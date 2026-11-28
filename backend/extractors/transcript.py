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


def _crawl4ai_extract_markdown(url: str) -> str:
    """阶段 A：当 requests + trafilatura 遇到 JS 动态渲染或 403 时，优先走 Crawl4AI，未装时自动回退 Jina Reader 免费转 Markdown。"""
    try:
        import asyncio
        from crawl4ai import AsyncWebCrawler

        async def _run():
            async with AsyncWebCrawler(verbose=False) as crawler:
                res = await crawler.arun(url=url)
                md = getattr(res, "markdown", None)
                if hasattr(md, "raw_markdown"):
                    return (md.raw_markdown or "").strip()
                return str(md or "").strip()

        out = asyncio.run(_run())
        if len(out) >= 40:
            return out
    except Exception:
        pass
    # 零依赖兜底：Jina Reader 公开免费网页转 Markdown 服务
    try:
        r = requests.get(f"https://r.jina.ai/{url}", headers={"User-Agent": BROWSER_UA, "X-Return-Format": "markdown"}, timeout=20)
        if r.status_code == 200 and len(r.text.strip()) >= 40:
            return r.text.strip()
    except Exception:
        pass
    return ""


def _transcribe_with_sensevoice(audio_path: Path) -> dict | None:
    """阶段 C：阿里 SenseVoice 中文/多语言极速语音识别（通过 funasr_onnx 或 funasr 运行，未装时自动回退 Whisper）。"""
    try:
        from funasr import AutoModel

        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        device, _ = _detect_whisper_device()
        key = ("sensevoice", device)
        if key not in _WHISPER_CACHE:
            _WHISPER_CACHE[key] = AutoModel(
                model="iic/SenseVoiceSmall",
                trust_remote_code=False,
                device="cuda:0" if device == "cuda" else "cpu",
                disable_update=True,
            )
        res = _WHISPER_CACHE[key].generate(input=str(audio_path), cache={}, language="auto", use_itn=True)
        raw = (res[0].get("text") or "").strip() if res else ""
        # 清理 SenseVoice 输出的情感/事件标签 <|zh|><|NEUTRAL|> 等
        import re as _re
        clean = _re.sub(r"<\|[^|]+\|>", "", raw).strip()
        if clean:
            return {
                "ok": True,
                "extract_method": f"sensevoice_{device}",
                "language": "zh/auto",
                "raw_text": clean,
                "segments": [],
                "error": "",
            }
    except Exception:
        return None
    return None


def normalize_segments(
    segments: list[dict],
    video_duration_sec: float | None = None,
) -> tuple[list[dict], float | None, float | None]:
    """规范化字幕时间轴：
    1. 优先保留真实 start / end 及原始 end_source（platform_duration / whisper_timestamp）；
    2. 历史缺失 end 的段落使用下一段 start 估算并标记 end_source = 'estimated_next_start'；
    3. 末段若无真实 end，绝不无依据伪造结束时间，保持 end = None 且 end_source = 'unknown'；
    4. 返回 (normalized_segments, coverage_start, coverage_end)。
    """
    if not segments:
        return [], None, None
    cleaned: list[dict] = []
    for raw in segments:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        try:
            start = round(float(raw.get("start", 0.0)), 2)
        except (TypeError, ValueError):
            start = 0.0
        end_val = raw.get("end")
        end_num: float | None = None
        if end_val is not None:
            try:
                pe = round(float(end_val), 2)
                if pe > start:
                    end_num = pe
            except (TypeError, ValueError):
                end_num = None
        elif raw.get("duration") is not None:
            try:
                dur = float(raw.get("duration"))
                if dur > 0:
                    end_num = round(start + dur, 2)
            except (TypeError, ValueError):
                end_num = None
        end_source = str(raw.get("end_source") or "").strip()
        if end_num is not None and not end_source:
            end_source = "platform_duration"
        cleaned.append(
            {
                "start": start,
                "end": end_num,
                "end_source": end_source or "unknown",
                "text": text,
            }
        )

    for i, seg in enumerate(cleaned):
        if seg["end"] is None:
            if i + 1 < len(cleaned) and cleaned[i + 1]["start"] > seg["start"]:
                seg["end"] = round(cleaned[i + 1]["start"], 2)
                seg["end_source"] = "estimated_next_start"
            else:
                seg["end"] = None
                seg["end_source"] = "unknown"

    cov_start = cleaned[0]["start"] if cleaned else None
    last = cleaned[-1] if cleaned else None
    cov_end = last["end"] if (last and last["end"] is not None) else (last["start"] if last else None)
    if video_duration_sec and cov_end is not None and cov_end > video_duration_sec + 5:
        cov_end = round(float(video_duration_sec), 2)
    return cleaned, cov_start, cov_end


