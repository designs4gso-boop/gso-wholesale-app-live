// 2026-11-20 — Mimaki result sync v1.4 (activation + ticket pre-filter + outage-safe loop),
// the Print Intake health watchdog, the two registration scripts, and upload-token rotation.
//
// What runs here:
//   * the REAL owner-only rotate action (app/routes/app.erp.print-log-settings.tsx) and the
//     REAL token endpoints, against a small in-memory database;
//   * the REAL upload route for an un-ticketed result (the server stores it unmatched);
//   * on Windows, the REAL PowerShell scripts: their offline -SelfTest, and the sync script
//     end to end against temp folders and a stub HTTP server on 127.0.0.1 (no NAS, no ERP,
//     no scheduled task, nothing beside the repository scripts is written);
//   * source pins for what cannot be executed safely (task registration, the watchdog's
//     Stop/Start of the live task, the token helper).
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sub: "1", t: {} as Record<string, any[]>, seq: 0, clock: Date.parse("2026-11-20T18:00:00Z"), writes: [] as string[] }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "shop-1", isOnline: false }, sessionToken: { sub: h.sub }, admin: {} }) },
}));

// In-memory database: equality (Date-aware, undefined == null), in / not / startsWith /
// contains, OR / NOT, orderBy, take, upsert. Every write is recorded in h.writes.
vi.mock("../app/db.server", () => {
  const eq = (a: any, b: any) => (a instanceof Date || b instanceof Date ? (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null) : (a ?? null) === (b ?? null));
  const rows = (name: string) => (h.t[name] = h.t[name] || []);
  const match = (row: any, where: any = {}): boolean => Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return (value as any[]).some((part) => match(row, part));
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part) => match(row, part));
    if (key === "NOT") return !match(row, value);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.keys(value).every((op) => {
        if (op === "in") return value.in.includes(row[key]);
        if (op === "not") return !eq(row[key], value.not);
        if (op === "startsWith") return String(row[key] ?? "").startsWith(String(value.startsWith));
        if (op === "contains") return String(row[key] ?? "").includes(String(value.contains));
        return true;
      });
    }
    return eq(row[key], value);
  });
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any = {}) => {
      const list = rows(name);
      const create = (data: any) => {
        const clean = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
        const row: any = { id: `${name}_${++h.seq}`, createdAt: new Date((h.clock += 1000)), updatedAt: new Date(h.clock), ...clean };
        list.push(row);
        h.writes.push(`${name}.create`);
        return { ...row };
      };
      if (method === "findFirst" || method === "findUnique") { const found = list.filter((row) => match(row, args.where))[0]; return found ? { ...found } : null; }
      if (method === "findMany") { const found = list.filter((row) => match(row, args.where)); return (args.take ? found.slice(0, args.take) : found).map((row) => ({ ...row })); }
      if (method === "count") return list.filter((row) => match(row, args.where)).length;
      if (method === "create") return create(args.data);
      if (method === "update" || method === "updateMany") {
        const found = list.filter((row) => match(row, args.where));
        found.forEach((row) => Object.assign(row, args.data, { updatedAt: new Date((h.clock += 1000)) }));
        if (found.length) h.writes.push(`${name}.${method}`);
        return method === "update" ? { ...found[0] } : { count: found.length };
      }
      if (method === "upsert") {
        const found = list.find((row) => match(row, args.where));
        if (!found) return create(args.create);
        Object.assign(found, args.update, { updatedAt: new Date((h.clock += 1000)) });
        h.writes.push(`${name}.update`);
        return { ...found };
      }
      return null;
    },
  });
  const db: any = new Proxy({}, { get: (_t, key: string) => (key === "$transaction" ? async (fn: any) => (typeof fn === "function" ? fn(db) : Promise.all(fn)) : key === "$queryRawUnsafe" ? async () => [] : model(key)) });
  return { default: db, db };
});

import { RIP_ITEM_TICKET_RE, parseRipTickets } from "../app/lib/rip-identity-match.server";
import { action as settingsAction, loader as settingsLoader } from "../app/routes/app.erp.print-log-settings";
import { action as reportAction } from "../app/routes/api.print-intake.report";
import { action as routePlanAction } from "../app/routes/api.print-intake.route-plan";
import { action as statusAction } from "../app/routes/api.print-intake.status";
import { action as printLogsAction } from "../app/routes/api.print-logs.upload";
import { action as quoteRipAction } from "../app/routes/api.quote-rip-results.sync";
import { action as ripUploadAction } from "../app/routes/api.rip-imports.upload";

