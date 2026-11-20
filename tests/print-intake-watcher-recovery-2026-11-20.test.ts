// Print Intake watcher v1.11 (2026-11-20) — recovery behaviour, pinned at the source.
//
// The watcher runs unattended on the RIP PC. These pins cover what it does when
// something around it fails:
//   - a routed file is written to the ledger BEFORE the archive move, so a failed
//     move can never send the same file to the press again (audit item G4);
//   - an unreadable ledger skips the pass instead of acting as "nothing routed";
//   - a claim left by a dead watcher on this PC is reclaimed at once;
//   - one -Loop watcher per PC; a broken config says why in a local log;
//   - every earlier safety stop (exit 2 / 3 / 4 / 5) is still there.
// The heartbeat that makes a dead watcher visible in the ERP is pinned too.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WATCHER_STALE_AFTER_MINUTES, watcherHealth } from "../app/lib/print-intake-heartbeat";

const src = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const agent = src("tools/gso-print-intake-agent.ps1");

function block(from: string, to: string): string {
  const start = agent.indexOf(from);
  const end = agent.indexOf(to, start + from.length);
  expect(start, `missing start marker: ${from}`).toBeGreaterThan(-1);
  expect(end, `missing end marker: ${to}`).toBeGreaterThan(start);
  return agent.slice(start, end);
}

describe("1. version and the safety stops that must never go away", () => {
  it("is v1.11 and still reports its version and host on the heartbeat call", () => {
    expect(agent).toContain('$ScriptVersion = "gso-print-intake-agent/1.11 (');
    expect(agent).not.toContain("gso-print-intake-agent/1.10");
    expect(agent).toContain("@{ token = $config.UploadToken; pending = $true; agentVersion = $ScriptVersion; agentHost = $env:COMPUTERNAME } 20");
  });

  it("a token the ERP itself refuses stops the agent on the heartbeat call too (exit 2), never on a proxy 403", () => {
    expect(agent).toContain("return ($null -ne $Result.json) -and ($Result.json.ok -eq $false) -and ([string]$Result.json.error -match 'upload token')");
    const stop = block("    if (Test-TokenRejected $pendingResult) {", "    if (-not $pendingResult.exception -and $pendingResult.status -eq 200");
    expect(stop).toContain("      exit 2\n");
    expect(stop).toContain("Nothing was processed; files wait where they are.");
  });

  it("keeps exit 2 (token), 3 (flood cap), 4 (no cutoff) and 5 (dry run not honoured)", () => {
    expect(agent).toContain('if ($_.Exception.Message -eq "fatal_config") { Write-IntakeLog $config "agent_stopped" "-" "fatal config error; fix token and restart"; exit 2 }');
    expect(agent).toContain("if (-not (Test-EligibleCountWithinCap $files.Count $config.MaxEligibleFilesPerScan)) {");
    expect(agent).toContain("    exit 3\n");
    expect(agent).toContain("if ($null -eq $config.CutoffUtc) {");
    expect(agent).toContain("  exit 4\n");
    expect(agent).toContain('if ($_.Exception.Message -eq "fatal_dry_run") { Write-Host "DRY RUN STOPPED - the server did not confirm a read-only plan."; exit 5 }');
    expect(agent).toContain("$HardFloodCap = 60");
  });

  it("never logs the token: the local config-error line carries a path, a key name or an exception type only", () => {
    expect(agent).toContain("function Get-IntakeConfigErrorText([string]$Message, [string]$TypeName) {");
    expect(agent).toContain('return "the config file could not be read as JSON ($TypeName)"');
    expect(agent).not.toMatch(/Write-Intake(Local)?Log[^\n]*UploadToken/);
  });
});

