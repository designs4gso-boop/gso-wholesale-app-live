// Patch 2D-2 (17D.6) — ONE physical manufacturing adapter for the 4x5 bag
// process, shared by BOTH products that use it:
//
//   sticker_bag_4x5  customer artwork, normal art + print setup
//   stock_bag        premade GSO artwork, NO new-customer-art charge, MOQ 50
//
// Every PHYSICAL line — blank, media, ink, nesting, print occupancy, print
// operator attention, cutting, cut recovery, cut attention, weeding,
// application — comes from this one file, so the two products can never drift
// apart physically. Only setup/art/product rules differ.
//
// NO ZAKEKE. Stock Bag costing has no Zakeke dependency of any kind.
//
// Pure: no db, no network, no clock.

import { deriveGsoLabelCutlineFromArtboard } from "./gso-cutline";
import { computeNesting, resolveNestingPolicy, type NestingResult, type NestingRun } from "./nesting-engine.server";
import { computeFinishing, type CutGeometryMap, type CutMode, type FinishingResult } from "./finishing-cost.server";
import { computeLabelApplication, type LabelApplicationResult } from "./label-application.server";
import { SETUP_BASIS, type CostBasis } from "./true-cost-engine.server";
import { OWNER_STANDARDS } from "./owner-standards";

export const BAG_COST_INPUTS_VERSION = "17D.6-bag-cost-inputs";

/* ------------------------------------------------------------------ *
 * OWNER DECISION 1 — blank 4x5 bag: $0.11 EACH (OWNER DECISION 2026-10-08)
 *
 * TRUE BASE COST: $0.11 each, regardless of bag colour. Effective 2026-10-08.
 * This is the ONE current authority for the 4x5 blank; the Material row, the
 * VendorProduct preset:blank-4x5-bag, the calculator preset, Approved Cost
 * Updates, Cost Health / Cost Verification and this constant all carry it.
 *
 * SUPERSEDED 2026-10-08: the 2D-4C2D rule "$0.09 supplier base BEFORE inbound
 * freight (owner-corrected 2026-08-24)". The repo briefly held two competing
 * authorities (an earlier handoff said $0.11, production stayed $0.09, a later
 * decision moved canonical back to $0.09); the owner resolved the conflict on
 * 2026-10-08 in favour of $0.11. $0.09 is never charged anywhere current.
 *
 * NO GENERIC FREIGHT UPLIFT is added on top of $0.11. Blank bags ship on the
 * SAME pallet method from the SAME supplier as jars (never Southwest Cargo,
 * which applies only to outsourced DTP bags and boxes). No separate verified
 * freight policy exists, so the inbound_freight component stays $0 and is
 * disclosed as FREIGHT_NOT_MODELED rather than invented.
 *
 * Carton data recorded for that future allocation, unused today:
 *   coloured     1,000/carton, 12.5 x 9.5 x 10 in, 10 lb gross
 *   white/black  2,000/carton, 23.5 x 13 x 9 in,   29 lb gross
 * ------------------------------------------------------------------ */
export const BAG_4X5_BLANK_UNIT_COST = 0.11;
export const BAG_4X5_BLANK_SOURCE = "Owner decision 2026-10-08: 4x5 blank bag true base cost $0.11 each, regardless of colour (supersedes the 2026-08-24 $0.09-before-freight rule). No generic freight uplift is added; inbound freight stays a separate, not-yet-modelled component.";
export const BAG_4X5_BLANK_EFFECTIVE_DATE = "2026-10-08";

/**
 * SUPERSEDED 2026-10-08. The 2026-08-24 "$0.09 supplier base before inbound
 * freight" figure. Kept only so a test can prove it is never charged again.
 */
export const BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24 = 0.09;

/**
 * Carton facts for the future pallet-freight allocator. Recorded, not priced —
 * nothing here participates in any cost today.
 */
export const BAG_4X5_CARTON_FACTS = {
  coloured: { bagsPerCarton: 1000, cartonIn: { l: 12.5, w: 9.5, h: 10 }, grossLb: 10 },
  whiteBlack: { bagsPerCarton: 2000, cartonIn: { l: 23.5, w: 13, h: 9 }, grossLb: 29 },
  inboundMethod: "Same supplier and same pallet inbound method as jars. NOT Southwest Cargo — that applies only to outsourced DTP bags and boxes.",
} as const;

