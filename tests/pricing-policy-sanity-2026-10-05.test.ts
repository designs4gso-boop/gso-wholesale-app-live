// 2026-10-05 OVERNIGHT — PRICING POLICY SANITY SUITE.
//
// Reusable commercial-pricing sanity checks on top of UNCHANGED true
// manufacturing cost. For the jar families the engine now prices from the
// owner-approved 16D ladder with minimum-margin protection and a
// quantity-break envelope; this suite walks EVERY integer quantity in the
// supported range and asserts the commercial invariants. Other canonical
// families are audited (price >= cost, margin >= floor, no negative profit)
// and their quantity cliffs are REPORTED, not changed.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assembleCanonicalJob, canonicalInputForQuantity, normalizeCanonicalInput, type ResolvedMachineInputs } from "../app/lib/canonical-calculator.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { computeCommercialPrice, defaultPricingPolicyValues, marginCurveConfigFor, resolveMarginPctForQuantity } from "../app/lib/commercial-pricing-policy.server";
import { MARGIN_FLOOR_PCT, PROVISIONAL_MARGIN_CURVE, resolveMarginFamily, type FamilyMarginRule } from "../app/lib/calculator-emergency.server";
import { JAR_PRICE_BREAK_SUPPORT_QUANTITIES, applyQuantityBreakEnvelope, dropSupportRows, resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { JAR_BASE_PRICES } from "../app/lib/canonical-jar-pricing";
import { ACTIVE_JAR_PROFILES } from "../app/lib/jar-active-scope";

const CAL: ResolvedMachineInputs = {
  calibration: {
    id: "cal_test", shop: "test", machineKey: "mimaki-ucjv300-130", inkMode: "cmyk",
    ripProfile: "p", qualityMode: "q", resolution: "r", passConfig: "1x",
    mlPerSqftPerPass: 1.89, inkAreaBasis: "inkable_artwork", minutesPerSqft: 1.444, timeAreaBasis: "rip_layout",
    fixedMinutes: 0, timeModel: "variable_only", coverageBasisPct: 100,
    measuredAt: new Date(0), effectiveFrom: new Date(0), effectiveTo: null,
    status: "approved", source: "owner-measured", notes: null, supersedesId: null,
  } as any,
  calibrationMessage: "approved",
  inkCostPerMl: CANONICAL_INK_RATES.mimakiCmykPerMl,
  inkCostSource: "canonical purchasing rate",
};
const POLICY = defaultPricingPolicyValues();
const provisionalRule: FamilyMarginRule = { key: "provisional-universal", label: "Provisional universal curve", curve: [...PROVISIONAL_MARGIN_CURVE], familyMinPct: MARGIN_FLOOR_PCT, aliases: [] };

type Row = { quantity: number; jobCost: number | null; unitCost: number | null; totalPrice: number | null; unitPrice: number | null; profit: number | null; actualMarginPct: number | null; marginPct: number | null; floorPct?: number; draftOnly: boolean; requested: boolean; supportRow: boolean; commercial: any; status: string };

/** Mirrors the calculator loader's per-row pricing for a canonical family (no freight extras, no overrides). */
function priceRows(opts: { base: string; family: "premium-jars" | "standard-jars" | "sticker-bags" | "stock-bags" | "stickers-labels" | "banners"; curveKey: string | null; quantities: number[]; requested: number; ladder: (qty: number) => { unitPrice: number; source: string; label: string } | null; display: Set<number> }): Row[] {
  const input0 = normalizeCanonicalInput(new URLSearchParams(opts.base));
  expect(input0, opts.base).not.toBeNull();
  const rule = opts.curveKey ? resolveMarginFamily(opts.curveKey) ?? provisionalRule : provisionalRule;
  const floorPct = Math.max(marginCurveConfigFor(POLICY, opts.curveKey)?.familyMinPct ?? rule.familyMinPct, MARGIN_FLOOR_PCT);
  const rows = opts.quantities.map((qty) => {
    const scaled = canonicalInputForQuantity(input0!, qty);
    const r = scaled ? assembleCanonicalJob(scaled, CAL) : null;
    if (!r || r.status === "DRAFT_ONLY" || r.unitCost == null) {
      return { quantity: qty, jobCost: null, unitCost: null, totalPrice: null, unitPrice: null, profit: null, actualMarginPct: null, marginPct: null, draftOnly: true, requested: qty === opts.requested, supportRow: !opts.display.has(qty), commercial: null, status: "BLOCKED" } as Row;
    }
    const c = computeCommercialPrice({ familyKey: opts.family, quantity: qty, completeCost: r.totalCost, marginRule: rule, premiumEligible: false, policyValues: POLICY, marginCurveKey: opts.curveKey, ownerLadder: opts.ladder(qty) });
    return {
      quantity: qty, jobCost: r.totalCost, unitCost: r.unitCost, totalPrice: c.finalTotalPrice, unitPrice: c.finalUnitPrice, profit: c.achievedProfit, actualMarginPct: c.achievedMarginPct,
      marginPct: c.marginPctApplied, floorPct, draftOnly: false, requested: qty === opts.requested, supportRow: !opts.display.has(qty),
      commercial: { controllingRule: c.controllingRule, ownerLadder: c.ownerLadder ?? null, marginSource: c.marginSource },
      status: c.marginPctApplied < floorPct ? "BELOW FLOOR — override required" : "READY TO QUOTE",
    } as Row;
  });
  return rows;
}

const LADDER = [64, 128, 256, 640, 1000];
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_v, i) => a + i);

