# GSO Print Intake Agent - keep the ONE existing watcher task healthy.
#
# Run in an ELEVATED PowerShell (Run as administrator), signed in as the shop user.
# Preview first, then apply:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5 -WhatIf
#   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WatchdogMinutes 5
#
# What it does (and nothing else):
#   A. On the EXISTING scheduled task "GSO Print Intake Agent" - settings only:
#        - no execution time limit (PT0S), MultipleInstances = IgnoreNew (never two watchers)
#        - restart on failure: at least 3 restarts, 1 minute apart (an existing stronger
#          policy - today 10 x 1 minute - is kept as it is)
#        - removes the old repeating "relaunch" trigger of earlier versions of this script
#          (id GsoPrintIntakeWatchdog) if it is there: it only checked "is the task running"
#          and re-launched the watcher every few minutes after a deliberate safety stop
#        - optional -AddStartupTrigger: an "At startup" trigger. Off by default: the task can
#          only start while the user is signed in, and then the logon trigger has started it.
#      The action (script, config, arguments), the user, the logon type (InteractiveToken),
#      the run level and every existing trigger stay exactly as they are.
#   B. With -WatchdogMinutes N: registers (or updates) the task "GSO Print Intake Watchdog",
#      which runs  <InstallPath>\print-intake-watchdog.ps1 -Loop  as the SAME user with the
#      SAME logon type and run level as the watcher task, starting at logon. Every N minutes
#      it checks the watcher's HEALTH (heartbeat file / newest log line - not just "is the
#      task running") and stops + starts the EXISTING watcher task only when it is stale for
#      -StaleMinutes. It backs off after a deliberate safety stop. It never starts a second
#      watcher. Copy tools\print-intake-watchdog.ps1 into <InstallPath> first.
#
# What it never does:
#   - it never starts or stops the WATCHER (the watchdog task is started, unless -NoStart)
#   - it never registers a second watcher task, and it refuses when another enabled task
#     already runs the watcher script
#   - it never changes how the task logs on. -RunWhetherLoggedOn is REFUSED (see below)
#   - it never asks for, stores, prints or passes on a password or any other credential
#   - it never touches Windows automatic sign-in (that is a decision for the owner, made by
#     hand - docs/GSO_PRINT_INTAKE_RUNTIME.md, section 2)
#
# It refuses (exit 1, nothing changed) when: it is not elevated (without -WhatIf); the watcher
# task is missing or duplicated; the task does not run from the stable install folder
# C:\GSO-Print-Intake-Agent (-InstallPath); -WatchdogMinutes is given but the watcher task is
# not an InteractiveToken task or print-intake-watchdog.ps1 is not in the install folder.
#
# Before changing a task its current definition is exported into the install folder as
#   print-intake-task-backup-<yyyyMMdd-HHmmss>.xml            (watcher task, only if it changes)
#   print-intake-watchdog-task-backup-<yyyyMMdd-HHmmss>.xml   (watchdog task, only if it existed)
# The script prints the exact undo lines.
#
# Without -WhatIf the script lists the changes and asks "Are you sure?" first
# (add -Confirm:$false to skip the question).
#
# Safe to run twice: when everything is already in place it says so and changes nothing
# (no backup file is written either).
#
# -RunWhetherLoggedOn (REMOVED 2026-11-20): this switch used to convert the task to
#   "run whether the user is logged on or not" with a stored password. It pre-filled the
#   account as the local alias (DESKTOP-...\user), which is exactly the form that already
#   failed for this Microsoft-account profile, and a watcher without a session is useless
#   here anyway (RasterLink and VersaWorks only run in a signed-in session). The switch is
#   still accepted so that an old command line fails loudly: the script explains and exits 1.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$TaskName = "GSO Print Intake Agent",
  [string]$InstallPath = "C:\GSO-Print-Intake-Agent",
  [ValidateRange(1, 100)][int]$RestartCount = 3,
  [ValidateRange(1, 60)][int]$RestartIntervalMinutes = 1,
  [switch]$AddStartupTrigger,
  [ValidateRange(0, 30)][int]$StartupDelayMinutes = 2,
  # 0 = leave the watchdog alone. N = install the health watchdog, checking every N minutes.
  [ValidateRange(0, 60)][int]$WatchdogMinutes = 0,
  # How long the watcher may show no sign of life before the watchdog restarts it.
  [ValidateRange(5, 240)][int]$StaleMinutes = 15,
  # Register the watchdog task but do not start it now (it starts at the next sign-in).
  [switch]$NoStart,
  [switch]$RunWhetherLoggedOn
)

