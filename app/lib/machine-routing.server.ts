// Patch 2D-4A (17D.7A) — THE canonical machine-routing + calibration authority.
//
// ONE place decides which press a job runs on and which calibration identity
// each ink channel needs. The label, bag and banner adapters, the calculator
// route and the canonical dispatch all consume this — none of them re-derives
// routing, so the rule cannot drift apart between families.
//
// OWNER ROUTING RULE (unchanged by this patch):
//
//   CMYK only        AUTO -> MIMAKI. Explicit ROLAND allowed (overflow /
//                    operator-approved work). Explicit MIMAKI allowed.
//   WHITE            ROLAND required. Explicit MIMAKI -> BLOCK.
//   GLOSS            ROLAND required. Explicit MIMAKI -> BLOCK.
//   WHITE + GLOSS    ROLAND required. Explicit MIMAKI -> BLOCK.
//
// The Mimaki is a CMYK-only machine: CANONICAL_INK_RATES.mimakiGlossPerMl is
// deliberately null and no Mimaki white/gloss calibration exists, so a Mimaki
// specialty job could never price even if routing allowed it.
//
// OPERATORS NEVER TYPE CALIBRATION INTERNALS. ripProfile / qualityMode /
// resolution / passConfig are derived here from the printer + ink mode. The
// only operator inputs are: printer (auto | mimaki | roland), white layers,
// white coverage %, gloss layers, gloss coverage %.
//
// FAILS CLOSED. A logically-resolved identity with no approved DB row is
// MISSING_CALIBRATION -> DRAFT_ONLY. Matching is never widened and no
// "close enough" record is ever substituted.

import {
  CANONICAL_INK_RATES,
  channelInkRatePerMl,
  type InkChannelKind,
} from "./ink-rates-shared";
import type { CalibrationIdentity } from "./machine-calibration.server";

export const MACHINE_ROUTING_VERSION = "17D.7A-machine-routing";

/* ------------------------------------------------------------------ *
 * Machines
 * ------------------------------------------------------------------ */

export const MACHINE_KEYS = {
  mimaki: "mimaki-ucjv300-130",
  roland: "roland-lg-640",
} as const;

export type PrinterBrand = "mimaki" | "roland";
export type PrinterSelection = "auto" | PrinterBrand;

export const PRINTER_SELECTIONS: PrinterSelection[] = ["auto", "mimaki", "roland"];

export function normalizePrinterSelection(value: unknown): PrinterSelection {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "mimaki") return "mimaki";
  if (text === "roland") return "roland";
  return "auto";
}

/** The Mimaki prints CMYK and nothing else. Owner-verified 2026-07-26. */
export const MACHINE_CAPABILITIES: Record<PrinterBrand, { cmyk: boolean; white: boolean; gloss: boolean }> = {
  mimaki: { cmyk: true, white: false, gloss: false },
  roland: { cmyk: true, white: true, gloss: true },
};

/* ------------------------------------------------------------------ *
 * The four owner-measured calibration identities.
 *
 * These are the EXACT six-part identities seeded by
 * tools/seed-machine-profile-calibrations.mjs. They are transcribed here so
 * the resolver can name them without a database round trip; a test pins them
 * byte-for-byte against the seed file so the two can never drift.
 *
 * NOTE the Mimaki's ink mode is "cmyk_heavy", not "cmyk" — heavy/full CMYK is
 * the normal GSO production assumption and that is what was measured.
 * ------------------------------------------------------------------ */

export type CanonicalCalibrationKey = "mimaki-cmyk" | "roland-cmyk" | "roland-white" | "roland-gloss";

export const CANONICAL_CALIBRATION_IDENTITIES: Record<CanonicalCalibrationKey, CalibrationIdentity> = {
  "mimaki-cmyk": {
    machineKey: MACHINE_KEYS.mimaki,
    inkMode: "cmyk_heavy",
    ripProfile: "PVC Gloss / Mimaki Vision Vinyl",
    qualityMode: "Fast Print High",
    resolution: "600x1200 VD",
    passConfig: "32-pass-bidi-op1",
  },
  "roland-cmyk": {
    machineKey: MACHINE_KEYS.roland,
    inkMode: "cmyk",
    ripProfile: "Generic Sign Production",
    qualityMode: "High Quality",
    resolution: "720x1200",
    passConfig: "hq-default",
  },
  "roland-white": {
    machineKey: MACHINE_KEYS.roland,
    inkMode: "white",
    ripProfile: "Generic Sign Production",
    qualityMode: "High Quality",
    resolution: "720x1200",
    passConfig: "white-hd-1x",
  },
  "roland-gloss": {
    machineKey: MACHINE_KEYS.roland,
    inkMode: "gloss",
    ripProfile: "Special Effects",
    qualityMode: "High Quality",
    resolution: "720x1200",
    passConfig: "gloss-1x",
  },
};

/* ------------------------------------------------------------------ *
 * Reasons
 * ------------------------------------------------------------------ */

