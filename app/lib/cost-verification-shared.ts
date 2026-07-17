// Cost Verification Workbook (13.2) — pure, client-safe logic: provenance
// fingerprints, confidence classification, replay-test definitions, and the
// severity rules. No Prisma, no Shopify, no .server imports; the route
// component and the tests import this file directly.

export type Confidence = "verified" | "manual" | "seeded" | "missing";

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  verified: "Verified (invoice marker)",
  manual: "Manually entered",
  seeded: "Seeded / estimated",
  missing: "Missing / unusable",
};

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  missing: 0,
  seeded: 1,
  manual: 2,
  verified: 3,
};

// Interim, schema-free verification convention (documented on the page):
// the owner appends e.g. "[VERIFIED 2026-07-17 inv#123]" to the record's
// notes via its normal edit page. Real verifiedAt/By/Source columns are
// deferred to the planned migration batch.
const VERIFIED_MARKER = /\[verified[^\]]*\]/i;
const SEEDED_NOTES_HINT = /(seed|preset)/i;

export function hasVerifiedMarker(notes: unknown) {
  return VERIFIED_MARKER.test(String(notes ?? ""));
}

export function hasSeededNotes(notes: unknown) {
  return SEEDED_NOTES_HINT.test(String(notes ?? ""));
}

// Known constants the seeds/presets baked into the database. A live value
// exactly matching one of these is "seeded/estimated" unless a VERIFIED
// marker overrides (a legitimately-verified $5/hr machine stays Verified).
export const SEEDED_FINGERPRINTS = {
  rolandPouchCost: 156.99,
  rolandPouchMl: 750,
  mimakiBottleCost: 190,
  mimakiBottleMl: 1000,
  inkUsagePerSqftPct: 0.0075,
  machineRatePerHour: 5,
  machineSqftPerHour: 150,
  cmykCoveragePct: 40,
  inkAllowancePct: 15,
  maintenancePerSqft: 0.08,
  recoveryPerSqft: 0.05,
} as const;

export function nearlyEqual(a: number, b: number, epsilon = 0.0001) {
  return Math.abs(Number(a) - Number(b)) <= epsilon;
}

export function classifyConfidence(input: {
  notes?: unknown;
  value: number | null;
  seededFingerprint?: boolean;
}): Confidence {
  if (hasVerifiedMarker(input.notes)) return "verified";
  if (input.value == null || !(input.value > 0)) return "missing";
  if (input.seededFingerprint || hasSeededNotes(input.notes)) return "seeded";
  return "manual";
}

export function worstConfidence(values: Confidence[]): Confidence {
  if (!values.length) return "missing";
  return values.reduce((worst, value) =>
    CONFIDENCE_RANK[value] < CONFIDENCE_RANK[worst] ? value : worst,
  );
}

// Vendor tier sanity: cost per unit should not increase as quantity rises.
export function tiersNonMonotonic(tiers: Array<{ minQty: number; unitCost: number }>) {
  const sorted = [...tiers].sort((a, b) => Number(a.minQty) - Number(b.minQty));
  for (let i = 1; i < sorted.length; i += 1) {
    if (Number(sorted[i].unitCost) > Number(sorted[i - 1].unitCost) + 0.0001) return true;
  }
  return false;
}

export type WorkbookSeverity = "critical" | "warning";

export type WorkbookIssue = {
  area: string;
  item: string;
  severity: WorkbookSeverity;
  problem: string;
  verify: string;
  fixPath: string;
  fixLabel: string;
};

export type CategoryRow = {
  category: string;
  source: string;
  valueSummary: string;
  confidence: Confidence;
  problem: string;
  verify: string;
  fixPath: string;
  fixLabel: string;
};

// ---------- Owner Cost Checklist export (13.2.1) ----------

// Owner rule: only Miron jars are expected to carry quantity tiers; everything
// else should be a flat cost unless the owner confirms otherwise.
export function tierPolicy(vendor: unknown, name: unknown): "expected_tiered" | "expected_flat" {
  const text = `${String(vendor ?? "")} ${String(name ?? "")}`;
  return /miron/i.test(text) ? "expected_tiered" : "expected_flat";
}

const PLACEHOLDER_HINT = /(template|placeholder|sample|\btest\b)/i;
const FIVE_OZ_HINT = /(jar_5oz|5\s*oz)/i;

// Advisory flag only — the OWNER STATUS column records the decision.
// 5oz jar is special-cased: CLAUDE.md declares it cost-only/placeholder.
export function looksLikePlaceholder(name: unknown, sku: unknown, notes: unknown): boolean {
  const text = `${String(name ?? "")} ${String(sku ?? "")} ${String(notes ?? "")}`;
  return PLACEHOLDER_HINT.test(text) || FIVE_OZ_HINT.test(text);
}

export const PLACEHOLDER_ISSUE = "Possible placeholder — owner decide: delete, disable, or fill real cost.";
export const UNEXPECTED_TIERS_ISSUE = "Unexpected tiers — owner says only Miron should be tiered unless confirmed.";
export const NO_FLAT_COST_ISSUE = "No usable flat cost — enter one via Vendor Cost Book.";

