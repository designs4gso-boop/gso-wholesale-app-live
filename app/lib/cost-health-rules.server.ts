// Cost Source Health Check rules — PURE (no Prisma, no Shopify, no writes).
// The route loader fetches shop-scoped rows and hands them to
// buildCostHealth(); tests and read-only audit scripts call it directly with
// plain objects. Extracted from app.erp.cost-health.tsx on 2026-10-08 (FINAL
// COST HEALTH CLEANUP) with these narrow rule changes:
//   1. A zero-cost material that NO recipe / media option / label zone
//      references (and that is not roll media or ink) is a WARNING
//      placeholder, not a CRITICAL cost source — nothing prices from it.
//   2. Ink-channel -> material matching is machine-aware (a Roland slot never
//      "matches" a Mimaki ink material) and the match is only reported when
//      it is actually used, i.e. the slot has no cost of its own.
//   3. Routing awareness: the Mimaki is CMYK-only for ERP routing (owner
//      decision 2026-10-07). Its stored white channels are hardware data, not
//      routable capacity, and the page says so instead of implying otherwise.
// Nothing here changes pricing: the live engines never read this module.
import { OWNER_STANDARDS } from "./owner-standards";

export type CostHealthStatus = "ready" | "warning" | "critical";

export type CostHealthIssue = {
  area: string;
  item: string;
  status: CostHealthStatus;
  message: string;
  fix: string;
};

export type CostHealthCard = {
  label: string;
  value: number | string;
  status: CostHealthStatus;
  help: string;
};

export type CostHealthMaterial = {
  id?: string;
  name?: string | null;
  materialType?: string | null;
  productFamilies?: string | null;
  unit?: string | null;
  baseUnit?: string | null;
  costPerUnit?: number | null;
  purchaseCost?: number | null;
  purchaseUnit?: string | null;
  calculatedUnitCost?: number | null;
  rollWidthIn?: number | null;
  rollLengthFt?: number | null;
  volumeMl?: number | null;
  yieldQuantity?: number | null;
  yieldUnit?: string | null;
  useInRecipes?: boolean | null;
  costReviewNeeded?: boolean | null;
  active?: boolean | null;
  /**
   * Rows that point at this material (RecipeMaterial + RecipeMediaOption +
   * RecipeLabelZone). `undefined` = unknown, which is treated as referenced
   * (fail closed). Only a KNOWN zero downgrades a missing cost to a warning.
   */
  recipeReferences?: number | null;
};

export type CostHealthInkChannel = {
  id?: string;
  slotNumber: number;
  inkName?: string | null;
  inkType?: string | null;
  costPerMl?: number | null;
  cartridgeCost?: number | null;
  cartridgeMl?: number | null;
  mlPerSqft1Pct?: number | null;
  mlPerSqft100?: number | null;
  enabled?: boolean | null;
};

export type CostHealthMachine = {
  id?: string;
  name?: string | null;
  machineType?: string | null;
  costPerHour?: number | null;
  sqftPerHour?: number | null;
  setupWastePct?: number | null;
  active?: boolean | null;
  inkChannels?: CostHealthInkChannel[] | null;
};

export type CostHealthProductType = {
  id?: string;
  key?: string | null;
  name?: string | null;
  productionMode?: string | null;
  defaultMarginPct?: number | null;
  tierBreakpoints?: string | null;
  active?: boolean | null;
};

export type CostHealthVendorProduct = {
  id?: string;
  name?: string | null;
  defaultUnitCost?: number | null;
  vendorSku?: string | null;
  _count?: { tiers?: number | null } | null;
};

export type CostHealthRecipeLabor = {
  id?: string;
  name?: string | null;
  applicationLaborSecondsPerUnit?: number | null;
  packingLaborSecondsPerUnit?: number | null;
  prepressMinutes?: number | null;
};

export type CostHealthInput = {
  materials: CostHealthMaterial[];
  machines: CostHealthMachine[];
  productTypes: CostHealthProductType[];
  vendorProductRows: CostHealthVendorProduct[];
  recipesWithStoredLabor: CostHealthRecipeLabor[];
  sourcedCostTierCount: number;
  productCostCount: number;
  pricingRuleCount: number;
};

