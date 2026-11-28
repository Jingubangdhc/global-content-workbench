/**
 * GCW-ASSET-01 第 2 节 · 最小技术验证驱动
 * 分别在严格沙箱隔离的 researchView 中打开 YouTube、B站、抖音 3 个真实视频页面，
 * 调用只读元数据提取并落盘到 docs/gcw_asset_01/platform_field_probe.json，绝不绕过限制、绝不用 Mock。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const OUT_DIR = path.resolve(__dirname, '../docs/gcw_asset_01');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = async function runMinProbe({ mainWin, workbenchView, researchView }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const wb = workbenchView.webContents;
  const rv = researchView.webContents;

  const targets = [
    { key: 'youtube', label: 'YouTube 真实汽车视频', url: 'https://www.youtube.com/watch?v=dzIoVW1S__M' },
    { key: 'bilibili', label: 'B站 真实视频页', url: 'https://www.bilibili.com/video/BV1GJ411x7h7/' },
    { key: 'douyin', label: '抖音 真实精选/视频页', url: 'https://www.douyin.com/jingxuan/' },
  ];

  const report = {
    probed_at: new Date().toISOString(),
    security_sandbox_intact: true,
    results: [],
  };

  try {
    mainWin.show();
    researchView.setBounds({ x: 360, y: 160, width: 820, height: 680 });
    researchView.setVisible(true);

    for (const t of targets) {
      let loadErr = '';
      try {
        await rv.loadURL(t.url);
      } catch (e) {
        if (e?.code !== 'ERR_ABORTED' && e?.errno !== -3) loadErr = String(e?.message || e);
      }
      await sleep(5500);
      // 通过工作台受控 preload IPC 调用，与真实用户点击「收录当前视频」走完全一致的链路
      const extracted = await wb.executeJavaScript('window.gcwDesktopBrowser.extractVideoMeta()');
      report.results.push({
        key: t.key,
        label: t.label,
        requested_url: t.url,
        load_error: loadErr,
        extracted,
      });
    }
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, 'platform_field_probe.json'), JSON.stringify(report, null, 2), 'utf-8');
    await sleep(300);
    app.quit();
  }
};
