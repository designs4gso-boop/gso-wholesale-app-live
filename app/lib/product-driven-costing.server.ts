// Product-driven costing (14C.1). Pure — the route resolves DB records by
// posted ID and passes VALUES in; the server derives every technical number
// (sqft, waste, boxes, weeding pages, layer ink, passes). Client-posted costs,
// sqft, boxes, and waste are never trusted; the save action re-runs this.
//
// PROVISIONAL LAYER MODEL (documented; replace after 13A.8 calibration): no
// verified per-layer usage formula exists, so each white/gloss layer is
// modeled as ONE additional full-coverage pass using the same ml/sqft as the
// base CMYK pass (linear). Passes = 1 + whiteLayers + glossLayers; machine
// minutes scale by passes when a minutes/sqft model is supplied. All layer
// lines are labeled with the layer count and "provisional linear model".

import { INK_RATES, OWNER_LABOR, resolveMarginFamily, type CostLine, type SourceLabel } from "./calculator-emergency.server";
import { WIRED_LABOR, blankItemUnitCostAtQty } from "./cost-calculator.server";
import { familyByKeyOrAlias } from "./product-family-registry";

export const PRODUCT_ENGINE_VERSION = "14C.1";
// 14C.2: snapshot engine for the complete product-to-price flow (multi-label
// jar builder + automatic family tiers fed directly from the calculated job).
export const MULTILABEL_ENGINE_VERSION = "14C.2-multilabel-auto-tiers";
// 15F.0: production-ready pricing — complete cost model (machine, cutting,
// packing, shipping ownership) + commercial price policy. New snapshots
// record this version; historical snapshots are never rewritten.
export const PRODUCTION_READY_ENGINE_VERSION = "15F.0-production-ready-pricing";

// ---------- 15F.0-D/E: machine + cutting standards (single location) ----------
// Machine recovery: OWNER standard $8/hr (owner-standards registry) x a
// PRODUCTION-TIME model. Time model precedence: Advanced minutes/sqft
// override -> verified machine speed (Machine.sqftPerHour, both live
// printers 150) -> BLOCKED (never silently $0 for in-house printing).
// The stale $5/hr Machine.costPerHour and the quarantined $25/hr are NEVER
// used as the recovery rate.
// 15F.0G.2 PRINTER-SPECIFIC production profiles — never one global CMYK
// constant, and TWO DISTINCT ARCHITECTURES:
// ROLAND = ADDITIVE mode-time model (owner-corrected RIP profiles
// 2026-07-25; head speeds CMYK 1,354 / Gloss 1,016 / White HD 677 mm/sec;
// overprint 1x PER SELECTED LAYER): CMYK 150 sqft/hr baseline; Gloss/Emboss
// 110 and White HD 75 sqft/hr per selected layer; hours sum per mode.
// MIMAKI UCJV300-130 = COMBINED RasterLink configuration-throughput model
// (owner-verified 2026-07-25). Active standard production profile:
//   600x1200 VD / 32 pass / Overprint 1 / Bi-direction / Fast Print High /
//   LUS-170 ink. Effective throughput by TOTAL production layers:
//   1 layer (CMYK only) 51.6 sqft/hr; 2 layers (e.g. CMYK+white) 18.2;
//   3 layers 11.8; 4 layers 8.6. Runtime x1.15 UCJV300-130 carriage/
//   turnaround factor, applied ONCE to total time. This is the verified
//   profile for THIS configuration — not a universal spec for every Mimaki
//   resolution/pass mode. (The interim G.1 single-rate figure was incorrect
//   and is retired.) Unsupported layer totals (5+) BLOCK.
export const ROLAND_CMYK_SQFT_PER_HOUR = 150; // Roland verified baseline
// Back-compat alias: the generic value — ONLY the Roland baseline and the
// stale-Machine-record marker (see resolvePrinterSpeeds in the route).
export const DOCUMENTED_PRINTER_SQFT_PER_HOUR = ROLAND_CMYK_SQFT_PER_HOUR;
export const ROLAND_PRINT_MODE_SQFT_PER_HOUR = {
  glossPerLayer: 110,
  whitePerLayer: 75,
} as const;

// 15F.0J.3 — Roland LG-640 MEASURED ink calibration (owner-ratified
// provisional). Source: Roland VersaWorks all-time job log forensic
// analysis, 2026-03-26..2026-07-24 (docs/GSO_ERP_ROLAND_LOG_FORENSIC_
// ANALYSIS.md; median ml per RIP-layout sqft from accepted completion
// records). Replaces the generic 0.6 ml/sqft basis for ROLAND ONLY —
// Mimaki keeps its own paths. Area basis at quote time: the engine's
// waste-adjusted sqft as the QUOTE-TIME LAYOUT PROXY (measured layout
// utilization ~99%, so no second hidden multiplier is added; the basis is
// labeled and snapshotted). Coverage factors default 1.00 (coverage % is
// not collected yet — exposed in the breakdown). RUNTIME stays on the
// existing provisional model — ink and runtime calibration are separate.
// Future refinements come only from new measured actuals + owner approval.
export const ROLAND_INK_CALIBRATION = {
  version: "15F.0J.3-roland-measured-ink",
  printerModel: "Roland TrueVIS LG-640",
  source: "Roland VersaWorks all-time job log forensic analysis (2026-03-26..2026-07-24)",
  areaBasis: "waste-adjusted sqft (quote-time layout proxy; measured layout utilization ~99%)",
  cmykMlPerSqft: 1.05, // n=127, HIGH confidence (median 1.052)
  whiteMlPerSqftPerLayer: 1.9, // n=14-21, MEDIUM confidence (combined-stage median 1.92)
  glossMlPerSqftPerStage: 2.83, // n=164, HIGH confidence (median 2.834; per selected gloss STAGE)
  coverageFactor: 1.0, // documented default until coverage % is collected
  status: "measured provisional (owner-ratified 2026-07-26)",
} as const;
export const MIMAKI_UCJV_RASTERLINK_PROFILE = {
  label: "600x1200 VD / 32-pass / Bi-direction / Fast Print High (LUS-170)",
  turnaroundFactor: 1.15, // UCJV300-130 physical carriage/turnaround, once per job
  sqftPerHourByTotalLayers: { 1: 51.6, 2: 18.2, 3: 11.8, 4: 8.6 } as Record<number, number>,
} as const;

// 15F.0G.3 — PROVISIONAL Mimaki premium-ink estimate (owner decision
// 2026-07-25): routine gloss quotes must not block waiting for RIP actuals.
// Gloss estimate = adjustedSqft x CMYK ml/sqft basis (0.6) x glossLayers x
// approvedGlossFactor x $0.176/ml — labeled estimated, NEVER verified.
// White keeps its existing VERIFIED rate (mimakiWhitePerMl): the provisional
// approach applies only where a cost is missing. whiteFactor exists
// SEPARATELY for calibration metadata and the future editable settings
// (ownerConfig.inkCalibration.mimaki.whiteFactor / .glossFactor, 15F.1).
// Finalized RIP actuals feed READ-ONLY calibration recommendations
// (app/lib/ink-calibration.server.ts); factors change only by owner
// approval; every quote snapshots the factor used; historical snapshots are
// never rewritten.
export const PREMIUM_INK_ESTIMATE_VERSION = "15F.0G.3-provisional-ink-estimate";
export const MIMAKI_INK_CALIBRATION = {
  whiteFactor: 1.0, // separate from gloss; code-backed default until 15F.1 ownerConfig
  glossFactor: 1.0,
} as const;

// Snapshot metadata for premium (white/gloss) Mimaki quotes — the record RIP
// actuals are later compared against. Returns null when no premium layers.
export function buildMimakiPremiumInkEstimate(input: {
  wasteAdjustedSqft: number;
  whiteLayers: number;
  glossLayers: number;
  inkMlPerSqft: number;
}): {
  printer: string; profile: string; baseMlPerSqft: number; inkCostPerMl: number;
  whiteLayers: number; glossLayers: number; whiteFactor: number; glossFactor: number;
  estimatedWhiteMl: number; estimatedGlossMl: number;
  estimatedWhiteCost: number; estimatedGlossCost: number; sourceVersion: string;
} | null {
  const whiteLayers = Math.max(0, Math.floor(input.whiteLayers));
  const glossLayers = Math.max(0, Math.floor(input.glossLayers));
  if (whiteLayers <= 0 && glossLayers <= 0) return null;
  const sqft = Math.max(0, input.wasteAdjustedSqft);
  const basis = Math.max(0, input.inkMlPerSqft);
  const estimatedWhiteMl = sqft * basis * whiteLayers * MIMAKI_INK_CALIBRATION.whiteFactor;
  const estimatedGlossMl = sqft * basis * glossLayers * MIMAKI_INK_CALIBRATION.glossFactor;
  return {
    printer: "Mimaki UCJV300-130",
    profile: MIMAKI_UCJV_RASTERLINK_PROFILE.label,
    baseMlPerSqft: basis,
    inkCostPerMl: INK_RATES.mimakiCmykPerMl,
    whiteLayers, glossLayers,
    whiteFactor: MIMAKI_INK_CALIBRATION.whiteFactor,
    glossFactor: MIMAKI_INK_CALIBRATION.glossFactor,
    estimatedWhiteMl, estimatedGlossMl,
    estimatedWhiteCost: estimatedWhiteMl * INK_RATES.mimakiWhitePerMl,
    estimatedGlossCost: estimatedGlossMl * INK_RATES.mimakiCmykPerMl,
    sourceVersion: PREMIUM_INK_ESTIMATE_VERSION,
  };
}

