'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));
const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = path.join(os.tmpdir(), 'jiuge-dbg-v313-ud-' + Date.now());
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
    const has = await page.evaluate(function () { return typeof window.jiugeBridge; });
    console.log('jiugeBridge =', has);
    const r1 = await page.evaluate(function () {
      return window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.themeAdd', args: [{ title: '污水处理工艺' }] });
    });
    console.log('themeAdd ->', JSON.stringify(r1));
    const r2 = await page.evaluate(function () {
      return window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.themes', args: [] });
    });
    console.log('themes ->', JSON.stringify(r2).slice(0, 400));
    const tid = r2 && r2.data && r2.data[0] && r2.data[0].themeId;
    const r3 = await page.evaluate(function (tid) {
      return window.jiugeBridge.invoke('v1/domain:call', {
        name: 'reading.addBook',
        args: [{ title: 'MBR 膜污染控制', author: '测试', total: 200, unit: '页', themeId: tid, format: 'EPUB', filePath: 'D:/tmp/x.epub', fileExt: 'epub', fileSize: 4096 }]
      });
    }, tid);
    console.log('addBook ->', JSON.stringify(r3).slice(0, 300));
    const r4 = await page.evaluate(function () {
      return window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
    });
    const b = r4 && r4.data;
    console.log('stats ->', JSON.stringify(b && b.stats));
    console.log('books ->', (b && b.books || []).length, 'leisure ->', (b && b.leisureBooks || []).length, 'groups ->', (b && b.themeGroups || []).length);
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
