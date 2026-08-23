// Patch 2D-3A (17D.6) — canonical BANNER true-cost adapter.
//
// Banners are NOT labels: they are printed and trimmed, never weeded.
//
// 2D-3A CORRECTION — material is ACTUAL MEDIA CONSUMED, not finished area.
// A banner runs down a 54in roll, so a 36in-wide banner leaves ~18in of the
// web unused and that width is still consumed. The canonical nesting engine
// owns that number; there is deliberately NO banner-specific layout formula.
//
//   FINISHED / INKABLE   w x h x qty        -> ink
//   RIP LAYOUT           nest box x feed    -> printer occupancy
//   MEDIA CONSUMED       roll width x feed  -> material cost
//
// A 3x5 banner is 15 finished sqft but consumes 22.5 sqft of a 54in roll.
// Treating the unused web as free would understate material by 50%.
//
// TRIM is machine cutting, not hand labor: the repo already routes banner trim
// through the square/rectangle CUT path ("banner trim use the square/rectangle
// standard automatically (simple shapes cut in-line)" —
// product-driven-costing.server.ts), and the UCJV300 is a print/cut unit. So
// trim costs cutter time through the canonical cutting engine, using the
// banner's finished size as its cutline. The RATE, however, was measured on
// 130 small labels with constant direction changes; a banner is four long
// straight strokes, so the rate is flagged rather than presented as measured.
//
// TRUE COST ONLY. No selling price, no margin, no competitor number.
//
// Pure: no db, no network, no clock.

import { APPROVED_ROLL_COSTS } from "./approved-cost-updates.server";
import { computeNesting, resolveNestingPolicy, type NestingResult, type NestingRun } from "./nesting-engine.server";
import { computeFinishing, type CutMode, type FinishingResult } from "./finishing-cost.server";
import { OWNER_STANDARDS } from "./owner-standards";
import { SETUP_BASIS, type CostBasis } from "./true-cost-engine.server";

export const BANNER_COST_INPUTS_VERSION = "17D.6A-banner-cost-inputs";

/** Verified. Preserved exactly as the repo derives it. */
export const BANNER_VINYL_PER_SQFT = APPROVED_ROLL_COSTS.bannerVinylPerSqft; // 0.2962962963
export const BANNER_ROLL_WIDTH_IN = 54;

/** Banners are trimmed, not weeded. */
export const BANNER_REQUIRES_WEEDING = false;

export const BANNER_REASONS = {
  materialCostRequired: "BANNER_MATERIAL_COST_REQUIRED",
  finishingRateRequired: "BANNER_FINISHING_RATE_REQUIRED",
  trimRateRequired: "BANNER_TRIM_RATE_REQUIRED",
  routeRequired: "BANNER_ROUTE_REQUIRED",
  sizeRequired: "BANNER_SIZE_REQUIRED",
  doubleSidedUnsupported: "BANNER_DOUBLE_SIDED_UNSUPPORTED",
} as const;

export type BannerEdge = "TRIM_ONLY" | "HEMMED";
export type BannerGrommets = "NONE" | "FOUR_CORNERS" | "EVERY_24_INCHES";
export type BannerPolePockets = "NONE" | "TOP" | "TOP_AND_BOTTOM";
export type BannerSides = "SINGLE" | "DOUBLE";

/**
 * Which OPTIONAL operations have a defensible rate. Everything false is
 * reported with the exact owner measurement needed, never priced.
 */
export const BANNER_FINISHING_SUPPORT = {
  HEMMED: { verified: false, ownerInputNeeded: "seconds per linear foot of hem, plus hem-tape $/ft" },
  GROMMETS: { verified: false, ownerInputNeeded: "seconds per grommet, plus grommet consumable $ each" },
  POLE_POCKETS: { verified: false, ownerInputNeeded: "seconds per linear foot of pole pocket, plus any material" },
  TUBE_PACKOUT: { verified: false, ownerInputNeeded: "tube cost and banners per tube" },
  DOUBLE_SIDED: { verified: false, ownerInputNeeded: "confirmation the banner media/process supports double-sided at all, then its second-pass cost" },
} as const;

