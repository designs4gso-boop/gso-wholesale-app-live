// Jar COMMERCIAL pricing helpers (2026-10-05 overnight finish-line).
//
// WHY THIS EXISTS. The ERP calculator priced Miron jars from the positional
// margin curve 65/58/52/47/45 % (calculator-emergency.server.ts, commit
// d9e2c8b, 2026-07-24). That curve cites a "GSO 2026 competitor and margin
// study" document that does not exist in the repository; the study document
// that does exist (GSO_ERP_COMPETITOR_MARGIN_STUDY.md, 2026-07-25) contains
// no jar data, and jar market tables were explicitly DEFERRED (owner
// decisions 2026-07-26). The ONLY owner-approved jar price authority in the
// repo is the 16D launch ladder in canonical-jar-pricing.ts (2026-08-12,
// "market-driven by owner decision", used live by the storefront). The curve
// also produced a quantity cliff: 127 jars priced at 65 % ($9.61 each,
// $1,220) while 128 priced at 58 % ($8.00 each, $1,024).
//
// WHAT THIS DOES. For jar sizes with an owner ladder, the commercial
// candidate becomes the OWNER LADDER PRICE (incl. the owner's holographic
// +20 %-of-base and 0X-8X specialty adders) and the existing MINIMUM MARGIN
// PROTECTION (family minimum, never below the 40 % global floor) stays in
// force as a raising-only floor. True manufacturing cost is never touched.
// A quantity-break ENVELOPE then guarantees a customer never pays more in
// total than they would by ordering the next price break.
//
// WHAT THIS DOES NOT DO. It does not lower any margin floor: where the owner
// ladder sits below the floor (today: every Miron tier — e.g. 100ml x128
// ladder $4.50 = 25 % margin vs the 45 % Miron family minimum = $6.11), the
// floor controls and the gap is surfaced for the owner to decide. Chiron has
// no owner ladder and keeps its curve (with the envelope). See
// docs/GSO_JAR_PRICING_AUTHORITY_AUDIT.md.
//
// Client-safe: pure data + pure functions.

import {
  JAR_BASE_PRICES,
  JAR_HOLOGRAPHIC_PCT,
  JAR_PRICING_VERSION,
  JAR_QUANTITY_OPTIONS,
  JAR_SPECIALTY_LADDER,
  JAR_STOREFRONT_MIN_QTY,
  JAR_VOLUME_QUOTE_FROM,
  type JarLaunchSize,
} from "./canonical-jar-pricing";

export const JAR_COMMERCIAL_PRICING_VERSION = "jar-commercial-pricing/1.0.0-2026-10-05";
export const JAR_OWNER_LADDER_SOURCE = `Owner-approved jar price ladder (${JAR_PRICING_VERSION}, 2026-08-12; canonical-jar-pricing.ts) — the storefront price authority`;
export const JAR_OWNER_LADDER_RULE = "Owner jar price ladder (16D, owner-approved 2026-08-12)";
export const JAR_FLOOR_RULE_PREFIX = "Minimum margin protection";
export const QUANTITY_BREAK_ENVELOPE_NOTE = "capped at the next quantity break — ordering more would otherwise cost less";

/** Engine jar size key (jar-active-scope / jar-label-geometry) -> owner ladder size. */
export function jarLaunchSizeForSizeKey(sizeKey: string | null | undefined): JarLaunchSize | null {
  switch (String(sizeKey || "")) {
    case "50ml": return "50ml";
    case "100ml_tall":
    case "100ml_wide": return "100ml";
    case "150ml": return "150ml";
    case "250ml": return "250ml";
    case "3oz": return "3oz";
    case "4oz": return "4oz";
    default: return null;
  }
}

export type JarOwnerLadderQuote = {
  unitPrice: number;
  basePrice: number;
  tierMinQty: number;
  holoAdd: number;
  specialtyX: number;
  specialtyAdd: number;
  launchSize: JarLaunchSize;
  source: string;
  label: string;
};

export type JarOwnerLadderResolution =
  | { ok: true; quote: JarOwnerLadderQuote }
  | { ok: false; reason: "NO_OWNER_LADDER" | "BELOW_LADDER_MINIMUM" | "VOLUME_QUOTE" | "DEEP_BUILD"; message: string };

