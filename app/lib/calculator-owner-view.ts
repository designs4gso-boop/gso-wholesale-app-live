// 2026-10-19 — Cost & Pricing Calculator OWNER VIEW (presentation only).
//
// Client-safe: pure data + pure functions, no server imports. Nothing here
// computes a cost or a price. It READS the numbers the loader already produced
// (canonical true cost, the server tier rows, the multi-line combined quote)
// and decides how the owner sees them:
//
//   - which existing, owner-approved pricing authority set the recommended
//     price — or that NONE exists, in which case the price is NOT AVAILABLE
//     (the provisional universal margin curve is never presented as approved);
//   - a 1-4 line plain-English summary of server blockers (raw engine codes
//     stay available, collapsed, under Advanced diagnostics);
//   - which visible required fields are still empty before Calculate.
//
// Missing cost is never $0: every money field here is `number | null`, and a
// blocked job carries null — never a zero that could read as "free".

/* ------------------------------------------------------------------ *
 * Stock Bags — an explicit family in the selector.
 *
 * The canonical engine already models Stock Bags as their own family
 * (CANONICAL_DISPATCH["stock-bags"] -> computeBagPhysical(product: stock_bag):
 * premade base art, MOQ 50). canonicalFamilyFromUi only reaches it through
 * pfamily=sticker-bags + pstockbag=1, and the live form never posted
 * pstockbag, so Stock Bags were supported by the engine but missing from the
 * UI. This option posts exactly that existing pair — no new family key, no
 * new formula, and the save path replays the same bytes via psearch.
 * ------------------------------------------------------------------ */
export const STOCK_BAG_CALCULATOR_OPTION = {
  value: "stock-bags",
  label: "Stock Bags",
  pfamily: "sticker-bags",
  pstockbag: "1",
} as const;

/**
 * 2026-11-11 owner decision: Split Bag — a permanent stocked product on the
 * SAME canonical bag adapter (computeBagPhysical product: split_bag). Posted
 * exactly like Stock Bags: pfamily=sticker-bags + psplitbag=1.
 */
export const SPLIT_BAG_CALCULATOR_OPTION = {
  value: "split-bags",
  label: "Split Bag",
  pfamily: "sticker-bags",
  psplitbag: "1",
} as const;

/** No Split Bag selling ladder exists yet — the owner prices each job. */
export const SPLIT_BAG_PRICE_AUTHORITY_TEXT =
  "Split Bag has no owner-approved selling price yet. The true cost is recorded; the owner sets and approves a job-level price (the 4x5 Sticker Bag price curve is never applied to it).";

/** Map a family-selector choice onto the form params the loader reads. */
export function calculatorFamilyParams(choice: string): { pfamily: string; pstockbag: string | null; psplitbag: string | null } {
  if (choice === STOCK_BAG_CALCULATOR_OPTION.value) {
    return { pfamily: STOCK_BAG_CALCULATOR_OPTION.pfamily, pstockbag: STOCK_BAG_CALCULATOR_OPTION.pstockbag, psplitbag: null };
  }
  if (choice === SPLIT_BAG_CALCULATOR_OPTION.value) {
    return { pfamily: SPLIT_BAG_CALCULATOR_OPTION.pfamily, pstockbag: null, psplitbag: SPLIT_BAG_CALCULATOR_OPTION.psplitbag };
  }
  return { pfamily: choice, pstockbag: null, psplitbag: null };
}

/** The selector value that represents the current URL state. */
export function calculatorFamilyChoice(pfamily: string | null | undefined, pstockbag: string | null | undefined, psplitbag?: string | null): string {
  const family = String(pfamily || "");
  if (family === STOCK_BAG_CALCULATOR_OPTION.pfamily && pstockbag === STOCK_BAG_CALCULATOR_OPTION.pstockbag) {
    return STOCK_BAG_CALCULATOR_OPTION.value;
  }
  if (family === SPLIT_BAG_CALCULATOR_OPTION.pfamily && psplitbag === SPLIT_BAG_CALCULATOR_OPTION.psplitbag) {
    return SPLIT_BAG_CALCULATOR_OPTION.value;
  }
  return family;
}

/* ------------------------------------------------------------------ *
 * Pre-calculation validation (client UX only — the server still fails
 * closed on its own; this only stops an obviously incomplete submit).
 * ------------------------------------------------------------------ */
