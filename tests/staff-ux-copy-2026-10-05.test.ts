// Staff UX copy / grouping pass (2026-10-05, branch gso-erp-overnight-finishline).
//
// The four edited routes received DISPLAY-ONLY changes: headings, status words,
// collapsed <details> blocks, plain-language labels. These pins prove that every
// form field name and intent value that existed before the pass still exists,
// that the ops-hub release-test tools stayed inside a collapsed block, that the
// agent review queue approval action is byte-for-byte the same decision-only
// code, and that the new staff headings are present. Source reads only — no
// Prisma, no network.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const quotes = read("app/routes/app.quotes.tsx");
const production = read("app/routes/app.erp.production.tsx");
const queue = read("app/routes/app.erp.agent-review-queue.tsx");
const hub = read("app/routes/app.erp.ops-hub.tsx");

// Snapshot of `name="..."` attributes present in each route BEFORE the pass
// (grep of git HEAD, 2026-10-05). Every one must still be present.
const PRODUCTION_FIELD_NAMES = [
  "actualCostFinalized", "actualCostNotes", "actualLaborCost", "actualLaborMinutes", "actualLaborRate", "actualOtherCost",
  "actualOutsourceCost", "actualPackingCost", "actualReprintCost", "actualShippingCost", "adjustNotes", "adjustQty",
  "artworkUrl", "assetFolderUrl", "assetInboxKey", "assetRole", "assetSource", "assignedTo", "checklistId", "completed",
  "confirmLink", "confirmPhrase", "confirmReopen", "costPerUnit", "customerName", "customerNotes", "deductInventory",
  "deductQty", "dtpAdditionalCharges", "dtpCredit", "dtpFreight", "dtpInvoiceIncludesFreight", "dtpInvoiceSubtotal",
  "dueDate", "email", "estimatedQty", "family", "fileId", "fileName", "fileNotes", "fileType", "fileUrl", "finalizeReason",
  "finish", "intent", "internalNotes", "itemId", "itemNotes", "itemTitle", "jobId", "laborZeroConfirmed", "linkReason",
  "linkTarget", "materialId", "materialName", "materialNotes", "materialType", "note", "phone", "printer", "printFileUrl",
  "priority", "productImageUrl", "proofUrl", "pulledQty", "qcNote", "qcResult", "quantity", "quoteId", "reference",
  "reopenPhrase", "reopenReason", "reprintNote", "reprintQty", "reprintReason", "requestId", "size", "sku", "source",
  "sourceFolderUrl", "sourceJobId", "sourceRef", "status", "totalCost", "unit", "usageId", "usedQty", "wasteQty",
];

const PRODUCTION_INTENTS = [
  "addFile", "addMaterialUsage", "addNote", "adjustInventory", "backfillTickets", "changeStatus", "createFromQuote",
  "createManualJob", "createProofPortal", "deleteFile", "deleteMaterialUsage", "linkJobToTarget", "markPrinted",
  "markProofSent", "pullPrintLogActuals", "qcItem", "reopenJobCost", "reopenReprint", "reprintItem", "revisionItem",
  "saveFinalCosts", "setFileRole", "toggleChecklist", "updateJob",
];

const QUEUE_FIELD_NAMES = ["intent", "itemId", "note", "selectedRecipeId", "suggestedRecipeId"];
const QUEUE_STAFF_INTENTS = ["request_missing_info", "mark_needs_cost_review", "mark_ready_to_quote", "reject", "archive"];

const HUB_FIELD_NAMES = ["intent", "intentId", "runKey"];
const HUB_INTENTS = ["createSandboxApprovalTest", "createStage4Intent", "executeStage4"];

