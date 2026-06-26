# GSO ERP Section Build Audit SOP

Before starting any new section of the GSO ERP / Shopify app build, run a full audit first.

Goal:
Avoid duplicate systems, conflicting tables, duplicate routes, duplicate pricing logic, and wasted build time.

## Required audit before each new section

1. Define the section clearly.
2. Search Prisma schema.
3. Search app routes.
4. Search app code.
5. Search tools/scripts.
6. Inspect database records.
7. Decide whether to extend, clean up, or build new.
8. Document the decision before patching.
9. Build small patches.
10. Verify after patch.
11. Commit only clean files.

## Standard audit commands

Run these from the project folder:

```powershell
cd C:\Users\golde\shopify-apps\wholesale-lite-mvp

Select-String -Path prisma\schema.prisma -Pattern "SECTION_KEYWORD|family|Family|productType|ProductType|recipe|Recipe|category|Category|material|Material|pricing|Pricing|configurator|Configurator" -Context 2,8

Get-ChildItem app\routes -File |
  Where-Object { $_.Name -match "SECTION_KEYWORD|family|product|recipe|pricing|configurator|material|cost|setup|production" } |
  Select-Object Name

Get-ChildItem app -Recurse -File -Include *.ts,*.tsx |
  Select-String -Pattern "SECTION_KEYWORD|productType|Product Type|family|Family|recipeFamily|Recipe Family|category|Category" |
  Select-Object Path,LineNumber,Line

Get-ChildItem tools -Recurse -File -Include *.js,*.mjs,*.ts |
  Select-String -Pattern "SECTION_KEYWORD|productType|family|recipe|category|configurator|pricing|sync|seed" |
  Select-Object Path,LineNumber,Line
