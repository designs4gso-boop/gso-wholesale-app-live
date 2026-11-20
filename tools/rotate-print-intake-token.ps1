# GSO Print Intake - put a NEW upload token into the local agent configs on this PC.
#
# This is the LOCAL half of a token rotation. The new token is created in the ERP
# (Print Log Settings -> Rotate token, owner only) and shown there exactly once.
# Full runbook: docs/GSO_PRINT_INTAKE_RUNTIME.md, "Token rotation".
#
# Preview (reads the files, asks for nothing, changes nothing):
#   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\rotate-print-intake-token.ps1" -WhatIf
# Apply (ELEVATED PowerShell when -RestartWatcher is used; a normal window is enough without it):
#   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\rotate-print-intake-token.ps1" -RestartWatcher -ClearClipboard
#
# What it does:
#   - asks for the new token TWICE with hidden input (Read-Host -AsSecureString: nothing
#     typed or pasted is shown)
#   - ONLY the two runtime configs can be updated (C:\GSO-Print-Intake-Agent\... and
#     C:\GSO-RIP-Result-Sync\...); any other path given in -ConfigPath is refused
#   - for each of them that exists and has an "UploadToken" value:
#       1. copies the file beside itself as  <name>.before-token-rotation-<yyyyMMdd-HHmmss>.json
#       2. replaces ONLY the UploadToken value (every other character of the file is kept)
#       3. reads the file back and checks it is valid JSON, holds the new token, and
#          that nothing else changed
#   - prints key names and lengths only - never a token, old or new
#   - with -RestartWatcher (and only then): stops and starts the EXISTING scheduled task
#     "GSO Print Intake Agent" and waits for a fresh line in the watcher's log. It never
#     launches the watcher script itself and never starts a second watcher.
#   - prints the exact verification steps (banner green; old token rejected)
#
# What it does NOT do:
#   - it does not talk to the ERP, and it does not create or check a token
#   - without -RestartWatcher it does not start, stop or restart anything. The running
#     watcher keeps the OLD token in memory until it is restarted (see the runbook).
#   - it does not delete anything. The backup copies still hold the OLD token; once
#     the old token is rotated away it is worthless, but delete the backups when the
#     rotation is verified.
#
# Undo: copy a backup over its config (the script prints the exact line per file).
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # Only the two RUNTIME configs get the new token. The three configs in the old
  # clone (C:\Users\golde\GSO-ERP-WORKSPACE\wholesale-lite-mvp\tools\...) are left
  # alone on purpose: nothing live reads them, and the token they hold stops
  # working the moment the ERP rotates it.
  [string[]]$ConfigPath = @(
    "C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json",
    "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json"
  ),
  # The ERP makes tokens shaped gso_plog_ + 48 hex characters. Anything else is refused
  # (a half-pasted token would lock the watcher out) unless this switch is given.
  [switch]$AllowAnyFormat,
  # Empty the Windows clipboard at the end (the token was probably pasted from it).
  [switch]$ClearClipboard,
  # After the configs are updated: stop + start the EXISTING watcher task and wait for a
  # fresh log line. Needs an elevated PowerShell (the task runs with highest privileges).
  [switch]$RestartWatcher,
  [string]$WatcherTaskName = "GSO Print Intake Agent",
  [ValidateRange(30, 900)][int]$RestartWaitSeconds = 240
)

$ErrorActionPreference = "Stop"
# The ONLY files this script may write a token into.
$RuntimeConfigs = @(
  "C:\GSO-Print-Intake-Agent\gso-print-intake-agent-config.json",
  "C:\GSO-RIP-Result-Sync\gso-mimaki-result-sync-config.json"
)
$WatcherConfig = $RuntimeConfigs[0]
$TokenPattern = '^gso_plog_[0-9a-f]{48}$'
# "UploadToken" : "<value>"  - the value is captured so it can be swapped in place.
$TokenFieldPattern = '("UploadToken"\s*:\s*")((?:[^"\\]|\\.)*)(")'

function ConvertTo-PlainText([System.Security.SecureString]$Secure) {
  $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

# The file text with the token value blanked out - used to prove nothing else changed.
function Get-TextWithoutToken([string]$Text) {
  return [regex]::Replace($Text, $TokenFieldPattern, { param($m) $m.Groups[1].Value + $m.Groups[3].Value })
}

# One config file -> what is there. Reads only.
function Get-ConfigTokenState([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ path = $Path; state = "missing" } }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = (New-Object System.Text.UTF8Encoding($false)).GetString($bytes, $(if ($hasBom) { 3 } else { 0 }), $bytes.Length - $(if ($hasBom) { 3 } else { 0 }))
  $json = $null
  try { $json = $text | ConvertFrom-Json } catch { return @{ path = $Path; state = "not_json" } }
  $found = [regex]::Matches($text, $TokenFieldPattern)
  if ($found.Count -ne 1 -or $null -eq $json.PSObject.Properties["UploadToken"]) { return @{ path = $Path; state = "no_single_token_field"; count = $found.Count } }
  return @{ path = $Path; state = "ok"; text = $text; hasBom = $hasBom; current = [string]$json.UploadToken }
}

