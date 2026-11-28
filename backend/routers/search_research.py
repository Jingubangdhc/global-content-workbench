"""SEARCH-PHASE-1 · 通用 AI 关键词拓展任务与 12 平台真实能力矩阵 REST 路由。"""
from __future__ import annotations

import json
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.db import get_conn
from backend.services import keyword_engine as kw_svc
from backend.services.keyword_engine import build_platform_capability_matrix, expand_keywords_with_real_llm
from backend.services import market_validation_engine as mv_svc
from backend.services import search_batch_engine as batch_svc

router = APIRouter(prefix="/api/search", tags=["search-research-v2"])


@router.get("/platform-capabilities")
def api_platform_capabilities():
    """返回 12 平台真实 6 级能力矩阵（严禁把手动跳转标为自动采集）。"""
    items = build_platform_capability_matrix()
    return {
        "ok": True,
        "total": len(items),
        "auto_search_count": sum(1 for x in items if x["auto_search_supported"]),
        "platforms": items,
    }


# ==================== FIX-02: 可扩展自定义研究维度库与常用组合 ====================
@router.get("/dimensions")
def api_get_dimensions():
    return {"ok": True, **kw_svc.get_dimension_library_and_presets()}


class DimensionCreateBody(BaseModel):
    name: str
    category: str = "自定义维度"
    description: str = ""


@router.post("/dimensions")
def api_add_dimension(body: DimensionCreateBody):
    res = kw_svc.add_custom_dimension(body.name, body.category, body.description)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "新增维度失败")
    return res


class DimensionUpdateBody(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None


@router.patch("/dimensions/{dim_id}")
def api_update_dimension(dim_id: str, body: DimensionUpdateBody):
    res = kw_svc.update_custom_dimension(dim_id, body.name, body.category, body.description)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "编辑维度失败")
    return res


@router.delete("/dimensions/{dim_id}")
def api_delete_dimension(dim_id: str):
    res = kw_svc.delete_custom_dimension(dim_id)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "删除维度失败")
    return res


class DimensionPresetBody(BaseModel):
    name: str
    dimensions: list[str]


@router.post("/dimension-presets")
def api_save_dimension_preset(body: DimensionPresetBody):
    res = kw_svc.save_dimension_preset(body.name, body.dimensions)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "保存维度组合失败")
    return res


@router.delete("/dimension-presets/{preset_id}")
def api_delete_dimension_preset(preset_id: str):
    return kw_svc.delete_dimension_preset(preset_id)


class ExpandTaskReq(BaseModel):
    project_id: int
    seed_keyword: str
    depth_mode: str = "quick"  # quick | standard | deep
    research_goal: str = ""
    target_region: str = ""
    target_language: str = ""
    filters: dict[str, Any] = {}
    selected_platforms: list[str] = ["youtube", "bilibili"]
    budget: dict[str, Any] = {"max_queries": 10, "max_requests": 20, "per_platform_limit": 15, "max_rounds": 2}
    dimension_mode: str = "ai_auto"  # ai_auto | manual | random | all
    selected_dimensions: list[str] = []
    random_count: int = 6


