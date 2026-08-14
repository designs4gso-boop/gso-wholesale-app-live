// Stock Bag personalization — Phase 4 (checkout-side resolution).
//
// Turns whatever the browser posted on a cart line into an authoritative server
// object, or refuses the checkout. Nothing here reads a posted fileUrl,
// mimeType, fileName, byteSize, assetRole or status: the id must be accompanied
// by a valid GSO-issued claim, and live state is re-read from Shopify.
//
// Split of authority:
//   * signed claim  -> originalFileName, mimeType, byteSize (validated at upload)
//   * live Shopify  -> fileUrl, status (these change after the claim was issued)
//
// Personalization NEVER participates in pricing. This module is called after the
// line price is already computed so the two cannot be entangled.

import {
  MAX_PERSONALIZATION_ASSETS_PER_LINE,
  parsePostedPersonalizationAssets,
  verifyPersonalizationClaim,
} from "./personalization-claim.server";
import { resolvePersonalizationAssetById, type UploadAssetStatus } from "./personalization-upload.server";
import { PERSONALIZATION_ASSET_ROLE, type PersonalizationDeps } from "./personalization-assets.server";

/**
 * Only canonical Stock Bags carry Stock Bag personalization today. DTP/Zakeke
 * artwork is a separate channel and must not be reachable through this field.
 * Widening this list is the single explicit step required to support a new
 * family later.
 */
export const PERSONALIZATION_SUPPORTED_FAMILIES = ["Stock Bags"] as const;

export function familySupportsPersonalization(productFamily: unknown): boolean {
  return (PERSONALIZATION_SUPPORTED_FAMILIES as readonly string[]).includes(String(productFamily ?? ""));
}

export type ResolvedPersonalizationAsset = {
  assetId: string;
  originalFileName: string;
  /** "" while PROCESSING. Never fabricated — a URL is only ever Shopify's own. */
  fileUrl: string;
  mimeType: string;
  byteSize: number;
  assetRole: typeof PERSONALIZATION_ASSET_ROLE;
  status: UploadAssetStatus;
};

export type PersonalizationCheckoutFailure = {
  ok: false;
  code:
    | "PERSONALIZATION_MALFORMED"
    | "PERSONALIZATION_TOO_MANY"
    | "PERSONALIZATION_NOT_SUPPORTED"
    | "PERSONALIZATION_UNVERIFIED"
    | "PERSONALIZATION_EXPIRED"
    | "PERSONALIZATION_FAILED";
  message: string;
  failedFile?: string;
};

export type PersonalizationCheckoutResult =
  | { ok: true; assets: ResolvedPersonalizationAsset[] }
  | PersonalizationCheckoutFailure;

/** Customer-safe, bounded, and never derived from an exception or a Shopify payload. */
const MESSAGES: Record<PersonalizationCheckoutFailure["code"], string> = {
  PERSONALIZATION_MALFORMED: "One of your uploaded files could not be verified. Please remove it and upload it again.",
  PERSONALIZATION_TOO_MANY: `You can attach at most ${MAX_PERSONALIZATION_ASSETS_PER_LINE} files to a bag.`,
  PERSONALIZATION_NOT_SUPPORTED: "Uploaded files are not available for this product.",
  PERSONALIZATION_UNVERIFIED: "One of your uploaded files could not be verified. Please remove it and upload it again.",
  PERSONALIZATION_EXPIRED: "One of your uploaded files has expired. Please upload it again.",
  PERSONALIZATION_FAILED: "One of your uploaded files could not be processed. Please remove it and upload it again.",
};

function fail(code: PersonalizationCheckoutFailure["code"], failedFile?: string): PersonalizationCheckoutFailure {
  return { ok: false, code, message: MESSAGES[code], ...(failedFile ? { failedFile } : {}) };
}

/**
 * Shopify Files is asynchronous, so an asset uploaded seconds before checkout can
 * still be PROCESSING. Re-poll a few times server-side rather than exposing a
 * public status endpoint the storefront could hammer.
 */
export const PERSONALIZATION_CHECKOUT_POLL_ATTEMPTS = 3;
export const PERSONALIZATION_CHECKOUT_POLL_DELAY_MS = 250;

