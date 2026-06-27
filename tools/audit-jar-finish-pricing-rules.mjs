import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const rows = await db.configuratorPricingRule.groupBy({
  by: ["productType", "material", "finish"],
  where: {
    shop,
    productType: {
      in: [
        "jar_50ml",
        "jar_100ml_tall",
        "jar_100ml_wide",
        "jar_150ml",
        "jar_250ml",
        "jar_3oz_clear",
        "jar_3oz_black_white",
        "jar_4oz_clear",
        "jar_4oz_black_white",
      ],
    },
  },
  _count: { _all: true },
  orderBy: [
    { productType: "asc" },
    { material: "asc" },
    { finish: "asc" },
  ],
});

console.table(rows.map((r) => ({
  productType: r.productType,
  material: r.material,
  finish: r.finish,
  rows: r._count._all,
})));

const total = await db.configuratorPricingRule.count({
  where: {
    shop,
    productType: {
      startsWith: "jar_",
    },
  },
});

console.log(`Total jar configurator pricing rules: ${total}`);

await db.$disconnect();
