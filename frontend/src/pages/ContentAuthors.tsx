import { useEffect, useState } from 'react';
import {
  DollarSign,
  Download,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  Star,
  Trash2,
  Upload,
  User,
} from 'lucide-react';
import { api, fmtNum } from '../api';
import type { ContentItem, CreatorItem } from '../api';

interface Props {
  projectId: number;
  onOpenTranscript: (contentId: number) => void;
  onInspectCreatorRevenue: (handle: string, platform: string) => void;
}

/** 页面②：万能链接收集箱、带货 CSV 导入、作品库与作者库（含 0-Token 变现指纹） */
export default function ContentAuthors({ projectId, onOpenTranscript, onInspectCreatorRevenue }: Props) {
  const [mode, setMode] = useState<'contents' | 'creators'>('contents');
  const [contents, setContents] = useState<ContentItem[]>([]);
  const [creators, setCreators] = useState<CreatorItem[]>([]);

  const [rawInput, setRawInput] = useState('');
  const [reason, setReason] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [filterPlat, setFilterPlat] = useState('all');
  const [searchQ, setSearchQ] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    const [cs, crs] = await Promise.all([
      api.listContents({ project_id: projectId, platform: filterPlat, q: searchQ }),
      api.listCreators(filterPlat),
    ]);
    setContents(cs);
    setCreators(crs);
  };

  useEffect(() => {
    load();
  }, [projectId, filterPlat, searchQ]);

  const handleCollect = async () => {
    if (!rawInput.trim()) return;
    setCollecting(true);
    setMsg('');
    try {
      const r = await api.collectLinks({
        raw_text: rawInput,
        project_id: projectId,
        collect_reason: reason,
      });
      setRawInput('');
      setReason('');
      const warns = (r.results || []).filter((x: any) => x.warning).map((x: any) => x.warning);
      setMsg(`✅ 已处理 ${r.count} 条链接${warns.length ? `（提示：${warns[0]}）` : ''}`);
      load();
    } catch (e: any) {
      setMsg('❌ ' + e.message);
    } finally {
      setCollecting(false);
    }
  };

  const handleCsv = async (file?: File) => {
    if (!file) return;
    setCollecting(true);
    try {
      const r = await api.importCsv(file, projectId);
      setMsg(`✅ 成功从 CSV 导入 ${r.imported} 条带货/达人视频`);
      load();
    } catch (e: any) {
      setMsg('❌ CSV 导入失败：' + e.message);
    } finally {
      setCollecting(false);
    }
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
      {/* 顶部万能链接收集栏 */}
      <div className="bg-[#0b1120] border border-slate-800/90 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-cyan-300">
            <Link2 className="w-4 h-4" />
            <span>万能收录框（支持任意平台链接、多行批量粘贴、或直接粘贴抖音/小红书分享口令文本）</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 gcw-text-tag text-slate-200 cursor-pointer flex items-center gap-1 border border-slate-700">
              <Upload className="w-3 h-3" />
              导入带货 CSV
              <input type="file" accept=".csv" className="hidden" onChange={(e) => handleCsv(e.target.files?.[0])} />
            </label>
            <a
              href="/api/export/sop-excel"
              className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 gcw-text-tag text-emerald-300 border border-emerald-500/40 flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              导出 SOP Excel
            </a>
          </div>
        </div>

        <div className="flex gap-2">
          <textarea
            rows={2}
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            placeholder="粘贴 YouTube / TikTok / 抖音 / 小红书 / B站 / Reddit / 文章链接（可一次粘贴多条）..."
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
          />
          <div className="w-52 flex flex-col gap-1.5">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="一句收藏理由（选填）"
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200"
            />
            <button
              onClick={handleCollect}
              disabled={collecting}
              className="flex-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs flex items-center justify-center gap-1.5"
            >
              {collecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              解析并入库
            </button>
          </div>
        </div>
        {msg && <div className="text-xs text-emerald-400">{msg}</div>}
      </div>

      {/* 主列表区 */}
      <div className="flex-1 bg-[#0b1120] border border-slate-800/90 rounded-xl flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between flex-wrap gap-2">
          <div className="flex gap-1 text-xs">
            <button
              onClick={() => setMode('contents')}
              className={`px-3 py-1.5 rounded-lg font-medium ${
                mode === 'contents'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              🎬 作品素材库 ({contents.length})
            </button>
            <button
              onClick={() => setMode('creators')}
              className={`px-3 py-1.5 rounded-lg font-medium ${
                mode === 'creators'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              👤 作者对标库 ({creators.length})
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <select
              value={filterPlat}
              onChange={(e) => setFilterPlat(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
            >
              <option value="all">全部平台</option>
              <option value="youtube">YouTube</option>
              <option value="tiktok">TikTok</option>
              <option value="douyin">抖音</option>
              <option value="xiaohongshu">小红书</option>
              <option value="bilibili">B站</option>
              <option value="reddit">Reddit</option>
              <option value="web">网页文章</option>
            </select>
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="搜标题/作者/理由..."
              className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1 text-slate-200 w-44"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {mode === 'contents' ? (
            contents.length === 0 ? (
              <div className="h-44 flex items-center justify-center text-xs text-slate-500">
                暂无收录内容。可在「关键词搜爆款」一键收录，或在上方粘贴任意平台链接。
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead className="gcw-text-tag text-slate-400 border-b border-slate-800 sticky top-0 bg-[#0b1120]">
                  <tr>
                    <th className="py-2 pr-2">平台 / 标题（点开看原视频）</th>
                    <th className="py-2 px-2">作者与变现指纹</th>
                    <th className="py-2 px-2 text-right">播放 / 倍数</th>
                    <th className="py-2 px-2">状态</th>
                    <th className="py-2 pl-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {contents.map((c) => {
                    const tags = parseTags(c.detected_links_json);
                    return (
                      <tr key={c.id} className="hover:bg-slate-900/60">
                        <td className="py-2.5 pr-2 max-w-md">
                          <div className="flex items-start gap-2">
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 gcw-text-meta uppercase font-mono-num text-cyan-300 shrink-0">
                              {c.platform}
                            </span>
                            <div className="min-w-0">
                              <a
                                href={c.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-100 hover:text-cyan-300 font-medium line-clamp-2"
                              >
                                {c.title} <ExternalLink className="w-3 h-3 inline opacity-50" />
                              </a>
                              {c.collect_reason && (
                                <div className="gcw-text-meta text-slate-400 mt-0.5">理由：{c.collect_reason}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-2">
                          <div className="text-slate-200">{c.creator_name || '—'}</div>
                          {tags.length > 0 && (
                            <div className="flex gap-1 flex-wrap mt-1">
                              {tags.map((t) => (
                                <span
                                  key={t}
                                  className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 gcw-text-meta"
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono-num">
                          <div className="text-cyan-300">{fmtNum(c.view_count)}</div>
                          <div className="gcw-text-meta text-amber-300">
                            {c.outlier_score ? `${c.outlier_score}x` : '—'}
                          </div>
                        </td>
                        <td className="py-2.5 px-2">
                          <select
                            value={c.status}
                            onChange={(e) => api.patchContent(c.id, { status: e.target.value }).then(load)}
                            className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 gcw-text-tag text-slate-200"
                          >
                            <option value="inbox">📥 收件箱</option>
                            <option value="useful">⭐ 有用</option>
                            <option value="extracted">📝 已提文案</option>
                            <option value="used">🎬 已用于选题</option>
                            <option value="archived">归档</option>
                          </select>
                        </td>
                        <td className="py-2.5 pl-2 text-right whitespace-nowrap space-x-1">
                          <button
                            onClick={() => onOpenTranscript(c.id)}
                            className={`px-2 py-1 rounded gcw-text-tag border ${
                              c.has_transcript
                                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                : 'bg-cyan-600/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-600 hover:text-white'
                            }`}
                          >
                            <FileText className="w-3 h-3 inline mr-0.5" />
                            {c.has_transcript ? '看文案' : '提文案'}
                          </button>
                          <button
                            onClick={() => api.delContent(c.id).then(load)}
                            className="p-1 text-slate-500 hover:text-rose-400"
                          >
                            <Trash2 className="w-3.5 h-3.5 inline" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {creators.map((cr) => {
                const tags = parseTags(cr.detected_monetization_json);
                return (
                  <div key={cr.id} className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <User className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                          <a
                            href={cr.profile_url || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-sm text-slate-100 hover:text-cyan-300 truncate"
                          >
                            {cr.name}
                          </a>
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 gcw-text-meta uppercase text-slate-400">
                            {cr.platform}
                          </span>
                        </div>
                        <div className="gcw-text-tag text-slate-400 font-mono-num mt-1">
                          粉丝 {fmtNum(cr.follower_count)} · 基线中位数 {fmtNum(cr.baseline_median_views)} · 已收 {cr.video_count} 条
                        </div>
                      </div>
                      <button
                        onClick={() => api.patchCreator(cr.id, { is_starred: cr.is_starred ? 0 : 1 }).then(load)}
                        className={cr.is_starred ? 'text-amber-400' : 'text-slate-600 hover:text-amber-300'}
                      >
                        <Star className="w-4 h-4 fill-current" />
                      </button>
                    </div>

                    {tags.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {tags.map((t) => (
                          <span
                            key={t}
                            className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 gcw-text-meta"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => onInspectCreatorRevenue(cr.handle || cr.name, cr.platform)}
                        className="flex-1 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-medium flex items-center justify-center gap-1"
                      >
                        <DollarSign className="w-3.5 h-3.5" />
                        透视背后收益
                      </button>
                      {cr.profile_url && (
                        <a
                          href={cr.profile_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1"
                        >
                          主页 <ExternalLink className="w-3 h-3" />
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
    </div>
  );
}
