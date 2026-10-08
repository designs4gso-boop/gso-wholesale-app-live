// FINAL OWNER DECISIONS — 2026-10-07 release-candidate lock.
// Pins: the five approved DTP ladders + steps + 25,000 / above-25,000 rule,
// acquisition economics per size, the QC-PASS-before-completion guard,
// Mimaki CMYK-only, 5x4x2 manual review, and the source wiring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DTP_ACQUISITION_TIER_EXCEPTIONS,
  DTP_LADDER_QUANTITIES,
  DTP_LADDER_SOURCES,
  DTP_MAX_APPROVED_QUANTITY,
  DTP_MIN_JOB_PROFIT,
  DTP_OWNER_PRICE_LADDERS,
  ownerPriceForQuantity,
  priceDtpQuote,
} from "../app/lib/dtp-owner-pricing.server";
import { DTP_MAX_VENDOR_TIER_QUANTITY, resolveDtpQuoteCost } from "../app/lib/dtp-quote-cost-authority.server";
import { dtpSizeForVendorSku } from "../app/lib/dtp-catalog";
import { priceDtpConfiguration } from "../app/lib/canonical-dtp-pricing.server";
import { QC_PASS_REQUIRED_MESSAGE, completionGuardApplies, evaluateQcForCompletion, qcEventItemKey, qcResultOf } from "../app/lib/production-qc-guard";
import { decideMachine } from "../app/lib/print-intake-routing.server";
import { DTP_SHAPED_MOQ, applyShapedPolicyToDtpRow, priceShapedPouch, toolingForShapes } from "../app/lib/dtp-shaped-bag-policy";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SOFT_TOUCH = { material: "White PET", finish: "Soft Touch", spot: "None", zipper: "Child Resistant", topFeature: "No Tear Notch", clearGusset: false };
const legacy = { totalCost: 0, missing: true, vendorSubtotal: null };

const APPROVED: Record<string, Record<number, number>> = {
  "spektra-dtp-3.5x4.5x2": { 1000: 1.3, 2500: 0.7, 5000: 0.45, 10000: 0.36, 25000: 0.29 },
  "spektra-dtp-4x5x2": { 1000: 1.3, 2500: 0.71, 5000: 0.46, 10000: 0.37, 25000: 0.3 },
  "spektra-dtp-5x5x2": { 1000: 1.35, 2500: 0.75, 5000: 0.49, 10000: 0.41, 25000: 0.35 },
  "spektra-dtp-6x5x2": { 1000: 1.4, 2500: 0.78, 5000: 0.54, 10000: 0.46, 25000: 0.4 },
  "spektra-dtp-8x5x2": { 1000: 1.5, 2500: 0.86, 5000: 0.65, 10000: 0.59, 25000: 0.52 },
};

