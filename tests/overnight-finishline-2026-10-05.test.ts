// 2026-10-05 OVERNIGHT FINISH-LINE — UI/copy pins for the work done tonight
// (display-only changes; the numeric pins live in the pricing sanity suite).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const calc = readFileSync("app/routes/app.erp.cost-calculator.tsx", "utf8");
const verify = readFileSync("app/routes/app.erp.cost-verification.tsx", "utf8");

describe("PHASE 1 — jar label-count helper derives from the CURRENT quantity", () => {
  it("no hard-coded 128 jar copy remains", () => {
    expect(calc).not.toContain("Side + Lid on 128 jars");
    expect(calc).not.toMatch(/is 128 side labels/);
  });
  it("the helper reads the live quantity field, handles missing quantity neutrally, and never prints NaN", () => {
    expect(calc).toContain("const jarQtyForCopy = (() => {");
    expect(calc).toContain("const n = Number(canonLine.qty);");
    expect(calc).toContain("Number.isFinite(n) && n > 0 ? Math.floor(n) : null");
    expect(calc).toContain("Enter the quantity to see the label counts.");
    expect(calc).toContain("<div style={smallHelp}>{jarLabelCountCopy}</div>");
    // worked examples of the exact wording
    const build = (qty: number | null, sel: { side: boolean; lid: boolean; tamper: boolean }) => {
      const pieces: string[] = [];
      if (sel.side) pieces.push("side label");
      if (sel.lid) pieces.push("lid label");
      if (sel.tamper) pieces.push("tamper band");
      if (!pieces.length) return "Choose a label set: one label of each selected kind is printed and applied per jar.";
      if (qty == null) return `One ${pieces.join(", one ")} per jar. Enter the quantity to see the label counts.`;
      const fmt = (n: number) => n.toLocaleString();
      return `${fmt(qty)} jar${qty === 1 ? "" : "s"}: ${pieces.map((p) => `${fmt(qty)} ${p}${qty === 1 ? "" : "s"}`).join(" + ")}.`;
    };
    expect(build(127, { side: true, lid: true, tamper: false })).toBe("127 jars: 127 side labels + 127 lid labels.");
    expect(build(127, { side: true, lid: false, tamper: false })).toBe("127 jars: 127 side labels.");
    expect(build(127, { side: false, lid: true, tamper: false })).toBe("127 jars: 127 lid labels.");
    expect(build(null, { side: true, lid: true, tamper: false })).toBe("One side label, one lid label per jar. Enter the quantity to see the label counts.");
    expect(build(1, { side: true, lid: false, tamper: false })).toBe("1 jar: 1 side label.");
  });
});

describe("PHASE 5/12 — cost and price are visually separate; legacy diagnostics are secondary", () => {
  it("render order: form -> CANONICAL TRUE COST -> RECOMMENDED CUSTOMER PRICE -> collapsed legacy diagnostics", () => {
    const form = calc.indexOf("<ProductDrivenForm />");
    const cost = calc.indexOf("<CanonicalTrueCost />");
    const price = calc.indexOf("<ProductTiers />");
    const legacy = calc.indexOf("Advanced diagnostics — legacy 14C.2 per-line breakdown (not the job cost)");
    const breakdown = calc.indexOf("<ProductBreakdown />");
    expect(form).toBeGreaterThan(0);
    expect(cost).toBeGreaterThan(form);
    expect(price).toBeGreaterThan(cost);
    expect(legacy).toBeGreaterThan(price);
    expect(breakdown).toBeGreaterThan(legacy);
    expect(calc).toContain("<b style={{ fontSize: 15 }}>RECOMMENDED CUSTOMER PRICE</b>");
    expect(calc).toContain("Customer price is commercial policy; it never changes the true manufacturing cost above.");
  });
  it("the owner-ladder vs floor conflict is shown as OWNER CONFIRMATION PENDING (amber), never green", () => {
    expect(calc).toContain("Owner storefront price for this jar at");
    expect(calc).toContain("OWNER CONFIRMATION PENDING:");
    expect(calc).toContain("ol.raisedByFloor ? \"#fde68a\" : \"#bbf7d0\"");
    expect(calc).toContain("pricingBasis");
    expect(calc).toContain("Owner jar price ladder (16D, approved 2026-08-12) with minimum margin protection");
  });
  it("jar pricing wiring exists in BOTH the loader and the save path (parity)", () => {
    expect(calc.split("ownerLadder: jarLadderFor(qty)").length - 1).toBe(1);
    expect(calc.split("ownerLadder: jarLadderForSave(qty)").length - 1).toBe(1);
    expect(calc.split("applyQuantityBreakEnvelope(").length - 1).toBe(2);
    expect(calc.split("dropSupportRows(").length - 1).toBe(2);
    expect(calc.split("floorPct: floorForFamily,").length - 1).toBe(2);
    expect(calc.split("floorPct: floorForFamilySave,").length - 1).toBe(2);
  });
});

