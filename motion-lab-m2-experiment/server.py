"""AI Motion & Style Lab · M2 独立实验台本地服务（http://127.0.0.1:5199/）。

严格隔离：不修改主工作台任何源码、数据库或配置；仅托管独立实验台并提供真实 FFmpeg 透明 MOV/WebM 导出与 ffprobe 校验。
"""
import base64
import json
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
EXPORTS_DIR = ROOT / "exports"
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
REGISTRY_DIR = ROOT / "registry"
REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
REGISTRY_FILE = REGISTRY_DIR / "custom_cards.json"
DNA_PROFILE_FILE = REGISTRY_DIR / "style_dna_profile.json"
ATLAS_PROMPT_FILE = ROOT.parent / "atlas-p1b-experiment" / "atlas_prompt_library.json"
ATLAS_CATALOG_FILE = ROOT.parent / "atlas-p1b-experiment" / "atlas_catalog_cn.json"
MOTION_CATALOG_FILE = ROOT.parent / "atlas-p1b-experiment" / "r2_motion_catalog.json"

app = FastAPI(title="AI Motion & Style Lab · M2/M3/M4 独立研发实验台")


def _load_atlas_prompts() -> list[dict]:
    """只读加载已有 504 项 Atlas 风格词条（严禁修改原文件）。"""
    if not ATLAS_PROMPT_FILE.is_file():
        return []
    try:
        return json.loads(ATLAS_PROMPT_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _load_atlas_full() -> list[dict]:
    """合并 atlas_catalog_cn.json (504) 与 atlas_prompt_library.json (504) 为全量中文检索索引。"""
    prompt_map = {str(p.get("source_id")): p for p in ATLAS_CACHE}
    if not ATLAS_CATALOG_FILE.is_file():
        return []
    try:
        raw = json.loads(ATLAS_CATALOG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    out = []
    for item in raw:
        sid = str(item.get("source_id") or "")
        cat = (item.get("original") or {}).get("catalog") or {}
        tr = item.get("translation") or {}
        pm = prompt_map.get(sid) or {}
        out.append({
            "id": sid,
            "title_zh": tr.get("title") or cat.get("title") or sid,
            "title_en": cat.get("title") or sid,
            "category": pm.get("mode") or cat.get("kind") or "视觉风格",
            "decade": cat.get("decade") or "",
            "summary": (tr.get("visual_features") or pm.get("recipe") or tr.get("prompt") or "")[:120],
            "prompt": (pm.get("recipe") or tr.get("prompt") or "")[:220],
        })
    return out


def _load_motion_full() -> list[dict]:
    """只读加载 r2_motion_catalog.json 全量 264 项 Motion Prompt 镜头与动效参考。"""
    if not MOTION_CATALOG_FILE.is_file():
        return []
    try:
        raw = json.loads(MOTION_CATALOG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    pack_names = {}
    for pk in raw.get("packs") or []:
        t = pk.get("title") or {}
        pack_names[pk.get("pack")] = t.get("zh-Hans") or t.get("en") or pk.get("pack")
    out = []
    for el in raw.get("elements") or []:
        nm = el.get("name") or {}
        mn = el.get("meaning") or {}
        pk_id = el.get("pack") or "motion"
        out.append({
            "id": f"{pk_id}:{el.get('slug') or el.get('id')}",
            "slug": el.get("slug") or "",
            "title_zh": nm.get("zh-Hans") or nm.get("en") or el.get("slug"),
            "title_en": nm.get("en") or el.get("slug"),
            "category": pack_names.get(pk_id, pk_id),
            "sub_category": el.get("category") or "",
            "cycle": float(el.get("cycle") or 4.0),
            "summary": mn.get("zh-Hans") or mn.get("en") or "",
            "prompt": f"{nm.get('en', '')}: {mn.get('en', '')}".strip(": "),
        })
    return out


ATLAS_CACHE = _load_atlas_prompts()
ATLAS_FULL_504 = _load_atlas_full()
MOTION_FULL_264 = _load_motion_full()


def _load_registry() -> list[dict]:
    if not REGISTRY_FILE.is_file():
        return []
    try:
        return json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_registry(items: list[dict]) -> None:
    REGISTRY_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{max(0, min(255, int(r))):02x}{max(0, min(255, int(g))):02x}{max(0, min(255, int(b))):02x}"


def _color_sat(r: int, g: int, b: int) -> float:
    mx, mn = max(r, g, b), min(r, g, b)
    return 0.0 if mx == 0 else (mx - mn) / mx


def _match_atlas(keywords: list[str], limit: int = 3) -> list[dict]:
    """基于关键词从已有 504 项 Atlas 库中检索最相关的视觉参考词条。"""
    if not ATLAS_CACHE:
        return []
    scored = []
    for item in ATLAS_CACHE:
        blob = " ".join([
            str(item.get("source_id") or ""),
            str(item.get("mode") or ""),
            str(item.get("official_zh") or ""),
            str(item.get("recipe") or ""),
        ]).lower()
        score = sum(1 for kw in keywords if kw and kw.lower() in blob)
        if score > 0:
            scored.append((score, item))
    scored.sort(key=lambda x: x[0], reverse=True)
    picks = [x[1] for x in scored[:limit]] or ATLAS_CACHE[:limit]
    return [
        {
            "source_id": p.get("source_id"),
            "mode": p.get("mode"),
            "recipe": p.get("recipe") or (p.get("official_zh") or "")[:60],
        }
        for p in picks
    ]


def _probe(path: Path) -> dict:
    cmd = ["ffprobe", "-v", "error"]
    if path.suffix.lower() == ".webm":
        cmd += ["-c:v", "libvpx-vp9"]
    cmd += [
        "-show_entries", "format=duration,size:stream=codec_type,codec_name,pix_fmt,width,height:stream_tags=alpha_mode",
        "-of", "json", str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    if proc.returncode != 0:
        return {"ok": False, "error": proc.stderr.strip()}
    data = json.loads(proc.stdout or "{}")
    vs = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    pix = vs[0].get("pix_fmt", "") if vs else ""
    alpha_mode = (vs[0].get("tags") or {}).get("alpha_mode") if vs else None
    return {
        "ok": True,
        "codec": vs[0].get("codec_name") if vs else None,
        "pix_fmt": pix,
        "alpha_mode": alpha_mode,
        "has_alpha": any(k in pix.lower() for k in ("yuva", "rgba", "argb", "bgra", "gbrap")) or str(alpha_mode) == "1",
        "width": vs[0].get("width") if vs else None,
        "height": vs[0].get("height") if vs else None,
        "duration_sec": round(float(data.get("format", {}).get("duration") or 0), 3),
        "size_bytes": int(data.get("format", {}).get("size") or 0),
    }


class ExportFramesBody(BaseModel):
    name: str
    fps: int = 30
    frames: list[str]


@app.post("/api/export-transparent")
def api_export_transparent(body: ExportFramesBody):
    """将浏览器 Canvas 确定性渲染的透明 RGBA PNG 序列编码为透明 ProRes 4444 MOV + VP9 WebM 并用 ffprobe 验证。"""
    if not body.frames or len(body.frames) > 300:
        raise HTTPException(400, "帧数必须在 1–300 之间")
    stamp = time.strftime("%Y%m%d_%H%M%S")
    safe_name = "".join(ch if ch.isalnum() or ch in ("_", "-") else "_" for ch in body.name)[:60]
    tmp_dir = EXPORTS_DIR / f"_tmp_{safe_name}_{stamp}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    mov_out = EXPORTS_DIR / f"{safe_name}_{stamp}.mov"
    webm_out = EXPORTS_DIR / f"{safe_name}_{stamp}.webm"

    try:
        for i, data_url in enumerate(body.frames, 1):
            raw_b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
            (tmp_dir / f"f_{i:04d}.png").write_bytes(base64.b64decode(raw_b64))

        # 1. ProRes 4444 透明 MOV（与 Overlay Studio 剪映规范一致：premultiply + yuva444p10le）
        p1 = subprocess.run(
            [
                "ffmpeg", "-y", "-framerate", str(body.fps), "-i", str(tmp_dir / "f_%04d.png"),
                "-vf", "premultiply=inplace=1",
                "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
                "-vendor", "apl0", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                str(mov_out),
            ],
            capture_output=True, text=True, timeout=90,
        )
        if p1.returncode != 0:
            raise HTTPException(500, f"MOV 编码失败：{p1.stderr[-300:]}")

        # 2. VP9 Alpha 透明 WebM
        p2 = subprocess.run(
            [
                "ffmpeg", "-y", "-framerate", str(body.fps), "-i", str(tmp_dir / "f_%04d.png"),
                "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
                "-auto-alt-ref", "0", str(webm_out),
            ],
            capture_output=True, text=True, timeout=90,
        )
        if p2.returncode != 0:
            raise HTTPException(500, f"WebM 编码失败：{p2.stderr[-300:]}")

        mov_probe = _probe(mov_out)
        webm_probe = _probe(webm_out)
        return {
            "ok": True,
            "frames": len(body.frames),
            "mov_path": str(mov_out),
            "webm_path": str(webm_out),
            "mov_filename": mov_out.name,
            "webm_filename": webm_out.name,
            "mov_url": f"/api/download/{mov_out.name}",
            "webm_url": f"/api/download/{webm_out.name}",
            "mov_size_bytes": mov_probe.get("size_bytes", 0),
            "webm_size_bytes": webm_probe.get("size_bytes", 0),
            "ffprobe_mov": mov_probe,
            "ffprobe_webm": webm_probe,
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@app.get("/api/download/{filename}")
def api_download_export(filename: str):
    """提供透明视频文件的浏览器附件下载，防止路径穿越。"""
    safe_name = Path(filename).name
    target = EXPORTS_DIR / safe_name
    if not target.is_file():
        raise HTTPException(404, "导出文件不存在")
    media = "video/quicktime" if safe_name.endswith(".mov") else "video/webm"
    return FileResponse(target, media_type=media, filename=safe_name)


class AnalyzeRefBody(BaseModel):
    filename: str
    data_url: str


@app.post("/api/m3/analyze-reference")
def api_m3_analyze_reference(body: AnalyzeRefBody):
    """M3 参考素材真实反推：调用本地 FFmpeg 采样 RGB 帧流，量化色彩、判断明暗与节奏能量并映射为候选皮肤。"""
    ext = Path(body.filename).suffix.lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm"):
        raise HTTPException(400, f"不支持的参考格式：{ext}")
    raw_b64 = body.data_url.split(",", 1)[1] if "," in body.data_url else body.data_url
    try:
        raw_bytes = base64.b64decode(raw_b64)
    except Exception:
        raise HTTPException(400, "参考文件 base64 解码失败")

    stamp = f"{time.strftime('%H%M%S')}_{uuid.uuid4().hex[:6]}"
    tmp_file = EXPORTS_DIR / f"_ref_{stamp}{ext}"
    tmp_file.write_bytes(raw_bytes)
    try:
        is_video = ext in (".mp4", ".mov", ".webm", ".gif")
        probe = _probe(tmp_file) if is_video else {"ok": True, "duration_sec": 4.0}
        duration_sec = probe.get("duration_sec") or 4.0

        # 用 FFmpeg 解码为 64x36 rgb24 原始像素流（图片 1 帧，视频最多采样 6 帧）
        vf = "fps=2,scale=64:36" if is_video else "scale=64:36"
        cmd = ["ffmpeg", "-v", "error", "-i", str(tmp_file), "-vf", vf, "-frames:v", "6" if is_video else "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        proc = subprocess.run(cmd, capture_output=True, timeout=25)
        if proc.returncode != 0 or not proc.stdout:
            raise HTTPException(500, f"FFmpeg 采样失败：{proc.stderr.decode(errors='ignore')[-200:]}")

        frame_size = 64 * 36 * 3
        buf = proc.stdout
        n_frames = max(1, len(buf) // frame_size)
        first = buf[:frame_size]

        # 1. 采样四角与边缘像素估算背景色；采样全图高饱和像素估算主强调色
        border_rgb = []
        accent_candidates = []
        luma_sum = 0.0
        px_count = 64 * 36
        for idx in range(px_count):
            r, g, b = first[idx * 3], first[idx * 3 + 1], first[idx * 3 + 2]
            luma = 0.299 * r + 0.587 * g + 0.114 * b
            luma_sum += luma
            y_pos, x_pos = divmod(idx, 64)
            if x_pos < 4 or x_pos >= 60 or y_pos < 4 or y_pos >= 32:
                border_rgb.append((r, g, b))
            sat = _color_sat(r, g, b)
            if sat > 0.38 and 45 < luma < 235:
                accent_candidates.append((sat * (1.0 - abs(luma - 140) / 140.0), r, g, b))

        avg_luma = luma_sum / px_count
        is_dark = avg_luma < 115
        bg_r = sum(c[0] for c in border_rgb) / max(1, len(border_rgb))
        bg_g = sum(c[1] for c in border_rgb) / max(1, len(border_rgb))
        bg_b = sum(c[2] for c in border_rgb) / max(1, len(border_rgb))

        if accent_candidates:
            accent_candidates.sort(key=lambda x: x[0], reverse=True)
            top = accent_candidates[: max(1, min(12, len(accent_candidates)))]
            ac_r = sum(c[1] for c in top) / len(top)
            ac_g = sum(c[2] for c in top) / len(top)
            ac_b = sum(c[3] for c in top) / len(top)
            accent_hex = _rgb_to_hex(ac_r, ac_g, ac_b)
        else:
            accent_hex = "#3b82f6" if is_dark else "#ea580c"

        # 2. 若是多帧视频/GIF，计算相邻帧差分能量推导节奏系数
        motion_energy = 0.0
        if n_frames > 1:
            diffs = []
            for fi in range(n_frames - 1):
                f_a = buf[fi * frame_size : (fi + 1) * frame_size]
                f_b = buf[(fi + 1) * frame_size : (fi + 2) * frame_size]
                diff = sum(abs(a - b) for a, b in zip(f_a, f_b)) / (frame_size * 255.0)
                diffs.append(diff)
            motion_energy = round(sum(diffs) / len(diffs), 4)

        motion_intensity = round(min(1.45, max(0.8, 0.9 + motion_energy * 2.5)), 2) if is_video else 1.0
        stage_bg = _rgb_to_hex(bg_r, bg_g, bg_b)
        surface_bg = _rgb_to_hex(bg_r + 14, bg_g + 15, bg_b + 20) if is_dark else "#ffffff"
        surface_alt = _rgb_to_hex(bg_r + 28, bg_g + 30, bg_b + 38) if is_dark else "#f1efe9"
        border_color = _rgb_to_hex(bg_r + 52, bg_g + 56, bg_b + 68) if is_dark else "#e2ded5"

        skin_id = f"ref_skin_{stamp}"
        candidate_skin = {
            "id": skin_id,
            "name": f"参考反推 · {Path(body.filename).stem[:10]}",
            "mode": "production",
            "source": "m3_reference_reverse",
            "atlas_refs": [m["source_id"] for m in _match_atlas(["暗黑", "蓝", "极简"] if is_dark else ["极简", "印刷", "浅色"], 2)],
            "tokens": {
                "stage_bg": stage_bg,
                "surface_bg": surface_bg,
                "surface_alt": surface_alt,
                "border_color": border_color,
                "border_style": "solid",
                "border_width": 1.2,
                "radius": 14,
                "text_primary": "#ffffff" if is_dark else "#18181b",
                "text_secondary": "#cbd5e1" if is_dark else "#52525b",
                "text_muted": "#94a3b8" if is_dark else "#71717a",
                "accent_primary": accent_hex,
                "accent_secondary": "#0ea5e9" if is_dark else "#0f766e",
                "shadow": "0 20px 44px rgba(0, 0, 0, 0.45)" if is_dark else "0 14px 34px rgba(24, 24, 27, 0.08)",
                "font_display": "'Microsoft YaHei UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
                "font_body": "'Microsoft YaHei UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
                "show_motion_guides": False,
            },
        }
        atlas_hits = _match_atlas(["暗黑", "科技", "极简"] if is_dark else ["浅色", "排版", "极简"], 3)
        return {
            "ok": True,
            "analysis": {
                "filename": body.filename,
                "media_type": "video" if is_video else "image",
                "sampled_frames": n_frames,
                "avg_luma": round(avg_luma, 1),
                "theme": "dark" if is_dark else "light",
                "detected_bg": stage_bg,
                "detected_accent": accent_hex,
                "motion_energy": motion_energy,
                "recommended_duration": round(min(6.0, max(2.5, duration_sec)), 2),
                "recommended_motion_intensity": motion_intensity,
                "recommended_skeleton": "step_flow_list" if is_dark else "stat_counter",
                "atlas_matches": atlas_hits,
            },
            "candidate_skin": candidate_skin,
        }
    finally:
        tmp_file.unlink(missing_ok=True)


class GenerateVariantBody(BaseModel):
    prompt: str
    base_skeleton_id: str = "step_flow_list"
    base_skin: dict
    base_content: dict
    base_duration: float = 4.2


@app.post("/api/m3/generate-variant")
def api_m3_generate_variant(body: GenerateVariantBody):
    """M3 AI 共创变体生成器：检索 504 项 Atlas 风格库 + 解析中文创作指令，产出隔离沙箱候选动效卡草案。"""
    txt = body.prompt.strip()
    if not txt:
        raise HTTPException(400, "请输入修改或创作指令")

    # 1. 骨架意图映射
    skel_id = body.base_skeleton_id
    if re.search(r"步骤|流程|清单|三步|目录", txt):
        skel_id = "step_flow_list"
    elif re.search(r"对比|PK|VS|双栏|取舍", txt, re.I):
        skel_id = "versus_split"
    elif re.search(r"排行|柱状|榜单|对比图", txt):
        skel_id = "bar_race_rank"
    elif re.search(r"金句|字幕|观点|语录", txt):
        skel_id = "callout_reveal"
    elif re.search(r"数字|数据|倍数|统计|指标", txt):
        skel_id = "stat_counter"

    # 2. 时长与节奏意图解析
    duration = body.base_duration
    m_sec = re.search(r"(\d+(?:\.\d+)?)\s*秒", txt)
    if m_sec:
        duration = round(min(8.0, max(2.0, float(m_sec.group(1)))), 2)
    motion_intensity = 1.25 if re.search(r"快节奏|动感|强烈|弹跳", txt) else 0.85 if re.search(r"克制|缓慢|柔和|极简", txt) else 1.0

    # 3. 视觉皮肤克隆与主题/色板微调
    new_skin = json.loads(json.dumps(body.base_skin))
    stamp = uuid.uuid4().hex[:6]
    new_skin["id"] = f"ai_skin_{stamp}"
    new_skin["name"] = f"AI 共创 · {txt[:8]}"
    tok = new_skin["tokens"]

    if re.search(r"暗黑|深色|黑底|瑞士", txt):
        tok.update({"stage_bg": "#0b0f19", "surface_bg": "#121826", "surface_alt": "#1e293b", "border_color": "#334155", "text_primary": "#ffffff", "text_secondary": "#cbd5e1", "text_muted": "#94a3b8"})
    elif re.search(r"麦田|浅色|暖白|极简", txt):
        tok.update({"stage_bg": "#f7f6f2", "surface_bg": "#ffffff", "surface_alt": "#f1efe9", "border_color": "#e2ded5", "text_primary": "#18181b", "text_secondary": "#52525b", "text_muted": "#71717a"})
    elif re.search(r"霓虹|玻璃|赛博|未来", txt):
        tok.update({"stage_bg": "#060914", "surface_bg": "rgba(15, 23, 42, 0.82)", "border_color": "rgba(34, 211, 238, 0.6)", "text_primary": "#ecfeff", "text_secondary": "#a5f3fc"})

    if re.search(r"蓝|青", txt):
        tok["accent_primary"] = "#3b82f6"
    elif re.search(r"橙|金|暖", txt):
        tok["accent_primary"] = "#ea580c"
    elif re.search(r"红|玫", txt):
        tok["accent_primary"] = "#f43f5e"
    elif re.search(r"绿|翡翠", txt):
        tok["accent_primary"] = "#10b981"
    elif re.search(r"紫", txt):
        tok["accent_primary"] = "#a855f7"

    # 4. 检索 504 项 Atlas 风格灵感
    kws = [w for w in ("暗黑", "极简", "霓虹", "玻璃", "印刷", "蓝", "电影", "科技", "渐变", "光晕") if w in txt]
    atlas_hits = _match_atlas(kws or ["极简", "排版"], 3)

    draft_card = {
        "id": f"custom_card_{stamp}",
        "name": f"AI 共创：{txt[:14]}",
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source_prompt": txt,
        "skeleton_id": skel_id,
        "duration": duration,
        "skin": new_skin,
        "content": body.base_content,
        "dna": {"motion_intensity": motion_intensity, "radius_scale": 1.0, "accent_override": None},
        "atlas_inspirations": atlas_hits,
        "gate_passed": False,
    }
    return {"ok": True, "draft_card": draft_card}


class SandboxGateBody(BaseModel):
    draft_card: dict
    render_proof: dict


FORBIDDEN_PATTERNS = [
    r"\beval\s*\(", r"\bFunction\s*\(", r"\bfetch\s*\(", r"\bXMLHttpRequest\b",
    r"\blocalStorage\b", r"document\.cookie", r"performance\.now", r"\bsetInterval\b",
    r"<script", r"javascript:",
]


@app.post("/api/m3/sandbox-gate")
def api_m3_sandbox_gate(body: SandboxGateBody):
    """M3 隔离沙箱 4 道安全与确定性门禁校验。"""
    card = body.draft_card
    proof = body.render_proof or {}
    gates = []

    # Gate 1: Schema 完整性与边界
    allowed_skels = {"stat_counter", "bar_race_rank", "callout_reveal", "versus_split", "step_flow_list"}
    skel_ok = card.get("skeleton_id") in allowed_skels
    dur = float(card.get("duration") or 0)
    tok = (card.get("skin") or {}).get("tokens") or {}
    tok_ok = all(k in tok for k in ("stage_bg", "surface_bg", "text_primary", "accent_primary"))
    g1 = skel_ok and (1.5 <= dur <= 12.0) and tok_ok
    gates.append({"id": "schema_integrity", "label": "Gate 1 · 6 层 Schema 与数值边界校验", "pass": g1, "detail": f"skeleton={card.get('skeleton_id')}, duration={dur}s"})

    # Gate 2: 静态安全扫描（禁外网/禁自播放时钟/禁脚本注入）
    raw_dump = json.dumps(card, ensure_ascii=False)
    hit_bad = [pat for pat in FORBIDDEN_PATTERNS if re.search(pat, raw_dump, re.I)]
    g2 = len(hit_bad) == 0
    gates.append({"id": "static_security", "label": "Gate 2 · 静态安全审计（禁外网/自时钟/注入）", "pass": g2, "detail": "零风险命中" if g2 else f"拦截风险：{hit_bad}"})

    # Gate 3: 渲染动态性与确定性哈希证明
    h035 = proof.get("hash_t035")
    h185 = proof.get("hash_t185")
    d1 = proof.get("hash_det1")
    d2 = proof.get("hash_det2")
    g3 = bool(h035 and h185 and h035 != h185 and d1 and d1 == d2)
    gates.append({"id": "determinism_dynamic", "label": "Gate 3 · 纯函数动态变化 & 同帧确定性哈希", "pass": g3, "detail": f"t0.35={h035} != t1.85={h185}, det={d1}"})

    # Gate 4: 透明 Alpha 像素证明
    has_alpha_px = bool(proof.get("has_transparent_pixels"))
    gates.append({"id": "transparent_alpha", "label": "Gate 4 · 透明底 RGBA Alpha 通道校验", "pass": has_alpha_px, "detail": "检测到有效透明 Alpha 像素" if has_alpha_px else "未检测到透明通道"})

    all_pass = all(g["pass"] for g in gates)
    return {"ok": True, "passed": all_pass, "gates": gates}


@app.get("/api/m3/registry")
def api_m3_list_registry():
    return {"ok": True, "cards": _load_registry(), "atlas_total": len(ATLAS_CACHE)}


class RegisterCardBody(BaseModel):
    draft_card: dict


@app.post("/api/m3/registry/register")
def api_m3_register_card(body: RegisterCardBody):
    card = body.draft_card
    if not card.get("gate_passed"):
        raise HTTPException(400, "必须先通过 4 道隔离沙箱门禁校验后才能入库")
    items = _load_registry()
    items = [c for c in items if c.get("id") != card.get("id")]
    items.insert(0, card)
    _save_registry(items)
    return {"ok": True, "total": len(items), "card": card}


@app.delete("/api/m3/registry/{card_id}")
def api_m3_delete_card(card_id: str):
    items = [c for c in _load_registry() if c.get("id") != card_id]
    _save_registry(items)
    return {"ok": True, "total": len(items)}


# === M4：个人 Style DNA 审美反馈学习 + Atlas 504 风格混搭变体生成 ===
DEFAULT_DNA_PROFILE = {
    "version": 1,
    "likes": 0,
    "dislikes": 0,
    "theme_score_dark": 0.0,   # >0 偏向暗黑编辑部，<0 偏向浅色极简
    "preferred_theme": "balanced",
    "motion_intensity": 1.0,
    "radius_scale": 1.0,
    "favorite_accents": ["#3b82f6", "#ea580c"],
    "liked_atlas_ids": [],
    "disliked_atlas_ids": [],
    "updated_at": None,
}


def _load_dna_profile() -> dict:
    if not DNA_PROFILE_FILE.is_file():
        return json.loads(json.dumps(DEFAULT_DNA_PROFILE))
    try:
        return json.loads(DNA_PROFILE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return json.loads(json.dumps(DEFAULT_DNA_PROFILE))


def _save_dna_profile(prof: dict) -> None:
    DNA_PROFILE_FILE.write_text(json.dumps(prof, ensure_ascii=False, indent=2), encoding="utf-8")


@app.get("/api/m4/atlas/search")
def api_m4_atlas_search(q: str = "", limit: int = 12):
    """检索已有 504 项 Atlas 视觉风格图鉴（只读复用，严禁修改原文件）。"""
    q_low = q.strip().lower()
    hits = []
    for item in ATLAS_CACHE:
        blob = " ".join([
            str(item.get("source_id") or ""),
            str(item.get("mode") or ""),
            str(item.get("official_zh") or ""),
            str(item.get("recipe") or ""),
        ]).lower()
        if not q_low or q_low in blob:
            hits.append({
                "source_id": item.get("source_id"),
                "mode": item.get("mode") or "风格参考",
                "recipe": (item.get("recipe") or item.get("official_zh") or "")[:90],
            })
        if len(hits) >= max(1, min(30, limit)):
            break
    return {"ok": True, "total_catalog": len(ATLAS_CACHE), "items": hits}


@app.get("/api/m4/dna")
def api_m4_get_dna():
    return {"ok": True, "profile": _load_dna_profile()}


class DnaFeedbackBody(BaseModel):
    action: str  # like | dislike | reset
    theme: str = "dark"  # dark | light
    accent: str | None = None
    motion_intensity: float = 1.0
    radius_scale: float = 1.0
    atlas_id: str | None = None


@app.post("/api/m4/dna/feedback")
def api_m4_dna_feedback(body: DnaFeedbackBody):
    """审美反馈学习：基于点赞/否决增量更新个人 Style DNA 权重并持久化。"""
    if body.action == "reset":
        fresh = json.loads(json.dumps(DEFAULT_DNA_PROFILE))
        fresh["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        _save_dna_profile(fresh)
        return {"ok": True, "profile": fresh}

    prof = _load_dna_profile()
    prof["version"] = int(prof.get("version", 1)) + 1
    is_like = body.action == "like"
    delta = 1.0 if is_like else -0.8

    if is_like:
        prof["likes"] = int(prof.get("likes", 0)) + 1
        # 滑动平均学习运动幅度与圆角偏好
        prof["motion_intensity"] = round(prof["motion_intensity"] * 0.65 + float(body.motion_intensity) * 0.35, 2)
        prof["radius_scale"] = round(prof["radius_scale"] * 0.65 + float(body.radius_scale) * 0.35, 2)
        if body.accent:
            favs = [c for c in prof.get("favorite_accents", []) if c != body.accent]
            favs.insert(0, body.accent)
            prof["favorite_accents"] = favs[:6]
        if body.atlas_id:
            liked = [a for a in prof.get("liked_atlas_ids", []) if a != body.atlas_id]
            liked.insert(0, body.atlas_id)
            prof["liked_atlas_ids"] = liked[:12]
    else:
        prof["dislikes"] = int(prof.get("dislikes", 0)) + 1
        if body.atlas_id:
            dis = [a for a in prof.get("disliked_atlas_ids", []) if a != body.atlas_id]
            dis.insert(0, body.atlas_id)
            prof["disliked_atlas_ids"] = dis[:12]

    # 更新明暗主题偏好分
    theme_dir = 1.0 if body.theme == "dark" else -1.0
    prof["theme_score_dark"] = round(float(prof.get("theme_score_dark", 0.0)) + theme_dir * delta, 2)
    if prof["theme_score_dark"] >= 0.6:
        prof["preferred_theme"] = "dark"
    elif prof["theme_score_dark"] <= -0.6:
        prof["preferred_theme"] = "light"
    else:
        prof["preferred_theme"] = "balanced"

    prof["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    _save_dna_profile(prof)
    return {"ok": True, "profile": prof}


class MixVariantsBody(BaseModel):
    skeleton_id: str = "step_flow_list"
    atlas_query: str = ""
    seed: int = 1


@app.post("/api/m4/mix-variants")
def api_m4_mix_variants(body: MixVariantsBody):
    """M4 风格混搭引擎：结合 Atlas 504 词条 + 个人 Style DNA 权重，一次生成 4 组可执行皮肤变体。"""
    prof = _load_dna_profile()
    pref_dark = prof.get("preferred_theme") == "dark"
    fav_accent = (prof.get("favorite_accents") or ["#3b82f6"])[0]
    base_amp = float(prof.get("motion_intensity", 1.0))
    base_rad = float(prof.get("radius_scale", 1.0))

    # 从 Atlas 504 中按关键词或偏移抽取 4 条灵感（避开已否决项）
    disliked = set(prof.get("disliked_atlas_ids") or [])
    pool = [x for x in ATLAS_CACHE if x.get("source_id") not in disliked]
    if body.atlas_query.strip():
        q = body.atlas_query.strip().lower()
        filtered = [x for x in pool if q in str(x.get("source_id", "")).lower() or q in str(x.get("official_zh", "")).lower() or q in str(x.get("recipe", "")).lower()]
        if filtered:
            pool = filtered
    offset = ((body.seed - 1) * 4) % max(1, len(pool))
    picks = [pool[(offset + i) % len(pool)] for i in range(4)] if pool else [{"source_id": f"atlas_{i}", "mode": "风格"} for i in range(4)]

    # 4 组差异化且受 DNA 引导的混搭原型
    archetypes = [
        {
            "tag": "DNA 优先推荐",
            "theme": "dark" if pref_dark else "light",
            "stage_bg": "#0b0f19" if pref_dark else "#f7f6f2",
            "surface_bg": "#121826" if pref_dark else "#ffffff",
            "surface_alt": "#1e293b" if pref_dark else "#f1efe9",
            "border_color": "#334155" if pref_dark else "#e2ded5",
            "text_primary": "#ffffff" if pref_dark else "#18181b",
            "text_secondary": "#cbd5e1" if pref_dark else "#52525b",
            "text_muted": "#94a3b8" if pref_dark else "#71717a",
            "accent_primary": fav_accent,
            "accent_secondary": "#0ea5e9",
            "radius": 14,
            "motion_intensity": base_amp,
            "radius_scale": base_rad,
        },
        {
            "tag": "深邃编辑部 · 数据蓝",
            "theme": "dark",
            "stage_bg": "#0f1117",
            "surface_bg": "#161b26",
            "surface_alt": "#1f2937",
            "border_color": "#2e3748",
            "text_primary": "#ffffff",
            "text_secondary": "#cbd5e1",
            "text_muted": "#8b98a9",
            "accent_primary": "#3b82f6",
            "accent_secondary": "#38bdf8",
            "radius": 12,
            "motion_intensity": round(min(1.4, base_amp * 1.05), 2),
            "radius_scale": round(max(0.5, base_rad * 0.9), 2),
        },
        {
            "tag": "麦田暖白 · 琥珀印制",
            "theme": "light",
            "stage_bg": "#f6f4ee",
            "surface_bg": "#ffffff",
            "surface_alt": "#edeae2",
            "border_color": "#dcd6c8",
            "text_primary": "#18181b",
            "text_secondary": "#44403c",
            "text_muted": "#78716c",
            "accent_primary": "#ea580c",
            "accent_secondary": "#0f766e",
            "radius": 16,
            "motion_intensity": round(max(0.7, base_amp * 0.92), 2),
            "radius_scale": round(min(1.8, base_rad * 1.1), 2),
        },
        {
            "tag": "赛博翡翠 · 霓虹高光",
            "theme": "dark",
            "stage_bg": "#060b14",
            "surface_bg": "rgba(13, 25, 42, 0.86)",
            "surface_alt": "rgba(22, 42, 68, 0.72)",
            "border_color": "rgba(16, 185, 129, 0.55)",
            "text_primary": "#ecfdf5",
            "text_secondary": "#a7f3d0",
            "text_muted": "#6ee7b7",
            "accent_primary": "#10b981",
            "accent_secondary": "#22d3ee",
            "radius": 18,
            "motion_intensity": round(min(1.5, base_amp * 1.15), 2),
            "radius_scale": round(min(1.8, base_rad * 1.2), 2),
        },
    ]

    variants = []
    for idx, (arc, atlas_item) in enumerate(zip(archetypes, picks), 1):
        vid = f"mix_v{body.seed}_{idx}_{uuid.uuid4().hex[:5]}"
        variants.append({
            "variant_id": vid,
            "label": f"变体 #{idx} · {arc['tag']}",
            "theme": arc["theme"],
            "atlas_ref": atlas_item.get("source_id"),
            "atlas_recipe": (atlas_item.get("recipe") or atlas_item.get("official_zh") or "")[:65],
            "dna": {
                "motion_intensity": arc["motion_intensity"],
                "radius_scale": arc["radius_scale"],
                "accent_override": None,
            },
            "skin": {
                "id": vid,
                "name": f"混搭 · {arc['tag']}",
                "mode": "production",
                "atlas_refs": [atlas_item.get("source_id")],
                "tokens": {
                    "stage_bg": arc["stage_bg"],
                    "surface_bg": arc["surface_bg"],
                    "surface_alt": arc["surface_alt"],
                    "border_color": arc["border_color"],
                    "border_style": "solid",
                    "border_width": 1.2,
                    "radius": arc["radius"],
                    "text_primary": arc["text_primary"],
                    "text_secondary": arc["text_secondary"],
                    "text_muted": arc["text_muted"],
                    "accent_primary": arc["accent_primary"],
                    "accent_secondary": arc["accent_secondary"],
                    "shadow": "0 20px 44px rgba(0,0,0,0.42)" if arc["theme"] == "dark" else "0 14px 34px rgba(24,24,27,0.08)",
                    "font_display": "'Microsoft YaHei UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
                    "font_body": "'Microsoft YaHei UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
                    "show_motion_guides": False,
                },
            },
        })

    return {"ok": True, "seed": body.seed, "dna_version": prof.get("version", 1), "variants": variants}


@app.get("/api/m4/assets/browse")
def api_m4_assets_browse(source: str = "atlas", q: str = "", category: str = "", page: int = 1, page_size: int = 24):
    """全量浏览 504 项 Atlas 视觉图鉴与 264 项 Motion Prompt 镜头库（支持分类/关键词/分页）。"""
    dataset = ATLAS_FULL_504 if source == "atlas" else MOTION_FULL_264
    cats = sorted({str(x.get("category") or "") for x in dataset if x.get("category")})
    q_low = q.strip().lower()
    filtered = []
    for item in dataset:
        if category and item.get("category") != category:
            continue
        if q_low:
            blob = f"{item.get('id','')} {item.get('title_zh','')} {item.get('title_en','')} {item.get('category','')} {item.get('summary','')}".lower()
            if q_low not in blob:
                continue
        filtered.append(item)
    ps = max(6, min(60, page_size))
    total = len(filtered)
    total_pages = max(1, (total + ps - 1) // ps)
    p = max(1, min(total_pages, page))
    return {
        "ok": True,
        "source": source,
        "atlas_total": len(ATLAS_FULL_504),
        "motion_total": len(MOTION_FULL_264),
        "total_matched": total,
        "page": p,
        "page_size": ps,
        "total_pages": total_pages,
        "categories": cats,
        "items": filtered[(p - 1) * ps : p * ps],
    }


class ApplyAssetBody(BaseModel):
    source: str  # atlas | motion
    item_id: str
    current_skeleton_id: str = "step_flow_list"


@app.post("/api/m4/assets/apply")
def api_m4_assets_apply(body: ApplyAssetBody):
    """将任意一项 Atlas(504) 或 Motion Prompt(264) 词条实时编译为可执行皮肤与运动 DNA 参数。"""
    dataset = ATLAS_FULL_504 if body.source == "atlas" else MOTION_FULL_264
    item = next((x for x in dataset if x.get("id") == body.item_id), None)
    if not item:
        raise HTTPException(404, f"未找到资产词条：{body.item_id}")

    blob = f"{item.get('title_zh','')} {item.get('title_en','')} {item.get('summary','')} {item.get('prompt','')}".lower()

    # 1. 根据词条语义推导视觉皮肤色板
    is_dark = any(k in blob for k in ("暗", "黑", "霓虹", "赛博", "夜", "neon", "cyber", "dark", "glow", "glitch", "film", "cinema", "laser", "holo"))
    accent = "#3b82f6"
    if any(k in blob for k in ("霓虹", "青", "激光", "neon", "cyan", "holo", "glitch")):
        accent = "#22d3ee"
    elif any(k in blob for k in ("红", "粉", "洋红", "red", "crimson", "magenta", "ruby", "pop")):
        accent = "#f43f5e"
    elif any(k in blob for k in ("绿", "翡翠", "矩阵", "green", "emerald", "matrix")):
        accent = "#10b981"
    elif any(k in blob for k in ("紫", "梦幻", "purple", "violet", "vapor")):
        accent = "#a855f7"
    elif any(k in blob for k in ("金", "暖", "橙", "复古", "胶片", "gold", "amber", "warm", "vintage", "retro", "sepia")):
        accent = "#ea580c"

    radius = 4 if any(k in blob for k in ("像素", "1-bit", "抖动", "pixel", "dither", "grid", "swiss", "brutal")) else 18 if any(k in blob for k in ("玻璃", "气泡", "圆", "glass", "bubble", "soft")) else 14
    motion_amp = 1.3 if any(k in blob for k in ("弹", "震", "冲", "快", "pop", "bounce", "shake", "zoom", "whip", "burst")) else 0.85 if any(k in blob for k in ("缓", "淡", "浮", "慢", "fade", "float", "drift", "slow")) else 1.05
    duration = round(min(7.0, max(2.2, float(item.get("cycle") or 4.0))), 2) if body.source == "motion" else 4.0

    # 2. 若是 Motion Prompt，顺便推荐最契合的骨架
    rec_skel = body.current_skeleton_id
    if body.source == "motion":
        if any(k in blob for k in ("字", "文本", "打字", "text", "type", "kinetic", "title")):
            rec_skel = "callout_reveal"
        elif any(k in blob for k in ("对比", "分屏", "split", "versus", "wipe")):
            rec_skel = "versus_split"
        elif any(k in blob for k in ("柱", "图", "进度", "bar", "chart", "meter", "graph")):
            rec_skel = "bar_race_rank"
        elif any(k in blob for k in ("数", "计", "count", "number", "odometer")):
            rec_skel = "stat_counter"
        elif any(k in blob for k in ("步", "列表", "阶梯", "list", "step", "stagger", "cascade")):
            rec_skel = "step_flow_list"

    skin_id = f"{body.source}_{uuid.uuid4().hex[:6]}"
    compiled_skin = {
        "id": skin_id,
        "name": f"{'Atlas' if body.source == 'atlas' else 'Motion'} · {item['title_zh'][:10]}",
        "mode": "production",
        "atlas_refs": [item["id"]],
        "tokens": {
            "stage_bg": "#090d16" if is_dark else "#f7f6f2",
            "surface_bg": "#121826" if is_dark else "#ffffff",
            "surface_alt": "#1e293b" if is_dark else "#f1efe9",
            "border_color": f"{accent}88" if is_dark else "#e2ded5",
            "border_style": "solid",
            "border_width": 1.4 if is_dark else 1.0,
            "radius": radius,
            "text_primary": "#ffffff" if is_dark else "#18181b",
            "text_secondary": "#cbd5e1" if is_dark else "#52525b",
            "text_muted": "#94a3b8" if is_dark else "#71717a",
            "accent_primary": accent,
            "accent_secondary": "#38bdf8" if is_dark else "#0f766e",
            "shadow": "0 20px 44px rgba(0,0,0,0.45)" if is_dark else "0 14px 34px rgba(24,24,27,0.08)",
            "font_display": "'Microsoft YaHei UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            "font_body": "'Microsoft YaHei UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            "show_motion_guides": False,
        },
    }
    return {
        "ok": True,
        "source": body.source,
        "item": item,
        "draft_card": {
            "id": f"asset_card_{uuid.uuid4().hex[:6]}",
            "name": f"{'Atlas' if body.source == 'atlas' else 'Motion'}：{item['title_zh'][:14]}",
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source_prompt": f"{body.source}:{item['id']}",
            "skeleton_id": rec_skel,
            "duration": duration,
            "skin": compiled_skin,
            "dna": {"motion_intensity": motion_amp, "radius_scale": 1.0, "accent_override": None},
            "atlas_inspirations": [{"source_id": item["id"], "recipe": item.get("summary", "")}],
            "gate_passed": False,
        },
    }


@app.get("/api/m5/groups")
def api_m5_groups():
    """M5 正式 28 组动效分类注册中心：汇总骨架、皮肤与已入库原创卡的组合扩容进度。"""
    tax_file = ROOT / "schemas" / "M5_28_GROUPS_TAXONOMY.json"
    tax = json.loads(tax_file.read_text(encoding="utf-8")) if tax_file.is_file() else {"groups": [], "target_cards": 501}
    custom_cards = _load_registry()
    skel_schema = json.loads((ROOT / "schemas" / "M2_SKELETON_SCHEMA.json").read_text(encoding="utf-8"))
    skin_schema = json.loads((ROOT / "schemas" / "M2_SKIN_SCHEMA.json").read_text(encoding="utf-8"))
    base_combos = len(skel_schema.get("skeletons", [])) * len(skin_schema.get("skins", []))
    return {
        "ok": True,
        "total_groups": len(tax.get("groups", [])),
        "target_cards": tax.get("target_cards", 501),
        "active_skeletons": len(skel_schema.get("skeletons", [])),
        "active_skins": len(skin_schema.get("skins", [])),
        "base_matrix_combos": base_combos,
        "registered_custom_cards": len(custom_cards),
        "atlas_total": len(ATLAS_FULL_504),
        "motion_total": len(MOTION_FULL_264),
        "groups": tax.get("groups", []),
    }


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/engine.js")
def engine_js():
    return FileResponse(ROOT / "engine.js", media_type="application/javascript")


app.mount("/schemas", StaticFiles(directory=str(ROOT / "schemas")), name="schemas")
app.mount("/reports", StaticFiles(directory=str(ROOT / "reports")), name="reports")
