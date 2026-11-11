'use strict';
// 诊断脚本（不是门禁）：看底栏高度、页面是否溢出、底栏下面还有没有东西。
// 用法：node tests/e2e/shot-status-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = path.join(root, 'build-v2');
const userData = path.join(os.tmpdir(), 'jiuge-shot-status-' + Date.now());

delete process.env.ELECTRON_RUN_AS_NODE;

(async function main() {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(900);

    const probe = await page.evaluate(() => {
      const sb = document.querySelector('.statusbar');
      const wb = document.querySelector('.workbench');
      const r = sb.getBoundingClientRect();
      const wr = wb.getBoundingClientRect();
      const cs = getComputedStyle(sb);
      return {
        win: { w: window.innerWidth, h: window.innerHeight },
        doc: {
          scrollH: document.documentElement.scrollHeight,
          clientH: document.documentElement.clientHeight,
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth
        },
        body: { scrollH: document.body.scrollHeight, clientH: document.body.clientHeight },
        workbench: { top: Math.round(wr.top), bottom: Math.round(wr.bottom), h: Math.round(wr.height) },
        statusbar: {
          top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
          w: Math.round(r.width),
          padding: cs.padding, fontSize: cs.fontSize, overflow: cs.overflow,
          scrollH: sb.scrollHeight, clientH: sb.clientHeight, scrollW: sb.scrollWidth, clientW: sb.clientWidth
        },
        statusText: sb.textContent.replace(/\s+/g, ' ').trim(),
        gridRows: getComputedStyle(wb).gridTemplateRows,
        // 底栏下面还有谁
        afterStatus: (function () {
          const kids = Array.prototype.slice.call(wb.children);
          const i = kids.indexOf(sb);
          return kids.slice(i + 1).map(function (k) {
            const b = k.getBoundingClientRect();
            return { cls: k.className, top: Math.round(b.top), h: Math.round(b.height), hidden: k.hidden };
          });
        })(),
        lastChildBottom: (function () {
          const kids = Array.prototype.slice.call(wb.children);
          let max = 0, who = '';
          kids.forEach(function (k) {
            const b = k.getBoundingClientRect();
            if (b.height > 0 && b.bottom > max) { max = b.bottom; who = k.className || k.tagName; }
          });
          return { bottom: Math.round(max), who: who };
        })()
      };
    });
    console.log(JSON.stringify(probe, null, 2));

    // 谁把页面撑高了：列出 bottom 超过视口、或 height 超过视口的元素
    const over = await page.evaluate(() => {
      const out = [];
      const vh = window.innerHeight;
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i += 1) {
        const el = all[i];
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && (r.bottom > vh + 1)) {
          out.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 40),
            top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
            pos: cs.position, overflow: cs.overflow
          });
        }
      }
      return out.slice(0, 25);
    });
    console.log('OVERFLOWERS=' + JSON.stringify(over, null, 2));

    const appEl = await page.evaluate(() => {
      const a = document.getElementById('app') || document.body.firstElementChild;
      const b = a ? a.getBoundingClientRect() : null;
      return {
        html: { h: getComputedStyle(document.documentElement).height, overflow: getComputedStyle(document.documentElement).overflow },
        body: { h: getComputedStyle(document.body).height, overflow: getComputedStyle(document.body).overflow, margin: getComputedStyle(document.body).margin },
        app: a ? { id: a.id, cls: a.className, h: getComputedStyle(a).height, rectH: b ? Math.round(b.height) : 0 } : null
      };
    });
    console.log('ROOT=' + JSON.stringify(appEl, null, 2));

    await page.screenshot({ path: path.join(outDir, 'shot-status-1-home.png') });
    // 底栏特写
    await page.locator('.statusbar').screenshot({ path: path.join(outDir, 'shot-status-2-bar.png') });

    // 逐个视图看底栏 + 页面是否还溢出
    const navCount = await page.locator('.nav-item').count();
    const report = [];
    for (let i = 0; i < navCount; i += 1) {
      const nav = page.locator('.nav-item').nth(i);
      const label = (await nav.innerText()).replace(/\s+/g, ' ').trim();
      await nav.click();
      await page.waitForTimeout(320);
      const m = await page.evaluate(() => ({
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth
      }));
      report.push({
        view: label,
        overflowY: m.scrollH - m.clientH,
        overflowX: m.scrollW - m.clientW
      });
      if (i === 0 || label.indexOf('数据中心') >= 0) {
        await page.screenshot({
          path: path.join(outDir, 'shot-status-3-view-' + (i + 1) + '.png')
        });
      }
    }
    console.log('VIEWS=' + JSON.stringify(report, null, 2));
  } finally {
    if (app) { try { await app.close(); } catch (e) { /* noop */ } }
  }
})();
