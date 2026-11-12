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
// OWNER DECISION 2026-11-11 (previously approved): the owner ladder price is
// AUTHORITATIVE. The generic family margin floor (Miron 45% / Chiron 40%) no
// longer raises a ladder price — realized margin below the generic target is
// an owner-only informational warning. The floor still protects prices that
// have NO approved ladder (below 50, 5,000+, unapproved sizes / products).
//
// OWNER DECISION 2026-11-11 — CHIRON SELLS ON THE EQUIVALENT MIRON LADDER.
// Chiron 100ml tall / 100ml wide / 150ml use the SAME customer selling-price
// ladder (and the same holographic / specialty adders) as the equivalent
// Miron size. SELLING PRICE ONLY: Chiron true cost stays on its own flat
// blank authority (CHIRON_SET_COST $1.80 / $1.80 / $1.90), margin is Chiron
// true cost vs that price, and the same raising-only minimum margin
// protection applies. Any other Chiron size has no price authority.
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

/**
 * OWNER DECISION 2026-11-11: Chiron size -> the Miron size whose approved
 * selling ladder it uses. Selling price only — never a cost substitution.
 * A Chiron size missing here has NO price authority and keeps blocking.
 */
export const CHIRON_EQUIVALENT_MIRON_SIZE: Readonly<Record<string, string>> = {
  "100ml_tall": "100ml_tall",
  "100ml_wide": "100ml_wide",
  "150ml": "150ml",
};
export const CHIRON_LADDER_INHERITANCE_SOURCE = "Owner decision 2026-11-11: Chiron uses the equivalent Miron customer selling-price ladder (selling price only; Chiron true cost unchanged)";

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
  /** Set when a Chiron price comes from the equivalent Miron ladder. */
  inheritedFrom: { brand: "miron"; sizeKey: string } | null;
};

export type JarOwnerLadderResolution =
  | { ok: true; quote: JarOwnerLadderQuote }
  | { ok: false; reason: "NO_OWNER_LADDER" | "BELOW_LADDER_MINIMUM" | "VOLUME_QUOTE" | "DEEP_BUILD"; message: string };

const money = (n: number) => Math.round(n * 100) / 100;

/**
 * The owner ladder unit price for one jar configuration, or an explicit
 * reason why none applies. Miron and the standard 3oz/4oz applied-label jars
 * have a 16D ladder; Chiron inherits the equivalent Miron ladder for its
 * approved sizes only (CHIRON_EQUIVALENT_MIRON_SIZE).
 */
export function resolveJarOwnerLadder(input: {
  brand: string | null | undefined;
  sizeKey: string | null | undefined;
  quantity: number;
  holographic?: boolean;
  specialtyX?: number;
}): JarOwnerLadderResolution {
  const brand = String(input.brand || "");
  let inheritedFrom: JarOwnerLadderQuote["inheritedFrom"] = null;
  let sizeKey = input.sizeKey;
  if (brand === "chiron") {
    const mironSize = CHIRON_EQUIVALENT_MIRON_SIZE[String(input.sizeKey || "")];
    if (!mironSize) return { ok: false, reason: "NO_OWNER_LADDER", message: `Chiron ${String(input.sizeKey || "")} has no approved selling-price authority (only Chiron 100ml tall, 100ml wide and 150ml inherit the equivalent Miron ladder).` };
    inheritedFrom = { brand: "miron", sizeKey: mironSize };
    sizeKey = mironSize;
  }
  const launchSize = jarLaunchSizeForSizeKey(sizeKey);
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
      source: inheritedFrom ? `${JAR_OWNER_LADDER_SOURCE}; ${CHIRON_LADDER_INHERITANCE_SOURCE}` : JAR_OWNER_LADDER_SOURCE,
      label: `${JAR_OWNER_LADDER_RULE}${inheritedFrom ? ` — Chiron on the equivalent Miron ${inheritedFrom.sizeKey} ladder` : ""}: ${launchSize} @ ${tier.minQty}+ = $${tier.priceEach.toFixed(2)}${holoAdd ? ` + holographic $${holoAdd.toFixed(2)}` : ""}${specialty.premium ? ` + ${specialty.label} $${specialty.premium.toFixed(2)}` : ""}`,
      inheritedFrom,
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
  128, 256, 640, // legacy margin-band starts (off-ladder curve quantities)
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
    // An approved ladder row is never held up by the generic floor (owner decision 2026-11-11).
    const ladderRow = Boolean((row as any).commercial?.ownerLadder);
    const floorPct = ladderRow ? 0 : Math.max(0, Math.min(99, Number(row.floorPct ?? 0)));
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
