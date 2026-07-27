// 15F.0K.4B — one-time owner-approved data corrections (2026-07-26).
// Follows the 13.2.2 Approved Cost Updates pattern: targeted updates by
// exact record id, cost-history rows for material changes, before/after
// printed for the audit trail. NO deletes, NO schema changes.
//
// Corrections (owner-approved in the 15F.0K.4A conflict audit + 4B task):
//  1. Material "100ml Tall Miron Blank Jar + Lid" 2.86 -> 2.78 (align to the
//     owner-approved 2026-07-17 VendorProduct ladder; VendorProduct untouched).
//  2. Material "4x5 Blank Bag" 0 -> 0.09 (restore the verified 13.2.3 cost;
//     the row was manually zeroed 2026-05-12; VendorProduct stays authority).
//  3. Machines: costPerHour 5 -> 8 (owner-approved recovery rate) on both
//     printers; rename the Roland record to "Roland TrueVIS LG-640".
//  4. ownerConfig.pricing.minimumOrderTotals: stickers-labels 25 -> 45 via
//     the audited envelope contract (owner note included).
//  5. Rename "DTP 4x5x2 Blank Pouch" -> adds "(unprinted)" clarity suffix.
//
// Run once: node tools/apply-15f0k4b-data-corrections.mjs

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SHOP = "942075-2.myshopify.com";
const ACTOR = "Approved Cost Updates (15F.0K.4B)";

const MIRON_TALL_MATERIAL_ID = "cmqvl3pwi000ow6qg9dcrabc8";
const BAG_4X5_MATERIAL_ID = "cmowdnhb40003h128csyx8il2";
const ROLAND_MACHINE_ID = "cmozcqi3w0000fj285by7l644";
const MIMAKI_MACHINE_ID = "cmozcqiib000hfj28hcsc2wez";
const DTP_BLANK_POUCH_ID = "cmrpjvdhw0003av2as2otx1f0";
const MIN_ORDER_KEY = "ownerConfig.pricing.minimumOrderTotals";

