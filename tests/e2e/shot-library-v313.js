'use strict';
// 出图脚本（不是门禁）：V3.13 图书馆四件事——
//   ① 主题书不进休闲书架  ② 无封面书的占位印完整书名
//   ③ 详细列表改成 calibre 式表格  ④ 豆瓣封面候选与套用
// 用法：node tests/e2e/shot-library-v313.js [输出目录]
// 只读：JIUGE_V2_USERDATA 指向临时全新目录，结束后不删除任何用户文件。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'jiuge-shot-v313');
const userData = path.join(os.tmpdir(), 'jiuge-shot-v313-ud-' + Date.now());

delete process.env.ELECTRON_RUN_AS_NODE;

// 极简 zip：只够 EPUB 解析器认出 mimetype + container + opf + 一章正文
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

// 故意不给封面：要看的正是「没有封面时占位上印什么」
const LEISURE = [
  '移动平均线策略在中国的实证研究',
  '叶乐天·量化投资之道',
  '项目成本管理中不可预见费的界定与计取',
  '台州市施工现场关键人员到岗履职管理',
  // 加一本豆瓣能精确命中的，用来演示「点一张候选就换上」
  '活着'
];
const THEME = [
  '城镇污水处理厂污染物排放标准解读',
  'A2O 工艺脱氮除磷机理与运行控制',
  'MBR 膜污染控制与清洗周期'
];

