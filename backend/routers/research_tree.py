"""GCW-UAT-FIX-02 · 无限级研究维度树、候选选题假设、人工多平台研究侧栏与受控扩展 REST 路由。"""
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from backend.db import get_conn
from backend.services import research_tree_service as svc

router = APIRouter(prefix="/api/research-flow", tags=["research-flow-v2"])


def require_local_or_extension_auth(request: Request) -> None:
    """受控安全校验：
    - 合法本地工作台来源（无 Origin 或 localhost/127.0.0.1/[::1]）放行；
    - Chrome Extension（chrome-extension://*）必须携带匹配的 X-GCW-Extension-Token 放行；
    - 禁止放开任意外部来源（一律 HTTP 403）。
    """
    origin = (request.headers.get("origin") or "").strip()
    if not origin:
        return
    if origin.startswith("chrome-extension://"):
        req_token = (request.headers.get("x-gcw-extension-token") or "").strip()
        expected = svc.get_or_create_extension_token()
        if not req_token or req_token != expected:
            raise HTTPException(403, "Chrome 扩展访问未授权：请先在工作台复制受控令牌填入侧栏")
        return
    host = urlparse(origin).hostname
    if host not in ("localhost", "127.0.0.1", "::1"):
        raise HTTPException(403, f"仅允许本地工作台或受控扩展访问此接口（已拒绝来源：{origin}）")


@router.get("/extension-pairing")
def api_get_extension_pairing(request: Request):
    """仅限本地工作台获取本机受控扩展配对令牌（禁止外部来源读取）。"""
    origin = (request.headers.get("origin") or "").strip()
    if origin and urlparse(origin).hostname not in ("localhost", "127.0.0.1", "::1"):
        raise HTTPException(403, "禁止外部来源读取扩展配对令牌")
    return {
        "ok": True,
        "extension_token": svc.get_or_create_extension_token(),
        "api_base": "http://127.0.0.1:8000",
        "extension_dir": "chrome-extension",
    }


@router.get("/projects", dependencies=[Depends(require_local_or_extension_auth)])
def api_flow_projects():
    conn = get_conn()
    try:
        rows = [dict(r) for r in conn.execute("SELECT id, name, target_country FROM projects ORDER BY id ASC").fetchall()]
        return {"ok": True, "projects": rows}
    finally:
        conn.close()


# ==================== 研究维度树 ====================
@router.get("/tree", dependencies=[Depends(require_local_or_extension_auth)])
def api_get_tree(project_id: int = Query(...)):
    return svc.list_project_tree(project_id)


@router.get("/project-state", dependencies=[Depends(require_local_or_extension_auth)])
def api_get_project_research_state(project_id: int = Query(...)):
    return svc.get_project_research_state(project_id)


class ProjectResearchStateBody(BaseModel):
    project_id: int
    root_input: Optional[str] = None
    active_cand_id: Optional[int] = None
    active_query_text: Optional[str] = None
    active_platform_id: Optional[str] = None
    last_browser_url: Optional[str] = None
    judge_reason: Optional[str] = None
    dims_collapsed: Optional[bool] = None
    cands_collapsed: Optional[bool] = None


@router.put("/project-state", dependencies=[Depends(require_local_or_extension_auth)])
def api_save_project_research_state(body: ProjectResearchStateBody):
    return svc.save_project_research_state(body.project_id, body.model_dump(exclude={"project_id"}, exclude_unset=True))


class RootExpandBody(BaseModel):
    project_id: int
    root_topic: str
    max_children: int = 10


@router.post("/tree/root", dependencies=[Depends(require_local_or_extension_auth)])
def api_create_root_and_expand(body: RootExpandBody):
    try:
        res = svc.create_root_and_expand(body.project_id, body.root_topic, max_children=body.max_children)
        if not res.get("ok"):
            raise HTTPException(400, res.get("error") or "推荐研究维度失败")
        return res
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"AI 推荐研究维度失败：{e}")


class ManualNodeBody(BaseModel):
    project_id: int
    parent_id: Optional[int] = None
    name: str
    root_topic: str = ""


@router.post("/tree/nodes", dependencies=[Depends(require_local_or_extension_auth)])
def api_add_manual_node(body: ManualNodeBody):
    res = svc.add_manual_node(body.project_id, body.parent_id, body.name, body.root_topic)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "添加节点失败")
    return res


class PatchNodeBody(BaseModel):
    project_id: int
    name: Optional[str] = None
    is_selected: Optional[int] = None


@router.patch("/tree/nodes/{node_id}", dependencies=[Depends(require_local_or_extension_auth)])
def api_patch_node(node_id: int, body: PatchNodeBody):
    res = svc.update_node(node_id, body.project_id, body.name, body.is_selected)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "更新节点失败")
    return res


@router.delete("/tree/nodes/{node_id}", dependencies=[Depends(require_local_or_extension_auth)])
def api_delete_node(node_id: int, project_id: int = Query(...)):
    return svc.delete_node(node_id, project_id)


class BatchSelectNodesBody(BaseModel):
    project_id: int
    action: str  # all | none | invert | category_on | category_off | random | set_ids
    parent_id: Optional[int] = None
    random_count: int = 3
    node_ids: Optional[list[int]] = None


@router.post("/tree/batch-select", dependencies=[Depends(require_local_or_extension_auth)])
def api_batch_select_nodes(body: BatchSelectNodesBody):
    return svc.batch_select_nodes(body.project_id, body.action, body.parent_id, body.random_count, body.node_ids)


class AiRecommendDimsBody(BaseModel):
    project_id: int
    count: int = 4


@router.post("/tree/ai-recommend", dependencies=[Depends(require_local_or_extension_auth)])
def api_ai_recommend_dims(body: AiRecommendDimsBody):
    res = svc.ai_recommend_dimensions(body.project_id, body.count)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "AI 随机推荐维度失败")
    return res


