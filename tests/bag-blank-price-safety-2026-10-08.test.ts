// COMMERCIAL PRICE SAFETY — 4x5 blank bag $0.09 -> $0.11 (owner decision 2026-10-08).
//
// Sweeps every customer-facing 4x5 bag price point (storefront app proxy and
// the identical rule in the Cost Calculator) at the superseded $0.09 blank and
// the approved $0.11 blank by feeding the blank cost as INPUT, records every
// sell price that moved with its controlling rule, and pins the invariant: a
// price may move ONLY when a cost-based rule (margin band / cost floor /
// minimum) controls it; an owner / market-target controlled price never moves;
// a higher cost never LOWERS a price. Writes
// docs/generated/bag-blank-price-safety-2026-10-08.{json,md}.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalStockBagJob } from "../app/lib/canonical-bag-pricing.server";
import { priceStorefrontConfiguration } from "../app/lib/storefront-canonical-pricing.server";
import { defaultPricingPolicyValues } from "../app/lib/commercial-pricing-policy.server";
import { BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24, BAG_4X5_BLANK_UNIT_COST } from "../app/lib/bag-cost-inputs.server";

const POLICY = defaultPricingPolicyValues();
const inputs = (blankUnitCost: number): any => ({
  available: true, reasons: [],
  matte: { name: "Poseidon Matte", costPerSqft: 213 / 675 },
  holographic: { name: "Holographic", costPerSqft: 0.7141463415 },
  blank: { name: "Blank 4x5 bag (Safe Care)", unitCost: blankUnitCost, tiers: [] },
  rolandSqftPerHour: 150, policyValues: POLICY,
});

type Row = { config: string; blank: number; cost: number | null; total: number | null; unit: number | null; rule: string };
function sweep(blankUnitCost: number): Row[] {
  const rows: Row[] = [];
  const BI = inputs(blankUnitCost);
  for (const quantity of [50, 100, 250, 500, 1000, 2500]) for (const faces of [1, 2]) for (const material of ["Matte", "Holographic"]) for (const stages of [0, 1, 3, 5, 7]) {
    const finish = stages ? `${stages}X Spot Gloss` : "No Spot Gloss";
    const p: any = priceStorefrontConfiguration(BI, { quantity, faces, material, finish });
    const job: any = canonicalStockBagJob(BI, { quantity, faces, glossLayers: stages, whiteLayers: material === "Holographic" ? 1 : 0, holographic: material === "Holographic" });
    rows.push({ config: `${quantity} x ${faces === 2 ? "double" : "single"} ${material} ${finish}`, blank: blankUnitCost, cost: job.available ? job.totalCost : null, total: p.ok ? p.totalPrice : null, unit: p.ok ? p.unitPrice : null, rule: job.available ? String(job.controllingRule) : `unavailable: ${p.reason || ""}` });
  }
  return rows;
}

const COST_RULE = /margin|floor|cost|band|minimum|provisional/i;
const FIXED_RULE = /owner jar price ladder|market target|UV specialty market tier|sticker market|owner config/i;