/* ------------------------------------------------------------------ *
 * OWNER DECISION 2 — application
 *
 * 10 seconds per APPLIED SIDE at the canonical $20/hr. This SUPERSEDES the
 * 15G.2A 256-labels/hour standard ($0.078125/label) for the 4x5 bag process.
 *   1 side  -> 10s -> $0.0555555556
 *   2 sides -> 20s -> $0.1111111111
 * ------------------------------------------------------------------ */
export const BAG_APPLICATION_SECONDS_PER_SIDE = 10;
export const BAG_APPLICATION_LABOR_RATE_PER_HOUR = 20;
/** Recorded so a test can prove the retired rate is never used as a cost. */
export const BAG_APPLICATION_RETIRED_LABELS_PER_HOUR = 256;

/* ------------------------------------------------------------------ *
 * Geometry — ARTBOARD drives printing/nesting, CUTLINE drives the cutter.
 * ------------------------------------------------------------------ */
// 2026-10-05: value moved verbatim to the client-safe bag-artboard-geometry.ts
// so the product-spec layer can read it; re-exported here unchanged.
import { BAG_4X5_ARTBOARD_IN } from "./bag-artboard-geometry";
export { BAG_4X5_ARTBOARD_IN };
/**
 * 2D-4C2A: DERIVED, not hand-recorded. The GSO standard builds every label's
 * cutline from its artboard with a -0.0625in inward offset, so a 4.00 x 5.00in
 * bag label cuts at 3.875 x 4.875in. The previous literal 3.79 x 4.81 predated
 * that rule and is gone — a second cutline authority is exactly what the rule
 * exists to prevent.
 */
const BAG_4X5_CUT = deriveGsoLabelCutlineFromArtboard(BAG_4X5_ARTBOARD_IN.widthIn, BAG_4X5_ARTBOARD_IN.heightIn)!;
export const BAG_4X5_CUTLINE_IN = { widthIn: BAG_4X5_CUT.cutWidthIn, heightIn: BAG_4X5_CUT.cutHeightIn } as const;

export const STOCK_BAG_MOQ = 50;
/**
 * 2D-4E2 — OWNER VERIFIED: custom 4x5 Sticker Bags carry the same 50-unit
 * minimum as Stock Bags. Until October 2026 this lived only in the storefront
 * commercial layer; the canonical manufacturing engine now enforces it as an
 * ELIGIBILITY blocker. It is deliberately NOT part of material consumption —
 * 49 bags still nest, cut and apply as 49; the job is simply not quotable.
 */
export const STICKER_BAG_MOQ = 50;
export const BAG_DEFAULT_MEDIA_WIDTH_IN = 54;
export const BAG_DEFAULT_MACHINE_KEY = "mimaki-ucjv300-130";
export const BAG_DEFAULT_CUT_MODE: CutMode = "normal";

export const BAG_REASONS = {
  stockBagBelowMoq: "STOCK_BAG_BELOW_MOQ",
  /** 2D-4E2: custom 4x5 sticker bags below the owner-verified 50-unit MOQ. */
  stickerBagBelowMoq: "STICKER_BAG_BELOW_MOQ",
  bagBlankCostRequired: "BAG_BLANK_COST_REQUIRED",
  /**
   * personalizedDesignCount must be a positive integer when supplied.
   *
   * 2D-3C RETIRED STOCK_BAG_PERSONALIZATION_RATE_REQUIRED. Normal logo/QR
   * placement now uses the already-verified canonical art setup standard, so
   * there is no missing owner duration left to block on. This is the only
   * personalization reason code that remains.
   */
  stockBagPersonalizedDesignCountInvalid: "STOCK_BAG_PERSONALIZED_DESIGN_COUNT_INVALID",
} as const;

