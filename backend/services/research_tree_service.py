"""GCW-UAT-FIX-02 · 无限级研究维度树、候选选题假设、人工多平台研究证据管理与受控扩展认证服务。

核心铁律：
1. 取消固定 30 维限制：支持 原始主题 → 一级维度 → 二级维度 → 多级子维度 → 候选选题；
2. 候选选题仅代表待研究假设，绝不冒充已验证市场需求；
3. 人工研究证据缺失数字严格存 NULL（绝不填 0），且收录研究证据绝不自动将作品加入文案工坊（manual_transcript_collected=0）；
4. 确认选题直接沉淀至现有 TopicHub（topics + topic_evidence），不建第二套选题库；
5. 仅记录未来 Skill 所需的最小必要业务操作日志，不开发无关监控系统。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import re
import secrets
import time
import uuid
from typing import Any

from openai import OpenAI

from backend.collectors.media import detect_platform
from backend.config import DATA_DIR, get_env_config
from backend.db import get_conn

SCREENSHOT_DIR = os.path.join(DATA_DIR, "research_screenshots")
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

_EXT_TOKEN_KEY = "gcw_extension_token"
_PLATFORMS_KEY = "gcw_manual_research_platforms_json"
_TREE_PRESETS_KEY = "gcw_research_tree_presets_json"

DEFAULT_RESEARCH_PLATFORMS: list[dict[str, Any]] = [
    {"id": "douyin_hot", "name": "抖音热点榜", "region": "国内", "base_url": "https://douhot.douyin.com/analysis", "search_url_template": "", "supports_query_url": False, "lang": "zh", "sort_order": 1, "note": "抖音官方热点榜分析页，实时查看上升热点与趋势"},
    {"id": "douyin_home", "name": "抖音主页", "region": "国内", "base_url": "https://www.douyin.com/jingxuan/", "search_url_template": "", "supports_query_url": False, "lang": "zh", "sort_order": 2, "note": "抖音精选主页，直接刷爆款与搜索站内真实视频"},
    {"id": "ocean_index", "name": "巨量算数", "region": "国内", "base_url": "https://trendinsight.oceanengine.com/arithmetic-index", "search_url_template": "https://trendinsight.oceanengine.com/arithmetic-index/analysis?keyword={q}", "supports_query_url": True, "lang": "zh", "sort_order": 3, "note": "支持关键词热度与人群画像分析"},
    {"id": "zhihu", "name": "知乎", "region": "国内", "base_url": "https://www.zhihu.com/", "search_url_template": "https://www.zhihu.com/search?type=content&q={q}", "supports_query_url": True, "lang": "zh", "sort_order": 4, "note": "深度问答、真实用户痛点与专业讨论检索"},
    {"id": "baidu_index", "name": "百度指数", "region": "国内", "base_url": "https://index.baidu.com/", "search_url_template": "https://index.baidu.com/v2/main/index.html#/trend/{q}?words={q}", "supports_query_url": True, "lang": "zh", "sort_order": 5, "note": "查看中文搜索趋势（部分数据需在浏览器自行登录百度）"},
    {"id": "baidu_search", "name": "百度搜索", "region": "国内", "base_url": "https://www.baidu.com/", "search_url_template": "https://www.baidu.com/s?wd={q}", "supports_query_url": True, "lang": "zh", "sort_order": 6, "note": "中文全网百科、问答与新闻检索"},
    {"id": "google_trends", "name": "Google Trends", "region": "海外", "base_url": "https://trends.google.com/trends/", "search_url_template": "https://trends.google.com/trends/explore?q={q}", "supports_query_url": True, "lang": "en", "sort_order": 7, "note": "全球相对搜索趋势与上升关联词"},
    {"id": "google_search", "name": "Google Search", "region": "海外", "base_url": "https://www.google.com/", "search_url_template": "https://www.google.com/search?q={q}", "supports_query_url": True, "lang": "en", "sort_order": 8, "note": "全球权威资料、评测文章与问答检索"},
    {"id": "youtube", "name": "YouTube", "region": "海外", "base_url": "https://www.youtube.com/", "search_url_template": "https://www.youtube.com/results?search_query={q}", "supports_query_url": True, "lang": "en", "sort_order": 9, "note": "海外长短视频爆款、评论区痛点与创作者表现"},
    {"id": "xiaohongshu", "name": "小红书", "region": "国内", "base_url": "https://www.xiaohongshu.com/", "search_url_template": "https://www.xiaohongshu.com/search_result?keyword={q}", "supports_query_url": True, "lang": "zh", "sort_order": 10, "note": "真实消费者种草、避坑与评论需求"},
    {"id": "reddit", "name": "Reddit", "region": "海外", "base_url": "https://www.reddit.com/", "search_url_template": "https://www.reddit.com/search/?q={q}", "supports_query_url": True, "lang": "en", "sort_order": 11, "note": "海外真实社区吐槽与深度讨论"},
    {"id": "bilibili", "name": "哔哩哔哩", "region": "国内", "base_url": "https://www.bilibili.com/", "search_url_template": "https://search.bilibili.com/all?keyword={q}", "supports_query_url": True, "lang": "zh", "sort_order": 12, "note": "国内深度中长视频、评测与弹幕评论反馈"},
]


def _read_setting(key: str, default: Any = None) -> Any:
    conn = get_conn()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        if not row or not row["value"]:
            return default
        return json.loads(row["value"])
    except Exception:
        return default
    finally:
        conn.close()


def _write_setting(key: str, val: Any) -> None:
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(val, ensure_ascii=False)),
        )
        conn.commit()
    finally:
        conn.close()


def get_or_create_extension_token() -> str:
    """生成/读取本机 Chrome 扩展受控连接令牌（严禁放开任意外部来源）。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (_EXT_TOKEN_KEY,)).fetchone()
        if row and (row["value"] or "").strip():
            return row["value"].strip()
        token = "gcw_ext_" + secrets.token_hex(16)
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_EXT_TOKEN_KEY, token),
        )
        conn.commit()
        return token
    finally:
        conn.close()


def log_research_action(project_id: int, action_type: str, payload: dict[str, Any], candidate_topic_id: int | None = None) -> None:
    """记录未来 Skill 所需的最小必要业务操作日志。"""
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO research_action_logs(project_id, candidate_topic_id, action_type, payload_json) VALUES (?, ?, ?, ?)",
            (project_id, candidate_topic_id, action_type, json.dumps(payload, ensure_ascii=False)),
        )
        conn.commit()
    finally:
        conn.close()