const src = (path: string) => readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
const SHOP = "shop-1";
const OLD_TOKEN = `gso_plog_${"0f".repeat(24)}`;
const ENV = { GSO_OWNER_SHOPIFY_USER_IDS: "1", GSO_STAFF_ROLES: "2:manager,4:print_operator", GSO_MANAGER_AUTHORIZED_USER_IDS: "2" };
const setting = () => (h.t.printLogAutoImportSetting || [])[0];
const jsonRequest = (path: string, body: unknown) => new Request(`https://erp.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const settingsPost = (fields: Record<string, string>) => { const body = new FormData(); Object.entries(fields).forEach(([k, v]) => body.set(k, v)); return new Request("https://erp.test/app/erp/print-log-settings", { method: "POST", body }); };
const outcome = async (run: () => Promise<Response>): Promise<{ status: number; text: string }> => {
  try { const response = await run(); return { status: response.status, text: await response.text() }; }
  catch (thrown) { if (thrown instanceof Response) return { status: thrown.status, text: await thrown.text() }; throw thrown; }
};

// Every token endpoint, called with the smallest body that reaches the token check.
const TOKEN_ENDPOINTS: Array<{ name: string; call: (token: string) => Promise<Response> }> = [
  { name: "api.print-intake.route-plan", call: (token) => routePlanAction({ request: jsonRequest("/api/print-intake/route-plan", { token }) }) },
  { name: "api.print-intake.report", call: (token) => reportAction({ request: jsonRequest("/api/print-intake/report", { token }) }) },
  { name: "api.print-intake.status", call: (token) => statusAction({ request: jsonRequest("/api/print-intake/status", { token, pending: true }) }) },
  { name: "api.rip-imports.upload", call: (token) => { const form = new FormData(); if (token) form.set("token", token); form.set("source", "rasterlink"); return ripUploadAction({ request: new Request("https://erp.test/api/rip-imports/upload", { method: "POST", body: form }) }); } },
  { name: "api.print-logs.upload", call: (token) => printLogsAction({ request: jsonRequest("/api/print-logs/upload", { token }) }) },
  { name: "api.quote-rip-results.sync", call: (token) => quoteRipAction({ request: jsonRequest("/api/quote-rip-results/sync", { token, rows: [] }) }) },
];

beforeEach(() => {
  h.t = { printLogAutoImportSetting: [{ id: "setting_1", shop: SHOP, enabled: true, uploadToken: OLD_TOKEN }] };
  h.seq = 0; h.writes = []; h.sub = "1";
  Object.assign(process.env, ENV);
  delete process.env.GSO_OWNER_ENFORCEMENT;
});

/* ====================================================================== */
/* FIX 11 — token rotation, through the real action and the real endpoints */
/* ====================================================================== */

describe("FIX 11 · upload-token rotation — real action, real endpoints, in-memory database", () => {
  it("a non-owner is refused: an authorized manager, a print operator and an unknown user all get 403 and nothing changes", async () => {
    for (const sub of ["2", "4", "9"]) {
      h.sub = sub; h.writes = [];
      const refused = await outcome(() => settingsAction({ request: settingsPost({ intent: "rotateToken" }) }) as Promise<Response>);
      expect(refused.status, `staff ${sub}`).toBe(403);
      expect(refused.text, `staff ${sub}`).not.toContain("gso_plog_");
      expect(setting().uploadToken, `staff ${sub}`).toBe(OLD_TOKEN);
      expect(h.writes, `staff ${sub}`).toEqual([]);
    }
    // the manager CAN open the page (loader) — and still never receives the token
    h.sub = "2";
    const page = await outcome(() => settingsLoader({ request: new Request("https://erp.test/app/erp/print-log-settings") }) as Promise<Response>);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(OLD_TOKEN);
  });

  it("the owner rotates: a new strong token is returned ONCE, the stored token changes, and it appears nowhere else in the answer", async () => {
    const response = await settingsAction({ request: settingsPost({ intent: "rotateToken" }) }) as Response;
    expect(response.status).toBe(200);
    const body = await response.json();
    const fresh = body.rotatedTokenOnce as string;
    expect(body.ok).toBe(true);
    expect(fresh).toMatch(/^gso_plog_[0-9a-f]{48}$/); // 24 random bytes = 192 bits
    expect(fresh).not.toBe(OLD_TOKEN);
    expect(setting().uploadToken).toBe(fresh);
    expect(h.t.printLogAutoImportSetting).toHaveLength(1); // rotated in place, no second credential
    // beyond the one-time field the answer holds neither token
    const { rotatedTokenOnce: _once, ...rest } = body;
    expect(JSON.stringify(rest)).not.toContain(fresh);
    expect(JSON.stringify(rest)).not.toContain(OLD_TOKEN);
    expect(Object.keys(body).sort()).toEqual(["message", "ok", "rotatedTokenOnce"]);
    // it is never shown again: the page loader only carries a masked status
    const page = await (await settingsLoader({ request: new Request("https://erp.test/app/erp/print-log-settings") }) as Response).text();
    expect(page).not.toContain(fresh);
    expect(page).not.toContain(OLD_TOKEN);
  });

  it("every rotation gives a different token (crypto randomBytes, not a counter or a clock)", async () => {
    const seen = new Set<string>([OLD_TOKEN]);
    for (let i = 0; i < 25; i += 1) {
      const body = await (await settingsAction({ request: settingsPost({ intent: "rotateToken" }) }) as Response).json();
      expect(seen.has(body.rotatedTokenOnce)).toBe(false);
      seen.add(body.rotatedTokenOnce);
    }
    const route = src("app/routes/app.erp.print-log-settings.tsx");
    expect(route).toContain('import { randomBytes } from "crypto";');
    expect(route).toContain("return `gso_plog_${randomBytes(24).toString(\"hex\")}`;");
    expect(route).not.toMatch(/Math\.random|Date\.now\(\)\.toString/);
  });

  it("before rotation the old token is accepted by every token endpoint; a missing token is 401; a wrong one is 401/403", async () => {
    for (const endpoint of TOKEN_ENDPOINTS) {
      const accepted = await outcome(() => endpoint.call(OLD_TOKEN));
      expect([401, 403], `${endpoint.name} accepted`).not.toContain(accepted.status);
      expect((await outcome(() => endpoint.call(""))).status, `${endpoint.name} missing`).toBe(401);
      expect([401, 403], `${endpoint.name} wrong`).toContain((await outcome(() => endpoint.call("gso_plog_wrong"))).status);
    }
  });

  it("after rotation the OLD token is rejected at once by every token endpoint and the NEW one is accepted", async () => {
    const fresh = (await (await settingsAction({ request: settingsPost({ intent: "rotateToken" }) }) as Response).json()).rotatedTokenOnce as string;
    h.writes = [];
    for (const endpoint of TOKEN_ENDPOINTS) {
      const old = await outcome(() => endpoint.call(OLD_TOKEN));
      expect([401, 403], `${endpoint.name} old token`).toContain(old.status);
      expect(old.text, endpoint.name).toMatch(/upload token/i);
      expect(old.text, endpoint.name).not.toContain(OLD_TOKEN);
    }
    expect(h.writes).toEqual([]); // a rejected token writes nothing, anywhere
    for (const endpoint of TOKEN_ENDPOINTS) {
      const now = await outcome(() => endpoint.call(fresh));
      expect([401, 403], `${endpoint.name} new token`).not.toContain(now.status);
      expect(now.text, endpoint.name).not.toMatch(/Invalid or disabled upload token|Missing upload token/);
      expect(now.text, endpoint.name).not.toContain(fresh); // no endpoint echoes the token back
    }
  });

  it("a disabled setting rejects even the right token", async () => {
    setting().enabled = false;
    for (const endpoint of TOKEN_ENDPOINTS) expect([401, 403], endpoint.name).toContain((await outcome(() => endpoint.call(OLD_TOKEN))).status);
  });

  it("neither token is ever written to a log: no console call during rotation or any endpoint call carries one", async () => {
    const calls: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { calls.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")); }));
    try {
      const fresh = (await (await settingsAction({ request: settingsPost({ intent: "rotateToken" }) }) as Response).json()).rotatedTokenOnce as string;
      for (const endpoint of TOKEN_ENDPOINTS) { await outcome(() => endpoint.call(OLD_TOKEN)); await outcome(() => endpoint.call(fresh)); }
      h.sub = "4";
      await outcome(() => settingsAction({ request: settingsPost({ intent: "rotateToken" }) }) as Promise<Response>);
      const logged = calls.join("\n");
      expect(logged).not.toContain(fresh);
      expect(logged).not.toContain(OLD_TOKEN);
      expect(logged).not.toMatch(/gso_plog_[0-9a-f]{8}/);
    } finally { spies.forEach((spy) => spy.mockRestore()); }
    // and the action has no log statement at all
    const route = src("app/routes/app.erp.print-log-settings.tsx");
    const action = route.slice(route.indexOf("export async function action"), route.indexOf("export default function"));
    expect(action).not.toMatch(/console\.|logger\./);
    expect(action.indexOf("requireOwner(auth);")).toBeGreaterThan(0);
    expect(action.indexOf("requireOwner(auth);")).toBeLessThan(action.indexOf("request.formData()")); // refused before anything is read
  });

  it("SOURCE PIN: the local helper asks with hidden input, writes only the two runtime configs, never prints a token", () => {
    const helper = src("tools/rotate-print-intake-token.ps1");
    expect(helper).toContain('Read-Host -AsSecureString "New upload token"');
    expect(helper).toContain('"C:\\GSO-Print-Intake-Agent\\gso-print-intake-agent-config.json"');
    expect(helper).toContain('"C:\\GSO-RIP-Result-Sync\\gso-mimaki-result-sync-config.json"');
    expect(helper).toContain('if (-not (Test-IsRuntimeConfig $path)) { Write-Host ("REFUSED (not one of the two runtime configs): " + $path); continue }');
    expect(helper).toContain("[CmdletBinding(SupportsShouldProcess = $true)]");
    expect(helper).toContain('".before-token-rotation-" + $stamp + ".json"'); // timestamped backup first
    expect(helper.indexOf("Copy-Item -LiteralPath $path -Destination $backup")).toBeLessThan(helper.indexOf("[System.IO.File]::WriteAllText($path, $newText"));
    expect(helper).toContain('if ($after.state -ne "ok") { throw "the file did not read back as a config with one UploadToken" }'); // JSON validated after writing
    // nothing printed about a token but its length
    expect(helper).not.toMatch(/Write-(Host|Output)[^\n]*\$(first|second|newToken)\b(?!\.Length)/);
    expect(helper).not.toMatch(/Write-(Host|Output)[^\n]*\.current\b(?!\.Length)/);
    expect(helper).not.toMatch(/Add-Content|Out-File|Start-Transcript/); // no log file at all
    // the restart is opt-in, acts on the EXISTING task only, and never launches the watcher script
    const restart = helper.slice(helper.indexOf("if ($RestartWatcher) {\n  # Only the EXISTING"), helper.indexOf('Write-Host "VERIFY'));
    expect(restart).toContain("Stop-ScheduledTask -TaskName $WatcherTaskName -ErrorAction Stop");
    expect(restart).toContain("Start-ScheduledTask -TaskName $WatcherTaskName -ErrorAction Stop");
    expect(restart).toContain('if ($seen -contains "agent_started" -and $state -eq "Running")'); // waits for a fresh log line
    const outsideRestart = helper.replace(restart, "");
    expect(outsideRestart).not.toMatch(/^\s*(Stop|Start)-ScheduledTask /m);
    expect(helper).not.toMatch(/Stop-Process|Start-Process|Register-ScheduledTask|gso-print-intake-agent\.ps1"? -Loop/);
    // prints the exact verification steps
    expect(helper).toContain("the banner is GREEN");
    expect(helper).toContain("'old token -> HTTP ' + [int]`$_.Exception.Response.StatusCode");
  });
});

