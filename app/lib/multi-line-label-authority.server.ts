// Patch 2D-4E1 (October 2026) — MULTI-LINE LABEL JOBS QUOTE FROM CANONICAL COST.
//
// THE BUG THIS CLOSES. A multi-line sticker/label job (Line 1 + additional
// lines) was combined by `combineStickerLines` from per-line LEGACY engine
// runs. The canonical save gate still refused an unusable job, but when the
// canonical result WAS usable the number persisted to Quote.unitCost — and
// the one shown to staff as "Job cost" — was still the legacy total. For a
// CANONICAL_COST_AUTHORITY family that is a direct violation of the owner
// rule: canonical manufacturing cost is the only cost authority.
//
// WHAT THIS MODULE DOES. One pure function decides the multi-line job from
// the canonical result:
//
//   manufacturing jobCost / unitCost / status / blockers  <- canonical only
//   commercial selling price                              <- the EXISTING
//     per-line researched-band policy (combineStickerLines), unchanged, but
//     fed the canonical cost instead of the legacy cost.
//
// COMMERCIAL ALLOCATION, STATED PLAINLY. The per-line band policy needs a
// cost per line, and the canonical engine prices the job (ink, press,
// cutting, weeding, setup, packout are job-level lines). The canonical JOB
// total is therefore allocated across the physical lines by each line's own
// canonical nested material footprint (sqft), falling back to quantity when
// a footprint is unavailable. This allocation exists ONLY so the commercial
// policy can price each line on its own quantity band; it never changes the
// manufacturing total, which stays exactly the canonical figure. Nothing is
// redistributed between the ENTERED QUANTITIES — those are preserved as typed.
//
// FAIL-CLOSED. No canonical result, a DRAFT_ONLY result, a null unit cost,
// any canonical blocker, any line field error, or any legacy `missing`
// reason -> the job is BLOCKED: every money field is null, never $0, and the
// route refuses the save.

import { combineStickerLines, type PricingPolicyValues } from "./commercial-pricing-policy.server";
import type { FamilyMarginRule } from "./calculator-emergency.server";
import {
  isCostedAuthority,
  resolveCostAuthority,
  type CanonicalCostLike,
  type CostAuthorityResult,
} from "./canonical-quote-authority.server";

export const MULTI_LINE_LABEL_AUTHORITY_VERSION = "17D.8A-multi-line-label-authority";

/** The per-line shape the route already builds for the legacy combiner. */
export type MultiLineLegacyLine = {
  lineNumber: number;
  name: string;
  quantity: number;
  designs: number;
  glossOrWhite: boolean;
  /** Legacy engine line cost — DIAGNOSTIC ONLY here; never a cost basis. */
  lineCost: number;
  missing: string[];
  fieldErrors?: string[];
  finishedSqft?: number;
  setupTotal?: number;
};

/** Minimum canonical shape this module reads (structural, test-buildable). */
export type CanonicalLabelLineLike = {
  key: string;
  quantity: number;
  nesting: { materialFootprintSqft: number } | null;
  materialCost: number;
};

export type CanonicalLabelJobLike = CanonicalCostLike & {
  adapter?: { label?: { lines: CanonicalLabelLineLike[] } | null } | null;
};

export type MultiLineAllocation = {
  basis: "canonical_material_footprint" | "quantity";
  note: string;
  perLine: Array<{ lineNumber: number; name: string; weight: number; share: number; allocatedCost: number }>;
};

export type MultiLineCanonicalQuote = {
  version: string;
  costAuthority: "canonical" | "blocked";
  authority: CostAuthorityResult;
  /** Commercially priced lines (combineStickerLines shape). Empty when blocked. */
  lines: ReturnType<typeof combineStickerLines>["lines"];
  totalQuantity: number;
  /** Canonical manufacturing JOB cost. null when blocked — never 0. */
  totalCost: number | null;
  /** Canonical manufacturing UNIT cost. null when blocked — never 0. */
  unitCost: number | null;
  finalTotalPrice: number | null;
  achievedProfit: number | null;
  achievedMarginPct: number | null;
  controllingRule: string;
  allocation: MultiLineAllocation | null;
  blockers: string[];
  reasons: string[];
};

export const MULTI_LINE_REASONS = {
  canonicalAllocation: "MULTI_LINE_COMMERCIAL_ALLOCATION_CANONICAL",
  lineIncomplete: "MULTI_LINE_INCOMPLETE",
} as const;

/** Canonical line key for a 1-based form line number (pl0 == Line 1). */
export function canonicalLineKeyFor(lineNumber: number): string {
  return `line-${Math.max(0, Math.floor(lineNumber) - 1)}`;
}

/**
 * Allocate a canonical job total across physical lines for the COMMERCIAL
 * band policy. Sums to `jobTotal` exactly (last line absorbs rounding).
 */
