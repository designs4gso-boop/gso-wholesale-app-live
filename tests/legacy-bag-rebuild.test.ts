// Phase 16C — proof tests for the legacy Stock Bag rebuild helpers.
// These pin the invariants the gated CLI relies on: strict legacy-set
// membership, refuse-don't-guess planning, the exact ERP row shape the
// configurator sync writes, and post-write acceptance calibrated to the
// healthy-fleet reference.
import { describe, expect, it } from "vitest";
import {
  CANONICAL_TAG,
  CANONICAL_TEMPLATE_SUFFIX,
  CANONICAL_VARIANT_PRICE,
  EXPECTED_LEGACY_COUNT,
  REBUILD_NOTES_MARKER,
  classifyProduct,
  erpRowDataFor,
  planRebuild,
  snapshotOf,
  verifyRebuilt,
} from "../tools/legacy-bag-rebuild-lib.mjs";

const emptyErp = { gids: new Set<string>(), handles: new Set<string>(), titles: new Set<string>() };

function legacyProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Product/1",
    handle: "ding-dongz-birthday-cake",
    title: "Ding Dongz Birthday Cake",
    status: "DRAFT",
    productType: "Stock Bag",
    tags: ["Stock Bags", "stock-bag"],
    variantsCount: { count: 24 },
    ...overrides,
  };
}

function legacyDetail() {
  return {
    id: "gid://shopify/Product/1",
    handle: "ding-dongz-birthday-cake",
    title: "Ding Dongz Birthday Cake",
    status: "DRAFT",
    productType: "Stock Bag",
    vendor: "GSO Packaging",
    templateSuffix: null,
    tags: ["Stock Bags", "stock-bag"],
    mediaCount: { count: 7 },
    options: [
      { id: "gid://shopify/ProductOption/10", name: "Sided", position: 1, values: ["Single Sided", "Double Sided"] },
      { id: "gid://shopify/ProductOption/11", name: "Material", position: 2, values: ["Matte", "Holographic"] },
      { id: "gid://shopify/ProductOption/12", name: "Bag Color", position: 3, values: ["Purple", "Teal"] },
    ],
    variants: {
      nodes: [
        {
          id: "gid://shopify/ProductVariant/101",
          title: "Single Sided / Matte / Purple",
          position: 1,
          price: "1.00",
          compareAtPrice: null,
          barcode: null,
          inventoryPolicy: "DENY",
          selectedOptions: [
            { name: "Sided", value: "Single Sided" },
            { name: "Material", value: "Matte" },
            { name: "Bag Color", value: "Purple" },
          ],
          inventoryItem: { sku: "DDBC-1", tracked: false },
        },
        {
          id: "gid://shopify/ProductVariant/102",
          title: "Double Sided / Matte / Purple",
          position: 2,
          price: "1.25",
          compareAtPrice: null,
          barcode: null,
          inventoryPolicy: "DENY",
          selectedOptions: [
            { name: "Sided", value: "Double Sided" },
            { name: "Material", value: "Matte" },
            { name: "Bag Color", value: "Purple" },
          ],
          inventoryItem: { sku: "DDBC-2", tracked: false },
        },
      ],
    },
  };
}

describe("classifyProduct (legacy set membership)", () => {
  it("classifies a drafted multi-variant untagged unlinked Stock Bag as legacy", () => {
    expect(classifyProduct(legacyProduct(), emptyErp)).toBe("legacy");
  });

  it("never classifies an ERP-linked product as legacy (gid, handle, or title)", () => {
    const byGid = { ...emptyErp, gids: new Set(["gid://shopify/Product/1"]) };
    const byTitle = { ...emptyErp, titles: new Set(["Ding Dongz Birthday Cake"]) };
    const byHandle = { ...emptyErp, handles: new Set(["ding-dongz-birthday-cake"]) };
    expect(classifyProduct(legacyProduct(), byGid)).not.toBe("legacy");
    expect(classifyProduct(legacyProduct(), byTitle)).not.toBe("legacy");
    expect(classifyProduct(legacyProduct(), byHandle)).not.toBe("legacy");
  });

  it("excludes ACTIVE products, pilot-tagged products, and non Stock Bag types", () => {
    expect(classifyProduct(legacyProduct({ status: "ACTIVE" }), emptyErp)).toBe("other");
    expect(classifyProduct(legacyProduct({ tags: [CANONICAL_TAG] }), emptyErp)).toBe("other");
    expect(classifyProduct(legacyProduct({ productType: "" }), emptyErp)).toBe("other");
  });

  it("recognizes the canonical fleet shape", () => {
    const canonical = legacyProduct({ tags: [CANONICAL_TAG], variantsCount: { count: 1 } });
    const erp = { ...emptyErp, gids: new Set(["gid://shopify/Product/1"]) };
    expect(classifyProduct(canonical, erp)).toBe("canonical");
  });

  it("pins the expected rebuild census", () => {
    expect(EXPECTED_LEGACY_COUNT).toBe(31);
  });
});

