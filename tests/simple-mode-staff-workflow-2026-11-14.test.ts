// 2026-11-14 GSO ERP SIMPLE MODE — staff workflows + server-side role rules.
//
// OWNER DECISION: material use (and its stock deduction / restore), manual job
// creation, scheduling edits, artwork revision, reopen-for-reprint, intake
// linking and file removal used to be accepted from ANY signed-in staff
// account. They now need a listed production role, enforced by the Production
// action itself (app/lib/production-role-access.ts).
//
// SECURITY MATRIX: for every action and all six roles this drives the REAL
// action through the Simple Mode routes. A denied role's forged POST must get
// 403 and cause NO database call at all (no read, no write, no stock movement,
// no job creation, no link). An allowed role must succeed with the unchanged
// behaviour. The Simple Mode screen shows a control only to roles the server
// allows.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", state: null as any, clock: Date.parse("2026-11-14T15:00:00Z") }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false, email: "staff@gso.test" }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

// Recorded (not re-tested): the stock engine, the job-creation service and the
// intake-link service each have their own suites. Here we only need to see
// whether the existing action reaches them, and with what.
vi.mock("../app/lib/inventory-stock.server", async (importOriginal) => {
  const original: any = await importOriginal();
  return { ...original, applyStockMovement: async (_tx: any, input: any) => { h.state.stockMovements.push(input); return { ok: true, beforeQty: 100, afterQty: 100 + Number(input.delta) }; } };
});
vi.mock("../app/lib/production-job-source.server", async (importOriginal) => {
  const original: any = await importOriginal();
  return {
    ...original,
    createProductionJobFromSource: async (_db: any, input: any) => { h.state.created.push(input); return { created: true, job: { id: "new1", jobTicket: "GSO-NEW-0001", items: [{ itemTicket: "GSO-NEW-0001-01", suggestedFileName: "GSO-NEW-0001-01.pdf", machineSummary: "Roland LG-640" }] } }; },
    linkIntakeJobToTarget: async (_db: any, input: any) => { h.state.links.push(input); return { ok: true, message: "Linked." }; },
  };
});

vi.mock("../app/db.server", () => {
  const now = () => new Date((h.clock += 1000));
  const READS = ["findFirst", "findMany", "count", "findUnique"];
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const s = h.state;
      s.calls.push(`${name}.${method}`);
      if (!READS.includes(method)) s.writes.push(`${name}.${method}`);
      if (name === "productionJob") {
        if (method === "findFirst") return { ...s.job, items: s.items.map((i: any) => ({ ...i })) };
        if (method === "findMany") return [{ ...s.job, items: s.items.map((i: any) => ({ ...i })), events: [...s.events].reverse().slice(0, 20), files: s.files.map((f: any) => ({ ...f })), checklistItems: [], materialUsages: s.usages.map((u: any) => ({ ...u })), inventoryMovements: [] }];
        if (method === "update" || method === "updateMany") { Object.assign(s.job, args.data); s.jobWrites.push(args.data); return { count: 1 }; }
      }
      if (name === "material") {
        if (method === "findFirst") return s.materials.find((m: any) => m.id === args.where?.id) || null;
        if (method === "findMany") return s.materials.map((m: any) => ({ ...m }));
      }
      if (name === "productionMaterialUsage") {
        if (method === "create") { const row = { id: `u${s.usages.length + 1}`, stockDeductedQty: 0, ...args.data, createdAt: now() }; s.usages.push(row); return row; }
        if (method === "findFirst") return s.usages.find((u: any) => u.id === args.where?.id) || null;
        if (method === "update") { Object.assign(s.usages.find((u: any) => u.id === args.where.id), args.data); return {}; }
        if (method === "deleteMany") { const before = s.usages.length; s.usages = s.usages.filter((u: any) => u.id !== args.where?.id); return { count: before - s.usages.length }; }
      }
      if (name === "materialInventoryMovement" && method === "findMany") return s.movements.filter((m: any) => m.materialUsageId === args.where?.materialUsageId);
      if (name === "productionJobFile") {
        if (method === "findFirst") return s.files.find((f: any) => f.id === args.where?.id) || null;
        if (method === "delete") { s.files = s.files.filter((f: any) => f.id !== args.where?.id); return {}; }
      }
      if (name === "productionJobEvent" && method === "create") { const row = { ...args.data, createdAt: now() }; s.events.push(row); return row; }
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});

