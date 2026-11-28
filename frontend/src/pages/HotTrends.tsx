import { useEffect, useState } from 'react';
import { Download, ExternalLink, Flame, Loader2, RefreshCw, Search } from 'lucide-react';
import { api } from '../api';

interface Props {
  projectId: number;
  onJumpSearchKeyword: (kw: string) => void;
}

/** 阶段 A 新增：全网实时热榜雷达（参考 TrendRadar / DailyHotApi，零 Key 聚合海内外 8 大平台热榜） */
export default function HotTrends({ projectId, onJumpSearchKeyword }: Props) {
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [region, setRegion] = useState<'all' | '国内' | '海外'>('all');
  const [highlightQ, setHighlightQ] = useState('');
  const [toast, setToast] = useState('');

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 3000);
  };

  const load = async (force = false) => {
    setLoading(true);
    try {
      const r = await api.hotTrends(force);
      setSources(r.sources || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(false);
  }, []);

  const collectHot = async (title: string, url: string, sourceName: string) => {
    try {
      await api.collectLinks({
        raw_text: url,
        project_id: projectId,
        fallback_title: title,
        collect_reason: `热榜收录:${sourceName}`,
      });
      showToast(`✅ 已收录到素材库：${title.slice(0, 24)}`);
    } catch (e: any) {
      showToast('❌ 收录失败：' + e.message);
    }
  };

  const kwTokens = highlightQ
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const isMatched = (title: string) => {
    if (kwTokens.length === 0) return false;
    const low = title.toLowerCase();
    return kwTokens.some((k) => low.includes(k));
  };

  const visibleSources = sources.filter((s) => region === 'all' || s.region === region);

  return (
    <div className="flex flex-col h-full gap-3 overflow-hidden">
      <div className="bg-[#0b1120] border border-slate-800/90 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-rose-400" />
          <span className="text-sm font-bold text-slate-100">全网实时热榜雷达</span>
          <div className="flex gap-1 bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-xs ml-2">
            {(['all', '国内', '海外'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRegion(r)}
                className={`px-2.5 py-1 rounded ${
                  region === r ? 'bg-cyan-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {r === 'all' ? '全部平台' : r}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <input
            value={highlightQ}
            onChange={(e) => setHighlightQ(e.target.value)}
            placeholder="高亮关注词（空格分隔，如 医疗 AI 出海）"
            className="w-64 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-500"
          />
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium flex items-center gap-1"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            强制刷新
          </button>
        </div>
      </div>

      {toast && (
        <div className="px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs">
          {toast}
        </div>
      )}

      <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 pr-1">
        {visibleSources.map((src) => (
          <div
            key={src.key}
            className="bg-[#0b1120] border border-slate-800/90 rounded-xl flex flex-col overflow-hidden h-[520px]"
          >
            <div className="px-3 py-2.5 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-slate-100">{src.name}</span>
                <span className="px-1.5 py-0.5 rounded bg-slate-800 gcw-text-meta text-slate-400">{src.region}</span>
              </div>
              <span className={`gcw-text-meta font-mono-num ${src.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                {src.ok ? `${src.count} 条` : '暂受限'}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50 p-1.5">
              {!src.ok ? (
                <div className="p-4 gcw-text-tag text-slate-500 text-center">
                  当前网络访问受限：{src.error}
                </div>
              ) : (
                src.items.map((it: any) => {
                  const hit = isMatched(it.title);
                  return (
                    <div
                      key={`${src.key}-${it.rank}`}
                      className={`p-2 rounded-lg transition group ${
                        hit ? 'bg-amber-500/15 border border-amber-500/40' : 'hover:bg-slate-900/70'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={`font-mono-num gcw-text-tag font-bold w-4 shrink-0 ${
                            it.rank <= 3 ? 'text-rose-400' : 'text-slate-500'
                          }`}
                        >
                          {it.rank}
                        </span>
                        <div className="min-w-0 flex-1">
                          <a
                            href={it.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-slate-200 hover:text-cyan-300 leading-snug line-clamp-2"
                          >
                            {it.title} <ExternalLink className="w-2.5 h-2.5 inline opacity-40" />
                          </a>
                          <div className="flex items-center justify-between mt-1">
                            <span className="gcw-text-meta text-slate-500 font-mono-num truncate">
                              {it.hot} {it.extra ? `· ${it.extra}` : ''}
                            </span>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
                              <button
                                onClick={() => onJumpSearchKeyword(it.title)}
                                className="px-1.5 py-0.5 rounded bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white gcw-text-meta"
                                title="带词去搜全网爆款"
                              >
                                <Search className="w-2.5 h-2.5 inline" />搜
                              </button>
                              <button
                                onClick={() => collectHot(it.title, it.url, src.name)}
                                className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-emerald-600 text-slate-300 hover:text-white gcw-text-meta"
                                title="收录到素材库"
                              >
                                <Download className="w-2.5 h-2.5 inline" />收
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
