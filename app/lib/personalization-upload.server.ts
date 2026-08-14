// Stock Bag personalization — Phase 2 (upload endpoint core).
//
// The route file is a thin adapter; everything testable lives here, matching the
// repo convention that tests never import route modules.
//
// Two invariants carried from Phase 1:
//   * the browser is never authority for fileUrl / mimeType / fileName / byteSize
//   * the whole batch is validated before ANY byte reaches Shopify

import {
  MAX_PERSONALIZATION_FILES,
  MAX_PERSONALIZATION_FILE_BYTES,
  type PersonalizationAsset,
  type PersonalizationDeps,
  type PersonalizationUploadInput,
  uploadPersonalizationAssets,
  validatePersonalizationBatch,
  validatePersonalizationFile,
} from "./personalization-assets.server";

/** 5 x 10MB plus multipart overhead. */
export const MAX_PERSONALIZATION_REQUEST_BYTES = MAX_PERSONALIZATION_FILES * MAX_PERSONALIZATION_FILE_BYTES + 1024 * 1024;

export const RATE_LIMIT_MAX_REQUESTS = 20;
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export type UploadErrorCode =
  | "NO_FILES"
  | "TOO_MANY_FILES"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_CONTENT_MISMATCH"
  | "RATE_LIMITED"
  | "UPLOAD_FAILED"
  | "INVALID_REQUEST";

export type UploadAssetStatus = "READY" | "PROCESSING";

export type UploadResponseAsset = Omit<PersonalizationAsset, "fileUrl"> & {
  fileUrl: string | null;
  status: UploadAssetStatus;
  /**
   * Phase 4: opaque server-signed proof that this asset came through the GSO
   * upload endpoint. The browser stores and returns it verbatim; it cannot read
   * or forge it, and no signing internals are exposed alongside it.
   */
  assetClaim: string;
};

export type UploadHandlerResult =
  | { ok: true; status: number; body: { ok: true; assets: UploadResponseAsset[] } }
  | { ok: false; status: number; body: { ok: false; code: UploadErrorCode; message: string; failedFile?: string } };

/* ------------------------------------------------------------------ *
 * Error contract
 * ------------------------------------------------------------------ */

const MESSAGES: Record<UploadErrorCode, string> = {
  NO_FILES: "Choose at least one file to upload.",
  TOO_MANY_FILES: `You can upload up to ${MAX_PERSONALIZATION_FILES} files.`,
  FILE_TOO_LARGE: `Each file must be ${Math.floor(MAX_PERSONALIZATION_FILE_BYTES / (1024 * 1024))}MB or smaller.`,
  UNSUPPORTED_FILE_TYPE: "Unsupported file type. Upload a PNG, JPG, or PDF.",
  FILE_CONTENT_MISMATCH: "File contents do not match the file type.",
  RATE_LIMITED: "Too many uploads. Please wait a few minutes and try again.",
  UPLOAD_FAILED: "We could not save your file. Please try again.",
  INVALID_REQUEST: "That request could not be processed.",
};

export function uploadError(code: UploadErrorCode, status: number, failedFile?: string): UploadHandlerResult {
  return { ok: false, status, body: { ok: false, code, message: MESSAGES[code], ...(failedFile ? { failedFile } : {}) } };
}