export type BannerJobInput = {
  widthIn: number;
  heightIn: number;
  quantity: number;
  edge?: BannerEdge;
  grommets?: BannerGrommets;
  polePockets?: BannerPolePockets;
  sides?: BannerSides;
  designs?: number;
  machineKey?: string;
  cutMode?: CutMode;
  loadedMediaWidthIn?: number;
};

export type BannerCostResult = {
  version: string;
  widthIn: number;
  heightIn: number;
  quantity: number;
  /** Finished / inkable artwork area — the INK basis. */
  finishedSqft: number;
  /** Actual roll media consumed — the MATERIAL basis. */
  mediaSqft: number;
  /** Printer occupancy basis. */
  ripLayoutSqft: number;
  feedLengthIn: number;
  nestWidthIn: number;
  columns: number;
  rows: number;
  rotated: boolean;
  materialCost: number;
  materialCostPerSqft: number;
  machineKey: string;
  nesting: NestingResult | null;
  /** Trim = machine cutting through the canonical engine. */
  finishing: FinishingResult | null;
  /** Art AND print are both PER_DESIGN. Copy quantity never enters either. */
  setup: { art: number; print: number; total: number; designs: number; artBasis: CostBasis; printBasis: CostBasis };
  requiresWeeding: false;
  unverifiedSelections: Array<{ option: string; reason: string; ownerInputNeeded: string }>;
  reasons: string[];
  blockers: string[];
};

/** CMYK-only defaults to the Mimaki; Roland is White/Gloss, explicit, or overflow. */
export function resolveBannerMachine(input: { machineKey?: string }): string {
  return input.machineKey ?? "mimaki-ucjv300-130";
}

