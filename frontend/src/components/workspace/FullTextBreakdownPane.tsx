/**
 * FIX-04 / FIX-03-B / FIX-C03 / FIX-C04 · 全文拆解 Skill 工作区（三层清晰布局，绝不拥挤，绝不缩小全局字体）
 * 第一层：工作区标题 + 历史报告按需展开入口 + 配置区折叠/展开按钮
 * 第二层：独立分析配置区（5 行纵向排布，小高度支持内部滚动；导入 Skill 可选用途；模型显示真实连接态不伪造）
 * 第三层：独立全文拆解报告阅读区（生成后自动折叠配置区；安全 Markdown 渲染标题/表格/列表/引用/粗体，严禁原始 HTML）
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
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

/** 安全行内渲染：仅解析 **粗体** 与 `代码`，全部以 React 文本节点输出，严禁执行原始 HTML */
function renderInlineSafe(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let k = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const tok = match[0];
    if (tok.startsWith('**') && tok.endsWith('**')) {
      parts.push(
        <strong key={k++} className="font-semibold text-slate-100">
          {tok.slice(2, -2)}
        </strong>
      );
    } else if (tok.startsWith('`') && tok.endsWith('`')) {
      parts.push(
        <code key={k++} className="px-1 py-0.5 rounded bg-[#16233d] text-cyan-200 font-mono-num">
          {tok.slice(1, -1)}
        </code>
      );
    }
    last = match.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** FIX-C04: 安全 Markdown 块级渲染（标题 / 表格 / 列表 / 引用 / 粗体，严禁 dangerouslySetInnerHTML） */
function SafeMarkdownView({ markdown }: { markdown: string }) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    // 标题
    const hMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const cls =
        level === 1
          ? 'text-lg font-bold text-cyan-200 pt-2 pb-1 border-b border-[#1e2e4a]'
          : level === 2
          ? 'text-base font-bold text-slate-100 pt-2'
          : 'gcw-text-btn font-semibold text-slate-100 pt-1.5';
      blocks.push(
        <div key={key++} className={cls}>
          {renderInlineSafe(hMatch[2])}
        </div>
      );
      i += 1;
      continue;
    }

    // 表格（首行含 | 且次行为 --- 分隔行）
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const parseRow = (r: string) =>
        r
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseRow(lines[i]);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        bodyRows.push(parseRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div key={key++} className="overflow-x-auto my-2 rounded-lg border border-[#1e2e4a]">
          <table className="w-full text-left border-collapse gcw-text-tag">
            <thead>
              <tr className="bg-[#111c33] text-cyan-200 border-b border-[#1e2e4a]">
                {headers.map((h, hi) => (
                  <th key={hi} className="px-2.5 py-1.5 font-semibold">
                    {renderInlineSafe(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri} className="border-b border-[#1e2e4a]/60 last:border-b-0">
                  {headers.map((_, ci) => (
                    <td key={ci} className="px-2.5 py-1.5 text-slate-200 align-top">
                      {renderInlineSafe(row[ci] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 引用块
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="border-l-2 border-cyan-500/60 bg-[#101a30] px-3 py-1.5 rounded-r-lg text-slate-300 gcw-text-base space-y-1"
        >
          {quoteLines.map((ql, qi) => (
            <div key={qi}>{renderInlineSafe(ql)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ul key={key++} className="list-disc pl-5 space-y-1 gcw-text-base text-slate-200">
          {items.map((it, ii) => (
            <li key={ii}>{renderInlineSafe(it)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={key++} className="list-decimal pl-5 space-y-1 gcw-text-base text-slate-200">
          {items.map((it, ii) => (
            <li key={ii}>{renderInlineSafe(it)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 普通段落
    blocks.push(
      <p key={key++} className="gcw-text-base text-slate-200 leading-relaxed break-words">
        {renderInlineSafe(line)}
      </p>
    );
    i += 1;
  }

  return <div className="space-y-2">{blocks}</div>;
}

function modelConnLabel(m: any | null): { text: string; cls: string } {
  if (!m) return { text: '未选择', cls: 'bg-slate-500/15 border-slate-500/40 text-slate-300' };
  if (m.is_translation_only) return { text: '仅限翻译', cls: 'bg-amber-500/15 border-amber-500/40 text-amber-300' };
  if (!m.configured) return { text: '未配置', cls: 'bg-rose-500/15 border-rose-500/40 text-rose-300' };
  if (m.connection_status === 'connected' || m.connected) {
    return { text: '已连接', cls: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' };
  }
  if (m.connection_status === 'failed') {
    return { text: '连接失败', cls: 'bg-rose-500/15 border-rose-500/40 text-rose-300' };
  }
  return { text: '未检测', cls: 'bg-sky-500/15 border-sky-500/40 text-sky-300' };
}

export default function FullTextBreakdownPane({ contentId, subData = null, onSwitchToReference }: Props) {
  const [skills, setSkills] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [importPurpose, setImportPurpose] = useState<'breakdown' | 'general' | 'rewrite'>('breakdown');
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
      // FIX-C04: 兼容历史未标注 skill_purpose 的 Skill（默认视为 general），仅过滤掉明确标为 rewrite 的 Skill
      const customSkills = (skRes?.skills || []).filter(
        (s: any) => !s.is_builtin && (s.skill_purpose || 'general') !== 'rewrite'
      );
      setSkills(customSkills);
      if (customSkills.length && !customSkills.some((s: any) => s.skill_id === selectedSkillId)) {
        setSelectedSkillId(customSkills[0].skill_id);
      }
      const mdList = mdRes?.models || [];
      setModels(mdList);
      if (mdList.length && !selectedModelKey) {
        const usable =
          mdList.find((m: any) => m.ready && m.text_generation_capable) ||
          mdList.find((m: any) => m.configured && !m.is_translation_only) ||
          mdList[0];
        if (usable) setSelectedModelKey(`${usable.engine_id}::${usable.model_id}`);
      }
    } catch (e: any) {
      setErrMsg(`加载拆解 Skill 或可用模型列表失败：${e?.message || e}`);
    }
  };

  useEffect(() => {
    loadSkillsAndModels();
  }, []);

  // FIX-03-B / FIX-C04: 切换作品时彻底隔离旧请求与状态，且加载历史报告失败显式提示不吞异常
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
      .catch((e: any) => {
        if (seq !== reqSeqRef.current || activeContentIdRef.current !== targetCid) return;
        setErrMsg(`加载历史拆解报告失败：${e?.message || e}`);
      });
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

  const badge = modelConnLabel(selectedModel);

  const handleImportSkill = async (file: File) => {
    try {
      const text = await file.text();
      const baseName = file.name.replace(/\.(md|txt|json)$/i, '');
      let name = baseName;
      let description = `从 ${file.name} 导入的自定义 Skill`;
      let system_prompt = text;
      let purpose: 'breakdown' | 'general' | 'rewrite' = importPurpose;
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text);
        name = parsed.name || name;
        description = parsed.description || description;
        system_prompt = parsed.system_prompt || parsed.prompt || text;
        if (parsed.skill_purpose && ['breakdown', 'general', 'rewrite'].includes(parsed.skill_purpose)) {
          purpose = parsed.skill_purpose;
        }
      }
      const res = await api.saveCustomScriptSkill({
        name,
        description,
        system_prompt,
        source_format: file.name.split('.').pop() || 'md',
        skill_purpose: purpose,
      } as any);
      if (res?.ok) {
        await loadSkillsAndModels();
        if (res.skill?.skill_id && purpose !== 'rewrite') setSelectedSkillId(res.skill.skill_id);
        setMsg(`✅ 已导入自定义 Skill「${name}」（用途：${purpose === 'breakdown' ? '全文拆解' : purpose === 'rewrite' ? '二创文案' : '通用'}）`);
        setErrMsg('');
      } else {
        setErrMsg(res?.error || '导入自定义 Skill 失败');
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
        setConfigCollapsed(true);
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

      {/* 第二层：独立分析配置区（5 行纵向排布，小高度支持内部滚动） */}
      {!configCollapsed && (
        <div className="p-3.5 border-b border-[#1e2e4a] bg-[#0d1526] space-y-2.5 shrink-0 max-h-[60%] overflow-y-auto">
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

          {/* 第一行：拆解 Skill 选择、用途标注与导入按钮 */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedSkillId}
              onChange={(e) => setSelectedSkillId(e.target.value)}
              className="gcw-input flex-1 min-w-[160px] px-3 py-1.5 gcw-text-btn"
            >
              {skills.length === 0 ? (
                <option value="">待导入拆解 Skill（尚未导入）</option>
              ) : (
                skills.map((s) => (
                  <option key={s.skill_id} value={s.skill_id}>
                    {s.name}
                    {s.skill_purpose === 'breakdown' ? ' [拆解]' : s.skill_purpose === 'general' ? ' [通用]' : ''}
                  </option>
                ))
              )}
            </select>
            <select
              value={importPurpose}
              onChange={(e) => setImportPurpose(e.target.value as any)}
              title="导入 Skill 时由用户指定用途"
              className="gcw-input px-2 py-1.5 gcw-text-tag shrink-0"
            >
              <option value="breakdown">用途：全文拆解</option>
              <option value="general">用途：通用</option>
              <option value="rewrite">用途：二创文案</option>
            </select>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="gcw-btn-ghost px-3 py-1.5 rounded-lg gcw-text-btn inline-flex items-center gap-1.5 shrink-0"
            >
              <Upload className="w-4 h-4" /> 导入拆解 Skill
            </button>
          </div>

          {/* 第二行：AI 模型选择与真实可用状态（不伪造已连接） */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedModelKey}
              onChange={(e) => setSelectedModelKey(e.target.value)}
              className="gcw-input flex-1 min-w-[180px] px-3 py-1.5 gcw-text-btn"
            >
              {models.length === 0 && <option value="">暂无可用文本生成模型</option>}
              {models.map((m) => (
                <option key={`${m.engine_id}::${m.model_id}`} value={`${m.engine_id}::${m.model_id}`}>
                  {m.label || m.name}
                  {m.is_translation_only
                    ? '（仅限翻译）'
                    : !m.configured
                    ? '（未配置）'
                    : m.connection_status === 'connected' || m.connected
                    ? '（已连接）'
                    : m.connection_status === 'failed'
                    ? '（连接失败）'
                    : '（未检测）'}
                </option>
              ))}
            </select>
            <span className={`px-2.5 py-1 rounded-lg gcw-text-tag shrink-0 border ${badge.cls}`}>{badge.text}</span>
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
                <div className="gcw-text-tag font-semibold truncate">
                  {r.skill_name} · {r.model_id}
                </div>
                <div className="gcw-text-meta text-slate-400 font-mono-num">
                  {formatLocalDateTime(r.created_at)} · 输入：{r.text_mode}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {/* 第三层：独立全文拆解报告阅读区（占主要可用空间，安全 Markdown 渲染） */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-2.5 min-w-0">
        {activeReport ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#1e2e4a]">
              <div className="gcw-text-meta text-slate-400 font-mono-num min-w-0 truncate">
                Skill：{activeReport.skill_name} · 模型：{activeReport.model_id} · {formatLocalDateTime(activeReport.created_at)}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="gcw-btn-ghost px-2.5 py-1 rounded-lg gcw-text-tag inline-flex items-center gap-1"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? '已复制' : '复制'}
                </button>
                <button
                  type="button"
                  onClick={handleExport}
                  className="gcw-btn-ghost px-2.5 py-1 rounded-lg gcw-text-tag inline-flex items-center gap-1"
                >
                  <Download className="w-3.5 h-3.5" /> 导出
                </button>
              </div>
            </div>
            <div className="p-3.5 rounded-xl bg-[#0c1424] border border-[#1e2e4a]">
              <SafeMarkdownView markdown={activeReport.report_markdown} />
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
