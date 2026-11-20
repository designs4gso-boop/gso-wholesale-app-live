// 2026-11-18 — Mimaki gloss restored: focused regression tests for the SHARED
// press decider (`decideMachine` in app/lib/print-intake-routing.server.ts), used
// by production dispatch, manual job entry and order -> job creation.
//
// Owner rule (2026-11-18):
//   0. Primer requested                        -> no press, PRIMER_NOT_CONFIGURED
//   1. explicit ERP press (Mimaki / Roland)    -> that press (explicit_erp_machine), gloss included
//   2. standalone ROLAND / MIMAKI filename tag -> that press
//   3. nothing explicit, no white layer        -> Mimaki (default_cmyk), with or without gloss
//   4. nothing explicit, white layer           -> UNCHANGED: AUTO by complete load, else review
// Negated finishes ("No Spot Gloss", "No Gloss", "No UV", "No Varnish",
// "No Specialty") are not gloss. Contradictory data still reviews.
import { describe, expect, it } from "vitest";

import {
  PRIMER_NOT_CONFIGURED,
  decideMachine,
  decideMachineFromFilename,
  needsGloss,
  needsWhiteLayer,
  needsWhiteOrGloss,
  type IntakeItem,
} from "../app/lib/print-intake-routing.server";

// An item with NOTHING explicit: no ERP press, no finish, no material summary.
function item(overrides: Partial<IntakeItem> = {}): IntakeItem {
  return {
    id: "item1",
    itemTicket: "GSO-20261118-0001-01",
    ripJobName: "GSO-20261118-0001-01",
    suggestedFileName: "GSO-20261118-0001-01_LABEL_QTY100",
    productTitle: "Label",
    selectedFinish: null,
    materialSummary: null,
    machineSummary: null,
    ...overrides,
  };
}

// Same snapshot shape as tests/manual-job-creation.test.ts / tests/print-intake-routing.test.ts.
const load = (mimaki: number, roland: number, unattributed = 0) => ({
  source: "test",
  capturedAt: "2026-11-18T00:00:00Z",
  unattributedOpenItems: unattributed,
  byPrinter: { mimaki: { openItems: mimaki, estimatedMinutes: null }, roland: { openItems: roland, estimatedMinutes: null } },
});

