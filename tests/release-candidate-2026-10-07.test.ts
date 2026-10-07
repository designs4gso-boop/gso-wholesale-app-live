// RELEASE-CANDIDATE PINS — overnight 2026-10-07 safe fixes.
// Source pins for wording/guards + unit pins for the new helpers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProductionAlertText, unrecognizedPaidOrderQueueItem } from "../app/lib/production-alert.server";
// Plain ESM function (no Shopify runtime). Loaded dynamically by path so the
// untyped Function source is not pulled into the TypeScript program.
const cartTransformPath = "../extensions/gso-configurator-cart-transform/src/cart_transform_run.js";
const { cartTransformRun } = (await import(/* @vite-ignore */ cartTransformPath)) as { cartTransformRun: (input: any) => any };

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("paid-order trail (webhook)", () => {
  it("builds the same alert shape as the board and a review-queue item for an unrecognised paid order", () => {
    const text = buildProductionAlertText({ company: "Acme", jobTicket: "GSO-20261007-0001", quoteId: "shopify_order_1", priority: "normal", status: "new" }, "paid Shopify order (webhook)");
    expect(text).toContain("New GSO Production Job");
    expect(text).toContain("Source: paid Shopify order (webhook)");
    expect(text).toContain("Status: New");
    const item = unrecognizedPaidOrderQueueItem("shop.myshopify.com", { name: "#1042", email: "buyer@example.com", customer: { first_name: "Pat", last_name: "Lee" }, line_items: [{ title: "Mystery Item", quantity: 3 }] });
    expect(item.source).toBe("shopify_order_unrecognized");
    expect(item.status).toBe("new");
    expect(item.quantity).toBe("3");
    expect(item.internalNotes).toContain("#1042");
    expect(item.internalNotes).toContain("Mystery Item x3");
    expect(item.internalNotes).toContain("NO production job");
    expect(item.createdBy).toBe("orders_paid_webhook");
    const webhook = src("app/routes/webhooks.orders_paid.tsx");
    expect(webhook).toContain("sendProductionAlertSafe(result.job");
    expect(webhook).toContain("agentReviewQueueItem.create");
    expect(webhook).toMatch(/try \{[\s\S]*sendProductionAlertSafe[\s\S]*\} catch/); // never fails the webhook
  });
});

describe("cart transform honours the live theme attribute keys", () => {
  const line = (attrs: Record<string, string>) => ({
    id: "gid://shopify/CartLine/1",
    quantity: 50,
    gsoConfigurator: { value: attrs._gso_configurator },
    gsoErpPriceEach: attrs["_GSO ERP Price Each"] ? { value: attrs["_GSO ERP Price Each"] } : null,
    gsoErpMatchedTier: null,
    gsoPriceEach: attrs["_GSO Price Each"] ? { value: attrs["_GSO Price Each"] } : null,
    gsoMatchedTier: null,
  });
  it("applies the ERP price from `_GSO Price Each` (theme) and from `_GSO ERP Price Each` (compat); no change otherwise", () => {
    const theme = cartTransformRun({ cart: { lines: [line({ _gso_configurator: "true", "_GSO Price Each": "$1.30" })] } } as any);
    expect(theme.operations).toHaveLength(1);
    expect(theme.operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount).toBe("1.30");
    const compat = cartTransformRun({ cart: { lines: [line({ _gso_configurator: "true", "_GSO ERP Price Each": "0.71" })] } } as any);
    expect(compat.operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount).toBe("0.71");
    expect(cartTransformRun({ cart: { lines: [line({ _gso_configurator: "" , "_GSO Price Each": "1.30" })] } } as any).operations).toHaveLength(0);
    expect(cartTransformRun({ cart: { lines: [line({ _gso_configurator: "true" })] } } as any).operations).toHaveLength(0);
    const gql = src("extensions/gso-configurator-cart-transform/src/cart_transform_run.graphql");
    expect(gql).toContain('attribute(key: "_GSO Price Each")');
    expect(gql).toContain('attribute(key: "_GSO ERP Price Each")');
  });
});