export const OWNER_CHECKLIST_HEADER = [
  "category",
  "item name",
  "vendor",
  "current app cost",
  "unit",
  "tier min qty",
  "tier max qty",
  "MOQ",
  "cost source table/model",
  "confidence",
  "issue/warning",
  "verify against",
  "fix page",
  "OWNER STATUS",
  "OWNER NOTES",
] as const;

export type ChecklistRow = {
  category: string;
  itemName: string;
  vendor: string;
  cost: number | null;
  unit: string;
  tierMinQty: number | null;
  tierMaxQty: number | null;
  moq: number | null;
  source: string;
  confidence: Confidence | "n/a";
  issue: string;
  verify: string;
  fixPage: string;
};

export function checklistRowToCells(row: ChecklistRow): (string | number)[] {
  return [
    row.category,
    row.itemName,
    row.vendor,
    row.cost == null ? "" : row.cost,
    row.unit,
    row.tierMinQty == null ? "" : row.tierMinQty,
    row.tierMaxQty == null ? "" : row.tierMaxQty,
    row.moq == null ? "" : row.moq,
    row.source,
    row.confidence === "n/a" ? "n/a" : CONFIDENCE_LABELS[row.confidence],
    row.issue,
    row.verify,
    row.fixPage,
    "", // OWNER STATUS — blank for manual review
    "", // OWNER NOTES — blank for manual review
  ];
}

// The Cost Calculator's hardcoded assumptions, exported so the owner can
// confirm each one. These are code constants, not database values.
export const CALCULATOR_ASSUMPTION_ROWS: Array<{ itemName: string; cost: number | null; unit: string; note: string }> = [
  { itemName: "Labor rate (calculator default)", cost: 25, unit: "per hour", note: "Confirm against payroll reality." },
  { itemName: "Machine rate (calculator default input)", cost: 8, unit: "per hour", note: "Conflicts with the seeded $5/hr on Machines — pick one verified number." },
  { itemName: "Ink profile: CMYK Heavy", cost: 0.5, unit: "per sqft", note: "Estimated profile; engine-computed ink at seeded defaults is ~$0.25-0.29/sqft." },
  { itemName: "Ink profile: CMYK + White Heavy", cost: 1.0, unit: "per sqft", note: "Estimated profile." },
  { itemName: "Ink profile: CMYK + Gloss Heavy", cost: 1.0, unit: "per sqft", note: "Estimated profile." },
  { itemName: "Ink profile: CMYK + White + Gloss Heavy", cost: 1.5, unit: "per sqft", note: "Estimated profile." },
  { itemName: "Ink profile: CMYK + 2X Gloss Heavy", cost: 1.5, unit: "per sqft", note: "Estimated profile." },
  { itemName: "Ink profile: CMYK + 3X Gloss Heavy", cost: 2.0, unit: "per sqft", note: "Estimated profile." },
  { itemName: "Ink profile: CMYK + 4X Gloss Heavy", cost: 2.5, unit: "per sqft", note: "Estimated profile." },
  { itemName: "Application seconds (jars/bags heuristics)", cost: null, unit: "8-15 sec/unit", note: "Hardcoded per item type; stopwatch one real run." },
  { itemName: "Cutting rules (square/contour/die-cut/weed)", cost: null, unit: "setup min + sec/unit", note: "Hardcoded rule table." },
  { itemName: "Prepress rules (proof/repair/dieline/color)", cost: null, unit: "15-35 min", note: "Hardcoded rule table." },
  { itemName: "Packout rules (standard/bulk/individual)", cost: null, unit: "$0.01-0.05/unit + flat", note: "Hardcoded rule table." },
  { itemName: "Default line waste", cost: null, unit: "10 %", note: "Assumed, never measured." },
];

// ---------- Known-job replay tests (T1-T7) ----------

export type ReplayTest = {
  id: string;
  name: string;
  drivers: string;
  verify: string;
  href: string | null;
  hrefLabel: string;
  pending: boolean;
};

// Prefill URL for the Cost Calculator. Param names MUST match the calculator's
// form field names exactly (unit-tested); values the owner must supply (real
// label dimensions) are deliberately left blank so lines show their own
// "required" warnings instead of inventing numbers.
export function calculatorPrefillUrl(params: Record<string, string | number>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  return `/app/erp/cost-calculator?${search.toString()}`;
}

