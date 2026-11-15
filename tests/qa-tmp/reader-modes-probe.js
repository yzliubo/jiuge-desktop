'use strict';
// V3.5 阅读方式真窗口探针：PDF 原页 / 连续滚动 / 双页并排 / 全屏 / 分组收藏
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = '<仓库根>';
const OUT = '<文档根>/评估-20261114/shots-library';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
const PDF = '<用户目录>/Downloads/北湖污水处理厂深隧泵站水泵装置安装及调试_杨文中.pdf';
delete process.env.ELECTRON_RUN_AS_NODE;

const log = [];
function say(k, v) { const s = '[' + k + '] ' + JSON.stringify(v); log.push(s); console.log(s); }

(async function () {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-modes-'));
  const txt = path.join(ud, 'probe-book.txt');
  const cn = ['一', '二', '三', '四', '五', '六'];
  let body = '';
  for (let i = 1; i <= 6; i += 1) {
    body += '第' + cn[i - 1] + '章\n' +
      ('这是第 ' + i + ' 章的正文，用来验证连续滚动能不能把后面的章节接上来，也用来看双栏排版是否正常。').repeat(24) + '\n\n';
  }
  fs.writeFileSync(txt, body, 'utf8');

  const app = await electron.launch({
    executablePath: path.join(P, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(P, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const main = await app.firstWindow();
  await main.waitForSelector('.workbench', { timeout: 30000 });
  await main.waitForTimeout(700);

  const call = async (name, args) => {
    const r = await main.evaluate(function (q) {
      return window.jiugeBridge.invoke('v1/domain:call', { name: q.name, args: q.args });
    }, { name: name, args: args || [] });
    if (!r || r.code !== 'OK') throw new Error(name + ' -> ' + JSON.stringify(r));
    return r.data;
  };

  await call('reading.addFiles', [[PDF, txt]]);
  const bd = await call('reading.board', []);
  const rows = (bd.books || []).filter(function (b) { return /(北湖污水|probe-book)/.test(b.title) || /\.pdf$/i.test(b.filePath) || /probe-book/.test(b.filePath); });
  say('books', rows.map(function (b) { return { title: b.title, format: b.format, path: b.filePath }; }));
  const pdfBook = rows.filter(function (b) { return /\.pdf$/i.test(b.filePath); })[0];
  const txtBook = rows.filter(function (b) { return /\.txt$/i.test(b.filePath); })[0];
  if (!pdfBook || !txtBook) throw new Error('两本测试书没加齐');

  async function openReader(id) {
    const p = new Promise(function (resolve) { app.once('window', resolve); });
    await main.evaluate(function (q) {
      return window.jiugeBridge.invoke('v1/reader:open', { bookId: q });
    }, id);
    const w = await Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('开窗超时')); }, 15000); })]);
    await w.waitForSelector('#rrApp', { timeout: 30000 });
    await w.waitForTimeout(1200);
    return w;
  }

  // ---------- PDF ----------
  const pdfWin = await openReader(pdfBook.id);
  say('pdf:pagesText', await pdfWin.locator('#rrModePages').innerText());
  say('pdf:canvas', await pdfWin.locator('#rrPdf .rr-pdf-page canvas').count());
  say('pdf:toc', await pdfWin.locator('#rrToc .rr-toc-item').count());
  say('pdf:iframeHidden', await pdfWin.locator('#rrPage').evaluate(function (el) { return el.style.display; }));
  await pdfWin.screenshot({ path: path.join(OUT, '04-PDF-单页原页.png') });

  await pdfWin.locator('#rrFlow').click();
  await pdfWin.waitForTimeout(1200);
  say('pdf:flowPages', await pdfWin.locator('#rrPdf .rr-pdf-page').count());
  say('pdf:flowRendered', await pdfWin.locator('#rrPdf .rr-pdf-page canvas').count());

  await pdfWin.locator('#rrSpread').click();
  await pdfWin.waitForTimeout(1200);
  say('pdf:spreadClass', await pdfWin.locator('#rrPdf .rr-pdf-pages').getAttribute('class'));
  say('pdf:spreadRendered', await pdfWin.locator('#rrPdf .rr-pdf-page canvas').count());
  say('pdf:tocLabel', await pdfWin.locator('#rrToc .rr-toc-name').first().innerText());
  say('pdf:progressText', await pdfWin.locator('#rrProgressText').innerText());
  // 滚到封面下面那一摊，截图里才看得见左右两页真的并排
  await pdfWin.evaluate(function () {
    const s = document.getElementById('rrPdf');
    const b = s.querySelectorAll('.rr-pdf-page')[1];
    if (b) s.scrollTop = Math.max(0, b.offsetTop - 20);
  });
  await pdfWin.waitForTimeout(900);
  await pdfWin.screenshot({ path: path.join(OUT, '05-PDF-连续双页.png') });

  await pdfWin.locator('#rrFull').click();
  await pdfWin.waitForTimeout(700);
  say('pdf:full', await pdfWin.locator('#rrApp').getAttribute('data-full'));
  say('pdf:fullExitVisible', await pdfWin.locator('#rrFullExit').isVisible());
  await pdfWin.screenshot({ path: path.join(OUT, '06-PDF-全屏.png') });
  await pdfWin.locator('#rrFullExit').click();
  await pdfWin.waitForTimeout(400);
  say('pdf:afterExit', await pdfWin.locator('#rrApp').getAttribute('data-full'));

  // PDF 书内搜索（逐页文字层）
  await pdfWin.locator('#rrSearchInput').fill('水泵');
  await pdfWin.locator('#rrSearchBtn').click();
  await pdfWin.waitForTimeout(1800);
  say('pdf:searchCount', await pdfWin.locator('#rrSearchCount').innerText());
  say('pdf:searchHits', await pdfWin.locator('#rrSearchHits .rr-hit').count());

  await pdfWin.close();

  // ---------- TXT 连续滚动 / 双栏 ----------
  // 偏好是跨窗口共享的 localStorage：先显式把两个开关拨到目标态，别假定默认值
  async function ensureMode(win, wantFlow, wantSpread) {
    const f = (await win.locator('#rrFlow').getAttribute('aria-pressed')) === 'true';
    if (f !== wantFlow) { await win.locator('#rrFlow').click(); await win.waitForTimeout(700); }
    const s = (await win.locator('#rrSpread').getAttribute('aria-pressed')) === 'true';
    if (s !== wantSpread) { await win.locator('#rrSpread').click(); await win.waitForTimeout(500); }
  }
  const txtWin = await openReader(txtBook.id);
  const frame = txtWin.frameLocator('#rrPage');
  await ensureMode(txtWin, false, false);
  say('txt:chapterModeSections', await frame.locator('.rr-flow-ch').count());
  say('txt:chapterModeTitle', await txtWin.locator('#rrChapterTitle').innerText());

  await ensureMode(txtWin, true, false);
  const n1 = await frame.locator('.rr-flow-ch').count();
  say('txt:flowSections', n1);
  // 连滚到底两次，验证「滚到底自动追加下一章」
  for (let i = 0; i < 2; i += 1) {
    await txtWin.evaluate(function () {
      const w = document.getElementById('rrPage').contentWindow;
      w.scrollTo(0, w.document.documentElement.scrollHeight);
    });
    await txtWin.waitForTimeout(900);
  }
  const n2 = await frame.locator('.rr-flow-ch').count();
  say('txt:flowSectionsAfterScroll', n2);
  say('txt:currentChapterAfterScroll', await txtWin.locator('#rrPos').innerText());

  await ensureMode(txtWin, true, true);
  say('txt:columnCount', await txtWin.evaluate(function () {
    return document.getElementById('rrPage').contentDocument.body.style.columnCount;
  }));
  await txtWin.screenshot({ path: path.join(OUT, '07-流式-连续双栏.png') });
  await txtWin.locator('#rrFull').click();
  await txtWin.waitForTimeout(500);
  say('txt:full', await txtWin.locator('#rrApp').getAttribute('data-full'));
  await txtWin.screenshot({ path: path.join(OUT, '08-流式-全屏.png') });
  await txtWin.close();

  await app.close();
  console.log('PROBE_DONE');
})().catch(function (e) {
  console.error('PROBE_FAIL', e.stack || e.message);
  console.error(log.join('\n'));
  process.exit(1);
});
