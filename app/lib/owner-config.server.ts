// Owner-config plumbing (15F.0K.1) — validated JSON envelopes stored in
// ErpAdminSetting per docs/GSO_ERP_SETTINGS_OWNERSHIP_PLAN.md. ONE read/write
// path for owner-editable pricing configuration:
//
//   envelope = { schemaVersion: 1, payload, updatedAt, updatedBy, note,
//                previous }   // previous = last-good envelope minus its own
//                             // previous (one-step rollback, no growth)
//
// SAFETY CONTRACT (15F.0K.1 approved scope):
// - Missing row            -> code constants  (source "code_fallback")
// - Corrupt/invalid config -> code constants  (source "invalid_config_fallback")
// - A bad value can never reach pricing: validation is all-or-nothing per key
//   (no partial merges), and every validator rejects non-finite, negative,
//   and out-of-bounds numbers.
// - Writes are shop-scoped (ErpAdminSetting @@unique([shop, key])), record
//   the real session actor, and refuse invalid payloads outright.
//
// K.1 wires exactly THREE keys (minimum gross profit, minimum order totals,
// sticker area-floor bands). minimumUnitPrices is deliberately NOT read from
// config in K.1 — unit-price floors activate in 15F.0K.2 — so even a
// hand-crafted row for that key has no effect. Margin curves, market targets,
// rounding, and override rules also remain code-only until their phases.

import {
  FAMILY_COMMERCIAL_POLICIES,
  MARGIN_CURVE_CONFIGURABLE_KEYS,
  MARGIN_CURVE_VARIANT_BASE,
  MARKET_TARGET_ALLOWED_KEYS,
  STICKER_MARKET_FLOOR_BANDS,
  defaultMarginCurvesValues,
  defaultMarketTargetsValues,
  defaultPricingPolicyValues,
  defaultSpecialtyPricingValues,
  defaultTierLaddersValues,
  type SpecialtyPricingValues,
  type AreaFloorBand,
  type FamilyMarginCurveConfig,
  type FamilyMarketTargets,
  type FamilyMoneyMap,
  type MarginCurvesValues,
  type MarketTargetBand,
  type MarketTargetsValues,
  type PricingPolicyValues,
  type TierLaddersValues,
} from "./commercial-pricing-policy.server";

export const OWNER_CONFIG_CATEGORY = "OwnerConfig";
export const OWNER_CONFIG_SCHEMA_VERSION = 1;
export const OWNER_CONFIG_MIN_NOTE_LENGTH = 5;

export const PRICING_MIN_GROSS_PROFIT_KEY = "ownerConfig.pricing.minimumGrossProfit";
export const PRICING_MIN_ORDER_TOTALS_KEY = "ownerConfig.pricing.minimumOrderTotals";
export const PRICING_AREA_FLOOR_BANDS_KEY = "ownerConfig.pricing.areaFloorBands";
// 15F.0K.2-A: per-family margin bands + display tier ladders.
export const PRICING_MARGIN_CURVES_KEY = "ownerConfig.pricing.marginCurves";
export const PRICING_TIER_LADDERS_KEY = "ownerConfig.pricing.tierLadders";
// 15F.0K.3: verified market targets (bags-4x5 families only).
export const PRICING_MARKET_TARGETS_KEY = "ownerConfig.pricing.marketTargets";
// 15G.4C: specialty commercial pricing (curve/floor/holo/white/minimums).
export const PRICING_SPECIALTY_KEY = "ownerConfig.pricing.specialtyPricing";

// The ONLY keys the resolver reads (pinned by test — unit-price floors are
// still absent on purpose; owner decision K.3-1 keeps them inactive).
export const PRICING_POLICY_KEYS = [
  PRICING_MIN_GROSS_PROFIT_KEY,
  PRICING_MIN_ORDER_TOTALS_KEY,
  PRICING_AREA_FLOOR_BANDS_KEY,
  PRICING_MARGIN_CURVES_KEY,
  PRICING_TIER_LADDERS_KEY,
  PRICING_MARKET_TARGETS_KEY,
  PRICING_SPECIALTY_KEY,
] as const;

export type OwnerConfigSource = "owner_config" | "code_fallback" | "invalid_config_fallback";

export type OwnerConfigEnvelope = {
  schemaVersion: number;
  payload: unknown;
  updatedAt: string;
  updatedBy: string;
  note: string;
  previous: Omit<OwnerConfigEnvelope, "previous"> | null;
};

