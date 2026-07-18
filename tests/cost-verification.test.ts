import { describe, expect, it } from "vitest";

import {
  APPLY_CONFIRM_PHRASE,
  CALCULATOR_ASSUMPTION_ROWS,
  CONFIDENCE_LABELS,
  CURRENT_CALC_LABOR,
  LABOR_RULE_COMPARISONS,
  LABOR_STANDARDS,
  LABOR_STANDARD_CONFIDENCE_LABEL,
  NO_FLAT_COST_ISSUE,
  buildLaborWiringScenarios,
  OWNER_CHECKLIST_HEADER,
  PLACEHOLDER_ISSUE,
  REPLAY_RECORD_FIELDS,
  SEEDED_FINGERPRINTS,
  SINGLE_TIER_FLAT_NOTE,
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
import { APPROVED_COST_TRUTH, APPROVED_ROLL_COSTS, evaluateApprovedItem, type EvalContext } from "../app/lib/approved-cost-updates.server";

const emptyContext: EvalContext = { vendorProducts: [], materials: [], machines: [] };
const ctxWith = (partial: Partial<EvalContext>): EvalContext => ({ ...emptyContext, ...partial });

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
  it("tier policy: Miron AND DTP 4x5x2 are expected tiered, everything else expected flat", () => {
    expect(tierPolicy("MIRON", "50ml Miron jar + lid")).toBe("expected_tiered");
    expect(tierPolicy("", "100ml tall Miron jar")).toBe("expected_tiered");
    expect(tierPolicy("Vendor TBD", "DTP 4x5x2 Blank Pouch")).toBe("expected_tiered");
    expect(tierPolicy("SAFE CARE", "4oz jar - clear")).toBe("expected_flat");
    expect(tierPolicy("", "DTP 4x6x2 Blank Pouch")).toBe("expected_flat");
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
    const { row } = evaluateApprovedItem(bag, emptyContext);
    expect(row.status).toBe("will_create");
    expect(row.changes.some((change) => change.includes('create VendorProduct "4x6 Blank Bag"'))).toBe(true);
    expect(row.changes.some((change) => change.includes("no tier rows"))).toBe(true);
    expect(row.changes.some((change) => change.includes("verified marker"))).toBe(true);
  });

  it("missing DTP pouch becomes will_create with its 5 tier rows", () => {
    const pouch = APPROVED_COST_TRUTH.find((item) => item.key === "dtp-4x5x2-pouch")!;
    const { row } = evaluateApprovedItem(pouch, emptyContext);
    expect(row.status).toBe("will_create");
    expect(row.changes.some((change) => change.includes("create 5 tier row(s)"))).toBe(true);
  });

  it("missing item WITHOUT a creation spec stays missing_record", () => {
    const miron = APPROVED_COST_TRUTH.find((item) => item.key === "miron-50ml")!;
    expect(miron.creation).toBeUndefined();
    const { row } = evaluateApprovedItem(miron, emptyContext);
    expect(row.status).toBe("missing_record");
  });

  it("an existing clean record with a blank cost is updated, not duplicated", () => {
    const bag = APPROVED_COST_TRUTH.find((item) => item.key === "bag-4x5")!;
    const context = ctxWith({ vendorProducts: [{ id: "x", name: "Blank 4x5 bag", vendor: "SAFE CARE", vendorSku: null, defaultUnitCost: 0, notes: null, tiers: [] }] as any });
    const { row } = evaluateApprovedItem(bag, context);
    expect(row.status).toBe("will_update");
    expect(row.changes.some((change) => change.includes("flat cost: none ->"))).toBe(true);
  });

  it("template records still evaluate to manual review and are never creatable", () => {
    const template = APPROVED_COST_TRUTH.find((item) => item.key === "template-4x5-stock-bag")!;
    const context = ctxWith({ vendorProducts: [{ id: "t", name: "Template - 4x5 Outsourced Stock Bag", vendor: null, vendorSku: null, defaultUnitCost: 0, notes: null, tiers: [] }] as any });
    const { row } = evaluateApprovedItem(template, context);
    expect(row.status).toBe("manual_review");
  });

  it("DTP 4x6x2 stays do_not_update even with no record", () => {
    const pouch = APPROVED_COST_TRUTH.find((item) => item.key === "dtp-4x6x2-pouch")!;
    const { row } = evaluateApprovedItem(pouch, emptyContext);
    expect(row.status).toBe("do_not_update");
  });
});

