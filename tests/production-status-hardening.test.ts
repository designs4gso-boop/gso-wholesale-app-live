// Phase 5 — legacy manual production status path hardening (2026-10-04).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PRODUCTION_STATUS_OPTIONS, STAFF_PRODUCTION_STATUSES, isStaffProductionStatus, staffStatusLabel } from "../app/lib/production-status-vocabulary";
import { prismaTransitionDeps } from "../app/lib/ops/production-transition-executor.server";
import { PRODUCTION_STATUSES, evaluateTransition, normalizeStatus } from "../app/lib/ops/production-transitions";

const route = readFileSync(new URL("../app/routes/app.erp.production.tsx", import.meta.url), "utf8");

describe("staff production status vocabulary", () => {
  it("accepts only the canonical staff statuses and rejects arbitrary strings", () => {
    expect(PRODUCTION_STATUS_OPTIONS.length).toBe(17);
    for (const s of STAFF_PRODUCTION_STATUSES) expect(isStaffProductionStatus(s)).toBe(true);
    for (const bad of ["", "shipped; DROP TABLE", "Printing", "approved", "canceled", "done", null, 5, undefined]) expect(isStaffProductionStatus(bad as any), String(bad)).toBe(false);
    expect(staffStatusLabel("proof_approved")).toBe("Proof Approved");
    expect(staffStatusLabel("weird")).toBe("weird");
  });

  it("the changeStatus action validates against the vocabulary before any write and rejects with 400", () => {
    const block = route.slice(route.indexOf('if (intent === "changeStatus")'), route.indexOf('if (intent === "updateJob")'));
    expect(block.indexOf("isStaffProductionStatus(status)")).toBeGreaterThan(0);
    expect(block.indexOf("isStaffProductionStatus(status)")).toBeLessThan(block.indexOf("db.productionJob.findFirst"));
    expect(block).toMatch(/status: 400/);
    expect(block).not.toMatch(/\|\| "new"/); // no silent default any more
    expect(route).toMatch(/import \{ PRODUCTION_STATUS_OPTIONS, isStaffProductionStatus \} from "\.\.\/lib\/production-status-vocabulary"/);
  });

  it("no agent/runtime library imports the legacy production route; the executor is the only agent write path", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = new URL("../app/lib/ops/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/from ["'][^"']*routes\/app\.erp\.production/); // no import of the legacy route
      expect(src, f).not.toMatch(/intent === "changeStatus"|formData\.get\("status"\)/); // no re-implementation of the form handler
      if (f !== "production-transition-executor.server.ts") expect(src, f).not.toMatch(/productionJob\.update/);
    }
  });

  it("agent guard treats staff-only stages as unknown (fails closed) rather than inventing transitions", () => {
    for (const staffOnly of ["prepress", "proof_needed", "ready_to_print", "laminating", "packing", "ready_for_pickup"]) {
      expect(PRODUCTION_STATUSES as string[]).not.toContain(staffOnly);
      expect(normalizeStatus(staffOnly)).toBeNull();
      expect(evaluateTransition(staffOnly, "printing", { artApproved: true }).allowed).toBe(false);
      expect(evaluateTransition("proof_approved", staffOnly, { artApproved: true }).allowed).toBe(false);
    }
  });
});

describe("status-only moves never manufacture evidence for the agent guard", () => {
  const job = { id: "j", shop: "s", jobTicket: "T", status: "qc" };
  const mk = (row: any) => prismaTransitionDeps({ productionJob: { findFirst: async () => ({ proofStatus: "draft", proofApprovedAt: null, checklistItems: [], files: [], events: [], ...row }) } }, "s");

  it("status_change to proof_approved is not art approval", async () => {
    expect((await mk({ events: [{ eventType: "status_change", newValue: "proof_approved", createdAt: new Date() }] }).loadFacts(job, "printing")).artApproved).toBe(false);
  });
  it("status_change to qc / completed is not a QC pass", async () => {
    const f = await mk({ events: [{ eventType: "status_change", newValue: "qc", createdAt: new Date() }, { eventType: "status_change", newValue: "completed", createdAt: new Date() }] }).loadFacts(job, "completed");
    expect(f.qcPassRecorded).toBe(false);
    expect(evaluateTransition("qc", "completed", f).allowed).toBe(false);
    expect((await mk({ events: [{ eventType: "qc_result", newValue: "pass", createdAt: new Date() }] }).loadFacts(job, "completed")).qcPassRecorded).toBe(true);
    expect((await mk({ events: [{ eventType: "qc_result", newValue: "fail", createdAt: new Date() }] }).loadFacts(job, "completed")).qcPassRecorded).toBe(false);
  });
  it("status_change to shipped is not a shipping record", async () => {
    const f = await mk({ events: [{ eventType: "status_change", newValue: "shipped", createdAt: new Date() }] }).loadFacts({ ...job, status: "completed" }, "shipped");
    expect(f.shippingRecorded).toBe(false);
    expect(evaluateTransition("completed", "shipped", f).allowed).toBe(false);
    expect((await mk({ events: [{ eventType: "tracking_added", newValue: "1Z", createdAt: new Date() }] }).loadFacts(job, "shipped")).shippingRecorded).toBe(true);
  });
});
