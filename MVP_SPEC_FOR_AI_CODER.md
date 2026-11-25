# 全网内容收集与赛道收益工作台：MVP 产品与工程交付规划书（V3.0）

> **致 AI 编码助手（Codex / Gemini）**：本文件是经用户确认的完整 MVP 工程规格书。请严格按本文件的模块范围、SQLite 表结构、API 契约及第 5.4 节本机实测避坑铁律进行开发，切勿擅自扩充二期复杂功能，也切勿跳过本机兼容性约束。
> **已就绪种子数据**：当前目录下的 `./seed/resource_db/*.json`（11 个文件，来自《全球创作者数据资源库_V4筛选修复版.xlsx》）与 `./seed/sop_db/*.json`（14 个文件，来自《HuaHui_YouTube_海外选题素材SOP_v1.xlsx》）已全部清洗转换为标准 UTF-8 JSON，可直接用于首次启动灌库。

---

## 1. 本机实测环境基线
- **系统与硬件**：Windows，Intel Core i5-12490F，NVIDIA RTX 4060 (8GB)，32GB RAM。
- **已安装工具**：`Python 3.14.5`（当前目录已有 `.venv`）、`Node.js v24.15.0`、`npm 11.12.1`、`ffmpeg 9.0.2-full_build`。
- **架构选型**：`FastAPI` + `SQLite3 (WAL)` 后端 + `React 18 + TypeScript + Vite + Tailwind CSS` 前端，配 `start.bat` 一键启动。

---

## 2. 产品核心范围：两大刚需模块、五个主页面

### 模块一：全网内容收集与文案提取
1. **页面 ① 关键词搜爆款中心 (`SearchHub`)**：
   - 左侧：导入并管理 `seed/sop_db/03_关键词检索.json` 的 22 条种子词（保留赛道、子类、潜在观众、公式、核实提醒），支持按项目分组与新增关键词，显示该词下已收视频数与已提文案数。
   - 右侧上层（工作台直拉）：
     - **YouTube 爆款页签**：默认调用 `yt-dlp` 免 Key 搜索 `ytsearch20:<keyword>`；支持拉取频道近 15–20 条同形态视频计算基线播放中位数与 `outlier_score = 视频播放 / 频道中位数`，按 `≥10x 红标极高优先`、`≥5x 橙标高优先`、`≥3x 绿标值得研究` 着色；提供“只看低粉爆款”“排除 Shorts”开关；行内一键 `[收录]`、`[提文案]`。
     - **B 站页签**：调用 `bilisearch10:<keyword>` 并补全视频详情（标题、UP主、播放、点赞、评论、时长）。
     - **全网文章页签**：若 `.env` 配有 `TAVILY_API_KEY` 则直接返回网页列表并支持一键提取正文；未配时展示带词直达 Google / Google News / Medium / Substack / 搜狗微信按钮。
   - 右侧下层（全网一键带词搜索跳板 + 核心榜单条）：
     - 自动将关键词 URL 编码拼入 TikTok、抖音、小红书、快手、Instagram、X、Reddit、Quora、知乎、微博、Google Trends、TikTok Creative Center、抖音热点宝、巨量算数、百度指数、今日热榜等，支持单开或分组一键连开。
     - 联动展示 `seed/resource_db` 中 `爆款与选题` 与 `热点与需求趋势` 的 A 级免费榜单。
2. **页面 ② 素材与作者库 (`ContentAuthors`)**：
   - 支持单条/批量粘贴链接（自动用正则从抖音/小红书分享口令混合文本中提取 URL）、浏览器书签栏 Bookmarklet（`GET /quick-collect?url=...&title=...`）、第三方带货导出 CSV 批量导入。
   - 按 `(platform, platform_item_id)` 唯一去重；调用 `yt-dlp` 免下载补全元数据与原视频/作者主页链接；抓不到的指标一律存 `NULL` 显示 `待补`（严禁填 `0`），支持行内手补。
   - **变现指纹程序扫描（0 Token 纯正则）**：自动扫描视频简介与作者简介中的外链，分类识别独立站（Shopify/自建域名）、联盟链接（`amzn.to`、`tag=`、`linktr.ee`、`beacons.ai`、折扣码）、知识付费（Patreon、Substack、Gumroad、小鹅通）、私信漏斗（WhatsApp、WeChat、Telegram、Calendly）。
3. **页面 ③ 文案提取工坊 (`TranscriptStudio`)**：
   - 五级提取链：① `youtube-transcript-api` / `yt-dlp` 字幕 → ② 网页 URL 走 `requests(浏览器UA) + trafilatura` → ③ `yt-dlp` 下载最轻音频流 + 本地 `faster-whisper` 转写（转写完立即删除音频）→ ④ 下载受阻时支持拖拽上传本地音视频文件直接转写 → ⑤ 403/失败兜底手动粘贴框。
   - 左右双栏界面：左栏只读保留原始提取稿（带时间戳），右栏独立编辑二创口播稿（内置 `seed/sop_db/10_脚本结构.json` 的 5 种结构骨架一键插入，以及可选按次触发的中文翻译按钮）。
   - 支持导出 `.md`、`.docx`，以及兼容原 SOP `04/05/06` 表头的 `.xlsx`。

