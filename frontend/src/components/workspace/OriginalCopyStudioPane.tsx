/**
 * GCW-WORKSPACE-05 · 原创文案与 Skill 创作工作区（右侧面板）
 * - 复用现有 script-skills / writing-models / studio-versions API，绝不复制 1286 行 TranscriptStudio
 * - 参考文案、翻译文案、原创草稿、正式原创版本四者严格隔离，绝不覆盖参考原文
 * - 切换同一选题的不同参考视频时保留当前原创草稿；切换选题或项目时自动保存并加载对应草稿（带 reqSeq 防异步竞态）
 * - 自动保存失败明确提示，绝不显示虚假保存成功
 * - 生成新文案前若编辑区已有内容，先弹窗确认防止未经确认覆盖
 */
import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  History,
  Loader2,
  PenTool,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../../api';
import { formatLocalDateTime } from './VideoMetricsBar';

interface Props {
  projectId: number;
  topicId: number | null;
  topicTitle: string;
  activeContentId: number | null;
  topicContents: any[];
}

export default function OriginalCopyStudioPane({
  projectId,
  topicId,
  topicTitle,
  activeContentId,
  topicContents,
}: Props) {
  const [skills, setSkills] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState('fact_separated_deep_dive');
  const [selectedModelKey, setSelectedModelKey] = useState(''); // `${engine_id}::${model_id}`
  const [selectedRefIds, setSelectedRefIds] = useState<number[]>([]);
  const [extraReq, setExtraReq] = useState('');

  // 原创草稿编辑态
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftState, setDraftState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [draftErr, setDraftErr] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);

  // 正式版本列表与生成态
  const [versions, setVersions] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [savingVer, setSavingVer] = useState(false);
  const [msg, setMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');

  // 自定义/导入 Skill 表单
  const [showCustomSkill, setShowCustomSkill] = useState(false);
  const [csName, setCsName] = useState('');
  const [csDesc, setCsDesc] = useState('');
  const [csPrompt, setCsPrompt] = useState('');

  const topicLoadSeqRef = useRef(0);
  const genSeqRef = useRef(0);
  const loadedTopicIdRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadSkillsAndModels = async () => {
    try {
      const [skRes, mdRes] = await Promise.all([api.topicHubScriptSkills(), api.listWritingModels()]);
      const skList = skRes?.skills || [];
      setSkills(skList);
      if (skList.length && !skList.some((s: any) => s.skill_id === selectedSkillId)) {
        setSelectedSkillId(skList[0].skill_id);
      }
      const mdList = mdRes?.models || [];
      setModels(mdList);
      if (mdList.length && !selectedModelKey) {
        const firstReady = mdList.find((m: any) => m.ready) || mdList[0];
        if (firstReady) setSelectedModelKey(`${firstReady.engine_id}::${firstReady.model_id}`);
      }
    } catch {
      // 忽略首次拉取异常
    }
  };

  useEffect(() => {
    loadSkillsAndModels();
  }, []);

  // 默认勾选当前选题下所有参考作品（仅在切换选题时重置）
  useEffect(() => {
    const ids = (topicContents || []).map((c: any) => Number(c.content_id || c.id)).filter(Boolean);
    setSelectedRefIds(ids);
  }, [topicId]);

  // 切换选题时：加载对应选题的独立草稿与历史正式版本（带 reqSeq 防竞态）
  useEffect(() => {
    const seq = ++topicLoadSeqRef.current;
    loadedTopicIdRef.current = null;
    dirtyRef.current = false;
    setDraftState('idle');
    setDraftErr('');
    setMsg('');
    setErrMsg('');
    if (!topicId) {
      setDraftTitle('');
      setDraftContent('');
      setExtraReq('');
      setVersions([]);
      return;
    }
    Promise.all([
      api.topicHubGetDraft(topicId).catch(() => null),
      api.listStudioOriginalVersions(projectId, null, topicId).catch(() => null),
    ]).then(([dr, vr]) => {
      if (seq !== topicLoadSeqRef.current) return;
      const d = dr?.draft || {};
      setDraftTitle(d.title || topicTitle || '');
      setDraftContent(d.content || '');
      setExtraReq(d.extra_requirements || '');
      if (d.skill_id) setSelectedSkillId(d.skill_id);
      if (d.engine_id && d.model_id) setSelectedModelKey(`${d.engine_id}::${d.model_id}`);
      setDraftSavedAt(d.updated_at || null);
      setVersions(vr?.versions || []);
      loadedTopicIdRef.current = topicId;
    });
  }, [topicId, projectId]);

  // 防抖自动保存草稿（仅当当前选题已加载且用户修改过；保存失败明确报错）
  useEffect(() => {
    if (!topicId || loadedTopicIdRef.current !== topicId || !dirtyRef.current) return;
    const targetTid = topicId;
    const [engineId, modelId] = (selectedModelKey || '::').split('::');
    const timer = setTimeout(async () => {
      setDraftState('saving');
      setDraftErr('');
      try {
        const res = await api.topicHubSaveDraft(targetTid, {
          title: draftTitle,
          content: draftContent,
          extra_requirements: extraReq,
          skill_id: selectedSkillId,
          engine_id: engineId || '',
          model_id: modelId || '',
        });
        if (loadedTopicIdRef.current !== targetTid) return;
        if (res?.ok) {
          dirtyRef.current = false;
          setDraftState('saved');
          setDraftSavedAt(res.draft?.updated_at || new Date().toISOString());
        } else {
          setDraftState('error');
          setDraftErr(res?.error || '草稿自动保存失败');
        }
      } catch (e: any) {
        if (loadedTopicIdRef.current !== targetTid) return;
        setDraftState('error');
        setDraftErr(`草稿自动保存失败：${e?.message || e}`);
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [draftTitle, draftContent, extraReq, selectedSkillId, selectedModelKey, topicId]);

  const handleImportSkillFile = async (file: File) => {
    try {
      const text = await file.text();
      const baseName = file.name.replace(/\.(md|txt|json)$/i, '');
      let name = baseName;
      let description = `从 ${file.name} 导入`;
      let system_prompt = text;
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text);
        name = parsed.name || baseName;
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
        setMsg(`✅ 已导入 Skill「${name}」`);
      }
    } catch (e: any) {
      setErrMsg(`导入 Skill 失败：${e?.message || e}`);
    }
  };

  const handleSaveCustomSkill = async () => {
    if (!csName.trim() || !csPrompt.trim()) {
      setErrMsg('自定义 Skill 名称和指令内容不能为空');
      return;
    }
    try {
      const res = await api.saveCustomScriptSkill({
        name: csName.trim(),
        description: csDesc.trim(),
        system_prompt: csPrompt.trim(),
        source_format: 'manual',
      });
      if (res?.ok) {
        setCsName('');
        setCsDesc('');
        setCsPrompt('');
        setShowCustomSkill(false);
        await loadSkillsAndModels();
        if (res.skill?.skill_id) setSelectedSkillId(res.skill.skill_id);
        setMsg('✅ 已保存自定义 Skill');
      }
    } catch (e: any) {
      setErrMsg(`保存自定义 Skill 失败：${e?.message || e}`);
    }
  };

  const handleDeleteCurrentSkill = async () => {
    const cur = skills.find((s) => s.skill_id === selectedSkillId);
    if (!cur || !cur.is_custom) return;
    if (!window.confirm(`确定删除自定义 Skill「${cur.name}」吗？`)) return;
    try {
      await api.deleteCustomScriptSkill(cur.skill_id);
      await loadSkillsAndModels();
      setMsg(`已删除自定义 Skill「${cur.name}」`);
    } catch (e: any) {
      setErrMsg(`删除 Skill 失败：${e?.message || e}`);
    }
  };

  const handleGenerate = async () => {
    if (!topicId || generating) return;
    if (draftContent.trim() && !window.confirm('当前编辑区已有原创文案内容，确认用新生成的文案替换编辑区吗？（原有已保存的正式版本不会丢失）')) {
      return;
    }
    const targetTid = topicId;
    const seq = ++genSeqRef.current;
    const [engineId, modelId] = (selectedModelKey || '::').split('::');
    setGenerating(true);
    setErrMsg('');
    setMsg('正在调用所选 Skill 与模型生成原创文案...');
    try {
      const refIds = selectedRefIds.length ? selectedRefIds : activeContentId ? [activeContentId] : [];
      const res = await api.generateStudioOriginalVersion({
        project_id: projectId,
        topic_id: targetTid,
        primary_content_id: activeContentId || refIds[0] || null,
        reference_content_ids: refIds,
        skill_id: selectedSkillId,
        engine_id: engineId || '',
        model_id: modelId || '',
        extra_requirements: extraReq.trim(),
        title: draftTitle.trim() || `${topicTitle} · 原创文案`,
      });
      // 严格防止异步模型结果写入用户后来切换的其他选题
      if (seq !== genSeqRef.current || loadedTopicIdRef.current !== targetTid) return;
      if (res?.ok && res.version) {
        setDraftTitle(res.version.title || draftTitle);
        setDraftContent(res.version.content || '');
        dirtyRef.current = true;
        const vr = await api.listStudioOriginalVersions(projectId, null, targetTid);
        if (loadedTopicIdRef.current === targetTid) setVersions(vr?.versions || []);
        setMsg(`✅ 已生成独立原创版本 #${res.version.version_no}（原文未受任何修改）`);
      } else {
        setErrMsg(res?.error || '生成原创文案失败');
        setMsg('');
      }
    } catch (e: any) {
      if (seq !== genSeqRef.current || loadedTopicIdRef.current !== targetTid) return;
      setErrMsg(`生成原创文案失败：${e?.message || e}`);
      setMsg('');
    } finally {
      if (seq === genSeqRef.current) setGenerating(false);
    }
  };

  const handleSaveOfficialVersion = async () => {
    if (!topicId || !draftContent.trim() || savingVer) return;
    setSavingVer(true);
    setErrMsg('');
    try {
      const [engineId, modelId] = (selectedModelKey || '::').split('::');
      const refIds = selectedRefIds.length ? selectedRefIds : activeContentId ? [activeContentId] : [];
      const res = await api.generateStudioOriginalVersion({
        project_id: projectId,
        topic_id: topicId,
        primary_content_id: activeContentId || refIds[0] || null,
        reference_content_ids: refIds,
        skill_id: selectedSkillId,
        engine_id: engineId || '',
        model_id: modelId || '',
        extra_requirements: extraReq.trim(),
        title: draftTitle.trim() || `${topicTitle} · 人工修订版`,
        manual_content: draftContent,
      });
      if (res?.ok && res.version) {
        const vr = await api.listStudioOriginalVersions(projectId, null, topicId);
        setVersions(vr?.versions || []);
        setMsg(`✅ 已保存为独立正式版本 #${res.version.version_no}`);
      } else {
        setErrMsg(res?.error || '保存正式版本失败');
      }
    } catch (e: any) {
      setErrMsg(`保存正式版本失败：${e?.message || e}`);
    } finally {
      setSavingVer(false);
    }
  };

  const handleExportOriginal = () => {
    if (!draftContent.trim()) return;
    const blob = new Blob([`# ${draftTitle || topicTitle}\n\n${draftContent}`], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `original_copy_topic_${topicId || 'draft'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const curSkill = skills.find((s) => s.skill_id === selectedSkillId);

  return (
    <div className="gcw-panel flex flex-col h-full min-h-0 overflow-hidden">
      {/* 顶部栏 */}
      <div className="gcw-panel-header px-3 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <PenTool className="w-4 h-4 text-purple-400 shrink-0" />
          <span className="gcw-section-title text-slate-100">原创文案</span>
          <span className="gcw-text-tag text-slate-400">
            {draftState === 'saving'
              ? '草稿保存中...'
              : draftState === 'saved'
              ? `草稿已保存 ${draftSavedAt ? formatLocalDateTime(draftSavedAt).slice(-5) : ''}`
              : draftState === 'error'
              ? '草稿保存失败'
              : `${versions.length} 个正式版本`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportSkillFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="gcw-btn-ghost px-2 py-0.5 rounded-lg gcw-text-tag inline-flex items-center gap-1"
            title="导入本地 .md / .txt / .json Skill 文件"
          >
            <Upload className="w-3.5 h-3.5" /> 导入Skill
          </button>
          <button
            type="button"
            onClick={() => setShowCustomSkill((v) => !v)}
            className="gcw-btn-ghost px-2 py-0.5 rounded-lg gcw-text-tag inline-flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> 自定义
          </button>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className={`px-2 py-0.5 rounded-lg gcw-text-tag border inline-flex items-center gap-1 ${
              showHistory ? 'bg-purple-500/20 border-purple-400/50 text-purple-200' : 'gcw-btn-ghost'
            }`}
          >
            <History className="w-3.5 h-3.5" /> 历史({versions.length})
          </button>
          <button
            type="button"
            onClick={handleExportOriginal}
            disabled={!draftContent.trim()}
            className="gcw-btn-ghost px-2 py-0.5 rounded-lg gcw-text-tag inline-flex items-center gap-1 disabled:opacity-40"
            title="导出原创文案 Markdown"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Skill & 模型选择控制区 */}
      <div className="px-3 py-2 border-b border-[#1e2e4a] bg-[#0d1526] space-y-2 shrink-0">
        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-6 flex items-center gap-1">
            <select
              value={selectedSkillId}
              onChange={(e) => {
                setSelectedSkillId(e.target.value);
                dirtyRef.current = true;
              }}
              className="gcw-input flex-1 min-w-0 px-2 py-1 gcw-text-btn"
              title="选择创作 Skill"
            >
              {skills.map((s) => (
                <option key={s.skill_id} value={s.skill_id}>
                  {s.is_custom ? `[自定义] ${s.name}` : s.name}
                </option>
              ))}
            </select>
            {curSkill?.is_custom && (
              <button
                type="button"
                onClick={handleDeleteCurrentSkill}
                className="p-1.5 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 shrink-0"
                title="删除此自定义 Skill"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="col-span-6">
            <select
              value={selectedModelKey}
              onChange={(e) => {
                setSelectedModelKey(e.target.value);
                dirtyRef.current = true;
              }}
              className="gcw-input w-full px-2 py-1 gcw-text-btn"
              title="选择执行此 Skill 的 AI 模型"
            >
              {models.map((m) => (
                <option key={`${m.engine_id}::${m.model_id}`} value={`${m.engine_id}::${m.model_id}`}>
                  {m.label || `${m.engine_id} / ${m.model_id}`}{m.ready ? '' : '（未就绪）'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 额外创作要求 + 生成 & 保存按钮 */}
        <div className="flex items-center gap-2">
          <input
            value={extraReq}
            onChange={(e) => {
              setExtraReq(e.target.value);
              dirtyRef.current = true;
            }}
            placeholder="输入额外创作要求（如口语风格、时长、目标受众、禁用词...）"
            className="gcw-input flex-1 min-w-0 px-2.5 py-1 gcw-text-btn"
          />
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!topicId || generating}
            className="gcw-btn-purple px-3 py-1 rounded-lg gcw-text-btn font-semibold inline-flex items-center gap-1.5 shrink-0 disabled:opacity-40"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {generating ? '生成中...' : '生成原创'}
          </button>
          <button
            type="button"
            onClick={handleSaveOfficialVersion}
            disabled={!topicId || !draftContent.trim() || savingVer}
            className="gcw-btn-cyan px-3 py-1 rounded-lg gcw-text-btn font-semibold inline-flex items-center gap-1 shrink-0 disabled:opacity-40"
            title="将当前编辑区保存为一条独立的历史正式版本"
          >
            {savingVer ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            存版本
          </button>
        </div>

        {/* 自定义 Skill 内嵌表单 */}
        {showCustomSkill && (
          <div className="p-2.5 rounded-lg bg-[#111a2e] border border-[#2c4268] space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                value={csName}
                onChange={(e) => setCsName(e.target.value)}
                placeholder="Skill 名称"
                className="gcw-input px-2 py-1 gcw-text-btn"
              />
              <input
                value={csDesc}
                onChange={(e) => setCsDesc(e.target.value)}
                placeholder="简短说明（可选）"
                className="gcw-input px-2 py-1 gcw-text-btn"
              />
            </div>
            <textarea
              value={csPrompt}
              onChange={(e) => setCsPrompt(e.target.value)}
              rows={3}
              placeholder="输入 Skill 系统指令..."
              className="gcw-input w-full px-2 py-1 gcw-text-base"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCustomSkill(false)} className="gcw-btn-ghost px-2.5 py-1 rounded gcw-text-tag">
                取消
              </button>
              <button type="button" onClick={handleSaveCustomSkill} className="gcw-btn-cyan px-3 py-1 rounded gcw-text-tag font-semibold">
                保存 Skill
              </button>
            </div>
          </div>
        )}

        {(msg || errMsg || draftErr) && (
          <div className="space-y-1">
            {msg && (
              <div className="gcw-text-tag text-emerald-300 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {msg}
              </div>
            )}
            {(errMsg || draftErr) && <div className="gcw-text-tag text-rose-300">{errMsg || draftErr}</div>}
          </div>
        )}
      </div>

      {/* 历史正式版本抽屉 or 主编辑区 */}
      {showHistory ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {!versions.length ? (
            <div className="text-center py-8 text-slate-500 gcw-text-base">当前选题暂无已保存的原创文案正式版本</div>
          ) : (
            versions.map((v) => (
              <div key={v.id} className="p-3 rounded-lg bg-[#0c1424] border border-[#1e2e4a] space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="gcw-text-btn font-semibold text-slate-100 truncate">
                    #{v.version_no} {v.title || '原创文案'}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (draftContent.trim() && !window.confirm('确认将此历史版本恢复到编辑区吗？')) return;
                      setDraftTitle(v.title || draftTitle);
                      setDraftContent(v.content || '');
                      dirtyRef.current = true;
                      setShowHistory(false);
                      setMsg(`已恢复历史版本 #${v.version_no} 至编辑区`);
                    }}
                    className="gcw-btn-cyan px-2.5 py-0.5 rounded gcw-text-tag shrink-0"
                  >
                    恢复到编辑区
                  </button>
                </div>
                <div className="gcw-text-meta text-slate-400">
                  Skill：{v.skill_id || '—'} · 模型：{v.model_id || '—'} · 时间：{formatLocalDateTime(v.created_at)}
                </div>
                <div className="gcw-text-tag text-slate-300 line-clamp-3 whitespace-pre-wrap">{v.content}</div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
          <input
            value={draftTitle}
            onChange={(e) => {
              setDraftTitle(e.target.value);
              dirtyRef.current = true;
            }}
            placeholder="原创文案标题..."
            className="gcw-input px-3 py-1.5 gcw-video-title font-semibold shrink-0"
          />
          <textarea
            value={draftContent}
            onChange={(e) => {
              setDraftContent(e.target.value);
              dirtyRef.current = true;
            }}
            placeholder="在此编辑原创文案（自动保存为当前选题独立草稿，绝不覆盖参考原文）..."
            className="gcw-input gcw-editor-text flex-1 min-h-0 w-full p-3 resize-none leading-relaxed"
          />
        </div>
      )}
    </div>
  );
}
