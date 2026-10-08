// COMMERCIAL PRICE SAFETY — machine recovery $8/hr -> $5/hr (2026-10-07).
//
// Sweeps every customer-facing price path (storefront 4x5 bags, Cost
// Calculator families, owner jar ladder, Product Setup recipe pricing) at the
// former $8/hr and the approved $5/hr by toggling the ONE owner standard at
// runtime, records every sell price that moved with its controlling rule, and
// pins the safety invariant: a price may move ONLY when a cost-based rule
// (margin band / cost floor) controls it; an owner ladder or market-target
// controlled price never moves. Writes docs/generated/commercial-price-safety-2026-10-07.{json,md}.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { computeCanonicalJob, normalizeCanonicalInput } from "../app/lib/canonical-calculator.server";
import { CANONICAL_CALIBRATION_IDENTITIES } from "../app/lib/machine-routing.server";
import { canonicalStockBagJob } from "../app/lib/canonical-bag-pricing.server";
import { priceStorefrontConfiguration } from "../app/lib/storefront-canonical-pricing.server";
import { computeCommercialPrice, defaultPricingPolicyValues, specialtyFinishReasons } from "../app/lib/commercial-pricing-policy.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";
import { resolveJarOwnerLadder } from "../app/lib/jar-commercial-pricing";
import { computeProductDrivenCost, type ProductDrivenInput } from "../app/lib/product-driven-costing.server";
import { priceRecipeAtQuantity } from "../app/lib/recipe-pricing.server";

const APPROVED_RATE = 5;
const FORMER_RATE = 8;
const std: any = OWNER_STANDARDS.machineRecoveryPerHour;
afterAll(() => { std.value = APPROVED_RATE; });

/* Production-shaped calibration rows (same as the 2D-4C1 control suite). */
const MEASURED: Record<string, { mlPerSqftPerPass: number; minutesPerSqft: number; coverageBasisPct: number | null }> = {
  "mimaki-cmyk": { mlPerSqftPerPass: 1.89, minutesPerSqft: 1.444, coverageBasisPct: null },
  "roland-cmyk": { mlPerSqftPerPass: 1.4133, minutesPerSqft: 0.91, coverageBasisPct: null },
  "roland-white": { mlPerSqftPerPass: 6.0, minutesPerSqft: 1.71, coverageBasisPct: 100 },
  "roland-gloss": { mlPerSqftPerPass: 4.18, minutesPerSqft: 0.91, coverageBasisPct: 100 },
};
const SHOP = "942075-2.myshopify.com";
const ROWS = Object.entries(CANONICAL_CALIBRATION_IDENTITIES).map(([key, identity]) => ({
  id: `cal_${key}`, shop: SHOP, ...identity, inkAreaBasis: "inkable_artwork", timeAreaBasis: "rip_layout", fixedMinutes: null, timeModel: "variable_only",
  measuredAt: new Date("2026-08-18T00:00:00Z"), effectiveFrom: new Date("2026-08-18T00:00:00Z"), effectiveTo: null, status: "approved", source: "owner-measured", notes: null, supersedesId: null, createdAt: new Date("2026-08-18T00:00:00Z"), ...MEASURED[key],
}));
const db = { machineProfileCalibration: { findMany: async ({ where }: any) => ROWS.filter((row) => Object.entries(where).every(([field, value]) => field === "shop" ? row.shop === value : (row as any)[field] === value)) } };
const POLICY = defaultPricingPolicyValues();
const BAG_INPUTS: any = { available: true, reasons: [], matte: { name: "Poseidon Matte", costPerSqft: 213 / 675 }, holographic: { name: "Holographic", costPerSqft: 0.7141463415 }, blank: { name: "Blank 4x5 bag (Safe Care)", unitCost: 0.09, tiers: [] }, rolandSqftPerHour: 150, policyValues: POLICY };

type Row = { surface: string; family: string; config: string; rate: number; cost: number | null; total: number | null; unit: number | null; rule: string; note?: string };

