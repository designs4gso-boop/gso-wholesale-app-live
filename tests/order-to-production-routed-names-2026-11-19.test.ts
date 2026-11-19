// Order-to-production O2 (2026-11-19) — the routed print-file name carries the
// item ticket AND the staff file name:
//     <ITEM TICKET>__<staff file name>[__<run>]<.ext>
// Staff never type a ticket. Matching rules are unchanged (exact ticket /
// folder / stored name only; nothing fuzzy; no job is ever created from a file).
// Drives the real route-plan and report endpoints against an in-memory database.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const state: { settings: Row[]; jobs: Row[]; intakes: Row[]; files: Row[]; events: Row[]; writes: string[]; seq: number } = { settings: [], jobs: [], intakes: [], files: [], events: [], writes: [], seq: 0 };

vi.mock("../app/db.server", () => {
  const findIntake = (where: any) => {
    if (where?.shop_fileHashSha256) return state.intakes.find((row) => row.shop === where.shop_fileHashSha256.shop && row.fileHashSha256 === where.shop_fileHashSha256.fileHashSha256) ?? null;
    return state.intakes.find((row) => (!where?.id || row.id === where.id) && (!where?.shop || row.shop === where.shop)) ?? null;
  };
  const printIntake = {
    findUnique: async ({ where }: any) => findIntake(where),
    // Honours every field of the revision lookup, including the staff file name.
    findFirst: async ({ where, orderBy }: any) => {
      if (!where?.authoritativeTicket) return findIntake(where);
      const hits = state.intakes.filter((row) =>
        row.shop === where.shop
        && row.authoritativeTicket === where.authoritativeTicket
        && (!where.status || row.status === where.status)
        && (where.originalFilename === undefined || row.originalFilename === where.originalFilename)
        && row.fileHashSha256 !== where.NOT?.fileHashSha256);
      if (orderBy?.revisionNumber === "desc") hits.sort((a, b) => b.revisionNumber - a.revisionNumber);
      return hits[0] ?? null;
    },
    findMany: async ({ where }: any = {}) => state.intakes.filter((row) => (!where?.shop || row.shop === where.shop) && (!where?.status?.not || row.status !== where.status.not)),
    create: async ({ data }: any) => {
      const row = { id: `pi_${++state.seq}`, matchedProductionJobId: null, generatedProductionJobId: null, authoritativeTicket: null, printer: null, printMode: null, routingRule: null, routedFilename: null, reviewReason: null, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1, createdAt: new Date(), updatedAt: new Date(), ...data };
      state.intakes.push(row);
      return row;
    },
    update: async ({ where, data }: any) => { const row = findIntake(where)!; Object.assign(row, data); return row; },
    upsert: async ({ where, update, create }: any) => { const row = findIntake(where); if (row) { Object.assign(row, update); return row; } return printIntake.create({ data: create }); },
  };
  const matches = (row: Row, where: Row) => Object.entries(where || {}).every(([key, value]) => row[key] === value);
  const productionJobFile = {
    findFirst: async ({ where }: any) => state.files.find((row) => matches(row, where)) ?? null,
    create: async ({ data }: any) => { const row = { id: `file_${++state.seq}`, createdAt: new Date(), ...data }; state.files.push(row); return row; },
    update: async ({ where, data }: any) => { const row = state.files.find((file) => file.id === where.id)!; Object.assign(row, data); return row; },
  };
  const productionJob = {
    findMany: async ({ where }: any) => state.jobs.filter((job) => job.shop === where.shop && job.active === where.active),
    findFirst: async ({ where }: any) => state.jobs.find((job) => (!where.id || job.id === where.id) && job.shop === where.shop) ?? null,
  };
  const other = (model: string) => new Proxy({}, { get: (_t, method: string) => async () => { if (/^(create|update|upsert|delete)/.test(method)) state.writes.push(`${model}.${method}`); return method === "findMany" ? [] : null; } });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "printIntake") return printIntake;
      if (key === "productionJobFile") return productionJobFile;
      if (key === "printLogAutoImportSetting") return {
        findUnique: async ({ where }: any) => state.settings.find((row) => row.uploadToken === where.uploadToken) ?? null,
        update: async ({ where, data }: any) => { Object.assign(state.settings.find((row) => row.id === where.id)!, data); return {}; },
      };
      if (key === "productionJob") return new Proxy(productionJob, { get: (target: any, method: string) => target[method] ?? (async () => { state.writes.push(`productionJob.${method}`); return {}; }) });
      if (key === "productionJobEvent") return { create: async ({ data }: any) => { state.events.push(data); return {}; } };
      if (key === "$queryRawUnsafe") return async () => [{ gso_lock: "" }];
      if (key === "$transaction") return async (arg: any) => (typeof arg === "function" ? arg(db) : Promise.all(arg));
      return other(key);
    },
  });
  return { default: db, db };
});

