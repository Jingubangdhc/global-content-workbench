"""G2 多平台发布中心 REST API 路由（B01–B11）。

安全红线审计声明：
- 本路由模块严格不包含任何 /submit 或 /publish 自动提交端点；
- 仅允许白名单 7 平台，禁止 B12 暂定平台；
- 所有填写授权任务止步于 awaiting_user，必须由本人在官方页面确认并手动回填实际发布链接与时间。
"""
from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.db import get_conn
from backend.services.overlay_adapter import safe_filename
from backend.services.publish_engine import (
    ALLOWED_PLATFORMS,
    PLATFORM_SPECS,
    PUBLISH_BUNDLES_DIR,
    PUBLISH_COVERS_DIR,
    RULES_VERSION,
    build_publish_protocol_bundle,
    compute_package_hash,
    detect_chrome_executable,
    generate_platform_drafts,
    get_account_profile_dir,
    make_idempotency_key,
    open_isolated_platform_page,
    probe_image_dimensions,
    redact_log_text,
    validate_platform_id,
    validate_publish_package,
)

router = APIRouter(prefix="/api/publish", tags=["PublishHub-G2"])


def _audit(conn, event_type: str, entity_type: str, entity_id: str, status: str, summary: str, payload: Any = None):
    conn.execute(
        """INSERT INTO integration_audit_events(module, event_type, entity_type, entity_id, status, summary, payload_json)
           VALUES ('publish_hub', ?, ?, ?, ?, ?, ?)""",
        (
            event_type,
            entity_type,
            str(entity_id),
            status,
            redact_log_text(summary),
            redact_log_text(json.dumps(payload or {}, ensure_ascii=False)),
        ),
    )


