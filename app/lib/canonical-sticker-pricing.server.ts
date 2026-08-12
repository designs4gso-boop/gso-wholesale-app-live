// Phase 16F — canonical sticker/label storefront pricing.
//
// NO NEW PRICING SYSTEM: this wraps the SAME two engines every ERP quote
// uses — computeProductDrivenCost (owner-verified area costs: material $/sqft
// from the Material Center, ink, Mimaki/Roland machine recovery, owner cut
// page standard + contour bands, weeding, art/print/gloss-mask setup) and
// computeCommercialPrice (owner margin curves "stickers-labels" /
// "spot-gloss-labels", sticker AREA market floor, minimum-job policy).
// Exactly the architecture the canonical bag engine uses (15G.2 pattern).
//
// Pricing is DIMENSION-DRIVEN: the server recomputes width x height — the
// client's area math is never trusted. Fail-closed: any missing cost input
// from the engine refuses to price instead of guessing.

import {
  computeProductDrivenCost,
  DOCUMENTED_PRINTER_SQFT_PER_HOUR,
} from "./product-driven-costing.server";
import {
  computeCommercialPrice,
  marginCurveKeyFor,
  specialtyFinishReasons,
  type PricingPolicyValues,
} from "./commercial-pricing-policy.server";
import { resolveMarginFamily } from "./calculator-emergency.server";
import { resolvePrintMaterialCostPerSqft } from "./cost-calculator.server";
import { OWNER_STANDARDS } from "./owner-standards";
import { resolvePricingPolicyConfig } from "./owner-config.server";

export const STICKER_PRICING_VERSION = "16F.1-sticker-canonical";
export const STICKER_PRICING_ENGINE = "canonical-sticker-pricing/16F.1";

// 16F.1 OWNER RULE: holographic stickers must never sell at the matte price
// just because both hit the same market floor. Customer SELL floor only —
// HOLO = MAX(canonical holo price, equivalent-Matte price x 1.20); an
// engine-derived HIGHER holo price always wins. Cost accounting untouched.
export const STICKER_HOLO_MIN_PREMIUM_PCT = 0.2;

export const STICKER_STOREFRONT_MIN_QTY = 50;
export const STICKER_VOLUME_QUOTE_FROM = 5000; // above this -> quote
export const STICKER_QUANTITY_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000];
// Online dimension bounds (production-safe launch window; larger = quote).
export const STICKER_MIN_DIM_IN = 0.5;
export const STICKER_MAX_DIM_IN = 12;

export const STICKER_MATERIAL_OPTIONS = ["Matte", "Holographic"];

// Universal GSO specialty vocabulary, sticker ladder (16F). Pricing stays
// AREA-DRIVEN through the cost engine — X maps to printed gloss layers, so
// bigger stickers cost more per layer automatically; the ladder is language,
// never a per-unit surcharge. The 0X label avoids router tokens.
export const STICKER_SPECIALTY_LADDER: Array<{ x: number; label: string }> = [
  { x: 0, label: "Standard — 0X" },
  { x: 1, label: "Spot Gloss — 1X" },
  { x: 2, label: "Raised — 2X" },
  { x: 3, label: "Raised+ — 3X" },
  { x: 4, label: "Heavy Raised — 4X" },
  { x: 5, label: "Ultra Layered — 5X" },
  { x: 6, label: "Ultra Layered+ — 6X" },
  { x: 7, label: "Extreme Layered — 7X" },
  { x: 8, label: "Maximum Layered — 8X" },
];
export const STICKER_DEEP_BUILD_LABEL = "Deep Build 9X+ — Request Custom Quote";
export const STICKER_SPECIALTY_OPTIONS = [
  ...STICKER_SPECIALTY_LADDER.map((entry) => entry.label),
  STICKER_DEEP_BUILD_LABEL,
];

export type StickerLaunchInfo = { stickerType: "regular" | "die_cut"; cutType: "square-rect" | "kiss-simple"; cutRequiresWeeding: boolean };