import { action as routePlan } from "../app/routes/api.print-intake.route-plan";
import { action as report } from "../app/routes/api.print-intake.report";
import {
  applyRunSuffix,
  decideIntakeRoute,
  parseIntakeLayerTokens,
  parseRunIdentity,
  ripFileBaseName,
  routedStaffNameSegment,
} from "../app/lib/print-intake-routing.server";
import { parseRipTickets } from "../app/lib/rip-identity-match.server";

const TOKEN = "tok-live";
const HASH = (char: string) => char.repeat(64);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const JOB = "GSO-20261119-0042";
const FOLDER = `${JOB} CRUD`;

function item(n: number, overrides: Row = {}): Row {
  const ticket = `${JOB}-0${n}`;
  return { id: `item_${n}`, itemTicket: ticket, ripJobName: ticket, suggestedFileName: `${ticket}_POUCH_QTY500`, productTitle: "Pouch", selectedFinish: "CMYK + Gloss", materialSummary: null, machineSummary: null, ...overrides };
}
function job(items: Row[]): Row {
  return { id: "job_42", shop: "shop-1", active: true, status: "new", actualCostFinalized: false, jobTicket: JOB, customerName: "CRUD", company: null, artworkUrl: null, printFileUrl: null, items, files: [] };
}
async function plan(fields: Row) {
  const response = await routePlan({ request: new Request("https://app.test/api/print-intake/route-plan", { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return ((await response.json()) as any).plan;
}
async function deliver(fileName: string, hash: string, extra: Row = {}) {
  const planned = await plan({ fileName, fileHash: hash, fileSize: 10, ...extra });
  if (planned.decision !== "route") return { planned, reported: null as any };
  const response = await report({ request: new Request("https://app.test/api/print-intake/report", { method: "POST", body: JSON.stringify({ token: TOKEN, fileName, decision: "routed", rule: planned.rule, jobId: planned.jobId, jobTicket: planned.jobTicket, itemTicket: planned.itemTicket, ripName: planned.ripName, machine: planned.machine, fileHash8: hash.slice(0, 8), fileHash: hash }) }) });
  return { planned, reported: (await response.json()) as any };
}

beforeEach(() => {
  state.settings = [{ id: "set_1", shop: "shop-1", uploadToken: TOKEN, enabled: true, notes: null }];
  state.jobs = [job([item(1)])];
  state.intakes = [];
  state.files = [];
  state.events = [];
  state.writes = [];
  state.seq = 0;
});

describe("routed name = item ticket + staff file name", () => {
  it("1. a staff file in the ticket job folder routes as <item ticket>__<staff name>; the original name is kept", async () => {
    const { planned } = await deliver("crud_HEATH_F_CMYK.pdf", HASH("a"), { subfolder: FOLDER });
    expect(planned.decision).toBe("route");
    expect(planned.rule).toBe("job_subfolder");
    expect(planned.itemTicket).toBe(`${JOB}-01`);
    expect(planned.ripName).toBe(`${JOB}-01__crud_HEATH_F_CMYK`);
    expect(state.intakes[0].originalFilename).toBe("crud_HEATH_F_CMYK.pdf");
    expect(state.intakes[0].routedFilename).toBe(`${JOB}-01__crud_HEATH_F_CMYK`);
    // the job's print-file record: routed name with the extension, original name beside it
    expect(state.files).toHaveLength(1);
    expect(state.files[0].fileName).toBe(`${JOB}-01__crud_HEATH_F_CMYK.pdf`);
    expect(state.files[0].originalFileName).toBe("crud_HEATH_F_CMYK.pdf");
  });

  it("2. sibling layers keep their own names, the same press and run 1 — a second layer is not a revision", async () => {
    const cmyk = await deliver("crud_HEATH_F_CMYK.pdf", HASH("a"), { subfolder: FOLDER, folderFiles: ["crud_HEATH_F_g.pdf"] });
    const gloss = await deliver("crud_HEATH_F_g.pdf", HASH("b"), { subfolder: FOLDER, folderFiles: ["crud_HEATH_F_CMYK.pdf"] });
    expect(cmyk.planned.ripName).toBe(`${JOB}-01__crud_HEATH_F_CMYK`);
    expect(gloss.planned.ripName).toBe(`${JOB}-01__crud_HEATH_F_g`);
    expect(gloss.planned.machine).toBe(cmyk.planned.machine);
    expect(cmyk.planned.machine).toBe("mimaki"); // CMYK + gloss -> Mimaki (owner rule, unchanged)
    expect(state.intakes.map((row) => row.revisionNumber)).toEqual([1, 1]);
    expect(state.files.map((row) => row.fileName).sort()).toEqual([`${JOB}-01__crud_HEATH_F_CMYK.pdf`, `${JOB}-01__crud_HEATH_F_g.pdf`]);
    // layer suffix still readable as a layer on the routed name
    expect(parseIntakeLayerTokens(`${gloss.planned.ripName}.pdf`).layers).toEqual(["gloss"]);
  });

  it("3. a retry of the same file gets the same routed name and writes no second print-file row", async () => {
    const first = await deliver("crud_HEATH_F_CMYK.pdf", HASH("a"), { subfolder: FOLDER });
    const again = await deliver("crud_HEATH_F_CMYK.pdf", HASH("a"), { subfolder: FOLDER });
    expect(again.planned.ripName).toBe(first.planned.ripName);
    expect(state.intakes).toHaveLength(1);
    expect(state.files).toHaveLength(1);
    expect(again.reported.printFile).toBe("unchanged");
  });

  it("4. corrected artwork under the SAME staff name is revision 2; history keeps both", async () => {
    await deliver("crud_HEATH_F_CMYK.pdf", HASH("a"), { subfolder: FOLDER });
    const corrected = await deliver("crud_HEATH_F_CMYK.pdf", HASH("c"), { subfolder: FOLDER });
    expect(corrected.planned.ripName).toBe(`${JOB}-01__crud_HEATH_F_CMYK__R2-A1`);
    expect(parseRunIdentity(corrected.planned.ripName)).toEqual({ revision: 2, reprint: 0, attempt: 1 });
    expect(state.intakes).toHaveLength(2);
    expect(state.files).toHaveLength(2);
  });

  it("5. multi-item job: an item ticket in the file name picks the item; the folder alone never guesses one", async () => {
    state.jobs = [job([item(1), item(2), item(3)])];
    const exact = await plan({ fileName: `${JOB}-02 crud_SHORTCAKES_F_CMYK.pdf`, fileHash: HASH("d"), subfolder: FOLDER });
    expect(exact.decision).toBe("route");
    expect(exact.itemTicket).toBe(`${JOB}-02`);
    expect(exact.ripName).toBe(`${JOB}-02__crud_SHORTCAKES_F_CMYK`); // the typed ticket is not repeated
    const unknownItem = await plan({ fileName: "crud_MIXED_BERRIES_F_CMYK.pdf", fileHash: HASH("e"), subfolder: FOLDER });
    expect(unknownItem.decision).toBe("review");
    expect(unknownItem.reasons).toContain("folder_job_has_multiple_items_needs_link_to_item");
    expect(unknownItem.ripName).toBeNull();
  });

  it("6. a file with no business record is still held for review — no job, no item, no route", async () => {
    const loose = await plan({ fileName: "crud_HEATH_F_CMYK.pdf", fileHash: HASH("f") });
    expect(loose.decision).toBe("review");
    expect(loose.needsLinkToJob).toBe(true);
    expect(loose.autoCreated).toBe(false);
    expect(state.writes.filter((write) => write.startsWith("productionJob"))).toEqual([]);
    expect(state.intakes[0].status).toBe("review");
  });
});

describe("routed-name rules", () => {
  const one: any = item(1);

  it("7. safe Windows characters, kept extension-free, bounded length with the layer suffix preserved", () => {
    expect(routedStaffNameSegment("Crud  Heath (final) #2 F_CMYK.PDF")).toBe("Crud_Heath_final_2_F_CMYK");
    expect(routedStaffNameSegment('a<b>c:d"e|f?g*h.pdf')).toBe("a_b_c_d_e_f_g_h");
    expect(routedStaffNameSegment("double__underscore__name.pdf")).toBe("double_underscore_name"); // "__" is reserved
    const long = `${"x".repeat(150)}_F_CMYK.pdf`;
    const segment = routedStaffNameSegment(long);
    expect(segment.length).toBeLessThanOrEqual(80);
    expect(segment.endsWith("_F_CMYK")).toBe(true);
    const routed = applyRunSuffix(ripFileBaseName(one, long), { revision: 12, reprint: 12, attempt: 12 });
    expect(routed.length).toBeLessThanOrEqual(120);
    expect(parseRunIdentity(routed)).toEqual({ revision: 12, reprint: 12, attempt: 12 }); // never truncated away
  });

  it("8. a typed ticket is not repeated; a bare ticket file keeps the bare name; a custom RIP name is left alone", () => {
    expect(ripFileBaseName(one, `${JOB}-01_crud_HEATH.pdf`)).toBe(`${JOB}-01__crud_HEATH`);
    expect(ripFileBaseName(one, `${JOB}_crud_HEATH.pdf`)).toBe(`${JOB}-01__crud_HEATH`);
    expect(ripFileBaseName(one, `${JOB}-01.pdf`)).toBe(`${JOB}-01`);
    expect(ripFileBaseName(one)).toBe(`${JOB}-01`);
    expect(ripFileBaseName(item(1, { ripJobName: `${JOB}-01_JAR_3OZ` }) as any, "anything.pdf")).toBe(`${JOB}-01_JAR_3OZ`);
  });

  it("9. an explicit ROLAND / MIMAKI tag stays in the routed name and still decides the press", () => {
    const decision = decideIntakeRoute({ fileName: "crud_HEATH_F_CMYK_ROLAND.pdf", subfolder: FOLDER, jobs: [{ ...(job([item(1)]) as any), fileNames: [] }] });
    expect(decision.machine).toBe("roland");
    expect(decision.ripName).toBe(`${JOB}-01__crud_HEATH_F_CMYK_ROLAND`);
  });

  it("10. the RIP result of a routed name resolves to the exact item ticket, with or without a run", () => {
    expect(parseRipTickets(`${JOB}-01__crud_HEATH_F_CMYK.pdf`).itemTicket).toBe(`${JOB}-01`);
    expect(parseRipTickets(`${JOB}-01__crud_HEATH_F_g__P1-A1.pdf`).itemTicket).toBe(`${JOB}-01`);
    expect(parseRipTickets(`${JOB}-01__crud_HEATH_F_CMYK.pdf`).jobTicket).toBe(JOB);
  });

  it("11. a reprint keeps the item ticket and the staff name and only adds the run", () => {
    const reprint = applyRunSuffix(`${JOB}-01__crud_HEATH_F_CMYK`, { revision: 1, reprint: 1, attempt: 1 });
    expect(reprint).toBe(`${JOB}-01__crud_HEATH_F_CMYK__P1-A1`);
    expect(applyRunSuffix(reprint, { revision: 1, reprint: 2, attempt: 1 })).toBe(`${JOB}-01__crud_HEATH_F_CMYK__P2-A1`);
  });

  it("12. source pins: both route-plan branches pass the staff name; revision lookup is per staff file name; no job creation", () => {
    const routePlanSource = src("app/routes/api.print-intake.route-plan.tsx");
    expect(routePlanSource).toContain("ripFileBaseName(assignedItem as any, fileName)");
    expect(routePlanSource).toContain('authoritativeTicket: ticket, status: "routed", originalFilename: fileName, NOT: { fileHashSha256: fileHash }');
    expect(routePlanSource).not.toContain("productionJob.create");
    expect(src("app/lib/print-intake-routing.server.ts")).toContain("const ripName = ripFileBaseName(item, fileName);");
  });
});
