// Phase 16F — dimension-driven canonical sticker/label pricing.
// Pins that the storefront wraps the EXISTING ERP engines (area cost +
// owner margin/floor policy — no duplicate pricing system), the dimension/
// quantity validation, the family-aware snapshot, routing token hygiene,
// and paid-order -> ProductionJob mapping with the stickers-labels checklist.
import { describe, expect, it } from "vitest";
import {
  STICKER_DEEP_BUILD_LABEL,
  STICKER_MAX_DIM_IN,
  STICKER_QUANTITY_OPTIONS,
  STICKER_SPECIALTY_LADDER,
  STICKER_STOREFRONT_MIN_QTY,
  STICKER_VOLUME_QUOTE_FROM,
  buildCanonicalStickerLineMetadata,
  priceStickerConfiguration,
  stickerLaunchInfoForType,
  stickerPriceBreaks,
  type CanonicalStickerInputs,
} from "../app/lib/canonical-sticker-pricing.server";
import {
  canonicalStickerMaterialSummary,
  parseCanonicalDtpOrderLine,
  parseCanonicalJarOrderLine,
  parseCanonicalOrderLine,
  parseCanonicalStickerOrderLine,
} from "../app/lib/order-canonical.server";
import { FAMILY_CHECKLISTS, buildShopifyOrderJobPayload, isConfiguratorLine } from "../app/lib/production-job-source.server";
import { decideMachine } from "../app/lib/print-intake-routing.server";
import { DOCUMENTED_PRINTER_SQFT_PER_HOUR } from "../app/lib/product-driven-costing.server";

// Owner cost references as deterministic fixtures (matte $0.26/sqft, holo
// $1.20/sqft — the live resolver reads the same values from the Material
// Center; policyValues absent = the code-constant policy, test-pinned
// byte-identical upstream).
const INPUTS: CanonicalStickerInputs = {
  available: true,
  reasons: [],
  matte: { name: "Poseidon Matte Vinyl", costPerSqft: 0.26 },
  holographic: { name: "Holographic Vinyl", costPerSqft: 1.2 },
  rolandSqftPerHour: DOCUMENTED_PRINTER_SQFT_PER_HOUR,
  policyValues: undefined as any,
};

function price(overrides: Partial<{ productType: string; widthIn: unknown; heightIn: unknown; quantity: number; material: string; specialty: string }> = {}) {
  return priceStickerConfiguration(INPUTS, {
    productType: overrides.productType ?? "sticker_regular",
    // "in" checks (not ??) so explicit null/empty fixtures pass through
    widthIn: "widthIn" in overrides ? overrides.widthIn : 3,
    heightIn: "heightIn" in overrides ? overrides.heightIn : 3,
    quantity: overrides.quantity ?? 100,
    material: overrides.material ?? "Matte",
    specialty: overrides.specialty ?? "Standard — 0X",
  });
}

function expectOk(result: ReturnType<typeof priceStickerConfiguration>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result;
}

