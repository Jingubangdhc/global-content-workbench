"""SEARCH-PHASE-4 · 选题资产中心（TopicHub）REST API 路由。"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.services import production_package_service as pkg_svc
from backend.services import topic_hub_service as svc
from backend.services import video_capture_service as vc_svc

router = APIRouter(prefix="/api/topic-hub", tags=["topic-hub"])


@router.get("/project-categories")
def api_topic_hub_project_categories():
    """FIX-A06: 获取左侧项目分类与各项目选题数量（动态读库，含全部项目与未归类）。"""
    return svc.get_project_categories()


@router.get("/overview")
def api_topic_hub_overview(project_id: Optional[int] = Query(None)):
    return svc.get_topic_hub_overview(project_id)


@router.get("/topics")
def api_topic_hub_list(
    project_id: Optional[int] = Query(None),
    q: str = Query(""),
    origin_type: str = Query(""),
    validation_status: str = Query(""),
    production_status: str = Query(""),
    favorite_only: bool = Query(False),
    tag: str = Query(""),
    include_published: bool = Query(True),
    include_archived: bool = Query(False),
    sort_by: str = Query("created_desc"),
    date_from: str = Query(""),
    date_to: str = Query(""),
    limit: int = Query(100),
):
    items = svc.list_topics_hub(
        project_id=project_id,
        q=q,
        origin_type=origin_type,
        validation_status=validation_status,
        production_status=production_status,
        favorite_only=favorite_only,
        tag=tag,
        include_published=include_published,
        include_archived=include_archived,
        sort_by=sort_by,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
    )
    return {"ok": True, "total": len(items), "topics": items}


class CreateTopicBody(BaseModel):
    project_id: int
    topic_title: str
    research_question: str = ""
    angle: str = ""
    target_audience: str = ""
    origin_type: str = "manual_original"
    discovery_reason: str = ""
    production_status: str = "待研究"
    tags: list[str] = []
    keywords: list[str] = []
    suggested_queries: list[str] = []
    fact_check_status: str = "待核实"
    differentiation_notes: str = ""
    user_notes: str = ""
    is_favorite: bool = False
    script_ready: bool = False
    content_ids: list[int] = []
    comment_ids: list[int] = []


@router.post("/topics")
def api_topic_hub_create(body: CreateTopicBody):
    try:
        res = svc.create_manual_topic(body.project_id, body.model_dump())
    except ValueError as e:
        msg = str(e)
        code = 403 if "不属于当前项目" in msg else 400
        raise HTTPException(code, msg)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "创建选题失败")
    return res


@router.get("/topics/{topic_id}")
def api_topic_hub_detail(topic_id: int, project_id: Optional[int] = Query(None)):
    res = svc.get_topic_detail(topic_id, project_id=project_id)
    if not res.get("ok"):
        code = 403 if "跨项目" in (res.get("error") or "") else 404
        raise HTTPException(code, res.get("error") or "未找到选题")
    return res


class PatchTopicBody(BaseModel):
    project_id: Optional[int] = None
    target_project_id: Optional[int] = None
    topic_title: Optional[str] = None
    research_question: Optional[str] = None
    angle: Optional[str] = None
    target_audience: Optional[str] = None
    tags: Optional[list[str]] = None
    keywords: Optional[list[str]] = None
    suggested_queries: Optional[list[str]] = None
    fact_check_status: Optional[str] = None
    differentiation_notes: Optional[str] = None
    user_notes: Optional[str] = None
    production_status: Optional[str] = None
    validation_status: Optional[str] = None
    is_favorite: Optional[bool] = None
    script_ready: Optional[bool] = None
    user_override_recommendation: Optional[str] = None
    production_fit: Optional[dict[str, Any]] = None
    change_reason: str = ""


@router.patch("/topics/{topic_id}")
def api_topic_hub_patch(topic_id: int, body: PatchTopicBody):
    res = svc.update_topic_archive(topic_id, body.project_id, body.model_dump(exclude_unset=True))
    if not res.get("ok"):
        code = 403 if "跨项目" in (res.get("error") or "") else 400
        raise HTTPException(code, res.get("error") or "更新选题失败")
    return res


class BatchStatusBody(BaseModel):
    topic_ids: list[int]
    production_status: str
    reason: str = "用户批量修改创作状态"


@router.post("/topics/batch-status")
def api_topic_batch_status(body: BatchStatusBody):
    res = svc.batch_update_topics_status(body.topic_ids, body.production_status, body.reason)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "批量修改状态失败")
    return res


class TopicLifecycleActionBody(BaseModel):
    reason: str = ""
    archive: bool = True


@router.post("/topics/{topic_id}/revert-status")
def api_topic_revert_status(topic_id: int, body: TopicLifecycleActionBody):
    res = svc.revert_topic_status(topic_id, body.reason or "用户退回上一阶段")
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "退回上一阶段失败")
    return res


@router.post("/topics/{topic_id}/archive")
def api_topic_archive_or_restore(topic_id: int, body: TopicLifecycleActionBody):
    res = svc.archive_or_restore_topic(topic_id, body.archive, body.reason)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "归档/恢复失败")
    return res


class LinkContentBody(BaseModel):
    project_id: int
    content_id: int
    provenance: str = "manual_link"


@router.post("/topics/{topic_id}/evidence/content")
def api_topic_link_content(topic_id: int, body: LinkContentBody):
    res = svc.link_content_to_topic(topic_id, body.project_id, body.content_id, provenance=body.provenance)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "关联作品失败")
    return res


@router.delete("/topics/{topic_id}/evidence/content/{content_id}")
def api_topic_unlink_content(topic_id: int, content_id: int, project_id: int = Query(...)):
    res = svc.unlink_content_from_topic(topic_id, project_id, content_id)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "解除关联失败")
    return res


class LinkRelationBody(BaseModel):
    project_id: int
    parent_topic_id: int
    child_topic_id: int
    relation_type: str = "derived"
    reason: str = ""


@router.post("/relations")
def api_topic_link_relation(body: LinkRelationBody):
    res = svc.link_topic_relation(body.project_id, body.parent_topic_id, body.child_topic_id, body.relation_type, body.reason)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "建立选题关系失败")
    return res


@router.get("/similar")
def api_topic_detect_similar(project_id: int = Query(...), topic_id: Optional[int] = Query(None), threshold: float = Query(0.28)):
    pairs = svc.detect_similar_topics(project_id=project_id, topic_id=topic_id, threshold=threshold)
    return {"ok": True, "count": len(pairs), "pairs": pairs}


class MergeTopicsBody(BaseModel):
    project_id: int
    target_topic_id: int
    source_topic_id: int
    reason: str = "用户确认合并重复选题"


@router.post("/merge")
def api_topic_merge(body: MergeTopicsBody):
    res = svc.merge_topics(body.project_id, body.target_topic_id, body.source_topic_id, body.reason)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "合并选题失败")
    return res


class RestoreMergeBody(BaseModel):
    project_id: int


@router.post("/merge-logs/{merge_log_id}/restore")
def api_topic_restore_merge(merge_log_id: int, body: RestoreMergeBody):
    res = svc.restore_merged_topic(merge_log_id, body.project_id)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "恢复失败")
    return res


class ReSearchBody(BaseModel):
    project_id: int
    queries: list[str] = []
    platforms: list[str] = ["youtube", "bilibili"]
    per_query_limit: int = 4
    auto_start: bool = True


@router.post("/topics/{topic_id}/re-search")
def api_topic_re_search(topic_id: int, body: ReSearchBody):
    res = svc.re_search_topic(
        topic_id=topic_id,
        project_id=body.project_id,
        queries=body.queries,
        platforms=body.platforms,
        per_query_limit=body.per_query_limit,
        auto_start=body.auto_start,
    )
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "重新发起真实搜索失败")
    return res


# ==================== SEARCH-PHASE-5: 原创文案多版本与标准化创作资料包 ====================
@router.get("/package-schema")
def api_package_schema():
    return {"ok": True, "schema": pkg_svc.get_package_schema()}


@router.get("/script-skills")
def api_script_skills():
    return {"ok": True, "skills": pkg_svc.list_available_script_skills()}


class CustomSkillBody(BaseModel):
    name: str
    description: str = ""
    system_prompt: str
    skill_id: str = ""
    default_version_kind: str = "ai_draft"
    source_format: str = "manual"
    skill_purpose: str = "general"


@router.post("/script-skills/custom")
def api_save_custom_script_skill(body: CustomSkillBody):
    res = pkg_svc.save_custom_script_skill(
        name=body.name,
        description=body.description,
        system_prompt=body.system_prompt,
        skill_id=body.skill_id,
        default_version_kind=body.default_version_kind,
        source_format=body.source_format,
        skill_purpose=body.skill_purpose,
    )
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "保存自定义 Skill 失败")
    return res


@router.delete("/script-skills/custom/{skill_id}")
def api_delete_custom_script_skill(skill_id: str):
    res = pkg_svc.delete_custom_script_skill(skill_id)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "删除自定义 Skill 失败")
    return res


@router.get("/writing-models")
def api_writing_models():
    return {"ok": True, "models": pkg_svc.list_available_writing_models()}


@router.get("/studio-versions")
def api_list_studio_versions(
    project_id: int = Query(1),
    content_id: Optional[int] = Query(None),
    topic_id: Optional[int] = Query(None),
):
    return pkg_svc.list_studio_original_versions(
        project_id=project_id,
        content_id=content_id,
        topic_id=topic_id,
    )


class StudioGenerateOriginalBody(BaseModel):
    project_id: int = 1
    primary_content_id: Optional[int] = None
    reference_content_ids: list[int] = []
    skill_id: str = "fact_separated_deep_dive"
    engine_id: str = ""
    model_id: str = ""
    topic_id: Optional[int] = None
    extra_requirements: str = ""
    title: str = ""
    manual_content: str = ""


@router.post("/studio-versions/generate")
def api_generate_studio_original(body: StudioGenerateOriginalBody):
    res = pkg_svc.generate_studio_original_version(
        project_id=body.project_id,
        primary_content_id=body.primary_content_id,
        reference_content_ids=body.reference_content_ids,
        skill_id=body.skill_id,
        engine_id=body.engine_id,
        model_id=body.model_id,
        topic_id=body.topic_id,
        extra_requirements=body.extra_requirements,
        title=body.title,
        manual_content=body.manual_content,
    )
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "生成独立原创文案版本失败")
    return res


@router.get("/topics/{topic_id}/scripts")
def api_list_topic_scripts(topic_id: int, project_id: int = Query(...)):
    res = pkg_svc.list_script_versions(topic_id, project_id)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "获取文案版本失败")
    return res


class CreateScriptBody(BaseModel):
    project_id: int
    skill_id: str = "manual"
    version_kind: str = "user_final"
    title: str = ""
    content_markdown: str = ""
    user_viewpoint: str = ""
    facts_vs_opinions: Optional[dict[str, Any]] = None
    source_refs: Optional[list[Any]] = None
    is_final: bool = False


@router.post("/topics/{topic_id}/scripts")
def api_create_topic_script(topic_id: int, body: CreateScriptBody):
    res = pkg_svc.create_or_generate_script_version(
        topic_id=topic_id,
        project_id=body.project_id,
        skill_id=body.skill_id,
        version_kind=body.version_kind,
        title=body.title,
        content_markdown=body.content_markdown,
        user_viewpoint=body.user_viewpoint,
        facts_vs_opinions=body.facts_vs_opinions,
        source_refs=body.source_refs,
        is_final=body.is_final,
    )
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "保存或生成文案版本失败")
    return res


@router.get("/topics/{topic_id}/package-check")
def api_package_completeness_check(topic_id: int, project_id: int = Query(...)):
    res = pkg_svc.check_package_completeness(topic_id, project_id)
    if not res.get("ok"):
        code = 403 if "跨项目" in (res.get("error") or "") else 404
        raise HTTPException(code, res.get("error") or "完整性检查失败")
    return res


class GeneratePackageBody(BaseModel):
    project_id: int
    script_version_id: Optional[int] = None
    language: str = "zh-CN"
    production_requirements: Optional[dict[str, Any]] = None


@router.post("/topics/{topic_id}/packages/generate")
def api_generate_package(topic_id: int, body: GeneratePackageBody):
    res = pkg_svc.generate_production_package(
        topic_id=topic_id,
        project_id=body.project_id,
        script_version_id=body.script_version_id,
        language=body.language,
        production_requirements=body.production_requirements,
    )
    if not res.get("ok"):
        code = 403 if "跨项目" in (res.get("error") or "") else 400
        raise HTTPException(code, res.get("error") or "生成创作资料包失败")
    return res


@router.get("/topics/{topic_id}/packages")
def api_list_topic_packages(topic_id: int, project_id: int = Query(...)):
    res = pkg_svc.list_production_packages(topic_id, project_id)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "获取历史资料包失败")
    return res


@router.get("/packages/{package_uid}/download/{fmt}")
def api_download_package_file(package_uid: str, fmt: str, project_id: Optional[int] = Query(None)):
    res = pkg_svc.get_package_file_for_download(package_uid, fmt, project_id=project_id)
    if not res.get("ok"):
        code = 403 if "跨项目" in (res.get("error") or "") else 404
        raise HTTPException(code, res.get("error") or "下载失败")
    media = "application/zip" if fmt == "zip" else ("application/json" if fmt == "manifest" else "text/markdown; charset=utf-8")
    return FileResponse(res["path"], filename=res["filename"], media_type=media)


# ==================== GCW-ASSET-01: 内置浏览器视频一键收录与资产管理 ====================
class ResolveShareLinkBody(BaseModel):
    raw_text: str


@router.post("/video-capture/resolve-share-link")
def api_resolve_share_link(body: ResolveShareLinkBody):
    return vc_svc.resolve_share_link_safely(body.raw_text)


class VideoCapturePreviewBody(BaseModel):
    project_id: int
    url: str
    platform: str = ""
    platform_item_id: str = ""
    title: str = ""
    thumbnail_url: str = ""
    author: str = ""
    author_url: str = ""
    published_at: str = ""
    duration_sec: Optional[int] = None
    raw_metrics: dict[str, Any] = {}
    search_keyword: str = ""
    collected_at: str = ""


@router.post("/video-capture/preview")
def api_video_capture_preview(body: VideoCapturePreviewBody):
    res = vc_svc.preview_video_capture(body.project_id, body.model_dump())
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "预览视频信息失败")
    return res


class VideoCaptureSaveBody(BaseModel):
    project_id: int
    url: str
    original_share_url: str = ""
    platform: str = ""
    platform_item_id: str = ""
    title: str = ""
    thumbnail_url: str = ""
    author: str = ""
    author_url: str = ""
    published_at: str = ""
    duration_sec: Optional[int] = None
    view_count: Optional[Any] = None
    like_count: Optional[Any] = None
    comment_count: Optional[Any] = None
    favorite_count: Optional[Any] = None
    share_count: Optional[Any] = None
    author_follower_count: Optional[Any] = None
    collected_at: str = ""
    data_source: str = "electron_readonly_capture"
    search_keyword: str = ""
    research_tags: list[str] = []
    capture_reason: str = ""
    target_mode: str = "existing_topic"
    target_topic_id: Optional[int] = None
    candidate_topic_id: Optional[int] = None
    new_topic_title: str = ""
    new_topic_question: str = ""
    new_topic_angle: str = ""
    new_topic_status: str = "待研究"


@router.post("/video-capture/save")
def api_video_capture_save(body: VideoCaptureSaveBody):
    res = vc_svc.save_video_capture(body.project_id, body.model_dump())
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "收录视频失败")
    return res


class PatchTopicContentAssetBody(BaseModel):
    project_id: int
    url: Optional[str] = None
    original_share_url: Optional[str] = None
    research_tags: Optional[list[str]] = None
    capture_reason: Optional[str] = None
    view_count: Optional[Any] = None
    like_count: Optional[Any] = None
    comment_count: Optional[Any] = None
    favorite_count: Optional[Any] = None
    share_count: Optional[Any] = None
    author_follower_count: Optional[Any] = None
    target_topic_ids: Optional[list[int]] = None


@router.patch("/topics/{topic_id}/evidence/content/{content_id}")
def api_patch_topic_content_asset(topic_id: int, content_id: int, body: PatchTopicContentAssetBody):
    res = vc_svc.update_topic_content_asset(topic_id, content_id, body.project_id, body.model_dump(exclude_unset=True))
    if not res.get("ok"):
        code = 409 if res.get("conflict") else 400
        raise HTTPException(code, res.get("error") or "更新视频资产失败")
    return res


# ==================== GCW-WORKSPACE-V2: 原创草稿持久化与当前视频真实数据面板 ====================
class TopicDraftBody(BaseModel):
    title: str = ""
    content: str = ""
    extra_requirements: str = ""
    skill_id: str = ""
    engine_id: str = ""
    model_id: str = ""
    client_rev: Optional[int] = None


@router.get("/topics/{topic_id}/draft")
def api_get_topic_draft(topic_id: int):
    return svc.get_topic_original_draft(topic_id)


@router.put("/topics/{topic_id}/draft")
def api_save_topic_draft(topic_id: int, body: TopicDraftBody):
    res = svc.save_topic_original_draft(topic_id, body.model_dump())
    if not res.get("ok"):
        code = 409 if res.get("stale_rejected") else 500
        raise HTTPException(code, res.get("error") or "保存草稿失败")
    return res


@router.get("/contents/{content_id}/metrics")
def api_get_content_metrics(content_id: int):
    res = svc.get_content_metrics_detail(content_id)
    if not res.get("ok"):
        raise HTTPException(404, res.get("error") or "未找到作品")
    return res


class RefreshContentMetricsBody(BaseModel):
    expected_platform: str = ""
    expected_platform_item_id: str = ""
    view_count: Optional[Any] = None
    like_count: Optional[Any] = None
    comment_count: Optional[Any] = None
    favorite_count: Optional[Any] = None
    share_count: Optional[Any] = None
    author_follower_count: Optional[Any] = None
    duration_sec: Optional[Any] = None
    author_name: Optional[str] = None
    published_at: Optional[str] = None


@router.post("/contents/{content_id}/refresh-metrics")
def api_refresh_content_metrics(content_id: int, body: RefreshContentMetricsBody):
    res = svc.refresh_content_metrics(content_id, body.model_dump(exclude_unset=True))
    if not res.get("ok"):
        code = 409 if res.get("identity_mismatch") else 400
        raise HTTPException(code, res.get("error") or "刷新作品数据失败")
    return res


# ==================== FIX-03-B: 公共标准库 OpenAI 兼容调用（彻底移除 httpx 依赖，分类报错不抛 500） ====================
def _call_openai_compat_chat(
    *,
    api_key: str,
    base_url: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 0.4,
    timeout: float = 75.0,
) -> str:
    import json
    import socket
    import urllib.error
    import urllib.request

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    payload = json.dumps(
        {"model": model, "messages": messages, "temperature": temperature},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="ignore")[:300]
        except Exception:
            pass
        if e.code == 401:
            raise HTTPException(401, f"模型 API Key 无效或未授权（HTTP 401），请在左下角「翻译 Key / 设置」检查配置")
        if e.code == 402 or "insufficient" in err_body.lower() or "balance" in err_body.lower() or "quota" in err_body.lower():
            raise HTTPException(402, f"模型账户余额不足或配额耗尽（HTTP {e.code}），请充值或切换其他已授权模型")
        if e.code == 429:
            raise HTTPException(429, "模型请求过于频繁（HTTP 429），请稍后重试")
        raise HTTPException(502, f"模型接口返回错误（HTTP {e.code}）：{err_body or e.reason}")
    except (TimeoutError, socket.timeout):
        raise HTTPException(504, f"调用模型超时（>{int(timeout)}s），请检查网络或本地模型服务状态后重试")
    except urllib.error.URLError as e:
        raise HTTPException(502, f"无法连接模型服务（{base_url}）：{e.reason}")
    except Exception as e:
        raise HTTPException(502, f"调用模型发生异常：{e}")

    try:
        data = json.loads(raw)
        return str((data.get("choices") or [{}])[0].get("message", {}).get("content") or "").strip()
    except Exception as e:
        raise HTTPException(502, f"模型返回了无法解析的 JSON 响应：{e}")


def _check_billing_policy_for_engine(engine_id: str) -> None:
    """FIX-C03: 依据实际引擎类别判断免费与付费，严禁硬编码只有混元免费，严禁未经用户授权调用付费模型。"""
    from backend.services import translation_provider as tp_svc

    overview = tp_svc.get_translation_overview()
    billing_mode = (overview.get("policy") or {}).get("billing_mode") or "free_only"
    providers = overview.get("providers") or []
    matched = next((p for p in providers if p.get("engine_id") == engine_id), None)
    if matched is not None:
        billing_cat = matched.get("billing_category") or (
            "free_local" if matched.get("protocol") == "local_openai_compatible" else "paid_cloud"
        )
        is_free = billing_cat in ("free_local", "free_cloud")
    else:
        is_free = False
    if billing_mode == "free_only" and not is_free:
        raise HTTPException(
            403,
            "当前工作台处于「仅允许免费模式」，未获用户付费 API 授权，已拦截付费云端模型调用。如需使用云端模型，请在左下角「翻译 Key / 设置」中显式开启付费授权。",
        )


# ==================== FIX-04 / FIX-03-B: 全文拆解 Skill 工作区（禁止静默截断、原子保存） ====================
class BreakdownRunBody(BaseModel):
    skill_id: str
    engine_id: str = ""
    model_id: str = ""
    text_mode: str = "original"  # original | zh | bilingual
    extra_requirements: str = ""


@router.get("/contents/{content_id}/breakdown-reports")
def api_list_breakdown_reports(content_id: int):
    import json
    from backend.db import get_conn
    conn = get_conn()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (f"content_breakdown_reports_{content_id}",)).fetchone()
        reports = json.loads(row["value"]) if row and row["value"] else []
        return {"ok": True, "content_id": content_id, "reports": reports}
    finally:
        conn.close()


@router.post("/contents/{content_id}/breakdown-run")
def api_run_breakdown_skill(content_id: int, body: BreakdownRunBody):
    import json
    from datetime import datetime, timezone
    from backend.db import get_conn
    from backend.services import translation_provider as tp_svc

    skills = pkg_svc.list_available_script_skills()
    sk = next((s for s in skills if s.get("skill_id") == body.skill_id and not s.get("is_builtin")), None)
    if not sk:
        raise HTTPException(400, "未找到已导入的拆解 Skill，请先导入拆解 Skill（绝不生成虚构分析）")

    sub = tp_svc.get_content_subtitles(content_id, "zh-CN")
    segs = sub.get("segments") or []
    if not segs:
        raise HTTPException(400, "当前视频尚无参考文案，请先提取参考文案后再执行全文拆解")

    lines = []
    for s in segs:
        orig = (s.get("text") or "").strip()
        zh = (s.get("translated_text") or "").strip()
        if body.text_mode == "zh":
            lines.append(zh or orig)
        elif body.text_mode == "bilingual":
            lines.append(f"{orig}\n{zh}" if zh else orig)
        else:
            lines.append(orig)
    full_text = "\n".join(x for x in lines if x).strip()
    if not full_text:
        raise HTTPException(400, "所选文案视图为空，无法执行全文拆解")

    # FIX-03-B: 禁止静默截断超过 18000 字符的原文；超限时明确报错，不把部分分析标为全文分析
    MAX_FULLTEXT_CHARS = 18000
    if len(full_text) > MAX_FULLTEXT_CHARS:
        raise HTTPException(
            400,
            f"当前完整参考文案长度（{len(full_text)} 字）超出单次全文拆解容量上限（{MAX_FULLTEXT_CHARS} 字）。系统禁止静默截断冒充全文分析，请切换为单语视图或缩短输入后重试。",
        )

    try:
        api_key, base_url, resolved_model, resolved_engine = pkg_svc._resolve_writing_llm(body.engine_id, body.model_id)
    except Exception as e:
        raise HTTPException(400, str(e))

    _check_billing_policy_for_engine(resolved_engine)

    sys_prompt = sk.get("system_prompt") or ""
    user_prompt = f"以下是待拆解视频的完整参考文案（模式：{body.text_mode}，共 {len(full_text)} 字）：\n\n{full_text}"
    if body.extra_requirements.strip():
        user_prompt += f"\n\n额外分析要求：\n{body.extra_requirements.strip()}"

    report_md = _call_openai_compat_chat(
        api_key=api_key,
        base_url=base_url,
        model=resolved_model,
        messages=[
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.4,
        timeout=90.0,
    )
    if not report_md:
        raise HTTPException(502, "模型返回的拆解报告为空，未保存")

    item = {
        "id": f"bd_{int(datetime.now(timezone.utc).timestamp() * 1000)}",
        "content_id": content_id,
        "skill_id": sk.get("skill_id"),
        "skill_name": sk.get("name"),
        "engine_id": resolved_engine,
        "model_id": resolved_model,
        "text_mode": body.text_mode,
        "input_chars": len(full_text),
        "extra_requirements": body.extra_requirements.strip(),
        "report_markdown": report_md,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    conn = get_conn()
    try:
        # FIX-03-B: 原子保存历史拆解报告，禁止并发覆盖
        conn.execute("BEGIN IMMEDIATE")
        key = f"content_breakdown_reports_{content_id}"
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        reports = json.loads(row["value"]) if row and row["value"] else []
        reports.insert(0, item)
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(reports[:30], ensure_ascii=False)),
        )
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        raise HTTPException(500, f"保存拆解报告失败：{e}")
    finally:
        conn.close()
    return {"ok": True, "report": item}


# ==================== FIX-08 / FIX-03-B: 高赞评论选题发现（严格归属校验、禁止非法 ID 替换、无 httpx） ====================
class CommentDiscoverTopicsBody(BaseModel):
    project_id: int
    content_id: int
    comment_ids: list[int]
    count: int = 3
    engine_id: str = ""
    model_id: str = ""


@router.post("/comments/discover-topics")
def api_discover_topics_from_comments(body: CommentDiscoverTopicsBody):
    import json
    from datetime import datetime, timezone
    from backend.db import get_conn

    cids = [int(x) for x in (body.comment_ids or []) if int(x) > 0]
    if not cids:
        raise HTTPException(400, "请先选择至少 1 条真实评论")
    want_n = max(1, min(10, int(body.count or 3)))

    conn = get_conn()
    try:
        # FIX-C01 & FIX-C02: 复用统一证据归属校验，严格校验项目、作品及所有传入评论（禁止静默忽略混合无效评论 ID）
        try:
            validated = svc.validate_topic_evidence_scope(
                conn,
                body.project_id,
                [body.content_id],
                cids,
                require_comment_in_contents=True,
            )
        except ValueError as e:
            msg = str(e)
            code = 403 if "不属于当前项目" in msg else (404 if "不存在" in msg and "作品" in msg else 400)
            raise HTTPException(code, msg)
        content_row = validated["content_map"][int(body.content_id)]
        real_comments = sorted(
            validated["comment_map"].values(),
            key=lambda r: int(r.get("like_count") or 0),
            reverse=True,
        )
    finally:
        conn.close()

    if not real_comments:
        raise HTTPException(400, "所选评论在当前视频下不存在，禁止编造评论生成选题")

    try:
        api_key, base_url, resolved_model, resolved_engine = pkg_svc._resolve_writing_llm(body.engine_id, body.model_id)
    except Exception as e:
        raise HTTPException(400, str(e))

    if resolved_engine == "hunyuan_mt3_local":
        raise HTTPException(400, "本地混元模型属于专用机器翻译模型，不支持高赞评论选题生成，请选择具备通用文本生成能力的已配置模型")

    _check_billing_policy_for_engine(resolved_engine)

    cmt_block = "\n".join(
        f"- [comment_id={c['id']}, likes={c.get('like_count') or 0}] {c.get('text') or ''}"
        for c in real_comments
    )
    prompt = (
        f"请严格基于以下真实用户评论，提炼 {want_n} 个短视频候选选题。\n"
        f"源视频：{content_row['title']}\n真实评论：\n{cmt_block}\n\n"
        "严格返回 JSON 数组，每项字段为：suggested_title, user_pain_point, angle, source_comment_id（必须是上述真实整数 comment_id 之一）。严禁编造不存在的评论或数据。"
    )
    raw_txt = _call_openai_compat_chat(
        api_key=api_key,
        base_url=base_url,
        model=resolved_model,
        messages=[
            {"role": "system", "content": "你是严谨的内容选题研究助手，只输出合法 JSON 数组，严禁编造评论与互动数据。"},
            {"role": "user", "content": prompt},
        ],
        temperature=0.5,
        timeout=60.0,
    )
    try:
        s_idx = raw_txt.find("[")
        e_idx = raw_txt.rfind("]")
        if s_idx < 0 or e_idx <= s_idx:
            raise ValueError("响应中未找到 JSON 数组")
        parsed = json.loads(raw_txt[s_idx : e_idx + 1])
        if not isinstance(parsed, list):
            raise ValueError("解析结果不是列表")
    except Exception as e:
        raise HTTPException(502, f"模型返回内容 JSON 解析失败：{e}")

    by_id = {int(c["id"]): c for c in real_comments}
    now_iso = datetime.now(timezone.utc).isoformat()
    candidates = []
    skipped_invalid_id = 0
    for item in parsed[:want_n]:
        if not isinstance(item, dict) or not str(item.get("suggested_title") or "").strip():
            continue
        # FIX-03-B (A01 & A02): 安全解析 source_comment_id 并严格校验属于用户所选真实评论集合，绝不静默替换为其他评论
        raw_scid = item.get("source_comment_id")
        try:
            scid = int(str(raw_scid).strip()) if raw_scid is not None and str(raw_scid).strip() != "" else None
        except (ValueError, TypeError):
            scid = None
        if scid is None or scid not in by_id:
            skipped_invalid_id += 1
            continue
        src_c = by_id[scid]
        candidates.append({
            "suggested_title": str(item.get("suggested_title") or "").strip()[:140],
            "user_pain_point": str(item.get("user_pain_point") or "").strip()[:300],
            "angle": str(item.get("angle") or "").strip()[:300],
            "source_comment_id": int(src_c["id"]),
            "source_comment_text": src_c.get("text") or "",
            "comment_likes": src_c.get("like_count"),
            "content_id": int(content_row["id"]),
            "content_url": content_row["url"] or "",
            "project_id": int(body.project_id),
            "engine_id": resolved_engine,
            "model_id": resolved_model,
            "generated_at": now_iso,
        })
    if not candidates:
        raise HTTPException(
            502,
            f"模型未返回关联到所选真实评论 ID 的有效候选选题（已拒绝 {skipped_invalid_id} 条非法评论归属项），请重试",
        )
    return {"ok": True, "candidates": candidates}