// Owner-documented cutting standards (15F.0-E). Square/rectangle: the owner
// measured 15.7 minutes = $6.53 at the applicable labor standard; applied per
// 54x54in production page (the same page unit as weeding) so cost scales
// deterministically with quantity/sqft. Kiss/contour and die-cut/complex have
// NO verified model yet — they BLOCK with an exact configuration message
// instead of silently charging $0 (or wrongly borrowing the square model).
export const CUT_TYPES = [
  { value: "none", label: "No cutting required" },
  { value: "square-rect", label: "Square / rectangle cut" },
  { value: "kiss-simple", label: "Kiss cut — simple contour (circles, ovals, rounded shapes)" },
  { value: "kiss-moderate", label: "Kiss cut — moderate contour (multi-curve outlines)" },
  { value: "kiss-complex", label: "Kiss cut — complex contour (detailed outlines)" },
  { value: "die-irregular", label: "Die cut / irregular production (needs owner standard)" },
] as const;
export const CUT_SQUARE_RECT_STANDARD = {
  minutesPerPage: 15.7,
  costPerPage: 6.53,
  basis: "Owner-documented square/rectangle model: 15.7 min = $6.53 per 54x54in production page",
} as const;
// 15F.0-FINAL contour bands (PROVISIONAL conservative, editable in 15F.1):
// contour cut paths run longer and slower than the straight grid path the
// square/rectangle page standard measures — the multiplier approximates the
// perimeter/path increase per page (simple ~+15%, moderate ~+35%, complex
// ~+60% of the measured 15.7-min page). Pages already scale with quantity and
// label size, and cut setup is inside the owner art-setup standard, so
// contour cost = pages x $6.53 x band. Die-cut/irregular production has NO
// safe model and stays BLOCKED.
export const CUT_CONTOUR_MULTIPLIERS: Record<string, { multiplier: number; label: string }> = {
  "kiss-simple": { multiplier: 1.15, label: "simple contour (+15% of the square/rect page standard, provisional)" },
  "kiss-moderate": { multiplier: 1.35, label: "moderate contour (+35%, provisional)" },
  "kiss-complex": { multiplier: 1.6, label: "complex contour (+60%, provisional)" },
};
export type NormalizedCutType = "none" | "square-rect" | "kiss-simple" | "kiss-moderate" | "kiss-complex" | "die-irregular";
// Legacy pcut values from saved quote links: "kiss"/"weeded" (14C-era simple
// square kiss cuts) map to square-rect; the short-lived 15F.0 "kiss-contour"
// maps to the simple contour band; "die-complex"/"die" stay blocked.
export function normalizeCutType(raw: string | null | undefined): NormalizedCutType {
  const value = String(raw || "").toLowerCase();
  if (value === "none") return "none";
  if (value === "kiss-simple" || value === "kiss-contour" || value === "contour") return "kiss-simple";
  if (value === "kiss-moderate") return "kiss-moderate";
  if (value === "kiss-complex") return "kiss-complex";
  if (value === "die-irregular" || value === "die-complex" || value === "die" || value === "die-cut") return "die-irregular";
  return "square-rect"; // includes legacy "kiss" / "weeded" / blank
}

// 15F.0-FINAL banner finishing standards (PROVISIONAL conservative, labeled;
// editable in 15F.1). Basis: owner labor standard $25/hr. Hems: ~50 linear
// ft/hr -> $0.50/ft labor + $0.10/ft hem tape = $0.60 per finished perimeter
// foot. Grommets: one per 24in of perimeter (corners included by the ceil),
// ~0.5 min each -> $0.21 labor + $0.10 consumable ~= $0.30 each. One $5
// finishing setup per job when any finishing is selected. Trimming is the
// square/rect cutting line. Specialty finishing (pole pockets, wind slits,
// keder) has no standard and is not selectable — documented as unsupported.
export const BANNER_FINISHING_STANDARDS = {
  hemPerFoot: 0.6,
  hemBasis: "$0.50/ft labor (owner $25/hr at ~50 ft/hr, provisional) + $0.10/ft hem tape",
  grommetEach: 0.3,
  grommetSpacingIn: 24,
  grommetBasis: "~0.5 min labor each at the owner $25/hr standard + $0.10 consumable (provisional)",
  finishingSetupPerJob: 5,
  setupBasis: "Finishing setup/handling per job (provisional conservative)",
} as const;

// 15F.0-FINAL packing realism (PROVISIONAL, labeled): stickers ~5,000 per
// box; banners ship rolled in tubes (~5 per tube, $4/tube consumable+labor) —
// never priced like a sticker box.
export const STICKER_UNITS_PER_BOX_DEFAULT = 5000;
export const BANNER_TUBE_CAPACITY = 5;
export const BANNER_TUBE_COST = 4;

// 15F.0-F: packing family defaults where no verified units-per-box rule
// exists. Jar families use the documented Safe Care 4oz density (100/box) as
// the family default (labeled estimated — owner confirmation pending);
// stickers/banners/misc bags use a single-box-per-job floor of the $2 owner
// packout standard (labeled estimated). Packing is NEVER silently $0 for a
// supported non-custom family.
export const JAR_FAMILY_DEFAULT_UNITS_PER_BOX = 100;
export const MAX_LAYERS = 14;
export const MAX_LABELS_PER_UNIT = 6;
export const WEEDING_PAGE_SQFT = (54 * 54) / 144; // 20.25 sqft per 54x54in page

// Owner-verified Safe Care packing (documented constants until an ERP
// units-per-box field exists). Missing entries = Estimated/Missing packout.
export const PACKOUT_RULES: Array<{ match: RegExp; unitsPerBox: number; label: string }> = [
  { match: /4\s?x\s?5.*bag|bag.*4\s?x\s?5/i, unitsPerBox: 1000, label: "4x5 blank bags: 1,000/box (Safe Care)" },
  { match: /3\s?oz/i, unitsPerBox: 150, label: "3 oz jars: 150/box (Safe Care)" },
  { match: /4\s?oz/i, unitsPerBox: 100, label: "4 oz jars: 100/box (Safe Care)" },
];

export function unitsPerBoxFor(productName: string): { unitsPerBox: number | null; label: string | null } {
  const rule = PACKOUT_RULES.find((candidate) => candidate.match.test(productName));
  return rule ? { unitsPerBox: rule.unitsPerBox, label: rule.label } : { unitsPerBox: null, label: null };
}

export function validateLayers(value: number): { ok: boolean; value: number; error: string | null } {
  if (!Number.isFinite(value) || value < 0) return { ok: false, value: 0, error: "Layers cannot be negative." };
  if (value > MAX_LAYERS) return { ok: false, value: MAX_LAYERS, error: `Layers cannot exceed ${MAX_LAYERS}.` };
  return { ok: true, value: Math.floor(value), error: null };
}

// ---------- 14C.2: jar multi-label rows (server-built, never client-trusted) ----------
// Terminology guard: these are PRINTED labels (a "Lid label" is artwork applied
// to the lid). The Miron "Top type" is the PHYSICAL jar top — separate concept,
// separate field, separate snapshot key.
export const LABEL_TYPES = [
  { value: "side", label: "Side label" },
  { value: "lid", label: "Lid label" },
  { value: "bottom", label: "Bottom label" },
  { value: "neck", label: "Neck label" },
  { value: "tamper", label: "Tamper label" },
  { value: "additional", label: "Additional label" },
  { value: "custom", label: "Custom" },
];

export function defaultLabelTypesFor(count: number): string[] {
  const n = Math.min(Math.max(1, Math.floor(count || 1)), MAX_LABELS_PER_UNIT);
  if (n === 1) return ["side"];
  if (n === 2) return ["side", "lid"];
  return ["side", "lid", ...Array.from({ length: n - 2 }, () => "additional")];
}

export type LabelRow = { type: string; typeLabel: string; widthIn: number; heightIn: number };

// One shared row builder for loader AND save action. Rows are derived strictly
// from the posted count — extra posted array entries (stale hidden rows) are
// discarded here, so they can never affect cost. Same-size mode replicates one
// width/height across every row with the documented default types.
export function buildLabelRows(params: {
  count: number;
  same: boolean;
  sameWidthIn: number;
  sameHeightIn: number;
  types: string[];
  widths: number[];
  heights: number[];
}): LabelRow[] {
  const count = Math.min(Math.max(1, Math.floor(params.count || 1)), MAX_LABELS_PER_UNIT);
  const defaults = defaultLabelTypesFor(count);
  const valid = new Set(LABEL_TYPES.map((option) => option.value));
  const rows = Array.from({ length: count }, (_v, index) => {
    const type = params.same
      ? defaults[index]
      : valid.has(String(params.types[index] || "")) ? String(params.types[index]) : defaults[index];
    const widthIn = params.same ? Number(params.sameWidthIn) : Number(params.widths[index]);
    const heightIn = params.same ? Number(params.sameHeightIn) : Number(params.heights[index]);
    return {
      type,
      typeLabel: LABEL_TYPES.find((option) => option.value === type)?.label || "Custom",
      widthIn: Number.isFinite(widthIn) && widthIn > 0 ? widthIn : 0,
      heightIn: Number.isFinite(heightIn) && heightIn > 0 ? heightIn : 0,
    };
  });
  // number repeated "Additional label" rows so breakdown lines stay distinct
  const additionalCount = rows.filter((row) => row.type === "additional").length;
  if (additionalCount > 1) {
    let n = 0;
    for (const row of rows) if (row.type === "additional") row.typeLabel = `Additional label ${++n}`;
  }
  return rows;
}

