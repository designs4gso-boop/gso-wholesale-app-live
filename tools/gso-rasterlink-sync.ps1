# GSO RasterLink result sync (Patch 13A.6B).
# Watches the RasterLink incoming NAS folder, uploads new result CSVs to the
# token-authenticated ERP endpoint (/api/rip-imports/upload), and moves each
# file to processed/error with structured logging, bounded retries, claim-file
# locking, and error sidecars. PowerShell 5.1 compatible.
#
# Modes:
#   (default)   poll loop every PollSeconds
#   -Once       single pass then exit
#   -DryRun     detect + report only; no uploads, no moves
#   -Health     config/folders/endpoint/token checks; creates NO imports
#   -SelfTest   offline unit checks (no config, no network)
#   -OnlyFile   process ONLY the named result file(s) (exact names) - for a
#               controlled first verification; every other file is left alone.
#               It narrows the eligible results; it never makes one eligible.
#   -ActivationUtc <ISO-8601 UTC>   one-shot activation for -Once / -DryRun only
#               (the manual validation before the task exists). Refused in the
#               poll loop: the loop only ever uses the config's ActivationUtc.
#
# Exit codes: 0 finished | 1 config could not be loaded / unsafe incoming folder
# (see the local log beside this script) | 2 upload token rejected by the ERP |
# 4 no activation timestamp (nothing is processed) | 6 another poll loop for the
# same incoming folder is already running on this PC.
#
# v1.4 (2026-11-20):
#   * ACTIVATION. The config key ActivationUtc (written by the registration
#     script at the moment the task is registered) is mandatory. A result whose
#     own time - file write time, the time stamp in its name, and the latest
#     RIP / print / cut end time inside it, every one the script can read - is
#     older than the activation is ignored for good: never uploaded, never
#     moved, counted as ignored_before_activation. No activation = exit 4.
#   * PRE-FILTER. A result is uploaded only when it is a RasterLink result
#     (..._print.csv / ..._cut.csv with KEY_FILENAME rows), is post-activation,
#     and at least one job name in it carries an ERP item ticket
#     GSO-YYYYMMDD-NNNN-NN (hyphens, any case - the form the server's
#     parseRipTickets accepts). Everything else stays where it is, is counted
#     (ignored_no_ticket, ignored_ambiguous, ignored_unsupported_format) and is
#     listed once in the log for a person. Nothing is guessed.
#   * The loop survives. Logging retries, then falls back to a local file, and
#     never throws. Nothing thrown in one pass ends the loop; one failed result
#     does not stop the next one. A token the ERP rejects still stops it (exit 2).
#   * A server outage no longer strands results: a result the server did not
#     answer (network error, 5xx, 429) stays in the incoming folder and is
#     retried on the next pass. A result is moved only after the server answered:
#     accepted -> processed, refused (4xx) -> error + sidecar. Results an older
#     version moved to the error folder during an outage are retried from there.
#   * One pass_summary line (when the counts change) with every counter and
#     state=ok / state=ERROR.
#
# Patch F (2026-11-18):
#   * RasterLink writes results into a per-printer subfolder
#     (...\rasterlink\incoming\UCJV-300). IncomingFolder must point AT that
#     subfolder. Only files directly inside it are read - never subfolders, and
#     never the historical backlog in ...\incoming\GSOP.
#   * Composite CMYK + clear jobs carry NO ink in the result CSV. When
#     JobsFolder is configured (C:\MijCtrl\Jobs\1), the JobInfo.ini of the
#     EXACT RasterLink job (same file name + same RIP start/end stamps, folder
#     name = JobID) is uploaded as a read-only companion. JobInfo.ini is only
#     ever READ. The server links it by exact identity or ignores it.
#   * "_cut.csv" results are uploaded before "_print.csv" results, because the
#     arranged copy count of a composite is on the cut result.
param(
  [switch]$Once,
  [switch]$DryRun,
  [switch]$Health,
  [switch]$SelfTest,
  [string[]]$OnlyFile = @(),
  [string]$ActivationUtc = "",
  [string]$ConfigPath = (Join-Path $PSScriptRoot "gso-rasterlink-sync-config.json")
)

$ScriptVersion = "gso-rasterlink-sync/1.4 (activation cutoff + ticket pre-filter + crash-safe logging + pass guard + outage-safe retry; Patch F jobinfo companion + NotBeforeUtc)"
$ErrorActionPreference = "Stop"

# v1.4 process memory (never persisted, never sent anywhere).
$script:LocalLogFolders = @($PSScriptRoot, $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "GSO-RIP-Result-Sync" } else { "" }), $env:TEMP)
$script:NasLogDownUntil = [datetime]::MinValue   # after a failed NAS log write, go straight to the local log for a minute
$script:LogFallbackCount = 0                     # log lines that could not be written to the NAS log
$script:StabilityRecheckSeconds = 2
$script:ListedIgnored = @{}                      # ignored results already listed in the log (once per run)
$script:UnreleasedClaims = @{}                   # claim files that could not be removed (NAS dropped)
$script:ServerDownStreak = 0                     # consecutive passes that ended with the server not answering
$script:JobInfoTransient = $false
$script:JobInfoFailed = 0
$script:LastPassSummary = ""
$script:LastPassError = ""
$script:PassErrorRepeats = 0

# ---------- config ----------

# ISO-8601 UTC instant -> [DateTime] (Utc kind). Empty -> $null. Unreadable -> throws.
function ConvertTo-SyncUtcInstant([string]$Value, [string]$KeyName) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $parsed = [datetime]::MinValue
  $style = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
  if (-not [datetime]::TryParse($Value, [System.Globalization.CultureInfo]::InvariantCulture, $style, [ref]$parsed)) {
    throw "Config $KeyName is not a valid ISO-8601 UTC timestamp (expected e.g. 2026-11-21T17:20:00Z)"
  }
  return $parsed
}

