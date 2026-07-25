# GSO ERP — Navigation + Permission Plan (Phase 15F, 2026-07-24)

Plan only. Current nav: 33 flat `s-link` entries in `app/routes/app.tsx`
using "Setup ·"/"Audit ·"/"Owner ·" text prefixes; several live pages
unlinked (wholesale trio, purchase pages, calendar, print-log-settings).

## G. Target navigation (15F.4)

**Daily Work** — Dashboard · Quotes / CRM · Production · Cost Calculator ·
Reports · Agent Review Queue

**Products & Pricing** — Product Setup (tabbed home) · Vendor Cost Book ·
Wholesale Pricing Rules (renamed from "Pricing Rules")

**Operations** — Print Intake · RIP Imports · RIP Review · Print Logs (+
settings link) · Materials · Machines · Vendors · Purchase Requests ·
Purchase Export · Reorder Report

**Owner / Audit** (collapsed by default) — Admin Settings · Cost
Verification · Pricing & Cost Health (merged) · Shopify Cost Audit · Actual
Costs · Calibration · Configurator Audit · Agent Security · Setup Wizard ·
ERP Walkthrough · Advanced: Configurator / Sync / Manual Mapping / Jar
Mapping / Shopify Links / Wholesale Lite (re-linked) / Legacy Manual
Calculator (extracted)

Mechanics: pure re-grouping in app.tsx (group headings or `<s-section>`
separators — embedded-admin s-link constraint keeps it flat-with-headings if
the component set lacks grouping); NO route URL changes, so bookmarks/deep
links survive. Old prefixes drop from labels once groups exist.

## H. Permissions — honest assessment
**Fact (verified 15F): the app has NO role enforcement.** Every admin route
uses `authenticate.admin` only; any staff member with app access can open
every page including Admin Settings and finalization. "Owner ·" prefixes are
cosmetic. Shopify's own staff-permission system gates only whether a user can
open the app at all ("Manage installed apps" / app permission), not per-page.

Minimum roles the business needs (target model, post-15F):
- **owner** — settings, ladders/standards edits, finalize/reopen, overrides
- **production** — production, print intake/logs, RIP pages
- **sales** — quotes/CRM, calculator (no override phrases)
- Read-only reports could piggyback on sales.

**Interim owner-only gate (smallest honest step, no schema work)** — chosen
design for 15F.1: `app/lib/owner-gate.server.ts` exporting
`requireOwnerActor(session)`; allowlist of owner emails read from
`ownerConfig.access.ownerEmails` (ErpAdminSetting JSON, default = shop-admin
fallback when unset so the single-owner shop keeps working; compare against
`session.email` / `session.onlineAccessInfo` when available, else deny
non-listed). Applied ONLY to mutation actions that change money-truth:
saveOwnerConfig writes, ladder/standards saves, finalize/reopen already gated
by phrases (phrases stay — they are audit prompts, not auth). UI hides owner
forms when the gate fails but the SERVER check is the enforcement. Documented
limitation, stated plainly in Admin Settings UI: this is an email allowlist,
not Shopify-verified roles; offline tokens may lack email → fallback rule is
"deny writes, allow reads" for unlisted actors. True per-staff roles would
require Shopify online-mode sessions per user + a UserRole table (migration)
— post-15F decision, not pretended now.

## Session fields available (verified in schema)
Prisma `Session` already stores `email`, `firstName`, `lastName`, `userId`,
`accountOwner` — `accountOwner === true` identifies the store owner on
online-token sessions; resolveActorFromSession (15E.1) already reads these.
The interim gate prefers `accountOwner` when present, then the allowlist.
