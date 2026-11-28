# GCW-UAT-R4 & GCW-R4-C-FINAL｜全批次连续开发与本地混元模型统一验收报告

> **版本状态**：全部批次（R4-A 收尾至 R4-E 及 R4-C-FINAL）均已按顺序独立开发、独立真实自测并建立独立本地候选版本恢复点（`v0.1.5-rc` ~ `v0.1.10-rc`），**均未标记为正式稳定版本，均未推送远程 GitHub**。现已停止开发，等待 ChatGPT 独立审查及用户统一验收。

---

## 一、全批次独立版本恢复点清单（支持任意批次单独回滚）

| 批次 | 本地候选标签 | 核心整改范围 | SQLite 一致性热备（`PRAGMA integrity_check`） | 自动化/真机实测结果 |
|---|---|---|---|---|
| **基线** | `v0.1.4-rc` | GCW-TRANS-01 翻译引擎配置与真实双语字幕基线 | `data/backups/workbench_v0.1.4_rc_20261128.db`（`ok`） | 已冻结 |
| **R4-A 收尾** | `v0.1.5-rc` | FIX-A01~A09：双独立 `WebContentsView`、共享 `persist:gcw_research` 会话、Electron 35 四道外部协议拦截（`bytedance://`/`snssdk://`/`aweme://` 零弹窗）、项目隔离、方案 A 首收转正、TopicHub 分类与 7 态生命周期、清理废弃 Side Panel 桥接 | `data/backups/workbench_v0.1.5_rc_20261128.db`（`ok`） | 后端 5/5 PASS、5 轮双浏览器切换 PASS、FIX-A09 `OpenWith.exe` 增量 = `0` PASS；抖音实机扫码待用户验证 |
| **R4-B** | `v0.1.6-rc` | 「AI 维度词生成」语义去重、可解释五因子启发式「AI 随机推荐」（显式声明 `heuristic_rule`）、取消 6/15 硬编码自定义数量、候选选题锁定保护、拒绝排重、单条/批量/全部重生成 | `data/backups/workbench_v0.1.6_rc_20261128.db`（`ok`） | `verify_r4_b.py` 4/4 ALL PASS |
| **R4-C** | `v0.1.7-rc` | 本地免费翻译模型安装向导与 TopicHub 外语视频自动翻译闭环（语言判定→自动提字幕→0-Token 缓存优先→中文不重译→切视频取消防串用） | `data/backups/workbench_v0.1.7_rc_20261128.db`（`ok`） | `verify_r4_c.py` 3/3 ALL PASS |
| **R4-D** | `v0.1.8-rc` | 文案工坊 Skill 整改：「二创脚本」更名「原创文案」、明显「+ 导入 / 自定义 Skill」入口、同一 Skill 自由切换已配置 AI 模型、多篇参考文案 + 关联选题 + 额外要求生成独立原创版本（绝不覆盖原文）、移除固定 SOP 脚本骨架与文案工坊「真实素材台账」入口（保留底层素材 API 与历史数据） | `data/backups/workbench_v0.1.8_rc_20261128.db`（`ok`） | `verify_r4_d.py` 5/5 ALL PASS |
| **R4-E** | `v0.1.9-rc` | 双语字幕位置优化最小技术验证：在不侵入第三方 DOM、不遮挡原生进度条/音量/全屏、不削弱 Electron 35 安全隔离前提下，实现「紧贴视频下沿」无缝影院字幕条（支持一键切换「紧贴视频下沿 / 标准停靠」） | `data/backups/workbench_v0.1.9_rc_20261128.db`（`ok`） | 真机截图与合成录屏视觉核验 PASS |
| **R4-C-FINAL** | `v0.1.10-rc` | 获用户授权部署腾讯混元 `Hy-MT3-1.8B-Q4_K_M.gguf` + `llama.cpp b12823 (CUDA 12.4)` GPU 加速推理；接入官方翻译 Prompt、按需启停与显存释放、设置页 7 项状态与打开模型目录、设为默认翻译引擎、断网与 248/324 段全量字幕实测 | `data/backups/workbench_v0.1.10_rc_20261128.db`（`ok`） | `verify_r4_c_final.py` 6/6 ALL PASS + Electron 真机录屏更新 PASS |
| **R4-F** | `v0.1.11-rc` | FIX-F01 删除字幕位置切换按钮与无依赖分支；FIX-F02 抖音分享文本提取（实测样例精准解析出 `7702420505361452297`）、多链接选择、失效/非白名单拦截、已收录链接 409 防覆盖编辑；FIX-F03 明确收录目的地为选题资产中心、真实项目/选题切换与直达按钮；FIX-F04 根治旧 11434 报错残留、真实健康判定与前端防竞态 | `data/backups/workbench_v0.1.11_rc_20261128.db`（`ok`） | `verify_r4_f.py` **4/4 ALL PASS** + 最新 Electron 真机截图与录屏（`670 KB`）视觉确认 PASS |
| **R4-G** | `v0.1.12-rc` | 双语字幕时间轴同步专项修复（零全局固定延迟）：移除 `-0.15s/+0.15s` 偏置与静音 5s 兜底、重叠自动字幕按 `currentTime` 倒序取最新已开始段、`main.js` 广告态 `.ad-showing` 隔离与主 `<video>` 优选、100ms 轮询 + `playbackReqSeqRef` 防旧 IPC 覆盖与 URL 归属校验 | `data/backups/workbench_v0.1.12_rc_20261128.db`（`ok`） | `verify_r4_g_sync.js` **54 点全场景 PASS**（均值 `88ms`、峰值 `202ms` <= 250ms；附带真实声音录屏 `06_r4_g_sync_with_audio.mp4` 1.16 MB 与诊断日志） |

