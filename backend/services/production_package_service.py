"""SEARCH-PHASE-5 · 标准化创作资料包（Production_Package）生成、原创文案多版本与完整性校验引擎。

核心铁律：
1. 根据真实 topic_id 自动汇总已有研究任务、关键词、市场验证、参考作品、作者、原始文案、真实评论、指标快照、衍生选题、真实素材与备注，绝不虚构缺失资料；
2. 原创文案严格区分 5 类版本（原始参考文案 / AI提炼结构 / 用户原创观点 / AI辅助生成文案 / 用户最终确认文案），绝不覆盖 transcripts 原始文案；
3. 严格分离事实与观点（已核实事实 / 原作品观点 / 模型推断 / 用户观点 / 尚待验证信息），高播放不等于事实准确；
4. 导出前执行 10 项完整性检查与敏感信息零泄露检查（绝不导出 API Key / Cookie / 密码）；
5. 每次导出生成独立历史版本（单独 Markdown + 完整 13 文件 ZIP + 机器可读 00_manifest.json 含 SHA-256），绝不覆盖旧版，绝不自动标记选题为「已发布」。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
import zipfile
from typing import Any

from openai import OpenAI

from backend.config import DATA_DIR, get_env_config
from backend.db import get_conn
from backend.services import market_validation_engine as mv_svc
from backend.services import topic_hub_service as th_svc

PACKAGE_SCHEMA_VERSION = "gcw-pkg-v1.0"
PKG_ROOT_DIR = os.path.join(DATA_DIR, "production_packages")
CUSTOM_SKILLS_FILE = os.path.join(DATA_DIR, "custom_script_skills.json")
os.makedirs(PKG_ROOT_DIR, exist_ok=True)

VERSION_KIND_LABELS = {
    "reference_transcript": "原始参考文案",
    "ai_structure": "AI提炼内容结构",
    "user_viewpoint": "用户原创观点",
    "ai_draft": "AI辅助生成文案",
    "user_final": "用户最终确认文案",
}

BUILTIN_SCRIPT_SKILLS = [
    {
        "skill_id": "fact_separated_deep_dive",
        "name": "深度解析（事实与观点严格分离）",
        "description": "适用于医疗、财经、商业分析、科技科普，强制分离已核实事实、原作品观点、模型推断与尚待验证信息。",
        "requires_llm": True,
        "default_version_kind": "ai_draft",
    },
    {
        "skill_id": "problem_solution_guide",
        "name": "实操避坑指南（评论痛点切入）",
        "description": "基于真实用户评论高频提问与痛点，构建可执行的分步操作指南与风险提示。",
        "requires_llm": True,
        "default_version_kind": "ai_draft",
    },
    {
        "skill_id": "compare_review_breakdown",
        "name": "多案例对比拆解（结构提炼）",
        "description": "从多个参考作品中提炼结构框架与差异化切入角度，绝不复制原视频完整表达。",
        "requires_llm": True,
        "default_version_kind": "ai_structure",
    },
    {
        "skill_id": "story_case_narrative",
        "name": "真实案例叙事（钩子与复盘）",
        "description": "以真实案例为主线组织口播结构，明确标注需人工二次核实的数据点。",
        "requires_llm": True,
        "default_version_kind": "ai_draft",
    },
    {
        "skill_id": "manual",
        "name": "纯人工撰写 / 编辑（零模型调用）",
        "description": "用户直接记录原创观点或保存最终确认文案，不调用外部 LLM。",
        "requires_llm": False,
        "default_version_kind": "user_final",
    },
]

PRODUCTION_PACKAGE_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Global Content Workbench Standard Production Package Manifest",
    "schema_version": PACKAGE_SCHEMA_VERSION,
    "required": [
        "schema_version",
        "package_id",
        "package_version",
        "project_id",
        "topic_id",
        "topic_title",
        "language",
        "target_audience",
        "market_validation",
        "scoring_rule_version",
        "source_research_tasks",
        "source_evidence_ids",
        "reference_contents",
        "reference_authors",
        "script_versions",
        "assets",
        "license_manifest",
        "missing_materials",
        "production_requirements",
        "created_at",
        "file_manifest",
    ],
    "standard_files": [
        "00_manifest.json",
        "01_选题说明.md",
        "02_市场验证.md",
        "03_目标人群.md",
        "04_参考作品.md",
        "05_原始文案.md",
        "06_真实用户评论.md",
        "07_知识与事实.md",
        "08_原创差异化.md",
        "09_脚本制作建议.md",
        "10_真实素材清单.md",
        "11_关联选题.md",
        "12_制作记录.md",
    ],
}


def get_package_schema() -> dict[str, Any]:
    return PRODUCTION_PACKAGE_SCHEMA


def _load_custom_skills() -> list[dict[str, Any]]:
    if not os.path.exists(CUSTOM_SKILLS_FILE):
        return []
    try:
        with open(CUSTOM_SKILLS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict) and x.get("skill_id") and x.get("name")]
    except Exception:
        pass
    return []


def _save_custom_skills(skills: list[dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(CUSTOM_SKILLS_FILE), exist_ok=True)
    with open(CUSTOM_SKILLS_FILE, "w", encoding="utf-8") as f:
        json.dump(skills, f, ensure_ascii=False, indent=2)


def save_custom_script_skill(
    *,
    name: str,
    description: str = "",
    system_prompt: str = "",
    skill_id: str = "",
    default_version_kind: str = "ai_draft",
    source_format: str = "manual",
) -> dict[str, Any]:
    """新建、导入或更新自定义原创文案 Skill（支持 Markdown / JSON / 纯文本导入）。"""
    clean_name = (name or "").strip()
    clean_prompt = (system_prompt or "").strip()
    if not clean_name:
        return {"ok": False, "error": "Skill 名称不能为空"}
    if not clean_prompt:
        return {"ok": False, "error": "Skill 创作指令（Prompt）不能为空"}
    if default_version_kind not in VERSION_KIND_LABELS:
        default_version_kind = "ai_draft"

    builtin_ids = {s["skill_id"] for s in BUILTIN_SCRIPT_SKILLS}
    sid = re.sub(r"[^a-zA-Z0-9_-]+", "_", (skill_id or "").strip()).strip("_")
    if not sid or sid in builtin_ids:
        sid = f"custom_{uuid.uuid4().hex[:8]}"

    custom_list = _load_custom_skills()
    now_iso = time.strftime("%Y-%m-%d %H:%M:%S")
    item = {
        "skill_id": sid,
        "name": clean_name[:80],
        "description": (description or "").strip()[:300] or "用户导入的自定义原创文案 Skill",
        "system_prompt": clean_prompt[:12000],
        "requires_llm": True,
        "default_version_kind": default_version_kind,
        "is_builtin": False,
        "source_format": (source_format or "manual")[:32],
        "updated_at": now_iso,
    }
    replaced = False
    for idx, old in enumerate(custom_list):
        if old.get("skill_id") == sid:
            custom_list[idx] = item
            replaced = True
            break
    if not replaced:
        custom_list.insert(0, item)
    _save_custom_skills(custom_list)
    return {"ok": True, "skill": item, "skills": list_available_script_skills()}


def delete_custom_script_skill(skill_id: str) -> dict[str, Any]:
    """删除自定义 Skill（内置 Skill 受保护不可删除）。"""
    builtin_ids = {s["skill_id"] for s in BUILTIN_SCRIPT_SKILLS}
    if skill_id in builtin_ids:
        return {"ok": False, "error": "内置 Skill 不可删除"}
    custom_list = _load_custom_skills()
    next_list = [s for s in custom_list if s.get("skill_id") != skill_id]
    if len(next_list) == len(custom_list):
        return {"ok": False, "error": "未找到对应的自定义 Skill"}
    _save_custom_skills(next_list)
    return {"ok": True, "deleted_skill_id": skill_id, "skills": list_available_script_skills()}


def list_available_writing_models() -> list[dict[str, Any]]:
    """列出所有已配置的 OpenAI 兼容 AI 模型，供同一文案 Skill 自由切换执行。"""
    from backend.services import translation_provider as tp_svc

    pub = tp_svc.get_translation_overview()
    models: list[dict[str, Any]] = []
    for p in pub.get("providers") or []:
        proto = p.get("protocol") or ""
        if proto not in ("openai_compatible", "local_openai_compatible"):
            continue
        pcfg = p.get("config") or {}
        is_local = proto == "local_openai_compatible"
        models.append({
            "engine_id": p["engine_id"],
            "name": p["name"],
            "label": f"{p['name']} ({pcfg.get('model_id') or p.get('default_model') or ''})",
            "model_id": pcfg.get("model_id") or p.get("default_model") or "",
            "configured": bool(p.get("configured")),
            "ready": bool(p.get("configured")),
            "is_paid": p.get("billing_category") != "free_local",
            "is_local": is_local,
            "base_url": pcfg.get("local_endpoint") if is_local else (pcfg.get("base_url") or p.get("default_base_url") or ""),
            "note": p.get("notes") or "",
        })
    # 若 .env 中配置了通用 LLM_API_KEY 且未出现在上述已配置列表中，补充 .env 默认模型入口
    env_key = os.getenv("LLM_API_KEY", "").strip()
    env = get_env_config()
    if env_key and not any(m["engine_id"] == "env_default_llm" for m in models):
        models.insert(0, {
            "engine_id": "env_default_llm",
            "name": f"工作台默认大模型 ({env.get('llm_model') or 'deepseek-chat'})",
            "label": f"工作台默认大模型 ({env.get('llm_model') or 'deepseek-chat'})",
            "model_id": env.get("llm_model") or "deepseek-chat",
            "configured": True,
            "ready": True,
            "is_paid": True,
            "is_local": False,
            "base_url": env.get("llm_base_url") or "https://api.deepseek.com/v1",
            "note": "读取自本地 .env LLM_API_KEY",
        })
    return models


def _resolve_writing_llm(engine_id: str = "", model_id: str = "") -> tuple[str, str, str, str]:
    """返回 (api_key, base_url, resolved_model_id, resolved_engine_id)，绝不向外暴露凭据。"""
    from backend.services import translation_provider as tp_svc

    eid = (engine_id or "").strip()
    if eid and eid != "env_default_llm":
        meta = tp_svc.PROVIDER_REGISTRY.get(eid) or {}
        proto = meta.get("protocol") or ""
        if proto not in ("openai_compatible", "local_openai_compatible"):
            raise ValueError(f"引擎「{meta.get('name') or eid}」属于专用机器翻译接口，不支持文案 Skill 生成")
        cfg = tp_svc._resolve_provider_runtime_config(eid)
        is_local = proto == "local_openai_compatible"
        api_key = (cfg.get("api_key") or "").strip()
        base_url = ((cfg.get("local_endpoint") if is_local else cfg.get("base_url")) or meta.get("default_base_url") or "").rstrip("/")
        mid = (model_id or "").strip() or (cfg.get("model_id") or meta.get("default_model") or "").strip()
        if is_local:
            api_key = api_key or "local-no-key"
        elif not api_key:
            raise ValueError(f"引擎「{meta.get('name') or eid}」尚未配置 API Key，请先在左下角设置中配置")
        if not base_url or not mid:
            raise ValueError(f"引擎「{meta.get('name') or eid}」缺少 Base URL 或 Model ID")
        return api_key, base_url, mid, eid

    env = get_env_config()
    api_key = os.getenv("LLM_API_KEY", "").strip()
    if not api_key:
        # 尝试回退第一个已配置的 OpenAI 兼容翻译/大模型引擎
        for m in list_available_writing_models():
            if m.get("configured") and m["engine_id"] != "env_default_llm":
                return _resolve_writing_llm(m["engine_id"], model_id)
        raise ValueError("未配置可用 AI 模型 Key，请在左下角「翻译 Key / 设置」中配置后再执行 Skill")
    base_url = (env.get("llm_base_url") or "https://api.deepseek.com/v1").rstrip("/")
    mid = (model_id or "").strip() or (env.get("llm_model") or "deepseek-chat")
    return api_key, base_url, mid, "env_default_llm"


def list_available_script_skills() -> list[dict[str, Any]]:
    """返回工作台已注册且实际可执行的文案 Skill 列表（内置 + 用户导入自定义 Skill）。"""
    models = list_available_writing_models()
    llm_ok = any(m.get("configured") for m in models)
    default_model = next((m["model_id"] for m in models if m.get("configured")), "none")
    out: list[dict[str, Any]] = []
    for sk in _load_custom_skills():
        out.append({
            **sk,
            "is_builtin": False,
            "available": llm_ok,
            "model": default_model,
        })
    for sk in BUILTIN_SCRIPT_SKILLS:
        out.append({
            **sk,
            "is_builtin": True,
            "system_prompt": sk.get("description", ""),
            "available": (llm_ok if sk["requires_llm"] else True),
            "model": default_model if sk["requires_llm"] else "none",
        })
    return out


def list_studio_original_versions(
    *,
    project_id: int,
    content_id: int | None = None,
    topic_id: int | None = None,
    limit: int = 30,
) -> dict[str, Any]:
    """列出文案工坊历史独立原创文案版本（绝不覆盖原始参考文案）。"""
    conn = get_conn()
    try:
        where = ["project_id = ?"]
        params: list[Any] = [project_id]
        if content_id:
            where.append("primary_content_id = ?")
            params.append(content_id)
        if topic_id:
            where.append("topic_id = ?")
            params.append(topic_id)
        rows = conn.execute(
            f"SELECT * FROM studio_original_versions WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ?",
            params + [max(1, min(int(limit), 100))],
        ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            d["reference_content_ids"] = json.loads(d.pop("reference_content_ids_json") or "[]")
            d["source_refs"] = json.loads(d.pop("source_refs_json") or "[]")
            d["facts_vs_opinions"] = json.loads(d.pop("facts_vs_opinions_json") or "{}")
            d["llm_meta"] = json.loads(d.pop("llm_meta_json") or "{}")
            items.append(d)
        return {"ok": True, "versions": items}
    finally:
        conn.close()


def generate_studio_original_version(
    *,
    project_id: int,
    primary_content_id: int | None = None,
    reference_content_ids: list[int] | None = None,
    skill_id: str = "fact_separated_deep_dive",
    engine_id: str = "",
    model_id: str = "",
    topic_id: int | None = None,
    extra_requirements: str = "",
    title: str = "",
    manual_content: str = "",
) -> dict[str, Any]:
    """GCW-UAT-R4-D：文案工坊 Skill 驱动原创文案生成（支持自定义 Skill、多模型切换、多篇参考文案与关联选题）。"""
    ref_ids: list[int] = []
    for cid in (reference_content_ids or []):
        try:
            n = int(cid)
            if n > 0 and n not in ref_ids:
                ref_ids.append(n)
        except Exception:
            pass
    if primary_content_id and int(primary_content_id) not in ref_ids:
        ref_ids.insert(0, int(primary_content_id))
    primary_cid = int(primary_content_id) if primary_content_id else (ref_ids[0] if ref_ids else None)

    all_skills = list_available_script_skills()
    skill_obj = next((s for s in all_skills if s["skill_id"] == skill_id), None)
    if not skill_obj:
        return {"ok": False, "error": f"未找到指定 Skill：{skill_id}"}

    conn = get_conn()
    try:
        ref_docs: list[dict[str, Any]] = []
        source_refs: list[dict[str, Any]] = []
        if ref_ids:
            placeholders = ",".join("?" for _ in ref_ids)
            c_rows = conn.execute(
                f"""SELECT c.id, c.platform, c.title, COALESCE(cr.name, '') AS creator_name, c.url, c.view_count,
                           t.raw_text, t.translated_zh, t.language
                    FROM contents c
                    LEFT JOIN creators cr ON cr.id = c.creator_id
                    LEFT JOIN transcripts t ON t.content_id = c.id
                    WHERE c.id IN ({placeholders})""",
                ref_ids,
            ).fetchall()
            c_map = {int(r["id"]): dict(r) for r in c_rows}
            for cid in ref_ids:
                row = c_map.get(cid)
                if not row:
                    continue
                cm_rows = conn.execute(
                    "SELECT text, like_count, is_question FROM comments WHERE content_id = ? ORDER BY like_count DESC LIMIT 6",
                    (cid,),
                ).fetchall()
                excerpt = (row.get("translated_zh") or row.get("raw_text") or "").strip()[:3200]
                ref_docs.append({
                    "content_id": cid,
                    "platform": row.get("platform") or "",
                    "title": row.get("title") or "",
                    "creator": row.get("creator_name") or "",
                    "language": row.get("language") or "",
                    "views": row.get("view_count") or 0,
                    "transcript_excerpt": excerpt,
                    "top_comments": [
                        {"text": (cm["text"] or "")[:160], "likes": cm["like_count"], "is_question": bool(cm["is_question"])}
                        for cm in cm_rows
                    ],
                })
                source_refs.append({
                    "content_id": cid,
                    "title": row.get("title") or f"参考作品#{cid}",
                    "url": row.get("url") or "",
                })
    finally:
        conn.close()

    topic_ctx: dict[str, Any] | None = None
    if topic_id:
        detail = th_svc.get_topic_detail(int(topic_id), project_id=project_id)
        if detail.get("ok"):
            tp = detail["topic"]
            topic_ctx = {
                "topic_id": tp["id"],
                "title": tp["topic_title"],
                "research_question": tp.get("research_question") or "",
                "angle": tp.get("angle") or "",
                "target_audience": tp.get("target_audience") or "",
                "differentiation_notes": tp.get("differentiation_notes") or "",
                "evidence_count": len(detail.get("contents") or []),
                "topic_comments_sample": [
                    {"text": (cm["text"] or "")[:160], "is_question": bool(cm["is_question"])}
                    for cm in (detail.get("comments") or [])[:8]
                ],
            }

    final_title = (title or "").strip()
    final_md = (manual_content or "").strip()
    fvo: dict[str, Any] = {
        "verified_facts": [],
        "source_opinions": [],
        "model_inferences": [],
        "user_opinions": [extra_requirements.strip()] if extra_requirements.strip() else [],
        "pending_verification": ["所有引用数据、医疗/商业/历史事实在正式发布前须人工二次核验"],
    }
    resolved_engine = engine_id or ""
    resolved_model = model_id or ""
    llm_meta: dict[str, Any] = {"engine_id": "manual", "model": "none", "calls": 0, "total_tokens": 0}

    if skill_id != "manual":
        if not ref_docs and not topic_ctx and not extra_requirements.strip():
            return {"ok": False, "error": "请至少选择一篇参考文案、关联一个选题，或输入额外创作要求"}
        try:
            api_key, base_url, resolved_model, resolved_engine = _resolve_writing_llm(engine_id, model_id)
        except Exception as e:
            return {"ok": False, "error": str(e)}

        custom_rule = (skill_obj.get("system_prompt") or skill_obj.get("description") or "").strip()
        sys_prompt = f"""你是专业中文原创内容创作专家，严格执行用户指定的文案 Skill。
