"""G2 多平台发布中心核心引擎（B01–B11）。

安全与合规硬约束：
1. 严格 7 平台白名单：bilibili / douyin / xiaohongshu / wechat_channels / youtube / x / instagram（拒绝 B12 暂定平台）。
2. 全平台零自动提交：只负责文案准备、规则校验、标准化 publish.json 导出、以及在独立 Chrome Profile 中打开官方上传页等待人工填写/核对；绝不自动点击任何平台的最终发布按钮。
3. Windows 原生兼容：零 lsof 调用，按独立 --user-data-dir 隔离账号，绝不读取用户日常浏览器登录态，绝不存密码或明文 Cookie。
4. 医疗内容人工复核：命中医疗健康敏感语境仅提示人工核对官方政策，绝不做自动替换词规避审核。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from backend.config import DATA_DIR, get_env_config

PUBLISH_STORAGE_DIR = DATA_DIR / "publish_hub"
PUBLISH_COVERS_DIR = PUBLISH_STORAGE_DIR / "covers"
PUBLISH_BUNDLES_DIR = PUBLISH_STORAGE_DIR / "bundles"
PUBLISH_PROFILES_DIR = PUBLISH_STORAGE_DIR / "chrome_profiles"

for _d in (PUBLISH_STORAGE_DIR, PUBLISH_COVERS_DIR, PUBLISH_BUNDLES_DIR, PUBLISH_PROFILES_DIR):
    _d.mkdir(parents=True, exist_ok=True)

RULES_VERSION = "gcw-rules-2026.11"

# 严格 7 平台白名单与规则（B03/B06/B12）
PLATFORM_SPECS: dict[str, dict[str, Any]] = {
    "bilibili": {
        "id": "bilibili",
        "name": "B站",
        "upload_url": "https://member.bilibili.com/platform/upload/video/frame",
        "max_title": 80,
        "max_body": 2000,
        "max_tags": 10,
        "cover_ratio": "16:9",
        "forbid_external_link": False,
        "forbid_wechat_id": False,
        "notes": "支持 16:9 与 4:3 封面；分区与自制声明须在官方页人工核对。",
    },
    "douyin": {
        "id": "douyin",
        "name": "抖音",
        "upload_url": "https://creator.douyin.com/creator-micro/content/upload",
        "max_title": 30,
        "max_body": 1000,
        "max_tags": 5,
        "cover_ratio": "3:4",
        "forbid_external_link": True,
        "forbid_wechat_id": True,
        "notes": "禁止在正文放外链或微信号；合集与声明须人工确认。",
    },
    "xiaohongshu": {
        "id": "xiaohongshu",
        "name": "小红书",
        "upload_url": "https://creator.xiaohongshu.com/publish/publish",
        "max_title": 20,
        "max_body": 1000,
        "max_tags": 10,
        "cover_ratio": "3:4",
        "forbid_external_link": True,
        "forbid_wechat_id": True,
        "notes": "标题上限 20 字，推荐 3:4 竖版封面；严禁引流外链与微信号。",
    },
    "wechat_channels": {
        "id": "wechat_channels",
        "name": "视频号",
        "upload_url": "https://channels.weixin.qq.com/platform/post/create",
        "max_title": 16,
        "max_body": 1000,
        "max_tags": 6,
        "cover_ratio": "3:4",
        "forbid_external_link": True,
        "forbid_wechat_id": True,
        "notes": "短标题 6-16 字，须等视频上传完成后补封面，禁止外部导流链接。",
    },
    "youtube": {
        "id": "youtube",
        "name": "YouTube",
        "upload_url": "https://studio.youtube.com/",
        "max_title": 100,
        "max_body": 5000,
        "max_tags": 15,
        "cover_ratio": "16:9",
        "forbid_external_link": False,
        "forbid_wechat_id": False,
        "notes": "16:9 封面；是否面向儿童、付费推广声明须在 Studio 人工确认。",
    },
    "x": {
        "id": "x",
        "name": "X",
        "upload_url": "https://x.com/compose/post",
        "max_title": 100,
        "max_body": 280,
        "max_tags": 3,
        "cover_ratio": "16:9",
        "forbid_external_link": False,
        "forbid_wechat_id": False,
        "notes": "普通账号单帖 280 字符限制；仅准备草稿，严禁自动发帖。",
    },
    "instagram": {
        "id": "instagram",
        "name": "Instagram",
        "upload_url": "https://www.instagram.com/",
        "max_title": 60,
        "max_body": 2200,
        "max_tags": 10,
        "cover_ratio": "3:4",
        "forbid_external_link": False,
        "forbid_wechat_id": False,
        "notes": "推荐 3:4 / 9:16 竖屏封面；仅打开官方上传流由本人确认发布。",
    },
}

ALLOWED_PLATFORMS = set(PLATFORM_SPECS.keys())

VALID_TASK_STATES = {
    "draft",
    "validated",
    "fill_authorized",
    "filling",
    "awaiting_user",
    "scheduled_confirmed",
    "published_confirmed",
    "failed",
    "needs_reconcile",
    "not_logged_in",
    "cancelled",
    "skipped",
}

URL_PATTERN = re.compile(r"https?://\S+|www\.\S+", re.I)
WECHAT_PATTERN = re.compile(r"(微信|vx|v信|wx|加我|私信领|公众号|微信号)\s*[:：]?\s*[a-zA-Z0-9_-]{3,}", re.I)
MEDICAL_PATTERN = re.compile(r"医院|医生|手术|癌症|治疗|药效|挂号|医疗|诊断|诊所|疗效|hospital|surgery|treatment|medical|clinic", re.I)
SECRET_REDACT_PATTERNS = [
    (re.compile(r"(cookie|token|authorization|password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s,;\"']+", re.I), r"\1=***REDACTED***"),
    (re.compile(r"Bearer\s+[A-Za-z0-9\-._~+/]+=*", re.I), "Bearer ***REDACTED***"),
    (re.compile(r"sk-[A-Za-z0-9]{12,}"), "sk-***REDACTED***"),
]


def redact_log_text(text: str) -> str:
    """B10：日志敏感值强制脱敏，绝不将 Cookie/Token/密钥写入日志或数据库。"""
    out = str(text or "")
    for pat, repl in SECRET_REDACT_PATTERNS:
        out = pat.sub(repl, out)
    return out


def validate_platform_id(platform: str) -> str:
    p = (platform or "").strip().lower()
    if p not in ALLOWED_PLATFORMS:
        raise ValueError(f"平台 '{platform}' 不在本期 7 平台白名单内（允许：{', '.join(sorted(ALLOWED_PLATFORMS))}）")
    return p


def detect_chrome_executable() -> Optional[str]:
    """Windows 原生定位 Chrome/Edge，绝不使用 Unix lsof。"""
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(os.getenv("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return None


def get_account_profile_dir(platform: str, external_uid: str) -> Path:
    """为每个平台+账号生成隔离的本地 Chrome Profile 目录（B11）。"""
    safe_uid = re.sub(r"[^a-zA-Z0-9_\-]+", "_", external_uid).strip("_") or "default"
    pdir = (PUBLISH_PROFILES_DIR / f"{platform}_{safe_uid}").resolve()
    if not str(pdir).startswith(str(PUBLISH_PROFILES_DIR.resolve())):
        raise ValueError("非法的 Profile 目录路径")
    pdir.mkdir(parents=True, exist_ok=True)
    return pdir


def probe_image_dimensions(img_path: Path) -> dict[str, Any]:
    """用 ffprobe 读取封面真实分辨率与比例（B02）。"""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", str(img_path)],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0:
            streams = json.loads(proc.stdout or "{}").get("streams", [])
            if streams:
                w = int(streams[0].get("width") or 0)
                h = int(streams[0].get("height") or 0)
                if w > 0 and h > 0:
                    ratio = round(w / h, 3)
                    matched = "16:9" if abs(ratio - 16 / 9) < 0.12 else ("4:3" if abs(ratio - 4 / 3) < 0.12 else ("3:4" if abs(ratio - 3 / 4) < 0.12 else "other"))
                    return {"ok": True, "width": w, "height": h, "ratio": ratio, "matched_slot": matched}
    except Exception:
        pass
    return {"ok": False, "width": None, "height": None, "ratio": None, "matched_slot": "unknown"}


def generate_platform_drafts(title: str, source_text: str = "", platforms: Optional[list[str]] = None, use_llm: bool = True) -> dict[str, Any]:
    """B01：为白名单平台生成独立文案草稿（DeepSeek LLM + 确定性规则兜底，绝不伪造链接）。"""
    target_plats = [validate_platform_id(p) for p in (platforms or list(PLATFORM_SPECS.keys()))]
    cfg = get_env_config()
    drafts: dict[str, dict[str, Any]] = {}
    meta = {"used_llm": False, "model": None, "total_tokens": 0, "rules_version": RULES_VERSION}

    if use_llm and cfg.get("llm_configured"):
        try:
            from openai import OpenAI

            client = OpenAI(api_key=os.getenv("LLM_API_KEY"), base_url=cfg["llm_base_url"])
            spec_lines = "\n".join(
                f"- {p} ({PLATFORM_SPECS[p]['name']}): 标题<={PLATFORM_SPECS[p]['max_title']}字, 正文<={PLATFORM_SPECS[p]['max_body']}字, 标签<={PLATFORM_SPECS[p]['max_tags']}个, 禁外链={PLATFORM_SPECS[p]['forbid_external_link']}"
                for p in target_plats
            )
            prompt = f"""你是多平台内容运营编辑。请为以下视频主题生成各平台独立发布草稿。
