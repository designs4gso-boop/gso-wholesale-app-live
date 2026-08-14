// Stock Bag personalization — Phase 4 (server-signed asset claim).
//
// THE PROBLEM THIS SOLVES
//
// After Phase 2 the browser holds a Shopify Files id like
// `gid://shopify/MediaImage/123`. Those ids are guessable and shop-wide, so if
// checkout accepted an id purely because it was posted, anyone could attach an
// arbitrary store file — a product photo, another customer's artwork — to their
// own order. Re-resolving the id through Shopify does NOT fix that: resolution
// proves the file exists, not that GSO created it for this customer.
//
// So every successful upload also mints a CLAIM: a compact HMAC-signed token
// proving "GSO's own upload endpoint produced this asset, for this shop". The
// browser stores it opaquely and hands it back at checkout. It cannot mint one,
// cannot alter one, and cannot move one from asset A to asset B.
//
// WHY THE CLAIM CARRIES METADATA
//
// The fields inside a verified claim are server-authoritative: the upload
// endpoint validated them (filename sanitised, MIME confirmed from magic bytes,
// byte length measured) before signing. Reading them back after signature
// verification is NOT trusting the browser. This matters because Shopify does
// not expose the original filename or byte size for a file we created, so a
// claim is the only honest source for them — better than inventing authority
// from a posted value.
//
// Live status and fileUrl are deliberately NOT in the claim: those change after
// issue, so checkout re-resolves them through Shopify every time.

import { createHmac, timingSafeEqual } from "node:crypto";

export const PERSONALIZATION_CLAIM_VERSION = 1;

/**
 * 30 days.
 *
 * The GSO cart lives in localStorage with no expiry, so a customer can
 * legitimately configure a bag and check out weeks later. A short TTL would
 * silently invalidate saved carts, which is a worse failure than the narrow risk
 * it would mitigate: a replayed claim can only re-attach a file this same shop
 * already uploaded through GSO. 30 days keeps expiry outside any realistic
 * ordering window while still bounding replay.
 */
export const PERSONALIZATION_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Tolerance for clock drift between the issuing and verifying process. */
export const PERSONALIZATION_CLAIM_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Rejected on length before any parsing or crypto work happens. */
export const MAX_PERSONALIZATION_CLAIM_LENGTH = 1024;

/** Mirrors MAX_PERSONALIZATION_FILES; duplicated here to keep this module dependency-free. */
export const MAX_PERSONALIZATION_ASSETS_PER_LINE = 5;

const MAX_CLAIM_FILE_NAME = 80;
const ASSET_ID_PATTERN = /^gid:\/\/shopify\/(MediaImage|GenericFile)\/(\d{1,20})$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type PersonalizationClaimPayload = {
  v: number;
  /** Shop domain the claim is bound to. */
  s: string;
  /** Shopify Files gid. */
  a: string;
  /** Sanitized original filename. */
  n: string;
  /** Server-detected MIME type. */
  m: string;
  /** Measured byte length. */
  b: number;
  /** Issued-at, epoch ms. */
  t: number;
};

export type PersonalizationClaimInput = {
  shop: string;
  assetId: string;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  issuedAt?: number;
};

export type ClaimVerification =
  | { ok: true; payload: PersonalizationClaimPayload }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "WRONG_SHOP" | "WRONG_ASSET" | "EXPIRED" | "UNSUPPORTED_VERSION" };

/* ------------------------------------------------------------------ *
 * Key material
 * ------------------------------------------------------------------ */

const CLAIM_KEY_INFO = "gso/personalization-asset-claim/v1";

/**
 * Domain-separated subkey, never the raw app secret.
 *
 * Signing with SHOPIFY_API_SECRET directly would mean a GSO claim signature and
 * a Shopify webhook/app-proxy HMAC share key material, so a flaw in one context
 * could be leveraged in the other. One extra HMAC removes that coupling
 * entirely, and the derived key never leaves this module.
 */
function deriveClaimKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(CLAIM_KEY_INFO).digest();
}

/**
 * The only place the application secret is read. It is never logged, never
 * returned, and never included in an error message. Missing secret throws, so
 * the feature fails CLOSED (no claim issued -> checkout refuses the asset)
 * rather than silently degrading to unsigned, forgeable ids.
 */
export function getPersonalizationClaimSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) throw new Error("Personalization claim signing is not configured.");
  return secret;
}

/* ------------------------------------------------------------------ *
 * Encoding helpers
 * ------------------------------------------------------------------ */

