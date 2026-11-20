# GSO Print Intake - HEALTH watchdog for the existing watcher task.
#
# It watches whether the watcher is WORKING, not merely whether the scheduled task
# says "Running", and it only ever acts on the ONE existing task
# "GSO Print Intake Agent" (Stop-ScheduledTask / Start-ScheduledTask). It never
# registers a task, never launches the watcher script itself, never starts a
# second watcher, needs no token and talks to no server.
#
# Installed copy: C:\GSO-Print-Intake-Agent\print-intake-watchdog.ps1 (the lead
# engineer copies it there; tools\register-print-intake-startup-task-ELEVATED.ps1
# -WatchdogMinutes N registers the task "GSO Print Intake Watchdog" that runs it).
#
#   -Once       one check, then exit (default when -Loop is not given)
#   -Loop       check every -CheckMinutes, for ever (what the watchdog task runs)
#   -WhatIf     show the signals and the decision; stop / start nothing, save nothing
#   -SelfTest   offline checks of the decision rules (no task, no files, no network)
#
# HEALTH SIGNALS (all local, read-only, no token):
#   1. the task: state, last start time, last exit code
#   2. the heartbeat file  <InstallPath>\gso-print-intake-heartbeat.txt  - written every
#      pass by a watcher that has the heartbeat change (see docs/GSO_PRINT_INTAKE_RUNTIME.md).
#      Watcher v1.11 as installed does NOT write it; the watchdog then uses:
#   3. the newest line of the watcher's own log: the NAS log
#      (<LogFolder>\gso-print-intake-<yyyyMMdd>.log) and the local fallback log
#      (<InstallPath>\gso-print-intake-local-<yyyyMMdd>.log), whichever is newer.
#      v1.11 writes at least one line per file per pass while files are waiting in the
#      inbox, and NOTHING while the inbox is empty. So with the log alone:
#        - files waiting + no new line for -StaleMinutes        -> STALE  -> restart
#        - last line says the inbox is empty (eligible=0)       -> cannot tell -> no action
#        - last line is a pass_error (watcher alive, NAS blind) -> restart only after 3 x -StaleMinutes
#      With the heartbeat file the watchdog can always tell.
#
# WHEN IT ACTS:
#   task Running + healthy                      -> nothing
#   task Running + within -StartupGraceMinutes  -> nothing (the first pass re-hashes every held file)
#   task Running + STALE                        -> Stop-ScheduledTask, wait until the watcher is gone, Start-ScheduledTask
#   task not running, a watcher process exists  -> nothing (a hand-started watcher; never a second one)
#   task not running after a DELIBERATE stop    -> nothing for -SafetyStopDelayMinutes, then one start, then back off
#        (exit 2 token rejected, 3 flood cap, 4 no cutoff, 5 dry run, 6 second instance, 1 config, or stopped by a person)
#   task not running otherwise                  -> Start-ScheduledTask
#   task Disabled, or the hold file exists      -> nothing
# BACK-OFF: after an action that did not make the watcher healthy, the next action waits
#   -BackoffMinutes, then 2 x, 4 x ... (at most once a day). It never fights a stop endlessly.
# HOLD: create  <InstallPath>\print-intake-watchdog-hold.txt  before maintenance (installing a
#   new watcher, rotating the token); remove it afterwards. While it exists nothing is done.
#
# Log:   <InstallPath>\print-intake-watchdog-<yyyyMMdd>.log   (what it saw, what it did)
# State: <InstallPath>\print-intake-watchdog-state.json       (back-off bookkeeping only)
#
# Exit codes: 0 check done | 6 another -Loop watchdog is already running.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Loop,
  [switch]$Once,
  [switch]$SelfTest,
  [string]$TaskName = "GSO Print Intake Agent",
  [string]$InstallPath = "C:\GSO-Print-Intake-Agent",
  # No sign of life for this long = stale. A pass takes about 2 minutes with 31 held
  # 200 MB files (measured 2026-11-20) plus 30 s between passes; 15 minutes is the same
  # limit after which the ERP banner turns red.
  [ValidateRange(5, 240)][int]$StaleMinutes = 15,
  # After a (re)start the first pass re-hashes every held file (about 5 minutes for 31
  # files, about 10 at the flood cap of 60). No verdict before this.
  [ValidateRange(5, 240)][int]$StartupGraceMinutes = 15,
  [ValidateRange(1, 60)][int]$CheckMinutes = 5,
  [ValidateRange(5, 1440)][int]$BackoffMinutes = 30,
  [ValidateRange(5, 1440)][int]$SafetyStopDelayMinutes = 60
)

