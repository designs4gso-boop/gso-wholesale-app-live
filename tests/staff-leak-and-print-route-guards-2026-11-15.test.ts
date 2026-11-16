// 2026-11-15 — two server-side gaps closed during overnight stabilization.
//
//   A. Quotes: when the margin rule blocked a staff action (send, approve,
//      deposit / balance order, invoice email, save), the error text returned
//      to the browser named the true margin % and the margin floor
//      ("margin 20.0% is below 40%"). With the selling price on screen that
//      gives away true cost. Non-owners now get plain workflow wording.
//   B. Print Logs, RIP Imports and Incoming Print Files had no role check on
//      the server (the menu simply did not link them). Sales and unassigned
//      accounts are now turned away before anything is read or written.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "9001", quote: null as any, calls: [] as string[], writes: [] as string[] }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const READS = ["findFirst", "findMany", "count", "findUnique", "aggregate", "groupBy"];
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      h.calls.push(`${name}.${method}`);
      if (!READS.includes(method)) { h.writes.push(`${name}.${method}`); if (name === "quote" && args?.data) Object.assign(h.quote, args.data); return { count: 1 }; }
      if (name === "quote") return method === "findMany" ? [h.quote] : method === "count" ? 1 : h.quote;
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});

const ROLES = { owner: "9001", manager: "1001", sales: "1002", print_operator: "1003", bagger: "1004", unassigned: "9999" } as const;
type Role = keyof typeof ROLES;
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: ROLES.owner, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };

/* One low-margin quote: price $10, true cost $8 -> 20% margin, below the 40% floor. */
const freshQuote = () => ({
  id: "q_1", shop: "shop-1", status: "draft", notes: "", customerName: "Acme", company: "Acme", email: null, phone: null,
  customerTier: "standard", customerTierLabel: null, createdAt: new Date(0), updatedAt: new Date(0),
  lowMarginApprovedAt: null, lowMarginApprovedBy: null, lowMarginApprovalReason: null, lowMarginApprovalThresholdPct: null, lowMarginApprovedSnapshot: null,
  items: [{ id: "i_1", quoteId: "q_1", productName: "Custom job", variant: null, sku: null, quantity: 10, unitPrice: 10, unitCost: 8, notes: null, priceSnapshot: null, costSnapshot: null, marginPct: 20 }],
});

let quotes: any, printLogs: any, ripImports: any, printIntake: any;
beforeAll(async () => {
  quotes = await import("../app/routes/app.quotes");
  printLogs = await import("../app/routes/app.erp.print-logs");
  ripImports = await import("../app/routes/app.erp.rip-imports");
  printIntake = await import("../app/routes/app.erp.print-intake");
}, 240_000);
beforeEach(() => { Object.assign(process.env, ENV); h.quote = freshQuote(); h.calls = []; h.writes = []; });
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

const quoteAction = async (role: Role, payload: unknown) => {
  h.sub = ROLES[role];
  const res: Response = await quotes.action({ request: new Request("https://app.test/app/quotes", { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } }) });
  return res.json();
};

describe("A. Quotes — a margin-blocked action never tells a non-owner the margin or the floor", () => {
  it.each(["manager", "sales"] as Role[])("%s: sending a low-margin quote is refused with plain wording (no %, no floor, no item margin)", async (role) => {
    const body = await quoteAction(role, { intent: "status", id: "q_1", status: "sent" });
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Owner Approval Required — ask the owner to approve this quote's price before continuing.");
    expect(body.error).not.toMatch(/\d+(\.\d+)?\s?%|margin|below|floor|threshold/i);
    expect(h.quote.status).toBe("draft");
    // nothing else in the response gives the margin away either
    expect(JSON.stringify(body)).not.toMatch(/20\.0%|below 40%|"unitCost":\s*8|blendedMarginPct|lowItems/);
  }, 60_000);

  it("the owner still gets the full reason (which item, its margin, the floor)", async () => {
    const body = await quoteAction("owner", { intent: "status", id: "q_1", status: "sent" });
    expect(body.ok).toBe(false);
    expect(body.error).toContain("margin 20.0% is below 40%");
  }, 60_000);

  it("every margin-block response in the Quotes action goes through the owner check (none returns the raw message)", () => {
    const src = readFileSync("app/routes/app.quotes.tsx", "utf8");
    expect(src).not.toMatch(/error: (marginState|saveMarginState)\.blockMessage/);
    expect(src.match(/error: marginBlockError\(marginState\.blockMessage\)/g)).toHaveLength(5);
    expect(src.match(/error: marginBlockError\(saveMarginState\.blockMessage\)/g)).toHaveLength(1);
    expect(src).toContain("const marginBlockError = (message: string) => (viewerIsOwner ? message : STAFF_MARGIN_BLOCK_MESSAGE);");
  });
});

