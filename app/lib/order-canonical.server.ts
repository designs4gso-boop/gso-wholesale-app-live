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

// ---------- 16D: applied-label jar canonical lines ----------
// Family-aware sibling of the stock-bag snapshot, produced by
// canonical-jar-pricing.ts buildCanonicalJarLineMetadata: { v, family:"jars",
// profile, size, qty, baseFinish, labelMaterial, holo, whiteRequired,
// specialtyX, finishLabel, unitPrice, engine }. Same fail-closed contract:
// malformed snapshots fall back to visible line properties with warnings.

export type CanonicalJarOrderLine = {
  v: string;
  family: "jars";
  profile: string;
  size: string;
  qty: number;
  baseFinish: "Matte" | "Gloss";
  labelMaterial: "Standard" | "Holographic";
  holo: boolean;
  whiteRequired: boolean;
  specialtyX: number;
  finishLabel: string;
  unitPrice: number;
  // 16D.1: color-variant jars (3oz/4oz). Production attribute only — the
  // words "Clear"/"White" are machine-router tokens, so this value may
  // appear ONLY in notes/add-ons, never in routing-read summaries.
  jarColor: "" | "Clear" | "Black" | "White";
  engine: string;
};

export function parseCanonicalJarOrderLine(raw: string | null | undefined): CanonicalJarOrderLine | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.family !== "jars") return null;
  const qty = Number(parsed.qty);
  const specialtyX = Number(parsed.specialtyX);
  const unitPrice = Number(parsed.unitPrice);
  const jarColor = parsed.jarColor === undefined ? "" : parsed.jarColor;
  const ok =
    typeof parsed.v === "string" && parsed.v.length > 0 &&
    typeof parsed.profile === "string" && parsed.profile.startsWith("jar_") &&
    typeof parsed.size === "string" && parsed.size.length > 0 &&
    Number.isFinite(qty) && qty > 0 &&
    (parsed.baseFinish === "Matte" || parsed.baseFinish === "Gloss") &&
    (parsed.labelMaterial === "Standard" || parsed.labelMaterial === "Holographic") &&
    Number.isFinite(specialtyX) && specialtyX >= 0 && specialtyX <= 8 &&
    typeof parsed.finishLabel === "string" && parsed.finishLabel.length > 0 &&
    Number.isFinite(unitPrice) && unitPrice > 0 &&
    (jarColor === "" || jarColor === "Clear" || jarColor === "Black" || jarColor === "White") &&
    typeof parsed.engine === "string" && parsed.engine.length > 0;
  if (!ok) return null;
  return {
    v: parsed.v,
    family: "jars",
    profile: parsed.profile,
    size: parsed.size,
    qty: Math.floor(qty),
    baseFinish: parsed.baseFinish,
    labelMaterial: parsed.labelMaterial,
    holo: Boolean(parsed.holo),
    whiteRequired: Boolean(parsed.whiteRequired),
    specialtyX: Math.floor(specialtyX),
    finishLabel: parsed.finishLabel,
    unitPrice,
    jarColor,
    engine: parsed.engine,
  };
}

// Jar production summary — the machine decider reads this text, so token
// hygiene is deliberate: a plain-CMYK config (0X + Standard label) contains
// NO white/gloss/clear token and defaults to the Mimaki; specialty layers
// emit "Gloss Layers: NX" and holographic emits "White Layers: 1" (technical
// underbase) so those deterministically route Roland. The customer-facing
// word "Gloss" for the INCLUDED base laminate finish is intentionally
// rendered "High-Shine" here (and stated verbatim in production notes,
// which the router never reads).
export function canonicalJarMaterialSummary(jar: CanonicalJarOrderLine): string {
  // 16D.1: the 3oz/4oz profile IDs contain the literal words "clear"/"white"
  // (jar_3oz_clear, jar_4oz_black_white) — router tokens. The summary renders
  // a token-safe spelling; the exact profile rides in add-ons/notes/snapshot.
  const safeProfile = jar.profile.replace(/_clear\b/g, "_clr").replace(/_black_white\b/g, "_blkwht");
  const parts = [
    `Profile: ${safeProfile}`,
    `Family: Jars`,
    `Size: ${jar.size}`,
    `Base: ${jar.baseFinish === "Gloss" ? "High-Shine" : "Matte"}`,
    `Label Material: ${jar.holo ? "Holographic Vinyl" : "Standard Vinyl"}`,
    `Specialty: ${jar.finishLabel}`,
  ];
  if (jar.specialtyX >= 1) parts.push(`Gloss Layers: ${jar.specialtyX}X`);
  if (jar.holo) parts.push(`White Layers: 1`, `Holographic: yes`);
  else parts.push(`Holographic: no`);
  parts.push(`Application: GSO label application included`);
  return parts.join(" | ");
}

