// Phase 15G.5 — storefront single-price-truth convergence pins.
// The public configurator + checkout price supported stock bags through the
// SAME canonical engine as the ERP; these tests prove the parity matrix,
// finish mapping, tamper resistance, and the old-vs-new delta bands.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalStockBagJob, type CanonicalBagInputs } from "../app/lib/canonical-bag-pricing.server";
import {
  CANONICAL_FINISH_OPTIONS,
  DEEP_BUILD_STOREFRONT_MESSAGE,
  STOREFRONT_PRICE_BREAK_QUANTITIES,
  parseStorefrontFinish,
  priceStorefrontConfiguration,
  round2,
  storefrontPriceBreaks,
} from "../app/lib/storefront-canonical-pricing.server";
import { defaultPricingPolicyValues } from "../app/lib/commercial-pricing-policy.server";
import { FALLBACK_PRICING_ROWS } from "../app/lib/configurator-pricing";

const INPUTS: CanonicalBagInputs = {
  available: true,
  reasons: [],
  matte: { name: "Poseidon Matte", costPerSqft: 213 / 675 },
  holographic: { name: "Holographic", costPerSqft: 0.7141463415 },
  blank: { name: "Blank 4x5 bag (Safe Care)", unitCost: 0.09, tiers: [] },
  rolandSqftPerHour: 150,
  policyValues: defaultPricingPolicyValues(),
};

function storefront(selection: { quantity: number; faces: number; material?: string; finish?: string }) {
  return priceStorefrontConfiguration(INPUTS, {
    quantity: selection.quantity,
    faces: selection.faces,
    material: selection.material || "Matte",
    finish: selection.finish || "No Spot Gloss",
  });
}

describe("finish mapping is deterministic (E)", () => {
  it("maps current and future customer names to exact X counts; 9X+ = Deep Build", () => {
    expect(parseStorefrontFinish("No Spot Gloss")).toEqual({ glossLayers: 0, deepBuild: false });
    expect(parseStorefrontFinish("1X Spot Gloss")).toEqual({ glossLayers: 1, deepBuild: false });
    expect(parseStorefrontFinish("3X Spot Gloss")).toEqual({ glossLayers: 3, deepBuild: false });
    expect(parseStorefrontFinish("Raised Gloss Plus — 3X")).toEqual({ glossLayers: 3, deepBuild: false });
    expect(parseStorefrontFinish("Extreme Raised — 8X")).toEqual({ glossLayers: 8, deepBuild: false });
    expect(parseStorefrontFinish("Spot Gloss")).toEqual({ glossLayers: 1, deepBuild: false });
    expect(parseStorefrontFinish("Deep Build 9X+ — Request Quote").deepBuild).toBe(true);
    expect(parseStorefrontFinish("9X").deepBuild).toBe(true);
    expect(parseStorefrontFinish("")).toEqual({ glossLayers: 0, deepBuild: false });
  });
});

