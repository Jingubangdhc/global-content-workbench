"""FastAPI 主服务：提供五大工作台页面所需的全部 REST 接口与 Bookmarklet 快捷收录入口。"""
import csv
import io
import json
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus, urlparse

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from backend.collectors.assets import search_real_assets
from backend.collectors.comments import fetch_video_comments, summarize_comment_keywords
from backend.collectors.douyin_api import check_douyin_api_health
from backend.collectors.hot_trends import fetch_all_hot_trends
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
from backend.extractors.analysis import fetch_youtube_heatmap_highlights, run_anchored_breakdown
from backend.routers.video_studio import router as video_studio_router
from backend.routers.publish_hub import router as publish_hub_router
from backend.routers.motion_registry import router as motion_registry_router
from backend.routers.style_dna import router as style_dna_router
from backend.routers.ai_video_jobs import router as ai_video_jobs_router
from backend.routers.search_research import router as search_research_router
from backend.routers.topic_hub import router as topic_hub_router
from backend.routers.research_tree import router as research_tree_router
from backend.routers.credential_vault import router as credential_vault_router
from backend.routers.translation import router as translation_router
from backend.services.translation_provider import translate_content_segments
from backend.services.motion_registry import sync_builtin_motion_assets
from backend.services.style_dna_service import ensure_default_style_dna
from backend.extractors.transcript import (
    _detect_whisper_device,
    extract_transcript_pipeline,
    transcribe_local_audio,
    translate_batch_with_llm,
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
app.include_router(video_studio_router)
app.include_router(publish_hub_router)
app.include_router(motion_registry_router)
app.include_router(style_dna_router)
app.include_router(ai_video_jobs_router)
app.include_router(search_research_router)
app.include_router(topic_hub_router)
app.include_router(research_tree_router)
app.include_router(credential_vault_router)
app.include_router(translation_router)


@app.on_event("startup")
def _on_startup():
    init_db()
    sync_builtin_motion_assets()
    ensure_default_style_dna()


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
    douyin_api_base: Optional[str] = None
    asr_engine: Optional[str] = None
    pexels_api_key: Optional[str] = None
    pixabay_api_key: Optional[str] = None
    ui_font_scale: Optional[str] = None


@app.get("/api/douyin-api/health")
def api_douyin_health(base: Optional[str] = None):
    return check_douyin_api_health(base)


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
    if body.douyin_api_base is not None:
        env_updates["DOUYIN_API_BASE"] = body.douyin_api_base
    if body.asr_engine is not None:
        env_updates["ASR_ENGINE"] = body.asr_engine
    if body.pexels_api_key:
        env_updates["PEXELS_API_KEY"] = body.pexels_api_key
    if body.pixabay_api_key:
        env_updates["PIXABAY_API_KEY"] = body.pixabay_api_key
    if env_updates:
        save_env_keys(env_updates)

    return {"ok": True, "env": get_env_config()}


class ProjectCreate(BaseModel):
    name: str
    target_country: str = "United States"
    target_audience: str = ""
    notes: str = ""


def _assert_local_origin(request: Request) -> None:
    """校验项目写接口的本地来源：无 Origin（同源/本机脚本）或合法 localhost/127.0.0.1/[::1] 放行，非法外部 Origin 拒绝。"""
    origin = (request.headers.get("origin") or "").strip()
    if not origin:
        return
    parsed = urlparse(origin)
    if parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise HTTPException(403, f"仅允许从本地工作台访问此接口（已拒绝非法来源：{origin}）")


@app.post("/api/projects")
def api_create_project(body: ProjectCreate, request: Request):
    _assert_local_origin(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "项目名称不能为空")
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO projects(name, target_country, target_audience, notes) VALUES (?, ?, ?, ?)",
            (name, body.target_country, body.target_audience, body.notes),
        )
        conn.commit()
        row = dict(conn.execute("SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone())
        return row
    except Exception as e:
        raise HTTPException(400, f"项目已存在或创建失败：{e}")
    finally:
        conn.close()


@app.delete("/api/projects/{proj_id}")
def api_delete_project(proj_id: int, request: Request):
    """删除项目（至少保留 1 个项目；已收录素材解除关联但不删除数据）。"""
    _assert_local_origin(request)
    conn = get_conn()
    try:
        cnt = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        if cnt <= 1:
            raise HTTPException(400, "至少需要保留 1 个研究项目，无法全部删除。")
        conn.execute("UPDATE contents SET project_id = NULL WHERE project_id = ?", (proj_id,))
        conn.execute("UPDATE revenue_evidence SET project_id = NULL WHERE project_id = ?", (proj_id,))
        conn.execute("DELETE FROM keywords WHERE project_id = ?", (proj_id,))
        conn.execute("DELETE FROM projects WHERE id = ?", (proj_id,))
        conn.commit()
        return {"ok": True}
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
    if body.keyword_id:
        conn = get_conn()
        conn.execute("UPDATE keywords SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?", (body.keyword_id,))
        conn.commit()
        conn.close()
    return {"keyword": body.keyword, "count": len(items), "items": items}


@app.post("/api/search/web")
def api_search_web(body: SearchReq):
    return search_web_articles(body.keyword)


@app.get("/api/trends/hot")
def api_hot_trends(force: bool = Query(False)):
    return {"sources": fetch_all_hot_trends(force=force)}


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
        "SELECT id, project_id, keyword_id, collect_reason FROM contents WHERE platform = ? AND platform_item_id = ?",
        (meta["platform"], meta["platform_item_id"]),
    ).fetchone()
    links_json = json.dumps(meta.get("detected_monetization") or {}, ensure_ascii=False)

    if existing:
        cid = existing["id"]
        owner_pid = existing["project_id"]
        # 强制跨项目数据污染保护：若该作品已归属其他项目，严禁覆写原项目的 project_id / keyword_id / collect_reason
        if owner_pid is not None and project_id is not None and int(owner_pid) != int(project_id):
            conn.execute(
                """UPDATE contents SET
                   creator_id = COALESCE(?, creator_id),
                   view_count = COALESCE(?, view_count),
                   like_count = COALESCE(?, like_count),
                   comment_count = COALESCE(?, comment_count),
                   views_to_followers = COALESCE(?, views_to_followers),
                   outlier_score = COALESCE(?, outlier_score)
                   WHERE id = ?""",
                (
                    creator_id, meta.get("view_count"), meta.get("like_count"),
                    meta.get("comment_count"), meta.get("views_to_followers"), meta.get("outlier_score"),
                    cid,
                ),
            )
            conn.execute(
                """INSERT INTO integration_audit_events(module, event_type, entity_type, entity_id, status, summary, payload_json)
                   VALUES ('search_hub', 'cross_project_overwrite_blocked', 'content', ?, 'protected', ?, ?)""",
                (
                    str(cid),
                    f"已阻断项目#{project_id}覆盖项目#{owner_pid}的作品历史关联（仅刷新客观指标）",
                    json.dumps({"owner_project_id": owner_pid, "incoming_project_id": project_id, "incoming_keyword_id": keyword_id}, ensure_ascii=False),
                ),
            )
            conn.execute(
                """INSERT OR IGNORE INTO project_content_links(
                       project_id, content_id, keyword_text, platform, data_source, availability_status
                   ) VALUES (?, ?, ?, ?, 'manual_collect_cross_project', 'ok')""",
                (project_id, cid, reason or "跨项目收录", meta["platform"]),
            )
            return {
                "id": cid,
                "dedup": True,
                "cross_project_protected": True,
                "cross_project_linked": True,
                "owner_project_id": owner_pid,
                "warning": f"该作品已归属项目 #{owner_pid}，已为项目 #{project_id} 建立独立多项目发现关联（未覆盖原项目历史归属，已刷新最新指标）",
            }

        # 同项目重复收录：仅当旧 keyword_id 为空时才补写，不覆盖已有历史关联
        conn.execute(
            """UPDATE contents SET
               keyword_id = COALESCE(keyword_id, ?),
               creator_id = COALESCE(?, creator_id),
               view_count = COALESCE(?, view_count),
               like_count = COALESCE(?, like_count),
               comment_count = COALESCE(?, comment_count),
               views_to_followers = COALESCE(?, views_to_followers),
               outlier_score = COALESCE(?, outlier_score)
               WHERE id = ?""",
            (
                keyword_id, creator_id, meta.get("view_count"), meta.get("like_count"),
                meta.get("comment_count"), meta.get("views_to_followers"), meta.get("outlier_score"),
                cid,
            ),
        )
        return {"id": cid, "dedup": True, "cross_project_protected": False, "warning": meta.get("meta_warning", "")}

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
    only_transcript_collected: bool = False,
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
    if only_transcript_collected:
        sql += " AND (COALESCE(c.manual_transcript_collected, 0) = 1 OR t.id IS NOT NULL)"
    if project_id:
        sql += " AND (c.project_id = ? OR c.project_id IS NULL OR EXISTS (SELECT 1 FROM project_content_links pcl WHERE pcl.content_id = c.id AND pcl.project_id = ?))"
        params.extend([project_id, project_id])
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
    # GCW-ASSET-02: 用户主动发起文案提取时，自动将该作品人工收录至文案工坊
    conn.execute("UPDATE contents SET manual_transcript_collected = 1 WHERE id = ?", (cid,))
    conn.commit()
    cookie_browser = _get_setting(conn, "cookie_browser", "none")
    res = extract_transcript_pipeline(c["platform"], c["platform_item_id"], c["url"], cookie_browser=cookie_browser)

    seg_json = json.dumps(res.get("segments") or [], ensure_ascii=False)
    conn.execute(
        """INSERT INTO transcripts(content_id, extract_method, language, raw_text, segments_json,
                                   video_duration_sec, subtitle_coverage_start, subtitle_coverage_end,
                                   extract_error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(content_id) DO UPDATE SET
             extract_method=CASE WHEN length(excluded.raw_text)>0 THEN excluded.extract_method ELSE transcripts.extract_method END,
             language=CASE WHEN length(excluded.raw_text)>0 THEN excluded.language ELSE transcripts.language END,
             raw_text=CASE WHEN length(excluded.raw_text)>0 THEN excluded.raw_text ELSE transcripts.raw_text END,
             segments_json=CASE WHEN length(excluded.raw_text)>0 THEN excluded.segments_json ELSE transcripts.segments_json END,
             video_duration_sec=COALESCE(excluded.video_duration_sec, transcripts.video_duration_sec),
             subtitle_coverage_start=COALESCE(excluded.subtitle_coverage_start, transcripts.subtitle_coverage_start),
             subtitle_coverage_end=COALESCE(excluded.subtitle_coverage_end, transcripts.subtitle_coverage_end),
             extract_error=excluded.extract_error,
             updated_at=CURRENT_TIMESTAMP""",
        (
            cid,
            res["extract_method"],
            res["language"],
            res["raw_text"],
            seg_json,
            c["duration_sec"],
            res.get("subtitle_coverage_start"),
            res.get("subtitle_coverage_end"),
            res["error"],
        ),
    )
    if res["ok"]:
        conn.execute("UPDATE contents SET status = 'extracted', manual_transcript_collected = 1 WHERE id = ? AND status IN ('inbox','useful')", (cid,))
    conn.commit()
    t = dict(conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone())
    conn.close()
    return {"ok": res["ok"], "error": res["error"], "transcript": t, "content_id": cid}


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
def api_translate_transcript(cid: int, force_retranslate: bool = Query(False), engine_id: Optional[str] = Query(None)):
    """GCW-TRANS-01 统一翻译入口：带时间轴视频优先走统一 TranslationProvider 分批上下文翻译并缓存落库；
    纯文章/无时间轴文本回退整篇翻译，彻底消除两套割裂翻译链。"""
    conn = get_conn()
    t = conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone()
    conn.close()
    if not t or not (t["raw_text"] or "").strip():
        raise HTTPException(400, "原文为空，请先提取或粘贴原文。")
    segs = json.loads(t["segments_json"] or "[]")
    if segs:
        try:
            sub = translate_content_segments(
                content_id=cid,
                target_lang="zh-CN",
                engine_id=engine_id,
                force_retranslate=force_retranslate,
            )
            return {
                "ok": True,
                "translated_text": sub.get("translated_zh", ""),
                "translated_count": sub.get("translated_count", 0),
                "total_count": sub.get("total_count", 0),
                "cache_hit": sub.get("cache_hit", False),
                "engine_id": sub.get("engine_id", ""),
                "model_id": sub.get("model_id", ""),
                "message": sub.get("message", ""),
                "subtitles": sub,
            }
        except PermissionError as e:
            raise HTTPException(402, str(e))
        except Exception as e:
            raise HTTPException(400, str(e))

    # 无时间轴纯文章回退
    try:
        res = translate_with_llm(t["raw_text"])
    except Exception as e:
        raise HTTPException(400, str(e))
    conn = get_conn()
    conn.execute(
        "UPDATE transcripts SET translated_zh = ?, updated_at = CURRENT_TIMESTAMP WHERE content_id = ?",
        (res["translated_text"], cid),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "translated_text": res["translated_text"]}
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


# ==================== 优化①：热力高光 + 强锚定爆款拆解 + 个人金句库 ====================
@app.post("/api/analysis/heatmap/{cid}")
def api_heatmap(cid: int):
    conn = get_conn()
    c = conn.execute("SELECT * FROM contents WHERE id = ?", (cid,)).fetchone()
    if not c:
        conn.close()
        raise HTTPException(404, "未找到该素材")
    if c["platform"] != "youtube":
        conn.close()
        return {"ok": False, "highlights": [], "message": "目前仅 YouTube 提供公开最多重播热力图（Most Replayed）。"}
    t = conn.execute("SELECT segments_json FROM transcripts WHERE content_id = ?", (cid,)).fetchone()
    segs = json.loads(t["segments_json"]) if (t and t["segments_json"]) else []
    res = fetch_youtube_heatmap_highlights(c["url"], segments=segs)
    if res["ok"]:
        conn.execute(
            """INSERT INTO transcripts(content_id, heatmap_json, updated_at)
               VALUES (?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(content_id) DO UPDATE SET heatmap_json=excluded.heatmap_json, updated_at=CURRENT_TIMESTAMP""",
            (cid, json.dumps(res["highlights"], ensure_ascii=False)),
        )
        conn.commit()
    conn.close()
    return res


@app.post("/api/analysis/heatmap/{cid}/translate")
def api_translate_heatmap(cid: int):
    """按次批量多语言翻译热力高光片段，并写回本地缓存。"""
    conn = get_conn()
    t = conn.execute("SELECT heatmap_json FROM transcripts WHERE content_id = ?", (cid,)).fetchone()
    if not t or not t["heatmap_json"]:
        conn.close()
        raise HTTPException(400, "尚未拉取热力高光，请先点击拉取热力高光。")
    highlights = json.loads(t["heatmap_json"])
    texts = [h.get("snippet", "") for h in highlights]
    try:
        tr = translate_batch_with_llm(texts)
    except Exception as e:
        conn.close()
        raise HTTPException(400, str(e))
    for h, r in zip(highlights, tr["results"]):
        h["lang"] = r.get("lang", "")
        h["snippet_zh"] = r.get("zh", "")
    conn.execute(
        "UPDATE transcripts SET heatmap_json = ?, updated_at = CURRENT_TIMESTAMP WHERE content_id = ?",
        (json.dumps(highlights, ensure_ascii=False), cid),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "highlights": highlights, "model": tr["model"], "total_tokens": tr["total_tokens"]}


@app.post("/api/analysis/breakdown/{cid}")
def api_breakdown(cid: int):
    conn = get_conn()
    c = conn.execute("SELECT * FROM contents WHERE id = ?", (cid,)).fetchone()
    t = conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone()
    if not c or not t or not (t["raw_text"] or "").strip():
        conn.close()
        raise HTTPException(400, "请先提取或粘贴原文，再执行强锚定爆款拆解。")
    try:
        data = run_anchored_breakdown(t["raw_text"], title=c["title"] or "")
    except Exception as e:
        conn.close()
        raise HTTPException(400, str(e))
    conn.execute(
        "UPDATE transcripts SET breakdown_json = ?, updated_at = CURRENT_TIMESTAMP WHERE content_id = ?",
        (json.dumps(data, ensure_ascii=False), cid),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "breakdown": data}


@app.get("/api/quotes")
def api_list_quotes(q: Optional[str] = None):
    conn = get_conn()
    if q:
        like = f"%{q}%"
        rows = conn.execute("SELECT * FROM quotes WHERE quote_text LIKE ? OR category LIKE ? OR note LIKE ? ORDER BY id DESC", (like, like, like)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM quotes ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


class QuoteCreate(BaseModel):
    content_id: Optional[int] = None
    quote_text: str
    category: str = "金句"
    timestamp_sec: Optional[float] = None
    source_url: str = ""
    note: str = ""


@app.post("/api/quotes")
def api_add_quote(body: QuoteCreate):
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO quotes(content_id, quote_text, category, timestamp_sec, source_url, note) VALUES (?, ?, ?, ?, ?, ?)",
        (body.content_id, body.quote_text.strip(), body.category, body.timestamp_sec, body.source_url, body.note),
    )
    conn.commit()
    row = dict(conn.execute("SELECT * FROM quotes WHERE id = ?", (cur.lastrowid,)).fetchone())
    conn.close()
    return row


@app.delete("/api/quotes/{qid}")
def api_del_quote(qid: int):
    conn = get_conn()
    conn.execute("DELETE FROM quotes WHERE id = ?", (qid,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ==================== 优化②：合规真实素材搜索 + 授权台账 ====================
@app.get("/api/assets/search")
def api_search_assets(q: str = Query(..., min_length=1), source: str = Query("all")):
    return search_real_assets(q.strip(), source=source)


@app.get("/api/assets/saved/{cid}")
def api_list_saved_assets(cid: int):
    conn = get_conn()
    rows = [dict(r) for r in conn.execute("SELECT * FROM media_assets WHERE content_id = ? ORDER BY id DESC", (cid,)).fetchall()]
    conn.close()
    return rows


class AssetSave(BaseModel):
    content_id: int
    source: str
    asset_type: str = "image"
    title: str = ""
    thumb_url: str = ""
    asset_url: str
    source_page_url: str = ""
    author: str = ""
    license: str = ""
    commercial_ok: str = "需核实"
    segment_note: str = ""


@app.post("/api/assets/saved")
def api_save_asset(body: AssetSave):
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO media_assets
           (content_id, source, asset_type, title, thumb_url, asset_url, source_page_url, author, license, commercial_ok, segment_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            body.content_id, body.source, body.asset_type, body.title, body.thumb_url,
            body.asset_url, body.source_page_url, body.author, body.license, body.commercial_ok, body.segment_note,
        ),
    )
    conn.commit()
    row = dict(conn.execute("SELECT * FROM media_assets WHERE id = ?", (cur.lastrowid,)).fetchone())
    conn.close()
    return row


@app.delete("/api/assets/saved/{aid}")
def api_del_asset(aid: int):
    conn = get_conn()
    conn.execute("DELETE FROM media_assets WHERE id = ?", (aid,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ==================== 优化③：高赞评论拉取与 0-Token 痛点词频 ====================
@app.get("/api/comments/{cid}")
def api_list_comments(cid: int, only_questions: bool = Query(False)):
    conn = get_conn()
    sql = "SELECT * FROM comments WHERE content_id = ?"
    if only_questions:
        sql += " AND is_question = 1"
    sql += " ORDER BY is_pain_point DESC, like_count DESC"
    rows = [dict(r) for r in conn.execute(sql, (cid,)).fetchall()]
    conn.close()
    return {"comments": rows, "top_keywords": summarize_comment_keywords(rows)}


@app.post("/api/comments/fetch/{cid}")
def api_fetch_comments(cid: int, max_comments: int = Query(50)):
    conn = get_conn()
    c = conn.execute("SELECT * FROM contents WHERE id = ?", (cid,)).fetchone()
    if not c:
        conn.close()
        raise HTTPException(404, "未找到该素材")
    try:
        items = fetch_video_comments(c["url"], max_comments=min(max_comments, 80))
    except Exception as e:
        conn.close()
        raise HTTPException(400, f"评论拉取失败（仅 YouTube 等公开评论接口支持免登拉取）：{str(e)[:150]}")
    for it in items:
        conn.execute(
            """INSERT OR IGNORE INTO comments(content_id, platform_comment_id, author, text, like_count, is_question)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (cid, it["platform_comment_id"], it["author"], it["text"], it["like_count"], it["is_question"]),
        )
    conn.commit()
    rows = [dict(r) for r in conn.execute("SELECT * FROM comments WHERE content_id = ? ORDER BY is_pain_point DESC, like_count DESC", (cid,)).fetchall()]
    conn.close()
    return {"ok": True, "fetched": len(items), "comments": rows, "top_keywords": summarize_comment_keywords(rows)}


@app.patch("/api/comments/{comment_id}/pain")
def api_toggle_pain_comment(comment_id: int, is_pain_point: int = Query(1)):
    conn = get_conn()
    conn.execute("UPDATE comments SET is_pain_point = ? WHERE id = ?", (is_pain_point, comment_id))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/comments/{cid}/translate")
def api_translate_comments(cid: int, limit: int = Query(30)):
    """按次批量多语言翻译前 N 条尚未翻译的高赞评论并落库缓存。"""
    conn = get_conn()
    targets = conn.execute(
        """SELECT id, text FROM comments
           WHERE content_id = ? AND length(coalesce(translated_zh,'')) = 0
           ORDER BY is_pain_point DESC, like_count DESC LIMIT ?""",
        (cid, min(limit, 40)),
    ).fetchall()
    if not targets:
        rows = [dict(r) for r in conn.execute("SELECT * FROM comments WHERE content_id = ? ORDER BY is_pain_point DESC, like_count DESC", (cid,)).fetchall()]
        conn.close()
        return {"ok": True, "translated_count": 0, "comments": rows, "message": "前 30 条高赞评论均已翻译过（已命中缓存，0 Token）。"}
    try:
        tr = translate_batch_with_llm([r["text"] for r in targets])
    except Exception as e:
        conn.close()
        raise HTTPException(400, str(e))
    for row, res in zip(targets, tr["results"]):
        zh = res.get("zh", "")
        lang = res.get("lang", "")
        val = f"[{lang}] {zh}" if (lang and zh) else zh
        conn.execute("UPDATE comments SET translated_zh = ? WHERE id = ?", (val, row["id"]))
    conn.commit()
    rows = [dict(r) for r in conn.execute("SELECT * FROM comments WHERE content_id = ? ORDER BY is_pain_point DESC, like_count DESC", (cid,)).fetchall()]
    conn.close()
    return {
        "ok": True,
        "translated_count": len(targets),
        "model": tr["model"],
        "total_tokens": tr["total_tokens"],
        "comments": rows,
    }


# ==================== 下游视频渲染交接包（可直接交给独立 Remotion + Skills 工作区） ====================
@app.get("/api/export/handoff/{cid}")
def api_export_video_handoff(cid: int):
    conn = get_conn()
    c = conn.execute("SELECT c.*, cr.name AS creator_name FROM contents c LEFT JOIN creators cr ON cr.id = c.creator_id WHERE c.id = ?", (cid,)).fetchone()
    if not c:
        conn.close()
        raise HTTPException(404, "未找到素材")
    t = conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (cid,)).fetchone()
    assets = [dict(r) for r in conn.execute("SELECT * FROM media_assets WHERE content_id = ? ORDER BY id", (cid,)).fetchall()]
    pain_comments = [dict(r) for r in conn.execute("SELECT author, text, like_count FROM comments WHERE content_id = ? AND (is_pain_point=1 OR is_question=1) ORDER BY like_count DESC LIMIT 15", (cid,)).fetchall()]
    conn.close()
    pkg = {
        "schema": "global-content-workbench/video-handoff-v1",
        "source_content": dict(c),
        "my_script_draft": (t["my_draft_text"] if t else "") or "",
        "hook_analysis": (t["hook_analysis"] if t else "") or "",
        "script_template": (t["script_template_type"] if t else "") or "",
        "authorized_media_assets": assets,
        "audience_pain_comments": pain_comments,
    }
    return StreamingResponse(
        io.BytesIO(json.dumps(pkg, ensure_ascii=False, indent=2).encode("utf-8")),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="video_handoff_{cid}.json"'},
    )
