// Cost Verification Workbook (13.2) — pure, client-safe logic: provenance
// fingerprints, confidence classification, replay-test definitions, and the
// severity rules. No Prisma, no Shopify, no .server imports; the route
// component and the tests import this file directly.
import { normalizeSku } from "./shopify-cost-audit-shared";

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

// Owner rule (updated 13.2.5): Miron jars AND the DTP 4x5x2 blank pouch are
// approved as tiered; everything else should be a flat cost unless the owner
// confirms otherwise. A [VERIFIED ...] marker on a record also counts as that
// confirmation (verification IS the owner sign-off the warning asks for).
export function tierPolicy(vendor: unknown, name: unknown): "expected_tiered" | "expected_flat" {
  const text = `${String(vendor ?? "")} ${String(name ?? "")}`;
  return /miron|4\s?x\s?5\s?x\s?2/i.test(text) ? "expected_tiered" : "expected_flat";
}

// One-row all-range tiers are the app's storage pattern for flat costs (the
// jar seed wrote SAFECARE jars this way). Informational, never a warning.
export const SINGLE_TIER_FLAT_NOTE = "Flat cost stored as a single tier row (app convention) — informational only.";

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
  confidence: Confidence | "n/a" | "owner_standard";
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
    row.confidence === "n/a" ? "n/a" : row.confidence === "owner_standard" ? LABOR_STANDARD_CONFIDENCE_LABEL : CONFIDENCE_LABELS[row.confidence],
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

// ---------- Labor Standards (13A.1) ----------
// Owner-approved hand-labor standards, FULL PRECISION (hourly / min speed).
// Reporting foundation only: these are NOT wired into the calculator or the
// pricing engine yet — the calculator still uses its old heuristics until a
// separate approved wiring patch. Cutting is machine-based (cutter time), and
// gloss/white setup is setup labor only (ink usage profiles untouched).

export type LaborStandard = {
  key: string;
  task: string;
  kind: "hand" | "machine";
  hourlyCost: number | null;
  minSpeed: string;
  basis: string;
  unitCost: number | null;
  note: string;
};

export const LABOR_STANDARDS: LaborStandard[] = [
  { key: "art-setup", task: "Art setup", kind: "hand", hourlyCost: 25, minSpeed: "3 designs/hr", basis: "per design", unitCost: 25 / 3, note: "" },
  { key: "print-setup", task: "Print setup", kind: "hand", hourlyCost: 25, minSpeed: "25 designs/hr", basis: "per design", unitCost: 25 / 25, note: "" },
  { key: "cut-setup", task: "Cut setup", kind: "hand", hourlyCost: null, minSpeed: "—", basis: "included", unitCost: 0, note: "Included in art setup — $0 extra." },
  { key: "cutting", task: "Cutting", kind: "machine", hourlyCost: null, minSpeed: "25 cm/s setting; use conservative 12.5 cm/s effective estimate", basis: "machine-based", unitCost: null, note: "Done by the printer/cutter, not hand labor. Cost basis will be machine/cutter time later — not wired into the calculator yet." },
  { key: "weeding", task: "Weeding", kind: "hand", hourlyCost: 20, minSpeed: "15 sheets/hr (54in x 54in page)", basis: "per 54x54 sheet", unitCost: 20 / 15, note: "" },
  { key: "jar-application", task: "Jar application", kind: "hand", hourlyCost: 20, minSpeed: "100 jars/hr", basis: "per jar/application", unitCost: 20 / 100, note: "" },
  { key: "bag-4x5-application", task: "4x5 bag application", kind: "hand", hourlyCost: 20, minSpeed: "180 bags/hr", basis: "per side/application", unitCost: 20 / 180, note: "Front only = $0.1111/bag; front + back = $0.2222/bag." },
  { key: "bag-14x16-application", task: "14x16 bag application", kind: "hand", hourlyCost: 20, minSpeed: "20 bags/hr", basis: "per side/application", unitCost: 20 / 20, note: "Front only = $1.00/bag; front + back = $2.00/bag." },
  { key: "packout", task: "Pack out / shipping prep", kind: "hand", hourlyCost: 20, minSpeed: "10 packout units/hr", basis: "per packout unit/order box", unitCost: 20 / 10, note: "" },
  { key: "gloss-white-setup", task: "Gloss / white setup", kind: "hand", hourlyCost: 25, minSpeed: "3 setup jobs/hr", basis: "per setup", unitCost: 25 / 3, note: "Setup labor only — white/gloss ink usage profiles are NOT changed by this standard." },
];

