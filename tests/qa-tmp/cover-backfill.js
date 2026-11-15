'use strict';
// 探针（不是门禁）：验证「老书没有 coverId」时，按需回填书内封面。
// 做法：第一次导入 → 关窗 → 手工把 store.json 的 coverId 清空并删掉封面文件（模拟旧版本数据）
//       → 第二次启动打开图书馆，看封面是否自动补回来。
// 用法：node tests/qa-tmp/cover-backfill.js [输出目录]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../e2e'), 'node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'jiuge-cover-backfill');
const userData = path.join(os.tmpdir(), 'jiuge-backfill-ud-' + Date.now());
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

const SPECS = [
  { slug: 'a', title: '程序员修炼之道', author: 'Hunt & Thomas', cover: 'cover-a.png' },
  { slug: 'b', title: '小强升职记', author: '邹鑫', cover: 'cover-b.png' },
  { slug: 'c', title: '股票大作手回忆录', author: '勒菲弗', cover: 'cover-c.png' }
];

function makeEpub(b) {
  const png = fs.readFileSync(path.join(coverDir, b.cover));
  const f = path.join(os.tmpdir(), 'jiuge-backfill-' + b.slug + '-' + Date.now() + '.epub');
  fs.writeFileSync(f, zip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
    {
      name: 'OEBPS/content.opf',
      data: '<package><metadata><dc:title>' + b.title + '</dc:title><dc:creator>' + b.author + '</dc:creator>' +
        '<meta name="cover" content="ci"/></metadata>' +
        '<manifest><item id="ci" href="images/cover.png" media-type="image/png"/>' +
        '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
        '<spine><itemref idref="c1"/></spine></package>'
    },
    { name: 'OEBPS/ch1.xhtml', data: '<html><body><p>回填测试正文。</p></body></html>' },
    { name: 'OEBPS/images/cover.png', data: png }
  ]));
  return f;
}

async function launch() {
  return electron.launch({
    executablePath: electronExe,
    args: [entry],
    env: Object.assign({}, process.env, {
      JIUGE_V2_USERDATA: userData,
      JIUGE_V2_PROBE: '1',
      JIUGE_V2_PICK_FILES: fixtures.join('|')
    }),
    timeout: 60000
  });
}

let fixtures = [];

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fixtures = SPECS.map(makeEpub);

    // 第一轮：正常导入（新版会直接抽到封面）
    app = await launch();
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.locator('.reading-btn').click();
    await page.waitForSelector('.rd-view', { timeout: 8000 });
    await page.locator('.rd-tab').nth(0).click();
    await page.waitForSelector('.rd-drop', { timeout: 8000 });
    await page.locator('.rd-file-actions .rd-primary').click();
    await page.waitForSelector('.rd-book', { timeout: 20000 });
    await page.waitForTimeout(1200);
    await app.close();
    app = null;

    // 手工退化成旧数据：coverId 清空 + 删掉已落盘的封面文件
    const storePath = path.join(userData, 'jiuge-data', 'store.json');
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const entries = raw.entries || raw;
    const reading = entries.md_reading || {};
    const books = Array.isArray(reading.books) ? reading.books : [];
    books.forEach(function (b) { b.coverId = ''; });
    fs.writeFileSync(storePath, JSON.stringify(raw));
    const cdir = path.join(userData, 'jiuge-data', 'covers');
    if (fs.existsSync(cdir)) {
      fs.readdirSync(cdir).forEach(function (n) { try { fs.unlinkSync(path.join(cdir, n)); } catch (_) { /* noop */ } });
    }
    console.log('已退化为旧数据：' + books.length + ' 本无 coverId，covers 目录已清空');

    // 第二轮：只打开书架，不重新导入——封面应被按需补回
    app = await launch();
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.locator('.reading-btn').click();
    await page.waitForSelector('.rd-view', { timeout: 8000 });
    await page.locator('.rd-tab').nth(0).click();
    await page.waitForSelector('.rd-book', { timeout: 15000 });
    await page.waitForTimeout(2000);

    const shown = await page.locator('.rd-book .rd-cover-img').count();
    await page.screenshot({ path: path.join(outDir, 'backfill-list.png') });
    const restored = fs.existsSync(cdir) ? fs.readdirSync(cdir).length : 0;
    console.log('列表里显示出来的封面数：' + shown + ' / 3；covers 目录回填文件数：' + restored);

    await page.locator('.rd-viewmode button', { hasText: '封面墙' }).click();
    await page.waitForSelector('.rd-spine', { timeout: 8000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, 'backfill-wall.png') });
    const wall = await page.locator('.rd-spine-img').count();
    console.log('封面墙显示出来的封面数：' + wall + ' / 3');
    console.log('shots -> ' + outDir);
    process.exitCode = shown === 3 && wall === 3 ? 0 : 1;
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