export function computeBannerCost(input: BannerJobInput): BannerCostResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const unverifiedSelections: BannerCostResult["unverifiedSelections"] = [];

  const widthIn = Number(input.widthIn) || 0;
  const heightIn = Number(input.heightIn) || 0;
  const quantity = Math.max(0, Math.floor(input.quantity));
  const machineKey = resolveBannerMachine(input);
  const mediaWidthIn = input.loadedMediaWidthIn ?? BANNER_ROLL_WIDTH_IN;

  const sizeOk = widthIn > 0 && heightIn > 0 && quantity > 0;
  if (!sizeOk) {
    reasons.push(BANNER_REASONS.sizeRequired);
    blockers.push(`${BANNER_REASONS.sizeRequired}: a banner needs a positive width, height and quantity.`);
  }

  const finishedSqft = (widthIn * heightIn * quantity) / 144;

  // ---- MEDIA: the canonical nesting engine owns it. No banner-specific formula.
  let nesting: NestingResult | null = null;
  const policy = resolveNestingPolicy({ machineKey, loadedMediaWidthIn: mediaWidthIn });
  if (!policy.ok) {
    reasons.push(BANNER_REASONS.routeRequired);
    blockers.push(`${policy.blocker}: ${policy.message}`);
  } else if (sizeOk) {
    const run: NestingRun = {
      key: "banner-run",
      label: "Banner print run",
      items: [{ key: "banner", groupKey: "banner", shapeType: "rect", widthIn, heightIn, quantity, allowRotate: true }],
    };
    nesting = computeNesting([run], policy.policy);
    if (!nesting.ok) {
      reasons.push(BANNER_REASONS.sizeRequired);
      blockers.push(...nesting.blockers);
    }
  }

  const band = nesting?.runs[0]?.bands[0] ?? null;
  const mediaSqft = nesting?.materialFootprintSqft ?? 0;
  const materialCost = mediaSqft * BANNER_VINYL_PER_SQFT;

  // ---- TRIM: machine cutting on the banner's finished size as its cutline.
  let finishing: FinishingResult | null = null;
  if (nesting && nesting.ok) {
    finishing = computeFinishing({
      nesting,
      machineKey,
      cutMode: input.cutMode ?? "normal",
      cutGeometry: {
        banner: {
          model: "separated_rectangle",
          cutWidthIn: widthIn,
          cutHeightIn: heightIn,
          note: "Banner trim: the finished size IS the cutline. Cut in-line on the print/cut unit, not by hand.",
        },
      },
      requiresWeeding: BANNER_REQUIRES_WEEDING,
    });
    // The cut RATE came from 130 small labels, not long banner strokes.
    reasons.push(BANNER_REASONS.trimRateRequired);
  }

  const note = (option: keyof typeof BANNER_FINISHING_SUPPORT, label: string) => {
    const support = BANNER_FINISHING_SUPPORT[option];
    if (support.verified) return;
    reasons.push(BANNER_REASONS.finishingRateRequired);
    unverifiedSelections.push({
      option: label,
      reason: `${BANNER_REASONS.finishingRateRequired}: no defensible rate exists for ${label}. The historical value is self-labelled provisional and sits on a superseded labor basis, so it is not promoted to canonical.`,
      ownerInputNeeded: support.ownerInputNeeded,
    });
    blockers.push(`${BANNER_REASONS.finishingRateRequired}: ${label} was selected but has no verified rate. Needed: ${support.ownerInputNeeded}.`);
  };

  if ((input.edge ?? "TRIM_ONLY") === "HEMMED") note("HEMMED", "hemming");
  if ((input.grommets ?? "NONE") !== "NONE") note("GROMMETS", `grommets (${input.grommets})`);
  if ((input.polePockets ?? "NONE") !== "NONE") note("POLE_POCKETS", `pole pockets (${input.polePockets})`);
  if ((input.sides ?? "SINGLE") === "DOUBLE") {
    reasons.push(BANNER_REASONS.doubleSidedUnsupported);
    unverifiedSelections.push({
      option: "double-sided",
      reason: `${BANNER_REASONS.doubleSidedUnsupported}: nothing in the repo proves the banner media/process supports double-sided printing.`,
      ownerInputNeeded: BANNER_FINISHING_SUPPORT.DOUBLE_SIDED.ownerInputNeeded,
    });
    blockers.push(`${BANNER_REASONS.doubleSidedUnsupported}: double-sided banners are not proven supported. Needed: ${BANNER_FINISHING_SUPPORT.DOUBLE_SIDED.ownerInputNeeded}.`);
  }

  // 2D-3C owner decision: print setup is PER DESIGN ($25/hr at 25 designs/hr),
  // not once per job. Banner copy quantity enters neither number.
  const designs = Math.max(0, Math.floor(input.designs ?? 1));
  const art = designs * OWNER_STANDARDS.artSetupPerDesign.value;
  const print = designs * OWNER_STANDARDS.printSetupPerDesign.value;

  return {
    version: BANNER_COST_INPUTS_VERSION,
    widthIn, heightIn, quantity,
    finishedSqft,
    mediaSqft,
    ripLayoutSqft: nesting?.ripLayoutSqft ?? 0,
    feedLengthIn: nesting?.runs[0]?.feedLengthIn ?? 0,
    nestWidthIn: band?.nestWidthIn ?? 0,
    columns: band?.columns ?? 0,
    rows: band?.rows ?? 0,
    rotated: band?.rotated ?? false,
    materialCost,
    materialCostPerSqft: BANNER_VINYL_PER_SQFT,
    machineKey,
    nesting,
    finishing,
    setup: { art, print, total: art + print, designs, artBasis: SETUP_BASIS, printBasis: SETUP_BASIS },
    requiresWeeding: BANNER_REQUIRES_WEEDING,
    unverifiedSelections,
    reasons: Array.from(new Set(reasons)),
    blockers,
  };
}
