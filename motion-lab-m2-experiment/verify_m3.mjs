import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/wodhc/.gemini/antigravity/scratch/content-workbench/engines/overlay-studio/motion-playground/node_modules/puppeteer');

const BASE_URL = 'http://127.0.0.1:5199/';
const REF_IMG = 'C:/Users/wodhc/.gemini/antigravity/brain/f5cd6ba6-6bf2-46f3-a97b-d42a4da5382a/.user_uploaded/media_1795683348785_42ad5ae2.png';
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

  // 1. 真实上传用户《三步出片》参考图并等待 FFmpeg 像素反推完成
  const analyzePromise = page.waitForResponse((r) => r.url().includes('/api/m3/analyze-reference') && r.request().method() === 'POST');
  const fileInput = await page.$('#refFileInput');
  await fileInput.uploadFile(REF_IMG);
  const analyzeResp = await analyzePromise;
  const analyzeJson = await analyzeResp.json();
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => window.__labTest.setState({ t: 1.85 }));
  await page.screenshot({ path: path.join(OUT_DIR, '04_m3_reference_reverse.png') });

  // 2. 安全门禁反测：向 /api/m3/sandbox-gate 提交恶意草案（含 fetch + performance.now），验证必须被拦截
  const evilGate = await page.evaluate(async () => {
    const r = await fetch('/api/m3/sandbox-gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft_card: {
          skeleton_id: 'step_flow_list',
          duration: 3.0,
          skin: { tokens: { stage_bg: '#000', surface_bg: '#111', text_primary: '#fff', accent_primary: '#3b82f6' } },
          evil_code: 'fetch("https://evil.example"); performance.now();',
        },
        render_proof: { hash_t035: 'a', hash_t185: 'b', hash_det1: 'c', hash_det2: 'c', has_transparent_pixels: true },
      }),
    });
    return r.json();
  });

  // 3. 正向流程：AI 共创 → 运行 4 道沙箱门禁 → 入库持久化 → 刷新页面验证持久存在
  await page.type('#aiPrompt', '做一个三步出片风格的暗黑数据蓝步骤清单，3.2秒快节奏');
  const genPromise = page.waitForResponse((r) => r.url().includes('/api/m3/generate-variant'));
  await page.click('#btnAiApply');
  const genJson = await (await genPromise).json();
  await new Promise((r) => setTimeout(r, 200));

  const gatePromise = page.waitForResponse((r) => r.url().includes('/api/m3/sandbox-gate'));
  await page.click('#btnRunGate');
  const gateJson = await (await gatePromise).json();
  await new Promise((r) => setTimeout(r, 200));

  const regPromise = page.waitForResponse((r) => r.url().includes('/api/m3/registry/register'));
  await page.click('#btnRegisterCard');
  const regJson = await (await regPromise).json();
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => window.__labTest.setState({ t: 1.75 }));
  await page.screenshot({ path: path.join(OUT_DIR, '05_m3_sandbox_gate_registered.png') });

  // 4. 刷新页面确认入库卡片持久化保留
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 250));
  const persistedCount = await page.$eval('#lblCustomCount', (el) => Number(el.textContent.trim()));

  const result = {
    verified_at: new Date().toISOString(),
    console_errors: consoleErrors,
    page_errors: pageErrors,
    reference_reverse: {
      http_status: analyzeResp.status(),
      analysis: analyzeJson.analysis,
      pass: Boolean(analyzeJson.ok && analyzeJson.analysis?.theme === 'dark' && analyzeJson.analysis?.recommended_skeleton === 'step_flow_list'),
    },
    evil_security_block: {
      passed_flag: evilGate.passed,
      static_security_gate: (evilGate.gates || []).find((g) => g.id === 'static_security'),
      pass: evilGate.passed === false,
    },
    ai_generate_variant: {
      ok: genJson.ok,
      skeleton_id: genJson.draft_card?.skeleton_id,
      duration: genJson.draft_card?.duration,
      atlas_inspirations: genJson.draft_card?.atlas_inspirations,
      pass: Boolean(genJson.ok && genJson.draft_card?.skeleton_id === 'step_flow_list' && genJson.draft_card?.duration === 3.2),
    },
    sandbox_gate_4_of_4: {
      passed: gateJson.passed,
      gates: gateJson.gates,
      pass: Boolean(gateJson.passed && (gateJson.gates || []).length === 4),
    },
    registry_persistence: {
      register_ok: regJson.ok,
      persisted_count_after_reload: persistedCount,
      pass: Boolean(regJson.ok && persistedCount >= 1),
    },
  };

  fs.writeFileSync('reports/m3_verification_result.json', JSON.stringify(result, null, 2), 'utf-8');
  console.log(JSON.stringify({
    console_errors: consoleErrors.length,
    page_errors: pageErrors.length,
    reference_reverse_pass: result.reference_reverse.pass,
    detected_bg: analyzeJson.analysis?.detected_bg,
    detected_accent: analyzeJson.analysis?.detected_accent,
    evil_security_block_pass: result.evil_security_block.pass,
    ai_generate_pass: result.ai_generate_variant.pass,
    sandbox_gate_4_of_4_pass: result.sandbox_gate_4_of_4.pass,
    registry_persistence_pass: result.registry_persistence.pass,
    persisted_count_after_reload: persistedCount,
  }, null, 2));

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