async function sweep(rate: number): Promise<Row[]> {
  std.value = rate;
  const rows: Row[] = [];
  // 1. storefront 4x5 bags (app proxy) + the same rule in the calculator
  for (const quantity of [50, 100, 250, 500, 1000, 2500]) for (const faces of [1, 2]) for (const material of ["Matte", "Holographic"]) for (const stages of [0, 1, 3, 5, 7]) {
    const finish = stages ? `${stages}X Spot Gloss` : "No Spot Gloss";
    const p: any = priceStorefrontConfiguration(BAG_INPUTS, { quantity, faces, material, finish });
    const job: any = canonicalStockBagJob(BAG_INPUTS, { quantity, faces, glossLayers: stages, whiteLayers: material === "Holographic" ? 1 : 0, holographic: material === "Holographic" });
    rows.push({ surface: "storefront / calculator 4x5 bag", family: "sticker-bags", config: `${quantity} x ${faces === 2 ? "double" : "single"} ${material} ${finish}`, rate, cost: job.available ? job.totalCost : null, total: p.ok ? p.totalPrice : null, unit: p.ok ? p.unitPrice : null, rule: job.available ? String(job.controllingRule) : `unavailable: ${p.reason || ""}` });
  }
  // 2. Cost Calculator — stickers / labels (Mimaki CMYK, Roland white, Roland gloss)
  const labelCases: Array<{ label: string; q: string; qty: number; white: number; gloss: number }> = [];
  for (const qty of [100, 250, 500, 1000, 2500]) labelCases.push({ label: `3x3 matte CMYK x ${qty}`, qty, white: 0, gloss: 0, q: `pfamily=stickers-labels&pllines=1&pl0qty=${qty}&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=0&pglosslayers=0` });
  for (const qty of [500, 1000]) {
    labelCases.push({ label: `3x3 matte + 1 white x ${qty}`, qty, white: 1, gloss: 0, q: `pfamily=stickers-labels&pllines=1&pl0qty=${qty}&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=1&pwhitecoverage=100&pglosslayers=0` });
    labelCases.push({ label: `3x3 matte + 3X gloss x ${qty}`, qty, white: 0, gloss: 3, q: `pfamily=stickers-labels&pllines=1&pl0qty=${qty}&pl0w=3&pl0h=3&pl0cutw=2.875&pl0cuth=2.875&pl0mat=matte&pl0art=A&pprinter=auto&pwhitelayers=0&pglosslayers=3` });
  }
  for (const c of labelCases) {
    const r = await computeCanonicalJob({ db, shop: SHOP }, normalizeCanonicalInput(new URLSearchParams(c.q))!);
    if (r.totalCost == null) { rows.push({ surface: "Cost Calculator", family: "stickers-labels", config: c.label, rate, cost: null, total: null, unit: null, rule: `no cost: ${r.status} ${r.blockers.join(";")}` }); continue; }
    const setupTotal = r.trueCost.lines.filter((l) => l.key === "art_setup" || l.key === "print_setup").reduce((t, l) => t + l.amount, 0);
    const commercial = computeCommercialPrice({ familyKey: "stickers-labels", quantity: c.qty, completeCost: r.totalCost, marginRule: resolveMarginFamily("stickers-labels"), premiumEligible: c.white > 0 || c.gloss > 0, finishedSqft: (3 * 3 * c.qty) / 144, setupTotal, policyValues: POLICY, marginCurveKey: "stickers-labels", marketTargetSpecialtyReasons: specialtyFinishReasons({ whiteLayers: c.white, glossLayers: c.gloss, materialName: "Poseidon Matte" }) });
    rows.push({ surface: "Cost Calculator", family: "stickers-labels", config: c.label, rate, cost: r.totalCost, total: commercial.finalTotalPrice, unit: commercial.finalUnitPrice, rule: commercial.controllingRule });
  }
  // 3. Cost Calculator — banners (product-driven engine, market/margin bands)
  for (const qty of [1, 5]) {
    const input: ProductDrivenInput = { family: "banners", quantity: qty, designs: 1, facesPerUnit: 1, widthIn: 36, heightIn: 72, labelRows: null, dtp: null, blank: null, lid: null, mironTop: null, material: { name: "Banner Vinyl", costPerSqft: 0.2962962962962963 }, printer: "mimaki", printerHasWhite: true, printerHasGloss: false, whiteLayers: 0, glossLayers: 0, inkMlPerSqft: 0.6, machineMinutesPerSqft: 0, machineSqftPerHour: 0, machineRatePerHour: std.value, cutType: "square-rect", cutRequiresWeeding: false, hemming: false, grommets: false, freightPerUnit: 0, freightSource: "estimated", recipeWastePct: null, wasteOverride: null, boxOverride: null } as ProductDrivenInput;
    const run = computeProductDrivenCost(input);
    const commercial = computeCommercialPrice({ familyKey: "banners", quantity: qty, completeCost: run.totalCost, marginRule: resolveMarginFamily("banners"), premiumEligible: false, finishedSqft: 18 * qty, setupTotal: run.setupTotal, policyValues: POLICY, marginCurveKey: "banners" });
    rows.push({ surface: "Cost Calculator", family: "banners", config: `3x6 ft plain x ${qty}`, rate, cost: run.totalCost, total: commercial.finalTotalPrice, unit: commercial.finalUnitPrice, rule: commercial.controllingRule });
  }
  // 4. Cost Calculator — Miron jars (owner 16D ladder + margin floor + envelope)
  for (const qty of [50, 128, 250, 500, 1000]) {
    const q = `pfamily=premium-jars&pqty=${qty}&pjar=miron/100ml_tall&pjarside=1&pjarlid=1&pjarset=side_lid&pdesigns=1&pprinter=auto&pwhitelayers=0&pglosslayers=0`;
    const r = await computeCanonicalJob({ db, shop: SHOP }, normalizeCanonicalInput(new URLSearchParams(q))!);
    const ladder = resolveJarOwnerLadder({ brand: "miron", sizeKey: "100ml_tall", quantity: qty, holographic: false, specialtyX: 0 });
    if (r.totalCost == null) { rows.push({ surface: "Cost Calculator", family: "premium-jars", config: `Miron 100ml Tall side+lid x ${qty}`, rate, cost: null, total: null, unit: null, rule: `no cost: ${r.status}` }); continue; }
    const commercial = computeCommercialPrice({ familyKey: "premium-jars", quantity: qty, completeCost: r.totalCost, marginRule: resolveMarginFamily("miron-jars"), premiumEligible: false, policyValues: POLICY, marginCurveKey: "miron-jars", ownerLadder: ladder.ok ? { unitPrice: ladder.quote.unitPrice, source: ladder.quote.source, label: ladder.quote.label } : null });
    rows.push({ surface: "Cost Calculator", family: "premium-jars", config: `Miron 100ml Tall side+lid x ${qty}`, rate, cost: r.totalCost, total: commercial.finalTotalPrice, unit: commercial.finalUnitPrice, rule: commercial.controllingRule });
  }
  // 5. Product Setup recipe pricing (cost-plus margin set per recipe by the owner)
  const recipe: any = { widthIn: 3, heightIn: 3, wastePct: 10, laborMinutes: 0, operatorLaborPct: 0, marginPct: 50, pricingMode: "margin", materials: [], machineRules: [{ preferredMachine: { costPerHour: 5, sqftPerHour: 150, inkChannels: [] } }] };
  try {
    const priced: any = priceRecipeAtQuantity(recipe, 1000, {});
    rows.push({ surface: "Product Setup / Quotes recipe", family: "recipe (cost-plus)", config: "3x3 in-house recipe x 1,000 at the recipe margin", rate, cost: priced.unitCost != null ? priced.unitCost * 1000 : null, total: priced.unitPrice != null ? priced.unitPrice * 1000 : null, unit: priced.unitPrice ?? null, rule: `recipe-pricing/${priced.pricingSource ?? "margin"}` });
  } catch (error: any) {
    rows.push({ surface: "Product Setup / Quotes recipe", family: "recipe (cost-plus)", config: "3x3 in-house recipe x 1,000", rate, cost: null, total: null, unit: null, rule: `error: ${error?.message}` });
  }
  return rows;
}

