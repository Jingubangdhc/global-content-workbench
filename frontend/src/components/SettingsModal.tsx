import { useState } from 'react';
import { Bookmark, Cpu, KeyRound, Settings, X } from 'lucide-react';
import { api } from '../api';

interface Props {
  open: boolean;
  onClose: () => void;
  boot: any;
  onSaved: () => void;
}

export default function SettingsModal({ open, onClose, boot, onSaved }: Props) {
  const env = boot?.env || {};
  const settings = boot?.settings || {};

  const [llmBaseUrl, setLlmBaseUrl] = useState(env.llm_base_url || 'https://api.deepseek.com/v1');
  const [llmModel, setLlmModel] = useState(env.llm_model || 'deepseek-chat');
  const [llmKey, setLlmKey] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [cookieBrowser, setCookieBrowser] = useState(settings.cookie_browser || 'none');
  const [lowThreshold, setLowThreshold] = useState(settings.low_follower_threshold || '50000');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  if (!open) return null;

  const bookmarkletHref = `javascript:(function(){window.open('http://127.0.0.1:8000/quick-collect?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'_blank','width=460,height=280');})();`;

  const save = async () => {
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

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4">
      <div className="bg-[#0f172a] border border-slate-700 rounded-xl w-full max-w-xl shadow-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-[#0b1120]">
          <div className="flex items-center gap-2 text-slate-100 font-semibold">
            <Settings className="w-4 h-4 text-cyan-400" />
            <span>工作台设置（密钥仅存本机 .env，不上传）</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto text-xs">
          {/* 1. 按次手动大模型翻译 */}
          <div className="space-y-2.5 bg-slate-900/70 border border-slate-800 rounded-lg p-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-cyan-300 font-semibold">
                <KeyRound className="w-3.5 h-3.5" />
                <span>按次手动翻译接口（兼容 OpenAI 格式）</span>
              </div>
              <span className={env.llm_configured ? 'text-emerald-400' : 'text-slate-500'}>
                {env.llm_configured ? `已配置 (${env.llm_key_masked})` : '未配置（仅影响翻译按钮）'}
              </span>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setLlmBaseUrl('https://api.deepseek.com/v1');
                  setLlmModel('deepseek-chat');
                }}
                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                预设：DeepSeek
              </button>
              <button
                type="button"
                onClick={() => {
                  setLlmBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/');
                  setLlmModel('gemini-2.5-flash');
                }}
                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                预设：Gemini OpenAI兼容
              </button>
              <button
                type="button"
                onClick={() => {
                  setLlmBaseUrl('https://api.openai.com/v1');
                  setLlmModel('gpt-4o-mini');
                }}
                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                预设：OpenAI
              </button>
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

          {/* 2. 网页搜索 Tavily + 采集偏好 */}
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

          {/* 3. 本地语音识别状态与浏览器书签小工具 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3">
              <div className="flex items-center gap-1.5 text-slate-200 font-semibold mb-1">
                <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                <span>本地语音识别引擎</span>
              </div>
              <div className="text-slate-400">
                当前运行设备：
                <span className="font-mono-num text-emerald-400 font-semibold ml-1">
                  {boot?.whisper_active_device === 'cuda' ? 'RTX 4060 CUDA 加速' : 'CPU int8 (实测 4 倍速)'}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                注：若需开启 RTX 4060 CUDA 加速，安装 nvidia-cublas-cu12 后重启即自动切换。
              </div>
            </div>
            <div className="bg-slate-900/70 border border-slate-800 rounded-lg p-3">
              <div className="flex items-center gap-1.5 text-slate-200 font-semibold mb-1">
                <Bookmark className="w-3.5 h-3.5 text-amber-400" />
                <span>浏览器一键收藏书签</span>
              </div>
              <div className="text-[11px] text-slate-400 mb-2">把下方按钮直接拖到浏览器书签栏，逛任何视频点一下秒进收集箱：</div>
              <a
                href={bookmarkletHref}
                onClick={(e) => e.preventDefault()}
                className="inline-block px-3 py-1 rounded bg-amber-500/20 border border-amber-500/50 text-amber-300 font-medium cursor-grab"
              >
                ➕ 收到内容工作台
              </a>
            </div>
          </div>

          {msg && <div className="text-emerald-400 font-medium">{msg}</div>}
        </div>

        <div className="px-5 py-3 bg-[#0b1120] border-t border-slate-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white">
            关闭
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-1.5 text-xs rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium"
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>
    </div>
  );
}
