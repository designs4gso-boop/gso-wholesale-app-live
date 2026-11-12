// 2026-11-11 OWNER DECISION — staff roles / permissions and internal-financial gates.
//
// Identity = verified Shopify staff user ID (session token sub). Roles come from
// GSO_STAFF_ROLES; managers see financials / approve purchasing / exception
// pricing only when listed in GSO_MANAGER_AUTHORIZED_USER_IDS. Unassigned staff
// get nothing. Owners keep every permission; owner enforcement is unchanged.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OWNER_ENFORCEMENT_ENV, OWNER_ENFORCEMENT_TEMPORARY, OWNER_USER_IDS_ENV, financialAccess, productionFinancialVisibility, requireFinancialAccess, resolveOwnerAuthorization } from "../app/lib/owner-authorization.server";
import { MANAGER_AUTHORIZED_ENV, ROLE_PERMISSIONS, STAFF_ROLES_ENV, resolveStaffAccess } from "../app/lib/staff-roles.server";

const as = (sub: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub } });
const OWNER = "77055393857";
const ENV = {
  [OWNER_USER_IDS_ENV]: OWNER,
  [STAFF_ROLES_ENV]: "1001:manager,1002:sales,1003:print_operator,1004:bagger,1005:manager,bad:owner,1006:superuser",
  [MANAGER_AUTHORIZED_ENV]: "1005",
};

describe("role resolution from the verified Shopify staff identity", () => {
  it("owner keeps every permission; owner enforcement is unchanged", () => {
    const a = resolveStaffAccess(as(OWNER), ENV);
    expect(a.role).toBe("owner");
    for (const p of ROLE_PERMISSIONS.owner) expect(a.can(p)).toBe(true);
    expect(resolveOwnerAuthorization(as("1001"), ENV).isOwner).toBe(false); // a manager is not an owner
  });

  it("assigned roles get exactly the owner-approved matrix", () => {
    const sales = resolveStaffAccess(as("1002"), ENV);
    expect(sales.role).toBe("sales");
    expect(sales.can("sendQuote")).toBe(true);
    for (const p of ["viewFinancials", "approveExceptionPricing", "approvePurchasing", "selectPrinter", "recordQc", "ownerOverrides"] as const) expect(sales.can(p), p).toBe(false);
    const operator = resolveStaffAccess(as("1003"), ENV);
    expect(["selectPrinter", "recordQc", "recordReprint", "recordShipment"].every((p) => operator.can(p as any))).toBe(true);
    expect(operator.can("viewFinancials")).toBe(false);
    const bagger = resolveStaffAccess(as("1004"), ENV);
    expect(bagger.can("recordQc")).toBe(true);
    expect(bagger.can("selectPrinter")).toBe(false);
    expect(bagger.can("viewFinancials")).toBe(false);
    for (const role of ["sales", "print_operator", "bagger", "manager"] as const) expect(ROLE_PERMISSIONS[role]).toContain("createPurchaseRequest"); // staff may create PRs
  });

  it("a manager is operational only unless the owner explicitly authorizes financials / purchasing / exceptions", () => {
    const plain = resolveStaffAccess(as("1001"), ENV);
    expect(plain.role).toBe("manager");
    expect(plain.can("viewFinancials")).toBe(false);
    expect(plain.can("approvePurchasing")).toBe(false);
    const authorized = resolveStaffAccess(as("1005"), ENV);
    expect(authorized.can("viewFinancials")).toBe(true);
    expect(authorized.can("approvePurchasing")).toBe(true);
    expect(authorized.can("approveExceptionPricing")).toBe(true);
    expect(authorized.can("ownerOverrides")).toBe(false);
  });

  it("unassigned / malformed / unknown roles fail closed", () => {
    for (const sub of ["9999", "1006"]) {
      const a = resolveStaffAccess(as(sub), ENV);
      expect(a.role).toBe("unassigned");
      expect(a.permissions.size).toBe(0);
    }
    expect(resolveStaffAccess({ session: { shop: "s", isOnline: false } }, ENV).role).toBe("unassigned"); // no identity
    // the temporary all-staff switch still makes everyone owner (unchanged, explicit)
    expect(resolveStaffAccess(as("9999"), { ...ENV, [OWNER_ENFORCEMENT_ENV]: OWNER_ENFORCEMENT_TEMPORARY }).role).toBe("owner");
  });
});

describe("internal-financial access (fails closed)", () => {
  it("owner and authorized manager only; nobody when no owner is configured", () => {
    expect(financialAccess(as(OWNER), ENV).allowed).toBe(true);
    expect(financialAccess(as("1005"), ENV).allowed).toBe(true);
    for (const sub of ["1001", "1002", "1003", "1004", "9999"]) expect(financialAccess(as(sub), ENV).allowed, sub).toBe(false);
    expect(financialAccess(as(OWNER), {}).allowed).toBe(false);
    expect(productionFinancialVisibility(as("1003"), ENV).show).toBe(false);
    expect(() => requireFinancialAccess(as("1002"), ENV)).toThrow();
    let thrown: any = null;
    try { requireFinancialAccess(as("1002"), ENV); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(403);
  });

  const GATED = [
    "app.erp.margin-review.tsx", "app.erp.cost-verification.tsx", "app.erp.reports-dashboard.tsx", "app.erp.pricing-intelligence.tsx",
    "app.erp.vendor-cost-book.tsx", "app.erp.pricing-rules.tsx", "app.erp.product-setup.tsx", "app.erp.materials.tsx",
    "app.erp.shopify-cost-audit.tsx", "app.erp.cost-health.tsx", "app.erp.pricing-health.tsx", "app.erp.pricing-settings.tsx",
    "app.erp.configurator.tsx", "app.erp.products.new.tsx", "app.erp.agent-review-queue.tsx", "app.erp.configurator-audit.tsx",
    "app.erp.configurator-mapping.tsx", "app.erp.calibration.tsx", "app.erp.rip-import-review.tsx",
  ];
  for (const file of GATED) {
    it(`${file}: the loader refuses non-financial staff on the server`, () => {
      const src = readFileSync(`app/routes/${file}`, "utf8");
      const loader = src.slice(src.search(/export (async function loader|const loader)/));
      expect(loader.slice(0, 600)).toMatch(/requireFinancialAccess\((financialAuth|auth)\);/);
    });
  }

  it("Shopify-mutating setup routes are owner only", () => {
    expect(readFileSync("app/routes/app.create-wholesale-discount.tsx", "utf8")).toContain('requireOwner(auth, process.env, "Creating the Wholesale Pricing discount is owner only.");');
    expect(readFileSync("app/routes/app.create-configurator-cart-transform.tsx", "utf8")).toContain("if (!owner.isOwner) return json(");
  });
});
