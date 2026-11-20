# GSO Mimaki Result Sync - register the ONE scheduled task and ACTIVATE the sync.
#
# Repository copy. The lead engineer copies this file and tools\gso-rasterlink-sync.ps1
# (v1.4 or newer) into C:\GSO-RIP-Result-Sync\ and runs it THERE, only after the first
# ERP-linked Mimaki result has been validated by hand
# (docs/GSO_MIMAKI_RESULT_SYNC_ENABLEMENT.md, section 6).
#
# Preview (reads only; works without elevation; asks nothing; changes nothing):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1" -WhatIf
# Apply (ELEVATED PowerShell - Run as administrator - signed in as the shop user):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\GSO-RIP-Result-Sync\register-mimaki-result-sync-task.ps1"
#
# What it does, in this order:
#   1. checks (read-only): the sync script in C:\GSO-RIP-Result-Sync is v1.4+ (it must know
#      ActivationUtc - an older script would ignore the activation and upload the backlog),
#      the config is valid and points at ...\rasterlink\incoming\UCJV-300, no other enabled
#      task runs the result sync, and the task does not exist yet
#   2. asks "Are you sure?" (skip the question with -Confirm:$false)
#   3. backs up the config beside itself, then writes  "ActivationUtc": "<now, UTC>"  into it.
#      ONLY that key is written. The token is never read out, shown or changed.
#      Every result that exists at this moment is older than the activation, so the sync
#      ignores it for good: the historical results are excluded by construction.
#   4. registers the task "GSO Mimaki Result Sync": at logon of the current user, run level
#      Limited (not elevated), MultipleInstances = IgnoreNew (never two), restart on failure
#      10 x 1 minute, no time limit, running C:\GSO-RIP-Result-Sync\gso-rasterlink-sync.ps1
#      with C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json
#   5. prints the verify, disable and rollback commands
# It does NOT start the task unless -StartNow is given: by default the sync starts at the
# next sign-in, or when you run the Start-ScheduledTask line it prints.
#
# Safe to run twice: when the task already exists with this definition it says so and changes
# nothing - the activation timestamp is NOT moved. A task with this name that runs something
# else is never overwritten.
#
# It refuses (exit 1, nothing changed) when: it is not elevated (without -WhatIf); the current
# Windows user is not the user of the "GSO Print Intake Agent" task (the sync must run in the
# session that can reach the NAS); a file is missing; the sync script is older than v1.4; the
# config is not valid JSON or has no UploadToken; IncomingFolder is not the UCJV-300 folder;
# another enabled task already runs the result sync.
#
# Roland is not touched: "GSO Roland Result Sync" stays disabled and Roland stays manual.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  # Start the task right after registering it. Without this the task is only registered.
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$TaskName = "GSO Mimaki Result Sync"
$Runtime = "C:\GSO-RIP-Result-Sync"
$SyncScript = Join-Path $Runtime "gso-rasterlink-sync.ps1"
$ConfigPath = Join-Path $Runtime "gso-mimaki-result-sync-config.json"
$IntakeTaskName = "GSO Print Intake Agent"
$MinimumSyncVersion = [version]"1.4"
# "ActivationUtc" : "<value>"  - the value is captured so it can be swapped in place.
$ActivationFieldPattern = '("ActivationUtc"\s*:\s*")((?:[^"\\]|\\.)*)(")'

# ---------- pure functions (no machine state; exercised in memory by the tests) ----------

# The version in a sync script's text, or $null.
function Get-SyncScriptVersion([string]$ScriptText) {
  if ([string]$ScriptText -match '\$ScriptVersion\s*=\s*"gso-rasterlink-sync/(\d+\.\d+)') { return [version]$Matches[1] }
  return $null
}

