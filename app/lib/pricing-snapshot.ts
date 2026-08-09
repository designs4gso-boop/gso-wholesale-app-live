// Phase 15G.2 — ONE normalized cost/pricing snapshot shape (client-safe).
//
// Every surface that persists a canonical price (Cost Calculator, Quotes,
// production job creation, Margin Review approval records, future
// Ticket-First intake) embeds this block so any later reader — printable
// work orders, variance reports, audits — can explain a price without
// knowing which surface produced it. Historical snapshots are never
// rewritten; this shape applies to NEW snapshots only.

export const CANONICAL_PRICING_SNAPSHOT_VERSION = "15G.2-canonical-snapshot-v1";

export type CanonicalPricingSnapshot = {
  snapshotVersion: string;
  engine: string; // producing engine + its version string
  at: string; // ISO timestamp
  family: string | null;
  productName: string | null;
  quantity: number;
  dimensions: { widthIn: number | null; heightIn: number | null; facesPerUnit: number | null } | null;
  materialSource: string | null; // e.g. "Material:<id>" / "VendorProduct:<id>"
  materialCost: number | null;
  blankCost: number | null;
  inkCost: number | null;
  whiteLayers: number | null;
  glossLayers: number | null;
  glossCoveragePct: number | null;
  machine: string | null;
  machineRatePerHour: number | null;
  machineMinutes: number | null;
  cuttingCost: number | null;
  applicationCost: number | null;
  setupCost: number | null;
  packoutCost: number | null;
  wastePct: number | null;
  totalCost: number;
  unitCost: number;
  pricingPolicy: string | null; // margin curve / tier / ladder description
  marginPct: number | null;
  minimumApplied: string | null; // controlling floor/minimum if any
  marketAdvisory: string | null;
  recommendedUnitPrice: number;
  recommendedTotalPrice: number;
};

export function buildCanonicalPricingSnapshot(
  input: Partial<CanonicalPricingSnapshot> & { quantity: number; totalCost: number; unitCost: number; recommendedUnitPrice: number; recommendedTotalPrice: number; engine: string },
): CanonicalPricingSnapshot {
  return {
    snapshotVersion: CANONICAL_PRICING_SNAPSHOT_VERSION,
    at: input.at || new Date().toISOString(),
    engine: input.engine,
    family: input.family ?? null,
    productName: input.productName ?? null,
    quantity: input.quantity,
    dimensions: input.dimensions ?? null,
    materialSource: input.materialSource ?? null,
    materialCost: input.materialCost ?? null,
    blankCost: input.blankCost ?? null,
    inkCost: input.inkCost ?? null,
    whiteLayers: input.whiteLayers ?? null,
    glossLayers: input.glossLayers ?? null,
    glossCoveragePct: input.glossCoveragePct ?? null,
    machine: input.machine ?? null,
    machineRatePerHour: input.machineRatePerHour ?? null,
    machineMinutes: input.machineMinutes ?? null,
    cuttingCost: input.cuttingCost ?? null,
    applicationCost: input.applicationCost ?? null,
    setupCost: input.setupCost ?? null,
    packoutCost: input.packoutCost ?? null,
    wastePct: input.wastePct ?? null,
    totalCost: input.totalCost,
    unitCost: input.unitCost,
    pricingPolicy: input.pricingPolicy ?? null,
    marginPct: input.marginPct ?? null,
    minimumApplied: input.minimumApplied ?? null,
    marketAdvisory: input.marketAdvisory ?? null,
    recommendedUnitPrice: input.recommendedUnitPrice,
    recommendedTotalPrice: input.recommendedTotalPrice,
  };
}
