"""R2 隔离沙箱安全门禁与 MotionDSL v1 严格白名单校验器。

职责：
1. 对 AI 生成的 MotionDSL v1 JSON 进行严格白名单结构校验（图元白名单、数量上限、嵌套深度、轨道区间、缓动函数白名单、防表达式/脚本注入）；
2. 联合前端离屏沙箱提交的动态变化、同帧确定性 SHA-256 与透明 Alpha 证明执行 4 道硬核门禁。
"""
from __future__ import annotations

import json
import re
from typing import Any

ALLOWED_LAYER_TYPES = {"rect", "circle", "line", "bezier_connector", "text", "arc", "group"}
ALLOWED_EASINGS = {"linear", "easeOutCubic", "easeInCubic", "easeOutQuart", "easeOutExpo", "easeOutBackSoft"}
ALLOWED_TRACK_PROPS = {"x", "y", "scale", "opacity", "rotation", "drawProgress", "width", "height", "fillProgress", "r"}

FORBIDDEN_CODE_PATTERNS = [
    r"\beval\s*\(",
    r"\bFunction\s*\(",
    r"\bfetch\s*\(",
    r"\bXMLHttpRequest\b",
    r"\blocalStorage\b",
    r"\bsessionStorage\b",
    r"document\.cookie",
    r"window\.location",
    r"performance\.now",
    r"\bsetInterval\b",
    r"\bsetTimeout\b",
    r"<script",
    r"javascript:",
    r"__proto__",
    r"constructor\s*\[",
]

MAX_LAYERS_TOTAL = 120
MAX_NESTING_DEPTH = 5


def _count_and_validate_layers(layers: list[Any], depth: int, errors: list[str], counter: list[int]) -> None:
    if depth > MAX_NESTING_DEPTH:
        errors.append(f"图层嵌套深度超过上限 {MAX_NESTING_DEPTH}")
        return
    for idx, layer in enumerate(layers):
        if not isinstance(layer, dict):
            errors.append(f"depth={depth} 第 {idx+1} 个图层不是对象")
            continue
        counter[0] += 1
        if counter[0] > MAX_LAYERS_TOTAL:
            errors.append(f"图元总数超过安全上限 {MAX_LAYERS_TOTAL}")
            return
        ltype = layer.get("type")
        if ltype not in ALLOWED_LAYER_TYPES:
            errors.append(f"非法图元类型：{ltype}（允许：{sorted(ALLOWED_LAYER_TYPES)}）")
        if not layer.get("id"):
            errors.append(f"第 {counter[0]} 个图元缺少 id")

        tracks = layer.get("tracks") or []
        if not isinstance(tracks, list):
            errors.append(f"图元 {layer.get('id')} 的 tracks 必须是数组")
        else:
            for ti, tr in enumerate(tracks):
                if not isinstance(tr, dict):
                    errors.append(f"图元 {layer.get('id')} 第 {ti+1} 条轨道不是对象")
                    continue
                prop = tr.get("prop")
                if prop not in ALLOWED_TRACK_PROPS:
                    errors.append(f"图元 {layer.get('id')} 含非法轨道属性：{prop}")
                easing = tr.get("easing", "easeOutCubic")
                if easing not in ALLOWED_EASINGS:
                    errors.append(f"图元 {layer.get('id')} 含非法缓动函数：{easing}")
                t0 = tr.get("t0")
                t1 = tr.get("t1")
                if not isinstance(t0, (int, float)) or not isinstance(t1, (int, float)) or t0 < 0 or t1 > 1.001 or t1 <= t0:
                    errors.append(f"图元 {layer.get('id')} 轨道时间区间非法：[{t0}, {t1}]")

        if ltype == "group":
            children = layer.get("children") or []
            if not isinstance(children, list):
                errors.append(f"group {layer.get('id')} 的 children 必须是数组")
            else:
                _count_and_validate_layers(children, depth + 1, errors, counter)


