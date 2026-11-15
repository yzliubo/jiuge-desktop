'use strict';
// 临时探针：确认本地 pdf.js 导出 / getTextContent 的 item 结构（V3.17）
const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const PDF = process.argv[2] || 'D:/BaiduNetdiskWorkspace/论文/专业论文/031002100411_49997957.pdf';
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  if (!fs.existsSync(PDF)) { console.log('缺少测试 PDF：' + PDF); return; }
  const ud = path.join(os.tmpdir(), 'jiuge-probe-pdf-api-ud-' + Date.now());
  let app = null;
  try {
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    const size = fs.statSync(PDF).size;
    const bookId = await page.evaluate(async function (a) {
      await window.jiugeBridge.invoke('v1/domain:call', {
        name: 'reading.addBook',
        args: [{ title: 'PDF API 探针', author: '探针', total: 8, unit: '页',
          filePath: a.path, fileExt: 'pdf', fileSize: a.size, format: 'PDF' }]
      });
      const board = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
      const books = (board && board.data && board.data.books) || [];
      const hit = books.filter(function (b) { return b.title === 'PDF API 探针'; })[0];
      return hit ? hit.id : '';
    }, { path: PDF, size: size });

    const [reader] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(async function (id) {
        await window.jiugeBridge.invoke('v1/reader:open', { bookId: id });
      }, bookId)
    ]);
    await reader.waitForSelector('.rr-pdf-page canvas', { timeout: 30000 });
    await reader.waitForTimeout(1200);

    const info = await reader.evaluate(function () {
      const L = window.pdfjsLib;
      const keys = L ? Object.keys(L).sort() : [];
      const wanted = ['Util', 'TextLayer', 'renderTextLayer', 'getDocument', 'GlobalWorkerOptions',
        'AnnotationEditorLayer', 'version', 'build', 'TextLayerBuilder'];
      const expose = {};
      wanted.forEach(function (k) { expose[k] = L && typeof L[k] !== 'undefined' ? typeof L[k] : 'MISS'; });
      const utilKeys = L && L.Util ? Object.keys(L.Util).sort() : [];
      return { keys: keys.slice(0, 60), expose: expose, utilKeys: utilKeys,
        version: L && L.version, build: L && L.build };
    });
    console.log('pdfjsLib 导出 =', JSON.stringify(info, null, 1));

    const tc = await reader.evaluate(async function () {
      // 借用页面里已经打开的 pdfDoc 不方便（模块内局部变量），重新解码同一份数据
      const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.readerPdfData', args: [window.__probeBookId] });
      return r ? 'has domain' : 'no domain';
    }).catch(function (e) { return 'err ' + e.message; });
    console.log('domain 探测 =', tc);
  } catch (e) {
    console.log('探针异常：', e && e.message);
  } finally {
    if (app) await app.close().catch(function () {});
  }
})();
