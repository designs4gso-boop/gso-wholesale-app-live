// 2026-11-19 — ONE table of who may open each admin route.
//
// Before tonight every route carried its own guard and nothing listed them
// together, so a route with no guard (Quotes) could go unnoticed. This table is
// the single reference; `route-access.server.ts` enforces it and a test fails
// when a route is registered in app/routes.ts without an entry here.
//
// ROLES, never people. A role comes only from the verified Shopify staff user
// id (staff-roles.server.ts). This table only RESTRICTS: each route keeps its
// own stricter per-action checks (owner-only overrides, per-intent role lists).
//
// Pure, client-safe, no Prisma.

export type RouteAccessLevel =
  | "owner" // the owner only
  | "financial" // owner + managers the owner authorized for financials
  | "admin_workflow" // owner, manager
  | "commercial" // owner, manager, sales
  | "production_view" // owner, manager, print operator, bagger
  | "production_leads" // owner, manager, print operator
  | "assigned" // any assigned ERP role (not "unassigned"); money is redacted per role inside the page
  | "authenticated" // any signed-in staff account: no business data in the payload
  | "redirect"; // retired route: redirects, reads nothing

export const ROUTE_LEVEL_ROLES: Record<Exclude<RouteAccessLevel, "financial" | "authenticated" | "redirect">, readonly string[]> = {
  owner: ["owner"],
  admin_workflow: ["owner", "manager"],
  commercial: ["owner", "manager", "sales"],
  production_view: ["owner", "manager", "print_operator", "bagger"],
  production_leads: ["owner", "manager", "print_operator"],
  assigned: ["owner", "manager", "sales", "print_operator", "bagger"],
};

/** Route path (as registered in app/routes.ts, without the leading "app/") -> who may open it. */
export const ROUTE_ACCESS: Record<string, RouteAccessLevel> = {
  // home: every signed-in account lands here; the payload is built per role and an unassigned account gets no business data
  "": "authenticated",
  "erp/walkthrough": "authenticated", // static SOP, no database access, no action
  // sales / commercial
  quotes: "commercial",
  "erp/reorder": "commercial",
  "erp/crm": "commercial",
  "erp/crm/:id": "commercial",
  "erp/customers": "commercial",
  "erp/customers/:id": "commercial",
  "wholesale/customers": "commercial",
  "erp/agent-product-rules": "commercial",
  "erp/agent-intake-rules": "commercial",
  "erp/agent-quote-prep-rules": "commercial",
  "erp/agent-quote-prep-draft-shape": "commercial",
  "erp/agent-review-queue-rules": "commercial",
  // admin / workflow lane
  "erp/release-queue": "admin_workflow",
  "erp/agent-approvals": "admin_workflow",
  "erp/setup-wizard": "admin_workflow",
  // owner
  "erp/privacy-requests": "owner",
  "erp/owner-readiness": "owner",
  "erp/agent-security": "owner",
  "erp/ops-hub": "owner",
  "erp/cost-calculator": "owner",
  "create-wholesale-discount": "owner",
  "create-configurator-cart-transform": "owner",
  // internal financials: cost, price, margin, vendors, setup
  "erp/agent-review-queue": "financial",
  "erp/agent-review-queue/new": "financial",
  wholesale: "financial",
  "wholesale/rules": "financial",
  "erp/product-setup": "financial",
  "erp/products/new": "financial",
  "erp/shopify-links": "financial",
  "erp/pricing-settings": "financial",
  "erp/pricing-intelligence": "financial",
  "erp/cost-health": "financial",
  "erp/cost-verification": "financial",
  "erp/actual-costs": "financial",
  "erp/calibration": "financial",
  "erp/shopify-cost-audit": "financial",
  "erp/pricing-rules": "financial",
  "erp/pricing-health": "financial",
  "erp/configurator": "financial",
  "erp/configurator-sync": "financial",
  "erp/configurator-mapping": "financial",
  "erp/configurator-jar-mapping": "financial",
  "erp/configurator-audit": "financial",
  "erp/materials": "financial",
  "erp/machines": "financial",
  "erp/rip-import-review": "financial",
  "erp/print-log-settings": "financial",
  "erp/purchase-export": "financial",
  "erp/vendors": "financial",
  "erp/vendor-cost-book": "financial",
  "erp/reports-dashboard": "financial",
  "erp/admin-settings": "financial",
  "erp/margin-review": "financial",
  // production lane
  "erp/production": "production_view",
  "erp/production-board": "production_view",
  "erp/production-job/:id": "production_view",
  "erp/production-calendar": "production_view",
  "erp/production/:id/print": "production_view",
  "erp/production/:id/proof": "production_view",
  "erp/print-logs": "production_view",
  "erp/rip-imports": "production_view",
  "erp/print-intake": "production_view",
  "erp/production-new": "production_leads",
  // every assigned role; cost columns are stripped for non-financial viewers
  "erp/reorder-report": "assigned",
  "erp/purchase-requests": "assigned",
  // retired
  "wholesale/calculator": "redirect",
  "product-costs": "redirect",
  "erp/product-costs": "redirect",
  "create-order": "redirect",
};

export type RouteViewer = { role: string; canViewFinancials: boolean };

/** May this viewer open a route of this level? Unknown levels are refused. */
export function viewerMeetsRouteLevel(level: RouteAccessLevel | undefined, viewer: RouteViewer): boolean {
  if (!level) return false;
  if (level === "authenticated" || level === "redirect") return true;
  const role = String(viewer.role || "").trim().toLowerCase();
  if (level === "financial") return role === "owner" || viewer.canViewFinancials === true;
  return (ROUTE_LEVEL_ROLES[level] || []).includes(role);
}

/** A route that is not in the table is refused for everyone (fail closed). */
export function viewerMayOpenRoute(routeKey: string, viewer: RouteViewer): boolean {
  return viewerMeetsRouteLevel(ROUTE_ACCESS[routeKey], viewer);
}

export const ROUTE_ACCESS_DENIED: Record<RouteAccessLevel, string> = {
  owner: "This page is for the owner.",
  financial: "This page is for the owner and managers authorized for financials.",
  admin_workflow: "This page is for the owner and managers.",
  commercial: "Quotes, customers and leads are for the owner, managers and sales.",
  production_view: "This page is for production staff.",
  production_leads: "This page is for the owner, managers and print operators.",
  assigned: "This page needs an assigned ERP role.",
  authenticated: "Sign in to open this page.",
  redirect: "This page has moved.",
};
