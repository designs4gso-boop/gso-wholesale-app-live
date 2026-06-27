import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const terms = ["jar", "miron", "50ml", "100ml", "150ml", "250ml", "3oz", "4oz", "saturn", "wide neck", "flat"];

function contains(field) {
  return terms.map((term) => ({ [field]: { contains: term, mode: "insensitive" } }));
}

async function main() {
  console.log("FULL JAR / MIRON / 3OZ / 4OZ DATABASE AUDIT");
  console.log(`Shop: ${shop}`);

  const profiles = await db.productTypeProfile.findMany({
    where: {
      shop,
      OR: [
        ...contains("key"),
        ...contains("name"),
        ...contains("notes"),
      ],
    },
    orderBy: { key: "asc" },
  });

  console.log("\nPRODUCT TYPE PROFILES");
  console.table(profiles.map((p) => ({
    key: p.key,
    name: p.name,
    minQuantity: p.minQuantity,
    defaultQuantity: p.defaultQuantity,
    tierBreakpoints: p.tierBreakpoints,
    pricingMethod: p.pricingMethod,
    calculatorKind: p.calculatorKind,
    active: p.active,
    notes: p.notes,
  })));

  const materials = await db.material.findMany({
    where: {
      shop,
      OR: [
        ...contains("name"),
        ...contains("materialType"),
        ...contains("productFamilies"),
        ...contains("notes"),
        ...contains("vendor"),
        ...contains("sku"),
      ],
    },
    include: { vendors: true },
    orderBy: [{ materialType: "asc" }, { name: "asc" }],
  });

  console.log("\nMATERIALS");
  console.table(materials.map((m) => ({
    id: m.id,
    name: m.name,
    materialType: m.materialType,
    productFamilies: m.productFamilies,
    unit: m.unit,
    costPerUnit: m.costPerUnit,
    purchaseCost: m.purchaseCost,
    purchaseUnit: m.purchaseUnit,
    vendor: m.vendor,
    sku: m.sku,
    active: m.active,
    vendorRows: m.vendors.length,
    notes: m.notes,
  })));

  for (const material of materials) {
    if (!material.vendors.length) continue;

    console.log(`\nMATERIAL VENDORS: ${material.name}`);
    console.table(material.vendors.map((v) => ({
      vendorName: v.vendorName,
      vendorSku: v.vendorSku,
      unitCost: v.unitCost,
      unit: v.unit,
      moq: v.moq,
      leadTimeDays: v.leadTimeDays,
      preferred: v.preferred,
      active: v.active,
      notes: v.notes,
    })));
  }

  const recipes = await db.productRecipe.findMany({
    where: {
      shop,
      OR: [
        ...contains("name"),
        ...contains("productType"),
        ...contains("productFamily"),
        ...contains("notes"),
        ...contains("sku"),
      ],
    },
    include: {
      materials: { include: { material: true } },
      labelZones: true,
      tiers: true,
      sourcedTiers: true,
      addOns: true,
    },
    orderBy: [{ productType: "asc" }, { name: "asc" }],
  });

  console.log("\nRECIPES");
  console.table(recipes.map((r) => ({
    id: r.id,
    name: r.name,
    productType: r.productType,
    productFamily: r.productFamily,
    active: r.active,
    productionMode: r.productionMode,
    costMethod: r.costMethod,
    minQuantity: r.minQuantity,
    defaultQuantity: r.defaultQuantity,
    materials: r.materials.length,
    labelZones: r.labelZones.length,
    sellTiers: r.tiers.length,
    sourcedCostTiers: r.sourcedTiers.length,
    addOns: r.addOns.length,
    notes: r.notes,
  })));

  for (const recipe of recipes) {
    console.log(`\nRECIPE DETAIL: ${recipe.name} / ${recipe.productType}`);

    console.log("Materials:");
    console.table(recipe.materials.map((m) => ({
      usageType: m.usageType,
      material: m.material?.name,
      quantity: m.quantity,
      unit: m.unit,
      wastePct: m.wastePct,
      active: m.active,
      notes: m.notes,
    })));

    console.log("Label zones:");
    console.table(recipe.labelZones.map((z) => ({
      name: z.name,
      position: z.position,
      widthIn: z.widthIn,
      heightIn: z.heightIn,
      qtyPerUnit: z.qtyPerUnit,
      applicationSecondsPerLabel: z.applicationSecondsPerLabel,
      active: z.active,
      notes: z.notes,
    })));

    console.log("Manufacturer cost tiers:");
    console.table(recipe.sourcedTiers.map((t) => ({
      minQty: t.minQty,
      unitCost: t.unitCost,
      vendor: t.vendor,
      notes: t.notes,
    })));

    console.log("Sell tiers:");
    console.table(recipe.tiers.map((t) => ({
      minQty: t.minQty,
      maxQty: t.maxQty,
      marginPct: t.marginPct,
      fixedPrice: t.fixedPrice,
      notes: t.notes,
    })));
  }

  const vendorProducts = await db.vendorProduct.findMany({
    where: {
      shop,
      OR: [
        ...contains("name"),
        ...contains("productType"),
        ...contains("vendor"),
        ...contains("vendorSku"),
        ...contains("notes"),
      ],
    },
    include: {
      tiers: { orderBy: { minQty: "asc" } },
      addOns: true,
    },
    orderBy: [{ productType: "asc" }, { name: "asc" }],
  });

  console.log("\nVENDOR PRODUCTS");
  console.table(vendorProducts.map((v) => ({
    id: v.id,
    name: v.name,
    productType: v.productType,
    vendor: v.vendor,
    vendorSku: v.vendorSku,
    defaultUnitCost: v.defaultUnitCost,
    moq: v.moq,
    leadTimeDays: v.leadTimeDays,
    active: v.active,
    tiers: v.tiers.length,
    addOns: v.addOns.length,
    notes: v.notes,
  })));

  for (const vendorProduct of vendorProducts) {
    console.log(`\nVENDOR PRODUCT DETAIL: ${vendorProduct.name}`);

    console.log("Cost tiers:");
    console.table(vendorProduct.tiers.map((t) => ({
      minQty: t.minQty,
      maxQty: t.maxQty,
      unitCost: t.unitCost,
      notes: t.notes,
    })));

    console.log("Add-ons:");
    console.table(vendorProduct.addOns.map((a) => ({
      name: a.name,
      pricingType: a.pricingType,
      amount: a.amount,
      enabled: a.enabled,
      notes: a.notes,
    })));
  }

  console.log("\nAUDIT COMPLETE");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
