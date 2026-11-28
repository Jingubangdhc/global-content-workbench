/**
 * GCW-UAT-FIX-03-R3 · Electron + WebContentsView 真实桌面窗口最小技术验证驱动（V2 高清原生捕获版）
 *
 * 解决 Windows GPU DirectComposition 窗口下 gdigrab -i title 抓黑屏问题：
 * 直接通过 Electron 原生 workbenchView.webContents.capturePage() 与 researchView.webContents.capturePage()
 * 按 researchView.getBounds() 真实坐标实时合成完整 Electron 桌面窗口帧，生成：
 * - 7 张完整窗口高清 PNG 截图（左工作台 + 中央真实网页 + 右证据收录全屏同框）
 * - 1 段真实连续操作录屏 MP4（gcw_r3_electron_demo.mp4）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const OUT_DIR = path.resolve(__dirname, '../docs/uat_fix_03_r3');
const FRAMES_DIR = path.join(OUT_DIR, '_frames');
const WINDOW_TITLE = 'Global Content Workbench · 内置浏览器研究桌面版';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = async function runVerify({ mainWin, workbenchView, researchView, getState }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const mp4Path = path.join(OUT_DIR, 'gcw_r3_electron_demo.mp4');
  const results = {
    started_at: new Date().toISOString(),
    electron_version: process.versions.electron,
    chromium_version: process.versions.chrome,
    window_title: WINDOW_TITLE,
    security_config: {
      research_view_partition: 'persist:gcw_research',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: null,
      ipc_exposed_to_external: false,
    },
    steps: [],
    mp4_path: mp4Path,
  };

  let frameSeq = 0;

  /**
   * 捕获当前真实完整 Electron 窗口画面（底层工作台 + 嵌入式研究网页原生合成）
   */
  async function captureCompositeFrame(saveAsName = null) {
    const wbImg = await workbenchView.webContents.capturePage();
    const wbSize = wbImg.getSize();
    const wbPngPath = path.join(FRAMES_DIR, '_tmp_wb.png');
    fs.writeFileSync(wbPngPath, wbImg.toPNG());

    const st = getState();
    const rvBounds = researchView.getBounds();
    const frameFile = path.join(FRAMES_DIR, `frame_${String(++frameSeq).padStart(4, '0')}.png`);

    if (st.visible && rvBounds.width >= 50 && rvBounds.height >= 50) {
      const rvImg = await researchView.webContents.capturePage();
      const rvSize = rvImg.getSize();
      if (rvSize.width > 0 && rvSize.height > 0) {
        const rvPngPath = path.join(FRAMES_DIR, '_tmp_rv.png');
        fs.writeFileSync(rvPngPath, rvImg.toPNG());

        // 处理高 DPI 缩放比例，确保研究视图严丝合缝贴合到中央容器坐标
        const [contentW] = mainWin.getContentSize();
        const dpr = contentW > 0 ? wbSize.width / contentW : 1;
        const ox = Math.round(rvBounds.x * dpr);
        const oy = Math.round(rvBounds.y * dpr);
        const rw = Math.round(rvBounds.width * dpr);
        const rh = Math.round(rvBounds.height * dpr);

        execFileSync(
          'ffmpeg',
          [
            '-y',
            '-i', wbPngPath,
            '-i', rvPngPath,
            '-filter_complex', `[1:v]scale=${rw}:${rh}[rv];[0:v][rv]overlay=${ox}:${oy}`,
            '-frames:v', '1',
            frameFile,
          ],
          { stdio: 'pipe', timeout: 15000 }
        );
      } else {
        fs.copyFileSync(wbPngPath, frameFile);
      }
    } else {
      fs.copyFileSync(wbPngPath, frameFile);
    }

    if (saveAsName) {
      const target = path.join(OUT_DIR, saveAsName);
      fs.copyFileSync(frameFile, target);
      return target;
    }
    return frameFile;
  }

  /**
   * 在操作等待期间持续抓取多帧，使 MP4 完整呈现真实加载、滚动、播放与切换过程
   */
  async function recordBurst(count = 4, intervalMs = 450) {
    for (let i = 0; i < count; i++) {
      try {
        await captureCompositeFrame(null);
      } catch (_) {}
      if (i < count - 1) await sleep(intervalMs);
    }
  }

  const wb = workbenchView.webContents;
  const rv = researchView.webContents;

  const clickWorkbenchButtonByText = async (needle) => {
    return wb.executeJavaScript(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const target = btns.find(el => (el.innerText || '').includes(${JSON.stringify(needle)}));
        if (!target) return { ok: false, reason: 'not_found' };
        target.scrollIntoView({ block: 'center' });
        target.click();
        return { ok: true, text: (target.innerText || '').trim().slice(0, 80) };
      })()
    `);
  };

  const clickWorkbenchButtonByTitle = async (titleNeedle) => {
    return wb.executeJavaScript(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button[title]'));
        const target = btns.find(el => (el.getAttribute('title') || '').includes(${JSON.stringify(titleNeedle)}));
        if (!target) return { ok: false, reason: 'not_found' };
        const disabled = Boolean(target.disabled);
        if (!disabled) target.click();
        return { ok: !disabled, disabled, title: target.getAttribute('title') };
      })()
    `);
  };

  const waitResearchIdle = async (timeoutMs = 10000) => {
    const start = Date.now();
    await sleep(1000);
    await recordBurst(2, 500);
    while (Date.now() - start < timeoutMs) {
      const st = getState();
      if (!st.isLoading && st.url) {
        await sleep(1200);
        return getState();
      }
      await sleep(500);
    }
    return getState();
  };

  try {
    mainWin.show();
    mainWin.focus();
    await sleep(1500);

    // Step 0: 切换到「汽车」项目并进入关键词研究
    await wb.executeJavaScript(`
      (() => {
        const sel = document.querySelector('select');
        if (sel) {
          const opt = Array.from(sel.options).find(o => o.text.includes('汽车'));
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      })()
    `);
    await sleep(1200);
    await clickWorkbenchButtonByText('关键词研究');
    await sleep(1200);
    await recordBurst(3, 400);

    // 1. 抖音热点宝
    const clickDouyin = await clickWorkbenchButtonByText('抖音热点宝');
    const stDouyin = await waitResearchIdle(10000);
    await recordBurst(2, 450);
    try { await rv.executeJavaScript('window.scrollBy(0, 280); true;'); } catch (_) {}
    await sleep(700);
    const shot1 = await captureCompositeFrame('01_douyin_hot.png');
    await recordBurst(3, 450);
    results.steps.push({
      step: 'douyin_hot',
      label: '抖音热点宝',
      click: clickDouyin,
      state: stDouyin,
      screenshot: shot1,
    });

    // 2. 百度搜索
    const clickBaidu = await clickWorkbenchButtonByText('百度搜索');
    const stBaidu = await waitResearchIdle(9000);
    const shot2 = await captureCompositeFrame('02_baidu_search.png');
    await recordBurst(3, 450);
    results.steps.push({
      step: 'baidu_search',
      label: '百度搜索',
      click: clickBaidu,
      state: stBaidu,
      screenshot: shot2,
    });

    // 3. Google Search
    const clickGoogle = await clickWorkbenchButtonByText('Google Search');
    const stGoogle = await waitResearchIdle(10000);
    try { await rv.executeJavaScript('window.scrollBy(0, 180); true;'); } catch (_) {}
    await sleep(700);
    const shot3 = await captureCompositeFrame('03_google_search.png');
    await recordBurst(3, 450);
    results.steps.push({
      step: 'google_search',
      label: 'Google Search',
      click: clickGoogle,
      state: stGoogle,
      screenshot: shot3,
    });

    // 4. YouTube（搜索 -> 点开首条视频播放 -> 后退/前进/刷新 -> 一键提取当前页至右侧）
    const clickYoutube = await clickWorkbenchButtonByText('YouTube');
    const stYoutubeSearch = await waitResearchIdle(11000);
    const shot4a = await captureCompositeFrame('04a_youtube_search.png');
    await recordBurst(3, 450);

    let ytVideoClick = { ok: false, reason: 'no_video_link' };
    try {
      ytVideoClick = await rv.executeJavaScript(`
        (() => {
          const link = document.querySelector('a#video-title[href*="/watch?v="], ytd-video-renderer a[href*="/watch?v="]');
          if (!link) return { ok: false, reason: 'video_link_not_found' };
          const href = link.href;
          const title = (link.title || link.innerText || '').trim();
          link.click();
          return { ok: true, href, title };
        })()
      `);
    } catch (e) {
      ytVideoClick = { ok: false, reason: String(e.message || e) };
    }
    const stYoutubeWatch = await waitResearchIdle(10000);
    await recordBurst(5, 500); // 连续录下视频播放进展

    let videoCheck = null;
    try {
      videoCheck = await rv.executeJavaScript(`
        (() => {
          const v = document.querySelector('video');
          if (!v) return { hasVideo: false };
          return {
            hasVideo: true,
            readyState: v.readyState,
            paused: v.paused,
            currentTime: Number(v.currentTime.toFixed(2)),
            duration: Number((v.duration || 0).toFixed(2)),
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
          };
        })()
      `);
    } catch (e) {
      videoCheck = { error: String(e.message || e) };
    }

    // 真实点击工作台顶栏内置浏览器导航按钮：后退 -> 前进 -> 刷新
    const backClick = await clickWorkbenchButtonByTitle('后退');
    await sleep(2000);
    const stAfterBack = getState();
    await recordBurst(2, 450);

    const fwdClick = await clickWorkbenchButtonByTitle('前进');
    await sleep(2400);
    const stAfterForward = getState();
    await recordBurst(2, 450);

    const reloadClick = await clickWorkbenchButtonByTitle('刷新');
    await sleep(2400);
    const stAfterReload = getState();

    // 点击「提取当前页至右侧」自动填充右侧证据表单
    const extractClick = await clickWorkbenchButtonByText('提取当前页至右侧');
    await sleep(900);
    const shot4b = await captureCompositeFrame('04b_youtube_video_and_capture.png');
    await recordBurst(4, 450);

    results.steps.push({
      step: 'youtube_search_and_play',
      label: 'YouTube 搜索、视频播放与导航/收录',
      click: clickYoutube,
      search_state: stYoutubeSearch,
      video_click: ytVideoClick,
      watch_state: stYoutubeWatch,
      video_check: videoCheck,
      nav_test: {
        back: { click: backClick, url_after_back: stAfterBack.url },
        forward: { click: fwdClick, url_after_forward: stAfterForward.url },
        reload: { click: reloadClick, url_after_reload: stAfterReload.url },
      },
      extract_click: extractClick,
      screenshots: [shot4a, shot4b],
    });

    // 5. 最大化研究区
    const maxClick = await clickWorkbenchButtonByText('最大化研究区');
    await sleep(1400);
    const stMaximized = getState();
    const shot5 = await captureCompositeFrame('05_maximized_research.png');
    await recordBurst(4, 450);
    results.steps.push({
      step: 'maximize_research',
      label: '最大化研究区自适应缩放',
      click: maxClick,
      state: stMaximized,
      screenshot: shot5,
    });

    // 还原三栏
    await clickWorkbenchButtonByText('还原三栏');
    await sleep(1000);
    await recordBurst(2, 400);

    // 6. 切换至 TopicHub 验证自动隐藏
    const topicHubClick = await clickWorkbenchButtonByText('选题资产中心');
    await sleep(1500);
    const stTopicHub = getState();
    const shot6 = await captureCompositeFrame('06_topichub_browser_hidden.png');
    await recordBurst(4, 450);
    results.steps.push({
      step: 'switch_to_topichub_hide',
      label: '切换 TopicHub 自动隐藏内置浏览器',
      click: topicHubClick,
      state: stTopicHub,
      screenshot: shot6,
    });

    // 将连续捕获的真实窗口操作帧合成为流畅的 H.264 MP4 录屏
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-framerate', '2.5',
        '-i', path.join(FRAMES_DIR, 'frame_%04d.png'),
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        mp4Path,
      ],
      { stdio: 'pipe', timeout: 60000 }
    );

    results.total_frames = frameSeq;
    results.finished_at = new Date().toISOString();
    results.ok = true;
  } catch (err) {
    results.ok = false;
    results.error = String(err?.stack || err);
  } finally {
    // 清理临时帧目录，保留最终 PNG 与 MP4
    try { fs.rmSync(FRAMES_DIR, { recursive: true, force: true }); } catch (_) {}
    fs.writeFileSync(
      path.join(OUT_DIR, 'r3_verify_results.json'),
      JSON.stringify(results, null, 2),
      'utf-8'
    );
    await sleep(400);
    app.quit();
  }
};
