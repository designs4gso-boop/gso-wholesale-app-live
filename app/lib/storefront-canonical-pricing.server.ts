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

  const { glossLayers, deepBuild } = parseStorefrontFinish(selection.finish);
  if (deepBuild) return { ok: false, requestQuote: true, reason: DEEP_BUILD_STOREFRONT_MESSAGE };

  const holographic = /holo/i.test(String(selection.material || ""));
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