def transcribe_local_audio(audio_path: Path, language: str | None = None) -> dict:
    """优先按用户设置选择 SenseVoice（中文极速）或 faster-whisper（RTX 4060 CUDA / CPU）。"""
    engine = os.getenv("ASR_ENGINE", "whisper").strip().lower()
    if engine == "sensevoice":
        sv = _transcribe_with_sensevoice(audio_path)
        if sv:
            return sv

    model, device = get_whisper_model()
    segs_iter, info = model.transcribe(str(audio_path), language=language, vad_filter=True)
    segments = []
    texts = []
    for s in segs_iter:
        t = (s.text or "").strip()
        if t:
            segments.append(
                {
                    "start": round(float(s.start), 2),
                    "end": round(float(s.end), 2),
                    "end_source": "whisper_timestamp",
                    "text": t,
                }
            )
            texts.append(t)
    norm_segs, cov_start, cov_end = normalize_segments(segments)
    full_text = "\n".join(texts)
    return {
        "ok": True,
        "extract_method": f"local_whisper_{device}",
        "language": info.language or "",
        "raw_text": full_text,
        "segments": norm_segs,
        "subtitle_coverage_start": cov_start,
        "subtitle_coverage_end": cov_end,
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
    # L1：YouTube 优先走字幕秒提（完整记录真实 start/end 与 language_code）
    if platform == "youtube" and platform_item_id:
        try:
            api = YouTubeTranscriptApi()
            tr = api.fetch(platform_item_id, languages=["zh-Hans", "zh", "zh-CN", "en", "en-US", "en-GB"])
            detected_lang = str(getattr(tr, "language_code", "") or "").strip() or "en"
            segments = []
            for s in tr:
                txt = s.text.replace("\n", " ").strip()
                if not txt:
                    continue
                start = round(float(s.start), 2)
                dur = float(getattr(s, "duration", 0.0) or 0.0)
                end = round(start + dur, 2) if dur > 0 else None
                segments.append(
                    {
                        "start": start,
                        "end": end,
                        "end_source": "platform_duration" if end is not None else "unknown",
                        "text": txt,
                    }
                )
            norm_segs, cov_start, cov_end = normalize_segments(segments)
            raw_text = "\n".join(s["text"] for s in norm_segs if s["text"])
            if raw_text:
                return {
                    "ok": True,
                    "extract_method": "youtube_sub",
                    "language": detected_lang,
                    "raw_text": raw_text,
                    "segments": norm_segs,
                    "subtitle_coverage_start": cov_start,
                    "subtitle_coverage_end": cov_end,
                    "error": "",
                }
        except Exception:
            pass  # 无字幕则继续往下走音频转写

    # L2：网页/文章/社区帖子（先轻量 requests+trafilatura，失败自动升级 Crawl4AI 无头浏览器抓取）
    if platform in ("web", "reddit", "zhihu", "weibo"):
        try:
            r = requests.get(url, headers={"User-Agent": BROWSER_UA}, timeout=20)
            if r.status_code == 200:
                text = (trafilatura.extract(r.text) or "").strip()
                if len(text) >= 40:
                    return {
                        "ok": True,
                        "extract_method": "trafilatura",
                        "language": "auto",
                        "raw_text": text,
                        "segments": [],
                        "error": "",
                    }
            # 轻量提取失败或遇到 403/JS渲染 -> 自动升级 Crawl4AI
            c4 = _crawl4ai_extract_markdown(url)
            if len(c4) >= 40:
                return {
                    "ok": True,
                    "extract_method": "crawl4ai",
                    "language": "auto",
                    "raw_text": c4,
                    "segments": [],
                    "error": "",
                }
            return {
                "ok": False,
                "extract_method": "trafilatura+crawl4ai",
                "language": "",
                "raw_text": "",
                "segments": [],
                "error": f"目标站点返回 HTTP {r.status_code} 且 Crawl4AI 未能穿透登录/风控，请直接在浏览器复制正文粘贴到左侧。",
            }
        except Exception as e:
            c4 = _crawl4ai_extract_markdown(url)
            if len(c4) >= 40:
                return {
                    "ok": True,
                    "extract_method": "crawl4ai",
                    "language": "auto",
                    "raw_text": c4,
                    "segments": [],
                    "error": "",
                }
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


def translate_batch_with_llm(texts: list[str], target_lang: str = "简体中文") -> dict:
    """
    批量多语言翻译（自动识别英/俄/西/法/日/韩/阿等任意语种 -> 简体中文），
    一次请求打包返回 JSON 数组，大幅节省 Token。
    """
    import re as _re

    api_key = os.getenv("LLM_API_KEY", "").strip()
    base_url = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1").strip()
    model = os.getenv("LLM_MODEL", "deepseek-chat").strip()
    if not api_key:
        raise ValueError("尚未配置 LLM_API_KEY，请在左下角【设置】中填写兼容 OpenAI 格式的 API Key。")

    numbered = [{"i": idx, "text": (t or "")[:1200]} for idx, t in enumerate(texts)]
    prompt = (
        f"你是精通多语言（英文、俄语、西班牙语、法语、日语、韩语、德语、阿拉伯语等）的自媒体翻译官。"
        f"请自动识别下面 JSON 数组中每条 text 的源语言，并将其自然、准确地翻译为{target_lang}（若本来就是中文则润色保留）。"
        f"仅返回合法 JSON 数组，不要任何 markdown 代码块或多余文字，格式严格为：\n"
        f'[{{"i": 0, "lang": "EN/RU/ES/FR/JA/ZH等简写", "zh": "中文译文"}}]\n\n'
        f"待翻译列表：\n{json.dumps(numbered, ensure_ascii=False)}"
    )

    client = OpenAI(api_key=api_key, base_url=base_url)
    resp = client.chat.completions.create(
        model=model,
        temperature=0.2,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = (resp.choices[0].message.content or "").strip()
    raw = _re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=_re.IGNORECASE).strip()
    parsed = json.loads(raw)
    by_idx = {int(x["i"]): {"lang": str(x.get("lang", "")), "zh": str(x.get("zh", ""))} for x in parsed if "i" in x}
    results = [by_idx.get(i, {"lang": "", "zh": ""}) for i in range(len(texts))]
    return {
        "results": results,
        "model": model,
        "total_tokens": resp.usage.total_tokens if resp.usage else None,
    }