export type OwnerConfigResolution<T> = {
  key: string;
  value: T; // effective value — validated payload or the code fallback
  source: OwnerConfigSource;
  invalidReason: string | null;
  // Display info for the settings page (null when no row exists or the stored
  // value is not even envelope-shaped).
  envelopeInfo: { updatedAt: string; updatedBy: string; note: string; hasPrevious: boolean } | null;
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const MAX_MONEY_VALUE = 100000;
const MAX_AREA_RATE = 1000;
const MAX_AREA_BANDS = 12;

const KNOWN_FAMILY_KEYS = FAMILY_COMMERCIAL_POLICIES.map((policy) => policy.familyKey);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- payload validators (all-or-nothing; never partial) ----------

// Family money map: EVERY known family key must be present explicitly, each
// value null (candidate disabled — a legitimate current semantic) or a finite
// number > 0 within bounds. Unknown/extra keys reject the whole payload.
export function validateFamilyMoneyMap(payload: unknown): ValidationResult<FamilyMoneyMap> {
  if (!isPlainObject(payload)) return { ok: false, reason: "Payload must be an object of familyKey -> amount." };
  const keys = Object.keys(payload);
  for (const key of keys) {
    if (!KNOWN_FAMILY_KEYS.includes(key)) return { ok: false, reason: `Unknown family key "${key}".` };
  }
  for (const family of KNOWN_FAMILY_KEYS) {
    if (!(family in payload)) return { ok: false, reason: `Missing family key "${family}" — every family must be listed (use null to disable).` };
    const value = (payload as Record<string, unknown>)[family];
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: `"${family}" must be a finite number or null.` };
    if (value <= 0) return { ok: false, reason: `"${family}" must be greater than 0 (use null to disable the minimum).` };
    if (value > MAX_MONEY_VALUE) return { ok: false, reason: `"${family}" exceeds the $${MAX_MONEY_VALUE.toLocaleString()} sanity cap.` };
  }
  const result: FamilyMoneyMap = {};
  for (const family of KNOWN_FAMILY_KEYS) result[family] = (payload as Record<string, number | null>)[family];
  return { ok: true, value: result };
}

// Area floor bands: 1..12 rows; ratePerSqft finite > 0 <= cap; maxSqft
// strictly ascending finite > 0 for every row except the LAST, which must be
// null (open-ended) — exactly the shape of STICKER_MARKET_FLOOR_BANDS.
export function validateAreaFloorBands(payload: unknown): ValidationResult<AreaFloorBand[]> {
  if (!Array.isArray(payload)) return { ok: false, reason: "Payload must be an array of bands." };
  if (payload.length < 1) return { ok: false, reason: "At least one band is required." };
  if (payload.length > MAX_AREA_BANDS) return { ok: false, reason: `No more than ${MAX_AREA_BANDS} bands.` };
  let lastMax = 0;
  const bands: AreaFloorBand[] = [];
  for (let index = 0; index < payload.length; index += 1) {
    const row = payload[index];
    if (!isPlainObject(row)) return { ok: false, reason: `Band ${index + 1} must be an object { maxSqft, ratePerSqft }.` };
    const rate = row.ratePerSqft;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return { ok: false, reason: `Band ${index + 1}: ratePerSqft must be a finite number > 0.` };
    if (rate > MAX_AREA_RATE) return { ok: false, reason: `Band ${index + 1}: ratePerSqft exceeds the $${MAX_AREA_RATE}/sqft sanity cap.` };
    const max = row.maxSqft;
    const isLast = index === payload.length - 1;
    if (isLast) {
      if (max !== null) return { ok: false, reason: "The last band must have maxSqft null (open-ended)." };
    } else {
      if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return { ok: false, reason: `Band ${index + 1}: maxSqft must be a finite number > 0 (only the last band is open-ended).` };
      if (max <= lastMax) return { ok: false, reason: `Band ${index + 1}: maxSqft must be strictly ascending.` };
      lastMax = max;
    }
    bands.push({ maxSqft: isLast ? null : (max as number), ratePerSqft: rate });
  }
  return { ok: true, value: bands };
}

// 15F.0K.2-A margin curves: object { families: { <key>: { familyMinPct,
// bands: [{minQty, targetPct}] } } }. EVERY configurable margin family
// (FAMILY_MARGIN_RULES minus the excluded dtp-pouches/provisional-universal)
// must be present; the ONLY optional extras are the allowlisted variant keys
// (bags-4x5-double). DTP keys and unknowns reject the whole payload. Bands:
// 1..16 rows, integer minQty strictly ascending with the FIRST band at
// minQty 1 (no coverage gap below), targetPct 40..95 and >= familyMinPct,
// familyMinPct 40..95 (the 40% global floor always stands beneath).
const MAX_MARGIN_BANDS = 16;
const MIN_MARGIN_PCT = 40;
const MAX_MARGIN_PCT = 95;
const MAX_LADDER_ENTRIES = 16;
const MAX_LADDER_QTY = 1000000;

