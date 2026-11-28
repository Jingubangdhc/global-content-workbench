# GCW-WORKSPACE-V2-FIX-03-B · 代码变更与验收报告

- **目标候选版本**：`v0.2.3-rc`（基线：`v0.2.2-rc`）
- **日期**：2026-11-28
- **前置诊断依据**：`docs/gcw_workspace_v2_fix_03/GCW_FIX_03_ROOT_CAUSE_REPORT.md` 与 `GCW_FIX_03_REPRODUCTION.json`

## 1. 核心根因与修复前后对照

| 编号 | 缺陷来源 | 修复前问题 | 修复后方案与源码位置 |
|---|---|---|---|
| **R00** | FIX-03-A 真实复现 | `backend/routers/topic_hub.py` L723/L618 `import httpx`，本机 `.venv` 未安装 `httpx`，直接抛出 `ModuleNotFoundError` → HTTP 500 | `backend/routers/topic_hub.py` L595-653：彻底移除 `httpx` 依赖，封装标准库 `urllib.request` 调用 `_call_openai_compat_chat`，按 401/402/429/504/URLError/JSON 异常分类返回清晰中文业务错误，绝不抛未捕获 500 |
| **A01** | 独立审查 | `hunyuan_mt3_local` 被当作通用文案生成模型暴露 | `backend/services/production_package_service.py` L215-259：区分 `configured`/`connected`/`text_generation_capable`/`is_translation_only`；`backend/routers/topic_hub.py` L779 明确 400 拒绝专用翻译模型 |
| **A02/A03** | 独立审查 | `source_comment_id` 强转 `int` 崩溃；缺失/非法 ID 被静默替换为 `real_comments[0]` | `backend/routers/topic_hub.py` L871-885：安全解析整数并严格校验 `scid in by_id`，非法项直接丢弃，若无有效映射明确返回 422 |
| **A04** | 独立审查 | 未校验 `content_id` 与 `body.project_id` 真实归属关系 | `backend/routers/topic_hub.py` L762-776：兼容校验 `contents.project_id` / `project_content_links` / `topic_evidence` 多选题关联，跨项目越权返回 403 |
| **A05/A06** | 独立审查 | `CommentTopicDiscoveryPane.tsx` 入库传非法 `origin_type: 'comment_discovery'` 且未落库 `comment` 证据；切作品无异步隔离 | `frontend/src/components/workspace/CommentTopicDiscoveryPane.tsx` 改为 `'content_comment_discovery'` 并透传 `comment_ids` + `reqSeqRef`/`activeScopeRef` 隔离；`backend/services/topic_hub_service.py` L686-715 单事务原子写入 `topics` + `content` + `comment` 证据 |
| **A07** | 独立审查 | 全文拆解 >18000 字静默截断，历史报告非原子写入 | `backend/routers/topic_hub.py` L715-755：超限返回 400 明确提示禁止静默截断，历史报告使用 `BEGIN IMMEDIATE` 原子保存 |
| **A08** | 费用红线 | 未校验 `free_only` 费用授权策略 | `backend/routers/topic_hub.py` L655-666：新增 `_check_billing_policy_for_engine`，`free_only` 模式下拦截付费云端模型返回 403 |
| **UI-01** | 用户反馈 | 全文拆解 UI 仍为旧版拥挤布局 | `frontend/src/components/workspace/FullTextBreakdownPane.tsx` 彻底重做为三层布局（标题+历史按需展开 → 5 行独立纵向配置区 → 独立报告阅读区，生成后自动折叠配置区，四档字号零横向溢出）；`frontend/src/pages/TopicHub.tsx` 透传 `subData` 与 `onSwitchToReference` |

## 2. 修改文件清单

- `backend/routers/topic_hub.py`
- `backend/services/production_package_service.py`
- `backend/services/topic_hub_service.py`
- `frontend/src/components/workspace/FullTextBreakdownPane.tsx`
- `frontend/src/components/workspace/CommentTopicDiscoveryPane.tsx`
- `frontend/src/pages/TopicHub.tsx`
- `docs/gcw_workspace_v2_fix_03/GCW_FIX_03_B_TEST_RESULTS.json`
- `docs/gcw_workspace_v2_fix_03/GCW_FIX_03_B_CODE_CHANGE_REPORT.md`

## 3. 验收测试结果

- TypeScript 类型检查：`npx tsc --noEmit` 通过（`TSC_FIX03B_OK`）。
- 后端与 SQLite 真实测试：专用翻译模型 400 拒绝、跨项目越权 403 拒绝、`urllib.request` 调用真实返回 200、结构化 `content` + `comment` 证据原子落库全部 `PASS`。
- 新版全文拆解三层 UI 真实 Electron 渲染与四档字号（紧凑/标准/舒适/大字）横向溢出检查全部 `PASS`（截图留存本地 `docs/gcw_workspace_v2_fix_03/screenshots/after_fulltext_breakdown_v2.png`，按规范不上传远程）。
- **BLOCKED 项**：用户尚未提供正式拆解 Skill，全文拆解真实报告生成标记 `BLOCKED`。
