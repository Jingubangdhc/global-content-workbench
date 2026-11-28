# GCW-WORKSPACE-V2-FIX-03-A · 高赞评论生成选题 500 故障根因诊断报告

## 1. 运行基线核对
- **本机分支与提交**：`feat/koubo-p2-chatcut-antigravity` / `d4308a3c757061fccd8b0a4672890e5364298f35`（`v0.2.2-rc`）
- **远程审查分支**：`origin/review/gcw-uat-r4` / `27b4cd3a7f467ad621e846cb75f83236cb959e78`
- **本阶段性质**：严格只读诊断（未修改任何业务源码与数据库，未调用未经授权的付费模型）。

---

## 2. 已复现直接根因（100% 实锤）

### 2.1 真实复现结果
- **请求 URL**：`POST http://127.0.0.1:8000/api/topic-hub/comments/discover-topics`
- **脱敏请求体**：`{"project_id": 1, "content_id": 39, "comment_ids": [129], "count": 1, "engine_id": "hunyuan_mt3_local", "model_id": "hy-mt3-1.8b"}`
- **HTTP 状态码**：`500 Internal Server Error`
- **真实后端 Traceback（脱敏）**：
```text
File "backend/routers/topic_hub.py", line 723, in api_discover_topics_from_comments
    import httpx
ModuleNotFoundError: No module named 'httpx'
```
- **连带同源隐患**：`backend/routers/topic_hub.py` 第 `618` 行 `api_run_breakdown_skill` 同样存在 `import httpx`，在执行全文拆解 Skill 时会触发完全相同的 `500 ModuleNotFoundError`。

---

## 3. ChatGPT 独立审查发现逐条核查（A01 – A08）

| 编号 | 审查项 | 核查结论 | 源码位置与实证 |
|---|---|---|---|
| **A01** | `topic_hub.py#L790` 未捕获的 `int()` 转换异常 | **源码确认缺陷** | `scid = int(item.get("source_comment_id") or ...)` 位于 `try/except` 之外，模型返回非纯数字字符串（如 `"#129"`）会直接抛 `ValueError` → 500。 |
| **A02** | `topic_hub.py#L790-L791` 非法评论 ID 被静默替换 | **源码确认缺陷** | `src_c = by_id.get(scid) or real_comments[0]` 在模型返回非法/越界 ID 时静默回退为 `real_comments[0]`，导致错误归因。应丢弃或报错而非伪造归属。 |
| **A03** | `production_package_service.py` 将 `configured` 等同于 `ready` | **源码确认缺陷** | L225–226 直接将 `ready` 设为 `bool(p.get("configured"))`，未区分本地服务是否真实在线与云端付费授权策略。 |
| **A04** | `CommentTopicDiscoveryPane.tsx` 缺少项目与作品切换异步隔离 | **源码确认缺陷** | `runDiscover` 与 `handleAddToLibrary` 无 `reqSeqRef` 与当前 `projectId/contentId` 校验，快速切换时旧响应会回写到新作品界面。 |
| **A05** | 创建选题只保存 `content` 证据，未保存 `comment` 结构化证据 | **源码确认缺陷** | `topic_evidence` 表原生支持 `evidence_type='comment'`，但 `create_manual_topic` 仅处理 `content_ids`，评论信息只拼进了 `discovery_reason` 字符串。 |
| **A06** | `comment_discovery` 与 `content_comment_discovery` 枚举不一致 | **源码确认缺陷** | 前端 L85 传 `origin_type: 'comment_discovery'`，后端 `ORIGIN_LABELS` 枚举为 `'content_comment_discovery'`，导致静默回退为 `'manual_original'`。 |
| **A07** | 上一轮测试只验证按钮存在，未验证真实业务成功 | **已确认** | `verify_fix02_e2e.js` 仅断言了「批量生成候选选题」按钮文本存在，未真实请求接口，导致 `ModuleNotFoundError` 逃逸。 |
| **A08** | 评论生成接口缺少项目与作品归属验证 | **源码确认缺陷** | `topic_hub.py#L733` 仅校验 `content_id` 存在，未校验该作品是否归属 `body.project_id`（或通过 `project_content_links` 关联）。 |

---

## 4. 区分三类结论
1. **已复现根因**：`backend/routers/topic_hub.py` L723（及 L618）`import httpx` 在本机 `.venv` 中触发 `ModuleNotFoundError: No module named 'httpx'` → HTTP 500。
2. **源码确认缺陷**：A01、A02、A03、A04、A05、A06、A07、A08 全部确认存在。
3. **待验证风险**：
   - 修复 `httpx` 替换为标准库 `urllib.request`（或复用现有 LLM HTTP 客户端）后，使用本地免费混元 `Hy-MT3-1.8B` 执行 JSON 结构化输出的遵循度需在修复阶段实测验证；
   - 付费云端模型（如 DeepSeek）受费用授权红线限制，本阶段未调用（标记 `BLOCKED`）。

---

## 5. 最小修复方案及影响范围（供下一轮 FIX-03-B 执行）
1. **`backend/routers/topic_hub.py`（L618 & L723 & L733 & L787-L805）**：
   - 移除 `import httpx`，统一改为项目已有标准库 `urllib.request`（零新增依赖）；
   - 补齐 `content_id` 与 `body.project_id` 归属校验（A08）；
   - 严格校验 `source_comment_id` 为所选 `by_id` 中的合法整数 ID，非法时跳过/报错，绝不静默替换成 `real_comments[0]`（A01/A02）；
   - 尊重免费/付费授权策略，未授权付费模型返回明确 403/400 提示。
2. **`backend/services/topic_hub_service.py`（`create_manual_topic`）**：
   - 支持可选 `comment_ids: list[int]` 参数，在 `topic_evidence` 表写入结构化 `evidence_type='comment'` 记录（A05）。
3. **`backend/services/production_package_service.py`（`list_available_writing_models`）**：
   - 区分 `configured` 与真实 `ready`（本地模型检查实时在线/按需就绪，云端模型标注是否受免费策略限制）（A03）。
4. **`frontend/src/components/workspace/CommentTopicDiscoveryPane.tsx`**：
   - `origin_type` 统一为 `'content_comment_discovery'`（A06），入库时透传 `comment_ids: [c.source_comment_id]`（A05）；
   - 为 `runDiscover` 与 `handleAddToLibrary` 增加 `reqSeqRef` 与 `projectId/contentId` 归属守卫（A04）。
