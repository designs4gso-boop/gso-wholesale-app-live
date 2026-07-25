# GSO ERP — Product Setup Target Design (Phase 15F, 2026-07-24)

Plan only. Product Setup becomes the single owner-facing product home with
TRUE tabs; specialist tools stay linked, never duplicated.

## B. Sections → authoritative sources

| Tab | Authoritative source | Editable here | Read-only / linked |
|---|---|---|---|
| 1. Basics | ProductRecipe (name/SKU/family/status) + product-family registry | name, SKU, recipe family, active | canonical family mapping (registry), classification preview |
| 2. Vendor Cost | VendorProduct(+Tier/+AddOn) | NOTHING (display + status) | full table + deep link to Vendor Cost Book (single intake/review — never duplicated) |
| 3. Calculator Rules | registry + owner standards + classifier | none in 15F.3 (15F.1 makes standards editable in Settings) | family flags, MOQ, floors, application/packout standards with sources |
| 4. Customer Pricing | DTP ladders (15F.2 → settings) + FAMILY_MARGIN_RULES (stay code — owner-approved research) | DTP ladder prices/floors/fees after 15F.2 | researched curves (read-only with source) |
| 5. Features | VendorProductAddOn | add/edit/toggle add-ons (thin editor — the ONE new editable surface, small) | — |
| 6. Shopify | ProductRecipe GID fields | existing recipe link fields | Shopify Links tool by link |
| 7. Production Recipe | ProductRecipe + 8 children | existing recipe builder (unchanged) | — |
| 8. Actual-Cost Feedback | 15E.2 reporting lib | accept/dismiss/defer (existing queue) | per-product finalized variance rows |
| 9. History / Audit | events + snapshots + Cost Book history | nothing | presented events (15E.3 presenter) |

Save behavior: each tab posts its own intent to the existing owners (recipe
intents, add-on intent, settings intents) — one page, many small forms, no
cross-tab mega-save. Verification state: the 15B deriveProductVerification
badge (Draft/Unverified/Verified × Active/Inactive) heads every tab.

## E. True tabs (practical model)
Query-state tabs (`?tab=vendor-cost&recipeId=…&product=vendor:…`) on the ONE
existing route — no new routes, embedded-admin safe (client-side GET
navigation, RR <Form>/links only), selected product persists in the query
string, memory-safe loaders fetch per-tab data only. Add Product REMAINS the
guided wizard (unchanged URL) reached from the "New Product" button; it
already lands back in Product Setup with the draft selected.

## F. Product creation workflow + gates
Create (wizard) → Basics → Vendor Cost (Cost Book entry for vendor/DTP
products) → Calculator Rules (classification check) → Customer Pricing (DTP
ladder / curve review) → Features → Shopify → Production Recipe → Verify →
Activate. Status gates (existing derivation + new activation checks in
15F.3): Draft → Unverified → Verified → Active/Inactive. Activation BLOCKS
when: likely duplicate (15B warning hardened to a gate), missing cost
(Unverified), unclassifiable for its family (calculator rules missing),
Shopify mapping set but unresolvable, vendor-finished product without tiers.
All families supported by the same flow — DTP/vendor-finished products skip
in-house recipe steps exactly as the calculator/production already do.

## K. 15E.3 follow-up (presentation only)
15E.3 complete. Remaining cosmetics for 15F.4: dense aggregate tables on
Reports (add per-section collapse), the pre-15E.2 dashboard blocks partially
duplicate the exec summary (fold quote/job counter cards), long Production
job page (tabs later), mobile wrapping on wide tables (overflow wrappers
exist; audit spot-checks remain).
