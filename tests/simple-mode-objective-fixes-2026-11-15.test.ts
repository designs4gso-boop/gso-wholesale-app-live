// 2026-11-15 — SIMPLE MODE objective fixes (no redesign).
//
//   1. Raw backend codes ("[shopify] … (ready_to_print)", "manual") shown to
//      employees are replaced with staff words. Backend values are unchanged.
//   2. CHANGE STATUS on a Shipped / Picked Up job silently pre-selected "New".
//   3. Linking an intake job succeeded and then showed "This job was not found".
//   4. Staff notes dropped off the Notes tab after 20 newer history events.
//   5. Links / tiles that always answered "owner only" for the viewer are hidden.
//   6. The owner-access banner and the unassigned card no longer show server
//      setting names to staff; the access checks themselves are unchanged.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", s: null as any }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const full = (job: any) => ({ ...job, items: (h.s.items[job.id] || []).map((i: any) => ({ ...i })), files: [], checklistItems: [], materialUsages: [], inventoryMovements: [], events: h.s.events.filter((e: any) => e.jobId === job.id).sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 20) });
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      h.s.calls.push(`${name}.${method}`);
      if (name === "productionJob") {
        if (method === "findMany") return h.s.jobs.filter((j: any) => j.active).map(full);
        if (method === "findFirst") { const j = h.s.jobs.find((x: any) => x.id === args.where?.id); return j ? full(j) : null; }
        if (method === "count") return 0;
      }
      if (name === "productionJobEvent" && method === "findMany") {
        const w = args.where || {};
        return h.s.events
          .filter((e: any) => (!w.jobId || e.jobId === w.jobId) && (!w.eventType?.in || w.eventType.in.includes(e.eventType)) && (!w.newValue || e.newValue === w.newValue))
          .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args.take || 1000);
      }
      if (name === "printIntake" && method === "findMany") return h.s.intakes;
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});

import { JOB_SOURCE_LABELS, PRODUCTION_STATUS_OPTIONS, jobSourceLabel, staffStatusLabel } from "../app/lib/production-status-vocabulary";
import { navForRole } from "../app/lib/simple-nav";

const ROLES = { owner: "77055393857", manager: "1001", sales: "1002", print_operator: "1003", bagger: "1004", authorized_manager: "1005", unassigned: "9999" } as const;
type Role = keyof typeof ROLES;
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: ROLES.owner, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger,1005:manager", GSO_MANAGER_AUTHORIZED_USER_IDS: "1005" };
const T = (minute: number) => new Date(Date.UTC(2026, 10, 15, 12, minute, 0));

const SRC = {
  workspace: readFileSync("app/routes/app.erp.production-job.$id.tsx", "utf8"),
  production: readFileSync("app/routes/app.erp.production.tsx", "utf8"),
  home: readFileSync("app/routes/app._index.tsx", "utf8"),
  shell: readFileSync("app/routes/app.tsx", "utf8"),
};

let workspace: any, shell: any, home: any;
beforeAll(async () => {
  workspace = await import("../app/routes/app.erp.production-job.$id");
  shell = await import("../app/routes/app");
  home = await import("../app/routes/app._index");
}, 240_000);
beforeEach(() => {
  Object.assign(process.env, ENV);
  h.sub = ROLES.owner;
  h.s = {
    jobs: [
      { id: "j1", shop: "shop-1", jobTicket: "GSO-20261115-0003", status: "ready_to_print", active: true, quoteId: "shopify_order_1", orderGid: "gid://shopify/Order/1", quoteNumber: "#1042", customerName: "Jane Buyer", company: "", priority: "normal", dueDate: null },
      { id: "j2", shop: "shop-1", jobTicket: "GSO-20261115-0004", status: "proof_sent", active: true, quoteId: "manual_abcdef12", orderGid: null, quoteNumber: "MANUAL-ABCDEF12", customerName: "", company: "Walk-in Co", priority: "normal", dueDate: null },
      { id: "j3", shop: "shop-1", jobTicket: "GSO-20261115-0005", status: "prepress", active: true, quoteId: null, orderGid: null, quoteNumber: null, customerName: "", company: "", priority: "normal", dueDate: null },
    ],
    items: { j1: [{ id: "i1", jobId: "j1", productTitle: "Sticker bags", quantity: 500 }], j2: [{ id: "i2", jobId: "j2", productTitle: "Labels", quantity: 100 }], j3: [{ id: "i3", jobId: "j3", productTitle: "art.pdf", quantity: 1 }] },
    events: [] as any[], intakes: [{ id: "pi1", shop: "shop-1", generatedProductionJobId: "j3", matchedProductionJobId: null }], calls: [] as string[],
  };
});
afterEach(() => { for (const key of [...Object.keys(ENV), "GSO_OWNER_ENFORCEMENT"]) delete process.env[key]; });

