"""KOUBO-SKILL-P2 · 正式 AI 智能剪辑统一业务服务层（REST API 与正式 Workbench MCP Server 共用）。

核心原则：
1. 全部任务、不可变成片版本、工程互斥锁均持久化至正式 SQLite（data/workbench.db），杜绝独立实验 JSON 双源分裂；
2. 所有关键事件自动写入 integration_audit_events；
3. 发布交接仅接受已登记在 ai_video_jobs / ai_video_job_versions 且经 FFprobe 校验的受信任 MP4 路径；
4. 严格执行领取锁、ChatCut 工程互斥锁、幂等去重、超时回收与费用门禁。
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from backend.config import DATA_DIR, ROOT_DIR
VIDEO_UPLOADS_DIR = DATA_DIR / "video_uploads"
VIDEO_EXPORTS_DIR = DATA_DIR / "video_exports"
from backend.db import get_conn
from backend.services.commercial_contracts import Entitlement, SkillLicense

LOCK_TTL_SECONDS = 1800
EXTERNAL_SKILLS_ROOT = Path(r"C:\Users\wodhc\.gemini\antigravity\scratch\koubo-skill-p0-audit\koubo-templates")
WORKBENCH_SKILLS_ROOT = ROOT_DIR / ".agents" / "plugins" / "koubo-workbench-bridge" / "skills"
AI_VIDEO_EXPORTS_DIR = DATA_DIR / "ai_video_exports"
AI_VIDEO_EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

VALID_STATUSES = [
    "Pending",
    "WaitingForAgent",
    "Preparing",
    "Analyzing",
    "Editing",
    "Rendering",
    "Checking",
    "Completed",
    "Failed",
    "Cancelled",
    "Blocked",
]
TERMINAL_STATUSES = {"Completed", "Failed", "Cancelled"}
ACTIVE_LOCK_STATUSES = {"Preparing", "Analyzing", "Editing", "Rendering", "Checking"}


def _now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _sha256_file_head(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        h.update(f.read(1024 * 1024))
    return h.hexdigest()[:16]


def _audit(conn, event_type: str, entity_type: str, entity_id: str, status: str, summary: str, payload: dict | None = None) -> None:
    conn.execute(
        """INSERT INTO integration_audit_events(module, event_type, entity_type, entity_id, status, summary, payload_json)
           VALUES ('ai_video_studio', ?, ?, ?, ?, ?, ?)""",
        (event_type, entity_type, str(entity_id), status, summary[:400], json.dumps(payload or {}, ensure_ascii=False)),
    )


def _detect_version(skill_dir: Path, fallback: str) -> str:
    md = skill_dir / "SKILL.md"
    if md.is_file():
        m = re.search(r"version\s*:\s*['\"]?([0-9]+\.[0-9]+\.[0-9a-zA-Z.-]+)['\"]?", md.read_text(encoding="utf-8", errors="replace")[:1500], re.I)
        if m:
            return m.group(1)
    return fallback


# ==================== 1. 统一 Video Skill 注册中心（§12） ====================
def list_video_skills() -> list[dict[str, Any]]:
    wb_dir = EXTERNAL_SKILLS_ROOT / "whiteboard-koubo"
    pm_dir = EXTERNAL_SKILLS_ROOT / "premium-talk-edit"
    vd_dir = WORKBENCH_SKILLS_ROOT / "visual-director"
    ra_dir = WORKBENCH_SKILLS_ROOT / "real-asset-director"
    cm_dir = WORKBENCH_SKILLS_ROOT / "custom-motion-authoring"
    qc_dir = WORKBENCH_SKILLS_ROOT / "video-quality-check"

    return [
        {
            "skill_id": "premium-talk-edit",
            "name": "高级感干货口播剪辑",
            "version": _detect_version(pm_dir, "0.2.0"),
            "source": {"repo": "https://github.com/yyue5578-coder/koubo-templates", "path": str(pm_dir), "exists": (pm_dir / "SKILL.md").is_file()},
            "license": SkillLicense("premium-talk-edit", "CC BY-NC 4.0", False, True, "仅限内部非商业创作，禁止打包入商业发行版").__dict__,
            "supported_agents": ["antigravity-native"],
            "supported_engines": ["chatcut_desktop"],
            "execution_status": "verified",
            "commercial_restricted": True,
            "note": "P1 V2 两组对照 17/17 全绿通过，可稳定用于内部口播生产",
        },
        {
            "skill_id": "whiteboard-koubo",
            "name": "白板便签风口播剪辑",
            "version": _detect_version(wb_dir, "1.0.3"),
            "source": {"repo": "https://github.com/yyue5578-coder/koubo-templates", "path": str(wb_dir), "exists": (wb_dir / "SKILL.md").is_file()},
            "license": SkillLicense("whiteboard-koubo", "CC BY-NC 4.0", False, True, "仅限内部非商业创作，禁止打包入商业发行版").__dict__,
            "supported_agents": ["antigravity-native"],
            "supported_engines": ["chatcut_desktop"],
            "execution_status": "partial",
            "commercial_restricted": True,
            "note": "P1 V2 检出圆窗缩进/字幕安全区/A2音效轨 3 项缺口，P2 已在 chatcut_adapter.py 实施修复并待回归验证通过后升级状态",
        },
        {
            "skill_id": "visual-director",
            "name": "自研智能视觉导演（VisualDirector）",
            "version": _detect_version(vd_dir, "1.0.0"),
            "source": {"repo": "local://content-workbench", "path": str(vd_dir), "exists": (vd_dir / "SKILL.md").is_file()},
            "license": SkillLicense("visual-director", "Internal-Proprietary", True, False, "自研提示词与编排协议，可商业化演进").__dict__,
            "supported_agents": ["antigravity-native"],
            "supported_engines": ["chatcut_desktop", "overlay_studio"],
            "execution_status": "verified" if (vd_dir / "SKILL.md").is_file() else "unimplemented",
            "commercial_restricted": False,
            "note": "剪辑前先做完整文案语义分段、叙事目的、纯口播/真实素材/动效/布局决策",
        },
        {
            "skill_id": "real-asset-director",
            "name": "自研真实素材导演（RealAssetDirector）",
            "version": _detect_version(ra_dir, "1.0.0"),
            "source": {"repo": "local://content-workbench", "path": str(ra_dir), "exists": (ra_dir / "SKILL.md").is_file()},
            "license": SkillLicense("real-asset-director", "Internal-Proprietary", True, False, "调用工作台受控真实素材检索并记录来源/作者/许可").__dict__,
            "supported_agents": ["antigravity-native"],
            "supported_engines": ["chatcut_desktop"],
            "execution_status": "verified" if (ra_dir / "SKILL.md").is_file() else "unimplemented",
            "commercial_restricted": False,
            "note": "严禁伪造新闻/医院/人物/企业资料，无授权素材标记为待补充",
        },
        {
            "skill_id": "custom-motion-authoring",
            "name": "自研原创动效研发（CustomMotionAuthoring）",
            "version": _detect_version(cm_dir, "1.0.0"),
            "source": {"repo": "local://content-workbench", "path": str(cm_dir), "exists": (cm_dir / "SKILL.md").is_file()},
            "license": SkillLicense("custom-motion-authoring", "Internal-Proprietary", True, False, "自研 ChatCut/Remotion JSX 动效研发协议").__dict__,
            "supported_agents": ["antigravity-native"],
            "supported_engines": ["chatcut_desktop", "motion_lab"],
            "execution_status": "verified" if (cm_dir / "SKILL.md").is_file() else "unimplemented",
            "commercial_restricted": False,
            "note": "支持 AI 原创独立 JSX 组件研发、逐帧控制、渲染质检与注册入库",
        },
        {
            "skill_id": "video-quality-check",
            "name": "自研成片质量检测（VideoQualityCheck）",
            "version": _detect_version(qc_dir, "1.0.0"),
            "source": {"repo": "local://content-workbench", "path": str(qc_dir), "exists": (qc_dir / "SKILL.md").is_file()},
            "license": SkillLicense("video-quality-check", "Internal-Proprietary", True, False, "多维成片质检与人工复审回环").__dict__,
            "supported_agents": ["antigravity-native"],
            "supported_engines": ["chatcut_desktop"],
            "execution_status": "verified" if (qc_dir / "SKILL.md").is_file() else "unimplemented",
            "commercial_restricted": False,
            "note": "结合 FFprobe、final_check.py 与多维规则验收，质检通过后仍支持人工审片与局部返修",
        },
    ]


def get_skill_by_id(skill_id: str) -> dict[str, Any] | None:
    return next((s for s in list_video_skills() if s["skill_id"] == skill_id), None)


# ==================== 2. 任务序列化与超时恢复 ====================
def _row_to_job(row) -> dict[str, Any]:
    d = dict(row)
    for k in ("input_manifest_json", "visual_plan_json", "output_manifest_json", "quality_report_json", "cost_report_json", "claim_lock_json", "execution_log_json"):
        short = k.replace("_json", "")
        raw = d.pop(k, None)
        try:
            d[short] = json.loads(raw) if raw else ({} if short != "execution_log" else [])
        except Exception:
            d[short] = {} if short != "execution_log" else []
    return d


def _cleanup_expired_locks(conn) -> None:
    now = time.time()
    rows = conn.execute("SELECT job_id, status, claim_lock_json, execution_log_json, external_project_id FROM ai_video_jobs WHERE status IN ('Preparing','Analyzing','Editing','Rendering','Checking')").fetchall()
    for r in rows:
        lock = json.loads(r["claim_lock_json"]) if r["claim_lock_json"] else None
        if lock and float(lock.get("expires_at", 0)) < now:
            logs = json.loads(r["execution_log_json"]) if r["execution_log_json"] else []
            msg = f"Agent 领取锁超时（>{LOCK_TTL_SECONDS}s）且未续期，系统已自动回收并标记 Failed"
            logs.append({"ts": _now_str(), "event": "lock_timeout", "status": "Failed", "detail": msg})
            conn.execute(
                "UPDATE ai_video_jobs SET status='Failed', error_message=?, claim_lock_json=NULL, execution_log_json=?, updated_at=CURRENT_TIMESTAMP WHERE job_id=?",
                (msg, json.dumps(logs, ensure_ascii=False), r["job_id"]),
            )
            if r["external_project_id"]:
                conn.execute("DELETE FROM chatcut_project_locks WHERE external_project_id=? AND job_id=?", (r["external_project_id"], r["job_id"]))
            _audit(conn, "job_lock_timeout", "ai_video_job", r["job_id"], "Failed", msg)
    conn.execute("DELETE FROM chatcut_project_locks WHERE expires_at < ?", (now,))


# ==================== 3. 任务 CRUD、锁与状态机（§6 / §8） ====================
def create_ai_video_job(payload: dict[str, Any]) -> dict[str, Any]:
    mode = payload.get("execution_mode") or "mode_a_external_agent"
    if mode == "mode_b_programmatic":
        return {"ok": False, "error": "模式 B（程序化自动启动）当前无合规官方无人值守入口，禁止伪造一键启动"}

    skill_id = payload.get("skill_id") or "premium-talk-edit"
    sk = get_skill_by_id(skill_id)
    if not sk or sk["execution_status"] == "unimplemented":
        return {"ok": False, "error": f"Skill 不可用：{skill_id}"}

    src_video = (payload.get("source_video") or "").strip()
    if src_video and not Path(src_video).is_file():
        return {"ok": False, "error": f"源视频文件不存在：{src_video}"}

    conn = get_conn()
    try:
        _cleanup_expired_locks(conn)
        idem = (payload.get("idempotency_key") or "").strip()
        if idem:
            dup = conn.execute(
                "SELECT job_id, status FROM ai_video_jobs WHERE idempotency_key = ? AND status NOT IN ('Completed','Failed','Cancelled')",
                (idem,),
            ).fetchone()
            if dup:
                return {"ok": False, "error": f"重复任务拦截：相同 idempotency_key={idem} 的任务 {dup['job_id']} 仍处于 {dup['status']}", "existing_job_id": dup["job_id"]}

        job_id = (payload.get("job_id") or f"avj-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}").strip()
        if conn.execute("SELECT 1 FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone():
            return {"ok": False, "error": f"job_id 已存在：{job_id}"}

        init_status = "WaitingForAgent" if mode == "mode_a_external_agent" else "Pending"
        ent = Entitlement()
        input_manifest = {
            "title": payload.get("title") or f"AI 智能剪辑任务 {job_id}",
            "source_video": src_video,
            "script": payload.get("script") or "",
            "content_id": payload.get("content_id"),
            "aspect_ratio": payload.get("aspect_ratio") or "9:16",
            "resolution": payload.get("resolution") or "1080x1920",
            "auto_style": bool(payload.get("auto_style", True)),
            "style_dna": payload.get("style_dna") or {},
            "options": payload.get("options") or {
                "auto_rough_cut": True,
                "auto_captions": True,
                "real_asset_match": True,
                "smart_motion": True,
                "custom_motion": False,
                "camera_layout": True,
                "sfx_and_bgm": True,
                "auto_quality_check": True,
            },
            "cost_limit": payload.get("cost_limit") or {
                "max_chatcut_credits": ent.max_chatcut_credits_per_job,
                "allow_paid_api": ent.allow_external_paid_api,
            },
        }
        cost_report = {
            "google_ai_pro_member": "通过 Antigravity 官方客户端交互使用（官方未开放实时剩余额度接口：未知）",
            "model_visible_calls": 0,
            "chatcut_credits_before": None,
            "chatcut_credits_after": None,
            "chatcut_credits_used": 0,
            "extra_api_cost_usd": 0.0,
            "local_render_sec": 0.0,
        }
        logs = [{
            "ts": _now_str(),
            "event": "job_created",
            "status": init_status,
            "detail": f"任务已创建并进入 {init_status}（Skill={skill_id} v{sk['version']}），等待用户在 Antigravity 客户端启动 Agent 领取",
        }]

        conn.execute(
            """INSERT INTO ai_video_jobs(
                   job_id, idempotency_key, video_project_id, project_id, agent_id, engine_id,
                   skill_id, skill_version, execution_mode, input_manifest_json, status,
                   cost_report_json, execution_log_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                job_id,
                idem or None,
                payload.get("video_project_id"),
                payload.get("project_id") or 1,
                payload.get("agent_id") or "antigravity-native",
                payload.get("engine_id") or "chatcut_desktop",
                skill_id,
                sk["version"],
                mode,
                json.dumps(input_manifest, ensure_ascii=False),
                init_status,
                json.dumps(cost_report, ensure_ascii=False),
                json.dumps(logs, ensure_ascii=False),
            ),
        )
        _audit(conn, "job_created", "ai_video_job", job_id, init_status, f"创建 AI 剪辑任务（Skill={skill_id}）")
        conn.commit()
        row = conn.execute("SELECT * FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        return {"ok": True, "job": _row_to_job(row)}
    finally:
        conn.close()


def list_ai_video_jobs(project_id: int | None = None, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        _cleanup_expired_locks(conn)
        conn.commit()
        sql = "SELECT * FROM ai_video_jobs WHERE 1=1"
        params: list[Any] = []
        if project_id is not None:
            sql += " AND project_id = ?"
            params.append(project_id)
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [_row_to_job(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def get_ai_video_job(job_id: str) -> dict[str, Any] | None:
    conn = get_conn()
    try:
        _cleanup_expired_locks(conn)
        conn.commit()
        row = conn.execute("SELECT * FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return None
        job = _row_to_job(row)
        vers = conn.execute("SELECT * FROM ai_video_job_versions WHERE job_id = ? ORDER BY version_no DESC", (job_id,)).fetchall()
        job["versions"] = []
        for v in vers:
            vd = dict(v)
            for jf in ("segment_range_json", "visual_plan_json", "ffprobe_json", "quality_report_json"):
                short = jf.replace("_json", "")
                raw = vd.pop(jf, None)
                try:
                    vd[short] = json.loads(raw) if raw else {}
                except Exception:
                    vd[short] = {}
            job["versions"].append(vd)
        return job
    finally:
        conn.close()


def claim_ai_video_job(job_id: str, agent_id: str = "antigravity-native", external_project_id: str = "") -> dict[str, Any]:
    conn = get_conn()
    try:
        _cleanup_expired_locks(conn)
        row = conn.execute("SELECT * FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"任务不存在：{job_id}"}
        if row["status"] == "Cancelled":
            return {"ok": False, "error": f"任务 {job_id} 已被取消，禁止领取"}
        if row["status"] == "Completed":
            return {"ok": False, "error": f"任务 {job_id} 已完成（防重复执行保护）"}
        lock = json.loads(row["claim_lock_json"]) if row["claim_lock_json"] else None
        if lock and float(lock.get("expires_at", 0)) > time.time():
            return {"ok": False, "error": f"重复领取拦截：任务 {job_id} 已被 {lock.get('agent_id')} 锁定（lock_id={lock.get('lock_id')}）"}

        if external_project_id:
            plock = conn.execute("SELECT * FROM chatcut_project_locks WHERE external_project_id = ?", (external_project_id,)).fetchone()
            if plock and plock["job_id"] != job_id and float(plock["expires_at"]) > time.time():
                return {"ok": False, "error": f"ChatCut 共享工程互斥锁拦截：工程 {external_project_id} 正被任务 {plock['job_id']} 占用"}
            conn.execute(
                "INSERT OR REPLACE INTO chatcut_project_locks(external_project_id, job_id, agent_id, locked_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                (external_project_id, job_id, agent_id, _now_str(), time.time() + LOCK_TTL_SECONDS),
            )

        lock_id = f"lock-{uuid.uuid4().hex[:8]}"
        new_lock = {"lock_id": lock_id, "agent_id": agent_id, "claimed_at": _now_str(), "expires_at": time.time() + LOCK_TTL_SECONDS}
        logs = json.loads(row["execution_log_json"]) if row["execution_log_json"] else []
        logs.append({"ts": _now_str(), "event": "job_claimed", "status": "Preparing", "detail": f"Agent [{agent_id}] 领取任务并获得独占锁 {lock_id}"})
        conn.execute(
            "UPDATE ai_video_jobs SET agent_id=?, status='Preparing', claim_lock_json=?, execution_log_json=?, updated_at=CURRENT_TIMESTAMP WHERE job_id=?",
            (agent_id, json.dumps(new_lock, ensure_ascii=False), json.dumps(logs, ensure_ascii=False), job_id),
        )
        _audit(conn, "job_claimed", "ai_video_job", job_id, "Preparing", f"Agent {agent_id} 领取并加锁 {lock_id}")
        conn.commit()
        return {"ok": True, "job_id": job_id, "lock_id": lock_id, "status": "Preparing"}
    finally:
        conn.close()


def acquire_chatcut_project_lock(external_project_id: str, job_id: str, agent_id: str = "antigravity-native") -> dict[str, Any]:
    conn = get_conn()
    try:
        _cleanup_expired_locks(conn)
        plock = conn.execute("SELECT * FROM chatcut_project_locks WHERE external_project_id = ?", (external_project_id,)).fetchone()
        if plock and plock["job_id"] != job_id and float(plock["expires_at"]) > time.time():
            return {"ok": False, "error": f"ChatCut 共享工程互斥锁拦截：工程 {external_project_id} 正被任务 {plock['job_id']} 占用"}
        conn.execute(
            "INSERT OR REPLACE INTO chatcut_project_locks(external_project_id, job_id, agent_id, locked_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            (external_project_id, job_id, agent_id, _now_str(), time.time() + LOCK_TTL_SECONDS),
        )
        conn.commit()
        return {"ok": True, "external_project_id": external_project_id, "job_id": job_id}
    finally:
        conn.close()


def update_ai_video_job_status(job_id: str, status: str, detail: str = "", error_message: str = "") -> dict[str, Any]:
    if status not in VALID_STATUSES:
        return {"ok": False, "error": f"非法状态：{status}"}
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"任务不存在：{job_id}"}
        if row["status"] == "Cancelled" and status != "Cancelled":
            return {"ok": False, "error": f"任务 {job_id} 已取消，禁止推进至 {status}"}
        logs = json.loads(row["execution_log_json"]) if row["execution_log_json"] else []
        logs.append({"ts": _now_str(), "event": "status_changed", "status": status, "detail": detail or error_message or status})
        claim_val = None if status in TERMINAL_STATUSES else row["claim_lock_json"]
        if status in TERMINAL_STATUSES and row["external_project_id"]:
            conn.execute("DELETE FROM chatcut_project_locks WHERE external_project_id=? AND job_id=?", (row["external_project_id"], job_id))
        conn.execute(
            "UPDATE ai_video_jobs SET status=?, error_message=COALESCE(NULLIF(?,''), error_message), claim_lock_json=?, execution_log_json=?, updated_at=CURRENT_TIMESTAMP WHERE job_id=?",
            (status, error_message, claim_val, json.dumps(logs, ensure_ascii=False), job_id),
        )
        _audit(conn, "job_status_updated", "ai_video_job", job_id, status, detail or error_message or status)
        conn.commit()
        return {"ok": True, "job_id": job_id, "status": status}
    finally:
        conn.close()


def cancel_ai_video_job(job_id: str, reason: str = "用户主动取消任务") -> dict[str, Any]:
    return update_ai_video_job_status(job_id, "Cancelled", detail=reason, error_message=reason)


def check_job_cost_limit(job_id: str, requested_chatcut_credits: float = 0.0, requested_api_usd: float = 0.0) -> dict[str, Any]:
    conn = get_conn()
    try:
        row = conn.execute("SELECT input_manifest_json FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"任务不存在：{job_id}"}
        manifest = json.loads(row["input_manifest_json"]) if row["input_manifest_json"] else {}
        lim = manifest.get("cost_limit") or {"max_chatcut_credits": 0, "allow_paid_api": False}
        max_cc = float(lim.get("max_chatcut_credits", 0))
        allow_api = bool(lim.get("allow_paid_api", False))
    finally:
        conn.close()

    if requested_chatcut_credits > max_cc:
        msg = f"费用超限拦截：请求消耗 ChatCut 积分 {requested_chatcut_credits} 超过授权上限 {max_cc}"
        update_ai_video_job_status(job_id, "Blocked", detail=msg, error_message=msg)
        return {"ok": False, "blocked": True, "error": msg}
    if requested_api_usd > 0 and not allow_api:
        msg = f"费用超限拦截：任务禁止调用额外付费 API（请求 ${requested_api_usd}）"
        update_ai_video_job_status(job_id, "Blocked", detail=msg, error_message=msg)
        return {"ok": False, "blocked": True, "error": msg}
    return {"ok": True, "blocked": False}


def submit_visual_plan(job_id: str, visual_plan: dict[str, Any]) -> dict[str, Any]:
    """记录 VisualDirector 生成的结构化制作计划（§9）。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT execution_log_json, cost_report_json FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"任务不存在：{job_id}"}
        logs = json.loads(row["execution_log_json"]) if row["execution_log_json"] else []
        cost = json.loads(row["cost_report_json"]) if row["cost_report_json"] else {}
        cost["model_visible_calls"] = int(cost.get("model_visible_calls", 0)) + 1
        logs.append({
            "ts": _now_str(),
            "event": "visual_plan_submitted",
            "status": "Analyzing",
            "detail": f"提交 VisualDirector 结构化方案：{visual_plan.get('summary', '')[:120]}",
        })
        conn.execute(
            "UPDATE ai_video_jobs SET visual_plan_json=?, cost_report_json=?, execution_log_json=?, updated_at=CURRENT_TIMESTAMP WHERE job_id=?",
            (json.dumps(visual_plan, ensure_ascii=False), json.dumps(cost, ensure_ascii=False), json.dumps(logs, ensure_ascii=False), job_id),
        )
        _audit(conn, "visual_plan_submitted", "ai_video_job", job_id, "ok", visual_plan.get("summary", "提交视觉导演方案"))
        conn.commit()
        return {"ok": True, "job_id": job_id}
    finally:
        conn.close()


def _ffprobe_mp4(mp4: Path) -> dict[str, Any]:
    raw = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate", "-of", "json", str(mp4)],
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return json.loads(raw.stdout)


def register_video_output(
    job_id: str,
    output_mp4_path: str,
    external_project_id: str,
    external_project_path: str = "",
    credits_file: str = "",
    cost_report: dict[str, Any] | None = None,
    edit_scope: str = "full",
    segment_range: dict[str, Any] | None = None,
    note: str = "",
) -> dict[str, Any]:
    """登记真实成片并创建不可变版本记录（§8 / §13），强制通过 FFprobe 核验。"""
    mp4 = Path(output_mp4_path)
    if not mp4.is_file() or mp4.stat().st_size < 10000:
        return {"ok": False, "error": f"成片文件不存在或体积异常：{mp4}"}
    try:
        probe = _ffprobe_mp4(mp4)
    except Exception as e:
        return {"ok": False, "error": f"FFprobe 校验失败：{e}"}

    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"任务不存在：{job_id}"}
        max_v = conn.execute("SELECT COALESCE(MAX(version_no), 0) FROM ai_video_job_versions WHERE job_id = ?", (job_id,)).fetchone()[0]
        next_v = max_v + 1
        checksum = _sha256_file_head(mp4)
        out_manifest = {
            "version_no": next_v,
            "output_mp4_path": str(mp4.resolve()),
            "size_bytes": mp4.stat().st_size,
            "external_project_id": external_project_id,
            "external_project_path": external_project_path,
            "ffprobe": probe,
            "credits_file": credits_file,
            "checksum": checksum,
            "registered_at": _now_str(),
        }
        existing_cost = json.loads(row["cost_report_json"]) if row["cost_report_json"] else {}
        if cost_report:
            existing_cost.update(cost_report)
        logs = json.loads(row["execution_log_json"]) if row["execution_log_json"] else []
        logs.append({
            "ts": _now_str(),
            "event": "output_registered",
            "status": row["status"],
            "detail": f"登记不可变成片 v{next_v}：{mp4.name}（{round(mp4.stat().st_size/1024/1024,2)} MB，scope={edit_scope}）",
        })
        conn.execute(
            """INSERT INTO ai_video_job_versions(
                   job_id, version_no, parent_version_no, edit_scope, segment_range_json,
                   visual_plan_json, external_project_id, output_video_path, ffprobe_json,
                   checksum, note
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                job_id,
                next_v,
                max_v if max_v > 0 else None,
                edit_scope,
                json.dumps(segment_range or {}, ensure_ascii=False),
                row["visual_plan_json"] or "{}",
                external_project_id,
                str(mp4.resolve()),
                json.dumps(probe, ensure_ascii=False),
                checksum,
                note or (f"局部返修生成不可变版本 v{next_v}" if edit_scope == "segment" else f"完整制作版本 v{next_v}"),
            ),
        )
        conn.execute(
            """UPDATE ai_video_jobs
               SET external_project_id=?, external_project_path=?, output_video_path=?,
                   output_manifest_json=?, cost_report_json=?, execution_log_json=?, updated_at=CURRENT_TIMESTAMP
               WHERE job_id=?""",
            (
                external_project_id,
                external_project_path,
                str(mp4.resolve()),
                json.dumps(out_manifest, ensure_ascii=False),
                json.dumps(existing_cost, ensure_ascii=False),
                json.dumps(logs, ensure_ascii=False),
                job_id,
            ),
        )
        _audit(conn, "output_registered", "ai_video_job", job_id, "ok", f"登记成片 v{next_v} ({mp4.name})")
        conn.commit()
        return {"ok": True, "job_id": job_id, "version_no": next_v, "output_manifest": out_manifest}
    finally:
        conn.close()


def submit_quality_report(job_id: str, passed: bool, exit_code: int, raw_report: str, summary: str = "", checks: dict | None = None, billing_credits_used: float = 0.0) -> dict[str, Any]:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"任务不存在：{job_id}"}
        qr = {
            "passed": bool(passed),
            "exit_code": int(exit_code),
            "summary": summary,
            "checks": checks or {},
            "raw_report": raw_report,
            "billing_credits_used": billing_credits_used,
            "submitted_at": _now_str(),
            "human_review_note": "质检通过不等于审美优秀，请人工观看成片并可随时指定片段局部返修",
        }
        final_status = "Completed" if passed else "Failed"
        cost = json.loads(row["cost_report_json"]) if row["cost_report_json"] else {}
        cost["chatcut_credits_used"] = billing_credits_used
        logs = json.loads(row["execution_log_json"]) if row["execution_log_json"] else []
        logs.append({"ts": _now_str(), "event": "quality_report_submitted", "status": final_status, "detail": f"质检提交：{summary} (exit={exit_code})"})

        conn.execute(
            """UPDATE ai_video_jobs
               SET quality_report_json=?, cost_report_json=?, status=?,
                   error_message=CASE WHEN ?=0 THEN ? ELSE error_message END,
                   claim_lock_json=NULL, execution_log_json=?, updated_at=CURRENT_TIMESTAMP
               WHERE job_id=?""",
            (
                json.dumps(qr, ensure_ascii=False),
                json.dumps(cost, ensure_ascii=False),
                final_status,
                1 if passed else 0,
                f"质检未通过 (exit={exit_code})",
                json.dumps(logs, ensure_ascii=False),
                job_id,
            ),
        )
        # 同步最新版本的质检报告
        conn.execute(
            "UPDATE ai_video_job_versions SET quality_report_json=? WHERE job_id=? AND version_no=(SELECT MAX(version_no) FROM ai_video_job_versions WHERE job_id=?)",
            (json.dumps(qr, ensure_ascii=False), job_id, job_id),
        )
        if row["external_project_id"]:
            conn.execute("DELETE FROM chatcut_project_locks WHERE external_project_id=? AND job_id=?", (row["external_project_id"], job_id))
        _audit(conn, "quality_report_submitted", "ai_video_job", job_id, final_status, f"质检结果 passed={passed}")
        conn.commit()
        return {"ok": True, "job_id": job_id, "status": final_status, "passed": bool(passed)}
    finally:
        conn.close()


# ==================== 4. 局部 AI 重新剪辑与候选 StyleDNA 反馈（§13） ====================
def submit_edit_feedback(
    job_id: str,
    start_sec: float,
    end_sec: float,
    base_version_no: int,
    edit_request: str,
    preserve_notes: str = "非指定片段保持原剪辑点、动效与音效不变",
    propose_style_dna_rule: str = "",
) -> dict[str, Any]:
    if end_sec <= start_sec:
        return {"ok": False, "error": "修改片段结束时间必须大于开始时间"}
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"任务不存在：{job_id}"}
        req_payload = {
            "start_sec": start_sec,
            "end_sec": end_sec,
            "base_version_no": base_version_no,
            "edit_request": edit_request,
            "preserve_notes": preserve_notes,
            "requested_at": _now_str(),
        }
        logs = json.loads(row["execution_log_json"]) if row["execution_log_json"] else []
        logs.append({
            "ts": _now_str(),
            "event": "segment_edit_requested",
            "status": "WaitingForAgent",
            "detail": f"用户请求局部返修 [{start_sec:.1f}s-{end_sec:.1f}s]（基于 v{base_version_no}）：{edit_request}",
        })
        # 局部返修反馈仅写入 editor_feedback_rules 作为候选待审规则（status='pending'），绝不直接污染所有项目
        rule_id = None
        if propose_style_dna_rule.strip():
            cur = conn.execute(
                """INSERT INTO editor_feedback_rules(project_id, video_project_id, diff_json, proposed_rule, rule_category, status)
                   VALUES (?, ?, ?, ?, 'ai_segment_edit', 'pending')""",
                (row["project_id"], row["video_project_id"], json.dumps(req_payload, ensure_ascii=False), propose_style_dna_rule.strip()),
            )
            rule_id = cur.lastrowid

        conn.execute(
            "UPDATE ai_video_jobs SET status='WaitingForAgent', execution_log_json=?, updated_at=CURRENT_TIMESTAMP WHERE job_id=?",
            (json.dumps(logs, ensure_ascii=False), job_id),
        )
        _audit(conn, "segment_edit_requested", "ai_video_job", job_id, "WaitingForAgent", f"局部返修 [{start_sec}-{end_sec}s]: {edit_request[:120]}", req_payload)
        conn.commit()
        return {"ok": True, "job_id": job_id, "status": "WaitingForAgent", "segment_request": req_payload, "candidate_rule_id": rule_id}
    finally:
        conn.close()


# ==================== 5. 受信任发布交接（§15，禁止任意文件路径绕过） ====================
def handoff_trusted_output_to_publish(job_id: str, version_no: int | None = None, title: str | None = None) -> dict[str, Any]:
    """仅允许将已登记在 ai_video_job_versions 且经 FFprobe 校验的受信任 MP4 创建为 PublishHub 发布草稿。"""
    conn = get_conn()
    try:
        job = conn.execute("SELECT * FROM ai_video_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not job:
            return {"ok": False, "error": f"任务不存在：{job_id}"}
        if version_no is not None:
            ver = conn.execute("SELECT * FROM ai_video_job_versions WHERE job_id=? AND version_no=?", (job_id, version_no)).fetchone()
        else:
            ver = conn.execute("SELECT * FROM ai_video_job_versions WHERE job_id=? ORDER BY version_no DESC LIMIT 1", (job_id,)).fetchone()
        if not ver or not ver["output_video_path"]:
            return {"ok": False, "error": "该任务尚无受信任的已登记成片版本，禁止绕过校验进入发布中心"}
        mp4 = Path(ver["output_video_path"]).resolve()
        if not mp4.is_file() or mp4.stat().st_size < 10000:
            return {"ok": False, "error": f"受信任成片文件已丢失或损坏：{mp4}"}
        if not ver["ffprobe_json"]:
            return {"ok": False, "error": "该成片版本缺少 FFprobe 校验记录，禁止进入发布中心"}

        manifest = json.loads(job["input_manifest_json"]) if job["input_manifest_json"] else {}
        pkg_title = (title or manifest.get("title") or f"AI成片 {job_id} v{ver['version_no']}").strip()
        drafts = {
            "source_job_id": job_id,
            "source_version_no": ver["version_no"],
            "external_project_id": ver["external_project_id"],
            "checksum": ver["checksum"],
            "requires_human_publish_approval": True,
        }
        cur = conn.execute(
            """INSERT INTO publish_packages(project_id, video_project_id, title, video_file_path, drafts_json, rules_version, schedule_timezone, content_hash, status)
               VALUES (?, ?, ?, ?, ?, 'gcw-rules-2026.11', 'Asia/Shanghai', ?, 'draft')""",
            (job["project_id"], job["video_project_id"], pkg_title, str(mp4), json.dumps(drafts, ensure_ascii=False), ver["checksum"]),
        )
        pkg_id = cur.lastrowid
        _audit(conn, "trusted_output_sent_to_publish", "ai_video_job", job_id, "draft", f"受信任成片 v{ver['version_no']} 已创建发布草稿 publish_package#{pkg_id}")
        conn.commit()
        return {"ok": True, "package_id": pkg_id, "job_id": job_id, "version_no": ver["version_no"], "video_file_path": str(mp4), "status": "draft"}
    finally:
        conn.close()
