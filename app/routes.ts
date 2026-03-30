import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),

  route("auth/login", "routes/auth.login/route.tsx"),
  route("auth/*", "routes/auth.$.tsx"),

  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
  ]),

  route("apps/wholesale-lite", "routes/apps.wholesale-lite._index.ts"),
  route("apps/wholesale-lite/pricing", "routes/apps.wholesale-lite.pricing.ts"),
  route("apps/wholesale-lite/validate", "routes/apps.wholesale-lite.validate.ts"),

  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.ts"),
] satisfies RouteConfig;