"""五级文案提取流水线 + 按次手动触发的 OpenAI 兼容大模型翻译。"""
import ctypes
import json
import os
import sys
import uuid
from pathlib import Path

import requests
import trafilatura
import yt_dlp
from openai import OpenAI
from youtube_transcript_api import YouTubeTranscriptApi

from backend.config import BROWSER_UA, TMP_AUDIO_DIR

_WHISPER_CACHE = {}
_CUDA_DIRS_REGISTERED = False


def _register_nvidia_dll_dirs() -> None:
    """Windows 下将 pip 安装的 nvidia-cublas / nvidia-cudnn bin 目录加入 DLL 搜索路径。"""
    global _CUDA_DIRS_REGISTERED
    if _CUDA_DIRS_REGISTERED:
        return
    _CUDA_DIRS_REGISTERED = True
    nvidia_root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if not nvidia_root.exists():
        return
    for bin_dir in nvidia_root.glob("*/bin"):
        if bin_dir.is_dir():
            try:
                os.add_dll_directory(str(bin_dir))
            except Exception:
                pass
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


def _detect_whisper_device() -> tuple[str, str]:
    """检测本机是否存在可用 CUDA 运行库（RTX 4060 加速），缺失时无感回退 CPU int8。"""
    pref = os.getenv("WHISPER_DEVICE", "auto").strip().lower()
    if pref == "cpu":
        return "cpu", "int8"
    _register_nvidia_dll_dirs()
    try:
        ctypes.CDLL("cublas64_12.dll")
        return "cuda", "float16"
    except OSError:
        return "cpu", "int8"


def get_whisper_model():
    """懒加载并缓存 faster-whisper 模型。"""
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    size = os.getenv("WHISPER_MODEL_SIZE", "small").strip() or "small"
    device, ctype = _detect_whisper_device()
    key = (size, device, ctype)
    if key not in _WHISPER_CACHE:
        from faster_whisper import WhisperModel
        _WHISPER_CACHE[key] = WhisperModel(size, device=device, compute_type=ctype)
    return _WHISPER_CACHE[key], device


def transcribe_local_audio(audio_path: Path, language: str | None = None) -> dict:
    """使用 faster-whisper 转写本地音视频文件。"""
    model, device = get_whisper_model()
    segs_iter, info = model.transcribe(str(audio_path), language=language, vad_filter=True)
    segments = []
    texts = []
    for s in segs_iter:
        t = (s.text or "").strip()
        if t:
            segments.append({"start": round(float(s.start), 1), "text": t})
            texts.append(t)
    full_text = "\n".join(texts)
    return {
        "ok": True,
        "extract_method": f"local_whisper_{device}",
        "language": info.language or "",
        "raw_text": full_text,
        "segments": segments,
        "error": "",
    }


