// Patch 2D-4A (17D.7A) — THE canonical machine-routing + calibration authority.
//
// ONE place decides which press a job runs on and which calibration identity
// each ink channel needs. The label, bag and banner adapters, the calculator
// route and the canonical dispatch all consume this — none of them re-derives
// routing, so the rule cannot drift apart between families.
//
// OWNER ROUTING RULE (corrected 2026-11-11 — the Mimaki DOES print White):
//
//   CMYK only        Explicit MIMAKI or ROLAND allowed. AUTO -> the LESS BUSY
//                    eligible press (machine-load-balancing.ts).
//   WHITE            Explicit MIMAKI or ROLAND allowed. AUTO -> less busy
//   CMYK + WHITE     among the presses that are compatible AND cost-calibrated.
//   GLOSS            ROLAND required. Explicit MIMAKI -> BLOCK.
//   WHITE + GLOSS    ROLAND required. Explicit MIMAKI -> BLOCK.
//
// GLOSS is what forces the Roland; White alone does not. The Mimaki has no
// gloss channel (CANONICAL_INK_RATES.mimakiGlossPerMl is deliberately null).
//
// Compatibility and COST calibration are separate: Mimaki White is supported
// operationally but is costed only from its OWN approved calibration
// ("mimaki-white") — never from the Roland's. Missing that row is
// MIMAKI_WHITE_CALIBRATION_REQUIRED, not an unsupported machine.
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
import { AUTO_MACHINE_LOAD_UNAVAILABLE, selectLessBusyPrinter, type MachineLoadSnapshot } from "./machine-load-balancing";

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

/**
 * Owner-authoritative capabilities (corrected 2026-11-11): the Mimaki prints
 * CMYK and White; Gloss is not operational on it. The Roland prints all three.
 */
export const MACHINE_CAPABILITIES: Record<PrinterBrand, { cmyk: boolean; white: boolean; gloss: boolean }> = {
  mimaki: { cmyk: true, white: true, gloss: false },
  roland: { cmyk: true, white: true, gloss: true },
};

/** Presses that can physically print a job with these layers. */
export function compatiblePrinters(layers: { whiteLayers?: number; glossLayers?: number }): PrinterBrand[] {
  const white = Number(layers.whiteLayers ?? 0) > 0;
  const gloss = Number(layers.glossLayers ?? 0) > 0;
  return (["mimaki", "roland"] as PrinterBrand[]).filter((p) => (!white || MACHINE_CAPABILITIES[p].white) && (!gloss || MACHINE_CAPABILITIES[p].gloss));
}

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

/** The four identities with owner-approved seeded rows. */
export type SeededCalibrationKey = "mimaki-cmyk" | "roland-cmyk" | "roland-white" | "roland-gloss";
/** Identities a job may need that have NO approved row yet (2026-11-11: Mimaki White). */
export type PendingCalibrationKey = "mimaki-white";
export type CanonicalCalibrationKey = SeededCalibrationKey | PendingCalibrationKey;

