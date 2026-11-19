// Print Intake Patch B (2026-11-18) — owner-approved press routing for files
// arriving through Print Intake:
//   explicit ERP press -> explicit filename tag -> gloss / white anywhere on
//   the job = Roland -> CMYK only = Mimaki. No load balancing.
// Layer files of one job (`_cmyk`, `_g`, `_w`) are decided together, so one
// physical job is never split across presses; conflicts go to review.
//
// UPDATE 2026-11-18 (owner): the Mimaki gloss / clear channel is restored. Gloss
// no longer decides the press — a CMYK + gloss job follows the CMYK rule (Mimaki
// unless explicitly Roland). WHITE still requires the Roland; the Roland-
// requirement, conflict and layer-split cases below are therefore proven with
// white. The new gloss rules live in tests/mimaki-gloss-restored-2026-11-18.test.ts.
//
// updated 2026-11-18: Mimaki gloss restored — the shared `decideMachine`
// (production dispatch, order -> job) now follows the same gloss rule (untagged
// CMYK / gloss -> Mimaki; white unchanged AUTO); section 9 pins that 2026-11-18
// behaviour. The Cost Calculator / quote routing is deliberately NOT changed.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const state: { settings: Row[]; jobs: Row[]; intakes: Row[]; events: Row[]; writes: string[]; seq: number } = { settings: [], jobs: [], intakes: [], events: [], writes: [], seq: 0 };

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: "9001" }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const findIntake = (where: any) => {
    if (where?.shop_fileHashSha256) return state.intakes.find((row) => row.shop === where.shop_fileHashSha256.shop && row.fileHashSha256 === where.shop_fileHashSha256.fileHashSha256) ?? null;
    return state.intakes.find((row) => (!where?.id || row.id === where.id) && (!where?.shop || row.shop === where.shop)) ?? null;
  };
  const printIntake = {
    findUnique: async ({ where }: any) => findIntake(where),
    findFirst: async ({ where }: any) => {
      if (where?.authoritativeTicket) return state.intakes.find((row) => row.shop === where.shop && row.authoritativeTicket === where.authoritativeTicket && row.status === where.status && row.fileHashSha256 !== where.NOT?.fileHashSha256) ?? null;
      return findIntake(where);
    },
    findMany: async ({ where }: any = {}) => state.intakes.filter((row) => (!where?.shop || row.shop === where.shop) && (!where?.status?.not || row.status !== where.status.not)),
    create: async ({ data }: any) => {
      const row = { id: `pi_${++state.seq}`, matchedProductionJobId: null, generatedProductionJobId: null, authoritativeTicket: null, printer: null, printMode: null, routingRule: null, routedFilename: null, reviewReason: null, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, createdAt: new Date(), updatedAt: new Date(), ...data };
      state.intakes.push(row);
      state.writes.push("printIntake.create");
      return row;
    },
    update: async ({ where, data }: any) => { const row = findIntake(where)!; Object.assign(row, data); state.writes.push("printIntake.update"); return row; },
    upsert: async ({ where, update, create }: any) => {
      const row = findIntake(where);
      if (row) { Object.assign(row, update); state.writes.push("printIntake.upsert:update"); return row; }
      return printIntake.create({ data: create });
    },
  };
  const productionJob = {
    findMany: async ({ where }: any) => state.jobs.filter((job) => job.shop === where.shop && job.active !== false),
    findFirst: async ({ where }: any) => state.jobs.find((job) => job.id === where.id && job.shop === where.shop && (where.active === undefined || job.active === where.active)) ?? null,
  };
  const other = (model: string) => new Proxy({}, { get: (_t, method: string) => async () => { if (/^(create|update|upsert|delete)/.test(method)) state.writes.push(`${model}.${method}`); return method === "findMany" ? [] : null; } });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "printIntake") return printIntake;
      if (key === "printLogAutoImportSetting") return { findUnique: async ({ where }: any) => state.settings.find((row) => row.uploadToken === where.uploadToken) ?? null };
      if (key === "productionJob") return new Proxy(productionJob, { get: (target: any, method: string) => target[method] ?? (async () => { state.writes.push(`productionJob.${method}`); return {}; }) });
      if (key === "productionJobEvent") return { create: async ({ data }: any) => { state.events.push(data); return {}; } };
      if (key === "$transaction") return async (fn: any) => { state.writes.push("$transaction"); return fn(db); };
      return other(key);
    },
  });
  return { default: db, db };
});

import { action as routePlan } from "../app/routes/api.print-intake.route-plan";
import { action as intakePageAction } from "../app/routes/app.erp.print-intake";
import { OWNER_USER_IDS_ENV } from "../app/lib/owner-authorization.server";
import {
  buildIntakeMachineContext,
  decideIntakeMachine,
  decideIntakeRoute,
  decideMachine,
  intakePrintModeStated,
  needsWhiteLayer,
  parseIntakeLayerTokens,
  type IntakeItem,
} from "../app/lib/print-intake-routing.server";
import { CONFIRM_PRINT_MODE_LABEL, CONFIRM_PRINT_MODE_REASON, PRINTER_CONFLICT_LABEL, PRINTER_CONFLICT_REASONS, canonicalReviewReason, reviewReasonLabel } from "../app/lib/print-intake-review.server";
import { resolveCanonicalMachineRouting } from "../app/lib/machine-routing.server";

