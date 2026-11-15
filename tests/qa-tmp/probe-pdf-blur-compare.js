'use strict';
// 出图：同一页 PDF，「1x 位图被浏览器拉伸」（修复前）与「按 DPR 出位图」（修复后）
// 并排对比，肉眼可见的差别就是老刘看到的那种糊。
// 用法：node tests/qa-tmp/probe-pdf-blur-compare.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = path.join(os.tmpdir(), 'jiuge-pdf-compare');
const PDF = process.argv[2] || 'D:/BaiduNetdiskWorkspace/论文/专业论文/(完整word版)絮凝沉淀池调试方案说明.pdf';
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(PDF)) { console.log('缺少测试 PDF：' + PDF); return; }
  const b64 = fs.readFileSync(PDF).toString('base64');
  const ud = path.join(os.tmpdir(), 'jiuge-pdfcmp-ud-' + Date.now());
  let app = null;
  try {
    app = await electron.launch({
      executablePath: electronExe,
      args: ['--force-device-scale-factor=1.5', entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    console.log('dpr =', await page.evaluate(function () { return window.devicePixelRatio; }));

    const size = fs.statSync(PDF).size;
    const bookId = await page.evaluate(async function (a) {
      await window.jiugeBridge.invoke('v1/domain:call', {
        name: 'reading.addBook',
        args: [{
          title: 'PDF 模糊对照', author: '对照', total: 10, unit: '页',
          filePath: a.path, fileExt: 'pdf', fileSize: a.size, format: 'PDF'
        }]
      });
      const b = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
      const hit = ((b && b.data && b.data.books) || []).filter(function (x) { return x.title === 'PDF 模糊对照'; })[0];
      return hit ? hit.id : '';
    }, { path: PDF, size: size });

    const [reader] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(async function (id) { await window.jiugeBridge.invoke('v1/reader:open', { bookId: id }); }, bookId)
    ]);
    await reader.waitForSelector('.rr-pdf-page canvas', { timeout: 30000 });
    await reader.waitForTimeout(1200);

    const made = await reader.evaluate(async function (b64) {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const doc = await window.pdfjsLib.getDocument({ data: bytes, useSystemFonts: true }).promise;
      const page = await doc.getPage(Math.min(2, doc.numPages));
      const base = page.getViewport({ scale: 1 });
      const CSSW = 620;                       // 两版都显示成 620 CSS 像素宽
      const dpr = window.devicePixelRatio || 1;
      const draw = async function (scale, withDpr) {
        const vp = page.getViewport({ scale: scale });
        const cv = document.createElement('canvas');
        cv.width = Math.round(vp.width * (withDpr ? dpr : 1));
        cv.height = Math.round(vp.height * (withDpr ? dpr : 1));
        cv.style.width = CSSW + 'px';
        cv.style.height = Math.round(CSSW * (vp.height / vp.width)) + 'px';
        cv.style.border = '1px solid #c9c3b6';
        cv.style.display = 'block';
        const t = withDpr && dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: t }).promise;
        return cv;
      };
      // 位图按 620 CSS 宽出：修复前只出 1x，修复后出 dpr 倍
      const s = CSSW / base.width;
      const oldCv = await draw(s, false);
      const newCv = await draw(s, true);
      oldCv.id = 'cmp-old';
      newCv.id = 'cmp-new';

      const mask = document.createElement('div');
      mask.id = 'cmp-mask';
      mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#f6f4ef;display:flex;gap:18px;padding:18px;font:13px/1.5 system-ui';
      const mkCol = function (cv, label, sub) {
        const col = document.createElement('div');
        col.style.cssText = 'flex:0 0 auto';
        const h = document.createElement('div');
        h.textContent = label;
        h.style.cssText = 'font-weight:600;margin-bottom:4px;color:#5a4a35';
        const p = document.createElement('div');
        p.textContent = sub;
        p.style.cssText = 'font-size:11px;color:#8a8377;margin-bottom:8px';
        col.appendChild(h); col.appendChild(p); col.appendChild(cv);
        return col;
      };
      mask.appendChild(mkCol(oldCv, '修复前：1x 位图，被浏览器放大到 150%',
        '位图 ' + oldCv.width + 'px 宽 → 实际显示 ' + Math.round(CSSW * dpr) + ' 物理 px'));
      mask.appendChild(mkCol(newCv, '修复后：按 devicePixelRatio 出位图',
        '位图 ' + newCv.width + 'px 宽 → 与物理像素 1:1'));
      document.body.appendChild(mask);
      return {
        dpr: dpr,
        oldBitmap: oldCv.width + 'x' + oldCv.height,
        newBitmap: newCv.width + 'x' + newCv.height,
        pages: doc.numPages
      };
    }, b64);
    console.log('对照数据 =', JSON.stringify(made));
    await reader.waitForTimeout(400);
    const shot = path.join(outDir, 'pdf-blur-compare.png');
    await reader.screenshot({ path: shot });
    console.log('对比图 =', shot);
    // 两张画布各截一份，交给 PIL 按「同一物理密度」放大后并排
    await reader.locator('#cmp-old').screenshot({ path: path.join(outDir, 'cmp-old.png') });
    await reader.locator('#cmp-new').screenshot({ path: path.join(outDir, 'cmp-new.png') });
    console.log('单页图 =', path.join(outDir, 'cmp-old.png'), '|', path.join(outDir, 'cmp-new.png'));
  } finally {
    if (app) await app.close().catch(function () {});
  }
})().catch(function (e) { console.error('失败：', e && e.message); process.exitCode = 1; });
