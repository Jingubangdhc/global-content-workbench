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
