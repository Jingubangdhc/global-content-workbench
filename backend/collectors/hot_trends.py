"""全网实时热榜聚合器（参考 DailyHotApi / TrendRadar 思路，纯 Python 零 Key 直连，内置 5 分钟缓存与故障隔离）。"""
import concurrent.futures
import time
import xml.etree.ElementTree as ET
from typing import Callable

import requests

from backend.config import BROWSER_UA

_CACHE: dict[str, tuple[float, dict]] = {}
CACHE_TTL = 300  # 5 分钟缓存，防止高频请求触发风控

HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def _fetch_bilibili() -> list[dict]:
    r = requests.get("https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all", headers=HEADERS, timeout=12)
    r.raise_for_status()
    items = []
    for i, x in enumerate((r.json().get("data") or {}).get("list") or [], 1):
        items.append({
            "rank": i,
            "title": x.get("title", ""),
            "url": f"https://www.bilibili.com/video/{x.get('bvid', '')}",
            "hot": f"{round((x.get('stat', {}).get('view', 0)) / 10000, 1)}万播放",
            "extra": x.get("owner", {}).get("name", ""),
        })
    return items[:25]


def _fetch_v2ex() -> list[dict]:
    r = requests.get("https://www.v2ex.com/api/topics/hot.json", headers=HEADERS, timeout=12)
    r.raise_for_status()
    return [
        {
            "rank": i,
            "title": x.get("title", ""),
            "url": x.get("url", "https://www.v2ex.com/"),
            "hot": f"{x.get('replies', 0)} 回复",
            "extra": (x.get("node") or {}).get("title", ""),
        }
        for i, x in enumerate(r.json()[:25], 1)
    ]


def _fetch_github_trending() -> list[dict]:
    # GitHub 搜索 API 无需 Key 即可查近 7 天新晋高星仓库（比抓 HTML 更稳）
    import datetime
    since = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
    r = requests.get(
        f"https://api.github.com/search/repositories?q=created:>{since}&sort=stars&order=desc&per_page=25",
        headers={**HEADERS, "Accept": "application/vnd.github+json"},
        timeout=12,
    )
    r.raise_for_status()
    return [
        {
            "rank": i,
            "title": f"{x.get('full_name', '')} — {(x.get('description') or '')[:60]}",
            "url": x.get("html_url", "https://github.com/trending"),
            "hot": f"★ {x.get('stargazers_count', 0)}",
            "extra": x.get("language") or "AI/OpenSource",
        }
        for i, x in enumerate((r.json().get("items") or [])[:25], 1)
    ]


def _fetch_zhihu() -> list[dict]:
    r = requests.get("https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=25", headers=HEADERS, timeout=12)
    r.raise_for_status()
    items = []
    for i, x in enumerate(r.json().get("data") or [], 1):
        t = x.get("target") or {}
        qid = t.get("id", "")
        items.append({
            "rank": i,
            "title": t.get("title", ""),
            "url": f"https://www.zhihu.com/question/{qid}" if qid else "https://www.zhihu.com/hot",
            "hot": x.get("detail_text", ""),
            "extra": "",
        })
    return items[:25]


def _fetch_weibo() -> list[dict]:
    r = requests.get(
        "https://m.weibo.cn/api/container/getIndex?containerid=106003type%3D25%26t%3D3%26disable_hot%3D1%26filter_type%3Drealtimehot",
        headers={**HEADERS, "Referer": "https://m.weibo.cn/"},
        timeout=12,
    )
    r.raise_for_status()
    cards = (r.json().get("data") or {}).get("cards") or []
    group = (cards[0].get("card_group") or []) if cards else []
    items = []
    for x in group:
        word = (x.get("desc") or "").strip()
        if not word:
            continue
        items.append({
            "rank": len(items) + 1,
            "title": word,
            "url": f"https://s.weibo.com/weibo?q=%23{requests.utils.quote(word)}%23",
            "hot": str(x.get("desc_extr") or ""),
            "extra": x.get("icon_desc") or "",
        })
    return items[:25]


def _fetch_toutiao() -> list[dict]:
    r = requests.get("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc", headers=HEADERS, timeout=12)
    r.raise_for_status()
    items = []
    for i, x in enumerate(r.json().get("data") or [], 1):
        items.append({
            "rank": i,
            "title": x.get("Title", ""),
            "url": x.get("Url", "https://www.toutiao.com/"),
            "hot": f"{round(int(x.get('HotValue', 0)) / 10000, 1)}万" if x.get("HotValue") else "",
            "extra": x.get("LabelDesc", ""),
        })
    return items[:25]


