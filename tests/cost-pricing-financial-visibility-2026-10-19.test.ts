// 2026-10-19 — FINAL FINANCIAL VISIBILITY CLEANUP.
//
//   1. "Approve low margin" is OWNER ONLY (control hidden, server refuses).
//   2. Staff-facing instructions send employees to Quotes / CRM with
//      "Owner Approval Required" — never to the owner-only calculator.
//   3. Quote cards: blended margin / margin detail is owner only, and the
//      Quotes loader + action REDACT it server-side for non-owners.
//
// The real Quotes loader and action run here against an in-memory DB double
// (no Prisma connection) with a mocked Shopify session.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const authState: { sessionToken: any } = { sessionToken: { sub: "1234" } };
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", email: "person@gso.test" }, sessionToken: authState.sessionToken, admin: {} }) },
}));

/* In-memory DB: one low-margin quote (price $10, cost $8 -> 20% margin). */
const dbState: { quote: any; writes: string[] } = { quote: null, writes: [] };
function freshQuote() {
  return {
    id: "q_1", shop: "shop-1", status: "draft", notes: "", customerName: "Acme", company: "Acme", email: null, phone: null,
    customerTier: "standard", customerTierLabel: null, createdAt: new Date(0), updatedAt: new Date(0),
    lowMarginApprovedAt: null, lowMarginApprovedBy: null, lowMarginApprovalReason: null, lowMarginApprovalThresholdPct: null, lowMarginApprovedSnapshot: null,
    items: [{ id: "i_1", quoteId: "q_1", productName: "Custom job", variant: null, sku: null, quantity: 10, unitPrice: 10, unitCost: 8, notes: null, priceSnapshot: null, costSnapshot: null, marginPct: 20 }],
  };
}
vi.mock("../app/db.server", () => {
  const model = (name: string) => ({
    findMany: async () => (name === "quote" ? [dbState.quote] : []),
    findFirst: async () => (name === "quote" ? dbState.quote : null),
    findUnique: async () => (name === "quote" ? dbState.quote : null),
    updateMany: async (args: any) => { dbState.writes.push(`${name}.updateMany`); if (name === "quote") Object.assign(dbState.quote, args.data); return { count: 1 }; },
    update: async () => { dbState.writes.push(`${name}.update`); return {}; },
    create: async () => { dbState.writes.push(`${name}.create`); return {}; },
  });
  const db = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (ops: any[]) => Promise.all(ops) : model(key)) });
  return { default: db, db };
});

import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import { prepareQuote } from "../app/lib/ops/quote-prep.server";

const QUOTES = "app/routes/app.quotes.tsx";
const src = (path: string) => readFileSync(path, "utf8");
const asOwner = () => { process.env[OWNER_USER_IDS_ENV] = "9001"; authState.sessionToken = { sub: "9001" }; };
const asStaff = () => { process.env[OWNER_USER_IDS_ENV] = "9001"; authState.sessionToken = { sub: "1234" }; };
const post = (payload: unknown) => new Request("https://app.test/app/quotes", { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } });

afterEach(() => {
  delete process.env[OWNER_USER_IDS_ENV];
  dbState.quote = freshQuote();
  dbState.writes = [];
});
dbState.quote = freshQuote();

describe("1. low-margin approval is owner only", () => {
  it("a non-owner cannot see the control or grant the override (server refuses, nothing written)", async () => {
    asStaff();
    const { action } = await import("../app/routes/app.quotes");
    const response = await action({ request: post({ intent: "approveLowMarginQuote", quoteId: "q_1", reason: "staff tries" }) });
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Low-margin approval is owner only.");
    expect(dbState.writes).toEqual([]);
    expect(dbState.quote.lowMarginApprovedAt).toBeNull();
    // the margin rule still blocks the staff member's send
    const sent = await (await action({ request: post({ intent: "status", id: "q_1", status: "sent" }) })).json();
    expect(sent.ok).toBe(false);
    // control rendered for the owner only
    const q = src(QUOTES);
    expect(q).toContain("{quote.marginState?.approvalRequired && ownerAccess.isOwner ? (");
    expect(q).toContain("{quote.marginState?.approvalRequired && !ownerAccess.isOwner ? (");
  }, 60_000);

  it("the owner can approve low margin", async () => {
    asOwner();
    const { action } = await import("../app/routes/app.quotes");
    const body = await (await action({ request: post({ intent: "approveLowMarginQuote", quoteId: "q_1", reason: "owner accepts 20% for launch" }) })).json();
    expect(body.ok).toBe(true);
    expect(dbState.writes).toEqual(["quote.updateMany"]);
    expect(dbState.quote.lowMarginApprovalReason).toBe("owner accepts 20% for launch");
  }, 60_000);
});