/* ------------------------------------------------------------------ *
 * 2D-3B OWNER RULE — personalization is SETUP, not application
 *
 * Placing a supplied logo and/or QR onto the premade Stock Bag design is a
 * ONE-TIME ART/SETUP EVENT PER PERSONALIZED DESIGN. It is NOT a per-bag
 * physical operation, so bag quantity must never multiply it:
 *
 *   50 bags / 1 personalized design    -> 1 setup event
 *   500 bags / 1 personalized design   -> 1 setup event
 *   5000 bags / 1 personalized design  -> 1 setup event
 *   500 bags / 2 personalized designs  -> 2 setup events
 *
 * logo-only, QR-only and logo+QR share ONE basis AND ONE rate. The individual
 * flags stay informational; they never fork the cost model.
 *
 * 2D-3C OWNER DECISION - no separate personalization standard is invented.
 * A personalized design is ONE NORMAL ART SETUP EVENT, priced at the existing
 * canonical OWNER_STANDARDS.artSetupPerDesign ($25/hr at 3 designs/hr =
 * $8.3333333333). Internal true cost therefore captures the labor while the
 * customer-facing add-on stays exactly $0.
 *
 * This is deliberately kept apart from PHYSICAL LABEL APPLICATION, which
 * genuinely scales: 1000 bags x 2 labelled sides = 2000 application events.
 * ------------------------------------------------------------------ */

/** Owner decision: normal logo/QR personalization is FREE to the customer. */
export const BAG_PERSONALIZATION_CUSTOMER_ADD_ON = 0;

/** ONE setup event per personalized design — never a copy count. */
export const BAG_PERSONALIZATION_BASIS: CostBasis = "PER_DESIGN";

/**
 * What "normal" personalization covers. Artwork REPAIR — vector recreation,
 * major cleanup, rebuilding or substantially redesigning customer graphics —
 * is separate artwork work under the normal artwork costing rules and is
 * deliberately NOT folded in here at any rate.
 */
export const BAG_PERSONALIZATION_SCOPE =
  "Placement/sizing of USABLE supplied artwork (logo and/or QR) on the premade GSO Stock Bag design. Does NOT include vector recreation, major cleanup, rebuilding artwork, substantial redesign or recreating customer graphics — those are separate artwork work under the normal artwork costing rules.";

/**
 * ONE normal art setup event per personalized design - the SAME canonical
 * standard every other design event uses. Nothing new is invented and no
 * duration is guessed: $25/hr at 3 designs/hr is already owner-verified.
 */
export const BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN = OWNER_STANDARDS.artSetupPerDesign.value;

export const BAG_PERSONALIZATION_BASIS_NOTE =
  "One normal art setup event per personalized design at OWNER_STANDARDS.artSetupPerDesign ($25/hr at 3 designs/hr = $8.3333333333). Bag quantity, label quantity, printed sides, application events and production quantity are ALL excluded - none of them multiplies this cost. Customer-facing add-on is $0; this is internal true cost only.";

export type BagProduct = "sticker_bag_4x5" | "stock_bag";
export type BagSides = 1 | 2;

export type BagPersonalization = {
  logo?: boolean;
  qr?: boolean;
  /**
   * Distinct personalized DESIGNS in this job — never a bag count.
   * Omitted while active defaults to 1, matching `designs` elsewhere.
   */
  personalizedDesignCount?: number;
};

export type BagPersonalizationResult = {
  /** NONE / PERSONALIZED — the only two cost-relevant states. */
  mode: "NONE" | "PERSONALIZED";
  active: boolean;
  /** Informational only. Neither flag forks the cost basis. */
  logo: boolean;
  qr: boolean;
  /** = personalizedDesignCount when active, 0 when not. NEVER bagQuantity. */
  setupEvents: number;
  basis: CostBasis;
  /** Internal true cost = setupEvents x $8.3333333333. Never a copy count. */
  internalSetupCost: number;
  /** The per-design rate actually used. */
  ratePerDesign: number;
  /** NONE = nothing selected. VERIFIED = costed on the canonical art standard. */
  internalCostStatus: "NONE" | "VERIFIED";
  /** Owner decision: always $0. Internal cost never becomes a surcharge. */
  customerAddOn: number;
  scope: string;
  basisNote: string;
  reasons: string[];
  blockers: string[];
};

/**
 * Personalization setup events, on a strictly PER_DESIGN basis.
 *
 * `bagQuantity` is accepted ONLY so the returned note can state plainly that
 * it was not used. It never enters the arithmetic.
 */
