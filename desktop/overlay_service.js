/**
 * GCW-VIDEO-STUDIO-V1.0-A · Overlay Studio 独立本地托管服务管理器
 *
 * 职责：
 * - 最大限度保留 engines/overlay-studio 原始源码零改动；
 * - 由 GCW Electron 负责 Overlay Studio（127.0.0.1:5177/overlay-engine/）的启动、健康检查、异常退出监测与关闭；
 * - 防重复启动（startingPromise 单例锁 + 既有健康实例复用）、端口冲突显式报错（严守 strictPort）、关闭 GCW 时整棵进程树零残留清理。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const OVERLAY_HOST = '127.0.0.1';
const OVERLAY_PORT = Number(process.env.GCW_OVERLAY_PORT || 5177);
const OVERLAY_BASE = '/overlay-engine/';
const OVERLAY_URL = `http://${OVERLAY_HOST}:${OVERLAY_PORT}${OVERLAY_BASE}`;
const OVERLAY_CWD = path.resolve(__dirname, '..', 'engines', 'overlay-studio', 'motion-playground');
const VITE_BIN = path.join(OVERLAY_CWD, 'node_modules', 'vite', 'bin', 'vite.js');

let childProc = null;
let managedByUs = false;
let stopping = false;
let startingPromise = null;
let lastError = '';
let stderrTail = '';

function checkHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(OVERLAY_URL, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function getStatus() {
  const running = await checkHealth(1000);
  return {
    ok: running,
    running,
    managedByUs,
    pid: childProc && !childProc.killed ? childProc.pid : null,
    port: OVERLAY_PORT,
    url: OVERLAY_URL,
    cwd: OVERLAY_CWD,
    lastError: running ? '' : lastError,
  };
}

async function startOverlayStudio() {
  if (startingPromise) return startingPromise;
  startingPromise = (async () => {
    lastError = '';
    stderrTail = '';

    // 1. 若 5177 已有健康的 Overlay Studio 实例，直接复用，不重复启动
    if (await checkHealth(1000)) {
      return getStatus();
    }

    if (!fs.existsSync(VITE_BIN)) {
      lastError = `未找到 Overlay Studio Vite 可执行文件：${VITE_BIN}，请先在 motion-playground 执行 npm install`;
      return getStatus();
    }

    // 2. 清理可能残留的旧托管进程句柄
    if (childProc && !childProc.killed) {
      stopOverlayStudio();
    }

    const nodeBin = process.env.GCW_NODE_BIN || 'node';
    const args = [
      VITE_BIN,
      '--host',
      OVERLAY_HOST,
      '--port',
      String(OVERLAY_PORT),
      '--strictPort',
      '--base',
      OVERLAY_BASE,
      '--open',
      'false',
    ];

    const proc = spawn(nodeBin, args, {
      cwd: OVERLAY_CWD,
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    childProc = proc;
    managedByUs = true;

    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1500);
    });
    proc.stdout.on('data', () => {
      // 消费 stdout 避免缓冲区阻塞
    });
    proc.on('error', (err) => {
      lastError = `Overlay Studio 启动进程失败：${err.message}`;
    });
    proc.on('exit', (code, signal) => {
      if (childProc === proc) {
        childProc = null;
        managedByUs = false;
      }
      if (stopping) {
        stopping = false;
        return;
      }
      if (code && code !== 0) {
        const portBusy = /Port \d+ is already in use|EADDRINUSE/i.test(stderrTail);
        lastError = portBusy
          ? `端口 ${OVERLAY_PORT} 已被其他进程占用（strictPort 模式禁止顺延），请释放端口后重试`
          : `Overlay Studio 异常退出（code=${code}, signal=${signal || 'none'}）：${stderrTail.trim().slice(-240)}`;
      }
    });

    // 3. 轮询健康检查（最长 12s）
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (!childProc || childProc.exitCode !== null) break;
      if (await checkHealth(800)) {
        return getStatus();
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!lastError) {
      lastError = `Overlay Studio 启动超时（12s 未响应 ${OVERLAY_URL}）`;
    }
    return getStatus();
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

function stopOverlayStudio() {
  if (!managedByUs || !childProc) return;
  const pid = childProc.pid;
  stopping = true;
  childProc = null;
  managedByUs = false;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // 进程已退出时忽略
  }
}

module.exports = {
  OVERLAY_PORT,
  OVERLAY_URL,
  checkHealth,
  getStatus,
  startOverlayStudio,
  stopOverlayStudio,
};
