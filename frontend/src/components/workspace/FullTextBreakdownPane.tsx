/**
 * FIX-04 / FIX-03-B · 全文拆解 Skill 工作区（三层清晰布局，绝不拥挤，绝不缩小全局字体）
 * 第一层：工作区标题 + 历史报告按需展开入口 + 配置区折叠/展开按钮
 * 第二层：独立分析配置区（5 行纵向排布：1.拆解Skill选择与导入 2.AI模型选择与真实可用状态 3.参考文案来源与原文/译文/双语切换 4.默认折叠的额外分析要求 5.醒目开始全文拆解主按钮）
 * 第三层：独立全文拆解报告阅读区（生成报告后自动折叠配置区，占主要可用空间，支持安全 Markdown 分段渲染、复制与导出）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileSearch,
  History,
  Loader2,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from 'lucide-react';
import { api } from '../../api';
import { formatLocalDateTime } from './VideoMetricsBar';

interface Props {
  contentId: number | null;
  subData?: any | null;
  onSwitchToReference?: () => void;
}

export default function FullTextBreakdownPane({ contentId, subData = null, onSwitchToReference }: Props) {
  const [skills, setSkills] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [textMode, setTextMode] = useState<'original' | 'zh' | 'bilingual'>('original');
  const [extraReq, setExtraReq] = useState('');

  // 折叠控制：生成报告后自动折叠配置区；额外分析要求默认折叠；历史报告按需展开
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [reports, setReports] = useState<any[]>([]);
  const [activeReport, setActiveReport] = useState<any | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const reqSeqRef = useRef(0);
  const runSeqRef = useRef(0);
  const activeContentIdRef = useRef<number | null>(contentId);
  activeContentIdRef.current = contentId;

  const loadSkillsAndModels = async () => {
    try {
      const [skRes, mdRes] = await Promise.all([api.topicHubScriptSkills(), api.listWritingModels()]);
      const customSkills = (skRes?.skills || []).filter((s: any) => !s.is_builtin);
      setSkills(customSkills);
      if (customSkills.length && !customSkills.some((s: any) => s.skill_id === selectedSkillId)) {
        setSelectedSkillId(customSkills[0].skill_id);
      }
      const mdList = mdRes?.models || [];
      setModels(mdList);
      if (mdList.length && !selectedModelKey) {
        const ready = mdList.find((m: any) => m.ready && m.text_generation_capable) || mdList.find((m: any) => m.configured) || mdList[0];
        if (ready) setSelectedModelKey(`${ready.engine_id}::${ready.model_id}`);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadSkillsAndModels();
  }, []);

  // FIX-03-B: 切换作品时彻底隔离旧请求与状态
  useEffect(() => {
    const seq = ++reqSeqRef.current;
    runSeqRef.current += 1;
    setRunning(false);
    setReports([]);
    setActiveReport(null);
    setHistoryOpen(false);
    setConfigCollapsed(false);
    setMsg('');
    setErrMsg('');
    if (!contentId) return;
    const targetCid = contentId;
    api
      .topicHubListBreakdownReports(targetCid)
      .then((r) => {
        if (seq !== reqSeqRef.current || activeContentIdRef.current !== targetCid) return;
        const list = r?.reports || [];
        setReports(list);
        if (list.length) {
          setActiveReport(list[0]);
          setConfigCollapsed(true);
        }
      })
      .catch(() => {});
  }, [contentId]);

  const refStats = useMemo(() => {
    const segs: any[] = subData?.segments || [];
    let origChars = 0;
    let zhChars = 0;
    for (const s of segs) {
      origChars += String(s.text || '').trim().length;
      zhChars += String(s.translated_text || '').trim().length;
    }
    return { segCount: segs.length, origChars, zhChars };
  }, [subData?.segments]);

  const selectedModel = useMemo(() => {
    const [eid, mid] = (selectedModelKey || '::').split('::');
    return models.find((m) => m.engine_id === eid && m.model_id === mid) || null;
  }, [models, selectedModelKey]);

  const handleImportSkill = async (file: File) => {
    try {
      const text = await file.text();
      const baseName = file.name.replace(/\.(md|txt|json)$/i, '');
      let name = `[拆解] ${baseName}`;
      let description = `从 ${file.name} 导入的全文拆解 Skill`;
      let system_prompt = text;
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text);
        name = parsed.name || name;
        description = parsed.description || description;
        system_prompt = parsed.system_prompt || parsed.prompt || text;
      }
      const res = await api.saveCustomScriptSkill({
        name,
        description,
        system_prompt,
        source_format: file.name.split('.').pop() || 'md',
      });
      if (res?.ok) {
        await loadSkillsAndModels();
        if (res.skill?.skill_id) setSelectedSkillId(res.skill.skill_id);
        setMsg(`✅ 已导入拆解 Skill「${name}」`);
        setErrMsg('');
      }
    } catch (e: any) {
      setErrMsg(`导入拆解 Skill 失败：${e?.message || e}`);
    }
  };

  const handleRun = async () => {
    if (!contentId || !selectedSkillId || running) return;
    const targetCid = contentId;
    const seq = ++runSeqRef.current;
    const [engineId, modelId] = (selectedModelKey || '::').split('::');
    setRunning(true);
    setErrMsg('');
    setMsg('正在调用所选拆解 Skill 分析完整参考文案...');
    try {
      const res = await api.topicHubRunBreakdownSkill(targetCid, {
        skill_id: selectedSkillId,
        engine_id: engineId || '',
        model_id: modelId || '',
        text_mode: textMode,
        extra_requirements: extraReq.trim(),
      });
      if (seq !== runSeqRef.current || activeContentIdRef.current !== targetCid) return;
      if (res?.ok && res.report) {
        setReports((prev) => [res.report, ...prev]);
        setActiveReport(res.report);
        setConfigCollapsed(true); // 生成报告后自动折叠配置区，释放阅读空间
        setHistoryOpen(false);
        setMsg('✅ 全文拆解完成并已原子保存（未修改参考文案与二创文案）');
      } else {
        setErrMsg(res?.error || '执行全文拆解失败');
        setMsg('');
      }
    } catch (e: any) {
      if (seq !== runSeqRef.current || activeContentIdRef.current !== targetCid) return;
      setErrMsg(`执行全文拆解失败：${e?.message || e}`);
      setMsg('');
    } finally {
      if (seq === runSeqRef.current && activeContentIdRef.current === targetCid) setRunning(false);
    }
  };

  const handleCopy = async () => {
    if (!activeReport?.report_markdown) return;
    await navigator.clipboard.writeText(activeReport.report_markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const handleExport = () => {
    if (!activeReport?.report_markdown) return;
    const blob = new Blob([activeReport.report_markdown], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `breakdown_content_${contentId || 'video'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const canRun = Boolean(
    contentId &&
      selectedSkillId &&
      refStats.segCount > 0 &&
      selectedModel?.configured &&
      selectedModel?.text_generation_capable !== false &&
      !running
  );

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden min-w-0">
      {/* 第一层：全文拆解工作区标题与历史报告入口 */}
      <div className="gcw-panel-header px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileSearch className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="gcw-section-title text-slate-100 truncate">全文拆解</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setConfigCollapsed((v) => !v)}
            className="gcw-btn-ghost px-2.5 py-1 rounded-lg gcw-text-tag inline-flex items-center gap-1"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {configCollapsed ? '展开配置' : '收起配置'}
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className={`px-2.5 py-1 rounded-lg gcw-text-tag border inline-flex items-center gap-1 ${
              historyOpen ? 'gcw-tab-active' : 'gcw-btn-ghost'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            历史 ({reports.length})
          </button>
        </div>
      </div>

      {/* 第二层：独立分析配置区（5 行纵向排布，绝不挤在一行） */}
      {!configCollapsed && (
        <div className="p-3.5 border-b border-[#1e2e4a] bg-[#0d1526] space-y-2.5 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportSkill(f);
              e.target.value = '';
            }}
          />

          {/* 第一行：拆解 Skill 选择与导入按钮 */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedSkillId}
              onChange={(e) => setSelectedSkillId(e.target.value)}
              className="gcw-input flex-1 min-w-[180px] px-3 py-1.5 gcw-text-btn"
            >
              {skills.length === 0 ? (
                <option value="">待导入拆解 Skill（尚未导入）</option>
              ) : (
                skills.map((s) => (
                  <option key={s.skill_id} value={s.skill_id}>
                    {s.name}
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="gcw-btn-ghost px-3 py-1.5 rounded-lg gcw-text-btn inline-flex items-center gap-1.5 shrink-0"
            >
              <Upload className="w-4 h-4" /> 导入拆解 Skill
            </button>
          </div>

          {/* 第二行：AI 模型选择与真实可用状态 */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedModelKey}
              onChange={(e) => setSelectedModelKey(e.target.value)}
              className="gcw-input flex-1 min-w-[180px] px-3 py-1.5 gcw-text-btn"
            >
              {models.map((m) => (
                <option key={`${m.engine_id}::${m.model_id}`} value={`${m.engine_id}::${m.model_id}`}>
                  {m.label || m.name}
                  {m.is_translation_only ? '（专用翻译模型）' : m.configured ? '' : '（未配置）'}
                </option>
              ))}
            </select>
            <span
              className={`px-2.5 py-1 rounded-lg gcw-text-tag shrink-0 border ${
                selectedModel?.is_translation_only
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                  : selectedModel?.configured
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-rose-500/15 border-rose-500/40 text-rose-300'
              }`}
            >
              {selectedModel?.is_translation_only
                ? '仅限翻译'
                : selectedModel?.configured
                ? '已配置'
                : '未配置'}
            </span>
          </div>

          {/* 第三行：完整参考文案来源、原文/译文/双语切换及原文查看入口 */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0c1424] border border-[#1e2e4a] rounded-lg px-3 py-1.5">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="gcw-text-tag text-slate-300 font-mono-num">
                {refStats.segCount > 0
                  ? `参考文案：${refStats.segCount} 段（原文 ${refStats.origChars} 字 / 译文 ${refStats.zhChars} 字）`
                  : '当前视频暂无参考文案'}
              </span>
              {onSwitchToReference && (
                <button
                  type="button"
                  onClick={onSwitchToReference}
                  className="gcw-text-tag text-cyan-400 hover:text-cyan-300 underline"
                >
                  查看原文
                </button>
              )}
            </div>
            <div className="flex rounded-lg overflow-hidden border border-[#2c4268] bg-[#111a2e] shrink-0">
              {(
                [
                  ['original', '原文'],
                  ['zh', '译文'],
                  ['bilingual', '双语'],
                ] as ['original' | 'zh' | 'bilingual', string][]
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTextMode(k)}
                  className={`px-2.5 py-0.5 gcw-text-tag transition ${
                    textMode === k ? 'bg-cyan-500/25 text-cyan-200 font-semibold' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* 第四行：默认折叠的额外分析要求 */}
          <div>
            <button
              type="button"
              onClick={() => setExtraOpen((v) => !v)}
              className="gcw-text-tag text-slate-400 hover:text-slate-200 inline-flex items-center gap-1"
            >
              {extraOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              额外分析要求（可选）
            </button>
            {extraOpen && (
              <textarea
                value={extraReq}
                onChange={(e) => setExtraReq(e.target.value)}
                rows={2}
                placeholder="输入针对本次全文拆解的额外关注点或输出要求..."
                className="gcw-input w-full mt-1.5 px-3 py-1.5 gcw-text-base resize-none"
              />
            )}
          </div>

          {/* 第五行：醒目的开始全文拆解主按钮 */}
          <button
            type="button"
            onClick={handleRun}
            disabled={!canRun}
            className="gcw-btn-cyan w-full py-2 rounded-xl gcw-text-btn font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {running ? '正在执行全文拆解...' : '开始全文拆解'}
          </button>

          {msg && <div className="gcw-text-tag text-emerald-300">{msg}</div>}
          {errMsg && (
            <div className="gcw-text-tag text-rose-300 flex items-start gap-1.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-words">{errMsg}</span>
            </div>
          )}
        </div>
      )}

      {/* 历史报告按需展开列表 */}
      {historyOpen && (
        <div className="p-3 border-b border-[#1e2e4a] bg-[#0b1222] max-h-48 overflow-y-auto space-y-1.5 shrink-0">
          {reports.length === 0 ? (
            <div className="gcw-text-tag text-slate-500 text-center py-2">当前作品暂无历史拆解报告</div>
          ) : (
            reports.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setActiveReport(r);
                  setHistoryOpen(false);
                  setConfigCollapsed(true);
                }}
                className={`w-full text-left px-3 py-2 rounded-lg border transition ${
                  activeReport?.id === r.id
                    ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-200'
                    : 'bg-[#111a2e] border-[#1e2e4a] text-slate-300 hover:border-[#2c4268]'
                }`}
              >
                <div className="gcw-text-tag font-semibold truncate">{r.skill_name} · {r.model_id}</div>
                <div className="gcw-text-meta text-slate-400 font-mono-num">
                  {formatLocalDateTime(r.created_at)} · 输入：{r.text_mode}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {/* 第三层：独立全文拆解报告阅读区（占主要可用空间） */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-2.5 min-w-0">
        {activeReport ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#1e2e4a]">
              <div className="gcw-text-meta text-slate-400 font-mono-num min-w-0 truncate">
                Skill：{activeReport.skill_name} · 模型：{activeReport.model_id} · {formatLocalDateTime(activeReport.created_at)}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button type="button" onClick={handleCopy} className="gcw-btn-ghost px-2.5 py-1 rounded-lg gcw-text-tag inline-flex items-center gap-1">
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? '已复制' : '复制'}
                </button>
                <button type="button" onClick={handleExport} className="gcw-btn-ghost px-2.5 py-1 rounded-lg gcw-text-tag inline-flex items-center gap-1">
                  <Download className="w-3.5 h-3.5" /> 导出
                </button>
              </div>
            </div>
            <div className="p-3.5 rounded-xl bg-[#0c1424] border border-[#1e2e4a] gcw-text-base text-slate-200 whitespace-pre-wrap break-words leading-relaxed">
              {activeReport.report_markdown}
            </div>
          </>
        ) : skills.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-slate-400 px-4">
            <FileSearch className="w-8 h-8 text-cyan-500/50" />
            <div className="gcw-text-base font-semibold text-slate-200">待导入拆解 Skill</div>
            <div className="gcw-text-tag text-slate-400 max-w-md">
              导入你的 `.md / .txt / .json` 拆解 Skill 后，即可对当前视频完整参考文案执行全文拆解。系统绝不硬编码模板或生成虚构分析。
            </div>
          </div>
        ) : refStats.segCount === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-slate-400 gcw-text-base px-4">
            当前视频尚无参考文案，请先在「参考文案」中提取文案后再执行全文拆解
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-center text-slate-500 gcw-text-base px-4">
            已就绪，点击上方「开始全文拆解」生成独立拆解报告
          </div>
        )}
      </div>
    </div>
  );
}
