import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/wodhc/.gemini/antigravity/scratch/content-workbench/engines/overlay-studio/motion-playground/node_modules/puppeteer');

const BASE_URL = 'http://127.0.0.1:5199/';
const OUT_DIR = path.resolve('reports/screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1440, height: 920 },
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#mainCanvas');

  // 1. 截屏 1：默认麦田浅色极简单画布（t=1.6s 处于展示中段）
  await page.evaluate(() => window.__labTest.setState({ skeletonId: 'stat_counter', skinId: 'maitian_minimal', t: 1.6 }));
  await page.screenshot({ path: path.join(OUT_DIR, '01_single_maitian_minimal.png') });

  // 2. 截屏 2：白模 vs 成品同帧对比视图
  await page.click('#modeCompare');
  await page.evaluate(() => window.__labTest.setState({ skeletonId: 'bar_race_rank', skinId: 'editorial_ink', t: 1.8 }));
  await page.screenshot({ path: path.join(OUT_DIR, '02_compare_wireframe_vs_skin.png') });

  // 3. 截屏 3：16 组合矩阵动态总览视图
  await page.click('#modeMatrix');
  await page.evaluate(() => window.__labTest.setState({ t: 1.7 }));
  await page.screenshot({ path: path.join(OUT_DIR, '03_matrix_16_combos.png') });
  await page.click('#modeSingle');

  // 4. 全部 16 个组合（4 骨架 × 4 皮肤）真实动态渲染校验
  const skeletons = ['stat_counter', 'bar_race_rank', 'callout_reveal', 'versus_split'];
  const skins = ['wireframe_gray', 'maitian_minimal', 'editorial_ink', 'cyber_glass'];
  const comboResults = [];

  for (const skel of skeletons) {
    for (const skin of skins) {
      const { d1, d2, len1, len2 } = await page.evaluate((sk, sn) => {
        const f1 = window.__labTest.getFrameDataUrl(0.35, sk, sn, true);
        const f2 = window.__labTest.getFrameDataUrl(1.85, sk, sn, true);
        return { d1: f1, d2: f2, len1: f1.length, len2: f2.length };
      }, skel, skin);
      const h1 = sha256(d1);
      const h2 = sha256(d2);
      comboResults.push({
        combo_id: `${skel}__${skin}`,
        skeleton: skel,
        skin,
        hash_t035: h1,
        hash_t185: h2,
        bytes_t035: len1,
        bytes_t185: len2,
        dynamic_changed: h1 !== h2 && len2 > 4000,
      });
    }
  }

  // 5. 确定性校验：相同时间与参数两次渲染（中间经过切皮肤与反向拖动）哈希 100% 一致
  const det1 = await page.evaluate(() => window.__labTest.getFrameDataUrl(1.5, 'stat_counter', 'maitian_minimal', true));
  await page.evaluate(() => window.__labTest.setState({ skeletonId: 'versus_split', skinId: 'cyber_glass', t: 0.4 }));
  const det2 = await page.evaluate(() => window.__labTest.getFrameDataUrl(1.5, 'stat_counter', 'maitian_minimal', true));
  const determinismPass = sha256(det1) === sha256(det2);

  // 6. 时间轴正反向 PointerEvent 拖动 + 播放/暂停
  const box = await page.$eval('#tlTrack', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
  await page.mouse.move(box.x + box.w * 0.2, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.75, box.y, { steps: 8 });
  const timeForward = await page.$eval('#lblTime', (el) => el.textContent.trim());
  await page.mouse.move(box.x + box.w * 0.30, box.y, { steps: 8 });
  const timeBackward = await page.$eval('#lblTime', (el) => el.textContent.trim());
  await page.mouse.up();

  await page.click('#btnPlay');
  await new Promise((r) => setTimeout(r, 450));
  await page.click('#btnPlay');
  const timeAfterPlay = await page.$eval('#lblTime', (el) => el.textContent.trim());

  // 7. 参数实时修改 & 工程保存/恢复
  const beforeEdit = await page.evaluate(() => window.__labTest.getFrameDataUrl(1.5, 'stat_counter', 'maitian_minimal', true));
  await page.evaluate(() => {
    window.__labTest.setState({ skeletonId: 'stat_counter', skinId: 'maitian_minimal', t: 1.5 });
    const inp = document.querySelector('#contentFields input');
    inp.value = '99800';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const afterEdit = await page.evaluate(() => window.__labTest.getFrameDataUrl(1.5, 'stat_counter', 'maitian_minimal', true));
  const paramRealtimePass = sha256(beforeEdit) !== sha256(afterEdit);

  // 工程保存与恢复
  await page.evaluate(() => window.__labTest.setState({ skeletonId: 'versus_split', skinId: 'cyber_glass', t: 2.1 }));
  await page.click('#btnSaveProj');
  await page.evaluate(() => window.__labTest.setState({ skeletonId: 'callout_reveal', skinId: 'wireframe_gray', t: 0.2 }));
  await page.click('#btnRestoreProj');
  const restoredText = await page.$eval('#lblTime', (el) => el.textContent.trim());
  const saveRestorePass = restoredText.startsWith('2.10s');

  // 8. 真实透明视频导出实测（经由页面按钮触发 /api/export-transparent）
  await page.evaluate(() => window.__labTest.setState({ skeletonId: 'stat_counter', skinId: 'maitian_minimal', t: 1.5 }));
  const exportResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/export-transparent') && resp.request().method() === 'POST',
    { timeout: 120000 }
  );
  await page.click('#btnExport');
  const exportResp = await exportResponsePromise;
  const exportJson = await exportResp.json();
  const exportUiStatus = await page.$eval('#exportStatus', (el) => el.textContent.trim());

  const summary = {
    verified_at: new Date().toISOString(),
    url: BASE_URL,
    console_errors: consoleErrors,
    page_errors: pageErrors,
    combos_total: comboResults.length,
    combos_dynamic_passed: comboResults.filter((c) => c.dynamic_changed).length,
    combo_results: comboResults,
    determinism: {
      hash_1: sha256(det1),
      hash_2: sha256(det2),
      pass: determinismPass,
    },
    timeline_scrub: {
      forward: timeForward,
      backward: timeBackward,
      after_play_450ms: timeAfterPlay,
      pass: timeForward !== timeBackward && timeAfterPlay !== timeBackward,
    },
    param_realtime_pass: paramRealtimePass,
    save_restore: {
      restored_time: restoredText,
      pass: saveRestorePass,
    },
    transparent_export: {
      http_status: exportResp.status(),
      ui_status: exportUiStatus,
      payload: exportJson,
      pass: Boolean(exportJson.ok && exportJson.ffprobe_mov?.has_alpha && exportJson.ffprobe_webm?.has_alpha),
    },
    screenshots: [
      'reports/screenshots/01_single_maitian_minimal.png',
      'reports/screenshots/02_compare_wireframe_vs_skin.png',
      'reports/screenshots/03_matrix_16_combos.png',
    ],
  };

  fs.writeFileSync('reports/m2_verification_result.json', JSON.stringify(summary, null, 2), 'utf-8');
  console.log(JSON.stringify({
    console_errors: consoleErrors.length,
    page_errors: pageErrors.length,
    combos_passed: `${summary.combos_dynamic_passed}/${summary.combos_total}`,
    determinism: summary.determinism,
    timeline_scrub: summary.timeline_scrub,
    param_realtime_pass: summary.param_realtime_pass,
    save_restore: summary.save_restore,
    transparent_export_pass: summary.transparent_export.pass,
    mov: exportJson.ffprobe_mov,
    webm: exportJson.ffprobe_webm,
    mov_size_bytes: exportJson.mov_size_bytes,
    webm_size_bytes: exportJson.webm_size_bytes,
  }, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
