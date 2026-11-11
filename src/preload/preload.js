'use strict';
/**
 * Preload：全局 wx polyfill 注入 → require 8 个零改动 utils → contextBridge 暴露 __jiuge。
 *
 * 顺序是硬约束（架构 §1.3 / §9.1）：
 *   1) global.wx = kvPolyfill  **必须先于**任何 require('../utils/...')；
 *      Node CommonJS 模块的自由变量 wx 天然解析到 global.wx，因此 8 个模块全部零改动。
 *   2) polyfill 故意不提供 setNavigationBarColor / setTabBarStyle / setTabBarItem 等原生 chrome API，
 *      theme.js 的 callApi() 用 typeof wx[name] === 'function' 探测后自动静默跳过 —— 正是桌面版要的行为。
 *   3) contextBridge 只暴露函数与纯 JSON 可克隆值，不暴露 require / fs / ipcRenderer / net。
 *
 * 安全配置由 main.js 提供：contextIsolation:true / nodeIntegration:false / sandbox:false。
 */
const fs = require('fs');
const path = require('path');
const { contextBridge, ipcRenderer } = require('electron');

function sendSync(channel, req) {
  try {
    const r = ipcRenderer.sendSync(channel, req || {});
    return r && typeof r === 'object' ? r : { ok: false, error: 'CLIENT_EXCEPTION' };
  } catch (e) {
    return { ok: false, error: 'CLIENT_EXCEPTION', message: String(e && e.message || e) };
  }
}

/** 主 → 渲染推送的标准回调订阅（contextBridge 官方支持的回调参数形式），不返回函数。 */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return { ok: false };
  const listener = function (_event, payload) {
    try {
      callback(payload);
    } catch (e) {
      console.error('[preload] ' + channel + ' 回调异常：' + String(e && e.message || e));
    }
  };
  ipcRenderer.on(channel, listener);
  return { ok: true };
}

// ==========================================================================
// 1. 先注入 global.wx（KV polyfill，供 diary-store.js / theme.js 使用）
// ==========================================================================
const kvPolyfill = {
  /** 对齐 wx.getStorageSync：未命中返回 ''（不是 undefined / null）。 */
  getStorageSync: function (key) {
    const r = sendSync('kv:get', { key: key });
    if (!r.ok) return '';
    return r.value === undefined || r.value === null ? '' : r.value;
  },
  /**
   * 对齐 wx.setStorageSync。失败必须 throw：
   *  - QUOTA_EXCEEDED → message 含 exceed / quota / size / limit，
   *    diary-store.js 的 write() 靠 /exceed|quota|size|limit/i 判定为 'QUOTA_EXCEEDED'；
   *  - 其它异常 → message 不含上述关键字，write() 返回 false → 上层得到 CLIENT_EXCEPTION。
   */
  setStorageSync: function (key, value) {
    const r = sendSync('kv:set', { key: key, value: value });
    if (r.ok) return;
    if (r.error === 'QUOTA_EXCEEDED') {
      throw new Error('wx.setStorageSync failed: exceed quota size limit of '
        + r.limitBytes + ' bytes (current ' + r.sizeBytes + ') for key ' + key);
    }
    throw new Error('wx.setStorageSync client exception: ' + (r.error || 'CLIENT_EXCEPTION')
      + ' for key ' + key);
  },
  removeStorageSync: function (key) {
    sendSync('kv:remove', { key: key });
  },
  /** 对齐 wx.getStorageInfoSync：keys 必须同步返回，供 listDates() / readReviewMap() 扫前缀。 */
  getStorageInfoSync: function () {
    const r = sendSync('kv:keys');
    return {
      keys: r.ok && Array.isArray(r.keys) ? r.keys : [],
      currentSize: 0,
      limitSize: 0,
    };
  },
};

global.wx = kvPolyfill;

// ==========================================================================
// 2. require 8 个 utils（内部 require('./work-board.js') 由 Node 解析，零改动）
// ==========================================================================
const store = require('../utils/diary-store.js');
const theme = require('../utils/theme.js');
const quotes = require('../utils/quotes.js');
const greetings = require('../utils/greetings.js');
const cellInsights = require('../utils/cell-insights.js');
const workBoard = require('../utils/work-board.js');
const moneyBook = require('../utils/money-book.js');
const studyLog = require('../utils/study-log.js');

