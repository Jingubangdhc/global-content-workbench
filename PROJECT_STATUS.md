# Global Content Workbench · 项目当前状态 (PROJECT_STATUS.md)

- **当前本机候选版本**：`v0.2.4-rc`（`GCW-WORKSPACE-V2-FIX-03-C`：结构化证据入库强校验 + 异步入库双序列号隔离 + 模型真实连接态 + 全文拆解安全 Markdown 渲染与收尾）
- **开发分支**：`feat/koubo-p2-chatcut-antigravity`
- **GitHub 独立审查分支**：`review/gcw-uat-r4`（不触碰 `main`，待 ChatGPT 独立审查与用户最终验收）
- **当前状态**：等待独立审查与最终验收（未标记正式稳定版，未打包 EXE）

## 核心模块状态

| 模块 | 状态 | 说明 |
|---|---|---|
| SearchHub（全网选题研究） | 已验收 | 独立 `researchView`，共享 `persist:gcw_research` 会话，4 步极简一键收录（含 `video_meta_extractor.js` 零 `const url` 异常修复） |
| TopicHub V2（选题资产中心） | 本轮升级完成 | 6 层一体化固定工作区：固定内嵌 `topicPlayerView`、实时双语字幕、当前视频真实数据面板、参考文案时间轴联动（`seekVideo`）、原创文案与 Skill 工作区、选题时间管理 |
| 全局字体与可读性（GCW-UI-02） | 本轮升级完成 | 默认舒适 16px，4 档字号（14/15/16/18px）覆盖全站 15 个前端组件，1920×1080 与 2560×1440 零横向溢出 |
| 本地混元翻译模型（Hy-MT3-1.8B） | 正常运行 | `llama.cpp b12823 CUDA 12.4` + `Hy-MT3-1.8B-Q4_K_M.gguf`（权重与运行库按规范排除在 Git 外） |
| 双语字幕时间轴同步（R4-G） | 正常运行 | 100ms 真实 `currentTime` 只读同步 + 广告态隔离，54 点实测均值 88ms |
