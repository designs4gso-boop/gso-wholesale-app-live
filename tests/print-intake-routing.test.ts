import { describe, expect, it } from "vitest";

import {
  INTAKE_OUTCOMES_MARKER,
  MAX_INTAKE_OUTCOMES,
  basenameOf,
  decideIntakeRoute,
  decideMachine,
  decodeIntakeOutcomes,
  eligibleJobsWhere,
  encodeIntakeOutcomes,
  extractItemTicketFrom,
  extractJobTicketFrom,
  hasRolandFilenameTag,
  needsGloss,
  needsWhiteOrGloss,
  normalizeFileIdentity,
  ripFileBaseName,
  type IntakeItem,
  type IntakeJob,
  type IntakeOutcome,
} from "../app/lib/print-intake-routing.server";

function makeItem(overrides: Partial<IntakeItem> = {}): IntakeItem {
  return {
    id: "item1",
    itemTicket: "GSO-20260718-0001-01",
    ripJobName: "GSO-20260718-0001-01",
    suggestedFileName: "GSO-20260718-0001-01_JAR_MATTE_QTY40",
    productTitle: "Jar label",
    selectedFinish: "Matte",
    materialSummary: "Matte vinyl",
    // 2026-11-11: converted quotes carry the press they were costed on; an
    // unassigned CMYK item would review unless machine load is complete.
    machineSummary: "Mimaki UCJV300-130",
    ...overrides,
  };
}

function makeJob(overrides: Partial<IntakeJob> = {}): IntakeJob {
  return {
    id: "job1",
    jobTicket: "GSO-20260718-0001",
    customerName: "Cust",
    company: "Cust Co",
    status: "new",
    artworkUrl: null,
    printFileUrl: null,
    items: [makeItem()],
    fileNames: [],
    ...overrides,
  };
}

describe("ticket extraction and identity", () => {
  it("recognizes item and job tickets, underscore-tolerant, and tells them apart", () => {
    expect(extractItemTicketFrom("GSO-20260718-0001-01_Jar_FRONT.pdf")).toBe("GSO-20260718-0001-01");
    expect(extractItemTicketFrom("GSO_20260718_0001_01.pdf")).toBe("GSO-20260718-0001-01");
    expect(extractItemTicketFrom("GSO-20260718-0001_Jar.pdf")).toBe("");
    expect(extractJobTicketFrom("GSO-20260718-0001_Jar.pdf")).toBe("GSO-20260718-0001");
    expect(extractJobTicketFrom("no ticket here.pdf")).toBe("");
  });

  it("basenameOf strips any path segments — local paths never survive", () => {
    expect(basenameOf("C:\\Users\\staff\\Desktop\\art.pdf")).toBe("art.pdf");
    expect(basenameOf("//nas/share/sub/My File.pdf")).toBe("My File.pdf");
    expect(normalizeFileIdentity("My Job FILE.PDF")).toBe(normalizeFileIdentity("my_job file.pdf"));
  });
});

