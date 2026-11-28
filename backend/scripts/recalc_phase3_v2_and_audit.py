"""SEARCH-PHASE-4 · Phase 3 市场验证规则 V2 整改重算与聚类/选题去重审计脚本。

功能：
1. 读取 Phase 3 四大方向（batch#1..4）及衍生选题 #20（batch#8）的真实数据库作品、评论与快照；
2. 对比 v1.0 与 v2.0（gcw-mv-v2.0）验证等级、可靠高表现门槛命中数与变更原因；
3. 追加写入 v2.0 market_validations 记录（保留 v1.0 历史记录不删除），同步更新 topics 的验证等级/规则版本/形成原因/关联关键词/关联任务；
4. 对 Phase 3 已生成的 22 个主题聚类与 23 个选题执行语义相似度与证据重叠检测审计；
5. 导出 SEARCH_SCORING_RULES_V2.json、grade_comparison_v1_vs_v2.json、cluster_dedup_audit.json 到 docs/search_phase4/。
"""
from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from backend.db import get_conn
from backend.services import market_validation_engine as mv_svc

OUT_DIR = os.path.join(ROOT, "docs", "search_phase4")
os.makedirs(OUT_DIR, exist_ok=True)


def _norm(s: str) -> str:
    return re.sub(r"[\[\]【】()（）<>《》\"'“”‘’!！?？.,，。:：;；\-_/|·•\s]+", "", (s or "").lower())


def _jaccard3(a: str, b: str) -> float:
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ga = {na[i : i + 3] for i in range(max(1, len(na) - 2))}
    gb = {nb[i : i + 3] for i in range(max(1, len(nb) - 2))}
    u = len(ga | gb)
    return round(len(ga & gb) / u, 3) if u else 0.0


