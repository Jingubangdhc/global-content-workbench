# Global Content Workbench · 永久开发与版本保护规范 (AGENTS.md)

本文件为所有后续参与本项目的开发 Agent 及工程师必须严格遵守的永久工程规范。

---

## 1. 永久版本保护前置流程（修改前必做）

每次修改 **UI、核心业务逻辑、数据库结构、API、模型配置或 Skills** 之前，必须按顺序完成以下全部步骤，严禁跳过：

1. **检查当前 Git 状态及未提交修改**：运行 `git status`，明确当前工作区与暂存区状态；
2. **保存当前完整可用源码状态**：严禁使用破坏性命令（如 `git reset --hard`、`git checkout -- .`、`git clean -fd`）覆盖未保护的用户修改；
3. **建立本地 Git 恢复点及版本标签**：创建带完整说明的本地提交与 annotated tag（如 `v0.1.0`、`v0.2.0`），并更新 `docs/versions/VERSION_REGISTRY.md`；
4. **记录当前版本号、时间及功能状态**：清晰标注当前基线包含的能力边界与已知状态；
5. **保存当前关键 UI 截图**：将变更前的关键页面（如 SearchHub、TopicHub）完整窗口截图归档至 `docs/versions/<version>/screenshots/`；
6. **对 SQLite 执行一致性备份**：使用 Python `sqlite3.Connection.backup()` 对 `data/workbench.db` 执行热备份（禁止直接复制正在写入的 `.db` 文件）；
7. **验证备份完整性及恢复能力**：将热备份复制到独立临时路径执行 `PRAGMA integrity_check`（必须返回 `ok`）并抽样核对核心表行数。

---

## 2. 安全与仓库边界红线

- **严禁擅自推送 GitHub**：允许创建必要的本地 Git 提交与本地版本标签；未经用户明确授权，绝不执行 `git push`。
- **严禁提交敏感信息**：API 密钥（`.env`）、OAuth 凭据、登录 Cookie、本地加密保险箱（`data/credential_vault.json`）、业务数据库（`data/workbench.db`）一律排除在 Git 之外。
- **严禁重复复制大体积可重建目录**：不得备份或提交 `node_modules/`、`.venv/`、构建缓存、临时音视频与日志目录。

---

## 3. 本地一键查看与安全回滚规则

项目根目录提供 Windows 直接可用的本地版本工具：
- `list_versions.bat`：列出全部本地可恢复版本标签、提交时间与版本说明；
- `rollback_version.bat`：选择目标版本执行安全回滚。

回滚脚本必须始终遵循以下铁律：
1. 执行前展示目标版本与当前版本的修改范围（`git diff --stat`）；
2. **自动保存当前状态**（创建带时间戳的 `backup/pre-rollback-<ts>` 本地保护分支与提交），防止二次损失；
3. 停止受影响的本地运行服务（FastAPI 8000 / Vite 5173 / Electron）；
4. **默认仅恢复源码，绝不覆盖用户业务数据库（`data/workbench.db`）与本地保险箱**；如检测到 `backend/db.py` 结构存在不兼容变更，必须给出明确的数据库单独恢复指引，经用户确认后方可操作；
5. 检查前后端及桌面端依赖完整性，重新拉起工作台并执行健康检查，全程保留日志于 `logs/rollback/`。

---

## 4. UI 与数据展示红线

- 统一使用 `frontend/src/styles/design-tokens.css` 中的 Design Tokens，禁止在各页面复制多套冲突主题；
- 旧版本通过 Git 恢复点管理，禁止在正式源码中复制保留两套重复页面实现；
- 仅展示真实可用数据字段，缺失字段统一显示 `—`，严禁虚构业务数据填充界面；
- Electron 内置浏览器加载的第三方外部网页保持原始显示，严禁强行注入深色样式或绕过登录/验证码限制。
