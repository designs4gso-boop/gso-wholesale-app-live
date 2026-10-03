// Patch 2A (17D.2) — jar cost INPUTS. Owner-authoritative reference data only.
//
// Pure data + lookups. No engine logic, no money arithmetic beyond simple
// per-unit division, no database, no network. The true-cost engine reads these;
// nothing else does.
//
// SCOPE NOTE: these presets are the Patch 2 owner authority for jar geometry,
// box density, freight and blank cost. They deliberately do NOT overwrite the
// existing RecipeLabelZone rows, which hold older estimated GEOMETRY read only
// by admin screens — never by a cost path.
//
// 2D-4D2 RESOLVED THE OTHER HALF OF THAT DIVERGENCE. The Patch 2A note said
// the split over APPLICATION SECONDS was "intentional until the owner decides
// which store wins". The owner has decided: the per-size RecipeLabelZone
// timings win, and this module now carries them (see
// JAR_APPLICATION_SECONDS_BY_SIZE). Setup rates moved onto the owner-verified
// global standards at the same time. GEOMETRY is unchanged and still belongs
// to this module.

import {
  computeNesting,
  resolveNestingPolicy,
  type NestingItem,
  type NestingResult,
  type NestingRun,
} from "./nesting-engine.server";
import { computeFinishing, type CutGeometryMap, type CutMode } from "./finishing-cost.server";
import { type CostBasis } from "./true-cost-engine.server";
import { deriveGsoLabelCutDiameter, deriveGsoLabelCutlineFromArtboard } from "./gso-cutline";
import { OWNER_STANDARDS } from "./owner-standards";

export const JAR_COST_INPUTS_VERSION = "17D.2-jar-cost-inputs";

/* ------------------------------------------------------------------ *
 * Production quantity
 * ------------------------------------------------------------------ */

/**
 * Planned jar overage — 1%. OWNER-VERIFIED (2D-4D3, 2026-08-25).
 *
 * 500 finished jars are produced as 505. The percentage is deliberate and the
 * owner has confirmed it, so it now reads from the decision authority
 * (OWNER_STANDARDS.jarPlannedOveragePct) rather than being a number this file
 * asserts about itself.
 *
 * HISTORY, because how this got verified matters: the value entered the repo
 * in commit 5246607 (Patch 2A / 17D.2, 2026-08-19) already labelled "owner
 * rule", with no OWNER_STANDARDS entry, no dated decision, no supplier
 * pack-quantity basis and no waste study behind it. The 2D-4D2 audit refused
 * to accept a self-asserted label as verification and disclosed it on every
 * jar quote instead of quietly trusting it. The owner then confirmed the 1%.
 * The number never changed; its PROVENANCE did.
 *
 * What it does: raises PRODUCTION quantity, so the inputs that genuinely scale
 * with produced units — blank complete sets, print media, ink, and the inbound
 * freight allocated to those sets — price at the higher number. It is applied
 * ONCE and never compounded. The planned_overage line is $0 so nothing is
 * double-counted, and packout still counts FINISHED jars.
 */
export const JAR_PLANNED_OVERAGE_PCT = OWNER_STANDARDS.jarPlannedOveragePct.value;

/** Machine-readable provenance — now a verified decision, not an assumption. */
export const JAR_PLANNED_OVERAGE_PROVENANCE = {
  pct: OWNER_STANDARDS.jarPlannedOveragePct.value,
  status: "OWNER_VERIFIED",
  ownerRecord: "OWNER_STANDARDS.jarPlannedOveragePct",
  confirmedOn: "2026-08-25 (2D-4D3)",
  supersedes: "Self-asserted comment in 5246607 (Patch 2A / 17D.2) with no owner record — audited and disclosed by 2D-4D2 until this confirmation.",
  note: "Applies to produced-quantity inputs only. Never compounded, never a separate charge; packout stays on finished quantity.",
} as const;

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
 *
 * 2D-4D2 RECONCILIATION. This module previously carried a FLAT
 * side 45s / lid 22s / tamper 45s. Those three numbers entered the repo in
 * one commit (5246607, Patch 2A / 17D.2, 2026-08-19) with no rate derivation,
 * no measurement and no owner citation — and this module's own header listed
 * the Patch 2 owner authority as "geometry, box density, freight and blank
 * cost", which does NOT include application seconds. The same header recorded
 * that the divergence from the RecipeLabelZone rows was "intentional until the
 * owner decides which store wins".
 *
 * The owner has now decided. The authority is the per-size timing the owner
 * supplied and which is LIVE in production RecipeLabelZone rows, seeded by
 * tools/seed-jar-label-zone-dimensions.mjs and noted there as "confirmed by
 * GSO jar label size list":
 *
 *   size          side  lid  lid-side band
 *   50ml           12    10   12
 *   100ml tall     12    10   12
 *   100ml wide     12    10   12
 *   150ml          13    10   12
 *   250ml          15    10   12
 *   3oz            10     8   (no lid-side zone exists)
 *   4oz            10     8   (no lid-side zone exists)
 *
 * NAMING: this module calls the third label "tamper". The owner data calls it
 * "Lid side label". They are the SAME optional band — both are a full jar
 * circumference wide, both 0.5-0.6in tall, both optional. The geometry table
 * below and the live zone rows agree size for size, which is why the timings
 * transfer.
 *
 * BRAND: the timings are keyed by SIZE, not brand. The live zone rows exist on
 * the Miron and plain-oz recipes; a Chiron 150ml is the same physical jar size
 * to apply a label to, so it takes the same 150ml timing.
 *
 * FAILS CLOSED: 3oz and 4oz have no owner lid-side timing, so asking for that
 * band on one of them BLOCKS. It is not filled in from another size.
 * ------------------------------------------------------------------ */