/* ====================================================================== */
/* FIX 6-8 — the server side: dedupe, and what happens to an un-ticketed row */
/* ====================================================================== */

const PRINT_HEAD = "KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_RIP_S_TIME,KEY_RIP_E_TIME,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL";
const CUT_HEAD = "KEY_FILENAME,KEY_RESULT,KEY_VEC_S_TIME,KEY_VEC_E_TIME,KEY_CUT_S_TIME,KEY_CUT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL";
const printCsv = (names: string[], end: string) => [PRINT_HEAD, ...names.map((name) => `"${name}","OK",,"${end}","${end}",,,"0",`)].join("\r\n") + "\r\n";
const cutCsv = (names: string[], end: string) => [CUT_HEAD, ...names.map((name) => `"${name}","OK","${end}","${end}","${end}","${end}","65",`)].join("\r\n") + "\r\n";

async function upload(fileName: string, text: string, token = OLD_TOKEN) {
  const form = new FormData();
  form.set("token", token); form.set("source", "rasterlink");
  form.set("file", new File([text], fileName, { type: "text/csv" }));
  const response = await ripUploadAction({ request: new Request("https://erp.test/api/rip-imports/upload", { method: "POST", body: form }) });
  return { status: response.status, body: await response.json() };
}

describe("FIX 6-8 · the server defends itself: duplicates write nothing, an un-ticketed row is stored unmatched", () => {
  const CRUD_NAME = "20261120_115424_crud_POP TARTS STRAW APPLE_b_.pdf_1_OK_print.csv";
  const CRUD = printCsv(["crud_POP TARTS STRAW APPLE_b_.pdf", "crud_ALL_b_.pdf"], "20261120_090444");

  it("an un-ticketed result that DID reach the server is kept for review and attached to NO job", async () => {
    h.t.productionJob = [{ id: "job_1", shop: SHOP, jobTicket: "GSO-20261120-0007" }];
    h.t.productionJobItem = [{ id: "item_1", shop: SHOP, jobId: "job_1", itemTicket: "GSO-20261120-0007-01", ripJobName: "GSO-20261120-0007-01__MIMAKI__CMYK__F", suggestedFileName: null }];
    const first = await upload(CRUD_NAME, CRUD);
    expect(first.body).toMatchObject({ ok: true, created: 2, matched: 0, unmatched: 2 });
    for (const entry of h.t.printLogEntry) {
      expect(entry.productionJobId ?? null).toBeNull();
      expect(entry.productionJobItemId ?? null).toBeNull();
    }
    // so the sync's pre-filter is the first line of defence, not the only one
  });

  it("the same result uploaded twice is answered duplicateFile and writes nothing (what makes every retry safe)", async () => {
    await upload(CRUD_NAME, CRUD);
    const rowsBefore = h.t.printLogEntry.length;
    h.writes = [];
    const again = await upload(CRUD_NAME, CRUD);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, duplicateFile: true });
    expect(h.writes).toEqual([]);
    expect(h.t.printLogEntry).toHaveLength(rowsBefore);
  });

  it("SOURCE PIN: file-level and row-level dedupe in the upload route (cited in the enablement doc)", () => {
    const lines = src("app/routes/api.rip-imports.upload.tsx").split("\n");
    expect(lines[212]).toContain("const marker = fileHashMarker(rawText);"); // :213
    expect(lines[216]).toContain("const duplicateFile = await db.printLogImport.findFirst({"); // :217
    expect(lines[217]).toContain('status: "processed", notes: { startsWith: marker }'); // :218
    expect(lines[220]).toContain("duplicateFile: true"); // :221
    expect(lines[251]).toContain("const existing = await db.printLogEntry.findFirst({ where: rowDedupeWhere(setting.shop, entry, importRecord.id) as any });"); // :252
    expect(lines[252]).toContain("if (existing) { skippedDuplicates += 1; continue; }"); // :253
  });

  it("the sync's item-ticket pattern is the server's own (hyphens only, any case) — underscores are NOT a ticket for either", () => {
    const sync = src("tools/gso-rasterlink-sync.ps1");
    expect(sync).toContain(`$ItemTicketPattern = '${RIP_ITEM_TICKET_RE.source}'`);
    expect(RIP_ITEM_TICKET_RE.flags).toContain("i");
    expect(sync).toContain("foreach ($m in [regex]::Matches([string]$Text, $ItemTicketPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {");
    expect(parseRipTickets("gso-20261120-0007-01__MIMAKI__CMYK__F.pdf").itemTicket).toBe("GSO-20261120-0007-01");
    expect(parseRipTickets("GSO_20261120_0007_01.pdf").itemTicket).toBeNull();
    expect(parseRipTickets("crud_POP TARTS STRAW APPLE_b_.pdf")).toMatchObject({ itemTicket: null, jobTicket: null });
  });
});

/* ====================================================================== */
/* FIX 6-8 — source pins for the sync script                                */
/* ====================================================================== */