def validate_motion_dsl(dsl: Any) -> dict[str, Any]:
    """校验 MotionDSL v1 声明式动画规范。"""
    errors: list[str] = []
    if not isinstance(dsl, dict):
        return {"valid": False, "errors": ["DSL 必须是 JSON 对象"], "layer_count": 0}

    layers = dsl.get("layers")
    if not isinstance(layers, list) or len(layers) == 0:
        return {"valid": False, "errors": ["DSL.layers 必须是非空数组"], "layer_count": 0}

    # 1. 静态注入与危险调用扫描
    raw_dump = json.dumps(dsl, ensure_ascii=False)
    for pat in FORBIDDEN_CODE_PATTERNS:
        if re.search(pat, raw_dump, re.I):
            errors.append(f"命中安全黑名单模式：{pat}")

    # 2. 图元白名单、深度、轨道合法性递归校验
    counter = [0]
    _count_and_validate_layers(layers, 1, errors, counter)

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "layer_count": counter[0],
    }


def run_full_sandbox_gate(asset_payload: dict[str, Any], render_proof: dict[str, Any]) -> dict[str, Any]:
    """执行 R2 完整 4 道隔离沙箱门禁。"""
    gates: list[dict[str, Any]] = []
    engine_type = str(asset_payload.get("engine_type") or "motion_lab_dsl")
    skel = asset_payload.get("skeleton_spec") or {}
    dsl = skel.get("dsl") if isinstance(skel, dict) else None

    # Gate 1: DSL / Schema 白名单结构与安全边界
    if engine_type == "motion_lab_dsl":
        dsl_res = validate_motion_dsl(dsl)
        g1 = dsl_res["valid"]
        g1_detail = f"MotionDSL v1 合法，共 {dsl_res['layer_count']} 个图元" if g1 else "; ".join(dsl_res["errors"][:3])
    else:
        dur = float((asset_payload.get("timeline_behavior") or {}).get("default_duration") or asset_payload.get("duration") or 4.0)
        g1 = 1.2 <= dur <= 15.0
        g1_detail = f"engine={engine_type}, duration={dur}s"
    gates.append({"id": "dsl_schema_whitelist", "label": "Gate 1 · MotionDSL 白名单与边界校验", "pass": g1, "detail": g1_detail})

    # Gate 2: 全局静态安全审计（禁外网/禁自时钟/禁原型链/禁脚本注入）
    raw_all = json.dumps(asset_payload, ensure_ascii=False)
    hits = [pat for pat in FORBIDDEN_CODE_PATTERNS if re.search(pat, raw_all, re.I)]
    g2 = len(hits) == 0
    gates.append({"id": "static_security", "label": "Gate 2 · 静态安全审计（禁外网/自时钟/代码注入）", "pass": g2, "detail": "零风险命中" if g2 else f"拦截：{hits[:3]}"})

    # Gate 3: 离屏动态变化与同帧确定性 SHA-256 校验
    h035 = (render_proof or {}).get("hash_t035")
    h185 = (render_proof or {}).get("hash_t185")
    d1 = (render_proof or {}).get("hash_det1")
    d2 = (render_proof or {}).get("hash_det2")
    g3 = bool(h035 and h185 and h035 != h185 and d1 and d1 == d2)
    gates.append({"id": "determinism_dynamic", "label": "Gate 3 · 纯函数动态变化 & 同帧确定性哈希", "pass": g3, "detail": f"t0.35={h035} != t1.85={h185}, det={d1}"})

    # Gate 4: 透明底 RGBA Alpha 像素校验
    has_alpha = bool((render_proof or {}).get("has_transparent_pixels"))
    gates.append({"id": "transparent_alpha", "label": "Gate 4 · 透明底 RGBA Alpha 通道校验", "pass": has_alpha, "detail": "检测到有效透明 Alpha 像素" if has_alpha else "未检测到透明通道"})

    return {"ok": True, "passed": all(g["pass"] for g in gates), "gates": gates}
