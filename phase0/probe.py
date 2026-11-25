"""Phase 0 可行性实测脚本：只读访问公开页面，低频调用，结果写入 results.json。"""
import json, statistics, sys, time, traceback
from pathlib import Path

import requests
import trafilatura
import yt_dlp
from youtube_transcript_api import YouTubeTranscriptApi

OUT = Path(__file__).with_name("results.json")
results = {}


def record(name, fn):
    """执行单项测试并记录耗时、结果或错误。"""
    t = time.time()
    try:
        data = fn()
        results[name] = {"ok": True, "sec": round(time.time() - t, 1), "data": data}
    except Exception as e:  # 记录失败原因，不中断其他测试
        results[name] = {"ok": False, "sec": round(time.time() - t, 1),
                         "error": f"{type(e).__name__}: {str(e)[:300]}"}
    print(name, "OK" if results[name]["ok"] else "FAIL", results[name]["sec"], "s", flush=True)


def ydl(opts=None):
    base = {"quiet": True, "no_warnings": True, "skip_download": True}
    base.update(opts or {})
    return yt_dlp.YoutubeDL(base)


KW = "medical tourism China"
state = {}


def t_search():
    """yt-dlp 关键词搜索（无需 API Key 的非官方方式）。"""
    with ydl({"extract_flat": True}) as y:
        info = y.extract_info(f"ytsearch15:{KW}", download=False)
    rows = [{"id": e.get("id"), "title": e.get("title"), "channel": e.get("channel"),
             "channel_id": e.get("channel_id"), "views": e.get("view_count"),
             "duration": e.get("duration")} for e in info["entries"]]
    state["videos"] = rows
    return {"count": len(rows), "with_views": sum(1 for r in rows if r["views"]), "sample": rows[:5]}


def t_video_detail():
    """单条视频完整元数据：播放、点赞、评论数、粉丝、发布日期。"""
    vid = state["videos"][0]["id"]
    with ydl() as y:
        i = y.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
    state["channel_url"] = i.get("channel_url")
    state["vid"] = vid
    keys = ["title", "view_count", "like_count", "comment_count", "channel", "channel_follower_count",
            "upload_date", "duration", "channel_url"]
    d = {k: i.get(k) for k in keys}
    d["has_subtitles"] = sorted(i.get("subtitles", {}).keys())[:10]
    d["has_auto_captions_en"] = "en" in (i.get("automatic_captions") or {})
    return d


def t_channel_baseline():
    """频道近 15 条视频播放量 → 计算基线中位数与异常倍数。"""
    with ydl({"extract_flat": True, "playlistend": 15}) as y:
        i = y.extract_info(state["channel_url"] + "/videos", download=False)
    views = [e.get("view_count") for e in i["entries"] if e.get("view_count")]
    med = statistics.median(views) if views else None
    top = state["videos"][0]["views"]
    return {"n": len(i["entries"]), "with_views": len(views), "median": med,
            "target_views": top, "outlier_x": round(top / med, 2) if (med and top) else None}


def t_transcript():
    """YouTube 字幕获取。"""
    api = YouTubeTranscriptApi()
    for v in [state["vid"]] + [r["id"] for r in state["videos"][1:4]]:
        try:
            tr = api.fetch(v, languages=["en", "zh-Hans", "zh"])
            text = " ".join(s.text for s in tr)
            return {"video": v, "segments": len(tr), "chars": len(text), "head": text[:200]}
        except Exception as e:
            last = f"{type(e).__name__}: {str(e)[:150]}"
    raise RuntimeError("前 4 条均失败：" + last)


def t_bilibili():
    """B 站元数据（公开知名视频）。"""
    with ydl() as y:
        i = y.extract_info("https://www.bilibili.com/video/BV1GJ411x7h7", download=False)
    return {k: i.get(k) for k in ["title", "uploader", "view_count", "like_count", "upload_date", "duration"]}


def t_article():
    """网页正文提取。"""
    html = trafilatura.fetch_url("https://en.wikipedia.org/wiki/Medical_tourism")
    text = trafilatura.extract(html) or ""
    return {"chars": len(text), "head": text[:200]}


def t_revenue_links():
    """收益工具直达链接是否可打开（只记录状态码，遇到验证页即记为需浏览器打开）。"""
    h = {"User-Agent": "Mozilla/5.0"}
    urls = {
        "socialblade": "https://socialblade.com/youtube/handle/mkbhd",
        "viewstats": "https://www.viewstats.com/@mkbhd",
        "similarweb": "https://www.similarweb.com/website/shopify.com/",
        "twitchtracker": "https://twitchtracker.com/xqc",
        "graphtreon": "https://graphtreon.com/creator/kurzgesagt",
        "meta_ad_library": "https://www.facebook.com/ads/library/?q=medical%20tourism",
        "tiktok_cc": "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en",
        "fastmoss": "https://www.fastmoss.com/",
        "kalodata": "https://www.kalodata.com/",
        "chanmama": "https://www.chanmama.com/",
    }
    out = {}
    for k, u in urls.items():
        try:
            r = requests.get(u, headers=h, timeout=15, allow_redirects=True)
            out[k] = {"status": r.status_code, "final": r.url[:100]}
        except Exception as e:
            out[k] = {"error": type(e).__name__}
        time.sleep(1)
    return out


for name, fn in [("youtube_search", t_search), ("video_detail", t_video_detail),
                 ("channel_baseline", t_channel_baseline), ("transcript", t_transcript),
                 ("bilibili", t_bilibili), ("article", t_article), ("revenue_links", t_revenue_links)]:
    if name in ("video_detail", "channel_baseline", "transcript") and not results.get("youtube_search", {}).get("ok"):
        results[name] = {"ok": False, "error": "依赖的搜索失败，跳过"}
        continue
    record(name, fn)

OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print("written", OUT)