describe("storefront == canonical ERP engine (L parity matrix)", () => {
  const parity = (selection: { quantity: number; faces: number; material?: string; finish?: string }) => {
    const priced = storefront(selection);
    if (!priced.ok) throw new Error(`unpriceable: ${JSON.stringify(selection)}`);
    const holographic = /holo/i.test(selection.material || "Matte");
    const job = canonicalStockBagJob(INPUTS, {
      quantity: selection.quantity,
      faces: selection.faces,
      glossLayers: parseStorefrontFinish(selection.finish || "No Spot Gloss").glossLayers,
      whiteLayers: holographic ? 1 : 0,
      holographic,
    });
    if (!job.available) throw new Error("canonical unavailable");
    expect(priced.unitPrice).toBeCloseTo(round2(job.recommendedTotalPrice / selection.quantity), 10);
    expect(priced.totalPrice).toBeCloseTo(round2(priced.unitPrice * selection.quantity), 10);
    return priced;
  };

  it("standard: 500/1000/2500 front + double match the approved UV ladder exactly", () => {
    expect(parity({ quantity: 500, faces: 1 }).unitPrice).toBeCloseTo(1.05, 10);
    expect(parity({ quantity: 500, faces: 2 }).unitPrice).toBeCloseTo(1.5, 10);
    expect(parity({ quantity: 1000, faces: 1 }).unitPrice).toBeCloseTo(1.05, 10);
    expect(parity({ quantity: 1000, faces: 2 }).unitPrice).toBeCloseTo(1.45, 10);
    expect(parity({ quantity: 2500, faces: 1 }).unitPrice).toBeCloseTo(0.95, 10);
    expect(parity({ quantity: 2500, faces: 2 }).unitPrice).toBeCloseTo(1.32, 10);
  });

  it("specialty 1X/3X/5X/7X at 500 and 1,000 double match the 15G.4C finals (pre-art floors included)", () => {
    const expected: Record<number, Record<number, number>> = {
      500: { 1: 840, 3: 960, 5: 1203.53, 7: 1501.23 },
      1000: { 1: 1624, 3: 1856, 5: 2377.67, 7: 2973.07 },
    };
    for (const quantity of [500, 1000]) {
      for (const stages of [1, 3, 5, 7]) {
        const priced = parity({ quantity, faces: 2, finish: `${stages}X Spot Gloss` });
        expect(priced.totalPrice, `${stages}X @ ${quantity}`).toBeCloseTo(round2(round2(expected[quantity][stages] / quantity) * quantity), 2);
      }
    }
  });

  it("holographic: +20% with the required white underbase bundled (no surcharge), 500/1,000 double", () => {
    const holo500 = parity({ quantity: 500, faces: 2, material: "Holographic" });
    expect(holo500.requiredWhite).toBe(true);
    expect(holo500.totalPrice).toBeCloseTo(900, 2); // 750 x 1.20
    const holo1000 = parity({ quantity: 1000, faces: 2, material: "Holographic" });
    expect(holo1000.totalPrice).toBeCloseTo(1740, 2); // 1450 x 1.20
  });

  it("holo + 3X (white auto-bundled) is floor-controlled pre-art at 1,000 — additive market 2,146 < 40% floor", () => {
    const combo = parity({ quantity: 1000, faces: 2, material: "Holographic", finish: "3X Spot Gloss" });
    // cost@90 (holo + required white + 3X + $6.25 gloss setup) = 1,341.80
    // → 40% floor 2,236.34 → unit 2.24 (rounded)
    expect(combo.unitPrice).toBeCloseTo(2.24, 10);
    expect(combo.totalPrice).toBeCloseTo(2240.0, 2);
  });

  it("price breaks follow the approved ladder [50,100,250,500,1000,2500] — no invented 5,000+ break", () => {
    expect(STOREFRONT_PRICE_BREAK_QUANTITIES).toEqual([50, 100, 250, 500, 1000, 2500]);
    const breaks = storefrontPriceBreaks(INPUTS, { faces: 2, material: "Matte", finish: "No Spot Gloss" });
    expect(breaks.map((entry) => entry.minQty)).toEqual([50, 100, 250, 500, 1000, 2500]);
    // 15G.5A: the owner ratified $1.80 at qty-100 double — the 61% margin
    // band now starts at 100, so the market target controls (was $1.93).
    expect(breaks.map((entry) => entry.priceEach)).toEqual([2.7, 1.8, 1.63, 1.5, 1.45, 1.32]);
  });

  it("exact quantities price through the band step function — never silently under the band (D)", () => {
    expect(storefront({ quantity: 300, faces: 2 })).toMatchObject({ ok: true, unitPrice: 1.63 }); // 250-band
    expect(storefront({ quantity: 64, faces: 2 })).toMatchObject({ ok: true, unitPrice: 2.7 }); // band-1
    expect(storefront({ quantity: 999, faces: 2 })).toMatchObject({ ok: true, unitPrice: 1.5 }); // 500-band
  });
});

