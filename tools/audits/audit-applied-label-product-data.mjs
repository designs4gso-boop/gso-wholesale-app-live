import { PrismaClient } from "@prisma/client";

// Internal read-only Prisma audit script.
// Uses the current DATABASE_URL and defaults to shop 942075-2.myshopify.com.
// Prints internal pricing/cost/vendor data; do not share output publicly.
// Does not write or mutate data.

const db = new PrismaClient();
const SHOP = process.env.SHOPIFY_SHOP || "942075-2.myshopify.com";

const exactTypes = [
  "stock_bag_4x5",
  "sticker_bag_4x5",
  "label_only",
  "jar_50ml",
  "jar_100ml_tall",
  "jar_100ml_wide",
  "jar_150ml",
  "jar_250ml",
  "jar_3oz_clear",
  "jar_3oz_black_white",
  "jar_4oz_clear",
  "jar_4oz_black_white"
];

const searchNames = [
  "jar",
  "50ml",
  "100ml",
  "label",
  "sticker",
  "stock bag",
  "applied label"
];

async function main() {
  console.log("APPLIED LABEL PRODUCTS DUPLICATE AUDIT");
  console.log(`Shop: ${SHOP}`);

  const profiles = await db.productTypeProfile.findMany({
    where: {
      shop: SHOP,
      OR: [
        { key: { in: exactTypes } },
        { name: { contains: "Jar", mode: "insensitive" } },
        { name: { contains: "Label", mode: "insensitive" } },
        { name: { contains: "Sticker", mode: "insensitive" } },
        { name: { contains: "Stock Bag", mode: "insensitive" } },
      ],
    },
    orderBy: { key: "asc" },
  });

  console.log("\nPRODUCT TYPE PROFILES FOUND");
  console.table(profiles.map((p) => ({
    key: p.key,
    name: p.name,
    productionMode: p.productionMode,
    minQuantity: p.minQuantity,
    defaultQuantity: p.defaultQuantity,
    tierBreakpoints: p.tierBreakpoints,
    active: p.active,
    calculatorKind: p.calculatorKind,
  })));

  const materials = await db.material.findMany({
    where: {
      shop: SHOP,
      OR: [
        { name: { contains: "Jar", mode: "insensitive" } },
        { name: { contains: "50ml", mode: "insensitive" } },
        { name: { contains: "100ml", mode: "insensitive" } },
        { name: { contains: "Blank", mode: "insensitive" } },
        { productFamilies: { contains: "jar" } },
        { productFamilies: { contains: "labels" } },
        { productFamilies: { contains: "sticker_bags" } },
        { productFamilies: { contains: "applied_label" } },
      ],
    },
    orderBy: [{ materialType: "asc" }, { name: "asc" }],
  });

  console.log("\nMATERIALS FOUND");
  console.table(materials.map((m) => ({
    id: m.id,
    name: m.name,
    materialType: m.materialType,
    productFamilies: m.productFamilies,
    unit: m.unit,
    costPerUnit: m.costPerUnit,
    active: m.active,
    useInRecipes: m.useInRecipes,
    notes: m.notes,
  })));

  const recipes = await db.productRecipe.findMany({
    where: {
      shop: SHOP,
      OR: [
        { productType: { in: exactTypes } },
        { productFamily: { contains: "Applied", mode: "insensitive" } },
        { productFamily: { contains: "Label", mode: "insensitive" } },
        { productFamily: { contains: "Sticker", mode: "insensitive" } },
        { name: { contains: "Jar", mode: "insensitive" } },
        { name: { contains: "50ml", mode: "insensitive" } },
        { name: { contains: "100ml", mode: "insensitive" } },
        { name: { contains: "Label", mode: "insensitive" } },
        { name: { contains: "Sticker", mode: "insensitive" } },
        { name: { contains: "Stock Bag", mode: "insensitive" } },
      ],
    },
    include: {
      materials: true,
      labelZones: true,
      mediaOptions: true,
      tiers: true,
      addOns: true,
      variantRules: true,
      sourcedTiers: true,
    },
    orderBy: [{ productFamily: "asc" }, { productType: "asc" }, { name: "asc" }],
  });

  console.log("\nRECIPES FOUND");
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
    mediaOptions: r.mediaOptions.length,
    tiers: r.tiers.length,
    sourcedTiers: r.sourcedTiers.length,
    addOns: r.addOns.length,
    variantRules: r.variantRules.length,
  })));

  const configuratorProducts = await db.configuratorProduct.findMany({
    where: {
      shop: SHOP,
      OR: [
        { productType: { in: exactTypes } },
        { title: { contains: "Jar", mode: "insensitive" } },
        { title: { contains: "Label", mode: "insensitive" } },
        { title: { contains: "Sticker", mode: "insensitive" } },
      ],
    },
    orderBy: [{ productType: "asc" }, { title: "asc" }],
  });

  console.log("\nCONFIGURATOR PRODUCTS FOUND");
  console.table(configuratorProducts.map((p) => ({
    title: p.title,
    productType: p.productType,
    handle: p.shopifyHandle,
    active: p.active,
    pilot: p.pilot,
    minQuantity: p.minQuantity,
  })));

  const options = await db.configuratorOption.groupBy({
    by: ["productType", "group"],
    where: { shop: SHOP, productType: { in: exactTypes } },
    _count: { id: true },
    orderBy: [{ productType: "asc" }, { group: "asc" }],
  });

  console.log("\nCONFIGURATOR OPTIONS FOUND");
  console.table(options.map((o) => ({
    productType: o.productType,
    group: o.group,
    count: o._count.id,
  })));

  const pricingRules = await db.configuratorPricingRule.groupBy({
    by: ["productType", "material", "finish"],
    where: { shop: SHOP, productType: { in: exactTypes } },
    _count: { id: true },
    orderBy: [{ productType: "asc" }, { material: "asc" }, { finish: "asc" }],
  });

  console.log("\nCONFIGURATOR PRICING RULES FOUND");
  console.table(pricingRules.map((r) => ({
    productType: r.productType,
    material: r.material,
    finish: r.finish,
    count: r._count.id,
  })));

  console.log("\nAUDIT NEXT STEP");
  console.log("If jar materials/recipes are missing, add only those.");
  console.log("If jar records already exist, reuse or repair them instead of creating duplicates.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