// ==========================================================================
// 3. 受控桥接对象（渲染进程只拿到函数与纯 JSON）
// ==========================================================================
const kv = {
  get: function (key) { return kvPolyfill.getStorageSync(key); },
  set: function (key, value) { return kvPolyfill.setStorageSync(key, value); },
  remove: function (key) { return kvPolyfill.removeStorageSync(key); },
  keys: function () { return kvPolyfill.getStorageInfoSync().keys; },
  flush: function () { return sendSync('kv:flush'); },
};

const dialog = {
  openBackup: function () { return ipcRenderer.invoke('file:openBackup'); },
  saveExport: function (req) { return ipcRenderer.invoke('file:saveExport', req); },
  openDataDir: function () { return ipcRenderer.invoke('file:openDataDir'); },
};

const clipboard = {
  write: function (req) { return sendSync('clipboard:write', { text: (req && req.text) || '' }); },
  read: function () { return sendSync('clipboard:read'); },
};

/** 只读视图模板：让渲染进程能拿到 WXML 文本，无需新增 IPC 通道、无需 fetch/XHR。 */
const PAGES_DIR = path.join(__dirname, '..', 'pages');
const VIEWS_DIR = path.join(__dirname, '..', 'views');
const PAGE_IDS = ['index', 'review', 'capsule', 'habit', 'settings'];

const sys = {
  windowBounds: function () { return sendSync('sys:windowBounds'); },
  /** 设置页只读展示数据目录；附带启动恢复提示（数据损坏 / 从 .bak 恢复，绝不静默）。 */
  userDataPath: function () { return sendSync('sys:userDataPath'); },
  /** 返回已落盘的页面 JS id 数组；T1 尚无页面 JS 时返回 []，运行时用占位实例。 */
  listPages: function () {
    return PAGE_IDS.filter(function (id) {
      try { return fs.existsSync(path.join(PAGES_DIR, id, id + '.js')); }
      catch (e) { return false; }
    });
  },
  /** 返回 WXML 原文（不存在返回 ''），渲染进程交给 WxmlRuntime.compile()。 */
  readView: function (pageId) {
    if (PAGE_IDS.indexOf(pageId) < 0) return '';
    try {
      return fs.readFileSync(path.join(VIEWS_DIR, pageId + '.wxml'), 'utf8');
    } catch (e) {
      return '';
    }
  },
  /**
   * 返回页面 JS 源码文本（纯字符串）。渲染进程用独立函数作用域执行每个页面，
   * 避免 5 个页面 JS 的顶层 const 在全局词法环境重复声明（小程序每页本就是独立模块）。
   * 不暴露 fs、不新增 IPC 通道、不改写源码一个字节。
   */
  readPageScript: function (pageId) {
    if (PAGE_IDS.indexOf(pageId) < 0) return '';
    try {
      return fs.readFileSync(path.join(PAGES_DIR, pageId, pageId + '.js'), 'utf8');
    } catch (e) {
      return '';
    }
  },
};

const menu = {
  onAction: function (cb) { return subscribe('menu:action', cb); },
};

const flush = {
  done: function (payload) {
    return ipcRenderer.invoke('app:flush-done', payload || { ok: true, dirty: false });
  },
  confirmExit: function (payload) {
    return ipcRenderer.invoke('app:confirm-exit', payload || { proceed: true });
  },
  onBeforeFlush: function (cb) { return subscribe('app:before-flush', cb); },
  onConfirmExitRequest: function (cb) { return subscribe('app:confirm-exit-request', cb); },
  onQuotaSimulated: function (cb) { return subscribe('kv:quota-simulated', cb); },
};

contextBridge.exposeInMainWorld('__jiuge', {
  store: store,
  theme: theme,
  quotes: quotes,
  greetings: greetings,
  workBoard: workBoard,
  moneyBook: moneyBook,
  studyLog: studyLog,
  cellInsights: cellInsights,
  kv: kv,
  dialog: dialog,
  clipboard: clipboard,
  sys: sys,
  menu: menu,
  flush: flush,
});
