import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Flame,
  Image,
  Languages,
  Loader2,
  MessageSquare,
  Package,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { api, fmtDur } from '../api';
import type { ContentItem, ScriptTemplate } from '../api';

interface Props {
  activeContentId: number | null;
  onSelectContent: (id: number) => void;
  templates: ScriptTemplate[];
}

/** 页面③：文案提取工坊 + 四合一深度面板（二创脚本 / 热力高光与强锚定拆解 / 合规真实素材与授权台账 / 高赞评论痛点） */
export default function TranscriptStudio({ activeContentId, onSelectContent, templates }: Props) {
  const [list, setList] = useState<ContentItem[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [rightTab, setRightTab] = useState<'draft' | 'analysis' | 'assets' | 'comments'>('draft');

  // 左栏原文与二创状态
  const [rawText, setRawText] = useState('');
  const [translated, setTranslated] = useState('');
  const [hookAnalysis, setHookAnalysis] = useState('');
  const [tplType, setTplType] = useState('');
  const [draft, setDraft] = useState('');

  // 优化①：热力高光 + 强锚定拆解 + 金句库
  const [heatmap, setHeatmap] = useState<any[]>([]);
  const [breakdown, setBreakdown] = useState<any>(null);
  const [quotes, setQuotes] = useState<any[]>([]);

  // 优化②：真实素材搜索 + 授权台账
  const [assetQ, setAssetQ] = useState('');
  const [assetResults, setAssetResults] = useState<any[]>([]);
  const [savedAssets, setSavedAssets] = useState<any[]>([]);
  const [assetLoading, setAssetLoading] = useState(false);

  // 优化③：高赞评论与高频词
  const [comments, setComments] = useState<any[]>([]);
  const [topKw, setTopKw] = useState<any[]>([]);
  const [onlyQ, setOnlyQ] = useState(false);

  const [extracting, setExtracting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const loadList = async () => {
    const cs = await api.listContents({});
    setList(cs);
    if (!activeContentId && cs.length > 0) {
      onSelectContent(cs[0].id);
    }
  };

  const loadQuotes = () => api.listQuotes().then(setQuotes).catch(() => {});

  useEffect(() => {
    loadList();
    loadQuotes();
  }, []);

  useEffect(() => {
    if (!activeContentId) return;
    api.getTranscript(activeContentId).then((res) => {
      setDetail(res);
      const t = res.transcript || {};
      setRawText(t.raw_text || '');
      setTranslated(t.translated_zh || '');
      setHookAnalysis(t.hook_analysis || '');
      setTplType(t.script_template_type || '');
      setDraft(t.my_draft_text || '');
      try {
        setHeatmap(t.heatmap_json ? JSON.parse(t.heatmap_json) : []);
      } catch {
        setHeatmap([]);
      }
      try {
        setBreakdown(t.breakdown_json ? JSON.parse(t.breakdown_json) : null);
      } catch {
        setBreakdown(null);
      }
      setMsg(t.extract_error ? `⚠️ 上次提取提示：${t.extract_error}` : '');
    });
    api.listSavedAssets(activeContentId).then(setSavedAssets).catch(() => setSavedAssets([]));
    api.listComments(activeContentId, onlyQ).then((r) => {
      setComments(r.comments || []);
      setTopKw(r.top_keywords || []);
    });
  }, [activeContentId]);

  useEffect(() => {
    if (!activeContentId) return;
    api.listComments(activeContentId, onlyQ).then((r) => {
      setComments(r.comments || []);
      setTopKw(r.top_keywords || []);
    });
  }, [onlyQ]);

  const runExtract = async () => {
    if (!activeContentId) return;
    setExtracting(true);
    setMsg('⏳ 正在执行五级提取流水线...');
    try {
      const r = await api.extractTranscript(activeContentId);
      setRawText(r.transcript?.raw_text || '');
      setMsg(r.ok ? `✅ 提取成功（方式：${r.transcript?.extract_method}）` : `⚠️ ${r.error}`);
      loadList();
    } catch (e: any) {
      setMsg('❌ 提取异常：' + e.message);
    } finally {
      setExtracting(false);
    }
  };

  const handleUploadAudio = async (file?: File) => {
    if (!file || !activeContentId) return;
    setExtracting(true);
    setMsg('⏳ 正在用本机显卡语音引擎转写上传文件...');
    try {
      const r = await api.uploadAudioTranscribe(activeContentId, file);
      setRawText(r.transcript?.raw_text || '');
      setMsg(`✅ 本地文件转写完成（${r.transcript?.extract_method}）`);
      loadList();
    } catch (e: any) {
      setMsg('❌ 转写失败：' + e.message);
    } finally {
      setExtracting(false);
    }
  };

  const runTranslate = async () => {
    if (!activeContentId) return;
    setTranslating(true);
    setMsg('⏳ 正在按次调用兼容大模型翻译原文...');
    try {
      await api.saveTranscript(activeContentId, { raw_text: rawText });
      const r = await api.translateTranscript(activeContentId);
      setTranslated(r.translated_text || '');
      setMsg(`✅ 翻译完成（模型：${r.model}，Token：${r.total_tokens || '—'}）`);
    } catch (e: any) {
      setMsg('❌ ' + e.message);
    } finally {
      setTranslating(false);
    }
  };

  const saveAll = async () => {
    if (!activeContentId) return;
    setSaving(true);
    try {
      await api.saveTranscript(activeContentId, {
        raw_text: rawText,
        hook_analysis: hookAnalysis,
        script_template_type: tplType,
        my_draft_text: draft,
        translated_zh: translated,
      });
      setMsg('✅ 已保存到本地数据库');
      loadList();
    } finally {
      setSaving(false);
    }
  };

  const runHeatmap = async () => {
    if (!activeContentId) return;
    setAnalyzing(true);
    setMsg('⏳ 正在 0-Token 读取 YouTube 最多重播热力图...');
    try {
      const r = await api.fetchHeatmap(activeContentId);
      setHeatmap(r.highlights || []);
      setMsg(r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`);
    } catch (e: any) {
      setMsg('❌ ' + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const runTranslateHeatmap = async () => {
    if (!activeContentId) return;
    setTranslating(true);
    setMsg('⏳ 正在多语言批量翻译热力高光（自动识别英/俄/西/法等语种）...');
    try {
      const r = await api.translateHeatmap(activeContentId);
      setHeatmap(r.highlights || []);
      setMsg(`✅ 热力高光多语翻译完成（模型：${r.model}，Token：${r.total_tokens || '—'}，已自动缓存）`);
    } catch (e: any) {
      setMsg('❌ ' + e.message);
    } finally {
      setTranslating(false);
    }
  };

  const runTranslateComments = async () => {
    if (!activeContentId) return;
    setTranslating(true);
    setMsg('⏳ 正在多语言批量翻译前 30 条高赞评论...');
    try {
      const r = await api.translateComments(activeContentId);
      setComments(r.comments || []);
      setMsg(
        r.message ||
          `✅ 已批量翻译 ${r.translated_count} 条评论（模型：${r.model}，Token：${r.total_tokens || '—'}，已缓存）`
      );
    } catch (e: any) {
      setMsg('❌ ' + e.message);
    } finally {
      setTranslating(false);
    }
  };

  const runBreakdown = async () => {
    if (!activeContentId) return;
    setAnalyzing(true);
    setMsg('⏳ 正在按次调用大模型做强锚定爆款拆解（并自动程序校验每条引用）...');
    try {
      await api.saveTranscript(activeContentId, { raw_text: rawText });
      const r = await api.runBreakdown(activeContentId);
      setBreakdown(r.breakdown);
      setMsg(`✅ 拆解完成（模型：${r.breakdown?._meta?.model}，Token：${r.breakdown?._meta?.total_tokens || '—'}）`);
    } catch (e: any) {
      setMsg('❌ ' + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const saveQuote = async (text: string, category: string, ts?: number) => {
    await api.addQuote({
      content_id: activeContentId,
      quote_text: text,
      category,
      timestamp_sec: ts,
      source_url: detail?.content?.url || '',
    });
    loadQuotes();
    setMsg('✅ 已存入个人金句库');
  };

  const doSearchAssets = async () => {
    if (!assetQ.trim()) return;
    setAssetLoading(true);
    try {
      const r = await api.searchAssets(assetQ.trim(), 'all');
      setAssetResults(r.items || []);
      if (r.count === 0) setMsg('未搜到候选素材，建议换英文关键词重试（Wikimedia 免 Key 英文词最准）');
    } finally {
      setAssetLoading(false);
    }
  };

  const doSaveAsset = async (item: any) => {
    if (!activeContentId) return;
    await api.saveAsset({ content_id: activeContentId, ...item, segment_note: assetQ });
    setSavedAssets(await api.listSavedAssets(activeContentId));
    setMsg(`✅ 已记入本稿件「合规授权台账」：${item.source}`);
  };

  const doFetchComments = async () => {
    if (!activeContentId) return;
    setAnalyzing(true);
    setMsg('⏳ 正在拉取视频前 50 条高赞评论并统计 0-Token 高频词...');
    try {
      const r = await api.fetchComments(activeContentId);
      setComments(r.comments || []);
      setTopKw(r.top_keywords || []);
      setMsg(`✅ 已拉取 ${r.fetched} 条高赞评论`);
    } catch (e: any) {
      setMsg('❌ ' + e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const insertTemplate = (typeName: string) => {
    setTplType(typeName);
    const t = templates.find((x) => x.template_type === typeName);
    if (!t) return;
    const skeleton = `【结构类型】${t.template_type}\n【开头钩子思路】${t.hook_strategy}\n【参考 Hook】${t.sample_hook}\n【主体推进】${t.structure_desc}\n【画面与证据】${t.visual_evidence}\n【收尾金句】${t.ending_idea}\n【行动引导】${t.cta}\n【合规防范】${t.precaution}\n\n--- 我的原创口播正文 ---\n`;
    setDraft((prev) => (prev.trim() ? `${prev}\n\n${skeleton}` : skeleton));
  };

  return (
    <div className="flex h-full gap-3 overflow-hidden">
      {/* 左侧素材切换列表 */}
      <div className="w-60 shrink-0 bg-[#0b1120] border border-slate-800/90 rounded-xl flex flex-col overflow-hidden">
        <div className="p-3 border-b border-slate-800 bg-[#0f172a] text-xs font-bold text-slate-200">
          已收录素材 ({list.length})
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60">
          {list.map((c) => (
            <div
              key={c.id}
              onClick={() => onSelectContent(c.id)}
              className={`p-2.5 cursor-pointer transition ${
                activeContentId === c.id ? 'bg-cyan-500/15 border-l-2 border-cyan-400' : 'hover:bg-slate-900/70'
              }`}
            >
              <div className="text-xs text-slate-200 line-clamp-2 leading-snug">{c.title}</div>
              <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
                <span className="uppercase font-mono-num">{c.platform}</span>
                <span className={c.has_transcript ? 'text-emerald-400' : 'text-slate-500'}>
                  {c.has_transcript ? '已提取' : '待提取'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧主工坊 */}
      <div className="flex-1 flex flex-col gap-3 min-w-0 overflow-hidden">
        {!detail ? (
          <div className="flex-1 bg-[#0b1120] border border-slate-800 rounded-xl flex items-center justify-center text-xs text-slate-500">
            请先从左侧选择一条已收录视频/文章，或前往「关键词搜爆款 / 爆款博主追踪」点「提文案」。
          </div>
        ) : (
          <>
            {/* 顶部操作条 */}
            <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="min-w-0 flex-1">
                  <a
                    href={detail.content.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-bold text-slate-100 hover:text-cyan-300 flex items-center gap-1.5"
                  >
                    <span className="truncate">{detail.content.title}</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    平台：{detail.content.platform} · 作者：{detail.content.creator_name || '未知'}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                  <button
                    onClick={runExtract}
                    disabled={extracting}
                    className="px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1"
                  >
                    {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    一键提文案
                  </button>
                  <label className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs border border-slate-700 cursor-pointer flex items-center gap-1">
                    <Upload className="w-3.5 h-3.5" />
                    本地转写
                    <input type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => handleUploadAudio(e.target.files?.[0])} />
                  </label>
                  <button
                    onClick={runTranslate}
                    disabled={translating || !rawText.trim()}
                    className="px-2.5 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/40 text-xs flex items-center gap-1"
                  >
                    {translating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                    翻译
                  </button>
                  <button
                    onClick={saveAll}
                    disabled={saving}
                    className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" />保存
                  </button>
                  <a href={`/api/export/content/${activeContentId}?fmt=md`} className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs">
                    <Download className="w-3 h-3 inline mr-0.5" />MD
                  </a>
                  <a href={`/api/export/content/${activeContentId}?fmt=docx`} className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs">
                    <Download className="w-3 h-3 inline mr-0.5" />Word
                  </a>
                  <a
                    href={`/api/export/handoff/${activeContentId}`}
                    className="px-2 py-1.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs flex items-center gap-1"
                    title="导出结构化交接包 JSON（含脚本、合规素材台账、观众痛点），可直接交给下游 Remotion + Skills 工作区出视频"
                  >
                    <Package className="w-3 h-3" />视频交接包
                  </a>
                </div>
              </div>
              {msg && <div className="text-xs text-amber-300">{msg}</div>}
            </div>

            {/* 左右双栏 */}
            <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
              {/* 左栏（5列）：原文与译文 */}
              <div className="col-span-5 bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    原始口播 / 正文
                  </span>
                  <button onClick={() => navigator.clipboard.writeText(rawText)} className="text-slate-400 hover:text-cyan-300 flex items-center gap-1">
                    <Copy className="w-3 h-3" />复制
                  </button>
                </div>
                <textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  placeholder="点击上方「一键提文案」，或在此粘贴原文..."
                  className="flex-1 bg-transparent p-3 text-xs text-slate-200 leading-relaxed resize-none focus:outline-none"
                />
                {translated && (
                  <div className="h-2/5 border-t border-slate-800 flex flex-col bg-slate-950/60">
                    <div className="px-3 py-1.5 text-[11px] font-semibold text-indigo-300 border-b border-slate-800/80 flex justify-between">
                      <span>中文译文参考</span>
                      <button onClick={() => navigator.clipboard.writeText(translated)} className="text-slate-400 hover:text-white">复制译文</button>
                    </div>
                    <textarea
                      value={translated}
                      onChange={(e) => setTranslated(e.target.value)}
                      className="flex-1 bg-transparent p-3 text-xs text-slate-300 leading-relaxed resize-none focus:outline-none"
                    />
                  </div>
                )}
              </div>

              {/* 右栏（7列）：四合一深度面板 */}
              <div className="col-span-7 bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
                <div className="px-2 py-1.5 border-b border-slate-800 bg-[#0f172a] flex items-center gap-1 text-xs flex-wrap">
                  {[
                    ['draft', '✍️ 二创脚本'],
                    ['analysis', '🔥 热力高光/拆解/金句'],
                    ['assets', `🎬 真实素材台账 (${savedAssets.length})`],
                    ['comments', `💬 高赞评论痛点 (${comments.length})`],
                  ].map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setRightTab(k as any)}
                      className={`px-2.5 py-1.5 rounded-lg font-medium transition ${
                        rightTab === k
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Tab 1: 二创脚本 */}
                {rightTab === 'draft' && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="p-2.5 border-b border-slate-800/80 flex gap-2">
                      <input
                        value={hookAnalysis}
                        onChange={(e) => setHookAnalysis(e.target.value)}
                        placeholder="前 5 秒钩子 / 核心结构笔记..."
                        className="flex-1 bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-amber-200 focus:outline-none focus:border-cyan-500"
                      />
                      <select
                        value={tplType}
                        onChange={(e) => insertTemplate(e.target.value)}
                        className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200"
                      >
                        <option value="">+ 插入 SOP 脚本骨架</option>
                        {templates.map((t) => (
                          <option key={t.id} value={t.template_type}>{t.template_type}</option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="看着左侧原文，在这里写你自己的原创口播稿..."
                      className="flex-1 bg-transparent p-3 text-xs text-slate-100 leading-relaxed resize-none focus:outline-none"
                    />
                  </div>
                )}

                {/* Tab 2: 优化① 热力高光 + 强锚定爆款拆解 + 个人金句库 */}
                {rightTab === 'analysis' && (
                  <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={runHeatmap}
                        disabled={analyzing}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-medium flex items-center gap-1"
                      >
                        <Flame className="w-3.5 h-3.5" />
                        0-Token 拉取 YouTube 最多重播高光
                      </button>
                      {heatmap.length > 0 && (
                        <button
                          onClick={runTranslateHeatmap}
                          disabled={translating}
                          className="px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/40 text-indigo-300 font-medium flex items-center gap-1"
                        >
                          {translating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                          多语言一键翻译高光
                        </button>
                      )}
                      <button
                        onClick={runBreakdown}
                        disabled={analyzing || !rawText.trim()}
                        className="px-3 py-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/40 text-cyan-300 font-medium flex items-center gap-1"
                      >
                        {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                        按次强锚定爆款拆解 + 提金句
                      </button>
                    </div>

                    {/* 热力高光区 */}
                    {heatmap.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="font-bold text-emerald-300">📈 观众反复重播热力高光（0-Token 客观数据）</div>
                        {heatmap.map((h, i) => (
                          <div key={i} className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="font-mono-num text-cyan-300 font-semibold">
                                #{i + 1} · {fmtDur(Math.floor(h.start_sec))} ~ {fmtDur(Math.floor(h.end_sec))} （重播热度 {(h.heat * 100).toFixed(0)}%）
                                {h.lang ? <span className="ml-2 px-1 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[10px]">{h.lang}→中</span> : null}
                              </span>
                              <button
                                onClick={() => saveQuote(h.snippet_zh ? `${h.snippet_zh}\n（原文：${h.snippet}）` : h.snippet, '热力高光', h.start_sec)}
                                className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-emerald-600 text-slate-200"
                              >
                                + 存金句库
                              </button>
                            </div>
                            <div className="text-slate-300 leading-relaxed">{h.snippet}</div>
                            {h.snippet_zh && (
                              <div className="text-indigo-200 bg-indigo-500/10 border-l-2 border-indigo-400 pl-2.5 py-1 rounded-r leading-relaxed">
                                {h.snippet_zh}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 强锚定 AI 拆解区 */}
                    {breakdown && (
                      <div className="space-y-2.5">
                        <div className="font-bold text-cyan-300">✨ 强锚定结构拆解（程序自动核验原文引用）</div>
                        <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-amber-300">钩子类型：{breakdown.hook_type}</span>
                            <span className={breakdown.hook_verified ? 'text-emerald-400 text-[10px]' : 'text-rose-400 text-[10px]'}>
                              {breakdown.hook_verified ? '✅ 原文核验通过' : '⚠️ 引用未精确匹配'}
                            </span>
                          </div>
                          <div className="text-slate-200 italic">“{breakdown.hook_quote}”</div>
                          {breakdown.hook_quote_zh && <div className="text-indigo-200">译：{breakdown.hook_quote_zh}</div>}
                          <div className="text-slate-400">{breakdown.hook_why}</div>
                        </div>

                        {(breakdown.retention_mechanics || []).map((m: any, idx: number) => (
                          <div key={idx} className="p-2 rounded-lg bg-slate-950/70 border border-slate-800/80 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-slate-200">{m.stage}</span>
                              <span className={m.verified ? 'text-emerald-400 text-[10px]' : 'text-rose-400 text-[10px]'}>
                                {m.verified ? '✅ 核验通过' : '⚠️ 待核'}
                              </span>
                            </div>
                            <div className="text-slate-400">“{m.quote}”</div>
                            {m.quote_zh && <div className="text-indigo-200">译：{m.quote_zh}</div>}
                            <div className="text-cyan-300/90">{m.mechanism}</div>
                          </div>
                        ))}

                        {(breakdown.quotes || []).length > 0 && (
                          <div className="space-y-1.5">
                            <div className="font-bold text-amber-300">💎 抽取高传播金句</div>
                            {breakdown.quotes.map((q: any, idx: number) => (
                              <div key={idx} className="p-2 rounded-lg bg-slate-900/80 border border-slate-800 flex items-start justify-between gap-2">
                                <div>
                                  <div className="text-slate-100">“{q.text}”</div>
                                  {q.text_zh && <div className="text-indigo-200 mt-0.5">译：{q.text_zh}</div>}
                                  <div className="text-[10px] text-slate-400 mt-0.5">
                                    {q.category} · {q.usage} · {q.verified ? '✅核验通过' : '⚠️待核'}
                                  </div>
                                </div>
                                <button
                                  onClick={() => saveQuote(q.text_zh ? `${q.text_zh}\n（原文：${q.text}）` : q.text, q.category)}
                                  className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[10px] shrink-0"
                                >
                                  + 存库
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 个人金句库 */}
                    <div className="border-t border-slate-800 pt-3 space-y-1.5">
                      <div className="font-bold text-slate-200">📚 我的跨赛道金句库 ({quotes.length})</div>
                      {quotes.slice(0, 15).map((q) => (
                        <div key={q.id} className="p-2 rounded bg-slate-950/70 border border-slate-800/70 flex items-start justify-between gap-2">
                          <div>
                            <div className="text-slate-200">“{q.quote_text}”</div>
                            <div className="text-[10px] text-slate-500 mt-0.5">{q.category}</div>
                          </div>
                          <button onClick={() => api.delQuote(q.id).then(loadQuotes)} className="text-slate-600 hover:text-rose-400">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tab 3: 优化② 合规真实素材搜索与授权台账 */}
                {rightTab === 'assets' && (
                  <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
                    <div className="flex gap-2">
                      <input
                        value={assetQ}
                        onChange={(e) => setAssetQ(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && doSearchAssets()}
                        placeholder="输入英文画面词（如 Shanghai hospital / medical bill / doctor）搜合规实拍与史料..."
                        className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-500"
                      />
                      <button
                        onClick={doSearchAssets}
                        disabled={assetLoading}
                        className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium flex items-center gap-1"
                      >
                        {assetLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                        搜合规素材
                      </button>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      默认免 Key 直连 Wikimedia Commons（历史/机构/公共图，原生带 CC 协议）；在左下角设置填入免费 Pexels / Pixabay Key 可同步搜高清视频 B-roll。
                    </div>

                    {assetResults.length > 0 && (
                      <div className="grid grid-cols-2 gap-2">
                        {assetResults.map((it, i) => (
                          <div key={i} className="p-2 rounded-lg bg-slate-900/80 border border-slate-800 flex flex-col justify-between gap-1.5">
                            <div className="flex gap-2">
                              {it.thumb_url ? (
                                <img src={it.thumb_url} alt="" className="w-16 h-12 object-cover rounded border border-slate-800 shrink-0" />
                              ) : (
                                <div className="w-16 h-12 rounded bg-slate-800 flex items-center justify-center shrink-0">
                                  <Image className="w-4 h-4 text-slate-500" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <a href={it.source_page_url || it.asset_url} target="_blank" rel="noopener noreferrer" className="text-slate-100 hover:text-cyan-300 font-medium line-clamp-2">
                                  {it.title}
                                </a>
                                <div className="text-[10px] text-emerald-400 mt-0.5">{it.license} · {it.source}</div>
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-[10px] pt-1 border-t border-slate-800/70">
                              <span className="text-slate-400 truncate max-w-[140px]">{it.commercial_ok}</span>
                              <button
                                onClick={() => doSaveAsset(it)}
                                className="px-2 py-0.5 rounded bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white flex items-center gap-0.5"
                              >
                                <Plus className="w-3 h-3" />入台账
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 本稿件已选授权台账 */}
                    <div className="border-t border-slate-800 pt-3 space-y-1.5">
                      <div className="font-bold text-emerald-300 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        本稿件合规素材授权台账 ({savedAssets.length}) — 导出视频交接包时自动附带
                      </div>
                      {savedAssets.map((a) => (
                        <div key={a.id} className="p-2 rounded bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <a href={a.source_page_url || a.asset_url} target="_blank" rel="noopener noreferrer" className="text-slate-100 hover:text-cyan-300 font-medium truncate block">
                              [{a.source}] {a.title}
                            </a>
                            <div className="text-[10px] text-slate-400">
                              作者：{a.author} · 协议：<span className="text-emerald-400">{a.license}</span> · {a.commercial_ok}
                            </div>
                          </div>
                          <button onClick={() => api.delAsset(a.id).then(() => api.listSavedAssets(activeContentId!).then(setSavedAssets))} className="text-slate-500 hover:text-rose-400">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tab 4: 优化③ 高赞评论与痛点 */}
                {rightTab === 'comments' && (
                  <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={doFetchComments}
                          disabled={analyzing}
                          className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium flex items-center gap-1"
                        >
                          {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
                          0-Token 拉取前 50 条高赞评论
                        </button>
                        {comments.length > 0 && (
                          <button
                            onClick={runTranslateComments}
                            disabled={translating}
                            className="px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/40 text-indigo-300 font-medium flex items-center gap-1"
                          >
                            {translating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                            多语言一键翻译前 30 条
                          </button>
                        )}
                      </div>
                      <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                        <input type="checkbox" checked={onlyQ} onChange={(e) => setOnlyQ(e.target.checked)} />
                        只看用户提问句（找选题痛点）
                      </label>
                    </div>

                    {topKw.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap bg-slate-950/80 border border-slate-800 rounded-lg p-2">
                        <span className="text-[10px] text-slate-400">高频词：</span>
                        {topKw.map((k) => (
                          <span key={k.word} className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono-num text-[10px]">
                            {k.word} ({k.count})
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="divide-y divide-slate-800/70">
                      {comments.map((cm) => (
                        <div key={cm.id} className="py-2 space-y-1">
                          <div className="flex items-center justify-between text-[10px] text-slate-400">
                            <span>
                              {cm.author} · 👍 <span className="font-mono-num text-cyan-300">{cm.like_count}</span>
                              {cm.is_question ? <span className="ml-1.5 px-1 rounded bg-amber-500/20 text-amber-300">提问</span> : null}
                            </span>
                            <button
                              onClick={() =>
                                api.togglePainComment(cm.id, cm.is_pain_point ? 0 : 1).then(() =>
                                  api.listComments(activeContentId!, onlyQ).then((r) => setComments(r.comments || []))
                                )
                              }
                              className={`px-1.5 py-0.5 rounded border ${
                                cm.is_pain_point
                                  ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                                  : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-rose-300'
                              }`}
                            >
                              {cm.is_pain_point ? '🔥 已标痛点' : '标为痛点'}
                            </button>
                          </div>
                          <div className="text-slate-200 leading-relaxed">{cm.text}</div>
                          {cm.translated_zh && (
                            <div className="text-indigo-200 bg-indigo-500/10 border-l-2 border-indigo-400 pl-2 py-0.5 rounded-r leading-relaxed">
                              {cm.translated_zh}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
