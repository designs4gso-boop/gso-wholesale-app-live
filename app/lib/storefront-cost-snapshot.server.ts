// 2026-11-19 — internal COST SNAPSHOT on storefront (Shopify) order items.
//
// Until tonight a storefront order became a production job with unitCost 0 and
// a "pending_cost_book_mapping" placeholder, so its estimated cost was $0 and a
// later cost change would silently rewrite what the job "should have cost".
//
// Now, when the order becomes a job, the cost basis IN FORCE AT THAT MOMENT is
// stored on the item (ProductionJobItem.unitCost + costSnapshot):
//
//   * FORWARD ONLY. Written once, when the job is created. Older jobs are not
//     recalculated and an existing snapshot is never rewritten.
//   * The basis is the cost the storefront price engine itself uses for that
//     configuration (canonicalStockBagJob). It includes material, ink, labour,
//     finishing and the APPLICATION values exactly as they are in force today
//     (PENDING REAL SHOP TIMING VALIDATION). Nothing here changes a timing, a
//     formula or a price — it only records the number.
//   * Honest when it cannot be captured: an unsupported family or missing cost
//     inputs is stored as status "not_captured" with the reason, never as $0
//     pretending to be a cost.
//   * Stored under its own key (storefrontCost). It is deliberately NOT shaped
//     like the canonical true-cost block that quote cost authority trusts.
//
// Covered tonight: 4x5 Stock Bags and Sticker Bags (they share one engine).
// Jars, stickers and DTP pouches are recorded as not_captured with the reason;
// their storefront engines do not return a cost.

import { canonicalStockBagJob, type CanonicalBagInputs } from "./canonical-bag-pricing.server";
import { STOREFRONT_PRICING_VERSION } from "./storefront-canonical-pricing.server";

export const STOREFRONT_COST_SNAPSHOT_VERSION = "storefront-cost-snapshot/1 (2026-11-19)";
export const STOREFRONT_COST_SOURCE = "storefront_cost_snapshot";
export const APPLICATION_TIMING_NOTE = "Application values as in force when the order was placed — PENDING REAL SHOP TIMING VALIDATION.";

const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

type BagCanonical = { profile?: string; qty?: number; faces?: number; holo?: boolean; whiteRequired?: boolean; glossX?: number; engine?: string; v?: string };

/** The bag checkout snapshot (and only that one) carries faces + glossX + holo. */
export function bagCanonicalOf(priceSnapshot: any): BagCanonical | null {
  const canonical = priceSnapshot?.canonical;
  if (!canonical || typeof canonical !== "object") return null;
  const faces = Number(canonical.faces);
  if (!(faces === 1 || faces === 2) || !Number.isFinite(Number(canonical.glossX)) || typeof canonical.holo !== "boolean") return null;
  return canonical as BagCanonical;
}

export type StorefrontCostSnapshot =
  | {
      source: typeof STOREFRONT_COST_SOURCE; version: string; status: "captured"; capturedAt: string; basis: string; note: string;
      family: string; pricingVersion: string; quantity: number; faces: number; glossLayers: number; holographic: boolean;
      unitCost: number; totalCost: number; sellingUnitPrice: number; sellingTotal: number; marginPct: number | null;
      costLines: Array<{ label: string; amount: number }>;
    }
  | { source: typeof STOREFRONT_COST_SOURCE; version: string; status: "not_captured"; capturedAt: string; reason: string; family: string };

/** Pure: the snapshot for one order item. */
export function storefrontCostSnapshotFor(item: { quantity: number; unitPrice: number; priceSnapshot?: string | null }, bagInputs: CanonicalBagInputs | null, now: Date = new Date()): StorefrontCostSnapshot {
  const capturedAt = now.toISOString();
  let price: any = null;
  try { price = JSON.parse(String(item.priceSnapshot || "null")); } catch { price = null; }
  const family = String(price?.productFamily || "").trim() || "unknown";
  const missing = (reason: string): StorefrontCostSnapshot => ({ source: STOREFRONT_COST_SOURCE, version: STOREFRONT_COST_SNAPSHOT_VERSION, status: "not_captured", capturedAt, reason, family });
  const bag = bagCanonicalOf(price);
  if (!bag) return missing(`No cost is captured for ${family} storefront lines yet (their storefront engine returns a price only).`);
  if (!bagInputs || !bagInputs.available) return missing(`Bag cost inputs were not available when the order was placed${bagInputs?.reasons?.length ? `: ${bagInputs.reasons.join("; ")}` : "."}`);
  const quantity = Math.max(1, Math.floor(Number(item.quantity) || 0));
  const faces = Number(bag.faces) === 1 ? 1 : 2;
  const glossLayers = Math.max(0, Math.floor(Number(bag.glossX) || 0));
  const holographic = Boolean(bag.holo);
  // The same call the storefront price engine makes for this configuration.
  const job = canonicalStockBagJob(bagInputs, { quantity, faces, glossLayers, whiteLayers: holographic ? 1 : 0, holographic });
  if (!job.available) return missing(`The cost engine could not cost this configuration: ${job.reasons.join("; ")}`);
  if (job.blockers.length) return missing(`The cost engine reported missing inputs: ${job.blockers.join("; ")}`);
  if (!(job.totalCost > 0) || !Number.isFinite(job.unitCost)) return missing("The cost engine returned no cost.");
  const sellingUnitPrice = Number(item.unitPrice) || 0;
  const sellingTotal = round(sellingUnitPrice * quantity, 2);
  return {
    source: STOREFRONT_COST_SOURCE,
    version: STOREFRONT_COST_SNAPSHOT_VERSION,
    status: "captured",
    capturedAt,
    basis: "The cost the storefront price engine used for this configuration when the order was placed.",
    note: APPLICATION_TIMING_NOTE,
    family,
    pricingVersion: STOREFRONT_PRICING_VERSION,
    quantity,
    faces,
    glossLayers,
    holographic,
    unitCost: round(job.unitCost),
    totalCost: round(job.totalCost, 2),
    sellingUnitPrice,
    sellingTotal,
    marginPct: sellingTotal > 0 ? round(((sellingTotal - job.totalCost) / sellingTotal) * 100, 2) : null,
    costLines: (job.costLines || []).map((line) => ({ label: String(line.label), amount: round(Number(line.amount) || 0, 2) })),
  };
}

/**
 * Pure: stamp every item of a NEW storefront job. A captured cost fills
 * unitCost; a line that cannot be costed keeps unitCost 0 and says why.
 */
export function applyStorefrontCostSnapshots<T extends { quantity: number; unitPrice: number; priceSnapshot?: string | null }>(items: T[], bagInputs: CanonicalBagInputs | null, now: Date = new Date()): Array<T & { unitCost: number; costSnapshot: string }> {
  return items.map((item) => {
    const snapshot = storefrontCostSnapshotFor(item, bagInputs, now);
    return { ...item, unitCost: snapshot.status === "captured" ? snapshot.unitCost : 0, costSnapshot: JSON.stringify(snapshot) };
  });
}
