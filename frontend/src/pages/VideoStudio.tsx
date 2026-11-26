import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bookmark,
  CheckCircle2,
  ChevronsDown,
  ChevronsUp,
  Clapperboard,
  Download,
  ExternalLink,
  Eye,
  FileJson,
  FileText,
  Film,
  History,
  Layers,
  Loader2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  ShieldAlert,
  Sliders,
  Sparkles,
  Star,
  Trash2,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  XCircle,
  ZoomIn,
  ZoomOut,
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
  layerOrder?: 'manual';
  glow?: boolean;
  breath?: boolean;
  inkColor?: string;
  fxScale?: number;
  animSpeed?: number;
  exportFps?: number;
  srt?: { start: number; end: number; text: string }[];
  cards: OverlayCard[];
}

const FEEL_TAGS: Record<string, string[]> = {
  滚动计数: ['odometer', 'stat-proof', 'ring-metric'],
  逐条落位: ['checklist', 'step-timeline', 'pin-board', 'entity-chips'],
  堆叠累积: ['waterfall-bridge', 'waffle-fill', 'growth-bars'],
  生长描画: ['growth-curve', 'rank-bars', 'donut-split', 'radar-profile'],
  对撞并置: ['versus-card'],
  翻转轮换: ['type-shift', 'chapter-bar'],
  聚散飞行: ['blur-text', 'quote-lockup'],
  扫过点亮: ['punch-pill', 'caption-track'],
  '3D 浮屏': ['terminal-3d'],
  取景重构: ['focus-card', 'ui-callout'],
  玻璃虚化: ['term-card', 'stat-proof', 'quote-lockup'],
};

interface StylePreset {
  id: string;
  name: string;
  style: Record<string, any>;
}

const ACCENT_OPTIONS = [
  { id: 'blue', label: '数据蓝', swatch: '#38bdf8' },
  { id: 'red', label: '复古红', swatch: '#f43f5e' },
  { id: 'amber', label: '砖金橙', swatch: '#f59e0b' },
  { id: 'green', label: '翡翠绿', swatch: '#10b981' },
  { id: 'purple', label: '紫罗兰', swatch: '#a855f7' },
];

const GLASS_OPTIONS = [
  { id: '', label: '关闭' },
  { id: 'light', label: '亮色' },
  { id: 'dark', label: '暗色' },
];

const SHADOW_OPTIONS = [
  { id: '', label: '无' },
  { id: 'soft', label: '柔和' },
  { id: 'crisp', label: '清晰' },
  { id: 'strong', label: '剧烈' },
];

const POSITION_OPTIONS = [
  { id: 'center', label: '居中' },
  { id: 'left', label: '左侧' },
  { id: 'right', label: '右侧' },
  { id: 'top', label: '顶部' },
  { id: 'bottom', label: '底部' },
];

const GROUP_COLORS: Record<string, string> = {
  常驻层: 'bg-sky-500/35 border-sky-400/50 text-sky-100',
  证据实证: 'bg-emerald-500/35 border-emerald-400/50 text-emerald-100',
  数据指标: 'bg-cyan-500/35 border-cyan-400/50 text-cyan-100',
  对比取舍: 'bg-amber-500/35 border-amber-400/50 text-amber-100',
  金句观点: 'bg-rose-500/35 border-rose-400/50 text-rose-100',
  步骤流程: 'bg-indigo-500/35 border-indigo-400/50 text-indigo-100',
  教程标注: 'bg-violet-500/35 border-violet-400/50 text-violet-100',
  文字进场: 'bg-fuchsia-500/35 border-fuchsia-400/50 text-fuchsia-100',
  人物锚定: 'bg-teal-500/35 border-teal-400/50 text-teal-100',
  '场景 · 运镜': 'bg-orange-500/35 border-orange-400/50 text-orange-100',
  '场景 · B-roll': 'bg-slate-600/50 border-slate-400/50 text-slate-100',
};

function fmtClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${rem}`;
}

/** G1 智能视频制作页面（完整复刻 Overlay Studio 高频编辑体验，独立回环同源驱动零源码复制） */
export default function VideoStudio({ projectId }: Props) {
  const [caps, setCaps] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [activeProj, setActiveProj] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [renderJobs, setRenderJobs] = useState<any[]>([]);
  const [contents, setContents] = useState<ContentItem[]>([]);
  const [feedbackRules, setFeedbackRules] = useState<any[]>([]);

  const [doc, setDoc] = useState<OverlayDoc>({
    version: 1,
    ratio: 'h',
    theme: 'dark',
    glow: false,
    breath: false,
    fxScale: 1,
    animSpeed: 1,
    exportFps: 30,
    cards: [],
  });
  const [undoStack, setUndoStack] = useState<OverlayDoc[]>([]);
  const [redoStack, setRedoStack] = useState<OverlayDoc[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [lintRes, setLintRes] = useState<any>(null);

  const [effectSearch, setEffectSearch] = useState('');
  const [effectGroup, setEffectGroup] = useState('全部');
  const [feelTag, setFeelTag] = useState<string | null>(null);
  const [onlyFavEffects, setOnlyFavEffects] = useState(false);
  const [editorLeftTab, setEditorLeftTab] = useState<'cards' | 'srt'>('cards');
  const [muted, setMuted] = useState(false);
  const [tlZoom, setTlZoom] = useState(1);
  const [showSafeBorder, setShowSafeBorder] = useState(true);
  const [showAvatarGuide, setShowAvatarGuide] = useState(true);
  const [exportModal, setExportModal] = useState<null | { mode: 'timeline' | 'single' }>(null);
  const [exportOpts, setExportOpts] = useState({
    fps: 30,
    includeWebm: true,
    compatibilityMode: false,
    fastPng: false,
    exportMode: 'sequence' as 'sequence' | 'stream',
    singleDuration: 6,
  });
  const jsonImportRef = useRef<HTMLInputElement | null>(null);
  const [favEffects, setFavEffects] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('gcw_fav_effects') || '["stat-proof","growth-curve","quote-lockup","blur-text","versus-card"]');
    } catch {
      return [];
    }
  });
  const [presets, setPresets] = useState<StylePreset[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('gcw_overlay_presets') || '[]');
    } catch {
      return [];
    }
  });

  const [hoverEffect, setHoverEffect] = useState<{ eff: any; top: number } | null>(null);
  const hoverIframeRef = useRef<HTMLIFrameElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const mainWaitTimerRef = useRef<number | null>(null);

  const [rightTab, setRightTab] = useState<'props' | 'lint' | 'sfx' | 'feedback' | 'versions'>('props');
  const [showSafeZone, setShowSafeZone] = useState(true);
  const [globalModal, setGlobalModal] = useState(false);
  const [replayNonce, setReplayNonce] = useState(0);

  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [viewMode, setViewMode] = useState<'editor' | 'library' | 'native'>('editor');
  const [stageScale, setStageScale] = useState(0.35);
  const [stageFit, setStageFit] = useState<{ w: number; h: number }>({ w: 640, h: 360 });
  const [dragDelta, setDragDelta] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ clientX: number; clientY: number; origX: number; origY: number } | null>(null);
  const [debouncedDoc, setDebouncedDoc] = useState<OverlayDoc>(doc);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoUploadInputRef = useRef<HTMLInputElement | null>(null);
  const stageOuterRef = useRef<HTMLDivElement | null>(null);
  const overlayIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeReady, setIframeReady] = useState(false);

  const [newProjModal, setNewProjModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newRatio, setNewRatio] = useState<'16:9' | '9:16' | '4:3'>('16:9');
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

  const toggleFav = (eid: string) => {
    setFavEffects((prev) => {
      const next = prev.includes(eid) ? prev.filter((x) => x !== eid) : [...prev, eid];
      try {
        localStorage.setItem('gcw_fav_effects', JSON.stringify(next));
      } catch {}
      return next;
    });
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
      setDoc({ version: 1, ratio: 'h', theme: 'dark', glow: false, breath: false, fxScale: 1, animSpeed: 1, exportFps: 30, cards: [] });
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
      ? { fxScale: 1, animSpeed: 1, exportFps: 30, ...JSON.parse(data.project.draft_overlay_json) }
      : {
          version: 1,
          ratio: data.project.aspect_ratio === '9:16' ? 'v' : data.project.aspect_ratio === '4:3' ? '4:3' : 'h',
          theme: 'dark',
          glow: false,
          breath: false,
          fxScale: 1,
          animSpeed: 1,
          exportFps: 30,
          cards: [],
        };
    setDoc(parsedDoc);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedCardId(parsedDoc.cards?.[0]?.id || null);
    setLintRes(data.project.lint_summary_json ? JSON.parse(data.project.lint_summary_json) : null);
    setCurrentTime(parsedDoc.cards?.[0]?.start ? Number((parsedDoc.cards[0].start + 0.4).toFixed(1)) : 0);
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

  // 保持 currentTimeRef 同步，并对 doc 做 180ms 防抖避免连续拖滑杆时频繁重载 iframe
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedDoc(doc), 180);
    return () => window.clearTimeout(t);
  }, [doc]);

  // 60fps requestAnimationFrame 丝滑播放引擎（直接驱动 iframe 内时钟，UI 进度条每 80ms 节流刷新一次）
  const totalDur = Math.max(10, (activeProj?.duration_ms || 15000) / 1000, ...doc.cards.map((c) => c.end));
  useEffect(() => {
    if (!playing) return;
    let rafId = 0;
    let lastTs = performance.now();
    let lastUiSync = lastTs;
    let t = currentTimeRef.current;

    const step = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      if (videoRef.current && !videoRef.current.paused) {
        t = videoRef.current.currentTime;
      } else {
        t = t + dt >= totalDur ? 0 : t + dt;
      }
      currentTimeRef.current = t;
      const win = overlayIframeRef.current?.contentWindow as any;
      if (win && typeof win.__setExportT === 'function') {
        try {
          win.__setExportT(t);
        } catch {}
      }
      if (now - lastUiSync >= 80) {
        lastUiSync = now;
        setCurrentTime(Number(t.toFixed(2)));
      }
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [playing, totalDur]);

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

  // 键盘快捷键：Space 播放/暂停、←/→ 微调 ±0.5s、↑/↓ 切换卡片、Ctrl+Z 撤销、Delete 删除选中卡
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => {
          const next = !p;
          if (videoRef.current) {
            if (next) videoRef.current.play().catch(() => {});
            else videoRef.current.pause();
          }
          return next;
        });
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setCurrentTime((t) => Math.max(0, Number((t - 0.5).toFixed(1))));
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setCurrentTime((t) => Math.min(totalDur, Number((t + 0.5).toFixed(1))));
      } else if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && doc.cards.length > 0) {
        e.preventDefault();
        const idx = doc.cards.findIndex((c) => c.id === selectedCardId);
        const nextIdx = e.code === 'ArrowUp' ? Math.max(0, idx - 1) : Math.min(doc.cards.length - 1, idx + 1);
        const nextCard = doc.cards[nextIdx];
        if (nextCard) {
          setSelectedCardId(nextCard.id);
          setCurrentTime(Number((nextCard.start + 0.4).toFixed(1)));
        }
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && selectedCardId) {
        e.preventDefault();
        mutateDoc({ ...doc, cards: doc.cards.filter((c) => c.id !== selectedCardId) });
        setSelectedCardId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedCardId, doc, totalDur, undoStack]);

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
      setDoc({ fxScale: 1, animSpeed: 1, exportFps: 30, ...r.doc });
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

  const handleExport = async (mode: 'timeline' | 'single', opts = exportOpts) => {
    if (!activeProj) return;
    setBusy('export');
    setExportModal(null);
    try {
      await api.patchVideoProject(activeProj.id, { draft_overlay_json: JSON.stringify(doc) });
      const r = await api.createRenderJob({
        video_project_id: activeProj.id,
        mode,
        effect_id: mode === 'single' ? selectedCard?.kind || 'quote-lockup' : undefined,
        single_params: mode === 'single' ? selectedCard?.params || {} : undefined,
        include_webm: opts.includeWebm,
        fps: opts.fps || doc.exportFps || activeProj.fps || 30,
        duration_sec:
          mode === 'single'
            ? Math.max(1, Number(opts.singleDuration || 6))
            : Math.max(4, Math.min(120, totalDur)),
        compatibility_mode: opts.compatibilityMode,
        fast_png: opts.fastPng,
        export_mode: opts.exportMode,
      });
      setActiveJobUid(r.job_uid);
      showToast(mode === 'single' ? '🎬 已发起单卡透明 MOV 导出...' : '🎬 已发起整条时间轴透明视频导出...');
    } catch (e: any) {
      showToast('导出受阻：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleLoadDemo = async () => {
    setBusy('demo');
    try {
      const demo = await api.videoDemo();
      let proj = activeProj;
      if (!proj) {
        proj = await api.createVideoProject({ project_id: projectId, title: 'Overlay Studio 官方多轨示例', aspect_ratio: '16:9' });
        await loadAll(proj.id);
      }
      const nextDoc: OverlayDoc = { fxScale: 1, animSpeed: 1, exportFps: 30, ...demo.doc };
      mutateDoc(nextDoc);
      setSelectedCardId(nextDoc.cards?.[0]?.id || null);
      setCurrentTime(1.5);
      setViewMode('editor');
      showToast(`🎬 已载入官方多轨示例（${nextDoc.cards?.length || 0} 张动效卡 / ${demo.line_count} 句字幕）`);
    } catch (e: any) {
      showToast('载入示例失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleExportJsonFile = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeProj?.title || 'overlay'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('✅ 已导出 overlay.json 编排文件');
  };

  const moveCardLayer = (dir: 'up' | 'down' | 'top' | 'bottom') => {
    if (!selectedCard) return;
    const idx = doc.cards.findIndex((c) => c.id === selectedCard.id);
    if (idx < 0) return;
    const arr = [...doc.cards];
    const [item] = arr.splice(idx, 1);
    if (dir === 'up') arr.splice(Math.min(arr.length, idx + 1), 0, item);
    else if (dir === 'down') arr.splice(Math.max(0, idx - 1), 0, item);
    else if (dir === 'top') arr.push(item);
    else arr.unshift(item);
    mutateDoc({ ...doc, layerOrder: 'manual', cards: arr });
  };

  const handleReplay = () => {
    const startT = selectedCard ? selectedCard.start : 0;
    setCurrentTime(startT);
    setReplayNonce((n) => n + 1);
    setPlaying(true);
    if (videoRef.current) {
      videoRef.current.currentTime = startT;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleProposeFeedback = async () => {
    if (!activeProj) return;
    try {
      await api.createVideoFeedback(activeProj.id, {});
      setFeedbackRules(await api.listVideoFeedbackRules(projectId));
      setRightTab('feedback');
      showToast('✅ 已生成差异偏好候选规则（需您手动批准后才生效）');
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
      setCaps(await api.videoCapabilities());
      showToast('✅ 自定义授权音效已入库');
    } catch (e: any) {
      showToast('上传失败：' + e.message);
    }
  };

  const effects: any[] = caps?.effects || [];
  const effectById = useMemo(() => Object.fromEntries(effects.map((e) => [e.id, e])), [effects]);
  const groups = useMemo(() => ['全部', ...Array.from(new Set(effects.map((e) => e.group)))], [effects]);
  const filteredEffects = useMemo(
    () =>
      effects.filter((e) => {
        if (onlyFavEffects && !favEffects.includes(e.id)) return false;
        if (feelTag && !(FEEL_TAGS[feelTag] || []).includes(e.id)) return false;
        if (effectGroup !== '全部' && e.group !== effectGroup) return false;
        if (effectSearch.trim()) {
          const q = effectSearch.toLowerCase();
          return e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q);
        }
        return true;
      }),
    [effects, effectGroup, effectSearch, onlyFavEffects, favEffects, feelTag]
  );

  const selectedCard = useMemo(() => doc.cards.find((c) => c.id === selectedCardId) || null, [doc.cards, selectedCardId]);
  const selectedEffectMeta = selectedCard ? effectById[selectedCard.kind] : null;

  const addEffectCard = (eff: any, atTime?: number, cloneParams?: Record<string, any>) => {
    const start = Number((atTime ?? currentTime).toFixed(1));
    const end = Number((start + 4.0).toFixed(1));
    const cid = `card-${Date.now().toString(36).slice(-4)}`;
    const newCard: OverlayCard = {
      id: cid,
      kind: eff.id,
      start,
      end,
      params: cloneParams ? { ...cloneParams } : {},
    };
    mutateDoc({ ...doc, cards: [...doc.cards, newCard] });
    setSelectedCardId(cid);
    setCurrentTime(Number((start + 0.6).toFixed(1)));
    setRightTab('props');
  };

  const updateSelectedCard = (patch: Partial<OverlayCard>) => {
    if (!selectedCard) return;
    mutateDoc({
      ...doc,
      cards: doc.cards.map((c) => (c.id === selectedCard.id ? { ...c, ...patch } : c)),
    });
  };

  const updateSelectedParam = (key: string, val: any) => {
    if (!selectedCard) return;
    const nextParams = { ...(selectedCard.params || {}) };
    if (val === '' || val === undefined) delete nextParams[key];
    else nextParams[key] = val;
    updateSelectedCard({ params: nextParams });
  };

  const saveCurrentStylePreset = () => {
    if (!selectedCard) return;
    const name = window.prompt('输入样式预设名称（如：暗底数据蓝+玻璃）');
    if (!name?.trim()) return;
    const styleKeys = ['theme', 'accent', 'glass', 'glassAlpha', 'shadow', 'scale', 'speed'];
    const style: Record<string, any> = {};
    for (const k of styleKeys) {
      if (selectedCard.params?.[k] !== undefined) style[k] = selectedCard.params[k];
    }
    const next = [{ id: Date.now().toString(36), name: name.trim(), style }, ...presets].slice(0, 12);
    setPresets(next);
    try {
      localStorage.setItem('gcw_overlay_presets', JSON.stringify(next));
    } catch {}
    showToast(`✅ 已保存样式预设「${name.trim()}」`);
  };

  const applyStylePreset = (p: StylePreset) => {
    if (!selectedCard) return;
    updateSelectedCard({ params: { ...(selectedCard.params || {}), ...p.style } });
    showToast(`已套用预设「${p.name}」`);
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

  // 自适应真实 1920x1080 / 1080x1920 / 1440x1080 画布缩放
  const engine = caps?.engine;
  const isVertical = activeProj?.aspect_ratio === '9:16';
  const is43 = activeProj?.aspect_ratio === '4:3';
  const stageW = isVertical ? 1080 : is43 ? 1440 : 1920;
  const stageH = isVertical ? 1920 : 1080;

  useEffect(() => {
    const el = stageOuterRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const availW = Math.max(120, rect.width - 12);
      const availH = Math.max(120, rect.height - 12);
      const scale = Math.min(availW / stageW, availH / stageH);
      setStageScale(scale);
      setStageFit({ w: Math.floor(stageW * scale), h: Math.floor(stageH * scale) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageW, stageH, viewMode]);

  const handleSwitchRatio = async (ratio: '16:9' | '9:16' | '4:3') => {
    const ratioCode = ratio === '9:16' ? 'v' : ratio === '4:3' ? '4:3' : 'h';
    setDoc((prev) => ({ ...prev, ratio: ratioCode }));
    if (activeProj) {
      setActiveProj({ ...activeProj, aspect_ratio: ratio });
      await api.patchVideoProject(activeProj.id, { aspect_ratio: ratio }).catch(() => {});
    }
  };

  const overlayIframeSrc = useMemo(() => {
    if (!engine?.reachable || debouncedDoc.cards.length === 0) return '';
    const ratioCode = isVertical ? 'v' : is43 ? '4:3' : 'h';
    const payload: Record<string, any> = {
      version: 1,
      ratio: ratioCode,
      theme: debouncedDoc.theme || 'dark',
      layerOrder: debouncedDoc.layerOrder,
      glow: !!debouncedDoc.glow,
      breath: !!debouncedDoc.breath,
      inkColor: debouncedDoc.inkColor || undefined,
      cards: debouncedDoc.cards.map((c) => {
        const cleanParams = { ...(c.params || {}) };
        // 防御清洗：terminal-3d / type-shift 期望 lines 为字符串，避免数组触发 lines.split is not a function
        if ((c.kind === 'terminal-3d' || c.kind === 'type-shift') && cleanParams.lines !== undefined && typeof cleanParams.lines !== 'string') {
          delete cleanParams.lines;
        }
        return {
          id: c.id,
          kind: c.kind,
          start: c.start,
          end: c.end,
          params: cleanParams,
        };
      }),
    };
    const encoded = encodeURIComponent(JSON.stringify(payload));
    const fx = Number(debouncedDoc.fxScale || 1).toFixed(2);
    const spd = Number(debouncedDoc.animSpeed || 1).toFixed(2);
    return `/overlay-engine/?export=1&ratio=${ratioCode}&fx=${fx}&spd=${spd}&r=${replayNonce}&doc=${encoded}`;
  }, [engine?.reachable, isVertical, is43, debouncedDoc, replayNonce]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) window.cancelAnimationFrame(hoverTimerRef.current);
      if (mainWaitTimerRef.current) window.clearInterval(mainWaitTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!hoverEffect && hoverTimerRef.current) {
      window.cancelAnimationFrame(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, [hoverEffect]);

  const bootHoverPreview = () => {
    if (hoverTimerRef.current) {
      window.cancelAnimationFrame(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    let waited = 0;
    let t = 0.2;
    let started = false;
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      const win = hoverIframeRef.current?.contentWindow as any;
      if (!win) return;
      if (!started) {
        if (typeof win.__startExport === 'function' && typeof win.__setExportT === 'function') {
          try {
            win.__startExport();
            win.__setExportT(t);
            started = true;
          } catch {}
        } else {
          waited += dt * 1000;
          if (waited > 6000) return;
        }
      } else {
        try {
          t = t >= 4.2 ? 0.1 : t + dt;
          win.__setExportT(t);
        } catch {
          return;
        }
      }
      hoverTimerRef.current = window.requestAnimationFrame(tick);
    };
    hoverTimerRef.current = window.requestAnimationFrame(tick);
  };

  const bootMainOverlay = () => {
    if (mainWaitTimerRef.current) {
      window.clearInterval(mainWaitTimerRef.current);
      mainWaitTimerRef.current = null;
    }
    let waited = 0;
    mainWaitTimerRef.current = window.setInterval(() => {
      const win = overlayIframeRef.current?.contentWindow as any;
      if (win && typeof win.__startExport === 'function' && typeof win.__setExportT === 'function') {
        try {
          win.__startExport();
          win.__setExportT(currentTimeRef.current);
          setIframeReady(true);
          setDragDelta(null);
        } catch {}
        if (mainWaitTimerRef.current) {
          window.clearInterval(mainWaitTimerRef.current);
          mainWaitTimerRef.current = null;
        }
        return;
      }
      waited += 60;
      if (waited > 6000 && mainWaitTimerRef.current) {
        window.clearInterval(mainWaitTimerRef.current);
        mainWaitTimerRef.current = null;
      }
    }, 60);
  };

  useEffect(() => {
    const win = overlayIframeRef.current?.contentWindow as any;
    if (iframeReady && win && typeof win.__setExportT === 'function') {
      try {
        win.__setExportT(currentTime);
      } catch {}
    }
  }, [currentTime, iframeReady]);

  const activeSubtitle = (doc.srt || []).find((s) => currentTime >= s.start && currentTime <= s.end);
  const layoutKey = selectedEffectMeta?.layout_mode === 'side' ? 'side' : 'position';

  return (
    <div className="h-full flex flex-col gap-2 overflow-hidden">
      {/* 隐藏的视频上传 input，供左侧「导入视频」与顶部共用 */}
      <input
        ref={videoUploadInputRef}
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
          e.target.value = '';
        }}
      />

      {/* 隐藏的工程 JSON 导入 input */}
      <input
        ref={jsonImportRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const parsed = JSON.parse(await f.text());
            if (!Array.isArray(parsed.cards)) throw new Error('JSON 缺少 cards 数组');
            mutateDoc({ version: 1, fxScale: 1, animSpeed: 1, exportFps: 30, ...parsed });
            setSelectedCardId(parsed.cards[0]?.id || null);
            showToast(`✅ 已导入工程 JSON（${parsed.cards.length} 张动效卡）`);
          } catch (err: any) {
            showToast('导入 JSON 失败：' + err.message);
          }
          e.target.value = '';
        }}
      />

      {/* 顶部工具栏（100% 对标 5188：编辑台 / 效果库 / 全局设置 / 示例 / 播放归零声音 / 导出弹窗） */}
      <div className="bg-[#0b1120] border border-slate-800 rounded-xl px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Clapperboard className="w-4 h-4 text-cyan-400 shrink-0" />
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-[11px] shrink-0">
            <button
              onClick={() => setViewMode('editor')}
              className={`px-2.5 py-1 font-medium ${viewMode === 'editor' ? 'bg-orange-600 text-white' : 'bg-slate-900 text-slate-300 hover:text-white'}`}
            >
              编辑台
            </button>
            <button
              onClick={() => setViewMode('library')}
              className={`px-2.5 py-1 font-medium ${viewMode === 'library' ? 'bg-orange-600 text-white' : 'bg-slate-900 text-slate-300 hover:text-white'}`}
            >
              效果库
            </button>
            {engine?.reachable && (
              <button
                onClick={() => setViewMode('native')}
                className={`px-2 py-1 ${viewMode === 'native' ? 'bg-cyan-600/30 text-cyan-200' : 'bg-slate-900 text-slate-400 hover:text-slate-200'}`}
              >
                原生界面
              </button>
            )}
          </div>
          <select
            value={activeProj?.id || ''}
            onChange={(e) => e.target.value && openProject(Number(e.target.value))}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 max-w-[160px]"
          >
            {projects.length === 0 && <option value="">暂无工程</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <button onClick={() => setNewProjModal(true)} className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> 新建
          </button>
          <button
            onClick={handleLoadDemo}
            disabled={busy === 'demo'}
            className="px-2 py-1 rounded-lg bg-indigo-600/25 hover:bg-indigo-600/40 border border-indigo-500/40 text-xs text-indigo-200 flex items-center gap-1"
            title="一键载入官方 28s / 17 卡多轨示例"
          >
            🎬 示例
          </button>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setGlobalModal(true)}
            disabled={!activeProj}
            className="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1 disabled:opacity-40"
          >
            <Sliders className="w-3.5 h-3.5 text-cyan-400" /> 全局设置
          </button>
          {viewMode === 'editor' ? (
            <>
              <button
                onClick={() => {
                  setCurrentTime(0);
                  if (videoRef.current) videoRef.current.currentTime = 0;
                }}
                className="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-300"
                title="播放头归零"
              >
                归零
              </button>
              <button
                onClick={() => {
                  setMuted((m) => {
                    if (videoRef.current) videoRef.current.muted = !m;
                    return !m;
                  });
                }}
                className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300"
                title={muted ? '取消静音' : '静音参考视频'}
              >
                {muted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5 text-cyan-400" />}
              </button>
            </>
          ) : (
            <button onClick={handleReplay} disabled={!activeProj} className="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1 disabled:opacity-40">
              <RotateCcw className="w-3.5 h-3.5 text-amber-300" /> 重放动画
            </button>
          )}
          <button
            onClick={() => setShowSafeZone((s) => !s)}
            className={`px-2 py-1 rounded-lg border text-xs flex items-center gap-1 ${
              showSafeZone ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200' : 'bg-slate-900 border-slate-700 text-slate-400'
            }`}
          >
            <Eye className="w-3.5 h-3.5" /> 安全区
          </button>
          {/* 16:9 / 9:16 / 4:3 一键画幅胶囊切换 */}
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-[11px] shrink-0">
            {(['16:9', '9:16', '4:3'] as const).map((r) => (
              <button
                key={r}
                onClick={() => handleSwitchRatio(r)}
                className={`px-2 py-1 font-mono-num ${
                  (activeProj?.aspect_ratio || '16:9') === r
                    ? 'bg-cyan-600/35 text-cyan-200 font-semibold'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                }`}
                title={r === '16:9' ? '横屏 1920×1080' : r === '9:16' ? '竖屏 1080×1920' : '4:3 1440×1080'}
              >
                {r}
              </button>
            ))}
          </div>
          <button onClick={() => setSrtModal(true)} disabled={!activeProj} className="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1 disabled:opacity-40">
            <FileText className="w-3.5 h-3.5 text-cyan-400" /> SRT
          </button>
          <button onClick={() => handleCompile(true)} disabled={!activeProj || busy === 'compile'} className="px-2 py-1 rounded-lg bg-cyan-600/25 hover:bg-cyan-600/40 border border-cyan-500/50 text-xs text-cyan-200 flex items-center gap-1 disabled:opacity-40">
            {busy === 'compile' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} AI编排
          </button>
          <button onClick={handleSaveVersion} disabled={!activeProj || busy === 'save'} className="px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1 disabled:opacity-40">
            <Save className="w-3.5 h-3.5" /> 保存工程
          </button>
          <button
            onClick={() => setExportModal({ mode: viewMode === 'library' ? 'single' : 'timeline' })}
            disabled={!activeProj || busy === 'export' || !engine?.reachable}
            className="px-2.5 py-1 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-40"
          >
            <Download className="w-3.5 h-3.5" /> {viewMode === 'library' ? '导出单卡' : '导出透明 MOV'}
          </button>
          {engine?.reachable && (
            <a href="/overlay-engine/" target="_blank" rel="noopener noreferrer" className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-400 hover:text-cyan-300" title="独立窗口打开原生 Overlay Studio">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {toast && (
        <div className="px-3 py-1 rounded-lg bg-cyan-500/15 border border-cyan-500/35 text-cyan-200 text-xs">
          {toast}
        </div>
      )}

      {/* 三栏主工作区 或 原生完整编辑器 */}
      {viewMode === 'native' && engine?.reachable ? (
        <div className="flex-1 bg-[#0b1120] border border-slate-800 rounded-xl overflow-hidden flex flex-col">
          <iframe src="/overlay-engine/" title="Overlay Studio 原生完整编辑器" className="w-full flex-1 border-0 bg-[#060a12]" />
        </div>
      ) : (
        <div className="flex-1 flex gap-2.5 min-h-0 overflow-hidden">
          {/* 左栏：编辑台（卡片/字幕稿双页签 + JSON 导入导出） 或 效果库（25卡缩略图 + 11手感标签 + 收藏） */}
          <div className="w-72 shrink-0 bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden relative">
            {viewMode === 'editor' ? (
              <>
                <div className="p-2 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between gap-1">
                  <div className="flex gap-1 text-xs flex-1">
                    <button
                      onClick={() => setEditorLeftTab('cards')}
                      className={`flex-1 py-1 rounded font-medium ${editorLeftTab === 'cards' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      卡片 ({doc.cards.length})
                    </button>
                    <button
                      onClick={() => setEditorLeftTab('srt')}
                      className={`flex-1 py-1 rounded font-medium ${editorLeftTab === 'srt' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      字幕稿 ({doc.srt?.length || 0})
                    </button>
                  </div>
                  {editorLeftTab === 'cards' && doc.cards.length > 0 && (
                    <button
                      onClick={() => {
                        if (window.confirm('清空当前时间轴全部卡片？')) {
                          mutateDoc({ ...doc, cards: [] });
                          setSelectedCardId(null);
                        }
                      }}
                      className="px-1.5 py-1 rounded bg-slate-900 hover:bg-rose-500/20 text-[10px] text-slate-400 hover:text-rose-300"
                    >
                      清空
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                  {editorLeftTab === 'cards' ? (
                    <>
                      <button
                        onClick={() => setViewMode('library')}
                        className="w-full py-1.5 mb-1 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/35 border border-cyan-500/40 text-cyan-200 text-xs flex items-center justify-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" /> 去效果库挑选 25 种动效卡
                      </button>
                      {doc.cards.map((c, idx) => (
                        <div
                          key={c.id}
                          onClick={() => {
                            setSelectedCardId(c.id);
                            setCurrentTime(Number((c.start + 0.4).toFixed(1)));
                            setRightTab('props');
                          }}
                          className={`p-2 rounded-lg border cursor-pointer transition text-xs ${
                            c.id === selectedCardId
                              ? 'bg-orange-500/15 border-orange-500/60 text-white'
                              : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:bg-slate-800'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium truncate">
                              #{idx + 1} {effectById[c.kind]?.name || c.kind}
                            </span>
                            <span className="font-mono-num text-[10px] text-slate-400 shrink-0">
                              {c.start}s–{c.end}s
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400 truncate mt-0.5 font-mono-num">{c.kind}</div>
                        </div>
                      ))}
                      {doc.cards.length === 0 && (
                        <div className="text-center text-[11px] text-slate-500 py-8">
                          时间轴暂无卡片，可点击顶栏「🎬 示例」或切去「效果库」添加
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => setSrtModal(true)}
                        disabled={!activeProj}
                        className="w-full py-1.5 mb-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-cyan-300"
                      >
                        {doc.srt?.length ? '换 SRT / 重新导入字幕' : '导入 SRT / 从文案工坊导入'}
                      </button>
                      {(doc.srt || []).map((s, idx) => (
                        <div
                          key={idx}
                          onClick={() => setCurrentTime(s.start)}
                          className="p-2 rounded bg-slate-900/70 hover:bg-slate-800 border border-slate-800 cursor-pointer text-[11px]"
                        >
                          <div className="font-mono-num text-[10px] text-cyan-400">
                            {fmtClock(s.start)} → {fmtClock(s.end)}
                          </div>
                          <div className="text-slate-200 mt-0.5">{s.text}</div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="p-2.5 border-b border-slate-800 bg-[#0f172a] space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                    <span className="flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-cyan-400" /> 效果库 ({filteredEffects.length}/{effects.length})
                    </span>
                    <button
                      onClick={() => setOnlyFavEffects((v) => !v)}
                      className={`px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 border ${
                        onlyFavEffects ? 'bg-amber-500/20 border-amber-400/50 text-amber-300' : 'bg-slate-900 border-slate-700 text-slate-400'
                      }`}
                    >
                      <Star className="w-3 h-3" /> 收藏
                    </button>
                  </div>
                  <input
                    value={effectSearch}
                    onChange={(e) => setEffectSearch(e.target.value)}
                    placeholder="搜卡片名字 / 用途 / 手感，如 数字..."
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                  />
                  {/* 11 个手感过滤标签（100% 复刻 5188 效果库） */}
                  <div className="flex flex-wrap gap-1">
                    {Object.keys(FEEL_TAGS).map((tag) => (
                      <button
                        key={tag}
                        onClick={() => setFeelTag(feelTag === tag ? null : tag)}
                        className={`px-1.5 py-0.5 rounded text-[9px] border ${
                          feelTag === tag ? 'bg-orange-600 border-orange-400 text-white' : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  <select
                    value={effectGroup}
                    onChange={(e) => setEffectGroup(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200"
                  >
                    {groups.map((g) => (
                      <option key={g} value={g}>
                        浏览范围：{g}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex-1 overflow-y-auto p-2 grid grid-cols-2 gap-1.5 content-start">
                  {filteredEffects.map((e) => {
                    const isFav = favEffects.includes(e.id);
                    return (
                      <div
                        key={e.id}
                        onClick={() => activeProj && addEffectCard(e)}
                        onMouseEnter={(ev) => {
                          const rect = ev.currentTarget.getBoundingClientRect();
                          setHoverEffect({ eff: e, top: Math.max(80, Math.min(window.innerHeight - 280, rect.top - 20)) });
                        }}
                        onMouseLeave={() => setHoverEffect(null)}
                        className={`text-left rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-slate-800 hover:border-cyan-400/60 transition overflow-hidden flex flex-col cursor-pointer group ${
                          !activeProj ? 'opacity-40 pointer-events-none' : ''
                        }`}
                      >
                        <div className="w-full aspect-video bg-[#070c16] border-b border-slate-800/80 overflow-hidden relative flex items-center justify-center">
                          {e.thumb_url ? (
                            <img src={e.thumb_url} alt={e.name} loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition duration-200" />
                          ) : (
                            <span className="text-[10px] text-slate-600 font-mono-num">{e.id}</span>
                          )}
                          <button
                            onClick={(ev) => {
                              ev.stopPropagation();
                              toggleFav(e.id);
                            }}
                            className={`absolute top-1 left-1 p-0.5 rounded bg-black/60 ${isFav ? 'text-amber-400' : 'text-slate-500 opacity-0 group-hover:opacity-100'}`}
                          >
                            <Star className="w-3 h-3" fill={isFav ? 'currentColor' : 'none'} />
                          </button>
                        </div>
                        <div className="p-1.5">
                          <div className="text-[11px] font-medium text-slate-100 truncate">{e.name}</div>
                          <div className="text-[9px] text-slate-400 truncate mt-0.5">{e.desc}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* 左侧底部快捷操控区（含 JSON 导入导出 + 重播 + 导入视频 + 导出单卡 + 缩放/速度） */}
            <div className="p-2.5 border-t border-slate-800 bg-[#0d1424] space-y-2 text-xs shrink-0">
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={() => jsonImportRef.current?.click()} className="py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] text-slate-300 flex items-center justify-center gap-1">
                  <FileJson className="w-3 h-3 text-cyan-400" /> 打开JSON
                </button>
                <button onClick={handleExportJsonFile} className="py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] text-slate-300 flex items-center justify-center gap-1">
                  <Download className="w-3 h-3 text-emerald-400" /> 导出JSON
                </button>
              </div>
              <button
                onClick={handleReplay}
                disabled={!activeProj}
                className="w-full py-1.5 rounded-lg bg-slate-100 hover:bg-white text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                <Play className="w-3.5 h-3.5 fill-current" /> 重播动画
              </button>
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={() => videoUploadInputRef.current?.click()} disabled={!activeProj} className="py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 flex items-center justify-center gap-1 disabled:opacity-40">
                  <Upload className="w-3 h-3 text-cyan-400" /> 导入视频
                </button>
                <button onClick={() => setExportModal({ mode: 'single' })} disabled={!activeProj || !selectedCard || !engine?.reachable} className="py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 flex items-center justify-center gap-1 disabled:opacity-40">
                  <Download className="w-3 h-3 text-amber-400" /> 导出单卡
                </button>
              </div>
              <div className="space-y-1 pt-0.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400">特效整体大小</span>
                  <span className="font-mono-num text-cyan-300">{Math.round((doc.fxScale || 1) * 100)}%</span>
                </div>
                <input type="range" min={0.5} max={1.8} step={0.05} value={doc.fxScale || 1} onChange={(e) => setDoc({ ...doc, fxScale: Number(e.target.value) })} className="w-full accent-cyan-400 h-1" />
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400">动画速度</span>
                  <span className="font-mono-num text-cyan-300">{Number(doc.animSpeed || 1).toFixed(2)}x</span>
                </div>
                <input type="range" min={0.5} max={2.0} step={0.05} value={doc.animSpeed || 1} onChange={(e) => setDoc({ ...doc, animSpeed: Number(e.target.value) })} className="w-full accent-cyan-400 h-1" />
              </div>
            </div>

            {/* 悬停实时动态小窗预览 */}
            {hoverEffect && engine?.reachable && (
              <div
                style={{ top: `${hoverEffect.top}px` }}
                className="fixed left-[530px] z-50 w-[384px] rounded-xl bg-[#0b1120] border border-cyan-500/60 shadow-2xl shadow-black/80 overflow-hidden pointer-events-none"
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
                    onLoad={bootHoverPreview}
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

          {/* 中栏：主舞台画布（带 SAFE 人物安全区） + 增强版多轨时间轴 */}
          <div className="flex-1 flex flex-col gap-2 min-w-0 overflow-hidden">
            <div className="flex-1 bg-[#0b1120] border border-slate-800 rounded-xl p-2 flex flex-col min-h-0">
              <div
                ref={stageOuterRef}
                className="flex-1 flex items-center justify-center bg-[#060a12] rounded-lg border border-slate-800/80 relative overflow-hidden min-h-[240px]"
              >
                <div
                  style={{ width: `${stageFit.w}px`, height: `${stageFit.h}px` }}
                  className="relative bg-[#090d16] border border-slate-700/80 overflow-hidden flex items-center justify-center shadow-2xl"
                >
                  {activeProj?.reference_video_path ? (
                    <video
                      ref={videoRef}
                      src={`/api/video/projects/${activeProj.id}/reference-video`}
                      className="w-full h-full object-contain"
                      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    />
                  ) : (
                    !showSafeZone && (
                      <div className="text-center text-slate-600 text-xs space-y-1 p-4 select-none">
                        <Film className="w-7 h-7 mx-auto opacity-40" />
                        <div>{doc.cards.length > 0 ? '' : activeProj ? '点击左侧 25 种动效卡即可实时渲染真实动画' : '请先新建或选择一个视频工程'}</div>
                      </div>
                    )
                  )}

                  {/* SAFE 人物安全区剪影参考线（横屏居中 9:16 框；竖屏直接贴合全画幅） */}
                  {showSafeZone && (showSafeBorder || showAvatarGuide) && (
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center select-none">
                      <div
                        className={`${isVertical ? 'w-[92%] h-[92%]' : 'h-[92%] aspect-[9/16]'} rounded-sm relative flex flex-col items-center justify-end overflow-hidden ${
                          showSafeBorder ? 'border border-slate-700/50' : ''
                        }`}
                      >
                        {showSafeBorder && <span className="absolute top-2 text-[10px] tracking-[0.25em] text-slate-500 font-mono-num">SAFE</span>}
                        {showAvatarGuide && (
                          <>
                            <div className="w-[34%] aspect-square rounded-full bg-slate-700/20 mb-2" />
                            <div className="w-[74%] h-[54%] rounded-t-[48%] bg-slate-700/20" />
                            <span className="absolute bottom-2 text-[10px] text-slate-500">人物安全区</span>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 同源真实 Overlay Studio 透明动效渲染层（不重建 iframe + 暗底零白光 + 画布直接鼠标拖拽） */}
                  {overlayIframeSrc && (
                    <div
                      className={`absolute inset-0 overflow-hidden flex items-center justify-center ${
                        selectedCard ? 'cursor-grab active:cursor-grabbing' : 'pointer-events-none'
                      }`}
                      onPointerDown={(e) => {
                        if (!selectedCard) return;
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragStartRef.current = {
                          clientX: e.clientX,
                          clientY: e.clientY,
                          origX: Number(selectedCard.params?.offsetX || 0),
                          origY: Number(selectedCard.params?.offsetY || 0),
                        };
                        setDragDelta({ x: 0, y: 0 });
                      }}
                      onPointerMove={(e) => {
                        if (!dragStartRef.current) return;
                        const dx = e.clientX - dragStartRef.current.clientX;
                        const dy = e.clientY - dragStartRef.current.clientY;
                        setDragDelta({ x: dx, y: dy });
                      }}
                      onPointerUp={(e) => {
                        if (!dragStartRef.current || !selectedCard) return;
                        const dxStage = Math.round((e.clientX - dragStartRef.current.clientX) / Math.max(0.1, stageScale));
                        const dyStage = Math.round((e.clientY - dragStartRef.current.clientY) / Math.max(0.1, stageScale));
                        const nextX = Math.max(-600, Math.min(600, dragStartRef.current.origX + dxStage));
                        const nextY = Math.max(-450, Math.min(450, dragStartRef.current.origY + dyStage));
                        dragStartRef.current = null;
                        if (dxStage !== 0 || dyStage !== 0) {
                          setIframeReady(false);
                          updateSelectedCard({
                            params: { ...(selectedCard.params || {}), offsetX: nextX, offsetY: nextY },
                          });
                        } else {
                          setDragDelta(null);
                        }
                      }}
                    >
                      <iframe
                        ref={overlayIframeRef}
                        src={overlayIframeSrc}
                        title="Overlay Studio 实时真动效画布"
                        allowTransparency={true}
                        onLoad={bootMainOverlay}
                        style={{
                          width: `${stageW}px`,
                          height: `${stageH}px`,
                          transform: `translate(${dragDelta?.x || 0}px, ${dragDelta?.y || 0}px) scale(${stageScale})`,
                          transformOrigin: 'center center',
                          border: 0,
                          background: 'transparent',
                          colorScheme: 'dark',
                          opacity: iframeReady ? 1 : 0,
                          transition: 'opacity 120ms ease-out',
                          flexShrink: 0,
                          pointerEvents: 'none',
                        }}
                      />
                      {dragDelta && dragStartRef.current && (
                        <div className="absolute top-2 left-2 px-2 py-1 rounded bg-black/80 border border-cyan-500/50 text-[11px] font-mono-num text-cyan-300 pointer-events-none">
                          X: {dragStartRef.current.origX + Math.round(dragDelta.x / Math.max(0.1, stageScale))}px · Y:{' '}
                          {dragStartRef.current.origY + Math.round(dragDelta.y / Math.max(0.1, stageScale))}px
                        </div>
                      )}
                    </div>
                  )}

                  {activeSubtitle && (
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-black/75 text-white text-xs text-center max-w-[90%] pointer-events-none">
                      {activeSubtitle.text}
                    </div>
                  )}
                </div>
              </div>

              {/* 播放控制与快捷键提示栏 */}
              <div className="mt-2 flex items-center gap-2.5 text-xs">
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
                  title="播放/暂停 (Space)"
                >
                  {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                </button>
                <span className="font-mono-num text-cyan-300 text-[11px] shrink-0">
                  当前 {fmtClock(currentTime)} / {fmtClock(totalDur)}
                </span>
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
                  className="flex-1 accent-orange-500"
                />
                <span className="text-[10px] text-slate-500 hidden xl:inline">空格 播放 · ← → ±0.5s · Delete 删卡</span>
                <button onClick={handleUndo} disabled={!undoStack.length} className="p-1 rounded bg-slate-800 text-slate-300 disabled:opacity-30" title="撤销">
                  <Undo2 className="w-3.5 h-3.5" />
                </button>
                <button onClick={handleRedo} disabled={!redoStack.length} className="p-1 rounded bg-slate-800 text-slate-300 disabled:opacity-30" title="重做">
                  <Redo2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* 底部彩色多轨时间轴 + 缩放控制 + 拖拽调时 + 渲染队列 */}
            <div className="h-48 shrink-0 bg-[#0b1120] border border-slate-800 rounded-xl p-2.5 flex flex-col gap-1.5 overflow-y-auto text-[11px]">
              <div className="flex items-center justify-between text-slate-400">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-200">
                    时间轴 · 卡片 {doc.cards.length} 张 · 当前同屏 {doc.cards.filter((c) => currentTime >= c.start && currentTime <= c.end).length} 张
                  </span>
                  <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded px-1 py-0.5 text-[10px]">
                    <button onClick={() => setTlZoom((z) => Math.max(1, Number((z - 0.5).toFixed(1))))} className="hover:text-cyan-300" title="缩小时间轴">
                      <ZoomOut className="w-3 h-3" />
                    </button>
                    <span className="font-mono-num text-cyan-300 px-1">{tlZoom}×</span>
                    <button onClick={() => setTlZoom((z) => Math.min(4, Number((z + 0.5).toFixed(1))))} className="hover:text-cyan-300" title="放大时间轴">
                      <ZoomIn className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <button onClick={handleLint} disabled={!activeProj} className="text-[11px] text-amber-300 hover:underline flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> 质量检查{lintRes ? ` (${lintRes.error_count}错/${lintRes.warning_count}警)` : ''}
                </button>
              </div>

              <div className="overflow-x-auto pb-1">
              <div className="relative space-y-1.5" style={{ width: `${tlZoom * 100}%`, minWidth: '100%' }}>
                {/* 红色播放头垂直线 */}
                <div
                  style={{ left: `calc(68px + (100% - 68px) * ${Math.min(1, currentTime / totalDur)})` }}
                  className="absolute top-0 bottom-0 w-[2px] bg-orange-500 z-20 pointer-events-none"
                />

                {/* 轨1：参考视频 */}
                <div className="flex items-center gap-2">
                  <span className="w-14 text-slate-400 shrink-0">视频轨</span>
                  <div className="flex-1 h-5 bg-slate-950 rounded border border-slate-800 px-2 flex items-center text-[10px] text-slate-400 truncate">
                    {activeProj?.reference_video_path ? `参考视频：${activeProj.reference_video_path}` : '纯透明动效层模式（可左下角导入参考视频）'}
                  </div>
                </div>

                {/* 轨2：动效轨（按模板分组彩色块） */}
                <div className="flex items-center gap-2">
                  <span className="w-14 text-cyan-400 shrink-0">动效轨</span>
                  <div className="flex-1 h-8 bg-slate-950 rounded border border-slate-800 relative overflow-hidden">
                    {doc.cards.map((c) => {
                      const left = `${(c.start / totalDur) * 100}%`;
                      const width = `${Math.max(4, ((c.end - c.start) / totalDur) * 100)}%`;
                      const active = c.id === selectedCardId;
                      const grp = effectById[c.kind]?.group || '';
                      const cls = GROUP_COLORS[grp] || 'bg-indigo-500/30 border-indigo-400/50 text-indigo-100';
                      return (
                        <button
                          key={c.id}
                          draggable
                          onDragEnd={(ev) => {
                            const track = ev.currentTarget.parentElement;
                            if (!track) return;
                            const rect = track.getBoundingClientRect();
                            const ratio = Math.max(0, Math.min(0.95, (ev.clientX - rect.left) / rect.width));
                            const dur = Math.max(1, c.end - c.start);
                            const nextStart = Number((ratio * totalDur).toFixed(1));
                            mutateDoc({
                              ...doc,
                              cards: doc.cards.map((x) => (x.id === c.id ? { ...x, start: nextStart, end: Number((nextStart + dur).toFixed(1)) } : x)),
                            });
                            setCurrentTime(Number((nextStart + 0.4).toFixed(1)));
                          }}
                          onClick={() => {
                            setSelectedCardId(c.id);
                            setCurrentTime(Number((c.start + 0.4).toFixed(1)));
                            setRightTab('props');
                          }}
                          style={{ left, width }}
                          className={`absolute top-1 bottom-1 rounded px-1.5 text-[10px] truncate transition border cursor-grab active:cursor-grabbing ${cls} ${
                            active ? 'ring-2 ring-orange-400 z-10' : 'opacity-85 hover:opacity-100'
                          }`}
                          title={`${effectById[c.kind]?.name || c.kind} (${c.start}s - ${c.end}s) · 可左右拖拽移动`}
                        >
                          {effectById[c.kind]?.name || c.kind}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 轨3：字幕轨 */}
                <div className="flex items-center gap-2">
                  <span className="w-14 text-emerald-400 shrink-0">字幕轨</span>
                  <div className="flex-1 h-5 bg-slate-950 rounded border border-slate-800 relative overflow-hidden">
                    {(doc.srt || []).map((s, idx) => (
                      <div
                        key={idx}
                        style={{ left: `${(s.start / totalDur) * 100}%`, width: `${Math.max(2, ((s.end - s.start) / totalDur) * 100)}%` }}
                        className="absolute top-0.5 bottom-0.5 bg-emerald-500/25 border border-emerald-500/40 rounded px-1 text-[9px] text-emerald-200 truncate"
                        title={s.text}
                      >
                        {s.text}
                      </div>
                    ))}
                  </div>
                </div>

                {/* 轨4：音效轨 */}
                <div className="flex items-center gap-2">
                  <span className="w-14 text-amber-400 shrink-0">音效轨</span>
                  <div className="flex-1 h-5 bg-slate-950 rounded border border-slate-800 relative overflow-hidden">
                    {doc.cards
                      .filter((c) => c.params?.sfx && c.params.sfx !== 'none')
                      .map((c) => (
                        <div
                          key={c.id}
                          style={{ left: `${(c.start / totalDur) * 100}%`, width: '7%' }}
                          className="absolute top-0.5 bottom-0.5 bg-amber-500/25 border border-amber-500/40 rounded px-1 text-[9px] text-amber-200 truncate"
                        >
                          🔊 {c.params.sfx}
                        </div>
                      ))}
                  </div>
                </div>
              </div>
              </div>

              {/* 最近渲染任务状态条 */}
              {renderJobs.length > 0 && (
                <div className="mt-1 pt-1 border-t border-slate-800 space-y-1">
                  {renderJobs.slice(0, 2).map((j) => {
                    const probe = j.ffprobe_json ? JSON.parse(j.ffprobe_json) : null;
                    return (
                      <div key={j.job_uid} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-slate-900/90 border border-slate-800">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`px-1.5 py-0.2 rounded text-[10px] ${j.state === 'completed' ? 'bg-emerald-500/20 text-emerald-300' : j.state === 'running' ? 'bg-cyan-500/20 text-cyan-300' : 'bg-rose-500/20 text-rose-300'}`}>
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
                            <button onClick={() => api.cancelRenderJob(j.job_uid).then(() => showToast('已发送取消指令'))} className="px-2 py-0.5 rounded bg-rose-600/30 text-rose-200 text-[10px]">
                              取消
                            </button>
                          )}
                          {j.state === 'completed' && j.output_mov_path && (
                            <a href={`/api/video/render-jobs/${j.job_uid}/download?fmt=mov`} className="px-2 py-0.5 rounded bg-cyan-600/30 text-cyan-200 text-[10px]">下MOV</a>
                          )}
                          {j.state === 'completed' && j.output_webm_path && (
                            <a href={`/api/video/render-jobs/${j.job_uid}/download?fmt=webm`} className="px-2 py-0.5 rounded bg-indigo-600/30 text-indigo-200 text-[10px]">下WebM</a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 右栏：100% 复刻 Overlay Studio 精细属性面板（预设/内容/节奏/样式/摆位） */}
          <div className="w-80 shrink-0 bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
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
                    {/* 卡片标题栏 */}
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <div>
                        <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-orange-500" />
                          {selectedEffectMeta?.name || selectedCard.kind}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono-num">{selectedCard.kind} · {selectedCard.id}</div>
                      </div>
                      <button
                        onClick={() => {
                          mutateDoc({ ...doc, cards: doc.cards.filter((c) => c.id !== selectedCard.id) });
                          setSelectedCardId(null);
                        }}
                        className="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400"
                        title="删除此卡片 (Delete)"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* 更换特效（仅保留通用样式/节奏/布局字段，清除旧卡异构内容字段防止崩溃） */}
                    <label className="block space-y-1">
                      <span className="text-[10px] text-slate-400">更换特效（保留时间与通用样式）</span>
                      <select
                        value={selectedCard.kind}
                        onChange={(e) => {
                          const keepKeys = ['theme', 'accent', 'glass', 'glassAlpha', 'shadow', 'scale', 'speed', 'side', 'position', 'offsetX', 'offsetY', 'sfx', 'dimAt', 'breath'];
                          const nextParams: Record<string, any> = {};
                          for (const k of keepKeys) {
                            if (selectedCard.params?.[k] !== undefined) nextParams[k] = selectedCard.params[k];
                          }
                          updateSelectedCard({ kind: e.target.value, params: nextParams });
                        }}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-cyan-300"
                      >
                        {effects.map((eff) => (
                          <option key={eff.id} value={eff.id}>
                            [{eff.group}] {eff.name} ({eff.id})
                          </option>
                        ))}
                      </select>
                    </label>

                    {/* 我的样式预设 */}
                    <div className="p-2 rounded-lg bg-slate-900/70 border border-slate-800 space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-300 font-medium flex items-center gap-1">
                          <Bookmark className="w-3 h-3 text-amber-400" /> 我的样式预设
                        </span>
                        <button onClick={saveCurrentStylePreset} className="text-[10px] text-cyan-400 hover:underline">
                          + 存当前样式
                        </button>
                      </div>
                      {presets.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {presets.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => applyStylePreset(p)}
                              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-cyan-600/30 border border-slate-700 text-[10px] text-slate-200"
                            >
                              {p.name}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[10px] text-slate-500">调好底色/强调色/玻璃后可一键存为预设复用</div>
                      )}
                    </div>

                    {/* 内容 CONTENT（严格按上游 25 卡原生 controls 动态生成） */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-800/80 pb-1">
                        <span>内容</span>
                        <span className="font-mono-num">CONTENT</span>
                      </div>
                      {(selectedEffectMeta?.controls || []).map((ctrl: any) => (
                        <label key={ctrl.key} className="block space-y-1">
                          <span className="text-[11px] text-slate-300">{ctrl.label}</span>
                          {ctrl.type === 'range' ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="range"
                                min={ctrl.min ?? 0}
                                max={ctrl.max ?? 1000}
                                step={ctrl.step ?? 10}
                                value={selectedCard.params?.[ctrl.key] ?? ctrl.min ?? 0}
                                onChange={(e) => updateSelectedParam(ctrl.key, Number(e.target.value))}
                                className="flex-1 accent-cyan-400 h-1"
                              />
                              <span className="font-mono-num text-[10px] text-cyan-300 w-12 text-right">
                                {selectedCard.params?.[ctrl.key] ?? '默认'}
                              </span>
                            </div>
                          ) : ctrl.type === 'number' ? (
                            <input
                              type="number"
                              value={selectedCard.params?.[ctrl.key] ?? ''}
                              placeholder="留空用默认"
                              onChange={(e) => updateSelectedParam(ctrl.key, e.target.value === '' ? undefined : Number(e.target.value))}
                              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono-num text-slate-100"
                            />
                          ) : (
                            <input
                              value={selectedCard.params?.[ctrl.key] ?? ''}
                              placeholder="留空则使用官方默认演示文本"
                              onChange={(e) => updateSelectedParam(ctrl.key, e.target.value)}
                              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100"
                            />
                          )}
                        </label>
                      ))}
                    </div>

                    {/* 节奏 TIMING */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-800/80 pb-1">
                        <span>节奏</span>
                        <span className="font-mono-num">TIMING</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                          <span className="text-[10px] text-slate-400">开始时间 (s)</span>
                          <input
                            type="number"
                            step={0.1}
                            value={selectedCard.start}
                            onChange={(e) => updateSelectedCard({ start: Number(e.target.value) })}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 font-mono-num"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] text-slate-400">结束时间 (s)</span>
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
                        <span className="text-[10px] text-slate-400">讲过变浅时刻 (秒，空 = 不变浅)</span>
                        <input
                          type="number"
                          step={0.5}
                          placeholder="例如 12.5（讲完后压暗让位不退场）"
                          value={selectedCard.params?.dimAt ?? ''}
                          onChange={(e) => updateSelectedParam('dimAt', e.target.value === '' ? undefined : Number(e.target.value))}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 font-mono-num text-xs"
                        />
                      </label>
                      <label className="flex items-center justify-between py-0.5 text-[11px] text-slate-300">
                        <span>呼吸感（此卡独立落定微动）</span>
                        <input
                          type="checkbox"
                          checked={!!selectedCard.params?.breath}
                          onChange={(e) => updateSelectedParam('breath', e.target.checked || undefined)}
                        />
                      </label>
                      <div>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-slate-400">动画速度 (此卡)</span>
                          <span className="font-mono-num text-cyan-300">{Number(selectedCard.params?.speed || 1).toFixed(2)}x</span>
                        </div>
                        <input
                          type="range"
                          min={0.5}
                          max={2.0}
                          step={0.05}
                          value={selectedCard.params?.speed || 1}
                          onChange={(e) => updateSelectedParam('speed', Number(e.target.value))}
                          className="w-full accent-cyan-400 h-1"
                        />
                      </div>
                      <label className="block space-y-1">
                        <span className="text-[10px] text-slate-400">音效（出现时响，导出自动混入）</span>
                        <select
                          value={selectedCard.params?.sfx ?? ''}
                          onChange={(e) => updateSelectedParam('sfx', e.target.value || undefined)}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs"
                        >
                          <option value="">🔊 自动（按特效类型）</option>
                          <option value="none">🔇 无音效</option>
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
                    </div>

                    {/* 样式 STYLE（100% 复刻截图右侧样式区） */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-800/80 pb-1">
                        <span>样式</span>
                        <span className="font-mono-num">STYLE</span>
                      </div>

                      <div className="space-y-1">
                        <div className="text-[10px] text-slate-400">底色（此卡独立生效）</div>
                        <div className="grid grid-cols-2 gap-1.5">
                          {[['light', '☀ 亮底'], ['dark', '🌙 暗底']].map(([v, label]) => (
                            <button
                              key={v}
                              onClick={() => updateSelectedParam('theme', v)}
                              className={`py-1.5 rounded text-xs border ${
                                (selectedCard.params?.theme || doc.theme || 'dark') === v
                                  ? 'bg-orange-600 border-orange-500 text-white font-medium'
                                  : 'bg-slate-900 border-slate-700 text-slate-300'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="text-[10px] text-slate-400">关键词强调色</div>
                        <div className="grid grid-cols-3 gap-1">
                          {ACCENT_OPTIONS.map((a) => (
                            <button
                              key={a.id}
                              onClick={() => updateSelectedParam('accent', a.id)}
                              className={`py-1 px-1.5 rounded text-[11px] border flex items-center justify-center gap-1 ${
                                selectedCard.params?.accent === a.id
                                  ? 'bg-orange-600/90 border-orange-400 text-white'
                                  : 'bg-slate-900 border-slate-700 text-slate-300'
                              }`}
                            >
                              <span className="w-2 h-2 rounded-full" style={{ background: a.swatch }} />
                              {a.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="text-[10px] text-slate-400">玻璃底色</div>
                        <div className="grid grid-cols-3 gap-1">
                          {GLASS_OPTIONS.map((g) => (
                            <button
                              key={g.id}
                              onClick={() => updateSelectedParam('glass', g.id)}
                              className={`py-1 rounded text-[11px] border ${
                                (selectedCard.params?.glass || '') === g.id
                                  ? 'bg-orange-600 border-orange-500 text-white'
                                  : 'bg-slate-900 border-slate-700 text-slate-300'
                              }`}
                            >
                              {g.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                          <span>底色透明度（玻璃底色打开时生效）</span>
                          <span className="font-mono-num text-cyan-300">{Number(selectedCard.params?.glassAlpha ?? 0.6).toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={selectedCard.params?.glassAlpha ?? 0.6}
                          onChange={(e) => updateSelectedParam('glassAlpha', Number(e.target.value))}
                          className="w-full accent-cyan-400 h-1"
                        />
                      </div>

                      <div className="space-y-1">
                        <div className="text-[10px] text-slate-400">阴影</div>
                        <div className="grid grid-cols-4 gap-1">
                          {SHADOW_OPTIONS.map((s) => (
                            <button
                              key={s.id}
                              onClick={() => updateSelectedParam('shadow', s.id)}
                              className={`py-1 rounded text-[11px] border ${
                                (selectedCard.params?.shadow || '') === s.id
                                  ? 'bg-orange-600 border-orange-500 text-white'
                                  : 'bg-slate-900 border-slate-700 text-slate-300'
                              }`}
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* 摆位与大小 LAYOUT（100% 复刻截图右下角） */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-800/80 pb-1">
                        <span>摆位与大小</span>
                        <span className="font-mono-num">LAYOUT</span>
                      </div>
                      <div className="grid grid-cols-5 gap-1">
                        {POSITION_OPTIONS.map((pos) => (
                          <button
                            key={pos.id}
                            onClick={() => updateSelectedParam(layoutKey, pos.id)}
                            className={`py-1 rounded text-[10px] border ${
                              (selectedCard.params?.[layoutKey] || 'center') === pos.id
                                ? 'bg-orange-600 border-orange-500 text-white'
                                : 'bg-slate-900 border-slate-700 text-slate-300'
                            }`}
                          >
                            {pos.label}
                          </button>
                        ))}
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                          <span>单卡缩放</span>
                          <span className="font-mono-num text-cyan-300">{Math.round(Number(selectedCard.params?.scale || 1) * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min={0.5}
                          max={1.8}
                          step={0.05}
                          value={selectedCard.params?.scale || 1}
                          onChange={(e) => updateSelectedParam('scale', Number(e.target.value))}
                          className="w-full accent-cyan-400 h-1"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                          <span>水平微调 (offsetX)</span>
                          <span className="font-mono-num text-cyan-300">{selectedCard.params?.offsetX || 0}px</span>
                        </div>
                        <input
                          type="range"
                          min={-400}
                          max={400}
                          step={5}
                          value={selectedCard.params?.offsetX || 0}
                          onChange={(e) => updateSelectedParam('offsetX', Number(e.target.value))}
                          className="w-full accent-cyan-400 h-1"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                          <span>垂直微调 (offsetY)</span>
                          <span className="font-mono-num text-cyan-300">{selectedCard.params?.offsetY || 0}px</span>
                        </div>
                        <input
                          type="range"
                          min={-300}
                          max={300}
                          step={5}
                          value={selectedCard.params?.offsetY || 0}
                          onChange={(e) => updateSelectedParam('offsetY', Number(e.target.value))}
                          className="w-full accent-cyan-400 h-1"
                        />
                      </div>
                    </div>

                    {/* 叠放 · LAYER（100% 复刻 5188 编辑台层序控制） */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-800/80 pb-1">
                        <span>叠放顺序（当前第 {doc.cards.findIndex((c) => c.id === selectedCard.id) + 1}/{doc.cards.length} 层）</span>
                        <span className="font-mono-num">LAYER</span>
                      </div>
                      <div className="grid grid-cols-4 gap-1">
                        <button onClick={() => moveCardLayer('up')} className="py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] text-slate-200 flex items-center justify-center gap-0.5"><ArrowUp className="w-3 h-3" />上移</button>
                        <button onClick={() => moveCardLayer('down')} className="py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] text-slate-200 flex items-center justify-center gap-0.5"><ArrowDown className="w-3 h-3" />下移</button>
                        <button onClick={() => moveCardLayer('top')} className="py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] text-slate-200 flex items-center justify-center gap-0.5"><ChevronsUp className="w-3 h-3" />置顶</button>
                        <button onClick={() => moveCardLayer('bottom')} className="py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10px] text-slate-200 flex items-center justify-center gap-0.5"><ChevronsDown className="w-3 h-3" />置底</button>
                      </div>
                    </div>

                    {/* 底部醒目橙色主按钮：加到当前时间点 */}
                    <button
                      onClick={() => selectedEffectMeta && addEffectCard(selectedEffectMeta, currentTime, selectedCard.params)}
                      className="w-full py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold text-xs"
                    >
                      + 复制加到 {fmtClock(currentTime)}，时长 4 秒
                    </button>
                  </>
                ) : (
                  <div className="text-slate-500 text-center py-8">在左侧动效库点击任意卡片，或在时间轴选中已有卡片进行精细调参</div>
                )
              )}

              {rightTab === 'lint' && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-200">编排质量检查（A13）</span>
                    <button onClick={handleLint} className="px-2 py-0.5 rounded bg-cyan-600/30 text-cyan-200 text-[11px]">重新检查</button>
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
                              <button onClick={() => ignoreWarningRule(w.card_id, w.rule)} className="px-1.5 py-0.5 rounded bg-amber-500/20 text-[10px]">
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
                        <span className={r.status === 'approved' ? 'text-emerald-400' : r.status === 'revoked' ? 'text-slate-500' : 'text-amber-300'}>状态：{r.status}</span>
                        <div className="flex gap-1">
                          {r.status !== 'approved' && (
                            <button onClick={() => api.patchVideoFeedbackRule(r.id, { status: 'approved' }).then(() => api.listVideoFeedbackRules(projectId).then(setFeedbackRules))} className="px-1.5 py-0.5 rounded bg-emerald-600/30 text-emerald-200">批准</button>
                          )}
                          {r.status === 'approved' && (
                            <button onClick={() => api.patchVideoFeedbackRule(r.id, { status: 'revoked' }).then(() => api.listVideoFeedbackRules(projectId).then(setFeedbackRules))} className="px-1.5 py-0.5 rounded bg-rose-600/30 text-rose-200">撤销</button>
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
                        onClick={() => activeProj && api.restoreVideoVersion(activeProj.id, v.id).then(() => { openProject(activeProj.id); showToast(`✅ 已恢复到 v${v.version_no}`); })}
                        className="px-2 py-0.5 rounded bg-slate-800 hover:bg-cyan-600 text-[10px] text-slate-200 shrink-0"
                      >
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-2 border-t border-slate-800 bg-[#080d18] text-[10px] text-slate-500">
              动效渲染引擎：Overlay Studio v1.4.0（Copyright © 2026 Jessie Zhou · 内部使用/自改授权）。
            </div>
          </div>
        </div>
      )}

      {/* 全局设置弹窗（复刻 Overlay Studio 全局设置） */}
      {globalModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-[420px] bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3 text-xs">
            <div className="text-sm font-bold text-slate-100">全局设置（整片生效）</div>
            <div className="space-y-1">
              <div className="text-slate-400">全局默认底色</div>
              <div className="grid grid-cols-2 gap-2">
                {[['dark', '🌙 暗底'], ['light', '☀ 亮底']].map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setDoc({ ...doc, theme: v as any })}
                    className={`py-1.5 rounded border ${(doc.theme || 'dark') === v ? 'bg-orange-600 border-orange-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-300'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between py-1">
              <span className="text-slate-200">文字可读性光晕 (glow)</span>
              <input type="checkbox" checked={!!doc.glow} onChange={(e) => setDoc({ ...doc, glow: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between py-1">
              <span className="text-slate-200">卡片落定微动呼吸感 (breath)</span>
              <input type="checkbox" checked={!!doc.breath} onChange={(e) => setDoc({ ...doc, breath: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between py-1">
              <span className="text-slate-200">导出帧率 (FPS)</span>
              <select
                value={doc.exportFps || 30}
                onChange={(e) => setDoc({ ...doc, exportFps: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-cyan-300"
              >
                <option value={29.97}>29.97 fps (NTSC)</option>
                <option value={30}>30 fps</option>
                <option value={50}>50 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </label>
            <label className="flex items-center justify-between py-1">
              <span className="text-slate-200">全局主文字覆盖色 (留空默认)</span>
              <div className="flex items-center gap-2">
                <input type="color" value={doc.inkColor || '#ffffff'} onChange={(e) => setDoc({ ...doc, inkColor: e.target.value })} />
                {doc.inkColor && (
                  <button onClick={() => setDoc({ ...doc, inkColor: undefined })} className="text-[10px] text-rose-400">清空</button>
                )}
              </div>
            </label>
            <label className="flex items-center justify-between py-1">
              <span className="text-slate-200">安全区参考线（仅编辑可见）</span>
              <input type="checkbox" checked={showSafeBorder} onChange={(e) => setShowSafeBorder(e.target.checked)} />
            </label>
            <label className="flex items-center justify-between py-1">
              <span className="text-slate-200">人物安全区剪影占位（仅编辑可见）</span>
              <input type="checkbox" checked={showAvatarGuide} onChange={(e) => setShowAvatarGuide(e.target.checked)} />
            </label>
            <div className="flex justify-end">
              <button onClick={() => setGlobalModal(false)} className="px-4 py-1.5 rounded bg-cyan-600 text-white">完成</button>
            </div>
          </div>
        </div>
      )}

      {/* 完整导出配置弹窗（100% 复刻 5188 导出整条时间轴 / 导出单卡选项） */}
      {exportModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-[440px] bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3 text-xs">
            <div className="text-sm font-bold text-slate-100">
              {exportModal.mode === 'single' ? `导出单卡透明视频（${selectedCard?.kind || '未选卡'}）` : '导出整条时间轴（透明 MOV）'}
            </div>
            {exportModal.mode === 'single' && (
              <label className="flex items-center justify-between">
                <span className="text-slate-300">导出时长 (秒)</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  step={0.5}
                  value={exportOpts.singleDuration}
                  onChange={(e) => setExportOpts({ ...exportOpts, singleDuration: Number(e.target.value) })}
                  className="w-24 bg-slate-950 border border-slate-700 rounded px-2 py-1 font-mono-num text-right text-cyan-300"
                />
              </label>
            )}
            <label className="flex items-center justify-between">
              <span className="text-slate-300">输出帧率 (FPS)</span>
              <select
                value={exportOpts.fps}
                onChange={(e) => setExportOpts({ ...exportOpts, fps: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-cyan-300"
              >
                <option value={29.97}>29.97 fps (NTSC)</option>
                <option value={30}>30 fps</option>
                <option value={50}>50 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </label>
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 space-y-2">
              <div className="text-slate-400 text-[11px]">默认输出：ProRes 4444 透明 MOV（含预乘 Alpha 与混音，直接进剪映）</div>
              <label className="flex items-center justify-between">
                <span className="text-slate-200">附加 WebM（小体积，适合网页预览）</span>
                <input type="checkbox" checked={exportOpts.includeWebm} onChange={(e) => setExportOpts({ ...exportOpts, includeWebm: e.target.checked })} />
              </label>
              <label className="flex items-center justify-between">
                <span className="text-slate-200">Windows 兼容模式（渲染偏慢时开启）</span>
                <input type="checkbox" checked={exportOpts.compatibilityMode} onChange={(e) => setExportOpts({ ...exportOpts, compatibilityMode: e.target.checked })} />
              </label>
              <label className="flex items-center justify-between">
                <span className="text-slate-200">加快帧截图（实验 · fastPng）</span>
                <input type="checkbox" checked={exportOpts.fastPng} onChange={(e) => setExportOpts({ ...exportOpts, fastPng: e.target.checked })} />
              </label>
              <label className="flex items-center justify-between">
                <span className="text-slate-200">边渲染边编码（实验 · stream）</span>
                <input
                  type="checkbox"
                  checked={exportOpts.exportMode === 'stream'}
                  onChange={(e) => setExportOpts({ ...exportOpts, exportMode: e.target.checked ? 'stream' : 'sequence' })}
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setExportModal(null)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300">取消</button>
              <button onClick={() => handleExport(exportModal.mode, exportOpts)} className="px-4 py-1.5 rounded bg-orange-600 hover:bg-orange-500 text-white font-medium">
                开始导出
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建视频工程弹窗 */}
      {newProjModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-96 bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3">
            <div className="text-sm font-bold text-slate-100">新建视频动效工程</div>
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="输入视频工程标题..." className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100" autoFocus />
            <select value={newRatio} onChange={(e) => setNewRatio(e.target.value as any)} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100">
              <option value="16:9">16:9 横屏 (1920×1080)</option>
              <option value="9:16">9:16 竖屏 (1080×1920)</option>
              <option value="4:3">4:3 传统 (1440×1080)</option>
            </select>
            <div className="flex justify-end gap-2">
              <button onClick={() => setNewProjModal(false)} className="px-3 py-1.5 rounded bg-slate-800 text-xs text-slate-300">取消</button>
              <button onClick={createProject} className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-xs text-white">创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 导入 SRT 弹窗 */}
      {srtModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-[540px] bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3">
            <div className="text-sm font-bold text-slate-100">导入 SRT 字幕（A01）</div>
            <div className="space-y-1">
              <div className="text-[11px] text-slate-400">方式一：直接从「文案提取工坊」已有素材导入真实时间码</div>
              <select value={selectedContentId} onChange={(e) => setSelectedContentId(e.target.value ? Number(e.target.value) : '')} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100">
                <option value="">-- 选择已提取文案的素材 --</option>
                {contents.map((c) => <option key={c.id} value={c.id}>#{c.id} [{c.platform}] {c.title?.slice(0, 48)}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-slate-400">方式二：粘贴中英文 SRT 字幕全文（优先于方式一）</div>
              <textarea value={srtInput} onChange={(e) => setSrtInput(e.target.value)} rows={7} placeholder={'1\n00:00:00,000 --> 00:00:03,500\n今天我们用真实数据拆解一个关键现象'} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs font-mono-num text-slate-200" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSrtModal(false)} className="px-3 py-1.5 rounded bg-slate-800 text-xs text-slate-300">取消</button>
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
