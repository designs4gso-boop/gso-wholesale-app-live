import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_LABELS,
  SEEDED_FINGERPRINTS,
  buildReplayTests,
  calculatorPrefillUrl,
  classifyConfidence,
  hasSeededNotes,
  hasVerifiedMarker,
  nearlyEqual,
  tiersNonMonotonic,
  worstConfidence,
} from "../app/lib/cost-verification-shared";

describe("verified marker and seeded notes detection", () => {
  it("detects the interim [VERIFIED ...] notes marker", () => {
    expect(hasVerifiedMarker("Miron jar cost [VERIFIED 2026-07-17 inv#123]")).toBe(true);
    expect(hasVerifiedMarker("[verified]")).toBe(true);
    expect(hasVerifiedMarker("verified by phone")).toBe(false);
    expect(hasVerifiedMarker(null)).toBe(false);
  });

  it("detects seed/preset provenance in notes", () => {
    expect(hasSeededNotes("Seeded from app.erp.cost-calculator.tsx presetBlankItems().")).toBe(true);
    expect(hasSeededNotes("Cost Calculator preset <250")).toBe(true);
    expect(hasSeededNotes("entered from invoice 4412")).toBe(false);
  });
});

describe("confidence classification", () => {
  it("VERIFIED marker outranks a seeded fingerprint", () => {
    expect(classifyConfidence({ notes: "seeded preset [VERIFIED 2026-07-17]", value: 5, seededFingerprint: true })).toBe("verified");
  });

  it("missing/zero values are missing regardless of notes", () => {
    expect(classifyConfidence({ notes: "anything", value: 0 })).toBe("missing");
    expect(classifyConfidence({ notes: "anything", value: null })).toBe("missing");
  });

  it("fingerprints and seeded notes classify as seeded; otherwise manual", () => {
    expect(classifyConfidence({ notes: "", value: 5, seededFingerprint: true })).toBe("seeded");
    expect(classifyConfidence({ notes: "Seeded from jar preset", value: 2.46 })).toBe("seeded");
    expect(classifyConfidence({ notes: "from invoice", value: 2.1 })).toBe("manual");
  });

  it("worstConfidence picks the weakest link and labels exist for all levels", () => {
    expect(worstConfidence(["verified", "manual", "seeded"])).toBe("seeded");
    expect(worstConfidence(["verified", "missing"])).toBe("missing");
    expect(worstConfidence([])).toBe("missing");
    for (const label of Object.values(CONFIDENCE_LABELS)) expect(label.length).toBeGreaterThan(0);
  });
});

describe("fingerprints and tier sanity", () => {
  it("nearlyEqual matches the seeded constants exactly", () => {
    expect(nearlyEqual(5, SEEDED_FINGERPRINTS.machineRatePerHour)).toBe(true);
    expect(nearlyEqual(0.0075, SEEDED_FINGERPRINTS.inkUsagePerSqftPct)).toBe(true);
    expect(nearlyEqual(190, SEEDED_FINGERPRINTS.mimakiBottleCost)).toBe(true);
    expect(nearlyEqual(156.99, SEEDED_FINGERPRINTS.rolandPouchCost)).toBe(true);
    expect(nearlyEqual(5.01, SEEDED_FINGERPRINTS.machineRatePerHour)).toBe(false);
  });

  it("flags tiers whose unit cost rises with quantity", () => {
    expect(tiersNonMonotonic([
      { minQty: 1, unitCost: 2.46 },
      { minQty: 250, unitCost: 2.24 },
      { minQty: 500, unitCost: 2.03 },
    ])).toBe(false);
    expect(tiersNonMonotonic([
      { minQty: 1, unitCost: 2.03 },
      { minQty: 250, unitCost: 2.46 },
    ])).toBe(true);
  });
});

describe("replay tests (T1-T7)", () => {
  const context = {
    threeOzItemId: "vendor:abc",
    fourOzItemId: "vendor:def",
    holographicMaterialId: "mat-holo",
    bagItemId: "preset:blank-4x5-bag",
    blankOnlyItemId: "vendor:tiered",
    hasRipRows: true,
    hasOutsourcedRecipe: true,
  };

  it("prefill URLs use the Cost Calculator's exact param names", () => {
    const url = calculatorPrefillUrl({ lineCount: 1, lineQty: 600, itemMode: "inventory", itemId: "vendor:abc" });
    expect(url.startsWith("/app/erp/cost-calculator?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("lineCount")).toBe("1");
    expect(params.get("lineQty")).toBe("600");
    expect(params.get("itemMode")).toBe("inventory");
    expect(params.get("itemId")).toBe("vendor:abc");
  });

  it("builds all seven tests with T4 as a pending placeholder", () => {
    const tests = buildReplayTests(context);
    expect(tests.map((t) => t.id)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
    const t4 = tests.find((t) => t.id === "T4")!;
    expect(t4.pending).toBe(true);
    expect(t4.href).toBeNull();
  });

  it("T1 prefills the holographic material, 3oz item, and jar workflow", () => {
    const t1 = buildReplayTests(context).find((t) => t.id === "T1")!;
    const params = new URLSearchParams(String(t1.href).split("?")[1]);
    expect(params.get("itemId")).toBe("vendor:abc");
    expect(params.get("lineMaterialId")).toBe("mat-holo");
    expect(params.get("applicationMode")).toBe("apply-jar");
    expect(params.get("cuttingMode")).toBe("contour");
    expect(params.get("prepressMode")).toBe("basic");
    expect(params.get("packoutMode")).toBe("standard");
    expect(params.get("lineQty")).toBe("600");
  });

  it("degrades gracefully when records are missing", () => {
    const tests = buildReplayTests({
      threeOzItemId: null,
      fourOzItemId: null,
      holographicMaterialId: null,
      bagItemId: null,
      blankOnlyItemId: null,
      hasRipRows: false,
      hasOutsourcedRecipe: false,
    });
    for (const test of tests) expect(test.href).toBeNull();
    expect(tests.find((t) => t.id === "T5")!.hrefLabel).toContain("No synced GSOQ");
  });
});
