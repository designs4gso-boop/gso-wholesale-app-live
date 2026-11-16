// 2026-11-15 — PURCHASE REQUEST approval + metadata (overnight stabilization).
//
// Owner rule (2026-11-11): staff create purchase requests; only the owner or a
// financially authorized manager approves purchasing (orders, re-prices,
// cancels). These tests drive the real route action against an in-memory
// request and attack the gaps found on 2026-11-15:
//   - a forged "partially_received" / "received" status skipped approval and
//     opened the request for receiving stock;
//   - the approver was not captured when an approver moved a request straight
//     to a received state;
//   - Mark ordered / Mark PO sent re-opened a received or cancelled request
//     (same stock could be received twice) and reset the original order time;
//   - a received request could be cancelled.
// Nothing here orders from a vendor: the route makes no external call.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sub: "77055393857",
  pr: null as any,
  created: [] as any[],
  stockMoves: [] as any[],
  writes: [] as string[],
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));
vi.mock("../app/lib/inventory-stock.server", () => ({
  applyStockMovement: async (_tx: any, args: any) => { h.stockMoves.push(args); return { ok: true, beforeQty: 0, afterQty: Number(args.delta) }; },
}));
vi.mock("../app/db.server", () => {
  const MATERIAL = { id: "m1", shop: "shop-1", name: "Poseidon Matte", unit: "sqft", baseUnit: "sqft", stockOnHand: 5, reorderPoint: 20, active: true, costPerUnit: 0.31, calculatedUnitCost: 0.31, vendors: [] };
  const matches = (row: any, where: any) => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("not" in value) return row[key] !== value.not;
      if ("in" in value) return value.in.includes(row[key]);
      return true;
    }
    return row[key] === value;
  });
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any) => {
      if (name === "purchaseRequest") {
        if (method === "findFirst") return h.pr && matches(h.pr, args?.where) ? { ...h.pr } : null;
        if (method === "findMany") return h.pr ? [{ ...h.pr }] : [];
        if (method === "count") return h.created.length + (h.pr ? 1 : 0);
        if (method === "create") { h.writes.push("purchaseRequest.create"); h.created.push(args.data); return { id: "new", ...args.data }; }
        if (method === "update" || method === "updateMany") {
          if (!h.pr || !matches(h.pr, args.where)) return { count: 0 };
          h.writes.push(`purchaseRequest.${method}`);
          Object.assign(h.pr, args.data);
          return { count: 1, ...h.pr };
        }
      }
      if (/^(create|update|upsert|delete)/.test(method)) { h.writes.push(`${name}.${method}`); return { id: "new", count: 1 }; }
      if (method === "findFirst") return name === "material" ? MATERIAL : null;
      if (method === "findMany") return name === "material" ? [MATERIAL] : [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});

const OWNER = "77055393857";
const ROLES = { owner: OWNER, plainManager: "1001", sales: "1002", printOperator: "1003", bagger: "1004", authorizedManager: "1005", unassigned: "9999" } as const;
const NON_APPROVERS = ["plainManager", "sales", "printOperator", "bagger"] as const;
const ENV = {
  GSO_OWNER_SHOPIFY_USER_IDS: OWNER,
  GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger,1005:manager",
  GSO_MANAGER_AUTHORIZED_USER_IDS: "1005",
};
const T0 = new Date("2026-11-01T12:00:00Z");
const request = (over: Record<string, unknown> = {}) => ({
  id: "pr1", shop: "shop-1", requestNumber: "PR-1", status: "requested", priority: "normal", materialId: "m1", materialName: "Poseidon Matte", unit: "sqft",
  requestedQty: 100, orderedQty: 100, receivedQty: 0, unitCost: 0.31, estimatedCost: 31, vendor: "Media Vendor", moq: null,
  requestedBy: "shopify-user:1003", approvedBy: null, approvedAt: null, orderedAt: null, receivedAt: null, cancelledAt: null,
  expectedArrivalDate: null, leadTimeDays: null, vendorConfirmationNumber: null, notes: null, ...over,
});

let route: any;
beforeAll(async () => { route = await import("../app/routes/app.erp.purchase-requests"); }, 180_000);
beforeEach(() => { Object.assign(process.env, ENV); h.pr = request(); h.created = []; h.stockMoves = []; h.writes = []; });
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

async function act(role: keyof typeof ROLES, fields: Record<string, string>) {
  h.sub = ROLES[role];
  const response: Response = await route.action({ request: new Request("https://app.test/app/erp/purchase-requests", { method: "POST", body: new URLSearchParams(fields) }) });
  return { status: response.status, body: await response.json() };
}
const actorOf = (role: keyof typeof ROLES) => `shopify-user:${ROLES[role]}`;

