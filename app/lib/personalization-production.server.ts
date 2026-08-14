// Stock Bag personalization — Phase 5 (paid order -> production).
//
// Reads the Phase 4 line attributes off a PAID order line and turns them into
// production artefacts: a nested ProductionJobItem snapshot and one
// ProductionJobFile per asset.
//
// Three rules shape this module:
//
//   1. The order attribute is identity ONLY. It carries an asset id and a
//      status stamped at checkout time — never a URL. Every URL is re-resolved
//      from Shopify here, so a hand-edited order attribute cannot introduce one.
//
//   2. Only a canonical GSO Stock Bag line qualifies. `_GSO ...` attributes on
//      any other line are recorded as a warning and discarded, never trusted.
//
//   3. Nothing is silently dropped. A malformed, failed or unresolvable asset
//      becomes an operator-visible warning rather than a missing row.

import {
  MAX_PERSONALIZATION_ASSETS_PER_LINE,
  PERSONALIZATION_ASSETS_KEY,
  PERSONALIZATION_COUNT_KEY,
  PERSONALIZATION_FILES_KEY,
  decodePersonalizationAssets,
} from "./personalization-claim.server";
import { PERSONALIZATION_ASSET_ROLE, PERSONALIZATION_ASSET_SOURCE } from "./personalization-assets.server";

export { PERSONALIZATION_ASSET_ROLE, PERSONALIZATION_ASSET_SOURCE };

/**
 * ProductionJobFile.fileUrl is a NON-NULLABLE String, so an asset with no URL
 * yet still needs a value. Rather than invent a CDN URL, these sentinels record
 * the honest state and carry the durable id. They are deliberately not http(s),
 * so the ERP's `isImageUrl`/`isPdfUrl` helpers do not try to render them and no
 * operator can mistake one for artwork. `sourceRef` remains the authority.
 *
 * This mirrors the existing convention of storing an internal reference in
 * fileUrl (the auto-created proof sheet stores an app path; the Zakeke row
 * stores a derived app-proxy path).
 */
export const PERSONALIZATION_PENDING_URL_PREFIX = "gso:personalization-pending/";
export const PERSONALIZATION_FAILED_URL_PREFIX = "gso:personalization-failed/";

/** Neutral, bounded, 1-based. Used when a filename is missing or untrustworthy. */
export const PERSONALIZATION_FALLBACK_NAME_PREFIX = "customer-personalization-";

export const PERSONALIZATION_FILES_SEPARATOR = " | ";

export type PersonalizationProductionStatus = "READY" | "PROCESSING" | "FAILED";

export type DecodedPersonalizationAsset = {
  assetId: string;
  /** Status as stamped at checkout. Re-resolved before anything is written. */
  status: "READY" | "PROCESSING";
  originalFileName: string;
};

export type DecodedPersonalizationLine = {
  assets: DecodedPersonalizationAsset[];
  warnings: string[];
};

export type ResolvedPersonalizationProductionAsset = {
  assetId: string;
  originalFileName: string;
  /** Authoritative Shopify URL when READY; "" otherwise. Never fabricated. */
  fileUrl: string;
  status: PersonalizationProductionStatus;
};

/* ------------------------------------------------------------------ *
 * Reading the paid-order line
 * ------------------------------------------------------------------ */

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function personalizationFallbackName(index: number): string {
  return `${PERSONALIZATION_FALLBACK_NAME_PREFIX}${index + 1}`;
}

/**
 * FILENAME PAIRING CONTRACT (Phase 4 -> Phase 5).
 *
 * `_GSO Personalization Assets` and `_GSO Personalization Files` are built in a
 * single Phase 4 function from the SAME already-sorted array, in the same order,
 * so entry N of one corresponds to entry N of the other. The identity list is
 * never sorted independently of the names.
 *
 * That alignment holds by construction in the real flow, but it is not
 * self-defending: Phase 4 drops empty names, so a single empty name would shift
 * every later name onto the wrong asset. In practice it cannot occur —
 * sanitizeOriginalFileName returns "upload" for every empty/degenerate input, so
 * a name is never empty — and the 240-character cap is unreachable (five 40-char
 * names plus separators is 212). Both facts are pinned by tests.
 *
 * Rather than depend on that reasoning holding forever, pairing here is refused
 * outright unless the two lists are the SAME LENGTH. A mismatch (or a
 * hand-forged attribute) falls back to neutral names for every asset, so the
 * wrong filename can never be attached to an asset.
 */
