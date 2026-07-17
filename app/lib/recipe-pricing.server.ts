import { finishPresets } from "./finish-presets";

// Shared quote-ready recipe pricing. Callers must load recipes with
// QUOTE_RECIPE_PRICING_INCLUDE and gate lookups with QUOTE_READY_RECIPE_WHERE,
// then price with priceRecipeAtQuantity on the loaded row.

export const QUOTE_READY_RECIPE_WHERE = {
  active: true,
  useInQuotes: true,
  costReviewNeeded: false,
} as const;

export const QUOTE_RECIPE_PRICING_INCLUDE = {
  tiers: { orderBy: { minQty: "asc" as const } },
  materials: { include: { material: true } },
  addOns: { where: { enabled: true }, orderBy: { name: "asc" as const } },
  machineRules: {
    include: {
      preferredMachine: {
        include: { inkChannels: true },
      },
    },
  },
  vendorProduct: {
    include: {
      tiers: { orderBy: { minQty: "asc" as const } },
      addOns: { where: { enabled: true }, orderBy: { name: "asc" as const } },
    },
  },
};

function clean(value: any) {
  return String(value || "").trim().toLowerCase();
}

export function safeNumber(value: any, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function percentToDivisor(marginPct: number) {
  const safeMargin = Math.min(Math.max(marginPct, 0), 95);
  return 1 - safeMargin / 100;
}

// Canonical waste model shared by the engine and the Cost Calculator:
// waste consumes input, so usable output = input * (1 - waste%), which means
// required input = base / (1 - waste%). 100 sqft at 10% waste = 111.11 sqft.
export function applyWasteDivisor(baseAmount: number, wastePct: number) {
  const divisor = Math.max(0.01, 1 - safeNumber(wastePct) / 100);
  return safeNumber(baseAmount) / divisor;
}

function rangeLabel(row: any) {
  if (!row) return "No tier";
  return row.maxQty ? `${row.minQty}-${row.maxQty}` : `${row.minQty}+`;
}

export function getBestRange(rows: any[], quantity: number) {
  const sorted = [...(rows || [])].sort(
    (a, b) => safeNumber(a.minQty) - safeNumber(b.minQty)
  );

  const exact = sorted.find((row) => {
    const minQty = safeNumber(row.minQty, 1);
    const maxQty = row.maxQty == null ? null : safeNumber(row.maxQty);
    return quantity >= minQty && (maxQty == null || quantity <= maxQty);
  });

  if (exact) return exact;

  const fallback = sorted
    .filter((row) => quantity >= safeNumber(row.minQty, 1))
    .pop();

  return fallback || sorted[0] || null;
}

export function materialUnitCost(material: any) {
  return (
    safeNumber(material?.calculatedUnitCost) ||
    safeNumber(material?.costPerUnit) ||
    safeNumber(material?.purchaseCost)
  );
}

export function calculateAddOns(addOns: any[], selectedAddOnIds: string[], quantity: number, baseCost: number) {
  let perUnitCost = 0;
  let flatCost = 0;
  let percentCost = 0;
  const selected: any[] = [];

  for (const addOn of addOns || []) {
    if (!selectedAddOnIds.includes(addOn.id)) continue;
    selected.push(addOn);

    const amount = safeNumber(addOn.amount);
    if (addOn.pricingType === "per_unit") perUnitCost += amount * quantity;
    else if (addOn.pricingType === "flat_fee") flatCost += amount;
    else if (addOn.pricingType === "percent") percentCost += baseCost * (amount / 100);
  }

  return {
    selected,
    total: perUnitCost + flatCost + percentCost,
    perUnitCost,
    flatCost,
    percentCost,
  };
}

export function calculateInHouseRecipe(recipe: any, quantity: number, selectedFinish: string) {
  const finish = finishPresets[selectedFinish] || finishPresets.base;
  const widthIn = safeNumber(recipe.widthIn);
  const heightIn = safeNumber(recipe.heightIn);
  const sqftEach = widthIn > 0 && heightIn > 0 ? (widthIn * heightIn) / 144 : 0;
  const rawSqft = sqftEach * quantity;
  const wastePct = safeNumber(recipe.wastePct);
  const totalSqft = applyWasteDivisor(rawSqft, wastePct);
  const machine = recipe.machineRules?.[0]?.preferredMachine || null;
  const sqftPerHour = finish.sqftPerHour || safeNumber(machine?.sqftPerHour, 150) || 150;
  const runHours = sqftPerHour > 0 ? totalSqft / sqftPerHour : 0;
  const setupHours = safeNumber(recipe.laborMinutes) / 60;
  const operatorRate = safeNumber(recipe.operatorLaborPct, 25);
  const machineHourlyCost = safeNumber(machine?.costPerHour);

  let materialCost = 0;
  const materialBreakdown: any[] = [];

  for (const recipeMaterial of recipe.materials || []) {
    const material = recipeMaterial.material;
    const unitCost = materialUnitCost(material);
    const multiplier = safeNumber(recipeMaterial.quantity, 1) || 1;
    const unit = String(recipeMaterial.unit || material?.baseUnit || material?.unit || "each").toLowerCase();
    let cost = 0;

    if (unit === "sqft" || unit === "square_foot") {
      cost = totalSqft * unitCost * multiplier;
    } else if (unit === "sqin" || unit === "square_inch") {
      cost = totalSqft * 144 * unitCost * multiplier;
    } else if (unit === "each") {
      cost = quantity * unitCost * multiplier;
    } else if (unit === "hour") {
      cost = runHours * unitCost * multiplier;
    } else {
      cost = quantity * unitCost * multiplier;
    }

    materialCost += cost;
    materialBreakdown.push({
      name: material?.name || "Material",
      usageType: recipeMaterial.usageType,
      unit,
      unitCost,
      cost,
    });
  }

  const channels = (machine?.inkChannels || []).filter((channel: any) => channel.enabled !== false);
  const cmykChannels = channels.filter((channel: any) => clean(channel.inkType) === "cmyk");
  const whiteChannels = channels.filter((channel: any) => clean(channel.inkType) === "white");
  const glossChannels = channels.filter((channel: any) => clean(channel.inkType) === "gloss");

  const channelCost = (channel: any, coveragePct: number) => {
    const costPerMl = safeNumber(channel.costPerMl) || safeNumber(channel.cartridgeCost) / Math.max(1, safeNumber(channel.cartridgeMl, 1));
    return totalSqft * coveragePct * safeNumber(channel.mlPerSqft1Pct) * costPerMl;
  };

  const cmykCoverage = safeNumber(recipe.baseCmykCoveragePct, 40);
  const inkAllowance = 1 + safeNumber(recipe.inkAllowancePct, 15) / 100;
  const cmykInkCost = cmykChannels.reduce((sum: number, channel: any) => sum + channelCost(channel, cmykCoverage), 0);
  const whiteInkCost = whiteChannels.reduce(
    (sum: number, channel: any) => sum + channelCost(channel, 100 * finish.whiteLayers),
    0
  );
  const glossInkCost = glossChannels.reduce(
    (sum: number, channel: any) => sum + channelCost(channel, 100 * finish.glossLayers),
    0
  );
  const inkCost = (cmykInkCost + whiteInkCost + glossInkCost) * inkAllowance;

  const machineRunCost = runHours * machineHourlyCost;
  const laborCost = (runHours + setupHours) * operatorRate;
  const maintenanceCost = totalSqft * safeNumber(recipe.maintenanceCostPerSqft);
  const machineRecoveryCost = totalSqft * safeNumber(recipe.machineRecoveryCostPerSqft);
  const overheadCost = totalSqft * safeNumber(recipe.overheadCostPerSqft);
  const setupCost = safeNumber(recipe.setupCost);

  const totalCost =
    materialCost +
    inkCost +
    machineRunCost +
    laborCost +
    maintenanceCost +
    machineRecoveryCost +
    overheadCost +
    setupCost;

  const warnings: string[] = [];
  if (!widthIn || !heightIn) warnings.push("Recipe is missing label width or height.");
  if (!recipe.materials?.length) warnings.push("Recipe has no material attached.");
  if (!machine) warnings.push("Recipe has no preferred machine.");
  if (machine && !channels.length) warnings.push("Machine has no enabled ink channels, so ink may be under-costed.");
  if (finish.whiteLayers && !whiteChannels.length) warnings.push("White finish selected, but no white ink channel was found.");
  if (finish.glossLayers && !glossChannels.length) warnings.push("Gloss/emboss finish selected, but no gloss ink channel was found.");

  return {
    pricingSource: "recipe_in_house",
    finishLabel: finish.label,
    preferredMachine: machine?.name || finish.preferredMachine,
    quantity,
    sqftEach,
    totalSqft,
    runHours,
    costEach: quantity > 0 ? totalCost / quantity : 0,
    totalCost,
    warnings,
    breakdown: {
      materialCost,
      materialBreakdown,
      inkCost,
      cmykInkCost: cmykInkCost * inkAllowance,
      whiteInkCost: whiteInkCost * inkAllowance,
      glossInkCost: glossInkCost * inkAllowance,
      machineRunCost,
      laborCost,
      maintenanceCost,
      machineRecoveryCost,
      overheadCost,
      setupCost,
      sqftPerHour,
      wastePct,
      inkAllowancePct: safeNumber(recipe.inkAllowancePct, 15),
    },
  };
}

export function calculateOutsourcedRecipe(recipe: any, quantity: number, selectedAddOnIds: string[]) {
  const vendorProduct = recipe.vendorProduct;
  const vendorTier = getBestRange(vendorProduct?.tiers || [], quantity);
  const baseUnitCost = vendorTier ? safeNumber(vendorTier.unitCost) : safeNumber(vendorProduct?.defaultUnitCost);
  const baseCost = quantity * baseUnitCost;
  const vendorAddOns = vendorProduct?.addOns || [];
  const recipeAddOns = recipe.addOns || [];
  const addOnCost = calculateAddOns([...vendorAddOns, ...recipeAddOns], selectedAddOnIds, quantity, baseCost);
  const setupCost = safeNumber(recipe.setupCost);
  const totalCost = baseCost + addOnCost.total + setupCost;

  const warnings: string[] = [];
  if (!vendorProduct) warnings.push("Outsourced recipe has no vendor product attached.");
  if (vendorProduct && !vendorTier && !vendorProduct.defaultUnitCost) {
    warnings.push("Vendor product has no matching tier cost or fallback unit cost.");
  }

  return {
    pricingSource: "recipe_outsourced",
    finishLabel: addOnCost.selected.length
      ? addOnCost.selected.map((addOn) => addOn.name).join(", ")
      : "No add-ons",
    preferredMachine: "Vendor produced",
    quantity,
    sqftEach: 0,
    totalSqft: 0,
    runHours: 0,
    costEach: quantity > 0 ? totalCost / quantity : 0,
    totalCost,
    warnings,
    breakdown: {
      vendor: vendorProduct?.vendor || "",
      vendorSku: vendorProduct?.vendorSku || "",
      vendorTier: rangeLabel(vendorTier),
      baseUnitCost,
      baseCost,
      addOnCost: addOnCost.total,
      selectedAddOns: addOnCost.selected.map((addOn) => ({
        id: addOn.id,
        name: addOn.name,
        pricingType: addOn.pricingType,
        amount: addOn.amount,
      })),
      setupCost,
    },
  };
}

export function priceRecipeAtQuantity(
  recipe: any,
  rawQuantity: any,
  options: { selectedFinish?: string; selectedAddOnIds?: string[] } = {},
) {
  const quantity = Math.max(1, Math.floor(safeNumber(rawQuantity, 1)));
  const selectedAddOnIds = options.selectedAddOnIds || [];
  const productionMode = String(recipe.productionMode || "in_house");
  const estimate =
    productionMode === "outsourced" && recipe.vendorProduct
      ? calculateOutsourcedRecipe(recipe, quantity, selectedAddOnIds)
      : calculateInHouseRecipe(recipe, quantity, options.selectedFinish || "base");

  const recipeTier = getBestRange(recipe.tiers || [], quantity);
  const marginPct = safeNumber(recipeTier?.marginPct, safeNumber(recipe.targetMarginPct, 40));
  const fixedPrice = recipeTier?.fixedPrice == null ? null : safeNumber(recipeTier.fixedPrice);
  const unitCost = estimate.costEach;
  const unitPrice = fixedPrice != null ? fixedPrice : unitCost / percentToDivisor(marginPct);
  const totalPrice = unitPrice * quantity;
  const profit = totalPrice - estimate.totalCost;
  const marginActual = totalPrice > 0 ? (profit / totalPrice) * 100 : 0;
  const minQuantity = safeNumber(recipe.minQuantity, 1);
  const warnings = [...estimate.warnings];

  if (quantity < minQuantity) {
    warnings.push(`Quantity is below this recipe minimum of ${minQuantity}.`);
  }

  return {
    quantity,
    selectedAddOnIds,
    estimate,
    recipeTier,
    tierLabel: rangeLabel(recipeTier),
    marginPct,
    fixedPrice,
    unitCost,
    unitPrice,
    totalCost: estimate.totalCost,
    totalPrice,
    profit,
    marginActual,
    minQuantity,
    warnings,
    pricingSource: estimate.pricingSource,
  };
}

export type PricedRecipe = ReturnType<typeof priceRecipeAtQuantity>;

// Stricter than the Quotes screen on purpose: staff-driven quoting surfaces these
// as warnings for a human to judge, but unattended queue conversion must refuse
// to write a draft quote from incomplete or junk cost inputs.
export function blockingConversionIssues(recipe: any, priced: PricedRecipe) {
  const issues: string[] = [];
  const productionMode = String(recipe.productionMode || "in_house");
  const usesInHouseEngine = !(productionMode === "outsourced" && recipe.vendorProduct);

  if (usesInHouseEngine) {
    if (!safeNumber(recipe.widthIn) || !safeNumber(recipe.heightIn)) {
      issues.push("recipe is missing width or height");
    }
    if (!recipe.materials?.length) {
      issues.push("recipe has no materials attached");
    }
    if (!recipe.machineRules?.[0]?.preferredMachine) {
      issues.push("recipe has no preferred machine");
    }
  }

  if (priced.quantity < priced.minQuantity) {
    issues.push(`quantity ${priced.quantity} is below the recipe minimum of ${priced.minQuantity}`);
  }
  if (!Number.isFinite(priced.unitCost) || priced.unitCost <= 0) {
    issues.push("unit cost is not a positive number");
  }
  if (!Number.isFinite(priced.unitPrice) || priced.unitPrice <= 0) {
    issues.push("unit price is not a positive number");
  }

  return issues;
}
