import { useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  CreditCard,
  ExternalLink,
  Plus,
  Radar,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { RevenueEvidence, ToolRecord } from '../api';
import PaidDecisionModal from '../components/PaidDecisionModal';

interface Props {
  initialXray?: { query: string; platform: string } | null;
  onOpenCalc: () => void;
}

const CATEGORIES = [
  '全部变现模式',
  '流量分成/RPM',
  '短视频带货',
  '直播带货',
  '直播打赏',
  '独立站销售',
  '商业商单',
  '知识付费/订阅',
  '广告及投放',
  '电商综合研究',
  '联盟营销',
  '私信获客',
  '财务结算',
];

/** 页面④：赛道收益雷达（11大变现寻址矩阵 + 免费直通/付费决策卡 + 作者一键透视 + 收益证据本） */
export default function RevenueRadar({ initialXray, onOpenCalc }: Props) {
  const [viewMode, setViewMode] = useState<'external' | 'own'>('external');
  const [items, setItems] = useState<ToolRecord[]>([]);
  const [selectedCat, setSelectedCat] = useState('全部变现模式');
  const [feeFilter, setFeeFilter] = useState('all');
  const [decisionTool, setDecisionTool] = useState<ToolRecord | null>(null);

  // 作者/独立站一键透视
  const [xrayQuery, setXrayQuery] = useState(initialXray?.query || '');
  const [xrayPlat, setXrayPlat] = useState(initialXray?.platform || 'youtube');
  const [xrayRes, setXrayRes] = useState<any>(null);

  // 赛道收益证据本
  const [evidence, setEvidence] = useState<RevenueEvidence[]>([]);
  const [showAddEv, setShowAddEv] = useState(false);
  const [evForm, setEvForm] = useState({
    niche: '跨境医疗',
    monetization_type: '流量分成/RPM',
    platform: 'YouTube',
    content_format: '长视频',
    audience_region: 'US',
    metric_name: 'RPM',
    amount_min: '',
    amount_max: '',
    currency: 'USD',
    evidence_level: 'L2_SELF_REPORTED',
    source_url: '',
    note: '',
  });

  const loadMatrix = async () => {
    const r = await api.revenueMatrix(viewMode);
    setItems(r.items || []);
  };

  const loadEvidence = async () => {
    setEvidence(await api.listEvidence());
  };

  useEffect(() => {
    loadMatrix();
  }, [viewMode]);

  useEffect(() => {
    loadEvidence();
  }, []);

  useEffect(() => {
    if (initialXray?.query) {
      setXrayQuery(initialXray.query);
      setXrayPlat(initialXray.platform || 'youtube');
      api.authorXray(initialXray.query, initialXray.platform || 'youtube').then(setXrayRes);
    }
  }, [initialXray]);

  const runXray = async () => {
    if (!xrayQuery.trim()) return;
    setXrayRes(await api.authorXray(xrayQuery.trim(), xrayPlat));
  };

  const submitEv = async () => {
    if (!evForm.niche.trim()) return;
    await api.addEvidence({
      ...evForm,
      amount_min: evForm.amount_min ? parseFloat(evForm.amount_min) : null,
      amount_max: evForm.amount_max ? parseFloat(evForm.amount_max) : null,
    });
    setShowAddEv(false);
    setEvForm({ ...evForm, amount_min: '', amount_max: '', source_url: '', note: '' });
    loadEvidence();
  };

  const catCounts = useMemo(() => {
    const m: Record<string, number> = { 全部变现模式: items.length };
    items.forEach((it) => {
      m[it.category] = (m[it.category] || 0) + 1;
    });
    return m;
  }, [items]);

  const visibleItems = useMemo(() => {
    return items.filter((it) => {
      if (selectedCat !== '全部变现模式' && it.category !== selectedCat) return false;
      if (feeFilter !== 'all' && it.fee_tier !== feeFilter) return false;
      return true;
    });
  }, [items, selectedCat, feeFilter]);

  const tierBadge = (tier: string, myStatus: string) => {
    if (myStatus === 'paid_active')
      return (
        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 gcw-text-meta font-semibold">
          💳 已付费
        </span>
      );
    if (tier === 'free')
      return (
        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 gcw-text-meta">
          🟢 免费直看
        </span>
      );
    if (tier === 'freemium')
      return (
        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 gcw-text-meta">
          🟡 限免/需资格
        </span>
      );
    return (
      <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 gcw-text-meta">
        🔴 付费决策
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full gap-3 overflow-y-auto pr-1">
      {/* 顶部控制栏：视角切换（默认查同行，折叠自有后台）+ 作者一键透视 */}
      <div className="bg-[#0b1120] border border-slate-800/90 rounded-xl p-3 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <button
              onClick={() => {
                setViewMode('external');
                setSelectedCat('全部变现模式');
              }}
              className={`px-3 py-1.5 rounded-md font-semibold transition ${
                viewMode === 'external'
                  ? 'bg-cyan-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              🔭 查同行 / 看赛道收益（默认）
            </button>
            <button
              onClick={() => {
                setViewMode('own');
                setSelectedCat('全部变现模式');
              }}
              className={`px-3 py-1.5 rounded-md font-semibold transition ${
                viewMode === 'own'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              🔐 我的账号与结算后台（已折叠自有入口）
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <select
              value={feeFilter}
              onChange={(e) => setFeeFilter(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
            >
              <option value="all">全部费用类型</option>
              <option value="free">🟢 只看免费直看</option>
              <option value="freemium">🟡 限免/需资格</option>
              <option value="paid">🔴 付费为主</option>
            </select>
            <button
              onClick={onOpenCalc}
              className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-medium flex items-center gap-1.5"
            >
              <Calculator className="w-3.5 h-3.5" />
              打开收益反推计算器
            </button>
          </div>
        </div>

        {/* 作者 Handle 或独立站域名一键透视栏 */}
        <div className="flex items-center gap-2 pt-2 border-t border-slate-800/70 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs text-cyan-300 font-semibold shrink-0">
            <Radar className="w-4 h-4" />
            <span>作者/独立站一键透视：</span>
          </div>
          <select
            value={xrayPlat}
            onChange={(e) => setXrayPlat(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="youtube">YouTube</option>
            <option value="tiktok">TikTok</option>
            <option value="douyin">抖音</option>
            <option value="xiaohongshu">小红书</option>
            <option value="bilibili">B站</option>
          </select>
          <input
            value={xrayQuery}
            onChange={(e) => setXrayQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runXray()}
            placeholder="输入作者 @handle 或独立站域名（如 shopify.com / mkbhd）..."
            className="flex-1 min-w-[220px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
          />
          <button
            onClick={runXray}
            className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1"
          >
            <Search className="w-3.5 h-3.5" />
            生成侦察入口
          </button>
        </div>

        {xrayRes?.links && (
          <div className="flex items-center gap-2 flex-wrap bg-slate-950/90 border border-slate-800 rounded-lg p-2.5">
            <span className="gcw-text-tag text-slate-400">
              针对 <strong className="text-cyan-300">{xrayRes.query}</strong> 的一键侦察：
            </span>
            {xrayRes.links.map((l: any) => (
              <a
                key={l.name}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`px-2.5 py-1 rounded text-xs flex items-center gap-1 border transition ${
                  l.tier === 'paid'
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20'
                    : l.tier === 'free'
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20'
                }`}
              >
                <span>{l.name}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            ))}
          </div>
        )}
      </div>

      {/* 主体：左侧 11 大变现赛道导航 + 右侧卡片网格 */}
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 lg:col-span-3 bg-[#0b1120] border border-slate-800/90 rounded-xl p-2 space-y-1 h-fit">
          <div className="px-2 py-1.5 gcw-text-tag font-bold text-slate-400 uppercase tracking-wider">
            按变现赛道快速切换
          </div>
          {CATEGORIES.map((cat) => {
            const cnt = catCounts[cat] || 0;
            if (cat !== '全部变现模式' && cnt === 0 && viewMode === 'own') return null;
            const active = selectedCat === cat;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCat(cat)}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs transition ${
                  active
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                    : 'text-slate-300 hover:bg-slate-900'
                }`}
              >
                <span>{cat}</span>
                <span className="font-mono-num gcw-text-tag px-1.5 rounded bg-slate-900 text-slate-400">
                  {cnt}
                </span>
              </button>
            );
          })}
          {viewMode === 'external' && (
            <div className="mt-2 p-2.5 rounded-lg bg-slate-950 border border-slate-800 gcw-text-tag text-slate-400 leading-relaxed">
              💡 <strong className="text-slate-200">联盟营销 & 私信获客</strong>没有外部竞品查询站：在「素材与作者库」收录视频时，系统会自动用正则扫描简介里的 Amazon 短链、折扣码、独立站与 WhatsApp/微信线索。
            </div>
          )}
        </div>

        <div className="col-span-12 lg:col-span-9 space-y-3">
          {visibleItems.length === 0 ? (
            <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-8 text-center text-xs text-slate-400">
              当前筛选条件下无外部公开工具（该变现模式可能仅支持查看自有后台，可切换顶部「我的账号与结算后台」或使用作者简介指纹扫描）。
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {visibleItems.map((it, idx) => {
                const isPaid = it.fee_tier === 'paid' && it.my_status !== 'paid_active';
                return (
                  <div
                    key={`${it.tool_id}-${it.category}-${it.target_platform}-${idx}`}
                    className="bg-[#0b1120] border border-slate-800/90 hover:border-cyan-500/40 rounded-xl p-3 flex flex-col justify-between gap-2 transition"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-start justify-between gap-1.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-sm text-slate-100 truncate">{it.name}</span>
                            {it.is_pinned ? <Star className="w-3.5 h-3.5 text-amber-400 fill-current shrink-0" /> : null}
                          </div>
                          <div className="gcw-text-tag text-cyan-400/90">
                            {it.target_platform} · {it.category}
                          </div>
                        </div>
                        {tierBadge(it.fee_tier, it.my_status)}
                      </div>

                      <div className="text-xs text-slate-300 leading-snug">{it.metrics_desc}</div>
                      {it.fee_detail && (
                        <div className="gcw-text-tag text-slate-400 bg-slate-950/70 rounded px-2 py-1 border border-slate-800/70">
                          {it.fee_detail}
                        </div>
                      )}
                      <div className="gcw-text-meta text-amber-300/80">
                        口径：{it.data_nature || '按官网'} {it.limitation_warning ? `· ${it.limitation_warning}` : ''}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 pt-2 border-t border-slate-800/70">
                      {isPaid ? (
                        <button
                          onClick={() => setDecisionTool(it)}
                          className="flex-1 py-1.5 px-2.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-200 text-xs font-medium flex items-center justify-center gap-1"
                        >
                          <CreditCard className="w-3.5 h-3.5" />
                          查看收费说明与网址
                        </button>
                      ) : (
                        <a
                          href={it.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 py-1.5 px-2.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-cyan-500/40 text-xs font-medium flex items-center justify-center gap-1 transition"
                        >
                          直接打开 <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      <button
                        onClick={() => setDecisionTool(it)}
                        className="px-2 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-amber-300 text-xs"
                        title="标星 / 标记已付费 / 写备注"
                      >
                        <Star className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 赛道收益证据本（L1 自有 / L2 博主自晒 / L3 估算） */}
          <div className="bg-[#0b1120] border border-slate-800/90 rounded-xl p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-slate-100">赛道公开收益证据本（L1 自有真实 / L2 博主公开自晒 / L3 第三方估算）</div>
                <div className="gcw-text-tag text-slate-400">
                  随手记下各赛道博主晒出的真实 RPM、带货月 GMV 或独立站收入，形成你自己的一手赛道含金量账本
                </div>
              </div>
              <button
                onClick={() => setShowAddEv(!showAddEv)}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                记一笔收益情报
              </button>
            </div>

            {showAddEv && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs">
                <input
                  value={evForm.niche}
                  onChange={(e) => setEvForm({ ...evForm, niche: e.target.value })}
                  placeholder="赛道（如跨境医疗）"
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100"
                />
                <select
                  value={evForm.monetization_type}
                  onChange={(e) => setEvForm({ ...evForm, monetization_type: e.target.value })}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100"
                >
                  <option value="流量分成/RPM">流量分成/RPM</option>
                  <option value="短视频带货">短视频带货</option>
                  <option value="直播带货">直播带货</option>
                  <option value="独立站销售">独立站销售</option>
                  <option value="商业商单">商业商单</option>
                  <option value="私信获客">私信获客</option>
                </select>
                <input
                  value={evForm.platform}
                  onChange={(e) => setEvForm({ ...evForm, platform: e.target.value })}
                  placeholder="平台（如YouTube）"
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100"
                />
                <select
                  value={evForm.evidence_level}
                  onChange={(e) => setEvForm({ ...evForm, evidence_level: e.target.value })}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100"
                >
                  <option value="L2_SELF_REPORTED">L2 博主公开自晒</option>
                  <option value="L1_OWN">L1 我自己真实后台</option>
                  <option value="L3_THIRD_PARTY_EST">L3 第三方估算</option>
                </select>
                <input
                  value={evForm.metric_name}
                  onChange={(e) => setEvForm({ ...evForm, metric_name: e.target.value })}
                  placeholder="指标（RPM / 月GMV）"
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100"
                />
                <input
                  type="number"
                  value={evForm.amount_min}
                  onChange={(e) => setEvForm({ ...evForm, amount_min: e.target.value })}
                  placeholder="金额下限"
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100 font-mono-num"
                />
                <input
                  type="number"
                  value={evForm.amount_max}
                  onChange={(e) => setEvForm({ ...evForm, amount_max: e.target.value })}
                  placeholder="金额上限（选填）"
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100 font-mono-num"
                />
                <input
                  value={evForm.source_url}
                  onChange={(e) => setEvForm({ ...evForm, source_url: e.target.value })}
                  placeholder="原视频/来源链接"
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100"
                />
                <input
                  value={evForm.note}
                  onChange={(e) => setEvForm({ ...evForm, note: e.target.value })}
                  placeholder="备注（观众国家、长短视频口径、时间段）"
                  className="col-span-2 md:col-span-3 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-100"
                />
                <button onClick={submitEv} className="rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium py-1.5">
                  确认入库
                </button>
              </div>
            )}

            {evidence.length > 0 && (
              <div className="divide-y divide-slate-800/70 text-xs">
                {evidence.map((ev) => (
                  <div key={ev.id} className="py-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 gcw-text-meta text-cyan-300 font-mono-num">
                        {ev.evidence_level === 'L1_OWN' ? 'L1 自有' : ev.evidence_level === 'L2_SELF_REPORTED' ? 'L2 自晒' : 'L3 估算'}
                      </span>
                      <span className="font-semibold text-slate-100">
                        {ev.niche} · {ev.platform} ({ev.monetization_type})
                      </span>
                      <span className="font-mono-num text-emerald-400 font-bold">
                        {ev.metric_name}: {ev.currency} {ev.amount_min ?? '?'}
                        {ev.amount_max ? ` ~ ${ev.amount_max}` : ''}
                      </span>
                      {ev.note && <span className="text-slate-400">— {ev.note}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {ev.source_url && (
                        <a href={ev.source_url} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
                          来源↗
                        </a>
                      )}
                      <button onClick={() => api.delEvidence(ev.id).then(loadEvidence)} className="text-slate-500 hover:text-rose-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <PaidDecisionModal tool={decisionTool} onClose={() => setDecisionTool(null)} onUpdated={loadMatrix} />
    </div>
  );
}