export const APPLICATION_LABOR_RATE_PER_HOUR = 20;

export type JarApplicationSeconds = { side: number; lid: number; tamper: number | null };

/**
 * Owner application seconds per label, by jar size.
 *
 * tamper: null means the owner recorded NO band for that jar — a missing
 * standard, never a zero and never a borrowed number.
 */
export const JAR_APPLICATION_SECONDS_BY_SIZE: Record<JarSizeKey, JarApplicationSeconds> = {
  "50ml": { side: 12, lid: 10, tamper: 12 },
  "100ml_tall": { side: 12, lid: 10, tamper: 12 },
  "100ml_wide": { side: 12, lid: 10, tamper: 12 },
  "150ml": { side: 13, lid: 10, tamper: 12 },
  "250ml": { side: 15, lid: 10, tamper: 12 },
  "3oz": { side: 10, lid: 8, tamper: null },
  "4oz": { side: 10, lid: 8, tamper: null },
};

/** Where each number came from, so a quote can show it without guessing. */
export const JAR_APPLICATION_SOURCE =
  "Owner per-size application timings, live in RecipeLabelZone (seed-jar-label-zone-dimensions.mjs, \"confirmed by GSO jar label size list\"). Applied at $20/hr.";

export type JarApplicationResolution =
  | { ok: true; secondsPerJar: number; costPerFinishedUnit: number; detail: string }
  | { ok: false; reason: "MISSING_APPLICATION_STANDARD"; message: string };

/**
 * Application labor for ONE finished jar.
 *
 * Applies to CUSTOMER FINISHED QTY only — never to the overage quantity — and
 * charges once per label actually applied.
 */
export function resolveJarApplication(size: JarSizeKey, selection: JarLabelSelection): JarApplicationResolution {
  const owner = JAR_APPLICATION_SECONDS_BY_SIZE[size];
  if (!owner) {
    return {
      ok: false,
      reason: "MISSING_APPLICATION_STANDARD",
      message: `No owner application timing exists for a ${size} jar.`,
    };
  }

  const parts: string[] = [];
  let seconds = 0;
  if (selection.side) { seconds += owner.side; parts.push(`side ${owner.side}s`); }
  if (selection.lid) { seconds += owner.lid; parts.push(`lid ${owner.lid}s`); }
  if (selection.tamper) {
    if (owner.tamper == null) {
      return {
        ok: false,
        reason: "MISSING_APPLICATION_STANDARD",
        message: `The owner recorded no lid-side/tamper band timing for a ${size} jar, so its application labor cannot be costed. Another size's timing is not a substitute.`,
      };
    }
    seconds += owner.tamper;
    parts.push(`tamper/lid-side ${owner.tamper}s`);
  }

  return {
    ok: true,
    secondsPerJar: seconds,
    costPerFinishedUnit: (seconds / 3600) * APPLICATION_LABOR_RATE_PER_HOUR,
    detail: `${parts.join(" + ") || "no labels"} = ${seconds}s per jar at ${APPLICATION_LABOR_RATE_PER_HOUR}/hr. ${JAR_APPLICATION_SOURCE}`,
  };
}

/* ------------------------------------------------------------------ *
 * Setup (owner standard)
 * ------------------------------------------------------------------ */

