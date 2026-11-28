"""GCW-ASSET-01 · 内置浏览器视频一键收录与选题资产管理服务。

核心设计原则：
1. 复用现有 contents / creators / topics / topic_evidence，绝不新建第二套素材库；
2. 缺失数据严格存 NULL（绝不填 0 或伪造数据）；
3. 互动率、播放粉丝比、异常爆款倍数严格分离计算：
   - engagement_rate = (like + comment + favorite + share) / view（需 view > 0 且至少一项互动非空）
   - views_to_followers = view / author_follower_count（两者均 > 0）
   - outlier_score = view / creator.baseline_median_views（仅当存在可靠历史基准时计算，否则 NULL）
4. 全局作品去重遵循 UNIQUE(platform, platform_item_id)，支持同一视频关联多个选题，取消收录仅解除当前选题关联；
5. 收录视频严格设置 manual_transcript_collected = 0（保存视频不等于自动加入文案工坊）。
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

from backend.collectors.media import detect_platform
from backend.db import get_conn
from backend.services.topic_hub_service import create_manual_topic

ALLOWED_PLATFORM_DOMAINS = (
    "douyin.com",
    "iesdouyin.com",
    "youtube.com",
    "youtu.be",
    "bilibili.com",
    "b23.tv",
    "xiaohongshu.com",
    "xhslink.com",
    "zhihu.com",
    "tiktok.com",
)


def is_safe_platform_url(raw_url: str) -> tuple[bool, str]:
    """FIX-F02: 仅允许 http/https 及预期平台域名白名单，严禁 bytedance:// 等非预期协议与第三方解析站。"""
    try:
        p = urlparse((raw_url or "").strip())
    except Exception:
        return False, "链接格式无法解析"
    if p.scheme not in ("http", "https"):
        return False, f"不允许的非安全协议：{p.scheme or '空'}"
    host = (p.hostname or "").lower()
    if not host:
        return False, "缺少有效域名"
    if not any(host == d or host.endswith("." + d) for d in ALLOWED_PLATFORM_DOMAINS):
        return False, f"域名「{host}」不在预期内容平台白名单内"
    return True, ""


def extract_share_links(raw_text: str) -> dict[str, Any]:
    """FIX-F02: 从完整抖音/平台分享文本中提取全部合法网址，忽略口令、日期、e@o.Du 等非网址字符。"""
    text = (raw_text or "").strip()
    if not text:
        return {"urls": [], "rejected_urls": [], "raw_text": ""}
    found = re.findall(r"""https?://[^\s<>"'，。！？、；：（）【】《》]+""", text, flags=re.IGNORECASE)
    urls: list[str] = []
    rejected: list[str] = []
    seen: set[str] = set()
    for u in found:
        cleaned = u.rstrip(".,;:!?)]}'\"，。！？、；：）】》")
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        ok, _ = is_safe_platform_url(cleaned)
        if ok:
            urls.append(cleaned)
        else:
            rejected.append(cleaned)
    return {"urls": urls, "rejected_urls": rejected, "raw_text": text}


def _extract_work_identity(final_url: str) -> tuple[str, str, bool]:
    """根据最终落地 URL 提取 (platform, platform_item_id, is_specific_work)；首页/登录页绝不误判为作品。"""
    p = urlparse(final_url)
    host = (p.hostname or "").lower()
    path = p.path or ""
    qs = parse_qs(p.query)

    # 明确拦截首页/登录页/验证页
    low_url = final_url.lower()
    if any(k in low_url for k in ("/passport", "/login", "verify", "captcha", "/jingxuan", "/discover")):
        if not re.search(r"/(?:video|note|share/video)/(\d{15,22})", path) and "modal_id" not in qs:
            return ("douyin" if "douyin" in host else "web"), "", False

    # 抖音作品页识别（/video/<id>, /note/<id>, /share/video/<id>, modal_id=<id>）
    if "douyin.com" in host or "iesdouyin.com" in host:
        m = re.search(r"/(?:video|note|share/video)/(\d{15,22})", path)
        if m:
            return "douyin", m.group(1), True
        if qs.get("modal_id") and re.fullmatch(r"\d{15,22}", qs["modal_id"][0]):
            return "douyin", qs["modal_id"][0], True
        return "douyin", "", False

    det_plat, det_id = detect_platform(final_url)
    if det_plat and det_id and det_plat != "web":
        return det_plat, det_id, True
    return det_plat or "web", "", False


