# GSO Print Intake Agent (Patch 13A.6G).
# Watches "Prints For Today", asks the ERP for a deterministic routing plan
# (exact item/job ticket, stored filename, or job subfolder identity - never
# fuzzy), copies the file into the correct machine hot folder under the exact
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
#   -DryRun     plan + log only; no copies, no moves, no reports
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

$ScriptVersion = "gso-print-intake-agent/1.0 (13A.6G)"
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
  }
  foreach ($key in @("ApiBaseUrl","UploadToken","PrintsForTodayFolder","RoutedArchiveFolder","LogFolder")) {
    if ([string]::IsNullOrWhiteSpace($config[$key])) { throw "Config missing required value: $key" }
  }
  $config.PlanUrl = ($config.ApiBaseUrl.TrimEnd('/')) + "/api/print-intake/route-plan"
  $config.ReportUrl = ($config.ApiBaseUrl.TrimEnd('/')) + "/api/print-intake/report"
  return $config
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
    if (!(Test-Path $Config.LogFolder)) { New-Item -ItemType Directory -Path $Config.LogFolder -Force | Out-Null }
    $logPath = Join-Path $Config.LogFolder ("gso-print-intake-" + (Get-Date -Format "yyyyMMdd") + ".log")
    Add-Content -Path $logPath -Value $line
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

function Get-RoutePlan($Config, [string]$FileName, [string]$Subfolder) {
  return Invoke-IntakeJsonPost $Config $Config.PlanUrl @{ token = $Config.UploadToken; fileName = $FileName; subfolder = $Subfolder } 60
}

function Send-IntakeReport($Config, [hashtable]$Outcome) {
  $payload = @{ token = $Config.UploadToken } + $Outcome
  return Invoke-IntakeJsonPost $Config $Config.ReportUrl $payload 60
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

function Test-PlanReview($Json) {
  return ($null -ne $Json) -and ($Json.ok -eq $true) -and ($null -ne $Json.plan) -and ($Json.plan.decision -eq "review")
}

# ---------- per-file processing ----------

function Invoke-ProcessIntakeFile($Config, $File, $Ledger) {
  if (!(New-IntakeClaim $File.FullName $Config.ClaimStaleMinutes)) {
    Write-IntakeLog $Config "claim_skipped" $File.Name "another instance holds the claim"
    return
  }
  try {
    if (!(Test-IntakeFileStable $Config $File)) {
      Write-IntakeLog $Config "waiting_for_stability" $File.Name "younger than $($Config.StableFileSeconds)s or still changing"
      return
    }
    $hash = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $sha8 = $hash.Substring(0, 8)

    if ($Ledger.ContainsKey($hash)) {
      # Restart-safe dedupe: this exact content was already handled. Routed
      # content is never copied to a hot folder twice; unresolved content is
      # not re-reported (the plan is re-checked only after the ledger is
      # cleared or the file content changes).
      Write-IntakeLog $Config "ledger_skip" $File.Name "already handled as $($Ledger[$hash]) (sha8=$sha8)"
      return
    }

    $subfolder = ""
    $parent = Split-Path -Path $File.FullName -Parent
    if ($parent -and ($parent.TrimEnd('\') -ne $Config.PrintsForTodayFolder.TrimEnd('\'))) { $subfolder = Split-Path -Path $parent -Leaf }

    $planResult = Get-RoutePlan $Config $File.Name $subfolder
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
      $plan = $planResult.json.plan
      Write-IntakeLog $Config "dry_run" $File.Name "decision=$($plan.decision) rule=$($plan.rule) ripName=$($plan.ripName) machine=$($plan.machine) reasons=$($plan.reasons -join '|') (no copy, no move, no report)"
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
      Write-IntakeLog $Config "routed_to_hot_folder" $File.Name "as=$([System.IO.Path]::GetFileName($dest)) machine=$($plan.machine) rule=$($plan.rule)"
      Send-IntakeReport $Config @{ fileName = $File.Name; decision = "routed"; rule = [string]$plan.rule; jobId = [string]$plan.jobId; jobTicket = [string]$plan.jobTicket; itemTicket = [string]$plan.itemTicket; ripName = [string]$plan.ripName; machine = [string]$plan.machine; fileHash8 = $sha8 } | Out-Null
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
    Send-IntakeReport $Config @{ fileName = $File.Name; decision = "needs_review"; reason = $reason; fileHash8 = $sha8 } | Out-Null
    Add-IntakeLedgerEntry $Config $hash $File.Name "needs_review"
    $Ledger[$hash] = "needs_review"
  } finally {
    Remove-IntakeClaim $File.FullName
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
  $pending = @(Get-ChildItem -Path $Config.PrintsForTodayFolder -File -Recurse -ErrorAction SilentlyContinue | Where-Object { @('.pdf','.eps','.ai','.tif','.tiff','.png','.jpg','.jpeg') -contains $_.Extension.ToLowerInvariant() })
  Write-Host ("pending artwork files: " + $pending.Count)
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
    $routePlan = '{"ok":true,"plan":{"decision":"route","machine":"mimaki","ripName":"GSO-20260718-0001-01"}}' | ConvertFrom-Json
    $reviewPlan = '{"ok":true,"plan":{"decision":"review","reasons":["no_deterministic_match"]}}' | ConvertFrom-Json
    $errorPlan = '{"ok":false,"error":"x"}' | ConvertFrom-Json
    Assert "route plan recognized" (Test-PlanRoute $routePlan)
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

$modeLabel = if ($DryRun) { "dry-run" } elseif ($Loop) { "loop" } else { "once" }
Write-IntakeLog $config "agent_started" "-" "version=$ScriptVersion mode=$modeLabel source=$($config.PrintsForTodayFolder)"

$extensions = @('.pdf','.eps','.ai','.tif','.tiff','.png','.jpg','.jpeg')
while ($true) {
  $ledger = Read-IntakeLedger $config
  $archiveRoot = $config.RoutedArchiveFolder.TrimEnd('\')
  $files = @(Get-ChildItem -Path $config.PrintsForTodayFolder -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() -and -not $_.FullName.StartsWith($archiveRoot) } |
    Sort-Object LastWriteTime)
  foreach ($file in $files) {
    Write-IntakeLog $config "detected" $file.Name "size=$($file.Length)"
    try {
      Invoke-ProcessIntakeFile $config $file $ledger
    } catch {
      if ($_.Exception.Message -eq "fatal_config") { Write-IntakeLog $config "agent_stopped" "-" "fatal config error; fix token and restart"; exit 2 }
      Write-IntakeLog $config "file_error" $file.Name "unexpected: $($_.Exception.Message); file left in place"
    }
  }
  if (-not $Loop -or $Once -or $DryRun) { break }
  Start-Sleep -Seconds $config.PollSeconds
}
Write-IntakeLog $config "agent_finished" "-" "pass complete"