---

## 二、GCW-R4-C-FINAL 本地混元翻译模型部署与实测档案

### 1. 模型与推理环境实际部署信息
- **官方模型来源**：`https://huggingface.co/tencent/Hy-MT3-1.8B-GGUF`
- **模型文件实际路径**：`C:\Users\wodhc\.gemini\antigravity\scratch\content-workbench\models\hunyuan-mt\Hy-MT3-1.8B-Q4_K_M.gguf`（已加入 `.gitignore`，不入 Git）
- **模型文件大小**：`1,348,432,160` 字节（1.26 GiB / 1.35 GB）
- **模型 SHA256（官方 LFS 校验 100% 匹配）**：`bae6e591103654ff43ef0de7d1492f6e6df1f955505f6bb2cc52e86fc399a942`
- **模型许可证**：`Apache License 2.0`（免费可商用）
- **推理框架与版本**：`llama.cpp` Windows CUDA 12.4 便携版，`version: 1.1.0-dev (build 12823, commit 3ab385146)`（MIT 许可）
- **推理环境位置**：`C:\Users\wodhc\.gemini\antigravity\scratch\content-workbench\runtime\llama-cpp\llama-server.exe`（已加入 `.gitignore`）
- **运行参数与安全边界**：`--host 127.0.0.1 --port 8081 --alias hy-mt3-1.8b -ngl 99 -c 4096 --jinja`（仅监听本机回环地址，全层卸载至 `NVIDIA GeForce RTX 4060`）
- **官方 Prompt 与采样**：无 `system_prompt`；单句/长文使用混元官方 Default Translation 指令，批量字幕（8 段/批）使用混元官方 Delimiters `|||` 对齐指令 + 逐条兜底确保零错位；采样参数 `temperature=0.3, top_p=0.6, top_k=20, repeat_penalty=1.05`
- **未来离线打包预留清单**：已入 Git 保存于 `models/MODEL_MANIFEST.json`、`models/LICENSE_NOTICE.md`、`scripts/install_local_hunyuan_mt.py`

### 2. 真实翻译质量、速度、显存与断网实测结果（`verify_r4_c_final_result.json`）
| 实测项 | 实测指标与真实输出 | 结论 |
|---|---|---|
| **按需启动与进程复用** | 冷启动 `5,441 ms`；二次调用 `reused=true`（同一 PID `22684`，绝不重复启动） | **PASS** |
| **RTX 4060 显存占用与释放** | 启动前 `3,824 MiB` → 加载后 `5,519 MiB`（增量 **`1,695 MiB`**）→ 停止服务后回落至 `3,822 MiB`（释放 **`1,697 MiB`**，0 残留进程） | **PASS** |
| **重启/停止后自动按需拉起** | 停止态下直接发起翻译，无需手动命令，**`5,743 ms`** 自动拉起并译出：`服务停止后自动启动验证。` | **PASS** |
| **医疗术语与数字保留** | `1,291 ms` → `在上海的三级医院中，增强CT扫描和MRI检查费用约为1200元人民币，而针对难治性白血病的CAR-T细胞免疫治疗费用则约为50万美元价格的十分之一。` | **PASS** |
| **日常口语** | `1,115 ms` → `说实话，我完全惊呆了——没有疯狂的6个月等候名单，我只需扫个二维码，20分钟内就找到了专科医生，还直接在楼下就拿到了药！` | **PASS** |
| **长篇文案（611 字符）** | `1,598 ms` → 完整通顺译出，精准保留 `CAR-T疗法`、`术后随访护理`、`国际保险报销规则` | **PASS** |
| **248 段真实视频字幕（`#39` ShanghaiEye）** | 248/248 全部译完，耗时 **`31.35 s`**（`7.91 段/秒`），时间轴零错位，人工精校第 0 段保护完好；二次缓存复用 `47 ms`（0 费用） | **PASS** |
| **324 段真实视频字幕（`#41` BBC）** | 324/324 全部译完，耗时 **`47.27 s`**（`6.85 段/秒`），中文全文 5,965 字，时间轴零错位；二次缓存复用 `56 ms`（0 费用） | **PASS** |
| **断网环境离线翻译** | 硬拦截一切非 `127.0.0.1/localhost` 出站连接，`127 ms` 译出：`离线本地GPU翻译无需任何互联网连接即可运行。` | **PASS** |
| **默认引擎与多引擎保留** | 默认引擎已切换为 `hunyuan_mt3_local`，其余 6 个云端引擎（DeepSeek/Gemini/豆包/自定义 OpenAI/火山/Google）完整保留供手动切换；本地失败绝不擅自切付费 API | **PASS** |

