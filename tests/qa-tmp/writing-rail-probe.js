'use strict';
// 一次性探针：写作法体检卡从「中栏」搬到「右栏」后的真机核对（不进正式门禁）。
// 验证：① tab1/tab2 右栏无写作法卡 ② tab3 右栏有且中栏只留一处 .fw-stats=0
//       ③ 正文变化时右栏数字跟着动 ④ 右栏按钮能切「体检态」⑤ 离开模块后卡收回
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
delete process.env.ELECTRON_RUN_AS_NODE;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-wc-'));
const shot = function (n) { return path.join(root, 'tests/e2e/.wc-' + n + '.png'); };

(async function () {
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  page.on('pageerror', function (e) { console.log('PAGEERROR', e && e.message); });
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(700);

  await page.locator('.nav-item').nth(3).click();
  await page.waitForTimeout(500);
  console.log('[1] free-view =', await page.locator('.free-view').count(),
    '| tab1 右栏写作法卡 =', await page.locator('.context .fw-stats').count());

  await page.locator('.free-view .fw-tab').nth(2).click();
  await page.waitForTimeout(450);
  console.log('[2] tab3 右栏 .fw-stats =', await page.locator('.context .fw-stats').count(),
    '| 中栏 .free-view .fw-stats =', await page.locator('.free-view .fw-stats').count());

  await page.locator('.fw-doclist .fw-primary').click();
  await page.waitForTimeout(450);
  const text = '他非常慢慢地被进行了一番说明，其实没有予以解释。' + '字'.repeat(70) + '。';
  await page.locator('.fw-paper').fill(text);
  await page.waitForTimeout(900);
  console.log('[3] 写作态右栏摘要 =', (await page.locator('.context').innerText()).replace(/\s+/g, ' ').slice(0, 220));
  await page.screenshot({ path: shot('write-mode') });

  await page.locator('.context .wc-btn').click();
  await page.waitForTimeout(800);
  console.log('[4] 右栏按钮切体检后：paper =', await page.locator('.fw-paper').count(),
    '| review =', await page.locator('.fw-review').count(),
    '| 红句 =', await page.locator('.fw-review .fw-hard').count(),
    '| 蓝词 =', await page.locator('.fw-review mark').count());
  await page.screenshot({ path: shot('check-mode') });

  await page.locator('.context .wc-btn').click();
  await page.waitForTimeout(500);
  console.log('[5] 切回写作态：paper =', await page.locator('.fw-paper').count(),
    '| 正文一致 =', (await page.locator('.fw-paper').inputValue()) === text);

  await page.locator('.free-view .fw-tab').nth(0).click();
  await page.waitForTimeout(400);
  console.log('[6] 回 tab1 后右栏写作法卡 =', await page.locator('.context .fw-stats').count());

  await page.locator('.nav-item').nth(0).click();
  await page.waitForTimeout(400);
  console.log('[7] 回今天后右栏写作法卡 =', await page.locator('.context .fw-stats').count());
  console.log('[7b] 一级导航项数 =', await page.locator('.nav-item').count(),
    '| 一级里有「自由记录」=',
    await page.locator('.nav-item', { hasText: '自由记录' }).count(),
    '| 九格目录里有「自由记录」=',
    await page.locator('.nav-mod', { hasText: '自由记录' }).count());
  await page.locator('.nav-mod', { hasText: '自由记录' }).click();
  await page.waitForTimeout(500);
  await page.locator('.free-view .fw-tab').nth(2).click();
  await page.waitForTimeout(400);
  console.log('[8] 九格目录再进自由记录 → tab3 右栏写作法卡 =', await page.locator('.context .fw-stats').count(),
    '| 九格目录高亮 =', (await page.locator('.nav-mod', { hasText: '自由记录' }).getAttribute('class')));
  await page.screenshot({ path: shot('reenter') });

  await app.close();
  console.log('DONE');
})().catch(function (e) { console.error('FAIL', e && e.stack || e); process.exit(1); });
