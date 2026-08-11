// Phase 15H.2 — strict shared RIP identity matcher.
// Reproduces the silent Mimaki defect (item-ticket routed names searched only
// against job tickets), pins the deterministic match order, ambiguity
// handling, structured reasons, actuals confidence policy, and the
// no-laundering rule for stored fallback attributions.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTUALS_TRUSTED_CONFIDENCE,
  assessEntryIdentityTrust,
  parseRipTickets,
  resolveRipIdentity,
} from "../app/lib/rip-identity-match.server";
import { matchMethodAllowsActuals } from "../app/lib/rip-capture.server";
import { attributeEntryToItem } from "../app/lib/rip-duration.server";
import { matchMethodOf } from "../app/lib/actual-variance.server";

type FakeItem = { id: string; jobId: string; itemTicket: string | null; ripJobName: string | null; suggestedFileName: string | null };
type FakeJob = { id: string; jobTicket: string | null };

function fakeDb(jobs: FakeJob[], items: FakeItem[]) {
  return {
    productionJobItem: {
      findMany: async ({ where, take }: any) => {
        let hits: FakeItem[] = [];
        if (where.itemTicket) hits = items.filter((item) => item.itemTicket === where.itemTicket);
        else if (where.ripJobName?.in) hits = items.filter((item) => item.ripJobName && where.ripJobName.in.includes(item.ripJobName));
        else if (where.OR) hits = items.filter((item) => item.ripJobName || item.suggestedFileName);
        return (take ? hits.slice(0, take) : hits).map((item) => ({ ...item }));
      },
    },
    productionJob: {
      findMany: async ({ where, take }: any) => {
        const hits = jobs.filter((job) => job.jobTicket === where.jobTicket);
        return (take ? hits.slice(0, take) : hits).map((job) => ({ id: job.id }));
      },
    },
  };
}

const QUOTE_ORDER_WORLD = {
  jobs: [{ id: "job1", jobTicket: "GSO-20260809-0001" }],
  items: [
    { id: "item1", jobId: "job1", itemTicket: "GSO-20260809-0001-01", ripJobName: "GSO-20260809-0001-01", suggestedFileName: "GSO-20260809-0001-01_RITZ_MATTE_QTY100" },
    { id: "item2", jobId: "job1", itemTicket: "GSO-20260809-0001-02", ripJobName: "GSO-20260809-0001-02", suggestedFileName: null },
  ],
};