---

## 三、真实操作录屏与真机截图证据

- **R4-A 双独立浏览器隔离 5 轮往返录屏**：`docs/gcw_uat_r4_a/evidence/06_r4_a_dual_browser_demo.mp4`（1.10 MB）
- **R4-B / C-FINAL / D / E 全流程真机演示录屏**：`docs/gcw_uat_r4_final/evidence/05_r4_final_demo.mp4`（653 KB）
- **真机截图清单**：
  1. `docs/gcw_uat_r4_final/evidence/01_r4_b_searchhub_ai_dims_lock.png`
  2. `docs/gcw_uat_r4_final/evidence/02_r4_c_local_wizard.png`（已更新：混元本地设为默认、GPU 在线、7 项状态与打开模型目录按钮）
  3. `docs/gcw_uat_r4_final/evidence/03_r4_d_transcript_original_skill.png`
  4. `docs/gcw_uat_r4_final/evidence/04_r4_e_bilingual_subtitle_tight.png`（已更新：`hunyuan_mt3_local` 本地混元双语字幕无缝紧贴视频下沿）

---

## 四、剩余需用户亲自验证事项（严格不标 PASS）

1. **抖音实机扫码登录及跨重启会话保持**：受限于手机端实机扫码交互，未在自动化脚本中代为登录，请用户在桌面版内置研究浏览器中亲自扫码登录抖音，验证跨页面与重启后免重复登录。
2. **版本定型与远程推送**：已按用户授权将纯安全源码同步至独立审查分支 `review/gcw-uat-r4`（未触碰 `main`，未执行 `force push`），所有候选标签（`v0.1.5-rc` ~ `v0.1.13-rc`）均保持为候选状态，待 ChatGPT 独立审查及用户最终验收确认后再决定是否合并 `main` 或标记稳定版本。

---

## 五、GCW-UAT-R4-H｜源码同步及选题收录专项修复（`v0.1.13-rc`）

### 5.1 第一阶段：独立审查分支纯安全源码同步（基于 `v0.1.12-rc`）
- **同步分支**：`review/gcw-uat-r4`（从 `origin/main` 干净检出，仅含安全源码、清单与文档，不触碰 `main`，不使用 `force push`）。
- **首批 Commit SHA**：`3b57c24dff55e759f430d903dca258c47e06072b`（共 `190` 文件，本次同步 `84` 个纯源码/文档/模型清单文件）。
- **敏感信息与排除项扫描**：API Key、`.env`、Cookie/登录凭据、SQLite 数据库与备份、`models/*.gguf`、`.venv`/`runtime/llama.cpp`/`node_modules`、私人日志及真机截图录屏均已严格排除（`BAD_FILES: []`、`SECRET_HITS: []`）。

