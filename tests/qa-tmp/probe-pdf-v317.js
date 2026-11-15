'use strict';
// V3.17 端到端探针：PDF 划选 / 复制 / 摘录 / 搜索命中 / 点结果跳到命中处
const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const PDF = process.argv[2] || 'D:/BaiduNetdiskWorkspace/论文/专业论文/122A2O污水处理工艺实训平台的调试.pdf';
const KW = process.argv[3] || '污水处理';
const outDir = path.join(os.tmpdir(), 'jiuge-probe-pdf-v317');
delete process.env.ELECTRON_RUN_AS_NODE;

function shot(reader, name) { return reader.screenshot({ path: path.join(outDir, name) }); }

(async function () {
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(PDF)) { console.log('缺少测试 PDF：' + PDF); return; }
  const ud = path.join(os.tmpdir(), 'jiuge-probe-pdf-v317-ud-' + Date.now());
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
        args: [{ title: 'PDF 选区搜索探针', author: '探针', total: 8, unit: '页',
          filePath: a.path, fileExt: 'pdf', fileSize: a.size, format: 'PDF' }]
      });
      const board = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
      const books = (board && board.data && board.data.books) || [];
      const hit = books.filter(function (b) { return b.title === 'PDF 选区搜索探针'; })[0];
      return hit ? hit.id : '';
    }, { path: PDF, size: size });

    const [reader] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(async function (id) { await window.jiugeBridge.invoke('v1/reader:open', { bookId: id }); }, bookId)
    ]);
    await reader.waitForSelector('.rr-pdf-text span', { timeout: 30000 });
    await reader.waitForTimeout(700);

    // ① 划选一段（挑最长的那个 span，保证选到的是完整可读文字）
    const pick = await reader.evaluate(function () {
      const spans = Array.prototype.slice.call(document.querySelectorAll('.rr-pdf-text span'));
      let best = null;
      spans.forEach(function (s) { if (!best || s.textContent.length > best.textContent.length) best = s; });
      if (!best) return null;
      const r = document.createRange();
      r.selectNodeContents(best);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return { text: sel.toString(), len: best.textContent.length };
    });
    console.log('① 划选原文 =', JSON.stringify(pick && pick.text));
    await reader.evaluate(function () {
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await reader.waitForTimeout(250);
    const barVisible = await reader.locator('#rrSelBar').isVisible();
    const barText = await reader.locator('#rrSelBar').innerText().catch(function () { return ''; });
    console.log('② 工具条出现 =', barVisible, '| 按钮 =', barText.replace(/\s+/g, ' ').trim());
    await shot(reader, 'v317-1-selection.png');

    // ③ 复制
    await reader.locator('#rrSelBar [data-act="copy"]').click();
    await reader.waitForTimeout(250);
    const statusCopy = await reader.locator('#rrStatusMsg').innerText();
    console.log('③ 复制回执 =', statusCopy);

    // ④ 摘录进笔记
    await reader.evaluate(function () {
      const best = Array.prototype.slice.call(document.querySelectorAll('.rr-pdf-text span'))
        .sort(function (a, b) { return b.textContent.length - a.textContent.length; })[0];
      const r = document.createRange(); r.selectNodeContents(best);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await reader.waitForTimeout(200);
    await reader.locator('#rrSelBar [data-act="quote"]').click();
    await reader.waitForTimeout(400);
    const statusQuote = await reader.locator('#rrStatusMsg').innerText();
    const notes = await reader.evaluate(async function (id) {
      const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.notes', args: [{ bookId: id }] });
      const payload = (r && r.data) || r || {};
      return (payload.items || []).map(function (n) {
        return { type: n.type, style: n.style, quote: (n.quote || '').slice(0, 26), anchor: n.anchor, page: n.page };
      });
    }, bookId);
    console.log('④ 摘录回执 =', statusQuote);
    console.log('   笔记 =', JSON.stringify(notes));

    // ④b 划选 + 点颜色 → 文本层上出现持久标注，笔记也带页码锚点
    await reader.evaluate(function () {
      const best = Array.prototype.slice.call(document.querySelectorAll('.rr-pdf-text span'))
        .sort(function (a, b) { return b.textContent.length - a.textContent.length; })[0];
      const r = document.createRange(); r.selectNodeContents(best);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await reader.waitForTimeout(200);
    await reader.locator('#rrSelBar [data-color="green"]').click();
    await reader.waitForTimeout(400);
    const marks = await reader.locator('.rr-pdf-text span.rr-pdf-mark').count();
    const marksColor = await reader.locator('.rr-pdf-text span.rr-pdf-mark[data-mark="green"]').count();
    console.log('④b 颜色标注 span =', marks, '（绿色', marksColor, '）| 状态 =', await reader.locator('#rrStatusMsg').innerText());
    await shot(reader, 'v317-4-mark.png');

    // ⑤ 搜索
    await reader.locator('#rrSearchInput').fill(KW);
    await reader.locator('#rrSearchBtn').click();
    await reader.waitForFunction(function () {
      const el = document.getElementById('rrSearchCount');
      return el && /处|没有/.test(el.textContent);
    }, { timeout: 20000 });
    const searchCount = await reader.locator('#rrSearchCount').innerText();
    const hitRows = await reader.locator('.rr-hit').count();
    const lit = await reader.locator('.rr-pdf-text span.rr-pdf-hit').count();
    console.log('⑤ 搜索「' + KW + '」=', searchCount, '| 结果行 =', hitRows, '| 文本层高亮 span =', lit);
    await shot(reader, 'v317-2-search.png');

    // ⑥ 点一条结果，应该滚到命中处并点亮
    if (hitRows > 0) {
      await reader.locator('.rr-hit').first().click();
      await reader.waitForTimeout(700);
      const active = await reader.locator('.rr-pdf-text span.rr-pdf-hit-on').count();
      const jumpStatus = await reader.locator('#rrStatusMsg').innerText();
      console.log('⑥ 点结果：命中点亮 =', active, '| 状态 =', jumpStatus);
      await shot(reader, 'v317-3-jump.png');
    }

    // ⑦ Ctrl+F 落焦
    await reader.keyboard.press('Control+f');
    const focused = await reader.evaluate(function () { return document.activeElement && document.activeElement.id; });
    console.log('⑦ Ctrl+F 焦点 =', focused);

    console.log('截图目录 =', outDir);
  } catch (e) {
    console.log('探针异常：', e && e.stack);
  } finally {
    if (app) await app.close().catch(function () {});
  }
})();
