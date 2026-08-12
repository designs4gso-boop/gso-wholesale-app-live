// Phase 15H.4A — `_GSO Canonical` consumption for paid Shopify orders.
// The checkout attaches a SERVER-CREATED snapshot to every canonical
// configurator line (storefront-canonical-pricing.server.ts
// buildCanonicalLineMetadata): { v, profile, qty, faces, material, bagColor,
// holo, whiteRequired, glossX, finishLabel, unitPrice, engine }. This module
// parses it FAIL-CLOSED (a malformed snapshot never blocks job creation —
// the webhook falls back to the visible line properties with a warning) and
// maps it into authoritative production configuration. Nothing here reads
// browser-posted prices or recalculates pricing.

export type CanonicalOrderLine = {
  v: string;
  profile: string;
  qty: number;
  faces: 1 | 2;
  material: string;
  bagColor: string;
  holo: boolean;
  whiteRequired: boolean;
  glossX: number;
  finishLabel: string;
  unitPrice: number;
  engine: string;
};

export function parseCanonicalOrderLine(raw: string | null | undefined): CanonicalOrderLine | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const qty = Number(parsed.qty);
  const faces = Number(parsed.faces);
  const glossX = Number(parsed.glossX);
  const unitPrice = Number(parsed.unitPrice);
  const ok =
    typeof parsed.v === "string" && parsed.v.length > 0 &&
    typeof parsed.profile === "string" && parsed.profile.length > 0 &&
    Number.isFinite(qty) && qty > 0 &&
    (faces === 1 || faces === 2) &&
    typeof parsed.material === "string" && parsed.material.length > 0 &&
    Number.isFinite(glossX) && glossX >= 0 && glossX <= 8 &&
    typeof parsed.finishLabel === "string" && parsed.finishLabel.length > 0 &&
    Number.isFinite(unitPrice) && unitPrice > 0 &&
    typeof parsed.engine === "string" && parsed.engine.length > 0;
  if (!ok) return null;
  return {
    v: parsed.v,
    profile: parsed.profile,
    qty: Math.floor(qty),
    faces: faces as 1 | 2,
    material: parsed.material,
    bagColor: typeof parsed.bagColor === "string" ? parsed.bagColor : "",
    holo: Boolean(parsed.holo),
    whiteRequired: Boolean(parsed.whiteRequired),
    glossX: Math.floor(glossX),
    finishLabel: parsed.finishLabel,
    unitPrice,
    engine: parsed.engine,
  };
}

// Production-facing summaries. The explicit White/Holo tokens matter: the
// intake machine decider (needsWhiteOrGloss) reads these summaries, so a
// holographic order (bundled required white) deterministically routes
// Roland even though "holographic" itself is not a routing token.
export function canonicalMaterialSummary(canonical: CanonicalOrderLine): string {
  return [
    `Profile: ${canonical.profile}`,
    `Material: ${canonical.material}`,
    `Finish: ${canonical.finishLabel}`,
    `Gloss Layers: ${canonical.glossX}X`,
    `White Layers: ${canonical.whiteRequired ? 1 : 0}`,
    `Holographic: ${canonical.holo ? "yes" : "no"}`,
    `Bag Color: ${canonical.bagColor || "-"}`,
    `Sides: ${canonical.faces === 1 ? "Single Sided" : "Double Sided"}`,
  ].join(" | ");
}

export function canonicalSelectedAddOns(canonical: CanonicalOrderLine): Record<string, unknown> {
  return {
    source: "gso_canonical_checkout",
    canonicalVersion: canonical.v,
    profile: canonical.profile,
    material: canonical.material,
    finish: canonical.finishLabel,
    productionFinish: canonical.finishLabel,
    bagColor: canonical.bagColor,
    sides: canonical.faces === 1 ? "Single Sided" : "Double Sided",
    faces: canonical.faces,
    holographic: canonical.holo,
    requiredWhite: canonical.whiteRequired,
    glossLayers: canonical.glossX,
    engine: canonical.engine,
  };
}

// Cross-checks between the canonical snapshot and the paid line. Mismatches
// never block the job — they surface as warnings on the item so a human sees
// them (the PAID line quantity/price stay the commercial record; the
// canonical block is preserved verbatim alongside).
export function canonicalLineWarnings(canonical: CanonicalOrderLine, line: { quantity: number; unitPrice: number }): string[] {
  const warnings: string[] = [];
  if (Number(line.quantity) !== canonical.qty) {
    warnings.push(`Canonical qty ${canonical.qty} differs from paid line qty ${line.quantity} — verify before production.`);
  }
  if (Math.abs(Number(line.unitPrice) - canonical.unitPrice) > 0.005) {
    warnings.push(`Canonical unit price ${canonical.unitPrice} differs from paid line price ${line.unitPrice} — verify before production.`);
  }
  return warnings;
}

// ---------- runtime column capability (staged-migration safety) ----------
// The orderGid column ships as a STAGED migration (15H.1 pattern), and
// schema.prisma cannot declare it before the database has it (Prisma selects
// every declared scalar on reads). The webhook therefore probes the actual
// database ONCE per process and only writes orderGid when the column exists —
// deploying this code before the owner activates the migration is safe.
let orderGidCapability: boolean | null = null;

export async function orderGidColumnAvailable(db: any): Promise<boolean> {
  if (orderGidCapability != null) return orderGidCapability;
  try {
    await db.$queryRawUnsafe('SELECT "orderGid" FROM "ProductionJob" LIMIT 1');
    orderGidCapability = true;
  } catch {
    orderGidCapability = false;
  }
  return orderGidCapability;
}

export function resetOrderGidCapabilityForTests() {
  orderGidCapability = null;
}
