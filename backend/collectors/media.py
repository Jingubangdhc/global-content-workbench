"""多平台搜索、异常爆款倍数计算、10大必看平台跳板与万能链接解析。"""
import concurrent.futures
import hashlib
import os
import re
import statistics
from urllib.parse import quote_plus, urlparse

import requests
import yt_dlp

from backend.collectors.douyin_api import parse_via_douyin_api
from backend.config import BROWSER_UA
from backend.extractors.bio_scanner import scan_monetization_signals

URL_EXTRACT_RE = re.compile(r"https?://[^\s<>\"'\]\)]+", re.IGNORECASE)


def _ydl_opts(extra: dict | None = None, cookie_browser: str = "none") -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 20,
    }
    if cookie_browser and cookie_browser in ("chrome", "edge", "firefox"):
        opts["cookiesfrombrowser"] = (cookie_browser,)
    if extra:
        opts.update(extra)
    return opts


def detect_platform(url: str) -> tuple[str, str]:
    """根据 URL 识别平台与原生作品 ID（用于强去重）。"""
    u = url.strip()
    p = urlparse(u)
    host = p.netloc.lower().lstrip("www.")
    path = p.path.strip("/")

    if "youtube.com" in host or "youtu.be" in host:
        if "youtu.be" in host:
            vid = path.split("/")[0]
        elif "shorts/" in path:
            vid = path.split("shorts/")[1].split("/")[0]
        else:
            m = re.search(r"v=([A-Za-z0-9_-]{6,})", p.query)
            vid = m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12]
        return "youtube", vid
    if "bilibili.com" in host or "b23.tv" in host:
        m = re.search(r"(BV[A-Za-z0-9]+|av\d+)", u, re.IGNORECASE)
        return "bilibili", (m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12])
    if "tiktok.com" in host:
        m = re.search(r"video/(\d+)", u)
        return "tiktok", (m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12])
    if "douyin.com" in host or "iesdouyin.com" in host:
        m = re.search(r"video/(\d+)", u)
        return "douyin", (m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12])
    if "xiaohongshu.com" in host or "xhslink.com" in host:
        m = re.search(r"(?:explore|item)/([a-zA-Z0-9]+)", u)
        return "xiaohongshu", (m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12])
    if "instagram.com" in host:
        m = re.search(r"(?:reel|p)/([A-Za-z0-9_-]+)", u)
        return "instagram", (m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12])
    if "x.com" in host or "twitter.com" in host:
        m = re.search(r"status/(\d+)", u)
        return "x", (m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12])
    if "reddit.com" in host:
        m = re.search(r"comments/([a-z0-9]+)", u)
        return "reddit", (m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12])
    if "zhihu.com" in host:
        m = re.search(r"(?:question|p|answer)/(\d+)", u)
        return "zhihu", (m.group(1) if m else hashlib.md5(u.encode()).hexdigest()[:12])
    if "weibo.com" in host or "weibo.cn" in host:
        return "weibo", hashlib.md5(u.encode()).hexdigest()[:12]
    return "web", hashlib.md5(u.encode()).hexdigest()[:12]


