@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/2] 正在启动本地后端服务 (FastAPI http://127.0.0.1:8000)...
start "Workbench-Backend" cmd /k ".venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000"
timeout /t 2 >nul
echo [2/2] 正在启动前端界面 (Vite http://localhost:5173)...
start "Workbench-Frontend" cmd /k "cd frontend && npm run dev"
timeout /t 3 >nul
start http://localhost:5173
echo 已启动！关闭上面两个命令行窗口即可停止工作台。
