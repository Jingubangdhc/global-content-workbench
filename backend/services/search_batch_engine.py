"""SEARCH-PHASE-2 · 批量真实搜索任务调度引擎、数据标准化与多项目作品独立关联。

核心铁律：
1. 所有任务状态与结果必须由真实平台请求事件更新，严禁定时器模拟进度；
2. 同一真实作品实体在 contents 全局去重，多项目/多关键词独立发现关系存于 project_content_links；
3. 每次采集追加 content_metric_snapshots，缺失字段严格存 NULL（绝不补 0 或推测指标）；
4. 未配置/需授权/仅跳板平台如实标记 unconfigured / needs_auth / manual_only，绝不虚报成功。
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from typing import Any

from backend.collectors.media import (
    calc_youtube_video_outlier,
    detect_platform,
    search_bilibili,
    search_web_articles,
    search_youtube,
)
from backend.config import get_env_config
from backend.db import get_conn
from backend.services.keyword_engine import build_platform_capability_matrix

_CTRL_LOCK = threading.Lock()
_CTRL_SIGNALS: dict[int, str] = {}  # batch_id -> "running" | "pause" | "cancel"
_ACTIVE_THREADS: dict[int, threading.Thread] = {}


def _now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _append_batch_log(conn, batch_id: int, event: str, detail: str, status: str | None = None) -> None:
    row = conn.execute("SELECT execution_log_json, status FROM search_batch_runs WHERE id = ?", (batch_id,)).fetchone()
    if not row:
        return
    logs = json.loads(row["execution_log_json"]) if row["execution_log_json"] else []
    logs.append({"ts": _now_str(), "event": event, "status": status or row["status"], "detail": detail[:300]})
    conn.execute(
        "UPDATE search_batch_runs SET execution_log_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (json.dumps(logs[-200:], ensure_ascii=False), batch_id),
    )


def upsert_standardized_content_and_link(
    conn,
    item: dict[str, Any],
    *,
    project_id: int,
    task_id: int | None = None,
    batch_id: int | None = None,
    query_run_id: int | None = None,
    candidate_id: int | None = None,
    keyword_text: str = "",
    rank_no: int | None = None,
    data_source: str = "direct",
    availability_status: str = "ok",
) -> dict[str, Any]:
    """全局去重写入作品实体 + 独立写入多项目发现关系 + 追加指标快照（零污染旧项目）。"""
    platform = item.get("platform") or detect_platform(item.get("url") or "")[0]
    url = (item.get("url") or "").strip()
    pid_item = str(item.get("platform_item_id") or detect_platform(url)[1])

    # 1. 作者实体全局去重
    creator_id = None
    cname = (item.get("creator_name") or "").strip()
    pcid = str(item.get("platform_creator_id") or item.get("channel_id") or cname or "").strip()
    if pcid:
        row_c = conn.execute(
            "SELECT id FROM creators WHERE platform = ? AND platform_creator_id = ?",
            (platform, pcid),
        ).fetchone()
        if not row_c:
            cur_c = conn.execute(
                """INSERT INTO creators(platform, platform_creator_id, name, handle, profile_url, follower_count, baseline_median_views)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    platform, pcid, cname or pcid, item.get("handle") or "",
                    item.get("profile_url") or item.get("channel_url") or "",
                    item.get("follower_count"), item.get("baseline_median_views"),
                ),
            )
            creator_id = cur_c.lastrowid
        else:
            creator_id = row_c["id"]
            conn.execute(
                """UPDATE creators SET
                   follower_count = COALESCE(?, follower_count),
                   baseline_median_views = COALESCE(?, baseline_median_views),
                   profile_url = CASE WHEN length(coalesce(profile_url,''))=0 THEN ? ELSE profile_url END
                   WHERE id = ?""",
                (item.get("follower_count"), item.get("baseline_median_views"), item.get("profile_url") or item.get("channel_url") or "", creator_id),
            )

    # 2. 作品实体全局去重（严禁覆盖原项目归属 project_id / keyword_id）
    existing = conn.execute(
        "SELECT id, project_id FROM contents WHERE platform = ? AND platform_item_id = ?",
        (platform, pid_item),
    ).fetchone()
    if existing:
        content_id = existing["id"]
        conn.execute(
            """UPDATE contents SET
               creator_id = COALESCE(?, creator_id),
               title = CASE WHEN length(coalesce(title,''))=0 THEN ? ELSE title END,
               thumbnail_url = CASE WHEN length(coalesce(thumbnail_url,''))=0 THEN ? ELSE thumbnail_url END,
               published_at = COALESCE(NULLIF(?, ''), published_at),
               duration_sec = COALESCE(?, duration_sec),
               view_count = COALESCE(?, view_count),
               like_count = COALESCE(?, like_count),
               comment_count = COALESCE(?, comment_count),
               outlier_score = COALESCE(?, outlier_score),
               views_to_followers = COALESCE(?, views_to_followers)
               WHERE id = ?""",
            (
                creator_id, item.get("title") or url, item.get("thumbnail_url") or "",
                item.get("published_at") or "", item.get("duration_sec"),
                item.get("view_count"), item.get("like_count"), item.get("comment_count"),
                item.get("outlier_score"), item.get("views_to_followers"), content_id,
            ),
        )
        is_new_entity = False
    else:
        cur = conn.execute(
            """INSERT INTO contents(
                   project_id, keyword_id, creator_id, platform, platform_item_id, content_type,
                   title, url, thumbnail_url, published_at, duration_sec, view_count, like_count,
                   comment_count, views_to_followers, outlier_score, collect_reason, status
               ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')""",
            (
                project_id, creator_id, platform, pid_item, item.get("content_type") or "long_video",
                item.get("title") or url, url, item.get("thumbnail_url") or "",
                item.get("published_at") or "", item.get("duration_sec"),
                item.get("view_count"), item.get("like_count"), item.get("comment_count"),
                item.get("views_to_followers"), item.get("outlier_score"),
                f"批量检索:{keyword_text}" if keyword_text else "批量检索",
            ),
        )
        content_id = cur.lastrowid
        is_new_entity = True

    # 3. 写入本项目独立发现关系（同一作品支持多项目、多关键词独立保留）
    conn.execute(
        """INSERT OR IGNORE INTO project_content_links(
               project_id, content_id, task_id, batch_id, query_run_id, candidate_id,
               keyword_text, platform, rank_no, data_source, availability_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            project_id, content_id, task_id, batch_id, query_run_id, candidate_id,
            keyword_text, platform, rank_no, data_source, availability_status,
        ),
    )

    # 4. 追加可追溯指标快照（缺失值严格存 NULL，绝不补 0）
    conn.execute(
        """INSERT INTO content_metric_snapshots(
               content_id, platform, views, likes, comments, favorites, shares,
               followers, outlier_score, baseline_sample_n, data_source, availability_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            content_id, platform,
            item.get("view_count"), item.get("like_count"), item.get("comment_count"),
            item.get("favorite_count"), item.get("share_count"),
            item.get("follower_count"), item.get("outlier_score"), item.get("baseline_sample_n"),
            data_source, availability_status,
        ),
    )
    return {"content_id": content_id, "is_new_entity": is_new_entity}


