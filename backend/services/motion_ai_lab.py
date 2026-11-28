"""R2 真正的 AI 动效研发引擎（复用 backend/config.py 模型 API 中心）。

支持两种研发模式：
- Mode A (config_combo): 调用真实 LLM 从统一动效注册中心选择可执行资产与皮肤并生成参数化组合；
- Mode B (original_dsl): 调用真实 LLM 自主设计全新的 MotionDSL v1 声明式动画（任意图层拓扑、贝塞尔路径生长、关键帧轨道、缓动曲线与内容参数 Schema）；
- 多轮自然语言返修：传入上一版 DSL + 返修意见，由真实 LLM 精准修改运动路径/关键帧/布局；
- 显式降级原则：模型未配置/超时/失败时绝不伪装为 AI 研发成功，强制返回 execution_mode='llm_failed' 或 'degraded_rule_fallback' 与具体原因。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Optional

from backend.config import get_env_config
from backend.services.motion_registry import list_motion_assets, list_reference_catalog
from backend.services.motion_sandbox import validate_motion_dsl

DSL_SPEC_PROMPT = """你必须严格遵守 MotionDSL v1 声明式纯函数动画协议（画布基准坐标系 1280x720，时间进度 u ∈ [0.0, 1.0]）：
可用图元 type 白名单（仅限以下 7 种）：
1. "rect": {id, type:"rect", x, y, w, h, rx?, fill, stroke?, strokeWidth?, tracks:[]}
2. "circle": {id, type:"circle", x, y, r, fill, stroke?, strokeWidth?, tracks:[]}
3. "line": {id, type:"line", x1, y1, x2, y2, stroke, strokeWidth?, arrowEnd?:bool, tracks:[]}
4. "bezier_connector": {id, type:"bezier_connector", x1, y1, cx, cy, x2, y2, stroke, strokeWidth?, arrowEnd?:bool, tracks:[{prop:"drawProgress", t0, t1, from:0, to:1, easing:"easeOutCubic"}]}
5. "text": {id, type:"text", x, y, text:"支持 {{content.key}} 模板", fontSize, fontWeight?:700, align?:"center"|"left"|"right", fill, tracks:[]}
6. "arc": {id, type:"arc", x, y, r, startAngle, endAngle, stroke, strokeWidth, tracks:[{prop:"fillProgress", t0, t1, from:0, to:1, easing:"easeOutExpo"}]}
7. "group": {id, type:"group", x, y, children:[...], tracks:[]}

语义色 Token（自动适配换肤，强烈建议使用）：
"$stage_bg", "$surface", "$surface_alt", "$border", "$text_primary", "$text_secondary", "$text_muted", "$accent", "$accent_secondary"
（也可使用标准 #hex 颜色）。