/** The route-equivalent price for ONE requested quantity: ladder + support rows + requested, envelope, hide support rows. */
function routePriceFor(opts: Omit<Parameters<typeof priceRows>[0], "quantities" | "display" | "requested">, requested: number, supportRows: boolean) {
  const quantities = [...new Set([...LADDER, ...(supportRows ? JAR_PRICE_BREAK_SUPPORT_QUANTITIES : []), requested])].sort((a, b) => a - b);
  const display = new Set([...LADDER, requested]);
  const rows = priceRows({ ...opts, quantities, display, requested });
  const final = dropSupportRows(supportRows ? applyQuantityBreakEnvelope(rows) : rows);
  return final.find((r) => r.quantity === requested)!;
}

const jarLadder = (brand: string, size: string) => (qty: number) => {
  const r = resolveJarOwnerLadder({ brand, sizeKey: size, quantity: qty });
  return r.ok ? { unitPrice: r.quote.unitPrice, source: r.quote.source, label: r.quote.label } : null;
};
const MIRON_100T = { base: "pfamily=premium-jars&pqty=128&pjar=miron/100ml_tall&pjarside=1&pjarlid=1&pprinter=auto&pwhitelayers=0&pglosslayers=0", family: "premium-jars" as const, curveKey: "miron-jars", ladder: jarLadder("miron", "100ml_tall") };

const auditLines: string[] = [];
const fmt = (n: number | null, d = 2) => (n == null ? "—" : n.toFixed(d));

describe("owner jar ladder resolution", () => {
  it("maps engine sizes to the 16D ladder and refuses what the owner never priced", () => {
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_tall", quantity: 128 })).toMatchObject({ ok: true, quote: { unitPrice: 4.5, basePrice: 4.5, tierMinQty: 100, launchSize: "100ml" } });
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_wide", quantity: 50 })).toMatchObject({ ok: true, quote: { unitPrice: 4.95 } });
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "150ml", quantity: 500 })).toMatchObject({ ok: true, quote: { unitPrice: 5.5 } });
    expect(resolveJarOwnerLadder({ brand: "standard", sizeKey: "3oz", quantity: 1000 })).toMatchObject({ ok: true, quote: { unitPrice: 1.45 } });
    expect(resolveJarOwnerLadder({ brand: "chiron", sizeKey: "150ml", quantity: 500 })).toMatchObject({ ok: false, reason: "NO_OWNER_LADDER" });
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_tall", quantity: 49 })).toMatchObject({ ok: false, reason: "BELOW_LADDER_MINIMUM" });
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_tall", quantity: 5000 })).toMatchObject({ ok: false, reason: "VOLUME_QUOTE" });
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_tall", quantity: 128, specialtyX: 9 })).toMatchObject({ ok: false, reason: "DEEP_BUILD" });
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_tall", quantity: 128, holographic: true, specialtyX: 2 })).toMatchObject({ ok: true, quote: { unitPrice: 4.5 + 0.9 + 0.5, holoAdd: 0.9, specialtyAdd: 0.5 } });
    expect(resolveJarOwnerLadder({ brand: "miron", sizeKey: "5oz", quantity: 128 })).toMatchObject({ ok: false, reason: "NO_OWNER_LADDER" });
  });

  it("the ladder tables are the owner's 16D values (never regenerated)", () => {
    expect(JAR_BASE_PRICES["100ml"].map((t) => t.priceEach)).toEqual([4.95, 4.5, 4.0, 3.75, 3.5, 3.35]);
    expect(JAR_BASE_PRICES["150ml"].map((t) => t.priceEach)).toEqual([6.5, 6.0, 5.75, 5.5, 5.25, 4.95]);
  });
});

