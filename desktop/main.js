/**
 * GCW-UAT-R4-A (FIX-A02 / FIX-A03 / FIX-A05) · Electron + BaseWindow + 双独立业务 WebContentsView 架构
 *
 * 安全隔离与会话架构：
 * 1. workbenchView (http://localhost:5173/)：contextIsolation=true, nodeIntegration=false, sandbox=true，仅挂载受控 preload.js；
 * 2. 双独立业务浏览器视图（按模块固定实例，绝不为每个视频无限创建实例）：
 *    - research     (SearchHub 专属研究视图)
 *    - topicPlayer  (TopicHub 专属视频播放视图)
 *    两者独立维护 URL、历史、滚动位置、视频播放进度、加载与错误状态，离开模块仅暂停视频并隐藏、绝不销毁或互相覆盖；
 * 3. 共享持久化登录会话 (FIX-A03)：
 *    两者共用同一经过验证的 partition='persist:gcw_research'，在 SearchHub 登录抖音后，TopicHub 自动复用合法登录态；
 *    外部网页严格保持 sandbox=true, contextIsolation=true, nodeIntegration=false, webSecurity=true，零 preload、零 Chrome 凭据读取。
 */
const fs = require('fs');
const path = require('path');
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');
const { buildReadonlyVideoMetaScript } = require('./video_meta_extractor');

process.on('uncaughtException', (err) => {
  try {
    const logDir = path.resolve(__dirname, '../logs/launcher');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'electron_error.log'),
      `[${new Date().toISOString()}] ${err?.stack || err}\n`,
      'utf-8'
    );
  } catch (_) {}
});

const WORKBENCH_URL = process.env.GCW_WORKBENCH_URL || 'http://localhost:5173/';
const ALLOWED_WORKBENCH_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const APP_ICON_PATH = path.join(__dirname, 'assets', 'gcw-icon.ico');
const SHARED_PARTITION = 'persist:gcw_research';
const VALID_VIEW_IDS = new Set(['research', 'topicPlayer']);
// FIX-A09: 统一外部协议安全白名单（放行正常网页、MSE视频流与二维码，默认阻止 bytedance://、snssdk:// 等未授权外部应用协议）
const ALLOWED_NAV_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'blob:', 'data:', 'javascript:']);
const blockedProtocolEvents = [];

function getUrlProtocol(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).protocol.toLowerCase();
  } catch (_) {
    const m = String(rawUrl || '').trim().match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    return m ? `${m[1].toLowerCase()}:` : '';
  }
}

function isAllowedWebProtocol(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return true;
  const proto = getUrlProtocol(s);
  if (!proto) return true;
  return ALLOWED_NAV_PROTOCOLS.has(proto);
}

function logBlockedExternalProtocol(viewId, trigger, rawUrl) {
  const proto = getUrlProtocol(rawUrl) || 'unknown:';
  const safeUrl = String(rawUrl || '').slice(0, 240);
  const record = {
    ts: new Date().toISOString(),
    viewId,
    trigger,
    protocol: proto,
    url: safeUrl,
  };
  blockedProtocolEvents.push(record);
  if (blockedProtocolEvents.length > 50) blockedProtocolEvents.shift();
  try {
    const logDir = path.resolve(__dirname, '../logs/launcher');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'blocked_protocols.log'),
      `[${record.ts}] [${viewId}] [${trigger}] blocked ${proto} -> ${safeUrl}\n`,
      'utf-8'
    );
  } catch (_) {}
}

/**
 * FIX-A09: 为任意 WebContents 挂载统一的外部协议拦截（Electron 35）：
 * 覆盖 setWindowOpenHandler / will-navigate / will-frame-navigate / will-redirect，
 * 默认静默阻止 bytedance://、snssdk://、aweme:// 等未授权外部协议，彻底消除 Windows 系统弹窗。
 */