function makeEpub(title, slug) {
  const f = path.join(os.tmpdir(), 'jiuge-v313-' + slug + '-' + Date.now() + '.epub');
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
    { name: 'OEBPS/ch1.xhtml', data: '<html><body><h1>第一章</h1><p>占位封面与书架陈列测试用正文。</p></body></html>' }
  ]));
  return f;
}

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    const leisureFiles = LEISURE.map(function (t, i) { return makeEpub(t, 'l' + i); });
    const themeFiles = THEME.map(function (t, i) { return makeEpub(t, 't' + i); });

    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, {
        JIUGE_V2_USERDATA: userData,
        JIUGE_V2_PROBE: '1',
        JIUGE_V2_PICK_FILES: leisureFiles.join('|')
      }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1320, height: 940 });
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(600);

    const call = function (name, args) {
      return page.evaluate(function (p) {
        return window.jiugeBridge.invoke('v1/domain:call', { name: p.name, args: p.args });
      }, { name: name, args: args || [] });
    };

    // 截图通道（V3.13 踩坑记录）：Playwright 在 Electron 里偶发卡在 captureScreenshot 上
    // （日志停在 fonts loaded，随后 30s 超时），跟页面是否崩没关系——同一时刻 evaluate 还活着。
    // 所以重试两次仍不成就走 BrowserWindow.capturePage 兜底，别让一张图毁掉整轮出图。
    let shotFallback = 0;
    async function shot(name) {
      const file = path.join(outDir, name);
      for (let i = 0; i < 2; i++) {
        try {
          await page.screenshot({ path: file, timeout: 12000 });
          return;
        } catch (e) {
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
      console.log('截图兜底（capturePage）：' + name);
    }

    // ① 休闲书架：4 本无封面的书
    await page.locator('.reading-btn').click();
    await page.waitForSelector('.rd-view', { timeout: 8000 });
    await page.locator('.rd-tab').nth(0).click();
    await page.waitForSelector('.rd-drop', { timeout: 8000 });
    await page.locator('.rd-file-actions .rd-primary').click();
    await page.waitForSelector('.rd-trow', { timeout: 20000 });
    await page.waitForTimeout(700);
    await shot('v313-1-list.png');

    // ② 建主题 + 三本同主题文件（直接走领域层：文件选择器只认一个注入列表）
    await call('reading.themeAdd', [{ title: '污水处理工艺', note: '同一个主题下的一组标准与工艺文件' }]);
    const themes = await call('reading.themes', []);
    const themeId = themes && themes.data && themes.data[0] && themes.data[0].themeId;
    for (let i = 0; i < THEME.length; i += 1) {
      await call('reading.addBook', [{
        title: THEME[i], author: '测试作者', total: 200, unit: '页',
        themeId: themeId, filePath: themeFiles[i], fileExt: 'epub', fileSize: 4096, format: 'EPUB'
      }]);
    }

    // ③ 回书架看：主题书不该出现在休闲书架里（数量仍是 4）
    // 领域层直接写入不会推给渲染层，所以退出图书馆再进一次，让 board 重新读一遍
    await page.locator('.rd-back').click();
    await page.waitForTimeout(400);
    await page.locator('.reading-btn').click();
    await page.waitForSelector('.rd-view', { timeout: 8000 });
    await page.locator('.rd-tab').nth(0).click();
    await page.waitForTimeout(900);
    const rowCount = await page.locator('.rd-trow').count();
    const headText = await page.locator('.rd-stats').innerText();
    console.log('休闲书架行数 = ' + rowCount + '（应为 5：4 本无封面 + 活着）');
    console.log('统计头 = ' + headText.replace(/\s+/g, ' '));
    await shot('v313-2-list-after-theme.png');

    // ④ 封面预览：无封面 → 占位印完整书名
    await page.locator('.rd-viewmode button', { hasText: '封面预览' }).click();
    await page.waitForSelector('.rd-card', { timeout: 8000 });
    await page.waitForTimeout(600);
    await shot('v313-3-grid.png');

    // ⑤ 封面墙
    await page.locator('.rd-viewmode button', { hasText: '封面墙' }).click();
    await page.waitForSelector('.rd-spine', { timeout: 8000 });
    await page.waitForTimeout(500);
    await shot('v313-4-wall.png');

    // ⑥ 主题阅读：三本在各自主题下，书名收成一行
    await page.locator('.rd-tab').nth(1).click();
    await page.waitForSelector('.rd-group', { timeout: 8000 });
    await page.waitForTimeout(600);
    await shot('v313-5-theme.png');

    // ⑦ 豆瓣封面：编辑弹窗里点「从豆瓣找封面」——挑一本书名搜不到全称的，看关键词阶梯
    await page.locator('.rd-tab').nth(0).click();
    await page.locator('.rd-viewmode button', { hasText: '详细列表' }).click();
    await page.waitForSelector('.rd-trow', { timeout: 8000 });
    await page.locator('.rd-trow', { hasText: '移动平均线策略' }).locator('.rd-mini', { hasText: '编辑' }).click();
    await page.waitForSelector('.rd-modal', { timeout: 8000 });
    await page.locator('.rd-modal button', { hasText: '从豆瓣找封面' }).click();
    await page.waitForTimeout(7000);
    const candles = await page.locator('.rd-douban-item').count();
    const msg = await page.locator('.rd-douban .rd-hint').innerText().catch(function () { return ''; });
    console.log('豆瓣候选 = ' + candles + ' 张；提示 = ' + msg);
    await shot('v313-6-douban.png');

    // ⑧ 换一本豆瓣能精确命中的（活着），点第一张候选，看封面真换上去
    await page.locator('.rd-modal .rd-x').click();
    await page.waitForTimeout(300);
    await page.locator('.rd-trow', { hasText: '活着' }).locator('.rd-mini', { hasText: '编辑' }).click();
    await page.waitForSelector('.rd-modal', { timeout: 8000 });
    await page.locator('.rd-modal button', { hasText: '从豆瓣找封面' }).click();
    await page.waitForTimeout(7000);
    const n2 = await page.locator('.rd-douban-item').count();
    console.log('《活着》候选 = ' + n2 + ' 张');
    if (n2 > 0) {
      await page.locator('.rd-douban-item').first().click();
      await page.waitForTimeout(3000);
      // 先确认渲染层还活着：截图超时多半意味着主线程被卡住，这时该看的是卡在哪一步
      const alive = await page.evaluate(function () { return document.querySelectorAll('.rd-trow').length; });
      console.log('套用后行数 = ' + alive);
      await shot('v313-7-douban-applied.png');
      console.log('已点选第一张候选');
    }

    console.log('shots -> ' + outDir + (shotFallback ? '（' + shotFallback + ' 张走兜底）' : ''));
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