export const ROUTING_REASONS = {
  /** Explicit Mimaki + white/gloss. The machine cannot do it. */
  mimakiSpecialtyUnsupported: "MIMAKI_SPECIALTY_UNSUPPORTED",
  /** White selected with no coverage supplied. Never defaulted. */
  whiteCoverageRequired: "WHITE_COVERAGE_REQUIRED",
  /** A coverage outside 0..100. */
  invalidCoverage: "INVALID_COVERAGE",
  /** Layers must be whole numbers >= 0. */
  invalidLayers: "INVALID_LAYER_COUNT",
  /** No approved $/mL for a resolved channel. */
  inkPriceRequired: "MISSING_INK_PRICE",
} as const;

/* ------------------------------------------------------------------ *
 * Input / output
 * ------------------------------------------------------------------ */

export type MachineRoutingInput = {
  printerSelection?: PrinterSelection | string;
  whiteLayers?: number;
  /** Operator-supplied. NEVER defaulted and NEVER inferred from layer count. */
  whiteCoveragePct?: number | null;
  glossLayers?: number;
  glossCoveragePct?: number | null;
  /** CMYK coverage. Heavy production reference (100%) unless overridden. */
  cmykCoveragePct?: number | null;
};

export type RoutedChannel = {
  kind: InkChannelKind;
  calibrationKey: CanonicalCalibrationKey;
  identity: CalibrationIdentity;
  /** Print passes for this channel = its layer count (CMYK is always 1). */
  passCount: number;
  /** null when the operator must still supply it (white). */
  coveragePct: number | null;
  /** Canonical purchasing $/mL. null = no approved rate; blocks. */
  inkCostPerMl: number | null;
  inkCostSource: string;
  /** True for the job's base colour pass; false for specialty channels. */
  isBase: boolean;
};

export type MachineRoutingResult = {
  version: string;
  printerSelection: PrinterSelection;
  /** The press the job actually runs on. */
  effectivePrinter: PrinterBrand;
  machineKey: string;
  /** Why that press — shown to the operator. */
  routingBasis: string;
  /** Did the operator's explicit choice get honoured? */
  overrideApplied: boolean;
  requiresSpecialty: boolean;
  whiteLayers: number;
  glossLayers: number;
  channels: RoutedChannel[];
  /** Every calibration identity this job needs an approved row for. */
  requiredIdentities: CalibrationIdentity[];
  reasons: string[];
  blockers: string[];
};

const whole = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const coverageInvalid = (value: number | null | undefined): boolean =>
  value != null && (!Number.isFinite(value) || value <= 0 || value > 100);

/**
 * Route a job to a press and name every calibration identity it needs.
 *
 * PURE — no database. The caller loads the named identities and fails closed
 * on any that has no approved row.
 */
