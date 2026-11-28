/**
 * GCW-WORKSPACE-V2 · 选题资产中心与文案创作一体化工作区 (TopicHub V2)
 * 严格遵循用户确认的固定布局：
 * - 左侧：项目选择、选题搜索、时间排序（默认最新创建优先）与日期范围、7 态生命周期筛选、选题列表（显示真实本地时区创建时间）
 * - 右侧（从上至下）：
 *   1. 当前选题标题 + 顶部简洁参考作品切换器（无右侧参考作品栏） + 选题详情抽屉入口（低频管理功能归入抽屉）
 *   2. 横向完整内嵌视频播放区域（复用 topicPlayerView，非浮层）
 *   3. 实时双语字幕（保留 R4-G 同步与外语自动翻译，无位置切换）
 *   4. 当前视频真实数据面板（VideoMetricsBar）
 *   5. 标签页：文案创作（默认） | 内容拆解 | 高赞评论 | 研究证据
 *   6. 左右并列的参考文案（ReferenceTranscriptPane）与原创文案（OriginalCopyStudioPane）
 * - 支持视频区域与文案区域之间拖动调整高度，以及参考文案与原创文案之间拖动调整宽度
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Calendar,
  ExternalLink,
  FileText,
  Film,
  GripHorizontal,
  GripVertical,
  Info,
  Layers,
  MessageSquare,
  Package,
  Plus,
  Search,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import { api, fmtDur, fmtNum } from '../api';
import CommentTopicDiscoveryPane from '../components/workspace/CommentTopicDiscoveryPane';
import EmbeddedVideoWorkspace from '../components/workspace/EmbeddedVideoWorkspace';
import FullTextBreakdownPane from '../components/workspace/FullTextBreakdownPane';
import OriginalCopyStudioPane from '../components/workspace/OriginalCopyStudioPane';
import ReferenceTranscriptPane from '../components/workspace/ReferenceTranscriptPane';
import VideoMetricsBar, { formatLocalDateTime } from '../components/workspace/VideoMetricsBar';

interface Props {
  isActive?: boolean;
  refreshToken?: number;
  projectId: number;
  projects?: any[];
  focusTarget?: { projectId: number; topicId: number; token: number } | null;
  onConsumeFocusTarget?: () => void;
  onGoSearch?: (q: string) => void;
  overlayBlocked?: boolean;
}

type RightTab = 'copy' | 'comments' | 'evidence';
type LeftCopySubTab = 'reference' | 'breakdown';
type SortKey = 'created_desc' | 'created_asc' | 'updated_desc' | 'captured_desc';

const LIFECYCLE_STATUSES = ['待研究', '研究中', '待制作', '制作中', '待发布', '已发布', '已归档'] as const;

export default function TopicHub({
  isActive = true,
  refreshToken = 0,
  projectId,
  projects = [],
  focusTarget,
  onConsumeFocusTarget,
  onGoSearch,
  overlayBlocked = false,
}: Props) {
  const playerBrowser = useMemo(() => (window.gcwDesktopBrowser as any)?.forView?.('topicPlayer') || null, []);

  // 左侧筛选与列表状态
  const [selectedProjId, setSelectedProjId] = useState<number>(projectId);
  const [categories, setCategories] = useState<any>(null);
  const [topics, setTopics] = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [q, setQ] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('created_desc');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showDateFilter, setShowDateFilter] = useState(false);

  // 当前选中选题 & 详情
  const [activeTopicId, setActiveTopicId] = useState<number | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [activeContentId, setActiveContentId] = useState<number | null>(null);

  // 右侧工作区交互状态
  const [rightTab, setRightTab] = useState<RightTab>('copy');
  const [leftCopySubTab, setLeftCopySubTab] = useState<LeftCopySubTab>('reference');
  const [videoHeightPx, setVideoHeightPx] = useState<number>(() => {
    const saved = Number(localStorage.getItem('gcw_v2_video_h') || '320');
    return Number.isFinite(saved) && saved >= 180 && saved <= 640 ? saved : 320;
  });
  const [refWidthPct, setRefWidthPct] = useState<number>(() => {
    const saved = Number(localStorage.getItem('gcw_v2_ref_w') || '48');
    return Number.isFinite(saved) && saved >= 25 && saved <= 75 ? saved : 48;
  });
  const [videoMaximized, setVideoMaximized] = useState(false);

  // 字幕与联动状态
  const [subData, setSubData] = useState<any | null>(null);
  const [activeSegIdx, setActiveSegIdx] = useState<number | null>(null);
  const [seekWarning, setSeekWarning] = useState('');

  // 高赞评论 / 内容拆解 / 选题详情抽屉 / 新建选题弹窗
  const [comments, setComments] = useState<any[]>([]);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [newTopicOpen, setNewTopicOpen] = useState(false);
  const [newTopicTitle, setNewTopicTitle] = useState('');
  const [newTopicQuestion, setNewTopicQuestion] = useState('');
  const [toast, setToast] = useState('');

  // 抽屉内低频管理编辑态
  const [editNotes, setEditNotes] = useState('');
  const [editDiff, setEditDiff] = useState('');
  const [editAudience, setEditAudience] = useState('');
  const [pkgBusy, setPkgBusy] = useState(false);

  const listReqSeqRef = useRef(0);
  const detailReqSeqRef = useRef(0);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 4000);
  };

  // 响应外部项目切换
  useEffect(() => {
    setSelectedProjId(projectId);
  }, [projectId]);

  // 响应 SearchHub 一键收录后「前往选题资产中心查看 →」精准跳转
  useEffect(() => {
    if (!focusTarget) return;
    setSelectedProjId(focusTarget.projectId);
    setQ('');
    setFilterStatus('');
    setDateFrom('');
    setDateTo('');
    setActiveTopicId(focusTarget.topicId);
    onConsumeFocusTarget?.();
  }, [focusTarget?.token]);

  // 拉取左侧项目分类与选题列表（带 reqSeq 防异步竞态）
  const loadTopics = async () => {
    const seq = ++listReqSeqRef.current;
    setLoadingList(true);
    try {
      const [catRes, listRes] = await Promise.all([
        api.topicHubProjectCategories().catch(() => null),
        api.topicHubList({
          project_id: selectedProjId,
          q: q.trim(),
          production_status: filterStatus,
          include_published: 'true',
          include_archived: filterStatus === '已归档' ? 'true' : 'false',
          sort_by: sortBy,
          date_from: dateFrom,
          date_to: dateTo,
          limit: 120,
        }),
      ]);
      if (seq !== listReqSeqRef.current) return;
      if (catRes?.ok) setCategories(catRes);
      const list = listRes?.topics || [];
      setTopics(list);
      if (list.length > 0) {
        setActiveTopicId((prev) => (prev && list.some((t: any) => t.id === prev) ? prev : list[0].id));
      } else {
        setActiveTopicId(null);
        setDetail(null);
        setActiveContentId(null);
      }
    } catch {
      if (seq === listReqSeqRef.current) setTopics([]);
    } finally {
      if (seq === listReqSeqRef.current) setLoadingList(false);
    }
  };

  useEffect(() => {
    loadTopics();
  }, [selectedProjId, filterStatus, sortBy, dateFrom, dateTo, refreshToken]);

  // 加载当前选题详情（带 reqSeq 防快速切选题竞态）
  const loadDetail = async (tid: number) => {
    const seq = ++detailReqSeqRef.current;
    try {
      const res = await api.topicHubDetail(tid, selectedProjId > 0 ? selectedProjId : null);
      if (seq !== detailReqSeqRef.current) return;
      if (res?.ok) {
        setDetail(res);
        setEditNotes(res.topic?.user_notes || '');
        setEditDiff(res.topic?.differentiation_notes || '');
        setEditAudience(res.topic?.target_audience || '');
        const evContents = (res.contents || res.evidence?.contents || []).filter((x: any) => x?.content_id || x?.id);
        setActiveContentId((prev) => {
          if (prev && evContents.some((x: any) => Number(x.content_id || x.id) === prev)) return prev;
          return evContents.length ? Number(evContents[0].content_id || evContents[0].id) : null;
        });
      }
    } catch {
      if (seq === detailReqSeqRef.current) setDetail(null);
    }
  };

  useEffect(() => {
    setSeekWarning('');
    setActiveSegIdx(null);
    if (!activeTopicId) {
      setDetail(null);
      setActiveContentId(null);
      return;
    }
    loadDetail(activeTopicId);
  }, [activeTopicId]);

  // FIX-04: 加载当前作品的高赞评论（带序号防旧响应覆盖新作品）
  const commentsReqSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++commentsReqSeqRef.current;
    setComments([]);
    if (!activeContentId) return;
    api
      .listComments(activeContentId, false)
      .then((r) => {
        if (seq !== commentsReqSeqRef.current) return;
        setComments(r?.comments || []);
      })
      .catch(() => {
        if (seq !== commentsReqSeqRef.current) return;
        setComments([]);
      });
  }, [activeContentId]);

  const topicContents: any[] = useMemo(() => detail?.contents || detail?.evidence?.contents || [], [detail]);
  const activeVideo = useMemo(() => {
    if (!activeContentId) return topicContents[0] || null;
    return topicContents.find((c: any) => Number(c.content_id || c.id) === activeContentId) || topicContents[0] || null;
  }, [topicContents, activeContentId]);

  // 点击参考文案时间戳 -> 真实跳转视频播放器
  const handleSeekToSeconds = async (sec: number) => {
    setSeekWarning('');
    if (!playerBrowser?.seekVideo) {
      setSeekWarning('当前非桌面端内嵌播放器，暂不支持时间戳跳转');
      return;
    }
    try {
      const res = await playerBrowser.seekVideo(sec);
      if (!res?.ok || !res?.supported) {
        setSeekWarning(res?.reason || '当前平台播放器不支持时间戳跳转');
      }
    } catch (e: any) {
      setSeekWarning(`时间戳跳转失败：${e?.message || e}`);
    }
  };

  // 拖动调整视频区域高度
  const startVerticalResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = videoHeightPx;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(620, Math.max(180, startH + (ev.clientY - startY)));
      setVideoHeightPx(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      localStorage.setItem('gcw_v2_video_h', String(videoHeightPx));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 拖动调整参考文案与原创文案宽度比例
  const startHorizontalResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const pct = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 100;
      const clamped = Math.min(72, Math.max(28, Math.round(pct)));
      setRefWidthPct(clamped);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      localStorage.setItem('gcw_v2_ref_w', String(refWidthPct));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handlePatchTopic = async (patch: any, okMsg = '✅ 已更新选题') => {
    if (!activeTopicId) return;
    try {
      await api.topicHubPatch(activeTopicId, { project_id: detail?.topic?.project_id || selectedProjId, ...patch });
      showToast(okMsg);
      await loadDetail(activeTopicId);
      await loadTopics();
    } catch (e: any) {
      showToast('更新失败：' + (e?.message || e));
    }
  };

  const handleCreateManualTopic = async () => {
    if (!newTopicTitle.trim()) return;
    try {
      const pid = selectedProjId > 0 ? selectedProjId : projectId;
      const res = await api.topicHubCreate({
        project_id: pid,
        topic_title: newTopicTitle.trim(),
        research_question: newTopicQuestion.trim(),
        production_status: '待研究',
      });
      if (res?.ok && res.topic?.id) {
        setNewTopicOpen(false);
        setNewTopicTitle('');
        setNewTopicQuestion('');
        showToast('✅ 已新建原创选题');
        await loadTopics();
        setActiveTopicId(res.topic.id);
      }
    } catch (e: any) {
      showToast('新建失败：' + (e?.message || e));
    }
  };

  const handleGeneratePackage = async () => {
    if (!activeTopicId || pkgBusy) return;
    setPkgBusy(true);
    try {
      const pid = detail?.topic?.project_id || projectId;
      const res = await api.topicHubGeneratePackage(activeTopicId, { project_id: pid });
      if (res?.ok) showToast('✅ 已生成标准化创作资料包（13 文件 + ZIP）');
    } catch (e: any) {
      showToast('生成资料包失败：' + (e?.message || e));
    } finally {
      setPkgBusy(false);
    }
  };

  // 任何上层弹窗/抽屉打开时自动隐藏原生 WebContentsView，彻底防止遮挡
  const hideNativePlayer = Boolean(overlayBlocked || detailDrawerOpen || newTopicOpen);

  return (
    <div className="h-full w-full flex bg-[#0b111e] text-slate-100 overflow-hidden relative">
      {/* Toast 提示 */}
      {toast && (
        <div className="fixed top-4 right-5 z-50 px-4 py-2 rounded-xl bg-cyan-600/95 text-white gcw-text-btn font-semibold shadow-xl">
          {toast}
        </div>
      )}

      {/* ==================== 左侧栏：项目选择 + 选题搜索 + 时间排序 + 生命周期 + 选题列表 ==================== */}
      <aside className="w-[330px] shrink-0 border-r border-[#1e2e4a] bg-[#0e1628] flex flex-col min-h-0">
        {/* 顶栏：标题 + 新建选题 */}
        <div className="px-3.5 py-2.5 border-b border-[#1e2e4a] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Layers className="w-5 h-5 text-cyan-400 shrink-0" />
            <span className="gcw-section-title text-slate-100 truncate">选题资产中心</span>
          </div>
          <button
            type="button"
            onClick={() => setNewTopicOpen(true)}
            className="gcw-btn-cyan px-2.5 py-1 rounded-lg gcw-text-tag font-semibold inline-flex items-center gap-1 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> 新建
          </button>
        </div>

        {/* 项目选择 + 搜索 + 排序与日期筛选 */}
        <div className="p-3 border-b border-[#1e2e4a] space-y-2 shrink-0">
          <select
            value={selectedProjId}
            onChange={(e) => setSelectedProjId(Number(e.target.value))}
            className="gcw-input w-full px-2.5 py-1.5 gcw-text-btn font-semibold text-cyan-200"
          >
            <option value={0}>全部项目 ({categories?.all_projects?.active_count ?? '—'})</option>
            {(categories?.projects || projects).map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.active_count ?? '—'})
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadTopics()}
                placeholder="搜索选题标题/关键词..."
                className="gcw-input w-full pl-8 pr-2.5 py-1.5 gcw-text-btn"
              />
            </div>
            <button
              type="button"
              onClick={loadTopics}
              className="gcw-btn-ghost px-2.5 py-1.5 rounded-lg gcw-text-tag shrink-0"
            >
              搜
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="gcw-input flex-1 min-w-0 px-2 py-1 gcw-text-tag"
              title="选题列表排序方式"
            >
              <option value="created_desc">最新创建优先</option>
              <option value="created_asc">最早创建优先</option>
              <option value="updated_desc">最近更新优先</option>
              <option value="captured_desc">最近收录优先</option>
            </select>
            <button
              type="button"
              onClick={() => setShowDateFilter((v) => !v)}
              className={`px-2 py-1 rounded-lg gcw-text-tag border inline-flex items-center gap-1 shrink-0 ${
                showDateFilter || dateFrom || dateTo
                  ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-200'
                  : 'gcw-btn-ghost'
              }`}
              title="按创建日期范围筛选"
            >
              <Calendar className="w-3.5 h-3.5" /> 日期
            </button>
          </div>

          {showDateFilter && (
            <div className="grid grid-cols-2 gap-1.5 pt-0.5">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="gcw-input px-2 py-1 gcw-text-meta font-mono-num"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="gcw-input px-2 py-1 gcw-text-meta font-mono-num"
              />
            </div>
          )}

          {/* 7 态生命周期筛选 */}
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setFilterStatus('')}
              className={`px-2 py-0.5 rounded gcw-text-meta border transition ${
                filterStatus === '' ? 'gcw-tab-active' : 'bg-[#0c1424] border-[#1e2e4a] text-slate-400 hover:text-slate-200'
              }`}
            >
              全部({topics.length})
            </button>
            {LIFECYCLE_STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setFilterStatus(filterStatus === st ? '' : st)}
                className={`px-2 py-0.5 rounded gcw-text-meta border transition ${
                  filterStatus === st ? 'gcw-tab-active' : 'bg-[#0c1424] border-[#1e2e4a] text-slate-400 hover:text-slate-200'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>

        {/* 选题列表（显示真实本地时区创建时间） */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
          {loadingList ? (
            <div className="text-center py-8 text-slate-500 gcw-text-base">加载选题中...</div>
          ) : !topics.length ? (
            <div className="text-center py-8 text-slate-500 gcw-text-base">当前筛选条件下暂无选题</div>
          ) : (
            topics.map((t) => {
              const active = t.id === activeTopicId;
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveTopicId(t.id)}
                  className={`p-2.5 rounded-xl border cursor-pointer transition space-y-1 ${
                    active
                      ? 'bg-cyan-500/15 border-cyan-400/60 shadow-sm'
                      : 'bg-[#111a2e] border-[#1e2e4a] hover:border-[#2c4268]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 gcw-text-meta font-mono-num shrink-0">
                        {t.validation_grade || 'U'}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 gcw-text-meta shrink-0">
                        {t.production_status_norm || '待研究'}
                      </span>
                    </div>
                    {t.is_favorite ? <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0" /> : null}
                  </div>
                  <div className="gcw-video-title text-slate-100 line-clamp-2 leading-snug">
                    #{t.id} {t.topic_title}
                  </div>
                  <div className="flex items-center justify-between gcw-text-meta text-slate-400 font-mono-num">
                    <span>创建：{formatLocalDateTime(t.created_at)}</span>
                    <span>视频:{t.content_count ?? t.evidence_count ?? 0}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ==================== 右侧一体化工作区（固定 6 层结构） ==================== */}
      <main className="flex-1 min-w-0 h-full flex flex-col overflow-hidden p-3 gap-2">
        {/* 1. 当前选题标题 + 顶部简洁作品切换器 + 选题详情入口 */}
        <div className="gcw-panel px-4 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <h1 className="gcw-section-title text-slate-100 truncate">
              {detail?.topic ? `#${detail.topic.id} ${detail.topic.topic_title}` : '请选择左侧选题'}
            </h1>
            {detail?.topic && (
              <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 gcw-text-tag shrink-0">
                {detail.topic.production_status_norm || '待研究'}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {/* 同一选题多个参考作品时，通过顶部简洁选择器切换，绝不另建侧边栏 */}
            {topicContents.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Film className="w-4 h-4 text-cyan-400 shrink-0" />
                <select
                  value={activeVideo ? Number(activeVideo.content_id || activeVideo.id) : ''}
                  onChange={(e) => setActiveContentId(Number(e.target.value))}
                  className="gcw-input px-2.5 py-1 gcw-text-btn max-w-[280px]"
                  title="切换当前选题关联的参考视频"
                >
                  {topicContents.map((c: any, idx: number) => (
                    <option key={c.content_id || c.id} value={c.content_id || c.id}>
                      视频 {idx + 1}/{topicContents.length}：{(c.title || '未命名').slice(0, 32)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {detail?.topic && (
              <button
                type="button"
                onClick={() => setDetailDrawerOpen(true)}
                className="gcw-btn-ghost px-3 py-1 rounded-lg gcw-text-btn inline-flex items-center gap-1.5"
              >
                <Info className="w-4 h-4 text-cyan-400" /> 选题详情与档案
              </button>
            )}
          </div>
        </div>

        {/* 2 & 3. 横向完整内嵌视频播放区域 + 实时双语字幕 */}
        <EmbeddedVideoWorkspace
          isActive={isActive}
          activeVideo={activeVideo}
          playerBrowser={playerBrowser}
          overlayHidden={hideNativePlayer}
          heightPx={videoHeightPx}
          maximized={videoMaximized}
          onToggleMaximize={() => setVideoMaximized((v) => !v)}
          subData={subData}
          onSubDataChange={setSubData}
          onActiveSegmentIdxChange={setActiveSegIdx}
        />

        {/* 视频区域与下方区域的高度拖动分隔条 */}
        {!videoMaximized && (
          <div
            onMouseDown={startVerticalResize}
            className="h-2 -my-1 flex items-center justify-center cursor-row-resize group shrink-0"
            title="上下拖动调整视频播放区与文案区高度"
          >
            <div className="w-24 h-1 rounded-full bg-[#2c4268] group-hover:bg-cyan-400 transition flex items-center justify-center">
              <GripHorizontal className="w-4 h-3 text-slate-400 group-hover:text-cyan-200" />
            </div>
          </div>
        )}

        {/* 4. 当前视频真实数据面板 */}
        {!videoMaximized && (
          <VideoMetricsBar
            contentId={activeVideo ? Number(activeVideo.content_id || activeVideo.id) : null}
            playerBrowser={playerBrowser}
            fallbackItem={activeVideo}
          />
        )}

        {/* 5. 标签页：文案创作 | 高赞评论 | 研究证据（FIX-04: 取消独立内容拆解主标签，市场四类信号归入选题详情抽屉） */}
        {!videoMaximized && (
          <div className="flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              {(
                [
                  ['copy', '文案创作', FileText],
                  ['comments', `高赞评论 (${comments.length})`, MessageSquare],
                  ['evidence', `研究证据 (${topicContents.length})`, Layers],
                ] as [RightTab, string, any][]
              ).map(([k, lbl, Icon]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setRightTab(k)}
                  className={`px-3.5 py-1.5 rounded-lg gcw-text-btn font-semibold inline-flex items-center gap-1.5 border transition ${
                    rightTab === k
                      ? 'gcw-tab-active'
                      : 'bg-[#111a2e] border-[#1e2e4a] text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 6. 下方主创作区域 */}
        {!videoMaximized && (
          <div className="flex-1 min-h-0 overflow-hidden">
            {rightTab === 'copy' && (
              <div ref={splitContainerRef} className="h-full w-full flex min-h-0">
                <div style={{ width: `${refWidthPct}%` }} className="h-full min-w-0 pr-1 flex flex-col">
                  {/* FIX-04: 左侧双子标签（参考文案 | 全文拆解） */}
                  <div className="flex items-center gap-1 mb-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setLeftCopySubTab('reference')}
                      className={`px-3 py-1 rounded-lg gcw-text-tag font-semibold border transition ${
                        leftCopySubTab === 'reference'
                          ? 'gcw-tab-active'
                          : 'bg-[#111a2e] border-[#1e2e4a] text-slate-400 hover:text-slate-100'
                      }`}
                    >
                      参考文案
                    </button>
                    <button
                      type="button"
                      onClick={() => setLeftCopySubTab('breakdown')}
                      className={`px-3 py-1 rounded-lg gcw-text-tag font-semibold border transition inline-flex items-center gap-1 ${
                        leftCopySubTab === 'breakdown'
                          ? 'gcw-tab-active'
                          : 'bg-[#111a2e] border-[#1e2e4a] text-slate-400 hover:text-slate-100'
                      }`}
                    >
                      <Sparkles className="w-3.5 h-3.5" /> 全文拆解
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 overflow-hidden">
                    {leftCopySubTab === 'reference' ? (
                      <ReferenceTranscriptPane
                        contentId={activeVideo ? Number(activeVideo.content_id || activeVideo.id) : null}
                        videoTitle={activeVideo?.title || ''}
                        subData={subData}
                        onSubDataChange={setSubData}
                        activeSegmentIdx={activeSegIdx}
                        onSeekToSeconds={handleSeekToSeconds}
                        seekWarning={seekWarning}
                      />
                    ) : (
                      <div className="gcw-panel h-full overflow-hidden">
                        <FullTextBreakdownPane
                          contentId={activeVideo ? Number(activeVideo.content_id || activeVideo.id) : null}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* 左右宽度拖动分隔条 */}
                <div
                  onMouseDown={startHorizontalResize}
                  className="w-2.5 flex items-center justify-center cursor-col-resize group shrink-0"
                  title="左右拖动调整参考文案与二创文案宽度"
                >
                  <div className="h-16 w-1 rounded-full bg-[#2c4268] group-hover:bg-cyan-400 transition flex items-center justify-center">
                    <GripVertical className="w-3 h-4 text-slate-400 group-hover:text-cyan-200" />
                  </div>
                </div>

                <div style={{ width: `${100 - refWidthPct}%` }} className="h-full min-w-0 pl-1">
                  <OriginalCopyStudioPane
                    projectId={detail?.topic?.project_id || (selectedProjId > 0 ? selectedProjId : projectId)}
                    topicId={activeTopicId}
                    topicTitle={detail?.topic?.topic_title || ''}
                    activeContentId={activeVideo ? Number(activeVideo.content_id || activeVideo.id) : null}
                    topicContents={topicContents}
                  />
                </div>
              </div>
            )}

            {rightTab === 'comments' && (
              <CommentTopicDiscoveryPane
                projectId={detail?.topic?.project_id || (selectedProjId > 0 ? selectedProjId : projectId)}
                contentId={activeVideo ? Number(activeVideo.content_id || activeVideo.id) : null}
                comments={comments}
                onTopicAdded={() => loadTopics()}
              />
            )}

            {rightTab === 'evidence' && (
              <div className="gcw-panel h-full overflow-y-auto p-4 space-y-2.5">
                <div className="gcw-section-title text-slate-100">当前选题关联参考作品证据（点击直接切换上方播放）</div>
                {!topicContents.length ? (
                  <div className="text-slate-500 gcw-text-base py-6">当前选题暂无关联作品证据</div>
                ) : (
                  topicContents.map((c: any) => {
                    const cid = Number(c.content_id || c.id);
                    const isCur = activeVideo && Number(activeVideo.content_id || activeVideo.id) === cid;
                    return (
                      <div
                        key={cid}
                        onClick={() => setActiveContentId(cid)}
                        className={`p-3 rounded-xl border cursor-pointer transition flex items-center justify-between gap-3 ${
                          isCur
                            ? 'bg-cyan-500/15 border-cyan-400/60'
                            : 'bg-[#0c1424] border-[#1e2e4a] hover:border-[#2c4268]'
                        }`}
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="gcw-video-title text-slate-100 truncate">{c.title || '未命名作品'}</div>
                          <div className="gcw-text-tag text-slate-400 font-mono-num">
                            {(c.platform || '').toUpperCase()} · 作者：{c.author_name || '—'} · 时长：{fmtDur(c.duration_sec)} · 播放：{fmtNum(c.view_count)} · 赞：{fmtNum(c.like_count)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="px-2.5 py-1 rounded-lg bg-cyan-500/20 text-cyan-300 gcw-text-tag font-semibold">
                            {isCur ? '正在播放' : '点击播放'}
                          </span>
                          {c.url && (
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="p-1.5 rounded bg-slate-800 text-slate-300 hover:text-cyan-300"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ==================== 选题详情与低频管理抽屉（打开时自动隐藏原生播放器防遮挡） ==================== */}
      {detailDrawerOpen && detail?.topic && (
        <div className="fixed inset-0 z-50 bg-black/65 flex justify-end">
          <div className="w-full max-w-xl bg-[#111a2e] border-l border-[#2c4268] h-full flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#1e2e4a] flex items-center justify-between">
              <span className="gcw-section-title text-slate-100">选题详情与低频管理</span>
              <button type="button" onClick={() => setDetailDrawerOpen(false)} className="p-1 rounded hover:bg-slate-800 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div className="space-y-1 gcw-text-tag text-slate-400 font-mono-num">
                <div>选题 ID：#{detail.topic.id}</div>
                <div>创建时间：{formatLocalDateTime(detail.topic.created_at)}</div>
                <div>更新时间：{formatLocalDateTime(detail.topic.updated_at)}</div>
              </div>

              {/* FIX-04: 现有市场四类信号归入选题详情与档案，不删除原有数据 */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['市场关注', detail.topic.four_signals?.market_attention],
                  ['用户需求', detail.topic.four_signals?.user_demand],
                  ['购买信号', detail.topic.four_signals?.purchase_intent],
                  ['商业收益', detail.topic.four_signals?.commercial_revenue],
                ].map(([lbl, sig]: any) => (
                  <div key={lbl} className="p-2 rounded-lg bg-[#0c1424] border border-[#1e2e4a] space-y-0.5">
                    <div className="gcw-text-meta font-semibold text-cyan-300">{lbl}</div>
                    <div className="gcw-text-meta text-slate-300">{sig?.summary || '—'}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="gcw-text-tag text-slate-300 block">所属项目</label>
                  <select
                    value={detail.topic.project_id}
                    onChange={(e) => handlePatchTopic({ target_project_id: Number(e.target.value) }, '✅ 已迁移选题所属项目')}
                    className="gcw-input w-full px-2.5 py-1.5 gcw-text-btn"
                  >
                    {projects.map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="gcw-text-tag text-slate-300 block">生命周期状态</label>
                  <select
                    value={detail.topic.production_status_norm || '待研究'}
                    onChange={(e) => handlePatchTopic({ production_status: e.target.value }, `✅ 状态已切换为「${e.target.value}」`)}
                    className="gcw-input w-full px-2.5 py-1.5 gcw-text-btn"
                  >
                    {LIFECYCLE_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="gcw-text-tag text-slate-300 block">目标受众</label>
                <input value={editAudience} onChange={(e) => setEditAudience(e.target.value)} className="gcw-input w-full px-3 py-1.5 gcw-text-base" />
              </div>

              <div className="space-y-1">
                <label className="gcw-text-tag text-slate-300 block">原创差异化建议</label>
                <textarea value={editDiff} onChange={(e) => setEditDiff(e.target.value)} rows={3} className="gcw-input w-full px-3 py-1.5 gcw-text-base" />
              </div>

              <div className="space-y-1">
                <label className="gcw-text-tag text-slate-300 block">用户研究备注</label>
                <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={3} className="gcw-input w-full px-3 py-1.5 gcw-text-base" />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() =>
                    handlePatchTopic({
                      target_audience: editAudience,
                      differentiation_notes: editDiff,
                      user_notes: editNotes,
                    })
                  }
                  className="gcw-btn-cyan px-4 py-1.5 rounded-lg gcw-text-btn font-semibold"
                >
                  保存档案补充
                </button>
                <button
                  type="button"
                  onClick={handleGeneratePackage}
                  disabled={pkgBusy}
                  className="gcw-btn-purple px-4 py-1.5 rounded-lg gcw-text-btn font-semibold inline-flex items-center gap-1.5"
                >
                  <Package className="w-4 h-4" /> {pkgBusy ? '生成中...' : '生成创作资料包'}
                </button>
                {onGoSearch && (
                  <button
                    type="button"
                    onClick={() => {
                      setDetailDrawerOpen(false);
                      onGoSearch(detail.topic.topic_title);
                    }}
                    className="gcw-btn-ghost px-3 py-1.5 rounded-lg gcw-text-btn"
                  >
                    去 SearchHub 深搜
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handlePatchTopic({ production_status: '已归档' }, '✅ 已归档该选题')}
                  className="gcw-btn-ghost px-3 py-1.5 rounded-lg gcw-text-btn inline-flex items-center gap-1 text-amber-300"
                >
                  <Archive className="w-4 h-4" /> 归档
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== 新建原创选题弹窗 ==================== */}
      {newTopicOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#111a2e] border border-[#2c4268] rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="gcw-section-title text-slate-100">新建原创选题</span>
              <button type="button" onClick={() => setNewTopicOpen(false)} className="p-1 text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <input
                value={newTopicTitle}
                onChange={(e) => setNewTopicTitle(e.target.value)}
                placeholder="输入选题标题 *"
                className="gcw-input w-full px-3 py-2 gcw-text-base"
              />
              <textarea
                value={newTopicQuestion}
                onChange={(e) => setNewTopicQuestion(e.target.value)}
                rows={3}
                placeholder="核心研究问题（可选）"
                className="gcw-input w-full px-3 py-2 gcw-text-base"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setNewTopicOpen(false)} className="gcw-btn-ghost px-4 py-1.5 rounded-lg gcw-text-btn">
                取消
              </button>
              <button type="button" onClick={handleCreateManualTopic} className="gcw-btn-cyan px-4 py-1.5 rounded-lg gcw-text-btn font-semibold">
                确认创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