$ErrorActionPreference = "Stop"
$WatchdogVersion = "print-intake-watchdog/1.0"
$HeartbeatFileName = "gso-print-intake-heartbeat.txt"
$HoldFileName = "print-intake-watchdog-hold.txt"
$StateFileName = "print-intake-watchdog-state.json"
$TaskStillRunningCode = 267009      # 0x41301
$TaskTerminatedCode = 267014        # 0x41306 - the task was stopped (by a person, or by this watchdog)
# Exit codes after which the watcher stopped ON PURPOSE (tools/gso-print-intake-agent.ps1 header).
$DeliberateStops = @{
  1 = "the config could not be loaded, or the script ended with an error (exit 1)"
  2 = "the ERP rejected the upload token (exit 2)"
  3 = "flood-cap safety stop: too many eligible files (exit 3)"
  4 = "no go-live cutoff is configured (exit 4)"
  5 = "a dry run was not honoured (exit 5)"
  6 = "another watcher already holds the single-instance lock (exit 6)"
  267014 = "the task was stopped by a person"
}

# ---------- pure functions (no machine state; exercised by -SelfTest and the tests) ----------

# The last complete log line in a block of log text: @{ utc; event; rest } or $null.
function Get-LastLogLine([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $null }
  $lines = $Text -split "`r?`n"
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \[([A-Za-z_]+)\] file=(.*)$') {
      $utc = [datetime]::MinValue
      $style = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
      if ([datetime]::TryParse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture, $style, [ref]$utc)) {
        return @{ utc = $utc; event = $Matches[2]; rest = $Matches[3] }
      }
    }
  }
  return $null
}

# Minutes that must pass after the last action before the next one.
function Get-BackoffGapMinutes([int]$Consecutive, [int]$BaseMinutes) {
  if ($Consecutive -le 0) { return 0 }
  $gap = [double]$BaseMinutes * [Math]::Pow(2, [Math]::Min($Consecutive - 1, 10))
  return [int][Math]::Min(1440, $gap)
}

# Does the last log line explain a quiet log?  quiet | blind | active | none
#   quiet  = v1.11 writes nothing more until something changes (empty inbox, or the line
#            came from a one-shot run by a person) - liveness cannot be told from the log
#   blind  = pass_error: the loop is alive but a pass keeps failing; repeats are logged
#            only every 20th pass
#   active = files were being worked on: a healthy watcher writes again within one pass
function Get-LogQuietKind($LastLine) {
  if ($null -eq $LastLine) { return "none" }
  $eventName = [string]$LastLine.event
  if ($eventName -eq "pass_error") { return "blind" }
  if ($eventName -eq "scan_summary" -and [string]$LastLine.rest -match '(^|\s)eligible=0(\s|$)') { return "quiet" }
  if ($eventName -eq "agent_finished" -or $eventName -eq "dry_run" -or $eventName -eq "dry_run_not_honoured") { return "quiet" }
  return "active"
}

