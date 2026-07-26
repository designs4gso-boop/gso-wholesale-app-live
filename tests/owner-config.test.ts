// 15F.0K.1 owner-config plumbing tests: envelope validation, fail-closed
// fallbacks, one-step rollback, shop-scoped writes, K.1 key-scope pins, and
// the byte-for-byte pricing equivalence contract (no config = code constants).

import { describe, expect, it } from "vitest";

import {
  OWNER_CONFIG_CATEGORY,
  OWNER_CONFIG_KEY_DEFINITIONS,
  PRICING_AREA_FLOOR_BANDS_KEY,
  PRICING_MARGIN_CURVES_KEY,
  PRICING_MARKET_TARGETS_KEY,
  PRICING_MIN_GROSS_PROFIT_KEY,
  PRICING_MIN_ORDER_TOTALS_KEY,
  PRICING_POLICY_KEYS,
  PRICING_TIER_LADDERS_KEY,
  clearOwnerConfigKey,
  parseOwnerConfigValue,
  resolvePricingPolicyConfig,
  restoreOwnerConfigPrevious,
  saveOwnerConfigKey,
  validateAreaFloorBands,
  validateFamilyMoneyMap,
  validateMarginCurves,
  validateTierLadders,
} from "../app/lib/owner-config.server";
import {
  FAMILY_COMMERCIAL_POLICIES,
  STICKER_MARKET_FLOOR_BANDS,
  combineStickerLines,
  computeCommercialPrice,
  defaultMarginCurvesValues,
  defaultPricingPolicyValues,
  defaultTierLaddersValues,
} from "../app/lib/commercial-pricing-policy.server";
import { resolveMarginFamily } from "../app/lib/calculator-emergency.server";

const SHOP = "test-shop.myshopify.com";

function fakeDb(seedRows: Array<{ shop: string; key: string; value: string }> = []) {
  const rows = new Map<string, any>();
  for (const row of seedRows) rows.set(`${row.shop}|${row.key}`, { ...row });
  return {
    rows,
    erpAdminSetting: {
      findMany: async ({ where }: any) =>
        [...rows.values()]
          .filter((row) => row.shop === where.shop && (where.key?.in ?? []).includes(row.key))
          .map(({ key, value }) => ({ key, value })),
      findUnique: async ({ where }: any) => {
        const row = rows.get(`${where.shop_key.shop}|${where.shop_key.key}`);
        return row ? { value: row.value } : null;
      },
      upsert: async ({ where, create, update }: any) => {
        const id = `${where.shop_key.shop}|${where.shop_key.key}`;
        const existing = rows.get(id);
        if (existing) Object.assign(existing, update);
        else rows.set(id, { ...create });
        return rows.get(id);
      },
      update: async ({ where, data }: any) => {
        const id = `${where.shop_key.shop}|${where.shop_key.key}`;
        const existing = rows.get(id);
        if (!existing) throw new Error("row not found");
        Object.assign(existing, data);
        return existing;
      },
      deleteMany: async ({ where }: any) => {
        const id = `${where.shop}|${where.key}`;
        return { count: rows.delete(id) ? 1 : 0 };
      },
    },
  };
}

const validEnvelope = (payload: unknown, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, payload, updatedAt: "2026-07-26T00:00:00.000Z", updatedBy: "seed@test", note: "seed note", previous: null, ...overrides });