export const LABOR_STANDARD_CONFIDENCE_LABEL = "Verified / Owner-approved standard";

// ---------- Labor Wiring Preview (13A.2) ----------
// READ-ONLY mirror of the Cost Calculator's current hardcoded labor rules
// (app/routes/app.erp.cost-calculator.tsx: secondsForKnownApplication,
// estimateApplicationRule, prepressRule). The calculator is deliberately NOT
// changed by this patch; these constants exist so the preview can show exact
// current assumptions instead of guessing. The future wiring patch replaces
// the calculator's rules with LABOR_STANDARDS and deletes this mirror.
export const CURRENT_CALC_LABOR = {
  laborRatePerHour: 25,
  jarApplicationSeconds: 10, // safe-care jar, side label
  bagApplicationSecondsPerSide: 10, // blank 4x5 bag
  jarApplicationSetupMinutes: 10,
  bagApplicationSetupMinutes: 5,
  prepressBasicMinutes: 15, // "Basic proof / file check"
  glossWhiteSetup: 0, // the calculator has NO gloss/white setup labor today
} as const;

// Assumption-level comparison: current calculator rule vs owner standard.
// "needs_wiring_review" = the two use different bases and cannot be compared
// numerically without a wiring decision (never silently guessed).
export type LaborRuleComparison = {
  task: string;
  currentRule: string;
  ownerStandard: string;
  status: "comparable" | "needs_wiring_review";
  note: string;
};

export const LABOR_RULE_COMPARISONS: LaborRuleComparison[] = [
  { task: "Jar application", currentRule: "10 s/jar + 10 min setup @ $25/hr (≈ $0.0694/jar + setup)", ownerStandard: "$0.20/jar ($20/hr ÷ 100/hr)", status: "comparable", note: "Owner standard is ~2.9x the current per-jar rate." },
  { task: "4x5 bag application", currentRule: "10 s/side + 5 min setup @ $25/hr (≈ $0.0694/side + setup)", ownerStandard: "$0.1111/side ($20/hr ÷ 180/hr)", status: "comparable", note: "Front+back doubles per-bag cost in both models." },
  { task: "14x16 bag application", currentRule: "15 s/side (pound bag) @ $25/hr (≈ $0.1042/side)", ownerStandard: "$1.00/side ($20/hr ÷ 20/hr)", status: "comparable", note: "Owner standard is ~9.6x the current rate — big change, shown deliberately." },
  { task: "Design/prepress setup", currentRule: "Prepress 'basic' = 15 min = $6.25/job", ownerStandard: "Art setup $8.3333/design + print setup $1.00/design = $9.3333/design", status: "comparable", note: "Also becomes per-DESIGN instead of per-job (matters for future multi-design jobs)." },
  { task: "Gloss/white setup", currentRule: "None — $0 (finish only affects ink $/sqft profile)", ownerStandard: "$8.3333/setup ($25/hr ÷ 3/hr)", status: "comparable", note: "Setup labor only; ink usage profiles unchanged." },
  { task: "Cutting", currentRule: "Hand-labor minutes @ $25/hr (e.g. die-cut 15 min + 6 s/unit)", ownerStandard: "Machine/cutter time — 25 cm/s setting, 12.5 cm/s effective estimate", status: "needs_wiring_review", note: "Different basis (hand labor vs cutter time) — wiring decision required." },
  { task: "Weeding", currentRule: "'Weeded decal' cut rule: 10 min + 8 s/unit @ $25/hr", ownerStandard: "$1.3333 per 54x54 sheet ($20/hr ÷ 15 sheets/hr)", status: "needs_wiring_review", note: "Different basis (per unit vs per sheet) — needs sheet-count wiring." },
  { task: "Packout", currentRule: "'Standard' = $2 flat + $0.02/product unit", ownerStandard: "$2.00 per packout unit / order box ($20/hr ÷ 10/hr)", status: "needs_wiring_review", note: "Different basis (per product unit vs per order box) — wiring decision required." },
];

