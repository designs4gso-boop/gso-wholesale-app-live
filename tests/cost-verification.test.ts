import { describe, expect, it } from "vitest";

import {
  CALCULATOR_ASSUMPTION_ROWS,
  CONFIDENCE_LABELS,
  NO_FLAT_COST_ISSUE,
  OWNER_CHECKLIST_HEADER,
  PLACEHOLDER_ISSUE,
  SEEDED_FINGERPRINTS,
  UNEXPECTED_TIERS_ISSUE,
  buildReplayTests,
  calculatorPrefillUrl,
  checklistRowToCells,
  classifyConfidence,
  hasSeededNotes,
  hasVerifiedMarker,
  looksLikePlaceholder,
  nearlyEqual,
  tierPolicy,
  tiersNonMonotonic,
  worstConfidence,
  type ChecklistRow,
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

describe("owner cost checklist (13.2.1)", () => {
  it("tier policy: Miron is expected tiered, everything else expected flat", () => {
    expect(tierPolicy("MIRON", "50ml Miron jar + lid")).toBe("expected_tiered");
    expect(tierPolicy("", "100ml tall Miron jar")).toBe("expected_tiered");
    expect(tierPolicy("SAFE CARE", "4oz jar - clear")).toBe("expected_flat");
    expect(tierPolicy(null, null)).toBe("expected_flat");
  });

  it("placeholder detection catches template/placeholder/sample/test and the 5oz jar", () => {
    expect(looksLikePlaceholder("Template recipe shell", "", "")).toBe(true);
    expect(looksLikePlaceholder("", "", "placeholder cost only")).toBe(true);
    expect(looksLikePlaceholder("Sample jar", "", "")).toBe(true);
    expect(looksLikePlaceholder("Test material", "", "")).toBe(true);
    expect(looksLikePlaceholder("5oz Clear Blank Jar", "", "")).toBe(true);
    expect(looksLikePlaceholder("", "preset:jar_5oz_clear", "")).toBe(true);
    expect(looksLikePlaceholder("50ml Miron jar + lid", "preset:miron-50ml", "from invoice")).toBe(false);
    // "latest" contains "test" as a substring but not as a word.
    expect(looksLikePlaceholder("Latest gloss media", "", "")).toBe(false);
  });

  it("issue strings match the owner's exact wording", () => {
    expect(UNEXPECTED_TIERS_ISSUE).toBe("Unexpected tiers — owner says only Miron should be tiered unless confirmed.");
    expect(NO_FLAT_COST_ISSUE).toBe("No usable flat cost — enter one via Vendor Cost Book.");
    expect(PLACEHOLDER_ISSUE).toBe("Possible placeholder — owner decide: delete, disable, or fill real cost.");
  });

  it("header has the exact 15 owner columns in order", () => {
    expect([...OWNER_CHECKLIST_HEADER]).toEqual([
      "category", "item name", "vendor", "current app cost", "unit",
      "tier min qty", "tier max qty", "MOQ", "cost source table/model",
      "confidence", "issue/warning", "verify against", "fix page",
      "OWNER STATUS", "OWNER NOTES",
    ]);
  });

  it("rows serialize with blank OWNER STATUS / OWNER NOTES cells", () => {
    const row: ChecklistRow = {
      category: "Blank / vendor item (tiered)",
      itemName: "50ml Miron jar + lid",
      vendor: "MIRON",
      cost: 2.46,
      unit: "each",
      tierMinQty: 1,
      tierMaxQty: 249,
      moq: 128,
      source: "VendorProductTier",
      confidence: "seeded",
      issue: "",
      verify: "Vendor invoice / price sheet (MIRON)",
      fixPage: "Vendor Cost Book",
    };
    const cells = checklistRowToCells(row);
    expect(cells).toHaveLength(OWNER_CHECKLIST_HEADER.length);
    expect(cells[3]).toBe(2.46);
    expect(cells[5]).toBe(1);
    expect(cells[6]).toBe(249);
    expect(cells[13]).toBe("");
    expect(cells[14]).toBe("");
    expect(cells[9]).toBe(CONFIDENCE_LABELS.seeded);
  });

  it("null cost/tier/moq cells export as empty strings, n/a confidence passes through", () => {
    const cells = checklistRowToCells({
      category: "Legacy tables (context)", itemName: "x", vendor: "", cost: null, unit: "",
      tierMinQty: null, tierMaxQty: null, moq: null, source: "Legacy tables",
      confidence: "n/a", issue: "", verify: "", fixPage: "Cost Health",
    });
    expect(cells[3]).toBe("");
    expect(cells[5]).toBe("");
    expect(cells[7]).toBe("");
    expect(cells[9]).toBe("n/a");
  });

  it("calculator assumptions export as seeded hardcoded rows", () => {
    expect(CALCULATOR_ASSUMPTION_ROWS.length).toBeGreaterThanOrEqual(10);
    const labor = CALCULATOR_ASSUMPTION_ROWS.find((row) => /labor rate/i.test(row.itemName));
    expect(labor?.cost).toBe(25);
    const machine = CALCULATOR_ASSUMPTION_ROWS.find((row) => /machine rate/i.test(row.itemName));
    expect(machine?.cost).toBe(8);
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
