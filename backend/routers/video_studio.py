"""G1 智能视频制作 REST API 路由（A01–A16）。"""
from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.db import get_conn
from backend.services.overlay_adapter import (
    DEFAULT_SFX_CATALOG,
    EFFECT_CATALOG,
    OVERLAY_ENGINE_ROOT,
    VALID_EFFECT_IDS,
    VIDEO_CUSTOM_SFX_DIR,
    VIDEO_EXPORTS_DIR,
    VIDEO_STORAGE_DIR,
    VIDEO_UPLOADS_DIR,
    cancel_overlay_render_job,
    check_overlay_engine_health,
    compile_overlay_from_srt,
    compute_overlay_diff,
    execute_overlay_render_job,
    lint_overlay_doc,
    parse_srt_text,
    run_ffprobe,
    safe_filename,
    segments_to_srt,
    sha256_text,
)

router = APIRouter(prefix="/api/video", tags=["VideoStudio-G1"])


def _audit(conn, event_type: str, entity_type: str, entity_id: str, status: str, summary: str, payload: Any = None):
    conn.execute(
        """INSERT INTO integration_audit_events(module, event_type, entity_type, entity_id, status, summary, payload_json)
           VALUES ('video_studio', ?, ?, ?, ?, ?, ?)""",
        (event_type, entity_type, str(entity_id), status, summary, json.dumps(payload or {}, ensure_ascii=False)),
    )


@router.get("/capabilities")
def api_video_capabilities():
    """返回独立 Overlay Studio 引擎健康状态、25 张动效卡完整原生控件目录、15 个默认音效授权清单。"""
    health = check_overlay_engine_health()
    conn = get_conn()
    custom_sfx = [dict(r) for r in conn.execute("SELECT * FROM video_custom_sfx ORDER BY id DESC").fetchall()]
    conn.close()
    thumbs_dir = VIDEO_STORAGE_DIR / "effect_thumbs"
    meta_file = Path(__file__).resolve().parent.parent / "services" / "overlay_controls_meta.json"
    controls_meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
    effects_with_thumb = [
        {
            **e,
            "thumb_url": f"/api/video/thumbs/{e['id']}.png" if (thumbs_dir / f"{e['id']}.png").exists() else None,
            "controls": (controls_meta.get(e["id"]) or {}).get("controls", []),
            "layout_mode": (controls_meta.get(e["id"]) or {}).get("layout_mode", "position"),
        }
        for e in EFFECT_CATALOG
    ]
    return {
        "engine": health,
        "effects": effects_with_thumb,
        "default_sfx": DEFAULT_SFX_CATALOG,
        "custom_sfx": custom_sfx,
    }


@router.get("/thumbs/{effect_id}.png")
def api_get_effect_thumb(effect_id: str):
    """返回由本地 Overlay Studio 真实渲染生成的动效卡缩略图。"""
    if effect_id not in VALID_EFFECT_IDS:
        raise HTTPException(404, "未知动效卡")
    p = (VIDEO_STORAGE_DIR / "effect_thumbs" / f"{effect_id}.png").resolve()
    if not p.exists():
        raise HTTPException(404, "缩略图尚未生成")
    return FileResponse(p, media_type="image/png")


@router.get("/demo")
def api_get_demo_overlay():
    """读取本地 Overlay Studio 官方内置示例工程（demo-overlay.json + demo.srt），供一键体验。"""
    demo_dir = OVERLAY_ENGINE_ROOT / "public" / "demo"
    doc_file = demo_dir / "demo-overlay.json"
    srt_file = demo_dir / "demo.srt"
    if not doc_file.exists():
        raise HTTPException(404, "未找到官方示例文件 demo-overlay.json")
    doc = json.loads(doc_file.read_text(encoding="utf-8"))
    srt_text = srt_file.read_text(encoding="utf-8") if srt_file.exists() else ""
    srt_lines = parse_srt_text(srt_text) if srt_text else []
    if srt_lines and not doc.get("srt"):
        doc["srt"] = [{"start": x["start"], "end": x["end"], "text": x["text"]} for x in srt_lines]
    return {"ok": True, "doc": doc, "srt_text": srt_text, "line_count": len(srt_lines)}


