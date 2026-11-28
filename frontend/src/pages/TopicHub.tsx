import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  CheckCircle2,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  Film,
  GitMerge,
  Globe,
  Kanban,
  Languages,
  Layers,
  List,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Package,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  ThumbsUp,
  Unlink,
  X,
} from 'lucide-react';
import { api, fmtDur, fmtNum } from '../api';

interface Props {
  projectId: number;
  focusTarget?: { projectId: number; topicId: number; token: number } | null;
  onClearFocusTarget?: () => void;
  onOpenTranscript: (contentId: number) => void;
  onJumpSearch: (keyword: string) => void;
}

// FIX-A07: 统一 7 态生命周期（状态严格由用户控制，AI 与自动操作不得修改）
const PROD_STATUSES = ['待研究', '研究中', '待制作', '制作中', '待发布', '已发布', '已归档'];
const KANBAN_COLS = ['待研究', '研究中', '待制作', '制作中', '待发布', '已发布'];
const VAL_GRADES = ['S', 'A', 'B', 'U', '待复核'];

function gradeCls(g: string) {
  if (g === 'S') return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/45';
  if (g === 'A') return 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/45';
  if (g === 'B') return 'bg-amber-500/20 text-amber-300 border border-amber-500/45';
  if (g === '待复核') return 'bg-rose-500/20 text-rose-300 border border-rose-500/45';
  return 'bg-slate-700/50 text-slate-300 border border-slate-600/60';
}

function platformBadgeCls(p: string) {
  const k = (p || '').toLowerCase();
  if (k.includes('youtube')) return 'bg-rose-500/25 text-rose-200 border-rose-500/40';
  if (k.includes('bilibili')) return 'bg-sky-500/25 text-sky-200 border-sky-500/40';
  if (k.includes('douyin')) return 'bg-cyan-500/25 text-cyan-200 border-cyan-500/40';
  if (k.includes('xiaohongshu')) return 'bg-pink-500/25 text-pink-200 border-pink-500/40';
  if (k.includes('zhihu')) return 'bg-blue-500/25 text-blue-200 border-blue-500/40';
  return 'bg-slate-700/70 text-slate-200 border-slate-600';
}

/**
 * 独立一级页面：选题资产中心 TopicHub（SEARCH-PHASE-4 · 麦田式浅色极简设计）
 *
 * 严格遵循：
 * - 复用 Phase 3 topics / topic_evidence / topic_relations，不建第二套选题库；
 * - 市场验证状态（U/B/A/S/待复核）与制作状态（新发现/待研究/待制作/制作中/已发布/已搁置）严格分离，收藏为独立属性；
 * - 支持人工直接创建原创选题（不强制先 AI 搜索），未验证进入待制作仍保持 U；
 * - 支持多对多证据追溯、文案工坊联动、相似选题用户确认无损合并与重新发起真实搜索。
 */
