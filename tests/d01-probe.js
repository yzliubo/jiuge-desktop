'use strict';
/**
 * D01 缺陷验证探针（仅测试用）。
 *
 * 缺陷：循环项内引用外层 setData 标量的绑定永不刷新。
 * 探针只陈述事实与一致性判定，不区分「修复前 / 修复后」——
 * 同一份探针在修复前后各跑一次，前一次用于取证（失败项即缺陷现场），后一次用于验收。
 *
 * 该函数会被 toString() 后注入渲染主世界执行，因此**不得引用闭包外的任何变量**。
 *
 * 五条验证：
 *   D01-01/02 回看页三标签 .rv-tab-on 与 tabIndex 一致（setData 路径 + 真实点击路径）
 *   D01-03     设置页 .skin-cell-on / aria-checked / aria-label 与 theme 一致（四套皮肤）
 *   D01-04..08 回归 B-05：每秒刷 clockText × 6，输入框节点引用 / 焦点 / 选区 / 值 不变
 *   D01-09/10/11 九格摘要展开态 .dg-row-open 与 digestOpen[item.key] 一致，且与 wx:if 正文同步
 *   D01-12     372 格年历场景 60 次 setData 的耗时（avg / P50 / P95 / max）
 */
function d01Probe() {
  var out = { checks: [], facts: {} };

  function log(id, name, ok, detail) {
    out.checks.push({ id: id, name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  function q(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  }
  function round3(n) { return Math.round(n * 1000) / 1000; }
  function pct(sorted, p) {
    if (!sorted.length) return 0;
    var i = Math.ceil(p / 100 * sorted.length) - 1;
    if (i < 0) i = 0;
    if (i > sorted.length - 1) i = sorted.length - 1;
    return sorted[i];
  }

  /**
   * 连续 60 次 setData({clockText}) 的耗时（预热 5 次避开首次 JIT）。
   * 用「每秒刷时钟」这一真实高频路径压全量循环求值，得到最坏情况下的单次成本。
   */
  function benchSetData(instance, id, name, sceneNote) {
    var view = instance && instance._view ? instance._view : null;
    var loops = view && Array.isArray(view.loops) ? view.loops.length : -1;
    var items = 0;
    if (view && Array.isArray(view.loops)) {
      view.loops.forEach(function (l) {
        if (l && l.items && typeof l.items.size === 'number') items += l.items.size;
      });
    }
    var pixels = q('.pixel-cell').length;
    for (var w = 0; w < 5; w += 1) instance.setData({ clockText: 'warming-' + w });
    var samples = [];
    for (var n = 0; n < 60; n += 1) {
      var s = performance.now();
      instance.setData({ clockText: '11:' + (10 + (n % 50)) });
      samples.push(performance.now() - s);
    }
    var sorted = samples.slice().sort(function (a, b) { return a - b; });
    var sum = samples.reduce(function (a, b) { return a + b; }, 0);
    var avg = sum / samples.length;
    var p50 = pct(sorted, 50);
    var p95 = pct(sorted, 95);
    if (id) {
      log(id, name, avg <= 16,
        '平均 ' + round3(avg) + 'ms / P50 ' + round3(p50) + 'ms / P95 ' + round3(p95)
        + 'ms / 最大 ' + round3(sorted[sorted.length - 1]) + 'ms / 60 次合计 ' + round3(sum) + 'ms'
        + ' · 场景=' + sceneNote + ' / ' + (pixels ? pixels + ' 格 / ' : '')
        + loops + ' 个 wx:for / ' + items + ' 个循环项');
    }
    return {
      page: sceneNote, pixels: pixels, loops: loops, loopItems: items, iterations: 60,
      avgMs: round3(avg), p50Ms: round3(p50), p95Ms: round3(p95),
      maxMs: round3(sorted[sorted.length - 1]), minMs: round3(sorted[0]), totalMs: round3(sum),
      samples: samples.map(round3),
    };
  }

  try {
    var rt = window.JiugeRuntime;
    if (!rt || typeof rt.byId !== 'function') {
      log('D01-00', '渲染进程运行时可用', false, 'window.JiugeRuntime 缺失');
      return out;
    }
    var rv = rt.byId('review');
    var idx = rt.byId('index');
    var set = rt.byId('settings');
    log('D01-00', '回看 / 今日 / 设置 三个 Page 实例存在', !!rv && !!idx && !!set,
      'review=' + !!rv + ' index=' + !!idx + ' settings=' + !!set);

    // ================= 1. 回看页三标签（.rv-tab-on） =================
    window.JiugeNav.go('review');
    var tabs = q('.rv-tab');
    if (!rv || tabs.length !== 3) {
      log('D01-01', '回看页 tabIndex 变化后 .rv-tab-on 跟随', false,
        '标签数=' + tabs.length + ' / review 实例=' + !!rv);
    } else {
      function tabState() {
        var list = q('.rv-tab');
        var on = -1;
        var cls = [];
        list.forEach(function (t, i) {
          cls.push(t.className);
          if (t.classList.contains('rv-tab-on')) on = i;
        });
        return { on: on, tabIndex: rv.data.tabIndex, cls: cls };
      }
      var seq = [1, 2, 0, 1];
      var steps = [];
      var tabOk = true;
      seq.forEach(function (target) {
        rv.setData({ tabIndex: target });
        var st = tabState();
        steps.push('setData({tabIndex:' + target + '}) → .rv-tab-on 落在第 ' + (st.on + 1)
          + ' 个（0 基 ' + st.on + '），三个标签 class 实录=[' + st.cls.join(' ][ ') + ']');
        if (st.on !== target) tabOk = false;
      });
      out.facts.tabSteps = steps;
      log('D01-01', 'setData({tabIndex:N}) 后 .rv-tab-on 与 tabIndex 一致（N=1,2,0,1 四次）', tabOk,
        steps.join(' ; '));

      // 真实点击路径：走 bindtap → onTabTap → setData，端到端确认
      var tabsNow = q('.rv-tab');
      tabsNow[2].click();
      var clicked = tabState();
      log('D01-02', '点击第 3 个标签（真实 bindtap 链路）后 .rv-tab-on 与 tabIndex 一致',
        clicked.on === 2 && clicked.tabIndex === 2,
        'tabIndex=' + clicked.tabIndex + ' / .rv-tab-on=' + clicked.on
        + ' / class=[' + clicked.cls.join(' ][ ') + ']');
      rv.setData({ tabIndex: 1 });
    }

    // ================= 2. 设置页皮肤卡片 =================
    window.JiugeNav.go('settings');
    var themeIds = ['standard', 'tech', 'girl', 'kids'];
    var skinIds = (set && set.data && set.data.skinList ? set.data.skinList : []).map(function (s) {
      return s.id;
    });
    var skinSteps = [];
    var skinOk = true;
    themeIds.forEach(function (tid) {
      if (window.JiugeThemeCss && typeof window.JiugeThemeCss.change === 'function') {
        window.JiugeThemeCss.change(tid); // 菜单 / 快捷键 / 卡片点击共用的真实换肤入口
      }
      var cells = q('.skin-cell');
      if (!cells.length) {
        skinOk = false;
        skinSteps.push(tid + ' → 未找到 .skin-cell');
        return;
      }
      var onIdx = -1;
      var checked = [];
      var labeled = [];
      var ariaAll = [];
      cells.forEach(function (c, i) {
        if (c.classList.contains('skin-cell-on')) onIdx = i;
        if (c.getAttribute('aria-checked') === 'true') checked.push(i);
        var label = String(c.getAttribute('aria-label') || '');
        ariaAll.push(label);
        if (label.indexOf('已选中') >= 0) labeled.push(i);
      });
      var want = skinIds.indexOf(tid);
      var themeNow = set && set.data ? set.data.theme : '(null)';
      var ok = want >= 0 && themeNow === tid && onIdx === want
        && checked.length === 1 && checked[0] === want
        && labeled.length === 1 && labeled[0] === want;
      if (!ok) skinOk = false;
      skinSteps.push(tid + ' → data.theme=' + themeNow
        + '，期望第 ' + (want + 1) + ' 张卡（' + skinIds[want] + '）'
        + '，实际 .skin-cell-on=第 ' + (onIdx + 1) + ' 张'
        + '，aria-checked=true 的第 [' + checked.map(function (i) { return i + 1; }).join(',') + '] 张'
        + '，aria-label 含「已选中」的第 [' + labeled.map(function (i) { return i + 1; }).join(',') + '] 张'
        + '；aria-label 实录=' + ariaAll.join(' ‖ '));
    });
    out.facts.skinSteps = skinSteps;
    out.facts.skinIds = skinIds;
    log('D01-03', '四套皮肤切换后 .skin-cell-on / aria-checked / aria-label 与 theme 三者一致', skinOk,
      skinSteps.join(' ;; '));
    if (window.JiugeThemeCss && typeof window.JiugeThemeCss.change === 'function') {
      window.JiugeThemeCss.change('standard'); // 复原，避免影响后续断言与观感
    }

    // ================= 3. 回归 B-05：clockText 连刷不打断输入 =================
    window.JiugeNav.go('index');
    var opened = false;
    try {
      if (idx && typeof idx.openCellByKey === 'function') {
        idx.openCellByKey('weather'); // 让编辑浮层真正可见，焦点才落在真实可聚焦元素上
        opened = true;
      }
    } catch (e) { opened = false; }
    var ta = document.querySelector('.sheet-input');
    if (!ta) {
      log('D01-04', 'B-05 · 编辑浮层 textarea 存在', false, '未找到 .sheet-input（浮层已打开=' + opened + '）');
    } else {
      ta.value = '编辑到一半的正文 <script>alert(1)</script>';
      ta.focus();
      try { ta.setSelectionRange(5, 5); } catch (e) { /* 某些控件不支持选区 */ }
      var nodeRef = ta;
      var beforeStart = ta.selectionStart;
      var beforeEnd = ta.selectionEnd;
      var beforeValue = ta.value;
      var visible = ta.getBoundingClientRect().height > 0;

      var t0 = performance.now();
      for (var i = 0; i < 6; i += 1) idx.setData({ clockText: '12:' + (30 + i) });
      var sixMs = performance.now() - t0;

      var sameNode = document.querySelector('.sheet-input') === nodeRef;
      var focused = document.activeElement === nodeRef;
      var selKept = ta.selectionStart === beforeStart && ta.selectionEnd === beforeEnd;
      var valueKept = ta.value === beforeValue;
      var clockEl = document.querySelector('.clock-value');
      var clockText = clockEl ? String(clockEl.textContent).trim() : 'null';

      log('D01-04', 'B-05 · 连刷 clockText × 6 后 DOM 节点引用不变', sameNode,
        '同一节点=' + sameNode + ' / 节点仍挂载=' + document.contains(nodeRef));
      log('D01-05', 'B-05 · 连刷 clockText × 6 后输入框保持焦点', focused,
        'activeElement===textarea : ' + focused + ' / activeElement='
        + (document.activeElement ? document.activeElement.className || document.activeElement.tagName : 'null'));
      log('D01-06', 'B-05 · 连刷 clockText × 6 后选区（start/end）不变', selKept,
        '修复前 ' + beforeStart + '/' + beforeEnd + ' → 现在 ' + ta.selectionStart + '/' + ta.selectionEnd);
      log('D01-07', 'B-05 · 连刷 clockText × 6 后输入框内容未被回写覆盖', valueKept,
        '内容长度 ' + beforeValue.length + ' → ' + ta.value.length + ' / 内容一致=' + valueKept);
      log('D01-08', 'B-05 · 同时 clockText 确实局部刷新到视图（值级 diff 仍生效）', clockText === '12:35',
        '.clock-value=' + clockText + ' / 6 次 setData 共 ' + round3(sixMs) + 'ms / 浮层可见=' + visible);
      out.facts.b05 = {
        sixSetDataMs: round3(sixMs), sameNode: sameNode, focused: focused,
        selKept: selKept, valueKept: valueKept, clockText: clockText, sheetVisible: visible,
      };
      // 附加：今日页是「每秒刷 clockText」的真实场景，且此刻 textarea 正聚焦（最坏情况）
      out.facts.timingIndex = benchSetData(idx, 'D01-14',
        '今日页（每秒时钟刷新真实场景，输入框保持聚焦）60 次 setData 平均耗时 ≤ 16ms',
        '今日页（编辑浮层打开 + 输入框聚焦）');
    }

    // ================= 4. 九格摘要展开态（.dg-row-open + wx:if 正文） =================
    window.JiugeNav.go('review');
    rv.setData({ tabIndex: 1 });
    var digest = rv && rv.data ? (rv.data.digest || {}) : {};
    var rows = Array.isArray(digest.rows) ? digest.rows.slice() : [];
    if (!rows.length) {
      log('D01-09', '九格摘要 .dg-row-open 与 digestOpen[item.key] 一致', false, 'digest.rows 为空，无法验证');
    } else {
      // 只补齐第 1 行的「最近一句」，其余用 store 真实产出的行；整表一次性 setData 建立基准
      var seeded = rows.map(function (r, i) {
        if (i > 0) return r;
        return Object.assign({}, r, { days: r.days || 1, last: '探针最近一句', lastDate: '2026-11-01' });
      });
      rv.setData({ digest: Object.assign({}, digest, { rows: seeded }), digestOpen: {} });

      var key = seeded[0].key;
      var rowEl = null;
      q('.dg-row').forEach(function (el) {
        if (String(el.getAttribute('data-key')) === String(key)) rowEl = el;
      });
      if (!rowEl) {
        log('D01-09', '九格摘要 .dg-row-open 与 digestOpen[item.key] 一致', false,
          '未找到 data-key=' + key + ' 的 .dg-row（DOM .dg-row 数=' + q('.dg-row').length + '）');
      } else {
        function rowState() {
          var el = null;
          q('.dg-row').forEach(function (x) {
            if (String(x.getAttribute('data-key')) === String(key)) el = x;
          });
          if (!el) return { found: false };
          var body = el.querySelector('.dg-last');
          return {
            found: true,
            className: el.className,
            open: el.classList.contains('dg-row-open'),
            bodyExists: !!body,
            bodyDisplay: body ? body.style.display : '(无正文节点)',
            bodyText: body ? String(body.textContent).trim() : '',
          };
        }
        var s0 = rowState();
        rowEl.click(); // 真实 bindtap → onDigestRowTap → setData({digestOpen.<key>:true})
        var s1 = rowState();
        var openFlag = rv.data.digestOpen ? !!rv.data.digestOpen[key] : false;
        q('.dg-row').forEach(function (x) {
          if (String(x.getAttribute('data-key')) === String(key)) x.click();
        });
        var s2 = rowState();
        var closedFlag = rv.data.digestOpen ? !!rv.data.digestOpen[key] : false;

        var bodyOpen = s1.bodyExists && s1.bodyDisplay !== 'none';
        var bodyClosed = !s2.bodyExists || s2.bodyDisplay === 'none';
        var openOk = !s0.open && s1.open === openFlag && openFlag === true
          && s1.bodyExists && s1.bodyText === '探针最近一句';
        var closeOk = s2.open === closedFlag && closedFlag === false && bodyClosed;
        out.facts.digest = { key: key, s0: s0, s1: s1, s2: s2 };
        log('D01-09', '点开一行后 .dg-row-open 出现，且与 digestOpen[item.key] 一致', openOk,
          'key=' + key + ' / 点前 class=[' + s0.className + '] / 点后 class=[' + s1.className
          + '] / digestOpen.' + key + '=' + openFlag);
        log('D01-10', '同节点 wx:if 正文（.dg-last）与行样式同步，不出现「正文展开了、行样式没变」',
          s1.open === bodyOpen && bodyOpen && s1.bodyText === '探针最近一句',
          '.dg-last 存在=' + s1.bodyExists + ' / display=' + (s1.bodyDisplay || '(空)')
          + ' / 正文可见=' + bodyOpen + ' / 行样式已开=' + s1.open
          + ' / 两者一致=' + (s1.open === bodyOpen) + ' / 文本=' + s1.bodyText);
        log('D01-11', '再次点击收起后 .dg-row-open 移除且正文隐藏', closeOk,
          'class=[' + s2.className + '] / digestOpen.' + key + '=' + closedFlag
          + ' / .dg-last display=' + s2.bodyDisplay);
      }
    }

    // ================= 5. 372 格年历场景：60 次 setData 耗时 =================
    window.JiugeNav.go('review');
    try { if (typeof rv.refreshPixels === 'function') rv.refreshPixels(); } catch (e) { /* 已在 onShow 刷过 */ }
    out.facts.timing = benchSetData(rv, 'D01-12', '372 格年历下 60 次 setData 平均耗时 ≤ 16ms（一帧预算内）',
      'review 页（372 格年历）');

    // ================= 6. 循环实例回收（被 keyed 列表删掉的嵌套 wx:for） =================
    window.JiugeNav.go('review');
    try { if (typeof rv.refreshPixels === 'function') rv.refreshPixels(); } catch (e) { /* ignore */ }
    var vw = rv._view;
    if (!vw || !Array.isArray(vw.loops)) {
      log('D01-13', '被删掉的嵌套 wx:for 从 ctx.loops 回收', false, '拿不到 view.loops');
    } else {
      var pixelsBefore = q('.pixel-cell').length;
      var loopsBefore = vw.loops.length;
      // pixelMonths 是 12 项 keyed 列表，每项内嵌一个 item.cells 的 wx:for（12 个嵌套 loop）
      rv.setData({ pixelMonths: [] });
      var loopsAfter = vw.loops.length;
      var stale = 0;
      vw.loops.forEach(function (l) {
        if (!l || !l.wrap || l.wrap.isConnected === false) stale += 1;
      });
      var pixelsAfter = q('.pixel-cell').length;
      log('D01-13', '被删掉的嵌套 wx:for 循环实例从 ctx.loops 回收（不再对脱离 DOM 的子树求值）',
        stale === 0 && (loopsBefore - loopsAfter) >= 12,
        '清空前 loops=' + loopsBefore + ' / 清空后 loops=' + loopsAfter
        + ' / 本次回收 ' + (loopsBefore - loopsAfter) + ' 个'
        + ' / 仍留在注册表但已脱离 DOM 的 loop=' + stale
        + ' / DOM 年历格 ' + pixelsBefore + ' → ' + pixelsAfter);
      try { if (typeof rv.refreshPixels === 'function') rv.refreshPixels(); } catch (e) { /* ignore */ }
      out.facts.loopReclaim = {
        loopsBefore: loopsBefore, loopsAfter: loopsAfter,
        reclaimed: loopsBefore - loopsAfter, staleStillRegistered: stale,
      };
    }

    // ================= 7. 影响面抽查：另两处同域绑定（今日页金钱分类 / 坚持页里程碑预设） =================
    // 今日页 index.wxml:272 —— class="money-cat {{moneyCategory === item.id ? 'money-cat-on' : ''}}"
    window.JiugeNav.go('index');
    var cats = q('.money-cat');
    if (cats.length < 2) {
      log('D01-15', '今日页金钱分类 .money-cat-on 跟随真实点击', false, '.money-cat 数量=' + cats.length);
    } else {
      var catIds = (idx.data.moneyCategories || []).map(function (c) { return c.id; });
      var catSteps = [];
      var catOk = true;
      [1, 2, 0].forEach(function (i) {
        var list = q('.money-cat');
        if (i >= list.length) return;
        list[i].click(); // 真实 bindtap → onPickMoneyCategory → setData({moneyCategory})
        var now = q('.money-cat');
        var onIdx = -1;
        now.forEach(function (el, k) { if (el.classList.contains('money-cat-on')) onIdx = k; });
        var want = catIds.indexOf(idx.data.moneyCategory);
        catSteps.push('点第 ' + (i + 1) + ' 个 → data.moneyCategory=' + idx.data.moneyCategory
          + '（0 基 ' + want + '）/.money-cat-on 落在 0 基 ' + onIdx);
        if (onIdx !== want) catOk = false;
      });
      log('D01-15', '今日页金钱分类 .money-cat-on 与 data.moneyCategory 一致（点 2/3/1 三轮）', catOk,
        catSteps.join(' ; '));
    }

    // 坚持页 habit.wxml:104 —— class="ms-preset {{msDays == item ? 'ms-preset-on' : ''}}"
    window.JiugeNav.go('habit');
    var hp = rt.byId('habit');
    var presets = q('.ms-preset');
    if (!hp || presets.length < 2) {
      log('D01-16', '坚持页里程碑预设 .ms-preset-on 跟随真实点击', false,
        'habit 实例=' + !!hp + ' / .ms-preset 数量=' + presets.length);
    } else {
      var presetVals = (hp.data.msPresets || []);
      var preSteps = [];
      var preOk = true;
      [1, 0].forEach(function (i) {
        var list = q('.ms-preset');
        if (i >= list.length) return;
        list[i].click(); // 真实 bindtap → onMsPreset → setData({msDays})
        var now = q('.ms-preset');
        var onIdx = -1;
        now.forEach(function (el, k) { if (el.classList.contains('ms-preset-on')) onIdx = k; });
        var want = -1;
        presetVals.forEach(function (v, k) {
          if (String(v) === String(hp.data.msDays)) want = k;
        });
        preSteps.push('点第 ' + (i + 1) + ' 个 → data.msDays=' + hp.data.msDays
          + '（0 基 ' + want + '）/.ms-preset-on 落在 0 基 ' + onIdx);
        if (onIdx !== want) preOk = false;
      });
      log('D01-16', '坚持页里程碑预设 .ms-preset-on 与 data.msDays 一致（点 2/1 两轮）', preOk,
        preSteps.join(' ; ') + ' / 预设值=[' + presetVals.join(',') + ']');
    }

    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    window.JiugeNav.go('index');
  } catch (e) {
    log('D01-ERR', '探针执行异常', false, String((e && e.stack) || e));
  }
  return out;
}

module.exports = { d01Probe: d01Probe };