class VideoProjectCreate(BaseModel):
    project_id: int = 1
    topic_id: Optional[int] = None
    content_id: Optional[int] = None
    transcript_id: Optional[int] = None
    title: str
    aspect_ratio: str = "16:9"
    fps: float = 30
    theme: str = "dark"


@router.get("/projects")
def api_list_video_projects(project_id: Optional[int] = Query(None)):
    conn = get_conn()
    if project_id:
        rows = conn.execute("SELECT * FROM video_projects WHERE project_id = ? ORDER BY updated_at DESC, id DESC", (project_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM video_projects ORDER BY updated_at DESC, id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("/projects")
def api_create_video_project(body: VideoProjectCreate):
    if body.aspect_ratio not in ("16:9", "9:16", "4:3"):
        raise HTTPException(400, "aspect_ratio 仅支持 16:9 / 9:16 / 4:3")
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO video_projects(project_id, topic_id, content_id, transcript_id, title, aspect_ratio, fps, theme)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (body.project_id, body.topic_id, body.content_id, body.transcript_id, body.title.strip() or "未命名视频工程", body.aspect_ratio, body.fps, body.theme),
    )
    vid = cur.lastrowid
    _audit(conn, "project_created", "video_project", str(vid), "ok", f"新建视频工程：{body.title}")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone())
    conn.close()
    return row


@router.get("/projects/{vid}")
def api_get_video_project(vid: int):
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")
    versions = [dict(r) for r in conn.execute("SELECT id, version_no, schema_version, source_type, checksum, note, created_at FROM video_render_versions WHERE video_project_id = ? ORDER BY version_no DESC", (vid,)).fetchall()]
    jobs = [dict(r) for r in conn.execute("SELECT * FROM render_jobs WHERE video_project_id = ? ORDER BY id DESC LIMIT 20", (vid,)).fetchall()]
    conn.close()
    return {"project": dict(proj), "versions": versions, "render_jobs": jobs}


class VideoProjectPatch(BaseModel):
    title: Optional[str] = None
    aspect_ratio: Optional[str] = None
    fps: Optional[float] = None
    theme: Optional[str] = None
    draft_overlay_json: Optional[str] = None


@router.patch("/projects/{vid}")
def api_patch_video_project(vid: int, body: VideoProjectPatch):
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")
    fields = []
    vals: list[Any] = []
    if body.title is not None:
        fields.append("title = ?")
        vals.append(body.title.strip())
    if body.aspect_ratio is not None:
        if body.aspect_ratio not in ("16:9", "9:16", "4:3"):
            conn.close()
            raise HTTPException(400, "aspect_ratio 仅支持 16:9 / 9:16 / 4:3")
        fields.append("aspect_ratio = ?")
        vals.append(body.aspect_ratio)
    if body.fps is not None:
        fields.append("fps = ?")
        vals.append(body.fps)
    if body.theme is not None:
        fields.append("theme = ?")
        vals.append(body.theme)
    if body.draft_overlay_json is not None:
        fields.append("draft_overlay_json = ?")
        vals.append(body.draft_overlay_json)
    if fields:
        fields.append("updated_at = CURRENT_TIMESTAMP")
        vals.append(vid)
        conn.execute(f"UPDATE video_projects SET {', '.join(fields)} WHERE id = ?", vals)
        conn.commit()
    row = dict(conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone())
    conn.close()
    return row


@router.delete("/projects/{vid}")
def api_delete_video_project(vid: int):
    conn = get_conn()
    conn.execute("DELETE FROM video_projects WHERE id = ?", (vid,))
    conn.commit()
    conn.close()
    return {"ok": True}


