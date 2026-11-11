'use strict';
/**
 * AppState 改写（架构 §1.4 / §9.1，替代小程序 app.js 的 App({globalData})）。
 *
 *  - 纯内存、不落盘；跨页带参靠 getApp().globalData 的 backfillDate / reviewTab；
 *  - 源码 4 处 getApp() 里已经写好了「消费一次即清空」，这里不做二次加工，
 *    只额外提供 consume*() 给运行时/测试使用，行为与小程序一致；
 *  - onLaunch 保留源 app.js 的语义：首次启动写 morning_started_at（本地时区 YYYY-MM-DD），
 *    禁止用 toISOString() 做日期键；原生层刷新的 applySystemChrome 在桌面版由 CSS 换肤接管。
 *
 * 本文件同时兼容浏览器 <script> 与 Node CommonJS（tools/*.js 纯 Node 冒烟可 require）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeAppState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  /** 本地时区日期键；exportedAt 是唯一例外（由 exportBackup 用 toISOString）。 */
  function formatDate(d) {
    var date = d instanceof Date ? d : new Date();
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  var globalData = {
    appName: '九格手记',
    version: '1.0.0',
    // 回看页的「补记某天」经此中转，由今日页 onShow 消费一次
    backfillDate: '',
    // 今日页点「往年今天」要落在回看页的「日记」标签上，用数字下标中转，回看页消费一次
    reviewTab: null,
  };

  function getApp() {
    return { globalData: globalData };
  }

  /** 源 app.js onLaunch 的桌面等价：缺开始日就补今天，存储不可用不影响页面渲染。 */
  function onLaunch(wxImpl) {
    var wxApi = wxImpl || (typeof wx !== 'undefined' ? wx : null);
    if (!wxApi || typeof wxApi.getStorageSync !== 'function') return false;
    try {
      if (!wxApi.getStorageSync('morning_started_at')) {
        wxApi.setStorageSync('morning_started_at', formatDate(new Date()));
        return true;
      }
    } catch (e) {
      // 本地存储不可用时不影响页面渲染
    }
    return false;
  }

  /** 消费一次即清空；源码页面 JS 自己已经这么做了，这里仅给运行时/测试提供显式入口。 */
  function consumeBackfill() {
    var d = globalData.backfillDate;
    globalData.backfillDate = '';
    return d;
  }

  /** 消费一次即清空（reviewTab 回落到 null）。 */
  function consumeReviewTab() {
    var t = globalData.reviewTab;
    globalData.reviewTab = null;
    return t;
  }

  return {
    globalData: globalData,
    getApp: getApp,
    onLaunch: onLaunch,
    formatDate: formatDate,
    consumeBackfill: consumeBackfill,
    consumeReviewTab: consumeReviewTab,
  };
});