describe("tamper + safety (M)", () => {
  it("Deep Build 9X+ can never auto-checkout; zero/negative quantities rejected; unsupported inputs fail closed", () => {
    const deep = storefront({ quantity: 1000, faces: 2, finish: "9X" });
    expect(deep).toMatchObject({ ok: false, requestQuote: true, reason: DEEP_BUILD_STOREFRONT_MESSAGE });
    expect(storefront({ quantity: 0, faces: 2 }).ok).toBe(false);
    const broken = priceStorefrontConfiguration({ ...INPUTS, available: false, reasons: ["no material"], matte: null }, { quantity: 500, faces: 2, material: "Matte", finish: "No Spot Gloss" });
    expect(broken.ok).toBe(false);
    expect((broken as any).requestQuote).toBe(false);
  });

  it("checkout never reads a posted price, keeps app-proxy auth + minimum quantity, and mutates no variant prices", () => {
    const checkout = readFileSync("app/routes/apps.wholesale-lite.configurator-checkout.ts", "utf8");
    expect(checkout.includes("rawItem.price")).toBe(false);
    expect(checkout.includes("body.price")).toBe(false);
    expect(checkout).toContain("priceStorefrontConfiguration");
    expect(checkout).toContain("authenticate.public.appProxy");
    expect(checkout).toContain("Math.max(numberValue(rawItem.quantity, minQuantity), minQuantity)");
    expect(checkout.includes("productVariantUpdate")).toBe(false);
    const proxy = readFileSync("app/routes/apps.wholesale-lite.configurator.ts", "utf8");
    expect(proxy).toContain("authenticate.public.appProxy");
    expect(proxy).toContain("priceStorefrontConfiguration");
    expect(proxy.includes("productVariantUpdate")).toBe(false);
    // supported bags never silently fall back to the legacy rule price
    expect(proxy).toContain('pricingSource = "canonical_erp"');
  });

  it("paid-order webhook attributes remain a superset: Material/Finish/Bag Color still written + hidden canonical metadata", () => {
    const checkout = readFileSync("app/routes/apps.wholesale-lite.configurator-checkout.ts", "utf8");
    for (const key of ['key: "Material"', 'key: "Finish"', 'key: "Bag Color"', 'key: "_GSO Canonical"']) {
      expect(checkout).toContain(key);
    }
  });
});

describe("rollout delta awareness (S)", () => {
  it("15G.5A launch calibration: qty-100 double = $1.80 (ratified), min qty 50, 5,000+ = volume quote, finishes 0X-8X", () => {
    expect(storefront({ quantity: 100, faces: 2 })).toMatchObject({ ok: true, unitPrice: 1.8 });
    expect(storefront({ quantity: 100, faces: 1 })).toMatchObject({ ok: true, unitPrice: 1.3 });
    // 5,000+ never gets a fixed online price
    const volume = storefront({ quantity: 5000, faces: 2 });
    expect(volume).toMatchObject({ ok: false, requestQuote: true });
    // small-run safety: 50/100 clear cost + the $75 min-profit floor
    for (const fixture of [
      { quantity: 50, faces: 2 as const, cost: 39.43 },
      { quantity: 100, faces: 2 as const, cost: 67.52 },
    ]) {
      const priced = storefront(fixture);
      if (!priced.ok) throw new Error("unpriceable");
      expect(priced.totalPrice).toBeGreaterThan(fixture.cost + 75);
    }
    // canonical finish ladder served from code — 0X-8X + quote-only deep build
    expect(CANONICAL_FINISH_OPTIONS).toHaveLength(10);
    for (const [index, label] of CANONICAL_FINISH_OPTIONS.entries()) {
      const parsed = parseStorefrontFinish(label);
      if (index < 9) expect(parsed).toEqual({ glossLayers: index, deepBuild: false });
      else expect(parsed.deepBuild).toBe(true);
    }
    // proxy + checkout wire the ladder minimum and canonical options
    const proxySrc = readFileSync("app/routes/apps.wholesale-lite.configurator.ts", "utf8");
    expect(proxySrc).toContain("STOREFRONT_BAG_MIN_QTY");
    expect(proxySrc).toContain("CANONICAL_FINISH_OPTIONS");
    expect(proxySrc).toContain("quantityOptions");
    const checkoutSrc = readFileSync("app/routes/apps.wholesale-lite.configurator-checkout.ts", "utf8");
    expect(checkoutSrc).toContain("STOREFRONT_BAG_MIN_QTY");
  });

  it("legacy pilot matrix vs canonical: documented deltas hold (small-run rise flagged; volume tiers drop slightly)", () => {
    const legacyMatteNoGloss = FALLBACK_PRICING_ROWS.find((row) => row.material === "Matte" && row.finish === "No Spot Gloss")!;
    expect(legacyMatteNoGloss.prices).toEqual([1.75, 1.65, 1.55, 1.45, 1.35]);
    // canonical at representative legacy-range quantities (double-sided)
    expect(storefront({ quantity: 64, faces: 2 })).toMatchObject({ unitPrice: 2.7 }); // vs 1.75 → +54% FLAGGED small-run rise
    expect(storefront({ quantity: 500, faces: 2 })).toMatchObject({ unitPrice: 1.5 }); // vs 1.65 → −9.1%
    expect(storefront({ quantity: 1000, faces: 2 })).toMatchObject({ unitPrice: 1.45 }); // vs 1.55 → −6.5%
    expect(storefront({ quantity: 2500, faces: 2 })).toMatchObject({ unitPrice: 1.32 }); // vs 1.35 → −2.2%
  });
});
