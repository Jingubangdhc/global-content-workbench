import { useEffect, useState } from 'react';
import {
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
 * GCW-ASSET-01 · 内置浏览器一键收录当前视频弹窗（深蓝灰专业工作台规范）
 * - 自动填充可获得的真实数据，缺失留空（落库 NULL，前端展示 —）
 * - 三种收录方向：A 关联当前选题 / B 关联其他已有选题 / C 根据当前视频新建选题
 * - 支持人工标签 + AI 建议标签（点击采纳，绝不覆盖用户已确认标签）与收录原因
 * - 用户点击确认后才正式写入数据库，且保存视频绝不自动加入文案工坊
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
  currentTopicTitle,
  searchKeyword,
  initialPreview,
  initialOriginalShareUrl = '',
  loadingPreview,
  onSaved,
  onGoTopicHub,
}: Props) {
  const [selectedProjectId, setSelectedProjectId] = useState<number>(projectId);
  const [topics, setTopics] = useState<any[]>([]);
  const [targetMode, setTargetMode] = useState<'candidate_topic' | 'current_topic' | 'existing_topic' | 'new_topic'>(
    candidateTopicId ? 'candidate_topic' : currentTopicId ? 'current_topic' : 'existing_topic'
  );
  const [selectedTopicId, setSelectedTopicId] = useState<number | ''>(currentTopicId || '');
  const [newTopicTitle, setNewTopicTitle] = useState('');
  const [newTopicQuestion, setNewTopicQuestion] = useState('');
  const [newTopicAngle, setNewTopicAngle] = useState('');

  // 可编辑真实视频字段（空字符串保存时转为 NULL）
  const [url, setUrl] = useState('');
  const [originalShareUrl, setOriginalShareUrl] = useState('');
  const [multiLinkCandidates, setMultiLinkCandidates] = useState<string[]>([]);
  const [resolvingLink, setResolvingLink] = useState(false);
  const [savedResult, setSavedResult] = useState<any | null>(null);
  const [platform, setPlatform] = useState('');
  const [itemId, setItemId] = useState('');
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

  // 标签与收录原因（AI 建议标签仅作候选项，绝不覆盖用户已确认标签）
  const [userTags, setUserTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [aiSuggestedTags, setAiSuggestedTags] = useState<string[]>([]);
  const [captureReason, setCaptureReason] = useState('');

  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelectedProjectId(projectId);
    setSavedResult(null);
    setMultiLinkCandidates([]);
    setOriginalShareUrl(initialOriginalShareUrl || '');
  }, [open, projectId, initialOriginalShareUrl]);

  useEffect(() => {
    if (!open) return;
    setErrMsg('');
    const isOrigProject = selectedProjectId === projectId;
    api
      .topicHubList({ project_id: selectedProjectId, include_published: 'true', limit: 100 })
      .then((r) => {
        const list = r?.topics || [];
        setTopics(list);
        if (isOrigProject && candidateTopicId) {
          setTargetMode('candidate_topic');
          setSelectedTopicId(currentTopicId || '');
        } else if (isOrigProject && currentTopicId && list.some((t: any) => t.id === currentTopicId)) {
          setTargetMode('current_topic');
          setSelectedTopicId(currentTopicId);
        } else if (list.length > 0) {
          setTargetMode('existing_topic');
          setSelectedTopicId(list[0].id);
        } else {
          setTargetMode('new_topic');
          setSelectedTopicId('');
        }
      })
      .catch(() => setTopics([]));
  }, [open, selectedProjectId, projectId, currentTopicId, candidateTopicId]);

  useEffect(() => {
    if (!open || !initialPreview) return;
    setUrl(initialPreview.url || '');
    setPlatform(initialPreview.platform || '');
    setItemId(initialPreview.platform_item_id || '');
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
    setNewTopicTitle(initialPreview.title || '');
    setAiSuggestedTags(initialPreview.ai_suggested_tags || []);
    // 若该作品此前已收录过，保留用户已确认标签与原因
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
        if (r.original_share_url && r.original_share_url !== r.final_url) {
          setOriginalShareUrl(r.original_share_url);
        }
        setUrl(r.final_url);
        if (r.platform) setPlatform(r.platform);
        if (r.platform_item_id) setItemId(r.platform_item_id);
      } else {
        setErrMsg(r?.error || '未能确认具体作品链接，请在内置浏览器中核对');
      }
    } catch (e: any) {
      setErrMsg(e?.message || '分享链接解析失败');
    } finally {
      setResolvingLink(false);
    }
  };

  const handleSave = async () => {
    if (!url.trim() || !title.trim()) {
      setErrMsg('作品链接和视频标题不能为空');
      return;
    }
    if (targetMode === 'new_topic' && !newTopicTitle.trim()) {
      setErrMsg('请输入要新建的选题标题');
      return;
    }
    if (targetMode === 'candidate_topic' && (!candidateTopicId || selectedProjectId !== projectId)) {
      setErrMsg('切换研究项目后请选择该项目的已有选题或新建选题');
      return;
    }
    if ((targetMode === 'current_topic' || targetMode === 'existing_topic') && !selectedTopicId) {
      setErrMsg('请选择目标选题，或切换为「根据当前视频新建选题」');
      return;
    }

    setSaving(true);
    setErrMsg('');
    try {
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
        target_mode: targetMode,
        candidate_topic_id: targetMode === 'candidate_topic' ? candidateTopicId : null,
        target_topic_id: targetMode === 'current_topic' ? currentTopicId : selectedTopicId || null,
        new_topic_title: newTopicTitle.trim(),
        new_topic_question: newTopicQuestion.trim(),
        new_topic_angle: newTopicAngle.trim(),
      });
      if (res?.ok) {
        setSavedResult({ ...res, project_id: selectedProjectId });
        onSaved({ ...res, project_id: selectedProjectId });
      } else {
        setErrMsg(res?.error || '收录失败');
      }
    } catch (e: any) {
      setErrMsg(e?.message || '收录失败');
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
            <span className="font-bold text-sm">一键收录当前视频至 TopicHub</span>
            {initialPreview?.existing_content && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/35 text-amber-300 text-[10px]">
                作品已全局收录 (#{initialPreview.existing_content.content_id})，本次将去重更新并追加关联
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
          <div className="flex-1 overflow-y-auto p-4 space-y-3.5 text-xs bg-[#0B111E]">
            {errMsg && (
              <div className="px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/35 text-rose-300">
                ⚠ {errMsg}
              </div>
            )}

            {/* FIX-F03: 明确收录目的地、所属研究项目（可自由切换真实数据库项目）与关联选题归属确认条 */}
            <div className="px-3 py-2.5 rounded-lg bg-cyan-500/10 border border-cyan-500/40 space-y-1.5 text-[11px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 font-bold">
                    收录目的地：选题资产中心（TopicHub）
                  </span>
                  <span className="text-[10px] text-slate-300">绝不自动进文案工坊 · 不默认落入素材与作者库</span>
                </div>
                <span className="text-[10px] text-slate-400 font-mono-num">
                  采集时间：{initialPreview?.collected_at || '当前'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400 shrink-0">所属研究项目：</span>
                {projects.length > 0 ? (
                  <select
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(Number(e.target.value))}
                    className="gcw-input px-2 py-0.5 text-[11px] font-semibold text-cyan-200"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        #{p.id} {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <strong className="text-cyan-300">{projectName || `项目 #${selectedProjectId}`}</strong>
                )}
                <span className="text-slate-600">|</span>
                <span className="text-slate-400">关联选题：</span>
                <strong className="text-slate-100">
                  {targetMode === 'candidate_topic' && candidateTopicId && selectedProjectId === projectId
                    ? (currentTopicId ? `已沉淀正式选题 #${currentTopicId}「${candidateTopicTitle}」` : `方案A自动沉淀候选选题「${candidateTopicTitle}」→ 选题资产中心（待研究）`)
                    : targetMode === 'new_topic'
                      ? `新建选题「${newTopicTitle || title}」（待研究）`
                      : `已有选题 #${selectedTopicId || '未选'}`}
                </strong>
              </div>
            </div>

            {savedResult && (
              <div className="px-3.5 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-400/50 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-200">
                <div>
                  ✅ 已成功收录至 <strong>选题资产中心</strong>（项目 #{savedResult.project_id} · 选题 #{savedResult.topic_id}「{savedResult.topic_title}」· 状态：{savedResult.topic_status || '待研究'}）
                </div>
                <div className="flex items-center gap-2">
                  {onGoTopicHub && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onGoTopicHub(savedResult.project_id, savedResult.topic_id);
                      }}
                      className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs"
                    >
                      在选题资产中心查看 →
                    </button>
                  )}
                  <button type="button" onClick={onClose} className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs">
                    关闭窗口
                  </button>
                </div>
              </div>
            )}

            {/* 顶部缩略图与基本信息 */}
            <div className="gcw-panel p-3 flex gap-3">
              <div className="w-40 h-[90px] shrink-0 rounded-lg overflow-hidden bg-[#0C1424] border border-[#2C4268] relative flex items-center justify-center">
                {thumbnailUrl ? (
                  <img src={thumbnailUrl} alt={title} className="w-full h-full object-cover" />
                ) : (
                  <Film className="w-6 h-6 text-slate-600" />
                )}
                {durationSec && (
                  <span className="absolute bottom-1 right-1 px-1.5 py-0.2 rounded bg-black/75 text-slate-100 text-[10px] font-mono-num">
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
                  <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="平台" className="gcw-input px-2 py-1 text-[11px]" />
                  <input value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="作品唯一 ID" className="gcw-input px-2 py-1 text-[11px] font-mono-num" />
                  <input value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} placeholder="发布时间" className="gcw-input px-2 py-1 text-[11px] font-mono-num" />
                </div>
                <div className="flex gap-1.5">
                  <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="作品链接 *（支持粘贴完整抖音分享文本后点击右侧解析）"
                    className="gcw-input flex-1 px-2 py-1 text-[11px] font-mono-num text-slate-300"
                  />
                  <button
                    type="button"
                    onClick={() => handleResolveShareText()}
                    disabled={resolvingLink || !url.trim()}
                    className="gcw-btn-ghost px-2 py-1 rounded text-[10px] shrink-0"
                    title="提取抖音/平台分享文本中的短链并安全校验解析"
                  >
                    {resolvingLink ? '解析中...' : '解析分享链'}
                  </button>
                </div>
                {originalShareUrl && (
                  <div className="text-[10px] text-slate-400 font-mono-num truncate">
                    原始分享链接留痕：{originalShareUrl}
                  </div>
                )}
                {multiLinkCandidates.length > 1 && (
                  <div className="p-1.5 rounded bg-amber-500/10 border border-amber-500/35 space-y-1 text-[10px]">
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

            {/* 作者与真实统计字段（缺失留空存 NULL，前端显示 —） */}
            <div className="gcw-panel p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200">真实数据核对（缺失项请留空，严格存 NULL 不造假）</span>
                <span className="text-[10px] text-slate-400">支持输入 18.5万 / 1.2k 等格式自动解析</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">作者名</label>
                  <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px]" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">作者主页 URL</label>
                  <input value={authorUrl} onChange={(e) => setAuthorUrl(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px] font-mono-num" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">视频时长（秒）</label>
                  <input value={durationSec} onChange={(e) => setDurationSec(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px] font-mono-num" />
                </div>
              </div>
              <div className="grid grid-cols-6 gap-2">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">播放量</label>
                  <input value={viewCount} onChange={(e) => setViewCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px] font-mono-num" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">点赞量</label>
                  <input value={likeCount} onChange={(e) => setLikeCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px] font-mono-num" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">评论量</label>
                  <input value={commentCount} onChange={(e) => setCommentCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px] font-mono-num" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">收藏量</label>
                  <input value={favoriteCount} onChange={(e) => setFavoriteCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px] font-mono-num" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">分享量</label>
                  <input value={shareCount} onChange={(e) => setShareCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px] font-mono-num" />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-0.5">作者粉丝量</label>
                  <input value={followerCount} onChange={(e) => setFollowerCount(e.target.value)} placeholder="—" className="gcw-input w-full px-2 py-1 text-[11px] font-mono-num" />
                </div>
              </div>
            </div>

            {/* 三种收录方向：A 关联当前选题 / B 关联其他已有选题 / C 新建选题 */}
            <div className="gcw-panel p-3 space-y-2.5">
              <div className="font-semibold text-slate-200">选择收录方向（三选一）</div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={!currentTopicId}
                  onClick={() => { setTargetMode('current_topic'); if (currentTopicId) setSelectedTopicId(currentTopicId); }}
                  className={`p-2 rounded-lg text-left transition disabled:opacity-35 ${targetMode === 'current_topic' ? 'gcw-tab-active font-semibold' : 'gcw-btn-ghost'}`}
                >
                  <div className="text-[11px]">A. 关联当前选题</div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">{currentTopicTitle || '当前候选尚未入 TopicHub'}</div>
                </button>
                <button
                  type="button"
                  onClick={() => setTargetMode('existing_topic')}
                  className={`p-2 rounded-lg text-left transition ${targetMode === 'existing_topic' ? 'gcw-tab-active font-semibold' : 'gcw-btn-ghost'}`}
                >
                  <div className="text-[11px]">B. 关联其他已有选题</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">支持一视频关联多选题</div>
                </button>
                {candidateTopicId && (
                  <button
                    type="button"
                    onClick={() => setTargetMode('candidate_topic')}
                    className={`p-2 rounded-lg text-left transition ${targetMode === 'candidate_topic' ? 'gcw-tab-active font-semibold' : 'gcw-btn-ghost'}`}
                  >
                    <div className="text-[11px]">方案A · 关联当前候选选题（推荐）</div>
                    <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                      {currentTopicId ? `已入库 #${currentTopicId}，自动复用不改状态` : `首次收录自动存至 TopicHub（待研究）`}
                    </div>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setTargetMode('new_topic')}
                  className={`p-2 rounded-lg text-left transition ${targetMode === 'new_topic' ? 'gcw-tab-active font-semibold' : 'gcw-btn-ghost'}`}
                >
                  <div className="text-[11px]">C. 根据当前视频新建选题</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">新建选题验证等级保持 U</div>
                </button>
              </div>

              {targetMode === 'existing_topic' && (
                <select
                  value={selectedTopicId}
                  onChange={(e) => setSelectedTopicId(Number(e.target.value))}
                  className="gcw-input w-full px-2.5 py-1.5 text-xs"
                >
                  <option value="">请选择 TopicHub 已有选题...</option>
                  {topics.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.id} [{t.validation_grade}/{t.production_status_norm}] {t.topic_title}
                    </option>
                  ))}
                </select>
              )}

              {targetMode === 'new_topic' && (
                <div className="space-y-1.5 pt-1">
                  <input value={newTopicTitle} onChange={(e) => setNewTopicTitle(e.target.value)} placeholder="新选题标题 *" className="gcw-input w-full px-2.5 py-1.5 text-xs" />
                  <div className="grid grid-cols-2 gap-2">
                    <input value={newTopicQuestion} onChange={(e) => setNewTopicQuestion(e.target.value)} placeholder="核心研究问题（可选）" className="gcw-input px-2.5 py-1 text-[11px]" />
                    <input value={newTopicAngle} onChange={(e) => setNewTopicAngle(e.target.value)} placeholder="切入角度（可选）" className="gcw-input px-2.5 py-1 text-[11px]" />
                  </div>
                </div>
              )}
            </div>

            {/* 研究标签（人工标签 + AI 建议标签）与收录原因 */}
            <div className="gcw-panel p-3 space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                <Tag className="w-3.5 h-3.5 text-cyan-400" />
                <span>研究标签与收录原因</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {userTags.map((t) => (
                  <span key={t} className="gcw-chip-active px-2 py-0.5 rounded-full text-[11px] flex items-center gap-1">
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
                    className="gcw-input px-2 py-0.5 text-[11px] w-36"
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
                <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className="text-purple-300 flex items-center gap-0.5">
                    <Sparkles className="w-3 h-3" /> AI 建议标签（点击采纳，不覆盖已选）：
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
                placeholder="收录原因 / 核心亮点（例如：真实车主痛点反馈强、评论区提问集中）..."
                className="gcw-input w-full px-2.5 py-1.5 text-xs"
              />
            </div>
          </div>
        )}

        {/* 底栏 */}
        <div className="px-5 py-3 bg-[#131E36] border-t border-[#1E2E4A] flex items-center justify-between text-xs">
          <span className="text-[11px] text-slate-400">
            确认后写入 TopicHub，作品主体全局去重，且<strong className="text-cyan-300">不会自动加入文案工坊</strong>
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="gcw-btn-ghost px-3 py-1.5 rounded-lg">取消</button>
            <button
              onClick={handleSave}
              disabled={saving || loadingPreview}
              className="gcw-btn-cyan px-4 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              确认收录至 TopicHub
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
