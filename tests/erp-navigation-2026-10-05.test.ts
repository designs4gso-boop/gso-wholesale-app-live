// ERP navigation regroup (2026-10-05).
//
// Repo test convention: no Prisma, no Shopify, no route imports. The sidebar
// and Dashboard are pinned by reading the route source with node:fs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { navForRole } from "../app/lib/simple-nav";

const ROOT = resolve(__dirname, "..");
const navSource = readFileSync(resolve(ROOT, "app/routes/app.tsx"), "utf8");
const dashboardSource = readFileSync(resolve(ROOT, "app/routes/app._index.tsx"), "utf8");

const EXPECTED_NAV_HREFS = [
  "/app",
  "/app/quotes",
  "/app/wholesale/customers",
  "/app/erp/cost-calculator",
  "/app/erp/production",
  "/app/erp/print-intake",
  "/app/erp/rip-imports",
  "/app/erp/print-logs",
  "/app/erp/purchase-requests",
  "/app/erp/reorder-report",
  "/app/erp/agent-review-queue",
  "/app/erp/ops-hub",
  "/app/erp/reports-dashboard",
  "/app/erp/pricing-settings",
  "/app/erp/pricing-intelligence",
  "/app/erp/margin-review",
  "/app/erp/cost-verification",
  "/app/erp/product-setup",
  "/app/erp/materials",
  "/app/erp/machines",
  "/app/erp/vendors",
  "/app/erp/vendor-cost-book",
  "/app#advanced",
  "/app/erp/owner-readiness", // 2026-11-12: owner-only Staff Access & Readiness
  "/app/erp/setup-wizard",
  "/app/erp/walkthrough",
];

// Removed from the sidebar; must remain reachable from the Dashboard.
const REMOVED_FROM_NAV = [
  "/app/erp/products/new",
  "/app/erp/cost-health",
  "/app/erp/shopify-cost-audit",
  "/app/erp/actual-costs",
  "/app/erp/calibration",
  "/app/erp/pricing-health",
  "/app/erp/configurator-audit",
  "/app/erp/admin-settings",
  "/app/erp/agent-security",
  "/app/erp/pricing-rules",
  "/app/erp/configurator",
  "/app/erp/configurator-sync",
  "/app/erp/configurator-mapping",
  "/app/erp/configurator-jar-mapping",
  "/app/erp/shopify-links",
  "/app/erp/rip-import-review",
  "/app/erp/print-log-settings",
  "/app/erp/production-calendar",
  "/app/erp/purchase-export",
  "/app/erp/agent-review-queue/new",
];

// SIMPLE MODE (2026-11-14, owner-approved): the sidebar is no longer 26
// hard-coded links. app.tsx renders navForRole(role) — at most six areas — and
// every page that used to be a sidebar link is listed inside its area on Home.
// These tests pin the same intent as before: a short ordered sidebar, nothing
// "removed" at the top level, and every former sidebar page still reachable.
const ownerNav = navForRole("owner");
const ownerReachable = new Set(ownerNav.flatMap((section) => [section.href, ...section.links.map((link) => link.href)]));

describe("ERP sidebar nav (app/routes/app.tsx)", () => {
  it("renders the role-aware nav (no hard-coded link list)", () => {
    const start = navSource.indexOf("<s-app-nav>");
    const end = navSource.indexOf("</s-app-nav>");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = navSource.slice(start, end);
    expect(block).toContain("navForRole(role, { viewFinancials }).map((section) => (");
    expect(block).toContain("<s-link key={section.key} href={section.href}>{section.label}</s-link>");
    expect(block).not.toMatch(/<s-link href="/);
  });

  it("the owner sees exactly the six areas in order", () => {
    expect(ownerNav.map((section) => section.label)).toEqual(["Home", "Sales", "Production", "Inventory", "Purchasing", "Admin"]);
    expect(ownerNav.map((section) => section.href)).toEqual(["/app", "/app/quotes", "/app/erp/production-board", "/app/erp/materials", "/app/erp/purchase-requests", "/app#advanced"]);
  });

  it("every page that was a sidebar link is still reachable for the owner", () => {
    for (const href of EXPECTED_NAV_HREFS) {
      expect(ownerReachable.has(href), `${href} should be listed in an owner area`).toBe(true);
    }
  });

  it("does not put any removed href at the top level", () => {
    const top = new Set(ownerNav.map((section) => section.href));
    for (const removed of REMOVED_FROM_NAV) {
      expect(top.has(removed), `${removed} should not be in the sidebar`).toBe(false);
    }
  });

  it("uses plain labels (no group prefixes, no Owner · labels)", () => {
    for (const section of ownerNav) {
      for (const label of [section.label, ...section.links.map((link) => link.label)]) {
        expect(label.includes(" · "), `label "${label}"`).toBe(false);
      }
    }
    expect(ownerNav.find((section) => section.key === "admin")?.links.find((link) => link.href === "/app/erp/setup-wizard")?.label).toBe("Launch Readiness");
  });
});

describe("Dashboard (app/routes/app._index.tsx)", () => {
  it("links every href removed from the sidebar", () => {
    for (const removed of REMOVED_FROM_NAV) {
      expect(dashboardSource.includes(`"${removed}"`), `${removed} should be linked from the Dashboard`).toBe(true);
    }
  });

  it("has the collapsed advanced section anchor", () => {
    expect(dashboardSource).toMatch(/id="advanced"/);
    expect(dashboardSource).toContain("Advanced & owner tools");
    // Server-rendered closed by default: open is bound to state initialised to false.
    expect(dashboardSource).toContain("useState(false)");
  });

  it("stays read-only (Prisma count() only, no writes)", () => {
    expect(dashboardSource).not.toMatch(/db\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/);
    expect(dashboardSource).not.toContain("export async function action");
  });
});
