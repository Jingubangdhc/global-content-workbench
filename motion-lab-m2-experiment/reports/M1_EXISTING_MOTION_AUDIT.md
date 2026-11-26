# M1_EXISTING_MOTION_AUDIT.md — 现有动效资产逐项源码审查报告

## 1. 实存动效资产总量核实
- 本地 `engines/overlay-studio/motion-playground/src/effects/` 实存 **25 张独立可运行动效卡组件**（其中 **17 张** 出现在官方 `demo-overlay.json` 多轨示例中，另有 5 张 `hud/narrative/` 叙事图表卡与 3 张扩展卡）。
- **渲染引擎**：React 19 + DOM/SVG + CSS 变量（`--hud-scale`, `--hud-ink`, `--fx-outro`, `--project-glass-alpha`）。
- **时间轴同步机制**：预览期由 `App.tsx` 传入 `now`（映射为 `params.__t`）并配合 `useEnter` / `useCountUp`（`performance.now()` + `rAF`）和 `FxSpeedScope`（每帧修正 `el.getAnimations()` 的 `playbackRate`）；导出期由 `ExportView.tsx` 写入 `window.__fxExportMs` 并由 Puppeteer CDP 虚拟时间逐帧截透明 PNG。
- **透明视频导出机制**：`scripts/export-frames.mjs` → 无头 Chrome 截透明 PNG 序列 → `ffmpeg` 预乘 Alpha（`premultiply=inplace=1`）编码为 ProRes 4444 `.mov`（`yuva444p10le`/`yuva444p12le` + `pcm_s16le` 混音）与 VP9 `.webm`（`yuva420p`）。
- **EVA / OpenTake 资产核实**：经全目录只读检索，当前本机工程目录中**未发现 EVA 或 OpenTake 的本地源码或数据文件**，待您后续提供本地路径后再行专项核验。

---

## 2. 现有动效卡逐项技术拆解表（涵盖 17 张核心示例卡 + 8 张扩展卡，共 25 张）