describe("owner-config defaults mirror the code constants exactly", () => {
  it("defaultPricingPolicyValues reproduces FAMILY_COMMERCIAL_POLICIES field-for-field", () => {
    const defaults = defaultPricingPolicyValues();
    for (const policy of FAMILY_COMMERCIAL_POLICIES) {
      expect(defaults.minimumGrossProfit[policy.familyKey]).toBe(policy.minimumGrossProfit);
      expect(defaults.minimumOrderTotals[policy.familyKey]).toBe(policy.minimumOrderTotal);
      expect(defaults.minimumUnitPrices[policy.familyKey]).toBe(policy.minimumUnitPrice);
    }
    expect(Object.keys(defaults.minimumGrossProfit)).toHaveLength(FAMILY_COMMERCIAL_POLICIES.length);
    expect(defaults.areaFloorBands).toEqual(STICKER_MARKET_FLOOR_BANDS);
    // fresh copies, never the shared constant objects
    expect(defaults.areaFloorBands[0]).not.toBe(STICKER_MARKET_FLOOR_BANDS[0]);
  });

  it("K.1+K.2-A+K.3 reads exactly six keys — unit-price floors are STILL not configurable (owner decision K.3-1)", () => {
    expect([...PRICING_POLICY_KEYS]).toEqual([
      PRICING_MIN_GROSS_PROFIT_KEY,
      PRICING_MIN_ORDER_TOTALS_KEY,
      PRICING_AREA_FLOOR_BANDS_KEY,
      PRICING_MARGIN_CURVES_KEY,
      PRICING_TIER_LADDERS_KEY,
      PRICING_MARKET_TARGETS_KEY,
    ]);
    expect(OWNER_CONFIG_KEY_DEFINITIONS.map((definition) => definition.key)).toEqual([...PRICING_POLICY_KEYS]);
  });

  it("15F.0K.2-A validators: accept the Stage-A defaults, reject DTP keys, malformed bands, and gap-below-1 curves", () => {
    expect(validateMarginCurves(defaultMarginCurvesValues()).ok).toBe(true);
    expect(validateTierLadders(defaultTierLaddersValues()).ok).toBe(true);

    const good = () => defaultMarginCurvesValues();
    // DTP + provisional are code-only; unknown keys reject
    for (const forbidden of ["dtp-pouches", "provisional-universal", "not-a-family"]) {
      const withKey: any = good();
      withKey.families[forbidden] = { familyMinPct: 40, bands: [{ minQty: 1, targetPct: 50 }] };
      expect(validateMarginCurves(withKey).ok).toBe(false);
    }
    // missing required family rejects
    const missing: any = good();
    delete missing.families["banners"];
    expect(validateMarginCurves(missing).ok).toBe(false);
    // first band must start at minQty 1 (coverage), ascending, pct bounds, >= familyMin
    const startAt64: any = good();
    startAt64.families["bags-4x5"].bands[0].minQty = 64;
    expect(validateMarginCurves(startAt64).ok).toBe(false);
    const descending: any = good();
    descending.families["bags-4x5"].bands[2].minQty = 5;
    expect(validateMarginCurves(descending).ok).toBe(false);
    const belowFloor: any = good();
    belowFloor.families["bags-4x5"].bands[0].targetPct = 30;
    expect(validateMarginCurves(belowFloor).ok).toBe(false);
    const belowFamilyMin: any = good();
    belowFamilyMin.families["bags-4x5"].bands[4].targetPct = 44; // familyMinPct 45
    expect(validateMarginCurves(belowFamilyMin).ok).toBe(false);
    const nanMin: any = good();
    nanMin.families["boxes"].familyMinPct = Number.NaN;
    expect(validateMarginCurves(nanMin).ok).toBe(false);
    // optional variant key IS accepted when valid
    const withVariant: any = good();
    withVariant.families["bags-4x5-double"] = { familyMinPct: 40, bands: [{ minQty: 1, targetPct: 61 }, { minQty: 1000, targetPct: 52 }] };
    expect(validateMarginCurves(withVariant).ok).toBe(true);

    // ladders: dtp-bags rejected; non-ascending, floats, missing family reject
    const ladderDtp: any = defaultTierLaddersValues();
    ladderDtp.families["dtp-bags"] = [1000, 2500];
    expect(validateTierLadders(ladderDtp).ok).toBe(false);
    const ladderDescending: any = defaultTierLaddersValues();
    ladderDescending.families["sticker-bags"] = [64, 32];
    expect(validateTierLadders(ladderDescending).ok).toBe(false);
    const ladderFloat: any = defaultTierLaddersValues();
    ladderFloat.families["banners"] = [64, 128.5];
    expect(validateTierLadders(ladderFloat).ok).toBe(false);
    const ladderMissing: any = defaultTierLaddersValues();
    delete ladderMissing.families["custom-item"];
    expect(validateTierLadders(ladderMissing).ok).toBe(false);
    const ladderEmpty: any = defaultTierLaddersValues();
    ladderEmpty.families["banners"] = [];
    expect(validateTierLadders(ladderEmpty).ok).toBe(false);
  });
});

