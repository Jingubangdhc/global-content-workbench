"""R1 统一动效注册中心 REST API 路由（/api/motion/*）。"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.services.motion_ai_lab import develop_motion_with_llm, revise_motion_dsl_with_llm
from backend.services.motion_registry import (
    create_dev_task,
    get_28_groups_coverage,
    get_motion_asset_detail,
    list_dev_tasks,
    list_motion_assets,
    list_reference_catalog,
    sync_builtin_motion_assets,
    update_motion_asset_status,
    upsert_motion_asset,
)
from backend.services.motion_sandbox import run_full_sandbox_gate, validate_motion_dsl

router = APIRouter(prefix="/api/motion", tags=["MotionRegistry-R1"])


class AssetUpsertBody(BaseModel):
    asset_id: str
    version: str = "1.0.0"
    name: str
    engine_type: str
    group_id: str = "G01"
    skeleton_spec: dict[str, Any] = {}
    params_schema: dict[str, Any] = {}
    narrative_purposes: list[str] = []
    default_content: dict[str, Any] = {}
    default_skin: dict[str, Any] = {}
    sound_cues: list[dict[str, Any]] = []
    timeline_behavior: dict[str, Any] = {}
    capabilities: dict[str, Any] = {}
    source_type: str = "manual"
    license_note: str = "Internal"
    status: str = "draft"
    asset_class: Optional[str] = "executable"
    is_executable: bool = True
    change_note: str = "api upsert"
    gate_report: Optional[dict[str, Any]] = None


class StatusPatchBody(BaseModel):
    status: str
    note: str = ""


class DevTaskCreateBody(BaseModel):
    title: str
    requirement_prompt: str
    group_id: str = "G05"
    video_project_id: Optional[int] = None
    suggested_structure: Optional[dict[str, Any]] = None
    time_range: Optional[dict[str, Any]] = None


@router.get("/assets")
def api_list_motion_assets(
    engine_type: Optional[str] = Query(None),
    group_id: Optional[str] = Query(None),
    narrative_purpose: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
):
    items = list_motion_assets(engine_type=engine_type, group_id=group_id, narrative_purpose=narrative_purpose, status=status, q=q)
    return {"ok": True, "asset_class": "executable", "total": len(items), "items": items}


@router.get("/assets/{asset_id:path}")
def api_get_motion_asset(asset_id: str):
    item = get_motion_asset_detail(asset_id)
    if not item:
        raise HTTPException(404, f"未找到可执行动效资产：{asset_id}")
    return {"ok": True, "asset": item}


@router.post("/assets")
def api_upsert_motion_asset(body: AssetUpsertBody):
    try:
        saved = upsert_motion_asset(body.model_dump(), change_note=body.change_note, gate_report=body.gate_report)
        return {"ok": True, "asset": saved}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.patch("/assets/{asset_id:path}/status")
def api_patch_motion_asset_status(asset_id: str, body: StatusPatchBody):
    try:
        updated = update_motion_asset_status(asset_id, body.status, body.note)
        return {"ok": True, "asset": updated}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/sync")
def api_sync_builtin_assets():
    counts = sync_builtin_motion_assets()
    return {"ok": True, "synced": counts}


@router.get("/groups")
def api_get_28_groups():
    return {"ok": True, **get_28_groups_coverage()}


@router.get("/references")
def api_list_references(source: str = Query("atlas"), q: str = Query(""), limit: int = Query(20)):
    return {"ok": True, **list_reference_catalog(source=source, q=q, limit=limit)}


@router.get("/tasks")
def api_list_dev_tasks(status: Optional[str] = Query(None)):
    items = list_dev_tasks(status=status)
    return {"ok": True, "total": len(items), "items": items}


@router.post("/tasks")
def api_create_dev_task(body: DevTaskCreateBody):
    task = create_dev_task(
        title=body.title,
        requirement_prompt=body.requirement_prompt,
        group_id=body.group_id,
        video_project_id=body.video_project_id,
        suggested_structure=body.suggested_structure,
        time_range=body.time_range,
    )
    return {"ok": True, "task": task}


# ==================== R2: 真实 LLM 动效研发、多轮返修与隔离沙箱门禁 ====================
class AiDevelopBody(BaseModel):
    prompt: str
    mode: str = "original_dsl"  # config_combo | original_dsl
    base_skin: Optional[dict[str, Any]] = None
    style_dna: Optional[dict[str, Any]] = None
    group_id: str = "G20"
    simulate_llm_failure: bool = False


class AiReviseBody(BaseModel):
    current_asset: dict[str, Any]
    revision_prompt: str
    simulate_llm_failure: bool = False


class SandboxGateBody(BaseModel):
    asset_payload: dict[str, Any]
    render_proof: dict[str, Any]


@router.post("/ai-develop")
def api_ai_develop_motion(body: AiDevelopBody):
    try:
        return develop_motion_with_llm(
            prompt=body.prompt,
            mode=body.mode,
            base_skin=body.base_skin,
            style_dna=body.style_dna,
            group_id=body.group_id,
            simulate_llm_failure=body.simulate_llm_failure,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/ai-revise")
def api_ai_revise_motion(body: AiReviseBody):
    try:
        return revise_motion_dsl_with_llm(
            current_asset=body.current_asset,
            revision_prompt=body.revision_prompt,
            simulate_llm_failure=body.simulate_llm_failure,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/sandbox-gate")
def api_run_sandbox_gate(body: SandboxGateBody):
    return run_full_sandbox_gate(body.asset_payload, body.render_proof)


@router.post("/validate-dsl")
def api_validate_dsl(body: dict[str, Any]):
    return validate_motion_dsl(body.get("dsl"))
