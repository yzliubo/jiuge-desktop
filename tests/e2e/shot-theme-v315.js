'use strict';
// 出图脚本（不是门禁）：V3.15 主题阅读也走 calibre 式表格——
//   ① 主题下的书从「每本一张大卡片」换成与休闲书架同一套六列表格
//   ② 表头静态（不排序），操作列是 ＋ / 翻开读 / 编辑 / ✕
//   ③ 顺带量三件事：表格有没有横向溢出、六列是否都在可视区内、行高是否紧凑
// 用法：node tests/e2e/shot-theme-v315.js [输出目录]
// 只读：JIUGE_V2_USERDATA 指向临时全新目录，结束后不删除任何用户文件。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'jiuge-shot-v315');
const userData = path.join(os.tmpdir(), 'jiuge-shot-v315-ud-' + Date.now());

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

function tmpFile(ext, slug, bytes, text) {
  const f = path.join(os.tmpdir(), 'jiuge-v315-' + slug + '-' + Date.now() + ext);
  if (text !== undefined) fs.writeFileSync(f, text);
  else {
    const buf = Buffer.alloc(bytes || 4096, 0x20);
    fs.writeFileSync(f, buf);
  }
  return f;
}

function makeEpub(title, author, slug) {
  return tmpFile('.epub', slug, 0, zip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
    {
      name: 'OEBPS/content.opf',
      data: '<package><metadata><dc:title>' + title + '</dc:title><dc:creator>' + author + '</dc:creator></metadata>' +
        '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
        '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
        '<spine toc="ncx"><itemref idref="c1"/></spine></package>'
    },
    { name: 'OEBPS/toc.ncx', data: '<ncx><navMap><navPoint id="n1"><navLabel><text>第一章</text></navLabel><content src="ch1.xhtml"/></navPoint></navMap></ncx>' },
    { name: 'OEBPS/ch1.xhtml', data: '<html><body><h1>第一章</h1><p>主题表格出图用正文。</p></body></html>' }
  ]));
}

