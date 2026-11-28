import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Download,
  ExternalLink,
  FileCheck2,
  Image as ImageIcon,
  Loader2,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { api } from '../api';

interface Props {
  projectId: number;
}

const STATE_LABELS: Record<string, { text: string; cls: string }> = {
  draft: { text: '草稿', cls: 'bg-slate-800 text-slate-300' },
  validated: { text: '已校验', cls: 'bg-cyan-500/20 text-cyan-300' },
  fill_authorized: { text: '已授权填写', cls: 'bg-indigo-500/20 text-indigo-300' },
  filling: { text: '填写中', cls: 'bg-cyan-500/25 text-cyan-200' },
  awaiting_user: { text: '待本人确认发布', cls: 'bg-amber-500/25 text-amber-200 border border-amber-400/40' },
  scheduled_confirmed: { text: '已确认定时', cls: 'bg-indigo-500/25 text-indigo-200' },
  published_confirmed: { text: '已确认发布', cls: 'bg-emerald-500/20 text-emerald-300' },
  needs_reconcile: { text: '待人工对账', cls: 'bg-rose-500/25 text-rose-200' },
  not_logged_in: { text: '登录已过期', cls: 'bg-rose-500/20 text-rose-300' },
  failed: { text: '失败', cls: 'bg-rose-500/20 text-rose-300' },
  cancelled: { text: '已取消', cls: 'bg-slate-800 text-slate-500' },
  skipped: { text: '已跳过', cls: 'bg-slate-800 text-slate-500' },
};