def _call_llm_json(sys_prompt: str, user_payload: dict[str, Any], temperature: float = 0.4) -> tuple[dict[str, Any], dict[str, Any]]:
    env = get_env_config()
    api_key = os.getenv("LLM_API_KEY", "").strip()
    base_url = (env.get("llm_base_url") or "https://api.deepseek.com/v1").rstrip("/")
    model = env.get("llm_model") or "deepseek-chat"
    if not api_key:
        raise RuntimeError("未配置 LLM_API_KEY，无法调用真实 AI 模型")
    t0 = time.time()
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=60.0)
    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
    )
    elapsed_ms = int((time.time() - t0) * 1000)
    raw = (resp.choices[0].message.content or "").strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            raise ValueError(f"模型未返回合法 JSON：{raw[:200]}")
        parsed = json.loads(m.group(0))
    usage = getattr(resp, "usage", None)
    meta = {
        "model": getattr(resp, "model", model),
        "calls": 1,
        "prompt_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
        "completion_tokens": getattr(usage, "completion_tokens", None) if usage else None,
        "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
        "elapsed_ms": elapsed_ms,
    }
    return parsed, meta


def _get_node_path(conn, node_id: int) -> list[dict[str, Any]]:
    path: list[dict[str, Any]] = []
    cur_id: int | None = node_id
    guard = 0
    while cur_id is not None and guard < 20:
        r = conn.execute("SELECT id, parent_id, level, name, root_topic FROM research_tree_nodes WHERE id = ?", (cur_id,)).fetchone()
        if not r:
            break
        path.append(dict(r))
        cur_id = r["parent_id"]
        guard += 1
    path.reverse()
    return path


# ==================== FIX-02: 无限级研究维度树 ====================
def list_project_tree(project_id: int) -> dict[str, Any]:
    conn = get_conn()
    try:
        nodes = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM research_tree_nodes WHERE project_id = ? ORDER BY level ASC, sort_order ASC, id ASC",
                (project_id,),
            ).fetchall()
        ]
        presets = _read_setting(_TREE_PRESETS_KEY, [])
        # FIX-A04: 严格按 project_id 隔离常用维度组合，杜绝无归属组合跨项目串出
        proj_presets = [p for p in presets if p.get("project_id") == project_id]
        return {"ok": True, "project_id": project_id, "nodes": nodes, "presets": proj_presets}
    finally:
        conn.close()


def get_project_research_state(project_id: int) -> dict[str, Any]:
    """FIX-A04: 读取指定研究项目的独立研究上下文（主题、当前候选选题、搜索词、研究网页地址等）。"""
    key = f"gcw_project_research_state_{int(project_id)}"
    saved = _read_setting(key, None)
    if not isinstance(saved, dict):
        saved = {}
    return {
        "ok": True,
        "project_id": int(project_id),
        "state": {
            "root_input": str(saved.get("root_input") or ""),
            "active_cand_id": saved.get("active_cand_id"),
            "active_query_text": str(saved.get("active_query_text") or ""),
            "active_platform_id": str(saved.get("active_platform_id") or ""),
            "last_browser_url": str(saved.get("last_browser_url") or ""),
            "judge_reason": str(saved.get("judge_reason") or ""),
            "dims_collapsed": bool(saved.get("dims_collapsed", False)),
            "cands_collapsed": bool(saved.get("cands_collapsed", False)),
            "updated_at": str(saved.get("updated_at") or ""),
        },
    }


