/**
 * GCW-UAT-R4-A (FIX-A02 / FIX-A03) · 受控 Preload（仅挂载至本地工作台 workbenchView，外部网页绝不挂载此文件）
 * 所有浏览器控制指令均显式指定目标实例 viewId ('research' | 'topicPlayer')，彻底消除全局单实例互相覆盖问题。
 */
const { contextBridge, ipcRenderer } = require('electron');

function createViewController(viewId) {
  return {
    viewId,
    navigate: (url) => ipcRenderer.invoke('gcw-browser:navigate', viewId, url),
    setBounds: (rect) => ipcRenderer.invoke('gcw-browser:set-bounds', viewId, rect),
    setVisible: (visible) => ipcRenderer.invoke('gcw-browser:set-visible', viewId, visible),
    pauseMedia: () => ipcRenderer.invoke('gcw-browser:pause-media', viewId),
    back: () => ipcRenderer.invoke('gcw-browser:back', viewId),
    forward: () => ipcRenderer.invoke('gcw-browser:forward', viewId),
    reload: () => ipcRenderer.invoke('gcw-browser:reload', viewId),
    getState: () => ipcRenderer.invoke('gcw-browser:get-state', viewId),
    extractVideoMeta: () => ipcRenderer.invoke('gcw-browser:extract-video-meta', viewId),
    getVideoPlayback: () => ipcRenderer.invoke('gcw-browser:get-video-playback', viewId),
    seekVideo: (seconds) => ipcRenderer.invoke('gcw-browser:seek-video', viewId, seconds),
    onState: (cb) => {
      const handler = (_ev, state) => {
        if (state && state.viewId === viewId) cb(state);
      };
      ipcRenderer.on('gcw-browser:state', handler);
      return () => ipcRenderer.removeListener('gcw-browser:state', handler);
    },
  };
}

contextBridge.exposeInMainWorld('gcwDesktopBrowser', {
  isElectron: true,
  forView: (viewId) => createViewController(viewId),
  hideAll: () => ipcRenderer.invoke('gcw-browser:hide-all'),
});