function Read-SyncConfig([string]$Path) {
  # 15H.2-K: both filename conventions exist in the wild - the docs say
  # "gso-rasterlink-sync-config.json" (dash) while the live machines use
  # "gso-rasterlink-sync.config.json" (dot). Accept whichever exists so the
  # watcher never silently fails to start over a naming mismatch.
  if (!(Test-Path $Path)) {
    $alternate = if ($Path -match "-config\.json$") { $Path -replace "-config\.json$", ".config.json" } else { $Path -replace "\.config\.json$", "-config.json" }
    if ($alternate -and (Test-Path $alternate)) { $Path = $alternate }
  }
  if (!(Test-Path $Path)) { throw "Config not found: $Path (also tried the -config.json/.config.json alternate). Copy gso-rasterlink-sync-config.example.json, fill in the token from /app/erp/print-intake, and save next to this script." }
  $raw = Get-Content $Path -Raw | ConvertFrom-Json
  $config = @{
    ApiBaseUrl        = [string]$raw.ApiBaseUrl
    UploadToken       = [string]$raw.UploadToken
    IncomingFolder    = [string]$raw.IncomingFolder
    ProcessedFolder   = [string]$raw.ProcessedFolder
    ErrorFolder       = [string]$raw.ErrorFolder
    LogFolder         = [string]$raw.LogFolder
    JobsFolder        = if ($raw.JobsFolder) { [string]$raw.JobsFolder } else { "" }
    # v1.3: go-live cutoff. Result files last written BEFORE this UTC instant are never
    # uploaded or moved (they stay where they are). Empty = no cutoff.
    NotBeforeUtc      = if ($raw.NotBeforeUtc) { [string]$raw.NotBeforeUtc } else { "" }
    # v1.4: ACTIVATION (mandatory). Written by the registration script. Results
    # older than this are ignored for good. Empty = the sync refuses to process.
    ActivationUtc     = if ($raw.ActivationUtc -is [datetime]) { $raw.ActivationUtc.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") } elseif ($raw.ActivationUtc) { [string]$raw.ActivationUtc } else { "" }   # PowerShell 7 parses an ISO date in JSON into a DateTime
    Source            = if ($raw.Source) { [string]$raw.Source } else { "rasterlink" }
    PollSeconds       = if ($raw.PollSeconds) { [int]$raw.PollSeconds } else { 30 }
    StableFileSeconds = if ($raw.StableFileSeconds) { [int]$raw.StableFileSeconds } else { 20 }
    MaxRetries        = if ($raw.MaxRetries) { [int]$raw.MaxRetries } else { 4 }
    RetryDelaySeconds = if ($raw.RetryDelaySeconds) { [int]$raw.RetryDelaySeconds } else { 10 }
    # 15H.2-K: the Roland example config shipped with a "ClaimsStaleMinutes"
    # spelling - accept both so a copied config never silently falls back.
    ClaimStaleMinutes = if ($raw.ClaimStaleMinutes) { [int]$raw.ClaimStaleMinutes } elseif ($raw.ClaimsStaleMinutes) { [int]$raw.ClaimsStaleMinutes } else { 30 }
  }
  foreach ($key in @("ApiBaseUrl","UploadToken","IncomingFolder","ProcessedFolder","ErrorFolder","LogFolder")) {
    if ([string]::IsNullOrWhiteSpace($config[$key])) { throw "Config missing required value: $key" }
  }
  $config.UploadUrl = ($config.ApiBaseUrl.TrimEnd('/')) + "/api/rip-imports/upload"
  # An unreadable activation must fail loudly here, never be treated as "none".
  $config.ActivationInstant = ConvertTo-SyncUtcInstant $config.ActivationUtc "ActivationUtc"
  return $config
}

# Never any part of the token: only whether it is set and how long it is.
function Get-MaskedToken([string]$Token) {
  if ([string]::IsNullOrWhiteSpace($Token)) { return "(not set)" }
  return "(set, $($Token.Length) chars)"
}

# What may be written about a config that would not load. The script's own
# messages (they name a path or a key, never a value) pass through; anything
# else - a JSON parser error can quote a piece of the file, and the file holds
# the token - is reduced to its exception type.
function Get-SyncConfigErrorText([string]$Message, [string]$TypeName) {
  if ($Message -match '^Config (not found|missing required value)' -or $Message -match '^Config \w+ is not a valid ISO-8601') { return $Message }
  return "the config file could not be read as JSON ($TypeName)"
}

# ---------- logging (never logs the token; never throws) ----------

# One line into the first local folder that takes it: beside the script, then
# the user's LocalAppData, then TEMP. Returns $false when none could be written.
function Write-SyncLocalLine([string]$Line) {
  foreach ($folder in @($script:LocalLogFolders)) {
    if ([string]::IsNullOrWhiteSpace($folder)) { continue }
    try {
      if (!(Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
      Add-Content -LiteralPath (Join-Path $folder ("gso-rasterlink-sync-local-" + (Get-Date -Format "yyyyMMdd") + ".log")) -Value $Line -ErrorAction Stop
      return $true
    } catch { }
  }
  return $false
}

# v1.4: one failed write to the NAS log used to end the whole loop (the failure
# that stopped the Print Intake Agent on 2026-11-19). Logging now retries, then
# falls back to a local file, and never throws - not even when the console is gone.
function Write-SyncLog($Config, [string]$EventName, [string]$File, [string]$Detail) {
  try {
    $line = "{0} [{1}] file={2} {3}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $EventName, $File, $Detail
    try { Write-Host $line } catch { }
    $written = $false
    if ($Config -and $Config.LogFolder -and ((Get-Date) -ge $script:NasLogDownUntil)) {
      for ($logTry = 1; $logTry -le 3; $logTry++) {
        try {
          if (!(Test-Path -LiteralPath $Config.LogFolder)) { New-Item -ItemType Directory -Path $Config.LogFolder -Force | Out-Null }
          $logPath = Join-Path $Config.LogFolder ("gso-rasterlink-sync-" + (Get-Date -Format "yyyyMMdd") + ".log")
          Add-Content -LiteralPath $logPath -Value $line -ErrorAction Stop
          $written = $true
          break
        } catch { Start-Sleep -Milliseconds 400 }
      }
      if (-not $written) { $script:NasLogDownUntil = (Get-Date).AddSeconds(60) }
    }
    if (-not $written) {
      if ($Config -and $Config.LogFolder) { $script:LogFallbackCount++ }
      [void](Write-SyncLocalLine $line)
    }
  } catch { }
}

# One line in the LOCAL log only, for the moment before a config exists.
function Write-SyncLocalLog([string]$EventName, [string]$Detail) {
  try {
    $line = "{0} [{1}] file=- {2}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $EventName, $Detail
    try { Write-Host $line } catch { }
    [void](Write-SyncLocalLine $line)
  } catch { }
}

# ---------- single instance (one poll loop per incoming folder per PC) ----------

function Get-SyncInstanceName([string]$IncomingFolder) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(([string]$IncomingFolder).TrimEnd('\').ToLowerInvariant()))
    return "Global\GsoRasterlinkSyncLoop-" + ([System.BitConverter]::ToString($bytes, 0, 8) -replace '-', '')
  } finally { $sha.Dispose() }
}

# state = acquired | held | unavailable (the lock itself failed; the loop then runs without it).
function Enter-SyncSingleInstance {
  param([string]$Name)
  try {
    $mutex = New-Object System.Threading.Mutex($false, $Name)
    $got = $false
    try { $got = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
    if ($got) { return @{ state = "acquired"; mutex = $mutex } }
    $mutex.Dispose()
    return @{ state = "held"; mutex = $null }
  } catch [System.UnauthorizedAccessException] {
    return @{ state = "held"; mutex = $null }
  } catch {
    return @{ state = "unavailable"; mutex = $null }
  }
}

# ---------- claim-file locking ----------

function Get-ClaimPath([string]$FilePath) { return "$FilePath.gsoclaim" }

# A claim written by THIS PC for a process that no longer exists is orphaned:
# nobody is working on that file, so it is reclaimed now instead of after
# ClaimStaleMinutes. A claim from another PC or from a live process is not touched.
function Test-ClaimOrphaned([string]$ClaimText) {
  if ([string]$ClaimText -notmatch '^(\S+) pid=(\d+) at=') { return $false }
  $claimHost = $Matches[1]; $claimPid = [int]$Matches[2]
  if ($claimHost -ne $env:COMPUTERNAME) { return $false }
  if ($claimPid -eq $PID) { return $false }
  return ($null -eq (Get-Process -Id $claimPid -ErrorAction SilentlyContinue))
}

function New-FileClaim([string]$FilePath, [int]$ClaimStaleMinutes) {
  $claimPath = Get-ClaimPath $FilePath
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      $stream = [System.IO.File]::Open($claimPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("$env:COMPUTERNAME pid=$PID at=$((Get-Date).ToUniversalTime().ToString('o'))")
      $stream.Write($bytes, 0, $bytes.Length); $stream.Close()
      return $true
    } catch {
      try {
        if (Test-Path -LiteralPath $claimPath) {
          $age = (Get-Date) - (Get-Item -LiteralPath $claimPath).LastWriteTime
          if ($age.TotalMinutes -gt $ClaimStaleMinutes) { Remove-Item -LiteralPath $claimPath -Force -Confirm:$false; continue } # stale claim from a crashed run
          $claimText = ""
          try { $claimText = [System.IO.File]::ReadAllText($claimPath) } catch { $claimText = "" }
          if (Test-ClaimOrphaned $claimText) { Remove-Item -LiteralPath $claimPath -Force -Confirm:$false; continue }
        }
      } catch { }
      return $false
    }
  }
  return $false
}

function Remove-FileClaim([string]$FilePath) {
  $claimPath = Get-ClaimPath $FilePath
  if (Test-Path -LiteralPath $claimPath) { Remove-Item -LiteralPath $claimPath -Force -Confirm:$false }
}

# Remove claim files whose release failed on an earlier pass.
function Clear-UnreleasedClaims {
  foreach ($claimOwner in @($script:UnreleasedClaims.Keys)) {
    try { Remove-FileClaim $claimOwner; $script:UnreleasedClaims.Remove($claimOwner) } catch { }
  }
}

# ---------- stability ----------

function Test-FileStable($Config, $File) {
  $item = Get-Item -LiteralPath $File.FullName
  $ageSeconds = ((Get-Date) - $item.LastWriteTime).TotalSeconds
  if ($ageSeconds -lt $Config.StableFileSeconds) { return $false }
  $sizeBefore = $item.Length
  Start-Sleep -Seconds $script:StabilityRecheckSeconds
  $after = Get-Item -LiteralPath $File.FullName
  return ($after.Length -eq $sizeBefore -and $after.LastWriteTime -eq $item.LastWriteTime)
}

# ---------- upload (PowerShell 5.1-safe multipart, hand-built bytes) ----------

# 13A.6B.1: Windows PowerShell 5.1 runs on .NET Framework, whose
# MultipartFormDataContent writes Content-Disposition names WITHOUT quotes
# (name=token) and a QUOTED boundary in the Content-Type header. Node/Undici
# Request.formData() (what the Render server runs) rejects that body with
# "TypeError: Failed to parse body as FormData" -> HTTP 500 on every upload.
# This builder emits the standards-compliant form Undici requires: quoted
# name="..."/filename="...", unquoted boundary, CRLF line endings, a blank
# CRLF between part headers and content, exact file bytes, and a final
# --boundary-- terminator. Verified offline against Undici's parser.
function New-GsoMultipartBody([string]$Boundary, [System.Collections.IDictionary]$Fields, [string]$FileFieldName, [string]$FileName, [byte[]]$FileBytes, [string]$FileContentType) {
  $crlf = "`r`n"
  $enc = New-Object System.Text.UTF8Encoding($false)
  $stream = New-Object System.IO.MemoryStream
  foreach ($key in $Fields.Keys) {
    $part = "--$Boundary$crlf" + "Content-Disposition: form-data; name=`"$key`"$crlf$crlf" + [string]$Fields[$key] + $crlf
    $partBytes = $enc.GetBytes($part)
    $stream.Write($partBytes, 0, $partBytes.Length)
  }
  if ($null -ne $FileBytes) {
    $safeName = $FileName -replace '"', '_'
    $head = "--$Boundary$crlf" + "Content-Disposition: form-data; name=`"$FileFieldName`"; filename=`"$safeName`"$crlf" + "Content-Type: $FileContentType$crlf$crlf"
    $headBytes = $enc.GetBytes($head)
    $stream.Write($headBytes, 0, $headBytes.Length)
    $stream.Write($FileBytes, 0, $FileBytes.Length)
    $tailBytes = $enc.GetBytes($crlf)
    $stream.Write($tailBytes, 0, $tailBytes.Length)
  }
  $endBytes = $enc.GetBytes("--$Boundary--$crlf")
  $stream.Write($endBytes, 0, $endBytes.Length)
  $result = $stream.ToArray()
  $stream.Dispose()
  return ,$result
}

function Get-SafeBodySnippet([string]$Body) {
  if ([string]::IsNullOrWhiteSpace($Body)) { return "(empty)" }
  $flat = $Body -replace "[`r`n]+", " "
  return $flat.Substring(0, [Math]::Min(180, $flat.Length))
}

function Invoke-RipUpload($Config, [string]$FilePath, [string]$FileName, [System.Collections.IDictionary]$ExtraFields = $null) {
  $client = $null
  try {
    Add-Type -AssemblyName System.Net.Http | Out-Null
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(120)
    $boundary = "gso-" + [guid]::NewGuid().ToString("N")
    $fileBytes = [System.IO.File]::ReadAllBytes($FilePath)
    $fields = New-Object System.Collections.Specialized.OrderedDictionary
    $fields.Add("token", $Config.UploadToken)
    $fields.Add("source", $Config.Source)
    if ($null -ne $ExtraFields) { foreach ($extraKey in $ExtraFields.Keys) { $fields.Add($extraKey, [string]$ExtraFields[$extraKey]) } }
    $body = New-GsoMultipartBody $boundary $fields "file" $FileName $fileBytes "text/csv"
    $content = New-Object System.Net.Http.ByteArrayContent(,$body)
    $content.Headers.TryAddWithoutValidation("Content-Type", "multipart/form-data; boundary=$boundary") | Out-Null
    $response = $client.PostAsync($Config.UploadUrl, $content).GetAwaiter().GetResult()
    $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $json = $null
    try { $json = $responseBody | ConvertFrom-Json } catch { $json = $null }
    return @{ status = [int]$response.StatusCode; body = $responseBody; json = $json; exception = $null }
  } catch {
    return @{ status = 0; body = ""; json = $null; exception = $_.Exception.Message }
  } finally {
    if ($null -ne $client) { $client.Dispose() }
  }
}

function Test-DuplicateResponse($Json) {
  return ($null -ne $Json) -and ($Json.ok -eq $true) -and ($Json.PSObject.Properties.Name -contains "duplicateFile") -and ($Json.duplicateFile -eq $true)
}

function Test-SuccessResponse($Json) {
  return ($null -ne $Json) -and ($Json.ok -eq $true)
}

# The server ACCEPTED the upload: a 2xx answer whose JSON says ok.
function Test-UploadAccepted($Result) {
  return ($null -ne $Result) -and ($null -eq $Result.exception) -and ($Result.status -ge 200) -and ($Result.status -lt 300) -and (Test-SuccessResponse $Result.json)
}

# The ERP's OWN "token not accepted" answer (HTTP 401 / 403 with its JSON error
# naming the upload token) - not any 403 a proxy might return.
function Test-TokenRejected($Result) {
  if ($null -eq $Result) { return $false }
  if ($Result.status -ne 401 -and $Result.status -ne 403) { return $false }
  return ($null -ne $Result.json) -and ($Result.json.ok -eq $false) -and ([string]$Result.json.error -match 'upload token')
}

# The server REFUSED this upload for good: a 4xx that is not a token answer,
# not a timeout / rate limit, and not a bare proxy 401 / 403. Everything else
# that is not "accepted" is transient and is retried.
function Test-TerminalClientError($Result) {
  if ($null -eq $Result -or $null -ne $Result.exception) { return $false }
  if ($Result.status -lt 400 -or $Result.status -ge 500) { return $false }
  if ($Result.status -eq 401 -or $Result.status -eq 403 -or $Result.status -eq 408 -or $Result.status -eq 429) { return $false }
  return $true
}

# ---------- JobInfo.ini companion (READ-ONLY; Patch F) ----------

# Rows of a print result that have NO ink but a complete RIP window.
function Get-BlankInkResultRows([string]$CsvPath) {
  $found = New-Object System.Collections.ArrayList
  if ($CsvPath -notmatch '_print\.csv$') { return ,$found }
  $rows = @()
  try { $rows = @(Import-Csv -LiteralPath $CsvPath) } catch { return ,$found }
  foreach ($row in $rows) {
    $names = @($row.PSObject.Properties.Name)
    if ($names -notcontains "KEY_FILENAME" -or $names -notcontains "KEY_INKUSE") { continue }
    $name = [string]$row.KEY_FILENAME
    $ripStart = [string]$row.KEY_RIP_S_TIME
    $ripEnd = [string]$row.KEY_RIP_E_TIME
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if (-not [string]::IsNullOrWhiteSpace([string]$row.KEY_INKUSE)) { continue }
    if ($ripStart -notmatch '^\d{8}_\d{6}$' -or $ripEnd -notmatch '^\d{8}_\d{6}$') { continue }
    [void]$found.Add(@{ FileName = $name; RipStart = $ripStart; RipEnd = $ripEnd })
  }
  return ,$found
}

# The job folder(s) whose JobInfo.ini states EXACTLY this file name, this RIP
# start and this RIP end for its own JobID, and whose folder name IS that JobID.
# Exact text comparison only. Reads files; never writes into the jobs folder.
function Find-JobInfoFolders([string]$JobsFolder, $Row) {
  $matches = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($JobsFolder) -or !(Test-Path -LiteralPath $JobsFolder)) { return ,$matches }
  foreach ($dir in @(Get-ChildItem -LiteralPath $JobsFolder -Directory -ErrorAction SilentlyContinue)) {
    $ini = Join-Path $dir.FullName "JobInfo.ini"
    if (!(Test-Path -LiteralPath $ini)) { continue }
    $text = ""
    try { $text = [System.IO.File]::ReadAllText($ini) } catch { continue }
    $id = $dir.Name
    if (-not $text.Contains('JobID="' + $id + '"')) { continue }
    $hasName = $false
    foreach ($line in ($text -split "`r?`n")) { if ($line -ceq ('jobName="' + $Row.FileName + '"')) { $hasName = $true; break } }
    if (-not $hasName) { continue }
    if (-not $text.Contains('"' + $id + '";"KEY_RIP_S_TIME";"' + $Row.RipStart + '"')) { continue }
    if (-not $text.Contains('"' + $id + '";"KEY_RIP_E_TIME";"' + $Row.RipEnd + '"')) { continue }
    [void]$matches.Add(@{ JobId = $id; IniPath = $ini })
  }
  return ,$matches
}

# v1.4: a companion the server did not ANSWER (network error, 5xx, 429) sets
# $script:JobInfoTransient, and the result then stays in the incoming folder so
# the clear ink is retried on the next pass (the server answers the repeated
# result with duplicateFile and writes nothing twice). A companion the server
# refused is logged, counted, and does not hold the result back.
function Invoke-JobInfoCompanions($Config, $File) {
  if ([string]::IsNullOrWhiteSpace($Config.JobsFolder)) { return }
  $rows = Get-BlankInkResultRows $File.FullName
  foreach ($row in $rows) {
    $folders = Find-JobInfoFolders $Config.JobsFolder $row
    if ($folders.Count -ne 1) {
      Write-SyncLog $Config "jobinfo_not_linked" $File.Name "row=$($row.FileName) exactJobFolders=$($folders.Count) (ink stays blank; nothing guessed)"
      continue
    }
    $folder = $folders[0]
    $extra = New-Object System.Collections.Specialized.OrderedDictionary
    $extra.Add("jobFolder", $folder.JobId)
    $result = $null
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      $result = Invoke-RipUpload $Config $folder.IniPath "JobInfo.ini" $extra
      if ($result.exception -eq $null -and $result.status -ge 200 -and $result.status -lt 300) { break }
      if ((Test-TokenRejected $result) -or (Test-TerminalClientError $result)) { break }
      Start-Sleep -Seconds $Config.RetryDelaySeconds
    }
    if ($result.json -ne $null -and $result.json.ok -eq $true) {
      Write-SyncLog $Config "jobinfo_result" $File.Name "row=$($row.FileName) jobFolder=$($folder.JobId) outcome=$($result.json.outcome) reason=$($result.json.reason) cmykMl=$($result.json.cmykInkMl) clearMl=$($result.json.glossInkMl) updated=$($result.json.updated)"
    } else {
      $script:JobInfoFailed++
      $transient = -not ((Test-TerminalClientError $result) -or (Test-TokenRejected $result))
      if ($transient) { $script:JobInfoTransient = $true }
      Write-SyncLog $Config "jobinfo_upload_failed" $File.Name "row=$($row.FileName) jobFolder=$($folder.JobId) status=$($result.status) exception=$($result.exception) willRetry=$transient bodySnippet=$(Get-SafeBodySnippet $result.body)"
    }
  }
}

# v1.3: keep only result files last written at or after the configured UTC cutoff.
# An unreadable cutoff value keeps NOTHING (fail closed) rather than everything.
function Select-FilesAfterCutoff($Files, [string]$NotBeforeUtc) {
  $kept = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($NotBeforeUtc)) { foreach ($f in @($Files)) { [void]$kept.Add($f) }; return ,$kept }
  $cutoff = [datetime]::MinValue
  $style = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
  if (-not [datetime]::TryParse($NotBeforeUtc, [System.Globalization.CultureInfo]::InvariantCulture, $style, [ref]$cutoff)) { return ,$kept }
  foreach ($f in @($Files)) { if ($f.LastWriteTimeUtc -ge $cutoff) { [void]$kept.Add($f) } }
  return ,$kept
}