describe("roll material + ink verification (13.2.4)", () => {
  const materialRow = (overrides: Record<string, unknown>) => ({
    id: "m1", name: "", materialType: "", sku: null, notes: null,
    costPerUnit: 0, calculatedUnitCost: 0, purchaseCost: 0, purchaseUnit: null,
    rollWidthIn: null, rollLengthFt: null, volumeMl: null, baseUnit: "sqft", unit: "sqft",
    ...overrides,
  });

  it("pins the approved full-precision costs (raw, no waste baked in)", () => {
    expect(APPROVED_ROLL_COSTS.poseidonMattePerSqft).toBeCloseTo(0.3155555556, 9);
    expect(APPROVED_ROLL_COSTS.poseidonMattePerSqft).toBe(213 / 675);
    expect(APPROVED_ROLL_COSTS.holographicPerSqft).toBeCloseTo(0.7141463415, 9);
    expect(APPROVED_ROLL_COSTS.bannerVinylPerSqft).toBeCloseTo(0.2962962963, 9);
    expect(APPROVED_ROLL_COSTS.mimakiPerMl).toBe(0.176);
    expect(APPROVED_ROLL_COSTS.rolandPerMl).toBeCloseTo(0.1986666667, 9);
  });

  it("Poseidon matte at the old 0.2889 cost becomes will_update with purchase details", () => {
    const item = APPROVED_COST_TRUTH.find((entry) => entry.key === "roll-poseidon-matte")!;
    const context = ctxWith({ materials: [materialRow({ name: "Poseidon Matte Roll Media", calculatedUnitCost: 0.2889, purchaseCost: 205 })] as any });
    const { row, materialRecord } = evaluateApprovedItem(item, context);
    expect(row.status).toBe("will_update");
    expect(materialRecord).not.toBeNull();
    expect(row.changes.some((change) => change.includes("cost/sqft"))).toBe(true);
    expect(row.changes.some((change) => change.includes("purchase cost: $205 -> $213"))).toBe(true);
    expect(row.changes.some((change) => change.includes("verified marker"))).toBe(true);
  });

  it("a roll already at the approved cost with marker is already_correct", () => {
    const item = APPROVED_COST_TRUTH.find((entry) => entry.key === "roll-holographic")!;
    const context = ctxWith({
      materials: [materialRow({ name: "Holographic Roll Media", calculatedUnitCost: 488 / ((50 / 12) * 164), purchaseCost: 488, rollWidthIn: 50, rollLengthFt: 164, notes: "[VERIFIED 2026-07-17 owner-approved roll/ink cost]" })] as any,
    });
    expect(evaluateApprovedItem(item, context).row.status).toBe("already_correct");
  });

  it("missing Banner Vinyl becomes will_create (the only material creation)", () => {
    const item = APPROVED_COST_TRUTH.find((entry) => entry.key === "roll-banner-vinyl")!;
    const { row } = evaluateApprovedItem(item, emptyContext);
    expect(row.status).toBe("will_create");
    expect(row.changes.some((change) => change.includes('create Material "Banner Vinyl"'))).toBe(true);
    const others = APPROVED_COST_TRUTH.filter((entry) => entry.target === "material" && entry.key !== "roll-banner-vinyl");
    expect(others.every((entry) => !entry.material?.creation)).toBe(true);
  });

  it("ink material group updates a combined single row AND per-type rows layouts", () => {
    const item = APPROVED_COST_TRUTH.find((entry) => entry.key === "ink-material-mimaki")!;
    const combined = ctxWith({ materials: [materialRow({ name: "Mimaki Ink", materialType: "ink_coating", calculatedUnitCost: 0.1765, volumeMl: 1000 })] as any });
    const combinedResult = evaluateApprovedItem(item, combined);
    expect(combinedResult.row.status).toBe("will_update");
    expect(combinedResult.materialGroup).toHaveLength(1);

    const perType = ctxWith({
      materials: [
        materialRow({ id: "a", name: "Mimaki CMYK Ink", materialType: "ink_coating", calculatedUnitCost: 0.1765 }),
        materialRow({ id: "b", name: "Mimaki White Ink", materialType: "ink_coating", calculatedUnitCost: 0.176 }),
      ] as any,
    });
    const perTypeResult = evaluateApprovedItem(item, perType);
    expect(perTypeResult.row.status).toBe("will_update");
    // only the drifted row (and the marker-less exact row) need updating; both lack markers here
    expect(perTypeResult.materialGroup.length).toBe(2);
  });

  it("ink material group with zero brand rows is missing_record, never created", () => {
    const item = APPROVED_COST_TRUTH.find((entry) => entry.key === "ink-material-roland")!;
    const { row } = evaluateApprovedItem(item, emptyContext);
    expect(row.status).toBe("missing_record");
    expect(item.material?.creation).toBeUndefined();
  });

  it("Mimaki channels at the seeded $0.19 become will_update; correct channels are already_correct", () => {
    const item = APPROVED_COST_TRUTH.find((entry) => entry.key === "ink-channels-mimaki")!;
    const machine = {
      id: "mach1", name: "Mimaki UCJV300-130",
      inkChannels: [
        { id: "c1", slotNumber: 1, inkName: "Cyan", inkType: "cmyk", enabled: true, costPerMl: 0.19, cartridgeCost: 190, cartridgeMl: 1000 },
        { id: "c2", slotNumber: 5, inkName: "White", inkType: "white", enabled: true, costPerMl: 0.19, cartridgeCost: 190, cartridgeMl: 1000 },
        { id: "c3", slotNumber: 7, inkName: "Unused", inkType: "other", enabled: false, costPerMl: 0, cartridgeCost: 0, cartridgeMl: 0 },
      ],
    };
    const result = evaluateApprovedItem(item, ctxWith({ machines: [machine] as any }));
    expect(result.row.status).toBe("will_update");
    expect(result.channelGroup[0].channels).toHaveLength(2); // disabled 'other' slot excluded

    const correct = {
      ...machine,
      inkChannels: machine.inkChannels.map((channel) => ({ ...channel, costPerMl: 0.176, cartridgeCost: 176, cartridgeMl: 1000 })),
    };
    expect(evaluateApprovedItem(item, ctxWith({ machines: [correct] as any })).row.status).toBe("already_correct");
  });

  it("two machines matching one brand is ambiguous — nothing updates", () => {
    const item = APPROVED_COST_TRUTH.find((entry) => entry.key === "ink-channels-roland")!;
    const machines = [
      { id: "r1", name: "Roland TrueVIS LG-540", inkChannels: [] },
      { id: "r2", name: "Roland backup", inkChannels: [] },
    ];
    const { row, channelGroup } = evaluateApprovedItem(item, ctxWith({ machines: machines as any }));
    expect(row.status).toBe("ambiguous");
    expect(channelGroup).toHaveLength(0);
  });
});

