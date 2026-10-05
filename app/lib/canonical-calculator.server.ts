// Patch 2D-4 (17D.7) — THE canonical Cost Calculator dispatch layer.
//
// This is the ONE place the internal ERP Cost Calculator turns a job into a
// true cost for the four in-house manufacturing families it supports:
//
//   stickers-labels -> label-cost-inputs   (multi-line, per-line media)
//   sticker-bags    -> bag-cost-inputs     (sticker_bag_4x5)
//   stock-bags      -> bag-cost-inputs     (stock_bag)
//   banners         -> banner-cost-inputs
//
// DTP and Boxes are deliberately NOT here. They are outsourced/vendor families
// and keep their existing path untouched.
//
// WHY THIS FILE EXISTS AT ALL — calculate / save / recalculate parity.
// The route previously built its engine input twice: once in the loader and
// again in the action, and the two constructions had drifted apart in eleven
// places. Here there is exactly ONE normaliser (normalizeCanonicalInput, which
// reads URLSearchParams) and ONE assembler (assembleCanonicalJob, pure). The
// action replays the loader's own query string, so both sides feed the SAME
// function the SAME bytes and cannot disagree. That is a structural guarantee,
// not a convention a future edit can quietly break.
//
// SPLIT ON PURPOSE:
//   resolveCanonicalCalibration  async, touches the DB, nothing else
//   assembleCanonicalJob         PURE — every number in the result comes from
//                                here, so it is testable with no database
//   computeCanonicalJob          the thin async wrapper routes actually call
//
// NOTHING IS INVENTED. A missing calibration, missing cutline, missing media
// cost or unverified finishing operation blocks the job (DRAFT_ONLY) rather
// than resolving to a confident number. A blocked job never publishes a unit
// cost — see true-cost-engine.server.ts.

import {
  BAG_APPLICATION_LABOR_RATE_PER_HOUR,
  BAG_APPLICATION_SECONDS_PER_SIDE,
  computeBagPhysical,
  type BagJobInput,
  type BagPersonalization,
  type BagPhysicalResult,
  type BagSides,
} from "./bag-cost-inputs.server";
import {
  computeBannerCost,
  type BannerCostResult,
  type BannerEdge,
  type BannerGrommets,
  type BannerJobInput,
  type BannerPolePockets,
  type BannerSides,
} from "./banner-cost-inputs.server";
import {
  computeLabelJob,
  type LabelJobResult,
  type LabelLine,
} from "./label-cost-inputs.server";
import {
  computeLabelApplication,
  type LabelApplicationInput,
  type LabelApplicationResult,
} from "./label-application.server";
import type { CutMode } from "./finishing-cost.server";
import {
  computeInkMl,
  computeOccupancyMinutes,
  loadActiveCalibration,
  type CalibrationIdentity,
  type CalibrationRecord,
} from "./machine-calibration.server";
import { deriveGsoLabelCutlineFromArtboard } from "./gso-cutline";
import {
  JAR_LABEL_GEOMETRY,
  JAR_PLANNED_OVERAGE_PCT,
  resolveJarApplication,
  jarCutGeometry,
  jarFinishingStages,
  jarFreightPerUnit,
  jarNestingAreas,
  jarPhysicalRuns,
  jarSetupCost,
  packoutFor,
  productionQtyFor,
  resolveJarBlankCost,
  type JarBrand,
  type JarGeometryOverride,
  type JarLabelSelection,
  type JarSizeKey,
  type StandardJarVariant,
} from "./jar-cost-inputs.server";
import { activeJarProfile } from "./jar-active-scope";
import { JAR_LABEL_GEOMETRY_SOURCE, validateJarGeometryOverride } from "./jar-label-geometry";
import { BAG_4X5_ARTBOARD_IN, BAG_ARTBOARD_SOURCE } from "./bag-artboard-geometry";
import { PRODUCT_SPEC_VERSION } from "./product-production-spec";
import { CANONICAL_INK_RATES } from "./ink-rates-shared";
import {
  CANONICAL_CALIBRATION_IDENTITIES,
  resolveCanonicalMachineRouting,
  type CanonicalCalibrationKey,
  type MachineRoutingResult,
  type PrinterSelection,
  type RoutedChannel,
} from "./machine-routing.server";
import {
  CANONICAL_CALCULATOR_VERSION,
  CANONICAL_DISPATCH,
  CANONICAL_PACKOUT,
  CANONICAL_REASONS,
  type CanonicalCalculatorView,
  type CanonicalDiagnostics,
  type CanonicalFamily,
  type CanonicalFinishingBreakdown,
} from "./canonical-calculator-shared";
import { OWNER_STANDARDS } from "./owner-standards";
import {
  DEFAULT_OPERATOR_ATTENTION_PCT,
  DEFAULT_OPERATOR_LABOR_RATE_PER_HOUR,
  OPERATOR_ATTENTION_CLASSIFICATION,
  computeTrueJobCost,
  type CostBasis,
  type TrueCostInput,
  type TrueCostResult,
  type TrueCostStatus,
} from "./true-cost-engine.server";

// The families, dispatch table, reason codes, packout table and every result
// TYPE live in the client-safe half so React components can render a result
// without pulling this module (and Prisma) into the browser bundle.
export {
  CANONICAL_CALCULATOR_VERSION,
  CANONICAL_FAMILIES,
  CANONICAL_DISPATCH,
  CANONICAL_REASONS,
  CANONICAL_PACKOUT,
  CANONICAL_COMPONENT_ORDER,
  NON_CANONICAL_FAMILIES,
  isCanonicalFamily,
} from "./canonical-calculator-shared";
export type {
  CanonicalFamily,
  CanonicalDiagnostics,
  CanonicalCalculatorView,
} from "./canonical-calculator-shared";

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

export type CanonicalLabelInput = {
  lines: LabelLine[];
  /** NONE / CUSTOMER_PROVIDED_ITEM / CUSTOM_ITEM — the canonical module owns it. */
  application?: LabelApplicationInput;
  /** Specialty/file-prep setup EVENTS (per design/file), never per copy. */
  specialtyPrepEvents?: number;
  specialtyPrepPerEvent?: number;
};

export type CanonicalBagInput = {
  sides: BagSides;
  designs?: number;
  personalization?: BagPersonalization;
  blankUnitCost?: number | null;
};

export type CanonicalJarInput = {
  brand: JarBrand;
  size: JarSizeKey;
  variant?: StandardJarVariant;
  /** Which labels this jar actually receives. */
  selection: JarLabelSelection;
  /** Requested label types with no verified jar geometry — these BLOCK. */
  unsupportedLabels?: string[];
  designs?: number;
  /**
   * 2026-10-05 CUSTOM SIZE OVERRIDE. Only honoured when customSize is true;
   * values without the flag BLOCK (CUSTOM_SIZE_CONFLICT) rather than being
   * silently applied or silently ignored. A flag with an incomplete override
   * for a selected piece BLOCKS (CUSTOM_SIZE_INCOMPLETE). Application seconds
   * are NOT affected by an override — they stay the owner's per-size timings.
   */
  customSize?: boolean;
  geometryOverride?: JarGeometryOverride | null;
  overrideReason?: string | null;
  /** Staff-chosen label set key (side_only / lid_only / side_lid) — recorded, not costed. */
  labelSet?: string | null;
};

export type CanonicalBannerInput = {
  widthIn: number;
  heightIn: number;
  edge?: BannerEdge;
  grommets?: BannerGrommets;
  polePockets?: BannerPolePockets;
  sides?: BannerSides;
  designs?: number;
};

export type CanonicalCalculatorInput = {
  family: CanonicalFamily;
  /** Customer FINISHED quantity. Labels: printed labels. Bags: bags. Banners: banners. */
  quantity: number;
  overagePct?: number;

  /**
   * 2D-4A — OPERATOR-FACING PRESS CONTROL ONLY.
   *
   * ripProfile / qualityMode / resolution / passConfig are NOT inputs. They
   * are derived by the one routing authority (machine-routing.server.ts) from
   * the printer selection and the specialty layers, so a normal operator
   * never types a calibration internal.
   */
  printerSelection?: PrinterSelection | string;
  whiteLayers?: number;
  /** Operator-supplied. Never defaulted, never inferred from whiteLayers. */
  whiteCoveragePct?: number | null;
  glossLayers?: number;
  glossCoveragePct?: number | null;
  cmykCoveragePct?: number | null;

  equipmentRatePerHour?: number;
  cutMode?: CutMode;
  loadedMediaWidthIn?: number;

  labels?: CanonicalLabelInput;
  bags?: CanonicalBagInput;
  banner?: CanonicalBannerInput;
  jar?: CanonicalJarInput;
};

