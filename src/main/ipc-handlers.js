'use strict';
/**
 * IPC 通道注册（架构 §2.3 全量）：
 *  - 同步 S1–S9：ipcRenderer.sendSync ↔ ipcMain.on + event.returnValue，微信 *Sync 语义必须同步；
 *  - 异步 A1–A6：ipcRenderer.invoke ↔ ipcMain.handle；
 *  - 推送 P1–P4：主进程 webContents.send，由本类的 push() 统一出口。
 *
 * 通道名严格照登记清单，不新增任何未登记通道。返回统一 {ok:true} / {ok:false,error:CODE}。
 */
function getElectron() {
  try {
    return require('electron');
  } catch (e) {
    return null;
  }
}

class IpcHandlers {
  /**
   * @param {object} deps
   * @param {object} deps.kv KvStore 实例
   * @param {object} deps.windowState WindowState 实例
   * @param {object} deps.fileIo FileIo 实例
   * @param {string} deps.dataDir 数据目录
   * @param {Function} deps.getWindow 返回当前 BrowserWindow
   * @param {{onFlushDone?:Function, onConfirmExit?:Function}} [deps.callbacks]
   */
  constructor(deps) {
    const d = deps || {};
    this.kv = d.kv;
    this.windowState = d.windowState;
    this.fileIo = d.fileIo;
    this.dataDir = String(d.dataDir || '');
    this.getWindow = typeof d.getWindow === 'function' ? d.getWindow : function () { return null; };
    this.callbacks = d.callbacks || {};
    this.registered = false;
  }

  /** 主 → 渲染推送（P1 menu:action / P2 app:before-flush / P3 app:confirm-exit-request / P4 kv:quota-simulated）。 */
  push(channel, payload) {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return false;
    try {
      win.webContents.send(channel, payload);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 注册全部通道；重复调用安全。 */
  register() {
    if (this.registered) return { ok: true, already: true };
    const electron = getElectron();
    if (!electron || !electron.ipcMain) {
      return { ok: false, error: 'ipcMain 不可用：当前不是 Electron 主进程环境' };
    }
    const ipcMain = electron.ipcMain;
    const self = this;

    // ---------- A. 同步通道 S1–S9 ----------
    // 每个 handler 都必须给 event.returnValue 赋值，异常也不能漏（sendSync 会一直等）。
    const syncHandlers = {
      'kv:get': function (req) {
        return { ok: true, value: self.kv.get(req && req.key) };
      },
      'kv:set': function (req) {
        const r = self.kv.set(req && req.key, req && req.value);
        if (!r.ok && r.error === 'QUOTA_EXCEEDED') {
          // P4：仅测试用，由 JIUGE_KV_QUOTA 注入
          self.push('kv:quota-simulated', { limitBytes: r.limitBytes });
        }
        return r;
      },
      'kv:remove': function (req) {
        return self.kv.remove(req && req.key);
      },
      'kv:keys': function () {
        return { ok: true, keys: self.kv.keys() };
      },
      'kv:flush': function () {
        return self.kv.flush();
      },
      'clipboard:write': function (req) {
        try {
          const clip = electron.clipboard;
          if (!clip) throw new Error('clipboard 不可用');
          clip.writeText(String((req && req.text) || ''));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: 'CLIENT_EXCEPTION', message: String(e && e.message || e) };
        }
      },
      'clipboard:read': function () {
        try {
          const clip = electron.clipboard;
          if (!clip) throw new Error('clipboard 不可用');
          return { ok: true, text: clip.readText() };
        } catch (e) {
          return { ok: false, error: 'CLIENT_EXCEPTION', message: String(e && e.message || e) };
        }
      },
      'sys:windowBounds': function () {
        try {
          return { ok: true, bounds: self.windowState.read() };
        } catch (e) {
          return { ok: false, error: 'CLIENT_EXCEPTION', message: String(e && e.message || e) };
        }
      },
      'sys:userDataPath': function () {
        // 附带启动恢复提示：数据文件损坏 / 从 .bak 恢复必须明确告知，绝不静默（架构 §3.2）。
        return {
          ok: true,
          path: self.dataDir,
          notices: self.kv && Array.isArray(self.kv.notices) ? self.kv.notices.slice() : [],
        };
      },
    };

    Object.keys(syncHandlers).forEach(function (channel) {
      ipcMain.on(channel, function (event, req) {
        try {
          event.returnValue = syncHandlers[channel](req);
        } catch (e) {
          event.returnValue = { ok: false, error: 'CLIENT_EXCEPTION', message: String(e && e.message || e) };
        }
      });
    });

    // ---------- B. 异步通道 A1–A6 ----------
    ipcMain.handle('file:openBackup', async function () {
      try {
        return await self.fileIo.openBackup(self.getWindow());
      } catch (e) {
        return { canceled: false, error: '读取文件失败：' + String(e && e.message || e) };
      }
    });

    ipcMain.handle('file:saveExport', async function (_event, req) {
      try {
        return await self.fileIo.saveExport(self.getWindow(), req);
      } catch (e) {
        return { canceled: false, error: '写入文件失败：' + String(e && e.message || e) };
      }
    });

    ipcMain.handle('file:openDataDir', async function () {
      try {
        return self.fileIo.openDataDir();
      } catch (e) {
        return { ok: false, error: '打开数据目录失败：' + String(e && e.message || e) };
      }
    });

    ipcMain.handle('app:flush-done', async function (_event, req) {
      if (typeof self.callbacks.onFlushDone === 'function') {
        try { self.callbacks.onFlushDone(req || { ok: true, dirty: false }); } catch (e) { /* 不让回调异常卡住退出 */ }
      }
      return { ok: true };
    });

    ipcMain.handle('app:confirm-exit', async function (_event, req) {
      if (typeof self.callbacks.onConfirmExit === 'function') {
        try { self.callbacks.onConfirmExit(req || { proceed: true }); } catch (e) { /* 同上 */ }
      }
      return { ok: true };
    });

    // A6 theme:changed：本设计用自绘标题栏 + CSS 变量，默认不调用；登记在册以便将来接原生叠层。
    ipcMain.handle('theme:changed', async function (_event, req) {
      return { ok: true, id: req && req.id ? req.id : '' };
    });

    this.registered = true;
    return {
      ok: true,
      syncChannels: Object.keys(syncHandlers),
      asyncChannels: [
        'file:openBackup', 'file:saveExport', 'file:openDataDir',
        'app:flush-done', 'app:confirm-exit', 'theme:changed',
      ],
      pushChannels: [
        'menu:action', 'app:before-flush', 'app:confirm-exit-request', 'kv:quota-simulated',
      ],
    };
  }
}

module.exports = { IpcHandlers: IpcHandlers };
