"""Overlay Studio 独立引擎适配层（G1: A01–A16）。

严格遵循隔离原则：
- 不复制 Overlay Studio 的前端渲染源码到主工程；
- 通过回环地址 127.0.0.1:5177 与标准 OverlayDoc JSON 契约 + 子进程 export-frames.mjs 驱动真实透明导出；
- 保留上游独立 LICENSE 与版权声明，所有外部路径均做根目录白名单与防穿越校验。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

from backend.config import DATA_DIR, get_env_config

OVERLAY_ENGINE_ROOT = DATA_DIR.parent / "engines" / "overlay-studio" / "motion-playground"
OVERLAY_ENGINE_BASE_URL = os.getenv("OVERLAY_ENGINE_URL", "http://127.0.0.1:5177/overlay-engine")
VIDEO_STORAGE_DIR = DATA_DIR / "video_studio"
VIDEO_EXPORTS_DIR = VIDEO_STORAGE_DIR / "exports"
VIDEO_UPLOADS_DIR = VIDEO_STORAGE_DIR / "uploads"
VIDEO_CUSTOM_SFX_DIR = VIDEO_STORAGE_DIR / "custom_sfx"

for _d in (VIDEO_STORAGE_DIR, VIDEO_EXPORTS_DIR, VIDEO_UPLOADS_DIR, VIDEO_CUSTOM_SFX_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# 严格对齐 engines/overlay-studio/motion-playground/src/effects/registry.ts 的全部 25 张动效卡
EFFECT_CATALOG: list[dict[str, Any]] = [
    # 常驻层 (3)
    {"id": "chapter-bar", "name": "章节导航条", "group": "常驻层", "desc": "全程章节进度提示条", "defaults": {"chapters": "开场,核心观点,实证拆解,总结", "activeIndex": 0}},
    {"id": "pin-board", "name": "要点钉板", "group": "常驻层", "desc": "持续锚定核心主题或要点清单", "defaults": {"title": "核心要点", "items": "要点一,要点二,要点三"}},
    {"id": "caption-track", "name": "双语字幕轨", "group": "常驻层", "desc": "中英双语字幕叠加层（可关防重叠）", "defaults": {"enabled": True, "bilingual": True, "position": "bottom"}},
    # 证据实证 (1)
    {"id": "stat-proof", "name": "数字实证卡", "group": "证据实证", "desc": "突出真实核心数据及出处背书", "defaults": {"value": "18.6x", "label": "异常爆款倍数", "source": "真实数据出处"}},
    # 数据指标 (9)
    {"id": "ring-metric", "name": "环形占比图", "group": "数据指标", "desc": "展示单项比例或完成度", "defaults": {"value": 68, "label": "核心占比", "unit": "%", "source": ""}},
    {"id": "odometer", "name": "数字滚动表", "group": "数据指标", "desc": "里程表式数字递增动效", "defaults": {"from": 0, "to": 12000, "label": "样本规模", "unit": "", "source": ""}},
    {"id": "rank-bars", "name": "排名柱状图", "group": "数据指标", "desc": "多对象横向排行对比", "defaults": {"title": "排行对比", "items": "对象A:85,对象B:62,对象C:41", "source": ""}},
    {"id": "growth-curve", "name": "增长曲线图", "group": "数据指标", "desc": "时间序列趋势曲线", "defaults": {"title": "增长趋势", "points": "10,24,42,68,95", "source": ""}},
    {"id": "growth-bars", "name": "增长柱状图", "group": "数据指标", "desc": "分阶段柱状增长对比", "defaults": {"title": "阶段增长", "bars": "Q1:20,Q2:35,Q3:58,Q4:84", "source": ""}},
    {"id": "donut-split", "name": "环形分布图", "group": "数据指标", "desc": "多类别结构占比拆解", "defaults": {"title": "结构分布", "slices": "类别A:45,类别B:35,类别C:20", "source": ""}},
    {"id": "waterfall-bridge", "name": "瀑布拆解图", "group": "数据指标", "desc": "增减项累计构成分析", "defaults": {"title": "变化拆解", "steps": "基线:100,增量:+45,损耗:-15,净值:130", "source": ""}},
    {"id": "radar-profile", "name": "雷达能力图", "group": "数据指标", "desc": "多维度综合能力画像", "defaults": {"title": "多维评估", "axes": "流量:80,留存:75,变现:85,门槛:60,复购:70", "source": ""}},
    {"id": "waffle-fill", "name": "华夫格占比", "group": "数据指标", "desc": "百格直观比例填充", "defaults": {"title": "人群占比", "percent": 32, "label": "目标群体", "source": ""}},
    # 对比取舍 (1)
    {"id": "versus-card", "name": "双方案对比卡", "group": "对比取舍", "desc": "A vs B 直观利弊对照", "defaults": {"leftTitle": "方案 A", "rightTitle": "方案 B", "leftText": "核心特征 A", "rightText": "核心特征 B"}},
    # 金句观点 (2)
    {"id": "quote-lockup", "name": "金句定格卡", "group": "金句观点", "desc": "强视觉冲击的核心结论定格", "defaults": {"quote": "核心观点表达", "speaker": ""}},
    {"id": "punch-pill", "name": "强调胶囊标", "group": "金句观点", "desc": "短平快关键词高光弹出", "defaults": {"text": "关键转折点", "tone": "cyan"}},
    # 步骤流程 (2)
    {"id": "step-timeline", "name": "步骤时间轴", "group": "步骤流程", "desc": "线性展示方法论或执行步骤", "defaults": {"title": "执行步骤", "steps": "步骤一,步骤二,步骤三"}},
    {"id": "checklist", "name": "核对清单卡", "group": "步骤流程", "desc": "逐项勾选验证清单", "defaults": {"title": "核心清单", "items": "确认项1,确认项2,确认项3"}},
    # 教程标注 (2)
    {"id": "term-card", "name": "术语解释卡", "group": "教程标注", "desc": "专业概念或缩写即时释义", "defaults": {"term": "核心术语", "definition": "清晰简洁的中文解释"}},
    {"id": "ui-callout", "name": "界面标注框", "group": "教程标注", "desc": "指向屏幕特定位置的提示标注", "defaults": {"label": "重点关注区域", "x": 50, "y": 50}},
    # 文字进场 (2)
    {"id": "blur-text", "name": "聚焦清晰字幕", "group": "文字进场", "desc": "由模糊聚焦到清晰的大字标题", "defaults": {"text": "大字标题进场", "subtext": ""}},
    {"id": "type-shift", "name": "动能切换大字", "group": "文字进场", "desc": "节奏感强的短句动能切换", "defaults": {"text": "核心观点切换"}},
    # 人物锚定 (1)
    {"id": "entity-chips", "name": "实体标签组", "group": "人物锚定", "desc": "人物/品牌/工具多标签浮现", "defaults": {"chips": "标签一,标签二,标签三"}},
    # 场景 · 运镜 (1)
    {"id": "focus-card", "name": "画面聚焦运镜", "group": "场景 · 运镜", "desc": "对参考视频局部进行缩放聚焦", "defaults": {"title": "局部聚焦", "zoom": 1.25, "focusX": 50, "focusY": 50}},
    # 场景 · B-roll (1)
    {"id": "terminal-3d", "name": "3D 终端演示窗", "group": "场景 · B-roll", "desc": "代码/命令/数据终端 B-roll 卡片", "defaults": {"title": "Terminal", "lines": "$ analyze --source verified"}},
]

VALID_EFFECT_IDS = {e["id"] for e in EFFECT_CATALOG}
EFFECT_BY_ID = {e["id"]: e for e in EFFECT_CATALOG}
DATA_CHART_EFFECT_IDS = {
    "stat-proof", "ring-metric", "odometer", "rank-bars", "growth-curve",
    "growth-bars", "donut-split", "waterfall-bridge", "radar-profile", "waffle-fill",
}

DEFAULT_SFX_CATALOG: list[dict[str, str]] = [
    {"id": "pop-light", "file": "pop-light.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "轻量标签弹出"},
    {"id": "pop", "file": "pop.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "标准卡片进场"},
    {"id": "pop-cluster", "file": "pop-cluster.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "多项列表连续弹出"},
    {"id": "click", "file": "click.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "清单勾选/按钮切换"},
    {"id": "chime", "file": "chime.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "金句/结论提示"},
    {"id": "ding", "file": "ding.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "数据实证确认"},
    {"id": "glitch", "file": "glitch.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "反转/异常点强调"},
    {"id": "sparkle", "file": "sparkle.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "亮点/高光提示"},
    {"id": "type", "file": "type.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "打字/终端输入"},
    {"id": "shutter", "file": "shutter.mp3", "license": "CC0 (Kenney Interface Sounds)", "usage": "定格/截图聚焦"},
    {"id": "impact", "file": "impact.mp3", "license": "CC0 (Kenney Impact Sounds)", "usage": "大字重击进场"},
    {"id": "hit-soft", "file": "hit-soft.mp3", "license": "CC0 (Kenney Impact Sounds)", "usage": "柔和强调落位"},
    {"id": "rise", "file": "rise.mp3", "license": "CC0 (Kenney Digital Audio)", "usage": "增长趋势上扬"},
    {"id": "whoosh", "file": "whoosh.mp3", "license": "自研粉噪声合成（无第三方）", "usage": "章节转场扫过"},
    {"id": "whoosh-soft", "file": "whoosh-soft.mp3", "license": "自研粉噪声合成（无第三方）", "usage": "轻柔运镜切换"},
]

PLACEHOLDER_PATTERNS = [
    re.compile(r"\bTODO\b", re.I),
    re.compile(r"\bTBD\b", re.I),
    re.compile(r"\bFIXME\b", re.I),
    re.compile(r"演示数据|占位文本|示例文案|待填写|lorem ipsum", re.I),
]

# 单并发渲染进程管理（防死锁与支持取消）
_RENDER_LOCK = threading.Lock()
_ACTIVE_PROCS: dict[str, subprocess.Popen] = {}
_CANCELLED_JOBS: set[str] = set()


def check_overlay_engine_health() -> dict[str, Any]:
    """检测本地独立 Overlay Studio 回环引擎与导出脚本状态。"""
    exists = (OVERLAY_ENGINE_ROOT / "scripts" / "export-frames.mjs").exists()
    license_exists = (OVERLAY_ENGINE_ROOT.parent / "LICENSE").exists()
    reachable = False
    http_status = None
    error = None
    try:
        req = urllib.request.Request(OVERLAY_ENGINE_BASE_URL, headers={"User-Agent": "GCW-Health"})
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            http_status = resp.status
            reachable = 200 <= resp.status < 400
    except Exception as e:
        error = str(e)
    return {
        "engine_name": "Overlay Studio (独立回环进程)",
        "engine_version": "1.4.0",
        "pinned_commit": "8ce89d410af6ce648e1658eadf57fec15a612d62",
        "license": "Overlay Studio 公开版免费使用授权协议 v1.0 (Source Available, 仅限内部使用/自改，禁止转售或对外服务)",
        "license_file_present": license_exists,
        "engine_dir_ready": exists,
        "loopback_url": OVERLAY_ENGINE_BASE_URL,
        "reachable": reachable,
        "http_status": http_status,
        "error": error,
        "effect_count": len(EFFECT_CATALOG),
        "default_sfx_count": len(DEFAULT_SFX_CATALOG),
    }


def _parse_srt_ts(ts: str) -> float:
    m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)", ts.strip())
    if not m:
        return 0.0
    h, mi, s, ms = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4).ljust(3, "0")[:3])
    return round(h * 3600 + mi * 60 + s + ms / 1000.0, 3)


def parse_srt_text(srt_text: str) -> list[dict[str, Any]]:
    """解析中英文 SRT 字幕文本为精确时间码列表（A01）。"""
    blocks = re.split(r"\r?\n\s*\r?\n", (srt_text or "").strip())
    lines: list[dict[str, Any]] = []
    idx = 0
    for blk in blocks:
        rows = [r.strip() for r in blk.splitlines() if r.strip()]
        if not rows:
            continue
        time_row_idx = next((i for i, r in enumerate(rows) if "-->" in r), -1)
        if time_row_idx < 0:
            continue
        parts = rows[time_row_idx].split("-->")
        if len(parts) != 2:
            continue
        start = _parse_srt_ts(parts[0])
        end = _parse_srt_ts(parts[1])
        if end <= start:
            end = round(start + 0.5, 3)
        text = " ".join(rows[time_row_idx + 1:]).strip()
        if not text:
            continue
        idx += 1
        lines.append({"index": idx, "start": start, "end": end, "text": text})
    return lines


def _format_srt_ts(sec: float) -> str:
    sec = max(0.0, float(sec))
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    if ms >= 1000:
        ms = 999
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def segments_to_srt(segments: list[dict[str, Any]], fallback_text: str = "") -> tuple[str, list[dict[str, Any]]]:
    """将 TranscriptStudio 的 segments_json 或纯文本转为标准 SRT 与结构化行。"""
    lines: list[dict[str, Any]] = []
    if segments:
        for i, seg in enumerate(segments, 1):
            st = round(float(seg.get("start", 0.0)), 3)
            en = round(float(seg.get("end", st + float(seg.get("duration", 3.0)))), 3)
            if en <= st:
                en = round(st + 1.5, 3)
            txt = (seg.get("text") or "").strip()
            if txt:
                lines.append({"index": i, "start": st, "end": en, "text": txt})
    elif fallback_text.strip():
        raw_sents = [s.strip() for s in re.split(r"[。！？.!?\n]+", fallback_text.strip()) if s.strip()]
        cursor = 0.0
        for i, s in enumerate(raw_sents, 1):
            dur = max(2.0, min(6.0, round(len(s) * 0.18, 2)))
            lines.append({"index": i, "start": round(cursor, 3), "end": round(cursor + dur, 3), "text": s})
            cursor += dur

    srt_blocks = []
    for ln in lines:
        srt_blocks.append(f"{ln['index']}\n{_format_srt_ts(ln['start'])} --> {_format_srt_ts(ln['end'])}\n{ln['text']}")
    return "\n\n".join(srt_blocks), lines


def _has_numeric_evidence(text: str) -> bool:
    return bool(re.search(r"\d+(\.\d+)?\s*(%|万|亿|倍|x|X|美元|元|\$|k|K|M|年|月|天)", text or ""))


def compile_overlay_from_srt(
    srt_lines: list[dict[str, Any]],
    aspect_ratio: str = "16:9",
    theme: str = "dark",
    approved_rules: Optional[list[str]] = None,
    use_llm: bool = True,
) -> dict[str, Any]:
    """A01+A04：基于真实 SRT 时间码与已批准偏好，生成合法 OverlayDoc 编排。"""
    if not srt_lines:
        raise ValueError("缺少有效字幕行，请先导入 SRT 或从文案提取工坊导入字幕。")

    total_sec = round(max(ln["end"] for ln in srt_lines), 3)
    ratio_code = "v" if aspect_ratio == "9:16" else ("4:3" if aspect_ratio == "4:3" else "h")
    cfg = get_env_config()
    llm_meta: dict[str, Any] = {"used_llm": False, "model": None, "total_tokens": 0, "warnings": []}

    cards: list[dict[str, Any]] = []

    # 优先使用已配置的 DeepSeek LLM 进行语义编排
    if use_llm and cfg.get("llm_configured"):
        try:
            from openai import OpenAI

            client = OpenAI(api_key=os.getenv("LLM_API_KEY"), base_url=cfg["llm_base_url"])
            allowed_desc = "\n".join(f"- {e['id']} ({e['group']}/{e['name']}): {e['desc']}" for e in EFFECT_CATALOG)
            srt_brief = "\n".join(
                f"[{ln['index']}] {ln['start']:.2f}s-{ln['end']:.2f}s: {ln['text']}"
                for ln in srt_lines[:80]
            )
            pref_txt = "\n".join(f"- {r}" for r in (approved_rules or [])) or "（暂无自定义偏好）"
            prompt = f"""你是专业口播视频动效编排导演。请严格根据以下真实字幕时间码生成动效卡片 JSON。
