// Phase 15H.5 — runs / reprints / QC.
// Pins: A/R/P grammar + parsing, historical __A1 compatibility, run-aware
// RIP identity (strictness unchanged), run-aware actual grouping (no
// double-count), report-endpoint attempt semantics, board actions, and
// untouched neighboring systems. All against fakes — no live data.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN,
  applyRunSuffix,
  buildIntakeRipName,
  buildRunSuffix,
  parseRunIdentity,
} from "../app/lib/print-intake-routing.server";
import { parseRipTickets, resolveRipIdentity } from "../app/lib/rip-identity-match.server";
import { runBreakdownOf } from "../app/lib/actual-variance.server";

describe("15H.5 run identity grammar", () => {
  it("1+22+23. first normal run renders the historical __A1; absent tokens default R1/P0/A1", () => {
    expect(buildRunSuffix()).toBe("__A1");
    expect(buildIntakeRipName("GSO-20260812-0007", "roland", "GLOSS-3X", "art file.pdf")).toBe("GSO-20260812-0007__ROLAND__GLOSS-3X__ART-FILE__A1");
    expect(parseRunIdentity("GSO-20260811-0002__ROLAND__GLOSS-3X__NAME__A1")).toEqual(DEFAULT_RUN);
    expect(parseRunIdentity("GSO-20260811-0002__ROLAND__GLOSS-3X__NAME__A1.pdf")).toEqual(DEFAULT_RUN);
    expect(parseRunIdentity("bare-name-no-run.pdf")).toEqual(DEFAULT_RUN);
  });

  it("2+3+4. attempt/revision/reprint tokens are distinct and ordered R-P-A", () => {
    expect(buildRunSuffix({ attempt: 2 })).toBe("__A2");
    expect(buildRunSuffix({ revision: 2 })).toBe("__R2-A1");
    expect(buildRunSuffix({ reprint: 1 })).toBe("__P1-A1");
    expect(buildRunSuffix({ revision: 3, reprint: 2, attempt: 4 })).toBe("__R3-P2-A4");
    expect(parseRunIdentity("X__R3-P2-A4")).toEqual({ revision: 3, reprint: 2, attempt: 4 });
    expect(parseRunIdentity("X__P2-A1.pdf")).toEqual({ revision: 1, reprint: 2, attempt: 1 });
  });

  it("applyRunSuffix replaces an existing run segment without duplicating", () => {
    expect(applyRunSuffix("GSO-20260811-0002__ROLAND__GLOSS-3X__NAME__A1", { reprint: 1, attempt: 1 })).toBe("GSO-20260811-0002__ROLAND__GLOSS-3X__NAME__P1-A1");
    expect(applyRunSuffix("GSO-20260811-0002__ROLAND__GLOSS-3X__NAME__P1-A1", { reprint: 1, attempt: 2 })).toBe("GSO-20260811-0002__ROLAND__GLOSS-3X__NAME__P1-A2");
    expect(applyRunSuffix("BARE-TICKET-NAME", { revision: 2 })).toBe("BARE-TICKET-NAME__R2-A1");
  });

  it("12+13+M. strict RIP identity: decorated A/R/P names still lift the exact canonical tickets", async () => {
    expect(parseRipTickets("GSO-20260812-0005-01__ROLAND__GLOSS-3X__NAME__P2-A1.pdf")).toMatchObject({
      itemTicket: "GSO-20260812-0005-01",
      jobTicket: "GSO-20260812-0005",
    });
    expect(parseRipTickets("GSO-20260812-0005-01__R2-P1-A3")).toMatchObject({ itemTicket: "GSO-20260812-0005-01" });
    const db = {
      productionJobItem: { findMany: async ({ where }: any) => (where.itemTicket === "GSO-20260812-0005-01" ? [{ id: "i1", jobId: "j1" }] : []) },
      productionJob: { findMany: async () => [] },
    };
    const result = await resolveRipIdentity(db, "shop", { jobName: "GSO-20260812-0005-01__MIMAKI__CMYK__X__P2-A1" });
    expect(result).toMatchObject({ status: "matched", productionJobItemId: "i1", matchMethod: "exact_item_ticket" });
  });

  it("31+G. run-aware actual grouping sums to the same totals (no double-count)", () => {
    const entries = [
      { sourceJobName: "GSO-X-01__M__CMYK__N__A1", inkMl: 10, printMinutes: 5 },
      { sourceJobName: "GSO-X-01__M__CMYK__N__A1.pdf", inkMl: 2, printMinutes: 1 },
      { sourceJobName: "GSO-X-01__M__CMYK__N__P1-A1", inkMl: 7, printMinutes: 3 },
      { sourceJobName: "GSO-X-01 legacy bare name", inkMl: 4, printMinutes: 2 },
    ];
    const runs = runBreakdownOf(entries as any);
    expect(runs).toHaveLength(2); // base run (incl. legacy bare) + P1
    const base = runs.find((run) => run.runKey === "R1-P0-A1")!;
    const reprint = runs.find((run) => run.runKey === "R1-P1-A1")!;
    expect(base.rowCount).toBe(3);
    expect(base.inkMl).toBe(16);
    expect(reprint.inkMl).toBe(7);
    const groupedTotal = runs.reduce((sum, run) => sum + run.inkMl, 0);
    expect(groupedTotal).toBe(entries.reduce((sum, entry) => sum + entry.inkMl, 0)); // identical totals
  });

  it("5+6+7+8+14+19+20+21+E+K+L. board actions: same tickets, no new jobs, audited; report bumps A only on failure", () => {
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    // reprint: bumps P, resets A, retry_allowed, audited, reason required, NO job creation
    expect(board).toContain('intent === "reprintItem"');
    expect(board).toContain("reprintNumber: nextRun.reprint");
    expect(board).toContain("attemptNumber: 1");
    expect(board).toContain('status: "retry_allowed"');
    expect(board).toContain('"production_reprint_requested"');
    expect(board).toContain('"A reprint reason is required."');
    // revision: audit + guidance only (row binds when the corrected file arrives)
    expect(board).toContain('intent === "revisionItem"');
    expect(board).toContain('"production_revision_created"');
    // QC trio
    expect(board).toContain('intent === "qcItem"');
    expect(board).toContain('"production_run_qc_passed"');
    expect(board).toContain('"production_run_qc_hold"');
    expect(board).toContain('"production_run_qc_failed"');
    // none of the run actions create ProductionJobs
    const reprintBlock = board.slice(board.indexOf('intent === "reprintItem"'), board.indexOf('intent === "revisionItem"'));
    expect(reprintBlock.includes("productionJob.create")).toBe(false);
    // report endpoint: failed delivery bumps attempt exactly there
    const report = readFileSync("app/routes/api.print-intake.report.tsx", "utf8");
    expect(report).toContain("attemptNumber: row.attemptNumber + 1");
    expect(report).toContain('decision === "failed"');
  });

  it("9+10+11+F. reopen keeps completion/finalization history immutable", () => {
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    expect(board).toContain('intent === "reopenReprint"');
    expect(board).toContain('"production_job_reopened_for_reprint"');
    expect(board).toContain('data: { status: "reprint_needed" }');
    const reopenBlock = board.slice(board.indexOf('intent === "reopenReprint"'), board.indexOf('Unknown production action'));
    expect(reopenBlock.includes("actualCostFinalized: false")).toBe(false); // finalization never cleared
    expect(reopenBlock.includes("completedAt: null")).toBe(false); // completion history never erased
    expect(reopenBlock).toContain("finalized cost snapshot is immutable");
    // sold price untouched by reprint flows anywhere in the new actions
    const runActions = board.slice(board.indexOf("15H.5: runs / reprints / QC"), board.indexOf("Unknown production action"));
    expect(runActions.includes("unitPrice")).toBe(false);
  });

  it("15+16+17+18+I. QC results recorded as events — prior history never erased", () => {
    const board = readFileSync("app/routes/app.erp.production.tsx", "utf8");
    const qcBlock = board.slice(board.indexOf('intent === "qcItem"'), board.indexOf('intent === "reopenReprint"'));
    expect(qcBlock.includes("delete")).toBe(false);
    expect(qcBlock.includes("deleteMany")).toBe(false);
    expect(qcBlock).toContain('["pass", "reprint_required", "hold"]');
    expect(qcBlock).toContain("Prior history is preserved");
  });

  it("N+agent. pending-retries: one bounded call per pass; ledger stays the cache; fail closed offline", () => {
    const agent = readFileSync("tools/gso-print-intake-agent.ps1", "utf8");
    expect(agent).toContain("gso-print-intake-agent/1.7");
    expect(agent).toContain("pending = $true");
    expect(agent).toContain('"pending_retry"');
    expect(agent).toContain("retry_pending");
    const status = readFileSync("app/routes/api.print-intake.status.tsx", "utf8");
    expect(status).toContain("body.pending === true");
    expect(status).toContain('status: { in: ["retry_allowed", "assigned"] }');
    expect(status).toContain("take: 50");
  });

  it("route-plan: revision auto-detected for a NEW hash on an already-routed ticket; default runs keep bare names", () => {
    const plan = readFileSync("app/routes/api.print-intake.route-plan.tsx", "utf8");
    expect(plan).toContain("revision: prior.revisionNumber + 1");
    expect(plan).toContain("runIsDefault ? plan.ripName : applyRunSuffix");
    expect(plan).toContain("revisionNumber: run.revision");
  });

  it("24-30+32. neighbors untouched: intake review, routing, order convergence, manual, merge/link, pricing, actuals trust", () => {
    expect(readFileSync("app/lib/print-intake-review.server.ts", "utf8")).toContain("keep_blocked");
    expect(readFileSync("app/lib/print-intake-routing.server.ts", "utf8")).toContain('reasons: ["default_cmyk_to_mimaki"]');
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    expect(source).toContain("parseCanonicalOrderLine");
    expect(source).toContain("sourceKey = `manual_${requestId}`");
    expect(source).toContain("linkIntakeJobToTarget");
    expect(readFileSync("app/lib/commercial-pricing-policy.server.ts", "utf8")).toContain("BAGS_4X5_FRONT_LADDER");
    const matcher = readFileSync("app/lib/rip-identity-match.server.ts", "utf8");
    expect(matcher).toContain("ACTUALS_TRUSTED_CONFIDENCE");
    // grammar lives in ONE place: the retired local copy delegates
    expect(source).toContain("return buildIntakeRipName(ticket, machine, mode, originalFileName, attempt);");
  });
});
