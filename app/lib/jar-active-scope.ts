// Patch 2D-4D1 (17D.7E) — THE ACTIVE JAR PRODUCT SCOPE.
//
// The jar geometry tables carry every brand x size combination the code has
// ever known. GSO only SELLS ten of them. Those two facts were conflated, so a
// combination nobody offers — miron 4oz, chiron 250ml — looked like a missing
// cost and held back the products that are genuinely ready.
//
// This module is the single list of what is actually offered. It decides
// SCOPE, never cost: an active profile still resolves its blank price, freight
// and geometry from the existing verified sources, and an inactive one is
// simply not offered rather than being given a placeholder.
//
// OWNER-CONFIRMED SCOPE (2026-08-24):
//   MIRON   50ml, 100ml, 100ml tall, 150ml, 250ml
//   CHIRON  100ml, 100ml tall, 150ml
//   NORMAL  3oz, 4oz
//
// NAMING. The owner says "100ml" and "100ml tall"; the repo keys are
// 100ml_wide and 100ml_tall. The mapping is unambiguous from the geometry
// itself — 100ml_tall is 6.3 x 3.15in on a 1.75in lid (the narrow, tall jar)
// and 100ml_wide is 6.6 x 2.6in on a 1.9in lid (the normal, wider jar) — so
// nobody has to learn the internal names.
//
// Historical definitions are deliberately NOT deleted: JAR_LABEL_GEOMETRY,
// the cost tables and the freight tables keep every size for audit and for
// old quotes. Only what staff can SELECT is narrowed.
//
// Client-safe: the calculator form filters its selector with the same list the
// server scopes with, so the two cannot disagree.

import type { JarGeometryPendingSizeKey } from "./jar-label-geometry";

export const JAR_ACTIVE_SCOPE_VERSION = "17D.7E-jar-active-scope";

export type ActiveJarBrand = "miron" | "chiron" | "standard";

/** Repo key. "wide" is the NORMAL 100ml; "tall" is the taller variant. */
export type ActiveJarSizeKey = "50ml" | "100ml_tall" | "100ml_wide" | "150ml" | "250ml" | "3oz" | "4oz" | "ceres_50ml" | "ceres_100ml";

export type ActiveJarProfile = {
  brand: ActiveJarBrand;
  size: ActiveJarSizeKey;
  /** Stable identifier for a brand+size pair. */
  key: string;
  /** What the owner calls it. */
  label: string;
  /** Which canonical UI family this profile quotes under. */
  uiFamily: "premium-jars" | "standard-jars";
};

const profile = (
  brand: ActiveJarBrand,
  size: ActiveJarSizeKey,
  label: string,
  uiFamily: ActiveJarProfile["uiFamily"],
): ActiveJarProfile => ({ brand, size, key: `${brand}/${size}`, label, uiFamily });

/**
 * The combinations GSO currently offers (the ten of 2026-08-24 + the two MIRON Ceres sets of 2026-11-17).
 *
 * Chiron and Miron are the premium line; the plain oz jars are standard.
 */
export const ACTIVE_JAR_PROFILES: ActiveJarProfile[] = [
  profile("miron", "50ml", "Miron 50ml", "premium-jars"),
  profile("miron", "100ml_wide", "Miron 100ml", "premium-jars"),
  profile("miron", "100ml_tall", "Miron 100ml tall", "premium-jars"),
  profile("miron", "150ml", "Miron 150ml", "premium-jars"),
  profile("miron", "250ml", "Miron 250ml", "premium-jars"),
  // 2026-11-17 (owner): the MIRON Ceres jar + matching Yuha Special lid sets.
  // DISTINCT products from the generic "Miron 50ml / 100ml" rows above (those
  // are jar + normal SAN lid, with different cost, lid and label geometry) —
  // identified by the word "Ceres", never by the bare size.
  profile("miron", "ceres_50ml", "MIRON Ceres 50 mL + Yuha 48", "premium-jars"),
  profile("miron", "ceres_100ml", "MIRON Ceres 100 mL + Yuha 58", "premium-jars"),
  // Chiron quotes as PREMIUM alongside Miron — that is the repo's own family
  // split ("Premium Jars — Chiron & Miron"; Standard Jars is explicitly "Not
  // Chiron"), and blankClassAllowedFor enforces it. Only the plain oz jars are
  // standard.
  profile("chiron", "100ml_wide", "Chiron 100ml", "premium-jars"),
  profile("chiron", "100ml_tall", "Chiron 100ml tall", "premium-jars"),
  profile("chiron", "150ml", "Chiron 150ml", "premium-jars"),
  profile("standard", "3oz", "3oz jar", "standard-jars"),
  profile("standard", "4oz", "4oz jar", "standard-jars"),
];