export type LaborWiringScenario = {
  id: string;
  name: string;
  quantity: number;
  currentLabor: number;
  currentBasis: string;
  ownerLabor: number;
  ownerBasis: string;
  diff: number;
  diffPct: number;
  whatChanged: string;
};

const rate = CURRENT_CALC_LABOR.laborRatePerHour / 60; // $ per minute

function currentApplication(quantity: number, secondsPerUnit: number, setupMinutes: number) {
  return ((quantity * secondsPerUnit) / 60 + setupMinutes) * rate;
}

const CURRENT_PREPRESS = CURRENT_CALC_LABOR.prepressBasicMinutes * rate; // $6.25
const OWNER_DESIGN_SETUP = 25 / 3 + 1; // art + print setup per design = $9.3333

// Sample scenarios comparing ONLY the labor portion the wiring would change
// (application + design/gloss setup). Media, ink, machine, waste, and the
// calculator's live output are untouched by this preview.
export function buildLaborWiringScenarios(): LaborWiringScenario[] {
  const jarStandard = 20 / 100;
  const bagSideStandard = 20 / 180;
  const glossSetupStandard = 25 / 3;

  const make = (id: string, name: string, quantity: number, currentLabor: number, currentBasis: string, ownerLabor: number, ownerBasis: string, whatChanged: string): LaborWiringScenario => ({
    id, name, quantity, currentLabor, currentBasis, ownerLabor, ownerBasis,
    diff: ownerLabor - currentLabor,
    diffPct: currentLabor > 0 ? ((ownerLabor - currentLabor) / currentLabor) * 100 : 100,
    whatChanged,
  });

  const jarCurrent = currentApplication(600, CURRENT_CALC_LABOR.jarApplicationSeconds, CURRENT_CALC_LABOR.jarApplicationSetupMinutes) + CURRENT_PREPRESS;
  const jarOwner = 600 * jarStandard + OWNER_DESIGN_SETUP;

  return [
    make("T1", "600 × 3oz jar labels", 600, jarCurrent, "600 × 10s + 10 min setup + prepress 15 min @ $25/hr", jarOwner, "600 × $0.20/jar + art/print setup $9.3333", "Jar application 600 × $0.20 = $120.00 (was ≈$45.83 incl. setup); design setup $9.33 (was $6.25)."),
    make("T2", "600 × 4oz jar labels", 600, jarCurrent, "600 × 10s + 10 min setup + prepress 15 min @ $25/hr", jarOwner, "600 × $0.20/jar + art/print setup $9.3333", "Same speeds as T1 — identical labor change."),
    make("T3", "1,000 × 4x5 sticker bags (front only)", 1000, currentApplication(1000, CURRENT_CALC_LABOR.bagApplicationSecondsPerSide, CURRENT_CALC_LABOR.bagApplicationSetupMinutes) + CURRENT_PREPRESS, "1,000 × 10s + 5 min setup + prepress @ $25/hr", 1000 * bagSideStandard + OWNER_DESIGN_SETUP, "1,000 × $0.1111/side + setup $9.3333", "Front-only application 1,000 × $0.1111 = $111.11 (was ≈$71.53 incl. setup)."),
    make("T3b", "1,000 × 4x5 sticker bags (front + back)", 1000, currentApplication(2000, CURRENT_CALC_LABOR.bagApplicationSecondsPerSide, CURRENT_CALC_LABOR.bagApplicationSetupMinutes) + CURRENT_PREPRESS, "2,000 sides × 10s + 5 min setup + prepress @ $25/hr", 2000 * bagSideStandard + OWNER_DESIGN_SETUP, "2,000 sides × $0.1111 + setup $9.3333", "Front+back application 1,000 × $0.2222 = $222.22 (was ≈$140.97 incl. setup)."),
    make("T5", "Banner vinyl test (no application)", 1, CURRENT_PREPRESS, "Prepress 'basic' 15 min @ $25/hr", OWNER_DESIGN_SETUP, "Art setup $8.3333 + print setup $1.00 per design", "Design setup becomes per-design $9.33 (was per-job $6.25); no application labor either way."),
    make("T7", "Spot gloss / white-gloss setup test", 500, CURRENT_PREPRESS + CURRENT_CALC_LABOR.glossWhiteSetup, "Prepress $6.25; gloss/white setup $0 today", OWNER_DESIGN_SETUP + glossSetupStandard, "Design setup $9.3333 + gloss/white setup $8.3333 (labor only)", "Adds the $8.33 gloss/white SETUP labor the calculator currently charges nothing for — ink usage profiles unchanged."),
  ];
}

