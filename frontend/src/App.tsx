import { useEffect, useState } from 'react';
import {
  Calculator,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Compass,
  DollarSign,
  Flame,
  FolderKanban,
  Inbox,
  Layers,
  Plus,
  Radio,
  Search,
  Send,
  Settings,
  Terminal,
  Trash2,
} from 'lucide-react';
import { api } from './api';
import type { Project } from './api';
import RevenueCalculatorDrawer from './components/RevenueCalculatorDrawer';
import SettingsModal from './components/SettingsModal';
import ContentAuthors from './pages/ContentAuthors';
import CreatorTracker from './pages/CreatorTracker';
import HotTrends from './pages/HotTrends';
import PublishHub from './pages/PublishHub';
import ResourceDirectory from './pages/ResourceDirectory';
import RevenueRadar from './pages/RevenueRadar';
import SearchHub from './pages/SearchHub';
import TopicHub from './pages/TopicHub';
import TranscriptStudio from './pages/TranscriptStudio';
import VideoStudio from './pages/VideoStudio';

type PageKey = 'search' | 'topics' | 'trends' | 'tracker' | 'contents' | 'transcript' | 'video' | 'publish' | 'revenue' | 'directory';
type FontScaleKey = 'compact' | 'standard' | 'comfortable' | 'large';

const FONT_SCALE_OPTIONS: { key: FontScaleKey; label: string; px: string }[] = [
  { key: 'compact', label: '紧凑', px: '14' },
  { key: 'standard', label: '标准', px: '15' },
  { key: 'comfortable', label: '舒适', px: '16' },
  { key: 'large', label: '大字', px: '18' },
];

