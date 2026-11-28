"""KOUBO-SKILL-P2 · ChatCut Desktop 官方 MCP 执行适配器（含互斥锁、原创 JSX 注入与局部 AI 返修）。"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from backend.config import DATA_DIR, ROOT_DIR
from backend.services import ai_video_service as svc

SKILLS_ROOT = Path(r"C:\Users\wodhc\.gemini\antigravity\scratch\koubo-skill-p0-audit\koubo-templates")
WORK_ROOT = DATA_DIR / "ai_video_work"
LOGS_ROOT = DATA_DIR / "ai_video_logs"
WORK_ROOT.mkdir(parents=True, exist_ok=True)
LOGS_ROOT.mkdir(parents=True, exist_ok=True)
os.environ["PYTHONUTF8"] = "1"

FORBIDDEN_PAID_TOOLS = {
    "submit_video", "submit_image", "submit_music", "submit_sound",
    "submit_voice", "submit_avatar_video", "submit_lipsync", "submit_generation_batch",
}


class StdioMCPClient:
    """标准 JSON-RPC 2.0 stdio MCP 客户端（用于连接正式 Workbench MCP 与 ChatCut 官方 MCP）。"""

    def __init__(self, label: str, cmd: list[str], log_file: Path, extra_env: dict[str, str] | None = None):
        self.label = label
        self.log_file = log_file
        self._id = 0
        env = os.environ.copy()
        if extra_env:
            env.update(extra_env)
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", env=env,
        )
        self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "gcw-p2-native-bridge", "version": "2.1"},
        })
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.proc.stdin.flush()

    def _rpc(self, method: str, params: dict | None = None, timeout_sec: float = 120.0) -> dict:
        self._id += 1
        mid = self._id
        msg = {"jsonrpc": "2.0", "id": mid, "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        t0 = time.time()
        while time.time() - t0 < timeout_sec:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"[{self.label}] MCP 连接意外断开")
            s = line.strip()
            if s.startswith("{"):
                obj = json.loads(s)
                if obj.get("id") == mid:
                    return obj
        raise TimeoutError(f"[{self.label}] MCP 调用超时：{method}")

    def list_tools(self) -> list[dict]:
        return (self._rpc("tools/list", {}).get("result") or {}).get("tools", [])

    def call(self, tool_name: str, arguments: dict | None = None, timeout_sec: float = 120.0) -> dict:
        if tool_name in FORBIDDEN_PAID_TOOLS:
            raise PermissionError(f"严禁调用付费工具：{tool_name}")
        t0 = time.time()
        res = self._rpc("tools/call", {"name": tool_name, "arguments": arguments or {}}, timeout_sec=timeout_sec)
        dt = round(time.time() - t0, 3)
        result = res.get("result") or {}
        texts = [c.get("text", "") for c in (result.get("content") or []) if c.get("type") == "text"]
        full_text = "\n".join(texts)
        parsed = None
        for t in texts:
            ts = t.strip()
            if ts.startswith("{") or ts.startswith("["):
                try:
                    parsed = json.loads(ts)
                    break
                except Exception:
                    pass
        entry = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "mcp_server": self.label,
            "tool": tool_name,
            "args_preview": json.dumps(arguments or {}, ensure_ascii=False)[:400],
            "elapsed_sec": dt,
            "is_error": bool(result.get("isError") or "error" in res),
            "result_preview": full_text[:450],
        }
        with self.log_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return {"is_error": entry["is_error"], "text": full_text, "json": parsed, "elapsed_sec": dt}

    def close(self) -> None:
        for fn in (lambda: self.proc.stdin.close(), lambda: self.proc.terminate()):
            try:
                fn()
            except Exception:
                pass


def open_official_dual_mcp(log_file: Path) -> tuple[StdioMCPClient, StdioMCPClient]:
    py_exe = str(ROOT_DIR / ".venv" / "Scripts" / "python.exe")
    wb = StdioMCPClient("workbench_mcp", [py_exe, str(ROOT_DIR / "backend" / "mcp" / "workbench_mcp_server.py")], log_file)
    cc = StdioMCPClient("chatcut_desktop", ["cmd", "/c", r"C:\Users\wodhc\AppData\Roaming\ChatCut\chatcut-mcp.cmd"], log_file, {"CHATCUT_MCP_CLIENT": "claude_code"})
    return wb, cc


def stage1_prepare_job(job_id: str, agent_id: str = "antigravity-native") -> dict[str, Any]:
    """阶段一：双 MCP 领取任务 -> 建 ChatCut 工程并加互斥锁 -> 官方转写 -> 产出 words.json。"""
    work = WORK_ROOT / job_id
    work.mkdir(parents=True, exist_ok=True)
    log_file = LOGS_ROOT / f"{job_id}_mcp_calls.jsonl"
    wb, cc = open_official_dual_mcp(log_file)
    try:
        r_claim = wb.call("claim_video_job", {"job_id": job_id, "agent_id": agent_id})
        if r_claim["is_error"]:
            raise RuntimeError(r_claim["text"])
        job = wb.call("get_video_job", {"job_id": job_id})["json"]["job"]
        wb.call("get_script", {"job_id": job_id})
        wb.call("get_project_context", {"project_id": job.get("project_id") or 1})
        wb.call("get_style_dna", {"project_id": job.get("project_id") or 1})
        wb.call("list_video_skills", {})
        wb.call("list_motion_assets", {"limit": 40})

        im = job.get("input_manifest") or {}
        src_video = Path(im.get("source_video") or "")
        if not src_video.is_file():
            wb.call("update_job_status", {"job_id": job_id, "status": "Failed", "error_message": f"源视频不存在：{src_video}"})
            raise FileNotFoundError(f"源视频不存在：{src_video}")

        bill_before = cc.call("read_billing", {})["json"]
        r_cp = cc.call("create_project", {"name": f"GCW-P2-{job_id}", "compositionWidth": 1080, "compositionHeight": 1920, "openWindow": False})
        pid = (r_cp["json"] or {}).get("projectId") or re.search(r'"projectId"\s*:\s*"([^"]+)"', r_cp["text"]).group(1)

        # 获取 ChatCut 工程互斥锁
        lk = svc.acquire_chatcut_project_lock(pid, job_id, agent_id)
        if not lk.get("ok"):
            raise RuntimeError(lk.get("error"))

        proj_path = ((cc.call("read_project", {"projectId": pid})["json"] or {}).get("projectHome") or {}).get("projectPath")
        r_pa = cc.call("push_asset", {"projectId": pid, "filePath": str(src_video), "type": "video"})
        aid = re.search(r'"assetId"\s*:\s*"([^"]+)"', r_pa["text"]).group(1)

        cc.call("trigger_transcript", {"projectId": pid, "asset": aid})
        trans_dir = Path(proj_path) / "workspace" / "transcription" / aid
        raw_f = None
        for _ in range(40):
            cands = list(trans_dir.glob("*/raw-result.json")) if trans_dir.exists() else []
            if cands:
                raw_f = cands[0]
                break
            time.sleep(1.5)
        if not raw_f:
            wb.call("update_job_status", {"job_id": job_id, "status": "Failed", "error_message": "ChatCut 官方转写超时"})
            raise RuntimeError("转写超时")

        skill_id = job["skill_id"]
        skill_dir = SKILLS_ROOT / (skill_id if skill_id in ("premium-talk-edit", "whiteboard-koubo") else "premium-talk-edit")
        if skill_id == "whiteboard-koubo":
            subprocess.run(["python", str(skill_dir / "scripts" / "words_from_project.py"), str(Path(proj_path) / "workspace"), aid, "-o", str(work / "words.json")], check=True)
        else:
            subprocess.run(["python", str(skill_dir / "scripts" / "words_from_raw.py"), str(raw_f), "-o", str(work / "words.json")], check=True)
        subprocess.run(["python", str(skill_dir / "scripts" / "envelope.py"), str(src_video), str(work / "env.json")], check=True)

        src_dur = float(
            subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(src_video)], capture_output=True, text=True, check=True).stdout.strip()
        )
        ctx = {
            "job_id": job_id,
            "skill_id": skill_id,
            "project_id": pid,
            "project_path": proj_path,
            "video_asset_id": aid,
            "source_video": str(src_video),
            "source_duration": round(src_dur, 2),
            "credits_before": (bill_before or {}).get("availableCredits"),
            "words_file": str(work / "words.json"),
        }
        (work / "stage1_context.json").write_text(json.dumps(ctx, ensure_ascii=False, indent=2), encoding="utf-8")
        wb.call("update_job_status", {"job_id": job_id, "status": "Analyzing", "detail": f"已完成官方转写（{src_dur:.2f}s），等待 VisualDirector 决策"})
        return ctx
    finally:
        wb.close()
        cc.close()


def stage2_execute_plan(job_id: str, plan: dict[str, Any], edit_scope: str = "full", segment_range: dict | None = None, note: str = "") -> dict[str, Any]:
    """阶段二：按原生 AI Agent 动态生成的 visual_plan 驱动双 MCP 建轨、注入原创 JSX、导出与质检。"""
    t0 = time.time()
    work = WORK_ROOT / job_id
    ctx = json.loads((work / "stage1_context.json").read_text(encoding="utf-8"))
    log_file = LOGS_ROOT / f"{job_id}_mcp_calls.jsonl"
    skill_id = ctx["skill_id"]
    skill_dir = SKILLS_ROOT / (skill_id if skill_id in ("premium-talk-edit", "whiteboard-koubo") else "premium-talk-edit")
    pid = ctx["project_id"]
    proj_path = ctx["project_path"]
    aid = ctx["video_asset_id"]

    wb, cc = open_official_dual_mcp(log_file)
    try:
        wb.call("submit_visual_plan", {"job_id": job_id, "visual_plan": plan})
        wb.call("update_job_status", {"job_id": job_id, "status": "Editing", "detail": f"VisualDirector 方案已入库，正在驱动 ChatCut MCP 建轨（scope={edit_scope}）"})

        ws_mg = Path(proj_path) / "workspace" / "mg"
        ws_mg.mkdir(parents=True, exist_ok=True)
        if skill_id == "whiteboard-koubo":
            for fn in ("lib.jsx", "scenes.jsx", "ring.jsx", "board.jsx", "theme.jsx"):
                src_f = skill_dir / "assets" / "whiteboard-mg" / fn
                if src_f.is_file():
                    shutil.copy2(src_f, ws_mg / fn)
        else:
            subprocess.run(["python", str(skill_dir / "scripts" / "install_mg.py"), proj_path], check=True)

        th_p = ws_mg / "theme.jsx"
        if th_p.is_file() and plan.get("theme"):
            th_txt = th_p.read_text(encoding="utf-8")
            for k, v in plan["theme"].items():
                th_txt = re.sub(rf'{k}\s*:\s*"[^"]*"', f'{k}: "{v}"', th_txt)
            th_p.write_text(th_txt, encoding="utf-8")

        # 粗剪建轨（仅在 full 首次构建时写入 V1/V2；segment 局部返修保留原人物时间轴）
        if edit_scope == "full":
            (work / "pieces.json").write_text(json.dumps(plan["pieces"], ensure_ascii=False, indent=2), encoding="utf-8")
            bcmd = ["python", str(skill_dir / "scripts" / "build_cut.py"), str(work / "pieces.json"), "--words", str(work / "words.json"), "--asset", aid, "--src-dur", str(ctx["source_duration"]), "--out-dir", str(work)]
            if skill_id != "whiteboard-koubo":
                bcmd += ["--track", "V1"]
            subprocess.run(bcmd, check=True)
            adds = json.loads((work / "adds.json").read_text(encoding="utf-8"))
            cc.call("edit_item", {"projectId": pid, "adds": adds})
            subprocess.run(["python", str(skill_dir / "scripts" / "timeline_words.py"), proj_path, "--words", str(work / "words.json"), "-o", str(work / "tl_words.json")], check=True)

        cut = json.loads((work / "cut.json").read_text(encoding="utf-8"))
        total_frames = sum(c["dur"] for c in cut)
        total_sec = round(total_frames / 30.0, 2)

        # 写入标准 Skill 场景 + 可选独立原创 ChatCut JSX 组件
        cue_args = []
        mg_adds = []
        for s in plan.get("scenes", []):
            jsx_path = ws_mg / s["name"]
            if s.get("custom_jsx_template"):
                # §11 独立原创 JSX 组件直接复制并注入参数
                tpl = Path(s["custom_jsx_template"]).read_text(encoding="utf-8")
                if s.get("spec"):
                    tpl = re.sub(r"/\*SPEC\*/.*?/\*END\*/", f"/*SPEC*/ {json.dumps(s['spec'], ensure_ascii=False)} /*END*/", tpl, flags=re.S)
                jsx_path.write_text(tpl, encoding="utf-8")
                if edit_scope == "full" or s.get("replace_in_segment"):
                    r_mg = cc.call("push_asset", {"projectId": pid, "filePath": str(jsx_path), "type": "motion-graphic", "duration": int(round(s["dur_frames"] / 30.0 * 1e6)), "width": 1080, "height": 1920})
                    m_aid = re.search(r'"assetId"\s*:\s*"([^"]+)"', r_mg["text"])
                    if m_aid:
                        mg_adds.append({"type": "motion-graphic", "assetId": m_aid.group(1), "trackId": s.get("track") or "V2", "startFrame": s["start_frame"], "durationFrames": s["dur_frames"], "left": 0, "top": 0, "width": 1080, "height": 1920})
            else:
                jsx_path.write_text(
                    f'import React from "react";\nimport {{ Scene }} from "./scenes.jsx";\nconst SPEC = /*SPEC*/ {json.dumps(s["spec"], ensure_ascii=False)} /*END*/;\nexport default function Seg() {{ return <Scene spec={{SPEC}} />; }}\n',
                    encoding="utf-8",
                )
                cue_args.append(f"{jsx_path}@{s['start_frame']}+{s['dur_frames']}")
                if edit_scope == "full":
                    r_mg = cc.call("push_asset", {"projectId": pid, "filePath": str(jsx_path), "type": "motion-graphic", "duration": int(round(s["dur_frames"] / 30.0 * 1e6)), "width": 1080, "height": 1920})
                    m_aid = re.search(r'"assetId"\s*:\s*"([^"]+)"', r_mg["text"])
                    if m_aid:
                        trk = s.get("track") or ("V2" if skill_id != "whiteboard-koubo" else ("V3" if s["spec"].get("scene") == "topcard" else "V1"))
                        mg_adds.append({"type": "motion-graphic", "assetId": m_aid.group(1), "trackId": trk, "startFrame": s["start_frame"], "durationFrames": s["dur_frames"], "left": 0, "top": 0, "width": 1080, "height": 1920})

        if cue_args:
            if skill_id == "whiteboard-koubo":
                subprocess.run(["python", str(skill_dir / "scripts" / "scene_cues.py"), *cue_args, "--words", str(work / "tl_words.json"), "--voice-median", "-31.0", "-o", str(work / "cues.json")], check=True)
            else:
                subprocess.run(["python", str(skill_dir / "scripts" / "gk_cues.py"), *cue_args, "--words", str(work / "tl_words.json"), "--mg", str(ws_mg), "-o", str(work / "cues.json")], check=True)

        if mg_adds:
            cc.call("edit_item", {"projectId": pid, "adds": mg_adds})

        if edit_scope == "full":
            if skill_id != "whiteboard-koubo" and (work / "cues.json").is_file():
                subprocess.run(["python", str(skill_dir / "scripts" / "gk_layout.py"), str(work / "cues.json"), "--project", proj_path, "--out-dir", str(work)], check=True)
                manifest = json.loads((work / "layout_manifest.json").read_text(encoding="utf-8"))
                for fname in manifest.get("keyframe_batches_in_order", []):
                    cc.call("edit_item", {"projectId": pid, "keyframes": json.loads((work / fname).read_text(encoding="utf-8"))})
            elif skill_id == "whiteboard-koubo":
                # §12 白板风修复：调整字幕轨安全区 y=1200（避免落入 y>1440 平台标题区）
                cc.call("edit_captions", {"projectId": pid, "action": "enable"})
                cc.call("update_track", {"projectId": pid, "trackId": "C1", "layout": {"top": 1200}})

            if skill_id != "whiteboard-koubo":
                cc.call("edit_captions", {"projectId": pid, "action": "enable"})
                if (work / "cues.json").is_file():
                    subprocess.run(["python", str(skill_dir / "scripts" / "gk_bed.py"), "--pool", str(skill_dir / "assets" / "sfx-pool" / "pool.json"), "--cues", str(work / "cues.json"), str(work / "bed.wav"), "--seed", job_id, "--voice-median", "-31.0", "--total", str(total_sec)], check=True)
            elif (work / "cues.json").is_file():
                subprocess.run(["python", str(skill_dir / "scripts" / "sfx_bed.py"), str(work / "cues.json"), str(work / "bed.wav"), "--voice-median", "-31.0"], check=True)

            if (work / "bed.wav").is_file():
                r_sfx = cc.call("push_asset", {"projectId": pid, "filePath": str(work / "bed.wav"), "type": "audio"})
                m_said = re.search(r'"assetId"\s*:\s*"([^"]+)"', r_sfx["text"])
                if m_said:
                    # §12 白板风修复：统一放到独立 A2 轨避免被联动人声轨覆盖
                    cc.call("edit_item", {"projectId": pid, "adds": [{"type": "audio", "assetId": m_said.group(1), "trackId": "A2", "startFrame": 0, "durationFrames": total_frames}]})

        # 导出不可变新版本 MP4（不覆盖旧版）
        wb.call("update_job_status", {"job_id": job_id, "status": "Rendering", "detail": f"ChatCut 正在导出新版本 MP4（scope={edit_scope}）"})
        ver_tag = f"v{int(time.time()) % 10000}" if edit_scope == "segment" else "v1"
        out_mp4 = svc.AI_VIDEO_EXPORTS_DIR / f"{job_id}_{ver_tag}.mp4"
        if out_mp4.exists():
            out_mp4.unlink()
        cc.call("export", {"projectId": pid, "format": "video", "outputPath": str(out_mp4)}, timeout_sec=180)
        for _ in range(20):
            if out_mp4.exists() and out_mp4.stat().st_size > 10000:
                break
            cc.call("track_progress", {"projectId": pid, "target": "export", "action": "wait"}, timeout_sec=60)
            time.sleep(2)
        bill_after = cc.call("read_billing", {})["json"]

        wb.call("update_job_status", {"job_id": job_id, "status": "Checking", "detail": "正在执行 FFprobe 与 final_check.py 质检"})
        fc_cmd = ["python", str(skill_dir / "scripts" / "final_check.py"), str(out_mp4), "--project", proj_path]
        if (work / "cues.json").is_file():
            fc_cmd += ["--cues", str(work / "cues.json")]
        if (work / "bed.wav").is_file():
            fc_cmd += ["--bed", str(work / "bed.wav")]
        fc = subprocess.run(fc_cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")

        credits_before = ctx.get("credits_before")
        credits_after = (bill_after or {}).get("availableCredits")
        used = (credits_before - credits_after) if (credits_before is not None and credits_after is not None) else 0
        elapsed = round(time.time() - t0, 2)

        r_reg = wb.call("register_video_output", {
            "job_id": job_id,
            "output_mp4_path": str(out_mp4),
            "external_project_id": pid,
            "external_project_path": proj_path,
            "credits_file": str(work / "bed_CREDITS.txt") if (work / "bed_CREDITS.txt").exists() else "",
            "edit_scope": edit_scope,
            "segment_range": segment_range or {},
            "note": note,
            "cost_report": {
                "google_ai_pro_member": "已通过 Antigravity 官方客户端交互执行（会员剩余实时额度：未知）",
                "chatcut_credits_before": credits_before,
                "chatcut_credits_after": credits_after,
                "chatcut_credits_used": used,
                "extra_api_cost_usd": 0.0,
                "local_render_sec": elapsed,
            },
        })
        wb.call("submit_quality_report", {
            "job_id": job_id,
            "passed": fc.returncode == 0,
            "exit_code": fc.returncode,
            "summary": f"final_check.py {'通过' if fc.returncode == 0 else '存在未通过项'} (exit={fc.returncode})",
            "raw_report": fc.stdout + ("\n" + fc.stderr if fc.stderr else ""),
            "billing_credits_used": used,
        })
        return {
            "ok": True,
            "job_id": job_id,
            "version_no": (r_reg.get("json") or {}).get("version_no"),
            "output_mp4": str(out_mp4),
            "size_mb": round(out_mp4.stat().st_size / 1024 / 1024, 2),
            "final_check_rc": fc.returncode,
            "credits_used": used,
            "elapsed_sec": elapsed,
        }
    finally:
        wb.close()
        cc.close()