# Is this one of the two runtime configs? (full path, case-insensitive)
function Test-IsRuntimeConfig([string]$Path) {
  $full = ""
  try { $full = [System.IO.Path]::GetFullPath($Path) } catch { return $false }
  foreach ($allowed in $RuntimeConfigs) { if ($full -ieq $allowed) { return $true } }
  return $false
}

# "yyyy-MM-ddTHH:mm:ssZ [event] ..." lines at or after $SinceUtc in a block of log text:
# returns the EVENT NAMES only (never a whole line).
function Get-LogEventsSince([string]$Text, [datetime]$SinceUtc) {
  $events = New-Object System.Collections.ArrayList
  $style = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
  foreach ($line in ([string]$Text -split "`r?`n")) {
    if ($line -match '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \[([A-Za-z_]+)\] ') {
      $at = [datetime]::MinValue
      if ([datetime]::TryParse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture, $style, [ref]$at) -and $at -ge $SinceUtc) { [void]$events.Add($Matches[2]) }
    }
  }
  return ,$events
}

# The last bytes of a log, opened so that the watcher can keep writing to it.
function Read-LogTail([string]$Path, [int]$MaxBytes = 65536) {
  $stream = $null
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $take = [int][Math]::Min([long]$MaxBytes, $stream.Length)
    [void]$stream.Seek(-$take, [System.IO.SeekOrigin]::End)
    $buffer = New-Object byte[] $take
    $read = 0
    while ($read -lt $take) { $n = $stream.Read($buffer, $read, $take - $read); if ($n -le 0) { break }; $read += $n }
    return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  } catch { return "" } finally { if ($null -ne $stream) { $stream.Dispose() } }
}

Write-Host "GSO Print Intake - local token update. No token is ever shown by this script."
Write-Host ""

$targets = New-Object System.Collections.ArrayList
foreach ($path in $ConfigPath) {
  if (-not (Test-IsRuntimeConfig $path)) { Write-Host ("REFUSED (not one of the two runtime configs): " + $path); continue }
  $state = Get-ConfigTokenState $path
  switch ($state.state) {
    "missing"               { Write-Host ("SKIP (file not found)                : " + $path) }
    "not_json"              { Write-Host ("SKIP (not valid JSON - fix by hand)  : " + $path) }
    "no_single_token_field" { Write-Host ("SKIP (no single UploadToken value)   : " + $path) }
    default {
      Write-Host ("FOUND UploadToken (set, " + $state.current.Length + " chars)      : " + $path)
      [void]$targets.Add($state)
    }
  }
}
if ($targets.Count -eq 0) { Write-Host ""; Write-Host "No config file to update. Nothing was changed."; exit 1 }

if ($WhatIfPreference) {
  Write-Host ""
  Write-Host ("PREVIEW ONLY: " + $targets.Count + " file(s) above would be backed up and get the new token. Nothing was asked, nothing was changed.")
  if ($RestartWatcher) { Write-Host ("PREVIEW ONLY: the task '" + $WatcherTaskName + "' would then be stopped and started (it was NOT touched).") }
  exit 0
}

