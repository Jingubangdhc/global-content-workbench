# GCW-WORKSPACE-V2-FIX-02 · 代码变更报告

## 1. 新增文件
- `frontend/src/components/workspace/FullTextBreakdownPane.tsx`（FIX-04 全文拆解 Skill 工作区）
- `frontend/src/components/workspace/CommentTopicDiscoveryPane.tsx`（FIX-08 高赞评论选题发现）
- `docs/gcw_workspace_v2_fix_02/`（验收报告、代码变更报告、测试结果 JSON、真机脚本与证据）

## 2. 修改文件与关键位置
- `desktop/main.js#L362-L440` & `desktop/preload.js#L30-L35`：新增 `gcw-browser:set-active-view` 全局单一活动视图令牌（先同步瞬间隐藏非活动视图，再异步暂停媒体，拦截非活动视图的 `setVisible(true)`）。
- `backend/services/topic_hub_service.py#L364-L415`：`save_topic_original_draft` 使用 `BEGIN IMMEDIATE` 原子事务，严格拒绝 `client_rev <= existing_rev`。
- `backend/services/production_package_service.py#L221-L248`：`list_available_writing_models` 同时输出 `configured/ready` 与 `name/label`。
- `backend/routers/topic_hub.py#L585-L802`：新增 `GET/POST /contents/{id}/breakdown-reports|breakdown-run` 与 `POST /comments/discover-topics`。
- `frontend/src/App.tsx`：按需首次挂载 `mountedPages` + `hidden` 保活 + 统一 `setActiveView` 显隐控制 + `topicRefreshToken` 定向刷新。
- `frontend/src/pages/SearchHub.tsx` & `VideoCaptureModal.tsx`：接入 `isActive` 保活控制并统一改名「加入选题库」。
- `frontend/src/components/workspace/EmbeddedVideoWorkspace.tsx`：接入 `isActive`、`lastNavigatedUrlRef` 防返回页面重复 `navigate`、后台停轮询。
- `frontend/src/components/workspace/VideoMetricsBar.tsx`：重构为 79px 紧凑型横向数据条。
- `frontend/src/components/workspace/ReferenceTranscriptPane.tsx`：整句原文/译文点击 `seekVideo` + 选中文本/编辑态防误触。
- `frontend/src/components/workspace/OriginalCopyStudioPane.tsx`：统一 `content_markdown` 正文与 `configured` 模型契约、历史异常空版本标记、统一改名「二创文案」、`localStorage` 持久化待保存快照与成功前不清 `dirtyRef`。
- `frontend/src/pages/TopicHub.tsx`：取消独立「内容拆解」主标签（四类信号移入抽屉）、文案左侧双子标签、接入 `CommentTopicDiscoveryPane`。

## 3. 数据库与依赖变化
- 数据库结构：无表结构变更（全文拆解报告复用 `app_settings` 表 `content_breakdown_reports_{content_id}`，100% 兼容旧版回滚）。
- 新增依赖：无。
