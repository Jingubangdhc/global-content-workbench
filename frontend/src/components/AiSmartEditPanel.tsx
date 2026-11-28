import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  FolderOpen,
  History,
  Loader2,
  RefreshCw,
  Scissors,
  Send,
  Sparkles,
  Upload,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import type { ContentItem } from '../api';

interface Props {
  projectId: number;
  videoProjectId?: number;
  contents: ContentItem[];
  onJumpPublish?: () => void;
}

/**
 * KOUBO-SKILL-P2 · 麦田式浅色极简 AI 智能剪辑面板（ChatCut + Antigravity 正式融合）
 *
 * 原则：
 * - 真实状态驱动：创建任务后仅进入 WaitingForAgent，绝不假装一键自动运行；
 * - 明确标注商业受限 / 部分可用 / 规划中能力，禁止占位按钮冒充真实功能；
 * - 完整闭环：项目文案/本地视频导入 -> 创建任务 -> 查看视觉导演方案/日志/成片/不可变版本 -> 局部 AI 返修 -> 受信任推送至 PublishHub 草稿。
 */
export default function AiSmartEditPanel({ projectId, videoProjectId, contents, onJumpPublish }: Props) {
  const [statusInfo, setStatusInfo] = useState<any>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [selectedJob, setSelectedJob] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'plan' | 'logs' | 'quality' | 'segment' | 'cost'>('plan');

  // 新建任务表单
  const [title, setTitle] = useState('');
  const [sourceVideo, setSourceVideo] = useState('');
  const [selectedContentId, setSelectedContentId] = useState<number | ''>('');
  const [script, setScript] = useState('');
  const [skillId, setSkillId] = useState('premium-talk-edit');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [resolution, setResolution] = useState('1080x1920');
  const [autoStyle, setAutoStyle] = useState(true);
  const [opts, setOpts] = useState({
    auto_rough_cut: true,
    auto_captions: true,
    real_asset_match: true,
    smart_motion: true,
    custom_motion: true,
    camera_layout: true,
    sfx_and_bgm: true,
    auto_quality_check: true,
  });

  // 局部返修表单
  const [segStart, setSegStart] = useState('24');
  const [segEnd, setSegEnd] = useState('34');
  const [segReq, setSegReq] = useState('');
  const [segPreserve, setSegPreserve] = useState('非指定片段保持原剪辑点、动效与音效不变');
  const [segRule, setSegRule] = useState('');
  const [playVer, setPlayVer] = useState<number | null>(null);

  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const loadAll = async (focusJobId?: string) => {
    const [st, sk, jb] = await Promise.all([
      api.aiVideoStatus().catch(() => null),
      api.aiVideoSkills().catch(() => ({ skills: [] })),
      api.listAiVideoJobs(projectId).catch(() => ({ jobs: [] })),
    ]);
    setStatusInfo(st);
    setSkills(sk?.skills || []);
    const list = jb?.jobs || [];
    setJobs(list);
    const targetId = focusJobId || selectedJob?.job_id || list[0]?.job_id;
    if (targetId) {
      const detail = await api.getAiVideoJob(targetId).catch(() => null);
      if (detail?.job) {
        setSelectedJob(detail.job);
        setPlayVer(detail.job.versions?.[0]?.version_no ?? null);
      }
    }
  };

  useEffect(() => {
    loadAll();
  }, [projectId]);

  const handleImportContent = async (cid: number) => {
    setSelectedContentId(cid);
    const item = contents.find((c) => c.id === cid);
    if (item && !title) setTitle(`AI剪辑：${item.title.slice(0, 28)}`);
    try {
      const d = await api.contentDetail(cid);
      const txt = d?.transcript?.my_draft_text || d?.transcript?.translated_zh || d?.transcript?.raw_text || item?.title || '';
      setScript(txt);
      setMsg(`已从工作台内容 #${cid} 导入文案（${txt.length} 字）`);
    } catch {
      setMsg('已关联内容，但该内容暂无已提取文案，可直接手动粘贴');
    }
  };

  const handleUploadVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy('upload');
    try {
      const r = await api.uploadAiVideoSource(f);
      setSourceVideo(r.path);
      setMsg(`已导入本地视频：${f.name}（${(r.size_bytes / 1024 / 1024).toFixed(2)} MB）`);
    } catch (err: any) {
      setMsg('上传失败：' + err.message);
    } finally {
      setBusy('');
    }
  };

  const handleCreateJob = async () => {
    if (!title.trim() || !sourceVideo.trim()) {
      setMsg('请填写任务标题并指定本地视频路径');
      return;
    }
    setBusy('create');
    try {
      const r = await api.createAiVideoJob({
        project_id: projectId,
        video_project_id: videoProjectId,
        content_id: selectedContentId || undefined,
        title: title.trim(),
        source_video: sourceVideo.trim(),
        script: script.trim(),
        skill_id: skillId,
        aspect_ratio: aspectRatio,
        resolution,
        auto_style: autoStyle,
        options: opts,
      });
      setMsg(`✅ 已创建任务 ${r.job.job_id}（当前状态：${r.job.status}，请在 Antigravity 客户端下达领取指令）`);
      await loadAll(r.job.job_id);
    } catch (err: any) {
      setMsg('创建拦截/失败：' + err.message);
    } finally {
      setBusy('');
    }
  };

  const handleSegmentEdit = async () => {
    if (!selectedJob || !segReq.trim()) return;
    setBusy('segment');
    try {
      await api.submitAiSegmentEdit(selectedJob.job_id, {
        start_sec: Number(segStart),
        end_sec: Number(segEnd),
        base_version_no: playVer || selectedJob.versions?.[0]?.version_no || 1,
        edit_request: segReq.trim(),
        preserve_notes: segPreserve.trim(),
        propose_style_dna_rule: segRule.trim(),
      });
      setSegReq('');
      setSegRule('');
      setMsg('✅ 已提交局部返修指令（状态进入 WaitingForAgent，反馈规则已写入候选待审池）');
      await loadAll(selectedJob.job_id);
    } catch (err: any) {
      setMsg('提交返修失败：' + err.message);
    } finally {
      setBusy('');
    }
  };

  const handlePublish = async () => {
    if (!selectedJob) return;
    setBusy('publish');
    try {
      const r = await api.sendAiVideoToPublish(selectedJob.job_id, {
        version_no: playVer || undefined,
        title: selectedJob.input_manifest?.title,
      });
      setMsg(`✅ 受信任成片 v${r.version_no} 已创建多平台发布草稿 #${r.package_id}（需人工确认发布）`);
      if (onJumpPublish) setTimeout(() => onJumpPublish(), 700);
    } catch (err: any) {
      setMsg('推送发布失败：' + err.message);
    } finally {
      setBusy('');
    }
  };

  const badgeCls = (st: string) =>
    st === 'Completed'
      ? 'bg-[#EAF2E7] text-[#3E5A39] border-[#CFE0CA]'
      : ['Failed', 'Cancelled', 'Blocked'].includes(st)
      ? 'bg-[#FBECEB] text-[#A63B30] border-[#EAC4BF]'
      : 'bg-[#F7EEDB] text-[#8A601A] border-[#E7D4AF]';

  return (
    <div className="h-full overflow-y-auto rounded-xl bg-[#FAF8F4] text-[#2B2620] border border-[#E7DFD1] p-4">
      {/* 顶部真实连接状态条（麦田浅色极简） */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-4 border-b border-[#E7DFD1]">
        <div>
          <div className="text-sm font-bold flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-[#B98732]" />
            AI 智能剪辑（ChatCut Desktop + Google Antigravity 原生导演）
          </div>
          <div className="text-[11px] text-[#766D61]">
            当前工作台项目 #{projectId} · 创建任务后进入 WaitingForAgent，由 Antigravity 官方客户端通过双 MCP 真实执行
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
          <span className={`px-2.5 py-0.5 rounded-full border ${statusInfo?.antigravity_director?.workspace_plugin_configured ? 'bg-[#EAF2E7] text-[#3E5A39] border-[#CFE0CA]' : 'bg-[#FBECEB] text-[#A63B30] border-[#EAC4BF]'}`}>
            AI导演工作区插件: {statusInfo?.antigravity_director?.workspace_plugin_configured ? '已配置' : '未配置'}
          </span>
          <span className={`px-2.5 py-0.5 rounded-full border ${statusInfo?.chatcut_engine?.process_running ? 'bg-[#EAF2E7] text-[#3E5A39] border-[#CFE0CA]' : 'bg-[#FBECEB] text-[#A63B30] border-[#EAC4BF]'}`}>
            ChatCut 桌面: {statusInfo?.chatcut_engine?.process_running ? '运行中' : '未运行'}
          </span>
          <span className="px-2.5 py-0.5 rounded-full border bg-[#F4EFE6] text-[#5B5349] border-[#E7DFD1]">
            R1 动效: {statusInfo?.motion_registry?.approved_total ?? 0} 可执行 / {statusInfo?.motion_registry?.chatcut_jsx_compiled ?? 0} ChatCut JSX
          </span>
          <button onClick={() => loadAll()} className="px-2 py-0.5 rounded-lg border border-[#E7DFD1] bg-white hover:bg-[#F4EFE6] flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> 刷新
          </button>
        </div>
      </div>

      {msg && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-[#F7EEDB] border border-[#E7D4AF] text-xs text-[#7C5515] flex justify-between items-center">
          <span>{msg}</span>
          <button onClick={() => setMsg('')} className="text-[#8A601A] font-bold px-1">×</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 左侧：创建制作任务（麦田浅色卡片） */}
        <div className="lg:col-span-4 bg-white border border-[#E7DFD1] rounded-xl p-4 space-y-2.5">
          <div className="text-xs font-bold text-[#2B2620]">1. 导入素材与配置任务</div>

          <div>
            <label className="block text-[11px] font-semibold text-[#766D61] mb-1">从工作台文案/选题导入</label>
            <select
              value={selectedContentId}
              onChange={(e) => e.target.value && handleImportContent(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7DFD1] bg-[#FCFBF8] text-xs"
            >
              <option value="">-- 选择已有项目内容 --</option>
              {contents.map((c) => (
                <option key={c.id} value={c.id}>#{c.id} [{c.platform}] {c.title.slice(0, 32)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#766D61] mb-1">任务标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：P2 正式口播成片" className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7DFD1] bg-[#FCFBF8] text-xs" />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#766D61] mb-1 flex justify-between">
              <span>本地视频路径（或上传导入）</span>
              <label className="text-[#B98732] cursor-pointer flex items-center gap-0.5">
                <Upload className="w-3 h-3" /> 上传 MP4
                <input type="file" accept=".mp4,.mov,.webm" className="hidden" onChange={handleUploadVideo} />
              </label>
            </label>
            <input value={sourceVideo} onChange={(e) => setSourceVideo(e.target.value)} placeholder="C:\...\source.mp4" className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7DFD1] bg-[#FCFBF8] text-xs" />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#766D61] mb-1">口播参考文案</label>
            <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={3} placeholder="供 VisualDirector 分析语义分段与同音纠错..." className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7DFD1] bg-[#FCFBF8] text-xs" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-semibold text-[#766D61] mb-1">视频 Skill</label>
              <select value={skillId} onChange={(e) => setSkillId(e.target.value)} className="w-full px-2 py-1.5 rounded-lg border border-[#E7DFD1] bg-[#FCFBF8] text-xs">
                {skills.map((s) => (
                  <option key={s.skill_id} value={s.skill_id} disabled={s.execution_status === 'unimplemented'}>
                    {s.name} ({s.execution_status}{s.commercial_restricted ? '·非商用' : ''})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[#766D61] mb-1">画幅 / 分辨率</label>
              <select value={`${aspectRatio}|${resolution}`} onChange={(e) => { const [r, res] = e.target.value.split('|'); setAspectRatio(r); setResolution(res); }} className="w-full px-2 py-1.5 rounded-lg border border-[#E7DFD1] bg-[#FCFBF8] text-xs">
                <option value="9:16|1080x1920">9:16 竖屏 (1080×1920)</option>
                <option value="16:9|1920x1080">16:9 横屏 (1920×1080)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5 pt-1 text-[11px] text-[#5B5349]">
            {[
              ['auto_rough_cut', '自动粗剪/气口'],
              ['auto_captions', '自动字幕'],
              ['real_asset_match', '真实素材匹配'],
              ['smart_motion', '智能动效编排'],
              ['custom_motion', '原创 JSX 动效'],
              ['camera_layout', '运镜与人物布局'],
              ['sfx_and_bgm', '音效与响度控制'],
              ['auto_quality_check', '自动成片质检'],
            ].map(([k, lbl]) => (
              <label key={k} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(opts as any)[k]}
                  onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })}
                />
                {lbl}
              </label>
            ))}
          </div>

          <div className="flex items-center justify-between text-[11px] pt-1">
            <label className="flex items-center gap-1.5 text-[#5B5349]">
              <input type="checkbox" checked={autoStyle} onChange={(e) => setAutoStyle(e.target.checked)} />
              自动风格选择（结合个人 Style DNA）
            </label>
            <span className="text-[#9A8F80]" title="当前无合规官方无人值守接口，保留真实用户启动步骤">一键云端启动：未开放</span>
          </div>

          <button
            onClick={handleCreateJob}
            disabled={busy === 'create'}
            className="w-full py-2 rounded-lg bg-[#B98732] hover:bg-[#A67829] text-white text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {busy === 'create' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            创建制作任务（进入 WaitingForAgent）
          </button>
        </div>

        {/* 右侧：任务列表 + 详情/成片/局部返修/发布交接 */}
        <div className="lg:col-span-8 space-y-3">
          <div className="bg-white border border-[#E7DFD1] rounded-xl p-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-bold">2. 正式工作台 AI 剪辑任务队列（{jobs.length}）</span>
              <span className="text-[11px] text-[#766D61]">持久化于 data/workbench.db · 重启不丢失</span>
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {jobs.length === 0 && <div className="text-xs text-[#766D61] py-3 text-center">暂无任务，请在左侧创建。</div>}
              {jobs.map((j) => (
                <div
                  key={j.job_id}
                  onClick={async () => {
                    const d = await api.getAiVideoJob(j.job_id);
                    if (d?.job) {
                      setSelectedJob(d.job);
                      setPlayVer(d.job.versions?.[0]?.version_no ?? null);
                    }
                  }}
                  className={`p-2.5 rounded-lg border cursor-pointer transition flex items-center justify-between gap-2 ${
                    selectedJob?.job_id === j.job_id ? 'border-[#B98732] bg-[#FAF6EE]' : 'border-[#EAE3D7] hover:bg-[#FCFBF8]'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate">{j.input_manifest?.title || j.job_id}</div>
                    <div className="text-[11px] text-[#766D61]">
                      {j.job_id} · Skill: {j.skill_id} v{j.skill_version} · 工程: {j.external_project_id || '待创建'}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold shrink-0 ${badgeCls(j.status)}`}>{j.status}</span>
                </div>
              ))}
            </div>
          </div>

          {selectedJob && (
            <div className="bg-white border border-[#E7DFD1] rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-[#EAE3D7]">
                <div>
                  <div className="text-sm font-bold">{selectedJob.input_manifest?.title || selectedJob.job_id}</div>
                  <div className="text-[11px] text-[#766D61]">
                    状态: <strong>{selectedJob.status}</strong> · 不可变版本数: {selectedJob.versions?.length || 0} · ChatCut 工程: {selectedJob.external_project_id || '未创建'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    disabled={!selectedJob.external_project_path}
                    onClick={() => api.openChatCutProject(selectedJob.external_project_path)}
                    className="px-2.5 py-1 rounded-lg border border-[#E7DFD1] bg-[#FCFBF8] hover:bg-[#F4EFE6] text-xs flex items-center gap-1 disabled:opacity-40"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-[#B98732]" /> 打开 ChatCut 工程
                  </button>
                  <button
                    disabled={!selectedJob.output_video_path || busy === 'publish'}
                    onClick={handlePublish}
                    className="px-2.5 py-1 rounded-lg bg-[#4E6B48] hover:bg-[#3F593A] text-white text-xs font-medium flex items-center gap-1 disabled:opacity-40"
                  >
                    <Send className="w-3.5 h-3.5" /> 送入多平台发布草稿
                  </button>
                  <button
                    disabled={['Completed', 'Cancelled'].includes(selectedJob.status)}
                    onClick={async () => { await api.cancelAiVideoJob(selectedJob.job_id); loadAll(selectedJob.job_id); }}
                    className="px-2.5 py-1 rounded-lg border border-[#EAC4BF] bg-[#FBECEB] text-[#A63B30] text-xs flex items-center gap-1 disabled:opacity-40"
                  >
                    <XCircle className="w-3.5 h-3.5" /> 取消
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                {/* 左侧标签页 */}
                <div className="xl:col-span-7">
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {[
                      ['plan', '视觉导演方案'],
                      ['logs', '真实执行日志'],
                      ['quality', '成片质检'],
                      ['segment', '局部 AI 返修'],
                      ['cost', '费用与许可'],
                    ].map(([k, lbl]) => (
                      <button
                        key={k}
                        onClick={() => setActiveTab(k as any)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
                          activeTab === k ? 'bg-[#2B2620] text-white border-[#2B2620]' : 'bg-[#F4EFE6] text-[#5B5349] border-[#E7DFD1]'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>

                  {activeTab === 'plan' && (
                    <pre className="bg-[#FAF8F4] border border-[#E7DFD1] rounded-lg p-2.5 text-[11px] max-h-64 overflow-auto whitespace-pre-wrap">
                      {Object.keys(selectedJob.visual_plan || {}).length
                        ? JSON.stringify(selectedJob.visual_plan, null, 2)
                        : '尚未提交视觉导演方案（等待 Antigravity 原生 Agent 领取并分析逐词时间码）。'}
                    </pre>
                  )}

                  {activeTab === 'logs' && (
                    <pre className="bg-[#FAF8F4] border border-[#E7DFD1] rounded-lg p-2.5 text-[11px] max-h-64 overflow-auto whitespace-pre-wrap">
                      {JSON.stringify(selectedJob.execution_log || [], null, 2)}
                    </pre>
                  )}

                  {activeTab === 'quality' && (
                    selectedJob.quality_report?.raw_report ? (
                      <div>
                        <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold mb-2 ${selectedJob.quality_report.passed ? 'bg-[#EAF2E7] text-[#3E5A39] border-[#CFE0CA]' : 'bg-[#FBECEB] text-[#A63B30] border-[#EAC4BF]'}`}>
                          <CheckCircle2 className="w-3 h-3" /> {selectedJob.quality_report.summary}
                        </div>
                        <div className="text-[11px] text-[#766D61] mb-1.5">{selectedJob.quality_report.human_review_note}</div>
                        <pre className="bg-[#FAF8F4] border border-[#E7DFD1] rounded-lg p-2.5 text-[11px] max-h-56 overflow-auto whitespace-pre-wrap">
                          {selectedJob.quality_report.raw_report}
                        </pre>
                      </div>
                    ) : (
                      <div className="text-xs text-[#766D61] py-4">尚无质检报告。</div>
                    )
                  )}

                  {activeTab === 'segment' && (
                    <div className="bg-[#FAF8F4] border border-[#E7DFD1] rounded-lg p-3 space-y-2 text-xs">
                      <div className="font-semibold flex items-center gap-1"><Scissors className="w-3.5 h-3.5 text-[#B98732]" /> 局部 AI 重新剪辑（生成新版本，不覆盖原版）</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[11px] text-[#766D61]">起始秒</label>
                          <input value={segStart} onChange={(e) => setSegStart(e.target.value)} className="w-full px-2 py-1 rounded border border-[#E7DFD1] bg-white text-xs" />
                        </div>
                        <div>
                          <label className="text-[11px] text-[#766D61]">结束秒</label>
                          <input value={segEnd} onChange={(e) => setSegEnd(e.target.value)} className="w-full px-2 py-1 rounded border border-[#E7DFD1] bg-white text-xs" />
                        </div>
                      </div>
                      <textarea value={segReq} onChange={(e) => setSegReq(e.target.value)} rows={2} placeholder="输入修改要求（例如：将此段卡片替换为原创因果轨道动效并突出核心结论）" className="w-full px-2 py-1.5 rounded border border-[#E7DFD1] bg-white text-xs" />
                      <input value={segPreserve} onChange={(e) => setSegPreserve(e.target.value)} placeholder="保留不变的内容说明" className="w-full px-2 py-1 rounded border border-[#E7DFD1] bg-white text-xs" />
                      <input value={segRule} onChange={(e) => setSegRule(e.target.value)} placeholder="可选：沉淀为待审批候选 StyleDNA 规则（不直接污染全局）" className="w-full px-2 py-1 rounded border border-[#E7DFD1] bg-white text-xs" />
                      <button onClick={handleSegmentEdit} disabled={busy === 'segment'} className="px-3 py-1.5 rounded-lg bg-[#B98732] text-white text-xs font-semibold">
                        提交局部返修指令
                      </button>
                    </div>
                  )}

                  {activeTab === 'cost' && (
                    <div className="bg-[#FAF8F4] border border-[#E7DFD1] rounded-lg p-3 text-xs space-y-1.5">
                      <div><strong>Google AI Pro 会员：</strong>{selectedJob.cost_report?.google_ai_pro_member || '未知'}</div>
                      <div><strong>模型可见调用次数：</strong>{selectedJob.cost_report?.model_visible_calls ?? 0}</div>
                      <div><strong>ChatCut 积分变化：</strong>{selectedJob.cost_report?.chatcut_credits_before ?? '-'} → {selectedJob.cost_report?.chatcut_credits_after ?? '-'}（消耗 {selectedJob.cost_report?.chatcut_credits_used ?? 0}）</div>
                      <div><strong>额外付费 API：</strong>${selectedJob.cost_report?.extra_api_cost_usd ?? 0}</div>
                      <div><strong>本地渲染耗时：</strong>{selectedJob.cost_report?.local_render_sec ?? 0} 秒</div>
                      <div className="text-[11px] text-[#766D61] pt-1 border-t border-[#E7DFD1]">
                        商业化边界：当前仅限内部创作；非商业授权 Skill（CC BY-NC 4.0）与个人 Google AI Pro 会员严禁共享或打包商用。
                      </div>
                    </div>
                  )}
                </div>

                {/* 右侧：不可变版本选择 + 成片播放器 */}
                <div className="xl:col-span-5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-semibold text-[#766D61] flex items-center gap-1"><History className="w-3.5 h-3.5" /> 不可变成片预览</span>
                    {selectedJob.versions?.length > 0 && (
                      <select
                        value={playVer ?? ''}
                        onChange={(e) => setPlayVer(Number(e.target.value))}
                        className="px-2 py-0.5 rounded border border-[#E7DFD1] bg-[#FCFBF8] text-[11px]"
                      >
                        {selectedJob.versions.map((v: any) => (
                          <option key={v.version_no} value={v.version_no}>
                            v{v.version_no} ({v.edit_scope}) · {v.note?.slice(0, 18)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {selectedJob.output_video_path ? (
                    <video
                      key={`${selectedJob.job_id}-${playVer}`}
                      controls
                      className="w-full max-h-80 rounded-xl bg-black border border-[#E7DFD1]"
                      src={`/api/ai-video/jobs/${encodeURIComponent(selectedJob.job_id)}/video${playVer ? `?version_no=${playVer}` : ''}`}
                    />
                  ) : (
                    <div className="h-56 rounded-xl border border-dashed border-[#D8CFC0] bg-[#FAF8F4] flex items-center justify-center text-xs text-[#766D61] text-center px-4">
                      尚无已登记成片（当前状态：{selectedJob.status}）
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
