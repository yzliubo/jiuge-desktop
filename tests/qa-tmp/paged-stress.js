'use strict';
// 压力探针：分页态下反复改字号 / 行距 / 版心 / 开关双页 / 改窗口大小，
// 结构必须始终只有一个分页容器、段落数不增不减（重排不能把节点复制或丢下）。
// 用法：node tests/qa-tmp/paged-stress.js "<epub 路径>"
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = path.join(os.tmpdir(), 'jiuge-paged-stress-ud-' + Date.now());
const fixture = process.argv[2];

delete process.env.ELECTRON_RUN_AS_NODE;

const snap = (frameOf) => frameOf.evaluate(() => {
  const d = document.body;
  const box = document.getElementById('rr-pg-in');
  return {
    vp: document.querySelectorAll('#rr-pg-vp').length,
    cls: document.querySelectorAll('#rr-pg-clip').length,
    inBox: document.querySelectorAll('#rr-pg-in').length,
    all: d.querySelectorAll('*').length,
    moved: box ? box.querySelectorAll('*').length : 0,
    direct: Array.prototype.filter.call(d.children, (c) => c.id !== 'rr-pg-vp').length,
    pages: (document.querySelector('#rrModePages') || {}).textContent || ''
  };
});

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, {
        JIUGE_V2_USERDATA: userData,
        JIUGE_V2_PROBE: '1',
        JIUGE_V2_PICK_FILES: fixture
      }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.locator('.reading-btn').click();
    await page.waitForSelector('.rd-view', { timeout: 8000 });
    await page.locator('.rd-tab').nth(0).click();
    await page.waitForSelector('.rd-drop', { timeout: 8000 });
    await page.locator('.rd-file-actions .rd-primary').click();
    await page.waitForSelector('.rd-book', { timeout: 30000 });
    const [rd] = await Promise.all([
      app.waitForEvent('window'),
      page.locator('.rd-book').first().dblclick()
    ]);
    await rd.waitForSelector('.rr-app', { timeout: 30000 });
    await rd.waitForTimeout(1800);
    const frameOf = () => rd.frames().filter((f) => f !== rd.mainFrame())[0];
    const ensureMode = async (sel, want) => {
      const on = (await rd.locator(sel).getAttribute('aria-pressed')) === 'true';
      if (on !== want) { await rd.locator(sel).click(); await rd.waitForTimeout(900); }
    };
    await ensureMode('#rrFlow', false);
    await ensureMode('#rrSpread', false);
    await ensureMode('#rrPaged', true);
    await rd.waitForTimeout(600);
    console.log('STEP0 ' + JSON.stringify(await snap(frameOf())));

    await rd.locator('#rrFontPlus').click();
    await rd.waitForTimeout(700);
    console.log('FONT+ ' + JSON.stringify(await snap(frameOf())));

    await rd.locator('#rrLine').click();
    await rd.waitForTimeout(700);
    console.log('LINE  ' + JSON.stringify(await snap(frameOf())));

    await rd.locator('#rrZoomIn').click();
    await rd.waitForTimeout(700);
    console.log('ZOOM  ' + JSON.stringify(await snap(frameOf())));

    await rd.locator('#rrMargin').selectOption('wide');
    await rd.waitForTimeout(700);
    console.log('MARGIN ' + JSON.stringify(await snap(frameOf())));

    await rd.locator('#rrSpread').click();
    await rd.waitForTimeout(900);
    console.log('SPREAD ' + JSON.stringify(await snap(frameOf())));

    await rd.locator('#rrSpread').click();
    await rd.waitForTimeout(900);
    console.log('UNSPREAD ' + JSON.stringify(await snap(frameOf())));

    // 关掉分页：正文必须原样回到 body 直下，段落数不变
    await rd.locator('#rrPaged').click();
    await rd.waitForTimeout(700);
    console.log('OFF ' + JSON.stringify(await snap(frameOf())));
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