/** Routing is derived, never typed. One authority decides the whole identity. */
export function routingFor(input: CanonicalCalculatorInput): MachineRoutingResult {
  return resolveCanonicalMachineRouting({
    printerSelection: input.printerSelection,
    whiteLayers: input.whiteLayers,
    whiteCoveragePct: input.whiteCoveragePct,
    glossLayers: input.glossLayers,
    glossCoveragePct: input.glossCoveragePct,
    cmykCoveragePct: input.cmykCoveragePct,
  });
}

/** The BASE colour channel's identity — what the engine itself prices. */
export function calibrationIdentityOf(input: CanonicalCalculatorInput): CalibrationIdentity {
  const routing = routingFor(input);
  return routing.channels.find((channel) => channel.isBase)!.identity;
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

/** Per-channel ink diagnostics. White and gloss are NEVER merged into CMYK. */
export type CanonicalInkChannel = {
  kind: string;
  calibrationKey: string;
  identity: CalibrationIdentity;
  calibrationResolved: boolean;
  calibrationMessage: string;
  /** The calibration's OWN area basis — never substituted. */
  areaBasis: string | null;
  inkableSqft: number | null;
  coveragePct: number | null;
  coverageSource: string | null;
  /** Layers for this channel. CMYK is one pass. */
  passes: number;
  mlPerSqftPerPass: number | null;
  totalMl: number | null;
  costPerMl: number | null;
  inkCost: number | null;
  /** Occupancy this channel adds, on the calibration's own time basis. */
  occupancyAreaBasis: string | null;
  occupancyAreaSqft: number | null;
  occupancyMinutes: number | null;
  equipmentRecovery: number | null;
  operatorAttention: number | null;
  blocker?: string;
};

export type CanonicalCalculatorResult = {
  version: string;
  family: CanonicalFamily;
  status: TrueCostStatus;
  /** null whenever status is DRAFT_ONLY — a blocked job never publishes one. */
  unitCost: number | null;
  totalCost: number;
  trueCost: TrueCostResult;
  diagnostics: CanonicalDiagnostics;
  /** How the press was chosen, and what identities the job needs. */
  routing: MachineRoutingResult;
  /** CMYK / WHITE / GLOSS, each with its own calibration and arithmetic. */
  inkChannels: CanonicalInkChannel[];
  calibration: {
    resolved: boolean;
    identity: CalibrationIdentity;
    message: string;
    inkCostPerMl: number | null;
    inkCostSource: string;
  };
  setupBasis: { artBasis: CostBasis; printBasis: CostBasis; specialtyBasis: CostBasis | null };
  adapter: { label: LabelJobResult | null; bag: BagPhysicalResult | null; banner: BannerCostResult | null; application: LabelApplicationResult | null };
  reasons: string[];
  blockers: string[];
};

/* ------------------------------------------------------------------ *
 * Calibration resolution (the DB half)
 * ------------------------------------------------------------------ */

/** One channel with its approved calibration row attached (or not). */
export type ResolvedChannel = RoutedChannel & {
  calibration: CalibrationRecord | null;
  calibrationMessage: string;
};

export type ResolvedMachineInputs = {
  /** The BASE colour channel's calibration — what computeTrueJobCost prices. */
  calibration: CalibrationRecord | null;
  calibrationMessage: string;
  inkCostPerMl: number | null;
  inkCostSource: string;
  /** Every channel this job prints, base first. */
  channels?: ResolvedChannel[];
  routing?: MachineRoutingResult;
};

/**
 * Load the approved calibration row for ONE identity.
 *
 * Fails CLOSED on every axis. The MachineProfileCalibration migration is
 * STAGED-not-applied in some environments, so a missing TABLE must read as
 * "no approved calibration" — never a crash, and never a silently free job.
 */
async function loadOne(
  deps: { db: any; shop: string; at?: Date },
  identity: CalibrationIdentity,
): Promise<{ calibration: CalibrationRecord | null; message: string }> {
  try {
    const resolution = await loadActiveCalibration(deps.db, deps.shop, identity, deps.at ?? new Date());
    return resolution.ok
      ? { calibration: resolution.calibration, message: `Approved calibration ${resolution.calibration.id} (${resolution.calibration.source}).` }
      : { calibration: null, message: resolution.message };
  } catch (error: any) {
    return {
      calibration: null,
      message: `Calibration lookup unavailable (${String(error?.message || error).slice(0, 160)}). Treated as MISSING_CALIBRATION.`,
    };
  }
}

/**
 * Resolve the press, every ink channel, and each channel's approved
 * calibration row. Calibration owns mL/sqft and min/sqft; purchasing owns
 * $/mL — deliberately separate authorities, never stored together.
 */
export async function resolveCanonicalMachineInputs(
  deps: { db: any; shop: string; at?: Date },
  input: CanonicalCalculatorInput | CalibrationIdentity,
): Promise<ResolvedMachineInputs> {
  // Back-compatible: a bare identity resolves just that one row.
  if ("machineKey" in input && !("family" in input)) {
    const one = await loadOne(deps, input as CalibrationIdentity);
    return { calibration: one.calibration, calibrationMessage: one.message, inkCostPerMl: null, inkCostSource: "" };
  }

  const job = input as CanonicalCalculatorInput;
  const routing = routingFor(job);
  const channels: ResolvedChannel[] = [];
  for (const channel of routing.channels) {
    const loaded = await loadOne(deps, channel.identity);
    channels.push({ ...channel, calibration: loaded.calibration, calibrationMessage: loaded.message });
  }
  const base = channels.find((channel) => channel.isBase)!;
  return {
    calibration: base.calibration,
    calibrationMessage: base.calibrationMessage,
    inkCostPerMl: base.inkCostPerMl,
    inkCostSource: base.inkCostSource,
    channels,
    routing,
  };
}

/* ------------------------------------------------------------------ *
 * 2D-4F — Calibration cache for SYNCHRONOUS pricing surfaces.
 *
 * The storefront/preview pricing modules are pure, synchronous functions
 * tested with literal fixtures. They cannot await a database per price. The
 * canonical engine needs exactly FOUR calibration identities (see
 * CANONICAL_CALIBRATION_IDENTITIES in machine-routing.server.ts), so a caller
 * preloads those once per request and the engine is then resolved purely.
 *
 * FAILS CLOSED: an identity absent from the cache is MISSING_CALIBRATION, the
 * same as an absent DB row. Nothing is widened or substituted.
 * ------------------------------------------------------------------ */

export type CalibrationCache = Partial<Record<CanonicalCalibrationKey, { calibration: CalibrationRecord | null; message: string }>>;

/** Load every canonical calibration identity once. */
export async function preloadCanonicalCalibrations(deps: { db: any; shop: string; at?: Date }): Promise<CalibrationCache> {
  const cache: CalibrationCache = {};
  for (const key of Object.keys(CANONICAL_CALIBRATION_IDENTITIES) as CanonicalCalibrationKey[]) {
    cache[key] = await loadOne(deps, CANONICAL_CALIBRATION_IDENTITIES[key]);
  }
  return cache;
}

/** Pure twin of resolveCanonicalMachineInputs, reading the preloaded cache. */
export function resolveCanonicalMachineInputsFromCache(
  input: CanonicalCalculatorInput,
  cache: CalibrationCache | null | undefined,
): ResolvedMachineInputs {
  const routing = routingFor(input);
  const channels: ResolvedChannel[] = routing.channels.map((channel) => {
    const hit = cache?.[channel.calibrationKey];
    return {
      ...channel,
      calibration: hit?.calibration ?? null,
      calibrationMessage: hit
        ? hit.message
        : `No preloaded calibration for ${channel.calibrationKey}. Treated as MISSING_CALIBRATION.`,
    };
  });
  const base = channels.find((channel) => channel.isBase)!;
  return {
    calibration: base.calibration,
    calibrationMessage: base.calibrationMessage,
    inkCostPerMl: base.inkCostPerMl,
    inkCostSource: base.inkCostSource,
    channels,
    routing,
  };
}

/* ------------------------------------------------------------------ *
 * Assembly (the PURE half — every number originates here)
 * ------------------------------------------------------------------ */

const EMPTY_DIAGNOSTICS = (): CanonicalDiagnostics => ({
  mediaConsumedSqft: 0,
  ripLayoutSqft: null,
  inkableArtworkSqft: 0,
  feedLengthIn: null,
  nestRotated: null,
  nestColumns: null,
  nestRows: null,
  machineMinutes: null,
  cutPathIn: null,
  cutMinutes: null,
  weedingPages: null,
  applicationEvents: null,
  physicalItems: null,
  applicationsPerItem: null,
  printedLabelsAvailable: null,
  artSetupEvents: null,
  printSetupEvents: null,
  personalizationSetupEvents: null,
  personalizationCustomerAddOn: null,
  productSpec: null,
  finishingBreakdown: null,
});

export function assembleCanonicalJob(
  input: CanonicalCalculatorInput,
  machine: ResolvedMachineInputs,
): CanonicalCalculatorResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const diagnostics = EMPTY_DIAGNOSTICS();

  const finished = Math.max(0, Math.floor(input.quantity));
  const overagePct = input.overagePct ??
    (input.family === "standard-jars" || input.family === "premium-jars" ? JAR_PLANNED_OVERAGE_PCT : 0);
  const production = Math.max(finished, Math.ceil(finished * (1 + overagePct / 100)));
  const equipmentRatePerHour = input.equipmentRatePerHour ?? OWNER_STANDARDS.machineRecoveryPerHour.value;

  // Routing first: every adapter below needs the ROUTED machine key, and the
  // nesting/cut policies are machine-specific.
  const routing = machine.routing ?? routingFor(input);
  reasons.push(...routing.reasons);
  blockers.push(...routing.blockers);

  if (finished <= 0) {
    reasons.push(CANONICAL_REASONS.quantityRequired);
    blockers.push(`${CANONICAL_REASONS.quantityRequired}: a canonical job needs a positive finished quantity.`);
  }

  let label: LabelJobResult | null = null;
  let bag: BagPhysicalResult | null = null;
  let banner: BannerCostResult | null = null;
  let application: LabelApplicationResult | null = null;

  // Engine pieces every family must supply.
  let areas: TrueCostInput["areas"] = {
    inkableArtworkSqft: 0,
    ripLayoutSqft: null,
    materialFootprintSqft: 0,
    ripLayoutBasis: "not resolved",
  };
  let materialName = "Print media";
  let materialCostPerSqft: number | null = null;
  let materialSource = "";
  let blank: TrueCostInput["blank"] = {
    ok: true,
    unitCost: 0,
    label: "No blank / substrate for this family",
    source: "This family prints on roll media only; there is no separate blank item.",
  };
  let setup: TrueCostInput["setup"] = { art: 0, print: 0, groups: 0 };
  const finishingStages: NonNullable<TrueCostInput["finishingStages"]> = [];
  let applicationCost: TrueCostInput["application"] = {
    costPerFinishedUnit: 0,
    note: "No application selected for this job.",
  };
  let unitsPerBox = CANONICAL_PACKOUT[input.family].unitsPerBox;
  /** Jars bring their own verified packout and freight. */
  let jarPackout: { boxes: number; unitsPerBox: number; cost: number } | null = null;
  let jarFreightInput: TrueCostInput["freight"] | null = null;

  /* ---------------- LABELS / STICKERS ---------------- */
  if (input.family === "stickers-labels") {
    const cfg = input.labels ?? { lines: [] };
    label = computeLabelJob({
      lines: cfg.lines,
      machineKey: routing.machineKey,
      cutMode: input.cutMode,
      loadedMediaWidthIn: input.loadedMediaWidthIn,
    });
    reasons.push(...label.reasons);
    blockers.push(...label.blockers);

    if (label.areas) {
      areas = {
        inkableArtworkSqft: label.areas.inkableArtworkSqft,
        ripLayoutSqft: label.areas.ripLayoutSqft,
        materialFootprintSqft: label.areas.materialFootprintSqft,
        ripLayoutBasis: label.areas.ripLayoutBasis,
      };
      materialCostPerSqft = label.areas.blendedMaterialCostPerSqft;
      materialName = label.lines.length === 1 && label.lines[0].material
        ? label.lines[0].material.label
        : `${label.lines.length} label line(s), blended media`;
      materialSource = `Blended from the per-line verified roll costs so the job total equals the sum of the lines exactly ($${label.materialCost.toFixed(6)}).`;
      if (label.areas.inkableAreaEstimated) reasons.push(CANONICAL_REASONS.inkableAreaEstimated);
    }

    setup = {
      art: label.setup.art,
      print: label.setup.print,
      groups: label.setup.artSetupEvents,
      artBasis: label.setup.artBasis,
      printBasis: label.setup.printBasis,
      note: label.setup.basisNote,
    };
    if (cfg.specialtyPrepEvents && cfg.specialtyPrepEvents > 0) {
      const per = cfg.specialtyPrepPerEvent ?? OWNER_STANDARDS.glossLayerSetupPerDesign.value;
      setup = { ...setup, specialty: cfg.specialtyPrepEvents * per, specialtyBasis: "PER_DESIGN" };
    }

    if (label.finishing) {
      finishingStages.push(...canonicalFinishingStages(label.finishing, { includeWeeding: true }));
      diagnostics.cutPathIn = label.finishing.cutPathIn;
      diagnostics.cutMinutes = label.finishing.cutMinutes;
      diagnostics.weedingPages = label.finishing.weedingPages;
    }

    if (cfg.application) {
      application = computeLabelApplication({ ...cfg.application, printedLabels: label.printedLabels });
      reasons.push(...application.reasons);
      blockers.push(...application.blockers);
      applicationCost = {
        costPerFinishedUnit: finished > 0 ? application.applicationLaborCost / finished : 0,
        note: `${application.applicationEvents} application event(s) at the canonical $20/hr hand standard.`,
      };
      if (application.itemCost > 0) {
        finishingStages.push({
          key: "custom_item",
          label: `Custom physical item — ${application.physicalItems} x item cost`,
          amount: application.itemCost,
          category: "materials",
          basis: "PER_UNIT",
          formula: `${application.physicalItems} items x entered unit cost`,
          note: "CUSTOM_ITEM mode. A customer-provided item is $0 and never reaches this line.",
        });
      }
      diagnostics.applicationEvents = application.applicationEvents;
      diagnostics.physicalItems = application.physicalItems;
      diagnostics.applicationsPerItem = application.applicationsPerItem;
      diagnostics.printedLabelsAvailable = application.printedLabels;
    }

    diagnostics.artSetupEvents = label.setup.artSetupEvents;
    diagnostics.printSetupEvents = label.setup.printSetupEvents;
  }

  /* ---------------- 4x5 STICKER BAGS + STOCK BAGS ---------------- */
  if (input.family === "sticker-bags" || input.family === "stock-bags") {
    const cfg = input.bags ?? { sides: 1 as BagSides };
    const bagInput: BagJobInput = {
      product: input.family === "stock-bags" ? "stock_bag" : "sticker_bag_4x5",
      bagQuantity: production,
      sides: cfg.sides,
      designs: cfg.designs,
      personalization: cfg.personalization,
      blankUnitCost: cfg.blankUnitCost,
      machineKey: routing.machineKey,
      cutMode: input.cutMode,
      loadedMediaWidthIn: input.loadedMediaWidthIn,
    };
    bag = computeBagPhysical(bagInput);
    reasons.push(...bag.reasons);
    blockers.push(...bag.blockers);

    areas = {
      inkableArtworkSqft: bag.nesting.usedShapeAreaSqft,
      ripLayoutSqft: bag.nesting.ripLayoutSqft,
      materialFootprintSqft: bag.nesting.materialFootprintSqft,
      ripLayoutBasis: bag.nesting.ripLayoutBasis,
    };
    materialName = "Poseidon Matte (bag label media)";
    materialCostPerSqft = LABEL_MEDIA_PER_SQFT;
    materialSource = "Verified roll cost (APPROVED_ROLL_COSTS.poseidonMattePerSqft).";

    // The blank is priced at PRODUCTION quantity by the engine, so hand it the
    // unit cost rather than the adapter's already-multiplied total.
    blank = {
      ok: true,
      unitCost: production > 0 ? bag.blankCost / production : 0,
      label: "4x5 blank bag",
      source: "Owner-corrected 2026-08-24: $0.09 each, supplier base BEFORE inbound freight (pallet freight not yet modelled).",
    };

    setup = {
      art: bag.setup.art,
      print: bag.setup.print,
      groups: bag.setup.artDesignEvents,
      artBasis: bag.setup.artBasis,
      printBasis: bag.setup.printBasis,
      note: bag.setup.basisNote,
    };

    finishingStages.push(...canonicalFinishingStages(bag.finishing, { includeWeeding: true }));
    diagnostics.cutPathIn = bag.finishing.cutPathIn;
    diagnostics.cutMinutes = bag.finishing.cutMinutes;
    diagnostics.weedingPages = bag.finishing.weedingPages;

    application = bag.application;
    applicationCost = {
      secondsPerFinishedUnit: cfg.sides * BAG_APPLICATION_SECONDS_PER_SIDE,
      laborRatePerHour: BAG_APPLICATION_LABOR_RATE_PER_HOUR,
      note: `${cfg.sides} labelled side(s) x ${BAG_APPLICATION_SECONDS_PER_SIDE}s at $${BAG_APPLICATION_LABOR_RATE_PER_HOUR}/hr.`,
    };
    diagnostics.applicationEvents = bag.application.applicationEvents;
    diagnostics.physicalItems = bag.application.physicalItems;
    diagnostics.applicationsPerItem = bag.application.applicationsPerItem;
    diagnostics.printedLabelsAvailable = bag.application.printedLabels;
    diagnostics.artSetupEvents = bag.setup.artDesignEvents;
    diagnostics.printSetupEvents = bag.setup.printDesignEvents;
    diagnostics.personalizationSetupEvents = bag.personalization.setupEvents;
    diagnostics.personalizationCustomerAddOn = bag.personalization.customerAddOn;
  }

  /* ---------------- BANNERS ---------------- */
  if (input.family === "banners") {
    const cfg = input.banner ?? { widthIn: 0, heightIn: 0 };
    const bannerInput: BannerJobInput = {
      widthIn: cfg.widthIn,
      heightIn: cfg.heightIn,
      quantity: production,
      edge: cfg.edge,
      grommets: cfg.grommets,
      polePockets: cfg.polePockets,
      sides: cfg.sides,
      designs: cfg.designs,
      machineKey: routing.machineKey,
      cutMode: input.cutMode,
      loadedMediaWidthIn: input.loadedMediaWidthIn,
    };
    banner = computeBannerCost(bannerInput);
    reasons.push(...banner.reasons);
    blockers.push(...banner.blockers);

    areas = {
      inkableArtworkSqft: banner.finishedSqft,
      ripLayoutSqft: banner.ripLayoutSqft,
      // ACTUAL media consumed — never the finished area.
      materialFootprintSqft: banner.mediaSqft,
      ripLayoutBasis: banner.nesting?.ripLayoutBasis ?? "not resolved",
    };
    materialName = "Banner vinyl";
    materialCostPerSqft = banner.materialCostPerSqft;
    materialSource = "Verified roll cost (APPROVED_ROLL_COSTS.bannerVinylPerSqft), applied to ACTUAL media consumed.";

    setup = {
      art: banner.setup.art,
      print: banner.setup.print,
      groups: banner.setup.designs,
      artBasis: banner.setup.artBasis,
      printBasis: banner.setup.printBasis,
    };

    if (banner.finishing) {
      // Banners are trimmed, never weeded — no $0 weeding line is emitted.
      finishingStages.push(...canonicalFinishingStages(banner.finishing, { includeWeeding: false }));
      diagnostics.cutPathIn = banner.finishing.cutPathIn;
      diagnostics.cutMinutes = banner.finishing.cutMinutes;
    }
    // Banners are trimmed, never weeded.
    diagnostics.weedingPages = 0;
    diagnostics.feedLengthIn = banner.feedLengthIn;
    diagnostics.nestRotated = banner.rotated;
    diagnostics.nestColumns = banner.columns;
    diagnostics.nestRows = banner.rows;
    diagnostics.artSetupEvents = banner.setup.designs;
    diagnostics.printSetupEvents = banner.setup.designs;
  }

  /* ---------------- JARS (active scope only) ----------------
   * 2D-4D1. Jars keep their own long-standing rules — art PER_DESIGN, print
   * PER_JOB, a complete-set blank charged ONCE per jar, and per-size packout —
   * so this branch feeds the engine from the jar adapter rather than
   * reinterpreting any of it. Only the cutline is new, and it comes from the
   * shared GSO offset rule like every other label.
   *
   * SCOPE IS ENFORCED HERE: a brand+size GSO does not offer is refused rather
   * than costed from whatever tables happen to contain it. */
  if (input.family === "standard-jars" || input.family === "premium-jars") {
    const cfg = input.jar;
    if (!cfg) {
      reasons.push(CANONICAL_REASONS.familyUnsupported);
      blockers.push(`${CANONICAL_REASONS.familyUnsupported}: no jar profile was supplied for this job.`);
    } else {
      const active = activeJarProfile(cfg.brand, cfg.size);
      // A size the geometry tables do not contain cannot be measured at all,
      // so the adapter is never called with it — it would throw rather than
      // fail closed, and a crashed loader is not a refusal.
      const geometryKnown = Object.prototype.hasOwnProperty.call(JAR_LABEL_GEOMETRY, cfg.size);
      if (!active) {
        reasons.push(CANONICAL_REASONS.familyUnsupported);
        blockers.push(
          `${CANONICAL_REASONS.familyUnsupported}: "${cfg.brand} ${cfg.size}" is not a jar GSO currently offers, so it has no verified cost. Choose an active jar, or have the owner add this combination to the active scope with its supplier cost.`,
        );
      } else if (active.uiFamily !== input.family) {
        reasons.push(CANONICAL_REASONS.familyUnsupported);
        blockers.push(
          `${CANONICAL_REASONS.familyUnsupported}: ${active.label} quotes under "${active.uiFamily}", not "${input.family}".`,
        );
      }

      const selection: JarLabelSelection = {
        side: Boolean(cfg.selection?.side),
        lid: Boolean(cfg.selection?.lid),
        tamper: Boolean(cfg.selection?.tamper),
      };

      /* A jar has verified geometry for ONE side, ONE lid and ONE tamper label.
       * A requested neck/bottom/additional row — or a second label in a
       * position that already has one — is REFUSED rather than dropped:
       * dropping it would quietly remove a whole label per jar from the media,
       * ink, cutting, weeding and application cost. */
      const unsupported = cfg.unsupportedLabels ?? [];
      if (unsupported.length) {
        reasons.push(CANONICAL_REASONS.labelGeometryUnsupported);
        blockers.push(
          `${CANONICAL_REASONS.labelGeometryUnsupported}: this job asks for jar label(s) the canonical jar model has no verified geometry for — ${unsupported.join(", ")}. A jar is measured as one side, one lid and one tamper label; anything else needs owner-supplied geometry before it can be quoted.`,
        );
      }
      if (!selection.side && !selection.lid && !selection.tamper) {
        reasons.push(CANONICAL_REASONS.noPrintedComponent);
        blockers.push(
          `${CANONICAL_REASONS.noPrintedComponent}: no jar label was selected, so there is nothing to print. Choose at least one side, lid or tamper label.`,
        );
      }
      if (!geometryKnown) {
        reasons.push(CANONICAL_REASONS.familyUnsupported);
        blockers.push(
          `${CANONICAL_REASONS.familyUnsupported}: "${cfg.size || "(no jar selected)"}" is not a jar size this system has geometry for, so nothing about it can be measured.`,
        );
      }
    }

    if (cfg && Object.prototype.hasOwnProperty.call(JAR_LABEL_GEOMETRY, cfg.size)) {
      const selection: JarLabelSelection = {
        side: Boolean(cfg.selection?.side),
        lid: Boolean(cfg.selection?.lid),
        tamper: Boolean(cfg.selection?.tamper),
      };
      const active = activeJarProfile(cfg.brand, cfg.size);

      /* ---- 2026-10-05 CUSTOM SIZE OVERRIDE (fail closed) ----
       * Standard dimensions come from the one geometry authority. Staff may
       * override a SELECTED piece only with the explicit flag AND a complete,
       * in-range value; anything else blocks. */
      const overrideSupplied = Boolean(cfg.geometryOverride && Object.keys(cfg.geometryOverride).length);
      let jarGeometry: ReturnType<typeof validateJarGeometryOverride> = validateJarGeometryOverride(cfg.size, selection, null);
      if (overrideSupplied && !cfg.customSize) {
        reasons.push(CANONICAL_REASONS.customSizeConflict);
        blockers.push(
          `${CANONICAL_REASONS.customSizeConflict}: custom label dimensions were supplied without the CUSTOM SIZE OVERRIDE flag. Either turn the override on (Advanced / Custom Size Override) or clear the custom dimensions — the standard ${active?.label ?? cfg.size} dimensions were NOT silently used.`,
        );
      } else if (cfg.customSize) {
        jarGeometry = validateJarGeometryOverride(cfg.size, selection, cfg.geometryOverride ?? null);
        if (!jarGeometry.ok) {
          reasons.push(CANONICAL_REASONS.customSizeIncomplete);
          blockers.push(`${CANONICAL_REASONS.customSizeIncomplete}: ${jarGeometry.errors.join("; ")}.`);
        } else if (!jarGeometry.overridden.length) {
          reasons.push(CANONICAL_REASONS.customSizeIncomplete);
          blockers.push(
            `${CANONICAL_REASONS.customSizeIncomplete}: CUSTOM SIZE OVERRIDE is on but no custom dimension was entered for any selected label. Enter the custom size or turn the override off to use the standard ${active?.label ?? cfg.size} dimensions.`,
          );
        }
      }
      const geometryForCost = jarGeometry.ok ? jarGeometry.geometry : JAR_LABEL_GEOMETRY[cfg.size];
      const standardGeometry = JAR_LABEL_GEOMETRY[cfg.size];
      const overriddenPieces = jarGeometry.ok ? jarGeometry.overridden.map(String) : [];
      const pick = (g: typeof standardGeometry, only?: string[]) => {
        const out: Record<string, Record<string, number>> = {};
        if (selection.side && (!only || only.includes("side"))) out.side = { ...g.side };
        if (selection.lid && (!only || only.includes("lid"))) out.lid = { ...g.lid };
        if (selection.tamper && (!only || only.includes("tamper"))) out.tamper = { ...g.tamper };
        return out;
      };
      diagnostics.productSpec = {
        specVersion: PRODUCT_SPEC_VERSION,
        family: input.family,
        productKey: active?.key ?? `${cfg.brand}/${cfg.size}`,
        displayName: active?.label ?? `${cfg.brand} ${cfg.size}`,
        source: JAR_LABEL_GEOMETRY_SOURCE,
        labelSet: cfg.labelSet ?? null,
        standard: pick(standardGeometry),
        customSize: Boolean(cfg.customSize) && overriddenPieces.length > 0,
        override: overriddenPieces.length ? pick(geometryForCost, overriddenPieces) : {},
        overriddenPieces,
        overrideReason: cfg.overrideReason ? String(cfg.overrideReason).slice(0, 240) : null,
      };

      // ---- blank: a COMPLETE SET, charged once per jar ----
      const blankResolution: any = resolveJarBlankCost({
        brand: cfg.brand, size: cfg.size, quantity: production, variant: cfg.variant,
      });
      blank = blankResolution.ok
        ? { ok: true, unitCost: blankResolution.unitCost, label: `${active?.label ?? cfg.brand + " " + cfg.size} complete set`, source: blankResolution.source }
        : { ok: false, reason: blankResolution.reason, message: blankResolution.message };

      // ---- areas from the jar adapter's own physical runs ----
      const jarAreas = jarNestingAreas({
        size: cfg.size,
        selection,
        productionQty: production,
        machineKey: routing.machineKey,
        loadedMediaWidthIn: input.loadedMediaWidthIn,
        geometry: geometryForCost,
      });
      areas = jarAreas.areas;
      blockers.push(...jarAreas.blockers);
      materialName = "Poseidon Matte (jar label media)";
      materialCostPerSqft = LABEL_MEDIA_PER_SQFT;
      materialSource = "Verified roll cost (APPROVED_ROLL_COSTS.poseidonMattePerSqft).";

      // ---- cutting + weeding on the DERIVED cutlines ----
      if (jarAreas.nesting) {
        const jarFinishing = jarFinishingStages({
          size: cfg.size,
          nesting: jarAreas.nesting,
          machineKey: routing.machineKey,
          cutMode: input.cutMode,
          cutGeometry: jarCutGeometry(cfg.size, geometryForCost),
          requiresWeeding: true,
        });
        finishingStages.push(...canonicalFinishingStages(jarFinishing, { includeWeeding: true }));
        reasons.push(...jarFinishing.reasons);
        blockers.push(...jarFinishing.blockers);
        diagnostics.cutPathIn = jarFinishing.cutPathIn;
        diagnostics.cutMinutes = jarFinishing.cutMinutes;
        diagnostics.weedingPages = jarFinishing.weedingPages;
      }

      // ---- setup: art PER_DESIGN, print PER_JOB (jar rule, unchanged) ----
      const jarSetup = jarSetupCost(selection);
      setup = {
        art: jarSetup.art,
        print: jarSetup.print,
        groups: jarSetup.designs,
        artBasis: jarSetup.artBasis,
        printBasis: jarSetup.printBasis,
        note: "Jar setup: side+lid is ONE design, tamper is a second (+$10 art). Print setup is charged once per JOB — two physical runs do not create a second one.",
      };

      /* ---- application: per LABEL applied, on finished jars ----
       * 2D-4D2: the per-size OWNER timings, not a flat rate. A label the
       * owner recorded no timing for — a tamper/lid-side band on a 3oz or
       * 4oz jar — BLOCKS rather than borrowing another size's number. */
      const jarApplication = resolveJarApplication(cfg.size, selection);
      if (jarApplication.ok) {
        applicationCost = {
          costPerFinishedUnit: jarApplication.costPerFinishedUnit,
          note: jarApplication.detail,
        };
      } else {
        applicationCost = { costPerFinishedUnit: 0, note: jarApplication.message };
        reasons.push(CANONICAL_REASONS.applicationStandardRequired);
        blockers.push(`${CANONICAL_REASONS.applicationStandardRequired}: ${jarApplication.message}`);
      }
      const labelsPerJar = (selection.side ? 1 : 0) + (selection.lid ? 1 : 0) + (selection.tamper ? 1 : 0);
      diagnostics.applicationEvents = finished * labelsPerJar;
      diagnostics.physicalItems = finished;
      diagnostics.applicationsPerItem = labelsPerJar;
      diagnostics.artSetupEvents = jarSetup.designs;
      diagnostics.printSetupEvents = 1;

      // ---- packout + freight come from the jar adapter's verified tables ----
      jarPackout = packoutFor(cfg.size, finished);
      /* The 1% planned overage is OWNER-VERIFIED as of 2D-4D3
       * (OWNER_STANDARDS.jarPlannedOveragePct), so it carries no disclosure —
       * 2D-4D2's warning existed only because the figure had no owner record,
       * and that is no longer true. It is applied once, to produced-quantity
       * inputs, and is never a separate charge. */
      const jarFreight: any = jarFreightPerUnit(cfg.brand, cfg.size);
      jarFreightInput = {
        perUnit: jarFreight.perUnit,
        basis: jarFreight.basis,
        provisional: jarFreight.provisional,
        source: jarFreight.source ?? jarFreight.basis,
      };
    }
  }

  /* ---------------- shared diagnostics ---------------- */
  diagnostics.mediaConsumedSqft = areas.materialFootprintSqft;
  diagnostics.ripLayoutSqft = areas.ripLayoutSqft;
  diagnostics.inkableArtworkSqft = areas.inkableArtworkSqft;

  /* ---------------- material / packout / freight ---------------- */
  if (materialCostPerSqft == null || !(materialCostPerSqft > 0)) {
    reasons.push(CANONICAL_REASONS.materialCostRequired);
  }

  // Jars supply their own verified per-size box counts and consumables rate, so
  // the shared table's "null" for them means "the adapter owns this", not "no
  // packout standard exists".
  if (unitsPerBox == null && !jarPackout) {
    reasons.push(CANONICAL_REASONS.packoutNotModeled);
  }
  const packout: TrueCostInput["packout"] = jarPackout
    ? jarPackout
    : unitsPerBox == null
      ? { boxes: 0, unitsPerBox: 1, cost: 0 }
      : { unitsPerBox, laborPerBox: OWNER_STANDARDS.packoutPerBox.value, consumablesPerBox: 0 };

  if (!jarFreightInput) reasons.push(CANONICAL_REASONS.freightNotModeled);

  /* ---------------- calibration / ink ---------------- */
  if (!machine.calibration) reasons.push(CANONICAL_REASONS.calibrationRequired);
  if (machine.inkCostPerMl == null) reasons.push(CANONICAL_REASONS.inkPriceRequired);

  /* ---- ink channels — CMYK, WHITE and GLOSS priced SEPARATELY ----
   * The engine prices the BASE colour channel itself (one calibration, one
   * $/mL). Specialty channels have their own calibration, their own passes
   * and their own coverage, so they are computed here and added as explicit
   * ink / machine_recovery / run_labor stages. White and gloss are never
   * folded into the CMYK arithmetic.
   *
   * Every channel uses ITS calibration's own area basis — inkableArtwork for
   * ink, ripLayout for occupancy on all four seeded rows — never a substitute. */
  const resolvedChannels: ResolvedChannel[] = machine.channels ?? [];
  const inkChannels: CanonicalInkChannel[] = [];
  const areaMap = {
    inkable_artwork: areas.inkableArtworkSqft,
    rip_layout: areas.ripLayoutSqft ?? undefined,
    material_footprint: areas.materialFootprintSqft,
  };

  for (const channel of resolvedChannels) {
    const entry: CanonicalInkChannel = {
      kind: channel.kind,
      calibrationKey: channel.calibrationKey,
      identity: channel.identity,
      calibrationResolved: channel.calibration != null,
      calibrationMessage: channel.calibrationMessage,
      areaBasis: channel.calibration?.inkAreaBasis ?? null,
      inkableSqft: null,
      coveragePct: channel.coveragePct,
      coverageSource: null,
      passes: channel.passCount,
      mlPerSqftPerPass: channel.calibration?.mlPerSqftPerPass ?? null,
      totalMl: null,
      costPerMl: channel.inkCostPerMl,
      inkCost: null,
      occupancyAreaBasis: channel.calibration?.timeAreaBasis ?? null,
      occupancyAreaSqft: null,
      occupancyMinutes: null,
      equipmentRecovery: null,
      operatorAttention: null,
    };

    if (!channel.calibration) {
      entry.blocker = `${CANONICAL_REASONS.calibrationRequired}: ${channel.kind.toUpperCase()} channel — ${channel.calibrationMessage}`;
      if (!channel.isBase) blockers.push(entry.blocker);
      inkChannels.push(entry);
      continue;
    }

    const ml = computeInkMl({
      calibration: channel.calibration,
      areas: areaMap,
      coveragePct: channel.coveragePct,
      passCount: channel.passCount,
    });
    if (ml.ok) {
      entry.inkableSqft = ml.areaSqft;
      entry.coveragePct = ml.coveragePct;
      entry.coverageSource = ml.coverageSource;
      entry.totalMl = ml.inkMl;
      entry.inkCost = channel.inkCostPerMl != null ? ml.inkMl * channel.inkCostPerMl : null;
    } else if (!channel.isBase) {
      entry.blocker = `${ml.reason}: ${channel.kind.toUpperCase()} channel — ${ml.message}`;
      blockers.push(entry.blocker);
    }

    const occ = computeOccupancyMinutes({
      calibration: channel.calibration,
      areas: areaMap,
      passCount: channel.passCount,
    });
    if (occ.ok) {
      entry.occupancyAreaSqft = occ.areaSqft;
      entry.occupancyMinutes = occ.minutes;
      entry.equipmentRecovery = (occ.minutes / 60) * equipmentRatePerHour;
      entry.operatorAttention = (occ.minutes / 60) * (DEFAULT_OPERATOR_ATTENTION_PCT / 100) * DEFAULT_OPERATOR_LABOR_RATE_PER_HOUR;
    }

    // Specialty channels post their own explicit lines; the base channel is
    // priced by the engine so it must NOT be double-counted here.
    if (!channel.isBase) {
      finishingStages.push({
        key: `ink_${channel.kind}`,
        label: `${channel.kind.toUpperCase()} ink — ${entry.totalMl == null ? "blocked" : `${entry.totalMl.toFixed(2)} mL`} (${channel.passCount} layer(s))`,
        amount: entry.inkCost ?? 0,
        category: "ink",
        basis: "PER_AREA",
        formula: entry.totalMl == null ? undefined
          : `${(entry.inkableSqft ?? 0).toFixed(4)} sqft (${entry.areaBasis}) x ${entry.coveragePct}% x ${entry.mlPerSqftPerPass} mL/sqft x ${channel.passCount} pass = ${entry.totalMl.toFixed(4)} mL x ${(channel.inkCostPerMl ?? 0).toFixed(7)}/mL`,
        note: channel.inkCostSource,
        blocker: entry.blocker,
      });
      if (entry.equipmentRecovery != null) {
        finishingStages.push({
          key: `machine_${channel.kind}`,
          label: `${channel.kind.toUpperCase()} press occupancy — ${entry.occupancyMinutes!.toFixed(1)} min`,
          amount: entry.equipmentRecovery,
          category: "machine_recovery",
          basis: "PER_AREA",
          formula: `${(entry.occupancyAreaSqft ?? 0).toFixed(4)} sqft (${entry.occupancyAreaBasis}) x ${channel.calibration.minutesPerSqft} min/sqft x ${channel.passCount} pass`,
        });
        finishingStages.push({
          key: `attention_${channel.kind}`,
          label: `${channel.kind.toUpperCase()} operator attention — ${DEFAULT_OPERATOR_ATTENTION_PCT}% of ${entry.occupancyMinutes!.toFixed(1)} min`,
          amount: entry.operatorAttention!,
          category: "run_labor",
          basis: "PER_AREA",
          provisional: `Operator attention ${DEFAULT_OPERATOR_ATTENTION_PCT}% is ${OPERATOR_ATTENTION_CLASSIFICATION}.`,
        });
      }
    }
    inkChannels.push(entry);
  }

  const trueCostInput: TrueCostInput = {
    customerFinishedQty: finished,
    productionQty: production,
    overagePct,
    areas,
    blank,
    material: { name: materialName, costPerSqft: materialCostPerSqft, source: materialSource },
    calibration: machine.calibration,
    calibrationMessage: machine.calibrationMessage,
    inkCostPerMl: machine.inkCostPerMl,
    inkCostSource: machine.inkCostSource,
    // The BASE colour channel only. Specialty channels are priced above.
    coveragePct: resolvedChannels.find((channel) => channel.isBase)?.coveragePct ?? input.cmykCoveragePct ?? null,
    passCount: 1,
    application: applicationCost,
    setup,
    runLabor: { mode: "operator_attention" },
    equipmentRatePerHour,
    packout,
    freight: jarFreightInput ?? {
      perUnit: 0,
      basis: "NO_SEPARATE_INBOUND_FREIGHT",
      provisional: false,
      source: "Roll media is priced delivered (invoice cost / roll area), so it carries no separate inbound freight line. Blank-bag inbound freight is not modeled by the canonical adapter yet.",
    },
    finishingStages,
  };

  const trueCost = computeTrueJobCost(trueCostInput);
  diagnostics.machineMinutes = machineMinutesFrom(trueCost);
  diagnostics.finishingBreakdown = finishingBreakdownFrom(trueCost);
  if (input.family === "sticker-bags" || input.family === "stock-bags") {
    diagnostics.productSpec = {
      specVersion: PRODUCT_SPEC_VERSION,
      family: input.family,
      productKey: input.family === "sticker-bags" ? "bag-4x5/sticker" : "bag-4x5/stock",
      displayName: input.family === "sticker-bags" ? "4x5 Sticker Bag" : "4x5 Stock Bag",
      source: BAG_ARTBOARD_SOURCE,
      labelSet: null,
      standard: { label: { widthIn: BAG_4X5_ARTBOARD_IN.widthIn, heightIn: BAG_4X5_ARTBOARD_IN.heightIn } },
      customSize: false,
      override: {},
      overriddenPieces: [],
      overrideReason: null,
    };
  }

  const allBlockers = Array.from(new Set([...blockers, ...trueCost.blockers]));
  const status: TrueCostStatus = allBlockers.length
    ? "DRAFT_ONLY"
    : trueCost.status;

  return {
    version: CANONICAL_CALCULATOR_VERSION,
    family: input.family,
    status,
    unitCost: status === "DRAFT_ONLY" ? null : trueCost.unitCost,
    totalCost: trueCost.totalCost,
    trueCost,
    diagnostics,
    routing,
    inkChannels,
    calibration: {
      resolved: machine.calibration != null,
      identity: calibrationIdentityOf(input),
      message: machine.calibrationMessage,
      inkCostPerMl: machine.inkCostPerMl,
      inkCostSource: machine.inkCostSource,
    },
    setupBasis: {
      artBasis: setup.artBasis ?? "PER_DESIGN",
      printBasis: setup.printBasis ?? "PER_DESIGN",
      specialtyBasis: setup.specialty != null ? (setup.specialtyBasis ?? "PER_DESIGN") : null,
    },
    adapter: { label, bag, banner, application },
    reasons: Array.from(new Set(reasons)),
    blockers: allBlockers,
  };
}

