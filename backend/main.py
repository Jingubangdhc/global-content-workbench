"""FastAPI 主服务：提供五大工作台页面所需的全部 REST 接口与 Bookmarklet 快捷收录入口。"""
import csv
import io
import json
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus, urlparse

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from backend.collectors.media import (
    calc_youtube_video_outlier,
    extract_urls_from_text,
    fetch_creator_profile_and_videos,
    fetch_link_metadata,
    get_jump_links,
    search_bilibili,
    search_web_articles,
    search_youtube,
)
from backend.config import TMP_AUDIO_DIR, get_env_config, save_env_keys
from backend.db import get_conn, init_db, normalize_url
from backend.exporters.export import build_docx_bytes, build_markdown, build_sop_excel_bytes
from backend.extractors.transcript import (
    _detect_whisper_device,
    extract_transcript_pipeline,
    transcribe_local_audio,
    translate_with_llm,
)

app = FastAPI(title="全网内容收集与赛道收益工作台 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _on_startup():
    init_db()


def _get_setting(conn, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


# ==================== 系统状态与设置 ====================
@app.get("/api/bootstrap")
def api_bootstrap():
    stats = init_db()
    device, _ = _detect_whisper_device()
    conn = get_conn()
    settings = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM app_settings").fetchall()}
    projects = [dict(r) for r in conn.execute("SELECT * FROM projects ORDER BY id").fetchall()]
    templates = [dict(r) for r in conn.execute("SELECT * FROM script_templates ORDER BY id").fetchall()]
    conn.close()
    return {
        "stats": stats,
        "env": get_env_config(),
        "whisper_active_device": device,
        "settings": settings,
        "projects": projects,
        "script_templates": templates,
    }


class SettingsUpdate(BaseModel):
    cookie_browser: Optional[str] = None
    low_follower_threshold: Optional[int] = None
    llm_base_url: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None
    tavily_api_key: Optional[str] = None
    youtube_api_key: Optional[str] = None


@app.post("/api/settings")
def api_save_settings(body: SettingsUpdate):
    conn = get_conn()
    if body.cookie_browser is not None:
        conn.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('cookie_browser', ?)", (body.cookie_browser,))
    if body.low_follower_threshold is not None:
        conn.execute(
            "INSERT OR REPLACE INTO app_settings(key, value) VALUES ('low_follower_threshold', ?)",
            (str(body.low_follower_threshold),),
        )
    conn.commit()
    conn.close()

    env_updates = {}
    if body.llm_base_url is not None:
        env_updates["LLM_BASE_URL"] = body.llm_base_url
    if body.llm_api_key:
        env_updates["LLM_API_KEY"] = body.llm_api_key
    if body.llm_model is not None:
        env_updates["LLM_MODEL"] = body.llm_model
    if body.tavily_api_key:
        env_updates["TAVILY_API_KEY"] = body.tavily_api_key
    if body.youtube_api_key:
        env_updates["YOUTUBE_API_KEY"] = body.youtube_api_key
    if env_updates:
        save_env_keys(env_updates)

    return {"ok": True, "env": get_env_config()}


class ProjectCreate(BaseModel):
    name: str
    target_country: str = "United States"
    target_audience: str = ""
    notes: str = ""


@app.post("/api/projects")
def api_create_project(body: ProjectCreate):
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO projects(name, target_country, target_audience, notes) VALUES (?, ?, ?, ?)",
            (body.name.strip(), body.target_country, body.target_audience, body.notes),
        )
        conn.commit()
        row = dict(conn.execute("SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone())
        return row
    except Exception as e:
        raise HTTPException(400, f"项目已存在或创建失败：{e}")
    finally:
        conn.close()


# ==================== 页面①：关键词库与全网搜索中心 ====================
@app.get("/api/keywords")
def api_list_keywords(project_id: Optional[int] = None):
    conn = get_conn()
    sql = """
        SELECT k.*,
               (SELECT COUNT(*) FROM contents c WHERE c.keyword_id = k.id) AS content_count,
               (SELECT COUNT(*) FROM contents c JOIN transcripts t ON t.content_id = c.id
                WHERE c.keyword_id = k.id AND length(coalesce(t.raw_text,'')) > 0) AS transcript_count
        FROM keywords k
    """
    params = []
    if project_id:
        sql += " WHERE k.project_id = ?"
        params.append(project_id)
    sql += " ORDER BY k.id"
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


class KeywordCreate(BaseModel):
    project_id: int
    keyword: str
    category: str = "自定义"
    subcategory: str = ""
    audience: str = ""
    formula_note: str = ""
    verify_warning: str = ""


@app.post("/api/keywords")
def api_add_keyword(body: KeywordCreate):
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO keywords(project_id, category, subcategory, keyword, audience, formula_note, verify_warning)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (body.project_id, body.category, body.subcategory, body.keyword.strip(), body.audience, body.formula_note, body.verify_warning),
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM keywords WHERE id = ?", (cur.lastrowid,)).fetchone())
    except Exception as e:
        raise HTTPException(400, f"关键词已存在：{e}")
    finally:
        conn.close()


@app.delete("/api/keywords/{kw_id}")
def api_delete_keyword(kw_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM keywords WHERE id = ?", (kw_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/search/jump-links")
def api_jump_links(q: str = Query(..., min_length=1)):
    return get_jump_links(q)


class SearchReq(BaseModel):
    keyword: str
    keyword_id: Optional[int] = None
    limit: int = 18
    sort_by: str = "relevance"


@app.post("/api/search/youtube")
def api_search_youtube(body: SearchReq):
    items = search_youtube(body.keyword, limit=min(body.limit, 25), sort_by=body.sort_by)
    if body.keyword_id:
        conn = get_conn()
        conn.execute("UPDATE keywords SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?", (body.keyword_id,))
        conn.commit()
        conn.close()
    return {"keyword": body.keyword, "sort_by": body.sort_by, "count": len(items), "items": items}


class OutlierReq(BaseModel):
    url: str


@app.post("/api/search/youtube-outlier")
def api_youtube_outlier(body: OutlierReq):
    try:
        return calc_youtube_video_outlier(body.url)
    except Exception as e:
        raise HTTPException(500, f"计算基线倍数失败：{str(e)[:200]}")


@app.post("/api/search/bilibili")
def api_search_bilibili(body: SearchReq):
    items = search_bilibili(body.keyword, limit=min(body.limit, 10))
    return {"keyword": body.keyword, "count": len(items), "items": items}


@app.post("/api/search/web")
def api_search_web(body: SearchReq):
    return search_web_articles(body.keyword)


# ==================== 页面②：万能收录、书签投递与作者库 ====================
def _upsert_creator_and_content(conn, meta: dict, project_id: Optional[int], keyword_id: Optional[int], reason: str) -> dict:
    creator_id = None
    if meta.get("creator_name") or meta.get("platform_creator_id"):
        pcid = meta.get("platform_creator_id") or meta.get("creator_name")
        row_c = conn.execute(
            "SELECT id, detected_monetization_json FROM creators WHERE platform = ? AND platform_creator_id = ?",
            (meta["platform"], pcid),
        ).fetchone()
        mon_json = json.dumps(meta.get("detected_monetization") or {}, ensure_ascii=False)
        if not row_c:
            cur_c = conn.execute(
                """INSERT INTO creators
                   (platform, platform_creator_id, name, handle, profile_url, follower_count,
                    baseline_median_views, baseline_updated_at, detected_monetization_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)""",
                (
                    meta["platform"], pcid, meta.get("creator_name") or pcid,
                    meta.get("handle") or "", meta.get("profile_url") or "",
                    meta.get("follower_count"), meta.get("baseline_median_views"), mon_json,
                ),
            )
            creator_id = cur_c.lastrowid
        else:
            creator_id = row_c["id"]
            conn.execute(
                """UPDATE creators SET
                   follower_count = COALESCE(?, follower_count),
                   baseline_median_views = COALESCE(?, baseline_median_views),
                   profile_url = CASE WHEN length(coalesce(profile_url,''))=0 THEN ? ELSE profile_url END,
                   detected_monetization_json = CASE WHEN length(coalesce(?,''))>20 THEN ? ELSE detected_monetization_json END
                   WHERE id = ?""",
                (meta.get("follower_count"), meta.get("baseline_median_views"), meta.get("profile_url") or "", mon_json, mon_json, creator_id),
            )

    existing = conn.execute(
        "SELECT id FROM contents WHERE platform = ? AND platform_item_id = ?",
        (meta["platform"], meta["platform_item_id"]),
    ).fetchone()
    links_json = json.dumps(meta.get("detected_monetization") or {}, ensure_ascii=False)

    if existing:
        cid = existing["id"]
        conn.execute(
            """UPDATE contents SET
               keyword_id = COALESCE(?, keyword_id),
               creator_id = COALESCE(?, creator_id),
               view_count = COALESCE(?, view_count),
               like_count = COALESCE(?, like_count),
               comment_count = COALESCE(?, comment_count),
               views_to_followers = COALESCE(?, views_to_followers),
               outlier_score = COALESCE(?, outlier_score),
               collect_reason = CASE WHEN length(coalesce(?,''))>0 THEN ? ELSE collect_reason END
               WHERE id = ?""",
            (
                keyword_id, creator_id, meta.get("view_count"), meta.get("like_count"),
                meta.get("comment_count"), meta.get("views_to_followers"), meta.get("outlier_score"),
                reason, reason, cid,
            ),
        )
        return {"id": cid, "dedup": True, "warning": meta.get("meta_warning", "")}

    cur = conn.execute(
        """INSERT INTO contents
           (project_id, keyword_id, creator_id, platform, platform_item_id, content_type,
            title, url, thumbnail_url, published_at, duration_sec, view_count, like_count,
            comment_count, views_to_followers, outlier_score, collect_reason, detected_links_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            project_id, keyword_id, creator_id, meta["platform"], meta["platform_item_id"],
            meta.get("content_type"), meta.get("title"), meta["url"], meta.get("thumbnail_url"),
            meta.get("published_at"), meta.get("duration_sec"), meta.get("view_count"),
            meta.get("like_count"), meta.get("comment_count"), meta.get("views_to_followers"),
            meta.get("outlier_score"), reason, links_json,
        ),
    )
    return {"id": cur.lastrowid, "dedup": False, "warning": meta.get("meta_warning", "")}


class CollectReq(BaseModel):
    raw_text: str
    project_id: Optional[int] = None
    keyword_id: Optional[int] = None
    collect_reason: str = ""
    fallback_title: str = ""


@app.post("/api/collect")
def api_collect_links(body: CollectReq):
    urls = extract_urls_from_text(body.raw_text)
    if not urls:
        raise HTTPException(400, "未在文本中识别到有效网址（需以 http:// 或 https:// 开头）。")
    conn = get_conn()
    cookie_browser = _get_setting(conn, "cookie_browser", "none")
    results = []
    for u in urls[:20]:
        meta = fetch_link_metadata(u, fallback_title=body.fallback_title, cookie_browser=cookie_browser)
        r = _upsert_creator_and_content(conn, meta, body.project_id, body.keyword_id, body.collect_reason)
        results.append({"url": u, "title": meta["title"], "platform": meta["platform"], **r})
    conn.commit()
    conn.close()
    return {"count": len(results), "results": results}


@app.get("/quick-collect", response_class=HTMLResponse)
def quick_collect_bookmarklet(url: str = Query(...), title: str = Query("")):
    """浏览器书签栏一键收录回调页。"""
    conn = get_conn()
    cookie_browser = _get_setting(conn, "cookie_browser", "none")
    proj = conn.execute("SELECT id FROM projects ORDER BY id LIMIT 1").fetchone()
    meta = fetch_link_metadata(url, fallback_title=title, cookie_browser=cookie_browser)
    res = _upsert_creator_and_content(conn, meta, proj["id"] if proj else None, None, "书签一键收藏")
    conn.commit()
    conn.close()
    status_txt = "已存在（已更新）" if res["dedup"] else "收录成功"
    return f"""
    <html><body style="background:#0b1120;color:#e2e8f0;font-family:system-ui;padding:32px;text-align:center;">
      <h2 style="color:#34d399;">✅ {status_txt}</h2>
      <p style="color:#94a3b8;">[{meta['platform']}] {meta['title']}</p>
      <p style="font-size:13px;color:#fbbf24;">{res.get('warning','')}</p>
      <button onclick="window.close()" style="margin-top:16px;padding:8px 18px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">关闭窗口</button>
    </body></html>
    """


@app.post("/api/collect/csv")
async def api_import_commerce_csv(file: UploadFile = File(...), project_id: Optional[int] = Form(None)):
    """导入 FastMoss / Kalodata / 蝉妈妈等导出的 CSV，自动识别链接列并批量收录。"""
    raw = await file.read()
    text = raw.decode("utf-8-sig", errors="ignore")
    reader = csv.DictReader(io.StringIO(text))
    conn = get_conn()
    imported = 0
    for row in reader:
        url = ""
        title = ""
        creator = ""
        views = None
        for k, v in row.items():
            kl = (k or "").lower()
            val = (v or "").strip()
            if not url and val.startswith("http"):
                url = val
            if not title and any(w in kl for w in ("title", "标题", "视频", "desc")):
                title = val
            if not creator and any(w in kl for w in ("creator", "author", "达人", "作者", "博主")):
                creator = val
            if views is None and any(w in kl for w in ("view", "play", "播放", "观看")):
                try:
                    views = int(float(val.replace(",", "")))
                except Exception:
                    pass
        if not url:
            continue
        meta = fetch_link_metadata(url, fallback_title=title)
        if creator and not meta["creator_name"]:
            meta["creator_name"] = creator
        if views is not None and meta["view_count"] is None:
            meta["view_count"] = views
        _upsert_creator_and_content(conn, meta, project_id, None, f"CSV导入:{file.filename}")
        imported += 1
        if imported >= 100:
            break
    conn.commit()
    conn.close()
    return {"ok": True, "imported": imported}


@app.get("/api/contents")
def api_list_contents(
    project_id: Optional[int] = None,
    platform: Optional[str] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
):
    conn = get_conn()
    sql = """
        SELECT c.*,
               cr.name AS creator_name, cr.handle AS creator_handle, cr.profile_url AS creator_profile_url,
               cr.follower_count, cr.baseline_median_views,
               k.keyword AS keyword_text,
               CASE WHEN length(coalesce(t.raw_text,'')) > 0 THEN 1 ELSE 0 END AS has_transcript,
               t.hook_analysis, t.script_template_type, t.extract_error
        FROM contents c
        LEFT JOIN creators cr ON cr.id = c.creator_id
        LEFT JOIN keywords k ON k.id = c.keyword_id
        LEFT JOIN transcripts t ON t.content_id = c.id
        WHERE 1=1
    """
    params = []
    if project_id:
        sql += " AND (c.project_id = ? OR c.project_id IS NULL)"
        params.append(project_id)
    if platform and platform != "all":
        sql += " AND c.platform = ?"
        params.append(platform)
    if status and status != "all":
        sql += " AND c.status = ?"
        params.append(status)
    if q:
        sql += " AND (c.title LIKE ? OR c.collect_reason LIKE ? OR cr.name LIKE ?)"
        like = f"%{q}%"
        params.extend([like, like, like])
    sql += " ORDER BY c.id DESC"
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


class ContentPatch(BaseModel):
    title: Optional[str] = None
    view_count: Optional[int] = None
    like_count: Optional[int] = None
    comment_count: Optional[int] = None
    collect_reason: Optional[str] = None
    status: Optional[str] = None


@app.patch("/api/contents/{cid}")
def api_patch_content(cid: int, body: ContentPatch):
    conn = get_conn()
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE contents SET {sets} WHERE id = ?", (*fields.values(), cid))
        conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/contents/{cid}")
def api_delete_content(cid: int):
    conn = get_conn()
    conn.execute("DELETE FROM contents WHERE id = ?", (cid,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/creators")
def api_list_creators(platform: Optional[str] = None):
    conn = get_conn()
    sql = """
        SELECT cr.*,
               (SELECT COUNT(*) FROM contents c WHERE c.creator_id = cr.id) AS video_count,
               (SELECT MAX(outlier_score) FROM contents c WHERE c.creator_id = cr.id) AS max_outlier
        FROM creators cr
        WHERE 1=1
    """
    params = []
    if platform and platform != "all":
        sql += " AND cr.platform = ?"
        params.append(platform)
    sql += " ORDER BY cr.is_starred DESC, video_count DESC, cr.id DESC"
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


class CreatorPatch(BaseModel):
    is_starred: Optional[int] = None
    strengths_note: Optional[str] = None
    estimated_monthly_rev_note: Optional[str] = None
    follower_count: Optional[int] = None


@app.patch("/api/creators/{cr_id}")
def api_patch_creator(cr_id: int, body: CreatorPatch):
    conn = get_conn()
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE creators SET {sets} WHERE id = ?", (*fields.values(), cr_id))
        conn.commit()
    conn.close()
    return {"ok": True}


class TrackCreatorReq(BaseModel):
    profile_url: str
    project_id: Optional[int] = None
    limit: int = 15
    strengths_note: str = ""


def _save_tracked_creator(conn, data: dict, project_id: Optional[int], note: str = "") -> dict:
    mon_json = json.dumps(data.get("detected_monetization") or {}, ensure_ascii=False)
    row_c = conn.execute(
        "SELECT id FROM creators WHERE platform = ? AND platform_creator_id = ?",
        (data["platform"], data["platform_creator_id"]),
    ).fetchone()
    if not row_c:
        cur = conn.execute(
            """INSERT INTO creators
               (platform, platform_creator_id, name, handle, profile_url, follower_count,
                baseline_median_views, baseline_updated_at, bio_text, detected_monetization_json,
                strengths_note, is_starred)
               VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, 1)""",
            (
                data["platform"], data["platform_creator_id"], data["name"], data["handle"],
                data["profile_url"], data.get("follower_count"), data.get("baseline_median_views"),
                data.get("bio_text", ""), mon_json, note,
            ),
        )
        cr_id = cur.lastrowid
    else:
        cr_id = row_c["id"]
        conn.execute(
            """UPDATE creators SET
               name = COALESCE(?, name),
               handle = CASE WHEN length(coalesce(?,''))>0 THEN ? ELSE handle END,
               profile_url = CASE WHEN length(coalesce(?,''))>0 THEN ? ELSE profile_url END,
               follower_count = COALESCE(?, follower_count),
               baseline_median_views = COALESCE(?, baseline_median_views),
               baseline_updated_at = CURRENT_TIMESTAMP,
               bio_text = CASE WHEN length(coalesce(?,''))>0 THEN ? ELSE bio_text END,
               detected_monetization_json = CASE WHEN length(coalesce(?,''))>20 THEN ? ELSE detected_monetization_json END,
               strengths_note = CASE WHEN length(coalesce(?,''))>0 THEN ? ELSE strengths_note END
               WHERE id = ?""",
            (
                data["name"], data["handle"], data["handle"], data["profile_url"], data["profile_url"],
                data.get("follower_count"), data.get("baseline_median_views"),
                data.get("bio_text", ""), data.get("bio_text", ""), mon_json, mon_json, note, note, cr_id,
            ),
        )

    added_videos = 0
    for v in data.get("videos") or []:
        ex = conn.execute(
            "SELECT id FROM contents WHERE platform = ? AND platform_item_id = ?",
            (v["platform"], v["platform_item_id"]),
        ).fetchone()
        if ex:
            conn.execute(
                """UPDATE contents SET
                   creator_id = ?, view_count = COALESCE(?, view_count),
                   outlier_score = COALESCE(?, outlier_score),
                   views_to_followers = COALESCE(?, views_to_followers)
                   WHERE id = ?""",
                (cr_id, v.get("view_count"), v.get("outlier_score"), v.get("views_to_followers"), ex["id"]),
            )
        else:
            conn.execute(
                """INSERT INTO contents
                   (project_id, creator_id, platform, platform_item_id, content_type, title, url,
                    thumbnail_url, published_at, duration_sec, view_count, like_count, comment_count,
                    views_to_followers, outlier_score, collect_reason, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox')""",
                (
                    project_id, cr_id, v["platform"], v["platform_item_id"], v.get("content_type"),
                    v.get("title"), v["url"], v.get("thumbnail_url"), v.get("published_at"),
                    v.get("duration_sec"), v.get("view_count"), v.get("like_count"),
                    v.get("comment_count"), v.get("views_to_followers"), v.get("outlier_score"),
                    f"博主追踪:{data['name']}",
                ),
            )
            added_videos += 1
    return {"creator_id": cr_id, "total_fetched": len(data.get("videos") or []), "added_videos": added_videos, "warning": data.get("warning", "")}


@app.post("/api/creators/track")
def api_track_creator(body: TrackCreatorReq):
    urls = extract_urls_from_text(body.profile_url)
    if not urls:
        raise HTTPException(400, "请输入有效的博主主页链接（以 http:// 或 https:// 开头）。")
    conn = get_conn()
    cookie_browser = _get_setting(conn, "cookie_browser", "none")
    data = fetch_creator_profile_and_videos(urls[0], limit=min(body.limit, 30), cookie_browser=cookie_browser)
    res = _save_tracked_creator(conn, data, body.project_id, body.strengths_note)
    conn.commit()
    conn.close()
    return {"ok": True, "creator_name": data["name"], **res}


@app.post("/api/creators/{cr_id}/refresh")
def api_refresh_creator(cr_id: int, limit: int = Query(15)):
    conn = get_conn()
    cr = conn.execute("SELECT * FROM creators WHERE id = ?", (cr_id,)).fetchone()
    if not cr or not cr["profile_url"]:
        conn.close()
        raise HTTPException(404, "该博主缺少主页链接，无法自动刷新。")
    cookie_browser = _get_setting(conn, "cookie_browser", "none")
    data = fetch_creator_profile_and_videos(cr["profile_url"], limit=min(limit, 30), cookie_browser=cookie_browser)
    res = _save_tracked_creator(conn, data, None, "")
    conn.commit()
    conn.close()
    return {"ok": True, "creator_name": data["name"], **res}


@app.get("/api/creators/{cr_id}/videos")
def api_creator_videos(cr_id: int):
    conn = get_conn()
    cr = conn.execute("SELECT * FROM creators WHERE id = ?", (cr_id,)).fetchone()
    if not cr:
        conn.close()
        raise HTTPException(404, "未找到该博主")
    videos = [
        dict(r)
        for r in conn.execute(
            """SELECT c.*,
                      CASE WHEN length(coalesce(t.raw_text,'')) > 0 THEN 1 ELSE 0 END AS has_transcript
               FROM contents c
               LEFT JOIN transcripts t ON t.content_id = c.id
               WHERE c.creator_id = ?
               ORDER BY c.outlier_score DESC, c.view_count DESC, c.id DESC""",
            (cr_id,),
        ).fetchall()
    ]
    conn.close()
    return {"creator": dict(cr), "videos": videos}


@app.delete("/api/creators/{cr_id}")
def api_delete_creator(cr_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM creators WHERE id = ?", (cr_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ==================== 页面③：文案提取工坊与多格式导出 ====================
@app.get("/api/transcripts/{cid}")
def api_get_transcript(cid: int):
    conn = get_conn()
    c = conn.execute(
        """SELECT c.*, cr.name AS creator_name, cr.profile_url AS creator_profile_url, cr.follower_count
           FROM contents c LEFT JOIN creators cr ON cr.id = c.creator_id WHERE c.id = ?""",
        (cid,),
    ).fetchone()
    if not c:
        conn.close()
        raise HTTPException(404, "未找到该素材")
    t = conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone()
    conn.close()
    return {"content": dict(c), "transcript": dict(t) if t else None}


@app.post("/api/extract/{cid}")
def api_extract_transcript(cid: int):
    conn = get_conn()
    c = conn.execute("SELECT * FROM contents WHERE id = ?", (cid,)).fetchone()
    if not c:
        conn.close()
        raise HTTPException(404, "未找到该素材")
    cookie_browser = _get_setting(conn, "cookie_browser", "none")
    res = extract_transcript_pipeline(c["platform"], c["platform_item_id"], c["url"], cookie_browser=cookie_browser)

    seg_json = json.dumps(res.get("segments") or [], ensure_ascii=False)
    conn.execute(
        """INSERT INTO transcripts(content_id, extract_method, language, raw_text, segments_json, extract_error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(content_id) DO UPDATE SET
             extract_method=excluded.extract_method,
             language=excluded.language,
             raw_text=CASE WHEN length(excluded.raw_text)>0 THEN excluded.raw_text ELSE transcripts.raw_text END,
             segments_json=CASE WHEN length(excluded.raw_text)>0 THEN excluded.segments_json ELSE transcripts.segments_json END,
             extract_error=excluded.extract_error,
             updated_at=CURRENT_TIMESTAMP""",
        (cid, res["extract_method"], res["language"], res["raw_text"], seg_json, res["error"]),
    )
    if res["ok"]:
        conn.execute("UPDATE contents SET status = 'extracted' WHERE id = ? AND status IN ('inbox','useful')", (cid,))
    conn.commit()
    t = dict(conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone())
    conn.close()
    return {"ok": res["ok"], "error": res["error"], "transcript": t}


@app.post("/api/extract/upload/{cid}")
async def api_upload_audio_transcribe(cid: int, file: UploadFile = File(...)):
    """拖拽本地音视频文件直接走本地 faster-whisper 转写，转写后立即删除临时文件。"""
    ext = Path(file.filename or "audio.mp3").suffix or ".mp3"
    tmp_path = TMP_AUDIO_DIR / f"upload_{uuid.uuid4().hex[:10]}{ext}"
    tmp_path.write_bytes(await file.read())
    try:
        res = transcribe_local_audio(tmp_path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()

    conn = get_conn()
    seg_json = json.dumps(res.get("segments") or [], ensure_ascii=False)
    conn.execute(
        """INSERT INTO transcripts(content_id, extract_method, language, raw_text, segments_json, extract_error, updated_at)
           VALUES (?, ?, ?, ?, ?, '', CURRENT_TIMESTAMP)
           ON CONFLICT(content_id) DO UPDATE SET
             extract_method=excluded.extract_method, language=excluded.language,
             raw_text=excluded.raw_text, segments_json=excluded.segments_json,
             extract_error='', updated_at=CURRENT_TIMESTAMP""",
        (cid, res["extract_method"], res["language"], res["raw_text"], seg_json),
    )
    conn.execute("UPDATE contents SET status = 'extracted' WHERE id = ? AND status IN ('inbox','useful')", (cid,))
    conn.commit()
    t = dict(conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone())
    conn.close()
    return {"ok": True, "transcript": t}


class TranscriptSave(BaseModel):
    raw_text: Optional[str] = None
    hook_analysis: Optional[str] = None
    script_template_type: Optional[str] = None
    my_draft_text: Optional[str] = None
    translated_zh: Optional[str] = None


@app.put("/api/transcripts/{cid}")
def api_save_transcript(cid: int, body: TranscriptSave):
    conn = get_conn()
    conn.execute(
        """INSERT INTO transcripts(content_id, extract_method, raw_text, hook_analysis, script_template_type, my_draft_text, translated_zh, updated_at)
           VALUES (?, 'manual', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(content_id) DO UPDATE SET
             raw_text = COALESCE(?, transcripts.raw_text),
             hook_analysis = COALESCE(?, transcripts.hook_analysis),
             script_template_type = COALESCE(?, transcripts.script_template_type),
             my_draft_text = COALESCE(?, transcripts.my_draft_text),
             translated_zh = COALESCE(?, transcripts.translated_zh),
             updated_at = CURRENT_TIMESTAMP""",
        (
            cid, body.raw_text or "", body.hook_analysis or "", body.script_template_type or "",
            body.my_draft_text or "", body.translated_zh or "",
            body.raw_text, body.hook_analysis, body.script_template_type, body.my_draft_text, body.translated_zh,
        ),
    )
    conn.commit()
    t = dict(conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone())
    conn.close()
    return {"ok": True, "transcript": t}


@app.post("/api/transcripts/{cid}/translate")
def api_translate_transcript(cid: int):
    """仅用户手动点击按钮触发：调用 .env 中配置的 OpenAI 兼容模型翻译原文。"""
    conn = get_conn()
    t = conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone()
    if not t or not (t["raw_text"] or "").strip():
        conn.close()
        raise HTTPException(400, "原文为空，请先提取或粘贴原文。")
    try:
        res = translate_with_llm(t["raw_text"])
    except Exception as e:
        conn.close()
        raise HTTPException(400, str(e))
    conn.execute(
        "UPDATE transcripts SET translated_zh = ?, updated_at = CURRENT_TIMESTAMP WHERE content_id = ?",
        (res["translated_text"], cid),
    )
    conn.commit()
    conn.close()
    return {"ok": True, **res}


@app.get("/api/export/content/{cid}")
def api_export_single(cid: int, fmt: str = Query("md")):
    conn = get_conn()
    c = conn.execute(
        "SELECT c.*, cr.name AS creator_name FROM contents c LEFT JOIN creators cr ON cr.id = c.creator_id WHERE c.id = ?",
        (cid,),
    ).fetchone()
    if not c:
        conn.close()
        raise HTTPException(404, "未找到素材")
    t = conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone()
    conn.close()
    cd, td = dict(c), dict(t) if t else {}
    if fmt == "docx":
        data = build_docx_bytes(cd, td)
        return StreamingResponse(
            io.BytesIO(data),
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="script_{cid}.docx"'},
        )
    md = build_markdown(cd, td)
    return PlainTextResponse(md, headers={"Content-Disposition": f'attachment; filename="script_{cid}.md"'})


@app.get("/api/export/sop-excel")
def api_export_sop_excel():
    conn = get_conn()
    contents = [
        dict(r)
        for r in conn.execute(
            """SELECT c.*, cr.name AS creator_name, cr.baseline_median_views,
                      t.hook_analysis, t.script_template_type,
                      CASE WHEN length(coalesce(t.raw_text,''))>0 THEN 1 ELSE 0 END AS has_transcript
               FROM contents c
               LEFT JOIN creators cr ON cr.id = c.creator_id
               LEFT JOIN transcripts t ON t.content_id = c.id
               ORDER BY c.id DESC"""
        ).fetchall()
    ]
    creators = []
    for r in conn.execute("SELECT * FROM creators ORDER BY id DESC").fetchall():
        d = dict(r)
        try:
            tags = json.loads(d.get("detected_monetization_json") or "{}").get("tags") or []
            d["monetization_tags"] = "、".join(tags)
        except Exception:
            d["monetization_tags"] = ""
        creators.append(d)
    conn.close()
    data = build_sop_excel_bytes(contents, creators)
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="workbench_sop_export.xlsx"'},
    )


# ==================== 页面④⑤：赛道收益雷达与网址导航总库 ====================
@app.get("/api/tools")
def api_list_tools(
    view_mode: str = Query("external"),  # external(默认看同行) / own(我的后台) / all
    major_group: Optional[str] = None,
    category: Optional[str] = None,
    platform: Optional[str] = None,
    region: Optional[str] = None,
    fee_tier: Optional[str] = None,
    q: Optional[str] = None,
):
    conn = get_conn()
    sql = """
        SELECT t.*, tc.id AS cap_id, tc.major_group, tc.category, tc.region,
               tc.target_platform, tc.data_nature, tc.metrics_desc,
               tc.operation_path, tc.limitation_warning, tc.priority
        FROM tools t
        JOIN tool_capabilities tc ON tc.tool_id = t.id
        WHERE 1=1
    """
    params = []
    if view_mode == "external":
        sql += " AND t.access_scope != 'own_only'"
    elif view_mode == "own":
        sql += " AND t.access_scope = 'own_only'"

    if major_group and major_group != "all":
        sql += " AND tc.major_group = ?"
        params.append(major_group)
    if category and category != "all":
        sql += " AND tc.category = ?"
        params.append(category)
    if platform and platform != "all":
        sql += " AND tc.target_platform = ?"
        params.append(platform)
    if region and region != "all":
        sql += " AND tc.region = ?"
        params.append(region)
    if fee_tier and fee_tier != "all":
        sql += " AND t.fee_tier = ?"
        params.append(fee_tier)
    if q:
        sql += " AND (t.name LIKE ? OR t.domain LIKE ? OR tc.metrics_desc LIKE ? OR tc.target_platform LIKE ? OR t.my_note LIKE ?)"
        like = f"%{q}%"
        params.extend([like, like, like, like, like])

    # 排序铁律：置顶/已付费 -> 免费 -> 限免 -> 付费 -> A核心
    sql += """
        ORDER BY t.is_pinned DESC,
                 CASE t.my_status WHEN 'paid_active' THEN 0 WHEN 'useful' THEN 1 ELSE 2 END,
                 CASE t.fee_tier WHEN 'free' THEN 0 WHEN 'freemium' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END,
                 tc.priority ASC, t.id ASC
    """
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


@app.get("/api/revenue/matrix")
def api_revenue_matrix(view_mode: str = Query("external")):
    """返回商业变现 11 大模式 × 平台矩阵及统计计数。"""
    conn = get_conn()
    scope_sql = "AND t.access_scope != 'own_only'" if view_mode == "external" else (
        "AND t.access_scope = 'own_only'" if view_mode == "own" else ""
    )
    rows = [
        dict(r)
        for r in conn.execute(
            f"""SELECT tc.category, tc.target_platform, t.id AS tool_id, t.name, t.url, t.domain,
                       t.access_scope, t.fee_tier, t.fee_detail, t.pricing_evidence_url,
                       t.my_status, t.my_monthly_cost, t.my_expire_date, t.is_pinned, t.my_note,
                       tc.data_nature, tc.metrics_desc, tc.operation_path, tc.limitation_warning, tc.priority
                FROM tools t
                JOIN tool_capabilities tc ON tc.tool_id = t.id
                WHERE tc.major_group = '商业变现' {scope_sql}
                ORDER BY t.is_pinned DESC,
                         CASE t.my_status WHEN 'paid_active' THEN 0 ELSE 1 END,
                         CASE t.fee_tier WHEN 'free' THEN 0 WHEN 'freemium' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END"""
        ).fetchall()
    ]
    conn.close()
    return {"items": rows}


@app.get("/api/revenue/xray")
def api_author_xray(query: str = Query(..., min_length=1), platform: str = Query("youtube")):
    """输入作者 @handle 或独立站域名，生成免爬一键侦察链接组。"""
    raw = query.strip()
    is_domain = "." in raw and " " not in raw and not raw.startswith("@")
    clean_handle = raw.lstrip("@").strip("/")
    clean_domain = urlparse(raw if raw.startswith("http") else f"https://{raw}").netloc.lstrip("www.") if is_domain else ""
    q_enc = quote_plus(clean_handle)

    links = []
    if is_domain and clean_domain:
        links.extend([
            {"name": "Similarweb 网站流量", "tier": "freemium", "url": f"https://www.similarweb.com/website/{clean_domain}/"},
            {"name": "PPSPY Shopify追踪", "tier": "freemium", "url": "https://www.ppspy.com/shopify-spy"},
            {"name": "Meta 广告库（查在投广告）", "tier": "free", "url": f"https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q={quote_plus(clean_domain)}"},
            {"name": "访问店铺热销页", "tier": "free", "url": f"https://{clean_domain}/collections/best-sellers"},
        ])
    else:
        if platform == "youtube":
            links.extend([
                {"name": "Viewstats 异常爆款与收益", "tier": "freemium", "url": f"https://www.viewstats.com/@{clean_handle}"},
                {"name": "Social Blade 涨粉与广告区间", "tier": "freemium", "url": f"https://socialblade.com/youtube/handle/{clean_handle}"},
                {"name": "Playboard SuperChat/排名", "tier": "free", "url": f"https://playboard.co/en/search?q={q_enc}"},
                {"name": "NoxInfluencer 频道估值", "tier": "freemium", "url": f"https://www.noxinfluencer.com/search?q={q_enc}"},
            ])
        elif platform == "tiktok":
            links.extend([
                {"name": "FastMoss 带货GMV", "tier": "paid", "url": "https://www.fastmoss.com/"},
                {"name": "Kalodata 带货视频", "tier": "paid", "url": "https://www.kalodata.com/"},
                {"name": "Social Blade TikTok", "tier": "freemium", "url": f"https://socialblade.com/tiktok/user/{clean_handle}"},
            ])
        elif platform == "douyin":
            links.extend([
                {"name": "飞瓜抖音（带货GMV）", "tier": "paid", "url": "https://dy.feigua.cn/"},
                {"name": "蝉妈妈（直播/短视频）", "tier": "paid", "url": "https://www.chanmama.com/"},
                {"name": "巨量星图（商单报价）", "tier": "freemium", "url": "https://www.xingtu.cn/"},
            ])
        elif platform == "xiaohongshu":
            links.extend([
                {"name": "蒲公英（商单报价）", "tier": "freemium", "url": "https://pgy.xiaohongshu.com/"},
                {"name": "千瓜数据（商业笔记）", "tier": "paid", "url": "https://www.qian-gua.com/"},
                {"name": "新红（达人榜）", "tier": "freemium", "url": "https://xh.newrank.cn/"},
            ])
        elif platform == "bilibili":
            links.extend([
                {"name": "B站花火（商单报价）", "tier": "freemium", "url": "https://huahuo.bilibili.com/"},
                {"name": "飞瓜B站", "tier": "freemium", "url": "https://bz.feigua.cn/"},
            ])
        links.extend([
            {"name": "Graphtreon（查Patreon订阅）", "tier": "freemium", "url": f"https://graphtreon.com/creator/{clean_handle}"},
            {"name": "TwitchTracker（查直播）", "tier": "free", "url": f"https://twitchtracker.com/{clean_handle}"},
            {"name": "Meta Ad Library（搜品牌广告）", "tier": "free", "url": f"https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q={q_enc}"},
        ])
    return {"query": raw, "is_domain": is_domain, "links": links}


class ToolPatch(BaseModel):
    my_status: Optional[str] = None
    my_monthly_cost: Optional[float] = None
    my_expire_date: Optional[str] = None
    is_pinned: Optional[int] = None
    my_note: Optional[str] = None


@app.patch("/api/tools/{tool_id}")
def api_patch_tool(tool_id: int, body: ToolPatch):
    conn = get_conn()
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE tools SET {sets} WHERE id = ?", (*fields.values(), tool_id))
        conn.commit()
    conn.close()
    return {"ok": True}


class ToolCreate(BaseModel):
    name: str
    url: str
    major_group: str = "商业变现"
    category: str = "短视频带货"
    region: str = "海外"
    target_platform: str = "YouTube"
    access_scope: str = "competitor"
    fee_tier: str = "freemium"
    metrics_desc: str = ""
    my_note: str = ""


@app.post("/api/tools")
def api_create_tool(body: ToolCreate):
    norm_url, host = normalize_url(body.url)
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO tools(tool_code, name, url, domain, access_scope, fee_tier, fee_detail, pricing_evidence_url, my_note)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (f"USR_{uuid.uuid4().hex[:6]}", body.name.strip(), norm_url, host, body.access_scope, body.fee_tier, body.my_note, norm_url, body.my_note),
        )
        tid = cur.lastrowid
        conn.execute(
            """INSERT INTO tool_capabilities(tool_id, source_record_id, major_group, category, region, target_platform, data_nature, metrics_desc, priority)
               VALUES (?, 'USER', ?, ?, ?, ?, '用户新增', ?, 'A 核心')""",
            (tid, body.major_group, body.category, body.region, body.target_platform, body.metrics_desc),
        )
        conn.commit()
        return {"ok": True, "id": tid}
    except Exception as e:
        raise HTTPException(400, f"网址已存在或保存失败：{e}")
    finally:
        conn.close()


# ==================== 赛道收益证据本 ====================
@app.get("/api/revenue/evidence")
def api_list_evidence():
    conn = get_conn()
    rows = [dict(r) for r in conn.execute("SELECT * FROM revenue_evidence ORDER BY id DESC").fetchall()]
    conn.close()
    return rows


class EvidenceCreate(BaseModel):
    niche: str
    monetization_type: str
    platform: str
    content_format: str = "长视频"
    audience_region: str = "US"
    metric_name: str = "RPM"
    amount_min: Optional[float] = None
    amount_max: Optional[float] = None
    currency: str = "USD"
    period_desc: str = ""
    evidence_level: str = "L2_SELF_REPORTED"
    source_url: str = ""
    note: str = ""


@app.post("/api/revenue/evidence")
def api_add_evidence(body: EvidenceCreate):
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO revenue_evidence
           (niche, monetization_type, platform, content_format, audience_region, metric_name,
            amount_min, amount_max, currency, period_desc, evidence_level, source_url, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            body.niche, body.monetization_type, body.platform, body.content_format,
            body.audience_region, body.metric_name, body.amount_min, body.amount_max,
            body.currency, body.period_desc, body.evidence_level, body.source_url, body.note,
        ),
    )
    conn.commit()
    row = dict(conn.execute("SELECT * FROM revenue_evidence WHERE id = ?", (cur.lastrowid,)).fetchone())
    conn.close()
    return row


@app.delete("/api/revenue/evidence/{eid}")
def api_del_evidence(eid: int):
    conn = get_conn()
    conn.execute("DELETE FROM revenue_evidence WHERE id = ?", (eid,))
    conn.commit()
    conn.close()
    return {"ok": True}
