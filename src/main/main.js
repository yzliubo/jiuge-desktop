'use strict';
/**
 * 九格手记 Windows 桌面版 · 主进程入口。
 *
 * 职责（架构 §2 / §6.2 / T1-A1）：
 *  - app.whenReady → 加载 KV 真源、窗口状态 → 建单窗口（1280×800 / min 1024×680 / 记忆 bounds）；
 *  - 安全配置 contextIsolation:true / nodeIntegration:false / sandbox:false / webSecurity:true；
 *  - 拦截 will-navigate、setWindowOpenHandler deny，只加载本地 file:// index.html，不加载任何远程内容；
 *  - 菜单与快捷键、5 项侧栏由渲染进程负责，主进程只发 menu:action；
 *  - 关窗拦截：app:confirm-exit-request → app:confirm-exit → app:before-flush →
 *    app:flush-done → kv:flush → win.destroy() → app.quit()，3 秒未收到回执则主进程自行 flush 后退出。
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { createKvStore } = require('./kv-store.js');
const { WindowState, DEFAULT_BOUNDS, MIN_WIDTH, MIN_HEIGHT } = require('./window-state.js');
const { FileIo } = require('./file-io.js');
const { IpcHandlers } = require('./ipc-handlers.js');
const { buildMenu } = require('./menu.js');

const FLUSH_TIMEOUT_MS = 3000;
const BACKGROUND_COLOR = '#F6F8F3'; // THEMES.standard.window.backgroundColor，逐字照搬

let win = null;
let kv = null;
let windowState = null;
let ipc = null;
let closing = false;
let quitFinished = false;
let fallbackTimer = null;

function dataDirOf() {
  return path.join(app.getPath('userData'), 'jiuge-desktop');
}

function createWindow() {
  const saved = windowState.read();
  const options = {
    width: saved.width || DEFAULT_BOUNDS.width,
    height: saved.height || DEFAULT_BOUNDS.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    title: '今日 · 九格手记',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,   // 渲染进程与 preload 隔离
      nodeIntegration: false,   // 渲染进程无 Node
      sandbox: false,           // 必须为 false：preload 需 require 本地 CommonJS 与 sendSync
      webSecurity: true,
      spellcheck: false,
      nodeIntegrationInWorker: false,
    },
  };
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    options.x = saved.x;
    options.y = saved.y;
  }
  win = new BrowserWindow(options);

  win.once('ready-to-show', function () {
    if (!win.isDestroyed()) win.show();
  });

  // 禁用一切外部导航与新窗口：纯本地零网络底线
  win.webContents.on('will-navigate', function (event) {
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(function () {
    return { action: 'deny' };
  });

  win.on('resized', function () {
    if (!win.isDestroyed()) windowState.scheduleWrite(win.getBounds());
  });
  win.on('moved', function () {
    if (!win.isDestroyed()) windowState.scheduleWrite(win.getBounds());
  });

  win.on('closed', function () {
    win = null;
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

/** 关窗链路终点：kv:flush → 记录窗口 → destroy → quit。绝不静默丢稿。 */
function finishQuit(reason) {
  if (quitFinished) return;
  quitFinished = true;
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  if (kv) {
    const r = kv.flush();
    console.log('[退出链路] kv:flush → ' + (r.ok ? r.bytes + ' 字节' : r.error));
  }
  if (win && !win.isDestroyed()) {
    try { windowState.writeNow(win.getBounds()); } catch (e) { /* 记录失败不阻断退出 */ }
  }
  console.log('[退出链路] quit（来源：' + reason + '）');
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
}