export const REQUIRED_FIELDS_MESSAGE = "Complete the highlighted fields before calculating.";

export type CalculatorFormShape = {
  isBags: boolean;
  isStockBag: boolean;
  jars: boolean;
  isStickers: boolean;
  isBanners: boolean;
  isCustom: boolean;
  isDtp: boolean;
  topRequired: boolean;
  /** A single sticker-bag record is auto-selected, so no product picker renders. */
  autoBag: boolean;
  /** Stickers with a contour cut need a measured perimeter. */
  contourCut: boolean;
};

export type MissingField = { name: string; label: string };

const filled = (value: string | null | undefined) => String(value ?? "").trim() !== "";
const positive = (value: string | null | undefined) => {
  const n = Number(String(value ?? "").trim());
  return filled(value) && Number.isFinite(n) && n > 0;
};

/**
 * The visible required fields that are still empty or invalid. `read` returns
 * the current form value for a field name ("" when absent).
 */
export function missingRequiredCalculatorFields(shape: CalculatorFormShape, read: (name: string) => string): MissingField[] {
  const missing: MissingField[] = [];
  const pickerShown = (shape.isBags && !shape.autoBag) || shape.jars || shape.isCustom || shape.isDtp;
  if (pickerShown && !filled(read("pblank"))) missing.push({ name: "pblank", label: shape.isDtp ? "DTP size / product" : "Product" });
  if (shape.topRequired && !filled(read("plid"))) missing.push({ name: "plid", label: "Top type" });
  if (!positive(read("pqty"))) missing.push({ name: "pqty", label: "Quantity" });
  if (!filled(read("pdesigns"))) missing.push({ name: "pdesigns", label: "Number of designs" });
  if (!shape.isDtp && !shape.jars) {
    if (!positive(read("pwidth"))) missing.push({ name: "pwidth", label: shape.isBanners ? "Banner width" : "Print width" });
    if (!positive(read("pheight"))) missing.push({ name: "pheight", label: shape.isBanners ? "Banner height" : "Print height" });
  }
  if (!shape.isDtp && !filled(read("pmat"))) missing.push({ name: "pmat", label: "Material" });
  if (!shape.isDtp && Number(read("pwhitelayers") || 0) > 0 && !positive(read("pwhitecoverage"))) {
    missing.push({ name: "pwhitecoverage", label: "White coverage %" });
  }
  if (shape.isStickers && shape.contourCut && !positive(read("pl0perim"))) {
    missing.push({ name: "pl0perim", label: "Contour cut-path perimeter" });
  }
  return missing;
}

/* ------------------------------------------------------------------ *
 * Server blocker summary — plain English first, raw codes collapsed.
 * ------------------------------------------------------------------ */