const ROLES = { owner: "77055393857", manager: "1001", sales: "1002", print_operator: "1003", bagger: "1004", unassigned: "9999" } as const;
type Role = keyof typeof ROLES;
const ALL_ROLES = Object.keys(ROLES) as Role[];
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: ROLES.owner, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };
const WORKSPACE_SRC = readFileSync("app/routes/app.erp.production-job.$id.tsx", "utf8");
const CLASSIC_SRC = readFileSync("app/routes/app.erp.production.tsx", "utf8");
const NEW_JOB_SRC = readFileSync("app/routes/app.erp.production-new.tsx", "utf8");

let workspace: any;
let classic: any;
let newJob: any;
beforeAll(async () => {
  classic = await import("../app/routes/app.erp.production");
  workspace = await import("../app/routes/app.erp.production-job.$id");
  newJob = await import("../app/routes/app.erp.production-new");
}, 180_000);

const KEPT = { internalNotes: "Handle with care", customerNotes: "Call on arrival", artworkUrl: "https://files.test/art.pdf", proofUrl: "https://files.test/proof.pdf", printFileUrl: "https://files.test/print.pdf", productImageUrl: "https://files.test/img.png", assetFolderUrl: "https://files.test/folder", sourceFolderUrl: "https://files.test/src", assetInboxKey: "inbox-1" };
const reset = () => {
  h.state = {
    job: { id: "j1", shop: "shop-1", jobTicket: "GSO-TEST-0001", status: "printing", active: true, actualCostFinalized: false, sourceType: "manual", company: "Test Co", priority: "normal", assignedTo: null, dueDate: null, ...KEPT },
    items: [{ id: "i1", shop: "shop-1", jobId: "j1", itemTicket: "GSO-TEST-0001-01", productTitle: "Test item", quantity: 10 }],
    materials: [{ id: "m1", shop: "shop-1", name: "Poseidon Matte", materialType: "roll_media", unit: "roll", baseUnit: "sqft", costPerUnit: 0.4321, calculatedUnitCost: 0.4321, stockOnHand: 500, active: true }],
    usages: [{ id: "u0", shop: "shop-1", jobId: "j1", materialId: "m1", materialName: "Poseidon Matte", unit: "sqft", usedQty: 5, wasteQty: 0, stockDeductedQty: 5 }],
    movements: [{ id: "mv1", shop: "shop-1", materialUsageId: "u0", materialId: "m1", quantity: -5, unit: "sqft", costPerUnit: 0.4321, movementType: "production_deduction", reference: "Job j1" }],
    files: [{ id: "f1", shop: "shop-1", jobId: "j1", fileName: "wrong-file.pdf", fileType: "print_file", fileUrl: "https://files.test/wrong.pdf" }],
    events: [] as any[], calls: [] as string[], writes: [] as string[], jobWrites: [] as any[], stockMovements: [] as any[], created: [] as any[], links: [] as any[],
  };
};
beforeEach(() => { Object.assign(process.env, ENV); h.sub = ROLES.owner; reset(); });
afterEach(() => { for (const key of [...Object.keys(ENV), "GSO_MANAGER_AUTHORIZED_USER_IDS"]) delete process.env[key]; });

const post = async (fields: Record<string, string>, route: any = workspace, path = "/app/erp/production-job/j1") => {
  const res: Response = await route.action({ request: new Request(`https://app.test${path}`, { method: "POST", body: new URLSearchParams({ jobId: "j1", ...fields }) }) });
  return { status: res.status, body: await res.json() };
};
const untouched = () => ({ calls: h.state.calls, writes: h.state.writes, stock: h.state.stockMovements, created: h.state.created, links: h.state.links, usages: h.state.usages.length, files: h.state.files.length });
const NOTHING = { calls: [], writes: [], stock: [], created: [], links: [], usages: 1, files: 1 };

