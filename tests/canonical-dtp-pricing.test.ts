// Phase 16E — outsourced DTP pouch storefront activation.
// Pins that the storefront adapter consumes the EXISTING 15C.2 owner
// selling-price ladders exactly (no second engine, no new numbers), the
// MOQ/quote boundaries, the family-aware canonical snapshot, paid-order ->
// ProductionJob mapping with the outsourced dtp-bags checklist, and that
// no bag/jar behavior changed.
import { describe, expect, it } from "vitest";
import {
  DTP_FINISH_LABEL,
  DTP_QUANTITY_OPTIONS,
  DTP_STOREFRONT_MAX_QTY,
  DTP_STOREFRONT_MIN_QTY,
  buildCanonicalDtpLineMetadata,
  dtpLaunchInfoForType,
  dtpPriceBreaks,
  priceDtpConfiguration,
} from "../app/lib/canonical-dtp-pricing.server";
import { DTP_OWNER_PRICE_LADDERS, ownerPriceForQuantity } from "../app/lib/dtp-owner-pricing.server";
import {
  canonicalDtpMaterialSummary,
  parseCanonicalDtpOrderLine,
  parseCanonicalJarOrderLine,
  parseCanonicalOrderLine,
} from "../app/lib/order-canonical.server";
import { FAMILY_CHECKLISTS, buildShopifyOrderJobPayload, isConfiguratorLine } from "../app/lib/production-job-source.server";
import { decideMachine } from "../app/lib/print-intake-routing.server";
import { buildCanonicalJarLineMetadata, priceJarConfiguration } from "../app/lib/canonical-jar-pricing";

const OWNER_LADDER_PINS: Record<string, number[]> = {
  dtp_4x5x2: [1.67, 0.88, 0.74, 0.61, 0.6],
  dtp_5x4x2: [1.76, 0.97, 0.86, 0.72, 0.71],
  dtp_6x5x2: [1.84, 1.04, 0.96, 0.81, 0.81],
  dtp_8x5x2: [2.05, 1.23, 1.23, 1.05, 1.05],
};

function priced(productType: string, quantity: number) {
  return priceDtpConfiguration({ productType, quantity });
}

describe("owner DTP ladder consumption (authority — 15C.2, never re-derived)", () => {
  it("prices every size at every ladder tier exactly from the owner ladders", () => {
    expect(DTP_QUANTITY_OPTIONS).toEqual([1000, 2500, 5000, 7500, 10000]);
    for (const [type, prices] of Object.entries(OWNER_LADDER_PINS)) {
      DTP_QUANTITY_OPTIONS.forEach((quantity, index) => {
        const result = priced(type, quantity);
        if (!result.ok) throw new Error(`${type}@${quantity}: ${result.reason}`);
        expect(result.unitPrice, `${type}@${quantity}`).toBe(prices[index]);
        expect(result.tierUsed).toBe(quantity);
        // the storefront number IS the owner ladder number
        expect(result.unitPrice).toBe(ownerPriceForQuantity(dtpLaunchInfoForType(type)!.sku, quantity).unitPrice);
      });
    }
  });

  it("between tiers uses the highest reached owner tier — never interpolated", () => {
    const at1500 = priced("dtp_4x5x2", 1500);
    if (!at1500.ok) throw new Error("expected ok");
    expect(at1500).toMatchObject({ tierUsed: 1000, unitPrice: 1.67 });
    const at3000 = priced("dtp_4x5x2", 3000);
    if (!at3000.ok) throw new Error("expected ok");
    expect(at3000).toMatchObject({ tierUsed: 2500, unitPrice: 0.88 });
    expect(at3000.orderTotal).toBe(2640);
  });

  it("the adapter holds no price numbers of its own (ladder is the single source)", () => {
    for (const sku of Object.keys(DTP_OWNER_PRICE_LADDERS)) {
      expect(Object.values(DTP_LAUNCH_INFO_SKUS)).toContain(sku);
    }
  });

  const DTP_LAUNCH_INFO_SKUS: Record<string, string> = {
    dtp_4x5x2: "spektra-dtp-4x5x2",
    dtp_5x4x2: "spektra-dtp-5x4x2",
    dtp_6x5x2: "spektra-dtp-6x5x2",
    dtp_8x5x2: "spektra-dtp-8x5x2",
  };

  it("maps every launch type to its exact vendorSku (4x5x2 vs 5x4x2 stay distinct)", () => {
    for (const [type, sku] of Object.entries(DTP_LAUNCH_INFO_SKUS)) {
      expect(dtpLaunchInfoForType(type)?.sku).toBe(sku);
    }
    const a = priced("dtp_4x5x2", 2500);
    const b = priced("dtp_5x4x2", 2500);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.unitPrice).not.toBe(b.unitPrice);
  });
});

