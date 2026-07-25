# GSO ERP — Admin Route Audit (Phase 15F, 2026-07-24)

Audit-only. Full 75-route inventory with reads/writes lives in
GSO_ERP_PAGE_ROUTE_INVENTORY.md (15A) and remains accurate; this audit adds
the 15F decisions. Permission reality: EVERY admin route is protected only by
`authenticate.admin` (any staff member with app access sees everything —
"Owner ·" prefixes are labels, not enforcement; verified: no role checks
exist anywhere).

## Decisions (36 nav routes + notable unlinked)

| Route | Audience | Decision |
|---|---|---|
| Dashboard `/app` | all | KEEP (Daily Work) |
| Quotes / CRM | sales/owner | KEEP (Daily Work) |
| Production (+ calendar, unlinked) | production | KEEP (Daily Work); link calendar as a Production tab |
| Reports Dashboard | owner/finance | KEEP (Daily Work) — now carries actual-cost profitability (15E.2/3) |
| Agent Review Queue (+ /new, unlinked) | owner | KEEP (Daily Work, collapsible) |
| Print Intake / RIP Imports / RIP Import Review / Print Logs | production | KEEP grouped (Operations → Imports); print-log-settings (unlinked) gets a link there; MASK the upload token by default (High finding from 15A, still open) |
| Cost Calculator | sales/owner | KEEP (Products & Pricing) |
| Setup · Product Setup | owner | KEEP — becomes the tabbed product home (15F.3) |
| Setup · Add Product | owner | MERGE into Product Setup as the guided "New Product" tab entry (route/URL retained as a thin redirect) |
| Setup · Materials / Machines / Vendors | owner | KEEP (Operations) |
| Setup · Vendor Cost Book | owner | KEEP (Products & Pricing) — remains the ONLY vendor-cost intake/review |
| Audit · Cost Verification | owner | KEEP (Owner/Audit group) |
| Audit · Cost Health + Audit · Pricing Health | owner | MERGE candidates (15F.5): one "Pricing & Cost Health" page; until then both under Owner/Audit |
| Audit · Shopify Cost Audit / Actual Costs / Calibration / Configurator Audit | owner | KEEP under Owner/Audit (read-only diagnostics) |
| Owner · Admin Settings | owner | KEEP — becomes the settings backbone (15F.1 namespaces) |
| Owner · Agent Security | owner | KEEP (Owner/Audit) |
| Owner · Pricing Rules | owner | KEEP but RENAME in nav to "Wholesale Pricing Rules" (it edits the storefront PricingRule table — chronic confusion) |
| Owner · Configurator / Sync / Manual Mapping / Jar Mapping | owner | KEEP under Owner/Advanced — PROTECTED live checkout; never merge |
| Owner · Shopify Links | owner | KEEP (Owner/Advanced) |
| Owner · Margin Review | owner | RETIRE-AFTER-MERGE (15F.5): overlaps 15E.2 reporting; its private $25/hr + $0.15/side constants are quarantined legacy — fold any unique checks into Reports, then retire |
| Setup Wizard / ERP Walkthrough | owner/staff | KEEP under Owner/Advanced (diagnostic + SOP) |
| Wholesale admin trio (app/wholesale*, UNLINKED) | owner | RE-LINK under Owner/Advanced ("Wholesale Lite") — live storefront feature currently orphaned |
| purchase-requests / purchase-export / reorder-report (unlinked) | owner/ops | LINK under Operations |
| agent rule viewer pages (5, unlinked) | integrators | KEEP unlinked; document as API docs endpoints |
| Retired stubs (4) + 0KB product-costs | none | RETIRE in 15F.5 after link audit |
| Legacy Manual Calculator section (inside cost-calculator route) | owner fallback | EXTRACT to an Advanced route in 15F.4/5 (owner rule: keep as fallback) |

## Actively-used verdicts
Everything in Daily Work + Products & Pricing + Operations is in active use.
Diagnostics are used episodically (correct for audits). Only margin-review,
the stubs, and the 0KB file are true retirement candidates; pricing-health/
cost-health overlap is a merge, not a retirement.
