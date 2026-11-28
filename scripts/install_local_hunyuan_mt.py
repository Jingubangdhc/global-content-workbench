"""GCW-R4-C-FINAL：官方授权下载与部署脚本
1. 下载 llama.cpp b12823 CUDA 12.4 Windows 便携版 + cudart 到 runtime/llama-cpp/
2. 下载腾讯混元官方 Hy-MT3-1.8B-Q4_K_M.gguf 到 models/hunyuan-mt/ 并校验官方 SHA256
3. 清理临时 zip 包，输出安装校验报告 JSON
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MODEL_DIR = os.path.join(ROOT, "models", "hunyuan-mt")
RUNTIME_DIR = os.path.join(ROOT, "runtime", "llama-cpp")
TMP_DIR = os.path.join(ROOT, "runtime", "_tmp")
os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(RUNTIME_DIR, exist_ok=True)
os.makedirs(TMP_DIR, exist_ok=True)

MODEL_URL = "https://huggingface.co/tencent/Hy-MT3-1.8B-GGUF/resolve/main/Hy-MT3-1.8B-Q4_K_M.gguf"
MODEL_PATH = os.path.join(MODEL_DIR, "Hy-MT3-1.8B-Q4_K_M.gguf")
MODEL_EXPECTED_SIZE = 1348432160
MODEL_EXPECTED_SHA256 = "bae6e591103654ff43ef0de7d1492f6e6df1f955505f6bb2cc52e86fc399a942"

LLAMA_TAG = "b12823"
LLAMA_ZIPS = [
    (
        "llama-b12823-bin-win-cuda-12.4-x64.zip",
        "https://github.com/ggml-org/llama.cpp/releases/download/b12823/llama-b12823-bin-win-cuda-12.4-x64.zip",
    ),
    (
        "cudart-llama-bin-win-cuda-12.4-x64.zip",
        "https://github.com/ggml-org/llama.cpp/releases/download/b12823/cudart-llama-bin-win-cuda-12.4-x64.zip",
    ),
]


def download_file(url: str, dst: str, label: str, expected_size: int | None = None):
    if os.path.exists(dst) and expected_size and os.path.getsize(dst) == expected_size:
        print(f"[SKIP] {label} 已完整存在 ({expected_size} bytes)", flush=True)
        return
    t0 = time.time()
    print(f"[START] 下载 {label} -> {dst}", flush=True)
    # 优先用系统 curl.exe（支持断点续传、HTTP/2 与自动跟随重定向）
    cmd = ["curl.exe", "-L", "-C", "-", "--retry", "5", "--retry-delay", "3", "-sS", "-o", dst, url]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"下载 {label} 失败: {res.stderr}")
    size = os.path.getsize(dst)
    elapsed = time.time() - t0
    print(f"[DONE] {label}: {size / (1024*1024):.1f} MB in {elapsed:.1f}s", flush=True)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def main():
    tasks = [
        (MODEL_URL, MODEL_PATH, "Hy-MT3-1.8B-Q4_K_M.gguf", MODEL_EXPECTED_SIZE),
    ]
    zip_paths = []
    for name, url in LLAMA_ZIPS:
        zp = os.path.join(TMP_DIR, name)
        zip_paths.append((name, zp))
        if not os.path.exists(os.path.join(RUNTIME_DIR, "llama-server.exe")) or not os.path.exists(
            os.path.join(RUNTIME_DIR, "cudart64_12.dll")
        ):
            tasks.append((url, zp, name, None))

    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = [ex.submit(download_file, *t) for t in tasks]
        for fut in futs:
            fut.result()

    # 解压 llama.cpp CUDA 便携包
    for name, zp in zip_paths:
        if os.path.exists(zp):
            print(f"[EXTRACT] 解压 {name} -> {RUNTIME_DIR}", flush=True)
            with zipfile.ZipFile(zp, "r") as zf:
                zf.extractall(RUNTIME_DIR)
            os.remove(zp)
    try:
        os.rmdir(TMP_DIR)
    except OSError:
        pass

    # 校验模型哈希
    print("[VERIFY] 计算 Hy-MT3-1.8B-Q4_K_M.gguf SHA256...", flush=True)
    actual_sha = sha256_file(MODEL_PATH)
    actual_size = os.path.getsize(MODEL_PATH)
    sha_ok = actual_sha.lower() == MODEL_EXPECTED_SHA256.lower()
    if not sha_ok:
        raise RuntimeError(f"SHA256 不匹配！期望 {MODEL_EXPECTED_SHA256}，实际 {actual_sha}")

    # 检查 llama-server 版本
    server_exe = os.path.join(RUNTIME_DIR, "llama-server.exe")
    ver_out = subprocess.run([server_exe, "--version"], capture_output=True, text=True, timeout=15)
    ver_text = (ver_out.stdout or ver_out.stderr or "").strip()

    result = {
        "ok": True,
        "llama_cpp_tag": LLAMA_TAG,
        "llama_server_path": server_exe,
        "llama_server_version": ver_text,
        "model_path": MODEL_PATH,
        "model_size_bytes": actual_size,
        "model_sha256": actual_sha,
        "sha256_verified": sha_ok,
        "license": "Apache-2.0",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