describe("who may create a purchase request, and who is recorded as the requester", () => {
  it.each(["owner", "authorizedManager", "plainManager", "sales", "printOperator", "bagger"] as const)("%s can submit a request and is captured as requestedBy", async (role) => {
    const r = await act(role, { intent: "createManual", materialName: "Bubble mailers", requestedQty: "50" });
    expect(r.status).toBe(200);
    expect(h.created).toHaveLength(1);
    expect(h.created[0].requestedBy).toBe(actorOf(role));
    expect(h.created[0].requestedBy).not.toMatch(/offline|unidentified/);
  }, 60_000);

  it("an unassigned account cannot create, edit or receive", async () => {
    const attempts: Array<Record<string, string>> = [{ intent: "createManual", materialName: "x" }, { intent: "updateRequest", id: "pr1" }, { intent: "receiveRequest", id: "pr1", receiveQty: "1" }];
    for (const fields of attempts) {
      expect((await act("unassigned", fields)).status).toBe(403);
    }
    expect(h.writes).toEqual([]);
  }, 60_000);

  it("a non-approver's new request is never born approved: status is forced to requested and no approver is stamped", async () => {
    for (const status of ["ordered", "partially_received", "received", "cancelled"]) {
      h.created = [];
      await act("sales", { intent: "createManual", materialName: "x", requestedQty: "5", status });
      expect(h.created[0].status, status).toBe("requested");
      expect(h.created[0].approvedBy ?? null, status).toBeNull();
      expect(h.created[0].approvedAt ?? null, status).toBeNull();
    }
  }, 60_000);

  it("an approver who creates a request already ordered / received is captured as both requester and approver", async () => {
    for (const status of ["ordered", "partially_received", "received"]) {
      h.created = [];
      await act("authorizedManager", { intent: "createManual", materialName: "x", requestedQty: "5", status });
      expect(h.created[0]).toMatchObject({ status, requestedBy: actorOf("authorizedManager"), approvedBy: actorOf("authorizedManager") });
      expect(h.created[0].approvedAt).toBeInstanceOf(Date);
    }
    h.created = [];
    await act("owner", { intent: "createManual", materialName: "x", requestedQty: "5", status: "requested" });
    expect(h.created[0].approvedBy ?? null).toBeNull();
  }, 60_000);

  it("an unknown status is refused and nothing is stored", async () => {
    expect((await act("owner", { intent: "createManual", materialName: "x", status: "approved_by_me" })).status).toBe(400);
    expect((await act("owner", { intent: "updateRequest", id: "pr1", status: "approved_by_me" })).status).toBe(400);
    expect(h.writes).toEqual([]);
    expect(h.pr.status).toBe("requested");
  }, 60_000);
});

describe("forged status changes — every approval state needs approvePurchasing", () => {
  it.each(NON_APPROVERS)("%s cannot move a request to ordered, partially received, received or cancelled through Save request", async (role) => {
    for (const status of ["ordered", "partially_received", "received", "cancelled"]) {
      const r = await act(role, { intent: "updateRequest", id: "pr1", status, requestedQty: "100", orderedQty: "100" });
      expect(r.status, `${role} ${status}`).toBe(403);
    }
    expect(h.writes).toEqual([]);
    expect(h.pr).toMatchObject({ status: "requested", approvedBy: null, approvedAt: null });
  }, 60_000);

  it.each(NON_APPROVERS)("%s cannot use the forged status to open a request for receiving (no stock is added)", async (role) => {
    await act(role, { intent: "updateRequest", id: "pr1", status: "partially_received", requestedQty: "100", orderedQty: "100" });
    const receive = await act(role, { intent: "receiveRequest", id: "pr1", receiveQty: "40" });
    expect(receive.status).toBe(400);
    expect(h.stockMoves).toEqual([]);
    expect(h.pr.receivedQty).toBe(0);
  }, 60_000);

  it.each(NON_APPROVERS)("%s cannot pull an ordered or received request back to draft / requested, or re-open a cancelled one", async (role) => {
    for (const from of ["ordered", "partially_received", "received", "cancelled"]) {
      h.pr = request({ status: from, approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0 });
      for (const to of ["draft", "requested"]) {
        expect((await act(role, { intent: "updateRequest", id: "pr1", status: to, requestedQty: "100", orderedQty: "100" })).status, `${from} -> ${to}`).toBe(403);
      }
      expect(h.pr.status).toBe(from);
    }
  }, 60_000);

  it.each(NON_APPROVERS)("%s can still edit their own open request (draft <-> requested, quantity, notes) and can add notes to an ordered one", async (role) => {
    const toDraft = await act(role, { intent: "updateRequest", id: "pr1", status: "draft", requestedQty: "120", orderedQty: "120", notes: "need more" });
    expect(toDraft.status).toBe(200);
    expect(h.pr).toMatchObject({ status: "draft", requestedQty: 120, notes: "need more", unitCost: 0.31, approvedBy: null });
    expect((await act(role, { intent: "updateRequest", id: "pr1", status: "requested", requestedQty: "120", orderedQty: "120" })).status).toBe(200);
    h.pr = request({ status: "ordered", approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0 });
    const note = await act(role, { intent: "updateRequest", id: "pr1", status: "ordered", requestedQty: "100", orderedQty: "100", vendorReplyNotes: "ships Friday" });
    expect(note.status).toBe(200);
    expect(h.pr).toMatchObject({ status: "ordered", approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0, vendorReplyNotes: "ships Friday" });
  }, 60_000);

  it.each(NON_APPROVERS)("%s cannot press Mark ordered, Mark PO sent, Cancel or Apply best cost by forging the action", async (role) => {
    for (const intent of ["markOrdered", "markSent", "cancelRequest", "applyBestCost"]) {
      expect((await act(role, { intent, id: "pr1" })).status, `${role} ${intent}`).toBe(403);
    }
    expect(h.writes).toEqual([]);
  }, 60_000);

  it("an action the permission map does not list is refused for everyone, the owner included (fail closed)", async () => {
    for (const role of ["owner", "sales", "bagger"] as const) {
      for (const intent of ["approveAndPay", "", "constructor", "__proto__", "toString"]) {
        const r = await act(role, { intent, id: "pr1" });
        expect(r.status, `${role} ${intent}`).toBe(400);
      }
    }
    expect(h.writes).toEqual([]);
  }, 60_000);
});