export default function TopicHub({ projectId, focusTarget, onClearFocusTarget, onOpenTranscript, onJumpSearch }: Props) {
  const [overview, setOverview] = useState<any>(null);
  const [topics, setTopics] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list');

  // FIX-A06: 左侧项目分类（0=全部项目, -1=未归类, >0=真实研究项目，默认当前全局 projectId）
  const [projectCategories, setProjectCategories] = useState<any>(null);
  const [activeProjectFilter, setActiveProjectFilter] = useState<number>(projectId);

  // FIX-A07: 批量选择与归档显示控制
  const [checkedTopicIds, setCheckedTopicIds] = useState<number[]>([]);
  const [batchTargetStatus, setBatchTargetStatus] = useState<string>('研究中');
  const [includeArchived, setIncludeArchived] = useState(false);

  // 筛选条件
  const [q, setQ] = useState('');
  const [filterVal, setFilterVal] = useState('');
  const [filterProd, setFilterProd] = useState('');
  const [filterOrigin, setFilterOrigin] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [includePublished, setIncludePublished] = useState(true);

  // 弹窗：人工新建原创选题 / 相似选题检测与合并
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newQuestion, setNewQuestion] = useState('');
  const [newAngle, setNewAngle] = useState('');
  const [newAudience, setNewAudience] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newProdStatus, setNewProdStatus] = useState('待研究');

  const [similarOpen, setSimilarOpen] = useState(false);
  const [similarPairs, setSimilarPairs] = useState<any[]>([]);

  // 详情编辑草稿
  const [editNotes, setEditNotes] = useState('');
  const [editDiff, setEditDiff] = useState('');
  const [editAudience, setEditAudience] = useState('');
  const [editFact, setEditFact] = useState('待核实');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  // Phase 5: 原创文案多版本 + 创作资料包状态
  const [scriptSkills, setScriptSkills] = useState<any[]>([]);
  const [selectedSkill, setSelectedSkill] = useState('fact_separated_deep_dive');
  const [scriptVersions, setScriptVersions] = useState<any[]>([]);
  const [userViewpoint, setUserViewpoint] = useState('');
  const [manualScriptText, setManualScriptText] = useState('');
  const [pkgCheck, setPkgCheck] = useState<any>(null);
  const [packages, setPackages] = useState<any[]>([]);
  const [pkgBusy, setPkgBusy] = useState(false);
  const [scriptBusy, setScriptBusy] = useState(false);

  // GCW-ASSET-01: 参考视频列表筛选、排序与原始数据详情/编辑弹窗
  const [vidPlatformFilter, setVidPlatformFilter] = useState('');
  const [vidTagFilter, setVidTagFilter] = useState('');
  const [vidSearchQ, setVidSearchQ] = useState('');
  const [vidSortBy, setVidSortBy] = useState<'views' | 'likes' | 'engagement' | 'captured'>('views');
  const [editingVideo, setEditingVideo] = useState<any | null>(null);
  const [editVidUrl, setEditVidUrl] = useState('');
  const [editVidTags, setEditVidTags] = useState<string[]>([]);
  const [editVidTagInput, setEditVidTagInput] = useState('');
  const [editVidReason, setEditVidReason] = useState('');
  const [editVidTopicIds, setEditVidTopicIds] = useState<number[]>([]);
  const [savingVid, setSavingVid] = useState(false);

  // FIX-A02: TopicHub 专属独立播放器实例（topicPlayerView，与 SearchHub researchView 完全隔离，共享 persist:gcw_research 登录态）
  const isElectron = Boolean(window.gcwDesktopBrowser?.isElectron);
  const playerBrowser = useMemo(
    () => (window.gcwDesktopBrowser?.isElectron ? window.gcwDesktopBrowser.forView('topicPlayer') : null),
    []
  );
  const [playingVideo, setPlayingVideo] = useState<any | null>(null);
  const [playerState, setPlayerState] = useState<any>({ url: '', title: '', isLoading: false, canGoBack: false, canGoForward: false });
  const [playerMaximized, setPlayerMaximized] = useState(false);
  const [subData, setSubData] = useState<any | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [subTranslating, setSubTranslating] = useState(false);
  const [subProgressMsg, setSubProgressMsg] = useState('');
  const [subError, setSubError] = useState('');
  const [subMode, setSubMode] = useState<'bilingual' | 'zh' | 'source' | 'off'>('bilingual');
  const [subFontSize, setSubFontSize] = useState<14 | 18 | 22 | 26>(18);
  const [playback, setPlayback] = useState<{
    hasVideo: boolean;
    isAd: boolean;
    buffering: boolean;
    currentTime: number;
    duration: number;
    paused: boolean;
    ended: boolean;
    playbackRate: number;
    url: string;
  }>({
    hasVideo: false,
    isAd: false,
    buffering: false,
    currentTime: 0,
    duration: 0,
    paused: true,
    ended: false,
    playbackRate: 1,
    url: '',
  });
  const playbackReqSeqRef = useRef(0);
  const playerHostRef = useRef<HTMLDivElement | null>(null);
  // GCW-UAT-R4-C: 自动翻译任务序号守卫（切换视频或关闭播放器立即递增取消/隔离旧任务，杜绝字幕串用）
  const autoTransRunIdRef = useRef(0);

  const isChineseSubtitles = (data: any): boolean => {
    const lang = String(data?.language || '').toLowerCase();
    if (lang.startsWith('zh')) return true;
    const sample = (data?.segments || []).slice(0, 6).map((s: any) => s.text || '').join('');
    if (!sample) return false;
    const zhChars = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    return zhChars / Math.max(1, sample.length) >= 0.4;
  };

  useEffect(() => {
    if (!playerBrowser) return;
    const unsub = playerBrowser.onState((st) => {
      if (st) setPlayerState(st);
    });
    return () => {
      unsub?.();
      playerBrowser.setVisible(false).catch(() => {});
    };
  }, [playerBrowser]);

  // GCW-UAT-R4-C: 选题中心打开外语视频自动执行「查语言→查字幕→查缓存→有缓存秒加载 / 无缓存自动调用已授权默认引擎翻译」
  const loadPlayingSubtitles = async (contentId: number) => {
    const runId = ++autoTransRunIdRef.current;
    setSubLoading(true);
    setSubTranslating(false);
    setSubProgressMsg('1/3 正在检查视频源语言、原始字幕与翻译缓存...');
    setSubError('');
    try {
      let data = await api.translationGetSubtitles(contentId, 'zh-CN');
      if (autoTransRunIdRef.current !== runId) return;
      setSubData(data);

      // 无合法原始字幕时，自动静默拉取原始字幕与时间轴
      if (!data?.has_transcript || !data?.total_count) {
        setSubProgressMsg('2/3 未检测到本地字幕，正在自动提取合法原始字幕...');
        try {
          const ex = await api.extractTranscript(contentId);
          if (autoTransRunIdRef.current !== runId) return;
          if (ex?.ok) {
            data = await api.translationGetSubtitles(contentId, 'zh-CN');
            if (autoTransRunIdRef.current !== runId) return;
            setSubData(data);
          }
        } catch {
          // 提取失败不阻断视频正常播放
        }
      }

      if (!data?.has_transcript || !data?.total_count) {
        setSubProgressMsg('');
        setSubLoading(false);
        return;
      }

      // 中文视频无需重复翻译
      if (isChineseSubtitles(data)) {
        setSubProgressMsg('中文原声视频，无需重复翻译（直接同步原文字幕）');
        setSubLoading(false);
        return;
      }

      // 已有完整翻译缓存：0 费用直接加载，不重复消耗 Token
      if (data.translated_count >= data.total_count) {
        setSubProgressMsg(`已加载本地双语字幕缓存（${data.translated_count}/${data.total_count} 段 · 0 Token 复用）`);
        setSubLoading(false);
        return;
      }

      // 外语视频且无完整缓存：检查默认翻译引擎与费用授权策略（绝不未经授权调用付费 API）
      const cfg = await api.translationGetConfig().catch(() => null);
      if (autoTransRunIdRef.current !== runId) return;
      const defId = cfg?.default_engine_id || '';
      const defProv = (cfg?.providers || []).find((p: any) => p.engine_id === defId);
      const billingMode = cfg?.policy?.billing_mode || 'free_only';

      if (!defId || !defProv) {
        setSubProgressMsg('尚未配置默认翻译引擎，请点击右侧「翻译配置」选定引擎');
        setSubLoading(false);
        return;
      }
      if (billingMode === 'free_only' && defProv.billing_category === 'pay_as_you_go') {
        setSubProgressMsg(`当前为「仅允许免费模式」，已暂停自动调用按量付费引擎 ${defProv.short_name}（可切换授权或配置本地免费模型）`);
        setSubLoading(false);
        return;
      }

      // 已授权默认引擎：自动执行分批上下文翻译
      setSubLoading(false);
      setSubTranslating(true);
      setSubProgressMsg(`3/3 正在自动翻译外语字幕（${defProv.short_name} · ${data.total_count} 段）...`);
      const transRes = await api.translationTranslateSubtitles(contentId, { target_lang: 'zh-CN' });
      if (autoTransRunIdRef.current !== runId) return;
      setSubData(transRes);
      setSubProgressMsg(transRes.message || `自动翻译完成（${transRes.translated_count}/${transRes.total_count} 段）`);
    } catch (e: any) {
      if (autoTransRunIdRef.current !== runId) return;
      setSubError(e?.message || '自动加载/翻译字幕失败');
      setSubProgressMsg('');
    } finally {
      if (autoTransRunIdRef.current === runId) {
        setSubLoading(false);
        setSubTranslating(false);
      }
    }
  };

  useEffect(() => {
    playbackReqSeqRef.current += 1;
    if (!playingVideo?.content_id) {
      autoTransRunIdRef.current += 1;
      setSubData(null);
      setSubError('');
      setSubProgressMsg('');
      setPlayback({
        hasVideo: false,
        isAd: false,
        buffering: false,
        currentTime: 0,
        duration: 0,
        paused: true,
        ended: false,
        playbackRate: 1,
        url: '',
      });
      return;
    }
    setPlayback({
      hasVideo: false,
      isAd: false,
      buffering: false,
      currentTime: 0,
      duration: Number(playingVideo.duration_sec || 0),
      paused: true,
      ended: false,
      playbackRate: 1,
      url: '',
    });
    loadPlayingSubtitles(playingVideo.content_id);
  }, [playingVideo?.content_id]);

  // GCW-UAT-R4-G: 受控只读 IPC 每 100ms 读取真实 <video>.currentTime（防旧 IPC 覆盖、过滤广告态与旧视频 URL 残留）
  useEffect(() => {
    if (!playerBrowser || !playingVideo) return;
    let alive = true;
    const expectedItemId = String(playingVideo.platform_item_id || '').trim();
    const expectedUrl = String(playingVideo.url || '').trim();

    const matchesCurrentVideoUrl = (liveUrl: string) => {
      if (!liveUrl || liveUrl === 'about:blank') return false;
      if (expectedItemId && liveUrl.includes(expectedItemId)) return true;
      if (expectedUrl && liveUrl.startsWith(expectedUrl.split('?')[0])) return true;
      return !expectedItemId;
    };

    const tick = async () => {
      const seq = ++playbackReqSeqRef.current;
      try {
        const res = await playerBrowser.getVideoPlayback();
        if (!alive || seq !== playbackReqSeqRef.current || !res?.ok) return;
        const liveUrl = String(res.url || '');
        // 切视频过渡期若底层视图仍停留在上一条视频的 URL，严禁把旧视频 currentTime 注入当前字幕
        if (!matchesCurrentVideoUrl(liveUrl)) {
          setPlayback((prev) =>
            prev.hasVideo
              ? { hasVideo: false, isAd: false, buffering: false, currentTime: 0, duration: 0, paused: true, ended: false, playbackRate: 1, url: liveUrl }
              : prev
          );
          return;
        }
        setPlayback({
          hasVideo: Boolean(res.hasVideo) && !Boolean(res.isAd),
          isAd: Boolean(res.isAd),
          buffering: Boolean(res.buffering),
          currentTime: Number.isFinite(Number(res.currentTime)) ? Number(res.currentTime) : 0,
          duration: Number.isFinite(Number(res.duration)) ? Number(res.duration) : 0,
          paused: Boolean(res.paused),
          ended: Boolean(res.ended),
          playbackRate: Number.isFinite(Number(res.playbackRate)) ? Number(res.playbackRate) : 1,
          url: liveUrl,
        });
      } catch {
        // 忽略页面跳转瞬间的临时读取异常
      }
    };
    tick();
    const iv = setInterval(tick, 100);
    return () => {
      alive = false;
      playbackReqSeqRef.current += 1;
      clearInterval(iv);
    };
  }, [playingVideo?.content_id, playingVideo?.platform_item_id, playingVideo?.url, playerBrowser]);

  const handleTranslateInPlayer = async () => {
    if (!playingVideo?.content_id) return;
    setSubTranslating(true);
    setSubError('');
    try {
      const res = await api.translationTranslateSubtitles(playingVideo.content_id, { target_lang: 'zh-CN' });
      setSubData(res);
      showToast(res.message || '✅ 字幕翻译完成并已缓存');
    } catch (e: any) {
      setSubError(e?.message || '字幕翻译失败');
    } finally {
      setSubTranslating(false);
    }
  };

  // GCW-UAT-R4-G: 预排序规范化字幕（保留稳定 segment_idx 与原始时间戳，绝不按译文长度重算时间）
  const sortedSubtitleSegs = useMemo(() => {
    const segs: any[] = subData?.segments || [];
    if (!segs.length) return [];
    return [...segs].sort((a, b) => {
      const d = Number(a.start || 0) - Number(b.start || 0);
      return d !== 0 ? d : Number(a.segment_idx || 0) - Number(b.segment_idx || 0);
    });
  }, [subData?.segments]);

  // GCW-UAT-R4-G: 以真实 currentTime 为唯一时间基准精确匹配（零提前偏置；重叠区间取最新已开始段；无匹配正常留空）
  const activeSubtitleSeg = useMemo(() => {
    if (!sortedSubtitleSegs.length || !playback.hasVideo || playback.isAd) return null;
    const t = playback.currentTime;
    // 倒序查找：在 YouTube 自动滚动字幕相邻段存在重叠时，当 t 进入下一段 start 即准确切换至最新正在播放的片段
    for (let i = sortedSubtitleSegs.length - 1; i >= 0; i--) {
      const s = sortedSubtitleSegs[i];
      const start = Number(s.start);
      if (!Number.isFinite(start) || t < start) continue;
      const nextStart = i + 1 < sortedSubtitleSegs.length ? Number(sortedSubtitleSegs[i + 1].start) : null;
      const rawEnd = s.end != null && Number.isFinite(Number(s.end)) ? Number(s.end) : null;
      // 末段无可靠 end 时，仅当存在明确 rawEnd 或下一段 start 时判定范围；无匹配正常留空
      const effectiveEnd = rawEnd != null ? rawEnd : (nextStart != null && nextStart > start ? nextStart : null);
      if (effectiveEnd != null) {
        if (t >= start && t < effectiveEnd) {
          return s;
        }
      } else if (t >= start && t < start + 6) {
        // 仅针对末段 end_source='unknown' 时的安全上限保护
        return s;
      }
    }
    return null;
  }, [sortedSubtitleSegs, playback.currentTime, playback.hasVideo, playback.isAd]);

  // 暴露只读诊断快照供验收脚本核对真实播放时间与命中字幕段（不影响业务逻辑）
  useEffect(() => {
    (window as any).__gcwSubtitleDiag = {
      contentId: playingVideo?.content_id ?? null,
      hasVideo: playback.hasVideo,
      isAd: playback.isAd,
      buffering: playback.buffering,
      paused: playback.paused,
      playbackRate: playback.playbackRate,
      currentTime: playback.currentTime,
      activeSegIdx: activeSubtitleSeg?.segment_idx ?? null,
      activeStart: activeSubtitleSeg?.start ?? null,
      activeEnd: activeSubtitleSeg?.end ?? null,
      activeText: activeSubtitleSeg?.text ?? '',
      activeZh: activeSubtitleSeg?.translated_text ?? '',
      ts: Date.now(),
    };
  }, [playingVideo?.content_id, playback, activeSubtitleSeg]);

  useEffect(() => {
    if (!playerBrowser) return;
    if (!playingVideo) {
      playerBrowser.setVisible(false).catch(() => {});
      return;
    }
    const syncRect = () => {
      const el = playerHostRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 80) {
        playerBrowser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height }).catch(() => {});
      }
    };
    const timer = setTimeout(async () => {
      syncRect();
      // 若 topicPlayerView 当前加载的正是同一个视频 URL，则直接恢复显示不强制刷新，保留原进度
      const st = await playerBrowser.getState().catch(() => null);
      if (st?.url && playingVideo.url && st.url === playingVideo.url) {
        playerBrowser.setVisible(true).catch(() => {});
      } else {
        playerBrowser.navigate(playingVideo.url).catch(() => {});
      }
    }, 80);
    const ro = new ResizeObserver(() => syncRect());
    if (playerHostRef.current) ro.observe(playerHostRef.current);
    window.addEventListener('resize', syncRect);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener('resize', syncRect);
      playerBrowser.setVisible(false).catch(() => {});
    };
  }, [playingVideo, playerBrowser]);

  // 字幕停靠条显隐或工作台最大化切换时立即重新同步 topicPlayerView 尺寸
  useEffect(() => {
    if (!playerBrowser || !playingVideo) return;
    const t = setTimeout(() => {
      const el = playerHostRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 80) {
        playerBrowser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height }).catch(() => {});
      }
    }, 40);
    return () => clearTimeout(t);
  }, [playerMaximized, subMode, subFontSize, playingVideo, playerBrowser]);

  const openInlinePlayer = (c: any) => {
    if (!c?.url) {
      showToast('该作品缺少原始链接，无法播放');
      return;
    }
    setPlayingVideo(c);
  };

  const closeInlinePlayer = () => {
    setPlayingVideo(null);
    playerBrowser?.setVisible(false).catch(() => {});
  };

  const getFallbackEmbedUrl = (rawUrl: string) => {
    const yt = rawUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
    if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1`;
    const bv = rawUrl.match(/(BV[A-Za-z0-9]{10})/i);
    if (bv) return `https://player.bilibili.com/player.html?bvid=${bv[1]}&high_quality=1&autoplay=1`;
    return '';
  };

  const videoPlatforms = useMemo(() => {
    const s = new Set<string>();
    for (const c of detail?.contents || []) if (c.platform) s.add(String(c.platform));
    return Array.from(s);
  }, [detail?.contents]);

  const videoTags = useMemo(() => {
    const s = new Set<string>();
    for (const c of detail?.contents || []) {
      for (const t of c.research_tags || []) if (t) s.add(String(t));
    }
    return Array.from(s);
  }, [detail?.contents]);

  const filteredContents = useMemo(() => {
    let list = [...(detail?.contents || [])];
    if (vidPlatformFilter) list = list.filter((c) => c.platform === vidPlatformFilter);
    if (vidTagFilter) list = list.filter((c) => (c.research_tags || []).includes(vidTagFilter));
    if (vidSearchQ.trim()) {
      const kw = vidSearchQ.trim().toLowerCase();
      list = list.filter(
        (c) =>
          (c.title || '').toLowerCase().includes(kw) ||
          (c.creator_name || '').toLowerCase().includes(kw) ||
          (c.capture_reason || '').toLowerCase().includes(kw) ||
          (c.research_tags || []).some((t: string) => t.toLowerCase().includes(kw))
      );
    }
    list.sort((a, b) => {
      if (vidSortBy === 'likes') return (b.like_count ?? -1) - (a.like_count ?? -1);
      if (vidSortBy === 'engagement') return (b.engagement_rate ?? -1) - (a.engagement_rate ?? -1);
      if (vidSortBy === 'captured') return String(b.manual_captured_at || '').localeCompare(String(a.manual_captured_at || ''));
      return (b.view_count ?? -1) - (a.view_count ?? -1);
    });
    return list;
  }, [detail?.contents, vidPlatformFilter, vidTagFilter, vidSearchQ, vidSortBy]);

  const openVideoEditor = (c: any) => {
    setEditingVideo(c);
    setEditVidUrl(c.url || '');
    setEditVidTags(Array.isArray(c.research_tags) ? [...c.research_tags] : []);
    setEditVidTagInput('');
    setEditVidReason(c.capture_reason || '');
    setEditVidTopicIds(Array.isArray(c.linked_topic_ids) && c.linked_topic_ids.length > 0 ? [...c.linked_topic_ids] : detail?.topic ? [detail.topic.id] : []);
  };

  const handleSaveVideoAsset = async () => {
    if (!editingVideo || !detail?.topic) return;
    if (editVidTopicIds.length === 0) {
      showToast('请至少保留一个关联选题（如需取消收录请使用「取消收录」按钮）');
      return;
    }
    setSavingVid(true);
    try {
      const r = await api.topicHubPatchContentAsset(detail.topic.id, editingVideo.content_id, {
        project_id: detail.topic.project_id || projectId,
        url: editVidUrl.trim() !== (editingVideo.url || '').trim() ? editVidUrl.trim() : undefined,
        research_tags: editVidTags,
        capture_reason: editVidReason,
        target_topic_ids: editVidTopicIds,
      });
      if (r?.ok) {
        showToast('✅ 已更新视频链接、标签、收录原因与关联选题（已核对唯一ID防覆盖）');
        setEditingVideo(null);
        await loadAll(detail.topic.id);
      }
    } catch (e: any) {
      showToast('更新失败：' + e.message);
    } finally {
      setSavingVid(false);
    }
  };

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 4200);
  };

  const loadAll = async (keepSelectedId?: number | null, overrideProjectFilter?: number) => {
    const pf = overrideProjectFilter !== undefined ? overrideProjectFilter : activeProjectFilter;
    const [cats, ov, listRes] = await Promise.all([
      api.topicHubProjectCategories().catch(() => null),
      api.topicHubOverview(pf).catch(() => null),
      api
        .topicHubList({
          project_id: pf,
          q,
          validation_status: filterVal,
          production_status: filterProd,
          origin_type: filterOrigin,
          favorite_only: favOnly ? 'true' : '',
          include_published: includePublished ? 'true' : 'false',
          include_archived: includeArchived || filterProd === '已归档' ? 'true' : 'false',
        })
        .catch(() => ({ topics: [] })),
    ]);
    if (cats?.ok) setProjectCategories(cats);
    setOverview(ov);
    const list = listRes?.topics || [];
    setTopics(list);
    setCheckedTopicIds((prev) => prev.filter((id) => list.some((t: any) => t.id === id)));
    const target = keepSelectedId !== undefined ? keepSelectedId : selectedId;
    if (target && list.some((t: any) => t.id === target)) {
      loadDetail(target, list.find((t: any) => t.id === target)?.project_id);
    } else if (list.length > 0) {
      loadDetail(list[0].id, list[0].project_id);
    } else {
      setSelectedId(null);
      setDetail(null);
    }
  };

  // GCW-UAT-R4-H: 从收录弹窗点击「前往选题资产中心查看」后，自动切换项目、清除不适用的筛选条件并精准定位到刚保存的选题
  useEffect(() => {
    if (!focusTarget?.topicId) return;
    const targetPid = focusTarget.projectId;
    const targetTid = focusTarget.topicId;
    setActiveProjectFilter(targetPid);
    setQ('');
    setFilterVal('');
    setFilterProd('');
    setFilterOrigin('');
    setFavOnly(false);
    setIncludePublished(true);
    (async () => {
      try {
        const [cats, ov, listRes] = await Promise.all([
          api.topicHubProjectCategories().catch(() => null),
          api.topicHubOverview(targetPid).catch(() => null),
          api.topicHubList({ project_id: targetPid, include_published: 'true', include_archived: 'true', limit: 200 }).catch(() => ({ topics: [] })),
        ]);
        if (cats?.ok) setProjectCategories(cats);
        setOverview(ov);
        const list = listRes?.topics || [];
        setTopics(list);
        await loadDetail(targetTid, targetPid);
        showToast(`✅ 已定位至选题 #${targetTid}`);
      } finally {
        onClearFocusTarget?.();
      }
    })();
  }, [focusTarget?.token]);

  const loadDetail = async (tid: number, topicProjId?: number | null) => {
    setSelectedId(tid);
    const effectivePid = topicProjId || (activeProjectFilter > 0 ? activeProjectFilter : projectId);
    const [d, sc, ck, pk] = await Promise.all([
      api.topicHubDetail(tid, activeProjectFilter > 0 ? activeProjectFilter : null).catch(() => null),
      api.topicHubListScripts(tid, effectivePid).catch(() => ({ versions: [] })),
      api.topicHubPackageCheck(tid, effectivePid).catch(() => null),
      api.topicHubListPackages(tid, effectivePid).catch(() => ({ packages: [] })),
    ]);
    if (d?.ok) {
      setDetail(d);
      setEditNotes(d.topic.user_notes || '');
      setEditDiff(d.topic.differentiation_notes || '');
      setEditAudience(d.topic.target_audience || '');
      setEditFact(d.topic.fact_check_status || '待核实');
    }
    setScriptVersions(sc?.versions || []);
    setPkgCheck(ck?.ok ? ck : null);
    setPackages(pk?.packages || []);
  };

  useEffect(() => {
    api.topicHubScriptSkills().then((r) => setScriptSkills(r?.skills || [])).catch(() => {});
  }, []);

  const handleRunScriptSkill = async () => {
    if (!detail?.topic) return;
    if (selectedSkill === 'manual' && !manualScriptText.trim()) {
      showToast('手动保存文案时请输入正文内容');
      return;
    }
    setScriptBusy(true);
    try {
      const r = await api.topicHubCreateScript(detail.topic.id, {
        project_id: projectId,
        skill_id: selectedSkill,
        version_kind: selectedSkill === 'manual' ? 'user_final' : 'ai_draft',
        content_markdown: selectedSkill === 'manual' ? manualScriptText : '',
        user_viewpoint: userViewpoint,
        is_final: selectedSkill === 'manual',
      });
      if (r?.ok) {
        if (selectedSkill === 'manual') setManualScriptText('');
        showToast(`✅ 已保存独立文案版本 v${r.script_version.version_no}（绝不覆盖原始参考文案）`);
        await loadDetail(detail.topic.id);
      }
    } catch (e: any) {
      showToast('文案生成/保存失败：' + e.message);
    } finally {
      setScriptBusy(false);
    }
  };

  const handleGeneratePackage = async () => {
    if (!detail?.topic) return;
    setPkgBusy(true);
    try {
      const r = await api.topicHubGeneratePackage(detail.topic.id, {
        project_id: projectId,
        language: 'zh-CN',
      });
      if (r?.ok) {
        showToast(`📦 已生成标准化创作资料包 ${r.package_uid} (v${r.package_version}，含 ${r.files_count} 个标准文件)`);
        await loadDetail(detail.topic.id);
      }
    } catch (e: any) {
      showToast('生成资料包失败：' + e.message);
    } finally {
      setPkgBusy(false);
    }
  };

  useEffect(() => {
    setActiveProjectFilter(projectId);
    setSelectedId(null);
    setDetail(null);
    loadAll(null, projectId);
  }, [projectId]);

  useEffect(() => {
    loadAll();
  }, [activeProjectFilter, filterVal, filterProd, filterOrigin, favOnly, includePublished, includeArchived]);

  const handleBatchStatusUpdate = async () => {
    if (!checkedTopicIds.length) return;
    setBusy(true);
    try {
      const r = await api.topicHubBatchStatus({
        topic_ids: checkedTopicIds,
        production_status: batchTargetStatus,
      });
      if (r?.ok) {
        showToast(`✅ 已将 ${r.updated_count} 条选题批量调整为「${batchTargetStatus}」`);
        setCheckedTopicIds([]);
        await loadAll();
      }
    } catch (e: any) {
      showToast('批量修改状态失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRevertStatus = async (tid: number) => {
    setBusy(true);
    try {
      const r = await api.topicHubRevertStatus(tid);
      if (r?.ok) {
        showToast(`↩ 已从「${r.old_status}」退回至「${r.new_status}」`);
        await loadAll(tid);
      }
    } catch (e: any) {
      showToast(e.message || '无法退回上一阶段');
    } finally {
      setBusy(false);
    }
  };

  const handleArchiveOrRestore = async (tid: number, archive: boolean) => {
    setBusy(true);
    try {
      const r = await api.topicHubArchive(tid, archive);
      if (r?.ok) {
        showToast(archive ? '📦 已归档该选题（勾选「显示已归档」可随时恢复）' : `♻ 已恢复选题至「${r.new_status}」`);
        await loadAll(archive ? null : tid);
      }
    } catch (e: any) {
      showToast(e.message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateManual = async () => {
    if (!newTitle.trim()) {
      showToast('请输入选题标题');
      return;
    }
    setBusy(true);
    try {
      const r = await api.topicHubCreate({
        project_id: projectId,
        topic_title: newTitle.trim(),
        research_question: newQuestion.trim(),
        angle: newAngle.trim(),
        target_audience: newAudience.trim(),
        origin_type: 'manual_original',
        production_status: newProdStatus,
        keywords: newKeywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        tags: newTags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      });
      if (r?.ok) {
        setCreateOpen(false);
        setNewTitle('');
        setNewQuestion('');
        setNewAngle('');
        setNewAudience('');
        setNewKeywords('');
        setNewTags('');
        showToast('✅ 已创建人工原创选题（市场验证等级严格保持 U）');
        await loadAll(r.topic.id);
      }
    } catch (e: any) {
      showToast('创建失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const handlePatch = async (tid: number, patch: Record<string, any>, msg?: string) => {
    try {
      const r = await api.topicHubPatch(tid, { project_id: projectId, ...patch });
      if (r?.ok) {
        if (msg) showToast(msg);
        await loadAll(tid);
      }
    } catch (e: any) {
      showToast('更新失败：' + e.message);
    }
  };

  const handleDetectSimilar = async () => {
    const r = await api.topicHubDetectSimilar(projectId).catch(() => ({ pairs: [] }));
    setSimilarPairs(r?.pairs || []);
    setSimilarOpen(true);
  };

  const handleConfirmMerge = async (targetId: number, sourceId: number) => {
    setBusy(true);
    try {
      const r = await api.topicHubMerge({
        project_id: projectId,
        target_topic_id: targetId,
        source_topic_id: sourceId,
        reason: '用户在 TopicHub 确认无损合并重复选题',
      });
      if (r?.ok) {
        showToast(`✅ 已无损合并选题 #${sourceId} → #${targetId}（新增吸收 ${r.merged_evidence_count} 条证据，支持日志恢复）`);
        const sim = await api.topicHubDetectSimilar(projectId).catch(() => ({ pairs: [] }));
        setSimilarPairs(sim?.pairs || []);
        await loadAll(targetId);
      }
    } catch (e: any) {
      showToast('合并失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleReSearch = async (tp: any) => {
    setBusy(true);
    try {
      const r = await api.topicHubReSearch(tp.id, { project_id: projectId, platforms: ['youtube', 'bilibili'] });
      if (r?.ok) {
        showToast(`🔍 已发起真实研究批次 #${r.batch_id}（查询：${(r.queries || []).join(' / ')}）`);
        await loadDetail(tp.id);
      }
    } catch (e: any) {
      showToast('发起研究失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col gap-2.5 gcw-workspace p-2.5 rounded-xl overflow-hidden">
      {/* 顶部总览与统一标签页条 */}
      <div className="gcw-panel px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-slate-100 gcw-page-title">
            <Layers className="w-5 h-5 text-cyan-400" />
            <span>选题资产中心 TopicHub</span>
          </div>
          {overview && (
            <div className="flex items-center gap-2 text-[11px] flex-wrap font-mono-num">
              <span className="px-2 py-0.5 rounded bg-[#0C1424] border border-[#2C4268] text-slate-300">总计 <strong className="text-slate-100">{overview.total}</strong></span>
              <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300">收藏 <strong>{overview.favorite_count}</strong></span>
              <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300">文案就绪 <strong>{overview.script_ready_count}</strong></span>
              <span className="text-slate-400">
                验证：S(<span className="text-emerald-300">{overview.by_validation_status?.S || 0}</span>) · A(<span className="text-cyan-300">{overview.by_validation_status?.A || 0}</span>) · B(<span className="text-amber-300">{overview.by_validation_status?.B || 0}</span>) · U(<span className="text-slate-300">{overview.by_validation_status?.U || 0}</span>)
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setViewMode('list')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 ${viewMode === 'list' ? 'gcw-tab-active' : 'gcw-btn-ghost'}`}
          >
            <List className="w-3.5 h-3.5" /> 档案列表
          </button>
          <button
            onClick={() => setViewMode('kanban')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 ${viewMode === 'kanban' ? 'gcw-tab-active' : 'gcw-btn-ghost'}`}
          >
            <Kanban className="w-3.5 h-3.5" /> 制作看板
          </button>
          <button onClick={handleDetectSimilar} className="gcw-btn-ghost px-2.5 py-1 rounded-lg text-xs flex items-center gap-1">
            <GitMerge className="w-3.5 h-3.5 text-cyan-400" /> 相似去重
          </button>
          <button onClick={() => setCreateOpen(true)} className="gcw-btn-cyan px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> 新建原创选题
          </button>
        </div>
      </div>

      {/* 横向紧凑筛选工具栏 */}
      <div className="gcw-panel px-3 py-2 flex flex-wrap items-center gap-2 text-xs shrink-0">
        <div className="gcw-input flex items-center gap-1.5 flex-1 min-w-[200px] px-2.5 py-1">
          <Search className="w-3.5 h-3.5 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadAll()}
            placeholder="搜索标题 / 研究问题 / 关键词 / 标签..."
            className="flex-1 bg-transparent outline-none text-xs text-slate-100 placeholder:text-slate-500"
          />
          <button onClick={() => loadAll()} className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold">搜索</button>
        </div>

        <select value={filterVal} onChange={(e) => setFilterVal(e.target.value)} className="gcw-input px-2 py-1 text-xs">
          <option value="">全部验证等级</option>
          {VAL_GRADES.map((g) => <option key={g} value={g}>验证：{g}</option>)}
        </select>

        <select value={filterProd} onChange={(e) => setFilterProd(e.target.value)} className="gcw-input px-2 py-1 text-xs">
          <option value="">全部制作状态</option>
          {PROD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <select value={filterOrigin} onChange={(e) => setFilterOrigin(e.target.value)} className="gcw-input px-2 py-1 text-xs">
          <option value="">全部来源</option>
          <option value="A_original_matched">SearchHub·原始方向</option>
          <option value="B_market_derived">市场反向衍生</option>
          <option value="manual_original">人工原创灵感</option>
          <option value="C_ai_or_human_inspiration">AI 待验证灵感</option>
          <option value="content_comment_discovery">作品/评论发现</option>
        </select>

        <label className="flex items-center gap-1 cursor-pointer text-[11px] text-slate-300">
          <input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} className="accent-cyan-400" /> 仅看收藏
        </label>
        <label className="flex items-center gap-1 cursor-pointer text-[11px] text-slate-300">
          <input type="checkbox" checked={includePublished} onChange={(e) => setIncludePublished(e.target.checked)} className="accent-cyan-400" /> 显示已发布
        </label>
        <label className="flex items-center gap-1 cursor-pointer text-[11px] text-slate-300">
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} className="accent-cyan-400" /> 显示已归档
        </label>
      </div>

      {/* FIX-A07: 7 态生命周期数量统计快筛条 */}
      {overview?.by_production_status && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] shrink-0">
          <button
            onClick={() => setFilterProd('')}
            className={`px-2 py-0.5 rounded-full border transition ${filterProd === '' ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200 font-semibold' : 'bg-[#0C1424] border-[#1E2E4A] text-slate-400 hover:text-slate-200'}`}
          >
            全部状态 ({overview.total ?? 0})
          </button>
          {PROD_STATUSES.map((st) => (
            <button
              key={st}
              onClick={() => setFilterProd(filterProd === st ? '' : st)}
              className={`px-2 py-0.5 rounded-full border transition font-mono-num ${filterProd === st ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200 font-semibold' : 'bg-[#0C1424] border-[#1E2E4A] text-slate-400 hover:text-slate-200'}`}
            >
              {st} ({overview.by_production_status?.[st] ?? 0})
            </button>
          ))}
        </div>
      )}

      {toast && (
        <div className="px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-xs shrink-0">{toast}</div>
      )}

      {/* 主体：列表+档案详情 或 制作看板 */}
      {viewMode === 'kanban' ? (
        <div className="flex-1 grid grid-cols-5 gap-2.5 min-h-0 overflow-x-auto">
          {KANBAN_COLS.map((col) => {
            const colItems = topics.filter((t) => t.production_status_norm === col || (col === '待研究' && t.production_status_norm === '新发现'));
            return (
              <div key={col} className="gcw-panel flex flex-col min-w-[200px] overflow-hidden">
                <div className="px-2.5 py-2 gcw-panel-header flex justify-between items-center text-xs font-semibold text-slate-200">
                  <span>{col}</span>
                  <span className="text-[10px] px-1.5 rounded bg-[#0C1424] border border-[#2C4268] text-cyan-300 font-mono-num">{colItems.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {colItems.map((tp) => (
                    <div
                      key={tp.id}
                      onClick={() => { loadDetail(tp.id); setViewMode('list'); }}
                      className="gcw-card p-2.5 cursor-pointer space-y-1.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${gradeCls(tp.validation_grade)}`}>
                          验证:{tp.validation_grade}
                        </span>
                        <span className="text-[10px] text-slate-500 font-mono-num">#{tp.id}</span>
                      </div>
                      <div className="font-semibold text-slate-100 line-clamp-2">{tp.topic_title}</div>
                      <div className="text-[10px] text-slate-400 flex justify-between">
                        <span>{tp.origin_label || '—'}</span>
                        <span className="font-mono-num">证据 {tp.content_evidence_count ?? 0}</span>
                      </div>
                      <div className="pt-1 border-t border-[#1E2E4A] flex gap-1" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={tp.production_status_norm}
                          onChange={(e) => handlePatch(tp.id, { production_status: e.target.value }, `已移动至「${e.target.value}」（市场验证等级不变）`)}
                          className="gcw-input w-full px-1.5 py-0.5 text-[10px]"
                        >
                          {PROD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 flex gap-2.5 min-h-0 overflow-hidden">
          {/* FIX-A06: 最左栏动态项目分类（从数据库读取真实项目，含全部项目与未归类） */}
          <div className="w-[168px] shrink-0 gcw-panel flex flex-col overflow-hidden">
            <div className="px-2.5 py-2 gcw-panel-header text-xs font-semibold text-slate-200">
              项目分类
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1 text-xs">
              <button
                onClick={() => setActiveProjectFilter(0)}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between transition ${
                  activeProjectFilter === 0 ? 'bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 font-semibold' : 'text-slate-300 hover:bg-[#162238] border border-transparent'
                }`}
              >
                <span className="truncate">全部项目</span>
                <span className="font-mono-num text-[10px] opacity-80">{projectCategories?.all_projects?.active_count ?? '—'}</span>
              </button>
              {(projectCategories?.projects || []).map((p: any) => (
                <button
                  key={p.id}
                  onClick={() => setActiveProjectFilter(p.id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between transition ${
                    activeProjectFilter === p.id ? 'bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 font-semibold' : 'text-slate-300 hover:bg-[#162238] border border-transparent'
                  }`}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="font-mono-num text-[10px] opacity-80">{p.active_count}</span>
                </button>
              ))}
              <button
                onClick={() => setActiveProjectFilter(-1)}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between transition ${
                  activeProjectFilter === -1 ? 'bg-amber-500/20 border border-amber-400/50 text-amber-200 font-semibold' : 'text-slate-400 hover:bg-[#162238] border border-transparent'
                }`}
              >
                <span className="truncate">未归类</span>
                <span className="font-mono-num text-[10px] opacity-80">{projectCategories?.unassigned?.active_count ?? 0}</span>
              </button>
            </div>
          </div>

          {/* 中左：紧凑选题列表（支持批量修改状态） */}
          <div className="w-[310px] shrink-0 gcw-panel flex flex-col overflow-hidden">
            <div className="px-3 py-2 gcw-panel-header text-xs font-semibold flex justify-between items-center text-slate-200">
              <span>选题列表 <span className="font-mono-num text-cyan-300">({topics.length})</span></span>
              <span className="text-[10px] text-slate-400">状态由用户控制</span>
            </div>
            {checkedTopicIds.length > 0 && (
              <div className="px-2.5 py-1.5 bg-cyan-500/10 border-b border-cyan-500/30 flex items-center gap-1.5 text-[11px]">
                <span className="text-cyan-300 shrink-0">已选 {checkedTopicIds.length} 条</span>
                <select
                  value={batchTargetStatus}
                  onChange={(e) => setBatchTargetStatus(e.target.value)}
                  className="gcw-input px-1.5 py-0.5 text-[11px] flex-1"
                >
                  {PROD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={handleBatchStatusUpdate} disabled={busy} className="gcw-btn-cyan px-2 py-0.5 rounded font-semibold shrink-0">
                  批量改态
                </button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto divide-y divide-[#1A2842]">
              {topics.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">暂无匹配选题，可从 SearchHub 发现或点击右上角人工新建。</div>
              ) : (
                topics.map((tp) => (
                  <div
                    key={tp.id}
                    onClick={() => loadDetail(tp.id, tp.project_id)}
                    className={`p-2.5 cursor-pointer space-y-1.5 transition ${selectedId === tp.id ? 'bg-cyan-500/12 border-l-2 border-cyan-400' : 'hover:bg-[#162238]'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        <input
                          type="checkbox"
                          checked={checkedTopicIds.includes(tp.id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const ck = e.target.checked;
                            setCheckedTopicIds((prev) => (ck ? [...prev, tp.id] : prev.filter((x) => x !== tp.id)));
                          }}
                          className="accent-cyan-400 mr-0.5"
                        />
                        <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${gradeCls(tp.validation_grade)}`}>
                          {tp.validation_grade}
                        </span>
                        <span className="px-1.5 py-0.2 rounded bg-[#0C1424] border border-[#2C4268] text-[10px] text-slate-300">
                          {tp.production_status_norm}
                        </span>
                        {activeProjectFilter === 0 && tp.project_name && (
                          <span className="px-1.5 py-0.2 rounded bg-slate-800 text-[10px] text-cyan-300">{tp.project_name}</span>
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handlePatch(tp.id, { is_favorite: !tp.is_favorite }, !tp.is_favorite ? '⭐ 已收藏' : '已取消收藏'); }}
                        className={tp.is_favorite ? 'text-amber-400' : 'text-slate-600 hover:text-amber-300'}
                      >
                        <Star className="w-3.5 h-3.5" fill={tp.is_favorite ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                    <div className="text-xs font-semibold text-slate-100 line-clamp-2 leading-snug">
                      <span className="text-cyan-400 font-mono-num mr-1">#{tp.id}</span>
                      {tp.topic_title}
                    </div>
                    <div className="text-[10px] text-slate-400 flex justify-between font-mono-num">
                      <span>作品证据:{tp.content_evidence_count ?? 0} · 关联文案:{tp.linked_transcript_count ?? 0}</span>
                      <span className={tp.script_ready ? 'text-emerald-400' : 'text-slate-500'}>{tp.script_ready ? '● 文案已备' : '待备文案'}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 右：完整选题档案与三分区视频证据列表 */}
          <div className="flex-1 gcw-panel flex flex-col min-w-0 overflow-hidden">
            {!detail?.topic ? (
              <div className="flex-1 flex items-center justify-center text-xs text-slate-500">点击左侧任意选题查看完整档案、证据链路与文案联动</div>
            ) : (
              <div className="flex-1 overflow-y-auto p-3.5 space-y-3 text-xs">
                {/* 头部操作栏 */}
                <div className="flex flex-wrap items-start justify-between gap-2 pb-2.5 border-b border-[#1E2E4A]">
                  <div className="space-y-1.5 flex-1 min-w-[240px]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`px-2 py-0.5 rounded font-bold text-[11px] ${gradeCls(detail.topic.validation_grade)}`}>
                        市场验证：{detail.topic.validation_grade}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-[#0C1424] border border-[#2C4268] text-slate-300 text-[11px] font-mono-num">
                        规则：{detail.topic.validation_rule_version || '—'}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/35 text-cyan-300 text-[11px]">
                        来源：{detail.topic.origin_label || '—'}
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono-num">覆盖率 {detail.topic.evidence_coverage_pct ?? 0}%</span>
                    </div>
                    <h2 className="text-sm font-bold text-slate-100">
                      <span className="text-cyan-400 font-mono-num mr-1">#{detail.topic.id}</span>
                      {detail.topic.topic_title}
                    </h2>
                    <div className="text-[11px] text-slate-400">
                      核心问题：{detail.topic.research_question || '—'} · 角度：{detail.topic.angle || '—'}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    <select
                      value={detail.topic.project_id ?? -1}
                      onChange={(e) => handlePatch(detail.topic.id, { target_project_id: Number(e.target.value) }, '✅ 已人工调整选题所属研究项目')}
                      className="gcw-input px-2 py-1 text-xs"
                      title="人工调整选题归属项目"
                    >
                      {(projectCategories?.projects || []).map((p: any) => (
                        <option key={p.id} value={p.id}>项目：{p.name}</option>
                      ))}
                      <option value={-1}>项目：未归类</option>
                    </select>
                    <select
                      value={detail.topic.production_status_norm}
                      onChange={(e) => handlePatch(detail.topic.id, { production_status: e.target.value }, `创作状态已改为「${e.target.value}」（市场验证等级保持不变）`)}
                      className="gcw-input px-2 py-1 text-xs font-semibold"
                    >
                      {PROD_STATUSES.map((s) => <option key={s} value={s}>状态：{s}</option>)}
                    </select>
                    <button
                      onClick={() => handleRevertStatus(detail.topic.id)}
                      disabled={busy || detail.topic.production_status_norm === '待研究'}
                      className="gcw-btn-ghost px-2 py-1 rounded-lg text-[11px] disabled:opacity-40"
                      title="退回上一阶段"
                    >
                      ↩ 退回
                    </button>
                    <button
                      onClick={() => handleArchiveOrRestore(detail.topic.id, detail.topic.production_status_norm !== '已归档')}
                      disabled={busy}
                      className="gcw-btn-ghost px-2 py-1 rounded-lg text-[11px]"
                    >
                      {detail.topic.production_status_norm === '已归档' ? '♻ 恢复' : '📦 归档'}
                    </button>
                    <button
                      onClick={() => handlePatch(detail.topic.id, { script_ready: !detail.topic.script_ready }, detail.topic.script_ready ? '已取消文案就绪' : '✅ 已标记文案已准备')}
                      className={`px-2 py-1 rounded-lg border text-[11px] flex items-center gap-1 ${detail.topic.script_ready ? 'bg-emerald-500/20 border-emerald-500/45 text-emerald-300' : 'gcw-btn-ghost'}`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> {detail.topic.script_ready ? '文案已准备' : '标记文案就绪'}
                    </button>
                    <button
                      onClick={() => handleReSearch(detail.topic)}
                      disabled={busy}
                      className="gcw-btn-cyan px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 disabled:opacity-40"
                    >
                      <RefreshCw className="w-3 h-3" /> 重新发起真实搜索
                    </button>
                    <button
                      onClick={() => onJumpSearch((detail.topic.keywords?.[0] || detail.topic.suggested_queries?.[0] || detail.topic.topic_title))}
                      className="gcw-btn-ghost px-2 py-1 rounded-lg text-[11px]"
                    >
                      去 SearchHub
                    </button>
                  </div>
                </div>

                {/* 参考作品视频列表（GCW-ASSET-01：筛选/排序/三分区数据展示/独立三指标/编辑与多选题关联，缺失显示 —） */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-100 flex items-center gap-2">
                      <Film className="w-4 h-4 text-cyan-400" />
                      <span>参考作品证据列表</span>
                      <span className="text-[11px] text-cyan-300 font-mono-num">
                        显示 {filteredContents.length}/{detail.contents?.length || 0} · 作者 {detail.creators?.length || 0} · 关联文案 {detail.transcripts?.length || 0}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <input
                        value={vidSearchQ}
                        onChange={(e) => setVidSearchQ(e.target.value)}
                        placeholder="搜视频标题/作者/标签..."
                        className="gcw-input px-2 py-0.5 text-[11px] w-36"
                      />
                      <select value={vidPlatformFilter} onChange={(e) => setVidPlatformFilter(e.target.value)} className="gcw-input px-1.5 py-0.5 text-[11px]">
                        <option value="">全部平台</option>
                        {videoPlatforms.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <select value={vidTagFilter} onChange={(e) => setVidTagFilter(e.target.value)} className="gcw-input px-1.5 py-0.5 text-[11px]">
                        <option value="">全部标签</option>
                        {videoTags.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <select value={vidSortBy} onChange={(e) => setVidSortBy(e.target.value as any)} className="gcw-input px-1.5 py-0.5 text-[11px]">
                        <option value="views">按播放排序</option>
                        <option value="likes">按点赞排序</option>
                        <option value="engagement">按互动率排序</option>
                        <option value="captured">按收录时间排序</option>
                      </select>
                    </div>
                  </div>
                  {filteredContents.length === 0 ? (
                    <div className="p-4 rounded-xl bg-[#0C1424] border border-[#1E2E4A] text-[11px] text-slate-500 text-center">
                      {(detail.contents || []).length === 0 ? '暂无关联参考作品证据，可在 SearchHub 内置浏览器点击「收录当前视频」' : '无匹配筛选条件的视频'}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredContents.map((c: any) => (
                        <div key={c.evidence_id} className="gcw-card p-2.5 flex items-center gap-3">
                          {/* 左区：16:9 缩略图（点击工作台内播放 + 悬停显示播放图标） */}
                          <button
                            type="button"
                            onClick={() => openInlinePlayer(c)}
                            title="点击在工作台内观看视频"
                            className="group w-36 h-[80px] shrink-0 rounded-lg overflow-hidden bg-[#0C1424] border border-[#2C4268] hover:border-cyan-400 relative flex items-center justify-center cursor-pointer transition"
                          >
                            {c.thumbnail_url ? (
                              <img src={c.thumbnail_url} alt={c.title || ''} className="w-full h-full object-cover group-hover:scale-105 transition duration-200" />
                            ) : (
                              <div className="flex flex-col items-center justify-center text-slate-500 gap-0.5">
                                <Play className="w-5 h-5 text-cyan-500/70" />
                                <span className="text-[10px] uppercase font-mono-num">{c.platform || '—'}</span>
                              </div>
                            )}
                            {/* 悬停播放图标遮罩 */}
                            <div className="absolute inset-0 bg-slate-950/45 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                              <div className="w-9 h-9 rounded-full bg-cyan-500/90 text-slate-950 flex items-center justify-center shadow-lg">
                                <Play className="w-4 h-4 ml-0.5 fill-current" />
                              </div>
                            </div>
                            <span className={`absolute top-1 left-1 px-1.5 py-0.2 rounded border text-[10px] uppercase font-bold ${platformBadgeCls(c.platform)}`}>
                              {c.platform || '—'}
                            </span>
                            {c.duration_sec ? (
                              <span className="absolute bottom-1 right-1 px-1.5 py-0.2 rounded bg-black/80 text-slate-100 text-[10px] font-mono-num">
                                {fmtDur(c.duration_sec)}
                              </span>
                            ) : null}
                          </button>

                          {/* 中区：标题（点击同样工作台内播放）+ 作者/平台/发布时间 + 研究标签 + 收录原因 */}
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <button
                                type="button"
                                onClick={() => openInlinePlayer(c)}
                                className="gcw-video-title text-left text-slate-100 hover:text-cyan-300 line-clamp-1 truncate transition cursor-pointer"
                                title={`点击在工作台内播放：${c.title || ''}`}
                              >
                                {c.title || '—'}
                              </button>
                              <a
                                href={c.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-500 hover:text-cyan-300 shrink-0"
                                title="外部链接"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            </div>
                            <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-1.5">
                              <span>{c.platform || '—'}</span>
                              <span className="text-slate-600">·</span>
                              <span>作者：{c.creator_name || '—'}</span>
                              <span className="text-slate-600">·</span>
                              <span className="font-mono-num">{c.published_at || '—'}</span>
                              {c.linked_topic_ids?.length > 1 && (
                                <span className="px-1.5 py-0.2 rounded bg-purple-500/15 border border-purple-500/35 text-purple-300 text-[9px]">
                                  关联 {c.linked_topic_ids.length} 个选题
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                              {(c.research_tags || []).map((t: string) => (
                                <button
                                  key={t}
                                  onClick={() => setVidTagFilter(vidTagFilter === t ? '' : t)}
                                  className={`px-1.5 py-0.2 rounded text-[10px] border ${vidTagFilter === t ? 'gcw-chip-active' : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300'}`}
                                >
                                  #{t}
                                </button>
                              ))}
                              {c.capture_reason && (
                                <span className="text-[10px] text-slate-400 truncate max-w-[260px]" title={c.capture_reason}>
                                  理由：{c.capture_reason}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* 右区：播放/点赞/评论/收藏 + 独立三指标（互动率/播放粉丝比/异常倍数）+ 操作 */}
                          <div className="flex items-center gap-2.5 shrink-0">
                            <div className="text-[10px] text-slate-300 font-mono-num grid grid-cols-2 gap-x-2.5 gap-y-0.5 min-w-[120px]">
                              <div className="flex items-center gap-1" title="播放量">
                                <Play className="w-2.5 h-2.5 text-slate-400" />
                                <span>{c.view_count != null ? fmtNum(c.view_count) : '—'}</span>
                              </div>
                              <div className="flex items-center gap-1" title="点赞量">
                                <ThumbsUp className="w-2.5 h-2.5 text-slate-400" />
                                <span>{c.like_count != null ? fmtNum(c.like_count) : '—'}</span>
                              </div>
                              <div className="flex items-center gap-1" title="评论量">
                                <MessageSquare className="w-2.5 h-2.5 text-slate-400" />
                                <span>{c.comment_count != null ? fmtNum(c.comment_count) : '—'}</span>
                              </div>
                              <div className="flex items-center gap-1" title="收藏量">
                                <Bookmark className="w-2.5 h-2.5 text-slate-400" />
                                <span>{c.favorite_count != null ? fmtNum(c.favorite_count) : '—'}</span>
                              </div>
                            </div>

                            <div className="gcw-metric-box px-2 py-1 text-center min-w-[82px] space-y-0.5">
                              <div className="text-[9px] text-cyan-300/80">
                                互动 {c.engagement_rate != null ? `${(c.engagement_rate * 100).toFixed(1)}%` : '—'}
                              </div>
                              <div className="text-[10px] text-slate-200 font-mono-num">
                                播粉 {c.views_to_followers != null ? `${Number(c.views_to_followers).toFixed(1)}x` : '—'}
                              </div>
                              <div className="text-[11px] font-bold font-mono-num text-cyan-300 leading-tight" title="异常爆款倍数（无可靠历史作品基准时不计算）">
                                爆款 {c.outlier_score != null ? `${Number(c.outlier_score).toFixed(1)}x` : '—'}
                              </div>
                            </div>

                            <div className="flex flex-col gap-1">
                              <button onClick={() => openVideoEditor(c)} className="gcw-btn-ghost px-2 py-0.5 rounded text-[10px] text-cyan-300 flex items-center gap-1" title="查看原始数据、编辑标签/收录原因或调整关联选题">
                                <Edit3 className="w-3 h-3" /> 详情/编辑
                              </button>
                              <button onClick={() => onOpenTranscript(c.content_id)} className="gcw-btn-ghost px-2 py-0.5 rounded text-[10px] flex items-center gap-1">
                                <FileText className="w-3 h-3" /> 文案提取
                              </button>
                              <button
                                onClick={async () => {
                                  await api.topicHubUnlinkContent(detail.topic.id, c.content_id, projectId);
                                  showToast('已取消本选题收录（原作品主体及其他选题关联不受影响）');
                                  loadDetail(detail.topic.id);
                                }}
                                className="gcw-btn-ghost px-2 py-0.5 rounded text-[10px] text-slate-400 hover:text-rose-300 flex items-center gap-1"
                                title="仅取消当前选题收录，不误删其他选题关联的作品"
                              >
                                <Unlink className="w-3 h-3" /> 取消收录
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 等级形成原因与四类信号 */}
                <div className="p-2.5 rounded-xl bg-[#0D1526] border border-[#1E2E4A] space-y-2">
                  <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> 市场验证形成原因与四类信号（严格分离）
                  </div>
                  <div className="text-[11px] text-slate-300">{detail.topic.validation_reason || detail.latest_validation?.conclusion || '尚无市场验证记录，保持 U（未验证）'}</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {[
                      ['market_attention', '① 市场关注'],
                      ['user_demand', '② 用户需求'],
                      ['purchase_intent', '③ 购买信号'],
                      ['commercial_revenue', '④ 商业收益'],
                    ].map(([k, label]) => {
                      const sig = detail.topic.four_signals?.[k] || detail.latest_validation?.four_signals?.[k];
                      return (
                        <div key={k} className="p-2 rounded-lg bg-[#162238] border border-[#1E2E4A]">
                          <div className="flex justify-between text-[11px] font-semibold">
                            <span className="text-slate-200">{label}</span>
                            <span className="text-[10px] text-cyan-300 font-mono-num">{sig?.status || '—'}</span>
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5">{sig?.summary || '—'}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 发现路径与档案补充 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  <div className="p-2.5 rounded-xl bg-[#0D1526] border border-[#1E2E4A] space-y-1">
                    <div className="font-semibold text-slate-100">发现路径与多对多关联</div>
                    <div className="text-[11px] text-slate-300">发现说明：{detail.discovery_path?.discovery_reason || '—'}</div>
                    <div className="text-[11px] text-slate-300">关联关键词：{(detail.discovery_path?.keywords || []).join(' / ') || '—'}</div>
                    <div className="text-[11px] text-slate-400">
                      原始批次：{detail.discovery_path?.batch_info ? `#${detail.discovery_path.batch_info.id} ${detail.discovery_path.batch_info.title}` : '人工创建 / —'}
                    </div>
                    {detail.discovery_path?.second_round_batch && (
                      <div className="text-[11px] text-emerald-300">
                        二次/重研批次：#{detail.discovery_path.second_round_batch.id} [{detail.discovery_path.second_round_batch.status}] ({detail.discovery_path.second_round_batch.total_results}条)
                      </div>
                    )}
                    {detail.parent_topics?.length > 0 && (
                      <div className="text-[11px] text-amber-300">
                        父选题：{detail.parent_topics.map((p: any) => `#${p.topic_id || '?'} ${p.topic_title || p.parent_keyword}`).join('；')}
                      </div>
                    )}
                    {detail.child_topics?.length > 0 && (
                      <div className="text-[11px] text-cyan-300">
                        衍生/合并子选题：{detail.child_topics.map((c: any) => `#${c.topic_id} ${c.topic_title}`).join('；')}
                      </div>
                    )}
                  </div>

                  {/* 用户备注、事实核实与差异化编辑 */}
                  <div className="p-2.5 rounded-xl bg-[#0D1526] border border-[#1E2E4A] space-y-1.5">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-slate-100">档案补充（绝不 AI 虚构缺失信息）</span>
                      <select value={editFact} onChange={(e) => setEditFact(e.target.value)} className="gcw-input px-1.5 py-0.5 text-[10px]">
                        <option value="待核实">事实：待核实</option>
                        <option value="部分核实">事实：部分核实</option>
                        <option value="已核实">事实：已核实</option>
                      </select>
                    </div>
                    <input value={editAudience} onChange={(e) => setEditAudience(e.target.value)} placeholder="目标受众..." className="gcw-input w-full px-2 py-1 text-[11px]" />
                    <input value={editDiff} onChange={(e) => setEditDiff(e.target.value)} placeholder="原创差异化建议..." className="gcw-input w-full px-2 py-1 text-[11px]" />
                    <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={2} placeholder="用户备注..." className="gcw-input w-full px-2 py-1 text-[11px]" />
                    <button
                      onClick={() => handlePatch(detail.topic.id, { target_audience: editAudience, differentiation_notes: editDiff, user_notes: editNotes, fact_check_status: editFact }, '✅ 已保存选题档案')}
                      className="gcw-btn-cyan px-2.5 py-1 rounded-lg text-[11px] font-semibold"
                    >
                      保存档案补充
                    </button>
                  </div>
                </div>

                {/* Phase 5：原创文案版本（Skill 联动）与标准化创作资料包导出 */}
                <div className="p-3 rounded-xl bg-[#0D1526] border border-[#1E2E4A] space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                      <Package className="w-4 h-4 text-cyan-400" />
                      <span>标准化创作资料包 & 原创文案多版本</span>
                    </div>
                    <button
                      onClick={handleGeneratePackage}
                      disabled={pkgBusy}
                      className="px-3 py-1 rounded-lg bg-emerald-600/85 hover:bg-emerald-500 text-white font-semibold text-[11px] flex items-center gap-1 disabled:opacity-40 transition"
                    >
                      <Package className="w-3.5 h-3.5" /> {pkgBusy ? '生成资料包中...' : '生成创作资料包 (13文件 + ZIP)'}
                    </button>
                  </div>

                  {/* 资料完整性检查与缺失资料显式提示 */}
                  {pkgCheck && (
                    <div className="p-2 rounded-lg bg-[#162238] border border-[#1E2E4A] text-[11px] space-y-1">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-semibold text-slate-100">
                          导出前完整性检查：{pkgCheck.is_fully_complete ? '✅ 资料完整' : `⚠ 存在 ${pkgCheck.missing_materials?.length || 0} 项缺失/待核实（允许导出研究资料包，绝不虚构补齐）`}
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono-num">
                          作品:{pkgCheck.counts?.contents ?? 0} · 评论:{pkgCheck.counts?.comments ?? 0} · 原文案:{pkgCheck.counts?.transcripts ?? 0} · 原创版:{pkgCheck.counts?.script_versions ?? 0}
                        </span>
                      </div>
                      {(pkgCheck.todo_items || []).length > 0 && (
                        <div className="text-[10px] text-amber-300">待办：{pkgCheck.todo_items.slice(0, 3).join('；')}</div>
                      )}
                    </div>
                  )}

                  {/* 原创文案 Skill 选择与版本保存 */}
                  <div className="p-2.5 rounded-lg bg-[#162238] border border-[#1E2E4A] space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-200 flex items-center gap-1"><Sparkles className="w-3.5 h-3.5 text-purple-400" /> 选择文案 Skill：</span>
                      <select value={selectedSkill} onChange={(e) => setSelectedSkill(e.target.value)} className="gcw-input px-2 py-0.5 text-[11px]">
                        {scriptSkills.map((sk) => (
                          <option key={sk.skill_id} value={sk.skill_id}>{sk.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleRunScriptSkill}
                        disabled={scriptBusy}
                        className="gcw-btn-purple px-2.5 py-0.5 rounded font-semibold text-[11px] disabled:opacity-40"
                      >
                        {scriptBusy ? '执行中...' : selectedSkill === 'manual' ? '保存最终确认文案' : '调用 Skill 生成独立版本'}
                      </button>
                    </div>
                    <input
                      value={userViewpoint}
                      onChange={(e) => setUserViewpoint(e.target.value)}
                      placeholder="可选：输入你的原创观点（将与原作品观点、模型推断严格分离保存）..."
                      className="gcw-input w-full px-2 py-1 text-[11px]"
                    />
                    {selectedSkill === 'manual' && (
                      <textarea
                        value={manualScriptText}
                        onChange={(e) => setManualScriptText(e.target.value)}
                        rows={3}
                        placeholder="输入手动原创/最终确认文案正文..."
                        className="gcw-input w-full px-2 py-1 text-[11px]"
                      />
                    )}
                    {scriptVersions.length > 0 && (
                      <div className="pt-1 border-t border-[#1E2E4A] space-y-1">
                        <div className="text-[10px] font-semibold text-slate-300">已保存独立文案版本 ({scriptVersions.length})：</div>
                        {scriptVersions.slice(0, 4).map((sv) => (
                          <div key={sv.id} className="text-[10px] text-slate-300 flex justify-between bg-[#0C1424] px-2 py-1 rounded border border-[#1E2E4A]">
                            <span><strong className="text-cyan-300">v{sv.version_no}</strong> [{sv.version_kind_label}] {sv.title} (Skill:{sv.skill_name})</span>
                            <span className="text-slate-400">{sv.is_final ? '⭐最终版' : sv.created_at}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 历史创作资料包导出版本列表 */}
                  {packages.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold text-slate-200">历史创作资料包版本 ({packages.length}，绝不覆盖旧版)：</div>
                      <div className="space-y-1">
                        {packages.map((pk) => (
                          <div key={pk.id} className="p-2 rounded-lg bg-[#162238] border border-[#1E2E4A] flex flex-wrap items-center justify-between gap-2 text-[11px]">
                            <div>
                              <span className="font-semibold text-cyan-300">v{pk.package_version}</span> · <span className="font-mono-num text-[10px] text-slate-300">{pk.package_uid}</span>
                              <span className="ml-2 text-[10px] text-slate-400">{pk.created_at}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <a href={`/api/topic-hub/packages/${pk.package_uid}/download/md?project_id=${projectId}`} target="_blank" rel="noopener noreferrer" className="gcw-btn-ghost px-2 py-0.5 rounded text-[10px] flex items-center gap-1">
                                <Download className="w-3 h-3" /> Markdown
                              </a>
                              <a href={`/api/topic-hub/packages/${pk.package_uid}/download/zip?project_id=${projectId}`} target="_blank" rel="noopener noreferrer" className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-semibold flex items-center gap-1">
                                <Download className="w-3 h-3" /> 完整 ZIP
                              </a>
                              <a href={`/api/topic-hub/packages/${pk.package_uid}/download/manifest?project_id=${projectId}`} target="_blank" rel="noopener noreferrer" className="gcw-btn-ghost px-2 py-0.5 rounded text-[10px]">
                                Manifest JSON
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* 状态变更历史 */}
                {detail.status_history?.length > 0 && (
                  <div className="p-2.5 rounded-xl bg-[#0D1526] border border-[#1E2E4A] space-y-1">
                    <div className="font-semibold text-slate-200">状态修改历史 ({detail.status_history.length})</div>
                    <div className="space-y-0.5 max-h-28 overflow-y-auto text-[10px] text-slate-400 font-mono-num">
                      {detail.status_history.map((h: any) => (
                        <div key={h.id}>
                          [{h.created_at}] {h.field_name}: {h.old_value || '—'} → <strong className="text-cyan-300">{h.new_value}</strong>（{h.reason || h.changed_by}）
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 弹窗 1：人工直接创建原创选题 */}
      {createOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-[2px] flex items-center justify-center z-50 p-4">
          <div className="bg-[#111A2E] border border-[#2C4268] rounded-2xl w-full max-w-md p-4 space-y-3 text-xs text-slate-100 shadow-2xl">
            <div className="flex justify-between items-center font-bold text-sm">
              <span>人工新建原创选题（不强制先 AI 搜索）</span>
              <button onClick={() => setCreateOpen(false)} className="text-slate-400 hover:text-slate-100"><X className="w-4 h-4" /></button>
            </div>
            <div className="text-[11px] text-amber-300 bg-amber-500/15 border border-amber-500/35 rounded-lg px-2.5 py-1.5">
              说明：新建人工原创选题的市场验证等级严格保持 <strong>U（未验证）</strong>；你可以直接将其设为「待制作」，但不改变验证等级。
            </div>
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="选题标题 *" className="gcw-input w-full px-2.5 py-1.5" />
            <input value={newQuestion} onChange={(e) => setNewQuestion(e.target.value)} placeholder="核心研究问题" className="gcw-input w-full px-2.5 py-1.5" />
            <input value={newAngle} onChange={(e) => setNewAngle(e.target.value)} placeholder="原创切入角度" className="gcw-input w-full px-2.5 py-1.5" />
            <input value={newAudience} onChange={(e) => setNewAudience(e.target.value)} placeholder="目标受众" className="gcw-input w-full px-2.5 py-1.5" />
            <input value={newKeywords} onChange={(e) => setNewKeywords(e.target.value)} placeholder="关联关键词（逗号分隔）" className="gcw-input w-full px-2.5 py-1.5" />
            <input value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="行业标签（逗号分隔）" className="gcw-input w-full px-2.5 py-1.5" />
            <select value={newProdStatus} onChange={(e) => setNewProdStatus(e.target.value)} className="gcw-input w-full px-2.5 py-1.5">
              {PROD_STATUSES.map((s) => <option key={s} value={s}>初始制作状态：{s}</option>)}
            </select>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setCreateOpen(false)} className="gcw-btn-ghost px-3 py-1.5 rounded-lg">取消</button>
              <button onClick={handleCreateManual} disabled={busy} className="gcw-btn-cyan px-3 py-1.5 rounded-lg font-semibold disabled:opacity-40">确认创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 4：TopicHub 工作台内嵌视频播放浮层 + 真实双语字幕同步停靠条（复用 Electron WebContentsView） */}
      {playingVideo && (
        <div className={`fixed inset-0 bg-black/80 backdrop-blur-[2px] flex items-center justify-center z-50 ${playerMaximized ? 'p-1.5' : 'p-4'}`}>
          <div
            className={`bg-[#111A2E] border border-[#2C4268] flex flex-col overflow-hidden text-slate-100 shadow-2xl ${
              playerMaximized ? 'w-full h-full rounded-lg' : 'rounded-2xl w-full max-w-5xl h-[88vh]'
            }`}
          >
            <div className="px-4 py-2 bg-[#131E36] border-b border-[#1E2E4A] flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => {
                    setPlayerMaximized(false);
                    closeInlinePlayer();
                  }}
                  className="gcw-btn-ghost px-2.5 py-1 rounded-lg gcw-text-btn flex items-center gap-1 shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> 返回列表
                </button>
                <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase font-bold shrink-0 ${platformBadgeCls(playingVideo.platform)}`}>
                  {playingVideo.platform || '—'}
                </span>
                <span className="gcw-video-title truncate text-slate-100">{playingVideo.title || '—'}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {isElectron && (
                  <>
                    <button onClick={() => playerBrowser?.back()} disabled={!playerState.canGoBack} className="gcw-btn-ghost p-1 rounded disabled:opacity-30" title="后退">
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => playerBrowser?.forward()} disabled={!playerState.canGoForward} className="gcw-btn-ghost p-1 rounded disabled:opacity-30" title="前进">
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => playerBrowser?.reload()} className="gcw-btn-ghost p-1 rounded" title="刷新">
                      <RotateCw className={`w-3.5 h-3.5 ${playerState.isLoading ? 'animate-spin text-cyan-400' : ''}`} />
                    </button>
                  </>
                )}
                <button
                  onClick={() => setPlayerMaximized((v) => !v)}
                  className="gcw-btn-ghost px-2 py-1 rounded-lg text-[11px] flex items-center gap-1"
                  title="工作台内部最大化播放（持续保留底部双语字幕；平台原生全屏无法叠加工作台外部字幕）"
                >
                  {playerMaximized ? <Minimize2 className="w-3.5 h-3.5 text-cyan-400" /> : <Maximize2 className="w-3.5 h-3.5 text-cyan-400" />}
                  <span>{playerMaximized ? '退出最大化' : '工作台最大化'}</span>
                </button>
                <button
                  onClick={() => {
                    const cid = playingVideo.content_id;
                    setPlayerMaximized(false);
                    closeInlinePlayer();
                    onOpenTranscript(cid);
                  }}
                  className="gcw-btn-cyan px-2.5 py-1 rounded-lg gcw-text-btn font-semibold flex items-center gap-1"
                >
                  <FileText className="w-3.5 h-3.5" /> 文案工坊
                </button>
                <button
                  onClick={() => {
                    setPlayerMaximized(false);
                    closeInlinePlayer();
                  }}
                  className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100"
                  title="关闭播放器"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="px-4 py-1 bg-[#0D1526] border-b border-[#1E2E4A] flex items-center gap-2 text-[11px] text-slate-400 font-mono-num shrink-0">
              <Globe className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="truncate flex-1">{playerState.url || playingVideo.url}</span>
              <span className={playback.hasVideo ? (playback.paused ? 'text-amber-300' : 'text-emerald-400') : 'text-slate-500'}>
                {playback.hasVideo
                  ? `${playback.paused ? '⏸ 已暂停' : '▶ 同步播放中'} ${fmtDur(Math.floor(playback.currentTime))} / ${fmtDur(Math.floor(playback.duration || subData?.video_duration_sec || 0))}`
                  : '等待视频就绪'}
              </span>
              <span>·</span>
              <span>
                字幕：{subData?.total_count ? `${subData.translated_count}/${subData.total_count}段已译` : '未提取'}
              </span>
            </div>

            {isElectron ? (
              <div ref={playerHostRef} className="flex-1 bg-[#0B111E] relative flex items-center justify-center min-h-[240px]">
                <span className="text-xs text-slate-500">正在通过现有 Electron 内置浏览器加载真实视频页...</span>
              </div>
            ) : getFallbackEmbedUrl(playingVideo.url) ? (
              <iframe
                src={getFallbackEmbedUrl(playingVideo.url)}
                title={playingVideo.title}
                className="flex-1 w-full border-0 bg-black min-h-[240px]"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
                <div>当前为普通浏览器模式，建议使用桌面版内置浏览器直接播放该平台视频。</div>
                <a href={playingVideo.url} target="_blank" rel="noopener noreferrer" className="gcw-btn-cyan px-3 py-1.5 rounded-lg font-semibold">
                  打开原视频链接 ↗
                </a>
              </div>
            )}

            {/* FIX-F01 双语字幕区：固定采用稳定默认的紧贴视频画面下沿显示位置（已移除位置切换按钮与无依赖分支） */}
            <div className="bg-[#060B16] border-t border-[#1B2C4A] shrink-0">
              {subMode !== 'off' && (
                <div className="min-h-[58px] bg-[#040812] px-4 py-1.5 flex flex-col items-center justify-center text-center gap-0.5 border-b border-[#14223B]">
                  {subLoading ? (
                    <span className="text-xs text-slate-400 flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 正在加载字幕时间轴与译文缓存...
                    </span>
                  ) : subError ? (
                    <div className="text-xs text-amber-300">{subError}</div>
                  ) : !subData?.has_transcript ? (
                    <div className="text-xs text-slate-400">
                      当前视频尚未提取字幕，系统将自动提取或在右上角进入「文案工坊」提取时间轴。
                    </div>
                  ) : playback.isAd ? (
                    <div className="text-xs text-amber-300/90">
                      平台贴片广告播放中，正片开始后自动按真实时间轴同步双语字幕
                    </div>
                  ) : !playback.hasVideo ? (
                    <div className="text-xs text-slate-400">
                      已就绪 {subData.total_count} 段字幕（已译 {subData.translated_count} 段），播放视频后实时同步双语字幕。
                    </div>
                  ) : activeSubtitleSeg ? (
                    <>
                      {(subMode === 'bilingual' || subMode === 'zh') && (
                        <div
                          style={{ fontSize: `${subFontSize}px` }}
                          className="text-cyan-100 font-semibold leading-snug tracking-wide drop-shadow"
                        >
                          {activeSubtitleSeg.translated_text || '（本段尚未翻译，点击下方「翻译本视频字幕」即可生成）'}
                        </div>
                      )}
                      {(subMode === 'bilingual' || subMode === 'source') && (
                        <div
                          style={{ fontSize: `${Math.max(12, subFontSize - 3)}px` }}
                          className="text-slate-300/95 leading-snug"
                        >
                          {activeSubtitleSeg.text}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="h-5" aria-label="无匹配字幕留空" />
                  )}
                </div>
              )}

              <div className="bg-[#0A1120] px-4 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <Languages className="w-3.5 h-3.5 text-cyan-400" />
                  <span className="font-semibold text-slate-200">真实双语字幕</span>
                  {subData?.engine_id && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono-num text-[10px]">
                      {subData.engine_id}
                    </span>
                  )}
                  {subProgressMsg && (
                    <span className="text-[10px] text-cyan-300/90 truncate max-w-[340px]" title={subProgressMsg}>
                      · {subProgressMsg}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <div className="flex items-center bg-slate-900 rounded border border-slate-800 p-0.5">
                    {(
                      [
                        ['bilingual', '双语'],
                        ['zh', '仅中文'],
                        ['source', '仅原文'],
                        ['off', '关闭'],
                      ] as const
                    ).map(([mKey, mLabel]) => (
                      <button
                        key={mKey}
                        type="button"
                        onClick={() => setSubMode(mKey)}
                        className={`px-2 py-0.5 rounded text-[11px] transition ${
                          subMode === mKey ? 'bg-cyan-500/25 text-cyan-200 font-semibold' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {mLabel}
                      </button>
                    ))}
                  </div>
                  <select
                    value={subFontSize}
                    onChange={(e) => setSubFontSize(Number(e.target.value) as any)}
                    className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200"
                    title="字幕字号"
                  >
                    <option value={14}>14px</option>
                    <option value={18}>18px</option>
                    <option value={22}>22px</option>
                    <option value={26}>26px</option>
                  </select>
                  {subData?.has_transcript && (
                    <button
                      type="button"
                      onClick={handleTranslateInPlayer}
                      disabled={subTranslating}
                      className="px-2.5 py-0.5 rounded bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-400/40 text-indigo-200 font-medium flex items-center gap-1"
                    >
                      {subTranslating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      <span>{subData.translated_count > 0 ? '刷新/补译字幕' : '翻译本视频字幕'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPlayerMaximized(false);
                      closeInlinePlayer();
                      window.dispatchEvent(new CustomEvent('gcw:open-translation-settings'));
                    }}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1"
                    title="配置翻译引擎与费用控制"
                  >
                    <Settings className="w-3 h-3" />
                    <span>翻译配置</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 3：参考视频原始数据详情、编辑标签/收录原因与多选题关联调整 */}
      {editingVideo && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-[2px] flex items-center justify-center z-50 p-4">
          <div className="bg-[#111A2E] border border-[#2C4268] rounded-2xl w-full max-w-xl p-4 space-y-3 text-xs text-slate-100 shadow-2xl max-h-[88vh] overflow-y-auto">
            <div className="flex justify-between items-center font-bold text-sm">
              <span>视频资产详情与编辑 (#{editingVideo.content_id})</span>
              <button onClick={() => setEditingVideo(null)} className="text-slate-400 hover:text-slate-100"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-2.5 rounded-xl bg-[#0C1424] border border-[#1E2E4A] space-y-1 text-[11px] font-mono-num">
              <div className="font-sans font-semibold text-slate-100 text-xs">{editingVideo.title || '—'}</div>
              <div className="text-slate-400">平台：{editingVideo.platform || '—'} · 唯一ID：{editingVideo.platform_item_id || '—'} · 来源：{editingVideo.data_source || editingVideo.provenance || '—'}</div>
              <div className="text-slate-400">作者：{editingVideo.creator_name || '—'} · 粉丝：{editingVideo.follower_count != null ? fmtNum(editingVideo.follower_count) : '—'} · 发布：{editingVideo.published_at || '—'}</div>
              <div className="text-slate-400">采集时间：{editingVideo.collected_at || '—'} · 收录时间：{editingVideo.manual_captured_at || '—'} · 搜索词：{editingVideo.search_keyword || '—'}</div>
              <div className="text-slate-300">
                播:{editingVideo.view_count != null ? fmtNum(editingVideo.view_count) : '—'} ·
                赞:{editingVideo.like_count != null ? fmtNum(editingVideo.like_count) : '—'} ·
                评:{editingVideo.comment_count != null ? fmtNum(editingVideo.comment_count) : '—'} ·
                藏:{editingVideo.favorite_count != null ? fmtNum(editingVideo.favorite_count) : '—'} ·
                享:{editingVideo.share_count != null ? fmtNum(editingVideo.share_count) : '—'}
              </div>
              <div className="text-cyan-300">
                互动率:{editingVideo.engagement_rate != null ? `${(editingVideo.engagement_rate * 100).toFixed(2)}%` : '—'} ·
                播放粉丝比:{editingVideo.views_to_followers != null ? `${Number(editingVideo.views_to_followers).toFixed(2)}x` : '—'} ·
                异常爆款倍数:{editingVideo.outlier_score != null ? `${Number(editingVideo.outlier_score).toFixed(2)}x` : '—'}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200">作品链接（支持粘贴抖音分享文本修正，保存时核对唯一 ID 防覆盖）</span>
                {Array.isArray(editingVideo.url_edit_history) && editingVideo.url_edit_history.length > 0 && (
                  <span className="text-[10px] text-slate-400">已修正 {editingVideo.url_edit_history.length} 次（历史已留痕）</span>
                )}
              </div>
              <input
                value={editVidUrl}
                onChange={(e) => setEditVidUrl(e.target.value)}
                placeholder="https://..."
                className="gcw-input w-full px-2.5 py-1.5 text-[11px] font-mono-num text-cyan-200"
              />
              {editingVideo.original_share_url && (
                <div className="text-[10px] text-slate-400 font-mono-num truncate">
                  原始分享链接（只读保留）：{editingVideo.original_share_url}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-slate-200">研究标签</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {editVidTags.map((t) => (
                  <span key={t} className="gcw-chip-active px-2 py-0.5 rounded-full text-[11px] flex items-center gap-1">
                    {t}
                    <button onClick={() => setEditVidTags((prev) => prev.filter((x) => x !== t))}><X className="w-3 h-3" /></button>
                  </span>
                ))}
                <input
                  value={editVidTagInput}
                  onChange={(e) => setEditVidTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && editVidTagInput.trim()) {
                      e.preventDefault();
                      const nt = editVidTagInput.trim();
                      setEditVidTags((prev) => (prev.includes(nt) ? prev : [...prev, nt]));
                      setEditVidTagInput('');
                    }
                  }}
                  placeholder="+ 新增标签回车..."
                  className="gcw-input px-2 py-0.5 text-[11px] w-32"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="font-semibold text-slate-200">收录原因</div>
              <textarea value={editVidReason} onChange={(e) => setEditVidReason(e.target.value)} rows={2} className="gcw-input w-full px-2.5 py-1.5 text-xs" />
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-slate-200">关联选题（支持一视频多选题关联，作品主体全局去重）</div>
              <div className="max-h-36 overflow-y-auto space-y-1 p-2 rounded-lg bg-[#0C1424] border border-[#1E2E4A]">
                {topics.map((tp) => {
                  const checked = editVidTopicIds.includes(tp.id);
                  return (
                    <label key={tp.id} className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer hover:text-cyan-300">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setEditVidTopicIds((prev) =>
                            prev.includes(tp.id) ? prev.filter((x) => x !== tp.id) : [...prev, tp.id]
                          )
                        }
                        className="accent-cyan-400"
                      />
                      <span className="truncate">#{tp.id} {tp.topic_title}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setEditingVideo(null)} className="gcw-btn-ghost px-3 py-1.5 rounded-lg">取消</button>
              <button onClick={handleSaveVideoAsset} disabled={savingVid} className="gcw-btn-cyan px-4 py-1.5 rounded-lg font-semibold disabled:opacity-40">
                {savingVid ? '保存中...' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 2：相似选题检测与用户确认合并 */}
      {similarOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-[2px] flex items-center justify-center z-50 p-4">
          <div className="bg-[#111A2E] border border-[#2C4268] rounded-2xl w-full max-w-xl p-4 space-y-3 text-xs text-slate-100 shadow-2xl">
            <div className="flex justify-between items-center font-bold text-sm">
              <span>相似选题检测（仅提示，绝不未经确认自动删除）</span>
              <button onClick={() => setSimilarOpen(false)} className="text-slate-400 hover:text-slate-100"><X className="w-4 h-4" /></button>
            </div>
            {similarPairs.length === 0 ? (
              <div className="p-6 text-center text-slate-400">当前项目未检测到高度重复选题。</div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {similarPairs.map((p, idx) => (
                  <div key={idx} className="gcw-card p-2.5 space-y-1.5">
                    <div><strong className="text-cyan-300">保留 #{p.topic_a_id}：</strong>{p.topic_a_title}</div>
                    <div><strong className="text-amber-300">疑似重复 #{p.topic_b_id}：</strong>{p.topic_b_title}</div>
                    <div className="text-[10px] text-slate-400 font-mono-num">
                      标题相似度 {p.title_similarity} · 共同证据 ID: [{(p.shared_evidence_ids || []).join(', ')}]
                    </div>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setSimilarPairs((prev) => prev.filter((_, i) => i !== idx))} className="gcw-btn-ghost px-2 py-1 rounded">保留两个</button>
                      <button onClick={() => handleConfirmMerge(p.topic_a_id, p.topic_b_id)} disabled={busy} className="gcw-btn-cyan px-2.5 py-1 rounded font-semibold">
                        确认无损合并 (#{p.topic_b_id} → #{p.topic_a_id})
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