@router.post("/research-tasks/expand")
def api_expand_research_task(body: ExpandTaskReq):
    seed = body.seed_keyword.strip()
    if not seed:
        raise HTTPException(400, "请输入要研究的种子关键词")

    llm_res = expand_keywords_with_real_llm(
        seed_keyword=seed,
        depth_mode=body.depth_mode,
        research_goal=body.research_goal,
        target_region=body.target_region,
        target_language=body.target_language,
        filters=body.filters,
        dimension_mode=body.dimension_mode,
        selected_dimensions=body.selected_dimensions,
        random_count=body.random_count,
    )

    task_uid = f"rt-{uuid.uuid4().hex[:10]}"
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO research_tasks(
                   task_uid, project_id, seed_keyword, entity_type, research_goal, depth_mode,
                   target_region, target_language, filters_json, selected_platforms_json,
                   budget_json, selected_dimensions_json, llm_meta_json, status, error_message
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                task_uid,
                body.project_id,
                seed,
                llm_res.get("entity_type", ""),
                body.research_goal,
                body.depth_mode,
                body.target_region,
                body.target_language,
                json.dumps(body.filters, ensure_ascii=False),
                json.dumps(body.selected_platforms, ensure_ascii=False),
                json.dumps(body.budget, ensure_ascii=False),
                json.dumps(llm_res.get("selected_dimensions") or [], ensure_ascii=False),
                json.dumps(llm_res.get("llm_meta") or {}, ensure_ascii=False),
                llm_res.get("status", "failed"),
                llm_res.get("error", ""),
            ),
        )
        task_id = cur.lastrowid

        inserted = []
        if llm_res.get("ok"):
            for c in llm_res.get("candidates") or []:
                try:
                    c_cur = conn.execute(
                        """INSERT INTO keyword_candidates(
                               task_id, query_text, language, dimension, expansion_type,
                               intent, platform_hint, origin, priority, is_selected, exec_status
                           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, 1, 'pending')""",
                        (
                            task_id, c["query_text"], c["language"], c["dimension"],
                            c["expansion_type"], c["intent"], c["platform_hint"], c["priority"],
                        ),
                    )
                    inserted.append({"id": c_cur.lastrowid, **c, "is_selected": 1, "exec_status": "pending", "result_count": 0})
                except Exception:
                    continue

        conn.commit()
        task_row = dict(conn.execute("SELECT * FROM research_tasks WHERE id = ?", (task_id,)).fetchone())
        return {
            "ok": bool(llm_res.get("ok")),
            "task": _format_task(task_row),
            "entity_understanding": llm_res.get("entity_understanding", ""),
            "candidates": inserted,
            "error": llm_res.get("error", ""),
        }
    finally:
        conn.close()


def _format_task(row: dict) -> dict:
    d = dict(row)
    for jf in ("filters_json", "selected_platforms_json", "budget_json", "selected_dimensions_json", "llm_meta_json"):
        short = jf.replace("_json", "")
        raw = d.pop(jf, None)
        try:
            d[short] = json.loads(raw) if raw else ({} if short in ("filters", "budget", "llm_meta") else [])
        except Exception:
            d[short] = {} if short in ("filters", "budget", "llm_meta") else []
    return d


