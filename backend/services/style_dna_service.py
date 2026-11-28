"""R5 统一个人风格 DNA 服务（全局/项目级版本化、审批门禁、锁定与回滚）。

治理原则：
1. 工坊反馈、原版人工修改偏好、参考图选择与动效使用记录统一汇入 style_dna_events；
2. 只有显式批准（status='approved' 或 'locked'）的 Style DNA 版本才会注入 R2 研发与 R4 视觉导演；
3. 支持项目级覆盖全局、一键锁定防误改、以及回滚到任意历史版本。
"""
from __future__ import annotations

import json
from typing import Any, Optional

from backend.config import ROOT_DIR
from backend.db import get_conn

LEGACY_DNA_FILE = ROOT_DIR / "motion-lab-m2-experiment" / "registry" / "style_dna_profile.json"


def _deserialize_profile(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "scope": row["scope"],
        "project_id": row["project_id"],
        "version": int(row["version"]),
        "status": row["status"],
        "theme": row["theme"],
        "motion_intensity": float(row["motion_intensity"]),
        "radius_scale": float(row["radius_scale"]),
        "accent_primary": row["accent_primary"],
        "pacing_density": row["pacing_density"],
        "approved_rules": json.loads(row.get("approved_rules_json") or "[]"),
        "palette": json.loads(row.get("palette_json") or "[]"),
        "note": row.get("note") or "",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def ensure_default_style_dna() -> dict[str, Any]:
    """幂等初始化全局 v1 已批准 Style DNA（若存在历史 JSON 则迁入初始值）。"""
    conn = get_conn()
    existing = conn.execute(
        "SELECT * FROM style_dna_profiles WHERE scope = 'global' ORDER BY version DESC LIMIT 1"
    ).fetchone()
    if existing:
        conn.close()
        return _deserialize_profile(dict(existing))

    theme = "dark"
    amp = 1.0
    rad = 1.0
    accent = "#3b82f6"
    palette = ["#3b82f6", "#ea580c", "#10b981"]
    if LEGACY_DNA_FILE.is_file():
        try:
            leg = json.loads(LEGACY_DNA_FILE.read_text(encoding="utf-8"))
            if leg.get("preferred_theme") in ("dark", "light"):
                theme = leg["preferred_theme"]
            amp = float(leg.get("motion_intensity") or 1.0)
            rad = float(leg.get("radius_scale") or 1.0)
            favs = leg.get("favorite_accents") or []
            if favs:
                accent = favs[0]
                palette = favs[:6]
        except Exception:
            pass

    conn.execute(
        """INSERT INTO style_dna_profiles(
               scope, project_id, version, status, theme, motion_intensity, radius_scale,
               accent_primary, pacing_density, approved_rules_json, palette_json, note
           ) VALUES ('global', NULL, 1, 'approved', ?, ?, ?, ?, 'balanced', ?, ?, ?)""",
        (
            theme, amp, rad, accent,
            json.dumps(["优先使用清晰高对比字体与克制节奏"], ensure_ascii=False),
            json.dumps(palette, ensure_ascii=False),
            "R5 初始全局已批准 Style DNA v1",
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM style_dna_profiles WHERE scope = 'global' ORDER BY version DESC LIMIT 1").fetchone()
    conn.close()
    return _deserialize_profile(dict(row))


def get_active_approved_dna(project_id: Optional[int] = None) -> dict[str, Any]:
    """获取当前生效（仅 approved / locked）的 Style DNA：优先项目级覆盖，其次全局。"""
    ensure_default_style_dna()
    conn = get_conn()
    row = None
    if project_id is not None:
        row = conn.execute(
            """SELECT * FROM style_dna_profiles
               WHERE scope = 'project' AND project_id = ? AND status IN ('approved', 'locked')
               ORDER BY version DESC LIMIT 1""",
            (project_id,),
        ).fetchone()
    if not row:
        row = conn.execute(
            """SELECT * FROM style_dna_profiles
               WHERE scope = 'global' AND status IN ('approved', 'locked')
               ORDER BY version DESC LIMIT 1"""
        ).fetchone()
    # 合并原版 editor_feedback_rules 中已批准规则，彻底打通两套偏好
    fb_rows = conn.execute(
        "SELECT proposed_rule FROM editor_feedback_rules WHERE status = 'approved' ORDER BY id DESC LIMIT 20"
    ).fetchall()
    conn.close()

    prof = _deserialize_profile(dict(row))
    merged_rules = list(prof["approved_rules"])
    for r in fb_rows:
        rule_txt = r["proposed_rule"]
        if rule_txt and rule_txt not in merged_rules:
            merged_rules.append(rule_txt)
    prof["approved_rules"] = merged_rules
    return prof


def list_dna_versions(scope: str = "global", project_id: Optional[int] = None) -> list[dict[str, Any]]:
    ensure_default_style_dna()
    conn = get_conn()
    if scope == "project" and project_id is not None:
        rows = conn.execute(
            "SELECT * FROM style_dna_profiles WHERE scope = 'project' AND project_id = ? ORDER BY version DESC",
            (project_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM style_dna_profiles WHERE scope = 'global' ORDER BY version DESC"
        ).fetchall()
    conn.close()
    return [_deserialize_profile(dict(r)) for r in rows]


def create_dna_version(
    theme: str = "dark",
    motion_intensity: float = 1.0,
    radius_scale: float = 1.0,
    accent_primary: str = "#3b82f6",
    pacing_density: str = "balanced",
    approved_rules: Optional[list[str]] = None,
    palette: Optional[list[str]] = None,
    scope: str = "global",
    project_id: Optional[int] = None,
    status: str = "draft",
    note: str = "",
) -> dict[str, Any]:
    """创建新版本 Style DNA（默认 status='draft'，须显式批准才进入正式编排）。"""
    if status not in ("draft", "approved", "locked"):
        raise ValueError(f"非法状态：{status}")
    ensure_default_style_dna()
    conn = get_conn()
    # 检查当前最新生效版本是否被锁定
    if scope == "project" and project_id is not None:
        cur = conn.execute(
            "SELECT MAX(version) as mv FROM style_dna_profiles WHERE scope = 'project' AND project_id = ?",
            (project_id,),
        ).fetchone()
        locked = conn.execute(
            "SELECT version FROM style_dna_profiles WHERE scope = 'project' AND project_id = ? AND status = 'locked' LIMIT 1",
            (project_id,),
        ).fetchone()
    else:
        scope = "global"
        project_id = None
        cur = conn.execute("SELECT MAX(version) as mv FROM style_dna_profiles WHERE scope = 'global'").fetchone()
        locked = conn.execute("SELECT version FROM style_dna_profiles WHERE scope = 'global' AND status = 'locked' LIMIT 1").fetchone()

    if locked and status in ("approved", "locked"):
        conn.close()
        raise ValueError(f"当前 {scope} Style DNA v{locked['version']} 已锁定，请先解锁后再批准新版本")

    next_ver = int((cur["mv"] or 0)) + 1
    conn.execute(
        """INSERT INTO style_dna_profiles(
               scope, project_id, version, status, theme, motion_intensity, radius_scale,
               accent_primary, pacing_density, approved_rules_json, palette_json, note
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            scope, project_id, next_ver, status, theme, float(motion_intensity), float(radius_scale),
            accent_primary, pacing_density,
            json.dumps(approved_rules or [], ensure_ascii=False),
            json.dumps(palette or [accent_primary], ensure_ascii=False),
            note or f"Style DNA v{next_ver}",
        ),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM style_dna_profiles WHERE scope = ? AND COALESCE(project_id, -1) = COALESCE(?, -1) AND version = ?",
        (scope, project_id, next_ver),
    ).fetchone()
    conn.close()
    return _deserialize_profile(dict(row))


def set_dna_version_status(version: int, new_status: str, scope: str = "global", project_id: Optional[int] = None) -> dict[str, Any]:
    if new_status not in ("draft", "approved", "locked", "archived"):
        raise ValueError(f"非法状态：{new_status}")
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM style_dna_profiles WHERE scope = ? AND COALESCE(project_id, -1) = COALESCE(?, -1) AND version = ?",
        (scope, project_id, version),
    ).fetchone()
    if not row:
        conn.close()
        raise KeyError(f"未找到 {scope} Style DNA v{version}")
    if new_status in ("approved", "locked"):
        # 将其他同 scope 已生效版本归档，保证唯一当前生效态
        conn.execute(
            """UPDATE style_dna_profiles SET status = 'archived', updated_at = CURRENT_TIMESTAMP
               WHERE scope = ? AND COALESCE(project_id, -1) = COALESCE(?, -1) AND status IN ('approved', 'locked') AND version != ?""",
            (scope, project_id, version),
        )
    conn.execute(
        """UPDATE style_dna_profiles SET status = ?, updated_at = CURRENT_TIMESTAMP
           WHERE scope = ? AND COALESCE(project_id, -1) = COALESCE(?, -1) AND version = ?""",
        (new_status, scope, project_id, version),
    )
    conn.commit()
    updated = conn.execute(
        "SELECT * FROM style_dna_profiles WHERE scope = ? AND COALESCE(project_id, -1) = COALESCE(?, -1) AND version = ?",
        (scope, project_id, version),
    ).fetchone()
    conn.close()
    return _deserialize_profile(dict(updated))


def rollback_dna_to_version(target_version: int, scope: str = "global", project_id: Optional[int] = None) -> dict[str, Any]:
    """一键回滚至指定历史版本（直接将该版本重新激活为 approved）。"""
    return set_dna_version_status(target_version, "approved", scope=scope, project_id=project_id)


def record_dna_event(
    event_source: str,
    action: str,
    payload: dict[str, Any],
    scope: str = "global",
    project_id: Optional[int] = None,
) -> dict[str, Any]:
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO style_dna_events(scope, project_id, event_source, action, payload_json, approval_status)
           VALUES (?, ?, ?, ?, ?, 'pending')""",
        (scope, project_id, event_source, action, json.dumps(payload or {}, ensure_ascii=False)),
    )
    eid = cur.lastrowid
    conn.commit()
    row = conn.execute("SELECT * FROM style_dna_events WHERE id = ?", (eid,)).fetchone()
    conn.close()
    return dict(row)
