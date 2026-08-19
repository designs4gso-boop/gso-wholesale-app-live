// Patch 2A (17D.2) — THE canonical true manufacturing cost engine.
//
// TRUE JOB COST =
//   Materials + Ink + Setup Labor + Run Labor + Finishing/Application
//   + Machine/Equipment Recovery + Planned Overage + Packaging/Packout
//   + Inbound Freight + Outside Costs
//
// Commercial selling price is a SEPARATE concern and is never computed here.
//
// PURE. No database, no network, no Prisma. Every authoritative value is passed
// in by the caller, which is what keeps this testable and keeps a second cost
// authority from growing inside it. In Patch 2A nothing imports this module
// except its test, so no live price can move.
//
// THREE AREAS, NEVER COLLAPSED:
//   inkableArtworkSqft    — printable artwork/shape area (circular lid uses
//                           its ACTUAL circle area). Ink denominator.
//   ripLayoutSqft         — nested layout the head traverses. Machine denominator.
//   materialFootprintSqft — media physically consumed (bounding boxes + nesting).
// A circular label differs materially between the first and third (its circle
// area vs its bounding box), so substituting one for another is a real costing
// error, not a rounding detail. Product specifics live in the adapters.
//
// NO FALLBACK. A missing calibration, missing cost, missing coverage or missing
// area is reported and blocks a VALID result. Nothing silently becomes $0 and
// no legacy constant is ever substituted.

import {
  computeInkMl,
  computeOccupancyMinutes,
  type CalibrationRecord,
} from "./machine-calibration.server";

export const TRUE_COST_ENGINE_VERSION = "17D.2-true-cost-engine";

/**
 * Owner-approved provisional operator-attention standard.
 *
 * Normal printer tending is ~6 minutes or less of active operator attention per
 * 60 minutes of machine occupancy, so 10% of occupancy is charged at the
 * operator rate. The operator is NOT dedicated to the press — they do other
 * productive work while it runs — this allowance only covers tending.
 *
 * Universal across every family (jars, stickers, labels, sticker bags, stock
 * bags, DTP, boxes, banners) and currently applied to Mimaki CMYK, Roland CMYK,
 * Roland White and Roland Gloss alike. A caller may override the percentage per
 * machine/profile when a future owner measurement justifies it.
 */
export const DEFAULT_OPERATOR_ATTENTION_PCT = 10;
export const DEFAULT_OPERATOR_LABOR_RATE_PER_HOUR = 25;
export const OPERATOR_ATTENTION_CLASSIFICATION = "OWNER_APPROVED_PROVISIONAL";

/* ------------------------------------------------------------------ *
 * Result shape
 * ------------------------------------------------------------------ */

export type CostCategory =
  | "materials"
  | "ink"
  | "setup_labor"
  | "run_labor"
  | "finishing_application"
  | "machine_recovery"
  | "planned_overage"
  | "packout"
  | "inbound_freight"
  | "outside_costs";

/** VALID = every input verified. PROVISIONAL = numeric but a basis is provisional. DRAFT_ONLY = blocked. */
export type TrueCostStatus = "VALID" | "PROVISIONAL" | "DRAFT_ONLY";

export type TrueCostLine = {
  key: string;
  category: CostCategory;
  label: string;
  amount: number;
  formula?: string;
  note?: string;
  /** Set when this line could not be computed — always blocks a VALID result. */
  blocker?: string;
  /** Set when computed but resting on a provisional basis. */
  provisional?: string;
};

export type TrueCostAreas = {
  inkableArtworkSqft: number;
  ripLayoutSqft: number | null;
  materialFootprintSqft: number;
  /** Explains where ripLayoutSqft came from — a proxy must say so. */
  ripLayoutBasis: string;
};

export type TrueCostResult = {
  version: string;
  status: TrueCostStatus;
  customerFinishedQty: number;
  productionQty: number;
  overagePct: number;
  areas: TrueCostAreas;
  lines: TrueCostLine[];
  totals: Record<CostCategory, number>;
  totalCost: number;
  /** null when DRAFT_ONLY — a blocked job never publishes a per-unit number. */
  unitCost: number | null;
  blockers: string[];
  provisionalReasons: string[];
};

/* ------------------------------------------------------------------ *
 * Input shape
 * ------------------------------------------------------------------ */