describe("dimension-driven pricing through the existing ERP engines", () => {
  it("prices 2x2 / 3x3 / 4x4 matte and price scales with area", () => {
    const p22 = expectOk(price({ widthIn: 2, heightIn: 2 }));
    const p33 = expectOk(price({ widthIn: 3, heightIn: 3 }));
    const p44 = expectOk(price({ widthIn: 4, heightIn: 4 }));
    expect(p22.areaSqIn).toBe(4);
    expect(p33.areaSqIn).toBe(9);
    expect(p44.areaSqIn).toBe(16);
    expect(p22.unitPrice).toBeGreaterThan(0);
    expect(p33.unitPrice).toBeGreaterThan(p22.unitPrice);
    expect(p44.unitPrice).toBeGreaterThan(p33.unitPrice);
    expect(p33.orderTotal).toBe(Math.round(p33.unitPrice * 100 * 100) / 100);
  });

  it("supports custom fractional dimensions (server recomputes area — client math never trusted)", () => {
    const chronic = expectOk(price({ widthIn: 2.65, heightIn: 3.2, quantity: 250 }));
    expect(chronic.areaSqIn).toBe(8.48);
    expect(chronic.unitPrice).toBeGreaterThan(0);
  });

  it("holographic prices above matte; specialty layers add cost by area", () => {
    const matte = expectOk(price());
    const holo = expectOk(price({ material: "Holographic" }));
    expect(holo.unitPrice).toBeGreaterThan(matte.unitPrice);
    expect(holo.holographic).toBe(true);
    expect(holo.whiteRequired).toBe(true);
    const oneX = expectOk(price({ specialty: "Spot Gloss — 1X" }));
    const fourX = expectOk(price({ specialty: "Heavy Raised — 4X" }));
    const eightX = expectOk(price({ specialty: "Maximum Layered — 8X" }));
    expect(oneX.unitPrice).toBeGreaterThan(matte.unitPrice);
    expect(fourX.unitPrice).toBeGreaterThan(oneX.unitPrice);
    expect(eightX.unitPrice).toBeGreaterThan(fourX.unitPrice);
    // specialty on a LARGER sticker costs more than on a smaller one
    const fourXBig = expectOk(price({ specialty: "Heavy Raised — 4X", widthIn: 6, heightIn: 6 }));
    expect(fourXBig.unitPrice).toBeGreaterThan(fourX.unitPrice);
  });

  it("die-cut (kiss-cut contour + weeding) never prices below the same regular sticker", () => {
    // At floor-controlled operating points the owner AREA floor sets BOTH
    // prices (equal is correct); once cost-led pricing controls, the contour
    // + weeding cost keeps die-cut at or above regular. Never below.
    for (const quantity of [250, 1000, 2500, 5000]) {
      const regular = expectOk(price({ quantity }));
      const dieCut = expectOk(price({ productType: "sticker_die_cut", quantity }));
      expect(dieCut.unitPrice, `qty ${quantity}`).toBeGreaterThanOrEqual(regular.unitPrice);
    }
    const dieCut = expectOk(price({ productType: "sticker_die_cut", quantity: 250 }));
    expect(dieCut.stickerType).toBe("die_cut");
    expect(dieCut.cutType).toBe("kiss-simple");
    expect(stickerLaunchInfoForType("sticker_die_cut")?.cutRequiresWeeding).toBe(true);
  });

  it("unit price falls as quantity rises (setup amortization + margin curve)", () => {
    const q50 = expectOk(price({ quantity: 50 }));
    const q500 = expectOk(price({ quantity: 500 }));
    const q2500 = expectOk(price({ quantity: 2500 }));
    expect(q500.unitPrice).toBeLessThan(q50.unitPrice);
    expect(q2500.unitPrice).toBeLessThan(q500.unitPrice);
  });

  it("small jobs stay economical: the minimum-job policy keeps tiny orders above bare cost", () => {
    const tiny = expectOk(price({ widthIn: 1, heightIn: 1, quantity: 50 }));
    // a 50-piece 1x1 order can never sell below the setup-recovery floor
    expect(tiny.orderTotal).toBeGreaterThan(9); // art+print setup alone is ~$9.33
  });
});

