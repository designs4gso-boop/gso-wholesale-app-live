// Phase 15G.5 — ONE storefront pricing path. The public configurator proxy
// AND the checkout proxy price supported stock-bag configurations through
// this module, which wraps the SAME canonical engines the ERP uses
// (canonicalStockBagJob → computeProductDrivenCost + computeCommercialPrice
// with the 15G.4C UV market + specialty policy). ConfiguratorPricingRule is
// no longer a price authority for supported 4x5 products.
//
// Customer-facing rules honored here:
// - customers never see cost/margin/floor internals (callers return price only)
// - holographic implies the REQUIRED production white underbase (bundled,
//   floor-protected, no separate surcharge) — never asked of the customer
// - coverage is the internal 90% pre-art planning default (never a customer
//   input); actual-art coverage only ever improves realized margin
// - 9X+ = Deep Build → Request Custom Quote (never auto-checkout priced)

import { canonicalStockBagJob, type CanonicalBagInputs } from "./canonical-bag-pricing.server";

export const STOREFRONT_PRICING_VERSION = "15G.5-storefront-canonical";
export const DEEP_BUILD_STOREFRONT_MESSAGE =
  "Deep Build (9X+) finishes require a custom quote — contact us and we'll price it for you.";
export const UNSUPPORTED_CONFIG_MESSAGE =
  "This configuration can't be priced online right now. Please contact us for a quote.";

// Approved customer-facing quantity ladder for price breaks (5,000+ stays
// quote/cost-led — deliberately not shown as a fixed break).
export const STOREFRONT_PRICE_BREAK_QUANTITIES = [50, 100, 250, 500, 1000, 2500];
// 15G.5A: storefront minimum for the 4x5 configurator flow (owner-approved
// ladder starts at 50; other product families keep their own MOQs).
export const STOREFRONT_BAG_MIN_QTY = 50;
// 15G.5A: 5,000+ never shows an invented fixed market price online.
export const VOLUME_QUOTE_FROM = 5000;
export const VOLUME_QUOTE_MESSAGE =
  "Volume orders of 5,000+ are quoted individually — request a volume quote and we'll price it for you.";
// 15G.5A: customer-visible finish ladder served from CODE (no production
// ConfiguratorOption rows required). Every label parses deterministically to
// its exact X count via parseStorefrontFinish; Deep Build is quote-only.
export const CANONICAL_FINISH_OPTIONS = [
  "No Specialty — 0X",
  "Spot Gloss — 1X",
  "Raised Gloss — 2X",
  "Raised Gloss+ — 3X",
  "High Raised — 4X",
  "High Raised+ — 5X",
  "Ultra Raised — 6X",
  "Ultra Raised+ — 7X",
  "Extreme Raised — 8X",
  "Deep Build 9X+ — Request Custom Quote",
];

// 0D: customer-facing bag MATERIAL list, served from CODE for the same reason
// the finish ladder is (no production ConfiguratorOption rows required).
// Owner rule: Matte and Gloss are two surfaces sharing ONE base material cost
// class; Holographic is its own class. "Gloss" here is a MATERIAL — it is not
// the Spot Gloss FINISH, which lives in CANONICAL_FINISH_OPTIONS above.
export const BAG_MATERIAL_OPTIONS = ["Matte", "Gloss", "Holographic"];

/** The two base material cost classes a bag material can resolve to. */
export type BagMaterialClass = "matte" | "holographic";

/**
 * Map a customer-selected bag material to its base cost class.
 *
 * Holographic is the only material with its own cost inputs (and the only one
 * implying the required production white underbase). Everything else — Matte,
 * Gloss, and any legacy value — resolves to the matte class.
 *
 * This was previously an inline `/holo/i` test whose "Gloss prices as Matte"
 * behaviour was an accident of the fallthrough rather than a stated rule.
 * Naming it makes the owner rule explicit and testable, with no behaviour
 * change: a future allowlist can no longer silently reprice Gloss.
 */