describe("production guards added overnight (source pins)", () => {
  it("calendar validates the status vocabulary and records a status_change event", () => {
    const s = src("app/routes/app.erp.production-calendar.tsx");
    expect(s).toContain("isStaffProductionStatus(status)");
    expect(s).toContain('"status_change"');
    expect(s).not.toContain("suggestedMachine(");
    expect(s).toContain('"Not assigned"');
  });
  it("proof approval (staff + customer link) never regresses a job already past the proof stage", () => {
    const staff = src("app/routes/app.erp.production.$id.proof.tsx");
    expect(staff).toContain("PROOF_STAGE_STATUSES");
    expect(staff).toContain("Proof approval is not allowed while the job is");
    expect(staff).not.toContain("Proof approved internally/customer-approved");
    const customer = src("app/routes/proof.$token.tsx");
    expect((customer.match(/atProofStage\(job\.status\) \? \{ status: "proof_(approved|needed)" \}/g) || []).length).toBe(2);
    expect(customer).toContain("describeSelectedOptions(item.selectedAddOns)");
    expect(customer).not.toContain("item.selectedFinish || item.selectedAddOns ||");
  });
  it("production board: QC card unifies checklist + recorded result, checklist records the actor, qc_result event is emitted", () => {
    const s = src("app/routes/app.erp.production.tsx");
    expect(s).toContain('"qc_result"');
    expect(s).toContain("completedBy: completed ? checklistActor : null");
    expect(s).toContain("QC step and recorded QC result disagree");
    expect(s).not.toContain("const defaultChecklist = [");
    expect(s).toContain('if (value == null || value === "" || Number.isNaN(Number(value))) return "—";');
    const print = src("app/routes/app.erp.production.$id.print.tsx");
    expect(print).toContain("resolvePrintDuration(entry).minutes");
    expect(print).toContain('startsWith("cut:")');
    expect(print).not.toContain("Job ID: {job.id}");
  });
  it("machines copy matches the routing authority (Mimaki = CMYK only)", () => {
    const s = src("app/routes/app.erp.machines.tsx");
    expect(s).not.toContain("Mimaki is set up for CMYK + white");
    expect(s).toContain("The Mimaki runs CMYK only");
  });
});

describe("sales / admin honesty fixes (source pins)", () => {
  it("margin review no longer claims to be read-only or locked; no roadmap section", () => {
    const s = src("app/routes/app.erp.margin-review.tsx");
    for (const stale of ["This version is still read-only", "Shopify updates still locked", "Shopify quantity pricing still locked", "<h2 style={{ marginTop: 0 }}>Next phase</h2>", "v10 update Shopify prices"]) expect(s, stale).not.toContain(stale);
    expect(s).toContain('{row.currentPrice ? money(row.currentPrice) : "No price"}');
  });
  it("calculator: draft save links to Quotes; no-op button gone; owner date current", () => {
    const s = src("app/routes/app.erp.cost-calculator.tsx");
    expect(s).toContain("quoteId: quote.id");
    expect((s.match(/Open Quotes \/ CRM →/g) || []).length).toBe(3);
    expect(s).not.toContain("setSelectedQty(selected.quantity)");
    expect(s).not.toContain("owner-approved 2026-07-24).");
    expect(s).toContain("4x5x2: owner-approved 2026-10-06");
    expect(s).not.toContain("CANONICAL_DISPATCH[canonical.family]?.entry}");
  });
  it("customer quote page labels and colours every status; quotes board hides the margin badge until items are priced", () => {
    const q = src("app/routes/quote.$id.tsx");
    for (const k of ['won: "Confirmed"', 'lost: "Closed"', 'canceled: "Canceled"', 'expired: "Expired"', "statusColor(quote.status)"]) expect(q).toContain(k);
    const b = src("app/routes/app.quotes.tsx");
    expect(b).toContain("const hasPricedItems = Number(totals.revenue || 0) > 0;");
    expect(b).toContain('"No priced items yet"');
  });
  it("pricing intelligence: no $undefined, no patch ids in rendered copy, dollar signs on money columns", () => {
    const s = src("app/routes/app.erp.pricing-intelligence.tsx");
    expect(s).not.toContain("acceptedLow?.toFixed(2)} / $");
    expect(s).not.toContain("15F.0K.4E — read-only");
    expect(s).not.toContain('display: "none"');
    expect(s).toContain("`$${c.vendorUnit.toFixed(4)}`");
  });
  it("admin settings: every unread setting says NOT CURRENTLY USED; pricing rules banner is honest; shopify links has no fake green status", () => {
    const admin = src("app/routes/app.erp.admin-settings.tsx");
    expect((admin.match(/NOT CURRENTLY USED — stored for a future release/g) || []).length).toBeGreaterThanOrEqual(29);
    const rules = src("app/routes/app.erp.pricing-rules.tsx");
    expect(rules).toContain("LEGACY / DIAGNOSTIC — these tier rules are read only by the Shopify Cost Audit");
    expect(rules).not.toContain("changes here can affect live pricing, mappings, or Shopify behavior");
    const links = src("app/routes/app.erp.shopify-links.tsx");
    expect(links).not.toContain('<Badge tone="green">Products linked</Badge>');
    expect(links).toContain("Pause auto-sync (reload without continuing)");
  });
  it("purchasing: Mark PO sent keeps saved vendor fields; cost book tier at MOQ is the highest qualifying break; materials show action feedback", () => {
    const pr = src("app/routes/app.erp.purchase-requests.tsx");
    expect(pr).toContain('formData.has("vendorConfirmationNumber") ? postedConfirmation || null : existing?.vendorConfirmationNumber ?? null');
    const vcb = src("app/routes/app.erp.vendor-cost-book.tsx");
    expect(vcb).toContain("sort((a: any, b: any) => Number(b.minQty || 0) - Number(a.minQty || 0)).find(");
    const mat = src("app/routes/app.erp.materials.tsx");
    expect(mat).toContain("{actionFeedback ? <div");
    const nav = src("app/routes/app.tsx");
    expect(nav).toContain('<s-link href="/app/wholesale/customers">Sales · Wholesale Applications</s-link>');
  });
});
