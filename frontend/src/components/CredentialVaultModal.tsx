import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';

interface VaultItem {
  id: string;
  platform: string;
  site_url: string;
  username: string;
  has_password: boolean;
  note: string;
  created_at: string;
  updated_at: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  currentPlatformName?: string;
  currentUrl?: string;
  onOpenSite?: (url: string) => void;
}

const QUICK_PLATFORMS = [
  { name: '抖音热点榜', url: 'https://douhot.douyin.com/analysis' },
  { name: '抖音主页', url: 'https://www.douyin.com/jingxuan/' },
  { name: '巨量算数', url: 'https://trendinsight.oceanengine.com/arithmetic-index' },
  { name: '知乎', url: 'https://www.zhihu.com/' },
  { name: '百度', url: 'https://www.baidu.com/' },
  { name: 'Google', url: 'https://www.google.com/' },
  { name: 'YouTube', url: 'https://www.youtube.com/' },
  { name: '小红书', url: 'https://www.xiaohongshu.com/' },
  { name: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  { name: 'Reddit', url: 'https://www.reddit.com/' },
];

/**
 * 本地加密账号保险箱弹窗（Windows DPAPI 当前用户级加密）
 * - 默认列表不暴露明文密码，按需单条解密显示或复制；
 * - 严禁读取 Chrome 凭据或自动向第三方网页注入脚本。
 */
export default function CredentialVaultModal({
  open,
  onClose,
  currentPlatformName,
  currentUrl,
  onOpenSite,
}: Props) {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [encryptionInfo, setEncryptionInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [revealedMap, setRevealedMap] = useState<Record<string, string>>({});
  const [copiedKey, setCopiedKey] = useState('');
  const [errMsg, setErrMsg] = useState('');

  // 新增 / 编辑表单状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [fPlatform, setFPlatform] = useState('');
  const [fUrl, setFUrl] = useState('');
  const [fUsername, setFUsername] = useState('');
  const [fPassword, setFPassword] = useState('');
  const [fShowPwd, setFShowPwd] = useState(false);
  const [fNote, setFNote] = useState('');
  const [saving, setSaving] = useState(false);

  const loadVault = async () => {
    setLoading(true);
    setErrMsg('');
    try {
      const res = await api.vaultList();
      setItems(res.items || []);
      setEncryptionInfo(res.encryption || 'Windows DPAPI 本机用户级加密');
    } catch (e: any) {
      setErrMsg(e?.message || '读取保险箱失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      loadVault();
      setRevealedMap({});
    }
  }, [open]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? items.filter(
          (x) =>
            x.platform.toLowerCase().includes(q) ||
            x.username.toLowerCase().includes(q) ||
            x.site_url.toLowerCase().includes(q) ||
            x.note.toLowerCase().includes(q)
        )
      : items;
    // 当前正在浏览的平台优先置顶显示
    if (!currentPlatformName) return list;
    const cur = currentPlatformName.toLowerCase();
    return [...list].sort((a, b) => {
      const am = a.platform.toLowerCase().includes(cur) || cur.includes(a.platform.toLowerCase()) ? 0 : 1;
      const bm = b.platform.toLowerCase().includes(cur) || cur.includes(b.platform.toLowerCase()) ? 0 : 1;
      return am - bm;
    });
  }, [items, search, currentPlatformName]);

  if (!open) return null;

  const markCopied = (key: string) => {
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((prev) => (prev === key ? '' : prev)), 1800);
  };

  const handleCopyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      markCopied(key);
    } catch {
      setErrMsg('复制到剪贴板失败，请手动选中复制');
    }
  };

  const handleToggleReveal = async (id: string) => {
    if (revealedMap[id] !== undefined) {
      setRevealedMap((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const res = await api.vaultReveal(id);
      setRevealedMap((prev) => ({ ...prev, [id]: res.password || '' }));
    } catch (e: any) {
      setErrMsg(e?.message || '解密密码失败');
    }
  };

  const handleCopyPassword = async (id: string) => {
    try {
      let pwd = revealedMap[id];
      if (pwd === undefined) {
        const res = await api.vaultReveal(id);
        pwd = res.password || '';
      }
      if (!pwd) {
        setErrMsg('该记录未保存密码');
        return;
      }
      await handleCopyText(pwd, `pwd_${id}`);
    } catch (e: any) {
      setErrMsg(e?.message || '解密复制密码失败');
    }
  };

  const openCreateForm = () => {
    setEditingId(null);
    setFPlatform(currentPlatformName || '');
    setFUrl(currentUrl || '');
    setFUsername('');
    setFPassword('');
    setFShowPwd(false);
    setFNote('');
    setShowForm(true);
    setErrMsg('');
  };

  const openEditForm = (item: VaultItem) => {
    setEditingId(item.id);
    setFPlatform(item.platform);
    setFUrl(item.site_url);
    setFUsername(item.username);
    setFPassword('');
    setFShowPwd(false);
    setFNote(item.note);
    setShowForm(true);
    setErrMsg('');
  };

  const handleSave = async () => {
    if (!fPlatform.trim() || !fUsername.trim()) {
      setErrMsg('请填写平台名称和账号');
      return;
    }
    setSaving(true);
    setErrMsg('');
    try {
      if (editingId) {
        await api.vaultUpdate(editingId, {
          platform: fPlatform.trim(),
          site_url: fUrl.trim(),
          username: fUsername.trim(),
          password: fPassword ? fPassword : undefined,
          note: fNote.trim(),
        });
      } else {
        await api.vaultCreate({
          platform: fPlatform.trim(),
          site_url: fUrl.trim(),
          username: fUsername.trim(),
          password: fPassword,
          note: fNote.trim(),
        });
      }
      setShowForm(false);
      setEditingId(null);
      setRevealedMap({});
      await loadVault();
    } catch (e: any) {
      setErrMsg(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: VaultItem) => {
    if (!window.confirm(`确定删除「${item.platform} (${item.username})」的保险箱记录吗？`)) return;
    try {
      await api.vaultDelete(item.id);
      await loadVault();
    } catch (e: any) {
      setErrMsg(e?.message || '删除失败');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="bg-[#111A2E] border border-[#2C4268] rounded-2xl shadow-2xl w-full max-w-3xl max-h-[86vh] flex flex-col overflow-hidden text-slate-100">
        {/* 顶栏 */}
        <div className="px-5 py-3.5 bg-[#131E36] border-b border-[#1E2E4A] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center text-cyan-300">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <div className="font-bold text-sm flex items-center gap-2">
                <span>本地加密账号保险箱</span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 text-[10px] font-medium flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" /> {encryptionInfo || 'Windows DPAPI 加密'}
                </span>
              </div>
              <div className="text-[11px] text-slate-400">
                仅加密保存在本机 <code className="text-cyan-300">data/credential_vault.json</code>，仅当前 Windows 用户可解密；不读取 Chrome 凭据，不自动注入第三方网页
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100"
            title="关闭保险箱"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 工具条 */}
        <div className="px-5 py-2.5 border-b border-[#1E2E4A] flex items-center gap-2 bg-[#0D1526]">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索平台名称、账号、网址或备注..."
              className="gcw-input w-full pl-8 pr-3 py-1.5 text-xs"
            />
          </div>
          <button
            onClick={openCreateForm}
            className="gcw-btn-cyan px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> 新增账号
          </button>
        </div>

        {errMsg && (
          <div className="px-5 py-1.5 bg-rose-500/15 border-b border-rose-500/35 text-rose-300 text-xs">
            ⚠ {errMsg}
          </div>
        )}

        {/* 主体内容 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-[#0B111E]">
          {showForm && (
            <div className="p-4 rounded-xl bg-[#162238] border border-cyan-500/40 space-y-3 shadow-lg">
              <div className="flex items-center justify-between">
                <span className="font-bold text-xs text-cyan-300">
                  {editingId ? '编辑账号记录' : '新增平台账号（密码将使用 Windows DPAPI 加密保存）'}
                </span>
                <button onClick={() => setShowForm(false)} className="text-xs text-slate-400 hover:text-slate-100">
                  取消
                </button>
              </div>

              {/* 快捷平台选择 */}
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PLATFORMS.map((qp) => (
                  <button
                    key={qp.name}
                    type="button"
                    onClick={() => {
                      setFPlatform(qp.name);
                      setFUrl(qp.url);
                    }}
                    className={`px-2 py-0.5 rounded-full text-[11px] ${
                      fPlatform === qp.name ? 'gcw-chip-active font-semibold' : 'gcw-chip'
                    }`}
                  >
                    {qp.name}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">平台名称 *</label>
                  <input
                    value={fPlatform}
                    onChange={(e) => setFPlatform(e.target.value)}
                    placeholder="如：抖音热点榜 / 知乎 / 小红书"
                    className="gcw-input w-full px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">登录网址</label>
                  <input
                    value={fUrl}
                    onChange={(e) => setFUrl(e.target.value)}
                    placeholder="https://..."
                    className="gcw-input w-full px-2.5 py-1.5 font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">账号 / 手机号 / 邮箱 *</label>
                  <input
                    value={fUsername}
                    onChange={(e) => setFUsername(e.target.value)}
                    placeholder="输入登录账号"
                    className="gcw-input w-full px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    密码 {editingId ? '（留空则保留原加密密码）' : ''}
                  </label>
                  <div className="relative">
                    <input
                      type={fShowPwd ? 'text' : 'password'}
                      value={fPassword}
                      onChange={(e) => setFPassword(e.target.value)}
                      placeholder={editingId ? '留空不修改' : '输入密码'}
                      className="gcw-input w-full pl-2.5 pr-8 py-1.5"
                    />
                    <button
                      type="button"
                      onClick={() => setFShowPwd((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                    >
                      {fShowPwd ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="text-xs">
                <label className="block text-[11px] text-slate-400 mb-1">备注（如：扫码绑定手机尾号、主号/小号）</label>
                <input
                  value={fNote}
                  onChange={(e) => setFNote(e.target.value)}
                  placeholder="可选备注..."
                  className="gcw-input w-full px-2.5 py-1.5"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowForm(false)}
                  className="gcw-btn-ghost px-3 py-1.5 rounded-lg text-xs"
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="gcw-btn-cyan px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                >
                  {saving ? '加密保存中...' : '加密保存到保险箱'}
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-center py-10 text-xs text-slate-400">正在读取加密保险箱...</div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center py-12 space-y-2 text-xs text-slate-400 bg-[#111A2E] rounded-xl border border-dashed border-[#2C4268]">
              <Lock className="w-6 h-6 mx-auto text-cyan-400 opacity-80" />
              <div className="font-semibold text-slate-200">保险箱暂未保存账号</div>
              <div>点击右上角「+ 新增账号」，将各研究平台的账号密码安全加密保存在本机，登录时一键复制即可。</div>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map((item) => {
                const isCurrent =
                  currentPlatformName &&
                  (item.platform.toLowerCase().includes(currentPlatformName.toLowerCase()) ||
                    currentPlatformName.toLowerCase().includes(item.platform.toLowerCase()));
                const revealed = revealedMap[item.id];
                return (
                  <div
                    key={item.id}
                    className={`p-3.5 rounded-xl bg-[#162238] border transition space-y-2 ${
                      isCurrent ? 'border-cyan-400/70 ring-1 ring-cyan-400/20' : 'border-[#1E2E4A]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-bold text-xs text-slate-100">{item.platform}</span>
                        {isCurrent && (
                          <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/35 text-cyan-300 text-[10px] font-medium">
                            当前平台
                          </span>
                        )}
                        {item.site_url && (
                          <button
                            onClick={() => {
                              if (onOpenSite) {
                                onClose();
                                onOpenSite(item.site_url);
                              }
                            }}
                            className="text-[11px] text-cyan-300 hover:underline flex items-center gap-0.5 truncate max-w-[260px]"
                            title={`在内置浏览器打开 ${item.site_url}`}
                          >
                            <span className="truncate">{item.site_url}</span>
                            <ExternalLink className="w-3 h-3 shrink-0" />
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => openEditForm(item)}
                          className="p-1 rounded hover:bg-slate-700/60 text-slate-400 hover:text-slate-100"
                          title="编辑"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(item)}
                          className="p-1 rounded hover:bg-rose-500/20 text-rose-400"
                          title="删除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {/* 账号 */}
                      <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#0C1424] border border-[#1E2E4A]">
                        <div className="truncate">
                          <span className="text-[10px] text-slate-500 mr-1.5">账号</span>
                          <span className="font-mono-num text-slate-100">{item.username}</span>
                        </div>
                        <button
                          onClick={() => handleCopyText(item.username, `usr_${item.id}`)}
                          className="gcw-btn-ghost px-1.5 py-0.5 rounded text-[10px] flex items-center gap-0.5 shrink-0 ml-2"
                        >
                          {copiedKey === `usr_${item.id}` ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" /> 已复制
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" /> 复制
                            </>
                          )}
                        </button>
                      </div>

                      {/* 密码 */}
                      <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#0C1424] border border-[#1E2E4A]">
                        <div className="truncate">
                          <span className="text-[10px] text-slate-500 mr-1.5">密码</span>
                          <span className="font-mono-num text-slate-100">
                            {!item.has_password ? '—' : revealed !== undefined ? revealed : '••••••••••'}
                          </span>
                        </div>
                        {item.has_password && (
                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            <button
                              onClick={() => handleToggleReveal(item.id)}
                              className="gcw-btn-ghost p-1 rounded"
                              title={revealed !== undefined ? '隐藏密码' : '解密查看密码'}
                            >
                              {revealed !== undefined ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            </button>
                            <button
                              onClick={() => handleCopyPassword(item.id)}
                              className="gcw-btn-ghost px-1.5 py-0.5 rounded text-[10px] flex items-center gap-0.5"
                            >
                              {copiedKey === `pwd_${item.id}` ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-400" /> 已复制
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" /> 复制
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {item.note && (
                      <div className="text-[11px] text-slate-400">备注：{item.note}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
