import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const mironProductTypes = [
  "jar_50ml",
  "jar_100ml_tall",
  "jar_100ml_wide",
  "jar_150ml",
  "jar_250ml",
];

const standardJarProductTypes = [
  "jar_3oz_clear",
  "jar_3oz_black_white",
  "jar_4oz_clear",
  "jar_4oz_black_white",
];

const productTypeLabels = {
  jar_50ml: "50ml Miron Jar",
  jar_100ml_tall: "100ml Tall Miron Jar",
  jar_100ml_wide: "100ml Wide Miron Jar",
  jar_150ml: "150ml Miron Jar",
  jar_250ml: "250ml Miron Jar",
  jar_3oz_clear: "3oz Clear Jar",
  jar_3oz_black_white: "3oz Black/White Jar",
  jar_4oz_clear: "4oz Clear Jar",
  jar_4oz_black_white: "4oz Black/White Jar",
};

const baseMaterialOptions = [
  { group: "Material", value: "Matte", label: "Matte", sortOrder: 1 },
  { group: "Material", value: "Holographic", label: "Holographic", sortOrder: 2 },
];

const mironFinishOptions = [
  { group: "Finish", value: "CMYK", label: "CMYK", sortOrder: 1 },
  { group: "Finish", value: "1X Spot Gloss", label: "1X Spot Gloss", sortOrder: 2 },
  { group: "Finish", value: "2X Spot Gloss", label: "2X Spot Gloss", sortOrder: 3 },
  { group: "Finish", value: "3X Spot Gloss", label: "3X Spot Gloss", sortOrder: 4 },
  { group: "Finish", value: "4X Spot Gloss", label: "4X Spot Gloss", sortOrder: 5 },
  { group: "Finish", value: "Vinyl + White", label: "Vinyl + White", sortOrder: 6 },
];

const standardJarFinishOptions = [
  { group: "Finish", value: "CMYK", label: "CMYK", sortOrder: 1 },
  { group: "Finish", value: "1X Spot Gloss", label: "1X Spot Gloss", sortOrder: 2 },
  { group: "Finish", value: "2X Spot Gloss", label: "2X Spot Gloss", sortOrder: 3 },
  { group: "Finish", value: "3X Spot Gloss", label: "3X Spot Gloss", sortOrder: 4 },
  { group: "Finish", value: "Vinyl + White", label: "Vinyl + White", sortOrder: 5 },
];

const quantityOptions = [
  { group: "Quantity", value: "128", label: "128", sortOrder: 1 },
  { group: "Quantity", value: "250", label: "250", sortOrder: 2 },
  { group: "Quantity", value: "500", label: "500", sortOrder: 3 },
  { group: "Quantity", value: "1000", label: "1000", sortOrder: 4 },
  { group: "Quantity", value: "2500", label: "2500+", sortOrder: 5 },
];

const mironLabelSetOptions = [
  { group: "Label Set", value: "Side + Lid", label: "Side Label + Lid Label", sortOrder: 1 },
  { group: "Label Set", value: "Side + Lid + Lid Side", label: "Side + Lid + Lid Side Label", sortOrder: 2 },
];

const standardLabelSetOptions = [
  { group: "Label Set", value: "Side + Lid", label: "Side Label + Lid Label", sortOrder: 1 },
];

async function upsertOption(productType, option) {
  await db.configuratorOption.upsert({
    where: {
      shop_productType_group_value: {
        shop,
        productType,
        group: option.group,
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
      group: option.group,
      value: option.value,
      label: option.label,
      sortOrder: option.sortOrder,
      active: true,
    },
  });
}

async function main() {
  console.log("Seeding jar configurator options...");
  console.log(`Shop: ${shop}`);

  const summary = [];

  for (const productType of mironProductTypes) {
    const options = [
      ...baseMaterialOptions,
      ...mironFinishOptions,
      ...quantityOptions,
      ...mironLabelSetOptions,
    ];

    for (const option of options) {
      await upsertOption(productType, option);
    }

    summary.push({
      productType,
      label: productTypeLabels[productType],
      options: options.length,
      status: "seeded",
    });
  }

  for (const productType of standardJarProductTypes) {
    const options = [
      ...baseMaterialOptions,
      ...standardJarFinishOptions,
      ...quantityOptions,
      ...standardLabelSetOptions,
    ];

    for (const option of options) {
      await upsertOption(productType, option);
    }

    summary.push({
      productType,
      label: productTypeLabels[productType],
      options: options.length,
      status: "seeded",
    });
  }

  console.table(summary);
  console.log("DONE: Jar configurator options seeded.");
  console.log("Stock bag options were not touched.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
