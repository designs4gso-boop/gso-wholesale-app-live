import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const JARS = [
  {
    key: "jar_50ml",
    name: "50ml Miron Jar with Applied Label",
    profileName: "50ml Jar with Applied Label",
    materialName: "50ml Miron Blank Jar + Lid",
    vendorProductName: "50ml Miron jar + lid",
    vendor: "MIRON",
    vendorSku: "preset:miron-50ml",
    moq: 128,
    defaultUnitCost: 2.46,
    tiers: [
      { minQty: 1, maxQty: 249, unitCost: 2.46, notes: "Cost Calculator preset <250" },
      { minQty: 250, maxQty: 499, unitCost: 2.24, notes: "Cost Calculator preset 250+" },
      { minQty: 500, maxQty: 999, unitCost: 2.03, notes: "Cost Calculator preset 500+" },
      { minQty: 1000, maxQty: 2499, unitCost: 1.89, notes: "Cost Calculator preset 1,000+" },
      { minQty: 2500, maxQty: null, unitCost: 1.74, notes: "Cost Calculator preset 2,500+" },
    ],
  },
  {
    key: "jar_100ml_tall",
    name: "100ml Tall Miron Jar with Applied Label",
    profileName: "100ml Tall Jar with Applied Label",
    materialName: "100ml Tall Miron Blank Jar + Lid",
    vendorProductName: "100ml tall Miron jar + lid",
    vendor: "MIRON",
    vendorSku: "preset:miron-100ml-tall",
    moq: 128,
    defaultUnitCost: 2.86,
    tiers: [
      { minQty: 1, maxQty: 249, unitCost: 2.86, notes: "Cost Calculator preset <250" },
      { minQty: 250, maxQty: 499, unitCost: 2.63, notes: "Cost Calculator preset 250+" },
      { minQty: 500, maxQty: 999, unitCost: 2.41, notes: "Cost Calculator preset 500+" },
      { minQty: 1000, maxQty: 2499, unitCost: 2.22, notes: "Cost Calculator preset 1,000+" },
      { minQty: 2500, maxQty: null, unitCost: 2.07, notes: "Cost Calculator preset 2,500+" },
    ],
  },
  {
    key: "jar_100ml_wide",
    name: "100ml Wide Miron Jar with Applied Label",
    profileName: "100ml Wide Jar with Applied Label",
    materialName: "100ml Wide Miron Blank Jar + Lid",
    vendorProductName: "100ml wide Miron jar + lid",
    vendor: "MIRON",
    vendorSku: "preset:miron-100ml-wide",
    moq: 128,
    defaultUnitCost: 2.90,
    tiers: [
      { minQty: 1, maxQty: 249, unitCost: 2.90, notes: "Cost Calculator preset <250" },
      { minQty: 250, maxQty: 499, unitCost: 2.67, notes: "Cost Calculator preset 250+" },
      { minQty: 500, maxQty: 999, unitCost: 2.44, notes: "Cost Calculator preset 500+" },
      { minQty: 1000, maxQty: 2499, unitCost: 2.26, notes: "Cost Calculator preset 1,000+" },
      { minQty: 2500, maxQty: null, unitCost: 2.10, notes: "Cost Calculator preset 2,500+" },
    ],
  },
  {
    key: "jar_150ml",
    name: "150ml Miron Jar with Applied Label",
    profileName: "150ml Jar with Applied Label",
    materialName: "150ml Miron Blank Jar + Lid",
    vendorProductName: "150ml Miron jar + lid",
    vendor: "MIRON",
    vendorSku: "preset:miron-150ml",
    moq: 128,
    defaultUnitCost: 3.26,
    tiers: [
      { minQty: 1, maxQty: 249, unitCost: 3.26, notes: "Cost Calculator preset <250" },
      { minQty: 250, maxQty: 499, unitCost: 3.00, notes: "Cost Calculator preset 250+" },
      { minQty: 500, maxQty: 999, unitCost: 2.76, notes: "Cost Calculator preset 500+" },
      { minQty: 1000, maxQty: 2499, unitCost: 2.54, notes: "Cost Calculator preset 1,000+" },
      { minQty: 2500, maxQty: null, unitCost: 2.37, notes: "Cost Calculator preset 2,500+" },
    ],
  },
  {
    key: "jar_250ml",
    name: "250ml Miron Jar with Applied Label",
    profileName: "250ml Jar with Applied Label",
    materialName: "250ml Miron Blank Jar + Lid",
    vendorProductName: "250ml Miron jar + lid",
    vendor: "MIRON",
    vendorSku: "preset:miron-250ml",
    moq: 128,
    defaultUnitCost: 3.92,
    tiers: [
      { minQty: 1, maxQty: 249, unitCost: 3.92, notes: "Cost Calculator preset <250" },
      { minQty: 250, maxQty: 499, unitCost: 3.60, notes: "Cost Calculator preset 250+" },
      { minQty: 500, maxQty: 999, unitCost: 3.32, notes: "Cost Calculator preset 500+" },
      { minQty: 1000, maxQty: 2499, unitCost: 3.11, notes: "Cost Calculator preset 1,000+" },
      { minQty: 2500, maxQty: null, unitCost: 2.92, notes: "Cost Calculator preset 2,500+" },
    ],
  },
  {
    key: "jar_3oz_clear",
    name: "3oz Clear Jar with Applied Label",
    profileName: "3oz Clear Jar with Applied Label",
    materialName: "3oz Clear Blank Jar",
    vendorProductName: "3oz jar - clear",
    vendor: "SAFE CARE",
    vendorSku: "preset:3oz-jar-clear",
    moq: 1,
    defaultUnitCost: 0.50,
    tiers: [{ minQty: 1, maxQty: null, unitCost: 0.50, notes: "Flat Cost Calculator preset" }],
  },
  {
    key: "jar_3oz_black_white",
    name: "3oz Black/White Jar with Applied Label",
    profileName: "3oz Black/White Jar with Applied Label",
    materialName: "3oz Black/White Blank Jar",
    vendorProductName: "3oz jar - black/white",
    vendor: "SAFE CARE",
    vendorSku: "preset:3oz-jar-black-white",
    moq: 1,
    defaultUnitCost: 0.62,
    tiers: [{ minQty: 1, maxQty: null, unitCost: 0.62, notes: "Flat Cost Calculator preset" }],
  },
  {
    key: "jar_4oz_clear",
    name: "4oz Clear Jar with Applied Label",
    profileName: "4oz Clear Jar with Applied Label",
    materialName: "4oz Clear Blank Jar",
    vendorProductName: "4oz jar - clear",
    vendor: "SAFE CARE",
    vendorSku: "preset:4oz-jar-clear",
    moq: 1,
    defaultUnitCost: 0.60,
    tiers: [{ minQty: 1, maxQty: null, unitCost: 0.60, notes: "Flat Cost Calculator preset" }],
  },
  {
    key: "jar_4oz_black_white",
    name: "4oz Black/White Jar with Applied Label",
    profileName: "4oz Black/White Jar with Applied Label",
    materialName: "4oz Black/White Blank Jar",
    vendorProductName: "4oz jar - black/white",
    vendor: "SAFE CARE",
    vendorSku: "preset:4oz-jar-black-white",
    moq: 1,
    defaultUnitCost: 0.65,
    tiers: [{ minQty: 1, maxQty: null, unitCost: 0.65, notes: "Flat Cost Calculator preset" }],
  },
  {
    key: "jar_5oz_clear",
    name: "5oz Clear Jar with Applied Label",
    profileName: "5oz Clear Jar with Applied Label",
    materialName: "5oz Clear Blank Jar",
    vendorProductName: "5oz jar - clear",
    vendor: "SAFE CARE",
    vendorSku: "preset:5oz-jar-clear",
    moq: 1,
    defaultUnitCost: 0.60,
    tiers: [{ minQty: 1, maxQty: null, unitCost: 0.60, notes: "Flat Cost Calculator preset" }],
  },
];