export function bagMaterialClassFor(material: unknown): BagMaterialClass {
  return /holo/i.test(String(material ?? "")) ? "holographic" : "matte";
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Deterministic finish-name → gloss-stage mapping. Supports the current DB
// option names ("No Spot Gloss", "1X Spot Gloss"…) plus the 15G.4B raised-
// gloss vocabulary up to 8X. Anything 9X+ or explicitly deep-build is a
// custom quote.
export function parseStorefrontFinish(finish: unknown): { glossLayers: number; deepBuild: boolean } {
  const text = String(finish || "").trim().toLowerCase();
  if (!text || /^no\b|^none\b|no spot/.test(text)) return { glossLayers: 0, deepBuild: false };
  if (/deep\s*build|request.*quote|9\s*x?\s*\+/.test(text)) return { glossLayers: 9, deepBuild: true };
  const stageMatch = text.match(/(\d+)\s*x/);
  if (stageMatch) {
    const stages = Number(stageMatch[1]);
    if (!Number.isFinite(stages) || stages < 0) return { glossLayers: 0, deepBuild: false };
    if (stages >= 9) return { glossLayers: stages, deepBuild: true };
    return { glossLayers: stages, deepBuild: false };
  }
  if (/spot\s*gloss|raised|gloss\s*varnish/.test(text)) return { glossLayers: 1, deepBuild: false };
  return { glossLayers: 0, deepBuild: false };
}

export type StorefrontSelection = {
  quantity: number;
  faces: number; // sides — stock bags default Double Sided (2)
  material: string;
  finish: string;
};

export type StorefrontPriceResult =
  | { ok: true; unitPrice: number; totalPrice: number; glossLayers: number; holographic: boolean; requiredWhite: boolean; version: string }
  | { ok: false; requestQuote: boolean; reason: string };

export function priceStorefrontConfiguration(
  inputs: CanonicalBagInputs,
  selection: StorefrontSelection,
): StorefrontPriceResult {
  const quantity = Math.max(0, Math.floor(Number(selection.quantity) || 0));
  if (quantity < 1) return { ok: false, requestQuote: false, reason: "Quantity is required." };
  // 15G.5A: 5,000+ is a volume quote — the storefront never exposes a fixed
  // price beyond the approved 2,500 band (cost-led/crossover stays ERP-side).
  if (quantity >= VOLUME_QUOTE_FROM) return { ok: false, requestQuote: true, reason: VOLUME_QUOTE_MESSAGE };

  const { glossLayers, deepBuild } = parseStorefrontFinish(selection.finish);
  if (deepBuild) return { ok: false, requestQuote: true, reason: DEEP_BUILD_STOREFRONT_MESSAGE };

  const holographic = bagMaterialClassFor(selection.material) === "holographic";
  const faces = Math.max(1, Math.floor(Number(selection.faces) || 2));

  const job = canonicalStockBagJob(inputs, {
    quantity,
    faces,
    glossLayers,
    // holographic implies the required production white underbase — bundled
    // into cost for floor protection, never surcharged (15G.4C).
    whiteLayers: holographic ? 1 : 0,
    holographic,
  });
  if (!job.available) return { ok: false, requestQuote: false, reason: UNSUPPORTED_CONFIG_MESSAGE };
  if (job.blockers.length) return { ok: false, requestQuote: false, reason: UNSUPPORTED_CONFIG_MESSAGE };

  // Charge exactly unitPrice x quantity so the invoice line reconstructs to
  // the cent (draft orders take a 2dp unit price).
  const unitPrice = round2(job.recommendedTotalPrice / quantity);
  return {
    ok: true,
    unitPrice,
    totalPrice: round2(unitPrice * quantity),
    glossLayers,
    holographic,
    requiredWhite: holographic,
    version: STOREFRONT_PRICING_VERSION,
  };
}

export function storefrontPriceBreaks(
  inputs: CanonicalBagInputs,
  selection: Omit<StorefrontSelection, "quantity">,
): Array<{ minQty: number; priceEach: number }> {
  const breaks: Array<{ minQty: number; priceEach: number }> = [];
  for (const quantity of STOREFRONT_PRICE_BREAK_QUANTITIES) {
    const priced = priceStorefrontConfiguration(inputs, { ...selection, quantity });
    if (priced.ok) breaks.push({ minQty: quantity, priceEach: priced.unitPrice });
  }
  return breaks;
}

// Compact hidden line-item metadata (O) — enough for paid-order production
// creation and future Ticket-First intake to reconstruct the configuration
// and the quoted canonical price. Prefixed "_" attributes stay hidden from
// the customer-facing invoice.
export function buildCanonicalLineMetadata(input: {
  profileType: string;
  selection: StorefrontSelection & { bagColor?: string };
  priced: Extract<StorefrontPriceResult, { ok: true }>;
  finishLabel: string;
}): string {
  return JSON.stringify({
    v: STOREFRONT_PRICING_VERSION,
    profile: input.profileType,
    qty: input.selection.quantity,
    faces: input.selection.faces,
    material: input.selection.material,
    bagColor: input.selection.bagColor || "",
    holo: input.priced.holographic,
    whiteRequired: input.priced.requiredWhite,
    glossX: input.priced.glossLayers,
    finishLabel: input.finishLabel,
    unitPrice: input.priced.unitPrice,
    engine: "canonical-bag-pricing/15G.4C",
  });
}