// Bag application labor by BAG SIZE (owner standards only; unknown sizes are
// a MISSING blocker, never silently priced at the 4x5 rate).
export function bagApplicationRateFor(bagName: string): { rate: number | null; source: SourceLabel; basis: string } {
  const text = String(bagName || "");
  if (/14\s?x\s?16|pound/i.test(text)) return { rate: WIRED_LABOR.bag14x16PerSide, source: "owner_standard", basis: "14x16 bag $1.00/label (owner standard)" };
  if (/4\s?x\s?5\b/i.test(text)) return { rate: OWNER_LABOR.bagLabelApplicationPer, source: "owner_standard", basis: "4x5 bag $0.0781/label (owner standard)" };
  return { rate: null, source: "missing", basis: "No owner application-labor standard for this bag size" };
}

export type ProductFamilyKey = "bags-4x5" | "chiron-jars" | "miron-jars" | "stickers-labels" | "banners" | "custom" | "dtp-bags";

// ---------- 15C: Spektra DTP constants (vendor rules, single location) ----------
export const DTP_ENGINE_VERSION = "15C-spektra-dtp";
// $85 flat per Spektra PURCHASE ORDER — never per design, size, or line item.
// Multi-line orders on one PO enter the charge ONCE and allocate across the
// combined units (documented; multi-line ordering itself lands in a later phase).
export const SPEKTRA_FREIGHT_PER_PO = 85;
export const DTP_TIER_QUANTITIES = [1000, 2500, 5000, 7500];

// 15C.1 owner-authoritative DTP margin thresholds — margin is determined by
// QUANTITY, never by table row count or row position (the generic
// curveForTierCount 4-row mapping would wrongly drop the 52% point):
//   1,000-2,499 -> 65% | 2,500-4,999 -> 58% | 5,000-7,499 -> 52%
//   7,500-9,999 -> 46% | 10,000+ -> 42%
// Margin values come from the researched dtp-pouches curve (never duplicated
// here); these thresholds map quantity -> curve position. Vendor unit cost
// above 7,500 stays on the highest reached Spektra tier — margin follows the
// thresholds independently. 42% family minimum + 40% global floor preserved.
export const DTP_MARGIN_QUANTITY_THRESHOLDS = [1000, 2500, 5000, 7500, 10000];
export function dtpMarginPctForQuantity(quantity: number): number {
  const rule = resolveMarginFamily("dtp-pouches");
  const curve = rule ? rule.curve : [65, 58, 52, 46, 42];
  const familyMin = rule ? rule.familyMinPct : 42;
  let index = 0;
  for (let position = 0; position < DTP_MARGIN_QUANTITY_THRESHOLDS.length; position += 1) {
    if (quantity >= DTP_MARGIN_QUANTITY_THRESHOLDS[position]) index = position;
  }
  return Math.max(curve[Math.min(index, curve.length - 1)] ?? familyMin, familyMin);
}

export type ResolvedComponent = {
  name: string;
  unitCost: number | null; // resolved default; tiers refine by quantity
  tiers: Array<{ minQty: number; maxQty: number | null; unitCost: number }>;
  status: SourceLabel; // verified when priced from a DB record; estimated for custom-with-note
  includesCap?: boolean;
  note?: string;
};

export type ProductDrivenInput = {
  family: ProductFamilyKey;
  quantity: number;
  designs: number;
  facesPerUnit: number; // normalized from Front only/Front+back, labels per jar, sides, custom faces
  widthIn: number;
  heightIn: number;
  // 14C.2: jar multi-label rows (built server-side by buildLabelRows). When
  // present they REPLACE facesPerUnit/widthIn/heightIn: pieces = quantity x
  // rows, sqft = sum of every row, each row needs positive dimensions.
  labelRows?: LabelRow[] | null;
  // 15C: Spektra DTP (vendor-FINISHED pouches — no in-house print math).
  // Features come from the record's VendorProductAddOn rows (resolved by the
  // route, never duplicated in code); freightPerOrder is the resolved flat
  // per-PO charge (user-entered actual freight wins over the $85 default).
  dtp?: {
    sizeLabel: string;
    moq: number;
    hangHole: boolean;
    includedFeatures: string[];
    optionalFeatures: Array<{ name: string; amount: number }>;
    freightPerOrder: number;
    freightSource: SourceLabel;
    freightNote: string;
  } | null;
  blank: ResolvedComponent | null; // null = No Blank Item
  lid: ResolvedComponent | null; // Miron only
  // 14C.1B1: Miron top policy — a top selection is ALWAYS required for Miron.
  // Combined vendor sets charge once; matching standard top = $0 incremental;
  // different top = verified upgrade difference only; unverifiable = blocker.
  mironTop?: { setIncludesStandardTop: boolean; includedStandardTopCost: number | null; selectedTopIsStandard: boolean } | null;
  material: { name: string; costPerSqft: number | null; rollLabel?: string } | null;
  printer: "mimaki" | "roland";
  printerHasWhite: boolean;
  printerHasGloss: boolean;
  whiteLayers: number;
  glossLayers: number;
  inkMlPerSqft: number; // active base usage assumption (seeded 0.0075-derived / entered)
  machineMinutesPerSqft: number; // Advanced override only (0 = not overridden)
  // 15F.0-D: verified machine production speed (Machine.sqftPerHour; both live
  // printers 150). 0/absent = no speed model -> in-house printing BLOCKS
  // (never silently $0).
  machineSqftPerHour?: number;
  machineRatePerHour: number;
  // 15F.0-E: cut type (CUT_TYPES). null/undefined on non-cut families.
  cutType?: NormalizedCutType | null;
  cutRequiresWeeding: boolean;
  hemming: boolean;
  grommets: boolean;
  freightPerUnit: number;
  freightSource: SourceLabel;
  recipeWastePct: number | null; // precedence 1; null = fall through
  wasteOverride: { pct: number; reason: string } | null;
  boxOverride: { unitsPerBox: number; reason: string } | null;
};

export type LabelRowDerived = {
  index: number;
  type: string;
  typeLabel: string;
  pieces: number;
  widthIn: number;
  heightIn: number;
  sqin: number;
  baseSqft: number;
  sqftShare: number; // fraction of total base sqft (display allocation)
  materialCostShare: number;
  inkCostShare: number;
  whiteLayers: number;
  glossLayers: number;
  applications: number;
};

export type DerivedValues = {
  sqinPerPiece: number;
  totalPieces: number;
  baseSqft: number;
  wastePct: number;
  wasteSource: string;
  wasteAdjustedSqft: number;
  unitsPerBox: number | null;
  boxes: number | null;
  boxSource: string;
  weedingPages: number;
  weedingBasis: string;
  printPasses: number;
  labelRows: LabelRowDerived[] | null; // 14C.2 multi-label detail (null = single-size flow)
  applicationCount: number; // total labels applied (0 when no application labor line)
};