type BlockerKind = "info" | "blocked";
const BLOCKER_PLAIN: Record<string, { kind: BlockerKind; text: string }> = {
  QUANTITY_REQUIRED: { kind: "info", text: "Quantity" },
  BANNER_SIZE_REQUIRED: { kind: "info", text: "Banner width and height" },
  LABEL_PRINT_GEOMETRY_REQUIRED: { kind: "info", text: "Print dimensions (width and height)" },
  CUTLINE_GEOMETRY_REQUIRED: { kind: "info", text: "Print dimensions (width and height)" },
  MISSING_NESTING_MODEL: { kind: "info", text: "Print dimensions (width and height)" },
  INVALID_NESTING_ITEM: { kind: "info", text: "Print dimensions (width and height)" },
  EMPTY_PHYSICAL_RUN: { kind: "info", text: "Quantity and print dimensions" },
  CUT_PATH_ESTIMATE_REQUIRED: { kind: "info", text: "Contour cut-path perimeter" },
  APPLICATION_ITEM_QUANTITY_REQUIRED: { kind: "info", text: "Number of items to apply labels to" },
  WHITE_COVERAGE_REQUIRED: { kind: "info", text: "White coverage %" },
  CUSTOM_SIZE_INCOMPLETE: { kind: "info", text: "Complete the custom size override (or turn it off)" },
  CUSTOM_SIZE_CONFLICT: { kind: "info", text: "Custom size entered without the override switched on" },
  NO_PRINTED_COMPONENT: { kind: "info", text: "At least one printed label" },
  CUSTOM_ITEM_COST_REQUIRED: { kind: "info", text: "Custom item name, cost and reason" },
  STOCK_BAG_PERSONALIZED_DESIGN_COUNT_INVALID: { kind: "info", text: "Number of personalized designs" },
  MISSING_CALIBRATION: { kind: "blocked", text: "Printer calibration for this ink setup" },
  MISSING_INK_PRICE: { kind: "blocked", text: "Verified ink price" },
  MISSING_MATERIAL_COST: { kind: "blocked", text: "A material with a verified cost" },
  LABEL_MATERIAL_COST_REQUIRED: { kind: "blocked", text: "A material with a verified cost" },
  BANNER_MATERIAL_COST_REQUIRED: { kind: "blocked", text: "A banner material with a verified cost" },
  BAG_BLANK_COST_REQUIRED: { kind: "blocked", text: "Verified blank bag cost" },
  MIMAKI_SPECIALTY_UNSUPPORTED: { kind: "blocked", text: "White/gloss cannot print on the Mimaki — choose Auto or Roland" },
  STICKER_BAG_BELOW_MOQ: { kind: "blocked", text: "Quantity is below the Sticker Bag minimum" },
  STOCK_BAG_BELOW_MOQ: { kind: "blocked", text: "Quantity is below the Stock Bag minimum (50)" },
  STANDARD_PRODUCTION_DIMENSIONS_NOT_CONFIRMED: { kind: "blocked", text: "Confirmed product dimensions" },
  LABEL_GEOMETRY_UNSUPPORTED: { kind: "blocked", text: "Confirmed label dimensions for this product" },
  MISSING_APPLICATION_STANDARD: { kind: "blocked", text: "Owner label-application time standard" },
  APPLICATION_RATE_REQUIRED: { kind: "blocked", text: "Owner label-application time standard" },
  BANNER_FINISHING_RATE_REQUIRED: { kind: "blocked", text: "Banner finishing standard" },
  BANNER_TRIM_RATE_REQUIRED: { kind: "blocked", text: "Banner trimming standard" },
  BANNER_DOUBLE_SIDED_UNSUPPORTED: { kind: "blocked", text: "Double-sided banners are not supported yet" },
  BANNER_ROUTE_REQUIRED: { kind: "blocked", text: "Banner printer route" },
  ITEM_EXCEEDS_PRINTABLE_WIDTH: { kind: "blocked", text: "Item is wider than the printable media" },
  MISSING_MEDIA_WIDTH: { kind: "blocked", text: "Media width for the selected material" },
  MISSING_PRINTABLE_WIDTH: { kind: "blocked", text: "Media width for the selected material" },
  INVALID_COVERAGE: { kind: "blocked", text: "Valid white/gloss coverage %" },
  INVALID_LAYER_COUNT: { kind: "blocked", text: "Valid white/gloss layer counts" },
  CANONICAL_FAMILY_FAIL_CLOSED: { kind: "blocked", text: "This product's costing is not approved yet" },
  FAMILY_NOT_CANONICAL: { kind: "blocked", text: "This product has no canonical costing yet" },
  OWNER_PRICING_REVIEW_REQUIRED: { kind: "blocked", text: "Owner pricing review (manual / vendor quote)" },
};
// Wrapper / informational codes that never name the missing thing themselves.
const BLOCKER_WRAPPERS = new Set(["CANONICAL_TRUE_COST_REQUIRED", "DRAFT_ONLY"]);
const CODE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

export type BlockerSummary = {
  /** NEEDS INFORMATION when every reason is something the owner can type in; otherwise PRICING BLOCKED. */
  kind: "NEEDS_INFORMATION" | "PRICING_BLOCKED";
  /** 1-4 plain-English lines. */
  items: string[];
  /** Raw engine codes found, for Advanced diagnostics. */
  codes: string[];
};

