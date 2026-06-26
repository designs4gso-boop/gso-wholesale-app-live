import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const keys = ["labels", "sticker_bags", "dtp_bags", "boxes", "dtf_apparel"];

async function main() {
  console.log("ERP PRODUCT TYPE REUSE AUDIT");
  console.log(`Shop: ${shop}`);
  console.log(`Keys: ${keys.join(", ")}`);

  const profiles = await db.productTypeProfile.findMany({
    where: { shop, key: { in: keys } },
    orderBy: { key: "asc" },
  });

  console.log("\nPRODUCT TYPE PROFILES");
  console.table(profiles.map((x) => ({
    key: x.key,
    name: x.name,
    productionMode: x.productionMode,
    minQuantity: x.minQuantity,
    defaultQuantity: x.defaultQuantity,
    tierBreakpoints: x.tierBreakpoints,
    active: x.active,
  })));

  const recipes = await db.productRecipe.findMany({
    where: {
      shop,
      OR: [
        { productType: { in: keys } },
        { productFamily: { in: ["Labels", "Sticker Bags", "DTP Bags", "Boxes", "DTF / Apparel"] } },
      ],
    },
    include: {
      materials: true,
      labelZones: true,
      mediaOptions: true,
      inkRequirements: true,
      machineRules: true,
      tiers: true,
      addOns: true,
      variantRules: true,
      sourcedTiers: true,
    },
    orderBy: [
      { productFamily: "asc" },
      { productType: "asc" },
      { name: "asc" },
    ],
  });

  console.log("\nRECIPES SUMMARY");
  console.table(recipes.map((r) => ({
    id: r.id,
    name: r.name,
    productType: r.productType,
    productFamily: r.productFamily,
    active: r.active,
    costMethod: r.costMethod,
    productionMode: r.productionMode,
    minQty: r.minQuantity,
    defaultQty: r.defaultQuantity,
    materials: r.materials.length,
    labelZones: r.labelZones.length,
    mediaOptions: r.mediaOptions.length,
    inkReqs: r.inkRequirements.length,
    tiers: r.tiers.length,
    sourcedTiers: r.sourcedTiers.length,
    addOns: r.addOns.length,
    variantRules: r.variantRules.length,
  })));

  const materials = await db.material.findMany({
    where: {
      shop,
      OR: keys.map((key) => ({ productFamilies: { contains: key } })),
    },
    orderBy: [{ materialType: "asc" }, { name: "asc" }],
  });

  console.log("\nMATERIALS SUMMARY");
  console.table(materials.map((m) => ({
    name: m.name,
    materialType: m.materialType,
    productFamilies: m.productFamilies,
    unit: m.unit,
    costPerUnit: m.costPerUnit,
    active: m.active,
    useInRecipes: m.useInRecipes,
  })));

  const configuratorProducts = await db.configuratorProduct.groupBy({
    by: ["productType"],
    where: { shop, productType: { in: keys } },
    _count: { id: true },
    orderBy: { productType: "asc" },
  });

  const configuratorOptions = await db.configuratorOption.groupBy({
    by: ["productType", "group"],
    where: { shop, productType: { in: keys } },
    _count: { id: true },
    orderBy: [{ productType: "asc" }, { group: "asc" }],
  });

  const pricingRules = await db.configuratorPricingRule.groupBy({
    by: ["productType"],
    where: { shop, productType: { in: keys } },
    _count: { id: true },
    orderBy: { productType: "asc" },
  });

  console.log("\nCONFIGURATOR PRODUCTS USING OLD BROAD KEYS");
  console.table(configuratorProducts.map((x) => ({
    productType: x.productType,
    count: x._count.id,
  })));

  console.log("\nCONFIGURATOR OPTIONS USING OLD BROAD KEYS");
  console.table(configuratorOptions.map((x) => ({
    productType: x.productType,
    group: x.group,
    count: x._count.id,
  })));

  console.log("\nCONFIGURATOR PRICING RULES USING OLD BROAD KEYS");
  console.table(pricingRules.map((x) => ({
    productType: x.productType,
    count: x._count.id,
  })));

  console.log("\nAUDIT DECISION");
  console.log("- Reuse old broad keys for ERP recipe/material/admin setup.");
  console.log("- Use new exact product type keys for live storefront configurators.");
  console.log("- Do not delete old keys.");
  console.log("- Do not build duplicate recipe/material systems.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