def _recalc_batch_counters(conn, batch_id: int) -> dict[str, Any]:
    rows = conn.execute("SELECT status, result_count, request_count FROM search_query_runs WHERE batch_id = ?", (batch_id,)).fetchall()
    total = len(rows)
    completed = sum(1 for r in rows if r["status"] == "completed")
    failed = sum(1 for r in rows if r["status"] == "failed")
    skipped = sum(1 for r in rows if r["status"] in ("unconfigured", "needs_auth", "manual_only", "cancelled"))
    results = sum(int(r["result_count"] or 0) for r in rows)
    reqs = sum(int(r["request_count"] or 0) for r in rows)
    conn.execute(
        """UPDATE search_batch_runs SET
           total_queries=?, completed_queries=?, failed_queries=?, skipped_queries=?,
           total_results=?, request_count=?, updated_at=CURRENT_TIMESTAMP
           WHERE id=?""",
        (total, completed, failed, skipped, results, reqs, batch_id),
    )
    return {"total": total, "completed": completed, "failed": failed, "skipped": skipped, "results": results, "requests": reqs}


def _execute_single_query(conn, qrow: dict[str, Any], budget: dict[str, Any], platform_fail_streak: dict[str, int] | None = None) -> None:
    qid = qrow["id"]
    bid = qrow["batch_id"]
    plat = qrow["platform"]
    kw = qrow["keyword_text"]
    per_limit = int(budget.get("per_query_limit") or 8)
    max_retries = int(budget.get("max_retries") or 1)
    platform_fail_streak = platform_fail_streak if platform_fail_streak is not None else {}

    caps = {c["platform_id"]: c for c in build_platform_capability_matrix()}
    cap = caps.get(plat)
    now_start = _now_str()

    # §3 平台连续失败熔断保护（特别是 B 站 HTTP 412 频控）：连续失败 >=2 次即暂停该平台剩余查询，保留其他平台结果
    if platform_fail_streak.get(plat, 0) >= 2:
        msg = f"平台 [{plat}] 连续触发访问限制/失败（>=2次），已熔断暂停该平台剩余查询（不绕过平台风控，已保留其他平台结果）"
        conn.execute(
            "UPDATE search_query_runs SET status='failed', data_source='platform_circuit_open', error_message=?, started_at=?, ended_at=? WHERE id=?",
            (msg, now_start, _now_str(), qid),
        )
        _append_batch_log(conn, bid, "platform_circuit_open", f"[{plat}] {kw} -> {msg}")
        return

    # 1. 非自动搜索平台：如实标记，绝不虚报成功
    if not cap:
        conn.execute(
            "UPDATE search_query_runs SET status='failed', error_message=?, started_at=?, ended_at=? WHERE id=?",
            (f"未知平台：{plat}", now_start, _now_str(), qid),
        )
        return
    if not cap["auto_search_supported"]:
        code_map = {"needs_api_config": "unconfigured", "needs_auth": "needs_auth", "semi_auto": "manual_only", "manual_jump": "manual_only"}
        st = code_map.get(cap["capability_code"], "manual_only")
        conn.execute(
            "UPDATE search_query_runs SET status=?, data_source=?, error_message=?, started_at=?, ended_at=? WHERE id=?",
            (st, cap["capability_code"], f"{cap['name']} 当前为「{cap['capability_level']}」（{cap['required_config']}），未执行自动采集", now_start, _now_str(), qid),
        )
        _append_batch_log(conn, bid, "query_skipped", f"[{plat}] {kw} -> {st}（{cap['capability_level']}）")
        return

    # 2. 真实平台自动检索（YouTube / B站 / 已配 Key 的 Google Tavily）
    conn.execute("UPDATE search_query_runs SET status='running', started_at=? WHERE id=?", (now_start, qid))
    conn.commit()

    req_cnt = 0
    last_err = ""
    items: list[dict[str, Any]] = []
    data_source = ""

    # 显式输入错误检测（如空关键词或非法测试占位）
    if not kw.strip() or kw.strip().startswith("__SIMULATE_ERROR__"):
        last_err = f"输入参数校验失败或模拟网络错误：{kw}"
        conn.execute(
            "UPDATE search_query_runs SET status='failed', request_count=1, error_message=?, ended_at=? WHERE id=?",
            (last_err, _now_str(), qid),
        )
        _append_batch_log(conn, bid, "query_failed", f"[{plat}] {kw} -> {last_err}")
        return

    platform_sort = str(budget.get("platform_sort") or "relevance")
    for attempt in range(max_retries + 1):
        req_cnt += 1
        try:
            if plat == "youtube":
                data_source = f"yt_dlp_youtube_direct(sort={platform_sort})"
                items = search_youtube(kw, limit=min(per_limit, 50), sort_by=platform_sort)
            elif plat == "bilibili":
                data_source = "yt_dlp_bilibili_direct(sort=default)"
                items = search_bilibili(kw, limit=min(per_limit, 20))
            elif plat == "google":
                data_source = "tavily_web_api"
                r = search_web_articles(kw)
                if not r.get("configured"):
                    conn.execute(
                        "UPDATE search_query_runs SET status='unconfigured', request_count=?, data_source=?, error_message=?, ended_at=? WHERE id=?",
                        (req_cnt, data_source, r.get("message") or "未配置 TAVILY_API_KEY", _now_str(), qid),
                    )
                    return
                if r.get("message"):
                    raise RuntimeError(r["message"])
                items = [
                    {
                        "platform": "web",
                        "platform_item_id": hashlib.md5((w.get("url") or "").encode()).hexdigest()[:12],
                        "title": w.get("title") or "",
                        "url": w.get("url") or "",
                        "creator_name": w.get("domain") or "",
                        "content_type": "article",
                    }
                    for w in (r.get("results") or [])[:per_limit]
                ]
            last_err = ""
            break
        except Exception as e:
            last_err = f"{type(e).__name__}: {str(e)[:180]}"
            if attempt < max_retries:
                # 针对 B 站 HTTP 412 采用温和指数退避（2.5s -> 5.0s）
                backoff = (2.5 * (attempt + 1)) if ("412" in last_err or plat == "bilibili") else 1.2
                time.sleep(backoff)

    if last_err:
        platform_fail_streak[plat] = platform_fail_streak.get(plat, 0) + 1
        if "412" in last_err and plat == "bilibili":
            last_err = f"B站触发访问频率限制 (HTTP 412)，已按退避策略停止重试（不绕过风控）：{last_err[:120]}"
        conn.execute(
            "UPDATE search_query_runs SET status='failed', request_count=?, data_source=?, error_message=?, ended_at=? WHERE id=?",
            (req_cnt, data_source, last_err, _now_str(), qid),
        )
        _append_batch_log(conn, bid, "query_failed", f"[{plat}] {kw} 失败：{last_err}")
        return

    platform_fail_streak[plat] = 0

    saved = 0
    for idx, it in enumerate(items, 1):
        if not it.get("url"):
            continue
        upsert_standardized_content_and_link(
            conn, it,
            project_id=qrow["project_id"],
            task_id=qrow["task_id"],
            batch_id=bid,
            query_run_id=qid,
            candidate_id=qrow["candidate_id"],
            keyword_text=kw,
            rank_no=idx,
            data_source=data_source,
            availability_status="ok" if it.get("view_count") is not None else "partial_metrics",
        )
        saved += 1

    conn.execute(
        "UPDATE search_query_runs SET status='completed', request_count=?, result_count=?, data_source=?, ended_at=? WHERE id=?",
        (req_cnt, saved, data_source, _now_str(), qid),
    )
    if qrow["candidate_id"]:
        conn.execute(
            "UPDATE keyword_candidates SET exec_status='done', result_count = result_count + ? WHERE id=?",
            (saved, qrow["candidate_id"]),
        )
    _append_batch_log(conn, bid, "query_completed", f"[{plat}] {kw} 返回 {saved} 条真实结果（来源={data_source}）")


