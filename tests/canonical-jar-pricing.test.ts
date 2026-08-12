// Phase 16D — owner-approved Miron applied-label jar pricing + convergence.
// Pins the exact launch price authority (never derived from margins/costs),
// the holographic/specialty math, quote boundaries, the family-aware
// canonical snapshot, paid-order -> ProductionJob mapping, the jar
// production checklist, and machine routing from jar summaries.
import { describe, expect, it } from "vitest";
import {
  JAR_APPLICATION_LABOR_PER_JAR,
  JAR_DEEP_BUILD_LABEL,
  JAR_QUANTITY_OPTIONS,
  JAR_SPECIALTY_LADDER,
  JAR_STOREFRONT_MIN_QTY,
  JAR_VOLUME_QUOTE_FROM,
  buildCanonicalJarLineMetadata,
  jarLaunchSizeForType,
  jarPriceBreaks,
  priceJarConfiguration,
} from "../app/lib/canonical-jar-pricing";
import {
  canonicalJarMaterialSummary,
  canonicalJarSelectedAddOns,
  canonicalLineWarnings,
  parseCanonicalJarOrderLine,
  parseCanonicalOrderLine,
} from "../app/lib/order-canonical.server";
import { FAMILY_CHECKLISTS, buildShopifyOrderJobPayload, isConfiguratorLine } from "../app/lib/production-job-source.server";
import { decideMachine } from "../app/lib/print-intake-routing.server";

function price(productType: string, quantity: number, overrides: Partial<{ baseFinish: string; labelMaterial: string; specialty: string }> = {}) {
  return priceJarConfiguration({
    productType,
    quantity,
    baseFinish: overrides.baseFinish ?? "Matte",
    labelMaterial: overrides.labelMaterial ?? "Standard",
    specialty: overrides.specialty ?? "Standard — 0X",
  });
}

function expectUnit(result: ReturnType<typeof priceJarConfiguration>, unit: number) {
  if (!result.ok) throw new Error(`expected ok pricing, got: ${result.reason}`);
  expect(result.unitPrice).toBe(unit);
  return result;
}

describe("owner-approved base pricing (authority — never derived)", () => {
  it("prices every 100ml launch tier exactly", () => {
    expectUnit(price("jar_100ml_tall", 50), 4.95);
    expectUnit(price("jar_100ml_tall", 100), 4.5);
    expectUnit(price("jar_100ml_tall", 250), 4.0);
    expectUnit(price("jar_100ml_tall", 500), 3.75);
    expectUnit(price("jar_100ml_tall", 1000), 3.5);
    expectUnit(price("jar_100ml_tall", 2500), 3.35);
  });

  it("prices every 150ml launch tier exactly", () => {
    expectUnit(price("jar_150ml", 50), 6.5);
    expectUnit(price("jar_150ml", 100), 6.0);
    expectUnit(price("jar_150ml", 250), 5.75);
    expectUnit(price("jar_150ml", 500), 5.5);
    expectUnit(price("jar_150ml", 1000), 5.25);
    expectUnit(price("jar_150ml", 2500), 4.95);
  });

  it("both 100ml body styles (tall/wide) share the single owner 100ml table", () => {
    expect(jarLaunchSizeForType("jar_100ml_tall")).toBe("100ml");
    expect(jarLaunchSizeForType("jar_100ml_wide")).toBe("100ml");
    expectUnit(price("jar_100ml_wide", 500), 3.75);
  });

  it("in-between quantities price at the tier floor (band step)", () => {
    expectUnit(price("jar_150ml", 137), 6.0);
    expectUnit(price("jar_150ml", 4999), 4.95);
  });

  it("non-launch jar types are refused (no invented pricing)", () => {
    const result = price("jar_3oz_clear", 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requestQuote).toBe(false);
    expect(jarLaunchSizeForType("jar_250ml")).toBeNull();
  });
});