关键帧轨道 tracks 元素格式：
{"prop": "x|y|scale|opacity|rotation|drawProgress|width|height|fillProgress|r", "t0": 0.0, "t1": 0.3, "from": 0, "to": 1, "easing": "linear|easeOutCubic|easeInCubic|easeOutQuart|easeOutExpo|easeOutBackSoft"}
注意：
- 必须确保 t=0.35s 与 t=1.85s 之间存在明显动画变化（不要所有元素在 t=0 就静止不动）；
- 必须包含退场轨道（例如外层元素在 [0.90, 1.0] opacity 1 -> 0）；
- 严禁出现任何 JS 代码、表达式或 TODO 占位词。"""


def _call_real_llm_json(system_prompt: str, user_prompt: str, simulate_failure: bool = False, temperature: float = 0.25) -> dict[str, Any]:
    """统一调用主工作台配置的真实 LLM API（复用 backend/config.py）。"""
    if simulate_failure:
        return {
            "ok": False,
            "execution_mode": "llm_failed",
            "model": None,
            "total_tokens": 0,
            "error": "模拟模型调用失败（simulate_llm_failure=True）",
        }
    cfg = get_env_config()
    api_key = os.getenv("LLM_API_KEY", "").strip()
    if not cfg.get("llm_configured") or not api_key:
        return {
            "ok": False,
            "execution_mode": "llm_failed",
            "model": None,
            "total_tokens": 0,
            "error": "未配置 LLM_API_KEY，请在设置页配置模型 API 密钥",
        }
    try:
        from openai import OpenAI

        client = OpenAI(api_key=api_key, base_url=cfg["llm_base_url"])
        resp = client.chat.completions.create(
            model=cfg["llm_model"],
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            response_format={"type": "json_object"},
            timeout=60,
        )
        raw = resp.choices[0].message.content or "{}"
        parsed = json.loads(raw)
        tokens = getattr(resp.usage, "total_tokens", 0) or 0
        return {
            "ok": True,
            "execution_mode": "real_llm",
            "model": cfg["llm_model"],
            "total_tokens": int(tokens),
            "data": parsed,
        }
    except Exception as e:
        return {
            "ok": False,
            "execution_mode": "llm_failed",
            "model": cfg.get("llm_model"),
            "total_tokens": 0,
            "error": f"真实模型调用失败：{e}",
        }


def develop_motion_with_llm(
    prompt: str,
    mode: str = "original_dsl",  # config_combo | original_dsl
    base_skin: Optional[dict[str, Any]] = None,
    style_dna: Optional[dict[str, Any]] = None,
    group_id: str = "G20",
    simulate_llm_failure: bool = False,
) -> dict[str, Any]:
    """R2 真实 LLM 动效研发主入口（支持模式 A 配置组合 & 模式 B 原创 MotionDSL v1）。"""
    txt = (prompt or "").strip()
    if not txt:
        raise ValueError("请输入动效研发需求描述")

    # 只读检索 Atlas / Motion 参考作为风格上下文（严禁冒充可执行卡）
    atlas_refs = list_reference_catalog(source="atlas", q=txt[:8], limit=3).get("items", [])
    motion_refs = list_reference_catalog(source="motion", q=txt[:8], limit=3).get("items", [])
    dna_brief = json.dumps(style_dna or {"theme": "dark", "motion_intensity": 1.0}, ensure_ascii=False)

    if mode == "config_combo":
        approved = list_motion_assets(status="approved")
        lab_assets = [a for a in approved if a["engine_type"] in ("motion_lab_builtin", "motion_lab_dsl")]
        catalog_brief = "\n".join(
            f"- {a['asset_id']} ({a['name']}, group={a['group_id']}): params={list((a.get('default_content') or {}).keys())}"
            for a in lab_assets[:20]
        )
        sys_p = "你是高级动态图形设计师。请从现有可执行动效资产中选择最合适的一个，并输出合法 JSON 组合配置。"
        usr_p = f"""用户需求：{txt}
个人 Style DNA：{dna_brief}
可用可执行动效资产（仅可从中选择 asset_id）：
{catalog_brief}

请输出 JSON：
{{
  "selected_asset_id": "lab:...",
  "name": "中文卡片名称",
  "duration": 4.2,
  "content": {{"参数键": "真实中文文案"}},
  "skin_overrides": {{"theme": "dark|light", "accent_primary": "#3b82f6"}},
  "design_rationale": "简述为何选择此骨架与节奏"
}}"""
        llm_res = _call_real_llm_json(sys_p, usr_p, simulate_failure=simulate_llm_failure)
        if not llm_res["ok"]:
            return {
                "ok": False,
                "execution_mode": "degraded_rule_fallback",
                "degraded": True,
                "fallback_reason": llm_res["error"],
                "model": llm_res["model"],
                "total_tokens": 0,
            }
        data = llm_res["data"]
        sel_id = str(data.get("selected_asset_id") or "")
        picked = next((a for a in lab_assets if a["asset_id"] == sel_id), lab_assets[0] if lab_assets else None)
        if not picked:
            return {"ok": False, "execution_mode": "llm_failed", "degraded": True, "fallback_reason": "注册中心无可用工坊资产"}
        skin_obj = json.loads(json.dumps(base_skin or picked.get("default_skin") or {}))
        ov = data.get("skin_overrides") or {}
        if ov.get("accent_primary") and isinstance(skin_obj.get("tokens"), dict):
            skin_obj["tokens"]["accent_primary"] = ov["accent_primary"]
        return {
            "ok": True,
            "mode": "config_combo",
            "execution_mode": "real_llm",
            "degraded": False,
            "model": llm_res["model"],
            "total_tokens": llm_res["total_tokens"],
            "design_rationale": data.get("design_rationale", ""),
            "draft_asset": {
                "asset_id": f"lab:combo_{uuid.uuid4().hex[:8]}",
                "version": "1.0.0",
                "name": str(data.get("name") or f"AI 组合：{txt[:14]}"),
                "engine_type": picked["engine_type"],
                "group_id": picked["group_id"],
                "skeleton_spec": picked["skeleton_spec"],
                "params_schema": picked["params_schema"],
                "narrative_purposes": picked["narrative_purposes"],
                "default_content": {**(picked.get("default_content") or {}), **(data.get("content") or {})},
                "default_skin": skin_obj,
                "timeline_behavior": {"default_duration": float(data.get("duration") or 4.2), "min_duration": 1.5, "max_duration": 12.0, "allow_overlap": True},
                "source_type": "ai_config_combo",
                "license_note": f"AI Config Combo via {llm_res['model']}",
                "status": "draft",
            },
        }

    # === Mode B: 原创研发模式（生成全新 MotionDSL v1 声明式结构） ===
    sys_p = f"你是世界顶级 Motion Graphics 动效架构师。当现有模板无法满足需求时，你必须设计全新的 MotionDSL v1 声明式动画结构。\n{DSL_SPEC_PROMPT}"
    usr_p = f"""请根据用户需求原创设计一套全新的 MotionDSL v1 动效（不得退化为简单单卡片文字）：