$ErrorActionPreference = "Stop"
$TaskNs = "http://schemas.microsoft.com/windows/2004/02/mit/task"
$LegacyWatchdogTriggerId = "GsoPrintIntakeWatchdog"
$WatchdogTaskName = "GSO Print Intake Watchdog"
$WatchdogScriptName = "print-intake-watchdog.ps1"

# ---------- pure functions (no machine state; exercised in memory by the tests) ----------

# Current watcher-task XML in, desired XML + a plain list of changes out. Settings and
# triggers only - the principal (user, logon type, run level) and the actions are never
# edited, and the function refuses to return a plan in which they differ.
function Get-DesiredIntakeTaskXml {
  param(
    [string]$CurrentXml,
    [int]$WantRestartCount,
    [int]$WantRestartIntervalMinutes,
    [bool]$WantStartupTrigger,
    [int]$WantStartupDelayMinutes
  )
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $false
  $doc.LoadXml($CurrentXml)
  $nsm = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
  $nsm.AddNamespace("t", $TaskNs)
  $changes = New-Object System.Collections.Generic.List[string]
  $warnings = New-Object System.Collections.Generic.List[string]

  $taskNode = $doc.SelectSingleNode("/t:Task", $nsm)
  if ($null -eq $taskNode) { throw "The exported task XML has no <Task> root - refusing to continue." }
  $principalsBefore = ""; $actionsBefore = ""
  $principalsNode = $taskNode.SelectSingleNode("t:Principals", $nsm)
  $actionsNode = $taskNode.SelectSingleNode("t:Actions", $nsm)
  if ($null -ne $principalsNode) { $principalsBefore = $principalsNode.OuterXml }
  if ($null -ne $actionsNode) { $actionsBefore = $actionsNode.OuterXml }

  # ----- settings -----
  $settings = $taskNode.SelectSingleNode("t:Settings", $nsm)
  if ($null -eq $settings) {
    $settings = $doc.CreateElement("Settings", $TaskNs)
    [void]$taskNode.InsertBefore($settings, $actionsNode)
  }
  $simple = [ordered]@{ ExecutionTimeLimit = "PT0S"; MultipleInstancesPolicy = "IgnoreNew" }
  foreach ($name in $simple.Keys) {
    $node = $settings.SelectSingleNode("t:$name", $nsm)
    $have = if ($null -ne $node) { $node.InnerText.Trim() } else { "(not set)" }
    if ($have -ne $simple[$name]) {
      if ($null -eq $node) { $node = $doc.CreateElement($name, $TaskNs); [void]$settings.AppendChild($node) }
      $node.InnerText = $simple[$name]
      $changes.Add("Settings.$name : $have -> $($simple[$name])")
    }
  }
  $restart = $settings.SelectSingleNode("t:RestartOnFailure", $nsm)
  $haveCount = 0
  $haveInterval = "(not set)"
  if ($null -ne $restart) {
    $countNode = $restart.SelectSingleNode("t:Count", $nsm)
    $intervalNode = $restart.SelectSingleNode("t:Interval", $nsm)
    if ($null -ne $countNode) { [void][int]::TryParse($countNode.InnerText.Trim(), [ref]$haveCount) }
    if ($null -ne $intervalNode) { $haveInterval = $intervalNode.InnerText.Trim() }
  }
  # An existing restart policy that is at least as strong is kept as it is.
  if ($haveCount -lt $WantRestartCount -or $haveInterval -eq "(not set)") {
    # Edited in place: nodes Windows already wrote keep their position and order
    # (this PC exports <Count> before <Interval>); only missing nodes are added.
    if ($null -eq $restart) { $restart = $doc.CreateElement("RestartOnFailure", $TaskNs); [void]$settings.AppendChild($restart) }
    $countNode = $restart.SelectSingleNode("t:Count", $nsm)
    if ($null -eq $countNode) { $countNode = $doc.CreateElement("Count", $TaskNs); [void]$restart.AppendChild($countNode) }
    $countNode.InnerText = [string]([Math]::Max($haveCount, $WantRestartCount))
    $intervalNode = $restart.SelectSingleNode("t:Interval", $nsm)
    if ($null -eq $intervalNode) { $intervalNode = $doc.CreateElement("Interval", $TaskNs); [void]$restart.AppendChild($intervalNode) }
    $intervalNode.InnerText = "PT" + $WantRestartIntervalMinutes + "M"
    $changes.Add("Settings.RestartOnFailure : count=$haveCount interval=$haveInterval -> count=$($countNode.InnerText) interval=PT" + $WantRestartIntervalMinutes + "M")
  }

  # ----- triggers (the logon trigger and every other existing trigger are never edited) -----
  $triggers = $taskNode.SelectSingleNode("t:Triggers", $nsm)
  if ($null -eq $triggers -or $null -eq $triggers.SelectSingleNode("t:LogonTrigger", $nsm)) {
    $warnings.Add("The task has no logon trigger today. This script does not add one.")
  }
  if ($null -ne $triggers) {
    $legacy = $triggers.SelectSingleNode("t:TimeTrigger[@id='$LegacyWatchdogTriggerId']", $nsm)
    if ($null -ne $legacy) {
      [void]$triggers.RemoveChild($legacy)
      $changes.Add("Triggers : remove the old repeating relaunch trigger ($LegacyWatchdogTriggerId) - it re-launched the watcher after a deliberate safety stop; the health watchdog replaces it")
    }
  }
  if ($WantStartupTrigger) {
    if ($null -eq $triggers) {
      $triggers = $doc.CreateElement("Triggers", $TaskNs)
      [void]$taskNode.InsertBefore($triggers, $actionsNode)
    }
    if ($null -eq $triggers.SelectSingleNode("t:BootTrigger", $nsm)) {
      $boot = $doc.CreateElement("BootTrigger", $TaskNs)
      $enabled = $doc.CreateElement("Enabled", $TaskNs); $enabled.InnerText = "true"
      [void]$boot.AppendChild($enabled)
      if ($WantStartupDelayMinutes -gt 0) {
        $delay = $doc.CreateElement("Delay", $TaskNs); $delay.InnerText = "PT" + $WantStartupDelayMinutes + "M"
        [void]$boot.AppendChild($delay)
      }
      [void]$triggers.AppendChild($boot)
      $changes.Add("Triggers : add 'At startup' trigger (delay $WantStartupDelayMinutes min); existing triggers kept")
    }
  }

  # ----- the principal and the action are NOT part of any plan -----
  $logonNode = $taskNode.SelectSingleNode("t:Principals/t:Principal/t:LogonType", $nsm)
  $haveLogon = if ($null -ne $logonNode) { $logonNode.InnerText.Trim() } else { "(not set)" }
  if ($haveLogon -eq "InteractiveToken") {
    $warnings.Add("Logon type stays InteractiveToken: the task starts only while the user is signed in. After an unattended reboot the watcher starts when someone - or Windows automatic sign-in, if the owner sets it up by hand - signs in. This script does not change that.")
  } else {
    $warnings.Add("Logon type is $haveLogon (not InteractiveToken). This script leaves it exactly as it is.")
  }
  $principalsAfter = ""; $actionsAfter = ""
  $principalsNode = $taskNode.SelectSingleNode("t:Principals", $nsm)
  $actionsNode = $taskNode.SelectSingleNode("t:Actions", $nsm)
  if ($null -ne $principalsNode) { $principalsAfter = $principalsNode.OuterXml }
  if ($null -ne $actionsNode) { $actionsAfter = $actionsNode.OuterXml }
  if ($principalsAfter -cne $principalsBefore -or $actionsAfter -cne $actionsBefore) { throw "Internal check failed: the plan would change the task's user / logon type / action. Nothing was changed." }

  return @{
    Xml       = $doc.OuterXml
    Changes   = $changes
    Warnings  = $warnings
    LogonType = $haveLogon
  }
}

