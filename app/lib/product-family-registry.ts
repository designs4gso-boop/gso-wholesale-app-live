// Shared product-family registry (Phase 15B). ONE list consumed by the Cost
// Calculator (family options + accepted URL values), Product Setup (recipe
// family vocabulary), the margin-family mapping, and the sales-rule mapping.
// Client-safe: pure data + pure functions, no Prisma, no server imports.
//
// This registry replaces the previously duplicated family lists:
//   - calculator UI options (app/routes/app.erp.cost-calculator.tsx)
//   - canonical/legacy handling (app/lib/product-driven-costing.server.ts)
//   - the recipe-family string list primary entries (app.erp.product-setup.tsx)
// It INDEXES (does not replace) the researched margin curves
// (FAMILY_MARGIN_RULES via marginRuleKey) and the agent/sales rules
// (PRODUCT_FAMILY_SALES_RULES via salesRuleKey) — those tables remain the
// owner-approved sources for their own values.
//
// dtp-bags is RESERVED for Phase 15C: registered (so setup/data work can
// begin) but calculatorEnabled=false, so it never renders in the live
// calculator until 15C flips it.

export type ProductFamilyEntry = {
  key: string; // canonical key (calculator URL value for calculator families)
  label: string; // owner-facing label
  description: string;
  recipeFamilyLabel: string; // ProductRecipe.productFamily display vocabulary (legacy strings preserved)
  calculatorEnabled: boolean;
  productSetupEnabled: boolean;
  vendorCostCapable: boolean;
  marginRuleKey: string | null; // FAMILY_MARGIN_RULES key; null = provisional universal curve
  marginRuleNote: string | null; // documents class/size-dependent margin resolution
  salesRuleKey: string | null; // PRODUCT_FAMILY_SALES_RULES key
  legacyAliases: string[]; // accepted URL/snapshot values that normalize to key
  active: boolean;
  sortOrder: number;
};

export const PRODUCT_FAMILY_REGISTRY: ProductFamilyEntry[] = [
  {
    key: "sticker-bags",
    label: "Sticker Bags",
    description: "Blank sticker bags (4x5/4x6/5x8/6x9/14x16; OZ excluded) with printed applied labels.",
    recipeFamilyLabel: "Sticker Bags",
    calculatorEnabled: true, productSetupEnabled: true, vendorCostCapable: true,
    marginRuleKey: "bags-4x5",
    marginRuleNote: "Researched curve applies to 4x5 bags only; other sizes use the provisional universal curve (marginFamilyKeyFor).",
    salesRuleKey: "sticker-bags",
    legacyAliases: ["bags-4x5"],
    active: true, sortOrder: 10,
  },
  {
    key: "standard-jars",
    label: "Standard Jars",
    description: "Normal 3 oz / 4 oz / 5 oz jars plus the soda-can preset. Caps included. Not Chiron.",
    recipeFamilyLabel: "Jars",
    calculatorEnabled: true, productSetupEnabled: true, vendorCostCapable: true,
    marginRuleKey: null,
    marginRuleNote: "No researched curve yet — provisional universal curve, labeled FAMILY MARGIN RULE NOT CONFIGURED.",
    salesRuleKey: "jars",
    legacyAliases: [],
    active: true, sortOrder: 20,
  },
  {
    key: "premium-jars",
    label: "Premium Jars — Chiron & Miron",
    description: "Chiron (flat cost, cap included) and Miron (tiered, Top Type always required).",
    recipeFamilyLabel: "Jars",
    calculatorEnabled: true, productSetupEnabled: true, vendorCostCapable: true,
    marginRuleKey: null,
    marginRuleNote: "Class-dependent: jar_chiron -> chiron-jars, jar_miron -> miron-jars (marginFamilyKeyFor).",
    salesRuleKey: "jars",
    legacyAliases: ["chiron-jars", "miron-jars"],
    active: true, sortOrder: 30,
  },
  {
    key: "stickers-labels",
    label: "Stickers & Labels",
    description: "Die-cut/kiss-cut stickers and labels; automatic weeding when the cut requires it.",
    recipeFamilyLabel: "Labels / Stickers",
    calculatorEnabled: true, productSetupEnabled: true, vendorCostCapable: false,
    marginRuleKey: "stickers-labels",
    marginRuleNote: null,
    salesRuleKey: "labels-stickers",
    legacyAliases: [],
    active: true, sortOrder: 40,
  },
  {
    key: "banners",
    label: "Banners",
    description: "Banner media with optional hemming/grommets (finishing standards pending).",
    recipeFamilyLabel: "Banners",
    calculatorEnabled: true, productSetupEnabled: true, vendorCostCapable: false,
    marginRuleKey: "banners",
    marginRuleNote: null,
    salesRuleKey: "banners",
    legacyAliases: [],
    active: true, sortOrder: 50,
  },
  {
    key: "custom-item",
    label: "Custom Item",
    description: "One-off items with owner-entered cost + reason; provisional universal margins.",
    recipeFamilyLabel: "Custom / Other",
    calculatorEnabled: true, productSetupEnabled: true, vendorCostCapable: false,
    marginRuleKey: null,
    marginRuleNote: "Provisional universal curve by design.",
    salesRuleKey: "custom-other",
    legacyAliases: ["custom"],
    active: true, sortOrder: 60,
  },
  {
    // RESERVED for Phase 15C — never shown in the live calculator until
    // calculatorEnabled flips to true. Data entry (Spektra vendor records)
    // may proceed per docs/GSO_ERP_DTP_READINESS_PLAN.md.
    key: "dtp-bags",
    label: "Custom Printed Pouches / DTP Bags",
    description: "Spektra vendor-printed pouches (4x5x2/5x4x2/6x5x2/8x5x2), $85 flat freight per PO, CR zipper + tear notch included.",
    recipeFamilyLabel: "DTP Pouches",
    calculatorEnabled: false, productSetupEnabled: true, vendorCostCapable: true,
    marginRuleKey: "dtp-pouches",
    marginRuleNote: null,
    salesRuleKey: "dtp-pouches",
    legacyAliases: ["dtp-pouches", "dtp"],
    active: true, sortOrder: 70,
  },
];

