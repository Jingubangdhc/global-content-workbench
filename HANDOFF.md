# Global Content Workbench · 研发交接文档 (HANDOFF.md)

## 1. 本轮需求范围（GCW-WORKSPACE-V2）
将选题资产中心（TopicHub）升级为集视频观看、数据研究、参考文案、原创文案创作于一体的工作区，并完成 `GCW-UI-02` 全局字体与四档可读性整改；不开发独立智能体与视频制作系统。

## 2. 已实现内容与关键源码位置
1. **GCW-WORKSPACE-01（TopicHub V2 固定布局）**：
   - `frontend/src/pages/TopicHub.tsx`：左侧项目选择、选题搜索、4 种时间排序（默认最新创建优先）、日期范围筛选、7 态生命周期筛选与选题列表；右侧 6 层固定结构 + 视频/文案高度拖拽 + 参考/原创宽度拖拽 + 低频管理归入「选题详情与档案」抽屉；
   - `frontend/src/App.tsx`：左侧主导航一键折叠/展开、默认舒适 16px、取消旧独立「文案提取工坊」菜单入口（保留底层 API 与历史数据）、弹窗打开时通过 `overlayBlocked` 自动隐藏原生播放器防遮挡。
2. **GCW-WORKSPACE-02（固定内嵌视频播放与时间戳跳转）**：
   - `desktop/main.js` & `desktop/preload.js`：复用 `topicPlayerView`，新增受控 `gcw-browser:seek-video` IPC；
   - `frontend/src/components/workspace/EmbeddedVideoWorkspace.tsx`：`ResizeObserver` + 滚动/缩放同步 `setBounds`、保留 R4-G 100ms 真实同步与外语自动翻译闭环、保留工作台内最大化/恢复。
3. **GCW-WORKSPACE-03（当前视频真实数据面板）**：
   - `backend/services/topic_hub_service.py`（`get_content_metrics_detail` / `refresh_content_metrics`）& `backend/routers/topic_hub.py`：8 项核心指标 + 互动率口径 + 严格 ≥3 条同作者同平台历史作品的异常爆款倍数基准，刷新失败保留原值不以 0 覆盖；
   - `frontend/src/components/workspace/VideoMetricsBar.tsx`。
4. **GCW-WORKSPACE-04（参考文案与视频时间轴联动）**：
   - `frontend/src/components/workspace/ReferenceTranscriptPane.tsx`：复用既有字幕提取/混元翻译/人工修订缓存，支持双语/原文/中文切换、自动滚动开关、点击时间戳真实 `seekVideo` 跳转、复制与导出。
5. **GCW-WORKSPACE-05（原创文案与 Skill 工作区）**：
   - `backend/services/topic_hub_service.py`（`get_topic_original_draft` / `save_topic_original_draft`，复用 `app_settings` 零表结构变更）；
   - `frontend/src/components/workspace/OriginalCopyStudioPane.tsx`：导入/选择/自定义/删除 Skill、切换 AI 模型、防抖自动保存草稿（带 `reqSeq` 竞态防护）、生成前防覆盖确认、保存与恢复历史正式版本。
6. **GCW-WORKSPACE-06（选题时间管理）**：
   - `backend/services/topic_hub_service.py`（`list_topics_hub` 支持 `created_desc` / `created_asc` / `updated_desc` / `captured_desc` 与 `date_from` / `date_to`）；前端统一本机时区格式化，缺失显示「未知」。
7. **GCW-UI-02（全局字体与可读性整改）**：
   - `frontend/src/styles/design-tokens.css`：默认舒适 16px，四档字号（14/15/16/18px），微软雅黑 + Inter/Segoe UI + 等宽数字；全站 15 个前端组件硬编码 `text-[10px]` / `text-[11px]` 替换为可随设置动态缩放的语义类。

## 3. 未完成 / 保留用户人工确认事项
- 旧文件 `frontend/src/pages/TranscriptStudio.tsx` 菜单入口已取消，但暂保留源码文件作为底层过渡备份，待用户最终验收确认后再物理删除；
- 外接 2560×1440 物理高分屏与 125%/150% Windows DPI 下的主观视觉舒适度需用户本机亲测；
- 付费云端 API（需用户主动授权）生成原创文案的风格满意度需用户亲测。

## 4. 版本与测试证据
- 本地候选版本：`v0.2.4-rc`（上一恢复点：`v0.2.3-rc`）
- 本轮 FIX-03-C 验收证据：`docs/gcw_workspace_v2_fix_03_c/verify_fix03c_e2e.js`、`GCW_FIX_03_C_TEST_RESULTS.json`、`GCW_FIX_03_C_CODE_CHANGE_REPORT.md`（单/多条评论生成、混合无效评论 400、跨项目/无效评论入库拒绝且事务零残留回滚、`free_only` 隔离拦截 403、`[TEST-ONLY]` Skill 拆解安全 Markdown 表格渲染与四档字号回归全绿；用户正式拆解 Skill 仍标 `BLOCKED`）。
- 远程审查分支最终 Commit SHA 见本轮交付卡与 `git rev-parse origin/review/gcw-uat-r4`。
