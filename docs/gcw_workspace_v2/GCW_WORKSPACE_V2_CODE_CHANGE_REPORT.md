# GCW-WORKSPACE-V2 · 代码变更报告

## 1. 新增文件
- `frontend/src/components/workspace/EmbeddedVideoWorkspace.tsx`（固定内嵌 `topicPlayerView` + 实时双语字幕影院条 + 100ms 真实同步 + 外语自动翻译）
- `frontend/src/components/workspace/VideoMetricsBar.tsx`（8 项核心指标 + 互动率口径 + 同作者基准异常爆款倍数 + 按需刷新）
- `frontend/src/components/workspace/ReferenceTranscriptPane.tsx`（参考文案缓存复用、双语/原文/中文、人工修订、复制导出、点击时间戳 `seekVideo` 联动）
- `frontend/src/components/workspace/OriginalCopyStudioPane.tsx`（Skill 导入/自定义/删除、模型切换、独立草稿自动保存、正式版本保存与恢复）
- `PROJECT_STATUS.md`、`HANDOFF.md`、`CHANGELOG.md`
- `docs/gcw_workspace_v2/`（验收报告、代码变更报告、版本映射与测试脚本）

## 2. 修改文件与关键位置
- `desktop/main.js#L597-L635` & `desktop/preload.js#L18-L21`：新增 `gcw-browser:seek-video` 受控 IPC。
- `backend/services/topic_hub_service.py#L258-L480`：扩展 `list_topics_hub` 排序与日期筛选；新增 `get_topic_original_draft`、`save_topic_original_draft`、`get_content_metrics_detail`、`refresh_content_metrics`。
- `backend/routers/topic_hub.py#L28-L55` & `#L530-L580`：暴露新查询参数与草稿/指标路由。
- `frontend/src/api.ts#L468-L480`：新增 4 个 TopicHub V2 API 方法。
- `frontend/src/pages/TopicHub.tsx`：重构为 6 层固定工作区（由原 2035 行精简至 ~680 行，共用逻辑全部抽入 `components/workspace/`）。
- `frontend/src/App.tsx`：可折叠主导航、默认舒适 16px、取消独立「文案提取工坊」菜单入口、`overlayBlocked` 弹窗遮挡防护。
- `frontend/src/styles/design-tokens.css` 及全站 15 个 `.tsx` 文件：落地 `GCW-UI-02` 全局字号与语义类替换。

## 3. 数据库变化与新增依赖
- **数据库结构变化**：无新增表、无破坏性列修改（原创草稿复用既有 `app_settings` 表 `topic_original_draft_{topic_id}` 键，100% 兼容旧版源码回滚）。
- **新增第三方依赖**：无。

## 4. 已发现但暂保留事项
- `frontend/src/pages/TranscriptStudio.tsx` 菜单入口已取消，源码暂保留至用户最终验收确认后再物理删除。