export type TrueCostInput = {
  customerFinishedQty: number;
  productionQty: number;
  overagePct: number;

  areas: TrueCostAreas;

  /** Blank / substrate the product is built on, priced at PRODUCTION qty. */
  blank:
    | { ok: true; unitCost: number; label: string; source: string }
    | { ok: false; reason: string; message: string };

  /** Print media $/sqft — resolved by the caller from the verified Material row. */
  material: { name: string; costPerSqft: number | null; source: string } | null;

  /** Exact calibration for this machine+profile. null = MISSING_CALIBRATION. */
  calibration: CalibrationRecord | null;
  calibrationMessage?: string;

  /** $/mL from the purchasing authority — NEVER stored on a calibration row. */
  inkCostPerMl: number | null;
  inkCostSource: string;

  coveragePct?: number | null;
  passCount?: number;

  /**
   * Application / finishing labor, charged on CUSTOMER FINISHED QTY only.
   *
   * Generic on purpose: an adapter may supply seconds + rate (jars: 67 s at
   * $20/hr) or a pre-computed per-unit cost. The engine never knows what the
   * seconds are FOR.
   */
  application:
    | { secondsPerFinishedUnit: number; laborRatePerHour: number; note?: string }
    | { costPerFinishedUnit: number; note?: string };

  /**
   * Setup. The adapter decides how many setup groups a job has — one design,
   * one per SKU, or thirteen for a 13-design label job. The engine only sums
   * what it is given and never assumes one setup per job.
   */
  setup: { art: number; print: number; specialty?: number; groups: number; note?: string };

  /**
   * Run labor.
   *
   * "operator_attention" is the normal printed-job model: an operator is NOT
   * dedicated to the press for the whole run, but normal tending — checking
   * output and media, monitoring ink, responding to warnings and head/media
   * problems, periodic inspection — costs a share of machine occupancy. The
   * engine derives the hours from the occupancy it already computed, so no
   * adapter duplicates that calculation and the two can never disagree.
   *
   * This never double-counts print setup: setup/launch is its own component.
   *
   * "explicit" covers families where run labor is genuinely dedicated hours.
   * null = not modeled for this family yet.
   */
  runLabor:
    | { mode: "operator_attention"; attentionPct?: number; laborRatePerHour?: number; classification?: string }
    | { mode: "explicit"; hours: number; ratePerHour: number }
    | null;

  equipmentRatePerHour: number;

  /**
   * Packout on FINISHED qty. Either component rates (labor + consumables per
   * box) or a pre-computed cost. Boxes derive from unitsPerBox when supplied.
   */
  packout:
    | { unitsPerBox: number; laborPerBox: number; consumablesPerBox: number }
    | { boxes: number; unitsPerBox: number; cost: number };

  /** Applied to PRODUCTION qty. Never charged twice via a separate overage line. */
  freight: { perUnit: number | null; basis: string; provisional: boolean; source: string };

  /**
   * Generic additional finishing stages — cutting, weeding, hemming, grommets,
   * anything a family needs. Adapters supply the amounts; the engine supplies
   * the accounting, the status handling and the reason codes. Adding a stage
   * never requires a second cost engine.
   */
  finishingStages?: Array<{ key: string; label: string; amount: number; note?: string; provisional?: string; blocker?: string }>;

  outsideCosts?: Array<{ label: string; amount: number }>;
};

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

const EMPTY_TOTALS = (): Record<CostCategory, number> => ({
  materials: 0,
  ink: 0,
  setup_labor: 0,
  run_labor: 0,
  finishing_application: 0,
  machine_recovery: 0,
  planned_overage: 0,
  packout: 0,
  inbound_freight: 0,
  outside_costs: 0,
});

