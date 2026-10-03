// Patch 2D-4D2 — create the ONE missing Chiron picker record.
//
// WHY THIS EXISTS
// ---------------
// The owner's active jar scope (2026-08-24) includes Chiron 100ml tall. Its
// canonical cost resolves perfectly — jar-active-scope.ts scopes it,
// CHIRON_SET_COST prices it, jarFreightPerUnit freights it — but the Cost
// Calculator's product picker is built from ACTIVE VendorProduct rows, and no
// row for that jar exists. So staff cannot select a jar the owner sells.
//
// tools/seed-chiron-jars.mjs (Patch 14C.2A) created the other two Chiron rows
// and its header states "No other Chiron sizes exist." That was true on
// 2026-07-24. The 2026-08-24 scope supersedes it for THIS size only; nothing
// about the existing two rows changes.
//
// WHAT THIS DOES *NOT* DO
// -----------------------
// It does NOT make VendorProduct a cost authority. The canonical jar cost comes
// from CHIRON_SET_COST in jar-cost-inputs.server.ts and is not read from here.
// The row's defaultUnitCost exists only so the legacy calculator panel and the
// Vendor Cost Book behave like they do for the sibling Chiron rows.
//
// SAFETY
// ------
//   * DRY RUN by default. Writes only with --apply.
//   * Scoped to the production shop, which must be named explicitly.
//   * CREATE-IF-MISSING ONLY. If a row with this vendorSku exists, the script
//     reports it and exits without touching it. It never updates, never
//     deletes, never reactivates, and never touches tiers or any other row.
//   * Idempotent: safe to re-run; the second run is a no-op.
//   * Prints every field it would write, before writing anything.
//
// USAGE
//   node tools/seed-chiron-100ml-tall-2d4d2.mjs             # dry run, full preview
//   node tools/seed-chiron-100ml-tall-2d4d2.mjs --apply     # create the one row
//
// THE COST (2D-4D3)
// -----------------
// $1.80 per complete set, OWNER-VERIFIED 2026-08-25. When 2D-4D2 wrote this
// script the figure had no owner record — it had arrived in the same unsourced
// Patch 2A commit as figures that turned out to be wrong — so the script
// refused to default it. The owner has now confirmed it, so it is encoded here
// AND validated: passing --unit-cost is optional, but passing a DIFFERENT one
// is refused rather than written. A price change is an owner decision that
// belongs in the code, not a flag typed at a terminal.

import { PrismaClient } from "@prisma/client";

const SHOP = "942075-2.myshopify.com";
const VENDOR_SKU = "chiron-100ml-tall";
/** Owner-verified 2026-08-25 (2D-4D3). Matches CHIRON_SET_COST["100ml_tall"]. */
const OWNER_APPROVED_UNIT_COST = 1.8;
/** The sibling row this record is modelled on, field for field. */
const PRECEDENT_SKU = "chiron-100ml";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const unitCostArg = args.find((a) => a.startsWith("--unit-cost="));
const UNIT_COST = unitCostArg ? Number(unitCostArg.split("=")[1]) : null;

const db = new PrismaClient();

const line = (label, value) => console.log(`   ${String(label).padEnd(18)} ${value}`);

async function main() {
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — Chiron 100ml tall picker record`);
  console.log(`shop: ${SHOP}\n`);

  const precedent = await db.vendorProduct.findFirst({ where: { shop: SHOP, vendorSku: PRECEDENT_SKU } });
  if (!precedent) {
    console.error(`REFUSING: the structural precedent row "${PRECEDENT_SKU}" was not found in this shop.`);
    console.error("This script copies its shape rather than inventing one, so it cannot proceed.");
    process.exitCode = 1;
    return;
  }
  console.log(`Structural precedent: "${precedent.name}" (${precedent.id})`);
  console.log(`   productType=${precedent.productType}  vendor=${precedent.vendor}  moq=${precedent.moq}  active=${precedent.active}\n`);

  const existing = await db.vendorProduct.findFirst({ where: { shop: SHOP, vendorSku: VENDOR_SKU } });
  if (existing) {
    console.log("ALREADY EXISTS — nothing to do. This script never updates an existing row.");
    line("id", existing.id);
    line("name", existing.name);
    line("active", existing.active);
    line("defaultUnitCost", `$${Number(existing.defaultUnitCost).toFixed(2)}`);
    if (!existing.active) {
      console.log("\nNOTE: the row exists but is INACTIVE, so the picker still will not show it.");
      console.log("Reactivating is a deliberate edit — do it in the admin, not here.");
    }
    return;
  }

  // The owner-approved cost is the default. An explicit --unit-cost is allowed
  // only when it AGREES — a mismatch is a typo or an un-recorded price change,
  // and either way it must not be written.
  if (UNIT_COST != null && (!Number.isFinite(UNIT_COST) || UNIT_COST !== OWNER_APPROVED_UNIT_COST)) {
    console.error(`REFUSING: --unit-cost=${unitCostArg?.split("=")[1]} does not match the owner-approved $${OWNER_APPROVED_UNIT_COST.toFixed(2)}.`);
    console.error("If the supplier price really changed, that is an owner decision: update");
    console.error("CHIRON_SET_COST and this constant together, so the canonical cost and the");
    console.error("picker row can never drift apart.");
    process.exitCode = 1;
    return;
  }
  const unitCost = OWNER_APPROVED_UNIT_COST;

  const data = {
    shop: SHOP,
    name: "Chiron 100 ml tall",
    productType: precedent.productType,          // "jar"
    vendor: precedent.vendor,                    // "CHIRON"
    vendorId: precedent.vendorId,
    vendorSku: VENDOR_SKU,
    moq: precedent.moq,
    defaultUnitCost: unitCost,
    leadTimeDays: precedent.leadTimeDays,
    notes:
      "Chiron flat cost — same unit cost at every quantity (owner rule). Cap included; no separate top. Never add quantity tiers. " +
      "Cost $1.80 owner-verified 2026-08-25 (2D-4D3). Created so the owner-active Chiron 100ml tall is selectable in the Cost Calculator; the canonical cost comes from CHIRON_SET_COST, not from this row.",
    active: true,
  };

  console.log("WOULD CREATE VendorProduct:");
  for (const [key, value] of Object.entries(data)) line(key, value === null ? "null" : JSON.stringify(value));
  console.log("\nNo tiers are created — Chiron is flat-cost by owner rule.");
  console.log("Nothing else in the database is read, written or deleted.\n");

  if (!APPLY) {
    console.log("DRY RUN — nothing was written. Re-run with --apply to create this single row.");
    return;
  }

  const created = await db.vendorProduct.create({ data });
  console.log(`CREATED ${created.name} (${created.id}) — $${Number(created.defaultUnitCost).toFixed(2)} flat, no tiers.`);
  console.log("Re-running this script is now a no-op.");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
