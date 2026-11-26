# M1_ATLAS_REUSE_REPORT.md — 现有视觉图鉴与底层数据库复用方案

> **合规与复用原则**：严格零重新爬取、零覆盖原文件 `atlas-p1b-experiment/Visual_Style_Atlas_CN.html`；直接复用 `atlas-p1b-experiment/` 中已清洗完毕的底层结构化 JSON 资产。

---

## 1. 现有离线资产清点（只读实测）

| 文件路径 | 规模 | 精确结构（已实测字段） | 在 AI Motion & Style Lab 中的复用价值 |
| :--- | :---: | :--- | :--- |
| `atlas-p1b-experiment/Visual_Style_Atlas_CN.html` | 26.19 MB | 离线全量中文单页视觉图鉴（内嵌交互与预览） | 作为独立视觉参考画册，在 Lab 内提供只读参考入口，**不重写图鉴** |
| `atlas-p1b-experiment/atlas_catalog_cn.json` | **504 项** | `source`, `source_id`, `original`, `translation`, `suggestions`, `media`, `capabilities` | **视觉皮肤（Skin）核心语料库**：按风格/年代/材质/媒介快速检索生成 Design Tokens |
| `atlas-p1b-experiment/atlas_prompt_library.json` | **504 项** | `source`, `source_id`, `mode`, `routes`, `generation_mode`, `official`, `official_zh`, `generation_zh`, `generation_en`, `recipe` | **AI 风格混搭与变体生成引擎的直接 Prompt 配方库**（含中英双语 `recipe`） |
| `atlas-p1b-experiment/atlas_taxonomy.json` | **12 大类** | `categories(12)`, `identity(2)`, `media_types(4)`, `motion_fields(6)`, `capabilities(4)` | 为长期 28 组动效分类与风格 DNA 标签体系提供权威分类轴 |
| `atlas-p1b-experiment/r2_motion_catalog.json` | **264 项**（11 包） | `version`, `site`, `repo`, `count(264)`, `packs(11)`, `elements(264)` | **Motion Prompt 镜头与动效参考库**：直接映射到 M2 运动骨架的缓动、运镜、转场语汇 |

---

## 2. 推荐 AI 可调用的只读数据接口设计（下一阶段封装，M2 先直接静态复用）

无需重新爬虫或建第二套图鉴，仅需在 Lab 后端暴露 4 个轻量只读查询接口即可让 AI 与皮肤生成器直接调用上述 768 条资产（504 Atlas + 264 Motion）：
1. `GET /api/lab/atlas/search?q=&category=&media_type=&limit=20`：检索 `atlas_catalog_cn.json`（504 项），返回风格中英文名、视觉特征与 `source_id`。
2. `GET /api/lab/atlas/recipe/{source_id}`：从 `atlas_prompt_library.json` 读取该风格的 `official_zh`、`generation_en` 与结构化 `recipe`，作为 AI 生成 Skin JSON（`M2_SKIN_SCHEMA`）的权威依据。
3. `GET /api/lab/motion-prompts?pack=&q=`：检索 `r2_motion_catalog.json`（264 项），辅助 AI 为用户上传的参考动效匹配运动骨架与时间曲线参数。
4. `GET /api/lab/taxonomy`：返回 `atlas_taxonomy.json` 的 12 大视觉分类与 6 大运动维度，支撑个人 Style DNA 标签权重统计。

## 3. 本次 M2 实验的直接复用落地
在 M2 白模实验中，我们已直接从 Atlas 风格体系中抽取并映射出 **3 套可执行视觉皮肤 + 1 套灰色白模皮肤**（每套皮肤在 `M2_SKIN_SCHEMA.json` 中显式标注 `atlas_refs` 溯源 ID），验证「**Atlas 视觉词典 → 标准化 Skin Tokens → 驱动任意运动骨架实时渲染**」的完整技术通路。
