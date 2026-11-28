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
  const refreshSeqRef = useRef(0);
  const activeContentIdRef = useRef<number | null>(contentId);
  activeContentIdRef.current = contentId;

  useEffect(() => {
    const seq = ++reqSeqRef.current;
    refreshSeqRef.current += 1;
    // FIX-02 & FIX-04: 切换作品时立即隔离旧数据和旧请求状态
    setData(null);
    setRefreshErr('');
    setRefreshing(false);
    if (!contentId) {
      setLoading(false);
      return;
    }
    const targetCid = contentId;
    setLoading(true);
    api
      .topicHubContentMetrics(targetCid)
      .then((res) => {
        if (seq !== reqSeqRef.current || activeContentIdRef.current !== targetCid) return;
        if (res?.ok) setData(res);
      })
      .catch(() => {
        if (seq !== reqSeqRef.current || activeContentIdRef.current !== targetCid) return;
        setData(null);
      })
      .finally(() => {
        if (seq === reqSeqRef.current && activeContentIdRef.current === targetCid) setLoading(false);
      });
  }, [contentId]);

  const handleRefresh = async () => {
    if (!contentId || refreshing) return;
    const targetCid = contentId;
    const rSeq = ++refreshSeqRef.current;
    setRefreshing(true);
    setRefreshErr('');
    try {
      if (!playerBrowser?.extractVideoMeta) {
        throw new Error('当前非桌面端内嵌播放器，无法核验播放器当前作品身份');
      }
      const snap = await playerBrowser.extractVideoMeta();
      if (rSeq !== refreshSeqRef.current || activeContentIdRef.current !== targetCid) return;
      if (!snap || snap.ok === false || snap.extract_status === 'script_error') {
        throw new Error(snap?.error_message || '当前播放器页面未能提取到有效数据');
      }
      // FIX-02 前端强身份校验：核对播放器当前平台与真实平台作品 ID
      const expectedPlatform = String(data?.platform || fallbackItem?.platform || '').trim().toLowerCase();
      const expectedItemId = String(data?.platform_item_id || fallbackItem?.platform_item_id || '').trim();
      const livePlatform = String(snap.platform || '').trim().toLowerCase();
      const liveItemId = String(snap.platform_item_id || '').trim();

      if (!livePlatform || !liveItemId) {
        throw new Error('播放器当前页面无法确认真实平台作品 ID，拒绝刷新（已保留原有有效数据）');
      }
      if (expectedPlatform && livePlatform !== expectedPlatform) {
        throw new Error(`播放器当前平台（${livePlatform}）与目标作品（${expectedPlatform}）不一致，禁止跨视频更新`);
      }
      if (expectedItemId && liveItemId !== expectedItemId) {
        throw new Error(`播放器当前已切换至其他视频（${liveItemId} ≠ ${expectedItemId}），已拦截刷新以保护原作品数据`);
      }

      const rm = snap.raw_metrics || {};
      const payload = {
        expected_platform: livePlatform,
        expected_platform_item_id: liveItemId,
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
      const res = await api.topicHubRefreshContentMetrics(targetCid, payload);
      if (rSeq !== refreshSeqRef.current || activeContentIdRef.current !== targetCid) return;
      if (res?.ok) {
        setData(res);
      } else {
        setRefreshErr(res?.error || '刷新失败，已保留上一次成功获取的数据');
      }
    } catch (e: any) {
      if (rSeq !== refreshSeqRef.current || activeContentIdRef.current !== targetCid) return;
      setRefreshErr(`刷新失败（已保留原有有效数据）：${e?.message || e}`);
    } finally {
      if (rSeq === refreshSeqRef.current && activeContentIdRef.current === targetCid) setRefreshing(false);
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
      value: m.outlier_multiple != null ? `${m.outlier_multiple}x` : '未知',
      tip: m.outlier_basis || '未知（无可靠作者发布前历史作品基准）',
      accent: m.outlier_multiple != null ? 'text-amber-300' : 'text-slate-400',
    },
  ];

  return (
    <div className="gcw-panel px-3 py-1.5 space-y-1 shrink-0" data-testid="compact-metrics-bar">
      {/* 行 1：平台 + 标题 + 作者 + 时长 + 关键时间 + 刷新按钮 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 min-w-0">
          <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 gcw-text-meta font-semibold shrink-0">
            {platform}
          </span>
          <span className="gcw-text-base font-semibold text-slate-100 truncate max-w-[30vw]" title={title}>
            {title}
          </span>
          <span className="gcw-text-tag text-slate-300 truncate max-w-[14vw]" title={`作者：${author}`}>
            {author}
          </span>
          <span className="gcw-text-meta text-slate-400 font-mono-num">时长 {fmtDur(durationSec)}</span>
          <span
            className="gcw-text-meta text-slate-400 font-mono-num hidden 2xl:inline"
            title={`发布：${publishedAt || '未知'} | 收录：${formatLocalDateTime(capturedAt)} | 采集：${formatLocalDateTime(collectedAt)}`}
          >
            收录 {formatLocalDateTime(capturedAt)}
          </span>
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 gcw-text-meta text-cyan-400 hover:text-cyan-300">
              原链<ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="gcw-btn-ghost gcw-text-tag px-2 py-0.5 rounded-lg inline-flex items-center gap-1 shrink-0 disabled:opacity-50"
          title={`仅点击时刷新真实数据（失败保留原值）\n互动率口径：${m.engagement_formula || '—'}\n爆款基准：${m.outlier_basis || '未知'}\n采集时间：${formatLocalDateTime(collectedAt)}`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? '刷新中' : '刷新'}
        </button>
      </div>

      {/* 行 2：紧凑型横向 8 项指标条（宽屏单行，总高 ~68-80px，详细口径悬停查看） */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-[#0c1424] border border-[#1e2e4a] rounded-lg px-3 py-1">
        {cells.map((c) => (
          <div key={c.label} title={c.tip || c.label} className="inline-flex items-baseline gap-1.5 cursor-help">
            <span className="gcw-text-meta text-slate-400">{c.label}</span>
            <span className={`gcw-text-base font-mono-num font-bold ${c.accent || 'text-slate-100'}`}>
              {loading ? '…' : c.value}
            </span>
          </div>
        ))}
      </div>

      {refreshErr && (
        <div className="px-2.5 py-1 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 gcw-text-meta flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{refreshErr}</span>
        </div>
      )}
    </div>
  );
}