export function pairPersonalizationFileNames(
  assetCount: number,
  rawNames: string,
): { names: string[]; mismatch: boolean } {
  const parts = clean(rawNames)
    .split(PERSONALIZATION_FILES_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return { names: Array.from({ length: assetCount }, (_, index) => personalizationFallbackName(index)), mismatch: false };
  }
  if (parts.length !== assetCount) {
    // Refuse to guess. Neutral names for everything beats a wrong pairing.
    return { names: Array.from({ length: assetCount }, (_, index) => personalizationFallbackName(index)), mismatch: true };
  }
  return { names: parts.map((part, index) => part || personalizationFallbackName(index)), mismatch: false };
}

/**
 * Decode the personalization attributes off one paid-order line.
 *
 * `isCanonicalStockBagLine` must come from the caller's existing canonical
 * snapshot parse — the same marker the rest of the paid-order mapper trusts.
 * Attributes on any other line are refused, so a customer-authored `_GSO ...`
 * property on a hand-made cart line can never become a production asset.
 */
export function readPersonalizationFromLine(
  getProperty: (key: string) => string | null | undefined,
  options: { isCanonicalStockBagLine: boolean },
): DecodedPersonalizationLine {
  const rawAssets = clean(getProperty(PERSONALIZATION_ASSETS_KEY));
  const rawCount = clean(getProperty(PERSONALIZATION_COUNT_KEY));
  const rawNames = clean(getProperty(PERSONALIZATION_FILES_KEY));
  const warnings: string[] = [];

  if (!rawAssets && !rawCount && !rawNames) return { assets: [], warnings };

  if (!options.isCanonicalStockBagLine) {
    warnings.push("Personalization attributes were present on a line that is not a canonical GSO Stock Bag — ignored.");
    return { assets: [], warnings };
  }

  // decodePersonalizationAssets drops anything that is not a well-formed
  // <M|G><digits>:<R|P> token, so malformed identity yields fewer entries
  // rather than a fabricated one.
  const decoded = decodePersonalizationAssets(rawAssets);
  if (rawAssets && !decoded.length) {
    warnings.push("Personalization identity on this line could not be decoded — no artwork was attached.");
    return { assets: [], warnings };
  }

  // Duplicate ids collapse; a replayed or hand-edited attribute cannot inflate
  // the row count.
  const seen = new Set<string>();
  const unique = decoded.filter((entry) => {
    if (seen.has(entry.assetId)) return false;
    seen.add(entry.assetId);
    return true;
  });
  if (unique.length !== decoded.length) {
    warnings.push(`Personalization identity contained ${decoded.length - unique.length} duplicate asset id(s) — deduplicated.`);
  }

  const bounded = unique.slice(0, MAX_PERSONALIZATION_ASSETS_PER_LINE);
  if (unique.length > bounded.length) {
    warnings.push(`Personalization identity listed ${unique.length} assets; only the first ${MAX_PERSONALIZATION_ASSETS_PER_LINE} were accepted.`);
  }

  const declaredCount = Number.parseInt(rawCount, 10);
  if (Number.isFinite(declaredCount) && declaredCount !== bounded.length) {
    warnings.push(`Personalization count attribute says ${declaredCount} but ${bounded.length} asset(s) decoded — using the decoded assets.`);
  }

  const { names, mismatch } = pairPersonalizationFileNames(bounded.length, rawNames);
  if (mismatch) {
    warnings.push("Personalization filenames did not line up with the assets — neutral names were used instead of guessing.");
  }

  return {
    assets: bounded.map((entry, index) => ({
      assetId: entry.assetId,
      status: entry.status,
      originalFileName: names[index] || personalizationFallbackName(index),
    })),
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * Live re-resolution
 * ------------------------------------------------------------------ */

export type PersonalizationProductionResolver = (
  assetId: string,
) => Promise<{ ok: true; assetId: string; fileUrl: string; status: "READY" | "PROCESSING" } | { ok: false; reason: string; code: "UNKNOWN" | "FAILED" }>;

/**
 * Re-resolve every decoded asset against Shopify.
 *
 * The stored status is a checkout-time stamp, so it is re-derived rather than
 * believed: an asset stamped PROCESSING is usually READY by the time the order
 * is paid. A resolver fault (missing session, network) is NOT fatal — the asset
 * keeps its durable id and is surfaced as needing resolution, because losing the
 * customer's artwork is far worse than an operator having to click once.
 */
export async function resolvePersonalizationForProduction(
  assets: DecodedPersonalizationAsset[],
  resolve: PersonalizationProductionResolver | null,
): Promise<{ assets: ResolvedPersonalizationProductionAsset[]; warnings: string[] }> {
  const resolved: ResolvedPersonalizationProductionAsset[] = [];
  const warnings: string[] = [];

  for (const asset of assets) {
    if (!resolve) {
      resolved.push({ assetId: asset.assetId, originalFileName: asset.originalFileName, fileUrl: "", status: "PROCESSING" });
      continue;
    }

    let live: Awaited<ReturnType<PersonalizationProductionResolver>>;
    try {
      live = await resolve(asset.assetId);
    } catch {
      // Detail is logged by the caller; production only needs to know it is unresolved.
      warnings.push(`Personalization file "${asset.originalFileName}" could not be resolved from Shopify — resolve it before printing (${asset.assetId}).`);
      resolved.push({ assetId: asset.assetId, originalFileName: asset.originalFileName, fileUrl: "", status: "PROCESSING" });
      continue;
    }

    if (live.ok && live.status === "READY" && live.fileUrl) {
      resolved.push({ assetId: asset.assetId, originalFileName: asset.originalFileName, fileUrl: live.fileUrl, status: "READY" });
      continue;
    }

    if (!live.ok && live.code === "FAILED") {
      warnings.push(`Personalization file "${asset.originalFileName}" FAILED to process in Shopify — contact the customer for a replacement (${asset.assetId}).`);
      resolved.push({ assetId: asset.assetId, originalFileName: asset.originalFileName, fileUrl: "", status: "FAILED" });
      continue;
    }

    if (!live.ok) {
      warnings.push(`Personalization file "${asset.originalFileName}" could not be found in Shopify Files — verify before printing (${asset.assetId}).`);
      resolved.push({ assetId: asset.assetId, originalFileName: asset.originalFileName, fileUrl: "", status: "FAILED" });
      continue;
    }

    warnings.push(`Personalization file "${asset.originalFileName}" is still processing in Shopify — re-resolve before printing (${asset.assetId}).`);
    resolved.push({ assetId: asset.assetId, originalFileName: asset.originalFileName, fileUrl: "", status: "PROCESSING" });
  }

  return { assets: resolved, warnings };
}

/* ------------------------------------------------------------------ *
 * Production artefacts
 * ------------------------------------------------------------------ */

/**
 * Nested under `personalization` on purpose.
 *
 * Loose snapshot readers (firstImageFromQuoteItem, snapshotValue) look for
 * top-level productImageUrl/imageUrl, so a customer logo must never sit at that
 * level or it could be picked up as the product thumbnail. Nesting makes that
 * structurally impossible.
 */
export function buildPersonalizationSnapshot(
  assets: ResolvedPersonalizationProductionAsset[],
): Record<string, unknown> {
  if (!assets.length) return {};
  return {
    personalization: {
      count: assets.length,
      source: "shopify_line_property",
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        originalFileName: asset.originalFileName,
        fileUrl: asset.fileUrl,
        mimeType: mimeTypeForAssetId(asset.assetId),
        status: asset.status,
      })),
    },
  };
}

