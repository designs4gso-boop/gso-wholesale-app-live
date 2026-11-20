# GSO Print Intake Agent - make the watcher survive an unattended reboot.
#
# Run in an ELEVATED PowerShell (Run as administrator). Preview first, then apply:
#   powershell -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1" -WhatIf
#   powershell -ExecutionPolicy Bypass -File ".\tools\register-print-intake-startup-task-ELEVATED.ps1"
#
# What it does to the EXISTING scheduled task "GSO Print Intake Agent" (nothing else):
#   - keeps every existing trigger (the logon trigger stays exactly as it is)
#   - adds an "At startup" trigger (delayed, so the network/NAS is up first)
#   - restart on failure: at least 3 restarts, 1 minute apart (an existing higher count is kept)
#   - no execution time limit (PT0S), MultipleInstances = IgnoreNew (never two watchers)
#   - optional -WatchdogMinutes N: a repeating trigger that re-launches the watcher within
#     N minutes if it has exited. With IgnoreNew it does nothing while the watcher is running.
#   - optional -RunWhetherLoggedOn: run without anyone signed in (see PASSWORD below)
# The action (script path, config path, arguments), the user and the run level are NOT changed.
# The watcher is never started or stopped by this script.
#
# It only ever UPDATES the one existing task. It refuses to run when the task is missing, when
# more than one task has that name, or when the task does not run from the stable install
# folder C:\GSO-Print-Intake-Agent (-InstallPath) - it never registers a new task.
#
# Before changing anything the current task definition is exported into the install folder
# (C:\GSO-Print-Intake-Agent, not this repository) as
#   print-intake-task-backup-<yyyyMMdd-HHmmss>.xml
# Undo (the script prints this line with the real file name):
#   Register-ScheduledTask -TaskName "GSO Print Intake Agent" -TaskPath "\" -Xml (Get-Content -LiteralPath "<backup file>" -Raw) -Force
#
# Without -WhatIf the script lists the changes and then asks "Are you sure?" before the backup
# and the update (add -Confirm:$false to skip the question).
#
# Safe to run twice: when the task already has everything, it says so and changes nothing
# (no backup file is written either).
#
# PASSWORD - read this before choosing how the PC comes back after a reboot:
#   The task runs as the shop's Windows user with logon type "InteractiveToken": Windows only
#   starts it while that user is signed in. An "At startup" trigger alone therefore does NOT
#   start the watcher on a PC that sits at the sign-in screen. Two ways to close that gap:
#     A) Windows automatic sign-in (netplwiz, or Sysinternals Autologon). The PC signs the user
#        in after a reboot, the logon/startup triggers fire, and RasterLink / VersaWorks can
#        start too. This script does not set that up and never sees the password.
#     B) -RunWhetherLoggedOn. The script asks for the account password ONCE, interactively
#        (Get-Credential), hands it straight to Windows Task Scheduler, and keeps no copy: it is
#        never written to a file, a log, the backup XML or this script. Windows itself stores it
#        in its protected task credential store (that is how "run whether user is logged on or
#        not" works). For a Microsoft account this is the Microsoft-account password, not the PIN.
#        The watcher then runs in the background session; it must still be able to reach the NAS
#        share as that user - after applying, check the agent log on the NAS for a fresh
#        "agent_started" line following the next reboot.
#   "Do not store password" (S4U) is deliberately NOT offered: it has no network access, and the
#   watcher's inbox and logs live on the NAS.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$TaskName = "GSO Print Intake Agent",
  [string]$InstallPath = "C:\GSO-Print-Intake-Agent",
  [ValidateRange(1, 100)][int]$RestartCount = 3,
  [ValidateRange(1, 60)][int]$RestartIntervalMinutes = 1,
  [ValidateRange(0, 30)][int]$StartupDelayMinutes = 2,
  [ValidateRange(0, 1440)][int]$WatchdogMinutes = 0,
  [switch]$RunWhetherLoggedOn
)

$ErrorActionPreference = "Stop"
$TaskNs = "http://schemas.microsoft.com/windows/2004/02/mit/task"
$WatchdogTriggerId = "GsoPrintIntakeWatchdog"

