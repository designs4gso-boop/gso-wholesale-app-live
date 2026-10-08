// 2026-10-05 dead-control audit of the Pricing Settings page.
// Source-level guard (the route is a React Router client/server module and
// cannot be rendered in a node unit test): asserts that controls no pricing
// path reads are rendered read-only/hidden and labelled, that the saved
// payload shape is unchanged (fields still submitted), and that the
// price-effect legend and specialtyPricing note are present.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MARGIN_CURVE_CONFIGURABLE_KEYS, MARKET_TARGET_ALLOWED_KEYS } from "../app/lib/commercial-pricing-policy.server";

const ROUTE_PATH = resolve(__dirname, "../app/routes/app.erp.pricing-settings.tsx");
const source = readFileSync(ROUTE_PATH, "utf8");

function sectionBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Section D — unused margin-curve rows (die-cut-bags, boxes)", () => {
  it("names exactly die-cut-bags and boxes as unused, and both are still configurable keys the validator requires", () => {
    const match = source.match(/const UNUSED_MARGIN_CURVE_KEYS = \[([^\]]+)\];/);
    expect(match).not.toBeNull();
    const keys = match![1].split(",").map((token) => token.trim().replace(/^"|"$/g, "")).filter(Boolean);
    expect(keys.sort()).toEqual(["boxes", "die-cut-bags"]);
    for (const key of keys) expect(MARGIN_CURVE_CONFIGURABLE_KEYS).toContain(key);
  });

  it("carries the 'Not used by any calculator path' label and renders those rows readOnly (not disabled)", () => {
    expect(source).toContain("Not used by any calculator path — kept for config completeness");
    const rows = sectionBetween("Per-family margin curves (quantity bands)", "Save margin curves");
    // Both curve inputs in the row are readOnly when the family is unused.
    expect(rows).toContain("name={`curve_min_${family.key}`}");
    expect(rows).toContain("name={`curve_bands_${family.key}`}");
    expect(rows.match(/readOnly=\{unused\}/g)?.length).toBe(2);
    // readOnly inputs still submit; disabled ones would drop the fields the validator requires.
    expect(rows).not.toMatch(/disabled=\{unused\}/);
    expect(rows).toContain("{UNUSED_ROW_NOTE}");
    // The loader flags the rows from the shared constant.
    expect(source).toContain("unused: UNUSED_MARGIN_CURVE_KEYS.includes(key)");
  });

  it("parseMarginCurvesForm still reads every configurable key (payload unchanged)", () => {
    const parser = sectionBetween("function parseMarginCurvesForm", "function parseLadderText");
    expect(parser).toContain("for (const key of MARGIN_CURVE_CONFIGURABLE_KEYS)");
    expect(parser).toContain("form.get(`curve_min_${key}`)");
    expect(parser).toContain("form.get(`curve_bands_${key}`)");
  });
});

describe("Section F — premium target column", () => {
  const table = sectionBetween("Verified market targets", "Save market targets");

  it("no longer renders an editable Premium tgt input", () => {
    expect(table).not.toContain("Premium tgt");
    expect(table).not.toMatch(/cell\("prem"/);
  });

  it("still submits a hidden mt_<key>_prem_<idx> input so saved payloads are unchanged", () => {
    expect(table).toContain('<input type="hidden" name={`mt_${family.key}_prem_${index}`}');
    expect(table).toContain("Premium target: recorded for reference only; no pricing math reads it.");
  });

  it("parseMarketTargetsForm still maps prem -> premiumTarget for the allowed families", () => {
    const parser = sectionBetween("function parseMarketTargetsForm", "function parseBandPairsText");
    expect(parser).toContain('premiumTarget: num("prem")');
    expect(parser).toContain("for (const key of MARKET_TARGET_ALLOWED_KEYS)");
    expect(MARKET_TARGET_ALLOWED_KEYS).toEqual(["bags-4x5", "bags-4x5-double"]);
  });
});

describe("Legend and section tags", () => {
  it("renders the 'What on this page actually changes a price?' legend with all four classes", () => {
    expect(source).toContain("What on this page actually changes a price?");
    for (const label of ["ACTIVE AUTHORITY", "ACTIVE OVERRIDE (raising-only)", "DISPLAY ONLY", "NOT USED"]) {
      expect(source).toContain(label);
    }
  });

  it("tags each section header with a price-effect class", () => {
    // A/B via MoneyMapSection prop
    expect(source.match(/tag="authority"/g)?.length).toBe(2);
    // C stickers-only authority, D authority, E display, F override + display
    expect(source).toContain('Sticker area market floor bands<ClassTag kind="authority"');
    expect(source).toContain('Per-family margin curves (quantity bands)<ClassTag kind="authority"');
    expect(source).toContain('Displayed tier quantity ladders<ClassTag kind="display"');
    expect(source).toContain('<ClassTag kind="override" note="Target column" />');
    expect(source).toContain('<ClassTag kind="display" note="all other columns" />');
  });

  it("states that minimum unit-price floors are inactive by owner decision", () => {
    expect(source).toMatch(/minimum unit-price floors<\/b> are inactive by owner decision/);
  });
});

describe("specialtyPricing read-only note", () => {
  it("mentions the key, that it is active for 4x5 bag specialty pricing, and shows the loader-resolved source badge", () => {
    expect(source).toContain("PRICING_SPECIALTY_KEY");
    expect(source).toContain("specialtyPricing: PRICING_SPECIALTY_KEY");
    expect(source).toContain("4x5 bag specialty pricing");
    expect(source).toContain("<code>{keys.specialtyPricing}</code>");
    expect(source).toContain("active pricing authority");
    expect(source).toContain("<SourceBadge resolution={resolutions[keys.specialtyPricing]} />");
    expect(source).toContain("code defaults</b> unless a row was hand-written");
    // No editor is built for it on this page.
    expect(source).not.toContain('name="key" value={keys.specialtyPricing}');
  });
});

describe("staff-facing headings are plain English", () => {
  it("does not put patch numbers in h1/h2 headings", () => {
    const headings = [...source.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/g)].map((m) => m[1]);
    expect(headings.length).toBeGreaterThan(5);
    for (const heading of headings) expect(heading).not.toMatch(/15F\.0K/);
  });
});
