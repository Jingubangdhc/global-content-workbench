import { useState } from 'react';
import { Calculator, X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 完整内嵌原 Excel《商业计算器》全部 4 组公式的实时收益反推抽屉（0 Token 纯前端计算） */
export default function RevenueCalculatorDrawer({ open, onClose }: Props) {
  const [tab, setTab] = useState<'rpm' | 'ecom' | 'dm' | 'indie'>('rpm');

  // 1. RPM 流量分成
  const [views, setViews] = useState(100000);
  const [rpmLow, setRpmLow] = useState(3);
  const [rpmHigh, setRpmHigh] = useState(10);

  // 2. 带货 GPM / 佣金
  const [ecomViews, setEcomViews] = useState(100000);
  const [gmv, setGmv] = useState(20000);
  const [commRate, setCommRate] = useState(7.5);
  const [refundRate, setRefundRate] = useState(15);

  // 3. 私信高客单五级漏斗
  const [reach, setReach] = useState(10000);
  const [dmUsers, setDmUsers] = useState(200);
  const [validLeads, setValidLeads] = useState(80);
  const [booked, setBooked] = useState(20);
  const [paidCust, setPaidCust] = useState(8);
  const [adSpend, setAdSpend] = useState(400);
  const [totalAcqCost, setTotalAcqCost] = useState(600);
  const [bizRev, setBizRev] = useState(5000);
  const [fulfillCost, setFulfillCost] = useState(2100);
  const [otherVarCost, setOtherVarCost] = useState(400);

  // 4. 独立站 & 联盟
  const [sessions, setSessions] = useState(5000);
  const [convSessions, setConvSessions] = useState(100);
  const [orders, setOrders] = useState(110);
  const [netSales, setNetSales] = useState(5500);
  const [adAttrSales, setAdAttrSales] = useState(2400);
  const [indieAdSpend, setIndieAdSpend] = useState(400);
  const [affClicks, setAffClicks] = useState(1500);
  const [affComm, setAffComm] = useState(450);

  if (!open) return null;

  const gpm = ecomViews > 0 ? (gmv / ecomViews) * 1000 : 0;
  const estNetComm = gmv * (1 - refundRate / 100) * (commRate / 100);

  const dmRate = reach > 0 ? (dmUsers / reach) * 100 : 0;
  const leadRate = dmUsers > 0 ? (validLeads / dmUsers) * 100 : 0;
  const bookRate = validLeads > 0 ? (booked / validLeads) * 100 : 0;
  const closeRate = validLeads > 0 ? (paidCust / validLeads) * 100 : 0;
  const cpl = validLeads > 0 ? adSpend / validLeads : 0;
  const cac = paidCust > 0 ? totalAcqCost / paidCust : 0;
  const contribProfit = bizRev - fulfillCost - totalAcqCost - otherVarCost;
  const contribMargin = bizRev > 0 ? (contribProfit / bizRev) * 100 : 0;

  const cvr = sessions > 0 ? (convSessions / sessions) * 100 : 0;
  const aov = orders > 0 ? netSales / orders : 0;
  const roas = indieAdSpend > 0 ? adAttrSales / indieAdSpend : 0;
  const epc = affClicks > 0 ? affComm / affClicks : 0;

  const numInput = (label: string, val: number, setVal: (n: number) => void, hint?: string) => (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-800/80">
      <div>
        <div className="text-xs text-slate-300">{label}</div>
        {hint && <div className="text-[10px] text-slate-500">{hint}</div>}
      </div>
      <input
        type="number"
        value={val}
        onChange={(e) => setVal(parseFloat(e.target.value) || 0)}
        className="w-28 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-right text-xs font-mono-num text-cyan-300 focus:outline-none focus:border-cyan-500"
      />
    </div>
  );

  const metricBox = (label: string, val: string, accent = 'text-emerald-400') => (
    <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`text-base font-bold font-mono-num mt-0.5 ${accent}`}>{val}</div>
    </div>
  );

  return (
    <div className="fixed inset-y-0 right-0 w-[410px] bg-[#0b1120] border-l border-slate-800 shadow-2xl z-50 flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-[#0f172a]">
        <div className="flex items-center gap-2 text-cyan-400 font-semibold text-sm">
          <Calculator className="w-4 h-4" />
          <span>赛道收益反推计算器</span>
          <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">原表公式</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white p-1">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-1 p-2 bg-slate-950 border-b border-slate-800 text-xs">
        {[
          ['rpm', '流量RPM'],
          ['ecom', '带货GPM'],
          ['dm', '私信漏斗'],
          ['indie', '独立站/联盟'],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k as any)}
            className={`py-1.5 rounded font-medium transition ${
              tab === k ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:bg-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tab === 'rpm' && (
          <>
            <div className="text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded p-2">
              口径红线：Shorts 与长视频 RPM 差异极大，请勿混算；不要用广告主 CPM 代替创作者实收 RPM。
            </div>
            <div>
              {numInput('合格播放量（同周期）', views, setViews, '如近30天长视频播放')}
              {numInput('赛道保守 RPM（$ / 千次）', rpmLow, setRpmLow, '如娱乐 $1-3，医疗/财经 $6-15')}
              {numInput('赛道乐观 RPM（$ / 千次）', rpmHigh, setRpmHigh)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {metricBox('保守估算收益', `$${((views / 1000) * rpmLow).toFixed(0)}`, 'text-emerald-400')}
              {metricBox('乐观估算收益', `$${((views / 1000) * rpmHigh).toFixed(0)}`, 'text-cyan-400')}
            </div>
          </>
        )}

        {tab === 'ecom' && (
          <>
            <div className="text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded p-2">
              口径红线：第三方工具的 GMV 是下单估算，≠ 达人佣金，也 ≠ 净收入（需扣除退货率）。
            </div>
            <div>
              {numInput('带货观看量', ecomViews, setEcomViews)}
              {numInput('估算带货 GMV', gmv, setGmv, '同币种')}
              {numInput('达人佣金率 (%)', commRate, setCommRate)}
              {numInput('预估退款/取消率 (%)', refundRate, setRefundRate)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {metricBox('GPM（千次观看GMV）', gpm.toFixed(1), 'text-cyan-400')}
              {metricBox('扣退款预估净佣金', estNetComm.toFixed(0), 'text-emerald-400')}
            </div>
          </>
        )}

        {tab === 'dm' && (
          <>
            <div className="text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded p-2">
              适合跨境医疗 / 高客单咨询业务：按同批次去重人数测算私域变现效率。
            </div>
            <div>
              {numInput('内容触达人数', reach, setReach)}
              {numInput('新增私信人数', dmUsers, setDmUsers)}
              {numInput('有效线索人数', validLeads, setValidLeads)}
              {numInput('预约人数', booked, setBooked)}
              {numInput('新付费客户', paidCust, setPaidCust)}
              {numInput('广告支出', adSpend, setAdSpend)}
              {numInput('全部获客成本', totalAcqCost, setTotalAcqCost, '含广告，勿重复扣')}
              {numInput('确认业务收入', bizRev, setBizRev)}
              {numInput('履约变动成本', fulfillCost, setFulfillCost)}
              {numInput('其他变动成本', otherVarCost, setOtherVarCost)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {metricBox('私信率 / 有效线索率', `${dmRate.toFixed(1)}% / ${leadRate.toFixed(1)}%`, 'text-cyan-300')}
              {metricBox('预约率 / 线索成交率', `${bookRate.toFixed(1)}% / ${closeRate.toFixed(1)}%`, 'text-cyan-300')}
              {metricBox('CPL / CAC', `${cpl.toFixed(1)} / ${cac.toFixed(1)}`, 'text-amber-300')}
              {metricBox('贡献利润 (利润率)', `${contribProfit.toFixed(0)} (${contribMargin.toFixed(1)}%)`, contribProfit >= 0 ? 'text-emerald-400' : 'text-rose-400')}
            </div>
          </>
        )}

        {tab === 'indie' && (
          <>
            <div>
              {numInput('独立站会话数', sessions, setSessions)}
              {numInput('成交会话数', convSessions, setConvSessions)}
              {numInput('订单数', orders, setOrders)}
              {numInput('独立站净销售额', netSales, setNetSales, '扣折扣/退款')}
              {numInput('广告归因销售额', adAttrSales, setAdAttrSales)}
              {numInput('广告花费', indieAdSpend, setIndieAdSpend)}
              {numInput('联盟点击数', affClicks, setAffClicks)}
              {numInput('联盟确认净佣金', affComm, setAffComm)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {metricBox('会话转化率 CVR', `${cvr.toFixed(2)}%`, 'text-cyan-400')}
              {metricBox('客单价 AOV', aov.toFixed(1), 'text-emerald-400')}
              {metricBox('广告回报 ROAS', `${roas.toFixed(2)}x`, 'text-amber-300')}
              {metricBox('联盟每点击收益 EPC', epc.toFixed(3), 'text-emerald-400')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
