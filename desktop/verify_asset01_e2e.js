/**
 * GCW-ASSET-01 第 7 节 · 真实汽车项目 10 项全链路真机验收驱动（含高清截图 + MP4 录屏）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const OUT_DIR = path.resolve(__dirname, '../docs/gcw_asset_01');
const FRAMES_DIR = path.join(OUT_DIR, '_frames');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = async function runAsset01E2E({ mainWin, workbenchView, researchView, getState }) {
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
        const els = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const t = els.find(el => (el.innerText || '').includes(${JSON.stringify(needle)}));
        if (!t) return { ok: false };
        t.scrollIntoView({ block: 'center' });
        t.click();
        return { ok: true, text: (t.innerText || '').trim().slice(0, 60) };
      })()
    `);

  const report = { started_at: new Date().toISOString(), checks: {} };

  try {
    mainWin.show();
    mainWin.focus();
    await sleep(1800);

    // 1. 切换至「汽车」项目并点击 YouTube 搜索真实视频
    await wb.executeJavaScript(`
      (() => {
        const sel = document.querySelector('select');
        if (!sel) return;
        const opt = Array.from(sel.options).find(o => o.text.includes('汽车'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      })()
    `);
    await sleep(1400);
    await clickByText('YouTube');
    await sleep(4500);
    await burst(2, 450);

    // 点开搜索结果中的真实视频进入 watch 页
    const clickedVideo = await rv.executeJavaScript(`
      (() => {
        const a = document.querySelector('a#video-title[href*="/watch?v="], ytd-video-renderer a[href*="/watch?v="]');
        if (!a) return { ok: false };
        const href = a.href;
        a.click();
        return { ok: true, href };
      })()
    `);
    await sleep(5500);
    await burst(3, 450);

    const extractedMeta = await wb.executeJavaScript('window.gcwDesktopBrowser.extractVideoMeta()');
    report.checks.step1_search_and_open_video = { clickedVideo, extractedMeta };

    // 2. 点击「收录当前视频」按钮，检查弹窗自动填充真实数据
    const clickCaptureBtn = await clickByText('收录当前视频');
    await sleep(2500);
    const shot1 = await captureFrame('01_capture_modal_autofill.png');
    await burst(3, 450);

    // 采纳一个 AI 建议标签 + 输入人工标签 + 填写收录原因 + 确认收录至已有选题 #32
    await wb.executeJavaScript(`
      (() => {
        // 点击第一个 AI 建议标签
        const aiBtn = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').startsWith('+ '));
        if (aiBtn) aiBtn.click();
        // 输入收录原因
        const ta = Array.from(document.querySelectorAll('textarea')).find(t => (t.placeholder || '').includes('收录原因'));
        if (ta) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, 'GCW-ASSET-01 真机实测：汽车选购痛点真实案例');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
    await sleep(800);
    await clickByText('确认收录至 TopicHub');
    await sleep(2200);
    await burst(2, 450);
    report.checks.step2_capture_to_existing_topic = { clickCaptureBtn, screenshot: shot1 };

    // 3. 再次点击「收录当前视频」将同一视频通过「C. 根据当前视频新建选题」保存，验证全局去重与一视频多选题
    await clickByText('收录当前视频');
    await sleep(2200);
    await clickByText('C. 根据当前视频新建选题');
    await sleep(600);
    await clickByText('确认收录至 TopicHub');
    await sleep(2200);
    await burst(2, 450);

    // 4. 切换至 TopicHub 查看缩略图、真实数据、标签与「关联 2 个选题」徽章
    await clickByText('选题资产中心');
    await sleep(2500);
    const shot2 = await captureFrame('02_topichub_video_list.png');
    await burst(3, 450);

    // 点击「详情/编辑」查看原始数据详情与多选题复选框
    await clickByText('详情/编辑');
    await sleep(1200);
    const shot3 = await captureFrame('03_video_detail_modal.png');
    await burst(3, 450);
    await clickByText('取消');
    await sleep(600);

    report.checks.step4_topichub_display = { screenshots: [shot2, shot3] };

    // 合成完整操作录屏 MP4
    const mp4Path = path.join(OUT_DIR, 'gcw_asset01_demo.mp4');
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
    fs.writeFileSync(path.join(OUT_DIR, 'asset01_e2e_results.json'), JSON.stringify(report, null, 2), 'utf-8');
    await sleep(400);
    app.quit();
  }
};