def save_project_research_state(project_id: int, state: dict[str, Any]) -> dict[str, Any]:
    """FIX-A04: 持久化指定研究项目的独立研究上下文，切换项目时互不覆盖。"""
    key = f"gcw_project_research_state_{int(project_id)}"
    cur = get_project_research_state(project_id)["state"]
    for k in (
        "root_input",
        "active_cand_id",
        "active_query_text",
        "active_platform_id",
        "last_browser_url",
        "judge_reason",
        "dims_collapsed",
        "cands_collapsed",
    ):
        if k in state:
            cur[k] = state[k]
    cur["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    _write_setting(key, cur)
    return {"ok": True, "project_id": int(project_id), "state": cur}


def _norm_semantic_text(s: str) -> str:
    return re.sub(r"[\s\-_/|·•,，。:：;；()（）\[\]【】\"'“”‘’]+", "", (s or "").lower())


def _ngram_jaccard(a: str, b: str, n: int = 2) -> float:
    na, nb = _norm_semantic_text(a), _norm_semantic_text(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
        if len(shorter) >= 2 and len(shorter) / len(longer) >= 0.55:
            return 0.85
    ga = {na[i : i + n] for i in range(max(1, len(na) - n + 1))}
    gb = {nb[i : i + n] for i in range(max(1, len(nb) - n + 1))}
    u = len(ga | gb)
    return len(ga & gb) / u if u else 0.0


def _is_semantic_dup_dim(candidate: str, existing_list: list[str], threshold: float = 0.6) -> bool:
    for ex in existing_list:
        if _ngram_jaccard(candidate, ex, n=2) >= threshold:
            return True
    return False


def create_root_and_expand(project_id: int, root_topic: str, max_children: int = 10) -> dict[str, Any]:
    """GCW-UAT-R4-B 平铺式 AI 维度词生成：支持自定义生成数量（1~30）与近义/重复维度语义去重。"""
    topic = root_topic.strip()
    if not topic:
        return {"ok": False, "error": "原始主题不能为空"}
    max_n = max(1, min(int(max_children or 10), 30))

    conn = get_conn()
    try:
        existing_root = conn.execute(
            "SELECT * FROM research_tree_nodes WHERE project_id = ? AND level = 0 AND name = ? ORDER BY id DESC LIMIT 1",
            (project_id, topic),
        ).fetchone()
        existing_dim_names = [
            r["name"]
            for r in conn.execute(
                "SELECT name FROM research_tree_nodes WHERE project_id = ? AND level = 1",
                (project_id,),
            ).fetchall()
        ]
    finally:
        conn.close()

    sys_prompt = (
        "你是内容市场与选题研究专家。给定一个原始研究主题，请直接平铺生成指定数量的、彼此独立且不重复的【研究维度词】"
        "（例如：人群、价格预算、核心痛点、使用场景、技术路线、避坑对比、持有成本、争议趋势等，必须贴合该主题本质）。\n"
        "严格要求：\n"
        "1. 避免与已有维度词重复或近义换壳；\n"
        "2. 每个维度词精炼（2~12字），不输出层级树；\n"
        "3. 输出严格合法 JSON：{\"dimensions\": [\"维度1\", \"维度2\", ...]}。"
    )
    parsed, meta = _call_llm_json(
        sys_prompt,
        {"root_topic": topic, "requested_count": max_n, "existing_dimensions_to_avoid": existing_dim_names[:40]},
    )
    raw_dims = [str(x).strip()[:28] for x in (parsed.get("dimensions") or []) if str(x).strip()]
    if not raw_dims:
        return {"ok": False, "error": "AI 未返回有效的研究维度词，请重试或手动添加"}

    # 语义去重（同时对比已有维度与本批内部近义词）
    dedup_pool = list(existing_dim_names)
    dim_names: list[str] = []
    dedup_removed = 0
    for dn in raw_dims:
        if len(dim_names) >= max_n:
            break
        if _is_semantic_dup_dim(dn, dedup_pool):
            dedup_removed += 1
            continue
        dedup_pool.append(dn)
        dim_names.append(dn)

    conn = get_conn()
    try:
        if existing_root:
            root_id = existing_root["id"]
        else:
            cur = conn.execute(
                """INSERT INTO research_tree_nodes(project_id, root_topic, parent_id, level, name, node_type, origin, is_selected, sort_order)
                   VALUES (?, ?, NULL, 0, ?, 'root', 'user', 0, 0)""",
                (project_id, topic, topic),
            )
            root_id = cur.lastrowid

        children = []
        for idx, dn in enumerate(dim_names, 1):
            c = conn.execute(
                """INSERT INTO research_tree_nodes(project_id, root_topic, parent_id, level, name, node_type, origin, is_selected, sort_order)
                   VALUES (?, ?, ?, 1, ?, 'dimension', 'ai', 1, ?)""",
                (project_id, topic, root_id, dn, idx),
            )
            children.append(dict(conn.execute("SELECT * FROM research_tree_nodes WHERE id = ?", (c.lastrowid,)).fetchone()))
        root_row = dict(conn.execute("SELECT * FROM research_tree_nodes WHERE id = ?", (root_id,)).fetchone())
        conn.commit()
    finally:
        conn.close()

    log_research_action(
        project_id,
        "dimension_select",
        {"event": "flat_dimensions_generated", "root_topic": topic, "dimensions": dim_names, "dedup_removed": dedup_removed, "llm_meta": meta},
    )
    return {"ok": True, "root": root_row, "children": children, "dedup_removed": dedup_removed, "llm_meta": meta}


def ai_recommend_dimensions(project_id: int, count: int = 4) -> dict[str, Any]:
    """GCW-UAT-R4-B 可解释启发式加权 AI 随机推荐（显式标记为启发式规则，绝不伪称真实市场算法）。
    五因子权重：相关性(0.30) + 差异性(0.25) + 探索价值(0.20) + 历史研究覆盖平衡(0.15) + 随机探索因子(0.10)。
    """
    pick_n = max(1, min(int(count or 4), 20))
    conn = get_conn()
    try:
        dims = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM research_tree_nodes WHERE project_id = ? AND level = 1 ORDER BY id ASC",
                (project_id,),
            ).fetchall()
        ]
        if not dims:
            return {"ok": False, "error": "当前项目尚未生成平铺研究维度词"}
        proj = conn.execute("SELECT name, target_audience FROM projects WHERE id = ?", (project_id,)).fetchone()
        proj_context = f"{proj['name'] if proj else ''} {proj['target_audience'] if proj else ''}"
        cand_rows = conn.execute(
            "SELECT title, selected_node_ids_json FROM research_candidate_topics WHERE project_id = ?",
            (project_id,),
        ).fetchall()
        topic_rows = conn.execute(
            "SELECT topic_title, tags_json FROM topics WHERE project_id = ? AND merged_into_topic_id IS NULL",
            (project_id,),
        ).fetchall()

        # 统计各维度历史使用频次
        used_freq: dict[int, int] = {}
        existing_texts: list[str] = [r["topic_title"] or "" for r in topic_rows]
        for cr in cand_rows:
            existing_texts.append(cr["title"] or "")
            try:
                for nid in json.loads(cr["selected_node_ids_json"] or "[]"):
                    used_freq[int(nid)] = used_freq.get(int(nid), 0) + 1
            except Exception:
                pass
        max_freq = max(used_freq.values(), default=1)

        chosen: list[dict[str, Any]] = []
        chosen_names: list[str] = []
        remaining = list(dims)

        while remaining and len(chosen) < pick_n:
            best_item = None
            best_score = -1.0
            best_detail = None
            for d in remaining:
                dname = d["name"] or ""
                droot = d.get("root_topic") or ""
                # 1. 相关性 (0.30)：与主题/项目名语义重叠及词长信息量
                rel_base = max(_ngram_jaccard(dname, droot, 2), _ngram_jaccard(dname, proj_context, 2))
                relevance = round(min(1.0, 0.55 + rel_base * 0.45 + (0.08 if len(dname) >= 4 else 0.0)), 3)
                # 2. 差异性 (0.25)：与已选维度的最大相似度越低越好
                if chosen_names:
                    max_sim = max(_ngram_jaccard(dname, cn, 2) for cn in chosen_names)
                    diversity = round(max(0.0, 1.0 - max_sim), 3)
                else:
                    diversity = 1.0
                # 3. 探索价值 (0.20)：是否较少出现在既有选题标题中
                hit_cnt = sum(1 for t in existing_texts if dname[:2] and dname[:2].lower() in (t or "").lower())
                exploration = round(max(0.15, 1.0 - min(hit_cnt, 5) * 0.16), 3)
                # 4. 历史研究覆盖平衡 (0.15)：历史勾选次数越少，补齐覆盖得分越高
                freq = used_freq.get(int(d["id"]), 0)
                coverage_balance = round(max(0.1, 1.0 - (freq / max(1, max_freq)) * 0.8), 3)
                # 5. 随机探索因子 (0.10)
                rand_factor = round(random.uniform(0.2, 1.0), 3)

                total = round(
                    0.30 * relevance
                    + 0.25 * diversity
                    + 0.20 * exploration
                    + 0.15 * coverage_balance
                    + 0.10 * rand_factor,
                    4,
                )
                if total > best_score:
                    best_score = total
                    best_item = d
                    best_detail = {
                        "node_id": int(d["id"]),
                        "name": dname,
                        "total_score": total,
                        "factors": {
                            "relevance": relevance,
                            "diversity": diversity,
                            "exploration": exploration,
                            "coverage_balance": coverage_balance,
                            "random_factor": rand_factor,
                        },
                        "reason": (
                            f"启发式综合分 {total:.2f}（相关性 {relevance:.2f} / 差异性 {diversity:.2f} / "
                            f"探索价值 {exploration:.2f} / 覆盖补齐 {coverage_balance:.2f}）"
                        ),
                    }
            if not best_item or not best_detail:
                break
            chosen.append(best_detail)
            chosen_names.append(best_item["name"])
            remaining = [x for x in remaining if x["id"] != best_item["id"]]

        picked_ids = [c["node_id"] for c in chosen]
        conn.execute("UPDATE research_tree_nodes SET is_selected = 0 WHERE project_id = ?", (project_id,))
        if picked_ids:
            ph = ",".join("?" for _ in picked_ids)
            conn.execute(f"UPDATE research_tree_nodes SET is_selected = 1 WHERE project_id = ? AND id IN ({ph})", [project_id] + picked_ids)
        conn.commit()
        return {
            "ok": True,
            "rule_type": "heuristic_rule",
            "rule_disclaimer": "初始启发式加权规则（非真实市场算法），权重：相关性30% + 差异性25% + 探索价值20% + 历史覆盖15% + 随机因子10%",
            "selected_ids": picked_ids,
            "recommendations": chosen,
        }
    finally:
        conn.close()


