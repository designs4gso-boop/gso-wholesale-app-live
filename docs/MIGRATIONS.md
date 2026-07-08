# GSO ERP — Prisma Migration Runbook

Production database: Render Postgres (`gso_wholesale_db`). The schema was
historically drift-managed with no migration history. Patch 8A added the
baseline migration files; this document is the workflow from now on.

## CRITICAL WARNING — local .env points at PRODUCTION

As of Patch 8A the local `.env` `DATABASE_URL` is the production Render
Postgres. Until that changes:

- Treat every `prisma` command run locally as if it targets production.
- Strongly recommended: create a local Postgres (Docker) for development and
  keep the production URL out of `.env` except when deliberately operating on
  production.

## Never do (against production, ever)

- `prisma migrate reset` — wipes the database.
- `prisma db push` — that era ended with the baseline; push bypasses history.
- `prisma migrate dev` with a production `DATABASE_URL` — it can prompt to
  reset on drift. The `npm run prisma:migrate` script runs `migrate dev`;
  do not use it while `.env` points at production.
- Hand-editing `prisma/migrations/0_init/migration.sql` after the baseline
  has been resolved.

## Baseline (Patch 8A state)

- `prisma/migrations/0_init/migration.sql` — generated from
  `prisma/schema.prisma` only (no database contact) via:
  `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
- `prisma/migrations/migration_lock.toml` — `provider = "postgresql"`.
- Drift check before baselining returned "This is an empty migration."
  (production matches the schema).

## Owner-executed activation steps (one-time, after 8A review)

1. Re-run the read-only drift check (Render shell or locally):
   `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script`
   Expected output: `This is an empty migration.` If not, STOP and reconcile.
2. Mark the baseline as applied (writes ONE row to `_prisma_migrations`,
   executes no DDL):
   `npx prisma migrate resolve --applied 0_init`
3. Verify: `npx prisma migrate status` reports the baseline applied and no
   pending migrations.
4. Render configuration:
   - Build Command: `npm install && npx prisma generate && npm run build`
   - Pre-Deploy Command (preferred): `npx prisma migrate deploy`
   - Fallback if Pre-Deploy is unavailable on the plan:
     Start Command `npx prisma migrate deploy && npm run start`
5. Trigger a deploy and confirm the logs show migrate deploy running with
   "No pending migrations".

## Rollback for the baseline resolve

If the resolve was run in error:
`npx prisma migrate resolve --rolled-back 0_init`
(or delete the single `0_init` row from `_prisma_migrations`). No schema or
data changes occurred either way.

## Future migrations (Patch 8B and beyond)

Use the fully offline two-schema diff (no database contact of any kind).
Do NOT use `--from-migrations` in this environment: that variant needs a
shadow database connection to replay migrations, which we must not make
while local `.env` points at production.

1. Copy the current schema to a scratch file OUTSIDE the repo:
   `cp prisma/schema.prisma <scratch>/schema-before-<name>.prisma`
2. Edit `prisma/schema.prisma` (additive changes strongly preferred).
3. Generate the migration file-to-file:
   `npx prisma migrate diff --from-schema-datamodel <scratch>/schema-before-<name>.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<timestamp>_<name>/migration.sql`
4. Review the SQL by hand. Additive nullable columns only unless explicitly
   planned. No DROP, no destructive statements.
5. `npx prisma generate` (schema-only; regenerates the client, no DB contact).
6. Commit schema + migration together.
7. Deploy: Render's Pre-Deploy `npx prisma migrate deploy` applies it.
   Never run migrate deploy manually against production.

Applied real migrations:

- `20260707130000_add_low_margin_approval_fields` (Patch 8B): five nullable
  columns on Quote for schema-backed low-margin approval
  (`lowMarginApprovedAt/By/Reason/ThresholdPct/Snapshot`).
- `20260707150000_add_quote_customer_tier` (Patch 9A): `Quote.customerTier`
  (TEXT NOT NULL DEFAULT 'standard') and `Quote.customerTierLabel` (TEXT NULL).
  Default-backed NOT NULL add is metadata-only on Postgres; no table rewrite.

## Testing

`npm test` runs the Vitest suites in `tests/` (pure server-lib units: quote
margin state and the recipe pricing engine). They touch no database and no
Shopify APIs.
