// 2026-10-06 — Spektra research CSV import contract + exact-row verification
// of the generated authority against the research CSV itself.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildRow, importSpektraCsv, mapColumns, normalizeSize, normalizeZipper, parseCsv, parseFeatures } from "../tools/lib/spektra-csv-import.mjs";
import { SPEKTRA_COST_BOOK_META, SPEKTRA_OBSERVED_ROWS, lookupSpektraVendorCost, wholesaleTotalFromPublicTotal } from "../app/lib/spektra-live-cost-book";

const CSV_PATH = "docs/vendor-research/SPEKTRA_FLEX_LIVE_PRICE_MATRIX_2026-10-06.csv";
const csvText = readFileSync(CSV_PATH, "utf8");
const parsed = parseCsv(csvText);
const header = parsed[0];
const { col } = mapColumns(header);
const csvRows = parsed.slice(1).map((line, i) => buildRow(line, col, i + 2)).filter((r) => r.ok).map((r) => (r as any).row);

describe("features column parsing (research header `features`, not `topFeature`)", () => {
  it("accepts exactly the five observed values", () => {
    expect(parseFeatures("No Tear Notch")).toEqual({ ok: true, topFeature: "No Tear Notch", clearGusset: false });
    expect(parseFeatures("No Tear Notch + Clear Gusset")).toEqual({ ok: true, topFeature: "No Tear Notch", clearGusset: true });
    expect(parseFeatures("Punch Hole")).toEqual({ ok: true, topFeature: "Punch Hole", clearGusset: false });
    expect(parseFeatures("Sombrero")).toEqual({ ok: true, topFeature: "Sombrero", clearGusset: false });
    expect(parseFeatures("Sombrero + Clear Gusset")).toEqual({ ok: true, topFeature: "Sombrero", clearGusset: true });
    expect(parseFeatures("Clear Gusset + Punch Hole")).toEqual({ ok: true, topFeature: "Punch Hole", clearGusset: true });
    expect(parseFeatures("  sombrero+clear gusset ")).toEqual({ ok: true, topFeature: "Sombrero", clearGusset: true });
  });

  it("rejects unknown, missing, duplicate and double-top feature strings", () => {
    expect(parseFeatures("Tear Notch").ok).toBe(false);
    expect(parseFeatures("Hang Hole + Clear Gusset").ok).toBe(false);
    expect(parseFeatures("Clear Gusset").ok).toBe(false); // gusset is a toggle, not a top feature
    expect(parseFeatures("").ok).toBe(false);
    expect(parseFeatures("Punch Hole + Sombrero").ok).toBe(false);
    expect(parseFeatures("No Tear Notch + Clear Gusset + Clear Gusset").ok).toBe(false);
    expect(parseFeatures("Punch Hole, Zipper").ok).toBe(false);
  });

  it("maps the research header and normalizes sizes / zippers without touching numbers", () => {
    expect(header[0]).toBe("source_date");
    expect(col).toMatchObject({ size: 2, material: 4, finish: 5, spot: 6, zipper: 7, features: 8, quantity: 9, skuCount: 10, publicUnitDisplayed: 11, publicTotal: 12, discountPct: 13, wholesaleTotal: 14, wholesaleUnit: 15 });
    expect(normalizeSize("3.5 x 4.5 x 2")).toBe("3.5x4.5x2");
    expect(normalizeSize("4 x 5 x 2")).toBe("4x5x2");
    expect(normalizeSize("5 x 4 x 2")).toBeNull();
    expect(normalizeZipper("Child resistant")).toBe("Child Resistant");
    expect(normalizeZipper("")).toBe("None");
  });

  it("fails closed on bad rows: unknown material / finish / spot / zipper, Glossy + spot, bad numbers, wrong discount, wholesale mismatch", () => {
    const mk = (over: Record<string, string>) => {
      const base: Record<string, string> = { source_date: "2026-10-06", product_type: "Stand-up pouch", size: "4 x 5 x 2", capacity: "3.5 g", material: "White PET", finish: "Glossy", spot_gloss: "None", zipper: "Child resistant", features: "No Tear Notch", quantity: "1000", sku_count: "1", website_unit_display: "0.98", website_total: "982.15", gso_discount_pct: "25", gso_wholesale_total: "736.6125", gso_wholesale_unit_cost: "0.7366125000", shipping_included: "UNVERIFIED", compatibility_notes: "", source_url: "", confidence: "HIGH" };
      const row = { ...base, ...over };
      return buildRow(header.map((h) => row[h] ?? ""), col, 2);
    };
    expect(mk({}).ok).toBe(true);
    const badRows: Array<Record<string, string>> = [{ material: "Kraft" }, { finish: "Velvet" }, { spot_gloss: "Mega" }, { zipper: "Velcro" }, { finish: "Glossy", spot_gloss: "Standard" }, { quantity: "abc" }, { quantity: "0" }, { website_total: "-1" }, { gso_discount_pct: "30" }, { gso_wholesale_total: "700.00" }, { gso_wholesale_unit_cost: "0.70" }, { features: "Tear Notch" }, { size: "5 x 4 x 2" }];
    for (const bad of badRows) {
      expect(mk(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the research CSV imports completely: 1,084 rows read, 1,084 unique accepted, 0 rejected, 0 duplicates", () => {
    const result = importSpektraCsv(csvText);
    expect(result.ok).toBe(true);
    expect(result.read).toBe(1084);
    expect(result.accepted.length).toBe(1084);
    expect(result.rejected).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(SPEKTRA_COST_BOOK_META.researchFilePresent).toBe(true);
    expect(SPEKTRA_COST_BOOK_META.rowCount).toBe(1084);
    expect(SPEKTRA_OBSERVED_ROWS.length).toBe(1084);
  });

  it("the generated artifact equals the CSV import byte-for-byte on every key field (no derived rows stored)", () => {
    const result = importSpektraCsv(csvText);
    const strip = (r: any) => ({ size: r.size, material: r.material, finish: r.finish, spot: r.spot, zipper: r.zipper, topFeature: r.topFeature, clearGusset: r.clearGusset, quantity: r.quantity, skuCount: r.skuCount, publicTotal: r.publicTotal, publicUnitDisplayed: r.publicUnitDisplayed, observedAt: r.observedAt });
    expect(SPEKTRA_OBSERVED_ROWS.map(strip)).toEqual(result.accepted.map(strip));
  });
});

describe("exact CSV examples verified against the generated authority (wholesale = exact website total x 0.75)", () => {
  const find = (f: (r: any) => boolean) => { const r = csvRows.find(f); expect(r, "csv row").toBeDefined(); return r!; };
  const expectObserved = (q: any, csv: any) => {
    const look = lookupSpektraVendorCost(q);
    expect(look.status, JSON.stringify(q)).toBe("OBSERVED_VENDOR_PRICE");
    expect(look.publicTotal).toBe(csv.publicTotal);
    expect(look.wholesaleTotal).toBeCloseTo(csv.publicTotal * 0.75, 6);
    expect(look.wholesaleUnit!).toBeCloseTo((csv.publicTotal * 0.75) / csv.quantity, 9);
    // never from the rounded displayed unit
    if (csv.publicUnitDisplayed != null) expect(Math.abs(look.wholesaleTotal! - csv.publicUnitDisplayed * csv.quantity * 0.75)).toBeGreaterThanOrEqual(0);
    return look;
  };
  const BASE = { size: "4x5x2" as const, material: "White PET" as const, finish: "Glossy" as const, spot: "None" as const, zipper: "Child Resistant" as const, topFeature: "No Tear Notch" as const, clearGusset: false, skuCount: 1 };
  const same = (r: any, q: any) => r.size === q.size && r.material === q.material && r.finish === q.finish && r.spot === q.spot && r.zipper === q.zipper && r.topFeature === q.topFeature && r.clearGusset === q.clearGusset && r.skuCount === (q.skuCount ?? 1) && r.quantity === q.quantity;

  it("4x5x2 White PET Glossy, no spot, CR zipper, No Tear Notch, 1 SKU at 1000 / 2500 / 5000 / 10000 / 25000", () => {
    const known: Record<number, number> = { 1000: 982.15, 2500: 1197.71, 5000: 1554.24, 10000: 2492.39, 25000: 5019.27 };
    for (const quantity of [1000, 2500, 5000, 10000, 25000]) {
      const q = { ...BASE, quantity };
      const csv = find((r) => same(r, q));
      expect(csv.publicTotal).toBe(known[quantity]);
      const look = expectObserved(q, csv);
      expect(look.wholesaleTotal).toBeCloseTo(known[quantity] * 0.75, 6);
    }
    expect(wholesaleTotalFromPublicTotal(982.15)).toBeCloseTo(736.6125, 9); // full precision, no cent rounding
    expect(lookupSpektraVendorCost({ ...BASE, quantity: 1000 }).wholesaleUnit!).toBeCloseTo(0.7366125, 7);
  });

  it("one Clear Gusset, one Punch Hole, one Sombrero, one Standard spot, one Raised UV, one non-White material, one 8x5x2 row", () => {
    const picks = [
      (r: any) => r.clearGusset === true,
      (r: any) => r.topFeature === "Punch Hole",
      (r: any) => r.topFeature === "Sombrero",
      (r: any) => r.spot === "Standard",
      (r: any) => r.spot === "Raised UV",
      (r: any) => r.material !== "White PET",
      (r: any) => r.size === "8x5x2",
      (r: any) => r.skuCount === 10,
      (r: any) => r.quantity === 7500,
      (r: any) => r.zipper === "10 mm",
    ];
    for (const pick of picks) {
      const csv = find(pick);
      expectObserved({ size: csv.size, material: csv.material, finish: csv.finish, spot: csv.spot, zipper: csv.zipper, topFeature: csv.topFeature, clearGusset: csv.clearGusset, quantity: csv.quantity, skuCount: csv.skuCount }, csv);
    }
  });

  it("every one of the 1,084 rows round-trips through the lookup as OBSERVED with wholesale = exact total x 0.75", () => {
    let observed = 0;
    for (const csv of csvRows) {
      const look = lookupSpektraVendorCost({ size: csv.size, material: csv.material, finish: csv.finish, spot: csv.spot, zipper: csv.zipper, topFeature: csv.topFeature, clearGusset: csv.clearGusset, quantity: csv.quantity, skuCount: csv.skuCount });
      if (look.status !== "OBSERVED_VENDOR_PRICE") throw new Error(`not observed: ${JSON.stringify(csv)}`);
      if (Math.abs(look.wholesaleTotal! - csv.publicTotal * 0.75) > 1e-6) throw new Error(`discount mismatch: ${JSON.stringify(csv)}`);
      observed += 1;
    }
    expect(observed).toBe(1084);
  });

  it("derived SKU counts are labelled ESTIMATED (never OBSERVED) and unsupported configs still request a quote", () => {
    const est = lookupSpektraVendorCost({ ...BASE, quantity: 1000, skuCount: 3 });
    expect(est.status).toBe("ESTIMATED_FROM_VALIDATED_VENDOR_RULE");
    expect(est.publicTotal).toBeCloseTo(982.15 + 185 * 2, 6);
    expect(lookupSpektraVendorCost({ ...BASE, finish: "Glossy", spot: "Standard", quantity: 1000 }).status).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
    expect(lookupSpektraVendorCost({ ...BASE, quantity: 1500 }).status).toBe("REQUEST_CURRENT_VENDOR_QUOTE");
  });
});
