"""R5 统一个人风格 DNA REST API 路由（/api/style-dna/*）。"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.services.style_dna_service import (
    create_dna_version,
    get_active_approved_dna,
    list_dna_versions,
    record_dna_event,
    rollback_dna_to_version,
    set_dna_version_status,
)

router = APIRouter(prefix="/api/style-dna", tags=["StyleDNA-R5"])


class DnaCreateBody(BaseModel):
    theme: str = "dark"
    motion_intensity: float = 1.0
    radius_scale: float = 1.0
    accent_primary: str = "#3b82f6"
    pacing_density: str = "balanced"
    approved_rules: list[str] = []
    palette: list[str] = []
    scope: str = "global"
    project_id: Optional[int] = None
    status: str = "draft"
    note: str = ""


class DnaStatusBody(BaseModel):
    status: str
    scope: str = "global"
    project_id: Optional[int] = None


class DnaEventBody(BaseModel):
    event_source: str = "lab_feedback"
    action: str = "like"
    payload: dict[str, Any] = {}
    scope: str = "global"
    project_id: Optional[int] = None


@router.get("/active")
def api_get_active_dna(project_id: Optional[int] = Query(None)):
    return {"ok": True, "profile": get_active_approved_dna(project_id=project_id)}


@router.get("/versions")
def api_list_dna_versions(scope: str = Query("global"), project_id: Optional[int] = Query(None)):
    items = list_dna_versions(scope=scope, project_id=project_id)
    return {"ok": True, "total": len(items), "items": items}


@router.post("/versions")
def api_create_dna_version(body: DnaCreateBody):
    try:
        prof = create_dna_version(**body.model_dump())
        return {"ok": True, "profile": prof}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.patch("/versions/{version}/status")
def api_patch_dna_status(version: int, body: DnaStatusBody):
    try:
        prof = set_dna_version_status(version, body.status, scope=body.scope, project_id=body.project_id)
        return {"ok": True, "profile": prof}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/rollback/{version}")
def api_rollback_dna(version: int, scope: str = Query("global"), project_id: Optional[int] = Query(None)):
    try:
        prof = rollback_dna_to_version(version, scope=scope, project_id=project_id)
        return {"ok": True, "profile": prof}
    except KeyError as e:
        raise HTTPException(404, str(e))


@router.post("/events")
def api_record_dna_event(body: DnaEventBody):
    ev = record_dna_event(body.event_source, body.action, body.payload, scope=body.scope, project_id=body.project_id)
    return {"ok": True, "event": ev}
