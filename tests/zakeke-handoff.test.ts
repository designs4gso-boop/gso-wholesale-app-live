// Phase 17C.1 — Zakeke -> GSO configurator handoff.
// Pure helpers + real payload building + repo source pins (repo test convention:
// no Prisma, no Shopify, no route imports).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildShopifyOrderJobPayload } from "../app/lib/production-job-source.server";
import {
  ZAKEKE_ASSET_SOURCE,
  ZAKEKE_DESIGN_ID_KEY,
  ZAKEKE_MAX_DESIGN_ID,
  ZAKEKE_PREVIEW_KEY,
  buildZakekePreviewUrl,
  readZakekeDesignFromLine,
  resolveZakekeDesign,
  sanitizeZakekeDesignId,
  zakekeLineAttributes,
  zakekeSnapshot,
} from "../app/lib/zakeke-design.server";

const DESIGN_ID = "zk-9f2c8a41";

function orderLine(extraProps: Array<{ name: string; value: string }> = []) {
  return {
    id: 5551,
    title: "Ritz Vanilla Cupcake",
    quantity: 250,
    price: "1.32",
    sku: "ritz-vanilla-cupcake-matte-none-white",
    product_id: 7890553962561,
    variant_id: 43811335176257,
    properties: [
      { name: "Product Family", value: "Stock Bags" },
      { name: "Product Type", value: "stock_bag_4x5" },
      { name: "Material", value: "Matte" },
      { name: "Finish", value: "No Specialty — 0X" },
      { name: "Bag Color", value: "White" },
      { name: "Sides", value: "Double Sided" },
      ...extraProps,
    ],
  };
}

function paidOrder(line: any) {
  return {
    id: 99001,
    name: "#1042",
    admin_graphql_api_id: "gid://shopify/Order/99001",
    email: "buyer@example.com",
    line_items: [line],
  };
}

describe("17C.1 design identity helpers", () => {
  it("accepts a real design id and derives a stable same-origin preview reference", () => {
    const design = resolveZakekeDesign(DESIGN_ID);
    expect(design).toEqual({ designId: DESIGN_ID, previewUrl: `/apps/zakeke/preview/${DESIGN_ID}` });
    expect(buildZakekePreviewUrl(DESIGN_ID).startsWith("/apps/")).toBe(true);
  });

  it("bounds and rejects hostile design ids instead of passing them downstream", () => {
    expect(sanitizeZakekeDesignId('"><script>alert(1)</script>')).toBe("");
    expect(sanitizeZakekeDesignId("https://evil.example.com/steal")).toBe("");
    expect(sanitizeZakekeDesignId("../../etc/passwd")).toBe("");
    expect(sanitizeZakekeDesignId("id with spaces")).toBe("");
    expect(sanitizeZakekeDesignId("a".repeat(ZAKEKE_MAX_DESIGN_ID + 1))).toBe("");
    expect(sanitizeZakekeDesignId("a".repeat(ZAKEKE_MAX_DESIGN_ID))).toBe("a".repeat(ZAKEKE_MAX_DESIGN_ID));
    expect(sanitizeZakekeDesignId(null)).toBe("");
    expect(sanitizeZakekeDesignId(undefined)).toBe("");
    // a rejected id yields no attributes at all rather than a half-populated pair
    expect(zakekeLineAttributes(resolveZakekeDesign("<img src=x>"))).toEqual([]);
  });

  it("never lets a caller supply the preview URL that gets persisted", () => {
    // Only the id is honoured; any URL the client sends is ignored by construction.
    const design = resolveZakekeDesign(DESIGN_ID);
    expect(design?.previewUrl).toBe(`/apps/zakeke/preview/${DESIGN_ID}`);
    expect(JSON.stringify(design)).not.toContain("evil");
  });

  it("emits hidden draft-order attributes only when a design exists", () => {
    expect(zakekeLineAttributes(resolveZakekeDesign(DESIGN_ID))).toEqual([
      { key: ZAKEKE_DESIGN_ID_KEY, value: DESIGN_ID },
      { key: ZAKEKE_PREVIEW_KEY, value: `/apps/zakeke/preview/${DESIGN_ID}` },
    ]);
    expect(zakekeLineAttributes(null)).toEqual([]);
    // underscore prefix keeps these off the customer-facing order display
    expect(ZAKEKE_DESIGN_ID_KEY.startsWith("_")).toBe(true);
    expect(ZAKEKE_PREVIEW_KEY.startsWith("_")).toBe(true);
  });

  it("reads the identity back off a paid order line and re-derives the preview", () => {
    const props: Record<string, string> = { [ZAKEKE_DESIGN_ID_KEY]: DESIGN_ID };
    expect(readZakekeDesignFromLine((key) => props[key])).toEqual({
      designId: DESIGN_ID,
      previewUrl: `/apps/zakeke/preview/${DESIGN_ID}`,
    });
    // a tampered preview attribute cannot introduce an arbitrary URL
    const tampered: Record<string, string> = {
      [ZAKEKE_DESIGN_ID_KEY]: DESIGN_ID,
      [ZAKEKE_PREVIEW_KEY]: "https://evil.example.com/x.png",
    };
    expect(readZakekeDesignFromLine((key) => tampered[key])?.previewUrl).toBe(`/apps/zakeke/preview/${DESIGN_ID}`);
    expect(readZakekeDesignFromLine(() => undefined)).toBeNull();
  });

  it("nests the snapshot so loose image readers cannot promote it to a thumbnail", () => {
    const snap = zakekeSnapshot(resolveZakekeDesign(DESIGN_ID)) as any;
    expect(snap.zakeke.designId).toBe(DESIGN_ID);
    expect(Object.keys(snap)).toEqual(["zakeke"]);
    expect(snap.productImageUrl).toBeUndefined();
    expect(snap.imageUrl).toBeUndefined();
    expect(zakekeSnapshot(null)).toEqual({});
  });
});