def get_jump_links(keyword: str) -> dict:
    """
    返回带关键词编码的全网一键搜索链接。
    第一梯队严格置顶用户指定的 10 大必看平台：
    YouTube, TikTok, 抖音, 小红书, B站, Reddit, X, Instagram, 知乎, 新浪微博。
    """
    q = quote_plus(keyword.strip())
    pinned_10 = [
        {"platform": "YouTube", "badge": "海外视频", "url": f"https://www.youtube.com/results?search_query={q}"},
        {"platform": "TikTok", "badge": "海外短剧/带货", "url": f"https://www.tiktok.com/search?q={q}"},
        {"platform": "抖音", "badge": "国内短视频", "url": f"https://www.douyin.com/search/{q}"},
        {"platform": "小红书", "badge": "种草/痛点", "url": f"https://www.xiaohongshu.com/search_result?keyword={q}"},
        {"platform": "B站", "badge": "深度中长视频", "url": f"https://search.bilibili.com/all?keyword={q}"},
        {"platform": "Reddit", "badge": "海外真实讨论", "url": f"https://www.reddit.com/search/?q={q}&sort=relevance"},
        {"platform": "X", "badge": "全球一手观点", "url": f"https://x.com/search?q={q}&src=typed_query&f=top"},
        {"platform": "Instagram", "badge": "Reels/视觉", "url": f"https://www.google.com/search?q=site%3Ainstagram.com+{q}"},
        {"platform": "知乎", "badge": "国内深度问答", "url": f"https://www.zhihu.com/search?type=content&q={q}"},
        {"platform": "新浪微博", "badge": "实时热点舆情", "url": f"https://s.weibo.com/weibo?q={q}"},
    ]
    trends_and_web = [
        {"platform": "Google 搜索", "badge": "联想词/PAA", "url": f"https://www.google.com/search?q={q}"},
        {"platform": "Google Trends", "badge": "相对趋势", "url": f"https://trends.google.com/trends/explore?q={q}"},
        {"platform": "Google News", "badge": "新闻事实", "url": f"https://news.google.com/search?q={q}"},
        {"platform": "TikTok Creative Center", "badge": "海外热词/广告", "url": "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en"},
        {"platform": "抖音热点宝", "badge": "低粉爆款", "url": "https://hot.douyin.com/"},
        {"platform": "Quora", "badge": "海外长问答", "url": f"https://www.quora.com/search?q={q}"},
        {"platform": "搜狗微信", "badge": "公众号爆文", "url": f"https://weixin.sogou.com/weixin?type=2&query={q}"},
        {"platform": "Medium", "badge": "英文长文", "url": f"https://medium.com/search?q={q}"},
        {"platform": "Substack", "badge": "付费专栏", "url": f"https://substack.com/search/{q}"},
    ]
    return {"keyword": keyword, "pinned_10": pinned_10, "trends_and_web": trends_and_web}


YT_SORT_SP = {
    "views": "CAM%253D",          # 按观看次数最高
    "latest": "CAI%253D",         # 按上传时间最新
    "month_views": "CAMSBAgEEAE%253D",  # 本月 + 视频 + 按观看次数
    "week_views": "CAMSBAgDEAE%253D",   # 本周 + 视频 + 按观看次数
}


def search_youtube(keyword: str, limit: int = 20, sort_by: str = "relevance") -> list[dict]:
    """免 API Key 使用 yt-dlp 搜索 YouTube 爆款视频，支持综合相关/播放量最高/本月爆款/本周爆款/最新。"""
    sp = YT_SORT_SP.get(sort_by)
    target = (
        f"https://www.youtube.com/results?search_query={quote_plus(keyword)}&sp={sp}"
        if sp
        else f"ytsearch{limit}:{keyword}"
    )
    entries = []
    try:
        with yt_dlp.YoutubeDL(_ydl_opts({"extract_flat": True, "playlistend": limit})) as y:
            info = y.extract_info(target, download=False)
        entries = (info or {}).get("entries") or []
    except Exception:
        entries = []

    # 若带 sp 参数的搜索页受限，平滑降级到 ytsearch 并本地按播放量排序
    if not entries and sp:
        with yt_dlp.YoutubeDL(_ydl_opts({"extract_flat": True})) as y:
            info = y.extract_info(f"ytsearch{limit}:{keyword}", download=False)
        entries = (info or {}).get("entries") or []

    items = []
    for e in entries:
        vid = e.get("id")
        if not vid or len(str(vid)) != 11:
            continue
        dur = e.get("duration")
        ctype = "short_video" if (dur is not None and dur <= 65) else "long_video"
        thumbs = e.get("thumbnails") or []
        thumb = thumbs[-1].get("url") if thumbs else f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        ch_id = e.get("channel_id") or ""
        ch_url = e.get("channel_url") or (f"https://www.youtube.com/channel/{ch_id}" if ch_id else "")
        items.append({
            "platform": "youtube",
            "platform_item_id": vid,
            "title": e.get("title") or "",
            "url": f"https://www.youtube.com/watch?v={vid}",
            "thumbnail_url": thumb,
            "creator_name": e.get("channel") or e.get("uploader") or "",
            "channel_id": ch_id,
            "channel_url": ch_url,
            "view_count": e.get("view_count"),
            "duration_sec": int(dur) if dur is not None else None,
            "content_type": ctype,
        })
    if sort_by in ("views", "month_views", "week_views"):
        items.sort(key=lambda x: x.get("view_count") or 0, reverse=True)
    return items[:limit]