# THE DECISION. Pure: signals + clock + settings + remembered state in, verdict out.
#   Signals : TaskState ("Running" | "Ready" | "Queued" | "Disabled" | "Missing"), LastRunUtc,
#             LastTaskResult, WatcherProcesses (count; -1 = cannot tell), HeartbeatUtc,
#             LastLog (@{ utc; event; rest } or $null), HoldFile ($true / $false)
#   State   : Consecutive (actions since the watcher was last healthy), LastActionUtc,
#             StopCode + StopSeenUtc (the deliberate stop being waited on)
#   Returns : action (none | start | restart), health, reason, healthy ($true resets the
#             back-off), stopCode / stopSeenUtc (what to remember about a deliberate stop)
function Get-WatchdogDecision($Signals, [datetime]$NowUtc, $Settings, $State) {
  $verdict = @{ action = "none"; health = ""; reason = ""; healthy = $false; stopCode = $null; stopSeenUtc = $null }
  $consecutive = 0; if ($null -ne $State -and $null -ne $State.Consecutive) { $consecutive = [int]$State.Consecutive }
  $lastActionUtc = $null; if ($null -ne $State -and $null -ne $State.LastActionUtc) { $lastActionUtc = [datetime]$State.LastActionUtc }
  $gap = Get-BackoffGapMinutes $consecutive $Settings.BackoffMinutes
  $backoffLeft = 0
  if ($null -ne $lastActionUtc -and $gap -gt 0) { $backoffLeft = [int][Math]::Ceiling($gap - ($NowUtc - $lastActionUtc).TotalMinutes) }

  if ($Signals.HoldFile) { $verdict.health = "hold"; $verdict.reason = "the hold file exists - maintenance in progress; nothing is done"; return $verdict }
  if ($Signals.TaskState -eq "Missing") { $verdict.health = "task_missing"; $verdict.reason = "the scheduled task was not found; the watchdog never registers one"; return $verdict }
  if ($Signals.TaskState -eq "Disabled") { $verdict.health = "task_disabled"; $verdict.reason = "the task is disabled (a person switched it off); nothing is done"; return $verdict }

  if ($Signals.TaskState -ne "Running") {
    if ([int]$Signals.WatcherProcesses -gt 0) {
      $verdict.health = "manual_watcher"; $verdict.reason = "the task is not running but a watcher process is (started by hand); a second watcher is never started"; return $verdict
    }
    $code = [int]$Signals.LastTaskResult
    $stoppedByWatchdog = ($code -eq $TaskTerminatedCode) -and ($null -ne $lastActionUtc) -and (($NowUtc - $lastActionUtc).TotalMinutes -le 10)
    if ($DeliberateStops.ContainsKey($code) -and -not $stoppedByWatchdog) {
      $seen = $NowUtc
      if ($null -ne $State -and $null -ne $State.StopCode -and [int]$State.StopCode -eq $code -and $null -ne $State.StopSeenUtc) { $seen = [datetime]$State.StopSeenUtc }
      $verdict.stopCode = $code; $verdict.stopSeenUtc = $seen
      $verdict.health = "deliberate_stop"
      $waited = ($NowUtc - $seen).TotalMinutes
      if ($waited -lt $Settings.SafetyStopDelayMinutes) {
        $verdict.reason = "the watcher stopped on purpose: " + $DeliberateStops[$code] + ". Not restarting it; a person should look. First retry in " + [int][Math]::Ceiling($Settings.SafetyStopDelayMinutes - $waited) + " min."
        return $verdict
      }
      if ($backoffLeft -gt 0) { $verdict.reason = "the watcher stopped on purpose: " + $DeliberateStops[$code] + ". Already retried $consecutive time(s); backing off, next retry in $backoffLeft min."; return $verdict }
      $verdict.action = "start"; $verdict.reason = "the watcher stopped on purpose (" + $DeliberateStops[$code] + ") and has been down " + [int]$waited + " min: one retry (attempt " + ($consecutive + 1) + "), then back off"
      return $verdict
    }
    $verdict.health = "not_running"
    if ($backoffLeft -gt 0) { $verdict.reason = "the task is not running (last result $code); already started $consecutive time(s) without getting healthy; backing off, next try in $backoffLeft min"; return $verdict }
    $verdict.action = "start"; $verdict.reason = "the task is not running (last result $code)"
    return $verdict
  }

  # ----- the task says Running: is the watcher actually working? -----
  $lastRunUtc = $null; if ($null -ne $Signals.LastRunUtc) { $lastRunUtc = [datetime]$Signals.LastRunUtc }
  $heartbeatLive = ($null -ne $Signals.HeartbeatUtc) -and ($null -eq $lastRunUtc -or [datetime]$Signals.HeartbeatUtc -ge $lastRunUtc.AddMinutes(-1))
  $signs = New-Object System.Collections.ArrayList
  if ($heartbeatLive) { [void]$signs.Add([datetime]$Signals.HeartbeatUtc) }
  if ($null -ne $Signals.LastLog) { [void]$signs.Add([datetime]$Signals.LastLog.utc) }
  $newest = $null
  foreach ($sign in $signs) { if ($null -eq $newest -or $sign -gt $newest) { $newest = $sign } }
  $quietMinutes = if ($null -ne $newest) { ($NowUtc - $newest).TotalMinutes } else { [double]::PositiveInfinity }

  if ($null -ne $newest -and $quietMinutes -le $Settings.StaleMinutes) {
    $verdict.health = "healthy"; $verdict.healthy = $true
    $verdict.reason = "last sign of life " + [int]$quietMinutes + " min ago (" + $(if ($heartbeatLive -and [datetime]$Signals.HeartbeatUtc -eq $newest) { "heartbeat file" } else { "log line [" + $Signals.LastLog.event + "]" }) + ")"
    return $verdict
  }
  if ($null -ne $lastRunUtc -and ($NowUtc - $lastRunUtc).TotalMinutes -lt $Settings.StartupGraceMinutes) {
    $verdict.health = "starting"; $verdict.reason = "started " + [int]($NowUtc - $lastRunUtc).TotalMinutes + " min ago; no verdict during the first $($Settings.StartupGraceMinutes) min"; return $verdict
  }

  $stale = $false
  if ($heartbeatLive) {
    $stale = $true
    $verdict.reason = "STALE: the heartbeat file is " + [int]$quietMinutes + " min old (limit $($Settings.StaleMinutes))"
  } else {
    $kind = Get-LogQuietKind $Signals.LastLog
    if ($kind -eq "none") { $verdict.health = "unknown"; $verdict.reason = "no watcher log line could be read (NAS log and local log) and there is no heartbeat file; cannot judge; nothing is done"; return $verdict }
    if ($kind -eq "quiet") { $verdict.health = "idle_unknown"; $verdict.reason = "the log's last line [" + $Signals.LastLog.event + "] is " + [int]$quietMinutes + " min old and means 'nothing waiting' - this watcher version writes nothing while the inbox is empty, so the log cannot show whether it is alive; nothing is done (the heartbeat file closes this gap)"; return $verdict }
    if ($kind -eq "blind") {
      if ($quietMinutes -le (3 * $Settings.StaleMinutes)) { $verdict.health = "degraded"; $verdict.reason = "the watcher's last line is a pass_error " + [int]$quietMinutes + " min ago: it is alive but a pass keeps failing (NAS?). Repeats are logged every 20th pass; restart only after " + (3 * $Settings.StaleMinutes) + " min of silence"; return $verdict }
      $stale = $true; $verdict.reason = "STALE: nothing since a pass_error " + [int]$quietMinutes + " min ago (limit " + (3 * $Settings.StaleMinutes) + ")"
    } else {
      $stale = $true; $verdict.reason = "STALE: files were being processed, but no log line for " + [int]$quietMinutes + " min (limit $($Settings.StaleMinutes)); last line [" + $Signals.LastLog.event + "]"
    }
  }
  if ($stale) {
    $verdict.health = "stale"
    if ($backoffLeft -gt 0) { $verdict.reason += "; already acted $consecutive time(s) without getting healthy; backing off, next restart in $backoffLeft min"; return $verdict }
    $verdict.action = "restart"
  }
  return $verdict
}