function validateCurveEntry(key: string, entry: unknown): ValidationResult<FamilyMarginCurveConfig> {
  if (!isPlainObject(entry)) return { ok: false, reason: `"${key}" must be an object { familyMinPct, bands }.` };
  const familyMinPct = entry.familyMinPct;
  if (typeof familyMinPct !== "number" || !Number.isFinite(familyMinPct) || familyMinPct < MIN_MARGIN_PCT || familyMinPct > MAX_MARGIN_PCT) {
    return { ok: false, reason: `"${key}": familyMinPct must be a number between ${MIN_MARGIN_PCT} and ${MAX_MARGIN_PCT}.` };
  }
  const bands = entry.bands;
  if (!Array.isArray(bands) || bands.length < 1) return { ok: false, reason: `"${key}": bands must be a non-empty array.` };
  if (bands.length > MAX_MARGIN_BANDS) return { ok: false, reason: `"${key}": no more than ${MAX_MARGIN_BANDS} bands.` };
  let lastMinQty = 0;
  const cleanBands = [];
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    if (!isPlainObject(band)) return { ok: false, reason: `"${key}" band ${index + 1} must be an object { minQty, targetPct }.` };
    const minQty = band.minQty;
    if (typeof minQty !== "number" || !Number.isInteger(minQty) || minQty < 1 || minQty > MAX_LADDER_QTY) {
      return { ok: false, reason: `"${key}" band ${index + 1}: minQty must be an integer between 1 and ${MAX_LADDER_QTY.toLocaleString()}.` };
    }
    if (index === 0 && minQty !== 1) return { ok: false, reason: `"${key}": the first band must start at minQty 1 (no quantity may be left without a margin).` };
    if (minQty <= lastMinQty && index > 0) return { ok: false, reason: `"${key}" band ${index + 1}: minQty must be strictly ascending.` };
    const targetPct = band.targetPct;
    if (typeof targetPct !== "number" || !Number.isFinite(targetPct) || targetPct < MIN_MARGIN_PCT || targetPct > MAX_MARGIN_PCT) {
      return { ok: false, reason: `"${key}" band ${index + 1}: targetPct must be a number between ${MIN_MARGIN_PCT} and ${MAX_MARGIN_PCT}.` };
    }
    if (targetPct < familyMinPct) return { ok: false, reason: `"${key}" band ${index + 1}: targetPct ${targetPct} is below the familyMinPct ${familyMinPct}.` };
    cleanBands.push({ minQty, targetPct });
    lastMinQty = minQty;
  }
  return { ok: true, value: { familyMinPct, bands: cleanBands } };
}

export function validateMarginCurves(payload: unknown): ValidationResult<MarginCurvesValues> {
  if (!isPlainObject(payload) || !isPlainObject(payload.families)) return { ok: false, reason: "Payload must be an object { families: { ... } }." };
  const families = payload.families as Record<string, unknown>;
  const allowedOptional = Object.keys(MARGIN_CURVE_VARIANT_BASE);
  for (const key of Object.keys(families)) {
    if (!MARGIN_CURVE_CONFIGURABLE_KEYS.includes(key) && !allowedOptional.includes(key)) {
      return { ok: false, reason: `Unknown or non-configurable margin family "${key}" (DTP and the provisional fallback are code-only).` };
    }
  }
  for (const key of MARGIN_CURVE_CONFIGURABLE_KEYS) {
    if (!(key in families)) return { ok: false, reason: `Missing margin family "${key}" — every configurable family must be listed.` };
  }
  const result: Record<string, FamilyMarginCurveConfig> = {};
  for (const [key, entry] of Object.entries(families)) {
    const validated = validateCurveEntry(key, entry);
    if (!validated.ok) return validated;
    result[key] = validated.value;
  }
  return { ok: true, value: { families: result } };
}

// 15F.0K.2-A tier ladders: { defaultLadder: [qty...], families: { <canonical
// UI family>: [qty...] } } — exactly the six calculator families
// (dtp-bags is code-only and rejected). Ladders: 1..16 strictly ascending
// positive integers.
function validateLadderArray(label: string, value: unknown): ValidationResult<number[]> {
  if (!Array.isArray(value) || value.length < 1) return { ok: false, reason: `${label} must be a non-empty array of quantities.` };
  if (value.length > MAX_LADDER_ENTRIES) return { ok: false, reason: `${label}: no more than ${MAX_LADDER_ENTRIES} quantities.` };
  let last = 0;
  const clean: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const qty = value[index];
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > MAX_LADDER_QTY) {
      return { ok: false, reason: `${label} entry ${index + 1}: quantities must be integers between 1 and ${MAX_LADDER_QTY.toLocaleString()}.` };
    }
    if (qty <= last) return { ok: false, reason: `${label} entry ${index + 1}: quantities must be strictly ascending.` };
    clean.push(qty);
    last = qty;
  }
  return { ok: true, value: clean };
}