function installCloseInterceptor() {
  if (!win) return;
  win.on('close', function (event) {
    if (quitFinished) return;
    if (closing) {
      // 一次性标志，防止 confirm / flush 期间重复触发
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closing = true;
    console.log('[退出链路] close 拦截：e.preventDefault()，记录窗口 bounds');
    try { windowState.writeNow(win.getBounds()); } catch (e) { /* 不阻断 */ }

    // 3 秒兜底：渲染进程没回 flush-done 时，主进程自行 kv:flush 后再退出
    fallbackTimer = setTimeout(function () {
      console.log('[退出链路] 3 秒兜底：未收到 flush-done，主进程自行落盘');
      finishQuit('timeout');
    }, FLUSH_TIMEOUT_MS);

    // P1：有未保存输入时请渲染进程弹二次确认（dirty 由渲染进程自己判断）
    console.log('[退出链路] → app:confirm-exit-request');
    ipc.push('app:confirm-exit-request', { dirty: false });
  });
}

function boot() {
  const dataDir = dataDirOf();
  kv = createKvStore(dataDir);
  if (kv.notices.length) {
    kv.notices.forEach(function (n) { console.warn('[启动提示] ' + n); });
  }
  windowState = new WindowState(dataDir);
  const fileIo = new FileIo(dataDir, kv);

  ipc = new IpcHandlers({
    kv: kv,
    windowState: windowState,
    fileIo: fileIo,
    dataDir: dataDir,
    getWindow: function () { return win; },
    callbacks: {
      onConfirmExit: function (payload) {
        if (!closing || quitFinished) return;
        const proceed = !!(payload && payload.proceed);
        if (!proceed) {
          console.log('[退出链路] app:confirm-exit{proceed:false} → 中止关闭');
          closing = false;
          if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
          return;
        }
        console.log('[退出链路] app:confirm-exit{proceed:true} → app:before-flush');
        ipc.push('app:before-flush', { reason: 'close' });
      },
      onFlushDone: function (payload) {
        if (!closing || quitFinished) return;
        console.log('[退出链路] app:flush-done{ok:' + !!(payload && payload.ok) + '} → kv:flush → quit');
        finishQuit('flush-done');
      },
    },
  });

  const registered = ipc.register();
  if (!registered.ok) {
    console.error('[启动失败] IPC 通道注册失败：' + registered.error);
  } else {
    console.log('[启动] 同步通道 ' + registered.syncChannels.length + ' 条 / 异步通道 '
      + registered.asyncChannels.length + ' 条 / 推送通道 ' + registered.pushChannels.length + ' 条');
  }

  createWindow();
  installCloseInterceptor();

  buildMenu(function (action) {
    console.log('[菜单] menu:action → ' + action);
    ipc.push('menu:action', { action: action });
  }, function () { return win; });

  // 验收专用渲染探针：仅显式设置 JIUGE_TEST_PROBE=1 / JIUGE_TEST_READBACK=1 时注入，
  // 结果直接打印到主进程日志；不新增 IPC 通道、不引入任何网络能力、生产默认关闭。
  const probeMode = process.env.JIUGE_TEST_PROBE === '1';
  const readbackMode = process.env.JIUGE_TEST_READBACK === '1';
  if ((probeMode || readbackMode) && win) {
    setTimeout(function () {
      if (!win || win.isDestroyed()) return;
      let probes = null;
      try {
        probes = require('../../tools/renderer-probe.js');
      } catch (e) {
        console.error('[渲染探针] 加载失败：' + String(e && e.message || e));
        return;
      }
      let code;
      if (probeMode) {
        // 依次执行 T2 / T3 / T4 三段探针并合并结果（未落盘批次会自行跳过）
        const fns = [probes.probe, probes.probe3, probes.probe4];
        code = '(function(){var out={checks:[]};'
          + fns.map(function (f) {
            return 'var r=(' + f.toString() + ')();out.checks=out.checks.concat(r.checks||[]);';
          }).join('')
          + 'return out;})()';
      } else {
        code = '(' + probes.readback.toString() + ')()';
      }
      win.webContents.executeJavaScript(code).then(function (res) {
        const checks = res && Array.isArray(res.checks) ? res.checks : [];
        const failed = checks.filter(function (c) { return !c.ok; });
        checks.forEach(function (c) {
          console.log((c.ok ? '[渲染探针 PASS] ' : '[渲染探针 FAIL] ') + c.name + ' → ' + c.detail);
        });
        console.log('[渲染探针] 合计 ' + checks.length + ' 项，失败 ' + failed.length + ' 项');
      }).catch(function (e) {
        console.error('[渲染探针] 执行失败：' + String(e && e.message || e));
      });
    }, 1800);
  }

  // 仅用于无 GUI 的自动化验收：显式设置 JIUGE_TEST_CLOSE_MS 后，窗口显示 N 毫秒自动走
  // win.close() → 完整 flush 链路 → 退出。生产环境不设置该变量，行为完全不变。
  const testCloseMs = Number(process.env.JIUGE_TEST_CLOSE_MS);
  if (isFinite(testCloseMs) && testCloseMs > 0 && win) {
    setTimeout(function () {
      console.log('[测试钩子] 自动触发 win.close()，验证关窗 flush 链路');
      if (win && !win.isDestroyed()) win.close();
    }, testCloseMs);
  }
}

app.whenReady().then(function () {
  boot();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0 && !quitFinished) {
      createWindow();
      installCloseInterceptor();
    }
  });
});

app.on('window-all-closed', function () {
  if (windowState) windowState.dispose();
  if (kv) kv.dispose();
  app.quit();
});

module.exports = {
  dataDirOf: dataDirOf,
  BACKGROUND_COLOR: BACKGROUND_COLOR,
  FLUSH_TIMEOUT_MS: FLUSH_TIMEOUT_MS,
};