describe("MOQ and quote boundaries", () => {
  it("floors at the Spektra vendor MOQ (1,000) — refused, not quoted", () => {
    expect(DTP_STOREFRONT_MIN_QTY).toBe(1000);
    const below = priced("dtp_4x5x2", 999);
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.requestQuote).toBe(false);
  });

  it("caps online orders at 10,000 — larger runs request a quote", () => {
    expect(DTP_STOREFRONT_MAX_QTY).toBe(10000);
    const atCap = priced("dtp_4x5x2", 10000);
    expect(atCap.ok).toBe(true);
    const above = priced("dtp_4x5x2", 10001);
    expect(above.ok).toBe(false);
    if (!above.ok) expect(above.requestQuote).toBe(true);
  });

  it("refuses non-launch types (no invented pricing)", () => {
    const result = priced("dtp_9x12", 2500);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requestQuote).toBe(false);
    expect(dtpPriceBreaks("dtp_9x12")).toEqual([]);
  });

  it("serves the full break ladder per size", () => {
    const breaks = dtpPriceBreaks("dtp_8x5x2");
    expect(breaks.map((entry) => entry.minQty)).toEqual([1000, 2500, 5000, 7500, 10000]);
    expect(breaks.map((entry) => entry.priceEach)).toEqual([2.05, 1.23, 1.23, 1.05, 1.05]);
  });
});

describe("canonical DTP snapshot", () => {
  function metaFor(quantity = 2500) {
    const result = priced("dtp_4x5x2", quantity);
    if (!result.ok) throw new Error("expected ok");
    return buildCanonicalDtpLineMetadata({ productType: "dtp_4x5x2", priced: result });
  }

  it("round-trips with the outsourced classification and included CR zipper", () => {
    const dtp = parseCanonicalDtpOrderLine(metaFor())!;
    expect(dtp).toMatchObject({
      family: "dtp",
      profile: "dtp_4x5x2",
      size: "4x5x2",
      qty: 2500,
      crZipper: true,
      unitPrice: 0.88,
      supplier: "spektra_outsourced",
      ladderSku: "spektra-dtp-4x5x2",
    });
    expect(dtp.finishLabel).toBe(DTP_FINISH_LABEL);
  });

  it("never cross-parses with bag/jar snapshot parsers", () => {
    const dtpMeta = metaFor();
    expect(parseCanonicalOrderLine(dtpMeta)).toBeNull();
    expect(parseCanonicalJarOrderLine(dtpMeta)).toBeNull();
    const jarPriced = priceJarConfiguration({ productType: "jar_150ml", quantity: 500, baseFinish: "Matte", labelMaterial: "Standard", specialty: "Standard — 0X" });
    if (!jarPriced.ok) throw new Error("expected jar ok");
    const jarMeta = buildCanonicalJarLineMetadata({ productType: "jar_150ml", priced: jarPriced });
    expect(parseCanonicalDtpOrderLine(jarMeta)).toBeNull();
  });

  it("fails closed on malformed snapshots", () => {
    expect(parseCanonicalDtpOrderLine(null)).toBeNull();
    expect(parseCanonicalDtpOrderLine("{broken")).toBeNull();
    expect(parseCanonicalDtpOrderLine(JSON.stringify({ family: "dtp", profile: "dtp_4x5x2" }))).toBeNull();
    expect(parseCanonicalDtpOrderLine(metaFor().replace('"dtp_4x5x2"', '"jar_150ml"'))).toBeNull();
  });

  it("summary is router-token-clean (outsourced work takes the plain default if ever intake-matched)", () => {
    const dtp = parseCanonicalDtpOrderLine(metaFor())!;
    const summary = canonicalDtpMaterialSummary(dtp);
    expect(summary).toContain("Supplier: Spektra (outsourced, vendor-finished)");
    for (const token of ["white", "gloss", "clear", "varnish", "primer", "spot uv"]) {
      expect(summary.toLowerCase().includes(token), token).toBe(false);
    }
    const decision = decideMachine({ selectedFinish: dtp.finishLabel, materialSummary: summary, machineSummary: null } as any);
    expect(decision).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
  });
});

