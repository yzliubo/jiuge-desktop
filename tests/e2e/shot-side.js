'use strict';
// 项目/情境维护 + 行内改属性的截图：＋新建 / 双击改名 / 右键菜单 / 归档 / 三格下拉面板。
// 仅人眼复核，不进断言（真断言在 gui-assert.js 的 #75e 段）。
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const userData = '<工作区>/shot-side-userdata';
const shot = function (n) { return path.join(root, 'build-v2/' + n); };

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
  await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
  await page.waitForTimeout(600);

  const rows = [
    ['量房尺寸', '装修', '@电脑'],
    ['订瓷砖', '装修', '@电话'],
    ['给工长打电话', '装修', '@电话'],
    ['交底纪要', '二期验收', '@会议']
  ];
  for (const [t, p, c] of rows) {
    await page.locator('.cap-input').fill(t);
    await page.locator('.cap-proj').fill(p);
    await page.locator('.cap-sel').selectOption(c);
    await page.locator('.cap-btn').click();
    await page.waitForTimeout(280);
  }
  await page.waitForTimeout(400);

  const projSec = page.locator('.gtd-side .side-sec').filter({ hasText: '项目' }).first();
  const ctxSec = page.locator('.gtd-side .side-sec').filter({ hasText: '情境' }).first();

  // 1) 「＋」新建项目
  await projSec.locator('.side-plus').click();
  await page.waitForTimeout(200);
  await projSec.locator('.side-add-in').fill('厨房改造');
  await projSec.locator('.side-add-in').press('Enter');
  await page.waitForTimeout(650);
  await page.locator('.gtd-side').screenshot({ path: shot('shot-side-1-add.png') });

  // 2) 双击改名
  const firstProj = projSec.locator('.side-proj').filter({ hasText: '厨房改造' }).first();
  await firstProj.dblclick();
  await page.waitForTimeout(250);
  await projSec.locator('.side-edit-in').fill('厨房改造（2027）');
  await projSec.locator('.side-edit-in').press('Enter');
  await page.waitForTimeout(650);
  await page.locator('.gtd-side').screenshot({ path: shot('shot-side-2-rename.png') });

  // 3) 右键菜单
  await projSec.locator('.side-proj').filter({ hasText: '厨房改造（2027）' }).first().click({ button: 'right' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('shot-side-3-menu.png') });

  // 4) 归档 → 归档区
  await page.locator('.gtd-side-menu .gm-item').filter({ hasText: '归档' }).first().click();
  await page.waitForTimeout(700);
  await page.locator('.gtd-side').screenshot({ path: shot('shot-side-4-archived.png') });
  await page.locator('.side-arch-toggle').click();
  await page.waitForTimeout(350);
  await page.locator('.gtd-side').screenshot({ path: shot('shot-side-5-arch-list.png') });

  // 5) 行内情境下拉
  const row = page.locator('.gtd-item').first();
  await row.locator('.gtd-cell-ctx').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: shot('shot-side-6-pick-ctx.png') });
  await page.locator('.gtd-pick .gp-item').filter({ hasText: '@会议' }).first().click();
  await page.waitForTimeout(650);

  // 6) 行内到期下拉
  await row.locator('.gtd-cell-due').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: shot('shot-side-7-pick-due.png') });
  await page.locator('.gtd-pick .gp-focus').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot('shot-side-8-focus.png') });

  // 7) 情境条目右键
  await ctxSec.locator('.side-ctx').filter({ hasText: '@会议' }).first().click({ button: 'right' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('shot-side-9-ctxmenu.png') });
  await page.keyboard.press('Escape');

  console.log('shot-side ok');
  await Promise.race([app.close(), new Promise(function (r) { setTimeout(r, 3000); })]);
  process.exit(0);
})().catch(function (e) {
  console.error('shot-side failed', e && e.message);
  process.exit(1);
});
