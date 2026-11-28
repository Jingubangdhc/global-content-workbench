/** 前端 API 封装与核心类型定义 */

export interface Project {
  id: number;
  name: string;
  target_country: string;
  target_audience: string;
  notes: string;
}

export interface KeywordItem {
  id: number;
  project_id: number;
  category: string;
  subcategory: string;
  keyword: string;
  audience: string;
  formula_note: string;
  verify_warning: string;
  last_searched_at?: string;
  content_count: number;
  transcript_count: number;
}

export interface ContentItem {
  id: number;
  project_id?: number;
  keyword_id?: number;
  creator_id?: number;
  platform: string;
  platform_item_id: string;
  content_type?: string;
  title: string;
  url: string;
  thumbnail_url?: string;
  published_at?: string;
  duration_sec?: number;
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  views_to_followers?: number | null;
  outlier_score?: number | null;
  collect_reason?: string;
  detected_links_json?: string;
  status: string;
  creator_name?: string;
  creator_handle?: string;
  creator_profile_url?: string;
  follower_count?: number | null;
  baseline_median_views?: number | null;
  keyword_text?: string;
  has_transcript?: number;
  hook_analysis?: string;
  script_template_type?: string;
  extract_error?: string;
}

export interface CreatorItem {
  id: number;
  platform: string;
  platform_creator_id: string;
  name: string;
  handle: string;
  profile_url: string;
  follower_count?: number | null;
  baseline_median_views?: number | null;
  detected_monetization_json?: string;
  strengths_note?: string;
  estimated_monthly_rev_note?: string;
  is_starred: number;
  video_count: number;
  max_outlier?: number | null;
}

export interface ToolRecord {
  id: number;
  tool_id?: number;
  cap_id?: number;
  name: string;
  url: string;
  domain: string;
  access_scope: string;
  fee_tier: 'free' | 'freemium' | 'paid' | 'unknown';
  fee_detail?: string;
  pricing_evidence_url?: string;
  my_status: string;
  my_monthly_cost?: number | null;
  my_expire_date?: string | null;
  is_pinned: number;
  my_note?: string;
  major_group: string;
  category: string;
  region: string;
  target_platform: string;
  data_nature?: string;
  metrics_desc?: string;
  operation_path?: string;
  limitation_warning?: string;
  priority?: string;
}

export interface ScriptTemplate {
  id: number;
  template_type: string;
  hook_strategy: string;
  sample_hook: string;
  structure_desc: string;
  visual_evidence: string;
  ending_idea: string;
  cta: string;
  precaution: string;
}

export interface RevenueEvidence {
  id: number;
  niche: string;
  monetization_type: string;
  platform: string;
  content_format: string;
  audience_region: string;
  metric_name: string;
  amount_min?: number | null;
  amount_max?: number | null;
  currency: string;
  period_desc?: string;
  evidence_level: string;
  source_url?: string;
  note?: string;
  created_at?: string;
}