/* 2D-4D2 RECONCILIATION.
 *
 * This module previously carried art $12.50 ("$25/hr at 2 designs/hr"),
 * a flat +$10.00 for a tamper design (no rate at all), and print $2.00
 * ("$25/hr at 12.5 jobs/hr"). All three arrived in the same unsourced Patch 2A
 * commit as the application seconds above, and every other appearance of them
 * in the repo — GSO_TRUE_COST_CONTRACT.md, GSO_NESTING_CONTRACT.md,
 * nesting-engine.server.ts — merely restates this file. No owner-approved
 * jar-specific setup RATE exists anywhere: the rates 2 designs/hr and
 * 12.5 jobs/hr appear nowhere else and carry no owner record.
 *
 * The owner-verified global setup standards DO exist, dated and stamped:
 *   OWNER_STANDARDS.artSetupPerDesign   = $25/hr / 3 designs/hr = $8.333333
 *   OWNER_STANDARDS.printSetupPerDesign = $25/hr / 25 jobs/hr   = $1.000000
 *
 * So jars now use the OWNER RATES with the JAR BASIS. The basis is what is
 * genuinely jar-specific and it is unchanged:
 *   art   PER_DESIGN — side+lid is ONE design; a tamper band is a SECOND.
 *   print PER_JOB    — charged once per job. A tamper design adds no second
 *                      print setup, and the two physical runs (side/body and
 *                      lid) do not either.
 */

/** One art setup event at the owner rate. Side+lid together are ONE design. */
export const JAR_ART_SETUP_PER_DESIGN = OWNER_STANDARDS.artSetupPerDesign.value;
/** One print setup event at the owner rate, charged once per JOB. */
export const JAR_PRINT_SETUP_PER_JOB = OWNER_STANDARDS.printSetupPerDesign.value;

/**
 * Superseded 2D-4D2. Kept only so the old figures stay findable and a silent
 * revert is obvious; nothing reads them.
 */
export const JAR_SETUP_RETIRED_ASSUMPTIONS = {
  artBaseDollars: 12.5,
  artTamperAddDollars: 10.0,
  printPerJobDollars: 2.0,
  note: "Patch 2A (17D.2) figures. No owner-approved jar-specific setup rate was ever recorded for them.",
} as const;

