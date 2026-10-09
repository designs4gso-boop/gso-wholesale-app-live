// FINAL COST HEALTH CLEANUP — 2026-10-08.
// Pins the narrow Cost Source Health rule changes and proves the things the
// cleanup must NOT move: the $5/hr owner machine rate, the Roland ink rate,
// the DTP ladders, the canonical 4x5 blank cost, and read-only behaviour.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  UNREFERENCED_PLACEHOLDER_MESSAGE,
  buildCostHealth,
  channelRoutedElsewhere,
  findInkMaterialForChannel,
  machineRoutingPolicy,
  type CostHealthInput,
  type CostHealthMachine,
  type CostHealthMaterial,
} from "../app/lib/cost-health-rules.server";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { decideMachine } from "../app/lib/print-intake-routing.server";
import { CANONICAL_INK_RATES } from "../app/lib/ink-rates-shared";
import { BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24, BAG_4X5_BLANK_UNIT_COST, computeBagPhysical } from "../app/lib/bag-cost-inputs.server";
import { APPROVED_COST_TRUTH } from "../app/lib/approved-cost-updates.server";
import { DTP_OWNER_PRICE_LADDERS, ownerPriceForQuantity } from "../app/lib/dtp-owner-pricing.server";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ---- production-shaped fixtures (values copied from the live rows read on 2026-10-08) ----
const mimakiCmyk: CostHealthMaterial = { id: "m1", name: "Mimaki CMYK Ink", materialType: "ink_coating", productFamilies: "labels,sticker_bags", unit: "ml", baseUnit: "ml", costPerUnit: 0.176, purchaseCost: 176, volumeMl: 1000, calculatedUnitCost: 0.176, active: true, useInRecipes: true };
const mimakiWhite: CostHealthMaterial = { ...mimakiCmyk, id: "m2", name: "Mimaki White Ink" };
const rolandCmyk: CostHealthMaterial = { id: "r1", name: "Roland LG CMYK Ink", materialType: "ink_coating", productFamilies: "labels,sticker_bags", unit: "ml", baseUnit: "ml", costPerUnit: 149 / 750, purchaseCost: 149, volumeMl: 750, calculatedUnitCost: 149 / 750, active: true, useInRecipes: true };
const rolandWhite: CostHealthMaterial = { ...rolandCmyk, id: "r2", name: "Roland LG White Ink" };
const rolandGloss: CostHealthMaterial = { ...rolandCmyk, id: "r3", name: "Roland LG Gloss Ink" };
const inkMaterials = [mimakiCmyk, mimakiWhite, rolandCmyk, rolandGloss, rolandWhite]; // alphabetical like the loader's orderBy name

const packingSupplies: CostHealthMaterial = { id: "p1", name: "Packing Supplies", materialType: "packaging_supplies", productFamilies: "", unit: "each", baseUnit: "each", costPerUnit: 0, purchaseCost: 0, calculatedUnitCost: 0, active: true, useInRecipes: true, costReviewNeeded: false, recipeReferences: 0 };
const bag4x5: CostHealthMaterial = { id: "b1", name: "4x5 Blank Bag", materialType: "blank_bags", productFamilies: "sticker_bags", unit: "each", baseUnit: "each", costPerUnit: 0.11, purchaseCost: 0.11, calculatedUnitCost: 0.11, active: true, useInRecipes: true, recipeReferences: 1 };