用户需求：{txt}
个人 Style DNA：{dna_brief}
视觉参考灵感（仅作参考）：{json.dumps([r.get('title_zh') for r in atlas_refs + motion_refs], ensure_ascii=False)}

请严格输出以下结构的 JSON：
{{
  "name": "动效中文名（12字内）",
  "group_id": "{group_id}",
  "duration": 5.0,
  "narrative_purposes": ["relation_graph", "explainer_graphic"],
  "design_rationale": "简述图层拓扑、运动路径、关键帧错峰顺序与缓动策略",
  "params_schema": {{
    "center_title": {{"type": "string", "label": "中心核心标题", "default": "..."}}
  }},
  "default_content": {{
    "center_title": "..."
  }},
  "sound_cues": [
    {{"at_ratio": 0.15, "sfx": "whoosh", "role": "连线生长"}},
    {{"at_ratio": 0.35, "sfx": "pop", "role": "分支节点弹入"}}
  ],
  "dsl": {{
    "version": 1,
    "canvas": {{"width": 1280, "height": 720}},
    "layers": [
      ... 至少包含完整的中心/连线/分支图元与关键帧 tracks ...
    ]
  }}
}}"""

    llm_res = _call_real_llm_json(sys_p, usr_p, simulate_failure=simulate_llm_failure)
    if not llm_res["ok"]:
        return {
            "ok": False,
            "mode": "original_dsl",
            "execution_mode": "llm_failed",
            "degraded": True,
            "fallback_reason": llm_res["error"],
            "model": llm_res["model"],
            "total_tokens": 0,
        }

    data = llm_res["data"]
    total_tokens = llm_res["total_tokens"]
    dsl_check = validate_motion_dsl(data.get("dsl"))

    # 若首次生成有轻微 Schema 瑕疵，带报错明细自动让真实 LLM 自修复 1 次
    if not dsl_check["valid"]:
        fix_res = _call_real_llm_json(
            sys_p,
            f"你刚才生成的 MotionDSL v1 存在以下校验错误：{dsl_check['errors']}。\n请修复以下 JSON 并仅输出修复后的完整 JSON：\n{json.dumps(data, ensure_ascii=False)}",
            simulate_failure=False,
            temperature=0.1,
        )
        if fix_res["ok"]:
            total_tokens += fix_res["total_tokens"]
            data = fix_res["data"]
            dsl_check = validate_motion_dsl(data.get("dsl"))

    if not dsl_check["valid"]:
        return {
            "ok": False,
            "mode": "original_dsl",
            "execution_mode": "real_llm",
            "degraded": True,
            "fallback_reason": f"LLM 生成的 DSL 未通过白名单校验：{dsl_check['errors'][:3]}",
            "model": llm_res["model"],
            "total_tokens": total_tokens,
        }

    asset_id = f"lab:dsl_{uuid.uuid4().hex[:8]}"
    draft_asset = {
        "asset_id": asset_id,
        "version": "1.0.0",
        "name": str(data.get("name") or f"原创DSL：{txt[:12]}"),
        "engine_type": "motion_lab_dsl",
        "group_id": str(data.get("group_id") or group_id),
        "skeleton_spec": {
            "dsl": data["dsl"],
            "design_rationale": data.get("design_rationale", ""),
            "source_prompt": txt,
        },
        "params_schema": data.get("params_schema") or {},
        "narrative_purposes": data.get("narrative_purposes") or ["explainer_graphic", "relation_graph"],
        "default_content": data.get("default_content") or {},
        "default_skin": base_skin or {},
        "sound_cues": data.get("sound_cues") or [],
        "timeline_behavior": {
            "default_duration": round(min(12.0, max(2.0, float(data.get("duration") or 5.0))), 2),
            "min_duration": 1.5,
            "max_duration": 15.0,
            "allow_overlap": True,
        },
        "capabilities": {
            "realtime_param_edit": True,
            "reverse_scrub": True,
            "transparent_export": True,
            "deterministic_ft": True,
        },
        "source_type": "ai_dsl_original",
        "license_note": f"Original MotionDSL v1 generated via {llm_res['model']}",
        "status": "draft",
    }
    return {
        "ok": True,
        "mode": "original_dsl",
        "execution_mode": "real_llm",
        "degraded": False,
        "model": llm_res["model"],
        "total_tokens": total_tokens,
        "dsl_validation": dsl_check,
        "design_rationale": data.get("design_rationale", ""),
        "draft_asset": draft_asset,
    }


def revise_motion_dsl_with_llm(
    current_asset: dict[str, Any],
    revision_prompt: str,
    simulate_llm_failure: bool = False,
) -> dict[str, Any]:
    """R2 多轮自然语言返修：在上一版 MotionDSL 基础上精准修改图层/轨迹/关键帧并递增版本。"""
    skel = current_asset.get("skeleton_spec") or {}
    prev_dsl = skel.get("dsl")
    if not isinstance(prev_dsl, dict):
        raise ValueError("当前资产不是 MotionDSL v1 资产，无法进行 DSL 返修")

    sys_p = f"你是 Motion Graphics 返修专家。请严格按用户意见修改已有 MotionDSL v1 的关键帧时间、运动路径、缩放脉冲或图层结构。\n{DSL_SPEC_PROMPT}"
    usr_p = f"""用户返修要求：{revision_prompt}
