// Phase 15F.0K.4H — one-time owner activation of the Pricing Evidence
// "live from" cutoff. Owner confirmed (2026-07-27) that EVERY Shopify order,
// paid quote, and production job existing before activation was a test
// transaction and that no real storefront sales have occurred yet.
//
// This script writes ONE ErpAdminSetting row (pricingIntelligence.liveFrom).
// It deletes and modifies NOTHING else — no quotes, no production jobs, no
// Shopify data. It REFUSES to overwrite an existing value unless
// FORCE_15F0K4H=1 is set (moving the date changes historical evidence
// counts and needs an explicit owner decision + note), and it can never
// clear the value.
//
// Usage:            node tools/apply-15f0k4h-live-from.mjs
// Explicit change:  FORCE_15F0K4H=1 CHANGE_NOTE="why" node tools/apply-15f0k4h-live-from.mjs

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "942075-2.myshopify.com";
const KEY = "pricingIntelligence.liveFrom";

const OWNER_NOTE =
  "All Shopify/ERP sales before this timestamp were test transactions. Owner confirmed no real storefront sales existed before Pricing Intelligence activation.";

try {
  const now = new Date();
  console.log(`Current server timestamp: ${now.toISOString()}`);

  const existing = await db.erpAdminSetting.findUnique({ where: { shop_key: { shop, key: KEY } } });
  let previous = null;
  if (existing?.value) {
    let parsed = null;
    try { parsed = JSON.parse(existing.value); } catch {}
    if (process.env.FORCE_15F0K4H !== "1") {
      console.log("ALREADY SET — refusing to change without FORCE_15F0K4H=1 (owner decision required).");
      console.log(`Stored value: ${existing.value}`);
      process.exit(0);
    }
    const changeNote = String(process.env.CHANGE_NOTE || "").trim();
    if (changeNote.length < 5) {
      console.error("FORCE requested but CHANGE_NOTE (>=5 chars) is required to explain the move. Aborting.");
      process.exit(1);
    }
    // one-step rollback info, mirroring the ownerConfig envelope pattern
    previous = parsed ? { ...parsed, previous: undefined, changeNote } : null;
    console.log(`FORCE change requested. Reason: ${changeNote}`);
  }

  const envelope = {
    iso: now.toISOString(),
    note: OWNER_NOTE,
    changedAt: now.toISOString(),
    source: "phase-15f0k4h-owner-activation-script",
    previous,
  };
  const value = JSON.stringify(envelope);

  await db.erpAdminSetting.upsert({
    where: { shop_key: { shop, key: KEY } },
    update: { value, category: "PricingIntelligence", valueType: "json" },
    create: {
      shop,
      category: "PricingIntelligence",
      key: KEY,
      label: "Pricing Intelligence — live sales evidence start date (owner-approved)",
      value,
      valueType: "json",
      description:
        "Evidence dated before this ISO timestamp is excluded as pre-launch test evidence. Owner-controlled; changing it requires an explicit audited action.",
    },
  });

  const readBack = await db.erpAdminSetting.findUnique({ where: { shop_key: { shop, key: KEY } } });
  const stored = JSON.parse(readBack.value);
  console.log("WRITTEN AND READ BACK:");
  console.log(`  pricingEvidenceLiveFrom = ${stored.iso}`);
  console.log(`  note      = ${stored.note}`);
  console.log(`  changedAt = ${stored.changedAt}`);
  console.log(`  source    = ${stored.source}`);
} finally {
  await db.$disconnect();
}