describe("deterministic mapping hierarchy", () => {
  it("(a) exact unique item ticket routes to that item", () => {
    const decision = decideIntakeRoute({ fileName: "GSO-20260718-0001-01_Jar_FRONT.pdf", jobs: [makeJob()] });
    expect(decision.decision).toBe("route");
    expect(decision.rule).toBe("item_ticket");
    expect(decision.itemId).toBe("item1");
    expect(decision.ripName).toBe("GSO-20260718-0001-01__Jar_FRONT"); // 2026-11-19 (O2): item ticket + the staff file name
  });

  it("(a) duplicate item tickets across jobs route nothing — candidates listed", () => {
    const twin = makeJob({ id: "job2", items: [makeItem({ id: "item2" })] });
    const decision = decideIntakeRoute({ fileName: "GSO-20260718-0001-01.pdf", jobs: [makeJob(), twin] });
    expect(decision.decision).toBe("review");
    expect(decision.reasons).toContain("item_ticket_matches_multiple_items");
    expect(decision.candidates.length).toBe(2);
  });

  it("(b) job ticket routes only when the job has exactly one eligible item", () => {
    const single = decideIntakeRoute({ fileName: "GSO-20260718-0001 front art.pdf", jobs: [makeJob()] });
    expect(single.decision).toBe("route");
    expect(single.rule).toBe("job_ticket_single_item");

    const multi = makeJob({ items: [makeItem(), makeItem({ id: "item2", itemTicket: "GSO-20260718-0001-02" })] });
    const decision = decideIntakeRoute({ fileName: "GSO-20260718-0001 art.pdf", jobs: [multi] });
    expect(decision.decision).toBe("review");
    expect(decision.reasons).toContain("job_ticket_matches_job_with_multiple_items_pick_item_in_review");
    expect(decision.candidates.length).toBe(2);
  });

  it("(b) two jobs sharing a ticket route nothing", () => {
    const decision = decideIntakeRoute({ fileName: "GSO-20260718-0001.pdf", jobs: [makeJob(), makeJob({ id: "job2" })] });
    expect(decision.decision).toBe("review");
    expect(decision.reasons).toContain("job_ticket_matches_multiple_jobs");
  });

  it("(c) exact stored filename match routes without a ticket in the name", () => {
    const decision = decideIntakeRoute({ fileName: "GSO-20260718-0001-01_JAR_MATTE_QTY40.pdf", jobs: [makeJob()] });
    // item-ticket tier catches this name first — so test a pure suggested name:
    const namedItem = makeItem({ itemTicket: "GSO-20260718-0002-01", ripJobName: null, suggestedFileName: "Front Label Cookies v3" });
    const namedJob = makeJob({ id: "job3", jobTicket: "GSO-20260718-0002", items: [namedItem] });
    const byName = decideIntakeRoute({ fileName: "front label cookies V3.PDF", jobs: [namedJob] });
    expect(decision.decision).toBe("route");
    expect(byName.decision).toBe("route");
    expect(byName.rule).toBe("stored_filename");
    expect(byName.ripName).toBe("GSO-20260718-0002-01__front_label_cookies_V3"); // 2026-11-19 (O2): item ticket + the staff file name; // falls back to item ticket when ripJobName is unset
  });

  it("(d) exact ProductionJobFile name match routes single-item jobs only", () => {
    const job = makeJob({ jobTicket: "GSO-20260718-0003", items: [makeItem({ itemTicket: "GSO-20260718-0003-01", ripJobName: "GSO-20260718-0003-01" })], fileNames: ["customer artwork FINAL.pdf"] });
    const decision = decideIntakeRoute({ fileName: "Customer Artwork Final.pdf", jobs: [job] });
    expect(decision.decision).toBe("route");
    expect(decision.rule).toBe("job_file_name");
  });

  it("(e) job subfolder identity routes a single-item job", () => {
    const decision = decideIntakeRoute({
      fileName: "final art.pdf",
      subfolder: "GSO-20260718-0001 - CUST-CO - JAR-LABEL",
      jobs: [makeJob()],
    });
    expect(decision.decision).toBe("route");
    expect(decision.rule).toBe("job_subfolder");
  });

  it("(f) no deterministic signal reviews; non-artwork extensions review", () => {
    expect(decideIntakeRoute({ fileName: "mystery.pdf", jobs: [makeJob()] }).decision).toBe("review");
    expect(decideIntakeRoute({ fileName: "GSO-20260718-0001.xlsx", jobs: [makeJob()] }).reasons).toContain("not_an_artwork_file_type");
  });

  it("contains is never used: a ticket-like prefix inside a longer foreign name does not route by name tiers", () => {
    const namedItem = makeItem({ itemTicket: "GSO-20260718-0004-01", ripJobName: null, suggestedFileName: "banner" });
    const job = makeJob({ id: "job4", jobTicket: "GSO-20260718-0004", items: [namedItem] });
    const decision = decideIntakeRoute({ fileName: "banner-v2-final.pdf", jobs: [job] });
    expect(decision.decision).toBe("review"); // "banner" !== "banner-v2-final" — equality only
  });
});

