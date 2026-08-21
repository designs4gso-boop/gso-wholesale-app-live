// Patch 2C-2 (17D.3) — one-time backfill of the new first-class RIP timestamp
// columns on EXISTING RasterLink print rows.
//
// SAFETY: dry-run by default. Nothing is written unless --apply is passed.
//
// WHY A SCRIPT AND NOT MIGRATION SQL: the values already exist inside rawRow
// JSON, so a SQL backfill would mean JSON extraction plus timestamp casting
// running unattended during `prisma migrate deploy` — no preview, no per-row
// validation, no count to check afterwards, and no way to stop half way. A
// script makes the same operation observable: preview first, explicit apply,
// exact candidate/updated/skipped/error counts, and it is safely re-runnable.
//
// WHAT IT TOUCHES: PrintLogEntry.ripStartedAt / ripCompletedAt ONLY, and only
// where they are currently null. It NEVER writes startedAt, completedAt,
// printMinutes or rawRow, and it never invents a value — the source is strictly
// the rawRow.ripStart / rawRow.ripEnd already stored by the parser.
//
// IDEMPOTENT: a second run finds no null-column candidates and updates nothing.
//
// Usage:
//   node tools/backfill-rasterlink-rip-timestamps.mjs            # dry run
//   node tools/backfill-rasterlink-rip-timestamps.mjs --apply    # write
//   node tools/backfill-rasterlink-rip-timestamps.mjs --limit 25 # cap the scan

/**
 * The ONLY rows this tool will consider. Exported so a test can pin that the
 * scan can never reach cut rows or VersaWorks rows.
 *
 * The null test is an OR, not an AND, deliberately: a row holding exactly one
 * RIP column would be invisible to an AND filter and could never have its
 * missing half filled — permanently stranded, and stuck on the weak dedupe
 * path forever. With OR it stays a candidate until BOTH columns are settled.
 */
export const BACKFILL_CANDIDATE_WHERE = {
  printerSoftware: "rasterlink",
  status: { startsWith: "print:" },
  OR: [{ ripStartedAt: null }, { ripCompletedAt: null }],
};

/** Fields this tool is permitted to write. Pinned by test. */
export const BACKFILL_WRITABLE_FIELDS = ["ripStartedAt", "ripCompletedAt"];

/** Accepts only a real, plausible instant already produced by the parser. */
export function parseStoredStamp(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 1990 || year > 2100) return null; // refuse implausible instants
  return date;
}

/**
 * PURE planner: rows in, decisions out. No database, no IO, no clock.
 *
 * Only columns that are CURRENTLY NULL are ever proposed for writing, so an
 * already-populated value can never be overwritten — including the case where
 * one column is set and the other still needs filling. A row whose columns are
 * both already populated yields no update at all, which is what makes a second
 * pass a no-op.
 */
export function planBackfill(rows) {
  const updates = [];
  const counts = { candidates: rows.length, updatable: 0, skippedNoRaw: 0, skippedNoStamps: 0, skippedInvalid: 0, skippedAlreadySet: 0 };
  for (const row of rows) {
    if (row.ripStartedAt != null && row.ripCompletedAt != null) { counts.skippedAlreadySet += 1; continue; }

    let raw;
    try {
      raw = JSON.parse(row.rawRow || "");
    } catch {
      counts.skippedNoRaw += 1;
      continue;
    }
    if (!raw || typeof raw !== "object") { counts.skippedNoRaw += 1; continue; }
    if (raw.ripStart == null && raw.ripEnd == null) { counts.skippedNoStamps += 1; continue; }

    const parsedStart = parseStoredStamp(raw.ripStart);
    const parsedEnd = parseStoredStamp(raw.ripEnd);
    if (!parsedStart && !parsedEnd) { counts.skippedInvalid += 1; continue; }

    // Fill ONLY the columns that are still null.
    const data = {};
    if (row.ripStartedAt == null && parsedStart) data.ripStartedAt = parsedStart;
    if (row.ripCompletedAt == null && parsedEnd) data.ripCompletedAt = parsedEnd;
    if (!Object.keys(data).length) { counts.skippedInvalid += 1; continue; }

    updates.push({ id: row.id, data });
    counts.updatable += 1;
  }
  return { updates, counts };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  const APPLY = process.argv.includes("--apply");
  const limitArg = process.argv.indexOf("--limit");
  const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 0 : 0;

  try {
    console.log(`RasterLink RIP timestamp backfill — ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);

    const rows = await db.printLogEntry.findMany({
      where: BACKFILL_CANDIDATE_WHERE,
      select: { id: true, sourceJobName: true, status: true, rawRow: true, ripStartedAt: true, ripCompletedAt: true },
      orderBy: { createdAt: "asc" },
      ...(LIMIT > 0 ? { take: LIMIT } : {}),
    });

    const { updates, counts } = planBackfill(rows);
    let written = 0;
    let errors = 0;

    if (APPLY) {
      for (const update of updates) {
        try {
          // Guarded on the exact columns being written, so a concurrent import
          // that already populated one of them is never overwritten.
          const guard = { id: update.id };
          for (const field of Object.keys(update.data)) guard[field] = null;
          const result = await db.printLogEntry.updateMany({ where: guard, data: update.data });
          written += result.count;
        } catch (error) {
          errors += 1;
          console.error(`  ERROR ${update.id}: ${String(error?.message || error).slice(0, 120)}`);
        }
      }
    }

    console.log("");
    console.log(`  candidates scanned (rasterlink print rows with null RIP columns): ${counts.candidates}`);
    console.log(`  ${APPLY ? "updated" : "would update"}: ${APPLY ? written : counts.updatable}`);
    console.log(`  skipped — rawRow missing/unparsable        : ${counts.skippedNoRaw}`);
    console.log(`  skipped — no ripStart/ripEnd stored        : ${counts.skippedNoStamps}`);
    console.log(`  skipped — stored value not a valid instant : ${counts.skippedInvalid}`);
    console.log(`  skipped — both columns already set        : ${counts.skippedAlreadySet}`);
    console.log(`  errors: ${errors}`);

    for (const update of updates.slice(0, 5)) {
      const row = rows.find((r) => r.id === update.id);
      console.log(`    ${update.id} "${String(row?.sourceJobName).slice(0, 34)}" ${row?.status} -> ${Object.entries(update.data).map(([k, v]) => `${k}=${v.toISOString()}`).join(" ")}`);
    }
    if (!APPLY) console.log("\n  DRY RUN — nothing was written. Re-run with --apply to commit these updates.");

    const remaining = await db.printLogEntry.count({ where: BACKFILL_CANDIDATE_WHERE });
    console.log(`\n  rasterlink print rows still lacking RIP columns after this pass: ${remaining}`);
  } finally {
    await db.$disconnect();
  }
}

// Only run when invoked directly, so the pure helpers above stay importable.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