# The one command line the watchdog task runs.
function Get-WatchdogArguments([string]$WatchdogScriptPath, [string]$WatcherTaskName, [string]$InstallFolder, [int]$CheckMinutes, [int]$StaleMinutesValue) {
  return '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $WatchdogScriptPath + '" -Loop -TaskName "' + $WatcherTaskName + '" -InstallPath "' + $InstallFolder + '" -CheckMinutes ' + $CheckMinutes + ' -StaleMinutes ' + $StaleMinutesValue
}

# Watcher-task XML in, watchdog-task XML out. The watchdog runs as the SAME principal
# (user, logon type, run level - copied node for node, never edited) and starts at the
# same user's logon. Refuses when the watcher is not an InteractiveToken task: a task that
# needs a stored password is never created by this script.
function Get-WatchdogTaskXml {
  param([string]$WatcherXml, [string]$WatcherTaskName, [string]$InstallFolder, [int]$CheckMinutes, [int]$StaleMinutesValue)
  $watcher = New-Object System.Xml.XmlDocument
  $watcher.LoadXml($WatcherXml)
  $nsm = New-Object System.Xml.XmlNamespaceManager($watcher.NameTable)
  $nsm.AddNamespace("t", $TaskNs)
  $principals = $watcher.SelectSingleNode("/t:Task/t:Principals", $nsm)
  if ($null -eq $principals) { throw "The watcher task has no <Principals> - refusing to guess who the watchdog should run as." }
  $logonNode = $principals.SelectSingleNode("t:Principal/t:LogonType", $nsm)
  $logon = if ($null -ne $logonNode) { $logonNode.InnerText.Trim() } else { "(not set)" }
  if ($logon -ne "InteractiveToken") { throw "The watcher task's logon type is $logon, not InteractiveToken. The watchdog is only installed beside an interactive watcher task; no password is ever asked for or stored." }
  $logonUserNode = $watcher.SelectSingleNode("/t:Task/t:Triggers/t:LogonTrigger/t:UserId", $nsm)

  $arguments = Get-WatchdogArguments (Join-Path $InstallFolder $WatchdogScriptName) $WatcherTaskName $InstallFolder $CheckMinutes $StaleMinutesValue
  $doc = New-Object System.Xml.XmlDocument
  $doc.LoadXml('<?xml version="1.0" encoding="UTF-16"?><Task version="1.3" xmlns="' + $TaskNs + '"><RegistrationInfo><Description>GSO ERP: checks the health of the Print Intake watcher and restarts the existing watcher task only when it is stale. Never starts a second watcher.</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Count>3</Count><Interval>PT5M</Interval></RestartOnFailure><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments></Arguments><WorkingDirectory></WorkingDirectory></Exec></Actions></Task>')
  $nsd = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
  $nsd.AddNamespace("t", $TaskNs)
  $task = $doc.SelectSingleNode("/t:Task", $nsd)
  # schema order: RegistrationInfo, Triggers, Principals, Settings, Actions
  [void]$task.InsertBefore($doc.ImportNode($principals, $true), $task.SelectSingleNode("t:Settings", $nsd))
  $logonTrigger = $task.SelectSingleNode("t:Triggers/t:LogonTrigger", $nsd)
  if ($null -ne $logonUserNode -and $logonUserNode.InnerText.Trim()) {
    $user = $doc.CreateElement("UserId", $TaskNs); $user.InnerText = $logonUserNode.InnerText.Trim()
    [void]$logonTrigger.AppendChild($user)
  }
  # after the watcher itself has had time to start
  $delay = $doc.CreateElement("Delay", $TaskNs); $delay.InnerText = "PT3M"
  [void]$logonTrigger.AppendChild($delay)
  $task.SelectSingleNode("t:Actions/t:Exec/t:Arguments", $nsd).InnerText = $arguments
  $task.SelectSingleNode("t:Actions/t:Exec/t:WorkingDirectory", $nsd).InnerText = $InstallFolder
  return @{ Xml = $doc.OuterXml; Arguments = $arguments; LogonType = $logon }
}