describe("payload validators (all-or-nothing, never unsafe values)", () => {
  const goodMoney = () => defaultPricingPolicyValues().minimumGrossProfit;

  it("accepts the exact code-default money map", () => {
    const result = validateFamilyMoneyMap(goodMoney());
    expect(result.ok).toBe(true);
  });

  it("rejects negative, zero, NaN, Infinity, over-cap, unknown and missing families, and non-objects", () => {
    for (const bad of [
      { ...goodMoney(), "sticker-bags": -5 },
      { ...goodMoney(), "sticker-bags": 0 },
      { ...goodMoney(), "sticker-bags": Number.NaN },
      { ...goodMoney(), "sticker-bags": Number.POSITIVE_INFINITY },
      { ...goodMoney(), "sticker-bags": 999999 },
      { ...goodMoney(), "not-a-family": 10 },
    ]) {
      expect(validateFamilyMoneyMap(bad).ok).toBe(false);
    }
    const missing: any = goodMoney();
    delete missing["banners"];
    expect(validateFamilyMoneyMap(missing).ok).toBe(false);
    expect(validateFamilyMoneyMap(null).ok).toBe(false);
    expect(validateFamilyMoneyMap([1, 2]).ok).toBe(false);
    expect(validateFamilyMoneyMap("75").ok).toBe(false);
  });

  it("null disables a family minimum and is accepted (current live semantic)", () => {
    const payload = { ...goodMoney(), "sticker-bags": null };
    const result = validateFamilyMoneyMap(payload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value["sticker-bags"]).toBeNull();
  });

  it("accepts the exact code-default area bands and rejects malformed band sets", () => {
    expect(validateAreaFloorBands(STICKER_MARKET_FLOOR_BANDS).ok).toBe(true);
    expect(validateAreaFloorBands([]).ok).toBe(false);
    expect(validateAreaFloorBands("bands").ok).toBe(false);
    expect(validateAreaFloorBands([{ maxSqft: 10, ratePerSqft: 8 }]).ok).toBe(false); // last must be null
    expect(validateAreaFloorBands([{ maxSqft: null, ratePerSqft: 8 }, { maxSqft: null, ratePerSqft: 3 }]).ok).toBe(false); // middle null
    expect(validateAreaFloorBands([{ maxSqft: 25, ratePerSqft: 8 }, { maxSqft: 10, ratePerSqft: 6 }, { maxSqft: null, ratePerSqft: 3 }]).ok).toBe(false); // descending
    expect(validateAreaFloorBands([{ maxSqft: 10, ratePerSqft: 0 }, { maxSqft: null, ratePerSqft: 3 }]).ok).toBe(false); // zero rate
    expect(validateAreaFloorBands([{ maxSqft: 10, ratePerSqft: Number.NaN }, { maxSqft: null, ratePerSqft: 3 }]).ok).toBe(false); // NaN rate
    expect(validateAreaFloorBands([{ maxSqft: 10, ratePerSqft: 5000 }, { maxSqft: null, ratePerSqft: 3 }]).ok).toBe(false); // over cap
    expect(validateAreaFloorBands(Array.from({ length: 13 }, (_v, index) => ({ maxSqft: index === 12 ? null : index + 1, ratePerSqft: 1 }))).ok).toBe(false); // too many
  });
});

