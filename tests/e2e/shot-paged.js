'use strict';
// 出图 + 数值探针（不是门禁）：核对「分页阅读」与「双页并排」到底是不是真分页。
// 关键判据：
//   1. 分页容器高度 == 正文可视高度（内容不再纵向堆成一条长卷）
//   2. 翻页后 transform 平移一整页，页码与首段文字都换掉
//   3. 双页并排时右栏接左栏往下读，且本章最后一段不在第一摊里
// 用法：node tests/e2e/shot-paged.js [输出目录]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'jiuge-shot-paged');
const userData = path.join(os.tmpdir(), 'jiuge-shot-paged-ud-' + Date.now());

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

// 长章节：每段开头带一个可读序号，翻页后一眼能看出接没接上
const PARAS = [];
for (let i = 1; i <= 36; i += 1) {
  const n = ('0' + i).slice(-2);
  PARAS.push('<p>' + n + ' · 城市的地下有一张看不见的网。雨水、污水、给水、燃气、电力，' +
    '各自沿着自己的路径穿过土层，在检修井里偶尔交会。设计这张网的人，先要学会的不是' +
    '计算公式，而是承认自己看不见它。一条管道的寿命，往往不取决于它最厚的管壁，' +
    '而取决于它最薄的那一处。</p>');
}