const TOKEN = "tok-live";
const HASH = (char: string) => char.repeat(64);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const load = (mimaki: number, roland: number) => ({ source: "t", capturedAt: "t", unattributedOpenItems: 0, byPrinter: { mimaki: { openItems: mimaki, estimatedMinutes: mimaki * 10 }, roland: { openItems: roland, estimatedMinutes: roland * 10 } } });

function item(overrides: Partial<IntakeItem> = {}): IntakeItem {
  return { id: "item_1", itemTicket: "GSO-20261118-0001-01", ripJobName: "GSO-20261118-0001-01", suggestedFileName: null, productTitle: "Bag", selectedFinish: "CMYK", materialSummary: null, machineSummary: null, ...overrides };
}
function job(overrides: Row = {}): Row {
  return { id: "job_1", shop: "shop-1", active: true, status: "new", actualCostFinalized: false, jobTicket: "GSO-20261118-0001", customerName: "Real Customer", company: null, artworkUrl: null, printFileUrl: null, items: [item()], files: [], ...overrides };
}
async function plan(fields: Row) {
  const response = await routePlan({ request: new Request("https://app.test/api/print-intake/route-plan", { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return ((await response.json()) as any).plan;
}
const assign = (intakeId: string, target = "job_1|item_1") => intakePageAction({ request: new Request("https://app.test/app/erp/print-intake", { method: "POST", body: new URLSearchParams({ intent: "assign", intakeId, target }) }) }) as Promise<any>;
const jobWrites = () => state.writes.filter((write) => /^productionJob|^\$transaction/.test(write));
const intakeFor = (fileName: string) => state.intakes.find((row) => row.originalFilename === fileName)!;

beforeEach(() => {
  state.settings = [{ shop: "shop-1", uploadToken: TOKEN, enabled: true }];
  state.jobs = [job()];
  state.intakes = [];
  state.events = [];
  state.writes = [];
  state.seq = 0;
  process.env[OWNER_USER_IDS_ENV] = "9001";
});

describe("1. explicit press", () => {
  it("ERP-assigned Roland routes Roland; ERP-assigned Mimaki routes Mimaki", () => {
    expect(decideIntakeMachine(item({ machineSummary: "Roland LG-640" }))).toMatchObject({ machine: "roland", machineRule: "explicit_erp_machine" });
    expect(decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }))).toMatchObject({ machine: "mimaki", machineRule: "explicit_erp_machine" });
  });
  it("a filename ROLAND / MIMAKI tag works when the ERP assigns no press", () => {
    expect(decideIntakeMachine(item(), "GSO-20261118-0001-01_ROLAND.pdf")).toMatchObject({ machine: "roland", machineRule: "explicit_roland_tag" });
    expect(decideIntakeMachine(item(), "GSO-20261118-0001-01_MIMAKI.pdf")).toMatchObject({ machine: "mimaki", machineRule: "explicit_mimaki_tag" });
    expect(decideIntakeMachine(item(), "Rolando_art.pdf").machine).toBe("mimaki"); // not a tag
  });
  it("an explicit press is honoured for CMYK-only work; it never overrides a white / gloss requirement (see section 10)", () => {
    expect(decideIntakeMachine(item({ selectedFinish: "CMYK", machineSummary: "Roland LG-640" })).machine).toBe("roland");
    expect(decideIntakeMachine(item({ selectedFinish: "CMYK", machineSummary: "Mimaki UCJV300-130" })).machine).toBe("mimaki");
    expect(decideIntakeMachine(item({ selectedFinish: "White ink", machineSummary: "Mimaki UCJV300-130" })).machine).toBeNull();
  });
});

describe("2. job requirements", () => {
  it("white-required jobs route Roland", () => {
    for (const fields of [{ selectedFinish: "White ink" }, { selectedFinish: "White" }, { materialSummary: "Material: Holographic | Gloss Layers: 0X | White Layers: 1 | Holographic: yes" }, { selectedFinish: "Holo + White" }, { selectedFinish: "WHITE-2X" }]) {
      expect(decideIntakeMachine(item(fields)), JSON.stringify(fields)).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
    }
  });
  it("gloss and spot-gloss jobs no longer force a press: nothing explicit -> Mimaki (2026-11-18); gloss + white still -> Roland for the white", () => {
    for (const fields of [{ selectedFinish: "Gloss" }, { selectedFinish: "Matte + 4X Spot Gloss" }, { selectedFinish: "GLOSS-3X" }, { materialSummary: "Finish: 2X Spot Gloss | Gloss Layers: 2X" }]) {
      expect(decideIntakeMachine(item(fields)), JSON.stringify(fields)).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_gloss_default_mimaki"] });
    }
    expect(decideIntakeMachine(item({ selectedFinish: "Holo + White + 4X Spot Gloss" }))).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
  });
  it("CMYK-only with no printer hint routes Mimaki — a stated zero, a colour or a product word is not a requirement", () => {
    for (const fields of [{}, { selectedFinish: "No Specialty — 0X", materialSummary: "Material: Matte | Finish: No Specialty — 0X | Gloss Layers: 0X | White Layers: 0" }, { selectedFinish: "CMYK", materialSummary: "Product Type: jar_3oz_black_white | Material: Matte | Bag Color: White" },{ selectedFinish: "Matte", materialSummary: "Bag Color: White | Sides: Front" }]) {
      expect(decideIntakeMachine(item(fields)), JSON.stringify(fields)).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
    }
    expect(needsWhiteLayer(item({ materialSummary: "Bag Color: White" }))).toBe(false);
    expect(needsWhiteLayer(item({ materialSummary: "White Layers: 0" }))).toBe(false);
    expect(decideIntakeMachine(item(), "kk_WHITE CHERRY AIRHEADS_B.pdf").machine).toBe("mimaki"); // "WHITE" in a product name
  });
});

describe("3. no load balancing for Print Intake", () => {
  it("the same file resolves the same way whatever the press load is", () => {
    for (const machineLoad of [undefined, null, load(0, 9), load(9, 0), load(3, 3)]) {
      const decision = decideIntakeRoute({ fileName: "GSO-20261118-0001-01.pdf", jobs: [job() as any].map((j) => ({ ...j, fileNames: [] })), machineLoad });
      expect(decision).toMatchObject({ decision: "route", machine: "mimaki", machineRule: "default_cmyk" });
    }
  });
  it("the endpoint and the intake resolver contain no load-balancing call", () => {
    const route = src("app/routes/api.print-intake.route-plan.tsx");
    expect(route).not.toContain("loadMachineWorkload");
    expect(route).not.toContain("selectLessBusyPrinter");
    expect(route).not.toContain("machineLoad");
    expect(route).not.toMatch(/\bdecideMachine\(/);
    expect(route).not.toContain("decideMachineFromFilename");
    const lib = src("app/lib/print-intake-routing.server.ts");
    const resolver = lib.slice(lib.indexOf("export function decideIntakeMachine("), lib.indexOf("export type IntakeSiblingRow"));
    expect(resolver).not.toContain("selectLessBusyPrinter");
    expect(resolver).not.toContain("auto_load_balanced");
    expect(lib).toContain("const machineDecision = decideIntakeMachine(item, fileName, contextFor ? contextFor(job, item) : {});");
  });
});

describe("4. layer suffixes", () => {
  it("_cmyk / _g / _w are read as standalone tokens; _F / _B and look-alikes are not interpreted", () => {
    expect(parseIntakeLayerTokens("crud_TOAD KILLA_F_cmyk.pdf")).toEqual({ layers: ["cmyk"], stem: "crud toad killa f" });
    expect(parseIntakeLayerTokens("crud_TOAD KILLA_F_g.pdf")).toEqual({ layers: ["gloss"], stem: "crud toad killa f" });
    expect(parseIntakeLayerTokens("BLUE CHIP_yuzu lulu_w .pdf")).toEqual({ layers: ["white"], stem: "blue chip yuzu lulu" });
    expect(parseIntakeLayerTokens("BLUE CHIP_yuzu lulu_CMYK .pdf").stem).toBe("blue chip yuzu lulu");
    expect(parseIntakeLayerTokens("up in smoke_tip off_g_sl roland.pdf")).toEqual({ layers: ["gloss"], stem: "up in smoke tip off sl" });
    for (const name of ["kk_FROOT LOOPS TROP_F.pdf", "kk_FROOT LOOPS TROP_B.pdf", "All the smoke_all star_1g_98mm.pdf", "All the smoke_all star_dw_98mm.pdf", "bc exotics_POT5_b_p.pdf", "kk_bubble yum_B_R.pdf", "gso-rainbow-ap.pdf", "KRUDE LIFE LEM_kiwi starw.pdf"]) {
      expect(parseIntakeLayerTokens(name).layers, name).toEqual([]);
    }
    expect(parseIntakeLayerTokens("g_money_label.pdf").layers).toEqual([]); // never the leading segment
  });
  it("_cmyk alone, with no other layer known for the job, routes Mimaki", () => {
    expect(decideIntakeMachine(item(), "crud_TOAD KILLA_F_cmyk.pdf")).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
  });
  it("_g on its own file is a gloss layer and follows CMYK to the Mimaki; _w means white -> Roland", () => {
    expect(decideIntakeMachine(item(), "crud_TOAD KILLA_F_g.pdf")).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
    expect(decideIntakeMachine(item(), "blue chip_HAWAIIAN SKUNK_W.pdf")).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
  });
  it("_cmyk + _g of the same job BOTH resolve Mimaki; _cmyk + _w of the same job BOTH resolve Roland", () => {
    const pair = (a: string, b: string) => [decideIntakeMachine(item(), a, { relatedFileNames: [b] }).machine, decideIntakeMachine(item(), b, { relatedFileNames: [a] }).machine];
    expect(pair("crud_TOAD KILLA_F_cmyk.pdf", "crud_TOAD KILLA_F_g.pdf")).toEqual(["mimaki", "mimaki"]);
    expect(pair("blue chip_HAWAIIAN SKUNK_cmyk.pdf", "blue chip_HAWAIIAN SKUNK_W.pdf")).toEqual(["roland", "roland"]);
  });
  it("siblings are found by item ticket, single-item job, or the exact design stem — never by a near name", () => {
    const rows = [
      { fileHashSha256: HASH("1"), originalFilename: "crud_TOAD KILLA_F_g.pdf", authoritativeTicket: null, matchedProductionJobId: null, printer: null, status: "review" },
      { fileHashSha256: HASH("2"), originalFilename: "crud_TOAD KILLA_B_g.pdf", authoritativeTicket: null, matchedProductionJobId: null, printer: null, status: "review" },
      { fileHashSha256: HASH("3"), originalFilename: "crud_TOAD KILLER_F_g.pdf", authoritativeTicket: null, matchedProductionJobId: null, printer: null, status: "review" },
      { fileHashSha256: HASH("4"), originalFilename: "other art.pdf", authoritativeTicket: "GSO-20261118-0001-01", matchedProductionJobId: "job_1", printer: "roland", status: "routed" },
      { fileHashSha256: HASH("5"), originalFilename: "rejected_TOAD KILLA_F_g.pdf", authoritativeTicket: "GSO-20261118-0001-01", matchedProductionJobId: "job_1", printer: "mimaki", status: "rejected" },
      { fileHashSha256: HASH("9"), originalFilename: "crud_TOAD KILLA_F_cmyk.pdf", authoritativeTicket: null, matchedProductionJobId: null, printer: null, status: "review" },
    ];
    const context = buildIntakeMachineContext({ fileName: "crud_TOAD KILLA_F_cmyk.pdf", fileHash: HASH("9"), jobId: "job_1", jobItemCount: 1, itemTicket: "GSO-20261118-0001-01", rows });
    expect(context.relatedFileNames).toEqual(["crud_TOAD KILLA_F_g.pdf", "other art.pdf"]);
    expect(context.routedSiblingPrinters).toEqual(["roland"]);
    const none = buildIntakeMachineContext({ fileName: "plain art.pdf", fileHash: HASH("8"), jobId: null, jobItemCount: 0, itemTicket: null, rows });
    expect(none).toEqual({ relatedFileNames: [], routedSiblingPrinters: [] });
  });
});

describe("5. conflicts go to review, never to a press", () => {
  it("both printer tags, a tag against the ERP press, or white sent to the Mimaki", () => {
    const cases: Array<[ReturnType<typeof decideIntakeMachine>, string]> = [
      [decideIntakeMachine(item(), "Cust_Product_Roland_Mimaki.pdf"), "printer_token_conflict"],
      [decideIntakeMachine(item(), "art_cmyk_MIMAKI.pdf", { relatedFileNames: ["art_g_ROLAND.pdf"] }), "printer_token_conflict"],
      [decideIntakeMachine(item({ machineSummary: "Roland LG-640" }), "GSO-20261118-0001-01_MIMAKI.pdf"), "printer_assignment_contradiction"],
      [decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }), "GSO-20261118-0001-01_ROLAND.pdf"), "printer_assignment_contradiction"],
      [decideIntakeMachine(item({ selectedFinish: "White ink", machineSummary: "Mimaki UCJV300-130" })), "premium_mode_mimaki_contradiction"],
      [decideIntakeMachine(item(), "art_cmyk_MIMAKI.pdf", { relatedFileNames: ["art_w.pdf"] }), "premium_mode_mimaki_contradiction"],
      [decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }), "art_w.pdf"), "premium_mode_mimaki_contradiction"],
      [decideIntakeMachine(item(), "art_w.pdf", { routedSiblingPrinters: ["mimaki"] }), "layer_printer_split"],
    ];
    for (const [decision, code] of cases) {
      expect(decision.machine, code).toBeNull();
      expect(canonicalReviewReason(decision.reasons), decision.reasons.join(",")).toBe(code);
      expect(PRINTER_CONFLICT_REASONS).toContain(code);
    }
    expect(PRINTER_CONFLICT_LABEL).toBe("NEEDS REVIEW — PRINTER CONFLICT");
    expect(decideIntakeMachine(item({ machineSummary: "Mimaki or Roland" })).machine).toBeNull();
    expect(decideIntakeMachine(item({ selectedFinish: "Primer" })).machine).toBeNull();
  });
  it("the queue labels those rows as a printer conflict (resolved server-side)", () => {
    const page = src("app/routes/app.erp.print-intake.tsx");
    expect(page).toContain("PRINTER_CONFLICT_REASONS.includes(String(row.reviewReason || \"\"))");
    expect(page).toContain("? PRINTER_CONFLICT_LABEL");
    expect(page).toContain("? CONFIRM_PRINT_MODE_LABEL");
    expect(page).toContain("NEEDS REVIEW — PRINTER CONFLICT");
    expect(page).toContain("There is no load balancing.");
  });
});

