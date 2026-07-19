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
    machineSummary: null,
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
    expect(decision.ripName).toBe("GSO-20260718-0001-01");
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
    expect(byName.ripName).toBe("GSO-20260718-0002-01"); // falls back to item ticket when ripJobName is unset
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

describe("machine routing (conservative v1)", () => {
  it("CMYK-only defaults to Mimaki per the documented rule; explicit Mimaki also routes", () => {
    expect(decideMachine(makeItem()).machine).toBe("mimaki");
    expect(decideMachine(makeItem({ machineSummary: "Mimaki UCJV300" })).machine).toBe("mimaki");
  });

  it("explicit Roland assignment returns the roland key (agent enforces enable-flag + folder)", () => {
    const decision = decideMachine(makeItem({ machineSummary: "Roland LG-540" }));
    expect(decision.machine).toBe("roland");
  });

  it("white/gloss work never auto-routes in v1 — review with the documented-rule reason", () => {
    expect(needsWhiteOrGloss(makeItem({ selectedFinish: "White + Gloss" }))).toBe(true);
    const decision = decideMachine(makeItem({ selectedFinish: "Spot Gloss" }));
    expect(decision.machine).toBeNull();
    expect(decision.reasons).toContain("white_or_gloss_required_review_only_in_v1");
    const routed = decideIntakeRoute({ fileName: "GSO-20260718-0001-01.pdf", jobs: [makeJob({ items: [makeItem({ selectedFinish: "White ink" })] })] });
    expect(routed.decision).toBe("review");
  });

  it("contradictory or unknown machine data reviews", () => {
    const decision = decideMachine(makeItem({ machineSummary: "Mimaki or Roland" }));
    expect(decision.machine).toBeNull();
    expect(decision.reasons).toContain("machine_summary_contradictory_or_unknown");
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
