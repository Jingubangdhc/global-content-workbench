"""SEARCH-PHASE-1 · 通用 30 维自适应 AI 关键词拓展引擎与 12 平台真实能力矩阵。

严格原则：
1. 必须调用工作台已配置的真实 LLM 模型理解搜索对象、实体类型与研究目的；
2. 严禁使用固定模板、正则拼接或预制词库冒充 AI 拓展；
3. 模型不可用或响应非法时返回明确失败状态与错误原因，由前端提供手动输入兜底；
4. 完整记录实际模型名称、调用次数、执行耗时与可见 Token 消耗（不可得时标注「未知」）。
"""
from __future__ import annotations

import json
import os
import random
import re
import time
import uuid
from typing import Any

from openai import OpenAI

from backend.config import get_env_config
from backend.db import get_conn

DIMENSION_CATEGORIES: list[tuple[str, list[str]]] = [
    ("行业与产品", ["行业细分", "产品细分", "品牌企业", "关联行业"]),
    ("时空与地域", ["时间", "季节节日", "地区", "文化差异"]),
    ("人群与消费", ["年龄", "人群", "职业身份", "消费能力"]),
    ("痛点与需求", ["使用场景", "用户痛点", "用户需求", "购买动机"]),
    ("知识与原理", ["基础知识", "底层原理", "原因机制", "历史演变", "科学研究"]),
    ("测评与争议", ["对比测评", "争议讨论", "反常识", "真实体验"]),
    ("商业与变现", ["商业模式", "成本利润", "成功失败案例"]),
    ("趋势与创新", ["行业趋势", "未来创新"]),
]

THIRTY_DIMENSIONS = [d for _, ds in DIMENSION_CATEGORIES for d in ds]

_DIM_LIB_KEY = "research_dimension_library_json"
_DIM_PRESETS_KEY = "research_dimension_presets_json"


def _default_dimensions() -> list[dict[str, Any]]:
    out = []
    idx = 1
    for cat, names in DIMENSION_CATEGORIES:
        for nm in names:
            out.append({
                "id": f"builtin_{idx:02d}",
                "name": nm,
                "category": cat,
                "description": "",
                "builtin": True,
            })
            idx += 1
    return out


def _read_setting_json(key: str, default: Any) -> Any:
    conn = get_conn()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        if not row or not row["value"]:
            return default
        return json.loads(row["value"])
    except Exception:
        return default
    finally:
        conn.close()


def _write_setting_json(key: str, val: Any) -> None:
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(val, ensure_ascii=False)),
        )
        conn.commit()
    finally:
        conn.close()


def get_dimension_library_and_presets() -> dict[str, Any]:
    """返回可扩展研究维度库（内置30维+用户自定义维度）与已保存常用维度组合。"""
    dims = _read_setting_json(_DIM_LIB_KEY, None)
    if not isinstance(dims, list) or len(dims) == 0:
        dims = _default_dimensions()
        _write_setting_json(_DIM_LIB_KEY, dims)
    presets = _read_setting_json(_DIM_PRESETS_KEY, [])
    if not isinstance(presets, list):
        presets = []
    return {"dimensions": dims, "presets": presets}


def add_custom_dimension(name: str, category: str = "自定义维度", description: str = "") -> dict[str, Any]:
    nm = name.strip()
    if not nm:
        return {"ok": False, "error": "维度名称不能为空"}
    data = get_dimension_library_and_presets()
    dims = data["dimensions"]
    if any(d["name"].lower() == nm.lower() for d in dims):
        return {"ok": False, "error": f"维度「{nm}」已存在"}
    item = {
        "id": f"custom_{uuid.uuid4().hex[:8]}",
        "name": nm[:30],
        "category": (category or "自定义维度").strip()[:24],
        "description": (description or "").strip()[:120],
        "builtin": False,
    }
    dims.append(item)
    _write_setting_json(_DIM_LIB_KEY, dims)
    return {"ok": True, "dimension": item, "dimensions": dims}


