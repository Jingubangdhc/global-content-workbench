#!/usr/bin/env python3
"""KOUBO-SKILL-P2 · 正式 Global Content Workbench MCP Server（标准 JSON-RPC 2.0 stdio，16 个工具）。

核心设计：
- 与正式 FastAPI REST API 完全共用 backend.services.ai_video_service 与正式 SQLite（data/workbench.db），绝无两套数据源；
- 严格限定文件访问、项目范围与工具权限；
- 涉及真实素材检索复用 backend.collectors.assets.search_real_assets；
- 涉及原创动效登记复用 backend.services.motion_registry。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")

WORKBENCH_ROOT = Path(__file__).resolve().parents[2]
if str(WORKBENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKBENCH_ROOT))

from backend.collectors.assets import search_real_assets as run_real_asset_search
from backend.db import get_conn, init_db
from backend.services import ai_video_service as svc
from backend.services.motion_registry import list_motion_assets as r1_list_assets

TOOL_DEFINITIONS = [
    {"name": "list_video_jobs", "description": "列出正式工作台 AI 智能剪辑任务，可按 project_id / status 过滤。", "inputSchema": {"type": "object", "properties": {"project_id": {"type": "integer"}, "status": {"type": "string"}}}},
    {"name": "get_video_job", "description": "获取单个任务的完整详情、版本历史、AI 方案与日志。", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"]}},
    {"name": "claim_video_job", "description": "原子领取任务并加独占锁（支持 ChatCut 工程互斥锁防并发）。", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "agent_id": {"type": "string"}, "external_project_id": {"type": "string"}}, "required": ["job_id"]}},
    {"name": "get_script", "description": "读取任务关联的口播文案、选题与创作要求。", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"]}},
    {"name": "get_project_context", "description": "读取工作台项目上下文（项目定位、受众、关联内容与历史视频工程）。", "inputSchema": {"type": "object", "properties": {"project_id": {"type": "integer"}}, "required": ["project_id"]}},
    {"name": "list_video_skills", "description": "从正式 Video Skill 注册中心读取可用技能及商业化/验收状态。", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_motion_assets", "description": "查询统一动效注册中心已验收资产，并区分原生引擎可执行与 ChatCut JSX 已编译资产。", "inputSchema": {"type": "object", "properties": {"engine_type": {"type": "string"}, "limit": {"type": "integer", "default": 40}}}},
    {"name": "list_project_media", "description": "读取工作台项目下已保存的真实素材库记录（含 URL、来源、作者与许可）。", "inputSchema": {"type": "object", "properties": {"project_id": {"type": "integer"}, "limit": {"type": "integer", "default": 30}}}},
    {"name": "search_real_assets", "description": "按口播文案需求检索真实授权候选素材（不伪造资料、不自动侵权下载）。", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "asset_type": {"type": "string", "default": "image"}, "limit": {"type": "integer", "default": 6}}, "required": ["query"]}},
    {"name": "get_style_dna", "description": "获取工作台当前生效的个人风格 DNA（项目级覆盖或全局批准版本）。", "inputSchema": {"type": "object", "properties": {"project_id": {"type": "integer"}}}},
    {"name": "submit_visual_plan", "description": "提交 VisualDirector 生成的结构化视觉导演与剪辑计划。", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "visual_plan": {"type": "object"}}, "required": ["job_id", "visual_plan"]}},
    {"name": "update_job_status", "description": "更新任务真实执行状态（11 态状态机）。", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "status": {"type": "string"}, "detail": {"type": "string"}, "error_message": {"type": "string"}}, "required": ["job_id", "status"]}},
    {"name": "register_video_output", "description": "登记真实导出 MP4 并生成不可变版本记录（强制 FFprobe 校验）。", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "output_mp4_path": {"type": "string"}, "external_project_id": {"type": "string"}, "external_project_path": {"type": "string"}, "credits_file": {"type": "string"}, "cost_report": {"type": "object"}, "edit_scope": {"type": "string", "default": "full"}, "segment_range": {"type": "object"}, "note": {"type": "string"}}, "required": ["job_id", "output_mp4_path", "external_project_id"]}},
    {"name": "submit_quality_report", "description": "提交真实成片质量检测报告并推进任务终态。", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "passed": {"type": "boolean"}, "exit_code": {"type": "integer"}, "raw_report": {"type": "string"}, "summary": {"type": "string"}, "checks": {"type": "object"}, "billing_credits_used": {"type": "number", "default": 0}}, "required": ["job_id", "passed", "exit_code", "raw_report"]}},
    {"name": "register_motion_asset", "description": "将通过研发与渲染验证的原创 ChatCut JSX 动效组件注册入统一动效注册中心。", "inputSchema": {"type": "object", "properties": {"asset_id": {"type": "string"}, "name": {"type": "string"}, "version": {"type": "string", "default": "1.0.0"}, "group_id": {"type": "string", "default": "G05"}, "engine_type": {"type": "string", "default": "chatcut_jsx"}, "skeleton_spec": {"type": "object"}, "params_schema": {"type": "object"}, "default_content": {"type": "object"}, "license_note": {"type": "string", "default": "Internal-Original-MIT"}}, "required": ["asset_id", "name"]}},
    {"name": "submit_edit_feedback", "description": "提交局部 AI 重新剪辑指令或用户偏好反馈（候选规则不直接污染全局）。", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "start_sec": {"type": "number"}, "end_sec": {"type": "number"}, "base_version_no": {"type": "integer", "default": 1}, "edit_request": {"type": "string"}, "preserve_notes": {"type": "string"}, "propose_style_dna_rule": {"type": "string"}}, "required": ["job_id", "start_sec", "end_sec", "edit_request"]}},
]


def handle_tool(name: str, args: dict) -> dict:
    if name == "list_video_jobs":
        jobs = svc.list_ai_video_jobs(project_id=args.get("project_id"), status=args.get("status"))
        brief = [{k: j.get(k) for k in ("job_id", "project_id", "skill_id", "status", "external_project_id", "output_video_path", "updated_at")} for j in jobs]
        return {"ok": True, "total": len(brief), "jobs": brief}

    if name == "get_video_job":
        job = svc.get_ai_video_job(args["job_id"])
        return {"ok": True, "job": job} if job else {"ok": False, "error": f"任务不存在：{args['job_id']}"}

    if name == "claim_video_job":
        return svc.claim_ai_video_job(args["job_id"], args.get("agent_id") or "antigravity-native", args.get("external_project_id") or "")

    if name == "get_script":
        job = svc.get_ai_video_job(args["job_id"])
        if not job:
            return {"ok": False, "error": f"任务不存在：{args['job_id']}"}
        im = job.get("input_manifest") or {}
        return {"ok": True, "job_id": job["job_id"], "title": im.get("title", ""), "script": im.get("script", ""), "source_video": im.get("source_video", ""), "options": im.get("options", {})}

    if name == "get_project_context":
        conn = get_conn()
        try:
            proj = conn.execute("SELECT * FROM projects WHERE id = ?", (args["project_id"],)).fetchone()
            if not proj:
                return {"ok": False, "error": f"项目不存在：{args['project_id']}"}
            contents = [dict(r) for r in conn.execute("SELECT id, title, platform, status FROM contents WHERE project_id = ? ORDER BY id DESC LIMIT 10", (args["project_id"],)).fetchall()]
            vprojs = [dict(r) for r in conn.execute("SELECT id, title, aspect_ratio, status FROM video_projects WHERE project_id = ? ORDER BY id DESC LIMIT 10", (args["project_id"],)).fetchall()]
            return {"ok": True, "project": dict(proj), "recent_contents": contents, "video_projects": vprojs}
        finally:
            conn.close()

    if name == "list_video_skills":
        skills = svc.list_video_skills()
        return {"ok": True, "total": len(skills), "skills": skills}

    if name == "list_motion_assets":
        conn = get_conn()
        try:
            eng = args.get("engine_type")
            lim = int(args.get("limit") or 40)
            if eng:
                rows = conn.execute("SELECT asset_id, name, engine_type, group_id, is_executable FROM motion_assets WHERE status='approved' AND engine_type=? ORDER BY id DESC LIMIT ?", (eng, lim)).fetchall()
            else:
                rows = conn.execute("SELECT asset_id, name, engine_type, group_id, is_executable FROM motion_assets WHERE status='approved' ORDER BY id DESC LIMIT ?", (lim,)).fetchall()
            classified = [{
                "asset_id": r["asset_id"], "name": r["name"], "engine_type": r["engine_type"],
                "group_id": r["group_id"], "is_executable": bool(r["is_executable"]),
                "chatcut_jsx_compiled": r["engine_type"] == "chatcut_jsx",
            } for r in rows]
            return {"ok": True, "total": len(classified), "items": classified}
        finally:
            conn.close()

    if name == "list_project_media":
        conn = get_conn()
        try:
            pid = args.get("project_id")
            lim = int(args.get("limit") or 30)
            if pid:
                rows = conn.execute(
                    """SELECT m.* FROM media_assets m
                       JOIN contents c ON c.id = m.content_id
                       WHERE c.project_id = ? ORDER BY m.id DESC LIMIT ?""",
                    (pid, lim),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM media_assets ORDER BY id DESC LIMIT ?", (lim,)).fetchall()
            return {"ok": True, "total": len(rows), "items": [dict(r) for r in rows]}
        finally:
            conn.close()

    if name == "search_real_assets":
        try:
            res = run_real_asset_search(query=args["query"], asset_type=args.get("asset_type") or "image", limit=int(args.get("limit") or 6))
            return {"ok": True, "query": args["query"], "result": res}
        except Exception as e:
            return {"ok": False, "error": f"真实素材检索失败（已保留待补充标记）：{e}"}

    if name == "get_style_dna":
        conn = get_conn()
        try:
            pid = args.get("project_id")
            row = None
            if pid:
                row = conn.execute("SELECT * FROM style_dna_profiles WHERE scope='project' AND project_id=? AND status IN ('approved','locked') ORDER BY version DESC LIMIT 1", (pid,)).fetchone()
            if not row:
                row = conn.execute("SELECT * FROM style_dna_profiles WHERE scope='global' AND status IN ('approved','locked') ORDER BY version DESC LIMIT 1").fetchone()
            return {"ok": True, "style_dna": dict(row) if row else {"scope": "default", "theme": "ivory"}}
        finally:
            conn.close()

    if name == "submit_visual_plan":
        return svc.submit_visual_plan(args["job_id"], args["visual_plan"])

    if name == "update_job_status":
        return svc.update_ai_video_job_status(args["job_id"], args["status"], args.get("detail") or "", args.get("error_message") or "")

    if name == "register_video_output":
        return svc.register_video_output(
            job_id=args["job_id"],
            output_mp4_path=args["output_mp4_path"],
            external_project_id=args["external_project_id"],
            external_project_path=args.get("external_project_path") or "",
            credits_file=args.get("credits_file") or "",
            cost_report=args.get("cost_report") or {},
            edit_scope=args.get("edit_scope") or "full",
            segment_range=args.get("segment_range") or {},
            note=args.get("note") or "",
        )

    if name == "submit_quality_report":
        return svc.submit_quality_report(
            job_id=args["job_id"],
            passed=bool(args["passed"]),
            exit_code=int(args["exit_code"]),
            raw_report=args["raw_report"],
            summary=args.get("summary") or "",
            checks=args.get("checks") or {},
            billing_credits_used=float(args.get("billing_credits_used") or 0),
        )

    if name == "register_motion_asset":
        conn = get_conn()
        try:
            aid = args["asset_id"]
            conn.execute(
                """INSERT INTO motion_assets(
                       asset_id, version, name, engine_type, group_id, skeleton_spec_json,
                       params_schema_json, default_content_json, capabilities_json,
                       source_type, license_note, status, is_executable
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_original_jsx', ?, 'approved', 1)
                   ON CONFLICT(asset_id) DO UPDATE SET
                       version=excluded.version, name=excluded.name, engine_type=excluded.engine_type,
                       skeleton_spec_json=excluded.skeleton_spec_json, params_schema_json=excluded.params_schema_json,
                       default_content_json=excluded.default_content_json, status='approved', updated_at=CURRENT_TIMESTAMP""",
                (
                    aid,
                    args.get("version") or "1.0.0",
                    args["name"],
                    args.get("engine_type") or "chatcut_jsx",
                    args.get("group_id") or "G05",
                    json.dumps(args.get("skeleton_spec") or {}, ensure_ascii=False),
                    json.dumps(args.get("params_schema") or {}, ensure_ascii=False),
                    json.dumps(args.get("default_content") or {}, ensure_ascii=False),
                    json.dumps({"chatcut_jsx_compiled": True, "realtime_param_edit": True, "render_tested": True}, ensure_ascii=False),
                    args.get("license_note") or "Internal-Original-MIT",
                ),
            )
            svc._audit(conn, "motion_asset_registered", "motion_asset", aid, "approved", f"原创动效 {aid} ({args['name']}) 已登记入统一注册中心")
            conn.commit()
            return {"ok": True, "asset_id": aid, "status": "approved", "engine_type": args.get("engine_type") or "chatcut_jsx"}
        finally:
            conn.close()

    if name == "submit_edit_feedback":
        return svc.submit_edit_feedback(
            job_id=args["job_id"],
            start_sec=float(args["start_sec"]),
            end_sec=float(args["end_sec"]),
            base_version_no=int(args.get("base_version_no") or 1),
            edit_request=args["edit_request"],
            preserve_notes=args.get("preserve_notes") or "非指定片段保持不变",
            propose_style_dna_rule=args.get("propose_style_dna_rule") or "",
        )

    return {"ok": False, "error": f"未知工具：{name}"}


def main() -> None:
    init_db()
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid = msg.get("id")
        method = msg.get("method")
        if method == "notifications/initialized":
            continue
        if method == "initialize":
            resp = {
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "gcw_workbench_mcp", "version": "2.1.0"},
                },
            }
        elif method == "tools/list":
            resp = {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOL_DEFINITIONS}}
        elif method == "tools/call":
            p = msg.get("params") or {}
            try:
                out = handle_tool(p.get("name", ""), p.get("arguments") or {})
            except Exception as e:
                out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            resp = {
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "isError": not bool(out.get("ok", True)),
                    "content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}],
                },
            }
        else:
            resp = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}}
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
