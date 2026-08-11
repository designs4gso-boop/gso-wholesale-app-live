// Phase 15H.3 — intake review + retry: server-authoritative dispositions,
// reason codes, audit trail, owner assignment validation, matched-row reuse,
// agent reconciliation pins, and the three currently-blocked live files.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REVIEW_REASON_LABELS,
  appendIntakeAudit,
  canonicalReviewReason,
  dispositionOf,
  readIntakeMeta,
  reviewReasonLabel,
  validateIntakeAssignment,
} from "../app/lib/print-intake-review.server";
import { createOrReusePrintIntakeJob } from "../app/lib/production-job-source.server";
import { decideMachineFromFilename } from "../app/lib/print-intake-routing.server";

describe("15H.3 intake review + retry", () => {
  it("D. reason codes map from raw plan/report reasons and all carry labels", () => {
    expect(canonicalReviewReason(["conflicting_printer_tokens_in_filename"])).toBe("printer_token_conflict");
    expect(canonicalReviewReason(["premium_mode_but_mimaki_token_contradiction"])).toBe("premium_mode_mimaki_contradiction");
    expect(canonicalReviewReason(["not_an_artwork_file_type"])).toBe("unsupported_file_type");
    expect(canonicalReviewReason(["item_ticket_matches_multiple_items"])).toBe("ambiguous_candidates");
    expect(canonicalReviewReason(["item_ticket_GSO-20260101-0001-01_not_found_in_eligible_jobs"])).toBe("unknown_ticket");
    expect(canonicalReviewReason(["advisory_lock_failed: x"])).toBe("ticket_allocation_failed");
    expect(canonicalReviewReason(["ticket_allocation_exhausted: y"])).toBe("ticket_allocation_failed");
    expect(canonicalReviewReason(["Roland routing disabled in config (route_blocked)"])).toBe("hot_folder_unreachable");
    expect(canonicalReviewReason(["copy_length_mismatch"])).toBe("copy_verify_failed");
    expect(canonicalReviewReason(["no_deterministic_match", "machine_summary_contradictory_or_unknown"])).toBe("unknown_production_requirements");
    expect(canonicalReviewReason(["legacy_ledger_blocked"])).toBe("legacy_ledger_blocked");
    expect(canonicalReviewReason(["rejected_by_owner"])).toBe("rejected_by_owner");
    for (const code of Object.keys(REVIEW_REASON_LABELS)) {
      expect(reviewReasonLabel(code).length).toBeGreaterThan(5);
    }
  });

  it("B. disposition mapping: review/failed block, retry_allowed/assigned retry, routed/rejected terminal", () => {
    expect(dispositionOf(null)).toEqual({ disposition: "keep_blocked", retryAllowed: false });
    expect(dispositionOf({ status: "review" })).toEqual({ disposition: "keep_blocked", retryAllowed: false });
    expect(dispositionOf({ status: "failed" })).toEqual({ disposition: "keep_blocked", retryAllowed: false });
    expect(dispositionOf({ status: "retry_allowed" })).toEqual({ disposition: "retry_allowed", retryAllowed: true });
    expect(dispositionOf({ status: "assigned" })).toEqual({ disposition: "assigned", retryAllowed: true });
    expect(dispositionOf({ status: "routed" })).toEqual({ disposition: "already_routed", retryAllowed: false });
    expect(dispositionOf({ status: "rejected" })).toEqual({ disposition: "rejected", retryAllowed: false });
  });

  it("C. audit trail appends inside rawParsedHints JSON without losing hints (cap 30)", () => {
    const first = appendIntakeAudit(JSON.stringify({ hints: { mode: "GLOSS-3X" } }), { at: "t1", actor: "route-plan", action: "plan_reviewed" });
    const second = appendIntakeAudit(first, { at: "t2", actor: "admin:shop", action: "released_for_retry" });
    const meta = readIntakeMeta(second);
    expect(meta.hints.mode).toBe("GLOSS-3X");
    expect(meta.audit.map((entry: any) => entry.action)).toEqual(["plan_reviewed", "released_for_retry"]);
    const corrupt = appendIntakeAudit("not-json{{", { at: "t3", actor: "x", action: "y" });
    expect(readIntakeMeta(corrupt).audit).toHaveLength(1);
  });

  it("I. assignment validation: shop-scoped, active-only, finalized/completed refuse, multi-item requires item", () => {
    const job = (over: Partial<any> = {}) => ({
      id: "j1", shop: "shop.test", active: true, status: "new", actualCostFinalized: false, jobTicket: "GSO-20260812-0001",
      items: [{ id: "i1", itemTicket: "GSO-20260812-0001-01" }],
      ...over,
    });
    expect(validateIntakeAssignment({ shop: "shop.test", job: job() as any, itemId: null })).toMatchObject({ ok: true, item: { id: "i1" } });
    expect(validateIntakeAssignment({ shop: "other.shop", job: job() as any, itemId: null })).toMatchObject({ ok: false, reason: "Job not found." });
    expect(validateIntakeAssignment({ shop: "shop.test", job: job({ active: false }) as any, itemId: null }).ok).toBe(false);
    expect((validateIntakeAssignment({ shop: "shop.test", job: job({ actualCostFinalized: true }) as any, itemId: null }) as any).reason).toContain("FINALIZED");
    expect((validateIntakeAssignment({ shop: "shop.test", job: job({ status: "completed" }) as any, itemId: null }) as any).reason).toContain("completed");
    const multi = job({ items: [{ id: "i1", itemTicket: "T-01" }, { id: "i2", itemTicket: "T-02" }] });
    expect((validateIntakeAssignment({ shop: "shop.test", job: multi as any, itemId: null }) as any).reason).toContain("multiple items");
    expect(validateIntakeAssignment({ shop: "shop.test", job: multi as any, itemId: "i2" })).toMatchObject({ ok: true, item: { id: "i2" } });
    expect(validateIntakeAssignment({ shop: "shop.test", job: multi as any, itemId: "zz" }).ok).toBe(false);
  });

  it("K. matched-row reuse: matchedProductionJobId identity is honored — no duplicate job for the same hash", async () => {
    const matchedRow = {
      id: "pi1",
      generatedProductionJobId: null,
      matchedProductionJobId: "existing_job",
      authoritativeTicket: "GSO-20260812-0002-01",
      routedFilename: "GSO-20260812-0002-01",
    };
    const db = {
      printIntake: { findUnique: async () => matchedRow },
      $transaction: async () => { throw new Error("must not create a new job when a matched identity exists"); },
    };
    const result = await createOrReusePrintIntakeJob(db, {
      shop: "shop.test",
      fileName: "whatever.pdf",
      fileHash: "b".repeat(64),
      machine: "roland",
      machineRule: "white_or_gloss",
      mode: "GLOSS-3X",
    });
    expect(result).toMatchObject({ created: false, productionJobId: "existing_job", jobTicket: "GSO-20260812-0002-01" });
  });

  it("K2. generated pointer keeps working exactly as before", async () => {
    const generatedRow = { id: "pi2", generatedProductionJobId: "gen_job", matchedProductionJobId: null, authoritativeTicket: "GSO-20260812-0003", routedFilename: null };
    const db = { printIntake: { findUnique: async () => generatedRow }, $transaction: async () => { throw new Error("no new job"); } };
    const result = await createOrReusePrintIntakeJob(db, { shop: "s", fileName: "f.pdf", fileHash: "c".repeat(64), machine: "mimaki", machineRule: "default_cmyk", mode: "CMYK" });
    expect(result).toMatchObject({ created: false, productionJobId: "gen_job", jobTicket: "GSO-20260812-0003" });
  });

  it("M. the three blocked live files classify deterministically under current rules", () => {
    expect(decideMachineFromFilename("BUTTAWAY_bently_ROLAND.pdf")).toMatchObject({ machine: "roland", machineRule: "explicit_roland_tag", mode: "CMYK" });
    expect(decideMachineFromFilename("GSO PIPELINE TEST_3X SPOT GLOSS_Roland.pdf")).toMatchObject({ machine: "roland", machineRule: "white_or_gloss", mode: "GLOSS-3X" });
    expect(decideMachineFromFilename("GSO PIPELINE TEST 2_1X SPOT GLOSS_Roland.pdf")).toMatchObject({ machine: "roland", machineRule: "white_or_gloss", mode: "GLOSS-1X" });
  });

  it("G. agent reconciliation pins: routed skips locally; blocked hashes ask the server; fail closed offline", () => {
    const agent = readFileSync("tools/gso-print-intake-agent.ps1", "utf8");
    expect(agent).toContain('gso-print-intake-agent/1.6');
    expect(agent).toContain('/api/print-intake/status');
    expect(agent).toContain('$ledgerDecision -eq "routed" -or $ledgerDecision -eq "duplicate"');
    expect(agent).toContain("Get-IntakeDisposition");
    expect(agent).toContain('"disposition_unreachable"'); // fail closed
    expect(agent).toContain("disposition reconciliation skipped in dry run");
    expect(agent).toContain('Add-IntakeLedgerEntry $Config $hash $File.Name "rejected"');
  });

  it("H+N. status endpoint pins: token-auth, batch-capped, minimal payload, legacy row creation", () => {
    const status = readFileSync("app/routes/api.print-intake.status.tsx", "utf8");
    expect(status).toContain("printLogAutoImportSetting.findUnique({ where: { uploadToken: token } })");
    expect(status).toContain('"legacy_ledger_blocked"');
    expect(status).toContain(".slice(0, 50)");
    expect(status.includes("unitPrice")).toBe(false);
    expect(status.includes("costSnapshot")).toBe(false);
    const routes = readFileSync("app/routes.ts", "utf8");
    expect(routes).toContain('route("api/print-intake/status", "routes/api.print-intake.status.tsx")');
  });

  it("F+E+J. route-plan + UI pins: rejected short-circuit, assigned routing, review rows, confirm-gated reject", () => {
    const plan = readFileSync("app/routes/api.print-intake.route-plan.tsx", "utf8");
    expect(plan).toContain('existingIntake?.status === "rejected"');
    expect(plan).toContain('"assigned_by_owner"');
    expect(plan).toContain("recordReviewRow");
    expect(plan).toContain("decideMachine(assignedItem as any, fileName)"); // machine rules stay authoritative even for assignments
    const ui = readFileSync("app/routes/app.erp.print-intake.tsx", "utf8");
    expect(ui).toContain('intent === "release"');
    expect(ui).toContain('intent === "assign"');
    expect(ui).toContain('intent === "reject"');
    expect(ui).toContain('confirmReject');
    expect(ui).toContain("validateIntakeAssignment");
    expect(ui).toContain("never deleted");
    const report = readFileSync("app/routes/api.print-intake.report.tsx", "utf8");
    expect(report).toContain("canonicalReviewReason");
  });

  it("R. routing/ticket/RIP authorities untouched", () => {
    const routing = readFileSync("app/lib/print-intake-routing.server.ts", "utf8");
    expect(routing).toContain('return { machine: "mimaki", machineRule: "default_cmyk", reasons: ["default_cmyk_to_mimaki"] };');
    const source = readFileSync("app/lib/production-job-source.server.ts", "utf8");
    expect(source).toContain("allocateJobTicket");
    expect(source).toContain("GSO-${stamp}");
    const matcher = readFileSync("app/lib/rip-identity-match.server.ts", "utf8");
    expect(matcher).toContain("exact_item_ticket");
  });
});
