'use strict';
// 截图脚本（保留在仓库里，供每轮改版肉眼复核中栏顶部）。
// 用法：cd tests/e2e && TEMP=<工作区> node shot-greeting.js
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const userData = '<工作区>/shot-userdata';
const out = path.join(root, 'build-v2/shot-today.png');
const out2 = path.join(root, 'build-v2/shot-focus.png');

delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(700);
  await page.locator('.cell[data-cell="work"] .rt-body').click();
  await page.keyboard.type('上午把泵房调试记录整理完，下午对接了厂家。');
  await page.locator('.cell[data-cell="health"] .rt-body').click();
  await page.keyboard.type('早睡一次，十点半上床。');
  await page.locator('.save-btn').click();
  await page.waitForTimeout(700);
  // 截中栏（含顶部两块与九格，便于看清相对位置）
  await page.locator('.center').screenshot({ path: out });
  console.log('shot ok', out);
  // 进入「今日六条」格再截一张
  await page.locator('.cell[data-cell="future"] .cell-label').dblclick();
  await page.waitForTimeout(600);
  await page.locator('.center').screenshot({ path: out2 });
  console.log('shot ok', out2);
  await app.close();
})().catch(function (e) {
  console.error('shot failed', e && e.message);
  process.exitCode = 1;
});
