<#
.SYNOPSIS
    Global Content Workbench · 本地版本查看与一键安全回滚守护脚本

.DESCRIPTION
    1. list：列出全部本地可恢复版本标签、提交时间与功能说明；
    2. rollback：
       - 执行前展示目标版本与当前修改范围，并检测 backend/db.py 结构兼容性；
       - 自动创建 backup/pre-rollback-<ts> 本地保护分支保存当前全部源码状态，严禁破坏性覆盖；
       - 停止受影响的运行服务（8000/5173/Electron）；
       - 仅恢复源码至目标版本（绝不覆盖 data/workbench.db 与 data/credential_vault.json）；
       - 检查依赖完整性，重新拉起工作台并验证前后端 HTTP 200 健康状态；
       - 全程保留详细日志于 logs/rollback/。
#>
param(
    [ValidateSet('list', 'rollback')]
    [string]$Action = 'list',
    [string]$TargetVersion = '',
    [string]$RepoRoot = '',
    [switch]$Yes,
    [switch]$SkipRestart
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}

Push-Location $RepoRoot
try {
    if ($Action -eq 'list') {
        Write-Host '============================================================' -ForegroundColor Cyan
        Write-Host '  Global Content Workbench · 本地可恢复版本列表' -ForegroundColor Cyan
        Write-Host '============================================================' -ForegroundColor Cyan
        $curBranch = (git rev-parse --abbrev-ref HEAD).Trim()
        $curCommit = (git rev-parse --short HEAD).Trim()
        $dirty = @(git status --porcelain)
        Write-Host "当前分支: $curBranch ($curCommit) | 未提交变更文件数: $($dirty.Count)" -ForegroundColor Yellow
        Write-Host ''
        git tag -l --sort=-creatordate --format="%(refname:short) `t| %(creatordate:short) | %(objectname:short) | %(contents:subject)"
        Write-Host ''
        $backups = Get-ChildItem -Path (Join-Path $RepoRoot 'data\backups') -Filter '*.db' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 8
        if ($backups) {
            Write-Host '最近 SQLite 一致性热备（默认回滚不覆盖业务库，如需单独恢复请手动核对）：' -ForegroundColor Green
            foreach ($b in $backups) {
                Write-Host ("  - {0} ({1:N0} KB, {2})" -f $b.Name, ($b.Length / 1KB), $b.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
            }
        }
        exit 0
    }

    # ==================== ROLLBACK ====================
    $ts = Get-Date -Format 'yyyyMMdd_HHmmss'
    $logDir = Join-Path $RepoRoot 'logs\rollback'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $logFile = Join-Path $logDir "rollback_$ts.log"

    function Log([string]$msg, [string]$level = 'INFO') {
        $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$level] $msg"
        Add-Content -Path $logFile -Value $line -Encoding UTF8
        if ($level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
        elseif ($level -eq 'WARN') { Write-Host $line -ForegroundColor Yellow }
        else { Write-Host $line -ForegroundColor Gray }
    }

    if (-not $TargetVersion) {
        Write-Host '当前可恢复版本标签：' -ForegroundColor Cyan
        git tag -l --sort=-creatordate --format="  %(refname:short)  [%(creatordate:short)]  %(contents:subject)"
        Write-Host ''
        $TargetVersion = (Read-Host '请输入要恢复的版本标签（例如 v0.1.0）').Trim()
    }

    if (-not $TargetVersion) {
        Log '未输入目标版本号，已取消回滚。' 'WARN'
        exit 1
    }

    # 校验目标标签/提交是否存在
    $targetHash = (git rev-parse --verify "$TargetVersion^{commit}" 2>$null)
    if (-not $targetHash) {
        Log "目标版本 '$TargetVersion' 不存在，请先运行 list_versions.bat 核对。" 'ERROR'
        exit 2
    }
    $targetHash = $targetHash.Trim()

    Log "========== 开始准备安全回滚至 $TargetVersion ($($targetHash.Substring(0,7))) =========="
    $curBranch = (git rev-parse --abbrev-ref HEAD).Trim()
    $curHash = (git rev-parse HEAD).Trim()

    # 1. 展示目标版本与修改范围
    Write-Host ''
    Write-Host "目标版本: $TargetVersion ($($targetHash.Substring(0,7)))" -ForegroundColor Cyan
    Write-Host "当前版本: $curBranch ($($curHash.Substring(0,7)))" -ForegroundColor Yellow
    Write-Host '--- 源码变更范围（git diff --stat） ---' -ForegroundColor Cyan
    $diffStat = git diff --stat HEAD $targetHash
    if ($diffStat) { $diffStat | ForEach-Object { Write-Host $_ } } else { Write-Host '（已跟踪源码无差异）' }

    # 检查数据库结构文件 backend/db.py 是否有差异
    $dbDiff = @(git diff --name-only HEAD $targetHash -- backend/db.py)
    if ($dbDiff.Count -gt 0) {
        Log '检测到目标版本与当前版本的 backend/db.py 存在差异！默认回滚绝不覆盖 data/workbench.db。若启动后报字段不兼容，请先热备当前库，再经人工确认从 data/backups/ 恢复对应基线数据库。' 'WARN'
    } else {
        Log '数据库结构核查：backend/db.py 无不兼容结构变更，用户业务数据库 data/workbench.db 将完整保留。'
    }

    if (-not $Yes) {
        $confirm = (Read-Host "确认执行安全回滚至 $TargetVersion ？（将先自动备份当前状态，且绝不覆盖业务数据库）[y/N]").Trim()
        if ($confirm -notin @('y', 'Y', 'yes', 'YES')) {
            Log '用户取消了回滚操作。' 'WARN'
            exit 0
        }
    }

    # 2. 自动保存当前状态到独立保护分支（严禁破坏性丢弃未保护修改）
    $backupBranch = "backup/pre-rollback-$ts"
    $dirtyFiles = @(git status --porcelain)
    $gitAuthorArgs = @('-c', 'user.name=GCW Version Guard', '-c', 'user.email=gcw-local@workbench.local')
    if ($dirtyFiles.Count -gt 0) {
        Log "检测到 $($dirtyFiles.Count) 项未提交修改，正在自动保存至保护分支 $backupBranch ..."
        git checkout -b $backupBranch | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '创建保护分支失败' }
        git add -A
        git @gitAuthorArgs commit -m "backup(pre-rollback): auto-save working tree before rollback to $TargetVersion" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '保护分支提交失败' }
        $savedHash = (git rev-parse --short HEAD).Trim()
        Log "当前工作区已完整保护于分支 $backupBranch ($savedHash)。"
        git checkout $curBranch | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "切回原分支 $curBranch 失败" }
    } else {
        git branch $backupBranch HEAD | Out-Null
        Log "当前工作区干净，已创建保护分支 $backupBranch 指向 $($curHash.Substring(0,7))。"
    }

    # 3. 停止受影响的运行服务
    if (-not $SkipRestart) {
        Log '正在停止受影响的本地服务（Electron / 8000 / 5173）...'
        Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        foreach ($port in @(8000, 5173)) {
            $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            foreach ($c in $conns) {
                if ($c.OwningProcess) {
                    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                    Log "已停止端口 $port 进程 (PID=$($c.OwningProcess))"
                }
            }
        }
        Start-Sleep -Seconds 1
    }

    # 4. 非破坏性方式将当前分支源码树恢复为目标版本（不触碰 .gitignore 保护的 data/ 数据库与保险箱）
    Log "正在将源码恢复至 $TargetVersion（业务数据库 data/ 保持原样不覆盖）..."
    # 先移除在当前提交存在但在目标版本不存在的已跟踪文件
    $toRemove = @(git diff --name-only --diff-filter=A $targetHash HEAD)
    foreach ($f in $toRemove) {
        if ($f -and (Test-Path $f)) {
            git rm -f --quiet -- "$f" 2>$null
        }
    }
    # 检出目标版本全部源码文件
    git checkout $targetHash -- .
    $afterDiff = @(git status --porcelain)
    if ($afterDiff.Count -gt 0) {
        git add -A
        git @gitAuthorArgs commit -m "revert(rollback): restore source tree to $TargetVersion (backup: $backupBranch)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '回滚提交失败' }
        $newHead = (git rev-parse --short HEAD).Trim()
        Log "源码回滚提交已生成 ($newHead)，完整保留历史可随时切回 $backupBranch。"
    } else {
        Log '当前源码已与目标版本一致，无需新提交。'
    }

    # 5. 检查依赖兼容性
    $depChanged = @(git diff --name-only $curHash $targetHash -- frontend/package.json desktop/package.json requirements.txt)
    if ($depChanged.Count -gt 0) {
        Log "检测到依赖清单存在变更 ($($depChanged -join ', '))，请留意是否需重新运行 npm install / pip install。" 'WARN'
    } else {
        Log '依赖兼容性检查通过：package.json 与 requirements.txt 无变动。'
    }

    # 6. 重新启动工作台并验证前后端健康状态
    if (-not $SkipRestart) {
        $launcher = Join-Path $RepoRoot 'desktop\launcher.ps1'
        if (Test-Path $launcher) {
            Log '正在通过 desktop\launcher.ps1 重新启动工作台并校验健康状态...'
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -NoGuiAlert
            if ($LASTEXITCODE -ne 0) {
                Log "工作台重启返回非零状态 ($LASTEXITCODE)，请查看 logs\launcher\launcher.log。" 'ERROR'
                exit 5
            }
            Log '工作台已重新启动并通过前后端健康检查。'
        } else {
            Log '未找到 desktop\launcher.ps1，跳过自动启动桌面版。' 'WARN'
        }
    } else {
        Log '已按 -SkipRestart 参数跳过服务重启（隔离测试模式）。'
    }

    Log "========== 回滚至 $TargetVersion 全部完成！日志文件：$logFile =========="
    exit 0
} catch {
    Write-Host "[ERROR] 回滚过程发生异常: $($_.Exception.Message)" -ForegroundColor Red
    exit 99
} finally {
    Pop-Location
}