// ---------- Approved Cost Updates (13.2.2) ----------
// Pure matching/diff logic for applying the owner-approved cost truth list.
// The truth table and db orchestration live in approved-cost-updates.server.ts;
// everything here is client-safe and unit-tested.

export const APPLY_CONFIRM_PHRASE = "APPLY VERIFIED COSTS";

export type ApprovedUpdateStatus =
  | "already_correct"
  | "will_update"
  | "will_create"
  | "missing_record"
  | "ambiguous"
  | "manual_review"
  | "do_not_update";

export const APPROVED_UPDATE_STATUS_LABELS: Record<ApprovedUpdateStatus, string> = {
  already_correct: "Already correct",
  will_update: "Will update",
  will_create: "Will create",
  missing_record: "Missing record — manual create/review",
  ambiguous: "Ambiguous — manual review",
  manual_review: "Needs manual review",
  do_not_update: "Do not update (owner decision)",
};

export type ApprovedTier = { minQty: number; maxQty: number | null; unitCost: number };

// Template/placeholder records must never be captured by normal item matching
// (e.g. "Template - 4x5 Outsourced Stock Bag" must not match the 4x5 blank bag).
export function looksLikeTemplateRecord(name: unknown) {
  return /template|outsourced|stock\s?bag/i.test(String(name ?? ""));
}

// Safest-identifier matching: exact vendorSku first, then a unique anchored
// name match among non-template candidates. Multiple hits = ambiguous.
export function matchApprovedRecord<T extends { id: string; name: string | null; vendorSku: string | null }>(
  item: { matchVendorSkus: string[]; matchName: RegExp; allowTemplates?: boolean },
  candidates: T[],
): { status: "matched" | "missing" | "ambiguous"; record: T | null; hits: T[] } {
  const skuSet = new Set(item.matchVendorSkus.map((sku) => normalizeSku(sku)));
  const pool = item.allowTemplates ? candidates : candidates.filter((c) => !looksLikeTemplateRecord(c.name));

  const bySku = pool.filter((c) => c.vendorSku && skuSet.has(normalizeSku(c.vendorSku)));
  if (bySku.length === 1) return { status: "matched", record: bySku[0], hits: bySku };
  if (bySku.length > 1) return { status: "ambiguous", record: null, hits: bySku };

  const byName = pool.filter((c) => item.matchName.test(String(c.name ?? "")));
  if (byName.length === 1) return { status: "matched", record: byName[0], hits: byName };
  if (byName.length > 1) return { status: "ambiguous", record: null, hits: byName };
  return { status: "missing", record: null, hits: [] };
}

// Order-insensitive tier comparison: equal when every approved (min,max,cost)
// row exists exactly once in the current set and counts match.
export function tiersMatchApproved(
  currentTiers: Array<{ minQty: number; maxQty: number | null; unitCost: number }>,
  approvedTiers: ApprovedTier[],
) {
  if (currentTiers.length !== approvedTiers.length) return false;
  const keyOf = (tier: { minQty: number; maxQty: number | null; unitCost: number }) =>
    `${Number(tier.minQty)}|${tier.maxQty == null ? "" : Number(tier.maxQty)}|${Number(tier.unitCost).toFixed(4)}`;
  const current = new Map<string, number>();
  for (const tier of currentTiers) current.set(keyOf(tier), (current.get(keyOf(tier)) || 0) + 1);
  for (const tier of approvedTiers) {
    const key = keyOf(tier);
    const count = current.get(key) || 0;
    if (!count) return false;
    current.set(key, count - 1);
  }
  return true;
}

