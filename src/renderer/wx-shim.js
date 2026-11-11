'use strict';
/**
 * 渲染进程第二份 window.wx（UI 版，架构 §1.3 / §9.1）。
 *
 * 供 5 个页面 JS 使用：showToast / showModal / showActionSheet /
 * setClipboardData / getClipboardData / navigateTo / switchTab /
 * createSelectorQuery / getSystemInfoSync 及 4 个 KV 转发。
 * 两份 polyfill 共享主进程同一份 KV 真源，不存在双写。
 *
 * 故意**不提供** setNavigationBarColor / setBackgroundColor / setTabBarStyle / setTabBarItem：
 * theme.js 在 preload 上下文中用 callApi() 逐个探测、缺失即静默跳过原生 chrome（桌面版要的行为）。
 *
 * window.require shim 把 '../../utils/xxx.js' 映射到 __jiuge 上的同名模块（页面 JS 零改动）。
 * getSystemInfoSync().windowWidth **固定返回 375**：ensureIntakeTrack() 的 unit = w/750 = 0.5
 * 必须与 rpx→px 的 1rpx=0.5px 一致，返回真实窗口宽会让滑杆档位算错（R2 红线）。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  'use strict';

  var J = G.__jiuge || {};

  function feedback() {
    return G.JiugeUiFeedback || {
      toast: function (o) { console.log('[toast] ' + ((o && o.title) || '')); },
      modal: function (o) { if (o && o.success) o.success({ confirm: false, cancel: true }); },
      actionSheet: function (o) { if (o && o.fail) o.fail({ errMsg: 'showActionSheet:fail cancel' }); },
    };
  }

  function nav() {
    return G.JiugeNav || {
      goByUrl: function (url) { console.log('[navigate] ' + url); },
    };
  }

  /** DOM 测量：createSelectorQuery().in(this).select(sel).boundingClientRect(cb).exec()。 */
  function makeSelectorQuery() {
    var q = {
      _page: null,
      _sel: '',
      _cb: null,
      _all: false,
      in: function (page) { q._page = page; return q; },
      select: function (sel) { q._sel = String(sel || ''); q._all = false; return q; },
      selectAll: function (sel) { q._sel = String(sel || ''); q._all = true; return q; },
      boundingClientRect: function (cb) { q._cb = typeof cb === 'function' ? cb : null; return q; },
      exec: function () {
        var rect = null;
        try {
          var el = document.querySelector(q._sel);
          if (el) {
            var r = el.getBoundingClientRect();
            rect = {
              id: el.id || '',
              dataset: Object.assign({}, el.dataset || {}),
              left: r.left, top: r.top, right: r.right, bottom: r.bottom,
              width: r.width, height: r.height,
            };
          }
        } catch (e) {
          rect = null;
        }
        if (q._cb) {
          try { q._cb(rect); } catch (e) { console.error('[createSelectorQuery] 回调异常：' + e.message); }
        }
        return q;
      },
    };
    return q;
  }

  function kvGet(key) {
    try { return J.kv ? J.kv.get(key) : ''; } catch (e) { return ''; }
  }
  function kvSet(key, value) {
    if (!J.kv) throw new Error('wx.setStorageSync client exception: bridge unavailable for key ' + key);
    return J.kv.set(key, value);
  }
  function kvRemove(key) {
    try { return J.kv ? J.kv.remove(key) : null; } catch (e) { return null; }
  }
  function kvKeys() {
    try {
      var k = J.kv ? J.kv.keys() : [];
      return Array.isArray(k) ? k : [];
    } catch (e) {
      return [];
    }
  }

  var wx = {
    // ---------- UI 反馈（文案逐字取自源码实参，本层不改一个字） ----------
    showToast: function (opt) { feedback().toast(opt || {}); },
    showModal: function (opt) { feedback().modal(opt || {}); },
    showActionSheet: function (opt) { feedback().actionSheet(opt || {}); },

    // ---------- 剪贴板（主进程 / IPC，渲染进程不碰 clipboard 原生对象） ----------
    setClipboardData: function (opt) {
      var o = opt || {};
      var r = J.clipboard ? J.clipboard.write({ text: String(o.data === undefined ? '' : o.data) }) : { ok: false };
      if (!r || !r.ok) {
        if (typeof o.fail === 'function') o.fail({ errMsg: 'setClipboardData:fail' });
        return;
      }
      if (typeof o.success === 'function') o.success({});
      if (typeof o.complete === 'function') o.complete({});
    },
    getClipboardData: function (opt) {
      var o = opt || {};
      var r = J.clipboard ? J.clipboard.read() : { ok: false, text: '' };
      if (!r || !r.ok) {
        if (typeof o.fail === 'function') o.fail({ errMsg: 'getClipboardData:fail' });
        return;
      }
      if (typeof o.success === 'function') o.success({ data: r.text || '' });
      if (typeof o.complete === 'function') o.complete({});
    },

    // ---------- 导航（单窗口 5 视图切换，不新开 BrowserWindow） ----------
    navigateTo: function (opt) { nav().goByUrl((opt && opt.url) || ''); },
    switchTab: function (opt) { nav().goByUrl((opt && opt.url) || ''); },
    navigateBack: function () { if (nav().back) nav().back(); },

    // ---------- 测量与系统信息 ----------
    createSelectorQuery: makeSelectorQuery,
    getSystemInfoSync: function () {
      // 375 是小程序设计基准宽；禁止返回真实窗口宽（R2 / §9.6-10）
      return {
        windowWidth: 375,
        windowHeight: 667,
        screenWidth: 375,
        screenHeight: 667,
        pixelRatio: 1,
        platform: 'windows',
        system: 'Windows',
        language: 'zh_CN',
        SDKVersion: 'desktop',
      };
    },

    // ---------- 同步 KV 转发（微信 *Sync 语义必须同步） ----------
    getStorageSync: kvGet,
    setStorageSync: kvSet,
    removeStorageSync: kvRemove,
    getStorageInfoSync: function () {
      return { keys: kvKeys(), currentSize: 0, limitSize: 0 };
    },
  };

  G.wx = wx;

  // ---------- window.require shim：把页面 JS 的 '../../utils/xxx.js' 映射到 __jiuge ----------
  var MODULE_MAP = {
    'diary-store': J.store,
    'theme': J.theme,
    'quotes': J.quotes,
    'greetings': J.greetings,
    'cell-insights': J.cellInsights,
    'work-board': J.workBoard,
    'money-book': J.moneyBook,
    'study-log': J.studyLog,
  };

  G.require = function (id) {
    var raw = String(id || '').replace(/\\/g, '/');
    var base = raw.split('/').pop().replace(/\.js$/, '');
    if (Object.prototype.hasOwnProperty.call(MODULE_MAP, base)) return MODULE_MAP[base];
    console.warn('[require shim] 未登记的模块：' + raw);
    return {};
  };

  return { wx: wx, MODULE_MAP: MODULE_MAP, makeSelectorQuery: makeSelectorQuery };
});
