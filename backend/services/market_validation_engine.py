"""SEARCH-PHASE-3 · 真实市场验证、合规评论抽样、主题聚类、反向关键词与新选题发现引擎。

严格铁律：
1. 严禁 Mock、造假评论、虚构指标或为缺失维度暗中补 0 / 默认满分；
2. 跨平台指标分平台独立口径评估，严禁直接相加或横比不同平台播放量；
3. 严格区分四类信号：真实市场关注度 / 用户实际需求 / 购买意愿 / 实际商业收益（无商业收益证据严禁宣称盈利）；
4. 严格区分三类选题来源：A_original_matched / B_market_derived / C_ai_or_human_inspiration；
5. 程序级强制校验所有 source_evidence_ids 真实存在且归属当前允许项目，引用不存在 ID 或跨项目 ID 立即拦截；
6. 衍生选题必须通过独立二次真实检索验证，原关键词爆款证据绝不自动继承；
7. 统一通过 openai.OpenAI 调用工作台已配置的真实 LLM，并完整记录模型名、调用次数与 Token 消耗。
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import time
from typing import Any

from openai import OpenAI

from backend.collectors.comments import fetch_video_comments, summarize_comment_keywords
from backend.config import get_env_config
from backend.db import get_conn
from backend.services import search_batch_engine as batch_svc

RULE_VERSION = "gcw-mv-v2.0"

CLUSTER_CATEGORIES = [
    "热门内容方向",
    "高频观点",
    "用户痛点",
    "高频提问",
    "争议焦点",
    "产品或案例",
    "人群场景",
    "商业信号",
    "潜在内容缺口",
]

PURCHASE_INTENT_RE = re.compile(
    r"(price|cost|buy|purchase|worth it|recommend|link|where to get|how much|多少钱|怎么买|值得买|推荐|价格|费用|报价|链接|哪家|预约|挂号|咨询|套餐)",
    re.IGNORECASE,
)

# 可配置的最低样本、可靠高表现与证据门槛（明确标注：尚待更多真实市场样本校准）
DEFAULT_THRESHOLDS: dict[str, Any] = {
    "calibration_status": "待市场校准（初始工程保守门槛，支持按行业/平台动态配置）",
    "reliable_high_perf_min_views_by_platform": {
        "youtube": 10000,
        "bilibili": 10000,
        "default": 10000,
    },
    "reliable_high_perf_min_outlier": 2.0,
    "reliable_high_perf_min_vtf": 3.0,
    "reliable_high_perf_vtf_min_views": 5000,
    "grade_b_min_high_perf_items": 1,
    "grade_a_min_same_platform_high_perf_creators": 3,
    "grade_a_min_coverage_pct": 50.0,
    "grade_s_min_qualified_platforms": 2,
    "grade_s_min_high_perf_creators_per_platform": 2,
    "grade_s_min_total_high_perf_creators": 5,
    "grade_s_min_total_samples": 6,
    "grade_s_min_coverage_pct": 62.5,
}

SCORING_RULES: dict[str, Any] = {
    "rule_version": RULE_VERSION,
    "calibration_notice": "当前最低样本与可靠高表现门槛为 V2 保守工程初值，尚待更多行业真实市场数据持续校准；证据覆盖率不等于市场价值分数、爆款成功率或商业盈利概率。",
    "configurable_thresholds": DEFAULT_THRESHOLDS,
    "principles": [
        "严格沿用原始等级定义：U=未验证/证据不足；B=至少1个相关且可靠的高表现作品；A=同平台多个独立作者具有可靠优秀表现；S=多平台、多独立作者验证且各主要平台均具可靠高表现与充分证据",
        "S级与A级绝不能仅凭作品数量、作者数量或平台数量自动产生，缺少可靠表现数据或基线/证据不足时严禁评为A或S",
        "证据覆盖率仅表示8维中可观测维度的比例，绝不等同于市场价值分数、爆款成功率或商业盈利概率",
        "跨平台指标独立口径展示与评估，严禁把 YouTube 与 B站等不同平台播放量直接相加或横比",
        "严格区分真实市场关注度、用户实际需求、购买意愿、实际商业收益四类信号；无商业收益证据不得宣称盈利",
        "取消固定输出数量限制：主题聚类与新选题宁缺毋滥，允许返回少量甚至0个，严禁将少量作品强拆为重复聚类",
        "所有聚类、反向词与 A/B 类选题必须经程序级证据 ID 完整性与项目归属校验",
        "衍生选题默认最多自动二次检索至第 2 轮，原关键词爆款证据绝不自动继承为衍生选题已验证",
    ],
    "validation_grades": {
        "S": {
            "label": "S级·多平台充分验证",
            "definition": "多平台、多独立作者验证且证据充分",
            "requirements": "至少2个平台各自具备>=2位独立作者的可靠高表现作品，全局>=5位高表现独立作者、>=6条去重样本、证据覆盖率>=62.5%，且具备有效相对爆款基线或真实用户评论需求证据",
        },
        "A": {
            "label": "A级·同平台多作者验证",
            "definition": "同平台多个独立作者具有优秀表现",
            "requirements": "至少1个平台内有>=3位独立作者具备可靠高表现作品，且证据覆盖率>=50.0%",
        },
        "B": {
            "label": "B级·单点高表现验证",
            "definition": "至少一个相关且可靠的高表现作品",
            "requirements": "至少存在1条具备可靠高表现指标（播放>=平台门槛或有效爆款倍数>=2.0x或低粉高表现>=3.0x）的真实去重作品",
        },
        "U": {
            "label": "U级·未验证/证据不足",
            "definition": "未验证或证据不足",
            "requirements": "无可靠表现数据（如播放量全缺失或未达高表现门槛）、无有效样本或证据不足",
        },
    },
    "experimental_market_value_weights": {
        "absolute_heat": 25,
        "relative_outlier": 20,
        "multi_creator_validation": 20,
        "real_user_demand": 15,
        "cross_platform_consistency": 10,
        "temporal_trend": 10,
    },
    "production_fit_weights": {
        "account_fit": 25,
        "creator_advantage": 20,
        "production_ease": 20,
        "compliance_safety": 15,
        "reusability": 10,
        "monetization_potential": 10,
    },
    "recommendations": ["优先制作", "重点储备", "原创试验", "暂时搁置"],
}


def get_scoring_rules() -> dict[str, Any]:
    return SCORING_RULES


def _normalize_title_for_repost(title: str) -> str:
    t = (title or "").lower()
    t = re.sub(r"[\[\]【】()（）<>《》\"'“”‘’!！?？.,，。:：;；\-_/|·•\s]+", "", t)
    for noise in ("转载", "搬运", "熟肉", "中字", "中文字幕", "原视频", "repost", "reupload", "official"):
        t = t.replace(noise, "")
    return t


def _char_ngrams(text: str, n: int = 3) -> set[str]:
    if not text:
        return set()
    if len(text) <= n:
        return {text}
    return {text[i : i + n] for i in range(len(text) - n + 1)}


def deduplicate_reposts(contents: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """程序级重复转载/搬运识别：保留播放量最高或最早发布者作为代表，返回 (独立作品列表, 转载分组列表)。"""
    sorted_items = sorted(
        contents,
        key=lambda x: (int(x.get("view_count") or -1), -(int(x.get("id") or 0))),
        reverse=True,
    )
    kept: list[dict[str, Any]] = []
    kept_sigs: list[tuple[str, set[str], int]] = []
    repost_groups: list[dict[str, Any]] = []

    for item in sorted_items:
        norm = _normalize_title_for_repost(item.get("title") or "")
        grams = _char_ngrams(norm, 3)
        matched_idx = -1
        for idx, (k_norm, k_grams, _) in enumerate(kept_sigs):
            if norm and norm == k_norm:
                matched_idx = idx
                break
            if len(grams) >= 3 and len(k_grams) >= 3:
                inter = len(grams & k_grams)
                union = len(grams | k_grams)
                if union > 0 and (inter / union) >= 0.72:
                    matched_idx = idx
                    break
        if matched_idx >= 0:
            rep_id = kept_sigs[matched_idx][2]
            existing_grp = next((g for g in repost_groups if g["representative_content_id"] == rep_id), None)
            if not existing_grp:
                existing_grp = {
                    "representative_content_id": rep_id,
                    "representative_title": kept[matched_idx].get("title") or "",
                    "duplicate_content_ids": [],
                }
                repost_groups.append(existing_grp)
            existing_grp["duplicate_content_ids"].append(item["id"])
        else:
            kept.append(item)
            kept_sigs.append((norm, grams, item["id"]))
    return kept, repost_groups


def validate_evidence_ids(
    conn,
    project_id: int,
    content_ids: list[Any] | None = None,
    comment_ids: list[Any] | None = None,
) -> dict[str, Any]:
    """程序级强制证据完整性与跨项目隔离校验。

    规则：
    - content_id 必须真实存在于 contents 表，且属于 project_id（contents.project_id == project_id 或 project_content_links 存在该 project_id 记录）；
    - comment_id 必须真实存在于 comments 表，且其所属 content_id 属于 project_id；
    - 任何不存在 ID 或跨项目 ID 必须被拒绝并记录在审计字段中。
    """
    valid_contents: list[int] = []
    valid_comments: list[int] = []
    rejected_nonexistent: list[dict[str, Any]] = []
    rejected_cross_project: list[dict[str, Any]] = []

    def _parse_int(val: Any) -> int | None:
        if isinstance(val, bool):
            return None
        if isinstance(val, int):
            return val
        if isinstance(val, str):
            m = re.search(r"\d+", val.strip())
            if m:
                return int(m.group(0))
        return None

    seen_c: set[int] = set()
    for raw in content_ids or []:
        cid = _parse_int(raw)
        if cid is None:
            rejected_nonexistent.append({"type": "content", "raw_id": raw, "reason": "非有效整数 ID"})
            continue
        if cid in seen_c:
            continue
        seen_c.add(cid)
        row = conn.execute("SELECT id, project_id FROM contents WHERE id = ?", (cid,)).fetchone()
        if not row:
            rejected_nonexistent.append({"type": "content", "id": cid, "reason": "contents 表中不存在该作品 ID"})
            continue
        allowed = (row["project_id"] == project_id)
        if not allowed:
            link = conn.execute(
                "SELECT 1 FROM project_content_links WHERE project_id = ? AND content_id = ? LIMIT 1",
                (project_id, cid),
            ).fetchone()
            allowed = bool(link)
        if not allowed:
            rejected_cross_project.append({
                "type": "content",
                "id": cid,
                "owner_project_id": row["project_id"],
                "requested_project_id": project_id,
                "reason": "跨项目证据污染拦截：该作品未归属当前项目",
            })
            continue
        valid_contents.append(cid)

    seen_cm: set[int] = set()
    for raw in comment_ids or []:
        cmid = _parse_int(raw)
        if cmid is None:
            rejected_nonexistent.append({"type": "comment", "raw_id": raw, "reason": "非有效整数 ID"})
            continue
        if cmid in seen_cm:
            continue
        seen_cm.add(cmid)
        row = conn.execute("SELECT id, content_id FROM comments WHERE id = ?", (cmid,)).fetchone()
        if not row:
            rejected_nonexistent.append({"type": "comment", "id": cmid, "reason": "comments 表中不存在该评论 ID"})
            continue
        c_row = conn.execute("SELECT id, project_id FROM contents WHERE id = ?", (row["content_id"],)).fetchone()
        allowed = bool(c_row and c_row["project_id"] == project_id)
        if not allowed and c_row:
            link = conn.execute(
                "SELECT 1 FROM project_content_links WHERE project_id = ? AND content_id = ? LIMIT 1",
                (project_id, c_row["id"]),
            ).fetchone()
            allowed = bool(link)
        if not allowed:
            rejected_cross_project.append({
                "type": "comment",
                "id": cmid,
                "content_id": row["content_id"],
                "requested_project_id": project_id,
                "reason": "跨项目评论证据拦截：评论所属作品未归属当前项目",
            })
            continue
        valid_comments.append(cmid)

    return {
        "valid_content_ids": valid_contents,
        "valid_comment_ids": valid_comments,
        "rejected_nonexistent_ids": rejected_nonexistent,
        "rejected_cross_project_ids": rejected_cross_project,
        "integrity_passed": (len(rejected_nonexistent) == 0 and len(rejected_cross_project) == 0),
    }


def _load_batch_dataset(conn, batch_id: int) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], dict[int, int]]:
    """读取单个真实检索批次的元数据、关联作品（含作者指标）、关联评论与快照次数。"""
    batch = conn.execute("SELECT * FROM search_batch_runs WHERE id = ?", (batch_id,)).fetchone()
    if not batch:
        raise ValueError(f"未找到批次：{batch_id}")
    batch_dict = dict(batch)

    rows = conn.execute(
        """SELECT DISTINCT
               c.id, c.project_id, c.platform, c.platform_item_id, c.url, c.title,
               c.thumbnail_url, c.published_at, c.duration_sec,
               c.view_count, c.like_count, c.comment_count, c.outlier_score, c.views_to_followers,
               cr.id AS creator_id, cr.name AS creator_name, cr.platform_creator_id,
               cr.follower_count, cr.baseline_median_views,
               pcl.keyword_text, pcl.rank_no, pcl.data_source
           FROM project_content_links pcl
           JOIN contents c ON c.id = pcl.content_id
           LEFT JOIN creators cr ON cr.id = c.creator_id
           WHERE pcl.batch_id = ? AND pcl.project_id = ?
           ORDER BY COALESCE(c.view_count, -1) DESC, c.id ASC""",
        (batch_id, batch_dict["project_id"]),
    ).fetchall()

    # 若同一 content 在同批次被多个关键词命中，合并 keyword_text
    by_id: dict[int, dict[str, Any]] = {}
    for r in rows:
        d = dict(r)
        cid = d["id"]
        if cid not in by_id:
            d["matched_keywords"] = [d["keyword_text"]] if d.get("keyword_text") else []
            by_id[cid] = d
        else:
            kw = d.get("keyword_text")
            if kw and kw not in by_id[cid]["matched_keywords"]:
                by_id[cid]["matched_keywords"].append(kw)

    contents = list(by_id.values())
    cids = [c["id"] for c in contents]
    comments: list[dict[str, Any]] = []
    snapshot_counts: dict[int, int] = {}

    if cids:
        ph = ",".join("?" for _ in cids)
        c_rows = conn.execute(
            f"""SELECT id, content_id, platform_comment_id, author, text, like_count, is_question
                FROM comments WHERE content_id IN ({ph})
                ORDER BY like_count DESC, id ASC""",
            cids,
        ).fetchall()
        comments = [dict(x) for x in c_rows]

        s_rows = conn.execute(
            f"""SELECT content_id, COUNT(*) AS cnt
                FROM content_metric_snapshots WHERE content_id IN ({ph})
                GROUP BY content_id""",
            cids,
        ).fetchall()
        snapshot_counts = {int(x["content_id"]): int(x["cnt"]) for x in s_rows}

    return batch_dict, contents, comments, snapshot_counts


def sample_comments_for_batch(
    batch_id: int,
    max_videos: int = 2,
    max_per_video: int = 12,
) -> dict[str, Any]:
    """合规抽样真实评论：仅对少量代表性 YouTube 作品抽样，已存在评论直接复用，绝不造假。"""
    conn = get_conn()
    try:
        _, contents, existing_comments, _ = _load_batch_dataset(conn, batch_id)
        by_cid_count: dict[int, int] = {}
        for cm in existing_comments:
            by_cid_count[cm["content_id"]] = by_cid_count.get(cm["content_id"], 0) + 1

        yt_candidates = [c for c in contents if c.get("platform") == "youtube" and c.get("url")]
        sampled_videos: list[dict[str, Any]] = []
        unavailable_videos: list[dict[str, Any]] = []
        newly_inserted = 0

        for item in yt_candidates[:max_videos]:
            cid = item["id"]
            if by_cid_count.get(cid, 0) >= 3:
                sampled_videos.append({
                    "content_id": cid,
                    "title": item.get("title") or "",
                    "status": "reused_existing",
                    "comment_count": by_cid_count[cid],
                })
                continue
            try:
                fetched = fetch_video_comments(item["url"], max_comments=max_per_video)
                if not fetched:
                    unavailable_videos.append({
                        "content_id": cid,
                        "title": item.get("title") or "",
                        "reason": "该视频暂无公开评论或评论区已关闭",
                    })
                    continue
                inserted_here = 0
                for fc in fetched:
                    cur = conn.execute(
                        """INSERT OR IGNORE INTO comments(content_id, platform_comment_id, author, text, like_count, is_question)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (cid, fc["platform_comment_id"], fc["author"], fc["text"], fc["like_count"], fc["is_question"]),
                    )
                    if cur.rowcount > 0:
                        inserted_here += 1
                conn.commit()
                newly_inserted += inserted_here
                sampled_videos.append({
                    "content_id": cid,
                    "title": item.get("title") or "",
                    "status": "fetched_live",
                    "fetched": len(fetched),
                    "newly_inserted": inserted_here,
                })
            except Exception as exc:
                unavailable_videos.append({
                    "content_id": cid,
                    "title": item.get("title") or "",
                    "reason": f"合规抽样失败（已标记缺失，未造假）：{str(exc)[:180]}",
                })

        non_yt = [c for c in contents if c.get("platform") != "youtube"]
        if non_yt:
            unavailable_videos.append({
                "platform": sorted({c.get("platform") for c in non_yt}),
                "count": len(non_yt),
                "reason": "非 YouTube 平台未配置授权评论接口，已如实标记评论缺失",
            })

        return {
            "ok": True,
            "batch_id": batch_id,
            "sampled_videos": sampled_videos,
            "unavailable_videos": unavailable_videos,
            "newly_inserted": newly_inserted,
        }
    finally:
        conn.close()