export const ACTIVE_JAR_KEYS = ACTIVE_JAR_PROFILES.map((p) => p.key);

export function isActiveJarProfile(brand: string | null | undefined, size: string | null | undefined): boolean {
  return ACTIVE_JAR_KEYS.includes(`${brand}/${size}`);
}

export function activeJarProfile(brand: string | null | undefined, size: string | null | undefined): ActiveJarProfile | null {
  return ACTIVE_JAR_PROFILES.find((p) => p.key === `${brand}/${size}`) ?? null;
}

export function activeJarProfilesForFamily(uiFamily: string | null | undefined): ActiveJarProfile[] {
  return ACTIVE_JAR_PROFILES.filter((p) => p.uiFamily === uiFamily);
}

/* ------------------------------------------------------------------ *
 * 2026-11-20 — COST-CALCULATOR-ONLY jars (Eris 60ml / Eris 120ml)
 *
 * NOT part of ACTIVE_JAR_PROFILES, on purpose. The active scope is "what GSO
 * offers and can fully cost"; the owner asked only for the two Eris jars to be
 * selectable in the Cost Calculator with their supplier unit cost. They are
 * NOT FOR SALE: no storefront size, no price ladder, no configurator product,
 * no MOQ rule, no quote-ready recipe. Keeping them in their own list means
 * every consumer of the active scope (storefront, quote readiness, product
 * specs, price ladders) keeps ignoring them without having to know about them.
 *
 * "eris" is its own brand so it can never fall into a Miron tier ladder, a
 * Miron pallet, a Chiron flat-set rule or the standard invoice freight.
 *
 * NO FAMILY. Eris has no owner-approved classification ("Premium Jars" was
 * never one), so a cost-only profile carries no uiFamily. It is listed in
 * every Jar picker of the Cost Calculator under its own brand group
 * (COST_ONLY_JAR_PICKER_GROUP) — display / navigation only. Nothing about a
 * family (margin curve, market target, minimum, policy) attaches to it, and no
 * price is ever produced for it. No supplier item number was provided, so none
 * is stored; `key` is the stable internal identifier.
 * ------------------------------------------------------------------ */

export type CostOnlyJarBrand = "eris";

export type CostOnlyJarProfile = {
  brand: CostOnlyJarBrand;
  size: JarGeometryPendingSizeKey;
  /** Stable identifier for a brand+size pair. */
  key: string;
  /** The canonical product name. */
  label: string;
  /** Never a storefront / Shopify / quotable product. */
  notForSale: true;
};

export const COST_ONLY_JAR_PROFILES: CostOnlyJarProfile[] = [
  { brand: "eris", size: "eris_60ml", key: "eris/eris_60ml", label: "Eris 60ml Jar", notForSale: true },
  { brand: "eris", size: "eris_120ml", key: "eris/eris_120ml", label: "Eris 120ml Jar", notForSale: true },
];

/** The brand group the Cost Calculator Jar pickers list the cost-only jars under. Display only. */
export const COST_ONLY_JAR_PICKER_GROUP = "ERIS";
export const COST_ONLY_JAR_PICKER_GROUP_LABEL = "ERIS — cost data pending";
/** The calculator Jar pickers. A cost-only jar is listed in each; it belongs to none. */
export const COST_ONLY_JAR_PICKER_FAMILIES = ["standard-jars", "premium-jars"] as const;

export const COST_ONLY_JAR_KEYS = COST_ONLY_JAR_PROFILES.map((p) => p.key);

export function costOnlyJarProfile(brand: string | null | undefined, size: string | null | undefined): CostOnlyJarProfile | null {
  return COST_ONLY_JAR_PROFILES.find((p) => p.key === `${brand}/${size}`) ?? null;
}

export function costOnlyJarProfileByKey(key: string | null | undefined): CostOnlyJarProfile | null {
  return COST_ONLY_JAR_PROFILES.find((p) => p.key === String(key || "")) ?? null;
}

/** "60ml" / "120ml" identify an Eris jar ONLY together with the word "Eris". */
const COST_ONLY_NAME_PATTERNS: Array<{ size: JarGeometryPendingSizeKey; test: RegExp }> = [
  { size: "eris_60ml", test: /\beris\b.*\b60\s*ml|\b60\s*ml.*\beris\b/i },
  { size: "eris_120ml", test: /\beris\b.*\b120\s*ml|\b120\s*ml.*\beris\b/i },
];

