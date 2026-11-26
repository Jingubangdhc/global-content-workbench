import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/wodhc/.gemini/antigravity/scratch/content-workbench/engines/overlay-studio/motion-playground/node_modules/puppeteer');

const BASE_URL = 'http://127.0.0.1:5199/';
const OUT_DIR = path.resolve('reports/screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

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

  // 1. 先重置 DNA 确保干净基线，并核验 Atlas 504 检索接口
  const atlasSearch = await page.evaluate(async () => {
    await fetch('/api/m4/dna/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset' }) });
    return fetch('/api/m4/atlas/search?q=极简&limit=5').then((r) => r.json());
  });

  // 2. 切到 step_flow_list 并打开 M4 风格混搭变体（4 格 2x2 同步动态画布）
  await page.evaluate(() => window.__labTest.setState({ skeletonId: 'step_flow_list', t: 1.9 }));
  const mixPromise = page.waitForResponse((r) => r.url().includes('/api/m4/mix-variants'));
  await page.click('#modeRemix');
  const mixJson = await (await mixPromise).json();
  await new Promise((r) => setTimeout(r, 300));

  const remixCanvasCount = await page.$$eval('#remixGrid canvas', (els) => els.length);

  // 3. 模拟审美反馈学习：👍 暗黑变体 #2、👎 浅色变体 #3、👍 暗黑变体 #4
  const likeBtns = await page.$$('.btn-remix-like');
  const disBtns = await page.$$('.btn-remix-dislike');
  const fb1 = page.waitForResponse((r) => r.url().includes('/api/m4/dna/feedback'));
  await likeBtns[1].click();
  await fb1;
  const fb2 = page.waitForResponse((r) => r.url().includes('/api/m4/dna/feedback'));
  await disBtns[2].click();
  await fb2;
  const fb3 = page.waitForResponse((r) => r.url().includes('/api/m4/dna/feedback'));
  await likeBtns[3].click();
  const learnedJson = await (await fb3).json();
  await new Promise((r) => setTimeout(r, 250));

  await page.screenshot({ path: path.join(OUT_DIR, '07_m4_remix_and_dna.png') });

  // 4. 刷新页面验证个人 Style DNA 持久化，并点「一键套用我的 DNA」
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 250));
  const dnaSummaryAfterReload = await page.$eval('#dnaSummaryTitle', (el) => el.textContent.trim());
  const dnaCountsAfterReload = await page.$eval('#dnaCounts', (el) => el.textContent.trim());
  await page.click('#btnApplyMyDna');
  const applyStatus = await page.$eval('#exportStatus', (el) => el.textContent.trim());

  const result = {
    verified_at: new Date().toISOString(),
    console_errors: consoleErrors,
    page_errors: pageErrors,
    atlas_504_search: {
      total_catalog: atlasSearch.total_catalog,
      hits: (atlasSearch.items || []).length,
      pass: Boolean(atlasSearch.ok && atlasSearch.total_catalog >= 500 && (atlasSearch.items || []).length > 0),
    },
    remix_4_variants: {
      canvas_count: remixCanvasCount,
      variants_count: (mixJson.variants || []).length,
      pass: remixCanvasCount === 4 && (mixJson.variants || []).length === 4,
    },
    dna_feedback_learning: {
      profile: learnedJson.profile,
      pass: Boolean(learnedJson.profile?.preferred_theme === 'dark' && learnedJson.profile?.likes === 2 && learnedJson.profile?.dislikes === 1),
    },
    dna_persistence_and_apply: {
      summary_after_reload: dnaSummaryAfterReload,
      counts_after_reload: dnaCountsAfterReload,
      apply_status: applyStatus,
      pass: dnaCountsAfterReload === '👍2 / 👎1' && applyStatus.includes('已一键套用'),
    },
  };

  fs.writeFileSync('reports/m4_verification_result.json', JSON.stringify(result, null, 2), 'utf-8');
  console.log(JSON.stringify({
    console_errors: consoleErrors.length,
    page_errors: pageErrors.length,
    atlas_504_pass: result.atlas_504_search.pass,
    remix_4_pass: result.remix_4_variants.pass,
    dna_learning_pass: result.dna_feedback_learning.pass,
    dna_theme: learnedJson.profile?.preferred_theme,
    dna_persistence_pass: result.dna_persistence_and_apply.pass,
    dna_counts: dnaCountsAfterReload,
  }, null, 2));

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