def update_custom_dimension(dim_id: str, name: str | None = None, category: str | None = None, description: str | None = None) -> dict[str, Any]:
    data = get_dimension_library_and_presets()
    dims = data["dimensions"]
    target = next((d for d in dims if d["id"] == dim_id), None)
    if not target:
        return {"ok": False, "error": "维度不存在"}
    if name is not None and name.strip():
        target["name"] = name.strip()[:30]
    if category is not None and category.strip():
        target["category"] = category.strip()[:24]
    if description is not None:
        target["description"] = description.strip()[:120]
    _write_setting_json(_DIM_LIB_KEY, dims)
    return {"ok": True, "dimension": target, "dimensions": dims}


def delete_custom_dimension(dim_id: str) -> dict[str, Any]:
    data = get_dimension_library_and_presets()
    dims = data["dimensions"]
    new_dims = [d for d in dims if d["id"] != dim_id]
    if len(new_dims) == len(dims):
        return {"ok": False, "error": "维度不存在"}
    _write_setting_json(_DIM_LIB_KEY, new_dims)
    return {"ok": True, "dimensions": new_dims}


def save_dimension_preset(name: str, dimensions: list[str]) -> dict[str, Any]:
    nm = name.strip()
    clean = [str(x).strip() for x in dimensions if str(x).strip()]
    if not nm or not clean:
        return {"ok": False, "error": "组合名称和维度列表均不能为空"}
    data = get_dimension_library_and_presets()
    presets = data["presets"]
    item = {
        "id": f"preset_{uuid.uuid4().hex[:8]}",
        "name": nm[:40],
        "dimensions": list(dict.fromkeys(clean)),
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    presets.insert(0, item)
    _write_setting_json(_DIM_PRESETS_KEY, presets[:30])
    return {"ok": True, "preset": item, "presets": presets[:30]}


def delete_dimension_preset(preset_id: str) -> dict[str, Any]:
    data = get_dimension_library_and_presets()
    presets = [p for p in data["presets"] if p["id"] != preset_id]
    _write_setting_json(_DIM_PRESETS_KEY, presets)
    return {"ok": True, "presets": presets}

DEPTH_RANGES = {
    "quick": (10, 20),
    "standard": (30, 60),
    "deep": (100, 140),
}


def build_platform_capability_matrix() -> list[dict[str, Any]]:
    """返回 12 个目标平台的真实 6 级能力矩阵（绝不将手动跳转冒充为自动搜索）。"""
    env = get_env_config()
    tavily_ok = bool(env.get("tavily_configured"))
    douyin_ok = bool(env.get("douyin_api_base"))

    return [
        {
            "platform_id": "youtube",
            "name": "YouTube",
            "region": "海外",
            "capability_level": "已支持真实自动搜索",
            "capability_code": "auto_search",
            "auto_search_supported": True,
            "metrics_supported": ["view_count", "like_count", "comment_count", "follower_count", "duration_sec", "published_at", "outlier_score"],
            "missing_fields_as_null": ["favorite_count", "share_count"],
            "required_config": "免 API Key（yt-dlp 直连）",
            "cost_hint": "免费本地调用",
        },
        {
            "platform_id": "bilibili",
            "name": "B站",
            "region": "国内",
            "capability_level": "已支持真实自动搜索",
            "capability_code": "auto_search",
            "auto_search_supported": True,
            "metrics_supported": ["view_count", "like_count", "comment_count", "duration_sec", "published_at"],
            "missing_fields_as_null": ["follower_count", "favorite_count", "share_count", "outlier_score"],
            "required_config": "免 API Key（bilisearch 直连）",
            "cost_hint": "免费本地调用",
        },
        {
            "platform_id": "google",
            "name": "Google / 全网文章",
            "region": "海外",
            "capability_level": "已支持真实自动搜索" if tavily_ok else "需要API配置",
            "capability_code": "auto_search" if tavily_ok else "needs_api_config",
            "auto_search_supported": tavily_ok,
            "metrics_supported": ["title", "url", "snippet", "domain"],
            "missing_fields_as_null": ["view_count", "like_count", "comment_count", "follower_count"],
            "required_config": "设置页配置 TAVILY_API_KEY" if not tavily_ok else "已配置 TAVILY_API_KEY",
            "cost_hint": "Tavily 免费额度/按量计费",
        },
        {
            "platform_id": "douyin",
            "name": "抖音",
            "region": "国内",
            "capability_level": "支持半自动搜索",
            "capability_code": "semi_auto",
            "auto_search_supported": False,
            "metrics_supported": ["title", "url", "view_count(粘贴链接/解析)", "like_count", "comment_count"],
            "missing_fields_as_null": ["keyword_auto_search_list"],
            "required_config": "已连本地解析服务" if douyin_ok else "可选配置 DOUYIN_API_BASE；支持跳板+链接/CSV半自动收录",
            "cost_hint": "无额外付费 API",
        },
        {
            "platform_id": "tiktok",
            "name": "TikTok",
            "region": "海外",
            "capability_level": "支持半自动搜索",
            "capability_code": "semi_auto",
            "auto_search_supported": False,
            "metrics_supported": ["title", "url", "view_count(粘贴链接/CSV)", "like_count", "comment_count"],
            "missing_fields_as_null": ["keyword_auto_search_list"],
            "required_config": "已连本地解析服务" if douyin_ok else "支持跳板+链接/FastMoss/Kalodata CSV半自动收录",
            "cost_hint": "无额外付费 API",
        },
        {
            "platform_id": "xiaohongshu",
            "name": "小红书",
            "region": "国内",
            "capability_level": "仅支持手动跳转",
            "capability_code": "manual_jump",
            "auto_search_supported": False,
            "metrics_supported": ["manual_import_only"],
            "missing_fields_as_null": ["view_count", "like_count", "favorite_count", "follower_count"],
            "required_config": "手动跳转后通过链接或书签收录（收藏≠播放）",
            "cost_hint": "免费",
        },
        {
            "platform_id": "kuaishou",
            "name": "快手",
            "region": "国内",
            "capability_level": "仅支持手动跳转",
            "capability_code": "manual_jump",
            "auto_search_supported": False,
            "metrics_supported": ["manual_import_only"],
            "missing_fields_as_null": ["view_count", "like_count", "comment_count", "follower_count"],
            "required_config": "手动跳转后通过链接/CSV收录",
            "cost_hint": "免费",
        },
        {
            "platform_id": "zhihu",
            "name": "知乎",
            "region": "国内",
            "capability_level": "仅支持手动跳转",
            "capability_code": "manual_jump",
            "auto_search_supported": False,
            "metrics_supported": ["hot_trends_only", "manual_import"],
            "missing_fields_as_null": ["view_count", "follower_count"],
            "required_config": "热榜可自动获取，关键词搜索仅支持手动跳转",
            "cost_hint": "免费",
        },
        {
            "platform_id": "instagram",
            "name": "Instagram",
            "region": "海外",
            "capability_level": "需要账号授权",
            "capability_code": "needs_auth",
            "auto_search_supported": False,
            "metrics_supported": ["manual_import_only"],
            "missing_fields_as_null": ["view_count", "like_count", "follower_count"],
            "required_config": "需官方 Graph API 授权，当前仅支持手动跳转",
            "cost_hint": "无",
        },
        {
            "platform_id": "reddit",
            "name": "Reddit",
            "region": "海外",
            "capability_level": "需要API配置",
            "capability_code": "needs_api_config",
            "auto_search_supported": False,
            "metrics_supported": ["manual_import_only"],
            "missing_fields_as_null": ["view_count", "follower_count"],
            "required_config": "需配置合规 Reddit OAuth 凭据，当前仅支持手动跳转",
            "cost_hint": "无",
        },
        {
            "platform_id": "x",
            "name": "X (Twitter)",
            "region": "海外",
            "capability_level": "需要API配置",
            "capability_code": "needs_api_config",
            "auto_search_supported": False,
            "metrics_supported": ["manual_import_only"],
            "missing_fields_as_null": ["view_count", "like_count", "follower_count"],
            "required_config": "X 官方搜索 API 为付费服务，未经授权仅支持手动跳转",
            "cost_hint": "官方 API 付费（未启用）",
        },
        {
            "platform_id": "google_trends",
            "name": "Google Trends",
            "region": "海外",
            "capability_level": "仅支持手动跳转",
            "capability_code": "manual_jump",
            "auto_search_supported": False,
            "metrics_supported": ["relative_interest_manual"],
            "missing_fields_as_null": ["absolute_search_volume"],
            "required_config": "手动跳转查看相对趋势（0-100≠绝对搜索量）",
            "cost_hint": "免费",
        },
    ]


def _extract_json_object(raw_text: str) -> dict[str, Any]:
    s = (raw_text or "").strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", s, flags=re.S)
    if m:
        s = m.group(1)
    else:
        i = s.find("{")
        j = s.rfind("}")
        if i != -1 and j != -1 and j > i:
            s = s[i : j + 1]
    return json.loads(s)


def expand_keywords_with_real_llm(
    seed_keyword: str,
    depth_mode: str = "quick",
    research_goal: str = "",
    target_region: str = "",
    target_language: str = "",
    filters: dict[str, Any] | None = None,
    dimension_mode: str = "ai_auto",
    selected_dimensions: list[str] | None = None,
    random_count: int = 6,
) -> dict[str, Any]:
    """调用工作台已配置的真实 LLM 执行可扩展维度关键词拓展（严格遵循用户指定的维度模式）。"""
    env = get_env_config()
    api_key = os.getenv("LLM_API_KEY", "").strip()
    base_url = (env.get("llm_base_url") or "https://api.deepseek.com/v1").rstrip("/")
    model_name = env.get("llm_model") or "deepseek-chat"

    if not api_key:
        return {
            "ok": False,
            "status": "failed",
            "error": "未配置 LLM_API_KEY，无法执行真实 AI 关键词拓展（请前往设置页配置模型或使用左侧手动输入关键词）",
            "llm_meta": {"model": model_name, "calls": 0, "tokens": "未知", "cost_note": "未调用"},
        }

    lib_data = get_dimension_library_and_presets()
    all_dim_names = [d["name"] for d in lib_data["dimensions"]]
    mode = (dimension_mode or "ai_auto").strip()
    enforced_dims: list[str] = []

    if mode == "manual":
        enforced_dims = [str(x).strip() for x in (selected_dimensions or []) if str(x).strip()]
        if not enforced_dims:
            return {"ok": False, "status": "failed", "error": "手动指定维度模式下至少需要选择 1 个研究维度", "llm_meta": {"model": model_name, "calls": 0}}
    elif mode == "random":
        if selected_dimensions:
            enforced_dims = [str(x).strip() for x in selected_dimensions if str(x).strip()]
        else:
            k = max(1, min(int(random_count or 6), len(all_dim_names)))
            enforced_dims = random.sample(all_dim_names, k)
    elif mode == "all":
        enforced_dims = list(all_dim_names)

    min_n, max_n = DEPTH_RANGES.get(depth_mode, (10, 20))
    if mode == "all":
        max_n = max(max_n, len(enforced_dims) * 2)
    target_n = min_n + (max_n - min_n) // 2
    filters = filters or {}

    if mode == "ai_auto":
        dim_instruction = (
            f"从以下 {len(all_dim_names)} 个可扩展研究维度中【自适应挑选最贴合该对象本质的 5~9 个维度】"
            f"（严禁对不同行业套用同一组维度，严禁机械笛卡尔积拼接）。\n可选维度库：{', '.join(all_dim_names)}"
        )
    else:
        dim_instruction = (
            f"【严格约束·禁止违反】用户已明确指定以下 {len(enforced_dims)} 个研究维度：{', '.join(enforced_dims)}。\n"
            f"你必须严格且只能围绕这 {len(enforced_dims)} 个维度生成候选关键词，每条 candidate 的 dimension 必须逐字取自该列表，"
            f"严禁忽略用户选择，严禁擅自添加列表之外的维度！"
        )

    system_prompt = (
        "你是全球内容研究与市场检索专家。你的任务是理解用户输入的任意研究对象，"
        f"{dim_instruction}\n"
        "生成真实用户在 YouTube / B站 / 抖音 / 小红书 / Google 上会实际搜索的高质量候选关键词。\n"
        "注意：\n"
        "1. 严禁只把主体名替换进同一套通用后缀（如全部生成“XX教程/XX测评/XX推荐”）。\n"
        "2. 融合8类拓展法：synonym/hypernym/hyponym/related/question/contrast/temporal/cross_lang。\n"
        "3. 只输出严格合法的 JSON 对象，不要输出任何额外说明文字。"
    )
    user_prompt = json.dumps(
        {
            "seed_keyword": seed_keyword,
            "dimension_mode": mode,
            "enforced_dimensions": enforced_dims if enforced_dims else None,
            "research_goal": research_goal or "发现有真实市场需求与差异化机会的内容选题",
            "target_region": target_region or "不限",
            "target_language": target_language or "中文为主，必要时附自然英文表达",
            "filters": filters,
            "target_count": target_n,
            "min_count": min_n,
            "max_count": max_n,
            "required_json_schema": {
                "entity_type": "如：消费品 / 人物 / 影视文化 / 自然与科学对象 / 商业概念 / 专业服务",
                "entity_understanding": "一句话说明该搜索对象的核心研究视角",
                "selected_dimensions": enforced_dims if enforced_dims else ["自适应选出的5~9个维度名称"],
                "candidates": [
                    {
                        "query_text": "真实自然搜索词",
                        "language": "zh 或 en",
                        "dimension": "所属维度（必须来自 selected_dimensions）",
                        "expansion_type": "synonym|hypernym|hyponym/related/question/contrast/temporal/cross_lang",
                        "intent": "用户搜索意图简述",
                        "platform_hint": "youtube|bilibili|douyin|xiaohongshu|google",
                        "priority": 80,
                    }
                ],
            },
        },
        ensure_ascii=False,
    )

    t0 = time.time()
    last_err = None
    attempts = 0
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=90.0, max_retries=2)
    for attempt in range(2):
        attempts = attempt + 1
        try:
            resp = client.chat.completions.create(
                model=model_name,
                temperature=0.45,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )
            elapsed = round(time.time() - t0, 2)
            usage = resp.usage
            content = (resp.choices[0].message.content or "") if resp.choices else ""
            parsed = _extract_json_object(content)

            raw_cands = parsed.get("candidates") or []
            seen = set()
            deduped = []
            for c in raw_cands:
                qt = str(c.get("query_text") or "").strip()
                key = re.sub(r"\s+", " ", qt.lower())
                if not qt or key in seen:
                    continue
                dim_val = str(c.get("dimension") or "通用")[:30]
                if enforced_dims and dim_val not in enforced_dims:
                    # 严格遵循用户所选维度：若模型返回了未选维度，跳过避免违背用户意图
                    continue
                seen.add(key)
                deduped.append({
                    "query_text": qt,
                    "language": str(c.get("language") or "zh")[:10],
                    "dimension": dim_val,
                    "expansion_type": str(c.get("expansion_type") or "related")[:20],
                    "intent": str(c.get("intent") or "")[:120],
                    "platform_hint": str(c.get("platform_hint") or "youtube")[:24],
                    "priority": int(c.get("priority") or 60),
                    "origin": "ai",
                })

            if not deduped:
                return {
                    "ok": False,
                    "status": "failed",
                    "error": "真实模型返回空候选词列表，请重试或手动输入关键词",
                    "llm_meta": {"model": resp.model or model_name, "calls": attempts, "elapsed_sec": elapsed, "total_tokens": getattr(usage, "total_tokens", "未知")},
                }

            return {
                "ok": True,
                "status": "ready",
                "entity_type": str(parsed.get("entity_type") or "通用对象"),
                "entity_understanding": str(parsed.get("entity_understanding") or ""),
                "selected_dimensions": enforced_dims if enforced_dims else list(parsed.get("selected_dimensions") or []),
                "candidates": deduped[:max_n],
                "llm_meta": {
                    "model": resp.model or model_name,
                    "dimension_mode": mode,
                    "enforced_dimensions_count": len(enforced_dims),
                    "calls": attempts,
                    "elapsed_sec": elapsed,
                    "prompt_tokens": getattr(usage, "prompt_tokens", "未知") if usage else "未知",
                    "completion_tokens": getattr(usage, "completion_tokens", "未知") if usage else "未知",
                    "total_tokens": getattr(usage, "total_tokens", "未知") if usage else "未知",
                    "cost_note": "复用工作台已有合规模型配置（实际账单视服务商计费，此处不虚构金额：未知）",
                },
            }
        except Exception as e:
            last_err = e
            if attempt == 0:
                time.sleep(1.5)
                continue
            break

    return {
        "ok": False,
        "status": "failed",
        "error": f"真实 AI 模型调用失败：{str(last_err)[:220]}（请检查网络/模型配置或使用手动输入兜底）",
        "llm_meta": {
            "model": model_name,
            "calls": attempts,
            "elapsed_sec": round(time.time() - t0, 2),
            "total_tokens": "未知",
        },
    }