def _fetch_baidu() -> list[dict]:
    r = requests.get("https://top.baidu.com/api/board?platform=wise&tab=realtime", headers=HEADERS, timeout=12)
    r.raise_for_status()
    cards = (r.json().get("data") or {}).get("cards") or []
    content = (cards[0].get("content") or []) if cards else []
    # 兼容嵌套 content[0]['content']
    if content and isinstance(content[0], dict) and "content" in content[0]:
        content = content[0]["content"]
    items = []
    for i, x in enumerate(content, 1):
        word = x.get("word") or x.get("query") or ""
        if not word:
            continue
        items.append({
            "rank": i,
            "title": word,
            "url": x.get("url") or f"https://www.baidu.com/s?wd={requests.utils.quote(word)}",
            "hot": f"{round(int(x.get('hotScore', 0)) / 10000, 1)}万" if str(x.get("hotScore", "")).isdigit() else "",
            "extra": x.get("hotTag", ""),
        })
    return items[:25]


def _fetch_douyin() -> list[dict]:
    r = requests.get(
        "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/",
        headers={**HEADERS, "Referer": "https://www.douyin.com/"},
        timeout=12,
    )
    r.raise_for_status()
    items = []
    for i, x in enumerate(r.json().get("word_list") or [], 1):
        w = x.get("word", "")
        if not w:
            continue
        items.append({
            "rank": i,
            "title": w,
            "url": f"https://www.douyin.com/search/{requests.utils.quote(w)}",
            "hot": f"{round((x.get('hot_value') or 0) / 10000, 1)}万" if x.get("hot_value") else "",
            "extra": "",
        })
    return items[:25]


def _fetch_hackernews() -> list[dict]:
    r = requests.get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=25", headers=HEADERS, timeout=12)
    r.raise_for_status()
    items = []
    for i, x in enumerate(r.json().get("hits") or [], 1):
        oid = x.get("objectID", "")
        items.append({
            "rank": i,
            "title": x.get("title", ""),
            "url": x.get("url") or f"https://news.ycombinator.com/item?id={oid}",
            "hot": f"{x.get('points', 0)} pts · {x.get('num_comments', 0)} 评",
            "extra": "海外科技/AI",
        })
    return items[:25]


def _fetch_reddit() -> list[dict]:
    # Reddit JSON 接口易 403，改用公开官方 Atom RSS Feed
    r = requests.get(
        "https://www.reddit.com/r/popular/.rss",
        headers={"User-Agent": "Mozilla/5.0 (compatible; RSSReader/1.0)"},
        timeout=12,
    )
    r.raise_for_status()
    ns = {"a": "http://www.w3.org/2005/Atom"}
    root = ET.fromstring(r.text)
    items = []
    for i, ent in enumerate(root.findall("a:entry", ns)[:25], 1):
        title = (ent.findtext("a:title", default="", namespaces=ns) or "").strip()
        link_el = ent.find("a:link", ns)
        url = link_el.get("href", "") if link_el is not None else ""
        cat_el = ent.find("a:category", ns)
        sub = cat_el.get("term", "") if cat_el is not None else ""
        items.append({
            "rank": i,
            "title": title,
            "url": url,
            "hot": "Popular",
            "extra": f"r/{sub}" if sub else "",
        })
    return items


SOURCES: list[tuple[str, str, str, Callable[[], list[dict]]]] = [
    ("bilibili", "B站全站热榜", "国内", _fetch_bilibili),
    ("douyin", "抖音热搜榜", "国内", _fetch_douyin),
    ("toutiao", "今日头条热榜", "国内", _fetch_toutiao),
    ("baidu", "百度热搜", "国内", _fetch_baidu),
    ("v2ex", "V2EX 热议", "国内", _fetch_v2ex),
    ("github", "GitHub 7日新星榜", "海外", _fetch_github_trending),
    ("hackernews", "Hacker News", "海外", _fetch_hackernews),
    ("weibo", "微博热搜", "国内", _fetch_weibo),
]


def _run_source(key: str, name: str, region: str, fn: Callable, force: bool) -> dict:
    now = time.time()
    if not force and key in _CACHE and now - _CACHE[key][0] < CACHE_TTL:
        return _CACHE[key][1]
    try:
        items = fn()
        res = {"key": key, "name": name, "region": region, "ok": True, "count": len(items), "items": items, "error": "", "updated_at": int(now)}
    except Exception as e:
        res = {"key": key, "name": name, "region": region, "ok": False, "count": 0, "items": [], "error": str(e)[:120], "updated_at": int(now)}
    _CACHE[key] = (now, res)
    return res


def fetch_all_hot_trends(force: bool = False) -> list[dict]:
    """并发拉取全部 8 大海内外热榜，单源失败不影响其他平台。"""
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(_run_source, k, n, reg, fn, force) for k, n, reg, fn in SOURCES]
        return [f.result() for f in futs]