def main():
    # 1. 导出 SEARCH_SCORING_RULES_V2.json
    with open(os.path.join(OUT_DIR, "SEARCH_SCORING_RULES_V2.json"), "w", encoding="utf-8") as f:
        json.dump(mv_svc.get_scoring_rules(), f, ensure_ascii=False, indent=2)

    conn = get_conn()
    targets = [
        {"code": "A_toy", "name": "玩具", "batch_id": 1, "topic_id": None},
        {"code": "B_startup", "name": "创业与商业认知", "batch_id": 2, "topic_id": None},
        {"code": "C_musk", "name": "马斯克科技", "batch_id": 3, "topic_id": None},
        {"code": "D_medical", "name": "跨境医疗", "batch_id": 4, "topic_id": None},
        {"code": "T20_round2", "name": "衍生选题#20(二轮独立验证)", "batch_id": 8, "topic_id": 20},
    ]

    comparisons = []
    for t in targets:
        bid = t["batch_id"]
        tid = t["topic_id"]
        # 读取 v1.0 历史记录
        if tid is None:
            v1_row = conn.execute(
                "SELECT * FROM market_validations WHERE batch_id = ? AND topic_id IS NULL AND rule_version = 'gcw-mv-v1.0' ORDER BY id DESC LIMIT 1",
                (bid,),
            ).fetchone()
        else:
            v1_row = conn.execute(
                "SELECT * FROM market_validations WHERE batch_id = ? AND topic_id = ? AND rule_version = 'gcw-mv-v1.0' ORDER BY id DESC LIMIT 1",
                (bid, tid),
            ).fetchone()

        v1_grade = v1_row["validation_grade"] if v1_row else "unknown"
        v1_cov = v1_row["evidence_coverage_pct"] if v1_row else 0.0

        # 使用 V2.0 重新计算
        batch, contents, comments, snap_counts = mv_svc._load_batch_dataset(conn, bid)
        v2 = mv_svc.evaluate_market_rules(contents=contents, comments=comments, snapshot_counts=snap_counts)

        # 追加写入 v2.0 记录（保留 v1.0 历史不覆盖）
        existing_v2 = conn.execute(
            "SELECT id FROM market_validations WHERE batch_id = ? AND COALESCE(topic_id, -1) = ? AND rule_version = ?",
            (bid, tid if tid is not None else -1, mv_svc.RULE_VERSION),
        ).fetchone()
        if not existing_v2:
            conn.execute(
                """INSERT INTO market_validations(
                       project_id, batch_id, task_id, topic_id, rule_version,
                       sample_count, unique_creators_count, platforms_json,
                       validation_grade, evidence_coverage_pct, eight_dims_json,
                       four_signals_json, experimental_market_score, production_fit_json,
                       recommendation, missing_evidence_json, evidence_ids_json,
                       conclusion, llm_meta_json
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    batch["project_id"], bid, batch.get("task_id"), tid, v2["rule_version"],
                    v2["sample_count"], v2["unique_creators_count"],
                    json.dumps(v2["platforms"], ensure_ascii=False),
                    v2["validation_grade"], v2["evidence_coverage_pct"],
                    json.dumps(v2["eight_dims"], ensure_ascii=False),
                    json.dumps(v2["four_signals"], ensure_ascii=False),
                    v2["experimental_market_score"],
                    json.dumps(v2["production_fit"], ensure_ascii=False),
                    v2["recommendation"],
                    json.dumps(v2["missing_evidence"], ensure_ascii=False),
                    json.dumps(v2["evidence_ids"], ensure_ascii=False),
                    v2["conclusion"],
                    json.dumps({"high_perf_summary": v2["high_perf_summary"], "recalc_from_v1": v1_grade}, ensure_ascii=False),
                ),
            )

        # 同步更新关联 topics 的 V2 规则字段（并记入 topic_status_history）
        q_kws = [r["keyword_text"] for r in conn.execute("SELECT DISTINCT keyword_text FROM search_query_runs WHERE batch_id = ?", (bid,)).fetchall() if r["keyword_text"]]
        task_ids = [batch["task_id"]] if batch.get("task_id") else []

        if tid is not None:
            # 衍生选题 #20
            old_tp = conn.execute("SELECT validation_status, project_id FROM topics WHERE id = ?", (tid,)).fetchone()
            if old_tp and old_tp["validation_status"] != v2["validation_grade"]:
                conn.execute(
                    """INSERT INTO topic_status_history(topic_id, project_id, field_name, old_value, new_value, reason, changed_by)
                       VALUES (?, ?, 'validation_status', ?, ?, ?, 'system_v2_recalc')""",
                    (tid, old_tp["project_id"], old_tp["validation_status"], v2["validation_grade"], v2["grade_reason"]),
                )
            conn.execute(
                """UPDATE topics SET
                   validation_status = ?, validation_rule_version = ?, validation_reason = ?,
                   evidence_coverage_pct = ?, four_signals_json = ?,
                   keywords_json = ?, task_ids_json = ?,
                   updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (
                    v2["validation_grade"], v2["rule_version"], v2["grade_reason"],
                    v2["evidence_coverage_pct"], json.dumps(v2["four_signals"], ensure_ascii=False),
                    json.dumps(q_kws, ensure_ascii=False), json.dumps(task_ids, ensure_ascii=False),
                    tid,
                ),
            )
        else:
            # 该批次下的所有 topics：A 类同步 V2 等级，B/C 类保留 unverified 但补齐 keywords_json / task_ids_json / rule_version
            tps = conn.execute("SELECT * FROM topics WHERE batch_id = ?", (bid,)).fetchall()
            for tp in tps:
                if tp["id"] == 20:
                    continue
                if tp["origin_type"] == "A_original_matched":
                    if tp["validation_status"] != v2["validation_grade"]:
                        conn.execute(
                            """INSERT INTO topic_status_history(topic_id, project_id, field_name, old_value, new_value, reason, changed_by)
                               VALUES (?, ?, 'validation_status', ?, ?, ?, 'system_v2_recalc')""",
                            (tp["id"], tp["project_id"], tp["validation_status"], v2["validation_grade"], v2["grade_reason"]),
                        )
                    conn.execute(
                        """UPDATE topics SET
                           validation_status = ?, validation_rule_version = ?, validation_reason = ?,
                           evidence_coverage_pct = ?, four_signals_json = ?,
                           keywords_json = ?, task_ids_json = ?,
                           updated_at = CURRENT_TIMESTAMP
                           WHERE id = ?""",
                        (
                            v2["validation_grade"], v2["rule_version"], v2["grade_reason"],
                            v2["evidence_coverage_pct"], json.dumps(v2["four_signals"], ensure_ascii=False),
                            json.dumps(q_kws, ensure_ascii=False), json.dumps(task_ids, ensure_ascii=False),
                            tp["id"],
                        ),
                    )
                else:
                    # B/C 类一轮未验证，规范化状态为 'U'（保持未验证），同时记录来源关键词与任务
                    conn.execute(
                        """UPDATE topics SET
                           validation_status = CASE WHEN validation_status = 'unverified' THEN 'U' ELSE validation_status END,
                           validation_rule_version = ?,
                           validation_reason = '衍生/灵感选题尚未经独立二次真实检索验证，保持 U（未验证）',
                           keywords_json = ?, task_ids_json = ?,
                           updated_at = CURRENT_TIMESTAMP
                           WHERE id = ?""",
                        (
                            v2["rule_version"],
                            json.dumps(q_kws, ensure_ascii=False), json.dumps(task_ids, ensure_ascii=False),
                            tp["id"],
                        ),
                    )

        comparisons.append({
            "code": t["code"],
            "name": t["name"],
            "batch_id": bid,
            "topic_id": tid,
            "sample_count": v2["sample_count"],
            "unique_creators_count": v2["unique_creators_count"],
            "platforms": v2["platforms"],
            "v1_rule_version": "gcw-mv-v1.0",
            "v1_grade": v1_grade,
            "v1_coverage_pct": v1_cov,
            "v2_rule_version": v2["rule_version"],
            "v2_grade": v2["validation_grade"],
            "v2_coverage_pct": v2["evidence_coverage_pct"],
            "changed": v1_grade != v2["validation_grade"],
            "v2_grade_reason": v2["grade_reason"],
            "high_perf_summary": v2["high_perf_summary"],
            "four_signals": v2["four_signals"],
            "missing_evidence": v2["missing_evidence"],
        })

    # 2. 审计 Phase 3 已生成的聚类与选题重复情况（重点检查 batch#1 玩具 4作品->6聚类、batch#2 创业 4作品->6聚类）
    cluster_audit = []
    for bid in (1, 2, 3, 4):
        b = conn.execute("SELECT title FROM search_batch_runs WHERE id = ?", (bid,)).fetchone()
        cnt_n = conn.execute("SELECT COUNT(DISTINCT content_id) FROM project_content_links WHERE batch_id = ?", (bid,)).fetchone()[0]
        cls = [dict(r) for r in conn.execute("SELECT * FROM topic_clusters WHERE batch_id = ? ORDER BY id ASC", (bid,)).fetchall()]
        over_split = len(cls) > cnt_n
        overlap_pairs = []
        for i in range(len(cls)):
            for j in range(i + 1, len(cls)):
                ev_i = set(json.loads(cls[i]["source_evidence_ids_json"] or "[]"))
                ev_j = set(json.loads(cls[j]["source_evidence_ids_json"] or "[]"))
                sim = _jaccard3(cls[i]["cluster_title"], cls[j]["cluster_title"])
                if (ev_i and ev_i == ev_j) or sim >= 0.35:
                    overlap_pairs.append({
                        "cluster_a": cls[i]["cluster_title"],
                        "cluster_b": cls[j]["cluster_title"],
                        "title_sim": sim,
                        "same_evidence_set": (ev_i == ev_j),
                        "shared_evidence_ids": sorted(ev_i & ev_j),
                    })
        cluster_audit.append({
            "batch_id": bid,
            "batch_title": b["title"] if b else "",
            "unique_contents_count": cnt_n,
            "phase3_clusters_count": len(cls),
            "over_split_detected": over_split,
            "v2_clusters_max_cap": max(1, min(cnt_n, 5)),
            "overlap_pairs_count": len(overlap_pairs),
            "overlap_pairs": overlap_pairs,
        })

    conn.commit()
    conn.close()

    with open(os.path.join(OUT_DIR, "grade_comparison_v1_vs_v2.json"), "w", encoding="utf-8") as f:
        json.dump(comparisons, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT_DIR, "cluster_dedup_audit.json"), "w", encoding="utf-8") as f:
        json.dump(cluster_audit, f, ensure_ascii=False, indent=2)

    print("=== V1 vs V2 整改前后验证等级对照 ===")
    for c in comparisons:
        print(
            f"  {c['name']} (batch#{c['batch_id']}): {c['v1_grade']} -> {c['v2_grade']} "
            f"| hp_items={c['high_perf_summary']['reliable_high_perf_count']} "
            f"| hp_by_plat={c['high_perf_summary']['high_perf_creators_by_platform']} "
            f"| reason={c['v2_grade_reason']}"
        )
    print("=== 聚类过度拆分与重叠审计 ===")
    for ca in cluster_audit:
        print(
            f"  batch#{ca['batch_id']}: contents={ca['unique_contents_count']} -> clusters={ca['phase3_clusters_count']} "
            f"(over_split={ca['over_split_detected']}, v2_cap={ca['v2_clusters_max_cap']}, overlap_pairs={ca['overlap_pairs_count']})"
        )


if __name__ == "__main__":
    main()
