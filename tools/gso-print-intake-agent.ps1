# GSO Print Intake Agent (Patch 13A.6G).
# Watches "Prints For Today", asks the ERP for a deterministic routing plan
# (exact item/job ticket, a job folder whose name STARTS with the job ticket,
# or stored filename - never fuzzy), copies the file into the correct machine hot folder under the exact
# ERP RIP name, preserves the original, and reports every outcome back to the
# ERP for the intake audit trail. PowerShell 5.1 compatible. JSON transport
# only - no multipart.
#
# Separation of duties: this agent routes ARTWORK INTO the RIPs. The separate
# gso-rasterlink-sync.ps1 watcher imports RIP RESULTS back into the ERP. They
# are never merged.
#
# Modes:
#   (default)   one pass then exit (same as -Once)
#   -Loop       poll continuously every PollSeconds
#   -Once       single pass then exit
#   -DryRun     TRUE READ-ONLY (Patch A): asks the ERP what WOULD happen with
#               dryRun=true - the server suppresses every database write and
#               says so; no claims, no copies, no moves, no reports, no ledger.
#               If the server does not confirm the dry run, the agent stops.
#
# Safety stops (Patch A): the agent refuses to process anything when no go-live
# cutoff is configured, and when one scan finds more than the flood cap (60)
# eligible files it processes NONE of them and exits for human review.
#   -Health     config/folders/endpoint/token checks; writes nothing
#   -SelfTest   offline unit checks (no config, no network, no NAS)
param(
  [switch]$Loop,
  [switch]$Once,
  [switch]$DryRun,
  [switch]$Health,
  [switch]$SelfTest,
  [string]$ConfigPath = (Join-Path $PSScriptRoot "gso-print-intake-agent-config.json")
)

$ScriptVersion = "gso-print-intake-agent/1.10 (crash-safe logging + pass guard + heartbeat; Patch A read-only dry run + flood cap + mandatory cutoff; Patch D ticket job folders)"
$ErrorActionPreference = "Stop"

# ---------- config ----------

function Read-IntakeConfig([string]$Path) {
  if (!(Test-Path $Path)) { throw "Config not found: $Path. Copy gso-print-intake-agent-config.example.json, paste the upload token from /app/erp/print-intake, and save as gso-print-intake-agent-config.json." }
  $raw = Get-Content $Path -Raw | ConvertFrom-Json
  $config = @{
    ApiBaseUrl            = [string]$raw.ApiBaseUrl
    UploadToken           = [string]$raw.UploadToken
    PrintsForTodayFolder  = [string]$raw.PrintsForTodayFolder
    RoutedArchiveFolder   = [string]$raw.RoutedArchiveFolder
    ErrorFolder           = [string]$raw.ErrorFolder
    LogFolder             = [string]$raw.LogFolder
    MimakiHotFolder       = [string]$raw.MimakiHotFolder
    VersaWorksHotFolder   = [string]$raw.VersaWorksHotFolder
    MimakiRoutingEnabled  = [bool]$raw.MimakiRoutingEnabled
    RolandRoutingEnabled  = [bool]$raw.RolandRoutingEnabled
    PollSeconds           = if ($raw.PollSeconds) { [int]$raw.PollSeconds } else { 30 }
    StableFileSeconds     = if ($raw.StableFileSeconds) { [int]$raw.StableFileSeconds } else { 20 }
    ClaimStaleMinutes     = if ($raw.ClaimStaleMinutes) { [int]$raw.ClaimStaleMinutes } else { 30 }
    ProcessFilesModifiedAfterUtc = [string]$raw.ProcessFilesModifiedAfterUtc
    # Patch D: also process files DIRECTLY inside one level of job folders whose
    # name starts with a job ticket. Missing = on; set false for root-only.
    TicketJobFoldersEnabled = if ($null -eq $raw.TicketJobFoldersEnabled) { $true } else { [bool]$raw.TicketJobFoldersEnabled }
    # Patch A: flood cap. May be LOWERED in config, never raised above the hard cap.
    MaxEligibleFilesPerScan = Get-EffectiveFloodCap $raw.MaxEligibleFilesPerScan
  }
  foreach ($key in @("ApiBaseUrl","UploadToken","PrintsForTodayFolder","RoutedArchiveFolder","LogFolder")) {
    if ([string]::IsNullOrWhiteSpace($config[$key])) { throw "Config missing required value: $key" }
  }
  $config.PlanUrl = ($config.ApiBaseUrl.TrimEnd('/')) + "/api/print-intake/route-plan"
  $config.ReportUrl = ($config.ApiBaseUrl.TrimEnd('/')) + "/api/print-intake/report"
  # 15H.3: server-authoritative disposition endpoint - the local ledger is a
  # cache; blocked hashes ask the ERP before being skipped.
  $config.StatusUrl = ($config.ApiBaseUrl.TrimEnd('/')) + "/api/print-intake/status"
  # Go-live cutoff (13A.6G): parsed ONCE at config load; an invalid value must
  # fail loudly here - a silently ignored typo would process every historical
  # file in Prints For Today on first start.
  $config.CutoffUtc = ConvertTo-CutoffUtc $config.ProcessFilesModifiedAfterUtc
  return $config
}

# ---------- Patch A: flood cap (pure, self-testable) ----------
# One scan may never hand more than this many files to the pipeline. Above the
# cap NOTHING is processed (not the first 60 either) and the agent exits so a
# person looks before anything is ingested.
$HardFloodCap = 60

function Get-EffectiveFloodCap($Configured) {
  $value = 0
  if ($null -ne $Configured -and [int]::TryParse([string]$Configured, [ref]$value) -and $value -ge 1) { return [Math]::Min($value, $HardFloodCap) }
  return $HardFloodCap
}

function Test-EligibleCountWithinCap([int]$Count, [int]$Cap) {
  return ($Count -le $Cap)
}

# ISO-8601 UTC cutoff -> [DateTime] (Utc kind). Empty/missing -> $null (no
# cutoff, all files eligible). Anything unparseable throws.
function ConvertTo-CutoffUtc([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  try {
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    return [DateTime]::Parse($Value, [System.Globalization.CultureInfo]::InvariantCulture, $styles)
  } catch {
    throw "Config ProcessFilesModifiedAfterUtc is not a valid ISO-8601 UTC timestamp: '$Value' (expected e.g. 2026-07-19T17:20:00Z)"
  }
}

function Get-MaskedToken([string]$Token) {
  if ([string]::IsNullOrWhiteSpace($Token)) { return "(not set)" }
  $prefix = $Token.Substring(0, [Math]::Min(4, $Token.Length))
  return "(set, $($Token.Length) chars, $prefix****)"
}

# ---------- logging (never logs the token) ----------

function Write-IntakeLog($Config, [string]$EventName, [string]$File, [string]$Detail) {
  $line = "{0} [{1}] file={2} {3}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $EventName, $File, $Detail
  Write-Host $line
  if ($Config -and $Config.LogFolder) {
    # v1.10 (2026-11-19): one failed write to the NAS log ended the whole agent
    # (it stopped at 16:47 and stayed down). Logging now retries and then falls
    # back to a local file; it never throws.
    for ($logTry = 1; $logTry -le 3; $logTry++) {
      try {
        if (!(Test-Path $Config.LogFolder)) { New-Item -ItemType Directory -Path $Config.LogFolder -Force | Out-Null }
        $logPath = Join-Path $Config.LogFolder ("gso-print-intake-" + (Get-Date -Format "yyyyMMdd") + ".log")
        Add-Content -Path $logPath -Value $line
        return
      } catch { Start-Sleep -Milliseconds 400 }
    }
    try { Add-Content -Path (Join-Path $PSScriptRoot ("gso-print-intake-local-" + (Get-Date -Format "yyyyMMdd") + ".log")) -Value $line } catch { }
  }
}

# ---------- claim files (same pattern as the RasterLink watcher) ----------

function Get-IntakeClaimPath([string]$FilePath) { return "$FilePath.gsoclaim" }

function New-IntakeClaim([string]$FilePath, [int]$ClaimStaleMinutes) {
  $claimPath = Get-IntakeClaimPath $FilePath
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      $stream = [System.IO.File]::Open($claimPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("$env:COMPUTERNAME pid=$PID at=$((Get-Date).ToUniversalTime().ToString('o'))")
      $stream.Write($bytes, 0, $bytes.Length); $stream.Close()
      return $true
    } catch {
      if (Test-Path $claimPath) {
        $age = (Get-Date) - (Get-Item $claimPath).LastWriteTime
        if ($age.TotalMinutes -gt $ClaimStaleMinutes) { Remove-Item $claimPath -Force -Confirm:$false; continue }
      }
      return $false
    }
  }
  return $false
}

