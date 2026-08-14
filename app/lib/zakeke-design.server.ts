// Phase 17C.1 — Zakeke design identity.
//
// Zakeke owns artwork only. The design identity travels:
//   configurator cart item -> checkout POST -> draft order line custom attributes
//   -> paid order line properties -> ProductionJob (file row + item snapshot)
//
// The design id is the durable identity. The preview URL is always DERIVED from
// that id here rather than taken from the client, so an order attribute can never
// carry a caller-supplied URL, and the stored reference is always a stable
// same-origin app-proxy path instead of a transient blob: URL.

export const ZAKEKE_DESIGN_ID_KEY = "_GSO Zakeke Design ID";
export const ZAKEKE_PREVIEW_KEY = "_GSO Zakeke Preview";

export const ZAKEKE_PREVIEW_BASE = "/apps/zakeke/preview/";
export const ZAKEKE_ASSET_SOURCE = "zakeke";
export const ZAKEKE_MAX_DESIGN_ID = 200;

// Design ids are opaque to GSO, so accept a conservative charset only. Anything
// else is treated as "no design" rather than passed downstream.
const DESIGN_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type ZakekeDesign = {
  designId: string;
  previewUrl: string;
};

export function sanitizeZakekeDesignId(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > ZAKEKE_MAX_DESIGN_ID) return "";
  return DESIGN_ID_PATTERN.test(raw) ? raw : "";
}

export function buildZakekePreviewUrl(designId: string): string {
  const clean = sanitizeZakekeDesignId(designId);
  return clean ? `${ZAKEKE_PREVIEW_BASE}${encodeURIComponent(clean)}` : "";
}

/** Resolve a posted design id into the identity we are willing to persist. */
export function resolveZakekeDesign(value: unknown): ZakekeDesign | null {
  const designId = sanitizeZakekeDesignId(value);
  if (!designId) return null;
  return { designId, previewUrl: buildZakekePreviewUrl(designId) };
}

/** Draft-order line custom attributes. Underscore keys stay hidden from the customer. */
export function zakekeLineAttributes(design: ZakekeDesign | null): Array<{ key: string; value: string }> {
  if (!design) return [];
  return [
    { key: ZAKEKE_DESIGN_ID_KEY, value: design.designId },
    { key: ZAKEKE_PREVIEW_KEY, value: design.previewUrl },
  ];
}

/**
 * Read the design back off a paid order line. Takes the caller's property lookup
 * so this stays independent of REST `properties` vs GraphQL `customAttributes`.
 * The id is re-sanitized and the preview re-derived — a tampered order attribute
 * can never introduce an arbitrary URL into the ERP.
 */
export function readZakekeDesignFromLine(
  getProperty: (key: string) => string | null | undefined,
): ZakekeDesign | null {
  const candidates = [ZAKEKE_DESIGN_ID_KEY, "Zakeke Design ID", "zakeke_design_id"];
  for (const key of candidates) {
    const found = resolveZakekeDesign(getProperty(key));
    if (found) return found;
  }
  return null;
}

/** Nested snapshot payload — stored inside existing JSON string columns, no schema change. */
export function zakekeSnapshot(design: ZakekeDesign | null): Record<string, unknown> {
  if (!design) return {};
  return {
    zakeke: {
      designId: design.designId,
      previewUrl: design.previewUrl,
      source: "shopify_line_property",
    },
  };
}
