'use strict';
// 工作台排版截图：分栏分行 + 点任务后右栏详情。仅人眼复核，不进 git 断言。
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const userData = 'G:/workbuddy/tmp-build/shot-work-userdata';

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
  await page.waitForTimeout(800);

  // 先进入工作台（捕获条在它里面）
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
    await page.waitForTimeout(320);
  }

  // 点收件箱第一条，看右栏详情
  await page.locator('.gtd-item').first().locator('.gtd-title').click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(root, 'build-v2/shot-work-1.png') });
  await page.locator('.center').screenshot({ path: path.join(root, 'build-v2/shot-work-2.png') });
  await page.locator('.context').screenshot({ path: path.join(root, 'build-v2/shot-work-3.png') });

  // 拖一条收件箱任务到「项目·装修」：归类后应离开收件箱、进下一步
  const row = page.locator('.gtd-item').filter({ hasText: '订瓷砖' }).first();
  const proj = page.locator('.side-proj').filter({ hasText: '装修' }).first();
  const dt = await page.evaluateHandle(function () { return new DataTransfer(); });
  await row.dispatchEvent('dragstart', { dataTransfer: dt });
  await proj.dispatchEvent('dragover', { dataTransfer: dt });
  await page.waitForTimeout(200);
  await page.locator('.center').screenshot({ path: path.join(root, 'build-v2/shot-work-4-drop.png') });
  await proj.dispatchEvent('drop', { dataTransfer: dt });
  await page.waitForTimeout(700);
  await page.locator('.center').screenshot({ path: path.join(root, 'build-v2/shot-work-5-after.png') });
  console.log('收件箱剩余：' + (await page.locator('.gtd-item').count()));

  // 右键菜单：设置 / 转发
  await page.locator('.gtd-item').first().click({ button: 'right' });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(root, 'build-v2/shot-work-6-menu.png') });
  await page.locator('.gtd-menu .gm-item', { hasText: '转发' }).first().click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(root, 'build-v2/shot-work-7-fwd.png') });

  // 子项：只有「下一步 / 等待」能拆。加一条子项，验父行与子行的分列是否还对得上
  await page.keyboard.press('Escape');
  await page.locator('.gtd-tab.side-tab').filter({ hasText: '下一步' }).first().click();
  await page.waitForTimeout(400);
  const p0 = page.locator('.gtd-item').first();
  await p0.locator('.gtd-add-kid').click();
  await page.waitForTimeout(200);
  // 输入框在子项容器里（.gtd-kids-wrap 是父行的兄弟节点，不在 .gtd-item 内部）
  const kidIn = page.locator('.gtd-kids-wrap .kid-in').first();
  await kidIn.fill('先量客厅和主卧');
  await kidIn.press('Enter');
  await page.waitForTimeout(700);
  await page.locator('.center').screenshot({ path: path.join(root, 'build-v2/shot-work-8-kid.png') });

  // 到期列：给父任务填个日子，确认这一列不是天生空着
  await page.locator('.gtd-item').first().locator('.gtd-title').click();
  await page.waitForTimeout(300);
  const d = new Date();
  const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  await page.locator('#wc-due').fill(iso);
  await page.locator('.context .wc-save').click();
  await page.waitForTimeout(800);
  await page.locator('.center').screenshot({ path: path.join(root, 'build-v2/shot-work-9-due.png') });

  console.log('shot ok');
  // 收窗偶发卡住（Electron 子进程已退出、句柄没放干净）：限时等待后直接结束，
  // 否则脚本会一直挂着，下一次跑又会撞上同一个 userData
  await Promise.race([app.close(), new Promise(function (r) { setTimeout(r, 3000); })]);
  process.exit(0);
})().catch(function (e) {
  console.error('shot failed', e && e.message);
  process.exit(1);
});
