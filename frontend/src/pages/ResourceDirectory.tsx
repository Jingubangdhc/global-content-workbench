import { useEffect, useState } from 'react';
import { ExternalLink, Plus, Search, Star } from 'lucide-react';
import { api } from '../api';
import type { ToolRecord } from '../api';
import PaidDecisionModal from '../components/PaidDecisionModal';

/** 页面⑤：全量 268 条能力 / 166 独立站网址导航总库（多维组合秒筛 + 标星置顶 + 新增宝藏网址） */
export default function ResourceDirectory() {
  const [rows, setRows] = useState<ToolRecord[]>([]);
  const [viewMode, setViewMode] = useState('external');
  const [majorGroup, setMajorGroup] = useState('all');
  const [region, setRegion] = useState('all');
  const [feeTier, setFeeTier] = useState('all');
  const [q, setQ] = useState('');
  const [editTool, setEditTool] = useState<ToolRecord | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: '',
    url: '',
    major_group: '商业变现',
    category: '短视频带货',
    region: '海外',
    target_platform: 'YouTube',
    fee_tier: 'freemium',
    metrics_desc: '',
  });

  const load = async () => {
    const data = await api.listTools({
      view_mode: viewMode,
      major_group: majorGroup,
      region,
      fee_tier: feeTier,
      q,
    });
    setRows(data);
  };

  useEffect(() => {
    load();
  }, [viewMode, majorGroup, region, feeTier, q]);

  const addTool = async () => {
    if (!form.name.trim() || !form.url.trim()) return;
    await api.createTool(form);
    setShowAdd(false);
    setForm({ ...form, name: '', url: '', metrics_desc: '' });
    load();
  };

  return (
    <div className="flex flex-col h-full gap-3 overflow-hidden">
      <div className="bg-[#0b1120] border border-slate-800/90 rounded-xl p-3 space-y-2.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <select
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 font-medium"
            >
              <option value="external">🔭 只看同行/公开研究（默认）</option>
              <option value="own">🔐 只看我的自有后台</option>
              <option value="all">全部 268 条记录</option>
            </select>
            <select
              value={majorGroup}
              onChange={(e) => setMajorGroup(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
            >
              <option value="all">全部大类</option>
              <option value="商业变现">💰 商业变现</option>
              <option value="内容与流量">📈 内容与流量</option>
            </select>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
            >
              <option value="all">全部地区</option>
              <option value="海外">海外</option>
              <option value="国内">国内</option>
              <option value="全球">全球</option>
            </select>
            <select
              value={feeTier}
              onChange={(e) => setFeeTier(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
            >
              <option value="all">全部收费</option>
              <option value="free">🟢 免费核心</option>
              <option value="freemium">🟡 限免/需资格</option>
              <option value="paid">🔴 付费为主</option>
            </select>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜工具名 / 平台 / 指标..."
                className="bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-slate-100 w-52 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono-num text-slate-400">匹配 {rows.length} 条</span>
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              新增网址
            </button>
          </div>
        </div>

        {showAdd && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 border-t border-slate-800 text-xs">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="工具名称"
              className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-100"
            />
            <input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://..."
              className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-100"
            />
            <input
              value={form.target_platform}
              onChange={(e) => setForm({ ...form, target_platform: e.target.value })}
              placeholder="目标平台"
              className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-100"
            />
            <input
              value={form.metrics_desc}
              onChange={(e) => setForm({ ...form, metrics_desc: e.target.value })}
              placeholder="能查什么数据"
              className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-100"
            />
            <button onClick={addTool} className="col-span-2 md:col-span-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium">
              保存到本地导航库
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 bg-[#0b1120] border border-slate-800/90 rounded-xl overflow-y-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead className="text-[11px] text-slate-400 border-b border-slate-800 sticky top-0 bg-[#0f172a]">
            <tr>
              <th className="py-2.5 px-3">工具名称</th>
              <th className="py-2.5 px-2">类别 / 平台</th>
              <th className="py-2.5 px-2">收费与口径</th>
              <th className="py-2.5 px-2">可查数据与限制</th>
              <th className="py-2.5 px-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {rows.map((r) => (
              <tr key={`${r.id}-${r.cap_id}`} className="hover:bg-slate-900/60">
                <td className="py-2 px-3 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    {r.is_pinned ? <Star className="w-3.5 h-3.5 text-amber-400 fill-current" /> : null}
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-slate-100 hover:text-cyan-300"
                    >
                      {r.name}
                    </a>
                  </div>
                  <div className="text-[10px] text-slate-500">{r.domain}</div>
                </td>
                <td className="py-2 px-2 whitespace-nowrap">
                  <div className="text-cyan-300">{r.category}</div>
                  <div className="text-[10px] text-slate-400">
                    {r.region} · {r.target_platform}
                  </div>
                </td>
                <td className="py-2 px-2 whitespace-nowrap">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] border ${
                      r.my_status === 'paid_active'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                        : r.fee_tier === 'free'
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : r.fee_tier === 'paid'
                        ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                        : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    }`}
                  >
                    {r.my_status === 'paid_active'
                      ? '💳 已付费'
                      : r.fee_tier === 'free'
                      ? '🟢 免费'
                      : r.fee_tier === 'paid'
                      ? '🔴 付费'
                      : '🟡 限免'}
                  </span>
                  <div className="text-[10px] text-slate-500 mt-0.5">{r.data_nature}</div>
                </td>
                <td className="py-2 px-2 max-w-md">
                  <div className="text-slate-200 line-clamp-1">{r.metrics_desc}</div>
                  {r.my_note && <div className="text-[10px] text-emerald-400">备注：{r.my_note}</div>}
                </td>
                <td className="py-2 px-3 text-right whitespace-nowrap space-x-1.5">
                  <button
                    onClick={() => setEditTool(r)}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px]"
                  >
                    标记/备注
                  </button>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-1 rounded bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-cyan-500/40 text-[11px] inline-flex items-center gap-0.5"
                  >
                    打开 <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaidDecisionModal tool={editTool} onClose={() => setEditTool(null)} onUpdated={load} />
    </div>
  );
}