const openJob = async (role: Role, id: string) => {
  h.sub = ROLES[role];
  const res: Response = await workspace.loader({ request: new Request(`https://app.test/app/erp/production-job/${id}`), params: { id } });
  return res.json();
};

describe("1. staff words instead of raw backend codes", () => {
  it("every production status has a friendly label, and none of them is the raw code", () => {
    expect(staffStatusLabel("ready_to_print")).toBe("Ready to Print");
    expect(staffStatusLabel("proof_sent")).toBe("Proof Sent");
    expect(staffStatusLabel("proof_approved")).toBe("Proof Approved");
    expect(staffStatusLabel("ready_for_pickup")).toBe("Ready for Pickup");
    expect(staffStatusLabel("reprint_needed")).toBe("Reprint Needed");
    for (const option of PRODUCTION_STATUS_OPTIONS) {
      expect(staffStatusLabel(option.value)).toBe(option.label);
      expect(option.label).not.toMatch(/_/);
    }
    // backend values are untouched
    expect(PRODUCTION_STATUS_OPTIONS.map((o) => o.value)).toEqual(["new", "prepress", "proof_needed", "proof_sent", "proof_approved", "ready_to_print", "printing", "cutting", "laminating", "qc", "packing", "ready_for_pickup", "shipped", "picked_up", "completed", "on_hold", "reprint_needed", "cancelled"]);
  });

  it("a job's source is shown in words", () => {
    expect(JOB_SOURCE_LABELS).toEqual({ shopify: "Shopify order", quote: "Quote", manual: "Manual job", intake: "Print file (not linked yet)", other: "Other" });
    expect(jobSourceLabel("shopify")).toBe("Shopify order");
    expect(jobSourceLabel("MANUAL")).toBe("Manual job");
    expect(jobSourceLabel("something_new")).toBe("Other");
    expect(jobSourceLabel(null)).toBe("—");
    expect(SRC.workspace).toContain('<Fact label="Source" value={jobSourceLabel(job.sourceType)} />');
    expect(SRC.workspace).not.toContain('value={String(job.sourceType || "—")}');
  });

  it("the 'which job does it belong to?' list reads in staff words — no [shopify], no (ready_to_print), no MANUAL-id, no database id", async () => {
    const data = await openJob("print_operator", "j3");
    expect(data.job.linkEligible).toBe(true);
    const labels: string[] = data.linkTargets.map((target: any) => target.label);
    expect(labels).toEqual(["Shopify order: GSO-20261115-0003 · #1042 · Jane Buyer · Ready to Print", "Manual job: GSO-20261115-0004 · Walk-in Co · Proof Sent"]);
    for (const label of labels) expect(label).not.toMatch(/\[|\]|ready_to_print|proof_sent|MANUAL-|\bj[12]\b|_/);
    expect(SRC.production).not.toContain("`[${job.sourceType}]");
  }, 120_000);
});

describe("2. CHANGE STATUS never pre-selects a different status than the job has", () => {
  it("a Shipped / Picked Up job gets an empty 'Choose a status' choice and the list is required", () => {
    expect(SRC.workspace).toContain('const STATUS_CHOICES = PRODUCTION_STATUS_OPTIONS.filter((option) => !["shipped", "picked_up"].includes(option.value));');
    expect(SRC.workspace).toContain('defaultValue={STATUS_CHOICES.some((option) => option.value === String(job.status || "new")) ? String(job.status || "new") : ""} required style={input}>');
    expect(SRC.workspace).toContain('{STATUS_CHOICES.some((option) => option.value === String(job.status || "new")) ? null : <option value="" disabled>Choose a status</option>}');
    expect(SRC.workspace).not.toContain('<select name="status" defaultValue={String(job.status || "new")} style={input}>');
  });

  it("the status and priority lists re-sync after a save (keyed on the saved value), so an old value is never posted back", () => {
    expect(SRC.workspace).toContain('<select name="status" key={String(job.status || "new")}');
    expect(SRC.workspace).toContain('<select name="priority" key={String(job.priority || "normal")} defaultValue={String(job.priority || "normal")} style={input}>');
  });
});