describe("17C.1 paid order -> production job", () => {
  it("carries the design identity to the job payload without touching item columns", () => {
    const payload: any = buildShopifyOrderJobPayload(
      paidOrder(orderLine([{ name: ZAKEKE_DESIGN_ID_KEY, value: DESIGN_ID }])),
      "GSO-1042",
    );
    expect(payload).toBeTruthy();
    expect(payload.zakekeDesigns).toHaveLength(1);
    expect(payload.zakekeDesigns[0].designId).toBe(DESIGN_ID);
    expect(payload.zakekeDesigns[0].previewUrl).toBe(`/apps/zakeke/preview/${DESIGN_ID}`);

    // mapped items are spread straight into Prisma, so they must stay column-shaped
    const item = payload.items[0];
    expect(item.zakekeDesignId).toBeUndefined();
    expect(item.zakekeDesigns).toBeUndefined();
    // ...and the identity still rides in the existing JSON snapshot column
    expect(JSON.parse(item.priceSnapshot).zakeke).toEqual({
      designId: DESIGN_ID,
      previewUrl: `/apps/zakeke/preview/${DESIGN_ID}`,
      source: "shopify_line_property",
    });
  });

  it("leaves pricing untouched — the design is artwork identity only", () => {
    const withDesign: any = buildShopifyOrderJobPayload(
      paidOrder(orderLine([{ name: ZAKEKE_DESIGN_ID_KEY, value: DESIGN_ID }])),
      "GSO-1042",
    );
    const without: any = buildShopifyOrderJobPayload(paidOrder(orderLine()), "GSO-1042");
    expect(withDesign.items[0].unitPrice).toBe(without.items[0].unitPrice);
    expect(withDesign.items[0].quantity).toBe(without.items[0].quantity);
    const strip = (snapshot: string) => {
      const parsed = JSON.parse(snapshot);
      delete parsed.zakeke;
      return parsed;
    };
    expect(strip(withDesign.items[0].priceSnapshot)).toEqual(strip(without.items[0].priceSnapshot));
  });

  it("does not crash or fabricate a design for configurator lines without Zakeke data", () => {
    const payload: any = buildShopifyOrderJobPayload(paidOrder(orderLine()), "GSO-1042");
    expect(payload).toBeTruthy();
    expect(payload.zakekeDesigns).toEqual([]);
    expect(JSON.parse(payload.items[0].priceSnapshot).zakeke).toBeUndefined();
    // a garbage id is dropped rather than stored
    const hostile: any = buildShopifyOrderJobPayload(
      paidOrder(orderLine([{ name: ZAKEKE_DESIGN_ID_KEY, value: "<script>x</script>" }])),
      "GSO-1042",
    );
    expect(hostile.zakekeDesigns).toEqual([]);
  });
});

describe("17C.1 checkout route wiring", () => {
  const checkout = readFileSync("app/routes/apps.wholesale-lite.configurator-checkout.ts", "utf8");

  it("accepts the design from the posted item and adds it to the draft-order line", () => {
    expect(checkout).toContain("resolveZakekeDesign(rawItem.zakekeDesignId");
    expect(checkout).toContain("...zakekeLineAttributes(zakekeDesign)");
  });

  it("keeps the design out of every pricing input", () => {
    // pricing must never read a posted price, and must never read the design
    expect(checkout.includes("rawItem.price")).toBe(false);
    expect(checkout).toContain("priceStorefrontConfiguration");
    expect(/price[A-Za-z]*\([^)]*zakeke/i.test(checkout)).toBe(false);
    // the resolved design is used in exactly two places: parsing it, and emitting
    // the line attributes — never in a quantity, price, or total expression
    expect(checkout.match(/zakekeDesign\b/g)).toHaveLength(2);
  });
});

