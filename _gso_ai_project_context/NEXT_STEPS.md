# Next Steps

1. Run app locally and confirm /app/erp/configurator opens.
2. Do not run broad ts-nocheck patch unless absolutely needed.
3. If app does not run, fix only the blocking error.
4. After calculator is confirmed, move pricing rules from hardcoded pilot rows into Prisma/database.
5. Add Shopify product mapping for the 5 pilot products.
6. Add storefront configurator only for products tagged configurator-pilot.
7. Send Material, Finish, Bag Color, Quantity, ERP Product ID, and ERP Config ID as Shopify line item properties.
8. Update order paid webhook to read configurator line item properties.
9. Create ERP production job with cost/margin snapshot.

Patch 2 next verification:
- Run npx prisma generate
- Run npm run build
- Commit to gso-configurator-db-rules
- Push branch
- Merge to main after successful local build
- Render will run npx prisma db push and deploy schema/models

Patch 2.1 verification:
- Run npm run build
- Commit range label fix
- Merge to main
- Confirm 1921-2560+ column shows prices

Patch 2.2 verification:
- Run npm run build
- Commit final tier display fix
- Merge to main
- Confirm final pricing matrix column shows prices

Hotfix verification:
- Run npm run build
- Commit hotfix
- Merge to main
- Confirm configurator page loads
- Confirm final pricing column displays prices

Hotfix 2 verification:
- Run npm run build
- Confirm build passes
- Commit hotfix
- Merge to main
- Confirm /app/erp/configurator loads

Patch 3 verification:
- Run npm run build
- Commit mapping page
- Merge to main after build passes
- Open /app/erp/configurator-mapping
- Save product mapping for the 5 pilot products

Cleanup verification:
- Run npm run build
- Confirm configurator page still loads
- Confirm pricing matrix still displays
- Next patch should be Shopify collection/tag sync, not manual product mapping

Cleanup syntax hotfix verification:
- Run npm run build
- Commit hotfix
- Merge to main
- Confirm Render deploy succeeds
- Confirm /app/erp/configurator loads

Collection sync verification:
- Run npm run build
- Commit collection sync page
- Merge to main after build passes
- Open /app/erp/configurator-sync
- Preview Stock Bags + configurator-pilot products
- Sync pilot products into ERP

Sync search hotfix verification:
- Run npm run build
- Deploy to Render
- Open /app/erp/configurator-sync
- Preview with collection stock-bags, tag configurator-pilot, product type Stock Bag
- If zero, preview again with Product Type blank
