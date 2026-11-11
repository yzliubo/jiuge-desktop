'use strict';
/**
 * 小程序页面兼容运行时（架构 §1.4 / §9.1）。
 *
 *  - App()/getApp()：内存 AppState { backfillDate:'', reviewTab:null }，不落盘、消费一次即清；
 *  - Page()：注册 5 个常驻实例（单窗口视图切换），getCurrentPages() 一一对应换肤广播；
 *  - setData(patch)：合并进 data 后调用 WxmlRuntime 的**节点级 diff**，绝不整页重建；
 *  - 生命周期 onLoad / onShow / onHide / onUnload 由本层与 nav.js / flush.js 转发；
 *  - 页面 JS 由 bootstrap() 动态加载（script 元素带 data-page-id，用 document.currentScript 精确识别），
 *    T1 尚无页面 JS 时注册占位实例，保证窗口、导航、换肤、退出 flush 链路全部可用；
 *    T2/T3/T4 落下页面 JS 与 views/*.wxml 后自动接管，运行时无需改动。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  'use strict';

  var APP = G.JiugeAppState;
  var WXML = G.JiugeWxmlRuntime;
  var J = G.__jiuge || {};
  var PAGE_IDS = ['index', 'review', 'capsule', 'habit', 'settings'];

  // 占位视图标题逐字取自 PRD §11.4（源项目页面 navigationBarTitleText）
  var PLACEHOLDER_TITLE = {
    index: '今日 · 九格手记',
    review: '回看',
    capsule: '写给未来的自己',
    habit: '坚持 · 记录习惯',
    settings: '设置 · 九格手记',
  };

  var pages = [];
  var byId = {};
  var booted = false;

  function setDeep(obj, path, value) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i += 1) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function cloneData(data) {
    try {
      return JSON.parse(JSON.stringify(data || {}));
    } catch (e) {
      return Object.assign({}, data || {});
    }
  }

  function currentPageId() {
    // 独立作用域执行时 document.currentScript 不可用，由 bootstrap 显式指定当前页 id
    if (G.__jiugeCurrentPageId) return G.__jiugeCurrentPageId;
    try {
      var cs = document.currentScript;
      if (cs && cs.getAttribute) {
        var id = cs.getAttribute('data-page-id');
        if (id) return id;
      }
    } catch (e) { /* 回落 */ }
    return G.__pendingPageId || '';
  }

  function placeholderWxml(id) {
    return '<view class="page"><text class="page-title">'
      + WXML.escapeHtml(PLACEHOLDER_TITLE[id] || '') + '</text></view>';
  }

  function sectionFor(id) {
    if (typeof document === 'undefined') return null;
    return document.querySelector('section.page[data-page="' + id + '"]');
  }

  /** 创建 Page 实例；options 里的方法原样挂到实例上（页面 JS 零改动）。 */
  function makePage(id, options) {
    var opt = options || {};
    var inst = {
      pageId: id,
      data: cloneData(opt.data),
      _view: null,
      _loaded: false,
      _shown: false,
    };
    Object.keys(opt).forEach(function (k) {
      if (k !== 'data') inst[k] = opt[k];
    });

    // setData 必须在拷贝 options 之后强制重设，防止被页面对象覆盖
    inst.setData = function (patch, callback) {
      var p = patch || {};
      Object.keys(p).forEach(function (k) {
        if (k.indexOf('.') >= 0) setDeep(inst.data, k, p[k]);
        else inst.data[k] = p[k];
      });
      if (inst._view && typeof inst._view.update === 'function') inst._view.update();
      if (typeof callback === 'function') {
        try { callback(); } catch (e) { console.error('[setData 回调异常] ' + e.message); }
      }
    };

    if (typeof inst.applyTheme !== 'function') {
      // 占位页也要能响应 settings.js 的换肤广播（幂等，跳过自身由调用方判断）
      inst.applyTheme = function () {};
    }
    if (typeof inst.onLoad !== 'function') inst.onLoad = function () {};
    if (typeof inst.onShow !== 'function') inst.onShow = function () {};
    if (typeof inst.onHide !== 'function') inst.onHide = function () {};
    if (typeof inst.onUnload !== 'function') inst.onUnload = function () {};
    return inst;
  }

  function mountPage(inst) {
    var section = sectionFor(inst.pageId);
    if (!section || typeof WXML === 'undefined') return;
    var text = '';
    try {
      text = J.sys && typeof J.sys.readView === 'function' ? J.sys.readView(inst.pageId) : '';
    } catch (e) {
      text = '';
    }
    if (!text) {
      text = placeholderWxml(inst.pageId);
      console.log('[页面运行时] ' + inst.pageId + ' 尚无 WXML，使用占位视图（T2/T3/T4 交付后自动接管）');
    }
    try {
      inst._view = WXML.mount(inst, text, section);
    } catch (e) {
      console.error('[页面运行时] ' + inst.pageId + ' 模板挂载失败：' + String(e && e.stack || e));
      inst._view = null;
    }
  }

  function registerPage(id, options) {
    if (byId[id]) {
      console.warn('[页面运行时] 重复注册 Page：' + id);
      return byId[id];
    }
    var inst = makePage(id, options);
    byId[id] = inst;
    pages.push(inst);
    mountPage(inst);
    try {
      inst.onLoad({});
      inst._loaded = true;
    } catch (e) {
      console.error('[页面运行时] ' + id + '.onLoad 异常：' + String(e && e.stack || e));
    }
    return inst;
  }

  /** 小程序 Page() 全局：由页面 JS 调用，id 由 script 的 data-page-id 决定。 */
  function Page(options) {
    var id = currentPageId();
    if (!id) {
      console.error('[页面运行时] Page() 无法确定页面 id（缺少 data-page-id / __pendingPageId）');
      return null;
    }
    return registerPage(id, options);
  }

  /** 小程序 App() 全局：桌面版只保留 onLaunch 写开始日的语义。 */
  function App(options) {
    var opt = options || {};
    if (APP && typeof APP.onLaunch === 'function') APP.onLaunch(G.wx);
    if (typeof opt.onLaunch === 'function') {
      try { opt.onLaunch({}); } catch (e) { console.error('[App.onLaunch 异常] ' + e.message); }
    }
    return getApp();
  }

  function getApp() {
    return APP ? APP.getApp() : { globalData: { backfillDate: '', reviewTab: null } };
  }

  function getCurrentPages() {
    return pages.slice();
  }

  /** 加载并执行一个页面 JS；返回 Promise（失败也 resolve，由占位实例兜底）。 */
  function loadPageScript(id) {
    return new Promise(function (resolve) {
      if (typeof document === 'undefined') { resolve(false); return; }
      var source = '';
      try {
        source = J.sys && typeof J.sys.readPageScript === 'function' ? J.sys.readPageScript(id) : '';
      } catch (e) {
        source = '';
      }
      if (!source) {
        // 回落：读不到源码时用 <script> 标签（单页 / 降级场景）
        var script = document.createElement('script');
        script.src = '../pages/' + id + '/' + id + '.js';
        script.setAttribute('data-page-id', id);
        script.onload = function () { resolve(true); };
        script.onerror = function () {
          console.warn('[页面运行时] 页面 JS 加载失败：' + id);
          resolve(false);
        };
        document.body.appendChild(script);
        return;
      }
      try {
        // 每页一个独立函数作用域：顶层 const/let 留在局部，5 个页面互不冲突，
        // 同时仍能访问 window.require / Page / getApp 等全局（等价小程序模块作用域）。
        G.__jiugeCurrentPageId = id;
        (new Function(source))();
        resolve(true);
      } catch (e) {
        console.error('[页面运行时] 页面 JS 执行失败：' + id + ' → ' + String(e && e.stack || e));
        resolve(false);
      } finally {
        G.__jiugeCurrentPageId = null;
      }
    });
  }

  /** 串行加载，保证 document.currentScript 精确对应页面 id。 */
  function loadAllExisting(ids) {
    return ids.reduce(function (chain, id) {
      return chain.then(function () { return loadPageScript(id); });
    }, Promise.resolve());
  }

  function showStartupNotices() {
    try {
      var info = J.sys && J.sys.userDataPath ? J.sys.userDataPath() : null;
      var notices = info && Array.isArray(info.notices) ? info.notices : [];
      if (!notices.length) return;
      notices.forEach(function (n) {
        console.warn('[启动提示] ' + n);
        if (G.wx && typeof G.wx.showToast === 'function') {
          G.wx.showToast({ title: n, icon: 'none', duration: 5000 });
        }
      });
    } catch (e) { /* 提示失败不影响启动 */ }
  }

  function bootstrap() {
    if (booted) return Promise.resolve({ ok: true, already: true });
    booted = true;

    // R9：启动自检，缺任一全局即在控制台明确报错
    var missing = WXML && typeof WXML.selfCheck === 'function' ? WXML.selfCheck(G) : [];
    if (missing.length) {
      console.error('[页面运行时] 缺少全局：' + missing.join(','));
      if (G.wx && G.wx.showToast) {
        G.wx.showToast({ title: '运行时未就绪：' + missing.join(','), icon: 'none' });
      }
    }

    if (APP && typeof APP.onLaunch === 'function') APP.onLaunch(G.wx);

    var existing = [];
    try {
      existing = J.sys && typeof J.sys.listPages === 'function' ? J.sys.listPages() : [];
      if (!Array.isArray(existing)) existing = [];
    } catch (e) {
      existing = [];
    }
    existing = PAGE_IDS.filter(function (id) { return existing.indexOf(id) >= 0; });
    console.log('[页面运行时] 已落盘页面 JS：' + (existing.length ? existing.join(',') : '（无，全部占位）'));

    return loadAllExisting(existing).then(function () {
      // 未落盘的页注册占位实例；按 PAGE_IDS 固定页面栈顺序
      PAGE_IDS.forEach(function (id) {
        if (!byId[id]) registerPage(id, { data: {}, applyTheme: function () {} });
      });
      pages = PAGE_IDS.map(function (id) { return byId[id]; }).filter(Boolean);

      if (G.JiugeThemeCss && typeof G.JiugeThemeCss.apply === 'function') {
        G.JiugeThemeCss.apply();
      }
      if (G.JiugeNav && typeof G.JiugeNav.go === 'function') {
        G.JiugeNav.go('index');
      }
      showStartupNotices();
      console.log('[页面运行时] 启动完成：5 个常驻 Page 实例，冷启动落在「今日」');
      return { ok: true, pages: pages.length, loadedScripts: existing.length };
    });
  }

  var api = {
    App: App,
    Page: Page,
    getApp: getApp,
    getCurrentPages: getCurrentPages,
    bootstrap: bootstrap,
    registerPage: registerPage,
    mountPage: mountPage,
    pages: function () { return pages.slice(); },
    byId: function (id) { return byId[id] || null; },
    PAGE_IDS: PAGE_IDS,
    PLACEHOLDER_TITLE: PLACEHOLDER_TITLE,
  };

  // 全局命名空间只挂架构 §9.1 允许的 6 个 + __jiuge / JiugeRuntime
  G.Page = Page;
  G.App = App;
  G.getApp = getApp;
  G.getCurrentPages = getCurrentPages;

  return api;
});
