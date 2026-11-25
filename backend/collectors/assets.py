"""优化②：合规真实素材搜索（Real Asset Finder）— Wikimedia Commons (免Key) + Pexels + Pixabay。"""
import os
import re
import requests

from backend.config import BROWSER_UA

HEADERS = {"User-Agent": "GlobalContentWorkbench/1.0 (https://github.com/Jingubangdhc/global-content-workbench)"}


def _clean_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()


def search_wikimedia(query: str, limit: int = 8) -> list[dict]:
    """完全免 API Key 调用 Wikimedia Commons 官方 API，返回缩略图、作者、许可证与出处页。"""
    params = {
        "action": "query",
        "generator": "search",
        "gsrsearch": query,
        "gsrnamespace": 6,  # File: 命名空间
        "gsrlimit": limit,
        "prop": "imageinfo",
        "iiprop": "url|extmetadata|mime|size",
        "iiurlwidth": 480,
        "format": "json",
    }
    r = requests.get("https://commons.wikimedia.org/w/api.php", params=params, headers=HEADERS, timeout=15)
    r.raise_for_status()
    pages = (r.json().get("query") or {}).get("pages") or {}
    out = []
    for _, p in pages.items():
        ii = (p.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata") or {}
        lic = _clean_html((meta.get("LicenseShortName") or {}).get("value", "CC/Public"))
        author = _clean_html((meta.get("Artist") or {}).get("value", "Wikimedia Contributor"))[:80]
        mime = ii.get("mime") or ""
        if not mime.startswith(("image/", "video/")):
            continue
        commercial_ok = "可商用(需按协议署名)" if any(k in lic.upper() for k in ("CC0", "PD", "PUBLIC", "CC-BY", "CC BY")) and "NC" not in lic.upper() else "请核对非商用限制"
        out.append({
            "source": "Wikimedia Commons",
            "asset_type": "video" if mime.startswith("video/") else "image",
            "title": (p.get("title") or "").replace("File:", ""),
            "thumb_url": ii.get("thumburl") or ii.get("url") or "",
            "asset_url": ii.get("url") or "",
            "source_page_url": ii.get("descriptionurl") or "",
            "author": author,
            "license": lic,
            "commercial_ok": commercial_ok,
        })
    return out


def search_pexels(query: str, asset_type: str = "video", limit: int = 6) -> list[dict]:
    """调用 Pexels 官方免费 API（需在设置页填入 PEXELS_API_KEY）。"""
    key = os.getenv("PEXELS_API_KEY", "").strip()
    if not key:
        return []
    h = {"Authorization": key, "User-Agent": BROWSER_UA}
    if asset_type == "video":
        r = requests.get("https://api.pexels.com/videos/search", params={"query": query, "per_page": limit}, headers=h, timeout=15)
        r.raise_for_status()
        out = []
        for v in r.json().get("videos") or []:
            files = v.get("video_files") or []
            best = sorted(files, key=lambda x: x.get("width") or 0, reverse=True)[0] if files else {}
            out.append({
                "source": "Pexels Video",
                "asset_type": "video",
                "title": f"Pexels Video #{v.get('id')} ({v.get('duration')}s)",
                "thumb_url": v.get("image") or "",
                "asset_url": best.get("link") or v.get("url") or "",
                "source_page_url": v.get("url") or "",
                "author": (v.get("user") or {}).get("name", "Pexels"),
                "license": "Pexels License",
                "commercial_ok": "免费可商用(禁冒充特定事实)",
            })
        return out
    r = requests.get("https://api.pexels.com/v1/search", params={"query": query, "per_page": limit}, headers=h, timeout=15)
    r.raise_for_status()
    return [
        {
            "source": "Pexels Photo",
            "asset_type": "image",
            "title": p.get("alt") or f"Pexels Photo #{p.get('id')}",
            "thumb_url": (p.get("src") or {}).get("medium") or "",
            "asset_url": (p.get("src") or {}).get("large2x") or (p.get("src") or {}).get("original") or "",
            "source_page_url": p.get("url") or "",
            "author": p.get("photographer") or "Pexels",
            "license": "Pexels License",
            "commercial_ok": "免费可商用(禁冒充特定事实)",
        }
        for p in r.json().get("photos") or []
    ]


def search_pixabay(query: str, limit: int = 6) -> list[dict]:
    """调用 Pixabay 官方免费 API（需在设置页填入 PIXABAY_API_KEY）。"""
    key = os.getenv("PIXABAY_API_KEY", "").strip()
    if not key:
        return []
    r = requests.get(
        "https://pixabay.com/api/",
        params={"key": key, "q": query, "per_page": limit, "safesearch": "true"},
        timeout=15,
    )
    r.raise_for_status()
    return [
        {
            "source": "Pixabay",
            "asset_type": "image",
            "title": h.get("tags") or f"Pixabay #{h.get('id')}",
            "thumb_url": h.get("webformatURL") or "",
            "asset_url": h.get("largeImageURL") or h.get("webformatURL") or "",
            "source_page_url": h.get("pageURL") or "",
            "author": h.get("user") or "Pixabay",
            "license": "Pixabay Content License",
            "commercial_ok": "免费可商用",
        }
        for h in r.json().get("hits") or []
    ]


def search_real_assets(query: str, source: str = "all") -> dict:
    """聚合搜索合规免费真实素材，返回候选列表及各源配置状态。"""
    results = []
    errors = []
    if source in ("all", "wikimedia"):
        try:
            results.extend(search_wikimedia(query, limit=8))
        except Exception as e:
            errors.append(f"Wikimedia: {str(e)[:80]}")
    if source in ("all", "pexels"):
        try:
            results.extend(search_pexels(query, "video", limit=6))
            results.extend(search_pexels(query, "image", limit=4))
        except Exception as e:
            errors.append(f"Pexels: {str(e)[:80]}")
    if source in ("all", "pixabay"):
        try:
            results.extend(search_pixabay(query, limit=6))
        except Exception as e:
            errors.append(f"Pixabay: {str(e)[:80]}")

    return {
        "query": query,
        "count": len(results),
        "items": results,
        "errors": errors,
        "pexels_configured": bool(os.getenv("PEXELS_API_KEY", "").strip()),
        "pixabay_configured": bool(os.getenv("PIXABAY_API_KEY", "").strip()),
    }
