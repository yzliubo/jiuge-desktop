'use strict';
// 多语言接线定向真窗口探针：不依赖 playwright，直接用 Electron 加载渲染层产物，
// 在真 DOM 上点设置页语言按钮，验「改口 / 还原 / 偏好落盘」。
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '../..');
const DIST = path.join(root, 'renderer-v2/dist/index.html');
// 每次用全新档案：否则上一轮探针存下的语言偏好会让这轮一启动就已是别的语言
app.setPath('userData', path.join(__dirname, '.i18n-probe-userdata-' + Date.now()));
app.disableHardwareAcceleration();

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  const errors = [];
  win.webContents.on('console-message', function (_e, level, msg) {
    if (level === 3) errors.push(msg);
  });
  await win.loadFile(DIST);
  await new Promise(function (r) { setTimeout(r, 1300); });

  const out = await win.webContents.executeJavaScript(`(async function () {
    var out = {};
    var q = function (s) { return document.querySelector(s); };
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    out.brandZh = q('.brand') ? q('.brand').textContent.trim() : null;
    out.navZh = q('.nav-item') ? q('.nav-item').textContent.trim() : null;
    out.marksAtStart = document.querySelectorAll('[data-i18n-src]').length;

    var btn = q('.settings-btn');
    if (!btn) return { error: 'settings-btn missing' };
    btn.click();
    await sleep(280);
    out.cards = Array.prototype.map.call(document.querySelectorAll('.settings .card h2'), function (x) { return x.textContent.trim(); });
    var card = Array.prototype.filter.call(document.querySelectorAll('.settings .card'), function (c) {
      var h = c.querySelector('h2');
      return h && h.textContent.indexOf('8 · 语言') >= 0;
    })[0];
    if (!card) return { error: 'language card missing' };
    out.options = Array.prototype.map.call(card.querySelectorAll('button.seg'), function (b) { return b.textContent.trim(); });

    var host = q('#wt-host');
    out.inputBefore = host ? host.value : null;

    var pick = function (text) {
      return Array.prototype.filter.call(card.querySelectorAll('button.seg'), function (b) {
        return b.textContent.indexOf(text) >= 0;
      })[0];
    };
    var en = pick('English');
    if (!en) return { error: 'English option missing' };
    en.click();
    await sleep(320);
    out.brandEn = q('.brand').textContent.trim();
    out.navEn = q('.nav-item').textContent.trim();
    out.footEn = q('.local') ? q('.local').textContent.trim() : null;
    out.storedEn = localStorage.getItem('jiuge.ui.locale');
    out.inputAfterEn = host ? host.value : null;

    var ja = pick('日本語');
    if (ja) { ja.click(); await sleep(320); out.brandJa = q('.brand').textContent.trim(); }

    var zh = pick('简体中文');
    if (!zh) return { error: 'zh-Hans option missing' };
    zh.click();
    await sleep(320);
    out.brandBack = q('.brand').textContent.trim();
    out.navBack = q('.nav-item').textContent.trim();
    out.marksAfterRestore = document.querySelectorAll('[data-i18n-src]').length;
    out.storedBack = localStorage.getItem('jiuge.ui.locale');
    return out;
  })()`);

  console.log(JSON.stringify(out, null, 2));
  console.log('console errors: ' + JSON.stringify(errors));
  app.exit(0);
}).catch(function (e) {
  console.error('probe failed: ' + (e && e.stack || e));
  app.exit(1);
});