def add_manual_node(project_id: int, parent_id: int | None, name: str, root_topic: str = "") -> dict[str, Any]:
    nm = name.strip()
    if not nm:
        return {"ok": False, "error": "节点名称不能为空"}
    conn = get_conn()
    try:
        if parent_id is not None:
            p = conn.execute("SELECT * FROM research_tree_nodes WHERE id = ? AND project_id = ?", (parent_id, project_id)).fetchone()
            if not p:
                return {"ok": False, "error": "父节点不存在"}
            lvl = int(p["level"]) + 1
            rt = p["root_topic"]
            ntype = "dimension"
        else:
            lvl = 0
            rt = root_topic.strip() or nm
            ntype = "root"
        cur = conn.execute(
            """INSERT INTO research_tree_nodes(project_id, root_topic, parent_id, level, name, node_type, origin, is_selected, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, 'user', 0, 99)""",
            (project_id, rt, parent_id, lvl, nm[:40], ntype),
        )
        conn.commit()
        row = dict(conn.execute("SELECT * FROM research_tree_nodes WHERE id = ?", (cur.lastrowid,)).fetchone())
        return {"ok": True, "node": row}
    finally:
        conn.close()


def update_node(node_id: int, project_id: int, name: str | None = None, is_selected: int | None = None) -> dict[str, Any]:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM research_tree_nodes WHERE id = ? AND project_id = ?", (node_id, project_id)).fetchone()
        if not row:
            return {"ok": False, "error": "节点不存在"}
        conn.execute(
            "UPDATE research_tree_nodes SET name = COALESCE(?, name), is_selected = COALESCE(?, is_selected) WHERE id = ?",
            (name.strip()[:40] if name and name.strip() else None, is_selected, node_id),
        )
        conn.commit()
        return {"ok": True, "node": dict(conn.execute("SELECT * FROM research_tree_nodes WHERE id = ?", (node_id,)).fetchone())}
    finally:
        conn.close()


def delete_node(node_id: int, project_id: int) -> dict[str, Any]:
    conn = get_conn()
    try:
        conn.execute("DELETE FROM research_tree_nodes WHERE id = ? AND project_id = ?", (node_id, project_id))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def batch_select_nodes(
    project_id: int,
    action: str,
    parent_id: int | None = None,
    random_count: int = 3,
    node_ids: list[int] | None = None,
) -> dict[str, Any]:
    """支持：all(全选) | none(全不选) | invert(反选) | category_on(分类全选) | category_off(分类取消) | random(随机选N个) | set_ids(载入组合)。"""
    conn = get_conn()
    try:
        if action == "all":
            conn.execute("UPDATE research_tree_nodes SET is_selected = 1 WHERE project_id = ? AND level > 0", (project_id,))
        elif action == "none":
            conn.execute("UPDATE research_tree_nodes SET is_selected = 0 WHERE project_id = ?", (project_id,))
        elif action == "invert":
            conn.execute("UPDATE research_tree_nodes SET is_selected = CASE WHEN is_selected=1 THEN 0 ELSE 1 END WHERE project_id = ? AND level > 0", (project_id,))
        elif action in ("category_on", "category_off") and parent_id is not None:
            val = 1 if action == "category_on" else 0
            conn.execute("UPDATE research_tree_nodes SET is_selected = ? WHERE project_id = ? AND (id = ? OR parent_id = ?)", (val, project_id, parent_id, parent_id))
        elif action == "random":
            rows = conn.execute("SELECT id FROM research_tree_nodes WHERE project_id = ? AND level > 0", (project_id,)).fetchall()
            all_ids = [r["id"] for r in rows]
            picked = random.sample(all_ids, min(max(1, random_count), len(all_ids))) if all_ids else []
            conn.execute("UPDATE research_tree_nodes SET is_selected = 0 WHERE project_id = ?", (project_id,))
            if picked:
                ph = ",".join("?" for _ in picked)
                conn.execute(f"UPDATE research_tree_nodes SET is_selected = 1 WHERE id IN ({ph})", picked)
        elif action == "set_ids" and node_ids is not None:
            conn.execute("UPDATE research_tree_nodes SET is_selected = 0 WHERE project_id = ?", (project_id,))
            if node_ids:
                ph = ",".join("?" for _ in node_ids)
                conn.execute(f"UPDATE research_tree_nodes SET is_selected = 1 WHERE project_id = ? AND id IN ({ph})", [project_id] + node_ids)
        conn.commit()
        selected_ids = [r["id"] for r in conn.execute("SELECT id FROM research_tree_nodes WHERE project_id = ? AND is_selected = 1", (project_id,)).fetchall()]
        return {"ok": True, "selected_ids": selected_ids}
    finally:
        conn.close()


