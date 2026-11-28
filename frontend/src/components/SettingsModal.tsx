import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  Cpu,
  DollarSign,
  ExternalLink,
  KeyRound,
  Languages,
  Loader2,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from '../api';

interface Props {
  open: boolean;
  onClose: () => void;
  boot: any;
  onSaved: () => void;
  initialTab?: 'translation' | 'general';
}

interface ProviderField {
  key: string;
  label: string;
  type: 'secret' | 'url' | 'model' | 'text';
  required: boolean;
  placeholder: string;
}

interface ProviderItem {
  engine_id: string;
  name: string;
  short_name: string;
  protocol: string;
  batch_group: string;
  billing_category: string;
  billing_label: string;
  default_base_url: string;
  default_model: string;
  recommended_models: string[];
  official_links: { api_key_url: string; docs_url: string; pricing_url: string };
  fields: ProviderField[];
  notes: string;
  configured: boolean;
  is_default: boolean;
  secret_source: string;
  config: {
    base_url: string;
    model_id: string;
    region: string;
    local_endpoint: string;
    local_model_path: string;
    has_api_key: boolean;
    api_key_masked: string;
    has_access_key_id: boolean;
    access_key_id_masked: string;
    has_secret_access_key: boolean;
    secret_access_key_masked: string;
    saved_at: string;
    last_test_ok: boolean | null;
    last_test_at: string;
    last_test_message: string;
  };
}

