# GSO October 2026 — CORE Release Runbook

**Status: prepared 2026-10-03. NOTHING in this runbook has been executed.**
Every command below is for OWNER USE ONLY, in the order given, after the
owner has reviewed the branch. Nothing is pushed, deployed, migrated or
seeded until the owner runs it.

---

## 1. What the CORE release is

| Item | Value |
|---|---|
| Release branch | `costing-october-core-release-2026-10-03` |
| Base | GitHub `origin/main` = `fd55e51 feat(costing): add canonical machine routing and calibration resolution` |
| Included historical local commits | `d2ec32f` zakeke identity, `252d99b` zakeke intake separation, `22d91f2` canonical quote cost authority (these are the 3 commits local `main` already carries ahead of GitHub) |
| Included October commits | `cf04eaf` 2D-4C2 → 2D-4D3 calculator release candidate; `1b13758` 2D-4E P0 canonical authority lockdown; the 2D-4E6 recipe-gate fix commit; the CORE docs commit (see `git log` on the branch for the final hashes) |
| **Excluded on purpose** | `14a125d fix(pricing): use canonical manufacturing cost in storefront pricing` — customer-facing commercial behaviour that needs owner decisions (see `docs/GSO_STOREFRONT_PRICING_DECISION_PACKET.md` on `costing-october-full-review-2026-10-03`); `a9ea8b3` finish-line docs (stale production-state claims, superseded) |

What CORE changes for staff: the Cost Calculator, Quotes editor, Agent Review
Queue and emergency panel all quote canonical-authority families
(stickers-labels, sticker-bags, stock-bags, banners, standard-jars,
premium-jars) from the canonical true manufacturing cost only. Blocked jobs
publish `unitCost = null`, never $0. DTP and Boxes are untouched.

What CORE does NOT change for customers: the public configurator, checkout,
Pricing Rules preview and Configurator admin still price bags and stickers
exactly as production does today (legacy engine). No storefront price moves.

## 2. Production state (read-only verified 2026-10-03)

* All four approved machine calibrations **exist** in production and match the
  approved values. **Do NOT run `seed-machine-profile-calibrations.mjs --apply`.**
  It is not needed and not a blocker.
* Chiron 100ml tall VendorProduct row (`chiron-100ml-tall`) is **missing**.
  Seed is post-deploy, owner-approved only (section 7).
* `.env` DATABASE_URL points at production Postgres: every `tools/` and
  Prisma command is a production command.

## 3. Deployment requirement (from `git diff fd55e51..CORE`)

| Area | Changed? | Consequence |
|---|---|---|
| Application code (`app/lib`, `app/routes`) | yes | Render deploy |
| Prisma schema / migrations | **no** | no migration; `prisma migrate deploy` on Render is a no-op |
| `prisma/migrations-pending` | untouched (pre-existing 15H.4A staging) | no action |
| Shopify extensions / functions (`extensions/`, `wholesale-validation/`) | **no** | **`shopify app deploy` NOT required** |
| `shopify.app.toml` (scopes, webhooks, proxy) | **no** | no reauthorization |
| Function config / collection map | **no** | **"Save settings & sync functions" NOT required** |
| `package.json` / lockfile | **no** | no dependency change |
| Theme extension | **no** | nothing to ship |
| Tests / docs / tools | yes | none |

