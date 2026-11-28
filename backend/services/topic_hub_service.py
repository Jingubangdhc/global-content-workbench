"""SEARCH-PHASE-4 · 选题资产中心（TopicHub）核心业务服务。

核心原则：
1. 100% 复用 Phase 3 已建立的 topics / topic_evidence / topic_relations 表，绝不新建第二套选题库；
2. 市场验证状态（U/B/A/S/待复核）与制作状态（新发现/待研究/待制作/制作中/已发布/已搁置）严格分离，收藏为独立属性；
3. 人工原创选题允许直接创建（不强制先 AI 搜索），初始验证状态严格为 U，进入待制作不改变市场验证等级；
4. 多对多证据关系与跨项目严格隔离：删除某选题关联绝不误删其他选题或作品/作者/评论实体；
5. 相似选题仅检测提示，绝不未经用户确认自动删除；合并无损保留全部证据/关键词/任务/父子关系，并支持日志恢复。
"""
from __future__ import annotations

import json
import re
from typing import Any

from backend.db import get_conn
from backend.services import market_validation_engine as mv_svc
from backend.services import search_batch_engine as batch_svc

# FIX-A07: 统一 7 态生命周期（状态严格由用户控制，AI 与自动操作不得修改）
VALID_PRODUCTION_STATUSES = ["待研究", "研究中", "待制作", "制作中", "待发布", "已发布", "已归档"]
LIFECYCLE_FLOW_ORDER = ["待研究", "研究中", "待制作", "制作中", "待发布", "已发布"]
VALID_VALIDATION_STATUSES = ["U", "B", "A", "S", "待复核"]
ORIGIN_LABELS = {
    "A_original_matched": "SearchHub·原始方向",
    "B_market_derived": "市场反向衍生",
    "C_ai_or_human_inspiration": "AI 待验证灵感",
    "manual_original": "人工原创灵感",
    "content_comment_discovery": "作品/评论发现",
}


def _norm_grade(raw: str | None) -> str:
    s = (raw or "").strip()
    if s in ("U", "B", "A", "S", "待复核"):
        return s
    if s in ("unverified", "insufficient", "validating", ""):
        return "U"
    return s


def _norm_prod_status(raw: str | None) -> str:
    s = (raw or "").strip()
    if s in VALID_PRODUCTION_STATUSES:
        return s
    mapping = {
        "新发现": "待研究",
        "待验证": "待研究",
        "证据不足": "待研究",
        "已验证": "待制作",
        "已收藏": "待研究",
        "已搁置": "已归档",
    }
    return mapping.get(s, "待研究")


def _norm_text(s: str) -> str:
    return re.sub(r"[\[\]【】()（）<>《》\"'“”‘’!！?？.,，。:：;；\-_/|·•\s]+", "", (s or "").lower())


