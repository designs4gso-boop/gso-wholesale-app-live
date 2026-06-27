import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const jarProductTypes = [
  "jar_50ml",
  "jar_100ml_tall",
  "jar_100ml_wide",
  "jar_150ml",
  "jar_250ml",
  "jar_3oz_clear",
  "jar_3oz_black_white",
  "jar_4oz_clear",
  "jar_4oz_black_white",
];

const finishOptionsByType = {
  miron: [
    { value: "No Spot Gloss", label: "No Spot Gloss", sortOrder: 1 },
    { value: "1X Spot Gloss", label: "1X Spot Gloss", sortOrder: 2 },
    { value: "2X Spot Gloss", label: "2X Spot Gloss", sortOrder: 3 },
    { value: "3X Spot Gloss", label: "3X Spot Gloss", sortOrder: 4 },
    { value: "4X Spot Gloss", label: "4X Spot Gloss", sortOrder: 5 },
  ],
  standard: [
    { value: "No Spot Gloss", label: "No Spot Gloss", sortOrder: 1 },
    { value: "1X Spot Gloss", label: "1X Spot Gloss", sortOrder: 2 },
    { value: "2X Spot Gloss", label: "2X Spot Gloss", sortOrder: 3 },
    { value: "3X Spot Gloss", label: "3X Spot Gloss", sortOrder: 4 },
  ],
};

function isMiron(productType) {
  return [
    "jar_50ml",
    "jar_100ml_tall",
    "jar_100ml_wide",
    "jar_150ml",
    "jar_250ml",
  ].includes(productType);
}

async function upsertOption(productType, option) {
  await db.configuratorOption.upsert({
    where: {
      shop_productType_group_value: {
        shop,
        productType,
        group: "Finish",
        value: option.value,
      },
    },
    update: {
      label: option.label,
      sortOrder: option.sortOrder,
      active: true,
    },
    create: {
      shop,
      productType,
      group: "Finish",
      value: option.value,
      label: option.label,
      sortOrder: option.sortOrder,
      active: true,
    },
  });
}

async function renameRule(productType, material, oldFinish, newFinish) {
  const rows = await db.configuratorPricingRule.findMany({
    where: {
      shop,
      productType,
      material,
      finish: oldFinish,
      sides: "Jar Label Set",
    },
  });

  for (const row of rows) {
    const existing = await db.configuratorPricingRule.findFirst({
      where: {
        shop,
        productType,
        material,
        finish: newFinish,
        sides: row.sides,
        minQty: row.minQty,
        maxQty: row.maxQty,
      },
    });

    if (existing) {
      await db.configuratorPricingRule.update({
        where: { id: existing.id },
        data: {
          productionFinish: newFinish,
          priceEach: row.priceEach,
          costEach: row.costEach,
          active: true,
          notes: `${row.notes || ""} Normalized finish from ${oldFinish} to ${newFinish}.`.trim(),
        },
      });

      await db.configuratorPricingRule.delete({
        where: { id: row.id },
      });
    } else {
      await db.configuratorPricingRule.update({
        where: { id: row.id },
        data: {
          finish: newFinish,
          productionFinish: newFinish,
          notes: `${row.notes || ""} Normalized finish from ${oldFinish} to ${newFinish}.`.trim(),
        },
      });
    }
  }

  return rows.length;
}

async function main() {
  console.log("Normalizing jar finish options and pricing rules...");
  console.log(`Shop: ${shop}`);

  const summary = [];

  for (const productType of jarProductTypes) {
    await db.configuratorOption.updateMany({
      where: {
        shop,
        productType,
        group: "Finish",
        value: { in: ["CMYK", "Vinyl + White"] },
      },
      data: {
        active: false,
      },
    });

    const finishOptions = isMiron(productType) ? finishOptionsByType.miron : finishOptionsByType.standard;

    for (const option of finishOptions) {
      await upsertOption(productType, option);
    }

    const matteRows = await renameRule(productType, "Matte", "CMYK", "No Spot Gloss");
    const holoRows = await renameRule(productType, "Holographic", "Vinyl + White", "No Spot Gloss");

    summary.push({
      productType,
      finishOptions: finishOptions.length,
      matteRowsRenamed: matteRows,
      holoRowsRenamed: holoRows,
      status: "normalized",
    });
  }

  console.table(summary);
  console.log("DONE: Jar finish options normalized.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