export function tierChangeSummary(
  currentTiers: Array<{ minQty: number; maxQty: number | null; unitCost: number }>,
  approvedTiers: ApprovedTier[],
) {
  const label = (tier: { minQty: number; maxQty: number | null }) =>
    tier.maxQty == null ? `${tier.minQty}+` : `${tier.minQty}-${tier.maxQty}`;
  const currentByRange = new Map(currentTiers.map((tier) => [label(tier), Number(tier.unitCost)]));
  const parts: string[] = [];
  for (const tier of approvedTiers) {
    const existing = currentByRange.get(label(tier));
    if (existing == null) parts.push(`${label(tier)}: add $${tier.unitCost.toFixed(4)}`);
    else if (!nearlyEqual(existing, tier.unitCost, 0.0001)) parts.push(`${label(tier)}: $${existing.toFixed(4)} -> $${tier.unitCost.toFixed(4)}`);
  }
  for (const tier of currentTiers) {
    if (!approvedTiers.some((approved) => label(approved) === label(tier))) parts.push(`${label(tier)}: remove`);
  }
  return parts;
}

// ---------- Known-job replay tests (T1-T7) ----------

export type ReplayTest = {
  id: string;
  name: string;
  quantity: number | null;
  product: string;
  finish: string;
  drivers: string;
  verify: string;
  href: string | null;
  hrefLabel: string;
  pending: boolean;
};

// The fields each replay slot eventually records. Read-only prep for now (no
// schema): rendered as blank fill-in cells on the page and in the CSV; results
// get written into docs/GSO_ERP_PROJECT_STATE.md until a schema patch adds a
// proper replay-results model.
export const REPLAY_RECORD_FIELDS = [
  "job name",
  "quantity",
  "product/material",
  "label/art sqft",
  "finish",
  "estimated app cost",
  "actual material used",
  "actual ink/RIP result",
  "actual labor minutes",
  "actual machine/print minutes",
  "variance",
  "owner notes",
] as const;

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

