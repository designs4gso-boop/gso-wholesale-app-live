// Phase 0D — 4X5 Sticker Bag identity + required-Zakeke policy.
//
// LOCKED OWNER RULES pinned here:
//   sticker_bag_4x5 is its own family ("Sticker Bags") — NOT a Stock Bag,
//   NOT an ordinary Sticker. Zakeke is REQUIRED on it; ADD YOUR BRAND is not
//   available to it. Stock Bags remain the sole Zakeke exception.
//   Materials: Matte and Gloss share ONE base material cost class;
//   Holographic is its own. Gloss (material) is not Spot Gloss (finish).
//
// Repo test convention (same as tests/zakeke-handoff.test.ts): pure helpers +
// real payload building + repo source pins. No Prisma, no Shopify, no route
// imports — route wiring is asserted by reading the source.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  productFamilyForConfiguratorType,
  isStickerBagProductType,
  configuratorProductGate,
  CONFIGURATOR_FAMILIES,
} from "../app/lib/product-family";
import {
  ZAKEKE_DESIGN_ID_KEY,
  ZAKEKE_PREVIEW_KEY,
  productTypeRequiresZakekeDesign,
  resolveZakekeDesign,
  zakekeDesignGate,
  ZAKEKE_REQUIRED_PRODUCT_TYPES,
} from "../app/lib/zakeke-design.server";
import {
  BAG_MATERIAL_OPTIONS,
  STOREFRONT_BAG_MIN_QTY,
  bagMaterialClassFor,
} from "../app/lib/storefront-canonical-pricing.server";
import { BAG_4X5_BLANK_UNIT_COST } from "../app/lib/bag-cost-inputs.server";
import { buildShopifyOrderJobPayload } from "../app/lib/production-job-source.server";

const STICKER_BAG_TYPE = "sticker_bag_4x5";
const DESIGN_ID = "zk-4x5-9f2c8a41";

/* ------------------------------------------------------------------ *
 * 1-4  Product-family classification
 * ------------------------------------------------------------------ */

describe("0D product-family classification", () => {
  it("classifies sticker_bag_4x5 as its own family", () => {
    expect(productFamilyForConfiguratorType(STICKER_BAG_TYPE)).toBe("Sticker Bags");
  });

  it("never classifies a sticker bag as a Stock Bag", () => {
    expect(productFamilyForConfiguratorType(STICKER_BAG_TYPE)).not.toBe("Stock Bags");
  });

  it("never classifies a sticker bag as an ordinary Sticker", () => {
    // sticker_bag_ must be tested BEFORE the generic sticker_ prefix
    expect(productFamilyForConfiguratorType(STICKER_BAG_TYPE)).not.toBe("Stickers");
    expect(isStickerBagProductType(STICKER_BAG_TYPE)).toBe(true);
    expect(isStickerBagProductType("sticker_regular")).toBe(false);
    expect(isStickerBagProductType("sticker_die_cut")).toBe(false);
  });

  it("keeps every existing family exactly where it was", () => {
    expect(productFamilyForConfiguratorType("stock_bag_4x5")).toBe("Stock Bags");
    expect(productFamilyForConfiguratorType("jar_100ml_tall")).toBe("Jars");
    expect(productFamilyForConfiguratorType("jar_3oz_black_white")).toBe("Jars");
    expect(productFamilyForConfiguratorType("dtp_4x5x2")).toBe("DTP Pouches");
    expect(productFamilyForConfiguratorType("sticker_regular")).toBe("Stickers");
    expect(productFamilyForConfiguratorType("sticker_die_cut")).toBe("Stickers");
  });

  it("FAILS CLOSED on an unknown or missing product type — never silently a Stock Bag", () => {
    // the pre-0D behaviour coerced anything unrecognised (and any empty
    // productType, via `product.productType || "stock_bag_4x5"`) into the
    // Stock Bag family, which would have opened ADD YOUR BRAND on it.
    expect(productFamilyForConfiguratorType("")).toBeNull();
    expect(productFamilyForConfiguratorType(null)).toBeNull();
    expect(productFamilyForConfiguratorType(undefined)).toBeNull();
    expect(productFamilyForConfiguratorType("something_new")).toBeNull();
  });

  it("exposes the family vocabulary as data so callers cannot invent a family", () => {
    expect(CONFIGURATOR_FAMILIES).toContain("Sticker Bags");
    expect(CONFIGURATOR_FAMILIES).toContain("Stock Bags");
    expect(new Set(CONFIGURATOR_FAMILIES).size).toBe(CONFIGURATOR_FAMILIES.length);
  });
});

