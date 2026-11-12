// 2026-11-11 — explicit temporary owner access, production financial
// visibility, and Margin Review owner/server-recompute safety.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OWNER_ENFORCEMENT_ENV,
  OWNER_ENFORCEMENT_TEMPORARY,
  OWNER_USER_IDS_ENV,
  ownerEnforcementMode,
  productionFinancialVisibility,
  requireOwner,
  resolveOwnerAuthorization,
} from "../app/lib/owner-authorization.server";

const as = (sub: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub } });
const src = (path: string) => readFileSync(path, "utf8");

describe("owner access enforcement", () => {
  it("default is ENFORCED and fails closed with no owner IDs — and tells the user their own ID", () => {
    const r = resolveOwnerAuthorization(as("111"), {});
    expect(r).toMatchObject({ isOwner: false, enforcement: "enforced" });
    expect(r.reason).toContain("Your Shopify staff user ID is 111.");
    expect(() => requireOwner(as("111"), {})).toThrow();
  });
  it("configured IDs decide when enforced", () => {
    const env = { [OWNER_USER_IDS_ENV]: "111, 222" };
    expect(resolveOwnerAuthorization(as("222"), env).isOwner).toBe(true);
    expect(resolveOwnerAuthorization(as("333"), env).isOwner).toBe(false);
  });
  it("only the exact switch value opens temporary access — and says so", () => {
    for (const value of ["", "off", "true", "1", "temporary"]) {
      expect(ownerEnforcementMode({ [OWNER_ENFORCEMENT_ENV]: value }), value).toBe("enforced");
    }
    const env = { [OWNER_ENFORCEMENT_ENV]: OWNER_ENFORCEMENT_TEMPORARY };
    const r = resolveOwnerAuthorization(as("333"), env);
    expect(r).toMatchObject({ isOwner: true, enforcement: OWNER_ENFORCEMENT_TEMPORARY });
    expect(r.reason).toContain("TEMPORARY OWNER ACCESS");
    expect(r.reason).toContain("333");
  });
  it("the switch never replaces Shopify authentication: every caller authenticates first", () => {
    for (const file of ["app/routes/app.erp.cost-calculator.tsx", "app/routes/app.erp.margin-review.tsx", "app/routes/app.erp.production.tsx"]) {
      expect(src(file), file).toMatch(/await authenticate\.admin\(request\)/);
    }
  });
});

describe("production financial visibility", () => {
  it("visible to owners (and authorized managers) only — fails CLOSED when no owner is configured (2026-11-11)", () => {
    expect(productionFinancialVisibility(as("111"), {}).show).toBe(false); // no owner configured: denied by default
    expect(productionFinancialVisibility(as("111"), { [OWNER_USER_IDS_ENV]: "111" }).show).toBe(true);
    expect(productionFinancialVisibility(as("999"), { [OWNER_USER_IDS_ENV]: "111" }).show).toBe(false);
    expect(productionFinancialVisibility(as("999"), { [OWNER_USER_IDS_ENV]: "111", [OWNER_ENFORCEMENT_ENV]: OWNER_ENFORCEMENT_TEMPORARY }).show).toBe(true);
  });
  it("the board redacts on the SERVER and gates owner cost actions", () => {
    const board = src("app/routes/app.erp.production.tsx");
    expect(board).toContain("jobs: financials.show ? jobsWithActuals : jobsWithActuals.map(redactJobFinancials)");
    expect(board).toContain('["saveFinalCosts", "reopenJobCost", "pullPrintLogActuals", "adjustInventory"].includes(intent)');
    expect(board).toContain("select: { id: true, company: true, customerName: true, email: true, status: true, items: { select: { id: true } } }");
    expect(board).toContain("const costPerUnit = Number((ownerCosts && formData.get(\"costPerUnit\"))");
  });
});

describe("Margin Review", () => {
  const review = src("app/routes/app.erp.margin-review.tsx");
  it("price approvals and Shopify pushes are owner-only", () => {
    expect(review).toContain('if (intent === "reviewApprovalRecords" || intent === "safeShopifyPriceUpdate" || intent === "createPriceApprovalRecords") {');
    expect(review).toContain("requireOwner(auth, process.env,");
  });
  it("approval rows are rebuilt on the server; canonical families are refused; pushes re-verify", () => {
    expect(review).toContain("const server = await serverApprovalRow(prisma, shop, posted.variantRuleId, assumptions);");
    expect(review).toContain("const gate = agentConversionCanonicalGate(recipe);");
    expect(review).toContain("const server = await serverApprovalRow(prisma, shop, record.variantRuleId, pushAssumptions);");
  });
});

/* ---- 2026-11-11 final pass: every production surface ---- */
import { redactJobFinancials } from "../app/lib/production-financial-redaction";

describe("production surfaces — server-side redaction for non-owners", () => {
  const job = {
    id: "j1", status: "printing", actualTotalCost: 410, actualFinalProfit: 215, actualFinalMargin: 34.4, actualCostNotes: "vendor invoice 120",
    actuals: { entryCount: 2, actualSqft: 30, actualInkMl: 41, actualPrintMinutes: 44, revenue: 625, roughActualPrintCost: 18.2, conservativeProfitAfterLoggedPrintCost: 600 },
    finalizeGate: { status: "READY", varianceDollars: 12, variancePct: 3, estimatedTotalCost: 398 },
    items: [{ id: "i1", quantity: 1000, productTitle: "4x5 Sticker Bag", unitPrice: 0.625, unitCost: 0.41, costSnapshot: "{}", priceSnapshot: "{}" }],
    materialUsages: [{ id: "u1", usedQty: 30, costPerUnit: 0.31, totalCost: 9.3 }],
    events: [{ id: "e1", message: "Final cost saved: $410.00", oldValue: null, newValue: null }, { id: "e2", message: "Status changed to printing", oldValue: "queued", newValue: "printing" }],
  };
  it("no money figure survives serialization; operational data does", () => {
    const red = redactJobFinancials(job);
    const json = JSON.stringify(red);
    for (const leaked of ["410", "215", "34.4", "0.625", "0.41", "9.3", "625", "18.2", "vendor invoice"]) expect(json, leaked).not.toContain(leaked);
    expect(red.actuals).toEqual({ entryCount: 2, actualSqft: 30, actualInkMl: 41, actualPrintMinutes: 44 });
    expect(red.items[0]).toMatchObject({ quantity: 1000, productTitle: "4x5 Sticker Bag" });
    expect(red.events[1].message).toBe("Status changed to printing");
  });
  it("board, print work order, calendar and proof all redact on the server; actual-costs is owner-gated", () => {
    expect(src("app/routes/app.erp.production.$id.print.tsx")).toContain("job: financials.show ? full : redactJobFinancials(full)");
    expect(src("app/routes/app.erp.production-calendar.tsx")).toContain("const filteredJobs = financials.show ? searchedJobs : searchedJobs.map(redactJobFinancials);");
    expect(src("app/routes/app.erp.production.$id.proof.tsx")).toContain("productionFinancialVisibility(auth).show ? job : redactJobFinancials(job)");
    expect(src("app/routes/app.erp.actual-costs.tsx")).toContain('if (!financials.show) throw ownerOnlyForbiddenResponse(financials.owner, "Actual costs are owner-only.");');
  });
});
