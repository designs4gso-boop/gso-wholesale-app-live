// Phase 15H.1-A — READ-ONLY ticket-uniqueness audit. Writes NOTHING.
// Gates the (shop, jobTicket) / (shop, itemTicket) unique-index migration:
// any duplicate found = STOP, report for owner review, no migration.
// Run from the repo root: node tools/audit-ticket-uniqueness.mjs
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const JOB_TICKET_CANONICAL = /^GSO-\d{8}-\d{4}$/;
const ITEM_TICKET_CANONICAL = /^GSO-\d{8}-\d{4}-\d{2}$/;

async function main() {
  const jobs = await db.productionJob.findMany({
    select: { id: true, shop: true, jobTicket: true, quoteId: true, createdAt: true },
  });
  const items = await db.productionJobItem.findMany({
    select: { id: true, shop: true, jobId: true, itemTicket: true },
  });

  const byKey = (rows, keyOf) => {
    const map = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      if (key == null) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return [...map.entries()].filter(([, group]) => group.length > 1);
  };

  const dupJobTickets = byKey(jobs.filter((j) => j.jobTicket), (j) => `${j.shop}|${j.jobTicket}`);
  const dupItemTickets = byKey(items.filter((i) => i.itemTicket), (i) => `${i.shop}|${i.itemTicket}`);
  const dupQuoteIds = byKey(jobs.filter((j) => j.quoteId), (j) => `${j.shop}|${j.quoteId}`);

  const nullJobTickets = jobs.filter((j) => !j.jobTicket).length;
  const nullItemTickets = items.filter((i) => !i.itemTicket).length;
  const nullQuoteIds = jobs.filter((j) => !j.quoteId).length;

  const malformedJobs = jobs.filter((j) => j.jobTicket && !JOB_TICKET_CANONICAL.test(j.jobTicket));
  const malformedItems = items.filter((i) => i.itemTicket && !ITEM_TICKET_CANONICAL.test(i.itemTicket));

  console.log("=== 15H.1-A TICKET UNIQUENESS AUDIT (read-only) ===");
  console.log(`ProductionJob rows:        ${jobs.length} (null jobTicket: ${nullJobTickets}, null quoteId: ${nullQuoteIds})`);
  console.log(`ProductionJobItem rows:    ${items.length} (null itemTicket: ${nullItemTickets})`);
  console.log(`duplicate (shop, jobTicket) groups:  ${dupJobTickets.length}`);
  for (const [key, group] of dupJobTickets.slice(0, 20)) {
    console.log(`  DUP job ticket ${key}: ${group.map((j) => `${j.id} (${j.createdAt.toISOString()})`).join(" | ")}`);
  }
  console.log(`duplicate (shop, itemTicket) groups: ${dupItemTickets.length}`);
  for (const [key, group] of dupItemTickets.slice(0, 20)) {
    console.log(`  DUP item ticket ${key}: ${group.map((i) => `${i.id} (job ${i.jobId})`).join(" | ")}`);
  }
  console.log(`duplicate (shop, quoteId) groups:    ${dupQuoteIds.length} (INFORMATIONAL — unique(shop,quoteId) deferred by owner)`);
  for (const [key, group] of dupQuoteIds.slice(0, 10)) {
    console.log(`  DUP quoteId ${key}: ${group.map((j) => j.id).join(" | ")}`);
  }
  console.log(`malformed jobTicket (non-canonical GSO-YYYYMMDD-NNNN):     ${malformedJobs.length}`);
  for (const j of malformedJobs.slice(0, 20)) console.log(`  MALFORMED job ${j.id} [${j.shop}]: "${j.jobTicket}"`);
  console.log(`malformed itemTicket (non-canonical GSO-YYYYMMDD-NNNN-NN): ${malformedItems.length}`);
  for (const i of malformedItems.slice(0, 20)) console.log(`  MALFORMED item ${i.id} (job ${i.jobId}) [${i.shop}]: "${i.itemTicket}"`);

  const blocking = dupJobTickets.length + dupItemTickets.length;
  console.log(blocking === 0
    ? "AUDIT: PASS — zero ticket duplicates; the unique-index migration is safe to stage."
    : "AUDIT: FAIL — ticket duplicates exist; STOP (no migration) and review the rows above.");
  process.exitCode = blocking === 0 ? 0 : 2;
}

main()
  .catch((error) => {
    console.error("AUDIT ERROR:", error.message || error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
