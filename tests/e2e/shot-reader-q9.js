'use strict';
// 出图脚本（不是门禁）：把独立阅读窗右栏「三阶九问」面板截下来，供主理人核验观感。
// 用法：node tests/e2e/shot-reader-q9.js [输出目录]
// 只读：用 JIUGE_V2_USERDATA 指一个全新目录，本脚本不删除任何文件。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'build-v2');
const userData = path.join(os.tmpdir(), 'jiuge-shot-q9-' + Date.now());

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
const P3 = '所以规范里总留着余地：安全系数、备用管段、检修空间。这些余地看起来是浪费，实际上是给「看不见」留的位子。把它们算得太紧的工程，十年之内一定会回来补。';

const book = zip([
  { name: 'mimetype', data: 'application/epub+zip' },
  { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
  {
    name: 'OEBPS/content.opf',
    data: '<package><metadata><dc:title>看不见的管网</dc:title><dc:creator>老刘</dc:creator><meta name="cover" content="ci"/></metadata>' +
      '<manifest><item id="ci" href="images/cover.png" media-type="image/png"/>' +
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
      '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
  },
  {
    name: 'OEBPS/toc.ncx',
    data: '<ncx><navMap>' +
      '<navPoint id="n1"><navLabel><text>第一章 地下的网</text></navLabel><content src="ch1.xhtml"/>' +
      '<navPoint id="n1a"><navLabel><text>第一节 检修井</text></navLabel><content src="ch1.xhtml#v"/></navPoint></navPoint>' +
      '<navPoint id="n2"><navLabel><text>第二章 余地的算法</text></navLabel><content src="ch2.xhtml"/></navPoint>' +
      '</navMap></ncx>'
  },
  {
    name: 'OEBPS/ch1.xhtml',
    data: '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body>' +
      '<h1 id="v">第一章 地下的网</h1>' +
      '<p>' + P1 + '</p><p>' + P2 + '</p><blockquote>看不见的东西，才需要规范。</blockquote><p>' + P3 + '</p>' +
      '</body></html>'
  },
  {
    name: 'OEBPS/ch2.xhtml',
    data: '<html><body><h1>第二章 余地的算法</h1><p>' + P3 + '</p><p>' + P1 + '</p></body></html>'
  },
  {
    name: 'OEBPS/images/cover.png',
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  }
]);
const fixture = path.join(os.tmpdir(), 'jiuge-shot-book-' + Date.now() + '.epub');
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
      page.locator('.rd-book').filter({ hasText: '看不见的管网' }).first().dblclick()
    ]);
    await rd.waitForSelector('.rr-app', { timeout: 20000 });
    await rd.waitForTimeout(2200);

    // ① 默认视角：右栏九问面板（默认阶跟着阅读位置走）
    await rd.screenshot({ path: path.join(outDir, 'shot-q9-1-panel.png') });

    // ② 展开一问：面板里点开 Q4，看输入区与引用块的样子
    await rd.click('.rr-q9-tab[data-stage="mid"]');
    await rd.waitForTimeout(300);
    await rd.click('.rr-q9-item[data-i="0"]');
    await rd.waitForTimeout(300);
    await rd.fill('.rr-q9-input', '这一章说的是：地下管网的风险集中在看不见、也算不准的地方。');
    await rd.waitForTimeout(200);
    await rd.screenshot({ path: path.join(outDir, 'shot-q9-2-editor.png') });

    // ③ 划选 → 划线工具条（带重述 / 连接 / 行动）
    const fr = rd.frames().filter(function (f) { return f !== rd.mainFrame(); })[0];
    await fr.waitForSelector('p', { timeout: 15000 });
    await fr.evaluate(function () {
      const ps = Array.prototype.slice.call(document.querySelectorAll('p'));
      for (let i = 0; i < ps.length; i += 1) {
        const walker = document.createTreeWalker(ps[i], NodeFilter.SHOW_TEXT, null);
        const node = walker.nextNode();
        if (!node || node.textContent.trim().length < 20) continue;
        const r = document.createRange();
        r.setStart(node, 0);
        r.setEnd(node, 24);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return;
      }
    });
    await rd.waitForTimeout(600);
    await rd.screenshot({ path: path.join(outDir, 'shot-q9-3-selbar.png') });

    // ④ 点「行动」：浮窗直跳 Q6 并带上引用
    await rd.click('.rr-selbar-ask[data-ask="2"]');
    await rd.waitForTimeout(600);
    await rd.screenshot({ path: path.join(outDir, 'shot-q9-4-ask.png') });
    await rd.screenshot({ path: path.join(outDir, 'shot-q9-4-ask.png') });

    console.log('shots -> ' + outDir);
    await rd.close();
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
