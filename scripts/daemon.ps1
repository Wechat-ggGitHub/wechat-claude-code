param(
  [Parameter(Position=0)]
  [ValidateSet("start","stop","restart","status","logs")]
  [string]$Command = "status"
)

$ProjectDir = Resolve-Path "$PSScriptRoot/.."
$DataDir = "$env:USERPROFILE\.wechat-claude-code"
$PidFile = "$DataDir\wechat-claude-code.pid"
$LogDir = "$DataDir\logs"
$StdoutLog = "$LogDir\stdout.log"
$StderrLog = "$LogDir\stderr.log"

function Get-SavedPid {
  if (Test-Path $PidFile) {
    return [int](Get-Content $PidFile -Raw).Trim()
  }
  return $null
}

function Is-Running($procId) {
  if (-not $procId) { return $false }
  try { return (Get-Process -Id $procId -ErrorAction Stop) -ne $null }
  catch { return $false }
}

function Write-StartupEnv {
  $env:NODE_PATH = "$ProjectDir/node_modules"
}

switch ($Command) {
  "start" {
    $savedPid = Get-SavedPid
    if ((Is-Running $savedPid)) {
      Write-Host "Already running (PID: $savedPid)"
      exit 0
    }
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }

    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    Write-Host "Starting wechat-claude-code daemon..."
    Write-StartupEnv

    $p = Start-Process -FilePath "node" -ArgumentList "dist/main.js start" -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog
    $p.Id | Out-File -FilePath $PidFile -Encoding utf8

    Write-Host "Started (PID: $($p.Id))"
    Write-Host "Logs: $StdoutLog"
  }

  "stop" {
    $procId = Get-SavedPid
    if (-not $procId) {
      Write-Host "Not running (no PID file)"
      exit 0
    }

    if (Is-Running $procId) {
      Write-Host "Stopping (PID: $procId)..."
      try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "Stopped (PID: $procId)"
      } catch {
        Write-Host "Failed to stop process: $_"
      }
    } else {
      Write-Host "Not running (stale PID file)"
    }

    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
  }

  "restart" {
    & $PSCommandPath stop
    Start-Sleep -Seconds 2
    & $PSCommandPath start
  }

  "status" {
    $procId = Get-SavedPid
    if ((Is-Running $procId)) {
      $proc = Get-Process -Id $procId
      $uptime = (Get-Date) - $proc.StartTime
      Write-Host "Running (PID: $procId, started: $($proc.StartTime), uptime: $([math]::Floor($uptime.TotalHours))h $($uptime.Minutes)m)"
    } else {
      Write-Host "Not running"
    }
  }

  "logs" {
    if (Test-Path $StdoutLog) {
      Write-Host "=== stdout.log (last 100 lines) ==="
      Get-Content $StdoutLog -Tail 100
    }
    if (Test-Path $StderrLog) {
      Write-Host "=== stderr.log (last 100 lines) ==="
      Get-Content $StderrLog -Tail 100
    }
    if (-not (Test-Path $StdoutLog) -and -not (Test-Path $StderrLog)) {
      Write-Host "No logs found"
    }
  }
}
