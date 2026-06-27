import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const SELL_TIERS = [
  {
    productType: "jar_50ml",
    prices: [4.35, 3.70, 3.45, 3.35, 3.05],
  },
  {
    productType: "jar_100ml_tall",
    prices: [4.85, 4.15, 3.85, 3.75, 3.50],
  },
  {
    productType: "jar_100ml_wide",
    prices: [5.00, 4.30, 3.95, 3.85, 3.55],
  },
  {
    productType: "jar_150ml",
    prices: [5.50, 4.80, 4.40, 4.30, 4.00],
  },
  {
    productType: "jar_250ml",
    prices: [6.55, 5.65, 5.30, 5.15, 4.75],
  },
  {
    productType: "jar_3oz_clear",
    prices: [2.90, 2.75, 2.60, 2.50, 2.45],
  },
  {
    productType: "jar_3oz_black_white",
    prices: [2.90, 2.75, 2.60, 2.50, 2.45],
  },
  {
    productType: "jar_4oz_clear",
    prices: [2.80, 2.55, 2.40, 2.30, 2.10],
  },
  {
    productType: "jar_4oz_black_white",
    prices: [2.80, 2.55, 2.40, 2.30, 2.10],
  },
];

const ranges = [
  { minQty: 128, maxQty: 249 },
  { minQty: 250, maxQty: 499 },
  { minQty: 500, maxQty: 999 },
  { minQty: 1000, maxQty: 2499 },
  { minQty: 2500, maxQty: null },
];

async function main() {
  console.log("Seeding base Matte / CMYK finished jar sell tiers...");
  console.log(`Shop: ${shop}`);

  const results = [];

  for (const row of SELL_TIERS) {
    const recipe = await db.productRecipe.findFirst({
      where: {
        shop,
        productType: row.productType,
        active: true,
      },
    });

    if (!recipe) {
      results.push({
        productType: row.productType,
        status: "missing recipe",
      });
      continue;
    }

    await db.recipeTier.deleteMany({
      where: {
        shop,
        recipeId: recipe.id,
      },
    });

    await db.recipeTier.createMany({
      data: ranges.map((range, index) => ({
        shop,
        recipeId: recipe.id,
        minQty: range.minQty,
        maxQty: range.maxQty,
        marginPct: null,
        fixedPrice: row.prices[index],
        notes: "Base finished sell price: Matte / CMYK. Seeded from GSO jar pricing sheet. Finish-specific pricing matrix will be handled separately.",
      })),
    });

    results.push({
      productType: row.productType,
      recipe: recipe.name,
      sellTiers: row.prices.join(", "),
      status: "seeded",
    });
  }

  console.table(results);
  console.log("DONE: Base Matte / CMYK finished jar sell tiers seeded.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