describe("replay slots (13.2.5 T1-T7)", () => {
  const context = {
    threeOzItemId: "vendor:abc",
    fourOzItemId: "vendor:def",
    bagItemId: "preset:blank-4x5-bag",
    dtpPouchItemId: "vendor:pouch",
    bannerVinylMaterialId: "mat-banner",
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

  it("builds the owner's seven slots in order with quantities and products", () => {
    const tests = buildReplayTests(context);
    expect(tests.map((t) => t.id)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
    expect(tests.map((t) => t.quantity)).toEqual([600, 600, 1000, 2500, 1, 500, 500]);
    expect(tests.every((t) => !t.pending)).toBe(true);
    expect(tests.find((t) => t.id === "T3")!.name).toContain("4x5 sticker bags");
    expect(tests.find((t) => t.id === "T5")!.product).toContain("Banner Vinyl");
  });

  it("T4 prefills the DTP pouch tier check at 2,500 with no application", () => {
    const t4 = buildReplayTests(context).find((t) => t.id === "T4")!;
    const params = new URLSearchParams(String(t4.href).split("?")[1]);
    expect(params.get("itemId")).toBe("vendor:pouch");
    expect(params.get("lineQty")).toBe("2500");
    expect(params.get("applicationMode")).toBe("none");
    expect(t4.verify).toContain("$0.4744");
  });

  it("T5 prefills the banner material; T6/T7 always link with the right ink profiles", () => {
    const tests = buildReplayTests(context);
    const t5 = new URLSearchParams(String(tests.find((t) => t.id === "T5")!.href).split("?")[1]);
    expect(t5.get("lineMaterialId")).toBe("mat-banner");
    const t6 = new URLSearchParams(String(tests.find((t) => t.id === "T6")!.href).split("?")[1]);
    expect(t6.get("lineInkEstimateProfile")).toBe("cmyk-white-heavy");
    const t7 = new URLSearchParams(String(tests.find((t) => t.id === "T7")!.href).split("?")[1]);
    expect(t7.get("lineInkEstimateProfile")).toBe("cmyk-3x-gloss-heavy");
  });

  it("degrades gracefully: record-dependent slots lose links, profile slots keep them", () => {
    const tests = buildReplayTests({ threeOzItemId: null, fourOzItemId: null, bagItemId: null, dtpPouchItemId: null, bannerVinylMaterialId: null });
    for (const id of ["T1", "T2", "T3", "T4", "T5"]) expect(tests.find((t) => t.id === id)!.href).toBeNull();
    for (const id of ["T6", "T7"]) expect(tests.find((t) => t.id === id)!.href).not.toBeNull();
  });

  it("the replay record template has the 12 required fields", () => {
    expect([...REPLAY_RECORD_FIELDS]).toEqual([
      "job name", "quantity", "product/material", "label/art sqft", "finish",
      "estimated app cost", "actual material used", "actual ink/RIP result",
      "actual labor minutes", "actual machine/print minutes", "variance", "owner notes",
    ]);
  });
});

describe("labor standards (13A.1)", () => {
  const byKey = (key: string) => LABOR_STANDARDS.find((standard) => standard.key === key)!;

  it("has all ten owner-approved tasks", () => {
    expect(LABOR_STANDARDS).toHaveLength(10);
    expect(LABOR_STANDARDS.map((standard) => standard.key)).toEqual([
      "art-setup", "print-setup", "cut-setup", "cutting", "weeding",
      "jar-application", "bag-4x5-application", "bag-14x16-application", "packout", "gloss-white-setup",
    ]);
  });

  it("pins the calculated unit costs at full precision (hourly / min speed)", () => {
    expect(byKey("art-setup").unitCost).toBe(25 / 3);
    expect(byKey("art-setup").unitCost).toBeCloseTo(8.333333, 5);
    expect(byKey("print-setup").unitCost).toBe(1);
    expect(byKey("weeding").unitCost).toBe(20 / 15);
    expect(byKey("weeding").unitCost).toBeCloseTo(1.333333, 5);
    expect(byKey("jar-application").unitCost).toBe(0.2);
    expect(byKey("bag-4x5-application").unitCost).toBe(20 / 180);
    expect(byKey("bag-4x5-application").unitCost).toBeCloseTo(0.111111, 5);
    expect(byKey("bag-14x16-application").unitCost).toBe(1);
    expect(byKey("packout").unitCost).toBe(2);
    expect(byKey("gloss-white-setup").unitCost).toBe(25 / 3);
  });

  it("cut setup is included at $0; cutting is machine-based with no hand-labor cost", () => {
    const cutSetup = byKey("cut-setup");
    expect(cutSetup.unitCost).toBe(0);
    expect(cutSetup.basis).toBe("included");
    expect(cutSetup.note).toContain("Included in art setup");

    const cutting = byKey("cutting");
    expect(cutting.kind).toBe("machine");
    expect(cutting.unitCost).toBeNull();
    expect(cutting.minSpeed).toContain("25 cm/s");
    expect(cutting.minSpeed).toContain("12.5 cm/s");
    expect(cutting.note).toContain("not hand labor");
    expect(cutting.note).toContain("not wired into the calculator");
  });

  it("gloss/white setup is labor only and says so", () => {
    expect(byKey("gloss-white-setup").note).toContain("ink usage profiles are NOT changed");
  });

  it("checklist rows serialize owner_standard confidence with the approved label", () => {
    const cells = checklistRowToCells({
      category: "Labor standard (owner-approved)", itemName: "Jar application", vendor: "",
      cost: 0.2, unit: "per jar/application", tierMinQty: null, tierMaxQty: null, moq: null,
      source: "Owner labor standards (13A.1)", confidence: "owner_standard", issue: "", verify: "", fixPage: "Cost Calculator",
    });
    expect(cells[9]).toBe(LABOR_STANDARD_CONFIDENCE_LABEL);
    expect(LABOR_STANDARD_CONFIDENCE_LABEL).toBe("Verified / Owner-approved standard");
  });
});

describe("labor wiring preview (13A.2)", () => {
  const scenarios = buildLaborWiringScenarios();
  const byId = (id: string) => scenarios.find((scenario) => scenario.id === id)!;

  it("mirrors the calculator's current hardcoded rules exactly", () => {
    expect(CURRENT_CALC_LABOR.laborRatePerHour).toBe(25);
    expect(CURRENT_CALC_LABOR.jarApplicationSeconds).toBe(10);
    expect(CURRENT_CALC_LABOR.bagApplicationSecondsPerSide).toBe(10);
    expect(CURRENT_CALC_LABOR.jarApplicationSetupMinutes).toBe(10);
    expect(CURRENT_CALC_LABOR.bagApplicationSetupMinutes).toBe(5);
    expect(CURRENT_CALC_LABOR.prepressBasicMinutes).toBe(15);
    expect(CURRENT_CALC_LABOR.glossWhiteSetup).toBe(0);
  });

  it("T1: 600 jars — owner application alone is 600 x $0.20 = $120.00", () => {
    const t1 = byId("T1");
    // current: (600*10s)/60 + 10 setup = 110 min + prepress 15 min = 125 min @ $25/hr
    expect(t1.currentLabor).toBeCloseTo((110 + 15) * (25 / 60), 4);
    expect(t1.currentLabor).toBeCloseTo(52.0833, 3);
    expect(t1.ownerLabor).toBeCloseTo(600 * 0.2 + (25 / 3 + 1), 4);
    expect(t1.ownerLabor).toBeCloseTo(129.3333, 3);
    expect(t1.diff).toBeCloseTo(77.25, 2);
    expect(t1.diffPct).toBeCloseTo(148.32, 1);
  });

  it("T3/T3b: 1,000 4x5 bags — front $111.11, front+back $222.22 application", () => {
    const t3 = byId("T3");
    expect(t3.ownerLabor).toBeCloseTo(1000 * (20 / 180) + (25 / 3 + 1), 4);
    expect(1000 * (20 / 180)).toBeCloseTo(111.1111, 3);
    const t3b = byId("T3b");
    expect(2000 * (20 / 180)).toBeCloseTo(222.2222, 3);
    expect(t3b.ownerLabor - t3.ownerLabor).toBeCloseTo(111.1111, 3);
  });

  it("T7: adds gloss/white setup labor the calculator charges nothing for today", () => {
    const t7 = byId("T7");
    expect(t7.currentLabor).toBeCloseTo(6.25, 4); // prepress only, gloss setup $0
    expect(t7.ownerLabor).toBeCloseTo(25 / 3 + 1 + 25 / 3, 4);
    expect(t7.whatChanged).toContain("ink usage profiles unchanged");
  });

  it("five rules are LIVE (13A.3); incomparable bases stay needs_wiring_review, never guessed", () => {
    const reviewTasks = LABOR_RULE_COMPARISONS.filter((rule) => rule.status === "needs_wiring_review").map((rule) => rule.task);
    expect(reviewTasks).toEqual(["Cutting", "Weeding", "Packout"]);
    const live = LABOR_RULE_COMPARISONS.filter((rule) => rule.status === "live");
    expect(live.length).toBe(5);
    expect(live.every((rule) => rule.note.includes("LIVE since 13A.3"))).toBe(true);
  });

  it("scenarios cover the required sample set", () => {
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["T1", "T2", "T3", "T3b", "T5", "T7"]);
    expect(scenarios.every((scenario) => Number.isFinite(scenario.diff) && Number.isFinite(scenario.diffPct))).toBe(true);
  });
});

describe("warning cleanup (13.2.5)", () => {
  it("single-tier flat note is informational wording, not the unexpected-tiers warning", () => {
    expect(SINGLE_TIER_FLAT_NOTE).toContain("informational only");
    expect(SINGLE_TIER_FLAT_NOTE).not.toContain("Unexpected");
  });

  it("verified DTP 4x5x2 evaluates already_correct in the approved tool (no unexpected-tier path exists there)", () => {
    const item = APPROVED_COST_TRUTH.find((entry) => entry.key === "dtp-4x5x2-pouch")!;
    const record = {
      id: "p1", name: "DTP 4x5x2 Blank Pouch", vendor: "Vendor TBD", vendorSku: "preset:dtp-4x5x2-pouch",
      defaultUnitCost: 0.7138, notes: "[VERIFIED 2026-07-17 owner-approved DTP 4x5x2 blank pouch table]",
      tiers: [
        { id: "t1", minQty: 1000, maxQty: 2499, unitCost: 0.7138 },
        { id: "t2", minQty: 2500, maxQty: 4999, unitCost: 0.4744 },
        { id: "t3", minQty: 5000, maxQty: 7499, unitCost: 0.4029 },
        { id: "t4", minQty: 7500, maxQty: 9999, unitCost: 0.3458 },
        { id: "t5", minQty: 10000, maxQty: null, unitCost: 0.3117 },
      ],
    };
    const { row } = evaluateApprovedItem(item, ctxWith({ vendorProducts: [record] as any }));
    expect(row.status).toBe("already_correct");
  });
});
