// Client-safe pure logic for the Shopify Cost Audit (12B.2b): matching,
// status math, and CSV helpers. No Prisma, no Shopify client, and no imports
// from .server modules — the route component and the tests import this file,
// while app/lib/shopify-cost-audit.server.ts layers the Shopify pull and the
// database index on top.

export const DEFAULT_TOLERANCE_PCT = 5;
export const MAX_UI_ROWS = 600;
// Hard cap on rows returned to the client for CSV/TSV export (well beyond
// this shop's catalog; keeps the loader payload bounded).
export const EXPORT_ROW_CAP = 3000;

function safeNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeSku(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function gidTail(value: unknown) {
  const match = String(value ?? "").trim().match(/(\d+)$/);
  return match ? match[1] : "";
}

// Keys under which a Shopify GID can be found: the trimmed full string and the
// trailing numeric id (ERP fields store either form).
export function gidKeys(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return [] as string[];
  const keys = [text];
  const tail = gidTail(text);
  if (tail && tail !== text) keys.push(tail);
  return keys;
}

export function splitIdList(value: unknown) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildCsv(header: string[], rows: (string | number | null | undefined)[][]) {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.join("\r\n");
}

export type ErpMatch = {
  table: "recipe" | "variant_rule" | "configurator" | "vendor_product" | "material" | "pricing_rule";
  id: string;
  name: string;
  matchedBy: "variant_gid" | "product_gid" | "handle" | "sku";
};

export type ErpCost = {
  source: "recipe_computed" | "vendor_product" | "material" | "configurator" | "pricing_rule";
  low: number;
  high: number;
  label: string;
};

export type AuditStatus =
  | "missing_shopify_cost"
  | "cost_unavailable"
  | "no_erp_match"
  | "above_erp"
  | "below_erp"
  | "within_tolerance"
  | "ambiguous"
  | "needs_review";

export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  missing_shopify_cost: "Shopify cost missing",
  cost_unavailable: "Shopify cost unavailable (scope)",
  no_erp_match: "ERP match missing",
  above_erp: "Shopify cost higher than ERP",
  below_erp: "Shopify cost lower than ERP",
  within_tolerance: "Match within tolerance",
  ambiguous: "Ambiguous — needs manual review",
  needs_review: "Needs manual review",
};

// Severity order for sorting: actionable problems first.
export const AUDIT_STATUS_RANK: Record<AuditStatus, number> = {
  ambiguous: 0,
  above_erp: 1,
  below_erp: 2,
  missing_shopify_cost: 3,
  needs_review: 4,
  no_erp_match: 5,
  cost_unavailable: 6,
  within_tolerance: 7,
};

// Delta of a Shopify cost against an ERP cost band: zero inside the band,
// otherwise measured against the nearest band edge.
export function deltaAgainstBand(shopifyCost: number, low: number, high: number) {
  const reference = Math.min(Math.max(shopifyCost, low), high);
  const base = reference > 0 ? reference : 1;
  const delta = shopifyCost - reference;
  return { delta, deltaPct: (delta / base) * 100 };
}

export function auditStatus(input: {
  inventoryAccess: boolean;
  shopifyCost: number | null;
  ambiguous: boolean;
  matched: boolean;
  erpCost: ErpCost | null;
  tolerancePct: number;
}): AuditStatus {
  if (input.ambiguous) return "ambiguous";
  if (!input.matched) return "no_erp_match";
  if (!input.inventoryAccess) return "cost_unavailable";
  if (input.shopifyCost == null || !(input.shopifyCost > 0)) return "missing_shopify_cost";
  if (!input.erpCost || !(input.erpCost.high > 0)) return "needs_review";

  const tolerance = Math.max(0, safeNumber(input.tolerancePct, DEFAULT_TOLERANCE_PCT)) / 100;
  const lowBound = input.erpCost.low * (1 - tolerance);
  const highBound = input.erpCost.high * (1 + tolerance);
  if (input.shopifyCost > highBound) return "above_erp";
  if (input.shopifyCost < lowBound) return "below_erp";
  return "within_tolerance";
}