const CMYK_DEFAULT = { machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] };
const GLOSS_DEFAULT = { machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_gloss_default_mimaki"] };
const AUTO_UNAVAILABLE = { machine: null, machineRule: null, reasons: ["auto_machine_load_unavailable_select_printer"] };

describe("(a) negated gloss wording is not gloss and takes the plain Mimaki default", () => {
  it.each([
    ["No Spot Gloss"],
    ["No Gloss"],
    ["No Specialty"],
    ["No Specialty — 0X"],
    ["Matte / No Spot Gloss"],
  ])("selectedFinish %j -> not gloss -> Mimaki cmyk_only_default_mimaki", (finish) => {
    const it_ = item({ selectedFinish: finish });
    expect(needsGloss(it_)).toBe(false);
    expect(needsWhiteOrGloss(it_)).toBe(false);
    expect(decideMachine(it_)).toEqual(CMYK_DEFAULT);
    // load data does not change a CMYK default, whichever press is busier
    expect(decideMachine(it_, "", load(9, 0))).toEqual(CMYK_DEFAULT);
    expect(decideMachine(it_, "", load(0, 9))).toEqual(CMYK_DEFAULT);
  });

  it("the same wording in the material summary is not gloss either", () => {
    for (const summary of ["Finish: No Spot Gloss", "Material: Matte | Specialty: No Specialty — 0X", "Matte | No UV | No Varnish"]) {
      const it_ = item({ selectedFinish: "Matte", materialSummary: summary });
      expect(needsGloss(it_), summary).toBe(false);
      expect(decideMachine(it_), summary).toEqual(CMYK_DEFAULT);
    }
  });

  it("a negation does not hide a real gloss request elsewhere on the item", () => {
    const it_ = item({ selectedFinish: "No Specialty", materialSummary: "Gloss Layers: 2X" });
    expect(needsGloss(it_)).toBe(true);
    expect(decideMachine(it_)).toEqual(GLOSS_DEFAULT);
  });
});

describe("(b) real gloss, nothing explicit -> Mimaki (gloss no longer forces the Roland)", () => {
  it.each([["Matte + 4X Spot Gloss"], ["GLOSS-3X"]])("selectedFinish %j -> gloss -> Mimaki cmyk_gloss_default_mimaki", (finish) => {
    const it_ = item({ selectedFinish: finish });
    expect(needsGloss(it_)).toBe(true);
    expect(needsWhiteLayer(it_)).toBe(false);
    expect(decideMachine(it_)).toEqual(GLOSS_DEFAULT);
    expect(decideMachine(it_, "", load(9, 0))).toEqual(GLOSS_DEFAULT); // a busy Mimaki does not move it to the Roland
  });

  it("the retired gloss rule strings are never produced", () => {
    const decision = decideMachine(item({ selectedFinish: "Spot Gloss" }));
    expect(decision.machine).not.toBe("roland");
    expect(decision.machineRule).not.toBe("gloss_requires_roland");
    expect(decision.reasons).not.toContain("gloss_requires_roland");
  });
});

describe("(c) + (d) an explicit ERP press wins, gloss included", () => {
  it("(c) explicit Roland + gloss -> Roland explicit_erp_machine", () => {
    expect(decideMachine(item({ selectedFinish: "Matte + 4X Spot Gloss", machineSummary: "Roland LG-640" }))).toEqual({
      machine: "roland",
      machineRule: "explicit_erp_machine",
      reasons: ["explicit_erp_roland_assignment"],
    });
  });

  it("(d) explicit Mimaki + gloss -> Mimaki explicit_erp_machine (no contradiction)", () => {
    const decision = decideMachine(item({ selectedFinish: "Matte + 4X Spot Gloss", machineSummary: "Mimaki UCJV300-130" }));
    expect(decision).toEqual({ machine: "mimaki", machineRule: "explicit_erp_machine", reasons: ["explicit_erp_mimaki_assignment"] });
    expect(decision.reasons).not.toContain("gloss_job_but_mimaki_selected_contradiction");
  });

  it("an explicit Roland still wins for plain CMYK (the Mimaki default never overrides an assignment)", () => {
    expect(decideMachine(item({ selectedFinish: "No Spot Gloss", machineSummary: "Roland LG-640" }))).toEqual({
      machine: "roland",
      machineRule: "explicit_erp_machine",
      reasons: ["explicit_erp_roland_assignment"],
    });
  });
});

describe("(e) standalone filename tags are explicit selections", () => {
  it("ROLAND tag -> Roland, with or without gloss", () => {
    expect(decideMachine(item({ selectedFinish: "No Spot Gloss" }), "GSO-20261118-0001-01_ROLAND.pdf")).toEqual({ machine: "roland", machineRule: "explicit_roland_tag", reasons: ["standalone_roland_tag_in_filename"] });
    expect(decideMachine(item({ selectedFinish: "GLOSS-3X" }), "GSO-20261118-0001-01_ROLAND.pdf")).toEqual({ machine: "roland", machineRule: "explicit_roland_tag", reasons: ["standalone_roland_tag_in_filename"] });
  });

  it("MIMAKI tag -> Mimaki, with or without gloss", () => {
    expect(decideMachine(item({ selectedFinish: "No Spot Gloss" }), "GSO-20261118-0001-01_MIMAKI.pdf")).toEqual({ machine: "mimaki", machineRule: "explicit_mimaki_tag", reasons: ["standalone_mimaki_tag_in_filename"] });
    expect(decideMachine(item({ selectedFinish: "GLOSS-3X" }), "GSO-20261118-0001-01_MIMAKI.pdf")).toEqual({ machine: "mimaki", machineRule: "explicit_mimaki_tag", reasons: ["standalone_mimaki_tag_in_filename"] });
  });

  it("decideMachineFromFilename: explicit token -> that press; no white -> Mimaki default", () => {
    expect(decideMachineFromFilename("Cust_labels_ROLAND.pdf")).toMatchObject({ machine: "roland", machineRule: "explicit_roland_tag", reasons: ["standalone_roland_tag_in_filename"] });
    expect(decideMachineFromFilename("Cust_labels_MIMAKI.pdf")).toMatchObject({ machine: "mimaki", machineRule: "explicit_mimaki_tag", reasons: ["standalone_mimaki_tag_in_filename"] });
    expect(decideMachineFromFilename("Cust_labels_matte.pdf")).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] });
    expect(decideMachineFromFilename("Cust_3x spot gloss_labels.pdf")).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_gloss_default_mimaki"] });
  });
});