describe("6. through the real endpoint: one job, one press", () => {
  const CMYK = "crud_TOAD KILLA_F_cmyk.pdf";
  const GLOSS = "crud_TOAD KILLA_F_w.pdf"; // the special (white) layer — kept under its old constant name

  it("layer names stored on the job: the CMYK layer routes Roland before the white layer is even dropped", async () => {
    state.jobs = [job({ files: [{ fileName: CMYK, originalFileName: null }, { fileName: GLOSS, originalFileName: null }] })];
    expect(await plan({ fileName: CMYK, fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "job_file_name", machine: "roland", machineRule: "white_requires_roland", jobId: "job_1" });
    expect(await plan({ fileName: GLOSS, fileHash: HASH("b") })).toMatchObject({ decision: "route", machine: "roland", machineRule: "white_requires_roland", jobId: "job_1" });
    expect(state.intakes.map((row) => row.printer)).toEqual(["roland", "roland"]);
    expect(jobWrites()).toEqual([]);
  });

  it("both layers dropped unmatched, then assigned one at a time: both route Roland", async () => {
    expect((await plan({ fileName: CMYK, fileHash: HASH("a") })).decision).toBe("review");
    expect((await plan({ fileName: GLOSS, fileHash: HASH("b") })).decision).toBe("review");
    expect((await assign(intakeFor(CMYK).id)).ok).toBe(true);
    expect(await plan({ fileName: CMYK, fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "assigned_by_owner", machine: "roland", machineRule: "white_requires_roland" });
    expect((await assign(intakeFor(GLOSS).id)).ok).toBe(true);
    expect(await plan({ fileName: GLOSS, fileHash: HASH("b") })).toMatchObject({ decision: "route", rule: "assigned_by_owner", machine: "roland" });
    expect(state.intakes.map((row) => [row.status, row.printer])).toEqual([["routed", "roland"], ["routed", "roland"]]);
    expect(jobWrites()).toEqual([]);
  });

  it("white layer + CMYK layer of one job: both route Roland", async () => {
    const c = "blue chip_HAWAIIAN SKUNK_cmyk.pdf";
    const w = "blue chip_HAWAIIAN SKUNK_W.pdf";
    await plan({ fileName: c, fileHash: HASH("a") });
    await plan({ fileName: w, fileHash: HASH("b") });
    await assign(intakeFor(c).id);
    await assign(intakeFor(w).id);
    expect(await plan({ fileName: c, fileHash: HASH("a") })).toMatchObject({ decision: "route", machine: "roland", machineRule: "white_requires_roland" });
    expect(await plan({ fileName: w, fileHash: HASH("b") })).toMatchObject({ decision: "route", machine: "roland", machineRule: "white_requires_roland" });
  });

  it("a CMYK layer already sent to the Mimaki + a gloss layer arriving later: the later file reviews as a printer conflict, nothing is split silently", async () => {
    await plan({ fileName: CMYK, fileHash: HASH("a") });
    await assign(intakeFor(CMYK).id);
    expect(await plan({ fileName: CMYK, fileHash: HASH("a") })).toMatchObject({ decision: "route", machine: "mimaki", machineRule: "default_cmyk" }); // alone -> Mimaki
    await plan({ fileName: GLOSS, fileHash: HASH("b") });
    await assign(intakeFor(GLOSS).id);
    const late = await plan({ fileName: GLOSS, fileHash: HASH("b") });
    expect(late.decision).toBe("review");
    expect(late.machine ?? null).toBeNull();
    expect(canonicalReviewReason(late.reasons)).toBe("layer_printer_split");
    expect(intakeFor(GLOSS).status).toBe("assigned"); // still waiting on a person; not routed
    expect(intakeFor(CMYK)).toMatchObject({ status: "routed", printer: "mimaki" });
  });

  it("ERP gloss metadata on the item no longer sends the file to the Roland — it follows CMYK to the Mimaki (2026-11-18)", async () => {
    state.jobs = [job({ items: [item({ selectedFinish: "Matte + 4X Spot Gloss", materialSummary: "Material: Matte | Finish: 4X Spot Gloss" })] })];
    expect(await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "item_ticket", machine: "mimaki", machineRule: "default_cmyk" });
  });

  it("a matched conflict is recorded as a review row and never routed", async () => {
    state.jobs = [job({ items: [item({ machineSummary: "Roland LG-640" })] })];
    const result = await plan({ fileName: "GSO-20261118-0001-01_MIMAKI.pdf", fileHash: HASH("a") });
    expect(result.decision).toBe("review");
    expect(state.intakes[0]).toMatchObject({ status: "review", reviewReason: "printer_assignment_contradiction", printer: null });
    expect(jobWrites()).toEqual([]);
  });
});

describe("7. idempotency — a file never alternates presses between polls", () => {
  it("ten identical plans give the identical press", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i += 1) seen.add((await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") })).machine);
    expect([...seen]).toEqual(["mimaki"]);
    expect(state.intakes).toHaveLength(1);
  });
  it("a file already routed keeps its press even if the job's requirements change afterwards", async () => {
    expect((await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") })).machine).toBe("mimaki");
    state.jobs[0].items[0].selectedFinish = "White ink"; // edited later in the ERP
    expect(await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") })).toMatchObject({ decision: "route", machine: "mimaki" });
    expect(state.intakes[0].printer).toBe("mimaki");
    expect((await plan({ fileName: "GSO-20261118-0001-01 art v2.pdf", fileHash: HASH("b") })).decision).toBe("review"); // a NEW file for that item would split the job -> review
  });
});

describe("8. Patch C still holds", () => {
  it("unmatched files stay review-only with no press, whatever their suffix or tag says", async () => {
    for (const [index, fileName] of ["loose_art_g.pdf", "loose_art_w.pdf", "loose_art_cmyk.pdf", "loose_ROLAND.pdf"].entries()) {
      const result = await plan({ fileName, fileHash: HASH(String(index)) });
      expect(result, fileName).toMatchObject({ decision: "review", machine: null, needsLinkToJob: true, autoCreated: false });
    }
    expect(state.intakes.every((row) => row.status === "review" && row.printer === null && row.matchedProductionJobId === null)).toBe(true);
  });
  it("an ambiguous match stays review-only", async () => {
    state.jobs = [job({ files: [{ fileName: "shared art.pdf", originalFileName: null }] }), job({ id: "job_2", jobTicket: "GSO-20261118-0002", items: [item({ id: "item_2", itemTicket: "GSO-20261118-0002-01", ripJobName: "GSO-20261118-0002-01" })], files: [{ fileName: "shared art.pdf", originalFileName: null }] })];
    const result = await plan({ fileName: "shared art.pdf", fileHash: HASH("a") });
    expect(result).toMatchObject({ decision: "review", machine: null });
    expect(state.intakes[0].matchedProductionJobId).toBeNull();
  });
  it("Patch B creates no ProductionJob, item, event or transaction on any path above", async () => {
    await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") });
    await plan({ fileName: "loose_art_g.pdf", fileHash: HASH("b") });
    await plan({ fileName: "GSO-20261118-0001-01_ROLAND_MIMAKI.pdf", fileHash: HASH("c") });
    expect(jobWrites()).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.jobs).toHaveLength(1);
    const route = src("app/routes/api.print-intake.route-plan.tsx");
    expect(route).not.toMatch(/productionJob(Item)?\.(create|createMany|upsert|update)\b/);
  });
  it("legitimate matched routing still works for every rule", async () => {
    state.jobs = [job({ items: [item({ ripJobName: "Flame Society Jar Front", suggestedFileName: "Flame Society Jar Front" })], files: [{ fileName: "customer upload final.pdf", originalFileName: null }] })];
    expect(await plan({ fileName: "GSO-20261118-0001-01 x.pdf", fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "item_ticket", machine: "mimaki" });
    expect(await plan({ fileName: "GSO-20261118-0001 y.pdf", fileHash: HASH("b") })).toMatchObject({ decision: "route", rule: "job_ticket_single_item" });
    expect(await plan({ fileName: "Flame Society Jar Front.pdf", fileHash: HASH("c") })).toMatchObject({ decision: "route", rule: "stored_filename" });
    expect(await plan({ fileName: "customer upload final.pdf", fileHash: HASH("d") })).toMatchObject({ decision: "route", rule: "job_file_name" });
  });
});

describe("9. nothing outside Print Intake changed", () => {
  it("the shared decideMachine (production dispatch, order -> job) has the 2026-11-18 behaviour (updated 2026-11-18: Mimaki gloss restored; white unchanged)", () => {
    expect(decideMachine(item())).toEqual({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] });
    expect(decideMachine(item(), "", load(1, 4) as any)).toEqual({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] });
    expect(decideMachine(item(), "", load(6, 2) as any)).toEqual({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_only_default_mimaki"] }); // load is not consulted for CMYK
    expect(decideMachine(item({ selectedFinish: "White ink" }), "", load(6, 2) as any)).toMatchObject({ machine: "roland", machineRule: "auto_load_balanced" }); // white unchanged
    expect(decideMachine(item({ selectedFinish: "White ink" }))).toEqual({ machine: null, machineRule: null, reasons: ["auto_machine_load_unavailable_select_printer"] }); // white unchanged
    expect(decideMachine(item({ selectedFinish: "Gloss" }))).toEqual({ machine: "mimaki", machineRule: "default_cmyk", reasons: ["cmyk_gloss_default_mimaki"] });
    for (const file of ["app/lib/ops/production-dispatch.server.ts", "app/lib/ops/production-transition-executor.server.ts", "app/lib/production-job-source.server.ts"]) {
      const text = src(file);
      expect(text, file).toMatch(/\bdecideMachine\(/);
      expect(text, file).not.toContain("decideIntakeMachine");
    }
  });
  it("quote / Cost Calculator routing still load-balances AUTO and does not use the intake resolver", () => {
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", machineLoad: load(5, 2) } as any).effectivePrinter).toBe("roland");
    expect(resolveCanonicalMachineRouting({ printerSelection: "auto", machineLoad: load(1, 4) } as any).effectivePrinter).toBe("mimaki");
    for (const file of ["app/lib/machine-routing.server.ts", "app/lib/canonical-calculator.server.ts", "app/lib/true-cost-engine.server.ts", "app/routes/app.erp.cost-calculator.tsx", "app/lib/machine-load-balancing.ts"]) {
      const text = src(file);
      expect(text, file).not.toContain("decideIntakeMachine");
      expect(text, file).not.toContain("print-intake-routing");
    }
  });
});

// ---------------------------------------------------------------------------
// Safety follow-up (2026-11-18, owner): white and gloss REQUIRE the Roland; an
// explicit Mimaki on such a job is a printer conflict; and a CMYK layer is never
// sent early when the job's print mode is unknown.
// ---------------------------------------------------------------------------
describe("10. WHITE is a Roland requirement — an explicit Mimaki is a conflict, never a route (gloss was removed from this rule 2026-11-18)", () => {
  const WHITE = { selectedFinish: "White ink" };
  const GLOSS = { selectedFinish: "Holo + White + 4X Spot Gloss" }; // gloss alone no longer counts; this one also needs white
  const HOLO = { selectedFinish: "No Specialty — 0X", materialSummary: "Material: Holographic | Gloss Layers: 0X | White Layers: 1 | Holographic: yes" };
  const conflict = (decision: ReturnType<typeof decideIntakeMachine>) => {
    expect(decision.machine).toBeNull();
    expect(canonicalReviewReason(decision.reasons)).toBe("premium_mode_mimaki_contradiction");
    expect(PRINTER_CONFLICT_REASONS).toContain("premium_mode_mimaki_contradiction");
  };
  it("1-2. white or gloss with no explicit press -> Roland", () => {
    expect(decideIntakeMachine(item(WHITE))).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
    expect(decideIntakeMachine(item(GLOSS))).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
    expect(decideIntakeMachine(item(HOLO))).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
  });
  it("3-4. white or gloss with an explicit ROLAND (ERP or filename) -> Roland", () => {
    for (const fields of [WHITE, GLOSS, HOLO]) {
      expect(decideIntakeMachine(item({ ...fields, machineSummary: "Roland LG-640" })).machine).toBe("roland");
      expect(decideIntakeMachine(item(fields), "GSO-20261118-0001-01_ROLAND.pdf").machine).toBe("roland");
    }
  });
  it("5-6. white or gloss with a MIMAKI filename tag -> printer conflict, no route", () => {
    for (const fields of [WHITE, GLOSS, HOLO]) conflict(decideIntakeMachine(item(fields), "GSO-20261118-0001-01_MIMAKI.pdf"));
    conflict(decideIntakeMachine(item(), "art_w_MIMAKI.pdf"));
    expect(decideIntakeMachine(item(), "art_g_MIMAKI.pdf")).toMatchObject({ machine: "mimaki", machineRule: "explicit_mimaki_tag" }); // gloss + Mimaki is valid now
    conflict(decideIntakeMachine(item(), "art_cmyk_MIMAKI.pdf", { relatedFileNames: ["art_w.pdf"] }));
    conflict(decideIntakeMachine(item(), "Cust_2x white_MIMAKI.pdf"));
  });
  it("7-8. ERP-assigned Mimaki on a white- or gloss-required job -> printer conflict, no route", () => {
    for (const fields of [WHITE, GLOSS, HOLO]) conflict(decideIntakeMachine(item({ ...fields, machineSummary: "Mimaki UCJV300-130" })));
    conflict(decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }), "art_w.pdf"));
    conflict(decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }), "art_cmyk.pdf", { relatedFileNames: ["art_w.pdf"] }));
  });
  it("9-11. CMYK only: explicit Mimaki -> Mimaki, explicit Roland -> Roland, no hint -> Mimaki", () => {
    expect(decideIntakeMachine(item({ machineSummary: "Mimaki UCJV300-130" }))).toMatchObject({ machine: "mimaki", machineRule: "explicit_erp_machine" });
    expect(decideIntakeMachine(item(), "x_MIMAKI.pdf")).toMatchObject({ machine: "mimaki", machineRule: "explicit_mimaki_tag" });
    expect(decideIntakeMachine(item({ machineSummary: "Roland LG-640" }))).toMatchObject({ machine: "roland", machineRule: "explicit_erp_machine" });
    expect(decideIntakeMachine(item(), "x_ROLAND.pdf")).toMatchObject({ machine: "roland", machineRule: "explicit_roland_tag" });
    expect(decideIntakeMachine(item())).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
  });
  it("through the endpoint: a white job assigned to the Mimaki in the ERP is recorded as a printer conflict and not routed", async () => {
    state.jobs = [job({ items: [item({ selectedFinish: "Holo + White", machineSummary: "Mimaki UCJV300-130" })] })];
    const result = await plan({ fileName: "GSO-20261118-0001-01 art.pdf", fileHash: HASH("a") });
    expect(result.decision).toBe("review");
    expect(result.machine ?? null).toBeNull();
    expect(state.intakes[0]).toMatchObject({ status: "review", reviewReason: "premium_mode_mimaki_contradiction", printer: null });
    expect(reviewReasonLabel("premium_mode_mimaki_contradiction")).toContain("White work with the Mimaki selected");
  });
});