def save_tree_preset(project_id: int, name: str, node_ids: list[int]) -> dict[str, Any]:
    nm = name.strip()
    if not nm or not node_ids:
        return {"ok": False, "error": "组合名称与选中节点均不能为空"}
    presets = _read_setting(_TREE_PRESETS_KEY, [])
    item = {"id": f"tp_{uuid.uuid4().hex[:8]}", "project_id": project_id, "name": nm[:40], "node_ids": node_ids, "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    presets.insert(0, item)
    _write_setting(_TREE_PRESETS_KEY, presets[:40])
    return {"ok": True, "preset": item}


# ==================== FIX-02: 基于选定维度树节点生成候选选题假设 ====================
def generate_candidate_topics(
    project_id: int,
    node_ids: list[int],
    *,
    custom_hint: str = "",
    max_count: int = 5,
    mode: str = "append",  # append | single | batch | all
    target_candidate_ids: list[int] | None = None,
) -> dict[str, Any]:
    """GCW-UAT-R4-B 候选选题生成与重生成：
    - 取消 6/15 条硬编码数量限制，支持自定义生成数量（1~30）；
    - 自动排除已被拒绝（status='eliminated'）的选题，避免重复换壳；
    - 支持单条/批量/全部重生成，严格保护已锁定(is_locked=1)、已收录证据(evidence_count>0)或已入 TopicHub(confirmed_topic_id)的选题。
    """
    max_n = max(1, min(int(max_count or 5), 30))
    conn = get_conn()
    try:
        if not node_ids:
            node_ids = [r["id"] for r in conn.execute("SELECT id FROM research_tree_nodes WHERE project_id = ? AND is_selected = 1", (project_id,)).fetchall()]
        if not node_ids:
            return {"ok": False, "error": "请先在维度区勾选至少 1 个研究维度词"}
        paths = []
        root_node_id = None
        for nid in node_ids[:20]:
            p = _get_node_path(conn, nid)
            if p:
                if root_node_id is None:
                    root_node_id = p[0]["id"]
                paths.append(" → ".join(x["name"] for x in p))

        # 查出已拒绝与已保留的选题标题，防止重复生成
        all_cands = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM research_candidate_topics WHERE project_id = ?",
                (project_id,),
            ).fetchall()
        ]
        ev_counts: dict[int, int] = {}
        for r in conn.execute(
            "SELECT candidate_topic_id, COUNT(*) AS cnt FROM manual_research_evidence WHERE project_id = ? GROUP BY candidate_topic_id",
            (project_id,),
        ).fetchall():
            ev_counts[int(r["candidate_topic_id"])] = int(r["cnt"])
    finally:
        conn.close()

    if not paths:
        return {"ok": False, "error": "未找到有效的维度节点"}

    def _is_protected(c: dict[str, Any]) -> bool:
        return bool(c.get("is_locked")) or bool(c.get("confirmed_topic_id")) or ev_counts.get(int(c["id"]), 0) > 0

    # 确定待替换的旧候选选题 ID（严格保护已锁定/已入库/有证据）
    replaceable_ids: list[int] = []
    protected_skipped = 0
    if mode in ("single", "batch") and target_candidate_ids:
        tset = {int(x) for x in target_candidate_ids}
        for c in all_cands:
            if int(c["id"]) in tset:
                if _is_protected(c):
                    protected_skipped += 1
                else:
                    replaceable_ids.append(int(c["id"]))
        if mode == "single" and not replaceable_ids:
            return {"ok": False, "error": "该选题已锁定、已收录证据或已保存至 TopicHub，受保护不能直接覆盖"}
        if replaceable_ids:
            max_n = len(replaceable_ids)
    elif mode == "all":
        for c in all_cands:
            if c.get("status") == "eliminated":
                continue
            if _is_protected(c):
                protected_skipped += 1
            else:
                replaceable_ids.append(int(c["id"]))

    rejected_titles = [c["title"] for c in all_cands if c.get("status") == "eliminated" and c.get("title")]
    kept_titles = [c["title"] for c in all_cands if int(c["id"]) not in set(replaceable_ids) and c.get("title")]
    avoid_titles = (rejected_titles + kept_titles)[:40]

    sys_prompt = """你是资深内容选题研究顾问。请严格围绕用户选定的研究维度词，生成有真实研究价值的【候选选题假设】。
严格原则：
1. 严禁机械拼接关键词；每个候选选题必须是一个具体、有明确受众与冲突/痛点的研究命题；
2. 严禁重复或换壳生成 avoid_titles 中已存在或已被用户拒绝的选题；
3. 明确这些只是【待人工去真实平台验证的研究假设】，不得宣称已被市场验证；
4. 为每个候选选题提供 2~3 个自然中文搜索词（search_queries_zh）和 1~2 个自然英文搜索词（search_queries_en）；
5. 输出严格合法 JSON：{"candidates": [{"title":"...","angle":"...","research_hypothesis":"...","search_queries_zh":["..."],"search_queries_en":["..."]}]}。"""

    # 取消 6/15 条硬限制：若请求数量 > 10，自动分批请求模型避免截断
    generated_raw: list[dict[str, Any]] = []
    total_meta: dict[str, Any] = {"calls": 0, "total_tokens": 0}
    seen_titles = list(avoid_titles)
    remaining_n = max_n
    while remaining_n > 0:
        batch_n = min(remaining_n, 10)
        parsed, meta = _call_llm_json(
            sys_prompt,
            {
                "selected_dimension_paths": paths,
                "custom_hint": custom_hint,
                "count": batch_n,
                "avoid_titles": seen_titles[:40],
            },
        )
        total_meta["calls"] += 1
        total_meta["model"] = meta.get("model")
        total_meta["total_tokens"] += int(meta.get("total_tokens") or 0)
        items = parsed.get("candidates") or []
        if not items:
            break
        added_this_round = 0
        for it in items:
            title = str(it.get("title") or "").strip()[:160]
            if not title:
                continue
            if any(_ngram_jaccard(title, av, 2) >= 0.72 for av in seen_titles):
                continue
            seen_titles.append(title)
            generated_raw.append(it)
            added_this_round += 1
            if len(generated_raw) >= max_n:
                break
        if added_this_round == 0:
            break
        remaining_n = max_n - len(generated_raw)

    if not generated_raw:
        return {"ok": False, "error": "AI 未生成新的不重复候选选题，请调整维度后重试"}

    conn = get_conn()
    saved = []
    try:
        # 替换未受保护的旧候选选题
        if replaceable_ids:
            ph = ",".join("?" for _ in replaceable_ids)
            conn.execute(
                f"DELETE FROM research_candidate_topics WHERE project_id = ? AND id IN ({ph}) AND COALESCE(is_locked,0)=0 AND confirmed_topic_id IS NULL",
                [project_id] + replaceable_ids,
            )

        for it in generated_raw[:max_n]:
            title = str(it.get("title") or "").strip()[:160]
            cur = conn.execute(
                """INSERT INTO research_candidate_topics
                   (project_id, root_node_id, selected_node_ids_json, selected_path_labels_json,
                    title, angle, research_hypothesis, search_queries_zh_json, search_queries_en_json,
                    status, is_locked, llm_meta_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)""",
                (
                    project_id,
                    root_node_id,
                    json.dumps(node_ids, ensure_ascii=False),
                    json.dumps(paths, ensure_ascii=False),
                    title,
                    str(it.get("angle") or "").strip()[:300],
                    str(it.get("research_hypothesis") or "").strip()[:400],
                    json.dumps(it.get("search_queries_zh") or [], ensure_ascii=False),
                    json.dumps(it.get("search_queries_en") or [], ensure_ascii=False),
                    json.dumps(total_meta, ensure_ascii=False),
                ),
            )
            row = dict(conn.execute("SELECT * FROM research_candidate_topics WHERE id = ?", (cur.lastrowid,)).fetchone())
            saved.append(_format_candidate(conn, row))
        conn.commit()
    finally:
        conn.close()

    log_research_action(
        project_id,
        "candidate_generate",
        {"mode": mode, "requested": max_n, "generated": len(saved), "replaced_count": len(replaceable_ids), "protected_skipped": protected_skipped, "llm_meta": total_meta},
    )
    return {
        "ok": True,
        "candidates": saved,
        "replaced_count": len(replaceable_ids),
        "protected_skipped": protected_skipped,
        "llm_meta": total_meta,
    }