describe("envelope parsing fails closed to the code fallback", () => {
  const definition = OWNER_CONFIG_KEY_DEFINITIONS[0];
  const fallback = definition.codeFallback();

  it("missing row -> code_fallback with exact defaults", () => {
    const result = parseOwnerConfigValue(definition.key, null, definition.validate, fallback);
    expect(result.source).toBe("code_fallback");
    expect(result.value).toEqual(fallback);
    expect(result.invalidReason).toBeNull();
  });

  it("corrupt JSON, wrong schemaVersion, missing envelope fields, and invalid payloads -> invalid_config_fallback with defaults", () => {
    const cases: Array<[string, string]> = [
      ["{not json", "not valid JSON"],
      [JSON.stringify({ schemaVersion: 2, payload: {}, updatedAt: "x", updatedBy: "y", note: "", previous: null }), "schemaVersion"],
      [JSON.stringify({ schemaVersion: 1, payload: {}, updatedAt: "", updatedBy: "y", note: "", previous: null }), "updatedAt"],
      [validEnvelope({ "sticker-bags": -1 }), "must"],
    ];
    for (const [stored, reasonFragment] of cases) {
      const result = parseOwnerConfigValue(definition.key, stored, definition.validate, definition.codeFallback());
      expect(result.source).toBe("invalid_config_fallback");
      expect(result.value).toEqual(definition.codeFallback());
      expect(String(result.invalidReason)).toContain(reasonFragment.split(" ")[0]);
    }
  });

  it("valid envelope -> owner_config with envelope info", () => {
    const payload = defaultPricingPolicyValues().minimumGrossProfit;
    const result = parseOwnerConfigValue(definition.key, validEnvelope(payload), definition.validate, fallback);
    expect(result.source).toBe("owner_config");
    expect(result.value).toEqual(payload);
    expect(result.envelopeInfo).toMatchObject({ updatedBy: "seed@test", hasPrevious: false });
  });
});

describe("resolvePricingPolicyConfig", () => {
  it("empty db -> every key code_fallback and values equal the code defaults", async () => {
    const resolved = await resolvePricingPolicyConfig(fakeDb(), SHOP);
    expect(resolved.values).toEqual(defaultPricingPolicyValues());
    for (const key of PRICING_POLICY_KEYS) expect(resolved.resolutions[key].source).toBe("code_fallback");
  });

  it("valid stored config wins; invalid stored config falls back; other shops never leak", async () => {
    const custom = { ...defaultPricingPolicyValues().minimumGrossProfit, "sticker-bags": 123 };
    const db = fakeDb([
      { shop: SHOP, key: PRICING_MIN_GROSS_PROFIT_KEY, value: validEnvelope(custom) },
      { shop: SHOP, key: PRICING_AREA_FLOOR_BANDS_KEY, value: "{corrupt" },
      { shop: "other-shop.myshopify.com", key: PRICING_MIN_ORDER_TOTALS_KEY, value: validEnvelope({}) },
    ]);
    const resolved = await resolvePricingPolicyConfig(db, SHOP);
    expect(resolved.values.minimumGrossProfit["sticker-bags"]).toBe(123);
    expect(resolved.resolutions[PRICING_MIN_GROSS_PROFIT_KEY].source).toBe("owner_config");
    expect(resolved.values.areaFloorBands).toEqual(STICKER_MARKET_FLOOR_BANDS);
    expect(resolved.resolutions[PRICING_AREA_FLOOR_BANDS_KEY].source).toBe("invalid_config_fallback");
    expect(resolved.resolutions[PRICING_MIN_ORDER_TOTALS_KEY].source).toBe("code_fallback");
  });

  it("a rogue minimumUnitPrices row is ignored in K.1 (unit floors stay code defaults, all null)", async () => {
    const db = fakeDb([
      { shop: SHOP, key: "ownerConfig.pricing.minimumUnitPrices", value: validEnvelope({ "sticker-bags": 1.22 }) },
    ]);
    const resolved = await resolvePricingPolicyConfig(db, SHOP);
    expect(resolved.values.minimumUnitPrices).toEqual(defaultPricingPolicyValues().minimumUnitPrices);
    expect(Object.values(resolved.values.minimumUnitPrices).every((value) => value === null)).toBe(true);
    expect(resolved.resolutions["ownerConfig.pricing.minimumUnitPrices"]).toBeUndefined();
  });

  it("config storage failure -> code defaults (pricing never breaks)", async () => {
    const broken = { erpAdminSetting: { findMany: async () => { throw new Error("db down"); } } };
    const resolved = await resolvePricingPolicyConfig(broken, SHOP);
    expect(resolved.values).toEqual(defaultPricingPolicyValues());
  });
});

