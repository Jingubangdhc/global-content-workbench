@echo off
chcp 65001 >nul
echo ============================================================
echo 独立安装并启动 Evil0ctal/Douyin_TikTok_Download_API (端口 8080)
echo 启动后在工作台设置页填入 http://127.0.0.1:8080 即可自动打通抖音/TikTok解析
echo ============================================================
set "DIR=%~dp0Douyin_TikTok_Download_API"
if not exist "%DIR%" (
    echo [1/3] 正在克隆开源仓库...
    git clone --depth 1 https://github.com/Evil0ctal/Douyin_TikTok_Download_API.git "%DIR%"
)
cd /d "%DIR%"
if not exist ".venv" (
    echo [2/3] 正在创建独立虚拟环境并安装依赖...
    python -m venv .venv
    .venv\Scripts\python.exe -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
)
echo [3/3] 正在启动服务 http://127.0.0.1:8080 ...
.venv\Scripts\python.exe start.py
pause
