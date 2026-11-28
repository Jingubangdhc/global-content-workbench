#!/usr/bin/env python3
"""SEARCH-PHASE-1 · 正式数据库热备份、可恢复性校验与增量建表脚本。"""
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
BAK_PATH = BAK_DIR / f"workbench_pre_search_p1_{ts}.db"

# 1. 热备份（迁移前）
src = sqlite3.connect(str(DB_PATH))
dst = sqlite3.connect(str(BAK_PATH))
src.backup(dst)
pre_tables = [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
key_tables = ("projects", "keywords", "creators", "contents", "transcripts", "comments")
pre_counts = {t: src.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in key_tables}
src.close()

bak_integrity = dst.execute("PRAGMA integrity_check").fetchone()[0]
dst.close()
assert bak_integrity == "ok", f"备份完整性校验失败: {bak_integrity}"

# 2. 可恢复性验证（复制到独立临时库并逐表核对）
tmp_restore = BAK_DIR / f"_verify_restore_{ts}.db"
shutil.copy2(BAK_PATH, tmp_restore)
rcon = sqlite3.connect(str(tmp_restore))
restore_integrity = rcon.execute("PRAGMA integrity_check").fetchone()[0]
restore_tables = [r[0] for r in rcon.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
restore_counts = {t: rcon.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in key_tables}
rcon.close()
tmp_restore.unlink()

assert restore_integrity == "ok" and pre_tables == restore_tables and pre_counts == restore_counts, "可恢复性验证不通过"

# 3. 执行增量建表（research_tasks + keyword_candidates）
from backend.db import init_db
init_db()

post = sqlite3.connect(str(DB_PATH))
post_integrity = post.execute("PRAGMA integrity_check").fetchone()[0]
post_tables = [r[0] for r in post.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
post_counts = {t: post.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in key_tables}
post.close()

result = {
    "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
    "backup_path": str(BAK_PATH),
    "backup_size_bytes": BAK_PATH.stat().st_size,
    "backup_integrity": bak_integrity,
    "restore_verified": True,
    "pre_tables_count": len(pre_tables),
    "post_tables_count": len(post_tables),
    "new_tables": sorted(set(post_tables) - set(pre_tables)),
    "post_integrity": post_integrity,
    "row_counts_preserved": pre_counts == post_counts,
    "row_counts": post_counts,
}
out_log = ROOT / "data" / "search_p1_backup_migration.json"
out_log.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, indent=2))
