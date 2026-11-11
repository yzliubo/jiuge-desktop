'use strict';
/**
 * D01 独立回归探针 —— QA（严过关）自建。
 *
 * 与工程师的 tests/d01-probe.js **零共享断言**：本文件只用产品源码的公开行为
 * （Page 实例、真实 DOM 点击、真实 input 事件、window.JiugeWxmlRuntime.mount）
 * 从外部观察，不读工程师落盘的 JSON、不引用其结论。
 *
 * 覆盖五类：
 *   QA-01..05/26  主路径（回看三标签 / 设置四皮肤 / 坚持里程碑 / 今日金钱分类 / 刷新不回退）
 *   QA-06..10     B-05 焦点回归（节点引用 / activeElement / 选区 / 值 / 时钟仍刷新）
 *   QA-11..19     破坏性自建用例（嵌套 wx:for、keyed 增删改序同批标量、循环内 wx:if、
 *                 回收不误伤 / 真回收）
 *   QA-20..24     真实跨页与高频（隐藏视图存活 loop、100 次 setData、值级 diff、真实键盘）
 *   QA-25         372 格年历 60 次 setData 性能（avg/P50/P95/max）
 *   QA-28         负向对照：抽掉 loops 通道必须复现缺陷（证明断言真的能抓到问题）
 *
 * 该函数会被 toString() 注入渲染主世界执行，**不得引用闭包外任何变量**。
 */