import { PRODUCTION_INTENT_ROLES, PRODUCTION_ROLE_DENIED, advancedProductionRedirect, roleMayRunProductionIntent, showsProductionControl } from "../app/lib/production-role-access";

// The owner-approved matrix, written out (not derived from the code under test).
const MATRIX: Record<string, { allowed: Role[]; fields: Record<string, string>; effect: () => void }> = {
  addMaterialUsage: {
    allowed: ["owner", "manager", "print_operator", "bagger"],
    fields: { materialId: "m1", usedQty: "12", wasteQty: "1.5", deductInventory: "on" },
    effect: () => {
      expect(h.state.usages.at(-1)).toMatchObject({ materialId: "m1", usedQty: 12, wasteQty: 1.5, costPerUnit: 0.4321 });
      expect(h.state.stockMovements).toHaveLength(1);
      expect(h.state.stockMovements[0]).toMatchObject({ delta: -13.5, movementType: "production_deduction" }); // used + waste, unchanged formula
    },
  },
  deleteMaterialUsage: {
    allowed: ["owner", "manager", "print_operator", "bagger"],
    fields: { usageId: "u0" },
    effect: () => {
      expect(h.state.usages).toHaveLength(0);
      // the existing behaviour: the deducted stock is restored by a reversal movement
      expect(h.state.stockMovements).toEqual([expect.objectContaining({ materialId: "m1", delta: 5, movementType: "reversal", reference: "Reversal for mv1" })]);
      expect(h.state.events.map((e: any) => e.eventType)).toEqual(["inventory_restored", "material_usage_deleted"]);
    },
  },
  createManualJob: {
    allowed: ["owner", "manager", "print_operator"],
    fields: { customerName: "Walk-in", itemTitle: "Labels", quantity: "100", requestId: "req-1", printer: "roland" },
    effect: () => { expect(h.state.created).toHaveLength(1); expect(h.state.created[0].source.type).toBe("manual_admin"); },
  },
  updateJob: {
    allowed: ["owner", "manager"],
    fields: { dueDate: "2026-11-20", priority: "rush", assignedTo: "Sam", ...KEPT },
    effect: () => { expect(h.state.job).toMatchObject({ priority: "rush", assignedTo: "Sam", ...KEPT }); expect(h.state.job.dueDate).toBeInstanceOf(Date); },
  },
  revisionItem: {
    allowed: ["owner", "manager", "print_operator"],
    fields: { itemId: "i1" },
    effect: () => { expect(h.state.events.map((e: any) => e.eventType)).toEqual(["production_revision_created"]); },
  },
  reopenReprint: {
    allowed: ["owner", "manager"],
    fields: { confirmReopen: "yes", reopenReason: "Customer found a defect" },
    effect: () => { expect(h.state.job.status).toBe("reprint_needed"); },
  },
  linkJobToTarget: {
    allowed: ["owner", "manager", "print_operator"],
    fields: { confirmLink: "yes", sourceJobId: "j1", linkTarget: "j2|i9", linkReason: "same order" },
    effect: () => { expect(h.state.links).toEqual([expect.objectContaining({ sourceJobId: "j1", targetJobId: "j2", targetItemId: "i9" })]); },
  },
  deleteFile: {
    allowed: ["owner", "manager", "print_operator"],
    fields: { fileId: "f1" },
    effect: () => { expect(h.state.files).toHaveLength(0); expect(h.state.events.map((e: any) => e.eventType)).toEqual(["file_deleted"]); },
  },
};

