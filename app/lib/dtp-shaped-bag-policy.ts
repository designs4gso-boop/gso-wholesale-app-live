// CUSTOM SHAPED / DIE-CUT POUCH SELLING POLICY — OWNER DECISION 2026-10-06.
//
// These are OWNER-APPROVED GSO COMMERCIAL RULES (the public Spektra site lists
// Die Cut Bag as COMING SOON and has no die-cut calculator). They are never a
// public Spektra price and never touch the standard vendor true-cost matrix.
//
//   BASE      = the matching STANDARD DTP configuration CUSTOMER product price
//               (same size, material, finish, spot, zipper, features, quantity,
//               SKU count).
//   SURCHARGE = +10 % on that standard customer PRODUCT price (per-unit).
//   TOOLING   = $700 per UNIQUE PHYSICAL SHAPE / DIE, charged separately — not
//               per design, not per SKU, not per artwork, not per quantity tier,
//               and $0 on a reorder that reuses an existing usable die.
//
// Exact die reuse requires explicit staff confirmation with a Die ID / Shape ID
// or a clear reference; nothing is matched by dimensions alone. Artwork and
// SKU-count changes never create a new die by themselves. Setup / prepress /
// plates / run charges are already inside the public Spektra price and are
// never added again. Client-safe: pure.

export const DTP_SHAPED_BAG_POLICY_VERSION = "dtp-shaped-bag-policy/1.0.0-2026-10-06";
export const DTP_SHAPED_BAG_POLICY_SOURCE = "OWNER DECISION 2026-10-06 — GSO commercial rule (not a public Spektra website price)";
export const DTP_CUSTOM_SHAPE_SURCHARGE_PCT = 10;
export const DTP_NEW_DIE_TOOLING_FEE = 700;
/** Shaped pouch minimum order (owner rule 2026-10-06). Standard DTP MOQ (1,000) is unchanged. */
export const DTP_SHAPED_MOQ = 2500;

export type DtpShape = "standard" | "custom";
export type DtpDieChoice =
  | { mode: "none" } // standard shape, no die involved
  | { mode: "new" } // NEW SHAPE — NEW $700 DIE
  | { mode: "existing"; dieId?: string | null; reference?: string | null }; // EXISTING SHAPE / DIE ON FILE

export type ShapedPouchPricing = {
  version: string;
  source: string;
  shape: DtpShape;
  quantity: number;
  /** Standard DTP customer product subtotal (base + extra design fees; freight/tooling excluded). */
  standardProductTotal: number;
  standardUnitPrice: number;
  surchargePct: number;
  shapeSurcharge: number;
  /** Product subtotal after the surcharge (what the per-unit price is built from). */
  productTotal: number;
  unitPrice: number;
  toolingRequired: boolean;
  toolingFee: number;
  dieMode: DtpDieChoice["mode"];
  dieId: string | null;
  dieReference: string | null;
  /** Product + tooling (tooling is a separate line, never folded into the unit price). */
  total: number;
  lines: Array<{ key: "product" | "shape_surcharge" | "tooling"; label: string; amount: number; note: string }>;
  /** Fail-closed: an existing-die claim without an identifier is an error. */
  errors: string[];
};

const money = (n: number) => Math.round(n * 100) / 100;

export function priceShapedPouch(input: {
  shape: DtpShape;
  quantity: number;
  standardProductTotal: number;
  die?: DtpDieChoice;
}): ShapedPouchPricing {
  const quantity = Math.max(0, Math.floor(Number(input.quantity) || 0));
  const standardProductTotal = Math.max(0, Number(input.standardProductTotal) || 0);
  const standardUnitPrice = quantity > 0 ? standardProductTotal / quantity : 0;
  const errors: string[] = [];
  const shape: DtpShape = input.shape === "custom" ? "custom" : "standard";
  const die: DtpDieChoice = shape === "custom" ? (input.die ?? { mode: "new" }) : { mode: "none" };
  if (shape === "custom" && die.mode === "none") errors.push("A custom shape needs a die choice: NEW SHAPE — NEW $700 DIE, or EXISTING SHAPE / DIE ON FILE.");
  if (shape === "custom" && quantity < DTP_SHAPED_MOQ) errors.push(`Shaped pouch minimum order is ${DTP_SHAPED_MOQ.toLocaleString()} units (owner rule 2026-10-06); requested ${quantity.toLocaleString()}.`);
  let dieId: string | null = null;
  let dieReference: string | null = null;
  if (die.mode === "existing") {
    dieId = String(die.dieId || "").trim() || null;
    dieReference = String(die.reference || "").trim() || null;
    if (!dieId && !dieReference) errors.push("EXISTING SHAPE / DIE ON FILE requires a Die ID / Shape ID or a clear staff reference — dies are never matched by dimensions alone.");
  }
  const shapeSurcharge = shape === "custom" ? money(standardProductTotal * (DTP_CUSTOM_SHAPE_SURCHARGE_PCT / 100)) : 0;
  const productTotal = money(standardProductTotal + shapeSurcharge);
  const toolingRequired = shape === "custom" && die.mode === "new";
  const toolingFee = toolingRequired ? DTP_NEW_DIE_TOOLING_FEE : 0;
  const lines: ShapedPouchPricing["lines"] = [
    { key: "product", label: shape === "custom" ? "Custom shaped pouches — standard DTP configuration" : "Standard DTP pouches", amount: standardProductTotal, note: "Standard DTP customer product price (setup, prepress, plates and run charges are inside the vendor price — never added again)." },
  ];
  if (shape === "custom") lines.push({ key: "shape_surcharge", label: `Custom shape surcharge +${DTP_CUSTOM_SHAPE_SURCHARGE_PCT}%`, amount: shapeSurcharge, note: "Owner commercial surcharge on the standard customer product price; applies to every shaped order including reorders." });
  if (shape === "custom") lines.push({ key: "tooling", label: toolingRequired ? "Custom tooling — new reusable custom die" : "Custom tooling — existing die on file", amount: toolingFee, note: toolingRequired ? `One $${DTP_NEW_DIE_TOOLING_FEE} fee per unique physical shape; not per design, SKU, artwork or quantity tier.` : `No tooling fee: reusing die ${dieId ?? dieReference ?? "(unspecified)"}.` });
  return {
    version: DTP_SHAPED_BAG_POLICY_VERSION,
    source: DTP_SHAPED_BAG_POLICY_SOURCE,
    shape,
    quantity,
    standardProductTotal,
    standardUnitPrice,
    surchargePct: shape === "custom" ? DTP_CUSTOM_SHAPE_SURCHARGE_PCT : 0,
    shapeSurcharge,
    productTotal,
    unitPrice: quantity > 0 ? productTotal / quantity : 0,
    toolingRequired,
    toolingFee,
    dieMode: die.mode,
    dieId,
    dieReference,
    total: money(productTotal + toolingFee),
    lines,
    errors,
  };
}

