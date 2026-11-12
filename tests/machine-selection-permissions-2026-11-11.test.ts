// 2026-11-11 OWNER RULE — manual printer selection: Owner + authorized Print
// Operator only. Managers, Sales, Baggers and unknown staff get AUTO; a forged
// "printer" field is ignored on the server. Print Intake review actions need
// manageIntake (owner / manager / print operator).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", captured: [] as any[], intakeWrites: [] as any[] }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));
vi.mock("../app/db.server", () => {
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any) => {
      if (name === "printIntake" && method === "findFirst") return { id: "pi1", shop: "shop-1", status: "needs_review", originalFilename: "a.pdf", rawParsedHints: null, reviewReason: null, fileHashSha256: "x".repeat(64) };
      if (name === "printIntake" && method === "update") { h.intakeWrites.push(args); return {}; }
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});
vi.mock("../app/lib/production-job-source.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, createProductionJobFromSource: async (_db: any, input: any) => { h.captured.push(input); return { created: true, job: { id: "j1", jobTicket: "GSO-1", items: [] } }; } };
});

const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: "77055393857", GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };
// the production route module is large: import it once up front
beforeAll(async () => { await import("../app/routes/app.erp.production"); await import("../app/routes/app.erp.print-intake"); }, 180_000);
beforeEach(() => { Object.assign(process.env, ENV); h.captured = []; h.intakeWrites = []; });
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

async function createManualJob(sub: string, printer: string) {
  h.sub = sub;
  const route = await import("../app/routes/app.erp.production");
  const body = new URLSearchParams({ intent: "createManualJob", customerName: "Walk-in", itemTitle: "Labels", quantity: "100", printer, requestId: `r-${sub}-${printer}` });
  await route.action({ request: new Request("https://app.test/app/erp/production", { method: "POST", body }) } as any);
  return h.captured.at(-1)?.source?.payload?.items?.[0]?.printer;
}

describe("manual printer selection (server-side)", () => {
  it("owner may choose a compatible printer", async () => {
    expect(await createManualJob("77055393857", "roland")).toBe("roland");
  });
  it("authorized print operator may choose", async () => {
    expect(await createManualJob("1003", "mimaki")).toBe("mimaki");
  });
  it.each([["sales", "1002"], ["bagger", "1004"], ["manager (not granted by default)", "1001"], ["unknown staff", "9999"]])("%s: a forged printer field is ignored -> AUTO", async (_label, sub) => {
    expect(await createManualJob(sub, "roland")).toBe("auto");
  });
});

describe("Print Intake review actions need manageIntake", () => {
  async function release(sub: string) {
    h.sub = sub;
    const route = await import("../app/routes/app.erp.print-intake");
    const body = new URLSearchParams({ intent: "release", intakeId: "pi1" });
    return (await route.action({ request: new Request("https://app.test/app/erp/print-intake", { method: "POST", body }) } as any)) as any;
  }
  it("owner / manager / print operator allowed; sales / bagger / unknown denied with no write", async () => {
    for (const sub of ["77055393857", "1001", "1003"]) expect((await release(sub)).ok, sub).toBe(true);
    const writesBefore = h.intakeWrites.length;
    for (const sub of ["1002", "1004", "9999"]) {
      const result = await release(sub);
      expect(result.ok, sub).toBe(false);
      expect(result.message).toMatch(/Print Intake review actions/);
    }
    expect(h.intakeWrites.length).toBe(writesBefore);
  });
});