# ---------- self-test of the rules (pure) ----------

function Invoke-WatchdogSelfTest {
  $script:failures = 0
  function Assert($name, $condition) { if ($condition) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:failures++ } }
  $now = [datetime]::SpecifyKind([datetime]"2026-11-20T20:00:00", [DateTimeKind]::Utc)
  $settings = @{ StaleMinutes = 15; StartupGraceMinutes = 15; BackoffMinutes = 30; SafetyStopDelayMinutes = 60 }
  $fresh = @{ Consecutive = 0; LastActionUtc = $null; StopCode = $null; StopSeenUtc = $null }
  function Sig($over) {
    $base = @{ TaskState = "Running"; LastRunUtc = $now.AddHours(-10); LastTaskResult = 267009; WatcherProcesses = 1; HeartbeatUtc = $null; LastLog = $null; HoldFile = $false }
    foreach ($key in $over.Keys) { $base[$key] = $over[$key] }
    return $base
  }
  function LogLine($minutesAgo, $eventName, $rest) { return @{ utc = $now.AddMinutes(-$minutesAgo); event = $eventName; rest = $rest } }

  $text = "2026-11-20T19:58:01Z [detected] file=a b.pdf size=10`r`n2026-11-20T19:58:04Z [ledger_skip] file=a b.pdf server says keep_blocked - still blocked (sha8=aa)`r`nhalf a li"
  $last = Get-LastLogLine $text
  Assert "last log line: the last COMPLETE line, time read as UTC" ($last.event -eq "ledger_skip" -and $last.utc -eq $now.AddMinutes(-2).AddSeconds(4) -and $last.utc.Kind -eq [DateTimeKind]::Utc)
  Assert "last log line: nothing readable = null" (($null -eq (Get-LastLogLine "")) -and ($null -eq (Get-LastLogLine "garbage only")))
  Assert "quiet kinds" (((Get-LogQuietKind (LogLine 1 "scan_summary" "- eligible=0 historical_files_ignored=12 cutoffUtc=x")) -eq "quiet") -and ((Get-LogQuietKind (LogLine 1 "scan_summary" "- eligible=31 historical_files_ignored=12")) -eq "active") -and ((Get-LogQuietKind (LogLine 1 "scan_summary" "- eligible=0")) -eq "quiet") -and ((Get-LogQuietKind (LogLine 1 "scan_summary" "- eligible=10")) -eq "active") -and ((Get-LogQuietKind (LogLine 1 "pass_error" "- x")) -eq "blind") -and ((Get-LogQuietKind (LogLine 1 "agent_finished" "- pass complete")) -eq "quiet") -and ((Get-LogQuietKind (LogLine 1 "ledger_skip" "x")) -eq "active") -and ((Get-LogQuietKind $null) -eq "none"))
  Assert "back-off gaps: 0, base, 2x, 4x ... at most a day" ((Get-BackoffGapMinutes 0 30) -eq 0 -and (Get-BackoffGapMinutes 1 30) -eq 30 -and (Get-BackoffGapMinutes 2 30) -eq 60 -and (Get-BackoffGapMinutes 3 30) -eq 120 -and (Get-BackoffGapMinutes 20 30) -eq 1440)

  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 2 "ledger_skip" "x") }) $now $settings $fresh
  Assert "running + a log line 2 min ago = healthy, no action" ($d.action -eq "none" -and $d.health -eq "healthy" -and $d.healthy)
  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 16 "ledger_skip" "x") }) $now $settings $fresh
  Assert "running + files in progress + silent 16 min = STALE -> restart the existing task" ($d.action -eq "restart" -and $d.health -eq "stale")
  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 14 "detected" "x") }) $now $settings $fresh
  Assert "running + silent 14 min (inside the limit) = healthy" ($d.action -eq "none" -and $d.health -eq "healthy")
  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 300 "scan_summary" "- eligible=0 historical_files_ignored=3") }) $now $settings $fresh
  Assert "running + empty inbox + silent 5 h (v1.11 writes nothing when idle) = cannot tell -> NO restart" ($d.action -eq "none" -and $d.health -eq "idle_unknown")
  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 30 "pass_error" "- unexpected: ledger_unavailable") }) $now $settings $fresh
  Assert "running + last line pass_error 30 min ago = alive but blind -> no restart yet" ($d.action -eq "none" -and $d.health -eq "degraded")
  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 50 "pass_error" "- unexpected: ledger_unavailable") }) $now $settings $fresh
  Assert "running + nothing since a pass_error 50 min ago (> 3 x limit) = stale -> restart" ($d.action -eq "restart")
  $d = Get-WatchdogDecision (Sig @{ LastLog = $null }) $now $settings $fresh
  Assert "running + no readable log + no heartbeat = unknown -> no action" ($d.action -eq "none" -and $d.health -eq "unknown")
  $d = Get-WatchdogDecision (Sig @{ LastRunUtc = $now.AddMinutes(-6); LastLog = (LogLine 40 "ledger_skip" "x") }) $now $settings $fresh
  Assert "running + started 6 min ago = startup grace, no verdict" ($d.action -eq "none" -and $d.health -eq "starting")

  $d = Get-WatchdogDecision (Sig @{ HeartbeatUtc = $now.AddMinutes(-3); LastLog = (LogLine 300 "scan_summary" "- eligible=0") }) $now $settings $fresh
  Assert "heartbeat file 3 min old = healthy even with an idle log" ($d.health -eq "healthy" -and $d.action -eq "none")
  $d = Get-WatchdogDecision (Sig @{ HeartbeatUtc = $now.AddMinutes(-40); LastLog = (LogLine 300 "scan_summary" "- eligible=0") }) $now $settings $fresh
  Assert "heartbeat file from THIS run, 40 min old = STALE -> restart, even with an idle log" ($d.action -eq "restart" -and $d.health -eq "stale")
  $d = Get-WatchdogDecision (Sig @{ LastRunUtc = $now.AddHours(-2); HeartbeatUtc = $now.AddHours(-30); LastLog = (LogLine 100 "scan_summary" "- eligible=0") }) $now $settings $fresh
  Assert "a heartbeat file left by an EARLIER run (the running watcher does not write one) is ignored" ($d.action -eq "none" -and $d.health -eq "idle_unknown")

  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 16 "ledger_skip" "x") }) $now $settings @{ Consecutive = 1; LastActionUtc = $now.AddMinutes(-20); StopCode = $null; StopSeenUtc = $null }
  Assert "stale again 20 min after a restart = back off (30 min), no action" ($d.action -eq "none" -and $d.health -eq "stale" -and $d.reason -match "backing off")
  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 16 "ledger_skip" "x") }) $now $settings @{ Consecutive = 1; LastActionUtc = $now.AddMinutes(-31); StopCode = $null; StopSeenUtc = $null }
  Assert "stale 31 min after the first restart = second restart allowed" ($d.action -eq "restart")
  $d = Get-WatchdogDecision (Sig @{ LastLog = (LogLine 16 "ledger_skip" "x") }) $now $settings @{ Consecutive = 3; LastActionUtc = $now.AddMinutes(-100); StopCode = $null; StopSeenUtc = $null }
  Assert "after three useless restarts the gap is 2 h" ($d.action -eq "none" -and $d.reason -match "next restart in 20 min")

  $down = @{ TaskState = "Ready"; WatcherProcesses = 0 }
  $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = -1073741510 })) $now $settings $fresh
  Assert "task not running after a crash = start the EXISTING task" ($d.action -eq "start" -and $d.health -eq "not_running")
  $d = Get-WatchdogDecision (Sig @{ TaskState = "Ready"; WatcherProcesses = 1; LastTaskResult = 6 }) $now $settings $fresh
  Assert "task not running but a watcher process exists = never a second watcher" ($d.action -eq "none" -and $d.health -eq "manual_watcher")
  foreach ($code in @(1, 2, 3, 4, 5, 6)) {
    $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = $code })) $now $settings $fresh
    Assert "deliberate stop exit $code = no start now; the stop is remembered" ($d.action -eq "none" -and $d.health -eq "deliberate_stop" -and $d.stopCode -eq $code -and $d.stopSeenUtc -eq $now)
  }
  $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = 3 })) $now $settings @{ Consecutive = 0; LastActionUtc = $null; StopCode = 3; StopSeenUtc = $now.AddMinutes(-59) }
  Assert "flood-cap stop seen 59 min ago = still waiting" ($d.action -eq "none")
  $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = 3 })) $now $settings @{ Consecutive = 0; LastActionUtc = $null; StopCode = 3; StopSeenUtc = $now.AddMinutes(-61) }
  Assert "flood-cap stop seen 61 min ago = ONE retry" ($d.action -eq "start" -and $d.stopSeenUtc -eq $now.AddMinutes(-61))
  $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = 3 })) $now $settings @{ Consecutive = 1; LastActionUtc = $now.AddMinutes(-10); StopCode = 3; StopSeenUtc = $now.AddMinutes(-71) }
  Assert "it stopped again after that retry = back off, not every check" ($d.action -eq "none" -and $d.reason -match "backing off")
  $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = 2 })) $now $settings @{ Consecutive = 4; LastActionUtc = $now.AddHours(-3); StopCode = 2; StopSeenUtc = $now.AddHours(-9) }
  Assert "token stop, four retries done = next retry only after 4 h" ($d.action -eq "none" -and $d.reason -match "next retry in 60 min")
  $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = 2 })) $now $settings @{ Consecutive = 0; LastActionUtc = $null; StopCode = 3; StopSeenUtc = $now.AddHours(-5) }
  Assert "a DIFFERENT stop code starts its own wait" ($d.action -eq "none" -and $d.stopSeenUtc -eq $now)
  $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = 267014 })) $now $settings $fresh
  Assert "stopped by a person (maintenance) = not started for the delay" ($d.action -eq "none" -and $d.health -eq "deliberate_stop")
  $d = Get-WatchdogDecision (Sig ($down + @{ LastTaskResult = 267014 })) $now $settings @{ Consecutive = 1; LastActionUtc = $now.AddMinutes(-2); StopCode = $null; StopSeenUtc = $null }
  Assert "terminated by the watchdog's own restart 2 min ago is not 'stopped by a person' (and the back-off still applies)" ($d.health -eq "not_running" -and $d.action -eq "none")

  $d = Get-WatchdogDecision (Sig @{ TaskState = "Disabled"; WatcherProcesses = 0 }) $now $settings $fresh
  Assert "disabled task = nothing" ($d.action -eq "none" -and $d.health -eq "task_disabled")
  $d = Get-WatchdogDecision (Sig @{ TaskState = "Missing"; WatcherProcesses = 0 }) $now $settings $fresh
  Assert "missing task = nothing (never registers one)" ($d.action -eq "none" -and $d.health -eq "task_missing")
  $d = Get-WatchdogDecision (Sig @{ HoldFile = $true; TaskState = "Ready"; WatcherProcesses = 0; LastTaskResult = -1 }) $now $settings $fresh
  Assert "hold file = nothing, whatever the state" ($d.action -eq "none" -and $d.health -eq "hold")

  Write-Host ("self-test failures: " + $script:failures)
  if ($script:failures -gt 0) { exit 1 } else { exit 0 }
}

