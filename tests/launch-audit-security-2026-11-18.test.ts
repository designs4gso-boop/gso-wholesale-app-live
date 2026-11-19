// Launch-readiness audit, 2026-11-18: authorization, tenant-scope and data-leak fixes.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MONEY_OR_PRODUCTION_QUOTE_STATUSES, quoteStatusChangeCheck } from "../app/lib/quote-pricing-authority";
import { productionSafeQuoteNotes } from "../app/lib/quote-staff-visibility";
import { LOW_MARGIN_APPROVAL_MARKER, lowMarginApprovalLine } from "../app/lib/quote-margin.server";

const root = path.resolve(__dirname, "..");
const src = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
/** The body of an exported loader / action, up to the next top-level export. */
const exported = (source: string, name: "loader" | "action") => {
  const start = source.search(new RegExp(`export (?:async function|const) ${name}\\b`));
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start + 10);
  const next = rest.search(/\nexport (?:async function|const|default function|function) /);
  return next < 0 ? rest : rest.slice(0, next);
};
/** The gate must run before the handler reads the request body or touches the database. */
const gatedBeforeWork = (body: string, gate: string) => {
  const gateAt = body.indexOf(gate);
  expect(gateAt, `${gate} missing`).toBeGreaterThan(-1);
  const firstWork = body.search(/request\.(?:formData|json)\(|\bdb\.|ensureSetting\(|getRules\(|getWholesaleConfig\(|readOpsRuntimeConfig\(/);
  expect(firstWork, "no work found after the gate").toBeGreaterThan(gateAt);
};

describe("pages that had no role gate now have one (loader and action)", () => {
  it("Print Log Settings: view = owner / authorized manager; save and token rotation = owner only", () => {
    const file = src("app/routes/app.erp.print-log-settings.tsx");
    gatedBeforeWork(exported(file, "loader"), "requireFinancialAccess(auth);");
    gatedBeforeWork(exported(file, "action"), "requireOwner(auth);");
  });

  it("Agent Security (external agent API credentials): owner only", () => {
    const file = src("app/routes/app.erp.agent-security.tsx");
    gatedBeforeWork(exported(file, "loader"), "requireOwner(auth);");
    gatedBeforeWork(exported(file, "action"), "requireOwner(auth);");
  });

  it("Wholesale discount settings and price rules: owner / authorized manager", () => {
    for (const route of ["app/routes/app.wholesale.tsx", "app/routes/app.wholesale.rules.tsx"]) {
      const file = src(route);
      gatedBeforeWork(exported(file, "loader"), "requireFinancialAccess(auth);");
      gatedBeforeWork(exported(file, "action"), "requireFinancialAccess(auth);");
    }
  });

  it("Wholesale applications (tax IDs, approval): an assigned selling role — never unassigned", () => {
    const file = src("app/routes/app.wholesale.customers.tsx");
    for (const name of ["loader", "action"] as const) {
      gatedBeforeWork(exported(file, name), 'if (!access.can("sendQuote")) throw permissionDeniedResponse(access, "sendQuote");');
    }
  });

  it("Configurator Sync (bulk storefront product write): owner / authorized manager", () => {
    const file = src("app/routes/app.erp.configurator-sync.tsx");
    gatedBeforeWork(exported(file, "loader"), "requireFinancialAccess(auth);");
    gatedBeforeWork(exported(file, "action"), "requireFinancialAccess(auth);");
  });

  it("Ops Hub: owner only, as the page says", () => {
    const file = src("app/routes/app.erp.ops-hub.tsx");
    gatedBeforeWork(exported(file, "loader"), "requireOwner(auth);");
    gatedBeforeWork(exported(file, "action"), "requireOwner(auth);");
  });
});

describe("Quotes", () => {
  const quotes = src("app/routes/app.quotes.tsx");
  const action = exported(quotes, "action");

  it("deleting a quote, creating a Shopify draft order and emailing an invoice need an assigned selling role", () => {
    const gate = action.indexOf('if (["delete", "approveCreateOrder", "createDepositOrder", "createBalanceOrder", "sendInvoiceEmail"].includes(String(payload?.intent || ""))) {');
    expect(gate).toBeGreaterThan(-1);
    expect(action.slice(gate, gate + 500)).toContain('if (!quoteAccess.can("sendQuote")) {');
    expect(action.slice(gate, gate + 700)).toContain("{ status: 403 }");
    // before any intent is handled
    for (const intent of ["delete", "approveCreateOrder", "createDepositOrder", "createBalanceOrder", "sendInvoiceEmail"]) {
      const handled = action.indexOf(`payload.intent === "${intent}"`);
      expect(handled, intent).toBeGreaterThan(gate);
    }
  });

  it("a save for a quote id that is not this shop's writes nothing, and the item delete is shop-scoped", () => {
    const lookup = action.indexOf("const existingQuote = await db.quote.findFirst({ where: { id: quote.id, shop } });");
    const refuse = action.indexOf("if (!existingQuote) {");
    const write = action.indexOf("db.quoteItem.deleteMany({ where: { quoteId: quote.id, quote: { shop } } }),");
    expect(lookup).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(lookup);
    expect(write).toBeGreaterThan(refuse);
    expect(action).not.toContain("db.quoteItem.deleteMany({ where: { quoteId: quote.id } })");
  });

  it("a quote that has taken money or reached production cannot be deleted", () => {
    expect(action).toContain("await db.quote.deleteMany({ where: { id: payload.id, shop, status: { notIn: LOCKED_QUOTE_STATUSES } } });");
    expect(quotes).toContain('const LOCKED_QUOTE_STATUSES = ["deposit_paid", "paid", "production", "completed"];');
  });

  it("only the owner can move a quote OUT of a locked state (staff could reopen it and rewrite the snapshot)", () => {
    expect([...MONEY_OR_PRODUCTION_QUOTE_STATUSES]).toEqual(["deposit_paid", "paid", "production", "completed"]);
    for (const current of ["deposit_paid", "paid", "production", "completed"]) {
      for (const next of ["draft", "sent", "approved", "won", "lost", "canceled", "expired"]) {
        expect(quoteStatusChangeCheck({ currentStatus: current, nextStatus: next, isOwner: false }), `${current}->${next}`).toMatchObject({ ok: false });
        expect(quoteStatusChangeCheck({ currentStatus: current, nextStatus: next, isOwner: true })).toEqual({ ok: true });
      }
    }
    // unchanged: the normal forward staff move, no-op changes, and ordinary sales moves
    expect(quoteStatusChangeCheck({ currentStatus: "production", nextStatus: "completed", isOwner: false })).toEqual({ ok: true });
    expect(quoteStatusChangeCheck({ currentStatus: "production", nextStatus: "production", isOwner: false })).toEqual({ ok: true });
    expect(quoteStatusChangeCheck({ currentStatus: "draft", nextStatus: "sent", isOwner: false })).toEqual({ ok: true });
    expect(quoteStatusChangeCheck({ currentStatus: "sent", nextStatus: "lost", isOwner: false })).toEqual({ ok: true });
    // unchanged: payment / production states are still owner-only to SET
    expect(quoteStatusChangeCheck({ currentStatus: "approved", nextStatus: "paid", isOwner: false })).toMatchObject({ ok: false });
    expect(quoteStatusChangeCheck({ currentStatus: "completed", nextStatus: "production", isOwner: false })).toMatchObject({ ok: false });
  });
});

describe("margin and internal audit lines never reach the production work order / proof sheet", () => {
  it("productionSafeQuoteNotes drops low-margin approval lines and [GSO] audit lines, keeps the customer's notes", () => {
    const approval = lowMarginApprovalLine({ actor: "owner", thresholdPct: 40, blendedMarginPct: 31.2, lowestMarginPct: 18.5, reason: "repeat customer" });
    expect(approval.startsWith(LOW_MARGIN_APPROVAL_MARKER)).toBe(true);
    const notes = ["Deliver by Friday.", approval, "[GSO] Full payment invoice paid (Shopify order #1010).", "  [GSO] Owner-approved price RESET by owner", "Customer wants matte."].join("\n");
    const safe = productionSafeQuoteNotes(notes);
    expect(safe).toBe("Deliver by Friday.\nCustomer wants matte.");
    expect(safe).not.toMatch(/%|\[GSO\]|margin|threshold/i);
    expect(productionSafeQuoteNotes(null)).toBe("");
    expect(productionSafeQuoteNotes(approval)).toBe("");
  });

  it("the quote -> production job copy uses it", () => {
    const service = src("app/lib/production-job-source.server.ts");
    expect(service).toContain("customerNotes: productionSafeQuoteNotes(quote.notes) || null,");
    expect(service).not.toContain("customerNotes: quote.notes || null,");
  });
});

describe("tenant scope", () => {
  it("Vendor Cost Book: linked ids are verified against the shop and apply-writes are shop-scoped", () => {
    const file = src("app/routes/app.erp.vendor-cost-book.tsx");
    expect(file).toContain("if (materialId && !(await db.material.findFirst({ where: { shop, id: materialId }, select: { id: true } }))) {");
    expect(file).toContain("if (vendorProductId && !(await db.vendorProduct.findFirst({ where: { shop, id: vendorProductId }, select: { id: true } }))) {");
    expect(file).toContain("where: { id: item.materialId, shop },");
    expect(file).not.toMatch(/db\.material\.update\(\{\s*where: \{ id: item\.materialId \}/);
    const apply = file.slice(file.indexOf('if (intent === "applyToVendorProduct") {'));
    expect(apply.indexOf("db.vendorProduct.findFirst({ where: { shop, id: item.vendorProductId }")).toBeGreaterThan(-1);
    expect(apply.indexOf("db.vendorProduct.findFirst({ where: { shop, id: item.vendorProductId }")).toBeLessThan(apply.indexOf("await db.vendorProduct.update({"));
  });

  it("Production: a file or event is only ever written onto a job of this shop", () => {
    const file = src("app/routes/app.erp.production.tsx");
    const addFile = file.slice(file.indexOf('if (intent === "addFile") {'));
    const check = addFile.indexOf('if (!job) return Response.json({ ok: false, message: "Production job not found." }, { status: 404 });');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(addFile.indexOf("await db.productionJobFile.create({"));
    const createEvent = file.slice(file.indexOf("async function createEvent("));
    expect(createEvent.indexOf("if (!(await db.productionJob.findFirst({ where: { shop, id: jobId }, select: { id: true } }))) return null;")).toBeLessThan(createEvent.indexOf("return db.productionJobEvent.create({"));
    expect(createEvent.indexOf("if (!(await db.productionJob.findFirst({ where: { shop, id: jobId }")).toBeGreaterThan(-1);
  });
});

describe("orders/paid webhook", () => {
  const hook = src("app/routes/webhooks.orders_paid.tsx");
  it("a replayed full payment never pulls a quote back out of production / completed", () => {
    const full = hook.slice(hook.indexOf('if (paymentType === "full") {'), hook.indexOf('if (paymentType === "deposit") {'));
    const guard = full.indexOf('if (["production", "completed"].includes(quote.status)) {');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(full.indexOf('status: "paid",'));
    expect(full.slice(guard, full.indexOf('status: "paid",'))).toContain("status ${quote.status} preserved");
    expect(full.slice(guard, full.indexOf("return `OK full payment recorded"))).not.toContain("status:");
  });
  it("a paid order naming a quote that does not exist leaves a review item", () => {
    const missing = hook.slice(hook.indexOf("if (!quote) {"), hook.indexOf("const verification = await verifyQuotePaymentOrder"));
    expect(missing).toContain("db.agentReviewQueueItem.create({ data: unrecognizedPaidOrderQueueItem(shop, order) as any });");
    expect(missing).toContain('return "OK no matching quote for Quote ID; held for review";');
  });
});

describe("staff-facing fixes", () => {
  it("Stock Levels shows the inventory forms only to roles whose submit the server accepts", () => {
    const file = src("app/routes/app.erp.reorder-report.tsx");
    const gate = file.indexOf("{canSeeCost ? (<>");
    expect(gate).toBeGreaterThan(-1);
    expect(file.indexOf('name="intent" value="updateMaterialInventory"')).toBeGreaterThan(gate);
    expect(file.indexOf('name="intent" value="quickPurchase"')).toBeGreaterThan(gate);
    expect(file.indexOf("</>) : (")).toBeGreaterThan(file.indexOf('name="intent" value="quickPurchase"'));
  });
  it("instructions no longer say the dry run writes, or point at a script that does not exist", () => {
    expect(src("app/routes/app.erp.print-intake.tsx")).not.toContain("NOT read-only");
    expect(src("app/routes/app.erp.cost-calculator.tsx")).not.toContain("-File .\\tools\\gso-sync-quote-rip-results-to-app.ps1");
    expect(fs.existsSync(path.join(root, "tools", "gso-sync-quote-rip-results-to-app.ps1"))).toBe(false);
  });
});
