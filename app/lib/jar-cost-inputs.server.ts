// Patch 2A (17D.2) — jar cost INPUTS. Owner-authoritative reference data only.
//
// Pure data + lookups. No engine logic, no money arithmetic beyond simple
// per-unit division, no database, no network. The true-cost engine reads these;
// nothing else does.
//
// SCOPE NOTE: these presets are the Patch 2 owner authority for jar geometry,
// box density, freight and blank cost. They deliberately do NOT overwrite the
// existing RecipeLabelZone rows, which hold older estimated geometry and
// application seconds and are read only by admin screens — never by a cost
// path. That divergence is recorded in the Patch 2A audit and is intentional
// until the owner decides which store wins.

import {
  computeNesting,
  resolveNestingPolicy,
  type NestingItem,
  type NestingResult,
  type NestingRun,
} from "./nesting-engine.server";

export const JAR_COST_INPUTS_VERSION = "17D.2-jar-cost-inputs";

/* ------------------------------------------------------------------ *
 * Production quantity
 * ------------------------------------------------------------------ */

/** Owner rule: 1% planned overage. Blanks/material/ink price at production qty. */
export const JAR_PLANNED_OVERAGE_PCT = 1;

export function productionQtyFor(customerFinishedQty: number, overagePct = JAR_PLANNED_OVERAGE_PCT): number {
  const finished = Math.max(0, Math.floor(customerFinishedQty));
  return Math.ceil(finished * (1 + overagePct / 100));
}

/* ------------------------------------------------------------------ *
 * Label geometry (owner presets, Patch 2)
 * ------------------------------------------------------------------ */

export type JarSizeKey = "50ml" | "100ml_tall" | "100ml_wide" | "150ml" | "250ml" | "3oz" | "4oz";

export type JarLabelGeometry = {
  /** Side wrap, rectangular. */
  side: { widthIn: number; heightIn: number };
  /** Lid, CIRCULAR — diameter. Ink uses circle area; nesting uses the bounding box. */
  lid: { diameterIn: number };
  /** Optional tamper band, rectangular. */
  tamper: { widthIn: number; heightIn: number };
};

export const JAR_LABEL_GEOMETRY: Record<JarSizeKey, JarLabelGeometry> = {
  "50ml": { side: { widthIn: 5.6, heightIn: 1.5 }, lid: { diameterIn: 1.6 }, tamper: { widthIn: 5.6, heightIn: 0.5 } },
  "100ml_tall": { side: { widthIn: 6.3, heightIn: 3.15 }, lid: { diameterIn: 1.75 }, tamper: { widthIn: 6.3, heightIn: 0.5 } },
  "100ml_wide": { side: { widthIn: 6.6, heightIn: 2.6 }, lid: { diameterIn: 1.9 }, tamper: { widthIn: 6.6, heightIn: 0.5 } },
  "150ml": { side: { widthIn: 7.125, heightIn: 3.125 }, lid: { diameterIn: 2.0 }, tamper: { widthIn: 7.125, heightIn: 0.6 } },
  "250ml": { side: { widthIn: 9.4, heightIn: 2.9 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 9.4, heightIn: 0.6 } },
  "3oz": { side: { widthIn: 6.9, heightIn: 1.4 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 6.9, heightIn: 0.5 } },
  "4oz": { side: { widthIn: 7.125, heightIn: 1.4 }, lid: { diameterIn: 2.1 }, tamper: { widthIn: 7.125, heightIn: 0.5 } },
};

export type JarLabelSelection = { side: boolean; lid: boolean; tamper: boolean };

/**
 * INKABLE ARTWORK area per set — the circular lid uses its ACTUAL circle area.
 * This is the denominator every ink calibration is measured against.
 */
export function inkableArtworkSqInPerSet(size: JarSizeKey, selection: JarLabelSelection): number {
  const g = JAR_LABEL_GEOMETRY[size];
  let sqin = 0;
  if (selection.side) sqin += g.side.widthIn * g.side.heightIn;
  if (selection.lid) sqin += Math.PI * Math.pow(g.lid.diameterIn / 2, 2);
  if (selection.tamper) sqin += g.tamper.widthIn * g.tamper.heightIn;
  return sqin;
}

