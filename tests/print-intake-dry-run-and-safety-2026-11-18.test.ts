// Print Intake Patch A (2026-11-18) — safety gates before live activation:
//   - `dryRun: true` on the route-plan endpoint is TRULY read-only: the same
//     decision comes back and the server writes nothing at all;
//   - the agent sends dryRun, trusts only a confirmed read-only answer, never
//     reports / copies / claims in a dry run;
//   - more than 60 eligible files in one scan = process none;
//   - no go-live cutoff = refuse to process.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const state: { settings: Row[]; jobs: Row[]; intakes: Row[]; files: Row[]; events: Row[]; writes: string[]; seq: number } = { settings: [], jobs: [], intakes: [], files: [], events: [], writes: [], seq: 0 };

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1" }, sessionToken: { sub: "9001" }, admin: {} }) },
}));

vi.mock("../app/db.server", () => {
  const findIntake = (where: any) => {
    if (where?.shop_fileHashSha256) return state.intakes.find((row) => row.shop === where.shop_fileHashSha256.shop && row.fileHashSha256 === where.shop_fileHashSha256.fileHashSha256) ?? null;
    return state.intakes.find((row) => (!where?.id || row.id === where.id) && (!where?.shop || row.shop === where.shop)) ?? null;
  };
  // EVERY write on the real client is logged — a dry run must leave this empty.
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
    upsert: async ({ where, update, create }: any) => { state.writes.push("printIntake.upsert"); const row = findIntake(where); if (row) { Object.assign(row, update); return row; } return printIntake.create({ data: create }); },
  };
  const productionJob = {
    findMany: async ({ where }: any) => state.jobs.filter((job) => job.shop === where.shop && job.active !== false),
    findFirst: async ({ where }: any) => state.jobs.find((job) => job.id === where.id && job.shop === where.shop && (where.active === undefined || job.active === where.active)) ?? null,
  };
  const other = (model: string) => new Proxy({}, { get: (_t, method: string) => async () => { if (!/^(find|count|aggregate|groupBy)/.test(method)) state.writes.push(`${model}.${method}`); return method === "findMany" ? [] : null; } });
  const db: any = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "printIntake") return printIntake;
      if (key === "printLogAutoImportSetting") return { findUnique: async ({ where }: any) => state.settings.find((row) => row.uploadToken === where.uploadToken) ?? null };
      if (key === "productionJob") return new Proxy(productionJob, { get: (target: any, method: string) => target[method] ?? (async () => { state.writes.push(`productionJob.${method}`); return {}; }) });
      if (key === "productionJobEvent") return { create: async ({ data }: any) => { state.events.push(data); state.writes.push("productionJobEvent.create"); return {}; } };
      if (key === "productionJobFile") return { findFirst: async () => null, create: async ({ data }: any) => { state.files.push(data); state.writes.push("productionJobFile.create"); return data; } };
      if (key === "$transaction") return async (arg: any) => { state.writes.push("$transaction"); return typeof arg === "function" ? arg(db) : Promise.all(arg); };
      if (key === "$queryRawUnsafe" || key === "$executeRawUnsafe") return async () => { state.writes.push(String(key)); return []; };
      return other(key);
    },
  });
  return { default: db, db };
});

import { action as routePlan, loader as routePlanInfo } from "../app/routes/api.print-intake.route-plan";
import db from "../app/db.server";
import { readOnlyIntakeDb } from "../app/lib/print-intake-dry-run.server";

const TOKEN = "tok-live";
const HASH = (char: string) => char.repeat(64);
const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function item(overrides: Row = {}): Row {
  return { id: "item_1", itemTicket: "GSO-20261118-0003-01", ripJobName: "GSO-20261118-0003-01_JAR", suggestedFileName: null, productTitle: "Jar", selectedFinish: "CMYK", materialSummary: null, machineSummary: null, ...overrides };
}
function job(overrides: Row = {}): Row {
  return { id: "job_3", shop: "shop-1", active: true, status: "new", actualCostFinalized: false, jobTicket: "GSO-20261118-0003", customerName: "Flavaz", company: null, artworkUrl: null, printFileUrl: null, items: [item()], files: [], ...overrides };
}
async function call(fields: Row) {
  const response = await routePlan({ request: new Request("https://app.test/api/print-intake/route-plan", { method: "POST", body: JSON.stringify({ token: TOKEN, ...fields }) }) });
  return { status: response.status, body: (await response.json()) as any };
}
const snapshot = () => JSON.stringify({ intakes: state.intakes, jobs: state.jobs, files: state.files, events: state.events });