// updated 2026-11-18: Mimaki gloss restored — gloss no longer forces the Roland in the shared decideMachine.
describe("machine routing (owner rules, corrected 2026-11-11; updated 2026-11-18: Mimaki gloss restored)", () => {
  const unassigned = (o: Partial<IntakeItem> = {}) => makeItem({ machineSummary: null, ...o });
  const load = (m: number, r: number, unattributed = 0) => ({ source: "test", capturedAt: "t", unattributedOpenItems: unattributed, byPrinter: { mimaki: { openItems: m, estimatedMinutes: null }, roland: { openItems: r, estimatedMinutes: null } } });

  it("rule 1 (updated 2026-11-18: Mimaki gloss restored): untagged GLOSS routes to the Mimaki (default_cmyk / cmyk_gloss_default_mimaki); White alone does not force a press", () => {
    expect(needsWhiteOrGloss(makeItem({ selectedFinish: "White + Gloss" }))).toBe(true);
    expect(needsGloss(makeItem({ selectedFinish: "White ink" }))).toBe(false);
    const decision = decideMachine(unassigned({ selectedFinish: "Spot Gloss" }));
    expect(decision.machine).toBe("mimaki");
    expect(decision.machineRule).toBe("default_cmyk");
    expect(decision.reasons).toEqual(["cmyk_gloss_default_mimaki"]);
    // PIN UPDATED 2026-11-20 — owner rule supersedes the 2026-11-11 "the Mimaki prints White" correction: "Mimaki white is NOT re-approved." White + Mimaki is held with a clear reason; white with no press goes to the Roland and is never load-balanced onto the Mimaki.
    // (was: "white on an explicitly assigned Mimaki is a valid route now" -> mimaki / explicit_erp_machine)
    const mimakiWhite = decideMachine(makeItem({ selectedFinish: "White ink", machineSummary: "Mimaki UCJV300" }));
    expect(mimakiWhite).toEqual({ machine: null, machineRule: null, reasons: ["white_job_but_mimaki_selected_contradiction"] });
    // Roland white is unchanged
    expect(decideMachine(makeItem({ selectedFinish: "White ink", machineSummary: "Roland LG-640" }))).toMatchObject({ machine: "roland", machineRule: "explicit_erp_machine" });
  });

  it("the previously-reviewed case routes: GSO-20260627-0002-01_TEST.pdf on a white + gloss job -> Roland", () => {
    const item = unassigned({ id: "wg1", itemTicket: "GSO-20260627-0002-01", ripJobName: "GSO-20260627-0002-01", selectedFinish: "White + Gloss" });
    const job = makeJob({ id: "jobwg", jobTicket: "GSO-20260627-0002", items: [item] });
    const decision = decideIntakeRoute({ fileName: "GSO-20260627-0002-01_TEST.pdf", jobs: [job] });
    expect(decision.decision).toBe("route");
    expect(decision.machine).toBe("roland");
    expect(decision.machineRule).toBe("white_requires_roland"); // 2026-11-18: the WHITE sends it to the Roland; gloss no longer decides the press for Print Intake
    expect(decision.rule).toBe("item_ticket"); // exact item-ticket matching intact
    expect(decision.ripName).toBe("GSO-20260627-0002-01__TEST"); // 2026-11-19 (O2): the typed ticket is not repeated
  });

  it("rule 2: explicit ERP assignment wins for CMYK and White (explicit_erp_machine)", () => {
    const decision = decideMachine(makeItem({ machineSummary: "Roland LG-540" }));
    expect(decision.machine).toBe("roland");
    expect(decision.machineRule).toBe("explicit_erp_machine");
  });

  it("rule 3: standalone ROLAND / MIMAKI filename tags are explicit selections, case-insensitive", () => {
    expect(hasRolandFilenameTag("GSO-20260718-0001-01_roland_R1.pdf")).toBe(true);
    expect(hasRolandFilenameTag("art ROLAND final.pdf")).toBe(true);
    expect(hasRolandFilenameTag("Rolando-poster.pdf")).toBe(false); // never a substring of another word
    expect(hasRolandFilenameTag("unrolandish.pdf")).toBe(false);
    const decision = decideIntakeRoute({ fileName: "GSO-20260718-0001-01_ROLAND.pdf", jobs: [makeJob({ items: [unassigned()] })] });
    expect(decision.decision).toBe("route");
    expect(decision.machine).toBe("roland");
    expect(decision.machineRule).toBe("explicit_roland_tag");
    // PIN UPDATED 2026-11-20 — owner rule supersedes the 2026-11-11 "the Mimaki prints White" correction: "Mimaki white is NOT re-approved." White + Mimaki is held with a clear reason; white with no press goes to the Roland and is never load-balanced onto the Mimaki.
    // (was: a MIMAKI tag on a White ink item -> mimaki / explicit_mimaki_tag)
    const mimaki = decideMachine(unassigned({ selectedFinish: "White ink" }), "GSO-20260718-0001-01_MIMAKI.pdf");
    expect(mimaki).toEqual({ machine: null, machineRule: null, reasons: ["white_job_but_mimaki_selected_contradiction"] });
    expect(decideMachine(unassigned(), "GSO-20260718-0001-01_MIMAKI.pdf")).toMatchObject({ machine: "mimaki", machineRule: "explicit_mimaki_tag" }); // the tag itself still works for CMYK
  });

  it("rule 4 (updated 2026-11-18: Mimaki gloss restored): unassigned, untagged CMYK defaults to the Mimaki; unassigned WHITE still uses AUTO with COMPLETE load only", () => {
    // CMYK (no white layer): Mimaki default — load is not consulted, whatever it says
    const noLoad = decideMachine(unassigned());
    expect(noLoad.machine).toBe("mimaki");
    expect(noLoad.machineRule).toBe("default_cmyk");
    expect(noLoad.reasons).toEqual(["cmyk_only_default_mimaki"]);
    expect(decideMachine(unassigned(), "", load(0, 9, 1))).toEqual({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] });
    expect(decideMachine(unassigned(), "", load(3, 3))).toEqual({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] });
    expect(decideMachine(unassigned(), "", load(1, 4))).toEqual({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] });
    expect(decideMachine(unassigned(), "", load(9, 0))).toEqual({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] });
    // PIN UPDATED 2026-11-20 — owner rule supersedes the 2026-11-11 "the Mimaki prints White" correction: "Mimaki white is NOT re-approved." White + Mimaki is held with a clear reason; white with no press goes to the Roland and is never load-balanced onto the Mimaki.
    // (was: WHITE = AUTO by complete load, else review; load(1, 4) put white on the Mimaki)
    const white = () => unassigned({ selectedFinish: "White ink" });
    const toRoland = { machine: "roland", machineRule: "white_requires_roland", reasons: ["white_requires_roland"] };
    expect(decideMachine(white())).toEqual(toRoland);
    expect(decideMachine(white(), "", load(0, 9, 1))).toEqual(toRoland);
    expect(decideMachine(white(), "", load(3, 3))).toEqual(toRoland);
    expect(decideMachine(white(), "", load(6, 2))).toEqual(toRoland);
    expect(decideMachine(white(), "", load(1, 4))).toEqual(toRoland); // the less busy Mimaki never takes white
    // Patch B (2026-11-18): PRINT INTAKE never load-balances — an unassigned, untagged CMYK file
    // routes to the Mimaki with or without load data (the shared decideMachine above now agrees for CMYK).
    const routed = decideIntakeRoute({ fileName: "GSO-20260718-0001-01.pdf", jobs: [makeJob({ items: [unassigned()] })] });
    expect(routed).toMatchObject({ decision: "route", machine: "mimaki", machineRule: "default_cmyk" });
    const routedWithLoad = decideIntakeRoute({ fileName: "GSO-20260718-0001-01.pdf", jobs: [makeJob({ items: [unassigned()] })], machineLoad: load(0, 2) });
    expect(routedWithLoad).toMatchObject({ decision: "route", machine: "mimaki", machineRule: "default_cmyk" });
    const busyMimaki = decideIntakeRoute({ fileName: "GSO-20260718-0001-01.pdf", jobs: [makeJob({ items: [unassigned()] })], machineLoad: load(9, 0) });
    expect(busyMimaki).toMatchObject({ decision: "route", machine: "mimaki", machineRule: "default_cmyk" }); // load is ignored
  });

  it("contradictory data still reviews: ROLAND tag vs explicit Mimaki, both-printer summaries — gloss on an explicit Mimaki is NOT a contradiction any more (updated 2026-11-18: Mimaki gloss restored)", () => {
    const glossMimaki = decideMachine(makeItem({ selectedFinish: "Spot gloss", machineSummary: "Mimaki UCJV300" }));
    expect(glossMimaki.machine).toBe("mimaki");
    expect(glossMimaki.machineRule).toBe("explicit_erp_machine");
    expect(glossMimaki.reasons).toEqual(["explicit_erp_mimaki_assignment"]);
    expect(glossMimaki.reasons).not.toContain("gloss_job_but_mimaki_selected_contradiction");

    const tagMimaki = decideMachine(makeItem({ machineSummary: "Mimaki UCJV300" }), "GSO-20260718-0001-01_ROLAND.pdf");
    expect(tagMimaki.machine).toBeNull();
    expect(tagMimaki.reasons).toContain("roland_filename_tag_but_erp_assigned_mimaki_contradiction");

    const both = decideMachine(makeItem({ machineSummary: "Mimaki or Roland" }));
    expect(both.machine).toBeNull();
    expect(both.reasons).toContain("machine_summary_contradictory_or_unknown");

    // 2026-11-18: for PRINT INTAKE gloss on the Mimaki is valid again (and, since the same day, for the shared decideMachine above too);
    // WHITE with an explicit Mimaki is still the contradiction that reviews.
    const glossOnMimaki = decideIntakeRoute({ fileName: "GSO-20260718-0001-01.pdf", jobs: [makeJob({ items: [makeItem({ selectedFinish: "Gloss", machineSummary: "Mimaki UCJV300" })] })] });
    expect(glossOnMimaki).toMatchObject({ decision: "route", machine: "mimaki", machineRule: "explicit_erp_machine" });
    const reviewed = decideIntakeRoute({ fileName: "GSO-20260718-0001-01.pdf", jobs: [makeJob({ items: [makeItem({ selectedFinish: "White ink", machineSummary: "Mimaki UCJV300" })] })] });
    expect(reviewed.decision).toBe("review");
    expect(reviewed.machineRule).toBeNull();
  });
});

