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
param(
  [switch]$Once,
  [switch]$DryRun,
  [switch]$Health,
  [switch]$SelfTest,
  [string]$ConfigPath = (Join-Path $PSScriptRoot "gso-rasterlink-sync-config.json")
)

$ScriptVersion = "gso-rasterlink-sync/1.1 (13A.6B.1)"
$ErrorActionPreference = "Stop"

# ---------- config ----------

function Read-SyncConfig([string]$Path) {
  if (!(Test-Path $Path)) { throw "Config not found: $Path. Copy gso-rasterlink-sync-config.example.json, fill in the token from /app/erp/print-intake, and save as gso-rasterlink-sync-config.json." }
  $raw = Get-Content $Path -Raw | ConvertFrom-Json
  $config = @{
    ApiBaseUrl        = [string]$raw.ApiBaseUrl
    UploadToken       = [string]$raw.UploadToken
    IncomingFolder    = [string]$raw.IncomingFolder
    ProcessedFolder   = [string]$raw.ProcessedFolder
    ErrorFolder       = [string]$raw.ErrorFolder
    LogFolder         = [string]$raw.LogFolder
    Source            = if ($raw.Source) { [string]$raw.Source } else { "rasterlink" }
    PollSeconds       = if ($raw.PollSeconds) { [int]$raw.PollSeconds } else { 30 }
    StableFileSeconds = if ($raw.StableFileSeconds) { [int]$raw.StableFileSeconds } else { 20 }
    MaxRetries        = if ($raw.MaxRetries) { [int]$raw.MaxRetries } else { 4 }
    RetryDelaySeconds = if ($raw.RetryDelaySeconds) { [int]$raw.RetryDelaySeconds } else { 10 }
    ClaimStaleMinutes = if ($raw.ClaimStaleMinutes) { [int]$raw.ClaimStaleMinutes } else { 30 }
  }
  foreach ($key in @("ApiBaseUrl","UploadToken","IncomingFolder","ProcessedFolder","ErrorFolder","LogFolder")) {
    if ([string]::IsNullOrWhiteSpace($config[$key])) { throw "Config missing required value: $key" }
  }
  $config.UploadUrl = ($config.ApiBaseUrl.TrimEnd('/')) + "/api/rip-imports/upload"
  return $config
}

function Get-MaskedToken([string]$Token) {
  if ([string]::IsNullOrWhiteSpace($Token)) { return "(not set)" }
  $prefix = $Token.Substring(0, [Math]::Min(4, $Token.Length))
  return "(set, $($Token.Length) chars, $prefix****)"
}

# ---------- logging (never logs the token) ----------

function Write-SyncLog($Config, [string]$EventName, [string]$File, [string]$Detail) {
  $line = "{0} [{1}] file={2} {3}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $EventName, $File, $Detail
  Write-Host $line
  if ($Config -and $Config.LogFolder) {
    if (!(Test-Path $Config.LogFolder)) { New-Item -ItemType Directory -Path $Config.LogFolder -Force | Out-Null }
    $logPath = Join-Path $Config.LogFolder ("gso-rasterlink-sync-" + (Get-Date -Format "yyyyMMdd") + ".log")
    Add-Content -Path $logPath -Value $line
  }
}

# ---------- claim-file locking ----------

function Get-ClaimPath([string]$FilePath) { return "$FilePath.gsoclaim" }

function New-FileClaim([string]$FilePath, [int]$ClaimStaleMinutes) {
  $claimPath = Get-ClaimPath $FilePath
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      $stream = [System.IO.File]::Open($claimPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("$env:COMPUTERNAME pid=$PID at=$((Get-Date).ToUniversalTime().ToString('o'))")
      $stream.Write($bytes, 0, $bytes.Length); $stream.Close()
      return $true
    } catch {
      if (Test-Path $claimPath) {
        $age = (Get-Date) - (Get-Item $claimPath).LastWriteTime
        if ($age.TotalMinutes -gt $ClaimStaleMinutes) { Remove-Item $claimPath -Force -Confirm:$false; continue } # stale claim from a crashed run
      }
      return $false
    }
  }
  return $false
}

function Remove-FileClaim([string]$FilePath) {
  $claimPath = Get-ClaimPath $FilePath
  if (Test-Path $claimPath) { Remove-Item $claimPath -Force -Confirm:$false }
}

# ---------- stability ----------

