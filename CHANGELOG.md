# Global Content Workbench · 变更日志 (CHANGELOG.md)

## [v0.2.2-rc] - 2026-11-28（GCW-WORKSPACE-V2-FIX-02）
- **FIX-01 / FIX-09（P0）**：`desktop/main.js` 新增 `set-active-view` 全局单一活动视图令牌（先同步隐藏再异步暂停），`App.tsx` 改用按需首次挂载 + `hidden` 页面保活，`EmbeddedVideoWorkspace` 增加 `lastNavigatedUrlRef` 防返回页面重复加载视频；10 次往返实测 `overlapCount = 0`。
- **FIX-03 / FIX-06（P0）**：修复二创正文 `content_markdown` 与模型 `configured/ready` 契约错配，空正文严禁标成功，历史版本展示字数/正文预览并标记异常空版本；UI 统一改名「二创文案」「生成二创文案」。
- **FIX-10（P0）**：后端 `save_topic_original_draft` 使用 `BEGIN IMMEDIATE` 严格拒绝 `client_rev <= existing_rev`；前端按 `topic_id` 维护 `localStorage` 本地待保存快照，成功前绝不清 `dirtyRef`。
- **FIX-02 / FIX-05 / FIX-07**：紧凑型横向视频数据条（宽屏实测 79px）；参考文案整句点击 `seekVideo` 并防选中复制误触；SearchHub 与弹窗统一改名「加入选题库」。
- **FIX-04 / FIX-08**：取消独立「内容拆解」主标签（四类信号移入抽屉），新增文案左侧「全文拆解」Skill 子标签与「高赞评论选题发现」工作区。

## [v0.2.1-rc] - 2026-11-28（GCW-WORKSPACE-V2-FIX-01）
- **FIX-01（P0）**：`OriginalCopyStudioPane.tsx` 与 `topic_hub_service.py` 引入单调递增 `client_rev` 修订号防旧请求覆盖；切选题/切标签页/最大化/卸载/关闭前强制 flush 未保存草稿；加载期锁定编辑区；加载失败明确报错并保护已有数据；保存失败提供重试按钮；生成期间继续编辑不覆盖最新草稿。
- **FIX-02（P0）**：`VideoMetricsBar.tsx` 与 `topic_hub_service.py` 刷新视频数据前执行前后端双重身份校验（`content_id`、`platform`、`platform_item_id`），拦截跨视频错写并修复 `cr.follower_count` 列名。
- **FIX-03（P1）**：`get_content_metrics_detail` 异常爆款倍数严格排除当前 `content_id`、去重、校验发布前历史时间、最低 3 条其他作品、标注人工收录样本代表性限制、无可靠基准显示「未知」。
- **FIX-04（P1）**：`ReferenceTranscriptPane.tsx`、`EmbeddedVideoWorkspace.tsx`、`VideoMetricsBar.tsx`、`TopicHub.tsx` 补齐切视频立即清旧字幕/旧数据与全部异步请求目标标识+版本号校验。
- **FIX-05（P1）**：`EmbeddedVideoWorkspace.tsx` 引入 `boundsOpSeqRef` + `overlayHiddenRef` 根治异步 `setBounds` 在弹窗打开后重新显示播放器的竞态。
- **FIX-06**：保留旧 `GCW_WORKSPACE_V2_TEST_RESULTS.json` 原始失败记录不篡改，新增 `GCW_WORKSPACE_V2_FIX_01_TEST_RESULTS.json` 如实记录修复前后差异与未授权付费模型 `NOT TESTED`。

## [v0.2.0-rc] - 2026-11-28（GCW-WORKSPACE-V2）
- **新增**：`frontend/src/components/workspace/` 下 4 个高内聚公共工作区组件（`EmbeddedVideoWorkspace.tsx`、`VideoMetricsBar.tsx`、`ReferenceTranscriptPane.tsx`、`OriginalCopyStudioPane.tsx`）。
- **新增**：Electron `gcw-browser:seek-video` 受控 IPC；后端 `GET/PUT /api/topic-hub/topics/{topic_id}/draft`、`GET /api/topic-hub/contents/{content_id}/metrics`、`POST /api/topic-hub/contents/{content_id}/refresh-metrics`。
- **变更**：`TopicHub.tsx` 重构为 6 层固定一体化工作区，支持视频/文案高度拖拽与参考/原创宽度拖拽；`list_topics_hub` 支持 4 种时间排序（默认最新创建优先）与日期范围筛选；`App.tsx` 支持主导航一键折叠/展开、默认舒适 16px 字号、取消旧独立「文案提取工坊」菜单入口。
- **变更**：`GCW-UI-02` 升级 `design-tokens.css` 并替换全站 15 个前端文件的硬编码 `text-[10px]`/`text-[11px]` 为可随 4 档字号动态缩放的语义字号类。

## [v0.1.15-rc] - 2026-11-28（GCW-STABLE-FIX-02）
- 修复 `desktop/main.js` 中 `const url` 重复赋值触发 `TypeError` 及 `catch` 吞异常回退为 `web` 的缺陷，拆出 `desktop/video_meta_extractor.js` 与 `desktop/test_video_meta_extractor.js`。

## [v0.1.14-rc] - 2026-11-28（GCW-STABLE-AUDIT-01）
- 修复 `VideoCaptureModal.tsx` 项目切换异步竞态，无损标记历史临时哈希记录，清理远程残留 `frontend/src/App.css`。
