/**
 * GCW-UI-01 · 新版深蓝灰 UI 完整 Electron 桌面窗口高清截图驱动
 * 分别截取：
 * 1. SearchHub 新版完整窗口（汽车项目 + 中央 YouTube 真实网页同屏，验证外部网页保持原始样式不注入深色CSS）
 * 2. TopicHub 新版完整窗口（汽车项目 #32 + 含丰富视频证据的默认项目，验证三分区视频列表与缺失显示 —）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const OUT_DIR = path.resolve(__dirname, '../docs/gcw_ui_01');
const TMP_DIR = path.join(OUT_DIR, '_tmp');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = async function runUi01Verify({ mainWin, workbenchView, researchView, getState }) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const wb = workbenchView.webContents;

  async function captureFullWindow(filename) {
    const wbImg = await wb.capturePage();
    const wbSize = wbImg.getSize();
    const wbPng = path.join(TMP_DIR, '_wb.png');
    fs.writeFileSync(wbPng, wbImg.toPNG());
    const outPath = path.join(OUT_DIR, filename);

    const st = getState();
    const rvBounds = researchView.getBounds();
    if (st.visible && rvBounds.width >= 50 && rvBounds.height >= 50) {
      const rvImg = await researchView.webContents.capturePage();
      const rvSize = rvImg.getSize();
      if (rvSize.width > 0 && rvSize.height > 0) {
        const rvPng = path.join(TMP_DIR, '_rv.png');
        fs.writeFileSync(rvPng, rvImg.toPNG());
        const [contentW] = mainWin.getContentSize();
        const dpr = contentW > 0 ? wbSize.width / contentW : 1;
        const ox = Math.round(rvBounds.x * dpr);
        const oy = Math.round(rvBounds.y * dpr);
        const rw = Math.round(rvBounds.width * dpr);
        const rh = Math.round(rvBounds.height * dpr);
        execFileSync(
          'ffmpeg',
          ['-y', '-i', wbPng, '-i', rvPng, '-filter_complex', `[1:v]scale=${rw}:${rh}[rv];[0:v][rv]overlay=${ox}:${oy}`, '-frames:v', '1', outPath],
          { stdio: 'pipe', timeout: 15000 }
        );
        return outPath;
      }
    }
    fs.copyFileSync(wbPng, outPath);
    return outPath;
  }

  const clickByText = async (needle) =>
    wb.executeJavaScript(`
      (() => {
        const els = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const t = els.find(el => (el.innerText || '').includes(${JSON.stringify(needle)}));
        if (!t) return false;
        t.scrollIntoView({ block: 'center' });
        t.click();
        return true;
      })()
    `);

  const selectProjectByText = async (needle) =>
    wb.executeJavaScript(`
      (() => {
        const sel = document.querySelector('select');
        if (!sel) return false;
        const opt = Array.from(sel.options).find(o => o.text.includes(${JSON.stringify(needle)}));
        if (!opt) return false;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);

  try {
    mainWin.show();
    mainWin.focus();
    await sleep(1600);

    // 1. 切换至「汽车」项目 -> SearchHub -> 点击 YouTube 在中央加载真实页面
    await selectProjectByText('汽车');
    await sleep(1500);
    await clickByText('YouTube');
    await sleep(5500);
    await captureFullWindow('ui01_searchhub_new.png');

    // 2. 切换至 TopicHub（汽车项目）-> 确认内置浏览器自动隐藏
    await clickByText('选题资产中心');
    await sleep(2200);
    const stTopic = getState();
    await captureFullWindow('ui01_topichub_car_new.png');

    // 3. 切换至项目 1（含多条带数据参考作品）截取高密度视频列表效果
    await wb.executeJavaScript(`
      (() => {
        const sel = document.querySelector('select');
        if (sel && sel.options.length > 0) {
          sel.value = sel.options[0].value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
    await sleep(2200);
    await captureFullWindow('ui01_topichub_new.png');

    fs.writeFileSync(
      path.join(OUT_DIR, 'ui01_verify_meta.json'),
      JSON.stringify({ ok: true, topic_browser_hidden: !stTopic.visible, captured_at: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } finally {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
    await sleep(400);
    app.quit();
  }
};