describe("computeCommercialPrice in owner-ladder mode", () => {
  it("ladder price controls when above the floor; floor controls when the ladder is below it; curve is never consulted", () => {
    const high = computeCommercialPrice({ familyKey: "premium-jars", quantity: 100, completeCost: 100, marginRule: resolveMarginFamily("miron-jars"), premiumEligible: false, policyValues: POLICY, marginCurveKey: "miron-jars", ownerLadder: { unitPrice: 4.5, source: "s", label: "Owner ladder" } });
    expect(high.finalTotalPrice).toBe(450);
    expect(high.controllingRule).toBe("Owner ladder");
    expect(high.ownerLadder).toMatchObject({ controls: true, raisedByFloor: false, floorPct: 45 });
    const low = computeCommercialPrice({ familyKey: "premium-jars", quantity: 100, completeCost: 400, marginRule: resolveMarginFamily("miron-jars"), premiumEligible: false, policyValues: POLICY, marginCurveKey: "miron-jars", ownerLadder: { unitPrice: 4.5, source: "s", label: "Owner ladder" } });
    expect(low.finalTotalPrice).toBeCloseTo(400 / 0.55, 6);
    expect(low.controllingRule).toMatch(/Minimum margin protection — 45%/);
    expect(low.marginPctApplied).toBe(45); // not 65 — the curve is not used
    expect(low.ownerLadder).toMatchObject({ controls: false, raisedByFloor: true, unitPrice: 4.5, totalPrice: 450 });
    expect(low.ownerLadder!.ladderMarginPct).toBeCloseTo(((450 - 400) / 450) * 100, 6);
  });

  it("without a ladder the existing curve behaviour is byte-identical", () => {
    const a = computeCommercialPrice({ familyKey: "premium-jars", quantity: 128, completeCost: 430.0861, marginRule: resolveMarginFamily("miron-jars"), premiumEligible: false, policyValues: POLICY, marginCurveKey: "miron-jars" });
    const b = computeCommercialPrice({ familyKey: "premium-jars", quantity: 128, completeCost: 430.0861, marginRule: resolveMarginFamily("miron-jars"), premiumEligible: false, policyValues: POLICY, marginCurveKey: "miron-jars", ownerLadder: null });
    expect(b).toEqual(a);
    expect(a.finalUnitPrice).toBeCloseTo(8.0, 2); // the old live price, still reproducible for Chiron-style curve pricing
    expect(a.ownerLadder).toBeNull();
  });

  it("a staff per-tier margin override still wins over the ladder (existing gate semantics)", () => {
    const r = computeCommercialPrice({ familyKey: "premium-jars", quantity: 100, completeCost: 100, marginRule: resolveMarginFamily("miron-jars"), premiumEligible: false, policyValues: POLICY, marginCurveKey: "miron-jars", marginPctOverride: 50, ownerLadder: { unitPrice: 4.5, source: "s", label: "Owner ladder" } });
    expect(r.marginPctApplied).toBe(50);
    expect(r.finalTotalPrice).toBeCloseTo(200, 6);
  });
});

