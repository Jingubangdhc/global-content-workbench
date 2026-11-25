"""Phase 0 补测：B 站关键词搜索与元数据、网页正文提取（换抓取方式）。"""
import json
from pathlib import Path

import requests
import trafilatura
import yt_dlp

out = {}
opts = {"quiet": True, "no_warnings": True, "skip_download": True}

# B 站：先关键词搜索，再取第一条完整元数据
try:
    with yt_dlp.YoutubeDL({**opts, "extract_flat": True}) as y:
        s = y.extract_info("bilisearch5:外国人 中国 看病", download=False)
    ents = [{"title": e.get("title"), "url": e.get("url"), "views": e.get("view_count")} for e in s["entries"]]
    out["bili_search"] = {"ok": True, "count": len(ents), "sample": ents[:3]}
    with yt_dlp.YoutubeDL(opts) as y:
        i = y.extract_info(ents[0]["url"], download=False)
    out["bili_detail"] = {"ok": True, **{k: i.get(k) for k in
                          ["title", "uploader", "view_count", "like_count", "comment_count", "upload_date", "duration"]},
                          "subs": list((i.get("subtitles") or {}).keys())}
except Exception as e:
    out["bili"] = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}

# 网页：requests 抓取（带浏览器 UA），再交给 trafilatura 提取
ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
for u in ["https://en.wikipedia.org/wiki/Medical_tourism",
          "https://www.investopedia.com/terms/m/medical-tourism.asp",
          "https://www.cdc.gov/yellow-book/hcp/health-care-abroad/medical-tourism.html"]:
    try:
        r = requests.get(u, headers=ua, timeout=20)
        text = trafilatura.extract(r.text) or ""
        out[u] = {"status": r.status_code, "html_len": len(r.text), "chars": len(text), "head": text[:120]}
    except Exception as e:
        out[u] = {"error": f"{type(e).__name__}: {str(e)[:200]}"}

Path(__file__).with_name("results2.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(out, ensure_ascii=False, indent=1)[:3000])