describe("base finish, holographic, and specialty math", () => {
  it("Matte and Gloss base finishes are included at identical prices", () => {
    const matte = expectUnit(price("jar_150ml", 500, { baseFinish: "Matte" }), 5.5);
    const gloss = expectUnit(price("jar_150ml", 500, { baseFinish: "Gloss" }), 5.5);
    expect(matte.baseFinish).toBe("Matte");
    expect(gloss.baseFinish).toBe("Gloss");
  });

  it("holographic adds exactly 20% of BASE (never of the layered subtotal)", () => {
    const result = expectUnit(price("jar_150ml", 500, { labelMaterial: "Holographic" }), 6.6);
    if (result.ok) {
      expect(result.holoAdd).toBe(1.1);
      expect(result.whiteRequired).toBe(true);
    }
    expectUnit(price("jar_100ml_tall", 250, { labelMaterial: "Holographic" }), 4.8);
  });

  it("pins the fixed specialty ladder premiums", () => {
    expect(JAR_SPECIALTY_LADDER.map((entry) => entry.premium)).toEqual([0, 0.3, 0.5, 0.7, 0.9, 1.1, 1.3, 1.5, 1.75]);
    expectUnit(price("jar_150ml", 500, { specialty: "Spot Gloss — 1X" }), 5.8);
    expectUnit(price("jar_150ml", 500, { specialty: "Raised Emboss — 2X" }), 6.0);
    expectUnit(price("jar_150ml", 500, { specialty: "Raised — 4X" }), 6.4);
    expectUnit(price("jar_150ml", 500, { specialty: "Ultra Layered — 8X" }), 7.25);
  });

  it("stacks holographic + specialty exactly like the owner example (150ml/500/holo/4X = $7.50)", () => {
    const result = expectUnit(
      price("jar_150ml", 500, { labelMaterial: "Holographic", specialty: "Raised — 4X" }),
      7.5,
    );
    if (result.ok) {
      expect(result.basePrice).toBe(5.5);
      expect(result.holoAdd).toBe(1.1);
      expect(result.specialtyAdd).toBe(0.9);
    }
  });

  it("tolerates bare ladder indices from older clients", () => {
    expectUnit(price("jar_150ml", 500, { specialty: "3x" }), 6.2);
  });
});

describe("quote boundaries and minimums", () => {
  it("9X+ Deep Build always requests a quote", () => {
    const result = price("jar_150ml", 500, { specialty: JAR_DEEP_BUILD_LABEL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requestQuote).toBe(true);
  });

  it("5,000+ always requests a volume quote", () => {
    const result = price("jar_150ml", JAR_VOLUME_QUOTE_FROM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requestQuote).toBe(true);
  });

  it("floors at the 50-jar launch minimum", () => {
    expect(JAR_STOREFRONT_MIN_QTY).toBe(50);
    const result = price("jar_150ml", 49);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requestQuote).toBe(false);
  });

  it("serves the launch quantity ladder with adders applied per tier", () => {
    expect(JAR_QUANTITY_OPTIONS).toEqual([50, 100, 250, 500, 1000, 2500]);
    const breaks = jarPriceBreaks({ productType: "jar_100ml_tall", baseFinish: "Gloss", labelMaterial: "Holographic", specialty: "Spot Gloss — 1X" });
    expect(breaks.map((entry) => entry.minQty)).toEqual([50, 100, 250, 500, 1000, 2500]);
    // 100ml @100: 4.50 + 0.90 holo + 0.30 = 5.70
    expect(breaks.find((entry) => entry.minQty === 100)?.priceEach).toBe(5.7);
  });

  it("keeps application labor cost-side only ($0.20/jar never surcharged)", () => {
    expect(JAR_APPLICATION_LABOR_PER_JAR).toBe(0.2);
    const base = expectUnit(price("jar_150ml", 500), 5.5);
    expect(base.unitPrice).toBe(5.5);
  });
});

describe("canonical jar snapshot (checkout -> order)", () => {
  function snapshotFor(quantity = 500) {
    const priced = price("jar_150ml", quantity, { baseFinish: "Gloss", labelMaterial: "Holographic", specialty: "Raised — 4X" });
    if (!priced.ok) throw new Error("expected priced");
    return buildCanonicalJarLineMetadata({ productType: "jar_150ml", priced });
  }

  it("round-trips through the family-aware parser", () => {
    const jar = parseCanonicalJarOrderLine(snapshotFor());
    expect(jar).toMatchObject({
      family: "jars",
      profile: "jar_150ml",
      size: "150ml",
      qty: 500,
      baseFinish: "Gloss",
      labelMaterial: "Holographic",
      holo: true,
      whiteRequired: true,
      specialtyX: 4,
      finishLabel: "Raised — 4X",
      unitPrice: 7.5,
    });
  });

  it("never cross-parses with the bag snapshot parser", () => {
    expect(parseCanonicalOrderLine(snapshotFor())).toBeNull();
    const bagMeta = JSON.stringify({
      v: "15G.5-storefront-canonical", profile: "stock_bag_4x5", qty: 100, faces: 2, material: "Matte",
      bagColor: "White", holo: false, whiteRequired: false, glossX: 0, finishLabel: "No Specialty — 0X",
      unitPrice: 1.8, engine: "canonical-bag-pricing/15G.4C",
    });
    expect(parseCanonicalJarOrderLine(bagMeta)).toBeNull();
    expect(parseCanonicalOrderLine(bagMeta)).not.toBeNull();
  });

  it("fails closed on malformed jar snapshots", () => {
    expect(parseCanonicalJarOrderLine(null)).toBeNull();
    expect(parseCanonicalJarOrderLine("not json")).toBeNull();
    expect(parseCanonicalJarOrderLine(JSON.stringify({ family: "jars", profile: "jar_150ml" }))).toBeNull();
    expect(parseCanonicalJarOrderLine(snapshotFor().replace('"Gloss"', '"Satin"'))).toBeNull();
  });

  it("flags qty/price mismatches between snapshot and paid line", () => {
    const jar = parseCanonicalJarOrderLine(snapshotFor())!;
    expect(canonicalLineWarnings(jar, { quantity: 500, unitPrice: 7.5 })).toEqual([]);
    expect(canonicalLineWarnings(jar, { quantity: 400, unitPrice: 7.5 })).toHaveLength(1);
    expect(canonicalLineWarnings(jar, { quantity: 500, unitPrice: 1.0 })).toHaveLength(1);
  });
});

