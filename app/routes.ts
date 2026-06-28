import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),

  route("auth/login", "routes/auth.login/route.tsx"),
  route("auth/*", "routes/auth.$.tsx"),

  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("erp/setup-wizard", "routes/app.erp.setup-wizard.tsx"),
    route("wholesale", "routes/app.wholesale.tsx"),
    route("wholesale/rules", "routes/app.wholesale.rules.tsx"),
    route("wholesale/customers", "routes/app.wholesale.customers.tsx"),
    route("wholesale/calculator", "routes/app.wholesale.calculator.tsx"),
    route("quotes", "routes/app.quotes.tsx"),
    route("product-costs", "routes/app.product-costs.tsx"),
    route("erp/product-setup", "routes/app.erp.product-setup.tsx"),
    route("erp/shopify-links", "routes/app.erp.shopify-links.tsx"),
    route("erp/product-costs", "routes/app.erp.product-costs.tsx"),
    route("erp/cost-calculator", "routes/app.erp.cost-calculator.tsx"),
    route("erp/pricing-rules", "routes/app.erp.pricing-rules.tsx"),
    route("erp/configurator", "routes/app.erp.configurator.tsx"),
    route("erp/configurator-sync", "routes/app.erp.configurator-sync.tsx"),
    route("erp/stock-bag-migration-report", "routes/app.erp.stock-bag-migration-report.tsx"),
    route("erp/configurator-mapping", "routes/app.erp.configurator-mapping.tsx"),
    route("erp/configurator-jar-mapping", "routes/app.erp.configurator-jar-mapping.tsx"),
    route("erp/configurator-audit", "routes/app.erp.configurator-audit.tsx"),
    route("create-order", "routes/app.create-order.tsx"),
    route("erp/materials", "routes/app.erp.materials.tsx"),
    route("erp/machines", "routes/app.erp.machines.tsx"),
    route("erp/production", "routes/app.erp.production.tsx"),
    route("erp/production-calendar", "routes/app.erp.production-calendar.tsx"),
    route("erp/print-logs", "routes/app.erp.print-logs.tsx"),
    route("erp/rip-imports", "routes/app.erp.rip-imports.tsx"),
    route("erp/print-intake", "routes/app.erp.print-intake.tsx"),
    route("erp/print-log-settings", "routes/app.erp.print-log-settings.tsx"),
    route("erp/reorder-report", "routes/app.erp.reorder-report.tsx"),
    route("erp/purchase-requests", "routes/app.erp.purchase-requests.tsx"),
    route("erp/purchase-export", "routes/app.erp.purchase-export.tsx"),
    route("erp/vendors", "routes/app.erp.vendors.tsx"),
    route("erp/vendor-cost-book", "routes/app.erp.vendor-cost-book.tsx"),
    route("erp/reports-dashboard", "routes/app.erp.reports-dashboard.tsx"),
    route("erp/admin-settings", "routes/app.erp.admin-settings.tsx"),
    route("erp/production/:id/print", "routes/app.erp.production.$id.print.tsx"),
    route("erp/production/:id/proof", "routes/app.erp.production.$id.proof.tsx"),
    route("erp/margin-review", "routes/app.erp.margin-review.tsx"),
  ]),

  route("proof/:token", "routes/proof.$token.tsx"),

  route("api/print-logs/upload", "routes/api.print-logs.upload.tsx"),
  route("api/rip-imports/upload", "routes/api.rip-imports.upload.tsx"),
  route("api/quote-rip-results/sync", "routes/api.quote-rip-results.sync.tsx"),

  route("apps/wholesale-lite", "routes/apps.wholesale-lite._index.ts"),
  route("apps/wholesale-lite/pricing", "routes/apps.wholesale-lite.pricing.ts"),
  route("apps/wholesale-lite/configurator", "routes/apps.wholesale-lite.configurator.ts"),
  route("apps/wholesale-lite/configurator-checkout", "routes/apps.wholesale-lite.configurator-checkout.ts"),
  route("apps/wholesale-lite/validate", "routes/apps.wholesale-lite.validate.ts"),
  route("quote/:id", "routes/quote.$id.tsx"),
  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.ts"),
  route("app/create-wholesale-discount", "routes/app.create-wholesale-discount.tsx"),
  route("app/create-configurator-cart-transform", "routes/app.create-configurator-cart-transform.tsx"),
  route("webhooks/orders_paid", "routes/webhooks.orders_paid.tsx"),
] satisfies RouteConfig;









