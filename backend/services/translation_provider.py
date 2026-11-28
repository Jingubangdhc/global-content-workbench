"""GCW-TRANS-01 · 统一翻译引擎配置、安全密钥管理、费用用量控制与逐段上下文双语字幕翻译服务。

支持 7 类引擎（同一套配置体系，按 engine_id 严格隔离凭据）：
第一批（OpenAI 兼容协议）：
  1. deepseek_llm            - DeepSeek（默认复用 .env 已有密钥，绝不明文回传前端）
  2. gemini_llm              - Google Gemini（OpenAI 兼容接口）
  3. doubao_llm              - 豆包大模型（火山方舟 OpenAI 兼容接口）
  4. custom_openai           - 自定义 OpenAI 兼容服务
第二批（原生协议独立适配器）：
  5. volcengine_mt           - 火山引擎机器翻译（原生 V4 签名 Action=TranslateText&Version=2020-06-01）
  6. google_cloud_translate  - Google Cloud Translation Basic REST v2（独立 v2 协议，不混用 v3）
本地可选引擎：
  7. hunyuan_mt3_local       - 腾讯混元 Hy-MT3-1.8B 本地推理/模型路径探测（未安装明确提示，绝不擅自下载）

安全原则：
- 凭据复用 backend/routers/credential_vault.py 的 Windows 原生 DPAPI 加密落盘于 data/translation_configs.json；
- 绝不向前端返回完整 API Key / SecretKey，仅返回脱敏掩码；
- 切换服务商绝不跨服务商混用或误发密钥；
- 费用控制门禁支持 free_only（仅允许免费模式）与 authorized_paid（用户授权付费模式）及月度字符/预算硬上限。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from openai import OpenAI

from backend.config import DATA_DIR, get_env_config
from backend.db import get_conn
from backend.extractors.transcript import normalize_segments
from backend.routers.credential_vault import _dpapi_decrypt, _dpapi_encrypt

CONFIG_FILE = Path(DATA_DIR) / "translation_configs.json"

# ==================== 7 类官方翻译引擎注册表 ====================
PROVIDER_REGISTRY: dict[str, dict[str, Any]] = {
    "deepseek_llm": {
        "engine_id": "deepseek_llm",
        "name": "DeepSeek",
        "short_name": "DeepSeek",
        "protocol": "openai_compatible",
        "batch_group": "batch_1_openai",
        "billing_category": "pay_as_you_go",
        "billing_label": "按量付费（支持复用现有 .env 密钥）",
        "estimated_unit_cost_cny_per_1k_tokens": 0.002,
        "default_base_url": "https://api.deepseek.com",
        "default_model": "deepseek-chat",
        "recommended_models": ["deepseek-chat", "deepseek-reasoner"],
        "official_links": {
            "api_key_url": "https://platform.deepseek.com/api_keys",
            "docs_url": "https://api-docs.deepseek.com/",
            "pricing_url": "https://api-docs.deepseek.com/quick_start/pricing",
        },
        "fields": [
            {"key": "api_key", "label": "API Key", "type": "secret", "required": True, "placeholder": "留空可复用 .env 已有 DeepSeek Key"},
            {"key": "base_url", "label": "接口地址 (Base URL)", "type": "url", "required": True, "placeholder": "https://api.deepseek.com"},
            {"key": "model_id", "label": "模型 ID (Model ID)", "type": "model", "required": True, "placeholder": "deepseek-chat"},
        ],
        "notes": "中文表达自然流畅，适合长视频字幕上下文一致翻译；支持直接复用本机 .env 中已配置的 DeepSeek 密钥。",
    },
    "gemini_llm": {
        "engine_id": "gemini_llm",
        "name": "Google Gemini (OpenAI 兼容)",
        "short_name": "Gemini",
        "protocol": "openai_compatible",
        "batch_group": "batch_1_openai",
        "billing_category": "free_quota",
        "billing_label": "官方免费层额度 / 按量付费（依 AI Studio 计划）",
        "estimated_unit_cost_cny_per_1k_tokens": 0.001,
        "default_base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "default_model": "gemini-2.5-flash",
        "recommended_models": ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
        "official_links": {
            "api_key_url": "https://aistudio.google.com/apikey",
            "docs_url": "https://ai.google.dev/gemini-api/docs/openai",
            "pricing_url": "https://ai.google.dev/gemini-api/docs/pricing",
        },
        "fields": [
            {"key": "api_key", "label": "Gemini API Key", "type": "secret", "required": True, "placeholder": "AIza..."},
            {"key": "base_url", "label": "OpenAI 兼容接口地址", "type": "url", "required": True, "placeholder": "https://generativelanguage.googleapis.com/v1beta/openai/"},
            {"key": "model_id", "label": "模型 ID (Model ID)", "type": "model", "required": True, "placeholder": "gemini-2.5-flash"},
        ],
        "notes": "使用 Google 官方 OpenAI 兼容端点，可调用免费层或付费层 Gemini 模型；需国际网络环境。",
    },
    "doubao_llm": {
        "engine_id": "doubao_llm",
        "name": "豆包大模型（火山方舟）",
        "short_name": "豆包",
        "protocol": "openai_compatible",
        "batch_group": "batch_1_openai",
        "billing_category": "pay_as_you_go",
        "billing_label": "新客试用 / 按量付费",
        "estimated_unit_cost_cny_per_1k_tokens": 0.0008,
        "default_base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "default_model": "doubao-1-5-lite-32k-250115",
        "recommended_models": ["doubao-1-5-lite-32k-250115", "doubao-1-5-pro-32k-250115", "doubao-seed-1-6-flash-250615"],
        "official_links": {
            "api_key_url": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
            "docs_url": "https://www.volcengine.com/docs/82379/1330626",
            "pricing_url": "https://www.volcengine.com/docs/82379/1099320",
        },
        "fields": [
            {"key": "api_key", "label": "方舟 API Key", "type": "secret", "required": True, "placeholder": "填写火山方舟 API Key"},
            {"key": "base_url", "label": "接口地址 (Base URL)", "type": "url", "required": True, "placeholder": "https://ark.cn-beijing.volces.com/api/v3"},
            {"key": "model_id", "label": "模型 ID 或推理接入点 ID (ep-...)", "type": "model", "required": True, "placeholder": "doubao-1-5-lite-32k-250115 或 ep-xxxx"},
        ],
        "notes": "支持火山方舟 OpenAI 兼容接口；Model ID 可填官方模型名或控制台创建的推理接入点 ep-xxxx。",
    },
    "custom_openai": {
        "engine_id": "custom_openai",
        "name": "自定义 OpenAI 兼容服务",
        "short_name": "自定义 OpenAI",
        "protocol": "openai_compatible",
        "batch_group": "batch_1_openai",
        "billing_category": "pay_as_you_go",
        "billing_label": "自定义（依服务商计费）",
        "estimated_unit_cost_cny_per_1k_tokens": 0.002,
        "default_base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "recommended_models": ["gpt-4o-mini", "qwen-plus", "glm-4-flash"],
        "official_links": {
            "api_key_url": "https://platform.openai.com/api-keys",
            "docs_url": "https://platform.openai.com/docs/api-reference/chat",
            "pricing_url": "https://openai.com/api/pricing/",
        },
        "fields": [
            {"key": "api_key", "label": "API Key", "type": "secret", "required": True, "placeholder": "sk-..."},
            {"key": "base_url", "label": "兼容接口地址 (Base URL)", "type": "url", "required": True, "placeholder": "https://your-provider.example.com/v1"},
            {"key": "model_id", "label": "模型 ID (Model ID)", "type": "model", "required": True, "placeholder": "自定义模型名称"},
        ],
        "notes": "适配任何标准 OpenAI Chat Completions 兼容服务（通义、智谱、OpenRouter、自建网关等）。",
    },
    "volcengine_mt": {
        "engine_id": "volcengine_mt",
        "name": "火山引擎机器翻译",
        "short_name": "火山机器翻译",
        "protocol": "volcengine_mt_v4",
        "batch_group": "batch_2_native",
        "billing_category": "free_quota",
        "billing_label": "官方月度免费额度（约 200 万字符/月）+ 超额按量",
        "estimated_unit_cost_cny_per_1k_chars": 0.049,
        "default_base_url": "https://translate.volcengineapi.com",
        "default_model": "TranslateText-2020-06-01",
        "recommended_models": ["TranslateText-2020-06-01"],
        "official_links": {
            "api_key_url": "https://console.volcengine.com/iam/keymanage/",
            "docs_url": "https://www.volcengine.com/docs/4640/65067",
            "pricing_url": "https://www.volcengine.com/docs/4640/65066",
        },
        "fields": [
            {"key": "access_key_id", "label": "AccessKey ID", "type": "secret", "required": True, "placeholder": "AKLT..."},
            {"key": "secret_access_key", "label": "SecretAccessKey", "type": "secret", "required": True, "placeholder": "火山 IAM SecretAccessKey"},
            {"key": "region", "label": "区域 (Region)", "type": "text", "required": True, "placeholder": "cn-north-1"},
            {"key": "base_url", "label": "官方服务地址", "type": "url", "required": True, "placeholder": "https://translate.volcengineapi.com"},
        ],
        "notes": "使用火山引擎官方原生 V4 签名请求 TranslateText (2020-06-01)，不与方舟大模型 API Key 混用。",
    },
    "google_cloud_translate": {
        "engine_id": "google_cloud_translate",
        "name": "Google Cloud Translation (Basic v2)",
        "short_name": "Google Translate v2",
        "protocol": "google_translate_v2",
        "batch_group": "batch_2_native",
        "billing_category": "free_quota",
        "billing_label": "官方月度免费额度（50 万字符/月）+ 超额 $20/百万字符",
        "estimated_unit_cost_cny_per_1k_chars": 0.145,
        "default_base_url": "https://translation.googleapis.com/language/translate/v2",
        "default_model": "nmt",
        "recommended_models": ["nmt", "base"],
        "official_links": {
            "api_key_url": "https://console.cloud.google.com/apis/credentials",
            "docs_url": "https://cloud.google.com/translate/docs/reference/rest/v2/translate",
            "pricing_url": "https://cloud.google.com/translate/pricing",
        },
        "fields": [
            {"key": "api_key", "label": "Google Cloud API Key", "type": "secret", "required": True, "placeholder": "AIza..."},
            {"key": "base_url", "label": "Basic v2 REST 地址", "type": "url", "required": True, "placeholder": "https://translation.googleapis.com/language/translate/v2"},
            {"key": "model_id", "label": "翻译模型 (nmt / base)", "type": "model", "required": False, "placeholder": "nmt"},
        ],
        "notes": "仅对接 Google Cloud Translation Basic REST v2，不混用 Advanced v3 OAuth2 协议；需开通 Cloud Translation API。",
    },
    "hunyuan_mt3_local": {
        "engine_id": "hunyuan_mt3_local",
        "name": "腾讯混元 Hy-MT3-1.8B（本地免费离线 · GPU加速）",
        "short_name": "混元 Hy-MT3 本地",
        "protocol": "local_hunyuan",
        "batch_group": "local_optional",
        "billing_category": "local_free",
        "billing_label": "本地免费（Apache-2.0，零云端费用，支持断网离线翻译）",
        "estimated_unit_cost_cny_per_1k_tokens": 0.0,
        "default_base_url": "http://127.0.0.1:8081/v1",
        "default_model": "hy-mt3-1.8b",
        "recommended_models": ["hy-mt3-1.8b"],
        "official_links": {
            "api_key_url": "https://huggingface.co/tencent/Hy-MT3-1.8B-GGUF",
            "docs_url": "https://github.com/Tencent-Hunyuan/Hy-MT3",
            "pricing_url": "https://huggingface.co/tencent/Hy-MT3-1.8B-GGUF/blob/main/README_CN.md",
        },
        "fields": [
            {"key": "local_endpoint", "label": "本地推理服务地址 (llama.cpp / Ollama)", "type": "url", "required": False, "placeholder": "http://127.0.0.1:8081/v1"},
            {"key": "local_model_path", "label": "本地模型文件路径 (GGUF)", "type": "text", "required": False, "placeholder": "models/hunyuan-mt/Hy-MT3-1.8B-Q4_K_M.gguf"},
            {"key": "model_id", "label": "本地加载模型名", "type": "model", "required": False, "placeholder": "hy-mt3-1.8b"},
        ],
        "notes": "采用腾讯混元官方 Hy-MT3 翻译指令（无通用 JSON 套壳），按需自动启动本机 127.0.0.1:8081 CUDA 推理并支持一键停止释放显存。",
    },
}

PROVIDER_ORDER = [
    "deepseek_llm",
    "gemini_llm",
    "doubao_llm",
    "custom_openai",
    "volcengine_mt",
    "google_cloud_translate",
    "hunyuan_mt3_local",
]


def _mask_secret(secret: str) -> str:
    s = (secret or "").strip()
    if not s:
        return ""
    if len(s) <= 8:
        return "*" * len(s)
    return f"{s[:4]}****{s[-4:]}"


def _load_raw_store() -> dict[str, Any]:
    if not CONFIG_FILE.exists():
        return {"default_engine_id": "", "providers": {}}
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("default_engine_id", "")
            data.setdefault("providers", {})
            return data
    except Exception:
        pass
    return {"default_engine_id": "", "providers": {}}


def _save_raw_store(store: dict[str, Any]) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")


def _get_billing_policy() -> dict[str, Any]:
    conn = get_conn()
    try:
        rows = {
            r["key"]: r["value"]
            for r in conn.execute(
                "SELECT key, value FROM app_settings WHERE key LIKE 'translation_%'"
            ).fetchall()
        }
    finally:
        conn.close()
    mode = rows.get("translation_billing_mode", "free_only")
    if mode not in ("free_only", "authorized_paid"):
        mode = "free_only"
    try:
        char_limit = max(0, int(rows.get("translation_monthly_char_limit", "500000")))
    except ValueError:
        char_limit = 500000
    try:
        budget_cny = max(0.0, float(rows.get("translation_monthly_budget_cny", "20")))
    except ValueError:
        budget_cny = 20.0
    return {
        "billing_mode": mode,
        "auto_translate": rows.get("translation_auto_translate", "0") == "1",
        "monthly_char_limit": char_limit,
        "monthly_budget_cny": budget_cny,
        "default_target_lang": rows.get("translation_default_target_lang", "zh-CN") or "zh-CN",
    }


def save_billing_policy(
    billing_mode: Optional[str] = None,
    auto_translate: Optional[bool] = None,
    monthly_char_limit: Optional[int] = None,
    monthly_budget_cny: Optional[float] = None,
    default_target_lang: Optional[str] = None,
) -> dict[str, Any]:
    conn = get_conn()
    try:
        updates: dict[str, str] = {}
        if billing_mode in ("free_only", "authorized_paid"):
            updates["translation_billing_mode"] = billing_mode
        if auto_translate is not None:
            updates["translation_auto_translate"] = "1" if auto_translate else "0"
        if monthly_char_limit is not None:
            updates["translation_monthly_char_limit"] = str(max(0, int(monthly_char_limit)))
        if monthly_budget_cny is not None:
            updates["translation_monthly_budget_cny"] = str(round(max(0.0, float(monthly_budget_cny)), 2))
        if default_target_lang:
            updates["translation_default_target_lang"] = default_target_lang.strip()
        for k, v in updates.items():
            conn.execute(
                "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, v),
            )
        conn.commit()
    finally:
        conn.close()
    return _get_billing_policy()


def get_monthly_usage_summary() -> dict[str, Any]:
    """统计本月翻译字符数、Token 数、估算费用与缓存命中次数。"""
    month_prefix = datetime.now().strftime("%Y-%m")
    conn = get_conn()
    try:
        row = conn.execute(
            """SELECT
                 COUNT(*) AS total_calls,
                 SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS cache_hits,
                 COALESCE(SUM(source_chars), 0) AS source_chars,
                 COALESCE(SUM(target_chars), 0) AS target_chars,
                 COALESCE(SUM(total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(estimated_cost_cny), 0.0) AS estimated_cost_cny
               FROM translation_usage_logs
               WHERE created_at LIKE ? AND status = 'ok'""",
            (f"{month_prefix}%",),
        ).fetchone()
        by_engine = [
            dict(r)
            for r in conn.execute(
                """SELECT engine_id,
                          COUNT(*) AS calls,
                          SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS cache_hits,
                          COALESCE(SUM(source_chars), 0) AS source_chars,
                          COALESCE(SUM(total_tokens), 0) AS total_tokens,
                          COALESCE(SUM(estimated_cost_cny), 0.0) AS estimated_cost_cny
                   FROM translation_usage_logs
                   WHERE created_at LIKE ? AND status = 'ok'
                   GROUP BY engine_id""",
                (f"{month_prefix}%",),
            ).fetchall()
        ]
    finally:
        conn.close()
    return {
        "month": month_prefix,
        "total_calls": int(row["total_calls"] or 0),
        "cache_hits": int(row["cache_hits"] or 0),
        "source_chars": int(row["source_chars"] or 0),
        "target_chars": int(row["target_chars"] or 0),
        "total_tokens": int(row["total_tokens"] or 0),
        "estimated_cost_cny": round(float(row["estimated_cost_cny"] or 0.0), 4),
        "by_engine": by_engine,
    }


def _log_usage(
    engine_id: str,
    model_id: str,
    operation_type: str,
    billing_mode: str,
    content_id: Optional[int] = None,
    source_chars: int = 0,
    target_chars: int = 0,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    estimated_cost_cny: float = 0.0,
    cache_hit: bool = False,
    status: str = "ok",
    error_message: str = "",
) -> None:
    conn = get_conn()
    try:
        conn.execute(
            """INSERT INTO translation_usage_logs
               (content_id, engine_id, model_id, billing_mode, operation_type,
                source_chars, target_chars, prompt_tokens, completion_tokens, total_tokens,
                estimated_cost_cny, cache_hit, status, error_message)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                content_id,
                engine_id,
                model_id,
                billing_mode,
                operation_type,
                int(source_chars),
                int(target_chars),
                int(prompt_tokens),
                int(completion_tokens),
                int(total_tokens),
                round(float(estimated_cost_cny), 6),
                1 if cache_hit else 0,
                status,
                (error_message or "")[:500],
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _resolve_provider_runtime_config(engine_id: str) -> dict[str, Any]:
    """仅在后端内部解析指定服务商的运行时凭据（严禁透传前端、严禁跨商混用）。"""
    if engine_id not in PROVIDER_REGISTRY:
        raise ValueError(f"未知翻译引擎：{engine_id}")
    meta = PROVIDER_REGISTRY[engine_id]
    store = _load_raw_store()
    saved = store.get("providers", {}).get(engine_id, {}) or {}

    cfg: dict[str, Any] = {
        "engine_id": engine_id,
        "base_url": (saved.get("base_url") or meta["default_base_url"]).strip(),
        "model_id": (saved.get("model_id") or meta["default_model"]).strip(),
        "region": (saved.get("region") or "cn-north-1").strip(),
        "local_endpoint": (saved.get("local_endpoint") or meta["default_base_url"]).strip(),
        "local_model_path": (saved.get("local_model_path") or "").strip(),
        "api_key": "",
        "access_key_id": "",
        "secret_access_key": "",
        "secret_source": "none",
        "saved_at": saved.get("saved_at", ""),
        "last_test_ok": saved.get("last_test_ok"),
        "last_test_at": saved.get("last_test_at", ""),
        "last_test_message": saved.get("last_test_message", ""),
    }

    # 独立解密当前 engine_id 专属加密凭据
    for secret_field in ("api_key", "access_key_id", "secret_access_key"):
        enc_val = saved.get(f"{secret_field}_enc") or ""
        if enc_val:
            try:
                cfg[secret_field] = _dpapi_decrypt(enc_val).strip()
                if cfg[secret_field]:
                    cfg["secret_source"] = "dpapi_vault"
            except Exception:
                cfg[secret_field] = ""

    # 仅允许 DeepSeek 复用 .env 中已配置的 DeepSeek 密钥（绝不跨服务商复用）
    if engine_id == "deepseek_llm" and not cfg["api_key"]:
        env_cfg = get_env_config()
        env_base = (env_cfg.get("llm_base_url") or "").lower()
        env_key = (os.getenv("LLM_API_KEY") or "").strip()
        if not env_key:
            # 读 .env 文件兜底
            env_path = Path(DATA_DIR).parent / ".env"
            if env_path.exists():
                for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                    if line.strip().startswith("LLM_API_KEY="):
                        env_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
        if env_key and ("deepseek" in env_base or not env_base):
            cfg["api_key"] = env_key
            cfg["secret_source"] = "env_deepseek"
            if not saved.get("base_url") and env_cfg.get("llm_base_url"):
                cfg["base_url"] = env_cfg["llm_base_url"]
            if not saved.get("model_id") and env_cfg.get("llm_model"):
                cfg["model_id"] = env_cfg["llm_model"]

    return cfg


def _is_provider_configured(engine_id: str, cfg: dict[str, Any]) -> bool:
    protocol = PROVIDER_REGISTRY[engine_id]["protocol"]
    if protocol == "openai_compatible":
        return bool(cfg["api_key"] and cfg["base_url"])
    if protocol == "volcengine_mt_v4":
        return bool(cfg["access_key_id"] and cfg["secret_access_key"])
    if protocol == "google_translate_v2":
        return bool(cfg["api_key"])
    if protocol == "local_hunyuan":
        from backend.services import local_translation_wizard as lw

        return bool(lw.inspect_local_environment().get("ready_for_translation"))
    return False


def get_translation_overview() -> dict[str, Any]:
    """返回前端展示所需的脱敏配置总览（绝不包含任何明文密钥）。"""
    store = _load_raw_store()
    default_engine_id = store.get("default_engine_id") or ""
    providers_out = []

    for eid in PROVIDER_ORDER:
        meta = PROVIDER_REGISTRY[eid]
        cfg = _resolve_provider_runtime_config(eid)
        configured = _is_provider_configured(eid, cfg)
        last_test_ok = cfg["last_test_ok"]
        last_test_at = cfg["last_test_at"]
        last_test_message = cfg["last_test_message"]
        # FIX-F04: 若本地混元当前实际服务地址已更新（如 8081），自动屏蔽旧地址（如 11434）过期报错，历史仍保留在 test_history 中
        if eid == "hunyuan_mt3_local" and last_test_ok is False and last_test_message:
            cur_ep = (cfg.get("local_endpoint") or meta["default_base_url"]).strip()
            if ("11434" in last_test_message and "11434" not in cur_ep) or configured:
                last_test_ok = None
                last_test_message = ""
                last_test_at = ""
        providers_out.append(
            {
                "engine_id": eid,
                "name": meta["name"],
                "short_name": meta["short_name"],
                "protocol": meta["protocol"],
                "batch_group": meta["batch_group"],
                "billing_category": meta["billing_category"],
                "billing_label": meta["billing_label"],
                "default_base_url": meta["default_base_url"],
                "default_model": meta["default_model"],
                "recommended_models": meta["recommended_models"],
                "official_links": meta["official_links"],
                "fields": meta["fields"],
                "notes": meta["notes"],
                "configured": configured,
                "is_default": eid == default_engine_id,
                "secret_source": cfg["secret_source"],
                "config": {
                    "base_url": cfg["base_url"],
                    "model_id": cfg["model_id"],
                    "region": cfg["region"],
                    "local_endpoint": cfg["local_endpoint"],
                    "local_model_path": cfg["local_model_path"],
                    "has_api_key": bool(cfg["api_key"]),
                    "api_key_masked": _mask_secret(cfg["api_key"]),
                    "has_access_key_id": bool(cfg["access_key_id"]),
                    "access_key_id_masked": _mask_secret(cfg["access_key_id"]),
                    "has_secret_access_key": bool(cfg["secret_access_key"]),
                    "secret_access_key_masked": _mask_secret(cfg["secret_access_key"]),
                    "saved_at": cfg["saved_at"],
                    "last_test_ok": last_test_ok,
                    "last_test_at": last_test_at,
                    "last_test_message": last_test_message,
                },
            }
        )

    return {
        "default_engine_id": default_engine_id,
        "needs_initial_setup": not bool(default_engine_id),
        "policy": _get_billing_policy(),
        "usage": get_monthly_usage_summary(),
        "providers": providers_out,
    }


def save_provider_config(engine_id: str, payload: dict[str, Any], set_as_default: bool = False) -> dict[str, Any]:
    """保存指定服务商配置；密钥使用 Windows DPAPI 加密落盘，空字符串保持原密钥不变。"""
    if engine_id not in PROVIDER_REGISTRY:
        raise ValueError(f"不支持的翻译引擎：{engine_id}")

    store = _load_raw_store()
    providers = store.setdefault("providers", {})
    cur = providers.get(engine_id, {}) or {}

    endpoint_changed = False
    for text_field in ("base_url", "model_id", "region", "local_endpoint", "local_model_path"):
        if text_field in payload and payload[text_field] is not None:
            new_val = str(payload[text_field]).strip()
            if cur.get(text_field) != new_val:
                endpoint_changed = True
            cur[text_field] = new_val

    # FIX-F04: 配置地址或模型变更后归档历史测试日志并清理过期报错，避免旧地址错误继续污染当前状态
    if endpoint_changed and cur.get("last_test_message"):
        hist = cur.setdefault("test_history", [])
        if isinstance(hist, list):
            hist.append({
                "ok": cur.get("last_test_ok"),
                "at": cur.get("last_test_at") or "",
                "message": cur.get("last_test_message") or "",
            })
            cur["test_history"] = hist[-20:]
        cur["last_test_ok"] = None
        cur["last_test_at"] = ""
        cur["last_test_message"] = ""

    for secret_field in ("api_key", "access_key_id", "secret_access_key"):
        val = payload.get(secret_field)
        if val is not None:
            s = str(val).strip()
            if s and "****" not in s:
                cur[f"{secret_field}_enc"] = _dpapi_encrypt(s)
            elif payload.get(f"clear_{secret_field}"):
                cur.pop(f"{secret_field}_enc", None)

    cur["saved_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    providers[engine_id] = cur

    if set_as_default:
        store["default_engine_id"] = engine_id

    _save_raw_store(store)
    return get_translation_overview()


def set_default_engine(engine_id: str) -> dict[str, Any]:
    if engine_id not in PROVIDER_REGISTRY:
        raise ValueError(f"不支持的翻译引擎：{engine_id}")
    store = _load_raw_store()
    store["default_engine_id"] = engine_id
    _save_raw_store(store)
    return get_translation_overview()


def _record_test_status(engine_id: str, ok: bool, message: str) -> None:
    store = _load_raw_store()
    cur = store.setdefault("providers", {}).setdefault(engine_id, {})
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    hist = cur.setdefault("test_history", [])
    if isinstance(hist, list):
        hist.append({"ok": ok, "at": now_str, "message": message[:300]})
        cur["test_history"] = hist[-20:]
    cur["last_test_ok"] = ok
    cur["last_test_at"] = now_str
    cur["last_test_message"] = message[:300]
    _save_raw_store(store)


def clear_stale_test_status(engine_id: str, ok: Optional[bool] = None, message: str = "") -> None:
    """FIX-F04: 归档旧测试状态至 test_history 后更新或清空当前提示，防止过期错误残留。"""
    store = _load_raw_store()
    cur = store.setdefault("providers", {}).setdefault(engine_id, {})
    if cur.get("last_test_message"):
        hist = cur.setdefault("test_history", [])
        if isinstance(hist, list):
            hist.append({
                "ok": cur.get("last_test_ok"),
                "at": cur.get("last_test_at") or "",
                "message": cur.get("last_test_message") or "",
            })
            cur["test_history"] = hist[-20:]
    cur["last_test_ok"] = ok
    cur["last_test_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S") if message else ""
    cur["last_test_message"] = message[:300] if message else ""
    _save_raw_store(store)


# ==================== 费用与预算门禁 ====================
def _check_billing_gate(engine_id: str, estimated_chars: int = 0) -> tuple[bool, str]:
    """根据当前费用策略检查是否允许执行翻译调用。"""
    meta = PROVIDER_REGISTRY[engine_id]
    policy = _get_billing_policy()
    usage = get_monthly_usage_summary()
    billing_cat = meta["billing_category"]

    # 本地免费模型不受云端预算限制
    if billing_cat == "local_free":
        return True, ""

    # 仅允许免费模式：拦截按量付费云端大模型
    if policy["billing_mode"] == "free_only":
        if billing_cat not in ("local_free", "free_quota"):
            return (
                False,
                f"当前处于「仅允许免费模式 (free_only)」，已阻止调用按量付费引擎「{meta['name']}」。"
                "如需使用，请在「设置 → 翻译引擎与费用控制」中显式切换为「用户授权付费模式」，或改选本地/免费额度引擎。",
            )

    # 月度字符上限检查
    char_limit = policy["monthly_char_limit"]
    if char_limit > 0 and (usage["source_chars"] + estimated_chars) > char_limit:
        return (
            False,
            f"已达本月翻译字符上限（已用 {usage['source_chars']} / 上限 {char_limit} 字符）。"
            "系统已自动停止翻译，可在费用控制面板调整限额或切换本地引擎。",
        )

    # 月度预算上限检查（仅对付费模式生效）
    budget_cny = policy["monthly_budget_cny"]
    if policy["billing_mode"] == "authorized_paid" and budget_cny > 0 and usage["estimated_cost_cny"] >= budget_cny:
        return (
            False,
            f"已达本月预算上限（估算已用 ¥{usage['estimated_cost_cny']:.2f} / 上限 ¥{budget_cny:.2f}）。"
            "系统已自动停止付费调用，请人工调整预算或选择备用引擎。",
        )

    return True, ""


# ==================== 火山引擎原生 V4 签名适配器 ====================
def _volc_sign_headers(
    access_key: str,
    secret_key: str,
    region: str,
    service: str,
    host: str,
    query_str: str,
    body_bytes: bytes,
) -> dict[str, str]:
    """火山引擎 OpenAPI V4 HMAC-SHA256 签名实现（零第三方依赖）。"""
    now = datetime.now(timezone.utc)
    x_date = now.strftime("%Y%m%dT%H%M%SZ")
    short_date = now.strftime("%Y%m%d")
    content_type = "application/json"
    x_content_sha256 = hashlib.sha256(body_bytes).hexdigest()

    canonical_headers = (
        f"content-type:{content_type}\n"
        f"host:{host}\n"
        f"x-content-sha256:{x_content_sha256}\n"
        f"x-date:{x_date}\n"
    )
    signed_headers = "content-type;host;x-content-sha256;x-date"
    canonical_request = "\n".join(
        ["POST", "/", query_str, canonical_headers, signed_headers, x_content_sha256]
    )
    credential_scope = f"{short_date}/{region}/{service}/request"
    string_to_sign = "\n".join(
        [
            "HMAC-SHA256",
            x_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )

    def _hmac_sha256(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    k_date = _hmac_sha256(secret_key.encode("utf-8"), short_date)
    k_region = _hmac_sha256(k_date, region)
    k_service = _hmac_sha256(k_region, service)
    k_signing = _hmac_sha256(k_service, "request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return {
        "Content-Type": content_type,
        "Host": host,
        "X-Date": x_date,
        "X-Content-Sha256": x_content_sha256,
        "Authorization": authorization,
    }


def _volcengine_mt_translate_list(
    cfg: dict[str, Any],
    texts: list[str],
    source_lang: str,
    target_lang: str,
) -> list[str]:
    base_url = cfg["base_url"].rstrip("/")
    parsed = urllib.parse.urlparse(base_url)
    host = parsed.netloc or "translate.volcengineapi.com"
    query_str = "Action=TranslateText&Version=2020-06-01"
    tgt = "zh" if target_lang.lower().startswith("zh") else target_lang
    payload: dict[str, Any] = {
        "TargetLanguage": tgt,
        "TextList": texts,
    }
    if source_lang and source_lang not in ("auto", "unknown"):
        payload["SourceLanguage"] = source_lang.split("-")[0]
    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = _volc_sign_headers(
        access_key=cfg["access_key_id"],
        secret_key=cfg["secret_access_key"],
        region=cfg["region"] or "cn-north-1",
        service="translate",
        host=host,
        query_str=query_str,
        body_bytes=body_bytes,
    )
    req = urllib.request.Request(f"{base_url}/?{query_str}", data=body_bytes, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    meta_err = (data.get("ResponseMetadata") or {}).get("Error")
    if meta_err:
        raise RuntimeError(f"火山引擎返回错误：{meta_err.get('Code')} - {meta_err.get('Message')}")
    items = data.get("TranslationList") or []
    if len(items) != len(texts):
        raise RuntimeError(f"火山引擎返回段数不匹配（预期 {len(texts)}，实际 {len(items)}）")
    return [str(it.get("Translation") or "") for it in items]


# ==================== Google Cloud Translation Basic REST v2 适配器 ====================
def _google_v2_translate_list(
    cfg: dict[str, Any],
    texts: list[str],
    source_lang: str,
    target_lang: str,
) -> list[str]:
    base_url = cfg["base_url"].rstrip("/")
    tgt = "zh-CN" if target_lang.lower().startswith("zh") else target_lang
    url = f"{base_url}?key={urllib.parse.quote(cfg['api_key'])}"
    payload: dict[str, Any] = {
        "q": texts,
        "target": tgt,
        "format": "text",
        "model": cfg.get("model_id") or "nmt",
    }
    if source_lang and source_lang not in ("auto", "unknown"):
        payload["source"] = source_lang.split("-")[0]
    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body_bytes,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "error" in data:
        err = data["error"]
        raise RuntimeError(f"Google Cloud Translation v2 错误：{err.get('code')} - {err.get('message')}")
    translations = (data.get("data") or {}).get("translations") or []
    if len(translations) != len(texts):
        raise RuntimeError(f"Google v2 返回段数不匹配（预期 {len(texts)}，实际 {len(translations)}）")
    return [str(t.get("translatedText") or "") for t in translations]


# ==================== 连接测试（零翻译费）与拉取模型列表 ====================
def _http_get_json(url: str, headers: Optional[dict[str, str]] = None, timeout: int = 10) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def test_provider_connection(engine_id: str) -> dict[str, Any]:
    """测试连接（不执行付费翻译，不消耗翻译字符/Token）。"""
    if engine_id not in PROVIDER_REGISTRY:
        raise ValueError(f"未知翻译引擎：{engine_id}")
    meta = PROVIDER_REGISTRY[engine_id]
    cfg = _resolve_provider_runtime_config(engine_id)
    protocol = meta["protocol"]

    try:
        if protocol == "openai_compatible":
            if not cfg["api_key"]:
                msg = f"未配置 {meta['name']} API Key，无法测试连接。"
                _record_test_status(engine_id, False, msg)
                return {"ok": False, "engine_id": engine_id, "message": msg, "models": []}
            models_url = cfg["base_url"].rstrip("/") + "/models"
            data = _http_get_json(models_url, headers={"Authorization": f"Bearer {cfg['api_key']}"}, timeout=12)
            models = [m.get("id") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")]
            msg = f"连接成功（未产生翻译费用），检测到 {len(models)} 个可用模型。"
            _record_test_status(engine_id, True, msg)
            return {"ok": True, "engine_id": engine_id, "message": msg, "models": models[:60]}

        if protocol == "google_translate_v2":
            if not cfg["api_key"]:
                msg = "未配置 Google Cloud API Key。"
                _record_test_status(engine_id, False, msg)
                return {"ok": False, "engine_id": engine_id, "message": msg, "models": []}
            lang_url = cfg["base_url"].rstrip("/") + f"/languages?key={urllib.parse.quote(cfg['api_key'])}"
            data = _http_get_json(lang_url, timeout=12)
            langs = (data.get("data") or {}).get("languages") or []
            msg = f"Google Cloud Translation Basic v2 连接成功（零翻译费），支持 {len(langs)} 种语言。"
            _record_test_status(engine_id, True, msg)
            return {"ok": True, "engine_id": engine_id, "message": msg, "models": meta["recommended_models"]}

        if protocol == "volcengine_mt_v4":
            if not (cfg["access_key_id"] and cfg["secret_access_key"]):
                msg = "未完整配置火山引擎 AccessKey ID 与 SecretAccessKey。"
                _record_test_status(engine_id, False, msg)
                return {"ok": False, "engine_id": engine_id, "message": msg, "models": []}
            # 使用火山 LangDetect（仅语言识别探测，不计字符翻译费；若签名错误直接返回鉴权报错）
            base_url = cfg["base_url"].rstrip("/")
            host = urllib.parse.urlparse(base_url).netloc or "translate.volcengineapi.com"
            query_str = "Action=LangDetect&Version=2020-06-01"
            body_bytes = json.dumps({"TextList": ["hello"]}).encode("utf-8")
            headers = _volc_sign_headers(
                cfg["access_key_id"],
                cfg["secret_access_key"],
                cfg["region"] or "cn-north-1",
                "translate",
                host,
                query_str,
                body_bytes,
            )
            req = urllib.request.Request(f"{base_url}/?{query_str}", data=body_bytes, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            meta_err = (data.get("ResponseMetadata") or {}).get("Error")
            if meta_err:
                raise RuntimeError(f"{meta_err.get('Code')}: {meta_err.get('Message')}")
            msg = "火山引擎机器翻译 V4 签名鉴权与连通性测试成功。"
            _record_test_status(engine_id, True, msg)
            return {"ok": True, "engine_id": engine_id, "message": msg, "models": meta["recommended_models"]}

        if protocol == "local_hunyuan":
            from backend.services import local_translation_wizard as lw

            env = lw.inspect_local_environment()
            if env["service_online"]:
                msg = f"本地混元 GPU 推理服务在线（{env['active_endpoint']} · 模型：{env['deployment']['loaded_model_name']} · {env['deployment']['compute_mode']}）。"
                _record_test_status(engine_id, True, msg)
                return {
                    "ok": True,
                    "installed": True,
                    "engine_id": engine_id,
                    "message": msg,
                    "models": env["detected_models"],
                }
            if env["installed_on_demand"]:
                started = lw.ensure_local_service_running()
                if started.get("ok"):
                    fresh = started["env"]
                    msg = f"已按需启动本地混元推理服务（{started['endpoint']} · 模型：{started['model_id']} · {fresh['deployment']['compute_mode']}）。"
                    _record_test_status(engine_id, True, msg)
                    return {
                        "ok": True,
                        "installed": True,
                        "engine_id": engine_id,
                        "message": msg,
                        "models": fresh["detected_models"],
                    }
                msg = started.get("message") or "本地混元推理服务启动失败"
                _record_test_status(engine_id, False, msg)
                return {"ok": False, "installed": True, "engine_id": engine_id, "message": msg, "models": []}
            msg = (
                "未安装腾讯混元 Hy-MT3-1.8B 本地模型或推理环境。"
                "请先在上方安装向导中完成授权安装。"
            )
            _record_test_status(engine_id, False, msg)
            return {"ok": False, "installed": False, "engine_id": engine_id, "message": msg, "models": []}

    except urllib.error.HTTPError as he:
        err_body = ""
        try:
            err_body = he.read().decode("utf-8", errors="ignore")[:240]
        except Exception:
            pass
        msg = f"连接失败（HTTP {he.code}）：{err_body or he.reason}"
        _record_test_status(engine_id, False, msg)
        return {"ok": False, "engine_id": engine_id, "message": msg, "models": []}
    except Exception as e:
        msg = f"连接失败：{e}"
        _record_test_status(engine_id, False, msg)
        return {"ok": False, "engine_id": engine_id, "message": msg, "models": []}

    return {"ok": False, "engine_id": engine_id, "message": "未支持的协议", "models": []}


def fetch_provider_models(engine_id: str) -> dict[str, Any]:
    """获取模型列表（优先拉取实时 /models，失败时附带官方推荐模型供选择，并支持手动填写）。"""
    if engine_id not in PROVIDER_REGISTRY:
        raise ValueError(f"未知翻译引擎：{engine_id}")
    meta = PROVIDER_REGISTRY[engine_id]
    res = test_provider_connection(engine_id)
    merged = list(dict.fromkeys((res.get("models") or []) + meta["recommended_models"]))
    return {
        "ok": res["ok"],
        "engine_id": engine_id,
        "live_models": res.get("models") or [],
        "recommended_models": meta["recommended_models"],
        "models": merged,
        "message": res.get("message", ""),
    }


# ==================== 分批带上下文 LLM 字幕翻译核心 ====================
def _parse_json_translations(raw_content: str, expected_indices: list[int]) -> dict[int, str]:
    """严格解析模型返回的 [{"idx": int, "zh": str}]，确保按 segment_idx 精准对齐。"""
    text = (raw_content or "").strip()
    # 剥离 ```json 代码块
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        text = m.group(1).strip()

    parsed = None
    try:
        parsed = json.loads(text)
    except Exception:
        # 尝试截取最外层 [ ... ] 或 { ... }
        arr_m = re.search(r"\[[\s\S]*\]", text)
        if arr_m:
            try:
                parsed = json.loads(arr_m.group(0))
            except Exception:
                parsed = None

    result: dict[int, str] = {}
    if isinstance(parsed, dict):
        items = parsed.get("translations") or parsed.get("items") or parsed.get("segments") or []
    elif isinstance(parsed, list):
        items = parsed
    else:
        items = []

    expected_set = set(expected_indices)
    for it in items:
        if not isinstance(it, dict):
            continue
        idx_raw = it.get("idx", it.get("index", it.get("segment_idx")))
        zh_raw = it.get("zh", it.get("translation", it.get("translated_text", it.get("text"))))
        if idx_raw is None or zh_raw is None:
            continue
        try:
            idx_int = int(idx_raw)
        except (TypeError, ValueError):
            continue
        if idx_int in expected_set:
            zh_clean = str(zh_raw).strip()
            if zh_clean:
                result[idx_int] = zh_clean
    return result


def _hunyuan_mt3_translate_single(
    client: OpenAI,
    model_id: str,
    text: str,
    target_lang: str,
) -> tuple[str, int, int]:
    """严格遵循腾讯混元 Hy-MT3-1.8B 官方 Default Translation Prompt（无 system_prompt，纯译文输出）。"""
    target_label = "中文" if target_lang.lower().startswith("zh") else target_lang
    prompt = f"将以下文本翻译为{target_label}，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}"
    resp = client.chat.completions.create(
        model=model_id,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        top_p=0.6,
        max_tokens=2048,
        extra_body={"top_k": 20, "repeat_penalty": 1.05},
    )
    out = (resp.choices[0].message.content or "").strip()
    p_tok = int(getattr(resp.usage, "prompt_tokens", 0) or 0)
    c_tok = int(getattr(resp.usage, "completion_tokens", 0) or 0)
    return out, p_tok, c_tok


def _hunyuan_mt3_translate_batch(
    cfg: dict[str, Any],
    batch: list[dict[str, Any]],
    source_lang: str,
    target_lang: str,
) -> tuple[dict[int, str], int, int]:
    """使用混元 Hy-MT3 官方 Delimiters 分隔符对齐指令批量翻译字幕；若分隔符数偶发偏差则自动逐条兜底确保 100% 对齐。"""
    client = OpenAI(api_key="local-no-key", base_url=cfg["base_url"], timeout=120.0)
    model_id = cfg["model_id"] or "hy-mt3-1.8b"
    target_label = "中文" if target_lang.lower().startswith("zh") else target_lang
    total_p = 0
    total_c = 0

    if len(batch) == 1:
        zh, p, c = _hunyuan_mt3_translate_single(client, model_id, batch[0]["source_text"], target_lang)
        return ({batch[0]["segment_idx"]: zh} if zh else {}), p, c

    delim = " ||| "
    cleaned_sources = [re.sub(r"\s*\|\|\|\s*", " ", (it["source_text"] or "").strip()) for it in batch]
    joined = delim.join(cleaned_sources)
    prompt = (
        f"请将以下文本准确翻译为{target_label}。\n"
        "你必须在译文中保留等量的分隔符 |||，绝对不可遗漏、转义或翻译该符号，并注意分隔符的位置。"
        "注意只需要输出翻译后的结果，不要额外解释：\n\n"
        f"{joined}"
    )
    resp = client.chat.completions.create(
        model=model_id,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        top_p=0.6,
        max_tokens=2048,
        extra_body={"top_k": 20, "repeat_penalty": 1.05},
    )
    raw = (resp.choices[0].message.content or "").strip()
    total_p += int(getattr(resp.usage, "prompt_tokens", 0) or 0)
    total_c += int(getattr(resp.usage, "completion_tokens", 0) or 0)

    parts = [p.strip() for p in raw.split("|||")]
    if len(parts) == len(batch) and all(parts):
        return {batch[i]["segment_idx"]: parts[i] for i in range(len(batch))}, total_p, total_c

    # 分隔符数量未严格对齐时，自动逐条用官方单句 Prompt 精准翻译，绝不发生时间轴错位
    result: dict[int, str] = {}
    for it in batch:
        zh, p, c = _hunyuan_mt3_translate_single(client, model_id, it["source_text"], target_lang)
        total_p += p
        total_c += c
        if zh:
            result[it["segment_idx"]] = zh
    return result, total_p, total_c


def _openai_translate_batch(
    cfg: dict[str, Any],
    batch: list[dict[str, Any]],
    prev_context: list[dict[str, str]],
    source_lang: str,
    target_lang: str,
) -> tuple[dict[int, str], int, int]:
    """调用 OpenAI 兼容接口分批翻译字幕，严格保留每条 idx，不允许合并段落。"""
    client = OpenAI(api_key=cfg["api_key"] or "local-no-key", base_url=cfg["base_url"], timeout=60.0)
    target_label = "简体中文" if target_lang.lower().startswith("zh") else target_lang
    ctx_block = ""
    if prev_context:
        ctx_lines = [f"- 原文: {c['src']} => 译文: {c['zh']}" for c in prev_context[-2:]]
        ctx_block = "【前文参考（仅用于保持术语与语气连贯，切勿输出在结果中）】\n" + "\n".join(ctx_lines) + "\n\n"

    items_payload = [{"idx": item["segment_idx"], "text": item["source_text"]} for item in batch]
    prompt = (
        f"你是专业纪录片与视频双语字幕翻译专家。请将以下 {source_lang or '外语'} 视频字幕逐段翻译为自然、准确、口语化的{target_label}。\n"
        "严格遵守以下规则：\n"
        "1. 必须一对一保留每条字幕的 idx，绝对不能合并、拆分、漏译或错位。\n"
        "2. 仅输出合法 JSON 数组，格式为：[{\"idx\": 0, \"zh\": \"中文译文\"}, ...]，不要输出任何多余解释。\n"
        "3. 保留专有名词准确译法（医院、地名、金额、医学术语准确）。\n\n"
        f"{ctx_block}"
        f"【待翻译字幕（共 {len(items_payload)} 条）】\n"
        f"{json.dumps(items_payload, ensure_ascii=False)}"
    )

    resp = client.chat.completions.create(
        model=cfg["model_id"],
        messages=[
            {"role": "system", "content": "你是严谨的字幕时间轴对齐翻译引擎，只输出严格对齐 idx 的 JSON 数组。"},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
    )
    content = resp.choices[0].message.content or ""
    p_tok = int(getattr(resp.usage, "prompt_tokens", 0) or 0)
    c_tok = int(getattr(resp.usage, "completion_tokens", 0) or 0)
    expected = [item["segment_idx"] for item in batch]
    mapping = _parse_json_translations(content, expected)
    return mapping, p_tok, c_tok


def test_translate_sample(
    engine_id: str,
    sample_text: str = "Why are patients flying to Shanghai for medical checkups?",
    target_lang: str = "zh-CN",
) -> dict[str, Any]:
    """显式小段文本翻译测试（消耗少量翻译额度/Token，受费用门禁严格控制）。"""
    if engine_id not in PROVIDER_REGISTRY:
        raise ValueError(f"未知翻译引擎：{engine_id}")
    meta = PROVIDER_REGISTRY[engine_id]
    cfg = _resolve_provider_runtime_config(engine_id)
    policy = _get_billing_policy()

    allowed, reason = _check_billing_gate(engine_id, estimated_chars=len(sample_text))
    if not allowed:
        _log_usage(
            engine_id=engine_id,
            model_id=cfg["model_id"],
            operation_type="sample_test",
            billing_mode=policy["billing_mode"],
            source_chars=len(sample_text),
            status="blocked",
            error_message=reason,
        )
        return {"ok": False, "blocked_by_policy": True, "engine_id": engine_id, "message": reason}

    protocol = meta["protocol"]
    t0 = time.time()
    p_tok = c_tok = 0
    translated = ""

    try:
        if protocol in ("openai_compatible", "local_hunyuan"):
            if protocol == "openai_compatible" and not cfg["api_key"]:
                return {"ok": False, "engine_id": engine_id, "message": f"未配置 {meta['name']} API Key"}
            if protocol == "local_hunyuan":
                from backend.services import local_translation_wizard as lw

                started = lw.ensure_local_service_running()
                if not started.get("ok"):
                    return {"ok": False, "engine_id": engine_id, "message": started.get("message", "本地混元推理服务未安装或启动失败（绝不擅自切换付费 API）")}
                cfg = dict(cfg)
                cfg["base_url"] = started["endpoint"]
                cfg["model_id"] = started["model_id"]
                mapping, p_tok, c_tok = _hunyuan_mt3_translate_batch(
                    cfg,
                    [{"segment_idx": 0, "source_text": sample_text}],
                    source_lang="en",
                    target_lang=target_lang,
                )
            else:
                mapping, p_tok, c_tok = _openai_translate_batch(
                    cfg,
                    [{"segment_idx": 0, "source_text": sample_text}],
                    prev_context=[],
                    source_lang="en",
                    target_lang=target_lang,
                )
            translated = mapping.get(0, "")
            if not translated:
                raise RuntimeError("模型未返回有效译文")
        elif protocol == "volcengine_mt_v4":
            if not (cfg["access_key_id"] and cfg["secret_access_key"]):
                return {"ok": False, "engine_id": engine_id, "message": "未配置火山引擎 AccessKey / SecretKey"}
            out = _volcengine_mt_translate_list(cfg, [sample_text], "en", target_lang)
            translated = out[0]
        elif protocol == "google_translate_v2":
            if not cfg["api_key"]:
                return {"ok": False, "engine_id": engine_id, "message": "未配置 Google Cloud API Key"}
            out = _google_v2_translate_list(cfg, [sample_text], "en", target_lang)
            translated = out[0]
        else:
            raise RuntimeError(f"不支持的协议：{protocol}")

        total_tok = p_tok + c_tok
        est_cost = _estimate_cost(engine_id, len(sample_text), total_tok)
        _log_usage(
            engine_id=engine_id,
            model_id=cfg["model_id"],
            operation_type="sample_test",
            billing_mode=policy["billing_mode"],
            source_chars=len(sample_text),
            target_chars=len(translated),
            prompt_tokens=p_tok,
            completion_tokens=c_tok,
            total_tokens=total_tok,
            estimated_cost_cny=est_cost,
            status="ok",
        )
        return {
            "ok": True,
            "engine_id": engine_id,
            "model_id": cfg["model_id"],
            "source_text": sample_text,
            "translated_text": translated,
            "elapsed_ms": int((time.time() - t0) * 1000),
            "total_tokens": total_tok,
            "estimated_cost_cny": round(est_cost, 6),
        }
    except Exception as e:
        _log_usage(
            engine_id=engine_id,
            model_id=cfg["model_id"],
            operation_type="sample_test",
            billing_mode=policy["billing_mode"],
            source_chars=len(sample_text),
            status="error",
            error_message=str(e),
        )
        return {"ok": False, "engine_id": engine_id, "message": f"小段翻译测试失败：{e}"}


def _estimate_cost(engine_id: str, source_chars: int, total_tokens: int) -> float:
    meta = PROVIDER_REGISTRY[engine_id]
    if meta["billing_category"] == "local_free":
        return 0.0
    if "estimated_unit_cost_cny_per_1k_tokens" in meta and total_tokens > 0:
        return (total_tokens / 1000.0) * float(meta["estimated_unit_cost_cny_per_1k_tokens"])
    if "estimated_unit_cost_cny_per_1k_chars" in meta:
        return (source_chars / 1000.0) * float(meta["estimated_unit_cost_cny_per_1k_chars"])
    return 0.0


def _compute_source_hash(segments: list[dict[str, Any]]) -> str:
    joined = "\n".join(f"{s['start']}|{s['text']}" for s in segments)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def get_content_subtitles(content_id: int, target_lang: str = "zh-CN") -> dict[str, Any]:
    """统一读取某视频的完整字幕与双语译文（供 TopicHub 播放器字幕条与文案工坊共同复用）。"""
    conn = get_conn()
    try:
        cnt = conn.execute(
            "SELECT id, title, url, platform, duration_sec FROM contents WHERE id = ?",
            (content_id,),
        ).fetchone()
        if not cnt:
            raise ValueError(f"未找到视频作品 content_id={content_id}")
        tr = conn.execute(
            "SELECT * FROM transcripts WHERE content_id = ? ORDER BY id DESC LIMIT 1",
            (content_id,),
        ).fetchone()
        if not tr:
            return {
                "content_id": content_id,
                "title": cnt["title"],
                "url": cnt["url"],
                "video_duration_sec": cnt["duration_sec"],
                "has_transcript": False,
                "language": "",
                "target_lang": target_lang,
                "subtitle_coverage_start": None,
                "subtitle_coverage_end": None,
                "translated_count": 0,
                "total_count": 0,
                "manual_edited_count": 0,
                "engine_id": "",
                "model_id": "",
                "translated_zh": "",
                "segments": [],
            }

        raw_segs = json.loads(tr["segments_json"] or "[]")
        norm_segs, cov_start, cov_end = normalize_segments(raw_segs, cnt["duration_sec"])
        rows = conn.execute(
            """SELECT segment_idx, source_text, translated_text, start_sec, end_sec, end_source,
                      source_lang, target_lang, engine_id, model_id, source_hash, status,
                      is_manual_edited, translated_at
               FROM subtitle_translations
               WHERE content_id = ? AND target_lang = ?
               ORDER BY segment_idx ASC""",
            (content_id, target_lang),
        ).fetchall()
        trans_map = {int(r["segment_idx"]): dict(r) for r in rows}

        merged: list[dict[str, Any]] = []
        translated_count = 0
        manual_count = 0
        used_engine = tr["translation_engine"] or ""
        used_model = tr["translation_model"] or ""
        for idx, seg in enumerate(norm_segs):
            trow = trans_map.get(idx)
            zh = (trow["translated_text"] if trow else "") or ""
            status = (trow["status"] if trow else "pending") or "pending"
            is_manual = bool(trow["is_manual_edited"]) if trow else False
            if zh.strip() and status in ("translated", "manual"):
                translated_count += 1
            if is_manual:
                manual_count += 1
            if trow and trow.get("engine_id") and not used_engine:
                used_engine = trow["engine_id"]
            if trow and trow.get("model_id") and not used_model:
                used_model = trow["model_id"]
            merged.append(
                {
                    "segment_idx": idx,
                    "start": seg["start"],
                    "end": seg["end"],
                    "end_source": seg["end_source"],
                    "text": seg["text"],
                    "translated_text": zh,
                    "status": status,
                    "is_manual_edited": is_manual,
                    "engine_id": trow["engine_id"] if trow else "",
                    "model_id": trow["model_id"] if trow else "",
                    "translated_at": trow["translated_at"] if trow else None,
                }
            )

        return {
            "content_id": content_id,
            "transcript_id": tr["id"],
            "title": cnt["title"],
            "url": cnt["url"],
            "platform": cnt["platform"],
            "video_duration_sec": cnt["duration_sec"] or tr["video_duration_sec"],
            "has_transcript": True,
            "source_method": tr["extract_method"],
            "language": tr["language"] or "",
            "target_lang": target_lang,
            "subtitle_coverage_start": cov_start,
            "subtitle_coverage_end": cov_end,
            "translated_count": translated_count,
            "total_count": len(merged),
            "manual_edited_count": manual_count,
            "engine_id": used_engine,
            "model_id": used_model,
            "raw_text": tr["raw_text"] or "",
            "translated_zh": tr["translated_zh"] or "",
            "segments": merged,
        }
    finally:
        conn.close()


def update_manual_subtitle_translation(
    content_id: int,
    segment_idx: int,
    translated_text: str,
    target_lang: str = "zh-CN",
) -> dict[str, Any]:
    """人工修订单段译文并标记 is_manual_edited=1，后续重译默认不覆盖此段。"""
    sub_data = get_content_subtitles(content_id, target_lang)
    if not sub_data["has_transcript"]:
        raise ValueError("该视频尚未提取字幕")
    segs = sub_data["segments"]
    if segment_idx < 0 or segment_idx >= len(segs):
        raise ValueError(f"无效字幕段索引：{segment_idx}")
    seg = segs[segment_idx]
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    source_hash = _compute_source_hash(segs)

    conn = get_conn()
    try:
        conn.execute(
            """INSERT INTO subtitle_translations
               (content_id, segment_idx, source_text, translated_text, start_sec, end_sec, end_source,
                source_lang, target_lang, engine_id, model_id, source_hash, status, is_manual_edited, translated_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?)
               ON CONFLICT(content_id, segment_idx, target_lang) DO UPDATE SET
                 translated_text = excluded.translated_text,
                 status = 'manual',
                 is_manual_edited = 1,
                 updated_at = excluded.updated_at""",
            (
                content_id,
                segment_idx,
                seg["text"],
                translated_text.strip(),
                seg["start"],
                seg["end"],
                seg["end_source"],
                sub_data["language"],
                target_lang,
                seg.get("engine_id") or "manual",
                seg.get("model_id") or "manual",
                source_hash,
                now_str,
                now_str,
            ),
        )
        # 同步重建 transcripts.translated_zh 保证文案工坊全文一致
        all_rows = conn.execute(
            """SELECT translated_text FROM subtitle_translations
               WHERE content_id = ? AND target_lang = ?
               ORDER BY segment_idx ASC""",
            (content_id, target_lang),
        ).fetchall()
        full_zh = "\n".join(r["translated_text"].strip() for r in all_rows if (r["translated_text"] or "").strip())
        conn.execute(
            "UPDATE transcripts SET translated_zh = ? WHERE id = ?",
            (full_zh, sub_data["transcript_id"]),
        )
        conn.commit()
    finally:
        conn.close()
    return get_content_subtitles(content_id, target_lang)


def translate_content_segments(
    content_id: int,
    target_lang: str = "zh-CN",
    engine_id: Optional[str] = None,
    force_retranslate: bool = False,
    overwrite_manual: bool = False,
) -> dict[str, Any]:
    """统一逐段带上下文翻译并落库复用：
    - 默认优先命中缓存（同一 content_id + target_lang + source_hash 且全部段落已译）；
    - 默认保护 is_manual_edited = 1 的人工修订段不被覆盖；
    - 严格受费用控制门禁（free_only / authorized_paid / 月度限额）约束；
    - 同一份译文同时服务文案工坊全文、逐段双语对照与 TopicHub 播放双语字幕。
    """
    store = _load_raw_store()
    chosen_engine = (engine_id or store.get("default_engine_id") or "").strip()
    if not chosen_engine:
        raise RuntimeError("尚未配置默认翻译引擎，请先在「设置 → 翻译引擎与费用控制」中选择并配置默认引擎。")
    if chosen_engine not in PROVIDER_REGISTRY:
        raise RuntimeError(f"未知翻译引擎：{chosen_engine}")

    meta = PROVIDER_REGISTRY[chosen_engine]
    cfg = _resolve_provider_runtime_config(chosen_engine)
    policy = _get_billing_policy()

    sub_data = get_content_subtitles(content_id, target_lang)
    if not sub_data["has_transcript"] or not sub_data["segments"]:
        raise RuntimeError("当前视频尚未提取字幕，请先提取原始文案与时间轴。")

    segs = sub_data["segments"]
    source_hash = _compute_source_hash(segs)
    total_count = len(segs)

    # 1. 缓存复用检查：全部段已有译文且 source_hash 匹配且非强制重译
    conn = get_conn()
    try:
        existing_rows = {
            int(r["segment_idx"]): dict(r)
            for r in conn.execute(
                """SELECT * FROM subtitle_translations
                   WHERE content_id = ? AND target_lang = ?""",
                (content_id, target_lang),
            ).fetchall()
        }
    finally:
        conn.close()

    pending_items: list[dict[str, Any]] = []
    skipped_manual_count = 0
    for seg in segs:
        idx = seg["segment_idx"]
        ex = existing_rows.get(idx)
        if ex and ex.get("is_manual_edited") and not overwrite_manual:
            skipped_manual_count += 1
            continue
        if (
            not force_retranslate
            and ex
            and ex.get("source_hash") == source_hash
            and (ex.get("translated_text") or "").strip()
            and ex.get("status") in ("translated", "manual")
        ):
            continue
        pending_items.append(
            {
                "segment_idx": idx,
                "start": seg["start"],
                "end": seg["end"],
                "end_source": seg["end_source"],
                "source_text": seg["text"],
            }
        )

    if not pending_items:
        _log_usage(
            content_id=content_id,
            engine_id=chosen_engine,
            model_id=cfg["model_id"],
            operation_type="translate_segments",
            billing_mode=policy["billing_mode"],
            source_chars=0,
            target_chars=0,
            total_tokens=0,
            estimated_cost_cny=0.0,
            cache_hit=True,
            status="ok",
        )
        fresh = get_content_subtitles(content_id, target_lang)
        fresh["cache_hit"] = True
        fresh["newly_translated_count"] = 0
        fresh["skipped_manual_count"] = skipped_manual_count
        fresh["total_tokens"] = 0
        fresh["estimated_cost_cny"] = 0.0
        fresh["message"] = f"命中本地译文缓存（{fresh['translated_count']}/{total_count} 段已就绪，0 费用复用）。"
        return fresh

    # 2. 费用门禁校验
    est_chars = sum(len(it["source_text"]) for it in pending_items)
    allowed, reason = _check_billing_gate(chosen_engine, estimated_chars=est_chars)
    if not allowed:
        _log_usage(
            content_id=content_id,
            engine_id=chosen_engine,
            model_id=cfg["model_id"],
            operation_type="translate_segments",
            billing_mode=policy["billing_mode"],
            source_chars=est_chars,
            status="blocked",
            error_message=reason,
        )
        raise PermissionError(reason)

    # 3. 凭据与本地服务校验
    protocol = meta["protocol"]
    if protocol == "openai_compatible" and not cfg["api_key"]:
        raise RuntimeError(f"引擎「{meta['name']}」尚未配置 API Key，请前往翻译引擎配置填写。")
    if protocol == "volcengine_mt_v4" and not (cfg["access_key_id"] and cfg["secret_access_key"]):
        raise RuntimeError("火山引擎机器翻译尚未配置 AccessKey ID / SecretAccessKey。")
    if protocol == "google_translate_v2" and not cfg["api_key"]:
        raise RuntimeError("Google Cloud Translation v2 尚未配置 API Key。")
    if protocol == "local_hunyuan":
        from backend.services import local_translation_wizard as lw

        started = lw.ensure_local_service_running()
        if not started.get("ok"):
            raise RuntimeError(started.get("message", "本地混元 Hy-MT3 推理服务未安装或启动失败（未切换任何付费 API）。"))
        cfg = dict(cfg)
        cfg["base_url"] = started["endpoint"]
        cfg["model_id"] = started["model_id"]

    # 4. 分批带上下文翻译，严格按 segment_idx 对齐
    batch_size = 8 if protocol == "local_hunyuan" else (25 if protocol == "openai_compatible" else 16)
    translated_map: dict[int, str] = {}
    prev_context: list[dict[str, str]] = []
    total_prompt_tokens = 0
    total_completion_tokens = 0
    failed_indices: list[int] = []
    last_error = ""

    for start_i in range(0, len(pending_items), batch_size):
        batch = pending_items[start_i : start_i + batch_size]
        batch_ok = False
        for attempt in range(2):
            try:
                if protocol == "local_hunyuan":
                    mapping, p_tok, c_tok = _hunyuan_mt3_translate_batch(
                        cfg,
                        batch,
                        source_lang=sub_data["language"],
                        target_lang=target_lang,
                    )
                    total_prompt_tokens += p_tok
                    total_completion_tokens += c_tok
                    translated_map.update(mapping)
                elif protocol == "openai_compatible":
                    mapping, p_tok, c_tok = _openai_translate_batch(
                        cfg,
                        batch,
                        prev_context=prev_context,
                        source_lang=sub_data["language"],
                        target_lang=target_lang,
                    )
                    total_prompt_tokens += p_tok
                    total_completion_tokens += c_tok
                    translated_map.update(mapping)
                    # 若个别段漏译，再补一次精准小批
                    missing = [it for it in batch if it["segment_idx"] not in mapping]
                    if missing:
                        m2, p2, c2 = _openai_translate_batch(
                            cfg,
                            missing,
                            prev_context=prev_context,
                            source_lang=sub_data["language"],
                            target_lang=target_lang,
                        )
                        total_prompt_tokens += p2
                        total_completion_tokens += c2
                        translated_map.update(m2)
                elif protocol == "volcengine_mt_v4":
                    outs = _volcengine_mt_translate_list(
                        cfg, [it["source_text"] for it in batch], sub_data["language"], target_lang
                    )
                    for it, zh in zip(batch, outs):
                        translated_map[it["segment_idx"]] = zh
                elif protocol == "google_translate_v2":
                    outs = _google_v2_translate_list(
                        cfg, [it["source_text"] for it in batch], sub_data["language"], target_lang
                    )
                    for it, zh in zip(batch, outs):
                        translated_map[it["segment_idx"]] = zh
                batch_ok = True
                break
            except Exception as e:
                last_error = str(e)
                if attempt == 0:
                    time.sleep(0.8)

        if not batch_ok:
            for it in batch:
                failed_indices.append(it["segment_idx"])
        else:
            # 更新上下文窗口（最近 2 条成功译文）
            for it in batch[-2:]:
                zh_val = translated_map.get(it["segment_idx"], "")
                if zh_val:
                    prev_context.append({"src": it["source_text"], "zh": zh_val})
            prev_context = prev_context[-2:]

    if not translated_map and last_error:
        _log_usage(
            content_id=content_id,
            engine_id=chosen_engine,
            model_id=cfg["model_id"],
            operation_type="translate_segments",
            billing_mode=policy["billing_mode"],
            source_chars=est_chars,
            status="error",
            error_message=last_error,
        )
        raise RuntimeError(f"翻译调用失败（已保留原始字幕）：{last_error}")

    # 5. 逐段落库并重建 transcripts.translated_zh
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    newly_translated = 0
    total_target_chars = 0
    conn = get_conn()
    try:
        for it in pending_items:
            idx = it["segment_idx"]
            zh = (translated_map.get(idx) or "").strip()
            status = "translated" if zh else "failed"
            if zh:
                newly_translated += 1
                total_target_chars += len(zh)
            conn.execute(
                """INSERT INTO subtitle_translations
                   (content_id, segment_idx, source_text, translated_text, start_sec, end_sec, end_source,
                    source_lang, target_lang, engine_id, model_id, source_hash, status, is_manual_edited, translated_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                   ON CONFLICT(content_id, segment_idx, target_lang) DO UPDATE SET
                     source_text = excluded.source_text,
                     translated_text = CASE WHEN subtitle_translations.is_manual_edited = 1 AND ? = 0
                                            THEN subtitle_translations.translated_text
                                            ELSE excluded.translated_text END,
                     start_sec = excluded.start_sec,
                     end_sec = excluded.end_sec,
                     end_source = excluded.end_source,
                     source_lang = excluded.source_lang,
                     engine_id = excluded.engine_id,
                     model_id = excluded.model_id,
                     source_hash = excluded.source_hash,
                     status = CASE WHEN subtitle_translations.is_manual_edited = 1 AND ? = 0
                                   THEN subtitle_translations.status
                                   ELSE excluded.status END,
                     translated_at = excluded.translated_at,
                     updated_at = excluded.updated_at""",
                (
                    content_id,
                    idx,
                    it["source_text"],
                    zh,
                    it["start"],
                    it["end"],
                    it["end_source"],
                    sub_data["language"],
                    target_lang,
                    chosen_engine,
                    cfg["model_id"],
                    source_hash,
                    status,
                    now_str,
                    now_str,
                    1 if overwrite_manual else 0,
                    1 if overwrite_manual else 0,
                ),
            )

        # 重建全文 translated_zh 并同步更新 transcripts 的时间覆盖与规范化 segments_json
        all_rows = conn.execute(
            """SELECT translated_text FROM subtitle_translations
               WHERE content_id = ? AND target_lang = ?
               ORDER BY segment_idx ASC""",
            (content_id, target_lang),
        ).fetchall()
        full_zh = "\n".join(r["translated_text"].strip() for r in all_rows if (r["translated_text"] or "").strip())
        norm_json = json.dumps(
            [{"start": s["start"], "end": s["end"], "end_source": s["end_source"], "text": s["text"]} for s in segs],
            ensure_ascii=False,
        )
        conn.execute(
            """UPDATE transcripts
               SET translated_zh = ?,
                   segments_json = ?,
                   video_duration_sec = COALESCE(video_duration_sec, ?),
                   subtitle_coverage_start = ?,
                   subtitle_coverage_end = ?,
                   translation_engine = ?,
                   translation_model = ?,
                   translation_source_hash = ?
               WHERE id = ?""",
            (
                full_zh,
                norm_json,
                sub_data["video_duration_sec"],
                sub_data["subtitle_coverage_start"],
                sub_data["subtitle_coverage_end"],
                chosen_engine,
                cfg["model_id"],
                source_hash,
                sub_data["transcript_id"],
            ),
        )
        conn.commit()
    finally:
        conn.close()

    total_tokens = total_prompt_tokens + total_completion_tokens
    est_cost = _estimate_cost(chosen_engine, est_chars, total_tokens)
    _log_usage(
        content_id=content_id,
        engine_id=chosen_engine,
        model_id=cfg["model_id"],
        operation_type="translate_segments",
        billing_mode=policy["billing_mode"],
        source_chars=est_chars,
        target_chars=total_target_chars,
        prompt_tokens=total_prompt_tokens,
        completion_tokens=total_completion_tokens,
        total_tokens=total_tokens,
        estimated_cost_cny=est_cost,
        cache_hit=False,
        status="ok" if not failed_indices else "partial",
        error_message=last_error if failed_indices else "",
    )

    fresh = get_content_subtitles(content_id, target_lang)
    fresh["cache_hit"] = False
    fresh["newly_translated_count"] = newly_translated
    fresh["skipped_manual_count"] = skipped_manual_count
    fresh["failed_indices"] = failed_indices
    fresh["total_tokens"] = total_tokens
    fresh["estimated_cost_cny"] = round(est_cost, 6)
    fresh["message"] = (
        f"已完成翻译：{fresh['translated_count']}/{total_count} 段"
        + (f"（保留 {skipped_manual_count} 段人工修订）" if skipped_manual_count else "")
        + (f"，另有 {len(failed_indices)} 段失败可重试" if failed_indices else "")
    )
    return fresh
