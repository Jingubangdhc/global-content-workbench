"""SQLite 数据库建表、WAL 优化、每日自动备份与两份 Excel 种子 JSON 幂等灌库。"""
import datetime
import json
import shutil
import sqlite3
from pathlib import Path
from urllib.parse import urlparse

from backend.config import BACKUP_DIR, DB_PATH, SEED_DIR

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    target_country TEXT DEFAULT 'United States',
    target_audience TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id),
    category TEXT,
    subcategory TEXT,
    keyword TEXT NOT NULL,
    audience TEXT,
    formula_note TEXT,
    verify_warning TEXT,
    last_searched_at TEXT,
    UNIQUE(project_id, keyword)
);

CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    platform_creator_id TEXT NOT NULL,
    name TEXT,
    handle TEXT,
    profile_url TEXT,
    follower_count INTEGER,
    baseline_median_views REAL,
    baseline_updated_at TEXT,
    bio_text TEXT,
    detected_monetization_json TEXT,
    strengths_note TEXT,
    estimated_monthly_rev_note TEXT,
    is_starred INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, platform_creator_id)
);

CREATE TABLE IF NOT EXISTS contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id),
    keyword_id INTEGER REFERENCES keywords(id),
    creator_id INTEGER REFERENCES creators(id),
    platform TEXT NOT NULL,
    platform_item_id TEXT NOT NULL,
    content_type TEXT,
    title TEXT,
    url TEXT NOT NULL,
    thumbnail_url TEXT,
    published_at TEXT,
    duration_sec INTEGER,
    view_count INTEGER,
    like_count INTEGER,
    comment_count INTEGER,
    views_to_followers REAL,
    outlier_score REAL,
    collect_reason TEXT,
    detected_links_json TEXT,
    status TEXT DEFAULT 'inbox',
    collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, platform_item_id)
);

CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL UNIQUE REFERENCES contents(id) ON DELETE CASCADE,
    extract_method TEXT,
    language TEXT,
    raw_text TEXT,
    segments_json TEXT,
    translated_zh TEXT,
    hook_analysis TEXT,
    script_template_type TEXT,
    my_draft_text TEXT,
    extract_error TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_code TEXT UNIQUE,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    domain TEXT,
    access_scope TEXT,
    fee_tier TEXT,
    fee_detail TEXT,
    pricing_evidence_url TEXT,
    my_status TEXT DEFAULT 'untested',
    my_monthly_cost REAL,
    my_expire_date TEXT,
    is_pinned INTEGER DEFAULT 0,
    my_note TEXT
);

CREATE TABLE IF NOT EXISTS tool_capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    source_record_id TEXT,
    major_group TEXT,
    category TEXT,
    region TEXT,
    target_platform TEXT,
    data_nature TEXT,
    metrics_desc TEXT,
    operation_path TEXT,
    limitation_warning TEXT,
    priority TEXT
);

CREATE TABLE IF NOT EXISTS revenue_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id),
    creator_id INTEGER REFERENCES creators(id),
    niche TEXT NOT NULL,
    monetization_type TEXT NOT NULL,
    platform TEXT NOT NULL,
    content_format TEXT,
    audience_region TEXT,
    metric_name TEXT,
    amount_min REAL,
    amount_max REAL,
    currency TEXT DEFAULT 'USD',
    period_desc TEXT,
    evidence_level TEXT NOT NULL,
    source_url TEXT,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS script_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_type TEXT UNIQUE,
    hook_strategy TEXT,
    sample_hook TEXT,
    structure_desc TEXT,
    visual_evidence TEXT,
    ending_idea TEXT,
    cta TEXT,
    precaution TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER REFERENCES contents(id) ON DELETE SET NULL,
    quote_text TEXT NOT NULL,
    category TEXT DEFAULT '金句',
    timestamp_sec REAL,
    source_url TEXT,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    asset_type TEXT DEFAULT 'image',
    title TEXT,
    thumb_url TEXT,
    asset_url TEXT NOT NULL,
    source_page_url TEXT,
    author TEXT,
    license TEXT,
    commercial_ok TEXT DEFAULT '需核实',
    segment_note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    platform_comment_id TEXT,
    author TEXT,
    text TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    is_question INTEGER DEFAULT 0,
    is_pain_point INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(content_id, platform_comment_id)
);
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def normalize_url(url: str) -> tuple[str, str]:
    """规范化网址并提取主域名，用于合并同类工具主卡。"""
    u = (url or "").strip()
    if not u.startswith(("http://", "https://")):
        return u, ""
    p = urlparse(u)
    host = p.netloc.lower().lstrip("www.")
    norm = f"{p.scheme}://{p.netloc.lower()}{p.path.rstrip('/')}"
    if p.query:
        norm += f"?{p.query}"
    return norm, host