function slot(slotNumber: number, inkName: string, inkType: string, cartridgeCost: number, cartridgeMl: number, enabled = true) {
  return { id: `${inkName}-${slotNumber}`, slotNumber, inkName, inkType, costPerMl: cartridgeMl > 0 ? cartridgeCost / cartridgeMl : 0, cartridgeCost, cartridgeMl, mlPerSqft1Pct: 0.0075, mlPerSqft100: 0, enabled };
}
const mimaki: CostHealthMachine = {
  id: "mk", name: "Mimaki UCJV300-130", machineType: "printer", costPerHour: 5, sqftPerHour: 150, active: true,
  inkChannels: [slot(1, "Cyan", "cmyk", 176, 1000), slot(2, "Magenta", "cmyk", 176, 1000), slot(3, "Yellow", "cmyk", 176, 1000), slot(4, "Black", "cmyk", 176, 1000), slot(5, "White", "white", 176, 1000), slot(6, "White", "white", 176, 1000), slot(7, "Unused - gloss routed to Roland", "other", 0, 0, false), slot(8, "Unused - gloss routed to Roland", "other", 0, 0, false)],
};
const roland: CostHealthMachine = {
  id: "rl", name: "Roland TrueVIS LG-640", machineType: "printer", costPerHour: 5, sqftPerHour: 150, active: true,
  inkChannels: [slot(1, "Cyan", "cmyk", 149, 750), slot(2, "Magenta", "cmyk", 149, 750), slot(3, "Yellow", "cmyk", 149, 750), slot(4, "Black", "cmyk", 149, 750), slot(5, "White", "white", 149, 750), slot(6, "White", "white", 149, 750), slot(7, "Gloss", "gloss", 149, 750), slot(8, "Gloss", "gloss", 149, 750)],
};

function run(over: Partial<CostHealthInput> = {}) {
  return buildCostHealth({ materials: [...inkMaterials, packingSupplies, bag4x5], machines: [mimaki, roland], productTypes: [], vendorProductRows: [], recipesWithStoredLabor: [], sourcedCostTierCount: 0, productCostCount: 0, pricingRuleCount: 0, ...over });
}
const critical = (r: ReturnType<typeof run>) => r.issues.filter((i) => i.status === "critical");

describe("ISSUE 1 — Packing Supplies health classification", () => {
  it("an unreferenced zero-cost placeholder is a WARNING, not a critical cost source (nothing prices from it)", () => {
    const r = run();
    const row = r.issues.find((i) => i.item === "Packing Supplies");
    expect(row?.status).toBe("warning");
    expect(row?.message).toBe(UNREFERENCED_PLACEHOLDER_MESSAGE);
    expect(critical(r)).toEqual([]);
    expect(r.cards.find((c) => c.label === "Critical issues")?.value).toBe(0);
  });

  it("the same material stays CRITICAL once a recipe references it, when references are unknown (fail closed), or when it is ink / roll media", () => {
    expect(run({ materials: [...inkMaterials, { ...packingSupplies, recipeReferences: 1 }] }).issues.find((i) => i.item === "Packing Supplies")?.status).toBe("critical");
    expect(run({ materials: [...inkMaterials, { ...packingSupplies, recipeReferences: undefined }] }).issues.find((i) => i.item === "Packing Supplies")?.status).toBe("critical");
    const zeroInk = { ...mimakiCmyk, id: "zi", name: "Mystery Ink", costPerUnit: 0, purchaseCost: 0, calculatedUnitCost: 0, recipeReferences: 0 };
    expect(run({ materials: [...inkMaterials, zeroInk] }).issues.filter((i) => i.item === "Mystery Ink" && i.status === "critical").length).toBeGreaterThan(0);
  });
});

describe("ISSUE 2 — 4x5 blank bag live-data authority (resolved by owner decision 2026-10-08: $0.11)", () => {
  it("canonical code, calculator preset, Approved Cost Updates and the Material/VendorProduct value agree on $0.11; $0.09 is SUPERSEDED", () => {
    expect(BAG_4X5_BLANK_UNIT_COST).toBe(0.11);
    expect(BAG_4X5_BLANK_SUPERSEDED_SUPPLIER_BASE_2026_08_24).toBe(0.09);
    expect(read("../app/routes/app.erp.cost-calculator.tsx")).toContain('fixed("preset:blank-4x5-bag", "Blank 4x5 bag", 0.11');
    const entry = APPROVED_COST_TRUTH.find((item) => item.key === "bag-4x5")!;
    expect(entry.flatCost).toBe(0.11);
    expect(entry.matchVendorSkus).toEqual(["preset:blank-4x5-bag"]);
    expect(run().materialPreview.find((m) => m.name === "4x5 Blank Bag")?.costPerUnit).toBe(0.11);
  });

  it("the canonical bag adapter charges the $0.11 base by default", () => {
    const base = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 as any });
    const explicit11 = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 as any, blankUnitCost: 0.11 });
    const superseded09 = computeBagPhysical({ product: "sticker_bag_4x5", bagQuantity: 1000, sides: 1 as any, blankUnitCost: 0.09 });
    expect(base.blankCost).toBeCloseTo(explicit11.blankCost, 10);
    expect(superseded09.blankCost).toBeLessThan(base.blankCost);
  });
});