describe("2. G4 — a routed file is recorded before anything else can fail", () => {
  const routed = block("      # v1.11 (G4): the copy IS in the hot folder.", "    # Review: the original STAYS EXACTLY WHERE STAFF PUT IT.");

  it("remembers the file in memory and in the ledger before the report and the archive move", () => {
    const memory = routed.indexOf("$script:RoutedThisRun[$hash] = $File.Name");
    const ledger = routed.indexOf('Add-IntakeLedgerEntry $Config $hash $File.Name "routed"');
    const report = routed.indexOf("$routedReport = Send-IntakeReportWithRetry $Config @{ fileName = $File.Name; decision = \"routed\";");
    const move = routed.indexOf("Move-Item -LiteralPath $File.FullName -Destination $archiveDest -Force -Confirm:$false");
    expect(memory).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(memory);
    expect(report).toBeGreaterThan(ledger);
    expect(move).toBeGreaterThan(report);
  });

  it("a failed ledger write is kept in memory and retried; a failed archive move only logs", () => {
    expect(routed).toContain("$script:LedgerUnsaved[$hash] = $File.Name");
    expect(routed).toContain('Write-IntakeLog $Config "ledger_write_failed" $File.Name');
    expect(routed).toContain('Write-IntakeLog $Config "archive_move_failed" $File.Name');
    expect(routed).toContain("it is NOT sent to the press again");
    // the archive move sits inside its own try, so it cannot reach the file_error path
    const moveTry = routed.slice(routed.indexOf("      # Preserve the original: move (never delete) into the routed archive."));
    expect(moveTry).toMatch(/^ {6}# Preserve the original[^\n]*\n {6}try \{\n/);
    expect(routed).not.toContain("Remove-Item");
  });

  it("the copy itself is unchanged: verified by length, exact ERP RIP name, original never deleted", () => {
    expect(agent).toContain("Copy-Item -LiteralPath $File.FullName -Destination $dest -Force -Confirm:$false");
    expect(agent).toContain("if ($copied.Length -ne $File.Length) {");
    expect(agent).toContain("$routedName = Get-RoutedFileName ([string]$plan.ripName) $File.Name");
  });

  it("each pass starts from the ledger plus what this run already routed, and retries unsaved lines", () => {
    const passStart = block("  if (-not $DryRun) { Clear-UnreleasedClaims }", "  # 15H.5: ONE bounded pending-retries call per pass.");
    expect(passStart).toContain("  $ledger = Read-IntakeLedger $config\n  if (-not $DryRun) { Save-UnsavedLedgerEntries $config }\n  Merge-RoutedThisRun $ledger\n");
    expect(agent).toContain('if (-not $Ledger.ContainsKey($routedHash)) { $Ledger[$routedHash] = "routed" }');
  });

  it("the routed report is retried on a transient failure only, and a lost report is logged", () => {
    expect(agent).toContain("function Send-IntakeReportWithRetry($Config, [hashtable]$Outcome, [int]$Attempts = 3, [int]$DelaySeconds = 3) {");
    expect(agent).toContain("if (-not $result.exception -and $result.status -ne 0 -and $result.status -lt 500) { break }");
    expect(agent).toContain('Write-IntakeLog $Config "report_failed" $File.Name');
  });
});

describe("3. the ledger fails closed", () => {
  const read = block("function Read-IntakeLedger($Config) {", "function Add-IntakeLedgerEntry(");

  it("an unreachable log folder or a failed read throws instead of returning an empty ledger", () => {
    expect(read).toContain('if (!(Test-Path -LiteralPath $Config.LogFolder)) { throw "ledger_unavailable: the log folder is not reachable - nothing is processed until it is" }');
    expect(read).toContain("foreach ($line in @(Get-Content -LiteralPath $path -ErrorAction Stop)) {");
    expect(read).not.toContain("SilentlyContinue");
  });

  it("the ledger is read inside the pass guard and before the heartbeat call, so a blind watcher goes stale in the ERP", () => {
    const guard = agent.indexOf("  try {\n  if (-not $DryRun) { Clear-UnreleasedClaims }\n  $ledger = Read-IntakeLedger $config");
    const heartbeat = agent.indexOf("$pendingResult = Invoke-IntakeJsonPost $config $config.StatusUrl");
    expect(guard).toBeGreaterThan(-1);
    expect(heartbeat).toBeGreaterThan(guard);
    expect(agent).toContain('Write-IntakeLog $config "pass_error" "-" "unexpected: $passError; retrying next pass"');
    expect(agent).toContain("if ($passError -ne $lastPassError -or $passErrorRepeats -ge 20) {");
  });
});

describe("4. claims, single instance, config errors", () => {
  it("reclaims a claim only when it is from this PC and its process is gone", () => {
    const orphan = block("function Test-IntakeClaimOrphaned([string]$ClaimText) {", "function New-IntakeClaim(");
    expect(orphan).toContain("if ($claimHost -ne $env:COMPUTERNAME) { return $false }");
    expect(orphan).toContain("if ($claimPid -eq $PID) { return $false }");
    expect(orphan).toContain("return ($null -eq (Get-Process -Id $claimPid -ErrorAction SilentlyContinue))");
    expect(agent).toContain("if (Test-IntakeClaimOrphaned $claimText) { Remove-Item $claimPath -Force -Confirm:$false; continue }");
    // the age rule is still there for every other claim
    expect(agent).toContain("if ($age.TotalMinutes -gt $ClaimStaleMinutes) { Remove-Item $claimPath -Force -Confirm:$false; continue }");
  });

  it("a claim that cannot be released is retried next pass instead of failing the file", () => {
    expect(agent).toContain("if ($claimed) { try { Remove-IntakeClaim $File.FullName } catch { $script:UnreleasedClaims[$File.FullName] = $true } }");
    expect(agent).toContain("try { Remove-IntakeClaim $claimOwner; $script:UnreleasedClaims.Remove($claimOwner) } catch { }");
  });

  it("only a -Loop run takes the single-instance lock; a second watcher stops with exit 6", () => {
    const lock = block("if ($Loop -and -not $Once -and -not $DryRun) {\n  $script:InstanceLock", 'Write-IntakeLog $config "agent_started"');
    expect(lock).toContain('$script:InstanceLock = Enter-IntakeSingleInstance "Global\\GsoPrintIntakeAgentLoop"');
    expect(lock).toContain('if ($script:InstanceLock.state -eq "held") {');
    expect(lock).toContain("    exit 6\n");
    expect(lock).toContain('"instance_lock_unavailable"');
    expect(agent).toContain("try { $got = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }");
  });

  it("a config that will not load stops the agent with exit 1 and one local log line", () => {
    const load = block("try {\n  $config = Read-IntakeConfig $ConfigPath", "if ($Health) { Invoke-IntakeHealth $config; exit 0 }");
    expect(load).toContain('Write-IntakeLocalLog "config_error" ("agent did not start: " + (Get-IntakeConfigErrorText ([string]$_.Exception.Message) $_.Exception.GetType().Name))');
    expect(load).toContain("  exit 1\n");
    // the self-test still runs before any config is read
    expect(agent.indexOf("if ($SelfTest) { Invoke-IntakeSelfTest }")).toBeLessThan(agent.indexOf("  $config = Read-IntakeConfig $ConfigPath"));
  });

  it("logging still never throws (three NAS tries, then the local file)", () => {
    expect(agent).toContain("for ($logTry = 1; $logTry -le 3; $logTry++) {");
    expect(agent).toContain('try { Add-Content -Path (Join-Path $PSScriptRoot ("gso-print-intake-local-" + (Get-Date -Format "yyyyMMdd") + ".log")) -Value $line } catch { }');
  });

  it("the self-test covers the new behaviour", () => {
    for (const name of [
      "ledger read FAILS CLOSED when the log folder is unreachable (never an empty ledger)",
      "a file routed in this run stays routed without a ledger line; an existing ledger entry is not overwritten",
      "an unsaved routed line is written on a later pass and then forgotten",
      "a fresh claim left by a dead process is reclaimed at once",
      "a fresh claim from another PC is still respected",
      "single instance: the first watcher gets the lock, a second one is refused",
      "routed report is retried on a transient failure and stops at the first answer",
    ]) expect(agent).toContain(`Assert "${name}"`);
  });
});

describe("5. the heartbeat that shows a dead watcher in the ERP", () => {
  it("the watcher's once-per-pass status call stamps last-seen, version and host", () => {
    const status = src("app/routes/api.print-intake.status.tsx");
    expect(status).toContain("if (body.pending === true) {");
    expect(status).toContain("intakeAgentLastSeenAt: new Date(),");
    expect(status).toContain("// heartbeat is best effort");
  });

  it("green up to 15 minutes, red after, amber when it has never checked in", () => {
    const now = new Date("2026-11-20T18:00:00Z");
    expect(WATCHER_STALE_AFTER_MINUTES).toBe(15);
    expect(watcherHealth(new Date("2026-11-20T17:59:40Z"), now).state).toBe("ok");
    expect(watcherHealth(new Date("2026-11-20T17:45:00Z"), now).state).toBe("ok"); // exactly 15 min is still ok
    expect(watcherHealth(new Date("2026-11-20T17:44:00Z"), now).state).toBe("stale");
    expect(watcherHealth(null, now).state).toBe("never");
    expect(watcherHealth(new Date("2026-11-20T17:00:00Z"), now).message).toContain('start the task "GSO Print Intake Agent"');
  });

  it("the banner is on Incoming Print Files", () => {
    const page = src("app/routes/app.erp.print-intake.tsx");
    expect(page).toContain("watcher: watcherHealth((setting as any).intakeAgentLastSeenAt),");
    expect(page).toContain('<div role="status"');
  });
});

describe("6. token rotation exists server-side and is owner-only", () => {
  const settings = src("app/routes/app.erp.print-log-settings.tsx");

  it("rotateToken replaces the one upload token and reveals the new value once", () => {
    expect(settings).toContain('if (intent === "rotateToken") {');
    expect(settings).toContain("update: { uploadToken: rotatedToken },");
    expect(settings).toContain("rotatedTokenOnce: rotatedToken,");
    const action = settings.slice(settings.indexOf("export async function action("), settings.indexOf('if (intent === "save") {'));
    expect(action).toContain("requireOwner(auth);");
  });

  it("every agent endpoint answers a wrong token with 403 and a missing one with 401", () => {
    for (const path of ["app/routes/api.print-intake.route-plan.tsx", "app/routes/api.print-intake.report.tsx", "app/routes/api.print-intake.status.tsx", "app/routes/api.rip-imports.upload.tsx"]) {
      const route = src(path);
      expect(route, path).toContain("findUnique({ where: { uploadToken: token } })");
      expect(route, path).toMatch(/Missing upload token\." \}, 401\)/);
      expect(route, path).toMatch(/Invalid or disabled upload token\." \}, 403\)/);
    }
  });

  it("the local helper never prints the token and never restarts anything by itself", () => {
    const helper = src("tools/rotate-print-intake-token.ps1");
    expect(helper).toContain("Read-Host -AsSecureString");
    // the only thing ever printed about a token is its length
    expect(helper).not.toMatch(/Write-(Host|Output)[^\n]*\$(first|second|newToken)\b(?!\.Length)/);
    expect(helper).not.toMatch(/Write-(Host|Output)[^\n]*\.current\b(?!\.Length)/);
    // 2026-11-20 (afternoon): the helper gained an OPT-IN -RestartWatcher that stops + starts the EXISTING task, so
    // "contains no Stop/Start-ScheduledTask" went stale. "By itself" still holds and is pinned more exactly: outside
    // the -RestartWatcher block no line runs a Stop/Start, the block acts on the one named task, and nothing is killed.
    const restartBlock = helper.slice(helper.indexOf("if ($RestartWatcher) {\n  # Only the EXISTING"), helper.indexOf('Write-Host "VERIFY'));
    expect(restartBlock.length).toBeGreaterThan(200);
    expect(restartBlock).toContain("Stop-ScheduledTask -TaskName $WatcherTaskName -ErrorAction Stop");
    expect(restartBlock).toContain("Start-ScheduledTask -TaskName $WatcherTaskName -ErrorAction Stop");
    expect(helper.replace(restartBlock, "")).not.toMatch(/^\s*(Start|Stop)-ScheduledTask /m);
    expect(helper).toContain("[switch]$RestartWatcher,");
    expect(helper).not.toContain("Stop-Process");
  });
});