describe("(f) contradictory data still reviews", () => {
  it("both printer tags in the filename -> review", () => {
    expect(decideMachine(item({ selectedFinish: "GLOSS-3X" }), "GSO-20261118-0001-01_ROLAND_MIMAKI.pdf")).toEqual({ machine: null, machineRule: null, reasons: ["conflicting_printer_tokens_in_filename"] });
    expect(decideMachine(item(), "GSO-20261118-0001-01_MIMAKI_ROLAND.pdf")).toEqual({ machine: null, machineRule: null, reasons: ["conflicting_printer_tokens_in_filename"] });
  });

  it("a filename tag that contradicts the ERP-assigned press -> review", () => {
    expect(decideMachine(item({ machineSummary: "Mimaki UCJV300-130" }), "GSO-20261118-0001-01_ROLAND.pdf")).toEqual({ machine: null, machineRule: null, reasons: ["roland_filename_tag_but_erp_assigned_mimaki_contradiction"] });
    expect(decideMachine(item({ selectedFinish: "GLOSS-3X", machineSummary: "Roland LG-640" }), "GSO-20261118-0001-01_MIMAKI.pdf")).toEqual({ machine: null, machineRule: null, reasons: ["mimaki_filename_tag_but_erp_assigned_roland_contradiction"] });
  });

  it("a machine summary naming both presses, or an unknown one -> review", () => {
    expect(decideMachine(item({ machineSummary: "Mimaki or Roland" }))).toEqual({ machine: null, machineRule: null, reasons: ["machine_summary_contradictory_or_unknown"] });
    expect(decideMachine(item({ selectedFinish: "GLOSS-3X", machineSummary: "HP Latex" }))).toEqual({ machine: null, machineRule: null, reasons: ["machine_summary_contradictory_or_unknown"] });
  });

  it("a tag that AGREES with the ERP press is not a contradiction", () => {
    expect(decideMachine(item({ selectedFinish: "GLOSS-3X", machineSummary: "Mimaki UCJV300-130" }), "GSO-20261118-0001-01_MIMAKI.pdf")).toEqual({ machine: "mimaki", machineRule: "explicit_erp_machine", reasons: ["explicit_erp_mimaki_assignment"] });
  });
});