describe("ISSUE 3 — Mimaki stays CMYK-only for routing even though white slots are stored", () => {
  it("routing authority sends every white / gloss job to the Roland; an explicit Mimaki assignment on white is a contradiction, not a route", () => {
    expect(decideMachine({ selectedFinish: "White + CMYK", materialSummary: "white ink layer", machineSummary: null } as any).machine).toBe("roland");
    expect(decideMachine({ selectedFinish: "Gloss", materialSummary: "spot gloss", machineSummary: null } as any).machine).toBe("roland");
    expect(decideMachine({ selectedFinish: "CMYK", materialSummary: "standard cmyk", machineSummary: null } as any).machine).toBe("mimaki");
    expect(decideMachine({ selectedFinish: "White + CMYK", materialSummary: "white ink layer", machineSummary: "Mimaki UCJV300-130" } as any).machine).toBeNull();
    expect(CANONICAL_INK_RATES.mimakiGlossPerMl).toBeNull();
  });

  it("Cost Health reports the Mimaki white slots as hardware data that never prices a job, and no longer warns that the Mimaki lacks a gloss channel", () => {
    expect(machineRoutingPolicy(mimaki).cmykOnly).toBe(true);
    expect(machineRoutingPolicy(mimaki).label).toMatch(/CMYK only/);
    expect(machineRoutingPolicy(roland).cmykOnly).toBe(false);
    expect(channelRoutedElsewhere(slot(5, "White", "white", 176, 1000), mimaki)).toBe(true);
    expect(channelRoutedElsewhere(slot(5, "White", "white", 149, 750), roland)).toBe(false);
    const r = run();
    const mk = r.machinePreview.find((m) => m.name === mimaki.name)!;
    expect(mk.channels.filter((c) => c.routedElsewhere).map((c) => c.slotNumber)).toEqual([5, 6]);
    expect(mk.channels.length).toBe(6); // the two disabled slots stay disabled; nothing deleted
    expect(r.issues.filter((i) => i.area === "Print layers" && i.item === mimaki.name)).toEqual([]);
    // the Roland is the white/gloss home, so a Roland missing gloss still warns
    const rolandNoGloss = { ...roland, inkChannels: roland.inkChannels!.filter((c) => c.inkType !== "gloss") };
    expect(run({ machines: [mimaki, rolandNoGloss] }).issues.some((i) => i.area === "Print layers" && i.item === roland.name && /gloss/i.test(i.message))).toBe(true);
  });
});