# Pure function: current task XML in, desired task XML + a plain list of changes out.
# It touches nothing on the machine. An empty change list means "already configured".
function Get-DesiredIntakeTaskXml {
  param(
    [string]$CurrentXml,
    [int]$WantRestartCount,
    [int]$WantRestartIntervalMinutes,
    [int]$WantStartupDelayMinutes,
    [int]$WantWatchdogMinutes,
    [bool]$WantPasswordLogon
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

  # ----- settings -----
  $settings = $taskNode.SelectSingleNode("t:Settings", $nsm)
  if ($null -eq $settings) {
    $settings = $doc.CreateElement("Settings", $TaskNs)
    $actions = $taskNode.SelectSingleNode("t:Actions", $nsm)
    [void]$taskNode.InsertBefore($settings, $actions)
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
    $intervalNode.InnerText = "PT${WantRestartIntervalMinutes}M"
    $changes.Add("Settings.RestartOnFailure : count=$haveCount interval=$haveInterval -> count=$($countNode.InnerText) interval=PT${WantRestartIntervalMinutes}M")
  }

  # ----- triggers (existing ones are never removed or edited) -----
  $triggers = $taskNode.SelectSingleNode("t:Triggers", $nsm)
  if ($null -eq $triggers) {
    $triggers = $doc.CreateElement("Triggers", $TaskNs)
    [void]$taskNode.InsertBefore($triggers, $taskNode.SelectSingleNode("t:Actions", $nsm))
  }
  if ($null -eq $triggers.SelectSingleNode("t:LogonTrigger", $nsm)) {
    $warnings.Add("The task has no logon trigger today. This script does not add one; it only adds the startup trigger.")
  }
  if ($null -eq $triggers.SelectSingleNode("t:BootTrigger", $nsm)) {
    $boot = $doc.CreateElement("BootTrigger", $TaskNs)
    $enabled = $doc.CreateElement("Enabled", $TaskNs); $enabled.InnerText = "true"
    [void]$boot.AppendChild($enabled)
    if ($WantStartupDelayMinutes -gt 0) {
      $delay = $doc.CreateElement("Delay", $TaskNs); $delay.InnerText = "PT${WantStartupDelayMinutes}M"
      [void]$boot.AppendChild($delay)
    }
    [void]$triggers.AppendChild($boot)
    $changes.Add("Triggers : add 'At startup' trigger (delay ${WantStartupDelayMinutes} min); existing triggers kept")
  }
  if ($WantWatchdogMinutes -gt 0) {
    $watchdog = $triggers.SelectSingleNode("t:TimeTrigger[@id='$WatchdogTriggerId']", $nsm)
    $haveEvery = "(none)"
    if ($null -ne $watchdog) {
      $everyNode = $watchdog.SelectSingleNode("t:Repetition/t:Interval", $nsm)
      if ($null -ne $everyNode) { $haveEvery = $everyNode.InnerText.Trim() }
    }
    if ($haveEvery -ne "PT${WantWatchdogMinutes}M") {
      if ($null -ne $watchdog) { [void]$triggers.RemoveChild($watchdog) }
      $watchdog = $doc.CreateElement("TimeTrigger", $TaskNs)
      $watchdog.SetAttribute("id", $WatchdogTriggerId)
      $repetition = $doc.CreateElement("Repetition", $TaskNs)
      $every = $doc.CreateElement("Interval", $TaskNs); $every.InnerText = "PT${WantWatchdogMinutes}M"
      $stopAtEnd = $doc.CreateElement("StopAtDurationEnd", $TaskNs); $stopAtEnd.InnerText = "false"
      [void]$repetition.AppendChild($every); [void]$repetition.AppendChild($stopAtEnd)
      $startBoundary = $doc.CreateElement("StartBoundary", $TaskNs); $startBoundary.InnerText = "2026-01-01T00:00:00"
      $enabled = $doc.CreateElement("Enabled", $TaskNs); $enabled.InnerText = "true"
      [void]$watchdog.AppendChild($repetition); [void]$watchdog.AppendChild($startBoundary); [void]$watchdog.AppendChild($enabled)
      [void]$triggers.AppendChild($watchdog)
      $changes.Add("Triggers : watchdog repeat $haveEvery -> every ${WantWatchdogMinutes} min (no effect while the watcher is running: IgnoreNew)")
    }
  }

  # ----- principal (only with -RunWhetherLoggedOn) -----
  $needsPassword = $false
  $logonNode = $taskNode.SelectSingleNode("t:Principals/t:Principal/t:LogonType", $nsm)
  $haveLogon = if ($null -ne $logonNode) { $logonNode.InnerText.Trim() } else { "(not set)" }
  if ($WantPasswordLogon -and $haveLogon -ne "Password") {
    if ($null -eq $logonNode) { throw "The task has no <LogonType> to change - refusing to guess. Nothing was changed." }
    $logonNode.InnerText = "Password"
    $needsPassword = $true
    $changes.Add("Principal.LogonType : $haveLogon -> Password (run whether the user is signed in or not; Windows stores the password, this script does not)")
  }
  if (-not $WantPasswordLogon -and $haveLogon -eq "InteractiveToken") {
    $warnings.Add("Logon type stays InteractiveToken: the task only starts while the user is signed in. After an unattended reboot the watcher starts only if Windows signs in automatically, or if you re-run this script with -RunWhetherLoggedOn.")
  }

  $userNode = $taskNode.SelectSingleNode("t:Principals/t:Principal/t:UserId", $nsm)
  return @{
    Xml           = $doc.OuterXml
    Changes       = $changes
    Warnings      = $warnings
    NeedsPassword = $needsPassword
    UserId        = if ($null -ne $userNode) { $userNode.InnerText.Trim() } else { "" }
  }
}

function Resolve-TaskAccountName([string]$UserId) {
  if ($UserId -match '^S-1-') {
    try { return (New-Object System.Security.Principal.SecurityIdentifier($UserId)).Translate([System.Security.Principal.NTAccount]).Value } catch { return $UserId }
  }
  return $UserId
}

# ---------------- main ----------------

$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isElevated -and -not $WhatIfPreference) {
  Write-Host "NOT ELEVATED - right-click PowerShell, choose 'Run as administrator', and run this again. Nothing was changed."
  Write-Host "(A preview with -WhatIf works without elevation: it only reads the task.)"
  exit 1
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) { Write-Host "Scheduled task '$TaskName' was not found. Nothing was changed."; exit 1 }
if (@($task).Count -ne 1) { Write-Host "More than one task matches '$TaskName'. Nothing was changed."; exit 1 }
$taskPath = $task.TaskPath