/**
 * Tooling for a job with several physical shapes: $700 per UNIQUE new shape,
 * $0 for shapes that reuse an existing die. Designs/SKUs per shape never
 * matter.
 */
export function toolingForShapes(shapes: Array<{ shapeKey: string; die: DtpDieChoice; designs?: number }>): { uniqueNewShapes: number; reusedShapes: number; toolingFee: number; errors: string[] } {
  const seenNew = new Set<string>();
  const seenReused = new Set<string>();
  const errors: string[] = [];
  for (const s of shapes) {
    const key = String(s.shapeKey || "").trim();
    if (!key) { errors.push("Each shape needs a shape key."); continue; }
    if (s.die.mode === "existing") {
      if (!String(s.die.dieId || "").trim() && !String(s.die.reference || "").trim()) errors.push(`Shape "${key}": existing die claimed without a Die ID / reference.`);
      seenReused.add(key);
    } else {
      seenNew.add(key);
    }
  }
  return { uniqueNewShapes: seenNew.size, reusedShapes: seenReused.size, toolingFee: seenNew.size * DTP_NEW_DIE_TOOLING_FEE, errors };
}

/** Customer-facing presentation lines — tooling is always a separate block. */
export function shapedQuotePresentation(p: ShapedPouchPricing): string[] {
  const money2 = (n: number) => `$${n.toFixed(2)}`;
  if (p.shape !== "custom") return [`STANDARD POUCHES`, `${p.quantity.toLocaleString()} units`, `Unit price: ${money2(p.unitPrice)}`, `Total: ${money2(p.total)}`];
  const out = [
    "CUSTOM SHAPED POUCHES",
    `${p.quantity.toLocaleString()} units`,
    `Unit price: ${money2(p.unitPrice)}`,
    "Includes:",
    "Standard DTP configuration",
    `Custom shape surcharge +${p.surchargePct}%`,
    "",
    "CUSTOM TOOLING",
    p.toolingRequired ? `New reusable custom die: ${money2(p.toolingFee)}` : `Existing die on file (${p.dieId ?? p.dieReference ?? "reference required"}): $0.00`,
    "",
    `Product subtotal: ${money2(p.productTotal)}`,
    `Tooling: ${money2(p.toolingFee)}`,
    `Quote total: ${money2(p.total)}`,
  ];
  return out;
}

/**
 * Applies the shaped-bag policy to one DTP tier row produced by priceDtpQuote.
 * Surcharge = +10 % of the standard customer PRODUCT price (base subtotal +
 * design fees; freight and tooling excluded). Tooling is a separate
 * pass-through line (vendor die cost unknown) and is NOT counted as profit.
 */
export function applyShapedPolicyToDtpRow(input: {
  quantity: number;
  shape: DtpShape;
  die: DtpDieChoice;
  ladderUnitPrice: number;
  customerBaseSubtotal: number;
  extraDesignFees: number;
  customerTotal: number;
  grossProfit: number;
}): {
  shaped: ShapedPouchPricing;
  unitPrice: number;
  totalPrice: number;
  profit: number;
  marginPct: number;
  blocked: boolean;
  reasons: string[];
} {
  const shaped = priceShapedPouch({ shape: input.shape, quantity: input.quantity, standardProductTotal: input.customerBaseSubtotal + input.extraDesignFees, die: input.die });
  const factor = shaped.shape === "custom" ? 1 + DTP_CUSTOM_SHAPE_SURCHARGE_PCT / 100 : 1;
  const unitPrice = input.ladderUnitPrice * factor;
  const productTotal = input.customerTotal + shaped.shapeSurcharge; // customerTotal already holds base + design fees + any pass-through freight
  const totalPrice = money(productTotal + shaped.toolingFee);
  const profit = input.grossProfit + shaped.shapeSurcharge;
  const marginPct = productTotal > 0 ? (profit / productTotal) * 100 : 0;
  return { shaped, unitPrice, totalPrice, profit, marginPct, blocked: shaped.errors.length > 0, reasons: shaped.errors };
}