# Config text in, config text with ActivationUtc = $IsoUtc out. Only that key is
# written: an existing value is swapped in place; a missing key is inserted as the
# first property. Every other character of the file is kept.
function Set-ActivationInConfigText([string]$Text, [string]$IsoUtc) {
  if ($IsoUtc -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') { throw "The activation timestamp must look like 2026-11-21T17:20:00Z." }
  $found = [regex]::Matches($Text, $ActivationFieldPattern)
  if ($found.Count -gt 1) { throw "The config has more than one ActivationUtc key - fix it by hand." }
  if ($found.Count -eq 1) {
    return [regex]::Replace($Text, $ActivationFieldPattern, { param($m) $m.Groups[1].Value + $IsoUtc + $m.Groups[3].Value })
  }
  $open = $Text.IndexOf('{')
  if ($open -lt 0) { throw "The config is not a JSON object." }
  $newline = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
  return $Text.Substring(0, $open + 1) + $newline + '  "ActivationUtc": "' + $IsoUtc + '",' + $Text.Substring($open + 1)
}

# $true when the two config texts are the same JSON object except for ActivationUtc
# (same keys in the same order, same values), and the new one holds $IsoUtc.
function Test-OnlyActivationChanged([string]$Before, [string]$After, [string]$IsoUtc) {
  $a = $null; $b = $null
  try { $a = $Before | ConvertFrom-Json; $b = $After | ConvertFrom-Json } catch { return $false }
  if ($null -eq $a -or $null -eq $b) { return $false }
  # the value is compared as TEXT: PowerShell 7 turns an ISO date in JSON into a DateTime
  $stamped = [regex]::Matches($After, $ActivationFieldPattern)
  if ($stamped.Count -ne 1 -or $stamped[0].Groups[2].Value -cne $IsoUtc) { return $false }
  $namesA = @($a.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { $_ -ne "ActivationUtc" })
  $namesB = @($b.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { $_ -ne "ActivationUtc" })
  if (($namesA -join "`n") -cne ($namesB -join "`n")) { return $false }
  foreach ($name in $namesA) {
    if ((ConvertTo-Json -InputObject $a.$name -Depth 8 -Compress) -cne (ConvertTo-Json -InputObject $b.$name -Depth 8 -Compress)) { return $false }
  }
  return $true
}

# What a config must have before the sync may be registered. Returns a list of
# problems (empty = fine). Never returns or prints a value of UploadToken.
function Get-ConfigProblems($Config) {
  $problems = New-Object System.Collections.Generic.List[string]
  if ($null -eq $Config) { $problems.Add("the config is not valid JSON"); return $problems }
  foreach ($key in @("ApiBaseUrl", "UploadToken", "IncomingFolder", "ProcessedFolder", "ErrorFolder", "LogFolder")) {
    if ([string]::IsNullOrWhiteSpace([string]$Config.$key)) { $problems.Add("config key $key is missing or empty") }
  }
  if ([string]$Config.IncomingFolder -notmatch 'rasterlink\\incoming\\UCJV-300\\?$') { $problems.Add("IncomingFolder is not the ...\rasterlink\incoming\UCJV-300 result folder") }
  return $problems
}

# The one command line the task runs.
function Get-SyncTaskArguments([string]$ScriptPath, [string]$ConfigFile) {
  return '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '" -ConfigPath "' + $ConfigFile + '"'
}

# Does this action text run the result sync script (any copy of it)?
function Test-ActionRunsResultSync([string]$ActionText) {
  return ([string]$ActionText -match 'gso-rasterlink-sync\.ps1')
}

# ---------- read-only checks ----------

$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-Host "GSO Mimaki Result Sync - register + activate. No token is ever shown by this script."
Write-Host ""

foreach ($required in @($SyncScript, $ConfigPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Write-Host "Missing $required - copy it into $Runtime first. Nothing was changed."; exit 1 }
}
$installedVersion = Get-SyncScriptVersion ([System.IO.File]::ReadAllText($SyncScript))
if ($null -eq $installedVersion -or $installedVersion -lt $MinimumSyncVersion) {
  Write-Host ("The sync script in $Runtime is " + $(if ($null -eq $installedVersion) { "an unknown version" } else { "v" + $installedVersion }) + ". It must be v$MinimumSyncVersion or newer:")
  Write-Host "an older script does not know ActivationUtc and would upload the existing result backlog."
  Write-Host "Copy tools\gso-rasterlink-sync.ps1 from the repository over it first. Nothing was changed."
  exit 1
}

$configText = [System.IO.File]::ReadAllText($ConfigPath)
$configJson = $null
try { $configJson = $configText | ConvertFrom-Json } catch { $configJson = $null }
$configProblems = Get-ConfigProblems $configJson
if ($configProblems.Count -gt 0) {
  foreach ($problem in $configProblems) { Write-Host ("CONFIG: " + $problem) }
  Write-Host "Fix the config first. Nothing was changed."
  exit 1
}
Write-Host ("Sync script     : $SyncScript (v$installedVersion)")
Write-Host ("Config          : $ConfigPath")
Write-Host ("Incoming folder : " + $configJson.IncomingFolder)
Write-Host ("Jobs folder     : " + $configJson.JobsFolder)
Write-Host ("Upload token    : (set, " + ([string]$configJson.UploadToken).Length + " chars)")
Write-Host ("Activation now  : " + $(if ([string]::IsNullOrWhiteSpace([string]$configJson.ActivationUtc)) { "(not set - the sync refuses to process anything)" } else { [string]$configJson.ActivationUtc }))

$wantArguments = Get-SyncTaskArguments $SyncScript $ConfigPath
$existing = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
if ($existing.Count -gt 1) { Write-Host "More than one task is named '$TaskName'. Nothing was changed."; exit 1 }
if ($existing.Count -eq 1) {
  $haveAction = @($existing[0].Actions)[0]
  $sameAction = ($null -ne $haveAction) -and (@($existing[0].Actions).Count -eq 1) -and ([string]$haveAction.Arguments -eq $wantArguments)
  if ($sameAction) {
    Write-Host ""
    Write-Host ("Already registered - '$TaskName' exists and runs this sync (state: " + $existing[0].State + "). Nothing was changed; the activation timestamp was not moved.")
    exit 0
  }
  Write-Host ""
  Write-Host "A task named '$TaskName' exists but does not run this sync:"
  Write-Host ("  " + [string]$haveAction.Execute + " " + [string]$haveAction.Arguments)
  Write-Host "It is not overwritten. Review it in Task Scheduler. Nothing was changed."
  exit 1
}

# One task only: no OTHER enabled task may run the result sync.
$others = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  $_.TaskName -ne $TaskName -and $_.State -ne "Disabled" -and (@($_.Actions | Where-Object { Test-ActionRunsResultSync ([string]$_.Execute + " " + [string]$_.Arguments) }).Count -gt 0)
})
if ($others.Count -gt 0) {
  Write-Host ""
  Write-Host "Another enabled task already runs the result sync:"
  foreach ($other in $others) { Write-Host ("  " + $other.TaskPath + $other.TaskName + " (" + $other.State + ")") }
  Write-Host "Only one result sync may run. Disable that task first. Nothing was changed."
  exit 1
}

