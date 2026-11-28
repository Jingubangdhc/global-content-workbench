# Global Content Workbench · 变更日志 (CHANGELOG.md)

## [v0.2.0-rc] - 2026-11-28（GCW-WORKSPACE-V2）
- **新增**：`frontend/src/components/workspace/` 下 4 个高内聚公共工作区组件（`EmbeddedVideoWorkspace.tsx`、`VideoMetricsBar.tsx`、`ReferenceTranscriptPane.tsx`、`OriginalCopyStudioPane.tsx`）。
- **新增**：Electron `gcw-browser:seek-video` 受控 IPC；后端 `GET/PUT /api/topic-hub/topics/{topic_id}/draft`、`GET /api/topic-hub/contents/{content_id}/metrics`、`POST /api/topic-hub/contents/{content_id}/refresh-metrics`。
- **变更**：`TopicHub.tsx` 重构为 6 层固定一体化工作区，支持视频/文案高度拖拽与参考/原创宽度拖拽；`list_topics_hub` 支持 4 种时间排序（默认最新创建优先）与日期范围筛选；`App.tsx` 支持主导航一键折叠/展开、默认舒适 16px 字号、取消旧独立「文案提取工坊」菜单入口。
- **变更**：`GCW-UI-02` 升级 `design-tokens.css` 并替换全站 15 个前端文件的硬编码 `text-[10px]`/`text-[11px]` 为可随 4 档字号动态缩放的语义字号类。

## [v0.1.15-rc] - 2026-11-28（GCW-STABLE-FIX-02）
- 修复 `desktop/main.js` 中 `const url` 重复赋值触发 `TypeError` 及 `catch` 吞异常回退为 `web` 的缺陷，拆出 `desktop/video_meta_extractor.js` 与 `desktop/test_video_meta_extractor.js`。

## [v0.1.14-rc] - 2026-11-28（GCW-STABLE-AUDIT-01）
- 修复 `VideoCaptureModal.tsx` 项目切换异步竞态，无损标记历史临时哈希记录，清理远程残留 `frontend/src/App.css`。