function Remove-IntakeClaim([string]$FilePath) {
  $claimPath = Get-IntakeClaimPath $FilePath
  if (Test-Path $claimPath) { Remove-Item $claimPath -Force -Confirm:$false }
}

function Test-IntakeFileStable($Config, $File) {
  $item = Get-Item -LiteralPath $File.FullName
  $ageSeconds = ((Get-Date) - $item.LastWriteTime).TotalSeconds
  if ($ageSeconds -lt $Config.StableFileSeconds) { return $false }
  $sizeBefore = $item.Length
  Start-Sleep -Seconds 2
  $after = Get-Item -LiteralPath $File.FullName
  return ($after.Length -eq $sizeBefore -and $after.LastWriteTime -eq $item.LastWriteTime)
}

# ---------- routed ledger (restart-safe dedupe, JSONL in the log folder) ----------

function Get-LedgerPath($Config) { return (Join-Path $Config.LogFolder "gso-print-intake-ledger.jsonl") }

function Read-IntakeLedger($Config) {
  $ledger = @{}
  $path = Get-LedgerPath $Config
  if (Test-Path $path) {
    foreach ($line in (Get-Content $path -ErrorAction SilentlyContinue)) {
      try {
        $entry = $line | ConvertFrom-Json
        if ($entry.hash) { $ledger[[string]$entry.hash] = [string]$entry.decision }
      } catch { }
    }
  }
  return $ledger
}

