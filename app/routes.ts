import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  route("auth/login", "routes/auth.login/route.tsx"),
  route("auth/*", "routes/auth.$.tsx"),

  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
  ]),

  route("webhooks/app/uninstalled", "routes/webhooks.app.uninstalled.ts"),
] satisfies RouteConfig;