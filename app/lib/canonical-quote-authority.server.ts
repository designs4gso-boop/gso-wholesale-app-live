// Patch 2D-4C1 (17D.7C) — CANONICAL TRUE-COST AUTHORITY + HARD SAVE GATE.
//
// For the four in-house manufacturing families the canonical engine supports,
// CANONICAL TRUE MANUFACTURING COST IS THE ONLY COST AUTHORITY:
//
//   stickers-labels · sticker-bags · stock-bags · banners
//
// Commercial selling-price policy (margin curves, floors, market candidates)
// remains a SEPARATE concern and is untouched here. This module decides only
// two things, and it is pure so both can be tested without a database:
//
//   1. WHICH COST a supported family quotes from.
//   2. WHETHER a supported family may become quote-eligible at all.
//
// WHY IT IS ITS OWN MODULE. The 2D-4C audit found the canonical result was
// computed and displayed but never consulted: the legacy run cost still fed
// every margin, tier, READY TO QUOTE decision and the saved Quote.unitCost, and
// a DRAFT_ONLY canonical result could still save a quote. Putting the decision
// in a pure function makes it assertable with deliberately different legacy and
// canonical numbers, so a test cannot pass by accident with the wrong authority.
//
// FAIL-CLOSED, AND NOT OVERRIDABLE. A margin approval or an owner override may
// justify a thin margin; it may never manufacture a missing true cost. The gate
// below is deliberately independent of the commercial margin gate.

import { isCanonicalFamily, type CanonicalFamily } from "./canonical-calculator-shared";
import type { TrueCostStatus } from "./true-cost-engine.server";

export const CANONICAL_QUOTE_AUTHORITY_VERSION = "17D.7C-canonical-quote-authority";

/* ------------------------------------------------------------------ *
 * FAMILY COST MODEL — three kinds, not two.
 *
 * 2D-4C1B. Grouping jars with DTP/Boxes was wrong: they fail for opposite
 * reasons, and treating them alike let a jar quote save on legacy cost.
 *
 *   CANONICAL_COST_AUTHORITY  the canonical engine owns the true cost and it
 *                             is integrated. Usable -> quote from it. Blocked
 *                             -> refuse.
 *   CANONICAL_FAIL_CLOSED     the canonical engine KNOWS this family is not
 *                             costable and says so. Jars block on
 *                             CUTLINE_GEOMETRY_REQUIRED because no owner has
 *                             measured the actual side-label cutlines. That
 *                             blocker is authoritative, so a jar may not quote
 *                             at all — least of all by falling back to the
 *                             legacy cost the blocker exists to reject.
 *   LEGACY_OUTSOURCED         no canonical model exists yet (DTP, Boxes).
 *                             Their existing legacy path is unchanged.
 *
 * The difference between the middle and the last is the whole point: a jar has
 * a canonical verdict and it is "no"; DTP simply has no canonical verdict.
 * ------------------------------------------------------------------ */

export type FamilyCostModel =
  | "CANONICAL_COST_AUTHORITY"
  | "CANONICAL_FAIL_CLOSED"
  | "LEGACY_OUTSOURCED";

/** The four families whose true cost the canonical engine owns. */
export const CANONICAL_SUPPORTED_FAMILIES: CanonicalFamily[] = [
  "stickers-labels",
  "sticker-bags",
  "stock-bags",
  "banners",
  // 2D-4D1 PROMOTED. Every ACTIVE jar profile is now fully costed: verified
  // blank price, artboard geometry, a cutline derived by the GSO -0.0625in
  // rule, media, ink, machine, cutting, weeding, application, setup and a
  // non-null provisional freight. The combinations that were missing costs —
  // miron 3oz/4oz, chiron 50ml/250ml, standard 100ml/150ml/250ml — are not
  // products GSO offers, and jar-active-scope.ts keeps them out of scope
  // rather than pretending they have prices.
  "standard-jars",
  "premium-jars",
];

