'use strict';
// 出图脚本（不是门禁）：核对阅读窗「阅读方式」选项条是否居中、页码是否仍在右侧。
// 用法：node tests/e2e/shot-modes.js [输出目录]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'jiuge-shot-modes');
const userData = path.join(os.tmpdir(), 'jiuge-shot-modes-ud-' + Date.now());
const coverDir = path.join(os.tmpdir(), 'jiuge-cover-fixtures');

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
    data: '<package><metadata><dc:title>看不见的管网</dc:title><dc:creator>老刘</dc:creator><meta name="cover" content="ci"/></metadata>' +
      '<manifest><item id="ci" href="images/cover.png" media-type="image/png"/>' +
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
      '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine toc="ncx"><itemref idref="c1"/></spine></package>'
  },
  {
    name: 'OEBPS/toc.ncx',
    data: '<ncx><navMap><navPoint id="n1"><navLabel><text>第一章 地下的网</text></navLabel><content src="ch1.xhtml"/></navPoint></navMap></ncx>'
  },
  {
    name: 'OEBPS/ch1.xhtml',
    data: '<html><body><h1>第一章 地下的网</h1><p>' + P1 + '</p><p>' + P2 + '</p><p>' + P1 + '</p></body></html>'
  },
  { name: 'OEBPS/images/cover.png', data: fs.readFileSync(path.join(coverDir, 'cover-a.png')) }
]);
const fixture = path.join(os.tmpdir(), 'jiuge-modes-book-' + Date.now() + '.epub');
fs.writeFileSync(fixture, book);

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
    await page.waitForSelector('.rd-book', { timeout: 20000 });

    const [rd] = await Promise.all([
      app.waitForEvent('window'),
      page.locator('.rd-book').filter({ hasText: '看不见的管网' }).first().dblclick()
    ]);
    await rd.waitForSelector('.rr-app', { timeout: 20000 });
    await rd.waitForTimeout(2500);
    await rd.screenshot({ path: path.join(outDir, 'modes-1-window.png') });
    await rd.locator('#rrModes').screenshot({ path: path.join(outDir, 'modes-2-bar.png') });

    // 量一下选项条中心与整条中心差多少像素
    const box = await rd.evaluate(function () {
      const bar = document.getElementById('rrModes');
      const g = bar.querySelector('.rr-modes-group');
      const p = document.getElementById('rrModePages');
      const b = bar.getBoundingClientRect();
      const gb = g.getBoundingClientRect();
      const pb = p.getBoundingClientRect();
      return {
        barMid: b.left + b.width / 2,
        groupMid: gb.left + gb.width / 2,
        pagesRight: b.right - pb.right,
        barWidth: b.width
      };
    });
    console.log('底栏宽 ' + Math.round(box.barWidth) + 'px，选项条中心偏差 ' + Math.round(box.groupMid - box.barMid) + 'px，页码距右 ' + Math.round(box.pagesRight) + 'px');
    console.log('shots -> ' + outDir);
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
