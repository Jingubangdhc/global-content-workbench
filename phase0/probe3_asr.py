"""Phase 0 补测：视频 → 下载音频 → 本地语音识别 → 删除音频。用法：python probe3_asr.py <视频链接> <语言>"""
import json, os, sys, time
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")  # 国内网络下载模型用镜像
import yt_dlp
from faster_whisper import WhisperModel

URL, LANG = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)
tmp = Path(__file__).with_name("tmp_audio")
tmp.mkdir(exist_ok=True)
for f in tmp.iterdir():
    f.unlink()
out = {"url": URL}

t = time.time()
with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "format": "bestaudio",
                       "http_headers": {"Referer": "https://www.bilibili.com/"},
                       "outtmpl": str(tmp / "%(id)s.%(ext)s")}) as y:
    y.extract_info(URL, download=True)
audio = next(tmp.iterdir())
out["download_sec"] = round(time.time() - t, 1)
out["audio_mb"] = round(audio.stat().st_size / 1e6, 2)

for device, ctype in [("cuda", "float16"), ("cpu", "int8")]:
    try:
        t = time.time()
        model = WhisperModel("small", device=device, compute_type=ctype)
        load = round(time.time() - t, 1)
        t = time.time()
        segs, meta = model.transcribe(str(audio), language=LANG, vad_filter=True)
        text = "".join(s.text for s in segs)
        out[device] = {"ok": True, "load_sec": load, "asr_sec": round(time.time() - t, 1),
                       "audio_sec": round(meta.duration, 1), "lang": meta.language,
                       "chars": len(text), "head": text[:200]}
        break  # GPU 成功就不再测 CPU
    except Exception as e:
        out[device] = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}

audio.unlink()  # 转写完立即删除音频
out["audio_deleted"] = not audio.exists()
Path(__file__).with_name("results3.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(out, ensure_ascii=False, indent=1))