function profileTierBreakpoints(jar) {
  if (jar.vendor === "MIRON") return "128,250,500,1000,2500";
  return "1";
}

async function upsertProfile(jar) {
  const existing = await db.productTypeProfile.findUnique({
    where: { shop_key: { shop, key: jar.key } },
  });

  const data = {
    name: jar.profileName,
    productionMode: "in_house",
    minQuantity: jar.moq,
    defaultQuantity: jar.moq,
    tierBreakpoints: profileTierBreakpoints(jar),
    pricingMethod: "auto_margin",
    calculatorKind: "jar",
    notes: "Applied Label Products family. Blank jar cost plus printed/applied label. Seeded from Cost Calculator jar presets.",
    active: true,
  };

  if (existing) {
    return db.productTypeProfile.update({
      where: { id: existing.id },
      data,
    });
  }

  return db.productTypeProfile.create({
    data: {
      shop,
      key: jar.key,
      ...data,
    },
  });
}

async function upsertVendorProduct(jar) {
  const existing = await db.vendorProduct.findFirst({
    where: { shop, vendorSku: jar.vendorSku },
  });

  const data = {
    name: jar.vendorProductName,
    productType: "jar",
    vendor: jar.vendor,
    vendorSku: jar.vendorSku,
    moq: jar.moq,
    defaultUnitCost: jar.defaultUnitCost,
    leadTimeDays: null,
    notes: "Seeded from app.erp.cost-calculator.tsx presetBlankItems(). Manufacturer/blank jar cost only, not finished sell price.",
    active: true,
  };

  let vendorProduct;
  if (existing) {
    vendorProduct = await db.vendorProduct.update({
      where: { id: existing.id },
      data,
    });
    await db.vendorProductTier.deleteMany({ where: { shop, vendorProductId: existing.id } });
  } else {
    vendorProduct = await db.vendorProduct.create({
      data: { shop, ...data },
    });
  }

  await db.vendorProductTier.createMany({
    data: jar.tiers.map((tier) => ({
      shop,
      vendorProductId: vendorProduct.id,
      minQty: tier.minQty,
      maxQty: tier.maxQty,
      unitCost: tier.unitCost,
      notes: tier.notes,
    })),
  });

  return vendorProduct;
}