| # | Card ID | 源码路径（行数） | 渲染载体 | 时间驱动方式 | 核心运动骨架（Motion） | 信息结构（Layout） | 视觉耦合点（Skin） | 音效控制 |
| :-: | :--- | :--- | :---: | :---: | :--- | :--- | :--- | :--- |
| 1 | `chapter-bar` | `hud/ChapterBar.tsx` (78) | DOM | `__t` 时间驱动 | 顶栏进度条线性推进 + 章节高亮切换 | 顶部通栏横排分段 | 进度色/透明度/底色硬编码 CSS | `whoosh-soft` |
| 2 | `pin-board` | `hud/PinBoard.tsx` (77) | DOM | `__t` + `times` | 逐条按时间点淡入落位 | 左侧固定标题+要点竖列 | 卡片玻璃/主题变量 | `pop-light` |
| 3 | `caption-track` | `hud/CaptionTrack.tsx` (165) | DOM | `__t` 时间驱动 | 按时间窗切换中英双语字幕 + 关键词高亮 | 底部居中双行字幕槽 | 字体/描边宽度/强调色 | 无 |
| 4 | `stat-proof` | `hud/StatProof.tsx` (654) | DOM | `__t` + `easeOutExpo` | 数值 `0 -> target` 指数减速滚动 + 卡片淡入上移 | 眉题 + 超大数字 + 中英注脚 | 暗/亮底、玻璃透明度、强调色 | `ding` |
| 5 | `ring-metric` | `hud/RingMetric.tsx` (453) | SVG+DOM | `__t` + 弧长插值 | SVG 圆环 `stroke-dashoffset` 扫画 + 中心数字递增 | 居中环形表盘 + 底部说明 | 刻度渐变色、发光、玻璃底 | `ding` |
| 6 | `odometer` | `hud/Odometer.tsx` (425) | SVG+DOM | `__t` + 位移滚动 | 机械里程表式逐位数字纵滚到位 | 眉题 + 多位滚轮盒 + 单位说明 | 机械槽框阴影、字体等宽 | `click` |
| 7 | `rank-bars` | `hud/RankBars.tsx` (461) | DOM | `__t` + 宽度生长 | 多条横柱错峰 `stagger` 横向伸展 + 数值递增 | 标题 + N 行（名次/名称/进度条/数值） | 冠军高亮色、圆角、条纹材质 | `pop-cluster` |
| 8 | `growth-curve` | `hud/GrowthCurve.tsx` (653) | SVG+DOM | `drawMs` 路径描绘 | SVG 折线 `stroke-dashoffset` 描绘 + 峰值点脉冲 | 眉题 + 折线坐标系 + 峰值标注 | 面积渐变填充、网格虚线、霓虹点 | `rise` |
| 9 | `versus-card` | `hud/VersusCard.tsx` (444) | SVG+DOM | `__t` + 左右对撞 | A/B 双卡从左右滑入对撞 + 中央 VS 徽章缩放弹出 | 双栏对称卡片 + 中央 VS 锚点 | 左/右主色、胜出高亮框 | `impact` |
| 10 | `quote-lockup` | `QuoteLockup.tsx` (428) | DOM | `__t` + 逐行浮现 | 引号落位 + 多行金句错峰上移淡入 + 署名浮现 | 装饰引号 + 多行大字 + 署名 | 衬线/无衬线字体、光晕、卡片底 | `chime` |
| 11 | `punch-pill` | `hud/PunchPill.tsx` (431) | SVG+DOM | `__t` + 弹性缩放 | 胶囊高光扫过 + 图标与短词弹出 | 单行胶囊图标 + 强短语 | 胶囊边框高光、色调 | `pop` |
| 12 | `step-timeline` | `hud/StepTimeline.tsx` (495) | DOM | `__t` + 步进点亮 | 垂直时间线连线伸长 + 节点按 `stepMs` 依次点亮 | 标题 + 竖向节点/步骤卡片 | 连线色、当前节点脉冲环 | `pop-cluster` |
| 13 | `checklist` | `hud/Checklist.tsx` (428) | SVG+DOM | `__t` + 勾选描边 | 条目错峰入场 + SVG 对勾路径按序绘制打 ✓ | 标题 + 多行复选列表 | 勾选框色彩、完成态划暗 | `click` |
| 14 | `term-card` | `hud/TermCard.tsx` (450) | SVG+DOM | `__t` + 展开揭示 | 英文词根与中文术语分离进场 + 释义正文展开 | 顶部词条徽章 + 分隔线 + 释义区 | 词典风细边框、玻璃模糊 | `pop-light` |
| 15 | `ui-callout` | `hud/UICallout.tsx` (453) | SVG+DOM | `__t` + 引导线绘制 | 目标聚焦框缩放 + 折线引导线描边 + 标注文字浮现 | 锚点框 + 折线 + 悬浮说明牌 | 描边强调色、呼吸脉冲 | `shutter` |
| 16 | `blur-text` | `hud/BlurText.tsx` (454) | DOM | `__t` + 模糊度插值 | 词块按 `staggerMs` 从 `blur(16px)` 聚焦清晰并微移 | 居中多行词块 + `*关键词*` 高亮 | 关键词强调色、文字光晕 | `hit-soft` |
| 17 | `type-shift` | `hud/TypeShift.tsx` (532) | SVG+DOM | `__t` + 翻转切换 | 旧句划掉/翻走，新句以高动能切换就位 | 草稿标签 + 对比切换大字 | 划除线色、反转底色 | `glitch` |
| 18 | `entity-chips` | `hud/EntityChips.tsx` (504) | SVG+DOM | `__t` + 聚散弹出 | 多标签按 `stepMs` 环绕/队列飞入锚定 | 实体标签组 + 对比/备注条 | 徽章圆角、半透明材质 | `pop-cluster` |
| 19 | `focus-card` | `hud/FocusCard.tsx` (400) | SVG+DOM | `__t` + 镜头缩放 | 参考口播视频缩放裁切让位 + 旁侧要点列表入场 | 侧栏要点区 + 局部口播画中画框 | 背景深浅、聚焦环边框 | `whoosh` |
| 20 | `terminal-3d` | `hud/Terminal3D.tsx` (548) | DOM | `__t` + 字符打字机 | 3D 透视终端窗口倾斜进场 + 代码按 `cps` 逐字打出 |  macOS 顶栏 + 等宽代码区 | 终端语法高亮、3D 阴影 | `type` |
| 21–25 | `growth-bars` / `donut-split` / `waterfall-bridge` / `radar-profile` / `waffle-fill` | `hud/narrative/*.tsx` (170–248) | SVG+DOM | 事件触发 + `times` | 柱状对比生长 / 环形扇区展开 / 瀑布阶梯累积 / 雷达多边形扩张 / 百格矩阵顺序填充 | 统一 `kickerEn/Zh + title + SVG 图表区 + 标注` | 叙事图表专用调色板与卡片容器 | `rise` / `pop` |

---

## 3. 四维解耦切分结论（M2 架构依据）
1. **Motion（运动骨架）**：所有 25 张卡底层其实可归约为少量高复用运动原语——**数值指数递增**（`stat-proof/odometer/ring-metric`）、**多行错峰生长**（`rank-bars/checklist/step-timeline/pin-board`）、**聚焦与逐块浮现**（`blur-text/quote-lockup/term-card/punch-pill`）、**双栏对撞对比**（`versus-card/growth-bars`）、**路径描边描绘**（`growth-curve/ui-callout/donut-split`）。
2. **Layout（信息结构）**：纯结构抽象（眉题槽、主指标/标题槽、数据行槽、注脚槽、对比双栏槽），与字体/颜色无关。
3. **Skin（视觉皮肤）**：完全由 Design Tokens 驱动（背景、表面材质、边框、圆角、字体栈、字重、主/辅/强调色、阴影、颗粒/网格/玻璃滤镜），可从 Atlas 504 项视觉词典动态映射。
4. **Content（内容参数）**：纯 JSON 业务数据（真实文案、真实数字、数据出处），与动画算法彻底分离。
