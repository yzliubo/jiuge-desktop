'use strict';
// 排版截图：整窗 + 拖动右边界后的效果。仅用于人眼复核，不进 git 断言。
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const userData = '<工作区>/shot-layout-userdata';

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
  await page.waitForTimeout(900);

  const sizes = async function () {
    return page.evaluate(function () {
      const n = document.querySelector('.nav');
      const c = document.querySelector('.center');
      const r = document.querySelector('.context');
      return { nav: n ? Math.round(n.getBoundingClientRect().width) : 0, center: c ? Math.round(c.getBoundingClientRect().width) : 0, rail: r ? Math.round(r.getBoundingClientRect().width) : 0 };
    });
  };
  console.log('默认栏宽', JSON.stringify(await sizes()));
  await page.screenshot({ path: path.join(root, 'build-v2/shot-layout-1.png') });

  // 拖右边界：往左拖 120px，右栏应变宽
  const h = await page.locator('.col-divider').nth(1).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + 300);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 120, h.y + 300, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('拖右栏后', JSON.stringify(await sizes()));

  // 拖左边界：往右拖 60px，左栏应变宽
  const h2 = await page.locator('.col-divider').nth(0).boundingBox();
  await page.mouse.move(h2.x + h2.width / 2, h2.y + 300);
  await page.mouse.down();
  await page.mouse.move(h2.x + h2.width / 2 + 60, h2.y + 300, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('拖左栏后', JSON.stringify(await sizes()));
  await page.screenshot({ path: path.join(root, 'build-v2/shot-layout-2.png') });

  // 右栏「本页选项」就在右栏里
  const opt = await page.locator('.today-opt').boundingBox();
  console.log('本页选项卡', opt ? 'y=' + Math.round(opt.y) + ' w=' + Math.round(opt.width) : '缺失');
  await app.close();
})().catch(function (e) {
  console.error('shot failed', e && e.message);
  process.exitCode = 1;
});
