import { useEffect, useState } from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Flame,
  Languages,
  Loader2,
  MessageSquare,
  Package,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api, fmtDur } from '../api';
import type { ContentItem } from '../api';

interface Props {
  projectId: number;
  activeContentId: number | null;
  autoExtractToken?: number;
  onSelectContent: (id: number) => void;
}

/** 页面③：文案提取工坊 + 三合一深度面板（原创文案 Skill 工坊 / 热力高光与强锚定拆解 / 高赞评论痛点） */
export default function TranscriptStudio({ projectId, activeContentId, autoExtractToken = 0, onSelectContent }: Props) {
  const [list, setList] = useState<ContentItem[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [rightTab, setRightTab] = useState<'draft' | 'analysis' | 'comments'>('draft');

  // 左栏原文、源语言、真实时间轴与逐段双语译文状态（已彻底移除 60s 模拟播放器）
  const [rawText, setRawText] = useState('');
  const [sourceLang, setSourceLang] = useState('');
  const [subInfo, setSubInfo] = useState<any>(null);
  const [leftView, setLeftView] = useState<'bilingual' | 'fulltext'>('bilingual');
  const [editingSegIdx, setEditingSegIdx] = useState<number | null>(null);
  const [editingSegZh, setEditingSegZh] = useState('');
  const [savingSeg, setSavingSeg] = useState(false);
  const [extractProgress, setExtractProgress] = useState('');
  const [translated, setTranslated] = useState('');
  const [hookAnalysis, setHookAnalysis] = useState('');
  const [draft, setDraft] = useState('');

  // GCW-UAT-R4-D：原创文案 Skill + 多模型切换 + 多参考文案 + 关联选题 + 独立原创版本历史
  const [skills, setSkills] = useState<any[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string>('fact_separated_deep_dive');
  const [writingModels, setWritingModels] = useState<any[]>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<string>('');
  const [selectedRefIds, setSelectedRefIds] = useState<number[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string>('');
  const [extraRequirements, setExtraRequirements] = useState<string>('');
  const [originalTitle, setOriginalTitle] = useState<string>('');
  const [originalVersions, setOriginalVersions] = useState<any[]>([]);
  const [activeVersionId, setActiveVersionId] = useState<number | null>(null);
  const [generatingOriginal, setGeneratingOriginal] = useState(false);

  // 导入 / 新建自定义 Skill 弹窗
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDesc, setNewSkillDesc] = useState('');
  const [newSkillPrompt, setNewSkillPrompt] = useState('');
  const [newSkillFormat, setNewSkillFormat] = useState('manual');
  const [savingSkill, setSavingSkill] = useState(false);

  // 优化①：热力高光 + 强锚定拆解 + 金句库
  const [heatmap, setHeatmap] = useState<any[]>([]);
  const [breakdown, setBreakdown] = useState<any>(null);
  const [quotes, setQuotes] = useState<any[]>([]);

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
    const cs = await api.listContents({ only_transcript_collected: 'true' } as any);
    setList(cs);
    if (!activeContentId && cs.length > 0) {
      onSelectContent(cs[0].id);
    }
  };

  const loadQuotes = () => api.listQuotes().then(setQuotes).catch(() => {});

  const loadSkillsAndModels = async () => {
    try {
      const [skRes, mRes] = await Promise.all([api.topicHubScriptSkills(), api.listWritingModels()]);
      const skList = skRes?.skills || [];
      setSkills(skList);
      if (skList.length > 0 && !skList.some((s: any) => s.skill_id === selectedSkillId)) {
        setSelectedSkillId(skList[0].skill_id);
      }
      const mList = mRes?.models || [];
      setWritingModels(mList);
      if (!selectedEngineId) {
        const firstReady = mList.find((m: any) => m.configured);
        if (firstReady) setSelectedEngineId(firstReady.engine_id);
      }
    } catch {
      // 忽略首次加载瞬态异常
    }
  };

  const loadOriginalVersions = async (cid?: number | null) => {
    try {
      const res = await api.listStudioOriginalVersions(projectId, cid ?? activeContentId ?? undefined);
      setOriginalVersions(res?.versions || []);
    } catch {
      setOriginalVersions([]);
    }
  };

  useEffect(() => {
    loadList();
    loadQuotes();
    loadSkillsAndModels();
  }, []);

  useEffect(() => {
    api.topicHubList({ project_id: projectId, limit: 60 })
      .then((r) => setTopics(r?.items || []))
      .catch(() => setTopics([]));
    loadOriginalVersions(activeContentId);
  }, [projectId]);

  const loadSubtitles = async (cid: number) => {
    try {
      const s = await api.translationGetSubtitles(cid, 'zh-CN');
      setSubInfo(s);
      if (s?.translated_zh) setTranslated(s.translated_zh);
      if (s?.language) setSourceLang(s.language);
      return s;
    } catch {
      setSubInfo(null);
      return null;
    }
  };

  useEffect(() => {
    if (!activeContentId) return;
    let cancelled = false;
    setEditingSegIdx(null);
    api.getTranscript(activeContentId).then(async (res) => {
      if (cancelled) return;
      setDetail(res);
      const t = res.transcript || {};
      const existingRaw = (t.raw_text || '').trim();
      setRawText(t.raw_text || '');
      setSourceLang(t.language || '');
      setTranslated(t.translated_zh || '');
      setHookAnalysis(t.hook_analysis || '');
      setDraft(t.my_draft_text || '');
      setSelectedRefIds([activeContentId]);
      setActiveVersionId(null);
      setOriginalTitle('');
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

      await loadSubtitles(activeContentId);
      await loadOriginalVersions(activeContentId);

      // GCW-ASSET-02 / GCW-TRANS-01: 从 TopicHub 点击「文案提取」进来时：已有文案直接加载；无文案则自动执行提取闭环
      if (autoExtractToken > 0) {
        if (existingRaw) {
          setMsg(`✅ 已加载现有原始文案（源语言：${t.language || '未识别'} · 方式：${t.extract_method || '历史记录'}，如需刷新可点击「重新提取」）`);
        } else {
          await runExtract(activeContentId);
        }
      } else {
        setMsg(t.extract_error ? `⚠️ 上次提取提示：${t.extract_error}` : '');
      }
    });
    api.listComments(activeContentId, onlyQ).then((r) => {
      setComments(r.comments || []);
      setTopKw(r.top_keywords || []);
    });
    return () => {
      cancelled = true;
    };
  }, [activeContentId, autoExtractToken]);

  useEffect(() => {
    if (!activeContentId) return;
    api.listComments(activeContentId, onlyQ).then((r) => {
      setComments(r.comments || []);
      setTopKw(r.top_keywords || []);
    });
  }, [onlyQ]);

  const runExtract = async (targetId?: number) => {
    const cid = targetId ?? activeContentId;
    if (!cid) return;
    setExtracting(true);
    setExtractProgress('正在人工收录至文案工坊并拉取合法字幕/转写时间轴...');
    setMsg('⏳ 正在执行文案提取流水线（1/3 收录至文案工坊 → 2/3 获取官方字幕/本地转写 → 3/3 识别源语言与时间轴）...');
    try {
      const r = await api.extractTranscript(cid);
      const nextRaw = r.transcript?.raw_text || '';
      if (r.ok && nextRaw) {
        setRawText(nextRaw);
        setSourceLang(r.transcript?.language || '');
        const sub = await loadSubtitles(cid);
        setMsg(`✅ 文案提取成功（方式：${r.transcript?.extract_method || '—'} · 源语言：${r.transcript?.language || '未知'} · ${sub?.total_count || 0} 段）`);
        // 若用户已开启「提取后自动翻译」且已配置默认引擎，自动触发统一翻译
        try {
          const cfg = await api.translationGetConfig();
          if (cfg?.policy?.auto_translate && cfg?.default_engine_id) {
            await runTranslate(false, cid);
          }
        } catch {
          // 忽略自动检查异常
        }
      } else {
        // 严格要求：提取失败绝不覆盖编辑区原有文案，显示真实失败原因
        setMsg(`⚠️ 提取未获取新文案（原有文案已完整保留）：${r.error || '平台未提供可用字幕或访问受限'}`);
      }
      loadList();
    } catch (e: any) {
      setMsg('❌ 提取异常（原有文案已完整保留）：' + e.message);
    } finally {
      setExtracting(false);
      setExtractProgress('');
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

  const runTranslate = async (forceRetranslate = false, targetId?: number) => {
    const cid = targetId ?? activeContentId;
    if (!cid) return;
    setTranslating(true);
    setMsg(
      forceRetranslate
        ? '⏳ 正在重新逐段翻译（自动保留人工修订段落，并同步更新双语字幕）...'
        : '⏳ 正在调用统一翻译引擎分批带上下文翻译（命中缓存将零费用复用）...',
    );
    try {
      await api.saveTranscript(cid, { raw_text: rawText });
      if (subInfo?.total_count > 0) {
        const sub = await api.translationTranslateSubtitles(cid, {
          target_lang: 'zh-CN',
          force_retranslate: forceRetranslate,
        });
        setSubInfo(sub);
        setTranslated(sub.translated_zh || '');
        setMsg(
          `✅ ${sub.message || '翻译完成'}（引擎：${sub.engine_id || '—'} / ${sub.model_id || '—'} · Token：${sub.total_tokens ?? 0}）`,
        );
      } else {
        const r = await api.translateTranscript(cid);
        setTranslated(r.translated_text || '');
        setMsg(`✅ 全文翻译完成（${r.message || r.model || '已完成'}）`);
      }
    } catch (e: any) {
      // 翻译失败严格保留原文与原有译文，明确显示真实失败原因
      setMsg(`❌ 翻译失败（原文已完整保留）：${e.message}`);
    } finally {
      setTranslating(false);
    }
  };

  const handleSaveManualSeg = async (segIdx: number) => {
    if (!activeContentId) return;
    setSavingSeg(true);
    try {
      const updated = await api.translationEditSegment(activeContentId, segIdx, editingSegZh, 'zh-CN');
      setSubInfo(updated);
      setTranslated(updated.translated_zh || '');
      setEditingSegIdx(null);
      setMsg(`✅ 已保存第 #${segIdx + 1} 段人工修订译文（后续重新翻译将自动保护不被覆盖）`);
    } catch (e: any) {
      setMsg(`❌ 保存人工修订失败：${e.message}`);
    } finally {
      setSavingSeg(false);
    }
  };

  const saveAll = async () => {
    if (!activeContentId) return;
    setSaving(true);
    try {
      await api.saveTranscript(activeContentId, {
        raw_text: rawText,
        hook_analysis: hookAnalysis,
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

  const toggleRefContent = (cid: number) => {
    setSelectedRefIds((prev) =>
      prev.includes(cid) ? prev.filter((x) => x !== cid) : [...prev, cid],
    );
  };

  const handleImportSkillFile = async (file?: File) => {
    if (!file) return;
    try {
      const text = await file.text();
      const baseName = file.name.replace(/\.[^.]+$/, '');
      if (file.name.toLowerCase().endsWith('.json')) {
        const obj = JSON.parse(text);
        setNewSkillName(obj.name || baseName);
        setNewSkillDesc(obj.description || '');
        setNewSkillPrompt(obj.system_prompt || obj.prompt || text);
        setNewSkillFormat('json_import');
      } else {
        const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
        setNewSkillName(firstHeading || baseName);
        setNewSkillDesc(`从 ${file.name} 导入的自定义文案 Skill`);
        setNewSkillPrompt(text);
        setNewSkillFormat('markdown_import');
      }
      setMsg(`✅ 已读取 Skill 文件「${file.name}」，确认内容后点击「保存 Skill」即可使用`);
    } catch (e: any) {
      setMsg(`❌ 解析 Skill 文件失败：${e.message}`);
    }
  };

  const handleSaveCustomSkill = async () => {
    if (!newSkillName.trim() || !newSkillPrompt.trim()) {
      setMsg('⚠️ 请填写 Skill 名称和创作指令（Prompt）');
      return;
    }
    setSavingSkill(true);
    try {
      const res = await api.saveCustomScriptSkill({
        name: newSkillName.trim(),
        description: newSkillDesc.trim(),
        system_prompt: newSkillPrompt.trim(),
        source_format: newSkillFormat,
      });
      setSkills(res.skills || []);
      if (res.skill?.skill_id) setSelectedSkillId(res.skill.skill_id);
      setSkillModalOpen(false);
      setNewSkillName('');
      setNewSkillDesc('');
      setNewSkillPrompt('');
      setNewSkillFormat('manual');
      setMsg(`✅ 已保存并选中自定义 Skill「${res.skill?.name}」`);
    } catch (e: any) {
      setMsg(`❌ 保存 Skill 失败：${e.message}`);
    } finally {
      setSavingSkill(false);
    }
  };

  const handleDeleteCustomSkill = async (skillId: string) => {
    if (!window.confirm('确定删除该自定义 Skill 吗？')) return;
    try {
      const res = await api.deleteCustomScriptSkill(skillId);
      setSkills(res.skills || []);
      setSelectedSkillId('fact_separated_deep_dive');
      setMsg('✅ 已删除自定义 Skill');
    } catch (e: any) {
      setMsg(`❌ 删除失败：${e.message}`);
    }
  };

  const handleGenerateOriginal = async (manualSave = false) => {
    if (!activeContentId && selectedRefIds.length === 0) return;
    setGeneratingOriginal(true);
    const chosenModel = writingModels.find((m) => m.engine_id === selectedEngineId);
    setMsg(
      manualSave
        ? '⏳ 正在保存为独立原创版本（绝不覆盖原始参考文案）...'
        : `⏳ 正在使用所选 Skill + 模型「${chosenModel?.name || selectedEngineId || '默认模型'}」生成独立原创文案...`,
    );
    try {
      const res = await api.generateStudioOriginalVersion({
        project_id: projectId,
        primary_content_id: activeContentId,
        reference_content_ids: selectedRefIds.length > 0 ? selectedRefIds : activeContentId ? [activeContentId] : [],
        skill_id: manualSave ? 'manual' : selectedSkillId,
        engine_id: manualSave ? '' : selectedEngineId,
        model_id: manualSave ? '' : chosenModel?.model_id || '',
        topic_id: selectedTopicId ? Number(selectedTopicId) : null,
        extra_requirements: extraRequirements,
        title: originalTitle,
        manual_content: manualSave ? draft : '',
      });
      const ver = res.version;
      if (ver) {
        setDraft(ver.content_markdown || '');
        setOriginalTitle(ver.title || '');
        setActiveVersionId(ver.id);
        await loadOriginalVersions(activeContentId);
        setMsg(
          manualSave
            ? `✅ 已保存独立原创版本 v${ver.version_no}（原始参考文案完好保留）`
            : `✅ 已生成独立原创版本 v${ver.version_no}（Skill：${ver.skill_name} · 模型：${ver.llm_meta?.model || ver.model_id || '—'} · Token：${ver.llm_meta?.total_tokens ?? '—'}）`,
        );
      }
    } catch (e: any) {
      setMsg(`❌ 原创文案生成失败：${e.message}`);
    } finally {
      setGeneratingOriginal(false);
    }
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
              <div className="flex items-center justify-between mt-1 gcw-text-meta text-slate-400">
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
                  <div className="gcw-text-tag text-slate-400 mt-0.5 flex flex-wrap items-center gap-2">
                    <span>平台：{detail.content.platform}</span>
                    <span>·</span>
                    <span>作者：{detail.content.creator_name || '—'}</span>
                    <span>·</span>
                    <span className="px-1.5 py-0.2 rounded bg-cyan-500/15 border border-cyan-500/35 text-cyan-300 font-mono-num">
                      源语言：{sourceLang || '—'}
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono-num">
                      视频时长：{fmtDur(subInfo?.video_duration_sec ?? detail?.content?.duration_sec)}
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono-num">
                      字幕覆盖：{subInfo?.subtitle_coverage_start != null ? `${fmtDur(Math.floor(subInfo.subtitle_coverage_start))}–${fmtDur(Math.floor(subInfo.subtitle_coverage_end ?? subInfo.subtitle_coverage_start))}` : '—'}（{subInfo?.total_count ?? 0} 段）
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 font-mono-num">
                      已译：{subInfo?.translated_count ?? 0}/{subInfo?.total_count ?? 0} 段
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                  <button
                    onClick={() => runExtract()}
                    disabled={extracting}
                    className="px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1"
                  >
                    {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    {rawText.trim() ? '重新提取' : '一键提文案'}
                  </button>
                  <label className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs border border-slate-700 cursor-pointer flex items-center gap-1">
                    <Upload className="w-3.5 h-3.5" />
                    本地转写
                    <input type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => handleUploadAudio(e.target.files?.[0])} />
                  </label>
                  <button
                    onClick={() => runTranslate(false)}
                    disabled={translating || !rawText.trim()}
                    className="px-2.5 py-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600/45 text-indigo-200 border border-indigo-500/45 text-xs font-medium flex items-center gap-1"
                  >
                    {translating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}
                    {(subInfo?.translated_count ?? 0) > 0 ? '补译/复用译文' : '翻译字幕与全文'}
                  </button>
                  {(subInfo?.translated_count ?? 0) > 0 && (
                    <button
                      onClick={() => runTranslate(true)}
                      disabled={translating}
                      className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs"
                      title="强制重新翻译未人工修订的段落（人工修订段自动保留）"
                    >
                      重译
                    </button>
                  )}
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('gcw:open-translation-settings'))}
                    className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-xs"
                    title="配置翻译引擎与费用控制"
                  >
                    引擎设置
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
              {extracting && extractProgress && (
                <div className="px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-xs flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>{extractProgress}</span>
                </div>
              )}
              {msg && <div className="text-xs text-amber-300">{msg}</div>}
            </div>

            {/* 左右双栏 */}
            <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
              {/* 左栏（5列）：逐段双语对照（支持人工修订保护） / 原文与中文全文 */}
              <div className="col-span-5 bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between text-xs gap-2">
                  <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded border border-slate-800">
                    <button
                      type="button"
                      onClick={() => setLeftView('bilingual')}
                      className={`px-2 py-0.5 rounded gcw-text-tag font-medium ${
                        leftView === 'bilingual' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      逐段双语对照 ({subInfo?.total_count ?? 0})
                    </button>
                    <button
                      type="button"
                      onClick={() => setLeftView('fulltext')}
                      className={`px-2 py-0.5 rounded gcw-text-tag font-medium ${
                        leftView === 'fulltext' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      原文 + 中文全文
                    </button>
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(leftView === 'fulltext' ? (translated || rawText) : rawText)}
                    className="text-slate-400 hover:text-cyan-300 flex items-center gap-1 gcw-text-tag"
                  >
                    <Copy className="w-3 h-3" />复制
                  </button>
                </div>

                {leftView === 'bilingual' && (subInfo?.segments?.length ?? 0) > 0 ? (
                  <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70 p-2 space-y-1">
                    {subInfo.segments.map((seg: any) => {
                      const isEditing = editingSegIdx === seg.segment_idx;
                      return (
                        <div key={seg.segment_idx} className="p-2 rounded-lg hover:bg-slate-900/70 space-y-1 text-xs">
                          <div className="flex items-center justify-between gcw-text-meta text-slate-400 font-mono-num">
                            <div className="flex items-center gap-1.5">
                              <span className="text-cyan-400">#{seg.segment_idx + 1}</span>
                              <span>
                                {fmtDur(Math.floor(seg.start))} → {seg.end != null ? fmtDur(Math.floor(seg.end)) : '未知'}
                              </span>
                              {seg.end_source === 'estimated_next_start' && (
                                <span className="text-slate-500">(估算)</span>
                              )}
                              {seg.is_manual_edited && (
                                <span className="px-1 py-0.2 rounded bg-emerald-500/15 text-emerald-300 font-sans">人工修订</span>
                              )}
                            </div>
                            {!isEditing && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingSegIdx(seg.segment_idx);
                                  setEditingSegZh(seg.translated_text || '');
                                }}
                                className="text-slate-400 hover:text-cyan-300 font-sans"
                              >
                                修订译文
                              </button>
                            )}
                          </div>
                          <div className="text-slate-300 leading-snug">{seg.text}</div>
                          {isEditing ? (
                            <div className="space-y-1 pt-0.5">
                              <textarea
                                value={editingSegZh}
                                onChange={(e) => setEditingSegZh(e.target.value)}
                                rows={2}
                                className="w-full bg-slate-950 border border-cyan-500/50 rounded p-1.5 text-xs text-cyan-100 focus:outline-none"
                              />
                              <div className="flex justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setEditingSegIdx(null)}
                                  className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 gcw-text-tag"
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSaveManualSeg(seg.segment_idx)}
                                  disabled={savingSeg}
                                  className="px-2.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white gcw-text-tag font-medium"
                                >
                                  {savingSeg ? '保存中...' : '保存人工修订'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className={seg.translated_text ? 'text-cyan-200 leading-snug' : 'text-slate-500 italic'}>
                              {seg.translated_text || '（待翻译）'}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    <textarea
                      value={rawText}
                      onChange={(e) => setRawText(e.target.value)}
                      placeholder="点击上方「一键提文案」，或在此粘贴原文..."
                      className="flex-1 bg-transparent p-3 text-xs text-slate-200 leading-relaxed resize-none focus:outline-none"
                    />
                    {translated && (
                      <div className="h-2/5 border-t border-slate-800 flex flex-col bg-slate-950/60">
                        <div className="px-3 py-1.5 gcw-text-tag font-semibold text-indigo-300 border-b border-slate-800/80 flex justify-between">
                          <span>中文译文全文（与逐段双语字幕同源缓存）</span>
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
                  </>
                )}
              </div>

              {/* 右栏（7列）：三合一深度面板（原创文案 / 热力高光拆解 / 高赞评论痛点；已移除真实素材台账入口） */}
              <div className="col-span-7 bg-[#0b1120] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
                <div className="px-2 py-1.5 border-b border-slate-800 bg-[#0f172a] flex items-center gap-1 text-xs flex-wrap">
                  {[
                    ['draft', '✍️ 原创文案'],
                    ['analysis', '🔥 热力高光/拆解/金句'],
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

                {/* Tab 1: GCW-UAT-R4-D 原创文案（自定义 Skill 导入 + 多模型切换 + 多参考文案 + 关联选题 + 独立版本） */}
                {rightTab === 'draft' && (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="p-2.5 border-b border-slate-800/80 bg-slate-950/60 space-y-2 text-xs">
                      {/* 行 1：Skill 选择 + 明显导入 Skill 入口 + AI 模型选择 */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1.5 flex-1 min-w-[220px]">
                          <span className="gcw-text-tag text-slate-400 shrink-0">文案 Skill</span>
                          <select
                            value={selectedSkillId}
                            onChange={(e) => setSelectedSkillId(e.target.value)}
                            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
                          >
                            {skills.map((sk) => (
                              <option key={sk.skill_id} value={sk.skill_id}>
                                {sk.is_builtin ? '' : '[自定义] '}
                                {sk.name}
                              </option>
                            ))}
                          </select>
                          {skills.find((s) => s.skill_id === selectedSkillId && !s.is_builtin) && (
                            <button
                              type="button"
                              onClick={() => handleDeleteCustomSkill(selectedSkillId)}
                              className="p-1 rounded bg-slate-900 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-slate-700"
                              title="删除当前自定义 Skill"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setSkillModalOpen(true)}
                          className="px-2.5 py-1 rounded-lg bg-cyan-600/25 hover:bg-cyan-600/40 text-cyan-200 border border-cyan-500/50 text-xs font-medium flex items-center gap-1 shrink-0"
                        >
                          <FileUp className="w-3.5 h-3.5" />+ 导入 / 自定义 Skill
                        </button>
                        <div className="flex items-center gap-1.5 min-w-[200px]">
                          <span className="gcw-text-tag text-slate-400 shrink-0">执行模型</span>
                          <select
                            value={selectedEngineId}
                            onChange={(e) => setSelectedEngineId(e.target.value)}
                            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-emerald-200 focus:outline-none focus:border-emerald-500"
                          >
                            {writingModels.map((m) => (
                              <option key={m.engine_id} value={m.engine_id} disabled={!m.configured}>
                                {m.configured ? '● ' : '○(未配) '}
                                {m.name} ({m.model_id})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {/* 行 2：多篇参考文案勾选 + 关联 TopicHub 选题 */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1 flex-wrap flex-1 min-w-[220px]">
                          <span className="gcw-text-tag text-slate-400 shrink-0">参考文案 ({selectedRefIds.length})：</span>
                          {list.slice(0, 8).map((c) => {
                            const checked = selectedRefIds.includes(c.id);
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => toggleRefContent(c.id)}
                                className={`px-1.5 py-0.5 rounded border gcw-text-meta max-w-[150px] truncate transition ${
                                  checked
                                    ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200'
                                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                                }`}
                                title={`点击${checked ? '取消' : '追加'}参考文案：${c.title}`}
                              >
                                {checked ? '✓ ' : '+ '}#{c.id} {c.title}
                              </button>
                            );
                          })}
                        </div>
                        <select
                          value={selectedTopicId}
                          onChange={(e) => setSelectedTopicId(e.target.value)}
                          className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 gcw-text-tag text-slate-200 max-w-[210px]"
                          title="可选：关联 TopicHub 选题，自动带入该选题的证据与高赞评论"
                        >
                          <option value="">关联选题（可选）</option>
                          {topics.map((tp) => (
                            <option key={tp.id} value={tp.id}>
                              #{tp.id} {tp.topic_title}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* 行 3：额外创作要求 + 执行生成按钮 */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          value={extraRequirements}
                          onChange={(e) => setExtraRequirements(e.target.value)}
                          placeholder="额外创作要求（例如：面向中国中产家庭、口语化 3 分钟口播、突出费用与风险对比）..."
                          className="flex-1 min-w-[200px] bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
                        />
                        <button
                          type="button"
                          onClick={() => handleGenerateOriginal(false)}
                          disabled={generatingOriginal}
                          className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-medium flex items-center gap-1 shrink-0"
                        >
                          {generatingOriginal ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                          生成独立原创版本
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGenerateOriginal(true)}
                          disabled={generatingOriginal || !draft.trim()}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs flex items-center gap-1 shrink-0"
                          title="将当前编辑区的原创内容存为独立历史版本（绝不覆盖原始参考文案）"
                        >
                          <Plus className="w-3.5 h-3.5" />存为新版本
                        </button>
                      </div>

                      {/* 行 4：独立原创版本历史切换条 */}
                      {originalVersions.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-800/80">
                          <span className="gcw-text-meta text-slate-400">独立原创版本 ({originalVersions.length})：</span>
                          {originalVersions.slice(0, 8).map((v) => (
                            <button
                              key={v.id}
                              type="button"
                              onClick={() => {
                                setActiveVersionId(v.id);
                                setOriginalTitle(v.title || '');
                                setDraft(v.content_markdown || '');
                                setMsg(`已加载独立原创版本 v${v.version_no}（Skill：${v.skill_name} · 模型：${v.model_id || '手动'}）`);
                              }}
                              className={`px-2 py-0.5 rounded gcw-text-meta border transition ${
                                activeVersionId === v.id
                                  ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-200'
                                  : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-600'
                              }`}
                            >
                              v{v.version_no} · {v.skill_name?.slice(0, 10)} ({v.model_id || '手动'})
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 原创标题与钩子笔记 + 正文编辑区 */}
                    <div className="px-2.5 py-1.5 border-b border-slate-800/70 flex gap-2">
                      <input
                        value={originalTitle}
                        onChange={(e) => setOriginalTitle(e.target.value)}
                        placeholder="原创文案标题..."
                        className="w-1/2 bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
                      />
                      <input
                        value={hookAnalysis}
                        onChange={(e) => setHookAnalysis(e.target.value)}
                        placeholder="前 5 秒钩子 / 核心结构笔记..."
                        className="w-1/2 bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs text-amber-200 focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="选择文案 Skill 与 AI 模型点击「生成独立原创版本」，或在此直接撰写你的原创文案（绝不覆盖左侧原始参考文案）..."
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
                                {h.lang ? <span className="ml-2 px-1 py-0.5 rounded bg-indigo-500/20 text-indigo-300 gcw-text-meta">{h.lang}→中</span> : null}
                              </span>
                              <button
                                onClick={() => saveQuote(h.snippet_zh ? `${h.snippet_zh}\n（原文：${h.snippet}）` : h.snippet, '热力高光', h.start_sec)}
                                className="gcw-text-meta px-2 py-0.5 rounded bg-slate-800 hover:bg-emerald-600 text-slate-200"
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
                            <span className={breakdown.hook_verified ? 'text-emerald-400 gcw-text-meta' : 'text-rose-400 gcw-text-meta'}>
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
                              <span className={m.verified ? 'text-emerald-400 gcw-text-meta' : 'text-rose-400 gcw-text-meta'}>
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
                                  <div className="gcw-text-meta text-slate-400 mt-0.5">
                                    {q.category} · {q.usage} · {q.verified ? '✅核验通过' : '⚠️待核'}
                                  </div>
                                </div>
                                <button
                                  onClick={() => saveQuote(q.text_zh ? `${q.text_zh}\n（原文：${q.text}）` : q.text, q.category)}
                                  className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 gcw-text-meta shrink-0"
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
                            <div className="gcw-text-meta text-slate-500 mt-0.5">{q.category}</div>
                          </div>
                          <button onClick={() => api.delQuote(q.id).then(loadQuotes)} className="text-slate-600 hover:text-rose-400">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tab 3: 优化③ 高赞评论与痛点（已按 R4-D 移除真实素材台账界面入口，底层素材检索与历史数据完整保留） */}
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
                        <span className="gcw-text-meta text-slate-400">高频词：</span>
                        {topKw.map((k) => (
                          <span key={k.word} className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono-num gcw-text-meta">
                            {k.word} ({k.count})
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="divide-y divide-slate-800/70">
                      {comments.map((cm) => (
                        <div key={cm.id} className="py-2 space-y-1">
                          <div className="flex items-center justify-between gcw-text-meta text-slate-400">
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

      {/* GCW-UAT-R4-D：导入 / 新建自定义文案 Skill 弹窗 */}
      {skillModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-[#0b1120] border border-slate-700 rounded-xl shadow-2xl overflow-hidden text-xs">
            <div className="px-4 py-3 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between">
              <div className="font-bold text-cyan-300 flex items-center gap-1.5">
                <FileUp className="w-4 h-4" />导入 / 自定义原创文案 Skill
              </div>
              <button onClick={() => setSkillModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-slate-900/90 border border-slate-800">
                <div className="text-slate-300">
                  支持导入本地 <code className="text-cyan-300">.md / .txt / .json</code> Skill 文件，或在下方直接编写创作指令。
                </div>
                <label className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium cursor-pointer shrink-0 flex items-center gap-1">
                  <Upload className="w-3.5 h-3.5" />选择文件导入
                  <input
                    type="file"
                    accept=".md,.txt,.json,text/markdown,text/plain,application/json"
                    className="hidden"
                    onChange={(e) => handleImportSkillFile(e.target.files?.[0])}
                  />
                </label>
              </div>
              <div className="space-y-1">
                <label className="text-slate-400">Skill 名称 *</label>
                <input
                  value={newSkillName}
                  onChange={(e) => setNewSkillName(e.target.value)}
                  placeholder="例如：高端医疗真相拆解口播 Skill"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-slate-400">适用场景说明（可选）</label>
                <input
                  value={newSkillDesc}
                  onChange={(e) => setNewSkillDesc(e.target.value)}
                  placeholder="简要描述该 Skill 的风格、节奏与受众"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-slate-400">Skill 创作指令 / Prompt *</label>
                <textarea
                  rows={8}
                  value={newSkillPrompt}
                  onChange={(e) => setNewSkillPrompt(e.target.value)}
                  placeholder="输入该 Skill 的完整角色设定、结构要求、口播节奏、证据引用规范与避坑要求..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-100 leading-relaxed focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>
            <div className="px-4 py-3 border-t border-slate-800 bg-[#0f172a] flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSkillModalOpen(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveCustomSkill}
                disabled={savingSkill}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1"
              >
                {savingSkill ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                保存 Skill
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