describe("approver metadata — captured on the FIRST approval and never overwritten", () => {
  it.each(["owner", "authorizedManager"] as const)("%s: Mark ordered stamps approvedBy / approvedAt / orderedAt", async (role) => {
    const r = await act(role, { intent: "markOrdered", id: "pr1" });
    expect(r.status).toBe(200);
    expect(h.pr).toMatchObject({ status: "ordered", approvedBy: actorOf(role), requestedBy: "shopify-user:1003" });
    expect(h.pr.approvedAt).toBeInstanceOf(Date);
    expect(h.pr.orderedAt).toBeInstanceOf(Date);
  }, 60_000);

  it("each first-approval path captures the approver: Save request -> ordered, Mark PO sent, and Save request straight to a received state", async () => {
    await act("authorizedManager", { intent: "updateRequest", id: "pr1", status: "ordered", requestedQty: "100", orderedQty: "100" });
    expect(h.pr).toMatchObject({ status: "ordered", approvedBy: actorOf("authorizedManager") });
    h.pr = request();
    await act("owner", { intent: "markSent", id: "pr1" });
    expect(h.pr).toMatchObject({ status: "ordered", approvedBy: actorOf("owner") });
    for (const status of ["partially_received", "received"]) {
      h.pr = request();
      await act("authorizedManager", { intent: "updateRequest", id: "pr1", status, requestedQty: "100", orderedQty: "100" });
      expect(h.pr, status).toMatchObject({ status, approvedBy: actorOf("authorizedManager") });
      expect(h.pr.approvedAt, status).toBeInstanceOf(Date);
    }
  }, 60_000);

  it("a later approver action never replaces the first approver, the first approval time or the first order time", async () => {
    h.pr = request({ status: "ordered", approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0 });
    await act("owner", { intent: "markOrdered", id: "pr1" });
    await act("owner", { intent: "markSent", id: "pr1" });
    await act("owner", { intent: "updateRequest", id: "pr1", status: "ordered", requestedQty: "100", orderedQty: "100", unitCost: "0.29" });
    expect(h.pr).toMatchObject({ status: "ordered", approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0 });
    expect(h.pr.unitCost).toBe(0.29); // the owner's re-price itself is allowed
  }, 60_000);

  it("saving a draft / requested request stamps no approver", async () => {
    await act("owner", { intent: "updateRequest", id: "pr1", status: "draft", requestedQty: "100", orderedQty: "100" });
    await act("owner", { intent: "updateRequest", id: "pr1", status: "requested", requestedQty: "100", orderedQty: "100" });
    expect(h.pr).toMatchObject({ approvedBy: null, approvedAt: null, orderedAt: null });
  }, 60_000);
});

