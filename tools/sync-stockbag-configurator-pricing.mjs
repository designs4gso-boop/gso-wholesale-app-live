import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const shop = process.env.SHOP || "942075-2.myshopify.com";
const productType = "stock_bag_4x5";
const sides = "Double Sided";

const ranges = [
  { minQty: 64, maxQty: 256 },
  { minQty: 257, maxQty: 640 },
  { minQty: 641, maxQty: 1280 },
  { minQty: 1281, maxQty: 1920 },
  { minQty: 1921, maxQty: null },
];

const rows = [
  {
    material: "Matte",
    finish: "No Spot Gloss",
    productionFinish: "Matte",
    costEach: 0.60,
    prices: [1.75, 1.65, 1.55, 1.45, 1.35],
  },
  {
    material: "Matte",
    finish: "1X Spot Gloss",
    productionFinish: "Matte + 1X Spot Gloss",
    costEach: 0.75,
    prices: [2.05, 1.95, 1.85, 1.75, 1.65],
  },
  {
    material: "Matte",
    finish: "2X Spot Gloss",
    productionFinish: "Matte + 2X Spot Gloss",
    costEach: 0.90,
    prices: [2.15, 2.05, 1.95, 1.85, 1.75],
  },
  {
    material: "Matte",
    finish: "3X Spot Gloss",
    productionFinish: "Matte + 3X Spot Gloss",
    costEach: 1.02,
    prices: [2.80, 2.60, 2.40, 2.20, 2.05],
  },
  {
    material: "Holographic",
    finish: "No Spot Gloss",
    productionFinish: "Holographic Vinyl + CMYK + White",
    costEach: 0.88,
    prices: [1.80, 1.65, 1.50, 1.35, 1.25],
  },
  {
    material: "Holographic",
    finish: "1X Spot Gloss",
    productionFinish: "Holo + White + 1X Spot Gloss",
    costEach: 1.03,
    prices: [2.25, 2.05, 1.90, 1.75, 1.60],
  },
  {
    material: "Holographic",
    finish: "2X Spot Gloss",
    productionFinish: "Holo + White + 2X Spot Gloss",
    costEach: 1.03,
    prices: [2.40, 2.20, 2.05, 1.90, 1.75],
  },
  {
    material: "Holographic",
    finish: "3X Spot Gloss",
    productionFinish: "Holo + White + 3X Spot Gloss",
    costEach: 1.18,
    prices: [2.55, 2.35, 2.15, 1.95, 1.85],
  },
  {
    material: "Holographic",
    finish: "4X Spot Gloss",
    productionFinish: "Holo + White + 4X Spot Gloss",
    costEach: 1.18,
    prices: [2.85, 2.65, 2.45, 2.25, 2.05],
  },
];

async function main() {
  const data = [];

  for (const row of rows) {
    for (let index = 0; index < ranges.length; index += 1) {
      data.push({
        shop,
        productType,
        material: row.material,
        finish: row.finish,
        productionFinish: row.productionFinish,
        sides,
        minQty: ranges[index].minQty,
        maxQty: ranges[index].maxQty,
        priceEach: row.prices[index],
        costEach: row.costEach,
        active: true,
        priority: 100,
        notes: "Synced corrected stock bag finished price matrix.",
      });
    }
  }

  const materials = [...new Set(rows.map((row) => row.material))];
  const finishes = [...new Set(rows.map((row) => row.finish))];

  const deleted = await db.configuratorPricingRule.deleteMany({
    where: {
      shop,
      productType,
      material: { in: materials },
      finish: { in: finishes },
      sides,
    },
  });

  await db.configuratorPricingRule.createMany({ data });

  console.log(`Shop: ${shop}`);
  console.log(`Product type: ${productType}`);
  console.log(`Deleted old rows: ${deleted.count}`);
  console.log(`Created corrected rows: ${data.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
