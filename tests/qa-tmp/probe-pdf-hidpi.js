'use strict';
// 临时探针：确认 PDF 画布按 devicePixelRatio 出位图（V3.16）
// 用法：node tests/qa-tmp/probe-pdf-hidpi.js [dpr]
//   dpr 默认 1.5；用 --force-device-scale-factor 模拟 Windows 150% 缩放
const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const dpr = Number(process.argv[2] || 1.5);
const PDF = 'D:/BaiduNetdiskWorkspace/论文/专业论文/031002100411_49997957.pdf';
const outDir = path.join(os.tmpdir(), 'jiuge-probe-pdf-hidpi');
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(PDF)) { console.log('缺少测试 PDF：' + PDF); return; }
  const ud = path.join(os.tmpdir(), 'jiuge-probe-pdf-ud-' + Date.now());
  let app = null;
  try {
    app = await electron.launch({
      executablePath: electronExe,
      args: ['--force-device-scale-factor=' + dpr, entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    console.log('主窗 devicePixelRatio =', await page.evaluate(function () { return window.devicePixelRatio; }));

    const size = fs.statSync(PDF).size;
    const bookId = await page.evaluate(async function (a) {
      await window.jiugeBridge.invoke('v1/domain:call', {
        name: 'reading.addBook',
        args: [{
          title: 'PDF 清晰度探针', author: '探针', total: 8, unit: '页',
          filePath: a.path, fileExt: 'pdf', fileSize: a.size, format: 'PDF'
        }]
      });
      // addBook 的回执结构不稳定，直接回查书架最稳
      const board = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
      const books = (board && board.data && board.data.books) || [];
      const hit = books.filter(function (b) { return b.title === 'PDF 清晰度探针'; })[0];
      return hit ? hit.id : '';
    }, { path: PDF, size: size });
    console.log('书 id =', bookId, '大小 =', size);

    const [reader] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(async function (id) {
        await window.jiugeBridge.invoke('v1/reader:open', { bookId: id });
      }, bookId)
    ]);
    await reader.waitForSelector('.rr-pdf-page canvas', { timeout: 30000 });
    await reader.waitForTimeout(1500);

    const info = await reader.evaluate(function () {
      const cvs = Array.prototype.slice.call(document.querySelectorAll('.rr-pdf-page canvas'));
      return cvs.slice(0, 3).map(function (c) {
        const r = c.getBoundingClientRect();
        return {
          bitmap: c.width + 'x' + c.height,
          cssPx: Math.round(r.width) + 'x' + Math.round(r.height),
          inline: c.style.width + 'x' + c.style.height,
          ratio: +(c.width / r.width).toFixed(3),
          dpr: window.devicePixelRatio
        };
      });
    });
    console.log('画布 =', JSON.stringify(info, null, 1));
    const r0 = info[0] || {};
    console.log('判定：位图/CSS = ' + r0.ratio + '；期望 ≈ ' + r0.dpr +
      ' → ' + (Math.abs((r0.ratio || 0) - (r0.dpr || 1)) < 0.06 ? 'PASS 已按 DPR 出图' : 'FAIL 仍是 1x 位图'));

    await reader.screenshot({ path: path.join(outDir, 'pdf-dpr' + dpr + '.png') });
    // 再把正文放大 3 倍截一块，肉眼比对笔画是否糊
    const crop = await reader.evaluate(function () {
      const c = document.querySelector('.rr-pdf-page canvas');
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + 40), y: Math.round(r.y + 60), width: 460, height: 220 };
    });
    await reader.screenshot({ path: path.join(outDir, 'pdf-dpr' + dpr + '-zoom.png'), clip: crop });
    console.log('截图目录 =', outDir);

    // 窗口变窄 → 画布必须重画（而不是被 CSS 拉伸）
    const before = await reader.evaluate(function () {
      const c = document.querySelector('.rr-pdf-page canvas');
      return { w: c.width, css: Math.round(c.getBoundingClientRect().width) };
    });
    let resized = 'ok';
    try { await reader.setViewportSize({ width: 900, height: 760 }); }
    catch (e) { resized = 'setViewportSize 失败：' + (e && e.message); }
    console.log('缩窗 =', resized);
    await reader.waitForTimeout(1400);
    const after = await reader.evaluate(function () {
      const c = document.querySelector('.rr-pdf-page canvas');
      return { w: c.width, css: Math.round(c.getBoundingClientRect().width), dpr: window.devicePixelRatio };
    });
    console.log('窗口变窄前 =', JSON.stringify(before), '变形后 =', JSON.stringify(after) +
      ' → ' + (after.w !== before.w ? 'PASS 画布跟着重画' : 'FAIL 画布被拉伸') +
      '（位图/CSS = ' + (after.w / after.css).toFixed(3) + '，当前 dpr = ' + after.dpr.toFixed(2) +
      (Math.abs(after.w / after.css - after.dpr) < 0.08 ? ' → 密度仍对齐）' : ' → 密度没跟上！）'));
    await reader.screenshot({ path: path.join(outDir, 'pdf-dpr' + dpr + '-narrow.png') });
  } finally {
    if (app) await app.close().catch(function () {});
  }
})().catch(function (e) { console.error('探针失败：', e && e.message); process.exitCode = 1; });
