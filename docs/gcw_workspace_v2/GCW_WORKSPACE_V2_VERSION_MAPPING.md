# GCW-WORKSPACE-V2 · 版本对应与恢复点映射

| 版本标签 | 阶段 | 数据库热备文件 | 备注 |
|---|---|---|---|
| `v0.1.15-rc` | 修改前基线 | `data/backups/workbench_pre_workspace_v2_20261128.db`（`ok`） | 上一稳定候选基线 |
| `v0.2.0-rc` | GCW-WORKSPACE-V2 完成 | `data/backups/workbench_v0.2.0_rc_20261128.db`（`ok`） | TopicHub V2 + 全局字号整改候选版 |

- 远程审查分支：`review/gcw-uat-r4`（最终远程 Commit SHA 见本轮交付卡）。
- 回滚方式：运行根目录 `rollback_version.bat` 选择 `v0.1.15-rc`，默认仅回滚源码，不覆盖业务数据库与登录会话。
