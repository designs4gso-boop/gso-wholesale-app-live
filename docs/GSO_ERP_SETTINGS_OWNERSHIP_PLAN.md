# GSO ERP — Settings Ownership Plan (Phase 15F, 2026-07-24)

Plan only — no code/migration in 15F. Goal: every owner-tunable number gets
ONE editable home in ErpAdminSetting; researched pricing logic stays in code.

## Schema reality (verified)
`ErpAdminSetting { shop, category, key, label, value, valueType, unit,
description, createdAt, updatedAt }` with **@@unique([shop, key])** — key is
unique per shop ACROSS categories, so the namespace must live in the key
itself. There is **no updatedBy column** → actor + audit history must live in
the JSON envelope. Existing users: admin-settings (categories Shop/Pricing,
scalar values), calibration (reads defaultMachineRecoveryHr), reports-
dashboard (category pricing-feedback, valueType json — precedent for JSON
envelopes), setup-wizard. **No migration required for 15F.1–15F.5.**

## J. Namespaced settings contract (ownerConfig)
- Key naming: `ownerConfig.<domain>.<name>` (e.g. `ownerConfig.standards.labor`,
  `ownerConfig.dtp.ladders`); category `"OwnerConfig"`; valueType `"json"`.
- Envelope (the stored `value`):
  `{ schemaVersion: 1, payload: {…}, updatedAt, updatedBy, note, previous }`
  — `updatedBy` from resolveActorFromSession (15E.1); `note` = required
  owner source note ("why changed"); `previous` = last-good envelope minus
  its own `previous` (one-step rollback, no migration, no unbounded growth).
- Read path: ONE server module `app/lib/owner-config.server.ts` —
  `getOwnerConfig(db, shop, key, { schema, defaults })`: parse → validate
  (zod-style hand validator, no new dep) → on ANY failure log + return code
  defaults (registry constants remain the fallback of record). Per-request
  memoization only; no cross-request cache (multi-instance Render, same
  reasoning as 15D.1's no-memory-mutex rule).
- Write path: `saveOwnerConfig` validates payload against the same schema,
  refuses invalid, wraps envelope, upserts via `shop_key`, and the calling
  route surfaces a diff preview before save. Rollback = "Restore previous"
  action swapping `previous` → `payload` (same validation).

## D. Owner standards (15F.1 — first mover)
Source today: `app/lib/owner-standards.ts` OWNER_STANDARDS (7 rates + $8/hr
provisional machine recovery) with LEGACY_CONFLICTING_RATES quarantine.
Target: `ownerConfig.standards.labor` payload mirroring OWNER_STANDARDS
field-for-field; code constants become defaults + validation bounds (each
rate: number, > 0, sane ceiling e.g. ≤ $200/hr, per-label rates ≤ $5).
Consumers (calculator-emergency OWNER_LABOR, product-driven-costing, Product
Setup standards panel) read through getOwnerConfig; legacy quarantine values
are NEVER accepted as payload values (validator rejects 0.1111 per-label and
25 machine-rate exactly, with message pointing at the quarantine doc).

## C. DTP owner price ladders (15F.2)
Source today: `app/lib/dtp-owner-pricing.server.ts` — DTP_OWNER_PRICE_LADDERS
(4 vendorSkus × 5 quantities), DTP_HARD_FLOOR_BANDS, DTP_MIN_JOB_PROFIT /
STRATEGIC, DTP_EXTRA_DESIGN_FEES. Recommendation: **ErpAdminSetting JSON, one
key** `ownerConfig.dtp.ladders` (payload: `{ ladders: {vendorSku: {qty:
price}}, floors, profitTargets, designFees }`) — NOT per-price rows (atomic
save, one envelope audit) and NOT a new table (no migration; volume is 20
prices + 3 floors + 2 targets + 3 fees). Validation: every ladder must cover
exactly DTP_LADDER_QUANTITIES; prices strictly > 0 and non-increasing per-
unit as quantity rises; computed margin at each rung vs current VendorProduct
tier cost must clear the 30/35/38 hard-floor bands or the save is refused
(floors themselves editable only upward toward 40, never below the owner-
approved 30/35/38 without "OWNER MARGIN OVERRIDE" recorded in `note`).
priceDtpQuote keeps its exact statuses/engine version; only
ownerPriceForQuantity's lookup source changes. Snapshots already embed the
prices used, so historical quotes are unaffected by later edits.

## What STAYS code (owner-approved research, not settings)
FAMILY_MARGIN_RULES researched curves + 40% global floor; DTP margin
quantity thresholds (65/58/52/46/42); engine/snapshot version strings;
registry family keys/aliases; classifier rules; gate phrases. These change
only by owner-directed patch with tests.

## Duplicate configuration sources (I) → retirement path
| Value | Sources today | Winner | Retire |
|---|---|---|---|
| Product families | registry (15B consolidated) + products.new sales-key list + ProductTypeProfile seed keys | registry | 15F.5: wizard + profile seeds import registry |
| Application/packout/art rates | owner-standards.ts (winner) + LEGACY quarantine + WIRED_LABOR legacy block | ownerConfig.standards.labor | 15F.1 |
| Machine $/hr | $8 provisional (standards) + Machine.costPerHour rows + margin-review private $25 | ownerConfig (global default) + Machine rows (per-machine detail) | 15F.5 retires margin-review $25 |
| Ink rates | INK_RATES constant + MachineInkChannel rows | MachineInkChannel where present, INK_RATES fallback — document, defer unification | post-15F |
| DTP ladders/floors/fees | dtp-owner-pricing.server.ts only | ownerConfig.dtp.ladders | 15F.2 |
| machineRecoveryHr | defaultMachineRecoveryHr (admin-settings scalar) + standards $8 | fold scalar into ownerConfig.standards.labor with alias read during transition | 15F.1 |

## L. Required schema changes
**None for 15F.1–15F.5.** Optional post-15F hardening (only if history
pressure appears): `updatedBy String?` column on ErpAdminSetting or an
`ErpAdminSettingHistory` table — a migration; not needed while the envelope
carries actor + one-step previous.