class SrtImportBody(BaseModel):
    srt_text: Optional[str] = None
    content_id: Optional[int] = None


@router.post("/projects/{vid}/import-srt")
def api_import_srt(vid: int, body: SrtImportBody):
    """A01：导入 SRT 字幕文本，或从现有文案提取工坊（transcripts）一键导入真实时间码。"""
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")

    srt_text = (body.srt_text or "").strip()
    lines: list[dict[str, Any]] = []
    linked_cid = body.content_id or proj["content_id"]
    linked_tid = proj["transcript_id"]

    if not srt_text and linked_cid:
        tr = conn.execute("SELECT * FROM transcripts WHERE content_id = ?", (linked_cid,)).fetchone()
        if not tr:
            conn.close()
            raise HTTPException(400, "该素材尚未提取文案，请先在「文案提取工坊」完成提取")
        linked_tid = tr["id"]
        segs = []
        if tr["segments_json"]:
            try:
                segs = json.loads(tr["segments_json"])
            except Exception:
                segs = []
        srt_text, lines = segments_to_srt(segs, (tr["my_draft_text"] or tr["raw_text"] or ""))
    elif srt_text:
        lines = parse_srt_text(srt_text)
    else:
        conn.close()
        raise HTTPException(400, "请提供 srt_text 或选择已提取文案的素材 content_id")

    if not lines:
        conn.close()
        raise HTTPException(400, "未解析出有效 SRT 字幕行，请检查时间码格式（00:00:00,000 --> 00:00:03,000）")

    dur_ms = int(round(max(x["end"] for x in lines) * 1000))
    conn.execute(
        """UPDATE video_projects
           SET srt_text = ?, srt_json = ?, duration_ms = ?, content_id = ?, transcript_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?""",
        (srt_text, json.dumps(lines, ensure_ascii=False), dur_ms, linked_cid, linked_tid, vid),
    )
    _audit(conn, "srt_imported", "video_project", str(vid), "ok", f"导入 {len(lines)} 条字幕，总时长 {dur_ms/1000:.1f}s")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone())
    conn.close()
    return {"ok": True, "line_count": len(lines), "duration_ms": dur_ms, "lines": lines, "project": row}


