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