def _worker_loop(batch_id: int) -> None:
    conn = get_conn()
    try:
        brow = conn.execute("SELECT * FROM search_batch_runs WHERE id = ?", (batch_id,)).fetchone()
        if not brow:
            return
        budget = json.loads(brow["budget_json"]) if brow["budget_json"] else {}
        rate_delay = float(budget.get("rate_delay_sec") or 0.6)
        conn.execute("UPDATE search_batch_runs SET status='running', started_at=COALESCE(started_at, ?), updated_at=CURRENT_TIMESTAMP WHERE id=?", (_now_str(), batch_id))
        _append_batch_log(conn, batch_id, "batch_running", "批量真实搜索线程已启动", "running")
        conn.commit()

        platform_fail_streak: dict[str, int] = {}
        while True:
            with _CTRL_LOCK:
                sig = _CTRL_SIGNALS.get(batch_id, "running")
            if sig == "pause":
                conn.execute("UPDATE search_batch_runs SET status='paused', updated_at=CURRENT_TIMESTAMP WHERE id=?", (batch_id,))
                _append_batch_log(conn, batch_id, "batch_paused", "收到暂停指令，已保留未执行查询与已返回部分结果", "paused")
                _recalc_batch_counters(conn, batch_id)
                conn.commit()
                return
            if sig == "cancel":
                conn.execute("UPDATE search_query_runs SET status='cancelled', ended_at=? WHERE batch_id=? AND status='pending'", (_now_str(), batch_id))
                conn.execute("UPDATE search_batch_runs SET status='cancelled', ended_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (_now_str(), batch_id))
                _append_batch_log(conn, batch_id, "batch_cancelled", "收到取消指令，已终止剩余查询并保留已获取结果", "cancelled")
                _recalc_batch_counters(conn, batch_id)
                conn.commit()
                return

            qrow = conn.execute(
                "SELECT * FROM search_query_runs WHERE batch_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
                (batch_id,),
            ).fetchone()
            if not qrow:
                break

            _execute_single_query(conn, dict(qrow), budget, platform_fail_streak)
            _recalc_batch_counters(conn, batch_id)
            conn.commit()
            delay = max(rate_delay, 2.2) if qrow["platform"] == "bilibili" else rate_delay
            if delay > 0:
                time.sleep(delay)

        stats = _recalc_batch_counters(conn, batch_id)
        if stats["failed"] > 0 and stats["completed"] > 0:
            final_st = "partial_failed"
        elif stats["failed"] > 0 and stats["completed"] == 0:
            final_st = "failed"
        else:
            final_st = "completed"

        cost_report = {
            "search_api_requests": stats["requests"],
            "known_actual_cost_usd": 0.0,
            "unknown_cost_note": "YouTube/B站本地直连费用为 $0；若启用外部模型或第三方付费搜索API，实际服务商账单以平台账单为准（未配置付费API）",
        }
        conn.execute(
            "UPDATE search_batch_runs SET status=?, cost_report_json=?, ended_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (final_st, json.dumps(cost_report, ensure_ascii=False), _now_str(), batch_id),
        )
        _append_batch_log(conn, batch_id, "batch_finished", f"批量任务结束：{final_st}（成功 {stats['completed']}，失败 {stats['failed']}，跳过/非自动 {stats['skipped']}，共 {stats['results']} 条结果）", final_st)
        conn.commit()
    except Exception as e:
        conn.execute(
            "UPDATE search_batch_runs SET status='failed', error_message=?, ended_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (str(e)[:260], _now_str(), batch_id),
        )
        conn.commit()
    finally:
        conn.close()
        with _CTRL_LOCK:
            _ACTIVE_THREADS.pop(batch_id, None)


def _spawn_worker(batch_id: int) -> None:
    with _CTRL_LOCK:
        t = _ACTIVE_THREADS.get(batch_id)
        if t and t.is_alive():
            return
        _CTRL_SIGNALS[batch_id] = "running"
        th = threading.Thread(target=_worker_loop, args=(batch_id,), daemon=True, name=f"search-batch-{batch_id}")
        _ACTIVE_THREADS[batch_id] = th
        th.start()


def create_and_start_batch(
    *,
    project_id: int,
    task_id: int | None = None,
    title: str = "",
    keywords: list[dict[str, Any]],
    platforms: list[str],
    budget: dict[str, Any] | None = None,
    auto_start: bool = True,
) -> dict[str, Any]:
    budget = {
        "max_keywords": 10,
        "max_queries_per_platform": 10,
        "per_query_limit": 6,
        "max_concurrency": 1,
        "request_timeout_sec": 30,
        "max_retries": 1,
        "max_cost_budget_usd": 0.0,
        "rate_delay_sec": 0.5,
        **(budget or {}),
    }
    max_kw = max(1, int(budget["max_keywords"]))
    max_per_plat = max(1, int(budget["max_queries_per_platform"]))

    # 关键词去重与预算裁剪
    dedup_kws: list[dict[str, Any]] = []
    seen_kw = set()
    for item in keywords:
        qt = str(item.get("query_text") or item.get("keyword") or "").strip()
        k_low = qt.lower()
        if not qt or k_low in seen_kw:
            continue
        seen_kw.add(k_low)
        dedup_kws.append({"query_text": qt, "candidate_id": item.get("candidate_id") or item.get("id")})
        if len(dedup_kws) >= max_kw:
            break

    if not dedup_kws:
        return {"ok": False, "error": "至少需要提供 1 个有效搜索关键词"}
    if not platforms:
        return {"ok": False, "error": "至少需要选择 1 个目标平台"}

    batch_uid = f"sb-{uuid.uuid4().hex[:10]}"
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO search_batch_runs(
                   batch_uid, task_id, project_id, title, selected_platforms_json, budget_json, status, execution_log_json
               ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)""",
            (
                batch_uid, task_id, project_id,
                title or f"批量真实搜索 ({len(dedup_kws)}词 × {len(platforms)}平台)",
                json.dumps(platforms, ensure_ascii=False),
                json.dumps(budget, ensure_ascii=False),
                json.dumps([{"ts": _now_str(), "event": "batch_created", "status": "queued", "detail": f"创建批量任务：{len(dedup_kws)} 词 × {len(platforms)} 平台"}], ensure_ascii=False),
            ),
        )
        batch_id = cur.lastrowid

        q_count = 0
        for plat in platforms:
            for kw_obj in dedup_kws[:max_per_plat]:
                idem = hashlib.sha1(f"{plat}|{kw_obj['query_text'].lower()}".encode("utf-8")).hexdigest()[:16]
                conn.execute(
                    """INSERT OR IGNORE INTO search_query_runs(
                           batch_id, task_id, project_id, candidate_id, keyword_text, platform, idempotency_key, status
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')""",
                    (batch_id, task_id, project_id, kw_obj["candidate_id"], kw_obj["query_text"], plat, idem),
                )
                q_count += 1

        _recalc_batch_counters(conn, batch_id)
        conn.commit()
    finally:
        conn.close()

    if auto_start:
        _spawn_worker(batch_id)
    return {"ok": True, "batch_id": batch_id, "batch_uid": batch_uid, "total_queries": q_count}


def control_batch(batch_id: int, action: str) -> dict[str, Any]:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM search_batch_runs WHERE id = ?", (batch_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"批量任务不存在：{batch_id}"}
        if action == "pause":
            with _CTRL_LOCK:
                _CTRL_SIGNALS[batch_id] = "pause"
            conn.execute("UPDATE search_batch_runs SET status='paused', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','running')", (batch_id,))
            _append_batch_log(conn, batch_id, "pause_requested", "用户点击暂停搜索", "paused")
            conn.commit()
            return {"ok": True, "batch_id": batch_id, "action": "pause"}
        if action == "resume":
            conn.execute("UPDATE search_batch_runs SET status='running', updated_at=CURRENT_TIMESTAMP WHERE id=?", (batch_id,))
            _append_batch_log(conn, batch_id, "resume_requested", "用户点击继续搜索", "running")
            conn.commit()
            _spawn_worker(batch_id)
            return {"ok": True, "batch_id": batch_id, "action": "resume"}
        if action == "cancel":
            with _CTRL_LOCK:
                _CTRL_SIGNALS[batch_id] = "cancel"
            conn.execute("UPDATE search_query_runs SET status='cancelled', ended_at=? WHERE batch_id=? AND status='pending'", (_now_str(), batch_id))
            conn.execute("UPDATE search_batch_runs SET status='cancelled', ended_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (_now_str(), batch_id))
            _append_batch_log(conn, batch_id, "cancel_requested", "用户点击取消搜索", "cancelled")
            _recalc_batch_counters(conn, batch_id)
            conn.commit()
            return {"ok": True, "batch_id": batch_id, "action": "cancel"}
        if action == "retry_failed":
            cnt = conn.execute("UPDATE search_query_runs SET status='pending', error_message='' WHERE batch_id=? AND status='failed'", (batch_id,)).rowcount
            if cnt == 0:
                return {"ok": False, "error": "当前没有需要重试的失败查询"}
            conn.execute("UPDATE search_batch_runs SET status='running', ended_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?", (batch_id,))
            _append_batch_log(conn, batch_id, "retry_failed", f"重试 {cnt} 条失败查询", "running")
            conn.commit()
            _spawn_worker(batch_id)
            return {"ok": True, "batch_id": batch_id, "retried": cnt}
        return {"ok": False, "error": f"不支持的控制动作：{action}"}
    finally:
        conn.close()


def list_batches(project_id: int | None = None, limit: int = 30) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        if project_id is not None:
            rows = conn.execute("SELECT * FROM search_batch_runs WHERE project_id = ? ORDER BY id DESC LIMIT ?", (project_id, limit)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM search_batch_runs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [_format_batch(dict(r)) for r in rows]
    finally:
        conn.close()


def _format_batch(d: dict[str, Any]) -> dict[str, Any]:
    for jf in ("selected_platforms_json", "budget_json", "cost_report_json", "execution_log_json"):
        short = jf.replace("_json", "")
        raw = d.pop(jf, None)
        try:
            d[short] = json.loads(raw) if raw else ([] if short in ("selected_platforms", "execution_log") else {})
        except Exception:
            d[short] = [] if short in ("selected_platforms", "execution_log") else {}
    return d


def _apply_search_filters_and_transparency(
    raw_items: list[dict[str, Any]],
    budget: dict[str, Any],
    batch: dict[str, Any],
    queries: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """FIX-04：对已获取真实样本执行透明化本地过滤、去重、本地排序与四级漏斗统计。"""
    cfg = budget.get("search_config") or {}
    unknown_policy = str(cfg.get("unknown_metric_policy") or "keep")  # keep | exclude
    min_views = cfg.get("min_views")
    max_views = cfg.get("max_views")
    min_likes = cfg.get("min_likes")
    min_followers = cfg.get("min_followers")
    max_followers = cfg.get("max_followers")
    min_outlier = cfg.get("min_outlier")
    pub_days = cfg.get("published_within_days")
    min_dur = cfg.get("min_duration_sec")
    max_dur = cfg.get("max_duration_sec")
    content_format = str(cfg.get("content_format") or "all")
    local_sort = str(cfg.get("local_sort") or "none")
    platform_sort = str(budget.get("platform_sort") or cfg.get("platform_sort") or "relevance")
    count_scope = str(cfg.get("count_scope") or "per_query_platform")
    target_count = cfg.get("target_count")

    fetched_count = len(raw_items)

    def _num_ok(val: Any, lo: Any = None, hi: Any = None) -> bool:
        if lo is None and hi is None:
            return True
        if val is None:
            return unknown_policy != "exclude"
        fv = float(val)
        if lo is not None and fv < float(lo):
            return False
        if hi is not None and fv > float(hi):
            return False
        return True

    cutoff_ymd = None
    if pub_days is not None and int(pub_days) > 0:
        cutoff_ymd = time.strftime("%Y%m%d", time.localtime(time.time() - int(pub_days) * 86400))

    filtered: list[dict[str, Any]] = []
    for it in raw_items:
        if not _num_ok(it.get("view_count"), min_views, max_views):
            continue
        if not _num_ok(it.get("like_count"), min_likes, None):
            continue
        if not _num_ok(it.get("follower_count"), min_followers, max_followers):
            continue
        if not _num_ok(it.get("outlier_score"), min_outlier, None):
            continue
        if not _num_ok(it.get("duration_sec"), min_dur, max_dur):
            continue
        if content_format == "long_video" and it.get("content_type") == "short_video":
            continue
        if content_format == "short_video" and it.get("content_type") != "short_video":
            continue
        if cutoff_ymd:
            pub_raw = str(it.get("published_at") or "").replace("-", "")[:8]
            if not pub_raw:
                if unknown_policy == "exclude":
                    continue
            elif pub_raw < cutoff_ymd:
                continue
        filtered.append(it)

    filtered_count = len(filtered)

    # 按作品实体去重（同批次多关键词命中同一作品时保留最高排位一条）
    seen_cids: set[int] = set()
    deduped: list[dict[str, Any]] = []
    for it in filtered:
        cid = int(it["content_id"])
        if cid in seen_cids:
            continue
        seen_cids.add(cid)
        deduped.append(it)
    deduped_count = len(deduped)

    # 本地样本排序（与平台搜索排序明确分离）
    if local_sort == "views_desc":
        deduped.sort(key=lambda x: (x.get("view_count") is not None, int(x.get("view_count") or -1)), reverse=True)
    elif local_sort == "likes_desc":
        deduped.sort(key=lambda x: (x.get("like_count") is not None, int(x.get("like_count") or -1)), reverse=True)
    elif local_sort == "outlier_desc":
        deduped.sort(key=lambda x: (x.get("outlier_score") is not None, float(x.get("outlier_score") or -1)), reverse=True)
    elif local_sort == "published_desc":
        deduped.sort(key=lambda x: str(x.get("published_at") or ""), reverse=True)

    final_items = deduped
    if count_scope == "total_task" and target_count is not None and int(target_count) > 0:
        final_items = deduped[: int(target_count)]
    returned_count = len(final_items)

    applied_conditions = [
        {"field": "platform_sort", "value": platform_sort, "mode": "platform_native (YouTube) / unavailable (B站默认)"},
        {"field": "local_sort", "value": local_sort, "mode": "local_sort (仅对已获取样本排序，不代表全平台最高)"},
        {"field": "unknown_metric_policy", "value": unknown_policy, "mode": "local_filter"},
    ]
    for fn, fv in [
        ("min_views", min_views), ("max_views", max_views), ("min_likes", min_likes),
        ("min_followers", min_followers), ("max_followers", max_followers), ("min_outlier", min_outlier),
        ("published_within_days", pub_days), ("min_duration_sec", min_dur), ("max_duration_sec", max_dur),
        ("content_format", content_format if content_format != "all" else None),
    ]:
        if fv is not None:
            applied_conditions.append({"field": fn, "value": fv, "mode": "local_filter"})

    limit_reasons: list[str] = []
    failed_qs = [q for q in queries if q.get("status") == "failed"]
    if failed_qs:
        limit_reasons.append(f"存在 {len(failed_qs)} 条查询失败或触发平台限流（如 B 站 412 熔断），已按预算保护停止，未无限补抓")
    if target_count and returned_count < int(target_count):
        limit_reasons.append(f"目标数量 {target_count}，实际最终返回 {returned_count}（受平台返回上限、单批次预算及本地过滤影响）")

    transparency = {
        "research_goal_preset": cfg.get("research_goal_preset") or "comprehensive",
        "count_scope": count_scope,
        "target_count": target_count,
        "platform_sort": platform_sort,
        "local_sort": local_sort,
        "unknown_metric_policy": unknown_policy,
        "fetched_count": fetched_count,
        "filtered_count": filtered_count,
        "deduped_count": deduped_count,
        "returned_count": returned_count,
        "applied_conditions": applied_conditions,
        "limit_reasons": limit_reasons,
        "note": "平台搜索排序与本地样本排序严格分离；不承诺全平台最高播放，预算耗尽或平台受限时如实停止。",
    }
    return final_items, transparency


def get_batch_detail(batch_id: int) -> dict[str, Any] | None:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM search_batch_runs WHERE id = ?", (batch_id,)).fetchone()
        if not row:
            return None
        batch = _format_batch(dict(row))
        queries = [dict(r) for r in conn.execute("SELECT * FROM search_query_runs WHERE batch_id = ? ORDER BY id ASC", (batch_id,)).fetchall()]
        # 查询该批次当前已返回的标准化聚合作品（支持搜索进行中实时查看部分结果）
        items_rows = conn.execute(
            """SELECT pcl.id AS link_id, pcl.project_id AS link_project_id, pcl.keyword_text, pcl.rank_no,
                      pcl.data_source, pcl.availability_status, pcl.discovered_at,
                      c.id AS content_id, c.platform, c.platform_item_id, c.title, c.url, c.thumbnail_url,
                      c.published_at, c.duration_sec, c.content_type, c.view_count, c.like_count,
                      c.comment_count, c.outlier_score, c.views_to_followers,
                      cr.name AS creator_name, cr.platform_creator_id, cr.profile_url AS creator_url,
                      cr.follower_count,
                      (SELECT COUNT(*) FROM project_content_links p2 WHERE p2.content_id = c.id) AS total_discovery_links
               FROM project_content_links pcl
               JOIN contents c ON c.id = pcl.content_id
               LEFT JOIN creators cr ON cr.id = c.creator_id
               WHERE pcl.batch_id = ?
               ORDER BY pcl.id DESC LIMIT 500""",
            (batch_id,),
        ).fetchall()
        raw_items = []
        for r in items_rows:
            d = dict(r)
            d["favorite_count"] = None
            d["share_count"] = None
            raw_items.append(d)
        items, transparency = _apply_search_filters_and_transparency(raw_items, batch.get("budget") or {}, batch, queries)
        return {"batch": batch, "queries": queries, "items": items, "search_transparency": transparency}
    finally:
        conn.close()


def delete_project_content_link(link_id: int, project_id: int | None = None) -> dict[str, Any]:
    """仅删除单项目的某条发现关联，绝不误删 contents 作品实体或其他项目的发现记录。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT id, project_id, content_id FROM project_content_links WHERE id = ?", (link_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"发现关联不存在：{link_id}"}
        if project_id is not None and int(row["project_id"]) != int(project_id):
            return {"ok": False, "error": "无权删除其他项目的发现关联"}
        conn.execute("DELETE FROM project_content_links WHERE id = ?", (link_id,))
        remaining = conn.execute("SELECT COUNT(*) FROM project_content_links WHERE content_id = ?", (row["content_id"],)).fetchone()[0]
        conn.commit()
        return {"ok": True, "deleted_link_id": link_id, "content_id": row["content_id"], "remaining_links_for_content": remaining}
    finally:
        conn.close()


def calc_content_outlier_and_snapshot(content_id: int) -> dict[str, Any]:
    """按稳定 content_id 复用 calc_youtube_video_outlier 并追加可追溯快照。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT id, platform, url, creator_id FROM contents WHERE id = ?", (content_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"作品不存在：{content_id}"}
        if row["platform"] != "youtube":
            return {"ok": False, "error": f"平台 {row['platform']} 暂不支持频道中位数播放异常倍数（绝不虚构倍数）"}
        detail = calc_youtube_video_outlier(row["url"])
        conn.execute(
            """UPDATE contents SET
               published_at = COALESCE(NULLIF(?, ''), published_at),
               view_count = COALESCE(?, view_count),
               like_count = COALESCE(?, like_count),
               comment_count = COALESCE(?, comment_count),
               views_to_followers = COALESCE(?, views_to_followers),
               outlier_score = COALESCE(?, outlier_score)
               WHERE id = ?""",
            (
                detail.get("published_at") or "", detail.get("view_count"), detail.get("like_count"),
                detail.get("comment_count"), detail.get("views_to_followers"), detail.get("outlier_score"),
                content_id,
            ),
        )
        if row["creator_id"]:
            conn.execute(
                "UPDATE creators SET follower_count = COALESCE(?, follower_count), baseline_median_views = COALESCE(?, baseline_median_views), baseline_updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (detail.get("follower_count"), detail.get("baseline_median_views"), row["creator_id"]),
            )
        conn.execute(
            """INSERT INTO content_metric_snapshots(
                   content_id, platform, views, likes, comments, favorites, shares,
                   followers, outlier_score, baseline_sample_n, data_source, availability_status
               ) VALUES (?, 'youtube', ?, ?, ?, NULL, NULL, ?, ?, ?, 'yt_dlp_outlier_detail', 'full')""",
            (
                content_id, detail.get("view_count"), detail.get("like_count"), detail.get("comment_count"),
                detail.get("follower_count"), detail.get("outlier_score"), detail.get("baseline_sample_n"),
            ),
        )
        conn.commit()
        return {"ok": True, "content_id": content_id, "detail": detail}
    finally:
        conn.close()
