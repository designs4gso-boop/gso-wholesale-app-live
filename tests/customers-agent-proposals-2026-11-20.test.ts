// 2026-11-20 — Customers (account side of the CRM), the signed agent proposal
// endpoint, and the agent registry -> approval queue link.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "1", shop: "shop-1", t: {} as Record<string, any[]>, seq: 0, clock: Date.parse("2026-11-20T15:00:00Z") }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: h.shop, isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const OPS = new Set(["in", "not", "contains", "mode", "equals", "gte", "lte", "some"]);
  const same = (a: any, b: any) => (a ?? null) === (b ?? null);
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (!Object.keys(value).some((k) => OPS.has(k))) return match(row, value);
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return !same(row[key], value.not);
      if ("equals" in value) return String(row[key] ?? "").toLowerCase() === String(value.equals).toLowerCase() && row[key] != null;
      if ("gte" in value) return row[key] != null && new Date(row[key]).getTime() >= new Date(value.gte).getTime();
      if ("contains" in value) return String(row[key] || "").toLowerCase().includes(String(value.contains).toLowerCase());
      return true;
    }
    return same(row[key], value);
  });
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const list = rows(name);
      if (method === "findFirst" || method === "findUnique") { const found = list.filter((row) => match(row, args.where))[0]; return found ? { ...found } : null; }
      if (method === "findMany") return list.filter((row) => match(row, args.where)).map((row) => (name === "productionJob" ? { ...row, items: rows("productionJobItem").filter((item) => item.jobId === row.id) } : { ...row }));
      if (method === "count") return list.filter((row) => match(row, args.where)).length;
      if (method === "create") { const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date((h.clock += 1000)), updatedAt: new Date(h.clock), ...args.data }; list.push(row); return { ...row }; }
      if (method === "upsert") {
        const found = list.filter((row) => match(row, args.where))[0];
        if (found) { Object.assign(found, args.update); return { ...found }; }
        const row: any = { ...args.create }; list.push(row); return { ...row };
      }
      if (method === "update" || method === "updateMany") { const found = list.filter((row) => match(row, args.where)); found.forEach((row) => Object.assign(row, args.data)); return method === "update" ? { ...found[0] } : { count: found.length }; }
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : model(key)) });
  return { default: db, db };
});

import db from "../app/db.server";
import { accountLinks, accountMatchConditions, addAccountNote, createAccount, customersNotYetAdded, parseAccountInput, setAccountActive, updateAccount } from "../app/lib/crm-accounts.server";
import { convertLeadToAccount, createLead } from "../app/lib/crm.server";
import { AGENT_PROPOSAL_SCOPE, credentialAllowsIntake, credentialAllowsProposals, sha256Hex } from "../app/lib/agent-security.server";
import { submitApproval } from "../app/lib/agent-approvals.server";
import { agentMayPropose, agentProposalProfiles, AGENT_REGISTRY } from "../app/lib/ops/agent-registry";
import { INTERNAL_APPROVAL_ACTIONS } from "../app/lib/ops/autonomy";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { ROUTE_ACCESS } from "../app/lib/route-access";
import { navForRole } from "../app/lib/simple-nav";

const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const ROLE_SUB: Record<string, string> = { owner: "1", manager: "2", sales: "3", print_operator: "4", bagger: "5", unassigned: "9" };
const as = (role: string) => { h.sub = ROLE_SUB[role]; };
const post = (fields: Record<string, string>) => { const body = new FormData(); Object.entries(fields).forEach(([k, v]) => body.set(k, v)); return new Request("https://erp.test/x", { method: "POST", body }); };
const statusOf = async (run: () => Promise<any>) => { try { const out = await run(); return out instanceof Response ? out.status : 200; } catch (thrown) { if (thrown instanceof Response) return thrown.status; throw thrown; } };

beforeEach(() => {
  h.t = {}; h.seq = 0; h.shop = "shop-1"; as("owner");
  Object.assign(process.env, { GSO_OWNER_SHOPIFY_USER_IDS: "1", GSO_STAFF_ROLES: "2:manager,3:sales,4:print_operator,5:bagger" });
  delete process.env.GSO_OWNER_ENFORCEMENT;
});