async function req<T = any>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const txt = await res.text();
    let msg = txt;
    try {
      const j = JSON.parse(txt);
      msg = j.detail || txt;
    } catch {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  bootstrap: () => req('/api/bootstrap'),
  saveSettings: (body: any) => req('/api/settings', { method: 'POST', body: JSON.stringify(body) }),
  douyinApiHealth: (base?: string) => req(`/api/douyin-api/health${base ? `?base=${encodeURIComponent(base)}` : ''}`),
  createProject: (body: any) => req('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  deleteProject: (id: number) => req(`/api/projects/${id}`, { method: 'DELETE' }),

  listKeywords: (projectId?: number) => req<KeywordItem[]>(`/api/keywords${projectId ? `?project_id=${projectId}` : ''}`),
  addKeyword: (body: any) => req('/api/keywords', { method: 'POST', body: JSON.stringify(body) }),
  delKeyword: (id: number) => req(`/api/keywords/${id}`, { method: 'DELETE' }),

  jumpLinks: (q: string) => req(`/api/search/jump-links?q=${encodeURIComponent(q)}`),
  searchYouTube: (keyword: string, keyword_id?: number, sort_by = 'relevance') =>
    req('/api/search/youtube', { method: 'POST', body: JSON.stringify({ keyword, keyword_id, limit: 18, sort_by }) }),
  calcOutlier: (url: string) =>
    req('/api/search/youtube-outlier', { method: 'POST', body: JSON.stringify({ url }) }),
  searchBilibili: (keyword: string) =>
    req('/api/search/bilibili', { method: 'POST', body: JSON.stringify({ keyword, limit: 8 }) }),
  searchWeb: (keyword: string) =>
    req('/api/search/web', { method: 'POST', body: JSON.stringify({ keyword }) }),
  hotTrends: (force = false) => req(`/api/trends/hot?force=${force ? 'true' : 'false'}`),

  collectLinks: (body: any) => req('/api/collect', { method: 'POST', body: JSON.stringify(body) }),
  importCsv: async (file: File, projectId?: number) => {
    const fd = new FormData();
    fd.append('file', file);
    if (projectId) fd.append('project_id', String(projectId));
    const res = await fetch('/api/collect/csv', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  listContents: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '' && v !== 'all') qs.set(k, String(v));
    });
    return req<ContentItem[]>(`/api/contents?${qs.toString()}`);
  },
  patchContent: (id: number, body: any) => req(`/api/contents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delContent: (id: number) => req(`/api/contents/${id}`, { method: 'DELETE' }),

  listCreators: (platform?: string) => req<CreatorItem[]>(`/api/creators${platform && platform !== 'all' ? `?platform=${platform}` : ''}`),
  patchCreator: (id: number, body: any) => req(`/api/creators/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  trackCreator: (body: { profile_url: string; project_id?: number; limit?: number; strengths_note?: string }) =>
    req('/api/creators/track', { method: 'POST', body: JSON.stringify(body) }),
  refreshCreator: (id: number, limit = 15) => req(`/api/creators/${id}/refresh?limit=${limit}`, { method: 'POST' }),
  creatorVideos: (id: number) => req<{ creator: CreatorItem; videos: ContentItem[] }>(`/api/creators/${id}/videos`),
  delCreator: (id: number) => req(`/api/creators/${id}`, { method: 'DELETE' }),

  getTranscript: (cid: number) => req(`/api/transcripts/${cid}`),
  extractTranscript: (cid: number) => req(`/api/extract/${cid}`, { method: 'POST' }),
  uploadAudioTranscribe: async (cid: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/extract/upload/${cid}`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  saveTranscript: (cid: number, body: any) => req(`/api/transcripts/${cid}`, { method: 'PUT', body: JSON.stringify(body) }),
  translateTranscript: (cid: number) => req(`/api/transcripts/${cid}/translate`, { method: 'POST' }),

  listTools: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v && v !== 'all') qs.set(k, v);
    });
    return req<ToolRecord[]>(`/api/tools?${qs.toString()}`);
  },
  patchTool: (toolId: number, body: any) => req(`/api/tools/${toolId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  createTool: (body: any) => req('/api/tools', { method: 'POST', body: JSON.stringify(body) }),

  revenueMatrix: (viewMode: string) => req<{ items: ToolRecord[] }>(`/api/revenue/matrix?view_mode=${viewMode}`),
  authorXray: (query: string, platform: string) =>
    req(`/api/revenue/xray?query=${encodeURIComponent(query)}&platform=${encodeURIComponent(platform)}`),
  listEvidence: () => req<RevenueEvidence[]>('/api/revenue/evidence'),
  addEvidence: (body: any) => req<RevenueEvidence>('/api/revenue/evidence', { method: 'POST', body: JSON.stringify(body) }),
  delEvidence: (id: number) => req(`/api/revenue/evidence/${id}`, { method: 'DELETE' }),

  // 优化①②③：热力高光、强锚定拆解、金句库、合规素材台账、高赞评论
  fetchHeatmap: (cid: number) => req(`/api/analysis/heatmap/${cid}`, { method: 'POST' }),
  translateHeatmap: (cid: number) => req(`/api/analysis/heatmap/${cid}/translate`, { method: 'POST' }),
  runBreakdown: (cid: number) => req(`/api/analysis/breakdown/${cid}`, { method: 'POST' }),
  listQuotes: (q?: string) => req(`/api/quotes${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  addQuote: (body: any) => req('/api/quotes', { method: 'POST', body: JSON.stringify(body) }),
  delQuote: (id: number) => req(`/api/quotes/${id}`, { method: 'DELETE' }),

  searchAssets: (q: string, source = 'all') => req(`/api/assets/search?q=${encodeURIComponent(q)}&source=${source}`),
  listSavedAssets: (cid: number) => req(`/api/assets/saved/${cid}`),
  saveAsset: (body: any) => req('/api/assets/saved', { method: 'POST', body: JSON.stringify(body) }),
  delAsset: (aid: number) => req(`/api/assets/saved/${aid}`, { method: 'DELETE' }),

  listComments: (cid: number, onlyQuestions = false) =>
    req(`/api/comments/${cid}?only_questions=${onlyQuestions ? 'true' : 'false'}`),
  fetchComments: (cid: number) => req(`/api/comments/fetch/${cid}`, { method: 'POST' }),
  translateComments: (cid: number) => req(`/api/comments/${cid}/translate`, { method: 'POST' }),
  togglePainComment: (commentId: number, val: number) =>
    req(`/api/comments/${commentId}/pain?is_pain_point=${val}`, { method: 'PATCH' }),

  // G1 智能视频制作（A01–A16）
  videoCapabilities: () => req('/api/video/capabilities'),
  videoDemo: () => req('/api/video/demo'),
  listVideoProjects: (projectId?: number) =>
    req(`/api/video/projects${projectId ? `?project_id=${projectId}` : ''}`),
  createVideoProject: (body: any) =>
    req('/api/video/projects', { method: 'POST', body: JSON.stringify(body) }),
  getVideoProject: (vid: number) => req(`/api/video/projects/${vid}`),
  patchVideoProject: (vid: number, body: any) =>
    req(`/api/video/projects/${vid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delVideoProject: (vid: number) => req(`/api/video/projects/${vid}`, { method: 'DELETE' }),
  importVideoSrt: (vid: number, body: { srt_text?: string; content_id?: number }) =>
    req(`/api/video/projects/${vid}/import-srt`, { method: 'POST', body: JSON.stringify(body) }),
  uploadReferenceVideo: async (vid: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/video/projects/${vid}/upload-video`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  compileVideoOverlay: (vid: number, use_llm = true) =>
    req(`/api/video/projects/${vid}/compile`, { method: 'POST', body: JSON.stringify({ use_llm }) }),
  lintVideoOverlay: (vid: number, doc?: any) =>
    req(`/api/video/projects/${vid}/lint`, { method: 'POST', body: JSON.stringify({ doc }) }),
  saveVideoVersion: (vid: number, doc: any, note = '手动保存版本') =>
    req(`/api/video/projects/${vid}/versions`, { method: 'PUT', body: JSON.stringify({ doc, note }) }),
  restoreVideoVersion: (vid: number, verId: number) =>
    req(`/api/video/projects/${vid}/versions/${verId}/restore`, { method: 'POST' }),
  createVideoFeedback: (vid: number, body: any = {}) =>
    req(`/api/video/projects/${vid}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
  listVideoFeedbackRules: (projectId?: number) =>
    req(`/api/video/feedback-rules${projectId ? `?project_id=${projectId}` : ''}`),
  patchVideoFeedbackRule: (rid: number, body: { status: string; proposed_rule?: string }) =>
    req(`/api/video/feedback-rules/${rid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  uploadCustomSfx: async (fd: FormData) => {
    const res = await fetch('/api/video/sfx/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  createRenderJob: (body: any) =>
    req('/api/video/render-jobs', { method: 'POST', body: JSON.stringify(body) }),
  getRenderJob: (jobUid: string) => req(`/api/video/render-jobs/${jobUid}`),
  cancelRenderJob: (jobUid: string) =>
    req(`/api/video/render-jobs/${jobUid}/cancel`, { method: 'POST' }),
  listEngineExports: () => req('/api/video/engine-exports'),
  sendVideoToPublish: (vid: number, body: { video_file_path?: string; title?: string } = {}) =>
    req(`/api/video/projects/${vid}/send-to-publish`, { method: 'POST', body: JSON.stringify(body) }),

  // G2 多平台发布中心（B01–B11，全平台只填写不自动发布）
  publishCapabilities: () => req('/api/publish/capabilities'),
  listPublishAccounts: (projectId?: number) =>
    req(`/api/publish/accounts${projectId ? `?project_id=${projectId}` : ''}`),
  createPublishAccount: (body: any) =>
    req('/api/publish/accounts', { method: 'POST', body: JSON.stringify(body) }),
  checkPublishAccount: (aid: number, body: { authorization_state: string; open_login_window?: boolean }) =>
    req(`/api/publish/accounts/${aid}/check-login`, { method: 'POST', body: JSON.stringify(body) }),
  delPublishAccount: (aid: number) => req(`/api/publish/accounts/${aid}`, { method: 'DELETE' }),
  listPublishPackages: (projectId?: number) =>
    req(`/api/publish/packages${projectId ? `?project_id=${projectId}` : ''}`),
  createPublishPackage: (body: any) =>
    req('/api/publish/packages', { method: 'POST', body: JSON.stringify(body) }),
  getPublishPackage: (pid: number) => req(`/api/publish/packages/${pid}`),
  patchPublishPackage: (pid: number, body: any) =>
    req(`/api/publish/packages/${pid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delPublishPackage: (pid: number) => req(`/api/publish/packages/${pid}`, { method: 'DELETE' }),
  uploadPublishCover: async (pid: number, slot: string, file: File) => {
    const fd = new FormData();
    fd.append('slot', slot);
    fd.append('file', file);
    const res = await fetch(`/api/publish/packages/${pid}/covers`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  generatePublishDrafts: (pid: number, body: any = {}) =>
    req(`/api/publish/packages/${pid}/generate-drafts`, { method: 'POST', body: JSON.stringify(body) }),
  validatePublishPackage: (pid: number, platforms?: string[]) =>
    req(`/api/publish/packages/${pid}/validate`, { method: 'POST', body: JSON.stringify({ platforms }) }),
  authorizeFillTasks: (body: any) =>
    req('/api/publish/tasks/authorize-fill', { method: 'POST', body: JSON.stringify(body) }),
  reconcilePublishTask: (tid: number, body: any) =>
    req(`/api/publish/tasks/${tid}/reconcile`, { method: 'POST', body: JSON.stringify(body) }),
  publishCalendar: (projectId?: number) =>
    req(`/api/publish/calendar${projectId ? `?project_id=${projectId}` : ''}`),

  // ==================== KOUBO-SKILL-P2: AI 智能剪辑 (ChatCut + Antigravity) ====================
  aiVideoStatus: () => req('/api/ai-video/status'),
  aiVideoSkills: () => req('/api/ai-video/skills'),
  listAiVideoJobs: (projectId?: number, status?: string) => {
    const q = new URLSearchParams();
    if (projectId !== undefined) q.set('project_id', String(projectId));
    if (status) q.set('status', status);
    return req(`/api/ai-video/jobs${q.toString() ? `?${q}` : ''}`);
  },
  getAiVideoJob: (jobId: string) => req(`/api/ai-video/jobs/${encodeURIComponent(jobId)}`),
  createAiVideoJob: (body: any) =>
    req('/api/ai-video/jobs', { method: 'POST', body: JSON.stringify(body) }),
  uploadAiVideoSource: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/ai-video/jobs/upload-source', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  cancelAiVideoJob: (jobId: string, reason?: string) =>
    req(`/api/ai-video/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason || '用户在工作台取消任务' }),
    }),
  submitAiSegmentEdit: (jobId: string, body: any) =>
    req(`/api/ai-video/jobs/${encodeURIComponent(jobId)}/segment-edit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  sendAiVideoToPublish: (jobId: string, body: any = {}) =>
    req(`/api/ai-video/jobs/${encodeURIComponent(jobId)}/send-to-publish`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  openChatCutProject: (external_project_path: string) =>
    req('/api/ai-video/open-chatcut-project', {
      method: 'POST',
      body: JSON.stringify({ external_project_path }),
    }),

  // ==================== SEARCH-PHASE-1: 通用 AI 拓词引擎与 12 平台能力矩阵 ====================
  searchPlatformCapabilities: () => req('/api/search/platform-capabilities'),
  expandResearchTask: (body: any) =>
    req('/api/search/research-tasks/expand', { method: 'POST', body: JSON.stringify(body) }),
  listResearchTasks: (projectId?: number) =>
    req(`/api/search/research-tasks${projectId ? `?project_id=${projectId}` : ''}`),
  getResearchTask: (taskId: number) => req(`/api/search/research-tasks/${taskId}`),
  addResearchCandidate: (taskId: number, body: any) =>
    req(`/api/search/research-tasks/${taskId}/candidates`, { method: 'POST', body: JSON.stringify(body) }),
  patchResearchCandidate: (cid: number, body: any) =>
    req(`/api/search/candidates/${cid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteResearchCandidate: (cid: number) =>
    req(`/api/search/candidates/${cid}`, { method: 'DELETE' }),
  batchSelectCandidates: (taskId: number, body: { is_selected?: number; dimension?: string; invert?: boolean }) =>
    req(`/api/search/research-tasks/${taskId}/candidates/batch-select`, { method: 'POST', body: JSON.stringify(body) }),

  // FIX-02: 可扩展研究维度库与常用维度组合
  getSearchDimensions: () => req('/api/search/dimensions'),
  addSearchDimension: (body: { name: string; category?: string; description?: string }) =>
    req('/api/search/dimensions', { method: 'POST', body: JSON.stringify(body) }),
  updateSearchDimension: (dimId: string, body: { name?: string; category?: string; description?: string }) =>
    req(`/api/search/dimensions/${encodeURIComponent(dimId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSearchDimension: (dimId: string) =>
    req(`/api/search/dimensions/${encodeURIComponent(dimId)}`, { method: 'DELETE' }),
  saveSearchDimensionPreset: (body: { name: string; dimensions: string[] }) =>
    req('/api/search/dimension-presets', { method: 'POST', body: JSON.stringify(body) }),
  deleteSearchDimensionPreset: (presetId: string) =>
    req(`/api/search/dimension-presets/${encodeURIComponent(presetId)}`, { method: 'DELETE' }),

  // ==================== SEARCH-PHASE-2: 批量真实搜索调度与多项目关联 ====================
  createSearchBatch: (body: any) =>
    req('/api/search/batches', { method: 'POST', body: JSON.stringify(body) }),
  listSearchBatches: (projectId?: number) =>
    req(`/api/search/batches${projectId ? `?project_id=${projectId}` : ''}`),
  getSearchBatch: (batchId: number) => req(`/api/search/batches/${batchId}`),
  pauseSearchBatch: (batchId: number) =>
    req(`/api/search/batches/${batchId}/pause`, { method: 'POST' }),
  resumeSearchBatch: (batchId: number) =>
    req(`/api/search/batches/${batchId}/resume`, { method: 'POST' }),
  cancelSearchBatch: (batchId: number) =>
    req(`/api/search/batches/${batchId}/cancel`, { method: 'POST' }),
  retryFailedSearchBatch: (batchId: number) =>
    req(`/api/search/batches/${batchId}/retry-failed`, { method: 'POST' }),
  deleteProjectContentLink: (linkId: number, projectId?: number) =>
    req(`/api/search/project-links/${linkId}${projectId ? `?project_id=${projectId}` : ''}`, { method: 'DELETE' }),
  calcContentOutlier: (contentId: number) =>
    req(`/api/search/contents/${contentId}/calc-outlier`, { method: 'POST' }),
  getContentSnapshots: (contentId: number) =>
    req(`/api/search/contents/${contentId}/snapshots`),

  // ==================== SEARCH-PHASE-3: 市场验证、主题聚类、反向词与新选题 ====================
  getSearchScoringRules: () => req('/api/search/scoring-rules'),
  analyzeSearchBatch: (batchId: number, body: any = {}) =>
    req(`/api/search/batches/${batchId}/analyze`, { method: 'POST', body: JSON.stringify(body) }),
  getBatchInsights: (batchId: number) => req(`/api/search/batches/${batchId}/insights`),
  listSearchTopics: (projectId?: number, batchId?: number) => {
    const q = new URLSearchParams();
    if (projectId !== undefined) q.set('project_id', String(projectId));
    if (batchId !== undefined) q.set('batch_id', String(batchId));
    return req(`/api/search/topics${q.toString() ? `?${q}` : ''}`);
  },
  patchSearchTopic: (topicId: number, body: any) =>
    req(`/api/search/topics/${topicId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  launchTopicSecondRound: (topicId: number, body: any = {}) =>
    req(`/api/search/topics/${topicId}/second-round`, { method: 'POST', body: JSON.stringify(body) }),
  evaluateTopicSecondRound: (topicId: number, body: any = {}) =>
    req(`/api/search/topics/${topicId}/evaluate-second-round`, { method: 'POST', body: JSON.stringify(body) }),

  // ==================== SEARCH-PHASE-4: 选题资产中心 TopicHub ====================
  topicHubOverview: (projectId?: number | null) =>
    req(`/api/topic-hub/overview${projectId !== undefined && projectId !== null ? `?project_id=${projectId}` : ''}`),
  topicHubList: (params: Record<string, any>) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    });
    return req(`/api/topic-hub/topics?${q.toString()}`);
  },
  topicHubCreate: (body: any) =>
    req('/api/topic-hub/topics', { method: 'POST', body: JSON.stringify(body) }),
  topicHubDetail: (topicId: number, projectId?: number | null) =>
    req(`/api/topic-hub/topics/${topicId}${projectId && projectId > 0 ? `?project_id=${projectId}` : ''}`),
  topicHubPatch: (topicId: number, body: any) =>
    req(`/api/topic-hub/topics/${topicId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  topicHubLinkContent: (topicId: number, body: { project_id: number; content_id: number; provenance?: string }) =>
    req(`/api/topic-hub/topics/${topicId}/evidence/content`, { method: 'POST', body: JSON.stringify(body) }),
  topicHubUnlinkContent: (topicId: number, contentId: number, projectId: number) =>
    req(`/api/topic-hub/topics/${topicId}/evidence/content/${contentId}?project_id=${projectId}`, { method: 'DELETE' }),
  topicHubLinkRelation: (body: any) =>
    req('/api/topic-hub/relations', { method: 'POST', body: JSON.stringify(body) }),
  topicHubDetectSimilar: (projectId: number, topicId?: number) =>
    req(`/api/topic-hub/similar?project_id=${projectId}${topicId ? `&topic_id=${topicId}` : ''}`),
  topicHubMerge: (body: { project_id: number; target_topic_id: number; source_topic_id: number; reason?: string }) =>
    req('/api/topic-hub/merge', { method: 'POST', body: JSON.stringify(body) }),
  topicHubRestoreMerge: (mergeLogId: number, projectId: number) =>
    req(`/api/topic-hub/merge-logs/${mergeLogId}/restore`, { method: 'POST', body: JSON.stringify({ project_id: projectId }) }),
  topicHubReSearch: (topicId: number, body: any) =>
    req(`/api/topic-hub/topics/${topicId}/re-search`, { method: 'POST', body: JSON.stringify(body) }),
  topicHubGetDraft: (topicId: number) =>
    req(`/api/topic-hub/topics/${topicId}/draft`),
  topicHubSaveDraft: (topicId: number, body: { title?: string; content?: string; extra_requirements?: string; skill_id?: string; engine_id?: string; model_id?: string; client_rev?: number }) =>
    req(`/api/topic-hub/topics/${topicId}/draft`, { method: 'PUT', body: JSON.stringify(body) }),
  topicHubContentMetrics: (contentId: number) =>
    req(`/api/topic-hub/contents/${contentId}/metrics`),
  topicHubRefreshContentMetrics: (contentId: number, body: any) =>
    req(`/api/topic-hub/contents/${contentId}/refresh-metrics`, { method: 'POST', body: JSON.stringify(body) }),
  topicHubListBreakdownReports: (contentId: number) =>
    req(`/api/topic-hub/contents/${contentId}/breakdown-reports`),
  topicHubRunBreakdownSkill: (contentId: number, body: { skill_id: string; engine_id?: string; model_id?: string; text_mode?: string; extra_requirements?: string }) =>
    req(`/api/topic-hub/contents/${contentId}/breakdown-run`, { method: 'POST', body: JSON.stringify(body) }),
  topicHubDiscoverTopicsFromComments: (body: { project_id: number; content_id: number; comment_ids: number[]; count?: number; engine_id?: string; model_id?: string }) =>
    req('/api/topic-hub/comments/discover-topics', { method: 'POST', body: JSON.stringify(body) }),

  // ==================== SEARCH-PHASE-5 / R4-D: 原创文案多版本、自定义 Skill 与创作资料包 ====================
  topicHubScriptSkills: () => req('/api/topic-hub/script-skills'),
  saveCustomScriptSkill: (body: {
    name: string;
    description?: string;
    system_prompt: string;
    skill_id?: string;
    default_version_kind?: string;
    source_format?: string;
  }) => req('/api/topic-hub/script-skills/custom', { method: 'POST', body: JSON.stringify(body) }),
  deleteCustomScriptSkill: (skillId: string) =>
    req(`/api/topic-hub/script-skills/custom/${encodeURIComponent(skillId)}`, { method: 'DELETE' }),
  listWritingModels: () => req('/api/topic-hub/writing-models'),
  listStudioOriginalVersions: (projectId: number, contentId?: number | null, topicId?: number | null) => {
    const q = new URLSearchParams({ project_id: String(projectId) });
    if (contentId) q.set('content_id', String(contentId));
    if (topicId) q.set('topic_id', String(topicId));
    return req(`/api/topic-hub/studio-versions?${q.toString()}`);
  },
  generateStudioOriginalVersion: (body: {
    project_id: number;
    primary_content_id?: number | null;
    reference_content_ids?: number[];
    skill_id: string;
    engine_id?: string;
    model_id?: string;
    topic_id?: number | null;
    extra_requirements?: string;
    title?: string;
    manual_content?: string;
  }) => req('/api/topic-hub/studio-versions/generate', { method: 'POST', body: JSON.stringify(body) }),
  topicHubListScripts: (topicId: number, projectId: number) =>
    req(`/api/topic-hub/topics/${topicId}/scripts?project_id=${projectId}`),
  topicHubCreateScript: (topicId: number, body: any) =>
    req(`/api/topic-hub/topics/${topicId}/scripts`, { method: 'POST', body: JSON.stringify(body) }),
  topicHubPackageCheck: (topicId: number, projectId: number) =>
    req(`/api/topic-hub/topics/${topicId}/package-check?project_id=${projectId}`),
  topicHubGeneratePackage: (topicId: number, body: any) =>
    req(`/api/topic-hub/topics/${topicId}/packages/generate`, { method: 'POST', body: JSON.stringify(body) }),
  topicHubListPackages: (topicId: number, projectId: number) =>
    req(`/api/topic-hub/topics/${topicId}/packages?project_id=${projectId}`),

  // ==================== GCW-UAT-FIX-02: 无限级研究维度树、候选选题与人工多平台研究 ====================
  researchFlowPairing: () => req('/api/research-flow/extension-pairing'),
  researchFlowTree: (projectId: number) => req(`/api/research-flow/tree?project_id=${projectId}`),
  researchFlowCreateRoot: (body: { project_id: number; root_topic: string; max_children?: number }) =>
    req('/api/research-flow/tree/root', { method: 'POST', body: JSON.stringify(body) }),
  researchFlowAddNode: (body: { project_id: number; parent_id?: number | null; name: string; root_topic?: string }) =>
    req('/api/research-flow/tree/nodes', { method: 'POST', body: JSON.stringify(body) }),
  researchFlowPatchNode: (nodeId: number, body: { project_id: number; name?: string; is_selected?: number }) =>
    req(`/api/research-flow/tree/nodes/${nodeId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  researchFlowDeleteNode: (nodeId: number, projectId: number) =>
    req(`/api/research-flow/tree/nodes/${nodeId}?project_id=${projectId}`, { method: 'DELETE' }),
  researchFlowBatchSelect: (body: { project_id: number; action: string; parent_id?: number; random_count?: number; node_ids?: number[] }) =>
    req('/api/research-flow/tree/batch-select', { method: 'POST', body: JSON.stringify(body) }),
  researchFlowAiRecommendDims: (body: { project_id: number; count?: number }) =>
    req('/api/research-flow/tree/ai-recommend', { method: 'POST', body: JSON.stringify(body) }),
  researchFlowSavePreset: (body: { project_id: number; name: string; node_ids: number[] }) =>
    req('/api/research-flow/tree/presets', { method: 'POST', body: JSON.stringify(body) }),
  researchFlowGenerateCandidates: (body: { project_id: number; node_ids?: number[]; custom_hint?: string; max_count?: number; mode?: string; target_candidate_ids?: number[] }) =>
    req('/api/research-flow/candidates/generate', { method: 'POST', body: JSON.stringify(body) }),
  researchFlowRegenerateCandidates: (body: { project_id: number; node_ids?: number[]; custom_hint?: string; max_count?: number; mode: 'single' | 'batch' | 'all'; target_candidate_ids?: number[] }) =>
    req('/api/research-flow/candidates/regenerate', { method: 'POST', body: JSON.stringify(body) }),
  researchFlowListCandidates: (projectId: number) => req(`/api/research-flow/candidates?project_id=${projectId}`),
  researchFlowPatchCandidate: (cid: number, body: any) =>
    req(`/api/research-flow/candidates/${cid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  researchFlowConfirmCandidate: (cid: number, body: { project_id: number; title?: string; angle?: string; judge_reason?: string }) =>
    req(`/api/research-flow/candidates/${cid}/confirm`, { method: 'POST', body: JSON.stringify(body) }),
  researchFlowPlatforms: () => req('/api/research-flow/platforms'),
  researchFlowSavePlatforms: (platforms: any[]) =>
    req('/api/research-flow/platforms', { method: 'PUT', body: JSON.stringify({ platforms }) }),
  researchFlowCaptureEvidence: (body: any) =>
    req('/api/research-flow/evidence', { method: 'POST', body: JSON.stringify(body) }),
  researchFlowListEvidence: (projectId: number, candidateTopicId?: number) =>
    req(`/api/research-flow/evidence?project_id=${projectId}${candidateTopicId ? `&candidate_topic_id=${candidateTopicId}` : ''}`),

  // 本地加密账号保险箱（Windows DPAPI 本机用户级加密）
  vaultList: () => req('/api/vault/items'),
  vaultCreate: (body: { platform: string; site_url?: string; username: string; password?: string; note?: string }) =>
    req('/api/vault/items', { method: 'POST', body: JSON.stringify(body) }),
  vaultUpdate: (id: string, body: { platform?: string; site_url?: string; username?: string; password?: string; clear_password?: boolean; note?: string }) =>
    req(`/api/vault/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  vaultDelete: (id: string) =>
    req(`/api/vault/items/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  vaultReveal: (id: string) =>
    req(`/api/vault/items/${encodeURIComponent(id)}/reveal`, { method: 'POST' }),

  // GCW-ASSET-01: 内置浏览器视频一键收录与 TopicHub 资产管理
  videoCaptureResolveShareLink: (rawText: string) =>
    req('/api/topic-hub/video-capture/resolve-share-link', { method: 'POST', body: JSON.stringify({ raw_text: rawText }) }),
  videoCapturePreview: (body: any) =>
    req('/api/topic-hub/video-capture/preview', { method: 'POST', body: JSON.stringify(body) }),
  videoCaptureSave: (body: any) =>
    req('/api/topic-hub/video-capture/save', { method: 'POST', body: JSON.stringify(body) }),
  topicHubPatchContentAsset: (topicId: number, contentId: number, body: any) =>
    req(`/api/topic-hub/topics/${topicId}/evidence/content/${contentId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // GCW-UAT-R4-A: 项目研究状态隔离、TopicHub 项目分类与统一生命周期接口
  researchFlowGetProjectState: (projectId: number) =>
    req(`/api/research-flow/project-state?project_id=${projectId}`),
  researchFlowSaveProjectState: (body: {
    project_id: number;
    root_input?: string;
    active_cand_id?: number | null;
    active_query_text?: string;
    active_platform_id?: string;
    last_browser_url?: string;
    judge_reason?: string;
    dims_collapsed?: boolean;
    cands_collapsed?: boolean;
  }) => req('/api/research-flow/project-state', { method: 'PUT', body: JSON.stringify(body) }),
  topicHubProjectCategories: () => req('/api/topic-hub/project-categories'),
  topicHubBatchStatus: (body: { topic_ids: number[]; production_status: string; reason?: string }) =>
    req('/api/topic-hub/topics/batch-status', { method: 'POST', body: JSON.stringify(body) }),
  topicHubRevertStatus: (topicId: number, reason?: string) =>
    req(`/api/topic-hub/topics/${topicId}/revert-status`, { method: 'POST', body: JSON.stringify({ reason: reason || '' }) }),
  topicHubArchive: (topicId: number, archive: boolean, reason?: string) =>
    req(`/api/topic-hub/topics/${topicId}/archive`, { method: 'POST', body: JSON.stringify({ archive, reason: reason || '' }) }),

  // GCW-TRANS-01: 统一翻译引擎配置、费用控制与真实双语字幕接口
  translationGetConfig: () => req('/api/translation/config'),
  translationSaveProvider: (engineId: string, body: any) =>
    req(`/api/translation/providers/${encodeURIComponent(engineId)}`, { method: 'POST', body: JSON.stringify(body) }),
  translationSetDefault: (engineId: string) =>
    req(`/api/translation/providers/${encodeURIComponent(engineId)}/default`, { method: 'POST' }),
  translationTestConnection: (engineId: string) =>
    req(`/api/translation/providers/${encodeURIComponent(engineId)}/test-connection`, { method: 'POST' }),
  translationFetchModels: (engineId: string) =>
    req(`/api/translation/providers/${encodeURIComponent(engineId)}/models`),
  translationTestSample: (engineId: string, sampleText: string, targetLang = 'zh-CN') =>
    req(`/api/translation/providers/${encodeURIComponent(engineId)}/test-translate`, {
      method: 'POST',
      body: JSON.stringify({ sample_text: sampleText, target_lang: targetLang }),
    }),
  translationUpdatePolicy: (body: {
    billing_mode?: 'free_only' | 'authorized_paid';
    auto_translate?: boolean;
    monthly_char_limit?: number;
    monthly_budget_cny?: number;
    default_target_lang?: string;
  }) => req('/api/translation/policy', { method: 'POST', body: JSON.stringify(body) }),
  translationGetUsage: () => req('/api/translation/usage'),
  translationGetSubtitles: (contentId: number, targetLang = 'zh-CN') =>
    req(`/api/translation/subtitles/${contentId}?target_lang=${encodeURIComponent(targetLang)}`),
  translationTranslateSubtitles: (
    contentId: number,
    body: { target_lang?: string; engine_id?: string; force_retranslate?: boolean; overwrite_manual?: boolean } = {},
  ) =>
    req(`/api/translation/subtitles/${contentId}/translate`, {
      method: 'POST',
      body: JSON.stringify({ target_lang: 'zh-CN', ...body }),
    }),
  translationEditSegment: (contentId: number, segmentIdx: number, translatedText: string, targetLang = 'zh-CN') =>
    req(`/api/translation/subtitles/${contentId}/${segmentIdx}`, {
      method: 'PATCH',
      body: JSON.stringify({ translated_text: translatedText, target_lang: targetLang }),
    }),
  translationLocalInspect: () => req('/api/translation/local-wizard/inspect'),
  translationLocalService: (action: 'start' | 'stop' | 'health', runtime = 'ollama') =>
    req('/api/translation/local-wizard/service', { method: 'POST', body: JSON.stringify({ action, runtime }) }),
  translationLocalPull: (userAuthorized: boolean, modelTag = 'hy-mt3-1.8b') =>
    req('/api/translation/local-wizard/pull', {
      method: 'POST',
      body: JSON.stringify({ user_authorized: userAuthorized, model_tag: modelTag }),
    }),
  translationLocalWizardOpenModelDir: () =>
    req('/api/translation/local-wizard/open-model-dir', { method: 'POST' }),
};

export function fmtNum(n?: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return n.toLocaleString();
}

export function fmtDur(sec?: number | null): string {
  if (!sec && sec !== 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
