'use strict';
// V3.5 书架分组 / 收藏夹真窗口探针
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const OUT = 'G:/workbuddy/2026-11-08-09-57-53/jiuge-redesign/评估-20261114/shots-library';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

function say(k, v) { console.log('[' + k + ']', JSON.stringify(v)); }

(async function () {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-groups-'));
  const app = await electron.launch({
    executablePath: path.join(P, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(P, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', function (e) { errors.push(e.message); });
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(700);
  await page.locator('.reading-btn').click();
  await page.waitForTimeout(600);

  for (const n of ['探针甲', '探针乙', '探针丙']) {
    await page.locator('.rd-add .rd-name').fill(n);
    await page.locator('.rd-add .rd-primary').click();
    await page.waitForTimeout(300);
  }
  say('rows', await page.locator('.rd-shelf .rd-book').count());
  say('groupBar', await page.locator('.rd-groups').count());
  say('chips', await page.locator('.rd-groups .rd-gchip').allInnerTexts());

  // 收藏：星标 → 收藏夹计数 → 筛选
  await page.locator('.rd-shelf .rd-book').first().locator('.rd-fav').click();
  await page.waitForTimeout(400);
  say('favChip', await page.locator('.rd-groups .rd-gchip').nth(1).innerText());
  await page.locator('.rd-groups .rd-gchip').nth(1).click();
  await page.waitForTimeout(300);
  say('favRows', await page.locator('.rd-shelf .rd-book').count());
  say('favOn', await page.locator('.rd-groups .rd-gchip').nth(1).getAttribute('aria-pressed'));
  await page.locator('.rd-groups .rd-gchip').first().click();
  await page.waitForTimeout(300);

  // 新建分组
  await page.locator('.rd-groups .rd-mini', { hasText: '＋ 新分组' }).click();
  await page.locator('.rd-groups .rd-gnew').fill('技术');
  await page.locator('.rd-groups .rd-mini', { hasText: '建分组' }).click();
  await page.waitForTimeout(500);
  say('chipsAfterCreate', await page.locator('.rd-groups .rd-gchip').allInnerTexts());
  say('groupRows', await page.locator('.rd-shelf .rd-book').count());
  await page.screenshot({ path: path.join(OUT, '09-书架-分组与收藏.png') });

  // 在编辑弹窗里把第二本也归进去
  await page.locator('.rd-groups .rd-gchip').first().click();
  await page.waitForTimeout(300);
  await page.locator('.rd-shelf .rd-book').nth(1).locator('.rd-mini', { hasText: '编辑' }).click();
  await page.waitForTimeout(350);
  await page.locator('#rdEditGroup').selectOption('技术');
  await page.screenshot({ path: path.join(OUT, '10-编辑弹窗-所属分组.png') });
  await page.locator('.rd-modal-acts .rd-primary').click();
  await page.waitForTimeout(500);
  say('chipsAfterAssign', await page.locator('.rd-groups .rd-gchip').allInnerTexts());

  // 重命名 / 解散
  await page.locator('.rd-groups .rd-gchip', { hasText: '技术' }).click();
  await page.waitForTimeout(300);
  await page.locator('.rd-groups .rd-mini', { hasText: '重命名' }).click();
  await page.locator('.rd-groups .rd-gnew').fill('工具书');
  await page.locator('.rd-groups .rd-mini', { hasText: '改名' }).click();
  await page.waitForTimeout(500);
  say('chipsAfterRename', await page.locator('.rd-groups .rd-gchip').allInnerTexts());
  say('renameRows', await page.locator('.rd-shelf .rd-book').count());

  await page.locator('.rd-groups .rd-mini', { hasText: '解散分组' }).click();
  await page.locator('.rd-groups .rd-mini', { hasText: '确认解散' }).click();
  await page.waitForTimeout(500);
  say('chipsAfterRemove', await page.locator('.rd-groups .rd-gchip').allInnerTexts());
  say('rowsAfterRemove', await page.locator('.rd-shelf .rd-book').count());
  say('pageErrors', errors.slice(0, 5));
  await app.close();
  console.log('PROBE_DONE');
})().catch(function (e) { console.error('PROBE_FAIL', e.stack || e.message); process.exit(1); });
