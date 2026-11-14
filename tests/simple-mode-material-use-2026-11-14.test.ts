// 2026-11-14 GSO ERP SIMPLE MODE — owner correction: MATERIAL USED on the job page.
//
// The Job Workspace offers the EXISTING Production "addMaterialUsage" action in
// employee words. These tests drive the real action through the workspace
// route and prove: same action, same stock semantics (nothing is deducted
// unless "Deduct from material stock" is ticked AND a listed material is
// chosen), no cost field or cost data for staff, and no new power for any role
// (the workspace answers exactly as the full Production page does).

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", state: null as any, clock: Date.parse("2026-11-14T15:00:00Z") }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false, email: "staff@gso.test" }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

// The stock engine itself is covered by its own tests; here it is recorded so
// the test can see exactly when, and with what, the existing action calls it.
vi.mock("../app/lib/inventory-stock.server", async (importOriginal) => {
  const original: any = await importOriginal();
  return {
    ...original,
    applyStockMovement: async (_tx: any, input: any) => {
      h.state.stockMovements.push(input);
      return { ok: true, beforeQty: 100, afterQty: 100 + Number(input.delta) };
    },
  };
});

vi.mock("../app/db.server", () => {
  const now = () => new Date((h.clock += 1000));
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const s = h.state;
      if (!["findFirst", "findMany", "count", "findUnique"].includes(method)) s.writes.push(`${name}.${method}`);
      if (name === "productionJob") {
        if (method === "findFirst") return { ...s.job, items: [] };
        if (method === "findMany") return [{ ...s.job, items: s.items.map((i: any) => ({ ...i })), events: [...s.events].reverse().slice(0, 20), files: [], checklistItems: [], materialUsages: s.usages.map((u: any) => ({ ...u })), inventoryMovements: [] }];
      }
      if (name === "material") {
        if (method === "findFirst") return s.materials.find((m: any) => m.id === args.where?.id) || null;
        if (method === "findMany") return s.materials.map((m: any) => ({ ...m }));
      }
      if (name === "productionMaterialUsage") {
        if (method === "create") { const row = { id: `u${s.usages.length + 1}`, stockDeductedQty: 0, ...args.data, createdAt: now() }; s.usages.push(row); return row; }
        if (method === "update") { Object.assign(s.usages.find((u: any) => u.id === args.where.id), args.data); return {}; }
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

const OWNER = "77055393857";
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: OWNER, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };
const WORKSPACE_SRC = readFileSync("app/routes/app.erp.production-job.$id.tsx", "utf8");
const CLASSIC_SRC = readFileSync("app/routes/app.erp.production.tsx", "utf8");

let workspace: any;
let classic: any;
beforeAll(async () => {
  classic = await import("../app/routes/app.erp.production");
  workspace = await import("../app/routes/app.erp.production-job.$id");
}, 180_000);
beforeEach(() => {
  Object.assign(process.env, ENV);
  h.sub = "1003"; // print operator
  h.state = {
    job: { id: "j1", shop: "shop-1", jobTicket: "GSO-TEST-0001", status: "printing", active: true, actualCostFinalized: false, sourceType: "manual", company: "Test Co" },
    items: [{ id: "i1", shop: "shop-1", jobId: "j1", itemTicket: "GSO-TEST-0001-01", productTitle: "Test item", quantity: 10, unitPrice: 2.15, unitCost: 1.0952 }],
    materials: [{ id: "m1", shop: "shop-1", name: "Poseidon Matte", materialType: "roll_media", unit: "roll", baseUnit: "sqft", costPerUnit: 0.4321, calculatedUnitCost: 0.4321, purchaseCost: 199.99, stockOnHand: 500, active: true }],
    usages: [] as any[], events: [] as any[], writes: [] as string[], stockMovements: [] as any[],
  };
});
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

const request = (fields: Record<string, string>) => new Request("https://app.test/app/erp/production-job/j1", { method: "POST", body: new URLSearchParams({ intent: "addMaterialUsage", jobId: "j1", ...fields }) });
const post = async (fields: Record<string, string>, route: any = workspace) => {
  const res: Response = await route.action({ request: request(fields) });
  return { status: res.status, body: await res.json() };
};
const loadJob = async () => {
  const raw: any = await workspace.loader({ request: new Request("https://app.test/app/erp/production-job/j1"), params: { id: "j1" } });
  return raw instanceof Response ? raw.json() : raw;
};

import { MATERIAL_USE_ROLES, showsMaterialUse, toMaterialOption } from "../app/lib/simple-production";

describe("6. MATERIAL USED appears in Simple Mode for production roles", () => {
  it("is shown to owner, manager, print operator and bagger — not to sales or an unassigned account", () => {
    expect([...MATERIAL_USE_ROLES]).toEqual(["owner", "manager", "print_operator", "bagger"]);
    expect(showsMaterialUse("print_operator")).toBe(true);
    for (const role of ["sales", "unassigned", "", undefined]) expect(showsMaterialUse(role)).toBe(false);
  });

  it("sits in the PRINT and FINISH steps (and the Materials tab), with the owner's employee wording", () => {
    expect(WORKSPACE_SRC).toContain('{key === "print" || key === "finish" ? <MaterialUse job={job} materials={materials} canRecord={canRecordMaterial} /> : null}');
    expect(WORKSPACE_SRC).toContain('{tab === "materials" ? <MaterialUse job={job} materials={materials} canRecord={canRecordMaterial} /> : null}');
    expect(WORKSPACE_SRC).toContain("const canRecordMaterial = showsMaterialUse(role);");
    for (const text of ["MATERIAL USED", "Quantity used", "Waste", "Notes (optional)", "RECORD MATERIAL USE", "Deduct from material stock"]) expect(WORKSPACE_SRC, text).toContain(text);
    // the record form stays collapsed until asked for, so the step is not cluttered
    expect(WORKSPACE_SRC).toContain('<summary style={{ cursor: "pointer", fontWeight: 700, minHeight: 36 }}>Record material use</summary>');
  });
});

describe("7. no financial fields for material use", () => {
  it("the picker carries id / name / unit only, for every viewer", async () => {
    expect(toMaterialOption(h.state.materials[0])).toEqual({ id: "m1", name: "Poseidon Matte", unit: "sqft" });
    for (const sub of [OWNER, "1003", "1004"]) {
      h.sub = sub;
      const data: any = await loadJob();
      expect(data.materials).toEqual([{ id: "m1", name: "Poseidon Matte", unit: "sqft" }]);
      expect(JSON.stringify(data.materials)).not.toMatch(/0\.4321|199\.99|cost/i);
    }
  }, 120_000);

  it("the simple form has no cost input, and staff never get usage cost back", async () => {
    const form = WORKSPACE_SRC.slice(WORKSPACE_SRC.indexOf("function MaterialUse("), WORKSPACE_SRC.indexOf("function NotesTab("));
    expect(form).not.toMatch(/costPerUnit|totalCost|money\(|cost/i);
    expect((await post({ materialId: "m1", usedQty: "12", wasteQty: "1" })).body.ok).toBe(true);
    const staff: any = await loadJob();
    expect(staff.showFinancials).toBe(false);
    expect(staff.job.materialUsages[0]).toMatchObject({ materialName: "Poseidon Matte", usedQty: 12, wasteQty: 1, costPerUnit: null, totalCost: null });
    const text = JSON.stringify(staff);
    for (const secret of ["0.4321", "199.99", "5.6173", "1.0952", "2.15"]) expect(text, secret).not.toContain(secret);
  }, 120_000);

  it("a cost typed by staff is ignored — the existing owner-only cost rule still applies", async () => {
    await post({ materialId: "m1", usedQty: "10", costPerUnit: "0.01", totalCost: "0.05" });
    expect(h.state.usages[0].costPerUnit).toBe(0.4321); // from the material record, not the posted value
    expect(h.state.usages[0].totalCost).toBeCloseTo(4.321, 6);
  });
});

describe("8-9. the existing action and the existing deduction semantics", () => {
  it("the workspace has no material logic of its own", () => {
    expect(WORKSPACE_SRC).toContain('<ActionForm jobId={job.id} intent="addMaterialUsage">');
    expect(WORKSPACE_SRC).toContain("return productionAction({ request: args.request });");
    expect(WORKSPACE_SRC).not.toMatch(/applyStockMovement|productionMaterialUsage|stockOnHand|reserveInventory|consumeReservation/);
  });

  it("records the usage with the material's own unit; nothing is deducted unless the box is ticked", async () => {
    const res = await post({ materialId: "m1", usedQty: "12", wasteQty: "1.5", materialNotes: "first roll" });
    expect(res.body).toEqual({ ok: true, message: "Material usage added." });
    expect(h.state.usages[0]).toMatchObject({ materialId: "m1", materialName: "Poseidon Matte", unit: "sqft", usedQty: 12, wasteQty: 1.5, pulledQty: 0, reprintQty: 0, source: "manual", notes: "first roll" });
    expect(h.state.stockMovements).toEqual([]);
    expect(h.state.usages[0].stockDeductedQty).toBe(0);
  });

  it("ticked + listed material: one deduction of used + waste, exactly as the full page", async () => {
    const res = await post({ materialId: "m1", usedQty: "12", wasteQty: "1.5", deductInventory: "on" });
    expect(res.body.message).toBe("Material usage added and inventory deducted.");
    expect(h.state.stockMovements).toHaveLength(1);
    expect(h.state.stockMovements[0]).toMatchObject({ shop: "shop-1", materialId: "m1", delta: -13.5, movementType: "production_deduction", source: "production", jobId: "j1", materialUsageId: "u1" });
    expect(h.state.usages[0].stockDeductedQty).toBe(13.5);
  });

  it("ticked without a listed material never touches stock", async () => {
    const res = await post({ materialName: "Scrap vinyl", unit: "each", usedQty: "3", deductInventory: "on" });
    expect(res.body).toEqual({ ok: true, message: "Material usage added." });
    expect(h.state.usages[0]).toMatchObject({ materialId: null, materialName: "Scrap vinyl", unit: "each" });
    expect(h.state.stockMovements).toEqual([]);
  });

  it("the checkbox is unticked by default in both views (no silent deduction)", () => {
    expect(WORKSPACE_SRC).toContain('<input type="checkbox" name="deductInventory" style={{ width: 22, height: 22 }} />');
    expect(WORKSPACE_SRC).not.toMatch(/name="deductInventory"[^>]*(defaultChecked|checked)/);
    expect(CLASSIC_SRC).toContain('<input type="checkbox" name="deductInventory" />');
    // the server rule is untouched
    expect(CLASSIC_SRC).toContain('const shouldDeductInventory = String(formData.get("deductInventory") || "") === "on";');
    expect(CLASSIC_SRC).toContain("const deductionQty = Number(formData.get(\"deductQty\") || 0) || pulledQty || (usedQty + wasteQty + reprintQty) || usedQty || 0;");
  });

  it("the same post gives the same result on the workspace and on the full Production page", async () => {
    const viaWorkspace = await post({ materialId: "m1", usedQty: "5", deductInventory: "on" }, workspace);
    const viaClassic = await post({ materialId: "m1", usedQty: "5", deductInventory: "on" }, classic);
    expect(viaWorkspace).toEqual(viaClassic);
    expect(h.state.stockMovements.map((m: any) => m.delta)).toEqual([-5, -5]);
  });

  it("never reserves or consumes inventory automatically", async () => {
    await post({ materialId: "m1", usedQty: "5", deductInventory: "on" });
    expect(h.state.writes.filter((w: string) => w.startsWith("inventoryReservation"))).toEqual([]);
  });
});

describe("10. no role gains a new material / stock power", () => {
  it("owner-only stock and cost controls stay refused through the workspace for every staff role", async () => {
    for (const sub of ["1001", "1002", "1003", "1004", "9999"]) {
      h.sub = sub;
      for (const intent of ["adjustInventory", "saveFinalCosts", "reopenJobCost", "pullPrintLogActuals"]) {
        const res = await post({ intent, materialId: "m1", adjustmentQty: "50" });
        expect(res.status, `${sub} ${intent}`).toBe(403);
      }
    }
    expect(h.state.stockMovements).toEqual([]);
    expect(h.state.writes.filter((w: string) => /material\.(update|updateMany)|materialInventoryMovement/.test(w))).toEqual([]);
  });

  it("for every role the workspace answers exactly as the full Production page already does", async () => {
    for (const sub of [OWNER, "1001", "1002", "1003", "1004", "9999"]) {
      h.sub = sub;
      const viaWorkspace = await post({ materialId: "m1", usedQty: "2" }, workspace);
      const viaClassic = await post({ materialId: "m1", usedQty: "2" }, classic);
      expect(viaWorkspace, sub).toEqual(viaClassic);
    }
  });

  it("the workspace exposes no adjust-stock or deduct-override control (removing an entry is covered in the staff-workflow suite)", () => {
    expect(WORKSPACE_SRC).not.toMatch(/adjustInventory|deductQty/);
  });
});