export function computeTrueJobCost(input: TrueCostInput): TrueCostResult {
  const lines: TrueCostLine[] = [];
  const finished = Math.max(0, Math.floor(input.customerFinishedQty));
  const production = Math.max(finished, Math.floor(input.productionQty));

  /* ---- 1. Materials: blank sets (production qty) ---- */
  if (input.blank.ok) {
    lines.push({
      key: "blank_sets",
      category: "materials",
      label: `${input.blank.label} — ${production} set(s)`,
      amount: input.blank.unitCost * production,
      formula: `${production} x $${input.blank.unitCost.toFixed(4)}`,
      note: input.blank.source,
    });
  } else {
    lines.push({
      key: "blank_sets",
      category: "materials",
      label: "Blank / substrate",
      amount: 0,
      blocker: `${input.blank.reason}: ${input.blank.message}`,
    });
  }

  /* ---- 2. Materials: print media (material footprint) ---- */
  if (input.material && input.material.costPerSqft != null && input.material.costPerSqft > 0) {
    lines.push({
      key: "print_media",
      category: "materials",
      label: `${input.material.name} — ${input.areas.materialFootprintSqft.toFixed(2)} sqft (material footprint)`,
      amount: input.material.costPerSqft * input.areas.materialFootprintSqft,
      formula: `${input.areas.materialFootprintSqft.toFixed(4)} sqft x $${input.material.costPerSqft.toFixed(6)}/sqft`,
      note: `${input.material.source} materialFootprintSqft IS the physically consumed media — the deterministic nesting/layout engine will supply it directly (gutters, margins, unused roll width, row/column spacing, rotation inefficiency, feed length all included). No separate waste percentage is required or accepted. Today the adapter supplies a bounding-box approximation.`,
    });
  } else {
    lines.push({
      key: "print_media",
      category: "materials",
      label: input.material?.name || "Print media",
      amount: 0,
      blocker: "MISSING_COST: no verified print-media $/sqft.",
    });
  }

  /* ---- 3. Ink (inkable artwork area x calibration x $/mL) ---- */
  if (!input.calibration) {
    lines.push({
      key: "ink",
      category: "ink",
      label: "Ink",
      amount: 0,
      blocker: `MISSING_CALIBRATION: ${input.calibrationMessage || "no approved calibration for this exact machine/profile identity."}`,
    });
  } else if (input.inkCostPerMl == null || !(input.inkCostPerMl > 0)) {
    lines.push({
      key: "ink",
      category: "ink",
      label: "Ink",
      amount: 0,
      blocker: "MISSING_INK_PRICE: no purchasing $/mL for this channel.",
    });
  } else {
    const ml = computeInkMl({
      calibration: input.calibration,
      areas: {
        inkable_artwork: input.areas.inkableArtworkSqft,
        rip_layout: input.areas.ripLayoutSqft ?? undefined,
        material_footprint: input.areas.materialFootprintSqft,
      },
      coveragePct: input.coveragePct,
      passCount: input.passCount,
    });
    if (!ml.ok) {
      lines.push({ key: "ink", category: "ink", label: "Ink", amount: 0, blocker: `${ml.reason}: ${ml.message}` });
    } else {
      lines.push({
        key: "ink",
        category: "ink",
        label: `${input.calibration.inkMode} ink — ${ml.inkMl.toFixed(2)} mL`,
        amount: ml.inkMl * input.inkCostPerMl,
        formula: `${ml.areaSqft.toFixed(4)} sqft (${ml.areaBasis}) x ${ml.coveragePct}% x ${ml.mlPerSqftPerPass} mL/sqft x ${ml.passCount} pass = ${ml.inkMl.toFixed(4)} mL x $${input.inkCostPerMl.toFixed(7)}/mL`,
        note: `${input.inkCostSource} Coverage source: ${ml.coverageSource}.`,
      });
    }
  }

  /* ---- 4. Setup labor (groups decided by the adapter, never assumed to be 1) ---- */
  lines.push({
    key: "art_setup",
    category: "setup_labor",
    label: `Art setup — ${input.setup.groups} setup group(s)`,
    amount: input.setup.art,
    note: input.setup.note,
  });
  lines.push({
    key: "print_setup",
    category: "setup_labor",
    label: "Print setup",
    amount: input.setup.print,
  });
  if (input.setup.specialty != null && input.setup.specialty > 0) {
    lines.push({
      key: "specialty_setup",
      category: "setup_labor",
      label: "Specialty setup (e.g. gloss/white mask preparation)",
      amount: input.setup.specialty,
    });
  }

  /* ---- machine occupancy, resolved ONCE ----
   * Both equipment recovery (7) and operator-attention run labor (5) derive
   * from this single result, so the two can never disagree about how long the
   * press was occupied. */
  let occupancyMinutes: number | null = null;
  let occupancyBlocker: string | null = null;
  let occupancyDetail: { areaSqft: number; areaBasis: string; minutesPerSqft: number; passCount: number } | null = null;

  if (!input.calibration) {
    occupancyBlocker = "MISSING_CALIBRATION.";
  } else if (input.areas.ripLayoutSqft == null || !(input.areas.ripLayoutSqft > 0)) {
    occupancyBlocker = "MISSING_NESTING_MODEL: ripLayoutSqft is required and no nesting model produced one.";
  } else {
    const occ = computeOccupancyMinutes({
      calibration: input.calibration,
      areas: {
        inkable_artwork: input.areas.inkableArtworkSqft,
        rip_layout: input.areas.ripLayoutSqft,
        material_footprint: input.areas.materialFootprintSqft,
      },
      passCount: input.passCount,
    });
    if (!occ.ok) occupancyBlocker = `${occ.reason}: ${occ.message}`;
    else {
      occupancyMinutes = occ.minutes;
      occupancyDetail = { areaSqft: occ.areaSqft, areaBasis: occ.areaBasis, minutesPerSqft: occ.minutesPerSqft, passCount: occ.passCount };
    }
  }
  const occupancyHours = occupancyMinutes == null ? null : occupancyMinutes / 60;

  /* ---- 5. Run labor ---- */
  const rl = input.runLabor;
  if (rl && rl.mode === "explicit") {
    lines.push({
      key: "run_labor",
      category: "run_labor",
      label: `Run labor — ${rl.hours.toFixed(3)} hr @ $${rl.ratePerHour}/hr`,
      amount: rl.hours * rl.ratePerHour,
    });
  } else if (rl && rl.mode === "operator_attention") {
    const pct = rl.attentionPct ?? DEFAULT_OPERATOR_ATTENTION_PCT;
    const rate = rl.laborRatePerHour ?? DEFAULT_OPERATOR_LABOR_RATE_PER_HOUR;
    const classification = rl.classification ?? OPERATOR_ATTENTION_CLASSIFICATION;
    if (occupancyHours == null) {
      lines.push({
        key: "run_labor",
        category: "run_labor",
        label: "Operator attention labor",
        amount: 0,
        blocker: `Cannot derive operator attention without machine occupancy — ${occupancyBlocker}`,
      });
    } else {
      const attentionHours = occupancyHours * (pct / 100);
      lines.push({
        key: "run_labor",
        category: "run_labor",
        label: `Operator attention — ${pct}% of ${occupancyHours.toFixed(3)} machine hr @ $${rate}/hr`,
        amount: attentionHours * rate,
        formula: `${occupancyHours.toFixed(4)} machine hr x ${pct}% x $${rate}/hr = ${attentionHours.toFixed(4)} labor hr`,
        note: "Partial attention: the operator is NOT dedicated to the press and does other productive work while it runs. Covers normal tending only — output/media checks, ink monitoring and changes, head/media problems, warnings, periodic inspection. Print setup/launch is a SEPARATE component and is not double-counted here.",
        provisional: `Operator attention ${pct}% is ${classification} — replace when a machine/profile-specific measurement exists.`,
      });
    }
  } else {
    lines.push({
      key: "run_labor",
      category: "run_labor",
      label: "Run labor — not modeled",
      amount: 0,
      provisional: "No verified run-labor standard for this family yet; this component contributes $0 and the job is reported PROVISIONAL.",
    });
  }

  /* ---- 6. Finishing / application (FINISHED qty only) ---- */
  const app = input.application;
  const appPerUnit =
    "costPerFinishedUnit" in app ? app.costPerFinishedUnit : (app.secondsPerFinishedUnit / 3600) * app.laborRatePerHour;
  const appFormula =
    "costPerFinishedUnit" in app
      ? `${finished} x $${appPerUnit.toFixed(6)}`
      : `${finished} x ${app.secondsPerFinishedUnit}s / 3600 x $${app.laborRatePerHour}/hr`;
  lines.push({
    key: "application",
    category: "finishing_application",
    label: `Application labor — ${finished} finished unit(s)`,
    amount: appPerUnit * finished,
    formula: appFormula,
    note: `${app.note || ""} Charged on customer finished quantity only — never on the overage.`.trim(),
  });

  /* ---- 6b. Additional finishing stages (cutting, weeding, hemming, …) ---- */
  for (const stage of input.finishingStages || []) {
    lines.push({
      key: stage.key,
      category: "finishing_application",
      label: stage.label,
      amount: stage.blocker ? 0 : stage.amount,
      note: stage.note,
      provisional: stage.provisional,
      blocker: stage.blocker,
    });
  }

  /* ---- 7. Machine / equipment recovery (RIP layout area) ----
   * Equipment recovery only. Operator attention is a SEPARATE run-labor
   * component (5) so the two burdens stay independently adjustable. */
  if (occupancyMinutes == null || occupancyDetail == null) {
    lines.push({
      key: "machine",
      category: "machine_recovery",
      label: "Machine recovery",
      amount: 0,
      blocker: occupancyBlocker || "MISSING_CALIBRATION.",
    });
  } else {
    lines.push({
      key: "machine",
      category: "machine_recovery",
      label: `Machine recovery — ${occupancyMinutes.toFixed(1)} min`,
      amount: (occupancyMinutes / 60) * input.equipmentRatePerHour,
      formula: `${occupancyDetail.areaSqft.toFixed(4)} sqft (${occupancyDetail.areaBasis}) x ${occupancyDetail.minutesPerSqft} min/sqft x ${occupancyDetail.passCount} pass / 60 x $${input.equipmentRatePerHour}/hr`,
      note: `Coverage never reduces occupancy. RIP layout basis: ${input.areas.ripLayoutBasis}`,
      provisional: /proxy/i.test(input.areas.ripLayoutBasis)
        ? "ripLayoutSqft is a documented PROXY, not a nested layout — machine recovery is approximate."
        : undefined,
    });
  }

  /* ---- 8. Planned overage (a QUANTITY effect, never a second charge) ---- */
  lines.push({
    key: "planned_overage",
    category: "planned_overage",
    label: `Planned overage ${input.overagePct}% — ${finished} finished -> ${production} produced`,
    amount: 0,
    note: "Overage is applied by producing more units: blanks, media, ink and inbound freight already price at production quantity. It is deliberately never a separate charge, so nothing is double-counted.",
  });

  /* ---- 9. Packout (FINISHED qty) ---- */
  const pk = input.packout;
  const packBoxes = "boxes" in pk ? pk.boxes : Math.ceil(finished / Math.max(1, pk.unitsPerBox));
  const packPerBox = "cost" in pk ? pk.cost / Math.max(1, packBoxes) : pk.laborPerBox + pk.consumablesPerBox;
  const packCost = "cost" in pk ? pk.cost : packBoxes * packPerBox;
  lines.push({
    key: "packout",
    category: "packout",
    label: `Packout — ${packBoxes} box(es) @ ${pk.unitsPerBox}/box`,
    amount: packCost,
    formula: `ceil(${finished} / ${pk.unitsPerBox}) x $${packPerBox.toFixed(2)}/box`,
    note: "cost" in pk ? undefined : `$${pk.laborPerBox.toFixed(2)} labor + $${pk.consumablesPerBox.toFixed(2)} consumables per box.`,
  });

  /* ---- 10. Inbound freight (PRODUCTION qty) ---- */
  if (input.freight.perUnit == null) {
    lines.push({
      key: "inbound_freight",
      category: "inbound_freight",
      label: "Inbound freight",
      amount: 0,
      blocker: `${input.freight.basis}: ${input.freight.source}`,
    });
  } else {
    lines.push({
      key: "inbound_freight",
      category: "inbound_freight",
      label: `Inbound freight — ${production} production unit(s)`,
      amount: input.freight.perUnit * production,
      formula: `${production} x $${input.freight.perUnit.toFixed(6)}/unit`,
      note: input.freight.source,
      provisional: input.freight.provisional ? `Freight basis is ${input.freight.basis} — provisional, not a supplier-confirmed tariff.` : undefined,
    });
  }

  /* ---- 11. Outside costs ---- */
  for (const [index, outside] of (input.outsideCosts || []).entries()) {
    lines.push({ key: `outside_${index}`, category: "outside_costs", label: outside.label, amount: outside.amount });
  }

  /* ---- roll up ---- */
  const totals = EMPTY_TOTALS();
  for (const line of lines) totals[line.category] += line.amount;

  const blockers = lines.filter((l) => l.blocker).map((l) => `${l.label}: ${l.blocker}`);
  const provisionalReasons = lines.filter((l) => l.provisional).map((l) => `${l.label}: ${l.provisional}`);

  const totalCost = lines.reduce((sum, l) => sum + l.amount, 0);
  const status: TrueCostStatus = blockers.length ? "DRAFT_ONLY" : provisionalReasons.length ? "PROVISIONAL" : "VALID";

  return {
    version: TRUE_COST_ENGINE_VERSION,
    status,
    customerFinishedQty: finished,
    productionQty: production,
    overagePct: input.overagePct,
    areas: input.areas,
    lines,
    totals,
    totalCost,
    // A blocked job never publishes a per-unit number.
    unitCost: status === "DRAFT_ONLY" || finished <= 0 ? null : totalCost / finished,
    blockers,
    provisionalReasons,
  };
}