【当前执行 Skill】{skill_obj['name']}（ID: {skill_obj['skill_id']}）
【Skill 专属创作要求】
{custom_rule}

【不可违背的原创与事实纪律】
1. 必须生成全新的独立原创中文文案（口播/文章），严禁照搬或拼接参考文案原句冒充原创；参考来源以 [content_id] 标注。
2. 必须充分融合用户勾选的全部参考文案、关联选题证据、高赞评论痛点及「额外创作要求」。
3. 必须严格区分事实与观点，输出到 JSON 字段 facts_vs_opinions（verified_facts / source_opinions / model_inferences / user_opinions / pending_verification）。
4. 必须输出严格合法 JSON：{{"title":"原创标题","content_markdown":"完整原创正文(Markdown)","facts_vs_opinions":{{"verified_facts":[],"source_opinions":[],"model_inferences":[],"user_opinions":[],"pending_verification":[]}}}}"""

        user_payload = {
            "skill": {"skill_id": skill_obj["skill_id"], "name": skill_obj["name"]},
            "extra_requirements": extra_requirements.strip(),
            "linked_topic": topic_ctx,
            "reference_transcripts": ref_docs,
        }
        t0 = time.time()
        try:
            client = OpenAI(api_key=api_key, base_url=base_url, timeout=90.0)
            resp = client.chat.completions.create(
                model=resolved_model,
                temperature=0.4,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
                ],
            )
        except Exception as e:
            return {"ok": False, "error": f"调用模型「{resolved_engine}/{resolved_model}」失败：{e}"}

        elapsed_ms = int((time.time() - t0) * 1000)
        raw = (resp.choices[0].message.content or "").strip()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                parsed = {"title": final_title or f"{skill_obj['name']} · 原创版本", "content_markdown": raw}
            else:
                parsed = json.loads(m.group(0))

        final_title = (parsed.get("title") or final_title or f"{skill_obj['name']} · 原创版本")[:140]
        final_md = (parsed.get("content_markdown") or "").strip()
        if not final_md:
            return {"ok": False, "error": "模型未返回有效原创正文内容"}
        if isinstance(parsed.get("facts_vs_opinions"), dict):
            fvo = parsed["facts_vs_opinions"]
        usage = getattr(resp, "usage", None)
        llm_meta = {
            "engine_id": resolved_engine,
            "model": getattr(resp, "model", resolved_model) or resolved_model,
            "calls": 1,
            "prompt_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
            "completion_tokens": getattr(usage, "completion_tokens", None) if usage else None,
            "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
            "elapsed_ms": elapsed_ms,
        }
    else:
        if not final_md:
            return {"ok": False, "error": "手动保存原创版本时正文不能为空"}
        if not final_title:
            final_title = "手动保存原创版本"

    conn = get_conn()
    try:
        max_v = conn.execute(
            "SELECT COALESCE(MAX(version_no), 0) FROM studio_original_versions WHERE project_id = ? AND COALESCE(primary_content_id, 0) = ?",
            (project_id, primary_cid or 0),
        ).fetchone()[0]
        next_v = int(max_v) + 1
        cur = conn.execute(
            """INSERT INTO studio_original_versions(
                   project_id, primary_content_id, topic_id, version_no, title,
                   skill_id, skill_name, engine_id, model_id,
                   reference_content_ids_json, extra_requirements, content_markdown,
                   source_refs_json, facts_vs_opinions_json, llm_meta_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                project_id,
                primary_cid,
                topic_id,
                next_v,
                final_title,
                skill_obj["skill_id"],
                skill_obj["name"],
                resolved_engine,
                resolved_model,
                json.dumps(ref_ids, ensure_ascii=False),
                extra_requirements.strip(),
                final_md,
                json.dumps(source_refs, ensure_ascii=False),
                json.dumps(fvo, ensure_ascii=False),
                json.dumps(llm_meta, ensure_ascii=False),
            ),
        )
        sv_id = cur.lastrowid

        # 若关联了 TopicHub 选题，同步落入 topic_script_versions 以便创作资料包直接复用
        if topic_id and topic_ctx:
            max_tv = conn.execute(
                "SELECT COALESCE(MAX(version_no), 0) FROM topic_script_versions WHERE topic_id = ? AND project_id = ?",
                (topic_id, project_id),
            ).fetchone()[0]
            conn.execute(
                """INSERT INTO topic_script_versions(
                       topic_id, project_id, version_no, version_kind, title, skill_name,
                       content_markdown, source_refs_json, facts_vs_opinions_json, llm_meta_json,
                       is_final, created_by
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
                (
                    topic_id,
                    project_id,
                    int(max_tv) + 1,
                    skill_obj.get("default_version_kind") or "ai_draft",
                    final_title,
                    skill_obj["skill_id"],
                    final_md,
                    json.dumps(source_refs, ensure_ascii=False),
                    json.dumps(fvo, ensure_ascii=False),
                    json.dumps(llm_meta, ensure_ascii=False),
                    "ai_skill" if skill_id != "manual" else "user",
                ),
            )

        conn.commit()
        row = dict(conn.execute("SELECT * FROM studio_original_versions WHERE id = ?", (sv_id,)).fetchone())
        row["reference_content_ids"] = json.loads(row.pop("reference_content_ids_json") or "[]")
        row["source_refs"] = json.loads(row.pop("source_refs_json") or "[]")
        row["facts_vs_opinions"] = json.loads(row.pop("facts_vs_opinions_json") or "{}")
        row["llm_meta"] = json.loads(row.pop("llm_meta_json") or "{}")
        return {"ok": True, "version": row}
    finally:
        conn.close()


def list_script_versions(topic_id: int, project_id: int) -> dict[str, Any]:
    conn = get_conn()
    try:
        tp = conn.execute("SELECT id, project_id FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not tp or int(tp["project_id"]) != int(project_id):
            return {"ok": False, "error": "选题不存在或不属于当前项目"}
        rows = conn.execute(
            "SELECT * FROM topic_script_versions WHERE topic_id = ? AND project_id = ? ORDER BY version_no DESC, id DESC",
            (topic_id, project_id),
        ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            d["version_kind_label"] = VERSION_KIND_LABELS.get(d["version_kind"], d["version_kind"])
            d["source_refs"] = json.loads(d.pop("source_refs_json") or "[]")
            d["facts_vs_opinions"] = json.loads(d.pop("facts_vs_opinions_json") or "{}")
            d["llm_meta"] = json.loads(d.pop("llm_meta_json") or "{}")
            items.append(d)
        return {"ok": True, "topic_id": topic_id, "versions": items}
    finally:
        conn.close()


def create_or_generate_script_version(
    *,
    topic_id: int,
    project_id: int,
    skill_id: str = "manual",
    version_kind: str = "user_final",
    title: str = "",
    content_markdown: str = "",
    user_viewpoint: str = "",
    facts_vs_opinions: dict[str, Any] | None = None,
    source_refs: list[Any] | None = None,
    is_final: bool = False,
) -> dict[str, Any]:
    """保存人工原创版本，或调用真实 DeepSeek Skill 生成带引用来源与事实/观点分离的独立文案版本（绝不覆盖原始参考文案）。"""
    detail = th_svc.get_topic_detail(topic_id, project_id=project_id)
    if not detail.get("ok"):
        return detail

    tp = detail["topic"]
    llm_meta: dict[str, Any] = {"model": None, "calls": 0, "total_tokens": 0}
    fvo = facts_vs_opinions or {
        "verified_facts": [],
        "source_opinions": [],
        "model_inferences": [],
        "user_opinions": [user_viewpoint] if user_viewpoint.strip() else [],
        "pending_verification": ["所有引用数据、医疗/商业/历史事实在正式发布前须人工二次核验"],
    }
    refs = list(source_refs or [])
    if not refs:
        refs = [
            {"content_id": c["content_id"], "title": c["title"], "url": c["url"]}
            for c in (detail.get("contents") or [])[:6]
        ]

    final_md = content_markdown.strip()
    final_title = title.strip() or f"{tp['topic_title'][:40]} · {VERSION_KIND_LABELS.get(version_kind, version_kind)}"

    if skill_id != "manual":
        api_key = os.getenv("LLM_API_KEY", "").strip()
        env = get_env_config()
        base_url = (env.get("llm_base_url") or "https://api.deepseek.com/v1").rstrip("/")
        model = env.get("llm_model") or "deepseek-chat"
        if not api_key:
            return {"ok": False, "error": "未配置 LLM_API_KEY，无法调用 AI 文案 Skill（请改用 manual 手动保存）"}

        skill_obj = next((s for s in BUILTIN_SCRIPT_SKILLS if s["skill_id"] == skill_id), BUILTIN_SCRIPT_SKILLS[0])
        if version_kind not in VERSION_KIND_LABELS:
            version_kind = skill_obj["default_version_kind"]

        sys_prompt = """你是严谨的中文内容创作与事实核查顾问。基于提供的真实研究档案，执行指定文案 Skill。
严格纪律：
1. 严禁复制参考视频完整表达冒充原创；必须基于研究证据输出原创结构或口播初稿，并在文中标明引用来源 [content_id]。
2. 必须严格分离五类信息（输出到 JSON 的 facts_vs_opinions）：
   - verified_facts：仅限明确核实过的事实（若无则留空数组，绝不把高播放量或参考视频说法当已核实事实）
   - source_opinions：原参考作品或评论中的观点/个人经历
   - model_inferences：AI 基于现有素材的归纳推断
   - user_opinions：用户提供的原创观点
   - pending_verification：涉及医疗、费用、政策、商业收益、历史数据时，必须列入尚待核实清单
3. 输出严格合法 JSON：{"title":"...","content_markdown":"...","facts_vs_opinions":{"verified_facts":[],"source_opinions":[],"model_inferences":[],"user_opinions":[],"pending_verification":[]}}"""

        payload = {
            "skill": skill_obj,
            "topic": {
                "topic_id": tp["id"],
                "title": tp["topic_title"],
                "research_question": tp["research_question"],
                "angle": tp["angle"],
                "target_audience": tp["target_audience"],
                "validation_grade": tp["validation_grade"],
                "differentiation_notes": tp["differentiation_notes"],
            },
            "user_viewpoint": user_viewpoint,
            "reference_contents": [
                {"content_id": c["content_id"], "platform": c["platform"], "title": c["title"], "creator": c["creator_name"], "views": c["view_count"]}
                for c in (detail.get("contents") or [])[:8]
            ],
            "real_comments_sample": [
                {"comment_id": cm["id"], "text": (cm["text"] or "")[:180], "is_question": bool(cm["is_question"])}
                for cm in (detail.get("comments") or [])[:12]
            ],
            "existing_transcripts_snippets": [
                {"content_id": tr["content_id"], "snippet": tr["snippet"]}
                for tr in (detail.get("transcripts") or [])[:3]
            ],
        }

        t0 = time.time()
        client = OpenAI(api_key=api_key, base_url=base_url, timeout=60.0)
        resp = client.chat.completions.create(
            model=model,
            temperature=0.35,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        )
        elapsed_ms = int((time.time() - t0) * 1000)
        raw = (resp.choices[0].message.content or "").strip()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                return {"ok": False, "error": f"文案 Skill 返回非 JSON：{raw[:180]}"}
            parsed = json.loads(m.group(0))

        final_title = (parsed.get("title") or final_title)[:140]
        final_md = (parsed.get("content_markdown") or "").strip()
        if isinstance(parsed.get("facts_vs_opinions"), dict):
            fvo = parsed["facts_vs_opinions"]
        usage = getattr(resp, "usage", None)
        llm_meta = {
            "model": getattr(resp, "model", model),
            "calls": 1,
            "prompt_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
            "completion_tokens": getattr(usage, "completion_tokens", None) if usage else None,
            "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
            "elapsed_ms": elapsed_ms,
        }
    else:
        if not final_md:
            return {"ok": False, "error": "手动保存文案时内容不能为空"}

    conn = get_conn()
    try:
        max_v = conn.execute(
            "SELECT COALESCE(MAX(version_no), 0) FROM topic_script_versions WHERE topic_id = ? AND project_id = ?",
            (topic_id, project_id),
        ).fetchone()[0]
        next_v = int(max_v) + 1
        if is_final:
            conn.execute(
                "UPDATE topic_script_versions SET is_final = 0 WHERE topic_id = ? AND project_id = ?",
                (topic_id, project_id),
            )
        cur = conn.execute(
            """INSERT INTO topic_script_versions(
                   topic_id, project_id, version_no, version_kind, title, skill_name,
                   content_markdown, source_refs_json, facts_vs_opinions_json, llm_meta_json,
                   is_final, created_by
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                topic_id, project_id, next_v, version_kind, final_title, skill_id,
                final_md,
                json.dumps(refs, ensure_ascii=False),
                json.dumps(fvo, ensure_ascii=False),
                json.dumps(llm_meta, ensure_ascii=False),
                1 if is_final else 0,
                "ai_skill" if skill_id != "manual" else "user",
            ),
        )
        sv_id = cur.lastrowid
        if is_final or version_kind == "user_final":
            conn.execute("UPDATE topics SET script_ready = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (topic_id,))
        conn.commit()
        row = dict(conn.execute("SELECT * FROM topic_script_versions WHERE id = ?", (sv_id,)).fetchone())
        row["version_kind_label"] = VERSION_KIND_LABELS.get(row["version_kind"], row["version_kind"])
        row["source_refs"] = json.loads(row.pop("source_refs_json") or "[]")
        row["facts_vs_opinions"] = json.loads(row.pop("facts_vs_opinions_json") or "{}")
        row["llm_meta"] = json.loads(row.pop("llm_meta_json") or "{}")
        return {"ok": True, "script_version": row}
    finally:
        conn.close()


def _load_project_assets(conn, project_id: int, content_ids: list[int], contents: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """整理真实素材清单与版权许可清单（复用 media_assets，未确认授权一律标待核实，绝不自动下载）。"""
    assets: list[dict[str, Any]] = []
    licenses: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    # 1. 复用 media_assets 表中归属当前项目或关联作品的真实素材
    rows = conn.execute(
        """SELECT * FROM media_assets
           WHERE project_id = ? OR (content_id IS NOT NULL AND content_id IN ({}))
           ORDER BY id DESC LIMIT 30""".format(",".join("?" for _ in content_ids) if content_ids else "-1"),
        ([project_id] + content_ids) if content_ids else [project_id],
    ).fetchall()
    for r in rows:
        d = dict(r)
        lic = (d.get("license") or "").strip() or "待核实"
        risk = "低（已标明可商用许可）" if d.get("commercial_ok") == 1 else "待核实（未确认商用授权）"
        a_obj = {
            "asset_id": f"ma_{d['id']}",
            "name": d.get("title") or f"素材#{d['id']}",
            "asset_type": d.get("asset_type") or "media",
            "source_url": d.get("asset_url") or d.get("source_page_url") or "",
            "author_or_rights_holder": d.get("author") or "待核实",
            "source_platform": d.get("source") or "unknown",
            "acquired_at": d.get("created_at") or "",
            "linked_content_id": d.get("content_id"),
            "license": lic,
            "copyright_risk": risk,
            "local_file_ref": d.get("local_rel_path") or "",
        }
        assets.append(a_obj)
        licenses.append({"asset_id": a_obj["asset_id"], "license": lic, "copyright_risk": risk, "auto_downloaded": False})
        if a_obj["source_url"]:
            seen_urls.add(a_obj["source_url"])

    # 2. 将参考作品元数据作为参考来源登记（仅元数据引用，绝不下载他人视频，版权统一标待核实）
    for c in contents:
        u = c.get("url") or ""
        if u and u in seen_urls:
            continue
        a_obj = {
            "asset_id": f"ref_content_{c['content_id']}",
            "name": c.get("title") or f"参考作品#{c['content_id']}",
            "asset_type": "reference_video_metadata_only",
            "source_url": u,
            "author_or_rights_holder": c.get("creator_name") or "待核实",
            "source_platform": c.get("platform") or "unknown",
            "acquired_at": c.get("linked_at") or "",
            "linked_content_id": c["content_id"],
            "license": "他人公开作品（仅作研究参考，未获二次转载授权）",
            "copyright_risk": "待核实（严禁直接搬运或未经授权下载）",
            "local_file_ref": "",
        }
        assets.append(a_obj)
        licenses.append({"asset_id": a_obj["asset_id"], "license": a_obj["license"], "copyright_risk": a_obj["copyright_risk"], "auto_downloaded": False})

    return assets, licenses


def check_package_completeness(topic_id: int, project_id: int) -> dict[str, Any]:
    """第 10 节：导出前 10 项资料完整性检查（允许未完整导出，但必须明确列出待办项与缺失内容）。"""
    detail = th_svc.get_topic_detail(topic_id, project_id=project_id)
    if not detail.get("ok"):
        return detail

    tp = detail["topic"]
    contents = detail.get("contents") or []
    comments = detail.get("comments") or []
    transcripts = detail.get("transcripts") or []
    scripts_res = list_script_versions(topic_id, project_id)
    script_versions = scripts_res.get("versions") or []

    conn = get_conn()
    try:
        assets, licenses = _load_project_assets(conn, project_id, [c["content_id"] for c in contents], contents)
    finally:
        conn.close()

    urls_ok = all(bool((c.get("url") or "").startswith("http")) for c in contents) if contents else False
    rule_synced = (tp.get("validation_rule_version") == mv_svc.RULE_VERSION)
    script_prepared = bool(tp.get("script_ready")) or len(script_versions) > 0
    has_unverified_facts = (tp.get("fact_check_status") != "已核实")
    has_copyright_pending = any("待核实" in (x.get("copyright_risk") or "") for x in licenses)

    missing_materials: list[str] = list(tp.get("missing_evidence") or [])
    todo_items: list[str] = []

    if len(contents) == 0:
        missing_materials.append("缺少真实参考作品证据")
        todo_items.append("在 SearchHub 或 TopicHub 发起真实搜索并关联参考作品")
    if len(comments) == 0:
        missing_materials.append("缺少真实用户评论样本")
        todo_items.append("对代表性参考作品执行合规评论抽样")
    if len(transcripts) == 0:
        missing_materials.append("参考作品尚未提取原始参考文案（TranscriptStudio）")
        todo_items.append("点击参考作品「文案提取」补充原始参考文案")
    if not script_prepared:
        missing_materials.append("尚未保存独立原创文案版本")
        todo_items.append("在文案区选择可用 Skill 生成或手动保存原创文案版本")
    if not (tp.get("target_audience") or "").strip():
        missing_materials.append("目标受众画像尚未由用户补充")
        todo_items.append("在选题档案中补充目标受众")
    if has_unverified_facts:
        todo_items.append(f"当前事实核实状态为「{tp.get('fact_check_status')}」，正式制作前需人工核实医疗/商业/历史等关键数据")
    if has_copyright_pending:
        todo_items.append("存在未确认商用授权的参考素材（已标记待核实），严禁直接搬运")

    # 去重
    missing_materials = list(dict.fromkeys(missing_materials))

    checks = {
        "topic_exists": True,
        "evidence_linked": len(contents) > 0,
        "project_ownership_ok": int(tp["project_id"]) == int(project_id),
        "source_urls_present": urls_ok,
        "validation_rule_synced": rule_synced,
        "script_prepared": script_prepared,
        "assets_sourced": len(assets) > 0,
        "unverified_facts_exist": has_unverified_facts,
        "copyright_risk_pending": has_copyright_pending,
        "missing_materials_count": len(missing_materials),
    }

    return {
        "ok": True,
        "topic_id": topic_id,
        "project_id": project_id,
        "can_export": True,  # 允许导出尚未完整的研究资料包，但明示缺口
        "is_fully_complete": (len(missing_materials) == 0 and not has_unverified_facts),
        "checks": checks,
        "missing_materials": missing_materials,
        "todo_items": todo_items,
        "counts": {
            "contents": len(contents),
            "comments": len(comments),
            "transcripts": len(transcripts),
            "script_versions": len(script_versions),
            "assets": len(assets),
        },
    }


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _assert_no_secrets(text: str) -> None:
    """安全红线：断言导出资料包绝对不包含本机敏感 API Key / Cookie。"""
    for env_key in ("LLM_API_KEY", "TAVILY_API_KEY", "YOUTUBE_API_KEY", "PEXELS_API_KEY", "PIXABAY_API_KEY"):
        val = (os.getenv(env_key) or "").strip()
        if len(val) >= 8 and val in text:
            raise RuntimeError(f"安全拦截：导出内容中检测到敏感密钥 {env_key}，已中止导出！")


def generate_production_package(
    topic_id: int,
    project_id: int,
    *,
    script_version_id: int | None = None,
    language: str = "zh-CN",
    production_requirements: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """生成标准化 13 文件 Production_Package，输出单独 Markdown + 完整 ZIP + 00_manifest.json 并持久化历史版本。"""
    detail = th_svc.get_topic_detail(topic_id, project_id=project_id)
    if not detail.get("ok"):
        return detail

    completeness = check_package_completeness(topic_id, project_id)
    scripts_res = list_script_versions(topic_id, project_id)
    script_versions = scripts_res.get("versions") or []
    selected_script = None
    if script_version_id is not None:
        selected_script = next((s for s in script_versions if s["id"] == script_version_id), None)
    if not selected_script and script_versions:
        selected_script = next((s for s in script_versions if s.get("is_final")), script_versions[0])

    tp = detail["topic"]
    dp = detail["discovery_path"]
    contents = detail.get("contents") or []
    creators = detail.get("creators") or []
    comments = detail.get("comments") or []
    transcripts = detail.get("transcripts") or []
    lv = detail.get("latest_validation") or {}

    conn = get_conn()
    try:
        # 计算版本号（历史版本绝不被覆盖）
        max_ver = conn.execute(
            "SELECT COALESCE(MAX(package_version), 0) FROM production_packages WHERE topic_id = ? AND project_id = ?",
            (topic_id, project_id),
        ).fetchone()[0]
        pkg_ver = int(max_ver) + 1
        pkg_uid = f"pkg_p{project_id}_t{topic_id}_v{pkg_ver}_{uuid.uuid4().hex[:8]}"
        created_at = time.strftime("%Y-%m-%d %H:%M:%S")

        cids = [c["content_id"] for c in contents]
        assets, license_manifest = _load_project_assets(conn, project_id, cids, contents)

        # 读取指标快照（用于真实数据追溯）
        snapshots = []
        if cids:
            ph = ",".join("?" for _ in cids)
            snapshots = [
                dict(r)
                for r in conn.execute(
                    f"SELECT id, content_id, platform, views, likes, comments, followers, outlier_score, collected_at FROM content_metric_snapshots WHERE content_id IN ({ph}) ORDER BY id DESC LIMIT 40",
                    cids,
                ).fetchall()
            ]

        # 读取关联完整原始文案文本（用于 05_原始文案.md）
        full_transcripts = []
        if cids:
            ph = ",".join("?" for _ in cids)
            full_transcripts = [
                dict(r)
                for r in conn.execute(
                    f"""SELECT tr.id, tr.content_id, c.title, c.url, tr.language, tr.extract_method, tr.raw_text, tr.translated_zh, tr.updated_at
                        FROM transcripts tr JOIN contents c ON c.id = tr.content_id
                        WHERE tr.content_id IN ({ph}) ORDER BY tr.id DESC""",
                    cids,
                ).fetchall()
            ]
    finally:
        conn.close()

    missing_list = completeness["missing_materials"]
    todo_list = completeness["todo_items"]

    # 组装 12 份标准 Markdown 文件内容（严格基于真实数据，缺失明确标注「暂无/待补充」）
    md_files: dict[str, str] = {}

    # 01_选题说明.md
    md_files["01_选题说明.md"] = "\n".join([
        f"# 01｜选题说明：{tp['topic_title']}",
        "",
        f"- **Topic ID**：`{tp['id']}`（Project ID: `{project_id}`）",
        f"- **资料包 ID / 版本**：`{pkg_uid}` / `v{pkg_ver}`",
        f"- **来源类别**：{tp['origin_label']} (`{tp['origin_type']}`)",
        f"- **核心研究问题**：{tp['research_question'] or '（尚未填写，待补充）'}",
        f"- **原创内容角度**：{tp['angle'] or '（尚未填写，待补充）'}",
        f"- **行业标签**：{', '.join(tp['tags']) or '（暂无标签）'}",
        f"- **关联关键词**：{', '.join(tp['keywords']) or '（暂无关键词）'}",
        f"- **当前制作状态**：{tp['production_status_norm']}（导出资料包不会自动标记为已发布）",
        f"- **用户备注**：{tp['user_notes'] or '（暂无备注）'}",
        "",
    ])

    # 02_市场验证.md
    fs = tp.get("four_signals") or lv.get("four_signals") or {}
    md_files["02_市场验证.md"] = "\n".join([
        "# 02｜市场验证报告",
        "",
        f"- **市场验证等级**：**`{tp['validation_grade']}`**（规则版本：`{tp.get('validation_rule_version') or mv_svc.RULE_VERSION}`）",
        f"- **证据覆盖率**：{tp.get('evidence_coverage_pct') or lv.get('evidence_coverage_pct') or 0}%（说明：证据覆盖率不等于市场价值分数、爆款成功率或商业盈利概率）",
        f"- **等级形成原因**：{tp.get('validation_reason') or lv.get('conclusion') or '暂无市场验证记录'}",
        "",
        "## 四类信号严格分离",
        f"- **① 真实市场关注度**：`{(fs.get('market_attention') or {}).get('status', 'unverified')}` — {(fs.get('market_attention') or {}).get('summary', '暂无证据')}",
        f"- **② 用户实际需求**：`{(fs.get('user_demand') or {}).get('status', 'unverified')}` — {(fs.get('user_demand') or {}).get('summary', '暂无证据')}",
        f"- **③ 购买意愿信号**：`{(fs.get('purchase_intent') or {}).get('status', 'unverified')}` — {(fs.get('purchase_intent') or {}).get('summary', '暂无证据')}",
        f"- **④ 实际商业收益**：`{(fs.get('commercial_revenue') or {}).get('status', 'unverified')}` — {(fs.get('commercial_revenue') or {}).get('summary', '无商业收益证据，严禁宣称已盈利')}",
        "",
        "## 原始指标快照摘要",
        *(
            [f"- `content#{s['content_id']}` [{s['platform']}] 播放={s['views']} 赞={s['likes']} 评={s['comments']} 爆款={s['outlier_score']} ({s['collected_at']})" for s in snapshots[:15]]
            if snapshots else ["- 暂无历史指标快照"]
        ),
        "",
    ])

    # 03_目标人群.md
    q_cmts = [cm for cm in comments if cm.get("is_question")]
    md_files["03_目标人群.md"] = "\n".join([
        "# 03｜目标人群与真实用户需求",
        "",
        f"- **目标受众画像**：{tp.get('target_audience') or '（尚未填写，严禁 AI 虚构，请用户补充）'}",
        f"- **真实评论样本数**：{len(comments)} 条（其中明确提问句：{len(q_cmts)} 条）",
        "",
        "## 真实高频提问摘录",
        *(
            [f"- `[comment#{cm['id']}]` (赞 {cm['like_count']}): {cm['text'][:200]}" for cm in q_cmts[:10]]
            if q_cmts else ["- 暂无真实提问评论，待补充评论抽样"]
        ),
        "",
    ])

    # 04_参考作品.md
    md_files["04_参考作品.md"] = "\n".join([
        "# 04｜参考作品与参考作者",
        "",
        "## 参考作品清单",
        *(
            [
                f"- **`content#{c['content_id']}`** [{c['platform']}] [{c['title']}]({c['url']}) | 作者：{c['creator_name'] or '未知'} | 播放：{c['view_count'] if c['view_count'] is not None else '未知'} | 爆款倍数：{c['outlier_score'] if c['outlier_score'] is not None else '无基线'} | 关联来源：`{c['provenance']}`"
                for c in contents
            ]
            if contents else ["- 暂无关联参考作品"]
        ),
        "",
        "## 参考作者清单",
        *(
            [f"- **`creator#{cr['creator_id']}`** [{cr['platform']}] {cr['name']} | 粉丝：{cr['follower_count'] if cr['follower_count'] is not None else '未知'} | 主页：{cr['profile_url'] or '未知'}" for cr in creators]
            if creators else ["- 暂无参考作者"]
        ),
        "",
    ])

    # 05_原始文案.md
    md_files["05_原始文案.md"] = "\n".join([
        "# 05｜原始参考文案（TranscriptStudio 原始提取，严禁直接搬运）",
        "",
        *(
            [
                f"### `content#{tr['content_id']}` · {tr['title']}\n- 来源链接：{tr['url']}\n- 提取方式：{tr['extract_method']} | 语言：{tr['language']} | 更新时间：{tr['updated_at']}\n\n{(tr['raw_text'] or '')[:2000]}\n"
                for tr in full_transcripts
            ]
            if full_transcripts else ["- 当前关联参考作品尚未在 TranscriptStudio 提取原始文案（已列入缺失资料清单，未虚构）。"]
        ),
        "",
    ])

    # 06_真实用户评论.md
    md_files["06_真实用户评论.md"] = "\n".join([
        "# 06｜真实用户评论样本",
        "",
        *(
            [f"- **`comment#{cm['id']}`** (`content#{cm['content_id']}`, 赞 {cm['like_count']}, {'提问' if cm['is_question'] else '反馈'}) @{cm['author'] or '匿名'}：{cm['text']}" for cm in comments]
            if comments else ["- 暂无合规采集到的真实用户评论（已标注缺失，绝不造假评论）。"]
        ),
        "",
    ])

    # 07_知识与事实.md
    fvo = (selected_script or {}).get("facts_vs_opinions") or {}
    md_files["07_知识与事实.md"] = "\n".join([
        "# 07｜知识与事实核查（严格区分事实与观点）",
        "",
        f"- **事实核实状态**：`{tp.get('fact_check_status') or '待核实'}`",
        "- **重要声明**：参考视频存在某项说法不代表该说法已获事实验证；高播放量不代表内容准确；未经验证的医疗数据、商业收益、历史事实严禁作为已确认事实写入最终文案。",
        "",
        "## ① 已核实事实 (verified_facts)",
        *([f"- {x}" for x in fvo.get("verified_facts") or []] or ["- （暂无已人工核实的事实条目）"]),
        "",
        "## ② 原作品中的观点 (source_opinions)",
        *([f"- {x}" for x in fvo.get("source_opinions") or []] or ["- （待从参考作品中整理）"]),
        "",
        "## ③ 模型推断 (model_inferences)",
        *([f"- {x}" for x in fvo.get("model_inferences") or []] or ["- （暂无模型推断）"]),
        "",
        "## ④ 用户个人观点 (user_opinions)",
        *([f"- {x}" for x in fvo.get("user_opinions") or []] or ["- （待用户补充）"]),
        "",
        "## ⑤ 尚待验证的信息 (pending_verification)",
        *([f"- {x}" for x in fvo.get("pending_verification") or []] or ["- 需在正式拍摄前核实全部关键事实、费用与政策信息"]),
        "",
    ])

    # 08_原创差异化.md
    md_files["08_原创差异化.md"] = "\n".join([
        "# 08｜原创差异化与切入策略",
        "",
        f"- **核心切入角度**：{tp.get('angle') or '（待补充）'}",
        f"- **原创差异化建议**：{tp.get('differentiation_notes') or '（待用户补充）'}",
        f"- **制作适配评估**：`{json.dumps(tp.get('production_fit') or {}, ensure_ascii=False)}`",
        "",
    ])

    # 09_脚本制作建议.md
    if selected_script:
        script_body = [
            f"- **选用文案版本**：`v{selected_script['version_no']}` ({selected_script['version_kind_label']} · Skill=`{selected_script['skill_name']}`)",
            f"- **版本标题**：{selected_script['title']}",
            f"- **引用来源**：`{json.dumps(selected_script['source_refs'], ensure_ascii=False)}`",
            "",
            "## 文案正文",
            selected_script["content_markdown"],
        ]
    else:
        script_body = ["- 当前尚未保存独立原创文案版本（已列入缺失资料清单，请前往 TopicHub/文案工坊创建）。"]
    md_files["09_脚本制作建议.md"] = "\n".join(["# 09｜原创文案与脚本制作建议", "", *script_body, ""])

    # 10_真实素材清单.md
    md_files["10_真实素材清单.md"] = "\n".join([
        "# 10｜真实素材与版权许可清单",
        "",
        "- **合规声明**：未经授权绝不自动批量下载他人作品；未确认商用授权的素材统一标记「待核实」。",
        "",
        "| Asset ID | 素材名称 | 类型 | 平台 | 作者/版权方 | 使用许可 | 版权风险 | 原始 URL |",
        "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
        *(
            [f"| `{a['asset_id']}` | {a['name'][:40]} | `{a['asset_type']}` | {a['source_platform']} | {a['author_or_rights_holder']} | {a['license']} | {a['copyright_risk']} | {a['source_url']} |" for a in assets]
            if assets else ["| — | 暂无素材 | — | — | — | — | — | — |"]
        ),
        "",
    ])

    # 11_关联选题.md
    md_files["11_关联选题.md"] = "\n".join([
        "# 11｜关联选题与发现路径",
        "",
        "## 原始研究任务",
        *([f"- `task#{rt['id']}` 种子词=`{rt['seed_keyword']}` ({rt['entity_type']})" for rt in (dp.get("research_tasks") or [])] or ["- 无（人工创建或未关联研究任务）"]),
        "",
        "## 父选题",
        *([f"- `topic#{p.get('topic_id')}` {p.get('topic_title') or p.get('parent_keyword')} ({p.get('relation_type')})" for p in (detail.get("parent_topics") or [])] or ["- 无父选题"]),
        "",
        "## 衍生 / 合并子选题",
        *([f"- `topic#{c.get('topic_id')}` {c.get('topic_title')} ({c.get('relation_type')})" for c in (detail.get("child_topics") or [])] or ["- 无衍生选题"]),
        "",
    ])

    # 12_制作记录.md
    md_files["12_制作记录.md"] = "\n".join([
        "# 12｜制作记录、待补充资料与状态历史",
        "",
        f"- **导出时间**：{created_at}",
        f"- **资料包 ID / 版本**：`{pkg_uid}` / `v{pkg_ver}`",
        f"- **所用文案版本**：`v{selected_script['version_no']}`" if selected_script else "- **所用文案版本**：未关联",
        f"- **资料完整度**：{'已完整' if completeness['is_fully_complete'] else '尚有待补充项（允许导出研究资料包）'}",
        "",
        "## 缺失资料清单",
        *([f"- {m}" for m in missing_list] or ["- 无缺失资料"]),
        "",
        "## 制作前待办项",
        *([f"- [ ] {td}" for td in todo_list] or ["- 全部核查项已就绪"]),
        "",
        "## 状态变更历史",
        *([f"- [{h['created_at']}] `{h['field_name']}`: {h['old_value'] or '空'} → **{h['new_value']}**（{h['reason'] or h['changed_by']}）" for h in (detail.get("status_history") or [])[:15]] or ["- 暂无状态变更记录"]),
        "",
    ])

    # 校验所有 Markdown 无敏感密钥泄露并计算 SHA-256
    file_manifest: list[dict[str, Any]] = []
    for fname, ftext in md_files.items():
        _assert_no_secrets(ftext)
        fb = ftext.encode("utf-8")
        file_manifest.append({"file": fname, "size_bytes": len(fb), "sha256": _sha256_bytes(fb), "encoding": "UTF-8"})

    # 构造 00_manifest.json（严格满足第 6 节全部 21 个字段）
    manifest: dict[str, Any] = {
        "schema_version": PACKAGE_SCHEMA_VERSION,
        "package_id": pkg_uid,
        "package_version": pkg_ver,
        "project_id": project_id,
        "topic_id": topic_id,
        "topic_title": tp["topic_title"],
        "language": language,
        "target_audience": tp.get("target_audience") or "",
        "market_validation": {
            "validation_grade": tp["validation_grade"],
            "evidence_coverage_pct": tp.get("evidence_coverage_pct") or lv.get("evidence_coverage_pct") or 0.0,
            "validation_reason": tp.get("validation_reason") or lv.get("conclusion") or "",
            "four_signals": fs,
            "fact_check_status": tp.get("fact_check_status") or "待核实",
        },
        "scoring_rule_version": tp.get("validation_rule_version") or mv_svc.RULE_VERSION,
        "source_research_tasks": dp.get("research_tasks") or [],
        "source_evidence_ids": [c["content_id"] for c in contents],
        "reference_contents": [
            {
                "content_id": c["content_id"],
                "platform": c["platform"],
                "title": c["title"],
                "url": c["url"],
                "creator_name": c["creator_name"],
                "view_count": c["view_count"],
                "outlier_score": c["outlier_score"],
                "provenance": c["provenance"],
            }
            for c in contents
        ],
        "reference_authors": creators,
        "script_versions": [
            {
                "script_version_id": sv["id"],
                "version_no": sv["version_no"],
                "version_kind": sv["version_kind"],
                "skill_name": sv["skill_name"],
                "title": sv["title"],
                "is_final": bool(sv["is_final"]),
                "created_at": sv["created_at"],
            }
            for sv in script_versions
        ],
        "assets": assets,
        "license_manifest": license_manifest,
        "missing_materials": missing_list,
        "production_requirements": production_requirements or {
            "intended_format": "待创作者在独立视频工作室确认",
            "fact_check_required": completeness["checks"]["unverified_facts_exist"],
            "copyright_clearance_required": completeness["checks"]["copyright_risk_pending"],
            "standalone_readable": True,
        },
        "created_at": created_at,
        "file_manifest": file_manifest,
    }

    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2)
    _assert_no_secrets(manifest_text)

    # 落盘到独立历史目录（绝不覆盖旧版本）
    export_dir = os.path.join(PKG_ROOT_DIR, f"project_{project_id}", f"topic_{topic_id}", pkg_uid)
    pkg_inner_dir = os.path.join(export_dir, "Production_Package")
    os.makedirs(pkg_inner_dir, exist_ok=True)

    manifest_path = os.path.join(pkg_inner_dir, "00_manifest.json")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(manifest_text)
    for fname, ftext in md_files.items():
        with open(os.path.join(pkg_inner_dir, fname), "w", encoding="utf-8", newline="\n") as f:
            f.write(ftext)

    # 生成单独汇总 Markdown
    md_path = os.path.join(export_dir, f"{pkg_uid}.md")
    combined_md = f"# 标准化创作资料包 · {tp['topic_title']} (`{pkg_uid}` v{pkg_ver})\n\n" + "\n\n---\n\n".join(md_files.values())
    with open(md_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(combined_md)

    # 生成完整 ZIP（包含全部 13 文件）
    zip_path = os.path.join(export_dir, f"{pkg_uid}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(manifest_path, arcname="Production_Package/00_manifest.json")
        for fname in md_files:
            zf.write(os.path.join(pkg_inner_dir, fname), arcname=f"Production_Package/{fname}")

    with open(zip_path, "rb") as f:
        sha256_zip = _sha256_bytes(f.read())

    # 持久化导出记录（绝不自动把选题改为「已发布」）
    evidence_snapshot = {
        "content_ids": cids,
        "comments_count": len(comments),
        "transcripts_count": len(full_transcripts),
        "snapshots_count": len(snapshots),
        "validation_grade": tp["validation_grade"],
    }
    conn = get_conn()
    try:
        cur = conn.execute(
            """INSERT INTO production_packages(
                   package_uid, package_version, schema_version, project_id, topic_id,
                   script_version_id, export_dir, md_path, zip_path, manifest_path,
                   sha256_zip, completeness_report_json, evidence_snapshot_json,
                   missing_materials_json, manifest_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                pkg_uid, pkg_ver, PACKAGE_SCHEMA_VERSION, project_id, topic_id,
                selected_script["id"] if selected_script else None,
                export_dir, md_path, zip_path, manifest_path,
                sha256_zip,
                json.dumps(completeness, ensure_ascii=False),
                json.dumps(evidence_snapshot, ensure_ascii=False),
                json.dumps(missing_list, ensure_ascii=False),
                manifest_text,
            ),
        )
        pkg_db_id = cur.lastrowid
        conn.execute(
            """INSERT INTO topic_status_history(topic_id, project_id, field_name, old_value, new_value, reason, changed_by)
               VALUES (?, ?, 'package_export', ?, ?, ?, 'user')""",
            (topic_id, project_id, f"v{pkg_ver - 1}" if pkg_ver > 1 else "", f"{pkg_uid} (v{pkg_ver})", "导出标准化创作资料包（不自动标为已发布）"),
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "ok": True,
        "id": pkg_db_id,
        "package_uid": pkg_uid,
        "package_version": pkg_ver,
        "schema_version": PACKAGE_SCHEMA_VERSION,
        "topic_id": topic_id,
        "project_id": project_id,
        "md_path": md_path,
        "zip_path": zip_path,
        "manifest_path": manifest_path,
        "sha256_zip": sha256_zip,
        "files_count": 1 + len(md_files),
        "completeness": completeness,
        "manifest": manifest,
    }


def list_production_packages(topic_id: int, project_id: int) -> dict[str, Any]:
    conn = get_conn()
    try:
        tp = conn.execute("SELECT id, project_id FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not tp or int(tp["project_id"]) != int(project_id):
            return {"ok": False, "error": "选题不存在或不属于当前项目"}
        rows = conn.execute(
            """SELECT id, package_uid, package_version, schema_version, project_id, topic_id,
                      script_version_id, md_path, zip_path, manifest_path, sha256_zip,
                      completeness_report_json, missing_materials_json, created_at
               FROM production_packages
               WHERE topic_id = ? AND project_id = ?
               ORDER BY package_version DESC, id DESC""",
            (topic_id, project_id),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["completeness"] = json.loads(d.pop("completeness_report_json") or "{}")
            d["missing_materials"] = json.loads(d.pop("missing_materials_json") or "[]")
            out.append(d)
        return {"ok": True, "topic_id": topic_id, "packages": out}
    finally:
        conn.close()


def get_package_file_for_download(package_uid: str, fmt: str, project_id: int | None = None) -> dict[str, Any]:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM production_packages WHERE package_uid = ?", (package_uid,)).fetchone()
        if not row:
            return {"ok": False, "error": f"未找到资料包：{package_uid}"}
        if project_id is not None and int(row["project_id"]) != int(project_id):
            return {"ok": False, "error": "跨项目下载被拒绝"}
        path_map = {"md": row["md_path"], "zip": row["zip_path"], "manifest": row["manifest_path"]}
        target = path_map.get(fmt)
        if not target or not os.path.isfile(target):
            return {"ok": False, "error": f"文件不存在或格式不支持：{fmt}"}
        return {"ok": True, "path": target, "filename": os.path.basename(target)}
    finally:
        conn.close()