/**
 * MATERIAL FOOTPRINT area per set — bounding-box geometry, because a circular
 * lid is cut from a square of media. This is deliberately LARGER than the
 * inkable area and must never be substituted for it.
 */
export function materialFootprintSqInPerSet(size: JarSizeKey, selection: JarLabelSelection): number {
  const g = JAR_LABEL_GEOMETRY[size];
  let sqin = 0;
  if (selection.side) sqin += g.side.widthIn * g.side.heightIn;
  if (selection.lid) sqin += g.lid.diameterIn * g.lid.diameterIn;
  if (selection.tamper) sqin += g.tamper.widthIn * g.tamper.heightIn;
  return sqin;
}

/* ------------------------------------------------------------------ *
 * Application labor (owner standard $20/hr)
 * ------------------------------------------------------------------ */

export const APPLICATION_LABOR_RATE_PER_HOUR = 20;
export const JAR_APPLICATION_SECONDS = { side: 45, lid: 22, tamper: 45 } as const;

/**
 * Applies to CUSTOMER FINISHED QTY only — never to the overage quantity.
 * Side+Lid = 67 s = $0.372222/jar at $20/hr.
 */
export function applicationCostPerJar(selection: JarLabelSelection): number {
  let seconds = 0;
  if (selection.side) seconds += JAR_APPLICATION_SECONDS.side;
  if (selection.lid) seconds += JAR_APPLICATION_SECONDS.lid;
  if (selection.tamper) seconds += JAR_APPLICATION_SECONDS.tamper;
  return (seconds / 3600) * APPLICATION_LABOR_RATE_PER_HOUR;
}

/* ------------------------------------------------------------------ *
 * Setup (owner standard)
 * ------------------------------------------------------------------ */

/** Side + Lid together are ONE design: $25/hr at 2 designs/hr. */
export const JAR_ART_SETUP_BASE = 12.5;
/** Tamper is a SECOND design at +$10 art, and adds NO extra print setup. */
export const JAR_ART_SETUP_TAMPER_ADD = 10.0;
/** $25/hr at 12.5 jobs/hr — once per job, not per design. */
export const JAR_PRINT_SETUP_PER_JOB = 2.0;

export function jarSetupCost(selection: JarLabelSelection): { art: number; print: number; total: number; designs: number } {
  const art = JAR_ART_SETUP_BASE + (selection.tamper ? JAR_ART_SETUP_TAMPER_ADD : 0);
  const designs = selection.tamper ? 2 : 1;
  return { art, print: JAR_PRINT_SETUP_PER_JOB, total: art + JAR_PRINT_SETUP_PER_JOB, designs };
}

/* ------------------------------------------------------------------ *
 * Packout
 * ------------------------------------------------------------------ */

export const PACKOUT_LABOR_PER_BOX = 2.0; // $20/hr at 10 boxes/hr
export const PACKOUT_CONSUMABLES_PER_BOX = 1.5;
export const PACKOUT_TOTAL_PER_BOX = PACKOUT_LABOR_PER_BOX + PACKOUT_CONSUMABLES_PER_BOX; // $3.50

/** Finished units per box, by size. Boxes are counted on FINISHED qty. */
export const JAR_UNITS_PER_BOX: Record<JarSizeKey, number> = {
  "50ml": 100,
  "100ml_tall": 100,
  "100ml_wide": 100,
  "150ml": 50,
  "250ml": 25,
  "3oz": 150,
  "4oz": 100,
};

export function packoutFor(size: JarSizeKey, customerFinishedQty: number): { boxes: number; unitsPerBox: number; cost: number } {
  const unitsPerBox = JAR_UNITS_PER_BOX[size];
  const boxes = Math.ceil(Math.max(0, customerFinishedQty) / unitsPerBox);
  return { boxes, unitsPerBox, cost: boxes * PACKOUT_TOTAL_PER_BOX };
}

/* ------------------------------------------------------------------ *
 * Inbound freight
 * ------------------------------------------------------------------ */

export type FreightBasis =
  | "PROVISIONAL_INVOICE_DERIVED"
  | "PROVISIONAL_SUPPLIER_PALLET"
  | "MISSING_FREIGHT_BASIS";