function d01QaProbe() {
  var out = { checks: [], facts: {} };
  var t0 = Date.now();

  function log(id, name, ok, detail) {
    out.checks.push({ id: id, name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  }
  function q(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function r3(n) { return Math.round(Number(n) * 1000) / 1000; }
  function onInfo(list, clsName) {
    var on = -1; var count = 0;
    list.forEach(function (el, i) {
      if (el.classList && el.classList.contains(clsName)) { on = i; count += 1; }
    });
    return { on: on, count: count, n: list.length };
  }
  function displayOf(el) { return el ? (el.style.display || '(空)') : '(无节点)'; }
  function visible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    var r = el.getBoundingClientRect();
    return r.height > 0 && r.width > 0;
  }
  function section(name, fn) {
    try { fn(); } catch (e) {
      log(name + '-ERR', name + ' 段内异常', false, String((e && e.stack) || e));
    }
  }
  function pct(sorted, p) {
    if (!sorted.length) return 0;
    var i = Math.ceil(p / 100 * sorted.length) - 1;
    if (i < 0) i = 0;
    if (i > sorted.length - 1) i = sorted.length - 1;
    return sorted[i];
  }

  // ---------------------------------------------------------------- 合成视图工具
  var synthHosts = [];
  function makeHost(id) {
    var h = document.createElement('div');
    h.id = id;
    // 不用 display:none / visibility:hidden：isConnected 与布局都要保持“真实在文档中”
    h.setAttribute('style', 'position:absolute;left:-20000px;top:0;width:480px;height:40px;overflow:hidden;');
    document.body.appendChild(h);
    synthHosts.push(h);
    return h;
  }
  function mountSynth(host, wxml, data) {
    var page = { data: data };
    var view = window.JiugeWxmlRuntime.mount(page, wxml, host);
    return { page: page, view: view };
  }
  function dropHosts() {
    synthHosts.forEach(function (h) {
      if (h.parentNode) h.parentNode.removeChild(h);
    });
    synthHosts = [];
  }

  try {
    var RT = window.JiugeWxmlRuntime;
    var rt = window.JiugeRuntime;
    if (!RT || !rt || typeof rt.byId !== 'function' || typeof RT.mount !== 'function') {
      log('QA-00', '渲染进程公开 API 可用（JiugeRuntime.byId + JiugeWxmlRuntime.mount）', false,
        'JiugeWxmlRuntime=' + !!RT + ' / JiugeRuntime=' + !!rt);
      return out;
    }
    var rv = rt.byId('review');
    var idx = rt.byId('index');
    var st = rt.byId('settings');
    var hb = rt.byId('habit');
    log('QA-00', 'renderer 公开 API 可用 + 四个 Page 实例存在', !!(rv && idx && st && hb),
      'review=' + !!rv + ' index=' + !!idx + ' settings=' + !!st + ' habit=' + !!hb);

    // ================================================================
    // 1. 主路径：回看页三标签（真实点击，走 bindtap → onTabTap → setData）
    // ================================================================
    section('QA-01', function () {
      window.JiugeNav.go('review');
      var steps = []; var ok = true;
      [1, 2, 0, 1].forEach(function (target) {
        var tabs = q('.rv-tab');
        if (tabs.length !== 3) { ok = false; steps.push('tab 数=' + tabs.length); return; }
        tabs[target].click();
        var after = q('.rv-tab');
        var info = onInfo(after, 'rv-tab-on');
        var ink = document.querySelector('.rv-ink');
        var inkTf = ink ? String(ink.getAttribute('style') || '') : '(无)';
        var inkWant = 'translateX(' + (rv.data.tabIndex * 100) + '%)';
        steps.push('点第 ' + (target + 1) + ' 个 → tabIndex=' + rv.data.tabIndex
          + ' / .rv-tab-on 唯一=' + (info.count === 1) + ' 落在 0 基 ' + info.on
          + ' / .rv-ink 含 ' + inkWant + '=' + (inkTf.indexOf(inkWant) >= 0));
        if (rv.data.tabIndex !== target || info.on !== target || info.count !== 1) ok = false;
        if (inkTf.indexOf(inkWant) < 0) ok = false;
      });
      out.facts.reviewTabs = steps;
      log('QA-01', '回看页真实点击四个标签：tabIndex / .rv-tab-on 唯一性 / .rv-ink 位移三者同步', ok, steps.join(' ; '));
    });

    // ================================================================
    // 2. 主路径：设置页四套皮肤（真实点击 .skin-cell）
    // ================================================================
    section('QA-02', function () {
      window.JiugeNav.go('settings');
      var ids = ['tech', 'girl', 'kids', 'standard'];
      var steps = []; var ok = true;
      ids.forEach(function (id) {
        var cell = document.querySelector('.skin-cell[data-id="' + id + '"]');
        if (!cell) { ok = false; steps.push(id + ' → 无对应卡片'); return; }
        if (!visible(cell)) { ok = false; steps.push(id + ' → 卡片不可见'); }
        cell.click();
        var cells = q('.skin-cell');
        var on = onInfo(cells, 'skin-cell-on');
        var checkedIdx = []; var labelIdx = [];
        cells.forEach(function (c, i) {
          if (c.getAttribute('aria-checked') === 'true') checkedIdx.push(i);
          if (String(c.getAttribute('aria-label') || '').indexOf('已选中') >= 0) labelIdx.push(i);
        });
        var want = cells.map(function (c) { return c.getAttribute('data-id'); }).indexOf(id);
        var one = on.count === 1 && on.on === want
          && checkedIdx.length === 1 && checkedIdx[0] === want
          && labelIdx.length === 1 && labelIdx[0] === want;
        if (st.data.theme !== id) one = false;
        if (!one) ok = false;
        steps.push('点 ' + id + ' → data.theme=' + st.data.theme
          + ' / .skin-cell-on 数=' + on.count + ' 位置=' + on.on + '（期望 ' + want + '）'
          + ' / aria-checked=true=[' + checkedIdx.join(',') + ']'
          + ' / 含「已选中」=[' + labelIdx.join(',') + ']');
      });
      out.facts.skins = steps;
      log('QA-02', '设置页逐个点四套皮肤：.skin-cell-on 恒唯一且等于 theme，aria-checked / aria-label 同步', ok, steps.join(' ;; '));
    });

    // ================================================================
    // 3. 主路径：坚持页里程碑预设（先真实点「+ 添加奖励」打开浮层）
    // ================================================================
    section('QA-03', function () {
      window.JiugeNav.go('habit');
      var add = document.querySelector('.milestone-add');
      if (!add) { log('QA-03', '坚持页里程碑预设跟随点击', false, '未找到 .milestone-add'); return; }
      add.click();
      var sheet = document.querySelector('.ms-sheet');
      var sheetVisible = visible(sheet);
      var presets = q('.ms-preset');
      if (presets.length < 2) {
        log('QA-03', '坚持页里程碑预设跟随点击', false, '.ms-preset 数=' + presets.length + ' / 浮层可见=' + sheetVisible);
        return;
      }
      var steps = []; var ok = true;
      [1, 0, 4, 2].forEach(function (i) {
        if (i >= presets.length) return;
        q('.ms-preset')[i].click();
        var now = q('.ms-preset');
        var info = onInfo(now, 'ms-preset-on');
        var want = -1;
        (hb.data.msPresets || []).forEach(function (v, k) {
          if (String(v) === String(hb.data.msDays)) want = k;
        });
        steps.push('点第 ' + (i + 1) + ' 个（' + (hb.data.msPresets || [])[i] + ' 天）→ msDays=' + hb.data.msDays
          + ' / .ms-preset-on 唯一=' + (info.count === 1) + ' 位置=' + info.on + '（期望 ' + want + '）');
        if (info.on !== want || info.count !== 1) ok = false;
      });
      out.facts.habitPresets = { sheetVisible: sheetVisible, steps: steps };
      log('QA-03', '坚持页浮层可见 + 逐个点四个预设：msDays 变化后 .ms-preset-on 唯一且跟随', ok && sheetVisible,
        '浮层可见=' + sheetVisible + ' ; ' + steps.join(' ; '));
      window.JiugeNav.go('habit');
    });

    // ================================================================
    // 4. 主路径：今日页金钱分类（先真实打开「金钱」格，再点分类）
    // ================================================================
    section('QA-04', function () {
      window.JiugeNav.go('index');
      idx.openCellByKey('money'); // openCell → openCellByKey，同一入口
      var panel = document.querySelector('.money-panel');
      var panelVisible = visible(panel);
      var cats = q('.money-cat');
      var ids = (idx.data.moneyCategories || []).map(function (c) { return c.id; });
      if (cats.length < 2) {
        log('QA-04', '今日页金钱分类跟随真实点击', false, '.money-cat 数=' + cats.length + ' / 面板可见=' + panelVisible);
        return;
      }
      var steps = []; var ok = true;
      [1, 2, 0].forEach(function (i) {
        var list = q('.money-cat');
        if (i >= list.length) return;
        list[i].click();
        var now = q('.money-cat');
        var info = onInfo(now, 'money-cat-on');
        var want = ids.indexOf(idx.data.moneyCategory);
        steps.push('点第 ' + (i + 1) + ' 个 → moneyCategory=' + idx.data.moneyCategory
          + '（0 基 ' + want + '）/ .money-cat-on 唯一=' + (info.count === 1) + ' 位置=' + info.on);
        if (info.on !== want || info.count !== 1) ok = false;
      });
      out.facts.moneyCats = { panelVisible: panelVisible, count: cats.length, steps: steps };
      log('QA-04', '今日页金钱分类：面板可见 + 三次真实点击后 .money-cat-on 唯一且跟随 data.moneyCategory',
        ok && panelVisible, '面板可见=' + panelVisible + ' / 分类数=' + cats.length + ' ; ' + steps.join(' ; '));
    });

    // ================================================================
    // 5. 真实键盘输入：派发 input 事件后再刷时钟，输入不丢、光标不跳
    // ================================================================
    section('QA-05', function () {
      var note = document.querySelector('.money-note-input');
      if (!note) { log('QA-05', '真实键盘输入后刷时钟不丢输入/不跳光标', false, '未找到 .money-note-input'); return; }
      if (!visible(note)) { log('QA-05', '真实键盘输入后刷时钟不丢输入/不跳光标', false, '备注输入框不可见'); return; }
      var typed = '买咖啡 12 元';
      note.focus();
      note.value = typed;
      try { note.setSelectionRange(3, 3); } catch (e) { /* ignore */ }
      try {
        note.dispatchEvent(new InputEvent('input', { bubbles: true, data: typed, inputType: 'insertText' }));
      } catch (e) {
        var ev = document.createEvent('Event');
        ev.initEvent('input', true, false);
        note.dispatchEvent(ev);
      }
      var noteAfterInput = note;
      var dataAfterInput = idx.data.moneyNote;
      var caret0 = note.selectionStart;
      for (var i = 0; i < 3; i += 1) idx.setData({ clockText: '14:0' + i });
      var sameNode = document.querySelector('.money-note-input') === noteAfterInput;
      var focused = document.activeElement === noteAfterInput;
      var valueKept = note.value === typed;
      var caretKept = note.selectionStart === caret0 && note.selectionEnd === caret0;
      var dataKept = idx.data.moneyNote === typed;
      var clockEl = document.querySelector('.clock-value');
      var clockText = clockEl ? String(clockEl.textContent).trim() : 'null';
      out.facts.keyboard = {
        dataAfterInput: dataAfterInput, sameNode: sameNode, focused: focused,
        valueKept: valueKept, caret0: caret0, caretNow: note.selectionStart, clockText: clockText,
      };
      log('QA-05', '真实 input 事件 + 3 次时钟 setData：节点/焦点/选区/值/data 全不变，时钟仍刷新',
        sameNode && focused && valueKept && caretKept && dataKept && clockText === '14:02'
        && dataAfterInput === typed,
        '同节点=' + sameNode + ' 焦点=' + focused + ' 值不变=' + valueKept
        + ' 选区 ' + caret0 + '→' + note.selectionStart + ' data.moneyNote=' + JSON.stringify(dataAfterInput)
        + ' .clock-value=' + clockText);
    });

    // ================================================================
    // 6. B-05：编辑浮层 textarea 连刷 6 次 clockText 三重不变 + 时钟真刷新
    // ================================================================
    section('QA-06', function () {
      window.JiugeNav.go('index');
      if (typeof idx.closeCell === 'function') idx.closeCell();
      idx.openCellByKey('weather');
      var ta = document.querySelector('.sheet-input');
      if (!ta) { log('QA-06', 'B-05 · 浮层 textarea 存在且可见', false, '未找到 .sheet-input'); return; }
      var sheet = document.querySelector('.sheet');
      var taVisible = visible(ta);
      ta.value = '编辑到一半的正文 <b>&amp;</b> 与表情 🍵';
      ta.focus();
      try { ta.setSelectionRange(5, 5); } catch (e) { /* ignore */ }
      var nodeRef = ta;
      var start0 = ta.selectionStart;
      var end0 = ta.selectionEnd;
      var value0 = ta.value;
      for (var i = 0; i < 6; i += 1) idx.setData({ clockText: '12:' + (30 + i) });
      var sameNode = document.querySelector('.sheet-input') === nodeRef;
      var focused = document.activeElement === nodeRef;
      var selKept = ta.selectionStart === start0 && ta.selectionEnd === end0;
      var valueKept = ta.value === value0;
      var clockText = String((document.querySelector('.clock-value') || {}).textContent || '').trim();
      out.facts.b05 = {
        sheetVisible: visible(sheet), taVisible: taVisible, sameNode: sameNode, focused: focused,
        sel: start0 + '/' + end0 + ' → ' + ta.selectionStart + '/' + ta.selectionEnd,
        valueKept: valueKept, clockText: clockText,
      };
      log('QA-06', 'B-05 · 编辑浮层真实可见、textarea 可聚焦且已填入内容', taVisible && ta.value.length > 0,
        '浮层可见=' + visible(sheet) + ' / textarea 可见=' + taVisible
        + ' / 填入内容长度=' + ta.value.length + ' / 聚焦=' + (document.activeElement === ta));
      log('QA-07', 'B-05 · 连刷 clockText × 6 后 textarea 节点引用不变且仍在文档中', sameNode && document.contains(nodeRef),
        '同节点=' + sameNode + ' / 仍挂载=' + document.contains(nodeRef));
      log('QA-08', 'B-05 · 连刷 6 次后 activeElement 仍是该 textarea', focused,
        'activeElement=' + (document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : 'null'));
      log('QA-09', 'B-05 · 连刷 6 次后选区 start/end 不变', selKept,
        '5/5 → ' + ta.selectionStart + '/' + ta.selectionEnd);
      log('QA-10', 'B-05 · 连刷 6 次后手输内容未被回写覆盖', valueKept, '长度 ' + value0.length + ' → ' + ta.value.length);
      log('QA-11', 'B-05 · 同一批 setData 里 clockText 确实局部刷新（值级 diff 仍生效）', clockText === '12:35',
        '.clock-value=' + clockText);
    });

    // ================================================================
    // 7. 破坏性：嵌套 wx:for（外层标量变化，内层类名跟随）
    // ================================================================
    section('QA-12', function () {
      var host = makeHost('qa-synth-nested');
      var wxml = '<view class="qa-n">'
        + '<view wx:for="{{groups}}" wx:for-item="g" wx:for-index="gi" wx:key="id"'
        + ' class="qa-g {{sel === g.id ? \'qa-g-on\' : \'\'}}">'
        + '<text class="qa-gi">{{gi}}</text>'
        + '<view wx:for="{{g.cells}}" wx:for-item="c" wx:key="d"'
        + ' class="qa-c {{sel === g.id ? \'qa-c-on\' : \'\'}}">{{c.d}}</view>'
        + '</view></view>';
      var s = mountSynth(host, wxml, {
        sel: 'b',
        groups: [
          { id: 'a', cells: [{ d: 1 }, { d: 2 }] },
          { id: 'b', cells: [{ d: 3 }] }
        ]
      });
      // 逐组观察（不用全局下标，避免组内格数不同造成误判）
      function snap() {
        var groups = q('.qa-g', host);
        return {
          n: groups.length,
          c: q('.qa-c', host).length,
          loops: s.view.loops.length,
          gOn: groups.map(function (g) { return g.classList.contains('qa-g-on'); }),
          // 每组内每个格子是否带 on
          cOn: groups.map(function (g) {
            return q('.qa-c', g).map(function (c) { return c.classList.contains('qa-c-on'); });
          }),
          gi: q('.qa-gi', host).map(function (e) { return String(e.textContent).trim(); })
        };
      }
      var a = snap();
      var baseOk = a.n === 2 && a.c === 3 && a.loops === 3
        && JSON.stringify(a.gOn) === JSON.stringify([false, true])
        && JSON.stringify(a.cOn) === JSON.stringify([[false, false], [true]])
        && a.gi.join(',') === '0,1';
      s.page.data.sel = 'a';
      s.view.update();
      var b = snap();
      s.view.update(); // 再刷一次：不得产生重复实例
      var c = snap();
      var followOk = b.n === 2 && b.c === 3
        && JSON.stringify(b.gOn) === JSON.stringify([true, false])
        && JSON.stringify(b.cOn) === JSON.stringify([[true, true], [false]])
        && b.gi.join(',') === '0,1';
      var noDup = c.n === 2 && c.c === 3 && c.loops === 3;
      out.facts.nested = { base: baseOk, follow: followOk, noDup: noDup, loops: c.loops, cells: c.c.length, gOn: b.gOn, cOn: b.cOn };
      log('QA-12', '嵌套 wx:for：初始结构与 loop 注册数正确（外 1 + 内 2 = 3）', baseOk,
        '组数=' + a.n + ' 格数=' + a.c + ' loops=' + a.loops + ' gi=' + a.gi.join(',')
        + ' 外层 on=' + JSON.stringify(a.gOn) + ' 内层 on=' + JSON.stringify(a.cOn));
      log('QA-13', '嵌套 wx:for：外层标量变化（数组不变）时内外两层 class 都跟随，且重复 update 无重复实例',
        followOk && noDup,
        '改 sel=a 后 外层 on=' + JSON.stringify(b.gOn) + ' / 内层 on=' + JSON.stringify(b.cOn)
        + ' / 重刷后 组=' + c.n + ' 格=' + c.c + ' loops=' + c.loops);
      s.view.destroy();
    });

    // ================================================================
    // 8. 破坏性：keyed 列表重排 / 删除 / 新增，且与标量变化同一次 setData
    // ================================================================
    section('QA-14', function () {
      var host = makeHost('qa-synth-keyed');
      var wxml = '<view class="qa-k">'
        + '<view wx:for="{{rows}}" wx:key="id" class="qa-row {{sel === item.id ? \'qa-on\' : \'\'}}"'
        + ' data-id="{{item.id}}">{{item.id}}-{{index}}</view>'
        + '</view>';
      var s = mountSynth(host, wxml, {
        sel: 'a',
        rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
      });
      function read() {
        var rows = q('.qa-row', host);
        return {
          ids: rows.map(function (r) { return r.getAttribute('data-id'); }),
          texts: rows.map(function (r) { return String(r.textContent).trim(); }),
          on: onInfo(rows, 'qa-on'),
          count: rows.length
        };
      }
      var r0 = read();
      // 重排 + 同批改标量（一次 update）
      s.page.data.rows = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
      s.page.data.sel = 'b';
      s.view.update();
      var r1 = read();
      // 删除 + 同批改标量
      s.page.data.rows = [{ id: 'a' }, { id: 'c' }];
      s.page.data.sel = 'c';
      s.view.update();
      var r2 = read();
      // 新增 + 同批改标量
      s.page.data.rows = [{ id: 'a' }, { id: 'c' }, { id: 'd' }];
      s.page.data.sel = 'd';
      s.view.update();
      var r3 = read();

      var reorderOk = r1.ids.join(',') === 'c,a,b' && r1.texts.join(',') === 'c-0,a-1,b-2'
        && r1.on.on === 2 && r1.on.count === 1;
      var removeOk = r2.ids.join(',') === 'a,c' && r2.count === 2 && r2.on.on === 1 && r2.on.count === 1
        && r2.ids.indexOf('b') < 0;
      var addOk = r3.ids.join(',') === 'a,c,d' && r3.count === 3 && r3.on.on === 2 && r3.on.count === 1;
      out.facts.keyed = { r0: r0, r1: r1, r2: r2, r3: r3 };
      log('QA-14', 'keyed 重排 + 同批标量：DOM 顺序/index 文本正确、.qa-on 唯一跟随', reorderOk,
        '初始 ' + r0.ids.join(',') + ' → 重排后 ' + r1.ids.join(',') + ' (文本 ' + r1.texts.join(',')
        + ')，on 0 基 ' + r1.on.on);
      log('QA-15', 'keyed 删除 + 同批标量：残留节点清零、class 跟随', removeOk,
        '删除后 [' + r2.ids.join(',') + ']，节点数 ' + r2.count + '，on 0 基 ' + r2.on.on);
      log('QA-16', 'keyed 新增 + 同批标量：新增项参与排序与 class 计算', addOk,
        '新增后 [' + r3.ids.join(',') + ']，on 0 基 ' + r3.on.on);
      s.view.destroy();
    });

    // ================================================================
    // 9. 破坏性：循环项内 wx:if（数组变化 / 仅标量变化两条通道）
    // ================================================================
    section('QA-17', function () {
      var host = makeHost('qa-synth-cond');
      var wxml = '<view class="qa-cond">'
        + '<view wx:for="{{items}}" wx:key="id" class="qa-ci {{sel === item.id ? \'qa-ci-on\' : \'\'}}">'
        + '<text class="qa-yes" wx:if="{{item.show}}">S-{{item.id}}</text>'
        + '<text class="qa-no" wx:else>H-{{item.id}}</text>'
        + '</view>'
        + '<view wx:for="{{rows}}" wx:key="id" class="qa-cr">'
        + '<text class="qa-only" wx:if="{{sel2 === item.id}}">ON-{{item.id}}</text>'
        + '</view></view>';
      var s = mountSynth(host, wxml, {
        sel: 'x', sel2: 'r1',
        items: [{ id: 'x', show: true }, { id: 'y', show: false }],
        rows: [{ id: 'r1' }, { id: 'r2' }]
      });
      function state(id) {
        var ci = q('.qa-ci', host);
        var el = null;
        ci.forEach(function (n) { if (String(n.textContent).indexOf(id) >= 0) el = n; });
        var yes = el ? el.querySelector('.qa-yes') : null;
        var no = el ? el.querySelector('.qa-no') : null;
        return { yesDisp: displayOf(yes), noDisp: displayOf(no), yesText: yes ? String(yes.textContent).trim() : '' };
      }
      var s0x = state('x'); var s0y = state('y');
      // 注意：display 未显式设置时为 '(空)'，即「可见」
      var initOk = s0x.yesDisp !== 'none' && s0x.noDisp === 'none'
        && s0y.noDisp !== 'none' && s0y.yesDisp === 'none';
      // 数组变化 + 标量变化
      s.page.data.items = [{ id: 'x', show: false }, { id: 'y', show: true }];
      s.page.data.sel = 'y';
      s.view.update();
      var s1x = state('x'); var s1y = state('y');
      var arrOk = s1x.yesDisp === 'none' && s1x.noDisp !== 'none'
        && s1y.yesDisp !== 'none' && s1y.noDisp === 'none';
      // 仅标量变化：condGroup 通道路径
      var only0 = q('.qa-only', host).map(function (e) { return displayOf(e); });
      s.page.data.sel2 = 'r2';
      s.view.update();
      var only1 = q('.qa-only', host).map(function (e) { return displayOf(e); });
      var scalarOk = only0[0] !== 'none' && only0[1] === 'none'
        && only1[0] === 'none' && only1[1] !== 'none';
      out.facts.loopCond = { initOk: initOk, arrOk: arrOk, scalarOk: scalarOk, only0: only0, only1: only1 };
      log('QA-18', '循环项内 wx:if（数组+标量同批变化）：条件显隐随 item.show 正确翻转', initOk && arrOk,
        'x: ' + s0x.yesDisp + '/' + s0x.noDisp + ' → ' + s1x.yesDisp + '/' + s1x.noDisp
        + ' ; y: ' + s0y.yesDisp + '/' + s0y.noDisp + ' → ' + s1y.yesDisp + '/' + s1y.noDisp);
      log('QA-19', '循环项内 wx:if（仅外层标量变化，数组 signature 不变）：condGroup 通道未被 refresh 破坏',
        scalarOk, '.qa-only display 前=[' + only0.join(',') + '] 后=[' + only1.join(',') + ']');
      s.view.destroy();
    });

    // ================================================================
    // 10. 破坏性：回收不误伤存活 loop（隐藏但仍在文档中）；真 removed 才回收
    // ================================================================
    section('QA-20', function () {
      var host = makeHost('qa-synth-reclaim');
      var wxml = '<view class="qa-r">'
        + '<view wx:for="{{groups}}" wx:for-item="g" wx:key="id" class="qa-outer">'
        + '<view wx:for="{{g.cells}}" wx:for-item="c" wx:key="d" class="qa-inner">{{c.d}}</view>'
        + '</view>'
        + '<view class="qa-otherbox">'
        + '<view wx:for="{{other}}" wx:key="id" class="qa-other">{{item}}</view>'
        + '</view></view>';
      var s = mountSynth(host, wxml, {
        groups: [{ id: 'g1', cells: [{ d: 1 }, { d: 2 }] }, { id: 'g2', cells: [{ d: 3 }] }],
        other: ['o1', 'o2']
      });
      var loops0 = s.view.loops.length; // 1(groups) + 2(inner) + 1(other) = 4
      // 用 display:none 隐藏“其它视图”的容器，但节点仍在文档中
      var otherBox = host.querySelector('.qa-otherbox');
      otherBox.style.display = 'none';
      s.page.data.other = ['o1', 'o2'];
      s.view.update();
      var loops1 = s.view.loops.length;
      var otherCount1 = q('.qa-other', host).length;
      var disconnected1 = s.view.loops.filter(function (l) { return !l || !l.wrap || l.wrap.isConnected === false; }).length;
      var hideOk = loops1 === loops0 && otherCount1 === 2 && disconnected1 === 0;

      // 真正清空 groups：内层 loop 的 wrap 随父项一起脱离 DOM，应当被回收
      s.page.data.groups = [];
      s.view.update();
      var loops2 = s.view.loops.length;
      var outerDom = q('.qa-outer', host).length;
      var disconnected2 = s.view.loops.filter(function (l) { return !l || !l.wrap || l.wrap.isConnected === false; }).length;
      var reclaimOk = loops2 === loops0 - 2 && outerDom === 0 && disconnected2 === 0
        && q('.qa-other', host).length === 2;
      out.facts.reclaimSynth = {
        loops0: loops0, loops1: loops1, loops2: loops2,
        otherCount1: otherCount1, outerDom: outerDom, disconnected1: disconnected1, disconnected2: disconnected2
      };
      log('QA-20', '回收不误伤：display:none 隐藏但仍在文档中的 loop 不被摘掉',
        hideOk, 'loops ' + loops0 + ' → ' + loops1 + ' / .qa-other 数=' + otherCount1
        + ' / 脱离 DOM 的 loop=' + disconnected1);
      log('QA-21', '真回收：父项被删后其内嵌 loop 被摘掉（-2），存活 loop 与 DOM 不受影响',
        reclaimOk, 'loops ' + loops1 + ' → ' + loops2 + ' / .qa-outer 数=' + outerDom
        + ' / 脱离 DOM 的 loop=' + disconnected2 + ' / .qa-other 数=' + q('.qa-other', host).length);
      s.view.destroy();
    });

    // ================================================================
    // 11. 真实跨页：隐藏页面（section[hidden] = display:none）的 loop 不被回收
    // ================================================================
    section('QA-22', function () {
      window.JiugeNav.go('settings');
      var view = idx._view;
      if (!view) { log('QA-22', '隐藏页面存活 loop 不被回收', false, 'index._view 为空'); return; }
      var loops0 = view.loops.length;
      var cats0 = q('.money-cat').length;
      var idxSection = document.querySelector('section.page[data-page="index"]');
      var hiddenNow = idxSection ? idxSection.hasAttribute('hidden') : false;
      idx.setData({ clockText: '23:5' + (loops0 % 10) }); // 模拟后台时钟仍在刷
      var loops1 = view.loops.length;
      var connected = view.loops.filter(function (l) { return l && l.wrap && l.wrap.isConnected !== false; }).length;
      var cats1 = q('.money-cat').length;
      var ok = loops1 === loops0 && connected === loops1 && cats1 === cats0 && hiddenNow;
      out.facts.crossPage = { loops0: loops0, loops1: loops1, connected: connected, cats0: cats0, cats1: cats1, hidden: hiddenNow };
      log('QA-22', '真实跨页：index 被 [hidden] 隐藏时 setData 不回收其 loop，DOM 不丢', ok,
        '隐藏=' + hiddenNow + ' / loops ' + loops0 + ' → ' + loops1 + '（全部 isConnected=' + (connected === loops1) + '）'
        + ' / .money-cat ' + cats0 + ' → ' + cats1);
    });

    // ================================================================
    // 12. 真实高频：100 次 setData 不抛异常 / loops 不增长 / 无重复 DOM
    // ================================================================
    section('QA-23', function () {
      window.JiugeNav.go('index');
      var view = idx._view;
      var loops0 = view.loops.length;
      var catIds = (idx.data.moneyCategories || []).map(function (c) { return c.id; });
      var cellNode = q('.money-cat')[0];
      var err = '';
      var t = performance.now();
      try {
        for (var i = 0; i < 100; i += 1) {
          idx.setData({ clockText: '08:' + (10 + (i % 50)) });
          if (i % 10 === 0 && catIds.length) idx.setData({ moneyCategory: catIds[(i / 10) % catIds.length] });
        }
      } catch (e) { err = String((e && e.message) || e); }
      var ms = performance.now() - t;
      var loops1 = view.loops.length;
      var cats = q('.money-cat');
      var on = onInfo(cats, 'money-cat-on');
      var sameCell = q('.money-cat')[0] === cellNode;
      var entries = q('.money-entry').length;
      var entriesWant = (idx.data.moneyEntries || []).length;
      var study = q('.study-item').length;
      var studyWant = (idx.data.studyItems || []).length;
      var ok = !err && loops1 === loops0 && cats.length === catIds.length && on.count === 1
        && sameCell && entries === entriesWant && study === studyWant;
      out.facts.stress = {
        ms: r3(ms), loops0: loops0, loops1: loops1, cats: cats.length, onCount: on.count,
        sameFirstNode: sameCell, entries: entries, entriesWant: entriesWant, study: study, studyWant: studyWant, err: err
      };
      log('QA-23', '高频 110 次 setData（含标量+分类切换）：无异常、ctx.loops 不增长、无重复/丢失 DOM 节点', ok,
        '耗时 ' + r3(ms) + 'ms / loops ' + loops0 + '→' + loops1 + ' / .money-cat ' + cats.length + '（期望 ' + catIds.length + '）'
        + ' / .money-cat-on 唯一=' + (on.count === 1) + ' / 首节点复用=' + sameCell
        + ' / .money-entry ' + entries + '/' + entriesWant + ' / .study-item ' + study + '/' + studyWant
        + (err ? ' / 异常=' + err : ''));
    });

    // ================================================================
    // 13. 值级 diff：仅时钟变化时，循环项不应产生任何属性写入
    // ================================================================
    section('QA-24', function () {
      window.JiugeNav.go('review');
      var proto = Element.prototype;
      var origSet = proto.setAttribute;
      var origRemove = proto.removeAttribute;
      var writes = [];
      proto.setAttribute = function (n, v) {
        writes.push({ cls: String(this.className || this.tagName || ''), name: String(n) });
        return origSet.call(this, n, v);
      };
      proto.removeAttribute = function (n) {
        writes.push({ cls: String(this.className || this.tagName || ''), name: 'remove:' + String(n) });
        return origRemove.call(this, n);
      };
      try {
        rv.setData({ clockText: '09:41' });
      } finally {
        proto.setAttribute = origSet;
        proto.removeAttribute = origRemove;
      }
      var cellWrites = writes.filter(function (w) { return w.cls.indexOf('pixel-cell') >= 0; });
      var tabWrites = writes.filter(function (w) { return w.cls.indexOf('rv-tab') >= 0; });
      var ok = cellWrites.length === 0 && tabWrites.length === 0;
      out.facts.diffWrites = { total: writes.length, cellWrites: cellWrites.length, tabWrites: tabWrites.length };
      log('QA-24', '值级 diff：只改 clockText 时循环项 class 无冗余 setAttribute（372 格不被无谓重写）', ok,
        '本次 setAttribute 总写入=' + writes.length + ' / .pixel-cell 写入=' + cellWrites.length
        + ' / .rv-tab 写入=' + tabWrites.length);
    });

    // ================================================================
    // 14. 真实回收：review 的 pixelMonths 清空后 12 个内嵌 loop 被摘掉，恢复后 DOM 复原
    // ================================================================
    section('QA-25', function () {
      window.JiugeNav.go('review');
      var view = rv._view;
      if (!view) { log('QA-25', '真实 keyed 清空回收嵌套 loop', false, 'review._view 为空'); return; }
      if (!q('.pixel-cell').length) rv.refreshPixels();
      var cells0 = q('.pixel-cell').length;
      var loops0 = view.loops.length;
      rv.setData({ pixelMonths: [] });
      var loops1 = view.loops.length;
      var stale = view.loops.filter(function (l) { return !l || !l.wrap || l.wrap.isConnected === false; }).length;
      var cells1 = q('.pixel-cell').length;
      rv.refreshPixels();
      var cells2 = q('.pixel-cell').length;
      var loops2 = view.loops.length;
      var ok = cells0 > 300 && cells1 === 0 && loops1 === loops0 - 12 && stale === 0 && cells2 === cells0;
      out.facts.realReclaim = { cells0: cells0, cells1: cells1, cells2: cells2, loops0: loops0, loops1: loops1, loops2: loops2, stale: stale };
      log('QA-25', '真实 372 格年历：清空 pixelMonths 回收 12 个内嵌 loop，重刷后 DOM 完全复原', ok,
        '格数 ' + cells0 + '→' + cells1 + '→' + cells2 + ' / loops ' + loops0 + '→' + loops1 + '→' + loops2
        + ' / 仍注册但脱离 DOM=' + stale);
    });

    // ================================================================
    // 15. 修复持续性：切标签后再刷时钟，选中态不回退
    // ================================================================
    section('QA-26', function () {
      window.JiugeNav.go('review');
      rv.setData({ tabIndex: 2 });
      var steps = []; var ok = true;
      for (var i = 0; i < 3; i += 1) {
        rv.setData({ clockText: '10:0' + i });
        var info = onInfo(q('.rv-tab'), 'rv-tab-on');
        steps.push('第 ' + (i + 1) + ' 次时钟刷新后 .rv-tab-on=' + info.on + '（唯一=' + (info.count === 1) + '）');
        if (info.on !== 2 || info.count !== 1) ok = false;
      }
      log('QA-26', '修复持续性：tabIndex=2 之后 3 次仅时钟 setData，选中态不回退', ok, steps.join(' ; '));
    });

    // ================================================================
    // 16. 影响面：回看页九格摘要行 .dg-row-open（真实点击）
    // ================================================================
    section('QA-27', function () {
      window.JiugeNav.go('review');
      rv.setData({ tabIndex: 1 });
      var rows = (rv.data.digest && Array.isArray(rv.data.digest.rows)) ? rv.data.digest.rows : [];
      if (!rows.length) { log('QA-27', '九格摘要行 .dg-row-open 跟随点击', false, 'digest.rows 为空（空库）'); return; }
      // 空库下 rows 的 last 为空，行点击会被 onDigestRowTap 的「无正文不展开」守卫挡掉；
      // 这里只补数据（不改断言口径），让被点行具备可展开的正文。
      var seeded = rows.map(function (r, i) {
        return i === 0 ? Object.assign({}, r, { last: 'QA 探针正文', lastDate: '2026-11-01', days: r.days || 1 }) : r;
      });
      rv.setData({ digest: Object.assign({}, rv.data.digest, { rows: seeded }), digestOpen: {} });
      var key = seeded[0].key;
      var el = null;
      q('.dg-row').forEach(function (n) { if (String(n.getAttribute('data-key')) === String(key)) el = n; });
      if (!el) { log('QA-27', '九格摘要行 .dg-row-open 跟随点击', false, '未找到 data-key=' + key); return; }
      el.click();
      var after = null;
      q('.dg-row').forEach(function (n) { if (String(n.getAttribute('data-key')) === String(key)) after = n; });
      var info = onInfo(q('.dg-row'), 'dg-row-open');
      var flag = !!(rv.data.digestOpen && rv.data.digestOpen[key]);
      var body = after ? after.querySelector('.dg-last') : null;
      var bodyShown = !!body && body.style.display !== 'none'
        && String(body.textContent).indexOf('QA 探针正文') >= 0;
      var ok = info.count === 1 && info.on === q('.dg-row').indexOf(after) && flag === true && bodyShown;
      log('QA-27', '九格摘要行真实点击后 .dg-row-open 唯一、与 digestOpen[key] 一致，且 wx:if 正文同步可见', ok,
        'key=' + key + ' / .dg-row-open 数=' + info.count + ' / digestOpen=' + flag
        + ' / .dg-last 可见=' + bodyShown);
      if (after) after.click();
      var closed = !!(rv.data.digestOpen && rv.data.digestOpen[key]);
      out.facts.digest = { key: key, openFlag: flag, bodyShown: bodyShown, closedFlagAfterSecondTap: closed };
      if (closed) log('QA-27b', '九格摘要行再次点击后收起', false, 'digestOpen 仍为 true');
    });

    // ================================================================
    // 17. 负向对照：复刻修复前的短路行为，缺陷必须复现（证明上述断言真的能抓到问题）
    // ================================================================
    section('QA-28', function () {
      var host = makeHost('qa-synth-negative');
      var wxml = '<view class="qa-neg">'
        + '<view wx:for="{{rows}}" wx:key="id" class="qa-nr {{sel === item.id ? \'qa-nr-on\' : \'\'}}">{{item.id}}</view>'
        + '</view>';
      var s = mountSynth(host, wxml, { sel: 'a', rows: [{ id: 'a' }, { id: 'b' }] });
      var loops0 = s.view.loops.length;
      s.page.data.sel = 'b';
      // 忠实复刻修复前：signature 未变 → syncLoop 直接 return，循环项不重算。
      // 注入不含 forEach 的 items 桩，正好命中 refreshLoopItems 的防御性 return，
      // 从而在不改产品代码的前提下关掉「新增的那条通道」。
      var stubs = [];
      s.view.loops.forEach(function (l) { stubs.push({ loop: l, items: l.items }); l.items = { size: 0 }; });
      s.view.update();
      var staleInfo = onInfo(q('.qa-nr', host), 'qa-nr-on');
      stubs.forEach(function (x) { x.loop.items = x.items; }); // 恢复修复后的通道
      s.view.update();
      var freshInfo = onInfo(q('.qa-nr', host), 'qa-nr-on');
      var ok = loops0 === 1 && staleInfo.on === 0 && staleInfo.count === 1
        && freshInfo.on === 1 && freshInfo.count === 1;
      out.facts.negativeControl = {
        loops: loops0, staleOn: staleInfo.on, staleCount: staleInfo.count,
        freshOn: freshInfo.on, freshCount: freshInfo.count
      };
      log('QA-28', '负向对照：复刻修复前短路（不重算循环项）→ 选中态停在旧值；恢复新通道后立即跟随', ok,
        '复刻修复前 on 0 基 ' + staleInfo.on + '（缺陷现场应为 0）/ 修复后 on 0 基 ' + freshInfo.on
        + ' / 两者不同=' + (staleInfo.on !== freshInfo.on));
      s.view.destroy();
    });

    // ================================================================
    // 18. 性能：372 格年历，预热 5 次后连续 60 次 setData({clockText})
    // ================================================================
    section('QA-29', function () {
      window.JiugeNav.go('review');
      if (!q('.pixel-cell').length) rv.refreshPixels();
      var view = rv._view;
      var loops = view ? view.loops.length : -1;
      var items = 0;
      if (view && view.loops) {
        view.loops.forEach(function (l) { if (l && l.items && typeof l.items.size === 'number') items += l.items.size; });
      }
      var cells = q('.pixel-cell').length;
      for (var w = 0; w < 5; w += 1) rv.setData({ clockText: 'warm-' + w });
      var samples = [];
      for (var i = 0; i < 60; i += 1) {
        var s0 = performance.now();
        rv.setData({ clockText: '11:' + (10 + (i % 50)) });
        samples.push(performance.now() - s0);
      }
      var sorted = samples.slice().sort(function (a, b) { return a - b; });
      var sum = samples.reduce(function (a, b) { return a + b; }, 0);
      var avg = sum / samples.length;
      var p50 = pct(sorted, 50);
      var p95 = pct(sorted, 95);
      var max = sorted[sorted.length - 1];
      var min = sorted[0];
      var nav = window.navigator || {};
      out.facts.perf = {
        cells: cells, loops: loops, loopItems: items,
        avgMs: r3(avg), p50Ms: r3(p50), p95Ms: r3(p95), maxMs: r3(max), minMs: r3(min), totalMs: r3(sum),
        iterations: 60,
        cpuCores: nav.hardwareConcurrency || null,
        deviceMemoryGB: nav.deviceMemory || null,
        userAgent: String(nav.userAgent || ''),
        platform: String(nav.platform || ''),
        samples: samples.map(r3)
      };
      log('QA-29', '性能：372 格年历 60 次 setData 平均耗时 ≤ 16ms（一帧预算）', cells > 300 && avg <= 16,
        '格数=' + cells + ' / loops=' + loops + ' / 循环项=' + items
        + ' / avg=' + r3(avg) + 'ms P50=' + r3(p50) + ' P95=' + r3(p95) + ' max=' + r3(max) + ' min=' + r3(min)
        + ' / 60 次合计=' + r3(sum) + 'ms');
    });

    // ================================================================
    // 19. 长跑泄漏：来回切 20 次年历（每次都重建 12 个内嵌 loop），loops 不增长
    // ================================================================
    section('QA-30', function () {
      window.JiugeNav.go('review');
      if (!q('.pixel-cell').length) rv.refreshPixels();
      var view = rv._view;
      var loops0 = view.loops.length;
      var cells0 = q('.pixel-cell').length;
      var btns = q('.pixel-year-btn');
      if (btns.length < 2) { log('QA-30', '来回切年历 20 次 loops 不增长', false, '.pixel-year-btn 数=' + btns.length); return; }
      var prevBtn = btns[0];
      var nextBtn = btns[1];
      for (var i = 0; i < 10; i += 1) prevBtn.click();
      var loopsMid = view.loops.length;
      var yearMin = rv.data.pixelYear;
      for (var j = 0; j < 10; j += 1) nextBtn.click();
      var loops1 = view.loops.length;
      var cells1 = q('.pixel-cell').length;
      var stale = view.loops.filter(function (l) { return !l || !l.wrap || l.wrap.isConnected === false; }).length;
      var backYear = rv.data.pixelYear === yearMin + 10;
      var ok = loops1 === loops0 && cells1 === cells0 && stale === 0 && loopsMid === loops0 && backYear;
      out.facts.yearSwitch = {
        loops0: loops0, loopsMid: loopsMid, loops1: loops1,
        cells0: cells0, cells1: cells1, stale: stale, year: rv.data.pixelYear, backToStart: backYear
      };
      log('QA-30', '长跑：来回切年历 20 次（每次重建 12 个内嵌 loop）后 loops/格数不增长、无脱离 DOM 的残留 loop', ok,
        'loops ' + loops0 + '→' + loopsMid + '→' + loops1 + ' / 格数 ' + cells0 + '→' + cells1
        + ' / 残留=' + stale + ' / 年份回到起点=' + backYear + '（' + rv.data.pixelYear + '）');
    });

    // ================================================================
    // 20. 性能（真实每秒路径）：今日页 setData({clockText}) 60 次
    // ================================================================
    section('QA-31', function () {
      window.JiugeNav.go('index');
      var view = idx._view;
      var loops = view ? view.loops.length : -1;
      var items = 0;
      if (view && view.loops) {
        view.loops.forEach(function (l) { if (l && l.items && typeof l.items.size === 'number') items += l.items.size; });
      }
      if (typeof idx.closeCell === 'function') idx.closeCell();
      for (var w = 0; w < 5; w += 1) idx.setData({ clockText: 'warm-' + w });
      var samples = [];
      for (var i = 0; i < 60; i += 1) {
        var s0 = performance.now();
        idx.setData({ clockText: '07:' + (10 + (i % 50)) });
        samples.push(performance.now() - s0);
      }
      var sorted = samples.slice().sort(function (a, b) { return a - b; });
      var sum = samples.reduce(function (a, b) { return a + b; }, 0);
      var avg = sum / samples.length;
      out.facts.perfIndex = {
        loops: loops, loopItems: items, iterations: 60,
        avgMs: r3(avg), p50Ms: r3(pct(sorted, 50)), p95Ms: r3(pct(sorted, 95)),
        maxMs: r3(sorted[sorted.length - 1]), totalMs: r3(sum)
      };
      log('QA-31', '性能（真实每秒路径）：今日页 60 次 setData({clockText}) 平均 ≤ 16ms', avg <= 16,
        'loops=' + loops + ' / 循环项=' + items + ' / avg=' + r3(avg) + 'ms P50=' + r3(pct(sorted, 50))
        + ' P95=' + r3(pct(sorted, 95)) + ' max=' + r3(sorted[sorted.length - 1]));
    });

    // ================================================================
    // 21. 数据量放大：400 条金钱流水（循环项从 26 → 426）下的每秒时钟成本
    //     修复把「每次 setData 求值全部循环项」变成常态，必须看这份成本怎么随数据量长。
    // ================================================================
    section('QA-32', function () {
      window.JiugeNav.go('index');
      var view = idx._view;
      var loopsBeforeCount = view.loops.length;
      var before = 0;
      view.loops.forEach(function (l) { if (l && l.items && typeof l.items.size === 'number') before += l.items.size; });
      var big = [];
      for (var i = 0; i < 400; i += 1) {
        big.push({
          id: 'qa-' + i, glyph: '🍚', label: '餐饮', type: 'expense',
          amountText: '12.00', note: '', timeText: '12:00'
        });
      }
      idx.setData({ moneyEntries: big });
      var domEntries = q('.money-entry').length;
      var after = 0;
      view.loops.forEach(function (l) { if (l && l.items && typeof l.items.size === 'number') after += l.items.size; });
      for (var w = 0; w < 5; w += 1) idx.setData({ clockText: 'warm-' + w });
      var samples = [];
      for (var n = 0; n < 60; n += 1) {
        var s0 = performance.now();
        idx.setData({ clockText: '06:' + (10 + (n % 50)) });
        samples.push(performance.now() - s0);
      }
      var sorted = samples.slice().sort(function (a, b) { return a - b; });
      var sum = samples.reduce(function (a, b) { return a + b; }, 0);
      var avg = sum / samples.length;
      // 复原：清空 400 条，DOM 不得残留
      idx.setData({ moneyEntries: [] });
      var domAfterClear = q('.money-entry').length;
      var loops1 = view.loops.length;
      var loopsOk = loops1 === loopsBeforeCount && domAfterClear === 0;
      out.facts.perfBigList = {
        loopItemsBefore: before, loopItemsAfter: after, domEntries: domEntries,
        loopsBefore: loopsBeforeCount, loopsAfter: loops1,
        iterations: 60, avgMs: r3(avg), p50Ms: r3(pct(sorted, 50)), p95Ms: r3(pct(sorted, 95)),
        maxMs: r3(sorted[sorted.length - 1]), totalMs: r3(sum), domAfterClear: domAfterClear
      };
      log('QA-32', '数据量放大：400 条流水（循环项 ' + before + '→' + after + '）下 60 次时钟 setData 平均 ≤ 16ms', avg <= 16,
        'DOM 条目=' + domEntries + ' / avg=' + r3(avg) + 'ms P50=' + r3(pct(sorted, 50))
        + ' P95=' + r3(pct(sorted, 95)) + ' max=' + r3(sorted[sorted.length - 1]));
      log('QA-33', '400 条流水清空后 DOM 条目归零，loop 注册数不因增删而漂移', loopsOk,
        '.money-entry ' + domEntries + ' → ' + domAfterClear + ' / loops 保持 ' + loops1);
    });

    out.facts.machine = {
      userAgent: String((window.navigator || {}).userAgent || ''),
      cpuCores: (window.navigator || {}).hardwareConcurrency || null,
      deviceMemoryGB: (window.navigator || {}).deviceMemory || null,
      elapsedMs: Date.now() - t0
    };
  } catch (e) {
    log('QA-FATAL', '探针整体异常', false, String((e && e.stack) || e));
  } finally {
    try { dropHosts(); } catch (e) { /* ignore */ }
  }

  return out;
}

module.exports = { d01QaProbe: d01QaProbe };
