import { describe, expect, it } from "vitest";

import {
  AUDIT_STATUS_LABELS,
  auditStatus,
  buildCsv,
  csvEscape,
  deltaAgainstBand,
  gidKeys,
  gidTail,
  matchVariantToErp,
  normalizeSku,
  pickErpCost,
  splitIdList,
  type ErpCost,
  type ErpMatch,
} from "../app/lib/shopify-cost-audit-shared";

const match = (table: ErpMatch["table"], id: string, matchedBy: ErpMatch["matchedBy"] = "sku"): ErpMatch => ({
  table,
  id,
  name: `${table}-${id}`,
  matchedBy,
});

function indexWith(input: {
  variant?: Record<string, ErpMatch[]>;
  product?: Record<string, ErpMatch[]>;
  handle?: Record<string, ErpMatch[]>;
  sku?: Record<string, ErpMatch[]>;
}) {
  return {
    byVariantKey: new Map(Object.entries(input.variant || {})),
    byProductKey: new Map(Object.entries(input.product || {})),
    byHandle: new Map(Object.entries(input.handle || {})),
    bySku: new Map(Object.entries(input.sku || {})),
  };
}

describe("sku and gid normalization", () => {
  it("normalizes SKUs by trimming and upper-casing", () => {
    expect(normalizeSku("  preset:miron-50ml ")).toBe("PRESET:MIRON-50ML");
    expect(normalizeSku(null)).toBe("");
  });

  it("extracts numeric gid tails and both key forms", () => {
    expect(gidTail("gid://shopify/ProductVariant/1234567")).toBe("1234567");
    expect(gidKeys("gid://shopify/ProductVariant/42")).toEqual(["gid://shopify/ProductVariant/42", "42"]);
    expect(gidKeys("  ")).toEqual([]);
  });

  it("splits comma/space separated id lists", () => {
    expect(splitIdList("1, 2,3\n4")).toEqual(["1", "2", "3", "4"]);
    expect(splitIdList(null)).toEqual([]);
  });
});

describe("matcher precedence", () => {
  const variantHit = match("recipe", "r1", "variant_gid");
  const productHit = match("configurator", "c1", "product_gid");
  const skuHit = match("vendor_product", "v1", "sku");

  const fullIndex = indexWith({
    variant: { "111": [variantHit] },
    product: { "222": [productHit] },
    sku: { "SKU-1": [skuHit] },
  });

  it("variant GID beats product GID beats SKU", () => {
    const byVariant = matchVariantToErp(fullIndex, { variantId: "gid://shopify/ProductVariant/111", productId: "gid://shopify/Product/222", handle: "h", sku: "sku-1" });
    expect(byVariant.level).toBe("variant_gid");
    expect(byVariant.matches).toEqual([variantHit]);

    const byProduct = matchVariantToErp(fullIndex, { variantId: "gid://shopify/ProductVariant/999", productId: "gid://shopify/Product/222", handle: "h", sku: "sku-1" });
    expect(byProduct.level).toBe("product_gid");
    expect(byProduct.matches).toEqual([productHit]);

    const bySku = matchVariantToErp(fullIndex, { variantId: "gid://shopify/ProductVariant/999", productId: "gid://shopify/Product/888", handle: "h", sku: " SKU-1 " });
    expect(bySku.level).toBe("sku");
    expect(bySku.matches).toEqual([skuHit]);
  });

  it("matches by handle at the product level", () => {
    const index = indexWith({ handle: { "my-jar": [productHit] } });
    const result = matchVariantToErp(index, { variantId: "", productId: "", handle: "My-Jar", sku: "" });
    expect(result.level).toBe("product_gid");
    expect(result.matches).toEqual([productHit]);
  });

  it("returns none when nothing matches", () => {
    const result = matchVariantToErp(fullIndex, { variantId: "5", productId: "6", handle: "nope", sku: "missing" });
    expect(result.level).toBe("none");
    expect(result.matches).toEqual([]);
  });

  it("dedupes the same record matched via multiple keys", () => {
    const dup = match("recipe", "r1", "variant_gid");
    const index = indexWith({ variant: { "111": [dup, { ...dup }] } });
    const result = matchVariantToErp(index, { variantId: "111", productId: "", handle: "", sku: "" });
    expect(result.matches).toHaveLength(1);
  });
});