const book = zip([
  { name: 'mimetype', data: 'application/epub+zip' },
  { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
  {
    name: 'OEBPS/content.opf',
    data: '<package><metadata><dc:title>分页试验书</dc:title><dc:creator>老刘</dc:creator></metadata>' +
      '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
      '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
  },
  {
    name: 'OEBPS/toc.ncx',
    data: '<ncx><navMap><navPoint id="n1"><navLabel><text>第一章 长章</text></navLabel><content src="ch1.xhtml"/></navPoint>' +
      '<navPoint id="n2"><navLabel><text>第二章 短章</text></navLabel><content src="ch2.xhtml"/></navPoint></navMap></ncx>'
  },
  {
    name: 'OEBPS/ch1.xhtml',
    data: '<html><body><h1>第一章 长章</h1>' + PARAS.join('') + '</body></html>'
  },
  {
    name: 'OEBPS/ch2.xhtml',
    data: '<html><body><h1>第二章 短章</h1><p>21 · 第二章只有一小段，用来验证「翻过最后一页接下一章」。</p></body></html>'
  }
]);
const fixture = path.join(os.tmpdir(), 'jiuge-paged-book-' + Date.now() + '.epub');
fs.writeFileSync(fixture, book);

// 在正文 iframe 里量：页容器、列宽、页数、每页首段
function measure(rd) {
  return rd.evaluate(function () {
    const f = document.getElementById('rrPage');
    const d = f.contentDocument;
    const inner = d.getElementById('rr-pg-in');
    const vp = d.getElementById('rr-pg-vp');
    if (!inner || !vp) return { ok: false };
    const ps = Array.prototype.slice.call(inner.querySelectorAll('p'));
    const innerLeft = inner.getBoundingClientRect().left;
    const cs = getComputedStyle(inner);
    const gap = parseFloat(cs.columnGap) || 0;
    const pitch = (inner.clientWidth + gap) / (parseFloat(cs.columnCount) || 1);
    const label = (document.getElementById('rrModePages').innerText || '').replace(/\s+/g, ' ').trim();
    // 每一段落在第几栏（以「栏」为单位，不是以「页」为单位）
    const colOf = ps.map(function (p) {
      const r = p.getBoundingClientRect();
      return Math.round((r.left - innerLeft) / Math.max(1, pitch));
    });
    return {
      ok: true,
      label: label,
      innerH: inner.clientHeight,
      scrollH: inner.scrollHeight,
      clientH: inner.clientHeight,
      vpPad: getComputedStyle(vp).padding,
      colGap: gap,
      colCount: cs.columnCount,
      colWidth: cs.columnWidth,
      transform: cs.transform,
      firstText: ps.length ? ps[0].textContent.slice(0, 4) : '',
      lastCol: colOf.length ? colOf[colOf.length - 1] : -1,
      firstCols: colOf.slice(0, 6),
      cols: colOf
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
    await page.waitForSelector('.rd-book', { timeout: 20000 });

    const [rd] = await Promise.all([
      app.waitForEvent('window'),
      page.locator('.rd-book').filter({ hasText: '分页试验书' }).first().dblclick()
    ]);
    await rd.waitForSelector('.rr-app', { timeout: 20000 });
    await rd.waitForTimeout(1500);

    // 归位到「分章单栏」，别让上一次跑留下的偏好影响判断
    const ensureMode = async (sel, want) => {
      const on = (await rd.locator(sel).getAttribute('aria-pressed')) === 'true';
      if (on !== want) { await rd.locator(sel).click(); await rd.waitForTimeout(700); }
      return (await rd.locator(sel).getAttribute('aria-pressed')) === 'true';
    };
    await ensureMode('#rrFlow', false);
    await ensureMode('#rrSpread', false);
    await rd.screenshot({ path: path.join(outDir, 'paged-0-scroll.png') });

    // ---- 分页单页 ----
    await rd.locator('#rrPaged').click();
    await rd.waitForTimeout(900);
    const p1 = await measure(rd);
    await rd.screenshot({ path: path.join(outDir, 'paged-1-first.png') });
    console.log('PAGED-1 ' + JSON.stringify(p1));

    // 滚轮按在正文中间翻一页（这是「一页读完滚一下」的真实路径）
    await rd.locator('#rrPage').click({ position: { x: 400, y: 300 } });
    await rd.mouse.move(700, 420);
    await rd.mouse.wheel(0, 240);
    await rd.waitForTimeout(700);
    const p2 = await measure(rd);
    await rd.screenshot({ path: path.join(outDir, 'paged-2-second.png') });
    console.log('PAGED-2 ' + JSON.stringify(p2));

    // 再翻两页，看页码与位移是否线性（防「翻一页挪半页」）
    await rd.mouse.wheel(0, 240);
    await rd.waitForTimeout(600);
    await rd.mouse.wheel(0, 240);
    await rd.waitForTimeout(700);
    const p3 = await measure(rd);
    await rd.screenshot({ path: path.join(outDir, 'paged-3-third.png') });
    console.log('PAGED-3 ' + JSON.stringify(p3));

    // ---- 双页并排（分页之上的两页）----
    await rd.locator('#rrSpread').click();
    await rd.waitForTimeout(900);
    const s1 = await measure(rd);
    await rd.screenshot({ path: path.join(outDir, 'paged-4-spread.png') });
    console.log('SPREAD-1 ' + JSON.stringify(s1));

    await rd.mouse.move(700, 420);
    await rd.mouse.wheel(0, 240);
    await rd.waitForTimeout(800);
    const s2 = await measure(rd);
    await rd.screenshot({ path: path.join(outDir, 'paged-5-spread-next.png') });
    console.log('SPREAD-2 ' + JSON.stringify(s2));

    // 顶栏仍是「上一章 / 下一章」，底栏页码组在双页态也要在
    console.log('PAGES-UI ' + JSON.stringify(await rd.evaluate(function () {
      return {
        label: document.getElementById('rrModePages').innerText.replace(/\s+/g, ' ').trim(),
        btns: document.querySelectorAll('#rrModePages .rr-pg-btn').length,
        tip: document.getElementById('rrModesTip').textContent
      };
    })));

    // ---- 翻过最后一页要接下一章（像翻纸书一样）----
    await rd.locator('#rrPage').click({ position: { x: 400, y: 300 } });
    await rd.keyboard.press('End');
    await rd.waitForTimeout(600);
    const last = await measure(rd);
    console.log('LAST-PAGE ' + JSON.stringify({ label: last.label, transform: last.transform }));
    await rd.mouse.move(700, 420);
    await rd.mouse.wheel(0, 240);
    await rd.waitForTimeout(1200);
    const next = await rd.evaluate(function () {
      return {
        chapter: document.getElementById('rrChapterTitle').textContent,
        pos: document.getElementById('rrPos').textContent,
        label: document.getElementById('rrModePages').innerText.replace(/\s+/g, ' ').trim(),
        transform: (function () {
          const f = document.getElementById('rrPage');
          const inner = f.contentDocument.getElementById('rr-pg-in');
          return inner ? getComputedStyle(inner).transform : 'none';
        })()
      };
    });
    console.log('CROSS-CHAPTER ' + JSON.stringify(next));
    await rd.screenshot({ path: path.join(outDir, 'paged-6-next-chapter.png') });
    console.log('shots -> ' + outDir);
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