describe("3. linking an intake job no longer lands on 'This job was not found'", () => {
  it("the one reload after a successful link is skipped; every other action still reloads", () => {
    const form = (intent: string) => { const data = new FormData(); data.set("intent", intent); return data; };
    expect(workspace.shouldRevalidate({ formData: form("linkJobToTarget"), actionResult: { ok: true }, defaultShouldRevalidate: true })).toBe(false);
    expect(workspace.shouldRevalidate({ formData: form("linkJobToTarget"), actionResult: { ok: false }, defaultShouldRevalidate: true })).toBe(true);
    expect(workspace.shouldRevalidate({ formData: form("changeStatus"), actionResult: { ok: true }, defaultShouldRevalidate: true })).toBe(true);
    expect(workspace.shouldRevalidate({ formData: form("addNote"), actionResult: { ok: true }, defaultShouldRevalidate: true })).toBe(true);
    expect(workspace.shouldRevalidate({ defaultShouldRevalidate: true })).toBe(true);
    expect(workspace.shouldRevalidate({ defaultShouldRevalidate: false })).toBe(false);
  });

  it("after a successful link the page opens the job it was linked into (or the board)", () => {
    expect(SRC.workspace).toContain("navigate(targetId ? jobWorkspaceHref(targetId) : SIMPLE_BOARD_HREF);");
    expect(SRC.workspace).toContain('<select name="linkTarget" defaultValue="" required style={input} onChange={(event) => setChosen(event.currentTarget.value)}>');
  });
});

describe("4. staff notes stay on the job page however long the history gets", () => {
  const busyJob = () => {
    h.s.jobs[0].status = "on_hold";
    h.s.events.push({ id: "n1", jobId: "j1", eventType: "note", message: "Customer wants matte, not gloss", createdAt: T(0) });
    h.s.events.push({ id: "hold1", jobId: "j1", eventType: "status_change", oldValue: "printing", newValue: "on_hold", message: "Status changed from Printing to On Hold.", createdAt: T(1) });
    h.s.events.push({ id: "n2", jobId: "j1", eventType: "note", message: "Owner note: charge $45.00 rush", createdAt: T(2) });
    for (let i = 0; i < 30; i += 1) h.s.events.push({ id: `c${i}`, jobId: "j1", eventType: "checklist_updated", message: "Checklist item marked complete.", createdAt: T(10 + i) });
    h.s.events.push({ id: "other", jobId: "j2", eventType: "note", message: "A note on a different job", createdAt: T(50) });
  };

  it("an old note and the hold record are still sent after 30 newer events (they used to be cut off at 20)", async () => {
    busyJob();
    const data = await openJob("owner", "j1");
    const notes = data.job.events.filter((e: any) => e.eventType === "note").map((e: any) => e.message);
    expect(notes).toContain("Customer wants matte, not gloss");
    expect(notes).toContain("Owner note: charge $45.00 rush");
    expect(notes).not.toContain("A note on a different job");
    expect(data.job.events.some((e: any) => e.id === "hold1")).toBe(true);
    expect(new Set(data.job.events.map((e: any) => e.id)).size).toBe(data.job.events.length); // nothing listed twice
  }, 120_000);

  it("a note that mentions money is masked for production staff, exactly like every other history line", async () => {
    busyJob();
    const data = await openJob("bagger", "j1");
    const notes = data.job.events.filter((e: any) => e.eventType === "note").map((e: any) => e.message);
    expect(notes).toContain("Customer wants matte, not gloss");
    expect(notes).toContain("(financial detail — owner only)");
    expect(JSON.stringify(data)).not.toContain("$45.00");
  }, 120_000);

  it("recent notes are not duplicated when they are already among the newest events", async () => {
    h.s.events.push({ id: "n1", jobId: "j1", eventType: "note", message: "Only note", createdAt: T(0) });
    const data = await openJob("manager", "j1");
    expect(data.job.events.filter((e: any) => e.eventType === "note")).toHaveLength(1);
  }, 120_000);
});

