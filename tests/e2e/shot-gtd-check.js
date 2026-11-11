'use strict';
// 诊断脚本（不是门禁）：GTD 捕获后视图是否被切走（gui-assert #74 在旧 dist 上通过、新 dist 上失败的定位用）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = path.join(root, 'build-v2');
const userData = path.join(os.tmpdir(), 'jiuge-shot-gtd-' + Date.now());

delete process.env.ELECTRON_RUN_AS_NODE;

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(800);

    const cell = page.locator('.cell[data-cell="work"]');
    await cell.dblclick({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(900);

    const s1 = await page.evaluate(() => ({
      gtdTabs: document.querySelectorAll('.gtd-tab').length,
      capInput: document.querySelectorAll('.cap-input').length,
      workView: document.querySelectorAll('.work-view, .gtd').length,
      crumb: (document.querySelector('.view-crumb') || {}).textContent || ''
    }));
    console.log('AFTER_OPEN=' + JSON.stringify(s1));

    if (s1.capInput) {
      // 先切到「日程」tab 再捕获：gui-assert #73 结束时正停在这个 tab
      await page.locator('.gtd-tab').nth(1).click();
      await page.waitForTimeout(300);
      const sMid = await page.evaluate(() => ({
        gtdTabs: document.querySelectorAll('.gtd-tab').length,
        onTab: (document.querySelector('.gtd-tab-on') || {}).textContent || ''
      }));
      console.log('ON_TAB2=' + JSON.stringify(sMid));

      await page.locator('.cap-input').fill('写验收报告');
      await page.locator('.cap-proj').fill('二期验收');
      await page.locator('.cap-btn').click();
      await page.waitForTimeout(700);
      const s2 = await page.evaluate(() => ({
        gtdTabs: document.querySelectorAll('.gtd-tab').length,
        capInput: document.querySelectorAll('.cap-input').length,
        toast: (document.querySelector('.toast') || {}).textContent || '',
        crumb: (document.querySelector('.view-crumb') || {}).textContent || '',
        bodyCls: document.body.className,
        mainChildren: Array.prototype.map.call(
          document.querySelectorAll('.center > *'), (k) => k.className).slice(0, 8)
      }));
      console.log('AFTER_CAPTURE=' + JSON.stringify(s2));
      await page.screenshot({ path: path.join(outDir, 'shot-gtd-after-capture.png') });
    }
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