# Does this action text run the watcher script (any copy of it) in -Loop mode?
function Test-ActionRunsWatcher([string]$ActionText) {
  return ([string]$ActionText -match 'gso-print-intake-agent\.ps1')
}

# ---------------- main ----------------

if ($RunWhetherLoggedOn) {
  Write-Host "-RunWhetherLoggedOn is no longer supported and nothing was changed."
  Write-Host "It converted the task to a stored-password logon and pre-filled the local alias of the"
  Write-Host "account - the form that already failed for this Microsoft-account profile. A watcher"
  Write-Host "without a signed-in session is also useless on this PC: RasterLink and VersaWorks only"
  Write-Host "run in a session. Keep the interactive task; see docs/GSO_PRINT_INTAKE_RUNTIME.md, section 2."
  exit 1
}

$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isElevated -and -not $WhatIfPreference) {
  Write-Host "NOT ELEVATED - right-click PowerShell, choose 'Run as administrator', and run this again. Nothing was changed."
  Write-Host "(A preview with -WhatIf works without elevation: it only reads the tasks.)"
  exit 1
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) { Write-Host "Scheduled task '$TaskName' was not found. This script never registers a watcher task. Nothing was changed."; exit 1 }
if (@($task).Count -ne 1) { Write-Host "More than one task matches '$TaskName'. Nothing was changed."; exit 1 }
$taskPath = $task.TaskPath