describe("15H.2 shared strict RIP identity matcher", () => {
  it("17. MIMAKI REGRESSION: an item-ticket routed name now matches job + item (was silently unmatched)", async () => {
    const db = fakeDb(QUOTE_ORDER_WORLD.jobs, QUOTE_ORDER_WORLD.items);
    // Exactly the defect scenario: quote/order jobs route files as the bare
    // item ticket; the old RasterLink path searched ProductionJob.jobTicket
    // for "GSO-20260809-0001-01", found nothing, and imported unmatched with
    // no flag. The shared resolver resolves the ITEM first.
    const result = await resolveRipIdentity(db, "shop", { jobName: "GSO-20260809-0001-01" });
    expect(result).toMatchObject({
      status: "matched",
      productionJobId: "job1",
      productionJobItemId: "item1",
      matchMethod: "exact_item_ticket",
    });
  });

  it("1+4+5+6. item tickets resolve exactly with .pdf / __MIMAKI__ / __ROLAND__ decorations", async () => {
    const db = fakeDb(QUOTE_ORDER_WORLD.jobs, QUOTE_ORDER_WORLD.items);
    for (const name of [
      "GSO-20260809-0001-01.pdf",
      "GSO-20260809-0001-01__MIMAKI__CMYK__RITZ__A1",
      "GSO-20260809-0001-01__ROLAND__GLOSS-3X__RITZ__A1.pdf",
      "GSO-20260809-0001-01_Customer_Product_FRONT",
    ]) {
      const result = await resolveRipIdentity(db, "shop", { jobName: name });
      expect(result.status, name).toBe("matched");
      expect(result.productionJobItemId, name).toBe("item1");
      expect(result.matchMethod, name).toBe("exact_item_ticket");
    }
  });

  it("2. exact ripJobName resolves job + item", async () => {
    const items = [{ id: "itemR", jobId: "jobR", itemTicket: null, ripJobName: "SPECIAL-RIP-NAME-77", suggestedFileName: null }];
    const db = fakeDb([{ id: "jobR", jobTicket: "GSO-20260810-0002" }], items);
    const result = await resolveRipIdentity(db, "shop", { jobName: "SPECIAL-RIP-NAME-77" });
    expect(result).toMatchObject({ status: "matched", productionJobId: "jobR", productionJobItemId: "itemR", matchMethod: "exact_rip_job_name" });
  });

  it("3. exact job ticket resolves the job with item left null (attribution stays a labeled separate step)", async () => {
    const db = fakeDb(QUOTE_ORDER_WORLD.jobs, []);
    const result = await resolveRipIdentity(db, "shop", { jobName: "GSO-20260809-0001__ROLAND__CMYK__FILE__A1" });
    expect(result).toMatchObject({ status: "matched", productionJobId: "job1", productionJobItemId: null, matchMethod: "exact_job_ticket" });
  });

  it("7+8. unknown tickets stay unmatched with structured reasons", async () => {
    const db = fakeDb([], []);
    const unknownItem = await resolveRipIdentity(db, "shop", { jobName: "GSO-20260809-0009-01.pdf" });
    expect(unknownItem.status).toBe("unmatched");
    expect(unknownItem.reasons).toContain("unknown_item_ticket:GSO-20260809-0009-01");
    expect(unknownItem.reasons).toContain("unknown_job_ticket:GSO-20260809-0009");
    const noTicket = await resolveRipIdentity(db, "shop", { jobName: "random-artwork-file.pdf" });
    expect(noTicket.status).toBe("unmatched");
    expect(noTicket.reasons).toContain("no_ticket_identity");
  });

  it("9+10. duplicate candidates are AMBIGUOUS — never first-match-wins", async () => {
    const twoItems = [
      { id: "a", jobId: "jobA", itemTicket: "GSO-20260809-0003-01", ripJobName: null, suggestedFileName: null },
      { id: "b", jobId: "jobB", itemTicket: "GSO-20260809-0003-01", ripJobName: null, suggestedFileName: null },
    ];
    const itemResult = await resolveRipIdentity(fakeDb([], twoItems), "shop", { jobName: "GSO-20260809-0003-01" });
    expect(itemResult.status).toBe("ambiguous");
    expect(itemResult.productionJobId).toBeNull();
    expect(itemResult.reasons[0]).toContain("ambiguous_item_ticket:GSO-20260809-0003-01");

    const twoJobs = [
      { id: "j1", jobTicket: "GSO-20260809-0004" },
      { id: "j2", jobTicket: "GSO-20260809-0004" },
    ];
    const jobResult = await resolveRipIdentity(fakeDb(twoJobs, []), "shop", { jobName: "GSO-20260809-0004" });
    expect(jobResult.status).toBe("ambiguous");
    expect(jobResult.productionJobId).toBeNull();
    expect(jobResult.reasons[0]).toContain("ambiguous_job_ticket:GSO-20260809-0004");
  });

  it("11+12. substring/contains candidates NEVER auto-link", async () => {
    // Job ticket GSO-20260809-0001 exists; the name carries a LONGER unknown
    // ticket that merely CONTAINS it — old contains-matchers attached it.
    const db = fakeDb([{ id: "job1", jobTicket: "GSO-20260809-0001" }], [
      { id: "item1", jobId: "job1", itemTicket: "GSO-20260809-0001-01", ripJobName: "GSO-20260809-0001-01", suggestedFileName: null },
    ]);
    const result = await resolveRipIdentity(db, "shop", { jobName: "GSO-20260809-0001-77.pdf" });
    // -77 is a canonical-shaped item ticket that does not exist; its parent
    // job DOES exist — deterministic job-level fallback attaches the job but
    // never the wrong item, and the unknown item ticket is recorded.
    expect(result.productionJobItemId).toBeNull();
    expect(result.reasons).toContain("unknown_item_ticket:GSO-20260809-0001-77");
    // A ripJobName that merely contains a stored name never matches:
    const partial = await resolveRipIdentity(fakeDb([], [{ id: "x", jobId: "j", itemTicket: null, ripJobName: "NAME", suggestedFileName: null }]), "shop", { jobName: "MY-NAME-EXTENDED" });
    expect(partial.status).toBe("unmatched");
  });

  it("parse: canonical tickets lift exactly from decorated names; noncanonical GSO tokens never authorize", () => {
    expect(parseRipTickets("GSO-20260809-0001-01__MIMAKI__CMYK__X__A1")).toMatchObject({ itemTicket: "GSO-20260809-0001-01", jobTicket: "GSO-20260809-0001" });
    expect(parseRipTickets("plain-file.pdf")).toMatchObject({ itemTicket: null, jobTicket: null });
    const legacy = parseRipTickets("GSO-TEST-ALPHA_file");
    expect(legacy.itemTicket).toBeNull();
    expect(legacy.jobTicket).toBeNull();
    expect(legacy.noncanonicalTicket).toContain("GSO-TEST");
  });

  it("13+14+15. actuals policy: exact_* and manual allowed; suggestions/ambiguous/unmatched blocked", () => {
    for (const allowed of ["exact_item_ticket", "exact_rip_job_name", "exact_job_ticket", "exact_stored_filename", "manual_owner_assignment"]) {
      expect(ACTUALS_TRUSTED_CONFIDENCE.has(allowed), allowed).toBe(true);
      expect(matchMethodAllowsActuals(allowed), allowed).toBe(true);
    }
    for (const blocked of ["suggestion_only", "ambiguous", "unmatched", "PROBABLE_METADATA", "single_item_fallback", "item_fallback"]) {
      expect(ACTUALS_TRUSTED_CONFIDENCE.has(blocked), blocked).toBe(false);
      expect(matchMethodAllowsActuals(blocked), blocked).toBe(false);
    }
    // Legacy capture methods that were always genuinely exact stay allowed.
    expect(matchMethodAllowsActuals("EXACT_TICKET")).toBe(true);
    expect(matchMethodAllowsActuals("MANUAL")).toBe(true);
  });

  it("16. a persisted single_item_fallback attribution can never launder into exact", () => {
    const job = { id: "job1", jobTicket: "GSO-20260809-0001", items: [{ id: "only", itemTicket: null, ripJobName: null, suggestedFileName: null, productTitle: "X" }], fileNames: [] } as any;
    const entry = {
      productionJobItemId: "only",
      jobTicket: null,
      sourceJobName: "mystery.pdf",
      rawRow: JSON.stringify({ itemAttributionBackfill: { method: "single_item_fallback", confidence: "fallback" } }),
    };
    const attribution = attributeEntryToItem(entry, job);
    expect(attribution.confidence).toBe("fallback");
    expect(attribution.method).toBe("single_item_fallback");
    expect(matchMethodOf(entry as any, job)).toBe("item_fallback");
    // Without the fallback marker a stored id still reads as exact (import-
    // time exact matches and manual assignments).
    const clean = attributeEntryToItem({ ...entry, rawRow: null }, job);
    expect(clean.confidence).toBe("exact");
  });

  it("writeback trust re-verifies identity instead of believing stored labels", () => {
    const job = {
      jobTicket: "GSO-20260809-0001",
      items: [{ id: "i1", itemTicket: "GSO-20260809-0001-01", ripJobName: "GSO-20260809-0001-01", suggestedFileName: "GSO-20260809-0001-01_RITZ" }],
    };
    expect(assessEntryIdentityTrust({ jobTicket: "GSO-20260809-0001", sourceJobName: "x" }, job).trusted).toBe(true);
    expect(assessEntryIdentityTrust({ jobTicket: "GSO-20260809-0001-01", sourceJobName: "x" }, job).basis).toBe("exact_item_ticket");
    expect(assessEntryIdentityTrust({ jobTicket: null, sourceJobName: "GSO-20260809-0001-01.pdf" }, job).basis).toBe("exact_rip_job_name");
    expect(assessEntryIdentityTrust({ jobTicket: null, sourceJobName: "zzz-unrelated" }, job)).toMatchObject({ trusted: false, basis: "untrusted" });
    expect(
      assessEntryIdentityTrust({ jobTicket: null, sourceJobName: "zzz", rawRow: JSON.stringify({ rematchAudit: [{ at: "t" }] }) }, job).basis,
    ).toBe("manual_owner_assignment");
  });

  it("18. Roland parity: structured routed names and exact normalized names keep matching", async () => {
    const intakeItems = [{ id: "ri", jobId: "rj", itemTicket: "GSO-20260811-0007-01", ripJobName: "GSO-20260811-0007__ROLAND__GLOSS-3X__FILE__A1", suggestedFileName: "GSO-20260811-0007__ROLAND__GLOSS-3X__FILE__A1" }];
    const db = fakeDb([{ id: "rj", jobTicket: "GSO-20260811-0007" }], intakeItems);
    // CSV echoes the routed name (with or without extension)
    const byName = await resolveRipIdentity(db, "shop", { jobName: "GSO-20260811-0007__ROLAND__GLOSS-3X__FILE__A1.pdf" });
    expect(byName.status).toBe("matched");
    expect(byName.productionJobId).toBe("rj");
    // Case-drifted CSV name still matches via normalized equality
    const drifted = await resolveRipIdentity(db, "shop", { jobName: "gso-20260811-0007__roland__gloss-3x__file__a1" }, { ripNameIndex: intakeItems });
    expect(drifted.status).toBe("matched");
    expect(drifted.matchMethod).toBe("exact_rip_job_name");
  });

  it("19+20. no machine-routing or pricing files were touched by 15H.2", () => {
    const routing = readFileSync("app/lib/print-intake-routing.server.ts", "utf8");
    expect(routing).toContain('return { machine: "mimaki", machineRule: "default_cmyk", reasons: ["default_cmyk_to_mimaki"] };');
    expect(routing).toContain('return { machine: "roland", machineRule: "white_or_gloss", mode: hints.mode, reasons: ["white_or_gloss_requires_roland"] };');
    const policy = readFileSync("app/lib/commercial-pricing-policy.server.ts", "utf8");
    expect(policy).toContain("BAGS_4X5_FRONT_LADDER");
    // loose matchers are gone from automatic linking
    const printLogs = readFileSync("app/lib/print-logs.server.ts", "utf8");
    expect(printLogs.includes("{ contains: ticket }")).toBe(false);
    expect(printLogs.includes("PROBABLE_METADATA")).toBe(false);
    expect(printLogs).toContain("resolveRipIdentity");
    const upload = readFileSync("app/routes/api.rip-imports.upload.tsx", "utf8");
    expect(upload).toContain("resolveRipIdentity");
    expect(upload.includes("decideMatch(")).toBe(false);
    const manual = readFileSync("app/routes/app.erp.rip-imports.tsx", "utf8");
    expect(manual).toContain("resolveRipIdentity");
  });
});