// The Quote Builder posts JSON (fetcher.submit with encType application/json),
// so its contract is the intent vocabulary + the QuoteItemInput keys.
const QUOTE_INTENTS = [
  "searchProducts", "priceRecipe", "createProductionJobFromQuote", "delete", "status", "approveCreateOrder",
  "createDepositOrder", "createBalanceOrder", "sendInvoiceEmail", "approveLowMarginQuote", "save",
];
const QUOTE_ITEM_KEYS = [
  "productName", "variant", "sku", "quantity", "unitPrice", "unitCost", "notes", "productImageUrl", "artworkUrl", "proofUrl",
  "shopifyProductGid", "shopifyVariantGid", "recipeId", "recipeName", "selectedFinish", "selectedAddOnIds", "pricingSource",
  "tierLabel", "minQuantity", "marginPct", "costSnapshot", "priceSnapshot",
];

describe("every pre-existing form field name and intent value survives the copy pass", () => {
  it("Production Board", () => {
    for (const n of PRODUCTION_FIELD_NAMES) expect(production, `name="${n}"`).toContain(`name="${n}"`);
    for (const i of PRODUCTION_INTENTS) {
      expect(production, `action branch ${i}`).toContain(`intent === "${i}"`);
      expect(production, `form value ${i}`).toContain(`value="${i}"`);
    }
  });

  it("Agent Review Queue", () => {
    for (const n of QUEUE_FIELD_NAMES) expect(queue, `name="${n}"`).toContain(`name="${n}"`);
    expect(queue).toContain('value="create_quote_draft"');
    expect(queue).toContain('intent === "create_quote_draft"');
    for (const i of QUEUE_STAFF_INTENTS) expect(queue, `ACTIONS.${i}`).toMatch(new RegExp(`^  ${i}: \\{`, "m"));
    // the staff action buttons still render from the SAME allowed-transition table
    expect(queue).toContain("{allowedActionsForStatus(item.status).map((intent) => (");
    expect(queue).toContain('<input type="hidden" name="intent" value={intent} />');
  });

  it("Operations Hub", () => {
    for (const n of HUB_FIELD_NAMES) expect(hub, `name="${n}"`).toContain(`name="${n}"`);
    for (const i of HUB_INTENTS) {
      expect(hub, `action branch ${i}`).toContain(`intentName === "${i}"`);
      expect(hub, `form value ${i}`).toContain(`value="${i}"`);
    }
  });

  it("Quote Builder (JSON contract)", () => {
    for (const i of QUOTE_INTENTS) {
      expect(quotes, `client intent ${i}`).toContain(`intent: "${i}"`);
      expect(quotes, `server branch ${i}`).toContain(`payload.intent === "${i}"`);
    }
    const typeBlock = quotes.slice(quotes.indexOf("type QuoteItemInput = {"), quotes.indexOf("type ShopifyVariantOption"));
    for (const k of QUOTE_ITEM_KEYS) expect(typeBlock, `QuoteItemInput.${k}`).toMatch(new RegExp(`^  ${k}\\??: `, "m"));
    // the editor still binds every editable field to updateItem with the same key
    for (const k of ["productName", "variant", "sku", "quantity", "unitPrice", "unitCost", "marginPct", "productImageUrl", "artworkUrl", "notes", "selectedFinish"]) {
      expect(quotes, `updateItem(..., "${k}")`).toContain(`updateItem(item.id, "${k}", value)`);
    }
    // protected canonical cost stays read-only in BOTH item layouts (2D-4E3 pin)
    expect(quotes.match(/disabled=\{quoteItemCostIsProtected\(item\.costSnapshot\)\}/g)).toHaveLength(2);
  });
});

