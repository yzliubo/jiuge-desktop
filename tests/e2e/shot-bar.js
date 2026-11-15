'use strict';
// 底栏复核截图：底栏高度、右侧声明、右栏底部是否还留着版权卡。仅人眼复核。
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const userData = '<工作区>/shot-bar-userdata';

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

  // 1) 今天（默认页）：整页 + 底栏特写 + 右栏底部
  await page.screenshot({ path: path.join(root, 'build-v2/shot-bar-1-page.png') });
  await page.locator('.statusbar').screenshot({ path: path.join(root, 'build-v2/shot-bar-2-bar.png') });

  const geo = await page.evaluate(function () {
    const el = document.querySelector('.statusbar');
    const r = el.getBoundingClientRect();
    return {
      h: Math.round(r.height * 10) / 10,
      bottom: Math.round(r.bottom),
      vh: window.innerHeight,
      sw: el.scrollWidth,
      cw: el.clientWidth,
      text: el.innerText.replace(/\n/g, ' | ')
    };
  });
  console.log('statusbar', JSON.stringify(geo));

  // 2) 工作台右栏：确认底部不再有版权卡
  await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
  await page.waitForTimeout(700);
  const aside = page.locator('.context');
  const box = await aside.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(root, 'build-v2/shot-bar-3-workctx.png'),
      clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y + box.height - 220), width: Math.min(box.width + 8, 900), height: Math.min(240, box.height) }
    });
  }
  const footCount = await page.locator('.ctx-foot, .ctx-foot-card').count();
  const ctxText = (await aside.textContent()).trim();
  console.log('ctx-foot count', footCount);
  console.log('右栏末尾 40 字:', JSON.stringify(ctxText.slice(-40)));

  // 3) 设置页右栏，同样确认（原来这一页也印一遍）
  await page.locator('.nav-item', { hasText: '设置' }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(root, 'build-v2/shot-bar-4-settings.png') });
  console.log('设置页 ctx-foot count', await page.locator('.ctx-foot, .ctx-foot-card').count());

  console.log('shot ok');
  // app.close() 偶发挂住（Electron 退出慢），给个上限，别让整个脚本被 SIGTERM
  await Promise.race([app.close(), new Promise(function (r) { setTimeout(r, 8000); })]);
  process.exit(0);
})().catch(function (e) {
  console.error('shot failed', e && e.message);
  process.exitCode = 1;
});