@router.post("/projects/{vid}/upload-video")
async def api_upload_reference_video(vid: int, file: UploadFile = File(...)):
    """A05/A11：上传本地 H.264 参考视频（仅保存至受控目录，防路径穿越）。"""
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")
    try:
        fname = safe_filename(file.filename or "ref.mp4", {".mp4", ".mov", ".webm", ".m4v"})
    except ValueError as e:
        conn.close()
        raise HTTPException(400, str(e))

    dst = VIDEO_UPLOADS_DIR / f"vp_{vid}_{fname}"
    raw = await file.read()
    if len(raw) > 500 * 1024 * 1024:
        conn.close()
        raise HTTPException(400, "参考视频大小不能超过 500MB")
    dst.write_bytes(raw)
    rel = str(dst.relative_to(VIDEO_UPLOADS_DIR))
    conn.execute("UPDATE video_projects SET reference_video_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (rel, vid))
    _audit(conn, "reference_video_uploaded", "video_project", str(vid), "ok", f"上传参考视频 {rel}")
    conn.commit()
    conn.close()
    return {"ok": True, "reference_video_path": rel, "stream_url": f"/api/video/projects/{vid}/reference-video"}


@router.get("/projects/{vid}/reference-video")
def api_stream_reference_video(vid: int):
    conn = get_conn()
    proj = conn.execute("SELECT reference_video_path FROM video_projects WHERE id = ?", (vid,)).fetchone()
    conn.close()
    if not proj or not proj["reference_video_path"]:
        raise HTTPException(404, "该工程尚未上传参考视频")
    target = (VIDEO_UPLOADS_DIR / proj["reference_video_path"]).resolve()
    if not str(target).startswith(str(VIDEO_UPLOADS_DIR.resolve())) or not target.exists():
        raise HTTPException(404, "参考视频文件不存在")
    return FileResponse(target, media_type="video/mp4")


class CompileBody(BaseModel):
    use_llm: bool = True


@router.post("/projects/{vid}/compile")
def api_compile_overlay(vid: int, body: CompileBody):
    """A01+A04：基于真实 SRT 与已批准偏好规则自动编排动效并生成不可变草稿版本。"""
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")
    if not proj["srt_json"]:
        conn.close()
        raise HTTPException(400, "请先导入 SRT 字幕后再执行 AI 编排")

    srt_lines = json.loads(proj["srt_json"])
    approved = [
        r["proposed_rule"]
        for r in conn.execute(
            "SELECT proposed_rule FROM editor_feedback_rules WHERE project_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 10",
            (proj["project_id"],),
        ).fetchall()
    ]
    res = compile_overlay_from_srt(
        srt_lines=srt_lines,
        aspect_ratio=proj["aspect_ratio"] or "16:9",
        theme=proj["theme"] or "dark",
        approved_rules=approved,
        use_llm=body.use_llm,
    )
    doc = res["doc"]
    lint_res = lint_overlay_doc(doc, duration_sec=res["duration_ms"] / 1000.0)
    doc_str = json.dumps(doc, ensure_ascii=False)
    checksum = sha256_text(doc_str)

    max_v = conn.execute("SELECT COALESCE(MAX(version_no), 0) FROM video_render_versions WHERE video_project_id = ?", (vid,)).fetchone()[0]
    cur = conn.execute(
        """INSERT INTO video_render_versions(video_project_id, version_no, source_type, overlay_json, checksum, note)
           VALUES (?, ?, 'ai_compile', ?, ?, ?)""",
        (vid, max_v + 1, doc_str, checksum, f"AI 编排（模型：{res['meta'].get('model') or '规则引擎'}）"),
    )
    ver_id = cur.lastrowid
    conn.execute(
        """UPDATE video_projects
           SET draft_overlay_json = ?, current_version_id = ?, lint_summary_json = ?, duration_ms = ?, status = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?""",
        (doc_str, ver_id, json.dumps(lint_res, ensure_ascii=False), res["duration_ms"], "lint_passed" if lint_res["passed"] else "compiled", vid),
    )
    _audit(conn, "overlay_compiled", "video_project", str(vid), "ok", f"生成版本 v{max_v + 1}，共 {len(doc['cards'])} 张卡", res["meta"])
    conn.commit()
    conn.close()
    return {"ok": True, "version_id": ver_id, "version_no": max_v + 1, "doc": doc, "lint": lint_res, "meta": res["meta"]}


class LintBody(BaseModel):
    doc: Optional[dict[str, Any]] = None


@router.post("/projects/{vid}/lint")
def api_lint_overlay(vid: int, body: LintBody):
    """A13：编排质量检查（纯检查不修改原稿）。"""
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")
    doc = body.doc
    if doc is None:
        if not proj["draft_overlay_json"]:
            conn.close()
            raise HTTPException(400, "当前工程尚未生成动效编排")
        doc = json.loads(proj["draft_overlay_json"])
    lint_res = lint_overlay_doc(doc, duration_sec=(proj["duration_ms"] or 0) / 1000.0)
    conn.execute("UPDATE video_projects SET lint_summary_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (json.dumps(lint_res, ensure_ascii=False), vid))
    conn.commit()
    conn.close()
    return lint_res


class SaveVersionBody(BaseModel):
    doc: dict[str, Any]
    note: str = "手动保存版本"
    source_type: str = "manual_edit"


@router.put("/projects/{vid}/versions")
def api_save_overlay_version(vid: int, body: SaveVersionBody):
    """A14：保存不可变版本快照（不覆盖旧档，支持随时恢复）。"""
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")
    doc_str = json.dumps(body.doc, ensure_ascii=False)
    checksum = sha256_text(doc_str)
    lint_res = lint_overlay_doc(body.doc, duration_sec=(proj["duration_ms"] or 0) / 1000.0)
    max_v = conn.execute("SELECT COALESCE(MAX(version_no), 0) FROM video_render_versions WHERE video_project_id = ?", (vid,)).fetchone()[0]
    cur = conn.execute(
        """INSERT INTO video_render_versions(video_project_id, version_no, source_type, overlay_json, checksum, note)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (vid, max_v + 1, body.source_type, doc_str, checksum, body.note),
    )
    ver_id = cur.lastrowid
    conn.execute(
        """UPDATE video_projects
           SET draft_overlay_json = ?, current_version_id = ?, lint_summary_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?""",
        (doc_str, ver_id, json.dumps(lint_res, ensure_ascii=False), vid),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "version_id": ver_id, "version_no": max_v + 1, "checksum": checksum, "lint": lint_res}


@router.post("/projects/{vid}/versions/{ver_id}/restore")
def api_restore_overlay_version(vid: int, ver_id: int):
    """A14：恢复到指定历史不可变版本。"""
    conn = get_conn()
    ver = conn.execute("SELECT * FROM video_render_versions WHERE id = ? AND video_project_id = ?", (ver_id, vid)).fetchone()
    if not ver:
        conn.close()
        raise HTTPException(404, "未找到指定版本")
    doc = json.loads(ver["overlay_json"])
    lint_res = lint_overlay_doc(doc)
    conn.execute(
        """UPDATE video_projects
           SET draft_overlay_json = ?, current_version_id = ?, lint_summary_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?""",
        (ver["overlay_json"], ver_id, json.dumps(lint_res, ensure_ascii=False), vid),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "restored_version_no": ver["version_no"], "doc": doc, "lint": lint_res}


class FeedbackBody(BaseModel):
    original_version_id: Optional[int] = None
    edited_version_id: Optional[int] = None
    custom_rule_text: Optional[str] = None


@router.post("/projects/{vid}/feedback")
def api_create_feedback_rule(vid: int, body: FeedbackBody):
    """A16：比对 AI 草稿与人工修改版本差异，生成待人工批准的偏好规则（绝不训练模型）。"""
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")

    orig_ver = (
        conn.execute("SELECT * FROM video_render_versions WHERE id = ?", (body.original_version_id,)).fetchone()
        if body.original_version_id
        else conn.execute("SELECT * FROM video_render_versions WHERE video_project_id = ? AND source_type = 'ai_compile' ORDER BY version_no ASC LIMIT 1", (vid,)).fetchone()
    )
    edit_ver = (
        conn.execute("SELECT * FROM video_render_versions WHERE id = ?", (body.edited_version_id,)).fetchone()
        if body.edited_version_id
        else conn.execute("SELECT * FROM video_render_versions WHERE video_project_id = ? ORDER BY version_no DESC LIMIT 1", (vid,)).fetchone()
    )
    if not orig_ver or not edit_ver:
        conn.close()
        raise HTTPException(400, "至少需要 AI 编排草稿与一次人工保存版本才能生成差异学习规则")

    diff = compute_overlay_diff(json.loads(orig_ver["overlay_json"]), json.loads(edit_ver["overlay_json"]))
    rule_text = (body.custom_rule_text or "").strip() or diff["proposed_rule"]
    cur = conn.execute(
        """INSERT INTO editor_feedback_rules(project_id, video_project_id, original_version_id, edited_version_id, diff_json, proposed_rule, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')""",
        (proj["project_id"], vid, orig_ver["id"], edit_ver["id"], json.dumps(diff, ensure_ascii=False), rule_text),
    )
    rid = cur.lastrowid
    _audit(conn, "feedback_proposed", "feedback_rule", str(rid), "pending", rule_text)
    conn.commit()
    row = dict(conn.execute("SELECT * FROM editor_feedback_rules WHERE id = ?", (rid,)).fetchone())
    conn.close()
    return {"ok": True, "rule": row, "diff": diff}


@router.get("/feedback-rules")
def api_list_feedback_rules(project_id: Optional[int] = Query(None)):
    conn = get_conn()
    if project_id:
        rows = conn.execute("SELECT * FROM editor_feedback_rules WHERE project_id = ? ORDER BY id DESC", (project_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM editor_feedback_rules ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


class RuleStatusBody(BaseModel):
    status: str  # approved / revoked / pending
    proposed_rule: Optional[str] = None


@router.patch("/feedback-rules/{rid}")
def api_patch_feedback_rule(rid: int, body: RuleStatusBody):
    if body.status not in ("approved", "revoked", "pending"):
        raise HTTPException(400, "status 仅支持 approved / revoked / pending")
    conn = get_conn()
    if body.proposed_rule is not None:
        conn.execute(
            "UPDATE editor_feedback_rules SET status = ?, proposed_rule = ?, approved_by = CASE WHEN ?='approved' THEN 'user' ELSE approved_by END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (body.status, body.proposed_rule.strip(), body.status, rid),
        )
    else:
        conn.execute(
            "UPDATE editor_feedback_rules SET status = ?, approved_by = CASE WHEN ?='approved' THEN 'user' ELSE approved_by END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (body.status, body.status, rid),
        )
    conn.commit()
    row = conn.execute("SELECT * FROM editor_feedback_rules WHERE id = ?", (rid,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "未找到偏好规则")
    return dict(row)


@router.post("/sfx/upload")
async def api_upload_custom_sfx(
    project_id: int = Form(1),
    name: str = Form(...),
    license_note: str = Form(...),
    source_note: str = Form(""),
    file: UploadFile = File(...),
):
    """A10：上传本地授权自定义音效，记录权属来源，严格拦截非法格式与越界路径。"""
    if not license_note.strip():
        raise HTTPException(400, "必须填写音效授权说明（license_note）")
    try:
        fname = safe_filename(file.filename or "sfx.mp3", {".mp3", ".wav", ".ogg", ".m4a"})
    except ValueError as e:
        raise HTTPException(400, str(e))

    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(400, "自定义音效文件不能超过 20MB")
    dst = VIDEO_CUSTOM_SFX_DIR / fname
    dst.write_bytes(raw)
    fhash = hashlib.sha256(raw).hexdigest()[:16]

    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO video_custom_sfx(project_id, name, filename, local_rel_path, file_hash, license_note, source_note)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (project_id, name.strip(), fname, fname, fhash, license_note.strip(), source_note.strip()),
    )
    sid = cur.lastrowid
    _audit(conn, "custom_sfx_added", "video_custom_sfx", str(sid), "ok", f"新增授权音效 {name} ({license_note})")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM video_custom_sfx WHERE id = ?", (sid,)).fetchone())
    conn.close()
    return row


class RenderJobCreate(BaseModel):
    video_project_id: int
    mode: str = "timeline"  # timeline / single
    effect_id: Optional[str] = None
    single_params: Optional[dict[str, Any]] = None
    include_webm: bool = True
    fps: float = 30
    duration_sec: Optional[float] = None
    compatibility_mode: bool = False
    fast_png: bool = False
    export_mode: str = "sequence"  # sequence / stream


@router.post("/render-jobs")
def api_create_render_job(body: RenderJobCreate):
    """A12/A15：发起真实透明视频渲染任务（硬错误拦截 + 单并发保护 + ffprobe 自动验收）。"""
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (body.video_project_id,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")

    doc = json.loads(proj["draft_overlay_json"]) if proj["draft_overlay_json"] else {"version": 1, "cards": []}
    if body.mode == "timeline":
        lint_res = lint_overlay_doc(doc, duration_sec=(proj["duration_ms"] or 0) / 1000.0)
        if not lint_res["passed"]:
            conn.close()
            raise HTTPException(400, f"质量检查未通过（存在 {lint_res['error_count']} 项硬错误），已阻止导出：{lint_res['errors'][0]['message']}")

    health = check_overlay_engine_health()
    if not health["reachable"]:
        conn.close()
        raise HTTPException(503, f"独立 Overlay Studio 引擎 ({health['loopback_url']}) 未启动或不可达，无法执行透明导出")

    dur = float(body.duration_sec or max(3.0, (proj["duration_ms"] or 4000) / 1000.0))
    outputs = ["mov", "webm"] if body.include_webm else ["mov"]
    job_uid = str(uuid.uuid4())
    fmt_label = "mov_webm" if body.include_webm else "mov"

    cur = conn.execute(
        """INSERT INTO render_jobs(job_uid, video_project_id, version_id, mode, effect_id, format, aspect_ratio, fps, duration_sec, state, progress, progress_message, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 2, '任务已创建，准备渲染...', CURRENT_TIMESTAMP)""",
        (job_uid, body.video_project_id, proj["current_version_id"], body.mode, body.effect_id, fmt_label, proj["aspect_ratio"] or "16:9", body.fps, dur),
    )
    jid = cur.lastrowid
    _audit(conn, "render_started", "render_job", job_uid, "running", f"发起 {body.mode} 透明导出 ({fmt_label}, {proj['aspect_ratio']})")
    conn.commit()
    conn.close()

    def _on_progress(pct: int, msg: str):
        c = get_conn()
        c.execute("UPDATE render_jobs SET progress = ?, progress_message = ? WHERE job_uid = ? AND state = 'running'", (pct, msg, job_uid))
        c.commit()
        c.close()

    def _on_complete(mov_path: Optional[str], webm_path: Optional[str], probe: dict[str, Any]):
        c = get_conn()
        c.execute(
            """UPDATE render_jobs
               SET state = 'completed', progress = 100, progress_message = '透明视频导出并校验完成',
                   output_mov_path = ?, output_webm_path = ?, ffprobe_json = ?, ended_at = CURRENT_TIMESTAMP
               WHERE job_uid = ?""",
            (mov_path, webm_path, json.dumps(probe, ensure_ascii=False), job_uid),
        )
        c.execute("UPDATE video_projects SET status = 'exported', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (body.video_project_id,))
        _audit(c, "render_completed", "render_job", job_uid, "completed", f"导出成功，Alpha={probe.get('has_alpha')}，pix_fmt={probe.get('pix_fmt')}")
        c.commit()
        c.close()

    def _on_fail(err: str, cancelled: bool = False):
        st = "cancelled" if cancelled else "failed"
        c = get_conn()
        c.execute(
            "UPDATE render_jobs SET state = ?, error_message = ?, progress_message = ?, ended_at = CURRENT_TIMESTAMP WHERE job_uid = ?",
            (st, err, err[:160], job_uid),
        )
        _audit(c, f"render_{st}", "render_job", job_uid, st, err[:200])
        c.commit()
        c.close()

    execute_overlay_render_job(
        job_uid=job_uid,
        doc=doc,
        mode=body.mode,
        effect_id=body.effect_id,
        outputs=outputs,
        fps=body.fps,
        duration_sec=dur,
        aspect_ratio=proj["aspect_ratio"] or "16:9",
        on_progress=_on_progress,
        on_complete=_on_complete,
        on_fail=_on_fail,
        single_params=body.single_params,
        compatibility_mode=body.compatibility_mode,
        fast_png=body.fast_png,
        export_mode=body.export_mode,
    )

    return {"ok": True, "id": jid, "job_uid": job_uid, "state": "running"}


@router.get("/render-jobs/{job_uid}")
def api_get_render_job(job_uid: str):
    conn = get_conn()
    row = conn.execute("SELECT * FROM render_jobs WHERE job_uid = ?", (job_uid,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "未找到渲染任务")
    return dict(row)


@router.post("/render-jobs/{job_uid}/cancel")
def api_cancel_render_job(job_uid: str):
    """A15：取消运行中的渲染任务并清理临时文件。"""
    killed = cancel_overlay_render_job(job_uid)
    conn = get_conn()
    conn.execute(
        "UPDATE render_jobs SET state = 'cancelled', progress_message = '已由用户取消', ended_at = CURRENT_TIMESTAMP WHERE job_uid = ? AND state IN ('queued','running')",
        (job_uid,),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "killed_process": killed}


@router.get("/render-jobs/{job_uid}/download")
def api_download_render_output(job_uid: str, fmt: str = Query("mov")):
    conn = get_conn()
    row = conn.execute("SELECT output_mov_path, output_webm_path FROM render_jobs WHERE job_uid = ?", (job_uid,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "未找到渲染任务")
    raw_path = row["output_webm_path"] if fmt == "webm" else row["output_mov_path"]
    if not raw_path:
        raise HTTPException(404, f"该任务没有 {fmt} 格式输出文件")
    target = Path(raw_path).resolve()
    if not str(target).startswith(str(VIDEO_EXPORTS_DIR.resolve())) or not target.exists():
        raise HTTPException(404, "输出文件不存在或路径受限")
    media_type = "video/webm" if fmt == "webm" else "video/quicktime"
    return FileResponse(target, media_type=media_type, filename=target.name)


@router.get("/engine-exports")
def api_list_engine_exports():
    """方案 B 桥接：扫描独立 Overlay Studio 引擎 exports/output 目录下最新导出的透明 MOV/WebM 产物。"""
    out_dir = OVERLAY_ENGINE_ROOT / "exports" / "output"
    items: list[dict[str, Any]] = []
    if out_dir.exists():
        files = sorted(
            [p for p in out_dir.iterdir() if p.is_file() and p.suffix.lower() in (".mov", ".webm")],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:20]
        for f in files:
            items.append({
                "name": f.name,
                "path": str(f.resolve()),
                "ext": f.suffix.lower().lstrip("."),
                "size_bytes": f.stat().st_size,
                "mtime": int(f.stat().st_mtime),
            })
    return {"ok": True, "output_dir": str(out_dir), "items": items}


class SendToPublishBody(BaseModel):
    video_file_path: Optional[str] = None
    title: Optional[str] = None


@router.post("/projects/{vid}/send-to-publish")
def api_send_video_to_publish(vid: int, body: SendToPublishBody):
    """方案 B 桥接：将当前视频工程与导出的透明/成片视频一键创建为 PublishHub 发布包。"""
    conn = get_conn()
    proj = conn.execute("SELECT * FROM video_projects WHERE id = ?", (vid,)).fetchone()
    if not proj:
        conn.close()
        raise HTTPException(404, "未找到视频工程")
    vpath = (body.video_file_path or "").strip()
    if not vpath:
        rj = conn.execute(
            "SELECT output_mov_path, output_webm_path FROM render_jobs WHERE video_project_id = ? AND state = 'completed' ORDER BY id DESC LIMIT 1",
            (vid,),
        ).fetchone()
        if rj:
            vpath = rj["output_mov_path"] or rj["output_webm_path"] or ""
    title = (body.title or proj["title"] or "未命名发布工程").strip()
    cur = conn.execute(
        """INSERT INTO publish_packages(project_id, topic_id, video_project_id, title, video_file_path, rules_version, schedule_timezone)
           VALUES (?, ?, ?, ?, ?, 'gcw-rules-2026.11', 'Asia/Shanghai')""",
        (proj["project_id"], proj["topic_id"], vid, title, vpath),
    )
    pid = cur.lastrowid
    _audit(conn, "sent_to_publish", "video_project", str(vid), "ok", f"已推送至多平台发布中心 publish_package#{pid}")
    conn.commit()
    conn.close()
    return {"ok": True, "package_id": pid, "title": title, "video_file_path": vpath}
