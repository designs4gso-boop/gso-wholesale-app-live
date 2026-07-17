import { describe, expect, it } from "vitest";

import {
  APPLY_CONFIRM_PHRASE,
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
  looksLikeTemplateRecord,
  matchApprovedRecord,
  nearlyEqual,
  tierChangeSummary,
  tierPolicy,
  tiersMatchApproved,
  tiersNonMonotonic,
  worstConfidence,
  type ChecklistRow,
} from "../app/lib/cost-verification-shared";
// Safe to import: the server lib takes the Prisma client as a parameter and
// never constructs it (imports only the shared pure lib).
import { APPROVED_COST_TRUTH, evaluateApprovedItem } from "../app/lib/approved-cost-updates.server";

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

describe("approved cost updates (13.2.2)", () => {
  it("confirmation phrase is exact", () => {
    expect(APPLY_CONFIRM_PHRASE).toBe("APPLY VERIFIED COSTS");
  });

  it("pins the owner-approved truth numbers (esp. the 100ml tall correction and DTP pouch)", () => {
    const tall = APPROVED_COST_TRUTH.find((item) => item.key === "miron-100ml-tall")!;
    expect(tall.tiers!.map((tier) => tier.unitCost)).toEqual([2.78, 2.54, 2.31, 2.14, 1.99]);
    const fifty = APPROVED_COST_TRUTH.find((item) => item.key === "miron-50ml")!;
    expect(fifty.tiers!.map((tier) => tier.unitCost)).toEqual([2.46, 2.24, 2.03, 1.89, 1.74]);
    const pouch = APPROVED_COST_TRUTH.find((item) => item.key === "dtp-4x5x2-pouch")!;
    expect(pouch.tiers!.map((tier) => [tier.minQty, tier.unitCost])).toEqual([
      [1000, 0.7138], [2500, 0.4744], [5000, 0.4029], [7500, 0.3458], [10000, 0.3117],
    ]);
    const bags = APPROVED_COST_TRUTH.filter((item) => item.key.startsWith("bag-"));
    expect(bags.map((bag) => bag.flatCost)).toEqual([0.09, 0.1, 1.0]);
    expect(APPROVED_COST_TRUTH.find((item) => item.key === "dtp-4x6x2-pouch")!.policy).toBe("do_not_update");
    expect(APPROVED_COST_TRUTH.find((item) => item.key === "miron-black-metal-lids")!.policy).toBe("do_not_update");
    expect(APPROVED_COST_TRUTH.filter((item) => item.key.startsWith("template-")).every((item) => item.policy === "manual_review")).toBe(true);
  });

  const candidates = [
    { id: "a", name: "50ml Miron jar + lid", vendorSku: "preset:miron-50ml" },
    { id: "b", name: "100ml tall Miron jar + lid", vendorSku: "preset:miron-100ml-tall" },
    { id: "c", name: "Template - 4x5 Outsourced Stock Bag", vendorSku: null },
    { id: "d", name: "Blank 4x5 bag", vendorSku: null },
  ];

  it("matches by exact vendorSku first, then unique name", () => {
    const bySku = matchApprovedRecord({ matchVendorSkus: ["preset:miron-50ml"], matchName: /^50\s?ml.*miron/i }, candidates);
    expect(bySku.status).toBe("matched");
    expect(bySku.record?.id).toBe("a");

    const byName = matchApprovedRecord({ matchVendorSkus: ["preset:missing"], matchName: /^100\s?ml.*tall.*miron/i }, candidates);
    expect(byName.status).toBe("matched");
    expect(byName.record?.id).toBe("b");
  });

  it("template records are excluded from normal matching (4x5 bag matches the real item)", () => {
    expect(looksLikeTemplateRecord("Template - 4x5 Outsourced Stock Bag")).toBe(true);
    expect(looksLikeTemplateRecord("Blank 4x5 bag")).toBe(false);
    const result = matchApprovedRecord({ matchVendorSkus: [], matchName: /4\s?x\s?5\b.*bag/i }, candidates);
    expect(result.status).toBe("matched");
    expect(result.record?.id).toBe("d");
  });

  it("multiple hits are ambiguous, zero hits are missing", () => {
    const ambiguous = matchApprovedRecord({ matchVendorSkus: [], matchName: /miron/i }, candidates);
    expect(ambiguous.status).toBe("ambiguous");
    const missing = matchApprovedRecord({ matchVendorSkus: [], matchName: /never-matches-anything/i }, candidates);
    expect(missing.status).toBe("missing");
  });

  it("detects the 100ml tall tier drift and summarizes the changes", () => {
    const seeded = [
      { minQty: 1, maxQty: 249, unitCost: 2.86 },
      { minQty: 250, maxQty: 499, unitCost: 2.63 },
      { minQty: 500, maxQty: 999, unitCost: 2.41 },
      { minQty: 1000, maxQty: 2499, unitCost: 2.22 },
      { minQty: 2500, maxQty: null, unitCost: 2.07 },
    ];
    const approved = APPROVED_COST_TRUTH.find((item) => item.key === "miron-100ml-tall")!.tiers!;
    expect(tiersMatchApproved(seeded, approved)).toBe(false);
    const changes = tierChangeSummary(seeded, approved);
    expect(changes).toHaveLength(5);
    expect(changes[0]).toContain("$2.8600 -> $2.7800");

    const fiftyApproved = APPROVED_COST_TRUTH.find((item) => item.key === "miron-50ml")!.tiers!;
    const fiftySeeded = [
      { minQty: 1, maxQty: 249, unitCost: 2.46 },
      { minQty: 250, maxQty: 499, unitCost: 2.24 },
      { minQty: 500, maxQty: 999, unitCost: 2.03 },
      { minQty: 1000, maxQty: 2499, unitCost: 1.89 },
      { minQty: 2500, maxQty: null, unitCost: 1.74 },
    ];
    expect(tiersMatchApproved(fiftySeeded, fiftyApproved)).toBe(true);
    expect(tierChangeSummary(fiftySeeded, fiftyApproved)).toEqual([]);
  });
});

