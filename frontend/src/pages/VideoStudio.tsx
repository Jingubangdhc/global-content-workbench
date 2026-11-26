import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  Download,
  ExternalLink,
  FileText,
  Film,
  History,
  Layers,
  Loader2,
  Pause,
  Play,
  Plus,
  Redo2,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Volume2,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import type { ContentItem } from '../api';

interface Props {
  projectId: number;
}

interface OverlayCard {
  id: string;
  kind: string;
  start: number;
  end: number;
  lintOff?: boolean | string[];
  params: Record<string, any>;
}

interface OverlayDoc {
  version: 1;
  ratio?: 'h' | 'v' | '4:3';
  theme?: 'dark' | 'light';
  exportFps?: number;
  srt?: { start: number; end: number; text: string }[];
  cards: OverlayCard[];
}

/** G1 智能视频制作页面（A01–A16，独立回环接入 Overlay Studio 1.4.0） */
export default function VideoStudio({ projectId }: Props) {
  const [caps, setCaps] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [activeProj, setActiveProj] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [renderJobs, setRenderJobs] = useState<any[]>([]);
  const [contents, setContents] = useState<ContentItem[]>([]);
  const [feedbackRules, setFeedbackRules] = useState<any[]>([]);

  const [doc, setDoc] = useState<OverlayDoc>({ version: 1, ratio: 'h', theme: 'dark', exportFps: 30, cards: [] });
  const [undoStack, setUndoStack] = useState<OverlayDoc[]>([]);
  const [redoStack, setRedoStack] = useState<OverlayDoc[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [lintRes, setLintRes] = useState<any>(null);

  const [effectSearch, setEffectSearch] = useState('');
  const [effectGroup, setEffectGroup] = useState('全部');
  const [hoverEffect, setHoverEffect] = useState<{ eff: any; top: number } | null>(null);
  const hoverIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [rightTab, setRightTab] = useState<'props' | 'lint' | 'sfx' | 'feedback' | 'versions'>('props');

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [viewMode, setViewMode] = useState<'workbench' | 'native'>('workbench');
  const [stageScale, setStageScale] = useState(0.35);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const overlayIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeReady, setIframeReady] = useState(false);

  const [newProjModal, setNewProjModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newRatio, setNewRatio] = useState<'16:9' | '9:16'>('16:9');
  const [srtModal, setSrtModal] = useState(false);
  const [srtInput, setSrtInput] = useState('');
  const [selectedContentId, setSelectedContentId] = useState<number | ''>('');

  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [activeJobUid, setActiveJobUid] = useState<string | null>(null);

  // 自定义音效表单
  const [sfxName, setSfxName] = useState('');
  const [sfxLicense, setSfxLicense] = useState('CC0 / 自购授权');
  const [sfxFile, setSfxFile] = useState<File | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 4200);
  };

  const loadAll = async (preferVid?: number) => {
    const [capData, projList, contentList, ruleList] = await Promise.all([
      api.videoCapabilities().catch(() => null),
      api.listVideoProjects(projectId).catch(() => []),
      api.listContents({ project_id: projectId }).catch(() => []),
      api.listVideoFeedbackRules(projectId).catch(() => []),
    ]);
    setCaps(capData);
    setProjects(projList || []);
    setContents(contentList || []);
    setFeedbackRules(ruleList || []);
    const target = preferVid
      ? projList.find((p: any) => p.id === preferVid)
      : activeProj
      ? projList.find((p: any) => p.id === activeProj.id) || projList[0]
      : projList[0];
    if (target) {
      await openProject(target.id);
    } else {
      setActiveProj(null);
      setDoc({ version: 1, ratio: 'h', theme: 'dark', exportFps: 30, cards: [] });
      setVersions([]);
      setRenderJobs([]);
      setLintRes(null);
    }
  };

  const openProject = async (vid: number) => {
    const data = await api.getVideoProject(vid);
    setActiveProj(data.project);
    setVersions(data.versions || []);
    setRenderJobs(data.render_jobs || []);
    const parsedDoc: OverlayDoc = data.project.draft_overlay_json
      ? JSON.parse(data.project.draft_overlay_json)
      : { version: 1, ratio: data.project.aspect_ratio === '9:16' ? 'v' : 'h', theme: 'dark', exportFps: 30, cards: [] };
    setDoc(parsedDoc);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedCardId(parsedDoc.cards?.[0]?.id || null);
    setLintRes(data.project.lint_summary_json ? JSON.parse(data.project.lint_summary_json) : null);
    setCurrentTime(0);
    setPlaying(false);
  };

  useEffect(() => {
    loadAll();
  }, [projectId]);

  // 轮询运行中的渲染任务
  useEffect(() => {
    if (!activeJobUid) return;
    const timer = setInterval(async () => {
      try {
        const j = await api.getRenderJob(activeJobUid);
        setRenderJobs((prev) => [j, ...prev.filter((x) => x.job_uid !== j.job_uid)]);
        if (['completed', 'failed', 'cancelled'].includes(j.state)) {
          setActiveJobUid(null);
          if (j.state === 'completed') showToast('✅ 透明视频导出完成并通过 ffprobe Alpha 校验');
          else if (j.state === 'cancelled') showToast('已取消渲染并清理临时文件');
          else showToast('渲染失败：' + (j.error_message || '未知错误'));
        }
      } catch {}
    }, 1800);
    return () => clearInterval(timer);
  }, [activeJobUid]);

  // 播放时钟同步（无参考视频时也支持虚拟时钟预览）
  useEffect(() => {
    if (!playing) return;
    const totalSec = Math.max(10, (activeProj?.duration_ms || 15000) / 1000);
    const timer = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setCurrentTime(videoRef.current.currentTime);
      } else {
        setCurrentTime((t) => (t + 0.1 >= totalSec ? 0 : Number((t + 0.1).toFixed(2))));
      }
    }, 100);
    return () => clearInterval(timer);
  }, [playing, activeProj?.duration_ms]);

  const mutateDoc = (next: OverlayDoc) => {
    setUndoStack((s) => [...s.slice(-25), doc]);
    setRedoStack([]);
    setDoc(next);
  };

  const handleUndo = () => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, doc]);
    setUndoStack((s) => s.slice(0, -1));
    setDoc(prev);
  };

  const handleRedo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((s) => [...s, doc]);
    setRedoStack((r) => r.slice(0, -1));
    setDoc(next);
  };

  const createProject = async () => {
    if (!newTitle.trim()) return;
    setBusy('create');
    try {
      const created = await api.createVideoProject({
        project_id: projectId,
        title: newTitle.trim(),
        aspect_ratio: newRatio,
      });
      setNewTitle('');
      setNewProjModal(false);
      await loadAll(created.id);
      showToast('✅ 已创建视频工程');
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
      showToast(`✅ 已导入 ${r.line_count} 条字幕（总时长 ${(r.duration_ms / 1000).toFixed(1)}s）`);
    } catch (e: any) {
      showToast('导入字幕失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleCompile = async (useLlm: boolean) => {
    if (!activeProj) return;
    setBusy('compile');
    try {
      const r = await api.compileVideoOverlay(activeProj.id, useLlm);
      setDoc(r.doc);
      setLintRes(r.lint);
      setSelectedCardId(r.doc.cards?.[0]?.id || null);
      await openProject(activeProj.id);
      showToast(`✅ 已生成编排 v${r.version_no}（共 ${r.doc.cards.length} 张动效卡）`);
    } catch (e: any) {
      showToast('编排失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleSaveVersion = async () => {
    if (!activeProj) return;
    setBusy('save');
    try {
      const r = await api.saveVideoVersion(activeProj.id, doc, '手动编辑保存');
      setLintRes(r.lint);
      await openProject(activeProj.id);
      showToast(`✅ 已保存不可变版本 v${r.version_no} (${r.checksum})`);
    } catch (e: any) {
      showToast('保存失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleLint = async () => {
    if (!activeProj) return;
    const r = await api.lintVideoOverlay(activeProj.id, doc);
    setLintRes(r);
    setRightTab('lint');
    showToast(r.passed ? '✅ 质量检查通过（0 项硬错误）' : `⚠️ 发现 ${r.error_count} 项硬错误，已阻止导出`);
  };

  const handleExport = async (mode: 'timeline' | 'single', includeWebm = true) => {
    if (!activeProj) return;
    setBusy('export');
    try {
      await api.patchVideoProject(activeProj.id, { draft_overlay_json: JSON.stringify(doc) });
      const r = await api.createRenderJob({
        video_project_id: activeProj.id,
        mode,
        effect_id: mode === 'single' ? selectedCard?.kind || 'quote-lockup' : undefined,
        include_webm: includeWebm,
        fps: activeProj.fps || 30,
        duration_sec: mode === 'single' ? 4 : Math.max(4, Math.min(30, (activeProj.duration_ms || 6000) / 1000)),
      });
      setActiveJobUid(r.job_uid);
      showToast('🎬 已发起真实透明导出任务，正在调用独立 Overlay Studio 渲染...');
    } catch (e: any) {
      showToast('导出受阻：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleProposeFeedback = async () => {
    if (!activeProj) return;
    try {
      const r = await api.createVideoFeedback(activeProj.id, {});
      const rules = await api.listVideoFeedbackRules(projectId);
      setFeedbackRules(rules);
      setRightTab('feedback');
      showToast('✅ 已生成差异偏好候选规则（需您手动批准后才生效）');
      return r;
    } catch (e: any) {
      showToast(e.message);
    }
  };

  const handleUploadSfx = async () => {
    if (!sfxFile || !sfxName.trim() || !sfxLicense.trim()) {
      showToast('请填写音效名称、授权说明并选择音频文件');
      return;
    }
    const fd = new FormData();
    fd.append('project_id', String(projectId));
    fd.append('name', sfxName.trim());
    fd.append('license_note', sfxLicense.trim());
    fd.append('file', sfxFile);
    try {
      await api.uploadCustomSfx(fd);
      setSfxName('');
      setSfxFile(null);
      const c = await api.videoCapabilities();
      setCaps(c);
      showToast('✅ 自定义授权音效已入库');
    } catch (e: any) {
      showToast('上传失败：' + e.message);
    }
  };

  const effects: any[] = caps?.effects || [];
  const groups = useMemo(() => ['全部', ...Array.from(new Set(effects.map((e) => e.group)))], [effects]);
  const filteredEffects = useMemo(
    () =>
      effects.filter((e) => {
        if (effectGroup !== '全部' && e.group !== effectGroup) return false;
        if (effectSearch.trim()) {
          const q = effectSearch.toLowerCase();
          return e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q);
        }
        return true;
      }),
    [effects, effectGroup, effectSearch]
  );

  const selectedCard = useMemo(
    () => doc.cards.find((c) => c.id === selectedCardId) || null,
    [doc.cards, selectedCardId]
  );

  const addEffectCard = (eff: any) => {
    const start = Number(currentTime.toFixed(1));
    const end = Number((start + 4.0).toFixed(1));
    const cid = `card-${Date.now().toString(36).slice(-4)}`;
    // 传空对象让上游 Overlay Studio 自动填充该卡完整官方默认参数，确保真实动效立即可见
    const newCard: OverlayCard = {
      id: cid,
      kind: eff.id,
      start,
      end,
      params: {},
    };
    mutateDoc({ ...doc, cards: [...doc.cards, newCard] });
    setSelectedCardId(cid);
    setCurrentTime(Number((start + 0.5).toFixed(1)));
  };

  // 自适应计算真实 1920x1080 / 1080x1920 透明渲染画布的缩放比例
  const engine = caps?.engine;
  const isVertical = activeProj?.aspect_ratio === '9:16';
  const stageW = isVertical ? 1080 : 1920;
  const stageH = isVertical ? 1920 : 1080;

  useEffect(() => {
    const el = stageBoxRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageScale(Math.min(rect.width / stageW, rect.height / stageH));
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageW, stageH, viewMode]);

  // 构造同源真实渲染 iframe URL（仅包含已激活工程的当前编排 JSON）
  const overlayIframeSrc = useMemo(() => {
    if (!engine?.reachable || doc.cards.length === 0) return '';
    const payload = {
      version: 1,
      ratio: isVertical ? 'v' : 'h',
      theme: doc.theme || 'dark',
      cards: doc.cards.map((c) => ({
        id: c.id,
        kind: c.kind,
        start: c.start,
        end: c.end,
        params: c.params || {},
      })),
    };
    const encoded = encodeURIComponent(JSON.stringify(payload));
    return `/overlay-engine/?export=1&ratio=${isVertical ? 'v' : 'h'}&doc=${encoded}`;
  }, [engine?.reachable, isVertical, doc]);

  // 当播放时间变化时，直接通过同源 iframe 调用 Overlay Studio 原生时间控制器 __setExportT
  useEffect(() => {
    const win = overlayIframeRef.current?.contentWindow as any;
    if (iframeReady && win && typeof win.__setExportT === 'function') {
      try {
        win.__setExportT(currentTime);
      } catch {}
    }
  }, [currentTime, iframeReady]);

  const updateSelectedCard = (patch: Partial<OverlayCard>) => {
    if (!selectedCard) return;
    mutateDoc({
      ...doc,
      cards: doc.cards.map((c) => (c.id === selectedCard.id ? { ...c, ...patch } : c)),
    });
  };

  const ignoreWarningRule = (cardId: string, rule: string) => {
    mutateDoc({
      ...doc,
      cards: doc.cards.map((c) => {
        if (c.id !== cardId) return c;
        const cur = Array.isArray(c.lintOff) ? c.lintOff : [];
        return { ...c, lintOff: Array.from(new Set([...cur, rule])) };
      }),
    });
    showToast(`已显式忽略 ${cardId} 的 ${rule} 警告（保存后留痕）`);
  };

  const totalDur = Math.max(10, (activeProj?.duration_ms || 15000) / 1000, ...doc.cards.map((c) => c.end));
  const activeSubtitle = (doc.srt || []).find((s) => currentTime >= s.start && currentTime <= s.end);

  return (
    <div className="h-full flex flex-col gap-2.5 overflow-hidden">
      {/* 顶部工具栏 */}
      <div className="bg-[#0b1120] border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <Clapperboard className="w-4 h-4 text-cyan-400 shrink-0" />
          <select
            value={activeProj?.id || ''}
            onChange={(e) => e.target.value && openProject(Number(e.target.value))}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 max-w-[220px]"
          >
            {projects.length === 0 && <option value="">暂无视频工程</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.aspect_ratio})
              </option>
            ))}
          </select>
          <button
            onClick={() => setNewProjModal(true)}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> 新建工程
          </button>
          {engine && (
            <span
              className={`px-2 py-0.5 rounded text-[10px] border flex items-center gap-1 ${
                engine.reachable
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
              }`}
              title={engine.license}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${engine.reachable ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              Overlay Studio {engine.engine_version} {engine.reachable ? '回环就绪' : '未启动'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setSrtModal(true)}
            disabled={!activeProj}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1 disabled:opacity-40"
          >
            <FileText className="w-3.5 h-3.5 text-cyan-400" /> 导入 SRT / 文案
          </button>
          <button
            onClick={() => handleCompile(true)}
            disabled={!activeProj || busy === 'compile'}
            className="px-2.5 py-1.5 rounded-lg bg-cyan-600/25 hover:bg-cyan-600/40 border border-cyan-500/50 text-xs text-cyan-200 flex items-center gap-1 disabled:opacity-40"
          >
            {busy === 'compile' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            AI 智能编排
          </button>
          <button
            onClick={handleLint}
            disabled={!activeProj}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-amber-300 flex items-center gap-1 disabled:opacity-40"
          >
            <ShieldAlert className="w-3.5 h-3.5" /> 质量检查
          </button>
          <button
            onClick={handleSaveVersion}
            disabled={!activeProj || busy === 'save'}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1 disabled:opacity-40"
          >
            <Save className="w-3.5 h-3.5" /> 保存版本
          </button>
          <button
            onClick={() => handleExport('timeline', true)}
            disabled={!activeProj || busy === 'export' || !engine?.reachable}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-40"
          >
            <Download className="w-3.5 h-3.5" /> 导出透明视频
          </button>
          {engine?.reachable && (
            <div className="flex rounded-lg overflow-hidden border border-slate-700 text-[11px]">
              <button
                onClick={() => setViewMode('workbench')}
                className={`px-2 py-1.5 ${viewMode === 'workbench' ? 'bg-cyan-600/30 text-cyan-200' : 'bg-slate-900 text-slate-400 hover:text-slate-200'}`}
              >
                工作台模式
              </button>
              <button
                onClick={() => setViewMode('native')}
                className={`px-2 py-1.5 ${viewMode === 'native' ? 'bg-cyan-600/30 text-cyan-200' : 'bg-slate-900 text-slate-400 hover:text-slate-200'}`}
              >
                原生 Overlay 编辑器
              </button>
            </div>
          )}
          {engine?.reachable && (
            <a
              href="/overlay-engine/"
              target="_blank"
              rel="noopener noreferrer"
              className="px-2 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-400 hover:text-cyan-300 flex items-center gap-1"
              title="在新标签页打开独立 Overlay Studio 原生预览器（保留原版权与授权声明）"
            >
              独立窗口 <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      {toast && (
        <div className="px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/35 text-cyan-200 text-xs">
          {toast}
        </div>
      )}

      {/* 三栏主工作区 或 原生完整编辑器 */}
      {viewMode === 'native' && engine?.reachable ? (
        <div className="flex-1 bg-[#0b1120] border border-slate-800 rounded-xl overflow-hidden flex flex-col">
          <iframe
            src="/overlay-engine/"
            title="Overlay Studio 原生完整编辑器"
            className="w-full flex-1 border-0 bg-[#060a12]"
          />
        </div>
      ) : (
      <div className="flex-1 flex gap-2.5 min-h-0 overflow-hidden">
        {/* 左栏：25 种动效模板库（两列真实缩略图 + 悬停动态小窗预览） */}
        <div className="w-76 shrink-0 bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden relative">
          <div className="p-2.5 border-b border-slate-800 bg-[#0f172a] space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-cyan-400" /> 动效模板库 ({effects.length})
              </span>
              <span className="text-[10px] text-slate-400 font-normal">悬停预览 · 点击添加</span>
            </div>
            <input
              value={effectSearch}
              onChange={(e) => setEffectSearch(e.target.value)}
              placeholder="搜索 25 种动效卡..."
              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
            />
            <div className="flex flex-wrap gap-1">
              {groups.map((g) => (
                <button
                  key={g}
                  onClick={() => setEffectGroup(g)}
                  className={`px-1.5 py-0.5 rounded text-[10px] transition ${
                    effectGroup === g
                      ? 'bg-cyan-500/25 text-cyan-300 border border-cyan-500/40'
                      : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 grid grid-cols-2 gap-2 content-start">
            {filteredEffects.map((e) => (
              <button
                key={e.id}
                onClick={() => activeProj && addEffectCard(e)}
                onMouseEnter={(ev) => {
                  const rect = ev.currentTarget.getBoundingClientRect();
                  setHoverEffect({ eff: e, top: Math.max(80, Math.min(window.innerHeight - 280, rect.top - 20)) });
                }}
                onMouseLeave={() => setHoverEffect(null)}
                disabled={!activeProj}
                className="text-left rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-slate-800 hover:border-cyan-400/60 transition overflow-hidden flex flex-col disabled:opacity-40 group"
              >
                <div className="w-full aspect-video bg-[#070c16] border-b border-slate-800/80 overflow-hidden relative flex items-center justify-center">
                  {e.thumb_url ? (
                    <img
                      src={e.thumb_url}
                      alt={e.name}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
                    />
                  ) : (
                    <span className="text-[10px] text-slate-600 font-mono-num">{e.id}</span>
                  )}
                  <span className="absolute top-1 right-1 px-1 py-0.2 rounded bg-black/70 text-[9px] text-cyan-300 opacity-0 group-hover:opacity-100 transition">
                    +添加
                  </span>
                </div>
                <div className="p-1.5">
                  <div className="text-[11px] font-medium text-slate-100 truncate">{e.name}</div>
                  <div className="text-[9px] text-slate-400 truncate mt-0.5">{e.desc}</div>
                </div>
              </button>
            ))}
          </div>

          {/* 悬停实时动态小窗预览（同源真实 Overlay Studio 动画渲染） */}
          {hoverEffect && engine?.reachable && (
            <div
              style={{ top: `${hoverEffect.top}px` }}
              className="fixed left-[545px] z-50 w-[384px] rounded-xl bg-[#0b1120] border border-cyan-500/60 shadow-2xl shadow-black/80 overflow-hidden pointer-events-none"
            >
              <div className="px-2.5 py-1.5 bg-[#0f172a] border-b border-slate-800 flex items-center justify-between text-[11px]">
                <span className="font-semibold text-cyan-300">{hoverEffect.eff.name}</span>
                <span className="font-mono-num text-[10px] text-slate-400">{hoverEffect.eff.id} · 实时预览</span>
              </div>
              <div className="w-[384px] h-[216px] bg-[#070c16] relative overflow-hidden">
                <iframe
                  key={hoverEffect.eff.id}
                  ref={hoverIframeRef}
                  src={`/overlay-engine/?export=1&ratio=h&effect=${encodeURIComponent(hoverEffect.eff.id)}&duration=6`}
                  title={`预览 ${hoverEffect.eff.name}`}
                  onLoad={() => {
                    const win = hoverIframeRef.current?.contentWindow as any;
                    if (!win) return;
                    setTimeout(() => {
                      try {
                        win.__startExport?.();
                        let t = 0.05;
                        win.__setExportT?.(t);
                        const iv = setInterval(() => {
                          try {
                            if (!hoverIframeRef.current || !win.__setExportT) {
                              clearInterval(iv);
                              return;
                            }
                            t = t >= 4.2 ? 0.05 : Number((t + 0.1).toFixed(2));
                            win.__setExportT(t);
                          } catch {
                            clearInterval(iv);
                          }
                        }, 100);
                      } catch {}
                    }, 60);
                  }}
                  style={{
                    width: '1920px',
                    height: '1080px',
                    transform: 'scale(0.2)',
                    transformOrigin: 'top left',
                    border: 0,
                    background: 'transparent',
                  }}
                />
              </div>
              <div className="px-2.5 py-1 text-[10px] text-slate-400 bg-[#080d18]">
                {hoverEffect.eff.desc}（点击卡片立即插入时间轴）
              </div>
            </div>
          )}
        </div>

        {/* 中栏：预览画布 + 4 轨时间轴 */}
        <div className="flex-1 flex flex-col gap-2.5 min-w-0 overflow-hidden">
          {/* 预览画布 */}
          <div className="flex-1 bg-[#0b1120] border border-slate-800 rounded-xl p-3 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-300 font-medium">实时参考预览</span>
                {activeProj && (
                  <select
                    value={activeProj.aspect_ratio}
                    onChange={async (e) => {
                      const ratio = e.target.value;
                      await api.patchVideoProject(activeProj.id, { aspect_ratio: ratio });
                      setActiveProj({ ...activeProj, aspect_ratio: ratio });
                      setDoc({ ...doc, ratio: ratio === '9:16' ? 'v' : 'h' });
                    }}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-0.5 text-[11px] text-cyan-300"
                  >
                    <option value="16:9">16:9 横屏</option>
                    <option value="9:16">9:16 竖屏</option>
                  </select>
                )}
              </div>
              <div className="flex items-center gap-2">
                {activeProj && (
                  <label className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-300 cursor-pointer flex items-center gap-1">
                    <Upload className="w-3 h-3 text-cyan-400" /> 上传本地 H.264 参考视频
                    <input
                      type="file"
                      accept=".mp4,.mov,.webm"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f || !activeProj) return;
                        try {
                          await api.uploadReferenceVideo(activeProj.id, f);
                          await openProject(activeProj.id);
                          showToast('✅ 参考视频已绑定（预览与运镜同步）');
                        } catch (err: any) {
                          showToast('上传失败：' + err.message);
                        }
                      }}
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="flex-1 flex items-center justify-center bg-[#060a12] rounded-lg border border-slate-800/80 relative overflow-hidden min-h-[220px]">
              <div
                ref={stageBoxRef}
                className={`relative bg-slate-950 border border-slate-700/80 overflow-hidden flex items-center justify-center ${
                  isVertical ? 'h-full aspect-[9/16]' : 'w-full h-full max-w-[960px] aspect-video'
                }`}
              >
                {activeProj?.reference_video_path ? (
                  <video
                    ref={videoRef}
                    src={`/api/video/projects/${activeProj.id}/reference-video`}
                    className="w-full h-full object-contain"
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  />
                ) : (
                  <div className="text-center text-slate-600 text-xs space-y-1 p-4 select-none">
                    <Film className="w-7 h-7 mx-auto opacity-40" />
                    <div>{doc.cards.length > 0 ? '' : activeProj ? '点击左侧 25 种动效卡即可实时渲染真实动画' : '请先新建或选择一个视频工程'}</div>
                  </div>
                )}

                {/* 真正的 Overlay Studio 同源透明动效渲染层（非文字占位，零源码复制） */}
                {overlayIframeSrc && (
                  <div
                    className="absolute inset-0 pointer-events-none overflow-hidden"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <iframe
                      key={overlayIframeSrc}
                      ref={overlayIframeRef}
                      src={overlayIframeSrc}
                      title="Overlay Studio 实时真动效画布"
                      allowTransparency={true}
                      onLoad={() => {
                        const win = overlayIframeRef.current?.contentWindow as any;
                        if (win) {
                          setTimeout(() => {
                            try {
                              win.__startExport?.();
                              win.__setExportT?.(currentTime);
                              setIframeReady(true);
                            } catch {}
                          }, 80);
                        }
                      }}
                      style={{
                        width: `${stageW}px`,
                        height: `${stageH}px`,
                        transform: `scale(${stageScale})`,
                        transformOrigin: 'center center',
                        border: 0,
                        background: 'transparent',
                        flexShrink: 0,
                      }}
                    />
                  </div>
                )}

                {/* 字幕实时叠加 */}
                {activeSubtitle && (
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-black/75 text-white text-xs text-center max-w-[90%] pointer-events-none">
                    {activeSubtitle.text}
                  </div>
                )}
              </div>
            </div>

            {/* 播放控制条 */}
            <div className="mt-2 flex items-center gap-3 text-xs">
              <button
                onClick={() => {
                  const next = !playing;
                  setPlaying(next);
                  if (videoRef.current) {
                    if (next) videoRef.current.play().catch(() => {});
                    else videoRef.current.pause();
                  }
                }}
                className="p-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white"
              >
                {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
              <input
                type="range"
                min={0}
                max={totalDur}
                step={0.1}
                value={currentTime}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCurrentTime(v);
                  if (videoRef.current) videoRef.current.currentTime = v;
                }}
                className="flex-1 accent-cyan-400"
              />
              <span className="font-mono-num text-cyan-300 w-24 text-right">
                {currentTime.toFixed(1)}s / {totalDur.toFixed(1)}s
              </span>
              <button onClick={handleUndo} disabled={!undoStack.length} className="p-1 rounded bg-slate-800 text-slate-300 disabled:opacity-30" title="撤销">
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button onClick={handleRedo} disabled={!redoStack.length} className="p-1 rounded bg-slate-800 text-slate-300 disabled:opacity-30" title="重做">
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* 底部 4 轨时间轴 + 渲染队列 */}
          <div className="h-52 shrink-0 bg-[#0b1120] border border-slate-800 rounded-xl p-2.5 flex flex-col gap-1.5 overflow-y-auto text-[11px]">
            <div className="flex items-center justify-between text-slate-400">
              <span className="font-semibold text-slate-200">多轨时间轴（参考视频 / 动效 / 字幕 / 音效）</span>
              <span className="text-[10px]">点击动效块即可在右侧编辑参数与时间码</span>
            </div>

            {/* 轨1：参考视频 */}
            <div className="flex items-center gap-2">
              <span className="w-16 text-slate-400 shrink-0">视频轨</span>
              <div className="flex-1 h-6 bg-slate-950 rounded border border-slate-800 px-2 flex items-center text-slate-400">
                {activeProj?.reference_video_path ? `参考视频：${activeProj.reference_video_path}` : '未加载参考视频（纯透明动效层模式）'}
              </div>
            </div>

            {/* 轨2：动效轨 */}
            <div className="flex items-center gap-2">
              <span className="w-16 text-cyan-400 shrink-0">动效轨 ({doc.cards.length})</span>
              <div className="flex-1 h-8 bg-slate-950 rounded border border-slate-800 relative overflow-hidden">
                {doc.cards.map((c) => {
                  const left = `${(c.start / totalDur) * 100}%`;
                  const width = `${Math.max(4, ((c.end - c.start) / totalDur) * 100)}%`;
                  const active = c.id === selectedCardId;
                  return (
                    <button
                      key={c.id}
                      onClick={() => {
                        setSelectedCardId(c.id);
                        setCurrentTime(c.start);
                        setRightTab('props');
                      }}
                      style={{ left, width }}
                      className={`absolute top-1 bottom-1 rounded px-1.5 text-[10px] truncate transition border ${
                        active
                          ? 'bg-cyan-500/35 border-cyan-300 text-white z-10'
                          : 'bg-indigo-500/25 border-indigo-400/40 text-indigo-200 hover:bg-indigo-500/40'
                      }`}
                      title={`${c.kind} (${c.start}s - ${c.end}s)`}
                    >
                      {c.kind}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 轨3：字幕轨 */}
            <div className="flex items-center gap-2">
              <span className="w-16 text-emerald-400 shrink-0">字幕轨 ({doc.srt?.length || 0})</span>
              <div className="flex-1 h-6 bg-slate-950 rounded border border-slate-800 relative overflow-hidden">
                {(doc.srt || []).map((s, idx) => (
                  <div
                    key={idx}
                    style={{ left: `${(s.start / totalDur) * 100}%`, width: `${Math.max(2, ((s.end - s.start) / totalDur) * 100)}%` }}
                    className="absolute top-1 bottom-1 bg-emerald-500/25 border border-emerald-500/40 rounded px-1 text-[9px] text-emerald-200 truncate"
                    title={s.text}
                  >
                    {s.text}
                  </div>
                ))}
              </div>
            </div>

            {/* 轨4：音效轨 */}
            <div className="flex items-center gap-2">
              <span className="w-16 text-amber-400 shrink-0">音效轨</span>
              <div className="flex-1 h-6 bg-slate-950 rounded border border-slate-800 relative overflow-hidden">
                {doc.cards
                  .filter((c) => c.params?.sfx)
                  .map((c) => (
                    <div
                      key={c.id}
                      style={{ left: `${(c.start / totalDur) * 100}%`, width: '6%' }}
                      className="absolute top-1 bottom-1 bg-amber-500/25 border border-amber-500/40 rounded px-1 text-[9px] text-amber-200 truncate"
                    >
                      🔊 {c.params.sfx}
                    </div>
                  ))}
              </div>
            </div>

            {/* 最近渲染任务状态条 */}
            {renderJobs.length > 0 && (
              <div className="mt-1 pt-1.5 border-t border-slate-800 space-y-1">
                {renderJobs.slice(0, 2).map((j) => {
                  const probe = j.ffprobe_json ? JSON.parse(j.ffprobe_json) : null;
                  return (
                    <div key={j.job_uid} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-slate-900/90 border border-slate-800">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                          j.state === 'completed' ? 'bg-emerald-500/20 text-emerald-300' :
                          j.state === 'running' ? 'bg-cyan-500/20 text-cyan-300' :
                          'bg-rose-500/20 text-rose-300'
                        }`}>
                          {j.state} {j.progress}%
                        </span>
                        <span className="truncate text-slate-300">{j.progress_message || j.error_message}</span>
                        {probe?.ok && (
                          <span className="text-[10px] text-emerald-300 font-mono-num shrink-0">
                            Alpha:{probe.has_alpha ? 'YES' : 'NO'} · {probe.pix_fmt} · {probe.duration_sec}s
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {j.state === 'running' && (
                          <button
                            onClick={() => api.cancelRenderJob(j.job_uid).then(() => showToast('已发送取消指令'))}
                            className="px-2 py-0.5 rounded bg-rose-600/30 text-rose-200 text-[10px]"
                          >
                            取消
                          </button>
                        )}
                        {j.state === 'completed' && j.output_mov_path && (
                          <a href={`/api/video/render-jobs/${j.job_uid}/download?fmt=mov`} className="px-2 py-0.5 rounded bg-cyan-600/30 text-cyan-200 text-[10px]">
                            下 MOV
                          </a>
                        )}
                        {j.state === 'completed' && j.output_webm_path && (
                          <a href={`/api/video/render-jobs/${j.job_uid}/download?fmt=webm`} className="px-2 py-0.5 rounded bg-indigo-600/30 text-indigo-200 text-[10px]">
                            下 WebM
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右栏：属性 / 质量检查 / 音效 / 偏好学习 / 版本 */}
        <div className="w-76 shrink-0 bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
          <div className="p-2 border-b border-slate-800 bg-[#0f172a] flex gap-1 text-[11px]">
            {[
              ['props', '属性'],
              ['lint', `检查${lintRes ? `(${lintRes.error_count})` : ''}`],
              ['sfx', '音效'],
              ['feedback', '偏好'],
              ['versions', '版本'],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setRightTab(k as any)}
                className={`flex-1 py-1 rounded font-medium ${
                  rightTab === k ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3 text-xs space-y-3">
            {rightTab === 'props' && (
              selectedCard ? (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-cyan-300">{selectedCard.kind}</div>
                      <div className="text-[10px] text-slate-500 font-mono-num">{selectedCard.id}</div>
                    </div>
                    <button
                      onClick={() => {
                        mutateDoc({ ...doc, cards: doc.cards.filter((c) => c.id !== selectedCard.id) });
                        setSelectedCardId(null);
                      }}
                      className="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400"
                      title="删除此卡片"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-[10px] text-slate-400">开始时间 (秒)</span>
                      <input
                        type="number"
                        step={0.1}
                        value={selectedCard.start}
                        onChange={(e) => updateSelectedCard({ start: Number(e.target.value) })}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 font-mono-num"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] text-slate-400">结束时间 (秒)</span>
                      <input
                        type="number"
                        step={0.1}
                        value={selectedCard.end}
                        onChange={(e) => updateSelectedCard({ end: Number(e.target.value) })}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 font-mono-num"
                      />
                    </label>
                  </div>

                  <label className="block space-y-1">
                    <span className="text-[10px] text-slate-400">绑定音效（A09）</span>
                    <select
                      value={selectedCard.params?.sfx || ''}
                      onChange={(e) => updateSelectedCard({ params: { ...selectedCard.params, sfx: e.target.value || undefined } })}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1"
                    >
                      <option value="">无音效</option>
                      {(caps?.default_sfx || []).map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {s.id} · {s.usage}
                        </option>
                      ))}
                      {(caps?.custom_sfx || []).map((s: any) => (
                        <option key={s.id} value={s.filename}>
                          [自定义] {s.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="space-y-2 pt-2 border-t border-slate-800">
                    <div className="text-[11px] font-semibold text-slate-300">卡片参数编辑（A07）</div>
                    {Object.entries(selectedCard.params || {})
                      .filter(([k]) => !['sfx', 'source_srt_index'].includes(k))
                      .map(([k, v]) => (
                        <label key={k} className="block space-y-1">
                          <span className="text-[10px] text-slate-400 font-mono-num">{k}</span>
                          <input
                            value={typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}
                            onChange={(e) =>
                              updateSelectedCard({ params: { ...selectedCard.params, [k]: e.target.value } })
                            }
                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs"
                          />
                        </label>
                      ))}
                  </div>

                  <button
                    onClick={() => handleExport('single', false)}
                    disabled={!engine?.reachable}
                    className="w-full py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] border border-slate-700 disabled:opacity-40"
                  >
                    仅导出当前单卡透明 MOV
                  </button>
                </>
              ) : (
                <div className="text-slate-500 text-center py-8">在时间轴选中一张动效卡，或从左侧模板库点击添加</div>
              )
            )}

            {rightTab === 'lint' && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200">编排质量检查（A13）</span>
                  <button onClick={handleLint} className="px-2 py-0.5 rounded bg-cyan-600/30 text-cyan-200 text-[11px]">
                    重新检查
                  </button>
                </div>
                {!lintRes ? (
                  <div className="text-slate-500">点击上方「重新检查」运行规则校验</div>
                ) : (
                  <>
                    <div className={`p-2 rounded border ${lintRes.passed ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-300'}`}>
                      {lintRes.passed ? (
                        <span className="flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> 0 项硬错误，允许导出</span>
                      ) : (
                        <span className="flex items-center gap-1"><XCircle className="w-3.5 h-3.5" /> {lintRes.error_count} 项硬错误（已阻止导出）</span>
                      )}
                    </div>
                    {(lintRes.errors || []).map((err: any, i: number) => (
                      <div key={i} className="p-2 rounded bg-rose-950/40 border border-rose-500/30 text-rose-200 text-[11px]">
                        <div className="font-mono-num text-[10px] text-rose-400">{err.rule} {err.card_id ? `· ${err.card_id}` : ''}</div>
                        <div>{err.message}</div>
                      </div>
                    ))}
                    {(lintRes.warnings || []).map((w: any, i: number) => (
                      <div key={i} className="p-2 rounded bg-amber-950/30 border border-amber-500/30 text-amber-200 text-[11px] space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-mono-num text-[10px] text-amber-400"><AlertTriangle className="w-3 h-3 inline mr-1" />{w.rule}</span>
                          {w.card_id && (
                            <button
                              onClick={() => ignoreWarningRule(w.card_id, w.rule)}
                              className="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 text-[10px]"
                            >
                              显式忽略
                            </button>
                          )}
                        </div>
                        <div>{w.message}</div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {rightTab === 'sfx' && (
              <div className="space-y-3">
                <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-amber-400" /> 自定义授权音效库（A10）
                </div>
                <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
                  <input value={sfxName} onChange={(e) => setSfxName(e.target.value)} placeholder="音效名称..." className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1" />
                  <input value={sfxLicense} onChange={(e) => setSfxLicense(e.target.value)} placeholder="授权说明（必填，如 CC0）" className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1" />
                  <input type="file" accept=".mp3,.wav,.ogg,.m4a" onChange={(e) => setSfxFile(e.target.files?.[0] || null)} className="text-[10px] text-slate-400 w-full" />
                  <button onClick={handleUploadSfx} className="w-full py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-[11px]">
                    上传并登记授权台账
                  </button>
                </div>
                <div className="space-y-1">
                  <div className="text-[11px] text-slate-400">内置 15 个默认音效（授权已核验）</div>
                  {(caps?.default_sfx || []).map((s: any) => (
                    <div key={s.id} className="p-1.5 rounded bg-slate-900/70 border border-slate-800/80 flex justify-between">
                      <span className="text-slate-200 font-mono-num">{s.id}</span>
                      <span className="text-[10px] text-slate-400 truncate max-w-[140px]">{s.license}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {rightTab === 'feedback' && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200">人工修改偏好学习（A16）</span>
                  <button onClick={handleProposeFeedback} disabled={!activeProj} className="px-2 py-0.5 rounded bg-cyan-600/30 text-cyan-200 text-[11px] disabled:opacity-40">
                    提取本次差异
                  </button>
                </div>
                <div className="text-[10px] text-slate-400">仅人工批准的规则影响后续 AI 编排，可随时撤销，绝不用于模型训练。</div>
                {feedbackRules.map((r) => (
                  <div key={r.id} className="p-2 rounded bg-slate-900 border border-slate-800 space-y-1.5">
                    <div className="text-slate-200">{r.proposed_rule}</div>
                    <div className="flex items-center justify-between text-[10px]">
                      <span className={r.status === 'approved' ? 'text-emerald-400' : r.status === 'revoked' ? 'text-slate-500' : 'text-amber-300'}>
                        状态：{r.status}
                      </span>
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
              </div>
            )}

            {rightTab === 'versions' && (
              <div className="space-y-2">
                <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-cyan-400" /> 不可变版本历史（A14）
                </div>
                {versions.map((v) => (
                  <div key={v.id} className="p-2 rounded bg-slate-900 border border-slate-800 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-slate-200 font-medium">v{v.version_no} · {v.source_type}</div>
                      <div className="text-[10px] text-slate-400 truncate">{v.note} ({v.checksum})</div>
                    </div>
                    <button
                      onClick={() =>
                        activeProj &&
                        api.restoreVideoVersion(activeProj.id, v.id).then(() => {
                          openProject(activeProj.id);
                          showToast(`✅ 已恢复到 v${v.version_no}`);
                        })
                      }
                      className="px-2 py-0.5 rounded bg-slate-800 hover:bg-cyan-600 text-[10px] text-slate-200 shrink-0"
                    >
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 许可与版权保留声明 */}
          <div className="p-2 border-t border-slate-800 bg-[#080d18] text-[10px] text-slate-500">
            动效渲染引擎：Overlay Studio v1.4.0（Copyright © 2026 Jessie Zhou · 内部使用/自改授权，不对外作为软件分发）。
          </div>
        </div>
      </div>
      )}

      {/* 新建视频工程弹窗 */}
      {newProjModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-96 bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3">
            <div className="text-sm font-bold text-slate-100">新建视频动效工程</div>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="输入视频工程标题..."
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
              autoFocus
            />
            <select
              value={newRatio}
              onChange={(e) => setNewRatio(e.target.value as any)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
            >
              <option value="16:9">16:9 横屏 (1920×1080)</option>
              <option value="9:16">9:16 竖屏 (1080×1920)</option>
            </select>
            <div className="flex justify-end gap-2">
              <button onClick={() => setNewProjModal(false)} className="px-3 py-1.5 rounded bg-slate-800 text-xs text-slate-300">
                取消
              </button>
              <button onClick={createProject} className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-xs text-white">
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 导入 SRT / 从文案提取工坊导入弹窗 */}
      {srtModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-[540px] bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3">
            <div className="text-sm font-bold text-slate-100">导入 SRT 字幕（A01）</div>
            <div className="space-y-1">
              <div className="text-[11px] text-slate-400">方式一：直接从「文案提取工坊」已有素材导入真实时间码</div>
              <select
                value={selectedContentId}
                onChange={(e) => setSelectedContentId(e.target.value ? Number(e.target.value) : '')}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
              >
                <option value="">-- 选择已提取文案的素材 --</option>
                {contents.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.id} [{c.platform}] {c.title?.slice(0, 48)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-slate-400">方式二：粘贴中英文 SRT 字幕全文（优先于方式一）</div>
              <textarea
                value={srtInput}
                onChange={(e) => setSrtInput(e.target.value)}
                rows={7}
                placeholder={'1\n00:00:00,000 --> 00:00:03,500\n今天我们用真实数据拆解一个关键现象\n\n2\n00:00:03,600 --> 00:00:07,200\n数据显示平均播放倍数达到 12.4x'}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs font-mono-num text-slate-200"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSrtModal(false)} className="px-3 py-1.5 rounded bg-slate-800 text-xs text-slate-300">
                取消
              </button>
              <button onClick={handleImportSrt} disabled={busy === 'srt'} className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-xs text-white">
                {busy === 'srt' ? '解析中...' : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
