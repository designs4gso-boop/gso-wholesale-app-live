// Phase 15C — seed the Spektra DTP (Custom Printed Pouches) vendor data.
// Owner-verified 2026-07-24. Additive + re-runnable: upserts by stable
// vendorSku (the seed-jar-erp-foundation / seed-chiron-jars pattern); tiers
// and add-ons on THESE records are replaced on re-run; nothing else touched.
//
// Vendor rules (Spektra, USD, US-based): no customs/duty/tariff/brokerage;
// no setup/plate/cylinder/proof/sample/artwork/per-design fees; overrun/
// underrun inside the quoted unit cost; $85 flat freight per PURCHASE ORDER
// (never per design/size/line — handled by the calculator, NOT baked into
// unit costs here). 4x5x2 and 5x4x2 are DISTINCT structures (zipper location).

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const INCLUDED_FEATURES = [
  "Silver PET",
  "Five colors including one white",
  "Soft-touch lamination",
  "Child-resistant zipper",
  "Tear notches",
  "2-inch gusset",
];

const DTP_PRODUCTS = [
  {
    name: "Spektra DTP 4x5x2",
    vendorSku: "spektra-dtp-4x5x2",
    tiers: [
      { minQty: 1000, maxQty: 2499, unitCost: 0.9897 },
      { minQty: 2500, maxQty: 4999, unitCost: 0.4922 },
      { minQty: 5000, maxQty: 7499, unitCost: 0.4033 },
      { minQty: 7500, maxQty: null, unitCost: 0.3232 },
    ],
  },
  {
    name: "Spektra DTP 5x4x2",
    vendorSku: "spektra-dtp-5x4x2",
    tiers: [
      { minQty: 1000, maxQty: 2499, unitCost: 1.0504 },
      { minQty: 2500, maxQty: 4999, unitCost: 0.5419 },
      { minQty: 5000, maxQty: 7499, unitCost: 0.4697 },
      { minQty: 7500, maxQty: null, unitCost: 0.3818 },
    ],
  },
  {
    name: "Spektra DTP 6x5x2",
    vendorSku: "spektra-dtp-6x5x2",
    tiers: [
      { minQty: 1000, maxQty: 2499, unitCost: 1.1048 },
      { minQty: 2500, maxQty: 4999, unitCost: 0.5864 },
      { minQty: 5000, maxQty: 7499, unitCost: 0.529 },
      { minQty: 7500, maxQty: null, unitCost: 0.4341 },
    ],
  },
  {
    name: "Spektra DTP 8x5x2",
    vendorSku: "spektra-dtp-8x5x2",
    tiers: [
      { minQty: 1000, maxQty: 2499, unitCost: 1.2418 },
      { minQty: 2500, maxQty: 4999, unitCost: 0.6991 },
      { minQty: 5000, maxQty: 7499, unitCost: 0.6799 },
      { minQty: 7500, maxQty: null, unitCost: 0.5674 },
    ],
  },
];

// 1) Vendor master record
let vendor = await db.vendor.findFirst({ where: { shop, name: "Spektra" } });
const vendorData = {
  name: "Spektra",
  vendorType: "dtp_pouches",
  status: "active",
  country: "US",
  defaultCurrency: "USD",
  shippingNotes: "FREIGHT: $85 flat per Spektra PURCHASE ORDER (never per design, size, or line item). No customs, duty, tariffs, or brokerage (US-based).",
  notes: "Custom Printed Pouches / DTP Bags vendor (owner-verified 15C). No setup/plate/cylinder/proof/sample/artwork/per-design fees; overrun/underrun included in quoted unit cost. 4x5x2 and 5x4x2 are DISTINCT structures (zipper location).",
  active: true,
};
if (vendor) {
  vendor = await db.vendor.update({ where: { id: vendor.id }, data: vendorData });
  console.log(`updated Vendor Spektra (${vendor.id})`);
} else {
  vendor = await db.vendor.create({ data: { shop, ...vendorData } });
  console.log(`created Vendor Spektra (${vendor.id})`);
}

// 2) Four VendorProducts + exact tiers + feature add-ons
for (const product of DTP_PRODUCTS) {
  const existing = await db.vendorProduct.findFirst({ where: { shop, vendorSku: product.vendorSku } });
  const data = {
    name: product.name,
    productType: "dtp_bag",
    vendor: "SPEKTRA",
    vendorId: vendor.id,
    vendorSku: product.vendorSku,
    moq: 1000,
    defaultUnitCost: product.tiers[0].unitCost,
    leadTimeDays: null,
    notes: "Owner-verified Spektra tier costs (USD, 15C). Vendor-FINISHED pouch — no in-house print math. Freight $85 flat per PO handled by the calculator, never baked in here.",
    active: true,
  };
  let record;
  if (existing) {
    record = await db.vendorProduct.update({ where: { id: existing.id }, data });
    await db.vendorProductTier.deleteMany({ where: { shop, vendorProductId: existing.id } });
    await db.vendorProductAddOn.deleteMany({ where: { shop, vendorProductId: existing.id } });
    console.log(`updated ${product.name} (${record.id}) — tiers/add-ons replaced`);
  } else {
    record = await db.vendorProduct.create({ data: { shop, ...data } });
    console.log(`created ${product.name} (${record.id})`);
  }
  await db.vendorProductTier.createMany({
    data: product.tiers.map((tier) => ({
      shop,
      vendorProductId: record.id,
      minQty: tier.minQty,
      maxQty: tier.maxQty,
      unitCost: tier.unitCost,
      notes: "Owner-verified Spektra tier (USD, 15C).",
    })),
  });
  await db.vendorProductAddOn.createMany({
    data: [
      ...INCLUDED_FEATURES.map((name) => ({
        shop,
        vendorProductId: record.id,
        name,
        pricingType: "included",
        amount: 0,
        enabled: true,
        notes: "Included in the Spektra unit cost — never an additional customer charge (15C).",
      })),
      {
        shop,
        vendorProductId: record.id,
        name: "Hang hole",
        pricingType: "optional",
        amount: 0,
        enabled: true,
        notes: "Optional at $0 additional vendor cost (15C).",
      },
    ],
  });
  console.log(`  ${product.tiers.length} tiers + ${INCLUDED_FEATURES.length + 1} add-ons written`);
}

await db.$disconnect();
console.log("Spektra DTP seed complete (1 vendor, 4 products, 16 tiers, 28 add-ons; nothing else touched).");