硬性约束：
1. 只能使用以下 25 种合法 kind，严禁发明新 kind：
{allowed_desc}
2. 每张卡的 start 和 end 必须落在 [0, {total_sec}] 真实字幕时间范围内，且 end > start + 0.8。
3. 严禁出现 TODO/TBD/演示数据/占位文本；若台词中无真实数字，禁止使用数据图表类 kind（stat-proof/ring-metric/odometer/rank-bars/growth-curve/growth-bars/donut-split/waterfall-bridge/radar-profile/waffle-fill）。
4. 每张卡必须包含 source_srt_index（引用真实字幕序号）与 sfx（从 pop/pop-light/chime/ding/click/whoosh-soft/impact 中选或 null）。
5. 遵守用户已批准偏好：
{pref_txt}

真实字幕：
{srt_brief}

请只输出 JSON 对象：{{"chapters": ["..."], "cards": [{{"id": "card-1", "kind": "...", "start": 0.0, "end": 4.0, "source_srt_index": 1, "sfx": "pop", "params": {{...}}}}]}}"""

            resp = client.chat.completions.create(
                model=cfg["llm_model"],
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                response_format={"type": "json_object"},
                timeout=45,
            )
            raw_json = resp.choices[0].message.content or "{}"
            parsed = json.loads(raw_json)
            llm_meta["used_llm"] = True
            llm_meta["model"] = cfg["llm_model"]
            llm_meta["total_tokens"] = getattr(resp.usage, "total_tokens", 0) or 0
            for i, c in enumerate(parsed.get("cards", []), 1):
                kind = str(c.get("kind") or "").strip()
                if kind not in VALID_EFFECT_IDS:
                    llm_meta["warnings"].append(f"已拦截 LLM 生成的未知模板 {kind}")
                    continue
                st = max(0.0, min(total_sec - 0.5, round(float(c.get("start", 0.0)), 2)))
                en = max(st + 1.0, min(total_sec, round(float(c.get("end", st + 3.0)), 2)))
                srt_idx = c.get("source_srt_index")
                src_line = next((x for x in srt_lines if x["index"] == srt_idx), None)
                if kind in DATA_CHART_EFFECT_IDS and src_line and not _has_numeric_evidence(src_line["text"]):
                    llm_meta["warnings"].append(f"台词 #{srt_idx} 不含数字证据，已将 {kind} 降级为 quote-lockup")
                    kind = "quote-lockup"
                merged_params = {**EFFECT_BY_ID[kind]["defaults"], **(c.get("params") or {})}
                if c.get("sfx"):
                    merged_params["sfx"] = c["sfx"]
                if srt_idx is not None:
                    merged_params["source_srt_index"] = srt_idx
                cards.append({
                    "id": str(c.get("id") or f"card-{i}"),
                    "kind": kind,
                    "start": st,
                    "end": en,
                    "params": merged_params,
                })
        except Exception as e:
            llm_meta["warnings"].append(f"AI 编排调用回退为确定性语义规则：{e}")

    # 若未启用 LLM 或 LLM 产出为空，使用确定性语义规则（零虚构，严格引用真实台词）
    if not cards:
        step = max(1, len(srt_lines) // 6)
        picked = srt_lines[::step][:8]
        # 1. 常驻章节条
        cards.append({
            "id": "card-chapter",
            "kind": "chapter-bar",
            "start": 0.0,
            "end": total_sec,
            "params": {
                "chapters": ",".join(ln["text"][:10] for ln in picked[:4]) or "正文",
                "activeIndex": 0,
                "source_srt_index": 1,
                "sfx": "whoosh-soft",
            },
        })
        for idx_i, ln in enumerate(picked, 1):
            st = round(ln["start"], 2)
            en = round(min(total_sec, max(ln["end"], st + 2.5)), 2)
            txt = ln["text"]
            if _has_numeric_evidence(txt):
                m = re.search(r"\d+(?:\.\d+)?\s*(?:%|万|亿|倍|x|X|\$|美元|元)?", txt)
                val = m.group(0) if m else "数据"
                cards.append({
                    "id": f"card-{idx_i}",
                    "kind": "stat-proof",
                    "start": st,
                    "end": en,
                    "params": {"value": val, "label": txt[:24], "source": f"SRT #{ln['index']}", "source_srt_index": ln["index"], "sfx": "ding"},
                })
            elif idx_i == 1:
                cards.append({
                    "id": f"card-{idx_i}",
                    "kind": "blur-text",
                    "start": st,
                    "end": en,
                    "params": {"text": txt[:28], "subtext": "", "source_srt_index": ln["index"], "sfx": "impact"},
                })
            else:
                cards.append({
                    "id": f"card-{idx_i}",
                    "kind": "quote-lockup",
                    "start": st,
                    "end": en,
                    "params": {"quote": txt[:42], "speaker": "", "source_srt_index": ln["index"], "sfx": "pop"},
                })

    doc = {
        "version": 1,
        "ratio": ratio_code,
        "theme": theme if theme in ("dark", "light") else "dark",
        "exportFps": 30,
        "srt": [{"start": x["start"], "end": x["end"], "text": x["text"]} for x in srt_lines],
        "cards": cards,
    }
    return {"doc": doc, "meta": llm_meta, "duration_ms": int(round(total_sec * 1000))}


def lint_overlay_doc(doc: dict[str, Any], duration_sec: Optional[float] = None) -> dict[str, Any]:
    """A13 编排质量检查（纯检查不修改）：区分阻止导出的 hard errors 与可显式忽略的 warnings。"""
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    if not isinstance(doc, dict) or not isinstance(doc.get("cards"), list):
        return {
            "passed": False,
            "error_count": 1,
            "warning_count": 0,
            "errors": [{"rule": "invalid_schema", "card_id": None, "message": "缺少合法 cards 数组"}],
            "warnings": [],
        }

    cards = doc["cards"]
    if len(cards) == 0:
        errors.append({"rule": "empty_cards", "card_id": None, "message": "编排中没有任何动效卡片"})

    seen_ids: set[str] = set()
    non_persistent: list[tuple[float, float, str]] = []
    srt_max = max((float(s.get("end", 0)) for s in (doc.get("srt") or [])), default=0.0)
    max_bound = max(duration_sec or 0.0, srt_max)

    for idx, c in enumerate(cards):
        cid = str(c.get("id") or f"idx-{idx}")
        kind = str(c.get("kind") or "")
        lint_off = c.get("lintOff")

        def _is_ignored(rule_name: str) -> bool:
            if lint_off is True:
                return True
            if isinstance(lint_off, list) and rule_name in lint_off:
                return True
            return False

        if cid in seen_ids:
            errors.append({"rule": "duplicate_id", "card_id": cid, "message": f"卡片 ID 重复: {cid}"})
        seen_ids.add(cid)

        if kind not in VALID_EFFECT_IDS:
            errors.append({"rule": "unknown_kind", "card_id": cid, "message": f"未知动效模板: {kind}（不在 25 卡注册表内）"})

        try:
            st = float(c.get("start", -1))
            en = float(c.get("end", -1))
        except Exception:
            errors.append({"rule": "invalid_time", "card_id": cid, "message": "start/end 非有效数字"})
            continue

        if st < 0 or en <= st:
            errors.append({"rule": "time_order", "card_id": cid, "message": f"时间范围非法: {st}s ~ {en}s"})
        if max_bound > 0 and en > max_bound + 2.0:
            errors.append({"rule": "time_out_of_bounds", "card_id": cid, "message": f"结束时间 {en}s 超出字幕/视频总时长 {max_bound:.1f}s"})

        params = c.get("params") or {}
        serialized = json.dumps(params, ensure_ascii=False)
        for pat in PLACEHOLDER_PATTERNS:
            if pat.search(serialized):
                errors.append({"rule": "placeholder_text", "card_id": cid, "message": f"检测到未替换占位文本（命中 {pat.pattern}）"})
                break

        if en - st < 0.8:
            if not _is_ignored("too_short"):
                warnings.append({"rule": "too_short", "card_id": cid, "message": f"卡片时长仅 {en - st:.2f}s，观众可能来不及阅读"})

        if kind not in ("chapter-bar", "pin-board", "caption-track"):
            non_persistent.append((st, en, cid))

    # 检查同时叠加拥挤（>=3 张非背景卡同时出现）
    for i, (s1, e1, id1) in enumerate(non_persistent):
        overlap = [id2 for j, (s2, e2, id2) in enumerate(non_persistent) if i != j and s2 < e1 and e2 > s1]
        if len(overlap) >= 2:
            card_obj = next((x for x in cards if x.get("id") == id1), {})
            loff = card_obj.get("lintOff")
            if not (loff is True or (isinstance(loff, list) and "crowded_overlap" in loff)):
                warnings.append({
                    "rule": "crowded_overlap",
                    "card_id": id1,
                    "message": f"与 {', '.join(overlap[:2])} 同时叠加超过 2 张，画面可能拥挤（可显式忽略）",
                })

    return {
        "passed": len(errors) == 0,
        "error_count": len(errors),
        "warning_count": len(warnings),
        "errors": errors,
        "warnings": warnings,
    }


def compute_overlay_diff(orig_doc: dict[str, Any], edited_doc: dict[str, Any]) -> dict[str, Any]:
    """A16：计算 AI 草稿与人工修改版的精确差异并提炼候选偏好规则（不用于模型训练）。"""
    orig_cards = {c["id"]: c for c in (orig_doc.get("cards") or []) if isinstance(c, dict) and c.get("id")}
    edit_cards = {c["id"]: c for c in (edited_doc.get("cards") or []) if isinstance(c, dict) and c.get("id")}

    added = [cid for cid in edit_cards if cid not in orig_cards]
    removed = [cid for cid in orig_cards if cid not in edit_cards]
    modified: list[dict[str, Any]] = []

    kind_replacements: list[str] = []
    sfx_changes: list[str] = []
    duration_deltas: list[float] = []

    for cid, ec in edit_cards.items():
        if cid not in orig_cards:
            continue
        oc = orig_cards[cid]
        changes = {}
        if oc.get("kind") != ec.get("kind"):
            changes["kind"] = [oc.get("kind"), ec.get("kind")]
            kind_replacements.append(f"{oc.get('kind')} -> {ec.get('kind')}")
        if oc.get("start") != ec.get("start") or oc.get("end") != ec.get("end"):
            old_d = float(oc.get("end", 0)) - float(oc.get("start", 0))
            new_d = float(ec.get("end", 0)) - float(ec.get("start", 0))
            duration_deltas.append(round(new_d - old_d, 2))
            changes["time"] = [[oc.get("start"), oc.get("end")], [ec.get("start"), ec.get("end")]]
        op = oc.get("params") or {}
        ep = ec.get("params") or {}
        if op.get("sfx") != ep.get("sfx"):
            changes["sfx"] = [op.get("sfx"), ep.get("sfx")]
            sfx_changes.append(f"{ep.get('kind', ec.get('kind'))}: {op.get('sfx')} -> {ep.get('sfx')}")
        if op != ep:
            changed_keys = [k for k in set(op) | set(ep) if op.get(k) != ep.get(k)]
            if changed_keys:
                changes["param_keys"] = changed_keys
        if changes:
            modified.append({"card_id": cid, "changes": changes})

    proposals: list[str] = []
    if kind_replacements:
        proposals.append(f"模板偏好：优先使用替换后的动效卡（{', '.join(kind_replacements[:3])}）")
    if removed:
        proposals.append(f"精简偏好：减少冗余卡片（本次删除 {len(removed)} 张卡）")
    if sfx_changes:
        proposals.append(f"音效偏好：{'; '.join(sfx_changes[:3])}")
    if duration_deltas:
        avg_delta = round(sum(duration_deltas) / len(duration_deltas), 2)
        if abs(avg_delta) >= 0.3:
            proposals.append(f"停留时长偏好：单卡时长倾向{'延长' if avg_delta > 0 else '缩短'}约 {abs(avg_delta)} 秒")
    if not proposals and (added or modified):
        proposals.append(f"样式微调偏好：共新增 {len(added)} 张卡、调整 {len(modified)} 张卡参数")

    return {
        "added_ids": added,
        "removed_ids": removed,
        "modified": modified,
        "proposed_rule": "；".join(proposals) if proposals else "无显著结构差异",
    }


def run_ffprobe(media_path: Path) -> dict[str, Any]:
    """用 ffprobe 实测校验透明通道、分辨率、时长与音轨。"""
    proc = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration,size,format_name:stream=index,codec_type,codec_name,pix_fmt,width,height,r_frame_rate",
            "-of", "json",
            str(media_path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        return {"ok": False, "error": proc.stderr.strip()}
    data = json.loads(proc.stdout or "{}")
    v_streams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    a_streams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    pix_fmt = v_streams[0].get("pix_fmt", "") if v_streams else ""
    has_alpha = any(k in pix_fmt.lower() for k in ("yuva", "rgba", "argb", "bgra", "gbrap"))
    return {
        "ok": True,
        "duration_sec": round(float(data.get("format", {}).get("duration") or 0), 3),
        "size_bytes": int(data.get("format", {}).get("size") or 0),
        "video_codec": v_streams[0].get("codec_name") if v_streams else None,
        "pix_fmt": pix_fmt,
        "has_alpha": has_alpha,
        "width": v_streams[0].get("width") if v_streams else None,
        "height": v_streams[0].get("height") if v_streams else None,
        "audio_streams": len(a_streams),
        "raw": data,
    }


def execute_overlay_render_job(
    job_uid: str,
    doc: dict[str, Any],
    mode: str,
    effect_id: Optional[str],
    outputs: list[str],
    fps: float,
    duration_sec: float,
    aspect_ratio: str,
    on_progress,
    on_complete,
    on_fail,
) -> None:
    """A12/A15：后台线程调用独立 Overlay Studio 的 scripts/export-frames.mjs 执行真实透明导出。"""
    def _worker():
        if not _RENDER_LOCK.acquire(timeout=1):
            on_fail("当前已有渲染任务正在运行，请等待完成或先取消当前任务（单并发保护）。")
            return
        job_dir = VIDEO_EXPORTS_DIR / job_uid
        job_dir.mkdir(parents=True, exist_ok=True)
        job_json_path = job_dir / "job.json"
        try:
            ratio_code = "v" if aspect_ratio == "9:16" else ("4:3" if aspect_ratio == "4:3" else "h")
            payload: dict[str, Any] = {
                "runId": job_uid,
                "mode": mode,
                "fps": fps,
                "duration": max(1.0, float(duration_sec)),
                "base": OVERLAY_ENGINE_BASE_URL,
                "outputs": outputs,
                "ratio": ratio_code,
                "outputDir": str(job_dir),
            }
            if mode == "single":
                payload["effectId"] = effect_id or "quote-lockup"
                payload["params"] = EFFECT_BY_ID.get(payload["effectId"], {}).get("defaults", {})
            else:
                doc_copy = {**doc, "ratio": ratio_code}
                payload["doc"] = doc_copy

            job_json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            on_progress(5, "已下发任务至独立 Overlay Studio 引擎，正在启动无头渲染...")

            cmd = ["node", "scripts/export-frames.mjs", str(job_json_path)]
            proc = subprocess.Popen(
                cmd,
                cwd=str(OVERLAY_ENGINE_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            _ACTIVE_PROCS[job_uid] = proc

            tail_logs: list[str] = []
            assert proc.stdout is not None
            for line in proc.stdout:
                s = line.strip()
                if not s:
                    continue
                tail_logs.append(s)
                if len(tail_logs) > 40:
                    tail_logs.pop(0)
                # 解析进度提示
                m_pct = re.search(r"(\d{1,3})%", s)
                if m_pct:
                    pct = max(5, min(95, int(m_pct.group(1))))
                    on_progress(pct, s[:160])
                elif "ffmpeg" in s.lower() or "编码" in s or "封装" in s:
                    on_progress(88, s[:160])

            rc = proc.wait()
            _ACTIVE_PROCS.pop(job_uid, None)

            if job_uid in _CANCELLED_JOBS:
                _CANCELLED_JOBS.discard(job_uid)
                shutil.rmtree(job_dir, ignore_errors=True)
                on_fail("任务已被用户取消并清理临时文件", cancelled=True)
                return

            if rc != 0:
                err_msg = " | ".join(tail_logs[-5:]) or f"渲染进程退出码 {rc}"
                on_fail(err_msg)
                return

            mov_files = sorted(job_dir.glob("*.mov"), key=lambda p: p.stat().st_mtime, reverse=True)
            webm_files = sorted(job_dir.glob("*.webm"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not mov_files and not webm_files:
                on_fail("渲染进程正常退出，但未找到输出的 .mov / .webm 文件")
                return

            primary = mov_files[0] if mov_files else webm_files[0]
            probe = run_ffprobe(primary)
            on_complete(
                str(mov_files[0]) if mov_files else None,
                str(webm_files[0]) if webm_files else None,
                probe,
            )
        except Exception as e:
            on_fail(str(e))
        finally:
            _ACTIVE_PROCS.pop(job_uid, None)
            _RENDER_LOCK.release()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()


def cancel_overlay_render_job(job_uid: str) -> bool:
    """取消正在运行的渲染进程树并标记清理临时文件。"""
    _CANCELLED_JOBS.add(job_uid)
    proc = _ACTIVE_PROCS.get(job_uid)
    if not proc:
        return False
    try:
        # Windows 杀进程树，避免残留 Chrome/FFmpeg 子进程
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True,
            timeout=10,
        )
        return True
    except Exception:
        try:
            proc.kill()
            return True
        except Exception:
            return False


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def safe_filename(name: str, allowed_exts: set[str]) -> str:
    base = Path(name).name
    ext = Path(base).suffix.lower()
    if ext not in allowed_exts:
        raise ValueError(f"不支持的文件格式 {ext}，允许格式：{', '.join(sorted(allowed_exts))}")
    stem = re.sub(r"[^a-zA-Z0-9_\-\u4e00-\u9fff]+", "_", Path(base).stem).strip("_") or "file"
    return f"{stem}_{int(time.time())}{ext}"
