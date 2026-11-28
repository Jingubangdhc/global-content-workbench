import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clapperboard,
  ExternalLink,
  FileText,
  FolderOutput,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { ContentItem } from '../api';
import AiSmartEditPanel from '../components/AiSmartEditPanel';

interface Props {
  projectId: number;
  onJumpPublish?: () => void;
}

const OVERLAY_AUTOSAVE_KEY = 'overlayStudioAutosave';

/**
 * G1 智能视频制作（方案 B：100% 完整保留原版独立 Overlay Studio v1.4.0 编辑器 + 工作台顶部双向工程桥接栏）
 *
 * 架构与合规原则：
 * - 不复制、不修改上游源码，通过同源回环代理 /overlay-engine/ 直接运行原版完整编辑台与效果库；
 * - 100% 保真原版时间轴（自动多行分轨、边缘 8px 调时长、10px 磁吸、顶边调高度、锚点缩放、剪映式擦洗）、
 *   原版画布（60fps、12px 舞台辅助线、滚轮缩放、卡内录屏同步、零白光）与原版自动保存/导出；
 * - 顶部 44px 轻量工程交接栏负责与 Global Content Workbench 双向联动：
 *   文案提取工坊导入 SRT → DeepSeek AI 编排推入原版编辑台 → 原版精修与导出 → 同步不可变版本/偏好学习 → 一键送去 PublishHub。
 */
