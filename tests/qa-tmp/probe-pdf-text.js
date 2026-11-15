'use strict';
// V3.17 探针：PDF 文本层是否生成、能否划选、位置是否压在画布的字上
// 用法：node tests/qa-tmp/probe-pdf-text.js [pdf路径]
const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const PDF = process.argv[2] || 'D:/BaiduNetdiskWorkspace/论文/专业论文/031002100411_49997957.pdf';
const outDir = path.join(os.tmpdir(), 'jiuge-probe-pdf-text');
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(PDF)) { console.log('缺少测试 PDF：' + PDF); return; }
  const ud = path.join(os.tmpdir(), 'jiuge-probe-pdf-text-ud-' + Date.now());
  let app = null;
  try {
    app = await electron.launch({
      executablePath: electronExe, args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud }), timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    const size = fs.statSync(PDF).size;
    const bookId = await page.evaluate(async function (a) {
      await window.jiugeBridge.invoke('v1/domain:call', {
        name: 'reading.addBook',
        args: [{ title: 'PDF 文本层探针', author: '探针', total: 8, unit: '页',
          filePath: a.path, fileExt: 'pdf', fileSize: a.size, format: 'PDF' }]
      });
      const board = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
      const books = (board && board.data && board.data.books) || [];
      const hit = books.filter(function (b) { return b.title === 'PDF 文本层探针'; })[0];
      return hit ? hit.id : '';
    }, { path: PDF, size: size });

    const [reader] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(async function (id) { await window.jiugeBridge.invoke('v1/reader:open', { bookId: id }); }, bookId)
    ]);
    await reader.waitForSelector('.rr-pdf-page canvas', { timeout: 30000 });
    await reader.waitForSelector('.rr-pdf-text span', { timeout: 30000 });
    await reader.waitForTimeout(900);

    const info = await reader.evaluate(function () {
      const layers = Array.prototype.slice.call(document.querySelectorAll('.rr-pdf-text'));
      const spans = Array.prototype.slice.call(layers[0].querySelectorAll('span'));
      const cv = document.querySelector('.rr-pdf-page canvas');
      const cr = cv.getBoundingClientRect();
      const lr = layers[0].getBoundingClientRect();
      const box = document.querySelector('.rr-pdf-page');
      return {
        layers: layers.length,
        spansFirstPage: spans.length,
        textLen: (box.__pdfText || '').length,
        headText: (box.__pdfText || '').slice(0, 60),
        first5: spans.slice(0, 5).map(function (s) {
          return { t: s.textContent.slice(0, 12), left: s.style.left, top: s.style.top, fs: s.style.fontSize, tf: s.style.transform };
        }),
        canvas: { w: Math.round(cr.width), h: Math.round(cr.height), bitmap: cv.width },
        layer: { w: Math.round(lr.width), h: Math.round(lr.height), x: Math.round(lr.left - cr.left), y: Math.round(lr.top - cr.top) }
      };
    });
    console.log('文本层 =', JSON.stringify(info, null, 1));

    // 真划选：用 Range 选中第 3~8 个 span，读 getSelection().toString()
    const sel = await reader.evaluate(function () {
      const spans = Array.prototype.slice.call(document.querySelectorAll('.rr-pdf-text span')).slice(2, 9);
      if (spans.length < 2) return { text: '' };
      const r = document.createRange();
      r.setStart(spans[0].firstChild, 0);
      r.setEnd(spans[spans.length - 1].firstChild, spans[spans.length - 1].firstChild.nodeValue.length);
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(r);
      const rect = r.getBoundingClientRect();
      return { text: s.toString(), count: s.rangeCount, rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
    });
    console.log('划选结果 =', JSON.stringify(sel));
    await reader.waitForTimeout(300);
    await reader.screenshot({ path: path.join(outDir, 'text-selection.png') });

    // 把所有 span 临时描边，看是否压在画布的字上
    const alignShot = path.join(outDir, 'text-align.png');
    await reader.evaluate(function () {
      const st = document.createElement('style');
      st.id = 'probe-outline';
      st.textContent = '.rr-pdf-text span { outline: 1px solid rgba(255,0,0,.55) !important; }';
      document.head.appendChild(st);
      const s = window.getSelection(); if (s) s.removeAllRanges();
    });
    await reader.waitForTimeout(200);
    await reader.screenshot({ path: alignShot });
    console.log('对齐图 =', alignShot);
    console.log('判定：文本层与画布对齐 =',
      Math.abs(info.layer.x) <= 1 && Math.abs(info.layer.y) <= 1 &&
      Math.abs(info.layer.w - info.canvas.w) <= 1 ? 'PASS' : 'FAIL');
    console.log('判定：可划选 =', sel.text && sel.text.length > 1 ? 'PASS' : 'FAIL');
  } catch (e) {
    console.log('探针异常：', e && e.stack);
  } finally {
    if (app) await app.close().catch(function () {});
  }
})();
