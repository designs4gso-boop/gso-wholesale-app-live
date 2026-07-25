import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { presentProductionEvent } from "../app/lib/production-event-presenter.server";
import { assessCommercialName, cleanCommercialName } from "../app/lib/commercial-name-resolver.server";

const FINALIZE_SNAPSHOT = {
  version: "15E.1-actual-cost-finalize", gateStatus: "WARNING",
  warningReasons: ["Print cost is the LIVE PREVIEW"], finalizeReason: "Test validation - no recorded RIP writeback available.",
  enteredInputs: { laborMinutes: 30, laborRate: 20, laborCostOverride: null, laborZeroConfirmed: false, packingCost: null, shippingCost: null, outsourceCost: null, reprintCost: null, otherCost: null, dtp: null },
  components: { printCost: 12.26, printCostSource: "preview", materialCost: 0, laborCost: 10, laborBasis: "minutes_x_rate", packingCost: 0, shippingCost: 0, outsourceCost: 0, reprintCost: 0, otherCost: 0 },
  revenue: 30.65, finalTotalCost: 0, finalGrossProfit: 30.65, finalGrossMarginPct: 100,
  estimatedTotalCost: 12.26, varianceDollars: -12.26, variancePct: -100,
  actor: "owner@gso.com", finalizedAt: "2026-07-24T12:00:00Z", family: "stickers-labels",
};

describe("production event presenter (15E.3)", () => {
  it("finalized event: human summary with cost/profit/margin/variance/gate/reason — no raw JSON in the summary", () => {
    const event = presentProductionEvent({ id: "e1", eventType: "actual_cost_finalized", createdAt: "2026-07-24T12:00:01Z", createdBy: "owner@gso.com", jobTicket: "GSO-1", message: `Actual cost FINALIZED by owner@gso.com. Total: $0.00 | SNAPSHOT ${JSON.stringify(FINALIZE_SNAPSHOT)}` });
    expect(event.title).toBe("Actual cost finalized");
    expect(event.summaryLines).toContain("Final cost: $0.00");
    expect(event.summaryLines).toContain("Final profit: $30.65");
    expect(event.summaryLines).toContain("Final margin: 100.0%");
    expect(event.summaryLines.join(" ")).toContain("Variance: -$12.26");
    expect(event.summaryLines).toContain("Gate: WARNING");
    expect(event.summaryLines.join(" ")).toContain("Test validation");
    expect(event.summaryLines.join(" ")).not.toContain("{"); // no raw JSON inline
    // audit sections preserve exact values; raw payload retained
    const sectionText = event.auditSections.map((section) => `${section.title}: ${section.rows.map(([k, v]) => `${k}=${v}`).join(", ")}`).join(" | ");
    expect(sectionText).toContain("Inputs");
    expect(sectionText).toContain("Labor minutes=30");
    expect(sectionText).toContain("Print cost=$12.26 (preview)");
    expect(sectionText).toContain("Variance %=-100.0%");
    expect(sectionText).toContain("Actor=owner@gso.com");
    expect(event.rawJson).toContain('"finalGrossProfit": 30.65');
    expect(event.rawMessage).toContain("SNAPSHOT"); // original preserved
  });

  it("reopened event: previous figures + reason; prior payload preserved", () => {
    const prior = { totalCost: 0, profit: 30.65, marginPct: 100, laborCost: 10, packingCost: 0, shippingCost: 0, outsourceCost: 0, reprintCost: 0, otherCost: 0, finalizedAt: "2026-07-24T12:00:00Z", finalizedBy: "owner@gso.com" };
    const event = presentProductionEvent({ eventType: "actual_cost_reopened", message: `Actual cost REOPENED by owner. Reason: Testing controlled reopen workflow. PRIOR FINAL ${JSON.stringify(prior)}` });
    expect(event.title).toBe("Actual cost reopened");
    expect(event.summaryLines).toContain("Previous final cost: $0.00");
    expect(event.summaryLines).toContain("Previous margin: 100.0%");
    expect(event.summaryLines.join(" ")).toContain("Testing controlled reopen workflow");
    expect(event.auditSections[0].title).toBe("Prior final figures");
    expect(event.rawJson).toContain('"finalizedBy": "owner@gso.com"');
  });

  it("created-job events title by source; plain messages pass through; malformed JSON falls back safely", () => {
    expect(presentProductionEvent({ eventType: "created_from_shopify_order", message: "Production job GSO-1 created from paid Shopify configurator order #1042." }).title).toBe("Production job created (Shopify order)");
    const plain = presentProductionEvent({ eventType: "created_from_quote", message: "Production job GSO-2 created from quote q1 (source erp_quote, family premium-jars)." });
    expect(plain.summaryLines[0]).toContain("created from quote q1");
    const malformed = presentProductionEvent({ eventType: "actual_cost_finalized", message: "Actual cost FINALIZED. SNAPSHOT {broken json" });
    expect(malformed.title).toBe("Actual cost finalized");
    expect(malformed.summaryLines.length).toBeGreaterThan(0); // safe fallback, no crash
    expect(malformed.rawMessage).toContain("{broken json"); // nothing lost
  });

  it("legacy/blank events render a compact summary — never empty label rows", () => {
    const blank = presentProductionEvent({ eventType: "", message: "" });
    expect(blank.legacy).toBe(true);
    expect(blank.summaryLines).toEqual(["Legacy event"]);
    const unknown = presentProductionEvent({ eventType: "mystery_thing", message: "   " });
    expect(unknown.legacy).toBe(true);
    expect(unknown.title).toBe("Mystery thing");
  });
});