describe("PHASE 15/23 — Cost Verification exposes pricing authorities read-only; shared UI tokens", () => {
  it("Cost Verification lists the jar ladder, margin floors and minimum profit without an editor", () => {
    expect(verify).toContain("Customer pricing authorities");
    expect(verify).toContain("Jar price ladder");
    expect(verify).toContain("Margin protection");
    expect(verify).toContain("Minimum gross profit");
    expect(verify).not.toMatch(/name="jarLadder|name="marginFloor/);
  });
  it("the inline-styled audit routes share one token module", () => {
    for (const file of ["app/routes/app.erp.cost-verification.tsx", "app/routes/app.erp.actual-costs.tsx", "app/routes/app.erp.shopify-cost-audit.tsx"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain('from "../lib/erp-ui-tokens"');
      expect(src, file).not.toMatch(/const cardStyle: React\.CSSProperties = \{ border/);
    }
    const tokens = readFileSync("app/lib/erp-ui-tokens.ts", "utf8");
    // green is reserved for verified/ready/completed
    expect(tokens).toMatch(/READY_TO_QUOTE: \{ label: "READY TO QUOTE", bg: "#ecfdf5"/);
    expect(tokens).toMatch(/OWNER_CONFIRMATION_PENDING: \{ label: "OWNER CONFIRMATION PENDING", bg: "#fffbeb"/);
    expect(tokens).toMatch(/BLOCKED: \{ label: "BLOCKED", bg: "#fef2f2"/);
  });
});

describe("PHASE 29/31 — stale constants fixed without behaviour change", () => {
  it("configurator audit expects the canonical bag MOQ (50), not the retired pilot 64", async () => {
    const src = readFileSync("app/routes/app.erp.configurator-audit.tsx", "utf8");
    expect(src).toContain("const STOCK_BAG_MIN_QTY = 50;");
    expect(src).not.toContain("const STOCK_BAG_MIN_QTY = 64;");
    const bags = await import("../app/lib/bag-cost-inputs.server");
    expect(bags.STOCK_BAG_MOQ).toBe(50);
    expect(bags.STICKER_BAG_MOQ).toBe(50);
  });
  it("the canonical engine reads the approved Poseidon roll cost instead of re-typed arithmetic (identical value)", async () => {
    const src = readFileSync("app/lib/canonical-calculator.server.ts", "utf8");
    expect(src).toContain("const LABEL_MEDIA_PER_SQFT = APPROVED_ROLL_COSTS.poseidonMattePerSqft;");
    expect(src).not.toContain("const LABEL_MEDIA_PER_SQFT = 213 / ((54 / 12) * 150);");
    const approved = await import("../app/lib/approved-cost-updates.server");
    expect(approved.APPROVED_ROLL_COSTS.poseidonMattePerSqft).toBeCloseTo(213 / ((54 / 12) * 150), 12);
  });
});
