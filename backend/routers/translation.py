"""GCW-TRANS-01 · 统一翻译引擎配置、连接测试、费用控制与逐段双语字幕 API 路由。"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from backend.routers.credential_vault import _require_local_only
from backend.services.translation_provider import (
    fetch_provider_models,
    get_content_subtitles,
    get_monthly_usage_summary,
    get_translation_overview,
    save_billing_policy,
    save_provider_config,
    set_default_engine,
    test_provider_connection,
    test_translate_sample,
    translate_content_segments,
    update_manual_subtitle_translation,
)
from backend.services.local_translation_wizard import (
    authorized_pull_local_model,
    control_local_service,
    inspect_local_environment,
    open_model_directory,
)

router = APIRouter(prefix="/api/translation", tags=["translation"])


class ProviderConfigReq(BaseModel):
    api_key: Optional[str] = None
    access_key_id: Optional[str] = None
    secret_access_key: Optional[str] = None
    base_url: Optional[str] = None
    model_id: Optional[str] = None
    region: Optional[str] = None
    local_endpoint: Optional[str] = None
    local_model_path: Optional[str] = None
    clear_api_key: bool = False
    clear_access_key_id: bool = False
    clear_secret_access_key: bool = False
    set_as_default: bool = False


class BillingPolicyReq(BaseModel):
    billing_mode: Optional[str] = None  # free_only | authorized_paid
    auto_translate: Optional[bool] = None
    monthly_char_limit: Optional[int] = None
    monthly_budget_cny: Optional[float] = None
    default_target_lang: Optional[str] = None


class SampleTestReq(BaseModel):
    sample_text: str = "Why are patients flying to Shanghai for medical checkups?"
    target_lang: str = "zh-CN"


class TranslateContentReq(BaseModel):
    target_lang: str = "zh-CN"
    engine_id: Optional[str] = None
    force_retranslate: bool = False
    overwrite_manual: bool = False


class ManualSubtitleEditReq(BaseModel):
    translated_text: str
    target_lang: str = "zh-CN"


@router.get("/config", dependencies=[Depends(_require_local_only)])
def api_get_translation_config():
    """读取全部翻译引擎脱敏配置、默认引擎、费用策略与本月用量统计。"""
    return get_translation_overview()


@router.post("/providers/{engine_id}", dependencies=[Depends(_require_local_only)])
def api_save_provider_config(engine_id: str, req: ProviderConfigReq):
    try:
        return save_provider_config(engine_id, req.model_dump(exclude_none=True), set_as_default=req.set_as_default)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/providers/{engine_id}/default", dependencies=[Depends(_require_local_only)])
def api_set_default_engine(engine_id: str):
    try:
        return set_default_engine(engine_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/providers/{engine_id}/test-connection", dependencies=[Depends(_require_local_only)])
def api_test_connection(engine_id: str):
    """零翻译费连接测试。"""
    try:
        return test_provider_connection(engine_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/providers/{engine_id}/models", dependencies=[Depends(_require_local_only)])
def api_fetch_models(engine_id: str):
    """拉取在线可用模型列表并附带推荐模型。"""
    try:
        return fetch_provider_models(engine_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/providers/{engine_id}/test-translate", dependencies=[Depends(_require_local_only)])
def api_test_translate(engine_id: str, req: SampleTestReq):
    """显式小段文本翻译测试（受费用门禁约束）。"""
    try:
        return test_translate_sample(engine_id, req.sample_text, req.target_lang)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/policy", dependencies=[Depends(_require_local_only)])
def api_update_billing_policy(req: BillingPolicyReq):
    return {
        "policy": save_billing_policy(
            billing_mode=req.billing_mode,
            auto_translate=req.auto_translate,
            monthly_char_limit=req.monthly_char_limit,
            monthly_budget_cny=req.monthly_budget_cny,
            default_target_lang=req.default_target_lang,
        ),
        "usage": get_monthly_usage_summary(),
    }


@router.get("/usage", dependencies=[Depends(_require_local_only)])
def api_get_usage():
    return get_monthly_usage_summary()


@router.get("/subtitles/{content_id}")
def api_get_subtitles(content_id: int, target_lang: str = Query("zh-CN")):
    """获取某视频完整双语字幕时间轴（供 TopicHub 播放器和文案工坊共享）。"""
    try:
        return get_content_subtitles(content_id, target_lang)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/subtitles/{content_id}/translate")
def api_translate_subtitles(content_id: int, req: TranslateContentReq):
    """触发统一逐段带上下文翻译并缓存落库。"""
    try:
        return translate_content_segments(
            content_id=content_id,
            target_lang=req.target_lang,
            engine_id=req.engine_id,
            force_retranslate=req.force_retranslate,
            overwrite_manual=req.overwrite_manual,
        )
    except PermissionError as e:
        raise HTTPException(402, str(e))
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.patch("/subtitles/{content_id}/{segment_idx}")
def api_edit_subtitle_segment(content_id: int, segment_idx: int, req: ManualSubtitleEditReq):
    """人工修订单段译文并保护不被重译覆盖。"""
    try:
        return update_manual_subtitle_translation(content_id, segment_idx, req.translated_text, req.target_lang)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ==================== GCW-UAT-R4-C: 本地免费翻译模型安装向导接口 ====================
class LocalServiceControlReq(BaseModel):
    action: str = "health"  # start | stop | health
    runtime: str = "ollama"


class LocalModelPullReq(BaseModel):
    user_authorized: bool = False
    model_tag: str = "hy-mt3-1.8b"


@router.get("/local-wizard/inspect", dependencies=[Depends(_require_local_only)])
def api_local_wizard_inspect():
    return inspect_local_environment()


@router.post("/local-wizard/open-model-dir", dependencies=[Depends(_require_local_only)])
def api_local_wizard_open_model_dir():
    return open_model_directory()


@router.post("/local-wizard/service", dependencies=[Depends(_require_local_only)])
def api_local_wizard_service(req: LocalServiceControlReq):
    return control_local_service(req.action, req.runtime)


@router.post("/local-wizard/pull", dependencies=[Depends(_require_local_only)])
def api_local_wizard_pull(req: LocalModelPullReq):
    return authorized_pull_local_model(req.user_authorized, req.model_tag)