describe("TRACK 1 — Customers", () => {
  const seedWork = () => {
    h.t.quote = [
      { id: "q1", shop: "shop-1", company: "Krud Cafe", customerName: "Sam", email: "sam@krud.test", status: "paid", updatedAt: new Date("2026-11-10"), unitPrice: 9 },
      { id: "q2", shop: "shop-1", company: "KRUD CAFE", customerName: "Someone else", email: null, status: "draft", updatedAt: new Date("2026-11-12") },
      { id: "q3", shop: "shop-1", company: "Krud Cafeteria", customerName: "Lee", email: "lee@other.test", status: "draft", updatedAt: new Date("2026-11-13") },
      { id: "q4", shop: "shop-2", company: "Krud Cafe", email: "sam@krud.test", status: "draft", updatedAt: new Date("2026-11-14") },
    ];
    h.t.productionJob = [
      { id: "j1", shop: "shop-1", jobTicket: "GSO-20261001-0007", customerName: "Krud Cafe", company: null, email: null, status: "completed", createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-05") },
      { id: "j2", shop: "shop-1", jobTicket: "GSO-20261115-0003", customerName: "Sam", company: null, email: "SAM@krud.test", status: "printing", createdAt: new Date("2026-11-15"), updatedAt: new Date("2026-11-18") },
      { id: "j3", shop: "shop-1", jobTicket: "GSO-20261101-0001", customerName: "Leaf Labs", status: "completed", createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-02") },
    ];
    h.t.productionJobItem = [
      { id: "i1", shop: "shop-1", jobId: "j1", itemTicket: "GSO-20261001-0007-01", productTitle: "HEATH pouch", quantity: 128, unitCost: 0.31 },
      { id: "i2", shop: "shop-1", jobId: "j2", itemTicket: "GSO-20261115-0003-01", productTitle: "HEATH pouch", quantity: 256, reorderSourceItemId: "i1" },
      { id: "i3", shop: "shop-1", jobId: "j3", itemTicket: "GSO-20261101-0001-01", productTitle: "Leaf jar", quantity: 500 },
    ];
  };

  it("uses the one customer record: no second customer model exists", () => {
    const schema = src("prisma/schema.prisma");
    expect(schema.match(/^model (Customer|CrmCustomer|Account|ClientAccount) \{/m)).toBeNull();
    expect(schema).toContain("model CrmAccount {");
    expect(src("app/lib/crm-accounts.server.ts")).not.toMatch(/crmAccount\.delete|\.deleteMany\(/);
  });

  it("add, edit, note, deactivate — with history; the same email is one customer", async () => {
    expect(parseAccountInput({ phone: "555" }).ok).toBe(false);
    const first = await createAccount(db, { shop: "shop-1", actor: "Dana", fields: { company: "Krud Cafe", contactName: "Sam", email: "Sam@Krud.test" } });
    const again = await createAccount(db, { shop: "shop-1", actor: "Dana", fields: { company: "Krud", email: "sam@krud.test" } });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false, accountId: (first as any).accountId });
    expect(h.t.crmAccount).toHaveLength(1);
    const id = (first as any).accountId as string;
    expect((await updateAccount(db, { shop: "shop-2", id, actor: "X", fields: { company: "Hacked" } })).ok).toBe(false);
    expect((await updateAccount(db, { shop: "shop-1", id, actor: "Dana", fields: { company: "Krud Cafe", contactName: "Sam", email: "sam@krud.test", phone: "555-0100" } })).ok).toBe(true);
    expect((await addAccountNote(db, { shop: "shop-1", id, actor: "Dana", note: "Prefers pickup" })).ok).toBe(true);
    expect((await setAccountActive(db, { shop: "shop-1", id, actor: "Dana", active: false })).ok).toBe(true);
    expect(h.t.crmAccount[0]).toMatchObject({ phone: "555-0100", active: false, source: "manual" });
    expect(h.t.crmAccount).toHaveLength(1); // inactive, not deleted
    expect(h.t.crmAccountEvent.map((event) => event.event)).toEqual(["created", "edited", "note", "deactivated"]);
  });

  it("a customer's quotes, jobs, items and reorders are found by EXACT email or company — never a similar name, never another shop", async () => {
    seedWork();
    const { accountId } = (await createAccount(db, { shop: "shop-1", actor: "Dana", fields: { company: "Krud Cafe", email: "sam@krud.test" } })) as any;
    const account = h.t.crmAccount.find((row) => row.id === accountId);
    const links = await accountLinks(db, "shop-1", account);
    expect(links.quotes.map((quote: any) => quote.id).sort()).toEqual(["q1", "q2"]); // not "Krud Cafeteria", not shop-2
    expect(links.jobs.map((job: any) => job.id).sort()).toEqual(["j1", "j2"]); // by company-as-customer-name and by email
    expect(links.items.map((item) => item.itemTicket).sort()).toEqual(["GSO-20261001-0007-01", "GSO-20261115-0003-01"]);
    expect(links.reorders).toBe(1);
    expect(links.lastActivityAt).toBeInstanceOf(Date);
    expect(accountMatchConditions({ email: null, company: null })).toBeNull();
    expect((await accountLinks(db, "shop-1", { id: "x", email: null, company: null })).jobs).toEqual([]);
  });

  it("a lead that becomes a customer keeps its lineage and source", async () => {
    const lead = ((await createLead(db, { shop: "shop-1", actor: "Dana", fields: { company: "Bud Co", email: "a@bud.test", source: "referral" } })) as any).lead;
    const converted = (await convertLeadToAccount(db, { shop: "shop-1", id: lead.id, actor: "Dana" })) as any;
    const account = h.t.crmAccount.find((row) => row.id === converted.accountId);
    expect(account.source).toBe("referral");
    expect((await accountLinks(db, "shop-1", account)).leads.map((row: any) => row.id)).toEqual([lead.id]);
  });

  it("people on quotes and jobs who are not customers yet are OFFERED, never added automatically", async () => {
    seedWork();
    await createAccount(db, { shop: "shop-1", actor: "Dana", fields: { company: "Krud Cafe", email: "sam@krud.test" } });
    const offered = await customersNotYetAdded(db, "shop-1");
    expect(offered.map((row) => row.company || row.email).sort()).toEqual(["Krud Cafeteria", "Leaf Labs"]);
    expect(h.t.crmAccount).toHaveLength(1);
  });

  it("through the real pages: list, detail, permissions, and no money in the payload", async () => {
    seedWork();
    const list = await import("../app/routes/app.erp.customers");
    const page = await import("../app/routes/app.erp.customers.$id");
    as("sales");
    const created = await (await list.action({ request: post({ intent: "createCustomer", company: "Krud Cafe", email: "sam@krud.test", source: "quote" }) })).json();
    expect(created).toMatchObject({ ok: true });
    const data = await (await list.loader({ request: new Request("https://erp.test/app/erp/customers") })).json();
    expect(data.customers[0]).toMatchObject({ name: "Krud Cafe", quotes: 2, jobs: 2, reorders: 1, status: "Active", source: "quote" });
    expect(data.notYetAdded.length).toBe(2);
    const detail = await (await page.loader({ request: new Request("https://erp.test/x"), params: { id: created.accountId } })).json();
    expect(detail.jobs.map((job: any) => job.jobTicket).sort()).toEqual(["GSO-20261001-0007", "GSO-20261115-0003"]);
    expect(detail.items).toHaveLength(2);
    expect(detail.canOpenProduction).toBe(false); // sales gets no production link
    expect(JSON.stringify([data, detail])).not.toMatch(/unitCost|unitPrice|margin|costSnapshot/);
    as("owner");
    expect((await (await page.loader({ request: new Request("https://erp.test/x"), params: { id: created.accountId } })).json()).canOpenProduction).toBe(true);
    for (const role of ["print_operator", "bagger", "unassigned"]) {
      as(role);
      expect(await statusOf(() => list.loader({ request: new Request("https://erp.test/x") }))).toBe(403);
      expect(await statusOf(() => list.action({ request: post({ intent: "createCustomer", company: "Nope" }) }))).toBe(403);
      expect(await statusOf(() => page.loader({ request: new Request("https://erp.test/x"), params: { id: created.accountId } }))).toBe(403);
      expect(await statusOf(() => page.action({ request: post({ intent: "deactivate" }), params: { id: created.accountId } }))).toBe(403);
    }
    as("owner"); h.shop = "shop-2";
    expect(await statusOf(() => page.loader({ request: new Request("https://erp.test/x"), params: { id: created.accountId } }))).toBe(404);
    expect(ROUTE_ACCESS["erp/customers"]).toBe("commercial");
    expect(navForRole("sales").flatMap((section) => section.links.map((link) => link.href))).toContain("/app/erp/customers");
    expect(navForRole("print_operator").flatMap((section) => section.links.map((link) => link.href))).not.toContain("/app/erp/customers");
  }, 120_000);
});

describe("TRACK 3 — agent registry -> approval queue", () => {
  it("every agent that may propose has a profile: what, from where, approval always, external execution disabled", () => {
    const profiles = agentProposalProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(5);
    for (const profile of profiles) {
      expect(AGENT_REGISTRY.some((agent) => agent.id === profile.agentKey)).toBe(true);
      expect(profile.permittedProposalTypes.length).toBeGreaterThan(0);
      expect(profile.permittedProposalTypes.every((action) => INTERNAL_APPROVAL_ACTIONS.includes(action))).toBe(true);
      expect(profile.inputSource.length).toBeGreaterThan(0);
      expect(profile).toMatchObject({ approvalRequirement: "a person approves every proposal", externalExecution: "disabled" });
    }
    const byKey = Object.fromEntries(profiles.map((profile) => [profile.agentKey, profile.permittedProposalTypes]));
    expect(byKey.lead_manager).toEqual(["suggest_lead_assignment"]);
    expect(byKey.reorder_agent).toEqual(["submit_outreach_draft", "propose_reorder"]);
    expect(byKey.customer_followup).toEqual(["submit_outreach_draft", "propose_followup"]);
    expect(byKey.quote_prep).toEqual(["propose_quote"]);
  });

  it("the registry is the rule: an agent cannot propose outside its list, an unknown agent nothing, and no agent a sending action", async () => {
    expect(agentMayPropose("lead_manager", "suggest_lead_assignment")).toBe(true);
    expect(agentMayPropose("lead_manager", "submit_outreach_draft")).toBe(false);
    expect(agentMayPropose("production_planner", "propose_quote")).toBe(false);
    expect(agentMayPropose("not_an_agent", "propose_quote")).toBe(false);
    for (const agent of AGENT_REGISTRY) for (const action of ["send_customer_notification", "send_invoice", "refund_or_void", "post_slack_external"]) expect(agentMayPropose(agent.id, action)).toBe(false);
    const intents = createMemoryRepositories().intents;
    const refused = await submitApproval(intents, { shop: "shop-1", actionType: "submit_outreach_draft", agentId: "lead_manager", entityType: "none", entityId: "none", reason: "x", idempotencyKey: "k-12345678", proposedBy: { type: "agent", id: "a" } });
    expect(refused).toMatchObject({ ok: false });
    expect(await intents.list({})).toEqual([]);
  });
});

describe("TRACK 2 — signed agent proposal endpoint", () => {
  const SECRET = "s3cret-token-value";
  const credential = (overrides: Record<string, unknown> = {}) => ({ id: "cred-1", shop: "shop-1", agentId: "agent_abc", agentName: "Outreach GPT", tokenId: "gso_tok", tokenHash: sha256Hex(SECRET), scopes: ["intake:create", AGENT_PROPOSAL_SCOPE], isActive: true, revokedAt: null, ...overrides });
  const proposal = (overrides: Record<string, unknown> = {}) => ({ agentKey: "customer_followup", actionType: "submit_outreach_draft", entityType: "crm_lead", entityId: "lead-1", payload: { channel: "email", message: "Hi Sam — your samples shipped." }, reason: "Follow up after samples", idempotencyKey: "proposal-0001", ...overrides });
  const signed = (body: unknown, options: { secret?: string; tokenId?: string; timestamp?: string; signature?: string } = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const timestamp = options.timestamp ?? String(Date.now());
    const signature = options.signature ?? crypto.createHmac("sha256", options.secret ?? SECRET).update(`${timestamp}.${raw}`).digest("hex");
    return new Request("https://erp.test/api/agent/proposals", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${options.tokenId ?? "gso_tok"}.${options.secret ?? SECRET}`, "x-gso-agent-timestamp": timestamp, "x-gso-agent-signature": signature }, body: raw });
  };
  const call = async (request: Request) => { const route = await import("../app/routes/api.agent.proposals"); const response = await route.action({ request }); return { status: response.status, body: await response.json() }; };
  const intents = () => h.t.opsActionIntent || [];
  beforeEach(() => {
    h.t.agentApiCredential = [credential()];
    h.t.crmLead = [{ id: "lead-1", shop: "shop-1", status: "new" }, { id: "lead-other-shop", shop: "shop-2", status: "new" }];
  });

  it("the proposal scope is explicit: a legacy or intake-only credential can never propose", () => {
    expect(credentialAllowsProposals(["intake:create", "proposal:create"])).toBe(true);
    expect(credentialAllowsProposals(["intake:create"])).toBe(false);
    expect(credentialAllowsProposals(null)).toBe(false); // legacy: intake yes, proposals no
    expect(credentialAllowsIntake(null)).toBe(true);
    expect(credentialAllowsProposals("proposal:create")).toBe(false);
  });

  it("a signed proposal lands in the approval queue of the credential's shop, awaiting a person", async () => {
    const { status, body } = await call(signed(proposal()));
    expect(status).toBe(201);
    expect(body).toMatchObject({ ok: true, duplicate: false, status: "awaiting_approval", approvalRequired: true });
    expect(intents()).toHaveLength(1);
    expect(intents()[0]).toMatchObject({ shop: "shop-1", status: "AWAITING_APPROVAL", actionType: "submit_outreach_draft", agentId: "customer_followup", entityType: "crm_lead", entityId: "lead-1", createdByType: "agent", createdById: "agent_abc", approvedById: null });
    expect(intents()[0].payload).toEqual({ channel: "email", message: "Hi Sam — your samples shipped." });
    // it shows up for the owner on the Approvals screen
    const { listApprovals } = await import("../app/lib/agent-approvals.server");
    const { PrismaActionIntentRepository } = await import("../app/lib/ops/prisma-repositories.server");
    expect((await listApprovals(new PrismaActionIntentRepository(), "shop-1")).map((intent) => intent.id)).toEqual([body.proposalId]);
    expect(await listApprovals(new PrismaActionIntentRepository(), "shop-2")).toEqual([]);
    expect(h.t.agentSubmissionLog.at(-1)).toMatchObject({ status: "accepted", shop: "shop-1", credentialId: "cred-1" });
  }, 120_000);

  it("REPLAY: the same proposal sent again (and five times at once) is ONE proposal", async () => {
    const first = await call(signed(proposal()));
    const again = await call(signed(proposal()));
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => call(signed(proposal()))));
    expect(again).toMatchObject({ status: 200, body: { ok: true, duplicate: true, proposalId: first.body.proposalId } });
    expect(burst.every((result) => result.body.proposalId === first.body.proposalId)).toBe(true);
    expect(intents()).toHaveLength(1);
    // a different key is a different proposal; the same key from another credential is not confused with it
    await call(signed(proposal({ idempotencyKey: "proposal-0002" })));
    expect(intents()).toHaveLength(2);
  }, 120_000);

  it("authentication: missing headers, unknown token, wrong secret, stale timestamp, tampered body, revoked credential — nothing is written", async () => {
    const raw = JSON.stringify(proposal());
    const noAuth = new Request("https://erp.test/api/agent/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    expect((await call(noAuth)).status).toBe(401);
    expect((await call(signed(proposal(), { tokenId: "gso_unknown" }))).status).toBe(401);
    expect((await call(signed(proposal(), { secret: "wrong-secret" }))).status).toBe(401);
    expect((await call(signed(proposal(), { timestamp: String(Date.now() - 60 * 60 * 1000) }))).status).toBe(401);
    const good = signed(proposal());
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: JSON.stringify(proposal({ reason: "changed after signing" })) });
    expect((await call(tampered)).status).toBe(401);
    h.t.agentApiCredential = [credential({ revokedAt: new Date() })];
    expect((await call(signed(proposal()))).status).toBe(403);
    h.t.agentApiCredential = [credential({ scopes: ["intake:create"] })];
    expect((await call(signed(proposal()))).status).toBe(403);
    h.t.agentApiCredential = [credential({ scopes: null })];
    expect((await call(signed(proposal()))).status).toBe(403);
    expect(intents()).toEqual([]);
    const get = await (await import("../app/routes/api.agent.proposals")).loader();
    expect(get.status).toBe(405);
  }, 120_000);

  it("an agent cannot ask for anything that sends, orders or charges, nor act as an agent the registry does not allow", async () => {
    for (const actionType of ["send_customer_notification", "send_invoice", "refund_or_void", "post_slack_external", "move_production_job", "change_cost_or_price"]) {
      expect((await call(signed(proposal({ actionType, idempotencyKey: `bad-${actionType}` })))).status).toBe(422);
    }
    expect((await call(signed(proposal({ agentKey: "lead_manager" })))).status).toBe(403); // lead_manager may not draft outreach
    expect((await call(signed(proposal({ agentKey: "made_up_agent" })))).status).toBe(403);
    expect((await call(signed(proposal({ idempotencyKey: "short" })))).status).toBe(422);
    expect((await call(signed(proposal({ reason: "" })))).status).toBe(422);
    expect((await call(signed("[1,2,3]"))).status).toBe(400);
    expect(intents()).toEqual([]);
  }, 120_000);

  it("tenant safety: the shop comes from the credential; another shop's lead is 'not found'; a body cannot name a shop", async () => {
    expect((await call(signed(proposal({ entityId: "lead-other-shop" })))).status).toBe(422);
    expect((await call(signed(proposal({ entityId: "no-such-lead" })))).status).toBe(422);
    expect((await call(signed(proposal({ entityType: "session" })))).status).toBe(422);
    const { body } = await call(signed({ ...proposal(), shop: "shop-2", status: "APPROVED", approvedBy: "agent" }));
    expect(body.ok).toBe(true);
    expect(intents()).toHaveLength(1);
    expect(intents()[0]).toMatchObject({ shop: "shop-1", status: "AWAITING_APPROVAL", approvedById: null });
  }, 120_000);

  it("rate limit and oversized bodies are refused", async () => {
    h.t.agentSubmissionLog = Array.from({ length: 10 }, (_, index) => ({ id: `log-${index}`, credentialId: "cred-1", status: "accepted", createdAt: new Date() }));
    expect((await call(signed(proposal()))).status).toBe(429);
    h.t.agentSubmissionLog = [];
    expect((await call(signed(proposal({ payload: { message: "x".repeat(20000) } })))).status).toBe(413);
    expect(intents()).toEqual([]);
  }, 120_000);

  it("approval of an agent proposal still needs a person, and the endpoint has no path to the outside world", async () => {
    const { body } = await call(signed(proposal({ actionType: "propose_followup", payload: { followUpDate: "2026-11-25" }, idempotencyKey: "follow-0001" })));
    const { decideApproval } = await import("../app/lib/agent-approvals.server");
    const { PrismaActionIntentRepository } = await import("../app/lib/ops/prisma-repositories.server");
    const repo = new PrismaActionIntentRepository();
    expect((await decideApproval(repo, db, { shop: "shop-1", id: body.proposalId, decision: "approve", approver: { userId: "3", actor: "Sales", role: "sales" } })).ok).toBe(false);
    expect(h.t.crmLead[0].nextFollowUpAt).toBeUndefined();
    expect(await decideApproval(repo, db, { shop: "shop-1", id: body.proposalId, decision: "approve", approver: { userId: "1", actor: "Owner", role: "owner" } })).toMatchObject({ ok: true, status: "COMPLETED" });
    expect(new Date(h.t.crmLead[0].nextFollowUpAt).toISOString().slice(0, 10)).toBe("2026-11-25");
    const code = src("app/routes/api.agent.proposals.tsx");
    expect(code).not.toMatch(/fetch\(|sendEmail|nodemailer|twilio|SlackClient|admin\.graphql|draftOrder|productionJob\.|quote\.create/);
    expect(code).toContain("credentialAllowsProposals(credential.scopes)");
    expect(src("app/routes.ts")).toContain('route("api/agent/proposals", "routes/api.agent.proposals.tsx")');
  }, 120_000);

  it("the owner grants the proposal scope explicitly when creating a credential", () => {
    const page = src("app/routes/app.erp.agent-security.tsx");
    expect(page).toContain('scopes: formData.get("allowProposals") === "on" ? [INTAKE_SCOPE, PROPOSAL_SCOPE] : [INTAKE_SCOPE],');
    expect(page).toContain("requireOwner(auth)");
  });
});

describe("TRACK 7 — run cost in dollars (partial, never invented)", () => {
  it("ink and press time per run, by cost class; material / labour / finishing are named as not included", async () => {
    const { runCostDollars, RUN_COST_NOT_INCLUDED } = await import("../app/lib/run-cost-dollars.server");
    const { redactJobFinancials } = await import("../app/lib/production-financial-redaction");
    const rates: any = [{ brand: "mimaki", cmykPerMl: 0.1, whitePerMl: 0.2, glossPerMl: 0.09, blendedPerMl: 0.1, source: "test", missing: [] }];
    const runs: any[] = [
      { itemId: "i1", runNumber: 1, kind: "original", quantity: 500 },
      { itemId: "i1", runNumber: 2, kind: "reprint", quantity: 25, chargeType: "internal", runLabel: "P1-A1" },
      { itemId: "i1", runNumber: 3, kind: "remake", quantity: 40, chargeType: "customer_paid", runLabel: "P2-A1" },
    ];
    const entry = (name: string, cmyk: number, minutes: number, machineName: string | null = "Mimaki UCJV300") => ({ sourceJobName: name, machineName, printerSoftware: machineName ? "RasterLink" : null, cmykInkMl: cmyk, whiteInkMl: 0, glossInkMl: 0, inkMl: cmyk, printMinutes: minutes });
    const cost = runCostDollars(runs, [entry("GSO-1-01__a_CMYK", 30, 60), entry("GSO-1-01__a_CMYK__P1-A1", 2, 12), entry("GSO-1-01__a_CMYK__P2-A1", 4, 6)], rates, 5);
    expect(cost.runs.map((row) => [row.runNumber, row.costClass, row.pressCost])).toEqual([[1, "original", 5], [2, "internal_extra", 1], [3, "customer_paid_extra", 0.5]]);
    for (const row of cost.runs) { expect(row.partial).toBe(true); expect(row.knownCost).toBeCloseTo((row.inkCost || 0) + row.pressCost, 2); }
    expect(cost.shopAbsorbed).toBe(cost.runs[1].knownCost);
    expect(cost.customerPaid).toBe(cost.runs[2].knownCost);
    expect(cost.revenueChange).toBe("none");
    expect(cost.notIncluded).toEqual(RUN_COST_NOT_INCLUDED);
    // a press result that cannot be attributed to a machine is not given an invented ink cost
    const unknown = runCostDollars(runs, [{ ...entry("mystery_file", 10, 30, null), sourceJobName: "mystery_file" }], rates, 5);
    expect(unknown.runs[0]).toMatchObject({ inkCost: null, inkIncomplete: true, pressCost: 2.5, knownCost: 2.5 });
    // never sent to a non-financial viewer
    expect(redactJobFinancials({ items: [{ id: "i1", runCosts: cost }] }).items[0].runCosts).toBeNull();
    const loader = src("app/routes/app.erp.production.tsx");
    expect(loader).toContain("if (financials.show) item.runCosts = runCostDollars(");
    expect(src("app/lib/run-cost-dollars.server.ts")).not.toMatch(/db\.|prisma|applicationSeconds|labou?rRate\s*=/);
  });
});

describe("TRACK 6 — cost snapshot coverage", () => {
  const now = new Date("2026-11-20T16:00:00Z");
  it("stickers are captured from the sticker engine's own cost run; the cost never rides on the price result", async () => {
    const { priceStickerConfiguration, stickerCostOf } = await import("../app/lib/canonical-sticker-pricing.server");
    const { storefrontCostSnapshotFor, NOT_CAPTURED_REASON } = await import("../app/lib/storefront-cost-snapshot.server");
    const inputs: any = { available: true, reasons: [], matte: { name: "Poseidon Matte Vinyl", costPerSqft: 0.26 }, holographic: { name: "Holographic Vinyl", costPerSqft: 1.2 }, rolandSqftPerHour: 150, policyValues: undefined };
    const priced: any = priceStickerConfiguration(inputs, { productType: "sticker_regular", widthIn: 3, heightIn: 3, quantity: 500, material: "Matte", specialty: "Standard — 0X" });
    if (!priced.ok) throw new Error(`fixture: ${priced.reason}`);
    const cost = stickerCostOf(priced)!;
    expect(cost.totalCost).toBeGreaterThan(0);
    expect(JSON.stringify(priced)).not.toMatch(/totalCost|unitCost|costLines/); // nothing a storefront response could leak
    const canonical = { v: priced.version, family: "stickers", profile: "sticker_regular", stickerType: priced.stickerType, widthIn: 3, heightIn: 3, areaSqIn: 9, qty: 500, material: "Matte", holo: false, whiteRequired: false, specialtyX: 0, finishLabel: "Standard — 0X", cutType: priced.cutType, unitPrice: priced.unitPrice, engine: priced.engine };
    const item = { quantity: 500, unitPrice: priced.unitPrice, priceSnapshot: JSON.stringify({ productFamily: "Stickers", canonical }) };
    const snapshot: any = storefrontCostSnapshotFor(item, null, now, inputs);
    expect(snapshot).toMatchObject({ status: "captured", family: "Stickers", quantity: 500, note: "Stickers carry no application labour." });
    expect(snapshot.totalCost).toBeCloseTo(cost.totalCost, 2);
    expect(storefrontCostSnapshotFor(item, null, now, null)).toMatchObject({ status: "not_captured" });
    // jars and DTP stay not captured, each with its exact reason — nothing is estimated
    expect(storefrontCostSnapshotFor({ quantity: 128, unitPrice: 2, priceSnapshot: JSON.stringify({ productFamily: "Jars", canonical: { family: "jars" } }) }, null, now, inputs)).toMatchObject({ status: "not_captured", reason: NOT_CAPTURED_REASON.jars });
    expect(storefrontCostSnapshotFor({ quantity: 1000, unitPrice: 1, priceSnapshot: JSON.stringify({ productFamily: "DTP Pouches", canonical: { family: "dtp-bags" } }) }, null, now, inputs)).toMatchObject({ status: "not_captured", reason: NOT_CAPTURED_REASON.dtp });
    expect(NOT_CAPTURED_REASON.jars).toContain("which labels");
    expect(NOT_CAPTURED_REASON.dtp).toContain("freight is not verified");
  });
});

describe("TRACK 14 — Release to Production refuses anything ambiguous", () => {
  it("a production item with no quantity or no name blocks release; a complete review is ready", async () => {
    const { releaseReadiness } = await import("../app/lib/staged-transaction.server");
    const line = (items: any[]) => JSON.stringify([{ key: "1", description: "x", quantity: null, classification: "production", productionItems: items }]);
    expect(releaseReadiness({ status: "staged", customerName: "Krud", lines: line([{ productTitle: "HEATH", quantity: 128 }]) })).toMatchObject({ ok: true });
    for (const bad of [[{ productTitle: "HEATH", quantity: 0 }], [{ productTitle: "HEATH" }], [{ productTitle: "HEATH", quantity: 1.5 }], [{ productTitle: "", quantity: 5 }]]) {
      expect(releaseReadiness({ status: "staged", customerName: "Krud", lines: line(bad) }).ok).toBe(false);
    }
    expect(releaseReadiness({ status: "staged", customerName: "", lines: line([{ productTitle: "HEATH", quantity: 1 }]) }).ok).toBe(false);
    expect(releaseReadiness({ status: "released", customerName: "Krud", lines: line([{ productTitle: "HEATH", quantity: 1 }]) }).ok).toBe(false);
    const route = src("app/routes/app.erp.release-queue.tsx");
    expect(route).toContain("The invoice line has no whole quantity to use.");
    expect(route).not.toContain("Math.max(1, Math.floor(Number(line.quantity) || 1))"); // a missing quantity is never guessed as 1
  });
});

describe("TRACK 13 — first real job assist", () => {
  it("says what the system is waiting for, in floor words, and never invents a step", async () => {
    const { jobAssistLine } = await import("../app/lib/simple-production");
    const item = (extra: any = {}) => ({ id: "i1", itemTicket: "GSO-20261120-0001-01", productTitle: "HEATH pouch", quantity: 128, runs: [], ...extra });
    const job = (extra: any = {}) => ({ id: "j1", jobTicket: "GSO-20261120-0001", status: "new", items: [item()], files: [], events: [], checklistItems: [], ...extra });
    expect(jobAssistLine(job())).toContain("make a folder named GSO-20261120-0001");
    expect(jobAssistLine(job())).toContain("Awaiting files");
    expect(jobAssistLine(job({ fulfillmentState: "ready_to_ship", status: "qc" }))).toContain("Record the shipment");
    expect(jobAssistLine(job({ status: "printing", items: [item({ runs: [{ runNumber: 2, kind: "reprint", quantity: 25, status: "open" }] })] }))).toContain("Reprint open: Run 2 · Reprint · 25 pcs");
    expect(jobAssistLine(job({ status: "shipped" }))).toContain("Mark the job Completed");
    expect(jobAssistLine(job({ status: "completed" }))).toBe("");
    expect(jobAssistLine(job({ status: "cancelled" }))).toBe("");
    expect(src("app/routes/app.erp.production-new.tsx")).toContain('name="moreItems"');
  });
});
