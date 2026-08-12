// Phase 16D — canonical Miron applied-label jar pricing authority.
//
// OWNER-APPROVED LAUNCH PRICES (2026-08-12). These numbers ARE the pricing
// authority for the launch sizes — they are market-driven by owner decision
// and must never be regenerated from margins, costs, legacy jar rule tables,
// Pricing Intelligence, or competitor data. Change them only on an explicit
// owner instruction.
//
// Model (owner-specified):
//   unit = basePrice(size, qty)
//        + (labelMaterial == Holographic ? 20% of BASE, not of the layered
//           subtotal : 0)
//        + specialty per-jar premium (fixed ladder below)
//   5,000+ or Deep Build 9X+  ->  request quote (never priced online)
// Base includes: Miron jar + lid + printed label + GSO application + the
// Matte-or-Gloss base finish choice (no charge difference).
//
// GSO sells NO blank Miron jars and no label-only option — application is
// included and mandatory; this engine has no blank/no-label path on purpose.

export const JAR_PRICING_VERSION = "16D-jar-canonical";
export const JAR_PRICING_ENGINE = "canonical-jar-pricing/16D";

export const JAR_STOREFRONT_MIN_QTY = 50;
export const JAR_VOLUME_QUOTE_FROM = 5000;
export const JAR_QUANTITY_OPTIONS = [50, 100, 250, 500, 1000, 2500];

export type JarLaunchSize = "100ml" | "150ml";

// ERP ConfiguratorProduct productTypes that price through this engine. Both
// 100ml body styles (tall/wide) share the owner's single 100ml price table.
export const JAR_LAUNCH_TYPE_SIZES: Record<string, JarLaunchSize> = {
  jar_100ml_tall: "100ml",
  jar_100ml_wide: "100ml",
  jar_150ml: "150ml",
};

export function jarLaunchSizeForType(productType: string): JarLaunchSize | null {
  return JAR_LAUNCH_TYPE_SIZES[String(productType || "")] ?? null;
}

export const JAR_BASE_PRICES: Record<JarLaunchSize, Array<{ minQty: number; priceEach: number }>> = {
  "100ml": [
    { minQty: 50, priceEach: 4.95 },
    { minQty: 100, priceEach: 4.5 },
    { minQty: 250, priceEach: 4.0 },
    { minQty: 500, priceEach: 3.75 },
    { minQty: 1000, priceEach: 3.5 },
    { minQty: 2500, priceEach: 3.35 },
  ],
  "150ml": [
    { minQty: 50, priceEach: 6.5 },
    { minQty: 100, priceEach: 6.0 },
    { minQty: 250, priceEach: 5.75 },
    { minQty: 500, priceEach: 5.5 },
    { minQty: 1000, priceEach: 5.25 },
    { minQty: 2500, priceEach: 4.95 },
  ],
};

export const JAR_BASE_FINISHES = ["Matte", "Gloss"] as const;
export const JAR_LABEL_MATERIALS = ["Standard", "Holographic"] as const;
export const JAR_HOLOGRAPHIC_PCT = 0.2;

// Universal GSO specialty vocabulary, jar launch ladder. Customer-facing
// labels double as production finish labels, so the 0X label deliberately
// avoids the words the machine router treats as white/gloss tokens (plain
// CMYK label work must default to the Mimaki, not the Roland).
export const JAR_SPECIALTY_LADDER: Array<{ x: number; label: string; premium: number }> = [
  { x: 0, label: "Standard — 0X", premium: 0 },
  { x: 1, label: "Spot Gloss — 1X", premium: 0.3 },
  { x: 2, label: "Raised Emboss — 2X", premium: 0.5 },
  { x: 3, label: "Raised — 3X", premium: 0.7 },
  { x: 4, label: "Raised — 4X", premium: 0.9 },
  { x: 5, label: "Ultra Layered — 5X", premium: 1.1 },
  { x: 6, label: "Ultra Layered — 6X", premium: 1.3 },
  { x: 7, label: "Ultra Layered — 7X", premium: 1.5 },
  { x: 8, label: "Ultra Layered — 8X", premium: 1.75 },
];

export const JAR_DEEP_BUILD_LABEL = "Deep Build 9X+ — Request Custom Quote";

export const JAR_SPECIALTY_OPTIONS = [
  ...JAR_SPECIALTY_LADDER.map((entry) => entry.label),
  JAR_DEEP_BUILD_LABEL,
];

// Owner production standard for jar label application ($20/hour, minimum
// 100 jars/hour). COST-side only — never a customer surcharge.
export const JAR_APPLICATION_LABOR_PER_JAR = 0.2;

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function normalized(value: unknown) {
  return String(value ?? "").trim();
}

export function jarSpecialtyForLabel(label: string): { x: number; label: string; premium: number } | "deep_build" | null {
  const wanted = normalized(label).toLowerCase();
  if (!wanted) return JAR_SPECIALTY_LADDER[0];
  if (wanted === JAR_DEEP_BUILD_LABEL.toLowerCase() || wanted.includes("9x")) return "deep_build";
  const exact = JAR_SPECIALTY_LADDER.find((entry) => entry.label.toLowerCase() === wanted);
  if (exact) return exact;
  // tolerate a bare ladder index ("0X".."8X") from older clients
  const match = wanted.match(/^(\d)x$/);
  if (match) return JAR_SPECIALTY_LADDER.find((entry) => entry.x === Number(match[1])) ?? null;
  return null;
}

