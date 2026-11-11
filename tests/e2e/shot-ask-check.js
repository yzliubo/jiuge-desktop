'use strict';
// 出图 + 自检脚本（不是门禁）：看「伴读浮窗」启动时是不是胶囊、点一下才展开。
// 用法：node tests/e2e/shot-ask-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = path.join(root, 'build-v2');
const userData = path.join(os.tmpdir(), 'jiuge-shot-ask-' + Date.now());

delete process.env.ELECTRON_RUN_AS_NODE;

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  files.forEach(function (f) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([lh, name, data]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    offset += 30 + name.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, eocd]));
}

const P1 = '城市的地下有一张看不见的网。雨水、污水、给水、燃气、电力，各自沿着自己的路径穿过土层，在检修井里偶尔交会。设计这张网的人，先要学会的不是计算公式，而是承认自己看不见它。';
const P2 = '一条管道的寿命，往往不取决于它最厚的管壁，而取决于它最薄的那一处。腐蚀从焊缝开始，沉降在接口处积累，真正让管道失效的，是那些在图纸上标不出位置的地方。';

const book = zip([
  { name: 'mimetype', data: 'application/epub+zip' },
  { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
  {
    name: 'OEBPS/content.opf',
    data: '<package><metadata><dc:title>城门与水管</dc:title><dc:creator>老刘</dc:creator></metadata>' +
      '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
      '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
  },
  {
    name: 'OEBPS/toc.ncx',
    data: '<ncx><navMap>' +
      '<navPoint id="n1"><navLabel><text>第一章 城门</text></navLabel><content src="ch1.xhtml"/></navPoint>' +
      '<navPoint id="n2"><navLabel><text>第二章 水管</text></navLabel><content src="ch2.xhtml"/></navPoint>' +
      '</navMap></ncx>'
  },
  { name: 'OEBPS/ch1.xhtml', data: '<html><body><h1>第一章 城门</h1><p>' + P1 + '</p><p>' + P2 + '</p></body></html>' },
  { name: 'OEBPS/ch2.xhtml', data: '<html><body><h1>第二章 水管</h1><p>' + P2 + '</p><p>' + P1 + '</p></body></html>' }
]);
const fixture = path.join(os.tmpdir(), 'jiuge-ask-book-' + Date.now() + '.epub');
fs.writeFileSync(fixture, book);

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
    await page.waitForSelector('.rd-book', { timeout: 15000 });

    const [rd] = await Promise.all([
      app.waitForEvent('window'),
      page.locator('.rd-book').filter({ hasText: '城门与水管' }).first().dblclick()
    ]);
    await rd.waitForSelector('.rr-app', { timeout: 20000 });
    await rd.waitForTimeout(1600);

    function readAsk() {
      return rd.evaluate(() => {
        const el = document.getElementById('rrAsk');
        const body = document.getElementById('rrAskBody');
        const r = el.getBoundingClientRect();
        return {
          hidden: el.hidden,
          folded: el.classList.contains('rr-ask-folded'),
          bodyDisplay: getComputedStyle(body).display,
          foldBtn: (document.getElementById('rrAskFold') || {}).textContent,
          title: (document.getElementById('rrAskTitle') || {}).textContent,
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        };
      });
    }

    const onStart = await readAsk();
    await rd.screenshot({ path: path.join(outDir, 'shot-ask-1-capsule.png') });
    await rd.locator('#rrAsk').screenshot({ path: path.join(outDir, 'shot-ask-1-capsule-zoom.png') });

    // 点标题栏（不是那个小箭头）也该展开
    await rd.click('#rrAskHead');
    await rd.waitForTimeout(400);
    const afterClick = await readAsk();
    await rd.screenshot({ path: path.join(outDir, 'shot-ask-2-open.png') });
    await rd.locator('#rrAsk').screenshot({ path: path.join(outDir, 'shot-ask-2-open-zoom.png') });

    // 再点一次箭头收回成胶囊
    await rd.click('#rrAskFold');
    await rd.waitForTimeout(300);
    const afterFold = await readAsk();

    // 关掉 → 右下角「伴读」唤回：应当直接展开，位置不丢
    await rd.click('#rrAskClose');
    await rd.waitForTimeout(200);
    const closed = await readAsk();
    await rd.click('#rrAskOpen');
    await rd.waitForTimeout(400);
    const reopened = await readAsk();

    console.log('onStart=' + JSON.stringify(onStart));
    console.log('afterClick=' + JSON.stringify(afterClick));
    console.log('afterFold=' + JSON.stringify(afterFold));
    console.log('closed=' + JSON.stringify(closed));
    console.log('reopened=' + JSON.stringify(reopened));

    const assert = require('assert');
    assert.strictEqual(onStart.folded, true, '启动不是胶囊');
    assert.strictEqual(onStart.bodyDisplay, 'none', '启动就把问答摊开了');
    assert.strictEqual(afterClick.folded, false, '点标题栏没展开');
    assert.notStrictEqual(afterClick.bodyDisplay, 'none', '展开后 body 仍隐藏');
    assert.ok(afterClick.rect.h > onStart.rect.h + 100, '展开后高度没长起来');
    assert.strictEqual(afterClick.rect.x, onStart.rect.x, '展开后横向位置跳了');
    assert.strictEqual(afterFold.folded, true, '再点箭头没收回胶囊');
    assert.strictEqual(closed.hidden, true, '关闭后浮窗还在');
    assert.strictEqual(reopened.hidden, false, '唤回失败');
    assert.strictEqual(reopened.folded, false, '唤回后应直接展开');
    assert.strictEqual(reopened.rect.x, afterFold.rect.x, '唤回后位置没保持');
    console.log('ALL OK');
    await rd.close();
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
