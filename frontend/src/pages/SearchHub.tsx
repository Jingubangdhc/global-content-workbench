import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookmarkPlus,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Shuffle,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import CredentialVaultModal from '../components/CredentialVaultModal';
import VideoCaptureModal from '../components/VideoCaptureModal';
import { extractShareLinks } from '../utils/shareLink';

export interface DesktopBrowserViewController {
  viewId: 'research' | 'topicPlayer';
  navigate: (url: string) => Promise<any>;
  setBounds: (rect: { x: number; y: number; width: number; height: number }) => Promise<any>;
  setVisible: (visible: boolean) => Promise<any>;
  pauseMedia: () => Promise<any>;
  back: () => Promise<any>;
  forward: () => Promise<any>;
  reload: () => Promise<any>;
  getState: () => Promise<any>;
  extractVideoMeta: () => Promise<any>;
  getVideoPlayback: () => Promise<any>;
  onState: (cb: (state: any) => void) => () => void;
}

declare global {
  interface Window {
    gcwDesktopBrowser?: {
      isElectron: boolean;
      forView: (viewId: 'research' | 'topicPlayer') => DesktopBrowserViewController;
      hideAll: () => Promise<any>;
    };
  }
}

interface Props {
  isActive?: boolean;
  projectId: number;
  projectName?: string;
  projects?: { id: number; name: string }[];
  lowFollowerThreshold: number;
  externalQuery?: string | null;
  onOpenTranscript: (contentId: number) => void;
  onGoTopicHub?: (projectId: number, topicId?: number) => void;
}

function parseEmbedUrl(rawUrl: string): { kind: 'youtube' | 'bilibili' | null; embedUrl: string; label: string } {
  const u = (rawUrl || '').trim();
  if (!u) return { kind: null, embedUrl: '', label: '' };
  const ytMatch = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
  if (ytMatch) {
    return { kind: 'youtube', embedUrl: `https://www.youtube.com/embed/${ytMatch[1]}`, label: `YouTube 官方嵌入 (${ytMatch[1]})` };
  }
  const biliMatch = u.match(/(BV[A-Za-z0-9]{10})/);
  if (biliMatch) {
    return { kind: 'bilibili', embedUrl: `https://player.bilibili.com/player.html?bvid=${biliMatch[1]}&high_quality=1&autoplay=0`, label: `B站官方站外播放器 (${biliMatch[1]})` };
  }
  return { kind: null, embedUrl: '', label: '' };
}

/**
 * 页面①：真实市场研究工作区（GCW-UAT-FIX-02-R2 精简重构版 · 麦田浅色极简 UI）
 *
 * 空间比例目标：
 * - 顶部研究维度区（约 10%，平铺式芯片，可一键折叠）；
 * - 左侧候选选题区（约 15%，可一键折叠，进入人工研究优先收起）；
 * - 主体真实市场研究区（约 75%，支持一键最大化；左 70% 官方嵌入/真实网页同屏区 + 右 30% 证据收录与笔记栏）。
 * 深度打通 Chrome Extension MV3 Side Panel：扩展已连接时点击平台自动同屏展开原生网页 + 右侧研究侧栏。
 */