def fetch_creator_profile_and_videos(profile_url: str, limit: int = 15, cookie_browser: str = "none") -> dict:
    """
    爆款博主追踪核心：根据博主主页链接抓取博主资料 + 近期 N 条作品，
    自动计算该频道播放中位数与每条视频的异常爆款倍数。
    """
    u = profile_url.strip()
    platform, _ = detect_platform(u)
    if "youtube.com" in u.lower() or "youtu.be" in u.lower():
        platform = "youtube"

    p = urlparse(u)
    clean_path = p.path.strip("/")
    fallback_id = clean_path.split("/")[-1] if clean_path else hashlib.md5(u.encode()).hexdigest()[:10]
    fallback_handle = fallback_id.lstrip("@")

    result = {
        "platform": platform,
        "platform_creator_id": fallback_id,
        "name": fallback_handle or u,
        "handle": fallback_handle,
        "profile_url": u,
        "follower_count": None,
        "baseline_median_views": None,
        "bio_text": "",
        "detected_monetization": scan_monetization_signals(""),
        "videos": [],
        "warning": "",
    }

    target_url = u
    if platform == "youtube" and not any(u.rstrip("/").endswith(s) for s in ("/videos", "/shorts", "/streams")):
        target_url = u.rstrip("/") + "/videos"

    try:
        with yt_dlp.YoutubeDL(_ydl_opts({"extract_flat": True, "playlistend": limit}, cookie_browser=cookie_browser)) as y:
            info = y.extract_info(target_url, download=False)
        if not info:
            raise RuntimeError("未返回频道数据")

        ch_id = info.get("channel_id") or info.get("uploader_id") or fallback_id
        ch_name = info.get("channel") or info.get("uploader") or info.get("title") or fallback_handle
        # 去掉 YouTube 自动拼上的 " - Videos" 后缀
        ch_name = re.sub(r"\s*-\s*Videos$", "", str(ch_name), flags=re.IGNORECASE).strip()
        handle = str(info.get("uploader_id") or fallback_handle).lstrip("@")
        bio = info.get("description") or ""
        followers = info.get("channel_follower_count")

        raw_entries = info.get("entries") or []
        vids = []
        views_pool = []
        for e in raw_entries:
            if not e:
                continue
            vid = e.get("id")
            vurl = e.get("url") or (f"https://www.youtube.com/watch?v={vid}" if platform == "youtube" and vid else "")
            if not vurl:
                continue
            if not vurl.startswith("http") and platform == "youtube":
                vurl = f"https://www.youtube.com/watch?v={vurl}"
            vc = e.get("view_count")
            if vc is not None:
                views_pool.append(vc)
            dur = e.get("duration")
            thumbs = e.get("thumbnails") or []
            thumb = thumbs[-1].get("url") if thumbs else (f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if platform == "youtube" and vid else "")
            vids.append({
                "platform": platform,
                "platform_item_id": str(vid or hashlib.md5(vurl.encode()).hexdigest()[:12]),
                "title": e.get("title") or vurl,
                "url": vurl,
                "thumbnail_url": thumb,
                "published_at": e.get("upload_date") or "",
                "duration_sec": int(dur) if dur is not None else None,
                "content_type": "short_video" if (dur is not None and dur <= 65) else "long_video",
                "view_count": vc,
                "like_count": e.get("like_count"),
                "comment_count": e.get("comment_count"),
            })

        median_v = round(float(statistics.median(views_pool)), 1) if views_pool else None
        for v in vids:
            vc = v.get("view_count")
            v["outlier_score"] = round(vc / median_v, 2) if (vc is not None and median_v and median_v > 0) else None
            v["views_to_followers"] = round(vc / followers, 2) if (vc is not None and followers and followers > 0) else None

        result.update({
            "platform_creator_id": str(ch_id),
            "name": ch_name,
            "handle": handle,
            "profile_url": info.get("channel_url") or u,
            "follower_count": followers,
            "baseline_median_views": median_v,
            "bio_text": bio,
            "detected_monetization": scan_monetization_signals(bio),
            "videos": vids,
        })
    except Exception as e:
        result["warning"] = f"该平台主页受限未能自动拉取视频列表（已收录博主主页，可手动添加视频）：{str(e)[:150]}"
    return result