export type MatchIndex = {
  byVariantKey: Map<string, ErpMatch[]>;
  byProductKey: Map<string, ErpMatch[]>;
  byHandle: Map<string, ErpMatch[]>;
  bySku: Map<string, ErpMatch[]>;
};

// Most-specific match wins: variant GID, then product GID/handle, then SKU.
export function matchVariantToErp(
  index: MatchIndex,
  input: { variantId: string; productId: string; handle: string; sku: string },
) {
  const dedupe = (matches: ErpMatch[]) => {
    const seen = new Set<string>();
    return matches.filter((match) => {
      const key = `${match.table}:${match.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  for (const key of gidKeys(input.variantId)) {
    const hits = index.byVariantKey.get(key);
    if (hits?.length) return { level: "variant_gid" as const, matches: dedupe(hits) };
  }

  const productHits: ErpMatch[] = [];
  for (const key of gidKeys(input.productId)) productHits.push(...(index.byProductKey.get(key) || []));
  const handle = String(input.handle || "").trim().toLowerCase();
  if (handle) productHits.push(...(index.byHandle.get(handle) || []));
  if (productHits.length) return { level: "product_gid" as const, matches: dedupe(productHits) };

  const sku = normalizeSku(input.sku);
  if (sku) {
    const hits = index.bySku.get(sku);
    if (hits?.length) return { level: "sku" as const, matches: dedupe(hits) };
  }

  return { level: "none" as const, matches: [] as ErpMatch[] };
}

// ---------- Cost-factor classification (12B.2b.3) ----------
// The pull returns every Shopify variant, but most are customer-facing sales
// variants (especially stock-bag configurator option combinations), not cost
// inputs. Classification decides which rows are likely real cost factors so
// the default view is auditable by a human.

export type AuditViewMode =
  | "cost_factors"
  | "erp_matched"
  | "missing_cost"
  | "ambiguous"
  | "stock_configurator"
  | "all";

export const AUDIT_VIEW_LABELS: Record<AuditViewMode, string> = {
  cost_factors: "Cost factors only",
  erp_matched: "ERP matched",
  missing_cost: "Missing Shopify cost",
  ambiguous: "Ambiguous",
  stock_configurator: "Stock/configurator variants",
  all: "All Shopify variants",
};

export type RowClassification = {
  view: "cost_factor" | "stock_configurator" | "other";
  costFactorCandidate: boolean;
  hiddenReason: string | null;
};

const STOCK_CONFIGURATOR_HINT = /(stock[\s_-]?bag|configurator|4\s?x\s?5)/i;
const COST_SIGNAL_HINT = /(blank|jar|\bbags?\b|box|\bcans?\b|media|material|roll|ink|labels?\b|stickers?\b|vendor|outsourc|pouch|tube)/i;

export function classifyAuditRow(input: {
  sku: string;
  shopifyCost: number | null;
  matchLevel: string;
  matches: Pick<ErpMatch, "table" | "matchedBy">[];
  productType: string;
  vendor: string;
  tags: string;
  title: string;
  handle: string;
}): RowClassification {
  const matches = input.matches || [];
  const hasSku = Boolean(normalizeSku(input.sku));
  const hasShopifyCost = input.shopifyCost != null && input.shopifyCost > 0;
  const text = `${input.productType} ${input.vendor} ${input.tags} ${input.title} ${input.handle}`;

  // Strongest evidence first: a SKU-level or variant-level match into a real
  // cost table is a cost factor even if the product text looks configurator-ish
  // (e.g. a "Blank 4x5 bag" vendor item must not be buried as noise).
  const skuCostMatch = matches.some((m) => m.matchedBy === "sku" && m.table !== "configurator");
  const variantLevelMatch =
    input.matchLevel === "variant_gid" &&
    matches.some((m) => m.table === "recipe" || m.table === "variant_rule" || m.table === "pricing_rule");
  if (skuCostMatch || variantLevelMatch) {
    return { view: "cost_factor", costFactorCandidate: true, hiddenReason: null };
  }

  // Storefront/configurator sales variants: matched only through the
  // configurator mapping, or clearly stock-bag/configurator by name.
  const configuratorOnly = matches.length > 0 && matches.every((m) => m.table === "configurator");
  if (configuratorOnly || STOCK_CONFIGURATOR_HINT.test(text)) {
    return { view: "stock_configurator", costFactorCandidate: false, hiddenReason: "Stock/configurator sales variant" };
  }

  // A Shopify cost is itself a cost signal: either it corroborates an ERP
  // match, or it is a cost factor that has not been entered into ERP yet.
  if (hasShopifyCost) {
    return { view: "cost_factor", costFactorCandidate: true, hiddenReason: null };
  }

  // Cost-flavored text (jars, bags, media, ink, ...) counts only with a SKU;
  // no-SKU rows without a cost are hidden from the default view.
  if (hasSku && COST_SIGNAL_HINT.test(text)) {
    return { view: "cost_factor", costFactorCandidate: true, hiddenReason: null };
  }

  if (!hasSku) {
    return { view: "other", costFactorCandidate: false, hiddenReason: "No SKU and no Shopify cost" };
  }
  if (input.matchLevel === "product_gid") {
    return { view: "other", costFactorCandidate: false, hiddenReason: "Matched only by broad product mapping" };
  }
  return { view: "other", costFactorCandidate: false, hiddenReason: "No cost signals (customer-facing sales variant)" };
}

export function rowMatchesViewMode(
  row: {
    view: RowClassification["view"];
    costFactorCandidate: boolean;
    status: AuditStatus;
    matchLevel: string;
  },
  mode: AuditViewMode,
): boolean {
  if (mode === "all") return true;
  if (mode === "cost_factors") return row.costFactorCandidate;
  if (mode === "erp_matched") return row.matchLevel !== "none";
  if (mode === "missing_cost") return row.status === "missing_shopify_cost" || row.status === "cost_unavailable";
  if (mode === "ambiguous") return row.status === "ambiguous";
  return row.view === "stock_configurator";
}

export function summarizeAuditRows(
  rows: Array<{
    view: RowClassification["view"];
    costFactorCandidate: boolean;
    status: AuditStatus;
    matchLevel: string;
    unitCost: number | null;
  }>,
) {
  return {
    totalVariants: rows.length,
    costFactorCandidates: rows.filter((row) => row.costFactorCandidate).length,
    shopifyCostPresent: rows.filter((row) => row.unitCost != null && row.unitCost > 0).length,
    missingShopifyCost: rows.filter((row) => row.status === "missing_shopify_cost" || row.status === "cost_unavailable").length,
    erpMatched: rows.filter((row) => row.matchLevel !== "none").length,
    ambiguous: rows.filter((row) => row.status === "ambiguous").length,
    stockConfiguratorHidden: rows.filter((row) => row.view === "stock_configurator").length,
  };
}

// Authority order for the compared ERP cost.
const COST_AUTHORITY: ErpMatch["table"][] = ["recipe", "vendor_product", "material", "configurator", "pricing_rule"];

export type CostIndex = {
  vendorCostById: Map<string, ErpCost>;
  materialCostById: Map<string, ErpCost>;
  pricingRuleCostById: Map<string, ErpCost>;
  configuratorCostByProductType: Map<string, ErpCost>;
  configuratorTypeById: Map<string, string>;
};

export function pickErpCost(
  matches: ErpMatch[],
  index: CostIndex,
  recipeCostById: Map<string, ErpCost>,
): ErpCost | null {
  for (const table of COST_AUTHORITY) {
    for (const match of matches) {
      if (match.table !== table) continue;
      if (table === "recipe") {
        const cost = recipeCostById.get(match.id);
        if (cost) return cost;
      } else if (table === "vendor_product") {
        const cost = index.vendorCostById.get(match.id);
        if (cost) return cost;
      } else if (table === "material") {
        const cost = index.materialCostById.get(match.id);
        if (cost) return cost;
      } else if (table === "configurator") {
        const type = index.configuratorTypeById.get(match.id) || "";
        const cost = index.configuratorCostByProductType.get(type);
        if (cost) return cost;
      } else if (table === "pricing_rule") {
        const cost = index.pricingRuleCostById.get(match.id);
        if (cost) return cost;
      }
    }
  }
  return null;
}
