"""KOUBO-SKILL-P2 · 正式 AI 智能剪辑 REST 路由（与正式 Workbench MCP Server 共用 ai_video_service）。"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.config import DATA_DIR, ROOT_DIR
VIDEO_UPLOADS_DIR = DATA_DIR / "video_uploads"
from backend.db import get_conn
from backend.services import ai_video_service as svc
from backend.services.motion_registry import list_motion_assets as list_r1_assets

router = APIRouter(prefix="/api/ai-video", tags=["ai-video-studio"])
CHATCUT_MCP_CMD = Path(r"C:\Users\wodhc\AppData\Roaming\ChatCut\chatcut-mcp.cmd")
WORKSPACE_PLUGIN_MCP = ROOT_DIR / ".agents" / "plugins" / "koubo-workbench-bridge" / "mcp_config.json"


@router.get("/status")
def api_ai_video_status():
    """真实探测 ChatCut 桌面、官方工作区 MCP 插件、R1 动效注册中心与商业化边界状态。"""
    chatcut_running = False
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq ChatCut.exe"], capture_output=True, text=True, timeout=4)
        chatcut_running = "ChatCut.exe" in (out.stdout or "")
    except Exception:
        chatcut_running = False

    conn = get_conn()
    try:
        approved_total = conn.execute("SELECT COUNT(*) FROM motion_assets WHERE status='approved'").fetchone()[0]
        chatcut_compiled = conn.execute("SELECT COUNT(*) FROM motion_assets WHERE status='approved' AND engine_type='chatcut_jsx'").fetchone()[0]
    finally:
        conn.close()
    return {
        "ok": True,
        "antigravity_director": {
            "mode": "mode_a_external_agent",
            "workspace_plugin_configured": WORKSPACE_PLUGIN_MCP.is_file(),
            "workspace_plugin_path": str(WORKSPACE_PLUGIN_MCP),
            "programmatic_one_click_supported": False,
            "note": "正式工作台创建任务后进入 WaitingForAgent，需在 Antigravity 官方客户端下达指令领取，绝不假装自动运行",
        },
        "chatcut_engine": {
            "process_running": chatcut_running,
            "mcp_wrapper_exists": CHATCUT_MCP_CMD.is_file(),
        },
        "motion_registry": {
            "approved_total": approved_total,
            "chatcut_jsx_compiled": chatcut_compiled,
            "visual_reference_separated": 768,
        },
    }


@router.get("/skills")
def api_list_skills():
    return {"ok": True, "skills": svc.list_video_skills()}


@router.get("/jobs")
def api_list_jobs(project_id: Optional[int] = Query(None), status: Optional[str] = Query(None)):
    return {"ok": True, "jobs": svc.list_ai_video_jobs(project_id=project_id, status=status)}


@router.get("/jobs/{job_id}")
def api_get_job(job_id: str):
    job = svc.get_ai_video_job(job_id)
    if not job:
        raise HTTPException(404, f"未找到任务：{job_id}")
    return {"ok": True, "job": job}


class CreateAiJobBody(BaseModel):
    job_id: Optional[str] = None
    idempotency_key: Optional[str] = None
    project_id: Optional[int] = 1
    video_project_id: Optional[int] = None
    content_id: Optional[int] = None
    title: str
    source_video: str = ""
    script: str = ""
    skill_id: str = "premium-talk-edit"
    agent_id: str = "antigravity-native"
    engine_id: str = "chatcut_desktop"
    execution_mode: str = "mode_a_external_agent"
    aspect_ratio: str = "9:16"
    resolution: str = "1080x1920"
    auto_style: bool = True
    style_dna: dict[str, Any] = {}
    options: dict[str, Any] = {}
    cost_limit: dict[str, Any] = {}


@router.post("/jobs")
def api_create_job(body: CreateAiJobBody):
    res = svc.create_ai_video_job(body.model_dump())
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "创建任务失败")
    return res


@router.post("/jobs/upload-source")
async def api_upload_source_video(file: UploadFile = File(...)):
    """导入本地视频至受控目录 VIDEO_UPLOADS_DIR。"""
    ext = Path(file.filename or "clip.mp4").suffix.lower()
    if ext not in (".mp4", ".mov", ".mkv", ".webm", ".m4v"):
        raise HTTPException(400, f"不支持的视频格式：{ext}")
    VIDEO_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = f"ai_src_{Path(file.filename or 'clip.mp4').stem[:40]}{ext}"
    dst = VIDEO_UPLOADS_DIR / safe_name
    raw = await file.read()
    if len(raw) > 500 * 1024 * 1024:
        raise HTTPException(400, "视频体积不能超过 500MB")
    dst.write_bytes(raw)
    return {"ok": True, "path": str(dst.resolve()), "size_bytes": len(raw)}


class CancelBody(BaseModel):
    reason: str = "用户在工作台界面取消任务"


@router.post("/jobs/{job_id}/cancel")
def api_cancel_job(job_id: str, body: CancelBody):
    res = svc.cancel_ai_video_job(job_id, reason=body.reason)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "取消失败")
    return res


class SegmentEditBody(BaseModel):
    start_sec: float
    end_sec: float
    base_version_no: int = 1
    edit_request: str
    preserve_notes: str = "非指定片段保持原剪辑点、动效与音效不变"
    propose_style_dna_rule: str = ""


@router.post("/jobs/{job_id}/segment-edit")
def api_segment_edit(job_id: str, body: SegmentEditBody):
    res = svc.submit_edit_feedback(
        job_id=job_id,
        start_sec=body.start_sec,
        end_sec=body.end_sec,
        base_version_no=body.base_version_no,
        edit_request=body.edit_request,
        preserve_notes=body.preserve_notes,
        propose_style_dna_rule=body.propose_style_dna_rule,
    )
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "提交局部返修失败")
    return res


class PublishHandoffBody(BaseModel):
    version_no: Optional[int] = None
    title: Optional[str] = None


@router.post("/jobs/{job_id}/send-to-publish")
def api_trusted_send_to_publish(job_id: str, body: PublishHandoffBody):
    """§15 受信任发布交接：禁止任意本机文件路径绕过校验。"""
    res = svc.handoff_trusted_output_to_publish(job_id=job_id, version_no=body.version_no, title=body.title)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "推送发布草稿失败")
    return res


@router.get("/jobs/{job_id}/video")
def api_stream_job_video(job_id: str, version_no: Optional[int] = Query(None)):
    """受控视频流接口：仅允许播放该任务已登记的受信任成片版本。"""
    job = svc.get_ai_video_job(job_id)
    if not job:
        raise HTTPException(404, "任务不存在")
    vpath = ""
    if version_no is not None:
        v = next((x for x in job.get("versions", []) if x["version_no"] == version_no), None)
        vpath = v["output_video_path"] if v else ""
    else:
        vpath = job.get("output_video_path") or ""
    if not vpath or not Path(vpath).is_file():
        raise HTTPException(404, "该任务尚无可播放的受信任成片")
    return FileResponse(Path(vpath), media_type="video/mp4")


class OpenProjBody(BaseModel):
    external_project_path: str


@router.post("/open-chatcut-project")
def api_open_chatcut_project(body: OpenProjBody):
    p = Path(body.external_project_path)
    if not p.exists():
        raise HTTPException(404, f"ChatCut 工程路径不存在：{p}")
    subprocess.Popen(["explorer", "/select,", str(p)])
    return {"ok": True, "opened": str(p)}