const money = (n: number) => Math.round(n * 100) / 100;

/**
 * The owner ladder unit price for one jar configuration, or an explicit
 * reason why none applies. Brand matters: only Miron (and the standard
 * 3oz/4oz applied-label jars) have a 16D ladder; Chiron has none.
 */
export function resolveJarOwnerLadder(input: {
  brand: string | null | undefined;
  sizeKey: string | null | undefined;
  quantity: number;
  holographic?: boolean;
  specialtyX?: number;
}): JarOwnerLadderResolution {
  const brand = String(input.brand || "");
  if (brand === "chiron") return { ok: false, reason: "NO_OWNER_LADDER", message: "Chiron jars have no owner price ladder (16D covers Miron and standard applied-label jars only)." };
  const launchSize = jarLaunchSizeForSizeKey(input.sizeKey);
  if (!launchSize) return { ok: false, reason: "NO_OWNER_LADDER", message: `No owner price ladder exists for jar size "${String(input.sizeKey || "")}".` };
  const quantity = Math.floor(Number(input.quantity) || 0);
  if (quantity < JAR_STOREFRONT_MIN_QTY) return { ok: false, reason: "BELOW_LADDER_MINIMUM", message: `The owner ladder starts at ${JAR_STOREFRONT_MIN_QTY} jars.` };
  if (quantity >= JAR_VOLUME_QUOTE_FROM) return { ok: false, reason: "VOLUME_QUOTE", message: `Orders of ${JAR_VOLUME_QUOTE_FROM.toLocaleString()}+ jars are quoted individually (owner rule).` };
  const x = Math.max(0, Math.floor(Number(input.specialtyX) || 0));
  const specialty = JAR_SPECIALTY_LADDER.find((entry) => entry.x === x);
  if (!specialty) return { ok: false, reason: "DEEP_BUILD", message: "Deep Build 9X+ specialty work is quoted individually (owner rule)." };
  const table = JAR_BASE_PRICES[launchSize];
  const tier = [...table].reverse().find((entry) => quantity >= entry.minQty) ?? table[0];
  const holoAdd = input.holographic ? money(tier.priceEach * JAR_HOLOGRAPHIC_PCT) : 0;
  const unitPrice = money(tier.priceEach + holoAdd + specialty.premium);
  return {
    ok: true,
    quote: {
      unitPrice,
      basePrice: tier.priceEach,
      tierMinQty: tier.minQty,
      holoAdd,
      specialtyX: x,
      specialtyAdd: specialty.premium,
      launchSize,
      source: JAR_OWNER_LADDER_SOURCE,
      label: `${JAR_OWNER_LADDER_RULE}: ${launchSize} @ ${tier.minQty}+ = $${tier.priceEach.toFixed(2)}${holoAdd ? ` + holographic $${holoAdd.toFixed(2)}` : ""}${specialty.premium ? ` + ${specialty.label} $${specialty.premium.toFixed(2)}` : ""}`,
    },
  };
}

/**
 * Quantities at which a jar price can step: owner ladder breaks, the
 * legacy margin-band starts (still used by Chiron), and the Miron blank
 * cost tiers. The calculator prices these as hidden SUPPORT rows so the
 * quantity-break envelope has every step it needs for any requested
 * quantity.
 */
export const JAR_PRICE_BREAK_SUPPORT_QUANTITIES: number[] = Array.from(new Set([
  ...JAR_QUANTITY_OPTIONS, // 50 100 250 500 1000 2500 (owner ladder)
  128, 256, 640, // legacy margin-band starts (Chiron curve)
  250, 500, 1000, 2500, // Miron blank set cost tiers (MIRON_TIER_MIN_QTYS)
])).sort((a, b) => a - b);

export type EnvelopeRow = {
  quantity: number;
  totalPrice: number | null;
  unitPrice: number | null;
  profit: number | null;
  actualMarginPct: number | null;
  jobCost: number | null;
  /** Minimum margin % protecting this row (family minimum, >= 40). The envelope never caps below cost / (1 - floorPct). */
  floorPct?: number | null;
  draftOnly?: boolean;
  requested?: boolean;
  supportRow?: boolean;
  commercial?: { controllingRule: string; [key: string]: unknown } | null;
  [key: string]: unknown;
};

