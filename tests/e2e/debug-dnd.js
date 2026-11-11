'use strict';
// 临时调试：拖拽 drop 为什么没落库
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const userData = 'G:/workbuddy/tmp-build/debug-dnd-userdata';

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
  page.on('console', function (m) { console.log('[console]', m.type(), m.text()); });
  page.on('pageerror', function (e) { console.log('[pageerror]', e.message); });
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
  await page.waitForTimeout(600);

  await page.locator('.cap-input').fill('拖我一把');
  await page.locator('.cap-proj').fill('测试项目');
  await page.locator('.cap-btn').click();
  await page.waitForTimeout(400);

  const row = page.locator('.gtd-item').filter({ hasText: '拖我一把' }).first();
  const proj = page.locator('.side-proj').filter({ hasText: '测试项目' }).first();
  console.log('row count', await row.count(), 'proj count', await proj.count());

  const dt = await page.evaluateHandle(function () { return new DataTransfer(); });
  await row.dispatchEvent('dragstart', { dataTransfer: dt });
  await page.waitForTimeout(150);
  console.log('dragging rows', await page.locator('.gtd-item.gtd-dragging').count());
  await proj.dispatchEvent('dragenter', { dataTransfer: dt });
  await proj.dispatchEvent('dragover', { dataTransfer: dt });
  await page.waitForTimeout(150);
  console.log('drop-hot', await page.locator('.gtd-drop-hot').count());
  await proj.dispatchEvent('drop', { dataTransfer: dt });
  await page.waitForTimeout(900);
  console.log('msg', await page.locator('.gtd-view .msg').allTextContents());
  console.log('inbox items', await page.locator('.gtd-item').count());

  // 再试真实鼠标拖拽
  const row2 = page.locator('.gtd-item').filter({ hasText: '拖我一把' }).first();
  if (await row2.count()) {
    await row2.dragTo(proj, { timeout: 8000 }).catch(function (e) { console.log('dragTo failed', e.message); });
    await page.waitForTimeout(900);
    console.log('after dragTo msg', await page.locator('.gtd-view .msg').allTextContents());
    console.log('after dragTo items', await page.locator('.gtd-item').count());
  }

  await Promise.race([app.close(), new Promise(function (r) { setTimeout(r, 3000); })]);
  process.exit(0);
})().catch(function (e) {
  console.error('debug failed', e && e.stack || e);
  process.exit(1);
});
