# OPS-2 migration — STAGED, NOT APPLIED

**Why it lives here.** Render runs `npx prisma migrate deploy` as the Pre-Deploy command on every deploy (`docs/MIGRATIONS.md` step 4/7; `docs/GSO_ERP_PROJECT_STATE.md` 15H.4A note). Anything under `prisma/migrations/` is therefore applied automatically by the next deploy. The owner directed that OPS-2 application code ships FIRST with every new feature inert, and that the database change is applied as a separate, explicit step. Following the repo's existing convention for exactly this case (15H.4A), the migration is staged here, outside the auto-deploy path.

**What it is.** `migration.sql` — six additive tables (`OpsActionIntent`, `OpsActionAuditEvent`, `OpsExternalEventReceipt`, `OpsOutboxMessage`, `OpsSlackStaffIdentity`, `OpsAgentRun`), 16 indexes, 4 unique indexes, 1 foreign key. No existing table, column, index or row is touched. Generated offline with the two-schema `prisma migrate diff`; `prisma validate` passes.

**Why the app is safe without it.** `prisma/schema.prisma` already declares the models (the generated client knows them), but the only code that queries them is `app/lib/ops/prisma-repositories.server.ts`, and it is instantiated only when `GSO_OPS_REPOSITORY=prisma`. With that variable absent (default `memory`) no Ops table is ever queried — not at boot, not from the Operations Hub, not from the Slack endpoint.

**Activation (owner, release step D).**
1. `git mv prisma/migrations-pending/20261004120000_add_ops_agent_platform prisma/migrations/20261004120000_add_ops_agent_platform` (keep the `migration.sql`; this README may stay or be dropped).
2. Commit on a branch, merge to `main`, deploy. Render Pre-Deploy `npx prisma migrate deploy` applies it; confirm the deploy log shows the migration name.
3. Verify with a read-only check from the Render shell: `npx prisma migrate status` should list it as applied.
4. Only then set `GSO_OPS_REPOSITORY=prisma` (execution and reasoning still OFF).

**Rollback.** Application rollback alone is sufficient (pre-OPS-2 code never reads these tables). Dropping the six tables is optional and only safe when no deployed build has `GSO_OPS_REPOSITORY=prisma`.