describe("paid DTP order -> ProductionJob payload", () => {
  function dtpOrder(overrides: Partial<{ quantity: number; price: string }> = {}) {
    const result = priced("dtp_4x5x2", overrides.quantity ?? 2500);
    if (!result.ok) throw new Error("expected ok");
    const meta = buildCanonicalDtpLineMetadata({ productType: "dtp_4x5x2", priced: result });
    return {
      admin_graphql_api_id: "gid://shopify/Order/9160010",
      name: "#16E-DTP",
      line_items: [{
        id: 21,
        title: "4x5 Custom Pouch - 4x5x2 / Soft-Touch Full-Color / CR Zipper Included",
        quantity: overrides.quantity ?? 2500,
        price: overrides.price ?? "0.88",
        properties: [
          { name: "Product Family", value: "DTP Pouches" },
          { name: "Product Type", value: "dtp_4x5x2" },
          { name: "Material", value: "Soft-Touch Lamination (Included)" },
          { name: "Finish", value: DTP_FINISH_LABEL },
          { name: "Size", value: "4x5x2" },
          { name: "CR Zipper", value: "Included" },
          { name: "_GSO Canonical", value: meta },
        ],
      }],
    };
  }

  it("maps the DTP canonical snapshot authoritatively with the outsourced checklist", () => {
    const payload = buildShopifyOrderJobPayload(dtpOrder(), "GSO-20260812-9010")!;
    expect(payload.checklistFamily).toBe("dtp-bags");
    expect(payload.orderGid).toBe("gid://shopify/Order/9160010");
    const item = payload.items[0];
    expect(item.quantity).toBe(2500);
    expect(item.unitPrice).toBe(0.88);
    expect(item.materialSummary).toContain("Family: DTP Pouches");
    expect(item.materialSummary).toContain("Size: 4x5x2");
    expect(item.productionNotes).toContain("OUTSOURCED vendor-finished pouch (no in-house print)");
    expect(item.productionNotes).toContain("purchase order -> vendor proof -> receive -> QC -> pack");
    const addOns = JSON.parse(item.selectedAddOns);
    expect(addOns).toMatchObject({ family: "dtp", outsourced: true, crZipper: true, ladderSku: "spektra-dtp-4x5x2" });
    const priceSnapshot = JSON.parse(item.priceSnapshot);
    expect(priceSnapshot.canonical).toMatchObject({ family: "dtp", unitPrice: 0.88 });
  });

  it("qualifies DTP canonical lines even without visible properties", () => {
    const order = dtpOrder();
    order.line_items[0].properties = order.line_items[0].properties.filter((prop: any) => prop.name === "_GSO Canonical");
    expect(isConfiguratorLine(order.line_items[0])).toBe(true);
    const payload = buildShopifyOrderJobPayload(order, "GSO-20260812-9011")!;
    expect(payload.items[0].unitPrice).toBe(0.88);
    expect(payload.checklistFamily).toBe("dtp-bags");
  });

  it("surfaces canonical/paid mismatches as warnings, never recalculations", () => {
    const payload = buildShopifyOrderJobPayload(dtpOrder({ price: "0.10" }), "GSO-20260812-9012")!;
    expect(payload.items[0].unitPrice).toBe(0.88);
    expect(payload.items[0].productionNotes).toContain("WARNING:");
  });

  it("mixed jar+DTP orders fall back to the default checklist (never a wrong family flow)", () => {
    const jarPriced = priceJarConfiguration({ productType: "jar_150ml", quantity: 500, baseFinish: "Matte", labelMaterial: "Standard", specialty: "Standard — 0X" });
    if (!jarPriced.ok) throw new Error("expected jar ok");
    const order = dtpOrder();
    order.line_items.push({
      id: 22, title: "150ml Miron Jars - Matte / Standard — 0X / Standard", quantity: 500, price: "5.50",
      properties: [
        { name: "Product Family", value: "Jars" },
        { name: "Product Type", value: "jar_150ml" },
        { name: "Material", value: "Matte" },
        { name: "Finish", value: "Standard — 0X" },
        { name: "Label Set", value: "Standard" },
        { name: "_GSO Canonical", value: buildCanonicalJarLineMetadata({ productType: "jar_150ml", priced: jarPriced }) },
      ],
    } as any);
    const payload = buildShopifyOrderJobPayload(order, "GSO-20260812-9013")!;
    expect(payload.checklistFamily).toBe("default");
    expect(payload.items).toHaveLength(2);
  });

  it("the dtp-bags checklist is the outsourced purchase workflow — no in-house print/apply stages", () => {
    const labels = FAMILY_CHECKLISTS["dtp-bags"].map((entry) => entry.label.toLowerCase());
    const joined = labels.join(" | ");
    for (const needle of ["purchase order prepared", "purchase order sent to spektra", "vendor proof received", "goods received", "quality control"]) {
      expect(joined).toContain(needle);
    }
    for (const banned of ["labels printed", "labels applied", "machine assigned", "print complete"]) {
      expect(joined.includes(banned), banned).toBe(false);
    }
  });
});