export type EnvelopeResult = {
  /** The higher quantity whose total capped this row, or null. */
  envelopeCappedTo: number | null;
  /** true when the cap could only be applied down to the margin floor (a vendor cost tier makes the larger order genuinely cheaper). */
  envelopeFloorBound: boolean;
  /** A larger quantity that is cheaper in total even after capping (staff should offer it), or null. */
  cheaperQuantity: number | null;
};

/**
 * QUANTITY-BREAK ENVELOPE. For every priced row, the customer total is capped
 * at the total of any priced row with a larger quantity — but NEVER below the
 * row's own margin floor (cost / (1 - floorPct)). Rows are only ever lowered,
 * so no minimum-profit or margin protection the row already satisfied is
 * lost. Where the floor binds (the Miron blank set cost drops at 250 / 500 /
 * 1000 / 2500, so a larger order can be genuinely cheaper), the residual
 * step is reported as `cheaperQuantity` so staff can offer the larger order
 * instead. Blocked rows are untouched. Pure: input objects are not mutated.
 */
export function applyQuantityBreakEnvelope<T extends EnvelopeRow>(rows: T[]): Array<T & EnvelopeResult> {
  const sorted = [...rows].sort((a, b) => a.quantity - b.quantity);
  return sorted.map((row) => {
    const none: EnvelopeResult = { envelopeCappedTo: null, envelopeFloorBound: false, cheaperQuantity: null };
    if (row.draftOnly || row.totalPrice == null || row.jobCost == null) return { ...row, ...none };
    let cap: { quantity: number; totalPrice: number } | null = null;
    for (const other of sorted) {
      if (other.quantity <= row.quantity || other.draftOnly || other.totalPrice == null) continue;
      if (other.totalPrice < row.totalPrice - 1e-9 && (!cap || other.totalPrice < cap.totalPrice)) cap = { quantity: other.quantity, totalPrice: other.totalPrice };
    }
    if (!cap) return { ...row, ...none };
    const floorPct = Math.max(0, Math.min(99, Number(row.floorPct ?? 0)));
    const floorTotal = floorPct > 0 ? row.jobCost / (1 - floorPct / 100) : 0;
    const totalPrice = Math.max(cap.totalPrice, floorTotal);
    const floorBound = totalPrice > cap.totalPrice + 1e-9;
    const profit = totalPrice - row.jobCost;
    const note = floorBound
      ? `held at the ${floorPct}% margin floor — ordering ${cap.quantity.toLocaleString()} instead would cost less in total (vendor cost tier)`
      : `${QUANTITY_BREAK_ENVELOPE_NOTE} (${cap.quantity.toLocaleString()})`;
    return {
      ...row,
      totalPrice,
      unitPrice: row.quantity > 0 ? totalPrice / row.quantity : totalPrice,
      profit,
      actualMarginPct: totalPrice > 0 ? (profit / totalPrice) * 100 : 0,
      commercial: row.commercial ? { ...row.commercial, controllingRule: `${row.commercial.controllingRule} · ${note}` } : row.commercial,
      envelopeCappedTo: cap.quantity,
      envelopeFloorBound: floorBound,
      cheaperQuantity: floorBound ? cap.quantity : null,
    };
  });
}

/** Drops hidden support rows (keeps requested + displayed ladder rows). */
export function dropSupportRows<T extends { supportRow?: boolean; requested?: boolean }>(rows: T[]): T[] {
  return rows.filter((row) => !row.supportRow || row.requested);
}

/** Specialty "X" for the owner ladder from the calculator's layer inputs (same convention as 4x5 bags). */
export function jarSpecialtyXFromLayers(input: { glossLayers: number; whiteLayers: number; holographic: boolean }): number {
  const gloss = Math.max(0, Math.floor(Number(input.glossLayers) || 0));
  const white = Math.max(0, Math.floor(Number(input.whiteLayers) || 0));
  // On holographic media the white is the REQUIRED underbase (owner rule: part of the +20 %), not a decorative layer.
  return gloss + (white > 0 && !input.holographic ? 1 : 0);
}