/**
 * Families with a canonical blocker but no completed canonical integration.
 *
 * A family belongs here when the canonical engine has a verdict about it and
 * that verdict is "not costable yet" — an adapter exists, but something it
 * needs is genuinely unknown. That is different from an outsourced family,
 * which simply has no canonical verdict at all.
 *
 * THE REFUSAL IS ABSOLUTE (2D-4C1C). A fail-closed family refuses regardless
 * of what any canonical result says — VALID, PROVISIONAL, non-null unit cost,
 * zero blockers, anything. That is the entire point of the classification:
 * quote-readiness is an OWNER decision about whether a family's costing is
 * complete and verified, not something a passing arithmetic result may confer
 * on itself. Without this, a future change that happened to make a family's
 * costing return a usable-looking number would silently make it quotable with
 * no one having approved it.
 *
 * PROMOTION IS A DELIBERATE CODE CHANGE. Moving a family from
 * CANONICAL_FAIL_CLOSED to CANONICAL_COST_AUTHORITY means removing it from
 * CANONICAL_FAIL_CLOSED_FAMILIES and adding it to CANONICAL_SUPPORTED_FAMILIES,
 * and it may only happen after ALL of:
 *   1. cutline geometry the owner stands behind exists for the family,
 *   2. its canonical costing passes verification against that geometry,
 *   3. the owner explicitly approves it as quote-ready.
 * Never implementable by accident.
 *
 * THE LIST IS CURRENTLY EMPTY (2D-4D1). Jars were its only members. They were
 * promoted under those three conditions: their cutlines now come from the
 * owner's own -0.0625in offset rule rather than being unmeasured (1), every
 * jar in the active scope was run through a full canonical job with zero
 * blockers and a real unit cost (2), and the owner approved the active jar
 * list and the promotion (3). The mechanism is kept, not deleted — the next
 * family whose canonical verdict is "not costable yet" belongs here.
 */
export const CANONICAL_FAIL_CLOSED_FAMILIES = [] as const;

/**
 * 2D-4D1: EMPTY. Jars were the only entry and they were promoted once their
 * cutlines became derivable and their active scope was pinned down. The
 * mechanism stays — a future family that has a canonical verdict of "not
 * costable yet" belongs here, and the absolute refusal still works.
 */
export const FAIL_CLOSED_REASONS: Record<string, string> = {};

export function familyCostModel(canonicalFamilyKey: string | null | undefined): FamilyCostModel {
  if (isCanonicalFamily(canonicalFamilyKey) &&
      CANONICAL_SUPPORTED_FAMILIES.includes(canonicalFamilyKey as CanonicalFamily)) {
    return "CANONICAL_COST_AUTHORITY";
  }
  if (typeof canonicalFamilyKey === "string" &&
      (CANONICAL_FAIL_CLOSED_FAMILIES as readonly string[]).includes(canonicalFamilyKey)) {
    return "CANONICAL_FAIL_CLOSED";
  }
  return "LEGACY_OUTSOURCED";
}

/** True for a family the canonical engine refuses to let quote at all yet. */
export function isCanonicalFailClosedFamily(canonicalFamilyKey: string | null | undefined): boolean {
  return familyCostModel(canonicalFamilyKey) === "CANONICAL_FAIL_CLOSED";
}

export const AUTHORITY_REASONS = {
  /** Canonical is supported for this family but produced no usable cost. */
  canonicalCostRequired: "CANONICAL_TRUE_COST_REQUIRED",
  /** Canonical is the cost basis for this quote. */
  canonicalAuthority: "CANONICAL_COST_AUTHORITY",
  /** Family is outside the canonical engine — legacy keeps its existing path. */
  notCanonicalFamily: "FAMILY_NOT_CANONICAL",
  /** Family has an authoritative canonical blocker and cannot quote yet. */
  canonicalFailClosed: "CANONICAL_FAMILY_FAIL_CLOSED",
} as const;

/**
 * The minimum shape the authority needs from a canonical result. Deliberately
 * structural rather than importing CanonicalCalculatorResult, so a test can
 * hand-build one and the module stays free of the server calculator.
 */
export type CanonicalCostLike = {
  family: string;
  status: TrueCostStatus;
  unitCost: number | null;
  totalCost: number;
  blockers: string[];
  reasons?: string[];
};

