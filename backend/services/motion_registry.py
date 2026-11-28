"""R1 统一动效注册中心服务（Unified Motion Registry）。

核心契约：
1. 严格分离「可执行动效资产（motion_assets）」与「视觉参考资料（reference_only：Atlas 504 / Motion 264）」，
   严禁将参考资料冒充可执行卡片写入注册中心。
2. 统一纳管：
   - 原版 Overlay Studio v1.4.0 25 张动效卡（engine_type = 'overlay_native'）；
   - 工坊内置纯函数骨架（engine_type = 'motion_lab_builtin'）；
   - R2 AI 原创声明式动画 DSL（engine_type = 'motion_lab_dsl'）；
   - R2 受限沙箱渲染组件（engine_type = 'motion_lab_sandbox_js'）。
3. 每张可执行资产必须具备 11 项标准元数据，并保留不可变版本历史与验收状态机。
"""
from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any, Optional

from backend.config import ROOT_DIR
from backend.db import get_conn
from backend.services.overlay_adapter import EFFECT_CATALOG

ALLOWED_ENGINE_TYPES = {
    "overlay_native",
    "motion_lab_builtin",
    "motion_lab_dsl",
    "motion_lab_sandbox_js",
}
ALLOWED_STATUSES = {"draft", "sandbox_passed", "approved", "deprecated"}

MOTION_LAB_DIR = ROOT_DIR / "motion-lab-m2-experiment"
ATLAS_DIR = ROOT_DIR / "atlas-p1b-experiment"

# 原版 25 卡 -> 28 组分类与叙事用途映射表
NATIVE_GROUP_MAP: dict[str, tuple[str, list[str]]] = {
    "chapter-bar": ("G06", ["transition", "navigation", "ambient"]),
    "pin-board": ("G05", ["process", "summary", "ambient"]),
    "caption-track": ("G06", ["ambient", "subtitle"]),
    "stat-proof": ("G01", ["evidence", "data_viz"]),
    "ring-metric": ("G08", ["data_viz", "evidence"]),
    "odometer": ("G01", ["data_viz", "evidence"]),
    "rank-bars": ("G02", ["data_viz", "comparison"]),
    "growth-curve": ("G09", ["data_viz", "trend"]),
    "growth-bars": ("G02", ["data_viz", "trend"]),
    "donut-split": ("G08", ["data_viz", "structure"]),
    "waterfall-bridge": ("G10", ["data_viz", "breakdown"]),
    "radar-profile": ("G15", ["data_viz", "comparison"]),
    "waffle-fill": ("G08", ["data_viz", "evidence"]),
    "versus-card": ("G04", ["comparison", "decision"]),
    "quote-lockup": ("G03", ["emotion_peak", "quote", "summary"]),
    "punch-pill": ("G03", ["emotion_peak", "highlight"]),
    "step-timeline": ("G05", ["process", "explainer_graphic"]),
    "checklist": ("G18", ["process", "checklist"]),
    "term-card": ("G11", ["explainer_graphic", "definition"]),
    "ui-callout": ("G26", ["explainer_graphic", "annotation"]),
    "blur-text": ("G24", ["emotion_peak", "opening", "transition"]),
    "type-shift": ("G24", ["emotion_peak", "transition"]),
    "entity-chips": ("G22", ["entity", "highlight"]),
    "focus-card": ("G26", ["real_footage", "annotation"]),
    "terminal-3d": ("G14", ["explainer_graphic", "code_demo"]),
}

LAB_SKELETON_GROUP_MAP: dict[str, tuple[str, list[str]]] = {
    "stat_counter": ("G01", ["evidence", "data_viz"]),
    "bar_race_rank": ("G02", ["data_viz", "comparison"]),
    "callout_reveal": ("G03", ["emotion_peak", "quote"]),
    "versus_split": ("G04", ["comparison", "decision"]),
    "step_flow_list": ("G05", ["process", "explainer_graphic"]),
}


def _sha256_json(obj: Any) -> str:
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _audit(conn, event_type: str, entity_type: str, entity_id: str, status: str, summary: str, payload: Any = None):
    conn.execute(
        """INSERT INTO integration_audit_events(module, event_type, entity_type, entity_id, status, summary, payload_json)
           VALUES ('motion_registry', ?, ?, ?, ?, ?, ?)""",
        (event_type, entity_type, str(entity_id), status, summary, json.dumps(payload or {}, ensure_ascii=False)),
    )


