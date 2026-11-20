// 2026-11-19 (night) — access matrix, internal CRM, internal approval queue.
//
// Access: every admin route is in ONE table and denied roles are refused by the
// SERVER (loader and action), not merely by hidden navigation.
// CRM: leads move through a recorded lifecycle; conversions are idempotent;
// nothing sends a message. Approvals: a person decides; agents never can;
// approval never sends anything; replays never create a second record.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "1", shop: "shop-1", t: {} as Record<string, any[]>, seq: 0, clock: Date.parse("2026-11-20T05:00:00Z") }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: h.shop, isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const OPS = new Set(["in", "not", "contains", "mode", "gte", "lte", "lt"]);
  const eq = (a: any, b: any) => (a instanceof Date || b instanceof Date ? (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null) : (a ?? null) === (b ?? null));
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (!Object.keys(value).some((k) => OPS.has(k))) return match(row, value); // compound unique key
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return !eq(row[key], value.not);
      if ("lte" in value) return row[key] != null && new Date(row[key]).getTime() <= new Date(value.lte).getTime();
      if ("contains" in value) return String(row[key] || "").toLowerCase().includes(String(value.contains).toLowerCase());
      return true;
    }
    return eq(row[key], value);
  });
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const list = rows(name);
      if (method === "findFirst" || method === "findUnique") { const found = list.filter((row) => match(row, args.where))[0]; return found ? { ...found } : null; }
      if (method === "findMany") return list.filter((row) => match(row, args.where)).map((row) => ({ ...row, items: [] }));
      if (method === "count") return list.filter((row) => match(row, args.where)).length;
      if (method === "create") { const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date((h.clock += 1000)), updatedAt: new Date(h.clock), ...args.data }; list.push(row); return { ...row }; }
      if (method === "update" || method === "updateMany") {
        const found = list.filter((row) => match(row, args.where));
        found.forEach((row) => Object.assign(row, args.data));
        return method === "update" ? { ...found[0] } : { count: found.length };
      }
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : key === "$queryRawUnsafe" ? async () => [] : model(key)) });
  return { default: db, db };
});

import db from "../app/db.server";
import { APPROVAL_ACTION_INFO, approvalView, decideApproval, listApprovals, submitApproval } from "../app/lib/agent-approvals.server";
import { LEAD_STATUSES, leadFollowUpDue, leadTransitionVerdict, parseLeadInput } from "../app/lib/crm";
import { addLeadNote, assignLead, changeLeadStatus, convertLeadToAccount, createDraftQuoteForLead, createLead, leadFromQueueItem, setLeadFollowUp } from "../app/lib/crm.server";
import { ACTION_AUTONOMY_CEILING, INTERNAL_APPROVAL_ACTIONS } from "../app/lib/ops/autonomy";
import { CONSEQUENTIAL_ACTIONS } from "../app/lib/ops/action-intents";
import { createMemoryRepositories } from "../app/lib/ops/memory-repositories";
import { watcherHealth } from "../app/lib/print-intake-heartbeat";
import { ROUTE_ACCESS, viewerMayOpenRoute } from "../app/lib/route-access";
import { routeAccessDecision } from "../app/lib/route-access.server";
import { navForRole } from "../app/lib/simple-nav";

const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const ROLE_SUB: Record<string, string> = { owner: "1", manager: "2", sales: "3", print_operator: "4", bagger: "5", unassigned: "9" };
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: "1", GSO_STAFF_ROLES: "2:manager,3:sales,4:print_operator,5:bagger" };
const as = (role: string) => { h.sub = ROLE_SUB[role]; };
const authOf = (role: string) => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: ROLE_SUB[role] } });
const post = (fields: Record<string, string>) => { const body = new FormData(); Object.entries(fields).forEach(([k, v]) => body.set(k, v)); return new Request("https://erp.test/x", { method: "POST", body }); };
const statusOf = async (run: () => Promise<any>) => { try { const out = await run(); return out instanceof Response ? out.status : 200; } catch (thrown) { if (thrown instanceof Response) return thrown.status; throw thrown; } };

beforeEach(() => {
  h.t = {}; h.seq = 0; h.shop = "shop-1"; as("owner");
  Object.assign(process.env, ENV);
  delete process.env.GSO_OWNER_ENFORCEMENT;
  delete process.env.GSO_MANAGER_AUTHORIZED_USER_IDS;
});

