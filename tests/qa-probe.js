'use strict';
/**
 * 严过关（Yan）· QA 自建 Electron 渲染探针（B 组五页等价 + D6 退出不丢稿）。
 *
 * 与 tools/renderer-probe.js 完全无关：断言由 QA 自己重写、自己命名、自己判定，
 * 只借用 main.js 已存在的 JIUGE_TEST_PROBE / JIUGE_TEST_READBACK 注入时机（生产默认关闭）。
 * 这些函数会被 main.js 用 fn.toString() 注入渲染主世界执行，因此**必须自包含**，
 * 不得引用本模块作用域的任何变量；只能访问 window / document / 全局对象。
 *
 * 结果同时：① return {checks} 供 main.js 打印；② 累积到 window.__QA_RESULT__，
 * 由 tests/qa-electron-entry.js 读取落盘，供 tests/qa-electron-driver.js 汇总。
 */
'use strict';

/** B 组·今日页 / 启动态 / 时钟三重不变 / 四套皮肤（今日页） */
function probe() {
  var o = { checks: [] };
  function log(id, name, ok, detail) {
    o.checks.push({ id: id, name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  try {
    var J = window.__jiuge || {};
    var rt = window.JiugeRuntime;
    var nav = window.JiugeNav;

    var pages = J.sys && typeof J.sys.listPages === 'function' ? J.sys.listPages() : [];
    log('B-01', 'sys.listPages() 返回 5 页且顺序为 index,review,capsule,habit,settings',
      pages.length === 5 && pages.join(',') === 'index,review,capsule,habit,settings', pages.join(','));

    var inst = rt && typeof rt.pages === 'function' ? rt.pages() : [];
    log('B-02', '5 个常驻 Page 实例均已注册', inst.length === 5, '实例数=' + inst.length);

    var active = document.querySelector('#sidebar .nav-item.is-active');
    var secIndex = document.querySelector('section.page[data-page="index"]');
    var othersHidden = ['review', 'capsule', 'habit', 'settings'].every(function (id) {
      var s = document.querySelector('section.page[data-page="' + id + '"]');
      return !!s && s.hidden;
    });
    log('B-03', '冷启动落在「今日」页（导航态 / 侧栏激活项 / section 显隐一致）',
      !!nav && nav.current() === 'index' && !!active && active.getAttribute('data-nav') === 'index'
      && !!secIndex && !secIndex.hidden && othersHidden,
      'current=' + (nav ? nav.current() : 'null') + ' / active=' + (active ? active.getAttribute('data-nav') : 'null')
      + ' / 其余隐藏=' + othersHidden);

    var cells = document.querySelectorAll('.grid-cell');
    var clock = document.querySelector('.clock-value');
    log('B-04', '今日页真实 WXML 已接管（九宫格 9 格 + {{clockText}} 插值）',
      cells.length === 9 && !!clock && /^\d{2}:\d{2}$/.test(clock.textContent.trim()),
      '格数=' + cells.length + ' / clockText=' + (clock ? clock.textContent.trim() : 'null'));

    var idx = rt && typeof rt.byId === 'function' ? rt.byId('index') : null;
    var ta = document.querySelector('.sheet-input');
    if (idx && ta) {
      ta.value = 'QA编辑到一半的正文';
      ta.focus();
      try { ta.setSelectionRange(4, 4); } catch (e) { /* 控件不支持则跳过 */ }
      var before = ta.selectionStart;
      var nodeRef = ta;
      var i;
      for (i = 0; i < 6; i += 1) idx.setData({ clockText: '12:' + (30 + i) });
      var sameNode = document.querySelector('.sheet-input') === nodeRef;
      var focused = document.activeElement === nodeRef;
      var selKept = ta.selectionStart === before;
      var clockNow = document.querySelector('.clock-value');
      var updated = !!clockNow && clockNow.textContent.trim() === '12:35';
      log('B-05', '每秒刷新时钟 6 次：输入框节点 / 焦点 / 选区三重不变且 clockText 局部刷新',
        sameNode && focused && selKept && updated,
        '节点未替换=' + sameNode + ' / 焦点保持=' + focused + ' / 选区=' + before + '→' + ta.selectionStart
        + ' / clockText=' + (clockNow ? clockNow.textContent.trim() : 'null'));
      try { ta.blur(); } catch (e) { /* ignore */ }
      window.__jiugeDirty = false;
    } else {
      log('B-05', '每秒刷新时钟 6 次：输入框节点 / 焦点 / 选区三重不变且 clockText 局部刷新',
        false, '缺少 index 实例或 .sheet-input（idx=' + !!idx + ' / ta=' + !!ta + '）');
    }

    var w = window.wx && typeof window.wx.getSystemInfoSync === 'function'
      ? window.wx.getSystemInfoSync().windowWidth : null;
    log('B-06', 'wx.getSystemInfoSync().windowWidth 固定 375（R2 与 1rpx=0.5px 一致）', w === 375, 'windowWidth=' + w);

    var chips = document.querySelectorAll('.quick-chip');
    var chipTexts = [];
    Array.prototype.forEach.call(chips, function (c) { chipTexts.push(c.getAttribute('data-text')); });
    log('B-07', '一键留一句两条预设文案逐字保留',
      chipTexts.indexOf('今天无事，留个记号。') >= 0
      && chipTexts.indexOf('今天没有什么大事，我还是想把今天留下来。') >= 0,
      chipTexts.join(' | '));

    if (window.JiugeThemeCss && typeof window.JiugeThemeCss.apply === 'function') {
      var ids = ['standard', 'tech', 'girl', 'kids'];
      var ok = true;
      var seen = [];
      ids.forEach(function (id) {
        window.JiugeThemeCss.apply(id);
        var cls = document.documentElement.className;
        var sw = document.documentElement.style.getPropertyValue('--c-switch');
        seen.push(id + ':' + sw);
        if (cls.indexOf('theme-' + id) < 0 || !sw) ok = false;
      });
      log('B-08', '4 套皮肤在今日页全局生效（<html> class 与 --c-switch 同步）', ok, seen.join(' / '));
      window.JiugeThemeCss.apply();
    } else {
      log('B-08', '4 套皮肤在今日页全局生效（<html> class 与 --c-switch 同步）', false, 'JiugeThemeCss 缺失');
    }
  } catch (e) {
    log('B-ERR-1', 'QA probe() 未捕获异常', false, String((e && e.stack) || e));
  }
  if (!window.__QA_RESULT__) window.__QA_RESULT__ = { checks: [] };
  window.__QA_RESULT__.checks = window.__QA_RESULT__.checks.concat(o.checks);
  return o;
}

/** B 组·回看页：swiper / 三标签 / 372 格年历 / 心情筛选 / 跨页带参 */
function probe3() {
  var o = { checks: [] };
  function log(id, name, ok, detail) {
    o.checks.push({ id: id, name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  try {
    var J = window.__jiuge || {};
    var rt = window.JiugeRuntime;
    var page = rt && typeof rt.byId === 'function' ? rt.byId('review') : null;
    var real = !!page && !!document.querySelector('.rv-root');
    log('B-09', '回看页真实 WXML 已接管', real, 'root=' + real);
    if (real) {
      var tabs = document.querySelectorAll('.rv-tab');
      var items = document.querySelectorAll('.j-swiper-item');
      function visibleIdx() {
        var v = [];
        for (var i = 0; i < items.length; i += 1) { if (items[i].style.display !== 'none') v.push(i); }
        return v;
      }
      log('B-10', '回看页 3 个横向标签 + 3 个 swiper-item 且首帧只显示 current=0',
        tabs.length === 3 && items.length === 3 && visibleIdx().length === 1 && visibleIdx()[0] === 0,
        '标签=' + tabs.length + ' / swiper-item=' + items.length + ' / 可见=' + visibleIdx().join(','));

      var orig = page.onTabChange;
      var captured = null;
      page.onTabChange = function (e) {
        captured = e && e.detail ? e.detail.current : null;
        return orig.call(this, e);
      };
      if (tabs.length >= 2) tabs[1].click();
      page.onTabChange = orig;
      log('B-11', 'swiper bindchange 传入 {detail:{current}} 且 tabIndex 同步为 1',
        captured === 1 && page.data.tabIndex === 1,
        'current=' + captured + ' / tabIndex=' + page.data.tabIndex + ' / 可见=' + visibleIdx().join(','));
      if (tabs.length >= 3) tabs[2].click();
      log('B-12', '三标签可切到「日记」tabIndex=2 且 swiper-item 显隐跟随',
        page.data.tabIndex === 2 && visibleIdx().length === 1 && visibleIdx()[0] === 2,
        'tabIndex=' + page.data.tabIndex + ' / 可见=' + visibleIdx().join(','));

      if (typeof page.refreshPixels === 'function') page.refreshPixels();
      var pixels = document.querySelectorAll('.pixel-cell');
      log('B-13', '年历 12×31=372 格一次渲染（P1 保持，未分片）', pixels.length === 372,
        'DOM 格数=' + pixels.length);

      var dateInput = document.querySelector('.rv-root input[type=date]');
      log('B-14', 'picker mode=date → input[type=date]，值仍为 YYYY-MM-DD',
        !!dateInput && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value),
        dateInput ? dateInput.value : 'null');

      // 心情筛选：自己造一条带 mood 的日记，验证「只按心情时每篇一条摘要、标签为 心情 · X」
      var moodOk = false, moodDetail = '';
      try {
        var store = J.store;
        store.save({
          date: '2026-10-01',
          base: { weather: '', anniversary: '', body: '', mood: '平静' },
          cells: { free: 'QA心情筛选样本' },
          workBoard: { tasks: [], reflection: '' },
          moneyBook: { entries: [] },
          studyLog: { entries: [], note: '' },
          template: 'standard',
        });
        var sr = store.search('', '平静');
        var hits = sr.error ? [] : sr.data;
        var h = null;
        hits.forEach(function (x) { if (x.date === '2026-10-01') h = x; });
        moodOk = !!h && String(h.label).indexOf('心情 · 平静') === 0
          && String(h.text).indexOf('QA心情筛选样本') >= 0;
        moodDetail = '命中=' + hits.length + ' / 样本=' + JSON.stringify(h);
      } catch (e) { moodDetail = 'EX ' + String((e && e.message) || e); }
      log('B-15', '只按心情筛选：每篇一条摘要，label 为「心情 · 平静」', moodOk, moodDetail);

      var app = window.getApp();
      page.setData({ tabIndex: 0 });
      app.globalData.reviewTab = 2;
      window.JiugeNav.go('review');
      log('B-16', '往年今天 → 回看落到「日记」标签（reviewTab=2），AppState 消费一次即清',
        page.data.tabIndex === 2 && app.globalData.reviewTab === null,
        'tabIndex=' + page.data.tabIndex + ' / reviewTab=' + String(app.globalData.reviewTab));

      app.globalData.backfillDate = '2026-11-01';
      window.JiugeNav.go('index');
      var idx = rt.byId('index');
      log('B-17', '补记 → 今日落到指定日期 2026-11-01，backfillDate 消费一次即清',
        !!idx && idx.data.dateKey === '2026-11-01' && app.globalData.backfillDate === '',
        'dateKey=' + (idx ? idx.data.dateKey : 'null') + ' / backfillDate=' + app.globalData.backfillDate);
      if (idx && typeof idx.applyDate === 'function' && J.store) idx.applyDate(J.store.today());

      app.globalData.backfillDate = '';
      var origSwitch = window.wx.switchTab;
      window.wx.switchTab = function () { /* 阻断导航，单独验证 AppState 不被写入 */ };
      if (typeof page.goBackfill === 'function') page.goBackfill('2999-01-01');
      window.wx.switchTab = origSwitch;
      log('B-18', '未来日期补记被拒（AppState 不写入未来日期）',
        app.globalData.backfillDate === '', 'backfillDate=' + (app.globalData.backfillDate || '（空）'));
    }
  } catch (e) {
    log('B-ERR-2', 'QA probe3() 未捕获异常', false, String((e && e.stack) || e));
  }
  if (!window.__QA_RESULT__) window.__QA_RESULT__ = { checks: [] };
  window.__QA_RESULT__.checks = window.__QA_RESULT__.checks.concat(o.checks);
  return o;
}

/** B 组·胶囊 / 坚持 / 设置 + 5 页换肤 + 竖栏导航 + 开关 + D6 内容注入 */
function probe4() {
  var o = { checks: [] };
  function log(id, name, ok, detail) {
    o.checks.push({ id: id, name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  try {
    var J = window.__jiuge || {};
    var rt = window.JiugeRuntime;
    var nav = window.JiugeNav;
    var cap = rt && typeof rt.byId === 'function' ? rt.byId('capsule') : null;
    var capRoot = document.querySelector('.capsule-page');
    var dateInput = document.querySelector('.capsule-page input[type=date]');
    var min = dateInput ? dateInput.getAttribute('min') : '';
    var today = J.store ? J.store.today() : '';
    log('B-19', '胶囊页真实 WXML 接管 + picker mode=date 的 min=明天',
      !!cap && !!capRoot && !!dateInput && /^\d{4}-\d{2}-\d{2}$/.test(min)
      && min === cap.data.capsuleMinDate && min > today,
      'min=' + min + ' / capsuleMinDate=' + (cap ? cap.data.capsuleMinDate : 'null') + ' / today=' + today);

    var before = cap ? cap.data.capsuleOpenAt : '';
    if (cap && typeof cap.onCapsuleDateChange === 'function') {
      cap.onCapsuleDateChange({ detail: { value: '2020-01-01' } });
    }
    log('B-20', '过去日期被拒且不改写 capsuleOpenAt', !!cap && cap.data.capsuleOpenAt === before,
      before + ' → ' + (cap ? cap.data.capsuleOpenAt : 'null'));

    // 非法 openAt：注入一条脏胶囊 → refresh → DOM 不出现 NaN / 分组 total=1 → 恢复原值
    var nanOk = false, nanDetail = '';
    var original = J.kv ? J.kv.get('morning_capsules') : '';
    try {
      J.kv.set('morning_capsules', [
        { id: 'qa-bad', text: '脏信', openAt: 'NOT_A_DATE', writtenAt: '2024-01-01', createdAt: 1, opened: false, openedAt: 0 },
        { id: 'qa-good', text: '正常信', openAt: '2999-01-01', writtenAt: '2024-01-01', createdAt: 2, opened: false, openedAt: 0 },
      ]);
      if (cap && typeof cap.refresh === 'function') cap.refresh();
      var txt = capRoot ? capRoot.textContent : '';
      var g = J.store ? J.store.capsuleGroups() : { data: { total: -1 } };
      nanOk = txt.indexOf('NaN') < 0 && g.data.total === 1;
      nanDetail = 'DOM含NaN=' + (txt.indexOf('NaN') >= 0) + ' / capsuleGroups.total=' + g.data.total;
    } catch (e) { nanDetail = 'EX ' + String((e && e.message) || e); }
    finally {
      try {
        J.kv.set('morning_capsules', original);
        if (cap && typeof cap.refresh === 'function') cap.refresh();
      } catch (e) { /* ignore */ }
    }
    log('B-21', '非法 openAt 不显示「已到期 NaN 天」且 capsuleGroups 跳过该记录', nanOk, nanDetail);

    log('B-22', '坚持页真实 WXML 接管', !!document.querySelector('.milestone-card'),
      'milestone-card=' + !!document.querySelector('.milestone-card'));

    var set = rt.byId('settings');
    nav.go('settings');
    var boxes = document.querySelectorAll('.settings-page input[type=checkbox]');
    log('B-23', 'switch→checkbox 恰好 4 个开关（3 模块 + 1 头七天双向）', boxes.length === 4,
      'checkbox 数=' + boxes.length);

    var captured = null;
    var orig = set && set.onToggleModule ? set.onToggleModule : null;
    var modId = set && set.data.moduleList && set.data.moduleList[0] ? set.data.moduleList[0].id : null;
    var beforeMod = modId && J.store ? J.store.modules().data[modId] : null;
    if (set && orig) {
      set.onToggleModule = function (e) {
        captured = e && e.detail ? e.detail.value : null;
        return orig.call(this, e);
      };
    }
    if (boxes.length) {
      boxes[0].checked = !boxes[0].checked;
      boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (set && orig) set.onToggleModule = orig;
    var afterMod = modId && J.store ? J.store.modules().data[modId] : null;
    log('B-24', 'switch bindchange → e.detail.value 为布尔且 store.modules() 真的变化',
      typeof captured === 'boolean' && beforeMod !== afterMod,
      'captured=' + captured + ' / ' + modId + ':' + beforeMod + '→' + afterMod);
    if (modId && typeof beforeMod === 'boolean' && J.store) {
      J.store.setModule(modId, beforeMod);
      if (set && typeof set.refresh === 'function') set.refresh();
    }

    var btns = document.querySelectorAll('.settings-page .data-btn');
    var texts = [];
    Array.prototype.forEach.call(btns, function (b) {
      var t = b.querySelector('.data-btn-title');
      if (t) texts.push(t.textContent.trim());
    });
    var need = ['导出可读文本', '导出 Markdown', '导出 JSON 备份', '从剪贴板导入', '导入小程序备份文件（v6/v7）'];
    var missing = need.filter(function (t) { return texts.indexOf(t) < 0; });
    log('B-25', '剪贴板三导出 + 剪贴板导入 + 新增文件导入共 5 个入口并存',
      missing.length === 0, '缺失=' + JSON.stringify(missing) + ' / 实际=' + texts.join(' | '));

    var ids5 = ['index', 'review', 'capsule', 'habit', 'settings'];
    var skinOk = true, seen = [];
    ['standard', 'tech', 'girl', 'kids'].forEach(function (tid) {
      window.JiugeThemeCss.change(tid);
      var cls = document.documentElement.className;
      var sw = document.documentElement.style.getPropertyValue('--c-switch');
      var themes = ids5.map(function (id) { var p = rt.byId(id); return p && p.data ? p.data.theme : null; });
      if (cls.indexOf('theme-' + tid) < 0 || !sw || themes.some(function (t) { return t !== tid; })) skinOk = false;
      seen.push(tid + ':' + themes.join(','));
    });
    log('B-26', '4 套皮肤在全部 5 页一起变色（含 <html> class / --c-switch / 5 页 data.theme）',
      skinOk, seen.join(' | '));
    window.JiugeThemeCss.change('standard');

    var navBtns = document.querySelectorAll('#sidebar .nav-item');
    var navOk = navBtns.length === 5, visited = [];
    Array.prototype.forEach.call(navBtns, function (btn) {
      var id = btn.getAttribute('data-nav');
      btn.click();
      var sec = document.querySelector('section.page[data-page="' + id + '"]');
      var vis = !!sec && !sec.hidden;
      visited.push(id + ':' + (vis ? '可见' : '不可见'));
      if (!vis) navOk = false;
    });
    log('B-27', '左侧竖栏 5 项导航全部可达且对应 section 可见', navOk, visited.join(' / '));
    nav.go('index');

    // D6：注入「编辑到一半」的未失焦内容，供关窗 flush 与第二次启动 readback 复核
    var idx = rt.byId('index');
    if (idx) {
      idx.setData({
        editValue: 'QA当前格正文',
        workReflection: 'QA未失焦工作感想',
        studyDayNote: 'QA未失焦今日一句',
      });
      if (idx._cells) idx._cells.work = 'QA当前格正文';
      if (!idx._workBoard) idx._workBoard = { tasks: [], reflection: '' };
      if (!idx._studyLog) idx._studyLog = { entries: [], note: '' };
      log('B-28', '注入未失焦输入（工作感想 / 今日一句 / 当前格正文）供关窗 flush',
        true, 'workReflection=QA未失焦工作感想 / studyDayNote=QA未失焦今日一句 / _cells.work=QA当前格正文');
    } else {
      log('B-28', '注入未失焦输入（工作感想 / 今日一句 / 当前格正文）供关窗 flush',
        false, 'index 实例缺失');
    }
    // 避免 P1 二次确认弹窗阻塞自动关窗（QA 已主动清脏）
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    window.__jiugeDirty = false;
  } catch (e) {
    log('B-ERR-3', 'QA probe4() 未捕获异常', false, String((e && e.stack) || e));
  }
  if (!window.__QA_RESULT__) window.__QA_RESULT__ = { checks: [] };
  window.__QA_RESULT__.checks = window.__QA_RESULT__.checks.concat(o.checks);
  return o;
}

/** D6 回启读回：关窗 flush 后磁盘内容仍在 */
function readback() {
  var o = { checks: [] };
  function log(id, name, ok, detail) {
    o.checks.push({ id: id, name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  try {
    var J = window.__jiuge || {};
    var store = J.store;
    var today = store ? store.today() : '';
    var key = 'morning_diary_' + today;
    var raw = J.kv ? J.kv.get(key) : '';
    var rec = raw && typeof raw === 'object' ? raw : {};
    var refl = rec.workBoard && rec.workBoard.reflection ? rec.workBoard.reflection : '';
    var note = rec.studyLog && rec.studyLog.note ? rec.studyLog.note : '';
    var cell = rec.cells && rec.cells.work ? rec.cells.work : '';
    log('B-29', '关窗 flush 后回启：磁盘日记含未失焦工作感想', refl === 'QA未失焦工作感想', refl);
    log('B-30', '关窗 flush 后回启：磁盘日记含未失焦今日一句', note === 'QA未失焦今日一句', note);
    log('B-31', '关窗 flush 后回启：磁盘日记含当前格正文', cell === 'QA当前格正文', cell);
    log('B-32', '落盘键名 morning_diary_<今天> 且记录 date 正确',
      key.indexOf('morning_diary_') === 0 && rec.date === today, key + ' / date=' + (rec.date || ''));
  } catch (e) {
    log('B-ERR-4', 'QA readback() 未捕获异常', false, String((e && e.stack) || e));
  }
  if (!window.__QA_RESULT__) window.__QA_RESULT__ = { checks: [] };
  window.__QA_RESULT__.checks = window.__QA_RESULT__.checks.concat(o.checks);
  return o;
}

module.exports = { probe: probe, probe3: probe3, probe4: probe4, readback: readback };
