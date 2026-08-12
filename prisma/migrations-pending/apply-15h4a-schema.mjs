// Phase 15H.4A activation step 2 — adds the orderGid field + index to
// prisma/schema.prisma. Deterministic, assert-guarded, idempotent-safe.
// Run from the repo root: node prisma/migrations-pending/apply-15h4a-schema.mjs
import { readFileSync, writeFileSync } from "node:fs";

const path = "prisma/schema.prisma";
const text = readFileSync(path, "utf8");
if (text.includes("orderGid")) {
  console.log("schema.prisma already contains orderGid — nothing to do.");
  process.exit(0);
}

const fieldAnchor = "  quoteNumber     String?\n";
const indexAnchor = "  @@index([quoteId])\n";
if (!text.includes(fieldAnchor) || !text.includes(indexAnchor)) {
  console.error("ANCHORS NOT FOUND — schema.prisma has drifted; apply the two edits manually:");
  console.error('  1. after ProductionJob.quoteNumber add:  orderGid        String?');
  console.error("  2. after @@index([quoteId]) add:         @@index([shop, orderGid])");
  process.exit(1);
}

const next = text
  .replace(fieldAnchor, fieldAnchor + "  // 15H.4A: first-class Shopify order linkage (paid-order jobs)\n  orderGid        String?\n")
  .replace(indexAnchor, indexAnchor + "  @@index([shop, orderGid])\n");
writeFileSync(path, next);
console.log("schema.prisma patched: orderGid field + (shop, orderGid) index added.");
console.log("Now run `npx prisma validate`, commit together with the moved migration, and push.");