/**
 * Derived from the Shopify resource type in the id, not guessed: Phase 1 stores
 * PNG/JPEG as MediaImage and PDF (its only GenericFile) as GenericFile.
 */
export function mimeTypeForAssetId(assetId: string): string {
  return String(assetId).includes("/GenericFile/") ? "application/pdf" : "image/*";
}

function fileTypeForAssetId(assetId: string): string {
  return String(assetId).includes("/GenericFile/") ? "customer_pdf" : "image";
}

function sentinelUrl(asset: ResolvedPersonalizationProductionAsset): string {
  const prefix = asset.status === "FAILED" ? PERSONALIZATION_FAILED_URL_PREFIX : PERSONALIZATION_PENDING_URL_PREFIX;
  return `${prefix}${asset.assetId}`;
}

export type PersonalizationJobFileRow = {
  fileName: string;
  originalFileName: string;
  fileType: string;
  fileUrl: string;
  assetRole: string;
  assetSource: string;
  sourceRef: string;
  matchedBy: string;
  notes: string;
};

/**
 * One row per asset — never merged, never truncated to the first file.
 *
 * ProductionJobFile has no itemId column, so item association uses the existing
 * convention: the itemTicket prefixes fileName exactly as it prefixes
 * suggestedFileName / ripJobName, and the machine-readable join is
 * ProductionJobItem.priceSnapshot.personalization.assets[].assetId <-> sourceRef.
 */