严格要求：
1. 必须遵守各平台字数与禁外链规则：
{spec_lines}
2. 严禁编造任何网址、二维码、微信号或夸大医疗疗效；不得替医疗内容做规避审核的谐音替换。
3. 只输出 JSON 对象，键名为平台 ID（{', '.join(target_plats)}），每个平台值为：{{"title": "...", "body": "...", "tags": ["标签1", "标签2"], "cover_slot": "16:9或3:4或4:3"}}。

主题：{title}
参考脚本/要点：{(source_text or '')[:1500]}"""
            resp = client.chat.completions.create(
                model=cfg["llm_model"],
                messages=[{"role": "user", "content": prompt}],
                temperature=0.35,
                response_format={"type": "json_object"},
                timeout=45,
            )
            parsed = json.loads(resp.choices[0].message.content or "{}")
            meta["used_llm"] = True
            meta["model"] = cfg["llm_model"]
            meta["total_tokens"] = getattr(resp.usage, "total_tokens", 0) or 0
            for p in target_plats:
                item = parsed.get(p) or {}
                spec = PLATFORM_SPECS[p]
                drafts[p] = {
                    "title": str(item.get("title") or title)[: spec["max_title"]],
                    "body": str(item.get("body") or source_text[:200] or title)[: spec["max_body"]],
                    "tags": [str(t).lstrip("#").strip() for t in (item.get("tags") or []) if str(t).strip()][: spec["max_tags"]],
                    "cover_slot": item.get("cover_slot") if item.get("cover_slot") in ("16:9", "4:3", "3:4") else spec["cover_ratio"],
                    "scheduled_at": "",
                }
        except Exception as e:
            meta["fallback_reason"] = str(e)

    # 确定性兜底（确保任意平台都有合规草稿结构）
    for p in target_plats:
        if p in drafts:
            continue
        spec = PLATFORM_SPECS[p]
        base_body = (source_text or title).strip()
        if spec["forbid_external_link"]:
            base_body = URL_PATTERN.sub("", base_body).strip()
        drafts[p] = {
            "title": title[: spec["max_title"]],
            "body": base_body[: min(240, spec["max_body"])],
            "tags": ["内容创作", "实战拆解"][: spec["max_tags"]],
            "cover_slot": spec["cover_ratio"],
            "scheduled_at": "",
        }
    return {"drafts": drafts, "meta": meta}


def validate_publish_package(pkg: dict[str, Any], selected_platforms: Optional[list[str]] = None) -> dict[str, Any]:
    """B03：逐平台执行硬规则校验 + 医疗人工复核提醒（绝不自动改词绕审）。"""
    drafts = json.loads(pkg.get("drafts_json") or "{}") if isinstance(pkg.get("drafts_json"), str) else (pkg.get("drafts_json") or {})
    covers = json.loads(pkg.get("covers_json") or "{}") if isinstance(pkg.get("covers_json"), str) else (pkg.get("covers_json") or {})
    video_path = (pkg.get("video_file_path") or "").strip()

    target_plats = selected_platforms or list(drafts.keys()) or list(PLATFORM_SPECS.keys())
    global_errors: list[str] = []
    per_platform: dict[str, dict[str, Any]] = {}

    if not video_path:
        global_errors.append("缺少成片文件路径（video_file_path）")
    else:
        vp = Path(video_path)
        if not vp.exists():
            global_errors.append(f"成片文件不存在：{video_path}")
        elif vp.suffix.lower() not in {".mp4", ".mov", ".webm", ".mkv"}:
            global_errors.append(f"成片格式不受支持：{vp.suffix}")

    all_passed = len(global_errors) == 0

    for p in target_plats:
        if p not in ALLOWED_PLATFORMS:
            per_platform[p] = {"passed": False, "errors": [f"非法或暂定平台：{p}（本期已禁用）"], "warnings": []}
            all_passed = False
            continue
        spec = PLATFORM_SPECS[p]
        d = drafts.get(p) or {}
        title = str(d.get("title") or "").strip()
        body = str(d.get("body") or "").strip()
        tags = d.get("tags") or []
        cover_slot = d.get("cover_slot") or spec["cover_ratio"]

        errs: list[str] = []
        warns: list[str] = []

        if not title and p != "x":
            errs.append(f"{spec['name']} 标题不能为空")
        if len(title) > spec["max_title"]:
            errs.append(f"{spec['name']} 标题长度 {len(title)} 超过上限 {spec['max_title']}")
        if len(body) > spec["max_body"]:
            errs.append(f"{spec['name']} 正文长度 {len(body)} 超过上限 {spec['max_body']}")
        if len(tags) > spec["max_tags"]:
            errs.append(f"{spec['name']} 标签数量 {len(tags)} 超过上限 {spec['max_tags']}")

        combined = f"{title}\n{body}"
        if spec["forbid_external_link"] and URL_PATTERN.search(combined):
            errs.append(f"{spec['name']} 禁止在标题或正文包含外部链接")
        if spec["forbid_wechat_id"] and WECHAT_PATTERN.search(combined):
            errs.append(f"{spec['name']} 禁止包含微信号/私信导流联系方式")

        if MEDICAL_PATTERN.search(combined):
            warns.append(f"检测到医疗/健康相关词汇：请人工核对 {spec['name']} 官方医疗内容规范（系统不做自动替换词规避审核）")

        if cover_slot not in covers:
            warns.append(f"尚未上传 {cover_slot} 尺寸封面（{spec['name']} 推荐 {spec['cover_ratio']}）")
        else:
            c_info = covers[cover_slot]
            if c_info.get("matched_slot") not in (cover_slot, "unknown", None):
                warns.append(f"已上传封面的实测比例为 {c_info.get('matched_slot')}，与所选槽位 {cover_slot} 不完全匹配")

        p_ok = len(errs) == 0 and len(global_errors) == 0
        if not p_ok:
            all_passed = False
        per_platform[p] = {"passed": p_ok, "errors": errs, "warnings": warns, "rules_version": RULES_VERSION}

    return {
        "passed": all_passed,
        "rules_version": RULES_VERSION,
        "global_errors": global_errors,
        "platforms": per_platform,
    }


def compute_package_hash(pkg: dict[str, Any]) -> str:
    payload = {
        "title": pkg.get("title"),
        "video_file_path": pkg.get("video_file_path"),
        "covers_json": pkg.get("covers_json"),
        "drafts_json": pkg.get("drafts_json"),
        "schedule_timezone": pkg.get("schedule_timezone"),
    }
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def build_publish_protocol_bundle(pkg: dict[str, Any], accounts_by_platform: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """B04：构建统一发布工程协议 publish.json（安全相对路径、显式时区、零自动提交标记）。"""
    drafts = json.loads(pkg.get("drafts_json") or "{}") if isinstance(pkg.get("drafts_json"), str) else (pkg.get("drafts_json") or {})
    covers = json.loads(pkg.get("covers_json") or "{}") if isinstance(pkg.get("covers_json"), str) else (pkg.get("covers_json") or {})
    vp = Path(pkg["video_file_path"]).name if pkg.get("video_file_path") else ""
    safe_covers = {slot: Path(info.get("path", "")).name for slot, info in covers.items() if isinstance(info, dict) and info.get("path")}

    platforms_out = {}
    for p, d in drafts.items():
        if p not in ALLOWED_PLATFORMS:
            continue
        acc = accounts_by_platform.get(p)
        platforms_out[p] = {
            "platform_name": PLATFORM_SPECS[p]["name"],
            "upload_url": PLATFORM_SPECS[p]["upload_url"],
            "account_uid": acc["external_uid"] if acc else None,
            "account_name": acc["display_name"] if acc else None,
            "title": d.get("title", ""),
            "body": d.get("body", ""),
            "tags": d.get("tags", []),
            "cover_slot": d.get("cover_slot", PLATFORM_SPECS[p]["cover_ratio"]),
            "cover_file": safe_covers.get(d.get("cover_slot", PLATFORM_SPECS[p]["cover_ratio"])),
            "scheduled_at": d.get("scheduled_at") or None,
            "auto_submit": False,  # 强制硬编码 False：只填写不自动发布
        }

    return {
        "schema": "gcw-publish-bundle-v1",
        "rules_version": pkg.get("rules_version") or RULES_VERSION,
        "package_id": pkg["id"],
        "project_id": pkg.get("project_id"),
        "topic_id": pkg.get("topic_id"),
        "video_project_id": pkg.get("video_project_id"),
        "content_hash": pkg.get("content_hash") or compute_package_hash(pkg),
        "schedule_timezone": pkg.get("schedule_timezone") or "Asia/Shanghai",
        "approval_scope": "fill_only",
        "auto_submit_disabled": True,
        "video_file_name": vp,
        "covers": safe_covers,
        "platforms": platforms_out,
    }


def make_idempotency_key(package_id: int, account_id: Optional[int], platform: str, content_hash: str) -> str:
    raw = f"pkg:{package_id}|acc:{account_id or 0}|plat:{platform}|hash:{content_hash}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def open_isolated_platform_page(platform: str, profile_dir: Path) -> dict[str, Any]:
    """B06/B11：在独立 Chrome Profile 中打开指定平台官方上传页（仅打开填写环境，绝不自动提交）。"""
    validate_platform_id(platform)
    chrome_bin = detect_chrome_executable()
    url = PLATFORM_SPECS[platform]["upload_url"]
    if not chrome_bin:
        return {"launched": False, "url": url, "reason": "未在本机检测到 Chrome 或 Edge 浏览器"}
    args = [
        chrome_bin,
        f"--user-data-dir={str(profile_dir)}",
        "--no-first-run",
        "--no-default-browser-check",
        url,
    ]
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"launched": True, "url": url, "profile_dir": str(profile_dir), "browser": Path(chrome_bin).name}