# Stable install path: this script only works on the task that runs the installed watcher.
$actionNow = @($task.Actions)[0]
if ($null -eq $actionNow) { Write-Host "Scheduled task '$TaskName' has no action. Nothing was changed."; exit 1 }
$actionText = [string]$actionNow.Execute + " " + [string]$actionNow.Arguments
if ($actionText.IndexOf($InstallPath.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  Write-Host "Scheduled task '$TaskName' does not run from $InstallPath :"
  Write-Host ("  " + $actionText)
  Write-Host "Point the task at the installed watcher first (see $InstallPath\switch-task-to-runtime-ELEVATED.ps1), then run this again. Nothing was changed."
  exit 1
}

# No duplicate watcher: no OTHER enabled task may run the watcher script.
$otherWatchers = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  -not ($_.TaskName -eq $TaskName -and $_.TaskPath -eq $taskPath) -and $_.State -ne "Disabled" -and (@($_.Actions | Where-Object { Test-ActionRunsWatcher ([string]$_.Execute + " " + [string]$_.Arguments) }).Count -gt 0)
})
if ($otherWatchers.Count -gt 0) {
  Write-Host "Another enabled task also runs the watcher script:"
  foreach ($other in $otherWatchers) { Write-Host ("  " + $other.TaskPath + $other.TaskName + " (" + $other.State + ")") }
  Write-Host "There must be exactly one watcher task. Disable the other one first. Nothing was changed."
  exit 1
}

try {
  $currentXml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath)
} catch {
  Write-Host ("Could not read the definition of '$TaskName': " + $_.Exception.Message)
  Write-Host "Nothing was changed. If this was a -WhatIf preview without elevation, run it again in an elevated PowerShell."
  exit 1
}
if ($currentXml -notmatch "<Task ") { Write-Host "The exported definition of '$TaskName' is empty or not a task. Nothing was changed."; exit 1 }
$plan = Get-DesiredIntakeTaskXml -CurrentXml $currentXml -WantRestartCount $RestartCount -WantRestartIntervalMinutes $RestartIntervalMinutes -WantStartupTrigger ([bool]$AddStartupTrigger) -WantStartupDelayMinutes $StartupDelayMinutes

Write-Host ("Watcher task: " + $taskPath + $TaskName + "   state now: " + $task.State + "   logon type: " + $plan.LogonType + " (NOT changed)")
Write-Host ("Action (NOT changed): " + $actionText)
foreach ($warning in $plan.Warnings) { Write-Host ("NOTE: " + $warning) }