/** Map a Phase 1 validation reason onto a stable public code — no internal text escapes. */
export function codeForValidationReason(reason: string): UploadErrorCode {
  const text = String(reason || "").toLowerCase();
  if (text.includes("empty")) return "UNSUPPORTED_FILE_TYPE";
  if (text.includes("limit") && text.includes("mb")) return "FILE_TOO_LARGE";
  if (text.includes("do not match")) return "FILE_CONTENT_MISMATCH";
  if (text.includes("not a valid")) return "FILE_CONTENT_MISMATCH";
  if (text.includes("at most")) return "TOO_MANY_FILES";
  return "UNSUPPORTED_FILE_TYPE";
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

export type RateLimitVerdict = {
  allowed: boolean;
  retryAfterSeconds: number;
  /** True when the limiter itself could not run (e.g. database down). Fails closed. */
  unavailable?: boolean;
};

export type RateLimiter = {
  check(identity: string): Promise<RateLimitVerdict>;
};

/** Prune rows older than this. They exist only to answer "how many in the last window". */
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Roughly 1 request in 50 also runs the retention sweep, so it is not per-request work. */
export const RATE_LIMIT_CLEANUP_PROBABILITY = 0.02;

/**
 * Durable, Postgres-backed limiter — the production default.
 *
 * Insert-then-count on purpose. The obvious "count, then decide, then insert"
 * shape races: two concurrent requests both read 19 and both proceed. Writing
 * first and counting afterwards (including our own row, inside one transaction)
 * means every attempt is recorded exactly once and no attempt can be missed by a
 * concurrent reader. Under contention it can only ever over-count slightly,
 * which errs toward denying — the safe direction for abuse protection — so no
 * distributed lock or SERIALIZABLE retry loop is warranted.
 *
 * Denied attempts are recorded too: a caller hammering the endpoint should not
 * get a fresh budget simply because their requests were rejected.
 */
export function createPrismaRateLimiter(
  db: any,
  options: {
    maxRequests?: number;
    windowMs?: number;
    now?: () => number;
    random?: () => number;
    logError?: (message: string, detail: Record<string, unknown>) => void;
  } = {},
): RateLimiter {
  const maxRequests = options.maxRequests ?? RATE_LIMIT_MAX_REQUESTS;
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;

  return {
    async check(identity: string): Promise<RateLimitVerdict> {
      const current = now();
      const cutoff = new Date(current - windowMs);

      try {
        const count: number = await db.$transaction(async (tx: any) => {
          await tx.personalizationUploadRateLimit.create({ data: { identityKey: identity } });
          return tx.personalizationUploadRateLimit.count({
            where: { identityKey: identity, createdAt: { gt: cutoff } },
          });
        });

        // Opportunistic retention sweep — never on the hot path for most requests.
        if (random() < RATE_LIMIT_CLEANUP_PROBABILITY) {
          try {
            await db.personalizationUploadRateLimit.deleteMany({
              where: { createdAt: { lt: new Date(current - RATE_LIMIT_RETENTION_MS) } },
            });
          } catch (error) {
            // Cleanup is best-effort; never fail a request because pruning failed.
            options.logError?.("[personalization-upload] rate-limit cleanup failed", { error: String(error) });
          }
        }

        if (count > maxRequests) {
          return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
        }
        return { allowed: true, retryAfterSeconds: 0 };
      } catch (error) {
        // Fail CLOSED. A missing table or an unreachable database must never
        // silently turn abuse protection off on a public endpoint.
        options.logError?.("[personalization-upload] rate limiter unavailable", { error: String(error) });
        return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000), unavailable: true };
      }
    },
  };
}

/**
 * TEMPORARY — NOT PRODUCTION GRADE.
 *
 * Process memory only. Render can run multiple instances and restarts freely, so
 * this neither shares state across instances nor survives a restart. It exists so
 * the endpoint is not completely unprotected and so the policy is testable.
 *
 * The durable design mirrors the agent-intake limiter, which counts rows in a
 * time window (see api.agent.intake.tsx + AgentSubmissionLog). That needs a small
 * Prisma model, which is deliberately deferred — see the Phase 2 report.
 */
export function createInMemoryRateLimiter(
  maxRequests = RATE_LIMIT_MAX_REQUESTS,
  windowMs = RATE_LIMIT_WINDOW_MS,
  now: () => number = () => Date.now(),
): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    async check(identity: string) {
      const current = now();
      const cutoff = current - windowMs;
      const recent = (hits.get(identity) || []).filter((at) => at > cutoff);
      if (recent.length >= maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + windowMs - current) / 1000));
        hits.set(identity, recent);
        return { allowed: false, retryAfterSeconds };
      }
      recent.push(current);
      hits.set(identity, recent);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

/**
 * Identity for rate limiting.
 *
 * App-proxy requests reach us from Shopify's infrastructure, so the socket/;
 * forwarded IP identifies Shopify, not the shopper. The only shopper signal that
 * Shopify itself signs is `logged_in_customer_id`, so that is preferred. Guests
 * fall back to a coarse shop-scoped bucket; a client-supplied X-Forwarded-For is
 * never trusted as identity on its own.
 */
export function deriveClientIdentity(input: { shop: string; loggedInCustomerId?: string | null }): string {
  const shop = String(input.shop || "unknown-shop");
  const customer = String(input.loggedInCustomerId || "").replace(/[^0-9]/g, "");
  return customer ? `${shop}:customer:${customer}` : `${shop}:guest`;
}

/* ------------------------------------------------------------------ *
 * Server-side asset resolution (Phase 4 will consume this)
 * ------------------------------------------------------------------ */

const ASSET_ID_PATTERN = /^gid:\/\/shopify\/(MediaImage|GenericFile)\/\d+$/;

export function isPlausibleAssetId(value: unknown): boolean {
  return ASSET_ID_PATTERN.test(String(value ?? ""));
}

/**
 * Resolve an asset from its id using Shopify as the only authority.
 *
 * Phase 4 (checkout) must call this instead of believing a posted fileUrl/mimeType:
 * a forged URL in a request body can never become authoritative because nothing
 * from the caller other than the id is read.
 */
export async function resolvePersonalizationAssetById(
  deps: Pick<PersonalizationDeps, "graphql">,
  assetId: unknown,
): Promise<
  | { ok: true; assetId: string; fileUrl: string; status: UploadAssetStatus }
  | { ok: false; reason: string; code: "UNKNOWN" | "FAILED" }
