# Canonical signed-request tester for POST /api/agent/intake.
#
# Contract (must match app/lib/agent-security.server.ts):
#   Authorization:          Bearer tokenId.tokenSecret   (dot separator, split on FIRST dot)
#   X-GSO-Agent-Timestamp:  unix milliseconds (seconds also accepted server-side)
#   X-GSO-Agent-Signature:  lowercase hex HMAC-SHA256 over "<timestamp>.<rawBody>"
#                           keyed with the UTF-8 bytes of tokenSecret
#
# The previous version of this script sent ToUnixTimeSeconds(), which the
# server (comparing against millisecond time) rejected as a stale timestamp.
#
# Local-only helper. Never prints the token secret.

$ErrorActionPreference = "Stop"

$endpoint = Read-Host "Intake URL (blank = production)"
if ([string]::IsNullOrWhiteSpace($endpoint)) {
  $endpoint = "https://gso-wholesale-app-live.onrender.com/api/agent/intake"
}

$oneTimeToken = Read-Host "Paste one-time token (tokenId.tokenSecret)"
$oneTimeToken = $oneTimeToken.Trim()

$dotIndex = $oneTimeToken.IndexOf(".")
if ($dotIndex -le 0 -or $dotIndex -eq ($oneTimeToken.Length - 1)) {
  throw "Token must be in tokenId.tokenSecret format."
}

$tokenSecret = $oneTimeToken.Substring($dotIndex + 1)
Write-Host "Token ID:" $oneTimeToken.Substring(0, $dotIndex)
Write-Host "Token secret hidden."

$stamp = Get-Date -Format "yyyyMMddHHmmss"

$bodyObject = [ordered]@{
  customerName        = "Signed Intake Test Lead"
  company             = "Signed Intake Test Brand"
  email               = "test-agent@gso.local"
  productFamily       = "labels-stickers"
  quantity            = "100"
  dimensionsOrSize    = "3x3"
  materialOrSubstrate = "vinyl"
  finish              = "matte"
  sourceChannel       = "local_test_script"
  externalLeadId      = "intake-test-$stamp"
  idempotencyKey      = "intake-idem-$stamp"
  customerNotes       = "Signed intake test from tools/test-agent-intake.ps1"
}

$rawBody = $bodyObject | ConvertTo-Json -Compress
$bodyBytes = [Text.Encoding]::UTF8.GetBytes($rawBody)

# Milliseconds - this is the line the old script got wrong.
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()

$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($tokenSecret)
$hashBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$timestamp.$rawBody"))
$signature = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })

function Send-AgentTestRequest {
  param([string]$Label)

  Write-Host ""
  Write-Host "=== $Label ==="

  $headers = @{
    "Authorization"         = "Bearer $oneTimeToken"
    "X-GSO-Agent-Timestamp" = $timestamp
    "X-GSO-Agent-Signature" = $signature
  }

  try {
    # Body is sent as the exact UTF-8 bytes that were signed.
    $response = Invoke-WebRequest -Uri $endpoint -Method POST -Headers $headers `
      -ContentType "application/json" -Body $bodyBytes -UseBasicParsing

    Write-Host "HTTP Status:" $response.StatusCode
    Write-Host "Response:" $response.Content
    return [int]$response.StatusCode
  } catch {
    if ($null -ne $_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
      Write-Host "HTTP Status:" $statusCode
      $stream = $_.Exception.Response.GetResponseStream()
      if ($null -ne $stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        Write-Host "Response:" $reader.ReadToEnd()
      }
      return $statusCode
    }

    Write-Host $_.Exception.Message
    return 0
  }
}

$status = Send-AgentTestRequest "SIGNED INTAKE TEST - expecting 201 accepted"

if ($status -eq 201) {
  Write-Host ""
  Write-Host "Replaying the exact same signed request - expecting 200 duplicate..."
  Start-Sleep -Seconds 2
  Send-AgentTestRequest "REPLAY TEST - expecting 200 duplicate" | Out-Null
}

Write-Host ""
Write-Host "Check /app/erp/agent-security in the embedded admin for the logged submissions."
