// Phase 15H.4A — owner-gated orderGid backfill for EXISTING Shopify-paid
// ProductionJobs (quoteId = "shopify_order_<gid>" -> orderGid = "<gid>").
// READ-ONLY by default; --execute performs the writes. Refuses to run before
// the staged 15H.4A migration is activated (column must exist).
//   node tools/backfill-order-gid.mjs            (dry run / plan)
//   node tools/backfill-order-gid.mjs --execute  (perform the backfill)
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const EXECUTE = process.argv.includes("--execute");
const GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;
const db = new PrismaClient();

async function main() {
  try {
    await db.$queryRawUnsafe('SELECT "orderGid" FROM "ProductionJob" LIMIT 1');
  } catch {
    console.error("REFUSED: the orderGid column does not exist yet — activate the staged 15H.4A migration first (see prisma/migrations-pending/README.md).");
    process.exit(2);
  }

  const jobs = await db.$queryRawUnsafe(
    `SELECT id, shop, "quoteId", "jobTicket", "orderGid" FROM "ProductionJob" WHERE "quoteId" LIKE 'shopify_order_%' ORDER BY "createdAt" ASC`,
  );
  let planned = 0;
  let skippedAlreadySet = 0;
  let skippedMalformed = 0;
  const updates = [];
  for (const job of jobs) {
    const gid = String(job.quoteId).slice("shopify_order_".length);
    if (!GID_RE.test(gid)) {
      skippedMalformed += 1;
      console.log(`SKIP malformed: ${job.id} [${job.jobTicket}] "${gid}"`);
      continue;
    }
    if (job.orderGid) {
      if (job.orderGid !== gid) console.log(`CONFLICT (left untouched): ${job.id} has orderGid ${job.orderGid} but quoteId implies ${gid}`);
      skippedAlreadySet += 1;
      continue;
    }
    planned += 1;
    updates.push({ id: job.id, gid, ticket: job.jobTicket });
    console.log(`${EXECUTE ? "SET" : "[dry] would set"} ${job.jobTicket}: orderGid = ${gid}`);
  }

  if (EXECUTE) {
    for (const update of updates) {
      await db.$executeRawUnsafe(`UPDATE "ProductionJob" SET "orderGid" = $1 WHERE id = $2 AND "orderGid" IS NULL`, update.gid, update.id);
    }
  }
  console.log(`\n${EXECUTE ? "BACKFILLED" : "WOULD BACKFILL"}: ${planned} | already set: ${skippedAlreadySet} | malformed skipped: ${skippedMalformed}`);
}

main()
  .catch((error) => {
    console.error("BACKFILL ERROR:", error.message || error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