describe("closed requests stay closed — the same stock is never received twice", () => {
  it("Mark ordered / Mark PO sent refuse a received or cancelled request and change nothing", async () => {
    for (const status of ["received", "cancelled"]) {
      for (const intent of ["markOrdered", "markSent"]) {
        h.pr = request({ status, receivedQty: status === "received" ? 100 : 0, approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0 });
        h.writes = [];
        const r = await act("owner", { intent, id: "pr1" });
        expect(r.status, `${intent} ${status}`).toBe(400);
        expect(h.writes).toEqual([]);
        expect(h.pr.status).toBe(status);
      }
    }
    // ...so a fully received request cannot be re-opened by those buttons and received again
    h.pr = request({ status: "received", receivedQty: 100, approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0 });
    await act("owner", { intent: "markOrdered", id: "pr1" });
    expect((await act("owner", { intent: "receiveRequest", id: "pr1", receiveQty: "100" })).status).toBe(400);
    expect(h.stockMoves).toEqual([]);
  }, 60_000);

  it("Mark PO sent on a partially received request keeps it partially received (received quantity is not hidden)", async () => {
    h.pr = request({ status: "partially_received", receivedQty: 40, approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0 });
    expect((await act("owner", { intent: "markSent", id: "pr1" })).status).toBe(200);
    expect(h.pr).toMatchObject({ status: "partially_received", receivedQty: 40, orderedAt: T0 });
  }, 60_000);

  it("Cancel refuses a fully received request; an open or partially received one can still be cancelled by an approver", async () => {
    h.pr = request({ status: "received", receivedQty: 100 });
    expect((await act("owner", { intent: "cancelRequest", id: "pr1" })).status).toBe(400);
    expect(h.pr.status).toBe("received");
    for (const status of ["requested", "ordered", "partially_received"]) {
      h.pr = request({ status });
      expect((await act("authorizedManager", { intent: "cancelRequest", id: "pr1" })).status, status).toBe(200);
      expect(h.pr.status).toBe("cancelled");
      expect(h.pr.cancelledAt).toBeInstanceOf(Date);
    }
  }, 60_000);

  it("receiving works only on an ordered request and adds exactly the received quantity once", async () => {
    expect((await act("bagger", { intent: "receiveRequest", id: "pr1", receiveQty: "10" })).status).toBe(400); // still only requested
    h.pr = request({ status: "ordered", approvedBy: "shopify-user:1005", approvedAt: T0, orderedAt: T0 });
    expect((await act("bagger", { intent: "receiveRequest", id: "pr1", receiveQty: "40" })).status).toBe(200);
    expect(h.pr).toMatchObject({ status: "partially_received", receivedQty: 40, approvedBy: "shopify-user:1005" });
    expect((await act("bagger", { intent: "receiveRequest", id: "pr1", receiveQty: "60" })).status).toBe(200);
    expect(h.pr).toMatchObject({ status: "received", receivedQty: 100 });
    expect(h.stockMoves.map((move) => move.delta)).toEqual([40, 60]);
    expect((await act("bagger", { intent: "receiveRequest", id: "pr1", receiveQty: "5" })).status).toBe(400);
    expect(h.stockMoves).toHaveLength(2);
  }, 60_000);
});

describe("nothing is ordered automatically, and staff are not shown approval buttons", () => {
  const src = readFileSync("app/routes/app.erp.purchase-requests.tsx", "utf8");
  const exportSrc = readFileSync("app/routes/app.erp.purchase-export.tsx", "utf8");

  it("the purchasing routes make no vendor, Shopify or other external call", () => {
    for (const text of [src, exportSrc]) {
      expect(text).not.toMatch(/\bfetch\(|admin\.graphql|draftOrderCreate|orderCreate|sendPurchaseOrder|nodemailer|sendMail/);
    }
  });

  it("the loader tells the page whether this viewer approves; Mark PO sent / Mark ordered / Cancel render only for approvers", async () => {
    const load = async (role: keyof typeof ROLES) => {
      h.sub = ROLES[role];
      return (await route.loader({ request: new Request("https://app.test/app/erp/purchase-requests") })).json();
    };
    for (const role of ["owner", "authorizedManager"] as const) expect((await load(role)).canApprove, role).toBe(true);
    for (const role of NON_APPROVERS) expect((await load(role)).canApprove, role).toBe(false);
    expect(src).toContain("{canApprove ? (<>");
    expect(src.indexOf("{canApprove ? (<>")).toBeLessThan(src.indexOf('name="intent" value="markSent"'));
    const cancelForm = src.indexOf('name="intent" value="cancelRequest"');
    expect(src.lastIndexOf("{canApprove ? (", cancelForm)).toBeGreaterThan(src.indexOf('name="intent" value="receiveRequest"'));
    // a requester's Status list offers only draft / requested (plus the current status)
    expect(src).toContain("canApprove ? statusOptions : statusOptions.filter((option) => REQUESTER_STATUSES.includes(option.value) || option.value === request.status)");
  }, 60_000);
});