/** Verified roll cost for bag-label media. */
const LABEL_MEDIA_PER_SQFT = 213 / ((54 / 12) * 150);

/**
 * Map a FinishingResult onto engine stages, preserving category AND basis.
 *
 * 2C-3 deliberately keeps the cutter's two burdens separate and separately
 * adjustable, exactly like the printer's: cutter OCCUPANCY posts as
 * machine_recovery and cutter OPERATOR ATTENTION as run_labor. Burying either
 * in finishing would make cut time invisible next to print time.
 *
 * `includeWeeding` is false for families that are trimmed rather than weeded
 * (banners), so no $0 weeding line is emitted to imply the step happened.
 */
function canonicalFinishingStages(
  f: { stages: Array<{ key: string; label: string; amount: number; formula?: string; note?: string; provisional?: string; blocker?: string }> },
  options: { includeWeeding: boolean },
): NonNullable<TrueCostInput["finishingStages"]> {
  return f.stages
    .filter((stage) => (options.includeWeeding ? true : !/weed/i.test(stage.key)))
    .map((stage) => {
      const isWeeding = /weed/i.test(stage.key);
      const isAttention = /attention/i.test(stage.key);
      // "cutting_machine" is cutter OCCUPANCY — equipment recovery, not finishing.
      const isCutterOccupancy = /cut/i.test(stage.key) && /machine|equip/i.test(stage.key);
      return {
        key: stage.key,
        label: stage.label,
        amount: stage.amount,
        category: isCutterOccupancy
          ? ("machine_recovery" as const)
          : isAttention
            ? ("run_labor" as const)
            : ("finishing_application" as const),
        basis: isWeeding ? ("PER_AREA" as const) : ("PER_CUT_PATH" as const),
        formula: stage.formula,
        note: stage.note,
        provisional: stage.provisional,
        blocker: stage.blocker,
      };
    });
}