export function resolveCanonicalMachineRouting(input: MachineRoutingInput): MachineRoutingResult {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const printerSelection = normalizePrinterSelection(input.printerSelection);
  const whiteLayers = whole(input.whiteLayers);
  const glossLayers = whole(input.glossLayers);
  const requiresSpecialty = whiteLayers > 0 || glossLayers > 0;

  if (Number(input.whiteLayers ?? 0) < 0 || Number(input.glossLayers ?? 0) < 0) {
    reasons.push(ROUTING_REASONS.invalidLayers);
    blockers.push(`${ROUTING_REASONS.invalidLayers}: white and gloss layer counts must be whole numbers of zero or more.`);
  }

  /* ---- 1. Which press? ---- */
  let effectivePrinter: PrinterBrand;
  let routingBasis: string;
  let overrideApplied = false;

  if (requiresSpecialty) {
    // White and gloss exist only on the Roland.
    effectivePrinter = "roland";
    const parts = [whiteLayers > 0 ? "white" : null, glossLayers > 0 ? "gloss" : null].filter(Boolean).join(" + ");
    routingBasis = `${parts} selected — the Roland is the only press with white/gloss channels, so this job routes to it regardless of the printer selection.`;
    if (printerSelection === "mimaki") {
      reasons.push(ROUTING_REASONS.mimakiSpecialtyUnsupported);
      blockers.push(
        `${ROUTING_REASONS.mimakiSpecialtyUnsupported}: the Mimaki UCJV300-130 is a CMYK-only press and cannot print ${parts}. Route this job to the Roland, or remove the ${parts} layer(s).`,
      );
    }
  } else if (printerSelection === "roland") {
    effectivePrinter = "roland";
    overrideApplied = true;
    routingBasis = "CMYK-only job explicitly routed to the Roland (overflow or operator-approved work).";
  } else if (printerSelection === "mimaki") {
    effectivePrinter = "mimaki";
    overrideApplied = true;
    routingBasis = "CMYK-only job explicitly routed to the Mimaki.";
  } else {
    effectivePrinter = "mimaki";
    routingBasis = "AUTO — a CMYK-only job defaults to the Mimaki under the canonical routing rule.";
  }

  /* ---- 2. Which channels, and on which calibration? ---- */
  const channels: RoutedChannel[] = [];

  const priceFor = (kind: InkChannelKind): { perMl: number | null; source: string } => {
    const perMl = channelInkRatePerMl(effectivePrinter, kind);
    if (perMl != null) {
      return { perMl, source: `Canonical purchasing rate for ${effectivePrinter} ${kind} (ink-rates-shared).` };
    }
    return {
      perMl: null,
      source:
        effectivePrinter === "mimaki" && kind === "gloss"
          ? "The Mimaki is CMYK-only — gloss is never priced on it."
          : `No approved $/mL exists for ${effectivePrinter} ${kind}.`,
    };
  };

  // BASE COLOUR — every job prints CMYK.
  {
    const key: CanonicalCalibrationKey = effectivePrinter === "mimaki" ? "mimaki-cmyk" : "roland-cmyk";
    const price = priceFor("cmyk");
    if (coverageInvalid(input.cmykCoveragePct)) {
      reasons.push(ROUTING_REASONS.invalidCoverage);
      blockers.push(`${ROUTING_REASONS.invalidCoverage}: CMYK coverage must be greater than 0 and at most 100 (received ${input.cmykCoveragePct}).`);
    }
    channels.push({
      kind: "cmyk",
      calibrationKey: key,
      identity: CANONICAL_CALIBRATION_IDENTITIES[key],
      passCount: 1,
      // null lets the calibration's own heavy-production reference apply.
      coveragePct: input.cmykCoveragePct ?? null,
      inkCostPerMl: price.perMl,
      inkCostSource: price.source,
      isBase: true,
    });
    if (price.perMl == null) {
      reasons.push(ROUTING_REASONS.inkPriceRequired);
      blockers.push(`${ROUTING_REASONS.inkPriceRequired}: ${price.source}`);
    }
  }

  // WHITE — coverage is mandatory and is NEVER inferred from the layer count.
  if (whiteLayers > 0) {
    const price = priceFor("white");
    let coveragePct: number | null = null;
    if (input.whiteCoveragePct == null || String(input.whiteCoveragePct) === "") {
      reasons.push(ROUTING_REASONS.whiteCoverageRequired);
      blockers.push(
        `${ROUTING_REASONS.whiteCoverageRequired}: white has NO default coverage. Supply the actual white coverage percentage — it is a separate input from the ${whiteLayers} white layer(s) and is never derived from them.`,
      );
    } else if (coverageInvalid(input.whiteCoveragePct)) {
      reasons.push(ROUTING_REASONS.invalidCoverage);
      blockers.push(`${ROUTING_REASONS.invalidCoverage}: white coverage must be greater than 0 and at most 100 (received ${input.whiteCoveragePct}).`);
    } else {
      coveragePct = Number(input.whiteCoveragePct);
    }
    channels.push({
      kind: "white",
      calibrationKey: "roland-white",
      identity: CANONICAL_CALIBRATION_IDENTITIES["roland-white"],
      passCount: whiteLayers,
      coveragePct,
      inkCostPerMl: price.perMl,
      inkCostSource: price.source,
      isBase: false,
    });
    if (price.perMl == null) {
      reasons.push(ROUTING_REASONS.inkPriceRequired);
      blockers.push(`${ROUTING_REASONS.inkPriceRequired}: ${price.source}`);
    }
  }

  // GLOSS — an owner-approved 50% customer default exists (resolveCoverage),
  // so a missing gloss coverage does not block; an INVALID one does.
  if (glossLayers > 0) {
    const price = priceFor("gloss");
    if (coverageInvalid(input.glossCoveragePct)) {
      reasons.push(ROUTING_REASONS.invalidCoverage);
      blockers.push(`${ROUTING_REASONS.invalidCoverage}: gloss coverage must be greater than 0 and at most 100 (received ${input.glossCoveragePct}).`);
    }
    channels.push({
      kind: "gloss",
      calibrationKey: "roland-gloss",
      identity: CANONICAL_CALIBRATION_IDENTITIES["roland-gloss"],
      passCount: glossLayers,
      coveragePct: input.glossCoveragePct ?? null,
      inkCostPerMl: price.perMl,
      inkCostSource: price.source,
      isBase: false,
    });
    if (price.perMl == null) {
      reasons.push(ROUTING_REASONS.inkPriceRequired);
      blockers.push(`${ROUTING_REASONS.inkPriceRequired}: ${price.source}`);
    }
  }

  return {
    version: MACHINE_ROUTING_VERSION,
    printerSelection,
    effectivePrinter,
    machineKey: MACHINE_KEYS[effectivePrinter],
    routingBasis,
    overrideApplied,
    requiresSpecialty,
    whiteLayers,
    glossLayers,
    channels,
    requiredIdentities: channels.map((channel) => channel.identity),
    reasons: Array.from(new Set(reasons)),
    blockers,
  };
}

/** Re-exported so callers never reach into ink-rates-shared themselves. */
export { CANONICAL_INK_RATES };