if ($SelfTest) { Invoke-WatchdogSelfTest }

# ---------- reading the machine (read-only) ----------

$script:LogFolders = @($InstallPath, $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "GSO-Print-Intake-Watchdog" } else { "" }), $env:TEMP)

# Never throws. Local files only - the watchdog must be able to speak while the NAS is down.
function Write-WatchdogLog([string]$EventName, [string]$Detail) {
  try {
    $line = "{0} [{1}] {2}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $EventName, $Detail
    try { Write-Host $line } catch { }
    if ($WhatIfPreference) { return }
    foreach ($folder in @($script:LogFolders)) {
      if ([string]::IsNullOrWhiteSpace($folder)) { continue }
      try {
        if (!(Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force -WhatIf:$false | Out-Null }
        Add-Content -LiteralPath (Join-Path $folder ("print-intake-watchdog-" + (Get-Date -Format "yyyyMMdd") + ".log")) -Value $line -ErrorAction Stop -WhatIf:$false
        return
      } catch { }
    }
  } catch { }
}

# The last bytes of a file, opened so that the watcher can keep writing to it.
function Read-FileTail([string]$Path, [int]$MaxBytes = 16384) {
  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $take = [int][Math]::Min([long]$MaxBytes, $stream.Length)
    [void]$stream.Seek(-$take, [System.IO.SeekOrigin]::End)
    $buffer = New-Object byte[] $take
    $read = 0
    while ($read -lt $take) { $n = $stream.Read($buffer, $read, $take - $read); if ($n -le 0) { break }; $read += $n }
    return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  } catch { return "" } finally { if ($null -ne $stream) { $stream.Dispose() } }
}