export type JarFreight = {
  perUnit: number | null;
  basis: FreightBasis;
  /** True when the whole job result must be reported PROVISIONAL. */
  provisional: boolean;
  source: string;
};

/** Genuine Miron: verified supplier pallet capacities against a provisional $315/pallet. */
export const MIRON_PALLET_FREIGHT = 315;
export const MIRON_PALLET_CAPACITY: Partial<Record<JarSizeKey, number>> = {
  "50ml": 5376,
  "100ml_tall": 3360,
  "100ml_wide": 3080,
  "150ml": 2400,
  "250ml": 1760,
};

/**
 * Chiron / standard families — freight per unit derived from Safe Care invoices
 * plus physical carton measurement (owner amendment, Patch 2A).
 *
 * These are PROVISIONAL_INVOICE_DERIVED allowances, NOT supplier-confirmed
 * carrier tariffs. A numeric true cost may be produced, but the job result must
 * carry PROVISIONAL status until a stronger basis replaces them. The supporting
 * invoices (#16651, #16731, #16636) are MIXED shipments and must never be
 * represented as standalone jar freight invoices.
 *
 * Derived pallet planning basis (48x40 pallet, 60in loaded-height standard) is
 * DERIVED_STANDARD_PALLET, not supplier-confirmed:
 *   100ml tall/wide 3600 | 150ml 3600 | 3oz 5400 | 4oz 3600 jars/pallet
 */
export const INVOICE_DERIVED_FREIGHT_PER_UNIT: Partial<Record<JarSizeKey, number>> = {
  "100ml_tall": 0.139,
  "100ml_wide": 0.139,
  "150ml": 0.16,
  "3oz": 0.089,
  "4oz": 0.129,
};

export const DERIVED_STANDARD_PALLET_CAPACITY: Partial<Record<JarSizeKey, number>> = {
  "100ml_tall": 3600,
  "100ml_wide": 3600,
  "150ml": 3600,
  "3oz": 5400,
  "4oz": 3600,
};

export type JarBrand = "miron" | "chiron" | "standard";

/**
 * Freight per unit for a jar family. Applied to PRODUCTION quantity by the
 * engine — never charged twice through a separate overage line.
 */
export function jarFreightPerUnit(brand: JarBrand, size: JarSizeKey): JarFreight {
  if (brand === "miron") {
    const capacity = MIRON_PALLET_CAPACITY[size];
    if (!capacity) {
      return { perUnit: null, basis: "MISSING_FREIGHT_BASIS", provisional: true, source: `No verified Miron pallet capacity for ${size}.` };
    }
    return {
      perUnit: MIRON_PALLET_FREIGHT / capacity,
      basis: "PROVISIONAL_SUPPLIER_PALLET",
      provisional: true,
      source: `Provisional $${MIRON_PALLET_FREIGHT}/pallet over verified supplier capacity ${capacity} jars.`,
    };
  }

  const perUnit = INVOICE_DERIVED_FREIGHT_PER_UNIT[size];
  if (perUnit == null) {
    return {
      perUnit: null,
      basis: "MISSING_FREIGHT_BASIS",
      provisional: true,
      source: `No invoice-derived freight allowance for ${brand} ${size}.`,
    };
  }
  return {
    perUnit,
    basis: "PROVISIONAL_INVOICE_DERIVED",
    provisional: true,
    source: `Safe Care invoice + physical carton derived allowance ($${perUnit}/jar). Mixed-shipment invoices #16651/#16731/#16636; derived 48x40 / 60in pallet planning basis ${DERIVED_STANDARD_PALLET_CAPACITY[size] ?? "n/a"} jars. PROVISIONAL — not a supplier-confirmed tariff.`,
  };
}

/* ------------------------------------------------------------------ *
 * Blank (complete jar + lid set) cost
 * ------------------------------------------------------------------ */

export const MIRON_TIER_MIN_QTYS = [1, 250, 500, 1000, 2500];

