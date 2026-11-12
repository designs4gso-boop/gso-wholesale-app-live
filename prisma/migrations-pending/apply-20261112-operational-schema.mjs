// 2026-11-12 activation step 2 for 20261112090000_add_operational_records —
// adds the matching fields / models to prisma/schema.prisma. Deterministic,
// anchor-guarded, idempotent (re-running changes nothing).
// Run from the repo root:  node prisma/migrations-pending/apply-20261112-operational-schema.mjs
// The client must not declare these columns before the database has them, so
// this runs in the SAME commit that moves the migration into prisma/migrations.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MODEL_FIELDS = {
  ProductionJob: [
    "  // 2026-11-12 operational records (migration 20261112090000)",
    "  shippedAt            DateTime?",
    "  shipCarrier          String?",
    "  shipTrackingNumber   String?",
    "  shipPackageCount     Int?",
    "  pickedUpAt           DateTime?",
    "  pickedUpBy           String?",
    "  rushRequested        Boolean   @default(false)",
    "  rushApprovalStatus   String?",
    "  rushApprovedBy       String?",
    "  rushApprovedAt       DateTime?",
    "  rushNotes            String?",
    "  promisedDate         DateTime?",
    "  quotedTrueCost       Float?",
    "  actualVarianceAmount Float?",
    "  actualVariancePct    Float?",
  ],
  ProductionJobItem: [
    "  // 2026-11-12 operational records (migration 20261112090000)",
    "  goodQty           Float?",
    "  spoiledQty        Float?",
    "  spoilageReason    String?",
    "  qcResult          String?",
    "  qcBy              String?",
    "  qcAt              DateTime?",
    "  qcNote            String?",
    "  lastReprintReason String?",
    "  lastReprintBy     String?",
    "  lastReprintAt     DateTime?",
  ],
  PurchaseRequest: [
    "  // 2026-11-12 purchasing accountability (migration 20261112090000)",
    "  requestedBy String?",
    "  approvedBy  String?",
    "  approvedAt  DateTime?",
  ],
  Quote: [
    "  // 2026-11-12 (migration 20261112090000) — no rush fee: rush pricing is not approved",
    "  requestedDueDate DateTime?",
    "  rushRequested    Boolean   @default(false)",
  ],
};

export const NEW_MODELS = `
// 2026-11-12 (migration 20261112090000): reserve at scheduling, consume actual at
// completion, release on cancellation; idempotencyKey makes transitions replay-safe.
model InventoryReservation {
  id             String    @id @default(cuid())
  shop           String
  materialId     String
  jobId          String
  jobItemId      String?
  quantity       Float
  consumedQty    Float?
  unit           String
  status         String    @default("reserved")
  idempotencyKey String
  reservedBy     String?
  reservedAt     DateTime  @default(now())
  consumedAt     DateTime?
  releasedAt     DateTime?
  notes          String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @default(now()) @updatedAt

  @@unique([shop, idempotencyKey])
  @@index([shop, materialId, status])
  @@index([shop, jobId])
}

// 2026-11-12 (migration 20261112090000): configurable notification preferences; sends nothing itself.
model NotificationPreference {
  id           String   @id @default(cuid())
  shop         String
  recipientKey String
  eventType    String
  channel      String
  enabled      Boolean  @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @default(now()) @updatedAt

  @@unique([shop, recipientKey, eventType, channel])
}
`;

/** Pure transform (exported for tests). Throws when an anchor is missing. */
export function applyOperationalSchema(text) {
  if (text.includes("model InventoryReservation {")) return { text, changed: false };
  let next = text.replace(/\r\n/g, "\n");
  for (const [model, lines] of Object.entries(MODEL_FIELDS)) {
    const start = next.indexOf(`model ${model} {`);
    if (start === -1) throw new Error(`ANCHOR NOT FOUND: model ${model}`);
    const end = next.indexOf("\n}", start);
    const block = next.slice(start, end);
    // insert before the first block attribute (@@) or before the closing brace
    const attr = block.search(/\n\s*@@/);
    const insertAt = attr === -1 ? end : start + attr;
    next = next.slice(0, insertAt) + "\n" + lines.join("\n") + next.slice(insertAt);
  }
  next = next.replace(/\s*$/, "\n") + NEW_MODELS;
  return { text: next, changed: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = "prisma/schema.prisma";
  const { text, changed } = applyOperationalSchema(readFileSync(path, "utf8"));
  if (!changed) {
    console.log("schema.prisma already has the operational records — nothing to do.");
  } else {
    writeFileSync(path, text);
    console.log("schema.prisma patched with the 20261112090000 operational records.");
    console.log("Now run `npx prisma validate`, commit together with the moved migration, and push.");
  }
}