def calc_youtube_video_outlier(video_url: str) -> dict:
    """获取单条 YouTube 完整指标 + 拉取频道近 15 条同形态视频计算基线中位数与异常倍数。"""
    with yt_dlp.YoutubeDL(_ydl_opts()) as y:
        info = y.extract_info(video_url, download=False)
    views = info.get("view_count")
    followers = info.get("channel_follower_count")
    dur = info.get("duration")
    is_short = dur is not None and dur <= 65
    ch_url = info.get("channel_url") or ""
    desc = info.get("description") or ""
    monetization = scan_monetization_signals(desc)

    median_views = None
    outlier = None
    sample_n = 0
    if ch_url:
        tab = "/shorts" if is_short else "/videos"
        try:
            with yt_dlp.YoutubeDL(_ydl_opts({"extract_flat": True, "playlistend": 16})) as y:
                ch_info = y.extract_info(ch_url.rstrip("/") + tab, download=False)
            ch_views = [
                e.get("view_count")
                for e in (ch_info or {}).get("entries") or []
                if e.get("view_count") is not None and e.get("id") != info.get("id")
            ]
            sample_n = len(ch_views)
            if ch_views:
                median_views = round(float(statistics.median(ch_views)), 1)
                if views is not None and median_views > 0:
                    outlier = round(views / median_views, 2)
        except Exception:
            pass

    vtf = round(views / followers, 2) if (views is not None and followers and followers > 0) else None
    handle = (info.get("uploader_id") or "").lstrip("@")
    return {
        "platform": "youtube",
        "platform_item_id": info.get("id"),
        "title": info.get("title") or "",
        "url": info.get("webpage_url") or video_url,
        "thumbnail_url": info.get("thumbnail") or "",
        "published_at": info.get("upload_date") or "",
        "duration_sec": int(dur) if dur is not None else None,
        "content_type": "short_video" if is_short else "long_video",
        "view_count": views,
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "creator_name": info.get("channel") or info.get("uploader") or "",
        "platform_creator_id": info.get("channel_id") or handle or "",
        "handle": handle,
        "profile_url": ch_url,
        "follower_count": followers,
        "baseline_median_views": median_views,
        "baseline_sample_n": sample_n,
        "views_to_followers": vtf,
        "outlier_score": outlier,
        "description": desc,
        "detected_monetization": monetization,
    }


def search_bilibili(keyword: str, limit: int = 8) -> list[dict]:
    """搜索 B 站并并发补全单条视频元数据（Phase 0 实测可用）。"""
    with yt_dlp.YoutubeDL(_ydl_opts({"extract_flat": True})) as y:
        s = y.extract_info(f"bilisearch{limit}:{keyword}", download=False)
    urls = [e.get("url") for e in (s or {}).get("entries") or [] if e.get("url")]

    def _fetch(u: str) -> dict | None:
        try:
            with yt_dlp.YoutubeDL(_ydl_opts()) as y:
                i = y.extract_info(u, download=False)
            _, vid = detect_platform(i.get("webpage_url") or u)
            return {
                "platform": "bilibili",
                "platform_item_id": vid,
                "title": i.get("title") or "",
                "url": i.get("webpage_url") or u,
                "thumbnail_url": i.get("thumbnail") or "",
                "creator_name": i.get("uploader") or "",
                "channel_id": str(i.get("uploader_id") or ""),
                "channel_url": i.get("uploader_url") or "",
                "view_count": i.get("view_count"),
                "like_count": i.get("like_count"),
                "comment_count": i.get("comment_count"),
                "published_at": i.get("upload_date") or "",
                "duration_sec": int(i["duration"]) if i.get("duration") is not None else None,
                "content_type": "long_video",
            }
        except Exception:
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        res = [r for r in ex.map(_fetch, urls) if r]
    return res


