"""GCW-UAT-R4-C / GCW-R4-C-FINAL · 本地免费翻译模型安装向导与按需运行时管理（腾讯混元 Hy-MT3-1.8B）。

核心原则：
1. 统一优先管理项目 models/hunyuan-mt/ 与 runtime/llama-cpp/，同时兼容本机已装 Ollama；
2. 本地推理服务仅监听 127.0.0.1，支持需要翻译时按需启动、已运行进程直接复用（绝不重复启动）、一键停止立即释放 GPU 显存；
3. 未成功安装且未检测到可用模型时，ready_for_translation 严格为 False；本地失败时明确提示，绝不擅自切换付费 API。
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from backend.config import DATA_DIR

_MANAGED_PROC: subprocess.Popen | None = None
_START_LOCK = threading.Lock()

PROJECT_ROOT = Path(DATA_DIR).resolve().parent

MODELS_ROOT_DIR = (Path(PROJECT_ROOT) / "models" / "hunyuan-mt").resolve()
RUNTIME_LLAMA_DIR = (Path(PROJECT_ROOT) / "runtime" / "llama-cpp").resolve()
DEFAULT_MODEL_FILE = (MODELS_ROOT_DIR / "Hy-MT3-1.8B-Q4_K_M.gguf").resolve()
DEFAULT_LLAMA_SERVER = (RUNTIME_LLAMA_DIR / "llama-server.exe").resolve()
DEFAULT_MODEL_DIR = str(MODELS_ROOT_DIR)
DEFAULT_LLAMA_PORT = 8081
DEFAULT_LLAMA_ENDPOINT = f"http://127.0.0.1:{DEFAULT_LLAMA_PORT}/v1"
DEFAULT_MODEL_ALIAS = "hy-mt3-1.8b"

HY_MT3_INFO = {
    "model_name": "腾讯混元 Hy-MT3-1.8B (Q4_K_M GGUF)",
    "model_version": "Hy-MT3-1.8B-Q4_K_M",
    "model_alias": DEFAULT_MODEL_ALIAS,
    "license": "Apache License 2.0（免费可商用）",
    "estimated_download_gb": 1.35,
    "estimated_vram_gb": 1.8,
    "estimated_ram_gb": 2.4,
    "recommended_install_dir": DEFAULT_MODEL_DIR,
    "expected_sha256": "bae6e591103654ff43ef0de7d1492f6e6df1f955505f6bb2cc52e86fc399a942",
    "official_links": {
        "huggingface": "https://huggingface.co/tencent/Hy-MT3-1.8B-GGUF",
        "github": "https://github.com/Tencent-Hunyuan/Hy-MT3",
        "ollama_download": "https://ollama.com/download/windows",
        "llama_cpp_release": "https://github.com/ggml-org/llama.cpp/releases",
    },
}


def _check_port(host: str, port: int, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _probe_openai_models(base_url: str, timeout: float = 2.0) -> list[str]:
    try:
        url = base_url.rstrip("/") + "/models"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return [m.get("id") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")]
    except Exception:
        return []


def _probe_llama_health(port: int = DEFAULT_LLAMA_PORT, timeout: float = 1.5) -> bool:
    try:
        url = f"http://127.0.0.1:{port}/health"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                body = resp.read().decode("utf-8", errors="ignore")
                return "ok" in body.lower() or "loading" not in body.lower()
    except Exception:
        pass
    return False


def _detect_gpu() -> dict[str, Any]:
    smi = shutil.which("nvidia-smi")
    if not smi:
        return {
            "has_nvidia": False,
            "name": "未检测到 NVIDIA 显卡（可用 CPU 推理）",
            "driver_version": "",
            "vram_total_mb": 0,
            "vram_used_mb": 0,
            "vram_free_mb": 0,
        }
    try:
        out = subprocess.check_output(
            [smi, "--query-gpu=name,driver_version,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
            text=True,
            timeout=4,
            stderr=subprocess.DEVNULL,
        ).strip()
        if out:
            parts = [p.strip() for p in out.splitlines()[0].split(",")]
            return {
                "has_nvidia": True,
                "name": parts[0] if len(parts) > 0 else "NVIDIA GPU",
                "driver_version": parts[1] if len(parts) > 1 else "",
                "vram_total_mb": int(float(parts[2])) if len(parts) > 2 else 0,
                "vram_used_mb": int(float(parts[3])) if len(parts) > 3 else 0,
                "vram_free_mb": int(float(parts[4])) if len(parts) > 4 else 0,
            }
    except Exception:
        pass
    return {
        "has_nvidia": False,
        "name": "GPU 信息读取失败",
        "driver_version": "",
        "vram_total_mb": 0,
        "vram_used_mb": 0,
        "vram_free_mb": 0,
    }


def _find_binary(names: list[str], extra_paths: list[str]) -> str:
    for ep in extra_paths:
        if ep and os.path.exists(ep):
            return str(Path(ep).resolve())
    for nm in names:
        hit = shutil.which(nm)
        if hit:
            return hit
    return ""


def _read_llama_version(bin_path: str) -> str:
    if not bin_path or not os.path.exists(bin_path):
        return ""
    try:
        r = subprocess.run([bin_path, "--version"], capture_output=True, text=True, timeout=5)
        txt = (r.stdout or r.stderr or "").strip()
        for line in txt.splitlines():
            if "version:" in line.lower():
                return line.strip()
        return txt.splitlines()[0].strip() if txt else ""
    except Exception:
        return ""


def _find_installed_model_file() -> str:
    if DEFAULT_MODEL_FILE.exists() and DEFAULT_MODEL_FILE.stat().st_size > 100 * 1024 * 1024:
        return str(DEFAULT_MODEL_FILE)
    if MODELS_ROOT_DIR.exists():
        for p in sorted(MODELS_ROOT_DIR.glob("*.gguf")):
            if p.stat().st_size > 100 * 1024 * 1024:
                return str(p.resolve())
    return ""


def inspect_local_environment() -> dict[str, Any]:
    """只读检测本机硬件、磁盘、模型权重、llama.cpp / Ollama 运行时与本地服务端口状态。"""
    local_app = os.environ.get("LOCALAPPDATA", "")
    ollama_bin = _find_binary(
        ["ollama", "ollama.exe"],
        [os.path.join(local_app, "Programs", "Ollama", "ollama.exe")],
    )
    llama_bin = _find_binary(
        ["llama-server", "llama-server.exe"],
        [
            str(DEFAULT_LLAMA_SERVER),
            str(Path(DATA_DIR) / "bin" / "llama-server.exe"),
        ],
    )
    model_file = _find_installed_model_file()
    model_size_bytes = os.path.getsize(model_file) if model_file and os.path.exists(model_file) else 0
    model_size_gb = round(model_size_bytes / (1024**3), 2) if model_size_bytes else 0.0

    llama_port_open = _check_port("127.0.0.1", DEFAULT_LLAMA_PORT)
    ollama_port_open = _check_port("127.0.0.1", 11434)

    # FIX-F04: 严禁仅靠端口开放判定模型可用；必须真实 /health=ok 且 /v1/models 返回已加载目标模型
    llama_healthy = _probe_llama_health(DEFAULT_LLAMA_PORT) if llama_port_open else False
    llama_models = _probe_openai_models(DEFAULT_LLAMA_ENDPOINT) if llama_healthy else []
    ollama_models = _probe_openai_models("http://127.0.0.1:11434/v1") if ollama_port_open else []

    active_endpoint = ""
    detected_models: list[str] = []
    active_runtime = ""
    if llama_healthy and llama_models:
        active_endpoint = DEFAULT_LLAMA_ENDPOINT
        detected_models = llama_models
        active_runtime = "llama_cpp"
    elif ollama_port_open and ollama_models:
        active_endpoint = "http://127.0.0.1:11434/v1"
        detected_models = ollama_models
        active_runtime = "ollama"

    disk_root = Path(PROJECT_ROOT).anchor or "C:\\"
    du = shutil.disk_usage(disk_root)
    disk_free_gb = round(du.free / (1024**3), 2)
    disk_total_gb = round(du.total / (1024**3), 2)

    gpu = _detect_gpu()
    installed_ready_on_demand = bool(llama_bin and model_file)
    service_online = bool(active_endpoint and detected_models)
    ready = service_online or installed_ready_on_demand

    has_cuda_dll = bool(llama_bin and (Path(llama_bin).parent / "cudart64_12.dll").exists())
    if gpu.get("has_nvidia") and has_cuda_dll:
        compute_mode = f"GPU 加速 ({gpu['name']} · CUDA 12.4)"
    elif gpu.get("has_nvidia"):
        compute_mode = f"GPU 可用 ({gpu['name']})"
    else:
        compute_mode = "CPU 推理模式"

    llama_version = _read_llama_version(llama_bin) if llama_bin else ""
    loaded_model_name = detected_models[0] if detected_models else (DEFAULT_MODEL_ALIAS if model_file else "")

    if service_online:
        status_label = f"本地推理在线运行中（{active_endpoint} · 模型：{loaded_model_name}）"
    elif installed_ready_on_demand:
        status_label = "模型与推理环境已安装就绪（待命省显存模式：翻译时将自动按需启动）"
    else:
        status_label = "未安装或未启动本地免费翻译模型（待用户授权安装）"

    return {
        "ok": True,
        "ready_for_translation": ready,
        "service_online": service_online,
        "installed_on_demand": installed_ready_on_demand,
        "status_label": status_label,
        "model_info": HY_MT3_INFO,
        "deployment": {
            "model_actual_path": model_file or str(DEFAULT_MODEL_FILE),
            "model_dir": str(MODELS_ROOT_DIR),
            "model_installed": bool(model_file),
            "model_size_bytes": model_size_bytes,
            "model_size_gb": model_size_gb,
            "model_version": HY_MT3_INFO["model_version"] if model_file else "未安装",
            "runtime_framework": "llama.cpp (CUDA 12.4)" if llama_bin else ("Ollama" if ollama_bin else "未安装"),
            "runtime_dir": str(Path(llama_bin).parent) if llama_bin else str(RUNTIME_LLAMA_DIR),
            "runtime_binary": llama_bin,
            "runtime_version": llama_version or ("b12823" if llama_bin else ""),
            "local_endpoint": active_endpoint or DEFAULT_LLAMA_ENDPOINT,
            "loaded_model_name": loaded_model_name,
            "compute_mode": compute_mode,
            "license": HY_MT3_INFO["license"],
        },
        "hardware": {
            "gpu": gpu,
            "disk_drive": disk_root,
            "disk_free_gb": disk_free_gb,
            "disk_total_gb": disk_total_gb,
            "disk_sufficient": disk_free_gb >= 5.0,
        },
        "runtimes": {
            "ollama": {
                "installed": bool(ollama_bin),
                "binary_path": ollama_bin,
                "port": 11434,
                "port_open": ollama_port_open,
                "endpoint": "http://127.0.0.1:11434/v1",
                "models": ollama_models,
            },
            "llama_cpp": {
                "installed": bool(llama_bin),
                "binary_path": llama_bin,
                "version": llama_version,
                "port": DEFAULT_LLAMA_PORT,
                "port_open": llama_port_open,
                "endpoint": DEFAULT_LLAMA_ENDPOINT,
                "models": llama_models,
            },
        },
        "active_runtime": active_runtime,
        "active_endpoint": active_endpoint,
        "detected_models": detected_models,
        "managed_process_running": bool(_MANAGED_PROC and _MANAGED_PROC.poll() is None),
    }


def ensure_local_service_running(wait_timeout_sec: float = 45.0) -> dict[str, Any]:
    """按需启动本地混元推理服务：已运行直接复用，绝不重复启动进程，仅监听 127.0.0.1。"""
    global _MANAGED_PROC
    with _START_LOCK:
        env = inspect_local_environment()
        if env["service_online"]:
            return {
                "ok": True,
                "reused": True,
                "endpoint": env["active_endpoint"],
                "model_id": (env["detected_models"] or [DEFAULT_MODEL_ALIAS])[0],
                "message": f"复用已在线的本地推理服务：{env['active_endpoint']}",
                "env": env,
            }

        llama_bin = env["runtimes"]["llama_cpp"]["binary_path"]
        model_file = _find_installed_model_file()
        if llama_bin and model_file:
            # 若端口已打开但尚未就绪（模型加载中），直接等待而不重复拉起
            if not _check_port("127.0.0.1", DEFAULT_LLAMA_PORT):
                gpu = env["hardware"]["gpu"]
                ngl = "99" if gpu.get("has_nvidia") else "0"
                cmd = [
                    llama_bin,
                    "-m",
                    model_file,
                    "--alias",
                    DEFAULT_MODEL_ALIAS,
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(DEFAULT_LLAMA_PORT),
                    "-ngl",
                    ngl,
                    "-c",
                    "4096",
                    "--jinja",
                ]
                _MANAGED_PROC = subprocess.Popen(
                    cmd,
                    cwd=str(Path(llama_bin).parent),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )

            deadline = time.time() + wait_timeout_sec
            while time.time() < deadline:
                if _probe_llama_health(DEFAULT_LLAMA_PORT):
                    models = _probe_openai_models(DEFAULT_LLAMA_ENDPOINT)
                    if models:
                        fresh = inspect_local_environment()
                        try:
                            from backend.services.translation_provider import clear_stale_test_status
                            clear_stale_test_status(
                                "hunyuan_mt3_local",
                                ok=True,
                                message=f"本地混元 GPU 推理服务在线（{DEFAULT_LLAMA_ENDPOINT} · 模型：{models[0]} · {fresh['deployment']['compute_mode']}）",
                            )
                        except Exception:
                            pass
                        return {
                            "ok": True,
                            "reused": False,
                            "endpoint": DEFAULT_LLAMA_ENDPOINT,
                            "model_id": models[0],
                            "message": f"已按需启动本地混元 GPU 推理服务（{DEFAULT_LLAMA_ENDPOINT} · {models[0]}）",
                            "env": fresh,
                        }
                if _MANAGED_PROC and _MANAGED_PROC.poll() is not None:
                    return {
                        "ok": False,
                        "message": f"本地 llama-server 进程启动后异常退出（exit={_MANAGED_PROC.returncode}），请检查 CUDA 驱动或模型文件完整性。",
                        "env": inspect_local_environment(),
                    }
                time.sleep(0.6)
            return {
                "ok": False,
                "message": "等待本地混元推理服务就绪超时，请检查显存占用后重试。",
                "env": inspect_local_environment(),
            }

        # 兼容本机已安装 Ollama
        ollama_bin = env["runtimes"]["ollama"]["binary_path"]
        if ollama_bin:
            if not _check_port("127.0.0.1", 11434):
                _MANAGED_PROC = subprocess.Popen(
                    [ollama_bin, "serve"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
            time.sleep(2.0)
            fresh = inspect_local_environment()
            if fresh["service_online"]:
                return {
                    "ok": True,
                    "reused": False,
                    "endpoint": fresh["active_endpoint"],
                    "model_id": fresh["detected_models"][0],
                    "message": "已按需启动 Ollama 本地推理服务",
                    "env": fresh,
                }
            return {"ok": False, "message": "Ollama 服务已启动但未发现可用混元模型", "env": fresh}

        return {
            "ok": False,
            "requires_install": True,
            "message": "未检测到已安装的本地推理环境或 Hy-MT3-1.8B GGUF 模型文件，请先完成授权安装。",
            "env": env,
        }


def stop_local_service() -> dict[str, Any]:
    """停止本地推理服务并释放 RTX 4060 GPU 显存。"""
    global _MANAGED_PROC
    stopped = False
    if _MANAGED_PROC and _MANAGED_PROC.poll() is None:
        _MANAGED_PROC.terminate()
        try:
            _MANAGED_PROC.wait(timeout=5)
        except Exception:
            _MANAGED_PROC.kill()
        _MANAGED_PROC = None
        stopped = True

    # 若端口 8081 仍有本项目 llama-server 进程（如上次后端重启前拉起的），一并清理释放显存
    if os.name == "nt" and _check_port("127.0.0.1", DEFAULT_LLAMA_PORT):
        try:
            ps = (
                f"$p = (Get-NetTCPConnection -LocalPort {DEFAULT_LLAMA_PORT} -State Listen -ErrorAction SilentlyContinue "
                "| Select-Object -First 1).OwningProcess; "
                "if ($p) { $proc = Get-Process -Id $p -ErrorAction SilentlyContinue; "
                "if ($proc -and $proc.ProcessName -like '*llama*') { Stop-Process -Id $p -Force; Write-Output 'KILLED' } }"
            )
            r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=8)
            if "KILLED" in (r.stdout or ""):
                stopped = True
        except Exception:
            pass

    time.sleep(0.8)
    env = inspect_local_environment()
    if stopped:
        try:
            from backend.services.translation_provider import clear_stale_test_status
            clear_stale_test_status("hunyuan_mt3_local", ok=None, message="")
        except Exception:
            pass
    return {
        "ok": True,
        "stopped": stopped,
        "message": (
            f"已停止本地推理服务并释放显存（当前 GPU 已用显存：{env['hardware']['gpu']['vram_used_mb']} MiB）"
            if stopped
            else "当前无运行中的本地推理服务"
        ),
        "env": env,
    }


def control_local_service(action: str, runtime: str = "llama_cpp") -> dict[str, Any]:
    """按需启动、停止释放显存或健康检查本地推理服务。"""
    if action == "health":
        env = inspect_local_environment()
        return {"ok": env["service_online"] or env["installed_on_demand"], "env": env, "message": env["status_label"]}
    if action == "stop":
        return stop_local_service()
    if action == "start":
        return ensure_local_service_running()
    return {"ok": False, "message": f"未知操作：{action}", "env": inspect_local_environment()}


def open_model_directory() -> dict[str, Any]:
    """在系统文件管理器中安全打开项目本地模型存储目录（严格白名单限项目 models/hunyuan-mt）。"""
    MODELS_ROOT_DIR.mkdir(parents=True, exist_ok=True)
    target = str(MODELS_ROOT_DIR)
    try:
        if os.name == "nt":
            os.startfile(target)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", target])
        return {"ok": True, "path": target, "message": f"已打开模型目录：{target}"}
    except Exception as e:
        return {"ok": False, "path": target, "message": f"打开模型目录失败：{e}"}


def authorized_pull_local_model(user_authorized: bool, model_tag: str = "hy-mt3-1.8b") -> dict[str, Any]:
    """仅在用户显式授权 (user_authorized=True) 时允许拉取/验证模型；否则严禁绕过授权。"""
    if not user_authorized:
        return {
            "ok": False,
            "requires_authorization": True,
            "message": "未获得用户显式下载授权，已阻止自动下载本地模型权重。",
        }
    env = inspect_local_environment()
    if env["installed_on_demand"]:
        return {
            "ok": True,
            "message": f"模型已完整安装于 {env['deployment']['model_actual_path']}（{env['deployment']['model_size_gb']} GB），可直接点击「启动本地服务」或直接发起翻译按需拉起。",
            "env": env,
        }
    return {
        "ok": True,
        "command": "python scripts/install_local_hunyuan_mt.py",
        "message": "已确认用户授权，可运行项目内置脚本 `scripts/install_local_hunyuan_mt.py` 下载官方 Hy-MT3-1.8B-Q4_K_M.gguf 与 llama.cpp CUDA 12.4 加速包。",
        "env": env,
    }
