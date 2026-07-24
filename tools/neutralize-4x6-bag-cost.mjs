// Patch 14C.2A1 — neutralize the stale 4x6 sticker-bag cost.
// Owner rule (2026-07-24): pricing for 4x6 / 5x8 / 6x9 will be provided
// later. The existing 4x6 record carried $0.10 from an older seed, which made
// the calculator display "Verified". This script:
//   - zeroes defaultUnitCost on the ONE record with vendorSku
//     "preset:blank-4x6-bag" (no verified cost -> the calculator renders
//     "NO PRICE — not verified" and quotes stay Draft Only)
//   - renames it "4x6 Sticker Bag" so it displays exactly like the other
//     unpriced sizes (stable vendorSku unchanged)
//   - removes any stray tiers on THIS record only (it has none today)
// Nothing is deleted and no other record is touched; historical quote
// snapshots are frozen JSON and are unaffected. Safe to re-run. When the
// owner provides the real 4x6 cost, enter it in the Vendor Cost Book and the
// record becomes Verified again automatically.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";
const sku = "preset:blank-4x6-bag";

const existing = await db.vendorProduct.findFirst({ where: { shop, vendorSku: sku }, include: { tiers: true } });
if (!existing) {
  console.log(`no record with vendorSku ${sku} — nothing to neutralize`);
} else {
  console.log(`before: "${existing.name}" defaultUnitCost=$${existing.defaultUnitCost} tiers=${existing.tiers.length} active=${existing.active}`);
  await db.vendorProduct.update({
    where: { id: existing.id },
    data: {
      name: "4x6 Sticker Bag",
      defaultUnitCost: 0,
      notes: "Cost NEUTRALIZED 14C.2A1 — the old $0.10 seed value was never owner-verified. Owner will provide 4x6 pricing later; enter it here to make the record Verified. Quotes stay Draft Only until then.",
      active: true,
    },
  });
  if (existing.tiers.length) {
    const removed = await db.vendorProductTier.deleteMany({ where: { shop, vendorProductId: existing.id } });
    console.log(`removed ${removed.count} stray tier(s)`);
  }
  const after = await db.vendorProduct.findFirst({ where: { shop, vendorSku: sku }, include: { tiers: true } });
  console.log(`after:  "${after.name}" defaultUnitCost=$${after.defaultUnitCost} tiers=${after.tiers.length} active=${after.active} (${after.id})`);
}
await db.$disconnect();
