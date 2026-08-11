# Staged migrations (owner-applied only)

Migrations here are **deliberately invisible** to `prisma migrate deploy` —
Render runs that command at every deploy, and staging here is how a schema
change ships in code without auto-applying to production on push.

## Currently staged

### 20260811120000_add_ticket_uniqueness (Phase 15H.1)
Adds the two DB unique indexes that make production ticket identity
authoritative: `(shop, jobTicket)` on ProductionJob and `(shop, itemTicket)`
on ProductionJobItem. Pre-verified by `tools/audit-ticket-uniqueness.mjs`
(2026-08-11: 0 duplicates, 0 malformed across 11 jobs / 14 items — safe).
The application code (P2002 retry in the allocator) is already deployed and
is a harmless no-op until these indexes exist.

## How to apply (owner action)

1. Re-run the gate right before applying:
   `node tools/audit-ticket-uniqueness.mjs`  (must print AUDIT: PASS)
2. Move the folder into the live migrations directory:
   `git mv prisma/migrations-pending/20260811120000_add_ticket_uniqueness prisma/migrations/`
3. Commit and push — Render applies it at deploy via `npm run setup`
   (`prisma migrate deploy`).
   (Equivalent alternative: run the SQL directly against the production DB,
   then still move the folder so the migration history records it.)

Apply BEFORE creating any future migration with `prisma migrate dev`, so the
history stays linear (the SQL is IF NOT EXISTS-guarded either way).

## Rollback

The indexes are non-destructive (no data change, nullable preserved).
To roll back after applying:
`DROP INDEX "ProductionJob_shop_jobTicket_key";`
`DROP INDEX "ProductionJobItem_shop_itemTicket_key";`
and revert the two `@@unique` lines in `prisma/schema.prisma`.