def search_web_articles(keyword: str) -> dict:
    """若配置了 TAVILY_API_KEY 则直拉网页文章列表，否则返回提示与跳转链接。"""
    key = os.getenv("TAVILY_API_KEY", "").strip()
    if not key:
        return {"configured": False, "results": [], "message": "未配置 TAVILY_API_KEY，可在设置页免费申请填入，或直接使用下方搜索引擎一键跳转。"}
    try:
        r = requests.post(
            "https://api.tavily.com/search",
            json={"api_key": key, "query": keyword, "max_results": 12, "search_depth": "basic"},
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()
        items = [
            {
                "title": x.get("title", ""),
                "url": x.get("url", ""),
                "snippet": x.get("content", "")[:260],
                "domain": urlparse(x.get("url", "")).netloc.lstrip("www."),
            }
            for x in data.get("results", [])
        ]
        return {"configured": True, "results": items, "message": ""}
    except Exception as e:
        return {"configured": True, "results": [], "message": f"Tavily 搜索请求失败：{str(e)[:180]}"}


def extract_urls_from_text(raw_text: str) -> list[str]:
    """从粘贴文本或抖音/小红书口令中提取所有去重 URL。"""
    urls = URL_EXTRACT_RE.findall(raw_text or "")
    return list(dict.fromkeys(u.rstrip(".,;!?，。；！？") for u in urls))


def fetch_link_metadata(url: str, fallback_title: str = "", cookie_browser: str = "none") -> dict:
    """
    解析任意链接元数据（不下载视频，抓不到则平滑保留 URL 与已有标题，绝不填 0）。
    """
    platform, item_id = detect_platform(url)
    base = {
        "platform": platform,
        "platform_item_id": item_id,
        "url": url,
        "title": fallback_title or url,
        "thumbnail_url": "",
        "published_at": "",
        "duration_sec": None,
        "content_type": "article" if platform == "web" else "long_video",
        "view_count": None,
        "like_count": None,
        "comment_count": None,
        "creator_name": "",
        "platform_creator_id": "",
        "handle": "",
        "profile_url": "",
        "follower_count": None,
        "baseline_median_views": None,
        "views_to_followers": None,
        "outlier_score": None,
        "detected_monetization": scan_monetization_signals(""),
        "meta_warning": "",
    }

    if platform == "youtube":
        try:
            res = calc_youtube_video_outlier(url)
            base.update(res)
            return base
        except Exception as e:
            base["meta_warning"] = f"YouTube 详情解析失败：{str(e)[:120]}"
            return base

    if platform in ("bilibili", "tiktok", "douyin", "xiaohongshu", "instagram", "x"):
        # 阶段 B：若已配置本地 Douyin_TikTok_Download_API，优先走该服务解析抖音/TikTok 无水印与真实统计
        if platform in ("douyin", "tiktok"):
            api_meta = parse_via_douyin_api(url)
            if api_meta and api_meta.get("platform_item_id"):
                base.update(api_meta)
                return base
        try:
            with yt_dlp.YoutubeDL(_ydl_opts(cookie_browser=cookie_browser)) as y:
                i = y.extract_info(url, download=False)
            dur = i.get("duration")
            desc = i.get("description") or ""
            base.update({
                "title": i.get("title") or fallback_title or url,
                "url": i.get("webpage_url") or url,
                "thumbnail_url": i.get("thumbnail") or "",
                "published_at": i.get("upload_date") or "",
                "duration_sec": int(dur) if dur is not None else None,
                "content_type": "short_video" if (dur is not None and dur <= 65) else "long_video",
                "view_count": i.get("view_count"),
                "like_count": i.get("like_count"),
                "comment_count": i.get("comment_count"),
                "creator_name": i.get("uploader") or i.get("channel") or "",
                "platform_creator_id": str(i.get("uploader_id") or i.get("channel_id") or ""),
                "handle": str(i.get("uploader_id") or "").lstrip("@"),
                "profile_url": i.get("uploader_url") or i.get("channel_url") or "",
                "follower_count": i.get("channel_follower_count"),
                "detected_monetization": scan_monetization_signals(desc),
            })
            return base
        except Exception as e:
            base["meta_warning"] = f"平台受限未抓全元数据（已保留原链接，可手补）：{str(e)[:120]}"
            return base

    # 网页/社区文章：requests 抓标题
    try:
        r = requests.get(url, headers={"User-Agent": BROWSER_UA}, timeout=15)
        if r.status_code == 200:
            m = re.search(r"<title[^>]*>(.*?)</title>", r.text, re.IGNORECASE | re.DOTALL)
            if m and not fallback_title:
                base["title"] = re.sub(r"\s+", " ", m.group(1)).strip()[:160]
        else:
            base["meta_warning"] = f"目标网页返回 HTTP {r.status_code}（已保留链接）"
    except Exception as e:
        base["meta_warning"] = f"网页访问超时或受限：{str(e)[:100]}"
    return base
