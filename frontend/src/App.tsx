import { useEffect, useState } from 'react';
import {
  Calculator,
  Clapperboard,
  Compass,
  DollarSign,
  FileText,
  Flame,
  FolderKanban,
  Inbox,
  Plus,
  Radio,
  Search,
  Send,
  Settings,
  Terminal,
  Trash2,
} from 'lucide-react';
import { api } from './api';
import type { Project, ScriptTemplate } from './api';
import RevenueCalculatorDrawer from './components/RevenueCalculatorDrawer';
import SettingsModal from './components/SettingsModal';
import ContentAuthors from './pages/ContentAuthors';
import CreatorTracker from './pages/CreatorTracker';
import HotTrends from './pages/HotTrends';
import PublishHub from './pages/PublishHub';
import ResourceDirectory from './pages/ResourceDirectory';
import RevenueRadar from './pages/RevenueRadar';
import SearchHub from './pages/SearchHub';
import TranscriptStudio from './pages/TranscriptStudio';
import VideoStudio from './pages/VideoStudio';

type PageKey = 'search' | 'trends' | 'tracker' | 'contents' | 'transcript' | 'video' | 'publish' | 'revenue' | 'directory';

export default function App() {
  const [boot, setBoot] = useState<any>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number>(1);
  const [templates, setTemplates] = useState<ScriptTemplate[]>([]);

  const [page, setPage] = useState<PageKey>('search');
  const [searchSeedKw, setSearchSeedKw] = useState<string | null>(null);
  const [activeContentId, setActiveContentId] = useState<number | null>(null);
  const [xrayTarget, setXrayTarget] = useState<{ query: string; platform: string } | null>(null);

  const [calcOpen, setCalcOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addingProj, setAddingProj] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [projErr, setProjErr] = useState('');

  const loadBoot = async (preferProjectId?: number) => {
    const data = await api.bootstrap();
    setBoot(data);
    setTemplates(data.script_templates || []);
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

  const navItems: { key: PageKey; label: string; sub: string; icon: any }[] = [
    { key: 'search', label: '关键词搜爆款', sub: '10大平台 + YT排序直拉', icon: Search },
    { key: 'trends', label: '全网实时热榜', sub: '8大平台热搜实时看', icon: Radio },
    { key: 'tracker', label: '爆款博主追踪', sub: '贴主页直看视频与倍数', icon: Flame },
    { key: 'contents', label: '素材与作者库', sub: '收录 + 变现指纹', icon: Inbox },
    { key: 'transcript', label: '文案提取工坊', sub: '五级提取 + 二创', icon: FileText },
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
      {/* 左侧金融终端风导航栏 */}
      <aside className="w-56 shrink-0 bg-[#0b1120] border-r border-slate-800/90 flex flex-col">
        <div className="p-4 border-b border-slate-800/90">
          <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm tracking-tight">
            <Terminal className="w-4 h-4" />
            <span>全球情报工作台</span>
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-mono-num">
            MVP v1.0 · TERMINAL DARK
          </div>
        </div>

        {/* 项目选择器（支持新增与删除） */}
        <div className="p-3 border-b border-slate-800/80 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span className="flex items-center gap-1">
              <FolderKanban className="w-3 h-3" /> 当前研究项目
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
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 font-medium"
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
                className="flex-1 min-w-0 bg-slate-950 border border-cyan-500/50 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none"
              />
              <button
                onClick={handleAddProject}
                className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] shrink-0"
              >
                加
              </button>
            </div>
          )}
          {projErr && <div className="text-[10px] text-rose-400">{projErr}</div>}
        </div>

        {/* 五大主页面导航 */}
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {navItems.map((n) => {
            const Icon = n.icon;
            const active = page === n.key;
            return (
              <button
                key={n.key}
                onClick={() => setPage(n.key)}
                className={`w-full text-left px-3 py-2.5 rounded-xl transition flex items-center gap-2.5 ${
                  active
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100 border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold">{n.label}</div>
                  <div className="text-[10px] opacity-70 truncate">{n.sub}</div>
                </div>
              </button>
            );
          })}
        </nav>

        {/* 底部常驻工具按钮 */}
        <div className="p-2.5 border-t border-slate-800/90 space-y-1.5">
          <button
            onClick={() => setCalcOpen(true)}
            className="w-full py-2 px-3 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 text-xs font-medium flex items-center gap-2"
          >
            <Calculator className="w-4 h-4" />
            <span>收益反推计算器</span>
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="w-full py-2 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs flex items-center justify-between"
          >
            <span className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-slate-400" />
              <span>翻译 Key / 设置</span>
            </span>
            <span className={`w-2 h-2 rounded-full ${boot?.env?.llm_configured ? 'bg-emerald-400' : 'bg-slate-600'}`} />
          </button>
        </div>
      </aside>

      {/* 主内容区域 */}
      <main className="flex-1 flex flex-col min-w-0 p-3.5 overflow-hidden">
        {page === 'search' && (
          <SearchHub
            projectId={projectId}
            lowFollowerThreshold={lowThreshold}
            externalQuery={searchSeedKw}
            onOpenTranscript={(cid) => {
              setActiveContentId(cid);
              setPage('transcript');
            }}
          />
        )}
        {page === 'trends' && (
          <HotTrends
            projectId={projectId}
            onJumpSearchKeyword={(kw) => {
              setSearchSeedKw(kw);
              setPage('search');
            }}
          />
        )}
        {page === 'tracker' && (
          <CreatorTracker
            projectId={projectId}
            onOpenTranscript={(cid) => {
              setActiveContentId(cid);
              setPage('transcript');
            }}
            onInspectCreatorRevenue={(handle, platform) => {
              setXrayTarget({ query: handle, platform });
              setPage('revenue');
            }}
          />
        )}
        {page === 'contents' && (
          <ContentAuthors
            projectId={projectId}
            onOpenTranscript={(cid) => {
              setActiveContentId(cid);
              setPage('transcript');
            }}
            onInspectCreatorRevenue={(handle, platform) => {
              setXrayTarget({ query: handle, platform });
              setPage('revenue');
            }}
          />
        )}
        {page === 'transcript' && (
          <TranscriptStudio
            activeContentId={activeContentId}
            onSelectContent={setActiveContentId}
            templates={templates}
          />
        )}
        {page === 'video' && <VideoStudio projectId={projectId} />}
        {page === 'publish' && <PublishHub projectId={projectId} />}
        {page === 'revenue' && (
          <RevenueRadar initialXray={xrayTarget} onOpenCalc={() => setCalcOpen(true)} />
        )}
        {page === 'directory' && <ResourceDirectory />}
      </main>

      <RevenueCalculatorDrawer open={calcOpen} onClose={() => setCalcOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} boot={boot} onSaved={loadBoot} />
    </div>
  );
}
