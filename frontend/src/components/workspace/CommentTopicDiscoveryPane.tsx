/**
 * FIX-08 / FIX-03-B · 高赞评论选题发现面板
 * - 修复 origin_type 为后端合法枚举 content_comment_discovery，入库时透传 comment_ids 写入结构化 topic_evidence
 * - 增加 reqSeqRef + projectId/contentId 归属守卫，防止快速切换项目/作品时旧请求污染当前界面
 * - 区分模型已配置、专用翻译模型与通用文案生成能力
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Plus, Sparkles } from 'lucide-react';
import { api, fmtNum } from '../../api';

interface Props {
  projectId: number;
  contentId: number | null;
  comments: any[];
  onTopicAdded?: (topicId: number) => void;
}

export default function CommentTopicDiscoveryPane({ projectId, contentId, comments, onTopicAdded }: Props) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [count, setCount] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [addingIdx, setAddingIdx] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');

  const reqSeqRef = useRef(0);
  const activeScopeRef = useRef({ projectId, contentId });
  activeScopeRef.current = { projectId, contentId };

  useEffect(() => {
    api
      .listWritingModels()
      .then((r) => {
        const list = r?.models || [];
        setModels(list);
        const ready =
          list.find((m: any) => m.ready && m.text_generation_capable) ||
          list.find((m: any) => m.configured && !m.is_translation_only) ||
          list[0];
        if (ready) setSelectedModelKey(`${ready.engine_id}::${ready.model_id}`);
      })
      .catch(() => {});
  }, []);

  // FIX-03-B (A04): 切换项目或作品时立即递增序号并清理旧结果与旧加载状态
  useEffect(() => {
    reqSeqRef.current += 1;
    setGenerating(false);
    setAddingIdx(null);
    setSelectedIds([]);
    setCandidates([]);
    setMsg('');
    setErrMsg('');
  }, [projectId, contentId]);

  const toggleId = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const runDiscover = async (ids: number[], n: number) => {
    if (!contentId || !ids.length || generating) return;
    const targetPid = projectId;
    const targetCid = contentId;
    const seq = ++reqSeqRef.current;
    const [engineId, modelId] = (selectedModelKey || '::').split('::');
    setGenerating(true);
    setErrMsg('');
    setMsg('正在基于所选真实评论提炼候选选题...');
    try {
      const res = await api.topicHubDiscoverTopicsFromComments({
        project_id: targetPid,
        content_id: targetCid,
        comment_ids: ids,
        count: n,
        engine_id: engineId || '',
        model_id: modelId || '',
      });
      if (
        seq !== reqSeqRef.current ||
        activeScopeRef.current.projectId !== targetPid ||
        activeScopeRef.current.contentId !== targetCid
      ) {
        return;
      }
      if (res?.ok && Array.isArray(res.candidates)) {
        setCandidates(res.candidates);
        setMsg(`✅ 已基于 ${ids.length} 条真实评论生成 ${res.candidates.length} 个候选选题（请预览编辑后确认加入选题库）`);
      } else {
        setErrMsg(res?.error || '生成候选选题失败');
        setMsg('');
      }
    } catch (e: any) {
      if (
        seq !== reqSeqRef.current ||
        activeScopeRef.current.projectId !== targetPid ||
        activeScopeRef.current.contentId !== targetCid
      ) {
        return;
      }
      setErrMsg(`生成候选选题失败：${e?.message || e}`);
      setMsg('');
    } finally {
      if (seq === reqSeqRef.current) setGenerating(false);
    }
  };

  const handleAddToLibrary = async (idx: number) => {
    const c = candidates[idx];
    if (!c || !c.suggested_title?.trim() || addingIdx !== null) return;
    const targetPid = projectId;
    const targetCid = contentId;
    setAddingIdx(idx);
    setErrMsg('');
    try {
      const res = await api.topicHubCreate({
        project_id: targetPid,
        topic_title: c.suggested_title.trim(),
        research_question: c.user_pain_point || '',
        angle: c.angle || '',
        origin_type: 'content_comment_discovery',
        production_status: '待研究',
        discovery_reason: `来源真实高赞评论 #${c.source_comment_id}（赞 ${c.comment_likes ?? 0}）：${(c.source_comment_text || '').slice(0, 180)} | 模型：${c.model_id}`,
        content_ids: targetCid ? [targetCid] : [],
        comment_ids: c.source_comment_id ? [Number(c.source_comment_id)] : [],
      });
      if (activeScopeRef.current.projectId !== targetPid || activeScopeRef.current.contentId !== targetCid) return;
      if (res?.ok && res.topic?.id) {
        setCandidates((prev) => prev.map((x, i) => (i === idx ? { ...x, added_topic_id: res.topic.id } : x)));
        setMsg(`✅ 已加入选题库：#${res.topic.id}「${res.topic.topic_title}」（状态：待研究 · U级未验证 · 已写入结构化视频与评论证据）`);
        onTopicAdded?.(res.topic.id);
      } else {
        setErrMsg(res?.error || '加入选题库失败');
      }
    } catch (e: any) {
      if (activeScopeRef.current.projectId !== targetPid || activeScopeRef.current.contentId !== targetCid) return;
      setErrMsg(`加入选题库失败：${e?.message || e}`);
    } finally {
      setAddingIdx(null);
    }
  };

  return (
    <div className="gcw-panel h-full overflow-y-auto p-3.5 space-y-3">
      {/* 顶部批量操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#1e2e4a]">
        <div className="gcw-section-title text-slate-100">高赞评论选题发现（已选 {selectedIds.length}/{comments.length} 条）</div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={selectedModelKey}
            onChange={(e) => setSelectedModelKey(e.target.value)}
            className="gcw-input px-2 py-1 gcw-text-tag max-w-[240px]"
          >
            {models.map((m) => (
              <option key={`${m.engine_id}::${m.model_id}`} value={`${m.engine_id}::${m.model_id}`}>
                {m.label || m.name}
                {m.is_translation_only ? '（仅限翻译）' : m.configured ? '' : '（未配置）'}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={10}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(10, Number(e.target.value) || 3)))}
            className="gcw-input w-16 px-2 py-1 gcw-text-tag font-mono-num"
            title="自定义生成候选选题数量"
          />
          <button
            type="button"
            onClick={() => runDiscover(selectedIds, count)}
            disabled={!selectedIds.length || generating}
            className="gcw-btn-purple px-3 py-1 rounded-lg gcw-text-tag font-semibold inline-flex items-center gap-1 disabled:opacity-40"
          >
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            批量生成候选选题
          </button>
        </div>
      </div>

      {msg && (
        <div className="gcw-text-tag text-emerald-300 flex items-center gap-1">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {msg}
        </div>
      )}
      {errMsg && <div className="gcw-text-tag text-rose-300 break-words">{errMsg}</div>}

      {/* 候选选题预览与编辑区 */}
      {candidates.length > 0 && (
        <div className="p-3 rounded-xl bg-[#0e172a] border border-cyan-500/40 space-y-2.5">
          <div className="gcw-text-btn font-semibold text-cyan-300">候选选题预览（可编辑后确认加入选题库）</div>
          {candidates.map((c, idx) => (
            <div key={idx} className="p-2.5 rounded-lg bg-[#0c1424] border border-[#1e2e4a] space-y-1.5">
              <div className="flex items-center gap-2">
                <input
                  value={c.suggested_title}
                  onChange={(e) => setCandidates((prev) => prev.map((x, i) => (i === idx ? { ...x, suggested_title: e.target.value } : x)))}
                  className="gcw-input flex-1 px-2.5 py-1 gcw-text-btn font-semibold"
                />
                {c.added_topic_id ? (
                  <span className="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 gcw-text-tag shrink-0">
                    已入库 #{c.added_topic_id}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleAddToLibrary(idx)}
                    disabled={addingIdx !== null}
                    className="gcw-btn-cyan px-3 py-1 rounded-lg gcw-text-tag font-semibold inline-flex items-center gap-1 shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" /> 加入选题库
                  </button>
                )}
              </div>
              <div className="gcw-text-meta text-slate-300">痛点：{c.user_pain_point || '—'} · 角度：{c.angle || '—'}</div>
              <div className="gcw-text-meta text-slate-400 font-mono-num">
                来源评论 #{c.source_comment_id}（赞 {fmtNum(c.comment_likes)}）：{(c.source_comment_text || '').slice(0, 100)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 真实评论列表 */}
      {!comments.length ? (
        <div className="text-slate-500 gcw-text-base py-6">当前作品暂无已采集的真实评论数据</div>
      ) : (
        <div className="space-y-2">
          {comments.map((c: any) => {
            const checked = selectedIds.includes(c.id);
            return (
              <div
                key={c.id}
                className={`p-3 rounded-xl border transition space-y-1.5 ${
                  checked ? 'bg-cyan-500/10 border-cyan-500/50' : 'bg-[#0c1424] border-[#1e2e4a]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-2 cursor-pointer gcw-text-tag text-slate-300">
                    <input type="checkbox" checked={checked} onChange={() => toggleId(c.id)} className="accent-cyan-400" />
                    <span>{c.author || '匿名用户'}</span>
                    <span className="font-mono-num text-cyan-300">赞 {fmtNum(c.like_count)}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => runDiscover([c.id], 1)}
                    disabled={generating}
                    className="gcw-btn-ghost px-2.5 py-0.5 rounded-lg gcw-text-meta inline-flex items-center gap-1"
                  >
                    <Sparkles className="w-3 h-3 text-purple-400" /> 生成选题
                  </button>
                </div>
                <div className="gcw-text-base text-slate-200">{c.text}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