# Cut results first (the arranged count of a composite lives there), then by time.
function Get-ResultUploadOrder($Files) {
  return @($Files | Sort-Object @{ Expression = { if ($_.Name -match '_cut\.csv$') { 0 } else { 1 } } }, LastWriteTime, Name)
}

# ---------- moves + sidecars ----------

function Get-CollisionSafeDestination([string]$DestFolder, [string]$FileName, [string]$SourcePath) {
  $dest = Join-Path $DestFolder $FileName
  if (!(Test-Path -LiteralPath $dest)) { return $dest }
  # Deterministic suffix: first 8 hex chars of the file's content hash, so the
  # same content always maps to the same archived name.
  $sha8 = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash.Substring(0, 8).ToLowerInvariant()
  $base = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
  $ext = [System.IO.Path]::GetExtension($FileName)
  return Join-Path $DestFolder "$base-$sha8$ext"
}

function Move-ToFolder($Config, $File, [string]$DestFolder, [string]$LogEvent) {
  if (!(Test-Path -LiteralPath $DestFolder)) { New-Item -ItemType Directory -Path $DestFolder -Force | Out-Null }
  $dest = Get-CollisionSafeDestination $DestFolder $File.Name $File.FullName
  Move-Item -LiteralPath $File.FullName -Destination $dest -Force -Confirm:$false
  Write-SyncLog $Config $LogEvent $File.Name "dest=$dest"
  return $dest
}

function Get-ErrorSidecarPath($Config, [string]$FileName) {
  return (Join-Path $Config.ErrorFolder ($FileName + ".error.json"))
}

function Write-ErrorSidecar($Config, $File, [int]$RetryCount, $HttpStatus, [string]$ServerResponse, [string]$ExceptionMessage) {
  if (!(Test-Path -LiteralPath $Config.ErrorFolder)) { New-Item -ItemType Directory -Path $Config.ErrorFolder -Force | Out-Null }
  $sidecar = [ordered]@{
    originalFileName = $File.Name
    timestampUtc     = (Get-Date).ToUniversalTime().ToString("o")
    retryCount       = $RetryCount
    httpStatus       = $HttpStatus
    serverResponse   = if ($ServerResponse) { $ServerResponse.Substring(0, [Math]::Min(2000, $ServerResponse.Length)) } else { $null }
    exception        = $ExceptionMessage
    scriptVersion    = $ScriptVersion
  }
  $sidecarPath = Get-ErrorSidecarPath $Config $File.Name
  $sidecar | ConvertTo-Json | Set-Content -LiteralPath $sidecarPath
  return $sidecarPath
}

# ---------- v1.4: activation + pre-filter (pure; nothing here uploads or moves) ----------

# The exact item-ticket form the server lifts from a RIP name
# (app/lib/rip-identity-match.server.ts RIP_ITEM_TICKET_RE): hyphens only, any case.
$ItemTicketPattern = 'GSO-\d{8}-\d{4}-\d{2}(?!\d)'
# Text that looks like a ticket but is not that exact form (a job ticket without
# the item suffix, underscores or spaces instead of hyphens). The server would
# not resolve it as an item, so the sync does not guess either.
$TicketLikePattern = 'GSO[-_ ]?\d{8}[-_ ]?\d{4}'