const BILLING_BADGE: Record<string, { label: string; cls: string }> = {
  local_free: { label: '本地免费', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35' },
  free_quota: { label: '官方免费额度', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/35' },
  pay_as_you_go: { label: '按量付费', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/35' },
};

const GROUP_TITLE: Record<string, string> = {
  batch_1_openai: '第一批 · OpenAI 兼容模型',
  batch_2_native: '第二批 · 原生机器翻译协议',
  local_optional: '本地离线可选引擎',
};

export default function SettingsModal({ open, onClose, boot, onSaved, initialTab = 'translation' }: Props) {
  const env = boot?.env || {};
  const settings = boot?.settings || {};

  const [tab, setTab] = useState<'translation' | 'general'>(initialTab);

  // ==================== 翻译引擎与费用控制状态 ====================
  const [trLoading, setTrLoading] = useState(false);
  const [trOverview, setTrOverview] = useState<any>(null);
  const [selectedEngineId, setSelectedEngineId] = useState<string>('deepseek_llm');

  // 当前所选服务商的临时编辑表单（切换服务商立刻重置，绝不跨服务商混发密钥）
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModelId, setFormModelId] = useState('');
  const [formRegion, setFormRegion] = useState('cn-north-1');
  const [formLocalEndpoint, setFormLocalEndpoint] = useState('');
  const [formLocalModelPath, setFormLocalModelPath] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formAccessKeyId, setFormAccessKeyId] = useState('');
  const [formSecretAccessKey, setFormSecretAccessKey] = useState('');

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [connResult, setConnResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [sampleText, setSampleText] = useState('Why are patients flying to Shanghai for medical checkups?');
  const [testingSample, setTestingSample] = useState(false);
  const [sampleResult, setSampleResult] = useState<any>(null);

  const [trSaving, setTrSaving] = useState(false);
  const [trMsg, setTrMsg] = useState('');

  // GCW-UAT-R4-C: 本地免费翻译模型安装向导状态
  const [localEnv, setLocalEnv] = useState<any>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [localAuthChecked, setLocalAuthChecked] = useState(false);
  const [localWizardMsg, setLocalWizardMsg] = useState('');

  const localReqSeqRef = useRef(0);
  const connReqSeqRef = useRef(0);

  const inspectLocalEnv = async () => {
    const seq = ++localReqSeqRef.current;
    setLocalBusy(true);
    try {
      const res = await api.translationLocalInspect();
      if (seq !== localReqSeqRef.current) return;
      setLocalEnv(res);
      if (res?.deployment?.local_endpoint) setFormLocalEndpoint(res.deployment.local_endpoint);
      if (res?.deployment?.loaded_model_name) setFormModelId(res.deployment.loaded_model_name);
    } catch (e: any) {
      if (seq !== localReqSeqRef.current) return;
      setLocalWizardMsg('检测本地环境失败：' + (e?.message || e));
    } finally {
      if (seq === localReqSeqRef.current) setLocalBusy(false);
    }
  };

  const handleLocalService = async (action: 'start' | 'stop' | 'health') => {
    const seq = ++localReqSeqRef.current;
    setLocalBusy(true);
    setLocalWizardMsg('');
    setConnResult(null);
    try {
      const r = await api.translationLocalService(action, 'llama_cpp');
      if (seq !== localReqSeqRef.current) return;
      if (r?.env) setLocalEnv(r.env);
      setLocalWizardMsg(r?.message || '操作已执行');
      await loadTranslationOverview(selectedEngineId);
    } catch (e: any) {
      if (seq !== localReqSeqRef.current) return;
      setLocalWizardMsg('服务操作失败：' + (e?.message || e));
    } finally {
      if (seq === localReqSeqRef.current) setLocalBusy(false);
    }
  };

  const handleAuthorizedPull = async () => {
    setLocalBusy(true);
    setLocalWizardMsg('');
    try {
      const r = await api.translationLocalPull(localAuthChecked, formModelId || 'hy-mt3-1.8b');
      setLocalWizardMsg(r?.message || '');
    } catch (e: any) {
      setLocalWizardMsg('拉取引导失败：' + (e?.message || e));
    } finally {
      setLocalBusy(false);
    }
  };

  // 费用控制表单
  const [billingMode, setBillingMode] = useState<'free_only' | 'authorized_paid'>('free_only');
  const [autoTranslate, setAutoTranslate] = useState(false);
  const [monthlyCharLimit, setMonthlyCharLimit] = useState('500000');
  const [monthlyBudgetCny, setMonthlyBudgetCny] = useState('20');
  const [policySaving, setPolicySaving] = useState(false);

  // ==================== 通用与采集设置状态 ====================
  const [llmBaseUrl, setLlmBaseUrl] = useState(env.llm_base_url || 'https://api.deepseek.com/v1');
  const [llmModel, setLlmModel] = useState(env.llm_model || 'deepseek-chat');
  const [llmKey, setLlmKey] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [pexelsKey, setPexelsKey] = useState('');
  const [pixabayKey, setPixabayKey] = useState('');
  const [douyinApiBase, setDouyinApiBase] = useState(env.douyin_api_base || '');
  const [douyinStatus, setDouyinStatus] = useState('');
  const [asrEngine, setAsrEngine] = useState(env.asr_engine || 'whisper');
  const [cookieBrowser, setCookieBrowser] = useState(settings.cookie_browser || 'none');
  const [lowThreshold, setLowThreshold] = useState(settings.low_follower_threshold || '50000');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      loadTranslationOverview();
      inspectLocalEnv();
    }
  }, [open, initialTab]);

  const hydrateProviderForm = (providers: ProviderItem[], eid: string) => {
    const p = providers.find((x) => x.engine_id === eid) || providers[0];
    if (!p) return;
    setSelectedEngineId(p.engine_id);
    setFormBaseUrl(p.config.base_url || p.default_base_url || '');
    setFormModelId(p.config.model_id || p.default_model || '');
    setFormRegion(p.config.region || 'cn-north-1');
    setFormLocalEndpoint(p.config.local_endpoint || p.default_base_url || '');
    setFormLocalModelPath(p.config.local_model_path || '');
    // 切换服务商时强制清空临时密钥输入，防止误提交跨服务商密钥
    setFormApiKey('');
    setFormAccessKeyId('');
    setFormSecretAccessKey('');
    setAvailableModels(p.recommended_models || []);
    setConnResult(
      p.config.last_test_ok !== null && p.config.last_test_message
        ? { ok: Boolean(p.config.last_test_ok), message: `${p.config.last_test_message}（${p.config.last_test_at}）` }
        : null,
    );
    setSampleResult(null);
    setTrMsg('');
  };

  const loadTranslationOverview = async (keepEngineId?: string) => {
    setTrLoading(true);
    try {
      const data = await api.translationGetConfig();
      setTrOverview(data);
      const pol = data.policy || {};
      setBillingMode(pol.billing_mode === 'authorized_paid' ? 'authorized_paid' : 'free_only');
      setAutoTranslate(Boolean(pol.auto_translate));
      setMonthlyCharLimit(String(pol.monthly_char_limit ?? 500000));
      setMonthlyBudgetCny(String(pol.monthly_budget_cny ?? 20));
      const targetEid = keepEngineId || data.default_engine_id || selectedEngineId || 'deepseek_llm';
      hydrateProviderForm(data.providers || [], targetEid);
    } catch (e: any) {
      setTrMsg(`❌ 加载翻译配置失败：${e?.message || e}`);
    } finally {
      setTrLoading(false);
    }
  };

  if (!open) return null;

  const providers: ProviderItem[] = trOverview?.providers || [];
  const activeProvider: ProviderItem | undefined = providers.find((p) => p.engine_id === selectedEngineId);

  const handleSelectProvider = (eid: string) => {
    connReqSeqRef.current += 1;
    setLocalWizardMsg('');
    hydrateProviderForm(providers, eid);
  };

  const handleSaveProvider = async (setAsDefault = false) => {
    if (!activeProvider) return;
    setTrSaving(true);
    setTrMsg('');
    try {
      const payload: any = {
        base_url: formBaseUrl,
        model_id: formModelId,
        region: formRegion,
        local_endpoint: formLocalEndpoint,
        local_model_path: formLocalModelPath,
        set_as_default: setAsDefault,
      };
      if (formApiKey.trim()) payload.api_key = formApiKey.trim();
      if (formAccessKeyId.trim()) payload.access_key_id = formAccessKeyId.trim();
      if (formSecretAccessKey.trim()) payload.secret_access_key = formSecretAccessKey.trim();

      const updated = await api.translationSaveProvider(activeProvider.engine_id, payload);
      setTrOverview(updated);
      hydrateProviderForm(updated.providers || [], activeProvider.engine_id);
      setTrMsg(setAsDefault ? `✅ 已保存「${activeProvider.short_name}」配置并设为默认翻译引擎` : `✅ 已加密保存「${activeProvider.short_name}」配置`);
      onSaved();
    } catch (e: any) {
      setTrMsg(`❌ 保存失败：${e?.message || e}`);
    } finally {
      setTrSaving(false);
    }
  };

  const handleSetDefault = async () => {
    if (!activeProvider) return;
    setTrSaving(true);
    setTrMsg('');
    try {
      const updated = await api.translationSetDefault(activeProvider.engine_id);
      setTrOverview(updated);
      setTrMsg(`✅ 已将「${activeProvider.name}」设为默认翻译引擎`);
      onSaved();
    } catch (e: any) {
      setTrMsg(`❌ 设置默认引擎失败：${e?.message || e}`);
    } finally {
      setTrSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!activeProvider) return;
    const seq = ++connReqSeqRef.current;
    const targetEid = activeProvider.engine_id;
    setTestingConn(true);
    setConnResult(null);
    setTrMsg('');
    try {
      // 如果表单有未保存的 URL/模型/新密钥，先保存再测
      if (
        formApiKey.trim() ||
        formAccessKeyId.trim() ||
        formSecretAccessKey.trim() ||
        formBaseUrl !== activeProvider.config.base_url ||
        formModelId !== activeProvider.config.model_id ||
        formLocalEndpoint !== activeProvider.config.local_endpoint ||
        formLocalModelPath !== activeProvider.config.local_model_path
      ) {
        await api.translationSaveProvider(targetEid, {
          base_url: formBaseUrl,
          model_id: formModelId,
          region: formRegion,
          local_endpoint: formLocalEndpoint,
          local_model_path: formLocalModelPath,
          ...(formApiKey.trim() ? { api_key: formApiKey.trim() } : {}),
          ...(formAccessKeyId.trim() ? { access_key_id: formAccessKeyId.trim() } : {}),
          ...(formSecretAccessKey.trim() ? { secret_access_key: formSecretAccessKey.trim() } : {}),
        });
      }
      const res = await api.translationTestConnection(targetEid);
      if (seq !== connReqSeqRef.current) return;
      setConnResult({ ok: Boolean(res.ok), message: res.message || '' });
      if (Array.isArray(res.models) && res.models.length > 0) {
        setAvailableModels(Array.from(new Set([...res.models, ...(activeProvider.recommended_models || [])])));
      }
      await loadTranslationOverview(targetEid);
      if (targetEid === 'hunyuan_mt3_local') await inspectLocalEnv();
    } catch (e: any) {
      if (seq !== connReqSeqRef.current) return;
      setConnResult({ ok: false, message: e?.message || '连接测试失败' });
    } finally {
      if (seq === connReqSeqRef.current) setTestingConn(false);
    }
  };

  const handleFetchModels = async () => {
    if (!activeProvider) return;
    setFetchingModels(true);
    try {
      const res = await api.translationFetchModels(activeProvider.engine_id);
      if (Array.isArray(res.models)) {
        setAvailableModels(res.models);
      }
      setConnResult({ ok: Boolean(res.ok), message: res.message || '模型列表已刷新' });
    } catch (e: any) {
      setConnResult({ ok: false, message: e?.message || '获取模型列表失败' });
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTestSample = async () => {
    if (!activeProvider) return;
    setTestingSample(true);
    setSampleResult(null);
    try {
      const res = await api.translationTestSample(activeProvider.engine_id, sampleText, 'zh-CN');
      setSampleResult(res);
      await loadTranslationOverview(activeProvider.engine_id);
    } catch (e: any) {
      setSampleResult({ ok: false, message: e?.message || '小段翻译测试失败' });
    } finally {
      setTestingSample(false);
    }
  };

  const handleSavePolicy = async () => {
    setPolicySaving(true);
    setTrMsg('');
    try {
      const res = await api.translationUpdatePolicy({
        billing_mode: billingMode,
        auto_translate: autoTranslate,
        monthly_char_limit: parseInt(monthlyCharLimit, 10) || 0,
        monthly_budget_cny: parseFloat(monthlyBudgetCny) || 0,
      });
      setTrOverview((prev: any) => (prev ? { ...prev, policy: res.policy, usage: res.usage } : prev));
      setTrMsg('✅ 费用控制与自动翻译策略已保存');
      onSaved();
    } catch (e: any) {
      setTrMsg(`❌ 保存费用策略失败：${e?.message || e}`);
    } finally {
      setPolicySaving(false);
    }
  };

  // ==================== 通用设置逻辑 ====================
  const bookmarkletHref = `javascript:(function(){window.open('http://127.0.0.1:8000/quick-collect?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'_blank','width=460,height=280');})();`;

  const testDouyin = async () => {
    setDouyinStatus('检测中...');
    try {
      const r = await api.douyinApiHealth(douyinApiBase || 'http://127.0.0.1:8080');
      setDouyinStatus(r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`);
    } catch (e: any) {
      setDouyinStatus('❌ ' + e.message);
    }
  };

  const saveGeneral = async () => {
    setSaving(true);
    setMsg('');
    try {
      await api.saveSettings({
        cookie_browser: cookieBrowser,
        low_follower_threshold: parseInt(lowThreshold, 10) || 50000,
        llm_base_url: llmBaseUrl,
        llm_model: llmModel,
        llm_api_key: llmKey || undefined,
        tavily_api_key: tavilyKey || undefined,
        pexels_api_key: pexelsKey || undefined,
        pixabay_api_key: pixabayKey || undefined,
        douyin_api_base: douyinApiBase,
        asr_engine: asrEngine,
      });
      setMsg('✅ 已写入本地 .env 与数据库');
      setLlmKey('');
      setTavilyKey('');
      onSaved();
    } catch (e: any) {
      setMsg('❌ 保存失败：' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const usage = trOverview?.usage || {};
  const groupedOrder = ['batch_1_openai', 'batch_2_native', 'local_optional'];

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div className="bg-[#0f172a] border border-slate-700 rounded-xl w-full max-w-4xl max-h-[88vh] shadow-2xl overflow-hidden flex flex-col">
        {/* 顶栏 + 双标签页 */}
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-[#0b1120] shrink-0">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-slate-100 font-semibold text-sm">
              <Settings className="w-4 h-4 text-cyan-400" />
              <span>工作台设置与统一翻译引擎</span>
            </div>
            <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
              <button
                type="button"
                onClick={() => setTab('translation')}
                className={`px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
                  tab === 'translation'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                <Languages className="w-3.5 h-3.5" />
                <span>翻译引擎与费用控制</span>
              </button>
              <button
                type="button"
                onClick={() => setTab('general')}
                className={`px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
                  tab === 'general'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>通用与采集设置</span>
              </button>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ==================== 标签页 1：统一翻译引擎与费用控制 ==================== */}
        {tab === 'translation' && (
          <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
            {/* 顶部安全与费用总览条 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 space-y-1">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="flex items-center gap-1 font-medium text-slate-200">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    当前默认引擎
                  </span>
                  <span className="text-[10px] text-slate-500">DPAPI 本机加密</span>
                </div>
                <div className="text-sm font-semibold text-cyan-300 truncate">
                  {trOverview?.default_engine_id
                    ? providers.find((p) => p.engine_id === trOverview.default_engine_id)?.name || trOverview.default_engine_id
                    : '尚未设定（请先选定默认引擎）'}
                </div>
                <div className="text-[11px] text-slate-400">
                  密钥按服务商独立加密隔离，前端仅显示掩码
                </div>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 space-y-1">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="flex items-center gap-1 font-medium text-slate-200">
                    <DollarSign className="w-3.5 h-3.5 text-amber-400" />
                    本月用量与缓存复用
                  </span>
                  <span className="font-mono-num text-[10px] text-slate-400">{usage.month || '本月'}</span>
                </div>
                <div className="flex items-baseline gap-3 font-mono-num">
                  <span className="text-sm font-semibold text-slate-100">
                    {(usage.source_chars || 0).toLocaleString()} 字
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {(usage.total_tokens || 0).toLocaleString()} tok
                  </span>
                  <span className="text-[11px] text-amber-300">
                    ≈ ¥{Number(usage.estimated_cost_cny || 0).toFixed(3)}
                  </span>
                </div>
                <div className="text-[11px] text-emerald-400">
                  缓存零费用命中：{usage.cache_hits || 0} 次 / 总调用 {usage.total_calls || 0} 次
                </div>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-200">费用控制模式</span>
                  <button
                    type="button"
                    onClick={handleSavePolicy}
                    disabled={policySaving}
                    className="px-2 py-0.5 rounded bg-cyan-600/80 hover:bg-cyan-500 text-white text-[11px]"
                  >
                    {policySaving ? '保存中...' : '保存策略'}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setBillingMode('free_only')}
                    className={`py-1 px-2 rounded border text-[11px] font-medium ${
                      billingMode === 'free_only'
                        ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    仅允许免费模式
                  </button>
                  <button
                    type="button"
                    onClick={() => setBillingMode('authorized_paid')}
                    className={`py-1 px-2 rounded border text-[11px] font-medium ${
                      billingMode === 'authorized_paid'
                        ? 'bg-amber-500/20 border-amber-400/60 text-amber-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    用户授权付费模式
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-300 pt-0.5">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoTranslate}
                      onChange={(e) => setAutoTranslate(e.target.checked)}
                      className="rounded border-slate-600"
                    />
                    <span>提取后自动翻译</span>
                  </label>
                  <span className="text-slate-600">|</span>
                  <span className="text-slate-400">限额</span>
                  <input
                    type="number"
                    value={monthlyCharLimit}
                    onChange={(e) => setMonthlyCharLimit(e.target.value)}
                    className="w-16 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 font-mono-num text-[11px] text-slate-200"
                    title="月度字符上限"
                  />
                  <span className="text-slate-400">¥</span>
                  <input
                    type="number"
                    step="1"
                    value={monthlyBudgetCny}
                    onChange={(e) => setMonthlyBudgetCny(e.target.value)}
                    className="w-11 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 font-mono-num text-[11px] text-slate-200"
                    title="月度预算上限 (RMB)"
                  />
                </div>
              </div>
            </div>

            {trLoading && !trOverview ? (
              <div className="py-10 flex items-center justify-center text-slate-400 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>正在加载翻译引擎配置...</span>
              </div>
            ) : (
              <div className="grid grid-cols-12 gap-3">
                {/* 左侧：7 大服务商分组列表 */}
                <div className="col-span-4 bg-slate-900/70 border border-slate-800 rounded-lg p-2.5 space-y-3">
                  {groupedOrder.map((grp) => {
                    const list = providers.filter((p) => p.batch_group === grp);
                    if (!list.length) return null;
                    return (
                      <div key={grp} className="space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500 px-1.5 font-semibold">
                          {GROUP_TITLE[grp] || grp}
                        </div>
                        {list.map((p) => {
                          const active = p.engine_id === selectedEngineId;
                          const badge = BILLING_BADGE[p.billing_category] || BILLING_BADGE.pay_as_you_go;
                          return (
                            <button
                              key={p.engine_id}
                              type="button"
                              onClick={() => handleSelectProvider(p.engine_id)}
                              className={`w-full text-left px-2.5 py-2 rounded-lg border transition space-y-1 ${
                                active
                                  ? 'bg-cyan-500/15 border-cyan-400/50 text-slate-100'
                                  : 'bg-slate-950/60 border-slate-800/80 text-slate-300 hover:border-slate-700'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-semibold text-xs truncate">{p.short_name}</span>
                                <div className="flex items-center gap-1 shrink-0">
                                  {p.is_default && (
                                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/25 text-cyan-200 text-[10px] font-semibold">
                                      默认
                                    </span>
                                  )}
                                  <span
                                    className={`w-2 h-2 rounded-full ${
                                      p.configured ? 'bg-emerald-400' : 'bg-slate-600'
                                    }`}
                                    title={p.configured ? '已配置' : '未配置'}
                                  />
                                </div>
                              </div>
                              <div className="flex items-center justify-between gap-1">
                                <span className={`px-1.5 py-0.5 rounded border text-[10px] ${badge.cls}`}>
                                  {badge.label}
                                </span>
                                {p.secret_source === 'env_deepseek' && (
                                  <span className="text-[10px] text-emerald-400">复用 .env</span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>

                {/* 右侧：当前服务商动态配置表单 + 官方链接 + 双测试 */}
                {activeProvider && (
                  <div className="col-span-8 bg-slate-900/70 border border-slate-800 rounded-lg p-4 space-y-3.5">
                    <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-slate-100">{activeProvider.name}</h3>
                          {activeProvider.is_default && (
                            <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-[10px]">
                              当前默认引擎
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400">{activeProvider.notes}</p>
                        <div className="text-[11px] text-amber-300/90">计费说明：{activeProvider.billing_label}</div>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0 items-end">
                        <a
                          href={activeProvider.official_links.api_key_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px]"
                        >
                          <KeyRound className="w-3 h-3" />
                          <span>官方密钥入口</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                        <div className="flex gap-1.5">
                          <a
                            href={activeProvider.official_links.docs_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-cyan-300"
                          >
                            <span>官方文档</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                          <span className="text-slate-600">·</span>
                          <a
                            href={activeProvider.official_links.pricing_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-amber-300"
                          >
                            <span>价格说明</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </div>
                      </div>
                    </div>

                    {/* GCW-UAT-R4-C / R4-C-FINAL: 混元 Hy-MT3-1.8B 本地免费翻译模型状态与运行管理面板 */}
                    {activeProvider.engine_id === 'hunyuan_mt3_local' && (
                      <div className="p-3 rounded-lg bg-slate-950/90 border border-cyan-500/35 space-y-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-cyan-300 flex items-center gap-1.5">
                            <Cpu className="w-3.5 h-3.5" />
                            <span>本地免费翻译模型管理（腾讯混元 Hy-MT3-1.8B · Apache-2.0）</span>
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                              localEnv?.service_online
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : localEnv?.installed_on_demand
                                ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
                                : 'bg-rose-500/15 text-rose-300 border border-rose-500/35'
                            }`}
                          >
                            {localEnv?.service_online
                              ? '● 运行中（GPU 在线）'
                              : localEnv?.installed_on_demand
                              ? '● 已安装（按需自动启动）'
                              : '● 未安装/未启动（不可用）'}
                          </span>
                        </div>
                        {localEnv && (
                          <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono-num text-slate-300 bg-slate-900/70 p-2.5 rounded border border-slate-800">
                            <div>已安装模型版本：{localEnv.deployment?.model_version || '未安装'}</div>
                            <div>模型文件大小：{localEnv.deployment?.model_size_gb ? `${localEnv.deployment.model_size_gb} GB` : '未下载'}</div>
                            <div>实际加载模型名：{localEnv.deployment?.loaded_model_name || '—'}</div>
                            <div>本地服务地址：{localEnv.deployment?.local_endpoint || 'http://127.0.0.1:8081/v1'}</div>
                            <div className="col-span-2 text-emerald-300">
                              运行加速状态：{localEnv.deployment?.compute_mode || '—'} · 显存占用 {localEnv.hardware?.gpu?.vram_used_mb ?? 0} / {localEnv.hardware?.gpu?.vram_total_mb ?? 0} MiB
                            </div>
                            <div className="col-span-2 truncate text-slate-300" title={localEnv.deployment?.model_actual_path}>
                              模型实际存储位置：{localEnv.deployment?.model_actual_path || localEnv.model_info?.recommended_install_dir}
                            </div>
                            <div className="col-span-2 truncate text-slate-400" title={localEnv.deployment?.runtime_dir}>
                              推理环境位置：{localEnv.deployment?.runtime_framework} · {localEnv.deployment?.runtime_dir} {localEnv.deployment?.runtime_version ? `(${localEnv.deployment.runtime_version})` : ''}
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button type="button" onClick={inspectLocalEnv} disabled={localBusy} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300">
                            重新检测环境
                          </button>
                          <button type="button" onClick={() => handleLocalService('start')} disabled={localBusy} className="px-2 py-1 rounded bg-emerald-600/25 hover:bg-emerald-600/40 border border-emerald-500/40 text-emerald-300">
                            启动本地服务
                          </button>
                          <button type="button" onClick={() => handleLocalService('stop')} disabled={localBusy} className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/35 border border-amber-500/40 text-amber-200">
                            停止服务释放显存
                          </button>
                          <button type="button" onClick={() => handleLocalService('health')} disabled={localBusy} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200">
                            健康检查
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const r = await api.translationLocalWizardOpenModelDir();
                                setLocalWizardMsg(r.message || '已打开模型目录');
                              } catch (e: any) {
                                setLocalWizardMsg(`❌ ${e.message}`);
                              }
                            }}
                            className="px-2 py-1 rounded bg-cyan-600/20 hover:bg-cyan-600/35 border border-cyan-500/40 text-cyan-200"
                          >
                            打开模型目录
                          </button>
                        </div>
                        {!localEnv?.installed_on_demand && (
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800">
                            <label className="flex items-center gap-1.5 text-[10px] text-slate-300 cursor-pointer">
                              <input type="checkbox" checked={localAuthChecked} onChange={(e) => setLocalAuthChecked(e.target.checked)} className="accent-cyan-400" />
                              <span>我已了解约 1.35 GB 下载与显存占用，授权安装/拉取本地模型</span>
                            </label>
                            <button
                              type="button"
                              onClick={handleAuthorizedPull}
                              disabled={localBusy || !localAuthChecked}
                              className="px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-[10px] disabled:opacity-40"
                            >
                              授权拉取模型引导
                            </button>
                          </div>
                        )}
                        {localWizardMsg && <div className="text-[10px] text-amber-300">{localWizardMsg}</div>}
                      </div>
                    )}

                    {/* 动态字段表单 */}
                    <div className="space-y-2.5">
                      {activeProvider.fields.map((f) => {
                        if (f.key === 'api_key') {
                          return (
                            <div key={f.key} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-slate-300 font-medium">{f.label}</label>
                                <span className={activeProvider.config.has_api_key ? 'text-emerald-400 font-mono-num' : 'text-slate-500'}>
                                  {activeProvider.config.has_api_key
                                    ? `已保存 (${activeProvider.config.api_key_masked})`
                                    : '未配置'}
                                </span>
                              </div>
                              <input
                                type="password"
                                value={formApiKey}
                                onChange={(e) => setFormApiKey(e.target.value)}
                                placeholder={
                                  activeProvider.config.has_api_key
                                    ? '留空则保持已保存密钥不变；输入新密钥将覆盖加密存储'
                                    : f.placeholder
                                }
                                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                              />
                            </div>
                          );
                        }
                        if (f.key === 'access_key_id') {
                          return (
                            <div key={f.key} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-slate-300 font-medium">{f.label}</label>
                                <span className={activeProvider.config.has_access_key_id ? 'text-emerald-400 font-mono-num' : 'text-slate-500'}>
                                  {activeProvider.config.has_access_key_id
                                    ? `已保存 (${activeProvider.config.access_key_id_masked})`
                                    : '未配置'}
                                </span>
                              </div>
                              <input
                                type="password"
                                value={formAccessKeyId}
                                onChange={(e) => setFormAccessKeyId(e.target.value)}
                                placeholder={activeProvider.config.has_access_key_id ? '留空保持不变' : f.placeholder}
                                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                              />
                            </div>
                          );
                        }
                        if (f.key === 'secret_access_key') {
                          return (
                            <div key={f.key} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-slate-300 font-medium">{f.label}</label>
                                <span className={activeProvider.config.has_secret_access_key ? 'text-emerald-400 font-mono-num' : 'text-slate-500'}>
                                  {activeProvider.config.has_secret_access_key
                                    ? `已保存 (${activeProvider.config.secret_access_key_masked})`
                                    : '未配置'}
                                </span>
                              </div>
                              <input
                                type="password"
                                value={formSecretAccessKey}
                                onChange={(e) => setFormSecretAccessKey(e.target.value)}
                                placeholder={activeProvider.config.has_secret_access_key ? '留空保持不变' : f.placeholder}
                                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                              />
                            </div>
                          );
                        }
                        if (f.key === 'base_url') {
                          return (
                            <div key={f.key} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-slate-300 font-medium">{f.label}</label>
                                <button
                                  type="button"
                                  onClick={() => setFormBaseUrl(activeProvider.default_base_url)}
                                  className="text-[10px] text-cyan-400 hover:underline"
                                >
                                  恢复官方默认地址
                                </button>
                              </div>
                              <input
                                value={formBaseUrl}
                                onChange={(e) => setFormBaseUrl(e.target.value)}
                                placeholder={f.placeholder}
                                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono-num"
                              />
                            </div>
                          );
                        }
                        if (f.key === 'model_id') {
                          return (
                            <div key={f.key} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <label className="text-slate-300 font-medium">{f.label}（可下拉选择或手动填写）</label>
                                <button
                                  type="button"
                                  onClick={handleFetchModels}
                                  disabled={fetchingModels}
                                  className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
                                >
                                  <RefreshCw className={`w-3 h-3 ${fetchingModels ? 'animate-spin' : ''}`} />
                                  <span>获取在线模型列表</span>
                                </button>
                              </div>
                              <div className="flex gap-2">
                                <input
                                  value={formModelId}
                                  onChange={(e) => setFormModelId(e.target.value)}
                                  placeholder={f.placeholder}
                                  list={`models-${activeProvider.engine_id}`}
                                  className="flex-1 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono-num"
                                />
                                <datalist id={`models-${activeProvider.engine_id}`}>
                                  {availableModels.map((m) => (
                                    <option key={m} value={m} />
                                  ))}
                                </datalist>
                              </div>
                              {availableModels.length > 0 && (
                                <div className="flex flex-wrap gap-1 pt-0.5">
                                  {availableModels.slice(0, 6).map((m) => (
                                    <button
                                      key={m}
                                      type="button"
                                      onClick={() => setFormModelId(m)}
                                      className={`px-2 py-0.5 rounded text-[10px] font-mono-num border ${
                                        formModelId === m
                                          ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-200'
                                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                                      }`}
                                    >
                                      {m}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        }
                        if (f.key === 'region') {
                          return (
                            <div key={f.key} className="space-y-1">
                              <label className="text-slate-300 font-medium">{f.label}</label>
                              <input
                                value={formRegion}
                                onChange={(e) => setFormRegion(e.target.value)}
                                placeholder={f.placeholder}
                                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono-num"
                              />
                            </div>
                          );
                        }
                        if (f.key === 'local_endpoint') {
                          return (
                            <div key={f.key} className="space-y-1">
                              <label className="text-slate-300 font-medium">{f.label}</label>
                              <input
                                value={formLocalEndpoint}
                                onChange={(e) => setFormLocalEndpoint(e.target.value)}
                                placeholder={f.placeholder}
                                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono-num"
                              />
                            </div>
                          );
                        }
                        if (f.key === 'local_model_path') {
                          return (
                            <div key={f.key} className="space-y-1">
                              <label className="text-slate-300 font-medium">{f.label}</label>
                              <input
                                value={formLocalModelPath}
                                onChange={(e) => setFormLocalModelPath(e.target.value)}
                                placeholder={f.placeholder}
                                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200 font-mono-num"
                              />
                            </div>
                          );
                        }
                        return null;
                      })}
                    </div>

                    {/* 操作按钮区：连接测试(0费用) / 保存 / 设为默认 */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={testingConn}
                        className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-cyan-300 font-medium flex items-center gap-1.5"
                      >
                        {testingConn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        <span>测试连接（零翻译费）</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveProvider(false)}
                        disabled={trSaving}
                        className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-medium"
                      >
                        {trSaving ? '保存中...' : '保存配置'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveProvider(true)}
                        disabled={trSaving}
                        className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white font-semibold"
                      >
                        保存并设为默认引擎
                      </button>
                      {!activeProvider.is_default && activeProvider.configured && (
                        <button
                          type="button"
                          onClick={handleSetDefault}
                          disabled={trSaving}
                          className="px-2.5 py-1.5 rounded bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300"
                        >
                          直接设为默认
                        </button>
                      )}
                    </div>

                    {connResult && (
                      <div
                        className={`p-2.5 rounded-lg border text-[11px] flex items-start gap-2 ${
                          connResult.ok
                            ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-300'
                            : 'bg-rose-500/10 border-rose-500/35 text-rose-300'
                        }`}
                      >
                        {connResult.ok ? (
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        )}
                        <span>{connResult.message}</span>
                      </div>
                    )}

                    {/* 显式小段文本翻译测试（与零费用连接测试明确区分） */}
                    <div className="border-t border-slate-800 pt-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-200 font-semibold flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                          <span>小段文本翻译测试（将消耗极少量翻译额度 / Token，受费用模式拦截）</span>
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={sampleText}
                          onChange={(e) => setSampleText(e.target.value)}
                          className="flex-1 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                        />
                        <button
                          type="button"
                          onClick={handleTestSample}
                          disabled={testingSample}
                          className="px-3 py-1.5 rounded bg-amber-600/80 hover:bg-amber-500 text-white font-medium shrink-0 flex items-center gap-1"
                        >
                          {testingSample && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          <span>试译本句</span>
                        </button>
                      </div>
                      {sampleResult && (
                        <div
                          className={`p-2.5 rounded-lg border text-[11px] space-y-1 ${
                            sampleResult.ok
                              ? 'bg-slate-950 border-cyan-500/40 text-slate-100'
                              : 'bg-amber-500/10 border-amber-500/35 text-amber-200'
                          }`}
                        >
                          {sampleResult.ok ? (
                            <>
                              <div className="text-cyan-300 font-medium">中文译文：{sampleResult.translated_text}</div>
                              <div className="text-[10px] text-slate-400 font-mono-num">
                                模型：{sampleResult.model_id} · 耗时：{sampleResult.elapsed_ms}ms · Token：{sampleResult.total_tokens} · 估算：¥{sampleResult.estimated_cost_cny}
                              </div>
                            </>
                          ) : (
                            <div>{sampleResult.message}</div>
                          )}
                        </div>
                      )}
                    </div>

                    {trMsg && <div className="text-[11px] text-cyan-300">{trMsg}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ==================== 标签页 2：通用与采集设置（完整保留原有配置） ==================== */}
        {tab === 'general' && (
          <>
            <div className="p-5 space-y-4 overflow-y-auto text-xs flex-1">
              <div className="space-y-2.5 bg-slate-900/70 border border-slate-800 rounded-lg p-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-cyan-300 font-semibold">
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>全局 .env 大模型密钥（供 AI 拓词、复盘与默认复用）</span>
                  </div>
                  <span className={env.llm_configured ? 'text-emerald-400' : 'text-slate-500'}>
                    {env.llm_configured ? `已配置 (${env.llm_key_masked})` : '未配置'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={llmBaseUrl}
                    onChange={(e) => setLlmBaseUrl(e.target.value)}
                    placeholder="Base URL"
                    className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                  />
                  <input
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    placeholder="Model 名称"
                    className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                  />
                </div>
                <input
                  type="password"
                  value={llmKey}
                  onChange={(e) => setLlmKey(e.target.value)}
                  placeholder="输入新 API Key（留空则保持原配置不变）"
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                />
              </div>

              <div className="space-y-2.5 bg-slate-900/70 border border-slate-800 rounded-lg p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-cyan-300 font-semibold">Tavily 网页文章直拉（可选，每月 1000 次免费）</span>
                  <span className={env.tavily_configured ? 'text-emerald-400' : 'text-slate-500'}>
                    {env.tavily_configured ? '已配置' : '未配置'}
                  </span>
                </div>
                <input
                  type="password"
                  value={tavilyKey}
                  onChange={(e) => setTavilyKey(e.target.value)}
                  placeholder="输入 Tavily API Key（留空保持不变）"
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                />
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <input
                    type="password"
                    value={pexelsKey}
                    onChange={(e) => setPexelsKey(e.target.value)}
                    placeholder={`Pexels 免费素材 Key (${env.pexels_configured ? '已配置' : '选填'})`}
                    className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                  />
                  <input
                    type="password"
                    value={pixabayKey}
                    onChange={(e) => setPixabayKey(e.target.value)}
                    placeholder={`Pixabay 免费素材 Key (${env.pixabay_configured ? '已配置' : '选填'})`}
                    className="bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div>
                    <div className="text-slate-400 mb-1">读取浏览器登录态（突破 B站/社媒受限）</div>
                    <select
                      value={cookieBrowser}
                      onChange={(e) => setCookieBrowser(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200"
                    >
                      <option value="none">关闭（默认安全模式）</option>
                      <option value="edge">Edge 浏览器 Cookie</option>
                      <option value="chrome">Chrome 浏览器 Cookie</option>
                    </select>
                  </div>
                  <div>
                    <div className="text-slate-400 mb-1">“低粉爆款”粉丝数上限阈值</div>
                    <input
                      type="number"
                      value={lowThreshold}
                      onChange={(e) => setLowThreshold(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono-num"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2 bg-slate-900/70 border border-slate-800 rounded-lg p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-cyan-300 font-semibold">抖音/TikTok 无水印解析服务（Douyin_TikTok_Download_API）</span>
                  <span className="text-[11px] text-slate-400">双击 tools/start_douyin_api.bat 启动</span>
                </div>
                <div className="flex gap-2">
                  <input
                    value={douyinApiBase}
                    onChange={(e) => setDouyinApiBase(e.target.value)}
                    placeholder="例如 http://127.0.0.1:8080（留空则走内置 yt-dlp）"
                    className="flex-1 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={testDouyin}
                    className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700"
                  >
                    检测连通
                  </button>
                </div>
                {douyinStatus && <div className="text-[11px] text-amber-300">{douyinStatus}</div>}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-slate-200 font-semibold">
                    <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                    <span>本地语音识别引擎</span>
                  </div>
                  <div className="text-slate-400">
                    当前显卡：
                    <span className="font-mono-num text-emerald-400 font-semibold ml-1">
                      {boot?.whisper_active_device === 'cuda' ? 'RTX 4060 CUDA 加速' : 'CPU int8'}
                    </span>
                  </div>
                  <select
                    value={asrEngine}
                    onChange={(e) => setAsrEngine(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
                  >
                    <option value="whisper">Faster-Whisper（英文/多语言均衡）</option>
                    <option value="sensevoice">SenseVoice（阿里开源·中文口播极速）</option>
                  </select>
                </div>
                <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-slate-200 font-semibold">
                    <Bookmark className="w-3.5 h-3.5 text-amber-400" />
                    <span>一键收录书签小工具</span>
                  </div>
                  <div className="text-slate-400 text-[11px]">将下方按钮拖到浏览器书签栏，看任何页面一键收录：</div>
                  <a
                    href={bookmarkletHref}
                    onClick={(e) => e.preventDefault()}
                    className="inline-block px-2.5 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 font-medium"
                  >
                    📥 收录到内容工作台
                  </a>
                </div>
              </div>
              {msg && <div className="text-emerald-400 text-xs">{msg}</div>}
            </div>
            <div className="px-5 py-3 border-t border-slate-800 bg-[#0b1120] flex justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={saveGeneral}
                disabled={saving}
                className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold"
              >
                {saving ? '保存中...' : '保存通用设置'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
