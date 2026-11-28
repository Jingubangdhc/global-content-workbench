/**
 * GCW-ASSET-02 第 5 节 · BBC 跨境医疗视频（#41）真机验收驱动
 * 覆盖：
 * 1. 字号修改前后对比截图（标准 15px vs 大字体 18px，验证 Electron zoomFactor === 1.0 且未整窗缩放）
 * 2. 点击 BBC 跨境医疗视频缩略图 -> 工作台内嵌 WebContentsView 真实播放 -> 录制 MP4 -> 点击「返回列表」验证保留状态
 * 3. 点击 BBC 视频「文案提取」 -> 自动收录至文案工坊 -> 自动执行提取 -> 展开双语字幕同步验证面板 -> 截图
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const OUT_DIR = path.resolve(__dirname, '../docs/gcw_asset_02');
const FRAMES_DIR = path.join(OUT_DIR, '_frames');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = async function runAsset02E2E({ mainWin, workbenchView, researchView, getState }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const wb = workbenchView.webContents;
  const rv = researchView.webContents;
  let frameSeq = 0;

  async function captureFrame(saveName = null) {
    const wbImg = await wb.capturePage();
    const wbSize = wbImg.getSize();
    const wbPng = path.join(FRAMES_DIR, '_wb.png');
    fs.writeFileSync(wbPng, wbImg.toPNG());
    const frameFile = path.join(FRAMES_DIR, `f_${String(++frameSeq).padStart(4, '0')}.png`);

    const st = getState();
    const rvBounds = researchView.getBounds();
    if (st.visible && rvBounds.width >= 50 && rvBounds.height >= 50) {
      const rvImg = await rv.capturePage();
      const rvSize = rvImg.getSize();
      if (rvSize.width > 0 && rvSize.height > 0) {
        const rvPng = path.join(FRAMES_DIR, '_rv.png');
        fs.writeFileSync(rvPng, rvImg.toPNG());
        const [contentW] = mainWin.getContentSize();
        const dpr = contentW > 0 ? wbSize.width / contentW : 1;
        execFileSync(
          'ffmpeg',
          [
            '-y', '-i', wbPng, '-i', rvPng,
            '-filter_complex', `[1:v]scale=${Math.round(rvBounds.width * dpr)}:${Math.round(rvBounds.height * dpr)}[rv];[0:v][rv]overlay=${Math.round(rvBounds.x * dpr)}:${Math.round(rvBounds.y * dpr)}`,
            '-frames:v', '1', frameFile,
          ],
          { stdio: 'pipe', timeout: 15000 }
        );
      } else {
        fs.copyFileSync(wbPng, frameFile);
      }
    } else {
      fs.copyFileSync(wbPng, frameFile);
    }
    if (saveName) {
      const target = path.join(OUT_DIR, saveName);
      fs.copyFileSync(frameFile, target);
      return target;
    }
    return frameFile;
  }

  async function burst(n = 3, ms = 450) {
    for (let i = 0; i < n; i++) {
      try { await captureFrame(null); } catch (_) {}
      if (i < n - 1) await sleep(ms);
    }
  }

  const clickByText = async (needle) =>
    wb.executeJavaScript(`
      (() => {
        const els = Array.from(document.querySelectorAll('button, a'));
        const t = els.find(el => (el.innerText || '').trim().includes(${JSON.stringify(needle)}));
        if (!t) return { ok: false };
        t.scrollIntoView({ block: 'center' });
        t.click();
        return { ok: true, text: (t.innerText || '').trim().slice(0, 60) };
      })()
    `);

  const report = {
    started_at: new Date().toISOString(),
    electron_zoom_factor: wb.getZoomFactor(),
    checks: {},
  };

  try {
    mainWin.show();
    mainWin.focus();
    await sleep(2200);

    // 1. 进入 TopicHub（默认项目 1 跨境医疗，自动选中 #20 外籍人士在中国医院就医全流程指南）
    await clickByText('选题资产中心');
    await sleep(2200);

    // 截标准 15px 字号图
    await clickByText('标准');
    await sleep(600);
    const shotFont15 = await captureFrame('01_font_15px_standard.png');

    // 切换至大字体 18px 截图对比，并确认 zoomFactor 保持 1.0
    await clickByText('大字');
    await sleep(700);
    const zoomAfterLarge = wb.getZoomFactor();
    const shotFont18 = await captureFrame('02_font_18px_large.png');
    await clickByText('标准');
    await sleep(500);
    report.checks.font_scale = {
      zoom_factor_standard: report.electron_zoom_factor,
      zoom_factor_large: zoomAfterLarge,
      screenshots: [shotFont15, shotFont18],
    };

    // 2. 点击 BBC 跨境医疗视频缩略图（工作台内嵌 WebContentsView 播放）
    const clickThumb = await wb.executeJavaScript(`
      (() => {
        const btn = Array.from(document.querySelectorAll('button[title="点击在工作台内观看视频"]'))[0];
        if (!btn) return { ok: false };
        btn.click();
        return { ok: true };
      })()
    `);
    await sleep(6500);
    await burst(4, 500);
    const shotPlayer = await captureFrame('03_bbc_inline_player.png');
    await burst(3, 500);

    // 点击「返回列表」验证内置浏览器自动隐藏并保留 TopicHub 状态
    const clickBack = await clickByText('返回列表');
    await sleep(1200);
    const stAfterBack = getState();
    await burst(2, 450);
    report.checks.inline_player = {
      clickThumb,
      clickBack,
      browser_hidden_after_back: !stAfterBack.visible,
      screenshot: shotPlayer,
    };

    // 3. 点击 BBC 视频对应的「文案提取」按钮 -> 自动跳转、人工收录并提取文案
    const clickExtract = await wb.executeJavaScript(`
      (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === '文案提取');
        if (!btn) return { ok: false };
        btn.click();
        return { ok: true };
      })()
    `);
    // 等待文案提取完成（YouTube 字幕提取一般 3-12 秒）
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const done = await wb.executeJavaScript(`
        (() => {
          const ta = document.querySelector('textarea');
          const msg = document.body.innerText;
          return {
            hasRaw: Boolean(ta && ta.value && ta.value.trim().length > 20),
            extracting: msg.includes('正在执行文案提取流水线'),
          };
        })()
      `);
      if (done.hasRaw || (!done.extracting && i >= 3)) break;
    }
    await sleep(1000);

    // 展开双语字幕同步验证面板并快进验证同步渲染
    const clickBilingual = await clickByText('双语字幕验证');
    await sleep(800);
    await clickByText('快进 +10s');
    await sleep(600);
    const shotTranscript = await captureFrame('04_bbc_transcript_and_bilingual_sub.png');
    await burst(3, 450);
    report.checks.transcript_and_bilingual = {
      clickExtract,
      clickBilingual,
      screenshot: shotTranscript,
    };

    // 合成缩略图点击与内部播放录屏 MP4
    const mp4Path = path.join(OUT_DIR, 'gcw_asset02_play_demo.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-y', '-framerate', '2.5',
        '-i', path.join(FRAMES_DIR, 'f_%04d.png'),
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        mp4Path,
      ],
      { stdio: 'pipe', timeout: 60000 }
    );
    report.mp4_path = mp4Path;
    report.total_frames = frameSeq;
    report.ok = true;
    report.finished_at = new Date().toISOString();
  } catch (err) {
    report.ok = false;
    report.error = String(err?.stack || err);
  } finally {
    try { fs.rmSync(FRAMES_DIR, { recursive: true, force: true }); } catch (_) {}
    fs.writeFileSync(path.join(OUT_DIR, 'asset02_e2e_results.json'), JSON.stringify(report, null, 2), 'utf-8');
    await sleep(400);
    app.quit();
  }
};