export function summarizeCalculatorBlockers(blockers: Array<string | null | undefined>): BlockerSummary | null {
  const texts = blockers.map((b) => String(b ?? "")).filter((b) => b.trim() !== "");
  if (!texts.length) return null;
  const items: string[] = [];
  const codes: string[] = [];
  let anyBlocked = false;
  let unexplained = false;
  for (const text of texts) {
    const found = (text.match(CODE_PATTERN) || []).filter((code) => !BLOCKER_WRAPPERS.has(code));
    const known = found.filter((code) => BLOCKER_PLAIN[code]);
    for (const code of found) if (!codes.includes(code)) codes.push(code);
    if (!known.length) {
      // A wrapper-only line restates another line's blocker; anything else is
      // a real reason we have no plain wording for.
      const wrapperOnly = (text.match(CODE_PATTERN) || []).some((code) => BLOCKER_WRAPPERS.has(code)) && !found.length;
      if (!wrapperOnly) unexplained = true;
      continue;
    }
    // One plain line per blocker: the first code the engine named.
    const plain = BLOCKER_PLAIN[known[0]];
    if (plain.kind === "blocked") anyBlocked = true;
    if (!items.includes(plain.text)) items.push(plain.text);
  }
  if (unexplained) {
    anyBlocked = true;
    const other = "Other production data — see Advanced diagnostics";
    if (!items.includes(other)) items.push(other);
  }
  if (!items.length) {
    items.push("See Advanced diagnostics");
    anyBlocked = true;
  }
  const capped = items.length > 4 ? [...items.slice(0, 3), `${items.length - 3} more — see Advanced diagnostics`] : items;
  return { kind: anyBlocked ? "PRICING_BLOCKED" : "NEEDS_INFORMATION", items: capped, codes };
}

/* ------------------------------------------------------------------ *
 * SELLING-PRICE AUTHORITY (owner decisions 2026-10-19).
 *
 * Which EXISTING, owner-approved rule set the price of a server tier row — or
 * that none did. Pure classification of numbers the server already computed;
 * it never prices anything. Used by BOTH the calculator UI and the save
 * action, so what the owner sees is what the quote records.
 *
 * Evidence: docs/GSO_PRICING_AUTHORITY_MATRIX.md (customer price authority +
 * evidence class per family) and docs/GSO_JAR_PRICING_AUTHORITY_AUDIT.md.
 *   - 4x5 bag bands ............ MARKET RESEARCH ratified by owner  -> approved
 *   - Stickers & labels ........ MARKET RESEARCH + OWNER RULE      -> approved
 *   - Stock Bags ............... live storefront price authority (owner decision C)
 *   - Miron / 3oz / 4oz jars ... owner 16D ladder (+ owner floor)  -> approved
 *   - DTP ...................... owner DTP ladders                 -> approved
 *   - Chiron curve ............. "unsourced family default"        -> NOT approved (owner decision D)
 *   - Miron curve (off-ladder) . unsourced (jar audit section 3)   -> NOT approved
 *   - Banners curve ............ "unsourced family default"        -> NOT approved
 *   - provisional universal curve, custom items                    -> NOT approved
 * ------------------------------------------------------------------ */
export const PROVISIONAL_PRICING_STATUS = "PROVISIONAL — PRICING AUTHORITY REQUIRED";

/** Researched margin curves the owner has ratified as a customer-price authority. */
/** 2026-10-19: the whole calculator is owner only (server-enforced in owner-authorization.server.ts). */
export const COST_PRICING_OWNER_ONLY_MESSAGE = "The Cost & Pricing Calculator is owner only.";

export const APPROVED_MARGIN_CURVE_AUTHORITIES: Readonly<Record<string, string>> = {
  "bags-4x5": "4x5 bag quantity bands — market research ratified by the owner (docs/GSO_PRICING_AUTHORITY_MATRIX.md)",
  "stickers-labels": "Stickers & labels curve + area market floor — market research + owner rule (docs/GSO_PRICING_AUTHORITY_MATRIX.md)",
};

/** Curves present in code that are NOT an approved customer-price authority, with the documented reason. */
export const UNAPPROVED_MARGIN_CURVES: Readonly<Record<string, string>> = {
  "chiron-jars": "Chiron jars have no owner-approved price ladder. The Chiron margin curve is an unsourced family default (docs/GSO_PRICING_AUTHORITY_MATRIX.md), not an owner-approved price.",
  "miron-jars": "This Miron configuration is outside the owner 16D price ladder. The Miron margin curve is an unsourced family default (docs/GSO_JAR_PRICING_AUTHORITY_AUDIT.md section 3), not an owner-approved price.",
  banners: "The Banners margin curve is an unsourced family default (docs/GSO_PRICING_AUTHORITY_MATRIX.md), not an owner-approved price.",
};

export type SellingPriceAuthorityKind =
  | "storefront_stock_bag"
  | "owner_jar_ladder"
  | "owner_dtp_ladder"
  | "owner_dtp_custom_price"
  | "approved_margin_curve"
  | "cost_blocked"
  | "quote_required"
  | "none";

