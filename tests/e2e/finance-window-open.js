'use strict';
// 开窗链路端到端：真实主进程启动后，走 v1/finance:open 通道，
// 验证独立窗口真的被创建、加载 finance.html，且重复点只聚焦不叠窗。
// 用独立 userData，绝不碰真实日记。
// 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/e2e/finance-window-open.js
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.env.JIUGE_V2_USERDATA = path.join(os.tmpdir(), 'jiuge-finance-window-' + Date.now());
const errors = [];
process.on('uncaughtException', function (e) { errors.push(String(e && e.message)); });

require(path.resolve(__dirname, '../../src/main/main-v2.js'));

app.whenReady().then(function () {
  setTimeout(function () {
    if (!global.__jiugeApi) {
      console.log('FINANCE_OPEN ' + JSON.stringify({ ok: false, why: '主进程 API 未挂载' }));
      app.exit(1);
      return;
    }
    const before = BrowserWindow.getAllWindows().filter(function (w) { return !w.isDestroyed(); }).length;
    let first = null;
    try {
      first = global.__jiugeApi.handle('v1/finance:open', {});
    } catch (e) {
      console.log('FINANCE_OPEN ' + JSON.stringify({ ok: false, why: '开窗抛错: ' + e.message }));
      app.exit(1);
      return;
    }
    setTimeout(function () {
      const wins = BrowserWindow.getAllWindows().filter(function (w) { return !w.isDestroyed(); });
      const fw = wins.filter(function (w) {
        return (w.webContents.getURL() || '').indexOf('finance.html') >= 0;
      });
      let again = null;
      try { again = global.__jiugeApi.handle('v1/finance:open', {}); } catch (e) { again = null; }
      const after = BrowserWindow.getAllWindows().filter(function (w) { return !w.isDestroyed(); }).length;
      const ok = before >= 1 && first && first.code === 'OK'
        && fw.length === 1 && fw[0].getTitle().indexOf('家庭账本') >= 0
        && again && again.code === 'OK' && again.data.reused === true
        && after === wins.length && errors.length === 0;
      console.log('FINANCE_OPEN ' + JSON.stringify({
        ok: ok, mainWindows: before, afterOpen: wins.length,
        financeWindows: fw.length, title: fw[0] ? fw[0].getTitle() : '',
        url: fw[0] ? fw[0].webContents.getURL() : '',
        reusedOnSecondClick: again && again.data ? again.data.reused : null,
        afterSecondClick: after, errors: errors
      }));
      app.exit(ok ? 0 : 1);
    }, 2200);
  }, 2600);
});