describe("validation and quote boundaries", () => {
  it("rejects zero/negative/absent dimensions", () => {
    for (const bad of [0, -1, "", "abc", null]) {
      const w = price({ widthIn: bad });
      expect(w.ok, `width ${String(bad)}`).toBe(false);
      const h = price({ heightIn: bad });
      expect(h.ok, `height ${String(bad)}`).toBe(false);
    }
  });

  it("oversize dimensions request a quote instead of refusing", () => {
    const wide = price({ widthIn: STICKER_MAX_DIM_IN + 1 });
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.requestQuote).toBe(true);
  });

  it("enforces MOQ 50 and the 5,000+ volume quote boundary", () => {
    expect(STICKER_STOREFRONT_MIN_QTY).toBe(50);
    const below = price({ quantity: 49 });
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.requestQuote).toBe(false);
    expect(price({ quantity: STICKER_VOLUME_QUOTE_FROM }).ok).toBe(true);
    const above = price({ quantity: STICKER_VOLUME_QUOTE_FROM + 1 });
    expect(above.ok).toBe(false);
    if (!above.ok) expect(above.requestQuote).toBe(true);
  });

  it("9X+ requests a quote; unknown materials/specialties/types are refused", () => {
    const nine = price({ specialty: STICKER_DEEP_BUILD_LABEL });
    expect(nine.ok).toBe(false);
    if (!nine.ok) expect(nine.requestQuote).toBe(true);
    expect(price({ material: "Chrome" }).ok).toBe(false);
    expect(price({ specialty: "Extra Shiny" }).ok).toBe(false);
    expect(price({ productType: "sticker_transfer" }).ok).toBe(false);
  });

  it("serves formula-sampled breaks at the launch quantities", () => {
    const breaks = stickerPriceBreaks(INPUTS, { productType: "sticker_regular", widthIn: 3, heightIn: 3, material: "Matte", specialty: "Standard — 0X" });
    expect(breaks.map((entry) => entry.minQty)).toEqual(STICKER_QUANTITY_OPTIONS);
    expect(breaks[0].priceEach).toBeGreaterThan(breaks[breaks.length - 1].priceEach);
  });

  it("fails closed when engine inputs are unavailable", () => {
    const result = priceStickerConfiguration({ ...INPUTS, available: false, reasons: ["No verified matte print material found"] }, { productType: "sticker_regular", widthIn: 3, heightIn: 3, quantity: 100, material: "Matte", specialty: "" });
    expect(result.ok).toBe(false);
  });
});

describe("canonical sticker snapshot + routing", () => {
  function metaFor(overrides: Parameters<typeof price>[0] = {}) {
    const priced = expectOk(price(overrides));
    return buildCanonicalStickerLineMetadata({ productType: overrides.productType ?? "sticker_regular", priced });
  }

  it("round-trips the full production configuration", () => {
    const sticker = parseCanonicalStickerOrderLine(metaFor({ material: "Holographic", specialty: "Raised — 2X", quantity: 250 }))!;
    expect(sticker).toMatchObject({
      family: "stickers",
      profile: "sticker_regular",
      stickerType: "regular",
      widthIn: 3,
      heightIn: 3,
      areaSqIn: 9,
      qty: 250,
      material: "Holographic",
      holo: true,
      whiteRequired: true,
      specialtyX: 2,
      cutType: "square-rect",
    });
    expect(sticker.unitPrice).toBeGreaterThan(0);
  });

  it("never cross-parses with bag/jar/DTP parsers and fails closed on malformed data", () => {
    const meta = metaFor();
    expect(parseCanonicalOrderLine(meta)).toBeNull();
    expect(parseCanonicalJarOrderLine(meta)).toBeNull();
    expect(parseCanonicalDtpOrderLine(meta)).toBeNull();
    expect(parseCanonicalStickerOrderLine("{broken")).toBeNull();
    expect(parseCanonicalStickerOrderLine(meta.replace('"sticker_regular"', '"jar_150ml"'))).toBeNull();
    expect(parseCanonicalStickerOrderLine(meta.replace('"Matte"', '"Satin"'))).toBeNull();
  });

  it("matte 0X routes Mimaki (token-clean); specialty and holographic route Roland", () => {
    const plain = parseCanonicalStickerOrderLine(metaFor())!;
    const plainSummary = canonicalStickerMaterialSummary(plain);
    for (const token of ["white", "gloss", "clear", "varnish", "primer", "spot uv"]) {
      expect(plainSummary.toLowerCase().includes(token), token).toBe(false);
    }
    expect(decideMachine({ selectedFinish: plain.finishLabel, materialSummary: plainSummary, machineSummary: null } as any)).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
    const gloss = parseCanonicalStickerOrderLine(metaFor({ specialty: "Ultra Layered — 5X" }))!;
    expect(decideMachine({ selectedFinish: gloss.finishLabel, materialSummary: canonicalStickerMaterialSummary(gloss), machineSummary: null } as any)).toMatchObject({ machine: "roland", machineRule: "white_or_gloss" });
    const holo = parseCanonicalStickerOrderLine(metaFor({ material: "Holographic" }))!;
    const holoSummary = canonicalStickerMaterialSummary(holo);
    expect(holoSummary).toContain("White Layers: 1");
    expect(decideMachine({ selectedFinish: holo.finishLabel, materialSummary: holoSummary, machineSummary: null } as any)).toMatchObject({ machine: "roland", machineRule: "white_or_gloss" });
  });
});

