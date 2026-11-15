'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));
const root = path.resolve(__dirname, '../..');
const userData = path.join(os.tmpdir(), 'jiuge-measure-' + Date.now());
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    app = await electron.launch({
      executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: [path.join(root, 'src/main/main-v2.js')],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.evaluate(() => window.jiugeBridge.invoke('v1/domain:call', {
      name: 'reading.addBook', args: [{ title: '测量用书名很长很长很长很长', author: '测试作者', total: 100, unit: '页' }]
    }));
    await page.locator('.reading-btn').click();
    await page.locator('.rd-tab').nth(0).click();
    await page.waitForSelector('.rd-trow', { timeout: 8000 });
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const row = document.querySelector('.rd-trow');
      const cs = getComputedStyle(row);
      const widths = {};
      ['.rd-td-title', '.rd-td-author', '.rd-td-size', '.rd-td-date', '.rd-td-pct', '.rd-td-act'].forEach((s) => {
        const el = row.querySelector(s);
        widths[s] = el ? Math.round(el.getBoundingClientRect().width) : null;
      });
      const sizes = {};
      ['.rd-td-author', '.rd-td-size'].forEach((s) => {
        const el = row.querySelector(s);
        sizes[s] = el ? getComputedStyle(el).fontSize : null;
      });
      return {
        display: cs.display,
        cols: cs.gridTemplateColumns,
        rowWidth: Math.round(row.getBoundingClientRect().width),
        tableWidth: Math.round(document.querySelector('.rd-table').getBoundingClientRect().width),
        widths, sizes,
        text: { author: (row.querySelector('.rd-td-author') || {}).textContent, size: (row.querySelector('.rd-td-size') || {}).textContent }
      };
    });
    console.log(JSON.stringify(info, null, 1));
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