# ----- the watchdog task (only with -WatchdogMinutes) -----
$watchdogPlan = $null
$watchdogExisting = $null
$watchdogChange = ""
if ($WatchdogMinutes -gt 0) {
  $watchdogScript = Join-Path $InstallPath $WatchdogScriptName
  if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) {
    Write-Host "The watchdog script is not installed: $watchdogScript"
    Write-Host "Copy tools\$WatchdogScriptName from the repository into $InstallPath first. Nothing was changed."
    exit 1
  }
  try {
    $watchdogPlan = Get-WatchdogTaskXml -WatcherXml $currentXml -WatcherTaskName $TaskName -InstallFolder $InstallPath -CheckMinutes $WatchdogMinutes -StaleMinutesValue $StaleMinutes
  } catch {
    Write-Host ("The watchdog cannot be installed: " + $_.Exception.Message + " Nothing was changed.")
    exit 1
  }
  $watchdogExisting = Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue
  if (@($watchdogExisting).Count -gt 1) { Write-Host "More than one task is named '$WatchdogTaskName'. Nothing was changed."; exit 1 }
  if ($null -eq $watchdogExisting) {
    $watchdogChange = "register the task '$WatchdogTaskName' (same user / logon type / run level as the watcher; at logon; IgnoreNew): powershell.exe " + $watchdogPlan.Arguments
  } else {
    $haveWatchdogAction = @($watchdogExisting.Actions)[0]
    if ($null -eq $haveWatchdogAction -or @($watchdogExisting.Actions).Count -ne 1 -or [string]$haveWatchdogAction.Arguments -ne $watchdogPlan.Arguments) {
      $watchdogChange = "update the task '$WatchdogTaskName': its command line becomes  powershell.exe " + $watchdogPlan.Arguments
    }
  }
}