describe("paid sticker order -> ProductionJob payload", () => {
  function stickerOrder(overrides: Partial<{ price: string; specialty: string }> = {}) {
    const priced = expectOk(price({ quantity: 250, specialty: overrides.specialty ?? "Standard — 0X", productType: "sticker_die_cut" }));
    const meta = buildCanonicalStickerLineMetadata({ productType: "sticker_die_cut", priced });
    return {
      admin_graphql_api_id: "gid://shopify/Order/9160020",
      name: "#16F-STICKER",
      line_items: [{
        id: 31,
        title: "Die-Cut Stickers - 3x3in / Matte / Standard — 0X",
        quantity: 250,
        price: overrides.price ?? String(priced.unitPrice),
        properties: [
          { name: "Product Family", value: "Stickers" },
          { name: "Product Type", value: "sticker_die_cut" },
          { name: "Material", value: "Matte" },
          { name: "Finish", value: priced.specialtyLabel },
          { name: "Width (in)", value: "3" },
          { name: "Height (in)", value: "3" },
          { name: "Cut", value: "Die-Cut (contour)" },
          { name: "_GSO Canonical", value: meta },
        ],
      }],
      expectedUnit: priced.unitPrice,
    };
  }

  it("maps the sticker canonical snapshot authoritatively with the stickers-labels checklist", () => {
    const order = stickerOrder();
    const payload = buildShopifyOrderJobPayload(order, "GSO-20260812-9020")!;
    expect(payload.checklistFamily).toBe("stickers-labels");
    const item = payload.items[0];
    expect(item.unitPrice).toBe(order.expectedUnit);
    expect(item.materialSummary).toContain("Family: Stickers");
    expect(item.materialSummary).toContain("Size: 3x3in (9 sq in each)");
    expect(item.materialSummary).toContain("kiss-cut contour + weeding");
    expect(item.productionNotes).toContain('Sticker Size: 3" x 3" (9 sq in each)');
    expect(item.productionNotes).toContain("die-cut (kiss-cut contour) + weeding");
    const addOns = JSON.parse(item.selectedAddOns);
    expect(addOns).toMatchObject({ family: "stickers", stickerType: "die_cut", widthIn: 3, heightIn: 3, cutType: "kiss-simple" });
  });

  it("qualifies canonical sticker lines without visible properties; warns on price mismatch", () => {
    const order = stickerOrder({ price: "0.01" });
    expect(isConfiguratorLine(order.line_items[0])).toBe(true);
    const payload = buildShopifyOrderJobPayload(order, "GSO-20260812-9021")!;
    expect(payload.items[0].unitPrice).toBe(order.expectedUnit);
    expect(payload.items[0].productionNotes).toContain("WARNING:");
  });

  it("the stickers-labels checklist covers print -> cut -> weed -> QC -> pack", () => {
    const labels = FAMILY_CHECKLISTS["stickers-labels"].map((entry) => entry.label.toLowerCase()).join(" | ");
    for (const needle of ["artwork", "proof", "printed", "cut complete", "weeded", "qc", "packed"]) {
      expect(labels).toContain(needle);
    }
  });
});