def _append_task_log(conn, task_id: int, level: str, message: str):
    row = conn.execute("SELECT logs_json FROM publish_tasks WHERE id = ?", (task_id,)).fetchone()
    logs = json.loads(row["logs_json"] or "[]") if row else []
    logs.append({"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "level": level, "message": redact_log_text(message)})
    conn.execute("UPDATE publish_tasks SET logs_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (json.dumps(logs[-50:], ensure_ascii=False), task_id))


@router.get("/capabilities")
def api_publish_capabilities():
    """返回 7 平台白名单规则版本、本机浏览器检测状态及安全策略声明。"""
    return {
        "rules_version": RULES_VERSION,
        "allowed_platforms": list(PLATFORM_SPECS.values()),
        "browser_detected": detect_chrome_executable() is not None,
        "auto_submit_supported": False,
        "policy": "全 7 平台默认且强制只填写不自动发布；最终发布/定时由本人在官方页面确认。",
    }


# ==================== B11: 平台账号与独立 Profile 管理 ====================
class AccountCreate(BaseModel):
    project_id: int = 1
    platform: str
    external_uid: str
    display_name: str
    notes: str = ""


@router.get("/accounts")
def api_list_accounts(project_id: Optional[int] = Query(None), platform: Optional[str] = Query(None)):
    conn = get_conn()
    sql = "SELECT * FROM platform_accounts WHERE 1=1"
    params: list[Any] = []
    if project_id:
        sql += " AND project_id = ?"
        params.append(project_id)
    if platform:
        sql += " AND platform = ?"
        params.append(platform)
    sql += " ORDER BY platform, id DESC"
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


@router.post("/accounts")
def api_create_account(body: AccountCreate):
    try:
        plat = validate_platform_id(body.platform)
    except ValueError as e:
        raise HTTPException(400, str(e))
    uid = body.external_uid.strip()
    if not uid:
        raise HTTPException(400, "必须提供平台账号唯一标识（external_uid）")
    profile_dir = get_account_profile_dir(plat, uid)
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO platform_accounts(project_id, platform, external_uid, display_name, local_profile_ref, authorization_state, notes)
               VALUES (?, ?, ?, ?, ?, 'unverified', ?)""",
            (body.project_id, plat, uid, body.display_name.strip() or uid, str(profile_dir.name), body.notes.strip()),
        )
        aid = cur.lastrowid
        _audit(conn, "account_created", "platform_account", str(aid), "ok", f"登记平台账号 {plat}:{uid}（独立 Profile 隔离）")
        conn.commit()
    except Exception as e:
        conn.close()
        raise HTTPException(400, f"账号已存在或写入失败：{e}")
    row = dict(conn.execute("SELECT * FROM platform_accounts WHERE id = ?", (aid,)).fetchone())
    conn.close()
    return row


class AccountCheckBody(BaseModel):
    authorization_state: str = "logged_in"  # logged_in / expired / disabled / unverified
    open_login_window: bool = False


@router.post("/accounts/{aid}/check-login")
def api_check_account_login(aid: int, body: AccountCheckBody):
    """B11：核验/更新账号登录状态，或按需打开该账号专属隔离 Chrome Profile 供用户自行登录。"""
    if body.authorization_state not in ("logged_in", "expired", "disabled", "unverified"):
        raise HTTPException(400, "无效的 authorization_state")
    conn = get_conn()
    acc = conn.execute("SELECT * FROM platform_accounts WHERE id = ?", (aid,)).fetchone()
    if not acc:
        conn.close()
        raise HTTPException(404, "未找到平台账号")
    launch_info = None
    if body.open_login_window:
        pdir = get_account_profile_dir(acc["platform"], acc["external_uid"])
        launch_info = open_isolated_platform_page(acc["platform"], pdir)
    conn.execute(
        "UPDATE platform_accounts SET authorization_state = ?, last_checked_at = CURRENT_TIMESTAMP WHERE id = ?",
        (body.authorization_state, aid),
    )
    _audit(conn, "account_checked", "platform_account", str(aid), body.authorization_state, f"账号 {acc['platform']}:{acc['external_uid']} 状态更新为 {body.authorization_state}")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM platform_accounts WHERE id = ?", (aid,)).fetchone())
    conn.close()
    return {"ok": True, "account": row, "launch": launch_info}


@router.delete("/accounts/{aid}")
def api_delete_account(aid: int):
    conn = get_conn()
    conn.execute("DELETE FROM platform_accounts WHERE id = ?", (aid,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ==================== B01–B05: 发布工程包、多尺寸封面、AI 文案、规则校验与协议导出 ====================
class PublishPackageCreate(BaseModel):
    project_id: int = 1
    topic_id: Optional[int] = None
    video_project_id: Optional[int] = None
    render_job_id: Optional[int] = None
    title: str
    video_file_path: str = ""
    schedule_timezone: str = "Asia/Shanghai"


@router.get("/packages")
def api_list_packages(project_id: Optional[int] = Query(None)):
    conn = get_conn()
    if project_id:
        rows = conn.execute("SELECT * FROM publish_packages WHERE project_id = ? ORDER BY updated_at DESC, id DESC", (project_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM publish_packages ORDER BY updated_at DESC, id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("/packages")
def api_create_package(body: PublishPackageCreate):
    conn = get_conn()
    vpath = body.video_file_path.strip()
    if not vpath and body.render_job_id:
        rj = conn.execute("SELECT output_mov_path, output_webm_path FROM render_jobs WHERE id = ?", (body.render_job_id,)).fetchone()
        if rj:
            vpath = rj["output_mov_path"] or rj["output_webm_path"] or ""
    cur = conn.execute(
        """INSERT INTO publish_packages(project_id, topic_id, video_project_id, render_job_id, title, video_file_path, schedule_timezone, rules_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (body.project_id, body.topic_id, body.video_project_id, body.render_job_id, body.title.strip() or "未命名发布工程", vpath, body.schedule_timezone, RULES_VERSION),
    )
    pid = cur.lastrowid
    row = dict(conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone())
    chash = compute_package_hash(row)
    conn.execute("UPDATE publish_packages SET content_hash = ? WHERE id = ?", (chash, pid))
    _audit(conn, "package_created", "publish_package", str(pid), "ok", f"新建发布工程：{body.title}")
    conn.commit()
    row["content_hash"] = chash
    conn.close()
    return row


@router.get("/packages/{pid}")
def api_get_package(pid: int):
    conn = get_conn()
    pkg = conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone()
    if not pkg:
        conn.close()
        raise HTTPException(404, "未找到发布工程")
    tasks = [
        dict(r)
        for r in conn.execute(
            """SELECT t.*, a.display_name AS account_name, a.external_uid AS account_uid, a.authorization_state AS account_auth_state
               FROM publish_tasks t LEFT JOIN platform_accounts a ON a.id = t.account_id
               WHERE t.package_id = ? ORDER BY t.id DESC""",
            (pid,),
        ).fetchall()
    ]
    conn.close()
    return {"package": dict(pkg), "tasks": tasks}


class PublishPackagePatch(BaseModel):
    title: Optional[str] = None
    video_file_path: Optional[str] = None
    drafts: Optional[dict[str, Any]] = None
    schedule_timezone: Optional[str] = None


@router.patch("/packages/{pid}")
def api_patch_package(pid: int, body: PublishPackagePatch):
    conn = get_conn()
    pkg = conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone()
    if not pkg:
        conn.close()
        raise HTTPException(404, "未找到发布工程")
    fields = []
    vals: list[Any] = []
    if body.title is not None:
        fields.append("title = ?")
        vals.append(body.title.strip())
    if body.video_file_path is not None:
        fields.append("video_file_path = ?")
        vals.append(body.video_file_path.strip())
    if body.drafts is not None:
        for k in body.drafts.keys():
            if k not in ALLOWED_PLATFORMS:
                conn.close()
                raise HTTPException(400, f"非法平台键：{k}")
        fields.append("drafts_json = ?")
        vals.append(json.dumps(body.drafts, ensure_ascii=False))
    if body.schedule_timezone is not None:
        fields.append("schedule_timezone = ?")
        vals.append(body.schedule_timezone.strip())
    if fields:
        fields.append("updated_at = CURRENT_TIMESTAMP")
        vals.append(pid)
        conn.execute(f"UPDATE publish_packages SET {', '.join(fields)} WHERE id = ?", vals)
        updated = dict(conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone())
        chash = compute_package_hash(updated)
        conn.execute("UPDATE publish_packages SET content_hash = ? WHERE id = ?", (chash, pid))
        conn.commit()
    row = dict(conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone())
    conn.close()
    return row


@router.delete("/packages/{pid}")
def api_delete_package(pid: int):
    conn = get_conn()
    conn.execute("DELETE FROM publish_packages WHERE id = ?", (pid,))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.post("/packages/{pid}/covers")
async def api_upload_cover(pid: int, slot: str = Form(...), file: UploadFile = File(...)):
    """B02：上传 16:9 / 4:3 / 3:4 多尺寸封面并实测分辨率比例。"""
    if slot not in ("16:9", "4:3", "3:4"):
        raise HTTPException(400, "slot 仅支持 16:9 / 4:3 / 3:4")
    conn = get_conn()
    pkg = conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone()
    if not pkg:
        conn.close()
        raise HTTPException(404, "未找到发布工程")
    try:
        fname = safe_filename(file.filename or "cover.png", {".png", ".jpg", ".jpeg", ".webp"})
    except ValueError as e:
        conn.close()
        raise HTTPException(400, str(e))
    raw = await file.read()
    if len(raw) > 15 * 1024 * 1024:
        conn.close()
        raise HTTPException(400, "封面图片不能超过 15MB")
    dst = PUBLISH_COVERS_DIR / f"pkg_{pid}_{slot.replace(':', 'x')}_{fname}"
    dst.write_bytes(raw)
    dim = probe_image_dimensions(dst)
    covers = json.loads(pkg["covers_json"] or "{}")
    covers[slot] = {"path": str(dst.name), "size_bytes": len(raw), **dim}
    conn.execute("UPDATE publish_packages SET covers_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (json.dumps(covers, ensure_ascii=False), pid))
    conn.commit()
    conn.close()
    return {"ok": True, "slot": slot, "cover": covers[slot], "covers": covers}


class GenerateDraftsBody(BaseModel):
    source_text: str = ""
    platforms: Optional[list[str]] = None
    use_llm: bool = True


@router.post("/packages/{pid}/generate-drafts")
def api_generate_drafts(pid: int, body: GenerateDraftsBody):
    """B01：为 7 平台生成独立合规草稿并写入发布工程。"""
    conn = get_conn()
    pkg = conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone()
    if not pkg:
        conn.close()
        raise HTTPException(404, "未找到发布工程")
    src = body.source_text.strip()
    if not src and pkg["video_project_id"]:
        vp = conn.execute("SELECT srt_text FROM video_projects WHERE id = ?", (pkg["video_project_id"],)).fetchone()
        if vp and vp["srt_text"]:
            src = vp["srt_text"]
    try:
        res = generate_platform_drafts(pkg["title"], src, body.platforms, body.use_llm)
    except ValueError as e:
        conn.close()
        raise HTTPException(400, str(e))
    drafts_str = json.dumps(res["drafts"], ensure_ascii=False)
    conn.execute("UPDATE publish_packages SET drafts_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (drafts_str, pid))
    updated = dict(conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone())
    chash = compute_package_hash(updated)
    conn.execute("UPDATE publish_packages SET content_hash = ? WHERE id = ?", (chash, pid))
    _audit(conn, "drafts_generated", "publish_package", str(pid), "ok", f"生成 {len(res['drafts'])} 个平台独立草稿", res["meta"])
    conn.commit()
    conn.close()
    return {"ok": True, "drafts": res["drafts"], "meta": res["meta"]}


class ValidateBody(BaseModel):
    platforms: Optional[list[str]] = None


@router.post("/packages/{pid}/validate")
def api_validate_package(pid: int, body: ValidateBody):
    """B03：逐平台规则与格式校验。"""
    conn = get_conn()
    pkg = conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone()
    if not pkg:
        conn.close()
        raise HTTPException(404, "未找到发布工程")
    res = validate_publish_package(dict(pkg), body.platforms)
    conn.execute(
        "UPDATE publish_packages SET validation_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (json.dumps(res, ensure_ascii=False), "validated" if res["passed"] else "draft", pid),
    )
    conn.commit()
    conn.close()
    return res


@router.get("/packages/{pid}/export-protocol")
def api_export_publish_protocol(pid: int):
    """B04：导出标准化 publish.json 协议（兼容独立安装的麦田发布助手，硬编码 auto_submit=false）。"""
    conn = get_conn()
    pkg = conn.execute("SELECT * FROM publish_packages WHERE id = ?", (pid,)).fetchone()
    if not pkg:
        conn.close()
        raise HTTPException(404, "未找到发布工程")
    accs = conn.execute("SELECT * FROM platform_accounts WHERE project_id = ?", (pkg["project_id"],)).fetchall()
    acc_map = {a["platform"]: dict(a) for a in accs}
    bundle = build_publish_protocol_bundle(dict(pkg), acc_map)
    bundle_file = PUBLISH_BUNDLES_DIR / f"publish_pkg_{pid}.json"
    bundle_file.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    conn.close()
    return StreamingResponse(
        io.BytesIO(json.dumps(bundle, ensure_ascii=False, indent=2).encode("utf-8")),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="publish_pkg_{pid}.json"'},
    )


# ==================== B06–B10: 只填写授权任务、防重、对账与人工确认链接回填 ====================
class AuthorizeFillItem(BaseModel):
    platform: str
    account_id: Optional[int] = None
    scheduled_at: Optional[str] = None


class AuthorizeFillBody(BaseModel):
    package_id: int
    items: list[AuthorizeFillItem]
    open_browser: bool = False


@router.post("/tasks/authorize-fill")
def api_authorize_fill_tasks(body: AuthorizeFillBody):
    """B06/B07/B08：人工显式授权创建只填写任务（带幂等防重；绝不触发自动发布）。"""
    if not body.items:
        raise HTTPException(400, "请至少勾选 1 个目标平台")
    conn = get_conn()
    pkg = conn.execute("SELECT * FROM publish_packages WHERE id = ?", (body.package_id,)).fetchone()
    if not pkg:
        conn.close()
        raise HTTPException(404, "未找到发布工程")

    pkg_dict = dict(pkg)
    chash = pkg_dict.get("content_hash") or compute_package_hash(pkg_dict)
    selected_plats = [it.platform for it in body.items]
    val_res = validate_publish_package(pkg_dict, selected_plats)

    created_or_existing: list[dict[str, Any]] = []
    for it in body.items:
        try:
            plat = validate_platform_id(it.platform)
        except ValueError as e:
            conn.close()
            raise HTTPException(400, str(e))

        p_check = val_res["platforms"].get(plat) or {}
        if not p_check.get("passed"):
            errs = val_res["global_errors"] + p_check.get("errors", [])
            conn.close()
            raise HTTPException(400, f"{PLATFORM_SPECS[plat]['name']} 校验未通过，已拦截授权：{'; '.join(errs)}")

        # 若指定了账号，校验账号平台一致且未禁用
        acc = None
        if it.account_id:
            acc = conn.execute("SELECT * FROM platform_accounts WHERE id = ?", (it.account_id,)).fetchone()
            if not acc or acc["platform"] != plat:
                conn.close()
                raise HTTPException(400, f"账号 ID={it.account_id} 与平台 {plat} 不匹配")
            if acc["authorization_state"] == "disabled":
                conn.close()
                raise HTTPException(400, f"账号 {acc['display_name']} 已被禁用")

        idem_key = make_idempotency_key(body.package_id, it.account_id, plat, chash)
        dup = conn.execute("SELECT * FROM publish_tasks WHERE idempotency_key = ?", (idem_key,)).fetchone()
        if dup:
            # B07 防重：已存在相同版本/账号/平台任务，绝不重复创建或二次上传
            created_or_existing.append({**dict(dup), "deduplicated": True})
            continue

        init_state = "not_logged_in" if (acc and acc["authorization_state"] == "expired") else "fill_authorized"
        cur = conn.execute(
            """INSERT INTO publish_tasks(package_id, account_id, platform, idempotency_key, state, approval_scope, scheduled_at)
               VALUES (?, ?, ?, ?, ?, 'fill_only', ?)""",
            (body.package_id, it.account_id, plat, idem_key, init_state, it.scheduled_at or None),
        )
        tid = cur.lastrowid
        _append_task_log(conn, tid, "info", f"用户人工授权只填写任务（approval_scope=fill_only，严禁自动提交）")

        if init_state == "fill_authorized":
            # 落盘本平台标准填写包，并按需打开独立 Profile 官方上传页，终态停留在 awaiting_user
            if body.open_browser and acc:
                pdir = get_account_profile_dir(plat, acc["external_uid"])
                l_info = open_isolated_platform_page(plat, pdir)
                _append_task_log(conn, tid, "info", f"已在隔离浏览器打开官方上传页：{l_info.get('url')}（launched={l_info.get('launched')}）")
            conn.execute("UPDATE publish_tasks SET state = 'awaiting_user', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (tid,))
            _append_task_log(conn, tid, "info", "填写准备完成，已进入 awaiting_user：请本人在平台官方页面核对并点击最终发布/定时发布。")
        else:
            _append_task_log(conn, tid, "warn", "账号登录态已过期（not_logged_in），请先重新登录隔离浏览器。")

        _audit(conn, "fill_authorized", "publish_task", str(tid), init_state, f"平台 {plat} 只填写任务已就绪（无自动提交）")
        row = dict(conn.execute("SELECT * FROM publish_tasks WHERE id = ?", (tid,)).fetchone())
        created_or_existing.append({**row, "deduplicated": False})

    conn.commit()
    conn.close()
    return {"ok": True, "tasks": created_or_existing}


class TaskReconcileBody(BaseModel):
    action: str  # mark_needs_reconcile / confirm_published / confirm_scheduled / cancel / skip / fail
    external_item_id: Optional[str] = None
    published_url: Optional[str] = None
    actual_published_at: Optional[str] = None
    scheduled_at: Optional[str] = None
    note: str = ""


@router.post("/tasks/{tid}/reconcile")
def api_reconcile_task(tid: int, body: TaskReconcileBody):
    """B07/B09/B10：任务对账与人工确认回填实际作品 ID / 链接 / 真实发布时间。"""
    conn = get_conn()
    t = conn.execute("SELECT * FROM publish_tasks WHERE id = ?", (tid,)).fetchone()
    if not t:
        conn.close()
        raise HTTPException(404, "未找到发布任务")

    if body.action == "mark_needs_reconcile":
        conn.execute("UPDATE publish_tasks SET state = 'needs_reconcile', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (redact_log_text(body.note or "状态不确定，待人工对账（禁止重复上传）"), tid))
        _append_task_log(conn, tid, "warn", f"标记为 needs_reconcile：{body.note or '超时/网络中断，需先人工核对官方后台'}")
    elif body.action == "confirm_published":
        if not (body.published_url or "").strip().startswith(("http://", "https://")):
            conn.close()
            raise HTTPException(400, "确认已发布必须提供有效的官方作品链接（http/https）")
        pub_at = (body.actual_published_at or "").strip() or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        conn.execute(
            """UPDATE publish_tasks
               SET state = 'published_confirmed', external_item_id = ?, published_url = ?, actual_published_at = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            ((body.external_item_id or "").strip() or None, body.published_url.strip(), pub_at, tid),
        )
        _append_task_log(conn, tid, "ok", f"人工确认已发布，回填真实链接：{body.published_url.strip()}，时间：{pub_at}")
    elif body.action == "confirm_scheduled":
        sched = (body.scheduled_at or t["scheduled_at"] or "").strip()
        if not sched:
            conn.close()
            raise HTTPException(400, "确认已定时必须填写平台原生定时时间")
        conn.execute(
            "UPDATE publish_tasks SET state = 'scheduled_confirmed', scheduled_at = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (sched, tid),
        )
        _append_task_log(conn, tid, "ok", f"人工确认已在官方平台设置定时发布：{sched}")
    elif body.action in ("cancel", "skip", "fail"):
        st_map = {"cancel": "cancelled", "skip": "skipped", "fail": "failed"}
        conn.execute("UPDATE publish_tasks SET state = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (st_map[body.action], redact_log_text(body.note), tid))
        _append_task_log(conn, tid, "warn", f"状态变更为 {st_map[body.action]}：{body.note}")
    else:
        conn.close()
        raise HTTPException(400, f"不支持的 action：{body.action}")

    _audit(conn, f"task_{body.action}", "publish_task", str(tid), "ok", f"任务对账动作：{body.action}")
    conn.commit()
    row = dict(conn.execute("SELECT * FROM publish_tasks WHERE id = ?", (tid,)).fetchone())
    conn.close()
    return {"ok": True, "task": row}


@router.get("/calendar")
def api_publish_calendar(project_id: Optional[int] = Query(None)):
    """B05：按本地时区展示发布计划与真实定时/已发布队列（绝不触发无人自动发布）。"""
    conn = get_conn()
    sql = """SELECT t.*, p.title AS package_title, p.schedule_timezone, a.display_name AS account_name
             FROM publish_tasks t
             JOIN publish_packages p ON p.id = t.package_id
             LEFT JOIN platform_accounts a ON a.id = t.account_id"""
    params: list[Any] = []
    if project_id:
        sql += " WHERE p.project_id = ?"
        params.append(project_id)
    sql += " ORDER BY COALESCE(t.scheduled_at, t.actual_published_at, t.created_at) DESC LIMIT 100"
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows
