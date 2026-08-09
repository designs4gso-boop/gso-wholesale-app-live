// Phase 15G.3 — canonical-calculator simplification pins. Source pins over
// the route (no route harness exists) + engine facts already dollar-pinned in
// the single-price-truth / bag-application / specialty suites.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "app/routes/app.erp.cost-calculator.tsx"), "utf8");

describe("legacy paths are opt-in only (B/C/D)", () => {
  it("the legacy/unsupported tools render only behind the explicit legacytools flag and never auto-open", () => {
    expect(source).toContain('get("legacytools") === "1"');
    expect(source).toContain("Legacy / Unsupported Job Calculator");
    expect(source).toContain("NOT canonical pricing for supported ERP products");
    expect(source).toContain("Open intentionally");
    // the old always-rendered "Advanced Pricing Tools" summary is gone
    expect(source.includes(">Advanced Pricing Tools</summary>")).toBe(false);
  });

  it("14B.1 auto-costing engages only inside legacy tools (loader AND save parity)", () => {
    expect(source).toContain('eparams.get("emode") === "auto" && eparams.get("legacytools") === "1"');
    expect(source).toContain('fRead("emode") === "auto" && fRead("legacytools") === "1"');
  });

  it("the emergency tier generator renders only for manual/unsupported jobs — never beside canonical product tiers", () => {
    expect(source).toContain("!emergency.productMode && emergency.tiers.some");
    expect(source).toContain("Manual / unsupported-job tiers — NOT canonical pricing");
  });

  it("manual cost-entry fields are hidden whenever a supported product drives the canonical engine", () => {
    expect(source).toContain("manual/unsupported jobs only");
    const overridesBlock = source.split("Advanced Overrides (tier quantities")[1] || "";
    expect(overridesBlock).toContain("!emergency.productMode ? (");
  });
});

describe("stale presets removed (E)", () => {
  it("the Miron preset ladders are deleted — $2.86 cannot regress", () => {
    // no ladder DATA remains (comments may reference the retired number)
    expect(source.includes("unitCost: 2.86")).toBe(false);
    expect(source.includes('"preset:miron')).toBe(false);
    expect(source.includes("mironTiers.")).toBe(false);
    expect(source.includes("Miron jar + lid")).toBe(false);
  });

  it("save-action preset re-resolution prefers the current DB Vendor Product and never labels a code preset verified", () => {
    const resolveBlock = source.split('rawId.startsWith("preset:")')[1]?.split("return null;")[0] || "";
    expect(resolveBlock).toContain("db.vendorProduct.findFirst");
    expect(resolveBlock).toContain('status: "estimated"');
    expect(resolveBlock.includes('status: "verified" }')).toBe(false === resolveBlock.includes('seeded') ? false : resolveBlock.includes('status: "verified"'));
    // the seeded DB branch is the only one allowed to say verified
    const presetOnly = resolveBlock.split("presetBlankItems()")[1] || "";
    expect(presetOnly.includes('"verified"')).toBe(false);
  });
});

describe("canonical result trust + snapshot (H/I/L/M)", () => {
  it("the result card carries the source/status area and specialty explanation", () => {
    expect(source).toContain("Pricing engine:");
    expect(source).toContain("Canonical Product Engine");
    expect(source).toContain("256 labels/hr @ $20/hr");
    expect(source).toContain("charged ONCE per design");
    expect(source).toContain("90% planning default");
    expect(source).toContain("ACTUAL artwork mask coverage");
  });

  it("saved calculator quotes embed the 15G.2 canonical snapshot from the recomputed result", () => {
    expect(source).toContain("buildCanonicalPricingSnapshot");
    expect(source).toContain("canonicalSnapshot: productSnapshot && savedSelectedTier");
    // the action recomputes; posted totals are never trusted (existing contract)
    expect(source).toContain("the action recomputes everything and ignores posted totals");
  });

  it("the calculator performs no Shopify mutations (O: no live price changes possible here)", () => {
    expect(source.includes("admin.graphql")).toBe(false);
    expect(source.includes("productVariantUpdate")).toBe(false);
  });
});