describe("FIX 6-8 · gso-rasterlink-sync.ps1 v1.4 — source pins", () => {
  const sync = src("tools/gso-rasterlink-sync.ps1");

  it("the version is bumped and the exit codes are documented", () => {
    expect(sync).toContain('$ScriptVersion = "gso-rasterlink-sync/1.4 (');
    expect(sync).toContain("# Exit codes: 0 finished | 1 config could not be loaded / unsafe incoming folder");
    expect(sync).toContain("# 4 no activation timestamp (nothing is processed) | 6 another poll loop for the");
  });

  it("FIX 6: logging retries, falls back to a local file, and never throws", () => {
    const log = sync.slice(sync.indexOf("function Write-SyncLog("), sync.indexOf("# One line in the LOCAL log only"));
    expect(log.trimStart().split("\n")[1].trim()).toBe("try {"); // the whole body is guarded
    expect(log).toContain("try { Write-Host $line } catch { }");
    expect(log).toContain("for ($logTry = 1; $logTry -le 3; $logTry++) {");
    expect(log).toContain("[void](Write-SyncLocalLine $line)");
    expect(log.trimEnd().endsWith("} catch { }\n}")).toBe(true);
    // beside the script first, then a per-user folder when that is not writable
    expect(sync).toContain('$script:LocalLogFolders = @($PSScriptRoot, $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "GSO-RIP-Result-Sync" } else { "" }), $env:TEMP)');
    // no unguarded Add-Content / Write-Host in the loop path
    const main = sync.slice(sync.indexOf("# ---------- main ----------"));
    expect(main).not.toMatch(/^\s*Write-Host /m);
    expect(main).not.toContain("Add-Content");
    expect(main).not.toMatch(/\bthrow\b/);
  });

  it("FIX 6: a pass-level guard — nothing thrown in a pass ends the loop; one failed result does not stop the next", () => {
    const guard = sync.slice(sync.indexOf("function Invoke-GuardedPass("), sync.indexOf("# Which activation applies"));
    expect(guard).toContain("$pass = Invoke-SyncPass $config $ActivationInstant $IsDryRun $Only");
    expect(guard).toContain('Write-SyncLog $config "pass_error" "-" "PASS FAILED state=ERROR unexpected: $passError; nothing was moved; retrying next pass"');
    expect(guard).toContain('return @{ status = "pass_error"; summary = "" }');
    const loop = sync.slice(sync.indexOf("while ($true) {\n  $guarded = Invoke-GuardedPass"));
    expect(loop).toContain("$guarded = Invoke-GuardedPass $config $activationInstant ([bool]$DryRun) $OnlyFile ([bool]($Once -or $DryRun))");
    expect(loop).toContain("try { Start-Sleep -Seconds $config.PollSeconds } catch { }");
    const pass = sync.slice(sync.indexOf("function Invoke-SyncPass("), sync.indexOf("# The pass guard"));
    expect(pass).toContain("# One failed result never stops the results after it.");
    expect(pass).toContain('Write-SyncLog $config "file_error" $file.Name "unexpected: $($_.Exception.Message); file left in place; retried next pass"');
    // an unreachable folder is an error state, not "nothing to do"
    expect(pass).toContain('if (!(Test-Path -LiteralPath $config.IncomingFolder)) { throw "incoming_unavailable:');
  });

  it("FIX 6: the deliberate fatal exit stays fatal and is logged — the ERP's own token answer only", () => {
    expect(sync).toContain('if ($guarded.status -eq "fatal_token") {');
    expect(sync).toMatch(/Write-SyncLog \$config "watcher_stopped" "-" "the ERP rejected the upload token[^\n]*\n\s+exit 2/);
    expect(sync).toContain("return ($null -ne $Result.json) -and ($Result.json.ok -eq $false) -and ([string]$Result.json.error -match 'upload token')");
  });

  it("FIX 6: a result leaves its folder only after the server answered — an outage never moves it to the error folder", () => {
    const perFile = sync.slice(sync.indexOf("function Invoke-ProcessFile("), sync.indexOf("# ---------- one pass ----------"));
    // the only move to the error folder is behind a terminal 4xx answer
    expect(perFile.match(/Move-ToFolder \$Config \$File \$Config\.ErrorFolder/g)).toHaveLength(1);
    expect(perFile).toContain('if (Test-TerminalClientError $result) {\n        $sidecar = Write-ErrorSidecar $Config $File $attempt $result.status $result.body $null\n        if (-not $inErrorFolder) { Move-ToFolder $Config $File $Config.ErrorFolder "moved_to_error" | Out-Null }');
    // the only move to processed is behind an accepted answer
    expect(perFile.match(/Move-ToFolder \$Config \$File \$Config\.ProcessedFolder/g)).toHaveLength(1);
    expect(perFile.indexOf("if (Test-UploadAccepted $result) {")).toBeLessThan(perFile.indexOf('Move-ToFolder $Config $File $Config.ProcessedFolder "moved_to_processed"'));
    expect(perFile).toContain('return "retry_later"');
    expect(perFile).not.toContain("retries_exhausted");
    expect(sync).toContain("if ($Result.status -eq 401 -or $Result.status -eq 403 -or $Result.status -eq 408 -or $Result.status -eq 429) { return $false }");
    // results an older version stranded during an outage are retried from the error folder
    expect(sync).toContain("return ($status -eq 0 -or $status -ge 500 -or $status -eq 408 -or $status -eq 429)");
    expect(sync).toContain("$stranded = @(Get-RetryableErrorFiles $config | ForEach-Object { $_ })");
  });

  it("FIX 6: a visible error state — one pass_summary line with every counter and state=ERROR", () => {
    for (const counter of ["scanned", "eligible", "uploaded", "would_upload", "ignored_before_cutoff", "ignored_before_activation", "ignored_no_ticket", "ignored_ambiguous", "ignored_unsupported_format", "not_selected", "waiting", "retry_later", "rejected", "failed", "jobinfo_failed", "log_fallback"]) {
      expect(sync, counter).toMatch(new RegExp(`\\b${counter} = 0`));
    }
    expect(sync).toContain('$ErrorCounterNames = @("retry_later", "rejected", "failed", "jobinfo_failed", "log_fallback")');
    expect(sync).toContain('[void]$parts.Add($(if ($errors -gt 0) { "state=ERROR" } else { "state=ok" }))');
    expect(sync).toContain('Write-SyncLog $config "pass_summary" "-" $summary');
  });

  it("FIX 7: no activation timestamp = nothing is processed (exit 4); -ActivationUtc only for a one-shot run", () => {
    expect(sync).toContain("$activationChoice = Resolve-SyncActivation $config.ActivationInstant $ActivationUtc ([bool]($Once -or $DryRun))");
    expect(sync).toMatch(/if \(\$null -eq \$activationChoice\.instant\) \{\n\s+Write-SyncLog \$config "refused_no_activation"[^\n]*\n[^\n]*REFUSED TO START - NO ACTIVATION TIMESTAMP[^\n]*\n\s+exit 4\n\}/);
    expect(sync).toContain('if (-not $IsOneShot) { return @{ instant = $null; source = "refused";');
    expect(sync).toContain('$config.ActivationInstant = ConvertTo-SyncUtcInstant $config.ActivationUtc "ActivationUtc"'); // unreadable = config error, never "none"
    // the refusal comes before the loop and before any scan
    expect(sync.indexOf("exit 4")).toBeLessThan(sync.indexOf("while ($true) {\n  $guarded"));
  });

  it("FIX 7: a result is post-activation only when EVERY readable time is — write time, name stamp, latest end time inside", () => {
    const verdict = sync.slice(sync.indexOf("function Get-ResultEligibility("), sync.indexOf("# Results an OLDER version"));
    expect(verdict).toContain('if ($File.LastWriteTimeUtc -lt $ActivationInstant) { $verdict.reason = "ignored_before_activation"');
    expect(verdict).toContain('if ($null -ne $nameStamp -and $nameStamp -lt $ActivationInstant) { $verdict.reason = "ignored_before_activation"');
    expect(verdict).toContain("if ($null -ne $content.latestEndUtc -and $content.latestEndUtc -lt $ActivationInstant) {");
    expect(verdict).toContain('if ($null -eq $ActivationInstant) { $verdict.reason = "ignored_before_activation"');
    // the verdict function reads only
    expect(verdict).not.toMatch(/Move-Item|Remove-Item|Set-Content|Add-Content|Invoke-RipUpload|New-FileClaim/);
  });

  it("FIX 8: ineligible results are counted, listed once, and never reach the upload or a move", () => {
    const pass = sync.slice(sync.indexOf("function Invoke-SyncPass("), sync.indexOf("# The pass guard"));
    const skip = pass.indexOf("if (-not $verdict.eligible) {");
    const process = pass.indexOf("$outcome = Invoke-ProcessFile $config $file");
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(process);
    expect(pass.slice(skip, process)).toContain("continue\n      }\n      if ($Only.Count -gt 0 -and $Only -notcontains $file.Name) { $counters.not_selected++; continue }");
    expect(pass).toContain("if (-not $script:ListedIgnored.ContainsKey($listKey)) {");
    expect(pass).toContain('Write-SyncLog $config $verdict.reason $file.Name "NOT uploaded, left in place: $($verdict.detail). Review by hand."');
    // dry run: lists, uploads nothing
    const dry = pass.slice(pass.indexOf("if ($IsDryRun) {\n        $stable"), process);
    expect(dry).toContain('"WOULD UPLOAD  "');
    expect(dry).toContain("continue");
    expect(pass.indexOf('"WOULD UPLOAD  "')).toBeLessThan(process);
  });

  it("FIX 8: the JobInfo.ini (jobFolder) flow is unchanged for an eligible result, and a lost answer is retried", () => {
    expect(sync).toContain('$extra.Add("jobFolder", $folder.JobId)');
    expect(sync).toContain('$result = Invoke-RipUpload $Config $folder.IniPath "JobInfo.ini" $extra');
    expect(sync).toContain("try { Invoke-JobInfoCompanions $Config $File } catch {");
    expect(sync).toContain("if ($transient) { $script:JobInfoTransient = $true }");
    const companion = sync.slice(sync.indexOf("# ---------- JobInfo.ini companion"), sync.indexOf("# ---------- moves + sidecars"));
    expect(companion).not.toMatch(/Set-Content|Add-Content|Move-Item|Remove-Item|Out-File|WriteAll/); // JobInfo.ini is only read
  });

  it("the token is never logged: the mask shows a length only, and a config error never quotes the file", () => {
    expect(sync).toContain('return "(set, $($Token.Length) chars)"');
    expect(sync).not.toMatch(/\$Token\.Substring/);
    expect(sync).not.toMatch(/Write-SyncLog[^\n]*UploadToken/);
    expect(sync).toContain('return "the config file could not be read as JSON ($TypeName)"');
    expect(sync).toContain('Write-SyncLocalLog "config_error" ("sync did not start: " + (Get-SyncConfigErrorText ([string]$_.Exception.Message) $_.Exception.GetType().Name))');
  });

  it("the example config carries the activation key, empty (an example never activates anything)", () => {
    const example = JSON.parse(src("tools/gso-rasterlink-sync-config.example.json"));
    expect(example.ActivationUtc).toBe("");
    expect(Object.keys(example)).toContain("NotBeforeUtc");
  });
});

/* ====================================================================== */
/* The registration script for the Mimaki sync                             */
/* ====================================================================== */

describe("FIX 7 · register-mimaki-result-sync-task.ps1 — source pins (never executed here)", () => {
  const reg = src("tools/register-mimaki-result-sync-task.ps1");

  it("one explicitly named task, from the stable runtime folder, never two instances, restart on failure", () => {
    expect(reg).toContain('$TaskName = "GSO Mimaki Result Sync"');
    expect(reg).toContain('$Runtime = "C:\\GSO-RIP-Result-Sync"');
    expect(reg).toContain("New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)");
    expect(reg).toContain("New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited");
    expect(reg.match(/Register-ScheduledTask /g)).toHaveLength(1);
    expect(reg).not.toMatch(/-Password|Get-Credential|-RunLevel Highest/);
  });

  it("-WhatIf, idempotent, and refuses when it may not register", () => {
    expect(reg).toContain("[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]");
    expect(reg).toContain("Already registered - '$TaskName' exists and runs this sync");
    expect(reg).toContain("the activation timestamp was not moved.");
    expect(reg).toContain("if (-not $isElevated -and -not $WhatIfPreference) {");
    expect(reg).toContain("Only one result sync may run. Disable that task first. Nothing was changed.");
    expect(reg).toContain('$MinimumSyncVersion = [version]"1.4"'); // an older sync would ignore the activation
    expect(reg).toContain("if ($null -eq $installedVersion -or $installedVersion -lt $MinimumSyncVersion) {");
    // every read-only check and the confirmation come before the first write
    const firstWrite = reg.indexOf("Copy-Item -LiteralPath $ConfigPath -Destination $backupPath");
    expect(reg.indexOf("$PSCmdlet.ShouldProcess(")).toBeLessThan(firstWrite);
    expect(reg.indexOf("PREVIEW ONLY - nothing was written, no task was registered.")).toBeLessThan(firstWrite);
  });

  it("activation = now, written at registration, BEFORE the task exists; only that key; the token is never touched or shown", () => {
    expect(reg).toContain('$activationIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")');
    expect(reg.indexOf("[System.IO.File]::WriteAllText($ConfigPath, $afterText")).toBeLessThan(reg.indexOf("Register-ScheduledTask -TaskName $TaskName"));
    expect(reg).toContain('if (-not (Test-OnlyActivationChanged $beforeText $afterText $activationIso)) { throw "the edited config would differ in more than ActivationUtc" }');
    expect(reg).toContain('Write-Host ("Upload token    : (set, " + ([string]$configJson.UploadToken).Length + " chars)")');
    expect(reg).not.toMatch(/Write-Host[^\n]*\.UploadToken\b(?!\)\.Length)/);
    expect(reg).not.toMatch(/"UploadToken"\\s\*:/); // no pattern that could rewrite the token
  });

  it("it does not start processing by itself, and prints verify / disable / rollback", () => {
    expect(reg).toContain("if ($StartNow) {\n  Start-ScheduledTask -TaskName $TaskName");
    expect(reg.match(/^\s*Start-ScheduledTask /gm)).toHaveLength(1);
    expect(reg).toContain('Write-Host "NOT started. Start it when you are ready:"');
    for (const heading of ["VERIFY (", "DISABLE (", "ROLL BACK ("]) expect(reg).toContain(`Write-Host "${heading}`);
    expect(reg).toContain('"Unregister-ScheduledTask -TaskName `"$TaskName`" -Confirm:`$false"');
    expect(reg).not.toMatch(/-OnlyFile|NotBeforeUtc\s*=/); // it never widens what is eligible
  });
});

