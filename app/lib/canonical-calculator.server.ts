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
import { CANONICAL_INK_RATES } from "./ink-rates-shared";
import {
  resolveCanonicalMachineRouting,
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
});

export function assembleCanonicalJob(
  input: CanonicalCalculatorInput,
  machine: ResolvedMachineInputs,
): CanonicalCalculatorResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const diagnostics = EMPTY_DIAGNOSTICS();

  const finished = Math.max(0, Math.floor(input.quantity));
  const overagePct = input.overagePct ?? 0;
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
      source: "Owner canonical 2026-08-22: $0.11 each.",
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

  /* ---------------- shared diagnostics ---------------- */
  diagnostics.mediaConsumedSqft = areas.materialFootprintSqft;
  diagnostics.ripLayoutSqft = areas.ripLayoutSqft;
  diagnostics.inkableArtworkSqft = areas.inkableArtworkSqft;

  /* ---------------- material / packout / freight ---------------- */
  if (materialCostPerSqft == null || !(materialCostPerSqft > 0)) {
    reasons.push(CANONICAL_REASONS.materialCostRequired);
  }

  if (unitsPerBox == null) {
    reasons.push(CANONICAL_REASONS.packoutNotModeled);
  }
  const packout: TrueCostInput["packout"] =
    unitsPerBox == null
      ? { boxes: 0, unitsPerBox: 1, cost: 0 }
      : { unitsPerBox, laborPerBox: OWNER_STANDARDS.packoutPerBox.value, consumablesPerBox: 0 };

  reasons.push(CANONICAL_REASONS.freightNotModeled);

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
    freight: {
      perUnit: 0,
      basis: "NO_SEPARATE_INBOUND_FREIGHT",
      provisional: false,
      source: "Roll media is priced delivered (invoice cost / roll area), so it carries no separate inbound freight line. Blank-bag inbound freight is not modeled by the canonical adapter yet.",
    },
    finishingStages,
  };

  const trueCost = computeTrueJobCost(trueCostInput);
  diagnostics.machineMinutes = machineMinutesFrom(trueCost);

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
  const machine = await resolveCanonicalMachineInputs(deps, calibrationIdentityOf(input));
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
  return null;
}

/**
 * Build the canonical input from the calculator query string.
 *
 * THIS IS THE PARITY GUARANTEE. The loader passes its own URL params; the
 * action passes the replayed `psearch` it received. Identical bytes in,
 * identical input out — there is no second construction to drift from.
 */
export function normalizeCanonicalInput(params: URLSearchParams): CanonicalCalculatorInput | null {
  const family = canonicalFamilyFromUi(str(params, "pfamily"), flag(params, "pstockbag"));
  if (!family) return null;

  const base = {
    family,
    quantity: Math.max(0, Math.floor(num(params, "pqty", 0))),
    overagePct: num(params, "poverage", 0),
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
      const cutW = params.get(`pl${i}cutw`) ? num(params, `pl${i}cutw`) : undefined;
      const cutH = params.get(`pl${i}cuth`) ? num(params, `pl${i}cuth`) : undefined;
      lines.push({
        key: `line-${i}`,
        quantity: q,
        printWidthIn: num(params, `pl${i}w`, 0),
        printHeightIn: num(params, `pl${i}h`, 0),
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

    return {
      ...base,
      quantity: base.quantity > 0 ? base.quantity : lines.reduce((s, l) => s + l.quantity, 0),
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

/** Re-exported so a caller never has to reach into ink-rates-shared itself. */
export { CANONICAL_INK_RATES };