describe("ops-hub release-test tools stay inside a collapsed block", () => {
  it("every Stage 3 / Stage 4 form sits between a <details> and its </details>, after the daily-operations lists", () => {
    // anchor on the rendered <summary>, not the header comment that also names the section
    const summary = hub.indexOf("<summary style={summaryStyle}>SANDBOX / RELEASE TEST TOOLS");
    expect(summary).toBeGreaterThan(0);
    const open = hub.lastIndexOf("<details>", summary);
    const close = hub.indexOf("</details>", summary);
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    for (const i of HUB_INTENTS) {
      const at = hub.indexOf(`value="${i}"`);
      expect(at, `${i} inside the collapsed block`).toBeGreaterThan(open);
      expect(at, `${i} inside the collapsed block`).toBeLessThan(close);
    }
    // the daily view (decision lists) renders BEFORE the collapsed tools
    expect(hub.indexOf('title="NEEDS DECISION"')).toBeLessThan(open);
    // registry/matrix reference is also collapsed
    const ref = hub.indexOf("Agent registry and permission matrix (reference)");
    expect(hub.lastIndexOf("<details>", ref)).toBeGreaterThan(close);
  });

  it("safety defaults and actions are untouched", () => {
    expect(hub).not.toMatch(/productionJob\.update|changeStatus|requestProductionTransition\(/);
    expect(hub).toContain("if (runtime.executionEnabled === \"YES\") dangerous.push(");
    expect(hub).toContain("if (slack.sandboxOnly !== \"true\") dangerous.push(");
    expect(hub).toContain("const actor: Actor = { type: \"staff\", id: requestedBy.id, name: requestedBy.name, source: \"ops-hub:stage4-execute\" };");
    expect(hub).toContain("return Response.json({ ok: false, reasons: [\"unknown action\"] }, { status: 400 });");
  });
});

describe("agent review queue approval remains a decision only", () => {
  const action = queue.slice(queue.indexOf("export async function action("), queue.indexOf("const CONVERSION_ERROR_MESSAGES"));

  it("create_quote_draft gates are unchanged and nothing but an internal draft quote is written", () => {
    for (const line of [
      'if (intent === "create_quote_draft") {',
      'if (item.convertedQuoteId) return redirect("/app/erp/agent-review-queue");',
      'if (item.status !== "ready_to_quote") return redirect("/app/erp/agent-review-queue");',
      'if (item.requiresStaffApproval !== true) return redirect("/app/erp/agent-review-queue");',
      'if (item.canBecomeRealQuoteAutomatically !== false) return redirect("/app/erp/agent-review-queue");',
      'const quoteLineResult = quoteLineFromQueueItem(item, recipe, quantity);',
      'status: "draft",',
      'status: "converted_by_staff",',
      'throw new Error("Queue item was already converted.");',
      'eventType: "converted_to_real_quote_by_staff",',
    ]) expect(action, line).toContain(line);
    // the status actions always re-assert the safety flags
    expect(action).toContain("requiresStaffApproval: true,\n    canBecomeRealQuoteAutomatically: false,");
    expect(action).toContain("if (!allowedActionsForStatus(item.status).includes(staffIntent)) {");
    expect(action).toContain("if (NOTE_REQUIRED_ACTIONS.has(staffIntent) && !note) {");
    // no customer message, order, invoice or production job from this route
    for (const banned of ["productionJob.create", "draftOrderCreate", "sendInvoice", "fetch(", "slack"]) expect(action, banned).not.toContain(banned);
  });
});

describe("production status validation and transitions are untouched", () => {
  it("changeStatus still validates against the staff vocabulary before any write", () => {
    const block = production.slice(production.indexOf('if (intent === "changeStatus")'), production.indexOf('if (intent === "updateJob")'));
    expect(block).toContain("if (!isStaffProductionStatus(status)) return Response.json({ ok: false, message: `Invalid production status \"${status}\".` }, { status: 400 });");
    expect(block.indexOf("isStaffProductionStatus(status)")).toBeLessThan(block.indexOf("db.productionJob.findFirst"));
    expect(production).toContain("<select name=\"status\" defaultValue={job.status}");
    expect(production).toContain("{productionStatuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}");
  });

  it("the at-a-glance helpers are derived from loader fields only (no new DB reads in the component tree)", () => {
    const helpers = production.slice(production.indexOf("function statusToneFor("), production.indexOf("function money("));
    expect(helpers).not.toMatch(/\bdb\./);
    expect(helpers).not.toMatch(/await /);
    for (const g of ["glanceProduct", "glanceQuantity", "glanceDue", "glanceMachine", "glanceArt", "glanceMaterial", "glanceNextAction"]) expect(helpers).toContain(`function ${g}(`);
    // the loader include list is exactly what it was
    expect(production).toContain("items: { orderBy: { sortOrder: \"asc\" } },\n        files: { orderBy: { createdAt: \"desc\" } },\n        events: { orderBy: { createdAt: \"desc\" }, take: 20 },\n        checklistItems: { orderBy: [{ section: \"asc\" }, { sortOrder: \"asc\" }] },\n        materialUsages: { orderBy: { createdAt: \"desc\" } },\n        inventoryMovements: { orderBy: { createdAt: \"desc\" }, take: 20 },");
  });
});

describe("new staff headings and status vocabulary", () => {
  it("Quote Builder", () => {
    for (const h of ["Building a new quote", "Editing an existing quote", ">New quote<", "1 · Customer", "2–7 · Items: product, quantity, material / finish, cost, price, margin", "5 · Cost → 6 · Price → 7 · Margin", "8 · Notes → 9 · Save", "OWNER CONFIRMATION PENDING", "Advanced: look up a Shopify product"]) {
      expect(quotes, h).toContain(h);
    }
    // financial blockers stay visible (never collapsed): low-margin approval, canonical read-only cost, below minimum
    expect(quotes).toContain("Low margin - approval required");
    expect(quotes).toContain("Canonical true manufacturing cost — read-only.");
    expect(quotes).toContain("BLOCKED — below minimum quantity");
    expect(quotes).toContain("Items changed since approval - re-approve.");
  });

  it("Production Board", () => {
    for (const h of ['<Glance label="Customer"', '<Glance label="Product"', '<Glance label="Quantity"', '<Glance label="Due date"', '<Glance label="Machine"', '<Glance label="Art / proof"', '<Glance label="Material"', '<Glance label="Next action"', "Technical identifiers (folder name, RIP name, quote/job ids)", "Item ticket, RIP name and run identity", "PROVISIONAL — open", "VERIFIED — finalized"]) {
      expect(production, h).toContain(h);
    }
    // the status badge is no longer hard-coded green
    expect(production).not.toContain('<Badge tone="success">{labelForStatus(job.status)}</Badge>');
    expect(production).toContain("<Badge tone={statusToneFor(job.status)}>{labelForStatus(job.status)}</Badge>");
    // finalize gate words retained (owner-facing blockers never hidden)
    for (const w of ["READY TO FINALIZE", "WARNING — REASON REQUIRED", "BLOCKED"]) expect(production).toContain(w);
  });

  it("Agent Review Queue", () => {
    for (const h of ["Human decision inbox", "Decision inbox", "What the agent wants / why", "Risk & what approval does", "Evidence the agent captured", "What happens if approved", "Execution eligibility right now", "NEEDS DECISION", "READY TO QUOTE", "BLOCKED", "COMPLETED"]) {
      expect(queue, h).toContain(h);
    }
    // green only for ready/completed; rejected/missing info are red; archived grey
    const tone = queue.slice(queue.indexOf("function statusTone("), queue.indexOf("const STATUS_WORDS"));
    expect(tone).toContain('if (status === "ready_to_quote" || status === "converted_by_staff") return "success";');
    expect(tone).toContain('if (status === "rejected" || status === "missing_customer_info") return "critical";');
    expect(tone).toContain('if (status === "archived") return undefined;');
    expect(queue).not.toContain('<Badge tone={item.canBecomeRealQuoteAutomatically ? "critical" : "success"}>');
  });

  it("Operations Hub", () => {
    for (const h of ["Today at a glance", "NEEDS DECISION: ", "EXECUTION BLOCKED: ", "FAILED: ", "COMPLETED: ", 'title="NEEDS DECISION"', 'title="EXECUTION BLOCKED — approved, held by the execution kill switch"', 'title="COMPLETED"', "Diagnostics (provider, tracing, Slack environment, repository, simulation)", "Technical details (ids, audit trail)"]) {
      expect(hub, h).toContain(h);
    }
    // worker badges are informational (grey), not green
    expect(hub).not.toContain('<Badge tone="success">{`Worker scheduled');
    expect(hub).toContain("<Badge>{`Worker trigger: ");
    expect(hub).toContain("<Badge>{`Worker schedule: ");
  });
});