function attachExternalProtocolGuard(wc, viewId, allowInViewWindowOpen = true) {
  wc.setWindowOpenHandler(({ url }) => {
    if (!isAllowedWebProtocol(url)) {
      logBlockedExternalProtocol(viewId, 'setWindowOpenHandler', url);
      return { action: 'deny' };
    }
    if (allowInViewWindowOpen && url && (url.startsWith('http://') || url.startsWith('https://'))) {
      wc.loadURL(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (!isAllowedWebProtocol(url)) {
      event.preventDefault();
      logBlockedExternalProtocol(viewId, 'will-navigate', url);
    }
  });

  wc.on('will-frame-navigate', (details) => {
    if (details && !isAllowedWebProtocol(details.url)) {
      details.preventDefault();
      logBlockedExternalProtocol(viewId, 'will-frame-navigate', details.url);
    }
  });

  wc.on('will-redirect', (event, url) => {
    if (!isAllowedWebProtocol(url)) {
      event.preventDefault();
      logBlockedExternalProtocol(viewId, 'will-redirect', url);
    }
  });
}

const gotSingleInstanceLock = process.env.GCW_VERIFY_SCRIPT ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWin = null;
let workbenchView = null;

/**
 * 双独立业务浏览器实例注册表：
 * views[viewId] = { view: WebContentsView, bounds, visible, state }
 */
const views = {
  research: null,
  topicPlayer: null,
};

function isWorkbenchSender(event) {
  try {
    const senderUrl = event.senderFrame?.url || event.sender?.getURL() || '';
    const origin = new URL(senderUrl).origin;
    return ALLOWED_WORKBENCH_ORIGINS.has(origin);
  } catch (_) {
    return false;
  }
}

function getManagedView(viewId) {
  if (!VALID_VIEW_IDS.has(viewId)) return null;
  const entry = views[viewId];
  if (!entry || !entry.view || entry.view.webContents.isDestroyed()) return null;
  return entry;
}

function pushViewState(viewId) {
  const entry = views[viewId];
  if (!entry || !workbenchView || workbenchView.webContents.isDestroyed()) return;
  workbenchView.webContents.send('gcw-browser:state', {
    viewId,
    ...entry.state,
    visible: entry.visible,
  });
}

function syncViewBounds(viewId) {
  const entry = getManagedView(viewId);
  if (!entry) return;
  const { view, bounds, visible } = entry;
  if (!visible || bounds.width < 20 || bounds.height < 20) {
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  view.setBounds({
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(100, Math.round(bounds.width)),
    height: Math.max(100, Math.round(bounds.height)),
  });
  view.setVisible(true);
}

async function pauseViewMedia(viewId) {
  const entry = getManagedView(viewId);
  if (!entry) return { ok: false, error: 'view_unavailable' };
  const wc = entry.view.webContents;
  const currentUrl = wc.getURL() || '';
  if (!currentUrl || currentUrl === 'about:blank') return { ok: true, pausedCount: 0 };
  try {
    const count = await wc.executeJavaScript(
      `(() => {
        let n = 0;
        for (const el of document.querySelectorAll('video, audio')) {
          try { if (!el.paused) { el.pause(); n++; } } catch (_) {}
        }
        return n;
      })()`,
      true
    );
    return { ok: true, pausedCount: Number(count || 0) };
  } catch (_) {
    return { ok: true, pausedCount: 0 };
  }
}

function createManagedChildView(viewId) {
  const view = new WebContentsView({
    webPreferences: {
      partition: SHARED_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  view.setVisible(false);
  mainWin.contentView.addChildView(view);

  const entry = {
    viewId,
    view,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    visible: false,
    state: {
      url: '',
      title: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      lastError: '',
    },
  };
  views[viewId] = entry;

  const wc = view.webContents;
  // FIX-A09: 统一挂载外部协议安全拦截（覆盖新窗口、主帧导航、子 iframe 导航与重定向，双视图共享防护）
  attachExternalProtocolGuard(wc, viewId, true);

  const refreshNav = () => {
    if (wc.isDestroyed()) return;
    entry.state.url = wc.getURL() || entry.state.url;
    entry.state.title = wc.getTitle() || entry.state.title;
    entry.state.canGoBack = wc.navigationHistory ? wc.navigationHistory.canGoBack() : false;
    entry.state.canGoForward = wc.navigationHistory ? wc.navigationHistory.canGoForward() : false;
    pushViewState(viewId);
  };

  wc.on('did-start-loading', () => {
    entry.state.isLoading = true;
    entry.state.lastError = '';
    pushViewState(viewId);
  });
  wc.on('did-stop-loading', () => {
    entry.state.isLoading = false;
    refreshNav();
  });
  wc.on('did-navigate', (_e, url) => {
    entry.state.url = url;
    refreshNav();
  });
  wc.on('did-navigate-in-page', (_e, url) => {
    entry.state.url = url;
    refreshNav();
  });
  wc.on('page-title-updated', (_e, title) => {
    entry.state.title = title;
    pushViewState(viewId);
  });
  wc.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    entry.state.isLoading = false;
    entry.state.lastError = `加载失败 (${errorCode}): ${errorDesc} [${validatedURL}]`;
    pushViewState(viewId);
  });

  return entry;
}

function createWindow() {
  mainWin = new BaseWindow({
    width: 1520,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    title: 'Global Content Workbench · 双独立内置浏览器桌面版',
    icon: APP_ICON_PATH,
    backgroundColor: '#0B111E',
    show: true,
  });

  // 1. 底层视图：React 工作台
  workbenchView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWin.contentView.addChildView(workbenchView);
  attachExternalProtocolGuard(workbenchView.webContents, 'workbench', false);

  // 2. 双独立业务网页视图（共享持久化会话 persist:gcw_research）
  createManagedChildView('research');
  createManagedChildView('topicPlayer');

  const layoutAll = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const [w, h] = mainWin.getContentSize();
    if (workbenchView && !workbenchView.webContents.isDestroyed()) {
      workbenchView.setBounds({ x: 0, y: 0, width: w, height: h });
    }
    syncViewBounds('research');
    syncViewBounds('topicPlayer');
  };

  mainWin.on('resize', layoutAll);
  mainWin.on('maximize', () => setTimeout(layoutAll, 60));
  mainWin.on('unmaximize', () => setTimeout(layoutAll, 60));
  mainWin.on('closed', () => {
    for (const vid of VALID_VIEW_IDS) {
      const entry = views[vid];
      if (entry?.view && !entry.view.webContents.isDestroyed()) {
        try { entry.view.webContents.close(); } catch (_) {}
      }
      views[vid] = null;
    }
    if (workbenchView && !workbenchView.webContents.isDestroyed()) {
      try { workbenchView.webContents.close(); } catch (_) {}
    }
    workbenchView = null;
    mainWin = null;
  });

  layoutAll();
  workbenchView.webContents.loadURL(WORKBENCH_URL);
  mainWin.show();
  mainWin.focus();

  if (process.env.GCW_VERIFY_SCRIPT) {
    workbenchView.webContents.once('did-finish-load', () => {
      try {
        const runVerify = require(process.env.GCW_VERIFY_SCRIPT);
        runVerify({
          mainWin,
          workbenchView,
          researchView: views.research?.view,
          topicPlayerView: views.topicPlayer?.view,
          getState: (vid = 'research') => {
            const e = views[vid];
            return e ? { viewId: vid, ...e.state, visible: e.visible, bounds: { ...e.bounds } } : null;
          },
          getBlockedProtocols: () => [...blockedProtocolEvents],
        });
      } catch (err) {
        console.error('[GCW_VERIFY_SCRIPT error]', err);
      }
    });
  }
}

// ==================== 显式目标实例 IPC 路由 ====================
ipcMain.handle('gcw-browser:navigate', (event, viewId, url) => {
  if (!isWorkbenchSender(event)) return { ok: false, error: 'forbidden_sender' };
  const entry = getManagedView(viewId);
  if (!entry) return { ok: false, error: 'invalid_view_id' };
  const target = String(url || '').trim();
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    return { ok: false, error: '仅允许打开 http:// 或 https:// 真实网页' };
  }
  entry.state.lastError = '';
  entry.state.url = target;
  entry.visible = true;
  syncViewBounds(viewId);
  entry.view.webContents.loadURL(target).catch((err) => {
    entry.state.lastError = `打开失败：${err?.message || err}`;
    pushViewState(viewId);
  });
  pushViewState(viewId);
  return { ok: true, viewId, url: target };
});

ipcMain.handle('gcw-browser:set-bounds', (event, viewId, rect) => {
  if (!isWorkbenchSender(event)) return { ok: false, error: 'forbidden_sender' };
  const entry = getManagedView(viewId);
  if (!entry) return { ok: false, error: 'invalid_view_id' };
  if (rect && typeof rect.width === 'number' && typeof rect.height === 'number') {
    entry.bounds = {
      x: rect.x || 0,
      y: rect.y || 0,
      width: rect.width,
      height: rect.height,
    };
    syncViewBounds(viewId);
  }
  return { ok: true, viewId };
});

ipcMain.handle('gcw-browser:set-visible', async (event, viewId, visible) => {
  if (!isWorkbenchSender(event)) return { ok: false, error: 'forbidden_sender' };
  const entry = getManagedView(viewId);
  if (!entry) return { ok: false, error: 'invalid_view_id' };
  const nextVisible = Boolean(visible);
  // 隐藏时自动暂停该视图内正在播放的视频，但不销毁实例、不清空 URL 或进度
  if (!nextVisible && entry.visible) {
    await pauseViewMedia(viewId);
  }
  entry.visible = nextVisible;
  // 确保同时只有一个外部网页视图置顶展示，防止双视图遮挡
  if (nextVisible) {
    for (const otherId of VALID_VIEW_IDS) {
      if (otherId !== viewId && views[otherId]?.visible) {
        await pauseViewMedia(otherId);
        views[otherId].visible = false;
        syncViewBounds(otherId);
        pushViewState(otherId);
      }
    }
  }
  syncViewBounds(viewId);
  pushViewState(viewId);
  return { ok: true, viewId, visible: entry.visible };
});

ipcMain.handle('gcw-browser:pause-media', async (event, viewId) => {
  if (!isWorkbenchSender(event)) return { ok: false, error: 'forbidden_sender' };
  return pauseViewMedia(viewId);
});

ipcMain.handle('gcw-browser:hide-all', async (event) => {
  if (!isWorkbenchSender(event)) return { ok: false, error: 'forbidden_sender' };
  for (const vid of VALID_VIEW_IDS) {
    if (views[vid]?.visible) {
      await pauseViewMedia(vid);
      views[vid].visible = false;
      syncViewBounds(vid);
      pushViewState(vid);
    }
  }
  return { ok: true };
});

ipcMain.handle('gcw-browser:back', (event, viewId) => {
  if (!isWorkbenchSender(event)) return { ok: false };
  const entry = getManagedView(viewId);
  const wc = entry?.view.webContents;
  if (wc?.navigationHistory?.canGoBack()) wc.navigationHistory.goBack();
  return { ok: true };
});

ipcMain.handle('gcw-browser:forward', (event, viewId) => {
  if (!isWorkbenchSender(event)) return { ok: false };
  const entry = getManagedView(viewId);
  const wc = entry?.view.webContents;
  if (wc?.navigationHistory?.canGoForward()) wc.navigationHistory.goForward();
  return { ok: true };
});

ipcMain.handle('gcw-browser:reload', (event, viewId) => {
  if (!isWorkbenchSender(event)) return { ok: false };
  const entry = getManagedView(viewId);
  entry?.view.webContents.reload();
  return { ok: true };
});

ipcMain.handle('gcw-browser:get-state', (event, viewId) => {
  if (!isWorkbenchSender(event)) return { ok: false };
  const entry = getManagedView(viewId);
  if (!entry) return { ok: false, error: 'invalid_view_id' };
  return { ok: true, viewId, ...entry.state, visible: entry.visible };
});

/**
 * GCW-STABLE-FIX-02 · 受控只读提取当前真实页面视频公开元数据
 * - 独立分离 raw_page_url 与规范化 url，彻底修复 const 赋值导致的 TypeError
 * - 捕获异常时严格返回 ok: false + extract_status: 'script_error' 与诊断日志，严禁伪装成功回退为 web
 */
async function extractReadonlyVideoMeta(wc) {
  if (!wc || wc.isDestroyed()) {
    return {
      ok: false,
      extract_status: 'script_error',
      error_code: 'VIEW_UNAVAILABLE',
      error_message: '内置浏览器视图不可用或已销毁',
      collected_at: new Date().toISOString(),
    };
  }
  const currentUrl = wc.getURL() || '';
  const pageTitle = wc.getTitle() || '';
  const script = buildReadonlyVideoMetaScript();
  try {
    const snap = await wc.executeJavaScript(script, true);
    if (!snap || typeof snap !== 'object') {
      throw new Error('提取脚本未返回有效元数据对象');
    }
    return { ok: true, ...snap, collected_at: new Date().toISOString() };
  } catch (err) {
    const errMsg = String(err?.message || err);
    console.error('[GCW extractReadonlyVideoMeta ERROR]', {
      url: currentUrl,
      title: pageTitle,
      error: errMsg,
      stack: err?.stack ? String(err.stack).slice(0, 600) : '',
    });
    return {
      ok: false,
      extract_status: 'script_error',
      error_code: 'EXTRACT_SCRIPT_ERROR',
      error_message: errMsg,
      raw_page_url: currentUrl,
      url: currentUrl,
      title: pageTitle,
      collected_at: new Date().toISOString(),
    };
  }
}

ipcMain.handle('gcw-browser:extract-video-meta', async (event, viewId) => {
  if (!isWorkbenchSender(event)) return { ok: false, error: 'forbidden_sender' };
  const entry = getManagedView(viewId);
  if (!entry) return { ok: false, error: 'invalid_view_id' };
  return extractReadonlyVideoMeta(entry.view.webContents);
});

async function readVideoPlaybackState(wc) {
  if (!wc || wc.isDestroyed()) return { ok: false, hasVideo: false, error: 'view_unavailable' };
  const currentUrl = wc.getURL() || '';
  if (!currentUrl || currentUrl === 'about:blank') {
    return {
      ok: true,
      hasVideo: false,
      isAd: false,
      buffering: false,
      url: currentUrl,
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
      readyState: 0,
      playbackRate: 1,
      hostTs: Date.now(),
    };
  }
  const script = `
    (() => {
      // GCW-UAT-R4-G: 检测 YouTube 等平台广告播放态，严禁把贴片广告的 currentTime 当作正片时间驱动双语字幕
      const isAd = Boolean(
        document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-player-overlay-layout')
      );
      if (isAd) {
        return { hasVideo: false, isAd: true, buffering: false, currentTime: 0, duration: 0, paused: false, ended: false, readyState: 0, playbackRate: 1 };
      }
      // 优先选择 YouTube 主播放器视频元素，避免误选隐藏预览或广告占位 <video>
      let best = document.querySelector('video.html5-main-video');
      if (!best) {
        const vids = Array.from(document.querySelectorAll('video'));
        if (!vids.length) {
          return { hasVideo: false, isAd: false, buffering: false, currentTime: 0, duration: 0, paused: true, ended: false, readyState: 0, playbackRate: 1 };
        }
        let bestScore = -1;
        for (const v of vids) {
          const rect = v.getBoundingClientRect ? v.getBoundingClientRect() : { width: 0, height: 0 };
          const area = Math.max(0, rect.width) * Math.max(0, rect.height);
          const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
          const score = (!v.paused && !v.ended && v.readyState >= 2 ? 1e6 : 0) + (dur > 0 ? 1e5 : 0) + Math.min(area, 5e5);
          if (score > bestScore) { bestScore = score; best = v; }
        }
      }
      if (!best) {
        return { hasVideo: false, isAd: false, buffering: false, currentTime: 0, duration: 0, paused: true, ended: false, readyState: 0, playbackRate: 1 };
      }
      const dur = Number.isFinite(best.duration) && best.duration > 0 ? Number(best.duration) : 0;
      const ct = Number.isFinite(best.currentTime) ? Number(best.currentTime) : 0;
      const rs = Number(best.readyState || 0);
      const paused = Boolean(best.paused);
      return {
        hasVideo: dur > 0 && rs >= 1,
        isAd: false,
        buffering: !paused && !best.ended && rs < 3,
        currentTime: ct,
        duration: dur,
        paused,
        ended: Boolean(best.ended),
        readyState: rs,
        playbackRate: Number.isFinite(best.playbackRate) ? Number(best.playbackRate) : 1,
      };
    })()
  `;
  try {
    const state = await wc.executeJavaScript(script, true);
    return { ok: true, url: currentUrl, hostTs: Date.now(), ...state };
  } catch (err) {
    return { ok: false, hasVideo: false, isAd: false, buffering: false, url: currentUrl, error: String(err?.message || err) };
  }
}

ipcMain.handle('gcw-browser:get-video-playback', async (event, viewId) => {
  if (!isWorkbenchSender(event)) return { ok: false, hasVideo: false, error: 'forbidden_sender' };
  const entry = getManagedView(viewId);
  if (!entry) return { ok: false, hasVideo: false, error: 'invalid_view_id' };
  return readVideoPlaybackState(entry.view.webContents);
});

app.on('second-instance', () => {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
});

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BaseWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