// ERP ConfiguratorProduct productTypes served by this engine. Die-cut sells
// the SIMPLE contour band online (owner-documented page standard x1.15 +
// weeding); moderate/complex contours and irregular die production remain
// quote-only.
export const STICKER_LAUNCH_TYPE_INFO: Record<string, StickerLaunchInfo> = {
  sticker_regular: { stickerType: "regular", cutType: "square-rect", cutRequiresWeeding: false },
  sticker_die_cut: { stickerType: "die_cut", cutType: "kiss-simple", cutRequiresWeeding: true },
};

export function stickerLaunchInfoForType(productType: string): StickerLaunchInfo | null {
  return STICKER_LAUNCH_TYPE_INFO[String(productType || "")] ?? null;
}

export function stickerSpecialtyForLabel(label: string): { x: number; label: string } | "deep_build" | null {
  const wanted = String(label ?? "").trim().toLowerCase();
  if (!wanted) return STICKER_SPECIALTY_LADDER[0];
  if (wanted === STICKER_DEEP_BUILD_LABEL.toLowerCase() || wanted.includes("9x")) return "deep_build";
  const exact = STICKER_SPECIALTY_LADDER.find((entry) => entry.label.toLowerCase() === wanted);
  if (exact) return exact;
  const match = wanted.match(/^(\d)x$/);
  if (match) return STICKER_SPECIALTY_LADDER.find((entry) => entry.x === Number(match[1])) ?? null;
  return null;
}

export type CanonicalStickerInputs = {
  available: boolean;
  reasons: string[];
  matte: { name: string; costPerSqft: number } | null;
  holographic: { name: string; costPerSqft: number } | null;
  rolandSqftPerHour: number;
  policyValues: PricingPolicyValues;
};

