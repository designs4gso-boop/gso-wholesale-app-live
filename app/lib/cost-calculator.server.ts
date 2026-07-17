import {
  applyWasteDivisor,
  getBestRange,
  percentToDivisor,
  safeNumber,
} from "./recipe-pricing.server";

// Pure math for the Cost Calculator (estimate-only page). Extracted in 12B.1a
// so the numbers are unit-testable and shared with the engine's helpers.
// Nothing in this module touches the database or Shopify.

export type ResolvedUnitCost = {
  unitCost: number;
  warning: string | null;
};

// Per-base-unit cost for a saved material. Deliberately NEVER falls back to
// purchaseCost: that field is the whole-roll/case invoice price, and using it
// as a per-unit cost is the overcosting trap found in the 12B pricing audit.
// A material with only purchaseCost set resolves to 0 with a warning so the
// line fails loudly instead of pricing a $205 roll as $205/sqft.
export function resolveMaterialUnitCost(material: any): ResolvedUnitCost {
  const calculated = safeNumber(material?.calculatedUnitCost);
  if (calculated > 0) return { unitCost: calculated, warning: null };

  const costPerUnit = safeNumber(material?.costPerUnit);
  if (costPerUnit > 0) return { unitCost: costPerUnit, warning: null };

  const name = String(material?.name || "Material");
  const hasPurchaseCost = safeNumber(material?.purchaseCost) > 0;
  return {
    unitCost: 0,
    warning: hasPurchaseCost
      ? `${name} has a purchase cost but no per-unit cost. Open Materials and add roll/volume details so the unit cost can be calculated.`
      : `${name} has no usable unit cost. Set its cost in Materials.`,
  };
}

// Cost per square foot for print media, converting sq-inch-based materials
// with x144 (same conversion the recipe engine uses).
export function resolvePrintMaterialCostPerSqft(material: any): ResolvedUnitCost {
  const resolved = resolveMaterialUnitCost(material);
  if (resolved.unitCost <= 0) return resolved;

  const baseUnit = String(material?.baseUnit || material?.unit || "").toLowerCase();
  if (baseUnit.includes("sqin")) {
    return { unitCost: resolved.unitCost * 144, warning: resolved.warning };
  }
  return resolved;
}

export function tierRangeLabel(row: any): string {
  if (!row) return "fixed";
  const minQty = safeNumber(row.minQty);
  return row.maxQty == null ? `${minQty}+` : `${minQty}-${safeNumber(row.maxQty)}`;
}

export type BlankItemCostResult = {
  unitCost: number;
  tierLabel: string;
  warning: string | null;
};

// Quantity-tiered unit cost for a blank/vendor item. Tier selection goes
// through the engine's getBestRange so the calculator and quotes agree,
// including the engine's rule that a quantity below the lowest tier still
// charges the lowest tier (with a warning here so staff notice).
export function blankItemUnitCostAtQty(
  tiers: any[] | null | undefined,
  defaultUnitCost: number,
  quantity: number,
  itemName = "Item",
): BlankItemCostResult {
  const rows = (tiers || []).filter((row) => row && safeNumber(row.unitCost) > 0);
  if (!rows.length) {
    return { unitCost: safeNumber(defaultUnitCost), tierLabel: "fixed", warning: null };
  }

  const best = getBestRange(rows, quantity);
  if (!best) {
    return { unitCost: safeNumber(defaultUnitCost), tierLabel: "fixed", warning: null };
  }

  const lowestMinQty = rows.reduce(
    (min, row) => Math.min(min, safeNumber(row.minQty, 1)),
    Number.POSITIVE_INFINITY,
  );
  const warning =
    quantity < lowestMinQty
      ? `${itemName}: quantity ${quantity} is below the lowest cost tier (${tierRangeLabel(best)}); that tier's cost is used.`
      : null;

  return { unitCost: safeNumber(best.unitCost), tierLabel: tierRangeLabel(best), warning };
}

// Suggested sell price from a target margin, using the engine's clamped
// margin divisor (0-95). Replaces the old ">= 100% margin returns $0" edge.
export function suggestedPriceFromMargin(totalCost: number, targetMarginPct: number) {
  const divisor = percentToDivisor(safeNumber(targetMarginPct));
  return safeNumber(totalCost) / divisor;
}

export type LineCostInput = {
  quantity: number;
  widthIn: number;
  heightIn: number;
  wastePct: number;
  materialCostPerSqft: number;
  inkMode: "estimated" | "actual-per-piece" | "actual-full-job";
  estimatedInkCostPerSqft: number;
  ripInkCost: number;
  ripInkCc: number;
};

// Material + ink cost for one label/print line. Waste uses the shared engine
// divisor: required input = base / (1 - waste%), applied to both media sqft
// and the per-piece counts that actual RIP ink multiplies against.
export function computeLineCosts(input: LineCostInput) {
  const quantity = Math.max(0, safeNumber(input.quantity));
  const widthIn = safeNumber(input.widthIn);
  const heightIn = safeNumber(input.heightIn);
  const wastePct = safeNumber(input.wastePct);

  const sqftPerUnit = widthIn > 0 && heightIn > 0 ? (widthIn * heightIn) / 144 : 0;
  const baseSqft = sqftPerUnit * quantity;
  const wasteAdjustedSqft = applyWasteDivisor(baseSqft, wastePct);
  const effectiveUnits = applyWasteDivisor(quantity, wastePct);
  const materialCost = wasteAdjustedSqft * safeNumber(input.materialCostPerSqft);

  let inkCost = 0;
  let inkCc = 0;
  if (input.inkMode === "actual-per-piece") {
    inkCost = safeNumber(input.ripInkCost) * effectiveUnits;
    inkCc = safeNumber(input.ripInkCc) * effectiveUnits;
  } else if (input.inkMode === "actual-full-job") {
    inkCost = safeNumber(input.ripInkCost);
    inkCc = safeNumber(input.ripInkCc);
  } else {
    inkCost = safeNumber(input.estimatedInkCostPerSqft) * wasteAdjustedSqft;
  }

  const totalCost = materialCost + inkCost;
  return {
    sqftPerUnit,
    baseSqft,
    wasteAdjustedSqft,
    effectiveUnits,
    materialCost,
    inkCost,
    inkCc,
    totalCost,
    unitCost: quantity > 0 ? totalCost / quantity : 0,
  };
}

// Blank-item units to cost after waste (broken jars/bags still get paid for).
// Same divisor model, rounded up because vendors sell whole units.
export function blankItemCostQty(quantity: number, wastePct: number) {
  const qty = Math.max(0, safeNumber(quantity));
  if (qty <= 0) return 0;
  return Math.ceil(applyWasteDivisor(qty, wastePct));
}
