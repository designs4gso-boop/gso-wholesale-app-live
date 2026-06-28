import { PrismaClient } from "@prisma/client";

// Internal read-only Prisma audit script.
// Uses the current DATABASE_URL and defaults to shop 942075-2.myshopify.com.
// Prints internal pricing/cost/vendor data; do not share output publicly.
// Does not write or mutate data.

const db = new PrismaClient();
const SHOP = process.env.SHOPIFY_SHOP || "942075-2.myshopify.com";

async function main() {
  console.log("JAR MANUFACTURER / PRICING DUPLICATE AUDIT");
  console.log(`Shop: ${SHOP}`);

  const profileMatches = await db.productTypeProfile.findMany({
    where: {
      shop: SHOP,
      OR: [
        { key: { contains: "jar" } },
        { key: { contains: "50ml" } },
        { key: { contains: "100ml" } },
        { key: { contains: "250ml" } },
        { name: { contains: "Jar", mode: "insensitive" } },
        { name: { contains: "50ml", mode: "insensitive" } },
        { name: { contains: "100ml", mode: "insensitive" } },
        { name: { contains: "250ml", mode: "insensitive" } },
      ],
    },
    orderBy: { key: "asc" },
  });

  console.log("\nJAR PRODUCT TYPE PROFILES");
  console.table(profileMatches.map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    productionMode: p.productionMode,
    minQuantity: p.minQuantity,
    defaultQuantity: p.defaultQuantity,
    tierBreakpoints: p.tierBreakpoints,
    pricingMethod: p.pricingMethod,
    calculatorKind: p.calculatorKind,
    active: p.active,
  })));

  const materialMatches = await db.material.findMany({
    where: {
      shop: SHOP,
      OR: [
        { name: { contains: "Jar", mode: "insensitive" } },
        { name: { contains: "50ml", mode: "insensitive" } },
        { name: { contains: "100ml", mode: "insensitive" } },
        { name: { contains: "250ml", mode: "insensitive" } },
        { materialType: { contains: "jar" } },
        { productFamilies: { contains: "jar" } },
      ],
    },
    include: {
      vendors: true,
    },
    orderBy: [{ materialType: "asc" }, { name: "asc" }],
  });

  console.log("\nJAR MATERIALS");
  console.table(materialMatches.map((m) => ({
    id: m.id,
    name: m.name,
    materialType: m.materialType,
    productFamilies: m.productFamilies,
    unit: m.unit,
    costPerUnit: m.costPerUnit,
    purchaseCost: m.purchaseCost,
    purchaseUnit: m.purchaseUnit,
    active: m.active,
    vendorCount: m.vendors.length,
    notes: m.notes,
  })));

  console.log("\nJAR MATERIAL VENDOR TIERS / VENDOR RECORDS");
  for (const material of materialMatches) {
    if (!material.vendors.length) continue;

    console.log(`\n${material.name}`);
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

  const recipeMatches = await db.productRecipe.findMany({
    where: {
      shop: SHOP,
      OR: [
        { productType: { contains: "jar" } },
        { productType: { contains: "50ml" } },
        { productType: { contains: "100ml" } },
        { productType: { contains: "250ml" } },
        { name: { contains: "Jar", mode: "insensitive" } },
        { name: { contains: "50ml", mode: "insensitive" } },
        { name: { contains: "100ml", mode: "insensitive" } },
        { name: { contains: "250ml", mode: "insensitive" } },
      ],
    },
    include: {
      materials: { include: { material: true } },
      labelZones: true,
      mediaOptions: { include: { material: true } },
      tiers: true,
      sourcedTiers: true,
      addOns: true,
    },
    orderBy: [{ productType: "asc" }, { name: "asc" }],
  });

  console.log("\nJAR RECIPES");
  console.table(recipeMatches.map((r) => ({
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
    mediaOptions: r.mediaOptions.length,
    sellTiers: r.tiers.length,
    sourcedCostTiers: r.sourcedTiers.length,
    addOns: r.addOns.length,
  })));

  for (const recipe of recipeMatches) {
    console.log(`\nRECIPE DETAIL: ${recipe.name} / ${recipe.productType}`);

    console.log("Materials:");
    console.table(recipe.materials.map((m) => ({
      usageType: m.usageType,
      material: m.material?.name,
      quantity: m.quantity,
      unit: m.unit,
      wastePct: m.wastePct,
      active: m.active,
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
    })));

    console.log("Manufacturer / sourced cost tiers:");
    console.table(recipe.sourcedTiers.map((t) => ({
      minQty: t.minQty,
      unitCost: t.unitCost,
      vendor: t.vendor,
      notes: t.notes,
    })));

    console.log("Your sell / margin tiers:");
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
      shop: SHOP,
      OR: [
        { name: { contains: "Jar", mode: "insensitive" } },
        { name: { contains: "50ml", mode: "insensitive" } },
        { name: { contains: "100ml", mode: "insensitive" } },
        { name: { contains: "250ml", mode: "insensitive" } },
        { productType: { contains: "jar" } },
      ],
    },
    orderBy: [{ productType: "asc" }, { name: "asc" }],
  });

  console.log("\nVENDOR PRODUCTS MATCHING JARS");
  console.table(vendorProducts.map((v) => ({
    id: v.id,
    name: v.name,
    productType: v.productType,
    vendorName: v.vendorName,
    unitCost: v.unitCost,
    moq: v.moq,
    leadTimeDays: v.leadTimeDays,
    active: v.active,
  })));

  console.log("\nDECISION CHECK");
  console.log("If jar profiles exist but no materials/recipes/sourced tiers exist, add only the missing materials/recipes/tier costs.");
  console.log("If manufacturer tiers already exist, update or reuse them instead of duplicating.");
  console.log("If 250ml is missing, add a new jar_250ml product type/profile/material/recipe after reviewing your manufacturer pricing.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