describe("the server table is exactly the owner-approved matrix", () => {
  it("lists the same actions and roles", () => {
    expect(Object.keys(PRODUCTION_INTENT_ROLES).sort()).toEqual(Object.keys(MATRIX).sort());
    for (const [intent, row] of Object.entries(MATRIX)) expect([...PRODUCTION_INTENT_ROLES[intent]].sort(), intent).toEqual([...row.allowed].sort());
  });

  it("Sales and unassigned accounts are allowed nothing in it", () => {
    for (const intent of Object.keys(PRODUCTION_INTENT_ROLES)) {
      for (const role of ["sales", "unassigned", "", "anything-else"]) expect(roleMayRunProductionIntent(role, intent), `${role} ${intent}`).toBe(false);
    }
  });

  it("the check runs in the Production action before any intent is handled", () => {
    const gate = CLASSIC_SRC.indexOf("if (!roleMayRunProductionIntent(staffAccess.role, intent)) return Response.json({ ok: false, message: `${PRODUCTION_ROLE_DENIED} ${staffAccess.reason}` }, { status: 403 });");
    expect(gate).toBeGreaterThan(-1);
    for (const intent of Object.keys(MATRIX)) expect(CLASSIC_SRC.indexOf(`if (intent === "${intent}")`), intent).toBeGreaterThan(gate);
  });
});

describe("SECURITY MATRIX — every action x every role, through the Simple Mode route", () => {
  for (const [intent, row] of Object.entries(MATRIX)) {
    for (const role of ALL_ROLES) {
      const allowed = row.allowed.includes(role);
      it(`${intent} · ${role} · ${allowed ? "allowed" : "forged POST refused, nothing touched"}`, async () => {
        if (intent === "reopenReprint") h.state.job.status = "completed";
        h.sub = ROLES[role];
        const res = await post({ intent, ...row.fields });
        if (allowed) {
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(res.body.ok).toBe(true);
          row.effect();
        } else {
          expect(res.status).toBe(403);
          expect(res.body.ok).toBe(false);
          expect(res.body.message).toContain(PRODUCTION_ROLE_DENIED);
          expect(untouched()).toEqual(NOTHING); // not one database call
        }
        // the screen agrees with the server
        expect(showsProductionControl(role, intent)).toBe(allowed);
      });
    }
  }

  it("the full Production page's own action answers identically (one rule, two doors)", async () => {
    for (const [intent, row] of Object.entries(MATRIX)) {
      for (const role of ["sales", "unassigned"] as Role[]) {
        reset();
        h.sub = ROLES[role];
        const res = await post({ intent, ...row.fields }, classic, "/app/erp/production");
        expect(res.status, `${intent} ${role}`).toBe(403);
        expect(untouched(), `${intent} ${role}`).toEqual(NOTHING);
      }
    }
  });
});

