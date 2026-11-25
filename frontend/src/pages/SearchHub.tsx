import { useEffect, useState } from 'react';
import {
  Download,
  ExternalLink,
  FileText,
  Flame,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import { api, fmtDur, fmtNum } from '../api';
import type { KeywordItem } from '../api';

interface Props {
  projectId: number;
  lowFollowerThreshold: number;
  externalQuery?: string | null;
  onOpenTranscript: (contentId: number) => void;
}

/** 页面①：关键词搜爆款中心（SOP 22词 + YT/B站直拉 + 异常倍数计算 + 10大必看平台跳板） */
export default function SearchHub({ projectId, lowFollowerThreshold, externalQuery, onOpenTranscript }: Props) {
  const [keywords, setKeywords] = useState<KeywordItem[]>([]);
  const [selectedKw, setSelectedKw] = useState<KeywordItem | null>(null);
  const [query, setQuery] = useState('medical tourism China');
  const [newKw, setNewKw] = useState('');
  const newCat = '自定义';

  const [tab, setTab] = useState<'youtube' | 'bilibili' | 'web' | 'jump'>('youtube');
  const [ytSort, setYtSort] = useState('relevance');
  const [ytItems, setYtItems] = useState<any[]>([]);
  const [biliItems, setBiliItems] = useState<any[]>([]);
  const [webRes, setWebRes] = useState<any>(null);
  const [jumps, setJumps] = useState<any>(null);

  const [loading, setLoading] = useState(false);
  const [calcLoading, setCalcLoading] = useState<Record<string, boolean>>({});
  const [onlyLowFollower, setOnlyLowFollower] = useState(false);
  const [excludeShorts, setExcludeShorts] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 3500);
  };

  const loadKeywords = async () => {
    const list = await api.listKeywords(projectId);
    setKeywords(list);
    if (list.length > 0 && !selectedKw) {
      setSelectedKw(list[0]);
      setQuery(list[0].keyword);
    }
  };

  useEffect(() => {
    loadKeywords();
  }, [projectId]);

  useEffect(() => {
    if (externalQuery) {
      setQuery(externalQuery);
    }
  }, [externalQuery]);

  useEffect(() => {
    if (query.trim()) {
      api.jumpLinks(query.trim()).then(setJumps).catch(() => {});
    }
  }, [query]);

  const runSearch = async (targetKw?: string, kwId?: number) => {
    const q = (targetKw ?? query).trim();
    if (!q) return;
    setLoading(true);
    try {
      api.jumpLinks(q).then(setJumps).catch(() => {});
      if (tab === 'youtube') {
        const r = await api.searchYouTube(q, kwId ?? selectedKw?.id, ytSort);
        setYtItems(r.items || []);
      } else if (tab === 'bilibili') {
        const r = await api.searchBilibili(q);
        setBiliItems(r.items || []);
      } else if (tab === 'web') {
        const r = await api.searchWeb(q);
        setWebRes(r);
      }
      loadKeywords();
    } catch (e: any) {
      showToast('搜索出错：' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const calcSingleOutlier = async (idx: number, url: string) => {
    setCalcLoading((p) => ({ ...p, [url]: true }));
    try {
      const detail = await api.calcOutlier(url);
      setYtItems((prev) =>
        prev.map((it, i) => (i === idx ? { ...it, ...detail } : it))
      );
    } catch (e: any) {
      showToast('基线计算失败：' + e.message);
    } finally {
      setCalcLoading((p) => ({ ...p, [url]: false }));
    }
  };

  const batchCalcTop6 = async () => {
    const targets = ytItems.slice(0, 6);
    for (let i = 0; i < targets.length; i++) {
      if (targets[i].outlier_score === undefined) {
        await calcSingleOutlier(i, targets[i].url);
      }
    }
    showToast('已完成前 6 条视频的频道基线与异常爆款倍数计算');
  };

  const collectAndMaybeExtract = async (url: string, title: string, goExtract: boolean) => {
    try {
      const res = await api.collectLinks({
        raw_text: url,
        project_id: projectId,
        keyword_id: selectedKw?.id,
        fallback_title: title,
        collect_reason: `关键词搜索:${query}`,
      });
      const cid = res.results?.[0]?.id;
      loadKeywords();
      if (goExtract && cid) {
        onOpenTranscript(cid);
      } else {
        showToast(res.results?.[0]?.dedup ? '素材库已有该条（已更新指标）' : '✅ 已收录到素材库');
      }
    } catch (e: any) {
      showToast('收录失败：' + e.message);
    }
  };

  const addKeyword = async () => {
    if (!newKw.trim()) return;
    try {
      await api.addKeyword({ project_id: projectId, keyword: newKw.trim(), category: newCat });
      setNewKw('');
      loadKeywords();
      showToast('✅ 已添加到关键词库');
    } catch (e: any) {
      showToast(e.message);
    }
  };

  const filteredYt = ytItems.filter((it) => {
    if (excludeShorts && it.content_type === 'short_video') return false;
    if (onlyLowFollower && it.follower_count && it.follower_count > lowFollowerThreshold) return false;
    return true;
  });

  const outlierBadge = (score?: number | null) => {
    if (!score) return <span className="text-slate-600 font-mono-num">—</span>;
    if (score >= 10)
      return (
        <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 font-mono-num font-bold text-[11px]">
          🔥 {score}x
        </span>
      );
    if (score >= 5)
      return (
        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono-num font-bold text-[11px]">
          ⚡ {score}x
        </span>
      );
    if (score >= 3)
      return (
        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono-num font-bold text-[11px]">
          ✅ {score}x
        </span>
      );
    return <span className="text-slate-400 font-mono-num text-[11px]">{score}x</span>;
  };

  return (
    <div className="flex h-full gap-3 overflow-hidden">
      {/* 左侧 SOP 关键词库 */}
      <div className="w-72 shrink-0 bg-[#0b1120] border border-slate-800/90 rounded-xl flex flex-col overflow-hidden">
        <div className="p-3 border-b border-slate-800 bg-[#0f172a]">
          <div className="text-xs font-bold text-slate-200 flex items-center justify-between">
            <span>SOP 种子关键词库 ({keywords.length})</span>
          </div>
          <div className="mt-2 flex gap-1.5">
            <input
              value={newKw}
              onChange={(e) => setNewKw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
              placeholder="新增搜索词..."
              className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
            />
            <button
              onClick={addKeyword}
              className="px-2 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60">
          {keywords.map((k) => {
            const active = selectedKw?.id === k.id;
            return (
              <div
                key={k.id}
                onClick={() => {
                  setSelectedKw(k);
                  setQuery(k.keyword);
                }}
                className={`p-2.5 cursor-pointer transition group ${
                  active ? 'bg-cyan-500/15 border-l-2 border-cyan-400' : 'hover:bg-slate-900/80'
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="text-xs font-medium text-slate-200 leading-snug">{k.keyword}</div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      api.delKeyword(k.id).then(loadKeywords);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
                  <span>
                    {k.category} {k.subcategory ? `· ${k.subcategory}` : ''}
                  </span>
                  <span className="font-mono-num text-cyan-400/90">
                    收{k.content_count} / 稿{k.transcript_count}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 右侧搜索主工作区 */}
      <div className="flex-1 flex flex-col gap-3 min-w-0 overflow-hidden">
        {/* 搜索栏 + 10大必看平台常驻条 */}
        <div className="bg-[#0b1120] border border-slate-800/90 rounded-xl p-3 space-y-2.5">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder="输入英文或中文关键词，搜索全网爆款视频与文章..."
                className="w-full bg-slate-950 border border-slate-700 focus:border-cyan-500 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-100 focus:outline-none"
              />
            </div>
            <select
              value={ytSort}
              onChange={(e) => setYtSort(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-cyan-300 shrink-0"
              title="YouTube 直拉排序逻辑"
            >
              <option value="relevance">YT：综合相关</option>
              <option value="month_views">YT：本月爆款(播放↓)</option>
              <option value="week_views">YT：本周爆款(播放↓)</option>
              <option value="views">YT：历史最高播放</option>
              <option value="latest">YT：最新发布</option>
            </select>
            <button
              onClick={() => runSearch()}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs flex items-center gap-1.5 shrink-0"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              直拉当前页签
            </button>
          </div>

          {selectedKw?.verify_warning && (
            <div className="text-[11px] text-amber-300/90 flex items-center gap-2">
              <span>⚠️ SOP 核实提醒：{selectedKw.verify_warning}</span>
              {selectedKw.audience && <span className="text-slate-400">| 受众：{selectedKw.audience}</span>}
            </div>
          )}

          {/* 10大置顶必看平台一键带词直达 */}
          {jumps?.pinned_10 && (
            <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-800/70">
              <span className="text-[11px] text-slate-400 font-medium mr-1">10大必看直搜：</span>
              {jumps.pinned_10.map((p: any) => (
                <a
                  key={p.platform}
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 py-1 rounded bg-slate-900 hover:bg-cyan-500/20 border border-slate-800 hover:border-cyan-500/40 text-[11px] text-slate-200 hover:text-cyan-300 flex items-center gap-1 transition"
                >
                  <span>{p.platform}</span>
                  <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                </a>
              ))}
            </div>
          )}
        </div>

        {/* 结果页签 */}
        <div className="flex-1 bg-[#0b1120] border border-slate-800/90 rounded-xl flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between flex-wrap gap-2 bg-[#0f172a]">
            <div className="flex gap-1 text-xs">
              {[
                ['youtube', `YouTube 爆款直拉 (${filteredYt.length})`],
                ['bilibili', `B站直拉 (${biliItems.length})`],
                ['web', '全网文章直拉'],
                ['jump', '趋势与问答跳板'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTab(k as any)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition ${
                    tab === k
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'youtube' && ytItems.length > 0 && (
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={excludeShorts}
                    onChange={(e) => setExcludeShorts(e.target.checked)}
                  />
                  排除 Shorts
                </label>
                <label className="flex items-center gap-1 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={onlyLowFollower}
                    onChange={(e) => setOnlyLowFollower(e.target.checked)}
                  />
                  只看低粉 (&lt;{fmtNum(lowFollowerThreshold)})
                </label>
                <button
                  onClick={batchCalcTop6}
                  className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 flex items-center gap-1"
                >
                  <Flame className="w-3.5 h-3.5" />
                  一键算前6条爆款倍数
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {toast && (
              <div className="mb-2 px-3 py-1.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-xs">
                {toast}
              </div>
            )}

            {tab === 'youtube' && (
              filteredYt.length === 0 ? (
                <div className="h-48 flex flex-col items-center justify-center text-slate-500 text-xs gap-2">
                  <Sparkles className="w-6 h-6 text-slate-600" />
                  <span>点击上方「直拉当前页签」免 API Key 搜索 YouTube 爆款视频</span>
                </div>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="text-[11px] text-slate-400 border-b border-slate-800 sticky top-0 bg-[#0b1120]">
                    <tr>
                      <th className="py-2 pr-2">视频与原链接</th>
                      <th className="py-2 px-2">作者/频道</th>
                      <th className="py-2 px-2 text-right">播放量</th>
                      <th className="py-2 px-2 text-right">粉丝数</th>
                      <th className="py-2 px-2 text-right">异常倍数</th>
                      <th className="py-2 pl-2 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredYt.map((it, idx) => (
                      <tr key={it.platform_item_id} className="hover:bg-slate-900/60">
                        <td className="py-2 pr-2 max-w-md">
                          <div className="flex items-center gap-2.5">
                            <img
                              src={it.thumbnail_url}
                              alt=""
                              className="w-20 h-11 object-cover rounded border border-slate-800 shrink-0"
                            />
                            <div className="min-w-0">
                              <a
                                href={it.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-100 hover:text-cyan-300 font-medium line-clamp-2 leading-snug"
                              >
                                {it.title}
                              </a>
                              <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-2">
                                <span>{fmtDur(it.duration_sec)}</span>
                                <span>{it.content_type === 'short_video' ? 'Shorts推断' : '长视频'}</span>
                                {it.published_at && <span>{it.published_at}</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2 px-2 text-slate-300">
                          {it.channel_url ? (
                            <a href={it.channel_url} target="_blank" rel="noopener noreferrer" className="hover:text-cyan-300">
                              {it.creator_name}
                            </a>
                          ) : (
                            it.creator_name
                          )}
                        </td>
                        <td className="py-2 px-2 text-right font-mono-num text-cyan-300 font-medium">
                          {fmtNum(it.view_count)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono-num text-slate-300">
                          {fmtNum(it.follower_count)}
                        </td>
                        <td className="py-2 px-2 text-right">
                          {it.outlier_score !== undefined ? (
                            outlierBadge(it.outlier_score)
                          ) : (
                            <button
                              onClick={() => calcSingleOutlier(idx, it.url)}
                              disabled={calcLoading[it.url]}
                              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px]"
                            >
                              {calcLoading[it.url] ? '计算中...' : '算倍数'}
                            </button>
                          )}
                        </td>
                        <td className="py-2 pl-2 text-right whitespace-nowrap space-x-1">
                          <button
                            onClick={() => collectAndMaybeExtract(it.url, it.title, false)}
                            className="px-2 py-1 rounded bg-slate-800 hover:bg-cyan-600 text-slate-200 text-[11px]"
                            title="收录到素材库"
                          >
                            <Download className="w-3 h-3 inline mr-0.5" />收
                          </button>
                          <button
                            onClick={() => collectAndMaybeExtract(it.url, it.title, true)}
                            className="px-2 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 text-[11px]"
                          >
                            <FileText className="w-3 h-3 inline mr-0.5" />提文案
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {tab === 'bilibili' && (
              biliItems.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-slate-500 text-xs">
                  输入中文关键词后点击「直拉当前页签」搜索 B 站视频
                </div>
              ) : (
                <div className="space-y-2">
                  {biliItems.map((it) => (
                    <div
                      key={it.platform_item_id}
                      className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-slate-900/70 border border-slate-800"
                    >
                      <div className="min-w-0">
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-slate-100 hover:text-cyan-300 line-clamp-1"
                        >
                          {it.title}
                        </a>
                        <div className="text-[11px] text-slate-400 mt-1 font-mono-num">
                          UP主：{it.creator_name} · 播放 {fmtNum(it.view_count)} · 点赞 {fmtNum(it.like_count)} · 评论 {fmtNum(it.comment_count)}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button
                          onClick={() => collectAndMaybeExtract(it.url, it.title, false)}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-cyan-600 text-xs text-slate-200"
                        >
                          收录
                        </button>
                        <button
                          onClick={() => collectAndMaybeExtract(it.url, it.title, true)}
                          className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600 text-xs text-emerald-300 hover:text-white border border-emerald-500/40"
                        >
                          提文案
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}

            {tab === 'web' && (
              <div className="space-y-2.5">
                {webRes?.message && (
                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-300">
                    {webRes.message}
                  </div>
                )}
                {(webRes?.results || []).map((w: any) => (
                  <div key={w.url} className="p-3 rounded-lg bg-slate-900/70 border border-slate-800 flex justify-between gap-3">
                    <div className="min-w-0">
                      <a href={w.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-cyan-300 hover:underline">
                        {w.title}
                      </a>
                      <div className="text-[11px] text-slate-400 mt-1">{w.snippet}</div>
                      <div className="text-[10px] text-slate-500 mt-1">{w.domain}</div>
                    </div>
                    <button
                      onClick={() => collectAndMaybeExtract(w.url, w.title, true)}
                      className="px-3 py-1 h-fit rounded bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 text-xs shrink-0"
                    >
                      提取正文
                    </button>
                  </div>
                ))}
              </div>
            )}

            {tab === 'jump' && jumps?.trends_and_web && (
              <div className="grid grid-cols-3 gap-2.5">
                {jumps.trends_and_web.map((t: any) => (
                  <a
                    key={t.platform}
                    href={t.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-3 rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-slate-800 hover:border-cyan-500/40 transition flex items-center justify-between"
                  >
                    <div>
                      <div className="text-xs font-semibold text-slate-100">{t.platform}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">{t.badge}</div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-cyan-400" />
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