export const CANONICAL_CALIBRATION_IDENTITIES: Record<SeededCalibrationKey, CalibrationIdentity> = {
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

/**
 * Supported-press identities with NO approved calibration row. Kept out of
 * CANONICAL_CALIBRATION_IDENTITIES (which mirrors the seed file byte-for-byte)
 * so nothing treats them as seeded; the resolver still names and looks them up.
 */
export const PENDING_CALIBRATION_IDENTITIES: Record<PendingCalibrationKey, CalibrationIdentity> = {
  // 2026-11-11 — Mimaki White. NO approved row is seeded: the identity exists so
  // the resolver can name what it needs and fail closed with
  // MIMAKI_WHITE_CALIBRATION_REQUIRED. Activation is owner-approved only.
  // Values are the RIP settings observed on real Mimaki White jobs
  // (RasterLink MDC job XML, 2026-11-09: Generic PVC Matte v3.5, 600x1200,
  // 32 pass, FastPrint on, one White layer on channels 0f00+0f01).
  "mimaki-white": {
    machineKey: MACHINE_KEYS.mimaki,
    inkMode: "white",
    ripProfile: "Generic PVC Matte v3.5",
    qualityMode: "Fast Print High",
    resolution: "600x1200 VD",
    passConfig: "32-pass-white-1x",
  },
};

/** Every identity the resolver can name — seeded first, then pending. */
export const ALL_CALIBRATION_IDENTITIES: Record<CanonicalCalibrationKey, CalibrationIdentity> = {
  ...CANONICAL_CALIBRATION_IDENTITIES,
  ...PENDING_CALIBRATION_IDENTITIES,
};

/**
 * 2026-11-11 — calibration PROVENANCE vs the profiles production actually runs.
 *
 * The Mimaki CMYK row was measured on 2026-08-18 against "PVC Gloss / Mimaki
 * Vision Vinyl" (seed file; 130 x 3.989 x 5 in, 34.085 mL, 26 min). Current
 * RasterLink jobs run "Generic PVC Matte v3.5". The seeded identity is left
 * EXACTLY as measured — renaming it would falsify its provenance — and every
 * Mimaki CMYK quote keeps resolving that one exact identity (the resolver never
 * reads a live RIP profile, never widens a match). Recent production CMYK usage
 * (≈1.43–1.70 mL/sqft; ≈1.26 min/sqft) sits at or below the 1.89 / 1.444
 * reference, so the numbers stay; using them for Generic PVC Matte v3.5 is an
 * explicit, disclosed, owner-pending application — not an alias.
 */
export const CALIBRATION_PROVENANCE: Partial<Record<CanonicalCalibrationKey, {
  measuredOnProfile: string;
  observedProductionProfiles: string[];
  status: "MEASURED_PROFILE_MATCHES" | "APPLIED_TO_UNMEASURED_PROFILE_PENDING_OWNER_CONFIRMATION";
  note: string;
}>> = {
  "mimaki-cmyk": {
    measuredOnProfile: "PVC Gloss / Mimaki Vision Vinyl",
    observedProductionProfiles: ["Generic PVC Matte v3.5"],
    status: "APPLIED_TO_UNMEASURED_PROFILE_PENDING_OWNER_CONFIRMATION",
    note: "Measured 2026-08-18 on PVC Gloss / Mimaki Vision Vinyl; current Mimaki production runs Generic PVC Matte v3.5 (owner provenance review pending — numbers unchanged).",
  },
};

/**
 * Owner-CONFIRMED profile aliases: an observed RIP profile that may be treated
 * as a measured identity's profile. EMPTY until the owner confirms one, so any
 * caller matching real RIP rows to a calibration fails closed on a mismatch.
 */
export const OWNER_CONFIRMED_PROFILE_ALIASES: Partial<Record<CanonicalCalibrationKey, string[]>> = {};

/**
 * The calibration a RIP row with this observed profile may be compared with,
 * or null. Exact measured profile or an owner-confirmed alias only — never a
 * neighbouring calibration.
 */
export function calibrationKeyForObservedProfile(key: CanonicalCalibrationKey, observedProfile: string | null | undefined): CanonicalCalibrationKey | null {
  const observed = String(observedProfile ?? "").trim().toLowerCase();
  if (!observed) return null;
  const identity = ALL_CALIBRATION_IDENTITIES[key];
  if (identity.ripProfile.trim().toLowerCase() === observed) return key;
  return (OWNER_CONFIRMED_PROFILE_ALIASES[key] || []).some((alias) => alias.trim().toLowerCase() === observed) ? key : null;
}

/* ------------------------------------------------------------------ *
 * Reasons
 * ------------------------------------------------------------------ */

export const ROUTING_REASONS = {
  /** Explicit Mimaki + gloss. The Mimaki has no operational gloss. */
  mimakiGlossUnsupported: "MIMAKI_GLOSS_UNSUPPORTED",
  /** Mimaki White is supported, but no approved Mimaki White cost calibration exists. */
  mimakiWhiteCalibrationRequired: "MIMAKI_WHITE_CALIBRATION_REQUIRED",
  /** AUTO with two eligible presses and no defensible load answer. */
  autoMachineLoadUnavailable: AUTO_MACHINE_LOAD_UNAVAILABLE,
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
  /** Server-supplied per-press load for AUTO. Absent = load unavailable. */
  machineLoad?: MachineLoadSnapshot | null;
  /**
   * Server-supplied: presses whose every needed calibration is approved for
   * this job. AUTO only balances among these when supplied; absent = not
   * filtered (the calibration lookup still fails closed afterwards).
   */
  costReadyPrinters?: PrinterBrand[] | null;
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
  /** How AUTO resolved (or why it could not). */
  autoSelection: { status: "explicit" | "gloss_requires_roland" | "single_eligible" | "load_balanced" | "unavailable"; detail: string };
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
  let autoSelection: MachineRoutingResult["autoSelection"];
  const parts = [whiteLayers > 0 ? "white" : null, glossLayers > 0 ? "gloss" : null].filter(Boolean).join(" + ") || "CMYK";

  if (glossLayers > 0) {
    // Gloss exists only on the Roland — the one thing that forces a press.
    effectivePrinter = "roland";
    overrideApplied = printerSelection === "roland";
    routingBasis = `${parts} selected — gloss runs only on the Roland LG-640, so this job routes to it.`;
    autoSelection = { status: "gloss_requires_roland", detail: "Gloss forces the Roland." };
    if (printerSelection === "mimaki") {
      reasons.push(ROUTING_REASONS.mimakiGlossUnsupported);
      blockers.push(
        `${ROUTING_REASONS.mimakiGlossUnsupported}: gloss is not operational on the Mimaki UCJV300-130. Route this job to the Roland, or remove the gloss layer(s).`,
      );
    }
  } else if (printerSelection === "roland" || printerSelection === "mimaki") {
    // Operator-explicit assignment wins when compatible (both presses print CMYK and White).
    effectivePrinter = printerSelection;
    overrideApplied = true;
    routingBasis = `${parts} job explicitly routed to the ${printerSelection === "mimaki" ? "Mimaki UCJV300-130" : "Roland LG-640"}.`;
    autoSelection = { status: "explicit", detail: "Operator-selected press." };
  } else {
    const compatible = compatiblePrinters({ whiteLayers, glossLayers });
    const ready = input.costReadyPrinters ? compatible.filter((p) => input.costReadyPrinters!.includes(p)) : compatible;
    // No press is cost-ready: balance among the compatible ones; calibration then blocks.
    const candidates = ready.length ? ready : compatible;
    const choice = selectLessBusyPrinter(candidates, input.machineLoad);
    if (choice.ok) {
      effectivePrinter = choice.printer;
      routingBasis = candidates.length === 1
        ? `AUTO — ${choice.detail}${compatible.length > 1 ? " The other compatible press has no approved cost calibration for this job." : ""}`
        : choice.detail;
      autoSelection = { status: candidates.length === 1 ? "single_eligible" : "load_balanced", detail: choice.detail };
    } else {
      // Never invent a "less busy" press. The job is blocked until a press is
      // chosen; the Mimaki identity below only keeps the result shape and a
      // blocked job never publishes a cost.
      effectivePrinter = "mimaki";
      routingBasis = `AUTO could not choose a press — ${choice.detail}`;
      autoSelection = { status: "unavailable", detail: choice.detail };
      reasons.push(ROUTING_REASONS.autoMachineLoadUnavailable);
      blockers.push(`${ROUTING_REASONS.autoMachineLoadUnavailable}: ${choice.detail}`);
    }
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
          ? "The Mimaki has no operational gloss — gloss is never priced on it."
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
      identity: ALL_CALIBRATION_IDENTITIES[key],
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
    // The white channel's calibration is the ROUTED press's own — Mimaki White
    // never borrows the Roland's mL/sqft or press time.
    const whiteKey: CanonicalCalibrationKey = effectivePrinter === "mimaki" ? "mimaki-white" : "roland-white";
    channels.push({
      kind: "white",
      calibrationKey: whiteKey,
      identity: ALL_CALIBRATION_IDENTITIES[whiteKey],
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
    autoSelection,
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
