// 2026-11-14 GSO ERP SIMPLE MODE — release-audit fixes.
//
// 1. Sales may create a production job from a quote but may not open Production
//    pages. The Quotes page used to offer Sales an "Open Production Job" button
//    that led to a page the server turns them away from (they landed on Home).
//    Sales now stays in Quotes and sees "Production job created" + the job
//    ticket; production roles get a button that opens the Simple Mode job page.
// 2. The Sales Home no longer carries a tile that leads into Production.
// 3. The owner keeps a one-click Cost Calculator button on Home.
//
// No quote calculation, quote-creation or pricing code is involved.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "77055393857", created: [] as any[], selects: [] as any[] }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false, email: "staff@gso.test" }, sessionToken: { sub: h.sub }, admin: {} }) },
}));
vi.mock("../app/lib/production-job-source.server", async (importOriginal) => {
  const original: any = await importOriginal();
  return { ...original, createProductionJobFromSource: async (_db: any, input: any) => { h.created.push(input); return { created: false, job: { id: "j1", jobTicket: "GSO-20261114-0007" } }; } };
});
vi.mock("../app/db.server", () => {
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      if (name === "productionJob" && method === "findMany") { h.selects.push(args.select); return [{ id: "j1", quoteId: "q1", status: "new", updatedAt: new Date("2026-11-14T12:00:00Z"), jobTicket: "GSO-20261114-0007" }]; }
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
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: ROLES.owner, GSO_STAFF_ROLES: "1001:manager,1002:sales,1003:print_operator,1004:bagger" };
const QUOTES_SRC = readFileSync("app/routes/app.quotes.tsx", "utf8");
const HOME_SRC = readFileSync("app/routes/app._index.tsx", "utf8");

let quotes: any;
beforeAll(async () => { quotes = await import("../app/routes/app.quotes"); }, 240_000);
beforeEach(() => { Object.assign(process.env, ENV); h.created = []; h.selects = []; });
afterEach(() => { for (const key of Object.keys(ENV)) delete process.env[key]; });

describe("Quotes — after a production job is created from a quote", () => {
  it.each(Object.keys(ROLES) as Role[])("%s: the page is told whether this viewer may open Production (display only)", async (role) => {
    h.sub = ROLES[role];
    const data = await (await quotes.loader({ request: new Request("https://app.test/app/quotes") })).json();
    expect(data.canOpenProduction).toBe(["owner", "manager", "print_operator", "bagger"].includes(role));
    expect(data.productionJobs).toEqual([expect.objectContaining({ id: "j1", quoteId: "q1", jobTicket: "GSO-20261114-0007" })]);
  });

  it("Sales: the success message carries the job ticket and the answer stays a Quotes answer (no redirect)", async () => {
    h.sub = ROLES.sales;
    const res: Response = await quotes.action({ request: new Request("https://app.test/app/quotes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "createProductionJobFromQuote", quoteId: "q1" }) }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, intent: "createProductionJobFromQuote", jobId: "j1" });
    expect(body.message).toBe("Production job already exists. Job ticket GSO-20261114-0007.");
    expect(h.created).toEqual([expect.objectContaining({ source: { type: "erp_quote", quoteId: "q1" }, actor: "quotes_page" })]);
    expect(body.productionJobs[0].jobTicket).toBe("GSO-20261114-0007");
  });

  it("the Quotes page never sends anyone to the Advanced Production page, and never navigates after creating a job", () => {
    expect(QUOTES_SRC).not.toMatch(/navigate\(\s*[`"']\/app\/erp\/production["'`?]/);
    expect(QUOTES_SRC).toContain("navigate(jobId ? jobWorkspaceHref(jobId) : SIMPLE_BOARD_HREF);");
    // the create-job result handler only sets the on-page message
    const handler = QUOTES_SRC.slice(QUOTES_SRC.indexOf('if (fetcher.data?.intent === "createProductionJobFromQuote") {'), QUOTES_SRC.indexOf('if (fetcher.data?.intent === "priceRecipe") {'));
    expect(handler).toContain('setLastMessage(fetcher.data.message || "Production job ready.");');
    expect(handler).not.toContain("navigate(");
  });

  it("the Open Production Job button is offered only to viewers who may open Production; others see a plain confirmation", () => {
    expect(QUOTES_SRC).toContain("{loaderData.canOpenProduction");
    expect(QUOTES_SRC).toContain('? <Button variant="primary" onClick={() => openProductionJob(productionJob.id)}>Open Production Job</Button>');
    expect(QUOTES_SRC).toContain(': <Badge tone="success">Production job created</Badge>}');
    expect(QUOTES_SRC.match(/openProductionJob\(/g)).toHaveLength(2); // the definition + that one guarded button
  });

  it("the fix reads only job identity fields (no price, cost or quote field was added)", () => {
    expect(QUOTES_SRC.match(/select: \{ id: true, quoteId: true, status: true, updatedAt: true, jobTicket: true \},/g)).toHaveLength(2);
  });
});

describe("Home", () => {
  it("the Sales Home shows no tile that leads into Production", () => {
    const salesTiles = HOME_SRC.match(/\n\s*sales: \[([^\]]*)\],/)?.[1] || "";
    // 2026-11-15: the two lead-review tiles were removed — that page is owner / authorized-manager only on the
    // server, so for Sales they were links that always answered "owner only" (see simple-mode-objective-fixes test).
    expect(salesTiles).toBe('"quotesToWork", "quotesAwaitingPayment"');
    const tileHref = (key: string) => HOME_SRC.match(new RegExp(`\\{ key: "${key}",[^}]*href: ([^,]+),`))?.[1] || "";
    for (const key of salesTiles.split(",").map((part) => part.trim().replace(/"/g, ""))) {
      expect(tileHref(key), key).not.toBe("");
      expect(tileHref(key), key).not.toContain("SIMPLE_BOARD_HREF");
      expect(tileHref(key), key).not.toContain("/app/erp/production");
    }
  });

  it("the owner has a one-click Cost Calculator button on Home; nobody else is shown it", () => {
    expect(HOME_SRC).toContain('secondaryActions={isOwner ? [{ content: "Cost Calculator", onAction: () => navigate("/app/erp/cost-calculator") }] : []}');
  });
});

// ---------------------------------------------------------------------------
// Display fixes found by the pre-release screen review (no server rule changed)
// ---------------------------------------------------------------------------
import { friendlyMessage } from "../app/lib/employee-messages";
import { QC_NEEDED_AGAIN, jobWorkspaceView, toBoardCard, workspaceItemQc } from "../app/lib/simple-production";

const JOB_SRC = readFileSync("app/routes/app.erp.production-job.$id.tsx", "utf8");
const NEW_SRC = readFileSync("app/routes/app.erp.production-new.tsx", "utf8");
const BOARD_SRC = readFileSync("app/routes/app.erp.production-board.tsx", "utf8");

describe("job page — a job reopened for reprint after it shipped", () => {
  const checklist = [
    { id: "c1", section: "prepress", label: "Artwork received / linked", sortOrder: 10, completed: true },
    { id: "c3", section: "production", label: "Labels printed", sortOrder: 30, completed: true },
    { id: "c4", section: "production", label: "Cut complete", sortOrder: 40, completed: true },
    { id: "c7", section: "packing", label: "Packed and labeled", sortOrder: 80, completed: true },
  ];
  const passedItem = { id: "i1", itemTicket: "T-01", productTitle: "Labels", quantity: 10, machineSummary: "Roland LG-640", qcResult: "pass", qcBy: "op", qcAt: new Date("2026-11-10T10:00:00Z"), lastReprintAt: null };
  const reopenHold = { eventType: "qc_result", newValue: "hold", oldValue: "T-01", message: "QC reset to HOLD by reopen for reprint (T-01).", createdAt: new Date("2026-11-12T09:00:00Z") };
  const reopened = { id: "j1", status: "reprint_needed", shipCarrier: "UPS", shippedAt: new Date("2026-11-11T12:00:00Z"), items: [passedItem], checklistItems: checklist, events: [reopenHold] };

  it("the earlier QC PASS no longer counts: the item needs a new QC PASS and NEXT STEP is not Complete Job", () => {
    expect(workspaceItemQc(passedItem, [reopenHold])).toMatchObject({ status: "hold", label: QC_NEEDED_AGAIN });
    const view = jobWorkspaceView(reopened);
    expect(view.qcAllPass).toBe(false);
    expect(view.fulfilled).toBe(false); // the old shipment does not count as shipping the reprint
    expect(view.next.text).toBe("Reprint needed");
    expect(view.next.detail).toBe("Then: Record QC");
    expect(toBoardCard(reopened, new Date("2026-11-14T12:00:00Z")).next).not.toBe("Complete Job");
  });

  it("a PASS with no later non-pass QC event is still a PASS (nothing else changed)", () => {
    expect(workspaceItemQc(passedItem, []).status).toBe("pass");
    const earlierHold = { ...reopenHold, createdAt: new Date("2026-11-09T09:00:00Z") };
    expect(workspaceItemQc(passedItem, [earlierHold]).status).toBe("pass");
    const otherItemHold = { ...reopenHold, oldValue: "T-02" };
    expect(workspaceItemQc(passedItem, [otherItemHold]).status).toBe("pass");
    const laterPass = { eventType: "qc_result", newValue: "pass", oldValue: "T-01", createdAt: new Date("2026-11-13T09:00:00Z") };
    expect(workspaceItemQc(passedItem, [laterPass]).status).toBe("pass");
  });

  it("shipped / picked up still read as fulfilled with NEXT STEP Complete Job; completed is DONE", () => {
    expect(jobWorkspaceView({ ...reopened, status: "shipped", events: [] })).toMatchObject({ fulfilled: true, next: { text: "Complete Job" } });
    expect(jobWorkspaceView({ ...reopened, status: "picked_up", events: [] })).toMatchObject({ fulfilled: true, next: { text: "Complete Job" } });
    expect(jobWorkspaceView({ ...reopened, status: "completed", events: [] }).next.text).toBe("DONE");
  });

  it("the job page offers the shipment / pickup forms again once the job has left Shipped / Picked Up, and Complete Job only while it is there", () => {
    expect(JOB_SRC).toContain('{!["shipped", "picked_up", "completed", "cancelled"].includes(status) ? (');
    expect(JOB_SRC).not.toContain("!shipment && !pickup &&");
    expect(JOB_SRC.replace(/\r\n/g, "\n")).toContain('{["shipped", "picked_up"].includes(status) ? (\n        <ActionForm jobId={job.id} intent="changeStatus" hidden={{ status: "completed" }}>');
    expect(JOB_SRC).toContain("const qc = workspaceItemQc(item, job.events || []);");
  });
});

describe("NEXT STEP keeps a job's place when it is held, needs a reprint, or its proof is approved", () => {
  const checklist = [
    { id: "c1", section: "prepress", label: "Artwork received / linked", sortOrder: 10, completed: false },
    { id: "c2", section: "prepress", label: "Proof approved", sortOrder: 20, completed: false },
    { id: "c3", section: "production", label: "Labels printed", sortOrder: 30, completed: false },
  ];
  const item = { id: "i1", itemTicket: "T-01", quantity: 10, machineSummary: "Roland LG-640", qcResult: null, qcAt: null, lastReprintAt: null };
  const view = (job: any) => jobWorkspaceView({ id: "j", items: [item], checklistItems: checklist, events: [], ...job });

  it("Proof Approved: artwork is behind the job even when nobody ticked the checklist", () => {
    const v = view({ status: "proof_approved" });
    expect(v.currentStep).toBe("print");
    expect(v.next.text).toBe("Print on Roland LG-640");
  });

  it("Reprint Needed: the job goes back to the printer, not to Link artwork", () => {
    const v = view({ status: "reprint_needed" });
    expect(v.currentStep).toBe("print");
    expect(v.next).toMatchObject({ text: "Reprint needed", detail: "Then: Print on Roland LG-640", tone: "problem" });
  });

  it("On Hold: the steps stay where the job was before the hold", () => {
    const held = { eventType: "status_change", oldValue: "qc", newValue: "on_hold", createdAt: new Date("2026-11-14T09:00:00Z") };
    const older = { eventType: "status_change", oldValue: "new", newValue: "on_hold", createdAt: new Date("2026-11-01T09:00:00Z") };
    const v = view({ status: "on_hold", events: [older, held] });
    expect(v.currentStep).toBe("qc");
    expect(v.next.text).toBe("On hold — check the notes");
    expect(view({ status: "on_hold" }).currentStep).toBe("artwork"); // no history: unchanged behaviour
    // a hold never marks Fulfill done
    const afterShip = { eventType: "status_change", oldValue: "shipped", newValue: "on_hold", createdAt: new Date("2026-11-14T09:00:00Z") };
    expect(view({ status: "on_hold", events: [afterShip] }).fulfilled).toBe(false);
  });

  it("an open checklist label that merely contains the letters 'art' is shown as written", () => {
    const odd = [{ id: "x", section: "prepress", label: "Start color match", sortOrder: 5, completed: false }];
    expect(jobWorkspaceView({ id: "j", status: "prepress", items: [item], checklistItems: odd, events: [] }).next.text).toBe("Start color match");
  });
});

describe("job page — small shop-floor fixes", () => {
  it("a saved form is cleared, so a second tap cannot record the same material / note twice", () => {
    expect(JOB_SRC).toContain('if (fetcher.state === "idle" && fetcher.data?.ok) formRef.current?.reset();');
    expect(JOB_SRC).toContain('<fetcher.Form method="post" ref={formRef}>');
  });

  it("the QC step has no tick-box that looks like QC but is not", () => {
    expect(JOB_SRC).toContain('{key !== "qc" ? <ChecklistButtons jobId={job.id} items={step.checklist} /> : null}');
  });

  it("Mark proof sent is offered only while the job is still in prepress (it moves the job to Proof Sent)", () => {
    expect(JOB_SRC).toContain('const PROOF_SEND_STATUSES = ["new", "prepress", "proof_needed", "proof_sent", "proof_approved"];');
    expect(JOB_SRC).toContain('{PROOF_SEND_STATUSES.includes(String(job.status || "new")) ? (');
  });

  it("system bookkeeping lines are not shown to staff in Notes", () => {
    expect(JOB_SRC).toContain("{staffNotes(job.internalNotes) ?");
    expect(JOB_SRC).not.toContain("{job.internalNotes}</div>");
  });

  it("collapsible controls are at least 44px tall; long names cannot push an attention row off the screen", () => {
    expect(JOB_SRC).not.toMatch(/minHeight: 3[0-9]\b/);
    expect(BOARD_SRC).not.toMatch(/minHeight: 3[0-9]\b/);
    expect(BOARD_SRC).toContain('whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{card.customer} — {card.product}</span>');
  });

  it("New Job: a refused job does not wipe the form; a created job still refreshes it", async () => {
    const route: any = await import("../app/routes/app.erp.production-new");
    expect(route.shouldRevalidate({ actionResult: { ok: false, message: "MIMAKI_GLOSS_UNSUPPORTED" }, defaultShouldRevalidate: true })).toBe(false);
    expect(route.shouldRevalidate({ actionResult: { ok: true }, defaultShouldRevalidate: true })).toBe(true);
    expect(route.shouldRevalidate({ defaultShouldRevalidate: true })).toBe(true);
    expect(NEW_SRC).toContain('<fetcher.Form method="post" key={requestId}');
  }, 120_000);

  it("server messages staff see are in plain words, with the original kept under Details", () => {
    expect(friendlyMessage("Work order print event tracked.").primary).toBe("Work order marked as printed");
    const denied = "Your role can't do this on a production job. Assigned role bagger (verified Shopify staff user ID 1004).";
    expect(friendlyMessage(denied)).toEqual({ primary: "Your role can't do this — ask a manager", detail: denied });
    expect(friendlyMessage("GSO-1 reopened for reprint (was completed, cost finalized — snapshot preserved).").primary).toBe("Job reopened for reprint");
    // an account with no role keeps its existing wording
    expect(friendlyMessage("Your role can't do this on a production job. No ERP role is assigned to Shopify staff user ID 9999 (GSO_STAFF_ROLES).").primary).toBe("Your account doesn't have access to this yet — ask the owner");
  });
});
