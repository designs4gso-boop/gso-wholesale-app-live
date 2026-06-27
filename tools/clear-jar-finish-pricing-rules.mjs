import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const deleted = await db.configuratorPricingRule.deleteMany({
  where: {
    shop,
    productType: {
      startsWith: "jar_",
    },
  },
});

console.log(`Deleted ${deleted.count} partial jar configurator pricing rules.`);

await db.$disconnect();
