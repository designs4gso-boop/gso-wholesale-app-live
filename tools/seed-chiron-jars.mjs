// Patch 14C.2A — seed the two owner-verified Chiron jar records.
// Owner-authoritative rules (2026-07-24):
//   Chiron 100 ml = $1.80 each at EVERY quantity (flat, no tiers)
//   Chiron 150 ml = $1.90 each at EVERY quantity (flat, no tiers)
//   Cap included. No other Chiron sizes exist.
// Additive upsert by stable vendorSku (same pattern as
// seed-jar-erp-foundation.mjs): existing records are updated in place, tiers
// on these two records are removed (Chiron is flat-cost by owner rule), and
// NOTHING else in the database is touched. Safe to re-run.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";

const CHIRON_JARS = [
  {
    name: "Chiron 100 ml",
    vendorSku: "chiron-100ml",
    defaultUnitCost: 1.8,
  },
  {
    name: "Chiron 150 ml",
    vendorSku: "chiron-150ml",
    defaultUnitCost: 1.9,
  },
];

async function upsertChironJar(jar) {
  const existing = await db.vendorProduct.findFirst({
    where: { shop, vendorSku: jar.vendorSku },
  });

  const data = {
    name: jar.name,
    productType: "jar",
    vendor: "CHIRON",
    vendorSku: jar.vendorSku,
    moq: 1,
    defaultUnitCost: jar.defaultUnitCost,
    leadTimeDays: null,
    notes: "Chiron flat cost — same unit cost at every quantity (owner-verified 14C.2A). Cap included; no separate top. Never add quantity tiers.",
    active: true,
  };

  let record;
  if (existing) {
    record = await db.vendorProduct.update({ where: { id: existing.id }, data });
    // Chiron is flat-cost by owner rule — remove any tiers on THIS record only
    const removed = await db.vendorProductTier.deleteMany({ where: { shop, vendorProductId: existing.id } });
    console.log(`updated ${jar.name} (${record.id}) — $${jar.defaultUnitCost.toFixed(2)} flat${removed.count ? `; removed ${removed.count} stray tier(s)` : ""}`);
  } else {
    record = await db.vendorProduct.create({ data: { shop, ...data } });
    console.log(`created ${jar.name} (${record.id}) — $${jar.defaultUnitCost.toFixed(2)} flat, no tiers`);
  }
  return record;
}

for (const jar of CHIRON_JARS) await upsertChironJar(jar);
await db.$disconnect();
console.log("Chiron seed complete (2 records; flat costs; nothing else touched).");