/** Is this UI family one the canonical engine is authoritative for? */
export function isCanonicalSupportedFamily(canonicalFamilyKey: string | null | undefined): boolean {
  return isCanonicalFamily(canonicalFamilyKey) &&
    CANONICAL_SUPPORTED_FAMILIES.includes(canonicalFamilyKey as CanonicalFamily);
}

/**
 * Is a canonical result USABLE as a quote cost?
 *
 * PROVISIONAL is explicitly allowed — a provisional basis (e.g. a cut-path estimate; the machine
 * recovery, the 10% operator attention) is an owner classification, not a
 * defect, and such a job is fully costed. What disqualifies a result is a
 * missing number, not a cautious one.
 *
 * Non-blocking REASONS never disqualify. FREIGHT_NOT_MODELED is a disclosure,
 * not a blocker, and a job carrying it is still quotable.
 */
export function isCanonicalCostUsable(canonical: CanonicalCostLike | null | undefined): boolean {
  if (!canonical) return false;
  if (canonical.status === "DRAFT_ONLY") return false;
  if (canonical.unitCost == null) return false;
  if (!Number.isFinite(canonical.unitCost)) return false;
  if ((canonical.blockers?.length ?? 0) > 0) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Cost authority
 * ------------------------------------------------------------------ */

export type CostAuthorityInput = {
  /** The canonical UI family key, or null when the family is unsupported. */
  canonicalFamilyKey: string | null | undefined;
  /** Canonical result for THIS tier quantity, or null when not computed. */
  canonical: CanonicalCostLike | null | undefined;
  /** Legacy engine job cost for this tier — the pre-2D-4C authority. */
  legacyJobCost: number;
  quantity: number;
  /**
   * Inbound freight for this tier, from the legacy freight resolver.
   *
   * Canonical deliberately reports FREIGHT_NOT_MODELED and carries a $0
   * freight line, so adding this cannot double-count. Freight is inbound
   * logistics, not manufacturing — canonical owning the manufacturing cost
   * does not mean silently dropping a real freight cost the legacy path
   * already resolves. It is kept separate and disclosed.
   */
  freightTotal?: number;
};

/**
 * A COSTED authority — the only shape that carries numbers.
 *
 * Every money field is a real number here, and this variant is only ever
 * produced when a defensible cost exists.
 */
export type CostedAuthority = {
  version: string;
  costed: true;
  authority: "canonical" | "legacy";
  eligible: true;
  /** True manufacturing cost for the job, EXCLUDING inbound freight. */
  manufacturingJobCost: number;
  /** True manufacturing unit cost, EXCLUDING inbound freight. */
  manufacturingUnitCost: number;
  /** Cost basis handed to the commercial pricing policy (incl. freight). */
  completeCost: number;
  /**
   * Per-unit MANUFACTURING cost — what a saved quote records.
   *
   * Deliberately the manufacturing figure, NOT completeCost/qty: freight is
   * commercial logistics and must stay separately identifiable rather than
   * silently inflating the canonical manufacturing unit cost.
   */
  unitCost: number;
  freightTotal: number;
  reasons: string[];
  blockers: string[];
  basis: string;
};

/**
 * A BLOCKED authority — structurally non-costed.
 *
 * FIX 1 (2D-4C1A). The owner rule is global: DRAFT_ONLY must NEVER become a
 * $0 true cost. The previous shape returned zeros and relied on downstream
 * gates to stop them escaping; a zero that merely "should not be used" is one
 * refactor away from being used. These fields are `null`, so any arithmetic
 * on them produces NaN rather than a plausible-looking free job, and the
 * discriminant `costed: false` makes the numeric case unreachable by type.
 */
export type BlockedAuthority = {
  version: string;
  costed: false;
  authority: "canonical";
  eligible: false;
  manufacturingJobCost: null;
  manufacturingUnitCost: null;
  completeCost: null;
  unitCost: null;
  freightTotal: number;
  reasons: string[];
  blockers: string[];
  basis: string;
};

export type CostAuthorityResult = CostedAuthority | BlockedAuthority;

/** Narrow to the costed variant before touching any money field. */
export function isCostedAuthority(result: CostAuthorityResult): result is CostedAuthority {
  return result.costed === true;
}

/**
 * Decide the cost basis for one tier.
 *
 * Supported family + usable canonical -> canonical is the authority.
 * Supported family + unusable canonical -> NOT eligible, and the legacy cost
 *   is never promoted to fill the gap.
 * Unsupported family -> legacy keeps its existing behaviour, unchanged.
 */
export function resolveCostAuthority(input: CostAuthorityInput): CostAuthorityResult {
  const quantity = Math.max(0, Math.floor(input.quantity));
  const freightTotal = Number.isFinite(input.freightTotal) ? Number(input.freightTotal) : 0;
  const model = familyCostModel(input.canonicalFamilyKey);
  const supported = model === "CANONICAL_COST_AUTHORITY";
  const perUnit = (total: number) => (quantity > 0 ? total / quantity : total);

  // A FAIL-CLOSED family (jars) has an authoritative canonical blocker and is
  // never costed — not from the legacy engine, and not from a canonical result
  // that happens to look usable. The check is UNCONDITIONAL on purpose: a
  // family becomes quotable by owner promotion, never by an arithmetic result
  // promoting itself.
  if (model === "CANONICAL_FAIL_CLOSED") {
    const blocker = FAIL_CLOSED_REASONS[String(input.canonicalFamilyKey)] || "CANONICAL_BLOCKER";
    return {
      version: CANONICAL_QUOTE_AUTHORITY_VERSION,
      costed: false,
      authority: "canonical",
      eligible: false,
      manufacturingJobCost: null,
      manufacturingUnitCost: null,
      completeCost: null,
      unitCost: null,
      freightTotal,
      reasons: [AUTHORITY_REASONS.canonicalFailClosed, blocker],
      blockers: [
        `${AUTHORITY_REASONS.canonicalFailClosed}: "${String(input.canonicalFamilyKey)}" has an authoritative canonical blocker (${blocker}) and no completed canonical costing, so it has NO defensible true cost. The legacy engine's cost is NOT a substitute — that substitution is what the blocker forbids.`,
        ...(input.canonical?.blockers ?? []),
      ],
      basis: `Fail-closed family: canonical reports ${blocker}. No cost is published and no price may be derived.`,
    };
  }

  if (!supported) {
    const manufacturing = input.legacyJobCost;
    return {
      version: CANONICAL_QUOTE_AUTHORITY_VERSION,
      costed: true,
      authority: "legacy",
      eligible: true, // unchanged legacy behaviour — the commercial gate still applies
      manufacturingJobCost: manufacturing,
      manufacturingUnitCost: perUnit(manufacturing),
      completeCost: manufacturing + freightTotal,
      unitCost: perUnit(manufacturing),
      freightTotal,
      reasons: [AUTHORITY_REASONS.notCanonicalFamily],
      blockers: [],
      basis: "Family is outside the canonical in-house manufacturing model; the legacy engine keeps its existing authority and behaviour.",
    };
  }

  if (!isCanonicalCostUsable(input.canonical)) {
    const detail = !input.canonical
      ? "no canonical result was produced"
      : input.canonical.status === "DRAFT_ONLY"
        ? `canonical status is DRAFT_ONLY (${input.canonical.blockers.length} blocker(s))`
        : input.canonical.unitCost == null
          ? "canonical unit cost is null"
          : `canonical carries ${input.canonical.blockers.length} blocker(s)`;
    return {
      version: CANONICAL_QUOTE_AUTHORITY_VERSION,
      costed: false,
      authority: "canonical",
      eligible: false,
      // NEVER zero — a blocked job has no cost, and null cannot masquerade as free.
      manufacturingJobCost: null,
      manufacturingUnitCost: null,
      completeCost: null,
      unitCost: null,
      freightTotal,
      reasons: [AUTHORITY_REASONS.canonicalCostRequired],
      blockers: [
        `${AUTHORITY_REASONS.canonicalCostRequired}: this family quotes from canonical true manufacturing cost, and ${detail}. The legacy engine's cost is NOT a substitute — resolve the canonical blockers before quoting.`,
        ...(input.canonical?.blockers ?? []),
      ],
      basis: "Canonical true cost is unusable, so this job has NO cost — not a zero one. Legacy cost is deliberately not promoted and no price may be derived.",
    };
  }

  const canonical = input.canonical!;
  return {
    version: CANONICAL_QUOTE_AUTHORITY_VERSION,
    costed: true,
    authority: "canonical",
    eligible: true,
    manufacturingJobCost: canonical.totalCost,
    manufacturingUnitCost: canonical.unitCost!,
    completeCost: canonical.totalCost + freightTotal,
    // The MANUFACTURING unit cost, not (manufacturing + freight)/qty.
    unitCost: canonical.unitCost!,
    freightTotal,
    reasons: [AUTHORITY_REASONS.canonicalAuthority, ...(canonical.reasons ?? [])],
    blockers: [],
    basis: `Canonical true manufacturing cost (${canonical.status}) is the cost basis: ${canonical.totalCost.toFixed(6)} job / ${canonical.unitCost!.toFixed(6)} unit${freightTotal > 0 ? `. Inbound freight ${freightTotal.toFixed(2)} is added to the COMMERCIAL basis only and is kept separately identifiable — it never mutates the manufacturing unit cost.` : "."}`,
  };
}

/* ------------------------------------------------------------------ *
 * The hard save gate
 * ------------------------------------------------------------------ */

export type SaveGateInput = {
  canonicalFamilyKey: string | null | undefined;
  canonical: CanonicalCostLike | null | undefined;
};

export type SaveGateResult = {
  allowed: boolean;
  /** True when this decision is the canonical gate's, not the legacy gate's. */
  enforced: boolean;
  reason: string;
  blockers: string[];
};

/**
 * MAY THIS QUOTE BE SAVED?
 *
 * Deliberately INDEPENDENT of the commercial margin gate. A margin approval or
 * an owner override phrase justifies a thin margin; it can never justify a
 * missing true cost. The route must consult this BEFORE db.quote.create and
 * refuse outright — not merely disable a button, which a crafted POST ignores.
 *
 * Unsupported families are untouched: allowed = true, enforced = false, so the
 * existing legacy gates remain the only decision for them.
 */
export function canonicalSaveGate(input: SaveGateInput): SaveGateResult {
  const model = familyCostModel(input.canonicalFamilyKey);

  // LEGACY / OUTSOURCED (DTP, Boxes, genuinely unsupported): untouched.
  if (model === "LEGACY_OUTSOURCED") {
    return {
      allowed: true,
      enforced: false,
      reason: `${AUTHORITY_REASONS.notCanonicalFamily}: family is outside the canonical model; existing legacy save behaviour applies unchanged.`,
      blockers: [],
    };
  }

  // FAIL-CLOSED (jars) is checked FIRST and refuses unconditionally — before
  // any "is the result usable" question is asked. A usable-looking canonical
  // result must never implicitly promote an unapproved family.
  if (model === "CANONICAL_FAIL_CLOSED") {
    const blocker = FAIL_CLOSED_REASONS[String(input.canonicalFamilyKey)] || "CANONICAL_BLOCKER";
    return {
      allowed: false,
      enforced: true,
      reason:
        `${AUTHORITY_REASONS.canonicalFailClosed}: refusing to save — "${String(input.canonicalFamilyKey)}" is fail-closed on ${blocker}. ` +
        `This family is not owner-approved as quote-ready: its costing is incomplete until actual cutline geometry is measured and it is deliberately promoted. ` +
        `No canonical result — VALID, PROVISIONAL or otherwise — can make it quotable, and neither the legacy cost nor a margin approval can substitute.`,
      blockers: input.canonical?.blockers ?? [],
    };
  }

  // A usable canonical result allows the save for CANONICAL_COST_AUTHORITY.
  if (isCanonicalCostUsable(input.canonical)) {
    return {
      allowed: true,
      enforced: true,
      reason: `${AUTHORITY_REASONS.canonicalAuthority}: canonical true cost is usable (${input.canonical!.status}, ${input.canonical!.unitCost!.toFixed(6)}/unit, 0 blockers).`,
      blockers: [],
    };
  }

  // CANONICAL_COST_AUTHORITY with an unusable result.
  // (FAIL-CLOSED already returned above, unconditionally.)
  const canonical = input.canonical;
  const detail = !canonical
    ? "no canonical result was produced for this job"
    : canonical.status === "DRAFT_ONLY"
      ? "the canonical true cost is DRAFT_ONLY"
      : canonical.unitCost == null
        ? "the canonical true unit cost is null"
        : "the canonical true cost carries blockers";

  return {
    allowed: false,
    enforced: true,
    reason:
      `${AUTHORITY_REASONS.canonicalCostRequired}: refusing to save — ${detail}. ` +
      `This family quotes from canonical true manufacturing cost only; the legacy engine's cost is not a substitute, ` +
      `and a margin approval or override cannot supply a missing cost.`,
    blockers: canonical?.blockers ?? [],
  };
}

/* ------------------------------------------------------------------ *
 * The quote-save boundary
 *
 * FIX 3 (2D-4C1A). The gate ordering was previously proven only by reading
 * the route's source. That is not adequate evidence for a production write
 * safety defect, so the decision-plus-write is extracted here behind an
 * injected `createQuote`. The real action calls THIS function, and a test can
 * pass a spy and assert the create ran zero times.
 *
 * This function is reached ONLY after the commercial margin gate has already
 * allowed the save, so calling it in a test is exactly the "margin/override
 * would otherwise permit it" scenario. It takes no margin input at all —
 * that is the structural guarantee that an approval cannot override a missing
 * true cost, or a fail-closed family's blocker.
 * ------------------------------------------------------------------ */

export type QuoteSaveDecisionInput = {
  canonicalFamilyKey: string | null | undefined;
  /** Canonical result at the job's base quantity. */
  baseCanonical: CanonicalCostLike | null | undefined;
  /** Canonical result at the SELECTED tier's quantity — the row persisted. */
  selectedCanonical: CanonicalCostLike | null | undefined;
  selectedQuantity: number;
  /** The selected tier row's own blocked flag, whatever produced it. */
  selectedTierDraftOnly?: boolean;
};

export type QuoteSaveOutcome<T> =
  | { ok: true; created: T }
  | { ok: false; canonicalBlocked: true; message: string; blockers: string[] };

/**
 * Refuse or perform the quote write.
 *
 * Both quantities are gated: a base job can be costable while the selected
 * rung is not (a Stock Bag ladder crossing below its 50-unit MOQ is the live
 * example), and the row that gets persisted is the selected one.
 *
 * A FAIL-CLOSED family (jars) is refused on both, because its canonical
 * verdict is that it has no defensible cost at all.
 */
export async function persistQuoteIfCanonicalAllows<T>(
  decision: QuoteSaveDecisionInput,
  createQuote: () => Promise<T>,
): Promise<QuoteSaveOutcome<T>> {
  const baseGate = canonicalSaveGate({
    canonicalFamilyKey: decision.canonicalFamilyKey,
    canonical: decision.baseCanonical,
  });
  if (!baseGate.allowed) {
    return { ok: false, canonicalBlocked: true, message: baseGate.reason, blockers: baseGate.blockers };
  }

  const selectedGate = canonicalSaveGate({
    canonicalFamilyKey: decision.canonicalFamilyKey,
    canonical: decision.selectedCanonical,
  });
  if (!selectedGate.allowed) {
    return {
      ok: false,
      canonicalBlocked: true,
      message: `Selected tier ${decision.selectedQuantity}: ${selectedGate.reason}`,
      blockers: selectedGate.blockers,
    };
  }

  // Belt and braces: whatever marked the row blocked, honour it. Applies to
  // BOTH canonical models — only genuinely legacy/outsourced jobs skip it.
  if (familyCostModel(decision.canonicalFamilyKey) !== "LEGACY_OUTSOURCED" && decision.selectedTierDraftOnly) {
    return {
      ok: false,
      canonicalBlocked: true,
      message: `Selected tier ${decision.selectedQuantity} is BLOCKED and cannot be quoted.`,
      blockers: selectedGate.blockers,
    };
  }

  return { ok: true, created: await createQuote() };
}
