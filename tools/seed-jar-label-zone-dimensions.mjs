import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const zonesByProductType = {
  jar_50ml: [
    { name: "Side label", position: "Side", widthIn: 5.75, heightIn: 1.625, qtyPerUnit: 1, applicationSecondsPerLabel: 12, required: true, note: "Estimated from Miron specs: 48mm jar diameter = about 5.94in circumference. Use 5.75in width to leave a wrap gap. Verify with physical jar." },
    { name: "Lid label", position: "Lid", widthIn: 1.75, heightIn: 1.75, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true, note: "Estimated from Miron lid spec: 47.7mm lid diameter = about 1.88in. Verify with physical lid." },
    { name: "Lid side label", position: "Lid Side", widthIn: 5.75, heightIn: 0.5, qtyPerUnit: 1, applicationSecondsPerLabel: 12, required: false, note: "Estimated from Miron 50ml circumference. Optional wrap band. Verify with physical jar/lid." },
  ],
  jar_100ml_tall: [
    { name: "Side label", position: "Side", widthIn: 6.125, heightIn: 3.125, qtyPerUnit: 1, applicationSecondsPerLabel: 12, required: true },
    { name: "Lid label", position: "Lid", widthIn: 1.75, heightIn: 1.75, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true },
    { name: "Lid side label", position: "Lid Side", widthIn: 6.125, heightIn: 0.5, qtyPerUnit: 1, applicationSecondsPerLabel: 12, required: false },
  ],
  jar_100ml_wide: [
    { name: "Side label", position: "Side", widthIn: 6.43, heightIn: 2.6, qtyPerUnit: 1, applicationSecondsPerLabel: 12, required: true },
    { name: "Lid label", position: "Lid", widthIn: 1.875, heightIn: 1.875, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true },
    { name: "Lid side label", position: "Lid Side", widthIn: 6.43, heightIn: 0.5, qtyPerUnit: 1, applicationSecondsPerLabel: 12, required: false },
  ],
  jar_150ml: [
    { name: "Side label", position: "Side", widthIn: 7.125, heightIn: 3.125, qtyPerUnit: 1, applicationSecondsPerLabel: 13, required: true },
    { name: "Lid label", position: "Lid", widthIn: 2, heightIn: 2, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true },
    { name: "Lid side label", position: "Lid Side", widthIn: 7.125, heightIn: 0.5, qtyPerUnit: 1, applicationSecondsPerLabel: 12, required: false },
  ],
  jar_250ml: [
    { name: "Side label", position: "Side", widthIn: 9.375, heightIn: 2.875, qtyPerUnit: 1, applicationSecondsPerLabel: 15, required: true },
    { name: "Lid label", position: "Lid", widthIn: 2, heightIn: 2, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true },
    { name: "Lid side label", position: "Lid Side", widthIn: 9.375, heightIn: 0.5, qtyPerUnit: 1, applicationSecondsPerLabel: 12, required: false },
  ],
  jar_3oz_clear: [
    { name: "Side label", position: "Side", widthIn: 7.1, heightIn: 1.7, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true },
    { name: "Lid label", position: "Lid", widthIn: 2, heightIn: 2, qtyPerUnit: 1, applicationSecondsPerLabel: 8, required: true },
  ],
  jar_3oz_black_white: [
    { name: "Side label", position: "Side", widthIn: 7.1, heightIn: 1.7, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true },
    { name: "Lid label", position: "Lid", widthIn: 2, heightIn: 2, qtyPerUnit: 1, applicationSecondsPerLabel: 8, required: true },
  ],
  jar_4oz_clear: [
    { name: "Side label", position: "Side", widthIn: 7.125, heightIn: 2.125, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true },
    { name: "Lid label", position: "Lid", widthIn: 2.1, heightIn: 2.1, qtyPerUnit: 1, applicationSecondsPerLabel: 8, required: true },
  ],
  jar_4oz_black_white: [
    { name: "Side label", position: "Side", widthIn: 7.125, heightIn: 2.125, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true },
    { name: "Lid label", position: "Lid", widthIn: 2.1, heightIn: 2.1, qtyPerUnit: 1, applicationSecondsPerLabel: 8, required: true },
  ],
  jar_5oz_clear: [
    { name: "Side label", position: "Side", widthIn: 0, heightIn: 0, qtyPerUnit: 1, applicationSecondsPerLabel: 10, required: true, note: "Placeholder only. 5oz sell pricing and label size not confirmed." },
    { name: "Lid label", position: "Lid", widthIn: 0, heightIn: 0, qtyPerUnit: 1, applicationSecondsPerLabel: 8, required: true, note: "Placeholder only. 5oz sell pricing and label size not confirmed." },
  ],
};

async function main() {
  console.log("Updating jar recipe label zones with confirmed dimensions...");
  console.log(`Shop: ${shop}`);

  const summary = [];

  for (const [productType, zones] of Object.entries(zonesByProductType)) {
    const recipe = await db.productRecipe.findFirst({
      where: { shop, productType, active: true },
    });

    if (!recipe) {
      summary.push({ productType, status: "missing recipe", zones: 0 });
      continue;
    }

    await db.recipeLabelZone.deleteMany({
      where: { shop, recipeId: recipe.id },
    });

    await db.recipeLabelZone.createMany({
      data: zones.map((zone) => ({
        shop,
        recipeId: recipe.id,
        mediaMode: "fixed",
        name: zone.name,
        position: zone.position,
        widthIn: zone.widthIn,
        heightIn: zone.heightIn,
        qtyPerUnit: zone.qtyPerUnit,
        applicationSecondsPerLabel: zone.applicationSecondsPerLabel,
        required: zone.required,
        active: true,
        notes: zone.note || "Label zone dimension confirmed by GSO jar label size list.",
      })),
    });

    summary.push({
      productType,
      recipe: recipe.name,
      zones: zones.length,
      status: "updated",
    });
  }

  console.table(summary);
  console.log("DONE: Jar label zones updated.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