if ($plan.Changes.Count -eq 0 -and -not $watchdogChange) {
  Write-Host "Already configured - nothing to change. No backup written."
  if ($WatchdogMinutes -eq 0) { Write-Host "(The health watchdog was not asked for. Add -WatchdogMinutes 5 to install it.)" }
  exit 0
}
Write-Host "Changes this script will make:"
foreach ($change in $plan.Changes) { Write-Host ("  - watcher task: " + $change) }
if ($watchdogChange) { Write-Host ("  - watchdog: " + $watchdogChange) }
Write-Host "It will NOT start or stop the watcher, change how the watcher logs on, ask for a password, or touch Windows automatic sign-in."

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDirectory = if (Test-Path -LiteralPath $InstallPath -PathType Container) { $InstallPath } else { $PSScriptRoot }
$backupPath = Join-Path $backupDirectory ("print-intake-task-backup-" + $stamp + ".xml")
$watchdogBackupPath = Join-Path $backupDirectory ("print-intake-watchdog-task-backup-" + $stamp + ".xml")
$undoCommand = "Register-ScheduledTask -TaskName `"$TaskName`" -TaskPath `"$taskPath`" -Xml (Get-Content -LiteralPath `"$backupPath`" -Raw) -Force"
$watchdogRemove = "Stop-ScheduledTask -TaskName `"$WatchdogTaskName`"; Unregister-ScheduledTask -TaskName `"$WatchdogTaskName`" -Confirm:`$false"
if (-not $PSCmdlet.ShouldProcess("scheduled task(s) listed above", "apply the change(s) listed above (a backup of each changed task is written first)")) {
  Write-Host "PREVIEW ONLY - no backup written, nothing was changed."
  exit 0
}

# ----- A. the watcher task (only when it needs a change) -----
if ($plan.Changes.Count -gt 0) {
  # Backup first. If the backup cannot be written and read back, stop before touching the task.
  $backupOk = $false
  try {
    Set-Content -LiteralPath $backupPath -Value $currentXml -Encoding Unicode
    $backupText = [string](Get-Content -LiteralPath $backupPath -Raw)
    $backupOk = ($backupText.Trim() -eq $currentXml.Trim()) -and ($backupText -match "<Task ")
  } catch {
    Write-Host ("Could not write the backup to " + $backupPath + ": " + $_.Exception.Message)
  }
  if (-not $backupOk) {
    Write-Host "The backup at $backupPath could not be written and verified, so the task was NOT touched. Nothing was changed."
    exit 1
  }
  Write-Host ("Backup written: " + $backupPath)
  try {
    # No user name and no password are passed: the principal in the XML is the task's own, unchanged.
    Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Xml $plan.Xml -Force | Out-Null
  } catch {
    Write-Host ("Task Scheduler refused the update: " + $_.Exception.Message)
    Write-Host "The task keeps its previous definition. To be certain, restore the backup:"
    Write-Host ("  " + $undoCommand)
    exit 1
  }
  # Verify by reading the task back and re-running the same comparison.
  $after = Get-ScheduledTask -TaskName $TaskName -TaskPath $taskPath
  $afterXml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath)
  $recheck = Get-DesiredIntakeTaskXml -CurrentXml $afterXml -WantRestartCount $RestartCount -WantRestartIntervalMinutes $RestartIntervalMinutes -WantStartupTrigger ([bool]$AddStartupTrigger) -WantStartupDelayMinutes $StartupDelayMinutes
  if ($recheck.Changes.Count -gt 0) {
    Write-Host "The task was updated but these settings did not stick - review in Task Scheduler:"
    foreach ($change in $recheck.Changes) { Write-Host ("  - " + $change) }
    Write-Host ("Undo: " + $undoCommand)
    exit 1
  }
  $actionAfter = @($after.Actions)[0]
  if ($null -eq $actionAfter -or @($after.Actions).Count -ne @($task.Actions).Count -or $actionAfter.Execute -ne $actionNow.Execute -or $actionAfter.Arguments -ne $actionNow.Arguments -or $actionAfter.WorkingDirectory -ne $actionNow.WorkingDirectory -or $recheck.LogonType -ne $plan.LogonType) {
    Write-Host "WARNING: the task action or logon type differs from before - review in Task Scheduler, or restore the backup:"
    Write-Host ("  " + $undoCommand)
    exit 1
  }
  Write-Host ("Watcher task updated. State: " + $after.State + ". Triggers now: " + ((@($after.Triggers) | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task', '' }) -join ", "))
  Write-Host ("Undo: " + $undoCommand)
}

# ----- B. the watchdog task -----
if ($watchdogChange) {
  if ($null -ne $watchdogExisting) {
    try {
      $watchdogOldXml = [string](Export-ScheduledTask -TaskName $WatchdogTaskName -TaskPath $watchdogExisting.TaskPath)
      Set-Content -LiteralPath $watchdogBackupPath -Value $watchdogOldXml -Encoding Unicode
      Write-Host ("Backup written: " + $watchdogBackupPath)
    } catch {
      Write-Host ("Could not back up the existing '$WatchdogTaskName' task (" + $_.Exception.Message + "), so it was NOT touched.")
      exit 1
    }
  }
  try {
    # No user name and no password are passed: the principal is the watcher task's own interactive principal.
    Register-ScheduledTask -TaskName $WatchdogTaskName -Xml $watchdogPlan.Xml -Force | Out-Null
  } catch {
    Write-Host ("Task Scheduler refused the watchdog task: " + $_.Exception.Message)
    Write-Host "The watcher task is as listed above; no watchdog was registered."
    exit 1
  }
  $watchdogAfter = Get-ScheduledTask -TaskName $WatchdogTaskName
  $watchdogActionAfter = @($watchdogAfter.Actions)[0]
  if ($null -eq $watchdogActionAfter -or [string]$watchdogActionAfter.Arguments -ne $watchdogPlan.Arguments -or [string]$watchdogAfter.Settings.MultipleInstances -ne "IgnoreNew") {
    Write-Host "WARNING: the watchdog task does not read back as expected - review it in Task Scheduler, or remove it:"
    Write-Host ("  " + $watchdogRemove)
    exit 1
  }
  if ($NoStart) {
    Write-Host "Watchdog task registered, NOT started (-NoStart). It starts at the next sign-in, or with:"
    Write-Host ("  Start-ScheduledTask -TaskName `"$WatchdogTaskName`"")
  } else {
    # (re)start the WATCHDOG only - never the watcher
    try { Stop-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue } catch { }
    Start-ScheduledTask -TaskName $WatchdogTaskName
    Start-Sleep -Seconds 3
    Write-Host ("Watchdog task registered and started. State: " + (Get-ScheduledTask -TaskName $WatchdogTaskName).State)
  }
  Write-Host ("Watchdog log   : " + (Join-Path $InstallPath "print-intake-watchdog-<yyyyMMdd>.log"))
  Write-Host ("Pause it       : New-Item -ItemType File -Path `"" + (Join-Path $InstallPath "print-intake-watchdog-hold.txt") + "`"   (delete the file to resume)")
  Write-Host ("Remove it      : " + $watchdogRemove)
}

Write-Host "The watcher was not started or stopped by this script. If its state is not 'Running', start it with:"
Write-Host ("  Start-ScheduledTask -TaskName `"$TaskName`"")
exit 0