const COST_RULE = /margin|floor|cost|band|minimum|provisional|recipe-pricing/i;
const FIXED_RULE = /owner jar price ladder|market target|UV specialty market tier|sticker market|owner config/i;

describe("commercial price safety — $8/hr vs $5/hr machine recovery", () => {
  it("every moved sell price is controlled by a cost-based rule; no owner-ladder / market-target price moved", async () => {
    const at8 = await sweep(FORMER_RATE);
    const at5 = await sweep(APPROVED_RATE);
    std.value = APPROVED_RATE;
    expect(at8.length).toBe(at5.length);
    const moved: Array<Row & { total8: number | null; total5: number | null; unit8: number | null; unit5: number | null; rule8: string; rule5: string; cost8: number | null; cost5: number | null }> = [];
    const unchanged: string[] = [];
    at8.forEach((r8, i) => {
      const r5 = at5[i];
      expect(r5.config).toBe(r8.config);
      const same = (r8.total == null && r5.total == null) || (r8.total != null && r5.total != null && Math.abs(r8.total - r5.total) < 0.005);
      if (same) unchanged.push(`${r8.surface} · ${r8.config} · ${r8.rule}`);
      else moved.push({ ...r5, total8: r8.total, total5: r5.total, unit8: r8.unit, unit5: r5.unit, rule8: r8.rule, rule5: r5.rule, cost8: r8.cost, cost5: r5.cost });
    });
    // invariants
    for (const m of moved) {
      expect(m.rule8, `${m.surface} ${m.config} moved under rule "${m.rule8}"`).toMatch(COST_RULE);
      expect(m.rule8, `${m.surface} ${m.config} was fixed/market controlled at $8 but moved`).not.toMatch(FIXED_RULE);
      expect(m.total5!, `${m.surface} ${m.config} rose`).toBeLessThanOrEqual(m.total8! + 0.005); // lower cost never raises a price
    }
    for (const r of at8.filter((r) => FIXED_RULE.test(r.rule))) {
      const r5 = at5.find((x) => x.config === r.config && x.surface === r.surface)!;
      expect(r5.total, `${r.surface} ${r.config} (fixed/market) must not move`).toBeCloseTo(r.total!, 2);
    }
    mkdirSync(new URL("../docs/generated/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../docs/generated/commercial-price-safety-2026-10-07.json", import.meta.url), JSON.stringify({ movedCount: moved.length, unchangedCount: unchanged.length, moved, unchanged }, null, 2));
    const md = [
      "# Commercial price safety — machine recovery $8/hr → $5/hr (2026-10-07)",
      "",
      `Swept ${at8.length} customer-facing price points. ${moved.length} moved, ${unchanged.length} unchanged. A price moved only where a cost-based rule (margin band / cost floor / cost-plus recipe) controlled it at $8/hr; every owner-ladder or market-target controlled price is unchanged (test-pinned).`,
      "",
      "| Surface | Family | Configuration | Cost @8 | Cost @5 | Sell @8 | Sell @5 | Unit @8 | Unit @5 | Rule @8 | Rule @5 |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      ...moved.map((m) => `| ${m.surface} | ${m.family} | ${m.config} | ${m.cost8?.toFixed(2) ?? "—"} | ${m.cost5?.toFixed(2) ?? "—"} | ${m.total8?.toFixed(2) ?? "—"} | ${m.total5?.toFixed(2) ?? "—"} | ${m.unit8?.toFixed(4) ?? "—"} | ${m.unit5?.toFixed(4) ?? "—"} | ${m.rule8} | ${m.rule5} |`),
      "",
      "## Unchanged (fixed / market / ladder controlled, or cost did not change the winner)",
      "",
      ...unchanged.map((u) => `- ${u}`),
      "",
    ].join("\n");
    writeFileSync(new URL("../docs/generated/commercial-price-safety-2026-10-07.md", import.meta.url), md);
    expect(moved.length).toBeGreaterThan(0);
  });
});