function Test-FileStable($Config, $File) {
  $item = Get-Item $File.FullName
  $ageSeconds = ((Get-Date) - $item.LastWriteTime).TotalSeconds
  if ($ageSeconds -lt $Config.StableFileSeconds) { return $false }
  $sizeBefore = $item.Length
  Start-Sleep -Seconds 2
  $after = Get-Item $File.FullName
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

function Invoke-RipUpload($Config, [string]$FilePath, [string]$FileName) {
  Add-Type -AssemblyName System.Net.Http | Out-Null
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(120)
  try {
    $boundary = "gso-" + [guid]::NewGuid().ToString("N")
    $fileBytes = [System.IO.File]::ReadAllBytes($FilePath)
    $fields = New-Object System.Collections.Specialized.OrderedDictionary
    $fields.Add("token", $Config.UploadToken)
    $fields.Add("source", $Config.Source)
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
    $client.Dispose()
  }
}

function Test-DuplicateResponse($Json) {
  return ($null -ne $Json) -and ($Json.ok -eq $true) -and ($Json.PSObject.Properties.Name -contains "duplicateFile") -and ($Json.duplicateFile -eq $true)
}

function Test-SuccessResponse($Json) {
  return ($null -ne $Json) -and ($Json.ok -eq $true)
}

# ---------- moves + sidecars ----------

function Get-CollisionSafeDestination([string]$DestFolder, [string]$FileName, [string]$SourcePath) {
  $dest = Join-Path $DestFolder $FileName
  if (!(Test-Path $dest)) { return $dest }
  # Deterministic suffix: first 8 hex chars of the file's content hash, so the
  # same content always maps to the same archived name.
  $sha8 = (Get-FileHash -Path $SourcePath -Algorithm SHA256).Hash.Substring(0, 8).ToLowerInvariant()
  $base = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
  $ext = [System.IO.Path]::GetExtension($FileName)
  return Join-Path $DestFolder "$base-$sha8$ext"
}

function Move-ToFolder($Config, $File, [string]$DestFolder, [string]$LogEvent) {
  if (!(Test-Path $DestFolder)) { New-Item -ItemType Directory -Path $DestFolder -Force | Out-Null }
  $dest = Get-CollisionSafeDestination $DestFolder $File.Name $File.FullName
  Move-Item -Path $File.FullName -Destination $dest -Force -Confirm:$false
  Write-SyncLog $Config $LogEvent $File.Name "dest=$dest"
  return $dest
}

function Write-ErrorSidecar($Config, $File, [int]$RetryCount, $HttpStatus, [string]$ServerResponse, [string]$ExceptionMessage) {
  if (!(Test-Path $Config.ErrorFolder)) { New-Item -ItemType Directory -Path $Config.ErrorFolder -Force | Out-Null }
  $sidecar = [ordered]@{
    originalFileName = $File.Name
    timestampUtc     = (Get-Date).ToUniversalTime().ToString("o")
    retryCount       = $RetryCount
    httpStatus       = $HttpStatus
    serverResponse   = if ($ServerResponse) { $ServerResponse.Substring(0, [Math]::Min(2000, $ServerResponse.Length)) } else { $null }
    exception        = $ExceptionMessage
    scriptVersion    = $ScriptVersion
  }
  $sidecarPath = Join-Path $Config.ErrorFolder ($File.Name + ".error.json")
  $sidecar | ConvertTo-Json | Set-Content -Path $sidecarPath
  return $sidecarPath
}

# ---------- per-file processing ----------

function Invoke-ProcessFile($Config, $File) {
  if (!(New-FileClaim $File.FullName $Config.ClaimStaleMinutes)) {
    Write-SyncLog $Config "claim_skipped" $File.Name "another instance holds the claim"
    return "claimed_elsewhere"
  }
  try {
    if (!(Test-FileStable $Config $File)) {
      Write-SyncLog $Config "waiting_for_stability" $File.Name "younger than $($Config.StableFileSeconds)s or still changing; will retry next poll"
      return "unstable"
    }
    for ($attempt = 1; $attempt -le $Config.MaxRetries; $attempt++) {
      Write-SyncLog $Config "upload_started" $File.Name "attempt=$attempt of $($Config.MaxRetries)"
      $result = Invoke-RipUpload $Config $File.FullName $File.Name

      if ($result.exception -eq $null -and $result.status -ge 200 -and $result.status -lt 300 -and (Test-SuccessResponse $result.json)) {
        if (Test-DuplicateResponse $result.json) {
          Write-SyncLog $Config "duplicate_accepted" $File.Name "server already has this content (importId=$($result.json.importId)); treating as success"
        } else {
          Write-SyncLog $Config "upload_succeeded" $File.Name ("rows=$($result.json.rows) created=$($result.json.created) dupRowsSkipped=$($result.json.skippedDuplicates) matched=$($result.json.matched) ambiguous=$($result.json.ambiguous)")
        }
        Move-ToFolder $Config $File $Config.ProcessedFolder "moved_to_processed" | Out-Null
        return "processed"
      }

      if ($result.status -eq 401 -or $result.status -eq 403) {
        # Token/config problem: NEVER misfile good CSVs into error for this.
        Write-SyncLog $Config "fatal_config" $File.Name "HTTP $($result.status) token rejected - fix the config token; file left in incoming"
        return "fatal_config"
      }
      if ($result.status -ge 400 -and $result.status -lt 500 -and $result.status -ne 429) {
        $sidecar = Write-ErrorSidecar $Config $File $attempt $result.status $result.body $null
        Move-ToFolder $Config $File $Config.ErrorFolder "moved_to_error" | Out-Null
        Write-SyncLog $Config "terminal_client_error" $File.Name "HTTP $($result.status); sidecar=$sidecar"
        return "error"
      }

      # Transient (network exception, 5xx, 429): stepped backoff then retry.
      if ($attempt -lt $Config.MaxRetries) {
        $delay = $Config.RetryDelaySeconds * $attempt
        Write-SyncLog $Config "retry_scheduled" $File.Name "attempt=$attempt status=$($result.status) exception=$($result.exception) bodySnippet=$(Get-SafeBodySnippet $result.body) delaySeconds=$delay"
        Start-Sleep -Seconds $delay
      } else {
        $sidecar = Write-ErrorSidecar $Config $File $attempt $result.status $result.body $result.exception
        Move-ToFolder $Config $File $Config.ErrorFolder "moved_to_error" | Out-Null
        Write-SyncLog $Config "retries_exhausted" $File.Name "sidecar=$sidecar"
        return "error"
      }
    }
  } finally {
    Remove-FileClaim $File.FullName
  }
}

# ---------- health ----------

function Invoke-HealthCheck($Config) {
  Write-Host "=== gso-rasterlink-sync health ($ScriptVersion) ==="
  Write-Host ("config loaded: OK (source=$($Config.Source), poll=$($Config.PollSeconds)s, stable=$($Config.StableFileSeconds)s, retries=$($Config.MaxRetries))")
  Write-Host ("upload token: " + (Get-MaskedToken $Config.UploadToken))
  foreach ($pair in @(@("incoming", $Config.IncomingFolder), @("processed", $Config.ProcessedFolder), @("error", $Config.ErrorFolder), @("log", $Config.LogFolder))) {
    $label = $pair[0]; $path = $pair[1]
    if (Test-Path $path) {
      try {
        $probe = Join-Path $path (".gso-health-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
        Set-Content -Path $probe -Value "health"; Remove-Item $probe -Force -Confirm:$false
        Write-Host "$label folder: OK (reachable + writable) $path"
      } catch { Write-Host "$label folder: REACHABLE BUT NOT WRITABLE $path ($($_.Exception.Message))" }
    } else { Write-Host "$label folder: NOT REACHABLE $path" }
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
  Write-Host ("pending CSV count: " + $pending.Count)
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

    # error sidecar shape
    $sidecarConfig = @{ ErrorFolder = (Join-Path $temp "error") }
    $sidecarFile = Get-Item $src
    $sidecarPath = Write-ErrorSidecar $sidecarConfig $sidecarFile 3 500 '{"ok":false}' "boom"
    $sidecar = Get-Content $sidecarPath -Raw | ConvertFrom-Json
    Assert "sidecar written with fields" ($sidecar.originalFileName -eq "job.csv" -and $sidecar.retryCount -eq 3 -and $sidecar.httpStatus -eq 500 -and $sidecar.exception -eq "boom" -and $sidecar.scriptVersion -eq $ScriptVersion)

    # token masking never leaks the raw token
    $mask = Get-MaskedToken "supersecrettoken1234"
    Assert "token mask hides the token" ($mask -notmatch "supersecrettoken1234" -and $mask -match "supe\*\*\*\*")

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
  } finally {
    Remove-Item $temp -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host ("self-test failures: " + $script:failures)
  if ($script:failures -gt 0) { exit 1 } else { exit 0 }
}

# ---------- main ----------

if ($SelfTest) { Invoke-SelfTest }

$config = Read-SyncConfig $ConfigPath
if ($Health) { Invoke-HealthCheck $config; exit 0 }

Write-SyncLog $config "watcher_started" "-" "version=$ScriptVersion mode=$(if ($DryRun) { 'dry-run' } elseif ($Once) { 'once' } else { 'poll' }) incoming=$($config.IncomingFolder)"

while ($true) {
  $files = @(Get-ChildItem -Path $config.IncomingFolder -Filter *.csv -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
  foreach ($file in $files) {
    Write-SyncLog $config "detected" $file.Name "size=$($file.Length)"
    if ($DryRun) {
      $stable = Test-FileStable $config $file
      Write-SyncLog $config "dry_run" $file.Name "would_upload=$stable stable=$stable (no upload, no move)"
      continue
    }
    $outcome = Invoke-ProcessFile $config $file
    if ($outcome -eq "fatal_config") { Write-SyncLog $config "watcher_stopped" "-" "fatal config error; fix token and restart"; exit 2 }
  }
  if ($Once -or $DryRun) { break }
  Start-Sleep -Seconds $config.PollSeconds
}
Write-SyncLog $config "watcher_finished" "-" "single pass complete"