export default function VideoStudio({ projectId, onJumpPublish }: Props) {
  const [caps, setCaps] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [activeProj, setActiveProj] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [contents, setContents] = useState<ContentItem[]>([]);
  const [feedbackRules, setFeedbackRules] = useState<any[]>([]);
  const [engineExports, setEngineExports] = useState<any[]>([]);
  const [lintRes, setLintRes] = useState<any>(null);

  const [iframeNonce, setIframeNonce] = useState(0);
  const [studioMode, setStudioMode] = useState<'ai_smart_edit' | 'overlay' | 'motion_lab'>('ai_smart_edit');
  const [drawerTab, setDrawerTab] = useState<null | 'versions' | 'feedback' | 'lint' | 'exports'>(null);

  const [newProjModal, setNewProjModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [srtModal, setSrtModal] = useState(false);
  const [srtInput, setSrtInput] = useState('');
  const [selectedContentId, setSelectedContentId] = useState<number | ''>('');

  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 4200);
  };

  const loadAll = async (preferVid?: number) => {
    const [capData, projList, contentList, ruleList, expData] = await Promise.all([
      api.videoCapabilities().catch(() => null),
      api.listVideoProjects(projectId).catch(() => []),
      api.listContents({ project_id: projectId }).catch(() => []),
      api.listVideoFeedbackRules(projectId).catch(() => []),
      api.listEngineExports().catch(() => ({ items: [] })),
    ]);
    setCaps(capData);
    setProjects(projList || []);
    setContents(contentList || []);
    setFeedbackRules(ruleList || []);
    setEngineExports(expData?.items || []);

    const target = preferVid
      ? projList.find((p: any) => p.id === preferVid)
      : activeProj
      ? projList.find((p: any) => p.id === activeProj.id) || projList[0]
      : projList[0];
    if (target) {
      await openProject(target.id);
    } else {
      setActiveProj(null);
      setVersions([]);
      setLintRes(null);
    }
  };

  const openProject = async (vid: number) => {
    const data = await api.getVideoProject(vid);
    setActiveProj(data.project);
    setVersions(data.versions || []);
    setLintRes(data.project.lint_summary_json ? JSON.parse(data.project.lint_summary_json) : null);
  };

  useEffect(() => {
    loadAll();
  }, [projectId]);

  /** 将指定 OverlayDoc 通过同源 localStorage 协议推入原版 Overlay Studio 编辑台并刷新 */
  const pushDocToNativeEngine = (docObj: any, projectName?: string) => {
    const payload = {
      overlay: {
        version: 1,
        projectName: projectName || activeProj?.title || '工作台工程',
        ...docObj,
      },
    };
    localStorage.setItem(OVERLAY_AUTOSAVE_KEY, JSON.stringify(payload));
    setIframeNonce((n) => n + 1);
  };

  /** 从同源原版编辑台读取当前最新工程 JSON */
  const readDocFromNativeEngine = (): any | null => {
    try {
      const raw = localStorage.getItem(OVERLAY_AUTOSAVE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.overlay?.cards ? parsed.overlay : parsed?.cards ? parsed : null;
    } catch {
      return null;
    }
  };

  const createProject = async () => {
    if (!newTitle.trim()) return;
    setBusy('create');
    try {
      const created = await api.createVideoProject({
        project_id: projectId,
        title: newTitle.trim(),
        aspect_ratio: '16:9',
      });
      setNewTitle('');
      setNewProjModal(false);
      await loadAll(created.id);
      showToast('✅ 已新建工作台视频工程');
    } catch (e: any) {
      showToast('创建失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleImportSrt = async () => {
    if (!activeProj) return;
    setBusy('srt');
    try {
      const r = await api.importVideoSrt(activeProj.id, {
        srt_text: srtInput.trim() || undefined,
        content_id: selectedContentId ? Number(selectedContentId) : undefined,
      });
      setSrtModal(false);
      setSrtInput('');
      await openProject(activeProj.id);
      showToast(`✅ 已导入 ${r.line_count} 句字幕（总时长 ${(r.duration_ms / 1000).toFixed(1)}s），可点击「AI编排→推入编辑台」`);
    } catch (e: any) {
      showToast('导入失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleCompileAndPush = async () => {
    if (!activeProj) return;
    setBusy('compile');
    try {
      const r = await api.compileVideoOverlay(activeProj.id, true);
      setLintRes(r.lint);
      await openProject(activeProj.id);
      pushDocToNativeEngine(r.doc, activeProj.title);
      const labCnt = r.doc?.lab_cards?.length || 0;
      const mode = r.meta?.execution_mode || 'degraded_rule_fallback';
      if (r.meta?.degraded || mode !== 'real_llm') {
        showToast(`⚠ 模型调用已降级（${r.meta?.fallback_reason || mode}），规则生成 v${r.version_no}（原版 ${r.doc.cards?.length || 0} 卡）`);
      } else {
        showToast(`✅ 真实模型 (${r.meta?.model}) 编排 v${r.version_no}：原版 ${r.doc.cards?.length || 0} 卡 + 工坊 ${labCnt} 卡（DNA v${r.meta?.dna_version}）`);
      }
    } catch (e: any) {
      showToast('AI 编排失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleSyncSaveFromEngine = async () => {
    if (!activeProj) {
      showToast('请先在左侧选择或新建一个工作台视频工程');
      return;
    }
    const nativeDoc = readDocFromNativeEngine();
    if (!nativeDoc || !Array.isArray(nativeDoc.cards)) {
      showToast('当前原版编辑台尚未有可保存的动效编排（可先在编辑台载入示例或添加卡片）');
      return;
    }
    setBusy('save');
    try {
      const r = await api.saveVideoVersion(activeProj.id, nativeDoc, '从原版 Overlay Studio 同步保存');
      setLintRes(r.lint);
      await openProject(activeProj.id);
      showToast(`✅ 已同步原版编辑台状态至工作台版本 v${r.version_no}（${nativeDoc.cards.length} 张卡）`);
    } catch (e: any) {
      showToast('同步保存失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleRestoreVersionToEngine = async (verId: number) => {
    if (!activeProj) return;
    try {
      const r = await api.restoreVideoVersion(activeProj.id, verId);
      setLintRes(r.lint);
      pushDocToNativeEngine(r.doc, activeProj.title);
      await openProject(activeProj.id);
      showToast(`✅ 已将历史版本 v${r.restored_version_no} 恢复并载入原版编辑台`);
    } catch (e: any) {
      showToast('恢复失败：' + e.message);
    }
  };

  const handleProposeFeedback = async () => {
    if (!activeProj) return;
    try {
      await api.createVideoFeedback(activeProj.id, {});
      setFeedbackRules(await api.listVideoFeedbackRules(projectId));
      showToast('✅ 已比对 AI 初稿与原版人工精修差异，生成待批准偏好规则');
    } catch (e: any) {
      showToast(e.message);
    }
  };

  const handleSendToPublish = async (videoPath?: string) => {
    if (!activeProj) {
      showToast('请先选择或新建工作台视频工程');
      return;
    }
    try {
      const r = await api.sendVideoToPublish(activeProj.id, {
        video_file_path: videoPath || '',
        title: activeProj.title,
      });
      showToast(`✅ 已创建多平台发布包 #${r.package_id}`);
      if (onJumpPublish) {
        setTimeout(() => onJumpPublish(), 600);
      }
    } catch (e: any) {
      showToast('推送发布失败：' + e.message);
    }
  };

  const engine = caps?.engine;

  return (
    <div className="h-full flex flex-col gap-2 overflow-hidden relative">
      {/* 顶部 44px 轻量工作台工程交接栏（绝不挤压下方原版完整编辑器） */}
      <div className="h-11 shrink-0 bg-[#0b1120] border border-slate-800 rounded-xl px-3 flex items-center justify-between gap-2 overflow-x-auto">
        <div className="flex items-center gap-2 shrink-0">
          {/* 三模式切换胶囊：AI 智能剪辑（默认） | 原版编排台 | AI 动效工坊 */}
          <div className="flex items-center bg-slate-950 border border-slate-700 rounded-lg p-0.5 gcw-text-tag">
            <button
              onClick={() => setStudioMode('ai_smart_edit')}
              className={`px-2 py-0.5 rounded-md font-medium transition ${
                studioMode === 'ai_smart_edit' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="AI 智能剪辑：ChatCut Desktop + Google Antigravity 原生导演（默认入口）"
            >
              ✨ AI智能剪辑
            </button>
            <button
              onClick={() => setStudioMode('overlay')}
              className={`px-2 py-0.5 rounded-md font-medium transition ${
                studioMode === 'overlay' ? 'bg-cyan-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="100% 原版 Overlay Studio v1.4.0 多轨编排台"
            >
              🎬 原版编排台
            </button>
            <button
              onClick={() => setStudioMode('motion_lab')}
              className={`px-2 py-0.5 rounded-md font-medium transition ${
                studioMode === 'motion_lab' ? 'bg-orange-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="AI Motion & Style Lab：白模解耦 · 参考反推 · 504图鉴 & 264动效库 · 1080p透明导出"
            >
              ◈ AI 动效工坊
            </button>
          </div>
          <Clapperboard className="w-4 h-4 text-cyan-400 hidden lg:inline" />
          <span className="text-xs font-semibold text-slate-200 hidden sm:inline">工作台工程</span>
          <select
            value={activeProj?.id || ''}
            onChange={(e) => e.target.value && openProject(Number(e.target.value))}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 max-w-[180px]"
          >
            {projects.length === 0 && <option value="">未绑定工程</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <button
            onClick={() => setNewProjModal(true)}
            className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> 新建
          </button>
          <span
            className={`px-2 py-0.5 rounded gcw-text-meta border flex items-center gap-1 ${
              engine?.reachable
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
            }`}
            title={engine?.license}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${engine?.reachable ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            {engine?.reachable ? `原版引擎 ${engine.engine_version} 满血运行` : '独立引擎未启动 (127.0.0.1:5177)'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setSrtModal(true)}
            disabled={!activeProj}
            className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1 disabled:opacity-40"
            title="从文案提取工坊或本地粘贴导入 SRT"
          >
            <FileText className="w-3.5 h-3.5 text-cyan-400" /> 导入文案/SRT
          </button>
          <button
            onClick={handleCompileAndPush}
            disabled={!activeProj || busy === 'compile'}
            className="px-2.5 py-1 rounded-lg bg-cyan-600/25 hover:bg-cyan-600/40 border border-cyan-500/50 text-xs text-cyan-200 flex items-center gap-1 disabled:opacity-40"
            title="DeepSeek AI 编排并直接推入下方原版编辑台"
          >
            {busy === 'compile' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            AI编排→推入编辑台
          </button>
          <button
            onClick={handleSyncSaveFromEngine}
            disabled={!activeProj || busy === 'save'}
            className="px-2.5 py-1 rounded-lg bg-emerald-600/25 hover:bg-emerald-600/40 border border-emerald-500/40 text-xs text-emerald-200 flex items-center gap-1 disabled:opacity-40"
            title="将下方原版编辑台当前进度保存为工作台不可变版本"
          >
            <Save className="w-3.5 h-3.5" /> 同步存档
          </button>
          <button
            onClick={() => setDrawerTab(drawerTab === 'versions' ? null : 'versions')}
            className={`px-2 py-1 rounded-lg border text-xs flex items-center gap-1 ${
              drawerTab === 'versions' ? 'bg-cyan-600/30 border-cyan-400 text-cyan-100' : 'bg-slate-900 border-slate-700 text-slate-300'
            }`}
          >
            <History className="w-3.5 h-3.5" /> 版本({versions.length})
          </button>
          <button
            onClick={() => setDrawerTab(drawerTab === 'feedback' ? null : 'feedback')}
            className={`px-2 py-1 rounded-lg border text-xs flex items-center gap-1 ${
              drawerTab === 'feedback' ? 'bg-cyan-600/30 border-cyan-400 text-cyan-100' : 'bg-slate-900 border-slate-700 text-slate-300'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-amber-300" /> 质检/偏好
          </button>
          <button
            onClick={async () => {
              const exp = await api.listEngineExports().catch(() => ({ items: [] }));
              setEngineExports(exp?.items || []);
              setDrawerTab(drawerTab === 'exports' ? null : 'exports');
            }}
            className={`px-2.5 py-1 rounded-lg border text-xs flex items-center gap-1 ${
              drawerTab === 'exports' ? 'bg-orange-600 border-orange-400 text-white' : 'bg-orange-600/25 border-orange-500/50 text-orange-200 hover:bg-orange-600/40'
            }`}
          >
            <Send className="w-3.5 h-3.5" /> 成片送发布
          </button>
          <a
            href="/overlay-engine/"
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-400 hover:text-cyan-300"
            title="新标签页全屏打开原版 Overlay Studio"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {toast && (
        <div className="px-3 py-1 rounded-lg bg-cyan-500/15 border border-cyan-500/35 text-cyan-200 text-xs shrink-0">
          {toast}
        </div>
      )}

      {/* 主体全屏区：三模式按需独占渲染（AI智能剪辑默认入口 + 100% 保留原版 Overlay Studio v1.4.0 + AI Motion & Style Lab） */}
      <div className="flex-1 bg-[#0b1120] border border-slate-800 rounded-xl overflow-hidden flex flex-col relative min-h-0">
        {studioMode === 'ai_smart_edit' ? (
          <AiSmartEditPanel
            projectId={projectId}
            videoProjectId={activeProj?.id}
            contents={contents}
            onJumpPublish={onJumpPublish}
          />
        ) : studioMode === 'overlay' ? (
          engine?.reachable ? (
            <iframe
              key={iframeNonce}
              src="/overlay-engine/"
              title="Overlay Studio v1.4.0 原版完整编辑器"
              className="w-full flex-1 border-0 bg-[#090d16]"
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-xs gap-2 p-6">
              <Clapperboard className="w-8 h-8 text-slate-600" />
              <div>独立 Overlay Studio 引擎（http://127.0.0.1:5177/overlay-engine/）当前未启动</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    const ctl = (window as any).gcwOverlayStudio;
                    if (ctl?.start) {
                      showToast('正在通过 GCW 启动原版 Overlay Studio 引擎...');
                      const st = await ctl.start();
                      if (!st?.running && st?.lastError) showToast(st.lastError);
                    }
                    await loadAll();
                  }}
                  className="px-3 py-1.5 rounded bg-cyan-600 text-white flex items-center gap-1"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> 启动 / 重新检测引擎
                </button>
              </div>
            </div>
          )
        ) : (
          <iframe
            src="/motion-lab/"
            title="AI Motion & Style Lab 动效研发工坊"
            className="w-full flex-1 border-0 bg-[#f7f6f2]"
          />
        )}

        {/* 右侧滑出工作台桥接抽屉（按需展开，默认关闭不占原版空间） */}
        {drawerTab && (
          <div className="absolute top-0 right-0 bottom-0 w-96 bg-[#0b1120]/98 border-l border-slate-700 shadow-2xl z-30 flex flex-col text-xs">
            <div className="px-3.5 py-2.5 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between">
              <span className="font-semibold text-slate-100">
                {drawerTab === 'versions' && '工作台不可变版本历史（A14）'}
                {drawerTab === 'feedback' && '编排质检（A13）& 人工偏好学习（A16）'}
                {drawerTab === 'exports' && '原版导出成片 → 一键送去多平台发布'}
              </span>
              <button onClick={() => setDrawerTab(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {drawerTab === 'versions' && (
                <>
                  <div className="gcw-text-tag text-slate-400">
                    点击「同步存档」可将原版编辑台当前进度保存为工作台不可变快照；点「恢复到编辑台」可随时回滚。
                  </div>
                  {versions.map((v) => (
                    <div key={v.id} className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-200">v{v.version_no} · {v.source_type}</div>
                        <div className="gcw-text-meta text-slate-400 truncate">{v.note} ({v.checksum})</div>
                      </div>
                      <button
                        onClick={() => handleRestoreVersionToEngine(v.id)}
                        className="px-2 py-1 rounded bg-cyan-600/30 hover:bg-cyan-600 text-cyan-100 gcw-text-tag shrink-0"
                      >
                        恢复到编辑台
                      </button>
                    </div>
                  ))}
                  {versions.length === 0 && <div className="text-slate-500 text-center py-6">暂无已同步版本</div>}
                </>
              )}

              {drawerTab === 'feedback' && (
                <>
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 space-y-1.5">
                    <div className="font-semibold text-slate-200">最近一次质量检查结果</div>
                    {lintRes ? (
                      <div className={lintRes.passed ? 'text-emerald-300 flex items-center gap-1' : 'text-rose-300'}>
                        {lintRes.passed ? <CheckCircle2 className="w-3.5 h-3.5" /> : null}
                        {lintRes.passed ? '0 项硬错误，允许导出' : `发现 ${lintRes.error_count} 项硬错误`}
                      </div>
                    ) : (
                      <div className="text-slate-500">同步存档或 AI 编排后自动生成质检报告</div>
                    )}
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                    <span className="font-semibold text-slate-200">人工修改偏好学习（A16）</span>
                    <button onClick={handleProposeFeedback} disabled={!activeProj} className="px-2 py-1 rounded bg-cyan-600/30 text-cyan-200 gcw-text-tag disabled:opacity-40">
                      提取人工精修差异
                    </button>
                  </div>
                  <div className="gcw-text-meta text-slate-400">仅人工批准的规则影响后续 AI 编排，可随时撤销，绝不用于模型训练。</div>
                  {feedbackRules.map((r) => (
                    <div key={r.id} className="p-2 rounded bg-slate-900 border border-slate-800 space-y-1.5">
                      <div className="text-slate-200">{r.proposed_rule}</div>
                      <div className="flex items-center justify-between gcw-text-meta">
                        <span className={r.status === 'approved' ? 'text-emerald-400' : 'text-amber-300'}>状态：{r.status}</span>
                        <div className="flex gap-1">
                          {r.status !== 'approved' && (
                            <button
                              onClick={() => api.patchVideoFeedbackRule(r.id, { status: 'approved' }).then(() => api.listVideoFeedbackRules(projectId).then(setFeedbackRules))}
                              className="px-1.5 py-0.5 rounded bg-emerald-600/30 text-emerald-200"
                            >
                              批准生效
                            </button>
                          )}
                          {r.status === 'approved' && (
                            <button
                              onClick={() => api.patchVideoFeedbackRule(r.id, { status: 'revoked' }).then(() => api.listVideoFeedbackRules(projectId).then(setFeedbackRules))}
                              className="px-1.5 py-0.5 rounded bg-rose-600/30 text-rose-200"
                            >
                              撤销
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}

              {drawerTab === 'exports' && (
                <>
                  <div className="gcw-text-tag text-slate-400">
                    在左侧原版编辑台点击「导出透明 MOV」后，产物会出现在下方列表中，可直接一键送往「多平台发布中心」。
                  </div>
                  <button
                    onClick={() => handleSendToPublish('')}
                    disabled={!activeProj}
                    className="w-full py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium flex items-center justify-center gap-1.5 disabled:opacity-40"
                  >
                    <Send className="w-3.5 h-3.5" /> 仅用当前工程标题创建发布包
                  </button>
                  <div className="space-y-1.5 pt-2 border-t border-slate-800">
                    <div className="gcw-text-tag text-slate-300 font-medium flex items-center gap-1">
                      <FolderOutput className="w-3.5 h-3.5 text-amber-400" /> 原版导出目录最新文件 ({engineExports.length})
                    </div>
                    {engineExports.map((it) => (
                      <div key={it.path} className="p-2 rounded bg-slate-900 border border-slate-800 space-y-1">
                        <div className="text-slate-200 font-mono-num truncate">{it.name}</div>
                        <div className="flex items-center justify-between gcw-text-meta text-slate-400">
                          <span>{(it.size_bytes / 1024 / 1024).toFixed(1)} MB · {it.ext.toUpperCase()}</span>
                          <button
                            onClick={() => handleSendToPublish(it.path)}
                            className="px-2 py-0.5 rounded bg-orange-600 hover:bg-orange-500 text-white"
                          >
                            送去发布 →
                          </button>
                        </div>
                      </div>
                    ))}
                    {engineExports.length === 0 && (
                      <div className="text-slate-500 text-center py-4">暂未检测到原版导出的 .mov / .webm 文件</div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 新建工作台工程弹窗 */}
      {newProjModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-96 bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3 text-xs">
            <div className="text-sm font-bold text-slate-100">新建工作台视频工程</div>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createProject()}
              placeholder="输入视频工程标题..."
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setNewProjModal(false)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300">取消</button>
              <button onClick={createProject} disabled={busy === 'create'} className="px-3 py-1.5 rounded bg-cyan-600 text-white">创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 从文案提取工坊导入 SRT 弹窗 */}
      {srtModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-[540px] bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3 text-xs">
            <div className="text-sm font-bold text-slate-100">导入文案 / SRT 字幕（随后可 AI 编排推入原版编辑台）</div>
            <div className="space-y-1">
              <div className="gcw-text-tag text-slate-400">方式一：直接选择「文案提取工坊」已提取的素材</div>
              <select
                value={selectedContentId}
                onChange={(e) => setSelectedContentId(e.target.value ? Number(e.target.value) : '')}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
              >
                <option value="">-- 选择素材 --</option>
                {contents.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.id} [{c.platform}] {c.title?.slice(0, 48)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <div className="gcw-text-tag text-slate-400">方式二：直接粘贴中英文 SRT 字幕全文</div>
              <textarea
                value={srtInput}
                onChange={(e) => setSrtInput(e.target.value)}
                rows={6}
                placeholder={'1\n00:00:00,000 --> 00:00:03,500\n今天我们用真实数据拆解一个关键现象'}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 font-mono-num text-slate-200"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSrtModal(false)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300">取消</button>
              <button onClick={handleImportSrt} disabled={busy === 'srt'} className="px-3 py-1.5 rounded bg-cyan-600 text-white">
                {busy === 'srt' ? '导入中...' : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