/* ====================================================================== */
/* FIX 9 — watcher task script + health watchdog                           */
/* ====================================================================== */

describe("FIX 9 · register-print-intake-startup-task-ELEVATED.ps1 + print-intake-watchdog.ps1 — source pins", () => {
  const reg = src("tools/register-print-intake-startup-task-ELEVATED.ps1");
  const dog = src("tools/print-intake-watchdog.ps1");

  it("the register script never asks for, stores or prints a credential, and never converts the logon mode", () => {
    expect(reg).not.toMatch(/Get-Credential|GetNetworkCredential|-Password\b|\$plainPassword|ConvertTo-SecureString/);
    expect(reg).not.toMatch(/LogonType[^\n]*InnerText\s*=/); // the logon type node is never assigned
    expect(reg).toContain('if ($principalsAfter -cne $principalsBefore -or $actionsAfter -cne $actionsBefore) { throw "Internal check failed: the plan would change the task\'s user / logon type / action. Nothing was changed." }');
    const refuse = reg.slice(reg.indexOf("if ($RunWhetherLoggedOn) {"), reg.indexOf("$isElevated ="));
    expect(refuse).toContain("-RunWhetherLoggedOn is no longer supported and nothing was changed.");
    expect(refuse).toContain("exit 1");
    expect(reg.indexOf("if ($RunWhetherLoggedOn) {")).toBeLessThan(reg.indexOf("Get-ScheduledTask -TaskName $TaskName")); // refused before anything is read
    expect(reg).not.toMatch(/AutoAdminLogon|DefaultPassword|netplwiz|Winlogon/i); // no auto-sign-in change
  });

  it("-WhatIf, idempotent, stable runtime folder, no duplicate watcher, the watcher itself is never started or stopped", () => {
    expect(reg).toContain("[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]");
    expect(reg).toContain('[string]$InstallPath = "C:\\GSO-Print-Intake-Agent"');
    expect(reg).toContain('Write-Host "Already configured - nothing to change. No backup written."');
    expect(reg).toContain('Write-Host "There must be exactly one watcher task. Disable the other one first. Nothing was changed."');
    expect(reg).toContain("This script never registers a watcher task. Nothing was changed.");
    expect(reg).not.toMatch(/(Stop|Start)-ScheduledTask -TaskName \$TaskName/);
    // the old "relaunch every N minutes" trigger is not added any more - it is removed when found
    expect(reg).not.toContain('CreateElement("TimeTrigger"');
    expect(reg).toContain('$legacy = $triggers.SelectSingleNode("t:TimeTrigger[@id=\'$LegacyWatchdogTriggerId\']", $nsm)');
    // the watchdog task copies the watcher's principal and is refused beside a stored-password task
    expect(reg).toContain("[void]$task.InsertBefore($doc.ImportNode($principals, $true), $task.SelectSingleNode(\"t:Settings\", $nsd))");
    expect(reg).toContain('if ($logon -ne "InteractiveToken") { throw "The watcher task\'s logon type is $logon, not InteractiveToken.');
    expect(reg).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  });

  it("the watchdog judges HEALTH from local signals without a token, and acts only on the existing task", () => {
    expect(dog).not.toMatch(/UploadToken|ApiBaseUrl|Invoke-WebRequest|Invoke-RestMethod|HttpClient/);
    expect(dog).toContain('$HeartbeatFileName = "gso-print-intake-heartbeat.txt"');
    expect(dog).toContain("[ValidateRange(5, 240)][int]$StaleMinutes = 15,");
    expect(dog).toContain('gso-print-intake-local-" + $day + ".log"');
    // it never launches the watcher script and never registers anything
    expect(dog).not.toMatch(/Register-ScheduledTask|Start-Process|Stop-Process|-File[^\n]*gso-print-intake-agent\.ps1/);
    expect(dog.match(/^\s*Start-ScheduledTask /gm)).toHaveLength(1);
    expect(dog.match(/^\s*Stop-ScheduledTask /gm)).toHaveLength(1);
    // a restart starts the task only after the old watcher is really gone
    const act = dog.slice(dog.indexOf("function Invoke-WatchdogCheck"), dog.indexOf("# ---------- main ----------"));
    expect(act).toContain('Write-WatchdogLog "restart_aborted" "the watcher did not stop within 60 s - NOT starting it (never a second watcher). A person should look."');
    expect(act.indexOf("restart_aborted")).toBeLessThan(act.indexOf("Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop"));
    expect(act).toContain('if ([string](Get-ScheduledTask -TaskName $TaskName).State -eq "Running" -or (Get-WatcherProcessCount) -gt 0) {');
    // the log file is opened so the watcher can keep writing to it
    expect(dog).toContain("([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)");
  });

  it("the watchdog backs off after a deliberate safety stop instead of fighting it", () => {
    for (const code of ["1 =", "2 =", "3 =", "4 =", "5 =", "6 =", "267014 ="]) expect(dog).toContain(`  ${code} "`);
    expect(dog).toContain('$verdict.health = "deliberate_stop"');
    expect(dog).toContain("if ($waited -lt $Settings.SafetyStopDelayMinutes) {");
    expect(dog).toContain("$gap = [double]$BaseMinutes * [Math]::Pow(2, [Math]::Min($Consecutive - 1, 10))");
    expect(dog).toContain("# the action is counted BEFORE it is tried, so a failing action backs off too");
    expect(dog).toContain('if ($Signals.HoldFile) { $verdict.health = "hold";');
  });
});