/**
 * Exported so Phase 5 production creation reuses this exact helper rather than
 * growing a second polling implementation (and without any public endpoint).
 */
export async function resolveWithBoundedRetry(
  deps: Pick<PersonalizationDeps, "graphql"> & { wait?: (ms: number) => Promise<void> },
  assetId: string,
  attempts: number,
): Promise<Awaited<ReturnType<typeof resolvePersonalizationAssetById>>> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = await resolvePersonalizationAssetById(deps, assetId);

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    // Only PROCESSING is worth retrying: UNKNOWN and FAILED are terminal.
    if (!last.ok || last.status === "READY") return last;
    await wait(PERSONALIZATION_CHECKOUT_POLL_DELAY_MS * attempt);
    last = await resolvePersonalizationAssetById(deps, assetId);
  }

  return last;
}

/**
 * Verify + re-resolve the personalization assets posted on one cart line.
 *
 * PROCESSING that survives the bounded retry is ALLOWED through, with status
 * preserved. The Shopify id is durable and already proven to belong to this shop
 * via the claim, so refusing would throw away a valid order for a transient
 * Shopify state; Phase 5 resolves the URL again when production actually needs
 * the artwork. The alternative — writing a fileUrl we do not have — would be a
 * lie in the order record, which is strictly worse.
 *
 * FAILED is terminal and refuses the checkout, because the artwork genuinely
 * does not exist and no later phase can recover it.
 */
export async function resolvePersonalizationForLine(
  deps: Pick<PersonalizationDeps, "graphql"> & {
    wait?: (ms: number) => Promise<void>;
    secret: string;
    now?: () => number;
    attempts?: number;
  },
  input: { shop: string; productFamily: string; posted: unknown },
): Promise<PersonalizationCheckoutResult> {
  const parsed = parsePostedPersonalizationAssets(input.posted);
  if (!parsed.ok) {
    return fail(parsed.reason === "TOO_MANY" ? "PERSONALIZATION_TOO_MANY" : "PERSONALIZATION_MALFORMED");
  }
  if (!parsed.assets.length) return { ok: true, assets: [] };

  // Family scope is checked before any claim work: a browser must not be able to
  // graft Stock Bag personalization onto a jar, sticker or DTP line, and no
  // legitimate client can reach this branch.
  if (!familySupportsPersonalization(input.productFamily)) {
    return fail("PERSONALIZATION_NOT_SUPPORTED");
  }

  const now = deps.now ?? (() => Date.now());
  const attempts = deps.attempts ?? PERSONALIZATION_CHECKOUT_POLL_ATTEMPTS;
  const resolved: ResolvedPersonalizationAsset[] = [];

  for (const posted of parsed.assets) {
    const verdict = verifyPersonalizationClaim(
      posted.assetClaim,
      { shop: input.shop, assetId: posted.assetId, now: now() },
      deps.secret,
    );
    if (!verdict.ok) {
      // An unsigned or mismatched claim is indistinguishable from an attack, so
      // it is refused without revealing which check failed.
      return fail(verdict.reason === "EXPIRED" ? "PERSONALIZATION_EXPIRED" : "PERSONALIZATION_UNVERIFIED");
    }

    const live = await resolveWithBoundedRetry(deps, posted.assetId, attempts);
    if (!live.ok) {
      return fail(live.code === "FAILED" ? "PERSONALIZATION_FAILED" : "PERSONALIZATION_UNVERIFIED", verdict.payload.n);
    }

    resolved.push({
      assetId: live.assetId,
      // From the signed claim: Shopify exposes neither the customer's original
      // filename nor a byte size for a file we created, and the browser is not
      // authority for either. The claim is, because this server signed it.
      originalFileName: verdict.payload.n,
      mimeType: verdict.payload.m,
      byteSize: verdict.payload.b,
      // From live Shopify only.
      fileUrl: live.fileUrl,
      status: live.status,
      assetRole: PERSONALIZATION_ASSET_ROLE,
    });
  }

  // Stable order so the draft-order attribute is deterministic regardless of the
  // order the browser happened to post them in.
  resolved.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  return { ok: true, assets: resolved };
}