/** Identify the cost-only jar a product name represents ("Eris 60ml Jar"), or null. */
export function resolveCostOnlyJarProfile(recordName: string | null | undefined): CostOnlyJarProfile | null {
  const name = String(recordName || "");
  const size = COST_ONLY_NAME_PATTERNS.find((p) => p.test.test(name))?.size ?? null;
  return size ? costOnlyJarProfile("eris", size) : null;
}

/* ------------------------------------------------------------------ *
 * Resolving a live blank record to an active profile
 *
 * Same discipline as the label material mapper: this picks WHICH verified
 * profile a record is, and never supplies a cost. An unrecognised record
 * returns null and the job blocks rather than guessing a jar.
 * ------------------------------------------------------------------ */

/** Order matters: "100ml tall" must be tested before the bare "100ml". */
const SIZE_PATTERNS: Array<{ size: ActiveJarSizeKey; test: RegExp }> = [
  // "Ceres" must be tested before the bare sizes: a Ceres record also says "50 mL" / "100 mL".
  { size: "ceres_50ml", test: /\bceres\b.*\b50\s*ml|\b50\s*ml.*\bceres\b/i },
  { size: "ceres_100ml", test: /\bceres\b.*\b100\s*ml|\b100\s*ml.*\bceres\b/i },
  { size: "100ml_tall", test: /100\s*ml.*\btall\b|\btall\b.*100\s*ml/i },
  { size: "100ml_wide", test: /100\s*ml/i },
  { size: "50ml", test: /\b50\s*ml/i },
  { size: "150ml", test: /\b150\s*ml/i },
  { size: "250ml", test: /\b250\s*ml/i },
  { size: "3oz", test: /\b3\s*oz/i },
  { size: "4oz", test: /\b4\s*oz/i },
];

const BRAND_PATTERNS: Array<{ brand: ActiveJarBrand; test: RegExp }> = [
  { brand: "miron", test: /miron/i },
  { brand: "chiron", test: /chiron/i },
];

/**
 * Identify the active jar profile a blank record represents.
 *
 * Returns null when the record is not a jar, not a recognised size, or is a
 * brand+size GSO does not currently offer — all of which must block rather
 * than resolve to something else.
 */
export function resolveActiveJarProfile(recordName: string | null | undefined): ActiveJarProfile | null {
  const name = String(recordName || "");
  if (!name.trim()) return null;

  const size = SIZE_PATTERNS.find((p) => p.test.test(name))?.size ?? null;
  if (!size) return null;

  // No brand marker means the plain oz jars, which is the only unbranded line.
  const brand = BRAND_PATTERNS.find((p) => p.test.test(name))?.brand ?? "standard";
  return activeJarProfile(brand, size);
}

/* ------------------------------------------------------------------ *
 * Standard-jar variant
 *
 * The plain oz jars are stocked clear and black/white at different prices, so
 * the variant is part of identifying WHICH verified cost applies. Miron and
 * Chiron have one price per size and return null.
 * ------------------------------------------------------------------ */

export type ActiveJarVariant = "clear" | "black_white";

export function resolveActiveJarVariant(recordName: string | null | undefined): ActiveJarVariant | null {
  const name = String(recordName || "");
  if (/black\s*[/&+-]?\s*white|black\s*and\s*white|\bb\/w\b/i.test(name)) return "black_white";
  if (/\bclear\b/i.test(name)) return "clear";
  return null;
}

/* ------------------------------------------------------------------ *
 * Which jar labels the canonical model actually knows
 *
 * The calculator's label-row picker offers more types than a jar has verified
 * geometry for. A row type with no canonical geometry is NOT silently dropped
 * — dropping it would quietly under-cost the job by a whole label — so this
 * returns null and the caller blocks.
 * ------------------------------------------------------------------ */

export type CanonicalJarLabelRole = "side" | "lid" | "tamper";

export function canonicalJarLabelRole(rowType: string | null | undefined): CanonicalJarLabelRole | null {
  const type = String(rowType || "").trim().toLowerCase();
  if (type === "side") return "side";
  if (type === "lid") return "lid";
  if (type === "tamper") return "tamper";
  return null;
}

/** Look an active profile up by its "brand/size" key. */
export function activeJarProfileByKey(key: string | null | undefined): ActiveJarProfile | null {
  return ACTIVE_JAR_PROFILES.find((p) => p.key === String(key || "")) ?? null;
}