def extract_transcript_pipeline(platform: str, platform_item_id: str, url: str, cookie_browser: str = "none") -> dict:
    """
    严格按 Phase 0 实测验证过的五级流水线提取原文：
    1. YouTube 官方/自动字幕 (youtube-transcript-api)
    2. 网页文章 (requests 带浏览器 UA + trafilatura，严禁 trafilatura.fetch_url)
    3. 视频下载最轻音频流 -> 本地 faster-whisper 转写 -> 立即删除音频
    4. 失败返回清晰错误原因，引导前端“拖拽本地文件转写”或“手动粘贴”
    """
    # L1：YouTube 优先走字幕秒提
    if platform == "youtube" and platform_item_id:
        try:
            api = YouTubeTranscriptApi()
            tr = api.fetch(platform_item_id, languages=["zh-Hans", "zh", "zh-CN", "en", "en-US"])
            segments = [{"start": round(float(s.start), 1), "text": s.text.replace("\n", " ").strip()} for s in tr]
            raw_text = "\n".join(s["text"] for s in segments if s["text"])
            if raw_text:
                return {
                    "ok": True,
                    "extract_method": "youtube_sub",
                    "language": "auto",
                    "raw_text": raw_text,
                    "segments": segments,
                    "error": "",
                }
        except Exception:
            pass  # 无字幕则继续往下走音频转写

    # L2：网页/文章/社区帖子
    if platform in ("web", "reddit", "zhihu", "weibo"):
        try:
            r = requests.get(url, headers={"User-Agent": BROWSER_UA}, timeout=20)
            if r.status_code != 200:
                return {
                    "ok": False,
                    "extract_method": "trafilatura",
                    "language": "",
                    "raw_text": "",
                    "segments": [],
                    "error": f"目标站点返回 HTTP {r.status_code}（拒绝程序抓取），请直接在浏览器复制正文粘贴到右侧。",
                }
            text = trafilatura.extract(r.text) or ""
            if len(text.strip()) < 30:
                return {
                    "ok": False,
                    "extract_method": "trafilatura",
                    "language": "",
                    "raw_text": "",
                    "segments": [],
                    "error": "页面需要登录或为动态渲染，未能自动抽取正文，请手动粘贴。",
                }
            return {
                "ok": True,
                "extract_method": "trafilatura",
                "language": "auto",
                "raw_text": text.strip(),
                "segments": [],
                "error": "",
            }
        except Exception as e:
            return {
                "ok": False,
                "extract_method": "trafilatura",
                "language": "",
                "raw_text": "",
                "segments": [],
                "error": f"网页抓取失败：{str(e)[:150]}",
            }

    # L3：视频平台 -> 下载最轻音频流 -> 本地 Whisper 转写 -> 立即删除音频
    tmp_id = uuid.uuid4().hex[:10]
    outtmpl = str(TMP_AUDIO_DIR / f"{tmp_id}.%(ext)s")
    opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "socket_timeout": 25,
    }
    if platform == "bilibili":
        opts["http_headers"] = {"Referer": "https://www.bilibili.com/"}
    if cookie_browser and cookie_browser in ("chrome", "edge", "firefox"):
        opts["cookiesfrombrowser"] = (cookie_browser,)

    downloaded: Path | None = None
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            y.extract_info(url, download=True)
        matches = list(TMP_AUDIO_DIR.glob(f"{tmp_id}.*"))
        if not matches:
            raise RuntimeError("未找到下载完成的音频文件")
        downloaded = matches[0]
        return transcribe_local_audio(downloaded)
    except Exception as e:
        err_msg = str(e)[:220]
        hint = ""
        if "567" in err_msg or "403" in err_msg or "Sign in" in err_msg or "cookie" in err_msg.lower():
            hint = "（平台风控拦截：可在设置页开启读取 Edge/Chrome 登录态重试，或直接拖拽本地音视频文件到下方转写）"
        return {
            "ok": False,
            "extract_method": "local_whisper",
            "language": "",
            "raw_text": "",
            "segments": [],
            "error": f"音频提取失败：{err_msg} {hint}",
        }
    finally:
        if downloaded and downloaded.exists():
            try:
                downloaded.unlink()
            except Exception:
                pass


def translate_with_llm(text: str, target_lang: str = "简体中文") -> dict:
    """
    仅在用户手动点击【翻译成中文】按钮时触发，使用 .env 中的 OpenAI 兼容配置。
    """
    api_key = os.getenv("LLM_API_KEY", "").strip()
    base_url = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1").strip()
    model = os.getenv("LLM_MODEL", "deepseek-chat").strip()
    if not api_key:
        raise ValueError("尚未配置 LLM_API_KEY。请先在右上角【设置】或项目根目录 .env 中填入兼容 OpenAI 格式的 API Key。")

    client = OpenAI(api_key=api_key, base_url=base_url)
    # 超过 12000 字分段翻译，避免超长截断
    chunk_size = 6000
    chunks = [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]
    translated_parts = []
    total_tokens = 0

    for idx, ck in enumerate(chunks):
        resp = client.chat.completions.create(
            model=model,
            temperature=0.2,
            messages=[
                {
                    "role": "system",
                    "content": f"你是专业自媒体文案翻译官。请将用户提供的口播原文或文章准确、自然地翻译为{target_lang}，保留原有段落结构与关键数据，不要添加多余解释。",
                },
                {"role": "user", "content": ck},
            ],
        )
        translated_parts.append((resp.choices[0].message.content or "").strip())
        if resp.usage and resp.usage.total_tokens:
            total_tokens += resp.usage.total_tokens

    return {
        "translated_text": "\n\n".join(translated_parts),
        "model": model,
        "total_tokens": total_tokens,
    }
