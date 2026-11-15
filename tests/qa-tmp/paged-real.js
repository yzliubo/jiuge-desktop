'use strict';
// 临时探针：拿真实 EPUB（自带 CSS / 图片 / 长章节）验分页有没有被书里的样式顶破。
// 用法：node tests/qa-tmp/paged-real.js "<epub 路径>" [输出目录]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = path.join(os.tmpdir(), 'jiuge-paged-real-ud-' + Date.now());
const fixture = process.argv[2];
const outDir = process.argv[3] || path.join(os.tmpdir(), 'jiuge-paged-real');

delete process.env.ELECTRON_RUN_AS_NODE;

function readPage(rd, frameOf) {
  return frameOf.evaluate(() => {
    const box = document.getElementById('rr-pg-in');
    const clip = document.getElementById('rr-pg-clip');
    if (!box || !clip) return { ok: false };
    const cr = clip.getBoundingClientRect();
    const cs = getComputedStyle(box);
    // 最右的内容右沿：比裁切框还靠右就是露页了
    let maxRight = 0;
    Array.prototype.forEach.call(box.querySelectorAll('p,img,h1,h2,h3,li,blockquote'), function (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.bottom > cr.top && r.top < cr.bottom && r.right > maxRight) maxRight = r.right;
    });
    return {
      ok: true,
      gap: cs.columnGap,
      cw: box.clientWidth,
      sw: box.scrollWidth,
      h: box.clientHeight,
      sh: box.scrollHeight,
      transform: cs.transform,
      clipW: Math.round(cr.width),
      overRight: Math.round(maxRight - cr.right),
      imgs: box.querySelectorAll('img').length,
      bodyCol: getComputedStyle(document.body).columnCount,
      bodyPad: getComputedStyle(document.body).padding
    };
  });
}

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
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
    await rd.waitForTimeout(2000);
    const frameOf = () => rd.frames().filter((f) => f !== rd.mainFrame())[0];

    const ensureMode = async (sel, want) => {
      const on = (await rd.locator(sel).getAttribute('aria-pressed')) === 'true';
      if (on !== want) { await rd.locator(sel).click(); await rd.waitForTimeout(900); }
    };
    await ensureMode('#rrFlow', false);
    await ensureMode('#rrSpread', false);
    await ensureMode('#rrPaged', false);

    await rd.locator('#rrPaged').click();
    await rd.waitForTimeout(1200);
    console.log('REAL-PAGED ' + JSON.stringify(await readPage(rd, frameOf())));
    console.log('LABEL ' + (await rd.locator('#rrModePages').innerText()).replace(/\s+/g, ' '));
    await rd.screenshot({ path: path.join(outDir, 'real-1-paged.png') });

    // 连翻三页，确认每页内容都在框里、行宽没被书里的样式顶宽
    for (let i = 0; i < 3; i += 1) {
      await rd.mouse.move(700, 420);
      await rd.mouse.wheel(0, 240);
      await rd.waitForTimeout(500);
    }
    console.log('REAL-PAGED-4 ' + JSON.stringify(await readPage(rd, frameOf())));
    await rd.screenshot({ path: path.join(outDir, 'real-2-paged.png') });

    await rd.locator('#rrSpread').click();
    await rd.waitForTimeout(1100);
    console.log('REAL-SPREAD ' + JSON.stringify(await readPage(rd, frameOf())));
    await rd.screenshot({ path: path.join(outDir, 'real-3-spread.png') });
    console.log('shots -> ' + outDir);
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