/** Pull machine minutes back out of the engine's own recovery line. */
function machineMinutesFrom(result: TrueCostResult): number | null {
  const line = result.lines.find((l) => l.key === "machine");
  if (!line || line.blocker) return null;
  const match = /—\s*([\d.]+)\s*min/.exec(line.label);
  return match ? Number(match[1]) : null;
}

/* ------------------------------------------------------------------ *
 * The async wrapper routes call
 * ------------------------------------------------------------------ */

/**
 * Narrow the authoritative server result down to what the UI may see.
 *
 * The browser gets numbers the server already computed and nothing it could
 * recompute from — no adapter objects, no engine input. Keeps the "browser
 * owns no authoritative math" rule true by construction.
 */
export function canonicalViewOf(result: CanonicalCalculatorResult): CanonicalCalculatorView {
  return {
    version: result.version,
    family: result.family,
    status: result.status,
    unitCost: result.unitCost,
    totalCost: result.totalCost,
    lines: result.trueCost.lines,
    totals: result.trueCost.totals,
    diagnostics: result.diagnostics,
    calibration: {
      resolved: result.calibration.resolved,
      identity: { ...result.calibration.identity } as Record<string, string>,
      message: result.calibration.message,
      inkCostPerMl: result.calibration.inkCostPerMl,
      inkCostSource: result.calibration.inkCostSource,
    },
    setupBasis: result.setupBasis,
    reasons: result.reasons,
    blockers: result.blockers,
  };
}

