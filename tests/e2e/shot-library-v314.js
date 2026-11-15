'use strict';
// 出图脚本（不是门禁）：V3.14 图书馆独立窗口——
//   ① 顶栏「图书馆」开出独立窗口，三栏（文件夹树 / 书架 / 详情）
//   ② 左栏是「休闲阅读 / 主题阅读 → 分组 / 主题 → 书名」的层级树
//   ③ 搜索并进页签行最左侧；手写书名那一行已下线
// 用法：node tests/e2e/shot-library-v314.js [输出目录]
// 只读：JIUGE_V2_USERDATA 指向临时全新目录，结束后不删除任何用户文件。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'jiuge-shot-v314');
const userData = path.join(os.tmpdir(), 'jiuge-shot-v314-ud-' + Date.now());

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

// 休闲书：故意分三个分组，左栏才有层级可看
const LEISURE = [
  { t: '海底两万里', g: '文学' },
  { t: '城市给水排水工程规划', g: '给排水技术' },
  { t: '污水处理厂工艺设计手册', g: '给排水技术' },
  { t: '移动平均线策略在中国的实证研究', g: '量化投资' },
  { t: '活着', g: '' }
];
const THEME = ['城镇污水处理厂污染物排放标准解读', 'A2O 工艺脱氮除磷机理与运行控制', 'MBR 膜污染控制与清洗周期'];

