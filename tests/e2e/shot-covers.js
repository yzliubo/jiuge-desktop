'use strict';
// 出图脚本（不是门禁）：核对书架「详细列表 / 封面预览 / 封面墙」三种陈列里封面的显示比例。
// 用法：node tests/e2e/shot-covers.js [输出目录]
// 只读：JIUGE_V2_USERDATA 指向临时全新目录，结束后不删除任何用户文件。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'jiuge-shot-covers');
const userData = path.join(os.tmpdir(), 'jiuge-shot-covers-ud-' + Date.now());
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

const BOOKS = [
  { slug: 'a', title: '程序员修炼之道', author: 'Hunt & Thomas', cover: 'cover-a.png' },
  { slug: 'b', title: '小强升职记', author: '邹鑫', cover: 'cover-b.png' },
  { slug: 'c', title: '股票大作手回忆录', author: '勒菲弗', cover: 'cover-c.png' }
];

function makeEpub(b) {
  const png = fs.readFileSync(path.join(coverDir, b.cover));
  const f = path.join(os.tmpdir(), 'jiuge-cover-' + b.slug + '-' + Date.now() + '.epub');
  fs.writeFileSync(f, zip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
    {
      name: 'OEBPS/content.opf',
      data: '<package><metadata><dc:title>' + b.title + '</dc:title><dc:creator>' + b.author + '</dc:creator>' +
        '<meta name="cover" content="ci"/></metadata>' +
        '<manifest><item id="ci" href="images/cover.png" media-type="image/png"/>' +
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
        '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
        '<spine toc="ncx"><itemref idref="c1"/></spine></package>'
    },
    { name: 'OEBPS/toc.ncx', data: '<ncx><navMap><navPoint id="n1"><navLabel><text>第一章</text></navLabel><content src="ch1.xhtml"/></navPoint></navMap></ncx>' },
    { name: 'OEBPS/ch1.xhtml', data: '<html><body><h1>第一章</h1><p>封面比例测试用的正文。文字不重要，长度凑一屏即可。</p></body></html>' },
    { name: 'OEBPS/images/cover.png', data: png }
  ]));
  return f;
}

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    const fixtures = BOOKS.map(makeEpub);

    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, {
        JIUGE_V2_USERDATA: userData,
        JIUGE_V2_PROBE: '1',
        JIUGE_V2_PICK_FILES: fixtures.join('|')
      }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(600);

    await page.locator('.reading-btn').click();
    await page.waitForSelector('.rd-view', { timeout: 8000 });
    await page.locator('.rd-tab').nth(0).click();
    await page.waitForSelector('.rd-drop', { timeout: 8000 });
    await page.locator('.rd-file-actions .rd-primary').click();
    await page.waitForSelector('.rd-book', { timeout: 20000 });
    await page.waitForTimeout(800);

    // ① 详细列表（默认）：封面应按 2:3 立着，不再被行高拉成窄条
    await page.screenshot({ path: path.join(outDir, 'covers-1-list.png') });

    // ② 封面预览（带文字的卡片）
    await page.locator('.rd-viewmode button', { hasText: '封面预览' }).click();
    await page.waitForSelector('.rd-card', { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'covers-2-grid.png') });

    // ③ 封面墙（只摆封面）
    await page.locator('.rd-viewmode button', { hasText: '封面墙' }).click();
    await page.waitForSelector('.rd-spine', { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'covers-3-wall.png') });

    // ④ 悬停浮出书名 / 作者 / 进度
    await page.locator('.rd-spine').first().hover();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'covers-4-wall-hover.png') });

    console.log('shots -> ' + outDir);
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