describe("save / restore / clear (shop-scoped, audited, one-step rollback)", () => {
  const moneyPayload = (profit: number) => ({ ...defaultPricingPolicyValues().minimumGrossProfit, "sticker-bags": profit });

  it("save refuses short notes, missing actor, and invalid payloads", async () => {
    const db = fakeDb();
    expect((await saveOwnerConfigKey(db, { shop: SHOP, key: PRICING_MIN_GROSS_PROFIT_KEY, payload: moneyPayload(30), note: "ok", actor: "a@b" })).ok).toBe(false);
    expect((await saveOwnerConfigKey(db, { shop: SHOP, key: PRICING_MIN_GROSS_PROFIT_KEY, payload: moneyPayload(30), note: "valid note", actor: "" })).ok).toBe(false);
    expect((await saveOwnerConfigKey(db, { shop: SHOP, key: PRICING_MIN_GROSS_PROFIT_KEY, payload: moneyPayload(-4), note: "valid note", actor: "a@b" })).ok).toBe(false);
    expect((await saveOwnerConfigKey(db, { shop: SHOP, key: "ownerConfig.pricing.unknown", payload: {}, note: "valid note", actor: "a@b" })).ok).toBe(false);
    expect(db.rows.size).toBe(0);
  });

  it("first save creates the envelope; second save keeps ONE stripped previous; restore swaps back", async () => {
    const db = fakeDb();
    const first = await saveOwnerConfigKey(db, { shop: SHOP, key: PRICING_MIN_GROSS_PROFIT_KEY, payload: moneyPayload(30), note: "first save", actor: "owner@gso" });
    expect(first.ok).toBe(true);
    const row1 = db.rows.get(`${SHOP}|${PRICING_MIN_GROSS_PROFIT_KEY}`);
    expect(row1.category).toBe(OWNER_CONFIG_CATEGORY);
    expect(row1.valueType).toBe("json");
    const envelope1 = JSON.parse(row1.value);
    expect(envelope1).toMatchObject({ schemaVersion: 1, updatedBy: "owner@gso", note: "first save", previous: null });
    expect(envelope1.payload["sticker-bags"]).toBe(30);

    const second = await saveOwnerConfigKey(db, { shop: SHOP, key: PRICING_MIN_GROSS_PROFIT_KEY, payload: moneyPayload(45), note: "second save", actor: "owner@gso" });
    expect(second.ok).toBe(true);
    const envelope2 = JSON.parse(db.rows.get(`${SHOP}|${PRICING_MIN_GROSS_PROFIT_KEY}`).value);
    expect(envelope2.payload["sticker-bags"]).toBe(45);
    expect(envelope2.previous.payload["sticker-bags"]).toBe(30);
    expect(envelope2.previous.previous).toBeUndefined(); // one step only — no unbounded growth

    const restored = await restoreOwnerConfigPrevious(db, { shop: SHOP, key: PRICING_MIN_GROSS_PROFIT_KEY, actor: "owner@gso" });
    expect(restored.ok).toBe(true);
    const envelope3 = JSON.parse(db.rows.get(`${SHOP}|${PRICING_MIN_GROSS_PROFIT_KEY}`).value);
    expect(envelope3.payload["sticker-bags"]).toBe(30);
    expect(envelope3.previous.payload["sticker-bags"]).toBe(45); // toggle back stays possible
    expect(envelope3.note).toContain("Restored previous version");
  });

  it("restore refuses when there is no row or no previous; clear removes the row and reports the second attempt", async () => {
    const db = fakeDb();
    expect((await restoreOwnerConfigPrevious(db, { shop: SHOP, key: PRICING_MIN_ORDER_TOTALS_KEY, actor: "a@b" })).ok).toBe(false);
    await saveOwnerConfigKey(db, { shop: SHOP, key: PRICING_MIN_ORDER_TOTALS_KEY, payload: defaultPricingPolicyValues().minimumOrderTotals, note: "initial save", actor: "a@b" });
    expect((await restoreOwnerConfigPrevious(db, { shop: SHOP, key: PRICING_MIN_ORDER_TOTALS_KEY, actor: "a@b" })).ok).toBe(false); // previous null
    expect((await clearOwnerConfigKey(db, { shop: SHOP, key: PRICING_MIN_ORDER_TOTALS_KEY })).ok).toBe(true);
    expect(db.rows.size).toBe(0);
    expect((await clearOwnerConfigKey(db, { shop: SHOP, key: PRICING_MIN_ORDER_TOTALS_KEY })).ok).toBe(false);
  });
});