def map_access_scope(raw: str) -> str:
    s = (raw or "").strip()
    if "自有" in s:
        return "own_only"
    if "部分公开" in s or "授权合作" in s:
        return "partial"
    if "公开竞品" in s:
        return "competitor"
    if "间接" in s:
        return "indirect"
    return "unknown"


def map_fee_tier(raw: str, raw_orig: str = "") -> str:
    s = f"{raw} {raw_orig}"
    if "付费为主" in s:
        return "paid"
    if "限额免费" in s or "套餐" in s or "需资格" in s:
        return "freemium"
    if "免费核心" in s:
        return "free"
    return "unknown"


# 同名工具跨表收费分层说明（解决 S 表限额免费 vs M 表付费为主的冲突）
LAYERED_FEE_HINTS = {
    "fastmoss.com": ("paid", "基础榜单浏览：🟡 注册限免｜带货视频 GMV/销量明细与导出：🔴 付费会员"),
    "kalodata.com": ("paid", "7天体验试用｜TikTok Shop 带货视频 GMV/达人/选品：🔴 付费为主"),
    "dy.feigua.cn": ("paid", "基础榜单：🟡 注册限免｜抖音短视频/直播带货 GMV 明细：🔴 付费为主"),
    "feigua.cn": ("paid", "基础榜单：🟡 注册限免｜综合短视频/直播电商明细：🔴 付费为主"),
    "chanmama.com": ("paid", "基础榜单：🟡 注册限免｜抖音短视频/直播带货 GMV 明细：🔴 付费为主"),
    "huitun.com": ("paid", "基础达人榜：🟡 注册限免｜带货 GMV/直播明细：🔴 付费为主"),
    "qian-gua.com": ("paid", "官方提供会员版本与试用｜小红书爆款笔记/直播带货：🔴 付费为主"),
    "youwant.cn": ("paid", "视频号基础概览：🟡 限免｜视频号直播带货 GMV 估算：🔴 付费为主"),
    "xingtu.cn": ("freemium", "🟡 官方星图撮合后台：需达人或广告主/品牌资格登录查看刊例报价"),
    "pgy.xiaohongshu.com": ("freemium", "🟡 官方蒲公英后台：需达人或品牌账号登录查看商业报价"),
    "huahuo.bilibili.com": ("freemium", "🟡 官方B站花火后台：需UP主或品牌账号登录查看合作报价"),
    "kling.kuaishou.com": ("freemium", "🟡 官方快手磁力聚星：需对应角色登录查看达人商业报价"),
}

# 跨表补齐映射：把内容库里明确能看同行收益的工具关联到对应商业变现赛道
CROSS_TABLE_SUPPLEMENTS = [
    ("https://ks.feigua.cn", "飞瓜快手", "短视频带货", "国内", "快手", "第三方估算", "快手达人短视频带货、商品销量与增长估算", "短视频/达人榜", "第三方估算，需套餐解锁明细", "A 核心"),
    ("https://www.qian-gua.com", "千瓜数据", "短视频带货", "国内", "小红书", "第三方估算", "小红书商业带货笔记、商品种草与达人表现", "商品/品牌/笔记搜索", "第三方估算，会员收费", "A 核心"),
    ("https://playboard.co", "Playboard", "直播打赏", "海外", "YouTube", "公开代理指标", "YouTube Super Chat 打赏榜、频道全球排名", "Super Chat Rankings", "基于公开打赏估算，不含私下商单", "A 核心"),
    ("https://www.viewstats.com", "Viewstats", "流量分成/RPM", "海外", "YouTube", "第三方估算", "频道月播放量趋势、Outlier 异常爆款与估算收益", "搜索频道 @handle → Channelytics", "第三方模型估算，非真实后台 RPM", "A 核心"),
    ("https://www.noxinfluencer.com", "NoxInfluencer", "流量分成/RPM", "海外", "YouTube", "第三方估算", "YouTube/海外网红播放估算、频道广告收益区间", "搜索频道名", "粗略区间估算，仅供参考", "B 按需"),
    ("https://substack.com/discover", "Substack Discover", "知识付费/订阅", "海外", "Substack", "公开代理指标", "各细分赛道头部付费 Newsletter 榜单与订阅规模", "Discover → 选分类 → Rising / Top Paid", "仅展示公开排行，不含净到手", "A 核心"),
    ("https://inboxreads.co", "InboxReads", "知识付费/订阅", "海外", "Substack", "公开代理指标", "细分领域 Newsletter 发现与订阅者估算", "按领域筛选", "估算指标", "B 按需"),
    ("https://reletter.com", "Reletter", "知识付费/订阅", "海外", "Substack", "第三方估算", "Newsletter 搜索、作者发刊频率与受众研究", "搜索关键词或作者", "付费为主", "B 按需"),
]


