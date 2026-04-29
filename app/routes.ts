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
  ]),

  route("apps/wholesale-lite", "routes/apps.wholesale-lite._index.ts"),
  route("apps/wholesale-lite/pricing", "routes/apps.wholesale-lite.pricing.ts"),
  route("apps/wholesale-lite/validate", "routes/apps.wholesale-lite.validate.ts"),

  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.ts"),
  route("app/create-wholesale-discount", "routes/app.create-wholesale-discount.tsx"),
] satisfies RouteConfig;