describe("17C.1 native cart bypass is closed", () => {
  const bridge = readFileSync("extensions/wholesale-theme/assets/gso-zakeke-bridge.js", "utf8");
  const configurator = readFileSync("extensions/wholesale-theme/assets/gso-product-configurator.js", "utf8");
  const liquid = readFileSync("extensions/wholesale-theme/blocks/gso-product-configurator.liquid", "utf8");

  it("replaces the theme hook and never posts to the native cart itself", () => {
    expect(bridge).toContain("window.zakekeBeforeAddToCart = function (designID)");
    // the theme's version fetches the preview then POSTs form.action (/cart/add)
    // and redirects; neither may survive in the bridge
    expect(bridge.includes("fetch(form.action")).toBe(false);
    expect(bridge.includes('window.location.href = "/cart"')).toBe(false);
    expect(bridge.includes("window.location.href='/cart'")).toBe(false);
  });

  it("blocks programmatic native cart writes at the transport level", () => {
    // a fetch() POST fires no submit event and clicks no button, so the
    // configurator's submit listener and disabled add buttons cannot see it
    expect(bridge).toContain('path.indexOf("/cart/add") >= 0');
    expect(bridge).toContain("window.fetch = guardedFetch");
    expect(bridge).toContain("XMLHttpRequest.prototype.send = guardedSend");
    expect(bridge).toContain("HTMLFormElement.prototype.submit = guardedSubmit");
    expect(bridge).toContain("gso:zakeke:native-blocked");
  });

  it("only arms itself where the GSO configurator block is present", () => {
    expect(bridge).toContain('document.querySelector(".gso-configurator")');
    expect(bridge).toContain("if (!root()) return;");
    expect(liquid).toContain("gso-zakeke-bridge.js");
  });

  it("keeps the existing lockout layers intact", () => {
    expect(configurator).toContain('[name="add"]');
    expect(configurator).toContain("lb[li].disabled=!0");
    expect(configurator).toContain('"1"===t.dataset.gsoLockout&&document.body.classList.add("gso-native-purchase-lockout")');
  });
});

describe("17C.1 configurator cart carries the design", () => {
  const configurator = readFileSync("extensions/wholesale-theme/assets/gso-product-configurator.js", "utf8");

  it("stores the design on the cart item and forwards it on checkout", () => {
    expect(configurator).toContain("zakekeDesignId:window.GSOZakeke&&window.GSOZakeke.designId()||\"\"");
    expect(configurator).toContain('zakekeDesignId:t.zakekeDesignId||""');
    expect(configurator).toContain('zakekePreviewUrl:t.zakekePreviewUrl||""');
  });

  it("keys merged cart lines by design so two artworks never collapse into one", () => {
    // Phase 4 appended a personalization segment to both keys; the Zakeke
    // segment must still be present and still sit inside the joined identity.
    expect(configurator).toContain('t.bagColor||"",t.zakekeDesignId||"",gsoPzTag(t)].join("||")');
    expect(configurator).toContain('t.jarColor||"",t.zakekeDesignId||"",gsoPzTag(t)].join("||")');
  });

  it("stores only references, never artwork bytes", () => {
    const bridge = readFileSync("extensions/wholesale-theme/assets/gso-zakeke-bridge.js", "utf8");
    expect(bridge.includes("toDataURL")).toBe(false);
    expect(bridge.includes("base64")).toBe(false);
    expect(bridge.includes("createObjectURL")).toBe(false);
  });
});

describe("17C.1 production job storage", () => {
  const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");

  it("writes a retrievable, indexed artwork row without a schema change", () => {
    expect(source).toContain("tx.productionJobFile.create");
    expect(source).toContain("assetSource: ZAKEKE_ASSET_SOURCE");
    expect(source).toContain("sourceRef: design.designId");
    expect(source).toContain("fileUrl: design.previewUrl");
    expect(ZAKEKE_ASSET_SOURCE).toBe("zakeke");
  });

  it("reads the design from line properties rather than the canonical snapshot", () => {
    expect(source).toContain("readZakekeDesignFromLine((key) => getLineProperty(line, key))");
    expect(source).toContain("...zakekeSnapshot(zakekeDesign)");
  });
});
