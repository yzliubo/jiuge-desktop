'use strict';
// 临时探针：确认「主窗写领域层 → 图书馆窗口自动重取」这条链是否真的通
const path = require('path');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  const ud = path.join(os.tmpdir(), 'jiuge-probe-refresh-' + Date.now());
  let app = null;
  try {
    app = await electron.launch({ executablePath: electronExe, args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud }), timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    const [lib] = await Promise.all([app.waitForEvent('window'), page.locator('.reading-btn').click()]);
    await lib.waitForSelector('.lib-app', { timeout: 20000 });
    await lib.waitForTimeout(800);
    console.log('初试行数 =', await lib.locator('.rd-trow').count());

    await page.evaluate(async () => {
      await window.jiugeBridge.invoke('v1/domain:call', {
        name: 'reading.addBook', args: [{ title: '广播探针甲', total: 200, unit: '页' }]
      });
    });
    for (const ms of [300, 800, 2000]) {
      await lib.waitForTimeout(ms);
      const n = await lib.locator('.rd-trow').count();
      const has = (await lib.locator('.rd-table').innerText()).indexOf('广播探针甲') >= 0;
      console.log('等待 ' + ms + 'ms 后行数 =', n, '；书架里有这本书 =', has);
    }
    // 手动验证：在图书馆窗口自己写一次，看会不会重取
    await lib.evaluate(async () => {
      await window.jiugeBridge.invoke('v1/domain:call', {
        name: 'reading.addBook', args: [{ title: '广播探针乙', total: 200, unit: '页' }]
      });
    });
    await lib.waitForTimeout(1200);
    console.log('图书馆自己写之后行数 =', await lib.locator('.rd-trow').count(),
      '；含乙 =', (await lib.locator('.rd-table').innerText()).indexOf('广播探针乙') >= 0);
  } catch (e) {
    console.log('FAILED', e && e.message);
    process.exitCode = 1;
  } finally { if (app) await app.close().catch(() => {}); }
})();