def validate_executable_asset_payload(payload: dict[str, Any]) -> None:
    """强制校验统一可执行动效资产协议，拒绝 reference_only 或字段不全的伪资产。"""
    if payload.get("asset_class") == "reference_only" or payload.get("is_executable") is False:
        raise ValueError("参考资料（reference_only）严禁写入可执行动效注册中心")

    engine = str(payload.get("engine_type") or "").strip()
    if engine not in ALLOWED_ENGINE_TYPES:
        raise ValueError(f"非法 engine_type: {engine}，允许值：{sorted(ALLOWED_ENGINE_TYPES)}")

    asset_id = str(payload.get("asset_id") or "").strip()
    name = str(payload.get("name") or "").strip()
    if not asset_id or not name:
        raise ValueError("asset_id 与 name 为必填项")

    status = str(payload.get("status") or "draft").strip()
    if status not in ALLOWED_STATUSES:
        raise ValueError(f"非法状态 status: {status}")

    # 针对声明式 DSL 资产，必须包含非空 layers 结构
    if engine == "motion_lab_dsl":
        skel = payload.get("skeleton_spec") or {}
        dsl = skel.get("dsl") if isinstance(skel, dict) else None
        if not isinstance(dsl, dict) or not isinstance(dsl.get("layers"), list) or len(dsl["layers"]) == 0:
            raise ValueError("motion_lab_dsl 资产必须在 skeleton_spec.dsl.layers 中包含有效图层定义")