export function validateTierLadders(payload: unknown): ValidationResult<TierLaddersValues> {
  if (!isPlainObject(payload)) return { ok: false, reason: "Payload must be an object { defaultLadder, families }." };
  const defaultLadder = validateLadderArray("defaultLadder", payload.defaultLadder);
  if (!defaultLadder.ok) return defaultLadder;
  if (!isPlainObject(payload.families)) return { ok: false, reason: "families must be an object of familyKey -> ladder." };
  const families = payload.families as Record<string, unknown>;
  for (const key of Object.keys(families)) {
    if (!KNOWN_FAMILY_KEYS.includes(key)) return { ok: false, reason: `Unknown or non-configurable ladder family "${key}" (the DTP ladder is code-only).` };
  }
  const result: Record<string, number[]> = {};
  for (const family of KNOWN_FAMILY_KEYS) {
    if (!(family in families)) return { ok: false, reason: `Missing ladder for family "${family}" — every calculator family must be listed.` };
    const ladder = validateLadderArray(`"${family}" ladder`, families[family]);
    if (!ladder.ok) return ladder;
    result[family] = ladder.value;
  }
  return { ok: true, value: { defaultLadder: defaultLadder.value, families: result } };
}

// 15F.0K.3 market targets: { families: { bags-4x5 | bags-4x5-double:
// { active, sourceDate, source, confidence, bands: [{minQty, low, median,
// high, target, negotiationFloor, premiumTarget, crossover?}] } } }.
// EXACTLY the two allowlisted keys — every other family (jars, DTP, direct
// print, labels, banners, specialty, low-confidence) is REJECTED so market
// pricing cannot silently spread. Numeric fields: null or finite > 0
// <= $1000/unit; low <= median <= high; low <= target <= high when present
// (target: null = candidate skipped — the crossover tiers). negotiationFloor
// only needs to be <= high: the researched floor legitimately sits ABOVE
// the collapsing median in the direct-print crossover squeeze. active must
// be a boolean; bands 1..24, integer minQty strictly ascending from 1.
const MAX_MARKET_BANDS = 24;
const MAX_MARKET_UNIT_PRICE = 1000;

function validMarketMoney(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_MARKET_UNIT_PRICE);
}

function validateMarketFamily(key: string, entry: unknown): ValidationResult<FamilyMarketTargets> {
  if (!isPlainObject(entry)) return { ok: false, reason: `"${key}" must be an object { active, sourceDate, source, confidence, bands }.` };
  if (typeof entry.active !== "boolean") return { ok: false, reason: `"${key}": active must be true or false.` };
  const sourceDate = String(entry.sourceDate ?? "").trim();
  const source = String(entry.source ?? "").trim();
  const confidence = String(entry.confidence ?? "").trim();
  if (!sourceDate) return { ok: false, reason: `"${key}": sourceDate is required (when was the market data captured?).` };
  if (!source) return { ok: false, reason: `"${key}": source is required.` };
  if (!confidence || confidence.length > 40) return { ok: false, reason: `"${key}": confidence is required (max 40 chars).` };
  const bands = entry.bands;
  if (!Array.isArray(bands) || bands.length < 1) return { ok: false, reason: `"${key}": bands must be a non-empty array.` };
  if (bands.length > MAX_MARKET_BANDS) return { ok: false, reason: `"${key}": no more than ${MAX_MARKET_BANDS} bands.` };
  let lastMinQty = 0;
  const cleanBands: MarketTargetBand[] = [];
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const where = `"${key}" band ${index + 1}`;
    if (!isPlainObject(band)) return { ok: false, reason: `${where} must be an object.` };
    const minQty = band.minQty;
    if (typeof minQty !== "number" || !Number.isInteger(minQty) || minQty < 1) return { ok: false, reason: `${where}: minQty must be a positive integer.` };
    if (index === 0 && minQty !== 1) return { ok: false, reason: `"${key}": the first band must start at minQty 1.` };
    if (index > 0 && minQty <= lastMinQty) return { ok: false, reason: `${where}: minQty must be strictly ascending.` };
    for (const field of ["low", "median", "high", "target", "negotiationFloor", "premiumTarget"] as const) {
      if (!validMarketMoney(band[field] ?? null)) return { ok: false, reason: `${where}: ${field} must be null or a number between 0 and ${MAX_MARKET_UNIT_PRICE}.` };
    }
    const low = (band.low ?? null) as number | null;
    const median = (band.median ?? null) as number | null;
    const high = (band.high ?? null) as number | null;
    const target = (band.target ?? null) as number | null;
    const negotiationFloor = (band.negotiationFloor ?? null) as number | null;
    if (low != null && median != null && low > median) return { ok: false, reason: `${where}: low must be <= median.` };
    if (median != null && high != null && median > high) return { ok: false, reason: `${where}: median must be <= high.` };
    if (target != null && low != null && target < low) return { ok: false, reason: `${where}: target must be >= market low.` };
    if (target != null && high != null && target > high) return { ok: false, reason: `${where}: target must be <= market high.` };
    // negotiationFloor is GSO's OWN floor, not a market statistic — in the
    // direct-print crossover squeeze it legitimately sits above the entire
    // collapsed market range (research data: single 10k floor 0.61 > high
    // 0.60; double 10k floor 1.04 > high 0.93), so it is bound only by the
    // positivity/cap check above, never by the market band.
    const crossover = band.crossover == null ? null : band.crossover;
    if (crossover !== null && crossover !== "mild" && crossover !== "strong") return { ok: false, reason: `${where}: crossover must be "mild", "strong", or absent.` };
    cleanBands.push({ minQty, low, median, high, target, negotiationFloor, premiumTarget: (band.premiumTarget ?? null) as number | null, crossover });
    lastMinQty = minQty;
  }
  return { ok: true, value: { active: entry.active, sourceDate, source, confidence, bands: cleanBands } };
}