export default function App() {
  const [boot, setBoot] = useState<any>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number>(1);

  const [page, setPage] = useState<PageKey>('search');
  const [mountedPages, setMountedPages] = useState<PageKey[]>(['search']);
  const [topicRefreshToken, setTopicRefreshToken] = useState<number>(0);
  const [searchSeedKw, setSearchSeedKw] = useState<string | null>(null);
  const [focusTopicTarget, setFocusTopicTarget] = useState<{ projectId: number; topicId: number; token: number } | null>(null);
  const [activeContentId, setActiveContentId] = useState<number | null>(null);
  const [autoExtractToken, setAutoExtractToken] = useState<number>(0);
  const [xrayTarget, setXrayTarget] = useState<{ query: string; platform: string } | null>(null);
  const [fontScale, setFontScale] = useState<FontScaleKey>(() => {
    const saved = (localStorage.getItem('gcw_font_scale') || 'comfortable') as FontScaleKey;
    return ['compact', 'standard', 'comfortable', 'large'].includes(saved) ? saved : 'comfortable';
  });
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => localStorage.getItem('gcw_nav_collapsed') === '1');

  const [calcOpen, setCalcOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addingProj, setAddingProj] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [projErr, setProjErr] = useState('');

  const loadBoot = async (preferProjectId?: number) => {
    const data = await api.bootstrap();
    setBoot(data);
    const serverScale = data?.settings?.ui_font_scale as FontScaleKey | undefined;
    if (serverScale && ['compact', 'standard', 'comfortable', 'large'].includes(serverScale)) {
      setFontScale(serverScale);
      localStorage.setItem('gcw_font_scale', serverScale);
    }
    const list: Project[] = data.projects || [];
    setProjects(list);
    if (preferProjectId && list.some((p) => p.id === preferProjectId)) {
      setProjectId(preferProjectId);
    } else if (list.length > 0 && !list.some((p) => p.id === projectId)) {
      setProjectId(list[0].id);
    }
  };

  const handleAddProject = async () => {
    const name = newProjName.trim();
    if (!name) return;
    setProjErr('');
    try {
      const created = await api.createProject({ name });
      setNewProjName('');
      setAddingProj(false);
      await loadBoot(created.id);
    } catch (e: any) {
      setProjErr(e.message);
    }
  };

  const handleDeleteProject = async () => {
    const cur = projects.find((p) => p.id === projectId);
    if (!cur || projects.length <= 1) return;
    if (!window.confirm(`确定删除项目「${cur.name}」吗？（已收录的视频素材会保留，不会丢失）`)) return;
    setProjErr('');
    try {
      await api.deleteProject(projectId);
      const next = projects.find((p) => p.id !== projectId);
      await loadBoot(next?.id);
    } catch (e: any) {
      setProjErr(e.message);
    }
  };

  useEffect(() => {
    loadBoot();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.fontScale = fontScale;
  }, [fontScale]);

  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener('gcw:open-translation-settings', handler);
    return () => window.removeEventListener('gcw:open-translation-settings', handler);
  }, []);

  // FIX-09: 按需首次挂载并保活已访问导航页
  useEffect(() => {
    setMountedPages((prev) => (prev.includes(page) ? prev : [...prev, page]));
  }, [page]);

  // FIX-01: 全局单一活动原生浏览器视图控制（任一时刻仅允许当前活动模块视图显示，弹窗打开立即全部隐藏）
  useEffect(() => {
    const bridge = window.gcwDesktopBrowser as any;
    if (!bridge) return;
    if (settingsOpen || calcOpen) {
      bridge.setActiveView?.(null)?.catch?.(() => {});
      return;
    }
    if (page === 'search') {
      bridge.setActiveView?.('research')?.catch?.(() => {});
    } else if (page === 'topics') {
      bridge.setActiveView?.('topicPlayer')?.catch?.(() => {});
    } else {
      bridge.setActiveView?.(null)?.catch?.(() => {});
    }
  }, [page, settingsOpen, calcOpen]);

  const handleChangeFontScale = (next: FontScaleKey) => {
    setFontScale(next);
    localStorage.setItem('gcw_font_scale', next);
    api.saveSettings({ ui_font_scale: next }).catch(() => {});
  };

  const navItems: { key: PageKey; label: string; sub: string; icon: any }[] = [
    { key: 'search', label: '关键词搜爆款', sub: '10大平台 + YT排序直拉', icon: Search },
    { key: 'topics', label: '选题资产中心', sub: '视频 · 数据 · 参考与原创文案', icon: Layers },
    { key: 'trends', label: '全网实时热榜', sub: '8大平台热搜实时看', icon: Radio },
    { key: 'tracker', label: '爆款博主追踪', sub: '贴主页直看视频与倍数', icon: Flame },
    { key: 'contents', label: '素材与作者库', sub: '收录 + 变现指纹', icon: Inbox },
    ...(boot?.settings?.feature_video_studio !== '0'
      ? [{ key: 'video' as PageKey, label: '智能视频制作', sub: '25卡动效 + 透明层导出', icon: Clapperboard }]
      : []),
    ...(boot?.settings?.feature_publish_hub === '1'
      ? [{ key: 'publish' as PageKey, label: '多平台发布', sub: '7平台只填写 · 人工确认', icon: Send }]
      : []),
    { key: 'revenue', label: '赛道收益雷达', sub: '11大变现 + 决策卡', icon: DollarSign },
    { key: 'directory', label: '网址导航总库', sub: '166站全量筛选', icon: Compass },
  ];

  const lowThreshold = parseInt(boot?.settings?.low_follower_threshold || '50000', 10);

  return (
    <div className="h-screen w-screen flex bg-[#070b14] text-slate-200 overflow-hidden">
      {/* 左侧可折叠主导航栏 */}
      <aside className={`${navCollapsed ? 'w-16' : 'w-60'} shrink-0 bg-[#0b1120] border-r border-slate-800/90 flex flex-col transition-all duration-150`}>
        <div className="p-3 border-b border-slate-800/90 flex items-center justify-between gap-1">
          {!navCollapsed && (
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-cyan-400 font-bold gcw-nav-text tracking-tight truncate">
                <Terminal className="w-4 h-4 shrink-0" />
                <span className="truncate">全球情报工作台</span>
              </div>
              <div className="gcw-text-meta text-slate-500 mt-0.5 font-mono-num truncate">
                TopicHub V2 · DARK
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              const next = !navCollapsed;
              setNavCollapsed(next);
              localStorage.setItem('gcw_nav_collapsed', next ? '1' : '0');
            }}
            title={navCollapsed ? '展开主导航' : '折叠主导航'}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-cyan-300 shrink-0 mx-auto"
          >
            {navCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        {/* 项目选择器（展开时显示） */}
        {!navCollapsed && (
          <div className="p-3 border-b border-slate-800/80 space-y-1.5">
            <div className="flex items-center justify-between gcw-text-meta text-slate-400">
              <span className="flex items-center gap-1">
                <FolderKanban className="w-3.5 h-3.5" /> 当前研究项目
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setAddingProj(!addingProj);
                    setProjErr('');
                  }}
                  title="新建研究项目"
                  className="p-0.5 rounded hover:bg-cyan-500/20 text-cyan-400 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={handleDeleteProject}
                  disabled={projects.length <= 1}
                  title={projects.length <= 1 ? '至少保留 1 个项目' : '删除当前项目'}
                  className="p-0.5 rounded hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 disabled:opacity-30 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <select
              value={projectId}
              onChange={(e) => setProjectId(Number(e.target.value))}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 gcw-text-btn text-slate-100 font-medium"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            {addingProj && (
              <div className="flex gap-1 pt-0.5">
                <input
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddProject()}
                  placeholder="输入新项目名..."
                  autoFocus
                  className="flex-1 min-w-0 bg-slate-950 border border-cyan-500/50 rounded px-2 py-1 gcw-text-btn text-slate-100 focus:outline-none"
                />
                <button
                  onClick={handleAddProject}
                  className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white gcw-text-tag shrink-0"
                >
                  加
                </button>
              </div>
            )}
            {projErr && <div className="gcw-text-meta text-rose-400">{projErr}</div>}
          </div>
        )}

        {/* 主页面导航 */}
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {navItems.map((n) => {
            const Icon = n.icon;
            const active = page === n.key;
            return (
              <button
                key={n.key}
                onClick={() => setPage(n.key)}
                title={navCollapsed ? n.label : undefined}
                className={`w-full text-left ${navCollapsed ? 'px-2 justify-center' : 'px-3'} py-2.5 rounded-xl transition flex items-center gap-2.5 ${
                  active
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100 border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {!navCollapsed && (
                  <div className="min-w-0">
                    <div className="gcw-nav-text font-semibold truncate">{n.label}</div>
                    <div className="gcw-text-meta opacity-70 truncate">{n.sub}</div>
                  </div>
                )}
              </button>
            );
          })}
        </nav>

        {/* 底部常驻工具按钮 + 4 档字号切换（重启持久保持，禁止整窗缩放） */}
        <div className="p-2.5 border-t border-slate-800/90 space-y-1.5">
          {!navCollapsed && (
            <div className="px-1.5 py-1 rounded-lg bg-slate-900/90 border border-slate-800 space-y-1">
              <div className="gcw-text-meta text-slate-400 flex justify-between items-center">
                <span>界面字号</span>
                <span className="font-mono-num text-cyan-400">{FONT_SCALE_OPTIONS.find((x) => x.key === fontScale)?.px}px</span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {FONT_SCALE_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => handleChangeFontScale(opt.key)}
                    className={`py-0.5 rounded gcw-text-meta font-medium transition ${
                      fontScale === opt.key
                        ? 'bg-cyan-500/20 border border-cyan-400/60 text-cyan-300'
                        : 'bg-slate-950 border border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                    title={`${opt.label} (${opt.px}px)`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            onClick={() => setCalcOpen(true)}
            title="收益反推计算器"
            className={`w-full py-2 ${navCollapsed ? 'px-2 justify-center' : 'px-3'} rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 gcw-text-btn font-medium flex items-center gap-2`}
          >
            <Calculator className="w-4 h-4 shrink-0" />
            {!navCollapsed && <span>收益反推计算器</span>}
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            title="翻译 Key / 设置"
            className={`w-full py-2 ${navCollapsed ? 'px-2 justify-center' : 'px-3 justify-between'} rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 gcw-text-btn flex items-center`}
          >
            <span className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-slate-400 shrink-0" />
              {!navCollapsed && <span>翻译 Key / 设置</span>}
            </span>
            {!navCollapsed && <span className={`w-2 h-2 rounded-full ${boot?.env?.llm_configured ? 'bg-emerald-400' : 'bg-slate-600'}`} />}
          </button>
        </div>
      </aside>

      {/* 主内容区域（FIX-09: 按需首次挂载 + display:none 保活，切换页面不卸载、不丢失滚动/视频/编辑状态） */}
      <main className="flex-1 flex flex-col min-w-0 p-3.5 overflow-hidden relative">
        {mountedPages.includes('search') && (
          <div className={page === 'search' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <SearchHub
              isActive={page === 'search' && !settingsOpen && !calcOpen}
              projectId={projectId}
              projectName={projects.find((p) => p.id === projectId)?.name || ''}
              projects={projects}
              lowFollowerThreshold={lowThreshold}
              externalQuery={searchSeedKw}
              onOpenTranscript={(cid) => {
                setActiveContentId(cid);
                setPage('topics');
              }}
              onGoTopicHub={(targetPid, targetTid) => {
                const nextPid = targetPid || projectId;
                if (nextPid !== projectId) setProjectId(nextPid);
                setTopicRefreshToken((t) => t + 1);
                if (targetTid) {
                  setFocusTopicTarget({ projectId: nextPid, topicId: targetTid, token: Date.now() });
                }
                setPage('topics');
              }}
            />
          </div>
        )}
        {mountedPages.includes('topics') && (
          <div className={page === 'topics' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <TopicHub
              isActive={page === 'topics'}
              refreshToken={topicRefreshToken}
              projectId={projectId}
              projects={projects}
              focusTarget={focusTopicTarget}
              onConsumeFocusTarget={() => setFocusTopicTarget(null)}
              onGoSearch={(kw) => {
                setSearchSeedKw(kw);
                setPage('search');
              }}
              overlayBlocked={settingsOpen || calcOpen}
            />
          </div>
        )}
        {mountedPages.includes('trends') && (
          <div className={page === 'trends' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <HotTrends
              projectId={projectId}
              onJumpSearchKeyword={(kw) => {
                setSearchSeedKw(kw);
                setPage('search');
              }}
            />
          </div>
        )}
        {mountedPages.includes('tracker') && (
          <div className={page === 'tracker' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <CreatorTracker
              projectId={projectId}
              onOpenTranscript={(cid) => {
                setActiveContentId(cid);
                setPage('topics');
              }}
              onInspectCreatorRevenue={(handle, platform) => {
                setXrayTarget({ query: handle, platform });
                setPage('revenue');
              }}
            />
          </div>
        )}
        {mountedPages.includes('contents') && (
          <div className={page === 'contents' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <ContentAuthors
              projectId={projectId}
              onOpenTranscript={(cid) => {
                setActiveContentId(cid);
                setPage('topics');
              }}
              onInspectCreatorRevenue={(handle, platform) => {
                setXrayTarget({ query: handle, platform });
                setPage('revenue');
              }}
            />
          </div>
        )}
        {mountedPages.includes('transcript') && (
          <div className={page === 'transcript' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <TranscriptStudio
              projectId={projectId}
              activeContentId={activeContentId}
              autoExtractToken={autoExtractToken}
              onSelectContent={setActiveContentId}
            />
          </div>
        )}
        {mountedPages.includes('video') && (
          <div className={page === 'video' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <VideoStudio projectId={projectId} onJumpPublish={() => setPage('publish')} />
          </div>
        )}
        {mountedPages.includes('publish') && (
          <div className={page === 'publish' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <PublishHub projectId={projectId} />
          </div>
        )}
        {mountedPages.includes('revenue') && (
          <div className={page === 'revenue' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <RevenueRadar initialXray={xrayTarget} onOpenCalc={() => setCalcOpen(true)} />
          </div>
        )}
        {mountedPages.includes('directory') && (
          <div className={page === 'directory' ? 'h-full w-full flex flex-col min-h-0' : 'hidden'}>
            <ResourceDirectory />
          </div>
        )}
      </main>

      <RevenueCalculatorDrawer open={calcOpen} onClose={() => setCalcOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} boot={boot} onSaved={loadBoot} />
    </div>
  );
}