// 13.2.5 replay slots: the owner's seven known-job tests. Each slot prefills
// the Cost Calculator where records exist; real label/art sizes are always
// left for the owner to enter. Results are recorded manually for now.
export function buildReplayTests(context: {
  threeOzItemId: string | null;
  fourOzItemId: string | null;
  bagItemId: string | null;
  dtpPouchItemId: string | null;
  bannerVinylMaterialId: string | null;
}): ReplayTest[] {
  const jarBase = {
    lineCount: 1,
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
      name: "600 × 3oz jar labels",
      quantity: 600,
      product: "3oz SAFECARE jar (verified $0.50/$0.62) + label media",
      finish: "CMYK (choose media on the page)",
      drivers: "Verified 3oz blank cost, media $/sqft, application seconds, cutting, prepress, packout",
      verify: "Estimated total vs what this job was actually charged; blank cost line at the verified value.",
      href: context.threeOzItemId
        ? calculatorPrefillUrl({ ...jarBase, lineName: "3oz jar label", lineQty: 600, itemId: context.threeOzItemId })
        : null,
      hrefLabel: context.threeOzItemId ? "Open prefilled in Cost Calculator (enter real label size)" : "3oz jar item not found in Vendor Products",
      pending: false,
    },
    {
      id: "T2",
      name: "600 × 4oz jar labels",
      quantity: 600,
      product: "4oz SAFECARE jar (verified $0.60/$0.65) + label media",
      finish: "CMYK",
      drivers: "Verified 4oz blank cost, media $/sqft, application seconds",
      verify: "Suggested price vs the jar sell sheet; blank cost line at the verified value.",
      href: context.fourOzItemId
        ? calculatorPrefillUrl({ ...jarBase, lineName: "4oz jar label", lineQty: 600, itemId: context.fourOzItemId })
        : null,
      hrefLabel: context.fourOzItemId ? "Open prefilled in Cost Calculator (enter real label size)" : "4oz jar item not found in Vendor Products",
      pending: false,
    },
    {
      id: "T3",
      name: "1,000 × 4x5 sticker bags",
      quantity: 1000,
      product: "4x5 blank bag (verified $0.09) + label media",
      finish: "CMYK",
      drivers: "Verified bag cost, media $/sqft, flat-bag application, cutting",
      verify: "Compare against the live configurator price for the same combo; bag line at $0.09.",
      href: context.bagItemId
        ? calculatorPrefillUrl({ lineCount: 1, lineName: "4x5 bag label", lineQty: 1000, lineLabelType: "front", itemMode: "inventory", itemId: context.bagItemId, applicationMode: "apply-flat-bag", cuttingMode: "square" })
        : null,
      hrefLabel: context.bagItemId ? "Open prefilled in Cost Calculator (enter real label size)" : "4x5 bag item not found",
      pending: false,
    },
    {
      id: "T4",
      name: "DTP 4x5x2 pouch tier test",
      quantity: 2500,
      product: "DTP 4x5x2 blank pouch (verified tiers 0.7138 -> 0.3117)",
      finish: "Blank item only",
      drivers: "Verified pouch tier selection at quantity boundaries (1000/2500/5000/7500/10000)",
      verify: "Item cost row picks the right tier: 2,500 units must price at $0.4744; re-run at 1,000 ($0.7138) and 5,000 ($0.4029).",
      href: context.dtpPouchItemId
        ? calculatorPrefillUrl({ lineCount: 1, lineQty: 2500, itemMode: "inventory", itemId: context.dtpPouchItemId, applicationMode: "none" })
        : null,
      hrefLabel: context.dtpPouchItemId ? "Open prefilled in Cost Calculator (tier check at 2,500)" : "DTP 4x5x2 pouch record not found",
      pending: false,
    },
    {
      id: "T5",
      name: "Banner vinyl test",
      quantity: 1,
      product: "Banner Vinyl (verified $0.2963/sqft)",
      finish: "CMYK banner",
      drivers: "Verified banner $/sqft at large-format sizes; machine speed/setup assumptions",
      verify: "Enter a real banner size (e.g. 3ft x 8ft = 24 sqft) and compare material cost to 24 x $0.2963 = $7.11 before waste.",
      href: context.bannerVinylMaterialId
        ? calculatorPrefillUrl({ lineCount: 1, lineName: "Banner", lineQty: 1, lineMaterialId: context.bannerVinylMaterialId, lineWastePct: 5 })
        : null,
      hrefLabel: context.bannerVinylMaterialId ? "Open prefilled in Cost Calculator (enter banner size)" : "Banner Vinyl material not found",
      pending: false,
    },
    {
      id: "T6",
      name: "Heavy white ink label/job",
      quantity: 500,
      product: "Any clear/holographic label with white underprint",
      finish: "CMYK + White Heavy",
      drivers: "UNVERIFIED ink usage per sqft — the $/sqft white profile vs verified $0.176/ml raw cost x real ml usage",
      verify: "Run estimated mode, then the same art in Actual GSOQ mode after RIP; the gap is the usage calibration error (13A).",
      href: calculatorPrefillUrl({ lineCount: 1, lineName: "White-heavy label", lineQty: 500, lineInkEstimateProfile: "cmyk-white-heavy" }),
      hrefLabel: "Open prefilled in Cost Calculator (white-heavy profile)",
      pending: false,
    },
    {
      id: "T7",
      name: "Spot gloss / multi-layer gloss test",
      quantity: 500,
      product: "Any label with 2X-3X spot gloss",
      finish: "CMYK + 3X Gloss Heavy",
      drivers: "UNVERIFIED gloss ink usage + Roland speed at multi-layer gloss; verified $0.19867/ml raw cost",
      verify: "Estimated vs Actual GSOQ for a real gloss job; also sanity-check print minutes vs the finish speed curve.",
      href: calculatorPrefillUrl({ lineCount: 1, lineName: "Spot gloss label", lineQty: 500, lineInkEstimateProfile: "cmyk-3x-gloss-heavy" }),
      hrefLabel: "Open prefilled in Cost Calculator (3X gloss profile)",
      pending: false,
    },
  ];
}