# The sync must run as the user whose session reaches the NAS: the user of the intake task.
$intakeTask = Get-ScheduledTask -TaskName $IntakeTaskName -ErrorAction SilentlyContinue
if ($null -ne $intakeTask) {
  $intakeUser = [string]$intakeTask.Principal.UserId
  $intakeSid = $intakeUser
  if ($intakeUser -and $intakeUser -notmatch '^S-1-') {
    try { $intakeSid = (New-Object System.Security.Principal.NTAccount($intakeUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $intakeSid = "" }
  }
  if ($intakeSid -and $intakeSid -ne $currentSid) {
    Write-Host ""
    Write-Host "You are signed in as $currentUser, but '$IntakeTaskName' runs as another user ($intakeUser)."
    Write-Host "Run this as the shop user whose Windows session reaches the NAS. Nothing was changed."
    exit 1
  }
}

if (-not $isElevated -and -not $WhatIfPreference) {
  Write-Host ""
  Write-Host "NOT ELEVATED - right-click PowerShell, choose 'Run as administrator', and run this again. Nothing was changed."
  Write-Host "(A preview with -WhatIf works without elevation: it only reads.)"
  exit 1
}

$activationIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$backupPath = Join-Path $Runtime ("gso-mimaki-result-sync-config.before-activation-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")

$verifyLines = @(
  "Get-ScheduledTask -TaskName `"$TaskName`" | Select-Object TaskName, State",
  "Get-ScheduledTask -TaskName `"$TaskName`" | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult",
  "powershell -NoProfile -ExecutionPolicy Bypass -File `"$SyncScript`" -ConfigPath `"$ConfigPath`" -DryRun"
)
$startLine = "Start-ScheduledTask -TaskName `"$TaskName`""
$disableLines = @("Stop-ScheduledTask -TaskName `"$TaskName`"", "Disable-ScheduledTask -TaskName `"$TaskName`"")
$rollbackLines = @(
  "Stop-ScheduledTask -TaskName `"$TaskName`"",
  "Unregister-ScheduledTask -TaskName `"$TaskName`" -Confirm:`$false",
  "Copy-Item -LiteralPath `"$backupPath`" -Destination `"$ConfigPath`" -Force"
)

Write-Host ""
Write-Host "This script will:"
Write-Host ("  - back up the config to " + $backupPath)
Write-Host ("  - write ActivationUtc = $activationIso into the config (only that key; every result that exists now is older and is ignored for good)")
Write-Host ("  - register the task '$TaskName' for $currentUser : at logon, not elevated, IgnoreNew, restart 10 x 1 min, no time limit")
Write-Host ("      powershell.exe " + $wantArguments)
Write-Host ("  - " + $(if ($StartNow) { "start the task (-StartNow)" } else { "NOT start the task (it starts at the next sign-in, or with: $startLine)" }))

if (-not $PSCmdlet.ShouldProcess("scheduled task '$TaskName' and $ConfigPath", "write the activation timestamp and register the task")) {
  Write-Host ""
  Write-Host "PREVIEW ONLY - nothing was written, no task was registered."
  exit 0
}

# ---------- apply ----------

# 1. backup, verified, before the config is touched
try {
  Copy-Item -LiteralPath $ConfigPath -Destination $backupPath -Confirm:$false
  if ((Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash) { throw "the backup copy does not match the config" }
} catch {
  Write-Host ("Could not back up the config: " + $_.Exception.Message + ". Nothing was changed.")
  exit 1
}

# 2. activation timestamp - only that key
$bytes = [System.IO.File]::ReadAllBytes($ConfigPath)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$beforeText = (New-Object System.Text.UTF8Encoding($false)).GetString($bytes, $(if ($hasBom) { 3 } else { 0 }), $bytes.Length - $(if ($hasBom) { 3 } else { 0 }))
try {
  $afterText = Set-ActivationInConfigText $beforeText $activationIso
  if (-not (Test-OnlyActivationChanged $beforeText $afterText $activationIso)) { throw "the edited config would differ in more than ActivationUtc" }
  [System.IO.File]::WriteAllText($ConfigPath, $afterText, (New-Object System.Text.UTF8Encoding([bool]$hasBom)))
  $readBack = [System.IO.File]::ReadAllText($ConfigPath)
  if (-not (Test-OnlyActivationChanged $beforeText $readBack $activationIso)) { throw "the config did not read back with only ActivationUtc changed" }
} catch {
  Write-Host ("Could not write the activation timestamp: " + $_.Exception.Message)
  try { Copy-Item -LiteralPath $backupPath -Destination $ConfigPath -Force -Confirm:$false; Write-Host "The config was put back from its backup. No task was registered." } catch { Write-Host ("COULD NOT RESTORE - copy this file back by hand: " + $backupPath) }
  exit 1
}
Write-Host ("Activation written: ActivationUtc = $activationIso  (backup: $backupPath)")

# 3. the one task
try {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $wantArguments -WorkingDirectory $Runtime
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "GSO ERP: uploads ticketed Mimaki RasterLink results written after the activation timestamp (and the exact job's JobInfo.ini ink) to the ERP." | Out-Null
} catch {
  Write-Host ("Task Scheduler refused the registration: " + $_.Exception.Message)
  try { Copy-Item -LiteralPath $backupPath -Destination $ConfigPath -Force -Confirm:$false; Write-Host "The config was put back from its backup (the activation timestamp is as it was). No task was registered." } catch { Write-Host ("COULD NOT RESTORE the config - copy this file back by hand: " + $backupPath) }
  exit 1
}

# 4. read back
$after = Get-ScheduledTask -TaskName $TaskName
$afterAction = @($after.Actions)[0]
$ok = (@($after.Actions).Count -eq 1) -and ([string]$afterAction.Arguments -eq $wantArguments) -and ([string]$after.Settings.MultipleInstances -eq "IgnoreNew")
if (-not $ok) {
  Write-Host "WARNING: the task was registered but does not read back as expected - review it in Task Scheduler, or roll back:"
  foreach ($line in $rollbackLines) { Write-Host ("  " + $line) }
  exit 1
}
Write-Host ("Registered: '$TaskName' (state: " + $after.State + ", MultipleInstances: " + $after.Settings.MultipleInstances + ").")

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 5
  Write-Host ("Started. Task state: " + (Get-ScheduledTask -TaskName $TaskName).State)
} else {
  Write-Host "NOT started. Start it when you are ready:"
  Write-Host ("  " + $startLine)
}

Write-Host ""
Write-Host "VERIFY (the dry run lists what would be uploaded - right after registration that is nothing):"
foreach ($line in $verifyLines) { Write-Host ("  " + $line) }
Write-Host ("  Log: " + $configJson.LogFolder + "\gso-rasterlink-sync-<yyyyMMdd>.log  (watcher_started ... activationUtc=$activationIso, then pass_summary ... state=ok)")
Write-Host "DISABLE (keeps the task and the activation; nothing is deleted):"
foreach ($line in $disableLines) { Write-Host ("  " + $line) }
Write-Host "ROLL BACK (removes the task and puts the config back as it was before this run):"
foreach ($line in $rollbackLines) { Write-Host ("  " + $line) }
Write-Host ("The backup " + $backupPath + " holds the config as it was, including the token - keep it out of chats and e-mail.")
exit 0