export type JarSelection = {
  productType: string;
  quantity: number;
  baseFinish: string; // "Matte" | "Gloss" — included either way
  labelMaterial: string; // "Standard" | "Holographic"
  specialty: string; // ladder label
};

export type JarPriceResult =
  | {
      ok: true;
      size: JarLaunchSize;
      quantity: number;
      tierMinQty: number;
      basePrice: number;
      holographic: boolean;
      holoAdd: number;
      specialtyX: number;
      specialtyLabel: string;
      specialtyAdd: number;
      unitPrice: number;
      orderTotal: number;
      baseFinish: "Matte" | "Gloss";
      // technical white underbase for holographic vinyl — production/cost
      // reality only, never a customer surcharge (owner rule, 16D).
      whiteRequired: boolean;
      version: string;
      engine: string;
    }
  | { ok: false; requestQuote: boolean; reason: string };

export function priceJarConfiguration(selection: JarSelection): JarPriceResult {
  const size = jarLaunchSizeForType(selection.productType);
  if (!size) {
    return { ok: false, requestQuote: false, reason: "This jar size is not available for online pricing yet." };
  }

  const baseFinishRaw = normalized(selection.baseFinish) || "Matte";
  const baseFinish = JAR_BASE_FINISHES.find((entry) => entry.toLowerCase() === baseFinishRaw.toLowerCase());
  if (!baseFinish) {
    return { ok: false, requestQuote: false, reason: "Unknown base finish — choose Matte or Gloss." };
  }

  const labelMaterialRaw = normalized(selection.labelMaterial) || "Standard";
  const labelMaterial = JAR_LABEL_MATERIALS.find((entry) => entry.toLowerCase() === labelMaterialRaw.toLowerCase());
  if (!labelMaterial) {
    return { ok: false, requestQuote: false, reason: "Unknown label material — choose Standard or Holographic." };
  }

  const specialty = jarSpecialtyForLabel(selection.specialty);
  if (specialty === "deep_build") {
    return {
      ok: false,
      requestQuote: true,
      reason: "Deep Build 9X+ specialty work is quoted individually — please request a custom quote.",
    };
  }
  if (!specialty) {
    return { ok: false, requestQuote: false, reason: "Unknown specialty selection." };
  }

  const quantity = Math.floor(Number(selection.quantity) || 0);
  if (quantity < JAR_STOREFRONT_MIN_QTY) {
    return { ok: false, requestQuote: false, reason: `Minimum order is ${JAR_STOREFRONT_MIN_QTY} jars.` };
  }
  if (quantity >= JAR_VOLUME_QUOTE_FROM) {
    return {
      ok: false,
      requestQuote: true,
      reason: `Orders of ${JAR_VOLUME_QUOTE_FROM.toLocaleString()}+ jars are quoted individually — please request a volume quote.`,
    };
  }

  const table = JAR_BASE_PRICES[size];
  const tier = [...table].reverse().find((entry) => quantity >= entry.minQty);
  if (!tier) {
    return { ok: false, requestQuote: false, reason: `Minimum order is ${JAR_STOREFRONT_MIN_QTY} jars.` };
  }

  const holographic = labelMaterial === "Holographic";
  // Owner-preferred calculation: BASE + (20% of BASE) + per-unit premium —
  // the percentage is never applied to the layered subtotal.
  const holoAdd = holographic ? money(tier.priceEach * JAR_HOLOGRAPHIC_PCT) : 0;
  const unitPrice = money(tier.priceEach + holoAdd + specialty.premium);

  return {
    ok: true,
    size,
    quantity,
    tierMinQty: tier.minQty,
    basePrice: tier.priceEach,
    holographic,
    holoAdd,
    specialtyX: specialty.x,
    specialtyLabel: specialty.label,
    specialtyAdd: specialty.premium,
    unitPrice,
    orderTotal: money(unitPrice * quantity),
    baseFinish,
    whiteRequired: holographic,
    version: JAR_PRICING_VERSION,
    engine: JAR_PRICING_ENGINE,
  };
}

export function jarPriceBreaks(selection: Omit<JarSelection, "quantity">): Array<{ range: string; minQty: number; maxQty: null; priceEach: number }> {
  const breaks: Array<{ range: string; minQty: number; maxQty: null; priceEach: number }> = [];
  for (const quantity of JAR_QUANTITY_OPTIONS) {
    const priced = priceJarConfiguration({ ...selection, quantity });
    if (priced.ok) breaks.push({ range: `${quantity}+`, minQty: quantity, maxQty: null, priceEach: priced.unitPrice });
  }
  return breaks;
}

// Hidden `_GSO Canonical` line snapshot for jar lines — family-aware sibling
// of the stock-bag snapshot (order-canonical.server.ts parses both).
export function buildCanonicalJarLineMetadata(input: {
  productType: string;
  priced: Extract<JarPriceResult, { ok: true }>;
}): string {
  return JSON.stringify({
    v: JAR_PRICING_VERSION,
    family: "jars",
    profile: input.productType,
    size: input.priced.size,
    qty: input.priced.quantity,
    baseFinish: input.priced.baseFinish,
    labelMaterial: input.priced.holographic ? "Holographic" : "Standard",
    holo: input.priced.holographic,
    whiteRequired: input.priced.whiteRequired,
    specialtyX: input.priced.specialtyX,
    finishLabel: input.priced.specialtyLabel,
    unitPrice: input.priced.unitPrice,
    engine: JAR_PRICING_ENGINE,
  });
}
