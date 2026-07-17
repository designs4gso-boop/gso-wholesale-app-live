import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type Status = "ready" | "warning" | "critical";

type Issue = {
  area: string;
  item: string;
  status: Status;
  message: string;
  fix: string;
};

type SummaryCard = {
  label: string;
  value: number | string;
  status: Status;
  help: string;
};

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function lower(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function hasCost(material: any): boolean {
  return num(material.calculatedUnitCost) > 0 || num(material.costPerUnit) > 0 || num(material.purchaseCost) > 0;
}

function materialCostPerSqIn(material: any): number {
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

function inkCostPerMl(material: any): number {
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


function machineIsPrinter(machine: any): boolean {
  const type = lower(machine.machineType);
  const name = lower(machine.name);
  if (type.includes("outsource") || type.includes("vendor") || type.includes("other") || name.includes("outsource")) return false;
  return type.includes("printer") || type.includes("print") || name.includes("roland") || name.includes("mimaki");
}

function findInkMaterialForChannel(channel: any, inkMaterials: any[]) {
  const inkType = lower(channel.inkType);
  const inkName = lower(channel.inkName);
  const hay = `${inkType} ${inkName}`;
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
      return { material, score };
    })
    .filter((row) => row.score > 0 && inkCostPerMl(row.material) > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.material || null;
}

function channelCostPerMl(channel: any, inkMaterials: any[]): number {
  const channelCost = num(channel.costPerMl) || (num(channel.cartridgeCost) > 0 && num(channel.cartridgeMl) > 0 ? num(channel.cartridgeCost) / num(channel.cartridgeMl) : 0);
  if (channelCost > 0) return channelCost;
  const matched = findInkMaterialForChannel(channel, inkMaterials);
  return matched ? inkCostPerMl(matched) : 0;
}

function statusRank(status: Status): number {
  if (status === "critical") return 0;
  if (status === "warning") return 1;
  return 2;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [materials, machines, productTypes] = await Promise.all([
    db.material.findMany({
      where: { shop },
      select: {
        id: true,
        name: true,
        materialType: true,
        productFamilies: true,
        unit: true,
        baseUnit: true,
        costPerUnit: true,
        purchaseCost: true,
        purchaseUnit: true,
        calculatedUnitCost: true,
        rollWidthIn: true,
        rollLengthFt: true,
        volumeMl: true,
        yieldQuantity: true,
        yieldUnit: true,
        useInRecipes: true,
        costReviewNeeded: true,
        active: true,
      },
      orderBy: [{ active: "desc" }, { materialType: "asc" }, { name: "asc" }],
      take: 300,
    }),
    db.machine.findMany({
      where: { shop },
      select: {
        id: true,
        name: true,
        machineType: true,
        costPerHour: true,
        sqftPerHour: true,
        setupWastePct: true,
        active: true,
        inkChannels: {
          select: {
            id: true,
            slotNumber: true,
            inkName: true,
            inkType: true,
            costPerMl: true,
            cartridgeCost: true,
            cartridgeMl: true,
            mlPerSqft1Pct: true,
            mlPerSqft100: true,
            enabled: true,
          },
          orderBy: [{ slotNumber: "asc" }],
        },
      },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      take: 100,
    }),
    db.productTypeProfile.findMany({
      where: { shop },
      select: {
        id: true,
        key: true,
        name: true,
        productionMode: true,
        defaultMarginPct: true,
        tierBreakpoints: true,
        active: true,
      },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      take: 100,
    }),
  ]);

  // 12B.1a pricing-audit inputs: all read-only counts/selects, shop-scoped.
  const [vendorProductRows, recipesWithStoredLabor, sourcedCostTierCount, productCostCount, pricingRuleCount] = await Promise.all([
    db.vendorProduct.findMany({
      where: { shop, active: true },
      select: { id: true, name: true, defaultUnitCost: true, vendorSku: true, _count: { select: { tiers: true } } },
      take: 200,
    }),
    db.productRecipe.findMany({
      where: {
        shop,
        active: true,
        OR: [
          { applicationLaborSecondsPerUnit: { gt: 0 } },
          { packingLaborSecondsPerUnit: { gt: 0 } },
          { prepressMinutes: { gt: 0 } },
        ],
      },
      select: {
        id: true,
        name: true,
        applicationLaborSecondsPerUnit: true,
        packingLaborSecondsPerUnit: true,
        prepressMinutes: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
    db.sourcedCostTier.count({ where: { shop } }),
    db.productCost.count({ where: { shop } }),
    db.pricingRule.count({ where: { shop } }),
  ]);

  const issues: Issue[] = [];

  for (const material of materials) {
    const type = lower(material.materialType);
    const families = lower(material.productFamilies);
    const name = material.name || "Unnamed material";
    const active = Boolean(material.active);
    const usedInRecipes = Boolean(material.useInRecipes);
    const isRollMedia = type.includes("roll") || type.includes("media") || lower(name).includes("roll media");
    const isInk = type.includes("ink") || type.includes("coating") || lower(name).includes(" ink") || lower(name).includes("gloss ink") || lower(name).includes("white ink");
    const labelRelevant = families.includes("label") || families.includes("sticker") || isRollMedia || isInk;

    if (!active) {
      issues.push({ area: "Materials", item: name, status: "warning", message: "Inactive material. It will not be trusted by calculator auto-pull.", fix: "Archive intentionally or reactivate if this material should be available." });
      continue;
    }

    if (usedInRecipes && !hasCost(material)) {
      issues.push({ area: "Materials", item: name, status: "critical", message: "No usable cost is saved.", fix: "Add purchase cost and unit conversion, or enter cost per base unit." });
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

  const inkMaterials = materials.filter((material: any) => {
    const type = lower(material.materialType);
    const name = lower(material.name);
    return material.active && (type.includes("ink") || type.includes("coating") || name.includes(" ink") || name.includes("gloss ink") || name.includes("white ink"));
  });

  for (const machine of machines) {
    const name = machine.name || "Unnamed machine";
    const active = Boolean(machine.active);
    const enabledChannels = (machine.inkChannels || []).filter((c: any) => c.enabled);
    const isPrinter = machineIsPrinter(machine);

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
      const directCostPerMl = num(channel.costPerMl) || (num(channel.cartridgeCost) > 0 && num(channel.cartridgeMl) > 0 ? num(channel.cartridgeCost) / num(channel.cartridgeMl) : 0);
      const matchedInkMaterial = findInkMaterialForChannel(channel, inkMaterials);
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

    const hasWhite = enabledChannels.some((c: any) => lower(c.inkType).includes("white") || lower(c.inkName).includes("white"));
    const hasGloss = enabledChannels.some((c: any) => lower(c.inkType).includes("gloss") || lower(c.inkName).includes("gloss") || lower(c.inkName).includes("clear"));
    if (isPrinter && !hasWhite) {
      issues.push({ area: "Print layers", item: name, status: "warning", message: "No white ink channel is configured.", fix: "Add white if this machine handles clear/holographic/white-back jobs, otherwise ignore." });
    }
    if (isPrinter && !hasGloss) {
      issues.push({ area: "Print layers", item: name, status: "warning", message: "No gloss/clear ink channel is configured.", fix: "Add gloss/clear if this machine handles spot gloss/clear jobs, otherwise ignore." });
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

    if (num(machine.costPerHour) === 5) {
      issues.push({
        area: "Rates",
        item: name,
        status: "warning",
        message: "Machine rate is exactly $5/hr — the seeded GSO preset default. The Cost Calculator meanwhile defaults to $8/hr, so the app currently disagrees with itself about machine cost.",
        fix: "Decide the real machine recovery rate (power, maintenance, depreciation) and save it here; use the same number in the calculator.",
      });
    }

    for (const channel of (machine.inkChannels || []).filter((c: any) => c.enabled)) {
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

  const tieredVendorProducts = vendorProductRows.filter((p: any) => (p._count?.tiers || 0) > 0);
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

  const activeMaterials = materials.filter((m: any) => m.active);
  const rollMediaReady = activeMaterials.filter((m: any) => (lower(m.materialType).includes("roll") || lower(m.name).includes("roll media")) && materialCostPerSqIn(m) > 0).length;
  const inkMaterialsReady = activeMaterials.filter((m: any) => (lower(m.materialType).includes("ink") || lower(m.name).includes(" ink")) && inkCostPerMl(m) > 0).length;
  const activeMachines = machines.filter((m: any) => m.active);
  const activePrinterMachines = activeMachines.filter(machineIsPrinter);
  const machinesReady = activePrinterMachines.filter((m: any) => {
    const channels = (m.inkChannels || []).filter((c: any) => c.enabled);
    return channels.length > 0 && channels.some((c: any) => channelCostPerMl(c, inkMaterials) > 0);
  }).length;
  const criticalCount = issues.filter((i) => i.status === "critical").length;
  const warningCount = issues.filter((i) => i.status === "warning").length;

  const cards: SummaryCard[] = [
    { label: "Active materials", value: activeMaterials.length, status: activeMaterials.length > 0 ? "ready" : "critical", help: "Materials available for recipes/calculator." },
    { label: "Roll media ready", value: rollMediaReady, status: rollMediaReady > 0 ? "ready" : "critical", help: "Roll media with usable cost per square inch." },
    { label: "Ink materials ready", value: inkMaterialsReady, status: inkMaterialsReady > 0 ? "ready" : "critical", help: "Ink/coating materials with usable cost per ml." },
    { label: "Printer machines ready", value: `${machinesReady}/${activePrinterMachines.length}`, status: machinesReady > 0 ? "warning" : "critical", help: "Active printer machines with at least one usable ink channel. Outsourced/vendor placeholders are ignored." },
    { label: "Critical issues", value: criticalCount, status: criticalCount === 0 ? "ready" : "critical", help: "Must be fixed before trusting auto-pricing." },
    { label: "Warnings", value: warningCount, status: warningCount === 0 ? "ready" : "warning", help: "Can calculate, but results may be estimates/manual fallback." },
  ];

  const sortedIssues = issues.sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.area.localeCompare(b.area) || a.item.localeCompare(b.item)).slice(0, 200);

  return {
    cards,
    issues: sortedIssues,
    materialPreview: activeMaterials.slice(0, 40).map((m: any) => ({
      id: m.id,
      name: m.name,
      type: m.materialType,
      unit: m.unit,
      baseUnit: m.baseUnit,
      costPerUnit: num(m.costPerUnit),
      purchaseCost: num(m.purchaseCost),
      costPerSqIn: materialCostPerSqIn(m),
      inkCostPerMl: inkCostPerMl(m),
      useInRecipes: m.useInRecipes,
    })),
    machinePreview: activeMachines.map((m: any) => ({
      id: m.id,
      name: m.name,
      type: m.machineType,
      isPrinter: machineIsPrinter(m),
      costPerHour: num(m.costPerHour),
      sqftPerHour: num(m.sqftPerHour),
      channels: (m.inkChannels || []).filter((c: any) => c.enabled).map((c: any) => {
        const matched = findInkMaterialForChannel(c, inkMaterials);
        return {
          slotNumber: c.slotNumber,
          inkName: c.inkName,
          inkType: c.inkType,
          costPerMl: channelCostPerMl(c, inkMaterials),
          matchedMaterialName: matched?.name || "",
          mlPerSqft1Pct: num(c.mlPerSqft1Pct),
          mlPerSqft100: num(c.mlPerSqft100),
        };
      }),
    })),
  };
}

function money(value: number, digits = 4): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.0000";
  return `$${value.toFixed(digits)}`;
}

function Badge({ status, children }: { status: Status; children: React.ReactNode }) {
  return <span className={`badge badge-${status}`}>{children}</span>;
}

export default function CostHealthRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <div className="page">
      <style>{`
        .page{max-width:1180px;margin:0 auto;padding:28px;font-family:Arial, sans-serif;color:#111827;}
        .hero{background:linear-gradient(135deg,#111827,#4b5563);color:white;border-radius:12px;padding:24px;margin-bottom:16px;}
        .hero h1{margin:0 0 6px;font-size:28px;}
        .hero p{margin:0;font-size:13px;opacity:.95;line-height:1.45;}
        .notice{border:1px solid #bfdbfe;background:#eff6ff;color:#1e3a8a;border-radius:10px;padding:14px;margin-bottom:18px;font-size:13px;line-height:1.45;}
        .nav{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 4px;}
        .nav a{font-size:13px;color:#1d4ed8;text-decoration:underline;}
        .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px;}
        .card{border:1px solid #e5e7eb;background:white;border-radius:10px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.04);}
        .card .label{font-size:12px;color:#6b7280;margin-bottom:6px;}
        .card .value{font-size:26px;font-weight:800;margin-bottom:6px;}
        .card .help{font-size:12px;color:#4b5563;line-height:1.35;}
        .section{border:1px solid #e5e7eb;background:white;border-radius:12px;padding:16px;margin-bottom:18px;}
        .section h2{font-size:18px;margin:0 0 8px;}
        .section p{font-size:13px;line-height:1.45;color:#4b5563;margin:0 0 12px;}
        table{width:100%;border-collapse:collapse;font-size:12px;}
        th{background:#f3f4f6;text-align:left;padding:10px;border-bottom:1px solid #e5e7eb;}
        td{padding:10px;border-bottom:1px solid #e5e7eb;vertical-align:top;}
        .badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:700;}
        .badge-ready{background:#dcfce7;color:#166534;}
        .badge-warning{background:#fef3c7;color:#92400e;}
        .badge-critical{background:#fee2e2;color:#991b1b;}
        .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;}
        .empty{padding:18px;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:10px;font-size:13px;}
        @media(max-width:900px){.grid{grid-template-columns:1fr}.page{padding:16px}}
      `}</style>

      <div className="hero">
        <h1>Cost Source Health Check</h1>
        <p>v14 (12B.1a): audits materials, roll-media conversion, ink/ml setup, and printer-only ink channels, plus the pricing-audit checks — purchaseCost fallback traps, seeded estimate ink costs, machine-rate conflicts, vendor tier coverage, unpriced recipe labor, and legacy cost tables.</p>
      </div>

      <div className="notice">
        This page does not update Shopify and does not change prices or data. It tells us which backend cost sources are ready, which are estimates, and which must be fixed before the calculator can be trusted for real quotes.
        <div className="nav">
          <Link to="/app/erp/cost-verification">Open Cost Verification Workbook</Link>
          <Link to="/app/erp/materials">Open Materials</Link>
          <Link to="/app/erp/machines">Open Machine Center</Link>
          <Link to="/app/erp/product-setup">Open Product Setup</Link>
          <Link to="/app/erp/cost-calculator">Open Cost Calculator</Link>
          <Link to="/app/erp/vendor-cost-book">Open Vendor Cost Book</Link>
        </div>
      </div>

      <div className="section">
        <h2>Cost verification facts (12B pricing audit)</h2>
        <p>
          <b>DB-backed does not automatically mean invoice-verified.</b> Several database costs were seeded from code constants
          (jar/Miron costs, machine ink defaults), and jar cost data currently exists in multiple places (Cost Calculator presets,
          Vendor Product tiers, flat Material costs, and legacy SourcedCostTier rows). To verify: check each cost below against the
          real vendor invoice or price sheet, fix it in Materials / Machine Center / Vendor Cost Book, and use the material
          "cost review needed" flag to track what is still unverified. Two known engine gaps are deliberately unfixed because they
          move live quote pricing and need separate owner approval: the purchaseCost fallback, and vendor-tier-aware blank costing
          (plus pricing the stored application/packing/prepress labor).
        </p>
      </div>

      <div className="grid">
        {data.cards.map((card) => (
          <div className="card" key={card.label}>
            <div className="label">{card.label}</div>
            <div className="value">{card.value}</div>
            <Badge status={card.status}>{card.status === "ready" ? "Ready" : card.status === "warning" ? "Needs review" : "Needs fix"}</Badge>
            <div className="help">{card.help}</div>
          </div>
        ))}
      </div>

      <div className="section">
        <h2>Cost source issues</h2>
        <p>Fix critical issues first. Warnings can still calculate, but the result should be treated as an estimate or manual fallback.</p>
        {data.issues.length === 0 ? (
          <div className="empty">No issues found. Backend cost sources look ready for calculator testing.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Status</th><th>Area</th><th>Item</th><th>Problem</th><th>Fix</th></tr>
            </thead>
            <tbody>
              {data.issues.map((issue, idx) => (
                <tr key={`${issue.area}-${issue.item}-${idx}`}>
                  <td><Badge status={issue.status}>{issue.status}</Badge></td>
                  <td>{issue.area}</td>
                  <td><strong>{issue.item}</strong></td>
                  <td>{issue.message}</td>
                  <td>{issue.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <h2>Material cost preview</h2>
        <p>Roll media should show a cost per square inch. Ink/coating should show a cost per ml. Zero means the calculator will not be able to auto-price that variable correctly.</p>
        <table>
          <thead>
            <tr><th>Material</th><th>Type</th><th>Unit</th><th>Purchase cost</th><th>Cost/unit</th><th>Cost/sq in</th><th>Ink cost/ml</th><th>Use</th></tr>
          </thead>
          <tbody>
            {data.materialPreview.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.name}</strong></td>
                <td>{m.type}</td>
                <td>{m.unit} / {m.baseUnit}</td>
                <td>{money(m.purchaseCost, 2)}</td>
                <td>{money(m.costPerUnit, 4)}</td>
                <td className="mono">{money(m.costPerSqIn, 6)}</td>
                <td className="mono">{money(m.inkCostPerMl, 6)}</td>
                <td>{m.useInRecipes ? "Recipes" : "Hidden"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Machine / print layer preview</h2>
        <p>CMYK should be your base print layer. White and gloss/clear should be add-on layers with their own ink cost and production slowdown handling. This page checks whether the machine has enough setup to support that.</p>
        <table>
          <thead>
            <tr><th>Machine</th><th>Type</th><th>Printer?</th><th>Cost/hr</th><th>Sqft/hr</th><th>Enabled ink channels</th></tr>
          </thead>
          <tbody>
            {data.machinePreview.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.name}</strong></td>
                <td>{m.type}</td>
                <td>{m.isPrinter ? "Yes" : "No / ignored"}</td>
                <td>{money(m.costPerHour, 2)}</td>
                <td>{m.sqftPerHour.toFixed(2)}</td>
                <td>
                  {m.channels.length === 0 ? "No enabled ink channels" : m.channels.map((c: any) => (
                    <div key={`${m.id}-${c.slotNumber}`}>
                      Slot {c.slotNumber}: <strong>{c.inkName || c.inkType}</strong> ({c.inkType}) — cost/ml <span className="mono">{money(c.costPerMl, 6)}</span>{c.matchedMaterialName ? <span> via {c.matchedMaterialName}</span> : null}, usage 1% <span className="mono">{c.mlPerSqft1Pct.toFixed(6)}</span>, usage 100% <span className="mono">{c.mlPerSqft100.toFixed(6)}</span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