describe("blank bag + DTP creation (13.2.3)", () => {
  const noRecords: any[] = [];

  it("pins the creation specs (names, SKUs, types, Vendor TBD)", () => {
    const specs = APPROVED_COST_TRUTH.filter((item) => item.creation).map((item) => item.creation!);
    expect(specs.map((spec) => spec.name)).toEqual(["4x5 Blank Bag", "4x6 Blank Bag", "14x16 Blank Bag", "DTP 4x5x2 Blank Pouch"]);
    expect(specs.every((spec) => spec.vendor === "Vendor TBD")).toBe(true);
    expect(specs.map((spec) => spec.productType)).toEqual(["bag", "bag", "bag", "dtp_bag"]);
    expect(specs.map((spec) => spec.vendorSku)).toEqual(["preset:blank-4x5-bag", "preset:blank-4x6-bag", "preset:pound-bag", "preset:dtp-4x5x2-pouch"]);
    // do_not_update / manual_review items must never carry a creation spec.
    expect(APPROVED_COST_TRUTH.filter((item) => item.policy !== "update").every((item) => !item.creation)).toBe(true);
  });

  it("missing item WITH a creation spec becomes will_create (flat bag: no tier rows)", () => {
    const bag = APPROVED_COST_TRUTH.find((item) => item.key === "bag-4x6")!;
    const { row } = evaluateApprovedItem(bag, noRecords);
    expect(row.status).toBe("will_create");
    expect(row.changes.some((change) => change.includes('create VendorProduct "4x6 Blank Bag"'))).toBe(true);
    expect(row.changes.some((change) => change.includes("no tier rows"))).toBe(true);
    expect(row.changes.some((change) => change.includes("verified marker"))).toBe(true);
  });

  it("missing DTP pouch becomes will_create with its 5 tier rows", () => {
    const pouch = APPROVED_COST_TRUTH.find((item) => item.key === "dtp-4x5x2-pouch")!;
    const { row } = evaluateApprovedItem(pouch, noRecords);
    expect(row.status).toBe("will_create");
    expect(row.changes.some((change) => change.includes("create 5 tier row(s)"))).toBe(true);
  });

  it("missing item WITHOUT a creation spec stays missing_record", () => {
    const miron = APPROVED_COST_TRUTH.find((item) => item.key === "miron-50ml")!;
    expect(miron.creation).toBeUndefined();
    const { row } = evaluateApprovedItem(miron, noRecords);
    expect(row.status).toBe("missing_record");
  });

  it("an existing clean record with a blank cost is updated, not duplicated", () => {
    const bag = APPROVED_COST_TRUTH.find((item) => item.key === "bag-4x5")!;
    const existing = [{ id: "x", name: "Blank 4x5 bag", vendor: "SAFE CARE", vendorSku: null, defaultUnitCost: 0, notes: null, tiers: [] }];
    const { row } = evaluateApprovedItem(bag, existing as any);
    expect(row.status).toBe("will_update");
    expect(row.changes.some((change) => change.includes("flat cost: none ->"))).toBe(true);
  });

  it("template records still evaluate to manual review and are never creatable", () => {
    const template = APPROVED_COST_TRUTH.find((item) => item.key === "template-4x5-stock-bag")!;
    const existing = [{ id: "t", name: "Template - 4x5 Outsourced Stock Bag", vendor: null, vendorSku: null, defaultUnitCost: 0, notes: null, tiers: [] }];
    const { row } = evaluateApprovedItem(template, existing as any);
    expect(row.status).toBe("manual_review");
  });

  it("DTP 4x6x2 stays do_not_update even with no record", () => {
    const pouch = APPROVED_COST_TRUTH.find((item) => item.key === "dtp-4x6x2-pouch")!;
    const { row } = evaluateApprovedItem(pouch, noRecords);
    expect(row.status).toBe("do_not_update");
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
