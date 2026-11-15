// GSO ERP SIMPLE MODE (2026-11-14) — role-aware navigation.
//
// DISPLAY ONLY. This decides which links a person SEES; it never grants
// access. Every route keeps its own server-side permission check
// (owner-authorization.server.ts / staff-roles.server.ts), so hiding a link
// here is a convenience and showing one is never an authorization.
//
// The embedded Shopify nav is a flat list, so the sidebar carries at most six
// top-level areas; each area's pages are listed on Home ("Your areas").
// Pure, client-safe.

export type SimpleNavRole = "owner" | "manager" | "sales" | "print_operator" | "bagger" | "unassigned";
export type SimpleNavLink = { label: string; href: string };
export type SimpleNavSection = { key: string; label: string; href: string; purpose: string; links: SimpleNavLink[] };

export const SIMPLE_BOARD_HREF = "/app/erp/production-board";
export const NEW_JOB_HREF = "/app/erp/production-new";
export const CLASSIC_PRODUCTION_HREF = "/app/erp/production";
export const jobWorkspaceHref = (jobId: string) => `/app/erp/production-job/${jobId}`;
export const classicJobHref = (jobId: string) => `${CLASSIC_PRODUCTION_HREF}?job=${encodeURIComponent(jobId)}`;

const HOME: SimpleNavSection = { key: "home", label: "Home", href: "/app", purpose: "What needs your attention today.", links: [] };

/** Sidebar areas for a role. `viewFinancials` only widens what an already-authorized manager is shown. */
export function navForRole(role: SimpleNavRole | string, options: { viewFinancials?: boolean } = {}): SimpleNavSection[] {
  const isOwner = role === "owner";
  const isManager = role === "manager";
  const sections: SimpleNavSection[] = [HOME];

  if (isOwner || isManager || role === "sales") {
    sections.push({
      key: "sales",
      label: "Sales",
      href: "/app/quotes",
      purpose: "Customers, quotes and orders.",
      links: [
        { label: "Quotes & Customers", href: "/app/quotes" },
        { label: "Leads to Review", href: "/app/erp/agent-review-queue" },
        { label: "Wholesale Applications", href: "/app/wholesale/customers" },
        // cost & pricing tools are owner only (the route also refuses everyone else)
        ...(isOwner ? [{ label: "Price a Job (Cost Calculator)", href: "/app/erp/cost-calculator" }] : []),
      ],
    });
  }

  if (isOwner || isManager || role === "print_operator" || role === "bagger") {
    sections.push({
      key: "production",
      label: "Production",
      href: SIMPLE_BOARD_HREF,
      purpose: "Jobs on the floor and what to do next.",
      links: [
        { label: "Production Board", href: SIMPLE_BOARD_HREF },
        // manual / walk-in jobs: owner, manager, print operator (the server enforces the same list)
        ...(role !== "bagger" ? [{ label: "New Job", href: NEW_JOB_HREF }] : []),
        { label: "Production Calendar", href: "/app/erp/production-calendar" },
        ...(role !== "bagger" ? [{ label: "Incoming Print Files", href: "/app/erp/print-intake" }] : []),
        ...(isOwner || isManager ? [
          { label: "Print Logs", href: "/app/erp/print-logs" },
          { label: "RIP Imports & Review", href: "/app/erp/rip-imports" },
        ] : []),
        // the full page is for the owner and financially authorized managers; the server redirects everyone else
        ...(isOwner || (isManager && options.viewFinancials) ? [{ label: "Advanced Production View", href: CLASSIC_PRODUCTION_HREF }] : []),
      ],
    });
    sections.push(isOwner
      ? {
          key: "inventory",
          label: "Inventory",
          href: "/app/erp/materials",
          purpose: "What is in stock and what is running low.",
          links: [
            { label: "Stock & Materials", href: "/app/erp/materials" },
            { label: "Low Stock", href: "/app/erp/reorder-report" },
          ],
        }
      : {
          key: "inventory",
          label: "Inventory",
          href: "/app/erp/reorder-report",
          purpose: "Stock levels and what is running low.",
          links: [{ label: "Stock Levels", href: "/app/erp/reorder-report" }],
        });
    sections.push(isOwner || isManager
      ? {
          key: "purchasing",
          label: "Purchasing",
          href: "/app/erp/purchase-requests",
          purpose: "Request, approve and track material orders.",
          links: [
            { label: "Purchase Requests", href: "/app/erp/purchase-requests" },
            { label: "What to Reorder", href: "/app/erp/reorder-report" },
            ...(isOwner ? [
              { label: "Vendors", href: "/app/erp/vendors" },
              { label: "Vendor Cost Book", href: "/app/erp/vendor-cost-book" },
              { label: "Email a Purchase Order", href: "/app/erp/purchase-export" },
            ] : []),
          ],
        }
      : {
          key: "purchasing",
          label: "Request Material",
          href: "/app/erp/purchase-requests",
          purpose: "Ask for material you are running out of.",
          links: [{ label: "Request Material", href: "/app/erp/purchase-requests" }],
        });
  }

  if (isOwner) {
    sections.push({
      key: "admin",
      label: "Admin",
      href: "/app#advanced",
      purpose: "Products, pricing, machines, reports and settings.",
      links: [
        { label: "Reports", href: "/app/erp/reports-dashboard" },
        { label: "Product Setup", href: "/app/erp/product-setup" },
        { label: "Machines", href: "/app/erp/machines" },
        { label: "Pricing Settings", href: "/app/erp/pricing-settings" },
        { label: "Pricing Intelligence", href: "/app/erp/pricing-intelligence" },
        { label: "Margin Review", href: "/app/erp/margin-review" },
        { label: "Cost Verification", href: "/app/erp/cost-verification" },
        { label: "Operations Hub", href: "/app/erp/ops-hub" },
        { label: "Staff Access & Readiness", href: "/app/erp/owner-readiness" },
        { label: "Launch Readiness", href: "/app/erp/setup-wizard" },
        { label: "ERP Walkthrough", href: "/app/erp/walkthrough" },
      ],
    });
  } else if (isManager) {
    sections.push({
      key: "admin",
      label: "Admin",
      href: "/app#area-admin",
      purpose: "Operations oversight.",
      links: [
        { label: "Operations Hub", href: "/app/erp/ops-hub" },
        { label: "Launch Readiness", href: "/app/erp/setup-wizard" },
        { label: "ERP Walkthrough", href: "/app/erp/walkthrough" },
        // reports carry revenue / margin: only for a manager the owner has financially authorized
        ...(options.viewFinancials ? [{ label: "Reports", href: "/app/erp/reports-dashboard" }] : []),
      ],
    });
  }

  return sections;
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  sales: "Sales",
  print_operator: "Print Operator",
  bagger: "Bagger / Finishing",
  unassigned: "No role assigned",
};