describe("ambiguity and cost authority", () => {
  it("multiple distinct records at the same level are ambiguous (caller checks length)", () => {
    const index = indexWith({ sku: { "SKU-1": [match("vendor_product", "v1"), match("material", "m1")] } });
    const result = matchVariantToErp(index, { variantId: "", productId: "", handle: "", sku: "sku-1" });
    expect(result.matches).toHaveLength(2);
  });

  it("pickErpCost prefers computed recipe, then vendor, then material, then configurator, then legacy", () => {
    const matches = [match("pricing_rule", "p1"), match("material", "m1"), match("vendor_product", "v1"), match("recipe", "r1")];
    const costIndex = {
      vendorCostById: new Map([["v1", { source: "vendor_product", low: 2, high: 3, label: "vendor" } as ErpCost]]),
      materialCostById: new Map([["m1", { source: "material", low: 4, high: 4, label: "material" } as ErpCost]]),
      pricingRuleCostById: new Map([["p1", { source: "pricing_rule", low: 9, high: 9, label: "legacy" } as ErpCost]]),
      configuratorCostByProductType: new Map<string, ErpCost>(),
      configuratorTypeById: new Map<string, string>(),
    };
    const recipeCosts = new Map([["r1", { source: "recipe_computed", low: 1.5, high: 1.5, label: "computed" } as ErpCost]]);

    expect(pickErpCost(matches, costIndex, recipeCosts)?.source).toBe("recipe_computed");
    expect(pickErpCost(matches, costIndex, new Map())?.source).toBe("vendor_product");
    expect(pickErpCost([match("material", "m1"), match("pricing_rule", "p1")], costIndex, new Map())?.source).toBe("material");
    expect(pickErpCost([match("pricing_rule", "p1")], costIndex, new Map())?.source).toBe("pricing_rule");
    expect(pickErpCost([match("recipe", "rX")], costIndex, new Map())).toBeNull();
  });
});

describe("delta math and tolerance boundary", () => {
  it("is zero inside the band and measured from the nearest edge outside it", () => {
    expect(deltaAgainstBand(2.5, 2, 3).delta).toBe(0);
    expect(deltaAgainstBand(3.3, 2, 3).delta).toBeCloseTo(0.3, 6);
    expect(deltaAgainstBand(3.3, 2, 3).deltaPct).toBeCloseTo(10, 6);
    expect(deltaAgainstBand(1.5, 2, 3).deltaPct).toBeCloseTo(-25, 6);
  });

  const erpCost: ErpCost = { source: "vendor_product", low: 2, high: 2, label: "x" };
  const base = { inventoryAccess: true, ambiguous: false, matched: true, erpCost, tolerancePct: 5 };

  it("statuses flip exactly at the tolerance boundary", () => {
    expect(auditStatus({ ...base, shopifyCost: 2.1 })).toBe("within_tolerance"); // exactly +5%
    expect(auditStatus({ ...base, shopifyCost: 2.11 })).toBe("above_erp");
    expect(auditStatus({ ...base, shopifyCost: 1.9 })).toBe("within_tolerance"); // exactly -5%
    expect(auditStatus({ ...base, shopifyCost: 1.89 })).toBe("below_erp");
  });

  it("covers the non-numeric statuses", () => {
    expect(auditStatus({ ...base, shopifyCost: 2, ambiguous: true })).toBe("ambiguous");
    expect(auditStatus({ ...base, shopifyCost: 2, matched: false })).toBe("no_erp_match");
    expect(auditStatus({ ...base, shopifyCost: 2, inventoryAccess: false })).toBe("cost_unavailable");
    expect(auditStatus({ ...base, shopifyCost: null })).toBe("missing_shopify_cost");
    expect(auditStatus({ ...base, shopifyCost: 2, erpCost: null })).toBe("needs_review");
  });

  it("has a label for every status", () => {
    for (const label of Object.values(AUDIT_STATUS_LABELS)) expect(label.length).toBeGreaterThan(0);
  });
});

describe("csv escaping", () => {
  it("escapes commas, quotes, and newlines", () => {
    expect(csvEscape('Jar, 50ml "Miron"')).toBe('"Jar, 50ml ""Miron"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("plain")).toBe("plain");
  });

  it("builds a header + rows document", () => {
    const csv = buildCsv(["a", "b"], [["1", "x,y"], ["2", 'q"z']]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n2,"q""z"');
  });
});
