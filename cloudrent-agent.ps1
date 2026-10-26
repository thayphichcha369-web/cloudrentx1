# CloudRent Windows Host Agent - run only on PCs you own/administer.
# Set API_BASE, MACHINE_ID and AGENT_TOKEN before running.
$ErrorActionPreference = 'Continue'
$ApiBase = $env:CLOUDRENT_API_BASE
$MachineId = $env:CLOUDRENT_MACHINE_ID
$AgentToken = $env:CLOUDRENT_AGENT_TOKEN
if (-not $ApiBase -or -not $MachineId -or -not $AgentToken) {
  Write-Host 'Set CLOUDRENT_API_BASE, CLOUDRENT_MACHINE_ID and CLOUDRENT_AGENT_TOKEN first.' -ForegroundColor Red
  exit 1
}
$Headers = @{ Authorization = "Bearer $AgentToken"; 'Content-Type' = 'application/json' }
function Post-Json($Path, $Body) {
  try { Invoke-RestMethod -Method Post -Uri "$ApiBase$Path" -Headers $Headers -Body ($Body | ConvertTo-Json -Compress) -TimeoutSec 10 } catch { Write-Host $_.Exception.Message }
}
Write-Host "CloudRent Agent online for $MachineId. Ctrl+C to stop."
while ($true) {
  try {
    Post-Json '/api/agent/heartbeat' @{ machine_id = $MachineId; status = 'available' } | Out-Null
    $r = Invoke-RestMethod -Method Get -Uri "$ApiBase/api/agent/commands?machine_id=$([uri]::EscapeDataString($MachineId))" -Headers $Headers -TimeoutSec 10
    foreach ($cmd in $r.commands) {
      $ok = $true; $message = 'ok'
      try {
        switch ($cmd.command) {
          'shutdown' { $message='shutdown scheduled'; shutdown.exe /s /t 10 /c 'CloudRent admin shutdown' }
          'restart' { $message='restart scheduled'; shutdown.exe /r /t 10 /c 'CloudRent admin restart' }
          'wake' { $message='This agent can only receive Wake when Windows is running; configure Wake-on-LAN on an always-on router/server for powered-off PCs.' }
          'end_session' { $message='Rental marked ended in CloudRent. Configure your approved Parsec/Sunshine session cleanup separately.' }
          default { $ok=$false; $message='unknown command' }
        }
      } catch { $ok=$false; $message=$_.Exception.Message }
      Post-Json "/api/agent/commands/$($cmd.id)/result" @{ ok=$ok; result=$message } | Out-Null
    }
  } catch { Write-Host "API connection issue: $($_.Exception.Message)" }
  Start-Sleep -Seconds 5
}