### 5.2 第二阶段：作品 `#104` 收录 BUG 根因定位（数据库铁证 + 源码行号）
1. **数据库实查铁证**：
   - `contents.id=104`（《Gemini 4 Carbon 值不值得用？十个项目实测》）的 `source_url` 为抖音精选首页 `https://www.douyin.com/jingxuan/`，`source_item_id` 为 12 位 MD5 临时哈希 `3d5a56bd3d9c`；
   - 用户先后收录的 3 条不同抖音视频——`topic_evidence.id=103`（`project_id=1`, `topic_id=37`, 《网红男明星的日记 吃不停》）、`id=104`（`project_id=1`, `topic_id=38`, 《一只鹈鹕，怎么成了全球顶级AI的噩梦？》）、`id=105`（`project_id=2`, `topic_id=13`, 《Gemini 4 Carbon 值不值得用？十个项目实测》）——因共享同一临时哈希 `3d5a56bd3d9c`，在全局去重时被错误合并覆盖到同一条 `contents.id=104`；
   - 切换目标项目到 `project_id=2`（商业认知与变现）时，原前端弹窗自动切换为 `existing_topic` 并默认选中该项目第一条旧选题 `#13`（《马斯克政治立场争议》），导致未创建新选题且误挂在 `#13` 下。
2. **源码行号定位**：
   - `desktop/main.js#L567-L576`：原逻辑只从地址栏 `url` 提取抖音视频 ID，抖音精选页地址栏恒为 `/jingxuan/`；
   - `backend/collectors/media.py#L55-L57`：对无视频 ID 的 URL 回退生成 12 位 MD5 临时哈希；
   - `frontend/src/components/VideoCaptureModal.tsx`：原「选择收录方向（三选一）」在切项目时隐式切为 `existing_topic` 并选中 `filteredTopics[0]`。

### 5.3 第三、四阶段：极简 4 步收录流重构与精准跳转
- **`desktop/main.js`**：在抖音精选/推荐流中增强从 `[data-e2e="feed-active-video"]` 属性、`a[href*="/video/"]` 及 React fiber 只读提取真实 19 位 `aweme_id`，命中后自动规范化 `url = https://www.douyin.com/video/<id>`。
- **`backend/services/video_capture_service.py`**：新增 `_is_temp_md5_hash` 与 `_resolve_verified_work_identity`，严格拒绝将精选首页/搜索页或 12 位 MD5 临时哈希当真实作品 ID 入库（返回 400 并引导粘贴分享链接）；统一单事务原子落库，自动复用/新建「待研究」选题，绝不修改已有选题生命周期状态；返回完整 `content_id, topic_id, project_id, topic_title, link_status, topic_created, manual_transcript_collected: 0`。
- **`frontend/src/components/VideoCaptureModal.tsx`**：彻底删除「选择收录方向（三选一）」与 A/B/C 冗余逻辑，重构为极简 4 步弹窗（1. 所属研究项目 → 2. 选题名称自动生成或改选已有 → 3. 核对作品信息/分享链解析 → 4. 确认收录），增加防连点锁 `saving`，成功后展示真实保存明细与「前往选题资产中心查看 →」按钮。
- **`frontend/src/App.tsx` & `frontend/src/pages/TopicHub.tsx`**：新增 `focusTarget`，点击直达按钮后自动切换目标项目、清空不适用的筛选条件并精准定位选中刚保存的选题。

### 5.4 第五阶段：无损修复、自动化回归与真机录屏验收
- **历史数据无损修复**：先执行专项热备 `data/backups/workbench_pre_fix104_20261128.db`，在 `project_id=2`（商业认知与变现）新建正式「待研究」选题 `#39`《Gemini 4 Carbon 值不值得用？十个项目实测》，将误挂在 `#13` 下的 `topic_evidence.id=105` 改指 `#39`，零删除历史数据。
- **自动化回归测试（`docs/gcw_uat_r4_final/verify_r4_h.py`）**：5/5 ALL PASS（拒绝精选页临时哈希 400、抖音完整分享文本解析真实 19 位 ID 入库 `project_id=2`、连续重复点击幂等、跨项目收录至汽车项目 `461` 与跨境医疗项目 `1` 保留已有 `#20` 原状态 `已验证` 不变、TopicHub 立即可查且绝不自动进文案工坊）。
- **Electron 真机截图与操作录屏（`capture_r4_h_demo_result.json`）**：
  - `evidence/07_r4_h_simplified_capture_modal.png`（确认已移除「选择收录方向（三选一）」）
  - `evidence/08_r4_h_proj2_gemini_topic39.png`（确认 `project_id=2` 下 `#39` 清晰可见）
  - `evidence/07_r4_h_capture_flow_demo.mp4`（583KB，18 帧真实操作录屏）
- **版本冻结与增量同步**：本地 SQLite 热备 `data/backups/workbench_v0.1.13_rc_20261128.db`（`PRAGMA integrity_check = ok`），本地标签 `v0.1.13-rc` 冻结后增量推送安全源码至 `review/gcw-uat-r4`。