# The watcher's NAS log folder, from the watcher's own config. Only the LogFolder
# value is taken out of the text; nothing else in that file is used or kept.
function Get-WatcherLogFolder {
  try {
    $configFile = Join-Path $InstallPath "gso-print-intake-agent-config.json"
    if (!(Test-Path -LiteralPath $configFile)) { return "" }
    $text = [System.IO.File]::ReadAllText($configFile)
    $found = [regex]::Match($text, '"LogFolder"\s*:\s*("(?:[^"\\]|\\.)*")')
    $text = $null
    if (-not $found.Success) { return "" }
    return [string]($found.Groups[1].Value | ConvertFrom-Json)
  } catch { return "" }
}

# The newest readable watcher log line: today's and yesterday's NAS log and local fallback log.
function Get-NewestWatcherLogLine([string]$NasLogFolder) {
  $newest = $null
  $days = @((Get-Date).ToString("yyyyMMdd"), (Get-Date).AddDays(-1).ToString("yyyyMMdd"))
  $candidates = New-Object System.Collections.ArrayList
  foreach ($day in $days) {
    if (-not [string]::IsNullOrWhiteSpace($NasLogFolder)) { [void]$candidates.Add((Join-Path $NasLogFolder ("gso-print-intake-" + $day + ".log"))) }
    [void]$candidates.Add((Join-Path $InstallPath ("gso-print-intake-local-" + $day + ".log")))
  }
  foreach ($candidate in $candidates) {
    try {
      if (!(Test-Path -LiteralPath $candidate)) { continue }
      $line = Get-LastLogLine (Read-FileTail $candidate)
      if ($null -ne $line -and ($null -eq $newest -or $line.utc -gt $newest.utc)) { $newest = $line }
    } catch { }
  }
  return $newest
}

