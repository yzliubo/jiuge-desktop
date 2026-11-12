'use strict';
// 一次性取图：启动真实 Electron（干净档案），截中栏九格编辑区，供主理人核验界面改动。
// 用法：node tests/qa-tmp/grid-shot.js <输出 png 绝对路径>
const path = require('path');
const fs = require('fs');
delete process.env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(__dirname, '../..');
// playwright 装在 tests/e2e 子工程里，根 node_modules 没有
const { _electron: electron } = require(path.join(root, 'tests/e2e/node_modules/playwright'));
const userData = path.join(__dirname, '..', 'e2e', '.e2e-userdata-grid-shot');
fs.mkdirSync(userData, { recursive: true });
const out = process.argv[2];
if (!out) throw new Error('缺少输出路径');

(async () => {
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, {
      JIUGE_V2_USERDATA: userData,
      JIUGE_V2_PROBE: '1'
    }),
    timeout: 60000
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.grid .cell', { timeout: 30000 });
    await page.waitForTimeout(1000);
    await page.locator('.editor').screenshot({ path: out });
    const ph = await page.locator('.cell .rt-body').evaluateAll(function (els) {
      return els.map(function (el) { return el.getAttribute('data-placeholder'); });
    });
    console.log(JSON.stringify(ph, null, 2));
    console.log('SHOT=' + out);
  } finally {
    await app.close();
  }
})().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
