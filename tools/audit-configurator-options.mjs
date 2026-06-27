import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const options = await db.configuratorOption.findMany({
  where: { shop },
  orderBy: [
    { productType: "asc" },
    { group: "asc" },
    { sortOrder: "asc" },
    { value: "asc" },
  ],
});

console.table(options.map((o) => ({
  productType: o.productType,
  group: o.group,
  value: o.value,
  label: o.label,
  sortOrder: o.sortOrder,
  active: o.active,
})));

const rules = await db.configuratorPricingRule.groupBy({
  by: ["productType"],
  where: { shop },
  _count: { _all: true },
  orderBy: { productType: "asc" },
});

console.log("");
console.log("Pricing rule count by product type:");
console.table(rules.map((r) => ({
  productType: r.productType,
  rules: r._count._all,
})));

await db.$disconnect();