// Same Material Center resolution the canonical bag engine uses — the print
// vinyls ARE the sticker stock (owner rates live in the DB, never hardcoded).
export async function resolveCanonicalStickerInputs(db: any, shop: string): Promise<CanonicalStickerInputs> {
  const [materials, rolandMachine, policy] = await Promise.all([
    db.material.findMany({ where: { shop, active: true, useInRecipes: true }, take: 200 }),
    db.machine.findFirst({ where: { shop, active: true, name: { contains: "Roland" } }, select: { sqftPerHour: true } }),
    resolvePricingPolicyConfig(db, shop),
  ]);
  const reasons: string[] = [];
  const materialFor = (pattern: RegExp) => {
    const candidates = materials.filter((material: any) => pattern.test(String(material.name || "")));
    for (const candidate of candidates) {
      const resolved = resolvePrintMaterialCostPerSqft(candidate);
      if (resolved.unitCost > 0) return { name: String(candidate.name), costPerSqft: resolved.unitCost };
    }
    return null;
  };
  const matte = materialFor(/poseidon/i) || materialFor(/matte/i);
  if (!matte) reasons.push("No verified matte print material found (Poseidon/matte with a usable unit cost).");
  const holographic = materialFor(/holo/i);
  return {
    available: reasons.length === 0,
    reasons,
    matte,
    holographic,
    rolandSqftPerHour: Number(rolandMachine?.sqftPerHour) > 0 ? Number(rolandMachine?.sqftPerHour) : DOCUMENTED_PRINTER_SQFT_PER_HOUR,
    policyValues: policy.values,
  };
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function parseDim(value: unknown): number {
  const dim = Number(value);
  if (!Number.isFinite(dim)) return 0;
  return Math.round(dim * 100) / 100;
}

export type StickerSelection = {
  productType: string;
  widthIn: unknown;
  heightIn: unknown;
  quantity: number;
  material: string; // "Matte" | "Holographic"
  specialty: string; // ladder label
};

export type StickerPriceResult =
  | {
      ok: true;
      stickerType: "regular" | "die_cut";
      widthIn: number;
      heightIn: number;
      areaSqIn: number;
      quantity: number;
      material: "Matte" | "Holographic";
      holographic: boolean;
      whiteRequired: boolean;
      specialtyX: number;
      specialtyLabel: string;
      cutType: string;
      unitPrice: number;
      orderTotal: number;
      marginPctApplied: number;
      controllingRule: string;
      // 16F.1: owner holographic sell floor (MAX(canonical holo, matte x1.2)).
      holoFloorApplied: boolean;
      matteEquivalentUnit: number | null;
      version: string;
      engine: string;
    }
  | { ok: false; requestQuote: boolean; reason: string };

export function priceStickerConfiguration(inputs: CanonicalStickerInputs, selection: StickerSelection): StickerPriceResult {
  const info = stickerLaunchInfoForType(selection.productType);
  if (!info) return { ok: false, requestQuote: false, reason: "This sticker product is not available for online pricing yet." };
  if (!inputs.available) return { ok: false, requestQuote: false, reason: inputs.reasons.join("; ") || "Sticker pricing inputs unavailable." };

  const widthIn = parseDim(selection.widthIn);
  const heightIn = parseDim(selection.heightIn);
  if (!(widthIn >= STICKER_MIN_DIM_IN) || !(heightIn >= STICKER_MIN_DIM_IN)) {
    return { ok: false, requestQuote: false, reason: `Width and height must each be at least ${STICKER_MIN_DIM_IN}".` };
  }
  if (widthIn > STICKER_MAX_DIM_IN || heightIn > STICKER_MAX_DIM_IN) {
    return { ok: false, requestQuote: true, reason: `Stickers larger than ${STICKER_MAX_DIM_IN}" per side are quoted individually — please request a custom quote.` };
  }

  const quantity = Math.floor(Number(selection.quantity) || 0);
  if (quantity < STICKER_STOREFRONT_MIN_QTY) {
    return { ok: false, requestQuote: false, reason: `Minimum order is ${STICKER_STOREFRONT_MIN_QTY} stickers.` };
  }
  if (quantity > STICKER_VOLUME_QUOTE_FROM) {
    return { ok: false, requestQuote: true, reason: `Orders above ${STICKER_VOLUME_QUOTE_FROM.toLocaleString()} stickers are quoted individually — please request a volume quote.` };
  }

  const materialRaw = String(selection.material ?? "").trim() || "Matte";
  const holographic = /^holo/i.test(materialRaw);
  if (!holographic && !/^matte$/i.test(materialRaw)) {
    return { ok: false, requestQuote: false, reason: "Unknown material — choose Matte or Holographic." };
  }
  const material = holographic ? inputs.holographic : inputs.matte;
  if (!material) {
    return { ok: false, requestQuote: false, reason: holographic ? "No verified holographic material." : "No verified matte material." };
  }

  const specialty = stickerSpecialtyForLabel(selection.specialty);
  if (specialty === "deep_build") {
    return { ok: false, requestQuote: true, reason: "Deep Build 9X+ specialty work is quoted individually — please request a custom quote." };
  }
  if (!specialty) return { ok: false, requestQuote: false, reason: "Unknown specialty selection." };

  const glossLayers = specialty.x;
  // Technical white underbase for holographic vinyl only — production/cost
  // reality, never an exposed customer surcharge (owner white rule).
  const whiteLayers = holographic ? 1 : 0;
  const printer: "mimaki" | "roland" = glossLayers > 0 || whiteLayers > 0 || holographic ? "roland" : "mimaki";

  const run = computeProductDrivenCost({
    family: "stickers-labels",
    quantity,
    designs: 1,
    facesPerUnit: 1,
    widthIn,
    heightIn,
    labelRows: null,
    dtp: null,
    blank: null,
    lid: null,
    material: { name: material.name, costPerSqft: material.costPerSqft },
    printer,
    printerHasWhite: true,
    printerHasGloss: printer === "roland",
    whiteLayers,
    glossLayers,
    glossCoveragePct: null,
    inkMlPerSqft: 0.6,
    machineMinutesPerSqft: 0,
    machineSqftPerHour: printer === "roland" ? inputs.rolandSqftPerHour : 0,
    machineRatePerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
    cutType: info.cutType,
    cutRequiresWeeding: info.cutRequiresWeeding,
    hemming: false,
    grommets: false,
    freightPerUnit: 0,
    freightSource: "estimated",
    recipeWastePct: null,
    wasteOverride: null,
    boxOverride: null,
  } as any);

  if (run.missing.length) {
    return { ok: false, requestQuote: false, reason: `Cannot price this configuration: ${run.missing.join("; ")}` };
  }

  const marginRule = resolveMarginFamily("stickers-labels");
  const commercial = computeCommercialPrice({
    familyKey: "stickers-labels",
    quantity,
    completeCost: run.totalCost,
    marginRule,
    premiumEligible: false,
    finishedSqft: run.derived.baseSqft,
    setupTotal: run.setupTotal,
    policyValues: inputs.policyValues,
    marginCurveKey: marginCurveKeyFor("stickers-labels", 1),
    marketTargetSpecialtyReasons: specialtyFinishReasons({ whiteLayers, glossLayers, materialName: material.name }),
    specialty: {
      glossLayers,
      decorativeWhiteLayers: 0,
      requiredWhite: holographic && whiteLayers > 0,
      holographic,
    },
  });

  let unitPrice = money(commercial.finalTotalPrice / quantity);
  let controllingRule = commercial.controllingRule;
  let holoFloorApplied = false;
  let matteEquivalentUnit: number | null = null;

  // 16F.1: holographic customer sell floor — price the IDENTICAL
  // configuration (same dims/qty/specialty/cut) in Matte and enforce
  // HOLO >= MATTE x 1.20. Raise-only: an engine-derived higher holo price
  // always wins; matte pricing itself is never touched.
  if (holographic) {
    const matteResult = priceStickerConfiguration(inputs, { ...selection, material: "Matte" });
    if (matteResult.ok) {
      matteEquivalentUnit = matteResult.unitPrice;
      const floorUnit = money(matteResult.unitPrice * (1 + STICKER_HOLO_MIN_PREMIUM_PCT));
      if (floorUnit > unitPrice) {
        unitPrice = floorUnit;
        holoFloorApplied = true;
        controllingRule = `holographic minimum premium (matte x${1 + STICKER_HOLO_MIN_PREMIUM_PCT})`;
      }
    }
  }

  return {
    ok: true,
    stickerType: info.stickerType,
    widthIn,
    heightIn,
    areaSqIn: money(widthIn * heightIn),
    quantity,
    material: holographic ? "Holographic" : "Matte",
    holographic,
    whiteRequired: holographic,
    specialtyX: glossLayers,
    specialtyLabel: specialty.label,
    cutType: info.cutType,
    unitPrice,
    orderTotal: money(unitPrice * quantity),
    marginPctApplied: commercial.marginPctApplied,
    controllingRule,
    holoFloorApplied,
    matteEquivalentUnit,
    version: STICKER_PRICING_VERSION,
    engine: STICKER_PRICING_ENGINE,
  };
}

export function stickerPriceBreaks(
  inputs: CanonicalStickerInputs,
  selection: Omit<StickerSelection, "quantity">,
): Array<{ range: string; minQty: number; maxQty: null; priceEach: number }> {
  const breaks: Array<{ range: string; minQty: number; maxQty: null; priceEach: number }> = [];
  for (const quantity of STICKER_QUANTITY_OPTIONS) {
    const result = priceStickerConfiguration(inputs, { ...selection, quantity });
    if (result.ok) breaks.push({ range: `${quantity}+`, minQty: quantity, maxQty: null, priceEach: result.unitPrice });
  }
  return breaks;
}

// Hidden `_GSO Canonical` snapshot for sticker lines.
export function buildCanonicalStickerLineMetadata(input: {
  productType: string;
  priced: Extract<StickerPriceResult, { ok: true }>;
}): string {
  return JSON.stringify({
    v: STICKER_PRICING_VERSION,
    family: "stickers",
    profile: input.productType,
    stickerType: input.priced.stickerType,
    widthIn: input.priced.widthIn,
    heightIn: input.priced.heightIn,
    areaSqIn: input.priced.areaSqIn,
    qty: input.priced.quantity,
    material: input.priced.material,
    holo: input.priced.holographic,
    whiteRequired: input.priced.whiteRequired,
    specialtyX: input.priced.specialtyX,
    finishLabel: input.priced.specialtyLabel,
    cutType: input.priced.cutType,
    unitPrice: input.priced.unitPrice,
    subtotal: input.priced.orderTotal,
    engine: STICKER_PRICING_ENGINE,
  });
}