def evaluate_market_rules(
    contents: list[dict[str, Any]],
    comments: list[dict[str, Any]],
    snapshot_counts: dict[int, int] | None = None,
    production_fit_input: dict[str, Any] | None = None,
    revenue_evidence: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """纯规则层市场验证计算（8 维 + 4 类信号 + U/B/A/S 等级 + 实验性综合分 + 制作适配）。"""
    snapshot_counts = snapshot_counts or {}
    deduped, repost_groups = deduplicate_reposts(contents)
    sample_count = len(deduped)
    raw_count = len(contents)

    missing_evidence: list[str] = []
    if repost_groups:
        dup_n = sum(len(g["duplicate_content_ids"]) for g in repost_groups)
        missing_evidence.append(f"已程序去重 {dup_n} 条疑似重复转载作品，仅按独立作品统计")

    # 独立作者统计（去重后）
    creator_counter: dict[str, int] = {}
    for c in deduped:
        key = str(c.get("creator_id") or c.get("platform_creator_id") or c.get("creator_name") or f"anon_{c['id']}")
        creator_counter[key] = creator_counter.get(key, 0) + 1
    unique_creators_count = len(creator_counter)
    top_creator_share = round(max(creator_counter.values()) / sample_count, 3) if sample_count > 0 else 0.0

    # 按平台分组（严禁跨平台播放量相加或直接横比）
    by_platform: dict[str, list[dict[str, Any]]] = {}
    for c in deduped:
        p = c.get("platform") or "unknown"
        by_platform.setdefault(p, []).append(c)
    platforms = sorted(by_platform.keys())

    # 维度 1：绝对热度（分平台独立口径）
    platform_heat_breakdown: dict[str, Any] = {}
    heat_scores: list[float] = []
    for p, plist in by_platform.items():
        views = [int(x["view_count"]) for x in plist if x.get("view_count") is not None]
        likes = [int(x["like_count"]) for x in plist if x.get("like_count") is not None]
        cmts = [int(x["comment_count"]) for x in plist if x.get("comment_count") is not None]
        if views:
            med_v = float(statistics.median(views))
            max_v = max(views)
            # 对数尺度映射（平台内仅作辅助参考，不跨平台相加）
            p_score = min(100.0, max(10.0, (math.log10(max(med_v, 10.0)) - 2.0) * 25.0))
            heat_scores.append(p_score)
            platform_heat_breakdown[p] = {
                "sample_count": len(plist),
                "views_available_count": len(views),
                "median_views": round(med_v, 1),
                "max_views": max_v,
                "median_likes": round(float(statistics.median(likes)), 1) if likes else None,
                "median_comments": round(float(statistics.median(cmts)), 1) if cmts else None,
                "scale_note": f"{p} 平台独立口径（未与其他平台直接相加）",
            }
        else:
            platform_heat_breakdown[p] = {
                "sample_count": len(plist),
                "views_available_count": 0,
                "median_views": None,
                "max_views": None,
                "scale_note": f"{p} 播放量缺失，未补 0",
            }
    dim1_available = len(heat_scores) > 0 and sample_count > 0
    dim1_score = round(sum(heat_scores) / len(heat_scores), 1) if dim1_available else None
    if not dim1_available:
        missing_evidence.append("绝对热度：所有样本播放量均缺失")

    # 维度 2：相对爆款表现（基线缺失或基线 = 0 时严格不可评估）
    valid_outliers: list[float] = []
    zero_or_missing_baseline = 0
    for c in deduped:
        base = c.get("baseline_median_views")
        oscore = c.get("outlier_score")
        if base is not None and float(base) == 0.0:
            zero_or_missing_baseline += 1
            continue
        if oscore is not None and float(oscore) > 0:
            valid_outliers.append(float(oscore))
        else:
            zero_or_missing_baseline += 1
    dim2_available = len(valid_outliers) > 0
    if dim2_available:
        max_out = max(valid_outliers)
        med_out = float(statistics.median(valid_outliers))
        breakout_cnt = sum(1 for v in valid_outliers if v >= 2.0)
        dim2_score = round(min(100.0, med_out * 22.0 + breakout_cnt * 12.0), 1)
    else:
        max_out = None
        med_out = None
        breakout_cnt = 0
        dim2_score = None
        missing_evidence.append("相对爆款：作者历史基线缺失或基线为 0，无法计算有效爆款倍数（未补 0）")

    # 维度 3：低粉高表现信号（粉丝数未知时绝不设为 0）
    valid_vtf: list[float] = []
    unknown_followers = 0
    for c in deduped:
        fc = c.get("follower_count")
        vc = c.get("view_count")
        if fc is None or int(fc) <= 0:
            unknown_followers += 1
            continue
        if vc is not None:
            ratio = float(vc) / float(fc)
            valid_vtf.append(ratio)
    dim3_available = len(valid_vtf) > 0
    low_follower_hits = sum(1 for r in valid_vtf if r >= 3.0)
    if not dim3_available:
        missing_evidence.append(f"低粉高表现：{unknown_followers}/{sample_count} 条作品作者粉丝数未知，无法评估（未补 0）")

    # 维度 4：多独立作者验证
    dim4_available = sample_count > 0
    if sample_count < 3 or unique_creators_count < 2:
        missing_evidence.append(f"多独立作者验证：有效作品 {sample_count} 条、独立作者 {unique_creators_count} 位，样本或作者数不足")
    dim4_score = None
    if dim4_available:
        base_s = min(100.0, unique_creators_count * 18.0)
        if top_creator_share > 0.6 and sample_count >= 3:
            base_s = max(15.0, base_s - 25.0)
            missing_evidence.append(f"存在单一作者主导风险（最高作者占比 {round(top_creator_share * 100, 1)}%）")
        dim4_score = round(base_s, 1)

    # 维度 5：真实用户需求（严格依赖真实评论，无评论标记缺失）
    valid_comments = [cm for cm in comments if (cm.get("text") or "").strip()]
    question_comments = [cm for cm in valid_comments if cm.get("is_question")]
    purchase_comments = [cm for cm in valid_comments if PURCHASE_INTENT_RE.search(cm.get("text") or "")]
    top_comment_words = summarize_comment_keywords(valid_comments, top_n=12) if valid_comments else []
    dim5_available = len(valid_comments) >= 3
    dim5_score = (
        round(min(100.0, len(valid_comments) * 3.5 + len(question_comments) * 8.0), 1)
        if dim5_available
        else None
    )
    if not dim5_available:
        missing_evidence.append(f"真实用户需求：可用真实评论仅 {len(valid_comments)} 条（不足 3 条），无法可靠评估评论需求")

    # 维度 6：跨平台一致性
    dim6_available = len(platforms) >= 2
    dim6_score = round(min(100.0, 55.0 + len(platforms) * 15.0), 1) if dim6_available else None
    if not dim6_available:
        missing_evidence.append(f"跨平台一致性：当前仅覆盖 {platforms or ['无']} 单一平台，缺少跨平台印证")

    # 维度 7：时效与持续性（单次快照严格声明无法评估增长速度）
    pub_dates = sorted([str(c.get("published_at") or "")[:10] for c in deduped if c.get("published_at")])
    max_snaps = max((snapshot_counts.get(c["id"], 0) for c in deduped), default=0)
    dim7_available = len(pub_dates) >= 2 and max_snaps >= 2
    dim7_score = round(min(100.0, 60.0 + min(40.0, max_snaps * 10.0)), 1) if dim7_available else None
    if max_snaps < 2:
        missing_evidence.append("时效与增长趋势：当前仅单次采集快照，无法评估播放增长速度（未推测趋势）")

    # 维度 8：内容缺口与切入机会（由问题评论密度或低饱和高需求判断，若无评论则留待 AI/人工补充）
    dim8_available = len(question_comments) >= 1 and sample_count >= 2
    gap_note = (
        f"检测到 {len(question_comments)} 条真实提问评论，可针对未满足问题切入"
        if dim8_available
        else "缺少足够真实提问评论，内容缺口仅作待验证假设"
    )

    eight_dims = {
        "absolute_heat": {
            "status": "evaluated" if dim1_available else "unavailable",
            "score": dim1_score,
            "by_platform": platform_heat_breakdown,
        },
        "relative_outlier": {
            "status": "evaluated" if dim2_available else "unavailable",
            "score": dim2_score,
            "valid_count": len(valid_outliers),
            "unavailable_count": zero_or_missing_baseline,
            "median_outlier": round(med_out, 2) if med_out is not None else None,
            "max_outlier": round(max_out, 2) if max_out is not None else None,
            "breakout_2x_count": breakout_cnt,
        },
        "low_follower_breakout": {
            "status": "evaluated" if dim3_available else "unavailable",
            "valid_count": len(valid_vtf),
            "unknown_follower_count": unknown_followers,
            "hits_3x_count": low_follower_hits,
            "max_views_to_followers": round(max(valid_vtf), 2) if valid_vtf else None,
        },
        "multi_creator_validation": {
            "status": "evaluated" if dim4_available else "unavailable",
            "score": dim4_score,
            "raw_sample_count": raw_count,
            "deduped_sample_count": sample_count,
            "repost_groups": repost_groups,
            "unique_creators_count": unique_creators_count,
            "top_creator_share": top_creator_share,
        },
        "real_user_demand": {
            "status": "evaluated" if dim5_available else "unavailable",
            "score": dim5_score,
            "total_comments": len(valid_comments),
            "question_comments_count": len(question_comments),
            "top_keywords": top_comment_words,
        },
        "cross_platform_consistency": {
            "status": "evaluated" if dim6_available else "single_platform_only",
            "score": dim6_score,
            "platforms": platforms,
            "note": "跨平台口径独立展示，不直接比较绝对播放量" if dim6_available else "仅单一平台样本，无跨平台印证",
        },
        "temporal_trend": {
            "status": "evaluated" if dim7_available else "single_snapshot_only",
            "score": dim7_score,
            "max_snapshots_per_content": max_snaps,
            "published_date_range": [pub_dates[0], pub_dates[-1]] if pub_dates else [],
            "note": "具备多期快照可观察走势" if dim7_available else "仅单次快照，无法评估增长速度",
        },
        "content_gap": {
            "status": "evaluated" if dim8_available else "insufficient_evidence",
            "note": gap_note,
        },
    }

    evaluated_dims = sum(1 for d in eight_dims.values() if d["status"] == "evaluated")
    evidence_coverage_pct = round(evaluated_dims / 8.0 * 100.0, 1)

    # 四类信号严格分离
    has_rev = bool(revenue_evidence)
    four_signals = {
        "market_attention": {
            "status": "verified" if (dim1_available and sample_count >= 3 and unique_creators_count >= 2) else "insufficient",
            "summary": f"去重后 {sample_count} 条真实作品，覆盖 {unique_creators_count} 位独立作者、{len(platforms)} 个平台",
        },
        "user_demand": {
            "status": "verified" if dim5_available else "unverified",
            "summary": (
                f"采集到 {len(valid_comments)} 条真实评论，其中 {len(question_comments)} 条含明确提问/痛点"
                if dim5_available
                else "真实评论不足 3 条，用户实际需求尚未充分验证"
            ),
        },
        "purchase_intent": {
            "status": "observed" if len(purchase_comments) >= 1 else "unverified",
            "matched_comment_ids": [c["id"] for c in purchase_comments[:10]],
            "summary": (
                f"在 {len(purchase_comments)} 条真实评论中观察到价格/购买/选购咨询信号"
                if purchase_comments
                else "现有公开数据中未观察到明确购买意愿评论，未作推测"
            ),
        },
        "commercial_revenue": {
            "status": "verified" if has_rev else "unverified",
            "evidence_count": len(revenue_evidence or []),
            "summary": (
                "已提供外部真实商业收益证据"
                if has_rev
                else "无真实商业收益/成交数据，严禁据此宣称该方向已盈利或商业变现成立"
            ),
        },
    }

    # ==================== V2.0 规则化验证等级 U / B / A / S（严守原始定义与可靠表现门槛） ====================
    th = DEFAULT_THRESHOLDS
    min_views_map = th["reliable_high_perf_min_views_by_platform"]
    reliable_high_perf_items: list[dict[str, Any]] = []
    reliable_metric_items_count = 0
    high_perf_creators_by_platform: dict[str, set[str]] = {}
    all_high_perf_creators: set[str] = set()

    for c in deduped:
        plat = c.get("platform") or "unknown"
        vc = c.get("view_count")
        fc = c.get("follower_count")
        base = c.get("baseline_median_views")
        oscore = c.get("outlier_score")

        has_metric = (vc is not None) or (oscore is not None and float(oscore) > 0 and (base is None or float(base) > 0))
        if has_metric:
            reliable_metric_items_count += 1

        plat_min_v = int(min_views_map.get(plat, min_views_map["default"]))
        hit_views = (vc is not None and int(vc) >= plat_min_v)
        hit_outlier = (oscore is not None and float(oscore) >= th["reliable_high_perf_min_outlier"] and (base is None or float(base) > 0))
        hit_vtf = (
            fc is not None and int(fc) > 0 and vc is not None
            and int(vc) >= th["reliable_high_perf_vtf_min_views"]
            and (float(vc) / float(fc)) >= th["reliable_high_perf_min_vtf"]
        )
        if hit_views or hit_outlier or hit_vtf:
            ckey = str(c.get("creator_id") or c.get("platform_creator_id") or c.get("creator_name") or f"anon_{c['id']}")
            reasons_h = []
            if hit_views:
                reasons_h.append(f"播放={vc}>={plat_min_v}")
            if hit_outlier:
                reasons_h.append(f"爆款倍数={oscore}x>={th['reliable_high_perf_min_outlier']}x")
            if hit_vtf:
                reasons_h.append(f"低粉高表现={round(float(vc)/float(fc),2)}x")
            reliable_high_perf_items.append({"content_id": c["id"], "platform": plat, "creator_key": ckey, "reasons": reasons_h})
            high_perf_creators_by_platform.setdefault(plat, set()).add(ckey)
            all_high_perf_creators.add(ckey)

    qualified_platforms_for_s = sorted(
        p for p, cset in high_perf_creators_by_platform.items()
        if len(cset) >= th["grade_s_min_high_perf_creators_per_platform"]
    )
    max_same_platform_hp_creators = max((len(cset) for cset in high_perf_creators_by_platform.values()), default=0)
    has_baseline_or_demand = dim2_available or dim5_available

    if reliable_metric_items_count == 0 or len(reliable_high_perf_items) < th["grade_b_min_high_perf_items"]:
        grade = "U"
        grade_reason = (
            f"无可靠表现数据或无高表现作品（具备指标样本 {reliable_metric_items_count}/{sample_count}，"
            f"达高表现门槛作品 {len(reliable_high_perf_items)} 条），按 V2 规则不得评为 B/A/S，评为 U。"
        )
    elif (
        len(qualified_platforms_for_s) >= th["grade_s_min_qualified_platforms"]
        and len(all_high_perf_creators) >= th["grade_s_min_total_high_perf_creators"]
        and sample_count >= th["grade_s_min_total_samples"]
        and evidence_coverage_pct >= th["grade_s_min_coverage_pct"]
        and has_baseline_or_demand
    ):
        grade = "S"
        grade_reason = (
            f"满足 S 级（多平台多作者充分验证）：{len(qualified_platforms_for_s)} 个平台({', '.join(qualified_platforms_for_s)})"
            f"各自具备>={th['grade_s_min_high_perf_creators_per_platform']}位高表现独立作者，"
            f"全局高表现独立作者 {len(all_high_perf_creators)} 位，覆盖率 {evidence_coverage_pct}%。"
        )
    elif (
        max_same_platform_hp_creators >= th["grade_a_min_same_platform_high_perf_creators"]
        and evidence_coverage_pct >= th["grade_a_min_coverage_pct"]
    ):
        grade = "A"
        grade_reason = (
            f"满足 A 级（同平台多独立作者高表现）：单一平台最高 {max_same_platform_hp_creators} 位独立作者达可靠高表现，"
            f"覆盖率 {evidence_coverage_pct}%；但多平台双边高表现平台仅 {len(qualified_platforms_for_s)} 个({qualified_platforms_for_s})，故不评 S。"
        )
    else:
        grade = "B"
        grade_reason = (
            f"满足 B 级（至少 1 个相关且可靠的高表现作品）：共 {len(reliable_high_perf_items)} 条可靠高表现作品、"
            f"单平台最高 {max_same_platform_hp_creators} 位高表现独立作者（未达 A 级同平台>={th['grade_a_min_same_platform_high_perf_creators']}位或覆盖率>={th['grade_a_min_coverage_pct']}%门槛）。"
        )

    high_perf_summary = {
        "reliable_metric_items_count": reliable_metric_items_count,
        "reliable_high_perf_count": len(reliable_high_perf_items),
        "high_perf_creators_by_platform": {p: len(s) for p, s in high_perf_creators_by_platform.items()},
        "qualified_platforms_for_s": qualified_platforms_for_s,
        "reliable_high_perf_items": reliable_high_perf_items,
        "calibration_status": th["calibration_status"],
    }

    # 实验性市场价值综合分（仅对可评估项重归一化，绝不补 0；仅作实验参考，不等于验证等级）
    weights = SCORING_RULES["experimental_market_value_weights"]
    weighted_sum = 0.0
    used_weight = 0.0
    for dim_key, w in weights.items():
        sc = eight_dims[dim_key].get("score")
        if sc is not None:
            weighted_sum += float(sc) * w
            used_weight += w
    experimental_market_score = round(weighted_sum / used_weight, 1) if used_weight >= 40.0 else None

    # 制作适配度评估（保留缺失项为 None，不默认满分）
    pf_in = production_fit_input or {}
    pf_weights = SCORING_RULES["production_fit_weights"]
    pf_dims: dict[str, Any] = {}
    pf_w_sum = 0.0
    pf_used_w = 0.0
    for k, w in pf_weights.items():
        val = pf_in.get(k)
        if isinstance(val, (int, float)) and 0 <= float(val) <= 100:
            pf_dims[k] = round(float(val), 1)
            pf_w_sum += float(val) * w
            pf_used_w += w
        else:
            pf_dims[k] = None
    pf_score = round(pf_w_sum / pf_used_w, 1) if pf_used_w >= 40.0 else None
    production_fit = {
        "status": "evaluated" if pf_score is not None else "pending_user_input",
        "score": pf_score,
        "dimensions": pf_dims,
        "note": "未填写的制作适配维度保持为空（未补 0 或默认满分），用户可在前端按自身账号条件补充或覆盖推荐",
    }

    # 四档推荐结论
    if grade in ("S", "A") and (pf_score is None or pf_score >= 65):
        recommendation = "优先制作" if grade == "S" else "重点储备"
    elif grade == "B":
        recommendation = "重点储备" if (experimental_market_score or 0) >= 60 else "原创试验"
    else:
        recommendation = "暂时搁置" if sample_count == 0 else "原创试验"

    conclusion = (
        f"[{RULE_VERSION}] 规则验证等级 {grade}（{grade_reason} 证据覆盖 {evaluated_dims}/8 维 = {evidence_coverage_pct}%，覆盖率不等于市场价值分）；"
        f"市场关注度={four_signals['market_attention']['status']}，"
        f"用户需求={four_signals['user_demand']['status']}，"
        f"购买意愿={four_signals['purchase_intent']['status']}，"
        f"商业收益={four_signals['commercial_revenue']['status']}。"
        f"当前建议：{recommendation}。"
    )

    return {
        "rule_version": RULE_VERSION,
        "sample_count": sample_count,
        "raw_sample_count": raw_count,
        "unique_creators_count": unique_creators_count,
        "platforms": platforms,
        "validation_grade": grade,
        "grade_reason": grade_reason,
        "high_perf_summary": high_perf_summary,
        "evidence_coverage_pct": evidence_coverage_pct,
        "eight_dims": eight_dims,
        "four_signals": four_signals,
        "experimental_market_score": experimental_market_score,
        "production_fit": production_fit,
        "recommendation": recommendation,
        "missing_evidence": missing_evidence,
        "evidence_ids": [c["id"] for c in deduped],
        "deduped_contents": deduped,
        "repost_groups": repost_groups,
        "conclusion": conclusion,
    }


def _call_llm_for_discovery(
    *,
    batch_title: str,
    seed_keywords: list[str],
    deduped_contents: list[dict[str, Any]],
    comments: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """调用真实 DeepSeek LLM（经 openai.OpenAI）执行主题聚类、需求归纳、反向关键词与新选题提取。"""
    env = get_env_config()
    api_key = os.getenv("LLM_API_KEY", "").strip()
    base_url = (env.get("llm_base_url") or "https://api.deepseek.com/v1").rstrip("/")
    model = env.get("llm_model") or "deepseek-chat"
    if not api_key:
        raise RuntimeError("未配置 LLM_API_KEY，无法执行真实 AI 主题聚类与反向词发现")

    compact_contents = [
        {
            "content_id": c["id"],
            "platform": c.get("platform"),
            "title": (c.get("title") or "")[:120],
            "creator": (c.get("creator_name") or "")[:40],
            "views": c.get("view_count"),
            "likes": c.get("like_count"),
            "comments_n": c.get("comment_count"),
            "outlier_score": c.get("outlier_score"),
            "keywords": c.get("matched_keywords") or [],
        }
        for c in deduped_contents[:24]
    ]
    compact_comments = [
        {
            "comment_id": cm["id"],
            "content_id": cm["content_id"],
            "likes": cm.get("like_count"),
            "is_question": bool(cm.get("is_question")),
            "text": (cm.get("text") or "")[:200],
        }
        for cm in comments[:25]
    ]

    sys_prompt = """你是严谨的全球内容市场研究分析专家。你只能基于输入 JSON 中真实存在的作品(content_id)和评论(comment_id)进行归纳分析。

严格规则：
1. 严禁编造任何不存在的 content_id 或 comment_id；每条聚类、反向关键词和 A/B 类选题都必须准确列出它所依据的真实 content_id（放进 source_evidence_ids）。
2. 严禁把“真实市场关注度”混同为“商业盈利已验证”；若无成交/收入证据，不得宣称已盈利。
3. 主题聚类 category 必须从以下 9 类中选择：热门内容方向、高频观点、用户痛点、高频提问、争议焦点、产品或案例、人群场景、商业信号、潜在内容缺口。
4. 新选题 origin_type 必须严格区分：
   - A_original_matched：原关键词方向直接被当前真实作品匹配验证的选题
   - B_market_derived：从真实作品/评论中反向发现的市场衍生新选题（必须明确标注它尚未经二次独立搜索验证）
   - C_ai_or_human_inspiration：超出当前直接证据、供原创试验的 AI 灵感选题（不得冒充已验证）
5. 输出必须是合法 JSON 对象，禁止 Markdown 代码块外多余文字。"""

    user_payload = {
        "research_batch": batch_title,
        "seed_keywords": seed_keywords,
        "real_contents": compact_contents,
        "real_comments": compact_comments,
        "required_json_schema": {
            "clusters": [
                {
                    "cluster_title": "简短聚类标题",
                    "category": "9选1",
                    "summary": "基于真实证据的客观归纳",
                    "source_evidence_ids": [123],
                    "comment_evidence_ids": [456],
                }
            ],
            "demand_insights": {
                "summary": "基于真实评论的用户需求总结（若无评论则明确说明暂无评论证据）",
                "pain_points": ["痛点1"],
                "unanswered_questions": ["未满足问题1"],
                "comment_evidence_ids": [456],
            },
            "reverse_keywords": [
                {
                    "keyword": "反向发现的真实高价值关键词（不要与原词完全重复）",
                    "parent_keyword": "触发该发现的原关键词",
                    "discovery_type": "market_discovery 或 ai_inspiration",
                    "source_evidence_ids": [123],
                    "discovery_reason": "从哪些真实标题/评论中发现及原因",
                    "research_dimension": "例如：用户痛点/细分产品/对比测评/商业模式/人群场景",
                    "suggested_platforms": ["youtube", "bilibili"],
                    "missing_evidence": ["尚待二次真实搜索验证该衍生词独立样本量"],
                }
            ],
            "topics": [
                {
                    "topic_title": "具体可执行的内容选题标题",
                    "research_question": "该选题要回答的核心研究/观众问题",
                    "angle": "差异化切入角度",
                    "origin_type": "A_original_matched | B_market_derived | C_ai_or_human_inspiration",
                    "discovery_reason": "为何提出该选题及对应依据",
                    "source_evidence_ids": [123],
                    "suggested_queries": ["用于二次真实搜索的精准检索词1", "检索词2"],
                    "missing_evidence": ["当前缺失证据说明"],
                }
            ],
        },
        "quantity_guidance": {
            "principle": "宁缺毋滥，严禁为凑数量拆分重叠聚类或制造无依据的 AI 联想，允许返回 0 个或少量高可信条目",
            "clusters_max": max(1, min(len(deduped_contents), 5)),
            "reverse_keywords_max": max(1, min(len(deduped_contents) + 1, 5)),
            "topics_max": max(1, min(len(deduped_contents) + 1, 5)),
        },
    }

    t0 = time.time()
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=60.0)
    resp = client.chat.completions.create(
        model=model,
        temperature=0.3,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
    )
    elapsed_ms = int((time.time() - t0) * 1000)
    raw_text = (resp.choices[0].message.content or "").strip()
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if not m:
            raise ValueError(f"模型未返回合法 JSON：{raw_text[:200]}")
        parsed = json.loads(m.group(0))

    usage = getattr(resp, "usage", None)
    llm_meta = {
        "model": getattr(resp, "model", model),
        "calls": 1,
        "prompt_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
        "completion_tokens": getattr(usage, "completion_tokens", None) if usage else None,
        "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
        "elapsed_ms": elapsed_ms,
    }
    return parsed, llm_meta


def run_market_validation_and_discovery(
    batch_id: int,
    *,
    sample_comments: bool = True,
    max_comment_videos: int = 2,
    production_fit_input: dict[str, Any] | None = None,
    use_llm: bool = True,
    override_llm_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """对真实搜索批次执行完整 Phase 3 闭环：评论抽样 -> 8维市场验证 -> 真实LLM聚类/反向词/新选题 -> 程序证据校验 -> 落盘。"""
    comment_sampling_report = (
        sample_comments_for_batch(batch_id, max_videos=max_comment_videos, max_per_video=12)
        if sample_comments
        else {"ok": True, "skipped": True}
    )

    conn = get_conn()
    try:
        batch, contents, comments, snapshot_counts = _load_batch_dataset(conn, batch_id)
        project_id = int(batch["project_id"])
        task_id = batch.get("task_id")

        # 1. 规则层 8 维市场验证
        mv = evaluate_market_rules(
            contents=contents,
            comments=comments,
            snapshot_counts=snapshot_counts,
            production_fit_input=production_fit_input,
        )

        # 提取该批次实际执行过的关键词
        q_rows = conn.execute(
            "SELECT DISTINCT keyword_text FROM search_query_runs WHERE batch_id = ?",
            (batch_id,),
        ).fetchall()
        seed_keywords = [r["keyword_text"] for r in q_rows if r["keyword_text"]]
        primary_parent_kw = seed_keywords[0] if seed_keywords else (batch.get("title") or "")

        # 2. 真实 LLM 聚类、用户需求归纳、反向关键词与新选题提取
        llm_parsed: dict[str, Any] = {}
        llm_meta: dict[str, Any] = {"model": None, "calls": 0, "total_tokens": 0}
        llm_error: str | None = None

        if override_llm_payload is not None:
            llm_parsed = override_llm_payload
            llm_meta = {"model": "injected_test_payload", "calls": 0, "total_tokens": 0}
        elif use_llm and len(mv["deduped_contents"]) > 0:
            try:
                llm_parsed, llm_meta = _call_llm_for_discovery(
                    batch_title=batch.get("title") or f"批次#{batch_id}",
                    seed_keywords=seed_keywords,
                    deduped_contents=mv["deduped_contents"],
                    comments=comments,
                )
            except Exception as exc:
                llm_error = str(exc)
                llm_meta["error"] = llm_error

        # 3. 写入 market_validations
        cur_mv = conn.execute(
            """INSERT INTO market_validations(
                   project_id, batch_id, task_id, topic_id, rule_version,
                   sample_count, unique_creators_count, platforms_json,
                   validation_grade, evidence_coverage_pct, eight_dims_json,
                   four_signals_json, experimental_market_score, production_fit_json,
                   recommendation, missing_evidence_json, evidence_ids_json,
                   conclusion, llm_meta_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                project_id, batch_id, task_id, None, mv["rule_version"],
                mv["sample_count"], mv["unique_creators_count"],
                json.dumps(mv["platforms"], ensure_ascii=False),
                mv["validation_grade"], mv["evidence_coverage_pct"],
                json.dumps(mv["eight_dims"], ensure_ascii=False),
                json.dumps(mv["four_signals"], ensure_ascii=False),
                mv["experimental_market_score"],
                json.dumps(mv["production_fit"], ensure_ascii=False),
                mv["recommendation"],
                json.dumps(mv["missing_evidence"], ensure_ascii=False),
                json.dumps(mv["evidence_ids"], ensure_ascii=False),
                mv["conclusion"],
                json.dumps({**llm_meta, "demand_insights": llm_parsed.get("demand_insights") or {}}, ensure_ascii=False),
            ),
        )
        validation_id = cur_mv.lastrowid

        # 清理同批次旧分析记录以避免重复堆积（保留二次验证独立选题）
        conn.execute("DELETE FROM topic_clusters WHERE batch_id = ? AND project_id = ?", (batch_id, project_id))
        conn.execute("DELETE FROM reverse_keywords WHERE batch_id = ? AND project_id = ? AND round_no = 1", (batch_id, project_id))

        evidence_audit: dict[str, Any] = {
            "total_checked_items": 0,
            "rejected_nonexistent_total": 0,
            "rejected_cross_project_total": 0,
            "rejected_items": [],
        }

        # 4. 校验并写入 topic_clusters
        saved_clusters: list[dict[str, Any]] = []
        for cl in (llm_parsed.get("clusters") or []):
            evidence_audit["total_checked_items"] += 1
            chk = validate_evidence_ids(
                conn,
                project_id,
                cl.get("source_evidence_ids") or [],
                cl.get("comment_evidence_ids") or [],
            )
            if not chk["integrity_passed"]:
                evidence_audit["rejected_nonexistent_total"] += len(chk["rejected_nonexistent_ids"])
                evidence_audit["rejected_cross_project_total"] += len(chk["rejected_cross_project_ids"])
                evidence_audit["rejected_items"].append({
                    "kind": "cluster",
                    "title": cl.get("cluster_title"),
                    "rejected_nonexistent": chk["rejected_nonexistent_ids"],
                    "rejected_cross_project": chk["rejected_cross_project_ids"],
                })
            if not chk["valid_content_ids"] and not chk["valid_comment_ids"]:
                # 没有任何有效真实证据的聚类直接拒绝落盘
                continue
            cat = cl.get("category") if cl.get("category") in CLUSTER_CATEGORIES else "热门内容方向"
            cur_cl = conn.execute(
                """INSERT INTO topic_clusters(
                       project_id, batch_id, cluster_title, category, summary,
                       source_evidence_ids_json, comment_evidence_ids_json, llm_meta_json
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    project_id, batch_id,
                    (cl.get("cluster_title") or "未命名聚类")[:120],
                    cat,
                    (cl.get("summary") or "")[:500],
                    json.dumps(chk["valid_content_ids"], ensure_ascii=False),
                    json.dumps(chk["valid_comment_ids"], ensure_ascii=False),
                    json.dumps({"model": llm_meta.get("model"), "integrity_passed": chk["integrity_passed"]}, ensure_ascii=False),
                ),
            )
            saved_clusters.append({
                "id": cur_cl.lastrowid,
                "cluster_title": (cl.get("cluster_title") or "未命名聚类")[:120],
                "category": cat,
                "summary": (cl.get("summary") or "")[:500],
                "source_evidence_ids": chk["valid_content_ids"],
                "comment_evidence_ids": chk["valid_comment_ids"],
            })

        # 5. 校验并写入 reverse_keywords
        saved_reverse_kws: list[dict[str, Any]] = []
        for rk in (llm_parsed.get("reverse_keywords") or []):
            kw = (rk.get("keyword") or "").strip()
            if not kw:
                continue
            evidence_audit["total_checked_items"] += 1
            chk = validate_evidence_ids(conn, project_id, rk.get("source_evidence_ids") or [], [])
            if not chk["integrity_passed"]:
                evidence_audit["rejected_nonexistent_total"] += len(chk["rejected_nonexistent_ids"])
                evidence_audit["rejected_cross_project_total"] += len(chk["rejected_cross_project_ids"])
                evidence_audit["rejected_items"].append({
                    "kind": "reverse_keyword",
                    "keyword": kw,
                    "rejected_nonexistent": chk["rejected_nonexistent_ids"],
                    "rejected_cross_project": chk["rejected_cross_project_ids"],
                })
            dtype = rk.get("discovery_type") or "market_discovery"
            missing_list = list(rk.get("missing_evidence") or [])
            if not chk["valid_content_ids"]:
                # 若声称市场发现但无有效真实证据，降级为 ai_inspiration 并写明原因
                dtype = "ai_inspiration"
                missing_list.append("未通过程序级真实证据 ID 校验，已自动降级为 AI 灵感待验证")
            if "需二次真实检索独立验证" not in " ".join(missing_list):
                missing_list.append("尚未经二次真实检索独立验证")

            cur_rk = conn.execute(
                """INSERT INTO reverse_keywords(
                       project_id, batch_id, task_id, parent_keyword, keyword,
                       discovery_type, source_evidence_ids_json, discovery_reason,
                       research_dimension, suggested_platforms_json, missing_evidence_json,
                       validation_status, round_no
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                (
                    project_id, batch_id, task_id,
                    (rk.get("parent_keyword") or primary_parent_kw)[:100],
                    kw[:120],
                    dtype,
                    json.dumps(chk["valid_content_ids"], ensure_ascii=False),
                    (rk.get("discovery_reason") or "")[:400],
                    (rk.get("research_dimension") or "市场衍生")[:60],
                    json.dumps(rk.get("suggested_platforms") or ["youtube", "bilibili"], ensure_ascii=False),
                    json.dumps(missing_list, ensure_ascii=False),
                    "unverified",
                ),
            )
            saved_reverse_kws.append({
                "id": cur_rk.lastrowid,
                "keyword": kw[:120],
                "parent_keyword": (rk.get("parent_keyword") or primary_parent_kw)[:100],
                "discovery_type": dtype,
                "source_evidence_ids": chk["valid_content_ids"],
                "discovery_reason": (rk.get("discovery_reason") or "")[:400],
                "research_dimension": (rk.get("research_dimension") or "市场衍生")[:60],
                "suggested_platforms": rk.get("suggested_platforms") or ["youtube", "bilibili"],
                "missing_evidence": missing_list,
                "validation_status": "unverified",
            })

        # 6. 校验并写入 topics + topic_evidence + topic_relations
        saved_topics: list[dict[str, Any]] = []
        a_topic_id: int | None = None
        content_lookup = {c["id"]: c for c in contents}

        for tp in (llm_parsed.get("topics") or []):
            title = (tp.get("topic_title") or "").strip()
            if not title:
                continue
            evidence_audit["total_checked_items"] += 1
            chk = validate_evidence_ids(conn, project_id, tp.get("source_evidence_ids") or [], [])
            if not chk["integrity_passed"]:
                evidence_audit["rejected_nonexistent_total"] += len(chk["rejected_nonexistent_ids"])
                evidence_audit["rejected_cross_project_total"] += len(chk["rejected_cross_project_ids"])
                evidence_audit["rejected_items"].append({
                    "kind": "topic",
                    "title": title,
                    "rejected_nonexistent": chk["rejected_nonexistent_ids"],
                    "rejected_cross_project": chk["rejected_cross_project_ids"],
                })

            origin = tp.get("origin_type") or "B_market_derived"
            if origin not in ("A_original_matched", "B_market_derived", "C_ai_or_human_inspiration"):
                origin = "B_market_derived"
            missing_list = list(tp.get("missing_evidence") or [])

            # 严禁将无有效证据的选题标为 A/B 市场已验证
            if origin in ("A_original_matched", "B_market_derived") and not chk["valid_content_ids"]:
                origin = "C_ai_or_human_inspiration"
                missing_list.append("引用证据未通过程序级存在性/项目归属校验，已强制降级为 C 类灵感选题")

            # 关键原则：
            # - A 类原方向匹配可继承本轮验证等级（U/B/A/S）；
            # - B 类市场衍生选题与 C 类灵感选题绝不继承原关键词爆款等级，强制标为 unverified（待二次验证）！
            if origin == "A_original_matched":
                val_status = mv["validation_grade"]
                prod_status = "已验证" if val_status in ("B", "A", "S") else "证据不足"
                rec = mv["recommendation"]
            else:
                val_status = "unverified"
                prod_status = "待验证"
                rec = "原创试验" if origin == "C_ai_or_human_inspiration" else "待二次验证"
                if "衍生选题尚未经独立二次真实检索验证，不继承原词验证等级" not in missing_list:
                    missing_list.append("衍生选题尚未经独立二次真实检索验证，不继承原词验证等级")

            suggested_q = [str(x).strip() for x in (tp.get("suggested_queries") or []) if str(x).strip()][:4]
            if not suggested_q:
                suggested_q = [title[:40]]

            cur_tp = conn.execute(
                """INSERT INTO topics(
                       project_id, batch_id, task_id, topic_title, research_question,
                       angle, origin_type, discovery_reason, source_evidence_ids_json,
                       suggested_queries_json, missing_evidence_json, validation_status,
                       production_status, recommendation, production_fit_json, round_no
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                (
                    project_id, batch_id, task_id, title[:140],
                    (tp.get("research_question") or "")[:300],
                    (tp.get("angle") or "")[:300],
                    origin,
                    (tp.get("discovery_reason") or "")[:400],
                    json.dumps(chk["valid_content_ids"], ensure_ascii=False),
                    json.dumps(suggested_q, ensure_ascii=False),
                    json.dumps(missing_list, ensure_ascii=False),
                    val_status,
                    prod_status,
                    rec,
                    json.dumps(mv["production_fit"], ensure_ascii=False),
                ),
            )
            tid = cur_tp.lastrowid
            if origin == "A_original_matched" and a_topic_id is None:
                a_topic_id = tid

            # 写入 topic_evidence
            for cid in chk["valid_content_ids"]:
                c_obj = content_lookup.get(cid)
                conn.execute(
                    """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
                       VALUES (?, ?, 'content', ?, ?, ?, ?)""",
                    (
                        tid, project_id, cid,
                        (c_obj.get("url") if c_obj else ""),
                        ((c_obj.get("title") or "")[:180] if c_obj else ""),
                        f"batch#{batch_id}:round1",
                    ),
                )
            conn.execute(
                """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
                   VALUES (?, ?, 'validation', ?, '', ?, ?)""",
                (tid, project_id, validation_id, mv["conclusion"][:200], f"batch#{batch_id}:mv#{validation_id}"),
            )

            # 写入 topic_relations（B 类记录派生溯源）
            if origin == "B_market_derived":
                conn.execute(
                    """INSERT INTO topic_relations(project_id, parent_topic_id, child_topic_id, relation_type, parent_keyword, source_evidence_ids_json, reason)
                       VALUES (?, ?, ?, 'derived', ?, ?, ?)""",
                    (
                        project_id, a_topic_id, tid, primary_parent_kw[:100],
                        json.dumps(chk["valid_content_ids"], ensure_ascii=False),
                        (tp.get("discovery_reason") or "从一轮真实作品反向衍生")[:300],
                    ),
                )

            saved_topics.append({
                "id": tid,
                "topic_title": title[:140],
                "research_question": (tp.get("research_question") or "")[:300],
                "angle": (tp.get("angle") or "")[:300],
                "origin_type": origin,
                "discovery_reason": (tp.get("discovery_reason") or "")[:400],
                "source_evidence_ids": chk["valid_content_ids"],
                "suggested_queries": suggested_q,
                "missing_evidence": missing_list,
                "validation_status": val_status,
                "production_status": prod_status,
                "recommendation": rec,
                "round_no": 1,
            })

        # 把证据审计结果追加回 market_validations.llm_meta_json
        full_llm_meta = {
            **llm_meta,
            "demand_insights": llm_parsed.get("demand_insights") or {},
            "evidence_audit": evidence_audit,
            "comment_sampling": comment_sampling_report,
        }
        conn.execute(
            "UPDATE market_validations SET llm_meta_json = ? WHERE id = ?",
            (json.dumps(full_llm_meta, ensure_ascii=False), validation_id),
        )
        conn.commit()

        return {
            "ok": True,
            "batch_id": batch_id,
            "project_id": project_id,
            "validation_id": validation_id,
            "validation": {k: v for k, v in mv.items() if k != "deduped_contents"},
            "comment_sampling": comment_sampling_report,
            "demand_insights": llm_parsed.get("demand_insights") or {},
            "clusters": saved_clusters,
            "reverse_keywords": saved_reverse_kws,
            "topics": saved_topics,
            "evidence_audit": evidence_audit,
            "llm_meta": llm_meta,
            "llm_error": llm_error,
        }
    finally:
        conn.close()


def launch_second_round_validation(
    topic_id: int,
    *,
    platforms: list[str] | None = None,
    max_queries: int = 2,
    per_query_limit: int = 4,
    auto_start: bool = True,
) -> dict[str, Any]:
    """针对衍生选题发起独立二次真实检索验证（默认最多 2 轮，复用 Phase 2 真实批量引擎）。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到选题：{topic_id}"}
        topic = dict(row)
        if int(topic.get("round_no") or 1) >= 2 and topic.get("second_round_batch_id"):
            return {
                "ok": False,
                "error": "已达到默认最多 2 轮自动拓展上限，请先审阅第 2 轮验证结果或由用户显式决定继续",
                "second_round_batch_id": topic["second_round_batch_id"],
            }
        queries = json.loads(topic.get("suggested_queries_json") or "[]")
        if not queries:
            queries = [topic["topic_title"]]
        queries = queries[:max_queries]
        use_platforms = platforms or ["youtube", "bilibili"]

        kw_items = [{"query_text": q} for q in queries]
        batch_res = batch_svc.create_and_start_batch(
            project_id=int(topic["project_id"]),
            task_id=topic.get("task_id"),
            title=f"二次验证·{topic['topic_title'][:36]}",
            keywords=kw_items,
            platforms=use_platforms,
            budget={
                "max_queries": len(kw_items) * len(use_platforms),
                "per_query_limit": per_query_limit,
                "max_requests": max(8, len(kw_items) * len(use_platforms) * 2),
                "timeout_sec": 30,
            },
            auto_start=auto_start,
        )
        if not batch_res.get("ok"):
            return {"ok": False, "error": batch_res.get("error") or "创建二次检索批次失败"}

        sec_batch_id = int(batch_res["batch_id"])
        conn.execute(
            """UPDATE topics
               SET second_round_batch_id = ?, validation_status = 'validating',
                   production_status = '待验证', round_no = 2, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (sec_batch_id, topic_id),
        )
        conn.commit()
        return {
            "ok": True,
            "topic_id": topic_id,
            "second_round_batch_id": sec_batch_id,
            "queries": queries,
            "platforms": use_platforms,
            "batch": batch_res,
        }
    finally:
        conn.close()


def complete_second_round_validation(
    topic_id: int,
    *,
    sample_comments: bool = True,
    max_comment_videos: int = 2,
) -> dict[str, Any]:
    """仅基于二次检索新获得的真实作品与评论对衍生选题进行独立市场验证（严禁继承一轮原词证据）。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到选题：{topic_id}"}
        topic = dict(row)
        sec_batch_id = topic.get("second_round_batch_id")
        if not sec_batch_id:
            return {"ok": False, "error": "该选题尚未发起二次真实检索"}
    finally:
        conn.close()

    comment_sampling = (
        sample_comments_for_batch(int(sec_batch_id), max_videos=max_comment_videos, max_per_video=12)
        if sample_comments
        else {"ok": True, "skipped": True}
    )

    conn = get_conn()
    try:
        batch, contents, comments, snapshot_counts = _load_batch_dataset(conn, int(sec_batch_id))
        project_id = int(topic["project_id"])

        mv = evaluate_market_rules(contents=contents, comments=comments, snapshot_counts=snapshot_counts)
        cur_mv = conn.execute(
            """INSERT INTO market_validations(
                   project_id, batch_id, task_id, topic_id, rule_version,
                   sample_count, unique_creators_count, platforms_json,
                   validation_grade, evidence_coverage_pct, eight_dims_json,
                   four_signals_json, experimental_market_score, production_fit_json,
                   recommendation, missing_evidence_json, evidence_ids_json,
                   conclusion, llm_meta_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                project_id, int(sec_batch_id), topic.get("task_id"), topic_id, mv["rule_version"],
                mv["sample_count"], mv["unique_creators_count"],
                json.dumps(mv["platforms"], ensure_ascii=False),
                mv["validation_grade"], mv["evidence_coverage_pct"],
                json.dumps(mv["eight_dims"], ensure_ascii=False),
                json.dumps(mv["four_signals"], ensure_ascii=False),
                mv["experimental_market_score"],
                json.dumps(mv["production_fit"], ensure_ascii=False),
                mv["recommendation"],
                json.dumps(mv["missing_evidence"], ensure_ascii=False),
                json.dumps(mv["evidence_ids"], ensure_ascii=False),
                f"[二次独立验证·仅依据批次#{sec_batch_id}] " + mv["conclusion"],
                json.dumps({"comment_sampling": comment_sampling, "inherited_parent_evidence": False}, ensure_ascii=False),
            ),
        )
        validation_id = cur_mv.lastrowid

        new_val_status = mv["validation_grade"] if mv["sample_count"] > 0 else "insufficient"
        new_prod_status = "已验证" if new_val_status in ("B", "A", "S") else "证据不足"
        conn.execute(
            """UPDATE topics
               SET validation_status = ?, production_status = ?, recommendation = ?,
                   missing_evidence_json = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (
                new_val_status,
                new_prod_status,
                mv["recommendation"],
                json.dumps(mv["missing_evidence"], ensure_ascii=False),
                topic_id,
            ),
        )

        # 登记二次检索独立证据（标记 provenance = round2）
        for c in mv["deduped_contents"]:
            conn.execute(
                """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
                   VALUES (?, ?, 'content', ?, ?, ?, ?)""",
                (topic_id, project_id, c["id"], c.get("url") or "", (c.get("title") or "")[:180], f"batch#{sec_batch_id}:round2"),
            )
        conn.execute(
            """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
               VALUES (?, ?, 'validation', ?, '', ?, ?)""",
            (topic_id, project_id, validation_id, mv["conclusion"][:200], f"batch#{sec_batch_id}:round2_mv#{validation_id}"),
        )
        conn.execute(
            """INSERT INTO topic_relations(project_id, parent_topic_id, child_topic_id, relation_type, parent_keyword, source_evidence_ids_json, reason)
               VALUES (?, ?, ?, 'second_round', ?, ?, ?)""",
            (
                project_id, topic_id, topic_id, topic["topic_title"][:100],
                json.dumps(mv["evidence_ids"], ensure_ascii=False),
                f"二次独立真实检索批次#{sec_batch_id}完成，独立验证等级={new_val_status}",
            ),
        )
        conn.commit()

        return {
            "ok": True,
            "topic_id": topic_id,
            "second_round_batch_id": int(sec_batch_id),
            "validation_id": validation_id,
            "inherited_parent_evidence": False,
            "validation_status": new_val_status,
            "production_status": new_prod_status,
            "validation": {k: v for k, v in mv.items() if k != "deduped_contents"},
            "comment_sampling": comment_sampling,
        }
    finally:
        conn.close()


def get_batch_insights(batch_id: int) -> dict[str, Any]:
    """读取批次的完整市场验证、主题聚类、反向关键词、新选题与证据明细。"""
    conn = get_conn()
    try:
        batch = conn.execute("SELECT * FROM search_batch_runs WHERE id = ?", (batch_id,)).fetchone()
        if not batch:
            return {"ok": False, "error": f"未找到批次：{batch_id}"}
        b = dict(batch)

        mv_row = conn.execute(
            "SELECT * FROM market_validations WHERE batch_id = ? AND topic_id IS NULL ORDER BY id DESC LIMIT 1",
            (batch_id,),
        ).fetchone()
        validation = None
        if mv_row:
            d = dict(mv_row)
            for jf in ("platforms_json", "eight_dims_json", "four_signals_json", "production_fit_json", "missing_evidence_json", "evidence_ids_json", "llm_meta_json"):
                d[jf.replace("_json", "")] = json.loads(d.pop(jf) or ("{}" if "dims" in jf or "signals" in jf or "fit" in jf or "meta" in jf else "[]"))
            validation = d

        clusters = []
        for r in conn.execute("SELECT * FROM topic_clusters WHERE batch_id = ? ORDER BY id ASC", (batch_id,)).fetchall():
            d = dict(r)
            d["source_evidence_ids"] = json.loads(d.pop("source_evidence_ids_json") or "[]")
            d["comment_evidence_ids"] = json.loads(d.pop("comment_evidence_ids_json") or "[]")
            d["llm_meta"] = json.loads(d.pop("llm_meta_json") or "{}")
            clusters.append(d)

        reverse_kws = []
        for r in conn.execute("SELECT * FROM reverse_keywords WHERE batch_id = ? ORDER BY id ASC", (batch_id,)).fetchall():
            d = dict(r)
            d["source_evidence_ids"] = json.loads(d.pop("source_evidence_ids_json") or "[]")
            d["suggested_platforms"] = json.loads(d.pop("suggested_platforms_json") or "[]")
            d["missing_evidence"] = json.loads(d.pop("missing_evidence_json") or "[]")
            reverse_kws.append(d)

        topics = []
        for r in conn.execute("SELECT * FROM topics WHERE batch_id = ? ORDER BY is_favorite DESC, id ASC", (batch_id,)).fetchall():
            d = dict(r)
            d["source_evidence_ids"] = json.loads(d.pop("source_evidence_ids_json") or "[]")
            d["suggested_queries"] = json.loads(d.pop("suggested_queries_json") or "[]")
            d["missing_evidence"] = json.loads(d.pop("missing_evidence_json") or "[]")
            d["production_fit"] = json.loads(d.pop("production_fit_json") or "{}")
            ev_rows = conn.execute(
                "SELECT id, evidence_type, ref_id, ref_url, snippet, provenance FROM topic_evidence WHERE topic_id = ? ORDER BY id ASC",
                (d["id"],),
            ).fetchall()
            d["evidence_items"] = [dict(x) for x in ev_rows]
            topics.append(d)

        return {
            "ok": True,
            "batch_id": batch_id,
            "project_id": b["project_id"],
            "batch_title": b["title"],
            "validation": validation,
            "clusters": clusters,
            "reverse_keywords": reverse_kws,
            "topics": topics,
        }
    finally:
        conn.close()


def list_topics(project_id: int | None = None, batch_id: int | None = None, limit: int = 50) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        sql = "SELECT * FROM topics WHERE 1=1"
        params: list[Any] = []
        if project_id is not None:
            sql += " AND project_id = ?"
            params.append(project_id)
        if batch_id is not None:
            sql += " AND batch_id = ?"
            params.append(batch_id)
        sql += " ORDER BY is_favorite DESC, id DESC LIMIT ?"
        params.append(limit)
        out = []
        for r in conn.execute(sql, params).fetchall():
            d = dict(r)
            d["source_evidence_ids"] = json.loads(d.pop("source_evidence_ids_json") or "[]")
            d["suggested_queries"] = json.loads(d.pop("suggested_queries_json") or "[]")
            d["missing_evidence"] = json.loads(d.pop("missing_evidence_json") or "[]")
            d["production_fit"] = json.loads(d.pop("production_fit_json") or "{}")
            out.append(d)
        return out
    finally:
        conn.close()