export type CostHealthChannelPreview = {
  slotNumber: number;
  inkName: string;
  inkType: string;
  costPerMl: number;
  /** "slot" = the channel's own cost/ml (or cartridge ÷ ml); "material_estimate" = name-matched ink material fallback; "none" = no usable cost. */
  costSource: "slot" | "material_estimate" | "none";
  /** Only set when the fallback is actually in use (costSource === "material_estimate"). */
  matchedMaterialName: string;
  /** True for a white/gloss/clear channel on a machine the ERP routes those jobs AWAY from (Mimaki = CMYK only). */
  routedElsewhere: boolean;
  mlPerSqft1Pct: number;
  mlPerSqft100: number;
};

export type CostHealthMachinePreview = {
  id: string;
  name: string;
  type: string;
  isPrinter: boolean;
  costPerHour: number;
  sqftPerHour: number;
  routing: string;
  channels: CostHealthChannelPreview[];
};

export type CostHealthResult = {
  cards: CostHealthCard[];
  issues: CostHealthIssue[];
  materialPreview: Array<{
    id: string;
    name: string;
    type: string;
    unit: string;
    baseUnit: string;
    costPerUnit: number;
    purchaseCost: number;
    costPerSqIn: number;
    inkCostPerMl: number;
    useInRecipes: boolean;
  }>;
  machinePreview: CostHealthMachinePreview[];
};

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function lower(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

export function hasCost(material: CostHealthMaterial): boolean {
  return num(material.calculatedUnitCost) > 0 || num(material.costPerUnit) > 0 || num(material.purchaseCost) > 0;
}

export function materialCostPerSqIn(material: CostHealthMaterial): number {
  const calculated = num(material.calculatedUnitCost);
  const costPerUnit = num(material.costPerUnit);
  const purchaseCost = num(material.purchaseCost);
  const baseUnit = lower(material.baseUnit || material.unit);
  const unit = lower(material.unit);

  if (baseUnit === "sqin" || unit === "sqin") return calculated || costPerUnit || purchaseCost;
  if (baseUnit === "sqft" || unit === "sqft") return (calculated || costPerUnit || purchaseCost) / 144;

  const rollWidthIn = num(material.rollWidthIn);
  const rollLengthFt = num(material.rollLengthFt);
  if (purchaseCost > 0 && rollWidthIn > 0 && rollLengthFt > 0) {
    const sqIn = rollWidthIn * rollLengthFt * 12;
    return sqIn > 0 ? purchaseCost / sqIn : 0;
  }

  return 0;
}

export function inkCostPerMl(material: CostHealthMaterial): number {
  const calculated = num(material.calculatedUnitCost);
  const costPerUnit = num(material.costPerUnit);
  const purchaseCost = num(material.purchaseCost);
  const volumeMl = num(material.volumeMl) || num(material.yieldQuantity);
  const baseUnit = lower(material.baseUnit || material.unit);
  const unit = lower(material.unit);

  if (baseUnit === "ml" || unit === "ml") return calculated || costPerUnit || (volumeMl > 0 ? purchaseCost / volumeMl : 0);
  if (purchaseCost > 0 && volumeMl > 0) return purchaseCost / volumeMl;
  return 0;
}

export function machineIsPrinter(machine: CostHealthMachine): boolean {
  const type = lower(machine.machineType);
  const name = lower(machine.name);
  if (type.includes("outsource") || type.includes("vendor") || type.includes("other") || name.includes("outsource")) return false;
  return type.includes("printer") || type.includes("print") || name.includes("roland") || name.includes("mimaki");
}

export type MachineBrand = "roland" | "mimaki" | "";

export function machineBrand(machine: Pick<CostHealthMachine, "name"> | null | undefined): MachineBrand {
  const name = lower(machine?.name);
  if (name.includes("mimaki")) return "mimaki";
  if (name.includes("roland")) return "roland";
  return "";
}

export type MachineRoutingPolicy = {
  brand: MachineBrand;
  /** ERP routing never sends white / gloss / clear work here (Mimaki). */
  cmykOnly: boolean;
  /** Human copy shown next to the machine on the health page. */
  label: string;
};

/**
 * Mirrors print-intake-routing.server.ts (decideMachine): white / gloss work
 * ALWAYS routes to the Roland LG-640; the Mimaki UCJV300-130 is CMYK only
 * (owner decision 2026-07-26, re-confirmed 2026-10-07). This is a description
 * of routing authority for the health page — it never routes a job itself.
 */
export function machineRoutingPolicy(machine: Pick<CostHealthMachine, "name"> | null | undefined): MachineRoutingPolicy {
  const brand = machineBrand(machine);
  if (brand === "mimaki") {
    return { brand, cmykOnly: true, label: "ERP routing: CMYK only — white, gloss and clear jobs route to the Roland LG-640 (owner decision 2026-10-07). Stored white channels are hardware data, not routable capacity." };
  }
  if (brand === "roland") {
    return { brand, cmykOnly: false, label: "ERP routing: home of every white / gloss / clear job; CMYK only on explicit assignment or approved overflow." };
  }
  return { brand, cmykOnly: false, label: "" };
}

function channelIsWhite(channel: CostHealthInkChannel): boolean {
  return lower(channel.inkType).includes("white") || lower(channel.inkName).includes("white");
}

function channelIsGloss(channel: CostHealthInkChannel): boolean {
  return lower(channel.inkType).includes("gloss") || lower(channel.inkName).includes("gloss") || lower(channel.inkName).includes("clear");
}

/** True for a white / gloss channel on a machine the ERP routes that work away from. */
export function channelRoutedElsewhere(channel: CostHealthInkChannel, machine: Pick<CostHealthMachine, "name"> | null | undefined): boolean {
  return machineRoutingPolicy(machine).cmykOnly && (channelIsWhite(channel) || channelIsGloss(channel));
}

/**
 * Name-based FALLBACK only: used when a slot has no cost of its own. There is
 * no stored slot -> material relation in the schema. Machine-aware since
 * 2026-10-08: a material named for the other printer's ink can never win.
 */
export function findInkMaterialForChannel(channel: CostHealthInkChannel, inkMaterials: CostHealthMaterial[], machine?: Pick<CostHealthMachine, "name"> | null): CostHealthMaterial | null {
  const inkType = lower(channel.inkType);
  const inkName = lower(channel.inkName);
  const hay = `${inkType} ${inkName}`;
  const brand = machineBrand(machine);
  const otherBrand: MachineBrand = brand === "roland" ? "mimaki" : brand === "mimaki" ? "roland" : "";
  const scored = inkMaterials
    .map((material) => {
      const name = lower(material.name);
      let score = 0;
      if (inkName && name.includes(inkName)) score += 5;
      if (inkType && name.includes(inkType)) score += 4;
      if (hay.includes("white") && name.includes("white")) score += 8;
      if ((hay.includes("gloss") || hay.includes("clear")) && (name.includes("gloss") || name.includes("clear"))) score += 8;
      if (hay.includes("cmyk") && name.includes("cmyk")) score += 8;
      if ((hay.includes("cyan") || hay.includes("magenta") || hay.includes("yellow") || hay.includes("black")) && name.includes("cmyk")) score += 3;
      if (brand && name.includes(brand)) score += 10;
      if (otherBrand && name.includes(otherBrand)) score = -1; // never cross-brand
      return { material, score };
    })
    .filter((row) => row.score > 0 && inkCostPerMl(row.material) > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.material || null;
}

export function channelDirectCostPerMl(channel: CostHealthInkChannel): number {
  return num(channel.costPerMl) || (num(channel.cartridgeCost) > 0 && num(channel.cartridgeMl) > 0 ? num(channel.cartridgeCost) / num(channel.cartridgeMl) : 0);
}

export function channelCostPerMl(channel: CostHealthInkChannel, inkMaterials: CostHealthMaterial[], machine?: Pick<CostHealthMachine, "name"> | null): number {
  const channelCost = channelDirectCostPerMl(channel);
  if (channelCost > 0) return channelCost;
  const matched = findInkMaterialForChannel(channel, inkMaterials, machine);
  return matched ? inkCostPerMl(matched) : 0;
}

export function statusRank(status: CostHealthStatus): number {
  if (status === "critical") return 0;
  if (status === "warning") return 1;
  return 2;
}

export function isInkMaterial(material: CostHealthMaterial): boolean {
  const type = lower(material.materialType);
  const name = lower(material.name);
  return type.includes("ink") || type.includes("coating") || name.includes(" ink") || name.includes("gloss ink") || name.includes("white ink");
}

export function isRollMediaMaterial(material: CostHealthMaterial): boolean {
  const type = lower(material.materialType);
  return type.includes("roll") || type.includes("media") || lower(material.name).includes("roll media");
}

export const UNREFERENCED_PLACEHOLDER_MESSAGE =
  "Placeholder with no saved cost. No recipe, media option or label zone references it and no pricing path reads it, so it cannot affect a quote.";

export function buildCostHealth(input: CostHealthInput): CostHealthResult {
  const { materials, machines, productTypes, vendorProductRows, recipesWithStoredLabor, sourcedCostTierCount, productCostCount, pricingRuleCount } = input;
  const issues: CostHealthIssue[] = [];

  for (const material of materials) {
    const name = material.name || "Unnamed material";
    const families = lower(material.productFamilies);
    const active = Boolean(material.active);
    const usedInRecipes = Boolean(material.useInRecipes);
    const isRollMedia = isRollMediaMaterial(material);
    const isInk = isInkMaterial(material);
    const labelRelevant = families.includes("label") || families.includes("sticker") || isRollMedia || isInk;
    const knownUnreferenced = material.recipeReferences != null && num(material.recipeReferences) === 0;

    if (!active) {
      issues.push({ area: "Materials", item: name, status: "warning", message: "Inactive material. It will not be trusted by calculator auto-pull.", fix: "Archive intentionally or reactivate if this material should be available." });
      continue;
    }

    if (usedInRecipes && !hasCost(material)) {
      if (knownUnreferenced && !labelRelevant) {
        issues.push({ area: "Materials", item: name, status: "warning", message: UNREFERENCED_PLACEHOLDER_MESSAGE, fix: "Open Materials and archive it, or enter the real case cost and quantity before you add it to a recipe." });
      } else {
        issues.push({ area: "Materials", item: name, status: "critical", message: "No usable cost is saved.", fix: "Add purchase cost and unit conversion, or enter cost per base unit." });
      }
    }

    if (labelRelevant && isRollMedia && materialCostPerSqIn(material) <= 0) {
      issues.push({ area: "Materials", item: name, status: "critical", message: "Roll/media material cannot convert to cost per square inch.", fix: "Add roll width, roll length, and purchase cost, or save cost per sq ft/sq in." });
    }

    if (labelRelevant && isInk && inkCostPerMl(material) <= 0) {
      issues.push({ area: "Materials", item: name, status: "critical", message: "Ink/coating material has no cost per ml.", fix: "Add cartridge/bottle cost and ml amount, or save cost per ml." });
    }

    if (material.costReviewNeeded) {
      issues.push({ area: "Materials", item: name, status: "warning", message: "Marked for cost review.", fix: "Confirm vendor cost and clear cost review once verified." });
    }
  }

  const inkMaterials = materials.filter((material) => Boolean(material.active) && isInkMaterial(material));

  for (const machine of machines) {
    const name = machine.name || "Unnamed machine";
    const active = Boolean(machine.active);
    const enabledChannels = (machine.inkChannels || []).filter((c) => c.enabled);
    const isPrinter = machineIsPrinter(machine);
    const policy = machineRoutingPolicy(machine);

    if (!active) {
      issues.push({ area: "Machines", item: name, status: "warning", message: "Inactive machine. It will not be used by calculator auto-pull.", fix: "Reactivate only if this machine is part of production routing." });
      continue;
    }

    if (!isPrinter) {
      if (enabledChannels.length > 0) {
        issues.push({ area: "Machines", item: name, status: "warning", message: "Non-printer/vendor machine has ink channels, but they are ignored by calculator auto-pull.", fix: "Leave as-is for outsourced/vendor routes, or change machine type/name to printer if it is a real print device." });
      }
      continue;
    }

    if (isPrinter && enabledChannels.length === 0) {
      issues.push({ area: "Machines", item: name, status: "critical", message: "Printer has no enabled ink channels.", fix: "Add CMYK channels and optional white/gloss channels." });
    }

    if (isPrinter && num(machine.sqftPerHour) <= 0) {
      issues.push({ area: "Machines", item: name, status: "warning", message: "No sqft/hour production speed saved.", fix: "Add a safe average print speed so white/gloss slowdown can affect price." });
    }

    if (isPrinter && num(machine.costPerHour) <= 0) {
      issues.push({ area: "Machines", item: name, status: "warning", message: "No machine cost per hour saved.", fix: "Add an hourly machine recovery/overhead rate if you want time-based machine cost." });
    }

    for (const channel of enabledChannels) {
      const channelName = `${name} slot ${channel.slotNumber}: ${channel.inkName || channel.inkType || "unnamed ink"}`;
      const directCostPerMl = channelDirectCostPerMl(channel);
      const matchedInkMaterial = directCostPerMl > 0 ? null : findInkMaterialForChannel(channel, inkMaterials, machine);
      const costPerMl = directCostPerMl || (matchedInkMaterial ? inkCostPerMl(matchedInkMaterial) : 0);
      if (costPerMl <= 0) {
        issues.push({ area: "Machines", item: channelName, status: "critical", message: "Ink channel has no cost per ml and no matching ink material was found.", fix: "Enter cartridge/bottle cost and ml, or name/type the slot so it matches a saved CMYK, white, gloss, or clear ink material." });
      } else if (directCostPerMl <= 0 && matchedInkMaterial) {
        issues.push({ area: "Machines", item: channelName, status: "warning", message: `Ink channel cost is being estimated from material: ${matchedInkMaterial.name}.`, fix: "This is OK short term. For best accuracy, save the ink material link/cost in the machine slot later." });
      }
      if (num(channel.mlPerSqft1Pct) <= 0 && num(channel.mlPerSqft100) <= 0) {
        issues.push({ area: "Machines", item: channelName, status: "warning", message: "Ink usage rate is missing, so the calculator can only estimate or ignore this ink layer.", fix: "Add ml per sq ft at 1% coverage or 100% coverage. RIP imports can replace estimates later." });
      }
    }

    // Print-layer coverage is only meaningful for a machine the ERP actually
    // routes white / gloss work to. The Mimaki is CMYK-only by routing, so a
    // "missing white/gloss channel" warning there would invite the wrong fix.
    if (!policy.cmykOnly) {
      const hasWhite = enabledChannels.some(channelIsWhite);
      const hasGloss = enabledChannels.some(channelIsGloss);
      if (isPrinter && !hasWhite) {
        issues.push({ area: "Print layers", item: name, status: "warning", message: "No white ink channel is configured.", fix: "Add white if this machine handles clear/holographic/white-back jobs, otherwise ignore." });
      }
      if (isPrinter && !hasGloss) {
        issues.push({ area: "Print layers", item: name, status: "warning", message: "No gloss/clear ink channel is configured.", fix: "Add gloss/clear if this machine handles spot gloss/clear jobs, otherwise ignore." });
      }
    }
  }

  for (const profile of productTypes) {
    const name = profile.name || profile.key || "Unnamed product type";
    if (!profile.active) continue;
    if (num(profile.defaultMarginPct) <= 0) {
      issues.push({ area: "Product type routes", item: name, status: "critical", message: "Default margin is missing or zero.", fix: "Set a default margin or route-specific margin curve." });
    }
    if (!String(profile.tierBreakpoints || "").trim()) {
      issues.push({ area: "Product type routes", item: name, status: "warning", message: "No tier breakpoints saved.", fix: "Use GSO default tiers or define product-type-specific tiers." });
    }
  }

  // ---- 12B.1a pricing-audit checks (read-only; from the Cost Data Source Audit) ----

  for (const material of materials) {
    if (!material.active) continue;
    const name = material.name || "Unnamed material";
    const purchase = num(material.purchaseCost);
    const hasUnitCost = num(material.calculatedUnitCost) > 0 || num(material.costPerUnit) > 0;

    if (purchase > 0 && !hasUnitCost) {
      issues.push({
        area: "Materials",
        item: name,
        status: "critical",
        message: `purchaseCost fallback trap: only the whole-purchase price ($${purchase.toFixed(2)}) is saved, with no per-unit cost. The live quote engine falls back to this raw purchase price as the per-unit cost, which can massively overcost quotes. The Cost Calculator (v2.0) refuses to price it instead.`,
        fix: "Open Materials and add the roll/volume/case details so a real per-unit cost is calculated.",
      });
    }

    if (lower(material.purchaseUnit) === "roll" && (num(material.rollWidthIn) <= 0 || num(material.rollLengthFt) <= 0)) {
      issues.push({
        area: "Materials",
        item: name,
        status: "warning",
        message: "Purchased by the roll but roll width and/or roll length is missing, so cost per sqft cannot be derived from the invoice price.",
        fix: "Add roll width (in) and roll length (ft) in Materials.",
      });
    }
  }

  for (const machine of machines) {
    if (!machine.active || !machineIsPrinter(machine)) continue;
    const name = machine.name || "Unnamed machine";

    if (num(machine.costPerHour) > 0 && Math.abs(num(machine.costPerHour) - OWNER_STANDARDS.machineRecoveryPerHour.value) > 0.0001) {
      issues.push({
        area: "Rates",
        item: name,
        status: "warning",
        message: `Machine record says $${num(machine.costPerHour).toFixed(2)}/hr; the owner machine recovery standard is $${OWNER_STANDARDS.machineRecoveryPerHour.value}/hr (approved 2026-10-07, both printers). Pricing and actual costs use the owner standard, so this record is informational until aligned.`,
        fix: "Save the owner standard rate on the machine record so every screen shows the same number.",
      });
    }

    for (const channel of (machine.inkChannels || []).filter((c) => c.enabled)) {
      const channelName = `${name} slot ${channel.slotNumber}: ${channel.inkName || channel.inkType || "unnamed ink"}`;
      const direct = num(channel.costPerMl);
      const cart = num(channel.cartridgeCost);
      const cartMl = num(channel.cartridgeMl);

      if (direct > 0 && cart > 0 && cartMl > 0) {
        const derived = cart / cartMl;
        if (derived > 0 && Math.abs(direct - derived) / derived > 0.02) {
          issues.push({
            area: "Ink costs",
            item: channelName,
            status: "warning",
            message: `Stored cost/ml ($${direct.toFixed(4)}) no longer matches cartridge cost ÷ ml ($${derived.toFixed(4)}). The engine prefers the stored cost/ml, so a stale value silently misprices ink.`,
            fix: "Update cost/ml (or clear it) after changing cartridge cost so both agree.",
          });
        }
      }

      if (cart === 190 && cartMl === 1000) {
        issues.push({
          area: "Ink costs",
          item: channelName,
          status: "warning",
          message: "Ink cost is the seeded Mimaki estimate ($190 / 1000 ml) that the machine preset itself marks as a placeholder.",
          fix: "Replace with the real LUS-170 invoice cost.",
        });
      }

      if (num(channel.mlPerSqft1Pct) === 0.0075) {
        issues.push({
          area: "Ink costs",
          item: channelName,
          status: "warning",
          message: "Ink usage rate is the seeded default (0.0075 ml/sqft per 1% coverage), not a measured value.",
          fix: "Calibrate from RasterLink/VersaWorks job logs (planned Mimaki/Roland actual-cost import, Patch 13A).",
        });
      }
    }
  }

  const tieredVendorProducts = vendorProductRows.filter((p) => (p._count?.tiers || 0) > 0);
  if (tieredVendorProducts.length > 0) {
    issues.push({
      area: "Vendor tiers",
      item: `${tieredVendorProducts.length} vendor product(s) with quantity cost tiers`,
      status: "warning",
      message: "Quantity cost tiers exist (e.g. Miron jars). The Cost Calculator (v2.0) uses them, but the live quote engine still prices in-house recipes' blank materials at the flat material cost — high-quantity quotes can overcost (e.g. 2,500 jars costed at the <250 price).",
      fix: "Engine completeness patch (vendor-tier-aware blank costing) is deferred because it moves live quote pricing; owner must approve it separately.",
    });
  }
  for (const product of vendorProductRows) {
    if (num(product.defaultUnitCost) <= 0 && (product._count?.tiers || 0) === 0) {
      issues.push({
        area: "Vendor tiers",
        item: product.name || "Unnamed vendor product",
        status: "warning",
        message: "Active vendor product has no default unit cost and no cost tiers, so it prices as $0.",
        fix: "Add a unit cost or tiers via the Vendor Cost Book.",
      });
    }
  }

  for (const recipe of recipesWithStoredLabor) {
    const parts = [
      num(recipe.applicationLaborSecondsPerUnit) > 0 ? `application ${num(recipe.applicationLaborSecondsPerUnit)}s/unit` : "",
      num(recipe.packingLaborSecondsPerUnit) > 0 ? `packing ${num(recipe.packingLaborSecondsPerUnit)}s/unit` : "",
      num(recipe.prepressMinutes) > 0 ? `prepress ${num(recipe.prepressMinutes)} min` : "",
    ].filter(Boolean).join(", ");
    issues.push({
      area: "Recipe labor",
      item: recipe.name || "Unnamed recipe",
      status: "warning",
      message: `Stores labor the live quote engine does not price yet (${parts}). Quotes from this recipe exclude that labor unless it is baked into setup labor minutes.`,
      fix: "Deferred engine completeness patch (owner approval required, since quote prices would rise). Until then, verify margins knowingly.",
    });
  }

  if (sourcedCostTierCount > 0) {
    issues.push({
      area: "Legacy cost data",
      item: `SourcedCostTier (${sourcedCostTierCount} row(s))`,
      status: "warning",
      message: "Seeded recipe-level sourced cost tiers exist, but nothing prices from this table since the shared engine (Patch 2) — vendor tiers on Vendor Products are the live path.",
      fix: "No action needed for pricing; candidate for cleanup in a future schema patch.",
    });
  }

  if (productCostCount > 0 || pricingRuleCount > 0) {
    issues.push({
      area: "Legacy cost data",
      item: `ProductCost (${productCostCount}) / PricingRule (${pricingRuleCount})`,
      status: "warning",
      message: "Legacy cost/pricing tables have rows. The recipe pricing engine does not read them; they serve the older product-costs / pricing-rules pages.",
      fix: "Treat the recipe engine as the source of truth for quote costing; consolidate these later with owner approval.",
    });
  }

  issues.push({
    area: "Calculator presets",
    item: "Hardcoded blank-item presets",
    status: "warning",
    message: "The Cost Calculator still contains hardcoded blank-item costs (SAFE CARE jars/bags, soda can, and any Miron jar not yet in the database). A preset disappears automatically once a Vendor Product exists whose vendor SKU equals the preset id (the jar seed created those for Miron/SAFE CARE jars).",
    fix: "Enter remaining presets as Vendor Products with tiers via the Vendor Cost Book, verify against invoices, then remove the presets from code.",
  });

  // ---- end 12B.1a pricing-audit checks ----

  const activeMaterials = materials.filter((m) => m.active);
  const rollMediaReady = activeMaterials.filter((m) => (lower(m.materialType).includes("roll") || lower(m.name).includes("roll media")) && materialCostPerSqIn(m) > 0).length;
  const inkMaterialsReady = activeMaterials.filter((m) => (lower(m.materialType).includes("ink") || lower(m.name).includes(" ink")) && inkCostPerMl(m) > 0).length;
  const activeMachines = machines.filter((m) => m.active);
  const activePrinterMachines = activeMachines.filter(machineIsPrinter);
  const machinesReady = activePrinterMachines.filter((m) => {
    const channels = (m.inkChannels || []).filter((c) => c.enabled);
    return channels.length > 0 && channels.some((c) => channelCostPerMl(c, inkMaterials, m) > 0);
  }).length;
  const criticalCount = issues.filter((i) => i.status === "critical").length;
  const warningCount = issues.filter((i) => i.status === "warning").length;

  const cards: CostHealthCard[] = [
    { label: "Active materials", value: activeMaterials.length, status: activeMaterials.length > 0 ? "ready" : "critical", help: "Materials available for recipes/calculator." },
    { label: "Roll media ready", value: rollMediaReady, status: rollMediaReady > 0 ? "ready" : "critical", help: "Roll media with usable cost per square inch." },
    { label: "Ink materials ready", value: inkMaterialsReady, status: inkMaterialsReady > 0 ? "ready" : "critical", help: "Ink/coating materials with usable cost per ml." },
    { label: "Printer machines ready", value: `${machinesReady}/${activePrinterMachines.length}`, status: activePrinterMachines.length > 0 && machinesReady === activePrinterMachines.length ? "ready" : machinesReady > 0 ? "warning" : "critical", help: "Active printer machines with at least one usable ink channel. Outsourced/vendor placeholders are ignored." },
    { label: "Critical issues", value: criticalCount, status: criticalCount === 0 ? "ready" : "critical", help: "Must be fixed before trusting auto-pricing." },
    { label: "Warnings", value: warningCount, status: warningCount === 0 ? "ready" : "warning", help: "Can calculate, but results may be estimates/manual fallback." },
  ];

  const sortedIssues = issues.sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.area.localeCompare(b.area) || a.item.localeCompare(b.item)).slice(0, 200);

  return {
    cards,
    issues: sortedIssues,
    materialPreview: activeMaterials.slice(0, 40).map((m) => ({
      id: String(m.id || ""),
      name: String(m.name || ""),
      type: String(m.materialType || ""),
      unit: String(m.unit || ""),
      baseUnit: String(m.baseUnit || ""),
      costPerUnit: num(m.costPerUnit),
      purchaseCost: num(m.purchaseCost),
      costPerSqIn: materialCostPerSqIn(m),
      inkCostPerMl: inkCostPerMl(m),
      useInRecipes: Boolean(m.useInRecipes),
    })),
    machinePreview: activeMachines.map((m) => ({
      id: String(m.id || ""),
      name: String(m.name || ""),
      type: String(m.machineType || ""),
      isPrinter: machineIsPrinter(m),
      costPerHour: num(m.costPerHour),
      sqftPerHour: num(m.sqftPerHour),
      routing: machineRoutingPolicy(m).label,
      channels: (m.inkChannels || []).filter((c) => c.enabled).map((c) => {
        const direct = channelDirectCostPerMl(c);
        const matched = direct > 0 ? null : findInkMaterialForChannel(c, inkMaterials, m);
        const costPerMl = direct > 0 ? direct : matched ? inkCostPerMl(matched) : 0;
        const preview: CostHealthChannelPreview = {
          slotNumber: c.slotNumber,
          inkName: String(c.inkName || ""),
          inkType: String(c.inkType || ""),
          costPerMl,
          costSource: direct > 0 ? "slot" : matched ? "material_estimate" : "none",
          matchedMaterialName: matched?.name ? String(matched.name) : "",
          routedElsewhere: channelRoutedElsewhere(c, m),
          mlPerSqft1Pct: num(c.mlPerSqft1Pct),
          mlPerSqft100: num(c.mlPerSqft100),
        };
        return preview;
      }),
    })),
  };
}
