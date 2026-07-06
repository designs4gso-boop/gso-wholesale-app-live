# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # shopify app dev — starts app server, tunnel, opens embedded admin
npm run build        # react-router build — REQUIRED after any code patch (project rule)
npm run typecheck    # react-router typegen && tsc --noEmit
npm run start        # serve the production build (react-router-serve)
npm run setup        # prisma generate && prisma migrate deploy (run on a fresh checkout / deploy)
npm run prisma:migrate   # prisma migrate dev (create/apply a migration locally)
```

There is no test suite. Verification = `npm run build` (and optionally `typecheck`) passing.

Data-layer scripts live in `tools/` and are run directly with node, e.g.
`node tools/seed-jar-erp-foundation.mjs`, `node tools/audit-full-jar-setup.mjs`. They talk to the same
Prisma DB (`prisma/dev.sqlite` locally). Treat `seed-*`/`clear-*` scripts as destructive — never run them
against production data unless explicitly asked.

## Deploy

Web app deploys to the Render service `gso-wholesale-app-live` first, then `shopify app deploy` pushes
Shopify config + the three extensions. After both are live, open the embedded admin and click
**Save settings & sync functions**. Production shop: `942075-2.myshopify.com`.

## Architecture

React Router 7 (SSR) embedded Shopify admin app — Polaris + App Bridge on the front, Prisma on the back
(SQLite in dev via `DATABASE_URL=file:dev.sqlite`, Postgres in prod). Auth/session handling and the `admin`
GraphQL client come from `app/shopify.server.ts`; Shopify sessions are stored in Prisma. This one codebase
contains **two overlapping systems** — understand which one you're touching:

**1. Wholesale Lite** (the original product; see `README.md`). Replaces paid wholesale apps on Shopify Basic:
- A storefront **application form** tags customers `wholesale_pending` → admin approve/reject flips to
  `wholesale_approved` (see `app/lib/wholesale.server.ts` + `app/routes/app.wholesale.*`).
- **Tiered pricing** enforced by a Shopify **Discount Function** (`extensions/gso-wholesale-discount`) and a
  minimum-subtotal **Cart Validation Function** (`wholesale-validation/`, a separate extension workspace).
- Rule precedence: **variant (10) > product (20) > collection (30) > storewide fallback**.
- Shopify Function input queries are **static** — collection membership can't be queried at runtime, so saving
  settings pre-computes a `productToCollections` map baked into the function config. Adding a product to a
  collection later requires re-running **Save settings & sync functions**.

**2. GSO ERP** (the larger, active build; see `_gso_ai_project_context/ARCHITECTURE.md`). A manufacturing/ERP
layer under `app/routes/app.erp.*` (~50 routes) backed by ~60 Prisma models. Source-of-truth split is
deliberate — **do not duplicate these systems**:
- **Product Setup / Recipes** (`ProductTypeProfile`, `ProductRecipe`, `Recipe*`, `Material*`) = cost &
  production source of truth.
- **ERP tier pricing** (`PricingRule`, `RecipeTier`, `ProductCost`, `WholesaleRule`) = pricing / margin /
  quantity-tier / MOQ source of truth.
- **Configurator** (`ConfiguratorProduct`, `ConfiguratorOption`, `ConfiguratorPricingRule`) = customer option
  selector + Shopify order bridge. `ConfiguratorPricingRule` is a **pilot bridge only** — long-term pricing
  should route through the ERP tier engine, not this table.
- **Production / print / purchasing**: `ProductionJob*`, `PrintLog*`, `Vendor*`, `PurchaseRequest`,
  plus an **agent review queue** (`AgentReviewQueueItem`, `app/routes/app.erp.agent-review-queue.tsx`).

### Route naming (React Router flat routes, `app/routes.ts` + `app/routes/`)
- `app.*` → embedded admin UI (`app.wholesale.*` = wholesale, `app.erp.*` = ERP).
- `apps.wholesale-lite.*` → **App Proxy** endpoints hit by the storefront/theme (pricing, configurator,
  validate). These are public-facing storefront contracts — change carefully.
- `api.*` → internal JSON endpoints (uploads, agent intake, sync).
- `webhooks.*` → Shopify webhooks; `auth.*` → OAuth.

### Business logic
Lives in `app/lib/*.ts` (e.g. `configurator-pricing.ts`, `wholesale.server.ts`, `agent-*-rules.ts`,
`product-family-sales-rules.ts`), not inline in routes. Prefer editing/adding there over fattening route files.

## Working rules (from AGENTS.md — this is a live production app)

- Make **small patches**; don't rewrite large files unless asked. Prefer adding routes/tools over breaking
  working ones. Preserve the live stock-bag configurator and checkout flow.
- **Never** reset/reseed/delete production data or touch live Shopify product data unless explicitly asked.
- **Inspect `prisma/schema.prisma` before assuming any field exists** — do not guess schema.
- `jar_5oz_clear` is cost-only/placeholder — keep it out of storefront/customer flow.
- After a code patch run `npm run build`; before committing check `git status` / `git diff --stat`.

## Orientation docs
`_gso_ai_project_context/` (`ARCHITECTURE.md`, `CURRENT_STATE.md`, `KNOWN_ERRORS.md`, `NEXT_STEPS.md`,
`PATCH_LOG.md`) and `docs/` (ERP handoff, project state, launch checklists) hold current status and gotchas —
read them before larger changes rather than inferring intent from code alone.
