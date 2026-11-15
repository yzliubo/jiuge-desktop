'use strict';
// 探针（不是门禁）：核对封面抽取的四条兜底路径，确认「书里有封面就能拿到」。
// 用法：node tests/qa-tmp/cover-probe.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const epub = require('../../src/reading/epub.js');

const fixtureDir = path.join(os.tmpdir(), 'jiuge-cover-fixtures');
const big = fs.readFileSync(path.join(fixtureDir, 'cover-big.png'));
const small = fs.readFileSync(path.join(fixtureDir, 'cover-small.png'));

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  files.forEach(function (f) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(0, 6); lh.writeUInt32LE(0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([lh, name, data]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
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

function build(name, opf, extra) {
  const p = path.join(os.tmpdir(), 'cover-probe-' + name + '-' + Date.now() + '.epub');
  fs.writeFileSync(p, zip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: opf }
  ].concat(extra)));
  return p;
}

const cases = [];

// A. 规范写法：<meta name="cover">，但封面 1.2MB（旧上限 500KB 会漏）
cases.push({
  label: 'A meta封面 + 1.2MB 大图',
  file: build('a',
    '<package><metadata><dc:title>大图封面</dc:title><meta name="cover" content="ci"/></metadata>' +
    '<manifest><item id="ci" href="images/cover.png" media-type="image/png"/></manifest>' +
    '<spine><itemref idref="ci"/></spine></package>',
    [{ name: 'OEBPS/images/cover.png', data: big }]),
  expect: 'cover'
});

// B. 只有 guide type="cover" 指向封面页，页内 img 相对路径带 ../
cases.push({
  label: 'B guide 封面页（无 meta）',
  file: build('b',
    '<package><metadata><dc:title>guide 封面</dc:title></metadata>' +
    '<manifest><item id="cp" href="text/cover.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
    '<spine><itemref idref="ch1"/></spine>' +
    '<guide><reference type="cover" title="Cover" href="text/cover.xhtml"/></guide></package>',
    [
      { name: 'OEBPS/text/cover.xhtml', data: '<html><body><img src="../images/front.jpg" alt="cover"/></body></html>' },
      { name: 'OEBPS/text/ch1.xhtml', data: '<html><body><p>正文</p></body></html>' },
      { name: 'OEBPS/images/front.jpg', data: small }
    ]),
  expect: 'cover'
});

// C. EPUB3 写法：properties="cover-image"，文件名不含 cover
cases.push({
  label: 'C properties=cover-image',
  file: build('c',
    '<package><metadata><dc:title>EPUB3 封面</dc:title></metadata>' +
    '<manifest><item id="i1" href="img/c1.png" media-type="image/png" properties="cover-image"/></manifest>' +
    '<spine><itemref idref="i1"/></spine></package>',
    [{ name: 'OEBPS/img/c1.png', data: small }]),
  expect: 'cover'
});

// D. 真的没有封面：只有正文与一张插图，必须返回 null（不能把插图当封面）
cases.push({
  label: 'D 无封面（正文插图不该被当封面）',
  file: build('d',
    '<package><metadata><dc:title>没有封面</dc:title></metadata>' +
    '<manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="i1" href="images/fig1.png" media-type="image/png"/></manifest>' +
    '<spine><itemref idref="ch1"/></spine></package>',
    [
      { name: 'OEBPS/ch1.xhtml', data: '<html><body><img src="images/fig1.png"/><p>正文</p></body></html>' },
      { name: 'OEBPS/images/fig1.png', data: small }
    ]),
  expect: 'none'
});

let bad = 0;
cases.forEach(function (c) {
  const m = epub.inspect(c.file);
  const got = m && m.cover ? (m.cover.ext + ' ' + m.cover.data.length + 'B') : 'none';
  const ok = c.expect === 'cover' ? !!(m && m.cover) : !(m && m.cover);
  if (!ok) bad += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + c.label + ' → ' + got);
});
console.log(bad ? (bad + ' 条不符合预期') : '全部符合预期');
process.exit(bad ? 1 : 0);