describe("planRebuild", () => {
  it("keeps the position-1 variant and deletes the rest plus every option", () => {
    const plan = planRebuild(legacyDetail());
    expect(plan.errors).toEqual([]);
    expect(plan.keepVariantId).toBe("gid://shopify/ProductVariant/101");
    expect(plan.keepVariantSku).toBe("DDBC-1");
    expect(plan.deleteVariantIds).toEqual(["gid://shopify/ProductVariant/102"]);
    expect(plan.optionIds).toHaveLength(3);
    expect(plan.needsTemplateSuffix).toBe(true);
  });

  it("refuses products that are not in the audited legacy shape", () => {
    const active = { ...legacyDetail(), status: "ACTIVE" };
    expect(planRebuild(active).errors.length).toBeGreaterThan(0);
    const single = legacyDetail();
    single.variants.nodes = single.variants.nodes.slice(0, 1);
    expect(planRebuild(single).errors.some((e: string) => e.includes("nothing to collapse"))).toBe(true);
    const tagged = { ...legacyDetail(), tags: [CANONICAL_TAG] };
    expect(planRebuild(tagged).errors.some((e: string) => e.includes("configurator-pilot"))).toBe(true);
  });
});

describe("erpRowDataFor (configurator-sync row parity)", () => {
  it("mirrors the sync route field-for-field with rebuild provenance", () => {
    const row = erpRowDataFor(legacyDetail(), "gid://shopify/ProductVariant/101", "DDBC-1");
    expect(row).toMatchObject({
      title: "Ding Dongz Birthday Cake",
      shopifyProductGid: "gid://shopify/Product/1",
      shopifyVariantGid: "gid://shopify/ProductVariant/101",
      shopifyHandle: "ding-dongz-birthday-cake",
      sku: "DDBC-1",
      productType: "stock_bag_4x5",
      defaultSides: "Double Sided",
      minQuantity: 64,
      pilot: true,
      active: true,
    });
    expect(row.notes).toContain(REBUILD_NOTES_MARKER);
    expect(row.notes).toContain("canonical engine (50)");
  });
});

describe("snapshotOf (rollback fidelity)", () => {
  it("captures status, template, tags, options, and full variant identity", () => {
    const snapshot = snapshotOf(legacyDetail());
    expect(snapshot.previousStatus).toBe("DRAFT");
    expect(snapshot.previousTemplateSuffix).toBeNull();
    expect(snapshot.previousTags).toContain("Stock Bags");
    expect(snapshot.options.map((o: { name: string }) => o.name)).toEqual(["Sided", "Material", "Bag Color"]);
    expect(snapshot.variants).toHaveLength(2);
    expect(snapshot.variants[0]).toMatchObject({
      id: "gid://shopify/ProductVariant/101",
      price: "1.00",
      sku: "DDBC-1",
      inventoryPolicy: "DENY",
    });
    expect(snapshot.variants[0].selectedOptions).toHaveLength(3);
  });
});

describe("verifyRebuilt (post-write acceptance)", () => {
  const reference = { inventoryPolicy: "CONTINUE", tracked: false };

  function rebuiltDetail() {
    return {
      templateSuffix: CANONICAL_TEMPLATE_SUFFIX,
      tags: ["Stock Bags", "stock-bag", CANONICAL_TAG],
      options: [{ id: "gid://shopify/ProductOption/9", name: "Title", position: 1, values: ["Default Title"] }],
      variants: {
        nodes: [
          { id: "gid://shopify/ProductVariant/101", title: "Default Title", price: CANONICAL_VARIANT_PRICE, inventoryPolicy: "CONTINUE" },
        ],
      },
    };
  }

  it("accepts the canonical single-variant shape", () => {
    expect(verifyRebuilt(rebuiltDetail(), reference)).toEqual({ ok: true, problems: [] });
  });

  it("rejects every deviation: variants, options, price, policy, tag, template", () => {
    const twoVariants = rebuiltDetail();
    twoVariants.variants.nodes.push({ ...twoVariants.variants.nodes[0], id: "gid://shopify/ProductVariant/102" });
    expect(verifyRebuilt(twoVariants, reference).ok).toBe(false);

    const wrongPrice = rebuiltDetail();
    wrongPrice.variants.nodes[0].price = "1.25";
    expect(verifyRebuilt(wrongPrice, reference).ok).toBe(false);

    const wrongPolicy = rebuiltDetail();
    wrongPolicy.variants.nodes[0].inventoryPolicy = "DENY";
    expect(verifyRebuilt(wrongPolicy, reference).ok).toBe(false);

    const noTag = rebuiltDetail();
    noTag.tags = ["Stock Bags"];
    expect(verifyRebuilt(noTag, reference).ok).toBe(false);

    const noTemplate = { ...rebuiltDetail(), templateSuffix: null };
    expect(verifyRebuilt(noTemplate, reference).ok).toBe(false);
  });
});
