<#
.SYNOPSIS
    Global Content Workbench 桌面版一键启动器（静默后台 + 健康检查 + 服务复用 + 冷启动）

.DESCRIPTION
    1. 自动探测 FastAPI 后端 (127.0.0.1:8000) 与 Vite 前端 (localhost:5173)，已运行则直接复用，未运行则以绝对路径静默拉起；
    2. 轮询等待双端健康检查全部通过后，再启动 Electron 桌面窗口（配合主进程单实例锁避免重复弹窗）；
    3. 全程保留详细日志于 logs\launcher\，异常时弹出明确图形错误提示并告知日志位置；
    4. 仅依赖 Windows 原生 PowerShell 与项目现有运行环境，支持电脑重启后独立冷启动。
#>
param(
    [int]$TimeoutSeconds = 45,
    [switch]$NoGuiAlert
)

$ErrorActionPreference = 'Stop'

# 固定项目绝对路径（支持重启后任意工作目录冷启动）
$DesktopDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot  = Split-Path -Parent $DesktopDir
$FrontendDir  = Join-Path $ProjectRoot 'frontend'
$LogDir       = Join-Path $ProjectRoot 'logs\launcher'

$PythonExe    = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$ViteJs       = Join-Path $FrontendDir 'node_modules\vite\bin\vite.js'
$ElectronExe  = Join-Path $DesktopDir  'node_modules\electron\dist\electron.exe'

# 定位 Node 绝对路径（优先标准安装路径，回退 PATH）
$NodeExe = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $NodeExe)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}

$BackendHealthUrl  = 'http://127.0.0.1:8000/openapi.json'
$FrontendHealthUrl = 'http://localhost:5173/'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LauncherLog    = Join-Path $LogDir 'launcher.log'
$BackendOutLog  = Join-Path $LogDir 'backend_stdout.log'
$BackendErrLog  = Join-Path $LogDir 'backend_stderr.log'
$FrontendOutLog = Join-Path $LogDir 'frontend_stdout.log'
$FrontendErrLog = Join-Path $LogDir 'frontend_stderr.log'
$ElectronOutLog = Join-Path $LogDir 'electron_stdout.log'
$ElectronErrLog = Join-Path $LogDir 'electron_stderr.log'

function Write-Log([string]$Message, [string]$Level = 'INFO') {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] [$Level] $Message"
    Add-Content -Path $LauncherLog -Value $line -Encoding UTF8
}

function Show-ErrorAlert([string]$Title, [string]$Message) {
    Write-Log "$Title - $Message" 'ERROR'
    if (-not $NoGuiAlert) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show(
                $Message,
                $Title,
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error
            ) | Out-Null
        } catch {
            Write-Log "弹窗提示失败: $($_.Exception.Message)" 'WARN'
        }
    }
}

function Test-HttpOk([string]$Url) {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 -ErrorAction Stop
        return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400)
    } catch {
        return $false
    }
}

function Read-LogTail([string]$Path, [int]$Lines = 12) {
    if (Test-Path $Path) {
        $content = Get-Content -Path $Path -Tail $Lines -ErrorAction SilentlyContinue
        if ($content) { return ($content -join "`n") }
    }
    return ''
}