describe("B. Print Logs / RIP Imports / Incoming Print Files need a production role on the server", () => {
  const pages: Array<[string, () => any, string]> = [
    ["Print Logs", () => printLogs, "/app/erp/print-logs"],
    ["RIP Imports", () => ripImports, "/app/erp/rip-imports"],
    ["Incoming Print Files", () => printIntake, "/app/erp/print-intake"],
  ];
  const open = async (route: any, path: string, role: Role) => {
    h.sub = ROLES[role];
    try {
      const res = await route.loader({ request: new Request(`https://app.test${path}`), params: {} });
      return { status: res instanceof Response ? res.status : 200, location: res instanceof Response ? res.headers.get("Location") : null };
    } catch (thrown: any) {
      if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("Location") };
      throw thrown;
    }
  };

  for (const [label, route, path] of pages) {
    it.each(["sales", "unassigned"] as Role[])(`${label}: %s is sent Home before anything is read`, async (role) => {
      const r = await open(route(), path, role);
      expect(r).toEqual({ status: 302, location: "/app" });
      expect(h.calls).toEqual([]);
    }, 60_000);

    it.each(["owner", "manager", "print_operator", "bagger"] as Role[])(`${label}: %s (a production role) still opens the page`, async (role) => {
      const r = await open(route(), path, role);
      expect(r.status).toBe(200);
      expect(h.calls.length).toBeGreaterThan(0);
    }, 60_000);
  }

  const forge = async (route: any, path: string, role: Role, fields: Record<string, string>) => {
    h.sub = ROLES[role];
    const res: Response = await route.action({ request: new Request(`https://app.test${path}`, { method: "POST", body: new URLSearchParams(fields) }), params: {} });
    return { status: res.status, body: await res.json() };
  };

  it.each(["sales", "unassigned"] as Role[])("%s: a forged print-log import, print-log match or RIP upload is refused (403) and touches nothing", async (role) => {
    for (const [route, path, fields] of [
      [printLogs, "/app/erp/print-logs", { intent: "importPrintLog", machine: "mimaki", logText: "job,1" }],
      [printLogs, "/app/erp/print-logs", { intent: "matchEntry", entryId: "e1", productionJobId: "j1" }],
      [ripImports, "/app/erp/rip-imports", { source: "versaworks" }],
    ] as Array<[any, string, Record<string, string>]>) {
      const r = await forge(route, path, role, fields);
      expect(r.status, `${path} ${fields.intent || "upload"}`).toBe(403);
      expect(r.body.ok).toBe(false);
      expect(r.body.message).toContain("Your role can't do this on a production job.");
    }
    expect(h.calls).toEqual([]);
    expect(h.writes).toEqual([]);
  }, 60_000);

  it("each guard sits before the first database call of its loader / action", () => {
    for (const file of ["app.erp.print-logs", "app.erp.rip-imports", "app.erp.print-intake"]) {
      const src = readFileSync(`app/routes/${file}.tsx`, "utf8");
      const loader = src.slice(src.indexOf("export async function loader"), src.indexOf("export async function action"));
      const guard = loader.indexOf("if (!roleMayViewProduction(resolveStaffAccess(auth).role)) throw redirect(PRODUCTION_VIEW_DENIED_REDIRECT);");
      expect(guard, file).toBeGreaterThan(0);
      const firstDb = loader.search(/\bdb\.|ensureSetting\(|await load|await get/);
      if (firstDb >= 0) expect(guard, file).toBeLessThan(firstDb);
    }
    for (const file of ["app.erp.print-logs", "app.erp.rip-imports"]) {
      const src = readFileSync(`app/routes/${file}.tsx`, "utf8");
      const action = src.slice(src.indexOf("export async function action"));
      const guard = action.indexOf("if (!roleMayViewProduction(printStaff.role)) return Response.json(");
      expect(guard, file).toBeGreaterThan(0);
      expect(guard, file).toBeLessThan(action.indexOf("request.formData()"));
    }
  });
});
