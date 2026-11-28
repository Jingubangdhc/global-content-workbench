/**
 * GCW-WORKSPACE-02 · 固定内嵌视频播放与实时双语字幕工作区
 * - 复用现有 Electron topicPlayerView，绝不新建第三套播放器
 * - 通过 ResizeObserver + window resize/scroll 精准同步 setBounds
 * - 当上层存在弹窗/抽屉时由 overlayHidden=true 自动隐藏原生视图，防止遮挡弹窗
 * - 保留 R4-G 100ms 真实 currentTime 同步、外语自动翻译闭环、工作台内最大化与恢复；不恢复已删除的字幕位置切换
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Languages,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Settings,
} from 'lucide-react';
import { api } from '../../api';

export type SubtitleMode = 'bilingual' | 'zh' | 'original' | 'off';

interface Props {
  isActive?: boolean;
  activeVideo: any | null;
  playerBrowser: any;
  overlayHidden: boolean;
  heightPx: number;
  maximized: boolean;
  onToggleMaximize: () => void;
  subData: any | null;
  onSubDataChange: (next: any | null) => void;
  onActiveSegmentIdxChange?: (idx: number | null) => void;
}

function isChineseSubtitles(sub: any): boolean {
  const segs: any[] = sub?.segments || [];
  const sample = segs.slice(0, 12).map((s) => String(s.text || '')).join('');
  if (!sample) return false;
  const zh = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  return zh / Math.max(1, sample.length) >= 0.35;
}

export default function EmbeddedVideoWorkspace({
  isActive = true,
  activeVideo,
  playerBrowser,
  overlayHidden,
  heightPx,
  maximized,
  onToggleMaximize,
  subData,
  onSubDataChange,
  onActiveSegmentIdxChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const autoTransRunIdRef = useRef(0);
  const playbackReqSeqRef = useRef(0);
  const boundsOpSeqRef = useRef(0);
  const lastNavigatedUrlRef = useRef<string>('');
  const effectiveHidden = !isActive || overlayHidden;
  const overlayHiddenRef = useRef(effectiveHidden);
  const activeVideoRef = useRef(activeVideo);
  overlayHiddenRef.current = effectiveHidden;
  activeVideoRef.current = activeVideo;

  const [subMode, setSubMode] = useState<SubtitleMode>('bilingual');
  const [subLoading, setSubLoading] = useState(false);
  const [subTranslating, setSubTranslating] = useState(false);
  const [subProgressMsg, setSubProgressMsg] = useState('');
  const [subError, setSubError] = useState('');
  const [playback, setPlayback] = useState({
    hasVideo: false,
    isAd: false,
    buffering: false,
    currentTime: 0,
    duration: 0,
    paused: true,
    ended: false,
    playbackRate: 1,
    url: '',
  });

  // 1. FIX-09: 仅当切换到不同视频 URL 且页面处于激活态时才 navigate，返回 TopicHub 绝不重新加载原视频
  useEffect(() => {
    if (!playerBrowser) return;
    if (!activeVideo?.url || effectiveHidden) {
      playerBrowser.setVisible(false).catch(() => {});
      return;
    }
    if (lastNavigatedUrlRef.current !== activeVideo.url) {
      lastNavigatedUrlRef.current = activeVideo.url;
      playerBrowser.navigate(activeVideo.url).catch(() => {});
    }
  }, [activeVideo?.content_id, activeVideo?.url, effectiveHidden, playerBrowser]);

  // 2. FIX-05: 精准同步 WebContentsView 坐标与显隐（带 boundsOpSeqRef + overlayHiddenRef 防旧异步 setBounds 在弹窗打开后重新显示播放器）
  useEffect(() => {
    if (!playerBrowser) return;
    const syncBounds = () => {
      const opSeq = ++boundsOpSeqRef.current;
      const el = hostRef.current;
      if (!el || !activeVideoRef.current?.url || overlayHiddenRef.current) {
        playerBrowser.setVisible(false).catch(() => {});
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 60) {
        playerBrowser.setVisible(false).catch(() => {});
        return;
      }
      playerBrowser
        .setBounds({
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        })
        .then(() => {
          if (opSeq !== boundsOpSeqRef.current || overlayHiddenRef.current || !activeVideoRef.current?.url) {
            return;
          }
          return playerBrowser.setVisible(true);
        })
        .catch(() => {});
    };

    syncBounds();
    const ro = new ResizeObserver(syncBounds);
    if (hostRef.current) ro.observe(hostRef.current);
    window.addEventListener('resize', syncBounds);
    window.addEventListener('scroll', syncBounds, true);
    const t1 = setTimeout(syncBounds, 80);
    return () => {
      boundsOpSeqRef.current += 1;
      clearTimeout(t1);
      ro.disconnect();
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener('scroll', syncBounds, true);
    };
  }, [playerBrowser, activeVideo?.content_id, activeVideo?.url, effectiveHidden, heightPx, maximized]);

  // 组件卸载（离开 TopicHub）时暂停并隐藏播放器，绝不销毁实例
  useEffect(() => {
    return () => {
      playerBrowser?.setVisible?.(false)?.catch?.(() => {});
    };
  }, [playerBrowser]);

  // 3. FIX-04: 切换视频时立即清空旧字幕与播放时间，避免旧字幕残留；自动加载字幕与外语视频本地混元自动翻译闭环
  useEffect(() => {
    const runId = ++autoTransRunIdRef.current;
    playbackReqSeqRef.current += 1;
    onSubDataChange(null);
    onActiveSegmentIdxChange?.(null);
    setPlayback({
      hasVideo: false,
      isAd: false,
      buffering: false,
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
      playbackRate: 1,
      url: '',
    });
    setSubError('');
    setSubProgressMsg('');
    setSubLoading(false);
    setSubTranslating(false);
    if (!activeVideo?.content_id) {
      return;
    }
    const contentId = activeVideo.content_id;
    setSubLoading(true);
    (async () => {
      try {
        let data = await api.translationGetSubtitles(contentId, 'zh-CN');
        if (autoTransRunIdRef.current !== runId) return;
        onSubDataChange(data);

        if (!data?.has_transcript || !data?.total_count) {
          setSubProgressMsg('未检测到本地字幕，正在自动提取合法原始字幕...');
          try {
            const ex = await api.extractTranscript(contentId);
            if (autoTransRunIdRef.current !== runId) return;
            if (ex?.ok) {
              data = await api.translationGetSubtitles(contentId, 'zh-CN');
              if (autoTransRunIdRef.current !== runId) return;
              onSubDataChange(data);
            }
          } catch {
            // 不阻断视频播放
          }
        }

        if (!data?.has_transcript || !data?.total_count) {
          setSubProgressMsg('');
          setSubLoading(false);
          return;
        }
        if (isChineseSubtitles(data)) {
          setSubProgressMsg('中文原声视频（直接同步原文字幕）');
          setSubLoading(false);
          return;
        }
        if (data.translated_count >= data.total_count) {
          setSubProgressMsg(`本地双语字幕缓存（${data.translated_count}/${data.total_count} 段 · 0 Token 复用）`);
          setSubLoading(false);
          return;
        }

        const cfg = await api.translationGetConfig().catch(() => null);
        if (autoTransRunIdRef.current !== runId) return;
        const defId = cfg?.default_engine_id || '';
        const defProv = (cfg?.providers || []).find((p: any) => p.engine_id === defId);
        const billingMode = cfg?.policy?.billing_mode || 'free_only';
        if (!defId || !defProv) {
          setSubProgressMsg('未配置默认翻译引擎，可点击右侧「翻译配置」选定');
          setSubLoading(false);
          return;
        }
        if (billingMode === 'free_only' && defProv.billing_category === 'pay_as_you_go') {
          setSubProgressMsg(`仅允许免费模式：已暂停自动调用付费引擎 ${defProv.short_name}`);
          setSubLoading(false);
          return;
        }

        setSubLoading(false);
        setSubTranslating(true);
        setSubProgressMsg(`正在自动翻译外语字幕（${defProv.short_name} · ${data.total_count} 段）...`);
        const transRes = await api.translationTranslateSubtitles(contentId, { target_lang: 'zh-CN' });
        if (autoTransRunIdRef.current !== runId) return;
        onSubDataChange(transRes);
        setSubProgressMsg(transRes.message || `自动翻译完成（${transRes.translated_count}/${transRes.total_count} 段）`);
      } catch (e: any) {
        if (autoTransRunIdRef.current !== runId) return;
        setSubError(e?.message || '自动加载/翻译字幕失败');
      } finally {
        if (autoTransRunIdRef.current === runId) {
          setSubLoading(false);
          setSubTranslating(false);
        }
      }
    })();
  }, [activeVideo?.content_id]);

  // 4. R4-G / FIX-09: 仅当页面激活且未隐藏时执行 100ms 真实 currentTime 同步轮询（离开页面自动停轮询省资源）
  useEffect(() => {
    if (!playerBrowser || !activeVideo?.content_id || effectiveHidden) return;
    let alive = true;
    const expectedItemId = String(activeVideo.platform_item_id || '').trim();
    const expectedUrl = String(activeVideo.url || '').trim();

    const matchesUrl = (liveUrl: string) => {
      if (!liveUrl || liveUrl === 'about:blank') return false;
      if (expectedItemId && liveUrl.includes(expectedItemId)) return true;
      if (expectedUrl && liveUrl.startsWith(expectedUrl.split('?')[0])) return true;
      return !expectedItemId;
    };

    const tick = async () => {
      const seq = ++playbackReqSeqRef.current;
      try {
        const res = await playerBrowser.getVideoPlayback();
        if (!alive || seq !== playbackReqSeqRef.current || !res?.ok) return;
        const liveUrl = String(res.url || '');
        if (!matchesUrl(liveUrl)) {
          setPlayback((prev) =>
            prev.hasVideo
              ? { hasVideo: false, isAd: false, buffering: false, currentTime: 0, duration: 0, paused: true, ended: false, playbackRate: 1, url: liveUrl }
              : prev
          );
          return;
        }
        setPlayback({
          hasVideo: Boolean(res.hasVideo) && !Boolean(res.isAd),
          isAd: Boolean(res.isAd),
          buffering: Boolean(res.buffering),
          currentTime: Number.isFinite(Number(res.currentTime)) ? Number(res.currentTime) : 0,
          duration: Number.isFinite(Number(res.duration)) ? Number(res.duration) : 0,
          paused: Boolean(res.paused),
          ended: Boolean(res.ended),
          playbackRate: Number.isFinite(Number(res.playbackRate)) ? Number(res.playbackRate) : 1,
          url: liveUrl,
        });
      } catch {
        // 忽略瞬时导航读取异常
      }
    };
    tick();
    const iv = setInterval(tick, 100);
    return () => {
      alive = false;
      playbackReqSeqRef.current += 1;
      clearInterval(iv);
    };
  }, [activeVideo?.content_id, activeVideo?.platform_item_id, activeVideo?.url, effectiveHidden, playerBrowser]);

  const sortedSegs = useMemo(() => {
    const segs: any[] = subData?.segments || [];
    return [...segs].sort((a, b) => {
      const d = Number(a.start || 0) - Number(b.start || 0);
      return d !== 0 ? d : Number(a.segment_idx || 0) - Number(b.segment_idx || 0);
    });
  }, [subData?.segments]);

  const activeSeg = useMemo(() => {
    if (!sortedSegs.length || !playback.hasVideo || playback.isAd) return null;
    const t = playback.currentTime;
    for (let i = sortedSegs.length - 1; i >= 0; i--) {
      const s = sortedSegs[i];
      const start = Number(s.start || 0);
      const end = Number(s.end || start + 2.5);
      if (t >= start && t <= end) return s;
    }
    return null;
  }, [sortedSegs, playback.hasVideo, playback.isAd, playback.currentTime]);

  useEffect(() => {
    onActiveSegmentIdxChange?.(activeSeg ? Number(activeSeg.segment_idx) : null);
  }, [activeSeg?.segment_idx]);

  return (
    <div className="gcw-panel overflow-hidden flex flex-col shrink-0">
      {/* 固定内嵌 WebContentsView 宿主容器 */}
      <div
        ref={hostRef}
        style={{ height: maximized ? 'calc(100vh - 180px)' : `${heightPx}px` }}
        className="w-full bg-[#060a13] relative flex items-center justify-center"
      >
        {!activeVideo?.url ? (
          <div className="text-slate-500 gcw-text-base flex flex-col items-center gap-2">
            <Play className="w-8 h-8 text-cyan-500/40" />
            <span>当前选题暂无关联参考视频，请在「关键词搜爆款」收录视频或切换其他选题</span>
          </div>
        ) : overlayHidden ? (
          <div className="text-slate-400 gcw-text-tag">弹窗打开中，已临时隐藏原生视频视图以防遮挡</div>
        ) : !playerBrowser ? (
          <div className="text-slate-400 gcw-text-base">请在桌面版 Electron 中观看内嵌视频</div>
        ) : null}
      </div>

      {/* 实时双语字幕影院条（无位置切换按钮，保留双语/仅中文/仅原文/关闭 + 最大化） */}
      {subMode !== 'off' && (
        <div className="bg-[#090f1d] border-t border-[#1e2e4a] px-4 py-2 min-h-[58px] flex flex-col items-center justify-center text-center">
          {playback.isAd ? (
            <div className="gcw-text-tag text-amber-300">广告播放中，正片开始后自动同步双语字幕</div>
          ) : activeSeg ? (
            <>
              {(subMode === 'bilingual' || subMode === 'zh') && activeSeg.translated_text && (
                <div className="gcw-video-title text-white leading-snug">{activeSeg.translated_text}</div>
              )}
              {(subMode === 'bilingual' || subMode === 'original') && activeSeg.text && (
                <div className="gcw-text-tag text-slate-300 leading-snug mt-0.5">{activeSeg.text}</div>
              )}
            </>
          ) : (
            <div className="gcw-text-tag text-slate-500">
              {subLoading || subTranslating
                ? subProgressMsg || '正在加载/翻译字幕...'
                : subError || subProgressMsg || '播放视频后将按真实时间轴实时同步双语字幕'}
            </div>
          )}
        </div>
      )}

      {/* 精简字幕控制条 */}
      <div className="bg-[#0d1526] border-t border-[#1e2e4a] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {(
            [
              ['bilingual', '双语'],
              ['zh', '仅中文'],
              ['original', '仅原文'],
              ['off', '关闭字幕'],
            ] as [SubtitleMode, string][]
          ).map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              onClick={() => setSubMode(k)}
              className={`px-2 py-0.5 rounded gcw-text-tag transition ${
                subMode === k ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {lbl}
            </button>
          ))}
          {(subLoading || subTranslating) && <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400 ml-1" />}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('gcw:open-translation-settings'))}
            className="gcw-btn-ghost px-2 py-0.5 rounded gcw-text-tag inline-flex items-center gap-1"
          >
            <Settings className="w-3.5 h-3.5" /> 翻译配置
          </button>
          <button
            type="button"
            onClick={onToggleMaximize}
            className="gcw-btn-ghost px-2 py-0.5 rounded gcw-text-tag inline-flex items-center gap-1"
            title={maximized ? '恢复工作区布局' : '工作台内最大化视频'}
          >
            {maximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            {maximized ? '恢复' : '最大化'}
          </button>
        </div>
      </div>
    </div>
  );
}