export function familyByKeyOrAlias(value: string): ProductFamilyEntry | null {
  const needle = String(value || "").trim().toLowerCase();
  if (!needle) return null;
  return PRODUCT_FAMILY_REGISTRY.find((entry) => entry.key === needle || entry.legacyAliases.includes(needle)) || null;
}

// Families visible in the live calculator (sorted). dtp-bags stays out until 15C.
export function calculatorFamilies(): ProductFamilyEntry[] {
  return PRODUCT_FAMILY_REGISTRY
    .filter((entry) => entry.active && entry.calculatorEnabled)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// Every URL value the calculator loader/action accepts (canonical + legacy).
export function calculatorFamilyValues(): string[] {
  return calculatorFamilies().flatMap((entry) => [entry.key, ...entry.legacyAliases]);
}

// Recipe-family vocabulary for Product Setup (legacy display strings, deduped, registry order first).
export function productSetupFamilyLabels(): string[] {
  const labels = PRODUCT_FAMILY_REGISTRY
    .filter((entry) => entry.active && entry.productSetupEnabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((entry) => entry.recipeFamilyLabel);
  return [...new Set(labels)];
}

// ---------- Phase 15B: product verification status (D) ----------
// Derived from EXISTING data — no schema change. Better-than-cost sources are
// used when present: the Vendor Cost Book review status ("active" book item =
// owner-reviewed cost) upgrades the basis from "implicit" to "cost-book".
export type ProductVerification = {
  lifecycle: "Active" | "Inactive";
  verification: "Draft" | "Unverified" | "Verified";
  basis: string;
};

export function deriveProductVerification(input: {
  active: boolean;
  unitCost: number | null | undefined;
  tierCount: number;
  costBookStatus?: string | null; // linked VendorCostBookItem.status when one exists
}): ProductVerification {
  const lifecycle = input.active ? "Active" : "Inactive";
  const priced = (Number(input.unitCost) || 0) > 0 || input.tierCount > 0;
  const book = String(input.costBookStatus || "").toLowerCase();
  if (priced) {
    return book === "active"
      ? { lifecycle, verification: "Verified", basis: "Vendor Cost Book review (status active)" }
      : { lifecycle, verification: "Verified", basis: "implicit — cost present; add a Cost Book review to make verification explicit" };
  }
  if (book) return { lifecycle, verification: "Unverified", basis: `Cost Book intake exists (status ${book}) — cost not applied/verified` };
  return { lifecycle, verification: "Draft", basis: "no cost and no Cost Book intake yet" };
}

// ---------- Phase 15B: duplicate prevention (E) ----------
export function normalizeProductKey(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const SIZE_SPEC_RE = /(\d{1,2}\s*x\s*\d{1,2}(\s*x\s*\d{1,2})?)|((50|100|150|250)\s?ml)|([345]\s?oz)/i;
export function productSpecToken(name: string): string | null {
  const match = String(name || "").match(SIZE_SPEC_RE);
  return match ? normalizeProductKey(match[0]) : null;
}

export type DuplicateCandidate = { id: string; name: string; vendor?: string | null; vendorSku?: string | null };

// Likely-duplicate finder used by create actions to WARN (never silently
// merge): exact sku match, exact normalized-name match, or same vendor + same
// size/spec token.
export function findLikelyDuplicates(candidate: { name: string; vendor?: string | null; vendorSku?: string | null }, existing: DuplicateCandidate[]): DuplicateCandidate[] {
  const name = normalizeProductKey(candidate.name);
  const sku = normalizeProductKey(candidate.vendorSku || "");
  const vendor = normalizeProductKey(candidate.vendor || "");
  const spec = productSpecToken(candidate.name);
  return existing.filter((row) => {
    const rowSku = normalizeProductKey(row.vendorSku || "");
    if (sku && rowSku && rowSku === sku) return true;
    if (name && normalizeProductKey(row.name) === name) return true;
    if (vendor && spec && normalizeProductKey(row.vendor || "") === vendor && productSpecToken(row.name) === spec) return true;
    return false;
  });
}