// 15G.4C: specialty commercial pricing — strict, fail-closed. A bad row can
// never zero a premium or drop the floor below 30%.
export function validateSpecialtyPricing(payload: unknown): ValidationResult<SpecialtyPricingValues> {
  if (!isPlainObject(payload)) return { ok: false, reason: "Payload must be an object." };
  const raw = payload as Record<string, any>;
  const curve: Record<number, number> = {};
  if (!isPlainObject(raw.curve)) return { ok: false, reason: "curve must map X levels 1-8 to premium percents." };
  for (let x = 1; x <= 8; x += 1) {
    const pct = (raw.curve as any)[x] ?? (raw.curve as any)[String(x)];
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 200) {
      return { ok: false, reason: `curve[${x}] must be a finite percent 0-200.` };
    }
    curve[x] = pct;
  }
  for (let x = 2; x <= 8; x += 1) {
    if (curve[x] < curve[x - 1]) return { ok: false, reason: "curve must be non-decreasing from 1X to 8X." };
  }
  const floorPct = raw.floorPct;
  if (typeof floorPct !== "number" || !Number.isFinite(floorPct) || floorPct < 30 || floorPct > 60) {
    return { ok: false, reason: "floorPct must be 30-60." };
  }
  const holoPct = raw.holoPct;
  if (typeof holoPct !== "number" || !Number.isFinite(holoPct) || holoPct < 0 || holoPct > 100) {
    return { ok: false, reason: "holoPct must be 0-100." };
  }
  const whitePct = raw.decorativeWhiteLayerPct;
  if (typeof whitePct !== "number" || !Number.isFinite(whitePct) || whitePct < 0 || whitePct > 100) {
    return { ok: false, reason: "decorativeWhiteLayerPct must be 0-100." };
  }
  const minimums = raw.smallRunMinimums;
  if (!isPlainObject(minimums)) return { ok: false, reason: "smallRunMinimums must be an object { lowMin, lowMaxX, highMin }." };
  const lowMin = minimums.lowMin;
  const lowMaxX = minimums.lowMaxX;
  const highMin = minimums.highMin;
  if (typeof lowMin !== "number" || !Number.isFinite(lowMin) || lowMin < 0 || lowMin > 500) return { ok: false, reason: "smallRunMinimums.lowMin must be 0-500." };
  if (typeof highMin !== "number" || !Number.isFinite(highMin) || highMin < lowMin || highMin > 1000) return { ok: false, reason: "smallRunMinimums.highMin must be >= lowMin and <= 1000." };
  if (typeof lowMaxX !== "number" || !Number.isInteger(lowMaxX) || lowMaxX < 1 || lowMaxX > 8) return { ok: false, reason: "smallRunMinimums.lowMaxX must be an integer 1-8." };
  const deepFrom = raw.deepBuildCustomQuoteFrom;
  if (typeof deepFrom !== "number" || !Number.isInteger(deepFrom) || deepFrom < 2 || deepFrom > 20) {
    return { ok: false, reason: "deepBuildCustomQuoteFrom must be an integer 2-20." };
  }
  if (raw.stackingMode !== "additive") return { ok: false, reason: 'stackingMode must be "additive" (compounding is not owner-approved).' };
  return {
    ok: true,
    value: {
      curve,
      floorPct,
      holoPct,
      decorativeWhiteLayerPct: whitePct,
      smallRunMinimums: { lowMin, lowMaxX, highMin },
      stackingMode: "additive",
      deepBuildCustomQuoteFrom: deepFrom,
      preArtCoverageMode: "engine_default_90",
      noPostArtPriceDecrease: true,
    },
  };
}

export function validateMarketTargets(payload: unknown): ValidationResult<MarketTargetsValues> {
  if (!isPlainObject(payload) || !isPlainObject(payload.families)) return { ok: false, reason: "Payload must be an object { families: { ... } }." };
  const families = payload.families as Record<string, unknown>;
  for (const key of Object.keys(families)) {
    if (!MARKET_TARGET_ALLOWED_KEYS.includes(key)) {
      return { ok: false, reason: `Market targets are not allowed for "${key}" — only verified standard 4x5 sticker-applied bag families (${MARKET_TARGET_ALLOWED_KEYS.join(", ")}) may carry market pricing.` };
    }
  }
  for (const key of MARKET_TARGET_ALLOWED_KEYS) {
    if (!(key in families)) return { ok: false, reason: `Missing market-target family "${key}" (set active:false to disable it — never delete the entry).` };
  }
  const result: Record<string, FamilyMarketTargets> = {};
  for (const [key, entry] of Object.entries(families)) {
    const validated = validateMarketFamily(key, entry);
    if (!validated.ok) return validated;
    result[key] = validated.value;
  }
  return { ok: true, value: { families: result } };
}