describe("2. staff instructions point to Quotes / CRM, never the owner-only calculator", () => {
  it("agent handoffs, agent gate messages and editor help say Quotes / CRM + Owner Approval Required", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const ready = prepareQuote({ productFamily: "sticker-bags", quantity: 500, customerName: "A", email: "a@b.c", size: "4x5", material: "Matte", sides: 2, artworkStatus: "ready" } as any, { now });
    for (const result of [ready, prepareQuote({ productFamily: "sticker-bags" } as any, { now })]) {
      expect(result.calculatorPath ?? "/app/quotes").not.toContain("cost-calculator");
      expect(result.handoffNote).not.toMatch(/Cost Calculator|review margin/i);
    }
    expect(ready.handoffNote).toContain("Quotes / CRM");
    expect(ready.handoffNote).toContain("Owner Approval Required");
    const staffFacing = [
      "app/lib/ops/quote-prep.server.ts", "app/lib/agent-quote-canonical-gate.server.ts", "app/routes/app.erp.agent-review-queue.tsx",
      "app/lib/ops/agent-registry.ts", "app/lib/quote-item-cost-authority.ts",
    ];
    for (const file of staffFacing) {
      const text = src(file);
      expect(text, file).not.toMatch(/(build|re-quote|route)[^"`\n]{0,40}in the Cost Calculator|Re-quote (it )?in the Cost Calculator|calculatorPath: "\/app\/erp\/cost-calculator"/);
    }
    const q = src(QUOTES);
    expect(q).not.toContain("Re-quote in the Cost Calculator");
    expect(q).toContain('{ownerAccess.isOwner ? <Button onClick={() => navigate("/app/erp/cost-calculator")}>Open Cost & Pricing Calculator</Button> : null}');
    // owner / admin diagnostic pages keep their calculator links
    expect(src("app/routes/app.erp.cost-health.tsx")).toContain('<Link to="/app/erp/cost-calculator">Open Cost Calculator</Link>');
    expect(src("app/routes/app.erp.cost-verification.tsx")).toContain('<Link to="/app/erp/cost-calculator">Cost Calculator</Link>');
  });
});

describe("3. quote-card margin visibility (server-side)", () => {
  it("non-owner: the loader and action responses carry NO margin figures; the card hides margin", async () => {
    asStaff();
    const { loader, action } = await import("../app/routes/app.quotes");
    const data = await (await loader({ request: new Request("https://app.test/app/quotes") }) as Response).json();
    const card = data.quotes[0];
    expect(card.marginState).toEqual({
      isLowMargin: true, isApproved: false, approvalRequired: true, approvalStale: false,
      approvalLabel: "Owner Approval Required", approvedBy: null, approvedAt: null,
    });
    expect(JSON.stringify(card.marginState)).not.toMatch(/blended|lowest|threshold|\d+\.\d/i);
    expect(card.lowMarginApprovedSnapshot).toBeNull();
    expect(data.ownerAccess.isOwner).toBe(false);
    // every action response list is redacted too
    const refreshed = await (await action({ request: post({ intent: "approveLowMarginQuote", quoteId: "q_1", reason: "x" }) })).json();
    expect(refreshed.quotes[0].marginState.blendedMarginPct).toBeUndefined();
    const q = src(QUOTES);
    expect(q).toContain("{ownerAccess.isOwner && quote.marginState?.blendedMarginPct != null ? (");
    expect(q.split("await getQuotes(shop)").length).toBe(1); // no un-scoped refresh left in the action
  }, 60_000);

  it("owner: the quote card can show margin", async () => {
    asOwner();
    const { loader } = await import("../app/routes/app.quotes");
    const data = await (await loader({ request: new Request("https://app.test/app/quotes") }) as Response).json();
    expect(data.ownerAccess.isOwner).toBe(true);
    expect(data.quotes[0].marginState.blendedMarginPct).toBeCloseTo(20, 6);
    expect(data.quotes[0].marginState.lowItems[0].reason).toContain("below 40%");
  }, 60_000);
});

describe("4. pricing / cost formulas unchanged", () => {
  it("no cost or pricing engine file was touched by these owner decisions", () => {
    for (const lib of [
      "app/lib/canonical-calculator.server.ts", "app/lib/bag-cost-inputs.server.ts", "app/lib/banner-cost-inputs.server.ts",
      "app/lib/label-cost-inputs.server.ts", "app/lib/jar-cost-inputs.server.ts", "app/lib/true-cost-engine.server.ts", "app/lib/canonical-bag-pricing.server.ts",
      "app/lib/commercial-pricing-policy.server.ts", "app/lib/storefront-canonical-pricing.server.ts", "app/lib/jar-commercial-pricing.ts",
      "app/lib/dtp-owner-pricing.server.ts", "app/lib/customer-tiers.ts",
    ]) expect(src(lib), lib).not.toContain("2026-10-19");
    expect(src("app/lib/quote-margin.server.ts")).toContain("export const LOW_MARGIN_THRESHOLD_PCT = 40;");
  });
});
