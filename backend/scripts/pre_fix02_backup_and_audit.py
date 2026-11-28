"""GCW-UAT-FIX-02 迁移前 SQLite 热备份、独立临时库恢复验证、本地源码恢复点与代码审查统计脚本。"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRATCH_ROOT = os.path.dirname(ROOT)
DB_PATH = os.path.join(ROOT, "data", "workbench.db")
BACKUP_DIR = os.path.join(ROOT, "data", "backups")
OUT_DIR = os.path.join(ROOT, "docs", "uat_fix_02")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(BACKUP_DIR, exist_ok=True)


def _count_lines(path: str) -> int:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def main():
    ts = time.strftime("%Y%m%d_%H%M%S")
    db_bak = os.path.join(BACKUP_DIR, f"workbench_pre_uat_fix02_{ts}.db")

    # 1. SQLite 在线热备份 + 独立临时库恢复校验
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(db_bak)
    src.backup(dst)
    dst.close()
    pre_integrity = src.execute("PRAGMA integrity_check").fetchone()[0]
    pre_tables = [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()]
    pre_counts = {
        t: src.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in ("projects", "contents", "creators", "comments", "transcripts", "topics", "topic_evidence", "production_packages")
    }
    src.close()

    with tempfile.TemporaryDirectory() as tmpd:
        rp = os.path.join(tmpd, "restore_fix02.db")
        shutil.copy2(db_bak, rp)
        rc = sqlite3.connect(rp)
        r_int = rc.execute("PRAGMA integrity_check").fetchone()[0]
        r_tp = rc.execute("SELECT COUNT(*) FROM topics").fetchone()[0]
        rc.close()
    restore_verified = (r_int == "ok" and r_tp == pre_counts["topics"])

    # 2. 本地源码恢复点快照（排除大依赖目录）
    snap_dir = os.path.join(SCRATCH_ROOT, f"content-workbench-pre-fix02-{ts}")
    shutil.copytree(ROOT, snap_dir, ignore=shutil.ignore_patterns("node_modules", ".venv", ".git", "__pycache__", "dist", "tmp", "*.pyc", "backups"))

    # 3. 统计核心文件行数（变更前基线）
    tracked_files = [
        "backend/db.py",
        "backend/main.py",
        "backend/services/keyword_engine.py",
        "backend/services/search_batch_engine.py",
        "backend/services/market_validation_engine.py",
        "backend/services/topic_hub_service.py",
        "backend/services/production_package_service.py",
        "backend/routers/search_research.py",
        "backend/routers/topic_hub.py",
        "frontend/src/App.tsx",
        "frontend/src/api.ts",
        "frontend/src/pages/SearchHub.tsx",
        "frontend/src/pages/TopicHub.tsx",
        "frontend/src/pages/TranscriptStudio.tsx",
    ]
    pre_line_counts = {p: _count_lines(os.path.join(ROOT, p)) for p in tracked_files}

    report = {
        "timestamp": ts,
        "db_backup_path": db_bak,
        "db_backup_size_bytes": os.path.getsize(db_bak),
        "pre_integrity": pre_integrity,
        "restore_verified": restore_verified,
        "pre_tables_count": len(pre_tables),
        "pre_counts": pre_counts,
        "local_restore_point_dir": snap_dir,
        "pre_line_counts": pre_line_counts,
    }
    with open(os.path.join(OUT_DIR, "pre_fix02_baseline.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"OK! backup={db_bak}, restore_verified={restore_verified}, snap={snap_dir}")
    assert restore_verified and pre_integrity == "ok"


if __name__ == "__main__":
    main()