function makeEpub(title, slug) {
  const f = path.join(os.tmpdir(), 'jiuge-v314-' + slug + '-' + Date.now() + '.epub');
  fs.writeFileSync(f, zip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
    {
      name: 'OEBPS/content.opf',
      data: '<package><metadata><dc:title>' + title + '</dc:title><dc:creator>测试作者</dc:creator></metadata>' +
        '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
        '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
        '<spine toc="ncx"><itemref idref="c1"/></spine></package>'
    },
    { name: 'OEBPS/toc.ncx', data: '<ncx><navMap><navPoint id="n1"><navLabel><text>第一章</text></navLabel><content src="ch1.xhtml"/></navPoint></navMap></ncx>' },
    { name: 'OEBPS/ch1.xhtml', data: '<html><body><h1>第一章</h1><p>三栏窗口与文件夹树测试用正文。</p></body></html>' }
  ]));
  return f;
}

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1320, height: 940 });
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(500);

    const call = function (name, args) {
      return page.evaluate(function (p) {
        return window.jiugeBridge.invoke('v1/domain:call', { name: p.name, args: p.args })
          .then(function (r) { return r.data; });
      }, { name: name, args: args || [] });
    };

    // 直接写领域层：手写书名那一行已下线，书只能从文件来
    const leisureFiles = LEISURE.map(function (x, i) { return makeEpub(x.t, 'l' + i); });
    const themeFiles = THEME.map(function (t, i) { return makeEpub(t, 't' + i); });
    for (let i = 0; i < LEISURE.length; i += 1) {
      await call('reading.addBook', [{
        title: LEISURE[i].t, author: '测试作者', total: 320, unit: '页',
        filePath: leisureFiles[i], fileExt: 'epub', fileSize: 4096, format: 'EPUB'
      }]);
    }
    await call('reading.themeAdd', [{ title: '污水处理工艺', note: '同一个主题下的一组标准与工艺文件' }]);
    const themes = await call('reading.themes', []);
    const themeId = themes && themes[0] && themes[0].themeId;
    for (let i = 0; i < THEME.length; i += 1) {
      await call('reading.addBook', [{
        title: THEME[i], author: '测试作者', total: 200, unit: '页',
        themeId: themeId, filePath: themeFiles[i], fileExt: 'epub', fileSize: 4096, format: 'EPUB'
      }]);
    }
    // 分组是书上的一个名字：按书名回填
    const board = await call('reading.board', []);
    for (let i = 0; i < LEISURE.length; i += 1) {
      if (!LEISURE[i].g) continue;
      const hit = (board.books || []).filter(function (b) { return b.title === LEISURE[i].t; })[0];
      if (hit) await call('reading.updateBook', [hit.id, { group: LEISURE[i].g }]);
    }
    // 一本书读到一半、一本读完：右栏的进度 / 状态才有东西可看
    const b2 = await call('reading.board', []);
    const half = (b2.books || []).filter(function (b) { return b.title === '城市给水排水工程规划'; })[0];
    if (half) { await call('reading.advanceBook', [half.id, 120, '2026-11-15']); }
    const done = (b2.books || []).filter(function (b) { return b.title === '活着'; })[0];
    if (done) { await call('reading.setBookStatus', [done.id, 'done', '2026-11-15']); }

    // 三条笔记：右栏「读书笔记」范围那四格（笔记 / 本月 / 已入九格 / 标签）才有数可看
    const noteBook = (b2.books || []).filter(function (b) { return b.title === '污水处理厂工艺设计手册'; })[0];
    if (noteBook) {
      await call('reading.addNote', [{
        mode: 'leisure', bookId: noteBook.id, bookTitle: noteBook.title, type: 'quote',
        quote: '膜池污泥浓度宜控制在 8~12 g/L；跨膜压差超过 35 kPa 就该安排在线清洗。',
        text: '现场口径和厂里现在的做法差一档，回头核一遍清洗周期。',
        page: 126, tags: ['膜污染', '清洗周期'], chapterId: '',
        pushedAt: Date.now(), pushedCell: 'work'
      }]);
      await call('reading.addNote', [{
        mode: 'leisure', bookId: noteBook.id, bookTitle: noteBook.title, type: 'idea',
        text: '把「压差—清洗」写成一张对照表，标书里可以直接引用。',
        page: 131, tags: ['膜污染'], chapterId: ''
      }]);
      await call('reading.addNote', [{
        mode: 'theme', bookId: noteBook.id, bookTitle: THEME[0], type: 'quote',
        quote: '一级 A 标准的出水指标，是设计下限，不是运行目标。',
        page: 8, tags: ['标准', '出水指标'], chapterId: '',
        pushedAt: Date.now(), pushedCell: 'learn'
      }]);
    }

    // 截图对象会换成图书馆窗口：主窗那张不是要看的东西
    let target = page;
    let shotFallback = 0;
    async function shot(name) {
      const file = path.join(outDir, name);
      for (let i = 0; i < 2; i++) {
        try { await target.screenshot({ path: file, timeout: 12000 }); return; }
        catch (e) {
          console.log('截图重试 ' + (i + 1) + '：' + name + ' · ' + String(e.message || e).split('\n')[0]);
          await page.waitForTimeout(600);
        }
      }
      const b64 = await app.evaluate(async function (ctx) {
        const w = ctx.BrowserWindow.getAllWindows()[0];
        const img = await w.capturePage();
        return img.toPNG().toString('base64');
      });
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      shotFallback++;
    }

    // ① 顶栏「图书馆」→ 独立窗口
    const [lib] = await Promise.all([
      app.waitForEvent('window'),
      page.locator('.reading-btn').click()
    ]);
    target = lib;
    await lib.waitForSelector('.lib-app', { timeout: 20000 });
    await lib.waitForSelector('.rd-trow', { timeout: 20000 });
    await lib.setViewportSize({ width: 1440, height: 900 });
    await lib.waitForTimeout(900);
    console.log('窗口标题 = ' + (await lib.title()));
    console.log('主窗还停在 = ' + (await page.locator('.view-crumb').count() ? '（有面包屑）' : '') +
      ' 九格? ' + (await page.locator('.workbench').count() > 0));
    console.log('左栏行数 = ' + (await lib.locator('.lib-row').count()));
    console.log('书架行数 = ' + (await lib.locator('.rd-trow').count()));

    // 左栏对齐实测：根行 / 组行 / 主题行 / 书名行各自从哪个 x 开始
    const treeInfo = await lib.evaluate(function () {
      const pick = function (text) {
        const rows = Array.prototype.slice.call(document.querySelectorAll('.lib-row'));
        const hit = rows.filter(function (r) { return (r.innerText || '').indexOf(text) >= 0; })[0];
        if (!hit) return null;
        const b = hit.getBoundingClientRect();
        const name = hit.querySelector('.lib-name');
        const nb = name ? name.getBoundingClientRect() : null;
        return { x: Math.round(b.x), w: Math.round(b.width), nameX: nb ? Math.round(nb.x) : null, cls: hit.className };
      };
      const kids = document.querySelector('.lib-kids');
      const left = document.querySelector('.lib-left');
      return {
        leftW: left ? Math.round(left.getBoundingClientRect().width) : null,
        kidsPad: kids ? getComputedStyle(kids).paddingLeft : null,
        root: pick('休闲阅读'), all: pick('收藏夹'), group: pick('给排水技术'),
        theme: pick('污水处理工艺'), book: pick('MBR')
      };
    });
    console.log('左栏实测 = ' + JSON.stringify(treeInfo));
    await shot('v314-1-window.png');

    // ② 点分组「给排水技术」
    await lib.locator('.lib-row', { hasText: '给排水技术' }).first().click();
    await lib.waitForTimeout(600);
    console.log('分组筛选后书架行数 = ' + (await lib.locator('.rd-trow').count()) +
      '；右栏标题 = ' + (await lib.locator('.lib-right-title').innerText()));
    await shot('v314-2-group.png');

    // ③ 展开主题、点主题节点
    await lib.locator('.lib-row', { hasText: '污水处理工艺' }).first().click();
    await lib.waitForTimeout(700);
    console.log('主题展开后书名行数 = ' + (await lib.locator('.lib-book').count()) +
      '；页签 = ' + (await lib.locator('.rd-tab').filter({ hasText: '主题阅读' }).getAttribute('aria-pressed')));
    await shot('v314-3-theme.png');

    // ④ 点主题下的一本书 → 右栏换成这本书
    await lib.locator('.lib-book').first().click();
    await lib.waitForTimeout(600);
    console.log('选中书名 = ' + (await lib.locator('.lib-right-title').innerText()));
    await shot('v314-4-book.png');

    // ⑤ 回休闲书架，看搜索并进页签行
    await lib.locator('.lib-row', { hasText: '休闲阅读' }).first().click();
    await lib.waitForTimeout(500);
    const tabsBox = await lib.locator('.rd-tabs').boundingBox();
    const searchBox = await lib.locator('.rd-search').boundingBox();
    console.log('搜索框左边缘 = ' + Math.round(searchBox.x) + '；页签行左边缘 = ' + Math.round(tabsBox.x) +
      '；搜索与页签同一行 = ' + (Math.abs((searchBox.y + searchBox.height / 2) - (tabsBox.y + tabsBox.height / 2)) < 14));
    const dupAdd = await lib.locator('.rd-add').count();
    console.log('页面上还剩几个 rd-add（只该有主题那种）= ' + dupAdd);

    // ⑤b 真打一个关键词，确认搜索框在页签行里就地生效（只查书名/作者/格式/备注，不查分组）
    await lib.locator('.rd-search').fill('污水');
    await lib.waitForTimeout(500);
    console.log('搜索「污水」后书架行数 = ' + (await lib.locator('.rd-trow').count()) +
      '；页签仍在 = ' + ((await lib.locator('.rd-tab').count()) >= 3) +
      '；搜索框仍在页签行内 = ' + (await lib.locator('.rd-tabs .rd-search').count()));
    await shot('v314-5-search-inline.png');
    await lib.locator('.rd-search').fill('');
    await lib.waitForTimeout(400);

    // ⑤c 读书笔记范围：右栏四格换成笔记口径
    await lib.locator('.lib-row', { hasText: '读书笔记' }).first().click();
    await lib.waitForTimeout(600);
    const kpiLabels = await lib.locator('.lib-kpi span').allInnerTexts();
    console.log('读书笔记范围右栏四格 = ' + JSON.stringify(kpiLabels) +
      '；中栏页签 = ' + (await lib.locator('.rd-tab').filter({ hasText: '读书笔记' }).getAttribute('aria-pressed')));
    await shot('v314-6-notes-scope.png');


    // ⑥ 再点一次顶栏：不该叠第二个窗口
    const libCount = function () { return app.windows().filter(function (w) { return w.url().indexOf('library.html') >= 0; }).length; };
    const before = libCount();
    await page.locator('.reading-btn').click();
    await page.waitForTimeout(900);
    console.log('窗口复用：点之前 ' + before + ' 个，点之后 ' + libCount() + ' 个');

    // ⑦ 「关闭窗口」真的能关掉（window.close 在这套 Electron 里是否有效）
    await lib.locator('.rd-back').click();
    await page.waitForTimeout(1200);
    console.log('点关闭后剩余图书馆窗口 = ' + libCount());
    console.log('shots -> ' + outDir + (shotFallback ? '（' + shotFallback + ' 张走兜底）' : ''));
  } catch (e) {
    console.log('FAILED: ' + (e && e.stack ? e.stack : String(e)));
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(function () {});
  }
})();