/** Complete-set cost ladders, indexed to MIRON_TIER_MIN_QTYS. */
export const MIRON_SET_COST: Partial<Record<JarSizeKey, number[]>> = {
  "50ml": [2.46, 2.24, 2.03, 1.89, 1.74],
  "100ml_tall": [2.78, 2.54, 2.31, 2.14, 1.99],
  "100ml_wide": [2.9, 2.67, 2.44, 2.26, 2.1],
  "150ml": [3.26, 3.0, 2.76, 2.54, 2.37],
  "250ml": [3.92, 3.6, 3.32, 3.11, 2.92],
};

/** Chiron verified complete-set cost — FLAT at every quantity (owner rule). */
export const CHIRON_SET_COST: Partial<Record<JarSizeKey, number>> = {
  "100ml_tall": 1.8,
  "100ml_wide": 1.8,
  "150ml": 1.9,
  // 50ml deliberately absent — UNVERIFIED, must resolve MISSING_COST.
};

export type StandardJarVariant = "clear" | "black_white";

export const STANDARD_SET_COST: Partial<Record<JarSizeKey, Record<StandardJarVariant, number>>> = {
  "3oz": { clear: 0.5, black_white: 0.62 },
  "4oz": { clear: 0.6, black_white: 0.65 },
};

export type BlankCostResolution =
  | { ok: true; unitCost: number; tierMinQty: number | null; source: string }
  | { ok: false; reason: "MISSING_COST"; message: string };

/**
 * Complete-set blank cost. Never $0, never a fallback SKU, never inferred.
 * Miron uses the highest REACHED quantity tier; Chiron is flat by owner rule.
 */
export function resolveJarBlankCost(input: {
  brand: JarBrand;
  size: JarSizeKey;
  quantity: number;
  variant?: StandardJarVariant;
}): BlankCostResolution {
  const { brand, size, quantity } = input;

  if (brand === "miron") {
    const ladder = MIRON_SET_COST[size];
    if (!ladder) return { ok: false, reason: "MISSING_COST", message: `No verified Miron complete-set cost for ${size}.` };
    let index = 0;
    for (let i = 0; i < MIRON_TIER_MIN_QTYS.length; i += 1) if (quantity >= MIRON_TIER_MIN_QTYS[i]) index = i;
    return { ok: true, unitCost: ladder[index], tierMinQty: MIRON_TIER_MIN_QTYS[index], source: `Miron verified complete-set tier ${MIRON_TIER_MIN_QTYS[index]}+.` };
  }

  if (brand === "chiron") {
    const flat = CHIRON_SET_COST[size];
    if (flat == null) {
      return { ok: false, reason: "MISSING_COST", message: `Chiron ${size} has no verified complete-set cost — DRAFT ONLY. A blank cost must never be inferred.` };
    }
    return { ok: true, unitCost: flat, tierMinQty: null, source: "Chiron verified complete-set cost — flat at every quantity (owner rule)." };
  }

  const variants = STANDARD_SET_COST[size];
  if (!variants) return { ok: false, reason: "MISSING_COST", message: `No verified standard-jar complete-set cost for ${size}.` };
  const variant = input.variant ?? "clear";
  const unitCost = variants[variant];
  if (unitCost == null) return { ok: false, reason: "MISSING_COST", message: `No verified standard-jar cost for ${size} ${variant}.` };
  return { ok: true, unitCost, tierMinQty: null, source: `Standard jar verified complete-set cost (${variant}).` };
}

/* ------------------------------------------------------------------ *
 * Physical print runs + nesting (Patch 2B)
 *
 * SETUP GROUPING AND PHYSICAL-RUN GROUPING ARE DIFFERENT CONCEPTS.
 *
 *   setup grouping   side + lid = ONE artwork/design ($12.50 art, $2.00 print).
 *                    An optional tamper is a SECOND design (+$10 art, no extra
 *                    print setup). Unchanged by Patch 2B — see jarSetupCost().
 *
 *   physical runs    RUN 1 = side (+ optional tamper). RUN 2 = lid.
 *                    Lid labels are a SEPARATE physical print run.
 *
 * Two physical runs do NOT create a second print-setup charge.
 * ------------------------------------------------------------------ */

export type JarPhysicalRunKey = "side-body-run" | "lid-run";

/** Poseidon matte / gloss stock roll. Overrideable per job. */
export const JAR_DEFAULT_MEDIA_WIDTH_IN = 54;

