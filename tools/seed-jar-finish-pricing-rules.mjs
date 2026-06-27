import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const ranges = [
  { minQty: 128, maxQty: 249 },
  { minQty: 250, maxQty: 499 },
  { minQty: 500, maxQty: 999 },
  { minQty: 1000, maxQty: 2499 },
  { minQty: 2500, maxQty: 999999 },
];

const blankCosts = {
  jar_50ml: [2.46, 2.24, 2.03, 1.89, 1.74],
  jar_100ml_tall: [2.86, 2.63, 2.41, 2.22, 2.07],
  jar_100ml_wide: [2.90, 2.67, 2.44, 2.26, 2.10],
  jar_150ml: [3.26, 3.00, 2.76, 2.54, 2.37],
  jar_250ml: [3.92, 3.60, 3.32, 3.11, 2.92],
  jar_3oz_clear: [0.50, 0.50, 0.50, 0.50, 0.50],
  jar_3oz_black_white: [0.62, 0.62, 0.62, 0.62, 0.62],
  jar_4oz_clear: [0.60, 0.60, 0.60, 0.60, 0.60],
  jar_4oz_black_white: [0.65, 0.65, 0.65, 0.65, 0.65],
};

const fullMatrices = {
  jar_50ml: [
    ["Matte", "CMYK", [4.35, 3.70, 3.45, 3.35, 3.05]],
    ["Matte", "1X Spot Gloss", [4.50, 3.85, 3.55, 3.45, 3.15]],
    ["Matte", "2X Spot Gloss", [4.60, 3.95, 3.65, 3.55, 3.25]],
    ["Matte", "3X Spot Gloss", [4.75, 4.10, 3.80, 3.65, 3.35]],
    ["Matte", "4X Spot Gloss", [4.90, 4.25, 3.95, 3.80, 3.45]],
    ["Holographic", "Vinyl + White", [4.45, 3.80, 3.55, 3.45, 3.15]],
    ["Holographic", "1X Spot Gloss", [4.55, 3.90, 3.60, 3.50, 3.20]],
    ["Holographic", "2X Spot Gloss", [4.75, 4.05, 3.75, 3.60, 3.30]],
    ["Holographic", "3X Spot Gloss", [4.85, 4.15, 3.85, 3.70, 3.40]],
    ["Holographic", "4X Spot Gloss", [5.00, 4.30, 4.00, 3.80, 3.45]],
  ],
  jar_100ml_tall: [
    ["Matte", "CMYK", [4.85, 4.15, 3.85, 3.75, 3.50]],
    ["Matte", "1X Spot Gloss", [5.10, 4.40, 4.05, 3.90, 3.65]],
    ["Matte", "2X Spot Gloss", [5.35, 4.60, 4.25, 4.05, 3.75]],
    ["Matte", "3X Spot Gloss", [5.55, 4.80, 4.40, 4.25, 3.90]],
    ["Matte", "4X Spot Gloss", [5.85, 5.05, 4.65, 4.45, 4.10]],
    ["Holographic", "Vinyl + White", [5.05, 4.35, 4.00, 3.85, 3.60]],
    ["Holographic", "1X Spot Gloss", [5.30, 4.55, 4.20, 4.05, 3.75]],
    ["Holographic", "2X Spot Gloss", [5.50, 4.75, 4.35, 4.20, 3.90]],
    ["Holographic", "3X Spot Gloss", [5.60, 4.85, 4.45, 4.25, 3.95]],
    ["Holographic", "4X Spot Gloss", [6.05, 5.25, 4.80, 4.60, 4.25]],
  ],
  jar_100ml_wide: [
    ["Matte", "CMYK", [5.00, 4.30, 3.95, 3.85, 3.55]],
    ["Matte", "1X Spot Gloss", [5.20, 4.50, 4.15, 4.00, 3.70]],
    ["Matte", "2X Spot Gloss", [5.45, 4.70, 4.35, 4.20, 3.85]],
    ["Matte", "3X Spot Gloss", [5.65, 4.90, 4.50, 4.35, 4.00]],
    ["Matte", "4X Spot Gloss", [5.90, 5.10, 4.70, 4.50, 4.15]],
    ["Holographic", "Vinyl + White", [5.15, 4.45, 4.10, 3.95, 3.65]],
    ["Holographic", "1X Spot Gloss", [5.40, 4.65, 4.30, 4.15, 3.80]],
    ["Holographic", "2X Spot Gloss", [5.60, 4.85, 4.45, 4.30, 3.95]],
    ["Holographic", "3X Spot Gloss", [5.85, 5.05, 4.65, 4.45, 4.10]],
    ["Holographic", "4X Spot Gloss", [6.05, 5.25, 4.85, 4.65, 4.25]],
  ],
  jar_150ml: [
    ["Matte", "CMYK", [5.50, 4.80, 4.40, 4.30, 4.00]],
    ["Matte", "1X Spot Gloss", [5.75, 5.05, 4.65, 4.50, 4.15]],
    ["Matte", "2X Spot Gloss", [6.05, 5.30, 4.85, 4.70, 4.35]],
    ["Matte", "3X Spot Gloss", [6.35, 5.55, 5.10, 4.90, 4.55]],
    ["Matte", "4X Spot Gloss", [6.65, 5.85, 5.35, 5.15, 4.70]],
    ["Holographic", "Vinyl + White", [5.75, 5.00, 4.60, 4.45, 4.15]],
    ["Holographic", "1X Spot Gloss", [6.00, 5.25, 4.80, 4.65, 4.30]],
    ["Holographic", "2X Spot Gloss", [6.30, 5.50, 5.05, 4.85, 4.50]],
    ["Holographic", "3X Spot Gloss", [6.60, 5.80, 5.30, 5.10, 4.65]],
    ["Holographic", "4X Spot Gloss", [6.90, 6.05, 5.55, 5.30, 4.85]],
  ],
  jar_250ml: [
    ["Matte", "CMYK", [6.55, 5.65, 5.30, 5.15, 4.75]],
    ["Matte", "1X Spot Gloss", [7.05, 6.10, 5.70, 5.50, 5.10]],
    ["Matte", "2X Spot Gloss", [7.55, 6.55, 6.10, 5.85, 5.40]],
    ["Matte", "3X Spot Gloss", [8.05, 7.00, 6.50, 6.20, 5.70]],
    ["Matte", "4X Spot Gloss", [8.55, 7.45, 6.90, 6.55, 6.00]],
    ["Holographic", "Vinyl + White", [6.95, 6.05, 5.65, 5.45, 5.05]],
    ["Holographic", "1X Spot Gloss", [7.45, 6.50, 6.05, 5.80, 5.35]],
    ["Holographic", "2X Spot Gloss", [7.95, 6.90, 6.45, 6.15, 5.65]],
    ["Holographic", "3X Spot Gloss", [8.45, 7.35, 6.80, 6.50, 5.95]],
    ["Holographic", "4X Spot Gloss", [8.95, 7.80, 7.20, 6.85, 6.30]],
  ],
  jar_3oz_clear: [
    ["Matte", "CMYK", [2.90, 2.75, 2.60, 2.50, 2.45]],
    ["Matte", "1X Spot Gloss", [3.05, 2.90, 2.75, 2.65, 2.60]],
    ["Matte", "2X Spot Gloss", [3.20, 3.05, 2.90, 2.80, 2.75]],
    ["Matte", "3X Spot Gloss", [3.35, 3.20, 3.05, 2.95, 2.85]],
    ["Holographic", "Vinyl + White", [3.05, 2.90, 2.75, 2.65, 2.60]],
    ["Holographic", "1X Spot Gloss", [3.20, 3.05, 2.90, 2.80, 2.70]],
    ["Holographic", "2X Spot Gloss", [3.35, 3.20, 3.05, 2.95, 2.85]],
    ["Holographic", "3X Spot Gloss", [3.55, 3.35, 3.20, 3.05, 3.00]],
  ],
  jar_3oz_black_white: [
    ["Matte", "CMYK", [2.90, 2.75, 2.60, 2.50, 2.45]],
    ["Matte", "1X Spot Gloss", [3.05, 2.90, 2.75, 2.65, 2.60]],
    ["Matte", "2X Spot Gloss", [3.20, 3.05, 2.90, 2.80, 2.75]],
    ["Matte", "3X Spot Gloss", [3.35, 3.20, 3.05, 2.95, 2.85]],
    ["Holographic", "Vinyl + White", [3.05, 2.90, 2.75, 2.65, 2.60]],
    ["Holographic", "1X Spot Gloss", [3.20, 3.05, 2.90, 2.80, 2.70]],
    ["Holographic", "2X Spot Gloss", [3.35, 3.20, 3.05, 2.95, 2.85]],
    ["Holographic", "3X Spot Gloss", [3.55, 3.35, 3.20, 3.05, 3.00]],
  ],
  jar_4oz_clear: [
    ["Matte", "CMYK", [2.80, 2.55, 2.40, 2.30, 2.10]],
    ["Matte", "1X Spot Gloss", [2.90, 2.70, 2.50, 2.40, 2.20]],
    ["Matte", "2X Spot Gloss", [3.05, 2.80, 2.65, 2.50, 2.35]],
    ["Matte", "3X Spot Gloss", [3.25, 2.95, 2.80, 2.65, 2.45]],
    ["Holographic", "Vinyl + White", [2.90, 2.65, 2.50, 2.40, 2.20]],
    ["Holographic", "1X Spot Gloss", [3.05, 2.80, 2.65, 2.50, 2.30]],
    ["Holographic", "2X Spot Gloss", [3.20, 2.95, 2.75, 2.60, 2.45]],
    ["Holographic", "3X Spot Gloss", [3.35, 3.10, 2.90, 2.75, 2.55]],
  ],
  jar_4oz_black_white: [
    ["Matte", "CMYK", [2.80, 2.55, 2.40, 2.30, 2.10]],
    ["Matte", "1X Spot Gloss", [2.90, 2.70, 2.50, 2.40, 2.20]],
    ["Matte", "2X Spot Gloss", [3.05, 2.80, 2.65, 2.50, 2.35]],
    ["Matte", "3X Spot Gloss", [3.25, 2.95, 2.80, 2.65, 2.45]],
    ["Holographic", "Vinyl + White", [2.90, 2.65, 2.50, 2.40, 2.20]],
    ["Holographic", "1X Spot Gloss", [3.05, 2.80, 2.65, 2.50, 2.30]],
    ["Holographic", "2X Spot Gloss", [3.20, 2.95, 2.75, 2.60, 2.45]],
    ["Holographic", "3X Spot Gloss", [3.35, 3.10, 2.90, 2.75, 2.55]],
  ],
};