def _jaccard3(a: str, b: str) -> float:
    na, nb = _norm_text(a), _norm_text(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ga = {na[i : i + 3] for i in range(max(1, len(na) - 2))}
    gb = {nb[i : i + 3] for i in range(max(1, len(nb) - 2))}
    u = len(ga | gb)
    return round(len(ga & gb) / u, 3) if u else 0.0


def _loads_list(raw: str | None) -> list[Any]:
    try:
        v = json.loads(raw or "[]")
        return v if isinstance(v, list) else []
    except Exception:
        return []


def _loads_dict(raw: str | None) -> dict[str, Any]:
    try:
        v = json.loads(raw or "{}")
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _record_history(
    conn,
    topic_id: int,
    project_id: int,
    field_name: str,
    old_value: Any,
    new_value: Any,
    reason: str = "",
    changed_by: str = "user",
) -> None:
    if str(old_value) == str(new_value):
        return
    conn.execute(
        """INSERT INTO topic_status_history(topic_id, project_id, field_name, old_value, new_value, reason, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (topic_id, project_id, field_name, str(old_value), str(new_value), reason[:300], changed_by),
    )


def _format_topic_row(conn, row: Any) -> dict[str, Any]:
    d = dict(row)
    tid = d["id"]
    d["topic_id"] = tid
    d["validation_grade"] = _norm_grade(d.get("validation_status"))
    d["production_status_norm"] = _norm_prod_status(d.get("production_status"))
    d["origin_label"] = ORIGIN_LABELS.get(d.get("origin_type") or "", d.get("origin_type") or "未知")
    d["source_evidence_ids"] = _loads_list(d.pop("source_evidence_ids_json", "[]"))
    d["suggested_queries"] = _loads_list(d.pop("suggested_queries_json", "[]"))
    d["missing_evidence"] = _loads_list(d.pop("missing_evidence_json", "[]"))
    d["production_fit"] = _loads_dict(d.pop("production_fit_json", "{}"))
    d["tags"] = _loads_list(d.pop("tags_json", "[]"))
    d["keywords"] = _loads_list(d.pop("keywords_json", "[]"))
    d["task_ids"] = _loads_list(d.pop("task_ids_json", "[]"))
    d["four_signals"] = _loads_dict(d.pop("four_signals_json", "{}"))

    ev_cnt = conn.execute(
        "SELECT COUNT(*) FROM topic_evidence WHERE topic_id = ? AND evidence_type = 'content'",
        (tid,),
    ).fetchone()[0]
    d["content_evidence_count"] = int(ev_cnt)

    tr_cnt = conn.execute(
        """SELECT COUNT(DISTINCT tr.content_id)
           FROM topic_evidence te
           JOIN transcripts tr ON tr.content_id = te.ref_id
           WHERE te.topic_id = ? AND te.evidence_type = 'content'""",
        (tid,),
    ).fetchone()[0]
    d["linked_transcript_count"] = int(tr_cnt)
    return d


def _project_filter_clause(project_id: int | None) -> tuple[str, list[Any]]:
    """FIX-A06: 统一项目分类过滤：None/0=全部项目，-1=未归类(project_id IS NULL)，正整数=具体研究项目。"""
    if project_id is None or int(project_id) == 0:
        return "1=1", []
    if int(project_id) == -1:
        return "project_id IS NULL", []
    return "project_id = ?", [int(project_id)]


def get_project_categories() -> dict[str, Any]:
    """FIX-A06: 从数据库动态读取真实研究项目列表及各项目选题数量（含全部项目与未归类）。"""
    conn = get_conn()
    try:
        projects = [
            dict(r)
            for r in conn.execute("SELECT id, name, target_country FROM projects ORDER BY id ASC").fetchall()
        ]
        rows = conn.execute(
            """SELECT project_id, production_status, COALESCE(is_archived, 0) AS is_archived
               FROM topics
               WHERE merged_into_topic_id IS NULL"""
        ).fetchall()

        total_active = 0
        total_all = 0
        unassigned_active = 0
        unassigned_all = 0
        counts_by_proj: dict[int, dict[str, int]] = {
            int(p["id"]): {"active": 0, "archived": 0, "total": 0} for p in projects
        }

        for r in rows:
            ps = _norm_prod_status(r["production_status"])
            is_arch = bool(r["is_archived"]) or ps == "已归档"
            total_all += 1
            if not is_arch:
                total_active += 1
            pid = r["project_id"]
            if pid is None or int(pid) not in counts_by_proj:
                unassigned_all += 1
                if not is_arch:
                    unassigned_active += 1
            else:
                b = counts_by_proj[int(pid)]
                b["total"] += 1
                if is_arch:
                    b["archived"] += 1
                else:
                    b["active"] += 1

        items = [
            {
                "id": int(p["id"]),
                "name": p["name"],
                "target_country": p.get("target_country") or "",
                "active_count": counts_by_proj[int(p["id"])]["active"],
                "archived_count": counts_by_proj[int(p["id"])]["archived"],
                "total_count": counts_by_proj[int(p["id"])]["total"],
            }
            for p in projects
        ]
        return {
            "ok": True,
            "all_projects": {"id": 0, "name": "全部项目", "active_count": total_active, "total_count": total_all},
            "unassigned": {"id": -1, "name": "未归类", "active_count": unassigned_active, "total_count": unassigned_all},
            "projects": items,
        }
    finally:
        conn.close()


def get_topic_hub_overview(project_id: int | None = None) -> dict[str, Any]:
    """选题总览统计（支持全部项目/单个项目/未归类，返回完整 7 态数量统计）。"""
    conn = get_conn()
    try:
        clause, params = _project_filter_clause(project_id)
        rows = conn.execute(
            f"""SELECT id, validation_status, production_status, is_favorite, script_ready, origin_type,
                       COALESCE(is_archived, 0) AS is_archived
                FROM topics
                WHERE {clause} AND merged_into_topic_id IS NULL""",
            params,
        ).fetchall()
        by_prod = {k: 0 for k in VALID_PRODUCTION_STATUSES}
        by_val = {k: 0 for k in VALID_VALIDATION_STATUSES}
        by_origin: dict[str, int] = {}
        fav_cnt = 0
        script_ready_cnt = 0
        active_total = 0
        for r in rows:
            ps = "已归档" if r["is_archived"] else _norm_prod_status(r["production_status"])
            vs = _norm_grade(r["validation_status"])
            by_prod[ps] = by_prod.get(ps, 0) + 1
            if ps != "已归档":
                active_total += 1
                by_val[vs] = by_val.get(vs, 0) + 1
                ot = r["origin_type"] or "unknown"
                by_origin[ot] = by_origin.get(ot, 0) + 1
                if r["is_favorite"]:
                    fav_cnt += 1
                if r["script_ready"]:
                    script_ready_cnt += 1
        return {
            "ok": True,
            "project_id": project_id,
            "total": active_total,
            "total_with_archived": len(rows),
            "favorite_count": fav_cnt,
            "script_ready_count": script_ready_cnt,
            "by_production_status": by_prod,
            "by_validation_status": by_val,
            "by_origin": by_origin,
        }
    finally:
        conn.close()


def list_topics_hub(
    *,
    project_id: int | None = None,
    q: str = "",
    origin_type: str = "",
    validation_status: str = "",
    production_status: str = "",
    favorite_only: bool = False,
    tag: str = "",
    include_published: bool = True,
    include_archived: bool = False,
    sort_by: str = "created_desc",
    date_from: str = "",
    date_to: str = "",
    limit: int = 100,
) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        clause, params = _project_filter_clause(project_id)
        sql = f"""SELECT t.*, p.name AS project_name,
                         (SELECT MAX(COALESCE(NULLIF(te.manual_captured_at, ''), te.created_at))
                          FROM topic_evidence te WHERE te.topic_id = t.id) AS latest_captured_at
                  FROM topics t
                  LEFT JOIN projects p ON p.id = t.project_id
                  WHERE {clause.replace('project_id', 't.project_id')} AND t.merged_into_topic_id IS NULL"""
        if origin_type:
            sql += " AND t.origin_type = ?"
            params.append(origin_type)
        if favorite_only:
            sql += " AND t.is_favorite = 1"
        if date_from.strip():
            sql += " AND t.created_at IS NOT NULL AND substr(t.created_at, 1, 10) >= ?"
            params.append(date_from.strip()[:10])
        if date_to.strip():
            sql += " AND t.created_at IS NOT NULL AND substr(t.created_at, 1, 10) <= ?"
            params.append(date_to.strip()[:10])
        if q.strip():
            like = f"%{q.strip()}%"
            sql += " AND (t.topic_title LIKE ? OR t.research_question LIKE ? OR t.angle LIKE ? OR t.keywords_json LIKE ? OR t.tags_json LIKE ?)"
            params.extend([like, like, like, like, like])

        order_map = {
            "created_desc": "ORDER BY t.is_favorite DESC, (t.created_at IS NULL) ASC, t.created_at DESC, t.id DESC",
            "created_asc": "ORDER BY t.is_favorite DESC, (t.created_at IS NULL) ASC, t.created_at ASC, t.id ASC",
            "updated_desc": "ORDER BY t.is_favorite DESC, (t.updated_at IS NULL) ASC, t.updated_at DESC, t.id DESC",
            "captured_desc": "ORDER BY t.is_favorite DESC, (latest_captured_at IS NULL) ASC, latest_captured_at DESC, t.id DESC",
        }
        order_sql = order_map.get(sort_by or "created_desc", order_map["created_desc"])
        sql += f" {order_sql} LIMIT ?"
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        out = []
        want_archived = include_archived or production_status == "已归档"
        for r in rows:
            item = _format_topic_row(conn, r)
            item["latest_captured_at"] = r["latest_captured_at"] or None
            if item.get("is_archived"):
                item["production_status_norm"] = "已归档"
            if not want_archived and item["production_status_norm"] == "已归档":
                continue
            if validation_status and item["validation_grade"] != validation_status:
                continue
            if production_status and item["production_status_norm"] != production_status:
                continue
            if not include_published and item["production_status_norm"] == "已发布":
                continue
            if tag and tag not in item["tags"]:
                continue
            out.append(item)
        return out
    finally:
        conn.close()


def get_topic_original_draft(topic_id: int) -> dict[str, Any]:
    """GCW-WORKSPACE-05 / FIX-01: 读取选题级原创文案草稿（含单调递增 revision 修订号）。"""
    conn = get_conn()
    try:
        key = f"topic_original_draft_{int(topic_id)}"
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        if not row or not row["value"]:
            return {
                "ok": True,
                "topic_id": topic_id,
                "draft": {
                    "title": "",
                    "content": "",
                    "extra_requirements": "",
                    "skill_id": "",
                    "engine_id": "",
                    "model_id": "",
                    "revision": 0,
                    "updated_at": None,
                },
            }
        try:
            data = json.loads(row["value"])
        except Exception:
            data = {"title": "", "content": str(row["value"]), "revision": 0, "updated_at": None}
        if "revision" not in data or not isinstance(data.get("revision"), int):
            data["revision"] = 1
        return {"ok": True, "topic_id": topic_id, "draft": data}
    finally:
        conn.close()


def save_topic_original_draft(topic_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    """GCW-WORKSPACE-05 / FIX-10: BEGIN IMMEDIATE 原子事务校验 revision，严格拒绝重复或过期修订号覆盖。"""
    conn = get_conn()
    try:
        from datetime import datetime, timezone
        key = f"topic_original_draft_{int(topic_id)}"
        conn.execute("BEGIN IMMEDIATE")
        existing_rev = 0
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        if row and row["value"]:
            try:
                old_data = json.loads(row["value"])
                existing_rev = int(old_data.get("revision") or 0)
            except Exception:
                existing_rev = 0

        client_rev = payload.get("client_rev")
        if client_rev is not None:
            try:
                c_rev = int(client_rev)
            except Exception:
                c_rev = 0
            if c_rev <= existing_rev:
                conn.rollback()
                return {
                    "ok": False,
                    "stale_rejected": True,
                    "current_revision": existing_rev,
                    "error": f"检测到重复或过期草稿保存请求（client_rev={c_rev} <= current={existing_rev}），已拒绝覆盖最新草稿",
                }
            next_rev = c_rev
        else:
            next_rev = existing_rev + 1

        now_iso = datetime.now(timezone.utc).isoformat()
        draft = {
            "title": str(payload.get("title") or "")[:200],
            "content": str(payload.get("content") or ""),
            "extra_requirements": str(payload.get("extra_requirements") or "")[:2000],
            "skill_id": str(payload.get("skill_id") or "")[:120],
            "engine_id": str(payload.get("engine_id") or "")[:120],
            "model_id": str(payload.get("model_id") or "")[:160],
            "revision": next_rev,
            "updated_at": now_iso,
        }
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(draft, ensure_ascii=False)),
        )
        conn.commit()
        return {"ok": True, "topic_id": topic_id, "draft": draft}
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return {"ok": False, "error": f"保存草稿失败：{e}"}
    finally:
        conn.close()


def _parse_iso_ts(raw: Any) -> float | None:
    """尝试解析可验证的发布时间；无法解析返回 None，绝不伪造时间顺序。"""
    if not raw:
        return None
    s = str(raw).strip()
    if not s or len(s) < 8:
        return None
    from datetime import datetime
    try:
        norm = s.replace("Z", "+00:00")
        if len(norm) == 10 and norm[4] == "-" and norm[7] == "-":
            return datetime.fromisoformat(norm + "T00:00:00+00:00").timestamp()
        if " " in norm and "T" not in norm:
            norm = norm.replace(" ", "T")
        return datetime.fromisoformat(norm).timestamp()
    except Exception:
        return None


def get_content_metrics_detail(content_id: int) -> dict[str, Any]:
    """GCW-WORKSPACE-03 / FIX-03: 返回当前作品真实数据面板（异常爆款倍数严格排除当前作品、去重、要求发布前可靠历史样本 >=3）。"""
    conn = get_conn()
    try:
        row = conn.execute(
            """SELECT c.*, cr.name AS creator_name, cr.follower_count AS creator_followers
               FROM contents c
               LEFT JOIN creators cr ON cr.id = c.creator_id
               WHERE c.id = ?""",
            (content_id,),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到作品 #{content_id}"}
        d = dict(row)
        views = d.get("view_count")
        likes = d.get("like_count")
        comments = d.get("comment_count")
        favorites = d.get("favorite_count")
        shares = d.get("share_count")
        followers = d.get("author_follower_count") if d.get("author_follower_count") is not None else d.get("creator_followers")

        # 互动率口径：((点赞 + 评论 + 收藏 + 分享) / 播放量) × 100%，缺播放量或无任何互动数据时为 NULL
        used_parts = []
        inter_sum = 0
        for label, val in [("点赞", likes), ("评论", comments), ("收藏", favorites), ("分享", shares)]:
            if val is not None and int(val) >= 0:
                used_parts.append(label)
                inter_sum += int(val)
        if views is not None and int(views) > 0 and used_parts:
            engagement_rate = round((inter_sum / int(views)) * 100.0, 2)
            engagement_formula = f"({'+'.join(used_parts)}) / 播放量 × 100%"
        else:
            engagement_rate = None
            engagement_formula = "缺少有效播放量或互动指标，暂不计算互动率"

        # FIX-03 异常爆款倍数：
        # 1) 严格排除当前 content_id；2) 按 platform_item_id 去重；3) 仅同作者同平台有效播放量作品；
        # 4) 必须可验证发布时间且早于当前作品发布时间；5) 至少 3 条其他历史作品；6) 明确标注人工收录样本限制
        outlier_multiple = None
        outlier_basis = "未知（缺少同作者发布前可靠历史作品基准，需 ≥3 条其他作品）"
        creator_id = d.get("creator_id")
        platform = (d.get("platform") or "").strip().lower()
        cur_item_id = (d.get("platform_item_id") or "").strip()
        cur_pub_ts = _parse_iso_ts(d.get("published_at"))

        if not creator_id or views is None or int(views) <= 0:
            outlier_basis = "未知（缺少有效作者归属或播放量）"
        elif cur_pub_ts is None:
            outlier_basis = "未知（当前作品原始发布时间无法验证，不冒充发布前历史基准）"
        else:
            hist_rows = conn.execute(
                """SELECT id, platform_item_id, view_count, published_at, data_source
                   FROM contents
                   WHERE creator_id = ? AND lower(platform) = ? AND id != ?
                     AND view_count IS NOT NULL AND view_count > 0""",
                (creator_id, platform, content_id),
            ).fetchall()
            seen_item_ids: set[str] = {cur_item_id} if cur_item_id else set()
            valid_prior_views: list[int] = []
            manual_only = True
            for hr in hist_rows:
                hid = (hr["platform_item_id"] or "").strip()
                if hid and hid in seen_item_ids:
                    continue
                hts = _parse_iso_ts(hr["published_at"])
                if hts is None or hts >= cur_pub_ts:
                    continue
                if hid:
                    seen_item_ids.add(hid)
                valid_prior_views.append(int(hr["view_count"]))
                if (hr["data_source"] or "") not in ("electron_readonly_capture", "manual", ""):
                    manual_only = False

            if len(valid_prior_views) >= 3:
                avg_views = sum(valid_prior_views) / len(valid_prior_views)
                if avg_views > 0:
                    outlier_multiple = round(int(views) / avg_views, 2)
                    scope_note = "仅基于本库人工收录样本，代表性有限" if manual_only else "基于本库同作者历史样本"
                    outlier_basis = f"当前播放量 / 发布前 {len(valid_prior_views)} 条其他历史作品均值（{int(round(avg_views)):,}；{scope_note}）"
            else:
                outlier_basis = f"未知（该作者发布前可验证有效其他作品仅 {len(valid_prior_views)} 条，需 ≥3 条）"

        return {
            "ok": True,
            "content_id": int(d["id"]),
            "platform": platform,
            "platform_item_id": cur_item_id,
            "title": d.get("title") or "",
            "url": d.get("url") or "",
            "author_name": d.get("author_name") or d.get("creator_name") or "",
            "author_url": d.get("author_url") or "",
            "duration_sec": d.get("duration_sec"),
            "published_at": d.get("published_at") or None,
            "manual_captured_at": d.get("manual_captured_at") or None,
            "collected_at": d.get("collected_at") or None,
            "metrics": {
                "view_count": views,
                "like_count": likes,
                "comment_count": comments,
                "favorite_count": favorites,
                "share_count": shares,
                "author_follower_count": followers,
                "engagement_rate": engagement_rate,
                "engagement_formula": engagement_formula,
                "outlier_multiple": outlier_multiple,
                "outlier_basis": outlier_basis,
            },
        }
    finally:
        conn.close()


def refresh_content_metrics(content_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    """GCW-WORKSPACE-03 / FIX-02: 刷新前强制校验平台与平台作品 ID，绝不允许跨视频错写或以 0 覆盖有效数据。"""
    from backend.services.video_capture_service import parse_human_count
    from datetime import datetime, timezone

    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM contents WHERE id=?", (content_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到作品 #{content_id}"}
        cur = dict(row)

        # FIX-02 后端强身份校验：校验平台与真实平台作品 ID
        db_platform = (cur.get("platform") or "").strip().lower()
        db_item_id = (cur.get("platform_item_id") or "").strip()
        exp_platform = (payload.get("expected_platform") or "").strip().lower()
        exp_item_id = (payload.get("expected_platform_item_id") or "").strip()

        if not exp_platform or not exp_item_id:
            return {
                "ok": False,
                "identity_mismatch": True,
                "error": "刷新拒绝：缺少播放器当前作品的平台或真实作品 ID，无法核验身份（已保留原有有效数据）",
            }
        if db_platform and exp_platform != db_platform:
            return {
                "ok": False,
                "identity_mismatch": True,
                "error": f"刷新拒绝：播放器当前平台（{exp_platform}）与目标作品平台（{db_platform}）不一致，禁止跨视频写入",
            }
        if db_item_id and exp_item_id != db_item_id:
            return {
                "ok": False,
                "identity_mismatch": True,
                "error": f"刷新拒绝：播放器当前作品 ID（{exp_item_id}）与目标作品 ID（{db_item_id}）不一致，禁止将其他视频数据更新至原作品",
            }

        updates: dict[str, Any] = {}
        for field in ("view_count", "like_count", "comment_count", "favorite_count", "share_count", "author_follower_count"):
            raw = payload.get(field)
            parsed = parse_human_count(raw)
            if parsed is not None:
                if parsed == 0 and (cur.get(field) or 0) > 0:
                    continue
                updates[field] = parsed
        if payload.get("duration_sec") is not None:
            try:
                ds = int(payload["duration_sec"])
                if ds > 0:
                    updates["duration_sec"] = ds
            except Exception:
                pass
        if payload.get("author_name") and str(payload["author_name"]).strip():
            updates["author_name"] = str(payload["author_name"]).strip()
        if payload.get("published_at") and str(payload["published_at"]).strip():
            updates["published_at"] = str(payload["published_at"]).strip()

        if not updates:
            return {"ok": False, "error": "未能从当前页面获取到新的有效数据，已保留上一次成功采集的数据与时间"}

        updates["collected_at"] = datetime.now(timezone.utc).isoformat()
        set_sql = ", ".join(f"{k}=?" for k in updates.keys())
        conn.execute(f"UPDATE contents SET {set_sql} WHERE id=?", (*updates.values(), content_id))
        conn.commit()
    finally:
        conn.close()
    res = get_content_metrics_detail(content_id)
    res["refreshed"] = True
    return res


def create_manual_topic(project_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    """人工直接创建原创选题（不强制先 AI 搜索；未验证允许直接进入待制作，但验证等级严格保持 U）。"""
    title = (payload.get("topic_title") or "").strip()
    if not title:
        return {"ok": False, "error": "选题标题不能为空"}
    origin_type = payload.get("origin_type") or "manual_original"
    if origin_type not in ORIGIN_LABELS:
        origin_type = "manual_original"
    prod_status = _norm_prod_status(payload.get("production_status") or "待研究")
    keywords = [str(k).strip() for k in (payload.get("keywords") or []) if str(k).strip()]
    tags = [str(t).strip() for t in (payload.get("tags") or []) if str(t).strip()]
    suggested_queries = [str(q).strip() for q in (payload.get("suggested_queries") or keywords or [title[:40]]) if str(q).strip()]

    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO topics(
                   project_id, batch_id, task_id, topic_title, research_question, angle,
                   target_audience, tags_json, keywords_json, task_ids_json,
                   origin_type, discovery_reason, source_evidence_ids_json,
                   suggested_queries_json, missing_evidence_json,
                   validation_status, validation_rule_version, validation_reason,
                   evidence_coverage_pct, four_signals_json,
                   production_status, is_favorite, recommendation,
                   fact_check_status, differentiation_notes, user_notes, script_ready, round_no
               ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, '[]', ?, ?, '[]', ?, ?, 'U', ?, ?, 0.0, ?, ?, ?, '原创试验', ?, ?, ?, ?, 1)""",
            (
                project_id,
                title[:160],
                (payload.get("research_question") or "")[:400],
                (payload.get("angle") or "")[:400],
                (payload.get("target_audience") or "")[:200],
                json.dumps(tags, ensure_ascii=False),
                json.dumps(keywords, ensure_ascii=False),
                origin_type,
                (payload.get("discovery_reason") or "用户人工直接创建的原创选题")[:400],
                json.dumps(suggested_queries, ensure_ascii=False),
                json.dumps(["尚未执行市场真实检索验证，保持 U（未验证）"], ensure_ascii=False),
                mv_svc.RULE_VERSION,
                "人工原创选题，尚未经真实市场检索验证，保持 U（未验证）；允许直接进入待制作",
                json.dumps(
                    {
                        "market_attention": {"status": "unverified", "summary": "人工新建选题，尚未采集市场作品"},
                        "user_demand": {"status": "unverified", "summary": "尚无真实评论证据"},
                        "purchase_intent": {"status": "unverified", "summary": "尚无购买意愿信号"},
                        "commercial_revenue": {"status": "unverified", "summary": "无真实商业收益证据"},
                    },
                    ensure_ascii=False,
                ),
                prod_status,
                1 if payload.get("is_favorite") else 0,
                (payload.get("fact_check_status") or "待核实")[:40],
                (payload.get("differentiation_notes") or "")[:500],
                (payload.get("user_notes") or "")[:800],
                1 if payload.get("script_ready") else 0,
            ),
        )
        tid = cur.lastrowid
        _record_history(conn, tid, project_id, "production_status", "", prod_status, "人工创建原创选题（市场验证等级保持 U）")
        # 若同时传入了已归属本项目的 content_ids / comment_ids，校验后在同一事务内原子建立结构化证据关联
        content_ids = payload.get("content_ids") or []
        comment_ids = payload.get("comment_ids") or []
        if content_ids:
            chk = mv_svc.validate_evidence_ids(conn, project_id, content_ids, [])
            for cid in chk["valid_content_ids"]:
                c_row = conn.execute("SELECT url, title FROM contents WHERE id = ?", (cid,)).fetchone()
                conn.execute(
                    """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
                       VALUES (?, ?, 'content', ?, ?, ?, 'manual_link')""",
                    (tid, project_id, cid, c_row["url"] if c_row else "", (c_row["title"] or "")[:180] if c_row else ""),
                )
        if comment_ids:
            for raw_cmid in comment_ids:
                try:
                    cmid = int(raw_cmid)
                except Exception:
                    continue
                cm_row = conn.execute(
                    "SELECT cm.id, cm.text, cm.content_id, c.url FROM comments cm JOIN contents c ON c.id = cm.content_id WHERE cm.id = ?",
                    (cmid,),
                ).fetchone()
                if not cm_row:
                    continue
                conn.execute(
                    """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
                       VALUES (?, ?, 'comment', ?, ?, ?, 'comment_discovery')""",
                    (tid, project_id, cmid, cm_row["url"] or "", (cm_row["text"] or "")[:240]),
                )
        conn.commit()
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (tid,)).fetchone()
        return {"ok": True, "topic": _format_topic_row(conn, row)}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def get_topic_detail(topic_id: int, project_id: int | None = None) -> dict[str, Any]:
    """返回完整选题档案：发现路径、多对多证据、真实作品/作者/评论/文案、验证原因、二轮结果、父子选题与状态历史。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到选题：{topic_id}"}
        if project_id is not None and int(row["project_id"]) != int(project_id):
            return {"ok": False, "error": "跨项目访问被拒绝：该选题不属于当前项目"}

        topic = _format_topic_row(conn, row)
        pid = int(row["project_id"])

        # 1. 关联作品（仅读取当前项目允许的作品证据，完整透传一键收录字段）
        ev_rows = conn.execute(
            """SELECT te.id AS evidence_id, te.ref_id AS content_id, te.provenance, te.created_at AS linked_at,
                      te.research_tags_json AS ev_tags_json, te.capture_reason AS ev_capture_reason,
                      te.manual_captured_at AS ev_captured_at,
                      c.platform, c.platform_item_id, c.content_type, c.url, c.title, c.thumbnail_url,
                      c.published_at, c.duration_sec,
                      c.view_count, c.like_count, c.comment_count, c.favorite_count, c.share_count,
                      c.engagement_rate, c.outlier_score, c.views_to_followers,
                      c.author_name, c.author_url, c.author_follower_count,
                      c.collect_reason, c.data_source, c.search_keyword, c.research_tags_json AS c_tags_json,
                      c.collected_at, c.manual_captured_at, c.original_share_url, c.url_edit_history_json,
                      cr.id AS creator_id, cr.name AS creator_name, cr.follower_count, cr.profile_url
               FROM topic_evidence te
               JOIN contents c ON c.id = te.ref_id
               LEFT JOIN creators cr ON cr.id = c.creator_id
               WHERE te.topic_id = ? AND te.project_id = ? AND te.evidence_type = 'content'
               ORDER BY COALESCE(c.view_count, -1) DESC, te.id ASC""",
            (topic_id, pid),
        ).fetchall()
        contents = []
        for r in ev_rows:
            d = dict(r)
            ev_tags = json.loads(d.pop("ev_tags_json", None) or "[]")
            c_tags = json.loads(d.pop("c_tags_json", None) or "[]")
            d["research_tags"] = ev_tags if ev_tags else c_tags
            d["capture_reason"] = d.pop("ev_capture_reason", None) or d.get("collect_reason") or ""
            d["manual_captured_at"] = d.pop("ev_captured_at", None) or d.get("manual_captured_at") or d.get("linked_at")
            d["url_edit_history"] = json.loads(d.pop("url_edit_history_json", None) or "[]")
            d["creator_name"] = d.get("creator_name") or d.get("author_name") or ""
            d["profile_url"] = d.get("profile_url") or d.get("author_url") or ""
            d["follower_count"] = d.get("follower_count") if d.get("follower_count") is not None else d.get("author_follower_count")
            # 查询该作品在当前项目关联的全部选题 ID（用于一视频多选题展示与调整）
            d["linked_topic_ids"] = [
                int(x["topic_id"])
                for x in conn.execute(
                    "SELECT DISTINCT topic_id FROM topic_evidence WHERE project_id = ? AND evidence_type = 'content' AND ref_id = ?",
                    (pid, d["content_id"]),
                ).fetchall()
            ]
            contents.append(d)
        cids = [c["content_id"] for c in contents]

        # 2. 参考作者去重列表
        creators_map: dict[int, dict[str, Any]] = {}
        for c in contents:
            crid = c.get("creator_id")
            if crid and crid not in creators_map:
                creators_map[crid] = {
                    "creator_id": crid,
                    "name": c.get("creator_name") or "未知",
                    "platform": c.get("platform"),
                    "follower_count": c.get("follower_count"),
                    "profile_url": c.get("profile_url") or "",
                }
        creators = list(creators_map.values())

        # 3. 关联真实评论与已有文案（文案工坊联动）
        comments: list[dict[str, Any]] = []
        transcripts: list[dict[str, Any]] = []
        if cids:
            ph = ",".join("?" for _ in cids)
            comments = [
                dict(r)
                for r in conn.execute(
                    f"""SELECT id, content_id, author, text, like_count, is_question
                        FROM comments WHERE content_id IN ({ph})
                        ORDER BY like_count DESC, id ASC LIMIT 25""",
                    cids,
                ).fetchall()
            ]
            transcripts = [
                dict(r)
                for r in conn.execute(
                    f"""SELECT tr.id AS transcript_id, tr.content_id, c.title AS content_title,
                               tr.language, tr.extract_method, length(coalesce(tr.raw_text,'')) AS char_count,
                               substr(coalesce(tr.raw_text,''), 1, 220) AS snippet, tr.updated_at
                        FROM transcripts tr
                        JOIN contents c ON c.id = tr.content_id
                        WHERE tr.content_id IN ({ph})
                        ORDER BY tr.id DESC""",
                    cids,
                ).fetchall()
            ]

        # 4. 关联搜索批次与研究任务
        batch_info = None
        if row["batch_id"]:
            br = conn.execute("SELECT id, title, status, total_results, created_at FROM search_batch_runs WHERE id = ?", (row["batch_id"],)).fetchone()
            if br:
                batch_info = dict(br)
        second_round_batch = None
        if row["second_round_batch_id"]:
            sbr = conn.execute("SELECT id, title, status, total_results, created_at FROM search_batch_runs WHERE id = ?", (row["second_round_batch_id"],)).fetchone()
            if sbr:
                second_round_batch = dict(sbr)

        t_ids = list(topic["task_ids"])
        if row["task_id"] and row["task_id"] not in t_ids:
            t_ids.append(row["task_id"])
        research_tasks = []
        if t_ids:
            ph = ",".join("?" for _ in t_ids)
            research_tasks = [
                dict(r)
                for r in conn.execute(
                    f"SELECT id, seed_keyword, entity_type, research_goal, status, created_at FROM research_tasks WHERE id IN ({ph})",
                    t_ids,
                ).fetchall()
            ]

        # 5. 最新市场验证记录（优先查 topic 专属二轮验证，再查所属批次 V2 验证）
        mv_row = conn.execute(
            "SELECT * FROM market_validations WHERE topic_id = ? ORDER BY id DESC LIMIT 1",
            (topic_id,),
        ).fetchone()
        if not mv_row and row["batch_id"]:
            mv_row = conn.execute(
                "SELECT * FROM market_validations WHERE batch_id = ? AND topic_id IS NULL ORDER BY id DESC LIMIT 1",
                (row["batch_id"],),
            ).fetchone()
        latest_validation = None
        if mv_row:
            vd = dict(mv_row)
            for jf in ("platforms_json", "eight_dims_json", "four_signals_json", "production_fit_json", "missing_evidence_json", "evidence_ids_json", "llm_meta_json"):
                vd[jf.replace("_json", "")] = json.loads(vd.pop(jf) or ("{}" if any(k in jf for k in ("dims", "signals", "fit", "meta")) else "[]"))
            latest_validation = vd

        # 6. 父选题与衍生选题（关联列表，不搞复杂知识图谱）
        parent_topics = [
            dict(r)
            for r in conn.execute(
                """SELECT tr.id AS relation_id, tr.relation_type, tr.parent_keyword, tr.reason,
                          t.id AS topic_id, t.topic_title, t.validation_status, t.production_status
                   FROM topic_relations tr
                   LEFT JOIN topics t ON t.id = tr.parent_topic_id
                   WHERE tr.child_topic_id = ? AND tr.project_id = ? AND (tr.parent_topic_id IS NULL OR tr.parent_topic_id != ?)
                   ORDER BY tr.id DESC""",
                (topic_id, pid, topic_id),
            ).fetchall()
        ]
        child_topics = [
            dict(r)
            for r in conn.execute(
                """SELECT tr.id AS relation_id, tr.relation_type, tr.parent_keyword, tr.reason,
                          t.id AS topic_id, t.topic_title, t.validation_status, t.production_status
                   FROM topic_relations tr
                   JOIN topics t ON t.id = tr.child_topic_id
                   WHERE tr.parent_topic_id = ? AND tr.project_id = ? AND tr.child_topic_id != ?
                   ORDER BY tr.id DESC""",
                (topic_id, pid, topic_id),
            ).fetchall()
        ]

        # 7. 状态变更历史与合并日志
        status_history = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM topic_status_history WHERE topic_id = ? ORDER BY id DESC LIMIT 30",
                (topic_id,),
            ).fetchall()
        ]
        merge_logs = [
            dict(r)
            for r in conn.execute(
                "SELECT id, target_topic_id, source_topic_id, merged_evidence_count, reason, is_restored, created_at FROM topic_merge_logs WHERE target_topic_id = ? OR source_topic_id = ? ORDER BY id DESC",
                (topic_id, topic_id),
            ).fetchall()
        ]

        return {
            "ok": True,
            "topic": topic,
            "discovery_path": {
                "origin_type": topic["origin_type"],
                "origin_label": topic["origin_label"],
                "discovery_reason": topic["discovery_reason"],
                "keywords": topic["keywords"],
                "research_tasks": research_tasks,
                "batch_info": batch_info,
                "second_round_batch": second_round_batch,
            },
            "contents": contents,
            "creators": creators,
            "comments": comments,
            "transcripts": transcripts,
            "latest_validation": latest_validation,
            "parent_topics": parent_topics,
            "child_topics": child_topics,
            "status_history": status_history,
            "merge_logs": merge_logs,
        }
    finally:
        conn.close()


def update_topic_archive(topic_id: int, project_id: int | None, patch: dict[str, Any]) -> dict[str, Any]:
    """更新选题档案：严格分离制作状态、项目归属、收藏与市场验证状态，记录全部变更历史。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到选题：{topic_id}"}
        cur_pid = row["project_id"]
        if project_id is not None and int(project_id) > 0 and cur_pid is not None and int(cur_pid) != int(project_id):
            return {"ok": False, "error": "跨项目修改被拒绝：该选题不属于当前项目"}
        hist_pid = int(cur_pid or (project_id if project_id and int(project_id) > 0 else 1))

        reason = (patch.get("change_reason") or "").strip()
        updates: list[str] = []
        params: list[Any] = []

        # FIX-A06: 允许人工调整选题归属项目（支持调整至具体项目或 -1 设为未归类）
        if "target_project_id" in patch and patch["target_project_id"] is not None:
            raw_tp = int(patch["target_project_id"])
            new_pid = None if raw_tp <= 0 else raw_tp
            if new_pid is not None:
                p_chk = conn.execute("SELECT id, name FROM projects WHERE id = ?", (new_pid,)).fetchone()
                if not p_chk:
                    return {"ok": False, "error": f"目标项目不存在：{new_pid}"}
            updates.append("project_id = ?")
            params.append(new_pid)
            if new_pid is not None:
                conn.execute("UPDATE topic_evidence SET project_id = ? WHERE topic_id = ?", (new_pid, topic_id))
            _record_history(conn, topic_id, hist_pid, "project_id", cur_pid or "未归类", new_pid or "未归类", reason or "人工调整选题归属项目")

        # FIX-A07: 制作状态变更（绝不改变市场验证等级，同步归档标记）
        if "production_status" in patch and patch["production_status"] is not None:
            new_ps = _norm_prod_status(patch["production_status"])
            old_ps = "已归档" if row["is_archived"] else _norm_prod_status(row["production_status"])
            updates.append("production_status = ?")
            params.append(new_ps)
            updates.append("is_archived = ?")
            params.append(1 if new_ps == "已归档" else 0)
            _record_history(conn, topic_id, hist_pid, "production_status", old_ps, new_ps, reason or "用户更新创作状态")

        # 收藏作为独立属性（绝不改变市场验证等级！）
        if "is_favorite" in patch and patch["is_favorite"] is not None:
            new_fav = 1 if patch["is_favorite"] else 0
            updates.append("is_favorite = ?")
            params.append(new_fav)
            _record_history(conn, topic_id, project_id, "is_favorite", row["is_favorite"], new_fav, reason or "用户切换收藏")

        # 市场验证状态仅允许用户标记为「待复核」，禁止人工伪造为 A/S
        if "validation_status" in patch and patch["validation_status"] is not None:
            req_vs = str(patch["validation_status"]).strip()
            if req_vs == "待复核":
                old_vs = _norm_grade(row["validation_status"])
                updates.append("validation_status = ?")
                params.append("待复核")
                _record_history(conn, topic_id, project_id, "validation_status", old_vs, "待复核", reason or "用户标记待复核")
            elif req_vs != _norm_grade(row["validation_status"]):
                return {"ok": False, "error": "禁止人工直接篡改市场验证等级（仅允许标记「待复核」或通过真实搜索重新验证）"}

        for field, col in [
            ("topic_title", "topic_title"),
            ("research_question", "research_question"),
            ("angle", "angle"),
            ("target_audience", "target_audience"),
            ("fact_check_status", "fact_check_status"),
            ("differentiation_notes", "differentiation_notes"),
            ("user_notes", "user_notes"),
            ("user_override_recommendation", "user_override_recommendation"),
        ]:
            if field in patch and patch[field] is not None:
                val = str(patch[field]).strip()
                updates.append(f"{col} = ?")
                params.append(val)
                if field == "fact_check_status":
                    _record_history(conn, topic_id, project_id, "fact_check_status", row["fact_check_status"], val, reason)

        if "script_ready" in patch and patch["script_ready"] is not None:
            sr = 1 if patch["script_ready"] else 0
            updates.append("script_ready = ?")
            params.append(sr)
            _record_history(conn, topic_id, project_id, "script_ready", row["script_ready"], sr, reason)

        for field, col in [
            ("tags", "tags_json"),
            ("keywords", "keywords_json"),
            ("suggested_queries", "suggested_queries_json"),
            ("production_fit", "production_fit_json"),
        ]:
            if field in patch and patch[field] is not None:
                updates.append(f"{col} = ?")
                params.append(json.dumps(patch[field], ensure_ascii=False))

        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(topic_id)
            conn.execute(f"UPDATE topics SET {', '.join(updates)} WHERE id = ?", params)
            conn.commit()

        updated = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        return {"ok": True, "topic": _format_topic_row(conn, updated)}
    finally:
        conn.close()


