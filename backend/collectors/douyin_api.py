"""阶段 B 适配器：无缝对接开源项目 Evil0ctal/Douyin_TikTok_Download_API（抖音/TikTok 无水印视频与元数据解析）。"""
import os
import requests

from backend.extractors.bio_scanner import scan_monetization_signals


def get_douyin_api_base() -> str:
    return os.getenv("DOUYIN_API_BASE", "").strip().rstrip("/")


def check_douyin_api_health(base_url: str | None = None) -> dict:
    base = (base_url or get_douyin_api_base()).rstrip("/")
    if not base:
        return {"ok": False, "base": "", "message": "未配置 DOUYIN_API_BASE（本地默认 http://127.0.0.1:8080）"}
    try:
        r = requests.get(f"{base}/docs", timeout=5)
        return {"ok": r.status_code < 400, "base": base, "message": "服务在线" if r.status_code < 400 else f"HTTP {r.status_code}"}
    except Exception as e:
        return {"ok": False, "base": base, "message": f"未连接：{str(e)[:80]}"}


def parse_via_douyin_api(url: str) -> dict | None:
    """
    调用本地/自建 Douyin_TikTok_Download_API 的 /api/hybrid/video_data 接口解析单条视频。
    未配置或离线时返回 None，平滑回退到默认逻辑。
    """
    base = get_douyin_api_base()
    if not base:
        return None
    try:
        r = requests.get(f"{base}/api/hybrid/video_data", params={"url": url, "minimal": "false"}, timeout=20)
        if r.status_code != 200:
            return None
        payload = r.json()
        data = payload.get("data") or payload
        if not isinstance(data, dict):
            return None

        plat = (data.get("platform") or "").lower()
        if plat not in ("douyin", "tiktok", "bilibili"):
            plat = "tiktok" if "tiktok.com" in url.lower() else ("douyin" if "douyin" in url.lower() else "web")

        author = data.get("author") or {}
        stats = data.get("statistics") or {}
        desc = data.get("desc") or data.get("title") or ""
        aweme_id = str(data.get("aweme_id") or data.get("id") or "")
        cover = ""
        cov_obj = data.get("cover_data") or data.get("video", {}).get("cover") or {}
        if isinstance(cov_obj, dict):
            urls = cov_obj.get("url_list") or cov_obj.get("origin_cover", {}).get("url_list") or []
            cover = urls[0] if urls else ""

        uid = str(author.get("sec_uid") or author.get("unique_id") or author.get("uid") or "")
        handle = str(author.get("unique_id") or author.get("short_id") or uid)
        profile_url = (
            f"https://www.tiktok.com/@{handle}"
            if plat == "tiktok" and handle
            else (f"https://www.douyin.com/user/{uid}" if plat == "douyin" and uid else "")
        )

        return {
            "platform": plat,
            "platform_item_id": aweme_id,
            "title": desc[:180] or url,
            "url": url,
            "thumbnail_url": cover,
            "published_at": str(data.get("create_time") or ""),
            "duration_sec": int(data["duration"] / 1000) if isinstance(data.get("duration"), (int, float)) and data["duration"] > 1000 else data.get("duration"),
            "content_type": "short_video",
            "view_count": stats.get("play_count"),
            "like_count": stats.get("digg_count"),
            "comment_count": stats.get("comment_count"),
            "creator_name": author.get("nickname") or handle or "",
            "platform_creator_id": uid or handle,
            "handle": handle,
            "profile_url": profile_url,
            "follower_count": author.get("follower_count"),
            "detected_monetization": scan_monetization_signals(desc),
            "meta_warning": "",
        }
    except Exception:
        return None