describe("machine routing from jar summaries (canonical authority reuse)", () => {
  function summaryFor(overrides: Partial<{ labelMaterial: string; specialty: string; baseFinish: string }> = {}) {
    const priced = price("jar_150ml", 500, overrides);
    if (!priced.ok) throw new Error("expected priced");
    const jar = parseCanonicalJarOrderLine(buildCanonicalJarLineMetadata({ productType: "jar_150ml", priced }))!;
    return { summary: canonicalJarMaterialSummary(jar), finishLabel: jar.finishLabel };
  }

  it("plain CMYK (0X + Standard label) defaults to the Mimaki — even with the Gloss base finish", () => {
    for (const baseFinish of ["Matte", "Gloss"]) {
      const { summary, finishLabel } = summaryFor({ baseFinish });
      const decision = decideMachine({ selectedFinish: finishLabel, materialSummary: summary, machineSummary: null } as any);
      expect(decision).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
    }
  });

  it("specialty layers route Roland", () => {
    const { summary, finishLabel } = summaryFor({ specialty: "Ultra Layered — 5X" });
    const decision = decideMachine({ selectedFinish: finishLabel, materialSummary: summary, machineSummary: null } as any);
    expect(decision).toMatchObject({ machine: "roland", machineRule: "white_or_gloss" });
  });

  it("holographic (technical white underbase) routes Roland", () => {
    const { summary, finishLabel } = summaryFor({ labelMaterial: "Holographic" });
    expect(summary).toContain("White Layers: 1");
    const decision = decideMachine({ selectedFinish: finishLabel, materialSummary: summary, machineSummary: null } as any);
    expect(decision).toMatchObject({ machine: "roland", machineRule: "white_or_gloss" });
  });
});

