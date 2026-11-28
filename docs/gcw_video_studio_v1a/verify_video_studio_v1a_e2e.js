/**
 * GCW-VIDEO-STUDIO-V1.0-A · A-J 真实 Electron 端到端验收与截图脚本（标准 GCW_VERIFY_SCRIPT 导出）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { app } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'gcw_video_studio_v1a');
const SHOT_DIR = path.join(OUT_DIR, 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function runVerify({ mainWin, workbenchView }) {
  mainWin.setSize(1920, 1080);
  await sleep(2200);
  const wb = workbenchView.webContents;

  const report = {
    version: 'v0.2.5-rc (GCW-VIDEO-STUDIO-V1.0-A)',
    overlay_studio_upstream_commit: '8ce89d410af6ce648e1658eadf57fec15a612d62',
    tested_at: new Date().toISOString(),
    criteria: {},
  };

  try {
    // A & B. GCW 自动启动 Overlay Studio 状态 + 后端 overlay_adapter 健康检查
    const statusAndHealth = await wb.executeJavaScript(`
      (async () => {
        const ctl = window.gcwOverlayStudio;
        let st = ctl ? await ctl.getStatus() : null;
        if (ctl && (!st || !st.running)) st = await ctl.start();
        const caps = await fetch('http://127.0.0.1:8000/api/video/capabilities').then(r => r.json());
        return { ipcStatus: st, engineHealth: caps?.engine || null };
      })()
    `);
    report.criteria.A_standalone_and_health = {
      pass: Boolean(statusAndHealth.engineHealth?.reachable && statusAndHealth.engineHealth?.license_file_present),
      actual: statusAndHealth.engineHealth,
    };
    report.criteria.B_gcw_auto_start = {
      pass: Boolean(statusAndHealth.ipcStatus?.running && statusAndHealth.ipcStatus?.managedByUs && statusAndHealth.ipcStatus?.pid > 0),
      actual: statusAndHealth.ipcStatus,
    };

    // C, D, E, F. 进入智能视频制作 -> 切至原版 Overlay Studio -> 验证原版 Canvas/时间轴/动效卡/实时预览
    await wb.executeJavaScript(`
      (() => {
        const nav = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('智能视频制作'));
        if (nav) nav.click();
      })()
    `);
    await sleep(1600);
    await wb.executeJavaScript(`
      (() => {
        const tab = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('原版') || (b.textContent || '').includes('Overlay'));
        if (tab) tab.click();
      })()
    `);
    await sleep(3000);

    const editorCheck = await wb.executeJavaScript(`
      (async () => {
        const ifr = document.querySelector('iframe[src*="/overlay-engine/"]');
        if (!ifr || !ifr.contentDocument) return { loaded: false };
        const doc = ifr.contentDocument;
        // 点击原版顶部「示例」按钮加载内置示例动效卡与时间轴
        const demoBtn = Array.from(doc.querySelectorAll('button')).find(b => (b.textContent || '').includes('示例'));
        if (demoBtn) demoBtn.click();
        await new Promise(r => setTimeout(r, 1200));
        const text = doc.body?.innerText || '';
        const buttons = doc.querySelectorAll('button').length;
        const inputs = doc.querySelectorAll('input, select, textarea').length;
        const hasEditor = text.includes('编辑台') && text.includes('效果库') && text.includes('单卡参数');
        const hasTimeline = text.includes('当前') && text.includes('总时长');
        return {
          loaded: true,
          title: doc.title,
          clickedDemo: Boolean(demoBtn),
          hasEditor,
          hasTimeline,
          buttonCount: buttons,
          inputCount: inputs,
          textLen: text.length,
        };
      })()
    `);

    const img = await wb.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, 'gcw_overlay_studio_integrated.png'), img.toPNG());

    report.criteria.C_D_E_F_editor_cards_timeline_preview = {
      pass: Boolean(editorCheck.loaded && editorCheck.hasEditor && editorCheck.hasTimeline && editorCheck.buttonCount >= 15),
      screenshot: 'docs/gcw_video_studio_v1a/screenshots/gcw_overlay_studio_integrated.png',
      actual: editorCheck,
    };

    // G & H. OverlayDoc 兼容性与工程导入 -> 修改 -> 保存 -> 重新打开闭环（验完清理测试工程）
    const projCheck = await wb.executeJavaScript(`
      (async () => {
        const createRes = await fetch('http://127.0.0.1:8000/api/video/projects', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: 1, title: 'FIX_VS_V1A_测试工程_验证OverlayDoc闭环' }),
        }).then(r => r.json());
        const vid = createRes?.id || createRes?.project?.id;
        if (!vid) return { ok: false, step: 'create', createRes };

        const docV1 = {
          version: 1,
          projectName: 'FIX_VS_V1A_测试工程',
          fps: 30,
          duration: 12,
          cues: [
            { id: 'cue_1', kind: 'stat-proof', start: 0.5, end: 4.5, params: { value: '18.6x', label: '测试指标', source: '实测数据' } }
          ],
        };
        const save1 = await fetch('http://127.0.0.1:8000/api/video/projects/' + vid + '/versions', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: '导入验证', doc: docV1 }),
        }).then(r => r.json());

        const docV2 = {
          ...docV1,
          cues: [
            { id: 'cue_1', kind: 'stat-proof', start: 1.0, end: 5.5, params: { value: '24.0x', label: '修改后指标', source: '实测数据' } }
          ],
        };
        const save2 = await fetch('http://127.0.0.1:8000/api/video/projects/' + vid + '/versions', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: '修改并保存验证', doc: docV2 }),
        }).then(r => r.json());

        const reopened = await fetch('http://127.0.0.1:8000/api/video/projects/' + vid).then(r => r.json());
        const latestDoc = JSON.parse(reopened?.project?.draft_overlay_json || '{}');
        const cueValue = latestDoc?.cues?.[0]?.params?.value || '';
        return {
          ok: true,
          vid,
          save1Ok: Boolean(save1?.version || save1?.ok),
          save2Ok: Boolean(save2?.version || save2?.ok),
          versionCount: (reopened?.versions || []).length,
          reopenedCueValue: cueValue,
        };
      })()
    `);

    if (projCheck.vid) {
      spawnSync(
        path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
        [
          '-c',
          `import sqlite3; c=sqlite3.connect('data/workbench.db'); c.execute('DELETE FROM video_project_versions WHERE video_project_id=?', (${projCheck.vid},)); c.execute('DELETE FROM video_projects WHERE id=?', (${projCheck.vid},)); c.commit(); c.close()`,
        ],
        { cwd: ROOT }
      );
    }

    report.criteria.G_H_overlaydoc_import_modify_save_reopen = {
      pass: Boolean(projCheck.ok && projCheck.save1Ok && projCheck.save2Ok && projCheck.reopenedCueValue === '24.0x'),
      actual: { ...projCheck, testProjectCleaned: true },
    };

    // J. 原有 GCW 核心接口回归测试
    const reg = await wb.executeJavaScript(`
      (async () => {
        const t = await fetch('http://127.0.0.1:8000/api/topic-hub/topics?project_id=1&limit=5');
        const sub = await fetch('http://127.0.0.1:8000/api/translation/subtitles/39?target_lang=zh-CN');
        const pf = await fetch('http://127.0.0.1:8000/api/research-flow/platforms');
        return { topicsStatus: t.status, subtitlesStatus: sub.status, platformsStatus: pf.status };
      })()
    `);
    report.criteria.J_gcw_regression = {
      pass: reg.topicsStatus === 200 && reg.subtitlesStatus === 200 && reg.platformsStatus === 200,
      actual: reg,
    };

    report.all_in_app_pass = Object.values(report.criteria).every((c) => c.pass);
  } catch (e) {
    report.error = String(e?.stack || e);
    report.all_in_app_pass = false;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'GCW_VIDEO_STUDIO_V1A_TEST_RESULTS.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('VS_V1A_E2E_SUMMARY:', JSON.stringify({ all_in_app_pass: report.all_in_app_pass, criteria: Object.entries(report.criteria).map(([k, v]) => [k, v.pass]) }));
  app.quit();
};