export async function computeCanonicalJob(
  deps: { db: any; shop: string; at?: Date },
  input: CanonicalCalculatorInput,
): Promise<CanonicalCalculatorResult> {
  // 2D-4C1 DEFECT FIX: resolve from the FULL job input, never from a bare
  // identity. Passing calibrationIdentityOf(input) here took the back-compat
  // branch, which returns inkCostPerMl: null and no channels/routing — so
  // EVERY canonical job reported MISSING_INK_PRICE and no specialty channel
  // was ever resolved. The job input is what carries the routing.
  const machine = await resolveCanonicalMachineInputs(deps, input);
  return assembleCanonicalJob(input, machine);
}

/* ------------------------------------------------------------------ *
 * Normalisation — ONE reader, so loader and action cannot diverge
 * ------------------------------------------------------------------ */

const num = (params: URLSearchParams, key: string, fallback = 0) => {
  const raw = params.get(key);
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const str = (params: URLSearchParams, key: string, fallback = "") => (params.get(key) ?? fallback).trim();
const flag = (params: URLSearchParams, key: string) => params.get(key) === "1";

/** Map the UI family value onto a canonical family, or null when unsupported. */
export function canonicalFamilyFromUi(uiFamily: string, stockBag: boolean): CanonicalFamily | null {
  if (uiFamily === "stickers-labels") return "stickers-labels";
  if (uiFamily === "banners") return "banners";
  if (uiFamily === "sticker-bags") return stockBag ? "stock-bags" : "sticker-bags";
  // 2D-4D1: jars route canonically for their ACTIVE scope.
  if (uiFamily === "standard-jars" || uiFamily === "premium-jars") return uiFamily;
  return null;
}

/**
 * Build the canonical input from the calculator query string.
 *
 * THIS IS THE PARITY GUARANTEE. The loader passes its own URL params; the
 * action passes the replayed `psearch` it received. Identical bytes in,
 * identical input out — there is no second construction to drift from.
 */
/**
 * 2026-10-05 — reads the CUSTOM SIZE OVERRIDE fields exactly as typed. A piece
 * is present only when at least one of its fields was supplied, so a half-typed
 * piece arrives as a partial object and the assembler can refuse it by name.
 * Non-numeric text becomes NaN on purpose (validateJarGeometryOverride rejects it).
 */
function jarOverrideFromParams(params: URLSearchParams): JarGeometryOverride | null {
  const raw = (name: string): number | undefined => {
    const v = params.get(name);
    if (v == null || String(v).trim() === "") return undefined;
    return Number(v);
  };
  const out: JarGeometryOverride = {};
  const sideW = raw("pjarsidew"), sideH = raw("pjarsideh");
  if (sideW !== undefined || sideH !== undefined) out.side = { widthIn: sideW as number, heightIn: sideH as number };
  const lidD = raw("pjarlidd");
  if (lidD !== undefined) out.lid = { diameterIn: lidD };
  const tamperW = raw("pjartamperw"), tamperH = raw("pjartamperh");
  if (tamperW !== undefined || tamperH !== undefined) out.tamper = { widthIn: tamperW as number, heightIn: tamperH as number };
  return Object.keys(out).length ? out : null;
}

/**
 * 2026-10-05 — finishing decomposition from the engine's OWN lines. Each
 * bucket is a sum of existing line keys; no split is estimated.
 */
function finishingBreakdownFrom(trueCost: TrueCostResult): CanonicalFinishingBreakdown {
  const sum = (keys: string[]) => trueCost.lines.filter((l) => keys.includes(l.key)).reduce((t, l) => t + (Number(l.amount) || 0), 0);
  const basis = {
    cuttingMachine: ["cutting_machine"],
    cuttingAttention: ["cutting_attention"],
    weeding: ["weeding"],
    application: ["application"],
    specialtySetup: ["specialty_setup"],
  };
  const cuttingMachine = sum(basis.cuttingMachine);
  const cuttingAttention = sum(basis.cuttingAttention);
  const weeding = sum(basis.weeding);
  const application = sum(basis.application);
  const specialtySetup = sum(basis.specialtySetup);
  return { cuttingMachine, cuttingAttention, weeding, application, specialtySetup, total: cuttingMachine + cuttingAttention + weeding + application + specialtySetup, basis };
}

export function normalizeCanonicalInput(params: URLSearchParams): CanonicalCalculatorInput | null {
  const family = canonicalFamilyFromUi(str(params, "pfamily"), flag(params, "pstockbag"));
  if (!family) return null;

  const base = {
    family,
    quantity: Math.max(0, Math.floor(num(params, "pqty", 0))),
    // Absent means "use the family's own planned-overage standard" (the
    // assembler decides), not "zero" — jars carry a verified 1% owner rule.
    ...(params.get("poverage") ? { overagePct: num(params, "poverage", 0) } : {}),
    // 2D-4A — OPERATOR FIELDS ONLY. The calibration identity (ripProfile,
    // qualityMode, resolution, passConfig, inkMode, machineKey) is DERIVED
    // by machine-routing.server.ts; none of it is read from the query string,
    // so an operator can never type a calibration internal and never has to.
    printerSelection: str(params, "pprinter") || "auto",
    whiteLayers: Math.max(0, Math.floor(num(params, "pwhitelayers", 0))),
    whiteCoveragePct: String(params.get("pwhitecoverage") ?? "").trim() !== "" ? num(params, "pwhitecoverage") : null,
    glossLayers: Math.max(0, Math.floor(num(params, "pglosslayers", 0))),
    glossCoveragePct: String(params.get("pglosscoverage") ?? "").trim() !== "" ? num(params, "pglosscoverage") : null,
    cmykCoveragePct: String(params.get("pcmykcoverage") ?? "").trim() !== "" ? num(params, "pcmykcoverage") : null,
    cutMode: (str(params, "pcutmode") || "normal") as CutMode,
    loadedMediaWidthIn: params.get("pmediawidth") ? num(params, "pmediawidth") : undefined,
  } satisfies Partial<CanonicalCalculatorInput> as CanonicalCalculatorInput;

  if (family === "stickers-labels") {
    const lineCount = Math.max(1, Math.min(9, Math.floor(num(params, "pllines", 1))));
    const lines: LabelLine[] = [];
    for (let i = 0; i < lineCount; i += 1) {
      const q = Math.max(0, Math.floor(num(params, `pl${i}qty`, 0)));
      if (q <= 0) continue;
      // 2D-4C2A: the cutline is DERIVED from the artboard by the GSO
      // -0.0625in offset rule, never typed by an operator. One authority, so a
      // hand-entered value cannot disagree with what production actually cuts.
      const printW = num(params, `pl${i}w`, 0);
      const printH = num(params, `pl${i}h`, 0);
      const derivedCut = deriveGsoLabelCutlineFromArtboard(printW, printH);
      const cutW = derivedCut?.cutWidthIn;
      const cutH = derivedCut?.cutHeightIn;
      lines.push({
        key: `line-${i}`,
        quantity: q,
        printWidthIn: printW,
        printHeightIn: printH,
        ...(cutW != null ? { cutWidthIn: cutW } : {}),
        ...(cutH != null ? { cutHeightIn: cutH } : {}),
        ...(params.get(`pl${i}perim`) ? { contourPerimeterIn: num(params, `pl${i}perim`) } : {}),
        ...(params.get(`pl${i}shapearea`) ? { shapeAreaSqIn: num(params, `pl${i}shapearea`) } : {}),
        cutType: (str(params, `pl${i}cuttype`) || "rectangular") as LabelLine["cutType"],
        materialKey: str(params, `pl${i}mat`, "matte"),
        artworkKey: str(params, `pl${i}art`) || undefined,
        ...(params.get(`pl${i}extraart`) ? { additionalArtSetupEvents: Math.floor(num(params, `pl${i}extraart`)) } : {}),
        ...(params.get(`pl${i}printsetups`) ? { printSetupEvents: Math.floor(num(params, `pl${i}printsetups`)) } : {}),
      });
    }

    const mode = str(params, "papplymode", "none");
    const application: LabelApplicationInput | undefined =
      mode === "customer_provided_item" || mode === "custom_item"
        ? {
            mode,
            itemDescription: str(params, "papplyitem", "item"),
            itemQuantity: Math.max(0, Math.floor(num(params, "papplyitemqty", 0))),
            applicationsPerItem: Math.max(0, Math.floor(num(params, "papplyper", 1))),
            applicationSecondsPerEvent: num(params, "papplysec", 0),
            ...(mode === "custom_item" ? { customItemUnitCost: params.get("papplyitemcost") ? num(params, "papplyitemcost") : null } : {}),
            printedLabels: 0, // filled in by the assembler from the label job
          } as LabelApplicationInput
        : undefined;

    // 2D-4E1: the job's FINISHED quantity is the sum of the ENTERED physical
    // lines whenever more than one line exists. `pqty` mirrors Line 1 only, so
    // dividing a multi-line job total by it misstated the canonical unit cost
    // (and the per-finished-unit application basis). Line quantities are read
    // exactly as typed — nothing is redistributed.
    const enteredTotal = lines.reduce((s, l) => s + l.quantity, 0);
    return {
      ...base,
      quantity: lines.length > 1 ? enteredTotal : base.quantity > 0 ? base.quantity : enteredTotal,
      labels: {
        lines,
        application,
        specialtyPrepEvents: params.get("pfileprep") === "1" ? Math.max(1, Math.floor(num(params, "pfileprepevents", 1))) : 0,
      },
    };
  }

  if (family === "sticker-bags" || family === "stock-bags") {
    return {
      ...base,
      bags: {
        sides: (Math.floor(num(params, "pbagsides", 1)) === 2 ? 2 : 1) as BagSides,
        designs: Math.max(0, Math.floor(num(params, "pdesigns", 1))),
        personalization: flag(params, "pperslogo") || flag(params, "ppersqr")
          ? {
              logo: flag(params, "pperslogo"),
              qr: flag(params, "ppersqr"),
              personalizedDesignCount: params.get("ppersdesigns")
                ? Math.floor(num(params, "ppersdesigns", 1))
                : undefined,
            }
          : undefined,
        blankUnitCost: params.get("pblankcost") ? num(params, "pblankcost") : null,
      },
    };
  }

  if (family === "standard-jars" || family === "premium-jars") {
    /* 2D-4D1. The form mirrors the operator's jar choices into these fields
     * exactly the way the label form mirrors pl0*, so the loader and the save
     * path normalise the same bytes.
     *
     * "pjar" is the ACTIVE profile key ("miron/100ml_wide"). An unknown or
     * missing key is passed through as-is rather than defaulted, because the
     * assembler must refuse a jar GSO does not offer — quietly substituting a
     * neighbouring size would invent a price. */
    const [brandPart, sizePart] = str(params, "pjar").split("/");
    return {
      ...base,
      jar: {
        brand: (brandPart || "") as JarBrand,
        size: (sizePart || "") as JarSizeKey,
        ...(str(params, "pjarvariant") ? { variant: str(params, "pjarvariant") as StandardJarVariant } : {}),
        selection: {
          side: flag(params, "pjarside"),
          lid: flag(params, "pjarlid"),
          tamper: flag(params, "pjartamper"),
        },
        // Label rows whose type has no verified jar geometry. Carried through
        // so the job BLOCKS — a dropped row would silently under-cost a whole
        // label per jar.
        unsupportedLabels: (str(params, "pjarunsupported") || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        designs: params.get("pdesigns") ? Math.max(0, Math.floor(num(params, "pdesigns", 1))) : undefined,
        // 2026-10-05 CUSTOM SIZE OVERRIDE — raw values pass through untouched;
        // the assembler validates and fails closed. Nothing is defaulted here.
        labelSet: str(params, "pjarset") || null,
        customSize: flag(params, "pjarcustom"),
        geometryOverride: jarOverrideFromParams(params),
        overrideReason: str(params, "pjaroverridereason") || null,
      },
    };
  }

  return {
    ...base,
    banner: {
      widthIn: num(params, "pbannerw", 0),
      heightIn: num(params, "pbannerh", 0),
      edge: (str(params, "pbanneredge", "TRIM_ONLY") as BannerEdge),
      grommets: (str(params, "pbannergrommets", "NONE") as BannerGrommets),
      polePockets: (str(params, "pbannerpockets", "NONE") as BannerPolePockets),
      sides: (str(params, "pbannersides", "SINGLE") as BannerSides),
      designs: Math.max(0, Math.floor(num(params, "pdesigns", 1))),
    },
  };
}

/**
 * Rebuild a canonical input at a DIFFERENT quantity — for a tier ladder.
 *
 * Each family carries its quantity somewhere different, and getting this wrong
 * is silent: bags and banners read the top-level `quantity`, but a LABEL job
 * reads `labels.lines[].quantity` and ignores the top level for material, ink
 * and nesting. Overriding only the top level therefore produced an identical
 * job cost at every rung of a label ladder. This function is the one place
 * that knows the difference.
 *
 * RETURNS null WHEN THE JOB CANNOT BE RE-QUANTIFIED.
 *
 * 2D-4C1A FIX 2 — a MULTI-LINE label job is exactly that case. Splitting a new
 * total across several customer-entered lines would require an allocation rule
 * (which line grows? in what ratio?) that no owner has approved, and each
 * physical line is independently costed for material, nesting, ink, machine,
 * cutting and weeding. So the entered line quantities are never redistributed:
 * only the job AS ENTERED is quotable, and alternate ladder rungs are
 * suppressed by the caller rather than invented here.
 */
export function canonicalInputForQuantity(
  input: CanonicalCalculatorInput,
  quantity: number,
): CanonicalCalculatorInput | null {
  const target = Math.max(0, Math.floor(quantity));
  if (input.family !== "stickers-labels") return { ...input, quantity: target };

  const lines = input.labels?.lines ?? [];
  if (!lines.length) return { ...input, quantity: target };

  // A single physical line IS the job, so its quantity may simply become the
  // tier quantity — no allocation decision is involved.
  if (lines.length === 1) {
    return { ...input, quantity: target, labels: { ...input.labels!, lines: [{ ...lines[0], quantity: target }] } };
  }

  // Multi-line: only the entered quantities are valid.
  const entered = lines.reduce((sum, line) => sum + Math.max(0, line.quantity), 0);
  return target === entered ? input : null;
}

/** Can this job produce an alternate-quantity tier ladder at all? */
export function canonicalSupportsTierLadder(input: CanonicalCalculatorInput | null | undefined): boolean {
  if (!input) return true; // unsupported families keep their existing ladder
  if (input.family !== "stickers-labels") return true;
  return (input.labels?.lines?.length ?? 0) <= 1;
}

/** Re-exported so a caller never has to reach into ink-rates-shared itself. */
export { CANONICAL_INK_RATES };