Write-Host ""
Write-Host "Paste the NEW token from the ERP (Print Log Settings -> Rotate token). Input is hidden."
$first = ConvertTo-PlainText (Read-Host -AsSecureString "New upload token")
$second = ConvertTo-PlainText (Read-Host -AsSecureString "New upload token (again)")
$newToken = ([string]$first).Trim()
if ($newToken -cne ([string]$second).Trim()) { $first = $null; $second = $null; $newToken = $null; Write-Host "The two entries are not the same. Nothing was changed."; exit 1 }
$first = $null; $second = $null
if ([string]::IsNullOrWhiteSpace($newToken)) { Write-Host "No token entered. Nothing was changed."; exit 1 }
if (-not $AllowAnyFormat -and $newToken -cnotmatch $TokenPattern) {
  Write-Host ("That does not look like an ERP upload token (expected gso_plog_ followed by 48 hex characters; got " + $newToken.Length + " characters). Nothing was changed.")
  Write-Host "Copy the whole token from the ERP and run this again."
  $newToken = $null
  exit 1
}
if ($newToken -match '["\\]') { $newToken = $null; Write-Host "The token contains a quote or a backslash and cannot be written safely. Nothing was changed."; exit 1 }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$updated = 0; $unchanged = 0; $failed = 0
$backups = New-Object System.Collections.ArrayList
foreach ($target in $targets) {
  $path = [string]$target.path
  if ($target.current -ceq $newToken) { Write-Host ("ALREADY HAS THIS TOKEN (not touched)   : " + $path); $unchanged++; continue }
  $backup = Join-Path (Split-Path -Parent $path) ([System.IO.Path]::GetFileNameWithoutExtension($path) + ".before-token-rotation-" + $stamp + ".json")
  try {
    # 1. backup, verified byte for byte, before the config is touched
    Copy-Item -LiteralPath $path -Destination $backup -Confirm:$false
    if ((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash) { throw "the backup copy does not match the original" }
    # 2. swap only the token value
    $newText = [regex]::Replace($target.text, $TokenFieldPattern, { param($m) $m.Groups[1].Value + $newToken + $m.Groups[3].Value })
    [System.IO.File]::WriteAllText($path, $newText, (New-Object System.Text.UTF8Encoding([bool]$target.hasBom)))
    # 3. read back and check
    $after = Get-ConfigTokenState $path
    if ($after.state -ne "ok") { throw "the file did not read back as a config with one UploadToken" }
    if ($after.current -cne $newToken) { throw "the file does not hold the new token after writing" }
    if ((Get-TextWithoutToken $after.text) -cne (Get-TextWithoutToken $target.text)) { throw "something other than the token changed" }
    Write-Host ("UPDATED UploadToken (set, " + $after.current.Length + " chars)    : " + $path)
    Write-Host ("  backup : " + $backup)
    [void]$backups.Add($backup)
    Write-Host ("  undo   : Copy-Item -LiteralPath `"" + $backup + "`" -Destination `"" + $path + "`" -Force")
    $updated++
  } catch {
    $failed++
    Write-Host ("FAILED                                 : " + $path)
    Write-Host ("  reason : " + $_.Exception.Message)
    if (Test-Path -LiteralPath $backup) {
      try { Copy-Item -LiteralPath $backup -Destination $path -Force -Confirm:$false; Write-Host "  the file was put back from its backup - it holds the previous token." } catch { Write-Host ("  COULD NOT RESTORE - copy this file back by hand: " + $backup) }
    } else {
      Write-Host "  the file was not touched."
    }
  }
}
$newToken = $null
if ($ClearClipboard) { try { Set-Clipboard -Value " "; Write-Host "Clipboard emptied." } catch { Write-Host "Clipboard could not be emptied - copy any other text to overwrite it." } }

Write-Host ""
Write-Host ("Done: " + $updated + " updated, " + $unchanged + " already current, " + $failed + " failed.")

$restartLines = @("Stop-ScheduledTask  -TaskName `"$WatcherTaskName`"", "Start-ScheduledTask -TaskName `"$WatcherTaskName`"")
$restartOk = $false
if ($RestartWatcher) {
  # Only the EXISTING scheduled task is stopped and started. The watcher script is never
  # launched from here, so there can be no second watcher.
  if ($failed -gt 0) {
    Write-Host "NOT restarting the watcher: a config file failed above. Fix that first."
  } elseif ($null -eq (Get-ScheduledTask -TaskName $WatcherTaskName -ErrorAction SilentlyContinue)) {
    Write-Host ("NOT restarting: the scheduled task '" + $WatcherTaskName + "' was not found.")
  } else {
    $restartAtUtc = (Get-Date).ToUniversalTime().AddSeconds(-1)
    try {
      Stop-ScheduledTask -TaskName $WatcherTaskName -ErrorAction Stop
      for ($wait = 0; $wait -lt 15; $wait++) { if ([string](Get-ScheduledTask -TaskName $WatcherTaskName).State -ne "Running") { break }; Start-Sleep -Seconds 2 }
      if ([string](Get-ScheduledTask -TaskName $WatcherTaskName).State -eq "Running") { throw "the task is still running 30 s after Stop-ScheduledTask" }
      Start-ScheduledTask -TaskName $WatcherTaskName -ErrorAction Stop
      Write-Host ("Watcher task stopped and started. Waiting up to " + $RestartWaitSeconds + " s for a fresh log line...")
      # where the watcher logs: the NAS log folder from its config, and the local log beside it
      $logFolder = ""
      try {
        $found = [regex]::Match([System.IO.File]::ReadAllText($WatcherConfig), '"LogFolder"\s*:\s*("(?:[^"\\]|\\.)*")')
        if ($found.Success) { $logFolder = [string]($found.Groups[1].Value | ConvertFrom-Json) }
      } catch { $logFolder = "" }
      $day = Get-Date -Format "yyyyMMdd"
      $logFiles = @((Join-Path (Split-Path -Parent $WatcherConfig) ("gso-print-intake-local-" + $day + ".log")))
      if ($logFolder) { $logFiles += (Join-Path $logFolder ("gso-print-intake-" + $day + ".log")) }
      $deadline = (Get-Date).AddSeconds($RestartWaitSeconds)
      $seen = @()
      $startedSeenAt = $null
      while ((Get-Date) -lt $deadline) {
        $seen = @(); foreach ($logFile in $logFiles) { $seen += @(Get-LogEventsSince (Read-LogTail $logFile) $restartAtUtc | ForEach-Object { $_ }) }
        if ($seen -contains "agent_stopped" -or $seen -contains "config_error" -or $seen -contains "refused_no_cutoff" -or $seen -contains "duplicate_instance") { break }
        # after agent_started the first pass checks the token within seconds: give it 20 s to object
        if ($seen -contains "agent_started") { if ($null -eq $startedSeenAt) { $startedSeenAt = Get-Date } elseif (((Get-Date) - $startedSeenAt).TotalSeconds -ge 20) { break } }
        Start-Sleep -Seconds 5
      }
      $state = [string](Get-ScheduledTask -TaskName $WatcherTaskName).State
      if ($seen -contains "agent_stopped" -or $seen -contains "config_error") {
        Write-Host "THE WATCHER STARTED AND STOPPED AGAIN (its log says agent_stopped / config_error): the ERP did not accept the token in the config, or the config did not load. Repeat the rotation (runbook, 'If something goes wrong')."
      } elseif ($seen -contains "agent_started" -and $state -eq "Running") {
        Write-Host ("Fresh log line: [agent_started], no [agent_stopped] after it; task state: " + $state + ". The watcher runs with the new token.")
        $restartOk = $true
      } else {
        Write-Host ("No fresh [agent_started] line was seen within " + $RestartWaitSeconds + " s (task state: " + $state + "; events since the restart: " + $(if ($seen.Count) { ($seen | Select-Object -Unique) -join ", " } else { "none" }) + "). Check the log by hand before going on.")
      }
    } catch {
      Write-Host ("Could not restart the watcher task: " + $_.Exception.Message)
      Write-Host "Run these two lines in an ELEVATED PowerShell now:"
      foreach ($line in $restartLines) { Write-Host ("  " + $line) }
    }
  }
} else {
  Write-Host "Nothing was restarted. The running watcher still uses the token it loaded at start."
  Write-Host "Restart it now, in an ELEVATED PowerShell (or run this script with -RestartWatcher next time):"
  foreach ($line in $restartLines) { Write-Host ("  " + $line) }
}

Write-Host ""
Write-Host "VERIFY (docs/GSO_PRINT_INTAKE_RUNTIME.md, Token rotation, steps 5-8):"
Write-Host "  1. The new token is accepted (writes nothing; expected: 'token accepted: OK'):"
Write-Host ("       powershell -NoProfile -ExecutionPolicy Bypass -File `"" + (Join-Path (Split-Path -Parent $WatcherConfig) "gso-print-intake-agent.ps1") + "`" -ConfigPath `"" + $WatcherConfig + "`" -Health")
Write-Host "  2. ERP -> Incoming Print Files: the banner is GREEN and says the watcher checked in a few minutes ago at most."
Write-Host "  3. The OLD token is rejected (prints a status code only; expected: 'old token -> HTTP 403'):"
$oldBackup = if ($backups.Count -gt 0) { [string]$backups[0] } else { "<a ...before-token-rotation-<stamp>.json backup of the watcher config>" }
Write-Host ("       `$old = (Get-Content -LiteralPath `"" + $oldBackup + "`" -Raw | ConvertFrom-Json).UploadToken")
Write-Host ("       `$api = (Get-Content -LiteralPath `"" + $WatcherConfig + "`" -Raw | ConvertFrom-Json).ApiBaseUrl")
Write-Host "       try { Invoke-WebRequest -Uri (`$api.TrimEnd('/') + '/api/print-intake/route-plan') -Method POST -ContentType 'application/json' -Body (@{ token = `$old } | ConvertTo-Json) -UseBasicParsing | Out-Null; 'UNEXPECTED: the old token was accepted' } catch { 'old token -> HTTP ' + [int]`$_.Exception.Response.StatusCode }"
Write-Host "       `$old = `$null"
Write-Host "  4. When 1-3 are good, delete the backup file(s) listed above: they hold the OLD token."
if ($failed -gt 0) { exit 1 }
if ($RestartWatcher -and -not $restartOk) { exit 1 }
exit 0
