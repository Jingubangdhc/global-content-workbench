<#
.SYNOPSIS
    在 Windows 桌面创建「Global Content Workbench」快捷方式并绑定独立图标。
#>
$ErrorActionPreference = 'Stop'

$DesktopDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$VbsPath      = Join-Path $DesktopDir 'launch_hidden.vbs'
$IconPath     = Join-Path $DesktopDir 'assets\gcw-icon.ico'
$UserDesktop  = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $UserDesktop 'Global Content Workbench.lnk'

if (-not (Test-Path $VbsPath))  { throw "缺少引导脚本: $VbsPath" }
if (-not (Test-Path $IconPath)) { throw "缺少图标文件: $IconPath" }

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($ShortcutPath)
$sc.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$sc.Arguments = "`"$VbsPath`""
$sc.WorkingDirectory = $DesktopDir
$sc.IconLocation = "$IconPath,0"
$sc.Description = 'Global Content Workbench 桌面版（自动检查并启动前后端与内置浏览器工作台）'
$sc.WindowStyle = 7
$sc.Save()

Write-Output "SHORTCUT_CREATED=$ShortcutPath"
Write-Output "TARGET=$($sc.TargetPath)"
Write-Output "ARGS=$($sc.Arguments)"
Write-Output "ICON=$($sc.IconLocation)"
