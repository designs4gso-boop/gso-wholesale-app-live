// ERP navigation regroup (2026-10-05).
//
// Repo test convention: no Prisma, no Shopify, no route imports. The sidebar
// and Dashboard are pinned by reading the route source with node:fs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

function navBlock(source: string): string {
  const start = source.indexOf("<s-app-nav>");
  const end = source.indexOf("</s-app-nav>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function navLinks(source: string): { href: string; label: string }[] {
  return [...navBlock(source).matchAll(/<s-link href="([^"]+)">([^<]+)<\/s-link>/g)].map((m) => ({ href: m[1], label: m[2] }));
}

describe("ERP sidebar nav (app/routes/app.tsx)", () => {
  const links = navLinks(navSource);

  it("contains exactly the 25 grouped hrefs in order", () => {
    expect(links.map((l) => l.href)).toEqual(EXPECTED_NAV_HREFS);
    expect(links).toHaveLength(25);
  });

  it("does not contain any removed href", () => {
    const hrefs = new Set(links.map((l) => l.href));
    for (const removed of REMOVED_FROM_NAV) {
      expect(hrefs.has(removed), `${removed} should not be in the sidebar`).toBe(false);
    }
  });

  it("uses the new group prefixes (no Owner · and no Audit · Cost Health labels)", () => {
    for (const link of links) {
      expect(link.label.startsWith("Owner ·"), `label "${link.label}"`).toBe(false);
      expect(link.label.includes("Audit · Cost Health"), `label "${link.label}"`).toBe(false);
    }
    expect(links.find((l) => l.href === "/app#advanced")?.label).toBe("Admin · Advanced Tools");
    expect(links.find((l) => l.href === "/app/erp/setup-wizard")?.label).toBe("Help · Setup Wizard");
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
