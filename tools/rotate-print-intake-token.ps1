# GSO Print Intake - put a NEW upload token into the local agent configs on this PC.
#
# This is the LOCAL half of a token rotation. The new token is created in the ERP
# (Print Log Settings -> Rotate token, owner only) and shown there exactly once.
# Full runbook: docs/GSO_PRINT_INTAKE_RUNTIME.md, "Token rotation".
#
# Preview (reads the files, asks for nothing, changes nothing):
#   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\rotate-print-intake-token.ps1" -WhatIf
# Apply (normal PowerShell window - no "Run as administrator" needed):
#   powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\rotate-print-intake-token.ps1"
#
# What it does:
#   - asks for the new token TWICE with hidden input (nothing typed or pasted is shown)
#   - for every config file in -ConfigPath that exists and has an "UploadToken" value:
#       1. copies the file beside itself as  <name>.before-token-rotation-<yyyyMMdd-HHmmss>.json
#       2. replaces ONLY the UploadToken value (every other character of the file is kept)
#       3. reads the file back and checks it is valid JSON, holds the new token, and
#          that nothing else changed
#   - prints key names and lengths only - never a token, old or new
#
# What it does NOT do:
#   - it does not talk to the ERP, and it does not create or check a token
#   - it does not start, stop or restart any watcher or scheduled task. The running
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
  [switch]$ClearClipboard
)

$ErrorActionPreference = "Stop"
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

Write-Host "GSO Print Intake - local token update. No token is ever shown by this script."
Write-Host ""

$targets = New-Object System.Collections.ArrayList
foreach ($path in $ConfigPath) {
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
Write-Host "Nothing was restarted. The running watcher still uses the token it loaded at start:"
Write-Host "restart it now (docs/GSO_PRINT_INTAKE_RUNTIME.md, Token rotation, step 5)."
if ($failed -gt 0) { exit 1 } else { exit 0 }
