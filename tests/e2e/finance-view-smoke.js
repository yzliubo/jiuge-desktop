'use strict';
// 家庭账本视图 DOM 冒烟：真实 Electron 窗口加载 renderer-v2/dist，
// 点顶栏「账本」，再逐个点开四个分区，确认每条 v-if/v-else-if 分支都渲染且控制台无错误。
// 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/e2e/finance-view-smoke.js
const path = require('path');
const { app, BrowserWindow } = require('electron');

const DIST = path.resolve(__dirname, '../../renderer-v2/dist/index.html');
const TABS = ['流水', '预算', '自动分类规则', 'CSV 导入'];
const errors = [];
const results = [];

function js(win, code) { return win.webContents.executeJavaScript(code); }
function clickButton(win, label) {
  return js(win, `(function () {
    var b = Array.prototype.slice.call(document.querySelectorAll('button'))
      .filter(function (x) { return (x.textContent || '').trim() === ${JSON.stringify(label)}; })[0];
    if (b) b.click();
    return !!b;
  })()`);
}
function snapshot(win) {
  return js(win, `(function () {
    var v = document.querySelector('.fin-view');
    return {
      view: !!v,
      cards: document.querySelectorAll('.fin-card').length,
      active: (document.querySelector('.fin-tab-on') || {}).textContent || '',
      text: v ? (v.textContent || '').replace(/\\s+/g, ' ').slice(0, 160) : ''
    };
  })()`);
}

app.whenReady().then(function () {
  const win = new BrowserWindow({
    show: false, width: 1360, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.webContents.on('console-message', function (_e, level, message) {
    if (level >= 2) errors.push(String(message).slice(0, 160));
  });
  win.loadFile(DIST);
  win.webContents.once('did-finish-load', function () {
    setTimeout(function () {
      clickButton(win, '账本').then(function (clicked) {
        if (!clicked) { console.log('FINANCE_UI ' + JSON.stringify({ ok: false, why: '顶栏没有账本按钮' })); app.exit(1); return; }
        let i = 0;
        function next() {
          if (i >= TABS.length) {
            const ok = results.length === 4
              && results.every(function (r) { return r.view && r.cards >= 1 && r.active.trim() === r.want; })
              && errors.length === 0;
            console.log('FINANCE_UI ' + JSON.stringify({ ok: ok, results: results, errors: errors }));
            app.exit(ok ? 0 : 1);
            return;
          }
          const want = TABS[i];
          clickButton(win, want).then(function () {
            setTimeout(function () {
              snapshot(win).then(function (snap) {
                snap.want = want;
                results.push(snap);
                i += 1;
                next();
              }).catch(function (e) { console.log('FINANCE_UI_ERROR ' + e.message); app.exit(1); });
            }, 350);
          }).catch(function (e) { console.log('FINANCE_UI_ERROR ' + e.message); app.exit(1); });
        }
        setTimeout(next, 600);
      }).catch(function (e) { console.log('FINANCE_UI_ERROR ' + e.message); app.exit(1); });
    }, 1000);
  });
});