export function computeProductDrivenCost(input: ProductDrivenInput): {
  lines: CostLine[]; derived: DerivedValues; missing: string[]; warnings: string[];
  totalCost: number; unitCost: number; setupTotal: number; perUnitVariable: number;
} {
  const lines: CostLine[] = [];
  const warnings: string[] = [];
  const quantity = Math.max(1, Math.floor(input.quantity));
  // 15C: vendor-finished DTP pouches skip ALL in-house print derivation
  // (dimensions/material/ink/machine/application/weeding/packing).
  const isDtp = input.family === "dtp-bags";

  // ---- layers (validated; capability-gated) ----
  const white = validateLayers(input.printerHasWhite ? input.whiteLayers : 0);
  const gloss = validateLayers(input.printerHasGloss || input.printer === "roland" ? input.glossLayers : 0);
  if (white.error) warnings.push(`White layers: ${white.error}`);
  if (gloss.error) warnings.push(`Gloss layers: ${gloss.error}`);
  if (!input.printerHasWhite && input.whiteLayers > 0) warnings.push("Selected printer has no white channel — white layers ignored.");
  if (!input.printerHasGloss && input.printer === "mimaki" && input.glossLayers > 0) {
    // still counted so the MISSING blocker fires (never silently dropped)
  }
  const whiteLayers = white.value;
  const glossLayers = input.printer === "mimaki" && !input.printerHasGloss ? Math.floor(Math.max(0, Math.min(MAX_LAYERS, input.glossLayers))) : gloss.value;

  // ---- geometry (server-derived; dimensions required for printed families) ----
  // 14C.2: label rows (jars) sum per-row sqft; every row needs positive
  // dimensions and each invalid row is its OWN missing blocker. Without rows,
  // the single width/height x faces flow is unchanged.
  const rows = input.labelRows && input.labelRows.length ? input.labelRows : null;
  const faces = rows ? rows.length : Math.max(1, Math.floor(input.facesPerUnit));
  const totalPieces = quantity * faces;
  const rowSqft = rows ? rows.map((row) => (row.widthIn > 0 && row.heightIn > 0 ? (row.widthIn * row.heightIn * quantity) / 144 : 0)) : [];
  const sqinPerPiece = rows
    ? rows.reduce((sum, row) => sum + Math.max(0, row.widthIn) * Math.max(0, row.heightIn), 0) / rows.length
    : input.widthIn > 0 && input.heightIn > 0 ? input.widthIn * input.heightIn : 0;
  const baseSqft = rows ? rowSqft.reduce((sum, value) => sum + value, 0) : (sqinPerPiece * totalPieces) / 144;
  if (rows) {
    rows.forEach((row, index) => {
      if (!(row.widthIn > 0 && row.heightIn > 0)) {
        lines.push({ key: `label_dim_${index}`, label: `${row.typeLabel} (label ${index + 1}) — width and height`, amount: 0, source: "missing", note: "Each label row needs a positive width and height — never assumed." });
      }
    });
  } else {
    const printedFamily = (input.family !== "custom" && !isDtp) || (input.family === "custom" && sqinPerPiece > 0);
    if (printedFamily && baseSqft <= 0) {
      lines.push({ key: "dimensions", label: "Print width and height", amount: 0, source: "missing", note: "Dimensions required — square footage is never assumed." });
    }
  }

  // ---- waste precedence: recipe -> override -> provisional 10% ----
  let wastePct: number;
  let wasteSource: string;
  if (input.wasteOverride) {
    wastePct = input.wasteOverride.pct;
    wasteSource = `OVERRIDE (${input.wasteOverride.reason}) — original ${input.recipeWastePct ?? "provisional 10"}%`;
  } else if (input.recipeWastePct != null && input.recipeWastePct >= 0) {
    wastePct = input.recipeWastePct;
    wasteSource = "Product/recipe waste rule";
  } else if (isDtp) {
    wastePct = 0; // vendor-finished — overrun/underrun already inside the quoted vendor cost
    wasteSource = "Not applicable — vendor-finished product (Spektra cost includes overrun/underrun)";
  } else {
    wastePct = 10;
    wasteSource = "PROVISIONAL default 10% (no recipe rule)";
    warnings.push("Waste: no recipe rule — provisional 10% applied (labeled).");
  }
  const wasteMult = 1 / (1 - Math.min(Math.max(wastePct, 0), 90) / 100);
  const wasteAdjustedSqft = baseSqft * wasteMult;

  // ---- blank/lid components (qty-aware tiers, server-resolved) ----
  const componentLine = (component: ResolvedComponent, key: string, capNote: boolean) => {
    const resolved = blankItemUnitCostAtQty(component.tiers, component.unitCost ?? 0, quantity, component.name);
    const unit = resolved.unitCost > 0 ? resolved.unitCost : component.unitCost;
    if (unit != null && unit > 0) {
      lines.push({
        key, label: `${component.name} @ $${unit.toFixed(4)} x ${quantity}${resolved.tierLabel !== "fixed" ? ` (tier ${resolved.tierLabel})` : ""}`,
        amount: unit * quantity, source: component.status,
        note: capNote ? "Cap included — never double-counted." : component.note,
      });
      if (resolved.warning) warnings.push(resolved.warning);
    } else {
      lines.push({ key, label: component.name || "Component", amount: 0, source: "missing", note: "No verified cost on the selected record." });
    }
  };
  if (input.blank) componentLine(input.blank, "blank", input.family === "chiron-jars" || Boolean(input.blank.includesCap));
  if (input.family === "miron-jars") {
    lines.push(resolveMironTopLine({
      quantity,
      selectedTop: input.lid,
      policy: input.mironTop || null,
    }));
  }

  // ---- 15C: Spektra DTP (vendor-finished) lines ----
  if (isDtp) {
    const dtp = input.dtp;
    if (!input.blank) {
      lines.push({ key: "blank", label: "DTP size/product — Required", amount: 0, source: "missing", note: "Select a Spektra DTP size — cost comes from its verified vendor tiers." });
    }
    const moq = Math.max(1, Math.floor(dtp?.moq || 1000));
    if (quantity < moq) {
      lines.push({ key: "moq", label: `Below DTP minimum order — ${moq.toLocaleString()} required`, amount: 0, source: "missing", note: `Spektra MOQ is ${moq.toLocaleString()} units; requested ${quantity.toLocaleString()}.` });
    }
    lines.push({ key: "vendor_setup", label: "Vendor setup / plates / proofs / artwork — included by Spektra", amount: 0, source: "verified", note: "No vendor setup, plate/cylinder, proof/sample, artwork, or per-design fees; overrun/underrun inside the quoted unit cost." });
    if (dtp && dtp.includedFeatures.length) {
      lines.push({ key: "features", label: `Included: ${dtp.includedFeatures.join(", ")}`, amount: 0, source: "verified", note: "Included in the Spektra unit cost — never an additional customer charge." });
    }
    lines.push({ key: "hang_hole", label: `Hang hole — optional, $0${dtp?.hangHole ? " (selected)" : " (not selected)"}`, amount: 0, source: "verified" });
    if (dtp) {
      lines.push({ key: "freight", label: `Spektra freight — $${dtp.freightPerOrder.toFixed(2)} flat per purchase order`, amount: dtp.freightPerOrder, source: dtp.freightSource, note: dtp.freightNote });
    }
  }

  // ---- material + ink + machine ----
  if (baseSqft > 0) {
    if (input.material && input.material.costPerSqft != null) {
      lines.push({ key: "material", label: `${input.material.name}${input.material.rollLabel ? ` (${input.material.rollLabel})` : ""} — ${baseSqft.toFixed(2)} sqft +${wastePct}% waste`, amount: input.material.costPerSqft * wasteAdjustedSqft, source: "verified" });
    } else {
      lines.push({ key: "material", label: input.material?.name || "Material", amount: 0, source: "missing", note: "Select a verified material." });
    }
    const cmykRate = input.printer === "mimaki" ? INK_RATES.mimakiCmykPerMl : INK_RATES.rolandPerMl;
    // 15F.0J.3: ROLAND uses the MEASURED ink calibration (per-printer
    // profile) — never the generic 0.6 ml/sqft basis. Mimaki paths unchanged.
    const isRolandInk = input.printer === "roland";
    if (isRolandInk) {
      const cal = ROLAND_INK_CALIBRATION;
      const cmykMl = wasteAdjustedSqft * cal.cmykMlPerSqft;
      lines.push({
        key: "ink_cmyk",
        label: `CMYK ink — ${cmykMl.toFixed(1)} ml (measured ${cal.cmykMlPerSqft} ml/sqft)`,
        amount: cmykMl * INK_RATES.rolandPerMl,
        source: "estimated",
        formula: `${wasteAdjustedSqft.toFixed(2)} sqft (layout proxy) x ${cal.cmykMlPerSqft} ml/sqft x $${INK_RATES.rolandPerMl.toFixed(4)}/ml`,
        note: `${cal.printerModel} ${cal.version}: MEASURED provisional CMYK rate (HIGH confidence, n=127; ${cal.source}); area basis = ${cal.areaBasis}.`,
      });
    } else {
      lines.push({ key: "ink_cmyk", label: `CMYK ink — base print (${input.inkMlPerSqft} ml/sqft)`, amount: cmykRate * input.inkMlPerSqft * wasteAdjustedSqft, source: "verified" });
    }
    if (whiteLayers > 0) {
      if (isRolandInk) {
        const cal = ROLAND_INK_CALIBRATION;
        const whiteMl = wasteAdjustedSqft * cal.coverageFactor * whiteLayers * cal.whiteMlPerSqftPerLayer;
        lines.push({
          key: "ink_white",
          label: `White ink — ${whiteLayers} layer(s) — ${whiteMl.toFixed(1)} ml (measured ${cal.whiteMlPerSqftPerLayer} ml/sqft/layer)`,
          amount: whiteMl * INK_RATES.rolandPerMl,
          source: "estimated",
          formula: `${wasteAdjustedSqft.toFixed(2)} sqft x coverage ${cal.coverageFactor.toFixed(2)} x ${whiteLayers} layer(s) x ${cal.whiteMlPerSqftPerLayer} ml/sqft x $${INK_RATES.rolandPerMl.toFixed(4)}/ml`,
          note: `${cal.version}: MEASURED provisional white rate (MEDIUM confidence, n=14-21) — the SELECTED layer count only, never an assumed 3X; coverage factor ${cal.coverageFactor.toFixed(2)} (documented default).`,
        });
      } else {
        lines.push({ key: "ink_white", label: `White ink — ${whiteLayers} layer(s), provisional linear model`, amount: INK_RATES.mimakiWhitePerMl * input.inkMlPerSqft * wasteAdjustedSqft * whiteLayers, source: "verified" });
      }
    }
    if (glossLayers > 0) {
      if (isRolandInk) {
        const cal = ROLAND_INK_CALIBRATION;
        const glossMl = wasteAdjustedSqft * cal.coverageFactor * glossLayers * cal.glossMlPerSqftPerStage;
        lines.push({
          key: "ink_gloss",
          label: `Gloss ink — ${glossLayers} stage(s) — ${glossMl.toFixed(1)} ml (measured ${cal.glossMlPerSqftPerStage} ml/sqft/stage)`,
          amount: glossMl * INK_RATES.rolandPerMl,
          source: "estimated",
          formula: `${wasteAdjustedSqft.toFixed(2)} sqft x coverage ${cal.coverageFactor.toFixed(2)} x ${glossLayers} stage(s) x ${cal.glossMlPerSqftPerStage} ml/sqft x $${INK_RATES.rolandPerMl.toFixed(4)}/ml`,
          note: `${cal.version}: MEASURED provisional gloss rate (HIGH confidence, n=164) per selected gloss STAGE — one multiplier per stage, never doubled through mode logic; coverage ${cal.coverageFactor.toFixed(2)}.`,
        });
      } else {
      const glossRate = INK_RATES.mimakiGlossPerMl;
      if (glossRate == null) {
        // 15F.0G.3: Mimaki gloss quotes provisionally on the CMYK basis
        // (owner decision) — never $0, never blocked merely for missing RIP
        // actuals, never labeled verified. BLOCKS only if the ink price or
        // usage basis itself is missing.
        if (input.inkMlPerSqft > 0 && INK_RATES.mimakiCmykPerMl > 0) {
          const glossMl = wasteAdjustedSqft * input.inkMlPerSqft * glossLayers * MIMAKI_INK_CALIBRATION.glossFactor;
          lines.push({
            key: "ink_gloss",
            label: `Gloss ink — ${glossLayers} layer(s) — provisional estimate`,
            amount: glossMl * INK_RATES.mimakiCmykPerMl,
            source: "estimated",
            formula: `${wasteAdjustedSqft.toFixed(2)} sqft x ${input.inkMlPerSqft} ml/sqft x ${glossLayers} layer(s) x factor ${MIMAKI_INK_CALIBRATION.glossFactor.toFixed(2)} x $${INK_RATES.mimakiCmykPerMl}/ml`,
            note: "Provisional Mimaki gloss estimate: CMYK ml/sqft basis x gloss layers x approved gloss factor — reconciled against RIP actuals after production (owner-approved 2026-07-25).",
          });
        } else {
          lines.push({ key: "ink_gloss", label: `Gloss ink — ${glossLayers} layer(s)`, amount: 0, source: "missing", note: "Mimaki ink price/usage basis missing — gloss cannot be estimated." });
        }
      } else {
        // Defensive: a future verified Mimaki gloss rate prices linearly.
        lines.push({ key: "ink_gloss", label: `Gloss ink — ${glossLayers} layer(s), provisional linear model`, amount: glossRate * input.inkMlPerSqft * wasteAdjustedSqft * glossLayers, source: "estimated" });
      }
      }
    }
    const passes = 1 + whiteLayers + glossLayers;
    if (passes > 1) lines.push({ key: "passes", label: `Additional print passes — ${passes - 1}`, amount: 0, source: "estimated", note: "Machine time uses per-MODE speeds below (owner-corrected RIP profiles); ink uses the provisional linear model." });
    // 15F.0-D + owner-corrected RIP profiles: machine recovery is a REQUIRED
    // in-house cost. Time model precedence: Advanced minutes/sqft override
    // (x passes, manual) -> per-MODE speeds (CMYK baseline + 110 sqft/hr per
    // gloss layer + 75 sqft/hr per white layer, 1x per SELECTED layer only,
    // no hidden overprint multipliers) -> BLOCKED. Minutes = hours x 60.
    const machineSqftPerHour = input.machineSqftPerHour ?? 0;
    if (input.machineMinutesPerSqft > 0) {
      const machineMinutes = input.machineMinutesPerSqft * wasteAdjustedSqft * passes;
      lines.push({
        key: "machine",
        label: `Machine recovery — ${machineMinutes.toFixed(1)} min (${(machineMinutes / 60).toFixed(2)} hr) @ $${input.machineRatePerHour}/hr`,
        amount: (machineMinutes / 60) * input.machineRatePerHour,
        source: "manual_override",
        formula: `${wasteAdjustedSqft.toFixed(2)} sqft x ${input.machineMinutesPerSqft.toFixed(3)} min/sqft x ${passes} pass(es) / 60 x $${input.machineRatePerHour}/hr`,
        note: "Advanced minutes/sqft override (applied per pass).",
      });
    } else if (input.printer === "mimaki") {
      // 15F.0G.2: Mimaki UCJV300-130 = COMBINED RasterLink profile — one
      // throughput selected by the TOTAL production-layer configuration
      // (never Roland's additive formula, never inferred rates). The x1.15
      // turnaround factor applies exactly ONCE to total time. The stale
      // generic Machine-record speed is deliberately unused here.
      const totalLayers = 1 + whiteLayers + glossLayers;
      const profileRate = MIMAKI_UCJV_RASTERLINK_PROFILE.sqftPerHourByTotalLayers[totalLayers];
      if (profileRate) {
        const machineHours = (wasteAdjustedSqft / profileRate) * MIMAKI_UCJV_RASTERLINK_PROFILE.turnaroundFactor;
        const machineMinutes = machineHours * 60; // hours -> minutes: x60, never x6
        lines.push({
          key: "machine",
          label: `${totalLayers === 1 ? "CMYK" : `Combined ${totalLayers}-layer`} machine time — ${machineMinutes.toFixed(1)} min (${machineHours.toFixed(2)} hr), ${profileRate} sqft/hr`,
          amount: machineHours * input.machineRatePerHour,
          source: "owner_standard",
          formula: `${wasteAdjustedSqft.toFixed(2)} sqft / ${profileRate} sqft/hr x ${MIMAKI_UCJV_RASTERLINK_PROFILE.turnaroundFactor} turnaround = ${machineHours.toFixed(4)} hr x 60 = ${machineMinutes.toFixed(1)} min; x $${input.machineRatePerHour}/hr`,
          note: `Mimaki UCJV300-130 RasterLink profile ${MIMAKI_UCJV_RASTERLINK_PROFILE.label}: combined ${totalLayers}-layer throughput ${profileRate} sqft/hr, including the ${MIMAKI_UCJV_RASTERLINK_PROFILE.turnaroundFactor} UCJV300-130 turnaround factor (owner-verified); $${input.machineRatePerHour}/hr owner recovery standard.`,
        });
      } else {
        lines.push({ key: "machine", label: `Machine recovery — ${totalLayers}-layer Mimaki configuration`, amount: 0, source: "missing", note: "Verified Mimaki RasterLink layer profile required — this layer combination has no verified throughput (supported: 1-4 total layers)." });
      }
    } else if (machineSqftPerHour > 0) {
      // ROLAND = ADDITIVE mode-time model (unchanged): CMYK baseline + 110
      // sqft/hr per gloss layer + 75 sqft/hr per white layer.
      const cmykHours = wasteAdjustedSqft / machineSqftPerHour;
      const glossHours = (wasteAdjustedSqft / ROLAND_PRINT_MODE_SQFT_PER_HOUR.glossPerLayer) * glossLayers;
      const whiteHours = (wasteAdjustedSqft / ROLAND_PRINT_MODE_SQFT_PER_HOUR.whitePerLayer) * whiteLayers;
      const machineHours = cmykHours + glossHours + whiteHours;
      const machineMinutes = machineHours * 60; // hours -> minutes: x60, never x6
      lines.push({
        key: "machine",
        label: `Machine recovery — ${machineMinutes.toFixed(1)} min (${machineHours.toFixed(2)} hr) @ $${input.machineRatePerHour}/hr`,
        amount: machineHours * input.machineRatePerHour,
        source: "owner_standard",
        formula: `${wasteAdjustedSqft.toFixed(2)} sqft: /${machineSqftPerHour} CMYK${glossLayers > 0 ? ` + /${ROLAND_PRINT_MODE_SQFT_PER_HOUR.glossPerLayer} x ${glossLayers} gloss` : ""}${whiteLayers > 0 ? ` + /${ROLAND_PRINT_MODE_SQFT_PER_HOUR.whitePerLayer} x ${whiteLayers} white` : ""} = ${machineHours.toFixed(4)} hr x 60 = ${machineMinutes.toFixed(1)} min; x $${input.machineRatePerHour}/hr`,
        note: `Roland verified baseline ${machineSqftPerHour} sqft/hr (CMYK); Gloss/Emboss ${ROLAND_PRINT_MODE_SQFT_PER_HOUR.glossPerLayer} and White HD ${ROLAND_PRINT_MODE_SQFT_PER_HOUR.whitePerLayer} sqft/hr PER SELECTED LAYER (owner provisional; overprint 1x per layer, no hidden multiplier); $${input.machineRatePerHour}/hr owner recovery standard.`,
      });
    } else {
      lines.push({ key: "machine", label: "Machine recovery", amount: 0, source: "missing", note: "Machine production-rate standard required — set the printer speed (sqft/hr) before this job can be quoted." });
    }
    // 15F.0-E: cutting. Stickers use the selected cut type; bag/jar labels and
    // banner trim use the square/rectangle standard automatically (simple
    // shapes cut in-line). A cut type without a verified model BLOCKS.
    const autoCutFamilies: ProductFamilyKey[] = ["bags-4x5", "chiron-jars", "miron-jars", "banners"];
    const effectiveCutType = input.family === "stickers-labels" || input.family === "custom"
      ? (input.cutType || "square-rect")
      : autoCutFamilies.includes(input.family) ? "square-rect" : "none";
    if (effectiveCutType === "none") {
      lines.push({ key: "cutting", label: "Cutting — not required", amount: 0, source: "excluded", note: "No cutting selected for this job." });
    } else if (effectiveCutType === "square-rect") {
      const cutPages = Math.ceil(baseSqft / WEEDING_PAGE_SQFT);
      lines.push({
        key: "cutting",
        label: `Cutting — square/rectangle, ${cutPages} page(s)`,
        amount: CUT_SQUARE_RECT_STANDARD.costPerPage * cutPages,
        source: "owner_standard",
        formula: `ceil(${baseSqft.toFixed(2)} sqft / ${WEEDING_PAGE_SQFT} sqft per page) x $${CUT_SQUARE_RECT_STANDARD.costPerPage}/page`,
        note: CUT_SQUARE_RECT_STANDARD.basis + (input.family === "stickers-labels" || input.family === "custom" ? "" : " (label/trim cutting)."),
      });
    } else if (CUT_CONTOUR_MULTIPLIERS[effectiveCutType]) {
      // 15F.0-FINAL: contour kiss cuts quote automatically on the documented
      // page standard x the contour band multiplier (provisional, labeled).
      const band = CUT_CONTOUR_MULTIPLIERS[effectiveCutType];
      const cutPages = Math.ceil(baseSqft / WEEDING_PAGE_SQFT);
      lines.push({
        key: "cutting",
        label: `Cutting — ${band.label.split(" (")[0]}, ${cutPages} page(s)`,
        amount: CUT_SQUARE_RECT_STANDARD.costPerPage * band.multiplier * cutPages,
        source: "owner_standard",
        formula: `ceil(${baseSqft.toFixed(2)} sqft / ${WEEDING_PAGE_SQFT}) x $${CUT_SQUARE_RECT_STANDARD.costPerPage}/page x ${band.multiplier}`,
        note: `${CUT_SQUARE_RECT_STANDARD.basis}; ${band.label} — cut setup included in the art-setup standard.`,
      });
    } else {
      lines.push({ key: "cutting", label: "Cutting — die cut / irregular production", amount: 0, source: "missing", note: "Cutting standard required for this cut type — die-cut/irregular production has no safe owner model yet; provide the standard before quoting." });
    }
  }

  // ---- setup + family labor ----
  // 15C rule (owner-confirmed): outsourced DTP gets the GSO ART/design charge
  // only — the $1.00 in-house PRINT setup standard does not apply to
  // vendor-printed production and is never blindly added.
  const setupTotal = input.designs > 0
    ? input.designs * (isDtp ? OWNER_LABOR.artSetupPerDesign : OWNER_LABOR.artSetupPerDesign + OWNER_LABOR.printSetupPerDesign)
    : 0;
  if (input.designs > 0) {
    lines.push({ key: "art_setup", label: `${isDtp ? "GSO design/art charge" : "Art setup"} — ${input.designs} design(s)${isDtp ? "" : ", cut setup included"}`, amount: input.designs * OWNER_LABOR.artSetupPerDesign, source: "owner_standard", note: isDtp ? "Owner standard $8.3333/design. No in-house print setup — Spektra prints the pouches." : undefined });
    if (!isDtp) lines.push({ key: "print_setup", label: "Print setup", amount: input.designs * OWNER_LABOR.printSetupPerDesign, source: "owner_standard" });
  } else {
    lines.push({ key: "designs", label: "Number of designs", amount: 0, source: "missing", note: "Required." });
  }
  // 14C.2: application labor is charged per LABEL APPLIED (quantity x labels
  // per unit), never per jar/bag. Bag rates resolve by bag size (owner
  // standards only — unknown sizes block instead of borrowing the 4x5 rate).
  let applicationCount = 0;
  if (input.family === "bags-4x5") {
    const bagRate = bagApplicationRateFor(input.blank?.name || "");
    applicationCount = totalPieces;
    if (bagRate.rate != null) {
      lines.push({ key: "application", label: `Bag-label application — ${totalPieces} label(s) (${quantity} x ${faces}/bag; ${bagRate.basis})`, amount: bagRate.rate * totalPieces, source: "owner_standard" });
    } else {
      lines.push({ key: "application", label: `Bag-label application — ${totalPieces} label(s)`, amount: 0, source: "missing", note: `${bagRate.basis} — application labor cannot be priced.` });
    }
  }
  if (input.family === "chiron-jars" || input.family === "miron-jars") {
    applicationCount = totalPieces;
    lines.push({ key: "application", label: `Jar label application — ${totalPieces} label(s) (${quantity} jar(s) x ${faces} label(s)/jar)`, amount: OWNER_LABOR.jarApplicationPer * totalPieces, source: "owner_standard" });
  }

  // ---- automatic weeding (stickers only, when the cut requires it) ----
  let weedingPages = 0;
  let weedingBasis = "Not required for this product/cut.";
  if (input.family === "stickers-labels" && input.cutRequiresWeeding && baseSqft > 0) {
    weedingPages = Math.ceil(baseSqft / WEEDING_PAGE_SQFT);
    weedingBasis = `ESTIMATED: ceil(${baseSqft.toFixed(2)} sqft / ${WEEDING_PAGE_SQFT} sqft per 54x54 page)`;
    lines.push({ key: "weeding", label: `Weeding — ${weedingPages} page(s)`, amount: OWNER_LABOR.weedingPerPage54x54 * weedingPages, source: "estimated", note: weedingBasis });
  }
  // 15F.0-FINAL-G: ordinary banner finishing quotes automatically from the
  // documented provisional standards (perimeter-based); trimming is the
  // square/rect cutting line above. Specialty finishing stays unsupported.
  if (input.family === "banners" && (input.hemming || input.grommets)) {
    if (input.widthIn > 0 && input.heightIn > 0) {
      const perimeterFtPerBanner = (2 * (input.widthIn + input.heightIn)) / 12;
      const totalPerimeterFt = perimeterFtPerBanner * quantity;
      lines.push({ key: "finishing_setup", label: "Banner finishing setup", amount: BANNER_FINISHING_STANDARDS.finishingSetupPerJob, source: "estimated", formula: `$${BANNER_FINISHING_STANDARDS.finishingSetupPerJob} per job`, note: BANNER_FINISHING_STANDARDS.setupBasis });
      if (input.hemming) {
        lines.push({
          key: "finishing_hems",
          label: `Hems — ${totalPerimeterFt.toFixed(1)} perimeter ft`,
          amount: BANNER_FINISHING_STANDARDS.hemPerFoot * totalPerimeterFt,
          source: "estimated",
          formula: `${quantity} x 2 x (${input.widthIn} + ${input.heightIn}) in / 12 x $${BANNER_FINISHING_STANDARDS.hemPerFoot}/ft`,
          note: BANNER_FINISHING_STANDARDS.hemBasis,
        });
      }
      if (input.grommets) {
        const grommetsPerBanner = Math.ceil((2 * (input.widthIn + input.heightIn)) / BANNER_FINISHING_STANDARDS.grommetSpacingIn);
        const grommetCount = grommetsPerBanner * quantity;
        lines.push({
          key: "finishing_grommets",
          label: `Grommets — ${grommetCount} @ ${BANNER_FINISHING_STANDARDS.grommetSpacingIn}in spacing`,
          amount: BANNER_FINISHING_STANDARDS.grommetEach * grommetCount,
          source: "estimated",
          formula: `${quantity} x ceil(perimeter ${(2 * (input.widthIn + input.heightIn)).toFixed(0)}in / ${BANNER_FINISHING_STANDARDS.grommetSpacingIn}in) x $${BANNER_FINISHING_STANDARDS.grommetEach}`,
          note: BANNER_FINISHING_STANDARDS.grommetBasis,
        });
      }
    } else {
      lines.push({ key: "finishing", label: "Banner finishing", amount: 0, source: "missing", note: "Banner dimensions required before finishing can be priced." });
    }
  }

  // ---- automatic boxes/packout ----
  const packRule = input.boxOverride
    ? { unitsPerBox: input.boxOverride.unitsPerBox, label: `OVERRIDE (${input.boxOverride.reason})` }
    : unitsPerBoxFor(input.blank?.name || "");
  let boxes: number | null = null;
  let effectiveUnitsPerBox: number | null = packRule.unitsPerBox ?? null;
  let boxSource = "No units-per-box rule — packout Estimated/Missing (override in Advanced).";
  if (packRule.unitsPerBox && packRule.unitsPerBox > 0) {
    boxes = Math.ceil(quantity / packRule.unitsPerBox);
    boxSource = packRule.label || "rule";
    lines.push({ key: "packing", label: `Packing — ${boxes} box(es) @ ${packRule.unitsPerBox}/box`, amount: OWNER_LABOR.packoutPerBox * boxes, source: input.boxOverride ? "manual_override" : "owner_standard", formula: `ceil(${quantity} / ${packRule.unitsPerBox}) x $${OWNER_LABOR.packoutPerBox}/box`, note: boxSource });
  } else if (input.family === "chiron-jars" || input.family === "miron-jars") {
    // 15F.0-F: jar family default — documented Safe Care 4oz density until the
    // owner sets a per-product rule. Labeled estimated, never silently $0.
    effectiveUnitsPerBox = JAR_FAMILY_DEFAULT_UNITS_PER_BOX;
    boxes = Math.ceil(quantity / JAR_FAMILY_DEFAULT_UNITS_PER_BOX);
    boxSource = `Family default ${JAR_FAMILY_DEFAULT_UNITS_PER_BOX}/box (documented Safe Care 4oz jar density — owner confirmation pending)`;
    lines.push({ key: "packing", label: `Packing — ${boxes} box(es) @ ${JAR_FAMILY_DEFAULT_UNITS_PER_BOX}/box (family default)`, amount: OWNER_LABOR.packoutPerBox * boxes, source: "estimated", formula: `ceil(${quantity} / ${JAR_FAMILY_DEFAULT_UNITS_PER_BOX}) x $${OWNER_LABOR.packoutPerBox}/box`, note: boxSource });
  } else if (input.family === "banners") {
    // 15F.0-FINAL-H: banners ship rolled in tubes — never priced like sticker
    // boxes. ~5 banners per tube, $4/tube (provisional, labeled).
    effectiveUnitsPerBox = BANNER_TUBE_CAPACITY;
    boxes = Math.ceil(quantity / BANNER_TUBE_CAPACITY);
    boxSource = `Banner tubes — ${BANNER_TUBE_CAPACITY}/tube @ $${BANNER_TUBE_COST} (provisional standard)`;
    lines.push({ key: "packing", label: `Packing — ${boxes} shipping tube(s)`, amount: BANNER_TUBE_COST * boxes, source: "estimated", formula: `ceil(${quantity} / ${BANNER_TUBE_CAPACITY}) x $${BANNER_TUBE_COST}/tube`, note: boxSource });
  } else if (input.family !== "custom" && !isDtp) {
    // 15F.0-FINAL-H: stickers/labels and unruled bag sizes — ~5,000 units per
    // box (provisional realistic density), minimum one box, $2 owner packout.
    effectiveUnitsPerBox = STICKER_UNITS_PER_BOX_DEFAULT;
    boxes = Math.max(1, Math.ceil(quantity / STICKER_UNITS_PER_BOX_DEFAULT));
    boxSource = `${STICKER_UNITS_PER_BOX_DEFAULT.toLocaleString()}/box provisional density ($2 owner packout standard) — owner units-per-box rule editable in 15F.1`;
    lines.push({ key: "packing", label: `Packing — ${boxes} box(es)`, amount: OWNER_LABOR.packoutPerBox * boxes, source: "estimated", formula: `max(1, ceil(${quantity} / ${STICKER_UNITS_PER_BOX_DEFAULT})) x $${OWNER_LABOR.packoutPerBox}/box`, note: boxSource });
  }
  // (DTP: packing is inside the Spektra vendor cost — the vendor_setup line
  // documents it; no packing line renders, preserving the 15C "no in-house
  // lines" contract.)

  // ---- freight (single visible line; computed by the freight panel) ----
  // 15C: DTP pushes its own flat per-PO freight line above — never both.
  if (!isDtp) {
    lines.push({ key: "freight", label: "Freight/handling (separate line)", amount: input.freightPerUnit * quantity, source: input.freightSource, note: input.freightSource === "estimated" ? "ESTIMATED allowance" : undefined });
  }
  // 15F.0-G: shipping ownership — outbound CUSTOMER delivery is deliberately
  // NOT a production cost. It is excluded with its reason (never "missing"),
  // and the customer summary states it plainly. Inbound vendor freight
  // (DTP $85/PO, entered actual freight) remains a production cost above.
  lines.push({ key: "shipping_outbound", label: "Customer delivery/shipping — not included", amount: 0, source: "excluded", note: "Quoted/charged separately at shipment time (spec 15F.0-G); jobs needing delivered pricing must enter freight above." });

  const totalCost = lines.reduce((sum, line) => sum + line.amount, 0);
  const missing = lines.filter((line) => line.source === "missing").map((line) => line.label);
  // per-row DISPLAY allocation: shares of the single costed material/ink lines
  // by sqft fraction — shares sum exactly back to the line amounts, so the
  // breakdown reconstructs to total cost with nothing double-counted.
  const materialAmount = lines.find((line) => line.key === "material")?.amount || 0;
  const inkAmount = lines.filter((line) => line.key.startsWith("ink_")).reduce((sum, line) => sum + line.amount, 0);
  const labelRowsDerived: LabelRowDerived[] | null = rows
    ? rows.map((row, index) => {
        const share = baseSqft > 0 ? rowSqft[index] / baseSqft : 0;
        return {
          index, type: row.type, typeLabel: row.typeLabel, pieces: quantity,
          widthIn: row.widthIn, heightIn: row.heightIn, sqin: row.widthIn * row.heightIn,
          baseSqft: rowSqft[index], sqftShare: share,
          materialCostShare: materialAmount * share, inkCostShare: inkAmount * share,
          whiteLayers, glossLayers, applications: quantity,
        };
      })
    : null;
  return {
    lines,
    derived: {
      sqinPerPiece, totalPieces, baseSqft, wastePct, wasteSource, wasteAdjustedSqft,
      unitsPerBox: effectiveUnitsPerBox, boxes, boxSource, weedingPages, weedingBasis,
      printPasses: 1 + whiteLayers + glossLayers,
      labelRows: labelRowsDerived,
      applicationCount,
    },
    missing,
    warnings,
    totalCost,
    unitCost: totalCost / quantity,
    setupTotal,
    perUnitVariable: (totalCost - setupTotal) / quantity,
  };
}