export default function SearchHub({ isActive = true, projectId, projectName = '', projects = [], externalQuery, onGoTopicHub }: Props) {
  const [rootInput, setRootInput] = useState('');
  const [nodes, setNodes] = useState<any[]>([]);
  const [presets, setPresets] = useState<any[]>([]);
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [customDimInput, setCustomDimInput] = useState('');
  const [presetName, setPresetName] = useState('');
  const [randomCount, setRandomCount] = useState(4);
  const [dimGenCount, setDimGenCount] = useState(10);
  const [candGenCount, setCandGenCount] = useState(5);
  const [checkedCandIds, setCheckedCandIds] = useState<number[]>([]);
  const [aiRecNote, setAiRecNote] = useState('');

  // 布局折叠与最大化控制
  const [dimsCollapsed, setDimsCollapsed] = useState(false);
  const [candsCollapsed, setCandsCollapsed] = useState(false);
  const [researchMaximized, setResearchMaximized] = useState(false);

  // 候选选题
  const [candidates, setCandidates] = useState<any[]>([]);
  const [generatingCands, setGeneratingCands] = useState(false);
  const [activeCandId, setActiveCandId] = useState<number | null>(null);

  // FIX-A02: SearchHub 专属独立内置浏览器控制器（researchView，与 TopicHub topicPlayerView 完全隔离）
  const isElectron = Boolean(window.gcwDesktopBrowser?.isElectron);
  const researchBrowser = useMemo(
    () => (window.gcwDesktopBrowser?.isElectron ? window.gcwDesktopBrowser.forView('research') : null),
    []
  );
  const browserHostRef = useRef<HTMLDivElement | null>(null);
  const [ebState, setEbState] = useState<{
    url: string;
    title: string;
    isLoading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    lastError: string;
    visible: boolean;
  }>({ url: '', title: '', isLoading: false, canGoBack: false, canGoForward: false, lastError: '', visible: false });
  const [addressBar, setAddressBar] = useState('');
  const [lastOriginalShareUrl, setLastOriginalShareUrl] = useState('');
  const [addressMultiLinks, setAddressMultiLinks] = useState<string[]>([]);

  // FIX-A04: 严格项目隔离守卫（异步任务回调比对 activeProjectIdRef，切项目前保存原项目状态）
  const activeProjectIdRef = useRef<number>(projectId);
  const prevProjectIdRef = useRef<number>(projectId);
  const stateSnapshotRef = useRef<any>({});

  // 研究平台导航（已清理废弃 Chrome Side Panel 桥接代码）
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [activeQueryText, setActiveQueryText] = useState('');
  const [activePlatform, setActivePlatform] = useState<any>(null);

  // 官方视频站内嵌入播放器（YouTube / B站）
  const [embedInputUrl, setEmbedInputUrl] = useState('');
  const [activeEmbed, setActiveEmbed] = useState<{ kind: 'youtube' | 'bilibili' | null; embedUrl: string; label: string; rawUrl: string; title: string }>({
    kind: null, embedUrl: '', label: '', rawUrl: '', title: '',
  });

  // 人工证据列表与侧边收录表单
  const [evidences, setEvidences] = useState<any[]>([]);
  const [evType, setEvType] = useState<'video' | 'article' | 'comment_text' | 'data_snapshot'>('video');
  const [evUrl, setEvUrl] = useState('');
  const [evTitle, setEvTitle] = useState('');
  const [evAuthor, setEvAuthor] = useState('');
  const [evPlatform, setEvPlatform] = useState('youtube');
  const [evViews, setEvViews] = useState('');
  const [evLikes, setEvLikes] = useState('');
  const [evNote, setEvNote] = useState('');
  const [judgeReason, setJudgeReason] = useState('');
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [vaultOpen, setVaultOpen] = useState(false);
  const [captureModalOpen, setCaptureModalOpen] = useState(false);
  const [capturePreview, setCapturePreview] = useState<any | null>(null);
  const [captureLoading, setCaptureLoading] = useState(false);
  const browserWasVisibleRef = useRef(false);

  const openVaultModal = () => {
    if (researchBrowser && ebState.visible) {
      browserWasVisibleRef.current = true;
      researchBrowser.setVisible(false);
    } else {
      browserWasVisibleRef.current = false;
    }
    setVaultOpen(true);
  };

  const closeVaultModal = () => {
    setVaultOpen(false);
    if (researchBrowser && browserWasVisibleRef.current) {
      researchBrowser.setVisible(true);
    }
  };

  const handleOpenOneClickCapture = async () => {
    if (!researchBrowser) {
      showToast('请在桌面版内置浏览器中使用「加入选题库」');
      return;
    }
    if (!ebState.url) {
      showToast('请先在中央内置浏览器打开任意真实视频页面');
      return;
    }
    const reqPid = projectId;
    browserWasVisibleRef.current = ebState.visible;
    setCaptureLoading(true);
    setCapturePreview(null);
    setCaptureModalOpen(true);
    try {
      const snap = await researchBrowser.extractVideoMeta();
      // GCW-STABLE-FIX-02: 严禁吞掉页面提取脚本异常或伪装成功回退为 web
      if (!snap || snap.ok === false || snap.extract_status === 'script_error') {
        const errDetail = snap?.error_message || snap?.error || '未知提取异常';
        setCaptureModalOpen(false);
        showToast(`⚠️ 视频元数据提取脚本执行异常（${snap?.error_code || 'EXTRACT_ERROR'}）：${errDetail}`);
        return;
      }
      await researchBrowser.setVisible(false);
      const res = await api.videoCapturePreview({
        project_id: reqPid,
        url: snap.url || ebState.url,
        platform: snap.platform || '',
        platform_item_id: snap.platform_item_id || '',
        title: snap.title || ebState.title || '',
        thumbnail_url: snap.thumbnail_url || '',
        author: snap.author || '',
        author_url: snap.author_url || '',
        published_at: snap.published_at || '',
        duration_sec: snap.duration_sec ?? null,
        raw_metrics: snap.raw_metrics || {},
        search_keyword: activeQueryText.trim(),
        collected_at: snap.collected_at || '',
      });
      if (activeProjectIdRef.current !== reqPid) return;
      if (res?.ok) {
        setCapturePreview({
          ...res.preview,
          extract_status: snap.extract_status || (res.preview?.identity_verified ? 'complete' : 'identity_unverified'),
          raw_page_url: snap.raw_page_url || ebState.url,
        });
      } else {
        setCaptureModalOpen(false);
        showToast('提取预览失败：' + (res?.error || '后端未返回有效预览'));
      }
    } catch (e: any) {
      setCaptureModalOpen(false);
      if (researchBrowser && browserWasVisibleRef.current) {
        researchBrowser.setVisible(true);
      }
      showToast('提取当前视频失败：' + (e?.message || e));
    } finally {
      setCaptureLoading(false);
    }
  };

  const closeCaptureModal = () => {
    setCaptureModalOpen(false);
    if (researchBrowser && browserWasVisibleRef.current) {
      researchBrowser.setVisible(true);
    }
  };

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 4500);
  };

  // FIX-01 & FIX-09: 仅当 SearchHub 处于激活态且未打开收录弹窗时才显示 researchView，切换页面仅隐藏保活不重加载
  useEffect(() => {
    if (!researchBrowser) return;
    if (!isActive || captureModalOpen) {
      researchBrowser.setVisible(false).catch(() => {});
      return;
    }
    const el = browserHostRef.current;
    if (el && ebState.url) {
      const r = el.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 80) {
        researchBrowser.setBounds({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) })
          .then(() => researchBrowser.setVisible(true))
          .catch(() => {});
      }
    }
  }, [isActive, captureModalOpen, researchBrowser]);
  useEffect(() => {
    if (!researchBrowser) return;
    const syncRect = () => {
      const el = browserHostRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 80) {
        researchBrowser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
    };
    const unsub = researchBrowser.onState((st) => {
      setEbState(st);
      if (st?.url) setAddressBar(st.url);
    });
    researchBrowser.getState().then((st) => {
      if (st) {
        setEbState(st);
        if (st.url) {
          setAddressBar(st.url);
          // 关键：返回 SearchHub 时，若 researchView 已有原网页，立即恢复显示并贴合容器，绝不强制 reload
          setTimeout(() => {
            syncRect();
            researchBrowser.setVisible(true).catch(() => {});
          }, 60);
        }
      }
    }).catch(() => {});

    const ro = new ResizeObserver(syncRect);
    if (browserHostRef.current) ro.observe(browserHostRef.current);
    window.addEventListener('resize', syncRect);
    const t = setTimeout(syncRect, 120);

    return () => {
      unsub();
      ro.disconnect();
      window.removeEventListener('resize', syncRect);
      clearTimeout(t);
      // 离开 SearchHub：暂停视频并隐藏 researchView，不销毁实例、不清空 URL
      researchBrowser.setVisible(false).catch(() => {});
    };
  }, [researchBrowser]);

  useEffect(() => {
    if (!researchBrowser) return;
    const t = setTimeout(() => {
      const el = browserHostRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 80) {
        researchBrowser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
    }, 40);
    return () => clearTimeout(t);
  }, [dimsCollapsed, candsCollapsed, researchMaximized, activeEmbed.embedUrl, researchBrowser]);

  // 实时跟踪当前项目研究快照，用于切换项目或卸载前无感保存
  useEffect(() => {
    stateSnapshotRef.current = {
      root_input: rootInput,
      active_cand_id: activeCandId,
      active_query_text: activeQueryText,
      active_platform_id: activePlatform?.id || '',
      last_browser_url: ebState.url || addressBar || '',
      judge_reason: judgeReason,
      dims_collapsed: dimsCollapsed,
      cands_collapsed: candsCollapsed,
    };
  }, [rootInput, activeCandId, activeQueryText, activePlatform, ebState.url, addressBar, judgeReason, dimsCollapsed, candsCollapsed]);

  const loadAll = async (keepCandId?: number | null, forProjectId?: number) => {
    const reqPid = forProjectId ?? projectId;
    const [treeRes, candRes, platRes, projStateRes] = await Promise.all([
      api.researchFlowTree(reqPid).catch(() => ({ nodes: [], presets: [] })),
      api.researchFlowListCandidates(reqPid).catch(() => ({ candidates: [] })),
      api.researchFlowPlatforms().catch(() => ({ platforms: [] })),
      api.researchFlowGetProjectState(reqPid).catch(() => null),
    ]);
    // FIX-A04 异步归属守卫：若等待期间用户已切换至其他项目，立即丢弃过期响应
    if (activeProjectIdRef.current !== reqPid) return;

    setNodes(treeRes?.nodes || []);
    setPresets(treeRes?.presets || []);
    const cList = candRes?.candidates || [];
    setCandidates(cList);
    const pList = platRes?.platforms || [];
    setPlatforms(pList);

    const savedSt = projStateRes?.state || {};
    if (keepCandId === null && savedSt.root_input !== undefined) {
      setRootInput(savedSt.root_input || '');
      setJudgeReason(savedSt.judge_reason || '');
      setDimsCollapsed(Boolean(savedSt.dims_collapsed));
      setCandsCollapsed(Boolean(savedSt.cands_collapsed));
      if (savedSt.active_platform_id) {
        const mp = pList.find((x: any) => x.id === savedSt.active_platform_id);
        if (mp) setActivePlatform(mp);
      } else {
        setActivePlatform(null);
      }
      if (savedSt.last_browser_url) {
        setAddressBar(savedSt.last_browser_url);
      }
    }

    const targetCid =
      keepCandId !== undefined && keepCandId !== null
        ? keepCandId
        : savedSt.active_cand_id && cList.some((c: any) => c.id === savedSt.active_cand_id)
          ? savedSt.active_cand_id
          : activeCandId;

    if (targetCid && cList.some((c: any) => c.id === targetCid)) {
      await selectCandidate(cList.find((c: any) => c.id === targetCid), reqPid, savedSt.active_query_text);
    } else if (cList.length > 0) {
      await selectCandidate(cList[0], reqPid);
    } else {
      setActiveCandId(null);
      setActiveQueryText(savedSt.active_query_text || '');
      setEvidences([]);
    }
  };

  const selectCandidate = async (c: any, forProjectId?: number, savedQuery?: string) => {
    const reqPid = forProjectId ?? projectId;
    setActiveCandId(c.id);
    setActiveQueryText(savedQuery || c.search_queries_zh?.[0] || c.search_queries_en?.[0] || c.title);
    const evRes = await api.researchFlowListEvidence(reqPid, c.id).catch(() => ({ evidences: [] }));
    if (activeProjectIdRef.current !== reqPid) return;
    const evList = evRes?.evidences || [];
    setEvidences(evList);
    const firstEmbed = evList.find((e: any) => parseEmbedUrl(e.url || '').kind !== null);
    if (firstEmbed) {
      const parsed = parseEmbedUrl(firstEmbed.url);
      setActiveEmbed({ ...parsed, rawUrl: firstEmbed.url, title: firstEmbed.title || firstEmbed.url });
    }
  };

  // FIX-A04: 切换研究项目时，先持久化保存原项目状态，再立即清空并加载目标项目状态
  useEffect(() => {
    const prevPid = prevProjectIdRef.current;
    if (prevPid && prevPid !== projectId) {
      api.researchFlowSaveProjectState({ project_id: prevPid, ...stateSnapshotRef.current }).catch(() => {});
    }
    activeProjectIdRef.current = projectId;
    prevProjectIdRef.current = projectId;
    setNodes([]);
    setPresets([]);
    setCandidates([]);
    setActiveCandId(null);
    setEvidences([]);
    setActiveQueryText('');
    setRootInput('');
    setJudgeReason('');
    setActiveEmbed({ kind: null, embedUrl: '', label: '', rawUrl: '', title: '' });
    loadAll(null, projectId);
  }, [projectId]);

  useEffect(() => {
    return () => {
      const curPid = activeProjectIdRef.current;
      if (curPid) {
        api.researchFlowSaveProjectState({ project_id: curPid, ...stateSnapshotRef.current }).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (externalQuery) setRootInput(externalQuery);
  }, [externalQuery]);

  // 平铺维度（只展示 level=1，彻底隐藏多层树；历史数据保留在库中不删）
  const flatDims = useMemo(() => nodes.filter((n) => n.level === 1), [nodes]);
  const rootNode = useMemo(() => nodes.find((n) => n.level === 0) || null, [nodes]);
  const selectedDims = useMemo(() => flatDims.filter((n) => n.is_selected), [flatDims]);
  const activeCand = useMemo(() => candidates.find((c) => c.id === activeCandId) || null, [candidates, activeCandId]);

  const handleRecommendDims = async () => {
    const topic = rootInput.trim();
    if (!topic) { showToast('请输入原始研究主题（如：汽车）'); return; }
    const reqPid = projectId;
    setCreatingRoot(true);
    try {
      const r = await api.researchFlowCreateRoot({ project_id: reqPid, root_topic: topic, max_children: dimGenCount });
      if (activeProjectIdRef.current !== reqPid) return;
      if (r?.ok) {
        setRootInput(topic);
        setDimsCollapsed(false);
        showToast(
          `✅ AI 维度词生成完成：新增 ${r.children?.length || 0} 个维度词` +
            (r.dedup_removed ? `（语义去重 ${r.dedup_removed} 个重复/近义项）` : '')
        );
        await loadAll(undefined, reqPid);
      }
    } catch (e: any) {
      if (activeProjectIdRef.current === reqPid) showToast('AI 维度词生成失败：' + e.message);
    } finally {
      if (activeProjectIdRef.current === reqPid) setCreatingRoot(false);
    }
  };

  const handleAiRandomRecommend = async () => {
    const reqPid = projectId;
    try {
      const r = await api.researchFlowAiRecommendDims({ project_id: reqPid, count: randomCount });
      if (activeProjectIdRef.current !== reqPid) return;
      if (r?.ok) {
        const names = (r.recommendations || []).map((x: any) => x.name).join('、');
        setAiRecNote(`启发式推荐（非真实市场算法）：已选 ${names} — ${r.rule_disclaimer}`);
        showToast(`✅ AI 随机推荐已勾选 ${r.selected_ids?.length || 0} 个互补维度（启发式规则）`);
        await loadAll(undefined, reqPid);
      }
    } catch (e: any) {
      showToast('AI 随机推荐失败：' + e.message);
    }
  };

  const handleBatchSelect = async (action: string, nodeIds?: number[]) => {
    const reqPid = projectId;
    await api.researchFlowBatchSelect({ project_id: reqPid, action, random_count: randomCount, node_ids: nodeIds });
    if (activeProjectIdRef.current === reqPid) await loadAll(undefined, reqPid);
  };

  const handleGenerateCandidates = async () => {
    if (selectedDims.length === 0) { showToast('请先在上方勾选至少 1 个研究维度'); return; }
    const reqPid = projectId;
    setGeneratingCands(true);
    try {
      const r = await api.researchFlowGenerateCandidates({
        project_id: reqPid,
        node_ids: selectedDims.map((n) => n.id),
        max_count: candGenCount,
      });
      if (activeProjectIdRef.current !== reqPid) return;
      if (r?.ok) {
        setCandsCollapsed(false);
        showToast(`✅ 已基于 ${selectedDims.length} 个维度生成 ${r.candidates?.length || 0} 个候选选题（已排重拒绝项）`);
        await loadAll(r.candidates?.[0]?.id ?? null, reqPid);
      }
    } catch (e: any) {
      if (activeProjectIdRef.current === reqPid) showToast('生成候选选题失败：' + e.message);
    } finally {
      if (activeProjectIdRef.current === reqPid) setGeneratingCands(false);
    }
  };

  const handleRegenerateCandidates = async (mode: 'single' | 'batch' | 'all', targetIds?: number[]) => {
    if (selectedDims.length === 0) { showToast('请先在上方勾选至少 1 个研究维度'); return; }
    const reqPid = projectId;
    setGeneratingCands(true);
    try {
      const r = await api.researchFlowRegenerateCandidates({
        project_id: reqPid,
        node_ids: selectedDims.map((n) => n.id),
        max_count: mode === 'single' ? 1 : mode === 'batch' ? (targetIds?.length || candGenCount) : candGenCount,
        mode,
        target_candidate_ids: targetIds,
      });
      if (activeProjectIdRef.current !== reqPid) return;
      if (r?.ok) {
        setCheckedCandIds([]);
        showToast(
          `✅ 重新生成 ${r.candidates?.length || 0} 条候选选题` +
            (r.protected_skipped ? `（已自动保留 ${r.protected_skipped} 条锁定/有证据/已入库选题）` : '')
        );
        await loadAll(r.candidates?.[0]?.id ?? null, reqPid);
      }
    } catch (e: any) {
      if (activeProjectIdRef.current === reqPid) showToast('重新生成失败：' + e.message);
    } finally {
      if (activeProjectIdRef.current === reqPid) setGeneratingCands(false);
    }
  };

  const handleToggleLockCandidate = async (c: any) => {
    const nextLock = c.is_locked ? 0 : 1;
    await api.researchFlowPatchCandidate(c.id, { project_id: projectId, is_locked: nextLock });
    showToast(nextLock ? '🔒 已锁定该满意选题（重新生成时自动保留）' : '🔓 已解除选题锁定');
    await loadAll(c.id, projectId);
  };

  const handleOpenPlatformResearch = (p: any) => {
    setActivePlatform(p);
    setDimsCollapsed(true);
    const q = activeQueryText.trim() || activeCand?.title || '';
    const targetUrl = p.supports_query_url && p.search_url_template && q
      ? p.search_url_template.replace(/\{q\}/g, encodeURIComponent(q))
      : p.base_url;

    if (!p.supports_query_url && q) {
      navigator.clipboard?.writeText(q).catch(() => {});
    }

    if (researchBrowser) {
      setActiveEmbed({ kind: null, embedUrl: '', label: '', rawUrl: '', title: '' });
      const el = browserHostRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        researchBrowser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
      researchBrowser.navigate(targetUrl);
      setAddressBar(targetUrl);
      api.researchFlowSaveProjectState({ project_id: projectId, active_platform_id: p.id, last_browser_url: targetUrl }).catch(() => {});
      showToast(`🌐 已在中央内置浏览器加载 ${p.name}${!p.supports_query_url && q ? `（已复制搜索词「${q}」）` : ''}`);
      return;
    }
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  };

  const handleCaptureEvidence = async () => {
    if (!activeCand) return;
    try {
      const r = await api.researchFlowCaptureEvidence({
        project_id: projectId,
        candidate_topic_id: activeCand.id,
        evidence_type: evType,
        url: evUrl.trim(),
        title: evTitle.trim() || evUrl.trim(),
        author: evAuthor.trim(),
        platform: evPlatform,
        view_count: evViews.trim() === '' ? null : Number(evViews),
        like_count: evLikes.trim() === '' ? null : Number(evLikes),
        search_keyword: activeQueryText.trim(),
        user_note: evNote.trim(),
        data_source: 'workbench_manual',
        capture_method: 'manual_form',
      });
      if (r?.ok) {
        const parsed = parseEmbedUrl(evUrl.trim());
        if (parsed.kind) setActiveEmbed({ ...parsed, rawUrl: evUrl.trim(), title: evTitle.trim() || evUrl.trim() });
        setEvUrl(''); setEvTitle(''); setEvAuthor(''); setEvViews(''); setEvLikes(''); setEvNote('');
        showToast('✅ 已收录人工研究证据（绝不自动加入文案工坊）');
        await loadAll(activeCand.id);
      }
    } catch (e: any) {
      showToast('收录证据失败：' + e.message);
    }
  };

  const handleConfirmToTopicHub = async () => {
    if (!activeCand) return;
    setConfirmBusy(true);
    try {
      const r = await api.researchFlowConfirmCandidate(activeCand.id, {
        project_id: projectId,
        judge_reason: judgeReason.trim() || '人工多平台同屏研究确认',
      });
      if (r?.ok) {
        setJudgeReason('');
        showToast(`⭐ 已确认并保存至 TopicHub（选题 #${r.topic_id}，关联 ${r.evidence_count} 条证据）`);
        await loadAll(activeCand.id);
      }
    } catch (e: any) {
      showToast('确认失败：' + e.message);
    } finally {
      setConfirmBusy(false);
    }
  };

  const toggleMaximize = () => {
    const next = !researchMaximized;
    setResearchMaximized(next);
    setDimsCollapsed(next);
    setCandsCollapsed(next);
  };

  return (
    <div className="h-full flex flex-col gap-2 gcw-workspace p-2.5 rounded-xl overflow-hidden">
      {/* ① 顶部研究维度区（目标占比 ~10%，平铺式，支持一键折叠） */}
      <div className="gcw-panel px-3 py-2 shrink-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button onClick={() => setDimsCollapsed((v) => !v)} className="flex items-center gap-1 font-bold text-slate-100 hover:text-cyan-300 transition">
            {dimsCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-cyan-400" /> : <ChevronUp className="w-3.5 h-3.5 text-cyan-400" />}
            <span>① 研究维度</span>
            <span className="font-mono-num gcw-text-tag text-cyan-300">({selectedDims.length}/{flatDims.length})</span>
          </button>

          <input
            value={rootInput}
            onChange={(e) => setRootInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRecommendDims()}
            placeholder="输入原始主题（如：汽车）..."
            className="gcw-input w-44 px-2.5 py-1 text-xs"
          />
          <input
            type="number"
            min={1}
            max={30}
            value={dimGenCount}
            onChange={(e) => setDimGenCount(Math.max(1, Math.min(30, Number(e.target.value) || 10)))}
            title="自定义生成维度词数量 (1~30)"
            className="gcw-input w-12 px-1 py-1 text-center font-mono-num text-xs"
          />
          <button onClick={handleRecommendDims} disabled={creatingRoot} className="gcw-btn-purple px-2.5 py-1 rounded-lg font-semibold text-xs flex items-center gap-1 disabled:opacity-50">
            {creatingRoot ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            AI 维度词生成
          </button>
          <input
            type="number"
            min={1}
            max={30}
            value={candGenCount}
            onChange={(e) => setCandGenCount(Math.max(1, Math.min(30, Number(e.target.value) || 5)))}
            title="自定义候选选题生成数量 (1~30，无固定15条限制)"
            className="gcw-input w-12 px-1 py-1 text-center font-mono-num text-xs"
          />
          <button onClick={handleGenerateCandidates} disabled={generatingCands || selectedDims.length === 0} className="gcw-btn-cyan px-2.5 py-1 rounded-lg font-semibold text-xs flex items-center gap-1 disabled:opacity-40">
            {generatingCands ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            生成候选选题
          </button>

          <div className="ml-auto flex items-center gap-1.5 gcw-text-tag">
            <span className={`px-2 py-0.5 rounded-full border font-medium ${isElectron ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-amber-500/15 border-amber-500/40 text-amber-300'}`}>
              {isElectron ? '● 独立研究浏览器已就绪 (researchView)' : '⚠ 浏览器模式（建议用桌面外壳）'}
            </span>
            <button onClick={() => setCandsCollapsed((v) => !v)} className="gcw-btn-ghost px-2 py-0.5 rounded gcw-text-tag">
              {candsCollapsed ? '展开选题' : '收起选题'}
            </button>
            <button onClick={toggleMaximize} className={`px-2 py-0.5 rounded gcw-text-tag font-semibold flex items-center gap-1 ${researchMaximized ? 'gcw-tab-active' : 'gcw-btn-ghost'}`}>
              {researchMaximized ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
              {researchMaximized ? '恢复布局' : '最大化研究区'}
            </button>
          </div>
        </div>

        {!dimsCollapsed && (
          <div className="pt-1.5 border-t border-[#1E2E4A] space-y-1.5 gcw-text-tag">
            <div className="flex flex-wrap items-center gap-1.5">
              {flatDims.length === 0 ? (
                <span className="text-slate-500">输入主题点击「AI 推荐维度」，平铺展示后勾选即可直接生成候选选题。</span>
              ) : (
                flatDims.map((d) => (
                  <button
                    key={d.id}
                    onClick={async () => { await api.researchFlowPatchNode(d.id, { project_id: projectId, is_selected: d.is_selected ? 0 : 1 }); await loadAll(); }}
                    className={`px-2.5 py-0.5 rounded-full ${d.is_selected ? 'gcw-chip-active font-semibold' : 'gcw-chip'}`}
                  >
                    {d.name}
                  </button>
                ))
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 gcw-text-meta text-slate-400">
              <button onClick={() => handleBatchSelect('all')} className="text-cyan-400 hover:underline">全选</button>
              <button onClick={() => handleBatchSelect('none')} className="text-slate-400 hover:text-slate-200 hover:underline">全不选</button>
              <button onClick={() => handleBatchSelect('invert')} className="text-slate-400 hover:text-slate-200 hover:underline">反选</button>
              <button onClick={handleAiRandomRecommend} className="gcw-btn-ghost px-2 py-0.2 rounded inline-flex items-center gap-0.5 text-cyan-300" title="启发式加权规则：相关性30%+差异性25%+探索价值20%+历史覆盖15%+随机因子10%">
                <Shuffle className="w-2.5 h-2.5" />AI 随机推荐
              </button>
              <input type="number" min={1} max={20} value={randomCount} onChange={(e) => setRandomCount(Number(e.target.value) || 4)} className="gcw-input w-9 px-1 text-center font-mono-num" />
              <input value={customDimInput} onChange={(e) => setCustomDimInput(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter' && customDimInput.trim()) { await api.researchFlowAddNode({ project_id: projectId, parent_id: rootNode?.id ?? null, name: customDimInput.trim() }); setCustomDimInput(''); await loadAll(); } }} placeholder="+ 自定义维度..." className="gcw-input w-28 px-1.5 py-0.5" />
              <button onClick={async () => { if (!customDimInput.trim()) return; await api.researchFlowAddNode({ project_id: projectId, parent_id: rootNode?.id ?? null, name: customDimInput.trim() }); setCustomDimInput(''); await loadAll(); }} className="gcw-btn-cyan px-1.5 py-0.5 rounded"><Plus className="w-3 h-3" /></button>
              <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="常用组合名..." className="gcw-input w-24 px-1.5 py-0.5" />
              <button onClick={async () => { if (!presetName.trim() || selectedDims.length === 0) return; await api.researchFlowSavePreset({ project_id: projectId, name: presetName.trim(), node_ids: selectedDims.map((n) => n.id) }); setPresetName(''); showToast('✅ 已保存常用维度组合'); await loadAll(); }} className="px-2 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white font-medium">存组合</button>
              {presets.map((pr) => (
                <button key={pr.id} onClick={() => handleBatchSelect('set_ids', pr.node_ids)} className="gcw-chip px-2 py-0.2 rounded-full text-cyan-300">{pr.name}</button>
              ))}
            </div>
            {aiRecNote && <div className="gcw-text-meta text-amber-300/90 pt-0.5">{aiRecNote}</div>}
          </div>
        )}
      </div>

      {toast && <div className="px-3 py-1 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-xs shrink-0">{toast}</div>}

      {/* 下部主体：② 左侧候选选题区 (~15%，可折叠，支持锁定/单条/批量/全部重生成) + ③ 主体真实市场研究区 */}
      <div className="flex-1 flex gap-2 min-h-0 overflow-hidden">
        {!candsCollapsed && (
          <div className="w-64 shrink-0 gcw-panel flex flex-col overflow-hidden">
            <div className="px-2.5 py-2 gcw-panel-header flex justify-between items-center text-xs font-semibold text-slate-200 gap-1">
              <span>② 候选选题 <span className="font-mono-num text-cyan-300">({candidates.length})</span></span>
              <div className="flex items-center gap-1">
                {checkedCandIds.length > 0 && (
                  <button
                    onClick={() => handleRegenerateCandidates('batch', checkedCandIds)}
                    disabled={generatingCands}
                    className="px-1.5 py-0.5 rounded bg-cyan-600/80 hover:bg-cyan-500 text-white gcw-text-meta"
                    title="批量重生成已勾选的未锁定选题"
                  >
                    重生成({checkedCandIds.length})
                  </button>
                )}
                <button
                  onClick={() => handleRegenerateCandidates('all')}
                  disabled={generatingCands || candidates.length === 0}
                  className="gcw-btn-ghost px-1.5 py-0.5 rounded gcw-text-meta disabled:opacity-40"
                  title="全部重生成（自动保留已锁定、已收录证据及已入 TopicHub 的选题）"
                >
                  全部重生成
                </button>
                <button onClick={() => setCandsCollapsed(true)} className="text-slate-400 hover:text-cyan-300" title="收起候选选题区"><ChevronLeft className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-[#1A2842]">
              {candidates.length === 0 ? (
                <div className="p-4 gcw-text-tag text-slate-500">勾选维度后点击上方「生成候选选题」。</div>
              ) : (
                candidates.map((c) => {
                  const isProtected = Boolean(c.is_locked) || Boolean(c.confirmed_topic_id) || Number(c.evidence_count || 0) > 0;
                  return (
                    <div
                      key={c.id}
                      onClick={() => selectCandidate(c)}
                      className={`p-2.5 cursor-pointer space-y-1 text-xs transition ${activeCandId === c.id ? 'bg-cyan-500/12 border-l-2 border-cyan-400' : 'hover:bg-[#162238]'}`}
                    >
                      <div className="flex items-center justify-between gap-1 gcw-text-meta">
                        <div className="flex items-center gap-1">
                          {!isProtected && c.status !== 'eliminated' && (
                            <input
                              type="checkbox"
                              checked={checkedCandIds.includes(c.id)}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                const ck = e.target.checked;
                                setCheckedCandIds((prev) => (ck ? [...prev, c.id] : prev.filter((x) => x !== c.id)));
                              }}
                              className="accent-cyan-400"
                            />
                          )}
                          <span className={c.status === 'confirmed' ? 'text-emerald-400 font-semibold' : c.status === 'eliminated' ? 'text-rose-400' : 'text-cyan-300'}>
                            {c.status === 'confirmed' ? `已入Topic#${c.confirmed_topic_id}` : c.status === 'eliminated' ? '已淘汰' : '待验证'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => handleToggleLockCandidate(c)}
                            className={`px-1 rounded gcw-text-meta ${c.is_locked ? 'text-amber-300 bg-amber-500/15' : 'text-slate-500 hover:text-slate-200'}`}
                            title={c.is_locked ? '已锁定（点击解锁）' : '锁定满意选题（重生成时自动保留）'}
                          >
                            {c.is_locked ? '🔒' : '🔓'}
                          </button>
                          {!isProtected && c.status !== 'eliminated' && (
                            <button
                              type="button"
                              onClick={() => handleRegenerateCandidates('single', [c.id])}
                              disabled={generatingCands}
                              className="text-slate-400 hover:text-cyan-300 gcw-text-meta px-0.5"
                              title="单条重新生成此候选选题"
                            >
                              ↻
                            </button>
                          )}
                          <span className="text-slate-500 font-mono-num">证{c.evidence_count}</span>
                        </div>
                      </div>
                      <div className="font-semibold text-slate-100 line-clamp-2 leading-snug">{c.title}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ③ 真实市场研究主区（目标占比 75%—95%：左 70% 同屏浏览/官方视频播放 + 右 30% 侧边证据收录） */}
        <div className="flex-1 gcw-panel flex flex-col min-w-0 overflow-hidden">
          {/* 研究控制头：平台切换 + 搜索词 */}
          <div className="px-3 py-2 gcw-panel-header space-y-1.5 shrink-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {candsCollapsed && (
                <button onClick={() => setCandsCollapsed(false)} className="gcw-btn-ghost px-1.5 py-0.5 rounded gcw-text-tag flex items-center gap-0.5">
                  <ChevronRight className="w-3.5 h-3.5" /> 选题
                </button>
              )}
              <span className="font-bold text-slate-100 truncate max-w-[340px]">
                ③ 真实市场研究：<span className="text-cyan-300 font-semibold">{activeCand ? activeCand.title : '请先选择候选选题'}</span>
              </span>
              <input
                value={activeQueryText}
                onChange={(e) => setActiveQueryText(e.target.value)}
                placeholder="当前研究搜索词..."
                className="gcw-input flex-1 min-w-[160px] px-2.5 py-0.5 text-xs"
              />
              <button
                onClick={openVaultModal}
                className="px-2.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 gcw-text-tag font-semibold text-cyan-300 hover:bg-cyan-500/25 flex items-center gap-1 shrink-0 transition"
                title="管理并复制各平台登录账号密码（本机 Windows DPAPI 加密存储）"
              >
                <KeyRound className="w-3 h-3" /> 账号保险箱
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 gcw-text-tag">
              {platforms.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleOpenPlatformResearch(p)}
                  className={`px-2.5 py-0.5 rounded-full flex items-center gap-1 ${activePlatform?.id === p.id ? 'gcw-tab-active font-semibold' : 'gcw-chip'}`}
                >
                  <span>{p.name}</span>
                  <ExternalLink className="w-2.5 h-2.5 opacity-70" />
                </button>
              ))}
            </div>
          </div>

          {/* 主研究体：左 70% 真实同屏浏览/官方嵌入播放器 + 右 30% 证据收录与笔记 */}
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* 左 70%：真实内置浏览器 (WebContentsView) / 官方嵌入播放区 */}
            <div className="flex-1 flex flex-col min-w-0 border-r border-[#1E2E4A] bg-[#0B111E]">
              {isElectron ? (
                <>
                  {/* Electron 内置浏览器导航栏：后退 / 前进 / 刷新 / 真实网址 / 一键填入右侧证据栏 */}
                  <div className="px-2.5 py-1.5 border-b border-[#1E2E4A] bg-[#111A2E] flex items-center gap-1.5 gcw-text-tag shrink-0">
                    <button onClick={() => researchBrowser?.back()} disabled={!ebState.canGoBack} className="gcw-btn-ghost p-1 rounded disabled:opacity-30" title="后退">
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => researchBrowser?.forward()} disabled={!ebState.canGoForward} className="gcw-btn-ghost p-1 rounded disabled:opacity-30" title="前进">
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => researchBrowser?.reload()} className="gcw-btn-ghost p-1 rounded" title="刷新">
                      <RotateCw className={`w-3.5 h-3.5 ${ebState.isLoading ? 'animate-spin text-cyan-400' : ''}`} />
                    </button>
                    <Globe className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-0.5" />
                    <input
                      value={addressBar}
                      onChange={(e) => setAddressBar(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && addressBar.trim()) {
                          const raw = addressBar.trim();
                          const ext = extractShareLinks(raw);
                          if (ext.urls.length > 1) {
                            setAddressMultiLinks(ext.urls);
                            showToast(`识别到 ${ext.urls.length} 个链接，请在地址栏下方人工选择`);
                            return;
                          }
                          setAddressMultiLinks([]);
                          if (ext.urls.length === 1) {
                            const targetUrl = ext.urls[0];
                            if (raw !== targetUrl || /v\.douyin\.com|b23\.tv|xhslink\.com/i.test(targetUrl)) {
                              setLastOriginalShareUrl(targetUrl);
                            } else {
                              setLastOriginalShareUrl('');
                            }
                            setAddressBar(targetUrl);
                            researchBrowser?.navigate(targetUrl);
                            showToast(`✅ 已提取分享链接并通过内置浏览器打开：${targetUrl}`);
                            return;
                          }
                          if (ext.rejectedUrls.length > 0) {
                            showToast(`⚠️ 已拦截非预期协议或域名链接：${ext.rejectedUrls[0]}`);
                            return;
                          }
                          const u = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
                          researchBrowser?.navigate(u);
                        }
                      }}
                      placeholder="粘贴网址或完整抖音分享文本（如 2.05 aAg:/ ... https://v.douyin.com/...）回车浏览..."
                      className="gcw-input flex-1 px-2.5 py-0.5 gcw-text-tag font-mono-num"
                    />
                    <button
                      onClick={handleOpenOneClickCapture}
                      className="gcw-btn-cyan px-2.5 py-0.5 rounded font-semibold flex items-center gap-1 shrink-0"
                      title="自动提取当前真实视频数据并一键收录至 TopicHub"
                    >
                      <BookmarkPlus className="w-3.5 h-3.5" /> 加入选题库
                    </button>
                    <button
                      onClick={() => {
                        if (!ebState.url) { showToast('请先在中央内置浏览器打开任意平台页面'); return; }
                        setEvUrl(ebState.url);
                        setEvTitle(ebState.title || ebState.url);
                        if (ebState.url.includes('youtube.com')) setEvPlatform('youtube');
                        else if (ebState.url.includes('bilibili.com')) setEvPlatform('bilibili');
                        else if (ebState.url.includes('douyin.com') || ebState.url.includes('oceanengine.com')) setEvPlatform('douyin');
                        else if (ebState.url.includes('baidu.com')) setEvPlatform('baidu');
                        else if (ebState.url.includes('google.com')) setEvPlatform('google');
                        else if (ebState.url.includes('xiaohongshu.com')) setEvPlatform('xiaohongshu');
                        else if (ebState.url.includes('reddit.com')) setEvPlatform('reddit');
                        else if (ebState.url.includes('zhihu.com')) setEvPlatform('zhihu');
                        showToast('✅ 已将当前真实网页的 URL 与标题填入右侧证据收录栏');
                      }}
                      className="gcw-btn-ghost px-2 py-0.5 rounded shrink-0"
                    >
                      填至右侧
                    </button>
                  </div>
                  {addressMultiLinks.length > 1 && (
                    <div className="px-2.5 py-1.5 bg-amber-500/12 border-b border-amber-500/35 flex flex-wrap items-center gap-1.5 gcw-text-meta shrink-0">
                      <span className="text-amber-300 font-semibold">识别到多个链接，请人工选择打开：</span>
                      {addressMultiLinks.map((u) => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => {
                            setAddressMultiLinks([]);
                            setAddressBar(u);
                            setLastOriginalShareUrl(u);
                            researchBrowser?.navigate(u);
                          }}
                          className="px-2 py-0.5 rounded bg-slate-900 hover:bg-cyan-600/30 border border-slate-700 text-cyan-200 font-mono-num truncate max-w-[280px]"
                        >
                          {u}
                        </button>
                      ))}
                      <button type="button" onClick={() => setAddressMultiLinks([])} className="text-slate-400 hover:text-white ml-auto">取消</button>
                    </div>
                  )}
                  {ebState.lastError && (
                    <div className="px-2.5 py-1 bg-rose-500/15 border-b border-rose-500/35 text-rose-300 gcw-text-meta shrink-0">
                      ⚠ {ebState.lastError}
                    </div>
                  )}
                  {/* WebContentsView 精准挂载占位容器（外部网页保持原始样式，不注入深色CSS） */}
                  <div ref={browserHostRef} className="flex-1 relative bg-[#0B111E] flex items-center justify-center">
                    {!ebState.visible && (
                      <div className="text-center space-y-2 p-6 text-xs text-slate-400">
                        <div className="font-bold text-slate-100 text-sm">🖥️ 内置真实浏览器已就绪</div>
                        <div>点击上方 <strong className="text-cyan-300">抖音热点榜 / 抖音主页 / 知乎 / 百度 / Google / YouTube</strong> 等任意平台，真实官方网页将直接在此区域加载，无需跳转外部浏览器。</div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* 站内官方嵌入视频直达条（普通浏览器模式兜底：YouTube / B站） */}
                  <div className="px-3 py-1.5 border-b border-[#1E2E4A] bg-[#111A2E] flex items-center gap-2 gcw-text-tag">
                    <span className="font-semibold text-slate-300 shrink-0">站内官方播放器：</span>
                    <input
                      value={embedInputUrl}
                      onChange={(e) => setEmbedInputUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const p = parseEmbedUrl(embedInputUrl);
                          if (p.kind) setActiveEmbed({ ...p, rawUrl: embedInputUrl.trim(), title: embedInputUrl.trim() });
                          else showToast('仅支持 YouTube 或 B站 官方视频链接嵌入播放');
                        }
                      }}
                      placeholder="粘贴 YouTube 或 B站视频链接即可在此主区同屏播放..."
                      className="gcw-input flex-1 px-2.5 py-0.5 gcw-text-tag"
                    />
                    <button
                      onClick={() => {
                        const p = parseEmbedUrl(embedInputUrl);
                        if (p.kind) setActiveEmbed({ ...p, rawUrl: embedInputUrl.trim(), title: embedInputUrl.trim() });
                        else showToast('仅支持 YouTube 或 B站官方视频链接站内嵌入；其余网站请使用 Electron 桌面外壳');
                      }}
                      className="gcw-btn-cyan px-2.5 py-0.5 rounded font-semibold flex items-center gap-1"
                    >
                      <Play className="w-3 h-3" /> 站内播放
                    </button>
                  </div>

                  {activeEmbed.embedUrl ? (
                    <div className="flex-1 flex flex-col min-h-0">
                      <div className="px-3 py-1 bg-[#131E36] border-b border-[#1E2E4A] flex justify-between items-center gcw-text-tag">
                        <span className="font-semibold text-slate-200 truncate">{activeEmbed.label} · {activeEmbed.title}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <a href={activeEmbed.rawUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">原网页打开 ↗</a>
                          <button onClick={() => setActiveEmbed({ kind: null, embedUrl: '', label: '', rawUrl: '', title: '' })} className="text-slate-400 hover:text-slate-200">关闭播放器</button>
                        </div>
                      </div>
                      <iframe
                        src={activeEmbed.embedUrl}
                        title={activeEmbed.title}
                        className="flex-1 w-full border-0 bg-black"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                      />
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-3">
                      <div className="text-sm font-bold text-slate-100">
                        真实市场同屏研究主区（建议使用桌面版打开内置浏览器）
                      </div>
                      <div className="max-w-lg text-xs text-slate-400 leading-relaxed space-y-2">
                        <p>双击桌面快捷方式 <strong className="text-cyan-300">Global Content Workbench</strong> 启动 Electron 桌面版后，抖音热点榜、抖音主页、知乎、小红书、Google、YouTube、B站均可在此中央区域直接加载交互。</p>
                        {activePlatform && (
                          <div className="pt-1">
                            <a
                              href={activePlatform.supports_query_url && activePlatform.search_url_template && activeQueryText ? activePlatform.search_url_template.replace(/\{q\}/g, encodeURIComponent(activeQueryText)) : activePlatform.base_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="gcw-btn-cyan inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-semibold"
                            >
                              在独立标签页打开 {activePlatform.name} <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 右 30%：紧凑证据收录与研究笔记侧边条 */}
            <div className="w-80 shrink-0 flex flex-col overflow-hidden bg-[#111A2E]">
              <div className="px-2.5 py-1.5 gcw-panel-header gcw-text-tag font-semibold flex justify-between text-slate-200">
                <span>证据收录与笔记 <span className="font-mono-num text-cyan-300">({evidences.length})</span></span>
                <span className="gcw-text-meta text-slate-400">不自动进文案工坊</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5 gcw-text-tag">
                {/* 快速录入表单 */}
                <div className="space-y-1.5 pb-2.5 border-b border-[#1E2E4A]">
                  <div className="flex gap-1">
                    <select value={evType} onChange={(e) => setEvType(e.target.value as any)} className="gcw-input px-1.5 py-1 gcw-text-tag">
                      <option value="video">视频</option>
                      <option value="article">文章</option>
                      <option value="comment_text">评论</option>
                      <option value="data_snapshot">数据</option>
                    </select>
                    <input value={evPlatform} onChange={(e) => setEvPlatform(e.target.value)} placeholder="平台" className="gcw-input flex-1 px-2 py-1 gcw-text-tag" />
                  </div>
                  <input value={evUrl} onChange={(e) => setEvUrl(e.target.value)} placeholder="原始 URL（支持点击上方一键提取）" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                  <input value={evTitle} onChange={(e) => setEvTitle(e.target.value)} placeholder="标题 / 评论摘录" className="gcw-input w-full px-2 py-1 gcw-text-tag" />
                  <div className="flex gap-1">
                    <input value={evAuthor} onChange={(e) => setEvAuthor(e.target.value)} placeholder="作者" className="gcw-input w-1/3 px-1.5 py-1 gcw-text-tag" />
                    <input value={evViews} onChange={(e) => setEvViews(e.target.value)} placeholder="播放" className="gcw-input w-1/3 px-1.5 py-1 gcw-text-tag font-mono-num" />
                    <input value={evLikes} onChange={(e) => setEvLikes(e.target.value)} placeholder="点赞" className="gcw-input w-1/3 px-1.5 py-1 gcw-text-tag font-mono-num" />
                  </div>
                  <textarea value={evNote} onChange={(e) => setEvNote(e.target.value)} rows={2} placeholder="研究笔记..." className="gcw-input w-full px-2 py-1 gcw-text-tag" />
                  <button onClick={handleCaptureEvidence} disabled={!activeCand} className="gcw-btn-cyan w-full py-1.5 rounded-lg font-semibold disabled:opacity-40">
                    收录研究证据
                  </button>
                </div>

                {/* 已收录证据列表（缺失数据严格显示 —） */}
                <div className="space-y-1.5">
                  {evidences.map((ev) => {
                    const emb = parseEmbedUrl(ev.url || '');
                    return (
                      <div key={ev.id} className="gcw-card p-2 space-y-1">
                        <div className="flex justify-between gap-1 items-start">
                          <span className="font-semibold text-slate-100 line-clamp-1">
                            <span className="text-cyan-300 mr-1">[{ev.platform || '—'}]</span>
                            {ev.title || '—'}
                          </span>
                          {emb.kind && (
                            <button
                              onClick={() => setActiveEmbed({ ...emb, rawUrl: ev.url, title: ev.title })}
                              className="px-1.5 py-0.2 rounded bg-cyan-500/15 border border-cyan-500/35 text-cyan-300 gcw-text-meta shrink-0"
                            >
                              ▶ 播放
                            </button>
                          )}
                        </div>
                        <div className="gcw-text-meta text-slate-400 font-mono-num">
                          播:{ev.view_count ?? '—'} · 赞:{ev.like_count ?? '—'}
                        </div>
                        {ev.user_note && <div className="gcw-text-meta text-slate-300">{ev.user_note}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 底部确认与淘汰 */}
              <div className="p-2 border-t border-[#1E2E4A] bg-[#131E36] space-y-1.5 gcw-text-tag">
                <input value={judgeReason} onChange={(e) => setJudgeReason(e.target.value)} placeholder="判断理由..." className="gcw-input w-full px-2 py-1" />
                <div className="flex gap-1.5">
                  <button
                    onClick={async () => {
                      if (!activeCand) return;
                      await api.researchFlowPatchCandidate(activeCand.id, { project_id: projectId, status: 'eliminated', judge_reason: judgeReason.trim() || '人工淘汰' });
                      showToast('已标记淘汰');
                      await loadAll(activeCand.id);
                    }}
                    className="flex-1 py-1 rounded-lg border border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 font-semibold flex items-center justify-center gap-0.5 transition"
                  >
                    <XCircle className="w-3 h-3" /> 淘汰
                  </button>
                  <button
                    onClick={handleConfirmToTopicHub}
                    disabled={!activeCand || confirmBusy}
                    className="flex-1 py-1 rounded-lg bg-emerald-600/85 hover:bg-emerald-500 text-white font-semibold flex items-center justify-center gap-0.5 disabled:opacity-40 transition"
                  >
                    <CheckCircle2 className="w-3 h-3" /> 确认入TopicHub
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* FIX-A05 / FIX-F03 方案 A：一键加入选题库至选题资产中心弹窗（打开时自动暂隐 researchView 防遮挡） */}
      <VideoCaptureModal
        open={captureModalOpen}
        onClose={closeCaptureModal}
        projectId={projectId}
        projectName={projectName}
        projects={projects}
        candidateTopicId={activeCand?.id || null}
        candidateTopicTitle={activeCand?.title || ''}
        currentTopicId={activeCand?.confirmed_topic_id || null}
        currentTopicTitle={activeCand?.confirmed_topic_id ? `#${activeCand.confirmed_topic_id} ${activeCand.title}` : ''}
        searchKeyword={activeQueryText.trim()}
        initialPreview={capturePreview}
        initialOriginalShareUrl={lastOriginalShareUrl}
        loadingPreview={captureLoading}
        onGoTopicHub={onGoTopicHub}
        onSaved={(res) => {
          showToast(
            `⭐ 已一键收录至选题资产中心（项目 #${res.project_id || projectId} · 选题 #${res.topic_id}「${res.topic_title}」· 状态：${res.topic_status || '待研究'}）` +
              (res.topic_created ? ' · 已自动沉淀为正式选题' : '') +
              (res.dedup_reused ? ' · 作品主体已去重复用' : '')
          );
          loadAll(activeCand?.id, projectId);
        }}
      />

      {/* 本地加密账号保险箱弹窗（打开时自动暂隐 researchView 防遮挡） */}
      <CredentialVaultModal
        open={vaultOpen}
        onClose={closeVaultModal}
        currentPlatformName={activePlatform?.name}
        currentUrl={ebState.url || activePlatform?.base_url || ''}
        onOpenSite={(url) => {
          if (researchBrowser) {
            browserWasVisibleRef.current = true;
            researchBrowser.navigate(url);
          } else {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        }}
      />
    </div>
  );
}
