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


@router.post("/topics")
def api_topic_hub_create(body: CreateTopicBody):
    res = svc.create_manual_topic(body.project_id, body.model_dump())
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


@router.post("/script-skills/custom")
def api_save_custom_script_skill(body: CustomSkillBody):
    res = pkg_svc.save_custom_script_skill(
        name=body.name,
        description=body.description,
        system_prompt=body.system_prompt,
        skill_id=body.skill_id,
        default_version_kind=body.default_version_kind,
        source_format=body.source_format,
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