function Add-IntakeLedgerEntry($Config, [string]$Hash, [string]$FileName, [string]$Decision) {
  if (!(Test-Path $Config.LogFolder)) { New-Item -ItemType Directory -Path $Config.LogFolder -Force | Out-Null }
  $entry = @{ hash = $Hash; fileName = $FileName; decision = $Decision; at = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress
  Add-Content -Path (Get-LedgerPath $Config) -Value $entry
}

# ---------- ERP JSON calls ----------

function Invoke-IntakeJsonPost($Config, [string]$Url, [hashtable]$Payload, [int]$TimeoutSeconds) {
  Add-Type -AssemblyName System.Net.Http | Out-Null
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
  try {
    $jsonBody = $Payload | ConvertTo-Json -Compress
    $content = New-Object System.Net.Http.StringContent($jsonBody, [System.Text.Encoding]::UTF8, "application/json")
    $response = $client.PostAsync($Url, $content).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $json = $null
    try { $json = $body | ConvertFrom-Json } catch { $json = $null }
    return @{ status = [int]$response.StatusCode; body = $body; json = $json; exception = $null }
  } catch {
    return @{ status = 0; body = ""; json = $null; exception = $_.Exception.Message }
  } finally {
    $client.Dispose()
  }
}

# 15H.3: ask the ERP what the CURRENT disposition is for a ledger-blocked
# hash. Returns the result object or $null when the server is unreachable /
# the response is unusable (callers FAIL CLOSED and keep the file untouched).
function Get-IntakeDisposition($Config, [string]$Hash, [string]$FileName) {
  $result = Invoke-IntakeJsonPost $Config $Config.StatusUrl @{ token = $Config.UploadToken; hash = $Hash; fileName = $FileName } 30
  if ($result.exception -or $result.status -ne 200 -or -not $result.json -or -not $result.json.ok) { return $null }
  $rows = @($result.json.results)
  if (-not $rows -or $rows.Count -lt 1) { return $null }
  return $rows[0]
}

function Get-RoutePlan($Config, [string]$FileName, [string]$Subfolder, [string]$FileHash, [long]$FileSize, $FolderFiles = @(), [bool]$IsDryRun = $false) {
  # 15F.0J.5: the full SHA-256 + size ride the PLAN request so the server can
  # match the print-intake identity idempotently (the server never creates a
  # job for a dropped file). Patch D: folderFiles = the names of the other
  # artwork files in the same ticket job folder, so sibling layers of one job
  # are sent to one press.
  return Invoke-IntakeJsonPost $Config $Config.PlanUrl @{ token = $Config.UploadToken; fileName = $FileName; subfolder = $Subfolder; fileHash = $FileHash; fileSize = $FileSize; folderFiles = @($FolderFiles); dryRun = $IsDryRun } 60
}

function Send-IntakeReport($Config, [hashtable]$Outcome) {
  $payload = @{ token = $Config.UploadToken } + $Outcome
  return Invoke-IntakeJsonPost $Config $Config.ReportUrl $payload 60
}

# ---------- go-live cutoff + reserved-folder scanning (pure, self-testable) ----------

$ArtworkExtensions = @('.pdf','.eps','.ai','.tif','.tiff','.png','.jpg','.jpeg')
$ReservedFolderNames = @('_agent-test','_routed-archive')

# A file is ignored when a cutoff is configured and its LastWriteTimeUtc is at
# or before the cutoff (equal = ignored). No cutoff -> everything eligible.
function Test-FileEligibleByCutoff([DateTime]$LastWriteTimeUtc, $CutoffUtc) {
  if ($null -eq $CutoffUtc) { return $true }
  return ($LastWriteTimeUtc -gt $CutoffUtc)
}

# Reserved locations are never scanned: the fixed folder names _agent-test and
# _routed-archive anywhere in the path, plus the configured routed-archive,
# error, and log folders (path-prefix match, case-insensitive).
function Test-PathIsReserved([string]$FullName, $Config) {
  foreach ($name in $ReservedFolderNames) {
    if ($FullName -match ('[\\/]' + [regex]::Escape($name) + '([\\/]|$)')) { return $true }
  }
  foreach ($root in @($Config.RoutedArchiveFolder, $Config.ErrorFolder, $Config.LogFolder)) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $trimmed = $root.TrimEnd('\','/')
    if ($FullName.StartsWith($trimmed, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# ---------- Patch D: ticket-named job folders ----------
# A job folder is a DIRECT child of the inbox root whose name BEGINS with one
# exact job ticket: "GSO-20261118-0003", "GSO-20261118-0003 FLAVAZ",
# "GSO-20261118-0003 - FLAVAZ CAMP". Only the ticket is identity. A folder named
# after a customer / design / "PRINT TODAY", a ticket later in the name, or an
# item ticket is NOT a job folder and is never scanned.
$TicketJobFolderPattern = '^GSO[-_]\d{8}[-_]\d{4}(?!\d)(?![-_]\d)'

function Test-TicketJobFolderName([string]$Name) {
  return (([string]$Name).Trim() -match $TicketJobFolderPattern)
}

# One level only: the ticket folders directly under the root. Never recursive.
function Get-TicketJobFolders($Config) {
  $folders = @()
  if (-not $Config.TicketJobFoldersEnabled) { return $folders }
  foreach ($dir in @(Get-ChildItem -LiteralPath $Config.PrintsForTodayFolder -Directory -ErrorAction SilentlyContinue)) {
    if (-not (Test-TicketJobFolderName $dir.Name)) { continue }
    if (Test-PathIsReserved $dir.FullName $Config) { continue }
    $folders += $dir
  }
  return $folders
}

# Single scan pass: eligible artwork files (sorted oldest-first) plus the
# count of historical files ignored by the cutoff. Ignored files are filtered
# HERE, before detection logging, claims, hashing, ledger lookups, plan calls,
# copies, moves, or reports - they never enter the per-file pipeline at all.
# 15F.0J.4A INBOX CONTRACT: the configured PrintsForTodayFolder is a
# NON-RECURSIVE inbox. Only files DIRECTLY inside the root are processed;
# subfolders (production/archive/work areas like "PRINTS FOR TODAY",
# "600ppi", review/sent/customer folders) are NEVER traversed, regardless of
# name - one new root file is detected on the next poll no matter how many
# thousands of files the subfolders hold. Hashing/ledger lookups happen only
# for top-level eligible files.
# Patch D: plus the files DIRECTLY inside one level of ticket-named job folders
# (Get-TicketJobFolders). Nothing deeper is ever read, and the same cutoff,
# reserved-folder and artwork-extension filters apply to those files.
function Get-EligibleArtworkFiles($Config) {
  $eligible = @()
  $ignoredHistorical = 0
  $all = @(Get-ChildItem -LiteralPath $Config.PrintsForTodayFolder -File -ErrorAction SilentlyContinue)
  foreach ($jobFolder in @(Get-TicketJobFolders $Config)) {
    $all += @(Get-ChildItem -LiteralPath $jobFolder.FullName -File -ErrorAction SilentlyContinue)
  }
  foreach ($file in $all) {
    if ($ArtworkExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
    if (Test-PathIsReserved $file.FullName $Config) { continue }
    if (-not (Test-FileEligibleByCutoff $file.LastWriteTimeUtc $Config.CutoffUtc)) { $ignoredHistorical++; continue }
    $eligible += $file
  }
  return @{ files = @($eligible | Sort-Object LastWriteTime); ignoredHistorical = $ignoredHistorical }
}

# ---------- routing helpers (pure, self-testable) ----------

function Get-HotFolderFor($Config, [string]$Machine) {
  if ($Machine -eq "mimaki") {
    if (-not $Config.MimakiRoutingEnabled) { return @{ folder = $null; reason = "mimaki_routing_disabled_in_config" } }
    if ([string]::IsNullOrWhiteSpace($Config.MimakiHotFolder)) { return @{ folder = $null; reason = "mimaki_hot_folder_not_configured" } }
    return @{ folder = $Config.MimakiHotFolder; reason = $null }
  }
  if ($Machine -eq "roland") {
    if (-not $Config.RolandRoutingEnabled) { return @{ folder = $null; reason = "roland_routing_disabled_in_config" } }
    if ([string]::IsNullOrWhiteSpace($Config.VersaWorksHotFolder)) { return @{ folder = $null; reason = "versaworks_hot_folder_not_confirmed" } }
    return @{ folder = $Config.VersaWorksHotFolder; reason = $null }
  }
  return @{ folder = $null; reason = "unknown_machine_key" }
}

function Get-RoutedFileName([string]$RipName, [string]$OriginalFileName) {
  $ext = [System.IO.Path]::GetExtension($OriginalFileName).ToLowerInvariant()
  $clean = ($RipName -replace '[^A-Za-z0-9._-]+', '_').Trim('_')
  return "$clean$ext"
}

function Get-CollisionSafeIntakeDestination([string]$DestFolder, [string]$FileName, [string]$Sha8) {
  $dest = Join-Path $DestFolder $FileName
  if (!(Test-Path -LiteralPath $dest)) { return $dest }
  $base = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
  $ext = [System.IO.Path]::GetExtension($FileName)
  return Join-Path $DestFolder "$base-$Sha8$ext"
}

function Test-PlanRoute($Json) {
  return ($null -ne $Json) -and ($Json.ok -eq $true) -and ($null -ne $Json.plan) -and ($Json.plan.decision -eq "route")
}

# Patch A: a dry-run response is only trusted when the server says it ran
# read-only AND wrote nothing.
function Test-DryRunHonoured($Json) {
  return ($null -ne $Json) -and ($Json.ok -eq $true) -and ($Json.dryRun -eq $true) -and ($Json.wrote -eq $false)
}

# What WOULD happen, in plain lines (dry run only - nothing is done).
function Format-DryRunOutcome($Plan) {
  if ($Plan.decision -eq "route") {
    $ticket = if ($Plan.itemTicket) { [string]$Plan.itemTicket } else { [string]$Plan.jobTicket }
    return @(
      ("WOULD MATCH: " + $ticket + " (by " + [string]$Plan.rule + ")"),
      ("WOULD ROUTE: " + ([string]$Plan.machine).ToUpperInvariant() + " as " + [string]$Plan.ripName + " (" + [string]$Plan.machineRule + ")")
    )
  }
  $reasons = (@($Plan.reasons) -join "|")
  $label = "NEEDS REVIEW"
  if ($reasons -match "needs_link_to_item") { $label = "NEEDS REVIEW - LINK TO ITEM" }
  elseif ($reasons -match "needs_link_to_job|no_deterministic_match|_not_found_in_eligible_jobs") { $label = "NEEDS REVIEW - LINK TO JOB" }
  elseif ($reasons -match "confirm_print_mode") { $label = "NEEDS REVIEW - CONFIRM PRINT MODE" }
  elseif ($reasons -match "conflicting_printer_tokens|_contradiction|layer_split") { $label = "NEEDS REVIEW - PRINTER CONFLICT" }
  return @(("WOULD REVIEW: " + $label + " (" + $reasons + ")"))
}

function Test-PlanReview($Json) {
  return ($null -ne $Json) -and ($Json.ok -eq $true) -and ($null -ne $Json.plan) -and ($Json.plan.decision -eq "review")
}

# ---------- per-file processing ----------

function Invoke-ProcessIntakeFile($Config, $File, $Ledger) {
  # Dry-run safety: NO claims, no copies, no moves, no reports, no ledger
  # writes - only read-only checks, a plan call, and a log line.
  $claimed = $false
  if (-not $DryRun) {
    if (!(New-IntakeClaim $File.FullName $Config.ClaimStaleMinutes)) {
      Write-IntakeLog $Config "claim_skipped" $File.Name "another instance holds the claim"
      return
    }
    $claimed = $true
  }
  try {
    if (!(Test-IntakeFileStable $Config $File)) {
      Write-IntakeLog $Config "waiting_for_stability" $File.Name "younger than $($Config.StableFileSeconds)s or still changing"
      return
    }
    # v1.10: a file whose path, size and modified time are unchanged has the same content hash.
    $hashKey = "$($File.FullName)|$($File.Length)|$($File.LastWriteTimeUtc.Ticks)"
    if (-not $script:HashCache) { $script:HashCache = @{} }
    if (-not $script:HashCache.ContainsKey($hashKey)) { $script:HashCache[$hashKey] = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    $hash = $script:HashCache[$hashKey]
    $sha8 = $hash.Substring(0, 8)

    if ($Ledger.ContainsKey($hash)) {
      $ledgerDecision = [string]$Ledger[$hash]
      if ($ledgerDecision -eq "routed" -or $ledgerDecision -eq "duplicate") {
        # Successfully handled content stays a pure LOCAL skip - no server
        # call per pass (performance/restart safety unchanged).
        Write-IntakeLog $Config "ledger_skip" $File.Name "already handled as $ledgerDecision (sha8=$sha8)"
        return
      }
      # 15H.3: needs_review/rejected ledger entries are a CACHE - the ERP is
      # the truth. Ask the server for the current disposition; fail closed
      # (skip, file untouched) when it cannot answer.
      if ($DryRun) {
        Write-IntakeLog $Config "dry_run" $File.Name "ledger says $ledgerDecision; disposition reconciliation skipped in dry run (sha8=$sha8)"
        return
      }
      $disposition = Get-IntakeDisposition $Config $hash $File.Name
      if (-not $disposition) {
        Write-IntakeLog $Config "disposition_unreachable" $File.Name "server unavailable - keeping $ledgerDecision skip (sha8=$sha8)"
        return
      }
      $dispo = [string]$disposition.disposition
      if ($disposition.retryAllowed) {
        Write-IntakeLog $Config "disposition_retry" $File.Name "server says $dispo - re-planning (sha8=$sha8)"
        # fall through to the normal plan/route pipeline below
      } elseif ($dispo -eq "already_routed") {
        Write-IntakeLog $Config "disposition_synced" $File.Name "server says already_routed - updating ledger cache (sha8=$sha8)"
        Add-IntakeLedgerEntry $Config $hash $File.Name "routed"
        $Ledger[$hash] = "routed"
        return
      } elseif ($dispo -eq "rejected") {
        Write-IntakeLog $Config "disposition_synced" $File.Name "server says rejected - updating ledger cache (sha8=$sha8)"
        Add-IntakeLedgerEntry $Config $hash $File.Name "rejected"
        $Ledger[$hash] = "rejected"
        return
      } else {
        Write-IntakeLog $Config "ledger_skip" $File.Name "server says $dispo - still blocked (sha8=$sha8)"
        return
      }
    }

    $subfolder = ""
    $parent = Split-Path -Path $File.FullName -Parent
    if ($parent -and ($parent.TrimEnd('\') -ne $Config.PrintsForTodayFolder.TrimEnd('\'))) { $subfolder = Split-Path -Path $parent -Leaf }

    # Patch D: inside a ticket job folder, tell the ERP which other artwork files
    # sit beside this one (names only, cutoff-eligible only) so the layers of one
    # job go to one press.
    $folderFiles = @()
    if ($subfolder -and (Test-TicketJobFolderName $subfolder)) {
      $folderFiles = @(Get-ChildItem -LiteralPath $parent -File -ErrorAction SilentlyContinue |
        Where-Object { ($ArtworkExtensions -contains $_.Extension.ToLowerInvariant()) -and ($_.Name -ne $File.Name) -and (Test-FileEligibleByCutoff $_.LastWriteTimeUtc $Config.CutoffUtc) } |
        Select-Object -First 60 | ForEach-Object { $_.Name })
    }

    $planResult = Get-RoutePlan $Config $File.Name $subfolder $hash $File.Length $folderFiles ([bool]$DryRun)
    if ($planResult.exception -or $planResult.status -eq 0 -or $planResult.status -ge 500) {
      Write-IntakeLog $Config "plan_unreachable" $File.Name "status=$($planResult.status) exception=$($planResult.exception); will retry next pass"
      return
    }
    if ($planResult.status -eq 401 -or $planResult.status -eq 403) {
      Write-IntakeLog $Config "fatal_config" $File.Name "HTTP $($planResult.status) token rejected - fix the config token"
      throw "fatal_config"
    }
    if (-not (Test-PlanRoute $planResult.json) -and -not (Test-PlanReview $planResult.json)) {
      Write-IntakeLog $Config "plan_invalid" $File.Name "status=$($planResult.status); will retry next pass"
      return
    }

    if ($DryRun) {
      # Patch A: the SERVER must confirm it ran read-only. If it did not, stop -
      # a dry run that might have written is not a dry run.
      if (-not (Test-DryRunHonoured $planResult.json)) {
        Write-IntakeLog $Config "dry_run_not_honoured" $File.Name "the server did not confirm a read-only plan; stopping"
        throw "fatal_dry_run"
      }
      $plan = $planResult.json.plan
      $would = Format-DryRunOutcome $plan
      Write-Host ("DRY RUN  " + $File.Name)
      foreach ($line in $would) { Write-Host ("  " + $line) }
      Write-IntakeLog $Config "dry_run" $File.Name (($would -join "; ") + " (read-only: server wrote nothing; no claim, no copy, no move, no report)")
      return
    }

    $plan = $planResult.json.plan
    if ($plan.decision -eq "route") {
      $hot = Get-HotFolderFor $Config ([string]$plan.machine)
      if (-not $hot.folder) {
        # Machine resolved by the ERP but routing to it is disabled locally:
        # leave the original in place and record needs_review.
        Write-IntakeLog $Config "route_blocked" $File.Name "machine=$($plan.machine) reason=$($hot.reason)"
        Send-IntakeReport $Config @{ fileName = $File.Name; decision = "needs_review"; rule = [string]$plan.rule; reason = $hot.reason; jobTicket = [string]$plan.jobTicket; itemTicket = [string]$plan.itemTicket; ripName = [string]$plan.ripName; machine = [string]$plan.machine; fileHash8 = $sha8 } | Out-Null
        Add-IntakeLedgerEntry $Config $hash $File.Name "needs_review"
        $Ledger[$hash] = "needs_review"
        return
      }
      if (!(Test-Path -LiteralPath $hot.folder)) {
        Write-IntakeLog $Config "hot_folder_unreachable" $File.Name "machine=$($plan.machine); will retry next pass"
        return
      }
      $routedName = Get-RoutedFileName ([string]$plan.ripName) $File.Name
      $dest = Get-CollisionSafeIntakeDestination $hot.folder $routedName $sha8
      Copy-Item -LiteralPath $File.FullName -Destination $dest -Force -Confirm:$false
      $copied = Get-Item -LiteralPath $dest
      if ($copied.Length -ne $File.Length) {
        Write-IntakeLog $Config "copy_verify_failed" $File.Name "dest=$([System.IO.Path]::GetFileName($dest)); will retry next pass"
        Send-IntakeReport $Config @{ fileName = $File.Name; decision = "failed"; reason = "copy_length_mismatch"; fileHash8 = $sha8 } | Out-Null
        return
      }
      Write-IntakeLog $Config "routed_to_hot_folder" $File.Name "as=$([System.IO.Path]::GetFileName($dest)) machine=$($plan.machine) rule=$($plan.machineRule) matchedBy=$($plan.rule)"
      Send-IntakeReport $Config @{ fileName = $File.Name; decision = "routed"; rule = [string]$plan.rule; jobId = [string]$plan.jobId; jobTicket = [string]$plan.jobTicket; itemTicket = [string]$plan.itemTicket; ripName = [string]$plan.ripName; machine = [string]$plan.machine; fileHash8 = $sha8; fileHash = $hash } | Out-Null
      # Preserve the original: move (never delete) into the routed archive.
      if (!(Test-Path $Config.RoutedArchiveFolder)) { New-Item -ItemType Directory -Path $Config.RoutedArchiveFolder -Force | Out-Null }
      $archiveDest = Get-CollisionSafeIntakeDestination $Config.RoutedArchiveFolder $File.Name $sha8
      Move-Item -LiteralPath $File.FullName -Destination $archiveDest -Force -Confirm:$false
      Write-IntakeLog $Config "original_archived" $File.Name "dest=$([System.IO.Path]::GetFileName($archiveDest))"
      Add-IntakeLedgerEntry $Config $hash $File.Name "routed"
      $Ledger[$hash] = "routed"
      return
    }

    # Review: the original STAYS EXACTLY WHERE STAFF PUT IT. No moves.
    $reason = ($plan.reasons -join "|")
    Write-IntakeLog $Config "needs_review" $File.Name "reasons=$reason"
    Send-IntakeReport $Config @{ fileName = $File.Name; decision = "needs_review"; reason = $reason; fileHash8 = $sha8; fileHash = $hash } | Out-Null
    Add-IntakeLedgerEntry $Config $hash $File.Name "needs_review"
    $Ledger[$hash] = "needs_review"
  } finally {
    if ($claimed) { Remove-IntakeClaim $File.FullName }
  }
}

# ---------- health ----------

function Invoke-IntakeHealth($Config) {
  Write-Host "=== gso-print-intake-agent health ($ScriptVersion) ==="
  Write-Host ("config loaded: OK (poll=$($Config.PollSeconds)s stable=$($Config.StableFileSeconds)s mimakiRouting=$($Config.MimakiRoutingEnabled) rolandRouting=$($Config.RolandRoutingEnabled))")
  Write-Host ("upload token: " + (Get-MaskedToken $Config.UploadToken))
  $folders = @(
    @("prints-for-today", $Config.PrintsForTodayFolder),
    @("routed-archive", $Config.RoutedArchiveFolder),
    @("error (reserved)", $Config.ErrorFolder),
    @("log", $Config.LogFolder)
  )
  if ($Config.MimakiRoutingEnabled) { $folders += ,@("mimaki-hot", $Config.MimakiHotFolder) }
  if ($Config.RolandRoutingEnabled) { $folders += ,@("versaworks-hot", $Config.VersaWorksHotFolder) }
  foreach ($pair in $folders) {
    $label = $pair[0]; $path = $pair[1]
    if ([string]::IsNullOrWhiteSpace($path)) { Write-Host "$label folder: NOT CONFIGURED"; continue }
    if (Test-Path $path) { Write-Host "$label folder: OK (reachable) $path" } else { Write-Host "$label folder: NOT REACHABLE $path" }
  }
  try {
    $get = Invoke-WebRequest -Uri $Config.PlanUrl -Method GET -UseBasicParsing -TimeoutSec 20
    Write-Host "plan endpoint reachable: OK (GET $($get.StatusCode))"
  } catch { Write-Host "plan endpoint reachable: FAILED ($($_.Exception.Message))" }
  # Token probe: posting token without fileName returns 400 when the token is
  # accepted and 401/403 when it is not. Zero writes either way.
  $probe = Invoke-IntakeJsonPost $Config $Config.PlanUrl @{ token = $Config.UploadToken } 20
  if ($probe.status -eq 400) { Write-Host "token accepted: OK (400 missing-fileName as expected, nothing written)" }
  elseif ($probe.status -eq 401 -or $probe.status -eq 403) { Write-Host "token accepted: REJECTED (HTTP $($probe.status)) - check the config token" }
  else { Write-Host "token accepted: INCONCLUSIVE (HTTP $($probe.status) $($probe.exception))" }
  if ($Config.CutoffUtc) {
    Write-Host ("go-live cutoff (ProcessFilesModifiedAfterUtc): " + $Config.CutoffUtc.ToString('yyyy-MM-ddTHH:mm:ssZ'))
  } else {
    Write-Host "go-live cutoff (ProcessFilesModifiedAfterUtc): NOT SET - every artwork file in the folder is eligible"
  }
  $scan = Get-EligibleArtworkFiles $Config
  Write-Host ("flood cap: more than $($Config.MaxEligibleFilesPerScan) eligible files in one scan = process NONE and stop")
  if ($null -eq $Config.CutoffUtc) { Write-Host "REFUSED: no go-live cutoff is configured - the agent will not process anything until ProcessFilesModifiedAfterUtc is set." }
  elseif (-not (Test-EligibleCountWithinCap $scan.files.Count $Config.MaxEligibleFilesPerScan)) { Write-Host "SAFETY STOP - TOO MANY ELIGIBLE FILES ($($scan.files.Count) > $($Config.MaxEligibleFilesPerScan)): the agent would process none of them." }
  Write-Host ("ticket job folders (one level, name starts with a job ticket): " + $(if ($Config.TicketJobFoldersEnabled) { "ON - " + @(Get-TicketJobFolders $Config).Count + " found" } else { "OFF (root files only)" }))
  Write-Host ("historical files ignored by cutoff: " + $scan.ignoredHistorical)
  Write-Host ("eligible pending artwork files: " + $scan.files.Count)
  if ($null -eq $Config.CutoffUtc -and $scan.files.Count -gt 100) {
    Write-Host "WARNING: no cutoff is set and $($scan.files.Count) files are eligible - set ProcessFilesModifiedAfterUtc before enabling routing."
  }
}

# ---------- offline self-test ----------

function Invoke-IntakeSelfTest {
  $script:failures = 0
  $temp = Join-Path $env:TEMP ("gso-intake-selftest-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  function Assert($name, $condition) {
    if ($condition) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:failures++ }
  }
  try {
    # routed filename composition (exact ERP RIP name + original extension)
    Assert "routed name = ripName + lowercased original extension" ((Get-RoutedFileName "GSO-20260718-0001-01" "My Art File.PDF") -eq "GSO-20260718-0001-01.pdf")
    Assert "routed name sanitizes unsafe characters" ((Get-RoutedFileName 'GSO 1/bad:name' "x.png") -eq "GSO_1_bad_name.png")

    # collision-safe destination is deterministic by content hash
    $destDir = Join-Path $temp "hot"; New-Item -ItemType Directory -Path $destDir | Out-Null
    $first = Get-CollisionSafeIntakeDestination $destDir "job.pdf" "abcd1234"
    Assert "no-collision keeps exact rip name" ($first -eq (Join-Path $destDir "job.pdf"))
    Set-Content -Path (Join-Path $destDir "job.pdf") -Value "occupied"
    $second = Get-CollisionSafeIntakeDestination $destDir "job.pdf" "abcd1234"
    $third = Get-CollisionSafeIntakeDestination $destDir "job.pdf" "abcd1234"
    Assert "collision adds content-hash suffix deterministically" (($second -eq (Join-Path $destDir "job-abcd1234.pdf")) -and ($second -eq $third))

    # claim locking: acquire, refuse while held, stale reclaim, release
    $lockTarget = Join-Path $temp "art.pdf"; Set-Content -Path $lockTarget -Value "x"
    Assert "claim acquired" (New-IntakeClaim $lockTarget 30)
    Assert "second claim refused while held" (-not (New-IntakeClaim $lockTarget 30))
    (Get-Item (Get-IntakeClaimPath $lockTarget)).LastWriteTime = (Get-Date).AddHours(-2)
    Assert "stale claim reclaimed" (New-IntakeClaim $lockTarget 30)
    Remove-IntakeClaim $lockTarget
    Assert "claim released" (-not (Test-Path (Get-IntakeClaimPath $lockTarget)))

    # ledger: append + read + dedupe key by content hash
    $ledgerConfig = @{ LogFolder = $temp }
    Add-IntakeLedgerEntry $ledgerConfig "hash-a" "one.pdf" "routed"
    Add-IntakeLedgerEntry $ledgerConfig "hash-b" "two with spaces.pdf" "needs_review"
    $ledger = Read-IntakeLedger $ledgerConfig
    Assert "ledger round-trips decisions by hash" (($ledger["hash-a"] -eq "routed") -and ($ledger["hash-b"] -eq "needs_review"))
    Assert "ledger miss stays miss" (-not $ledger.ContainsKey("hash-c"))

    # plan-response classification from canned JSON
    $routePlan = '{"ok":true,"plan":{"decision":"route","machine":"roland","machineRule":"white_or_gloss","rule":"item_ticket","ripName":"GSO-20260718-0001-01"}}' | ConvertFrom-Json
    $reviewPlan = '{"ok":true,"plan":{"decision":"review","reasons":["no_deterministic_match"]}}' | ConvertFrom-Json
    $errorPlan = '{"ok":false,"error":"x"}' | ConvertFrom-Json
    Assert "route plan recognized" (Test-PlanRoute $routePlan)
    Assert "route plan carries machine rule and match rule" (($routePlan.plan.machineRule -eq "white_or_gloss") -and ($routePlan.plan.rule -eq "item_ticket") -and ($routePlan.plan.machine -eq "roland"))
    Assert "review plan recognized" ((Test-PlanReview $reviewPlan) -and (-not (Test-PlanRoute $reviewPlan)))
    Assert "error plan rejected" ((-not (Test-PlanRoute $errorPlan)) -and (-not (Test-PlanReview $errorPlan)))

    # machine gates: disabled/unconfigured folders never route
    $gateConfig = @{ MimakiRoutingEnabled = $false; MimakiHotFolder = "X:\hot"; RolandRoutingEnabled = $true; VersaWorksHotFolder = "" }
    Assert "disabled mimaki routing blocks with reason" ((Get-HotFolderFor $gateConfig "mimaki").reason -eq "mimaki_routing_disabled_in_config")
    Assert "unconfirmed versaworks folder blocks with reason" ((Get-HotFolderFor $gateConfig "roland").reason -eq "versaworks_hot_folder_not_confirmed")
    Assert "unknown machine key blocks" ((Get-HotFolderFor $gateConfig "other").reason -eq "unknown_machine_key")
    $onConfig = @{ MimakiRoutingEnabled = $true; MimakiHotFolder = "X:\hot"; RolandRoutingEnabled = $false; VersaWorksHotFolder = "" }
    Assert "enabled mimaki routing returns the folder" ((Get-HotFolderFor $onConfig "mimaki").folder -eq "X:\hot")

    # JSON payload building survives spaces and quotes in filenames
    $payload = @{ token = "secret-token"; fileName = 'My "Quoted" File Name.pdf'; subfolder = "GSO-20260718-0001 - Cust - Jar" } | ConvertTo-Json -Compress
    $roundTrip = $payload | ConvertFrom-Json
    Assert "json payload round-trips spaces and quotes" ($roundTrip.fileName -eq 'My "Quoted" File Name.pdf')

    # token masking never leaks the raw token
    $mask = Get-MaskedToken "supersecrettoken1234"
    Assert "token mask hides the token" ($mask -notmatch "supersecrettoken1234" -and $mask -match "supe\*\*\*\*")

    # go-live cutoff (13A.6G): parse, boundary semantics, reserved folders,
    # and proof that ignored files never enter the processing pipeline.
    $cutoff = ConvertTo-CutoffUtc "2026-07-19T17:20:00Z"
    Assert "cutoff parses ISO-8601 Z to UTC" ($cutoff.Kind -eq [System.DateTimeKind]::Utc -and $cutoff.Hour -eq 17 -and $cutoff.Minute -eq 20)
    Assert "empty cutoff means no cutoff" ($null -eq (ConvertTo-CutoffUtc ""))
    $badCutoff = $false; try { ConvertTo-CutoffUtc "not-a-date" | Out-Null } catch { $badCutoff = $true }
    Assert "invalid cutoff fails loudly instead of processing everything" $badCutoff
    Assert "file older than cutoff is ignored" (-not (Test-FileEligibleByCutoff $cutoff.AddSeconds(-1) $cutoff))
    Assert "file exactly equal to cutoff is ignored" (-not (Test-FileEligibleByCutoff $cutoff $cutoff))
    Assert "file newer than cutoff is eligible" (Test-FileEligibleByCutoff $cutoff.AddSeconds(1) $cutoff)
    Assert "no cutoff leaves files eligible" (Test-FileEligibleByCutoff $cutoff $null)

    $scanRoot = Join-Path $temp "prints"
    foreach ($sub in @("", "_agent-test", "_routed-archive", "jobsub", "PRINTS FOR TODAY", "PRINTS FOR TODAY\600ppi", "deep\a\b\c")) { New-Item -ItemType Directory -Path (Join-Path $scanRoot $sub) -Force | Out-Null }
    $scanConfig = @{ PrintsForTodayFolder = $scanRoot; RoutedArchiveFolder = (Join-Path $temp "archive"); ErrorFolder = (Join-Path $temp "err"); LogFolder = (Join-Path $temp "logs"); CutoffUtc = $cutoff }
    New-Item -ItemType Directory -Path $scanConfig.RoutedArchiveFolder -Force | Out-Null
    $old = Join-Path $scanRoot "historical.pdf"; Set-Content -Path $old -Value "old"
    (Get-Item $old).LastWriteTimeUtc = $cutoff.AddDays(-30)
    $atCutoff = Join-Path $scanRoot "at-cutoff.pdf"; Set-Content -Path $atCutoff -Value "edge"
    (Get-Item $atCutoff).LastWriteTimeUtc = $cutoff
    # 15F.0J.4A: ROOT files are the inbox - eligible in every artwork format.
    $fresh = Join-Path $scanRoot "new art.pdf"; Set-Content -Path $fresh -Value "new"
    (Get-Item $fresh).LastWriteTimeUtc = $cutoff.AddMinutes(5)
    $freshAi = Join-Path $scanRoot "vector.ai"; Set-Content -Path $freshAi -Value "v"
    (Get-Item $freshAi).LastWriteTimeUtc = $cutoff.AddMinutes(6)
    $freshTif = Join-Path $scanRoot "raster.tiff"; Set-Content -Path $freshTif -Value "r"
    (Get-Item $freshTif).LastWriteTimeUtc = $cutoff.AddMinutes(7)
    $freshPng = Join-Path $scanRoot "image.png"; Set-Content -Path $freshPng -Value "p"
    (Get-Item $freshPng).LastWriteTimeUtc = $cutoff.AddMinutes(8)
    # subfolder files (one level and several levels deep) are NEVER scanned
    $inSub = Join-Path $scanRoot "jobsub\sub art.pdf"; Set-Content -Path $inSub -Value "s"
    (Get-Item $inSub).LastWriteTimeUtc = $cutoff.AddMinutes(5)
    $inProd = Join-Path $scanRoot "PRINTS FOR TODAY\working.pdf"; Set-Content -Path $inProd -Value "w"
    (Get-Item $inProd).LastWriteTimeUtc = $cutoff.AddMinutes(5)
    $inDeep = Join-Path $scanRoot "deep\a\b\c\deep.pdf"; Set-Content -Path $inDeep -Value "x"
    (Get-Item $inDeep).LastWriteTimeUtc = $cutoff.AddMinutes(5)
    $inTest = Join-Path $scanRoot "_agent-test\test.pdf"; Set-Content -Path $inTest -Value "t"
    (Get-Item $inTest).LastWriteTimeUtc = $cutoff.AddMinutes(5)
    $inRoutedName = Join-Path $scanRoot "_routed-archive\done.pdf"; Set-Content -Path $inRoutedName -Value "d"
    (Get-Item $inRoutedName).LastWriteTimeUtc = $cutoff.AddMinutes(5)
    $inArchiveRoot = Join-Path $scanConfig.RoutedArchiveFolder "archived.pdf"; Set-Content -Path $inArchiveRoot -Value "a"
    (Get-Item $inArchiveRoot).LastWriteTimeUtc = $cutoff.AddMinutes(5)
    $notArt = Join-Path $scanRoot "notes.txt"; Set-Content -Path $notArt -Value "n"
    $scanOut = Get-EligibleArtworkFiles $scanConfig
    Assert "root artwork files (pdf/ai/tiff/png) are eligible; nothing else" (($scanOut.files.Count -eq 4) -and (@($scanOut.files | Where-Object { $_.Name -in @("new art.pdf","vector.ai","raster.tiff","image.png") }).Count -eq 4))
    Assert "one-level and multi-level subfolder files are ignored (non-recursive inbox)" (@($scanOut.files | Where-Object { $_.FullName -match "jobsub|PRINTS FOR TODAY|deep" }).Count -eq 0)
    Assert "historical count covers older and at-cutoff ROOT files" ($scanOut.ignoredHistorical -eq 2)
    Assert "reserved folder names and configured roots are never scanned" (@($scanOut.files | Where-Object { $_.FullName -match "_agent-test|_routed-archive" -or $_.FullName.StartsWith($scanConfig.RoutedArchiveFolder) }).Count -eq 0)
    Assert "path reservation logic unchanged (defense in depth under non-recursive scan)" ((Test-PathIsReserved $inTest $scanConfig) -and (Test-PathIsReserved $inRoutedName $scanConfig) -and (Test-PathIsReserved $inArchiveRoot $scanConfig) -and (-not (Test-PathIsReserved $fresh $scanConfig)))
    # many nested files never slow or leak into the scan: only root files return
    $bulkDir = Join-Path $scanRoot "PRINTS FOR TODAY\600ppi"
    for ($i = 1; $i -le 200; $i++) { Set-Content -Path (Join-Path $bulkDir "bulk-$i.pdf") -Value "b" }
    $scanOut2 = Get-EligibleArtworkFiles $scanConfig
    Assert "hundreds of nested files do not enter the scan (root-only result unchanged)" ($scanOut2.files.Count -eq 4)
    # Ignored files never reach claims/hash/API/report: the scan result is the
    # ONLY input to the processing loop, and scanning created no claim files.
    Assert "scan itself creates no claim files for ignored files" (@(Get-ChildItem -Path $scanRoot -Recurse -Filter "*.gsoclaim" -File).Count -eq 0)

    # ---- Patch D: ticket-named job folders (one level, exact ticket at the start) ----
    Assert "ticket folder names: ticket only, ticket + customer, ticket - customer, underscore form" ((Test-TicketJobFolderName "GSO-20260718-0001") -and (Test-TicketJobFolderName "GSO-20260718-0001 FLAVAZ") -and (Test-TicketJobFolderName "GSO-20260718-0001 - FLAVAZ CAMP") -and (Test-TicketJobFolderName "gso_20260718_0001 x"))
    $notTicketNames = @("FLAVAZ", "KRUD", "PRINT TODAY", "PRINTS FOR TODAY", "FLAVAZ GSO-20260718-0001", "GSO-2026-0001", "GSO-20260718-00011", "GSO-20260718-0001-01 item", "GSO 20260718 0001", "")
    Assert "customer / design / late-ticket / item-ticket / malformed folder names are never job folders" (@($notTicketNames | Where-Object { Test-TicketJobFolderName $_ }).Count -eq 0)
    $jobDir = Join-Path $scanRoot "GSO-20260718-0001 FLAVAZ"
    foreach ($sub in @("GSO-20260718-0001 FLAVAZ", "GSO-20260718-0001 FLAVAZ\proofs", "FLAVAZ GSO-20260718-0002", "FLAVAZ")) { New-Item -ItemType Directory -Path (Join-Path $scanRoot $sub) -Force | Out-Null }
    $layerC = Join-Path $jobDir "flavaz_og_3oz_F_cmyk.pdf"; Set-Content -Path $layerC -Value "c"
    (Get-Item $layerC).LastWriteTimeUtc = $cutoff.AddMinutes(9)
    $layerG = Join-Path $jobDir "flavaz_og_3oz_F_g.pdf"; Set-Content -Path $layerG -Value "g"
    (Get-Item $layerG).LastWriteTimeUtc = $cutoff.AddMinutes(10)
    $jobOld = Join-Path $jobDir "old proof.pdf"; Set-Content -Path $jobOld -Value "o"
    (Get-Item $jobOld).LastWriteTimeUtc = $cutoff.AddDays(-10)
    Set-Content -Path (Join-Path $jobDir "notes.txt") -Value "n"
    $jobNested = Join-Path $jobDir "proofs\nested.pdf"; Set-Content -Path $jobNested -Value "x"
    (Get-Item $jobNested).LastWriteTimeUtc = $cutoff.AddMinutes(9)
    $lateTicketFile = Join-Path $scanRoot "FLAVAZ GSO-20260718-0002\late.pdf"; Set-Content -Path $lateTicketFile -Value "l"
    (Get-Item $lateTicketFile).LastWriteTimeUtc = $cutoff.AddMinutes(9)
    $customerFile = Join-Path $scanRoot "FLAVAZ\customer.pdf"; Set-Content -Path $customerFile -Value "k"
    (Get-Item $customerFile).LastWriteTimeUtc = $cutoff.AddMinutes(9)
    $scanOff = Get-EligibleArtworkFiles $scanConfig
    Assert "ticket folders are not scanned when the switch is off (root-only result unchanged)" ($scanOff.files.Count -eq 4)
    $scanConfig.TicketJobFoldersEnabled = $true
    $scanJob = Get-EligibleArtworkFiles $scanConfig
    Assert "files directly inside a ticket job folder are eligible (root 4 + 2 layer files)" (($scanJob.files.Count -eq 6) -and (@($scanJob.files | Where-Object { $_.Name -in @("flavaz_og_3oz_F_cmyk.pdf","flavaz_og_3oz_F_g.pdf") }).Count -eq 2))
    Assert "a file nested below a ticket folder is NOT processed (one level only)" (@($scanJob.files | Where-Object { $_.Name -eq "nested.pdf" }).Count -eq 0)
    Assert "customer-named, ticket-not-at-start and other subfolders stay ignored" (@($scanJob.files | Where-Object { $_.FullName -match "FLAVAZ GSO-|\\FLAVAZ\\|jobsub|PRINTS FOR TODAY|deep" }).Count -eq 0)
    Assert "the go-live cutoff still applies inside a ticket folder" (($scanJob.ignoredHistorical -eq 3) -and (@($scanJob.files | Where-Object { $_.Name -eq "old proof.pdf" }).Count -eq 0))
    Assert "non-artwork files in a ticket folder are ignored" (@($scanJob.files | Where-Object { $_.Name -eq "notes.txt" }).Count -eq 0)
    Assert "exactly one ticket job folder is found; reserved names never are" ((@(Get-TicketJobFolders $scanConfig).Count -eq 1) -and (@(Get-TicketJobFolders $scanConfig | Where-Object { $_.Name -match "_agent-test|_routed-archive" }).Count -eq 0))
    Assert "scanning ticket folders creates no claim files" (@(Get-ChildItem -Path $scanRoot -Recurse -Filter "*.gsoclaim" -File).Count -eq 0)
    # ---- Patch A: flood cap, mandatory cutoff, read-only dry run ----
    Assert "flood cap: 60 or fewer may proceed" ((Test-EligibleCountWithinCap 0 60) -and (Test-EligibleCountWithinCap 1 60) -and (Test-EligibleCountWithinCap 60 60))
    Assert "flood cap: 61 or more processes none" ((-not (Test-EligibleCountWithinCap 61 60)) -and (-not (Test-EligibleCountWithinCap 10000 60)))
    Assert "flood cap defaults to 60 and can be lowered but never raised" (((Get-EffectiveFloodCap $null) -eq 60) -and ((Get-EffectiveFloodCap 25) -eq 25) -and ((Get-EffectiveFloodCap 500) -eq 60) -and ((Get-EffectiveFloodCap 0) -eq 60) -and ((Get-EffectiveFloodCap "abc") -eq 60))
    $floodDir = Join-Path $scanRoot "GSO-20260718-0009 FLOOD"; New-Item -ItemType Directory -Path $floodDir -Force | Out-Null
    for ($i = 1; $i -le 61; $i++) { $ff = Join-Path $floodDir "flood-$i.pdf"; Set-Content -Path $ff -Value "f"; (Get-Item $ff).LastWriteTimeUtc = $cutoff.AddMinutes(11) }
    $scanFlood = Get-EligibleArtworkFiles $scanConfig
    Assert "a real scan above the cap is refused as a whole (67 eligible > 60)" (($scanFlood.files.Count -eq 67) -and (-not (Test-EligibleCountWithinCap $scanFlood.files.Count 60)))
    Assert "the cutoff is what keeps historical files out: with it only new files count" (@($scanFlood.files | Where-Object { $_.LastWriteTimeUtc -le $cutoff }).Count -eq 0)
    $dryOk = '{"ok":true,"dryRun":true,"wrote":false,"plan":{"decision":"route","rule":"job_subfolder","jobTicket":"GSO-20260718-0001","itemTicket":"GSO-20260718-0001-01","ripName":"GSO-20260718-0001-01","machine":"roland","machineRule":"gloss_requires_roland"}}' | ConvertFrom-Json
    $dryNoFlag = '{"ok":true,"plan":{"decision":"route"}}' | ConvertFrom-Json
    $dryWrote = '{"ok":true,"dryRun":true,"wrote":true,"plan":{"decision":"route"}}' | ConvertFrom-Json
    Assert "dry run is trusted only when the server confirms dryRun=true and wrote=false" ((Test-DryRunHonoured $dryOk) -and (-not (Test-DryRunHonoured $dryNoFlag)) -and (-not (Test-DryRunHonoured $dryWrote)) -and (-not (Test-DryRunHonoured $null)))
    $wouldRoute = Format-DryRunOutcome $dryOk.plan
    Assert "dry run shows WOULD MATCH + WOULD ROUTE" (($wouldRoute[0] -eq "WOULD MATCH: GSO-20260718-0001-01 (by job_subfolder)") -and ($wouldRoute[1] -eq "WOULD ROUTE: ROLAND as GSO-20260718-0001-01 (gloss_requires_roland)"))
    $wouldReview = Format-DryRunOutcome (('{"decision":"review","reasons":["no_deterministic_match","needs_link_to_job"]}' | ConvertFrom-Json))
    Assert "dry run shows WOULD REVIEW with the queue label" (@($wouldReview)[0] -eq "WOULD REVIEW: NEEDS REVIEW - LINK TO JOB (no_deterministic_match|needs_link_to_job)")
    $dryPayload = @{ token = "t"; fileName = "a.pdf"; dryRun = $true } | ConvertTo-Json -Compress
    Assert "plan payload carries dryRun as a JSON boolean" ($dryPayload -match '"dryRun":true')
    $planPayload = @{ token = "t"; fileName = "a.pdf"; subfolder = "GSO-20260718-0001 FLAVAZ"; fileHash = "h"; fileSize = 1; folderFiles = @("flavaz_og_3oz_F_g.pdf") } | ConvertTo-Json -Compress
    Assert "plan payload carries sibling names as a JSON array (even a single one)" ($planPayload -match '"folderFiles":\["flavaz_og_3oz_F_g\.pdf"\]')
  } finally {
    Remove-Item $temp -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host ("self-test failures: " + $script:failures)
  if ($script:failures -gt 0) { exit 1 } else { exit 0 }
}

# ---------- main ----------

if ($SelfTest) { Invoke-IntakeSelfTest }

$config = Read-IntakeConfig $ConfigPath
if ($Health) { Invoke-IntakeHealth $config; exit 0 }

# Patch A: NO CUTOFF = NO PROCESSING. The agent never falls back to "every file
# in the folder is eligible" (the live folder holds 10,000+ historical files).
if ($null -eq $config.CutoffUtc) {
  Write-IntakeLog $config "refused_no_cutoff" "-" "ProcessFilesModifiedAfterUtc is not set - refusing to process anything"
  Write-Host "REFUSED TO START - NO GO-LIVE CUTOFF. Set ProcessFilesModifiedAfterUtc in the config."
  exit 4
}

$modeLabel = if ($DryRun) { "dry-run" } elseif ($Loop) { "loop" } else { "once" }
Write-IntakeLog $config "agent_started" "-" "version=$ScriptVersion mode=$modeLabel source=$($config.PrintsForTodayFolder)"

$lastScanSummary = ""
while ($true) {
  # v1.10: nothing thrown during a pass ends the loop (exit 2 / 3 / 5 are not
  # exceptions and still stop the agent on purpose). The next pass retries.
  try {
  $ledger = Read-IntakeLedger $config
  # 15H.5: ONE bounded pending-retries call per pass. Hashes the server says
  # to re-process (owner Reprint / release / assignment) override the local
  # ledger cache so an already-routed file can be re-delivered when staff
  # place it back into Prints For Today. Server unreachable = skip quietly
  # (fail closed - normal processing continues, nothing re-routes).
  if (-not $DryRun) {
    $pendingResult = Invoke-IntakeJsonPost $config $config.StatusUrl @{ token = $config.UploadToken; pending = $true; agentVersion = $ScriptVersion; agentHost = $env:COMPUTERNAME } 20
    if (-not $pendingResult.exception -and $pendingResult.status -eq 200 -and $pendingResult.json -and $pendingResult.json.ok) {
      foreach ($pendingRow in @($pendingResult.json.pending)) {
        if ($pendingRow -and $pendingRow.hash -and $ledger.ContainsKey([string]$pendingRow.hash)) {
          Write-IntakeLog $config "pending_retry" ([string]$pendingRow.fileName) "server requests re-processing (sha8=$(([string]$pendingRow.hash).Substring(0,8))) - ledger cache overridden"
          $ledger[[string]$pendingRow.hash] = "retry_pending"
        }
      }
    }
  }
  $scan = Get-EligibleArtworkFiles $config
  $files = $scan.files
  # One concise pass-level line (never one line per historical file), and only
  # when the counts change so -Loop mode does not spam the log.
  $scanSummary = "eligible=$($files.Count) historical_files_ignored=$($scan.ignoredHistorical)"
  if ($scanSummary -ne $lastScanSummary) {
    Write-IntakeLog $config "scan_summary" "-" ($scanSummary + $(if ($config.CutoffUtc) { " cutoffUtc=$($config.CutoffUtc.ToString('yyyy-MM-ddTHH:mm:ssZ'))" } else { " cutoffUtc=(not set)" }))
    $lastScanSummary = $scanSummary
  }
  # Patch A: flood cap. Above the cap NOTHING is processed and the agent exits
  # (a scheduled -Loop stays stopped until a person restarts it).
  if (-not (Test-EligibleCountWithinCap $files.Count $config.MaxEligibleFilesPerScan)) {
    Write-IntakeLog $config "safety_stop" "-" "SAFETY STOP - TOO MANY ELIGIBLE FILES: $($files.Count) eligible in one scan (cap $($config.MaxEligibleFilesPerScan)). Processed NONE. Check the watch folder and the cutoff, then restart the agent."
    Write-Host "SAFETY STOP - TOO MANY ELIGIBLE FILES ($($files.Count) > $($config.MaxEligibleFilesPerScan)). Processed none."
    exit 3
  }
  if ($DryRun) { Write-Host ("DRY RUN (read-only) - eligible files: " + $files.Count + "; historical files ignored by cutoff: " + $scan.ignoredHistorical) }
  foreach ($file in $files) {
    Write-IntakeLog $config "detected" $file.Name "size=$($file.Length)"
    try {
      Invoke-ProcessIntakeFile $config $file $ledger
    } catch {
      if ($_.Exception.Message -eq "fatal_config") { Write-IntakeLog $config "agent_stopped" "-" "fatal config error; fix token and restart"; exit 2 }
      if ($_.Exception.Message -eq "fatal_dry_run") { Write-Host "DRY RUN STOPPED - the server did not confirm a read-only plan."; exit 5 }
      Write-IntakeLog $config "file_error" $file.Name "unexpected: $($_.Exception.Message); file left in place"
    }
  }
  } catch {
    Write-IntakeLog $config "pass_error" "-" "unexpected: $($_.Exception.Message); retrying next pass"
  }
  if (-not $Loop -or $Once -or $DryRun) { break }
  Start-Sleep -Seconds $config.PollSeconds
}
Write-IntakeLog $config "agent_finished" "-" "pass complete"