describe("1. material use — adversarial", () => {
  it("Sales / unassigned cannot deduct stock by forging the checkbox, a quantity override or a cost", async () => {
    for (const role of ["sales", "unassigned"] as Role[]) {
      h.sub = ROLES[role];
      const res = await post({ intent: "addMaterialUsage", materialId: "m1", usedQty: "999", wasteQty: "50", pulledQty: "999", deductQty: "999", deductInventory: "on", costPerUnit: "0", totalCost: "0", source: "inventory" });
      expect(res.status, role).toBe(403);
    }
    expect(untouched()).toEqual(NOTHING);
  });

  it("the calculation for allowed roles is untouched: staff cost comes from the material record; nothing is deducted without the box", async () => {
    h.sub = ROLES.bagger;
    expect((await post({ intent: "addMaterialUsage", materialId: "m1", usedQty: "10", costPerUnit: "0.01" })).body).toEqual({ ok: true, message: "Material usage added." });
    expect(h.state.usages.at(-1)).toMatchObject({ costPerUnit: 0.4321, unit: "sqft" });
    expect(h.state.stockMovements).toEqual([]);
    expect(CLASSIC_SRC).toContain("const deductionQty = Number(formData.get(\"deductQty\") || 0) || pulledQty || (usedQty + wasteQty + reprintQty) || usedQty || 0;");
    expect(CLASSIC_SRC).toContain('const shouldDeductInventory = String(formData.get("deductInventory") || "") === "on";');
  });

  it("owner-only stock / cost controls stay refused for every staff role", async () => {
    for (const role of ["manager", "sales", "print_operator", "bagger", "unassigned"] as Role[]) {
      for (const intent of ["adjustInventory", "saveFinalCosts", "reopenJobCost", "pullPrintLogActuals"]) {
        h.sub = ROLES[role];
        expect((await post({ intent, materialId: "m1", adjustmentQty: "50" })).status, `${role} ${intent}`).toBe(403);
      }
    }
    expect(h.state.writes).toEqual([]);
    expect(h.state.stockMovements).toEqual([]);
  });

  it("existing permission rules are unchanged: reprint, QC, shipment and pickup still refuse the same roles", async () => {
    const expectations: [string, Record<string, string>, Role[]][] = [
      ["reprintItem", { itemId: "i1", reprintReason: "machine_error" }, ["sales", "bagger", "unassigned"]],
      ["qcItem", { itemId: "i1", qcResult: "pass" }, ["sales", "unassigned"]],
      ["recordShipment", { carrier: "UPS", packageCount: "1", shipDate: "2026-11-14" }, ["sales", "unassigned"]],
      ["recordPickup", { pickedUpBy: "x" }, ["sales", "unassigned"]],
    ];
    for (const [intent, fields, denied] of expectations) {
      for (const role of denied) {
        h.sub = ROLES[role];
        expect((await post({ intent, ...fields })).status, `${intent} ${role}`).toBe(403);
      }
    }
    expect(h.state.writes).toEqual([]);
  });
});

describe("3. create production job", () => {
  const loadNew = async () => { const raw: any = await newJob.loader({ request: new Request("https://app.test/app/erp/production-new") }); return raw.json(); };

  it("the New job page opens for owner / manager / print operator and is refused (403) for everyone else", async () => {
    for (const role of ["owner", "manager", "print_operator"] as Role[]) {
      h.sub = ROLES[role];
      const data = await loadNew();
      expect(data.requestId, role).toMatch(/[0-9a-f-]{36}/);
      expect(data.canChoosePrinter, role).toBe(role !== "manager"); // existing selectPrinter rule
    }
    for (const role of ["sales", "bagger", "unassigned"] as Role[]) {
      h.sub = ROLES[role];
      await expect(loadNew()).rejects.toMatchObject({ status: 403 });
    }
  });

  it("posts the existing createManualJob action; a manager's forged printer is still ignored -> AUTO", async () => {
    const fields = { intent: "createManualJob", customerName: "Walk-in", itemTitle: "Labels", quantity: "100", requestId: "req-9", printer: "roland" };
    h.sub = ROLES.manager;
    const res = await post(fields, newJob, "/app/erp/production-new");
    expect(res.body).toMatchObject({ ok: true, manualJob: { jobTicket: "GSO-NEW-0001", machine: "Roland LG-640" } });
    expect(h.state.created[0].source.payload.items[0].printer).toBe("auto");
    expect(h.state.created[0].source.requestId).toBe("req-9");
    h.sub = ROLES.print_operator;
    await post(fields, newJob, "/app/erp/production-new");
    expect(h.state.created[1].source.payload.items[0].printer).toBe("roland");
    h.sub = ROLES.sales;
    expect((await post(fields, newJob, "/app/erp/production-new")).status).toBe(403);
    expect(h.state.created).toHaveLength(2);
  });

  it("the form is short and has no creation logic of its own", () => {
    expect(NEW_JOB_SRC).toContain("return productionAction({ request: args.request });");
    expect(NEW_JOB_SRC).not.toMatch(/createProductionJobFromSource|db\.server|prisma/);
    for (const name of ["customerName", "itemTitle", "quantity", "family", "finish", "dueDate", "requestId"]) expect(NEW_JOB_SRC, name).toContain(`name="${name}"`);
    expect(NEW_JOB_SRC).toContain("{canChoosePrinter ? (");
    expect(NEW_JOB_SRC).toContain("CREATE JOB");
  });
});