def link_content_to_topic(topic_id: int, project_id: int, content_id: int, provenance: str = "manual_link") -> dict[str, Any]:
    """多对多关联作品到选题（严格校验跨项目隔离，不覆盖原始证据）。"""
    conn = get_conn()
    try:
        tp = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not tp or int(tp["project_id"]) != int(project_id):
            return {"ok": False, "error": "选题不存在或不属于当前项目"}
        chk = mv_svc.validate_evidence_ids(conn, project_id, [content_id], [])
        if not chk["valid_content_ids"]:
            return {"ok": False, "error": "证据校验未通过：该作品不存在或不属于当前项目（跨项目隔离拦截）", "audit": chk}
        c_row = conn.execute("SELECT url, title FROM contents WHERE id = ?", (content_id,)).fetchone()
        conn.execute(
            """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
               VALUES (?, ?, 'content', ?, ?, ?, ?)""",
            (topic_id, project_id, content_id, c_row["url"] or "", (c_row["title"] or "")[:180], provenance),
        )
        ev_ids = _loads_list(tp["source_evidence_ids_json"])
        if content_id not in ev_ids:
            ev_ids.append(content_id)
            conn.execute(
                "UPDATE topics SET source_evidence_ids_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (json.dumps(ev_ids, ensure_ascii=False), topic_id),
            )
        conn.commit()
        return {"ok": True, "topic_id": topic_id, "content_id": content_id}
    finally:
        conn.close()