describe("historical name display + dry-run assessment (15E.3-D/E)", () => {
  it("malformed historical value displays clean while the stored mock stays unchanged; legit No…/DTP/jar names intact", () => {
    const stored = "NoProduction Test Sticker selected / unknown";
    expect(cleanCommercialName(stored)).toBe("Production Test Sticker");
    expect(stored).toBe("NoProduction Test Sticker selected / unknown"); // display-only
    expect(cleanCommercialName("NoBull Sticker Co")).toBe("NoBull Sticker Co");
    expect(cleanCommercialName("Spektra DTP 4x5x2")).toBe("Spektra DTP 4x5x2");
    expect(cleanCommercialName("150ml Miron jar + lid")).toBe("150ml Miron jar + lid");
    expect(cleanCommercialName("4x5 Blank Bag")).toBe("4x5 Blank Bag");
  });

  it("assessment: corruption pattern = HIGH; placeholder-only = MEDIUM; clean names = none; deterministic and read-only", () => {
    const high = assessCommercialName("NoProduction Test Sticker selected / unknown");
    expect(high.confidence).toBe("high");
    expect(high.cleaned).toBe("Production Test Sticker");
    expect(high.original).toBe("NoProduction Test Sticker selected / unknown"); // original preserved
    expect(assessCommercialName("Not selected / unknown").confidence).toBe("medium");
    expect(assessCommercialName("Production Test Sticker").confidence).toBe("none");
    expect(assessCommercialName("Production Test Sticker").changed).toBe(false);
    // deterministic
    expect(assessCommercialName("NoProduction Test Sticker selected / unknown")).toEqual(high);
  });

  it("dashboard pins: presented events, collapsed audit details, raw-data block, dry-run link, no write methods in the audit path", () => {
    const src = readFileSync(new URL("../app/routes/app.erp.reports-dashboard.tsx", import.meta.url), "utf8");
    expect(src).toContain("presentProductionEvent");
    expect(src).toContain("Show audit details");
    expect(src).toContain("Raw event data");
    expect(src).not.toContain(">Legacy event<"); // legacy text comes from the presenter, not the route
    expect(src).toContain("nameaudit=1");
    expect(src).toContain("DRY RUN");
    expect(src).toContain("nothing was changed");
    const auditBlock = src.slice(src.indexOf('nameaudit') , src.indexOf("Historical Name Audit"));
    for (const banned of ["quoteItem.update", "productionJobItem.update", "updateMany"]) expect(auditBlock).not.toContain(banned);
    const prodSrc = readFileSync(new URL("../app/routes/app.erp.production.tsx", import.meta.url), "utf8");
    expect(prodSrc).toContain("displayTitle: cleanCommercialName(item.productTitle) || item.productTitle");
    expect(prodSrc).toContain("{item.displayTitle || item.productTitle}");
  });
});