// PIN UPDATED 2026-11-20 — owner rule supersedes the 2026-11-11 "the Mimaki prints White" correction: "Mimaki white is NOT re-approved." White + Mimaki is held with a clear reason; white with no press goes to the Roland and is never load-balanced onto the Mimaki.
// The (g) block pinned "WHITE is unchanged: nothing explicit -> AUTO by complete load, else review". Each test below keeps
// its inputs; only the expected result changed.
const WHITE_TO_ROLAND = { machine: "roland", machineRule: "white_requires_roland", reasons: ["white_requires_roland"] };
describe("(g) WHITE (updated 2026-11-20: Mimaki white not approved): nothing explicit -> the Roland, never load-balanced", () => {
  const whiteItems: Array<[string, Partial<IntakeItem>]> = [
    ["selectedFinish White + CMYK", { selectedFinish: "White + CMYK" }],
    ["materialSummary White Layers: 1X", { selectedFinish: "Matte", materialSummary: "Material: Holographic | Gloss Layers: 0X | White Layers: 1X" }],
  ];

  it.each(whiteItems)("%s: no load -> the Roland (was: no press, auto_machine_load_unavailable_select_printer)", (_label, overrides) => {
    const it_ = item(overrides);
    expect(needsWhiteLayer(it_)).toBe(true);
    expect(needsGloss(it_)).toBe(false);
    expect(decideMachine(it_)).toEqual(WHITE_TO_ROLAND);
    expect(decideMachine(it_, "", null)).toEqual(WHITE_TO_ROLAND);
  });

  it.each(whiteItems)("%s: complete load -> still the Roland, even when the Mimaki is less busy (was: auto_load_balanced)", (_label, overrides) => {
    const it_ = item(overrides);
    expect(decideMachine(it_, "", load(7, 1))).toEqual(WHITE_TO_ROLAND);
    expect(decideMachine(it_, "", load(1, 7))).toEqual(WHITE_TO_ROLAND); // was mimaki / auto_less_busy_mimaki_by_open_workload
  });

  it.each(whiteItems)("%s: incomplete or tied load -> the Roland (load is not consulted for white; was: review)", (_label, overrides) => {
    const it_ = item(overrides);
    expect(decideMachine(it_, "", load(0, 9, 1))).toEqual(WHITE_TO_ROLAND); // unattributed open items
    expect(decideMachine(it_, "", load(3, 3))).toEqual(WHITE_TO_ROLAND); // tie
  });

  it("white never takes the CMYK Mimaki default", () => {
    for (const [, overrides] of whiteItems) {
      const decision = decideMachine(item(overrides));
      expect(decision.machineRule).not.toBe("default_cmyk");
      expect(decision.machine).not.toBe("mimaki");
      expect(decision.machine).toBe("roland"); // 2026-11-20: was null (review)
    }
  });

  it("an explicit ROLAND still routes white; an explicit MIMAKI on white is held (2026-11-20; was: routed to the Mimaki)", () => {
    expect(decideMachine(item({ selectedFinish: "White + CMYK", machineSummary: "Mimaki UCJV300-130" }))).toEqual({ machine: null, machineRule: null, reasons: ["white_job_but_mimaki_selected_contradiction"] });
    expect(decideMachine(item({ selectedFinish: "White + CMYK", machineSummary: "Roland LG-640" }))).toEqual({ machine: "roland", machineRule: "explicit_erp_machine", reasons: ["explicit_erp_roland_assignment"] });
  });

  it("decideMachineFromFilename: white layers go to the Roland (was: AUTO by load, else review)", () => {
    expect(decideMachineFromFilename("Cust_2x white_labels.pdf")).toMatchObject(WHITE_TO_ROLAND);
    expect(decideMachineFromFilename("Cust_2x white_labels.pdf", load(7, 1))).toMatchObject(WHITE_TO_ROLAND);
    expect(decideMachineFromFilename("Cust_2x white_labels.pdf", load(1, 7))).toMatchObject(WHITE_TO_ROLAND);
  });
});

describe("(h) Primer is still not configured on any press", () => {
  it("Primer -> no press, PRIMER_NOT_CONFIGURED — never the new Mimaki default", () => {
    expect(PRIMER_NOT_CONFIGURED).toBe("PRIMER_NOT_CONFIGURED");
    expect(decideMachine(item({ selectedFinish: "Primer + CMYK" }))).toEqual({ machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] });
    expect(decideMachine(item({ selectedFinish: "Primer + Gloss" }))).toEqual({ machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] });
    expect(decideMachine(item({ materialSummary: "Finish: primer" }), "", load(0, 5))).toEqual({ machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] });
  });

  it("an explicit press or a filename tag cannot route Primer work", () => {
    expect(decideMachine(item({ selectedFinish: "Primer", machineSummary: "Mimaki UCJV300-130" }))).toEqual({ machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] });
    expect(decideMachine(item({ selectedFinish: "Primer", machineSummary: "Roland LG-640" }))).toEqual({ machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] });
    expect(decideMachine(item({ selectedFinish: "Primer" }), "GSO-20261118-0001-01_MIMAKI.pdf")).toEqual({ machine: null, machineRule: null, reasons: [PRIMER_NOT_CONFIGURED] });
  });
});

describe("(i) a stated zero is not a requirement", () => {
  it("'Gloss Layers: 0X' in a summary is not gloss -> plain Mimaki default", () => {
    const it_ = item({ selectedFinish: "Matte", materialSummary: "Material: Matte | Gloss Layers: 0X | White Layers: 0X" });
    expect(needsGloss(it_)).toBe(false);
    expect(needsWhiteOrGloss(it_)).toBe(false);
    expect(needsWhiteLayer(it_)).toBe(false);
    expect(decideMachine(it_)).toEqual(CMYK_DEFAULT);
  });

  it("'Gloss Layers: 2X' IS gloss -> Mimaki gloss default", () => {
    const it_ = item({ selectedFinish: "Matte", materialSummary: "Material: Matte | Gloss Layers: 2X | White Layers: 0X" });
    expect(needsGloss(it_)).toBe(true);
    expect(decideMachine(it_)).toEqual(GLOSS_DEFAULT);
  });
});
