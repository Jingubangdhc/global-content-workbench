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
2. **版本定型与远程推送**：所有候选标签（`v0.1.5-rc` ~ `v0.1.10-rc`）均仅保存在本地 Git，未推送 GitHub，未标记为正式稳定版本，待 ChatGPT 独立审查及用户统一验收确认后再决定后续动作。
