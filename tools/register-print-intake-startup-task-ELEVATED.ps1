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
# Before changing anything the current task definition is exported next to this file as
#   print-intake-task-backup-<yyyyMMdd-HHmmss>.xml
# Undo:
#   Register-ScheduledTask -TaskName "GSO Print Intake Agent" -Xml (Get-Content "<backup file>" -Raw) -Force
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
    if ($null -ne $restart) { [void]$settings.RemoveChild($restart) }
    $restart = $doc.CreateElement("RestartOnFailure", $TaskNs)
    $intervalNode = $doc.CreateElement("Interval", $TaskNs); $intervalNode.InnerText = "PT${WantRestartIntervalMinutes}M"
    $countNode = $doc.CreateElement("Count", $TaskNs); $countNode.InnerText = [string]([Math]::Max($haveCount, $WantRestartCount))
    [void]$restart.AppendChild($intervalNode); [void]$restart.AppendChild($countNode)
    [void]$settings.AppendChild($restart)
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

$currentXml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath)
$plan = Get-DesiredIntakeTaskXml -CurrentXml $currentXml -WantRestartCount $RestartCount -WantRestartIntervalMinutes $RestartIntervalMinutes -WantStartupDelayMinutes $StartupDelayMinutes -WantWatchdogMinutes $WatchdogMinutes -WantPasswordLogon ([bool]$RunWhetherLoggedOn)

Write-Host ("Task: " + $taskPath + $TaskName + "   state now: " + $task.State)
Write-Host ("Action (NOT changed): " + $task.Actions[0].Execute + " " + $task.Actions[0].Arguments)
foreach ($warning in $plan.Warnings) { Write-Host ("NOTE: " + $warning) }

if ($plan.Changes.Count -eq 0) {
  Write-Host "Already configured - nothing to change. No backup written."
  exit 0
}
Write-Host "Changes this script will make:"
foreach ($change in $plan.Changes) { Write-Host ("  - " + $change) }

$backupPath = Join-Path $PSScriptRoot ("print-intake-task-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".xml")
if (-not $PSCmdlet.ShouldProcess("scheduled task '$TaskName'", "back up the definition to $backupPath, then apply the $($plan.Changes.Count) change(s) listed above")) {
  Write-Host "No backup written. Nothing was changed."
  exit 0
}

# The password is asked for only now (after the preview and the confirmation), only when the
# logon type changes, and it lives in memory just long enough to hand it to Task Scheduler.
$credential = $null
if ($plan.NeedsPassword) {
  $account = Resolve-TaskAccountName $plan.UserId
  $credential = Get-Credential -UserName $account -Message "Password for the account that runs '$TaskName'. It goes straight to Windows Task Scheduler and is not saved by this script."
  if ($null -eq $credential -or $credential.Password.Length -eq 0) { Write-Host "No password entered. Nothing was changed."; exit 1 }
}

# Backup first. If the backup cannot be written and read back, stop before touching the task.
Set-Content -LiteralPath $backupPath -Value $currentXml -Encoding Unicode
$backupItem = Get-Item -LiteralPath $backupPath
if ($backupItem.Length -lt 200 -or ((Get-Content -LiteralPath $backupPath -Raw) -notmatch "<Task ")) {
  Write-Host "The backup at $backupPath could not be verified. Nothing was changed."
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
  Write-Host ("  Register-ScheduledTask -TaskName `"$TaskName`" -Xml (Get-Content `"$backupPath`" -Raw) -Force")
  exit 1
}

# Verify by reading the task back and re-running the same comparison.
$after = Get-ScheduledTask -TaskName $TaskName -TaskPath $taskPath
$afterXml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath)
$recheck = Get-DesiredIntakeTaskXml -CurrentXml $afterXml -WantRestartCount $RestartCount -WantRestartIntervalMinutes $RestartIntervalMinutes -WantStartupDelayMinutes $StartupDelayMinutes -WantWatchdogMinutes $WatchdogMinutes -WantPasswordLogon ([bool]$RunWhetherLoggedOn)
if ($recheck.Changes.Count -gt 0) {
  Write-Host "The task was updated but these settings did not stick - review in Task Scheduler:"
  foreach ($change in $recheck.Changes) { Write-Host ("  - " + $change) }
  Write-Host ("Undo: Register-ScheduledTask -TaskName `"$TaskName`" -Xml (Get-Content `"$backupPath`" -Raw) -Force")
  exit 1
}
if ($after.Actions[0].Arguments -ne $task.Actions[0].Arguments) {
  Write-Host "WARNING: the task action differs from before - review in Task Scheduler, or restore the backup."
  exit 1
}
Write-Host ("Done. Task state: " + $after.State + ". Triggers now: " + ((@($after.Triggers) | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task', '' }) -join ", "))
Write-Host "The watcher was not started or stopped by this script. If the state is not 'Running', start it with:"
Write-Host ("  Start-ScheduledTask -TaskName `"$TaskName`"")
Write-Host ("Undo: Register-ScheduledTask -TaskName `"$TaskName`" -Xml (Get-Content `"$backupPath`" -Raw) -Force")
