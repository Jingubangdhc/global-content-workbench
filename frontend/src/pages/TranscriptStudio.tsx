import { useEffect, useState } from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  Languages,
  Loader2,
  Save,
  Sparkles,
  Upload,
} from 'lucide-react';
import { api } from '../api';
import type { ContentItem, ScriptTemplate } from '../api';

interface Props {
  activeContentId: number | null;
  onSelectContent: (id: number) => void;
  templates: ScriptTemplate[];
}

/** 页面③：五级文案提取工坊（左栏只读存证原文 + 按次手动翻译，右栏 SOP 结构二创改写与导出） */
export default function TranscriptStudio({ activeContentId, onSelectContent, templates }: Props) {
  const [list, setList] = useState<ContentItem[]>([]);
  const [detail, setDetail] = useState<any>(null);

  const [rawText, setRawText] = useState('');
  const [translated, setTranslated] = useState('');
  const [hookAnalysis, setHookAnalysis] = useState('');
  const [tplType, setTplType] = useState('');
  const [draft, setDraft] = useState('');

  const [extracting, setExtracting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const loadList = async () => {
    const cs = await api.listContents({});
    setList(cs);
    if (!activeContentId && cs.length > 0) {
      onSelectContent(cs[0].id);
    }
  };

  useEffect(() => {
    loadList();
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
      setMsg(t.extract_error ? `⚠️ 上次提取提示：${t.extract_error}` : '');
    });
  }, [activeContentId]);

  const runExtract = async () => {
    if (!activeContentId) return;
    setExtracting(true);
    setMsg('⏳ 正在执行五级提取流水线（字幕 → 网页正文 → 音频下载与本地 Whisper 转写）...');
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
    setMsg('⏳ 正在用本机 faster-whisper 转写上传的音视频文件...');
    try {
      const r = await api.uploadAudioTranscribe(activeContentId, file);
      setRawText(r.transcript?.raw_text || '');
      setMsg(`✅ 本地文件转写完成（${r.transcript?.extract_method}），临时文件已自动清理`);
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
    setMsg('⏳ 正在按次调用 .env 中配置的兼容大模型翻译原文...');
    try {
      // 先保存可能手贴的原文
      await api.saveTranscript(activeContentId, { raw_text: rawText });
      const r = await api.translateTranscript(activeContentId);
      setTranslated(r.translated_text || '');
      setMsg(`✅ 翻译完成（模型：${r.model}，消耗 Token：${r.total_tokens || '—'}）`);
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
      <div className="w-64 shrink-0 bg-[#0b1120] border border-slate-800/90 rounded-xl flex flex-col overflow-hidden">
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

      {/* 右侧双栏文案工坊 */}
      <div className="flex-1 flex flex-col gap-3 min-w-0 overflow-hidden">
        {!detail ? (
          <div className="flex-1 bg-[#0b1120] border border-slate-800 rounded-xl flex items-center justify-center text-xs text-slate-500">
            请先从左侧选择一条已收录视频/文章，或前往「关键词搜爆款」点「提文案」。
          </div>
        ) : (
          <>
            {/* 顶部操作条 */}
            <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
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
                    className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1"
                  >
                    {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    一键提取文案
                  </button>
                  <label className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs border border-slate-700 cursor-pointer flex items-center gap-1">
                    <Upload className="w-3.5 h-3.5" />
                    本地音视频转写
                    <input
                      type="file"
                      accept="audio/*,video/*"
                      className="hidden"
                      onChange={(e) => handleUploadAudio(e.target.files?.[0])}
                    />
                  </label>
                  <button
                    onClick={runTranslate}
                    disabled={translating || !rawText.trim()}
                    className="px-2.5 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/40 text-xs flex items-center gap-1"
                    title="仅手动点击才消耗大模型 Token"
                  >
                    {translating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                    翻译成中文
                  </button>
                  <button
                    onClick={saveAll}
                    disabled={saving}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" />
                    保存
                  </button>
                  <a
                    href={`/api/export/content/${activeContentId}?fmt=md`}
                    className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
                  >
                    <Download className="w-3 h-3 inline mr-0.5" />MD
                  </a>
                  <a
                    href={`/api/export/content/${activeContentId}?fmt=docx`}
                    className="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
                  >
                    <Download className="w-3 h-3 inline mr-0.5" />Word
                  </a>
                </div>
              </div>
              {msg && <div className="text-xs text-amber-300">{msg}</div>}
            </div>

            {/* 左右双栏：原文存证 vs 二创改写 */}
            <div className="flex-1 grid grid-cols-2 gap-3 min-h-0">
              {/* 左栏：原文与译文 */}
              <div className="bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    原始口播 / 正文（提取失败也可直接粘贴）
                  </span>
                  <button
                    onClick={() => navigator.clipboard.writeText(rawText)}
                    className="text-slate-400 hover:text-cyan-300 flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" />复制
                  </button>
                </div>
                <textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  placeholder="点击上方「一键提取文案」，或在此粘贴原文..."
                  className="flex-1 bg-transparent p-3 text-xs text-slate-200 leading-relaxed resize-none focus:outline-none"
                />
                {translated && (
                  <div className="h-2/5 border-t border-slate-800 flex flex-col bg-slate-950/60">
                    <div className="px-3 py-1.5 text-[11px] font-semibold text-indigo-300 border-b border-slate-800/80 flex justify-between">
                      <span>中文译文参考</span>
                      <button onClick={() => navigator.clipboard.writeText(translated)} className="text-slate-400 hover:text-white">
                        复制译文
                      </button>
                    </div>
                    <textarea
                      value={translated}
                      onChange={(e) => setTranslated(e.target.value)}
                      className="flex-1 bg-transparent p-3 text-xs text-slate-300 leading-relaxed resize-none focus:outline-none"
                    />
                  </div>
                )}
              </div>

              {/* 右栏：我的二创改写区 */}
              <div className="bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-emerald-300">我的二创脚本工作区</span>
                  <select
                    value={tplType}
                    onChange={(e) => insertTemplate(e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200"
                  >
                    <option value="">+ 一键插入 SOP 脚本骨架</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.template_type}>
                        {t.template_type}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="p-2.5 border-b border-slate-800/80">
                  <input
                    value={hookAnalysis}
                    onChange={(e) => setHookAnalysis(e.target.value)}
                    placeholder="前 5 秒钩子 / 为什么吸引人看下去？（对应 SOP 06 表）"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-amber-200 focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="看着左侧原文，在这里写你自己的原创口播稿（点击右上角「保存」或导出 MD / Word）..."
                  className="flex-1 bg-transparent p-3 text-xs text-slate-100 leading-relaxed resize-none focus:outline-none"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