async function main() {
  console.log("Seeding jar configurator finish pricing matrix...");
  console.log(`Shop: ${shop}`);

  let createdOrUpdated = 0;
  const summary = [];

  for (const [productType, rows] of Object.entries(fullMatrices)) {
    let count = 0;

    for (const [material, finish, prices] of rows) {
      for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        const priceEach = prices[i];
        const costEach = blankCosts[productType][i];

        await db.configuratorPricingRule.upsert({
          where: {
            shop_productType_material_finish_sides_minQty_maxQty: {
              shop,
              productType,
              material,
              finish,
              sides: "Jar Label Set",
              minQty: range.minQty,
              maxQty: range.maxQty,
            },
          },
          update: {
            productionFinish: finish,
            priceEach,
            costEach,
            active: true,
            priority: 100,
            notes: "Seeded from GSO Custom Miron Jar pricing sheet. CostEach currently reflects blank jar/lid cost only; recipe/material calculator handles print/application cost separately.",
          },
          create: {
            shop,
            productType,
            material,
            finish,
            productionFinish: finish,
            sides: "Jar Label Set",
            minQty: range.minQty,
            maxQty: range.maxQty,
            priceEach,
            costEach,
            active: true,
            priority: 100,
            notes: "Seeded from GSO Custom Miron Jar pricing sheet. CostEach currently reflects blank jar/lid cost only; recipe/material calculator handles print/application cost separately.",
          },
        });

        createdOrUpdated += 1;
        count += 1;
      }
    }

    summary.push({ productType, pricingRules: count });
  }

  console.table(summary);
  console.log(`DONE: ${createdOrUpdated} jar pricing rule rows seeded/updated.`);
  console.log("Note: 3oz and 4oz sheets stop at 3X Spot Gloss, so no 4X rows were seeded for those.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