try {
    Write-Log '========== 开始启动 Global Content Workbench 桌面版 =========='

    # 0. 基础二进制文件完整性检查
    $missing = @()
    if (-not (Test-Path $PythonExe))   { $missing += "Python 虚拟环境缺失: $PythonExe" }
    if (-not (Test-Path $NodeExe))     { $missing += "Node.js 缺失: $NodeExe" }
    if (-not (Test-Path $ViteJs))      { $missing += "Vite 依赖缺失: $ViteJs" }
    if (-not (Test-Path $ElectronExe)) { $missing += "Electron 运行时缺失: $ElectronExe" }

    if ($missing.Count -gt 0) {
        $detail = ($missing -join "`n") + "`n`n日志目录: $LogDir"
        Show-ErrorAlert 'Global Content Workbench 启动失败' $detail
        exit 1
    }

    $backendProc = $null
    $frontendProc = $null

    # 1. 检查或静默启动 FastAPI 后端 (127.0.0.1:8000)
    if (Test-HttpOk $BackendHealthUrl) {
        Write-Log 'FastAPI 后端 (127.0.0.1:8000) 已在运行，直接复用。'
    } else {
        Write-Log 'FastAPI 后端未运行，正在静默拉起...'
        $backendProc = Start-Process `
            -FilePath $PythonExe `
            -ArgumentList @('-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000') `
            -WorkingDirectory $ProjectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $BackendOutLog `
            -RedirectStandardError $BackendErrLog `
            -PassThru
        Write-Log "FastAPI 后端进程已创建 (PID=$($backendProc.Id))"
    }

    # 2. 检查或静默启动 Vite 前端 (localhost:5173)
    if (Test-HttpOk $FrontendHealthUrl) {
        Write-Log 'Vite 前端 (localhost:5173) 已在运行，直接复用。'
    } else {
        Write-Log 'Vite 前端未运行，正在静默拉起...'
        $frontendProc = Start-Process `
            -FilePath $NodeExe `
            -ArgumentList @($ViteJs, '--port', '5173', '--host', 'localhost') `
            -WorkingDirectory $FrontendDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput $FrontendOutLog `
            -RedirectStandardError $FrontendErrLog `
            -PassThru
        Write-Log "Vite 前端进程已创建 (PID=$($frontendProc.Id))"
    }

    # 3. 轮询等待双端健康检查全部通过
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $backendReady = $false
    $frontendReady = $false

    while ((Get-Date) -lt $deadline) {
        if (-not $backendReady)  { $backendReady  = Test-HttpOk $BackendHealthUrl }
        if (-not $frontendReady) { $frontendReady = Test-HttpOk $FrontendHealthUrl }

        if ($backendReady -and $frontendReady) {
            break
        }

        # 若新拉起的进程提前崩溃退出，立即中止等待并报错
        if ($backendProc -and $backendProc.HasExited -and (-not $backendReady)) {
            $tail = Read-LogTail $BackendErrLog
            Show-ErrorAlert 'Global Content Workbench 后端启动异常' "FastAPI 后端进程提前退出 (ExitCode=$($backendProc.ExitCode))。`n`n最近错误日志：`n$tail`n`n完整日志：$BackendErrLog"
            exit 2
        }
        if ($frontendProc -and $frontendProc.HasExited -and (-not $frontendReady)) {
            $tail = Read-LogTail $FrontendErrLog
            Show-ErrorAlert 'Global Content Workbench 前端启动异常' "Vite 前端进程提前退出 (ExitCode=$($frontendProc.ExitCode))。`n`n最近错误日志：`n$tail`n`n完整日志：$FrontendErrLog"
            exit 3
        }

        Start-Sleep -Milliseconds 500
    }

    if (-not ($backendReady -and $frontendReady)) {
        $reasons = @()
        if (-not $backendReady) {
            $reasons += "FastAPI 后端 (127.0.0.1:8000) 健康检查超时，请查看：$BackendErrLog"
        }
        if (-not $frontendReady) {
            $reasons += "Vite 前端 (localhost:5173) 健康检查超时，请查看：$FrontendErrLog"
        }
        Show-ErrorAlert 'Global Content Workbench 服务等待超时' (($reasons -join "`n") + "`n`n启动日志：$LauncherLog")
        exit 4
    }

    Write-Log '前后端健康检查全部通过 (Backend=200, Frontend=200)，正在打开 Electron 桌面窗口...'

    # 4. 启动 Electron 桌面窗口（不重定向 stdout/stderr 以保持 UseShellExecute 正常创建可见 GUI 窗口；单实例锁自动唤醒已有窗口）
    $electronProc = Start-Process `
        -FilePath $ElectronExe `
        -ArgumentList @($DesktopDir) `
        -WorkingDirectory $DesktopDir `
        -WindowStyle Normal `
        -PassThru

    Write-Log "Electron 启动指令已触发 (PID=$($electronProc.Id))。"
    exit 0
} catch {
    $msg = "启动过程中发生未预期异常：$($_.Exception.Message)`n`n请查看启动日志：$LauncherLog"
    Show-ErrorAlert 'Global Content Workbench 启动失败' $msg
    exit 99
}