/* ====================================================================== */
/* The documents say what the scripts do                                   */
/* ====================================================================== */

describe("docs match the scripts", () => {
  const enable = src("docs/GSO_MIMAKI_RESULT_SYNC_ENABLEMENT.md");
  const runtime = src("docs/GSO_PRINT_INTAKE_RUNTIME.md");

  it("the enablement doc: status line, install files, one-shot validation, register / verify / disable / rollback", () => {
    expect(enable.split("\n")[0]).toBe("# READY TO ENABLE AFTER LIVE PATCH F VALIDATION");
    expect(enable).toContain("tools\\gso-rasterlink-sync.ps1");
    expect(enable).toContain("tools\\register-mimaki-result-sync-task.ps1");
    expect(enable).toContain("-Once -ActivationUtc");
    expect(enable).toContain("-DryRun -ActivationUtc");
    expect(enable).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\GSO-RIP-Result-Sync\\register-mimaki-result-sync-task.ps1" -WhatIf');
    expect(enable).toContain('Unregister-ScheduledTask -TaskName "GSO Mimaki Result Sync" -Confirm:$false');
    expect(enable).toContain('Disable-ScheduledTask -TaskName "GSO Mimaki Result Sync"');
    expect(enable).toContain("ignored_before_activation");
    expect(enable).not.toMatch(/gso_plog_[0-9a-f]{6}/);
  });

  it("the runtime doc: the commands are the scripts' own, the v1.11 note stays on top, no token value anywhere", () => {
    expect(runtime).toContain("> **UPDATE 2026-11-20, 10:25 AM (after this audit was written):** watcher **v1.11 was installed and is");
    expect(runtime).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File ".\\tools\\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5 -WhatIf');
    expect(runtime).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File ".\\tools\\rotate-print-intake-token.ps1" -RestartWatcher -ClearClipboard');
    expect(runtime).toContain("print-intake-watchdog-hold.txt");
    expect(runtime).toContain("gso-print-intake-heartbeat.txt");
    expect(runtime).not.toMatch(/gso_plog_[0-9a-f]{6}/);
    // every switch the doc tells James to type exists in the script it is typed at
    const reg = src("tools/register-print-intake-startup-task-ELEVATED.ps1");
    for (const name of ["WatchdogMinutes", "StaleMinutes", "AddStartupTrigger", "NoStart"]) expect(reg).toMatch(new RegExp(`\\$${name}\\b`));
    const helper = src("tools/rotate-print-intake-token.ps1");
    for (const name of ["RestartWatcher", "ClearClipboard"]) expect(helper).toContain(`[switch]$${name}`);
  });
});