describe("quantity-break envelope", () => {
  it("caps a row at any cheaper higher-quantity row, never raises, skips blocked rows, does not mutate", () => {
    const rows = [
      { quantity: 127, totalPrice: 1220, unitPrice: 1220 / 127, profit: 793, actualMarginPct: 65, jobCost: 427, draftOnly: false, commercial: { controllingRule: "curve" } },
      { quantity: 128, totalPrice: 1024, unitPrice: 8, profit: 594, actualMarginPct: 58, jobCost: 430, draftOnly: false, commercial: { controllingRule: "curve" } },
      { quantity: 256, totalPrice: null, unitPrice: null, profit: null, actualMarginPct: null, jobCost: null, draftOnly: true, commercial: null },
      { quantity: 640, totalPrice: 3000, unitPrice: 4.6875, profit: 1000, actualMarginPct: 33, jobCost: 2000, draftOnly: false, commercial: { controllingRule: "curve" } },
    ];
    const snapshot = JSON.stringify(rows);
    const out = applyQuantityBreakEnvelope(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(out[0]).toMatchObject({ quantity: 127, totalPrice: 1024, envelopeCappedTo: 128 });
    expect(out[0].unitPrice).toBeCloseTo(1024 / 127, 9);
    expect(out[0].profit).toBeCloseTo(1024 - 427, 9);
    expect(out[0].commercial!.controllingRule).toMatch(/capped at the next quantity break/);
    expect(out[1]).toMatchObject({ quantity: 128, totalPrice: 1024, envelopeCappedTo: null });
    expect(out[2]).toMatchObject({ quantity: 256, draftOnly: true, envelopeCappedTo: null });
    expect(out[3]).toMatchObject({ quantity: 640, totalPrice: 3000, envelopeCappedTo: null });
  });
});

describe("Miron 100ml Tall — every integer quantity 50..1000 (Side + Lid)", () => {
  const quantities = [...new Set([...LADDER, ...JAR_PRICE_BREAK_SUPPORT_QUANTITIES, ...range(50, 1000)])].sort((a, b) => a - b);
  const display = new Set(quantities); // price everything; envelope over the full set
  const rows = dropSupportRows(applyQuantityBreakEnvelope(priceRows({ ...MIRON_100T, quantities, display, requested: 128 })));
  const priced = rows.filter((r) => !r.draftOnly);

  it("every quantity prices (no blocked rows in the supported range)", () => {
    expect(priced.length).toBe(rows.length);
  });

  it("price >= true cost, profit > 0, realized margin >= the 45% Miron family minimum, status READY TO QUOTE", () => {
    for (const r of priced) {
      expect(r.totalPrice!, `qty ${r.quantity}`).toBeGreaterThanOrEqual(r.jobCost! - 1e-9);
      expect(r.profit!, `qty ${r.quantity}`).toBeGreaterThan(0);
      expect(r.actualMarginPct!, `qty ${r.quantity}`).toBeGreaterThanOrEqual(45 - 1e-9);
      expect(r.status, `qty ${r.quantity}`).toBe("READY TO QUOTE");
    }
  });

  it("TOTAL price never decreases when quantity increases by one, except where the margin floor binds at a vendor cost tier (reported, never below floor)", () => {
    const residual: string[] = [];
    for (let i = 1; i < priced.length; i += 1) {
      const a = priced[i - 1], b = priced[i];
      if (b.totalPrice! < a.totalPrice! - 1e-6) {
        // allowed ONLY when the lower-quantity row is pinned to its margin floor and flagged
        expect((a as any).envelopeFloorBound, `qty ${a.quantity} -> ${b.quantity}: total fell without a floor-bound flag`).toBe(true);
        expect(a.actualMarginPct!, `qty ${a.quantity}`).toBeCloseTo(45, 6);
        residual.push(`${a.quantity}->${b.quantity}: ${fmt(a.totalPrice)} -> ${fmt(b.totalPrice)} (cheaper to order ${(a as any).cheaperQuantity})`);
      }
    }
    auditLines.push("", "Residual steps where the 45% floor binds at a Miron blank cost tier (staff are told the larger order is cheaper): " + (residual.length ? residual.join("; ") : "none"));
  });

  it("no cliff: the 127 -> 128 margin-band edge no longer changes the price, and no step changes the unit price by more than 15%", () => {
    for (let i = 1; i < priced.length; i += 1) {
      const a = priced[i - 1].unitPrice!, b = priced[i].unitPrice!;
      // unit price may tick UP only by a packout box step (<= 2%), never a margin-band jump
      expect(b, `qty ${priced[i].quantity}`).toBeLessThanOrEqual(a * 1.02 + 1e-9);
      expect(Math.abs(b - a) / a, `qty ${priced[i].quantity}`).toBeLessThan(0.15);
    }
  });

  it("the route-equivalent computation (ladder + support rows + requested) agrees with the full walk at every quantity", () => {
    for (const qty of [50, 64, 99, 100, 127, 128, 129, 249, 250, 256, 499, 500, 639, 640, 999, 1000]) {
      const route = routePriceFor(MIRON_100T, qty, true);
      const full = priced.find((r) => r.quantity === qty)!;
      expect(route.totalPrice!, `qty ${qty}`).toBeCloseTo(full.totalPrice!, 6);
    }
  });

  it("127 vs 128: the cliff is gone (127 total <= 128 total; unit prices within a few cents)", () => {
    const r127 = priced.find((r) => r.quantity === 127)!;
    const r128 = priced.find((r) => r.quantity === 128)!;
    expect(r127.totalPrice!).toBeLessThanOrEqual(r128.totalPrice! + 1e-6);
    expect(Math.abs(r127.unitPrice! - r128.unitPrice!)).toBeLessThan(0.05);
    expect(r127.actualMarginPct!).toBeGreaterThanOrEqual(45 - 1e-9);
    // the old curve numbers are gone
    expect(r128.unitPrice!).toBeLessThan(8.0 - 0.5);
    expect(r127.unitPrice!).toBeLessThan(9.0);
  });

  it("audit table for the requested quantities (written to docs/generated)", () => {
    const want = [64, 100, 127, 128, 129, 250, 256, 500, 640, 1000];
    auditLines.push("| qty | true unit cost | true job cost | owner ladder $/jar | recommended unit price | total | gross profit | gross margin | pricing source |", "|---|---|---|---|---|---|---|---|---|");
    for (const qty of want) {
      const r = priced.find((x) => x.quantity === qty)!;
      expect(r).toBeDefined();
      const ol = r.commercial?.ownerLadder;
      auditLines.push(`| ${qty} | ${fmt(r.unitCost, 4)} | ${fmt(r.jobCost)} | ${ol ? fmt(ol.unitPrice) : "—"} | ${fmt(r.unitPrice)} | ${fmt(r.totalPrice)} | ${fmt(r.profit)} | ${fmt(r.actualMarginPct, 1)}% | ${r.commercial.controllingRule} |`);
    }
    mkdirSync("docs/generated", { recursive: true });
    writeFileSync("docs/generated/jar-pricing-sanity-100ml-tall-miron-2026-10-05.md", `# Miron 100ml Tall, Side + Lid — pricing sanity table (generated by tests/pricing-policy-sanity-2026-10-05.test.ts)\n\nTrue cost = canonical engine with the production-shaped Mimaki CMYK calibration. Prices = owner 16D ladder with 45% minimum margin protection and the quantity-break envelope. Generated ${new Date().toISOString().slice(0, 10)}.\n\n${auditLines.join("\n")}\n`);
  });
});

describe("every supported jar x Side+Lid at the owner ladder quantities", () => {
  for (const profile of ACTIVE_JAR_PROFILES) {
    it(`${profile.key}: prices, floors hold, totals monotone across 50..2500 breaks`, () => {
      const variant = profile.brand === "standard" ? "&pjarvariant=black_white" : "";
      const base = `pfamily=${profile.uiFamily}&pqty=128&pjar=${profile.key}${variant}&pjarside=1&pjarlid=1&pprinter=auto&pwhitelayers=0&pglosslayers=0`;
      const curveKey = profile.uiFamily === "premium-jars" ? (profile.brand === "chiron" ? "chiron-jars" : "miron-jars") : null;
      const quantities = [...new Set([...LADDER, ...JAR_PRICE_BREAK_SUPPORT_QUANTITIES, 127, 129, 255, 257, 999])].sort((a, b) => a - b);
      const rows = dropSupportRows(applyQuantityBreakEnvelope(priceRows({ base, family: profile.uiFamily, curveKey, ladder: jarLadder(profile.brand, profile.size), quantities, display: new Set(quantities), requested: 128 })));
      const priced = rows.filter((r) => !r.draftOnly);
      expect(priced.length, profile.key).toBe(rows.length);
      const floor = curveKey === "miron-jars" ? 45 : 40;
      for (const r of priced) {
        expect(r.totalPrice!).toBeGreaterThan(r.jobCost!);
        expect(r.actualMarginPct!).toBeGreaterThanOrEqual(floor - 1e-9);
      }
      for (let i = 1; i < priced.length; i += 1) expect(priced[i].totalPrice!, `${profile.key} ${priced[i].quantity}`).toBeGreaterThanOrEqual(priced[i - 1].totalPrice! - 1e-6);
      if (profile.brand === "chiron") {
        expect(priced.every((r) => r.commercial.ownerLadder == null)).toBe(true); // no owner ladder for Chiron
      } else {
        expect(priced.filter((r) => r.quantity >= 50 && r.quantity < 5000).every((r) => r.commercial.ownerLadder != null)).toBe(true);
      }
    });
  }
});

describe("other canonical families — floors hold; cliffs are reported (not changed tonight)", () => {
  const FAMILIES: Array<{ label: string; base: string; family: "sticker-bags" | "stock-bags" | "stickers-labels" | "banners"; curveKey: string | null; quantities: number[] }> = [
    { label: "4x5 sticker bag (1 side)", base: "pfamily=sticker-bags&pqty=100&pbagsides=1&pprinter=auto&pwhitelayers=0&pglosslayers=0", family: "sticker-bags", curveKey: "bags-4x5", quantities: [50, 99, 100, 127, 128, 129, 255, 256, 499, 500, 639, 640, 999, 1000, 1499, 1500] },
    { label: "3x3 matte sticker", base: "pfamily=stickers-labels&pllines=1&pl0qty=1000&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=0&pglosslayers=0", family: "stickers-labels", curveKey: "stickers-labels", quantities: [100, 127, 128, 255, 256, 639, 640, 999, 1000, 2000] },
    { label: "3x6 banner", base: "pfamily=banners&pqty=10&pbannerw=72&pbannerh=36&pprinter=auto&pwhitelayers=0&pglosslayers=0", family: "banners", curveKey: "banners", quantities: [1, 5, 10, 63, 64, 127, 128] },
  ];
  const report: string[] = ["| family | qty a -> qty b | total a | total b | cliff |", "|---|---|---|---|---|"];
  for (const f of FAMILIES) {
    it(`${f.label}: price >= cost, margin >= floor, profit > 0 at every audited quantity`, () => {
      const rows = priceRows({ base: f.base, family: f.family, curveKey: f.curveKey, ladder: () => null, quantities: f.quantities, display: new Set(f.quantities), requested: f.quantities[0] });
      const priced = rows.filter((r) => !r.draftOnly);
      expect(priced.length, f.label).toBeGreaterThan(0);
      const floor = Math.max(marginCurveConfigFor(POLICY, f.curveKey)?.familyMinPct ?? MARGIN_FLOOR_PCT, MARGIN_FLOOR_PCT);
      for (const r of priced) {
        expect(r.totalPrice!, `${f.label} ${r.quantity}`).toBeGreaterThan(r.jobCost!);
        expect(r.profit!, `${f.label} ${r.quantity}`).toBeGreaterThan(0);
        expect(r.actualMarginPct!, `${f.label} ${r.quantity}`).toBeGreaterThanOrEqual(floor - 1e-9);
      }
      for (let i = 1; i < priced.length; i += 1) {
        const a = priced[i - 1], b = priced[i];
        if (b.totalPrice! < a.totalPrice! - 1e-6) report.push(`| ${f.label} | ${a.quantity} -> ${b.quantity} | ${fmt(a.totalPrice)} | ${fmt(b.totalPrice)} | TOTAL DECREASES (${fmt(a.totalPrice! - b.totalPrice!)}) |`);
      }
    });
  }
  it("writes the cross-family cliff report", () => {
    mkdirSync("docs/generated", { recursive: true });
    writeFileSync("docs/generated/pricing-cliff-report-other-families-2026-10-05.md", `# Quantity-cliff report — non-jar canonical families (generated; NOT changed tonight)\n\nRows listed only where the customer TOTAL falls when quantity rises between audited quantities. Empty table = no cliff found among the audited quantities.\n\n${report.join("\n")}\n`);
    expect(report.length).toBeGreaterThanOrEqual(2);
  });
});

describe("historical quote safety", () => {
  it("a stored price snapshot is a plain JSON value that today's policy cannot reach into", () => {
    const stored = JSON.parse(JSON.stringify({ unitPrice: 8.0, marginPct: 58, tiers: [{ qty: 128, unitPrice: 8.0, marginPct: 58 }], pricingPolicy: "Miron jars researched curve at quantity band" }));
    const before = JSON.stringify(stored);
    // new policy runs
    computeCommercialPrice({ familyKey: "premium-jars", quantity: 128, completeCost: 430.0861, marginRule: resolveMarginFamily("miron-jars"), premiumEligible: false, policyValues: POLICY, marginCurveKey: "miron-jars", ownerLadder: { unitPrice: 4.5, source: "s", label: "Owner ladder" } });
    expect(JSON.stringify(stored)).toBe(before);
    expect(stored.tiers[0].unitPrice).toBe(8.0);
  });

  it("resolveMarginPctForQuantity still returns the legacy curve values (old snapshots' stated margins remain explainable)", () => {
    expect(resolveMarginPctForQuantity(POLICY, "miron-jars", resolveMarginFamily("miron-jars"), 127)).toBe(65);
    expect(resolveMarginPctForQuantity(POLICY, "miron-jars", resolveMarginFamily("miron-jars"), 128)).toBe(58);
  });
});
