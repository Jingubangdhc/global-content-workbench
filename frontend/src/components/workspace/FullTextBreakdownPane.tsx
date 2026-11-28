/**
 * FIX-04 · 全文拆解 Skill 工作区（文案创作左侧子标签）
 * - 复用现有 Skill 注册与模型管理，不重复开发 Skill 管理系统
 * - 无适用已导入拆解 Skill 时明确显示「待导入」，绝不生成虚构分析或硬编码拆解模板
 * - 拆解结果独立保存，绝不覆盖参考文案与二创文案
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, FileSearch, Loader2, Sparkles, Upload } from 'lucide-react';
import { api } from '../../api';
import { formatLocalDateTime } from './VideoMetricsBar';

interface Props {
  contentId: number | null;
}

export default function FullTextBreakdownPane({ contentId }: Props) {
  const [skills, setSkills] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [textMode, setTextMode] = useState<'original' | 'zh' | 'bilingual'>('original');
  const [extraReq, setExtraReq] = useState('');
  const [reports, setReports] = useState<any[]>([]);
  const [activeReport, setActiveReport] = useState<any | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const reqSeqRef = useRef(0);

  const loadSkillsAndModels = async () => {
    try {
      const [skRes, mdRes] = await Promise.all([api.topicHubScriptSkills(), api.listWritingModels()]);
      // 拆解 Skill 仅展示用户导入/自定义的 Skill（不把内置二创模板或市场验证冒充拆解 Skill）
      const customSkills = (skRes?.skills || []).filter((s: any) => !s.is_builtin);
      setSkills(customSkills);
      if (customSkills.length && !customSkills.some((s: any) => s.skill_id === selectedSkillId)) {
        setSelectedSkillId(customSkills[0].skill_id);
      }
      const mdList = mdRes?.models || [];
      setModels(mdList);
      if (mdList.length && !selectedModelKey) {
        const ready = mdList.find((m: any) => m.configured || m.ready) || mdList[0];
        if (ready) setSelectedModelKey(`${ready.engine_id}::${ready.model_id}`);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadSkillsAndModels();
  }, []);

  useEffect(() => {
    const seq = ++reqSeqRef.current;
    setReports([]);
    setActiveReport(null);
    setMsg('');
    setErrMsg('');
    if (!contentId) return;
    api
      .topicHubListBreakdownReports(contentId)
      .then((r) => {
        if (seq !== reqSeqRef.current) return;
        const list = r?.reports || [];
        setReports(list);
        if (list.length) setActiveReport(list[0]);
      })
      .catch(() => {});
  }, [contentId]);

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
      }
    } catch (e: any) {
      setErrMsg(`导入拆解 Skill 失败：${e?.message || e}`);
    }
  };

  const handleRun = async () => {
    if (!contentId || !selectedSkillId || running) return;
    const [engineId, modelId] = (selectedModelKey || '::').split('::');
    setRunning(true);
    setErrMsg('');
    setMsg('正在调用所选拆解 Skill 与模型分析完整参考文案...');
    try {
      const res = await api.topicHubRunBreakdownSkill(contentId, {
        skill_id: selectedSkillId,
        engine_id: engineId || '',
        model_id: modelId || '',
        text_mode: textMode,
        extra_requirements: extraReq.trim(),
      });
      if (res?.ok && res.report) {
        setReports((prev) => [res.report, ...prev]);
        setActiveReport(res.report);
        setMsg('✅ 全文拆解完成并已独立保存（未修改参考文案与二创文案）');
      } else {
        setErrMsg(res?.error || '执行全文拆解失败');
        setMsg('');
      }
    } catch (e: any) {
      setErrMsg(`执行全文拆解失败：${e?.message || e}`);
      setMsg('');
    } finally {
      setRunning(false);
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

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="p-2.5 border-b border-[#1e2e4a] bg-[#0d1526] space-y-2 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
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
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="gcw-btn-ghost px-2 py-1 rounded-lg gcw-text-tag inline-flex items-center gap-1"
          >
            <Upload className="w-3.5 h-3.5" /> 导入拆解Skill
          </button>

          <select
            value={selectedSkillId}
            onChange={(e) => setSelectedSkillId(e.target.value)}
            className="gcw-input flex-1 min-w-[140px] px-2 py-1 gcw-text-tag"
          >
            {skills.length === 0 ? (
              <option value="">待导入拆解 Skill</option>
            ) : (
              skills.map((s) => (
                <option key={s.skill_id} value={s.skill_id}>
                  {s.name}
                </option>
              ))
            )}
          </select>

          <select
            value={selectedModelKey}
            onChange={(e) => setSelectedModelKey(e.target.value)}
            className="gcw-input flex-1 min-w-[140px] px-2 py-1 gcw-text-tag"
          >
            {models.map((m) => (
              <option key={`${m.engine_id}::${m.model_id}`} value={`${m.engine_id}::${m.model_id}`}>
                {m.label || m.name}{m.configured || m.ready ? '' : '（未就绪）'}
              </option>
            ))}
          </select>

          <select
            value={textMode}
            onChange={(e) => setTextMode(e.target.value as any)}
            className="gcw-input px-2 py-1 gcw-text-tag"
            title="输入文案来源"
          >
            <option value="original">输入：原文</option>
            <option value="zh">输入：译文</option>
            <option value="bilingual">输入：双语</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            value={extraReq}
            onChange={(e) => setExtraReq(e.target.value)}
            placeholder="输入额外拆解分析要求（可选）..."
            className="gcw-input flex-1 min-w-0 px-2.5 py-1 gcw-text-tag"
          />
          <button
            type="button"
            onClick={handleRun}
            disabled={!contentId || !selectedSkillId || running}
            className="gcw-btn-cyan px-3 py-1 rounded-lg gcw-text-tag font-semibold inline-flex items-center gap-1 shrink-0 disabled:opacity-40"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {running ? '拆解中...' : '执行拆解'}
          </button>
          {activeReport && (
            <>
              <button type="button" onClick={handleCopy} className="gcw-btn-ghost px-2 py-1 rounded-lg gcw-text-tag" title="复制拆解报告">
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <button type="button" onClick={handleExport} className="gcw-btn-ghost px-2 py-1 rounded-lg gcw-text-tag" title="导出拆解报告 Markdown">
                <Download className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>

        {msg && <div className="gcw-text-meta text-emerald-300">{msg}</div>}
        {errMsg && <div className="gcw-text-meta text-rose-300">{errMsg}</div>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5">
        {skills.length === 0 && !activeReport ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-slate-400 px-4">
            <FileSearch className="w-7 h-7 text-cyan-500/50" />
            <div className="gcw-text-base font-semibold text-slate-200">待导入拆解 Skill</div>
            <div className="gcw-text-tag text-slate-400">
              请点击上方「导入拆解Skill」导入你的 `.md / .txt / .json` 拆解指令文件。系统绝不硬编码模板或生成虚构拆解报告。
            </div>
          </div>
        ) : !activeReport ? (
          <div className="text-center py-8 text-slate-500 gcw-text-base">
            点击上方「执行拆解」使用当前视频完整参考文案生成拆解报告
          </div>
        ) : (
          <div className="space-y-2">
            {reports.length > 1 && (
              <select
                value={activeReport.id}
                onChange={(e) => setActiveReport(reports.find((x) => x.id === e.target.value) || reports[0])}
                className="gcw-input w-full px-2 py-1 gcw-text-meta"
              >
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.skill_name} · {r.model_id} · {formatLocalDateTime(r.created_at)}
                  </option>
                ))}
              </select>
            )}
            <div className="gcw-text-meta text-slate-400 font-mono-num">
              Skill：{activeReport.skill_name} · 模型：{activeReport.model_id} · 输入：{activeReport.text_mode} · 时间：{formatLocalDateTime(activeReport.created_at)}
            </div>
            <div className="p-3 rounded-xl bg-[#0c1424] border border-[#1e2e4a] gcw-text-base text-slate-200 whitespace-pre-wrap leading-relaxed">
              {activeReport.report_markdown}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