export function canonicalJarSelectedAddOns(jar: CanonicalJarOrderLine): Record<string, unknown> {
  return {
    source: "gso_canonical_checkout",
    family: "jars",
    canonicalVersion: jar.v,
    profile: jar.profile,
    size: jar.size,
    ...(jar.jarColor ? { jarColor: jar.jarColor } : {}),
    baseFinish: jar.baseFinish,
    labelMaterial: jar.labelMaterial,
    holographic: jar.holo,
    requiredWhite: jar.whiteRequired,
    specialtyLayers: jar.specialtyX,
    finish: jar.finishLabel,
    productionFinish: jar.finishLabel,
    application: "GSO label application included",
    engine: jar.engine,
  };
}

// ---------- 16E: outsourced DTP pouch canonical lines ----------
// Produced by canonical-dtp-pricing.server.ts buildCanonicalDtpLineMetadata:
// { v, family:"dtp", profile, size, qty, finishLabel, crZipper, unitPrice,
//   supplier, ladderSku, ladderEngine, engine }. Same fail-closed contract.

export type CanonicalDtpOrderLine = {
  v: string;
  family: "dtp";
  profile: string;
  size: string;
  qty: number;
  finishLabel: string;
  crZipper: boolean;
  unitPrice: number;
  supplier: string;
  ladderSku: string;
  engine: string;
};

export function parseCanonicalDtpOrderLine(raw: string | null | undefined): CanonicalDtpOrderLine | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.family !== "dtp") return null;
  const qty = Number(parsed.qty);
  const unitPrice = Number(parsed.unitPrice);
  const ok =
    typeof parsed.v === "string" && parsed.v.length > 0 &&
    typeof parsed.profile === "string" && parsed.profile.startsWith("dtp_") &&
    typeof parsed.size === "string" && parsed.size.length > 0 &&
    Number.isFinite(qty) && qty > 0 &&
    typeof parsed.finishLabel === "string" && parsed.finishLabel.length > 0 &&
    Number.isFinite(unitPrice) && unitPrice > 0 &&
    typeof parsed.supplier === "string" && parsed.supplier.length > 0 &&
    typeof parsed.ladderSku === "string" && parsed.ladderSku.length > 0 &&
    typeof parsed.engine === "string" && parsed.engine.length > 0;
  if (!ok) return null;
  return {
    v: parsed.v,
    family: "dtp",
    profile: parsed.profile,
    size: parsed.size,
    qty: Math.floor(qty),
    finishLabel: parsed.finishLabel,
    crZipper: Boolean(parsed.crZipper),
    unitPrice,
    supplier: parsed.supplier,
    ladderSku: parsed.ladderSku,
    engine: parsed.engine,
  };
}

// DTP production summary. Token hygiene: outsourced vendor-finished pouches
// carry NO white/gloss/clear tokens, so if an artwork file is ever intake-
// matched it takes the plain default path — production truth (purchase
// workflow, no in-house print) lives in the dtp-bags checklist and notes.
export function canonicalDtpMaterialSummary(dtp: CanonicalDtpOrderLine): string {
  return [
    `Profile: ${dtp.profile}`,
    `Family: DTP Pouches`,
    `Size: ${dtp.size}`,
    `Spec: ${dtp.finishLabel}`,
    `CR Zipper: ${dtp.crZipper ? "included" : "no"}`,
    `Supplier: Spektra (outsourced, vendor-finished)`,
  ].join(" | ");
}

export function canonicalDtpSelectedAddOns(dtp: CanonicalDtpOrderLine): Record<string, unknown> {
  return {
    source: "gso_canonical_checkout",
    family: "dtp",
    canonicalVersion: dtp.v,
    profile: dtp.profile,
    size: dtp.size,
    finish: dtp.finishLabel,
    productionFinish: dtp.finishLabel,
    crZipper: dtp.crZipper,
    supplier: dtp.supplier,
    ladderSku: dtp.ladderSku,
    outsourced: true,
    engine: dtp.engine,
  };
}

// Cross-checks between the canonical snapshot and the paid line. Mismatches
// never block the job — they surface as warnings on the item so a human sees
// them (the PAID line quantity/price stay the commercial record; the
// canonical block is preserved verbatim alongside).
export function canonicalLineWarnings(canonical: Pick<CanonicalOrderLine, "qty" | "unitPrice">, line: { quantity: number; unitPrice: number }): string[] {
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