def _format_candidate(conn, d: dict[str, Any]) -> dict[str, Any]:
    for jf in ("selected_node_ids_json", "selected_path_labels_json", "search_queries_zh_json", "search_queries_en_json", "llm_meta_json"):
        short = jf.replace("_json", "")
        raw = d.pop(jf, None)
        try:
            d[short] = json.loads(raw) if raw else ({} if short == "llm_meta" else [])
        except Exception:
            d[short] = {} if short == "llm_meta" else []
    ev_cnt = conn.execute("SELECT COUNT(*) FROM manual_research_evidence WHERE candidate_topic_id = ?", (d["id"],)).fetchone()[0]
    d["evidence_count"] = int(ev_cnt)
    return d


def list_candidate_topics(project_id: int) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM research_candidate_topics WHERE project_id = ? ORDER BY CASE status WHEN 'researching' THEN 1 WHEN 'pending' THEN 2 WHEN 'confirmed' THEN 3 ELSE 4 END, id DESC",
            (project_id,),
        ).fetchall()
        return [_format_candidate(conn, dict(r)) for r in rows]
    finally:
        conn.close()


def update_candidate_topic(cid: int, project_id: int, patch: dict[str, Any]) -> dict[str, Any]:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM research_candidate_topics WHERE id = ? AND project_id = ?", (cid, project_id)).fetchone()
        if not row:
            return {"ok": False, "error": "候选选题不存在或不属于当前项目"}
        updates = []
        params: list[Any] = []
        for field in ("title", "angle", "research_hypothesis", "status", "user_notes", "judge_reason"):
            if field in patch and patch[field] is not None:
                updates.append(f"{field} = ?")
                params.append(str(patch[field]).strip())
        if "is_locked" in patch and patch["is_locked"] is not None:
            updates.append("is_locked = ?")
            params.append(1 if int(patch["is_locked"]) else 0)
        for field, col in [("search_queries_zh", "search_queries_zh_json"), ("search_queries_en", "search_queries_en_json")]:
            if field in patch and patch[field] is not None:
                updates.append(f"{col} = ?")
                params.append(json.dumps(patch[field], ensure_ascii=False))
        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(cid)
            conn.execute(f"UPDATE research_candidate_topics SET {', '.join(updates)} WHERE id = ?", params)
            conn.commit()
        updated = _format_candidate(conn, dict(conn.execute("SELECT * FROM research_candidate_topics WHERE id = ?", (cid,)).fetchone()))
    finally:
        conn.close()

    log_research_action(project_id, "candidate_judge" if "status" in patch else "candidate_edit", patch, candidate_topic_id=cid)
    return {"ok": True, "candidate": updated}


# ==================== FIX-03: 10大研究平台导航管理 ====================
def get_research_platforms() -> list[dict[str, Any]]:
    saved = _read_setting(_PLATFORMS_KEY, None)
    if not isinstance(saved, list) or len(saved) == 0:
        _write_setting(_PLATFORMS_KEY, DEFAULT_RESEARCH_PLATFORMS)
        return list(DEFAULT_RESEARCH_PLATFORMS)

    # 平滑升级已持久化平台：更新抖音热点榜新网址，并补齐新增的抖音主页与知乎
    changed = False
    by_id = {str(p.get("id") or ""): p for p in saved}
    if "douyin_hot" in by_id and "douhot.douyin.com" not in str(by_id["douyin_hot"].get("base_url") or ""):
        by_id["douyin_hot"]["name"] = "抖音热点榜"
        by_id["douyin_hot"]["base_url"] = "https://douhot.douyin.com/analysis"
        by_id["douyin_hot"]["note"] = "抖音官方热点榜分析页，实时查看上升热点与趋势"
        changed = True
    for default_item in DEFAULT_RESEARCH_PLATFORMS:
        if default_item["id"] in ("douyin_home", "zhihu") and default_item["id"] not in by_id:
            saved.append(dict(default_item))
            by_id[default_item["id"]] = saved[-1]
            changed = True
    if changed:
        # 按默认顺序重排内置平台，保留用户自定义平台在后
        default_order = {p["id"]: p["sort_order"] for p in DEFAULT_RESEARCH_PLATFORMS}
        for p in saved:
            if p.get("id") in default_order:
                p["sort_order"] = default_order[p["id"]]
        saved = sorted(saved, key=lambda x: int(x.get("sort_order", 99)))
        _write_setting(_PLATFORMS_KEY, saved)
    return sorted(saved, key=lambda x: int(x.get("sort_order", 99)))