上一版完整 MotionDSL v1：
{json.dumps(prev_dsl, ensure_ascii=False)}

请输出 JSON：
{{
  "change_summary": "一句话说明具体修改了哪些图层与关键帧",
  "duration": {float((current_asset.get('timeline_behavior') or {}).get('default_duration') or 5.0)},
  "dsl": {{ ... 修改后的完整 MotionDSL v1 ... }}
}}"""

    llm_res = _call_real_llm_json(sys_p, usr_p, simulate_failure=simulate_llm_failure, temperature=0.2)
    if not llm_res["ok"]:
        return {
            "ok": False,
            "execution_mode": "llm_failed",
            "degraded": True,
            "fallback_reason": llm_res["error"],
            "model": llm_res["model"],
            "total_tokens": 0,
        }

    data = llm_res["data"]
    dsl_check = validate_motion_dsl(data.get("dsl"))
    if not dsl_check["valid"]:
        return {
            "ok": False,
            "execution_mode": "real_llm",
            "degraded": True,
            "fallback_reason": f"返修后的 DSL 未通过白名单校验：{dsl_check['errors'][:3]}",
            "model": llm_res["model"],
            "total_tokens": llm_res["total_tokens"],
        }

    # 递增次版本号 1.0.0 -> 1.1.0 -> 1.2.0
    old_ver = str(current_asset.get("version") or "1.0.0")
    parts = old_ver.split(".")
    try:
        new_ver = f"{parts[0]}.{int(parts[1]) + 1}.0"
    except Exception:
        new_ver = f"1.{int(time.time()) % 100}.0"

    revised = json.loads(json.dumps(current_asset))
    revised["version"] = new_ver
    revised["status"] = "draft"
    revised["skeleton_spec"]["dsl"] = data["dsl"]
    revised["skeleton_spec"]["last_revision"] = revision_prompt
    if data.get("duration"):
        revised.setdefault("timeline_behavior", {})["default_duration"] = round(float(data["duration"]), 2)

    return {
        "ok": True,
        "execution_mode": "real_llm",
        "degraded": False,
        "model": llm_res["model"],
        "total_tokens": llm_res["total_tokens"],
        "change_summary": data.get("change_summary", revision_prompt),
        "dsl_validation": dsl_check,
        "revised_asset": revised,
    }