export function jarSetupCost(selection: JarLabelSelection): {
  art: number; print: number; total: number; designs: number;
  artBasis: CostBasis; printBasis: CostBasis;
} {
  // A tamper/lid-side band is a SECOND distinct artwork, so it is a second art
  // setup EVENT at the owner rate — not a flat surcharge.
  const designs = selection.tamper ? 2 : 1;
  const art = JAR_ART_SETUP_PER_DESIGN * designs;
  return {
    art,
    print: JAR_PRINT_SETUP_PER_JOB,
    total: art + JAR_PRINT_SETUP_PER_JOB,
    designs,
    artBasis: "PER_DESIGN",
    printBasis: "PER_JOB",
  };
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

/**
 * Chiron verified complete-set cost — FLAT at every quantity (owner rule).
 *
 * 100ml wide ($1.80) and 150ml ($1.90) are the two sizes the 14C.2A owner
 * record (2026-07-24) covered.
 *
 * 100ml tall ($1.80) is OWNER-VERIFIED 2026-08-25 (2D-4D3). It needed its own
 * confirmation rather than inheriting from 100ml wide: the size was added to
 * the active scope on 2026-08-24, after the 14C.2A record was written, and the
 * 2D-4D2 audit flagged that its price had arrived in the unsourced Patch 2A
 * commit alongside figures that turned out to be wrong. Same value, real
 * provenance — and it is a different jar, so matching 100ml wide is now the
 * owner's answer rather than a coincidence nobody checked.
 *
 * This table is the canonical blank authority for Chiron. VendorProduct rows
 * carry their own price for the legacy panel and the Vendor Cost Book; the
 * canonical cost path never reads them.
 */
export const CHIRON_SET_COST: Partial<Record<JarSizeKey, number>> = {
  "100ml_tall": 1.8,
  "100ml_wide": 1.8,
  "150ml": 1.9,
  // 50ml deliberately absent — UNVERIFIED, must resolve MISSING_COST.
};

/** Per-size provenance for the Chiron flat costs. */
export const CHIRON_SET_COST_PROVENANCE: Partial<Record<JarSizeKey, { status: "OWNER_VERIFIED"; record: string }>> = {
  "100ml_wide": { status: "OWNER_VERIFIED", record: "14C.2A owner record, 2026-07-24" },
  "150ml": { status: "OWNER_VERIFIED", record: "14C.2A owner record, 2026-07-24" },
  "100ml_tall": { status: "OWNER_VERIFIED", record: "Owner confirmation, 2026-08-25 (2D-4D3)" },
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
    const provenance = CHIRON_SET_COST_PROVENANCE[size];
    return {
      ok: true,
      unitCost: flat,
      tierMinQty: null,
      source: `Chiron verified complete-set cost — flat at every quantity (owner rule)${provenance ? `; ${provenance.record}` : ""}.`,
    };
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
 *   setup grouping   side + lid = ONE artwork/design (one art setup event,
 *                    one print setup event). An optional tamper is a SECOND
 *                    design (a second art event, no extra print setup).
 *                    See jarSetupCost() for the rates.
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

/* ------------------------------------------------------------------ *
 * Finishing - cutting + weeding (Patch 2C-3A)
 *
 * GSO labels are cut INDIVIDUALLY - adjacent labels do not share a physical
 * cut line - so jar side and tamper labels use SEPARATED_RECTANGLE
 * (qty x perimeter), never a shared grid.
 *
 * NO OWNER CUTLINE EXISTS FOR JARS YET. The 4x5 bag benchmark proved artboard
 * (4.00 x 5.00) and cutline (3.875 x 4.875) differ materially, so jar bands fall
 * back to the ARTBOARD geometry and are flagged CUT_PATH_ESTIMATE_REQUIRED.
 * A cutline is always smaller than its artboard, so this OVERSTATES jar
 * cutting until the owner supplies real jar cutlines.
 *
 * LIDS are circles -> CONTOUR at qty x pi x diameter. Exact length, but no
 * controlled contour benchmark exists, so the rate is borrowed and the job
 * stays PROVISIONAL.
 * ------------------------------------------------------------------ */

/** CMYK-only jar work routes to the Mimaki; White/Gloss would route to Roland. */
export const JAR_DEFAULT_CUT_MACHINE_KEY = "mimaki-ucjv300-130";
export const JAR_DEFAULT_CUT_MODE: CutMode = "normal";

/**
 * Cut geometry per nesting band. Side and tamper are separated rectangles with
 * NO owner cutline yet; the lid is a contour on its real diameter.
 */
/**
 * Cut geometry for one jar size.
 *
 * 2D-4D C1 — DERIVED FROM THE GSO RULE, not the artboard.
 *
 * Jar labels are cut like every other GSO label: the cutline is the artwork
 * outline with a -0.0625in inward offset. Until now no jar cutline existed, so
 * the artboard "stood in and overstated" the path and every jar blocked on
 * CUTLINE_GEOMETRY_REQUIRED. That blocker was never about jars being special —
 * it was about nobody having applied the rule to them.
 *
 * Side and tamper are rectangles; the lid is a circle, so its DIAMETER takes
 * the same 0.125in total reduction (one offset each side).
 *
 * Still fails closed: a profile whose artwork is too small to offset yields no
 * cutline for that component, and computeFinishing blocks rather than guessing.
 */
export function jarCutGeometry(size: JarSizeKey): CutGeometryMap {
  const g = JAR_LABEL_GEOMETRY[size];
  const side = deriveGsoLabelCutlineFromArtboard(g.side.widthIn, g.side.heightIn);
  const tamper = deriveGsoLabelCutlineFromArtboard(g.tamper.widthIn, g.tamper.heightIn);
  const lidCutDiameter = deriveGsoLabelCutDiameter(g.lid.diameterIn);

  return {
    side: side
      ? {
          model: "separated_rectangle",
          cutWidthIn: side.cutWidthIn,
          cutHeightIn: side.cutHeightIn,
          note: `Individually cut. Cutline ${side.cutWidthIn.toFixed(3)} x ${side.cutHeightIn.toFixed(3)}in, derived from the ${g.side.widthIn} x ${g.side.heightIn}in artboard by the GSO -0.0625in offset rule.`,
        }
      : { model: "separated_rectangle", note: "Side artwork is too small to offset — no cutline can be derived." },
    tamper: tamper
      ? {
          model: "separated_rectangle",
          cutWidthIn: tamper.cutWidthIn,
          cutHeightIn: tamper.cutHeightIn,
          note: `Individually cut. Cutline ${tamper.cutWidthIn.toFixed(3)} x ${tamper.cutHeightIn.toFixed(3)}in, derived by the GSO -0.0625in offset rule.`,
        }
      : { model: "separated_rectangle", note: "Tamper artwork is too small to offset — no cutline can be derived." },
    lid: lidCutDiameter
      ? {
          model: "contour",
          cutDiameterIn: lidCutDiameter,
          note: `Circular lid — contour path pi x ${lidCutDiameter.toFixed(3)}in, derived from the ${g.lid.diameterIn}in artboard diameter by the GSO -0.0625in offset rule.`,
        }
      : { model: "contour", note: "Lid artwork is too small to offset — no cut diameter can be derived." },
  };
}

export function jarFinishingStages(input: {
  size: JarSizeKey;
  nesting: NestingResult;
  machineKey?: string;
  cutMode?: CutMode;
  cutGeometry?: CutGeometryMap;
  requiresWeeding?: boolean;
  requiresCutting?: boolean;
}) {
  return computeFinishing({
    nesting: input.nesting,
    machineKey: input.machineKey ?? JAR_DEFAULT_CUT_MACHINE_KEY,
    cutMode: input.cutMode ?? JAR_DEFAULT_CUT_MODE,
    cutGeometry: input.cutGeometry ?? jarCutGeometry(input.size),
    requiresWeeding: input.requiresWeeding,
    requiresCutting: input.requiresCutting,
  });
}
