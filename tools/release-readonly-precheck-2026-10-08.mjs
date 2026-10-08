// RELEASE READ-ONLY PRE-CHECK (2026-10-08) — production database, SELECT only.
// Proves the exact target rows for the approved additive Spektra seed and
// captures the pre-seed state. Prints counts/identifiers only; never prints
// connection details. No writes of any kind.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = process.env.GSO_SHOP || "942075-2.myshopify.com";
const out = {};
try {
  out.vendorSpektra = await db.vendor.findFirst({ where: { shop, name: "Spektra" }, select: { id: true, name: true, status: true, active: true } });
  const skus = ["spektra-dtp-3.5x4.5x2", "spektra-dtp-4x5x2", "spektra-dtp-5x4x2", "spektra-dtp-5x5x2", "spektra-dtp-6x5x2", "spektra-dtp-8x5x2"];
  const products = await db.vendorProduct.findMany({ where: { shop, vendorSku: { in: skus } }, select: { id: true, vendorSku: true, name: true, active: true, moq: true, defaultUnitCost: true, updatedAt: true, _count: { select: { tiers: true, addOns: true } } }, orderBy: { vendorSku: "asc" } });
  out.dtpVendorProducts = products;
  out.missingSkus = skus.filter((s) => !products.some((p) => p.vendorSku === s));
  out.counts = {
    vendorProduct: await db.vendorProduct.count({ where: { shop } }),
    vendorProductTier: await db.vendorProductTier.count({ where: { shop } }),
    vendorProductAddOn: await db.vendorProductAddOn.count({ where: { shop } }),
    quote: await db.quote.count({ where: { shop } }).catch(() => null),
    quoteItem: await db.quoteItem.count({ where: { shop } }).catch(() => null),
    productionJob: await db.productionJob.count({ where: { shop } }),
    machine: await db.machine.count({ where: { shop } }),
  };
  out.machines = await db.machine.findMany({ where: { shop }, select: { name: true, active: true, costPerHour: true, machineType: true }, orderBy: { name: "asc" } });
  out.opsIntents = await db.actionIntent?.count?.().catch?.(() => null) ?? null;
} finally {
  await db.$disconnect();
}
console.log(JSON.stringify(out, (k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
