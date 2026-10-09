// 4X5 BLANK BAG FINAL AUTHORITY — OWNER DECISION 2026-10-08: $0.11 EACH.
//
// Narrow, auditable production update authorised by the owner on 2026-10-08.
// Touches EXACTLY two current records, once each, and appends one
// MaterialCostHistory row (the same trail the Materials page writes):
//   1. Material     "4x5 Blank Bag"          cmowdnhb40003h128csyx8il2   0.09 -> 0.11
//   2. VendorProduct preset:blank-4x5-bag     cmrpjvdc50000av2atvnbt09e   0.09 -> 0.11
// Never touches quotes, quote snapshots, production jobs, actual costs,
// invoices or any history table. Default is a DRY RUN; pass --write to apply.
//
// Safety sequence (fail-closed): read both rows by id -> confirm name / SKU ->
// confirm the current value is exactly $0.09 -> confirm no duplicate target ->
// snapshot the before-state OUTSIDE the repo -> one transaction -> read back.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const SHOP = "942075-2.myshopify.com";
const MATERIAL_ID = "cmowdnhb40003h128csyx8il2";
const VENDOR_PRODUCT_ID = "cmrpjvdc50000av2atvnbt09e";
const VENDOR_SKU = "preset:blank-4x5-bag";
const EXPECTED_BEFORE = 0.09;
const NEW_COST = 0.11;
const MARKER = "[VERIFIED 2026-10-08 owner decision: 4x5 blank bag true base cost $0.11 each, any colour; supersedes $0.09]";
const REASON = "Owner decision 2026-10-08: 4x5 blank bag true base cost $0.11 each regardless of colour; supersedes the $0.09-before-inbound-freight rule (2026-08-24). No generic freight uplift.";
const CHANGED_BY = "owner-decision-2026-10-08 via tools/apply-4x5-blank-authority-2026-10-08.mjs";
const WRITE = process.argv.includes("--write");
const near = (a, b) => Math.abs(Number(a) - b) < 1e-9;

const db = new PrismaClient();
try {
  const material = await db.material.findUnique({ where: { id: MATERIAL_ID } });
  const vendorProduct = await db.vendorProduct.findUnique({ where: { id: VENDOR_PRODUCT_ID }, include: { tiers: true } });
  if (!material) throw new Error("Material row not found — aborting.");
  if (!vendorProduct) throw new Error("VendorProduct row not found — aborting.");

  // ---- confirm exact rows ----
  if (material.shop !== SHOP || material.name !== "4x5 Blank Bag" || !material.active) throw new Error(`Material identity mismatch: ${JSON.stringify({ shop: material.shop, name: material.name, active: material.active })}`);
  if (vendorProduct.shop !== SHOP || vendorProduct.vendorSku !== VENDOR_SKU || !vendorProduct.active) throw new Error(`VendorProduct identity mismatch: ${JSON.stringify({ shop: vendorProduct.shop, sku: vendorProduct.vendorSku, active: vendorProduct.active })}`);
  if (vendorProduct.tiers.length !== 0) throw new Error(`VendorProduct has ${vendorProduct.tiers.length} tier rows — flat update not safe, aborting.`);

  // ---- confirm expected current value ($0.09) ----
  for (const [label, value] of [["material.costPerUnit", material.costPerUnit], ["material.purchaseCost", material.purchaseCost], ["material.calculatedUnitCost", material.calculatedUnitCost], ["vendorProduct.defaultUnitCost", vendorProduct.defaultUnitCost]]) {
    if (!near(value, EXPECTED_BEFORE)) throw new Error(`${label} is ${value}, expected ${EXPECTED_BEFORE} — aborting (already changed or wrong row).`);
  }

  // ---- confirm no duplicate target ----
  const materialDupes = await db.material.count({ where: { shop: SHOP, active: true, name: { equals: "4x5 Blank Bag", mode: "insensitive" } } });
  const vendorDupes = await db.vendorProduct.count({ where: { shop: SHOP, vendorSku: VENDOR_SKU } });
  if (materialDupes !== 1) throw new Error(`Expected exactly 1 active Material named 4x5 Blank Bag, found ${materialDupes} — aborting.`);
  if (vendorDupes !== 1) throw new Error(`Expected exactly 1 VendorProduct with sku ${VENDOR_SKU}, found ${vendorDupes} — aborting.`);

  const before = { material, vendorProduct };
  console.log("BEFORE material:", JSON.stringify({ id: material.id, name: material.name, costPerUnit: material.costPerUnit, purchaseCost: material.purchaseCost, calculatedUnitCost: material.calculatedUnitCost, updatedAt: material.updatedAt }));
  console.log("BEFORE vendorProduct:", JSON.stringify({ id: vendorProduct.id, name: vendorProduct.name, vendorSku: vendorProduct.vendorSku, defaultUnitCost: vendorProduct.defaultUnitCost, tiers: vendorProduct.tiers.length, updatedAt: vendorProduct.updatedAt }));
  console.log("checks passed: identity, expected $0.09, no duplicates");

  if (!WRITE) {
    console.log("DRY RUN — no write performed. Re-run with --write to apply the owner-authorised update.");
  } else {
    const dir = join(homedir(), ".gso-secrets", "backups", "4x5-blank-authority-2026-10-08");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(before, null, 2));
    console.log("before-state snapshot written outside the repo:", dir);

    const appendMarker = (notes) => (String(notes || "").includes(MARKER) ? String(notes || "") : `${String(notes || "").trim()}\n${MARKER}`.trim());
    await db.$transaction(async (tx) => {
      await tx.material.update({ where: { id: MATERIAL_ID }, data: { costPerUnit: NEW_COST, purchaseCost: NEW_COST, calculatedUnitCost: NEW_COST, costReviewNeeded: false, notes: appendMarker(material.notes) } });
      await tx.materialCostHistory.create({ data: { shop: SHOP, materialId: MATERIAL_ID, oldCost: EXPECTED_BEFORE, newCost: NEW_COST, vendor: material.vendor || null, reason: REASON, changedBy: CHANGED_BY } });
      await tx.vendorProduct.update({ where: { id: VENDOR_PRODUCT_ID }, data: { defaultUnitCost: NEW_COST, notes: appendMarker(vendorProduct.notes) } });
    });
    console.log("WRITE DONE — 2 updates + 1 cost-history row");
  }

  // ---- read back ----
  const materialAfter = await db.material.findUnique({ where: { id: MATERIAL_ID } });
  const vendorAfter = await db.vendorProduct.findUnique({ where: { id: VENDOR_PRODUCT_ID } });
  const historyCount = await db.materialCostHistory.count({ where: { materialId: MATERIAL_ID } });
  console.log("AFTER material:", JSON.stringify({ costPerUnit: materialAfter.costPerUnit, purchaseCost: materialAfter.purchaseCost, calculatedUnitCost: materialAfter.calculatedUnitCost, updatedAt: materialAfter.updatedAt, markerPresent: String(materialAfter.notes || "").includes(MARKER) }));
  console.log("AFTER vendorProduct:", JSON.stringify({ defaultUnitCost: vendorAfter.defaultUnitCost, updatedAt: vendorAfter.updatedAt, markerPresent: String(vendorAfter.notes || "").includes(MARKER) }));
  console.log("material cost-history rows:", historyCount);
  if (WRITE && (!near(materialAfter.costPerUnit, NEW_COST) || !near(vendorAfter.defaultUnitCost, NEW_COST))) throw new Error("READ-BACK MISMATCH — investigate before anything else.");
  if (WRITE) console.log("VERIFIED: both current records now $0.11");
} finally {
  await db.$disconnect();
}