async function upsertMaterial(jar) {
  const existing = await db.material.findFirst({
    where: { shop, sku: jar.vendorSku },
  });

  const data = {
    name: jar.materialName,
    materialType: "blank_jars",
    productFamilies: "jar,applied_label_products,labels",
    unit: "each",
    costPerUnit: jar.defaultUnitCost,
    purchaseUnit: "each",
    purchaseCost: jar.defaultUnitCost,
    calculatedUnitCost: jar.defaultUnitCost,
    vendor: jar.vendor,
    sku: jar.vendorSku,
    useInRecipes: true,
    costReviewNeeded: false,
    active: true,
    notes: "Blank jar/lid cost seeded from Cost Calculator presets. Use vendor product tiers for quantity-based cost.",
  };

  let material;
  if (existing) {
    material = await db.material.update({
      where: { id: existing.id },
      data,
    });
  } else {
    material = await db.material.create({
      data: { shop, ...data },
    });
  }

  const preferredVendor = await db.materialVendor.findFirst({
    where: { shop, materialId: material.id, vendorSku: jar.vendorSku },
  });

  if (preferredVendor) {
    await db.materialVendor.update({
      where: { id: preferredVendor.id },
      data: {
        vendorName: jar.vendor,
        unitCost: jar.defaultUnitCost,
        unit: "each",
        moq: jar.moq,
        preferred: true,
        active: true,
        notes: "Preferred vendor record seeded from jar preset.",
      },
    });
  } else {
    await db.materialVendor.create({
      data: {
        shop,
        materialId: material.id,
        vendorName: jar.vendor,
        vendorSku: jar.vendorSku,
        unitCost: jar.defaultUnitCost,
        unit: "each",
        moq: jar.moq,
        preferred: true,
        active: true,
        notes: "Preferred vendor record seeded from jar preset.",
      },
    });
  }

  return material;
}

async function upsertRecipe(jar, profile, vendorProduct, material) {
  const existing = await db.productRecipe.findFirst({
    where: { shop, productType: jar.key, name: jar.name },
  });

  const data = {
    productTypeProfileId: profile.id,
    name: jar.name,
    sku: jar.vendorSku,
    productType: jar.key,
    productFamily: "Applied Label Products",
    pricingTemplateMode: "template",
    useInQuotes: true,
    applicationLaborSecondsPerUnit: 10,
    packingLaborSecondsPerUnit: 0,
    prepressMinutes: 10,
    costMethod: "recipe",
    productionMode: "in_house",
    vendorProductId: vendorProduct.id,
    minQuantity: jar.moq,
    defaultQuantity: jar.moq,
    targetMarginPct: 40,
    wastePct: 2,
    setupCost: 0,
    laborMinutes: 0,
    notes: "Jar applied-label recipe shell. Includes blank jar/lid material. Add label zones and finished sell tiers after price sheet review.",
    active: true,
  };

  let recipe;
  if (existing) {
    recipe = await db.productRecipe.update({
      where: { id: existing.id },
      data,
    });
  } else {
    recipe = await db.productRecipe.create({
      data: { shop, ...data },
    });
  }

  const existingMaterial = await db.recipeMaterial.findFirst({
    where: { shop, recipeId: recipe.id, materialId: material.id, usageType: "blank" },
  });

  if (existingMaterial) {
    await db.recipeMaterial.update({
      where: { id: existingMaterial.id },
      data: {
        quantity: 1,
        unit: "each",
        wastePct: 2,
        includeWaste: true,
        active: true,
        notes: "Blank jar/lid per finished jar.",
      },
    });
  } else {
    await db.recipeMaterial.create({
      data: {
        shop,
        recipeId: recipe.id,
        materialId: material.id,
        usageType: "blank",
        quantity: 1,
        unit: "each",
        wastePct: 2,
        includeWaste: true,
        active: true,
        notes: "Blank jar/lid per finished jar.",
      },
    });
  }

  await db.sourcedCostTier.deleteMany({ where: { shop, recipeId: recipe.id } });
  await db.sourcedCostTier.createMany({
    data: jar.tiers.map((tier) => ({
      shop,
      recipeId: recipe.id,
      minQty: tier.minQty,
      unitCost: tier.unitCost,
      vendor: jar.vendor,
      notes: tier.notes,
    })),
  });

  return recipe;
}

async function main() {
  console.log("Seeding jar ERP foundation from Cost Calculator presets...");
  console.log(`Shop: ${shop}`);

  const results = [];

  for (const jar of JARS) {
    const profile = await upsertProfile(jar);
    const vendorProduct = await upsertVendorProduct(jar);
    const material = await upsertMaterial(jar);
    const recipe = await upsertRecipe(jar, profile, vendorProduct, material);

    results.push({
      key: jar.key,
      profile: profile.name,
      vendorProduct: vendorProduct.name,
      material: material.name,
      recipe: recipe.name,
    });
  }

  console.table(results);
  console.log("DONE: Jar profiles, vendor products, materials, recipe shells, and sourced cost tiers are seeded.");
  console.log("NEXT: Add finished GSO sell-price tiers from your jar price sheets.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
