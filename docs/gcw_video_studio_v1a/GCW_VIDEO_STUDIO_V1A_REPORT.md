# GCW-VIDEO-STUDIO-V1.0-A · 恢复并集成原版 Overlay Studio 交付报告

- **候选版本**：`v0.2.5-rc`（基线：`v0.2.4-rc`）
- **日期**：2026-11-28
- **Overlay Studio 原始仓库**：`https://github.com/jeszhou/overlay-studio`
- **Overlay Studio 原始 Commit SHA**：`8ce89d410af6ce648e1658eadf57fec15a612d62`
- **原始许可证与版权声明**：完整保留 `engines/overlay-studio/LICENSE` 与 `LICENSE-EN`

## 1. 启动故障根因分析

1. `engines/overlay-studio/motion-playground` 本地源码与上游 `8ce89d410af6ce648e1658eadf57fec15a612d62` 完全一致，Node `v24.15.0` 满足 `>=22.12.0` 要求，且依赖 `node_modules` 完备。
2. GCW 的 `frontend/vite.config.ts`（`/overlay-engine` 反向代理）与 `backend/services/overlay_adapter.py` 均指向 `http://127.0.0.1:5177/overlay-engine/`。
3. **直接根因**：`desktop/main.js` 中此前完全缺少启动、健康检查与关闭 Overlay Studio（5177 端口）的托管逻辑，导致 GCW 启动时 5177 端口无人监听，编辑器直接连接拒绝；且原版 `vite.config.ts` 默认配置 `open: true`，需通过 `--open false` 与 `BROWSER=none` 避免拉起外部系统浏览器。

## 2. 原始源码与修改源码差异

- **`engines/overlay-studio/`**：**0 文件修改（ZERO_DIFF）**，100% 保留原版 Canvas/舞台、Timeline、Effect Registry、ParamsPanel、25 张动效卡与许可证。
- **GCW 新增/修改文件清单**：
  1. 新增 `desktop/overlay_service.js`：独立本地托管服务管理器（`node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5177 --strictPort --base /overlay-engine/ --open false`），含单例防重复启动锁、既有健康实例复用、12s 健康检查、端口冲突（`strictPort`）显式报错、Windows `taskkill /T /F` 进程树零残留清理。
  2. 修改 `desktop/main.js`：引入 `overlay_service`，注册 `gcw-overlay:status` / `gcw-overlay:start` / `gcw-overlay:stop` 受控 IPC；在 `app.whenReady()` 自动启动，在 `before-quit` 与 `window-all-closed` 同步清理进程树。
  3. 修改 `desktop/preload.js`：向本地工作台暴露 `window.gcwOverlayStudio`（`getStatus / start / stop`）。
  4. 修改 `frontend/src/pages/VideoStudio.tsx`：引擎未就绪占位页支持一键调用 `window.gcwOverlayStudio.start()` 拉起并展示真实错误。

## 3. 数据库与工程备份及恢复验证记录

- 修改前数据库热备：`data/backups/workbench_pre_video_studio_v1a_20261128.db`（`2,330,624` 字节，隔离目录 `PRAGMA integrity_check = ok`）。
- 修改前视频工程目录备份：`data/backups/video_studio_pre_v1a_20261128/`。
- 当前版本数据库热备：`data/backups/workbench_v0.2.5_rc_20261128.db`（隔离目录 `PRAGMA integrity_check = ok`）。

## 4. 完整回滚说明

如需回滚至上一恢复点 `v0.2.4-rc`：
1. 源码回滚：`git checkout v0.2.4-rc`（或运行项目根目录 `rollback_version.bat` 选择 `v0.2.4-rc`）；
2. 数据库回滚：停止 8000 后端后将 `data/backups/workbench_pre_video_studio_v1a_20261128.db` 覆盖还原至 `data/workbench.db`；
3. 视频工程回滚：如需还原工程目录，从 `data/backups/video_studio_pre_v1a_20261128/` 恢复至 `data/video_studio/`。