export function computeBagPersonalization(
  personalization: BagPersonalization | undefined,
  bagQuantity: number,
): BagPersonalizationResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const logo = Boolean(personalization?.logo);
  const qr = Boolean(personalization?.qr);
  const active = logo || qr;

  if (!active) {
    return {
      mode: "NONE",
      active: false,
      logo: false,
      qr: false,
      setupEvents: 0,
      basis: BAG_PERSONALIZATION_BASIS,
      internalSetupCost: 0,
      ratePerDesign: BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN,
      internalCostStatus: "NONE",
      customerAddOn: BAG_PERSONALIZATION_CUSTOMER_ADD_ON,
      scope: BAG_PERSONALIZATION_SCOPE,
      basisNote: "No personalization selected - the base premade Stock Bag artwork carries no art setup at all.",
      reasons,
      blockers,
    };
  }

  const supplied = personalization?.personalizedDesignCount;
  let setupEvents = 1;
  if (supplied != null) {
    const n = Number(supplied);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      reasons.push(BAG_REASONS.stockBagPersonalizedDesignCountInvalid);
      blockers.push(`${BAG_REASONS.stockBagPersonalizedDesignCountInvalid}: personalizedDesignCount must be a positive integer - the number of distinct personalized artwork/design setup events, NOT a bag count (bagQuantity here is ${bagQuantity}); received ${JSON.stringify(supplied)}.`);
    } else {
      setupEvents = n;
    }
  }

  return {
    mode: "PERSONALIZED",
    active: true,
    logo,
    qr,
    setupEvents,
    basis: BAG_PERSONALIZATION_BASIS,
    // setupEvents x the canonical art rate. bagQuantity is absent by design.
    internalSetupCost: setupEvents * BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN,
    ratePerDesign: BAG_PERSONALIZATION_ART_SETUP_PER_DESIGN,
    internalCostStatus: "VERIFIED",
    customerAddOn: BAG_PERSONALIZATION_CUSTOMER_ADD_ON,
    scope: BAG_PERSONALIZATION_SCOPE,
    basisNote: BAG_PERSONALIZATION_BASIS_NOTE,
    reasons,
    blockers,
  };
}

export type BagJobInput = {
  product: BagProduct;
  /** Finished BAGS the customer receives. */
  bagQuantity: number;
  /** Physical sides that actually receive a label. */
  sides: BagSides;
  /** Designs needing customer artwork. Ignored for a base stock bag. */
  designs?: number;
  machineKey?: string;
  cutMode?: CutMode;
  loadedMediaWidthIn?: number;
  /** Overrides the canonical $0.11 owner base cost only when a verified alternative exists. */
  blankUnitCost?: number | null;
  /**
   * Optional logo/QR personalization of the premade Stock Bag design.
   * DESIGN-level semantics: setup events come from personalizedDesignCount,
   * never from bagQuantity.
   */
  personalization?: BagPersonalization;
};

export type BagPhysicalResult = {
  version: string;
  product: BagProduct;
  bagQuantity: number;
  sides: BagSides;
  /** Printed labels = bags x labelled sides. */
  labelQuantity: number;
  blankCost: number;
  nesting: NestingResult;
  finishing: FinishingResult;
  application: LabelApplicationResult;
  setup: {
    art: number; print: number; total: number; designs: number;
    artDesignEvents: number; printDesignEvents: number; personalizedDesignEvents: number;
    artBasis: CostBasis; printBasis: CostBasis; basisNote: string;
  };
  personalization: BagPersonalizationResult;
  reasons: string[];
  blockers: string[];
};

/** Cut geometry for a bag label: separated rectangles on the REAL cutline. */
export function bagCutGeometry(): CutGeometryMap {
  return {
    "bag-label": {
      model: "separated_rectangle",
      cutWidthIn: BAG_4X5_CUTLINE_IN.widthIn,
      cutHeightIn: BAG_4X5_CUTLINE_IN.heightIn,
      note: `Cutline ${BAG_4X5_CUTLINE_IN.widthIn} x ${BAG_4X5_CUTLINE_IN.heightIn}in, derived from the 4.00 x 5.00in artboard by the GSO -0.0625in offset rule. The artboard drives nesting/material/ink and is NEVER used for the cutter path.`,
    },
  };
}