beforeEach(() => {
  state.settings = [{ id: "set_1", shop: "shop-1", uploadToken: TOKEN, enabled: true, notes: null }];
  state.jobs = [job()];
  state.intakes = [];
  state.files = [];
  state.events = [];
  state.writes = [];
  state.seq = 0;
});

describe("1. the read-only facade", () => {
  it("passes every read through and never executes a write, a transaction or a raw statement", async () => {
    const calls: string[] = [];
    const real: any = {
      thing: {
        findMany: async (args: any) => { calls.push("findMany"); return [args]; },
        findUnique: async () => { calls.push("findUnique"); return { id: 1 }; },
        count: async () => { calls.push("count"); return 7; },
        create: async () => { calls.push("create"); return { id: "REAL" }; },
        update: async () => { calls.push("update"); return {}; },
        upsert: async () => { calls.push("upsert"); return {}; },
        delete: async () => { calls.push("delete"); return {}; },
        deleteMany: async () => { calls.push("deleteMany"); return {}; },
        updateMany: async () => { calls.push("updateMany"); return {}; },
        createMany: async () => { calls.push("createMany"); return {}; },
        somethingNew: async () => { calls.push("somethingNew"); return {}; },
      },
      $transaction: async () => { calls.push("$transaction"); },
      $executeRawUnsafe: async () => { calls.push("$executeRawUnsafe"); },
      $queryRawUnsafe: async () => { calls.push("$queryRawUnsafe"); },
    };
    const ro = readOnlyIntakeDb(real);
    expect(await ro.client.thing.findMany({ where: { a: 1 } })).toEqual([{ where: { a: 1 } }]);
    expect(await ro.client.thing.findUnique()).toEqual({ id: 1 });
    expect(await ro.client.thing.count()).toBe(7);
    for (const method of ["create", "update", "upsert", "delete", "deleteMany", "updateMany", "createMany", "somethingNew"]) expect(await ro.client.thing[method]({ data: {} }), method).toEqual({});
    await ro.client.$transaction([]);
    await ro.client.$executeRawUnsafe("DELETE FROM x");
    await ro.client.$queryRawUnsafe("SELECT 1");
    expect(calls).toEqual(["findMany", "findUnique", "count"]); // nothing else ever reached the real client
    expect(ro.suppressedWrites()).toEqual(["thing.create", "thing.update", "thing.upsert", "thing.delete", "thing.deleteMany", "thing.updateMany", "thing.createMany", "thing.somethingNew", "$transaction", "$executeRawUnsafe", "$queryRawUnsafe"]);
  });
});

