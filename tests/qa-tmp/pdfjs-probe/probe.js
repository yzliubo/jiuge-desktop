'use strict';
(async function () {
  const log = [];
  const out = document.getElementById('out');
  try {
    log.push('pdfjs=' + (window.pdfjsLib && pdfjsLib.version));
    log.push('workerGlobal=' + !!(window.pdfjsWorker && window.pdfjsWorker.WorkerMessageHandler));
    // 关键：先把 worker 的全局处理器挂在页面上。pdf.js 检测到
    // globalThis.pdfjsWorker.WorkerMessageHandler 就会直接用主线程 fake worker，
    // 既不开 new Worker（file:// 下会被 CORS 挡），也不需要放宽 CSP 的 script-src。
    pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

    const arr = await window.readPdf();
    const data = new Uint8Array(arr);
    log.push('bytes=' + data.length);
    const doc = await pdfjsLib.getDocument({ data: data, useSystemFonts: true }).promise;
    log.push('pages=' + doc.numPages);
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1.1 });
    const cv = document.getElementById('cv');
    cv.width = Math.floor(vp.width);
    cv.height = Math.floor(vp.height);
    const t0 = Date.now();
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    log.push('renderMs=' + (Date.now() - t0));
    const tc = await page.getTextContent();
    const text = tc.items.map(function (i) { return i.str; }).join('');
    log.push('textLen=' + text.length);
    log.push('cjk=' + /[\u4e00-\u9fa5]/.test(text));
    log.push('textHead=' + text.slice(0, 100));
    window.__result = { ok: true, log: log };
  } catch (e) {
    window.__result = { ok: false, log: log, err: String((e && e.stack) || e) };
  }
  out.textContent = JSON.stringify(window.__result, null, 1);
})();