/* ====================================================================== */
/* On Windows: the real scripts, offline                                   */
/* ====================================================================== */

const onWindows = process.platform === "win32";
const POWERSHELL = "powershell.exe"; // Windows PowerShell 5.1 - what the scheduled tasks run
const run = (args: string[]): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  execFile(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? Number((error as any).code ?? 1) : 0, out: `${stdout}\n${stderr}` });
  });
});
const pad = (n: number) => String(n).padStart(2, "0");
const ripStamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; // local time, as RasterLink writes it

describe.skipIf(!onWindows)("WINDOWS · the real PowerShell scripts, offline (temp folders, stub HTTP server on 127.0.0.1)", () => {
  const FAKE_TOKEN = `gso_plog_${"ab".repeat(24)}`; // a made-up value, valid nowhere
  const root = onWindows ? mkdtempSync(join(tmpdir(), "gso-sync-vitest-")) : "";
  const dirs = { bin: join(root, "bin"), incoming: join(root, "incoming"), processed: join(root, "processed"), error: join(root, "error"), logs: join(root, "logs") };
  const script = join(dirs.bin, "gso-rasterlink-sync.ps1"); // a COPY: its local fallback log lands in the temp folder, never in tools\
  const configPath = join(dirs.bin, "config.json");
  let server: Server | null = null;
  let port = 0;
  let mode: "ok" | "503" | "token" = "ok";
  const received: Array<{ fileName: string; hasToken: boolean; hasSource: boolean }> = [];
  const serverHas = new Set<string>();

  const writeConfig = (over: Record<string, unknown> = {}) => writeFileSync(configPath, JSON.stringify({
    ApiBaseUrl: `http://127.0.0.1:${port}`, UploadToken: FAKE_TOKEN, IncomingFolder: dirs.incoming, ProcessedFolder: dirs.processed, ErrorFolder: dirs.error, LogFolder: dirs.logs,
    JobsFolder: "", NotBeforeUtc: "", Source: "rasterlink", PollSeconds: 1, StableFileSeconds: 1, MaxRetries: 1, RetryDelaySeconds: 1, ClaimStaleMinutes: 30, ...over,
  }, null, 2));
  const now = Date.now();
  const written = new Date(now - 5 * 60_000);              // the result files: written 5 minutes ago
  const activationPast = new Date(now - 60 * 60_000).toISOString().replace(/\.\d+Z$/, "Z"); // activation an hour ago
  const TICKETED = "GSO-20261120-0007-01__MIMAKI__CMYK__F.pdf";
  const names = {
    ticketedPrint: `${ripStamp(written)}_${TICKETED}_1_OK_print.csv`,
    ticketedCut: `${ripStamp(written)}_${TICKETED}_1_OK_cut.csv`,
    crudPrint: `${ripStamp(written)}_crud_POP TARTS STRAW APPLE_b_.pdf_1_OK_print.csv`,
    oldPrint: `${ripStamp(new Date(now - 3 * 3600_000))}_GSO-20261119-0001-01__old.pdf_1_OK_print.csv`,
  };
  const put = (name: string, text: string, when: Date) => { writeFileSync(join(dirs.incoming, name), text); utimesSync(join(dirs.incoming, name), when, when); };
  const seed = () => {
    for (const dir of [dirs.incoming, dirs.processed, dirs.error, dirs.logs]) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
    const end = ripStamp(new Date(now - 10 * 60_000));
    put(names.ticketedPrint, printCsv([TICKETED, "crud_ALL_b_.pdf"], end), written);
    put(names.ticketedCut, cutCsv([TICKETED], end), written);
    put(names.crudPrint, printCsv(["crud_POP TARTS STRAW APPLE_b_.pdf", "crud_ALL_b_.pdf"], end), written);
    const oldWhen = new Date(now - 3 * 3600_000);
    put(names.oldPrint, printCsv(["GSO-20261119-0001-01__old.pdf"], ripStamp(oldWhen)), oldWhen);
    received.length = 0; serverHas.clear();
  };
  const incoming = () => readdirSync(dirs.incoming).sort();
  const logText = () => readdirSync(dirs.logs).map((name) => readFileSync(join(dirs.logs, name), "utf8")).join("\n");

  const ready = onWindows ? new Promise<void>((resolve) => {
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    copyFileSync("tools/gso-rasterlink-sync.ps1", script);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        const fileName = (body.match(/name="file"; filename="([^"]*)"/) || [])[1] || "";
        received.push({ fileName, hasToken: body.includes(`name="token"\r\n\r\n${FAKE_TOKEN}\r\n`), hasSource: body.includes('name="source"\r\n\r\nrasterlink\r\n') });
        const send = (status: number, payload: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); };
        if (mode === "503") return send(503, { ok: false, error: "Service Unavailable" });
        if (mode === "token") return send(403, { ok: false, error: "Invalid or disabled upload token." });
        if (serverHas.has(fileName)) return send(200, { ok: true, duplicateFile: true, importId: "imp_1" });
        serverHas.add(fileName);
        return send(200, { ok: true, format: "rasterlink", rows: 1, created: 1, skippedDuplicates: 0, matched: 1, ambiguous: 0 });
      });
    });
    server.listen(0, "127.0.0.1", () => { port = (server!.address() as any).port; resolve(); });
  }) : Promise.resolve();

  afterAll(() => { server?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  it("gso-rasterlink-sync.ps1 -SelfTest passes (filter, activation, logging fallback, pass guard, outage simulation)", async () => {
    const result = await run(["-File", "tools/gso-rasterlink-sync.ps1", "-SelfTest"]);
    expect(result.out).toContain("self-test failures: 0");
    expect(result.out).not.toMatch(/^FAIL /m);
    expect((result.out.match(/^PASS /gm) || []).length).toBeGreaterThanOrEqual(100);
    expect(result.code).toBe(0);
    for (const needle of ["PASS un-ticketed CRUD result = ignored_no_ticket, listed for review", "PASS outage: both results are still in incoming; the error folder is empty", "PASS pass guard: an arbitrary exception inside the pass is contained", "PASS logging: a failed log write does not throw", "PASS dry run: no upload call was made", "PASS clear ink: the result is uploaded, then the exact job's JobInfo.ini, then the result is archived"]) expect(result.out).toContain(needle);
  }, 180_000);

  it("print-intake-watchdog.ps1 -SelfTest passes (the decision rules)", async () => {
    const result = await run(["-File", "tools/print-intake-watchdog.ps1", "-SelfTest"]);
    expect(result.out).toContain("self-test failures: 0");
    expect(result.out).not.toMatch(/^FAIL /m);
    expect(result.code).toBe(0);
    for (const needle of ["PASS running + files in progress + silent 16 min = STALE -> restart the existing task", "PASS running + empty inbox + silent 5 h (v1.11 writes nothing when idle) = cannot tell -> NO restart", "PASS deliberate stop exit 3 = no start now; the stop is remembered", "PASS task not running but a watcher process exists = never a second watcher", "PASS it stopped again after that retry = back off, not every check"]) expect(result.out).toContain(needle);
  }, 120_000);

  it("NO activation timestamp: the sync refuses with exit 4 — nothing uploaded, nothing moved", async () => {
    await ready; seed(); mode = "ok"; writeConfig();
    const before = incoming();
    const result = await run(["-File", script, "-ConfigPath", configPath, "-Once"]);
    expect(result.code).toBe(4);
    expect(result.out).toContain("REFUSED TO START - NO ACTIVATION TIMESTAMP");
    expect(received).toHaveLength(0);
    expect(incoming()).toEqual(before);
    expect(logText()).toContain("[refused_no_activation]");
    // the poll loop does not accept a command-line activation either
    const loop = await run(["-File", script, "-ConfigPath", configPath, "-ActivationUtc", activationPast]);
    expect(loop.code).toBe(4);
    expect(received).toHaveLength(0);
  }, 120_000);

  it("-DryRun lists what WOULD be uploaded and uploads nothing; only the ticketed post-activation pair qualifies", async () => {
    await ready; seed(); mode = "ok"; writeConfig();
    const before = incoming();
    const result = await run(["-File", script, "-ConfigPath", configPath, "-DryRun", "-ActivationUtc", activationPast]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`WOULD UPLOAD  ${names.ticketedCut}  (ticket GSO-20261120-0007-01`);
    expect(result.out).toContain(`WOULD UPLOAD  ${names.ticketedPrint}  (ticket GSO-20261120-0007-01`);
    expect(result.out).toContain(`WOULD IGNORE  ${names.crudPrint}  (ignored_no_ticket`);
    expect(result.out).not.toContain(`WOULD UPLOAD  ${names.crudPrint}`);
    expect(result.out).not.toContain(`WOULD UPLOAD  ${names.oldPrint}`);
    expect(result.out).toMatch(/DRY RUN SUMMARY: .*would_upload=2 .*ignored_before_activation=1 .*ignored_no_ticket=1 /);
    expect(received).toHaveLength(0);
    expect(incoming()).toEqual(before); // nothing moved, no claim file
    expect(readdirSync(dirs.processed)).toEqual([]);
    expect(result.out + logText()).not.toContain(FAKE_TOKEN);
  }, 120_000);

  it("activation = now (what registration writes): every existing result is ignored for good", async () => {
    await ready; seed(); mode = "ok";
    writeConfig({ ActivationUtc: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
    const before = incoming();
    const result = await run(["-File", script, "-ConfigPath", configPath, "-Once"]);
    expect(result.code).toBe(0);
    expect(received).toHaveLength(0);
    expect(incoming()).toEqual(before);
    expect(logText()).toMatch(/\[pass_summary\] file=- scanned=4 eligible=0 uploaded=0 .*ignored_before_activation=4 .*state=ok/);
  }, 120_000);

  it("server outage, then recovery: results stay in incoming (never the error folder) and are uploaded exactly once afterwards", async () => {
    await ready; seed(); writeConfig({ ActivationUtc: activationPast });
    mode = "503";
    const down = await run(["-File", script, "-ConfigPath", configPath, "-Once"]);
    expect(down.code).toBe(0); // the pass survives the outage
    expect(readdirSync(dirs.error)).toEqual([]);
    expect(readdirSync(dirs.processed)).toEqual([]);
    expect(incoming()).toEqual([names.crudPrint, names.oldPrint, names.ticketedCut, names.ticketedPrint].sort());
    expect(logText()).toMatch(/\[upload_deferred\] .*SERVER NOT ANSWERING/);
    expect(logText()).toMatch(/\[pass_summary\] .*retry_later=2 .*state=ERROR/);
    expect(received.map((r) => r.fileName)).toEqual([names.ticketedCut]); // cut first; after it fails the rest wait

    mode = "ok"; received.length = 0;
    const up = await run(["-File", script, "-ConfigPath", configPath, "-Once"]);
    expect(up.code).toBe(0);
    expect(received.map((r) => r.fileName)).toEqual([names.ticketedCut, names.ticketedPrint]); // cut before print
    expect(received.every((r) => r.hasToken && r.hasSource)).toBe(true); // the multipart body the server expects
    expect(readdirSync(dirs.processed).sort()).toEqual([names.ticketedCut, names.ticketedPrint].sort());
    expect(incoming()).toEqual([names.crudPrint, names.oldPrint].sort()); // ignored results never move
    expect(logText()).toMatch(/\[pass_summary\] .*uploaded=2 .*state=ok/);
    expect(logText()).toMatch(/\[ignored_no_ticket\] file=.*crud_POP TARTS.* NOT uploaded, left in place/);

    // a third run has nothing to do and uploads nothing
    received.length = 0;
    await run(["-File", script, "-ConfigPath", configPath, "-Once"]);
    expect(received).toHaveLength(0);
    expect(logText()).not.toContain(FAKE_TOKEN);
  }, 180_000);

  it("the ERP rejects the token: exit 2, logged, and the result is not misfiled", async () => {
    await ready; seed(); writeConfig({ ActivationUtc: activationPast });
    mode = "token";
    const result = await run(["-File", script, "-ConfigPath", configPath, "-Once"]);
    expect(result.code).toBe(2);
    expect(logText()).toContain("[fatal_config]");
    expect(logText()).toContain("[watcher_stopped]");
    expect(readdirSync(dirs.error)).toEqual([]);
    expect(incoming()).toContain(names.ticketedCut);
    mode = "ok";
  }, 120_000);

  it("a broken config: exit 1, one line in the LOCAL log beside the script, and no piece of the file (the token) is written", async () => {
    await ready;
    writeFileSync(configPath, `{ "UploadToken": "${FAKE_TOKEN}", "ApiBaseUrl": oops }`);
    const result = await run(["-File", script, "-ConfigPath", configPath, "-Once"]);
    expect(result.code).toBe(1);
    const local = readdirSync(dirs.bin).filter((name) => name.startsWith("gso-rasterlink-sync-local-"));
    expect(local).toHaveLength(1);
    const text = readFileSync(join(dirs.bin, local[0]), "utf8");
    expect(text).toContain("[config_error]");
    expect(text).toContain("could not be read as JSON");
    expect(text + result.out).not.toContain(FAKE_TOKEN);
    expect(text + result.out).not.toContain("abababab");
    // and nothing was written beside the repository script
    expect(existsSync("tools") && readdirSync("tools").filter((name) => /-local-\d{8}\.log$/.test(name))).toEqual([]);
  }, 120_000);
});