// 主题书单：故意混格式、混大小、混进度——表格的价值就在于横向比这三样
const THEMES = [
  {
    title: '污水处理工艺',
    note: '同一个主题下的一组标准、工艺文件与现场记录',
    books: [
      { t: '城镇污水处理厂污染物排放标准 GB 18918-2002', a: '生态环境部', fmt: 'PDF', size: 1342177, unit: '页', total: 48, done: 48, state: 'done', days: 2 },
      { t: 'A2O 工艺脱氮除磷机理与运行控制', a: '张自杰', fmt: 'EPUB', size: 12474368, unit: '章', total: 12, done: 7, state: 'reading', days: 0 },
      { t: 'MBR 膜污染控制与清洗周期', a: '黄霞', fmt: 'EPUB', size: 3145728, unit: '章', total: 9, done: 3, state: 'reading', days: 1 },
      { t: 'MBR 工艺设计手册（第 2 版）', a: '周琪', fmt: 'PDF', size: 46137344, unit: '页', total: 320, done: 0, state: 'todo', days: 0 },
      { t: '反硝化滤池运行调试笔记', a: '现场记录', fmt: 'MD', size: 18432, unit: '节', total: 6, done: 6, state: 'done', days: 5 },
      { t: '污泥膨胀案例分析汇编', a: '技术科', fmt: 'TXT', size: 64000, unit: '页', total: 25, done: 4, state: 'reading', days: 3 },
      { t: 'CASS 工艺设计要点', a: '未记作者', fmt: 'AZW3', size: 2097152, unit: '章', total: 10, done: 0, state: 'todo', days: 0 },
      { t: '某厂提标改造方案（内部讨论稿）', a: '武东建设', fmt: '', size: 0, unit: '页', total: 0, done: 0, state: 'todo', days: 0, hand: true }
    ]
  },
  {
    title: '量化投资方案',
    note: '论文与回测记录，多格式多文件',
    books: [
      { t: '移动平均线策略在中国的实证研究', a: '李明', fmt: 'PDF', size: 2411724, unit: '页', total: 100, done: 12, state: 'reading', days: 4 },
      { t: '项目成本管理中不可预见费的风险量化估算', a: '王强', fmt: 'PDF', size: 1887436, unit: '页', total: 100, done: 0, state: 'todo', days: 0 },
      { t: '量化交易的未来前景研究', a: '陈曦', fmt: 'EPUB', size: 5242880, unit: '章', total: 15, done: 15, state: 'done', days: 8 },
      { t: '动量因子回测脚本说明', a: '自建', fmt: 'MD', size: 8192, unit: '节', total: 4, done: 4, state: 'done', days: 9 },
      { t: '因子有效性检验记录', a: '自建', fmt: 'TXT', size: 22528, unit: '条', total: 40, done: 6, state: 'reading', days: 6 }
    ]
  }
];

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

    // 备数据：直接写领域层（书只能从文件来）
    let seq = 0;
    const seen = {};
    for (let ti = 0; ti < THEMES.length; ti += 1) {
      const th = THEMES[ti];
      await call('reading.themeAdd', [{ title: th.title, note: th.note }]);
      // 注意：themes 返回的是 { themeId, themeTitle, note, rows }——字段叫 themeTitle 不叫 title
      const themes = await call('reading.themes', []);
      const got = (themes || []).filter(function (x) { return (x.themeTitle || x.title) === th.title; })[0];
      const themeId = got ? got.themeId : ((themes || [])[themes.length - 1] || {}).themeId;
      if (!themeId) throw new Error('主题没建出来：' + th.title);

      for (let bi = 0; bi < th.books.length; bi += 1) {
        const b = th.books[bi];
        seq += 1;
        let filePath = '';
        let fileExt = '';
        if (!b.hand) {
          if (b.fmt === 'EPUB') {
            filePath = makeEpub(b.t, b.a, 't' + ti + 'b' + bi);
            fileExt = 'epub';
          } else {
            fileExt = (b.fmt || 'txt').toLowerCase();
            filePath = tmpFile('.' + fileExt, 't' + ti + 'b' + bi, b.size);
          }
        }
        await call('reading.addBook', [{
          title: b.t, author: b.a, total: b.total, unit: b.unit || '页',
          themeId: themeId, filePath: filePath, fileExt: fileExt,
          fileSize: b.size || 0, format: b.fmt || ''
        }]);
        const board = await call('reading.board', []);
        const hit = (board.books || []).filter(function (x) { return x.title === b.t; })[0];
        if (!hit) continue;
        seen[b.t] = hit.id;
        if (b.done > 0) await call('reading.themeAdvance', [themeId, hit.id, b.done]);
        if (b.state === 'done') await call('reading.setBookStatus', [hit.id, 'done', '2026-11-15']);
        else if (b.state === 'reading') await call('reading.setBookStatus', [hit.id, 'reading', '2026-11-15']);
        // 最近读过：touchBook 直接写 lastReadAt（advanceBook 不写这个字段，别拿它凑日期）
        if (b.days > 0) await call('reading.touch', [hit.id, Date.now() - b.days * 86400000]);
        else if (b.state !== 'todo') await call('reading.touch', [hit.id, Date.now()]);
      }
    }
    // 三本不归任何分组的休闲书：左栏「未分组」那一项才有内容可点
    const loose = ['随手翻的散文集', '一本讲桥梁史的书', '旧讲义（没归档）'];
    for (let i = 0; i < loose.length; i += 1) {
      await call('reading.addBook', [{
        title: loose[i], author: '散书', total: 120, unit: '页',
        filePath: tmpFile('.txt', 'loose' + i, 64), fileExt: 'txt', fileSize: 64, format: 'TXT'
      }]);
    }

    // 两条笔记：右栏与「格式 · 大小」的 title 才有东西可查
    const nb = seen['MBR 膜污染控制与清洗周期'];
    if (nb) {
      await call('reading.addNote', [{
        mode: 'theme', bookId: nb, bookTitle: 'MBR 膜污染控制与清洗周期', type: 'quote',
        quote: '跨膜压差超过 35 kPa 就该安排在线清洗。', text: '厂里现在是 40 kPa 才动。',
        page: 126, tags: ['膜污染'], chapterId: '', pushedAt: Date.now(), pushedCell: 'work'
      }]);
    }

    // 开图书馆窗口
    let target = page;
    async function shot(name) {
      const file = path.join(outDir, name);
      for (let i = 0; i < 2; i++) {
        try { await target.screenshot({ path: file, timeout: 12000 }); return; }
        catch (e) { await page.waitForTimeout(600); }
      }
      const b64 = await app.evaluate(async function (ctx) {
        const w = ctx.BrowserWindow.getAllWindows()[0];
        const img = await w.capturePage();
        return img.toPNG().toString('base64');
      });
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    }

    const [lib] = await Promise.all([app.waitForEvent('window'), page.locator('.reading-btn').click()]);
    target = lib;
    await lib.waitForSelector('.lib-app', { timeout: 20000 });
    await lib.setViewportSize({ width: 1440, height: 900 });
    await lib.waitForTimeout(800);

    // 切到主题阅读
    await lib.locator('.rd-tab').filter({ hasText: '主题阅读' }).click();
    await lib.waitForSelector('.rd-theme-table', { timeout: 10000 });
    await lib.waitForTimeout(500);

    const stat = await lib.evaluate(function () {
      const tables = Array.prototype.slice.call(document.querySelectorAll('.rd-theme-table'));
      return tables.map(function (t) {
        const head = t.querySelector('.rd-thead');
        const ths = Array.prototype.slice.call(t.querySelectorAll('.rd-thead .rd-th')).map(function (s) {
          const b = s.getBoundingClientRect();
          return { text: (s.textContent || '').trim(), x: Math.round(b.x), w: Math.round(b.width) };
        });
        const rows = Array.prototype.slice.call(t.querySelectorAll('.rd-trow'));
        const rh = rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0;
        const tb = t.getBoundingClientRect();
        return {
          rows: rows.length,
          rowH: rh,
          tableW: Math.round(tb.width),
          scrollW: t.scrollWidth,
          clientW: t.clientWidth,
          overflow: t.scrollWidth - t.clientWidth,
          head: ths.map(function (s) { return s.text || '·'; }).join(' | '),
          cols: ths,
          lastColRight: ths.length ? (ths[ths.length - 1].x + ths[ths.length - 1].w) : 0,
          tableRight: Math.round(tb.right)
        };
      });
    });
    stat.forEach(function (s, i) {
      console.log('主题表 ' + (i + 1) + '：' + s.rows + ' 行 · 行高 ' + s.rowH + 'px · 表宽 ' + s.tableW +
        ' / 内容宽 ' + s.scrollW + ' · 横向溢出 ' + s.overflow + 'px');
      console.log('  列头 = ' + s.head);
      console.log('  各列 x/宽 = ' + s.cols.map(function (c) { return c.text + '@' + c.x + '/' + c.w; }).join('  '));
      console.log('  末列右缘 ' + s.lastColRight + ' vs 表右缘 ' + s.tableRight + ' → 全在可视区 = ' + (s.lastColRight <= s.tableRight + 1));
    });
    await shot('v315-1-theme-table.png');

    // 点「手工登记」那本（没有文件）→ 中栏出主题批注器，表格仍留在上方。
    // 有文件的书点「翻开读」是开独立阅读窗口，中栏不会出批注器——这是有意的分工。
    // 按书名找，别用 last()：新加的书排在最前面（表里是「最新在前」）。
    const handRow = lib.locator('.rd-theme-table').first().locator('.rd-trow')
      .filter({ hasText: '某厂提标改造方案' }).first();
    console.log('要点的行 = ' + (await handRow.locator('.rd-tname').innerText()).trim() +
      '；按钮 = ' + JSON.stringify(await handRow.locator('button').allInnerTexts()));
    await handRow.locator('button', { hasText: '翻开读' }).click();
    await lib.waitForTimeout(1500);
    const after = await lib.evaluate(function () {
      const t = document.querySelector('.rd-theme-table');
      const rd = document.querySelector('.rd-reader');
      const sayEl = document.querySelector('.rd-say, .toast, [role="status"]');
      return {
        reader: !!rd,
        readerAria: rd ? rd.getAttribute('aria-label') : '',
        readerVisible: rd ? !!(rd.offsetWidth || rd.offsetHeight) : false,
        tableStill: !!t,
        rows: t ? t.querySelectorAll('.rd-trow').length : 0,
        activeRow: document.querySelectorAll('.rd-trow-on').length,
        say: sayEl ? (sayEl.textContent || '').trim().slice(0, 60) : ''
      };
    });
    console.log('点开一本后：批注器节点 = ' + after.reader + '（aria=' + after.readerAria + '，可见=' + after.readerVisible + '）' +
      '；表格仍在 = ' + after.tableStill + '（' + after.rows + ' 行）；选中行 = ' + after.activeRow + '；提示 = ' + after.say);
    await shot('v315-2-theme-reader.png');

    // ③ 左栏点「未分组」→ 中栏书架要出那几本（保留值 GROUP_NONE 与空 group 必须对上）
    await lib.locator('.lib-row', { hasText: '未分组' }).first().click();
    await lib.waitForTimeout(700);
    console.log('点「未分组」→ 书架行数 = ' + (await lib.locator('.rd-shelf .rd-trow').count()) +
      '；中栏 chip 高亮 = ' + (await lib.locator('.rd-gchip.rd-gchip-on', { hasText: '未分组' }).count()));
    await shot('v315-3-ungrouped.png');

    // ④ 主题三角能收放：收起第一个主题，只剩标题行
    await lib.locator('.lib-row', { hasText: '主题阅读' }).first().click();
    await lib.waitForTimeout(500);
    await lib.locator('.rd-tab').filter({ hasText: '主题阅读' }).click();
    await lib.waitForTimeout(400);
    const tablesBefore = await lib.locator('.rd-theme-table').count();
    await lib.locator('.rd-group-title').first().click();
    await lib.waitForTimeout(500);
    console.log('收起第一个主题：表数 ' + tablesBefore + ' → ' + (await lib.locator('.rd-theme-table').count()) +
      '；标题提示 = ' + (await lib.locator('.rd-group .rd-hint').first().innerText()).trim());
    await shot('v315-4-collapsed.png');

    console.log('shots -> ' + outDir);
  } catch (e) {
    console.log('FAILED: ' + (e && e.stack ? e.stack : String(e)));
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(function () {});
  }
})();
