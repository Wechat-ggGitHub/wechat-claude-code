param(
    [Parameter(Position = 0)]
    [ValidateSet("setup", "start", "stop", "restart", "status", "logs")]
    [string]$Command = "status",

    [Parameter(Position = 1)]
    [ValidatePattern("^[A-Za-z0-9_-]+$")]
    [string]$Instance = "default"
)

$ErrorActionPreference = "Stop"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# default 实例继续使用原来的数据目录，保留当前已登录账号
$BaseDataDir = Join-Path $env:USERPROFILE ".wechat-claude-code"

if ($Instance -eq "default") {
    $DataDir = $BaseDataDir
} else {
    $InstancesDir = Join-Path $BaseDataDir "instances"
    $DataDir = Join-Path $InstancesDir $Instance
}

# Node.js 子进程会继承这个环境变量
$env:WCC_DATA_DIR = $DataDir

$LogDir = Join-Path $DataDir "logs"
$PidFile = Join-Path $DataDir "wechat-claude-code.pid"
$StdoutLog = Join-Path $LogDir "stdout.log"
$StderrLog = Join-Path $LogDir "stderr.log"
$EntryFile = Join-Path $ProjectDir "dist\main.js"

function Get-NodePath {
    $nodeCommand = Get-Command node -ErrorAction Stop
    return $nodeCommand.Source
}

function Get-SavedProcessId {
    if (-not (Test-Path $PidFile)) {
        return $null
    }

    try {
        $value = (Get-Content $PidFile -Raw).Trim()
        [int]$parsedId = 0

        if ([int]::TryParse($value, [ref]$parsedId)) {
            return $parsedId
        }
    } catch {
        return $null
    }

    return $null
}

function Test-ProcessRunning {
    param(
        [int]$ProcessId
    )

    if ($ProcessId -le 0) {
        return $false
    }

    try {
        Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Remove-PidFile {
    if (Test-Path $PidFile) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-InstanceSetup {
    if (-not (Test-Path $EntryFile)) {
        throw "dist/main.js not found. Run 'npm run build' first."
    }

    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

    $nodePath = Get-NodePath

    Write-Host "Setting up instance: $Instance"
    Write-Host "Data directory: $DataDir"
    Write-Host ""

    Push-Location $ProjectDir

    try {
        & $nodePath $EntryFile setup

        if ($LASTEXITCODE -ne 0) {
            throw "Setup failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Start-Daemon {
    $savedPid = Get-SavedProcessId

    if ($savedPid -and (Test-ProcessRunning -ProcessId $savedPid)) {
        Write-Host "Instance '$Instance' is already running (PID: $savedPid)"
        return
    }

    Remove-PidFile

    if (-not (Test-Path $EntryFile)) {
        throw "dist/main.js not found. Run 'npm run build' first."
    }

    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    $nodePath = Get-NodePath

    Write-Host "Starting instance '$Instance'..."
    Write-Host "Data directory: $DataDir"

    $process = Start-Process `
        -FilePath $nodePath `
        -ArgumentList @("`"$EntryFile`"", "start") `
        -WorkingDirectory $ProjectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog `
        -PassThru

    Set-Content -Path $PidFile -Value $process.Id -Encoding ASCII

    Start-Sleep -Milliseconds 800

    if (-not (Test-ProcessRunning -ProcessId $process.Id)) {
        Remove-PidFile

        Write-Host ""
        Write-Host "Daemon exited immediately."

        if (Test-Path $StderrLog) {
            Write-Host "=== stderr.log ==="
            Get-Content $StderrLog -Encoding UTF8 -Tail 50
        }

        throw "Failed to start instance '$Instance'"
    }

    Write-Host "Started instance '$Instance' (PID: $($process.Id))"
    Write-Host "Logs: $StdoutLog"
}

function Stop-Daemon {
    $savedPid = Get-SavedProcessId

    if (-not $savedPid) {
        Write-Host "Instance '$Instance' is not running (no PID file)"
        Remove-PidFile
        return
    }

    if (-not (Test-ProcessRunning -ProcessId $savedPid)) {
        Write-Host "Instance '$Instance' is not running (stale PID: $savedPid)"
        Remove-PidFile
        return
    }

    Write-Host "Stopping instance '$Instance' (PID: $savedPid)..."

    & taskkill.exe /PID $savedPid /T /F | Out-Host

    Start-Sleep -Milliseconds 500
    Remove-PidFile

    Write-Host "Stopped instance '$Instance'"
}

function Show-Status {
    $savedPid = Get-SavedProcessId

    Write-Host "Instance: $Instance"
    Write-Host "Data directory: $DataDir"

    if ($savedPid -and (Test-ProcessRunning -ProcessId $savedPid)) {
        $process = Get-Process -Id $savedPid
        $uptime = (Get-Date) - $process.StartTime

        Write-Host "Status: Running"
        Write-Host "PID: $savedPid"
        Write-Host "Started: $($process.StartTime)"
        Write-Host "Uptime: $([math]::Floor($uptime.TotalHours))h $($uptime.Minutes)m"
        return
    }

    if ($savedPid) {
        Remove-PidFile
    }

    Write-Host "Status: Not running"
}

function Show-Logs {
    Write-Host "Instance: $Instance"
    Write-Host "Data directory: $DataDir"
    Write-Host ""

    $found = $false

    if (Test-Path $StdoutLog) {
        $found = $true
        Write-Host "=== stdout.log ==="
        Get-Content $StdoutLog -Encoding UTF8 -Tail 100
    }

    if (Test-Path $StderrLog) {
        $found = $true
        Write-Host ""
        Write-Host "=== stderr.log ==="
        Get-Content $StderrLog -Encoding UTF8 -Tail 100
    }

    if (-not $found) {
        Write-Host "No logs found"
    }
}

switch ($Command) {
    "setup" {
        Invoke-InstanceSetup
    }

    "start" {
        Start-Daemon
    }

    "stop" {
        Stop-Daemon
    }

    "restart" {
        Stop-Daemon
        Start-Sleep -Seconds 1
        Start-Daemon
    }

    "status" {
        Show-Status
    }

    "logs" {
        Show-Logs
    }
}