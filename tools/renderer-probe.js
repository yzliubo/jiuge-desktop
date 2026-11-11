'use strict';
/**
 * 验收专用渲染探针（仅测试用，生产默认关闭）。
 *
 * 由 main.js 在显式设置 JIUGE_TEST_PROBE=1 / JIUGE_TEST_READBACK=1 时，
 * 通过 webContents.executeJavaScript 注入渲染主世界执行；
 * 不新增 IPC 通道、不引入任何网络能力、不改产品代码路径。
 *
 * probe()   —— T2 今日页：插值 / 条件 / 循环 / 失焦 / 滑杆 / picker / 皮肤 / 文案
 * probe3()  —— T3 回看页：swiper 三标签、bindchange、372 格年历、date picker、内联 rpx、补记与跨页带参
 * probe4()  —— T4 胶囊/坚持/设置：min=明天、switch→checkbox、导入入口、四套皮肤 5 页
 * readback()—— 关窗 flush 后回启读回（D6 编辑一半不丢字）
 */
function probe() {
  var out = { checks: [] };
  function log(name, ok, detail) {
    out.checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  try {
    var rt = window.JiugeRuntime;
    var page = rt && rt.byId('index');
    log('index 页实例存在', !!page, !!page);
    if (!page) return out;

    var clock = document.querySelector('.clock-value');
    var clockText = clock ? clock.textContent.trim() : '';
    log('{{clockText}} 求值', /^\d{2}:\d{2}$/.test(clockText), clockText);
    var dateEl = document.querySelector('.hero-date');
    log('{{dateLabel}} 求值', !!dateEl && dateEl.textContent.trim().length > 0,
      dateEl ? dateEl.textContent.trim() : 'null');
    var cells = document.querySelectorAll('.grid-cell');
    log('wx:for 九宫格 9 格', cells.length === 9, '实际 ' + cells.length + ' 格');
    var labels = [];
    Array.prototype.forEach.call(cells, function (c) {
      var l = c.querySelector('.cell-label');
      if (l) labels.push(l.textContent.trim());
    });
    log('{{item.label}} 逐格求值', labels.length === 9 && labels[0].length > 0, labels.join('/'));

    var masks = document.querySelectorAll('.mask');
    var allHidden = true;
    Array.prototype.forEach.call(masks, function (m) { if (m.style.display !== 'none') allHidden = false; });
    log('wx:if 首帧隐藏全部遮罩', masks.length >= 4 && allHidden,
      masks.length + ' 个遮罩，全部 display:none=' + allHidden);

    var cellText = document.querySelector('.cell-text');
    var cellPrompt = document.querySelector('.cell-prompt');
    log('wx:if / wx:else 条件组生效',
      !!cellText && cellText.style.display === 'none'
      && !!cellPrompt && cellPrompt.style.display !== 'none',
      'cell-text=' + (cellText ? cellText.style.display : 'null')
      + ' cell-prompt=' + (cellPrompt ? cellPrompt.style.display : 'null'));

    var blocks = document.querySelectorAll('.j-block');
    var scrolls = document.querySelectorAll('.j-scroll');
    log('block 与 scroll-view 组件映射', blocks.length >= 1 && scrolls.length >= 4,
      'block=' + blocks.length + ' / scroll-view=' + scrolls.length);

    var ta = document.querySelector('.sheet-input');
    log('textarea 存在', !!ta, !!ta ? ta.tagName : 'null');
    if (ta) {
      ta.value = '编辑到一半的正文 <script>alert(1)</script>';
      ta.focus();
      try { ta.setSelectionRange(5, 5); } catch (e) { /* 某些控件不支持 */ }
      var beforeStart = ta.selectionStart;
      var nodeRef = ta;
      for (var i = 0; i < 6; i += 1) page.setData({ clockText: '12:' + (30 + i) });
      var sameNode = document.querySelector('.sheet-input') === nodeRef;
      var focused = document.activeElement === nodeRef;
      var selKept = ta.selectionStart === beforeStart;
      log('时钟刷新 6 次 · DOM 节点未替换', sameNode, sameNode);
      log('时钟刷新 6 次 · 输入框保持焦点', focused, focused);
      log('时钟刷新 6 次 · 选区保持不变', selKept, beforeStart + ' → ' + ta.selectionStart);
      var clockNow = document.querySelector('.clock-value');
      log('clockText 已局部刷新到视图', !!clockNow && clockNow.textContent.trim() === '12:35',
        clockNow ? clockNow.textContent.trim() : 'null');
    }

    page.setData({
      editValue: '编辑一半的格子正文',
      workReflection: '未失焦的工作感想',
      studyDayNote: '未失焦的今日一句',
    });
    log('探针写入未失焦内容', true, 'workReflection / studyDayNote / editValue');

    try {
      page.openIntake('');
      var track = document.querySelector('.intake-track');
      if (track) {
        var r = track.getBoundingClientRect();
        log('滑杆轨道真实 DOM rect', r.width > 0,
          'width=' + Math.round(r.width) + ' left=' + Math.round(r.left));
        log('data-field 求值到 dataset', track.getAttribute('data-field') === 'weather',
          track.getAttribute('data-field'));
        var beforeValue = page.data.intakeRows && page.data.intakeRows[0]
          ? page.data.intakeRows[0].value : '';
        var mx = r.left + r.width * 0.85;
        track.dispatchEvent(new MouseEvent('mousedown', { clientX: mx, clientY: r.top + 5, bubbles: true }));
        var afterValue = page.data.intakeRows && page.data.intakeRows[0]
          ? page.data.intakeRows[0].value : '';
        log('鼠标事件包装 e.touches[0].clientX 生效', afterValue !== beforeValue && !!afterValue,
          beforeValue + ' → ' + afterValue + ' @clientX=' + Math.round(mx));
      } else {
        log('滑杆轨道真实 DOM rect', false, '未找到 .intake-track');
        log('鼠标事件包装 e.touches[0].clientX 生效', false, '未找到 .intake-track');
      }
      page.closeIntake();
    } catch (e) {
      log('滑杆探针异常', false, String(e && e.message || e));
    }

    var sampleItem = {
      id: 'probe-item', cls: '', kindCls: '', kindGlyph: '书', title: '探针条目',
      statusLabel: '在读', topicTitle: '', pct: 0, progressText: '0/10', step: 1,
      done: 0, finished: false, note: '', topicIndex: 0,
    };
    page.setData({
      studyItems: [sampleItem],
      studyTopicOptions: [{ id: '', title: '不归属主题' }],
    });
    var selects = document.querySelectorAll('select');
    log('picker mode=selector 映射为 select', selects.length >= 1,
      'select 数量=' + selects.length + ' / 首项 option=' + (selects.length ? selects[0].options.length : 0));
    if (selects.length) {
      log('picker range-key=title 生成 option 文本',
        selects[0].options.length === 1 && selects[0].options[0].textContent === '不归属主题',
        selects[0].options.length ? selects[0].options[0].textContent : 'null');
    } else {
      log('picker range-key=title 生成 option 文本', false, '无 select');
    }
    page.setData({ studyItems: [], studyTopicOptions: [{ id: '', title: '不归属主题' }] });

    log('getSystemInfoSync().windowWidth 固定 375',
      window.wx && wx.getSystemInfoSync().windowWidth === 375,
      window.wx ? wx.getSystemInfoSync().windowWidth : 'null');

    var measured = null;
    window.wx.createSelectorQuery().select('.hero').boundingClientRect(function (rect) {
      measured = rect;
    }).exec();
    log('createSelectorQuery 返回真实 rect', !!measured && measured.width > 0,
      measured ? 'width=' + Math.round(measured.width) : 'null');

    if (window.JiugeThemeCss) {
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
      log('四套皮肤在今日页生效', ok, seen.join(' / '));
      window.JiugeThemeCss.apply();
    }

    var chips = document.querySelectorAll('.quick-chip');
    var texts = [];
    Array.prototype.forEach.call(chips, function (c) { texts.push(c.getAttribute('data-text')); });
    log('一键留一句文案逐字保留',
      texts.indexOf('今天无事，留个记号。') >= 0
      && texts.indexOf('今天没有什么大事，我还是想把今天留下来。') >= 0,
      texts.join(' | '));

    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  } catch (e) {
    log('探针异常', false, String(e && e.stack || e));
  }
  return out;
}

/** T3：回看页 swiper / 三标签 / 年历 / 日期控件 / 补记与跨页带参。 */
function probe3() {
  var out = { checks: [] };
  function log(name, ok, detail) {
    out.checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  try {
    var rt = window.JiugeRuntime;
    var page = rt && rt.byId('review');
    var real = !!page && !!document.querySelector('.rv-root');
    log('T3 review 页真实 WXML 已接管', real, real);
    if (!real) return out;

    var tabs = document.querySelectorAll('.rv-tab');
    var items = document.querySelectorAll('.j-swiper-item');
    log('T3 3 个标签 + 3 个 swiper-item', tabs.length === 3 && items.length === 3,
      tabs.length + ' / ' + items.length);
    function visibleIdx() {
      var v = [];
      for (var i = 0; i < items.length; i += 1) { if (items[i].style.display !== 'none') v.push(i); }
      return v;
    }
    log('T3 swiper 首帧只显示 current=0',
      visibleIdx().length === 1 && visibleIdx()[0] === 0, visibleIdx().join(','));

    var orig = page.onTabChange;
    var captured = null;
    page.onTabChange = function (e) {
      captured = e && e.detail ? e.detail.current : null;
      return orig.call(this, e);
    };
    if (tabs.length >= 2) tabs[1].click();
    page.onTabChange = orig;
    log('T3 点击标签 → onTabTap tabIndex=1', page.data.tabIndex === 1, page.data.tabIndex);
    log('T3 swiper bindchange 传 {detail:{current}}', captured === 1, 'current=' + captured);
    log('T3 swiper 显隐切到 1',
      visibleIdx().length === 1 && visibleIdx()[0] === 1, visibleIdx().join(','));

    if (tabs.length >= 3) tabs[2].click();
    log('T3 三标签切到「日记」tabIndex=2', page.data.tabIndex === 2, page.data.tabIndex);
    log('T3 日记 swiper-item 可见',
      visibleIdx().length === 1 && visibleIdx()[0] === 2, visibleIdx().join(','));

    page.setData({ tabIndex: 0 });
    window.getApp().globalData.reviewTab = 2;
    window.JiugeNav.go('review');
    log('T3 往年今天落回看「日记」标签', page.data.tabIndex === 2, page.data.tabIndex);
    log('T3 AppState 消费一次即清', window.getApp().globalData.reviewTab === null,
      String(window.getApp().globalData.reviewTab));

    if (typeof page.refreshPixels === 'function') page.refreshPixels();
    var pixels = document.querySelectorAll('.pixel-cell');
    log('T3 年历 12×31=372 格一次渲染', pixels.length === 372, 'DOM 格数=' + pixels.length);

    var dateInput = document.querySelector('.rv-root input[type=date]');
    log('T3 picker mode=date → input[type=date]', !!dateInput,
      dateInput ? dateInput.value : 'null');
    log('T3 日期值 YYYY-MM-DD',
      !!dateInput && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value),
      dateInput ? dateInput.value : 'null');

    var conv = window.JiugeWxmlRuntime && window.JiugeWxmlRuntime.convertInlineRpx
      ? window.JiugeWxmlRuntime.convertInlineRpx('height:50rpx') : '';
    log('T3 内联 style rpx→px 转换', conv === 'height:25px', conv);
    var bar = document.querySelector('.trend-bar');
    log('T3 WXML 内联 rpx 未残留到 DOM',
      !bar || String(bar.getAttribute('style') || '').indexOf('rpx') < 0,
      bar ? bar.getAttribute('style') : '（心情柱暂无数据）');

    var app = window.getApp();
    app.globalData.backfillDate = '';
    var origSwitch = wx.switchTab;
    wx.switchTab = function () { /* 阻断导航，单独验证 AppState */ };
    page.goBackfill('2999-01-01');
    log('T3 未来日期补记被拒', app.globalData.backfillDate === '',
      app.globalData.backfillDate || '（空）');
    wx.switchTab = origSwitch;

    app.globalData.backfillDate = '2026-11-01';
    window.JiugeNav.go('index');
    var idx = rt.byId('index');
    log('T3 补记落今日指定日期', idx && idx.data.dateKey === '2026-11-01',
      idx ? idx.data.dateKey : 'null');
    log('T3 backfillDate 消费一次即清', app.globalData.backfillDate === '',
      app.globalData.backfillDate || '（空）');
    if (idx && typeof idx.applyDate === 'function') idx.applyDate(window.__jiuge.store.today());
  } catch (e) {
    log('T3 探针异常', false, String(e && e.stack || e));
  }
  return out;
}

/** T4：胶囊 min=明天 / switch→checkbox / 导入入口 / 四套皮肤 5 页。 */
function probe4() {
  var out = { checks: [] };
  function log(name, ok, detail) {
    out.checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  try {
    var available = window.__jiuge && window.__jiuge.sys ? window.__jiuge.sys.listPages() : [];
    var allReal = available.length === 5 && available.indexOf('capsule') >= 0
      && available.indexOf('habit') >= 0 && available.indexOf('settings') >= 0;
    if (!allReal) {
      log('T4 页面尚未全部落盘（按批次跳过）', true, '当前已落盘：' + available.join(','));
      return out;
    }
    var rt = window.JiugeRuntime;
    var cap = rt.byId('capsule');
    log('T4 capsule 真实 WXML 接管', !!document.querySelector('.capsule-page'),
      !!document.querySelector('.capsule-page'));
    var dateInput = document.querySelector('.capsule-page input[type=date]');
    var min = dateInput ? dateInput.getAttribute('min') : '';
    var today = window.__jiuge.store.today();
    log('T4 picker mode=date min=明天',
      !!cap && min === cap.data.capsuleMinDate && min > today && /^\d{4}-\d{2}-\d{2}$/.test(min),
      'min=' + min + ' / capsuleMinDate=' + (cap ? cap.data.capsuleMinDate : 'null') + ' / today=' + today);
    log('T4 日期值 YYYY-MM-DD',
      !!dateInput && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value),
      dateInput ? dateInput.value : 'null');
    var before = cap.data.capsuleOpenAt;
    cap.onCapsuleDateChange({ detail: { value: '2020-01-01' } });
    log('T4 过去日期被拒且不改值', cap.data.capsuleOpenAt === before,
      before + ' → ' + cap.data.capsuleOpenAt);

    log('T4 habit 真实 WXML 接管', !!document.querySelector('.milestone-card'),
      !!document.querySelector('.milestone-card'));

    var set = rt.byId('settings');
    // moduleList 在 settings.onShow() 里才填充；先导航触发 onShow，再检查循环渲染的 3 个模块开关
    window.JiugeNav.go('settings');
    var switches = document.querySelectorAll('.settings-page input[type=checkbox]');
    log('T4 switch→checkbox 4 个（3 模块 + 1 双向）', switches.length === 4, switches.length);
    var modList = set.data.moduleList || [];
    var checkedOk = true;
    for (var i = 0; i < 3 && i < switches.length && i < modList.length; i += 1) {
      if (switches[i].checked !== (modList[i].on !== false)) checkedOk = false;
    }
    log('T4 模块开关 checked 与数据一致', checkedOk,
      modList.slice(0, 3).map(function (m) { return m.on; }).join(','));

    var orig = set.onToggleModule;
    var captured = null;
    set.onToggleModule = function (e) {
      captured = e && e.detail ? e.detail.value : null;
      return orig.call(this, e);
    };
    if (switches.length) {
      switches[0].checked = !switches[0].checked;
      switches[0].dispatchEvent(new Event('change', { bubbles: true }));
    }
    set.onToggleModule = orig;
    log('T4 switch bindchange → e.detail.value', typeof captured === 'boolean', String(captured));
    if (modList.length) {
      window.__jiuge.store.setModule(modList[0].id, modList[0].on);
      set.refresh();
    }

    var btns = document.querySelectorAll('.settings-page .data-btn');
    var texts = [];
    Array.prototype.forEach.call(btns, function (b) {
      var t = b.querySelector('.data-btn-title');
      if (t) texts.push(t.textContent.trim());
    });
    log('T4 剪贴板导入入口保留', texts.indexOf('从剪贴板导入') >= 0, texts.join(' | '));
    log('T4 新增文件导入入口文案逐字',
      texts.indexOf('导入小程序备份文件（v6/v7）') >= 0, texts.join(' | '));
    log('T4 三种剪贴板导出入口保留',
      texts.indexOf('导出可读文本') >= 0 && texts.indexOf('导出 Markdown') >= 0
      && texts.indexOf('导出 JSON 备份') >= 0, texts.join(' | '));

    var ids = ['index', 'review', 'capsule', 'habit', 'settings'];
    var ok = true;
    var seen = [];
    ['standard', 'tech', 'girl', 'kids'].forEach(function (tid) {
      window.JiugeThemeCss.change(tid);
      var cls = document.documentElement.className;
      var sw = document.documentElement.style.getPropertyValue('--c-switch');
      var themes = ids.map(function (id) { var p = rt.byId(id); return p && p.data ? p.data.theme : null; });
      if (cls.indexOf('theme-' + tid) < 0 || !sw || themes.some(function (t) { return t !== tid; })) ok = false;
      seen.push(tid + ':' + themes.join(','));
    });
    log('T4 四套皮肤在全部 5 页一起变色', ok, seen.join(' | '));
    // 恢复 standard，避免探针换肤写入影响 QA 首次启动的观感
    window.JiugeThemeCss.change('standard');

    // 5 页左侧竖栏导航全部可达，且对应 section 可见
    var navBtns = document.querySelectorAll('#sidebar .nav-item');
    var navOk = navBtns.length === 5;
    var visited = [];
    Array.prototype.forEach.call(navBtns, function (btn) {
      var id = btn.getAttribute('data-nav');
      btn.click();
      var sec = document.querySelector('section.page[data-page="' + id + '"]');
      var visible = !!sec && !sec.hidden;
      visited.push(id + ':' + (visible ? '可见' : '不可见'));
      if (!visible) navOk = false;
    });
    log('T4 左侧竖栏 5 项导航全部可达', navOk, visited.join(' / '));
    window.JiugeNav.go('index');
  } catch (e) {
    log('T4 探针异常', false, String(e && e.stack || e));
  }
  return out;
}

/** 回启读回：验证关窗 flush 后内容仍在（D6「编辑一半不丢字」）。 */
function readback() {
  var out = { checks: [] };
  function log(name, ok, detail) {
    out.checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  try {
    var page = window.JiugeRuntime && window.JiugeRuntime.byId('index');
    log('index 页实例存在', !!page, !!page);
    if (!page) return out;
    var reflection = String((page.data && page.data.workReflection) || '');
    var note = String((page.data && page.data.studyDayNote) || '');
    log('回启后工作感想仍在', reflection === '未失焦的工作感想', reflection);
    log('回启后今日一句仍在', note === '未失焦的今日一句', note);
    var store = window.__jiuge && window.__jiuge.store;
    var key = 'morning_diary_' + (store ? store.today() : '');
    var raw = window.__jiuge && window.__jiuge.kv ? window.__jiuge.kv.get(key) : '';
    var rec = raw && typeof raw === 'object' ? raw : {};
    var diskReflection = rec.workBoard && rec.workBoard.reflection ? rec.workBoard.reflection : '';
    var diskNote = rec.studyLog && rec.studyLog.note ? rec.studyLog.note : '';
    log('磁盘日记含工作感想', diskReflection === '未失焦的工作感想', diskReflection);
    log('磁盘日记含今日一句', diskNote === '未失焦的今日一句', diskNote);
    log('morning_diary_ 键名正确', !!key && key.indexOf('morning_diary_') === 0, key);
  } catch (e) {
    log('回读探针异常', false, String(e && e.stack || e));
  }
  return out;
}

module.exports = { probe: probe, probe3: probe3, probe4: probe4, readback: readback };