Render auto-deploys a push to `main` (CURRENT_STATE: "Render auto-deploys
pushes"); the service is `gso-wholesale-app-live`, live at
`https://gso-wholesale-app-live.onrender.com`.

## 4. Pre-deploy verification checklist (owner, local)

```
git switch costing-october-core-release-2026-10-03
git status -sb                      # clean except shopify-theme/, theme-patches/, tools/attach-media-16g3.mjs
git ls-remote origin refs/heads/main   # must still be fd55e51...
git log --oneline --decorate -10
npx vitest run                      # expect all files passed, 0 failed
npm run build                       # expect PASS
npm run typecheck                   # expect exit 2 with 305 errors (historical Polaris baseline), none in costing files
git diff --check                    # expect clean
```

If `git ls-remote` shows anything other than `fd55e51`, STOP: the remote has
moved and must be reconciled by the owner before any push.

## 5. Deployment sequence (OWNER ONLY — do not run from an agent session)

```
# 1. final truth
git ls-remote origin refs/heads/main          # fd55e51 expected
git status -sb

# 2. move main forward to CORE (fast-forward only — CORE descends from main)
git switch main
git merge --ff-only costing-october-core-release-2026-10-03
git log --oneline --decorate -8               # main should now equal the CORE HEAD

# 3. re-verify on main
npx vitest run && npm run build

# 4. push (this triggers the Render deploy)
git push origin main

# 5. watch Render: service gso-wholesale-app-live — build + deploy must go green
# 6. production smoke tests (section 6)
# 7. Chiron seed procedure (section 7) — only after the smoke tests pass
# 8. shopify app deploy — NOT required for CORE (no extension/config change)
# 9. Save settings & sync functions — NOT required for CORE
```

If `--ff-only` refuses, do NOT force anything: it means `main` moved; report
and stop.

## 6. Post-deploy smoke tests (embedded admin, production shop)

LABELS (Cost Calculator, Stickers & Labels)
- single line, Matte, square/rect, qty 500: canonical cost shown, status not blocked, READY TO QUOTE
- multi-line, Line 2 "Same as Line 1": 2 physical lines, 1 art setup, 2 print setups; job cost = canonical
- multi-line, Line 2 "New artwork": 2 art setups
- mixed material (Line 2 holographic, Mimaki auto→ the job routes Roland for white? no — matte/holo CMYK-only stays Mimaki): job prices
- a kiss-cut (contour) line with NO perimeter: BLOCKED, `CUTLINE_GEOMETRY_REQUIRED`; with a perimeter entered: prices
- Save draft quote → open Quotes: unit cost equals the calculator's canonical unit cost; the field is read-only

4X5 STICKER BAGS
- qty 49: BLOCKED `STICKER_BAG_BELOW_MOQ`; qty 50: eligible
- Front only vs Front and back: different canonical cost (two sides cost more)
- blank line shows $0.11 owner base (2026-10-08; $0.09-before-freight SUPERSEDED); `FREIGHT_NOT_MODELED` disclosed, not blocking
- cutline shown 3.875 x 4.875 from the 4.000 x 5.000 artboard
- save succeeds; Quotes shows canonical unit cost

STOCK BAGS
- Bag artwork = "Stock Bag — premade GSO artwork": art setup $0; qty 40 BLOCKED (MOQ 50)
- Logo/QR personalization: 1 setup event per design, customer add-on $0, bag quantity does not multiply it
- Pricing Rules preview / Configurator admin still render (legacy basis in CORE — unchanged behaviour)

BANNERS
- plain single-sided CMYK 36x60: prices, not blocked
- hemmed / grommets / double-sided: BLOCKED with `BANNER_FINISHING_RATE_REQUIRED` / `BANNER_DOUBLE_SIDED_UNSUPPORTED`

STANDARD JARS
- 3oz side+lid prices; 4oz side+lid prices; adding a tamper band on either: BLOCKED (no approved standard)

PREMIUM JARS
- Chiron 100ml (wide) side+lid: prices at $1.80 flat set cost
- Miron 100ml side+lid at 500: blank at the 500+ tier; production 505 (1% overage); packout on 500
- art setup $8.333333 per design (tamper = second), print $1.00 per job
- Chiron 100ml tall: NOT selectable until section 7 is completed

QUOTE EDITOR
- canonical item: Unit Cost disabled with the canonical help text; changing Unit Price still works
- "Calculate from ERP" on a Labels/Jars/Bags recipe: refused with the canonical-authority message; on a DTP recipe: prices as before

AGENT REVIEW QUEUE
- convert an item against a Labels recipe: refused, `canonical_authority_required` banner, no draft created
- convert against a DTP recipe: draft created as before

EMERGENCY / LEGACY SAVE
- emergency panel, efamily "stickers-labels", no product family: save refused with the canonical message

MACHINE ROUTING
- CMYK auto → Mimaki; any white or gloss → Roland; explicit Mimaki + white or gloss → BLOCK

## 7. Post-deploy Chiron 100ml tall procedure (owner-approved only)

```
# STEP 1 — dry run (read-only)
node tools/seed-chiron-100ml-tall-2d4d2.mjs
# expect: "DRY RUN", precedent "Chiron 100 ml" found, "WOULD CREATE" with defaultUnitCost 1.8, active true, no tiers

# STEP 2 — review the CREATE preview above (name, sku chiron-100ml-tall, $1.80, active)

# STEP 3 — ONLY after explicit owner approval
node tools/seed-chiron-100ml-tall-2d4d2.mjs --apply
# expect: "CREATED Chiron 100 ml tall (...) — $1.80 flat, no tiers."

# STEP 4 — idempotency check
node tools/seed-chiron-100ml-tall-2d4d2.mjs
# expect: "ALREADY EXISTS — nothing to do."

# STEP 5 — in the Cost Calculator, Premium Jars: "Chiron 100ml tall" is selectable and prices at $1.80 flat
```

The tool is dry-run by default, create-if-missing only, scoped to
`942075-2.myshopify.com`, refuses any `--unit-cost` other than 1.80, never
updates/deletes/upserts, and writes no tiers. Its decisions are unit-tested in
`tests/october-readiness-2d4g.test.ts` on the full-review branch.

## 8. Rollback (owner-approved only; never force-push)

* **CORE rollback:** `git revert --no-commit <first CORE commit>^..<CORE HEAD>` on `main`, review, commit, push. The October commits are independent of the three historical zakeke/authority commits; reverting only `cf04eaf..<CORE HEAD>` restores the pre-October calculator while keeping `22d91f2`. Reverting `1b13758` alone is NOT safe without also reverting `cf04eaf`'s dependants in tests; revert the range.
* **Storefront-only rollback (if FULL is ever deployed):** `git revert 14a125d` (plus its follow-up technical fix commits on the full-review branch) — it is isolated to the storefront/preview pricing modules, the bag adapter media key and the bag form mirror.
* **Full rollback:** revert the whole range from `fd55e51` exclusive to the deployed HEAD.
* No schema changed, so no database rollback is involved.
* **Chiron row:** once created it is production data. Rolling back code does NOT remove it. If it must go, that is a deliberate owner action in the admin (deactivate) — this runbook does not propose deleting it.

## 9. Owner decisions NOT part of CORE

5X/7X specialty price movement, holographic storefront white-coverage,
die-cut storefront contour workflow, 4x5 inbound freight rate, banner
finisher rates, DTP/Box vendor data. See the decision packet on the
full-review branch.