> {
  if (!isPlausibleAssetId(assetId)) return { ok: false, reason: "Unknown asset.", code: "UNKNOWN" };
  const id = String(assetId);

  const payload = await deps.graphql(
    `query gsoResolveAsset($id: ID!) {
      node(id: $id) {
        id
        ... on MediaImage { fileStatus image { url } }
        ... on GenericFile { fileStatus url }
      }
    }`,
    { id },
  );

  const node = payload?.data?.node;
  if (!node?.id) return { ok: false, reason: "Unknown asset.", code: "UNKNOWN" };

  const status = String(node.fileStatus || "");
  const fileUrl = String(node?.image?.url || node?.url || "");
  if (status === "READY" && fileUrl) return { ok: true, assetId: id, fileUrl, status: "READY" };
  if (status === "FAILED") return { ok: false, reason: "Asset failed to process.", code: "FAILED" };
  return { ok: true, assetId: id, fileUrl: "", status: "PROCESSING" };
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

/** Mints the Phase 4 claim. Injected so tests never touch process.env. */
export type PersonalizationClaimSigner = (input: {
  shop: string;
  assetId: string;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
}) => string;

export type UploadHandlerDeps = PersonalizationDeps & {
  rateLimiter: RateLimiter;
  logError?: (message: string, detail: Record<string, unknown>) => void;
  signClaim?: PersonalizationClaimSigner;
};

/**
 * Validate the whole batch, then upload. Atomic validation means a single bad file
 * causes zero Shopify writes, so a customer never half-uploads a set.
 */
export async function handlePersonalizationUpload(
  deps: UploadHandlerDeps,
  input: { identity: string; files: PersonalizationUploadInput[]; shop?: string },
): Promise<UploadHandlerResult> {
  const files = Array.isArray(input.files) ? input.files : [];

  const limit = await deps.rateLimiter.check(input.identity);
  if (!limit.allowed) {
    // A genuine over-limit caller is told to wait. A limiter that could not run
    // is a server fault, so it reports the honest generic failure instead of
    // blaming the customer — either way the request is refused, never allowed.
    return limit.unavailable ? uploadError("UPLOAD_FAILED", 200) : uploadError("RATE_LIMITED", 429);
  }

  if (files.length === 0) return uploadError("NO_FILES", 400);

  const batch = validatePersonalizationBatch(files);
  if (!batch.ok) return uploadError("TOO_MANY_FILES", 400);

  // Atomic pre-validation: nothing is sent to Shopify unless every file passes.
  for (const file of files) {
    const verdict = validatePersonalizationFile(file);
    if (!verdict.ok) {
      return uploadError(codeForValidationReason(verdict.reason), 400, String(file?.fileName ?? ""));
    }
  }

  let result: Awaited<ReturnType<typeof uploadPersonalizationAssets>>;
  try {
    result = await uploadPersonalizationAssets(deps, files);
  } catch (error) {
    // Transport faults are logged server-side and never surfaced verbatim.
    deps.logError?.("[personalization-upload] storage transport failure", { error: String(error) });
    return uploadError("UPLOAD_FAILED", 200);
  }

  if (result.rejected.length) {
    // Storage-stage failure after validation passed: name the file, keep detail internal.
    deps.logError?.("[personalization-upload] storage rejected a file", { rejected: result.rejected });
    return uploadError("UPLOAD_FAILED", 200, result.rejected[0].originalFileName);
  }

  // Phase 4: mint the signed claim from the values THIS SERVER validated, not
  // from anything the caller sent. An upload that cannot be claimed is useless
  // at checkout, so a signing failure fails the request closed rather than
  // handing back an id that would later be refused.
  const shop = String(input.shop ?? "");
  let assets: UploadResponseAsset[];
  try {
    if (!deps.signClaim) throw new Error("Claim signer is not configured.");
    assets = result.assets.map((asset) => ({
      assetId: asset.assetId,
      fileName: asset.fileName,
      originalFileName: asset.originalFileName,
      // PROCESSING is a normal outcome, not a failure — Shopify Files is asynchronous.
      fileUrl: asset.fileUrl ? asset.fileUrl : null,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      assetRole: asset.assetRole,
      status: asset.fileUrl ? "READY" : "PROCESSING",
      assetClaim: deps.signClaim!({
        shop,
        assetId: asset.assetId,
        originalFileName: asset.originalFileName,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize,
      }),
    }));
  } catch (error) {
    deps.logError?.("[personalization-upload] could not issue an asset claim", { error: String(error) });
    return uploadError("UPLOAD_FAILED", 200);
  }

  return { ok: true, status: 200, body: { ok: true, assets } };
}
