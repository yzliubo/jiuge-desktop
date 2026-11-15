'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));
const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = path.join(os.tmpdir(), 'jiuge-dbg2-v313-ud-' + Date.now());
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    app = await electron.launch({
      executablePath: electronExe, args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    const call = function (name, args) {
      return page.evaluate(function (p) {
        return window.jiugeBridge.invoke('v1/domain:call', { name: p.name, args: p.args });
      }, { name: name, args: args || [] });
    };
    const add = await call('reading.addBook', [{ title: '移动平均线策略在中国的实证研究', author: '刘波', total: 200, unit: '页' }]);
    console.log('add ->', JSON.stringify(add).slice(0, 160));
    const bids = await call('reading.board', []);
    const id = bids.data.books[0].id;
    const t0 = Date.now();
    const r = await page.evaluate(function (id) {
      return window.jiugeBridge.invoke('v1/reading:doubanCovers', { args: [id] });
    }, id);
    console.log('doubanCovers in', Date.now() - t0, 'ms ->', JSON.stringify(r).slice(0, 700));
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