describe("pricing equivalence: no config (or defaults passed) is byte-identical", () => {
  const stickers = resolveMarginFamily("stickers-labels")!;
  const bags = resolveMarginFamily("bags-4x5")!;
  const defaults = defaultPricingPolicyValues();

  const CASES = [
    // cost-based controls (100 x 3x3 forensic fixture shape)
    { familyKey: "stickers-labels", quantity: 100, completeCost: 21.158395, marginRule: stickers, premiumEligible: false, finishedSqft: 6.25, setupTotal: 25 / 3 + 1 },
    // area floor controls (volume stickers)
    { familyKey: "stickers-labels", quantity: 1000, completeCost: 117.34, marginRule: stickers, premiumEligible: false, finishedSqft: 62.5, setupTotal: 25 / 3 + 1 },
    // minimum order total controls (tiny cheap sticker order)
    { familyKey: "stickers-labels", quantity: 5, completeCost: 3, marginRule: stickers, premiumEligible: false, finishedSqft: 0.5, setupTotal: 2 },
    // minimum gross profit controls (bags family)
    { familyKey: "sticker-bags", quantity: 64, completeCost: 33, marginRule: bags, premiumEligible: false, finishedSqft: 0, setupTotal: 9.33 },
    // premium finish floor
    { familyKey: "stickers-labels", quantity: 256, completeCost: 80, marginRule: stickers, premiumEligible: true, finishedSqft: 16, setupTotal: 9.33 },
    // suppressed job minimums (multi-line per-line call shape)
    { familyKey: "stickers-labels", quantity: 50, completeCost: 10, marginRule: stickers, premiumEligible: false, finishedSqft: 3, setupTotal: 5, suppressJobMinimums: true },
    // family with NO commercial policy entry (dtp-bags) — minimums all skipped
    { familyKey: "dtp-bags", quantity: 1000, completeCost: 1083, marginRule: null, premiumEligible: false, finishedSqft: 0, setupTotal: 0 },
  ] as const;

  it("computeCommercialPrice(input) === computeCommercialPrice(input + explicit defaults) across representative cases", () => {
    for (const testCase of CASES) {
      const withoutValues = computeCommercialPrice({ ...testCase });
      const withDefaults = computeCommercialPrice({ ...testCase, policyValues: defaults });
      expect(withDefaults).toEqual(withoutValues);
    }
  });

  it("combineStickerLines equivalence on a two-line job (with per-line premium)", () => {
    const lines = [
      { name: "Line 1", quantity: 300, designs: 1, glossOrWhite: false, lineCost: 42.5, missing: [], fieldErrors: [], finishedSqft: 18.75, setupTotal: 9.33 },
      { name: "Line 2", quantity: 120, designs: 2, glossOrWhite: true, lineCost: 30.1, missing: [], fieldErrors: [], finishedSqft: 7.5, setupTotal: 18.67 },
    ];
    const withoutValues = combineStickerLines({ lines, jobPackingCost: 2, marginRule: stickers });
    const withDefaults = combineStickerLines({ lines, jobPackingCost: 2, marginRule: stickers, policyValues: defaults });
    expect(withDefaults).toEqual(withoutValues);
  });

  it("edited config values actually flow through (wiring proof — direction only, no fixture changes)", () => {
    const custom = defaultPricingPolicyValues();
    custom.minimumOrderTotals["stickers-labels"] = 500;
    const result = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 5, completeCost: 3, marginRule: stickers, premiumEligible: false, finishedSqft: 0.5, setupTotal: 2, policyValues: custom });
    expect(result.finalTotalPrice).toBe(500);
    expect(result.controllingRule).toContain("Minimum order total");

    const customBands = defaultPricingPolicyValues();
    customBands.areaFloorBands = [{ maxSqft: null, ratePerSqft: 100 }];
    const floorControlled = computeCommercialPrice({ familyKey: "stickers-labels", quantity: 100, completeCost: 21.158395, marginRule: stickers, premiumEligible: false, finishedSqft: 6.25, setupTotal: 0, policyValues: customBands });
    expect(floorControlled.finalTotalPrice).toBeCloseTo(625, 6);
    expect(floorControlled.controllingRule).toContain("market floor");
  });
});