def resolve_share_link_safely(raw_text_or_url: str, timeout: float = 8.0) -> dict[str, Any]:
    """FIX-F02: 安全提取并解析平台短链（逐跳校验协议与域名白名单，绝不调第三方解析站、绝不绕过登录）。"""
    extracted = extract_share_links(raw_text_or_url)
    urls = extracted["urls"]
    rejected = extracted["rejected_urls"]
    if len(urls) == 0:
        if rejected:
            return {
                "ok": False,
                "status": "blocked_domain_or_scheme",
                "error": f"检测到非预期域名或协议链接（已拦截）：{rejected[0]}",
                "rejected_urls": rejected,
            }
        return {"ok": False, "status": "no_url", "error": "未在输入文本中识别到有效平台链接"}
    if len(urls) > 1:
        return {
            "ok": True,
            "status": "multiple_links",
            "candidate_urls": urls,
            "rejected_urls": rejected,
            "message": f"识别到 {len(urls)} 个链接，请人工选择要打开/收录的目标链接。",
        }

    orig_url = urls[0]
    redirect_chain: list[str] = [orig_url]
    blocked_redirect = ""

    class _SafeRedirectHandler(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            nonlocal blocked_redirect
            if len(redirect_chain) >= 7:
                blocked_redirect = "重定向次数超过安全上限"
                return None
            ok_u, why = is_safe_platform_url(newurl)
            if not ok_u:
                blocked_redirect = f"重定向目标被安全拦截：{why} ({newurl[:80]})"
                return None
            redirect_chain.append(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    final_url = orig_url
    http_error = ""
    try:
        opener = build_opener(_SafeRedirectHandler())
        req = Request(
            orig_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
        )
        with opener.open(req, timeout=timeout) as resp:
            final_url = resp.geturl() or redirect_chain[-1]
    except Exception as e:
        final_url = redirect_chain[-1]
        http_error = str(e)

    if blocked_redirect:
        return {
            "ok": False,
            "status": "blocked_redirect",
            "original_share_url": orig_url,
            "redirect_chain": redirect_chain,
            "error": blocked_redirect,
        }

    plat, item_id, is_work = _extract_work_identity(final_url)
    # 抖音移动端分享落地页转为桌面网页标准作品链接（便于内置浏览器播放与去重）
    canonical_url = final_url
    if plat == "douyin" and is_work and item_id:
        canonical_url = f"https://www.douyin.com/video/{item_id}"

    if not is_work:
        return {
            "ok": False,
            "status": "needs_login_or_not_video",
            "original_share_url": orig_url,
            "final_url": final_url,
            "platform": plat,
            "platform_item_id": "",
            "redirect_chain": redirect_chain,
            "error": (
                f"链接跳转至「{final_url[:90]}」，未能确认具体作品（可能已失效、跳转到首页或需登录验证）。"
                "请点击在内置浏览器中打开核对，系统绝不误判为解析成功。"
                + (f"（网络提示：{http_error[:80]}）" if http_error else "")
            ),
        }

    return {
        "ok": True,
        "status": "resolved",
        "original_share_url": orig_url,
        "final_url": canonical_url,
        "raw_final_url": final_url,
        "platform": plat,
        "platform_item_id": item_id,
        "redirect_chain": redirect_chain,
        "message": f"已安全解析{plat}作品（ID: {item_id}）",
    }


def parse_human_count(val: Any) -> int | None:
    """将中英文计数字符串（如 '11万位订阅者'、'与另外 2,205 人一起顶'、'18.5万'、'1.2M'）安全解析为整数；无法解析返回 None。"""
    if val is None or val == "":
        return None
    if isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return int(round(val)) if val >= 0 else None

    s = str(val).strip()
    if not s:
        return None
    # 提取首个有效数字+单位
    m = re.search(r"(\d[\d,]*(?:\.\d+)?)\s*(亿|万|w|W|k|K|m|M|b|B)?", s)
    if not m:
        return None
    num_str = m.group(1).replace(",", "")
    unit = (m.group(2) or "").lower()
    try:
        num = float(num_str)
    except ValueError:
        return None
    mult = 1.0
    if unit == "亿":
        mult = 1e8
    elif unit in ("万", "w"):
        mult = 1e4
    elif unit == "k":
        mult = 1e3
    elif unit == "m":
        mult = 1e6
    elif unit == "b":
        mult = 1e9
    return int(round(num * mult))


def _opt_int(val: Any) -> int | None:
    return parse_human_count(val)


def calc_independent_metrics(
    view_count: int | None,
    like_count: int | None,
    comment_count: int | None,
    favorite_count: int | None,
    share_count: int | None,
    author_follower_count: int | None,
    baseline_median_views: float | None = None,
) -> dict[str, float | None]:
    """分别计算互动率、播放粉丝比、异常爆款倍数，严禁混淆定义。"""
    engagement_rate: float | None = None
    if view_count is not None and view_count > 0:
        parts = [x for x in (like_count, comment_count, favorite_count, share_count) if x is not None]
        if parts:
            engagement_rate = round(sum(parts) / float(view_count), 4)

    views_to_followers: float | None = None
    if view_count is not None and view_count > 0 and author_follower_count is not None and author_follower_count > 0:
        views_to_followers = round(float(view_count) / float(author_follower_count), 2)

    outlier_score: float | None = None
    if view_count is not None and view_count > 0 and baseline_median_views is not None and baseline_median_views > 0:
        outlier_score = round(float(view_count) / float(baseline_median_views), 2)

    return {
        "engagement_rate": engagement_rate,
        "views_to_followers": views_to_followers,
        "outlier_score": outlier_score,
    }


def _http_get_json(url: str, params: dict[str, str], timeout: float = 4.0) -> dict[str, Any] | None:
    full_url = f"{url}?{urlencode(params)}"
    req = Request(full_url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=timeout) as resp:
        if resp.status == 200:
            return json.loads(resp.read().decode("utf-8", errors="ignore"))
    return None


def _enrich_public_metadata(url: str, platform: str, item_id: str) -> dict[str, Any]:
    """合法公开只读接口轻量补全（Python 标准库零依赖，绝不绕过限制、绝不读取凭据、超时 4 秒安静降级）。"""
    out: dict[str, Any] = {}
    try:
        if platform == "bilibili" and item_id.upper().startswith("BV"):
            j = _http_get_json("https://api.bilibili.com/x/web-interface/view", {"bvid": item_id})
            if j and j.get("code") == 0 and isinstance(j.get("data"), dict):
                d = j["data"]
                st = d.get("stat") or {}
                owner = d.get("owner") or {}
                out["title"] = d.get("title") or ""
                out["thumbnail_url"] = d.get("pic") or ""
                out["duration_sec"] = d.get("duration")
                if d.get("pubdate"):
                    out["published_at"] = datetime.fromtimestamp(int(d["pubdate"])).strftime("%Y-%m-%d %H:%M")
                out["author"] = owner.get("name") or ""
                if owner.get("mid"):
                    out["author_url"] = f"https://space.bilibili.com/{owner['mid']}"
                out["view_count"] = st.get("view")
                out["like_count"] = st.get("like")
                out["comment_count"] = st.get("reply")
                out["favorite_count"] = st.get("favorite")
                out["share_count"] = st.get("share")
        elif platform == "youtube" and item_id:
            j = _http_get_json("https://www.youtube.com/oembed", {"url": f"https://www.youtube.com/watch?v={item_id}", "format": "json"})
            if j:
                if j.get("title"):
                    out["title"] = j["title"]
                if j.get("author_name"):
                    out["author"] = j["author_name"]
                if j.get("author_url"):
                    out["author_url"] = j["author_url"]
                if j.get("thumbnail_url"):
                    out["thumbnail_url"] = j["thumbnail_url"]
    except Exception:
        pass
    return out


def _suggest_research_tags(title: str, platform: str, search_keyword: str = "") -> list[str]:
    """轻量生成 AI/规则建议标签（仅作建议，前端需用户主动点击采纳，绝不覆盖用户已确认标签）。"""
    tags: list[str] = []
    if platform and platform != "web":
        tags.append(platform)
    kw = (search_keyword or "").strip()
    if kw:
        for seg in re.split(r"[\s,，/]+", kw):
            if 1 < len(seg) <= 16 and seg not in tags:
                tags.append(seg)
    text = f"{title} {kw}"
    rules = [
        ("避坑", ["避坑", "后悔", "别买", "坑", "缺点", "故障"]),
        ("对比评测", ["对比", "vs", "还是", "评测", "实测", "横评"]),
        ("选购攻略", ["怎么选", "买什么", "推荐", "攻略", "技巧", "指南", "预算"]),
        ("痛点需求", ["痛点", "难用", "麻烦", "危险", "障碍", "问题"]),
        ("成本油耗", ["油耗", "省油", "保值", "成本", "价格", "便宜", "续航"]),
        ("人群场景", ["老人", "新手", "家用", "家庭", "自驾", "通勤"]),
    ]
    for label, kws in rules:
        if any(k in text.lower() for k in kws) and label not in tags:
            tags.append(label)
    return tags[:6]


def preview_video_capture(project_id: int, snapshot: dict[str, Any]) -> dict[str, Any]:
    """合并 Electron 只读 DOM 快照与公开只读元数据，返回可供用户核对补填的结构化预览。"""
    url = (snapshot.get("url") or "").strip()
    if not url:
        return {"ok": False, "error": "当前页面 URL 为空，请先在内置浏览器打开视频页面"}

    det_plat, det_id = detect_platform(url)
    platform = (snapshot.get("platform") or det_plat or "web").strip().lower()
    if platform == "web" and det_plat:
        platform = det_plat
    item_id = (snapshot.get("platform_item_id") or det_id or "").strip()

    public_extra = _enrich_public_metadata(url, platform, item_id)
    raw_m = snapshot.get("raw_metrics") or {}

    title = (snapshot.get("title") or public_extra.get("title") or url).strip()
    thumbnail_url = (snapshot.get("thumbnail_url") or public_extra.get("thumbnail_url") or "").strip()
    author = (snapshot.get("author") or public_extra.get("author") or "").strip()
    author_url = (snapshot.get("author_url") or public_extra.get("author_url") or "").strip()
    published_at = (snapshot.get("published_at") or public_extra.get("published_at") or "").strip()
    duration_sec = _opt_int(snapshot.get("duration_sec")) or _opt_int(public_extra.get("duration_sec"))

    view_count = _opt_int(raw_m.get("views"))
    if view_count is None:
        view_count = _opt_int(public_extra.get("view_count"))
    like_count = _opt_int(raw_m.get("likes"))
    if like_count is None:
        like_count = _opt_int(public_extra.get("like_count"))
    comment_count = _opt_int(raw_m.get("comments"))
    if comment_count is None:
        comment_count = _opt_int(public_extra.get("comment_count"))
    favorite_count = _opt_int(raw_m.get("favorites"))
    if favorite_count is None:
        favorite_count = _opt_int(public_extra.get("favorite_count"))
    share_count = _opt_int(raw_m.get("shares"))
    if share_count is None:
        share_count = _opt_int(public_extra.get("share_count"))
    author_follower_count = _opt_int(raw_m.get("followers"))

    # 检查是否已全局收录（去重提示）及该作者是否有可靠历史基线
    conn = get_conn()
    existing_content = None
    linked_topic_ids: list[int] = []
    baseline_median: float | None = None
    try:
        row_c = conn.execute(
            "SELECT id, title, creator_id, research_tags_json, collect_reason FROM contents WHERE platform = ? AND platform_item_id = ?",
            (platform, item_id),
        ).fetchone()
        if row_c:
            existing_content = {
                "content_id": row_c["id"],
                "title": row_c["title"],
                "research_tags": json.loads(row_c["research_tags_json"] or "[]"),
                "collect_reason": row_c["collect_reason"] or "",
            }
            linked_topic_ids = [
                int(r["topic_id"])
                for r in conn.execute(
                    "SELECT DISTINCT topic_id FROM topic_evidence WHERE ref_id = ? AND evidence_type = 'content' AND project_id = ?",
                    (row_c["id"], project_id),
                ).fetchall()
            ]
            if row_c["creator_id"]:
                cr = conn.execute("SELECT baseline_median_views FROM creators WHERE id = ?", (row_c["creator_id"],)).fetchone()
                if cr and cr["baseline_median_views"]:
                    baseline_median = float(cr["baseline_median_views"])
    finally:
        conn.close()

    metrics = calc_independent_metrics(
        view_count, like_count, comment_count, favorite_count, share_count, author_follower_count, baseline_median
    )
    search_keyword = (snapshot.get("search_keyword") or "").strip()
    ai_suggested_tags = _suggest_research_tags(title, platform, search_keyword)

    return {
        "ok": True,
        "preview": {
            "url": url,
            "platform": platform,
            "platform_item_id": item_id,
            "title": title,
            "thumbnail_url": thumbnail_url,
            "author": author,
            "author_url": author_url,
            "published_at": published_at,
            "duration_sec": duration_sec,
            "view_count": view_count,
            "like_count": like_count,
            "comment_count": comment_count,
            "favorite_count": favorite_count,
            "share_count": share_count,
            "author_follower_count": author_follower_count,
            "engagement_rate": metrics["engagement_rate"],
            "views_to_followers": metrics["views_to_followers"],
            "outlier_score": metrics["outlier_score"],
            "collected_at": snapshot.get("collected_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "data_source": "electron_readonly_capture",
            "search_keyword": search_keyword,
            "ai_suggested_tags": ai_suggested_tags,
            "existing_content": existing_content,
            "already_linked_topic_ids": linked_topic_ids,
        },
    }


def save_video_capture(project_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    """用户确认后正式落库：全局去重写入 contents，按三方向关联 TopicHub，严格不自动进入文案工坊。"""
    url = (payload.get("url") or "").strip()
    if not url:
        return {"ok": False, "error": "原始链接不能为空"}

    det_plat, det_id = detect_platform(url)
    platform = (payload.get("platform") or det_plat or "web").strip().lower()
    item_id = (payload.get("platform_item_id") or det_id or "").strip()
    if not item_id:
        return {"ok": False, "error": "无法确定作品唯一 ID"}

    title = (payload.get("title") or url).strip()[:240]
    thumbnail_url = (payload.get("thumbnail_url") or "").strip()[:500]
    author = (payload.get("author") or "").strip()[:120]
    author_url = (payload.get("author_url") or "").strip()[:400]
    published_at = (payload.get("published_at") or "").strip()[:40]
    duration_sec = _opt_int(payload.get("duration_sec"))
    view_count = _opt_int(payload.get("view_count"))
    like_count = _opt_int(payload.get("like_count"))
    comment_count = _opt_int(payload.get("comment_count"))
    favorite_count = _opt_int(payload.get("favorite_count"))
    share_count = _opt_int(payload.get("share_count"))
    author_follower_count = _opt_int(payload.get("author_follower_count"))
    search_keyword = (payload.get("search_keyword") or "").strip()[:120]
    data_source = (payload.get("data_source") or "electron_readonly_capture").strip()[:60]
    capture_reason = (payload.get("capture_reason") or "").strip()[:500]
    user_tags = list(dict.fromkeys([str(t).strip()[:30] for t in (payload.get("research_tags") or []) if str(t).strip()]))

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    collected_at = (payload.get("collected_at") or now_str).strip()[:40]

    # 收录方向：candidate_topic(方案A推荐) / current_topic / existing_topic / new_topic
    mode = (payload.get("target_mode") or "existing_topic").strip()
    target_topic_id = payload.get("target_topic_id")
    candidate_topic_id = payload.get("candidate_topic_id")
    topic_created = False

    conn = get_conn()
    try:
        # 方案 A（原子事务）：首次人工收录视频时，将当前候选选题立即转为 TopicHub「待研究」正式选题；
        # 后续再收录视频时自动关联同一正式选题，且绝不覆盖其已有生命周期状态（如制作中/待制作）。
        if mode == "candidate_topic" and candidate_topic_id:
            cand = conn.execute(
                "SELECT * FROM research_candidate_topics WHERE id = ? AND project_id = ?",
                (int(candidate_topic_id), int(project_id)),
            ).fetchone()
            if not cand:
                return {"ok": False, "error": "关联候选选题不存在或不属于当前研究项目"}
            existing_tid = cand["confirmed_topic_id"]
            reused_tp = None
            if existing_tid:
                reused_tp = conn.execute(
                    "SELECT id, project_id, topic_title, production_status FROM topics WHERE id = ? AND project_id = ?",
                    (int(existing_tid), int(project_id)),
                ).fetchone()
            if reused_tp:
                target_topic_id = int(reused_tp["id"])
            else:
                # 首次收录：在当前同一事务内创建正式选题（默认状态：待研究，验证等级：U）
                cand_queries = json.loads(cand["search_queries_zh_json"] or "[]") + json.loads(cand["search_queries_en_json"] or "[]")
                cur_tp = conn.execute(
                    """INSERT INTO topics(
                           project_id, batch_id, task_id, topic_title, research_question, angle,
                           target_audience, tags_json, keywords_json, task_ids_json,
                           origin_type, discovery_reason, source_evidence_ids_json,
                           suggested_queries_json, missing_evidence_json,
                           validation_status, validation_rule_version, validation_reason,
                           evidence_coverage_pct, four_signals_json,
                           production_status, is_favorite, recommendation,
                           fact_check_status, differentiation_notes, user_notes, script_ready, round_no
                       ) VALUES (?, NULL, NULL, ?, ?, ?, '', ?, ?, '[]', 'A_original_matched', ?, '[]', ?, '[]', 'U', 'gcw-mv-v1.0', '方案A首次收录视频自动保存至TopicHub，待继续研究', 0.0, '{}', '待研究', 0, '待研究', '待核实', '', '', 0, 1)""",
                    (
                        int(project_id),
                        (cand["title"] or title)[:160],
                        (cand["research_hypothesis"] or "")[:400],
                        (cand["angle"] or "")[:400],
                        json.dumps(user_tags, ensure_ascii=False),
                        json.dumps([search_keyword] if search_keyword else [], ensure_ascii=False),
                        f"方案A：用户首次收录参考视频《{title[:80]}》时自动沉淀至 TopicHub",
                        json.dumps(cand_queries[:8], ensure_ascii=False),
                    ),
                )
                target_topic_id = int(cur_tp.lastrowid)
                topic_created = True
                conn.execute(
                    "INSERT INTO topic_status_history(topic_id, project_id, field_name, old_value, new_value, reason, changed_by) VALUES (?, ?, 'production_status', '', '待研究', '方案A首次收录视频自动创建正式选题', 'user')",
                    (target_topic_id, int(project_id)),
                )
                conn.execute(
                    "UPDATE research_candidate_topics SET confirmed_topic_id = ?, status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (target_topic_id, int(candidate_topic_id)),
                )
        elif mode == "new_topic":
            new_title = (payload.get("new_topic_title") or title).strip()
            cur_tp = conn.execute(
                """INSERT INTO topics(
                       project_id, batch_id, task_id, topic_title, research_question, angle,
                       target_audience, tags_json, keywords_json, task_ids_json,
                       origin_type, discovery_reason, source_evidence_ids_json,
                       suggested_queries_json, missing_evidence_json,
                       validation_status, validation_rule_version, validation_reason,
                       evidence_coverage_pct, four_signals_json,
                       production_status, is_favorite, recommendation,
                       fact_check_status, differentiation_notes, user_notes, script_ready, round_no
                   ) VALUES (?, NULL, NULL, ?, ?, ?, '', ?, ?, '[]', 'content_comment_discovery', ?, '[]', ?, '[]', 'U', 'gcw-mv-v1.0', '由内置浏览器一键收录新建选题', 0.0, '{}', '待研究', 0, '待研究', '待核实', '', '', 0, 1)""",
                (
                    int(project_id),
                    new_title[:160],
                    (payload.get("new_topic_question") or "")[:400],
                    (payload.get("new_topic_angle") or capture_reason)[:400],
                    json.dumps(user_tags, ensure_ascii=False),
                    json.dumps([search_keyword] if search_keyword else [], ensure_ascii=False),
                    f"从内置浏览器一键收录视频新建选题：{title[:80]}",
                    json.dumps([search_keyword] if search_keyword else [new_title[:40]], ensure_ascii=False),
                ),
            )
            target_topic_id = int(cur_tp.lastrowid)
            topic_created = True
            conn.execute(
                "INSERT INTO topic_status_history(topic_id, project_id, field_name, old_value, new_value, reason, changed_by) VALUES (?, ?, 'production_status', '', '待研究', '收录视频新建正式选题', 'user')",
                (target_topic_id, int(project_id)),
            )
        else:
            if not target_topic_id:
                return {"ok": False, "error": "请选择要关联的目标选题，或切换为「方案A当前候选选题 / 新建选题」"}
            target_topic_id = int(target_topic_id)

        # 校验目标选题归属当前项目（绝不修改其已有 production_status）
        tp_row = conn.execute(
            "SELECT id, project_id, topic_title, production_status FROM topics WHERE id = ?",
            (target_topic_id,),
        ).fetchone()
        if not tp_row or int(tp_row["project_id"]) != int(project_id):
            return {"ok": False, "error": "目标选题不存在或不属于当前项目"}

        # 1. 作者去重写入/更新（若有作者名）
        creator_id = None
        baseline_median: float | None = None
        if author:
            p_cid = author_url.rstrip("/").split("/")[-1] if author_url else author
            ex_cr = conn.execute(
                "SELECT id, baseline_median_views FROM creators WHERE platform = ? AND platform_creator_id = ?",
                (platform, p_cid[:120]),
            ).fetchone()
            if ex_cr:
                creator_id = int(ex_cr["id"])
                if ex_cr["baseline_median_views"]:
                    baseline_median = float(ex_cr["baseline_median_views"])
                conn.execute(
                    """UPDATE creators SET
                       name = COALESCE(NULLIF(?, ''), name),
                       profile_url = COALESCE(NULLIF(?, ''), profile_url),
                       follower_count = COALESCE(?, follower_count)
                       WHERE id = ?""",
                    (author, author_url, author_follower_count, creator_id),
                )
            else:
                cur_cr = conn.execute(
                    """INSERT INTO creators(platform, platform_creator_id, name, profile_url, follower_count)
                       VALUES (?, ?, ?, ?, ?)""",
                    (platform, p_cid[:120], author, author_url, author_follower_count),
                )
                creator_id = int(cur_cr.lastrowid)

        metrics = calc_independent_metrics(
            view_count, like_count, comment_count, favorite_count, share_count, author_follower_count, baseline_median
        )

        # 2. 作品全局去重写入/更新（UNIQUE(platform, platform_item_id)，绝不改变已有项目的 project_id，且绝不自动进入文案工坊）
        original_share_url = (payload.get("original_share_url") or "").strip()
        ex_c = conn.execute(
            "SELECT id, research_tags_json, original_share_url FROM contents WHERE platform = ? AND platform_item_id = ?",
            (platform, item_id),
        ).fetchone()
        dedup_reused = False
        if ex_c:
            dedup_reused = True
            content_id = int(ex_c["id"])
            old_tags = json.loads(ex_c["research_tags_json"] or "[]")
            merged_tags = list(dict.fromkeys(old_tags + user_tags))
            keep_orig_share = (ex_c["original_share_url"] or "").strip() or original_share_url
            conn.execute(
                """UPDATE contents SET
                   creator_id = COALESCE(?, creator_id),
                   title = COALESCE(NULLIF(?, ''), title),
                   url = ?,
                   original_share_url = COALESCE(NULLIF(?, ''), original_share_url),
                   thumbnail_url = COALESCE(NULLIF(?, ''), thumbnail_url),
                   published_at = COALESCE(NULLIF(?, ''), published_at),
                   duration_sec = COALESCE(?, duration_sec),
                   view_count = COALESCE(?, view_count),
                   like_count = COALESCE(?, like_count),
                   comment_count = COALESCE(?, comment_count),
                   favorite_count = COALESCE(?, favorite_count),
                   share_count = COALESCE(?, share_count),
                   author_name = COALESCE(NULLIF(?, ''), author_name),
                   author_url = COALESCE(NULLIF(?, ''), author_url),
                   author_follower_count = COALESCE(?, author_follower_count),
                   engagement_rate = COALESCE(?, engagement_rate),
                   views_to_followers = COALESCE(?, views_to_followers),
                   outlier_score = COALESCE(?, outlier_score),
                   collect_reason = COALESCE(NULLIF(?, ''), collect_reason),
                   data_source = COALESCE(NULLIF(?, ''), data_source),
                   search_keyword = COALESCE(NULLIF(?, ''), search_keyword),
                   research_tags_json = ?,
                   manual_captured_at = ?
                   WHERE id = ?""",
                (
                    creator_id, title, url, keep_orig_share, thumbnail_url, published_at, duration_sec,
                    view_count, like_count, comment_count, favorite_count, share_count,
                    author, author_url, author_follower_count,
                    metrics["engagement_rate"], metrics["views_to_followers"], metrics["outlier_score"],
                    capture_reason, data_source, search_keyword,
                    json.dumps(merged_tags, ensure_ascii=False), now_str, content_id,
                ),
            )
        else:
            cur_c = conn.execute(
                """INSERT INTO contents(
                       project_id, creator_id, platform, platform_item_id, content_type,
                       title, url, original_share_url, thumbnail_url, published_at, duration_sec,
                       view_count, like_count, comment_count, favorite_count, share_count,
                       author_name, author_url, author_follower_count,
                       engagement_rate, views_to_followers, outlier_score,
                       collect_reason, data_source, search_keyword, research_tags_json,
                       collected_at, manual_captured_at, manual_transcript_collected
                   ) VALUES (?, ?, ?, ?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                (
                    project_id, creator_id, platform, item_id,
                    title, url, original_share_url, thumbnail_url, published_at, duration_sec,
                    view_count, like_count, comment_count, favorite_count, share_count,
                    author, author_url, author_follower_count,
                    metrics["engagement_rate"], metrics["views_to_followers"], metrics["outlier_score"],
                    capture_reason, data_source, search_keyword,
                    json.dumps(user_tags, ensure_ascii=False), collected_at, now_str,
                ),
            )
            content_id = int(cur_c.lastrowid)

        # 3. 写入跨项目作品关联（复用 project_content_links 真实列名）
        conn.execute(
            """INSERT OR IGNORE INTO project_content_links(project_id, content_id, keyword_text, platform, data_source)
               VALUES (?, ?, ?, ?, ?)""",
            (project_id, content_id, search_keyword, platform, data_source),
        )

        # 4. 关联至目标选题（topic_evidence，允许一视频多选题关联）
        ex_ev = conn.execute(
            "SELECT id FROM topic_evidence WHERE topic_id = ? AND project_id = ? AND evidence_type = 'content' AND ref_id = ?",
            (target_topic_id, project_id, content_id),
        ).fetchone()
        if ex_ev:
            conn.execute(
                """UPDATE topic_evidence SET
                   ref_url = ?, snippet = ?, research_tags_json = ?, capture_reason = ?, manual_captured_at = ?
                   WHERE id = ?""",
                (url, title[:180], json.dumps(user_tags, ensure_ascii=False), capture_reason, now_str, ex_ev["id"]),
            )
        else:
            conn.execute(
                """INSERT INTO topic_evidence(
                       topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance,
                       research_tags_json, capture_reason, manual_captured_at
                   ) VALUES (?, ?, 'content', ?, ?, ?, ?, ?, ?, ?)""",
                (
                    target_topic_id, project_id, content_id, url, title[:180],
                    f"one_click:{platform}", json.dumps(user_tags, ensure_ascii=False), capture_reason, now_str,
                ),
            )

        conn.execute("UPDATE topics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (target_topic_id,))
        conn.commit()
        return {
            "ok": True,
            "content_id": content_id,
            "topic_id": target_topic_id,
            "topic_title": tp_row["topic_title"],
            "topic_status": tp_row["production_status"],
            "topic_created": topic_created,
            "dedup_reused": dedup_reused,
            "manual_transcript_collected": 0,
            "metrics": metrics,
        }
    except Exception as e:
        conn.rollback()
        return {"ok": False, "error": f"收录事务失败已自动回滚：{e}"}
    finally:
        conn.close()


def update_topic_content_asset(
    topic_id: int,
    content_id: int,
    project_id: int,
    patch: dict[str, Any],
) -> dict[str, Any]:
    """在 TopicHub 中编辑单个参考视频的标签、收录原因、数据或追加/调整关联选题（全局去重）。"""
    conn = get_conn()
    try:
        ev = conn.execute(
            "SELECT id FROM topic_evidence WHERE topic_id = ? AND project_id = ? AND evidence_type = 'content' AND ref_id = ?",
            (topic_id, project_id, content_id),
        ).fetchone()
        if not ev:
            return {"ok": False, "error": "该选题下未找到此参考视频关联"}

        # FIX-F02: 允许人工修正已收录作品链接，严格校验协议/域名白名单及唯一 ID 防覆盖其他作品，并保留历史链接记录
        if "url" in patch and patch["url"] is not None:
            raw_new_url = str(patch["url"]).strip()
            if raw_new_url:
                extracted = extract_share_links(raw_new_url)
                if len(extracted["urls"]) == 0:
                    return {"ok": False, "error": "新链接未通过安全协议或预期平台域名白名单校验"}
                if len(extracted["urls"]) > 1:
                    return {"ok": False, "error": "检测到多个链接，请只保留一个目标作品链接后再保存"}
                new_url = extracted["urls"][0]
                cur_c = conn.execute(
                    "SELECT id, platform, platform_item_id, url, original_share_url, url_edit_history_json FROM contents WHERE id = ?",
                    (content_id,),
                ).fetchone()
                if not cur_c:
                    return {"ok": False, "error": "未找到目标作品记录"}
                new_plat, new_item_id, is_work = _extract_work_identity(new_url)
                if new_plat == "douyin" and is_work and new_item_id:
                    new_url = f"https://www.douyin.com/video/{new_item_id}"
                check_plat = new_plat if new_plat != "web" else (cur_c["platform"] or "web")
                check_id = new_item_id or cur_c["platform_item_id"]
                if check_id:
                    dup = conn.execute(
                        "SELECT id, title FROM contents WHERE platform = ? AND platform_item_id = ? AND id != ?",
                        (check_plat, check_id, content_id),
                    ).fetchone()
                    if dup:
                        return {
                            "ok": False,
                            "conflict": True,
                            "error": f"唯一 ID 冲突：该链接对应的作品 ({check_plat}:{check_id}) 已被作品 #{dup['id']}《{dup['title'][:40]}》占用，已阻止覆盖其他作品！",
                        }
                old_url = (cur_c["url"] or "").strip()
                hist = json.loads(cur_c["url_edit_history_json"] or "[]")
                if old_url and old_url != new_url:
                    hist.append({"old_url": old_url, "new_url": new_url, "edited_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
                orig_share = (cur_c["original_share_url"] or "").strip() or (
                    (patch.get("original_share_url") or "").strip() or old_url
                )
                conn.execute(
                    """UPDATE contents SET
                       url = ?,
                       platform = ?,
                       platform_item_id = COALESCE(NULLIF(?, ''), platform_item_id),
                       original_share_url = COALESCE(NULLIF(?, ''), original_share_url),
                       url_edit_history_json = ?
                       WHERE id = ?""",
                    (new_url, check_plat, new_item_id, orig_share, json.dumps(hist[-20:], ensure_ascii=False), content_id),
                )
                conn.execute("UPDATE topic_evidence SET ref_url = ? WHERE ref_id = ? AND evidence_type = 'content'", (new_url, content_id))

        if "research_tags" in patch and patch["research_tags"] is not None:
            tags = list(dict.fromkeys([str(t).strip()[:30] for t in patch["research_tags"] if str(t).strip()]))
            tags_json = json.dumps(tags, ensure_ascii=False)
            conn.execute("UPDATE topic_evidence SET research_tags_json = ? WHERE id = ?", (tags_json, ev["id"]))
            conn.execute("UPDATE contents SET research_tags_json = ? WHERE id = ?", (tags_json, content_id))

        if "capture_reason" in patch and patch["capture_reason"] is not None:
            reason = str(patch["capture_reason"]).strip()[:500]
            conn.execute("UPDATE topic_evidence SET capture_reason = ? WHERE id = ?", (reason, ev["id"]))
            conn.execute("UPDATE contents SET collect_reason = ? WHERE id = ?", (reason, content_id))

        # 可选：补充/修正统计字段并重算独立指标
        metric_fields = ("view_count", "like_count", "comment_count", "favorite_count", "share_count", "author_follower_count")
        if any(f in patch for f in metric_fields):
            row_c = conn.execute("SELECT * FROM contents WHERE id = ?", (content_id,)).fetchone()
            vals = {}
            for f in metric_fields:
                vals[f] = _opt_int(patch[f]) if f in patch else row_c[f]
            baseline_median = None
            if row_c["creator_id"]:
                cr = conn.execute("SELECT baseline_median_views FROM creators WHERE id = ?", (row_c["creator_id"],)).fetchone()
                if cr and cr["baseline_median_views"]:
                    baseline_median = float(cr["baseline_median_views"])
            m = calc_independent_metrics(
                vals["view_count"], vals["like_count"], vals["comment_count"],
                vals["favorite_count"], vals["share_count"], vals["author_follower_count"],
                baseline_median,
            )
            conn.execute(
                """UPDATE contents SET
                   view_count = ?, like_count = ?, comment_count = ?,
                   favorite_count = ?, share_count = ?, author_follower_count = ?,
                   engagement_rate = ?, views_to_followers = ?, outlier_score = ?
                   WHERE id = ?""",
                (
                    vals["view_count"], vals["like_count"], vals["comment_count"],
                    vals["favorite_count"], vals["share_count"], vals["author_follower_count"],
                    m["engagement_rate"], m["views_to_followers"], m["outlier_score"], content_id,
                ),
            )

        # 可选：调整关联选题（传入 target_topic_ids，支持将同一视频关联多个选题，作品主体保持唯一）
        if "target_topic_ids" in patch and isinstance(patch["target_topic_ids"], list):
            desired = {int(tid) for tid in patch["target_topic_ids"] if tid}
            if desired:
                c_row = conn.execute("SELECT url, title, platform, research_tags_json, collect_reason FROM contents WHERE id = ?", (content_id,)).fetchone()
                cur_rows = conn.execute(
                    "SELECT id, topic_id FROM topic_evidence WHERE project_id = ? AND evidence_type = 'content' AND ref_id = ?",
                    (project_id, content_id),
                ).fetchall()
                cur_ids = {int(r["topic_id"]) for r in cur_rows}
                # 新增关联
                for add_tid in desired - cur_ids:
                    valid_tp = conn.execute("SELECT id FROM topics WHERE id = ? AND project_id = ?", (add_tid, project_id)).fetchone()
                    if valid_tp:
                        conn.execute(
                            """INSERT OR IGNORE INTO topic_evidence(
                                   topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance,
                                   research_tags_json, capture_reason, manual_captured_at
                               ) VALUES (?, ?, 'content', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                            (
                                add_tid, project_id, content_id, c_row["url"] or "", (c_row["title"] or "")[:180],
                                f"multi_topic_link:{c_row['platform']}", c_row["research_tags_json"] or "[]", c_row["collect_reason"] or "",
                            ),
                        )
                # 移除取消勾选的关联（不删 contents 主体）
                for rem_tid in cur_ids - desired:
                    conn.execute(
                        "DELETE FROM topic_evidence WHERE topic_id = ? AND project_id = ? AND evidence_type = 'content' AND ref_id = ?",
                        (rem_tid, project_id, content_id),
                    )

        conn.commit()
        return {"ok": True, "topic_id": topic_id, "content_id": content_id}
    finally:
        conn.close()