export function buildPersonalizationJobFiles(
  assets: ResolvedPersonalizationProductionAsset[],
  context: { itemTicket: string; productTitle?: string },
): PersonalizationJobFileRow[] {
  return assets.map((asset, index) => ({
    fileName: `${context.itemTicket}_PERSONALIZATION-${index + 1}`,
    originalFileName: asset.originalFileName,
    fileType: fileTypeForAssetId(asset.assetId),
    fileUrl: asset.status === "READY" && asset.fileUrl ? asset.fileUrl : sentinelUrl(asset),
    // Deliberately NOT "artwork": Stock Bag personalization must stay
    // distinguishable from Zakeke, and this role is not one the ERP promotes to
    // the job's product image / artwork / proof / print file.
    assetRole: PERSONALIZATION_ASSET_ROLE,
    assetSource: PERSONALIZATION_ASSET_SOURCE,
    sourceRef: asset.assetId,
    matchedBy: "shopify_line_property",
    notes:
      asset.status === "READY"
        ? `Customer-uploaded personalization for ${context.itemTicket}${context.productTitle ? ` (${context.productTitle})` : ""}. Shopify Files asset ${asset.assetId}.`
        : asset.status === "FAILED"
          ? `ACTION REQUIRED: this customer personalization FAILED in Shopify and has no usable file. Contact the customer for a replacement. Shopify Files asset ${asset.assetId}.`
          : `ACTION REQUIRED: this customer personalization was still processing when the order was paid. Re-resolve Shopify Files asset ${asset.assetId} before printing.`,
  }));
}

/** Job-level summary for internalNotes, matching the existing "NOTE:" convention. */
export function personalizationJobNote(
  lines: Array<{ itemTicket: string; assets: ResolvedPersonalizationProductionAsset[] }>,
): string | null {
  const attention = lines.flatMap((line) =>
    line.assets.filter((asset) => asset.status !== "READY").map((asset) => `${line.itemTicket}:${asset.originalFileName} (${asset.status})`),
  );
  const total = lines.reduce((sum, line) => sum + line.assets.length, 0);
  if (!total) return null;
  if (!attention.length) return `NOTE: ${total} customer personalization file(s) attached and ready.`;
  return `ACTION REQUIRED: ${attention.length} of ${total} customer personalization file(s) are not ready: ${attention.slice(0, 5).join("; ")}${attention.length > 5 ? "…" : ""}`;
}