describe("ISSUE 4 — Roland CMYK source mapping", () => {
  it("a Roland CMYK slot with its own cartridge cost reports 'slot' as the source at $0.198667/ml and no material label at all (the old 'via Mimaki CMYK Ink' was a display-only fallback label)", () => {
    const rl = run().machinePreview.find((m) => m.name === roland.name)!;
    for (const c of rl.channels) {
      expect(c.costSource).toBe("slot");
      expect(c.matchedMaterialName).toBe("");
      expect(c.costPerMl).toBeCloseTo(149 / 750, 9);
    }
    expect(CANONICAL_INK_RATES.rolandPerMl).toBeCloseTo(0.198667, 6);
  });

  it("when a slot has no cost of its own the fallback matcher is machine-aware: Roland -> Roland LG CMYK Ink, Mimaki -> Mimaki CMYK Ink, never cross-brand", () => {
    const bare = slot(1, "Cyan", "cmyk", 0, 0);
    expect(findInkMaterialForChannel(bare, inkMaterials, roland)?.name).toBe("Roland LG CMYK Ink");
    expect(findInkMaterialForChannel(bare, inkMaterials, mimaki)?.name).toBe("Mimaki CMYK Ink");
    expect(findInkMaterialForChannel(slot(5, "White", "white", 0, 0), inkMaterials, roland)?.name).toBe("Roland LG White Ink");
    expect(findInkMaterialForChannel(bare, [mimakiCmyk], roland)).toBeNull(); // the only candidate is the other brand -> no match
    const bareRoland = { ...roland, inkChannels: [bare] };
    const preview = run({ machines: [mimaki, bareRoland] }).machinePreview.find((m) => m.name === roland.name)!.channels[0];
    expect(preview.costSource).toBe("material_estimate");
    expect(preview.matchedMaterialName).toBe("Roland LG CMYK Ink");
  });

  it("the page only prints a material name as 'estimated via' when the fallback is actually in use", () => {
    const src = read("../app/routes/app.erp.cost-health.tsx");
    expect(src).toContain('c.costSource === "slot" ? <span> (slot cost)</span> : c.matchedMaterialName ? <span> (estimated via {c.matchedMaterialName})</span> : null');
    expect(src).not.toContain("<span> via {c.matchedMaterialName}</span>");
  });
});

describe("UNCHANGED — machine $5/hr, DTP ladders, read-only page", () => {
  it("the owner machine recovery standard is still $5/hr (owner_verified) and Cost Health flags a record that disagrees", () => {
    expect(OWNER_STANDARDS.machineRecoveryPerHour.value).toBe(5);
    expect(OWNER_STANDARDS.machineRecoveryPerHour.status).toBe("owner_verified");
    expect(run().issues.filter((i) => i.area === "Rates")).toEqual([]);
    const stale = run({ machines: [{ ...mimaki, costPerHour: 8 }, roland] }).issues.filter((i) => i.area === "Rates");
    expect(stale.length).toBe(1);
    expect(stale[0].message).toContain("$8.00/hr");
    expect(stale[0].message).toContain("$5/hr");
  });

  it("DTP owner ladders are untouched (five current sizes at 1k/2.5k/5k/10k/25k; above 25k = vendor quote)", () => {
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-3.5x4.5x2"]).toEqual({ 1000: 1.3, 2500: 0.7, 5000: 0.45, 10000: 0.36, 25000: 0.29 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-4x5x2"]).toEqual({ 1000: 1.3, 2500: 0.71, 5000: 0.46, 10000: 0.37, 25000: 0.3 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-5x5x2"]).toEqual({ 1000: 1.35, 2500: 0.75, 5000: 0.49, 10000: 0.41, 25000: 0.35 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-6x5x2"]).toEqual({ 1000: 1.4, 2500: 0.78, 5000: 0.54, 10000: 0.46, 25000: 0.4 });
    expect(DTP_OWNER_PRICE_LADDERS["spektra-dtp-8x5x2"]).toEqual({ 1000: 1.5, 2500: 0.86, 5000: 0.65, 10000: 0.59, 25000: 0.52 });
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 25000).unitPrice).toBe(0.3);
    expect(ownerPriceForQuantity("spektra-dtp-4x5x2", 25001).unitPrice).toBeNull();
  });

  it("historical snapshots cannot be touched by this page: the rules module is pure and the route has no action and no write calls", () => {
    const rules = read("../app/lib/cost-health-rules.server.ts");
    expect(rules).not.toMatch(/@prisma\/client|db\.server|shopify\.server|\bdb\.|\.update\(|\.create\(|\.delete\(|upsert/);
    const route = read("../app/routes/app.erp.cost-health.tsx");
    expect(route).not.toMatch(/export (async )?function action/);
    expect(route).not.toMatch(/\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\(/);
    expect(route).toContain("buildCostHealth(");
    expect((route.match(/\.findMany\(|\.count\(/g) || []).length).toBe(8); // the same 8 read-only queries as before the extraction
  });
});
