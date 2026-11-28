@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [GCW Desktop] 正在检查前后端服务并启动 Global Content Workbench 桌面版...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
if errorlevel 1 (
    echo [GCW Desktop] 启动异常，请查看 logs\launcher\launcher.log
    pause
)
