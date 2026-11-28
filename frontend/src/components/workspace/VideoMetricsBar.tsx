/**
 * GCW-WORKSPACE-03 · 当前视频真实数据面板
 * - 优先读取数据库已有真实数据，不在每次播放时反复采集
 * - 仅用户点击「刷新数据」时尝试重新获取当前页面真实数据；失败保留上次有效值与时间，绝不以 0 覆盖有效值
 * - 缺失数据保留 NULL 并显示「—」
 * - 互动率与异常爆款倍数均明确标注计算口径与基准来源
 */
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { api, fmtDur, fmtNum } from '../../api';

export function formatLocalDateTime(raw?: string | null): string {
  if (!raw) return '未知';
  const s = String(raw).trim();
  if (!s) return '未知';
  // SQLite DATETIME 格式如 "2026-11-28 05:44:54" 视作 UTC 转本机时区；已有时区或纯日期直接解析
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

interface Props {
  contentId: number | null;
  playerBrowser?: any;
  fallbackItem?: any;
}

export default function VideoMetricsBar({ contentId, playerBrowser, fallbackItem }: Props) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState('');
  const reqSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++reqSeqRef.current;
    setRefreshErr('');
    if (!contentId) {
      setData(null);
      return;
    }
    setLoading(true);
    api
      .topicHubContentMetrics(contentId)
      .then((res) => {
        if (seq !== reqSeqRef.current) return;
        if (res?.ok) setData(res);
      })
      .catch(() => {
        if (seq !== reqSeqRef.current) return;
        setData(null);
      })
      .finally(() => {
        if (seq === reqSeqRef.current) setLoading(false);
      });
  }, [contentId]);

  const handleRefresh = async () => {
    if (!contentId || refreshing) return;
    setRefreshing(true);
    setRefreshErr('');
    try {
      let payload: any = {};
      if (playerBrowser?.extractVideoMeta) {
        const snap = await playerBrowser.extractVideoMeta();
        if (!snap || snap.ok === false || snap.extract_status === 'script_error') {
          throw new Error(snap?.error_message || '当前播放器页面未能提取到有效数据');
        }
        const rm = snap.raw_metrics || {};
        payload = {
          view_count: rm.views || null,
          like_count: rm.likes || null,
          comment_count: rm.comments || null,
          favorite_count: rm.favorites || null,
          share_count: rm.shares || null,
          author_follower_count: rm.followers || null,
          duration_sec: snap.duration_sec ?? null,
          author_name: snap.author || undefined,
          published_at: snap.published_at || undefined,
        };
      }
      const res = await api.topicHubRefreshContentMetrics(contentId, payload);
      if (res?.ok) {
        setData(res);
      } else {
        setRefreshErr(res?.error || '刷新失败，已保留上一次成功获取的数据');
      }
    } catch (e: any) {
      setRefreshErr(`刷新失败（已保留原有有效数据）：${e?.message || e}`);
    } finally {
      setRefreshing(false);
    }
  };

  if (!contentId) return null;

  const m = data?.metrics || {};
  const title = data?.title || fallbackItem?.title || '未命名视频';
  const author = data?.author_name || fallbackItem?.author_name || '—';
  const platform = (data?.platform || fallbackItem?.platform || '—').toUpperCase();
  const durationSec = data?.duration_sec ?? fallbackItem?.duration_sec ?? null;
  const publishedAt = data?.published_at || fallbackItem?.published_at || null;
  const capturedAt = data?.manual_captured_at || fallbackItem?.manual_captured_at || null;
  const collectedAt = data?.collected_at || fallbackItem?.collected_at || null;
  const url = data?.url || fallbackItem?.url || '';

  const cells: { label: string; value: string; tip?: string; accent?: string }[] = [
    { label: '播放量', value: fmtNum(m.view_count), accent: 'text-cyan-300' },
    { label: '点赞量', value: fmtNum(m.like_count) },
    { label: '评论量', value: fmtNum(m.comment_count) },
    { label: '收藏量', value: fmtNum(m.favorite_count) },
    { label: '分享量', value: fmtNum(m.share_count) },
    { label: '作者粉丝', value: fmtNum(m.author_follower_count) },
    {
      label: '互动率',
      value: m.engagement_rate != null ? `${m.engagement_rate}%` : '—',
      tip: m.engagement_formula || '缺少有效播放量或互动数据',
      accent: m.engagement_rate != null ? 'text-emerald-300' : 'text-slate-400',
    },
    {
      label: '异常爆款倍数',
      value: m.outlier_multiple != null ? `${m.outlier_multiple}x` : '—',
      tip: m.outlier_basis || '无可靠作者历史作品基准',
      accent: m.outlier_multiple != null ? 'text-amber-300' : 'text-slate-400',
    },
  ];

  return (
    <div className="gcw-panel px-3.5 py-2.5 space-y-2 shrink-0">
      {/* 顶部：视频元信息 + 刷新按钮 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <span className="px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 gcw-text-tag font-semibold shrink-0">
            {platform}
          </span>
          <span className="gcw-video-title text-slate-100 truncate max-w-[42vw]" title={title}>
            {title}
          </span>
          <span className="gcw-text-meta text-slate-300">作者：{author}</span>
          <span className="gcw-text-meta text-slate-400 font-mono-num">时长：{fmtDur(durationSec)}</span>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 gcw-text-tag text-cyan-400 hover:text-cyan-300"
              title="在外部浏览器查看原视频"
            >
              原链接 <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="gcw-btn-ghost gcw-text-btn px-2.5 py-1 rounded-lg inline-flex items-center gap-1.5 disabled:opacity-50"
            title="仅在点击时尝试从当前播放页面刷新真实数据；失败时保留上次有效数据"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '刷新中...' : '刷新数据'}
          </button>
        </div>
      </div>

      {/* 8 项核心真实指标 */}
      <div className="grid grid-cols-4 xl:grid-cols-8 gap-2">
        {cells.map((c) => (
          <div
            key={c.label}
            title={c.tip || c.label}
            className="bg-[#0c1424] border border-[#1e2e4a] rounded-lg px-2.5 py-1.5 flex flex-col justify-between"
          >
            <span className="gcw-text-meta text-slate-400 truncate">{c.label}</span>
            <span className={`gcw-metric-value font-mono-num font-bold leading-tight mt-0.5 ${c.accent || 'text-slate-100'}`}>
              {loading ? '…' : c.value}
            </span>
          </div>
        ))}
      </div>

      {/* 时间与口径说明条 */}
      <div className="flex flex-wrap items-center justify-between gap-2 gcw-text-meta text-slate-400">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono-num">
          <span>作品发布：{publishedAt || '未知'}</span>
          <span>作品收录：{formatLocalDateTime(capturedAt)}</span>
          <span>数据采集：{formatLocalDateTime(collectedAt)}</span>
        </div>
        <div className="truncate max-w-[46vw]" title={`${m.engagement_formula || ''} | ${m.outlier_basis || ''}`}>
          口径：{m.engagement_formula || '—'} · 爆款：{m.outlier_basis || '—'}
        </div>
      </div>

      {refreshErr && (
        <div className="px-2.5 py-1.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 gcw-text-tag flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{refreshErr}</span>
        </div>
      )}
    </div>
  );
}