export function buildReplayTests(context: {
  threeOzItemId: string | null;
  fourOzItemId: string | null;
  holographicMaterialId: string | null;
  bagItemId: string | null;
  blankOnlyItemId: string | null;
  hasRipRows: boolean;
  hasOutsourcedRecipe: boolean;
}): ReplayTest[] {
  const jarBase = {
    lineCount: 1,
    lineName: "Jar label",
    lineQty: 600,
    lineLabelType: "side",
    itemMode: "inventory",
    applicationMode: "apply-jar",
    cuttingMode: "contour",
    prepressMode: "basic",
    packoutMode: "standard",
  };

  return [
    {
      id: "T1",
      name: "600 × 3oz jar labels — holographic media, jar application, cut, proof, packout",
      drivers: "Holographic $/sqft, 3oz blank cost, application seconds, cutting, prepress, packout, waste",
      verify: "Blank at $0.50 (clear) / $0.62 (b&w) unless the invoice says otherwise; holographic $/sqft vs supplier invoice (the old hardcode was $0.72); total vs what this job was actually charged.",
      href: context.threeOzItemId
        ? calculatorPrefillUrl({
            ...jarBase,
            lineName: "3oz jar label",
            ...(context.holographicMaterialId ? { lineMaterialId: context.holographicMaterialId } : {}),
            itemId: context.threeOzItemId,
          })
        : null,
      hrefLabel: context.threeOzItemId ? "Open prefilled in Cost Calculator (enter real label size)" : "3oz jar item not found in Vendor Products — enter it first",
      pending: false,
    },
    {
      id: "T2",
      name: "600 × 4oz jar labels",
      drivers: "4oz blank cost, media $/sqft, application seconds",
      verify: "Blank at $0.60 / $0.65 vs invoice; suggested price vs the jar sell sheet.",
      href: context.fourOzItemId
        ? calculatorPrefillUrl({ ...jarBase, lineName: "4oz jar label", itemId: context.fourOzItemId })
        : null,
      hrefLabel: context.fourOzItemId ? "Open prefilled in Cost Calculator (enter real label size)" : "4oz jar item not found in Vendor Products — enter it first",
      pending: false,
    },
    {
      id: "T3",
      name: "1,000 sticker bags — single design",
      drivers: "Blank 4x5 bag cost, media $/sqft, flat-bag application, cutting",
      verify: "Bag blank at $0.09 vs invoice; compare against the live configurator price for the same combo (Shopify Cost Audit / storefront).",
      href: context.bagItemId
        ? calculatorPrefillUrl({
            lineCount: 1,
            lineName: "4x5 bag label",
            lineQty: 1000,
            lineLabelType: "front",
            itemMode: "inventory",
            itemId: context.bagItemId,
            applicationMode: "apply-flat-bag",
            cuttingMode: "square",
          })
        : null,
      hrefLabel: context.bagItemId ? "Open prefilled in Cost Calculator (enter real label size)" : "4x5 bag item not found — presets/vendor products missing",
      pending: false,
    },
    {
      id: "T4",
      name: "Multi-label / multi-design job",
      drivers: "Per-design setup, prepress, application across designs",
      verify: "Pending — multi-design/file groups (12B.1b) are deliberately not built until cost verification completes.",
      href: null,
      hrefLabel: "Placeholder — pending 12B.1b",
      pending: true,
    },
    {
      id: "T5",
      name: "Actual RIP-imported job with ink data",
      drivers: "RIP actual ink cost/cc vs estimated ink profiles; the NAS sync script's ink $/ml constant",
      verify: "Run the same art in Actual GSOQ mode and Estimated mode; the gap calibrates the ink profiles. Locate the NAS script's ink price and record it in the state doc.",
      href: context.hasRipRows
        ? calculatorPrefillUrl({ quoteMode: "actual", lineCount: 1, lineName: "RIP actual test", lineQty: 100 })
        : null,
      hrefLabel: context.hasRipRows ? "Open Cost Calculator in Actual mode (pick a GSOQ result)" : "No synced GSOQ RIP results yet — run a sync first (RIP Imports)",
      pending: false,
    },
    {
      id: "T6",
      name: "Blank-only item (no printing)",
      drivers: "Vendor tier selection at quantity, blank waste rounding",
      verify: "Item cost row only: 500 units should price at the correct tier (e.g. Miron 500-999). Ignore the incomplete label line — it only carries the quantity.",
      href: context.blankOnlyItemId
        ? calculatorPrefillUrl({
            lineCount: 1,
            lineQty: 500,
            itemMode: "inventory",
            itemId: context.blankOnlyItemId,
            applicationMode: "none",
          })
        : null,
      hrefLabel: context.blankOnlyItemId ? "Open prefilled in Cost Calculator" : "No tiered vendor item found",
      pending: false,
    },
    {
      id: "T7",
      name: "Outsourced / vendor product",
      drivers: "Vendor tier costs + add-ons through the pricing engine (outsourced recipes price via the engine, not the calculator)",
      verify: "Open an outsourced recipe in Product Setup and use the readiness price test at a real quantity; compare unit cost to the vendor quote/invoice.",
      href: context.hasOutsourcedRecipe ? "/app/erp/product-setup" : null,
      hrefLabel: context.hasOutsourcedRecipe ? "Open Product Setup (use the recipe readiness price test)" : "No outsourced recipe found — create one first",
      pending: false,
    },
  ];
}
