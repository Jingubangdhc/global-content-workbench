# M0_EDITOR_FIDELITY_REPORT.md — 原版编辑台功能保真复核报告

## 1. 复核结论
- **结论：PASS（无阻塞问题，已具备开展独立 M2 白模化技术验证的前提；正式工程继续保持只读隔离）**。
- 此前 `OVERLAY-FIDELITY-AUDIT-01` 发现的集成版手写外壳退化问题，已通过 **方案 B（commit `ecba219`，分支 `feat/gcw-phase2-g2`）** 完整解决：移除 1,300+ 行手写仿制壳，改为全屏同源运行原版 `Overlay Studio v1.4.0` 完整编辑器（`http://127.0.0.1:5177/overlay-engine/`），并在 `frontend/vite.config.ts` 补齐 `/demo`、`/sfx`、`/_media`、`/api/export-status` 等 7 条精准代理路由。

## 2. 核心保真项复核证据

| 检查项 | 当前状态 | 实测证据 |
| :--- | :---: | :--- |
| 播放头任意拖动与连续擦洗 | **已解决 (PASS)** | 原版 `TimelineBar.tsx` `.tlb-inner` 挂 `onPointerDown={startScrub}`，实测点击与连续擦洗画布 60fps 实时刷新 |
| 重叠动效自动多行分轨 | **已解决 (PASS)** | 原版 `assignLanes()` 自动分多条独立泳道（`top: 0/22/44px`），零单行硬叠遮挡 |
| 动效块整体平移 + 边缘调时长 + 10px 磁吸 | **已解决 (PASS)** | `EDGE_PX=8` 边缘热区与 10px 磁吸全部恢复，实测时长 `5.0s -> 3.1s`、平移 `0.0s -> 0.9s` |
| 时间轴顶边高度调整 | **已解决 (PASS)** | 拖拽 `.tlb-resize` 高度 `228px -> 294px` 顺滑可调并持久化 |
| 画布直接拖拽与无白光/无双字幕 | **已解决 (PASS)** | 原版 `CardShell` 直接拖拽同步 `水平/垂直微调`，零白光闪烁，宿主黑底双字幕已移除 |
| 音视频同步与音效试听 | **已解决 (PASS)** | 参考视频 `video.currentTime` 与 `App.tsx` `rAF` 强绑定；`/sfx/pop.mp3` HTTP 200 即时试听；导出自动混音 |
| 原版示例载入与服务心跳 | **已解决 (PASS)** | `/demo/demo-overlay.json`、`/demo/demo.srt`、`/api/export-status`、`/api/overlay-status` 全部 HTTP 200 |

## 3. 架构级发现（直接指导 M2 研发）
虽然原版编辑台交互已 100% 保真恢复，但 M1 源码深挖发现原版 25 张动效卡底层仍存在**两个无法直接支撑 501 卡工业化量产的根本局限**：
1. **动画非纯函数时间驱动**：多数卡片预览态依赖 `useCountUp` + `performance.now()` + CSS 过渡（事件触发型），导致**反向拖动播放头时动画无法精确倒放**，仅在导出态通过 `window.__fxExportMs` 强行对齐；
2. **运动、结构与视觉皮肤强耦合**：每张 `.tsx` 动效卡 400–650 行，把布局几何、运动缓动、Tailwind/CSS 配色材质与文案字段写死在同一个文件里，无法单独换皮肤或复用骨架。

因此，M2 独立白模实验将从底层采用 **100% 确定性纯函数时间驱动引擎 `frame = render(t, duration, Content, Layout, Skeleton, Skin, StyleDNA)`**，彻底攻克上述局限。
