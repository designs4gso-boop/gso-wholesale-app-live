// 2026-11-11 OWNER RULE — internal vendor / unit / purchase / material cost
// never reaches Sales, Print Operator, Bagger or unknown staff in a SERVER
// payload. Owner and financially authorized managers keep it.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { findInternalFinancialKeys, stripInternalFinancials } from "../app/lib/financial-redaction";

const h = vi.hoisted(() => ({ sub: "77055393857", writes: [] as string[] }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));
vi.mock("../app/db.server", () => {
  const MATERIAL = {
    id: "m1", shop: "shop-1", name: "Poseidon Matte", unit: "sqft", baseUnit: "sqft", stockOnHand: 5, reorderPoint: 20, leadTimeDays: null, active: true,
    costPerUnit: 0.3155, purchaseCost: 213, calculatedUnitCost: 0.3155, costReviewNeeded: false,
    primaryVendor: { id: "v1", name: "Media Vendor" }, vendors: [{ id: "mv1", vendorName: "Media Vendor", unitCost: 0.31, leadTimeDays: 7 }],
    inventoryMovements: [{ id: "im1", movementType: "purchase", quantity: 10, costPerUnit: 0.31, costImpact: 3.1, createdAt: new Date() }],
  };
  const PR = { id: "pr1", shop: "shop-1", requestNumber: "PR-1", status: "requested", priority: "normal", materialId: "m1", materialName: "Poseidon Matte", unit: "sqft", requestedQty: 100, orderedQty: 0, receivedQty: 0, unitCost: 0.31, estimatedCost: 31, vendor: "Media Vendor", updatedAt: new Date(), createdAt: new Date() };
  const COST_BOOK = { id: "cb1", shop: "shop-1", status: "active", vendorName: "Media Vendor", itemName: "Poseidon", unitCost: 0.3, moq: 1, tiers: [{ minQty: 100, unitCost: 0.28 }] };
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async () => {
      if (/^(create|update|upsert|delete)/.test(method)) { h.writes.push(`${name}.${method}`); return { id: "new", count: 1 }; }
      if (method === "findMany") {
        if (name === "purchaseRequest") return [PR];
        if (name === "material") return [MATERIAL];
        if (name === "vendorCostBookItem") return [COST_BOOK];
        if (name === "materialInventoryMovement") return [{ ...MATERIAL.inventoryMovements[0], material: MATERIAL }];
        return [];
      }
      if (method === "findFirst") return name === "purchaseRequest" ? PR : name === "material" ? MATERIAL : null;
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});

const ENV = {
  GSO_OWNER_SHOPIFY_USER_IDS: "77055393857",
  GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger,1005:manager",
  GSO_MANAGER_AUTHORIZED_USER_IDS: "1005",
};
beforeAll(async () => {
  await import("../app/routes/app.erp.purchase-requests");
  await import("../app/routes/app.erp.reorder-report");
}, 180_000);
beforeEach(() => { Object.assign(process.env, ENV); h.writes = []; });
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

async function load(file: string, sub: string): Promise<{ status: number; body: any }> {
  h.sub = sub;
  const route: any = await import(`../app/routes/${file}`);
  try {
    const response = await route.loader({ request: new Request(`https://app.test/x`) });
    return { status: response.status, body: await response.json() };
  } catch (thrown: any) {
    if (thrown instanceof Response) return { status: thrown.status, body: null };
    throw thrown;
  }
}
async function act(file: string, sub: string, fields: Record<string, string>) {
  h.sub = sub;
  const route: any = await import(`../app/routes/${file}`);
  try {
    const response = await route.action({ request: new Request("https://app.test/x", { method: "POST", body: new URLSearchParams(fields) }) });
    return { status: response.status, body: await response.json() };
  } catch (thrown: any) {
    if (thrown instanceof Response) return { status: thrown.status, body: null };
    throw thrown;
  }
}

describe("redaction helper", () => {
  it("removes every cost / price / margin / profit / floor key deeply and keeps operational fields", () => {
    const input = { a: [{ unitCost: 1, qty: 2, nested: { costImpact: 3, estimatedCost: 4, marginPct: 5, profit: 6, priceFloor: 7, name: "x" } }], costReviewNeeded: true, at: new Date(0) };
    const out = stripInternalFinancials(input);
    expect(findInternalFinancialKeys(out)).toEqual([]);
    expect(out).toEqual({ a: [{ qty: 2, nested: { name: "x" } }], costReviewNeeded: true, at: new Date(0) });
    expect(findInternalFinancialKeys(input).length).toBe(6);
  });
});

for (const file of ["app.erp.purchase-requests", "app.erp.reorder-report"]) {
  describe(`${file} loader payload`, () => {
    it("owner and authorized manager receive internal cost", async () => {
      for (const sub of ["77055393857", "1005"]) {
        const r = await load(file, sub);
        expect(r.status, sub).toBe(200);
        expect(r.body.canSeeCost).toBe(true);
        expect(findInternalFinancialKeys(r.body).length, sub).toBeGreaterThan(0);
      }
    }, 60_000);
    it.each([["sales", "1002"], ["print operator", "1003"], ["bagger", "1004"], ["plain manager", "1001"]])("%s receives NO internal cost keys at all", async (_label, sub) => {
      const r = await load(file, sub);
      expect(r.status).toBe(200);
      expect(r.body.canSeeCost).toBe(false);
      expect(findInternalFinancialKeys(r.body)).toEqual([]);
      expect(JSON.stringify(r.body)).not.toMatch(/0\.3155|"unitCost"|"estimatedCost"|"costImpact"/);
    }, 60_000);
    it("unknown / unassigned staff are denied the page", async () => {
      expect((await load(file, "9999")).status).toBe(403);
    }, 60_000);
  });
}

describe("forged purchase-request mutations", () => {
  it("non-approvers cannot order, re-price, apply a cost book, or create a request already 'ordered'", async () => {
    const forged: Array<Record<string, string>> = [
      { intent: "markOrdered", id: "pr1" },
      { intent: "applyBestCost", id: "pr1", costBookItemId: "cb1" },
      { intent: "updateRequest", id: "pr1", status: "ordered" },
      { intent: "updateRequest", id: "pr1", unitCost: "0.01" },
      { intent: "updateRequest", id: "pr1", costBookItemId: "cb1" },
    ];
    for (const fields of forged) {
      const r = await act("app.erp.purchase-requests", "1002", fields);
      expect(r.status, JSON.stringify(fields)).toBe(403);
    }
    expect(h.writes).toEqual([]);
  }, 60_000);
  it("an edit without a cost field never zeroes the stored cost", () => {
    const src = readFileSync("app/routes/app.erp.purchase-requests.tsx", "utf8");
    expect(src).toContain('const unitCost = formData.has("unitCost") ? num(formData.get("unitCost")) : num(purchaseRequest.unitCost);');
    expect(src).toContain('return ["draft", "requested"].includes(posted) || staffAccess.can("approvePurchasing") ? posted : "requested";');
  });
  it("reorder-report stock writes are financial-access only", async () => {
    const r = await act("app.erp.reorder-report", "1003", { intent: "quickPurchase", materialId: "m1", purchaseQty: "5" });
    expect(r.status).toBe(403);
    expect(h.writes).toEqual([]);
  }, 60_000);
});

describe("cost-configuration pages are gated on the server", () => {
  for (const file of ["app.erp.vendors.tsx", "app.erp.machines.tsx", "app.erp.shopify-links.tsx", "app.erp.configurator-jar-mapping.tsx", "app.erp.admin-settings.tsx", "app.erp.purchase-export.tsx"]) {
    it(`${file}: loader calls requireFinancialAccess`, () => {
      const src = readFileSync(`app/routes/${file}`, "utf8");
      const loader = src.slice(src.search(/export (async function loader|const loader)/));
      expect(loader.slice(0, 700)).toMatch(/requireFinancialAccess\((financialAuth|auth)\);/);
    });
  }
});