def unlink_content_from_topic(topic_id: int, project_id: int, content_id: int) -> dict[str, Any]:
    """解除某选题与某作品的关联：仅删除该选题的 topic_evidence 记录，绝不删除作品/作者/评论或其他选题的关联。"""
    conn = get_conn()
    try:
        tp = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not tp or int(tp["project_id"]) != int(project_id):
            return {"ok": False, "error": "选题不存在或不属于当前项目"}
        conn.execute(
            "DELETE FROM topic_evidence WHERE topic_id = ? AND project_id = ? AND evidence_type = 'content' AND ref_id = ?",
            (topic_id, project_id, content_id),
        )
        ev_ids = [x for x in _loads_list(tp["source_evidence_ids_json"]) if x != content_id]
        conn.execute(
            "UPDATE topics SET source_evidence_ids_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (json.dumps(ev_ids, ensure_ascii=False), topic_id),
        )
        conn.commit()
        return {"ok": True, "topic_id": topic_id, "unlinked_content_id": content_id}
    finally:
        conn.close()


def link_topic_relation(
    project_id: int,
    parent_topic_id: int,
    child_topic_id: int,
    relation_type: str = "derived",
    reason: str = "",
) -> dict[str, Any]:
    conn = get_conn()
    try:
        p = conn.execute("SELECT id, project_id, topic_title FROM topics WHERE id = ?", (parent_topic_id,)).fetchone()
        c = conn.execute("SELECT id, project_id FROM topics WHERE id = ?", (child_topic_id,)).fetchone()
        if not p or not c or int(p["project_id"]) != project_id or int(c["project_id"]) != project_id:
            return {"ok": False, "error": "父子选题必须同时存在且归属当前项目"}
        conn.execute(
            """INSERT INTO topic_relations(project_id, parent_topic_id, child_topic_id, relation_type, parent_keyword, reason)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (project_id, parent_topic_id, child_topic_id, relation_type, p["topic_title"][:100], reason[:300]),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def detect_similar_topics(project_id: int, topic_id: int | None = None, threshold: float = 0.28) -> list[dict[str, Any]]:
    """检测同项目相似选题对（仅提示，绝不自动删除）。"""
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT id, topic_title, angle, validation_status, production_status, source_evidence_ids_json
               FROM topics
               WHERE project_id = ? AND merged_into_topic_id IS NULL AND COALESCE(is_archived, 0) = 0
               ORDER BY id ASC""",
            (project_id,),
        ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            ev = set(
                x["ref_id"]
                for x in conn.execute(
                    "SELECT ref_id FROM topic_evidence WHERE topic_id = ? AND evidence_type = 'content'",
                    (d["id"],),
                ).fetchall()
            )
            d["ev_set"] = ev
            items.append(d)

        pairs = []
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, b = items[i], items[j]
                if topic_id is not None and a["id"] != topic_id and b["id"] != topic_id:
                    continue
                t_sim = _jaccard3(a["topic_title"], b["topic_title"])
                shared_ev = sorted(a["ev_set"] & b["ev_set"])
                ev_union = len(a["ev_set"] | b["ev_set"])
                ev_sim = round(len(shared_ev) / ev_union, 3) if ev_union else 0.0
                combined = round(max(t_sim, ev_sim * 0.8), 3)
                if t_sim >= threshold or (len(shared_ev) >= 2 and ev_sim >= 0.5):
                    pairs.append({
                        "topic_a_id": a["id"],
                        "topic_a_title": a["topic_title"],
                        "topic_b_id": b["id"],
                        "topic_b_title": b["topic_title"],
                        "title_similarity": t_sim,
                        "evidence_overlap_ratio": ev_sim,
                        "shared_evidence_ids": shared_ev,
                        "combined_score": combined,
                    })
        pairs.sort(key=lambda x: x["combined_score"], reverse=True)
        return pairs
    finally:
        conn.close()


def merge_topics(project_id: int, target_topic_id: int, source_topic_id: int, reason: str = "用户确认合并相似选题") -> dict[str, Any]:
    """无损合并相似选题：保留全部证据/关键词/任务/父子关系，软归档源选题并留存可恢复快照日志。"""
    if target_topic_id == source_topic_id:
        return {"ok": False, "error": "目标选题与源选题不能相同"}
    conn = get_conn()
    try:
        tgt = conn.execute("SELECT * FROM topics WHERE id = ?", (target_topic_id,)).fetchone()
        src = conn.execute("SELECT * FROM topics WHERE id = ?", (source_topic_id,)).fetchone()
        if not tgt or not src:
            return {"ok": False, "error": "目标或源选题不存在"}
        if int(tgt["project_id"]) != project_id or int(src["project_id"]) != project_id:
            return {"ok": False, "error": "跨项目合并不被允许"}

        # 1. 保存完整源选题快照用于可恢复
        src_ev_rows = [dict(r) for r in conn.execute("SELECT * FROM topic_evidence WHERE topic_id = ?", (source_topic_id,)).fetchall()]
        src_rel_rows = [dict(r) for r in conn.execute("SELECT * FROM topic_relations WHERE parent_topic_id = ? OR child_topic_id = ?", (source_topic_id, source_topic_id)).fetchall()]
        snapshot = {
            "topic": dict(src),
            "evidences": src_ev_rows,
            "relations": src_rel_rows,
        }

        # 2. 合并 topic_evidence（无损去重迁移）
        merged_ev_count = 0
        for ev in src_ev_rows:
            cur = conn.execute(
                """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (target_topic_id, project_id, ev["evidence_type"], ev["ref_id"], ev["ref_url"], ev["snippet"], f"merged_from:#{source_topic_id}|{ev['provenance']}"),
            )
            if cur.rowcount > 0:
                merged_ev_count += 1

        # 3. 合并关键词、任务 ID、标签、建议查询词与证据 ID
        merged_kws = list(dict.fromkeys(_loads_list(tgt["keywords_json"]) + _loads_list(src["keywords_json"])))
        merged_tasks = list(dict.fromkeys(_loads_list(tgt["task_ids_json"]) + _loads_list(src["task_ids_json"]) + ([src["task_id"]] if src["task_id"] else [])))
        merged_tags = list(dict.fromkeys(_loads_list(tgt["tags_json"]) + _loads_list(src["tags_json"])))
        merged_queries = list(dict.fromkeys(_loads_list(tgt["suggested_queries_json"]) + _loads_list(src["suggested_queries_json"])))
        merged_ev_ids = list(dict.fromkeys(_loads_list(tgt["source_evidence_ids_json"]) + _loads_list(src["source_evidence_ids_json"])))
        merged_notes = (tgt["user_notes"] or "").strip()
        if (src["user_notes"] or "").strip():
            merged_notes = (merged_notes + f"\n[合并自#{source_topic_id}] " + src["user_notes"].strip()).strip()

        conn.execute(
            """UPDATE topics SET
               keywords_json = ?, task_ids_json = ?, tags_json = ?,
               suggested_queries_json = ?, source_evidence_ids_json = ?,
               user_notes = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (
                json.dumps(merged_kws, ensure_ascii=False),
                json.dumps(merged_tasks, ensure_ascii=False),
                json.dumps(merged_tags, ensure_ascii=False),
                json.dumps(merged_queries, ensure_ascii=False),
                json.dumps(merged_ev_ids, ensure_ascii=False),
                merged_notes,
                target_topic_id,
            ),
        )

        # 4. 迁移父子关系并新增 merged 溯源关系
        conn.execute(
            "INSERT INTO topic_relations(project_id, parent_topic_id, child_topic_id, relation_type, parent_keyword, reason) VALUES (?, ?, ?, 'merged', ?, ?)",
            (project_id, target_topic_id, source_topic_id, src["topic_title"][:100], reason[:300]),
        )

        # 5. 软归档源选题（不物理删除，可恢复）
        conn.execute(
            "UPDATE topics SET merged_into_topic_id = ?, is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (target_topic_id, source_topic_id),
        )
        cur_log = conn.execute(
            """INSERT INTO topic_merge_logs(project_id, target_topic_id, source_topic_id, source_snapshot_json, merged_evidence_count, merged_keywords_json, reason)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (project_id, target_topic_id, source_topic_id, json.dumps(snapshot, ensure_ascii=False), merged_ev_count, json.dumps(merged_kws, ensure_ascii=False), reason[:300]),
        )
        _record_history(conn, target_topic_id, project_id, "merged", "", f"吸收选题#{source_topic_id}", reason)
        _record_history(conn, source_topic_id, project_id, "merged", "active", f"merged_into:#{target_topic_id}", reason)
        conn.commit()
        return {
            "ok": True,
            "merge_log_id": cur_log.lastrowid,
            "target_topic_id": target_topic_id,
            "source_topic_id": source_topic_id,
            "merged_evidence_count": merged_ev_count,
            "total_keywords": len(merged_kws),
        }
    finally:
        conn.close()


def restore_merged_topic(merge_log_id: int, project_id: int) -> dict[str, Any]:
    """根据合并日志恢复被合并归档的源选题。"""
    conn = get_conn()
    try:
        log = conn.execute("SELECT * FROM topic_merge_logs WHERE id = ? AND project_id = ?", (merge_log_id, project_id)).fetchone()
        if not log:
            return {"ok": False, "error": "未找到合并日志"}
        src_id = int(log["source_topic_id"])
        conn.execute(
            "UPDATE topics SET merged_into_topic_id = NULL, is_archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (src_id,),
        )
        conn.execute("UPDATE topic_merge_logs SET is_restored = 1 WHERE id = ?", (merge_log_id,))
        _record_history(conn, src_id, project_id, "merged", f"merged_into:#{log['target_topic_id']}", "restored", "用户从合并日志恢复源选题")
        conn.commit()
        return {"ok": True, "restored_topic_id": src_id, "merge_log_id": merge_log_id}
    finally:
        conn.close()


def re_search_topic(
    topic_id: int,
    project_id: int,
    *,
    queries: list[str] | None = None,
    platforms: list[str] | None = None,
    per_query_limit: int = 4,
    auto_start: bool = True,
) -> dict[str, Any]:
    """从 TopicHub 点击任意选题重新发起真实市场搜索（复用 Phase 2 批量调度引擎）。"""
    conn = get_conn()
    try:
        tp = conn.execute("SELECT * FROM topics WHERE id = ? AND project_id = ?", (topic_id, project_id)).fetchone()
        if not tp:
            return {"ok": False, "error": "选题不存在或不属于当前项目"}
        use_queries = [q.strip() for q in (queries or []) if q.strip()]
        if not use_queries:
            use_queries = _loads_list(tp["suggested_queries_json"]) or _loads_list(tp["keywords_json"]) or [tp["topic_title"][:40]]
        use_queries = use_queries[:2]
        use_platforms = platforms or ["youtube", "bilibili"]
    finally:
        conn.close()

    res = batch_svc.create_and_start_batch(
        project_id=project_id,
        task_id=tp["task_id"],
        title=f"TopicHub重研·{tp['topic_title'][:32]}",
        keywords=[{"query_text": q} for q in use_queries],
        platforms=use_platforms,
        budget={"max_queries": len(use_queries) * len(use_platforms), "per_query_limit": per_query_limit, "max_requests": 8, "timeout_sec": 30},
        auto_start=auto_start,
    )
    if not res.get("ok"):
        return res

    conn = get_conn()
    try:
        bid = int(res["batch_id"])
        conn.execute(
            "UPDATE topics SET second_round_batch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (bid, topic_id),
        )
        _record_history(conn, topic_id, project_id, "re_search", "", f"batch#{bid}", f"从 TopicHub 发起重新真实研究：{use_queries}")
        conn.commit()
    finally:
        conn.close()

    return {"ok": True, "topic_id": topic_id, "batch_id": int(res["batch_id"]), "queries": use_queries, "platforms": use_platforms}


# ==================== FIX-A07: 统一生命周期批量操作 / 退回 / 归档与恢复 ====================
def batch_update_topics_status(topic_ids: list[int], production_status: str, reason: str = "用户批量修改创作状态") -> dict[str, Any]:
    """批量修改多个选题的创作状态，逐条写入 topic_status_history，不改变市场验证等级。"""
    if not topic_ids:
        return {"ok": False, "error": "请先选择至少一条选题"}
    new_ps = _norm_prod_status(production_status)
    is_arch = 1 if new_ps == "已归档" else 0
    conn = get_conn()
    updated = 0
    try:
        for tid in topic_ids:
            row = conn.execute("SELECT id, project_id, production_status, COALESCE(is_archived,0) AS is_archived FROM topics WHERE id = ?", (int(tid),)).fetchone()
            if not row:
                continue
            old_ps = "已归档" if row["is_archived"] else _norm_prod_status(row["production_status"])
            if old_ps == new_ps:
                continue
            conn.execute(
                "UPDATE topics SET production_status = ?, is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (new_ps, is_arch, int(tid)),
            )
            _record_history(conn, int(tid), int(row["project_id"] or 1), "production_status", old_ps, new_ps, reason)
            updated += 1
        conn.commit()
        return {"ok": True, "updated_count": updated, "production_status": new_ps}
    finally:
        conn.close()


def revert_topic_status(topic_id: int, reason: str = "用户退回上一阶段") -> dict[str, Any]:
    """将选题按生命周期顺序退回上一阶段（待研究←研究中←待制作←制作中←待发布←已发布；已归档则恢复至归档前状态）。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (int(topic_id),)).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到选题：{topic_id}"}
        cur_ps = "已归档" if row["is_archived"] else _norm_prod_status(row["production_status"])
        if cur_ps == "已归档":
            return archive_or_restore_topic(topic_id, archive=False, reason=reason or "从已归档恢复")
        if cur_ps not in LIFECYCLE_FLOW_ORDER:
            prev_ps = "待研究"
        else:
            idx = LIFECYCLE_FLOW_ORDER.index(cur_ps)
            if idx == 0:
                return {"ok": False, "error": "当前已处于初始阶段「待研究」，无法继续退回"}
            prev_ps = LIFECYCLE_FLOW_ORDER[idx - 1]
        conn.execute(
            "UPDATE topics SET production_status = ?, is_archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (prev_ps, int(topic_id)),
        )
        _record_history(conn, int(topic_id), int(row["project_id"] or 1), "production_status", cur_ps, prev_ps, reason)
        conn.commit()
        fresh = conn.execute("SELECT * FROM topics WHERE id = ?", (int(topic_id),)).fetchone()
        return {"ok": True, "old_status": cur_ps, "new_status": prev_ps, "topic": _format_topic_row(conn, fresh)}
    finally:
        conn.close()


def archive_or_restore_topic(topic_id: int, archive: bool = True, reason: str = "") -> dict[str, Any]:
    """归档或恢复选题：恢复时优先还原归档前的最近有效状态，默认回落「待研究」。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (int(topic_id),)).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到选题：{topic_id}"}
        cur_ps = "已归档" if row["is_archived"] else _norm_prod_status(row["production_status"])
        if archive:
            new_ps = "已归档"
            is_arch = 1
            act_reason = reason or "用户主动归档"
        else:
            # 查询归档前的最近非归档状态
            prev_row = conn.execute(
                """SELECT old_value FROM topic_status_history
                   WHERE topic_id = ? AND field_name = 'production_status' AND new_value = '已归档'
                   ORDER BY id DESC LIMIT 1""",
                (int(topic_id),),
            ).fetchone()
            restored = _norm_prod_status(prev_row["old_value"]) if prev_row and prev_row["old_value"] else "待研究"
            if restored == "已归档":
                restored = "待研究"
            new_ps = restored
            is_arch = 0
            act_reason = reason or f"用户恢复归档选题至「{new_ps}」"
        conn.execute(
            "UPDATE topics SET production_status = ?, is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_ps, is_arch, int(topic_id)),
        )
        _record_history(conn, int(topic_id), int(row["project_id"] or 1), "production_status", cur_ps, new_ps, act_reason)
        conn.commit()
        fresh = conn.execute("SELECT * FROM topics WHERE id = ?", (int(topic_id),)).fetchone()
        return {"ok": True, "old_status": cur_ps, "new_status": new_ps, "topic": _format_topic_row(conn, fresh)}
    finally:
        conn.close()