describe("2. dryRun: true on the endpoint writes nothing and still says what WOULD happen", () => {
  it("an unmatched file: WOULD REVIEW (link to job), no PrintIntake row, no job, no event", async () => {
    const before = snapshot();
    const { status, body } = await call({ fileName: "loose art.pdf", fileHash: HASH("a"), fileSize: 9, dryRun: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, dryRun: true, wrote: false });
    expect(body.plan).toMatchObject({ decision: "review", machine: null, needsLinkToJob: true });
    expect(body.plan.reasons).toContain("needs_link_to_job");
    expect(body.suppressedWrites).toEqual(["printIntake.create"]); // the one write a real plan would have made
    expect(state.writes).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("a matched file: WOULD MATCH + WOULD ROUTE, and no PrintIntake row is created", async () => {
    const { body } = await call({ fileName: "art.pdf", subfolder: "GSO-20261118-0003 FLAVAZ", fileHash: HASH("a"), dryRun: true });
    expect(body).toMatchObject({ ok: true, dryRun: true, wrote: false });
    expect(body.plan).toMatchObject({ decision: "route", rule: "job_subfolder", jobId: "job_3", jobTicket: "GSO-20261118-0003", itemTicket: "GSO-20261118-0003-01", machine: "mimaki", ripName: "GSO-20261118-0003-01_JAR" });
    expect(body.suppressedWrites).toEqual(["printIntake.upsert"]);
    expect(state.writes).toEqual([]);
    expect(state.intakes).toEqual([]);
  });

  it("the dry-run decision is exactly the decision a real plan gives", async () => {
    state.jobs = [job({ items: [item({ selectedFinish: "Matte + 4X Spot Gloss" })] })];
    const cases: Row[] = [
      { fileName: "GSO-20261118-0003-01 art.pdf", fileHash: HASH("a") },
      { fileName: "art.pdf", subfolder: "GSO-20261118-0003", fileHash: HASH("b") },
      { fileName: "loose.pdf", fileHash: HASH("c") },
      { fileName: "GSO-20261118-0003-01_MIMAKI.pdf", fileHash: HASH("d") }, // gloss + Mimaki tag = printer conflict
      { fileName: "x.pdf", subfolder: "GSO-20261118-0999", fileHash: HASH("e") },
    ];
    for (const fields of cases) {
      const dry = (await call({ ...fields, dryRun: true })).body;
      expect(state.writes, fields.fileName).toEqual([]);
      const real = (await call(fields)).body;
      const pick = (plan: any) => ({ decision: plan.decision, rule: plan.rule ?? null, jobId: plan.jobId ?? null, itemId: plan.itemId ?? null, machine: plan.machine ?? null, machineRule: plan.machineRule ?? null, ripName: plan.ripName ?? null, reasons: plan.reasons });
      expect(pick(dry.plan), fields.fileName).toEqual(pick(real.plan));
      expect(real.dryRun, fields.fileName).toBeUndefined();
      state.intakes = [];
      state.writes = [];
    }
  });

  it("existing rows are never touched: a review row, an assigned row and a routed row all stay byte-identical", async () => {
    state.intakes = [
      { id: "pi_review", shop: "shop-1", fileHashSha256: HASH("1"), originalFilename: "loose.pdf", status: "review", reviewReason: "manual_review", rawParsedHints: JSON.stringify({ audit: [] }), matchedProductionJobId: null, authoritativeTicket: null, printer: null, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1 },
      { id: "pi_assigned", shop: "shop-1", fileHashSha256: HASH("2"), originalFilename: "assigned.pdf", status: "assigned", reviewReason: null, rawParsedHints: JSON.stringify({ assignedItemId: "item_1" }), matchedProductionJobId: "job_3", authoritativeTicket: "GSO-20261118-0003-01", printer: null, routedFilename: null, revisionNumber: 1, reprintNumber: 0, attemptNumber: 1 },
      { id: "pi_routed", shop: "shop-1", fileHashSha256: HASH("3"), originalFilename: "GSO-20261118-0003-01 done.pdf", status: "routed", reviewReason: null, rawParsedHints: null, matchedProductionJobId: "job_3", authoritativeTicket: "GSO-20261118-0003-01", printer: "mimaki", routedFilename: "GSO-20261118-0003-01_JAR", revisionNumber: 1, reprintNumber: 0, attemptNumber: 1 },
    ];
    const before = snapshot();
    expect((await call({ fileName: "loose.pdf", fileHash: HASH("1"), dryRun: true })).body.plan.decision).toBe("review");
    const assigned = (await call({ fileName: "assigned.pdf", fileHash: HASH("2"), dryRun: true })).body;
    expect(assigned.plan).toMatchObject({ decision: "route", rule: "assigned_by_owner", machine: "mimaki" });
    expect(assigned.suppressedWrites).toEqual(["printIntake.update"]);
    expect((await call({ fileName: "GSO-20261118-0003-01 done.pdf", fileHash: HASH("3"), dryRun: true })).body.plan.decision).toBe("route");
    expect(state.writes).toEqual([]);
    expect(snapshot()).toBe(before);
    expect(state.intakes[1].status).toBe("assigned"); // a dry run does not consume the assignment
  });

  it("no ProductionJob, ProductionJobFile, event, assignment or route report can come from a dry-run plan", async () => {
    for (const [index, fields] of [{ fileName: "a.pdf" }, { fileName: "GSO-20261118-0003-01 b.pdf" }, { fileName: "c_cmyk.pdf", subfolder: "GSO-20261118-0003", folderFiles: ["c_g.pdf"] }].entries()) {
      await call({ ...fields, fileHash: HASH(String(index)), dryRun: true });
    }
    expect(state.writes).toEqual([]);
    expect(state.intakes).toEqual([]);
    expect(state.files).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.jobs).toHaveLength(1);
    const route = src("app/routes/api.print-intake.route-plan.tsx");
    expect(route).toContain("const dryRun = body.dryRun === true;");
    expect(route).toContain("const db = readOnly ? readOnly.client : liveDb;");
    // the live client appears only in the import, as the facade's argument and as the non-dry-run fallback — nothing else can bypass the facade
    expect((route.match(/\bliveDb\b/g) || []).length).toBe(3);
    expect(route).not.toMatch(/\bliveDb\.(printIntake|productionJob|productionJobFile|productionJobEvent|\$transaction)/);
  });

  it("only the JSON boolean true is a dry run — anything else is a normal plan and says nothing about dryRun", async () => {
    for (const value of ["true", 1, "yes", null]) {
      state.intakes = [];
      state.writes = [];
      const { body } = await call({ fileName: "loose.pdf", fileHash: HASH("a"), dryRun: value });
      expect(body.dryRun, String(value)).toBeUndefined();
      expect(state.writes, String(value)).toEqual(["printIntake.create"]);
    }
  });

  it("the token is still checked in a dry run", async () => {
    expect((await call({ token: "wrong", fileName: "a.pdf", dryRun: true })).status).toBe(403);
    const noToken = await routePlan({ request: new Request("https://app.test/x", { method: "POST", body: JSON.stringify({ fileName: "a.pdf", dryRun: true }) }) });
    expect(noToken.status).toBe(401);
    expect(state.writes).toEqual([]);
    expect(await (routePlanInfo() as Response).text()).toContain("dryRun: true writes nothing");
    void db;
  });
});

describe("3. the agent's -DryRun is read-only end to end", () => {
  const agent = src("tools/gso-print-intake-agent.ps1");
  const dryBlock = agent.slice(agent.indexOf("    if ($DryRun) {\n      # Patch A: the SERVER must confirm"), agent.indexOf("    $plan = $planResult.json.plan\n    if ($plan.decision -eq \"route\") {\n      $hot = Get-HotFolderFor"));
  it("sends dryRun to the server and stops unless the server confirms dryRun=true and wrote=false", () => {
    expect(agent).toContain("gso-print-intake-agent/1.10");
    expect(agent).toContain("folderFiles = @($FolderFiles); dryRun = $IsDryRun } 60");
    expect(agent).toContain("$planResult = Get-RoutePlan $Config $File.Name $subfolder $hash $File.Length $folderFiles ([bool]$DryRun)");
    expect(agent).toContain("return ($null -ne $Json) -and ($Json.ok -eq $true) -and ($Json.dryRun -eq $true) -and ($Json.wrote -eq $false)");
    expect(dryBlock).toContain("if (-not (Test-DryRunHonoured $planResult.json)) {");
    expect(dryBlock).toContain('throw "fatal_dry_run"');
    expect(agent).toContain('if ($_.Exception.Message -eq "fatal_dry_run") { Write-Host "DRY RUN STOPPED - the server did not confirm a read-only plan."; exit 5 }');
  });
  it("in a dry run there is no claim, no copy, no move, no report, no ledger write and no status call", () => {
    expect(dryBlock.length).toBeGreaterThan(200);
    for (const forbidden of ["Send-IntakeReport", "Copy-Item", "Move-Item", "Add-IntakeLedgerEntry", "New-IntakeClaim", "Get-IntakeDisposition"]) expect(dryBlock, forbidden).not.toContain(forbidden);
    expect(dryBlock.trimEnd().endsWith("return\n    }")).toBe(true); // the dry-run branch returns before any routing code
    expect(agent).toContain("  if (-not $DryRun) {\n    if (!(New-IntakeClaim $File.FullName $Config.ClaimStaleMinutes)) {"); // claims only outside a dry run
    expect(agent).toContain("  if (-not $DryRun) {\n    $pendingResult = Invoke-IntakeJsonPost $config $config.StatusUrl"); // no pending-retries call in a dry run
    expect(agent).toContain("disposition reconciliation skipped in dry run");
  });
  it("it still prints what WOULD happen", () => {
    expect(agent).toContain('("WOULD MATCH: " + $ticket + " (by " + [string]$Plan.rule + ")")');
    expect(agent).toContain('("WOULD ROUTE: " + ([string]$Plan.machine).ToUpperInvariant() + " as " + [string]$Plan.ripName');
    expect(agent).toContain('return @(("WOULD REVIEW: " + $label + " (" + $reasons + ")"))');
    expect(agent).toContain('$label = "NEEDS REVIEW - LINK TO JOB"');
  });
});

describe("4. flood cap and mandatory cutoff", () => {
  const agent = src("tools/gso-print-intake-agent.ps1");
  it("more than 60 eligible files in one scan processes NONE and exits", () => {
    expect(agent).toContain("$HardFloodCap = 60");
    expect(agent).toContain("return ($Count -le $Cap)");
    expect(agent).toContain("return [Math]::Min($value, $HardFloodCap)"); // config can lower it, never raise it
    const capIndex = agent.indexOf("if (-not (Test-EligibleCountWithinCap $files.Count $config.MaxEligibleFilesPerScan)) {\n    Write-IntakeLog $config \"safety_stop\"");
    const loopIndex = agent.indexOf("  foreach ($file in $files) {\n    Write-IntakeLog $config \"detected\"");
    expect(capIndex).toBeGreaterThan(-1);
    expect(capIndex).toBeLessThan(loopIndex); // checked before the first file is touched
    const capBlock = agent.slice(capIndex, loopIndex);
    expect(capBlock).toContain("SAFETY STOP - TOO MANY ELIGIBLE FILES");
    expect(capBlock).toContain("Processed NONE");
    expect(capBlock).toContain("exit 3");
    expect(capBlock).not.toContain("Select-Object -First"); // never "the first 60"
    expect(agent).toContain('Assert "flood cap: 60 or fewer may proceed"');
    expect(agent).toContain('Assert "flood cap: 61 or more processes none"');
    expect(agent).toContain('Assert "a real scan above the cap is refused as a whole (67 eligible > 60)"');
  });
  it("no cutoff = the agent refuses to start processing", () => {
    const refuse = agent.indexOf("if ($null -eq $config.CutoffUtc) {\n  Write-IntakeLog $config \"refused_no_cutoff\"");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(agent.indexOf("while ($true) {"));
    expect(agent.slice(refuse, refuse + 400)).toContain("exit 4");
    expect(agent).toContain("REFUSED TO START - NO GO-LIVE CUTOFF");
  });
  it("historical files stay excluded and the scan stays root + one level", () => {
    expect(agent).toContain("return ($LastWriteTimeUtc -gt $CutoffUtc)");
    expect(agent).toContain("if (-not (Test-FileEligibleByCutoff $file.LastWriteTimeUtc $Config.CutoffUtc)) { $ignoredHistorical++; continue }");
    expect(agent).toContain("$all = @(Get-ChildItem -LiteralPath $Config.PrintsForTodayFolder -File -ErrorAction SilentlyContinue)");
    expect(agent).toContain("$all += @(Get-ChildItem -LiteralPath $jobFolder.FullName -File -ErrorAction SilentlyContinue)");
    const scan = agent.slice(agent.indexOf("function Test-TicketJobFolderName"), agent.indexOf("# ---------- routing helpers"));
    expect(scan).not.toContain("-Recurse");
    const example = JSON.parse(src("tools/gso-print-intake-agent-config.example.json"));
    expect(example.MaxEligibleFilesPerScan).toBe(60);
    expect(example.MimakiRoutingEnabled).toBe(false); // the example still ships with routing off
    expect(example.RolandRoutingEnabled).toBe(false);
  });
});