export function allocateCanonicalJobCost(
  jobTotal: number,
  lines: Array<{ lineNumber: number; name: string; quantity: number }>,
  canonicalLines: CanonicalLabelLineLike[],
): MultiLineAllocation {
  const footprints = lines.map((line) => {
    const match = canonicalLines.find((c) => c.key === canonicalLineKeyFor(line.lineNumber));
    const sqft = match?.nesting?.materialFootprintSqft;
    return typeof sqft === "number" && Number.isFinite(sqft) && sqft > 0 ? sqft : null;
  });
  const useFootprint = footprints.length > 0 && footprints.every((f) => f != null);
  const weights = useFootprint
    ? (footprints as number[])
    : lines.map((line) => Math.max(0, Math.floor(line.quantity)));
  const weightSum = weights.reduce((sum, w) => sum + w, 0);

  let assigned = 0;
  const perLine = lines.map((line, index) => {
    const share = weightSum > 0 ? weights[index] / weightSum : 1 / Math.max(1, lines.length);
    const isLast = index === lines.length - 1;
    const allocatedCost = isLast ? jobTotal - assigned : jobTotal * share;
    assigned += allocatedCost;
    return { lineNumber: line.lineNumber, name: line.name, weight: weights[index], share, allocatedCost };
  });

  return {
    basis: useFootprint ? "canonical_material_footprint" : "quantity",
    note: useFootprint
      ? "Canonical job cost allocated to lines by each line's canonical nested material footprint (sqft) — commercial band pricing only; the manufacturing total is the unallocated canonical figure."
      : "Canonical job cost allocated to lines by entered quantity (a line had no canonical footprint) — commercial band pricing only; the manufacturing total is the unallocated canonical figure.",
    perLine,
  };
}

function blockedQuote(
  authority: CostAuthorityResult,
  totalQuantity: number,
  blockers: string[],
  reasons: string[],
): MultiLineCanonicalQuote {
  return {
    version: MULTI_LINE_LABEL_AUTHORITY_VERSION,
    costAuthority: "blocked",
    authority,
    lines: [],
    totalQuantity,
    totalCost: null,
    unitCost: null,
    finalTotalPrice: null,
    achievedProfit: null,
    achievedMarginPct: null,
    controllingRule: "BLOCKED — no canonical true manufacturing cost; no price may be derived.",
    allocation: null,
    blockers: Array.from(new Set(blockers)),
    reasons: Array.from(new Set(reasons)),
  };
}

/**
 * Decide a multi-line label job from the canonical result.
 *
 * `canonical` is the canonical result for the job AS ENTERED (every line).
 * `lines` are the ACTIVE legacy per-line records the route already builds —
 * used for names, flags, field errors and the commercial band structure, and
 * NEVER for cost.
 */
export function resolveMultiLineLabelQuote(input: {
  lines: MultiLineLegacyLine[];
  canonical: CanonicalLabelJobLike | null | undefined;
  marginRule: FamilyMarginRule | null;
  policyValues?: PricingPolicyValues;
  freightTotal?: number;
}): MultiLineCanonicalQuote {
  const lines = input.lines;
  const totalQuantity = lines.reduce((sum, line) => sum + Math.max(0, Math.floor(line.quantity)), 0);

  // Line-level completeness blockers (never silently dropped).
  const lineBlockers = lines.flatMap((line) => {
    const errors = line.fieldErrors && line.fieldErrors.length
      ? line.fieldErrors
      : line.quantity > 0 ? [] : ["Quantity is required (must be greater than 0)."];
    return errors.map((reason) => `${line.name}: ${reason}`);
  });
  const legacyMissing = lines.flatMap((line) => (line.missing || []).map((reason) => `${line.name}: ${reason}`));

  const authority = resolveCostAuthority({
    canonicalFamilyKey: "stickers-labels",
    canonical: input.canonical ?? null,
    legacyJobCost: lines.reduce((sum, line) => sum + (Number.isFinite(line.lineCost) ? line.lineCost : 0), 0),
    quantity: totalQuantity,
    freightTotal: input.freightTotal ?? 0,
  });

  const reasons = [...authority.reasons];
  if (lineBlockers.length) reasons.push(MULTI_LINE_REASONS.lineIncomplete);

  if (!isCostedAuthority(authority) || lineBlockers.length || legacyMissing.length || totalQuantity <= 0) {
    return blockedQuote(
      authority,
      totalQuantity,
      [...lineBlockers, ...legacyMissing, ...authority.blockers],
      reasons,
    );
  }

  // Costed: the canonical manufacturing job cost is the commercial cost basis.
  const canonicalLines = input.canonical?.adapter?.label?.lines ?? [];
  const allocation = allocateCanonicalJobCost(authority.manufacturingJobCost, lines, canonicalLines);
  const combined = combineStickerLines({
    lines: lines.map((line, index) => ({
      name: line.name,
      quantity: line.quantity,
      designs: line.designs,
      glossOrWhite: line.glossOrWhite,
      lineCost: allocation.perLine[index].allocatedCost,
      missing: [],
      fieldErrors: [],
      finishedSqft: line.finishedSqft,
      setupTotal: line.setupTotal,
    })),
    // Packout is already INSIDE the canonical job total; nothing is added twice.
    jobPackingCost: 0,
    marginRule: input.marginRule,
    policyValues: input.policyValues,
  });
  reasons.push(MULTI_LINE_REASONS.canonicalAllocation);

  // The commercial policy's job-level minimums may lift the price; they never
  // touch the manufacturing figures, which stay exactly canonical.
  const finalTotalPrice = combined.finalTotalPrice;
  const achievedProfit = finalTotalPrice - authority.manufacturingJobCost;
  const achievedMarginPct = finalTotalPrice > 0 ? (achievedProfit / finalTotalPrice) * 100 : 0;

  return {
    version: MULTI_LINE_LABEL_AUTHORITY_VERSION,
    costAuthority: "canonical",
    authority,
    lines: combined.lines,
    totalQuantity,
    totalCost: authority.manufacturingJobCost,
    unitCost: authority.manufacturingUnitCost,
    finalTotalPrice,
    achievedProfit,
    achievedMarginPct,
    controllingRule: `${combined.controllingRule} — cost basis: canonical true manufacturing cost`,
    allocation,
    blockers: [...combined.blockers],
    reasons: Array.from(new Set(reasons)),
  };
}