function Get-ItemTickets([string]$Text) {
  $found = New-Object System.Collections.ArrayList
  foreach ($m in [regex]::Matches([string]$Text, $ItemTicketPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    $ticket = $m.Value.ToUpperInvariant()
    if (-not $found.Contains($ticket)) { [void]$found.Add($ticket) }
  }
  return ,$found
}

function Test-TicketLikeText([string]$Text) {
  return [regex]::IsMatch([string]$Text, $TicketLikePattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

# RasterLink stamps (yyyyMMdd_HHmmss) are the RIP PC's local time.
function ConvertFrom-RipStamp([string]$Stamp) {
  if ([string]$Stamp -notmatch '^\d{8}_\d{6}$') { return $null }
  $local = [datetime]::MinValue
  if (-not [datetime]::TryParseExact($Stamp, "yyyyMMdd_HHmmss", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeLocal, [ref]$local)) { return $null }
  return $local.ToUniversalTime()
}

# The time RasterLink put at the front of the result file name, as UTC ($null when there is none).
function Get-ResultNameStampUtc([string]$FileName) {
  if ([string]$FileName -notmatch '^(\d{8}_\d{6})_') { return $null }
  return (ConvertFrom-RipStamp $Matches[1])
}

# Reads one result file. readable = the file could be read at all (a NAS blip
# is not a verdict); supported = a RasterLink result with at least one named row.
function Read-ResultRows([string]$Path) {
  $out = @{ readable = $false; supported = $false; names = @(); latestEndUtc = $null }
  $text = ""
  try { $text = [System.IO.File]::ReadAllText($Path) } catch { return $out }
  $out.readable = $true
  $rows = @()
  try { $rows = @($text | ConvertFrom-Csv) } catch { return $out }
  $names = New-Object System.Collections.ArrayList
  $latest = $null
  foreach ($row in $rows) {
    if ($null -eq $row) { continue }
    $props = @($row.PSObject.Properties)
    if (@($props | ForEach-Object { $_.Name }) -notcontains "KEY_FILENAME") { continue }
    $name = [string]$row.KEY_FILENAME
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    [void]$names.Add($name)
    foreach ($prop in $props) {
      if ($prop.Name -notmatch '^KEY_[A-Z]+_E_TIME$') { continue }
      $endUtc = ConvertFrom-RipStamp ([string]$prop.Value)
      if ($null -ne $endUtc -and ($null -eq $latest -or $endUtc -gt $latest)) { $latest = $endUtc }
    }
  }
  $out.names = @($names)
  $out.latestEndUtc = $latest
  $out.supported = ($names.Count -gt 0)
  return $out
}

# The verdict for one result file. reason is one of:
#   eligible | ignored_before_activation | ignored_unsupported_format |
#   ignored_no_ticket | ignored_ambiguous | read_failed
# review = worth one line in the log for a person. Deterministic: the same file
# and the same activation always give the same verdict. Reads only.
function Get-ResultEligibility($File, $ActivationInstant) {
  $verdict = @{ eligible = $false; reason = ""; detail = ""; tickets = @(); review = $false; unticketedRows = 0 }
  if ($null -eq $ActivationInstant) { $verdict.reason = "ignored_before_activation"; $verdict.detail = "no activation timestamp"; return $verdict }
  if ($File.LastWriteTimeUtc -lt $ActivationInstant) { $verdict.reason = "ignored_before_activation"; $verdict.detail = "written before activation"; return $verdict }
  $nameStamp = Get-ResultNameStampUtc $File.Name
  if ($null -ne $nameStamp -and $nameStamp -lt $ActivationInstant) { $verdict.reason = "ignored_before_activation"; $verdict.detail = "name stamp before activation"; $verdict.review = $true; return $verdict }
  if ($File.Name -notmatch '_(print|cut)\.csv$') { $verdict.reason = "ignored_unsupported_format"; $verdict.detail = "not a ..._print.csv / ..._cut.csv result"; $verdict.review = $true; return $verdict }
  $content = Read-ResultRows $File.FullName
  if (-not $content.readable) { $verdict.reason = "read_failed"; $verdict.detail = "the file could not be read; retried next pass"; return $verdict }
  if (-not $content.supported) { $verdict.reason = "ignored_unsupported_format"; $verdict.detail = "no KEY_FILENAME rows"; $verdict.review = $true; return $verdict }
  if ($null -ne $content.latestEndUtc -and $content.latestEndUtc -lt $ActivationInstant) {
    $verdict.reason = "ignored_before_activation"; $verdict.detail = "written after activation, but its latest RIP / print / cut end time is before it"; $verdict.review = $true; return $verdict
  }
  # Identity: the job names INSIDE the result (the server resolves each row by
  # its own name; the result file is only a container named after its first job).
  $rowTickets = New-Object System.Collections.ArrayList
  $unticketed = 0
  $ticketLike = Test-TicketLikeText $File.Name
  foreach ($name in $content.names) {
    $inName = Get-ItemTickets $name
    if ($inName.Count -gt 1) { $verdict.reason = "ignored_ambiguous"; $verdict.detail = "one job name carries $($inName.Count) different item tickets"; $verdict.review = $true; return $verdict }
    if ($inName.Count -eq 1) { if (-not $rowTickets.Contains($inName[0])) { [void]$rowTickets.Add($inName[0]) } }
    else { $unticketed++; if (Test-TicketLikeText $name) { $ticketLike = $true } }
  }
  $fileTickets = Get-ItemTickets $File.Name
  if ($fileTickets.Count -gt 1) { $verdict.reason = "ignored_ambiguous"; $verdict.detail = "the result name carries $($fileTickets.Count) different item tickets"; $verdict.review = $true; return $verdict }
  if ($rowTickets.Count -eq 0) {
    $verdict.review = $true
    if ($fileTickets.Count -eq 1) { $verdict.reason = "ignored_ambiguous"; $verdict.detail = "the result name carries a ticket but no job name inside it does" }
    elseif ($ticketLike) { $verdict.reason = "ignored_ambiguous"; $verdict.detail = "ticket-like text, but no item ticket GSO-YYYYMMDD-NNNN-NN" }
    else { $verdict.reason = "ignored_no_ticket"; $verdict.detail = "no item ticket in any job name" }
    return $verdict
  }
  if ($fileTickets.Count -eq 1 -and -not $rowTickets.Contains($fileTickets[0])) { $verdict.reason = "ignored_ambiguous"; $verdict.detail = "the result name and the job names inside it carry different tickets"; $verdict.review = $true; return $verdict }
  $verdict.eligible = $true
  $verdict.reason = "eligible"
  $verdict.tickets = @($rowTickets)
  $verdict.unticketedRows = $unticketed
  return $verdict
}

# Results an OLDER version (or a refused upload) left in the error folder whose
# sidecar says the server never answered (no status, 5xx, 408, 429): an outage,
# not a verdict about the file. They are retried from where they are.
function Test-SidecarTransient($Sidecar) {
  if ($null -eq $Sidecar) { return $false }
  $status = 0
  if ($null -ne $Sidecar.httpStatus -and -not [int]::TryParse([string]$Sidecar.httpStatus, [ref]$status)) { return $false }
  return ($status -eq 0 -or $status -ge 500 -or $status -eq 408 -or $status -eq 429)
}

function Get-RetryableErrorFiles($Config) {
  $found = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrWhiteSpace($Config.ErrorFolder) -or !(Test-Path -LiteralPath $Config.ErrorFolder)) { return ,$found }
  foreach ($csv in @(Get-ChildItem -LiteralPath $Config.ErrorFolder -Filter *.csv -File -ErrorAction SilentlyContinue)) {
    $sidecarPath = Get-ErrorSidecarPath $Config $csv.Name
    if (!(Test-Path -LiteralPath $sidecarPath)) { continue }
    $sidecar = $null
    try { $sidecar = [System.IO.File]::ReadAllText($sidecarPath) | ConvertFrom-Json } catch { continue }
    if (Test-SidecarTransient $sidecar) { [void]$found.Add($csv) }
  }
  return ,$found
}

function Test-InErrorFolder($Config, $File) {
  if ([string]::IsNullOrWhiteSpace($Config.ErrorFolder)) { return $false }
  return ((Split-Path -Parent $File.FullName).TrimEnd('\') -ieq ([string]$Config.ErrorFolder).TrimEnd('\'))
}

# ---------- per-file processing ----------

# Returns: processed | move_pending | retry_later | error | fatal_config |
#          unstable | claimed_elsewhere
# A result leaves its folder ONLY after the server answered: accepted ->
# processed, refused (4xx) -> error + sidecar. No answer = it stays, retried.
function Invoke-ProcessFile($Config, $File) {
  if (!(New-FileClaim $File.FullName $Config.ClaimStaleMinutes)) {
    Write-SyncLog $Config "claim_skipped" $File.Name "another instance holds the claim"
    return "claimed_elsewhere"
  }
  $script:JobInfoTransient = $false
  try {
    if (!(Test-FileStable $Config $File)) {
      Write-SyncLog $Config "waiting_for_stability" $File.Name "younger than $($Config.StableFileSeconds)s or still changing; will retry next poll"
      return "unstable"
    }
    $inErrorFolder = Test-InErrorFolder $Config $File
    # While the server is known to be down, one probe per pass instead of a full retry ladder.
    $attempts = if ($script:ServerDownStreak -gt 0) { 1 } else { [Math]::Max(1, $Config.MaxRetries) }
    $result = $null
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
      Write-SyncLog $Config "upload_started" $File.Name "attempt=$attempt of $attempts"
      $result = Invoke-RipUpload $Config $File.FullName $File.Name

      if (Test-UploadAccepted $result) {
        if (Test-DuplicateResponse $result.json) {
          Write-SyncLog $Config "duplicate_accepted" $File.Name "server already has this content (importId=$($result.json.importId)); treating as success"
        } else {
          Write-SyncLog $Config "upload_succeeded" $File.Name ("rows=$($result.json.rows) created=$($result.json.created) dupRowsSkipped=$($result.json.skippedDuplicates) matched=$($result.json.matched) ambiguous=$($result.json.ambiguous)")
        }
        # Patch F: read-only JobInfo.ini companion for blank-ink composite rows.
        # Never fails the result itself.
        $script:JobInfoTransient = $false
        try { Invoke-JobInfoCompanions $Config $File } catch { $script:JobInfoFailed++; $script:JobInfoTransient = $true; Write-SyncLog $Config "jobinfo_error" $File.Name "exception=$($_.Exception.Message)" }
        if ($script:JobInfoTransient) {
          Write-SyncLog $Config "jobinfo_retry_later" $File.Name "the result is imported; its JobInfo.ini was not answered, so the result stays here and the ink is retried next pass (the server will not import the result twice)"
          return "retry_later"
        }
        try {
          Move-ToFolder $Config $File $Config.ProcessedFolder "moved_to_processed" | Out-Null
        } catch {
          Write-SyncLog $Config "move_failed_after_accept" $File.Name "the server HAS this result; the move to processed failed ($($_.Exception.Message)); retried next pass (the server answers a repeat with duplicateFile)"
          return "move_pending"
        }
        if ($inErrorFolder) {
          # the outage sidecar goes with it - nothing is deleted
          try {
            $sidecarPath = Get-ErrorSidecarPath $Config $File.Name
            if (Test-Path -LiteralPath $sidecarPath) { Move-Item -LiteralPath $sidecarPath -Destination (Get-CollisionSafeDestination $Config.ProcessedFolder ($File.Name + ".error.json") $sidecarPath) -Force -Confirm:$false }
          } catch { Write-SyncLog $Config "sidecar_move_failed" $File.Name "exception=$($_.Exception.Message)" }
        }
        return "processed"
      }

      if (Test-TokenRejected $result) {
        # Token/config problem: NEVER misfile good CSVs into error for this.
        Write-SyncLog $Config "fatal_config" $File.Name "HTTP $($result.status) token rejected - fix the config token; file left where it is"
        return "fatal_config"
      }
      if (Test-TerminalClientError $result) {
        $sidecar = Write-ErrorSidecar $Config $File $attempt $result.status $result.body $null
        if (-not $inErrorFolder) { Move-ToFolder $Config $File $Config.ErrorFolder "moved_to_error" | Out-Null }
        Write-SyncLog $Config "terminal_client_error" $File.Name "HTTP $($result.status) - the server refused this result; sidecar=$sidecar"
        return "error"
      }

      # Transient (network exception, 5xx, 408, 429, a proxy 401/403): stepped backoff then retry.
      if ($attempt -lt $attempts) {
        $delay = $Config.RetryDelaySeconds * $attempt
        Write-SyncLog $Config "retry_scheduled" $File.Name "attempt=$attempt status=$($result.status) exception=$($result.exception) bodySnippet=$(Get-SafeBodySnippet $result.body) delaySeconds=$delay"
        Start-Sleep -Seconds $delay
      }
    }
    # v1.4: the server did not answer. The result is NOT moved to the error
    # folder any more - it stays exactly where it is and is retried next pass.
    Write-SyncLog $Config "upload_deferred" $File.Name "SERVER NOT ANSWERING after $attempts attempt(s) (status=$($result.status) exception=$($result.exception)); file left where it is; retried next pass"
    return "retry_later"
  } finally {
    # A claim that cannot be released (NAS dropped mid-file) is retried at the start of the next pass.
    try { Remove-FileClaim $File.FullName } catch { $script:UnreleasedClaims[$File.FullName] = $true }
  }
}

# ---------- one pass ----------

function New-PassCounters {
  return [ordered]@{
    scanned = 0; eligible = 0; uploaded = 0; would_upload = 0
    ignored_before_cutoff = 0; ignored_before_activation = 0; ignored_no_ticket = 0; ignored_ambiguous = 0; ignored_unsupported_format = 0
    not_selected = 0; waiting = 0; retry_later = 0; rejected = 0; failed = 0; jobinfo_failed = 0; log_fallback = 0
  }
}

$ErrorCounterNames = @("retry_later", "rejected", "failed", "jobinfo_failed", "log_fallback")

function Format-PassSummary($Counters) {
  $parts = New-Object System.Collections.ArrayList
  $errors = 0
  foreach ($key in $Counters.Keys) {
    [void]$parts.Add("$key=$($Counters[$key])")
    if ($ErrorCounterNames -contains $key) { $errors += [int]$Counters[$key] }
  }
  [void]$parts.Add($(if ($errors -gt 0) { "state=ERROR" } else { "state=ok" }))
  return ($parts -join " ")
}

# One scan + upload pass. Returns @{ counters; fatal }. fatal = "token" when
# the ERP rejected the upload token (the caller stops with exit 2). Anything
# thrown here is caught by Invoke-GuardedPass.
function Invoke-SyncPass($config, $ActivationInstant, [bool]$IsDryRun, [string[]]$Only) {
  $counters = New-PassCounters
  $fallbackBefore = $script:LogFallbackCount
  $script:JobInfoFailed = 0
  if (-not $IsDryRun) { Clear-UnreleasedClaims }
  # An unreachable folder is an ERROR, not "nothing to do".
  if (!(Test-Path -LiteralPath $config.IncomingFolder)) { throw "incoming_unavailable: the incoming result folder is not reachable - nothing is processed until it is" }
  # Files DIRECTLY in IncomingFolder only (never -Recurse): subfolders such as the
  # historical ...\incoming\GSOP backlog are never read.
  $files = Get-ResultUploadOrder @(Get-ChildItem -Path $config.IncomingFolder -Filter *.csv -File -ErrorAction SilentlyContinue)
  $counters.scanned = @($files).Count
  $files = @(Select-FilesAfterCutoff $files $config.NotBeforeUtc | ForEach-Object { $_ }) # unroll the returned list (an empty list must be zero files, not one empty item)
  $counters.ignored_before_cutoff = $counters.scanned - $files.Count
  # Results stranded in the error folder by an outage (see Get-RetryableErrorFiles) join the same pipeline and the same filter.
  $stranded = @(Get-RetryableErrorFiles $config | ForEach-Object { $_ })
  $counters.scanned += $stranded.Count
  $serverDown = $false
  $fatal = $null
  foreach ($file in @($files + $stranded)) {
    try {
      $verdict = Get-ResultEligibility $file $ActivationInstant
      if (-not $verdict.eligible) {
        if ($verdict.reason -eq "read_failed") { $counters.waiting++ } else { $counters[$verdict.reason]++ }
        if ($verdict.review) {
          $listKey = "$($file.FullName)|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)"
          if (-not $script:ListedIgnored.ContainsKey($listKey)) {
            $script:ListedIgnored[$listKey] = $true
            Write-SyncLog $config $verdict.reason $file.Name "NOT uploaded, left in place: $($verdict.detail). Review by hand."
          }
          if ($IsDryRun) { try { Write-Host ("WOULD IGNORE  " + $file.Name + "  (" + $verdict.reason + ": " + $verdict.detail + ")") } catch { } }
        }
        continue
      }
      if ($Only.Count -gt 0 -and $Only -notcontains $file.Name) { $counters.not_selected++; continue }
      $counters.eligible++
      $ticketText = ($verdict.tickets -join ",")
      if ($IsDryRun) {
        $stable = Test-FileStable $config $file
        $counters.would_upload++
        try { Write-Host ("WOULD UPLOAD  " + $file.Name + "  (ticket " + $ticketText + $(if (-not $stable) { "; still being written - on a later pass" } else { "" }) + ")") } catch { }
        Write-SyncLog $config "dry_run" $file.Name "would_upload=true stable=$stable tickets=$ticketText unticketedRows=$($verdict.unticketedRows) (no upload, no move)"
        continue
      }
      if ($serverDown) { $counters.retry_later++; continue }
      Write-SyncLog $config "detected" $file.Name "size=$($file.Length) tickets=$ticketText unticketedRows=$($verdict.unticketedRows)"
      $outcome = Invoke-ProcessFile $config $file
      if ($outcome -eq "processed") { $counters.uploaded++ }
      elseif ($outcome -eq "retry_later") { $counters.retry_later++; if (-not $script:JobInfoTransient) { $serverDown = $true } }
      elseif ($outcome -eq "move_pending") { $counters.failed++ }
      elseif ($outcome -eq "error") { $counters.rejected++ }
      elseif ($outcome -eq "fatal_config") { $fatal = "token"; break }
      else { $counters.waiting++ }
    } catch {
      # One failed result never stops the results after it.
      $counters.failed++
      Write-SyncLog $config "file_error" $file.Name "unexpected: $($_.Exception.Message); file left in place; retried next pass"
    }
  }
  if ($serverDown) { $script:ServerDownStreak++ } elseif (-not $IsDryRun) { $script:ServerDownStreak = 0 }
  $counters.jobinfo_failed = $script:JobInfoFailed
  $counters.log_fallback = $script:LogFallbackCount - $fallbackBefore
  return @{ counters = $counters; fatal = $fatal }
}

# The pass guard: NOTHING thrown during a pass ends the loop. Returns
# @{ status = ok | pass_error | fatal_token; summary }. The same failure on
# every pass (NAS down overnight) is logged the first time and then on every
# 20th repeat, not every PollSeconds.
function Invoke-GuardedPass($config, $ActivationInstant, [bool]$IsDryRun, [string[]]$Only, [bool]$AlwaysSummarize) {
  try {
    $pass = Invoke-SyncPass $config $ActivationInstant $IsDryRun $Only
    $summary = Format-PassSummary $pass.counters
    if ($AlwaysSummarize -or $summary -ne $script:LastPassSummary) {
      Write-SyncLog $config "pass_summary" "-" $summary
      $script:LastPassSummary = $summary
    }
    $script:LastPassError = ""
    if ($pass.fatal -eq "token") { return @{ status = "fatal_token"; summary = $summary } }
    return @{ status = "ok"; summary = $summary }
  } catch {
    try {
      $passError = [string]$_.Exception.Message
      if ($passError -ne $script:LastPassError -or $script:PassErrorRepeats -ge 20) {
        Write-SyncLog $config "pass_error" "-" "PASS FAILED state=ERROR unexpected: $passError; nothing was moved; retrying next pass"
        $script:PassErrorRepeats = 0
      } else { $script:PassErrorRepeats++ }
      $script:LastPassError = $passError
      $script:LastPassSummary = ""
    } catch { }
    return @{ status = "pass_error"; summary = "" }
  }
}

# Which activation applies, or why none does. Pure.
#   -ActivationUtc on the command line is honoured only for -Once / -DryRun.
function Resolve-SyncActivation($ConfigInstant, [string]$ParamValue, [bool]$IsOneShot) {
  if (-not [string]::IsNullOrWhiteSpace($ParamValue)) {
    if (-not $IsOneShot) { return @{ instant = $null; source = "refused"; reason = "-ActivationUtc is only accepted with -Once or -DryRun; the poll loop uses the ActivationUtc written into the config at registration" } }
    try { return @{ instant = (ConvertTo-SyncUtcInstant $ParamValue "-ActivationUtc"); source = "parameter"; reason = "" } }
    catch { return @{ instant = $null; source = "refused"; reason = "-ActivationUtc is not a valid ISO-8601 UTC timestamp (expected e.g. 2026-11-21T17:20:00Z)" } }
  }
  if ($null -eq $ConfigInstant) { return @{ instant = $null; source = "none"; reason = "ActivationUtc is not set in the config - the sync has not been activated" } }
  return @{ instant = $ConfigInstant; source = "config"; reason = "" }
}

# ---------- health ----------

function Invoke-HealthCheck($Config) {
  Write-Host "=== gso-rasterlink-sync health ($ScriptVersion) ==="
  Write-Host ("config loaded: OK (source=$($Config.Source), poll=$($Config.PollSeconds)s, stable=$($Config.StableFileSeconds)s, retries=$($Config.MaxRetries))")
  Write-Host ("upload token: " + (Get-MaskedToken $Config.UploadToken))
  if ($null -ne $Config.ActivationInstant) { Write-Host ("activation (ActivationUtc): " + $Config.ActivationInstant.ToString('yyyy-MM-ddTHH:mm:ssZ') + " - older results are ignored for good") }
  else { Write-Host "activation (ActivationUtc): NOT SET - the sync refuses to process anything (exit 4) until it is activated" }
  foreach ($pair in @(@("incoming", $Config.IncomingFolder), @("processed", $Config.ProcessedFolder), @("error", $Config.ErrorFolder), @("log", $Config.LogFolder))) {
    $label = $pair[0]; $path = $pair[1]
    if (Test-Path $path) {
      try {
        $probe = Join-Path $path (".gso-health-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
        Set-Content -Path $probe -Value "health"; Remove-Item $probe -Force -Confirm:$false
        Write-Host "$label folder: OK (reachable + writable) $path"
      } catch { Write-Host "$label folder: REACHABLE BUT NOT WRITABLE $path ($($_.Exception.Message))" }
    } else { Write-Host "$label folder: NOT REACHABLE $path (processed / error folders are created on first use)" }
  }
  try {
    $get = Invoke-WebRequest -Uri $Config.UploadUrl -Method GET -UseBasicParsing -TimeoutSec 20
    Write-Host "endpoint reachable: OK (GET $($get.StatusCode))"
  } catch { Write-Host "endpoint reachable: FAILED ($($_.Exception.Message))" }
  # Side-effect-free token probe: the endpoint validates the token BEFORE the
  # file field, so posting token-without-file returns 400 when the token is
  # accepted and 403 when it is not. No import is ever created.
  $probeResult = Invoke-RipTokenProbe $Config
  Write-Host ("token accepted: " + $probeResult)
  $pending = @(Get-ChildItem -Path $Config.IncomingFolder -Filter *.csv -File -ErrorAction SilentlyContinue)
  Write-Host ("result CSV files in the incoming folder: " + $pending.Count + " (run -DryRun to see which of them would be uploaded)")
}

function Invoke-RipTokenProbe($Config) {
  Add-Type -AssemblyName System.Net.Http | Out-Null
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(20)
  try {
    # 13A.6B.1: same hand-built multipart as uploads - the old .NET-format body
    # was rejected by the server's FormData parser (500) before the token was
    # ever read, so a VALID token showed INCONCLUSIVE instead of the 400.
    $boundary = "gso-" + [guid]::NewGuid().ToString("N")
    $fields = New-Object System.Collections.Specialized.OrderedDictionary
    $fields.Add("token", $Config.UploadToken)
    $probeBody = New-GsoMultipartBody $boundary $fields $null $null $null $null
    $content = New-Object System.Net.Http.ByteArrayContent(,$probeBody)
    $content.Headers.TryAddWithoutValidation("Content-Type", "multipart/form-data; boundary=$boundary") | Out-Null
    $response = $client.PostAsync($Config.UploadUrl, $content).GetAwaiter().GetResult()
    $status = [int]$response.StatusCode
    if ($status -eq 400) { return "OK (token valid; 400 missing-file as expected, nothing imported)" }
    if ($status -eq 403 -or $status -eq 401) { return "REJECTED (HTTP $status) - check the token in the config" }
    return "INCONCLUSIVE (HTTP $status)"
  } catch { return "INCONCLUSIVE (endpoint unreachable: $($_.Exception.Message))" } finally { $client.Dispose() }
}

# ---------- offline self-test (no config, no network, no NAS) ----------

function Invoke-SelfTest {
  $script:failures = 0
  $temp = Join-Path $env:TEMP ("gso-rlsync-selftest-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  # Nothing in the self-test may write beside the script: the local log goes to the temp folder.
  $script:LocalLogFolders = @((Join-Path $temp "local-log"))
  $script:StabilityRecheckSeconds = 0
  function Assert($name, $condition) {
    if ($condition) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:failures++ }
  }
  try {
    # duplicate-response recognition
    $dup = '{"ok":true,"duplicateFile":true,"importId":"abc"}' | ConvertFrom-Json
    $success = '{"ok":true,"rows":3,"created":3}' | ConvertFrom-Json
    $fail = '{"ok":false,"error":"x"}' | ConvertFrom-Json
    Assert "duplicate response recognized" (Test-DuplicateResponse $dup)
    Assert "plain success is not duplicate" (-not (Test-DuplicateResponse $success))
    Assert "success response recognized" (Test-SuccessResponse $success)
    Assert "failure response rejected" (-not (Test-SuccessResponse $fail))

    # collision-safe naming: deterministic content-hash suffix
    $src = Join-Path $temp "job.csv"; Set-Content -Path $src -Value "KEY_FILENAME`nrow"
    $destDir = Join-Path $temp "processed"; New-Item -ItemType Directory -Path $destDir | Out-Null
    $first = Get-CollisionSafeDestination $destDir "job.csv" $src
    Assert "no-collision keeps original name" ($first -eq (Join-Path $destDir "job.csv"))
    Set-Content -Path (Join-Path $destDir "job.csv") -Value "already there"
    $second = Get-CollisionSafeDestination $destDir "job.csv" $src
    $third = Get-CollisionSafeDestination $destDir "job.csv" $src
    Assert "collision adds content-hash suffix" ($second -match "job-[0-9a-f]{8}\.csv$")
    Assert "collision suffix is deterministic" ($second -eq $third)

    # claim locking: second claim fails, stale claim is reclaimed
    $lockTarget = Join-Path $temp "lockme.csv"; Set-Content -Path $lockTarget -Value "x"
    Assert "first claim acquired" (New-FileClaim $lockTarget 30)
    Assert "second claim refused while held" (-not (New-FileClaim $lockTarget 30))
    (Get-Item (Get-ClaimPath $lockTarget)).LastWriteTime = (Get-Date).AddHours(-2)
    Assert "stale claim reclaimed" (New-FileClaim $lockTarget 30)
    Remove-FileClaim $lockTarget
    Assert "claim released" (-not (Test-Path (Get-ClaimPath $lockTarget)))
    $deadPid = 0
    $deadProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c exit" -WindowStyle Hidden -PassThru; $deadProc.WaitForExit(); $deadPid = $deadProc.Id
    Assert "a claim from a dead process on this PC is orphaned; one from another PC or from this process is not" ((Test-ClaimOrphaned "$env:COMPUTERNAME pid=$deadPid at=x") -and (-not (Test-ClaimOrphaned "OTHER-PC pid=$deadPid at=x")) -and (-not (Test-ClaimOrphaned "$env:COMPUTERNAME pid=$PID at=x")) -and (-not (Test-ClaimOrphaned "garbage")))

    # error sidecar shape
    $sidecarConfig = @{ ErrorFolder = (Join-Path $temp "error") }
    $sidecarFile = Get-Item $src
    $sidecarPath = Write-ErrorSidecar $sidecarConfig $sidecarFile 3 500 '{"ok":false}' "boom"
    $sidecar = Get-Content $sidecarPath -Raw | ConvertFrom-Json
    Assert "sidecar written with fields" ($sidecar.originalFileName -eq "job.csv" -and $sidecar.retryCount -eq 3 -and $sidecar.httpStatus -eq 500 -and $sidecar.exception -eq "boom" -and $sidecar.scriptVersion -eq $ScriptVersion)

    # token masking never leaks ANY part of the token
    $mask = Get-MaskedToken "supersecrettoken1234"
    Assert "token mask shows the length only - no part of the token" ($mask -eq "(set, 20 chars)" -and $mask -notmatch "supe")

    # 13A.6B.1: hand-built multipart must be Undici-compliant (the .NET
    # Framework writer's unquoted names / quoted boundary caused server 500s).
    $mpBoundary = "gso-testboundary123"
    $mpFileBytes = [byte[]](71, 83, 79, 13, 10, 0, 255, 66)  # text + CRLF + NUL + 0xFF binary bytes
    $mpFields = New-Object System.Collections.Specialized.OrderedDictionary
    $mpFields.Add("token", "tkn-value")
    $mpFields.Add("source", "rasterlink")
    $mp = New-GsoMultipartBody $mpBoundary $mpFields "file" "My Job File.csv" $mpFileBytes "text/csv"
    $mpText = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetString($mp)
    Assert "multipart opens with --boundary CRLF" ($mpText.StartsWith("--$mpBoundary`r`n"))
    Assert "multipart quotes text field names" ($mpText.Contains('Content-Disposition: form-data; name="token"') -and $mpText.Contains('name="source"'))
    Assert "multipart quotes file name and filename with spaces" ($mpText.Contains('name="file"; filename="My Job File.csv"'))
    Assert "multipart separates headers from content with blank CRLF" ($mpText.Contains("name=`"token`"`r`n`r`ntkn-value`r`n"))
    Assert "multipart ends with closing --boundary-- CRLF" ($mpText.EndsWith("--$mpBoundary--`r`n"))
    Assert "multipart has no bare LF line endings" (-not [regex]::IsMatch($mpText, "(?<!`r)`n"))
    $mpFileHead = "Content-Type: text/csv`r`n`r`n"
    $mpIdx = $mpText.IndexOf($mpFileHead) + $mpFileHead.Length
    $mpRoundTrip = [byte[]]$mp[$mpIdx..($mpIdx + $mpFileBytes.Length - 1)]
    Assert "multipart preserves file bytes exactly (incl. binary)" ([Convert]::ToBase64String($mpRoundTrip) -eq [Convert]::ToBase64String($mpFileBytes))
    $mpProbeFields = New-Object System.Collections.Specialized.OrderedDictionary
    $mpProbeFields.Add("token", "tkn-value")
    $mpProbe = New-GsoMultipartBody $mpBoundary $mpProbeFields $null $null $null $null
    $mpProbeText = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetString($mpProbe)
    Assert "token probe body has no file part and closes correctly" ((-not $mpProbeText.Contains("filename=")) -and $mpProbeText.EndsWith("--$mpBoundary--`r`n"))
    Assert "body snippet flattens newlines and truncates" ((Get-SafeBodySnippet ("line1`r`nline2 " + ("x" * 500))).Length -le 180)

    # Patch F: blank-ink rows, exact job-folder linkage, cut-first order
    $resDir = Join-Path $temp "results"; New-Item -ItemType Directory -Path $resDir | Out-Null
    $printCsv = Join-Path $resDir "20261118_153948_a_F_cmyk.pdf_1_OK_print.csv"
    $csvHead = "KEY_FILENAME,KEY_RESULT,KEY_INKUSE,KEY_RIP_S_TIME,KEY_RIP_E_TIME,KEY_PRINT_S_TIME,KEY_PRINT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL"
    Set-Content -Path $printCsv -Value @($csvHead, '"a_F_cmyk.pdf","OK",,"20261118_095815","20261118_095824",,,"0",', '"a_F_g.pdf","OK",,"20261118_095819","20261118_095824",,,"0",', '"has_ink.pdf","OK","C:0.016cc ","20261118_095819","20261118_095824",,,"0",')
    $blank = Get-BlankInkResultRows $printCsv
    Assert "blank-ink rows found, row with ink skipped" ($blank.Count -eq 2 -and $blank[0].FileName -eq "a_F_cmyk.pdf" -and $blank[1].RipStart -eq "20261118_095819")
    $cutCsv = Join-Path $resDir "20261118_153948_a_F_cmyk.pdf_1_OK_cut.csv"; Set-Content -Path $cutCsv -Value "KEY_FILENAME,KEY_RESULT"
    Assert "cut results yield no companion rows" ((Get-BlankInkResultRows $cutCsv).Count -eq 0)
    $jobs = Join-Path $temp "jobs"; New-Item -ItemType Directory -Path $jobs | Out-Null
    function New-TestJob($id, $name, $s, $e, $statedId) {
      $d = Join-Path $jobs $id; New-Item -ItemType Directory -Path $d | Out-Null
      Set-Content -Path (Join-Path $d "JobInfo.ini") -Value @("[Job]", ('JobID="' + $statedId + '"'), ('jobName="' + $name + '"'), ('resultLogResult="' + $statedId + '";"KEY_RIP_E_TIME";"' + $e + '","' + $statedId + '";"KEY_RIP_S_TIME";"' + $s + '"'), "inkUsed=1;4,2;70,3;99,4;7,131;0,133;0,136;0,137;0")
    }
    New-TestJob "S01_A" "a_F_cmyk.pdf" "20261118_095815" "20261118_095824" "S01_A"
    New-TestJob "S01_B" "a_F_cmyk.pdf" "20261117_095815" "20261117_095824" "S01_B"   # same name, another RIP run
    New-TestJob "S01_C" "a_F_cmyk_v2.pdf" "20261118_095815" "20261118_095824" "S01_C" # similar name
    New-TestJob "S01_D" "a_F_cmyk.pdf" "20261118_095815" "20261118_095824" "S01_OTHER" # folder is not the stated JobID
    $linked = Find-JobInfoFolders $jobs $blank[0]
    Assert "exactly the one job folder with the same name + RIP window + JobID links" ($linked.Count -eq 1 -and $linked[0].JobId -eq "S01_A")
    Assert "no job folder for a row nothing states" ((Find-JobInfoFolders $jobs @{ FileName = "zzz.pdf"; RipStart = "20261118_095815"; RipEnd = "20261118_095824" }).Count -eq 0)
    Assert "missing jobs folder links nothing" ((Find-JobInfoFolders (Join-Path $temp "nope") $blank[0]).Count -eq 0)
    $iniBefore = (Get-FileHash (Join-Path $jobs "S01_A\JobInfo.ini")).Hash
    [void](Find-JobInfoFolders $jobs $blank[0])
    Assert "JobInfo.ini is only read" ($iniBefore -eq (Get-FileHash (Join-Path $jobs "S01_A\JobInfo.ini")).Hash)
    $ordered = Get-ResultUploadOrder @(Get-ChildItem -Path $resDir -Filter *.csv -File)
    Assert "cut result is uploaded before its print result" ($ordered[0].Name -match '_cut\.csv$' -and $ordered[1].Name -match '_print\.csv$')
    $sub = Join-Path $resDir "GSOP"; New-Item -ItemType Directory -Path $sub | Out-Null; Set-Content -Path (Join-Path $sub "old_1_OK_print.csv") -Value $csvHead
    # v1.3 cutoff
    $oldFile = Get-Item $cutCsv; $oldFile.LastWriteTimeUtc = [datetime]::SpecifyKind([datetime]"2026-11-19T01:00:00", [DateTimeKind]::Utc)
    $newFile = Get-Item $printCsv; $newFile.LastWriteTimeUtc = [datetime]::SpecifyKind([datetime]"2026-11-19T09:00:00", [DateTimeKind]::Utc)
    $both = @(Get-ChildItem -Path $resDir -Filter *.csv -File)
    $afterCut = Select-FilesAfterCutoff $both "2026-11-19T04:00:00Z"
    Assert "cutoff keeps only files written at or after it" ($afterCut.Count -eq 1 -and $afterCut[0].Name -eq $newFile.Name)
    Assert "no cutoff keeps everything" ((Select-FilesAfterCutoff $both "").Count -eq 2)
    Assert "unreadable cutoff keeps nothing (fail closed)" ((Select-FilesAfterCutoff $both "not-a-date").Count -eq 0)
    $noneLeft = @(Select-FilesAfterCutoff $both "2026-12-01T00:00:00Z" | ForEach-Object { $_ })
    Assert "nothing after the cutoff is zero files in the main loop (not one empty item)" ($noneLeft.Count -eq 0)
    Assert "files in subfolders (historical backlog) are never listed" (@(Get-ChildItem -Path $resDir -Filter *.csv -File).Count -eq 2)

    # ================= v1.4 =================

    # ---- tickets: the exact form the server accepts ----
    Assert "item ticket found in a routed name, upper-cased" ((Get-ItemTickets "gso-20261120-0007-01__MIMAKI__CMYK__F.pdf")[0] -eq "GSO-20261120-0007-01")
    Assert "a job ticket without the item suffix is not an item ticket" ((Get-ItemTickets "GSO-20261120-0007 FLAVAZ.pdf").Count -eq 0)
    Assert "underscores instead of hyphens are not the server's form" ((Get-ItemTickets "GSO_20261120_0007_01.pdf").Count -eq 0)
    Assert "a longer number is not an item ticket" ((Get-ItemTickets "GSO-20261120-0007-012.pdf").Count -eq 0)
    Assert "an un-ticketed CRUD name has no ticket and is not ticket-like" (((Get-ItemTickets "crud_POP TARTS STRAW APPLE_b_.pdf").Count -eq 0) -and (-not (Test-TicketLikeText "crud_POP TARTS STRAW APPLE_b_.pdf")))
    Assert "two different tickets in one name are both seen" ((Get-ItemTickets "GSO-20261120-0007-01_GSO-20261120-0007-02.pdf").Count -eq 2)
    Assert "ticket-like text is recognised" ((Test-TicketLikeText "GSO_20261120_0007_01.pdf") -and (Test-TicketLikeText "GSO-20261120-0007 x.pdf"))

    # ---- activation instant parsing ----
    Assert "empty activation is none" ($null -eq (ConvertTo-SyncUtcInstant "" "ActivationUtc"))
    $instant = ConvertTo-SyncUtcInstant "2026-11-21T17:20:00Z" "ActivationUtc"
    Assert "activation parses as UTC" ($instant.Kind -eq [DateTimeKind]::Utc -and $instant.Hour -eq 17)
    $threw = $false; try { [void](ConvertTo-SyncUtcInstant "tomorrow-ish" "ActivationUtc") } catch { $threw = $true }
    Assert "an unreadable activation throws (never treated as none)" $threw
    Assert "resolve: no activation anywhere = none" ((Resolve-SyncActivation $null "" $false).source -eq "none")
    Assert "resolve: the config activation is used by the loop" ((Resolve-SyncActivation $instant "" $false).source -eq "config")
    Assert "resolve: -ActivationUtc is refused in the poll loop" ((Resolve-SyncActivation $instant "2026-11-21T00:00:00Z" $false).source -eq "refused")
    Assert "resolve: -ActivationUtc is honoured for a one-shot run" ((Resolve-SyncActivation $null "2026-11-21T00:00:00Z" $true).source -eq "parameter")
    Assert "resolve: an unreadable -ActivationUtc is refused" ((Resolve-SyncActivation $null "soon" $true).source -eq "refused")

    # ---- stamps are local time ----
    $stampUtc = ConvertFrom-RipStamp "20261120_115424"
    Assert "a RasterLink stamp is read as local time" ($stampUtc -eq ([datetime]"2026-11-20T11:54:24").ToUniversalTime())
    Assert "a blank or malformed stamp is not a time" (($null -eq (ConvertFrom-RipStamp "")) -and ($null -eq (ConvertFrom-RipStamp "2026-11-20")))
    Assert "the name stamp is read from the front of the result name" ((Get-ResultNameStampUtc "20261120_115424_x.pdf_1_OK_print.csv") -eq $stampUtc)

    # ---- eligibility (the pre-filter) ----
    $sim = Join-Path $temp "sim"; $inc = Join-Path $sim "incoming"; $proc = Join-Path $sim "processed"; $err = Join-Path $sim "error"; $logDir = Join-Path $sim "logs"
    foreach ($d in @($inc, $proc, $err, $logDir)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    $activation = (Get-Date).ToUniversalTime().AddHours(-1)
    $beforeStamp = (Get-Date).AddHours(-3).ToString("yyyyMMdd_HHmmss")
    $afterStamp = (Get-Date).AddMinutes(-20).ToString("yyyyMMdd_HHmmss")
    $afterEnd = (Get-Date).AddMinutes(-30).ToString("yyyyMMdd_HHmmss")
    $cutHead = "KEY_FILENAME,KEY_RESULT,KEY_VEC_S_TIME,KEY_VEC_E_TIME,KEY_CUT_S_TIME,KEY_CUT_E_TIME,KEY_ARRANGE_CNT,KEY_RESULT_DETAIL"
    function New-SimResult([string]$Folder, [string]$Stamp, [string]$Job, [string]$Kind, [string[]]$RowNames, [string]$EndStamp, [datetime]$WrittenUtc) {
      $path = Join-Path $Folder ($Stamp + "_" + $Job + "_1_OK_" + $Kind + ".csv")
      $lines = New-Object System.Collections.ArrayList
      if ($Kind -eq "print") { [void]$lines.Add($csvHead); foreach ($n in $RowNames) { [void]$lines.Add('"' + $n + '","OK",,"' + $EndStamp + '","' + $EndStamp + '",,,"0",') } }
      else { [void]$lines.Add($cutHead); foreach ($n in $RowNames) { [void]$lines.Add('"' + $n + '","OK","' + $EndStamp + '","' + $EndStamp + '","' + $EndStamp + '","' + $EndStamp + '","65",') } }
      Set-Content -LiteralPath $path -Value @($lines)
      (Get-Item -LiteralPath $path).LastWriteTimeUtc = $WrittenUtc
      return (Get-Item -LiteralPath $path)
    }
    $writtenAfter = (Get-Date).ToUniversalTime().AddMinutes(-20)
    $writtenBefore = (Get-Date).ToUniversalTime().AddHours(-3)
    $ticketName = "GSO-20261120-0007-01__MIMAKI__CMYK__F.pdf"
    $fOk = New-SimResult $inc $afterStamp $ticketName "print" @($ticketName, "crud_ALL_b_.pdf") $afterEnd $writtenAfter
    $fOkCut = New-SimResult $inc $afterStamp $ticketName "cut" @($ticketName) $afterEnd $writtenAfter
    $fOld = New-SimResult $inc $beforeStamp "GSO-20261119-0001-01__old.pdf" "print" @("GSO-20261119-0001-01__old.pdf") $beforeStamp $writtenBefore
    $fCrud = New-SimResult $inc $afterStamp "crud_POP TARTS STRAW APPLE_b_.pdf" "print" @("crud_POP TARTS STRAW APPLE_b_.pdf", "crud_ALL_b_.pdf") $afterEnd $writtenAfter
    $fJobOnly = New-SimResult $inc $afterStamp "GSO-20261120-0009 FLAVAZ.pdf" "print" @("GSO-20261120-0009 FLAVAZ.pdf") $afterEnd $writtenAfter
    $fUnder = New-SimResult $inc $afterStamp "GSO_20261120_0010_01.pdf" "print" @("GSO_20261120_0010_01.pdf") $afterEnd $writtenAfter
    $fTwo = New-SimResult $inc $afterStamp "two.pdf" "print" @("GSO-20261120-0011-01_GSO-20261120-0011-02.pdf") $afterEnd $writtenAfter
    $fRipOld = New-SimResult $inc $afterStamp "GSO-20261120-0012-01__ripped-early.pdf" "print" @("GSO-20261120-0012-01__ripped-early.pdf") $beforeStamp $writtenAfter
    $fTouched = New-SimResult $inc $beforeStamp "GSO-20261119-0002-01__touched.pdf" "print" @("GSO-20261119-0002-01__touched.pdf") $beforeStamp $writtenAfter   # an old result whose file time was refreshed by a copy
    $fOther = Join-Path $inc ($afterStamp + "_GSO-20261120-0013-01__notes.csv"); Set-Content -LiteralPath $fOther -Value "hello"; (Get-Item -LiteralPath $fOther).LastWriteTimeUtc = $writtenAfter; $fOther = Get-Item -LiteralPath $fOther
    $fNoRows = Join-Path $inc ($afterStamp + "_GSO-20261120-0014-01__x.pdf_1_OK_print.csv"); Set-Content -LiteralPath $fNoRows -Value "SOMETHING,ELSE`n1,2"; (Get-Item -LiteralPath $fNoRows).LastWriteTimeUtc = $writtenAfter; $fNoRows = Get-Item -LiteralPath $fNoRows
    $vOk = Get-ResultEligibility $fOk $activation
    Assert "ticketed + supported + post-activation = eligible (an un-ticketed layer beside it is noted, not a blocker)" ($vOk.eligible -and $vOk.tickets[0] -eq "GSO-20261120-0007-01" -and $vOk.unticketedRows -eq 1)
    Assert "its cut result is eligible too" ((Get-ResultEligibility $fOkCut $activation).eligible)
    Assert "written before activation = ignored_before_activation" ((Get-ResultEligibility $fOld $activation).reason -eq "ignored_before_activation")
    Assert "un-ticketed CRUD result = ignored_no_ticket, listed for review" (((Get-ResultEligibility $fCrud $activation).reason -eq "ignored_no_ticket") -and (Get-ResultEligibility $fCrud $activation).review)
    Assert "a job ticket without item suffix = ignored_ambiguous (nothing guessed)" ((Get-ResultEligibility $fJobOnly $activation).reason -eq "ignored_ambiguous")
    Assert "an underscore ticket = ignored_ambiguous" ((Get-ResultEligibility $fUnder $activation).reason -eq "ignored_ambiguous")
    Assert "two tickets in one job name = ignored_ambiguous" ((Get-ResultEligibility $fTwo $activation).reason -eq "ignored_ambiguous")
    Assert "written after activation but RIPped before it = ignored_before_activation, listed for review" (((Get-ResultEligibility $fRipOld $activation).reason -eq "ignored_before_activation") -and (Get-ResultEligibility $fRipOld $activation).review)
    Assert "an old result with a refreshed file time is still ignored (name stamp)" ((Get-ResultEligibility $fTouched $activation).reason -eq "ignored_before_activation")
    Assert "a csv that is not a print/cut result = ignored_unsupported_format" ((Get-ResultEligibility $fOther $activation).reason -eq "ignored_unsupported_format")
    Assert "a result with no KEY_FILENAME rows = ignored_unsupported_format" ((Get-ResultEligibility $fNoRows $activation).reason -eq "ignored_unsupported_format")
    Assert "no activation = nothing is eligible" (-not (Get-ResultEligibility $fOk $null).eligible)
    Assert "the same file and activation always give the same verdict" (((Get-ResultEligibility $fCrud $activation).reason) -eq ((Get-ResultEligibility $fCrud $activation).reason))

    # ---- offline simulation: stubbed server, temp folders ----
    $simConfig = @{ ApiBaseUrl = "http://127.0.0.1:9"; UploadUrl = "http://127.0.0.1:9/api/rip-imports/upload"; UploadToken = "selftest-token-value"; IncomingFolder = $inc; ProcessedFolder = $proc; ErrorFolder = $err; LogFolder = $logDir; JobsFolder = ""; NotBeforeUtc = ""; Source = "rasterlink"; PollSeconds = 1; StableFileSeconds = 0; MaxRetries = 2; RetryDelaySeconds = 0; ClaimStaleMinutes = 30 }
    $script:simCalls = New-Object System.Collections.ArrayList
    $script:simMode = "ok"
    $script:simServerHas = @{}
    function Invoke-RipUpload($Config, [string]$FilePath, [string]$FileName, [System.Collections.IDictionary]$ExtraFields = $null) {
      [void]$script:simCalls.Add($FileName)
      if ($script:simMode -eq "down") { return @{ status = 0; body = ""; json = $null; exception = "connection refused" } }
      if ($script:simMode -eq "503") { return @{ status = 503; body = "bad gateway"; json = $null; exception = $null } }
      if ($script:simMode -eq "token") { return @{ status = 403; body = "x"; json = ('{"ok":false,"error":"Invalid or disabled upload token."}' | ConvertFrom-Json); exception = $null } }
      if ($script:simMode -eq "refuse") { return @{ status = 400; body = "bad"; json = ('{"ok":false,"error":"bad file"}' | ConvertFrom-Json); exception = $null } }
      if ($script:simMode -eq "throw-on-cut" -and $FileName -match '_cut\.csv$') { throw "simulated crash inside the upload" }
      $key = $FileName + "|" + (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash
      if ($script:simServerHas.ContainsKey($key)) { return @{ status = 200; body = "dup"; json = ('{"ok":true,"duplicateFile":true,"importId":"imp-1"}' | ConvertFrom-Json); exception = $null } }
      $script:simServerHas[$key] = $true
      return @{ status = 200; body = "ok"; json = ('{"ok":true,"rows":1,"created":1,"skippedDuplicates":0,"matched":1,"ambiguous":0}' | ConvertFrom-Json); exception = $null }
    }
    $incomingBefore = @(Get-ChildItem -LiteralPath $inc -File | ForEach-Object { $_.Name } | Sort-Object)

    # dry run: lists what WOULD be uploaded, uploads nothing, moves nothing, claims nothing
    $dry = Invoke-GuardedPass $simConfig $activation $true @() $true
    Assert "dry run: only the ticketed result pair would be uploaded" ($dry.summary -match 'would_upload=2 ' -and $dry.summary -match 'eligible=2 ')
    Assert "dry run: no upload call was made" ($script:simCalls.Count -eq 0)
    Assert "dry run: nothing moved, no claim files" ((@(Get-ChildItem -LiteralPath $inc -File | ForEach-Object { $_.Name } | Sort-Object) -join "|") -eq ($incomingBefore -join "|"))
    Assert "dry run: counts every ignored reason" ($dry.summary -match 'ignored_before_activation=3 ' -and $dry.summary -match 'ignored_no_ticket=1 ' -and $dry.summary -match 'ignored_ambiguous=3 ' -and $dry.summary -match 'ignored_unsupported_format=2 ')

    # server outage: nothing is moved, nothing is stranded, the error state is visible
    $script:simMode = "down"; $script:simCalls.Clear(); $script:ServerDownStreak = 0
    $down = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "outage: the pass survives and reports state=ERROR with retry_later=2" ($down.status -eq "ok" -and $down.summary -match 'retry_later=2 ' -and $down.summary -match 'state=ERROR')
    Assert "outage: both results are still in incoming; the error folder is empty" ((Test-Path -LiteralPath $fOk.FullName) -and (Test-Path -LiteralPath $fOkCut.FullName) -and (@(Get-ChildItem -LiteralPath $err -File).Count -eq 0))
    Assert "outage: after the first result the rest wait for the next pass (no hammering)" ($script:simCalls.Count -eq 2)
    Assert "outage: no claim file is left behind" (@(Get-ChildItem -LiteralPath $inc -Filter *.gsoclaim -File).Count -eq 0)
    $script:simMode = "503"; $script:simCalls.Clear()
    $down2 = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "outage (5xx), second pass: one probe only, results still in incoming" ($script:simCalls.Count -eq 1 -and $down2.summary -match 'retry_later=2 ' -and (Test-Path -LiteralPath $fOk.FullName))

    # one bad result does not stop the next one
    $script:simMode = "throw-on-cut"; $script:simCalls.Clear(); $script:ServerDownStreak = 0
    $mixed = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "one result throws: counted as failed, the next result is still uploaded" ($mixed.status -eq "ok" -and $mixed.summary -match 'failed=1 ' -and $mixed.summary -match 'uploaded=1 ' -and $mixed.summary -match 'state=ERROR')
    Assert "the uploaded result moved to processed; the failed one is still in incoming" ((Test-Path -LiteralPath (Join-Path $proc $fOk.Name)) -and (Test-Path -LiteralPath $fOkCut.FullName))

    # recovery: the next pass uploads what was left, exactly once
    $script:simMode = "ok"; $script:simCalls.Clear()
    $recover = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "recovery: the remaining result is uploaded and moved; state=ok" ($recover.summary -match 'uploaded=1 ' -and $recover.summary -match 'state=ok' -and (Test-Path -LiteralPath (Join-Path $proc $fOkCut.Name)))
    Assert "the ignored results never left the incoming folder and were never uploaded" ((Test-Path -LiteralPath $fCrud.FullName) -and (Test-Path -LiteralPath $fOld.FullName) -and (Test-Path -LiteralPath $fJobOnly.FullName) -and (Test-Path -LiteralPath $fRipOld.FullName) -and (@($script:simCalls | Where-Object { $_ -match 'crud_|old|FLAVAZ|ripped-early' }).Count -eq 0))
    $idle = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "an idle pass uploads nothing and is state=ok" ($idle.summary -match 'uploaded=0 ' -and $idle.summary -match 'eligible=0 ' -and $idle.summary -match 'state=ok')
    $nasLog = Get-Content -LiteralPath (Join-Path $logDir ("gso-rasterlink-sync-" + (Get-Date -Format "yyyyMMdd") + ".log"))
    Assert "an ignored result is listed ONCE in the log, not every pass" (@($nasLog | Where-Object { $_ -match '\[ignored_no_ticket\]' }).Count -eq 1)
    Assert "the log never contains the token" (-not (($nasLog -join "`n").Contains("selftest-token-value")))

    # duplicate protection: the same result arriving again is accepted as a duplicate and archived, not imported twice
    $fAgain = New-SimResult $inc $afterStamp $ticketName "cut" @($ticketName) $afterEnd $writtenAfter
    $script:simCalls.Clear()
    $again = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "duplicate: accepted as duplicateFile and moved with a content-hash suffix" ($again.summary -match 'uploaded=1 ' -and (@($nasLog + (Get-Content -LiteralPath (Join-Path $logDir ("gso-rasterlink-sync-" + (Get-Date -Format "yyyyMMdd") + ".log"))) | Where-Object { $_ -match '\[duplicate_accepted\]' }).Count -ge 1) -and (@(Get-ChildItem -LiteralPath $proc -Filter "*_cut-*.csv" -File).Count -eq 1))

    # a refused result (4xx) goes to error with a sidecar - only after the server answered
    $fRefuse = New-SimResult $inc $afterStamp "GSO-20261120-0020-01__refused.pdf" "print" @("GSO-20261120-0020-01__refused.pdf") $afterEnd $writtenAfter
    $script:simMode = "refuse"
    $refused = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "refused by the server: moved to error with a sidecar, counted as rejected" ($refused.summary -match 'rejected=1 ' -and (Test-Path -LiteralPath (Join-Path $err $fRefuse.Name)) -and (Test-Path -LiteralPath (Join-Path $err ($fRefuse.Name + ".error.json"))))
    $script:simMode = "ok"; $script:simCalls.Clear()
    [void](Invoke-GuardedPass $simConfig $activation $false @() $true)
    Assert "a result the server refused is NOT retried from the error folder" ($script:simCalls.Count -eq 0)

    # results stranded in the error folder by an outage (older versions) are retried from there
    $fStranded = New-SimResult $err $afterStamp "GSO-20261120-0021-01__stranded.pdf" "print" @("GSO-20261120-0021-01__stranded.pdf") $afterEnd $writtenAfter
    Set-Content -LiteralPath (Join-Path $err ($fStranded.Name + ".error.json")) -Value '{"originalFileName":"x","retryCount":4,"httpStatus":0,"exception":"timeout"}'
    $fStrandedCrud = New-SimResult $err $afterStamp "crud_stranded.pdf" "print" @("crud_stranded.pdf") $afterEnd $writtenAfter
    Set-Content -LiteralPath (Join-Path $err ($fStrandedCrud.Name + ".error.json")) -Value '{"httpStatus":503}'
    $strandedPass = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "stranded by an outage: retried, accepted, moved to processed with its sidecar" ($strandedPass.summary -match 'uploaded=1 ' -and (Test-Path -LiteralPath (Join-Path $proc $fStranded.Name)) -and (Test-Path -LiteralPath (Join-Path $proc ($fStranded.Name + ".error.json"))) -and (-not (Test-Path -LiteralPath $fStranded.FullName)))
    Assert "a stranded UN-TICKETED result passes the same filter: never uploaded, never moved" ((Test-Path -LiteralPath $fStrandedCrud.FullName) -and (@($script:simCalls | Where-Object { $_ -match 'crud_stranded' }).Count -eq 0))
    Assert "sidecar status: no answer / 5xx / 408 / 429 are transient; a 4xx verdict is not" ((Test-SidecarTransient ('{"httpStatus":0}' | ConvertFrom-Json)) -and (Test-SidecarTransient ('{"httpStatus":null}' | ConvertFrom-Json)) -and (Test-SidecarTransient ('{"httpStatus":502}' | ConvertFrom-Json)) -and (Test-SidecarTransient ('{"httpStatus":429}' | ConvertFrom-Json)) -and (-not (Test-SidecarTransient ('{"httpStatus":400}' | ConvertFrom-Json))) -and (-not (Test-SidecarTransient ('{"httpStatus":"abc"}' | ConvertFrom-Json))))

    # token rejected: fatal for the caller, the result is not moved
    $fTok = New-SimResult $inc $afterStamp "GSO-20261120-0022-01__tok.pdf" "print" @("GSO-20261120-0022-01__tok.pdf") $afterEnd $writtenAfter
    $script:simMode = "token"
    $tok = Invoke-GuardedPass $simConfig $activation $false @() $true
    Assert "token rejected by the ERP: the pass reports fatal_token and the result stays in incoming" ($tok.status -eq "fatal_token" -and (Test-Path -LiteralPath $fTok.FullName))
    Assert "token rejected = the ERP's own answer only; a proxy 403 / 5xx / no answer is transient" ((Test-TokenRejected @{ status = 403; json = ('{"ok":false,"error":"Invalid or disabled upload token."}' | ConvertFrom-Json) }) -and (-not (Test-TokenRejected @{ status = 403; json = $null })) -and (-not (Test-TerminalClientError @{ status = 403; json = $null; exception = $null })) -and (-not (Test-TerminalClientError @{ status = 503; exception = $null })) -and (-not (Test-TerminalClientError @{ status = 0; exception = "x" })) -and (Test-TerminalClientError @{ status = 400; exception = $null }) -and (-not (Test-TerminalClientError @{ status = 429; exception = $null })))

    # -OnlyFile narrows the eligible results; it never makes an ignored one eligible
    $script:simMode = "ok"; $script:simCalls.Clear()
    $only = Invoke-GuardedPass $simConfig $activation $false @($fCrud.Name) $true
    Assert "-OnlyFile cannot push an un-ticketed result through" ($script:simCalls.Count -eq 0 -and $only.summary -match 'not_selected=1 ' -and (Test-Path -LiteralPath $fCrud.FullName))
    $only2 = Invoke-GuardedPass $simConfig $activation $false @($fTok.Name) $true
    Assert "-OnlyFile uploads exactly the named eligible result" ($script:simCalls.Count -eq 1 -and $script:simCalls[0] -eq $fTok.Name -and $only2.summary -match 'uploaded=1 ')

    # JobInfo.ini companion (the jobFolder flow) still runs for an eligible result
    $jobs2 = Join-Path $sim "jobs"; New-Item -ItemType Directory -Path $jobs2 | Out-Null
    $clearName = "GSO-20261120-0030-01__MIMAKI__CMYK_CLEAR__F.pdf"
    $fClear = New-SimResult $inc $afterStamp $clearName "print" @($clearName) $afterEnd $writtenAfter
    $jd = Join-Path $jobs2 "S09_Z"; New-Item -ItemType Directory -Path $jd | Out-Null
    Set-Content -Path (Join-Path $jd "JobInfo.ini") -Value @("[Job]", 'JobID="S09_Z"', ('jobName="' + $clearName + '"'), ('resultLogResult="S09_Z";"KEY_RIP_E_TIME";"' + $afterEnd + '","S09_Z";"KEY_RIP_S_TIME";"' + $afterEnd + '"'))
    $jobConfig = $simConfig.Clone(); $jobConfig.JobsFolder = $jobs2
    $script:simCalls.Clear()
    $clearPass = Invoke-GuardedPass $jobConfig $activation $false @() $true
    Assert "clear ink: the result is uploaded, then the exact job's JobInfo.ini, then the result is archived" ($script:simCalls.Count -eq 2 -and $script:simCalls[0] -eq $fClear.Name -and $script:simCalls[1] -eq "JobInfo.ini" -and (Test-Path -LiteralPath (Join-Path $proc $fClear.Name)) -and $clearPass.summary -match 'jobinfo_failed=0 ')

    # ---- the pass guard: nothing thrown in a pass ends the loop ----
    $goneConfig = $simConfig.Clone(); $goneConfig.IncomingFolder = (Join-Path $sim "not-there")
    $script:LastPassError = ""
    $guard1 = Invoke-GuardedPass $goneConfig $activation $false @() $false
    $guard2 = Invoke-GuardedPass $goneConfig $activation $false @() $false
    Assert "pass guard: an unreachable incoming folder is a pass_error, not a crash and not 'nothing to do'" ($guard1.status -eq "pass_error" -and $guard2.status -eq "pass_error")
    $nasLog2 = Get-Content -LiteralPath (Join-Path $logDir ("gso-rasterlink-sync-" + (Get-Date -Format "yyyyMMdd") + ".log"))
    Assert "pass guard: the repeated failure is logged once, with state=ERROR" (@($nasLog2 | Where-Object { $_ -match '\[pass_error\].*state=ERROR.*incoming_unavailable' }).Count -eq 1)
    function Invoke-SyncPass($config, $ActivationInstant, [bool]$IsDryRun, [string[]]$Only) { throw "simulated: anything at all" }
    $guard3 = Invoke-GuardedPass $simConfig $activation $false @() $false
    Assert "pass guard: an arbitrary exception inside the pass is contained" ($guard3.status -eq "pass_error")
    Remove-Item Function:\Invoke-SyncPass

    # ---- logging: retries, falls back to a local file, never throws ----
    $blockedLog = Join-Path $sim "log-is-a-file"; Set-Content -LiteralPath $blockedLog -Value "x"   # a FILE where the log folder should be: every write fails
    $badLogConfig = @{ LogFolder = $blockedLog }
    $script:NasLogDownUntil = [datetime]::MinValue; $script:LogFallbackCount = 0
    $logThrew = $false
    try { Write-SyncLog $badLogConfig "selftest_event" "a.csv" "first line while the log folder is unusable" } catch { $logThrew = $true }
    $localLogFile = Join-Path (Join-Path $temp "local-log") ("gso-rasterlink-sync-local-" + (Get-Date -Format "yyyyMMdd") + ".log")
    Assert "logging: a failed log write does not throw" (-not $logThrew)
    Assert "logging: the line is in the local fallback log and the fallback is counted" ((Test-Path -LiteralPath $localLogFile) -and ((Get-Content -LiteralPath $localLogFile -Raw) -match 'first line while the log folder is unusable') -and $script:LogFallbackCount -eq 1)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Write-SyncLog $badLogConfig "selftest_event" "a.csv" "second line goes straight to the local log"
    $sw.Stop()
    Assert "logging: while the NAS log is down the next lines skip the retries" ($sw.ElapsedMilliseconds -lt 1000 -and ((Get-Content -LiteralPath $localLogFile -Raw) -match 'second line goes straight'))
    $script:LocalLogFolders = @((Join-Path $blockedLog "nope"), (Join-Path $temp "local-log-2"))
    Write-SyncLog $badLogConfig "selftest_event" "a.csv" "third line when the first local folder is not writable"
    Assert "logging: when the folder beside the script is not writable, the next local folder takes the line" (Test-Path -LiteralPath (Join-Path (Join-Path $temp "local-log-2") ("gso-rasterlink-sync-local-" + (Get-Date -Format "yyyyMMdd") + ".log")))
    $script:LocalLogFolders = @((Join-Path $blockedLog "nope"))
    $logThrew = $false
    try { Write-SyncLog $badLogConfig "selftest_event" "a.csv" "nowhere to write at all"; Write-SyncLocalLog "selftest_event" "nowhere either" } catch { $logThrew = $true }
    Assert "logging: with nowhere to write at all it still does not throw" (-not $logThrew)
    $script:LocalLogFolders = @((Join-Path $temp "local-log")); $script:NasLogDownUntil = [datetime]::MinValue
    $script:LastPassSummary = ""
    $fbConfig = $simConfig.Clone(); $fbConfig.LogFolder = $blockedLog
    $script:ListedIgnored = @{}   # so this pass has lines to write
    $fbPass = Invoke-GuardedPass $fbConfig $activation $false @() $true
    Assert "logging: a pass with an unusable log folder still completes and shows log_fallback > 0, state=ERROR" ($fbPass.status -eq "ok" -and $fbPass.summary -match 'log_fallback=[1-9]' -and $fbPass.summary -match 'state=ERROR')
    $script:NasLogDownUntil = [datetime]::MinValue

    # ---- config error text never quotes the file ----
    Assert "config error text: own messages pass, a parser message is reduced to its type" (((Get-SyncConfigErrorText "Config missing required value: UploadToken" "RuntimeException") -eq "Config missing required value: UploadToken") -and ((Get-SyncConfigErrorText 'Invalid JSON primitive: gso_plog_secretvalue' "ArgumentException") -eq "the config file could not be read as JSON (ArgumentException)") -and ((Get-SyncConfigErrorText "Config ActivationUtc is not a valid ISO-8601 UTC timestamp (expected e.g. 2026-11-21T17:20:00Z)" "RuntimeException") -match '^Config ActivationUtc'))

    # ---- single instance ----
    $lockName = "Local\gso-rlsync-selftest-" + [guid]::NewGuid().ToString("N")
    $lockA = Enter-SyncSingleInstance $lockName
    $otherShell = [powershell]::Create()
    [void]$otherShell.AddScript("function Enter-SyncSingleInstance { " + ${function:Enter-SyncSingleInstance}.ToString() + " }; (Enter-SyncSingleInstance '" + $lockName + "').state")
    $otherState = [string](@($otherShell.Invoke())[0]); $otherShell.Dispose()
    Assert "single instance: the first loop gets the lock, a second one is refused" (($lockA.state -eq "acquired") -and ($otherState -eq "held"))
    if ($lockA.mutex) { $lockA.mutex.ReleaseMutex(); $lockA.mutex.Dispose() }
    Assert "single instance: the lock name depends on the incoming folder only (case and trailing slash do not matter)" (((Get-SyncInstanceName "\\NAS\a\UCJV-300\") -eq (Get-SyncInstanceName "\\nas\A\ucjv-300")) -and ((Get-SyncInstanceName "\\NAS\a\UCJV-300") -ne (Get-SyncInstanceName "\\NAS\a\LG-640")))

    # ---- the real HTTP client against a closed port: an answer object, never an exception ----
    Remove-Item Function:\Invoke-RipUpload
    $closed = Invoke-RipUpload $simConfig $fCrud.FullName $fCrud.Name
    Assert "a server that is not there is status 0 + exception text (transient), not a thrown error" ($closed.status -eq 0 -and $closed.exception -and (-not (Test-UploadAccepted $closed)) -and (-not (Test-TerminalClientError $closed)) -and (-not (Test-TokenRejected $closed)))
  } finally {
    Remove-Item $temp -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host ("self-test failures: " + $script:failures)
  if ($script:failures -gt 0) { exit 1 } else { exit 0 }
}

# ---------- main ----------

if ($SelfTest) { Invoke-SelfTest }

# A missing / broken config stops the sync (exit 1) and says why in the local log.
try {
  $config = Read-SyncConfig $ConfigPath
} catch {
  Write-SyncLocalLog "config_error" ("sync did not start: " + (Get-SyncConfigErrorText ([string]$_.Exception.Message) $_.Exception.GetType().Name))
  exit 1
}
if ($Health) { Invoke-HealthCheck $config; exit 0 }

if ((Split-Path -Leaf ($config.IncomingFolder.TrimEnd('\'))) -ieq "GSOP" -and $config.IncomingFolder -match 'rasterlink\\incoming\\GSOP\\?$') {
  Write-SyncLog $config "refused_backlog_folder" "-" "IncomingFolder points at the historical RasterLink backlog (incoming\GSOP). Refusing to run. Use ...\rasterlink\incoming\UCJV-300."
  exit 1
}

# v1.4: NO ACTIVATION = NO PROCESSING. The sync never falls back to "every
# result in the folder is eligible".
$activationChoice = Resolve-SyncActivation $config.ActivationInstant $ActivationUtc ([bool]($Once -or $DryRun))
if ($null -eq $activationChoice.instant) {
  Write-SyncLog $config "refused_no_activation" "-" ($activationChoice.reason + " - refusing to process anything (exit 4)")
  try { Write-Host ("REFUSED TO START - NO ACTIVATION TIMESTAMP. " + $activationChoice.reason + ".") } catch { }
  exit 4
}
$activationInstant = $activationChoice.instant

$modeLabel = if ($DryRun) { "dry-run" } elseif ($Once) { "once" } else { "poll" }

# One poll loop per incoming folder per PC (exit 6). -Once / -DryRun / -Health /
# -SelfTest never take the lock, so a person can still run a check beside the loop.
if (-not $Once -and -not $DryRun) {
  $script:InstanceLock = Enter-SyncSingleInstance (Get-SyncInstanceName $config.IncomingFolder)
  if ($script:InstanceLock.state -eq "held") {
    Write-SyncLog $config "duplicate_instance" "-" "another poll loop for this incoming folder is already running on this PC; this one stops (exit 6)"
    exit 6
  }
  if ($script:InstanceLock.state -ne "acquired") { Write-SyncLog $config "instance_lock_unavailable" "-" "single-instance lock could not be created; continuing without it" }
}

Write-SyncLog $config "watcher_started" "-" "version=$ScriptVersion mode=$modeLabel incoming=$($config.IncomingFolder) jobsFolder=$(if ($config.JobsFolder) { $config.JobsFolder } else { '(not set - no JobInfo companion)' }) onlyFile=$($OnlyFile.Count) activationUtc=$($activationInstant.ToString('yyyy-MM-ddTHH:mm:ssZ')) activationFrom=$($activationChoice.source) notBeforeUtc=$(if ($config.NotBeforeUtc) { $config.NotBeforeUtc } else { '(none)' })"
if ($DryRun) { try { Write-Host ("DRY RUN - nothing is uploaded, nothing is moved. Activation (UTC): " + $activationInstant.ToString('yyyy-MM-ddTHH:mm:ssZ') + " from " + $activationChoice.source) } catch { } }

while ($true) {
  $guarded = Invoke-GuardedPass $config $activationInstant ([bool]$DryRun) $OnlyFile ([bool]($Once -or $DryRun))
  if ($guarded.status -eq "fatal_token") {
    Write-SyncLog $config "watcher_stopped" "-" "the ERP rejected the upload token (rotated or disabled); fix the config token and restart. Nothing was moved; results wait where they are. (exit 2)"
    exit 2
  }
  if ($DryRun) { try { Write-Host ("DRY RUN SUMMARY: " + $guarded.summary) } catch { } }
  if ($Once -or $DryRun) { break }
  try { Start-Sleep -Seconds $config.PollSeconds } catch { }
}
Write-SyncLog $config "watcher_finished" "-" "single pass complete"