// ---------- key registry (K.1 + K.2-A + K.3) ----------

export type OwnerConfigKeyDefinition = {
  key: string;
  label: string;
  description: string;
  validate: (payload: unknown) => ValidationResult<unknown>;
  codeFallback: () => unknown;
};

export const OWNER_CONFIG_KEY_DEFINITIONS: OwnerConfigKeyDefinition[] = [
  {
    key: PRICING_MIN_GROSS_PROFIT_KEY,
    label: "Pricing — minimum gross-profit floors ($ per job, by family)",
    description: "Job-level minimum gross-profit candidates. null disables a family's minimum. Code fallback: 15F.0-FINAL provisional values.",
    validate: validateFamilyMoneyMap,
    codeFallback: () => defaultPricingPolicyValues().minimumGrossProfit,
  },
  {
    key: PRICING_MIN_ORDER_TOTALS_KEY,
    label: "Pricing — minimum order totals ($ per job, by family)",
    description: "Job-level minimum order-total candidates. null disables a family's minimum. Code fallback: 15F.0-FINAL provisional values.",
    validate: validateFamilyMoneyMap,
    codeFallback: () => defaultPricingPolicyValues().minimumOrderTotals,
  },
  {
    key: PRICING_AREA_FLOOR_BANDS_KEY,
    label: "Pricing — sticker area market floor bands ($/sqft by total finished sqft)",
    description: "Stickers & Labels area floor: $/sqft banded by total finished sqft, plus full setup recovery. Code fallback: 15F.0-FINAL provisional anchors.",
    validate: validateAreaFloorBands,
    codeFallback: () => STICKER_MARKET_FLOOR_BANDS.map((band) => ({ ...band })),
  },
  {
    key: PRICING_MARGIN_CURVES_KEY,
    label: "Pricing — per-family margin curves (quantity bands)",
    description: "Target margin % by quantity band per margin family, plus the family minimum. DTP and the provisional fallback are code-only. Code fallback: the researched 5-point curves at the Stage-A equivalent bands (1/128/256/640/1000).",
    validate: validateMarginCurves,
    codeFallback: () => defaultMarginCurvesValues(),
  },
  {
    key: PRICING_TIER_LADDERS_KEY,
    label: "Pricing — displayed tier quantity ladders (per calculator family)",
    description: "Default tier-table quantities per calculator family when no manual list is entered. The DTP ladder is code-only. Code fallback: [64, 128, 256, 640, 1000] for every family.",
    validate: validateTierLadders,
    codeFallback: () => defaultTierLaddersValues(),
  },
  {
    key: PRICING_MARKET_TARGETS_KEY,
    label: "Pricing — verified market targets (4x5 sticker-applied bags only)",
    description: "Raising-only market-target price candidate + negotiation-floor display data for bags-4x5 / bags-4x5-double. target null = candidate skipped (crossover tiers). Code fallback: the 2026-07-26 competitor study values, ACTIVE.",
    validate: validateMarketTargets,
    codeFallback: () => defaultMarketTargetsValues(),
  },
  {
    key: PRICING_SPECIALTY_KEY,
    label: "Pricing — UV specialty commercial pricing (15G.4C)",
    description: "Owner-approved specialty tiers over the standard UV base: curve 1X-8X percents, 40% cost-safety floor, holo +20%, decorative white +12%, small-run minimums $35/$60, additive stacking, 9X+ deep-build custom quote. Code fallback: the 2026-08-09 approved policy.",
    validate: validateSpecialtyPricing,
    codeFallback: () => defaultSpecialtyPricingValues(),
  },
];

export function ownerConfigKeyDefinition(key: string): OwnerConfigKeyDefinition | null {
  return OWNER_CONFIG_KEY_DEFINITIONS.find((definition) => definition.key === key) || null;
}

// ---------- envelope parsing (pure; fail-closed to fallback) ----------

function envelopeShapeError(raw: unknown): string | null {
  if (!isPlainObject(raw)) return "Stored value is not an envelope object.";
  if (raw.schemaVersion !== OWNER_CONFIG_SCHEMA_VERSION) return `Unsupported schemaVersion ${String(raw.schemaVersion)} (expected ${OWNER_CONFIG_SCHEMA_VERSION}).`;
  if (!("payload" in raw)) return "Envelope has no payload.";
  if (typeof raw.updatedAt !== "string" || !raw.updatedAt) return "Envelope updatedAt missing.";
  if (typeof raw.updatedBy !== "string" || !raw.updatedBy) return "Envelope updatedBy missing.";
  if (typeof raw.note !== "string") return "Envelope note missing.";
  if (raw.previous !== null && raw.previous !== undefined && !isPlainObject(raw.previous)) return "Envelope previous must be null or an object.";
  return null;
}

