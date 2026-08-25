// Phase 0E — production intake must not treat every canonical BAG snapshot as
// a Stock Bag.
//
// THE DEFECT
//
// `parseCanonicalOrderLine` accepts ANY non-empty `profile` string, so a
// Sticker Bag snapshot (profile "sticker_bag_4x5") parses exactly like a Stock
// Bag one. Two intake sites then drew a Stock-Bag conclusion from that parse
// alone: the ADD YOUR BRAND decoder and the productFamily fallback for lines
// whose visible properties were stripped.
//
// LOCKED OWNER RULES pinned here:
//   stock_bag_4x5   premade GSO artwork, ADD YOUR BRAND allowed, Zakeke N/A
//   sticker_bag_4x5 customer artwork, Zakeke REQUIRED, ADD YOUR BRAND FORBIDDEN
//
// Repo test convention: pure helpers + real payload building, no Prisma, no
// Shopify, no route imports.
import { describe, expect, it } from "vitest";

import {
  buildShopifyOrderJobPayload,
  decodeOrderPersonalization,
} from "../app/lib/production-job-source.server";
import { ZAKEKE_DESIGN_ID_KEY } from "../app/lib/zakeke-design.server";

const STOCK_BAG = "stock_bag_4x5";
const STICKER_BAG = "sticker_bag_4x5";
const DESIGN_ID = "zk-0e-7d41aa02";

/** A real Stock Bag personalization asset token: <M|G><digits>:<R|P>. */
const ASSET_TOKEN = "M30572556091457:R";

function bagCanonical(profile: string) {
  return JSON.stringify({
    v: "15G.5-storefront-canonical",
    profile,
    qty: 250,
    faces: 2,
    material: "Matte",
    bagColor: "White",
    holo: false,
    whiteRequired: false,
    glossX: 0,
    finishLabel: "No Specialty — 0X",
    unitPrice: 1.32,
    engine: "canonical-bag-pricing/15G.4C",
  });
}

/**
 * A line whose VISIBLE properties were stripped — only the server-created
 * canonical snapshot survives. This is precisely the case where intake has to
 * fall back on the snapshot, and precisely where the defect showed.
 */
function strippedLine(profile: string, extra: Array<{ name: string; value: string }> = []) {
  return {
    id: 8001,
    title: "4X5 Bag",
    quantity: 250,
    price: "1.32",
    properties: [{ name: "_GSO Canonical", value: bagCanonical(profile) }, ...extra],
  };
}

function personalizationProps() {
  return [
    { name: "_GSO Personalization Count", value: "1" },
    { name: "_GSO Personalization Assets", value: ASSET_TOKEN },
    { name: "_GSO Personalization Files", value: "customer logo.png" },
  ];
}

/** productFamily lives inside the item priceSnapshot JSON, not on the item. */
function familyOf(payload: any, index = 0): string {
  return JSON.parse(payload.items[index].priceSnapshot).productFamily;
}

/** productType lives in the same snapshot. */
function typeOf(payload: any, index = 0): string {
  return JSON.parse(payload.items[index].priceSnapshot).productType;
}

function paidOrder(lines: any[], id = 99201) {
  return {
    id,
    name: `#${id}`,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    email: "buyer@example.com",
    line_items: lines,
  };
}

/* ------------------------------------------------------------------ *
 * Stock Bags — the behaviour that must be PRESERVED
 * ------------------------------------------------------------------ */