export type SellingPriceAuthority = {
  approved: boolean;
  kind: SellingPriceAuthorityKind;
  /** Staff wording of the authority that set the price (approved only). */
  label: string | null;
  /** Why there is no approved price (not approved only). */
  missing: string | null;
  /** An owner job-level margin edit was applied on top of an approved authority. */
  ownerMarginEdit: boolean;
};

const NO_AUTHORITY_TEXT = "No owner-approved margin curve or price ladder exists for this product. The provisional universal curve is not an approved price.";
const CUSTOM_ITEM_AUTHORITY_TEXT = "Custom items have no approved selling-price rule.";

export function resolveSellingPriceAuthority(input: {
  /** canonicalUiFamily(pfamily). */
  family: string | null;
  stockBag: boolean;
  /** pfamily=sticker-bags + psplitbag=1. */
  splitBag?: boolean;
  /** marginFamilyKeyFor(...) — the researched curve key, or null. */
  marginRuleKey: string | null;
  row: any | null;
  multiLine?: any | null;
}): SellingPriceAuthority {
  const base = { ownerMarginEdit: false };
  const combined = input.multiLine?.combined ?? null;
  if (combined) {
    if (combined.blockers?.length || combined.finalTotalPrice == null) return { ...base, approved: false, kind: "cost_blocked", label: null, missing: "The job has no true cost yet." };
    return { ...base, approved: true, kind: "approved_margin_curve", label: APPROVED_MARGIN_CURVE_AUTHORITIES["stickers-labels"], missing: null };
  }
  const row = input.row;
  if (!row || row.draftOnly || row.jobCost == null) return { ...base, approved: false, kind: "cost_blocked", label: null, missing: "The job has no true cost yet." };

  // DTP: the owner DTP ladders are the only authority.
  if (row.dtp) {
    if (String(row.status) === "BLOCKED") {
      return { ...base, approved: false, kind: "quote_required", label: null, missing: (row.dtp.statusReasons || [])[0] || "No owner DTP price ladder applies — request a current vendor quote / manual review." };
    }
    if (row.dtp.customUnitPrice != null) {
      return { ...base, approved: true, kind: "owner_dtp_custom_price", label: `Owner custom unit price for this job (${row.dtp.pricingSource})`, missing: null };
    }
    if (String(row.dtp.ladderStatus || "") !== "OWNER_APPROVED") {
      return { ...base, approved: false, kind: "quote_required", label: null, missing: "Legacy DTP size — no current owner-approved price ladder. Manual / vendor review required (the legacy ladder in the tier table is reference only)." };
    }
    return { ...base, approved: true, kind: "owner_dtp_ladder", label: `Owner DTP price ladder (${row.dtp.pricingSource})`, missing: null };
  }

  if (input.family === "custom-item" || input.family === "custom") {
    return { ...base, approved: false, kind: "none", label: null, missing: CUSTOM_ITEM_AUTHORITY_TEXT };
  }

  // Split Bag: no approved selling price yet (owner decision 2026-11-11) —
  // PROVISIONAL, owner job-level price. Never the 4x5 Sticker Bag curve.
  if (input.splitBag && !input.stockBag) {
    return { ...base, approved: false, kind: "none", label: null, missing: SPLIT_BAG_PRICE_AUTHORITY_TEXT };
  }

  // Stock Bags: the live storefront price authority (owner decision C).
  if (input.stockBag) {
    const sb = row.stockBagStorefront;
    if (sb?.ok && row.totalPrice != null) {
      return { ...base, approved: true, kind: "storefront_stock_bag", label: `Live storefront Stock Bag price (${sb.version || "storefront-canonical"}) — the same authority the online checkout charges`, missing: null };
    }
    return { ...base, approved: false, kind: "quote_required", label: null, missing: sb?.reason || "The storefront Stock Bag price authority does not price this configuration." };
  }

  const ownerMarginEdit = /owner per-tier margin edit/i.test(String(row.commercial?.marginSource || ""));
  if (row.commercial?.ownerLadder) {
    return {
      approved: true, ownerMarginEdit, kind: "owner_jar_ladder", missing: null,
      label: row.commercial.ownerLadder.raisedByFloor
        ? "Owner jar price ladder (16D) — held at the owner minimum margin floor (ladder price is below it)"
        : "Owner jar price ladder (16D, approved 2026-08-12)",
    };
  }
  const key = String(input.marginRuleKey || "");
  if (key && APPROVED_MARGIN_CURVE_AUTHORITIES[key]) {
    return { approved: true, ownerMarginEdit, kind: "approved_margin_curve", label: APPROVED_MARGIN_CURVE_AUTHORITIES[key], missing: null };
  }
  return { ...base, approved: false, kind: "none", label: null, missing: (key && UNAPPROVED_MARGIN_CURVES[key]) || NO_AUTHORITY_TEXT };
}