// ---------- 14C.1B: product classification + premium-jar rules ----------
// One shared classifier — never scattered name matching. Precedence:
// (1) structured productType slugs (jar_3oz_*, jar_4oz_* = standard; jar_5oz
//     stays OUT of customer flow per AGENTS.md), (2) vendor metadata (MIRON,
//     SAFECARE=Chiron brand), (3) vendorSku codes (preset:miron-*),
// (4) documented normalized-name fallback. The seeded Miron records are
// combined "jar + lid" sets, so includesTop is detected from the record and
// a separate top is required ONLY for jar-only Miron records (prevents
// double-counting a lid already inside the verified tier price).

export type CalculatorProductClass = "bag_sticker" | "bag_dtp" | "jar_standard" | "jar_chiron" | "jar_miron" | "miron_top" | "other";

export type ClassifiableRecord = { name: string; productType?: string | null; vendor?: string | null; vendorSku?: string | null };

// 14C.2A precedence (owner-authoritative catalog rules):
//   1. Miron top/component   2. Miron jar   3. Chiron jar (EXPLICIT only)
//   4. standard jar          5. sticker bag 6. other
// Structured fields (productType, vendor, vendorSku) decide first; the
// normalized-name fallback only applies when they carry no signal.
// Owner rules (2026-07-24): 3 oz / 4 oz / 5 oz normal jars are STANDARD jars —
// vendor SAFE CARE alone does NOT mean Chiron. Chiron is only an explicit
// Chiron record (flat cost, cap included). OZ bags are NOT sticker bags.
export function classifyCalculatorProduct(record: ClassifiableRecord): { klass: CalculatorProductClass; includesTop: boolean } {
  const name = String(record.name || "");
  const type = String(record.productType || "").toLowerCase();
  const vendorNorm = String(record.vendor || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const skuNorm = String(record.vendorSku || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const text = `${type} ${name}`.toLowerCase();
  const includesTop = /\+\s*(lid|cap|top)|with\s+(lid|cap|top)|cap\s+included|lid\s+included/i.test(name) || /jar_(3|4|5)oz/.test(type);
  const isMiron = vendorNorm === "miron" || skuNorm.includes("miron") || /\bmiron\b/.test(text);
  const isChiron = vendorNorm.includes("chiron") || skuNorm.includes("chiron") || /\bchiron\b/.test(text);
  // 1. Miron top/component
  if (isMiron && /\b(lid|top|cap)\b/.test(text) && !/\bjar\b/.test(text)) return { klass: "miron_top", includesTop: false };
  // 2. Miron jar
  if (isMiron) return { klass: "jar_miron", includesTop };
  // 3. Chiron jar — EXPLICIT Chiron branding only; cap always included
  if (isChiron) return { klass: "jar_chiron", includesTop: true };
  // 15C. Spektra DTP (vendor-finished pouches). Structured fields first:
  // Spektra vendor/sku, or a dtp productType that is NOT a legacy "preset:"
  // pouch record (the old "DTP 4x5x2 Blank Pouch" preset stays out — it is a
  // blank-pouch placeholder, not a Spektra finished product).
  const isDtpRecord = vendorNorm.includes("spektra") || skuNorm.includes("spektradtp") || /\bspektra\b/.test(text)
    || (/dtp/.test(type) && !skuNorm.startsWith("preset") && !/blank\s+pouch/i.test(name));
  if (isDtpRecord && /dtp|pouch/.test(text)) return { klass: "bag_dtp", includesTop: false };
  // 4. standard jar — 3/4/5 oz normal jars (caps included per verified
  //    records); structured productType first, then name fallback
  if (/^jar_(3|4|5)oz/.test(type)) return { klass: "jar_standard", includesTop: true };
  if (/\b(3|4|5)\s?oz\b/.test(text) && /jar/.test(text)) return { klass: "jar_standard", includesTop: true };
  if (/\bjar\b/.test(text) || /\bcan\b/.test(text)) return { klass: "jar_standard", includesTop };
  // 5. sticker bag — structured productType first (dtp/stock/die bags are
  //    DIFFERENT product families; OZ bags are excluded by owner rule)
  const excludedBag = /dtp|stock|die/.test(type) || /dtp|stock|die.?cut/.test(text) || /\boz\b/.test(text);
  if (!excludedBag && /bag/.test(type)) return { klass: "bag_sticker", includesTop: false };
  if (!excludedBag && /\bbag\b/.test(text) && !/box/.test(text)) return { klass: "bag_sticker", includesTop: false };
  // 6. other
  return { klass: "other", includesTop: false };
}

// ---------- 14C.2A: Chiron flat cost + required sticker-bag sizes ----------
// Owner rule: Chiron blank cost is FLAT at every quantity (100 ml = $1.80,
// 150 ml = $1.90 on the seeded Vendor Cost Book records). Any quantity tiers
// that ever appear on a Chiron record are IGNORED so the blank cost can never
// drift by tier. Selling margins/prices still vary by tier normally.
export function enforceFlatChironCost(component: ResolvedComponent | null, klass: CalculatorProductClass | null): ResolvedComponent | null {
  if (!component || klass !== "jar_chiron" || !component.tiers.length) return component;
  return { ...component, tiers: [], note: component.note || "Chiron flat cost — quantity tiers ignored (owner rule)." };
}

// Owner-required sticker-bag size list. Sizes without an active record render
// as canonical NO PRICE options (value "type:bag-<size>") so they can be
// quoted Draft Only — a cost is never guessed. A real Vendor Cost Book record
// for the size automatically replaces the canonical entry.
export const REQUIRED_STICKER_BAG_SIZES = ["4x5", "4x6", "5x8", "6x9", "14x16"];
export function bagSizeToken(name: string): string | null {
  const match = String(name || "").match(/(\d{1,2})\s*x\s*(\d{1,2})/);
  return match ? `${Number(match[1])}x${Number(match[2])}` : null;
}

// Miron top compatibility: no structured compatibility relation exists in the
// schema, so the DOCUMENTED fallback is size-token matching — a top is
// compatible when it names the jar's size token (50ml/100ml/150ml/250ml) or
// carries no size token at all (universal top). Centralized here.
const SIZE_TOKEN_RE = /(50|100|150|250)\s?ml/i;
export function mironTopCompatible(jarName: string, topName: string): boolean {
  const jarSize = String(jarName || "").match(SIZE_TOKEN_RE)?.[1] || null;
  const topSize = String(topName || "").match(SIZE_TOKEN_RE)?.[1] || null;
  if (!topSize) return true; // universal top
  return jarSize != null && topSize === jarSize;
}

// UI family -> engine family. 14C.2 canonical UI keys: sticker-bags,
// standard-jars, premium-jars (Chiron & Miron combined), stickers-labels,
// banners, custom-item. Legacy URL/snapshot values (bags-4x5, chiron-jars,
// miron-jars, custom) stay accepted for back-compat.
export function uiFamilyToEngine(uiFamily: string, selectedClass: CalculatorProductClass | null, includesTop: boolean): ProductFamilyKey {
  if (uiFamily === "dtp-bags" || uiFamily === "dtp-pouches" || uiFamily === "dtp") return "dtp-bags"; // 15C
  if (uiFamily === "sticker-bags" || uiFamily === "bags-4x5") return "bags-4x5";
  if (uiFamily === "standard-jars") return "chiron-jars"; // cap-included jar semantics, no top selector
  if (uiFamily === "premium-jars") {
    if (selectedClass === "jar_miron") return "miron-jars"; // top selection ALWAYS required (14C.1B1 owner rule)
    return "chiron-jars";
  }
  if (uiFamily === "chiron-jars" || uiFamily === "miron-jars") return uiFamily as ProductFamilyKey; // legacy
  if (uiFamily === "custom-item") return "custom";
  return (["stickers-labels", "banners", "custom"].includes(uiFamily) ? uiFamily : "custom") as ProductFamilyKey;
}

// Canonical family value recorded on NEW snapshots (legacy inputs normalize).
// 15B: resolution is REGISTRY-driven (product-family-registry.ts owns the
// canonical keys and legacy aliases); unknown values stay custom-item.
export type CanonicalUiFamily = "sticker-bags" | "standard-jars" | "premium-jars" | "stickers-labels" | "banners" | "custom-item" | "dtp-bags";
export function canonicalUiFamily(uiFamily: string): CanonicalUiFamily {
  const entry = familyByKeyOrAlias(uiFamily);
  return (entry ? entry.key : "custom-item") as CanonicalUiFamily;
}

// Which product classes a family's blank picker accepts. Applied at BOTH the
// loader and the save action so a stale selection from a previous family can
// never survive a family switch (a Miron jar posted under Standard Jars is
// treated as no selection, not silently re-priced).
export function blankClassAllowedFor(uiFamily: string, klass: CalculatorProductClass): boolean {
  if (uiFamily === "chiron-jars") return klass === "jar_chiron"; // legacy narrow value
  if (uiFamily === "miron-jars") return klass === "jar_miron"; // legacy narrow value
  const canonical = canonicalUiFamily(uiFamily);
  if (canonical === "sticker-bags") return klass === "bag_sticker";
  if (canonical === "standard-jars") return klass === "jar_standard";
  if (canonical === "premium-jars") return klass === "jar_chiron" || klass === "jar_miron";
  if (canonical === "dtp-bags") return klass === "bag_dtp"; // 15C: ONLY Spektra DTP records
  if (canonical === "custom-item") return true;
  return false; // stickers/banners have no blank picker
}

// Researched margin family for the AUTOMATIC tier table (14C.2). Derived from
// the product selection server-side — the owner never re-enters the family.
// null = no researched curve exists (standard jars, custom items, non-4x5 bag
// sizes) -> the provisional universal curve applies with the existing
// "FAMILY MARGIN RULE NOT CONFIGURED" label. Never invents a new curve.
export function marginFamilyKeyFor(uiFamily: string, selectedClass: CalculatorProductClass | null, blankName: string): string | null {
  const canonical = canonicalUiFamily(uiFamily);
  if (canonical === "sticker-bags") return /4\s?x\s?5\b/i.test(String(blankName || "")) ? "bags-4x5" : null;
  if (canonical === "premium-jars") {
    if (selectedClass === "jar_miron") return "miron-jars";
    if (selectedClass === "jar_chiron") return "chiron-jars";
    return null;
  }
  if (canonical === "stickers-labels") return "stickers-labels";
  if (canonical === "banners") return "banners";
  if (canonical === "dtp-bags") return "dtp-pouches"; // 15C: researched DTP curve (65/58/52/46/42, min 42)
  return null;
}

export function formatComponentLabel(name: string, klass: CalculatorProductClass, includesTop: boolean, priceText: string): string {
  const suffix = klass === "jar_chiron" || (klass === "jar_standard" && includesTop) ? "cap included"
    : klass === "jar_miron" ? (includesTop ? "standard top included in vendor set" : "jar only, top required") : "";
  return [name, suffix, priceText].filter(Boolean).join(" — ");
}

// ---------- 14C.1B1: required Miron top charge (centralized) ----------
export const TOP_ENGINE_VERSION = "14C.1B1-required-miron-top";

// Every Miron sale requires an explicit top selection (owner rule — no
// exceptions, including combined "jar + lid" vendor sets). Cost behavior:
//   jar-only record        -> full selected-top cost (qty-tiered)
//   set + same standard top -> $0 incremental ("included in selected set")
//   set + different top     -> verified upgrade difference ONLY (never the
//                              full replacement cost on top of the set)
//   unverifiable difference -> MISSING blocker, never assumed $0
//   no selection            -> MISSING blocker
export function resolveMironTopLine(input: {
  quantity: number;
  selectedTop: ResolvedComponent | null;
  policy: { setIncludesStandardTop: boolean; includedStandardTopCost: number | null; selectedTopIsStandard: boolean } | null;
}): CostLine {
  const quantity = Math.max(1, Math.floor(input.quantity));
  if (!input.selectedTop) {
    return { key: "top", label: "Top type — Required (Miron)", amount: 0, source: "missing", note: "Every Miron sale requires an explicit top selection." };
  }
  const policy = input.policy;
  const resolved = blankItemUnitCostAtQty(input.selectedTop.tiers, input.selectedTop.unitCost ?? 0, quantity, input.selectedTop.name);
  const topUnit = resolved.unitCost > 0 ? resolved.unitCost : input.selectedTop.unitCost;
  if (!policy || !policy.setIncludesStandardTop) {
    // true jar-only Miron record: full top cost
    if (topUnit != null && topUnit > 0) {
      return { key: "top", label: `${input.selectedTop.name} @ $${topUnit.toFixed(4)} x ${quantity}`, amount: topUnit * quantity, source: input.selectedTop.status, note: "Full top cost (jar-only Miron record)." };
    }
    return { key: "top", label: input.selectedTop.name, amount: 0, source: "missing", note: "Selected top has no verified cost." };
  }
  if (policy.selectedTopIsStandard) {
    return { key: "top", label: `Standard top — included in selected Miron set`, amount: 0, source: "verified", note: "Set price already contains this top — charged once, $0 incremental." };
  }
  // different top on a combined set: verified upgrade difference only
  if (topUnit != null && topUnit > 0 && policy.includedStandardTopCost != null && policy.includedStandardTopCost >= 0) {
    const upgrade = Math.max(0, topUnit - policy.includedStandardTopCost);
    return { key: "top", label: `${input.selectedTop.name} — upgrade over included standard top`, amount: upgrade * quantity, source: input.selectedTop.status, note: `Upgrade difference $${upgrade.toFixed(4)}/unit (top $${topUnit.toFixed(4)} - included standard $${policy.includedStandardTopCost.toFixed(4)}); set cost charged once.` };
  }
  return { key: "top", label: `${input.selectedTop.name} — upgrade over included standard top`, amount: 0, source: "missing", note: "TOP UPGRADE COST NOT VERIFIED — DRAFT ONLY (never assumed $0)." };
}