### 模块二：赛道收益情报与网址总控
4. **页面 ④ 赛道收益雷达 (`RevenueRadar`)**：
   - **视角切换铁律**：顶部默认选中 `[🔭 查同行 / 看赛道收益]`（过滤出公开竞品/间接研究/部分公开入口），将 96 条 `自有/授权` 后台折叠进 `[🔐 我的经营后台]` 快捷抽屉。
   - **同名工具合并规则**：按规范化主域名合并卡片（解决原表如 FastMoss/飞瓜在 S 表标“限额免费”、在 M 表标“付费为主”的冲突，统一展示分层说明：`基础榜单限免 + 带货GMV明细付费`），并补齐跨表关联（快手带货关联 `S107 飞瓜快手`、小红书关联 `S083 千瓜 / S085 新红`、YT 打赏关联 `S007 Playboard`、快手商单关联 `S109 磁力聚星`、Substack 关联 `S046–S048`）。
   - **免费直通 vs 付费决策卡**：
     - `🟢 免费` / `🟡 限免或需资格`：左键直接打开，支持拼参的工具自动拼好 `@handle` 或域名。
     - `🔴 付费为主`：点击先展开「付费前决策卡」（展示可查指标、操作路径、“第三方估算≠真实净收”红线、官方价格核查页 `证据网址`、`[去官网查看 ↗]`、以及个人标记 `[未试用 / 💳已付费(填月费) / ⭐标星置顶 / ❌不买]`）。
   - **作者收益一页透视**：选中任意作者或输入 `@handle` / 独立站域名，自动生成 Viewstats、Social Blade、Similarweb、PPSPY、Graphtreon、Meta Ad Library 等直达按钮组 + 简介变现指纹列表。
   - **右侧常驻「收益反推计算器」+「赛道收益证据本」**：完整实现 `seed/resource_db/商业计算器.json` 与 `指标与计算.json` 的全部公式（RPM、GPM、带货佣金、私信获客五级转化漏斗 CPL/CAC/贡献利润、独立站 CVR/AOV/ROAS、联盟 EPC），并支持录入 L1 自有 / L2 博主自晒 / L3 第三方估算的赛道收益记录。
5. **页面 ⑤ 网址导航总库 (`ResourceDirectory`)**：
   - 全量展示 `seed/resource_db` 全部 264 条能力记录 / 139+ 独立网址，支持按 16 大数据类别、地区、平台、收费类型、可查对象组合秒筛、搜索、新增网址、行内备注及导出 Excel。

---

## 3. SQLite 数据库表结构

请严格创建以下 8 张核心表（详见会话主报告 `内容收集与赛道收益工作台_MVP交付规划_V3.md` 第 5.2 节 SQL 定义）：
1. `projects`（项目空间）
2. `keywords`（SOP 种子词与检索状态）
3. `creators`（对标作者、基线中位数与变现指纹 JSON）
4. `contents`（跨平台视频/文章/讨论、异常倍数 `outlier_score`、外链 JSON、状态流转）
5. `transcripts`（只读原始提取稿、时间戳 JSON、译文、钩子拆解与二创草稿）
6. `tools`（按主域名去重的独立网址实体 + 个人试用/付费/置顶账本）
7. `tool_capabilities`（264 条总汇 + 77 条商业数据源的多平台多变现映射明细）
8. `revenue_evidence`（L1/L2/L3 分级赛道收益情报账本）

---

## 4. Phase 0 本机已实测避坑铁律（编码硬约束）

1. **锁死 PyAV 版本**：Python 3.14 下必须锁定 `av>=14.0.0,<16.0.0`（实测 `av==15.1.0` 正常，`av>=19` 会令 `faster-whisper` 抛 `metadata_errors` 异常）。
2. **Whisper 镜像与设备回退**：默认设置 `HF_ENDPOINT=https://hf-mirror.com`；默认采用 `WhisperModel("small", device="cpu", compute_type="int8")`，仅当检测到 `cublas64_12.dll` 可正常加载时才启用 `cuda`；音频文件转写完毕必须立即删除。
3. **网页正文提取**：严禁调用 `trafilatura.fetch_url()`（实测返回空）；必须先用 `requests.get(url, headers={"User-Agent": "Mozilla/5.0 ..."}, timeout=20)` 校验 HTTP 200 后再传入 `trafilatura.extract(html)`，遇到 403/404 引导前端手动粘贴。
4. **风控与 Cookie**：B 站无 Cookie 下载音频可能返回 HTTP 567；设置页提供可选 `cookiesfrombrowser` 开关（默认关闭），下载失败直接降级到“上传本地音视频文件转写”或“手动粘贴”，严禁死循环重试。
5. **外部收益站只做前端跳转**：Social Blade、Meta Ad Library 等对后端请求返回 403，但在用户浏览器点击完全正常；严禁后端发请求预检外部工具状态。
6. **缺失值与估算标注**：缺失指标一律存 `NULL`（严禁填 `0`）；所有第三方 GMV 与收益估算值旁必须渲染 `[估算]` 标签。