/* ------------------------------------------------------------------ *
 * 0D-F  EXECUTABLE fail-closed gate
 *
 * The 0D suite proved this with toContain() source pins only. Mutation testing
 * showed those pins stayed green when the guard was inverted, dead-coded, or
 * removed. The decision now lives in configuratorProductGate, so these tests
 * EXECUTE it: an inverted or broken gate fails here, not silently.
 * ------------------------------------------------------------------ */

describe("0D-F configurator fail-closed gate (executable)", () => {
  it("REJECTS a missing productType — and specifically does not become Stock Bags", () => {
    for (const missing of ["", "   ", null, undefined]) {
      const gate = configuratorProductGate(missing);
      expect(gate.ok).toBe(false);
      expect(gate).toEqual({ ok: false, code: "PRODUCT_NOT_CONFIGURABLE" });
      // the exact pre-0D failure mode: an empty type inheriting the one family
      // that ADD YOUR BRAND is allowed on
      expect((gate as any).family).toBeUndefined();
    }
  });

  it("REJECTS an unknown productType rather than guessing", () => {
    for (const unknown of ["something_new", "custom", "stock_bag", "sticker", "jar", "bag_sticker_4x5"]) {
      expect(configuratorProductGate(unknown)).toEqual({ ok: false, code: "PRODUCT_NOT_CONFIGURABLE" });
    }
  });

  it("ALLOWS every known type, with the right family", () => {
    expect(configuratorProductGate("sticker_bag_4x5")).toEqual({ ok: true, family: "Sticker Bags" });
    expect(configuratorProductGate("stock_bag_4x5")).toEqual({ ok: true, family: "Stock Bags" });
    expect(configuratorProductGate("sticker_regular")).toEqual({ ok: true, family: "Stickers" });
    expect(configuratorProductGate("sticker_die_cut")).toEqual({ ok: true, family: "Stickers" });
    expect(configuratorProductGate("jar_100ml_tall")).toEqual({ ok: true, family: "Jars" });
    expect(configuratorProductGate("dtp_4x5x2")).toEqual({ ok: true, family: "DTP Pouches" });
  });

  it("is a total function — every input yields a discriminated result, never a throw", () => {
    for (const weird of [0, false, NaN, {}, [], Symbol.iterator.toString()]) {
      expect(() => configuratorProductGate(weird as any)).not.toThrow();
      expect(typeof configuratorProductGate(weird as any).ok).toBe("boolean");
    }
  });
});

