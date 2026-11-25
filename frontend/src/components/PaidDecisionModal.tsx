import { useState } from 'react';
import { AlertTriangle, CreditCard, ExternalLink, Star, X } from 'lucide-react';
import { api } from '../api';
import type { ToolRecord } from '../api';

interface Props {
  tool: ToolRecord | null;
  onClose: () => void;
  onUpdated: () => void;
}

/** 付费工具决策弹窗：点击 🔴 付费入口先看值不值得买、数据红线与价格页，再由用户决定 */
export default function PaidDecisionModal({ tool, onClose, onUpdated }: Props) {
  const [status, setStatus] = useState(tool?.my_status || 'untested');
  const [cost, setCost] = useState(tool?.my_monthly_cost ? String(tool.my_monthly_cost) : '');
  const [expire, setExpire] = useState(tool?.my_expire_date || '');
  const [pinned, setPinned] = useState(Boolean(tool?.is_pinned));
  const [note, setNote] = useState(tool?.my_note || '');
  const [saving, setSaving] = useState(false);

  if (!tool) return null;
  const tid = tool.tool_id || tool.id;

  const save = async () => {
    setSaving(true);
    try {
      await api.patchTool(tid, {
        my_status: status,
        my_monthly_cost: cost ? parseFloat(cost) : null,
        my_expire_date: expire || null,
        is_pinned: pinned ? 1 : 0,
        my_note: note,
      });
      onUpdated();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-[#0f172a] border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-[#0b1120]">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 text-[11px] rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-medium">
              🔴 付费决策评估
            </span>
            <h3 className="font-bold text-slate-100">{tool.name}</h3>
            <span className="text-xs text-slate-400">({tool.target_platform})</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 space-y-1.5">
            <div className="text-xs text-slate-400">花钱能看到的核心数据</div>
            <div className="text-slate-100 font-medium">{tool.metrics_desc || '详见官网说明'}</div>
            {tool.operation_path && (
              <div className="text-xs text-cyan-300/90">路径：{tool.operation_path}</div>
            )}
            {tool.fee_detail && (
              <div className="text-xs text-slate-300 pt-1 border-t border-slate-800">{tool.fee_detail}</div>
            )}
          </div>

          <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg p-3">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">数据性质：{tool.data_nature || '第三方估算'}</div>
              <div className="text-amber-200/80 mt-0.5">
                {tool.limitation_warning || '第三方模型估算不等于达人真实到手净收入，建议先试用 7 天或按月订阅验证导出能力。'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <a
              href={tool.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs transition"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              前往官网查看（自己决定是否付费）
            </a>
            {tool.pricing_evidence_url && tool.pricing_evidence_url !== tool.url && (
              <a
                href={tool.pricing_evidence_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs border border-slate-700"
              >
                <CreditCard className="w-3.5 h-3.5" />
                价格/说明页
              </a>
            )}
          </div>

          <div className="border-t border-slate-800 pt-3 space-y-3">
            <div className="text-xs font-semibold text-slate-300">我的试用与付费账本</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
              >
                <option value="untested">⚪ 未试用</option>
                <option value="useful">✅ 免费/试用好用</option>
                <option value="paid_active">💳 我已付费（全站置顶）</option>
                <option value="disliked">❌ 不值得买</option>
                <option value="broken">⚠️ 网址失效</option>
              </select>
              <button
                type="button"
                onClick={() => setPinned(!pinned)}
                className={`flex items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 ${
                  pinned
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                    : 'bg-slate-900 border-slate-700 text-slate-400'
                }`}
              >
                <Star className="w-3.5 h-3.5" />
                {pinned ? '已标星置顶' : '标星置顶'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <input
                type="number"
                placeholder="月费金额（选填）"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono-num"
              />
              <input
                type="text"
                placeholder="到期日 如 2026-12-31"
                value={expire}
                onChange={(e) => setExpire(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
              />
            </div>
            <input
              type="text"
              placeholder="实测备注（例如：能否导出CSV、是否准确）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200"
            />
          </div>
        </div>

        <div className="px-5 py-3 bg-[#0b1120] border-t border-slate-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white">
            取消
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
          >
            {saving ? '保存中...' : '保存个人标记'}
          </button>
        </div>
      </div>
    </div>
  );
}