def upsert_motion_asset(
    payload: dict[str, Any],
    change_note: str = "init",
    gate_report: Optional[dict[str, Any]] = None,
    conn=None,
) -> dict[str, Any]:
    """创建或更新统一可执行动效资产，并写入不可变版本快照。"""
    validate_executable_asset_payload(payload)
    own_conn = conn is None
    if own_conn:
        conn = get_conn()

    asset_id = str(payload["asset_id"]).strip()
    version = str(payload.get("version") or "1.0.0").strip()
    name = str(payload["name"]).strip()
    engine_type = str(payload["engine_type"]).strip()
    group_id = str(payload.get("group_id") or "G01").strip()
    skeleton_spec = payload.get("skeleton_spec") or {}
    params_schema = payload.get("params_schema") or {}
    narrative_purposes = payload.get("narrative_purposes") or []
    default_content = payload.get("default_content") or {}
    default_skin = payload.get("default_skin") or {}
    sound_cues = payload.get("sound_cues") or []
    timeline_behavior = payload.get("timeline_behavior") or {"default_duration": 4.0, "min_duration": 1.2, "max_duration": 15.0, "allow_overlap": True}
    capabilities = payload.get("capabilities") or {"realtime_param_edit": True, "reverse_scrub": engine_type != "overlay_native", "transparent_export": True}
    source_type = str(payload.get("source_type") or "manual").strip()
    license_note = str(payload.get("license_note") or "Internal").strip()
    status = str(payload.get("status") or "draft").strip()

    spec_snapshot = {
        "asset_id": asset_id,
        "version": version,
        "name": name,
        "engine_type": engine_type,
        "group_id": group_id,
        "skeleton_spec": skeleton_spec,
        "params_schema": params_schema,
        "narrative_purposes": narrative_purposes,
        "default_content": default_content,
        "default_skin": default_skin,
        "sound_cues": sound_cues,
        "timeline_behavior": timeline_behavior,
        "capabilities": capabilities,
        "source_type": source_type,
        "license_note": license_note,
    }
    checksum = _sha256_json(spec_snapshot)

    conn.execute(
        """INSERT INTO motion_assets (
               asset_id, version, name, engine_type, group_id,
               skeleton_spec_json, params_schema_json, narrative_purposes_json,
               default_content_json, default_skin_json, sound_cues_json,
               timeline_behavior_json, capabilities_json,
               source_type, license_note, status, is_executable, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
           ON CONFLICT(asset_id) DO UPDATE SET
               version = excluded.version,
               name = excluded.name,
               engine_type = excluded.engine_type,
               group_id = excluded.group_id,
               skeleton_spec_json = excluded.skeleton_spec_json,
               params_schema_json = excluded.params_schema_json,
               narrative_purposes_json = excluded.narrative_purposes_json,
               default_content_json = excluded.default_content_json,
               default_skin_json = excluded.default_skin_json,
               sound_cues_json = excluded.sound_cues_json,
               timeline_behavior_json = excluded.timeline_behavior_json,
               capabilities_json = excluded.capabilities_json,
               source_type = excluded.source_type,
               license_note = excluded.license_note,
               status = excluded.status,
               updated_at = CURRENT_TIMESTAMP""",
        (
            asset_id, version, name, engine_type, group_id,
            json.dumps(skeleton_spec, ensure_ascii=False),
            json.dumps(params_schema, ensure_ascii=False),
            json.dumps(narrative_purposes, ensure_ascii=False),
            json.dumps(default_content, ensure_ascii=False),
            json.dumps(default_skin, ensure_ascii=False),
            json.dumps(sound_cues, ensure_ascii=False),
            json.dumps(timeline_behavior, ensure_ascii=False),
            json.dumps(capabilities, ensure_ascii=False),
            source_type, license_note, status,
        ),
    )

    conn.execute(
        """INSERT OR IGNORE INTO motion_asset_versions(asset_id, version, spec_json, checksum, change_note, gate_report_json)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            asset_id,
            version,
            json.dumps(spec_snapshot, ensure_ascii=False),
            checksum,
            change_note,
            json.dumps(gate_report, ensure_ascii=False) if gate_report else None,
        ),
    )

    if own_conn:
        conn.commit()
        row = conn.execute("SELECT * FROM motion_assets WHERE asset_id = ?", (asset_id,)).fetchone()
        conn.close()
        return deserialize_asset_row(dict(row))
    return spec_snapshot


def deserialize_asset_row(row: dict[str, Any]) -> dict[str, Any]:
    """将数据库行反序列化为标准可执行动效资产对象。"""
    return {
        "id": row["id"],
        "asset_id": row["asset_id"],
        "version": row["version"],
        "name": row["name"],
        "engine_type": row["engine_type"],
        "group_id": row["group_id"],
        "skeleton_spec": json.loads(row.get("skeleton_spec_json") or "{}"),
        "params_schema": json.loads(row.get("params_schema_json") or "{}"),
        "narrative_purposes": json.loads(row.get("narrative_purposes_json") or "[]"),
        "default_content": json.loads(row.get("default_content_json") or "{}"),
        "default_skin": json.loads(row.get("default_skin_json") or "{}"),
        "sound_cues": json.loads(row.get("sound_cues_json") or "[]"),
        "timeline_behavior": json.loads(row.get("timeline_behavior_json") or "{}"),
        "capabilities": json.loads(row.get("capabilities_json") or "{}"),
        "source_type": row["source_type"],
        "license_note": row["license_note"],
        "status": row["status"],
        "is_executable": bool(row.get("is_executable", 1)),
        "usage_count": int(row.get("usage_count") or 0),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def sync_builtin_motion_assets() -> dict[str, int]:
    """幂等同步原版 25 卡、工坊内置 5 骨架及已有门禁通过的自定义卡至统一注册中心。"""
    conn = get_conn()
    counts = {"overlay_native": 0, "motion_lab_builtin": 0, "custom_imported": 0}

    # 1. 原版 Overlay Studio v1.4.0 25 张动效卡
    controls_file = ROOT_DIR / "backend" / "services" / "overlay_controls_meta.json"
    controls_meta = json.loads(controls_file.read_text(encoding="utf-8")) if controls_file.is_file() else {}
    for eff in EFFECT_CATALOG:
        eid = eff["id"]
        gid, purposes = NATIVE_GROUP_MAP.get(eid, ("G03", ["explainer_graphic"]))
        meta = controls_meta.get(eid) or {}
        upsert_motion_asset(
            {
                "asset_id": f"native:{eid}",
                "version": "1.4.0",
                "name": eff["name"],
                "engine_type": "overlay_native",
                "group_id": gid,
                "skeleton_spec": {"native_kind": eid, "group_label": eff["group"], "desc": eff["desc"], "layout_mode": meta.get("layout_mode", "position")},
                "params_schema": {"controls": meta.get("controls", []), "defaults": eff.get("defaults", {})},
                "narrative_purposes": purposes,
                "default_content": eff.get("defaults", {}),
                "default_skin": {"theme": "dark", "engine": "overlay_native"},
                "sound_cues": [{"role": "enter", "sfx": "pop"}],
                "timeline_behavior": {"default_duration": 4.0, "min_duration": 1.0, "max_duration": 30.0, "allow_overlap": True},
                "capabilities": {"realtime_param_edit": True, "reverse_scrub": False, "transparent_export": True, "preview_engine": "overlay_studio_v1.4"},
                "source_type": "overlay_v1.4",
                "license_note": "Overlay Studio v1.4.0 (Upstream Isolated Engine)",
                "status": "approved",
            },
            change_note="sync overlay_native v1.4.0",
            conn=conn,
        )
        counts["overlay_native"] += 1

    # 2. 工坊内置纯函数骨架（5 种）
    skel_file = MOTION_LAB_DIR / "schemas" / "M2_SKELETON_SCHEMA.json"
    skin_file = MOTION_LAB_DIR / "schemas" / "M2_SKIN_SCHEMA.json"
    default_skin_obj = {}
    if skin_file.is_file():
        sk_data = json.loads(skin_file.read_text(encoding="utf-8"))
        default_skin_obj = next((s for s in sk_data.get("skins", []) if s.get("id") == "maitian_minimal"), {})
    if skel_file.is_file():
        skels = json.loads(skel_file.read_text(encoding="utf-8")).get("skeletons", [])
        for sk in skels:
            sid = sk["id"]
            gid, purposes = LAB_SKELETON_GROUP_MAP.get(sid, ("G05", ["explainer_graphic"]))
            defaults = {k: v.get("default") for k, v in (sk.get("content_schema") or {}).items()}
            upsert_motion_asset(
                {
                    "asset_id": f"lab:{sid}",
                    "version": "1.0.0",
                    "name": sk["name"],
                    "engine_type": "motion_lab_builtin",
                    "group_id": gid,
                    "skeleton_spec": {"skeleton_id": sid, "layout_slots": sk.get("layout_slots", []), "motion_phases": sk.get("motion_phases", [])},
                    "params_schema": sk.get("content_schema", {}),
                    "narrative_purposes": purposes,
                    "default_content": defaults,
                    "default_skin": default_skin_obj,
                    "sound_cues": sk.get("sound_cues", []),
                    "timeline_behavior": {"default_duration": sk.get("default_duration", 4.0), "min_duration": 1.5, "max_duration": 12.0, "allow_overlap": True},
                    "capabilities": {"realtime_param_edit": True, "reverse_scrub": True, "transparent_export": True, "deterministic_ft": True},
                    "source_type": "lab_builtin",
                    "license_note": "Original Pure-Function Canvas Engine (Internal)",
                    "status": "approved",
                },
                change_note="sync motion_lab_builtin",
                conn=conn,
            )
            counts["motion_lab_builtin"] += 1

    # 3. 历史已通过门禁的工坊自定义卡（只读迁移，不删除原文件）
    custom_file = MOTION_LAB_DIR / "registry" / "custom_cards.json"
    if custom_file.is_file():
        try:
            cards = json.loads(custom_file.read_text(encoding="utf-8"))
            for c in cards:
                if not c.get("gate_passed"):
                    continue
                sid = c.get("skeleton_id") or "step_flow_list"
                gid, purposes = LAB_SKELETON_GROUP_MAP.get(sid, ("G05", ["explainer_graphic"]))
                upsert_motion_asset(
                    {
                        "asset_id": f"custom:{c['id']}",
                        "version": "1.0.0",
                        "name": c.get("name") or c["id"],
                        "engine_type": "motion_lab_builtin",
                        "group_id": gid,
                        "skeleton_spec": {"skeleton_id": sid, "source_prompt": c.get("source_prompt")},
                        "params_schema": {},
                        "narrative_purposes": purposes,
                        "default_content": c.get("content") or {},
                        "default_skin": c.get("skin") or default_skin_obj,
                        "sound_cues": [],
                        "timeline_behavior": {"default_duration": float(c.get("duration") or 4.0), "min_duration": 1.5, "max_duration": 12.0, "allow_overlap": True},
                        "capabilities": {"realtime_param_edit": True, "reverse_scrub": True, "transparent_export": True, "deterministic_ft": True},
                        "source_type": "ai_config_combo",
                        "license_note": "User Custom Card (Sandbox Gate Passed)",
                        "status": "approved",
                    },
                    change_note="migrate custom_cards.json",
                    conn=conn,
                )
                counts["custom_imported"] += 1
        except Exception:
            pass

    conn.commit()
    conn.close()
    return counts


def list_motion_assets(
    engine_type: Optional[str] = None,
    group_id: Optional[str] = None,
    narrative_purpose: Optional[str] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
) -> list[dict[str, Any]]:
    """检索统一可执行动效资产（绝不包含 reference_only 参考资料）。"""
    conn = get_conn()
    clauses = ["is_executable = 1"]
    params: list[Any] = []
    if engine_type:
        clauses.append("engine_type = ?")
        params.append(engine_type)
    if group_id:
        clauses.append("group_id = ?")
        params.append(group_id)
    if status:
        clauses.append("status = ?")
        params.append(status)
    rows = conn.execute(
        f"SELECT * FROM motion_assets WHERE {' AND '.join(clauses)} ORDER BY updated_at DESC, id ASC",
        params,
    ).fetchall()
    conn.close()

    items = [deserialize_asset_row(dict(r)) for r in rows]
    if narrative_purpose:
        np_low = narrative_purpose.strip().lower()
        items = [x for x in items if any(np_low in str(p).lower() for p in x["narrative_purposes"])]
    if q and q.strip():
        ql = q.strip().lower()
        items = [
            x for x in items
            if ql in x["asset_id"].lower()
            or ql in x["name"].lower()
            or ql in x["group_id"].lower()
            or ql in json.dumps(x["narrative_purposes"], ensure_ascii=False).lower()
            or ql in json.dumps(x["skeleton_spec"], ensure_ascii=False).lower()
        ]
    return items


def get_motion_asset_detail(asset_id: str) -> Optional[dict[str, Any]]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM motion_assets WHERE asset_id = ?", (asset_id,)).fetchone()
    if not row:
        conn.close()
        return None
    vers = conn.execute(
        "SELECT version, checksum, change_note, gate_report_json, created_at FROM motion_asset_versions WHERE asset_id = ? ORDER BY id DESC",
        (asset_id,),
    ).fetchall()
    conn.close()
    item = deserialize_asset_row(dict(row))
    item["versions"] = [
        {
            "version": v["version"],
            "checksum": v["checksum"],
            "change_note": v["change_note"],
            "gate_report": json.loads(v["gate_report_json"]) if v["gate_report_json"] else None,
            "created_at": v["created_at"],
        }
        for v in vers
    ]
    return item


def update_motion_asset_status(asset_id: str, new_status: str, note: str = "") -> dict[str, Any]:
    if new_status not in ALLOWED_STATUSES:
        raise ValueError(f"非法状态：{new_status}")
    conn = get_conn()
    row = conn.execute("SELECT * FROM motion_assets WHERE asset_id = ?", (asset_id,)).fetchone()
    if not row:
        conn.close()
        raise KeyError(f"未找到动效资产：{asset_id}")
    old_status = row["status"]
    conn.execute("UPDATE motion_assets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE asset_id = ?", (new_status, asset_id))
    _audit(conn, "asset_status_changed", "motion_asset", asset_id, new_status, f"{old_status} -> {new_status}: {note}")
    conn.commit()
    updated = conn.execute("SELECT * FROM motion_assets WHERE asset_id = ?", (asset_id,)).fetchone()
    conn.close()
    return deserialize_asset_row(dict(updated))


def get_28_groups_coverage() -> dict[str, Any]:
    """统计 28 组分类下的真实可执行资产覆盖率（严格只计入 is_executable=1）。"""
    tax_file = MOTION_LAB_DIR / "schemas" / "M5_28_GROUPS_TAXONOMY.json"
    tax = json.loads(tax_file.read_text(encoding="utf-8")) if tax_file.is_file() else {"groups": [], "target_cards": 501}
    assets = list_motion_assets()
    by_group: dict[str, list[dict[str, Any]]] = {}
    for a in assets:
        by_group.setdefault(a["group_id"], []).append(a)

    groups_out = []
    covered_groups = 0
    for g in tax.get("groups", []):
        gid = g["id"]
        g_assets = by_group.get(gid, [])
        approved = [x for x in g_assets if x["status"] == "approved"]
        if approved:
            covered_groups += 1
        groups_out.append({
            "id": gid,
            "name": g["name"],
            "target_cards": g.get("target_cards", 18),
            "approved_count": len(approved),
            "native_count": sum(1 for x in approved if x["engine_type"] == "overlay_native"),
            "lab_count": sum(1 for x in approved if x["engine_type"] != "overlay_native"),
            "gap": max(0, int(g.get("target_cards", 18)) - len(approved)),
        })
    return {
        "total_groups": len(groups_out),
        "covered_groups": covered_groups,
        "target_cards": tax.get("target_cards", 501),
        "total_executable_assets": len(assets),
        "approved_executable_assets": sum(1 for a in assets if a["status"] == "approved"),
        "groups": groups_out,
    }


def list_reference_catalog(source: str = "atlas", q: str = "", limit: int = 20) -> dict[str, Any]:
    """只读返回视觉参考资料（显式标记 asset_class='reference_only'，严禁当作可执行卡）。"""
    ql = q.strip().lower()
    if source == "motion":
        f = ATLAS_DIR / "r2_motion_catalog.json"
        if not f.is_file():
            return {"asset_class": "reference_only", "source": "motion", "total": 0, "items": []}
        raw = json.loads(f.read_text(encoding="utf-8"))
        els = raw.get("elements") or []
        hits = []
        for el in els:
            nm = el.get("name") or {}
            mn = el.get("meaning") or {}
            blob = f"{el.get('slug','')} {nm.get('zh-Hans','')} {nm.get('en','')} {mn.get('zh-Hans','')}".lower()
            if not ql or ql in blob:
                hits.append({
                    "id": f"{el.get('pack')}:{el.get('slug')}",
                    "asset_class": "reference_only",
                    "is_executable": False,
                    "title_zh": nm.get("zh-Hans") or nm.get("en"),
                    "title_en": nm.get("en"),
                    "cycle": el.get("cycle"),
                    "summary": mn.get("zh-Hans") or mn.get("en"),
                })
            if len(hits) >= max(1, min(50, limit)):
                break
        return {"asset_class": "reference_only", "source": "motion", "total": len(els), "items": hits}

    f = ATLAS_DIR / "atlas_catalog_cn.json"
    if not f.is_file():
        return {"asset_class": "reference_only", "source": "atlas", "total": 0, "items": []}
    raw = json.loads(f.read_text(encoding="utf-8"))
    hits = []
    for item in raw:
        tr = item.get("translation") or {}
        cat = (item.get("original") or {}).get("catalog") or {}
        blob = f"{item.get('source_id','')} {tr.get('title','')} {cat.get('title','')} {tr.get('visual_features','')}".lower()
        if not ql or ql in blob:
            hits.append({
                "id": item.get("source_id"),
                "asset_class": "reference_only",
                "is_executable": False,
                "title_zh": tr.get("title") or cat.get("title"),
                "title_en": cat.get("title"),
                "kind": cat.get("kind"),
                "summary": (tr.get("visual_features") or "")[:120],
            })
        if len(hits) >= max(1, min(50, limit)):
            break
    return {"asset_class": "reference_only", "source": "atlas", "total": len(raw), "items": hits}


def create_dev_task(
    title: str,
    requirement_prompt: str,
    group_id: str = "G05",
    video_project_id: Optional[int] = None,
    suggested_structure: Optional[dict] = None,
    time_range: Optional[dict] = None,
) -> dict[str, Any]:
    task_uid = f"task_{uuid.uuid4().hex[:10]}"
    conn = get_conn()
    conn.execute(
        """INSERT INTO motion_dev_tasks(task_uid, video_project_id, group_id, title, requirement_prompt, suggested_structure_json, time_range_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open')""",
        (
            task_uid, video_project_id, group_id, title, requirement_prompt,
            json.dumps(suggested_structure or {}, ensure_ascii=False),
            json.dumps(time_range or {}, ensure_ascii=False),
        ),
    )
    _audit(conn, "dev_task_created", "motion_dev_task", task_uid, "open", title)
    conn.commit()
    row = conn.execute("SELECT * FROM motion_dev_tasks WHERE task_uid = ?", (task_uid,)).fetchone()
    conn.close()
    return dict(row)


def list_dev_tasks(status: Optional[str] = None) -> list[dict[str, Any]]:
    conn = get_conn()
    if status:
        rows = conn.execute("SELECT * FROM motion_dev_tasks WHERE status = ? ORDER BY id DESC", (status,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM motion_dev_tasks ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]
