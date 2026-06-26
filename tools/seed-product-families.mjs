import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const shop = process.env.SHOP || "942075-2.myshopify.com";

const families = [
  {
    name: "Applied Label Products",
    slug: "applied_label_products",
    description: "Stock bags, sticker bags, jars, labels, and any product where GSO prints/applies a label to a blank item.",
  },
  {
    name: "DTP / Mylar Pouches",
    slug: "dtp_mylar_pouches",
    description: "Normal DTP bags, multiple pouch sizes, stock die-cuts, and custom die-cut pouch production.",
  },
  {
    name: "Boxes",
    slug: "boxes",
    description: "Tuck boxes, box and bag combos, and specialty box finishes.",
  },
];

const profiles = [
  // Family 1: Applied Label Products
  {
    key: "stock_bag_4x5",
    name: "4x5 Stock Bag",
    minQuantity: 64,
    defaultQuantity: 64,
    tierBreakpoints: "64,257,641,1281,1921",
    notes: "Applied Label Products family. Shopify configurator MVP product type.",
  },
  {
    key: "sticker_bag_4x5",
    name: "4x5 Sticker Bag",
    minQuantity: 64,
    defaultQuantity: 250,
    tierBreakpoints: "64,257,641,1281,1921",
    notes: "Applied Label Products family. Printed labels applied to blank bags.",
  },
  {
    key: "label_only",
    name: "Labels",
    minQuantity: 64,
    defaultQuantity: 250,
    tierBreakpoints: "64,250,500,1000,2500,5000,10000",
    notes: "Applied Label Products family. Label-only print orders.",
  },
  {
    key: "jar_50ml",
    name: "50ml Jar with Applied Label",
    minQuantity: 128,
    defaultQuantity: 128,
    tierBreakpoints: "128,1000,2000",
    notes: "Applied Label Products family. Blank jar cost plus printed/applied label.",
  },
  {
    key: "jar_100ml_tall",
    name: "100ml Tall Jar with Applied Label",
    minQuantity: 128,
    defaultQuantity: 128,
    tierBreakpoints: "128,1000,2000",
    notes: "Applied Label Products family. Blank jar cost plus printed/applied label.",
  },
  {
    key: "jar_100ml_wide",
    name: "100ml Wide Jar with Applied Label",
    minQuantity: 128,
    defaultQuantity: 128,
    tierBreakpoints: "128,1000,2000",
    notes: "Applied Label Products family. Blank jar cost plus printed/applied label.",
  },

  // Family 2: DTP / Mylar Pouches
  {
    key: "dtp_normal_bags",
    name: "Normal DTP Bags",
    minQuantity: 1000,
    defaultQuantity: 1000,
    tierBreakpoints: "1000,2000,5000,10000",
    notes: "DTP / Mylar Pouches family. Normal DTP pouch sizes.",
  },
  {
    key: "dtp_stock_die_cut",
    name: "Stock Die-Cuts",
    minQuantity: 2500,
    defaultQuantity: 2500,
    tierBreakpoints: "2500,5000,10000",
    notes: "DTP / Mylar Pouches family. Stock die-cut pouch shapes.",
  },
  {
    key: "dtp_custom_die_cut",
    name: "Custom Die-Cut",
    minQuantity: 2500,
    defaultQuantity: 2500,
    tierBreakpoints: "2500,5000,10000",
    notes: "DTP / Mylar Pouches family. Custom shape die-cut pouch jobs.",
  },

  // Family 3: Boxes
  {
    key: "tuck_boxes",
    name: "Tuck Boxes",
    minQuantity: 1000,
    defaultQuantity: 1000,
    tierBreakpoints: "1000,2500,5000,10000",
    notes: "Boxes family. Standard tuck boxes.",
  },
  {
    key: "box_bag_combos",
    name: "Box + Bag Combos",
    minQuantity: 1000,
    defaultQuantity: 1000,
    tierBreakpoints: "1000,2500,5000,10000",
    notes: "Boxes family. Combo pricing for bags plus boxes.",
  },
  {
    key: "specialty_box_finishes",
    name: "Specialty Box Finishes",
    minQuantity: 1000,
    defaultQuantity: 1000,
    tierBreakpoints: "1000,2500,5000,10000",
    notes: "Boxes family. Soft touch, holo, spot gloss, foil, and specialty finishes.",
  },
];

async function main() {
  console.log(`Shop: ${shop}`);

  for (const family of families) {
    await db.productCategory.upsert({
      where: {
        shop_slug: {
          shop,
          slug: family.slug,
        },
      },
      create: {
        shop,
        name: family.name,
        slug: family.slug,
        active: true,
      },
      update: {
        name: family.name,
        active: true,
      },
    });

    console.log(`Family/category ready: ${family.name}`);
  }

  for (const profile of profiles) {
    await db.productTypeProfile.upsert({
      where: {
        shop_key: {
          shop,
          key: profile.key,
        },
      },
      create: {
        shop,
        key: profile.key,
        name: profile.name,
        minQuantity: profile.minQuantity,
        defaultQuantity: profile.defaultQuantity,
        tierBreakpoints: profile.tierBreakpoints,
        active: true,
      },
      update: {
        name: profile.name,
        minQuantity: profile.minQuantity,
        defaultQuantity: profile.defaultQuantity,
        tierBreakpoints: profile.tierBreakpoints,
        active: true,
      },
    });

    console.log(`Product type profile ready: ${profile.key} - ${profile.name}`);
  }

  console.log("Product family setup seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