describe("0D both proxies share ONE classifier (they cannot drift)", () => {
  const loader = readFileSync("app/routes/apps.wholesale-lite.configurator.ts", "utf8");
  const checkout = readFileSync("app/routes/apps.wholesale-lite.configurator-checkout.ts", "utf8");

  it("delegates the decision to the shared gate instead of redefining it", () => {
    for (const src of [loader, checkout]) {
      expect(src).toContain("configuratorProductGate(productType)");
      // the duplicated local definition is gone
      expect(/function\s+productFamilyForType\s*\(/.test(src)).toBe(false);
    }
  });

  it("no longer hard-defaults a missing productType to the Stock Bag type", () => {
    // quote-agnostic: the 0D pin only matched the double-quoted form, so
    // restoring the fallback with single quotes slipped past it
    for (const src of [loader, checkout]) {
      expect(/product\.productType\s*\|\|\s*['"`]stock_bag_4x5['"`]/.test(src)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5-7  Zakeke requirement
 * ------------------------------------------------------------------ */

describe("0D required-Zakeke policy", () => {
  it("requires a design for the 4X5 Sticker Bag", () => {
    expect(productTypeRequiresZakekeDesign(STICKER_BAG_TYPE)).toBe(true);
    expect(ZAKEKE_REQUIRED_PRODUCT_TYPES).toContain(STICKER_BAG_TYPE);
  });

  it("does NOT require a design for Stock Bags — the locked owner exception", () => {
    expect(productTypeRequiresZakekeDesign("stock_bag_4x5")).toBe(false);
  });

  it("is added incrementally — no other family is swept in by this patch", () => {
    for (const type of ["jar_100ml_tall", "jar_3oz_clear", "dtp_4x5x2", "sticker_regular", "sticker_die_cut", "", "anything"]) {
      expect(productTypeRequiresZakekeDesign(type)).toBe(false);
    }
  });
});

describe("0D Stock Bags remain Zakeke-exempt at the storefront gate", () => {
  const bridge = readFileSync("extensions/wholesale-theme/assets/gso-zakeke-bridge.js", "utf8");

  it("keeps the Stock Bag family block untouched", () => {
    expect(bridge).toContain('var ZAKEKE_EXEMPT_TYPES = ["stock bag"];');
    expect(bridge).toContain("ZAKEKE_EXEMPT_TYPES.indexOf(productType()) === -1");
  });
});

/* ------------------------------------------------------------------ *
 * 0D-F  EXECUTABLE required-Zakeke gate
 * ------------------------------------------------------------------ */

describe("0D-F required-Zakeke gate (executable)", () => {
  const validDesign = resolveZakekeDesign(DESIGN_ID);

  it("REJECTS a sticker bag with NO design", () => {
    expect(zakekeDesignGate(STICKER_BAG_TYPE, null)).toEqual({ ok: false, code: "ZAKEKE_DESIGN_REQUIRED" });
  });

  it("REJECTS a sticker bag whose posted design fails sanitization", () => {
    // these are the values resolveZakekeDesign turns into null — the gate must
    // see the SANITIZED result, so each is indistinguishable from "no design"
    for (const hostile of ["", "   ", "<script>x</script>", "a b", "../../etc/passwd", "x".repeat(201)]) {
      expect(resolveZakekeDesign(hostile)).toBeNull();
      expect(zakekeDesignGate(STICKER_BAG_TYPE, resolveZakekeDesign(hostile))).toEqual({
        ok: false,
        code: "ZAKEKE_DESIGN_REQUIRED",
      });
    }
  });

  it("ALLOWS a sticker bag carrying a valid sanitized design", () => {
    expect(validDesign).not.toBeNull();
    expect(zakekeDesignGate(STICKER_BAG_TYPE, validDesign)).toEqual({ ok: true });
  });

  it("ALLOWS a Stock Bag with no design — the locked owner exception", () => {
    expect(zakekeDesignGate("stock_bag_4x5", null)).toEqual({ ok: true });
  });

  it("leaves every currently-non-required family unchanged", () => {
    for (const type of ["jar_100ml_tall", "jar_3oz_clear", "dtp_4x5x2", "sticker_regular", "sticker_die_cut", "", "anything"]) {
      expect(zakekeDesignGate(type, null)).toEqual({ ok: true });
    }
  });
});

describe("0D checkout enforcement wiring (source pins, supplementary to the executable gate above)", () => {
  const checkout = readFileSync("app/routes/apps.wholesale-lite.configurator-checkout.ts", "utf8");

  it("delegates to the shared gate and maps its code to a 400", () => {
    expect(checkout).toContain("zakekeDesignGate(productType, zakekeDesign)");
    expect(checkout).toContain("code: designGate.code");
    expect(checkout).toContain("status: 400");
  });

  it("only ever passes the SANITIZED design to the gate, never the raw posted value", () => {
    expect(checkout).toContain("resolveZakekeDesign(rawItem.zakekeDesignId");
    expect(/zakekeDesignGate\([^)]*rawItem\./.test(checkout)).toBe(false);
  });

  it("still never lets the design reach a pricing input", () => {
    expect(/price[A-Za-z]*\([^)]*zakeke/i.test(checkout)).toBe(false);
    expect(checkout.includes("rawItem.price")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 8-11  Order handoff + ERP routing
 * ------------------------------------------------------------------ */

function canonical(profile: string) {
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

// A canonical STICKER snapshot. Note the shape is materially different from a
// bag snapshot: it carries family:"stickers", which is exactly what stops
// parseCanonicalStickerOrderLine from ever claiming a sticker-BAG line.
function stickerCanonical() {
  return JSON.stringify({
    v: "16F-storefront-canonical-sticker",
    family: "stickers",
    profile: "sticker_regular",
    stickerType: "regular",
    widthIn: 3,
    heightIn: 3,
    areaSqIn: 9,
    qty: 100,
    material: "Matte",
    holo: false,
    whiteRequired: false,
    specialtyX: 0,
    finishLabel: "No Specialty — 0X",
    cutType: "square-rect",
    unitPrice: 0.44,
    subtotal: 44,
    engine: "canonical-sticker-pricing/16F",
  });
}

function stickerLine() {
  return {
    id: 7003,
    title: "Custom Stickers",
    quantity: 100,
    price: "0.44",
    properties: [
      { name: "Product Family", value: "Stickers" },
      { name: "Product Type", value: "sticker_regular" },
      { name: "Material", value: "Matte" },
      { name: "Finish", value: "No Specialty — 0X" },
      { name: "_GSO Canonical", value: stickerCanonical() },
    ],
  };
}

function stickerBagLine(extra: Array<{ name: string; value: string }> = []) {
  return {
    id: 7001,
    title: "4X5 Sticker Bag",
    quantity: 250,
    price: "1.32",
    product_id: 7854390280257,
    variant_id: 43689303507009,
    properties: [
      { name: "Product Family", value: "Sticker Bags" },
      { name: "Product Type", value: STICKER_BAG_TYPE },
      { name: "Material", value: "Matte" },
      { name: "Finish", value: "No Specialty — 0X" },
      { name: "Bag Color", value: "White" },
      { name: "Sides", value: "Double Sided" },
      { name: "_GSO Canonical", value: canonical(STICKER_BAG_TYPE) },
      ...extra,
    ],
  };
}

function paidOrder(line: any) {
  return {
    id: 99101,
    name: "#1101",
    admin_graphql_api_id: "gid://shopify/Order/99101",
    email: "buyer@example.com",
    line_items: [line],
  };
}

describe("0D paid-order handoff for the sticker bag", () => {
  it("carries a valid design id through to the job payload", () => {
    const payload: any = buildShopifyOrderJobPayload(
      paidOrder(stickerBagLine([{ name: ZAKEKE_DESIGN_ID_KEY, value: DESIGN_ID }])),
      "GSO-1101",
    );
    expect(payload).not.toBeNull();
    expect(payload.zakekeDesigns).toHaveLength(1);
    expect(payload.zakekeDesigns[0].designId).toBe(DESIGN_ID);
  });

  it("keeps the preview SERVER-DERIVED from the id — a posted URL is never trusted", () => {
    const payload: any = buildShopifyOrderJobPayload(
      paidOrder(
        stickerBagLine([
          { name: ZAKEKE_DESIGN_ID_KEY, value: DESIGN_ID },
          { name: ZAKEKE_PREVIEW_KEY, value: "https://evil.example.com/pwn.png" },
        ]),
      ),
      "GSO-1102",
    );
    expect(payload.zakekeDesigns[0].previewUrl).toBe(`/apps/zakeke/preview/${DESIGN_ID}`);
    expect(JSON.stringify(payload)).not.toContain("evil.example.com");
  });

  it("routes an all-sticker-bag order to the sticker-bags checklist family", () => {
    const payload: any = buildShopifyOrderJobPayload(paidOrder(stickerBagLine()), "GSO-1103");
    expect(payload.checklistFamily).toBe("sticker-bags");
  });

  it("does NOT route it to the flat sticker/label checklist", () => {
    const payload: any = buildShopifyOrderJobPayload(paidOrder(stickerBagLine()), "GSO-1104");
    expect(payload.checklistFamily).not.toBe("stickers-labels");
  });

  it("MIXED sticker + sticker-bag order falls back to the default checklist", () => {
    // 0D-F: pinning the CURRENT intended behaviour explicitly. Before this
    // patch a sticker-bag line classified as "sticker", so this order was
    // uniform and took "stickers-labels". Now the two lines are two families,
    // so the pre-existing uniform-family-only rule yields "default".
    //
    // That is the INTENTIONAL mixed-family fallback and it matches how every
    // other mixed order already behaves. Redesigning mixed-family production
    // checklists is deliberately out of scope for this phase.
    const order = {
      id: 99102,
      name: "#1102",
      admin_graphql_api_id: "gid://shopify/Order/99102",
      email: "buyer@example.com",
      line_items: [stickerBagLine(), stickerLine()],
    };
    const payload: any = buildShopifyOrderJobPayload(order, "GSO-1106");
    expect(payload).not.toBeNull();
    expect(payload.checklistFamily).toBe("default");
  });

  it("an all-regular-sticker order still reaches stickers-labels", () => {
    const stickerOnly = {
      id: 99103,
      name: "#1103",
      admin_graphql_api_id: "gid://shopify/Order/99103",
      email: "buyer@example.com",
      line_items: [stickerLine()],
    };
    const payload: any = buildShopifyOrderJobPayload(stickerOnly, "GSO-1107");
    expect(payload).not.toBeNull();
    expect(payload.checklistFamily).toBe("stickers-labels");
  });

  it("leaves every other family's checklist routing byte-identical", () => {
    const stockBag = {
      id: 7002,
      title: "Ritz Vanilla Cupcake",
      quantity: 50,
      price: "2.70",
      properties: [
        { name: "Product Family", value: "Stock Bags" },
        { name: "Product Type", value: "stock_bag_4x5" },
        { name: "Material", value: "Matte" },
        { name: "Finish", value: "No Specialty — 0X" },
        { name: "Bag Color", value: "White" },
        { name: "_GSO Canonical", value: canonical("stock_bag_4x5") },
      ],
    };
    // stock bags kept their pre-0D "default" checklist
    expect((buildShopifyOrderJobPayload(paidOrder(stockBag), "GSO-1105") as any).checklistFamily).toBe("default");
  });
});

/* ------------------------------------------------------------------ *
 * 14-15  Material cost classes
 * ------------------------------------------------------------------ */

describe("0D bag material cost classes", () => {
  it("puts Matte and Gloss in the SAME base material class", () => {
    expect(bagMaterialClassFor("Matte")).toBe("matte");
    expect(bagMaterialClassFor("Gloss")).toBe("matte");
    expect(bagMaterialClassFor("Gloss")).toBe(bagMaterialClassFor("Matte"));
  });

  it("keeps Holographic a distinct class", () => {
    expect(bagMaterialClassFor("Holographic")).toBe("holographic");
    expect(bagMaterialClassFor("Holographic")).not.toBe(bagMaterialClassFor("Matte"));
  });

  it("never confuses the Gloss MATERIAL with a Spot Gloss FINISH", () => {
    // "Gloss" as a material is a surface, not a specialty layer: it must not
    // read as holographic, and it must not imply the white underbase.
    expect(bagMaterialClassFor("Gloss")).not.toBe("holographic");
    // finish vocabulary must never be mistaken for a material
    expect(bagMaterialClassFor("Spot Gloss — 1X")).toBe("matte");
    expect(bagMaterialClassFor("Raised Gloss — 2X")).toBe("matte");
  });

  it("offers all three owner-approved materials to the storefront", () => {
    expect(BAG_MATERIAL_OPTIONS).toEqual(["Matte", "Gloss", "Holographic"]);
  });
});

/* ------------------------------------------------------------------ *
 * 8 (foundations)  MOQ + blank-bag cost non-regression
 * ------------------------------------------------------------------ */

describe("0D storefront/cost foundations are unchanged", () => {
  it("keeps the storefront bag MOQ at 50", () => {
    expect(STOREFRONT_BAG_MIN_QTY).toBe(50);
  });

  it("keeps the canonical blank 4x5 bag cost at the $0.09 supplier base", () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.09);
  });
});