describe("4. job settings (due date, priority, assigned to)", () => {
  it("the compact form sends back every field the existing updateJob action rewrites, so nothing is wiped", () => {
    const start = CLASSIC_SRC.indexOf('if (intent === "updateJob") {');
    const block = CLASSIC_SRC.slice(start, CLASSIC_SRC.indexOf('if (intent === "addFile") {', start));
    const written = [...block.matchAll(/formData\.get\("([a-zA-Z]+)"\)/g)].map((m) => m[1]).filter((name) => name !== "jobId").sort();
    const kept = /const UPDATE_JOB_KEPT_FIELDS = \[([^\]]+)\]/.exec(WORKSPACE_SRC)![1].split(",").map((part) => part.trim().replace(/"/g, ""));
    expect([...kept, "dueDate", "priority", "assignedTo"].sort()).toEqual(written);
    expect(WORKSPACE_SRC).toContain('hidden={Object.fromEntries(UPDATE_JOB_KEPT_FIELDS.map((field) => [field, String(job[field] ?? "")]))}');
  });

  it("saving settings changes only due date / priority / assigned to", async () => {
    h.sub = ROLES.manager;
    const res = await post({ intent: "updateJob", dueDate: "2026-11-21", priority: "critical", assignedTo: "Alex", ...KEPT });
    expect(res.body).toEqual({ ok: true, message: "Job updated." });
    expect(h.state.job).toMatchObject({ priority: "critical", assignedTo: "Alex", ...KEPT });
    expect(h.state.job.dueDate.toISOString().slice(0, 10)).toBe("2026-11-21");
  });
});

describe("the Simple Mode screen shows each control only to roles the server allows", () => {
  it("role -> visible controls", () => {
    const visible = (role: Role) => Object.keys(MATRIX).filter((intent) => showsProductionControl(role, intent)).sort();
    expect(visible("owner")).toEqual(Object.keys(MATRIX).sort());
    expect(visible("manager")).toEqual(Object.keys(MATRIX).sort());
    expect(visible("print_operator")).toEqual(["addMaterialUsage", "createManualJob", "deleteFile", "deleteMaterialUsage", "linkJobToTarget", "revisionItem"]);
    expect(visible("bagger")).toEqual(["addMaterialUsage", "deleteMaterialUsage"]);
    expect(visible("sales")).toEqual([]);
    expect(visible("unassigned")).toEqual([]);
    // reprint is shown to the roles that hold recordReprint; never to bagger / sales / unassigned
    expect((["owner", "manager", "print_operator"] as Role[]).every((role) => showsProductionControl(role, "reprintItem"))).toBe(true);
    expect((["bagger", "sales", "unassigned"] as Role[]).some((role) => showsProductionControl(role, "reprintItem"))).toBe(false);
  });

  it("every control is wrapped in its role check and uses the existing intent", () => {
    for (const snippet of [
      '{showsProductionControl(role, "reprintItem") ? (',
      'key === "artwork" && showsProductionControl(role, "revisionItem")',
      'const canRemove = showsProductionControl(role, "deleteFile");',
      'const canSettings = showsProductionControl(role, "updateJob");',
      'const canReopen = showsProductionControl(role, "reopenReprint") && String(job.status) === "completed";',
      'if (!job.linkEligible || !showsProductionControl(role, "linkJobToTarget")) return null;',
      'intent="deleteMaterialUsage"', 'intent="deleteFile"', 'intent="revisionItem"', 'intent="reprintItem"', 'intent="updateJob"', 'intent="reopenReprint"',
      '<input type="hidden" name="intent" value="linkJobToTarget" />',
    ]) expect(WORKSPACE_SRC, snippet).toContain(snippet);
  });

  it("uses the owner's employee wording and warns before removing a material entry", () => {
    for (const text of ["NEEDS REPRINT", "START REPRINT", "NEW ARTWORK REVISION", "START NEW REVISION", "Job settings", "SAVE JOB SETTINGS", "Correct material entry", "Remove this material entry?", "Removing it puts that amount back into stock.", "No stock was taken for this entry, so stock will not change.", "Yes, remove file", "LINK TO JOB"]) expect(WORKSPACE_SRC, text).toContain(text);
    // corrections stay behind small collapsed controls; the six steps are still the page
    expect(WORKSPACE_SRC).toContain("<MoreTools job={job} role={role} />");
    expect(WORKSPACE_SRC).not.toMatch(/adjustInventory|saveFinalCosts|pullPrintLogActuals|backfillTickets|setFileRole/);
  });

  it("link-intake data is only sent for an unlinked print-intake job", async () => {
    const raw: any = await workspace.loader({ request: new Request("https://app.test/app/erp/production-job/j1"), params: { id: "j1" } });
    const data = await raw.json();
    expect(data.job.linkEligible).toBe(false); // a normal (manual) job
    expect(data.linkTargets).toEqual([]);
    expect(WORKSPACE_SRC).toContain("const linkTargets = job.linkEligible ? data.linkTargets || [] : [];");
  }, 120_000);
});

describe("9. Advanced view redirect", () => {
  const open = async (path: string) => {
    try {
      const raw: any = await classic.loader({ request: new Request(`https://app.test${path}`) });
      return { redirect: null as string | null, data: await raw.json() };
    } catch (thrown: any) {
      if (thrown instanceof Response && thrown.status >= 300 && thrown.status < 400) return { redirect: thrown.headers.get("Location"), data: null };
      throw thrown;
    }
  };

  it("rule: owner and financially authorized managers stay; production roles go to the board; others go Home", () => {
    expect(advancedProductionRedirect("owner", true)).toBeNull();
    expect(advancedProductionRedirect("manager", true)).toBeNull();
    for (const role of ["manager", "print_operator", "bagger"]) expect(advancedProductionRedirect(role, false)).toBe("/app/erp/production-board");
    for (const role of ["sales", "unassigned", ""]) expect(advancedProductionRedirect(role, false)).toBe("/app");
  });

  it("the real loader redirects exactly those roles on /app/erp/production", async () => {
    h.sub = ROLES.owner;
    expect((await open("/app/erp/production")).redirect).toBeNull();
    for (const role of ["manager", "print_operator", "bagger"] as Role[]) {
      h.sub = ROLES[role];
      expect((await open("/app/erp/production?job=j1")).redirect, role).toBe("/app/erp/production-board?job=j1");
    }
    for (const role of ["sales", "unassigned"] as Role[]) {
      h.sub = ROLES[role];
      expect((await open("/app/erp/production")).redirect, role).toBe("/app");
    }
    // a financially authorized manager keeps the Advanced view (actual costs live only there)
    process.env.GSO_MANAGER_AUTHORIZED_USER_IDS = ROLES.manager;
    h.sub = ROLES.manager;
    const authorized = await open("/app/erp/production");
    expect(authorized.redirect).toBeNull();
    expect(authorized.data.showFinancials).toBe(true);
  }, 120_000);

  it("the Simple Mode routes are never redirected and still serve redacted data to staff", async () => {
    h.sub = ROLES.bagger;
    for (const path of ["/app/erp/production-board", "/app/erp/production-job/j1"]) {
      const result = await open(path);
      expect(result.redirect, path).toBeNull();
      expect(result.data.showFinancials).toBe(false);
      expect(result.data.jobs[0].materialUsages[0]).toMatchObject({ costPerUnit: null, totalCost: null });
    }
  }, 120_000);

  it("the redirect is a GET rule only: the action's permissions are the role table and the existing checks", () => {
    const loaderStart = CLASSIC_SRC.indexOf("export async function loader");
    const actionStart = CLASSIC_SRC.indexOf("export async function action");
    const at = CLASSIC_SRC.indexOf("advancedProductionRedirect(resolveStaffAccess(auth).role, financials.show)");
    expect(at).toBeGreaterThan(loaderStart);
    expect(at).toBeLessThan(actionStart);
  });
});