/* ------------------------------------------------------------------ *
 * The headline result — true cost, recommended price, profit, margin.
 * ------------------------------------------------------------------ */
export type OwnerResultState =
  | "READY"
  | "OWNER_OVERRIDE"
  | "OVERRIDE_REQUIRED"
  | "PRICE_NOT_AVAILABLE"
  | "NEEDS_INFORMATION"
  | "PRICING_BLOCKED";

export type OwnerResult = {
  state: OwnerResultState;
  badge: string;
  quantity: number | null;
  trueJobCost: number | null;
  trueUnitCost: number | null;
  /** True cost includes owner-approved provisional standards (canonical PROVISIONAL). */
  provisionalCost: boolean;
  recommendedTotal: number | null;
  recommendedUnit: number | null;
  profit: number | null;
  marginPct: number | null;
  /** The existing approved authority that set the price (null when none applies). */
  priceAuthority: string | null;
  /** Why no approved price is shown (null when one is). */
  missingAuthority: string | null;
  /** 1-4 plain reasons for NEEDS_INFORMATION / PRICING_BLOCKED / overrides. */
  reasons: string[];
  freightIncluded: number;
  authority: SellingPriceAuthority | null;
  /** Owner-visible warning on an APPROVED price (e.g. storefront Stock Bag price below the standard margin target). */
  marginWarning: string | null;
};

export type OwnerResultInput = {
  /** canonicalUiFamily(pfamily): sticker-bags, standard-jars, premium-jars, stickers-labels, banners, custom-item, dtp-bags. */
  family: string | null;
  /** pfamily=sticker-bags + pstockbag=1. */
  stockBag?: boolean;
  /** pfamily=sticker-bags + psplitbag=1. */
  splitBag?: boolean;
  canonical: { status: string; totalCost: number; unitCost: number | null; blockers: string[] } | null;
  /** The server tier row for the requested quantity (loader productMode.tiers). */
  requestedRow: any | null;
  /** loader productMode.multiLine (multi-line sticker jobs). */
  multiLine: any | null;
  /** loader productMode.marginFamily key (marginFamilyKeyFor). */
  marginRuleKey: string | null;
};

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The owner headline. Returns null before anything was calculated (no
 * quantity, no canonical result) so a blank form never renders a red card.
 */