describe("A. final current DTP ladders (OWNER APPROVED 2026-10-07)", () => {
  it("pins every size at every tier", () => {
    expect(DTP_LADDER_QUANTITIES).toEqual([1000, 2500, 5000, 10000, 25000]);
    for (const [sku, ladder] of Object.entries(APPROVED)) {
      expect(DTP_OWNER_PRICE_LADDERS[sku], sku).toEqual(ladder);
      expect(DTP_LADDER_SOURCES[sku].status).toBe("OWNER_APPROVED");
      expect(DTP_LADDER_SOURCES[sku].marketBenchmark).toBe("DESIGN_AND_CUSTOMIZE_PRIMARY");
      expect(DTP_LADDER_SOURCES[sku].requestQuoteAboveQuantity).toBe(25000);
      expect(dtpSizeForVendorSku(sku)?.quoteCostAuthority).toBe("LIVE_COST_BOOK");
    }
    expect(DTP_MAX_APPROVED_QUANTITY).toBe(25000);
  });

  it("B. commercial quantity steps: 2,499 / 2,500 / 4,999 / 5,000 / 9,999 / 10,000 / 24,999 / 25,000 / 25,001 for every size", () => {
    for (const [sku, ladder] of Object.entries(APPROVED)) {
      const p = (q: number) => ownerPriceForQuantity(sku, q);
      expect(p(1000).unitPrice, sku).toBe(ladder[1000]);
      expect(p(2499).unitPrice).toBe(ladder[1000]);
      expect(p(2500).unitPrice).toBe(ladder[2500]);
      expect(p(4999).unitPrice).toBe(ladder[2500]);
      expect(p(5000).unitPrice).toBe(ladder[5000]);
      expect(p(7500).unitPrice).toBe(ladder[5000]);
      expect(p(9999).unitPrice).toBe(ladder[5000]);
      expect(p(10000).unitPrice).toBe(ladder[10000]);
      expect(p(24999).unitPrice).toBe(ladder[10000]);
      expect(p(25000)).toMatchObject({ tierUsed: 25000, unitPrice: ladder[25000] });
      const above = p(25001);
      expect(above.unitPrice).toBeNull();
      expect(above.reviewRequired).toContain("REQUEST CURRENT VENDOR QUOTE");
      expect(p(999).unitPrice).toBeNull();
    }
  });

  it("above 25,000 the vendor row is never extended and the quote is BLOCKED; exactly 25,000 is costed and READY", () => {
    expect(DTP_MAX_VENDOR_TIER_QUANTITY).toBe(25000);
    const at25k = resolveDtpQuoteCost({ vendorSku: "spektra-dtp-4x5x2", quantity: 25000, designs: 1, selection: SOFT_TOUCH, legacy });
    expect(at25k.status).toBe("OBSERVED_VENDOR_PRICE");
    const q25 = priceDtpQuote({ ladderSku: "spektra-dtp-4x5x2", quantity: 25000, landedCost: at25k.landedCost, missingCost: at25k.missing, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(q25.unitPrice).toBe(0.3);
    expect(q25.status).toBe("READY");
    const above = resolveDtpQuoteCost({ vendorSku: "spektra-dtp-4x5x2", quantity: 25001, designs: 1, selection: SOFT_TOUCH, legacy });
    expect(above.status).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
    expect(above.missing).toBe(true);
    const qAbove = priceDtpQuote({ ladderSku: "spektra-dtp-4x5x2", quantity: 25001, landedCost: 0, missingCost: above.missing, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
    expect(qAbove.status).toBe("BLOCKED");
  });

  it("C. 1,000 acquisition tiers: every size passes the $350 exception on live landed cost; 2,500+ keeps $500 and READY", () => {
    const expected: Record<string, { gp: number; gm: number }> = {
      "spektra-dtp-3.5x4.5x2": { gp: 458.7, gm: 35.3 },
      "spektra-dtp-4x5x2": { gp: 439.3, gm: 33.8 },
      "spektra-dtp-5x5x2": { gp: 447.0, gm: 33.1 },
      "spektra-dtp-6x5x2": { gp: 457.7, gm: 32.7 },
      "spektra-dtp-8x5x2": { gp: 465.8, gm: 31.1 },
    };
    for (const sku of Object.keys(APPROVED)) {
      expect(DTP_ACQUISITION_TIER_EXCEPTIONS[sku]).toMatchObject({ tier: 1000, minJobProfit: 350 });
      const cost = resolveDtpQuoteCost({ vendorSku: sku, quantity: 1000, designs: 1, selection: SOFT_TOUCH, legacy });
      expect(cost.status, sku).toBe("OBSERVED_VENDOR_PRICE");
      const q = priceDtpQuote({ ladderSku: sku, quantity: 1000, landedCost: cost.landedCost, missingCost: cost.missing, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
      expect(q.status, sku).toBe("READY");
      expect(q.minJobProfit).toBe(350);
      expect(q.grossProfit).toBeCloseTo(expected[sku].gp, 0);
      expect(q.grossMarginPct).toBeCloseTo(expected[sku].gm, 0);
      expect(q.grossMarginPct).toBeGreaterThanOrEqual(30);
      for (const qty of [2500, 5000, 10000, 25000]) {
        const c = resolveDtpQuoteCost({ vendorSku: sku, quantity: qty, designs: 1, selection: SOFT_TOUCH, legacy });
        const qq = priceDtpQuote({ ladderSku: sku, quantity: qty, landedCost: c.landedCost, missingCost: c.missing, designs: 1, customUnitPrice: null, repeatOrder: false, passThroughFreight: false, freightAmount: 85, override: { phrase: "", reason: "" } });
        expect(qq.minJobProfit, `${sku}@${qty}`).toBe(DTP_MIN_JOB_PROFIT);
        expect(qq.status, `${sku}@${qty}`).toBe("READY");
        expect(qq.grossMarginPct).toBeGreaterThanOrEqual(qq.hardFloorPct);
      }
    }
    // the exception never leaks to a non-DTP ladder or to 5x4x2
    expect(DTP_ACQUISITION_TIER_EXCEPTIONS["spektra-dtp-5x4x2"]).toBeUndefined();
  });

  it("5x4x2 stays legacy: manual / vendor review in the calculator and the storefront adapter", () => {
    const cost = resolveDtpQuoteCost({ vendorSku: "spektra-dtp-5x4x2", quantity: 2500, designs: 1, selection: {}, legacy: { totalCost: 1448.08, missing: false, vendorSubtotal: 1354.75 } });
    expect(cost.status).toBe("LEGACY_MANUAL_REVIEW");
    expect(cost.missing).toBe(true);
    expect(dtpSizeForVendorSku("spektra-dtp-5x4x2")?.status).toBe("LEGACY_NO_CURRENT_STANDARD_CATALOG_MATCH");
    const sf = priceDtpConfiguration({ productType: "dtp_5x4x2", quantity: 2500 });
    expect(sf.ok).toBe(false);
    for (const type of ["dtp_3_5x4_5x2", "dtp_5x5x2", "dtp_6x5x2", "dtp_8x5x2"]) {
      const r = priceDtpConfiguration({ productType: type, quantity: 2500 });
      expect(r.ok, type).toBe(true);
    }
  });
});

describe("D. shaped (unchanged)", () => {
  it("MOQ 2,500; +10% on product only; one $700 per unique die; $0 reuse", () => {
    expect(DTP_SHAPED_MOQ).toBe(2500);
    expect(priceShapedPouch({ shape: "custom", quantity: 1000, standardProductTotal: 1300, die: { mode: "new" } }).errors.join(" ")).toContain("2,500");
    const row = applyShapedPolicyToDtpRow({ quantity: 2500, shape: "custom", die: { mode: "new" }, ladderUnitPrice: 0.71, customerBaseSubtotal: 1775, extraDesignFees: 0, customerTotal: 1775, grossProfit: 723 });
    expect(row.unitPrice).toBeCloseTo(0.781, 9);
    expect(row.shaped.toolingFee).toBe(700);
    expect(row.totalPrice).toBe(1775 + 177.5 + 700);
    expect(toolingForShapes([{ shapeKey: "A", die: { mode: "new" }, designs: 4 }, { shapeKey: "A", die: { mode: "new" } }]).toolingFee).toBe(700);
    expect(toolingForShapes([{ shapeKey: "A", die: { mode: "new" } }, { shapeKey: "B", die: { mode: "new" } }]).toolingFee).toBe(1400);
    expect(toolingForShapes([{ shapeKey: "A", die: { mode: "existing", dieId: "DIE-1" } }]).toolingFee).toBe(0);
  });
});

describe("E. production: QC PASS REQUIRED BEFORE COMPLETION", () => {
  const items = [{ id: "i1", itemTicket: "GSO-20261007-0001-01", productTitle: "4x5 pouch" }, { id: "i2", itemTicket: "GSO-20261007-0001-02", productTitle: "Labels" }];
  const ev = (eventType: string, oldValue: string | null, newValue: string | null, at: string, message = "") => ({ eventType, oldValue, newValue, createdAt: at, message });

  it("guard applies only when moving INTO completed", () => {
    expect(completionGuardApplies("qc", "completed")).toBe(true);
    expect(completionGuardApplies("new", "completed")).toBe(true);
    expect(completionGuardApplies("completed", "completed")).toBe(false); // already completed: never re-checked
    expect(completionGuardApplies("completed", "shipped")).toBe(false); // historical completed jobs move on freely
    for (const to of ["prepress", "proof_sent", "printing", "cutting", "qc", "packing", "ready_for_pickup", "shipped", "on_hold", "cancelled"]) expect(completionGuardApplies("new", to), to).toBe(false);
  });

  it("refuses with the staff message when any item has no PASS, or its latest result is HOLD / REPRINT", () => {
    const none = evaluateQcForCompletion(items, []);
    expect(none.ok).toBe(false);
    expect(none.message).toContain(QC_PASS_REQUIRED_MESSAGE);
    expect(none.missing).toEqual(["GSO-20261007-0001-01", "GSO-20261007-0001-02"]);
    const onePass = evaluateQcForCompletion(items, [ev("qc_result", "GSO-20261007-0001-01", "pass", "2026-10-07T10:00:00Z")]);
    expect(onePass.ok).toBe(false);
    expect(onePass.missing).toEqual(["GSO-20261007-0001-02"]);
    const bothPass = evaluateQcForCompletion(items, [ev("qc_result", "GSO-20261007-0001-01", "pass", "2026-10-07T10:00:00Z"), ev("qc_result", "GSO-20261007-0001-02", "pass", "2026-10-07T10:01:00Z")]);
    expect(bothPass.ok).toBe(true);
    const laterHold = evaluateQcForCompletion(items, [ev("qc_result", "GSO-20261007-0001-01", "pass", "2026-10-07T10:00:00Z"), ev("qc_result", "GSO-20261007-0001-02", "pass", "2026-10-07T10:01:00Z"), ev("qc_result", "GSO-20261007-0001-02", "hold", "2026-10-07T11:00:00Z")]);
    expect(laterHold.ok).toBe(false);
    expect(laterHold.notPassed).toEqual(["GSO-20261007-0001-02"]);
    const repass = evaluateQcForCompletion(items, [ev("qc_result", "GSO-20261007-0001-01", "pass", "2026-10-07T10:00:00Z"), ev("qc_result", "GSO-20261007-0001-02", "reprint_required", "2026-10-07T10:01:00Z"), ev("qc_result", "GSO-20261007-0001-02", "pass", "2026-10-07T12:00:00Z")]);
    expect(repass.ok).toBe(true);
  });

  it("understands historical QC rows (message-only identity) and the twin event rows without double counting", () => {
    const hist = [
      { eventType: "production_run_qc_passed", oldValue: null, newValue: null, createdAt: "2026-09-01T10:00:00Z", message: "QC PASS for GSO-20261007-0001-01 (run R1-P0-A1) by Sam." },
      { eventType: "production_run_qc_passed", oldValue: null, newValue: null, createdAt: "2026-09-01T10:05:00Z", message: "QC PASS for Labels (run R1-P0-A1) by Sam." },
    ];
    expect(qcResultOf(hist[0] as any)).toBe("pass");
    expect(qcEventItemKey(hist[0] as any)).toBe("gso-20261007-0001-01");
    expect(evaluateQcForCompletion(items, hist).ok).toBe(true);
    const twins = [
      ev("production_run_qc_passed", "GSO-20261007-0001-01", "pass", "2026-10-07T10:00:00Z"), ev("qc_result", "GSO-20261007-0001-01", "pass", "2026-10-07T10:00:00Z"),
      ev("production_run_qc_hold", "GSO-20261007-0001-02", "hold", "2026-10-07T10:01:00Z"), ev("qc_result", "GSO-20261007-0001-02", "hold", "2026-10-07T10:01:00Z"),
    ];
    const v = evaluateQcForCompletion(items, twins);
    expect(v.ok).toBe(false);
    expect(v.passCount).toBe(1);
    expect(v.items.map((i) => i.latest)).toEqual(["pass", "hold"]);
    // a job without item rows needs at least one PASS and the latest result must be PASS
    expect(evaluateQcForCompletion([], [ev("qc_result", null, "pass", "2026-10-07T10:00:00Z")]).ok).toBe(true);
    expect(evaluateQcForCompletion([], [ev("qc_result", null, "pass", "2026-10-07T10:00:00Z"), ev("qc_result", null, "hold", "2026-10-07T11:00:00Z")]).ok).toBe(false);
    expect(evaluateQcForCompletion([], []).ok).toBe(false);
  });

  it("the Production Board and the calendar both call the guard before writing completed", () => {
    for (const file of ["app/routes/app.erp.production.tsx", "app/routes/app.erp.production-calendar.tsx"]) {
      const s = src(file);
      expect(s, file).toContain("completionGuardApplies(job.status, status)");
      expect(s, file).toContain("evaluateQcForCompletion(items, events)");
      expect(s, file).toMatch(/if \(!verdict\.ok\) return Response\.json\(\{ ok: false, message: verdict\.message \}, \{ status: 400 \}\)/);
    }
  });
});

describe("F. routing: Mimaki CMYK only, Roland for white / gloss (unchanged authority)", () => {
  it("decideMachine routes white / gloss to the Roland and CMYK to the Mimaki by default; the Mimaki preset exposes no white channel", () => {
    const roland = decideMachine({ selectedFinish: "White + CMYK", materialSummary: "white ink layer", machineSummary: null } as any);
    expect(String(roland.machine)).toMatch(/roland/i);
    const gloss = decideMachine({ selectedFinish: "Gloss", materialSummary: "spot gloss", machineSummary: null } as any);
    expect(String(gloss.machine)).toMatch(/roland/i);
    const cmyk = decideMachine({ selectedFinish: "CMYK", materialSummary: "standard cmyk", machineSummary: null } as any);
    expect(String(cmyk.machine)).toMatch(/mimaki/i);
    const machines = src("app/routes/app.erp.machines.tsx");
    expect(machines).not.toMatch(/inkName: "White", inkType: "white", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE/);
    expect(machines).toContain('inkName: "Unused - white routed to Roland"');
  });
});

describe("G/H. remaining wiring pins", () => {
  it("seed tool for the two new sizes exists and is additive; wizard + walkthrough state the agent safety posture; wholesale applications are shop-scoped", () => {
    const seed = src("tools/seed-spektra-dtp-current-sizes-2026-10-07.mjs");
    expect(seed).toContain('vendorSku: "spektra-dtp-3.5x4.5x2"');
    expect(seed).toContain('vendorSku: "spektra-dtp-5x5x2"');
    expect(seed).not.toMatch(/deleteMany\(\{ where: \{ shop \} \}\)/);
    expect(src("app/routes/app.erp.setup-wizard.tsx")).toContain("Safety posture: agent reasoning OFF");
    expect(src("app/routes/app.erp.walkthrough.tsx")).toContain("8b. Agent safety posture");
    const customers = src("app/routes/app.wholesale.customers.tsx");
    expect(customers).toContain("where: { id, shop: session.shop }");
    expect(customers).toContain("Open Quotes / CRM");
    expect(src("app/routes/app.erp.ops-hub.tsx")).toContain("this card is kept as the historical test record");
  });
});