export function parseOwnerConfigValue<T>(
  key: string,
  storedValue: string | null | undefined,
  validate: (payload: unknown) => ValidationResult<T>,
  codeFallback: T,
): OwnerConfigResolution<T> & { rawEnvelope: OwnerConfigEnvelope | null } {
  if (storedValue == null || String(storedValue).trim() === "") {
    return { key, value: codeFallback, source: "code_fallback", invalidReason: null, envelopeInfo: null, rawEnvelope: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(storedValue));
  } catch {
    return { key, value: codeFallback, source: "invalid_config_fallback", invalidReason: "Stored value is not valid JSON.", envelopeInfo: null, rawEnvelope: null };
  }
  const shapeError = envelopeShapeError(parsed);
  if (shapeError) {
    return { key, value: codeFallback, source: "invalid_config_fallback", invalidReason: shapeError, envelopeInfo: null, rawEnvelope: null };
  }
  const envelope = parsed as OwnerConfigEnvelope;
  const info = {
    updatedAt: envelope.updatedAt,
    updatedBy: envelope.updatedBy,
    note: envelope.note,
    hasPrevious: envelope.previous != null,
  };
  const validated = validate(envelope.payload);
  if (!validated.ok) {
    return { key, value: codeFallback, source: "invalid_config_fallback", invalidReason: validated.reason, envelopeInfo: info, rawEnvelope: envelope };
  }
  return { key, value: validated.value, source: "owner_config", invalidReason: null, envelopeInfo: info, rawEnvelope: envelope };
}

// ---------- pricing-policy resolver (the ONE read path for the calculator) ----------

export type ResolvedPricingPolicy = {
  values: PricingPolicyValues;
  resolutions: Record<string, OwnerConfigResolution<unknown>>;
};

export async function resolvePricingPolicyConfig(dbClient: any, shop: string): Promise<ResolvedPricingPolicy> {
  const defaults = defaultPricingPolicyValues();
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = await dbClient.erpAdminSetting.findMany({
      where: { shop, key: { in: [...PRICING_POLICY_KEYS] } },
      select: { key: true, value: true },
    });
  } catch {
    // Config storage unreachable must never break pricing — code constants win.
    rows = [];
  }
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const resolutions: Record<string, OwnerConfigResolution<unknown>> = {};
  for (const definition of OWNER_CONFIG_KEY_DEFINITIONS) {
    const { rawEnvelope: _raw, ...resolution } = parseOwnerConfigValue(
      definition.key,
      byKey.get(definition.key),
      definition.validate as (payload: unknown) => ValidationResult<unknown>,
      definition.codeFallback(),
    );
    resolutions[definition.key] = resolution;
  }
  const values: PricingPolicyValues = {
    minimumGrossProfit: resolutions[PRICING_MIN_GROSS_PROFIT_KEY].value as FamilyMoneyMap,
    minimumOrderTotals: resolutions[PRICING_MIN_ORDER_TOTALS_KEY].value as FamilyMoneyMap,
    // Unit-price floors are STILL not configurable (activates in a later
    // approved phase) — always code defaults (all null) regardless of rows.
    minimumUnitPrices: defaults.minimumUnitPrices,
    areaFloorBands: resolutions[PRICING_AREA_FLOOR_BANDS_KEY].value as AreaFloorBand[],
    marginCurves: resolutions[PRICING_MARGIN_CURVES_KEY].value as MarginCurvesValues,
    tierLadders: resolutions[PRICING_TIER_LADDERS_KEY].value as TierLaddersValues,
    marketTargets: resolutions[PRICING_MARKET_TARGETS_KEY].value as MarketTargetsValues,
    specialtyPricing: resolutions[PRICING_SPECIALTY_KEY].value as SpecialtyPricingValues,
  };
  return { values, resolutions };
}

// ---------- write paths (shop-scoped; refuse invalid; keep one-step previous) ----------

function stripPrevious(envelope: OwnerConfigEnvelope): Omit<OwnerConfigEnvelope, "previous"> {
  const { previous: _previous, ...rest } = envelope;
  return rest;
}

// previous = the last GOOD envelope: the current one when its payload still
// validates; otherwise the current one's own previous when THAT validates;
// otherwise null. Invalid history is never resurrected silently.
function previousForSave(
  definition: OwnerConfigKeyDefinition,
  existingValue: string | null | undefined,
): Omit<OwnerConfigEnvelope, "previous"> | null {
  if (existingValue == null) return null;
  const parsed = parseOwnerConfigValue(definition.key, existingValue, definition.validate, definition.codeFallback());
  if (parsed.source === "owner_config" && parsed.rawEnvelope) return stripPrevious(parsed.rawEnvelope);
  const nested = parsed.rawEnvelope?.previous;
  if (nested && definition.validate((nested as OwnerConfigEnvelope).payload).ok) {
    return nested as Omit<OwnerConfigEnvelope, "previous">;
  }
  return null;
}