def save_research_platforms(platforms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned = []
    for idx, p in enumerate(platforms, 1):
        nm = str(p.get("name") or "").strip()
        if not nm:
            continue
        cleaned.append({
            "id": str(p.get("id") or f"plat_{uuid.uuid4().hex[:6]}"),
            "name": nm[:30],
            "region": str(p.get("region") or "国内")[:12],
            "base_url": str(p.get("base_url") or "").strip(),
            "search_url_template": str(p.get("search_url_template") or "").strip(),
            "supports_query_url": bool(p.get("search_url_template")),
            "lang": str(p.get("lang") or "zh")[:8],
            "sort_order": int(p.get("sort_order") or idx),
            "note": str(p.get("note") or "")[:120],
        })
    _write_setting(_PLATFORMS_KEY, cleaned)
    return cleaned


# ==================== FIX-04: 人工研究证据收录 & 确认沉淀至 TopicHub ====================
def _opt_int(val: Any) -> int | None:
    """严禁将不可获取的数据填写为 0：空字符串或 None 严格返回 None。"""
    if val is None or val == "":
        return None
    try:
        return int(float(val))
    except Exception:
        return None


def capture_manual_evidence(project_id: int, candidate_topic_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    """收录人工研究证据（视频/文章/选中文字/数据快照/可见区截图），严禁自动将作品加入文案工坊。"""
    conn = get_conn()
    try:
        cand = conn.execute("SELECT * FROM research_candidate_topics WHERE id = ? AND project_id = ?", (candidate_topic_id, project_id)).fetchone()
        if not cand:
            return {"ok": False, "error": "候选选题不存在或不属于当前项目"}

        url = (payload.get("url") or "").strip()
        ev_type = (payload.get("evidence_type") or "video").strip()
        title = (payload.get("title") or url or "人工收录研究证据").strip()[:240]
        author = (payload.get("author") or "").strip()[:100]
        platform = (payload.get("platform") or "").strip()
        if not platform and url:
            platform, _ = detect_platform(url)
        platform = platform or "web"

        # 若提交了 Base64 可见区截图，落盘保存
        screenshot_path = (payload.get("screenshot_path") or "").strip()
        b64_url = (payload.get("screenshot_data_url") or "").strip()
        if b64_url and "," in b64_url:
            raw_b64 = b64_url.split(",", 1)[1]
            fname = f"shot_p{project_id}_c{candidate_topic_id}_{uuid.uuid4().hex[:8]}.png"
            fpath = os.path.join(SCREENSHOT_DIR, fname)
            with open(fpath, "wb") as f:
                f.write(base64.b64decode(raw_b64))
            screenshot_path = fpath

        vc = _opt_int(payload.get("view_count"))
        lc = _opt_int(payload.get("like_count"))
        cc = _opt_int(payload.get("comment_count"))
        sc = _opt_int(payload.get("share_count"))
        favc = _opt_int(payload.get("favorite_count"))
        fc = _opt_int(payload.get("follower_count"))

        # 复用 contents 去重表（仅当有有效 URL 且为视频/文章时），严格设 manual_transcript_collected = 0（绝不自动进文案工坊！）
        content_id = None
        if url.startswith(("http://", "https://")) and ev_type in ("video", "article"):
            det_plat, pid_item = detect_platform(url)
            use_plat = platform or det_plat
            existing = conn.execute("SELECT id FROM contents WHERE platform = ? AND platform_item_id = ?", (use_plat, pid_item)).fetchone()
            if existing:
                content_id = existing["id"]
                conn.execute(
                    """UPDATE contents SET
                       title = CASE WHEN length(coalesce(title,''))=0 THEN ? ELSE title END,
                       view_count = COALESCE(?, view_count),
                       like_count = COALESCE(?, like_count),
                       comment_count = COALESCE(?, comment_count)
                       WHERE id = ?""",
                    (title, vc, lc, cc, content_id),
                )
            else:
                cur_c = conn.execute(
                    """INSERT INTO contents(
                           project_id, platform, platform_item_id, url, title, published_at,
                           content_type, view_count, like_count, comment_count, manual_transcript_collected
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                    (project_id, use_plat, pid_item, url, title, (payload.get("published_at") or "").strip(), "article" if ev_type == "article" else "long_video", vc, lc, cc),
                )
                content_id = cur_c.lastrowid

        cur = conn.execute(
            """INSERT INTO manual_research_evidence(
                   project_id, candidate_topic_id, confirmed_topic_id, content_id,
                   evidence_type, url, title, author, platform, published_at,
                   view_count, like_count, comment_count, share_count, favorite_count, follower_count,
                   selected_text, screenshot_path, search_keyword, user_note, data_source, capture_method
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                project_id, candidate_topic_id, cand["confirmed_topic_id"], content_id,
                ev_type, url, title, author, platform, (payload.get("published_at") or "").strip(),
                vc, lc, cc, sc, favc, fc,
                (payload.get("selected_text") or "").strip()[:2000],
                screenshot_path,
                (payload.get("search_keyword") or "").strip()[:120],
                (payload.get("user_note") or "").strip()[:1000],
                (payload.get("data_source") or "chrome_sidepanel").strip()[:60],
                (payload.get("capture_method") or "manual_form").strip()[:40],
            ),
        )
        ev_id = cur.lastrowid
        if cand["status"] == "pending":
            conn.execute("UPDATE research_candidate_topics SET status = 'researching', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (candidate_topic_id,))
        conn.commit()
        ev_row = dict(conn.execute("SELECT * FROM manual_research_evidence WHERE id = ?", (ev_id,)).fetchone())
    finally:
        conn.close()

    log_research_action(
        project_id,
        "evidence_capture",
        {"evidence_id": ev_id, "evidence_type": ev_type, "platform": platform, "url": url, "search_keyword": payload.get("search_keyword") or ""},
        candidate_topic_id=candidate_topic_id,
    )
    return {"ok": True, "evidence": ev_row}


def list_manual_evidence(project_id: int, candidate_topic_id: int | None = None) -> list[dict[str, Any]]:
    conn = get_conn()
    try:
        if candidate_topic_id is not None:
            rows = conn.execute(
                "SELECT * FROM manual_research_evidence WHERE project_id = ? AND candidate_topic_id = ? ORDER BY id DESC",
                (project_id, candidate_topic_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM manual_research_evidence WHERE project_id = ? ORDER BY id DESC LIMIT 100",
                (project_id,),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def confirm_candidate_to_topic_hub(
    candidate_topic_id: int,
    project_id: int,
    *,
    title: str | None = None,
    angle: str | None = None,
    judge_reason: str = "",
) -> dict[str, Any]:
    """用户确认候选选题：将最终选题、关联视频/文章/评论/数据/笔记沉淀至现有 TopicHub（绝不建第二套选题库）。"""
    conn = get_conn()
    try:
        cand = conn.execute("SELECT * FROM research_candidate_topics WHERE id = ? AND project_id = ?", (candidate_topic_id, project_id)).fetchone()
        if not cand:
            return {"ok": False, "error": "候选选题不存在或不属于当前项目"}

        final_title = (title or cand["title"]).strip()[:160]
        final_angle = (angle or cand["angle"] or "").strip()[:300]
        paths = json.loads(cand["selected_path_labels_json"] or "[]")
        kws = list(dict.fromkeys(json.loads(cand["search_queries_zh_json"] or "[]") + json.loads(cand["search_queries_en_json"] or "[]")))
        ev_rows = [dict(r) for r in conn.execute("SELECT * FROM manual_research_evidence WHERE candidate_topic_id = ? AND project_id = ? ORDER BY id ASC", (candidate_topic_id, project_id)).fetchall()]
        content_ids = list(dict.fromkeys([e["content_id"] for e in ev_rows if e.get("content_id")]))

        notes_parts = []
        if cand["user_notes"]:
            notes_parts.append(cand["user_notes"])
        if judge_reason.strip():
            notes_parts.append(f"[确认理由] {judge_reason.strip()}")
        for e in ev_rows:
            if e.get("user_note") or e.get("selected_text"):
                notes_parts.append(f"[{e['platform']}/{e['evidence_type']}] {e.get('title','')}: {e.get('user_note') or e.get('selected_text')[:120]}")
        combined_notes = "\n".join(notes_parts)[:1500]

        if cand["confirmed_topic_id"]:
            topic_id = int(cand["confirmed_topic_id"])
            conn.execute(
                """UPDATE topics SET
                   topic_title = ?, angle = ?, keywords_json = ?, source_evidence_ids_json = ?,
                   user_notes = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (final_title, final_angle, json.dumps(kws, ensure_ascii=False), json.dumps(content_ids, ensure_ascii=False), combined_notes, topic_id),
            )
        else:
            cur_t = conn.execute(
                """INSERT INTO topics(
                       project_id, batch_id, task_id, topic_title, research_question, angle,
                       tags_json, keywords_json, origin_type, discovery_reason,
                       source_evidence_ids_json, suggested_queries_json, missing_evidence_json,
                       validation_status, validation_rule_version, validation_reason,
                       production_status, user_notes, round_no
                   ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, 'content_comment_discovery', ?, ?, ?, ?, 'U', 'manual_research_v1', ?, '待制作', ?, 1)""",
                (
                    project_id, final_title,
                    cand["research_hypothesis"] or "",
                    final_angle,
                    json.dumps(["人工多平台研究"], ensure_ascii=False),
                    json.dumps(kws, ensure_ascii=False),
                    f"研究维度路径：{'；'.join(paths)}（人工收录 {len(ev_rows)} 条证据）",
                    json.dumps(content_ids, ensure_ascii=False),
                    json.dumps(kws[:4], ensure_ascii=False),
                    json.dumps(["人工研究已确认入库，市场验证等级保留 U（如需规则评级可补充批量指标）"], ensure_ascii=False),
                    f"人工多平台深度研究确认（共 {len(ev_rows)} 条真实证据；{judge_reason.strip() or '用户判断具备创作价值'}）",
                    combined_notes,
                ),
            )
            topic_id = cur_t.lastrowid

        # 将全部已收录证据关联至 topic_evidence
        for e in ev_rows:
            if e.get("content_id"):
                conn.execute(
                    """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
                       VALUES (?, ?, 'content', ?, ?, ?, ?)""",
                    (topic_id, project_id, e["content_id"], e.get("url") or "", (e.get("title") or "")[:180], f"manual_sidepanel:{e['platform']}"),
                )
            else:
                conn.execute(
                    """INSERT OR IGNORE INTO topic_evidence(topic_id, project_id, evidence_type, ref_id, ref_url, snippet, provenance)
                       VALUES (?, ?, 'manual_evidence', ?, ?, ?, ?)""",
                    (topic_id, project_id, e["id"], e.get("url") or "", (e.get("selected_text") or e.get("title") or "")[:180], f"manual_sidepanel:{e['platform']}"),
                )

        conn.execute("UPDATE manual_research_evidence SET confirmed_topic_id = ? WHERE candidate_topic_id = ?", (topic_id, candidate_topic_id))
        conn.execute(
            "UPDATE research_candidate_topics SET status = 'confirmed', confirmed_topic_id = ?, title = ?, angle = ?, judge_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (topic_id, final_title, final_angle, judge_reason.strip(), candidate_topic_id),
        )
        conn.execute(
            """INSERT INTO topic_status_history(topic_id, project_id, field_name, old_value, new_value, reason, changed_by)
               VALUES (?, ?, 'production_status', '候选假设', '待制作', ?, 'user')""",
            (topic_id, project_id, f"人工多平台研究确认沉淀至 TopicHub（关联 {len(ev_rows)} 条证据）"),
        )
        conn.commit()
    finally:
        conn.close()

    log_research_action(project_id, "topic_confirm", {"topic_id": topic_id, "title": final_title, "evidence_count": len(ev_rows), "judge_reason": judge_reason}, candidate_topic_id=candidate_topic_id)
    return {"ok": True, "topic_id": topic_id, "candidate_topic_id": candidate_topic_id, "evidence_count": len(ev_rows)}