describe("RIP name generation", () => {
  it("prefers stored ripJobName, sanitizes unsafe characters, never empty for routable items", () => {
    expect(ripFileBaseName(makeItem())).toBe("GSO-20260718-0001-01");
    expect(ripFileBaseName(makeItem({ ripJobName: "GSO 1/bad:name" }))).toBe("GSO_1_bad_name");
    expect(ripFileBaseName(makeItem({ ripJobName: null, suggestedFileName: null }))).toBe("GSO-20260718-0001-01");
  });

  it("an item with no name sources at all reviews instead of routing blind", () => {
    const bare = makeItem({ ripJobName: null, suggestedFileName: null, itemTicket: null });
    const job = makeJob({ items: [bare] });
    const decision = decideIntakeRoute({ fileName: "GSO-20260718-0001 art.pdf", jobs: [job] });
    expect(decision.decision).toBe("review");
    expect(decision.reasons.some((reason) => reason.includes("no_rip_name"))).toBe(true);
  });
});

describe("rolling outcomes codec (no schema)", () => {
  const outcome = (n: number, decision: IntakeOutcome["decision"] = "routed"): IntakeOutcome => ({
    at: `2026-07-18T00:00:0${n % 10}.000Z`, fileName: `file${n}.pdf`, decision, rule: "item_ticket",
    reason: null, jobTicket: "GSO-20260718-0001", itemTicket: null, ripName: "GSO-20260718-0001-01",
    machine: "mimaki", fileHash8: `hash${n}`,
  });

  it("appends newest-first, preserves foreign operator notes verbatim, caps the history", () => {
    let notes: string | null = "operator wrote this by hand";
    for (let index = 0; index < MAX_INTAKE_OUTCOMES + 10; index += 1) notes = encodeIntakeOutcomes(notes, outcome(index));
    const { outcomes, foreignText } = decodeIntakeOutcomes(notes);
    expect(foreignText).toBe("operator wrote this by hand");
    expect(outcomes).toHaveLength(MAX_INTAKE_OUTCOMES);
    expect(outcomes[0].fileName).toBe(`file${MAX_INTAKE_OUTCOMES + 9}.pdf`);
    expect(notes).toContain(INTAKE_OUTCOMES_MARKER);
  });

  it("re-reporting the identical head outcome is idempotent (agent restart safety)", () => {
    const first = encodeIntakeOutcomes(null, outcome(1));
    const second = encodeIntakeOutcomes(first, outcome(1));
    expect(second).toBe(first);
    expect(decodeIntakeOutcomes(second).outcomes).toHaveLength(1);
    // a different decision for the same file DOES append:
    const third = encodeIntakeOutcomes(second, outcome(1, "needs_review"));
    expect(decodeIntakeOutcomes(third).outcomes).toHaveLength(2);
  });

  it("outcomes never carry local paths — file names are basenames by construction", () => {
    expect(basenameOf("\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today\\sub\\art.pdf")).toBe("art.pdf");
  });
});

describe("shop scoping", () => {
  it("candidate queries always embed the shop and active flag", () => {
    expect(eligibleJobsWhere("shop-a.myshopify.com")).toEqual({ shop: "shop-a.myshopify.com", active: true });
    expect(eligibleJobsWhere("shop-a.myshopify.com")).not.toEqual(eligibleJobsWhere("shop-b.myshopify.com"));
  });
});
