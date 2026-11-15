'use strict';
// 临时诊断：列高是否被内容顶破（末行会不会压到页脚印）
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = path.join(os.tmpdir(), 'jiuge-paged-diag-ud-' + Date.now());
const fixture = process.argv[2];

delete process.env.ELECTRON_RUN_AS_NODE;

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, {
        JIUGE_V2_USERDATA: userData,
        JIUGE_V2_PROBE: '1',
        JIUGE_V2_PICK_FILES: fixture
      }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.locator('.reading-btn').click();
    await page.waitForSelector('.rd-view', { timeout: 8000 });
    await page.locator('.rd-tab').nth(0).click();
    await page.waitForSelector('.rd-drop', { timeout: 8000 });
    await page.locator('.rd-file-actions .rd-primary').click();
    await page.waitForSelector('.rd-book', { timeout: 20000 });
    const [rd] = await Promise.all([
      app.waitForEvent('window'),
      page.locator('.rd-book').filter({ hasText: '分页试验书' }).first().dblclick()
    ]);
    await rd.waitForSelector('.rr-app', { timeout: 20000 });
    await rd.waitForTimeout(1200);
    const on = (await rd.locator('#rrPaged').getAttribute('aria-pressed')) === 'true';
    if (!on) { await rd.locator('#rrPaged').click(); await rd.waitForTimeout(900); }
    console.log(JSON.stringify(await rd.evaluate(function () {
      const f = document.getElementById('rrPage');
      const d = f.contentDocument;
      const inner = d.getElementById('rr-pg-in');
      const clip = d.getElementById('rr-pg-clip');
      const vp = d.getElementById('rr-pg-vp');
      const b = function (el) { const r = el.getBoundingClientRect(); return { t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), h: +r.height.toFixed(1) }; };
      const ps = Array.prototype.slice.call(inner.querySelectorAll('p')).slice(0, 6);
      const lineH = parseFloat(getComputedStyle(ps[0]).lineHeight) || 0;
      return {
        lineHeight: lineH,
        vp: b(vp), clip: b(clip), inner: b(inner),
        innerScrollH: inner.scrollHeight,
        ps: ps.map(function (p) { return { txt: p.textContent.slice(0, 3), box: b(p) }; })
      };
    }), null, 1));
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
