#!/usr/bin/env python3
"""SEARCH-PHASE-3 · 正式数据库热备份、独立副本可恢复性验证与 6 张新表幂等迁移。"""
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(r"C:\Users\wodhc\.gemini\antigravity\scratch\content-workbench")
sys.path.insert(0, str(ROOT))

DB_PATH = ROOT / "data" / "workbench.db"
BAK_DIR = ROOT / "data" / "backups"
BAK_DIR.mkdir(parents=True, exist_ok=True)
ts = time.strftime("%Y%m%d_%H%M%S")
BAK_PATH = BAK_DIR / f"workbench_pre_search_p3_{ts}.db"

src = sqlite3.connect(str(DB_PATH))
dst = sqlite3.connect(str(BAK_PATH))
src.backup(dst)
pre_tables = [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
key_tables = ("projects", "keywords", "creators", "contents", "research_tasks", "keyword_candidates", "search_batch_runs", "project_content_links", "content_metric_snapshots")
pre_counts = {t: src.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in key_tables}
src.close()

bak_integrity = dst.execute("PRAGMA integrity_check").fetchone()[0]
dst.close()
assert bak_integrity == "ok"

tmp_restore = BAK_DIR / f"_verify_restore_p3_{ts}.db"
shutil.copy2(BAK_PATH, tmp_restore)
rcon = sqlite3.connect(str(tmp_restore))
restore_integrity = rcon.execute("PRAGMA integrity_check").fetchone()[0]
restore_tables = [r[0] for r in rcon.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
restore_counts = {t: rcon.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in key_tables}
rcon.close()
tmp_restore.unlink()
assert restore_integrity == "ok" and pre_tables == restore_tables and pre_counts == restore_counts

from backend.db import init_db
init_db()
init_db()

post = sqlite3.connect(str(DB_PATH))
post_integrity = post.execute("PRAGMA integrity_check").fetchone()[0]
post_tables = [r[0] for r in post.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
post_counts = {t: post.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in key_tables}
post.close()

res = {
    "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
    "backup_path": str(BAK_PATH),
    "backup_size_bytes": BAK_PATH.stat().st_size,
    "backup_integrity": bak_integrity,
    "restore_verified": True,
    "idempotent_double_init_ok": True,
    "pre_tables_count": len(pre_tables),
    "post_tables_count": len(post_tables),
    "new_tables": sorted(set(post_tables) - set(pre_tables)),
    "post_integrity": post_integrity,
    "row_counts_preserved": pre_counts == post_counts,
    "row_counts": post_counts,
}
(ROOT / "data" / "search_p3_backup_migration.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(res, ensure_ascii=False, indent=2))
