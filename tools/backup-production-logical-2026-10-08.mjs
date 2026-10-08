// PRODUCTION LOGICAL BACKUP (2026-10-08) — read-only JSON dump of every Prisma
// model, written OUTSIDE the repository to a private timestamped folder.
// pg_dump is not installed on this workstation, so this is the documented
// fallback: one JSON file per model (full rows, batched), plus a manifest with
// row counts, byte sizes and a sha256 per file. Nothing is printed except the
// manifest summary (no connection details). No writes to the database.
//
//   node tools/backup-production-logical-2026-10-08.mjs
//   GSO_BACKUP_DIR overrides the destination root (default: ~/.gso-secrets/backups)
import { PrismaClient, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const db = new PrismaClient();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = process.env.GSO_BACKUP_DIR || join(homedir(), ".gso-secrets", "backups");
const dir = join(root, `gso-erp-logical-${stamp}`);
mkdirSync(dir, { recursive: true });

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const manifest = { startedAt: new Date().toISOString(), directory: dir, method: "prisma findMany per model (batched, read-only)", models: [], totalRows: 0, totalBytes: 0, errors: [] };
const replacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

try {
  for (const model of Prisma.dmmf.datamodel.models) {
    const delegate = db[lower(model.name)];
    if (!delegate?.findMany) { manifest.errors.push(`${model.name}: no delegate`); continue; }
    const idField = model.fields.find((f) => f.isId)?.name;
    const rows = [];
    try {
      if (idField) {
        let cursor = null;
        for (;;) {
          const batch = await delegate.findMany({ take: 2000, ...(cursor ? { skip: 1, cursor: { [idField]: cursor } } : {}), orderBy: { [idField]: "asc" } });
          rows.push(...batch);
          if (batch.length < 2000) break;
          cursor = batch[batch.length - 1][idField];
        }
      } else {
        rows.push(...(await delegate.findMany()));
      }
    } catch (error) {
      manifest.errors.push(`${model.name}: ${error?.message || error}`);
      continue;
    }
    const file = join(dir, `${model.name}.json`);
    const json = JSON.stringify(rows, replacer);
    writeFileSync(file, json);
    const bytes = statSync(file).size;
    const sha256 = createHash("sha256").update(json).digest("hex");
    manifest.models.push({ model: model.name, rows: rows.length, bytes, sha256 });
    manifest.totalRows += rows.length;
    manifest.totalBytes += bytes;
  }
} finally {
  await db.$disconnect();
}
manifest.finishedAt = new Date().toISOString();
writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory: dir, models: manifest.models.length, totalRows: manifest.totalRows, totalBytes: manifest.totalBytes, errors: manifest.errors, zeroByteFiles: manifest.models.filter((m) => m.bytes === 0).map((m) => m.model) }, null, 2));
