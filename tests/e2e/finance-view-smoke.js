'use strict';
// 独立账本窗口 DOM 冒烟：真实 Electron 窗口加载 Vite 第二入口 dist/finance.html，
// 验证左中右三栏都在，并逐个点开九个模块，确认每条 v-if/v-else-if 分支都渲染且控制台无错误。
// 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/e2e/finance-view-smoke.js
const path = require('path');
const { app, BrowserWindow } = require('electron');

const DIST = path.resolve(__dirname, '../../renderer-v2/dist/finance.html');
const TABS = [
  { label: '总览', pane: 'overview' },
  { label: '流水', pane: 'flow' },
  { label: '预算', pane: 'budget' },
  { label: '账户', pane: 'accounts' },
  { label: '报表', pane: 'reports' },
  { label: '储蓄目标', pane: 'goals' },
  { label: '周期与订阅', pane: 'recurring' },
  { label: '自动分类规则', pane: 'rules' },
  { label: 'CSV 导入', pane: 'import' }
];
const errors = [];
const results = [];

function js(win, code) { return win.webContents.executeJavaScript(code); }
function clickNav(win, label) {
  return js(win, `(function () {
    var b = Array.prototype.slice.call(document.querySelectorAll('.fw-nav-item'))
      .filter(function (x) { return (x.textContent || '').trim() === ${JSON.stringify(label)}; })[0];
    if (b) b.click();
    return !!b;
  })()`);
}
function snapshot(win, want) {
  return js(win, `(function () {
    var pane = document.querySelector('.fw-pane');
    return {
      left: !!document.querySelector('.fw-left'),
      main: !!document.querySelector('.fw-main'),
      right: !!document.querySelector('.fw-right'),
      pane: pane ? (pane.getAttribute('data-pane') || '') : '',
      cards: document.querySelectorAll('.fw-pane .fin-card').length,
      active: ((document.querySelector('.fw-nav-on') || {}).textContent || '').trim(),
      navCount: document.querySelectorAll('.fw-nav-item').length,
      // V3.1：与主窗同款的两条可拖栏边界、手记收支联动卡片、并入的梦想账户
      colDivider: document.querySelectorAll('.col-divider').length,
      moneyCard: !!document.querySelector('[data-card="money-link"]'),
      dreamTag: pane ? (pane.textContent || '').indexOf('梦想账户') >= 0 : false,
      text: pane ? (pane.textContent || '').replace(/\\s+/g, ' ').slice(0, 120) : ''
    };
  })()`).then(function (snap) {
    snap.want = want.label;
    snap.wantPane = want.pane;
    return snap;
  });
}

app.whenReady().then(function () {
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.webContents.on('console-message', function (_e, level, message) {
    if (level >= 2) errors.push(String(message).slice(0, 160));
  });
  win.loadFile(DIST);
  win.webContents.once('did-finish-load', function () {
    setTimeout(function () {
      let i = 0;
      function next() {
        if (i >= TABS.length) {
          const flow = results.filter(function (r) { return r.wantPane === 'flow'; })[0];
          const goalsPane = results.filter(function (r) { return r.wantPane === 'goals'; })[0];
          const linkOk = !!flow && flow.moneyCard && !!goalsPane && goalsPane.dreamTag;
          const dividerOk = results.every(function (r) { return r.colDivider === 2; });
          const ok = results.length === TABS.length
            && results.every(function (r) {
              return r.left && r.main && r.right && r.navCount === TABS.length
                && r.cards >= 1 && r.pane === r.wantPane && r.active === r.want;
            })
            && linkOk && dividerOk && errors.length === 0;
          console.log('FINANCE_UI ' + JSON.stringify({ ok: ok, linkOk: linkOk, dividerOk: dividerOk, results: results, errors: errors }));
          app.exit(ok ? 0 : 1);
          return;
        }
        const want = TABS[i];
        clickNav(win, want.label).then(function (clicked) {
          if (!clicked) { console.log('FINANCE_UI ' + JSON.stringify({ ok: false, why: '左栏缺少导航 ' + want.label })); app.exit(1); return; }
          setTimeout(function () {
            snapshot(win, want).then(function (snap) {
              results.push(snap);
              i += 1;
              next();
            }).catch(function (e) { console.log('FINANCE_UI_ERROR ' + e.message); app.exit(1); });
          }, 260);
        }).catch(function (e) { console.log('FINANCE_UI_ERROR ' + e.message); app.exit(1); });
      }
      next();
    }, 900);
  });
});
