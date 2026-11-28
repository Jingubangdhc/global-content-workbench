/**
 * GCW-WORKSPACE-04 · 参考文案与视频时间轴联动面板
 * - 复用现有 TranscriptStudio / 字幕提取 / 本地混元翻译与逐段缓存，绝不新建第二套提取系统
 * - 支持：自动加载缓存、提取原始文案、本地转写、原文/中文全文/中英双语对照、重新提取、重新翻译、人工修订、一键复制、导出
 * - 视频播放时高亮当前字幕段落、自动滚动（可关闭）、点击时间戳调用真实播放器 seekVideo 跳转
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Edit3,
  Languages,
  Loader2,
  RefreshCw,
  ScrollText,
  Sparkles,
} from 'lucide-react';
import { api } from '../../api';

export type RefViewMode = 'bilingual' | 'original' | 'zh';

interface Props {
  contentId: number | null;
  videoTitle?: string;
  subData: any | null;
  onSubDataChange: (next: any | null) => void;
  activeSegmentIdx: number | null;
  onSeekToSeconds: (sec: number) => Promise<void> | void;
  seekWarning?: string;
}

function fmtTs(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export default function ReferenceTranscriptPane({
  contentId,
  videoTitle = '',
  subData,
  onSubDataChange,
  activeSegmentIdx,
  onSeekToSeconds,
  seekWarning = '',
}: Props) {
  const [viewMode, setViewMode] = useState<RefViewMode>('bilingual');
  const [autoScroll, setAutoScroll] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // 人工修订某一段译文
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const reqSeqRef = useRef(0);
  const activeContentIdRef = useRef<number | null>(contentId);
  activeContentIdRef.current = contentId;

  // FIX-04: 切换作品时立即清理所有旧异步任务与编辑态，防止旧状态残留
  useEffect(() => {
    reqSeqRef.current += 1;
    setExtracting(false);
    setTranslating(false);
    setSavingEdit(false);
    setEditingIdx(null);
    setEditingText('');
    setErrMsg('');
    setStatusMsg('');
  }, [contentId]);

  // 自动滚动至当前高亮段落
  useEffect(() => {
    if (!autoScroll || activeSegmentIdx == null || !activeRowRef.current) return;
    activeRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeSegmentIdx, autoScroll]);

  const segments: any[] = useMemo(() => {
    const raw = subData?.segments || [];
    return [...raw].sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
  }, [subData?.segments]);

  const handleExtract = async (force = false) => {
    if (!contentId || extracting) return;
    const seq = ++reqSeqRef.current;
    setExtracting(true);
    setErrMsg('');
    setStatusMsg(force ? '正在重新提取原始字幕/本地转写...' : '正在提取原始字幕/本地转写...');
    try {
      const ex = await api.extractTranscript(contentId);
      if (seq !== reqSeqRef.current) return;
      if (!ex?.ok) {
        // 提取失败绝不覆盖已有文案
        setErrMsg(ex?.error || '提取失败，已保留原有文案');
        setStatusMsg('');
        return;
      }
      const fresh = await api.translationGetSubtitles(contentId, 'zh-CN');
      if (seq !== reqSeqRef.current) return;
      onSubDataChange(fresh);
      setStatusMsg(`已提取 ${fresh?.total_count || 0} 段字幕`);
    } catch (e: any) {
      if (seq !== reqSeqRef.current) return;
      setErrMsg(`提取失败（已保留原有文案）：${e?.message || e}`);
      setStatusMsg('');
    } finally {
      if (seq === reqSeqRef.current) setExtracting(false);
    }
  };

  const handleTranslate = async (force = false) => {
    if (!contentId || translating) return;
    const seq = ++reqSeqRef.current;
    setTranslating(true);
    setErrMsg('');
    setStatusMsg(force ? '正在重新翻译全部字幕...' : '正在使用当前默认引擎翻译...');
    try {
      const res = await api.translationTranslateSubtitles(contentId, { target_lang: 'zh-CN', force });
      if (seq !== reqSeqRef.current) return;
      onSubDataChange(res);
      setStatusMsg(res?.message || `翻译完成（${res?.translated_count || 0}/${res?.total_count || 0} 段）`);
    } catch (e: any) {
      if (seq !== reqSeqRef.current) return;
      setErrMsg(`翻译失败（已保留原有译文）：${e?.message || e}`);
      setStatusMsg('');
    } finally {
      if (seq === reqSeqRef.current) setTranslating(false);
    }
  };

  const handleSaveManualEdit = async (segIdx: number) => {
    if (!contentId || savingEdit) return;
    const targetCid = contentId;
    const seq = ++reqSeqRef.current;
    setSavingEdit(true);
    setErrMsg('');
    try {
      const res = await api.translationUpdateSegment(targetCid, segIdx, {
        target_lang: 'zh-CN',
        translated_text: editingText,
      });
      if (seq !== reqSeqRef.current || activeContentIdRef.current !== targetCid) return;
      if (res?.ok) {
        const fresh = await api.translationGetSubtitles(targetCid, 'zh-CN');
        if (seq !== reqSeqRef.current || activeContentIdRef.current !== targetCid) return;
        onSubDataChange(fresh);
        setEditingIdx(null);
        setStatusMsg(`已保存第 #${segIdx + 1} 段人工修订译文`);
      } else {
        setErrMsg(res?.error || '保存人工修订失败');
      }
    } catch (e: any) {
      if (seq !== reqSeqRef.current || activeContentIdRef.current !== targetCid) return;
      setErrMsg(`保存人工修订失败：${e?.message || e}`);
    } finally {
      if (seq === reqSeqRef.current && activeContentIdRef.current === targetCid) setSavingEdit(false);
    }
  };

  const buildPlainExport = () => {
    if (!segments.length) return '';
    return segments
      .map((s) => {
        const ts = `[${fmtTs(s.start)}]`;
        if (viewMode === 'original') return `${ts} ${s.text || ''}`;
        if (viewMode === 'zh') return `${ts} ${s.translated_text || s.text || ''}`;
        return `${ts} ${s.text || ''}\n${s.translated_text ? `    ${s.translated_text}` : ''}`.trimEnd();
      })
      .join('\n');
  };

  const handleCopy = async () => {
    const txt = buildPlainExport();
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setErrMsg('复制到剪贴板失败');
    }
  };

  const handleExportTxt = () => {
    const txt = buildPlainExport();
    if (!txt) return;
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reference_transcript_${contentId || 'video'}_${viewMode}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="gcw-panel flex flex-col h-full min-h-0 overflow-hidden">
      {/* 顶部工具条 */}
      <div className="gcw-panel-header px-3 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <ScrollText className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="gcw-section-title text-slate-100 truncate">参考文案</span>
          <span className="gcw-text-tag text-slate-400 font-mono-num">
            {segments.length ? `${segments.length} 段` : '暂无字幕'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* 视图切换：双语 / 原文 / 中文 */}
          <div className="flex rounded-lg overflow-hidden border border-[#2c4268] bg-[#0c1424]">
            {(
              [
                ['bilingual', '双语'],
                ['original', '原文'],
                ['zh', '中文'],
              ] as [RefViewMode, string][]
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setViewMode(k)}
                className={`px-2 py-0.5 gcw-text-tag font-medium transition ${
                  viewMode === k ? 'bg-cyan-500/25 text-cyan-200' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAutoScroll((v) => !v)}
            className={`px-2 py-0.5 rounded-lg gcw-text-tag border transition ${
              autoScroll
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-[#0c1424] border-[#2c4268] text-slate-400'
            }`}
            title="视频播放时是否自动滚动到当前字幕段落"
          >
            自动滚动:{autoScroll ? '开' : '关'}
          </button>

          <button
            type="button"
            onClick={() => handleExtract(segments.length > 0)}
            disabled={!contentId || extracting}
            className="gcw-btn-ghost px-2 py-0.5 rounded-lg gcw-text-tag inline-flex items-center gap-1 disabled:opacity-40"
            title={segments.length ? '重新提取原始字幕/本地转写' : '提取原始字幕/本地转写'}
          >
            {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {segments.length ? '重提' : '提取文案'}
          </button>

          <button
            type="button"
            onClick={() => handleTranslate(Boolean(subData?.translated_count))}
            disabled={!contentId || !segments.length || translating}
            className="gcw-btn-ghost px-2 py-0.5 rounded-lg gcw-text-tag inline-flex items-center gap-1 disabled:opacity-40"
            title="使用默认翻译引擎翻译/重新翻译"
          >
            {translating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
            {subData?.translated_count ? '重译' : '翻译'}
          </button>

          <button
            type="button"
            onClick={handleCopy}
            disabled={!segments.length}
            className="gcw-btn-ghost px-2 py-0.5 rounded-lg gcw-text-tag inline-flex items-center gap-1 disabled:opacity-40"
            title="一键复制当前视图文案"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? '已复制' : '复制'}
          </button>

          <button
            type="button"
            onClick={handleExportTxt}
            disabled={!segments.length}
            className="gcw-btn-ghost px-2 py-0.5 rounded-lg gcw-text-tag inline-flex items-center gap-1 disabled:opacity-40"
            title="导出参考文案 TXT"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 状态与错误提示条 */}
      {(statusMsg || errMsg || seekWarning) && (
        <div className="px-3 py-1.5 border-b border-[#1e2e4a] space-y-1 shrink-0 bg-[#0d1526]">
          {statusMsg && <div className="gcw-text-tag text-cyan-300">{statusMsg}</div>}
          {seekWarning && <div className="gcw-text-tag text-amber-300">{seekWarning}</div>}
          {errMsg && <div className="gcw-text-tag text-rose-300">{errMsg}</div>}
        </div>
      )}

      {/* 字幕段落列表 */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {!contentId ? (
          <div className="h-full flex items-center justify-center text-slate-500 gcw-text-base">
            请先在上方选择一个参考视频作品
          </div>
        ) : !segments.length ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-slate-400 text-center px-4">
            <Sparkles className="w-6 h-6 text-cyan-400/70" />
            <div className="gcw-text-base">当前作品（{videoTitle || `#${contentId}`}）尚未提取原始文案</div>
            <button
              type="button"
              onClick={() => handleExtract(false)}
              disabled={extracting}
              className="gcw-btn-cyan px-4 py-1.5 rounded-lg gcw-text-btn font-semibold inline-flex items-center gap-1.5"
            >
              {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {extracting ? '正在提取...' : '立即提取原始文案 / 本地转写'}
            </button>
          </div>
        ) : (
          segments.map((seg, i) => {
            const segIdx = Number(seg.segment_idx ?? i);
            const isActive = activeSegmentIdx === segIdx;
            const isEditing = editingIdx === segIdx;
            return (
              <div
                key={`${segIdx}_${seg.start}`}
                ref={isActive ? activeRowRef : undefined}
                className={`rounded-lg px-3 py-2 border transition ${
                  isActive
                    ? 'bg-cyan-500/15 border-cyan-400/60 shadow-sm'
                    : 'bg-[#0c1424] border-[#1e2e4a] hover:border-[#2c4268]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSeekToSeconds(Number(seg.start || 0))}
                    className="px-1.5 py-0.5 rounded bg-slate-800/90 hover:bg-cyan-600/40 text-cyan-300 gcw-text-meta font-mono-num shrink-0 transition"
                    title="点击跳转到视频对应时间点"
                  >
                    {fmtTs(seg.start)}
                  </button>

                  <div
                    onClick={() => {
                      if (isEditing) return;
                      const sel = window.getSelection?.()?.toString()?.trim();
                      if (sel) return; // FIX-05: 选中复制文字时不误触视频跳转
                      onSeekToSeconds(Number(seg.start || 0));
                    }}
                    className={`flex-1 min-w-0 space-y-1 ${isEditing ? '' : 'cursor-pointer'}`}
                    title={isEditing ? undefined : '点击整句跳转至对应视频时间（选中文字复制不会误触）'}
                  >
                    {(viewMode === 'bilingual' || viewMode === 'original') && (
                      <div className="gcw-text-base text-slate-100 leading-relaxed break-words">
                        {seg.text}
                      </div>
                    )}
                    {(viewMode === 'bilingual' || viewMode === 'zh') && (
                      isEditing ? (
                        <div className="space-y-1.5 pt-1">
                          <textarea
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            rows={2}
                            className="gcw-input w-full px-2 py-1 gcw-text-base"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleSaveManualEdit(segIdx)}
                              disabled={savingEdit}
                              className="gcw-btn-cyan px-2.5 py-0.5 rounded gcw-text-tag font-semibold"
                            >
                              {savingEdit ? '保存中...' : '保存修订'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingIdx(null)}
                              className="gcw-btn-ghost px-2.5 py-0.5 rounded gcw-text-tag"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="gcw-text-base text-cyan-200/95 leading-relaxed break-words">
                          {seg.translated_text || (viewMode === 'zh' ? seg.text : '')}
                        </div>
                      )
                    )}
                  </div>

                  {!isEditing && (viewMode === 'bilingual' || viewMode === 'zh') && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingIdx(segIdx);
                        setEditingText(seg.translated_text || '');
                      }}
                      className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-cyan-300 shrink-0"
                      title="人工修订此段译文"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
