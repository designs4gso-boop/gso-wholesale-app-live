// 2026-11-19 (night) — UI RENDER SMOKE.
//
// No browser was available for this work, so these screens are RENDERED here
// (React server render through the real route components, inside the Polaris
// provider and a router) with representative data, and the output is checked
// for the controls staff rely on. This proves the screens render without
// throwing and show the right things for the data. It is NOT a visual check in
// a browser: layout, spacing and touch behaviour are still to be looked at.

import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "@shopify/polaris";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: "1" }, admin: {} }) } }));
vi.mock("../app/db.server", () => ({ default: {}, db: {} }));
vi.mock("@shopify/shopify-app-react-router/server", () => ({ boundary: { error: () => null, headers: () => ({}) } }));

function render(Component: any, loaderData: any, options: { path?: string; url?: string; ErrorBoundary?: any; error?: any } = {}): string {
  const path = options.path || "/page";
  const Stub = createRoutesStub([{ id: "page", path, Component, ErrorBoundary: options.ErrorBoundary, loader: () => loaderData, action: () => null }]);
  const hydrationData = options.error ? { errors: { page: options.error }, loaderData: {} } : { loaderData: { page: loaderData } };
  const html = renderToString(createElement(AppProvider, { i18n: {} } as any, createElement(Stub, { initialEntries: [options.url || path], hydrationData } as any)));
  // React marks adjacent text nodes with <!-- --> and escapes quotes; compare the text a person reads
  return html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
const forbidden = { status: 403, statusText: "Forbidden", data: "denied", internal: false };
const routeError = (error: any) => Object.assign(Object.create(null), error, { __type: "RouteErrorResponse" });

describe("CRM", () => {
  it("lead list: filters, a due lead, the add form — and no send control", async () => {
    const page = await import("../app/routes/app.erp.crm");
    const html = render(page.default, {
      view: "open", q: "", dueCount: 1, sources: ["manual", "referral"], statuses: [],
      leads: [
        { id: "l1", name: "Krud Cafe", contactName: "Sam", email: "sam@krud.test", phone: "555-0100", status: "contacted", statusLabel: "Contacted", assignedStaffName: "Dana", nextFollowUpAt: "2026-11-18T12:00:00.000Z", followUpDue: true, hasQuote: true },
        { id: "l2", name: "Leaf Labs", contactName: null, email: null, phone: null, status: "new", statusLabel: "New", assignedStaffName: null, nextFollowUpAt: null, followUpDue: false, hasQuote: false },
      ],
    });
    for (const text of ["Leads", "Follow-up due (1)", "Assigned to me", "Krud Cafe", "Assigned to Dana", "Has a quote", "Leaf Labs", "No contact details yet", "Not assigned", "Add a lead", "Nothing on this page sends a message"]) expect(html).toContain(text);
    expect(html).not.toMatch(/Send email|Send text|Send message/i);
  }, 120_000);

  it("empty list and the refused view", async () => {
    const page = await import("../app/routes/app.erp.crm");
    expect(render(page.default, { view: "won", q: "", dueCount: 0, sources: ["manual"], statuses: [], leads: [] })).toContain("No leads in this view.");
    const denied = render(page.default, null, { ErrorBoundary: page.ErrorBoundary, error: routeError(forbidden) });
    expect(denied).toContain("Leads and customers are for the owner, managers and sales.");
    expect(denied).not.toContain("Add a lead");
  }, 120_000);

  it("lead detail: next step, conversions, approval request, history", async () => {
    const page = await import("../app/routes/app.erp.crm.$id");
    const data = {
      lead: { id: "l1", name: "Krud Cafe", company: "Krud Cafe", contactName: "Sam", email: "sam@krud.test", phone: "555", source: "referral", productInterest: "4x5 bags", notes: "Likes holo", status: "contacted", statusLabel: "Contacted", assignedStaffName: "Dana", assignedToMe: false, nextFollowUpDate: "2026-11-21", followUpDue: false, outcomeReason: null, createdAt: "2026-11-19T10:00:00.000Z", createdBy: "Dana" },
      account: null, quote: null,
      events: [{ id: "e1", event: "status_changed", fromStatus: "new", toStatus: "contacted", detail: null, actor: "Dana", at: "2026-11-19T11:00:00.000Z" }, { id: "e2", event: "note", fromStatus: null, toStatus: null, detail: "Left a voicemail", actor: "Dana", at: "2026-11-19T12:00:00.000Z" }],
      sources: ["manual", "referral"], statuses: [{ value: "new", label: "New" }, { value: "contacted", label: "Contacted" }, { value: "lost", label: "Lost" }], me: "Dana",
    };
    const html = render(page.default, data, { path: "/lead/:id", url: "/lead/l1" });
    for (const text of ["Krud Cafe", "Update status", "Save follow-up date", "Assign to me", "Make this a customer", "Create draft quote", "Send for approval", "The ERP never sends it", "Left a voicemail", "Status changed", "No customer account yet.", "No quote yet."]) expect(html).toContain(text);
    const linked = render(page.default, { ...data, account: { id: "a1", company: "Krud Cafe" }, quote: { id: "q1", status: "draft" } }, { path: "/lead/:id", url: "/lead/l1" });
    expect(linked).toContain("Customer account: Krud Cafe");
    expect(linked).toContain("Quote linked (draft).");
    expect(linked).not.toContain("Make this a customer");
    expect(linked).toContain("Open Quotes");
  }, 120_000);
});

describe("Approvals", () => {
  it("a waiting draft shows what it is, who proposed it, what approval does, and both buttons", async () => {
    const page = await import("../app/routes/app.erp.agent-approvals");
    const item = { id: "ai_1", kind: "Draft message to a customer", actionType: "submit_outreach_draft", status: "AWAITING_APPROVAL", reason: "Follow up after the sample", entityType: "crm_lead", entityId: "l1", proposedBy: "customer_followup", proposedByType: "agent", createdAt: "2026-11-19T12:00:00.000Z", approvedBy: null, approvedAt: null, error: null, onApprove: "Approved for a person to send by hand. The ERP sends nothing.", fields: [{ name: "message", value: "Hi Sam, following up on your bags." }] };
    const html = render(page.default, { approvals: [item, { ...item, id: "ai_2", status: "CANCELLED", approvedBy: null }] });
    for (const text of ["Approvals", "Draft message to a customer", "Waiting for you", "(agent)", "Hi Sam, following up on your bags.", "The ERP sends nothing.", "APPROVE", "Reject", "Open the lead", "Already decided (1)", "Rejected", "Approving never sends anything to a customer"]) expect(html).toContain(text);
    expect(render(page.default, { approvals: [] })).toContain("Nothing is waiting for approval.");
    expect(render(page.default, null, { ErrorBoundary: page.ErrorBoundary, error: routeError(forbidden) })).toContain("Proposals are approved by the owner or a manager.");
  }, 120_000);
});

describe("Release to Production", () => {
  const txn = {
    id: "st1", sourceLabel: "QuickBooks invoice", docNumber: "1270", customerName: "krud Cafe", txnDate: "2026-11-18T12:00:00.000Z", externalStatus: "Partially paid", totalAmount: 512, balance: 256, status: "staged",
    reviewNotes: null, releasedBy: null, releasedJobId: null, releasedJobTicket: null, blockers: ["1 line(s) still need review — mark each line as production or not production."],
    lines: [
      { key: "1", description: "Qty:128 - 20 designs", quantity: 128, amount: 512, externalItemName: "Custom Item", classification: "production", productionItems: [{ productTitle: "HEATH pouch", quantity: 128, reorderSourceItemId: "old-1", reorderArtworkMode: "revision" }, { productTitle: "SHORTCAKES pouch", quantity: 128 }] },
      { key: "2", description: "Old Balance", quantity: 1, amount: 0, externalItemName: null, classification: "needs_review", productionItems: [] },
    ],
  };
  const base = { showAmounts: true, families: [{ value: "default", label: "Other" }], finishes: ["CMYK"], canChoosePrinter: true, find: "", reorderOptions: [{ id: "old-1", label: "GSO-20261001-0007-01 — HEATH pouch (128) — Krud Cafe" }] };

  it("a staged invoice with the reorder picker on each production item", async () => {
    const page = await import("../app/routes/app.erp.release-queue");
    const html = render(page.default, { ...base, transactions: [txn] });
    for (const text of ["krud Cafe", "QuickBooks invoice 1270", "Balance $256.00", "Qty:128 - 20 designs", "Old Balance", "Not decided yet", "Is any of these a reorder", "Not a reorder", "GSO-20261001-0007-01 — HEATH pouch (128) — Krud Cafe", "Same artwork as before", "Revised artwork (new proof needed)", "RELEASE TO PRODUCTION", "Save review", "Find earlier items", "Before release:"]) expect(html).toContain(text);
    expect(html).toMatch(/name="reorder_0_0"/);
    expect(html).toMatch(/name="reorder_0_1"/);
    expect(html).toMatch(/name="reorderfor_0_0" value="HEATH pouch"/);
  }, 120_000);

  it("amounts are absent for a reviewer without financial access; the empty and refused views", async () => {
    const page = await import("../app/routes/app.erp.release-queue");
    const hidden = render(page.default, { ...base, showAmounts: false, transactions: [{ ...txn, totalAmount: null, balance: null, lines: txn.lines.map((line) => ({ ...line, amount: null })) }] });
    expect(hidden).not.toContain("$512.00");
    expect(hidden).not.toContain("Balance $");
    expect(hidden).not.toContain("Total $");
    expect(render(page.default, { ...base, transactions: [] })).toContain("Nothing is waiting for release.");
    expect(render(page.default, null, { ErrorBoundary: page.ErrorBoundary, error: routeError(forbidden) })).toContain("done by the owner or a manager");
  }, 120_000);
});

describe("Privacy Requests", () => {
  it("an open erasure request: counts, the ERASE confirmation, working note, history; an overdue one says so", async () => {
    const page = await import("../app/routes/app.erp.privacy-requests");
    const row = {
      id: "c1", topic: "customers/redact", topicLabel: "Customer asked to be erased", customerEmail: "sam@krud.test", customerId: "12", status: "in_progress", receivedAt: "2026-11-01T00:00:00.000Z", dueAt: "2026-12-01T00:00:00.000Z",
      completedBy: null, completedAt: null, startedBy: "Owner", notes: "Checked quotes", overdue: false, resultSummary: null,
      history: [{ id: "h1", event: "received", detail: "customers/redact", actor: "shopify", at: "2026-11-01T00:00:00.000Z" }, { id: "h2", event: "started", detail: null, actor: "Owner", at: "2026-11-02T00:00:00.000Z" }],
      plan: { quotes: 1, productionJobs: 2, wholesaleApplications: 0, leads: 0, crmRecords: 1, total: 4, matchable: true },
    };
    const html = render(page.default, { requests: [row, { ...row, id: "c2", status: "received", overdue: true, history: [] }, { ...row, id: "c3", status: "completed", completedAt: "2026-11-03T00:00:00.000Z", completedBy: "Owner", resultSummary: "Contact details blanked on 4 record(s). Records kept.", plan: null }] });
    for (const text of ["Privacy Requests", "Customer asked to be erased", "In progress", "OVERDUE", "2 production job(s)", "1 CRM record(s)", "Type ERASE to confirm", "The quotes, jobs and their history are kept", "Add note", "Mark as handled", "I am working on this", "History (2)", "Completed", "Records kept."]) expect(html).toContain(text);
  }, 120_000);
});

describe("Production Board", () => {
  it("a job on reprint, packed and waiting: run, QC, printer, files, due date and assignment are on the card — no money", async () => {
    const { toBoardCard, buildSimpleBoard } = await import("../app/lib/simple-production");
    const page = await import("../app/routes/app.erp.production-board");
    const job = {
      id: "j1", jobTicket: "GSO-20261119-0042", customerName: "Krud Cafe", status: "printing", priority: "rush", dueDate: "2026-11-22T12:00:00.000Z", assignedTo: "Dana", fulfillmentState: null,
      actualTotalCost: 81.5, quotedTrueCost: 70, updatedAt: "2026-11-19T12:00:00.000Z", events: [], files: [], checklistItems: [],
      items: [{ id: "i1", itemTicket: "GSO-20261119-0042-01", productTitle: "HEATH pouch", quantity: 500, unitPrice: 0.62, unitCost: 0.31, selectedFinish: "CMYK + Gloss", machineSummary: "Mimaki UCJV300", lastReprintAt: "2026-11-19T11:00:00.000Z",
        runs: [{ itemId: "i1", runNumber: 1, kind: "original", quantity: 500, status: "qc_failed" }, { itemId: "i1", runNumber: 2, kind: "reprint", quantity: 25, reasonCode: "banding", chargeType: "internal", status: "open" }] }],
    };
    const packed = { ...job, id: "j2", jobTicket: "GSO-20261119-0043", customerName: "Leaf Labs", status: "qc", fulfillmentState: "ready_to_ship", items: [{ ...job.items[0], id: "i2", runs: [] }] };
    const cards = [toBoardCard(job), toBoardCard(packed)];
    expect(cards[0]).toMatchObject({ activeRunLabel: "Run 2 · Reprint · 25 pcs", fulfillmentLabel: "" });
    expect(cards[1]).toMatchObject({ activeRunLabel: "", fulfillmentLabel: "Ready to ship" });
    expect(JSON.stringify(cards)).not.toMatch(/81\.5|0\.62|0\.31|unitCost|unitPrice|actualTotalCost/);
    const html = render(page.default, { board: buildSimpleBoard(cards), total: 2 }, { path: "/board", url: "/board?view=all" });
    for (const text of ["Krud Cafe", "Leaf Labs", "On press now", "Run 2 · Reprint · 25 pcs", "Packed", "Ready to ship", "Dana", "RUSH"]) expect(html).toContain(text);
    expect(html).not.toMatch(/\$81|\$0\.62/);
  }, 120_000);
});