class SaveTreePresetBody(BaseModel):
    project_id: int
    name: str
    node_ids: list[int]


@router.post("/tree/presets", dependencies=[Depends(require_local_or_extension_auth)])
def api_save_tree_preset(body: SaveTreePresetBody):
    res = svc.save_tree_preset(body.project_id, body.name, body.node_ids)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "保存组合失败")
    return res


# ==================== 候选选题假设 ====================
class GenCandidatesBody(BaseModel):
    project_id: int
    node_ids: list[int] = []
    custom_hint: str = ""
    max_count: int = 5
    mode: str = "append"
    target_candidate_ids: Optional[list[int]] = None


@router.post("/candidates/generate", dependencies=[Depends(require_local_or_extension_auth)])
def api_generate_candidates(body: GenCandidatesBody):
    try:
        res = svc.generate_candidate_topics(
            body.project_id,
            body.node_ids,
            custom_hint=body.custom_hint,
            max_count=body.max_count,
            mode=body.mode,
            target_candidate_ids=body.target_candidate_ids,
        )
        if not res.get("ok"):
            raise HTTPException(400, res.get("error") or "生成候选选题失败")
        return res
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"AI 生成候选选题失败：{e}")


@router.post("/candidates/regenerate", dependencies=[Depends(require_local_or_extension_auth)])
def api_regenerate_candidates(body: GenCandidatesBody):
    try:
        res = svc.generate_candidate_topics(
            body.project_id,
            body.node_ids,
            custom_hint=body.custom_hint,
            max_count=body.max_count,
            mode=body.mode if body.mode in ("single", "batch", "all") else "all",
            target_candidate_ids=body.target_candidate_ids,
        )
        if not res.get("ok"):
            raise HTTPException(400, res.get("error") or "重新生成候选选题失败")
        return res
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"重新生成候选选题失败：{e}")


@router.get("/candidates", dependencies=[Depends(require_local_or_extension_auth)])
def api_list_candidates(project_id: int = Query(...)):
    return {"ok": True, "candidates": svc.list_candidate_topics(project_id)}


class PatchCandidateBody(BaseModel):
    project_id: int
    title: Optional[str] = None
    angle: Optional[str] = None
    research_hypothesis: Optional[str] = None
    status: Optional[str] = None
    is_locked: Optional[int] = None
    user_notes: Optional[str] = None
    judge_reason: Optional[str] = None
    search_queries_zh: Optional[list[str]] = None
    search_queries_en: Optional[list[str]] = None


@router.patch("/candidates/{cid}", dependencies=[Depends(require_local_or_extension_auth)])
def api_patch_candidate(cid: int, body: PatchCandidateBody):
    res = svc.update_candidate_topic(cid, body.project_id, body.model_dump(exclude_unset=True))
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "更新候选选题失败")
    return res


class ConfirmCandidateBody(BaseModel):
    project_id: int
    title: Optional[str] = None
    angle: Optional[str] = None
    judge_reason: str = ""


@router.post("/candidates/{cid}/confirm", dependencies=[Depends(require_local_or_extension_auth)])
def api_confirm_candidate(cid: int, body: ConfirmCandidateBody):
    res = svc.confirm_candidate_to_topic_hub(cid, body.project_id, title=body.title, angle=body.angle, judge_reason=body.judge_reason)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "确认选题失败")
    return res


# ==================== 10 大研究平台导航 & 人工证据收录 ====================
@router.get("/platforms", dependencies=[Depends(require_local_or_extension_auth)])
def api_get_platforms():
    return {"ok": True, "platforms": svc.get_research_platforms()}


class SavePlatformsBody(BaseModel):
    platforms: list[dict[str, Any]]


@router.put("/platforms", dependencies=[Depends(require_local_or_extension_auth)])
def api_save_platforms(body: SavePlatformsBody):
    return {"ok": True, "platforms": svc.save_research_platforms(body.platforms)}


class CaptureEvidenceBody(BaseModel):
    project_id: int
    candidate_topic_id: int
    evidence_type: str = "video"  # video | article | comment_text | data_snapshot | screenshot
    url: str = ""
    title: str = ""
    author: str = ""
    platform: str = ""
    published_at: str = ""
    view_count: Optional[Any] = None
    like_count: Optional[Any] = None
    comment_count: Optional[Any] = None
    share_count: Optional[Any] = None
    favorite_count: Optional[Any] = None
    follower_count: Optional[Any] = None
    selected_text: str = ""
    screenshot_data_url: str = ""
    search_keyword: str = ""
    user_note: str = ""
    data_source: str = "chrome_sidepanel"
    capture_method: str = "manual_form"


@router.post("/evidence", dependencies=[Depends(require_local_or_extension_auth)])
def api_capture_evidence(body: CaptureEvidenceBody):
    res = svc.capture_manual_evidence(body.project_id, body.candidate_topic_id, body.model_dump())
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "收录人工证据失败")
    return res


@router.get("/evidence", dependencies=[Depends(require_local_or_extension_auth)])
def api_list_evidence(project_id: int = Query(...), candidate_topic_id: Optional[int] = Query(None)):
    return {"ok": True, "evidences": svc.list_manual_evidence(project_id, candidate_topic_id)}


class LogActionBody(BaseModel):
    project_id: int
    candidate_topic_id: Optional[int] = None
    action_type: str
    payload: dict[str, Any] = {}


@router.post("/action-log", dependencies=[Depends(require_local_or_extension_auth)])
def api_log_action(body: LogActionBody):
    svc.log_research_action(body.project_id, body.action_type, body.payload, body.candidate_topic_id)
    return {"ok": True}