export async function saveOwnerConfigKey(dbClient: any, params: {
  shop: string;
  key: string;
  payload: unknown;
  note: string;
  actor: string;
}): Promise<{ ok: boolean; message: string }> {
  const definition = ownerConfigKeyDefinition(params.key);
  if (!definition) return { ok: false, message: `Unknown owner-config key "${params.key}".` };
  const note = String(params.note || "").trim();
  if (note.length < OWNER_CONFIG_MIN_NOTE_LENGTH) {
    return { ok: false, message: `A source note (at least ${OWNER_CONFIG_MIN_NOTE_LENGTH} characters) is required — record why the value changed.` };
  }
  const actor = String(params.actor || "").trim();
  if (!actor) return { ok: false, message: "Actor is required." };
  const validated = definition.validate(params.payload);
  if (!validated.ok) return { ok: false, message: `Not saved — ${validated.reason}` };

  const existing = await dbClient.erpAdminSetting.findUnique({
    where: { shop_key: { shop: params.shop, key: definition.key } },
    select: { value: true },
  });
  const envelope: OwnerConfigEnvelope = {
    schemaVersion: OWNER_CONFIG_SCHEMA_VERSION,
    payload: validated.value,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
    note,
    previous: previousForSave(definition, existing?.value),
  };
  await dbClient.erpAdminSetting.upsert({
    where: { shop_key: { shop: params.shop, key: definition.key } },
    update: { value: JSON.stringify(envelope), label: definition.label, category: OWNER_CONFIG_CATEGORY, valueType: "json", description: definition.description },
    create: {
      shop: params.shop,
      category: OWNER_CONFIG_CATEGORY,
      key: definition.key,
      label: definition.label,
      value: JSON.stringify(envelope),
      valueType: "json",
      description: definition.description,
    },
  });
  return { ok: true, message: `${definition.label} saved.` };
}

export async function restoreOwnerConfigPrevious(dbClient: any, params: {
  shop: string;
  key: string;
  actor: string;
}): Promise<{ ok: boolean; message: string }> {
  const definition = ownerConfigKeyDefinition(params.key);
  if (!definition) return { ok: false, message: `Unknown owner-config key "${params.key}".` };
  const actor = String(params.actor || "").trim();
  if (!actor) return { ok: false, message: "Actor is required." };
  const existing = await dbClient.erpAdminSetting.findUnique({
    where: { shop_key: { shop: params.shop, key: definition.key } },
    select: { value: true },
  });
  if (!existing?.value) return { ok: false, message: "Nothing to restore — no stored configuration for this key." };
  let current: unknown;
  try {
    current = JSON.parse(String(existing.value));
  } catch {
    return { ok: false, message: "Stored value is not a valid envelope — save a fresh value or reset to code defaults instead." };
  }
  const shapeError = envelopeShapeError(current);
  if (shapeError) return { ok: false, message: `Cannot restore: ${shapeError}` };
  const currentEnvelope = current as OwnerConfigEnvelope;
  const previous = currentEnvelope.previous;
  if (!previous) return { ok: false, message: "No previous version is stored for this key." };
  const validated = definition.validate((previous as OwnerConfigEnvelope).payload);
  if (!validated.ok) return { ok: false, message: `The previous version is invalid and was not restored — ${validated.reason}` };

  const envelope: OwnerConfigEnvelope = {
    schemaVersion: OWNER_CONFIG_SCHEMA_VERSION,
    payload: validated.value,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
    note: `Restored previous version (was "${String((previous as OwnerConfigEnvelope).note || "").slice(0, 120)}")`,
    previous: stripPrevious(currentEnvelope),
  };
  await dbClient.erpAdminSetting.update({
    where: { shop_key: { shop: params.shop, key: definition.key } },
    data: { value: JSON.stringify(envelope) },
  });
  return { ok: true, message: `${definition.label} restored to the previous version.` };
}

export async function clearOwnerConfigKey(dbClient: any, params: {
  shop: string;
  key: string;
}): Promise<{ ok: boolean; message: string }> {
  const definition = ownerConfigKeyDefinition(params.key);
  if (!definition) return { ok: false, message: `Unknown owner-config key "${params.key}".` };
  const result = await dbClient.erpAdminSetting.deleteMany({ where: { shop: params.shop, key: definition.key } });
  return result?.count
    ? { ok: true, message: `${definition.label} cleared — pricing uses the code defaults again.` }
    : { ok: false, message: "Nothing to clear — this key already uses the code defaults." };
}