async function main() {
  // ---- 1. Miron 100ml tall Material -> 2.78 ----
  const mironBefore = await db.material.findUnique({ where: { id: MIRON_TALL_MATERIAL_ID } });
  if (!mironBefore) throw new Error("Miron tall material not found — aborting.");
  console.log("BEFORE Miron tall material:", mironBefore.costPerUnit, mironBefore.purchaseCost, mironBefore.calculatedUnitCost);
  if (mironBefore.costPerUnit !== 2.78) {
    await db.material.update({
      where: { id: MIRON_TALL_MATERIAL_ID },
      data: {
        costPerUnit: 2.78,
        purchaseCost: 2.78,
        calculatedUnitCost: 2.78,
        notes: "Blank jar/lid cost. Aligned to the owner-approved 2026-07-17 VendorProduct tier ladder base (was stale seed 2.86). Use vendor product tiers for quantity-based cost. [15F.0K.4B]",
      },
    });
    await db.materialCostHistory.create({
      data: { shop: SHOP, materialId: MIRON_TALL_MATERIAL_ID, oldCost: mironBefore.costPerUnit, newCost: 2.78, reason: "Align to owner-approved 2026-07-17 Miron ladder (15F.0K.4A conflict; applied 15F.0K.4B)", changedBy: ACTOR },
    });
    console.log("UPDATED Miron tall material -> 2.78");
  } else console.log("Miron tall material already 2.78 — skipped");

  // ---- 2. 4x5 Blank Bag Material -> 0.09 ----
  const bagBefore = await db.material.findUnique({ where: { id: BAG_4X5_MATERIAL_ID } });
  if (!bagBefore) throw new Error("4x5 bag material not found — aborting.");
  console.log("BEFORE 4x5 bag material:", bagBefore.costPerUnit, bagBefore.purchaseCost, bagBefore.calculatedUnitCost);
  if (bagBefore.costPerUnit !== 0.09) {
    await db.material.update({
      where: { id: BAG_4X5_MATERIAL_ID },
      data: {
        costPerUnit: 0.09,
        purchaseCost: 0.09,
        calculatedUnitCost: 0.09,
        notes: "Restored to the verified 13.2.3 blank-bag cost (row was manually zeroed 2026-05-12). The VendorProduct preset:blank-4x5-bag remains the calculator authority. [15F.0K.4B]",
      },
    });
    await db.materialCostHistory.create({
      data: { shop: SHOP, materialId: BAG_4X5_MATERIAL_ID, oldCost: bagBefore.costPerUnit, newCost: 0.09, reason: "Restore verified 13.2.3 cost (15F.0K.4A conflict; applied 15F.0K.4B)", changedBy: ACTOR },
    });
    console.log("UPDATED 4x5 bag material -> 0.09");
  } else console.log("4x5 bag material already 0.09 — skipped");

  // ---- 3. Machines: $8/hr + LG-640 rename ----
  for (const [id, label] of [[ROLAND_MACHINE_ID, "Roland"], [MIMAKI_MACHINE_ID, "Mimaki"]]) {
    const before = await db.machine.findUnique({ where: { id }, select: { name: true, costPerHour: true } });
    console.log(`BEFORE ${label} machine:`, JSON.stringify(before));
  }
  await db.machine.update({ where: { id: ROLAND_MACHINE_ID }, data: { name: "Roland TrueVIS LG-640", costPerHour: 8 } });
  await db.machine.update({ where: { id: MIMAKI_MACHINE_ID }, data: { costPerHour: 8 } });
  console.log("UPDATED machines: Roland -> 'Roland TrueVIS LG-640' @ $8/hr; Mimaki @ $8/hr");

  // ---- 4. ownerConfig stickers/labels minimum order total $45 ----
  const existing = await db.erpAdminSetting.findUnique({ where: { shop_key: { shop: SHOP, key: MIN_ORDER_KEY } } });
  console.log("BEFORE ownerConfig minimumOrderTotals row:", existing ? "exists" : "none (code defaults)");
  // Payload must list EVERY family explicitly (validator contract): code
  // defaults with stickers-labels raised 25 -> 45 per the owner decision.
  const payload = { "sticker-bags": null, "standard-jars": null, "premium-jars": null, "stickers-labels": 45, "banners": 40, "custom-item": 25 };
  const envelope = {
    schemaVersion: 1,
    payload,
    updatedAt: new Date().toISOString(),
    updatedBy: ACTOR,
    note: "Owner-approved 2026-07-26: stickers/labels minimum order total $45 (competitor study label-only market minimum; 15F.0K.4A decision D2 applied in 15F.0K.4B).",
    previous: existing ? (() => { try { const parsed = JSON.parse(existing.value); delete parsed.previous; return parsed; } catch { return null; } })() : null,
  };
  await db.erpAdminSetting.upsert({
    where: { shop_key: { shop: SHOP, key: MIN_ORDER_KEY } },
    update: { value: JSON.stringify(envelope), category: "OwnerConfig", valueType: "json" },
    create: {
      shop: SHOP, category: "OwnerConfig", key: MIN_ORDER_KEY,
      label: "Pricing — minimum order totals ($ per job, by family)",
      value: JSON.stringify(envelope), valueType: "json",
      description: "Job-level minimum order-total candidates. null disables a family's minimum. Code fallback: 15F.0-FINAL provisional values.",
    },
  });
  console.log("UPSERTED ownerConfig minimumOrderTotals: stickers-labels = 45");

  // ---- 5. Blank-pouch clarity rename ----
  const pouch = await db.vendorProduct.findUnique({ where: { id: DTP_BLANK_POUCH_ID }, select: { name: true } });
  console.log("BEFORE pouch name:", pouch?.name);
  if (pouch && !pouch.name.includes("unprinted")) {
    await db.vendorProduct.update({ where: { id: DTP_BLANK_POUCH_ID }, data: { name: "DTP 4x5x2 Blank Pouch (unprinted)" } });
    console.log("UPDATED pouch name -> 'DTP 4x5x2 Blank Pouch (unprinted)'");
  } else console.log("Pouch rename skipped");

  // ---- verify ----
  const [mironAfter, bagAfter, machines, cfg, pouchAfter] = await Promise.all([
    db.material.findUnique({ where: { id: MIRON_TALL_MATERIAL_ID }, select: { costPerUnit: true, purchaseCost: true, calculatedUnitCost: true } }),
    db.material.findUnique({ where: { id: BAG_4X5_MATERIAL_ID }, select: { costPerUnit: true, purchaseCost: true, calculatedUnitCost: true } }),
    db.machine.findMany({ where: { id: { in: [ROLAND_MACHINE_ID, MIMAKI_MACHINE_ID] } }, select: { name: true, costPerHour: true } }),
    db.erpAdminSetting.findUnique({ where: { shop_key: { shop: SHOP, key: MIN_ORDER_KEY } }, select: { value: true } }),
    db.vendorProduct.findUnique({ where: { id: DTP_BLANK_POUCH_ID }, select: { name: true } }),
  ]);
  console.log("AFTER Miron tall material:", JSON.stringify(mironAfter));
  console.log("AFTER 4x5 bag material:", JSON.stringify(bagAfter));
  console.log("AFTER machines:", JSON.stringify(machines));
  console.log("AFTER ownerConfig stickers-labels minOrder:", JSON.parse(cfg.value).payload["stickers-labels"]);
  console.log("AFTER pouch name:", pouchAfter?.name);
  console.log("15F.0K.4B data corrections complete.");
}

main().catch((error) => { console.error("FAILED:", error.message); process.exit(1); }).finally(() => db.$disconnect());
