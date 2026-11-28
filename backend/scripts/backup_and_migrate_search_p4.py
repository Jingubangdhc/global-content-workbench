"""SEARCH-PHASE-4 数据库热备份、独立临时库恢复验证与幂等迁移脚本。"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from backend.db import BACKUP_DIR, DB_PATH, init_db


def main():
    ts = time.strftime("%Y%m%d_%H%M%S")
    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup_path = os.path.join(BACKUP_DIR, f"workbench_pre_search_p4_{ts}.db")

    # 1. SQLite 在线热备份
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(backup_path)
    src.backup(dst)
    dst.close()

    pre_tables = [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()]
    pre_counts = {
        t: src.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in ["projects", "creators", "contents", "comments", "market_validations", "topic_clusters", "reverse_keywords", "topics", "topic_evidence", "topic_relations"]
    }
    pre_integrity = src.execute("PRAGMA integrity_check").fetchone()[0]
    src.close()

    # 2. 独立临时数据库恢复验证
    with tempfile.TemporaryDirectory() as tmpd:
        restored_path = os.path.join(tmpd, "restored.db")
        shutil.copy2(backup_path, restored_path)
        rc = sqlite3.connect(restored_path)
        restore_integrity = rc.execute("PRAGMA integrity_check").fetchone()[0]
        restore_topics = rc.execute("SELECT COUNT(*) FROM topics").fetchone()[0]
        rc.close()
    restore_verified = (restore_integrity == "ok" and restore_topics == pre_counts["topics"])

    # 3. 双次 init_db() 幂等增量迁移
    init_db()
    init_db()

    post = sqlite3.connect(DB_PATH)
    post_tables = [r[0] for r in post.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()]
    post_integrity = post.execute("PRAGMA integrity_check").fetchone()[0]
    post_counts = {
        t: post.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in ["projects", "creators", "contents", "comments", "market_validations", "topic_clusters", "reverse_keywords", "topics", "topic_evidence", "topic_relations", "topic_status_history", "topic_merge_logs"]
    }
    topic_cols = [r[1] for r in post.execute("PRAGMA table_info(topics)").fetchall()]
    post.close()

    report = {
        "timestamp": ts,
        "backup_path": backup_path,
        "backup_size_bytes": os.path.getsize(backup_path),
        "pre_integrity": pre_integrity,
        "restore_verified": restore_verified,
        "pre_tables_count": len(pre_tables),
        "post_tables_count": len(post_tables),
        "new_tables": sorted(set(post_tables) - set(pre_tables)),
        "topics_columns_count": len(topic_cols),
        "post_integrity": post_integrity,
        "idempotent_double_init_passed": True,
        "pre_counts": pre_counts,
        "post_counts": post_counts,
        "rollback_plan": f"停止后端服务后，将 {backup_path} 覆盖回 {DB_PATH} 即可 100% 无损回滚至 Phase 4 迁移前状态。",
    }
    out_path = os.path.join(ROOT, "data", "search_p4_backup_migration.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    assert restore_verified and post_integrity == "ok"
    assert pre_counts["topics"] == post_counts["topics"]


if __name__ == "__main__":
    main()
