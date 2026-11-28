# GCW-WORKSPACE-V2-FIX-03-C · 代码变更与验收报告

- **目标候选版本**：`v0.2.4-rc`（基线：`v0.2.3-rc`）
- **日期**：2026-11-28

## 1. 残留缺陷收尾对照

| 编号 | 缺陷摘要 | 修复方案与源码位置 |
|---|---|---|
| **FIX-C01（P0）** | 结构化证据入库校验与原子回滚 | `backend/services/topic_hub_service.py` 新增统一 `validate_topic_evidence_scope` 与 `_content_belongs_to_project`，校验项目存在、作品归属（兼容共享关联）、评论存在且属于指定作品；`create_manual_topic` 拒绝任何无效证据并回滚整个事务；`backend/routers/topic_hub.py` 的 `api_topic_hub_create` 与 `api_discover_topics_from_comments` 复用同一校验逻辑 |
| **FIX-C02（P0）** | 候选选题异步入库隔离 | `frontend/src/components/workspace/CommentTopicDiscoveryPane.tsx` 为每个候选选题分配稳定唯一 `candidate_uid`；拆分生成（`genSeqRef`）与入库（`addSeqRef`）双序列号及 `activeScopeRef` 守卫，防止重新生成、A→B→A 切换及旧 `finally` 串用；后端拒绝混合有效/无效评论 ID 请求（400） |
| **FIX-C03（P1）** | 模型状态与调用权限 | `backend/services/production_package_service.py` 修复 `last_test_ok` 读取层级，区分 `connected` / `untested` / `failed` / `unconfigured`，严禁 `configured` 直接等同 `connected`；`backend/routers/topic_hub.py` 的 `_check_billing_policy_for_engine` 依据 provider 真实 `billing_category` 判断免费与付费，不硬编码只有混元免费 |
| **FIX-C04（P1）** | 全文拆解功能收尾 | `frontend/src/components/workspace/FullTextBreakdownPane.tsx` 保留三层 UI，新增零原始 HTML 执行的 `SafeMarkdownView`（标题/表格/列表/引用/粗体）；支持用户导入 Skill 时指定 `skill_purpose`（`breakdown`/`general`/`rewrite`）；`production_package_service.py` 取消 12000 字符静默截断；修复加载 Skill/模型/历史报告吞异常问题；配置区增加 `max-h-[60%] overflow-y-auto` |
| **FIX-C05** | 真实验收证据 | 独立脚本 `docs/gcw_workspace_v2_fix_03_c/verify_fix03c_e2e.js` 与脱敏结果 `GCW_FIX_03_C_TEST_RESULTS.json` 全绿通过 |

## 2. 修改文件清单

- `backend/services/topic_hub_service.py`
- `backend/services/production_package_service.py`
- `backend/routers/topic_hub.py`
- `frontend/src/components/workspace/CommentTopicDiscoveryPane.tsx`
- `frontend/src/components/workspace/FullTextBreakdownPane.tsx`
- `docs/gcw_workspace_v2_fix_03_c/verify_fix03c_e2e.js`
- `docs/gcw_workspace_v2_fix_03_c/GCW_FIX_03_C_TEST_RESULTS.json`
- `docs/gcw_workspace_v2_fix_03_c/GCW_FIX_03_C_CODE_CHANGE_REPORT.md`