describe("paid jar order -> ProductionJob payload", () => {
  function jarOrder(overrides: Partial<{ quantity: number; price: string }> = {}) {
    const priced = price("jar_150ml", overrides.quantity ?? 500, { baseFinish: "Gloss", labelMaterial: "Holographic", specialty: "Raised — 4X" });
    if (!priced.ok) throw new Error("expected priced");
    const meta = buildCanonicalJarLineMetadata({ productType: "jar_150ml", priced });
    return {
      admin_graphql_api_id: "gid://shopify/Order/9160001",
      name: "#16D-TEST",
      email: "jar-test@example.com",
      line_items: [
        {
          id: 111,
          title: "150ml Miron Jars - Gloss / Raised — 4X / Holographic",
          quantity: overrides.quantity ?? 500,
          price: overrides.price ?? "7.50",
          product_id: 7777,
          variant_id: 8888,
          properties: [
            { name: "Product Family", value: "Jars" },
            { name: "Product Type", value: "jar_150ml" },
            { name: "Material", value: "Gloss" },
            { name: "Finish", value: "Raised — 4X" },
            { name: "Production Finish", value: "Raised — 4X" },
            { name: "Base Finish", value: "Gloss" },
            { name: "Label Material", value: "Holographic" },
            { name: "Label Set", value: "Holographic" },
            { name: "_GSO Canonical", value: meta },
          ],
        },
      ],
    };
  }

  it("maps the jar canonical snapshot authoritatively (order GID, size, qty, price, snapshot)", () => {
    const payload = buildShopifyOrderJobPayload(jarOrder(), "GSO-20260812-9001")!;
    expect(payload.orderGid).toBe("gid://shopify/Order/9160001");
    expect(payload.checklistFamily).toBe("premium-jars");
    const item = payload.items[0];
    expect(item.quantity).toBe(500);
    expect(item.unitPrice).toBe(7.5);
    expect(item.selectedFinish).toBe("Raised — 4X");
    expect(item.materialSummary).toContain("Size: 150ml");
    expect(item.materialSummary).toContain("Label Material: Holographic Vinyl");
    expect(item.materialSummary).toContain("Base: High-Shine");
    expect(item.productionNotes).toContain("Base Finish (customer): Gloss — included, no charge");
    expect(item.productionNotes).toContain("Label application: GSO applied — included and mandatory");
    expect(item.productionNotes).toContain("Technical white underbase: yes (production requirement, not a customer charge)");
    const priceSnapshot = JSON.parse(item.priceSnapshot);
    expect(priceSnapshot.canonical).toMatchObject({ family: "jars", profile: "jar_150ml", unitPrice: 7.5 });
    const addOns = JSON.parse(item.selectedAddOns);
    expect(addOns).toMatchObject({ family: "jars", size: "150ml", specialtyLayers: 4, application: "GSO label application included" });
    expect(canonicalJarSelectedAddOns(parseCanonicalJarOrderLine(priceSnapshot.canonical && JSON.stringify(priceSnapshot.canonical))!)).toMatchObject({ family: "jars" });
  });

  it("qualifies jar canonical lines even without visible properties", () => {
    const order = jarOrder();
    order.line_items[0].properties = order.line_items[0].properties.filter((prop: any) => prop.name === "_GSO Canonical");
    expect(isConfiguratorLine(order.line_items[0])).toBe(true);
    const payload = buildShopifyOrderJobPayload(order, "GSO-20260812-9002")!;
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].unitPrice).toBe(7.5);
  });

  it("falls back to visible properties when the snapshot is malformed (paid price rides)", () => {
    const order = jarOrder();
    order.line_items[0].properties = order.line_items[0].properties.map((prop: any) =>
      prop.name === "_GSO Canonical" ? { name: "_GSO Canonical", value: "{broken" } : prop,
    );
    const payload = buildShopifyOrderJobPayload(order, "GSO-20260812-9003")!;
    const item = payload.items[0];
    expect(item.unitPrice).toBe(7.5); // paid line price fallback
    expect(item.materialSummary).toContain("Label Set: Holographic");
  });

  it("surfaces canonical/paid mismatches as warnings, never recalculations", () => {
    const payload = buildShopifyOrderJobPayload(jarOrder({ price: "1.00" }), "GSO-20260812-9004")!;
    expect(payload.items[0].productionNotes).toContain("WARNING:");
    expect(payload.items[0].unitPrice).toBe(7.5);
  });

  it("keeps the jar production checklist stages (inventory, print, cut, application, QC, pack)", () => {
    const labels = FAMILY_CHECKLISTS["premium-jars"].map((entry) => entry.label.toLowerCase()).join(" | ");
    for (const needle of ["artwork", "proof", "inventory", "printed", "cut", "applied", "qc", "packed"]) {
      expect(labels).toContain(needle);
    }
  });

  it("does not change stock bag order behavior (regression)", () => {
    const bagMeta = JSON.stringify({
      v: "15G.5-storefront-canonical", profile: "stock_bag_4x5", qty: 100, faces: 2, material: "Matte",
      bagColor: "White", holo: false, whiteRequired: false, glossX: 0, finishLabel: "No Specialty — 0X",
      unitPrice: 1.8, engine: "canonical-bag-pricing/15G.4C",
    });
    const order = {
      admin_graphql_api_id: "gid://shopify/Order/9160005",
      name: "#16D-BAG",
      line_items: [{
        id: 1, title: "Ritz Vanilla Cupcake - Matte / No Specialty — 0X / White", quantity: 100, price: "1.80",
        properties: [
          { name: "Product Family", value: "Stock Bags" },
          { name: "Product Type", value: "stock_bag_4x5" },
          { name: "Material", value: "Matte" },
          { name: "Finish", value: "No Specialty — 0X" },
          { name: "Bag Color", value: "White" },
          { name: "_GSO Canonical", value: bagMeta },
        ],
      }],
    };
    const payload = buildShopifyOrderJobPayload(order, "GSO-20260812-9005")!;
    expect(payload.checklistFamily).toBe("default");
    expect(payload.items[0].unitPrice).toBe(1.8);
    expect(payload.items[0].materialSummary).toBe(
      "Profile: stock_bag_4x5 | Material: Matte | Finish: No Specialty — 0X | Gloss Layers: 0X | White Layers: 0 | Holographic: no | Bag Color: White | Sides: Double Sided",
    );
  });
});
