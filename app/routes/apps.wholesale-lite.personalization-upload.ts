import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  MAX_PERSONALIZATION_FILES,
  MAX_PERSONALIZATION_FILE_BYTES,
  createAdminGraphql,
  uploadBytesToStagedTarget,
  type PersonalizationUploadInput,
} from "../lib/personalization-assets.server";
import { db } from "../db.server";
import {
  MAX_PERSONALIZATION_REQUEST_BYTES,
  createPrismaRateLimiter,
  deriveClientIdentity,
  handlePersonalizationUpload,
  uploadError,
  type UploadHandlerResult,
} from "../lib/personalization-upload.server";
import { getPersonalizationClaimSecret, issuePersonalizationClaim } from "../lib/personalization-claim.server";

// Phase 2: Stock Bag personalization upload endpoint.
//
// Thin adapter only — validation, rate limiting, storage and the error contract
// live in app/lib/personalization-upload.server.ts so they are unit-testable
// without importing a route module (repo test convention).
//
// 15G.1 convention preserved: the admin token comes ONLY from the authenticated
// app-proxy session, never from a caller-supplied shop value.

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function send(result: UploadHandlerResult) {
  return jsonResponse(result.body, { status: result.status });
}

// Phase 2.5: durable, Postgres-backed and therefore correct across Render
// restarts and multiple instances. The RateLimiter interface is preserved so
// tests inject deterministic implementations instead of needing a database.
const rateLimiter = createPrismaRateLimiter(db, {
  logError: (message, detail) => console.error(message, detail),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Signature is still verified so this cannot be probed off-proxy.
  await authenticate.public.appProxy(request);
  // GET never uploads.
  return jsonResponse({ ok: true, endpoint: "POST multipart/form-data with a 'files' field.", maxFiles: MAX_PERSONALIZATION_FILES });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  if (request.method !== "POST") {
    return send(uploadError("INVALID_REQUEST", 405));
  }

  const shop = session?.shop;
  const accessToken = session?.accessToken;
  if (!shop || !accessToken) {
    return jsonResponse({ ok: false, code: "INVALID_REQUEST", message: "App is not installed for this shop." }, { status: 400 });
  }

  // Content-Length is an early reject only — the real cap is enforced on the
  // parsed bytes below, because a header can lie.
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PERSONALIZATION_REQUEST_BYTES) {
    return send(uploadError("FILE_TOO_LARGE", 413));
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return send(uploadError("INVALID_REQUEST", 400));
  }

  let files: PersonalizationUploadInput[] = [];
  try {
    const form = await request.formData();
    const entries = form.getAll("files").filter((entry): entry is File => typeof entry === "object" && entry !== null && "arrayBuffer" in entry);

    // Bound the count before reading any bytes into memory.
    if (entries.length > MAX_PERSONALIZATION_FILES) {
      return send(uploadError("TOO_MANY_FILES", 400));
    }

    let total = 0;
    for (const entry of entries) {
      if (entry.size > MAX_PERSONALIZATION_FILE_BYTES) {
        return send(uploadError("FILE_TOO_LARGE", 400, entry.name));
      }
      total += entry.size;
      if (total > MAX_PERSONALIZATION_REQUEST_BYTES) {
        return send(uploadError("FILE_TOO_LARGE", 413));
      }
      files.push({
        fileName: entry.name,
        mimeType: entry.type,
        bytes: new Uint8Array(await entry.arrayBuffer()),
      });
    }
  } catch (error) {
    console.error("[personalization-upload] could not parse multipart body", { shop, error: String(error) });
    return send(uploadError("INVALID_REQUEST", 400));
  }

  const url = new URL(request.url);
  const identity = deriveClientIdentity({ shop, loggedInCustomerId: url.searchParams.get("logged_in_customer_id") });

  try {
    const result = await handlePersonalizationUpload(
      {
        graphql: createAdminGraphql(shop, accessToken),
        uploadBytes: uploadBytesToStagedTarget,
        rateLimiter,
        logError: (message, detail) => console.error(message, { shop, ...detail }),
        // Phase 4: the secret is read here and stays inside the signer closure —
        // it is never passed to the handler, logged, or serialized.
        signClaim: (asset) => issuePersonalizationClaim(asset, getPersonalizationClaimSecret()),
      },
      { identity, files, shop },
    );
    return send(result);
  } catch (error) {
    // The app proxy replaces upstream 5xx with the theme error page, so callers
    // always get JSON. The fault is still logged in full server-side.
    console.error("[personalization-upload] unhandled upload error", { shop, error: String(error) });
    return send(uploadError("UPLOAD_FAILED", 200));
  }
};