/** One physical print run: every bag label, whichever product it belongs to. */
export function bagNestingRuns(labelQuantity: number): NestingRun[] {
  return [{
    key: "bag-label-run",
    label: "Bag label print run",
    items: [{
      key: "4x5-bag-label",
      groupKey: "bag-label",
      shapeType: "rect",
      widthIn: BAG_4X5_ARTBOARD_IN.widthIn,
      heightIn: BAG_4X5_ARTBOARD_IN.heightIn,
      quantity: labelQuantity,
      allowRotate: true,
    }],
  }];
}

/**
 * Setup is the ONLY place the two products legitimately differ.
 *
 * sticker_bag_4x5 - customer artwork, so the normal art setup applies per
 *                   design.
 * stock_bag       - the base design is premade GSO artwork, so NO
 *                   new-customer-art charge for the base. A personalized
 *                   design IS a normal art setup event and is charged at the
 *                   same canonical rate, not at some invented rate.
 *
 * 2D-3C - BOTH components are PER_DESIGN:
 *   art   = (design events + personalized design events) x $8.3333333333
 *   print = print-design setup events x $1.00
 *
 * printSetupPerDesign is written "$ per design" ($25/hr at 25 designs/hr), so a
 * 3-design job is 3 print setups, not 1. Copy quantity multiplies neither.
 *
 * PRINT-DESIGN EVENTS for a Stock Bag = the number of distinct designs that
 * go on the press. Unpersonalized that is the one premade design;
 * personalized it is the personalized designs, which REPLACE the base on the
 * press rather than printing alongside it.
 */
export function bagSetupCost(
  product: BagProduct,
  designs = 1,
  personalizedDesignEvents = 0,
): {
  art: number; print: number; total: number; designs: number;
  artDesignEvents: number; printDesignEvents: number; personalizedDesignEvents: number;
  artBasis: CostBasis; printBasis: CostBasis; basisNote: string;
} {
  const artRate = OWNER_STANDARDS.artSetupPerDesign.value;
  const printRate = OWNER_STANDARDS.printSetupPerDesign.value;
  const personalized = Math.max(0, Math.floor(personalizedDesignEvents));

  if (product === "stock_bag") {
    // Base premade artwork: $0 art. Each personalized design: one normal event.
    const artDesignEvents = personalized;
    const printDesignEvents = Math.max(1, personalized);
    const art = artDesignEvents * artRate;
    const print = printDesignEvents * printRate;
    return {
      art,
      print,
      total: art + print,
      designs: artDesignEvents,
      artDesignEvents,
      printDesignEvents,
      personalizedDesignEvents: personalized,
      artBasis: SETUP_BASIS,
      printBasis: SETUP_BASIS,
      basisNote: personalized > 0
        ? `Stock Bag base artwork is premade GSO design - no new-customer-art charge for the base. ${personalized} personalized design(s) x $${artRate.toFixed(10)} NORMAL art setup + ${printDesignEvents} print-design setup(s) x $${printRate.toFixed(2)}. Bag quantity, label quantity, printed sides and application events appear nowhere in this calculation.`
        : `Stock Bag base artwork is premade GSO design - $0 art setup. One print-design setup x $${printRate.toFixed(2)}. Bag quantity does not appear in this calculation.`,
    };
  }

  const n = Math.max(0, Math.floor(designs));
  const artDesignEvents = n + personalized;
  const printDesignEvents = artDesignEvents;
  const art = artDesignEvents * artRate;
  const print = printDesignEvents * printRate;
  return {
    art,
    print,
    total: art + print,
    designs: artDesignEvents,
    artDesignEvents,
    printDesignEvents,
    personalizedDesignEvents: personalized,
    artBasis: SETUP_BASIS,
    printBasis: SETUP_BASIS,
    basisNote: `Custom 4x5 Sticker Bag: customer artwork. ${artDesignEvents} design event(s) x $${artRate.toFixed(10)} art + ${printDesignEvents} print-design setup(s) x $${printRate.toFixed(2)} (owner standards). Both charged per DESIGN - bag quantity does not appear in this calculation.`,
  };
}

