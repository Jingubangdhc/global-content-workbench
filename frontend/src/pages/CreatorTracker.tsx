import { useEffect, useState } from 'react';
import {
  DollarSign,
  ExternalLink,
  FileText,
  Flame,
  Loader2,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { api, fmtDur, fmtNum } from '../api';
import type { ContentItem, CreatorItem } from '../api';

interface Props {
  projectId: number;
  onOpenTranscript: (contentId: number) => void;
  onInspectCreatorRevenue: (handle: string, platform: string) => void;
}

/** 独立「爆款博主追踪」页：粘贴博主主页链接 -> 自动收录并拉取视频 -> 页内直接看作品、算异常倍数、一键提文案 */
export default function CreatorTracker({ projectId, onOpenTranscript, onInspectCreatorRevenue }: Props) {
  const [creators, setCreators] = useState<CreatorItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [activeCreator, setActiveCreator] = useState<CreatorItem | null>(null);
  const [videos, setVideos] = useState<ContentItem[]>([]);

  const [profileUrl, setProfileUrl] = useState('');
  const [note, setNote] = useState('');
  const [fetchLimit, setFetchLimit] = useState(15);
  const [tracking, setTracking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState('');

  const loadCreators = async (preferId?: number) => {
    const list = await api.listCreators('all');
    setCreators(list);
    const target = preferId ?? selectedId ?? (list[0]?.id || null);
    if (target) {
      setSelectedId(target);
      loadCreatorVideos(target);
    } else {
      setActiveCreator(null);
      setVideos([]);
    }
  };

  const loadCreatorVideos = async (crId: number) => {
    try {
      const res = await api.creatorVideos(crId);
      setActiveCreator(res.creator);
      setVideos(res.videos || []);
    } catch {
      setActiveCreator(null);
      setVideos([]);
    }
  };

  useEffect(() => {
    loadCreators();
  }, []);

  const handleTrack = async () => {
    if (!profileUrl.trim()) return;
    setTracking(true);
    setMsg('⏳ 正在解析博主主页并拉取近期视频（同时自动计算频道基线与异常倍数）...');
    try {
      const r = await api.trackCreator({
        profile_url: profileUrl.trim(),
        project_id: projectId,
        limit: fetchLimit,
        strengths_note: note.trim(),
      });
      setProfileUrl('');
      setNote('');
      setMsg(
        r.warning
          ? `⚠️ 已收录博主【${r.creator_name}】：${r.warning}`
          : `✅ 已收录博主【${r.creator_name}】，拉取 ${r.total_fetched} 条视频（新增 ${r.added_videos} 条）`
      );
      await loadCreators(r.creator_id);
    } catch (e: any) {
      setMsg('❌ 收录失败：' + e.message);
    } finally {
      setTracking(false);
    }
  };

  const handleRefresh = async (crId: number) => {
    setRefreshing(true);
    setMsg('⏳ 正在刷新该博主最新作品...');
    try {
      const r = await api.refreshCreator(crId, fetchLimit);
      setMsg(
        r.warning
          ? `⚠️ ${r.warning}`
          : `✅ 刷新完成：拉取 ${r.total_fetched} 条（新增 ${r.added_videos} 条）`
      );
      await loadCreators(crId);
    } catch (e: any) {
      setMsg('❌ 刷新失败：' + e.message);
    } finally {
      setRefreshing(false);
    }
  };

  const outlierBadge = (score?: number | null) => {
    if (!score) return <span className="text-slate-600 font-mono-num">—</span>;
    if (score >= 10)
      return <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 font-mono-num font-bold gcw-text-tag">🔥 {score}x</span>;
    if (score >= 5)
      return <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono-num font-bold gcw-text-tag">⚡ {score}x</span>;
    if (score >= 3)
      return <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono-num font-bold gcw-text-tag">✅ {score}x</span>;
    return <span className="text-slate-400 font-mono-num gcw-text-tag">{score}x</span>;
  };

  const parseTags = (jsonStr?: string): string[] => {
    try {
      return JSON.parse(jsonStr || '{}').tags || [];
    } catch {
      return [];
    }
  };

  return (
    <div className="flex flex-col h-full gap-3 overflow-hidden">
      {/* 顶部：添加爆款博主主页链接 */}
      <div className="bg-[#0b1120] border border-slate-800/90 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-bold text-cyan-300">
            <UserPlus className="w-4 h-4" />
            <span>爆款博主追踪（贴主页链接直接收录并查看他的近期作品与异常爆款倍数）</span>
          </div>
          <div className="gcw-text-tag text-slate-400">
            YouTube 主页（/@handle 或 /channel/...）支持全自动直拉作品
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <input
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleTrack()}
            placeholder="粘贴博主主页链接，如 https://www.youtube.com/@mkbhd 或 B站/抖音/TikTok 主页..."
            className="flex-1 min-w-[260px] bg-slate-950 border border-slate-700 focus:border-cyan-500 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="追踪备注（赛道/亮点，选填）"
            className="w-44 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
          />
          <select
            value={fetchLimit}
            onChange={(e) => setFetchLimit(Number(e.target.value))}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
          >
            <option value={5}>近 5 条</option>
            <option value={15}>近 15 条</option>
            <option value={30}>近 30 条</option>
          </select>
          <button
            onClick={handleTrack}
            disabled={tracking}
            className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1.5 shrink-0"
          >
            {tracking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            收录并拉取视频
          </button>
        </div>
        {msg && <div className="text-xs text-amber-300">{msg}</div>}
      </div>

      {/* 下方双栏：左侧已追踪博主列表 + 右侧该博主的视频列表 */}
      <div className="flex-1 flex gap-3 min-h-0 overflow-hidden">
        {/* 左侧博主清单 */}
        <div className="w-72 shrink-0 bg-[#0b1120] border border-slate-800/90 rounded-xl flex flex-col overflow-hidden">
          <div className="px-3 py-2.5 border-b border-slate-800 bg-[#0f172a] text-xs font-bold text-slate-200">
            已追踪博主 ({creators.length})
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60">
            {creators.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                暂无追踪博主，在上方粘贴任意 YouTube 频道链接试试。
              </div>
            ) : (
              creators.map((cr) => {
                const active = selectedId === cr.id;
                return (
                  <div
                    key={cr.id}
                    onClick={() => {
                      setSelectedId(cr.id);
                      loadCreatorVideos(cr.id);
                    }}
                    className={`p-3 cursor-pointer transition group ${
                      active ? 'bg-cyan-500/15 border-l-2 border-cyan-400' : 'hover:bg-slate-900/70'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-slate-100 truncate">{cr.name}</span>
                          <span className="px-1 py-0.5 rounded bg-slate-800 text-[9px] uppercase text-slate-400">
                            {cr.platform}
                          </span>
                        </div>
                        <div className="gcw-text-tag text-slate-400 font-mono-num mt-1">
                          中位数 {fmtNum(cr.baseline_median_views)} · {cr.video_count} 条
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {cr.max_outlier && cr.max_outlier >= 3 ? (
                          <span className="gcw-text-meta font-mono-num text-amber-300">
                            <Flame className="w-3 h-3 inline" />{cr.max_outlier}x
                          </span>
                        ) : null}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            api.patchCreator(cr.id, { is_starred: cr.is_starred ? 0 : 1 }).then(() => loadCreators(selectedId || undefined));
                          }}
                          className={cr.is_starred ? 'text-amber-400' : 'text-slate-600 hover:text-amber-300'}
                        >
                          <Star className="w-3.5 h-3.5 fill-current" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 右侧：选中博主的档案与作品墙 */}
        <div className="flex-1 bg-[#0b1120] border border-slate-800/90 rounded-xl flex flex-col overflow-hidden min-w-0">
          {!activeCreator ? (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-500">
              从左侧选择一位博主查看他的全部视频与爆款表现
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-slate-100">{activeCreator.name}</h2>
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 gcw-text-meta uppercase text-cyan-300 font-mono-num">
                      {activeCreator.platform}
                    </span>
                    {parseTags(activeCreator.detected_monetization_json).map((t) => (
                      <span key={t} className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 gcw-text-meta">
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className="gcw-text-tag text-slate-400 font-mono-num mt-1">
                    粉丝 {fmtNum(activeCreator.follower_count)} · 频道近期播放中位数 {fmtNum(activeCreator.baseline_median_views)} · 已拉取 {videos.length} 条作品
                    {activeCreator.strengths_note ? ` · 备注：${activeCreator.strengths_note}` : ''}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <button
                    onClick={() => handleRefresh(activeCreator.id)}
                    disabled={refreshing}
                    className="px-2.5 py-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-cyan-500/40 flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                    刷新最新视频
                  </button>
                  <button
                    onClick={() => onInspectCreatorRevenue(activeCreator.handle || activeCreator.name, activeCreator.platform)}
                    className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 flex items-center gap-1"
                  >
                    <DollarSign className="w-3.5 h-3.5" />
                    查背后收益
                  </button>
                  {activeCreator.profile_url && (
                    <a
                      href={activeCreator.profile_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1"
                    >
                      原主页 <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  <button
                    onClick={() => api.delCreator(activeCreator.id).then(() => loadCreators())}
                    className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-800"
                    title="移除博主"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3">
                {videos.length === 0 ? (
                  <div className="h-44 flex items-center justify-center text-xs text-slate-500">
                    暂未拉取到该博主的视频列表（可点击右上角「刷新最新视频」，或在「素材与作者库」手动粘贴他的视频链接）。
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="gcw-text-tag text-slate-400 border-b border-slate-800 sticky top-0 bg-[#0b1120]">
                      <tr>
                        <th className="py-2 pr-2">视频（点击直接看原视频）</th>
                        <th className="py-2 px-2 text-right">时长</th>
                        <th className="py-2 px-2 text-right">播放量</th>
                        <th className="py-2 px-2 text-right">相对基线倍数</th>
                        <th className="py-2 pl-2 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {videos.map((v) => (
                        <tr key={v.id} className="hover:bg-slate-900/60">
                          <td className="py-2 pr-2 max-w-lg">
                            <div className="flex items-center gap-2.5">
                              {v.thumbnail_url ? (
                                <img src={v.thumbnail_url} alt="" className="w-20 h-11 object-cover rounded border border-slate-800 shrink-0" />
                              ) : null}
                              <a
                                href={v.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-100 hover:text-cyan-300 font-medium line-clamp-2 leading-snug"
                              >
                                {v.title} <ExternalLink className="w-3 h-3 inline opacity-50" />
                              </a>
                            </div>
                          </td>
                          <td className="py-2 px-2 text-right font-mono-num text-slate-400">{fmtDur(v.duration_sec)}</td>
                          <td className="py-2 px-2 text-right font-mono-num text-cyan-300 font-semibold">{fmtNum(v.view_count)}</td>
                          <td className="py-2 px-2 text-right">{outlierBadge(v.outlier_score)}</td>
                          <td className="py-2 pl-2 text-right whitespace-nowrap">
                            <button
                              onClick={() => onOpenTranscript(v.id)}
                              className={`px-2.5 py-1 rounded gcw-text-tag border ${
                                v.has_transcript
                                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                  : 'bg-cyan-600/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-600 hover:text-white'
                              }`}
                            >
                              <FileText className="w-3 h-3 inline mr-0.5" />
                              {v.has_transcript ? '看文案' : '提文案'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