/** G2 多平台发布中心（B01–B11，全 7 平台强制只填写不自动发布） */
export default function PublishHub({ projectId }: Props) {
  const [caps, setCaps] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [activePkg, setActivePkg] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [calendar, setCalendar] = useState<any[]>([]);

  const [selectedPlatforms, setSelectedPlatforms] = useState<Record<string, boolean>>({
    bilibili: true,
    douyin: true,
    xiaohongshu: true,
    wechat_channels: true,
    youtube: true,
    x: true,
    instagram: true,
  });
  const [boundAccountByPlat, setBoundAccountByPlat] = useState<Record<string, number | ''>>({});
  const [drafts, setDrafts] = useState<Record<string, any>>({});
  const [covers, setCovers] = useState<Record<string, any>>({});
  const [validation, setValidation] = useState<any>(null);

  const [editingPlat, setEditingPlat] = useState<string | null>(null);
  const [reconcileTask, setReconcileTask] = useState<any>(null);
  const [pubUrlInput, setPubUrlInput] = useState('');
  const [pubIdInput, setPubIdInput] = useState('');

  const [newPkgModal, setNewPkgModal] = useState(false);
  const [newPkgTitle, setNewPkgTitle] = useState('');
  const [newPkgVideoPath, setNewPkgVideoPath] = useState('');

  const [newAccModal, setNewAccModal] = useState(false);
  const [accPlat, setAccPlat] = useState('bilibili');
  const [accUid, setAccUid] = useState('');
  const [accName, setAccName] = useState('');

  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 4200);
  };

  const loadAll = async (preferPid?: number) => {
    const [capData, accList, pkgList, calList] = await Promise.all([
      api.publishCapabilities().catch(() => null),
      api.listPublishAccounts(projectId).catch(() => []),
      api.listPublishPackages(projectId).catch(() => []),
      api.publishCalendar(projectId).catch(() => []),
    ]);
    setCaps(capData);
    setAccounts(accList || []);
    setPackages(pkgList || []);
    setCalendar(calList || []);

    const accMap: Record<string, number | ''> = {};
    for (const a of accList || []) {
      if (!accMap[a.platform]) accMap[a.platform] = a.id;
    }
    setBoundAccountByPlat((prev) => ({ ...accMap, ...prev }));

    const target = preferPid
      ? pkgList.find((p: any) => p.id === preferPid)
      : activePkg
      ? pkgList.find((p: any) => p.id === activePkg.id) || pkgList[0]
      : pkgList[0];
    if (target) {
      await openPackage(target.id);
    } else {
      setActivePkg(null);
      setTasks([]);
      setDrafts({});
      setCovers({});
      setValidation(null);
    }
  };

  const openPackage = async (pid: number) => {
    const data = await api.getPublishPackage(pid);
    setActivePkg(data.package);
    setTasks(data.tasks || []);
    setDrafts(data.package.drafts_json ? JSON.parse(data.package.drafts_json) : {});
    setCovers(data.package.covers_json ? JSON.parse(data.package.covers_json) : {});
    setValidation(data.package.validation_json ? JSON.parse(data.package.validation_json) : null);
  };

  useEffect(() => {
    loadAll();
  }, [projectId]);

  const platforms: any[] = caps?.allowed_platforms || [];
  const pickedList = useMemo(
    () => platforms.map((p) => p.id).filter((id) => selectedPlatforms[id]),
    [platforms, selectedPlatforms]
  );

  const createPackage = async () => {
    if (!newPkgTitle.trim()) return;
    setBusy('create');
    try {
      const created = await api.createPublishPackage({
        project_id: projectId,
        title: newPkgTitle.trim(),
        video_file_path: newPkgVideoPath.trim(),
      });
      setNewPkgModal(false);
      setNewPkgTitle('');
      setNewPkgVideoPath('');
      await loadAll(created.id);
      showToast('✅ 已新建发布工程包');
    } catch (e: any) {
      showToast('创建失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleGenerateDrafts = async () => {
    if (!activePkg) return;
    setBusy('drafts');
    try {
      const r = await api.generatePublishDrafts(activePkg.id, { platforms: pickedList, use_llm: true });
      setDrafts(r.drafts || {});
      await openPackage(activePkg.id);
      showToast(`✅ 已生成 ${Object.keys(r.drafts || {}).length} 个平台独立文案草稿`);
    } catch (e: any) {
      showToast('生成文案失败：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleValidate = async () => {
    if (!activePkg) return;
    setBusy('validate');
    try {
      await api.patchPublishPackage(activePkg.id, { drafts });
      const res = await api.validatePublishPackage(activePkg.id, pickedList);
      setValidation(res);
      showToast(res.passed ? '✅ 全部选中平台规则校验通过' : '⚠️ 部分平台校验未通过，请查看错误明细');
    } catch (e: any) {
      showToast('校验出错：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleAuthorizeFill = async (openBrowser: boolean) => {
    if (!activePkg || pickedList.length === 0) return;
    setBusy('fill');
    try {
      await api.patchPublishPackage(activePkg.id, { drafts });
      const items = pickedList.map((plat) => ({
        platform: plat,
        account_id: boundAccountByPlat[plat] ? Number(boundAccountByPlat[plat]) : undefined,
        scheduled_at: drafts[plat]?.scheduled_at || undefined,
      }));
      const r = await api.authorizeFillTasks({
        package_id: activePkg.id,
        items,
        open_browser: openBrowser,
      });
      await openPackage(activePkg.id);
      const cal = await api.publishCalendar(projectId).catch(() => []);
      setCalendar(cal || []);
      const dedupCount = (r.tasks || []).filter((t: any) => t.deduplicated).length;
      showToast(
        dedupCount > 0
          ? `✅ 已处理 ${r.tasks.length} 个平台（命中防重 ${dedupCount} 条），全部停在「待本人确认发布」`
          : `✅ 已授权 ${r.tasks.length} 个平台进入「待本人确认发布」，请本人在官方页核对发布`
      );
    } catch (e: any) {
      showToast('授权填写受阻：' + e.message);
    } finally {
      setBusy('');
    }
  };

  const handleConfirmPublished = async () => {
    if (!reconcileTask) return;
    try {
      await api.reconcilePublishTask(reconcileTask.id, {
        action: 'confirm_published',
        published_url: pubUrlInput.trim(),
        external_item_id: pubIdInput.trim() || undefined,
      });
      setReconcileTask(null);
      setPubUrlInput('');
      setPubIdInput('');
      if (activePkg) await openPackage(activePkg.id);
      setCalendar(await api.publishCalendar(projectId).catch(() => []));
      showToast('✅ 已人工确认发布并回填真实官方链接');
    } catch (e: any) {
      showToast(e.message);
    }
  };

  const handleCreateAccount = async () => {
    if (!accUid.trim()) return;
    try {
      await api.createPublishAccount({
        project_id: projectId,
        platform: accPlat,
        external_uid: accUid.trim(),
        display_name: accName.trim() || accUid.trim(),
      });
      setNewAccModal(false);
      setAccUid('');
      setAccName('');
      await loadAll(activePkg?.id);
      showToast('✅ 已登记平台账号（已分配独立隔离 Profile）');
    } catch (e: any) {
      showToast('登记失败：' + e.message);
    }
  };

  const awaitingCount = tasks.filter((t) => t.state === 'awaiting_user').length;
  const confirmedCount = tasks.filter((t) => t.state === 'published_confirmed' && t.published_url).length;
  const allLogs = useMemo(() => {
    const out: { ts: string; plat: string; level: string; message: string }[] = [];
    for (const t of tasks) {
      const arr = t.logs_json ? JSON.parse(t.logs_json) : [];
      for (const l of arr) {
        out.push({ ts: l.ts, plat: t.platform, level: l.level, message: l.message });
      }
    }
    return out.reverse().slice(0, 20);
  }, [tasks]);

  return (
    <div className="h-full flex flex-col gap-3 overflow-hidden">
      {/* 顶部栏 */}
      <div className="bg-[#0b1120] border border-slate-800 rounded-xl px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Send className="w-4 h-4 text-cyan-400" />
          <select
            value={activePkg?.id || ''}
            onChange={(e) => e.target.value && openPackage(Number(e.target.value))}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 max-w-[240px]"
          >
            {packages.length === 0 && <option value="">暂无发布工程</option>}
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <button
            onClick={() => setNewPkgModal(true)}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> 新建发布包
          </button>
          <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-200 gcw-text-meta">
            🔒 全 7 平台只填写 · 严禁自动发布
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={handleGenerateDrafts}
            disabled={!activePkg || busy === 'drafts'}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-cyan-300 flex items-center gap-1 disabled:opacity-40"
          >
            {busy === 'drafts' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            生成 7 平台文案
          </button>
          <button
            onClick={handleValidate}
            disabled={!activePkg || busy === 'validate'}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-amber-300 flex items-center gap-1 disabled:opacity-40"
          >
            <FileCheck2 className="w-3.5 h-3.5" /> 校验发布包
          </button>
          {activePkg && (
            <a
              href={`/api/publish/packages/${activePkg.id}/export-protocol`}
              className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-200 flex items-center gap-1"
            >
              <Download className="w-3.5 h-3.5" /> 导出 publish.json
            </a>
          )}
          <button
            onClick={() => handleAuthorizeFill(false)}
            disabled={!activePkg || pickedList.length === 0 || busy === 'fill'}
            className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-40"
          >
            <ShieldCheck className="w-3.5 h-3.5" /> 授权填写选中平台
          </button>
        </div>
      </div>

      {toast && (
        <div className="px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/35 text-cyan-200 text-xs">
          {toast}
        </div>
      )}

      {/* KPI 状态卡（无真实数据时一律显示 —） */}
      <div className="grid grid-cols-4 gap-2.5 shrink-0">
        <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3">
          <div className="gcw-text-tag text-slate-400">已选白名单平台</div>
          <div className="text-xl font-bold text-cyan-300 font-mono-num mt-1">{pickedList.length} / 7</div>
          <div className="gcw-text-meta text-slate-500 mt-0.5">B12 暂定平台已硬拦截</div>
        </div>
        <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3">
          <div className="gcw-text-tag text-slate-400">平台规则版本</div>
          <div className="text-base font-bold text-slate-100 font-mono-num mt-1.5">{caps?.rules_version || '—'}</div>
          <div className="gcw-text-meta text-slate-500 mt-0.5">医疗类仅提醒人工复核</div>
        </div>
        <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3">
          <div className="gcw-text-tag text-slate-400">待本人确认发布</div>
          <div className="text-xl font-bold text-amber-300 font-mono-num mt-1">{tasks.length ? awaitingCount : '—'}</div>
          <div className="gcw-text-meta text-slate-500 mt-0.5">需在官方页本人点发布</div>
        </div>
        <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3">
          <div className="gcw-text-tag text-slate-400">真实回填链接</div>
          <div className="text-xl font-bold text-emerald-300 font-mono-num mt-1">{tasks.length ? confirmedCount : '—'}</div>
          <div className="gcw-text-meta text-slate-500 mt-0.5">以官方页确认 URL 为准</div>
        </div>
      </div>

      {/* 主体两栏 */}
      <div className="flex-1 flex gap-3 min-h-0 overflow-hidden">
        {/* 左主区：7 平台逐卡表 + 多尺寸封面 + 发布日历 */}
        <div className="flex-1 flex flex-col gap-3 min-w-0 overflow-y-auto pr-1">
          {/* 成片路径与多尺寸封面（B02） */}
          {activePkg && (
            <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-1 min-w-[260px]">
                  <span className="text-slate-400 shrink-0">成片本地路径：</span>
                  <input
                    value={activePkg.video_file_path || ''}
                    onChange={(e) => setActivePkg({ ...activePkg, video_file_path: e.target.value })}
                    onBlur={() => api.patchPublishPackage(activePkg.id, { video_file_path: activePkg.video_file_path })}
                    placeholder="填写本地成片 .mp4 / .mov 绝对路径..."
                    className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono-num text-slate-200"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  {(['16:9', '4:3', '3:4'] as const).map((slot) => (
                    <label
                      key={slot}
                      className={`px-2 py-1 rounded border gcw-text-tag cursor-pointer flex items-center gap-1 ${
                        covers[slot]
                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                          : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-cyan-500/50'
                      }`}
                    >
                      <ImageIcon className="w-3 h-3" />
                      {slot}封面{covers[slot] ? `(${covers[slot].width || '?'}x${covers[slot].height || '?'})` : ''}
                      <input
                        type="file"
                        accept=".png,.jpg,.jpeg,.webp"
                        className="hidden"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          try {
                            const r = await api.uploadPublishCover(activePkg.id, slot, f);
                            setCovers(r.covers);
                            showToast(`✅ 已上传 ${slot} 封面`);
                          } catch (err: any) {
                            showToast(err.message);
                          }
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>
              {validation?.global_errors?.length > 0 && (
                <div className="p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 gcw-text-tag">
                  {validation.global_errors.join('；')}
                </div>
              )}
            </div>
          )}

          {/* 7 平台逐行卡片 */}
          <div className="bg-[#0b1120] border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-[#0f172a] gcw-text-tag text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3 w-10">选</th>
                  <th className="py-2.5 px-2">平台 / 绑定账号</th>
                  <th className="py-2.5 px-2">独立文案与规则校验</th>
                  <th className="py-2.5 px-2">计划定时 ({activePkg?.schedule_timezone || 'Asia/Shanghai'})</th>
                  <th className="py-2.5 px-3 text-right">任务状态与操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {platforms.map((p) => {
                  const d = drafts[p.id] || {};
                  const pVal = validation?.platforms?.[p.id];
                  const latestTask = tasks.find((t) => t.platform === p.id);
                  const stInfo = latestTask ? STATE_LABELS[latestTask.state] || STATE_LABELS.draft : null;
                  const platAccounts = accounts.filter((a) => a.platform === p.id);

                  return (
                    <tr key={p.id} className="hover:bg-slate-900/50">
                      <td className="py-2.5 px-3">
                        <input
                          type="checkbox"
                          checked={!!selectedPlatforms[p.id]}
                          onChange={(e) => setSelectedPlatforms((prev) => ({ ...prev, [p.id]: e.target.checked }))}
                        />
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                          <span>{p.name}</span>
                          <a href={p.upload_url} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-cyan-300" title="打开官方上传页">
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                        <select
                          value={boundAccountByPlat[p.id] || ''}
                          onChange={(e) => setBoundAccountByPlat((prev) => ({ ...prev, [p.id]: e.target.value ? Number(e.target.value) : '' }))}
                          className="mt-1 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 gcw-text-meta text-slate-300 max-w-[140px]"
                        >
                          <option value="">未绑定账号</option>
                          {platAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.display_name} ({a.authorization_state})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5 px-2 max-w-xs">
                        <div className="text-slate-200 truncate">{d.title || <span className="text-slate-500">未生成文案</span>}</div>
                        <div className="gcw-text-meta text-slate-400 truncate mt-0.5">{d.body || p.notes}</div>
                        <div className="flex items-center gap-2 mt-1">
                          <button
                            onClick={() => setEditingPlat(p.id)}
                            disabled={!activePkg}
                            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 gcw-text-meta text-cyan-300 disabled:opacity-40"
                          >
                            编辑草稿
                          </button>
                          {pVal && (
                            pVal.passed ? (
                              <span className="gcw-text-meta text-emerald-400 flex items-center gap-0.5"><CheckCircle2 className="w-3 h-3" />通过</span>
                            ) : (
                              <span className="gcw-text-meta text-rose-400 flex items-center gap-0.5" title={pVal.errors.join('; ')}><XCircle className="w-3 h-3" />{pVal.errors[0]}</span>
                            )
                          )}
                          {pVal?.warnings?.length > 0 && (
                            <span className="gcw-text-meta text-amber-300 flex items-center gap-0.5" title={pVal.warnings.join('; ')}>
                              <AlertTriangle className="w-3 h-3" />{pVal.warnings.length}提醒
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-2">
                        <input
                          type="datetime-local"
                          value={d.scheduled_at || ''}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [p.id]: { ...(prev[p.id] || {}), scheduled_at: e.target.value },
                            }))
                          }
                          className="bg-slate-950 border border-slate-800 rounded px-1.5 py-1 gcw-text-meta font-mono-num text-slate-300"
                        />
                      </td>
                      <td className="py-2.5 px-3 text-right space-y-1">
                        <div>
                          {stInfo ? (
                            <span className={`px-2 py-0.5 rounded gcw-text-meta ${stInfo.cls}`}>{stInfo.text}</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded gcw-text-meta bg-slate-900 text-slate-500">未发起</span>
                          )}
                        </div>
                        {latestTask && (
                          <div className="flex items-center justify-end gap-1">
                            {latestTask.state === 'awaiting_user' && (
                              <button
                                onClick={() => {
                                  setReconcileTask(latestTask);
                                  setPubUrlInput(latestTask.published_url || '');
                                  setPubIdInput(latestTask.external_item_id || '');
                                }}
                                className="px-2 py-0.5 rounded bg-emerald-600/30 hover:bg-emerald-600 text-emerald-200 gcw-text-meta"
                              >
                                回填确认链接
                              </button>
                            )}
                            {latestTask.published_url && (
                              <a
                                href={latestTask.published_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 gcw-text-meta"
                              >
                                看成片
                              </a>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 底部：发布日历与状态队列（B05） */}
          <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-cyan-400" /> 发布排期与队列（仅提醒与记录，绝不触发无人自动发布）
            </div>
            {calendar.length === 0 ? (
              <div className="text-xs text-slate-500 py-3 text-center">暂无已授权发布任务</div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {calendar.slice(0, 9).map((c) => (
                  <div key={c.id} className="p-2 rounded-lg bg-slate-900/80 border border-slate-800 gcw-text-tag space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200">{c.platform}</span>
                      <span className={`px-1.5 py-0.2 rounded gcw-text-meta ${(STATE_LABELS[c.state] || STATE_LABELS.draft).cls}`}>
                        {(STATE_LABELS[c.state] || STATE_LABELS.draft).text}
                      </span>
                    </div>
                    <div className="text-slate-300 truncate">{c.package_title}</div>
                    <div className="gcw-text-meta text-slate-500 font-mono-num">
                      {c.actual_published_at || c.scheduled_at || c.created_at}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右侧栏：发布前预检 + 账号隔离 Profile 管理 + 脱敏日志 */}
        <div className="w-80 shrink-0 flex flex-col gap-3 overflow-y-auto">
          <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3 space-y-2 text-xs">
            <div className="font-semibold text-slate-200">发布前预检清单</div>
            <div className="space-y-1.5 gcw-text-tag text-slate-300">
              <div>{activePkg?.video_file_path ? '☑' : '☐'} 成片文件存在且格式受支持</div>
              <div>{accounts.length > 0 ? '☑' : '☐'} 已登记独立隔离平台账号（不存密码/Cookie）</div>
              <div>{validation?.passed ? '☑' : '☐'} 7 平台字数/标签/外链/医疗人工复核已检查</div>
              <div>{Object.keys(covers).length > 0 ? '☑' : '☐'} 已准备 16:9 / 4:3 / 3:4 封面与本地时区</div>
            </div>
            <div className="gcw-text-meta text-amber-300/90 pt-1 border-t border-slate-800">
              红线：系统无任何自动提交接口，所有平台最终确认均由本人在官方原生页面完成。
            </div>
          </div>

          <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5 text-cyan-400" /> 平台账号 ({accounts.length})
              </span>
              <button onClick={() => setNewAccModal(true)} className="px-2 py-0.5 rounded bg-cyan-600/30 text-cyan-200 gcw-text-meta">
                + 登记账号
              </button>
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {accounts.map((a) => (
                <div key={a.id} className="p-2 rounded bg-slate-900 border border-slate-800 flex items-center justify-between gap-1 gcw-text-tag">
                  <div className="min-w-0">
                    <div className="text-slate-200 truncate">{a.platform} · {a.display_name}</div>
                    <div className="gcw-text-meta text-slate-500 font-mono-num truncate">UID: {a.external_uid} · {a.authorization_state}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() =>
                        api.checkPublishAccount(a.id, { authorization_state: 'logged_in', open_login_window: true }).then(() => {
                          loadAll(activePkg?.id);
                          showToast(`已为 ${a.display_name} 打开独立隔离 Chrome 登录窗口`);
                        })
                      }
                      className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-cyan-600 gcw-text-meta text-slate-200"
                    >
                      登录/校验
                    </button>
                    <button
                      onClick={() => api.delPublishAccount(a.id).then(() => loadAll(activePkg?.id))}
                      className="text-slate-500 hover:text-rose-400"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
              {accounts.length === 0 && <div className="gcw-text-tag text-slate-500">尚未登记平台账号</div>}
            </div>
          </div>

          <div className="bg-[#0b1120] border border-slate-800 rounded-xl p-3 space-y-2 text-xs flex-1 min-h-[140px]">
            <div className="font-semibold text-slate-200">执行日志（已自动脱敏）</div>
            <div className="space-y-1.5 gcw-text-tag">
              {allLogs.length === 0 ? (
                <div className="text-slate-500">尚未执行填写任务；失败或状态未知将标为待对账，禁止重复上传。</div>
              ) : (
                allLogs.map((l, i) => (
                  <div key={i} className="border-l-2 border-cyan-500/50 pl-2 py-0.5">
                    <div className="gcw-text-meta text-slate-500 font-mono-num">{l.ts} · {l.plat}</div>
                    <div className="text-slate-300">{l.message}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 新建发布包弹窗 */}
      {newPkgModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-[460px] bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3 text-xs">
            <div className="text-sm font-bold text-slate-100">新建多平台发布工程包</div>
            <input value={newPkgTitle} onChange={(e) => setNewPkgTitle(e.target.value)} placeholder="发布工程标题..." className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100" autoFocus />
            <input value={newPkgVideoPath} onChange={(e) => setNewPkgVideoPath(e.target.value)} placeholder="成片本地绝对路径（如 C:\...\video.mp4，可稍后填）" className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 font-mono-num text-slate-200" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setNewPkgModal(false)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300">取消</button>
              <button onClick={createPackage} className="px-3 py-1.5 rounded bg-cyan-600 text-white">创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 登记平台账号弹窗 */}
      {newAccModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-96 bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3 text-xs">
            <div className="text-sm font-bold text-slate-100">登记白名单平台账号（独立 Profile 隔离）</div>
            <select value={accPlat} onChange={(e) => setAccPlat(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100">
              {platforms.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
            </select>
            <input value={accUid} onChange={(e) => setAccUid(e.target.value)} placeholder="平台唯一账号 ID / Handle（必填）" className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100" />
            <input value={accName} onChange={(e) => setAccName(e.target.value)} placeholder="显示昵称（如：主号）" className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setNewAccModal(false)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300">取消</button>
              <button onClick={handleCreateAccount} className="px-3 py-1.5 rounded bg-cyan-600 text-white">登记</button>
            </div>
          </div>
        </div>
      )}

      {/* 单平台草稿编辑弹窗 */}
      {editingPlat && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-[520px] bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3 text-xs">
            <div className="text-sm font-bold text-slate-100">编辑 {editingPlat} 独立文案草稿</div>
            <input
              value={drafts[editingPlat]?.title || ''}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [editingPlat]: { ...(prev[editingPlat] || {}), title: e.target.value } }))}
              placeholder="标题..."
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100"
            />
            <textarea
              rows={5}
              value={drafts[editingPlat]?.body || ''}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [editingPlat]: { ...(prev[editingPlat] || {}), body: e.target.value } }))}
              placeholder="正文..."
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200"
            />
            <input
              value={(drafts[editingPlat]?.tags || []).join(', ')}
              onChange={(e) =>
                setDrafts((prev) => ({
                  ...prev,
                  [editingPlat]: { ...(prev[editingPlat] || {}), tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) },
                }))
              }
              placeholder="话题标签（逗号分隔）"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditingPlat(null)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300">关闭</button>
              <button
                onClick={async () => {
                  if (activePkg) await api.patchPublishPackage(activePkg.id, { drafts });
                  setEditingPlat(null);
                  showToast('✅ 已保存该平台独立草稿');
                }}
                className="px-3 py-1.5 rounded bg-cyan-600 text-white"
              >
                保存草稿
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 人工确认并回填真实发布链接弹窗（B09） */}
      {reconcileTask && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="w-[460px] bg-[#0f172a] border border-slate-700 rounded-xl p-4 space-y-3 text-xs">
            <div className="text-sm font-bold text-slate-100">人工确认已发布 · 回填真实链接（{reconcileTask.platform}）</div>
            <div className="gcw-text-tag text-slate-400">请在平台官方页面点击发布后，将真实作品链接回填至此处：</div>
            <input value={pubUrlInput} onChange={(e) => setPubUrlInput(e.target.value)} placeholder="官方作品 URL（https://...）" className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 font-mono-num text-slate-100" />
            <input value={pubIdInput} onChange={(e) => setPubIdInput(e.target.value)} placeholder="平台作品 ID（选填，如 BV号 / videoId）" className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 font-mono-num text-slate-200" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setReconcileTask(null)} className="px-3 py-1.5 rounded bg-slate-800 text-slate-300">取消</button>
              <button onClick={handleConfirmPublished} className="px-3 py-1.5 rounded bg-emerald-600 text-white">确认已发布</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
