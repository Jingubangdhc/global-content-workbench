"""GCW-UAT-P0 只读核查、SQLite 冻结热备份与本地可运行版本快照脚本（绝不修改任何业务代码或数据库结构）。"""
from __future__ import annotations

import json
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRATCH_ROOT = os.path.dirname(ROOT)
DB_PATH = os.path.join(ROOT, "data", "workbench.db")
BACKUP_DIR = os.path.join(ROOT, "data", "backups")
OUT_DIR = os.path.join(ROOT, "docs", "uat_p0")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(BACKUP_DIR, exist_ok=True)


def run_cmd(cmd: list[str], cwd: str = ROOT) -> str:
    try:
        return subprocess.check_output(cmd, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()
    except Exception as e:
        return f"ERROR: {e}"


def main():
    ts = time.strftime("%Y%m%d_%H%M%S")

    # 1. Git 状态与变更清单（只读，绝不 commit 或 push）
    git_branch = run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    git_head = run_cmd(["git", "log", "-1", "--oneline"])
    git_status = run_cmd(["git", "status", "--short"])
    changed_files = [ln for ln in git_status.splitlines() if ln.strip()]

    # 2. SQLite 在线热备份 + 独立临时库恢复验证
    db_freeze_path = os.path.join(BACKUP_DIR, f"workbench_uat_p0_freeze_{ts}.db")
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(db_freeze_path)
    src.backup(dst)
    dst.close()

    integrity = src.execute("PRAGMA integrity_check").fetchone()[0]
    tables = [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()]
    core_counts = {}
    for t in [
        "projects", "keywords", "creators", "contents", "comments", "transcripts",
        "revenue_evidence", "tools", "research_tasks", "keyword_candidates",
        "search_batch_runs", "search_query_runs", "project_content_links", "content_metric_snapshots",
        "market_validations", "topic_clusters", "reverse_keywords", "topics",
        "topic_evidence", "topic_relations", "topic_status_history", "topic_merge_logs",
        "topic_script_versions", "production_packages",
    ]:
        core_counts[t] = src.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    src.close()

    with tempfile.TemporaryDirectory() as tmpd:
        rp = os.path.join(tmpd, "restore_check.db")
        shutil.copy2(db_freeze_path, rp)
        rc = sqlite3.connect(rp)
        r_int = rc.execute("PRAGMA integrity_check").fetchone()[0]
        r_tp = rc.execute("SELECT COUNT(*) FROM topics").fetchone()[0]
        r_pk = rc.execute("SELECT COUNT(*) FROM production_packages").fetchone()[0]
        rc.close()
    restore_verified = (r_int == "ok" and r_tp == core_counts["topics"] and r_pk == core_counts["production_packages"])

    # 3. 保存当前可运行版本的本地源码+数据库快照（排除大依赖目录）
    snapshot_dir = os.path.join(SCRATCH_ROOT, f"content-workbench-uat-p0-freeze-{ts}")
    ignore_fn = shutil.ignore_patterns(
        "node_modules", ".venv", ".git", "__pycache__", "dist", "tmp", "*.pyc", "backups",
    )
    shutil.copytree(ROOT, snapshot_dir, ignore=ignore_fn)
    # 单独复制冻结数据库到快照的 data/backups/
    os.makedirs(os.path.join(snapshot_dir, "data", "backups"), exist_ok=True)
    shutil.copy2(db_freeze_path, os.path.join(snapshot_dir, "data", "backups", os.path.basename(db_freeze_path)))

    # 4. 检查 Phase 0 - Phase 5 历史验收报告完整度
    phase_reports_check = {
        "Phase 0 (只读审查)": sorted(os.listdir(os.path.join(SCRATCH_ROOT, "search-phase0-audit", "reports"))) if os.path.isdir(os.path.join(SCRATCH_ROOT, "search-phase0-audit", "reports")) else [],
        "Phase 1 (AI拓词与能力矩阵)": sorted(os.listdir(os.path.join(ROOT, "docs", "search_phase1"))) if os.path.isdir(os.path.join(ROOT, "docs", "search_phase1")) else [],
        "Phase 2 (批量真实搜索)": sorted(os.listdir(os.path.join(ROOT, "docs", "search_phase2"))) if os.path.isdir(os.path.join(ROOT, "docs", "search_phase2")) else [],
        "Phase 3 (市场验证与反向发现)": sorted(os.listdir(os.path.join(ROOT, "docs", "search_phase3"))) if os.path.isdir(os.path.join(ROOT, "docs", "search_phase3")) else [],
        "Phase 4 (TopicHub与V2整改)": sorted(os.listdir(os.path.join(ROOT, "docs", "search_phase4"))) if os.path.isdir(os.path.join(ROOT, "docs", "search_phase4")) else [],
        "Phase 5 (创作资料包与文案联动)": sorted(os.listdir(os.path.join(ROOT, "docs", "search_phase5"))) if os.path.isdir(os.path.join(ROOT, "docs", "search_phase5")) else [],
    }

    # 5. 检查当前运行中服务端口与 12 平台能力矩阵
    backend_ok = False
    frontend_ok = False
    platform_caps = []
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/api/search/platform-capabilities", timeout=5) as r:
            d = json.loads(r.read().decode("utf-8"))
            backend_ok = bool(d.get("ok"))
            platform_caps = d.get("platforms") or []
    except Exception:
        pass
    try:
        with urllib.request.urlopen("http://127.0.0.1:5173/", timeout=5) as r:
            frontend_ok = (r.status == 200)
    except Exception:
        pass

    node_ver = run_cmd(["node", "-v"])
    npm_ver = run_cmd(["npm.cmd", "-v"])

    baseline = {
        "freeze_timestamp": ts,
        "os": platform.platform(),
        "python_version": sys.version.split()[0],
        "node_version": node_ver,
        "npm_version": npm_ver,
        "git_branch": git_branch,
        "git_head": git_head,
        "changed_files_count": len(changed_files),
        "changed_files": changed_files,
        "db_freeze_path": db_freeze_path,
        "db_freeze_size_bytes": os.path.getsize(db_freeze_path),
        "db_integrity": integrity,
        "db_restore_verified": restore_verified,
        "business_tables_count": len(tables),
        "core_counts": core_counts,
        "local_code_snapshot_dir": snapshot_dir,
        "services_health": {
            "backend_8000": backend_ok,
            "frontend_5173": frontend_ok,
        },
        "platform_capabilities": platform_caps,
        "phase_reports_check": phase_reports_check,
    }

    out_path = os.path.join(OUT_DIR, "freeze_baseline.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(baseline, f, ensure_ascii=False, indent=2)
    print(f"OK! freeze_ts={ts}, restore_verified={restore_verified}, tables={len(tables)}, changed_files={len(changed_files)}, snapshot={snapshot_dir}")
    assert restore_verified and integrity == "ok" and backend_ok and frontend_ok


if __name__ == "__main__":
    main()