# Stable install path: this script only hardens the task that runs the installed watcher.
# A task that still points somewhere else (an old clone, a repository folder) is left alone.
$actionNow = @($task.Actions)[0]
if ($null -eq $actionNow) { Write-Host "Scheduled task '$TaskName' has no action. Nothing was changed."; exit 1 }
$actionText = [string]$actionNow.Execute + " " + [string]$actionNow.Arguments
if ($actionText.IndexOf($InstallPath.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  Write-Host "Scheduled task '$TaskName' does not run from $InstallPath :"
  Write-Host ("  " + $actionText)
  Write-Host "Point the task at the installed watcher first (see $InstallPath\switch-task-to-runtime-ELEVATED.ps1), then run this again. Nothing was changed."
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
$plan = Get-DesiredIntakeTaskXml -CurrentXml $currentXml -WantRestartCount $RestartCount -WantRestartIntervalMinutes $RestartIntervalMinutes -WantStartupDelayMinutes $StartupDelayMinutes -WantWatchdogMinutes $WatchdogMinutes -WantPasswordLogon ([bool]$RunWhetherLoggedOn)

Write-Host ("Task: " + $taskPath + $TaskName + "   state now: " + $task.State)
Write-Host ("Action (NOT changed): " + $actionText)
foreach ($warning in $plan.Warnings) { Write-Host ("NOTE: " + $warning) }

if ($plan.Changes.Count -eq 0) {
  Write-Host "Already configured - nothing to change. No backup written."
  exit 0
}
Write-Host "Changes this script will make:"
foreach ($change in $plan.Changes) { Write-Host ("  - " + $change) }

$backupDirectory = if (Test-Path -LiteralPath $InstallPath -PathType Container) { $InstallPath } else { $PSScriptRoot }
$backupPath = Join-Path $backupDirectory ("print-intake-task-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".xml")
$undoCommand = "Register-ScheduledTask -TaskName `"$TaskName`" -TaskPath `"$taskPath`" -Xml (Get-Content -LiteralPath `"$backupPath`" -Raw) -Force"
if (-not $PSCmdlet.ShouldProcess("scheduled task '$TaskName'", "back up the definition to $backupPath, then apply the $($plan.Changes.Count) change(s) listed above")) {
  Write-Host "No backup written. Nothing was changed."
  exit 0
}

# The password is asked for only now (after the preview and the confirmation), only when the
# logon type changes, and it lives in memory just long enough to hand it to Task Scheduler.
$credential = $null
if ($plan.NeedsPassword) {
  # PowerShell module logging (a group policy, off by default) records cmdlet parameter values in
  # the Windows event log - that would include the password handed to Register-ScheduledTask.
  $moduleLogging = Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ModuleLogging" -ErrorAction SilentlyContinue
  if ($null -ne $moduleLogging -and $moduleLogging.EnableModuleLogging -eq 1) {
    Write-Host "PowerShell module logging is ON on this PC: a password given here would be written to the Windows event log."
    Write-Host "Not asking for it. Set 'Run whether user is logged on or not' in Task Scheduler (taskschd.msc) instead, or run this again without -RunWhetherLoggedOn. Nothing was changed."
    exit 1
  }
  $account = Resolve-TaskAccountName $plan.UserId
  $credential = Get-Credential -UserName $account -Message "Password for the account that runs '$TaskName'. It goes straight to Windows Task Scheduler and is not saved by this script."
  if ($null -eq $credential -or $credential.Password.Length -eq 0) { Write-Host "No password entered. Nothing was changed."; exit 1 }
}

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
  Write-Host "Check that the folder exists and is writable, then run this again."
  $credential = $null
  exit 1
}
Write-Host ("Backup written: " + $backupPath)

try {
  if ($null -ne $credential) {
    $plainPassword = $credential.GetNetworkCredential().Password
    try {
      Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Xml $plan.Xml -User $credential.UserName -Password $plainPassword -Force | Out-Null
    } finally {
      $plainPassword = $null
      $credential = $null
    }
  } else {
    Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Xml $plan.Xml -Force | Out-Null
  }
} catch {
  Write-Host ("Task Scheduler refused the update: " + $_.Exception.Message)
  Write-Host "The task keeps its previous definition. To be certain, restore the backup:"
  Write-Host ("  " + $undoCommand)
  exit 1
}

# Verify by reading the task back and re-running the same comparison.
$after = Get-ScheduledTask -TaskName $TaskName -TaskPath $taskPath
$afterXml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath)
$recheck = Get-DesiredIntakeTaskXml -CurrentXml $afterXml -WantRestartCount $RestartCount -WantRestartIntervalMinutes $RestartIntervalMinutes -WantStartupDelayMinutes $StartupDelayMinutes -WantWatchdogMinutes $WatchdogMinutes -WantPasswordLogon ([bool]$RunWhetherLoggedOn)
if ($recheck.Changes.Count -gt 0) {
  Write-Host "The task was updated but these settings did not stick - review in Task Scheduler:"
  foreach ($change in $recheck.Changes) { Write-Host ("  - " + $change) }
  Write-Host ("Undo: " + $undoCommand)
  exit 1
}
$actionAfter = @($after.Actions)[0]
if ($null -eq $actionAfter -or @($after.Actions).Count -ne @($task.Actions).Count -or $actionAfter.Execute -ne $actionNow.Execute -or $actionAfter.Arguments -ne $actionNow.Arguments -or $actionAfter.WorkingDirectory -ne $actionNow.WorkingDirectory) {
  Write-Host "WARNING: the task action differs from before - review in Task Scheduler, or restore the backup:"
  Write-Host ("  " + $undoCommand)
  exit 1
}
Write-Host ("Done. Task state: " + $after.State + ". Triggers now: " + ((@($after.Triggers) | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task', '' }) -join ", "))
Write-Host "The watcher was not started or stopped by this script. If the state is not 'Running', start it with:"
Write-Host ("  Start-ScheduledTask -TaskName `"$TaskName`"")
Write-Host ("Undo: " + $undoCommand)