describe("11. late-layer splits are prevented", () => {
  const CMYK = "crud_TOAD KILLA_F_cmyk.pdf";
  it("12-13. a _cmyk file whose ERP job already says white routes Roland before any sibling arrives; a gloss job's _cmyk file goes to the Mimaki", async () => {
    expect(decideIntakeMachine(item({ selectedFinish: "Matte + 4X Spot Gloss" }), CMYK)).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
    expect(decideIntakeMachine(item({ selectedFinish: "Holo + White" }), CMYK)).toMatchObject({ machine: "roland", machineRule: "white_requires_roland" });
    expect(decideIntakeMachine(item({ selectedFinish: null, materialSummary: "Label Material: Holographic Vinyl | White Layers: 1 | Holographic: yes" }), CMYK).machine).toBe("roland");
    state.jobs = [job({ items: [item({ selectedFinish: "GLOSS-3X" })] })];
    await plan({ fileName: CMYK, fileHash: HASH("a") });
    await assign(intakeFor(CMYK).id);
    expect(await plan({ fileName: CMYK, fileHash: HASH("a") })).toMatchObject({ decision: "route", machine: "mimaki", machineRule: "default_cmyk" }); // a gloss job's CMYK layer: Mimaki
  });
  it("14. a _cmyk file whose ERP job states a CMYK-only finish routes Mimaki immediately", () => {
    for (const fields of [{ selectedFinish: "CMYK" }, { selectedFinish: "No Specialty — 0X", materialSummary: "Finish: No Specialty — 0X | Gloss Layers: 0X | White Layers: 0 | Holographic: no" }, { selectedFinish: "No Spot Gloss" }, { selectedFinish: null, materialSummary: "Family: Jars | Specialty: No Spot Gloss | Holographic: no" }, { selectedFinish: "base" }]) {
      expect(intakePrintModeStated(item(fields)), JSON.stringify(fields)).toBe(true);
      expect(decideIntakeMachine(item(fields), CMYK), JSON.stringify(fields)).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" });
    }
  });
  it("15. a _cmyk file on a job that states NO finish at all, with no sibling and no explicit press, is held — not routed", () => {
    const unknown = item({ selectedFinish: null, materialSummary: null, machineSummary: null });
    expect(intakePrintModeStated(unknown)).toBe(false);
    const held = decideIntakeMachine(unknown, CMYK);
    expect(held.machine).toBeNull();
    expect(canonicalReviewReason(held.reasons)).toBe(CONFIRM_PRINT_MODE_REASON);
    expect(CONFIRM_PRINT_MODE_LABEL).toBe("NEEDS REVIEW — CONFIRM PRINT MODE");
    expect(reviewReasonLabel(CONFIRM_PRINT_MODE_REASON)).toContain("Release / Retry");
    expect(decideIntakeMachine(item({ selectedFinish: "", materialSummary: "Shopify order: #1001" }), CMYK).machine).toBeNull(); // still no finish statement
  });
  it("the hold is narrow: a plain-named file, an explicit press, or a known sibling all resolve at once on the same unknown job", () => {
    const unknown = item({ selectedFinish: null, materialSummary: null, machineSummary: null });
    expect(decideIntakeMachine(unknown, "GSO-20261118-0001-01 art.pdf")).toMatchObject({ machine: "mimaki", machineRule: "default_cmyk" }); // not a layer file
    expect(decideIntakeMachine(unknown, "crud_TOAD KILLA_F_cmyk_MIMAKI.pdf")).toMatchObject({ machine: "mimaki", machineRule: "explicit_mimaki_tag" });
    expect(decideIntakeMachine(unknown, "crud_TOAD KILLA_F_cmyk_ROLAND.pdf").machine).toBe("roland");
    expect(decideIntakeMachine({ ...unknown, machineSummary: "Mimaki UCJV300-130" }, CMYK).machine).toBe("mimaki");
    expect(decideIntakeMachine(unknown, CMYK, { relatedFileNames: ["crud_TOAD KILLA_F_g.pdf"] }).machine).toBe("mimaki"); // a known gloss sibling: the pair stays on the Mimaki
    expect(decideIntakeMachine(unknown, CMYK, { relatedFileNames: ["crud_TOAD KILLA_F_w.pdf"] }).machine).toBe("roland");
  });
  it("through the endpoint: the held CMYK layer waits, then routes Roland once its WHITE sibling is known — the job is never split", async () => {
    const GLOSS = "crud_TOAD KILLA_F_w.pdf"; // the special (white) layer
    state.jobs = [job({ items: [item({ selectedFinish: null, materialSummary: null, machineSummary: null })] })];
    await plan({ fileName: CMYK, fileHash: HASH("a") });
    await assign(intakeFor(CMYK).id);
    const first = await plan({ fileName: CMYK, fileHash: HASH("a") });
    expect(first.decision).toBe("review");
    expect(first.machine ?? null).toBeNull();
    expect(canonicalReviewReason(first.reasons)).toBe(CONFIRM_PRINT_MODE_REASON);
    expect(intakeFor(CMYK)).toMatchObject({ status: "assigned", reviewReason: CONFIRM_PRINT_MODE_REASON, printer: null });
    const writesAfterFirstHold = state.writes.length;
    await plan({ fileName: CMYK, fileHash: HASH("a") });
    await plan({ fileName: CMYK, fileHash: HASH("a") });
    expect(state.writes.length).toBe(writesAfterFirstHold); // repeat polls of the held file write nothing
    await plan({ fileName: GLOSS, fileHash: HASH("b") }); // the white layer arrives (unmatched -> review row)
    expect(await plan({ fileName: CMYK, fileHash: HASH("a") })).toMatchObject({ decision: "route", rule: "assigned_by_owner", machine: "roland", machineRule: "white_requires_roland" });
    await assign(intakeFor(GLOSS).id);
    expect(await plan({ fileName: GLOSS, fileHash: HASH("b") })).toMatchObject({ decision: "route", machine: "roland" });
    expect(state.intakes.map((row) => row.printer)).toEqual(["roland", "roland"]);
    expect(jobWrites()).toEqual([]);
  });
  it("16-17. _cmyk + _w siblings both resolve Roland; _cmyk + _g siblings both resolve Mimaki", () => {
    const unknown = item({ selectedFinish: null, materialSummary: null, machineSummary: null });
    for (const [sibling, press] of [["crud_TOAD KILLA_F_g.pdf", "mimaki"], ["crud_TOAD KILLA_F_w.pdf", "roland"]]) {
      expect(decideIntakeMachine(unknown, CMYK, { relatedFileNames: [sibling] }).machine, sibling).toBe(press);
      expect(decideIntakeMachine(unknown, sibling, { relatedFileNames: [CMYK] }).machine, sibling).toBe(press);
    }
  });
  it("18. a layer already routed to the other press is a conflict — never a silent switch", () => {
    const late = decideIntakeMachine(item(), "crud_TOAD KILLA_F_w.pdf", { relatedFileNames: [CMYK], routedSiblingPrinters: ["mimaki"] });
    expect(late.machine).toBeNull();
    expect(canonicalReviewReason(late.reasons)).toBe("layer_printer_split");
  });
  it("19-20. unmatched intake stays review-only and nothing here creates a ProductionJob", async () => {
    state.jobs = [job({ items: [item({ selectedFinish: null, materialSummary: null, machineSummary: null })] })];
    expect(await plan({ fileName: "loose_art_cmyk.pdf", fileHash: HASH("a") })).toMatchObject({ decision: "review", machine: null, needsLinkToJob: true, autoCreated: false });
    expect(await plan({ fileName: "loose_art_w_MIMAKI.pdf", fileHash: HASH("b") })).toMatchObject({ decision: "review", machine: null, needsLinkToJob: true });
    expect(state.intakes.every((row) => row.matchedProductionJobId === null && row.printer === null)).toBe(true);
    expect(jobWrites()).toEqual([]);
    expect(state.jobs).toHaveLength(1);
  });
});