describe("5. no link or tile that always answers 'owner only' for the viewer", () => {
  const hrefs = (role: string, viewFinancials = false) => navForRole(role, { viewFinancials }).flatMap((section) => [section.href, ...section.links.map((link) => link.href)]);

  it("Leads to Review is offered only to those the lead queue admits (owner, financially authorized manager)", () => {
    expect(hrefs("owner")).toContain("/app/erp/agent-review-queue");
    expect(hrefs("manager", true)).toContain("/app/erp/agent-review-queue");
    expect(hrefs("manager", false)).not.toContain("/app/erp/agent-review-queue");
    expect(hrefs("sales")).not.toContain("/app/erp/agent-review-queue");
    for (const role of ["print_operator", "bagger", "unassigned"]) expect(hrefs(role)).not.toContain("/app/erp/agent-review-queue");
    // the queue itself is unchanged: still financial-access only on the server
    const queue = readFileSync("app/routes/app.erp.agent-review-queue.tsx", "utf8");
    expect(queue.match(/requireFinancialAccess\(financialAuth\);/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("Sales keeps Quotes and still has no way into Production; production roles keep their areas", () => {
    expect(hrefs("sales")).toContain("/app/quotes");
    for (const href of hrefs("sales")) expect(href).not.toMatch(/^\/app\/erp\/production/);
    for (const role of ["owner", "manager", "print_operator", "bagger"]) expect(hrefs(role)).toContain("/app/erp/production-board");
    expect(hrefs("unassigned")).toEqual(["/app"]);
  });

  it("Home tiles for a financial-only page are shown only to viewers who can open it", () => {
    expect(SRC.home).toContain('sales: ["quotesToWork", "quotesAwaitingPayment"],');
    expect(SRC.home).toContain('const FINANCIAL_PAGE_TILES = ["reviewNeedsStaff", "reviewReadyToQuote", "ripUnresolved"];');
    expect(SRC.home).toContain("const canOpenFinancialPages = isOwner || Boolean(data.viewFinancials);");
    expect(SRC.home).toContain(".filter((tile) => canOpenFinancialPages || !FINANCIAL_PAGE_TILES.includes(tile.key));");
    for (const file of ["app.erp.agent-review-queue", "app.erp.rip-import-review"]) expect(readFileSync(`app/routes/${file}.tsx`, "utf8")).toContain("requireFinancialAccess(financialAuth);");
  });

  it("the Open production jobs tile counts what its label says: not completed, shipped, picked up or cancelled", () => {
    expect(SRC.home).toContain('status: { notIn: ["completed", "shipped", "picked_up", "cancelled"] } } }),');
    expect(SRC.home).not.toContain('status: { notIn: ["completed", "shipped", "cancelled"] } } }),');
  });
});

describe("6. setup diagnostics are for the owner; staff get a plain line", () => {
  const shellData = async (role: Role) => { h.sub = ROLES[role]; return shell.loader({ request: new Request("https://app.test/app") }); };

  it("with owner access configured nobody gets a banner at all", async () => {
    for (const role of Object.keys(ROLES) as Role[]) expect((await shellData(role)).ownerAccessNotice, role).toBeNull();
  }, 120_000);

  it("while owner access is not configured, staff receive NO server setting name in the payload — only their own staff ID", async () => {
    delete process.env.GSO_OWNER_SHOPIFY_USER_IDS;
    for (const role of ["sales", "print_operator", "bagger", "manager", "unassigned"] as Role[]) {
      const data = await shellData(role);
      expect(data.isOwner, role).toBe(false);
      expect(data.ownerAccessNotice, role).toEqual({ temporary: false, userId: ROLES[role], idsEnv: null, switchEnv: null });
      expect(JSON.stringify(data), role).not.toMatch(/GSO_[A-Z_]+/);
    }
  }, 120_000);

  it("the temporary all-staff switch (everyone is owner) still shows the full diagnostic, since every viewer is then an owner", async () => {
    process.env.GSO_OWNER_ENFORCEMENT = "temporary_all_staff";
    const data = await shellData("bagger");
    expect(data.isOwner).toBe(true);
    expect(data.ownerAccessNotice).toMatchObject({ temporary: true, idsEnv: "GSO_OWNER_SHOPIFY_USER_IDS", switchEnv: "GSO_OWNER_ENFORCEMENT" });
  }, 120_000);

  it("the banner renders the technical text only for a verified owner; everyone else gets the plain staff line", () => {
    expect(SRC.shell).toContain("{ownerAccessNotice && !isOwner ? (");
    expect(SRC.shell).toContain("{ownerAccessNotice && isOwner ? (");
    expect(SRC.shell).toContain("<b>Your access is limited.</b> Ask the owner if you need another area.");
    const staffBlock = SRC.shell.slice(SRC.shell.indexOf("{ownerAccessNotice && !isOwner ? ("), SRC.shell.indexOf("{ownerAccessNotice && isOwner ? ("));
    expect(staffBlock).not.toMatch(/idsEnv|switchEnv|temporary_all_staff|GSO_/);
  });

  it("the unassigned Home card names the staff ID to give the owner, not a server setting; the access check is unchanged", async () => {
    h.sub = ROLES.unassigned;
    const data = await (await home.loader({ request: new Request("https://app.test/app") })).json();
    expect(data.role).toBe("unassigned");
    expect(data.roleReason).toBe("Your Shopify staff user ID is 9999. Give this number to the owner.");
    expect(JSON.stringify(data)).not.toMatch(/GSO_[A-Z_]+/);
    // unassigned staff still hold no permission and no area
    const { resolveStaffAccess } = await import("../app/lib/staff-roles.server");
    const access = resolveStaffAccess({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: "9999" } } as any);
    expect(access.role).toBe("unassigned");
    expect([...access.permissions]).toEqual([]);
  }, 120_000);
});