export function computeBagPhysical(input: BagJobInput): BagPhysicalResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const bagQuantity = Math.max(0, Math.floor(input.bagQuantity));
  const sides: BagSides = input.sides === 2 ? 2 : 1;
  const labelQuantity = bagQuantity * sides;

  // Personalization is ART/SETUP work on a strict PER_DESIGN basis. It is
  // resolved from the design count ONLY — bagQuantity is never a factor.
  const personalization = computeBagPersonalization(input.personalization, bagQuantity);
  reasons.push(...personalization.reasons);
  blockers.push(...personalization.blockers);

  if (input.product === "stock_bag" && bagQuantity > 0 && bagQuantity < STOCK_BAG_MOQ) {
    reasons.push(BAG_REASONS.stockBagBelowMoq);
    blockers.push(`${BAG_REASONS.stockBagBelowMoq}: Stock Bags have a ${STOCK_BAG_MOQ}-unit minimum; ${bagQuantity} requested.`);
  }
  // 2D-4E2: the owner-verified 50-unit minimum applies to custom 4x5 sticker
  // bags too. Eligibility only — the material/cut/application math below is
  // untouched by it.
  if (input.product === "sticker_bag_4x5" && bagQuantity > 0 && bagQuantity < STICKER_BAG_MOQ) {
    reasons.push(BAG_REASONS.stickerBagBelowMoq);
    blockers.push(`${BAG_REASONS.stickerBagBelowMoq}: 4x5 Sticker Bags have a ${STICKER_BAG_MOQ}-unit minimum (owner-verified); ${bagQuantity} requested.`);
  }

  const blankUnit = input.blankUnitCost == null ? BAG_4X5_BLANK_UNIT_COST : Number(input.blankUnitCost);
  if (!Number.isFinite(blankUnit) || blankUnit < 0) {
    reasons.push(BAG_REASONS.bagBlankCostRequired);
    blockers.push(`${BAG_REASONS.bagBlankCostRequired}: no verified blank bag cost.`);
  }
  const blankCost = blankUnit >= 0 ? bagQuantity * blankUnit : 0;

  const policy = resolveNestingPolicy({
    machineKey: input.machineKey ?? BAG_DEFAULT_MACHINE_KEY,
    loadedMediaWidthIn: input.loadedMediaWidthIn ?? BAG_DEFAULT_MEDIA_WIDTH_IN,
  });
  if (!policy.ok) {
    blockers.push(`${policy.blocker}: ${policy.message}`);
  }
  const nesting = policy.ok
    ? computeNesting(bagNestingRuns(labelQuantity), policy.policy)
    : computeNesting(bagNestingRuns(labelQuantity), {
        mediaWidthIn: 0, printableWidthIn: 0, ripBoxConvention: "nest_bbox",
        source: "unresolved", classification: "BLOCKED",
      });

  const finishing = computeFinishing({
    nesting,
    machineKey: input.machineKey ?? BAG_DEFAULT_MACHINE_KEY,
    cutMode: input.cutMode ?? BAG_DEFAULT_CUT_MODE,
    cutGeometry: bagCutGeometry(),
    requiresWeeding: true, // every printed run off either printer is weeded
  });

  // Application: the bag IS the item and GSO already owns it via the blank, so
  // the item line must NOT charge again. applicationsPerItem = labelled sides.
  const application = computeLabelApplication({
    mode: "customer_provided_item",
    itemDescription: "4x5 bag",
    itemQuantity: bagQuantity,
    applicationsPerItem: sides,
    applicationSecondsPerEvent: BAG_APPLICATION_SECONDS_PER_SIDE,
    printedLabels: labelQuantity,
  });

  return {
    version: BAG_COST_INPUTS_VERSION,
    product: input.product,
    bagQuantity,
    sides,
    labelQuantity,
    blankCost,
    nesting,
    finishing,
    application,
    setup: bagSetupCost(input.product, input.designs ?? 1, personalization.setupEvents),
    personalization,
    reasons: Array.from(new Set([...reasons, ...finishing.reasons, ...application.reasons])),
    blockers: [...blockers, ...finishing.stages.filter((s) => s.blocker).map((s) => s.blocker!), ...application.blockers],
  };
}

/** Application labor for a bag job, from the canonical 10s/side standard. */
export function bagApplicationCost(bagQuantity: number, sides: BagSides): number {
  return (bagQuantity * sides * BAG_APPLICATION_SECONDS_PER_SIDE / 3600) * BAG_APPLICATION_LABOR_RATE_PER_HOUR;
}