# How many watcher -Loop processes exist (not this watchdog). -1 = cannot tell.
function Get-WatcherProcessCount {
  try {
    $count = 0; $hidden = 0
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop)) {
      if ($process.ProcessId -eq $PID) { continue }
      $commandLine = [string]$process.CommandLine
      if ([string]::IsNullOrEmpty($commandLine)) { $hidden++; continue }
      if ($commandLine -match 'gso-print-intake-agent\.ps1' -and $commandLine -match '(^|\s)-Loop(\s|$)') { $count++ }
    }
    if ($count -eq 0 -and $hidden -gt 0) { return -1 }
    return $count
  } catch { return -1 }
}

function Get-WatchdogSignals {
  $signals = @{ TaskState = "Missing"; LastRunUtc = $null; LastTaskResult = 0; WatcherProcesses = -1; HeartbeatUtc = $null; LastLog = $null; HoldFile = $false }
  $signals.HoldFile = (Test-Path -LiteralPath (Join-Path $InstallPath $HoldFileName))
  $task = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  if ($task.Count -eq 1) {
    $signals.TaskState = [string]$task[0].State
    try {
      $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $task[0].TaskPath -ErrorAction Stop
      # LastTaskResult is unsigned; crash codes (0xC000....) do not fit an int as they are
      $result = [long]$info.LastTaskResult
      if ($result -gt [int]::MaxValue) { $result = $result - 4294967296 }
      $signals.LastTaskResult = [int]$result
      if ($null -ne $info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $signals.LastRunUtc = $info.LastRunTime.ToUniversalTime() }
    } catch { }
  }
  $signals.WatcherProcesses = Get-WatcherProcessCount
  try {
    $heartbeat = Join-Path $InstallPath $HeartbeatFileName
    if (Test-Path -LiteralPath $heartbeat) { $signals.HeartbeatUtc = (Get-Item -LiteralPath $heartbeat).LastWriteTimeUtc }
  } catch { }
  $signals.LastLog = Get-NewestWatcherLogLine (Get-WatcherLogFolder)
  return $signals
}

function Get-StatePath { return (Join-Path $InstallPath $StateFileName) }

function Read-WatchdogState {
  $state = @{ Consecutive = 0; LastActionUtc = $null; StopCode = $null; StopSeenUtc = $null; LastLogged = "" }
  try {
    $path = Get-StatePath
    if (Test-Path -LiteralPath $path) {
      $raw = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
      $style = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
      $culture = [System.Globalization.CultureInfo]::InvariantCulture
      if ($null -ne $raw.Consecutive) { $state.Consecutive = [int]$raw.Consecutive }
      if ($raw.LastActionUtc) { $state.LastActionUtc = [datetime]::Parse([string]$raw.LastActionUtc, $culture, $style) }
      if ($null -ne $raw.StopCode) { $state.StopCode = [int]$raw.StopCode }
      if ($raw.StopSeenUtc) { $state.StopSeenUtc = [datetime]::Parse([string]$raw.StopSeenUtc, $culture, $style) }
      if ($raw.LastLogged) { $state.LastLogged = [string]$raw.LastLogged }
    }
  } catch { }
  return $state
}

function Save-WatchdogState($State) {
  if ($WhatIfPreference) { return }
  try {
    $out = [ordered]@{
      Consecutive   = [int]$State.Consecutive
      LastActionUtc = $(if ($null -ne $State.LastActionUtc) { ([datetime]$State.LastActionUtc).ToString("yyyy-MM-ddTHH:mm:ssZ") } else { $null })
      StopCode      = $State.StopCode
      StopSeenUtc   = $(if ($null -ne $State.StopSeenUtc) { ([datetime]$State.StopSeenUtc).ToString("yyyy-MM-ddTHH:mm:ssZ") } else { $null })
      LastLogged    = [string]$State.LastLogged
    }
    [System.IO.File]::WriteAllText((Get-StatePath), ($out | ConvertTo-Json))
  } catch { Write-WatchdogLog "state_not_saved" ("the back-off state could not be written: " + $_.Exception.Message) }
}

# ---------- acting on the ONE existing task ----------

# Stop the existing task and wait until the watcher is really gone. $true = gone.
function Stop-WatcherTask {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  for ($wait = 0; $wait -lt 30; $wait++) {
    Start-Sleep -Seconds 2
    $state = [string](Get-ScheduledTask -TaskName $TaskName).State
    $processes = Get-WatcherProcessCount
    if ($state -ne "Running" -and $processes -le 0) { return $true }
  }
  return $false
}

