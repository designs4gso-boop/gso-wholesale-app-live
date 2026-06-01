param(
  [string]$ConfigPath = ".\gso-print-intake-config.json",
  [int]$IntervalSeconds = 30,
  [switch]$Once
)

$ErrorActionPreference = "Stop"

function Read-Config {
  if (!(Test-Path $ConfigPath)) { throw "Config file not found: $ConfigPath. Copy gso-print-intake-config.example.json and paste your ERP upload token." }
  Get-Content $ConfigPath -Raw | ConvertFrom-Json
}

function Ensure-Folder($Path) {
  if ($Path -and !(Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

function Clean-Token([string]$Value, [string]$Fallback) {
  $clean = ($Value -replace '[^A-Za-z0-9]+','_').Trim('_')
  if ([string]::IsNullOrWhiteSpace($clean)) { return $Fallback }
  return $clean.Substring(0, [Math]::Min($clean.Length, 40))
}

function Get-TicketFromPath($File) {
  $haystack = "$($File.DirectoryName) $($File.BaseName)"
  $match = [regex]::Match($haystack, '(?i)\bGSO[-_ ]?(?:TEST[-_ ]?)?[A-Z0-9]+(?:[-_][A-Z0-9]+)*\b')
  if ($match.Success) { return (($match.Value -replace '_','-') -replace '\s+','-').ToUpperInvariant() }
  return ""
}

function Get-Side($BaseName) {
  if ($BaseName -match '(?i)\bfront\b') { return "FRONT" }
  if ($BaseName -match '(?i)\bback\b') { return "BACK" }
  if ($BaseName -match '(?i)\btop\b') { return "TOP" }
  if ($BaseName -match '(?i)\bbottom\b') { return "BOTTOM" }
  return "PRINT"
}

function Get-Route($Config, $BaseName) {
  foreach ($route in $Config.routes) {
    foreach ($needle in $route.match) {
      if ($BaseName.ToLowerInvariant().Contains([string]$needle.ToLowerInvariant())) {
        return @{ route = [string]$route.route; hotFolder = [string]$route.hotFolder }
      }
    }
  }
  return @{ route = [string]$Config.defaultRoute; hotFolder = [string]$Config.defaultHotFolder }
}

function Process-PrintFiles($Config) {
  Ensure-Folder $Config.needsReviewFolder
  Ensure-Folder $Config.renamedFolder
  Ensure-Folder $Config.sentToRipFolder
  Ensure-Folder $Config.defaultHotFolder

  $extensions = @('.pdf','.eps','.ai','.tif','.tiff','.png','.jpg','.jpeg')
  $files = Get-ChildItem -Path $Config.printIntakeFolder -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() }
  foreach ($file in $files) {
    try {
      if ($file.FullName -like "*$($Config.needsReviewFolder)*" -or $file.FullName -like "*$($Config.sentToRipFolder)*" -or $file.FullName -like "*$($Config.renamedFolder)*") { continue }
      $ticket = Get-TicketFromPath $file
      if ([string]::IsNullOrWhiteSpace($ticket)) {
        Move-Item $file.FullName (Join-Path $Config.needsReviewFolder $file.Name) -Force
        Write-Host "Needs review: missing GSO ticket -> $($file.Name)"
        continue
      }
      $side = Get-Side $file.BaseName
      $routeInfo = Get-Route $Config $file.BaseName
      Ensure-Folder $routeInfo.hotFolder
      $customer = Clean-Token $file.Directory.Parent.Name "Customer"
      $product = Clean-Token $file.Directory.Name "Product"
      $material = if ($file.BaseName -match '(?i)holo') { "Holo" } elseif ($file.BaseName -match '(?i)gloss') { "Gloss" } elseif ($file.BaseName -match '(?i)clear') { "Clear" } else { "Matte" }
      $revision = "R1"
      $newName = "${ticket}_${customer}_${product}_${side}_${material}_$($routeInfo.route)_${revision}$($file.Extension.ToLowerInvariant())"
      $renamedPath = Join-Path $Config.renamedFolder $newName
      $hotPath = Join-Path $routeInfo.hotFolder $newName
      $sentPath = Join-Path $Config.sentToRipFolder $newName
      Copy-Item $file.FullName $renamedPath -Force
      Copy-Item $file.FullName $hotPath -Force
      Move-Item $file.FullName $sentPath -Force
      Write-Host "Sent to RIP: $newName -> $($routeInfo.hotFolder)"
    } catch {
      $dest = Join-Path $Config.needsReviewFolder $file.Name
      try { Move-Item $file.FullName $dest -Force } catch {}
      Write-Warning "Print file failed and was moved to needs-review: $($file.FullName) :: $($_.Exception.Message)"
    }
  }
}

function Upload-RipLogs($Config) {
  Ensure-Folder $Config.processedLogFolder
  Ensure-Folder $Config.errorLogFolder
  $logFolders = @(
    @{ source = 'versaworks'; path = $Config.versaworksLogFolder },
    @{ source = 'rasterlink'; path = $Config.rasterlinkLogFolder }
  )
  foreach ($logFolder in $logFolders) {
    if (!(Test-Path $logFolder.path)) { continue }
    $logs = Get-ChildItem -Path $logFolder.path -File -ErrorAction SilentlyContinue | Where-Object { @('.csv','.xml','.vw','.txt') -contains $_.Extension.ToLowerInvariant() }
    foreach ($log in $logs) {
      try {
        $form = @{ token = $Config.uploadToken; source = $logFolder.source; file = Get-Item $log.FullName }
        $response = Invoke-RestMethod -Uri $Config.erpUploadUrl -Method Post -Form $form
        if ($response.ok -eq $true) {
          Move-Item $log.FullName (Join-Path $Config.processedLogFolder $log.Name) -Force
          Write-Host "Uploaded RIP log: $($log.Name)"
        } else { throw "ERP rejected upload: $($response | ConvertTo-Json -Compress)" }
      } catch {
        Move-Item $log.FullName (Join-Path $Config.errorLogFolder $log.Name) -Force
        Write-Warning "RIP log upload failed: $($log.Name) :: $($_.Exception.Message)"
      }
    }
  }
}

$config = Read-Config
foreach ($folder in @($config.printIntakeFolder,$config.needsReviewFolder,$config.renamedFolder,$config.sentToRipFolder,$config.processedLogFolder,$config.errorLogFolder,$config.versaworksLogFolder,$config.rasterlinkLogFolder,$config.defaultHotFolder)) { Ensure-Folder $folder }

Write-Host "GSO Print Intake Watcher started. Source: $($config.printIntakeFolder)"
do {
  $config = Read-Config
  Process-PrintFiles $config
  Upload-RipLogs $config
  if ($Once) { break }
  Start-Sleep -Seconds $IntervalSeconds
} while ($true)