/**
 * Builds the physical runs for one jar job. Empty runs are omitted, so a
 * lid-only job produces exactly one run.
 */
export function jarPhysicalRuns(size: JarSizeKey, selection: JarLabelSelection, productionQty: number): NestingRun[] {
  const g = JAR_LABEL_GEOMETRY[size];
  const qty = Math.max(0, Math.floor(productionQty));
  const runs: NestingRun[] = [];

  const bodyItems: NestingItem[] = [];
  if (selection.side) {
    bodyItems.push({
      key: `${size}-side`, groupKey: "side", shapeType: "rect",
      widthIn: g.side.widthIn, heightIn: g.side.heightIn, quantity: qty, allowRotate: true,
    });
  }
  if (selection.tamper) {
    bodyItems.push({
      key: `${size}-tamper`, groupKey: "tamper", shapeType: "rect",
      widthIn: g.tamper.widthIn, heightIn: g.tamper.heightIn, quantity: qty, allowRotate: true,
    });
  }
  if (bodyItems.length) {
    runs.push({ key: "side-body-run" satisfies JarPhysicalRunKey, label: "Run 1 — side body (+ tamper)", items: bodyItems });
  }

  if (selection.lid) {
    const d = g.lid.diameterIn;
    runs.push({
      key: "lid-run" satisfies JarPhysicalRunKey,
      label: "Run 2 — lid",
      items: [{
        key: `${size}-lid`, groupKey: "lid", shapeType: "circle_bbox",
        // PHYSICAL PLACEMENT uses the diameter bounding box...
        widthIn: d, heightIn: d, quantity: qty, allowRotate: true,
        // ...while the real printed shape stays the circle, for honest utilisation.
        shapeAreaSqIn: Math.PI * Math.pow(d / 2, 2),
      }],
    });
  }

  return runs;
}

export type JarNestingInput = {
  size: JarSizeKey;
  selection: JarLabelSelection;
  productionQty: number;
  machineKey: string;
  loadedMediaWidthIn?: number;
  /** Actual captured RIP Print Area_X for a historical job. Beats the default. */
  actualSweptWidthIn?: number | null;
};

export type JarNestingAreas = {
  inkableArtworkSqft: number;
  ripLayoutSqft: number | null;
  materialFootprintSqft: number;
  ripLayoutBasis: string;
};

/**
 * The three areas for one jar job, with ripLayoutSqft and materialFootprintSqft
 * SUMMED ACROSS PHYSICAL RUNS. Feeds are never combined across runs.
 *
 * inkableArtworkSqft stays real printed shape geometry (circular lid = pi*r^2)
 * and is NOT taken from the nesting bounding boxes.
 *
 * A blocked nest returns ripLayoutSqft: null, which makes the true-cost engine
 * raise MISSING_NESTING_MODEL and return DRAFT_ONLY with a null unit cost —
 * never a guessed width and never a silent number.
 */
export function jarNestingAreas(input: JarNestingInput): { areas: JarNestingAreas; nesting: NestingResult | null; blockers: string[] } {
  const inkableArtworkSqft = (inkableArtworkSqInPerSet(input.size, input.selection) * input.productionQty) / 144;
  const resolved = resolveNestingPolicy({
    machineKey: input.machineKey,
    loadedMediaWidthIn: input.loadedMediaWidthIn ?? JAR_DEFAULT_MEDIA_WIDTH_IN,
    actualSweptWidthIn: input.actualSweptWidthIn ?? null,
  });

  if (!resolved.ok) {
    return {
      areas: { inkableArtworkSqft, ripLayoutSqft: null, materialFootprintSqft: 0, ripLayoutBasis: `Nesting blocked: ${resolved.message}` },
      nesting: null,
      blockers: [`${resolved.blocker}: ${resolved.message}`],
    };
  }

  const nesting = computeNesting(jarPhysicalRuns(input.size, input.selection, input.productionQty), resolved.policy);
  return {
    areas: {
      inkableArtworkSqft,
      ripLayoutSqft: nesting.ripLayoutSqft,
      materialFootprintSqft: nesting.materialFootprintSqft,
      ripLayoutBasis: nesting.ripLayoutBasis,
    },
    nesting,
    blockers: nesting.blockers,
  };
}