@router.get("/research-tasks")
def api_list_research_tasks(project_id: Optional[int] = Query(None), limit: int = 30):
    conn = get_conn()
    try:
        if project_id is not None:
            rows = conn.execute("SELECT * FROM research_tasks WHERE project_id = ? ORDER BY id DESC LIMIT ?", (project_id, limit)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM research_tasks ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        out = []
        for r in rows:
            t = _format_task(dict(r))
            t["candidate_count"] = conn.execute("SELECT COUNT(*) FROM keyword_candidates WHERE task_id = ?", (t["id"],)).fetchone()[0]
            out.append(t)
        return {"ok": True, "tasks": out}
    finally:
        conn.close()


@router.get("/research-tasks/{task_id}")
def api_get_research_task(task_id: int):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(404, "未找到研究任务")
        cands = [dict(r) for r in conn.execute("SELECT * FROM keyword_candidates WHERE task_id = ? ORDER BY priority DESC, id ASC", (task_id,)).fetchall()]
        return {"ok": True, "task": _format_task(dict(row)), "candidates": cands}
    finally:
        conn.close()


class CandidateAddBody(BaseModel):
    query_text: str
    dimension: str = "用户补充"
    language: str = "zh"
    intent: str = "手动补充研究词"
    platform_hint: str = "youtube"


@router.post("/research-tasks/{task_id}/candidates")
def api_add_candidate(task_id: int, body: CandidateAddBody):
    qt = body.query_text.strip()
    if not qt:
        raise HTTPException(400, "关键词不能为空")
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO keyword_candidates(task_id, query_text, language, dimension, expansion_type, intent, platform_hint, origin, priority, is_selected, exec_status)
               VALUES (?, ?, ?, ?, 'user', ?, ?, 'user', 90, 1, 'pending')""",
            (task_id, qt, body.language, body.dimension, body.intent, body.platform_hint),
        )
        conn.commit()
        row = dict(conn.execute("SELECT * FROM keyword_candidates WHERE id = ?", (cur.lastrowid,)).fetchone())
        return {"ok": True, "candidate": row}
    except Exception as e:
        raise HTTPException(400, f"候选词已存在或添加失败：{e}")
    finally:
        conn.close()


class CandidatePatchBody(BaseModel):
    query_text: Optional[str] = None
    dimension: Optional[str] = None
    is_selected: Optional[int] = None
    exec_status: Optional[str] = None
    result_count: Optional[int] = None


@router.patch("/candidates/{cid}")
def api_patch_candidate(cid: int, body: CandidatePatchBody):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM keyword_candidates WHERE id = ?", (cid,)).fetchone()
        if not row:
            raise HTTPException(404, "候选词不存在")
        conn.execute(
            """UPDATE keyword_candidates SET
               query_text = COALESCE(?, query_text),
               dimension = COALESCE(?, dimension),
               is_selected = COALESCE(?, is_selected),
               exec_status = COALESCE(?, exec_status),
               result_count = COALESCE(?, result_count)
               WHERE id = ?""",
            (body.query_text.strip() if body.query_text else None, body.dimension, body.is_selected, body.exec_status, body.result_count, cid),
        )
        conn.commit()
        return {"ok": True, "candidate": dict(conn.execute("SELECT * FROM keyword_candidates WHERE id = ?", (cid,)).fetchone())}
    finally:
        conn.close()


@router.delete("/candidates/{cid}")
def api_delete_candidate(cid: int):
    conn = get_conn()
    try:
        conn.execute("DELETE FROM keyword_candidates WHERE id = ?", (cid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


class BatchSelectBody(BaseModel):
    is_selected: Optional[int] = None
    dimension: Optional[str] = None
    invert: bool = False


@router.post("/research-tasks/{task_id}/candidates/batch-select")
def api_batch_select_candidates(task_id: int, body: BatchSelectBody):
    conn = get_conn()
    try:
        if body.invert:
            if body.dimension:
                conn.execute("UPDATE keyword_candidates SET is_selected = CASE WHEN is_selected = 1 THEN 0 ELSE 1 END WHERE task_id = ? AND dimension = ?", (task_id, body.dimension))
            else:
                conn.execute("UPDATE keyword_candidates SET is_selected = CASE WHEN is_selected = 1 THEN 0 ELSE 1 END WHERE task_id = ?", (task_id,))
        elif body.dimension:
            conn.execute("UPDATE keyword_candidates SET is_selected = ? WHERE task_id = ? AND dimension = ?", (body.is_selected or 0, task_id, body.dimension))
        else:
            conn.execute("UPDATE keyword_candidates SET is_selected = ? WHERE task_id = ?", (body.is_selected or 0, task_id))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ==================== SEARCH-PHASE-2: 批量真实搜索任务调度与多项目关联 ====================
class BatchCreateBody(BaseModel):
    project_id: int
    task_id: Optional[int] = None
    title: str = ""
    keywords: list[dict[str, Any]] = []
    platforms: list[str] = ["youtube", "bilibili"]
    budget: dict[str, Any] = {}
    auto_start: bool = True


@router.post("/batches")
def api_create_search_batch(body: BatchCreateBody):
    res = batch_svc.create_and_start_batch(
        project_id=body.project_id,
        task_id=body.task_id,
        title=body.title,
        keywords=body.keywords,
        platforms=body.platforms,
        budget=body.budget,
        auto_start=body.auto_start,
    )
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "创建批量搜索失败")
    return res


@router.get("/batches")
def api_list_search_batches(project_id: Optional[int] = Query(None), limit: int = 30):
    return {"ok": True, "batches": batch_svc.list_batches(project_id=project_id, limit=limit)}


@router.get("/batches/{batch_id}")
def api_get_search_batch(batch_id: int):
    detail = batch_svc.get_batch_detail(batch_id)
    if not detail:
        raise HTTPException(404, f"未找到批量搜索任务：{batch_id}")
    return {"ok": True, **detail}


@router.post("/batches/{batch_id}/pause")
def api_pause_search_batch(batch_id: int):
    res = batch_svc.control_batch(batch_id, "pause")
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "暂停失败")
    return res


@router.post("/batches/{batch_id}/resume")
def api_resume_search_batch(batch_id: int):
    res = batch_svc.control_batch(batch_id, "resume")
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "继续失败")
    return res


@router.post("/batches/{batch_id}/cancel")
def api_cancel_search_batch(batch_id: int):
    res = batch_svc.control_batch(batch_id, "cancel")
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "取消失败")
    return res


@router.post("/batches/{batch_id}/retry-failed")
def api_retry_failed_search_batch(batch_id: int):
    res = batch_svc.control_batch(batch_id, "retry_failed")
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "重试失败")
    return res


@router.delete("/project-links/{link_id}")
def api_delete_project_link(link_id: int, project_id: Optional[int] = Query(None)):
    res = batch_svc.delete_project_content_link(link_id, project_id=project_id)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "删除关联失败")
    return res


@router.post("/contents/{content_id}/calc-outlier")
def api_calc_content_outlier(content_id: int):
    res = batch_svc.calc_content_outlier_and_snapshot(content_id)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "计算爆款倍数失败")
    return res


@router.get("/contents/{content_id}/snapshots")
def api_content_snapshots(content_id: int):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM content_metric_snapshots WHERE content_id = ? ORDER BY id DESC LIMIT 50",
            (content_id,),
        ).fetchall()
        links = conn.execute(
            "SELECT * FROM project_content_links WHERE content_id = ? ORDER BY id DESC",
            (content_id,),
        ).fetchall()
        return {"ok": True, "content_id": content_id, "snapshots": [dict(r) for r in rows], "project_links": [dict(r) for r in links]}
    finally:
        conn.close()


# ==================== SEARCH-PHASE-3: 市场验证、主题聚类、反向关键词、新选题与二次检索 ====================
@router.get("/scoring-rules")
def api_get_scoring_rules():
    return {"ok": True, "rules": mv_svc.get_scoring_rules()}


class BatchAnalyzeBody(BaseModel):
    sample_comments: bool = True
    max_comment_videos: int = 2
    production_fit_input: Optional[dict[str, Any]] = None
    use_llm: bool = True


@router.post("/batches/{batch_id}/analyze")
def api_analyze_batch(batch_id: int, body: BatchAnalyzeBody = BatchAnalyzeBody()):
    try:
        return mv_svc.run_market_validation_and_discovery(
            batch_id=batch_id,
            sample_comments=body.sample_comments,
            max_comment_videos=body.max_comment_videos,
            production_fit_input=body.production_fit_input,
            use_llm=body.use_llm,
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"市场验证与发现分析失败：{e}")


@router.get("/batches/{batch_id}/insights")
def api_get_batch_insights(batch_id: int):
    res = mv_svc.get_batch_insights(batch_id)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "未找到批次洞察")
    return res


@router.get("/topics")
def api_list_topics(project_id: Optional[int] = Query(None), batch_id: Optional[int] = Query(None), limit: int = 50):
    return {"ok": True, "topics": mv_svc.list_topics(project_id=project_id, batch_id=batch_id, limit=limit)}


class TopicPatchBody(BaseModel):
    is_favorite: Optional[int] = None
    production_status: Optional[str] = None
    user_override_recommendation: Optional[str] = None
    production_fit: Optional[dict[str, Any]] = None


@router.patch("/topics/{topic_id}")
def api_patch_topic(topic_id: int, body: TopicPatchBody):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not row:
            raise HTTPException(404, "选题不存在")
        pf_json = json.dumps(body.production_fit, ensure_ascii=False) if body.production_fit is not None else None
        conn.execute(
            """UPDATE topics SET
               is_favorite = COALESCE(?, is_favorite),
               production_status = COALESCE(?, production_status),
               user_override_recommendation = COALESCE(?, user_override_recommendation),
               production_fit_json = COALESCE(?, production_fit_json),
               updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (body.is_favorite, body.production_status, body.user_override_recommendation, pf_json, topic_id),
        )
        conn.commit()
        updated = dict(conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone())
        return {"ok": True, "topic": updated}
    finally:
        conn.close()


class SecondRoundBody(BaseModel):
    platforms: list[str] = ["youtube", "bilibili"]
    max_queries: int = 2
    per_query_limit: int = 4
    auto_start: bool = True


@router.post("/topics/{topic_id}/second-round")
def api_launch_second_round(topic_id: int, body: SecondRoundBody = SecondRoundBody()):
    res = mv_svc.launch_second_round_validation(
        topic_id=topic_id,
        platforms=body.platforms,
        max_queries=body.max_queries,
        per_query_limit=body.per_query_limit,
        auto_start=body.auto_start,
    )
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "发起二次真实检索失败")
    return res


class EvalSecondRoundBody(BaseModel):
    sample_comments: bool = True
    max_comment_videos: int = 2


@router.post("/topics/{topic_id}/evaluate-second-round")
def api_evaluate_second_round(topic_id: int, body: EvalSecondRoundBody = EvalSecondRoundBody()):
    res = mv_svc.complete_second_round_validation(
        topic_id=topic_id,
        sample_comments=body.sample_comments,
        max_comment_videos=body.max_comment_videos,
    )
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "二轮独立验证失败")
    return res