describe("0E Stock Bags keep every Stock-Bag-only behaviour", () => {
  it("a stripped stock_bag_4x5 line is still identified as Stock Bags", () => {
    const payload: any = buildShopifyOrderJobPayload(paidOrder([strippedLine(STOCK_BAG)]), "GSO-2001");
    expect(payload).not.toBeNull();
    expect(familyOf(payload)).toBe("Stock Bags");
    expect(typeOf(payload)).toBe(STOCK_BAG);
  });

  it("a stock_bag_4x5 line still enters ADD YOUR BRAND resolution", () => {
    const decoded = decodeOrderPersonalization(paidOrder([strippedLine(STOCK_BAG, personalizationProps())]));
    expect(decoded).toHaveLength(1);
    expect(decoded[0].assets).toHaveLength(1);
    expect(decoded[0].assets[0].assetId).toBe("gid://shopify/MediaImage/30572556091457");
    expect(decoded[0].warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Sticker Bags — the defect
 * ------------------------------------------------------------------ */

describe("0E Sticker Bags are never mistaken for Stock Bags at intake", () => {
  it("a stripped sticker_bag_4x5 line is NOT identified as Stock Bags", () => {
    const payload: any = buildShopifyOrderJobPayload(paidOrder([strippedLine(STICKER_BAG)]), "GSO-2002");
    expect(payload).not.toBeNull();
    expect(familyOf(payload)).not.toBe("Stock Bags");
    expect(familyOf(payload)).toBe("Sticker Bags");
    // the productType fallback already read the profile correctly — pin it so
    // the family fix cannot regress it
    expect(typeOf(payload)).toBe(STICKER_BAG);
  });

  it("a sticker_bag_4x5 line does NOT enter Stock Bag personalization resolution", () => {
    const decoded = decodeOrderPersonalization(paidOrder([strippedLine(STICKER_BAG, personalizationProps())]));
    expect(decoded).toHaveLength(1);
    expect(decoded[0].assets).toEqual([]);
  });

  it("ADD YOUR BRAND metadata on a sticker bag is REFUSED, with a warning, not silently used", () => {
    const decoded = decodeOrderPersonalization(paidOrder([strippedLine(STICKER_BAG, personalizationProps())]));
    expect(decoded[0].warnings.length).toBeGreaterThan(0);
    expect(decoded[0].warnings.join(" ")).toMatch(/not a canonical GSO Stock Bag/i);
  });

  it("no personalization ProductionJobFile is produced for a sticker bag", () => {
    const order = paidOrder([strippedLine(STICKER_BAG, personalizationProps())]);
    const payload: any = buildShopifyOrderJobPayload(order, "GSO-2003");
    expect(payload.personalizationFiles || []).toEqual([]);
  });

  it("retains its Sticker Bag family and checklist identity", () => {
    const payload: any = buildShopifyOrderJobPayload(paidOrder([strippedLine(STICKER_BAG)]), "GSO-2004");
    expect(payload.checklistFamily).toBe("sticker-bags");
  });
});

/* ------------------------------------------------------------------ *
 * Zakeke artwork must still flow — 0E must not disturb the 17C.1 contract
 * ------------------------------------------------------------------ */

describe("0E the Zakeke artwork path is untouched", () => {
  const order = paidOrder([strippedLine(STICKER_BAG, [{ name: ZAKEKE_DESIGN_ID_KEY, value: DESIGN_ID }])], 99205);

  it("still carries the design id through to the job payload", () => {
    const payload: any = buildShopifyOrderJobPayload(order, "GSO-2005");
    expect(payload.zakekeDesigns).toHaveLength(1);
    expect(payload.zakekeDesigns[0].designId).toBe(DESIGN_ID);
    expect(payload.zakekeDesigns[0].previewUrl).toBe(`/apps/zakeke/preview/${DESIGN_ID}`);
  });

  it("Zakeke artwork survives even when ADD YOUR BRAND metadata is refused on the same line", () => {
    // the two artwork channels are independent: refusing one must not drop the other
    const mixed = paidOrder(
      [strippedLine(STICKER_BAG, [...personalizationProps(), { name: ZAKEKE_DESIGN_ID_KEY, value: DESIGN_ID }])],
      99206,
    );
    const payload: any = buildShopifyOrderJobPayload(mixed, "GSO-2006");
    expect(payload.zakekeDesigns[0].designId).toBe(DESIGN_ID);
    expect(payload.personalizationFiles || []).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Other families — no regressions
 * ------------------------------------------------------------------ */

describe("0E other families are unaffected", () => {
  function jarLine() {
    return {
      id: 8002,
      title: "100ML Tall Miron Jars",
      quantity: 128,
      price: "3.10",
      properties: [
        { name: "Product Family", value: "Jars" },
        { name: "Product Type", value: "jar_100ml_tall" },
        { name: "Material", value: "Matte" },
        { name: "Finish", value: "No Spot Gloss" },
        { name: "Label Set", value: "Side + Lid" },
      ],
    };
  }

  function dtpLine() {
    return {
      id: 8003,
      title: "4x5 Custom Pouch",
      quantity: 1000,
      price: "0.62",
      properties: [
        { name: "Product Family", value: "DTP Pouches" },
        { name: "Product Type", value: "dtp_4x5x2" },
        { name: "Material", value: "Soft-Touch Lamination (Included)" },
        { name: "Finish", value: "Included Spec" },
      ],
    };
  }

  it("jars keep their family and checklist", () => {
    const payload: any = buildShopifyOrderJobPayload(paidOrder([jarLine()], 99207), "GSO-2007");
    expect(familyOf(payload)).toBe("Jars");
    expect(payload.checklistFamily).toBe("premium-jars");
  });

  it("DTP pouches keep their family and checklist", () => {
    const payload: any = buildShopifyOrderJobPayload(paidOrder([dtpLine()], 99208), "GSO-2008");
    expect(familyOf(payload)).toBe("DTP Pouches");
    expect(payload.checklistFamily).toBe("dtp-bags");
  });

  it("neither jars nor DTP enter Stock Bag personalization", () => {
    for (const line of [jarLine(), dtpLine()]) {
      const withAssets = { ...line, properties: [...line.properties, ...personalizationProps()] };
      const decoded = decodeOrderPersonalization(paidOrder([withAssets], 99209));
      expect(decoded[0].assets).toEqual([]);
    }
  });

  it("a malformed canonical snapshot still falls back to visible properties, unchanged", () => {
    const malformed = {
      id: 8004,
      title: "Ritz Vanilla Cupcake",
      quantity: 50,
      price: "2.70",
      properties: [
        { name: "_GSO Canonical", value: "{ not json" },
        { name: "Product Family", value: "Stock Bags" },
        { name: "Product Type", value: STOCK_BAG },
        { name: "Material", value: "Matte" },
        { name: "Finish", value: "No Specialty — 0X" },
        { name: "Bag Color", value: "White" },
      ],
    };
    const payload: any = buildShopifyOrderJobPayload(paidOrder([malformed], 99210), "GSO-2010");
    expect(payload).not.toBeNull();
    expect(familyOf(payload)).toBe("Stock Bags");
  });

  it("an unknown line with no canonical snapshot and no markers produces no job", () => {
    const unknown = { id: 8005, title: "Mystery", quantity: 1, price: "1.00", properties: [] };
    expect(buildShopifyOrderJobPayload(paidOrder([unknown], 99211), "GSO-2011")).toBeNull();
  });
});