export function resolveOwnerResult(input: OwnerResultInput): OwnerResult | null {
  const canonical = input.canonical;
  const row = input.requestedRow;
  const combined = input.multiLine?.combined ?? null;
  if (!canonical && !row && !combined) return null;

  const blocked = canonical?.status === "DRAFT_ONLY";
  // Canonical families: the canonical true cost IS the authority. A blocked
  // canonical job publishes no cost — not its partial sum, and never $0.
  let trueJobCost: number | null = canonical ? (blocked ? null : finite(canonical.totalCost)) : finite(row?.jobCost);
  let trueUnitCost: number | null = canonical ? (blocked ? null : finite(canonical.unitCost)) : finite(row?.unitCost);
  if (combined) {
    trueJobCost = finite(combined.totalCost);
    trueUnitCost = finite(combined.unitCost);
  }
  const base = {
    quantity: finite(combined?.totalQuantity) ?? finite(row?.quantity),
    trueJobCost,
    trueUnitCost,
    provisionalCost: canonical?.status === "PROVISIONAL",
    freightIncluded: finite(row?.freightTotal) ?? 0,
    marginWarning: null as string | null,
  };
  const noPrice = { recommendedTotal: null, recommendedUnit: null, profit: null, marginPct: null };

  const blockerList: string[] = combined
    ? [...(combined.blockers || [])]
    : [...(row?.blockers || []), ...(row ? [] : canonical?.blockers || [])];
  const costMissing = combined
    ? combined.blockers?.length > 0 || trueJobCost == null
    : trueJobCost == null || !row || row.draftOnly || row.jobCost == null;

  // 1. No usable cost -> no price. Plain reasons; raw codes stay collapsed.
  if (costMissing) {
    const summary = summarizeCalculatorBlockers(blockerList.length ? blockerList : canonical?.blockers || []);
    const kind = summary?.kind ?? "PRICING_BLOCKED";
    return {
      ...base,
      ...noPrice,
      state: kind,
      badge: kind === "NEEDS_INFORMATION" ? "NEEDS INFORMATION" : "PRICING BLOCKED",
      priceAuthority: null,
      missingAuthority: null,
      reasons: summary?.items ?? ["See Advanced diagnostics"],
      authority: null,
    };
  }

  const authority = resolveSellingPriceAuthority({ family: input.family, stockBag: Boolean(input.stockBag), splitBag: Boolean(input.splitBag), marginRuleKey: input.marginRuleKey, row, multiLine: input.multiLine });

  // 2. True cost exists but no approved price authority -> NOT AVAILABLE.
  //    The generic/unsourced price the tier table may still carry is never shown here.
  if (!authority.approved) {
    const quoteRequired = authority.kind === "quote_required";
    const legacyDtp = /Legacy DTP size/.test(String(authority.missing));
    return {
      ...base,
      ...noPrice,
      state: "PRICE_NOT_AVAILABLE",
      badge: legacyDtp ? "MANUAL / VENDOR REVIEW" : quoteRequired ? "QUOTE REQUIRED" : PROVISIONAL_PRICING_STATUS,
      priceAuthority: null,
      missingAuthority: authority.missing,
      reasons: row?.dtp ? (row.dtp.statusReasons || []).slice(0, 4) : [],
      authority,
    };
  }

  // 3. Multi-line sticker job — the combined quote (Stickers & Labels authority).
  if (combined) {
    return {
      ...base,
      state: "READY",
      badge: "READY TO QUOTE",
      recommendedTotal: finite(combined.finalTotalPrice),
      recommendedUnit: finite(combined.finalTotalPrice) != null && base.quantity ? combined.finalTotalPrice / base.quantity : null,
      profit: finite(combined.achievedProfit),
      marginPct: finite(combined.achievedMarginPct),
      priceAuthority: `${authority.label} — ${combined.controllingRule}`,
      missingAuthority: null,
      reasons: [],
      authority,
    };
  }

  const priced = {
    recommendedTotal: finite(row.totalPrice),
    recommendedUnit: finite(row.unitPrice),
    profit: finite(row.profit),
    marginPct: finite(row.actualMarginPct),
  };
  // 2026-10-19 owner decision 5: the exact storefront Stock Bag price is an
  // approved authority — below the generic target it WARNS, it never requires an override.
  const storefrontPrice = authority.kind === "storefront_stock_bag";
  const belowFloor = !storefrontPrice && (Boolean(row.belowFloor) || /BELOW FLOOR/i.test(String(row.status || "")));
  const overrideRequired = belowFloor || (!storefrontPrice && String(row.status) === "OWNER OVERRIDE REQUIRED");
  const ownerSet = authority.kind === "owner_dtp_custom_price" || authority.ownerMarginEdit;
  return {
    ...base,
    ...priced,
    state: overrideRequired ? "OVERRIDE_REQUIRED" : ownerSet ? "OWNER_OVERRIDE" : "READY",
    badge: overrideRequired
      ? belowFloor ? "BELOW MARGIN FLOOR — OWNER OVERRIDE REQUIRED" : "OWNER OVERRIDE REQUIRED"
      : authority.kind === "owner_dtp_custom_price" ? "OWNER CUSTOM PRICE (this job only)"
      : authority.ownerMarginEdit ? "OWNER MARGIN EDIT (this job only)"
      : "READY TO QUOTE",
    priceAuthority: authority.ownerMarginEdit ? `Owner job-level margin edit on: ${authority.label}` : authority.label,
    missingAuthority: null,
    reasons: row.dtp ? (row.dtp.statusReasons || []).slice(0, 4) : [],
    authority,
    marginWarning: storefrontPrice && row.belowMarginTarget ? String(row.marginWarning || "Approved storefront price is below the standard margin target.") : null,
  };
}
