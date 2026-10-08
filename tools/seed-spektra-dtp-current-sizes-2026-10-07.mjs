// DEPLOYMENT-TIME SEED (owner-approved 2026-10-07) — creates the VendorProduct
// records for the two CURRENT Spektra catalog sizes the ERP had never sold:
//   3.5x4.5x2 (1 g)  -> vendorSku spektra-dtp-3.5x4.5x2
//   5x5x2    (7 g)  -> vendorSku spektra-dtp-5x5x2
// so they appear in the Cost Calculator's DTP product picker. Additive and
// re-runnable (upsert by vendorSku); the four existing DTP records and every
// other table are untouched. NO Shopify product is created.
//
// The tiers below are the LIVE Spektra cost book comparable spec (White PET /
// Soft Touch / no spot / Child Resistant / No Tear Notch / 1 SKU; exact public
// total x 0.75, research 2026-10-06). They are reference tiers only: the quote
// cost authority for every current size is the live book resolved by the
// exact configuration (app/lib/dtp-quote-cost-authority.server.ts). Freight
// ($85 per PO, UNVERIFIED) is never baked in here.
//
// Run ONLY as part of the approved deployment:  node tools/seed-spektra-dtp-current-sizes-2026-10-07.mjs

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = process.env.GSO_SHOP || "942075-2.myshopify.com";

const INCLUDED_FEATURES = ["Soft-touch lamination", "Child-resistant zipper", "Tear notches", "2-inch gusset"];

const PRODUCTS = [
  {
    name: "Spektra DTP 3.5x4.5x2",
    vendorSku: "spektra-dtp-3.5x4.5x2",
    tiers: [
      { minQty: 1000, maxQty: 2499, unitCost: 0.747968 },
      { minQty: 2500, maxQty: 4999, unitCost: 0.368163 },
      { minQty: 5000, maxQty: 9999, unitCost: 0.241115 },
      { minQty: 10000, maxQty: 24999, unitCost: 0.195982 },
      { minQty: 25000, maxQty: 25000, unitCost: 0.15911 },
    ],
  },
  {
    name: "Spektra DTP 5x5x2",
    vendorSku: "spektra-dtp-5x5x2",
    tiers: [
      { minQty: 1000, maxQty: 2499, unitCost: 0.809625 },
      { minQty: 2500, maxQty: 4999, unitCost: 0.416286 },
      { minQty: 5000, maxQty: 9999, unitCost: 0.284631 },
      { minQty: 10000, maxQty: 24999, unitCost: 0.244684 },
      { minQty: 25000, maxQty: 25000, unitCost: 0.207716 },
    ],
  },
];

const vendor = await db.vendor.findFirst({ where: { shop, name: "Spektra" } });
if (!vendor) {
  console.error("Vendor 'Spektra' not found for this shop — run tools/seed-spektra-dtp.mjs first.");
  process.exit(2);
}

for (const product of PRODUCTS) {
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
    notes: "Current Spektra catalog size (2026-10-06 live cost book, comparable spec). Reference tiers only — quotes cost from the live book by exact configuration. Freight $85 per PO (UNVERIFIED) is applied by the calculator, never baked in.",
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
    data: product.tiers.map((tier) => ({ shop, vendorProductId: record.id, minQty: tier.minQty, maxQty: tier.maxQty, unitCost: tier.unitCost, notes: "Live Spektra cost book 2026-10-06 (comparable spec, exact public total x 0.75) — reference tier." })),
  });
  await db.vendorProductAddOn.createMany({
    data: [
      ...INCLUDED_FEATURES.map((name) => ({ shop, vendorProductId: record.id, name, pricingType: "included", amount: 0, enabled: true, notes: "Included in the Spektra unit cost — never an additional customer charge." })),
      { shop, vendorProductId: record.id, name: "Hang hole", pricingType: "optional", amount: 0, enabled: true, notes: "Optional at $0 additional vendor cost." },
    ],
  });
}

await db.$disconnect();
console.log("done — 2 current-size DTP vendor products ensured");