function base64url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(encodedPayload: string, secret: string): string {
  return base64url(createHmac("sha256", deriveClaimKey(secret)).update(encodedPayload).digest());
}

/** Length-checked constant-time compare. timingSafeEqual throws on length mismatch. */
function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isPersonalizationAssetId(value: unknown): boolean {
  return ASSET_ID_PATTERN.test(String(value ?? ""));
}

/* ------------------------------------------------------------------ *
 * Issue
 * ------------------------------------------------------------------ */

export function issuePersonalizationClaim(input: PersonalizationClaimInput, secret: string): string {
  const assetId = String(input.assetId ?? "");
  if (!isPersonalizationAssetId(assetId)) throw new Error("Refusing to sign an unrecognized asset id.");

  const shop = String(input.shop ?? "").trim().toLowerCase();
  if (!shop) throw new Error("Refusing to sign a claim without a shop.");

  const payload: PersonalizationClaimPayload = {
    v: PERSONALIZATION_CLAIM_VERSION,
    s: shop,
    a: assetId,
    n: String(input.originalFileName ?? "").slice(0, MAX_CLAIM_FILE_NAME),
    m: String(input.mimeType ?? ""),
    b: Math.max(0, Math.floor(Number(input.byteSize) || 0)),
    t: Math.floor(Number(input.issuedAt) || Date.now()),
  };

  const encoded = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${encoded}.${sign(encoded, secret)}`;
}

/* ------------------------------------------------------------------ *
 * Verify
 * ------------------------------------------------------------------ */

/**
 * Order matters: the signature is checked BEFORE any payload field is used for a
 * decision, so an attacker-controlled payload never influences control flow on
 * the way to the comparison.
 */
export function verifyPersonalizationClaim(
  claim: unknown,
  expected: { shop: string; assetId: string; now?: number; ttlMs?: number },
  secret: string,
): ClaimVerification {
  const raw = String(claim ?? "");
  if (!raw || raw.length > MAX_PERSONALIZATION_CLAIM_LENGTH) return { ok: false, reason: "MALFORMED" };

  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };
  const [encodedPayload, providedSignature] = parts;
  if (!encodedPayload || !providedSignature) return { ok: false, reason: "MALFORMED" };
  if (!BASE64URL_PATTERN.test(encodedPayload) || !BASE64URL_PATTERN.test(providedSignature)) {
    return { ok: false, reason: "MALFORMED" };
  }

  if (!signaturesMatch(sign(encodedPayload, secret), providedSignature)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let payload: PersonalizationClaimPayload;
  try {
    payload = JSON.parse(fromBase64url(encodedPayload).toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "MALFORMED" };
  if (payload.v !== PERSONALIZATION_CLAIM_VERSION) return { ok: false, reason: "UNSUPPORTED_VERSION" };
  if (!isPersonalizationAssetId(payload.a)) return { ok: false, reason: "MALFORMED" };

  // Shop binding: a claim minted on one shop is worthless on another.
  const expectedShop = String(expected.shop ?? "").trim().toLowerCase();
  if (!expectedShop || String(payload.s ?? "").toLowerCase() !== expectedShop) return { ok: false, reason: "WRONG_SHOP" };

  // Asset binding: a valid claim for asset A must never validate asset B.
  if (String(payload.a) !== String(expected.assetId ?? "")) return { ok: false, reason: "WRONG_ASSET" };

  const now = Number(expected.now ?? Date.now());
  const ttl = Number(expected.ttlMs ?? PERSONALIZATION_CLAIM_TTL_MS);
  const issuedAt = Number(payload.t);
  if (!Number.isFinite(issuedAt)) return { ok: false, reason: "MALFORMED" };
  if (issuedAt > now + PERSONALIZATION_CLAIM_CLOCK_SKEW_MS) return { ok: false, reason: "EXPIRED" };
  if (now - issuedAt > ttl) return { ok: false, reason: "EXPIRED" };

  return { ok: true, payload };
}

/* ------------------------------------------------------------------ *
 * Posted payload parsing
 * ------------------------------------------------------------------ */

export type PostedPersonalizationAsset = { assetId: string; assetClaim: string };

/**
 * Reduce whatever arrived in the request body to at most 5 well-formed
 * {assetId, assetClaim} pairs. Anything else about the posted entries —
 * fileUrl, mimeType, fileName, byteSize, assetRole, status — is dropped here and
 * therefore cannot reach the rest of the system even by accident.
 */
export function parsePostedPersonalizationAssets(
  raw: unknown,
): { ok: true; assets: PostedPersonalizationAsset[] } | { ok: false; reason: "MALFORMED" | "TOO_MANY" } {
  if (raw == null) return { ok: true, assets: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "MALFORMED" };
  if (raw.length > MAX_PERSONALIZATION_ASSETS_PER_LINE) return { ok: false, reason: "TOO_MANY" };

  const assets: PostedPersonalizationAsset[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, reason: "MALFORMED" };
    const assetId = String((entry as any).assetId ?? "");
    const assetClaim = String((entry as any).assetClaim ?? "");
    if (!isPersonalizationAssetId(assetId)) return { ok: false, reason: "MALFORMED" };
    if (!assetClaim || assetClaim.length > MAX_PERSONALIZATION_CLAIM_LENGTH) return { ok: false, reason: "MALFORMED" };
    // Duplicates collapse rather than inflating the count or the attribute.
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    assets.push({ assetId, assetClaim });
  }

  return { ok: true, assets };
}

/* ------------------------------------------------------------------ *
 * Draft-order line attributes
 * ------------------------------------------------------------------ */

export const PERSONALIZATION_COUNT_KEY = "_GSO Personalization Count";
export const PERSONALIZATION_ASSETS_KEY = "_GSO Personalization Assets";
export const PERSONALIZATION_FILES_KEY = "_GSO Personalization Files";

/**
 * Shopify does not publish a hard limit for AttributeInput.value on draft-order
 * lines, and the most conservative documented bound anywhere in the platform is
 * 255 characters, so every value built here stays under that.
 *
 * Five full gids as JSON would be ~250 characters before any other field, and
 * five CDN URLs would be far beyond it, so the identity is encoded compactly and
 * losslessly instead: `<M|G><numeric id>:<R|P>`, comma separated.
 *   MediaImage -> M, GenericFile -> G, READY -> R, PROCESSING -> P
 * Worst case is 5 x (1 + 20 + 1 + 1) + 4 separators = 119 characters.
 */
export const MAX_PERSONALIZATION_ATTRIBUTE_LENGTH = 255;
const MAX_FILES_ATTRIBUTE_LENGTH = 240;
const MAX_FILE_NAME_IN_ATTRIBUTE = 40;

export type PersonalizationAttributeAsset = {
  assetId: string;
  originalFileName: string;
  status: "READY" | "PROCESSING";
};

export function encodePersonalizationAssets(assets: PersonalizationAttributeAsset[]): string {
  return assets
    .map((asset) => {
      const match = ASSET_ID_PATTERN.exec(String(asset.assetId ?? ""));
      if (!match) return "";
      const prefix = match[1] === "MediaImage" ? "M" : "G";
      return `${prefix}${match[2]}:${asset.status === "READY" ? "R" : "P"}`;
    })
    .filter(Boolean)
    .join(",");
}

/** Phase 5 reads the identity back off a paid order line with this. */
export function decodePersonalizationAssets(value: unknown): Array<{ assetId: string; status: "READY" | "PROCESSING" }> {
  return String(value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const match = /^([MG])(\d{1,20}):([RP])$/.exec(token);
      if (!match) return null;
      const resource = match[1] === "M" ? "MediaImage" : "GenericFile";
      return {
        assetId: `gid://shopify/${resource}/${match[2]}`,
        status: (match[3] === "R" ? "READY" : "PROCESSING") as "READY" | "PROCESSING",
      };
    })
    .filter(Boolean) as Array<{ assetId: string; status: "READY" | "PROCESSING" }>;
}

/**
 * Underscore-prefixed keys stay hidden from the customer, matching the existing
 * `_GSO Canonical` and `_GSO Zakeke Design ID` contract. Every value is built
 * from server-verified data — no client JSON is ever passed through.
 */
export function personalizationLineAttributes(
  assets: PersonalizationAttributeAsset[],
): Array<{ key: string; value: string }> {
  if (!assets.length) return [];

  const names = assets
    .map((asset) => String(asset.originalFileName ?? "").slice(0, MAX_FILE_NAME_IN_ATTRIBUTE))
    .filter(Boolean)
    .join(" | ")
    .slice(0, MAX_FILES_ATTRIBUTE_LENGTH);

  return [
    { key: PERSONALIZATION_COUNT_KEY, value: String(assets.length) },
    { key: PERSONALIZATION_ASSETS_KEY, value: encodePersonalizationAssets(assets).slice(0, MAX_PERSONALIZATION_ATTRIBUTE_LENGTH) },
    ...(names ? [{ key: PERSONALIZATION_FILES_KEY, value: names }] : []),
  ];
}