describe("TRACK A — one route access table, enforced on the server", () => {
  const routesFile = src("app/routes.ts");
  const registered = [...routesFile.matchAll(/route\("([^"]+)",\s*"routes\/(app\.[^"]+)"/g)].map((m) => ({ path: m[1].replace(/^app\//, ""), file: m[2] })).filter((route) => route.file !== "app.tsx"); // app.tsx is the layout

  it("every registered admin route is in the table (a new route with no entry fails here)", () => {
    expect(registered.length).toBeGreaterThan(60);
    const missing = registered.filter((route) => !(route.path in ROUTE_ACCESS)).map((route) => route.path);
    expect(missing).toEqual([]);
    expect(ROUTE_ACCESS[""]).toBe("authenticated");
  });

  it("a route that is not in the table is refused for everyone, including the owner", () => {
    expect(viewerMayOpenRoute("erp/some-new-page", { role: "owner", canViewFinancials: true })).toBe(false);
  });

  it("every route file carries a server guard that matches its level", () => {
    const guard: Record<string, RegExp> = {
      owner: /requireOwner\(|resolveOwnerAuthorization\(|requireRouteAccess\(/,
      financial: /requireFinancialAccess\(|productionFinancialVisibility\(|requireRouteAccess\(/,
      admin_workflow: /requireRouteAccess\(|roleMayRunProductionIntent\(/,
      commercial: /requireRouteAccess\(|can\("sendQuote"\)/,
      production_view: /roleMayViewProduction\(|from "\.\/app\.erp\.production"/,
      production_leads: /roleMayRunProductionIntent\(/,
      assigned: /can\("createPurchaseRequest"\)/,
      authenticated: /authenticate\.admin\(/,
      redirect: /redirect\(|from "\.\/app\.product-costs"/,
    };
    const unguarded = registered.filter((route) => !guard[ROUTE_ACCESS[route.path]].test(src(`app/routes/${route.file}`))).map((route) => `${route.path} (${ROUTE_ACCESS[route.path]})`);
    expect(unguarded).toEqual([]);
  });

  it("role floors: sales sells, production produces, unassigned gets nothing privileged", () => {
    const may = (role: string, route: string) => routeAccessDecision(authOf(role), route, ENV).allowed;
    for (const route of ["quotes", "erp/crm", "erp/crm/:id", "erp/reorder"]) {
      expect(["owner", "manager", "sales"].every((role) => may(role, route))).toBe(true);
      expect(["print_operator", "bagger", "unassigned"].some((role) => may(role, route))).toBe(false);
    }
    for (const route of ["erp/release-queue", "erp/agent-approvals", "erp/setup-wizard"]) {
      expect(may("owner", route) && may("manager", route)).toBe(true);
      expect(["sales", "print_operator", "bagger", "unassigned"].some((role) => may(role, route))).toBe(false);
    }
    for (const route of ["erp/privacy-requests", "erp/agent-security", "erp/ops-hub", "erp/cost-calculator", "erp/owner-readiness"]) {
      expect(may("owner", route)).toBe(true);
      expect(["manager", "sales", "print_operator", "bagger", "unassigned"].some((role) => may(role, route))).toBe(false);
    }
    for (const route of ["erp/pricing-settings", "erp/vendors", "erp/reports-dashboard", "erp/admin-settings", "erp/agent-review-queue/new", "erp/actual-costs"]) {
      expect(may("owner", route)).toBe(true);
      expect(["manager", "sales", "print_operator", "bagger", "unassigned"].some((role) => may(role, route))).toBe(false);
      // a manager only with the owner's explicit financial authorization
      expect(routeAccessDecision(authOf("manager"), route, { ...ENV, GSO_MANAGER_AUTHORIZED_USER_IDS: "2" }).allowed).toBe(true);
    }
    expect(may("print_operator", "erp/production-board") && may("bagger", "erp/production-board")).toBe(true);
    expect(may("sales", "erp/production-board") || may("unassigned", "erp/production-board")).toBe(false);
    expect(may("bagger", "erp/production-new")).toBe(false);
  });

  it("the refusal names no person and carries the viewer's own staff id only", () => {
    const denied = routeAccessDecision(authOf("bagger"), "quotes", ENV);
    expect(denied.allowed).toBe(false);
    expect(denied.message).toContain("owner, managers and sales");
    expect(src("app/lib/route-access.ts") + src("app/lib/route-access.server.ts")).not.toMatch(/raquel|james/i);
  });

  it("QUOTES: the real loader and the real action refuse production and unassigned accounts", async () => {
    const quotes = await import("../app/routes/app.quotes");
    for (const role of ["print_operator", "bagger", "unassigned"]) {
      as(role);
      expect(await statusOf(() => quotes.loader({ request: new Request("https://erp.test/app/quotes") }))).toBe(403);
      for (const intent of ["save", "status", "priceRecipe", "searchProducts", "delete", "createReorderQuote"]) {
        const response = await quotes.action({ request: new Request("https://erp.test/app/quotes", { method: "POST", body: JSON.stringify({ intent, quote: { customerName: "X", items: [] } }) }) });
        expect(response.status).toBe(403);
      }
    }
    expect(h.t.quote || []).toEqual([]);
    as("sales");
    expect(await statusOf(() => quotes.loader({ request: new Request("https://erp.test/app/quotes") }))).toBe(200);
  }, 120_000);

  it("CRM, approvals, privacy, release queue and manual lead entry: real loaders / actions refuse denied roles", async () => {
    const crm = await import("../app/routes/app.erp.crm");
    const crmLead = await import("../app/routes/app.erp.crm.$id");
    const approvals = await import("../app/routes/app.erp.agent-approvals");
    const privacy = await import("../app/routes/app.erp.privacy-requests");
    const release = await import("../app/routes/app.erp.release-queue");
    const manualLead = await import("../app/routes/app.erp.agent-review-queue.new");
    const get = () => new Request("https://erp.test/x");
    for (const role of ["print_operator", "bagger", "unassigned"]) {
      as(role);
      expect(await statusOf(() => crm.loader({ request: get() }))).toBe(403);
      expect(await statusOf(() => crm.action({ request: post({ intent: "createLead", company: "Nope" }) }))).toBe(403);
      expect(await statusOf(() => crmLead.loader({ request: get(), params: { id: "x" } }))).toBe(403);
      expect(await statusOf(() => crmLead.action({ request: post({ intent: "createQuote" }), params: { id: "x" } }))).toBe(403);
    }
    for (const role of ["sales", "print_operator", "bagger", "unassigned"]) {
      as(role);
      expect(await statusOf(() => approvals.loader({ request: get() }))).toBe(403);
      expect(await statusOf(() => approvals.action({ request: post({ intent: "approve", id: "x" }) }))).toBe(403);
      expect(await statusOf(() => release.loader({ request: get() }))).toBe(403);
      expect(await statusOf(() => release.action({ request: post({ intent: "release", id: "x" }) }))).toBe(403);
      expect(await statusOf(() => manualLead.loader({ request: get() }))).toBe(403);
      expect(await statusOf(() => manualLead.action({ request: post({ productFamily: "jars", quantity: "100", company: "X", internalNotes: "n" }) }))).toBe(403);
    }
    for (const role of ["manager", "sales", "print_operator", "bagger", "unassigned"]) {
      as(role);
      expect(await statusOf(() => privacy.loader({ request: get() }))).toBe(403);
      expect(await statusOf(() => privacy.action({ request: post({ intent: "complete", id: "x" }) }))).toBe(403);
    }
    expect(h.t.crmLead || []).toEqual([]);
    expect(h.t.agentReviewQueueItem || []).toEqual([]);
  }, 120_000);

  it("navigation follows the same roles (display only)", () => {
    const links = (role: string) => navForRole(role).flatMap((section) => section.links.map((link) => link.href));
    expect(links("sales")).toContain("/app/erp/crm");
    expect(links("sales")).not.toContain("/app/erp/agent-approvals");
    expect(links("manager")).toContain("/app/erp/agent-approvals");
    expect(links("print_operator")).not.toContain("/app/erp/crm");
    expect(links("print_operator")).not.toContain("/app/quotes");
    expect(links("unassigned")).toEqual([]);
  });
});

describe("TRACK B — internal CRM", () => {
  const actor = "Sales Person";
  const newLead = async (fields: Record<string, unknown> = { company: "Krud Cafe", email: "Buyer@Krud.test" }) => {
    const created = await createLead(db, { shop: "shop-1", actor, fields });
    if (!created.ok) throw new Error(created.message);
    return created.lead as any;
  };
  const stored = (id: string) => h.t.crmLead.find((lead) => lead.id === id);

  it("the lifecycle vocabulary is the requested one", () => {
    expect([...LEAD_STATUSES]).toEqual(["new", "qualified", "assigned", "contact_pending", "contacted", "follow_up_due", "quote_created", "won", "lost"]);
  });

  it("no single field is required, but a lead must identify someone", async () => {
    expect(parseLeadInput({ phone: "555-0100" }).ok).toBe(true);
    expect(parseLeadInput({ notes: "someone called" }).ok).toBe(false);
    expect(parseLeadInput({ email: "not-an-email" }).ok).toBe(false);
    expect((await createLead(db, { shop: "shop-1", actor, fields: {} })).ok).toBe(false);
    const lead = await newLead();
    expect(lead).toMatchObject({ shop: "shop-1", status: "new", email: "buyer@krud.test", source: "manual", createdBy: actor });
  });

  it("status progression is recorded, guarded and reversible only on purpose", async () => {
    const lead = await newLead();
    const move = (to: string, reason?: string) => changeLeadStatus(db, { shop: "shop-1", id: lead.id, actor, to, reason });
    expect((await move("assigned")).ok).toBe(false); // nobody assigned
    expect((await move("quote_created")).ok).toBe(false); // no quote
    expect((await move("qualified")).ok).toBe(true);
    expect((await move("contact_pending")).ok).toBe(true);
    expect((await move("contacted")).ok).toBe(true);
    expect(stored(lead.id).lastContactedAt).toBeInstanceOf(Date);
    expect((await move("lost")).ok).toBe(false); // needs a reason
    expect((await move("lost", "Chose another vendor")).ok).toBe(true);
    expect(stored(lead.id)).toMatchObject({ status: "lost", outcomeReason: "Chose another vendor" });
    expect((await move("won")).ok).toBe(false); // reopen first
    expect((await move("contacted")).ok).toBe(true);
    expect(stored(lead.id)).toMatchObject({ status: "contacted", lostAt: null, outcomeReason: null });
    expect((await move("won", "PO received")).ok).toBe(true);
    expect((await move("nonsense")).ok).toBe(false);
    const trail = h.t.crmLeadEvent.filter((event) => event.leadId === lead.id && event.event === "status_changed").map((event) => `${event.fromStatus}>${event.toStatus}`);
    expect(trail).toEqual(["new>qualified", "qualified>contact_pending", "contact_pending>contacted", "contacted>lost", "lost>contacted", "contacted>won"]);
    expect(leadTransitionVerdict({ status: "won" }, "won").ok).toBe(false);
  });

  it("assignment, follow-up date and notes are stored with history", async () => {
    const lead = await newLead();
    expect((await assignLead(db, { shop: "shop-1", id: lead.id, actor, staffName: "Dana", staffId: "3" })).ok).toBe(true);
    expect(stored(lead.id)).toMatchObject({ assignedStaffName: "Dana", assignedStaffId: "3", status: "assigned" });
    expect((await setLeadFollowUp(db, { shop: "shop-1", id: lead.id, actor, date: "tomorrow" })).ok).toBe(false);
    expect((await setLeadFollowUp(db, { shop: "shop-1", id: lead.id, actor, date: "2026-11-21" })).ok).toBe(true);
    expect(leadFollowUpDue(stored(lead.id), new Date("2026-11-20T12:00:00Z"))).toBe(false);
    expect(leadFollowUpDue(stored(lead.id), new Date("2026-11-22T12:00:00Z"))).toBe(true);
    expect(leadFollowUpDue({ status: "won", nextFollowUpAt: "2026-01-01" }, new Date())).toBe(false);
    expect((await addLeadNote(db, { shop: "shop-1", id: lead.id, actor, note: "Left a voicemail" })).ok).toBe(true);
    expect((await addLeadNote(db, { shop: "shop-1", id: lead.id, actor, note: " " })).ok).toBe(false);
    expect(h.t.crmLeadEvent.filter((event) => event.leadId === lead.id).map((event) => event.event)).toEqual(["created", "assigned", "follow_up_set", "note"]);
  });

  it("lead -> customer account is idempotent and reuses an account only on an exact email", async () => {
    const lead = await newLead();
    const first = await convertLeadToAccount(db, { shop: "shop-1", id: lead.id, actor });
    const again = await convertLeadToAccount(db, { shop: "shop-1", id: lead.id, actor });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false, accountId: (first as any).accountId });
    expect(h.t.crmAccount).toHaveLength(1);
    const sameEmail = await newLead({ company: "Krud Cafe West", email: "buyer@krud.test" });
    expect(await convertLeadToAccount(db, { shop: "shop-1", id: sameEmail.id, actor })).toMatchObject({ created: false, accountId: (first as any).accountId });
    const similarName = await newLead({ company: "Krud Cafe" }); // same name, no email: never matched by name
    expect(await convertLeadToAccount(db, { shop: "shop-1", id: similarName.id, actor })).toMatchObject({ created: true });
    expect(h.t.crmAccount).toHaveLength(2);
  });

  it("lead -> draft quote: one quote however often it is clicked, customer carried over, no line and no price", async () => {
    const lead = await newLead({ company: "Krud Cafe", contactName: "Sam", email: "sam@krud.test", phone: "555-0100", productInterest: "4x5 bags" });
    const results = await Promise.all([1, 2, 3].map(() => createDraftQuoteForLead(db, { shop: "shop-1", id: lead.id, actor })));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result: any) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result: any) => result.quoteId)).size).toBe(1);
    const linked = stored(lead.id);
    expect(linked.status).toBe("quote_created");
    const quote = h.t.quote.find((row) => row.id === linked.quoteId);
    expect(quote).toMatchObject({ shop: "shop-1", status: "draft", company: "Krud Cafe", customerName: "Sam", email: "sam@krud.test", phone: "555-0100" });
    expect(quote.items).toBeUndefined();
    expect(h.t.quoteItem || []).toEqual([]);
    expect(await createDraftQuoteForLead(db, { shop: "shop-1", id: lead.id, actor })).toMatchObject({ created: false, quoteId: linked.quoteId });
    // the CRM never makes production work: only the canonical job service does
    expect(h.t.productionJob || []).toEqual([]);
    expect(src("app/lib/crm.server.ts")).not.toMatch(/dbClient\.productionJob|from "\.\/production-job-source/);
  });

  it("a review-queue item becomes exactly one lead", async () => {
    h.t.agentReviewQueueItem = [{ id: "q1", shop: "shop-1", company: "Bud Co", email: "A@Bud.test", productFamily: "jars", quantity: "500", customerSafeSummary: "Wants jars" }];
    const first = await leadFromQueueItem(db, { shop: "shop-1", queueItemId: "q1", actor });
    const again = await leadFromQueueItem(db, { shop: "shop-1", queueItemId: "q1", actor });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false, leadId: (first as any).leadId });
    expect(h.t.crmLead).toHaveLength(1);
    expect(h.t.crmLead[0]).toMatchObject({ source: "agent", sourceQueueItemId: "q1", email: "a@bud.test" });
    expect((await leadFromQueueItem(db, { shop: "shop-2", queueItemId: "q1", actor })).ok).toBe(false);
  });

  it("tenant isolation: another shop cannot read or change a lead", async () => {
    const lead = await newLead();
    expect((await changeLeadStatus(db, { shop: "shop-2", id: lead.id, actor, to: "qualified" })).ok).toBe(false);
    expect((await assignLead(db, { shop: "shop-2", id: lead.id, actor, staffName: "X" })).ok).toBe(false);
    expect((await createDraftQuoteForLead(db, { shop: "shop-2", id: lead.id, actor })).ok).toBe(false);
    expect((await convertLeadToAccount(db, { shop: "shop-2", id: lead.id, actor })).ok).toBe(false);
    expect(stored(lead.id).status).toBe("new");
    expect(stored(lead.id).quoteId).toBeUndefined();
    h.shop = "shop-2";
    const page = await import("../app/routes/app.erp.crm.$id");
    expect(await statusOf(() => page.loader({ request: new Request("https://erp.test/x"), params: { id: lead.id } }))).toBe(404);
  });

  it("the CRM has no way to send anything", () => {
    const code = ["app/lib/crm.ts", "app/lib/crm.server.ts", "app/routes/app.erp.crm.tsx", "app/routes/app.erp.crm.$id.tsx"].map(src).join("\n");
    expect(code).not.toMatch(/fetch\(|sendEmail|nodemailer|twilio|graphql|admin\.|slack/i);
  });

  it("through the real pages: sales adds a lead and opens it", async () => {
    as("sales");
    const list = await import("../app/routes/app.erp.crm");
    const created = await (await list.action({ request: post({ intent: "createLead", company: "Leaf Labs", phone: "555-0101" }) })).json();
    expect(created).toMatchObject({ ok: true });
    const page = await import("../app/routes/app.erp.crm.$id");
    const data = await (await page.loader({ request: new Request("https://erp.test/x"), params: { id: created.leadId } })).json();
    expect(data.lead).toMatchObject({ name: "Leaf Labs", status: "new" });
    expect(JSON.stringify(data)).not.toMatch(/unitCost|margin|costSnapshot/);
    const mine = await (await page.action({ request: post({ intent: "assignToMe" }), params: { id: created.leadId } })).json();
    expect(mine.ok).toBe(true);
    expect(h.t.crmLead[0]).toMatchObject({ assignedStaffId: "3", status: "assigned" });
  });
});

describe("TRACK C — internal approval queue (external execution stays off)", () => {
  const repo = () => createMemoryRepositories().intents;
  const staff = { type: "staff" as const, id: "3", name: "Sales Person", source: "erp:crm" };
  const owner = { userId: "1", actor: "Owner", role: "owner" };
  const manager = { userId: "2", actor: "Manager", role: "manager" };
  const draft = (overrides: Record<string, unknown> = {}) => ({
    shop: "shop-1", actionType: "submit_outreach_draft", entityType: "crm_lead", entityId: "lead-1", payload: { channel: "email", message: "Hi Sam, following up on your bags." },
    reason: "Follow up after the sample", idempotencyKey: "draft-1", proposedBy: staff, ...overrides,
  });

  it("every approval action always needs a person and none is an external or money action", () => {
    expect(INTERNAL_APPROVAL_ACTIONS).toEqual(["submit_outreach_draft", "propose_followup", "propose_quote", "propose_reorder", "suggest_lead_assignment"]);
    for (const action of INTERNAL_APPROVAL_ACTIONS) {
      expect(ACTION_AUTONOMY_CEILING[action]).toBe("APPROVAL_REQUIRED");
      expect(CONSEQUENTIAL_ACTIONS.has(action)).toBe(false);
      expect(APPROVAL_ACTION_INFO[action]).toBeTruthy();
    }
    // the sending actions stay disabled exactly as before
    for (const action of ["send_customer_notification", "send_invoice", "send_purchase_order", "post_slack_external"] as const) expect(ACTION_AUTONOMY_CEILING[action]).toBe("DISABLED");
  });

  it("a proposal waits for approval; the same proposal twice is one record", async () => {
    const intents = repo();
    const first = await submitApproval(intents, draft());
    const again = await submitApproval(intents, draft());
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect((first as any).intent.status).toBe("AWAITING_APPROVAL");
    expect(await listApprovals(intents, "shop-1")).toHaveLength(1);
    expect((await submitApproval(intents, draft({ actionType: "send_customer_notification", idempotencyKey: "x" }))).ok).toBe(false);
    expect((await submitApproval(intents, draft({ actionType: "refund_or_void", idempotencyKey: "y" }))).ok).toBe(false);
    expect((await submitApproval(intents, draft({ reason: "", idempotencyKey: "z" }))).ok).toBe(false);
    expect((await submitApproval(intents, draft({ payload: { message: "x".repeat(9000) }, idempotencyKey: "big" }))).ok).toBe(false);
    expect(await listApprovals(intents, "shop-1")).toHaveLength(1);
  });

  it("only the owner or a manager decides; a rejection needs a reason; deciding twice changes nothing", async () => {
    const intents = repo();
    const { intent } = (await submitApproval(intents, draft())) as any;
    const decide = (decision: "approve" | "reject", approver: any, comment = "") => decideApproval(intents, db, { shop: "shop-1", id: intent.id, decision, approver, comment });
    expect((await decide("approve", { userId: "3", actor: "Sales", role: "sales" })).ok).toBe(false);
    expect((await decide("approve", { userId: null, actor: "?", role: "owner" })).ok).toBe(false);
    expect((await decide("reject", manager)).ok).toBe(false);
    expect((await intents.getById(intent.id))!.status).toBe("AWAITING_APPROVAL");
    const approved = await decide("approve", manager, "Looks good");
    expect(approved).toMatchObject({ ok: true, status: "COMPLETED" });
    expect(approved.message).toContain("ERP sends nothing");
    const audited = await intents.listAudit(intent.id);
    const before = audited.length;
    expect(await decide("approve", owner)).toMatchObject({ ok: true, status: "COMPLETED" });
    expect((await intents.listAudit(intent.id)).length).toBe(before);
    expect((await decide("reject", owner, "changed my mind")).ok).toBe(false);
    expect(audited.map((event) => event.newStatus)).toEqual(["PROPOSED", "VALIDATED", "AWAITING_APPROVAL", "APPROVED", "EXECUTING", "COMPLETED"]);
    const view = approvalView((await intents.getById(intent.id))!);
    expect(view).toMatchObject({ kind: "Draft message to a customer", approvedBy: "Manager", proposedBy: "Sales Person" });
  });

  it("an agent, a model or the system can never approve", async () => {
    const intents = repo();
    const { intent } = (await submitApproval(intents, draft({ proposedBy: { type: "agent", id: "customer_followup" } }))) as any;
    const { decideIntent } = await import("../app/lib/ops/action-intents");
    for (const type of ["agent", "model", "system"] as const) {
      expect((await decideIntent(intents, intent.id, "APPROVE", { type, id: "x", role: "owner" })).ok).toBe(false);
    }
    expect((await intents.getById(intent.id))!.status).toBe("AWAITING_APPROVAL");
  });

  it("rejected: nothing changes anywhere", async () => {
    const intents = repo();
    h.t.crmLead = [{ id: "lead-1", shop: "shop-1", status: "new" }];
    const { intent } = (await submitApproval(intents, draft({ actionType: "suggest_lead_assignment", payload: { staffName: "Dana" }, idempotencyKey: "assign-1" }))) as any;
    expect(await decideApproval(intents, db, { shop: "shop-1", id: intent.id, decision: "reject", approver: owner, comment: "Dana is out" })).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(h.t.crmLead[0]).toEqual({ id: "lead-1", shop: "shop-1", status: "new" });
    expect((await decideApproval(intents, db, { shop: "shop-1", id: intent.id, decision: "approve", approver: owner })).ok).toBe(false);
  });

  it("approved internal proposals change only the lead: assignment and follow-up date", async () => {
    const intents = repo();
    h.t.crmLead = [{ id: "lead-1", shop: "shop-1", status: "new" }];
    const assign = (await submitApproval(intents, draft({ actionType: "suggest_lead_assignment", payload: { staffName: "Dana", staffId: "3" }, idempotencyKey: "assign-2", proposedBy: { type: "agent", id: "lead_manager" } }))) as any;
    const follow = (await submitApproval(intents, draft({ actionType: "propose_followup", payload: { followUpDate: "2026-11-25" }, idempotencyKey: "follow-1" }))) as any;
    expect(await decideApproval(intents, db, { shop: "shop-1", id: assign.intent.id, decision: "approve", approver: manager })).toMatchObject({ ok: true, status: "COMPLETED" });
    expect(await decideApproval(intents, db, { shop: "shop-1", id: follow.intent.id, decision: "approve", approver: owner })).toMatchObject({ ok: true, status: "COMPLETED" });
    expect(h.t.crmLead[0]).toMatchObject({ assignedStaffName: "Dana", status: "assigned" });
    expect(new Date(h.t.crmLead[0].nextFollowUpAt).toISOString().slice(0, 10)).toBe("2026-11-25");
    // replay: no second assignment event
    await decideApproval(intents, db, { shop: "shop-1", id: assign.intent.id, decision: "approve", approver: manager });
    expect(h.t.crmLeadEvent.filter((event) => event.event === "assigned")).toHaveLength(1);
  });

  it("an approval that cannot be applied ends FAILED with the reason, not silently", async () => {
    const intents = repo();
    const bad = (await submitApproval(intents, draft({ actionType: "propose_followup", entityId: "missing-lead", payload: { followUpDate: "2026-11-25" }, idempotencyKey: "follow-2" }))) as any;
    const result = await decideApproval(intents, db, { shop: "shop-1", id: bad.intent.id, decision: "approve", approver: owner });
    expect(result).toMatchObject({ ok: false, status: "FAILED" });
    expect((await intents.getById(bad.intent.id))!.error).toContain("not found");
  });

  it("tenant isolation: another shop cannot see or decide a proposal; the same key in two shops is two proposals", async () => {
    const intents = repo();
    const one = (await submitApproval(intents, draft())) as any;
    const two = (await submitApproval(intents, draft({ shop: "shop-2" }))) as any;
    expect(one.intent.id).not.toBe(two.intent.id);
    expect((await listApprovals(intents, "shop-2")).map((intent) => intent.id)).toEqual([two.intent.id]);
    expect(await decideApproval(intents, db, { shop: "shop-2", id: one.intent.id, decision: "approve", approver: owner })).toMatchObject({ ok: false, message: "The proposal was not found." });
    expect((await intents.getById(one.intent.id))!.status).toBe("AWAITING_APPROVAL");
  });

  it("the approval code has no path to the outside world", () => {
    const code = ["app/lib/agent-approvals.server.ts", "app/routes/app.erp.agent-approvals.tsx"].map(src).join("\n");
    expect(code).not.toMatch(/fetch\(|sendEmail|nodemailer|twilio|SlackClient|admin\.graphql|draftOrder|quickbooks/i);
    expect(src("app/lib/ops/prisma-repositories.server.ts")).toContain("shop: i.shop ?? null");
  });
});

describe("TRACK N — the ERP can see whether the print-file watcher is alive", () => {
  const now = new Date("2026-11-20T06:00:00Z");
  it("ok, stale and never", () => {
    expect(watcherHealth(new Date("2026-11-20T05:58:00Z"), now)).toMatchObject({ state: "ok", minutesAgo: 2 });
    expect(watcherHealth(new Date("2026-11-20T00:47:13Z"), now)).toMatchObject({ state: "stale" });
    expect(watcherHealth(new Date("2026-11-20T00:47:13Z"), now).message).toContain("NOT being picked up");
    expect(watcherHealth(null, now).state).toBe("never");
  });
  it("the watcher's own status call stamps the heartbeat and never fails because of it", async () => {
    h.t.printLogAutoImportSetting = [{ id: "s1", shop: "shop-1", enabled: true, uploadToken: "tok" }];
    const status = await import("../app/routes/api.print-intake.status");
    const call = () => status.action({ request: new Request("https://erp.test/api/print-intake/status", { method: "POST", body: JSON.stringify({ token: "tok", pending: true, agentVersion: "gso-print-intake-agent/1.10", agentHost: "RIP-PC" }) }) });
    expect((await call()).status).toBe(200);
    expect(h.t.printLogAutoImportSetting[0]).toMatchObject({ intakeAgentVersion: "gso-print-intake-agent/1.10", intakeAgentHost: "RIP-PC" });
    expect(h.t.printLogAutoImportSetting[0].intakeAgentLastSeenAt).toBeInstanceOf(Date);
    const bad = await status.action({ request: new Request("https://erp.test/x", { method: "POST", body: JSON.stringify({ token: "wrong", pending: true }) }) });
    expect(bad.status).toBe(403);
  });
  it("the watcher script cannot be ended by one failed log write or one failed pass", () => {
    const agent = src("tools/gso-print-intake-agent.ps1");
    expect(agent).toContain("gso-print-intake-agent/1.10");
    expect(agent).toContain('"pass_error"');
    expect(agent).toContain("gso-print-intake-local-");
    expect(agent).toContain("agentVersion = $ScriptVersion");
  });
});

describe("TRACK K — privacy requests: lifecycle, history, retention", () => {
  it("received -> in progress -> completed, every step in an append-only history, tenant-scoped", async () => {
    const privacy = await import("../app/lib/privacy-compliance.server");
    const recorded = await privacy.recordComplianceRequest(db, { shop: "shop-1", topic: "customers/redact", webhookId: "wh-1", payload: { customer: { id: 12, email: "Sam@Krud.test" } } });
    const id = recorded.id as string;
    expect(h.t.complianceRequest[0].dueAt.getTime() - h.t.complianceRequest[0].receivedAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect((await privacy.startComplianceRequest(db, { shop: "shop-2", requestId: id, actor: "Other" })).ok).toBe(false);
    expect((await privacy.startComplianceRequest(db, { shop: "shop-1", requestId: id, actor: "Owner" })).ok).toBe(true);
    expect((await privacy.startComplianceRequest(db, { shop: "shop-1", requestId: id, actor: "Owner" })).message).toBe("Already in progress.");
    expect(h.t.complianceRequest[0]).toMatchObject({ status: "in_progress", startedBy: "Owner" });
    expect((await privacy.addComplianceNote(db, { shop: "shop-1", requestId: id, actor: "Owner", note: "Checked the quotes" })).ok).toBe(true);

    h.t.quote = [{ id: "q1", shop: "shop-1", email: "sam@krud.test", customerName: "Sam", phone: "555", status: "paid" }];
    h.t.productionJob = [{ id: "j1", shop: "shop-1", email: "sam@krud.test", customerName: "Sam", jobTicket: "GSO-20261119-0042", actualTotalCost: 81.5 }];
    h.t.crmLead = [{ id: "l1", shop: "shop-1", email: "sam@krud.test", contactName: "Sam", phone: "555", company: "Krud Cafe", status: "won" }, { id: "l2", shop: "shop-2", email: "sam@krud.test", contactName: "Sam" }];
    h.t.crmAccount = [{ id: "a1", shop: "shop-1", email: "sam@krud.test", contactName: "Sam", company: "Krud Cafe" }];
    const applied = await privacy.applyCustomerRedaction(db, { shop: "shop-1", requestId: id, actor: "Owner" });
    expect(applied.ok).toBe(true);
    // contact details are blanked; the business records are all still there
    expect(h.t.quote).toHaveLength(1);
    expect(h.t.productionJob[0]).toMatchObject({ email: null, jobTicket: "GSO-20261119-0042", actualTotalCost: 81.5 });
    expect(h.t.crmLead[0]).toMatchObject({ email: null, phone: null, company: "Krud Cafe", status: "won" });
    expect(h.t.crmAccount[0]).toMatchObject({ email: null, company: "Krud Cafe" });
    expect(h.t.crmLead[1]).toMatchObject({ email: "sam@krud.test", contactName: "Sam" }); // another shop is never touched
    expect(h.t.complianceRequest[0]).toMatchObject({ status: "completed", completedBy: "Owner" });
    expect(h.t.complianceRequest[0].completedAt).toBeInstanceOf(Date);
    expect(h.t.complianceRequestEvent.map((event) => event.event)).toEqual(["received", "started", "note", "redaction_applied", "completed"]);
    expect((await privacy.applyCustomerRedaction(db, { shop: "shop-1", requestId: id, actor: "Owner" })).ok).toBe(false);
  });

  it("nothing in the privacy code deletes a record, and the webhook erases nothing on its own", () => {
    const lib = src("app/lib/privacy-compliance.server.ts");
    expect(lib).not.toMatch(/\.delete\(|\.deleteMany\(/);
    const hook = src("app/routes/webhooks.compliance.ts");
    expect(hook).not.toMatch(/applyCustomerRedaction|updateMany|deleteMany/);
    expect(src("app/routes/app.erp.privacy-requests.tsx")).toContain("requireOwner(auth)");
  });
});
