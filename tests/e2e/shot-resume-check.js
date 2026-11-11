'use strict';
// 出图 + 自检脚本（不是门禁）：看「续读引导条」挪到顶栏后的实际样子。
// 用法：node tests/e2e/shot-resume-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = path.join(root, 'build-v2');
const userData = path.join(os.tmpdir(), 'jiuge-shot-resume-' + Date.now());

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
const fixture = path.join(os.tmpdir(), 'jiuge-resume-book-' + Date.now() + '.epub');
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

    // 先把位置挪到第 2 章，让「上次读到」有料可读，然后关窗重开走真实链路
    await rd.click('#rrNext');
    await rd.waitForTimeout(1200);
    await rd.close();
    await page.waitForTimeout(700);

    const [rd2] = await Promise.all([
      app.waitForEvent('window'),
      page.locator('.rd-book').filter({ hasText: '城门与水管' }).first().dblclick()
    ]);
    await rd2.waitForSelector('.rr-app', { timeout: 20000 });
    await rd2.waitForTimeout(1500);   // 续读条在打开后 600ms 才出现

    // 真实链路：不注入，直接读页面里自然出现的续读条
    const probe = await rd2.evaluate(() => {
      const el = document.getElementById('rrResume');
      const text = document.getElementById('rrResumeText');
      const stage = document.getElementById('rrStage');
      const r = el.getBoundingClientRect();
      const header = document.querySelector('.rr-top').getBoundingClientRect();
      return {
        hidden: el.hidden,
        text: text ? text.textContent : '',
        parent: el.parentElement.className,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        inHeader: r.top >= header.top && r.bottom <= header.bottom,
        stageTop: Math.round(stage.getBoundingClientRect().top),
        headerH: Math.round(header.height)
      };
    });
    await rd2.screenshot({ path: path.join(outDir, 'shot-resume-1-on.png') });

    // 关掉之后：是否真的不占位（display:none → 高度 0，正文不动）
    const off = await rd2.evaluate(() => {
      const el = document.getElementById('rrResume');
      const stage = document.getElementById('rrStage');
      const stageTopBefore = Math.round(stage.getBoundingClientRect().top);
      el.classList.remove('rr-show');
      el.hidden = true;
      return {
        display: getComputedStyle(el).display,
        h: Math.round(el.getBoundingClientRect().height),
        stageTopBefore: stageTopBefore,
        stageTop: Math.round(stage.getBoundingClientRect().top),
        headerH: Math.round(document.querySelector('.rr-top').getBoundingClientRect().height)
      };
    });
    await rd2.waitForTimeout(400);
    await rd2.screenshot({ path: path.join(outDir, 'shot-resume-2-off.png') });

    console.log('probe=' + JSON.stringify(probe));
    console.log('off=' + JSON.stringify(off));
    await rd2.close();
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