function Invoke-WatchdogCheck {
  $nowUtc = (Get-Date).ToUniversalTime()
  $settings = @{ StaleMinutes = $StaleMinutes; StartupGraceMinutes = $StartupGraceMinutes; BackoffMinutes = $BackoffMinutes; SafetyStopDelayMinutes = $SafetyStopDelayMinutes }
  $state = Read-WatchdogState
  $signals = Get-WatchdogSignals
  $decision = Get-WatchdogDecision $signals $nowUtc $settings $state

  $seen = "task=" + $signals.TaskState + " lastResult=" + $signals.LastTaskResult + " watcherProcesses=" + $signals.WatcherProcesses +
    " heartbeat=" + $(if ($null -ne $signals.HeartbeatUtc) { ([datetime]$signals.HeartbeatUtc).ToString("yyyy-MM-ddTHH:mm:ssZ") } else { "(none)" }) +
    " lastLog=" + $(if ($null -ne $signals.LastLog) { ([datetime]$signals.LastLog.utc).ToString("yyyy-MM-ddTHH:mm:ssZ") + "[" + $signals.LastLog.event + "]" } else { "(none)" })

  # remember a deliberate stop (so the wait survives a restart of the watchdog); forget it once it is over
  $state.StopCode = $decision.stopCode
  $state.StopSeenUtc = $decision.stopSeenUtc
  if ($decision.healthy) { $state.Consecutive = 0; $state.LastActionUtc = $null }

  # a line when the verdict changes or when something is done - not one every check
  $signature = $decision.health + "|" + $decision.action
  if ($decision.action -ne "none" -or $signature -ne [string]$state.LastLogged -or $WhatIfPreference) {
    Write-WatchdogLog ("health_" + $decision.health) ($decision.reason + " | " + $seen)
    $state.LastLogged = $signature
  }

  if ($decision.action -eq "none") { Save-WatchdogState $state; return }

  if (-not $PSCmdlet.ShouldProcess("scheduled task '$TaskName'", $decision.action + " (" + $decision.reason + ")")) {
    Write-WatchdogLog "whatif" ("WOULD " + $decision.action.ToUpperInvariant() + " the existing task '$TaskName' - nothing was done")
    return
  }

  # the action is counted BEFORE it is tried, so a failing action backs off too
  $state.Consecutive = [int]$state.Consecutive + 1
  $state.LastActionUtc = $nowUtc
  Save-WatchdogState $state
  try {
    if ($decision.action -eq "restart") {
      Write-WatchdogLog "restart_begin" "Stop-ScheduledTask '$TaskName'"
      if (-not (Stop-WatcherTask)) {
        Write-WatchdogLog "restart_aborted" "the watcher did not stop within 60 s - NOT starting it (never a second watcher). A person should look."
        return
      }
    } else {
      # start: only when no watcher exists
      if ([string](Get-ScheduledTask -TaskName $TaskName).State -eq "Running" -or (Get-WatcherProcessCount) -gt 0) {
        Write-WatchdogLog "start_skipped" "a watcher is running by now - nothing started"
        return
      }
    }
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Start-Sleep -Seconds 10
    Write-WatchdogLog ($decision.action + "_done") ("Start-ScheduledTask '$TaskName' -> state " + [string](Get-ScheduledTask -TaskName $TaskName).State + "; action " + $state.Consecutive + " since the watcher was last healthy; the next one waits " + (Get-BackoffGapMinutes $state.Consecutive $BackoffMinutes) + " min")
  } catch {
    Write-WatchdogLog ($decision.action + "_failed") ("could not " + $decision.action + " the task: " + $_.Exception.Message + " (run the watchdog task with the same rights as the watcher task)")
  }
}

# ---------- main ----------

if ($Loop -and -not $Once) {
  $mutex = $null; $got = $false
  try {
    $mutex = New-Object System.Threading.Mutex($false, "Global\GsoPrintIntakeWatchdogLoop")
    try { $got = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  } catch { $got = $true }   # the lock itself failed: run without it (the task is IgnoreNew anyway)
  if (-not $got) { Write-WatchdogLog "duplicate_watchdog" "another -Loop watchdog is already running; this one stops (exit 6)"; exit 6 }
  Write-WatchdogLog "watchdog_started" "version=$WatchdogVersion task='$TaskName' staleMinutes=$StaleMinutes startupGraceMinutes=$StartupGraceMinutes checkMinutes=$CheckMinutes backoffMinutes=$BackoffMinutes safetyStopDelayMinutes=$SafetyStopDelayMinutes"
  while ($true) {
    try { Invoke-WatchdogCheck } catch { Write-WatchdogLog "check_error" ("unexpected: " + $_.Exception.Message + "; next check in $CheckMinutes min") }
    try { Start-Sleep -Seconds ($CheckMinutes * 60) } catch { }
  }
}

try { Invoke-WatchdogCheck } catch { Write-WatchdogLog "check_error" ("unexpected: " + $_.Exception.Message) }
exit 0
