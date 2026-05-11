import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),

  route("auth/login", "routes/auth.login/route.tsx"),
  route("auth/*", "routes/auth.$.tsx"),

  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("wholesale", "routes/app.wholesale.tsx"),
    route("wholesale/rules", "routes/app.wholesale.rules.tsx"),
    route("wholesale/customers", "routes/app.wholesale.customers.tsx"),
    route("wholesale/calculator", "routes/app.wholesale.calculator.tsx"),
    route("quotes", "routes/app.quotes.tsx"),
    route("product-costs", "routes/app.product-costs.tsx"),
    route("create-order", "routes/app.create-order.tsx"),
    route("erp/materials", "routes/app.erp.materials.tsx"),
    route("erp/machines", "routes/app.erp.machines.tsx"),
    route("erp/production", "routes/app.erp.production.tsx"),
    route("erp/print-logs", "routes/app.erp.print-logs.tsx"),
    route("erp/print-log-settings", "routes/app.erp.print-log-settings.tsx"),
    route("erp/reorder-report", "routes/app.erp.reorder-report.tsx"),
    route("erp/purchase-requests", "routes/app.erp.purchase-requests.tsx"),
    route("erp/vendors", "routes/app.erp.vendors.tsx"),
    route("erp/production/:id/print", "routes/app.erp.production.$id.print.tsx"),
    route("erp/production/:id/proof", "routes/app.erp.production.$id.proof.tsx"),
  ]),

  route("api/print-logs/upload", "routes/api.print-logs.upload.tsx"),

  route("apps/wholesale-lite", "routes/apps.wholesale-lite._index.ts"),
  route("apps/wholesale-lite/pricing", "routes/apps.wholesale-lite.pricing.ts"),
  route("apps/wholesale-lite/validate", "routes/apps.wholesale-lite.validate.ts"),
  route("quote/:id", "routes/quote.$id.tsx"),
  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.ts"),
  route("app/create-wholesale-discount", "routes/app.create-wholesale-discount.tsx"),
  route("webhooks/orders_paid", "routes/webhooks.orders_paid.tsx"),
] satisfies RouteConfig;