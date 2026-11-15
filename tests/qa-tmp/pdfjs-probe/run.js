'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
const PDF = process.argv[2] || 'C:/Users/yzliu/Downloads/北湖污水处理厂深隧泵站水泵装置安装及调试_杨文中.pdf';
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-pdfjs-'));
  const app = await electron.launch({
    executablePath: path.join(P, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(__dirname, 'main.js')],
    env: Object.assign({}, process.env, {
      JIUGE_V2_USERDATA: ud, JIUGE_V2_PROBE: '1', PROBE_PDF: PDF
    }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.waitForFunction(function () { return window.__result !== undefined; }, null, { timeout: 60000 });
  const r = await page.evaluate(function () { return window.__result; });
  console.log(JSON.stringify(r, null, 1));
  console.log('CSP / console errors =', JSON.stringify(errors.slice(0, 8)));
  await page.screenshot({ path: path.join(__dirname, 'probe.png') });
  await app.close();
  process.exit(r.ok ? 0 : 1);
})().catch(function (e) { console.error('FAIL', e.message); process.exit(1); });