describe("4x5 blank bag $0.09 -> $0.11 — customer-facing price safety", () => {
  it("every moved sell price is cost-rule controlled; fixed / market prices never move; no price falls", () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    const before = sweep(BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24);
    const after = sweep(BAG_4X5_BLANK_UNIT_COST);
    expect(before.length).toBe(after.length);
    expect(after.length).toBe(120);
    const moved: Array<{ config: string; cost09: number | null; cost11: number | null; total09: number | null; total11: number | null; unit09: number | null; unit11: number | null; rule09: string; rule11: string; klass: string }> = [];
    const unchanged: string[] = [];
    before.forEach((b, i) => {
      const a = after[i];
      expect(a.config).toBe(b.config);
      // cost always rises by exactly $0.02 per bag when the job is priceable
      if (b.cost != null && a.cost != null) expect(a.cost - b.cost).toBeCloseTo(0.02 * Number(b.config.split(" ")[0]), 6);
      const same = (b.total == null && a.total == null) || (b.total != null && a.total != null && Math.abs(b.total - a.total) < 0.005);
      if (same) unchanged.push(`${b.config} · ${a.rule}`);
      else {
        const wasFixed = FIXED_RULE.test(b.rule);
        const nowCost = COST_RULE.test(a.rule) && !FIXED_RULE.test(a.rule);
        const klass = !wasFixed && COST_RULE.test(b.rule) ? "B approved dynamic cost/margin rule"
          : wasFixed && nowCost ? "B approved cost floor overtook the fixed owner-curve candidate (curve itself unchanged)"
          : wasFixed ? "A FIXED PRICE CHANGED — NOT ALLOWED" : "E ambiguous";
        moved.push({ config: b.config, cost09: b.cost, cost11: a.cost, total09: b.total, total11: a.total, unit09: b.unit, unit11: a.unit, rule09: b.rule, rule11: a.rule, klass });
      }
    });
    for (const m of moved) {
      // allowed: a cost-based rule controlled the price already, OR the existing cost floor rose above a fixed candidate
      expect(m.klass, `${m.config}: "${m.rule09}" -> "${m.rule11}"`).toMatch(/^B /);
      expect(m.rule11, `${m.config} ended under a non-cost rule yet moved`).toMatch(COST_RULE);
      expect(m.total11!, `${m.config} fell although cost rose`).toBeGreaterThanOrEqual(m.total09! - 0.005);
    }
    // a price that stays under a FIXED rule on both sides must not move at all (the owner curve / market target itself is untouched)
    for (const b of before.filter((r) => FIXED_RULE.test(r.rule))) {
      const a = after.find((x) => x.config === b.config)!;
      if (FIXED_RULE.test(a.rule)) expect(a.total, `${b.config} (fixed/market) must not move`).toBeCloseTo(b.total!, 2);
    }
    expect(moved.filter((m) => /NOT ALLOWED|ambiguous/.test(m.klass))).toEqual([]);
    mkdirSync(new URL("../docs/generated/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../docs/generated/bag-blank-price-safety-2026-10-08.json", import.meta.url), JSON.stringify({ sweptCount: after.length, movedCount: moved.length, unchangedCount: unchanged.length, moved, unchanged }, null, 2));
    const md = [
      "# Commercial price safety — 4x5 blank bag $0.09 → $0.11 (owner decision 2026-10-08)",
      "",
      `Swept ${after.length} customer-facing 4x5 bag price points (storefront app proxy = Cost Calculator rule). ${moved.length} moved, ${unchanged.length} unchanged. Every job cost rose by exactly $0.02 per bag. A sell price moved only under an approved cost-based rule (class B): either it was already cost-floor / margin-band controlled, or the existing specialty cost safety floor rose above a fixed owner-curve candidate (${moved.filter((m) => /overtook/.test(m.klass)).length} such rows — the curve itself is unchanged). No fixed owner / market-target price was altered and no price fell (test-pinned).`,
      "",
      "| Configuration | Cost @0.09 | Cost @0.11 | Sell @0.09 | Sell @0.11 | Unit @0.09 | Unit @0.11 | Rule @0.09 | Rule @0.11 | Class |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...moved.map((m) => `| ${m.config} | ${m.cost09?.toFixed(2) ?? "—"} | ${m.cost11?.toFixed(2) ?? "—"} | ${m.total09?.toFixed(2) ?? "—"} | ${m.total11?.toFixed(2) ?? "—"} | ${m.unit09?.toFixed(4) ?? "—"} | ${m.unit11?.toFixed(4) ?? "—"} | ${m.rule09} | ${m.rule11} | ${m.klass} |`),
      "",
      "## Unchanged (fixed / market controlled, or the cost change did not change the winning rule)",
      "",
      ...unchanged.map((u) => `- ${u}`),
    ].join("\n").replace(/\n+$/, "") + "\n";
    writeFileSync(new URL("../docs/generated/bag-blank-price-safety-2026-10-08.md", import.meta.url), md);
  });
});
