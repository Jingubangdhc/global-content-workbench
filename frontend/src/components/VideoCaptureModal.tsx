import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  Film,
  Loader2,
  Plus,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import { api, fmtDur } from '../api';
import { extractShareLinks } from '../utils/shareLink';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: number;
  projectName?: string;
  projects?: { id: number; name: string }[];
  candidateTopicId?: number | null;
  candidateTopicTitle?: string;
  currentTopicId?: number | null;
  currentTopicTitle?: string;
  searchKeyword?: string;
  initialPreview: any | null;
  initialOriginalShareUrl?: string;
  loadingPreview: boolean;
  onSaved: (res: any) => void;
  onGoTopicHub?: (projectId: number, topicId: number) => void;
}

/**
 * GCW-UAT-R4-H · 极简统一收录确认弹窗（已彻底移除“选择收录方向三选一”与 A/B/C 冗余逻辑）
 * 统一流程：选择项目 → 核对作品（强校验作品身份，拒绝首页/临时哈希） → 自动生成或编辑选题名称 → 确认收录
 */
export default function VideoCaptureModal({
  open,
  onClose,
  projectId,
  projectName = '',
  projects = [],
  candidateTopicId,
  candidateTopicTitle = '',
  currentTopicId,
  searchKeyword,
  initialPreview,
  initialOriginalShareUrl = '',
  loadingPreview,
  onSaved,
  onGoTopicHub,
}: Props) {
  const [selectedProjectId, setSelectedProjectId] = useState<number>(projectId);
  const [topics, setTopics] = useState<any[]>([]);
  // 统一选题字段：默认自动关联当前有效研究选题或按视频标题自动生成新选题名；也允许用户下拉改选已有选题
  const [linkedExistingTopicId, setLinkedExistingTopicId] = useState<number | ''>('');
  const [topicTitle, setTopicTitle] = useState('');

  // 作品核心字段
  const [url, setUrl] = useState('');
  const [originalShareUrl, setOriginalShareUrl] = useState('');
  const [platform, setPlatform] = useState('');
  const [itemId, setItemId] = useState('');
  const [identityVerified, setIdentityVerified] = useState<boolean>(true);
  const [identityWarning, setIdentityWarning] = useState<string>('');
  const [multiLinkCandidates, setMultiLinkCandidates] = useState<string[]>([]);
  const [resolvingLink, setResolvingLink] = useState(false);

  const [title, setTitle] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [author, setAuthor] = useState('');
  const [authorUrl, setAuthorUrl] = useState('');
  const [publishedAt, setPublishedAt] = useState('');
  const [durationSec, setDurationSec] = useState('');
  const [viewCount, setViewCount] = useState('');
  const [likeCount, setLikeCount] = useState('');
  const [commentCount, setCommentCount] = useState('');
  const [favoriteCount, setFavoriteCount] = useState('');
  const [shareCount, setShareCount] = useState('');
  const [followerCount, setFollowerCount] = useState('');

  const [userTags, setUserTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [aiSuggestedTags, setAiSuggestedTags] = useState<string[]>([]);
  const [captureReason, setCaptureReason] = useState('');

  const [saving, setSaving] = useState(false);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [savedResult, setSavedResult] = useState<any | null>(null);
  const topicListReqSeqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setSelectedProjectId(projectId);
    setSavedResult(null);
    setErrMsg('');
    setMultiLinkCandidates([]);
    setOriginalShareUrl(initialOriginalShareUrl || '');
  }, [open, projectId, initialOriginalShareUrl]);

  // 根据所选研究项目拉取真实数据库选题列表（切换项目时带请求序号与取消标志，防止慢返回的旧请求覆盖当前项目数据）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const reqSeq = ++topicListReqSeqRef.current;
    const isOrigProject = selectedProjectId === projectId;
    setLoadingTopics(true);
    setTopics([]);
    setLinkedExistingTopicId('');
    api
      .topicHubList({ project_id: selectedProjectId, include_published: 'true', limit: 100 })
      .then((r) => {
        if (cancelled || reqSeq !== topicListReqSeqRef.current) return;
        const list = r?.topics || [];
        setTopics(list);
        if (isOrigProject && currentTopicId && list.some((t: any) => t.id === currentTopicId)) {
          const hit = list.find((t: any) => t.id === currentTopicId);
          setLinkedExistingTopicId(currentTopicId);
          setTopicTitle(hit?.topic_title || candidateTopicTitle || initialPreview?.title || '');
        } else if (isOrigProject && candidateTopicId && candidateTopicTitle) {
          setLinkedExistingTopicId('');
          setTopicTitle(candidateTopicTitle);
        } else {
          // 切换到其他项目或无当前研究选题时：默认不乱挂旧选题，也绝不把旧项目候选选题标题带入新项目
          setLinkedExistingTopicId('');
          const videoDefaultTitle = (initialPreview?.title || '').split('\n')[0].slice(0, 120);
          setTopicTitle((prev) => {
            if (!prev || (candidateTopicTitle && prev === candidateTopicTitle)) {
              return videoDefaultTitle;
            }
            return prev;
          });
        }
      })
      .catch(() => {
        if (cancelled || reqSeq !== topicListReqSeqRef.current) return;
        setTopics([]);
        setLinkedExistingTopicId('');
      })
      .finally(() => {
        if (!cancelled && reqSeq === topicListReqSeqRef.current) {
          setLoadingTopics(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedProjectId, projectId, currentTopicId, candidateTopicId, candidateTopicTitle]);

  useEffect(() => {
    if (!open || !initialPreview) return;
    setUrl(initialPreview.url || '');
    setPlatform(initialPreview.platform || '');
    setItemId(initialPreview.platform_item_id || '');
    setIdentityVerified(initialPreview.identity_verified !== false);
    setIdentityWarning(initialPreview.identity_warning || '');
    setTitle(initialPreview.title || '');
    setThumbnailUrl(initialPreview.thumbnail_url || '');
    setAuthor(initialPreview.author || '');
    setAuthorUrl(initialPreview.author_url || '');
    setPublishedAt(initialPreview.published_at || '');
    setDurationSec(initialPreview.duration_sec != null ? String(initialPreview.duration_sec) : '');
    setViewCount(initialPreview.view_count != null ? String(initialPreview.view_count) : '');
    setLikeCount(initialPreview.like_count != null ? String(initialPreview.like_count) : '');
    setCommentCount(initialPreview.comment_count != null ? String(initialPreview.comment_count) : '');
    setFavoriteCount(initialPreview.favorite_count != null ? String(initialPreview.favorite_count) : '');
    setShareCount(initialPreview.share_count != null ? String(initialPreview.share_count) : '');
    setFollowerCount(initialPreview.author_follower_count != null ? String(initialPreview.author_follower_count) : '');
    if (!topicTitle) {
      setTopicTitle(
        selectedProjectId === projectId && candidateTopicTitle
          ? candidateTopicTitle
          : (initialPreview.title || '').split('\n')[0].slice(0, 120)
      );
    }
    setAiSuggestedTags(initialPreview.ai_suggested_tags || []);
    if (initialPreview.existing_content?.research_tags?.length) {
      setUserTags(initialPreview.existing_content.research_tags);
    } else {
      setUserTags([]);
    }
    setCaptureReason(initialPreview.existing_content?.collect_reason || '');
  }, [open, initialPreview]);

  if (!open) return null;

  const addTag = (raw: string) => {
    const t = raw.trim().slice(0, 30);
    if (!t) return;
    setUserTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
  };

  const removeTag = (t: string) => {
    setUserTags((prev) => prev.filter((x) => x !== t));
  };

  const handleResolveShareText = async (rawInput?: string) => {
    const src = (rawInput ?? url).trim();
    if (!src) return;
    const ext = extractShareLinks(src);
    if (ext.urls.length > 1) {
      setMultiLinkCandidates(ext.urls);
      setErrMsg(`识别到 ${ext.urls.length} 个链接，请在下方人工选择目标链接`);
      return;
    }
    setMultiLinkCandidates([]);
    setResolvingLink(true);
    setErrMsg('');
    try {
      const r = await api.videoCaptureResolveShareLink(src);
      if (r?.status === 'multiple_links' && Array.isArray(r.candidate_urls)) {
        setMultiLinkCandidates(r.candidate_urls);
        setErrMsg(r.message || '识别到多个链接，请人工选择');
      } else if (r?.ok && r.status === 'resolved') {
        const prevItemId = itemId.trim();
        const nextItemId = (r.platform_item_id || '').trim();
        const switchedToDifferentWork = Boolean(nextItemId && prevItemId && nextItemId !== prevItemId);
        if (r.original_share_url && r.original_share_url !== r.final_url) {
          setOriginalShareUrl(r.original_share_url);
        }
        setUrl(r.final_url);
        if (r.platform) setPlatform(r.platform);
        if (nextItemId) setItemId(nextItemId);
        setIdentityVerified(true);
        setIdentityWarning('');

        // GCW-STABLE-FIX-02: 分享链接解析成功后重新核对作品信息，防止把旧视频的标题/作者/互动数据错存到新链接
        try {
          const pv = await api.videoCapturePreview({
            project_id: selectedProjectId,
            url: r.final_url,
            platform: r.platform || '',
            platform_item_id: nextItemId,
            title: switchedToDifferentWork ? '' : title,
          });
          const existing = pv?.preview?.existing_content;
          if (existing) {
            if (existing.title) setTitle(existing.title);
            setAuthor(existing.author_name || '');
            setAuthorUrl(existing.author_url || '');
            setThumbnailUrl(existing.thumbnail_url || '');
            setPublishedAt(existing.published_at || '');
            setDurationSec(existing.duration_sec != null ? String(existing.duration_sec) : '');
            setViewCount(existing.view_count != null ? String(existing.view_count) : '');
            setLikeCount(existing.like_count != null ? String(existing.like_count) : '');
            setCommentCount(existing.comment_count != null ? String(existing.comment_count) : '');
            setFavoriteCount(existing.favorite_count != null ? String(existing.favorite_count) : '');
            setShareCount(existing.share_count != null ? String(existing.share_count) : '');
            setFollowerCount(existing.author_follower_count != null ? String(existing.author_follower_count) : '');
          } else if (switchedToDifferentWork) {
            // 解析到了与当前页面不同的新作品：清空旧视频残留元数据，避免张冠李戴
            setTitle('');
            setAuthor('');
            setAuthorUrl('');
            setThumbnailUrl('');
            setPublishedAt('');
            setDurationSec('');
            setViewCount('');
            setLikeCount('');
            setCommentCount('');
            setFavoriteCount('');
            setShareCount('');
            setFollowerCount('');
            setErrMsg('已解析到新作品 ID，已清空旧视频元数据，请核对并填写当前作品标题后保存');
          }
        } catch {
          if (switchedToDifferentWork) {
            setAuthor('');
            setAuthorUrl('');
            setThumbnailUrl('');
            setViewCount('');
            setLikeCount('');
            setCommentCount('');
            setFavoriteCount('');
            setShareCount('');
          }
        }
      } else {
        setIdentityVerified(false);
        setErrMsg(r?.error || '未能确认具体作品链接，请复制该视频的具体分享链接粘贴后重试');
      }
    } catch (e: any) {
      setErrMsg(e?.message || '分享链接解析失败');
    } finally {
      setResolvingLink(false);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    if (!url.trim() || !title.trim()) {
      setErrMsg('作品链接和视频标题不能为空');
      return;
    }
    if (!linkedExistingTopicId && !topicTitle.trim()) {
      setErrMsg('请输入选题名称，或选择一个已有选题');
      return;
    }

    setSaving(true);
    setErrMsg('');
    setSavedResult(null);
    try {
      const isOrigProject = selectedProjectId === projectId;
      const res = await api.videoCaptureSave({
        project_id: selectedProjectId,
        url: url.trim(),
        original_share_url: originalShareUrl.trim(),
        platform: platform.trim(),
        platform_item_id: itemId.trim(),
        title: title.trim(),
        thumbnail_url: thumbnailUrl.trim(),
        author: author.trim(),
        author_url: authorUrl.trim(),
        published_at: publishedAt.trim(),
        duration_sec: durationSec.trim() === '' ? null : Number(durationSec),
        view_count: viewCount.trim() === '' ? null : viewCount.trim(),
        like_count: likeCount.trim() === '' ? null : likeCount.trim(),
        comment_count: commentCount.trim() === '' ? null : commentCount.trim(),
        favorite_count: favoriteCount.trim() === '' ? null : favoriteCount.trim(),
        share_count: shareCount.trim() === '' ? null : shareCount.trim(),
        author_follower_count: followerCount.trim() === '' ? null : followerCount.trim(),
        collected_at: initialPreview?.collected_at || '',
        data_source: initialPreview?.data_source || 'electron_readonly_capture',
        search_keyword: searchKeyword || initialPreview?.search_keyword || '',
        research_tags: userTags,
        capture_reason: captureReason.trim(),
        target_mode: 'auto',
        target_topic_id: linkedExistingTopicId ? Number(linkedExistingTopicId) : null,
        candidate_topic_id: !linkedExistingTopicId && isOrigProject && candidateTopicId ? candidateTopicId : null,
        new_topic_title: topicTitle.trim(),
      });
      if (res?.ok && res.content_id && res.topic_id) {
        setSavedResult(res);
        setIdentityVerified(true);
        setIdentityWarning('');
        onSaved(res);
      } else {
        setErrMsg(res?.error || '收录写入失败，未保存');
      }
    } catch (e: any) {
      setErrMsg(e?.message || '收录写入失败，请检查具体视频链接后重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="bg-[#111A2E] border border-[#2C4268] rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden text-slate-100">
        {/* 顶栏 */}
        <div className="px-5 py-3 bg-[#131E36] border-b border-[#1E2E4A] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookmarkPlus className="w-4 h-4 text-cyan-400" />
            <span className="font-bold text-sm">收录作品至选题资产中心</span>
            {initialPreview?.existing_content && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/35 text-amber-300 gcw-text-meta">
                作品已存在 (#{initialPreview.existing_content.content_id})，本次将去重复用并建立选题关联
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        {loadingPreview ? (
          <div className="p-12 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
            <span>正在安全只读提取当前真实视频元数据...</span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs bg-[#0B111E]">
            {errMsg && (
              <div className="px-3 py-2 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errMsg}</span>
              </div>
            )}

            {!identityVerified && (
              <div className="px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-500/45 text-amber-200 gcw-text-tag flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-300" />
                <span>
                  {identityWarning ||
                    '当前页面未识别到具体视频唯一 ID（如抖音精选首页），请复制该视频的具体分享链接粘贴到下方「作品链接」框并点击「解析分享链」，绝不以首页或临时哈希入库。'}
                </span>
              </div>
            )}

            {savedResult && (
              <div className="px-3.5 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-400/50 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-200">
                <div className="space-y-0.5">
                  <div>
                    ✅ 已成功收录至 <strong>选题资产中心</strong>（项目：<strong>{savedResult.project_name || `#${savedResult.project_id}`}</strong> · 选题 <strong>#{savedResult.topic_id}</strong>「{savedResult.topic_title}」）
                  </div>
                  <div className="gcw-text-tag text-emerald-300/90">
                    作品 #{savedResult.content_id}（{savedResult.dedup_reused ? '已存在去重复用' : '新收录'}）·
                    {savedResult.topic_created ? '已自动新建待研究选题' : `已关联已有选题（保持原状态：${savedResult.topic_status || '待研究'}）`} ·
                    关联结果：{savedResult.link_status === 'updated' ? '已更新关联' : '已新建关联'} · 不会自动进入文案工坊
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {onGoTopicHub && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onGoTopicHub(savedResult.project_id, savedResult.topic_id);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs"
                    >
                      前往选题资产中心查看 →
                    </button>
                  )}
                  <button type="button" onClick={onClose} className="px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs">
                    关闭
                  </button>
                </div>
              </div>
            )}

            {/* 步骤 1 & 3：明确收录目的地 + 选择研究项目 + 自动生成或编辑选题名称 */}
            <div className="gcw-panel p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 gcw-text-tag">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 font-bold">
                    收录目的地：选题资产中心（TopicHub）
                  </span>
                  <span className="gcw-text-meta text-slate-400">不默认落入素材与作者库 · 不自动进入文案工坊</span>
                </div>
                <span className="gcw-text-meta text-slate-400 font-mono-num">
                  采集时间：{initialPreview?.collected_at || '当前'}
                </span>
              </div>

              <div className="grid grid-cols-12 gap-2.5 items-end">
                <div className="col-span-4 space-y-1">
                  <label className="block gcw-text-tag font-semibold text-slate-300">1. 所属研究项目 *</label>
                  {projects.length > 0 ? (
                    <select
                      value={selectedProjectId}
                      onChange={(e) => {
                        setSelectedProjectId(Number(e.target.value));
                        setSavedResult(null);
                      }}
                      className="gcw-input w-full px-2.5 py-1.5 text-xs font-semibold text-cyan-200"
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          #{p.id} {p.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="gcw-input px-2.5 py-1.5 text-xs text-cyan-300 font-semibold">
                      {projectName || `项目 #${selectedProjectId}`}
                    </div>
                  )}
                </div>

                <div className="col-span-8 space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="gcw-text-tag font-semibold text-slate-300">
                      2. 选题名称（自动生成待研究选题，或直接选择已有选题关联）*
                    </label>
                    {loadingTopics ? (
                      <span className="gcw-text-meta text-cyan-300">加载项目选题中...</span>
                    ) : topics.length > 0 && (
                      <select
                        value={linkedExistingTopicId}
                        onChange={(e) => {
                          const val = e.target.value ? Number(e.target.value) : '';
                          setLinkedExistingTopicId(val);
                          if (val) {
                            const hit = topics.find((t) => t.id === val);
                            if (hit) setTopicTitle(hit.topic_title);
                          }
                        }}
                        className="bg-slate-900 border border-slate-700 rounded px-2 py-0.5 gcw-text-meta text-slate-300 max-w-[210px]"
                        title="可选：改选当前项目下已有选题"
                      >
                        <option value="">自动新建待研究选题</option>
                        {topics.map((t) => (
                          <option key={t.id} value={t.id}>
                            关联已有 #{t.id} {t.topic_title}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <input
                    value={topicTitle}
                    onChange={(e) => {
                      setTopicTitle(e.target.value);
                      if (linkedExistingTopicId) setLinkedExistingTopicId('');
                    }}
                    placeholder="输入或编辑选题名称（无对应已有选题时将自动创建「待研究」选题）..."
                    className="gcw-input w-full px-2.5 py-1.5 text-xs font-semibold text-slate-100"
                  />
                </div>
              </div>
            </div>

            {/* 步骤 2：核对作品信息与具体视频链接 */}
            <div className="gcw-panel p-3 flex gap-3">
              <div className="w-40 h-[90px] shrink-0 rounded-lg overflow-hidden bg-[#0C1424] border border-[#2C4268] relative flex items-center justify-center">
                {thumbnailUrl ? (
                  <img src={thumbnailUrl} alt={title} className="w-full h-full object-cover" />
                ) : (
                  <Film className="w-6 h-6 text-slate-600" />
                )}
                {durationSec && (
                  <span className="absolute bottom-1 right-1 px-1.5 py-0.2 rounded bg-black/75 text-slate-100 gcw-text-meta font-mono-num">
                    {fmtDur(Number(durationSec))}
                  </span>
                )}
              </div>
              <div className="flex-1 space-y-1.5 min-w-0">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="视频标题 *"
                  className="gcw-input w-full px-2.5 py-1 text-xs font-semibold"
                />
                <div className="grid grid-cols-3 gap-1.5">
                  <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="平台" className="gcw-input px-2 py-1 gcw-text-tag" />
                  <input
                    value={itemId}
                    onChange={(e) => setItemId(e.target.value)}
                    placeholder="真实作品唯一 ID *"
                    className={`gcw-input px-2 py-1 gcw-text-tag font-mono-num ${!identityVerified ? 'border-amber-500/70' : ''}`}
                  />
                  <input value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} placeholder="发布时间" className="gcw-input px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
                <div className="flex gap-1.5">
                  <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="具体视频链接 *（支持粘贴完整抖音分享文本并点击解析）"
                    className={`gcw-input flex-1 px-2 py-1 gcw-text-tag font-mono-num text-slate-200 ${!identityVerified ? 'border-amber-500/70' : ''}`}
                  />
                  <button
                    type="button"
                    onClick={() => handleResolveShareText()}
                    disabled={resolvingLink || !url.trim()}
                    className="gcw-btn-cyan px-2.5 py-1 rounded gcw-text-meta font-semibold shrink-0"
                    title="提取抖音/平台分享文本中的短链并安全校验解析为具体作品链接"
                  >
                    {resolvingLink ? '解析中...' : '解析分享链'}
                  </button>
                </div>
                {originalShareUrl && (
                  <div className="gcw-text-meta text-slate-400 font-mono-num truncate">
                    原始分享链接留痕：{originalShareUrl}
                  </div>
                )}
                {multiLinkCandidates.length > 1 && (
                  <div className="p-1.5 rounded bg-amber-500/10 border border-amber-500/35 space-y-1 gcw-text-meta">
                    <div className="text-amber-300">识别到多个链接，请人工点选：</div>
                    <div className="flex flex-wrap gap-1">
                      {multiLinkCandidates.map((cu) => (
                        <button
                          key={cu}
                          type="button"
                          onClick={() => {
                            setUrl(cu);
                            setMultiLinkCandidates([]);
                            handleResolveShareText(cu);
                          }}
                          className="px-2 py-0.5 rounded bg-slate-900 hover:bg-cyan-600/30 border border-slate-700 text-cyan-200 font-mono-num truncate max-w-full"
                        >
                          {cu}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 作者与真实数据核对 */}
            <div className="gcw-panel p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200">作者与真实数据核对（缺失项请留空存 NULL）</span>
                <span className="gcw-text-meta text-slate-400">支持 18.5万 / 1.2k 自动解析</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">作者名</label>
                  <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag" />
                </div>
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">作者主页 URL</label>
                  <input value={authorUrl} onChange={(e) => setAuthorUrl(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">视频时长（秒）</label>
                  <input value={durationSec} onChange={(e) => setDurationSec(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
              </div>
              <div className="grid grid-cols-6 gap-2">
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">播放量</label>
                  <input value={viewCount} onChange={(e) => setViewCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">点赞量</label>
                  <input value={likeCount} onChange={(e) => setLikeCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">评论量</label>
                  <input value={commentCount} onChange={(e) => setCommentCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">收藏量</label>
                  <input value={favoriteCount} onChange={(e) => setFavoriteCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">分享量</label>
                  <input value={shareCount} onChange={(e) => setShareCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
                <div>
                  <label className="block gcw-text-meta text-slate-400 mb-0.5">作者粉丝量</label>
                  <input value={followerCount} onChange={(e) => setFollowerCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 gcw-text-tag font-mono-num" />
                </div>
              </div>
            </div>

            {/* 研究标签与收录原因 */}
            <div className="gcw-panel p-3 space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                <Tag className="w-3.5 h-3.5 text-cyan-400" />
                <span>研究标签与收录原因</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {userTags.map((t) => (
                  <span key={t} className="gcw-chip-active px-2 py-0.5 rounded-full gcw-text-tag flex items-center gap-1">
                    {t}
                    <button onClick={() => removeTag(t)} className="hover:text-rose-300"><X className="w-3 h-3" /></button>
                  </span>
                ))}
                <div className="flex items-center gap-1">
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); setTagInput(''); } }}
                    placeholder="+ 输入人工标签回车..."
                    className="gcw-input px-2 py-0.5 gcw-text-tag w-36"
                  />
                  <button
                    type="button"
                    onClick={() => { addTag(tagInput); setTagInput(''); }}
                    className="gcw-btn-ghost p-1 rounded"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {aiSuggestedTags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 gcw-text-meta">
                  <span className="text-purple-300 flex items-center gap-0.5">
                    <Sparkles className="w-3 h-3" /> AI 建议标签：
                  </span>
                  {aiSuggestedTags.map((st) => {
                    const adopted = userTags.includes(st);
                    return (
                      <button
                        key={st}
                        type="button"
                        disabled={adopted}
                        onClick={() => addTag(st)}
                        className={`px-2 py-0.5 rounded-full border ${adopted ? 'bg-slate-800/60 border-slate-700 text-slate-500' : 'bg-purple-500/15 border-purple-500/40 text-purple-200 hover:bg-purple-500/25'}`}
                      >
                        {adopted ? `✓ ${st}` : `+ ${st}`}
                      </button>
                    );
                  })}
                </div>
              )}

              <textarea
                value={captureReason}
                onChange={(e) => setCaptureReason(e.target.value)}
                rows={2}
                placeholder="收录原因 / 核心亮点（可选）..."
                className="gcw-input w-full px-2.5 py-1.5 text-xs"
              />
            </div>
          </div>
        )}

        {/* 底栏 */}
        <div className="px-5 py-3 bg-[#131E36] border-t border-[#1E2E4A] flex items-center justify-between text-xs">
          <span className="gcw-text-tag text-slate-400">
            确认后写入<strong className="text-cyan-300">选题资产中心</strong>，作品全局去重，不会自动进入文案工坊
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="gcw-btn-ghost px-3 py-1.5 rounded-lg">取消</button>
            <button
              onClick={handleSave}
              disabled={saving || loadingPreview}
              className="gcw-btn-cyan px-4 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              确认收录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
