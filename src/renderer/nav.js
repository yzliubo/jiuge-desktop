'use strict';
/**
 * 桌面外壳导航（架构 §1.4 / §2.4 / Q7）。
 *
 *  - 左侧 5 项常驻竖栏 + 单窗口 5 视图切换：section[hidden] 切换 + 旧页 onHide() / 目标页 onShow()；
 *  - URL→pageId 映射，使源码 wx.switchTab({url:'/pages/review/review'}) 与 navigateTo 零改动生效；
 *  - 跨页参数直传：go(pageId, {backfillDate, reviewTab}) 写内存 AppState，由目标页 onShow 消费一次；
 *  - 菜单/快捷键动作单点分发，主题动作走 theme-css.change()，其余交给 desktop-features。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeNav = api;
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  'use strict';

  var J = G.__jiuge || {};
  var PAGE_IDS = ['index', 'review', 'capsule', 'habit', 'settings'];

  // 逐字取自 PRD §11.4（源项目页面 navigationBarTitleText），仅用于标题栏回显
  var TITLE = {
    index: '今日 · 九格手记',
    review: '回看',
    capsule: '写给未来的自己',
    habit: '坚持 · 记录习惯',
    settings: '设置 · 九格手记',
  };

  var URL_TO_PAGE = {
    '/pages/index/index': 'index',
    '/pages/review/review': 'review',
    '/pages/capsule/capsule': 'capsule',
    '/pages/habit/habit': 'habit',
    '/pages/settings/settings': 'settings',
  };

  var current = null;
  var history = [];

  function runtime() { return G.JiugeRuntime || null; }
  function sectionOf(id) {
    if (typeof document === 'undefined') return null;
    return document.querySelector('section.page[data-page="' + id + '"]');
  }

  function pageIdFromUrl(url) {
    var u = String(url || '').split('?')[0];
    if (URL_TO_PAGE[u]) return URL_TO_PAGE[u];
    var m = /pages\/([^/]+)\//.exec(u);
    if (m && PAGE_IDS.indexOf(m[1]) >= 0) return m[1];
    return PAGE_IDS[0];
  }

  /**
   * 切换视图。
   * @param {string} pageId index|review|capsule|habit|settings
   * @param {{backfillDate?:string, reviewTab?:number}} [params] 应用内状态直传
   */
  function go(pageId, params) {
    if (PAGE_IDS.indexOf(pageId) < 0) {
      console.warn('[导航] 未知页面：' + pageId);
      return false;
    }
    var rt = runtime();

    // Q2：跨页带参改为内存 AppState 直传，页面 JS 的 4 处 getApp() 零改动即完成
    if (params && typeof params === 'object' && typeof G.getApp === 'function') {
      var app = G.getApp();
      if (app && app.globalData) {
        if (params.backfillDate !== undefined) app.globalData.backfillDate = params.backfillDate;
        if (params.reviewTab !== undefined) app.globalData.reviewTab = params.reviewTab;
      }
    }

    if (current && current !== pageId && rt) {
      var prev = rt.byId(current);
      if (prev && typeof prev.onHide === 'function') {
        try { prev.onHide(); } catch (e) { console.error('[导航] ' + current + '.onHide 异常：' + e.message); }
      }
    }

    PAGE_IDS.forEach(function (id) {
      var s = sectionOf(id);
      if (s) s.hidden = (id !== pageId);
    });

    if (typeof document !== 'undefined') {
      var buttons = document.querySelectorAll('#sidebar .nav-item');
      Array.prototype.forEach.call(buttons, function (btn) {
        var active = btn.getAttribute('data-nav') === pageId;
        if (btn.classList && btn.classList.toggle) btn.classList.toggle('is-active', active);
      });
      var tb = document.getElementById('tb-page');
      if (tb) tb.textContent = TITLE[pageId] || '';
      document.title = TITLE[pageId] || '九格手记';
    }

    if (current && current !== pageId) {
      history.push(current);
      if (history.length > 20) history.shift();
    }
    current = pageId;

    var inst = rt ? rt.byId(pageId) : null;
    if (inst && typeof inst.onShow === 'function') {
      try { inst.onShow(); } catch (e) { console.error('[导航] ' + pageId + '.onShow 异常：' + String(e && e.stack || e)); }
    }
    return true;
  }

  function goByUrl(url) {
    return go(pageIdFromUrl(url));
  }

  function back() {
    var prev = history.pop();
    if (!prev) return go(PAGE_IDS[0]);
    return go(prev);
  }

  /** 菜单 / 快捷键动作分发（只改变视图与调用既有页面方法，不改任何业务逻辑）。 */
  function onMenuAction(action) {
    var a = String(action || '');
    if (a.indexOf('page:') === 0) {
      var n = Number(a.slice('page:'.length));
      if (isFinite(n) && n >= 1 && n <= PAGE_IDS.length) go(PAGE_IDS[n - 1]);
      return;
    }
    if (a === 'settings') { go('settings'); return; }
    if (a.indexOf('theme:') === 0) {
      var id = a.slice('theme:'.length);
      if (G.JiugeThemeCss && typeof G.JiugeThemeCss.change === 'function') G.JiugeThemeCss.change(id);
      return;
    }
    if (a === 'save') {
      var rt = runtime();
      var today = rt ? rt.byId('index') : null;
      if (today && typeof today.persist === 'function') {
        try { today.persist(); } catch (e) { console.error('[菜单] 保存失败：' + e.message); }
      }
      return;
    }
    // export / import / open-data-dir 由 desktop-features.js 单点消费
    if (G.JiugeDesktopFeatures && typeof G.JiugeDesktopFeatures.onMenuAction === 'function') {
      G.JiugeDesktopFeatures.onMenuAction(a);
    }
  }

  function bind() {
    if (typeof document !== 'undefined') {
      var buttons = document.querySelectorAll('#sidebar .nav-item');
      Array.prototype.forEach.call(buttons, function (btn) {
        btn.addEventListener('click', function () { go(btn.getAttribute('data-nav')); });
      });
    }
    if (J.menu && typeof J.menu.onAction === 'function') {
      J.menu.onAction(function (payload) {
        onMenuAction(payload && payload.action);
      });
    }
  }

  var api = {
    go: go,
    goByUrl: goByUrl,
    back: back,
    onMenuAction: onMenuAction,
    current: function () { return current; },
    pageIdFromUrl: pageIdFromUrl,
    PAGE_IDS: PAGE_IDS,
    TITLE: TITLE,
    URL_TO_PAGE: URL_TO_PAGE,
    bind: bind,
  };

  bind();
  return api;
});