def backup_database_daily() -> None:
    """每日首次启动自动备份 SQLite，最多保留近 14 份。"""
    if not DB_PATH.exists():
        return
    today = datetime.date.today().strftime("%Y%m%d")
    dst = BACKUP_DIR / f"workbench_{today}.db"
    if not dst.exists():
        try:
            shutil.copy2(DB_PATH, dst)
        except Exception:
            pass
    backups = sorted(BACKUP_DIR.glob("workbench_*.db"), reverse=True)
    for old in backups[14:]:
        try:
            old.unlink()
        except Exception:
            pass


def init_db() -> dict:
    """初始化表结构并幂等导入种子数据。"""
    conn = get_conn()
    conn.executescript(SCHEMA_SQL)

    # 幂等迁移：为老库 transcripts / comments 表追加新字段
    tr_cols = {r["name"] for r in conn.execute("PRAGMA table_info(transcripts)").fetchall()}
    if "heatmap_json" not in tr_cols:
        conn.execute("ALTER TABLE transcripts ADD COLUMN heatmap_json TEXT")
    if "breakdown_json" not in tr_cols:
        conn.execute("ALTER TABLE transcripts ADD COLUMN breakdown_json TEXT")
    cm_cols = {r["name"] for r in conn.execute("PRAGMA table_info(comments)").fetchall()}
    if "translated_zh" not in cm_cols:
        conn.execute("ALTER TABLE comments ADD COLUMN translated_zh TEXT")

    # 默认设置
    defaults = {
        "cookie_browser": "none",  # none / chrome / edge
        "low_follower_threshold": "50000",
        "theme": "terminal_dark",
    }
    for k, v in defaults.items():
        conn.execute("INSERT OR IGNORE INTO app_settings(key, value) VALUES (?, ?)", (k, v))

    # 默认项目
    conn.execute(
        "INSERT OR IGNORE INTO projects(name, target_country, target_audience, notes) VALUES (?, ?, ?, ?)",
        ("跨境医疗（海外）", "United States", "美国/英国英文受众、赴华医疗与旅行者", "对应 HuaHui 海外内容研究 SOP"),
    )
    conn.execute(
        "INSERT OR IGNORE INTO projects(name, target_country, target_audience, notes) VALUES (?, ?, ?, ?)",
        ("商业认知与变现", "Global", "全球创作者、短视频带货与独立站观察", "研究各赛道高变现模式与案例"),
    )
    proj_id = conn.execute("SELECT id FROM projects WHERE name = '跨境医疗（海外）'").fetchone()["id"]

    # 1. 导入 SOP 22 条种子关键词
    kw_file = SEED_DIR / "sop_db" / "03_关键词检索.json"
    if kw_file.exists() and conn.execute("SELECT COUNT(*) FROM keywords").fetchone()[0] == 0:
        for r in json.loads(kw_file.read_text(encoding="utf-8")):
            kw = (r.get("英语搜索词（可改）") or "").strip()
            if not kw:
                continue
            conn.execute(
                """INSERT OR IGNORE INTO keywords
                   (project_id, category, subcategory, keyword, audience, formula_note, verify_warning)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    proj_id,
                    r.get("内容赛道", ""),
                    r.get("子类", ""),
                    kw,
                    r.get("潜在观众", ""),
                    r.get("你国内公式对应", ""),
                    r.get("特别核实", ""),
                ),
            )

    # 2. 导入 SOP 5 种脚本结构模板
    tpl_file = SEED_DIR / "sop_db" / "10_脚本结构.json"
    if tpl_file.exists() and conn.execute("SELECT COUNT(*) FROM script_templates").fetchone()[0] == 0:
        for r in json.loads(tpl_file.read_text(encoding="utf-8")):
            t = (r.get("结构类型") or "").strip()
            if not t:
                continue
            conn.execute(
                """INSERT OR IGNORE INTO script_templates
                   (template_type, hook_strategy, sample_hook, structure_desc, visual_evidence, ending_idea, cta, precaution)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    t,
                    r.get("开头策略", ""),
                    r.get("英语Hook（可修改）", ""),
                    r.get("长视频结构", ""),
                    r.get("该准备什么画面/证据", ""),
                    r.get("收尾金句思路", ""),
                    r.get("行动引导", ""),
                    r.get("必须防范", ""),
                ),
            )

    # 3. 导入全部 264 条数据总汇 + 跨表补齐
    res_file = SEED_DIR / "resource_db" / "数据总汇.json"
    if res_file.exists() and conn.execute("SELECT COUNT(*) FROM tools").fetchone()[0] == 0:
        rows = json.loads(res_file.read_text(encoding="utf-8"))
        url_to_tool_id: dict[str, int] = {}

        for r in rows:
            raw_url = (r.get("网站地址") or "").strip()
            if not raw_url.startswith("http"):
                continue
            norm_url, host = normalize_url(raw_url)
            scope = map_access_scope(r.get("可查对象", ""))
            fee = map_fee_tier(r.get("收费类型", ""), r.get("原始收费说明", ""))
            fee_detail = (r.get("操作路径/访问条件") or "").strip()

            # 同名工具分层覆盖
            if host in LAYERED_FEE_HINTS:
                fee, fee_detail = LAYERED_FEE_HINTS[host]

            tool_id = url_to_tool_id.get(norm_url)
            if not tool_id:
                cur = conn.execute(
                    """INSERT OR IGNORE INTO tools
                       (tool_code, name, url, domain, access_scope, fee_tier, fee_detail, pricing_evidence_url)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        r.get("来源ID", "") or f"T_{len(url_to_tool_id)+1}",
                        (r.get("工具名称") or host).strip(),
                        norm_url,
                        host,
                        scope,
                        fee,
                        fee_detail,
                        (r.get("证据网址") or norm_url).strip(),
                    ),
                )
                row_t = conn.execute("SELECT id, access_scope, fee_tier FROM tools WHERE url = ?", (norm_url,)).fetchone()
                tool_id = row_t["id"]
                url_to_tool_id[norm_url] = tool_id
            else:
                # 合并冲突时：只要存在“公开竞品/部分公开/间接研究”，则不被 own_only 覆盖；收费取最严
                existing = conn.execute("SELECT access_scope, fee_tier FROM tools WHERE id = ?", (tool_id,)).fetchone()
                if existing["access_scope"] == "own_only" and scope != "own_only":
                    conn.execute("UPDATE tools SET access_scope = ? WHERE id = ?", (scope, tool_id))
                if host not in LAYERED_FEE_HINTS and existing["fee_tier"] != "paid" and fee == "paid":
                    conn.execute("UPDATE tools SET fee_tier = 'paid' WHERE id = ?", (tool_id,))

            # 避免同一工具在同平台同类别重复插入（如星图/蒲公英/花火在 S/M 表重复）
            dup = conn.execute(
                """SELECT id FROM tool_capabilities
                   WHERE tool_id = ? AND category = ? AND target_platform = ?""",
                (tool_id, r.get("数据类别", ""), r.get("目标平台", "")),
            ).fetchone()
            if not dup:
                conn.execute(
                    """INSERT INTO tool_capabilities
                       (tool_id, source_record_id, major_group, category, region, target_platform,
                        data_nature, metrics_desc, operation_path, limitation_warning, priority)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        tool_id,
                        r.get("来源ID", ""),
                        r.get("数据大类", ""),
                        r.get("数据类别", ""),
                        r.get("地区", ""),
                        r.get("目标平台", ""),
                        r.get("数据性质", ""),
                        r.get("可查数据/功能", ""),
                        r.get("操作路径/访问条件", ""),
                        r.get("限制及注意事项", ""),
                        r.get("使用优先级", ""),
                    ),
                )

        # 写入跨表补齐的竞品收益映射
        for u, name, cat, region, plat, nature, metrics, path, warn, prio in CROSS_TABLE_SUPPLEMENTS:
            norm_url, host = normalize_url(u)
            row_t = conn.execute("SELECT id FROM tools WHERE url = ?", (norm_url,)).fetchone()
            if not row_t:
                continue
            tid = row_t["id"]
            dup = conn.execute(
                "SELECT id FROM tool_capabilities WHERE tool_id = ? AND category = ? AND target_platform = ?",
                (tid, cat, plat),
            ).fetchone()
            if not dup:
                conn.execute(
                    """INSERT INTO tool_capabilities
                       (tool_id, source_record_id, major_group, category, region, target_platform,
                        data_nature, metrics_desc, operation_path, limitation_warning, priority)
                       VALUES (?, ?, '商业变现', ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (tid, f"SUP_{tid}", cat, region, plat, nature, metrics, path, warn, prio),
                )

    conn.commit()
    stats = {
        "projects": conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
        "keywords": conn.execute("SELECT COUNT(*) FROM keywords").fetchone()[0],
        "tools": conn.execute("SELECT COUNT(*) FROM tools").fetchone()[0],
        "capabilities": conn.execute("SELECT COUNT(*) FROM tool_capabilities").fetchone()[0],
        "templates": conn.execute("SELECT COUNT(*) FROM script_templates").fetchone()[0],
    }
    conn.close()
    backup_database_daily()
    return stats
