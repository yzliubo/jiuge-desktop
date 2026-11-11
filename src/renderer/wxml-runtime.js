'use strict';
/**
 * 极简 WXML 运行时（架构 §1.5）。
 *
 *  - 启动期把 WXML 文本一次解析成节点树并缓存；
 *  - {{expr}} 用 new Function('d','with(d){ return (expr) }') 求值，文本插值统一 escapeHtml()，
 *    杜绝日记正文里的 < / & 破坏 DOM；
 *  - 支持 wx:if / wx:elif / wx:else / wx:for / wx:for-item / wx:for-index / wx:key（含 *this）/ block；
 *  - setData 走**节点级 diff**：只更新变化的文本 / class / style / 控件值与 keyed 列表，
 *    绝不整页 innerHTML 重建（今日页每秒刷 clockText 时输入框不能失焦，R4）；
 *  - 渲染前后保存 / 恢复 activeElement 与 selectionStart/End 作为双保险；
 *  - 事件代理把 bind 前缀与 catch 前缀事件映射到 DOM 事件，鼠标拖拽包装成 e.touches[0].clientX；
 *  - swiper 用 current 控制 swiper-item 显隐；picker 子节点由桌面控件自身取代；
 *  - 内联 style 里的 rpx 按 1rpx=0.5px 转换（WXSS 文件已在移植期转换）。
 *
 * 本文件是浏览器 <script>，IIFE 挂全局；同时兼容 Node require（便于工具脚本做纯函数校验）。
 */
(function (root, factory) {
  'use strict';
  var api = factory(typeof window !== 'undefined' ? window : globalThis);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeWxmlRuntime = api;
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  'use strict';

  var CM = G.JiugeComponentMap;
  if (!CM && typeof require === 'function') {
    try { CM = require('./component-map.js'); } catch (e) { CM = null; }
  }
  if (!CM) throw new Error('[WXML 运行时] 缺少 JiugeComponentMap，请先加载 component-map.js');

  var BIND_RE = /\{\{([\s\S]*?)\}\}/g;
  var fnCache = {};

  // ---------------------------------------------------------------- 基础工具
  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** WXML 内联 style 里的 rpx → px：WXSS 已在移植期转换，这里只处理动态内联值（§9.6-10）。 */
  function convertInlineRpx(text) {
    return String(text).replace(/(-?\d+(?:\.\d+)?)rpx/g, function (_m, num) {
      return String(Math.round(Number(num) * 0.5 * 10000) / 10000) + 'px';
    });
  }

  function stringify(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (e) { return ''; }
    }
    return String(v);
  }

  function compiled(expr) {
    if (!Object.prototype.hasOwnProperty.call(fnCache, expr)) {
      try {
        fnCache[expr] = new Function('d', 'with(d){ return (' + expr + '); }');
      } catch (e) {
        fnCache[expr] = function () { return ''; };
      }
    }
    return fnCache[expr];
  }

  /** 求值单个 {{expr}}；表达式抛错时返回 ''，不让整页渲染崩掉。 */
  function evalExpr(expr, scope) {
    try {
      return compiled(String(expr).trim())(scope || {});
    } catch (e) {
      return '';
    }
  }

  function parseBindings(str) {
    var s = String(str === null || str === undefined ? '' : str);
    var parts = [];
    var last = 0;
    var count = 0;
    var m;
    BIND_RE.lastIndex = 0;
    while ((m = BIND_RE.exec(s)) !== null) {
      if (m.index > last) parts.push({ static: true, text: s.slice(last, m.index) });
      parts.push({ static: false, expr: m[1].trim() });
      count += 1;
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push({ static: true, text: s.slice(last) });
    return { raw: s, parts: parts, count: count };
  }

  /** 字符串渲染通道（文本 / class / style / 普通属性）。 */
  function evalBinding(binding, scope) {
    if (!binding) return '';
    if (!binding.count) return binding.raw;
    var out = '';
    for (var i = 0; i < binding.parts.length; i += 1) {
      var p = binding.parts[i];
      out += p.static ? p.text : stringify(evalExpr(p.expr, scope));
    }
    return out;
  }

  /** 原始值通道（wx:for 的数组、wx:if 的真假、picker range 的数组）。 */
  function evalBindingRaw(binding, scope) {
    if (!binding) return '';
    if (!binding.count) return binding.raw;
    if (binding.parts.length === 1 && !binding.parts[0].static) {
      return evalExpr(binding.parts[0].expr, scope);
    }
    return evalBinding(binding, scope);
  }

  function truthy(v) {
    if (typeof v === 'string') return v.length > 0 && v !== 'false' && v !== '0';
    return !!v;
  }

  /** scope 以 page.data 为原型：setData 之后所有实例自动看到最新值，无需重建 scope。 */
  function makeScope(base, extra) {
    var s = Object.create(base || null);
    if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
    return s;
  }

  // ---------------------------------------------------------------- 词法 / 语法
  function findTagEnd(text, start) {
    var quote = '';
    for (var i = start + 1; i < text.length; i += 1) {
      var c = text.charAt(i);
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') return i;
    }
    return text.length - 1;
  }

  function parseTag(raw) {
    var s = String(raw).trim();
    var selfClose = /\/$/.test(s);
    if (selfClose) s = s.slice(0, -1).trim();
    var m = /^([^\s/>]+)/.exec(s);
    var tag = m ? m[1] : '';
    var attrs = {};
    var rest = s.slice(tag.length);
    var re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    var mm;
    while ((mm = re.exec(rest)) !== null) {
      var name = mm[1];
      var val = mm[2] !== undefined ? mm[2]
        : (mm[3] !== undefined ? mm[3] : (mm[4] !== undefined ? mm[4] : ''));
      attrs[name] = val;
    }
    return { tag: tag, attrs: attrs, selfClose: selfClose };
  }

  function tokenize(text) {
    var src = String(text || '');
    var root = { tag: '#root', attrs: {}, children: [], text: '' };
    var stack = [root];
    var i = 0;
    var len = src.length;
    while (i < len) {
      if (src.substr(i, 4) === '<!--') {
        var e = src.indexOf('-->', i + 4);
        i = e < 0 ? len : e + 3;
        continue;
      }
      if (src.charAt(i) === '<') {
        if (src.substr(i, 2) === '</') {
          var end = src.indexOf('>', i);
          if (end < 0) { i = len; continue; }
          var close = src.slice(i + 2, end).trim();
          for (var k = stack.length - 1; k > 0; k -= 1) {
            if (stack[k].tag === close) { stack.length = k; break; }
          }
          i = end + 1;
          continue;
        }
        var tagEnd = findTagEnd(src, i);
        var parsed = parseTag(src.slice(i + 1, tagEnd));
        var node = {
          tag: parsed.tag, attrs: parsed.attrs, children: [], text: '',
          selfClose: parsed.selfClose,
        };
        stack[stack.length - 1].children.push(node);
        if (!parsed.selfClose && !CM.VOID_TAGS[parsed.tag]) stack.push(node);
        i = tagEnd + 1;
        continue;
      }
      var next = src.indexOf('<', i);
      var stop = next < 0 ? len : next;
      var chunk = src.slice(i, stop);
      if (chunk.length) {
        stack[stack.length - 1].children.push({
          tag: '#text', attrs: {}, children: [], text: chunk,
        });
      }
      i = stop;
    }
    return root;
  }

  var CONTROL_NAMES = {
    'value': true, 'checked': true, 'range': true, 'start': true, 'end': true,
    'current': true, 'color': true, 'min': true, 'max': true, 'mode': true,
    'scroll-y': true, 'scroll-x': true,
  };

  /** 编译：预解析绑定、条件、循环、事件、控件属性。 */
  function prepare(node) {
    node.info = CM.resolve(node.tag, node.attrs);
    if (node.tag === '#text') {
      node.textBinding = parseBindings(node.text);
      return;
    }
    node.plainAttrs = [];
    node.dataAttrs = [];
    node.controlAttrs = [];
    node.events = [];
    node.cond = null;
    node.loop = null;

    Object.keys(node.attrs).forEach(function (name) {
      var raw = node.attrs[name];
      var binding = parseBindings(raw);
      if (name === 'wx:if') node.cond = { type: 'if', binding: binding };
      else if (name === 'wx:elif') node.cond = { type: 'elif', binding: binding };
      else if (name === 'wx:else') node.cond = { type: 'else', binding: parseBindings('true') };
      else if (name === 'wx:for') {
        if (!node.loop) node.loop = {};
        node.loop.binding = binding;
      } else if (name === 'wx:for-item') {
        if (!node.loop) node.loop = {};
        node.loop.itemName = String(raw || 'item');
      } else if (name === 'wx:for-index') {
        if (!node.loop) node.loop = {};
        node.loop.indexName = String(raw || 'index');
      } else if (name === 'wx:key') {
        if (!node.loop) node.loop = {};
        node.loop.keyName = String(raw || '');
      } else if (/^(bind|catch)/.test(name)) {
        node.events.push({ name: name, handler: String(raw || ''), info: CM.eventInfo(name) });
      } else if (name.indexOf('data-') === 0) {
        node.dataAttrs.push({ name: name, binding: binding });
      } else if (CONTROL_NAMES[name] && (node.info.control || node.info.addClass === 'j-scroll')) {
        node.controlAttrs.push({ name: name, binding: binding });
      } else if (CM.IGNORED_ATTRS[name] === true || CM.isRuntimeAttr(name)) {
        // 小程序专有 / 忽略属性：不落 DOM
      } else {
        node.plainAttrs.push({ name: name, binding: binding });
      }
    });

    if (node.loop) {
      if (!node.loop.binding) node.loop.binding = parseBindings('[]');
      node.loop.itemName = node.loop.itemName || 'item';
      node.loop.indexName = node.loop.indexName || 'index';
      node.loop.keyName = node.loop.keyName || '';
    }
    node.children.forEach(prepare);
  }

  function compile(text) {
    var tree = tokenize(text);
    tree.children.forEach(prepare);
    return tree;
  }

  // ---------------------------------------------------------------- 焦点双保险
  function saveFocus() {
    if (typeof document === 'undefined') return null;
    var el = document.activeElement;
    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return null;
    var snap = { el: el, start: null, end: null };
    try {
      snap.start = el.selectionStart;
      snap.end = el.selectionEnd;
    } catch (e) { /* 某些 input type 不支持选区 */ }
    return snap;
  }

  function restoreFocus(snap) {
    if (!snap || typeof document === 'undefined' || !document.contains(snap.el)) return;
    try {
      if (document.activeElement !== snap.el) snap.el.focus();
      if (snap.start !== null && typeof snap.el.setSelectionRange === 'function') {
        snap.el.setSelectionRange(snap.start, snap.end);
      }
    } catch (e) { /* 焦点恢复失败不影响渲染 */ }
  }

  // ---------------------------------------------------------------- 节点实例
  function refreshInst(inst) {
    if (!inst || !inst.bindings) return;
    inst.bindings.forEach(function (b) {
      var raw = evalBinding(b.binding, inst.scope);
      if (b.last === raw) return;
      b.last = raw;
      if (b.target === 'text') {
        // 统一 escapeHtml()：日记正文里的 < / & 不会破坏 DOM
        b.el.innerHTML = escapeHtml(raw);
      } else if (b.target === 'attr') {
        if (b.name === 'value' && (inst.info.control === 'input' || inst.info.control === 'textarea')) return;
        // class 通道必须保留 component-map 附加的映射类（j-scroll / j-switch 等）
        var attrValue = raw;
        if (b.name === 'style') attrValue = convertInlineRpx(attrValue);
        if (b.isClass && b.baseClass) attrValue = (b.baseClass + ' ' + attrValue).trim();
        try { b.el.setAttribute(b.name, attrValue); } catch (e) { /* 非法属性名跳过 */ }
      } else if (b.target === 'data') {
        try { b.el.setAttribute(b.name, raw); } catch (e) { /* 同上 */ }
      }
    });
    refreshControl(inst);
    inst.children.forEach(refreshInst);
  }

  function refreshControl(inst) {
    if (!inst.controlBindings || !inst.controlBindings.length) return;
    var v = {};
    inst.controlBindings.forEach(function (c) {
      var raw = evalBindingRaw(c.binding, inst.scope);
      if (c.name === 'checked') v.checked = truthy(raw);
      else if (c.name === 'value') v.value = raw === null || raw === undefined ? '' : raw;
      else if (c.name === 'range') v.range = raw;
      else if (c.name === 'start' || c.name === 'min') v.start = raw;
      else if (c.name === 'end' || c.name === 'max') v.end = raw;
      else if (c.name === 'current') v.current = Number(raw) || 0;
      else if (c.name === 'color') v.color = stringify(raw);
      else if (c.name === 'mode') v.mode = stringify(raw);
    });
    if (v.range !== undefined && inst.info.rangeKey) v.rangeKey = inst.info.rangeKey;
    CM.applyControl(inst.info, inst.el, v);
  }

  function setVisible(inst, show) {
    if (!inst || !inst.el || inst.el.nodeType !== 1) return;
    if (show) inst.el.style.display = inst.originalDisplay || '';
    else inst.el.style.display = 'none';
  }

  function callHandler(ctx, handler, ev) {
    var fn = ctx.page && ctx.page[handler];
    if (typeof fn !== 'function') {
      console.warn('[WXML 运行时] 页面缺少事件处理函数：' + handler);
      return;
    }
    try {
      fn.call(ctx.page, ev);
    } catch (e) {
      console.error('[WXML 运行时] ' + handler + ' 异常：' + String(e && e.stack || e));
    }
  }

  function bindEvents(inst, ctx) {
    var el = inst.el;
    var node = inst.node;
    if (!el || el.nodeType !== 1 || !node.events) return;
    node.events.forEach(function (evt) {
      if (!evt.handler) return;
      var domEventName = evt.info.domEvent;
      if (!domEventName) return;
      var listener = function (domEvent) {
        if (evt.info.confirmKey && domEvent.key !== evt.info.confirmKey) return;
        if (evt.info.short === 'touchmove' && !ctx.dragging) return;
        if (evt.info.isCatch) domEvent.stopPropagation();
        var current = ctx.currentOf(node);
        var detail = CM.detailFor(node.info.control, el, domEvent, current);
        var ev = CM.buildEvent({
          el: el, domEvent: domEvent, short: evt.info.short, detail: detail,
        });
        callHandler(ctx, evt.handler, ev);
      };
      el.addEventListener(domEventName, listener);
      if (evt.info.short === 'touchstart' || domEventName === 'mousedown') {
        el.addEventListener('mousedown', function () { ctx.dragging = true; });
      }
      if (evt.info.short === 'touchend' || domEventName === 'mouseup') {
        el.addEventListener('mouseup', function () { ctx.dragging = false; });
      }
    });
  }

  function keyOf(loop, value, index) {
    var k = loop.keyName;
    if (k === '*this') return 'i' + index + '|' + stringify(value);
    if (k && value && typeof value === 'object' && value[k] !== undefined) return 'k' + String(value[k]);
    return 'i' + index;
  }

  function scopeFor(loop, value, index) {
    var extra = {};
    extra[loop.itemName] = value;
    extra[loop.indexName] = index;
    return makeScope(loop.scope, extra);
  }

  function removeInst(inst) {
    if (!inst) return;
    if (inst.el && inst.el.parentNode) inst.el.parentNode.removeChild(inst.el);
    inst.children.forEach(removeInst);
  }

  /**
   * 创建一个节点实例。
   * @param {object} node 编译节点
   * @param {HTMLElement} parentDom 父容器
   * @param {object} scope 作用域（以 page.data 为原型）
   * @param {object} ctx View 上下文
   * @param {{skipLoop?:boolean, condGroup?:object}} [opts]
   */
  function createNode(node, parentDom, scope, ctx, opts) {
    var o = opts || {};
    if (node.loop && !o.skipLoop) {
      return createLoop(node, parentDom, scope, ctx, o);
    }
    var el;
    var inst = {
      node: node, scope: scope, ctx: ctx, bindings: [], controlBindings: [], children: [],
      info: node.info, originalDisplay: '', el: null,
    };

    if (node.tag === '#text') {
      el = document.createElement('span');
      el.className = 'j-text';
      inst.el = el;
      inst.bindings.push({
        target: 'text', name: '', binding: node.textBinding, el: el, last: null,
      });
    } else {
      el = document.createElement(node.info.htmlTag);
      inst.el = el;
      if (node.info.inputType) el.setAttribute('type', node.info.inputType);
      if (node.info.addClass) {
        el.className = node.info.addClass;
        if (node.info.isVirtual) el.style.display = 'contents';
        if (node.info.scrollY || node.info.scrollX) {
          el.style.overflowY = node.info.scrollY ? 'auto' : 'hidden';
          el.style.overflowX = node.info.scrollX ? 'auto' : 'hidden';
        }
      }
      node.plainAttrs.forEach(function (a) {
        if (a.name === 'class') return; // 类单独处理，避免覆盖映射附加的 class
        inst.bindings.push({
          target: 'attr', name: a.name, binding: a.binding, el: el, last: null,
        });
      });
      var classAttr = null;
      node.plainAttrs.forEach(function (a) { if (a.name === 'class') classAttr = a; });
      if (classAttr) {
        inst.classBinding = classAttr.binding;
        inst.bindings.push({
          target: 'attr', name: 'class', binding: {
            raw: classAttr.binding.raw, count: classAttr.binding.count,
            parts: classAttr.binding.parts,
          }, el: el, last: null, isClass: true, baseClass: node.info.addClass || '',
        });
      }
      node.dataAttrs.forEach(function (a) {
        inst.bindings.push({
          target: 'data', name: a.name, binding: a.binding, el: el, last: null,
        });
      });
      node.controlAttrs.forEach(function (a) {
        inst.controlBindings.push({ name: a.name, binding: a.binding });
      });
      bindEvents(inst, ctx);
      if (node.info.control === 'swiper') {
        var currentBinding = null;
        node.controlAttrs.forEach(function (a) { if (a.name === 'current') currentBinding = a.binding; });
        ctx.swipers.push({
          node: node, inst: inst, binding: currentBinding,
          last: currentBinding ? (Number(evalBindingRaw(currentBinding, scope)) || 0) : 0,
        });
      }
      if (node.cond && o.condGroup) {
        o.condGroup.members.push({ inst: inst, cond: node.cond });
      }
      inst.originalDisplay = el.style.display;
      if (node.info.control === 'selector' || node.info.control === 'date' || node.info.control === 'time') {
        // picker 映射成 <select> 或 <input type=date/time>：内容由控件自身呈现，
        // WXML 里作为显示文本的子节点在桌面版不落 DOM，避免 <div>/<span> 混入表单控件。
        inst.children = [];
      } else {
        // 子树收进 inst.children，setData / 循环项复用时可递归 diff，而不是只刷顶层
        createChildren(node, el, scope, ctx, inst.children);
      }
    }

    parentDom.appendChild(el);
    refreshInst(inst);
    return inst;
  }

  /** 遍历子节点，顺带把连续的 wx:if/elif/else 归成一个条件组；返回本层实例数组。 */
  function createChildren(parent, parentDom, scope, ctx, collector) {
    var list = collector || [];
    var currentGroup = null;
    parent.children.forEach(function (child) {
      if (child.tag === '#text' && !String(child.text).trim()) {
        // 纯空白文本节点不打断条件组，但也不渲染（等价 WXML 的空白折叠）
        return;
      }
      var isCond = !!(child.cond);
      if (isCond && (!currentGroup || (child.cond.type === 'if'))) {
        currentGroup = { id: ctx.groupSeq += 1, members: [] };
        ctx.condGroups.push(currentGroup);
      } else if (!isCond && child.tag !== '#text') {
        currentGroup = null;
      }
      var inst = createNode(child, parentDom, scope, ctx, {
        condGroup: isCond ? currentGroup : null,
      });
      if (inst && !inst.isLoop) list.push(inst);
    });
    return list;
  }

  function createLoop(node, parentDom, scope, ctx) {
    var wrap = document.createElement('span');
    wrap.className = 'j-for';
    wrap.style.display = 'contents';
    parentDom.appendChild(wrap);
    var loop = {
      node: node, wrap: wrap, scope: scope, ctx: ctx,
      itemName: node.loop.itemName,
      indexName: node.loop.indexName,
      keyName: node.loop.keyName,
      binding: node.loop.binding,
      items: new Map(),
      signature: '',
    };
    ctx.loops.push(loop);
    syncLoop(loop);
    return { isLoop: true, el: wrap, children: [], bindings: [], scope: scope, node: node, info: node.info };
  }

  /**
   * 结构未变时重算循环项内的绑定。
   *
   * 循环项实例不在 rootInsts 里（createChildren:517 把它排除在外），只挂在 loop.items 上，
   * 所以顶层 refreshInst 的递归覆盖不到它们。而「数组 signature 没变」并不等于「绑定没变」：
   * 循环项里完全可以引用外层 setData 标量（如 {{tabIndex === index ? 'rv-tab-on' : ''}}、
   * aria-checked / aria-label 同理），数组不动这些绑定照样得重算，否则选中态会停在前一帧。
   *
   * refreshInst 内部仍是值级 diff（b.last === raw 直接 return），所以这里只补求值，
   * 未变化的绑定不产生任何 DOM 写入。
   */
  function refreshLoopItems(loop) {
    var items = loop && loop.items;
    if (!items || typeof items.forEach !== 'function') return;
    items.forEach(function (inst) { refreshInst(inst); });
  }

  function syncLoop(loop) {
    var arr = evalBindingRaw(loop.binding, loop.scope);
    if (!Array.isArray(arr)) arr = [];
    var signature = '';
    try { signature = JSON.stringify(arr); } catch (e) { signature = String(arr.length); }
    if (signature === loop.signature) {
      // 结构没变：不重建列表，但循环项内的绑定必须重算一次（见 refreshLoopItems 注释）
      refreshLoopItems(loop);
      return;
    }
    loop.signature = signature;

    var oldItems = loop.items;
    var nextItems = new Map();
    var ordered = [];
    var usedKeys = {};

    arr.forEach(function (value, index) {
      var baseKey = keyOf(loop, value, index);
      var key = baseKey;
      var n = 1;
      while (usedKeys[key]) { key = baseKey + '_' + n; n += 1; }
      usedKeys[key] = true;

      var inst = oldItems.get(key);
      if (inst) {
        oldItems.delete(key);
        // 就地更新循环变量，保持 scope 对象引用不变：子树与嵌套 wx:for 都以它为原型，
        // 复用后自动看到新的 item/index，无需重建整棵子树，也就不会打断输入框焦点。
        inst.scope[loop.itemName] = value;
        inst.scope[loop.indexName] = index;
        refreshInst(inst);
      } else {
        var holder = document.createElement('span');
        holder.style.display = 'contents';
        inst = createNode(loop.node, holder, scopeFor(loop, value, index), loop.ctx, { skipLoop: true });
        if (inst.el && inst.el.parentNode === holder) holder.removeChild(inst.el);
      }
      if (inst.el.parentNode !== loop.wrap) loop.wrap.appendChild(inst.el);
      var at = loop.wrap.children[index];
      if (at !== inst.el) loop.wrap.insertBefore(inst.el, at || null);
      nextItems.set(key, inst);
      ordered.push(inst);
    });

    oldItems.forEach(function (inst) { removeInst(inst); });
    loop.items = nextItems;
    loop.ordered = ordered;
  }

  function syncCondGroup(group) {
    var picked = false;
    group.members.forEach(function (m) {
      var show = false;
      if (!picked) {
        if (m.cond.type === 'else') show = true;
        else show = truthy(evalBindingRaw(m.cond.binding, m.inst.scope));
        if (show) picked = true;
      }
      setVisible(m.inst, show);
    });
  }

  /** swiper 只显示 current 对应的 swiper-item（小程序语义；桌面没有手势滑动，靠点击标签切换）。 */
  function applySwiperVisibility(s) {
    if (!s || !s.inst || !s.inst.el || typeof s.inst.el.querySelectorAll !== 'function') return;
    var items = s.inst.el.querySelectorAll('.j-swiper-item');
    Array.prototype.forEach.call(items, function (item, i) {
      item.style.display = (i === s.last) ? '' : 'none';
    });
  }

  function syncSwiper(s, ctx) {
    if (!s.binding) return;
    var now = Number(evalBindingRaw(s.binding, s.inst.scope));
    if (!isFinite(now) || now === s.last) return;
    s.last = now;
    applySwiperVisibility(s);
    var handler = '';
    s.node.events.forEach(function (evt) {
      if (!handler && (evt.info.short === 'change')) handler = evt.handler;
    });
    if (!handler) return;
    var ev = CM.buildEvent({
      el: s.inst.el, short: 'change', detail: { current: now, source: 'touch' },
    });
    callHandler(ctx, handler, ev);
  }

  // ---------------------------------------------------------------- View
  function View(page, wxmlText, container) {
    this.page = page;
    this.container = container;
    this.tree = compile(wxmlText);
    this.rootInsts = [];
    this.loops = [];
    this.condGroups = [];
    this.swipers = [];
    this.groupSeq = 0;
    this.dragging = false;
    this.render();
  }

  View.prototype.currentOf = function (node) {
    var found = 0;
    this.swipers.forEach(function (s) { if (s.node === node) found = s.last; });
    return found;
  };

  View.prototype.render = function () {
    if (!this.container) return;
    this.container.innerHTML = '';
    var scope = makeScope(this.page && this.page.data ? this.page.data : {}, null);
    this.rootInsts = createChildren(this.tree, this.container, scope, this);
    // 首帧也必须应用 wx:if / wx:elif / wx:else，否则所有浮层与条件块会同时显示
    this.condGroups.forEach(syncCondGroup);
    // swiper 首帧只显示 current 对应的 swiper-item
    this.swipers.forEach(applySwiperVisibility);
  };

  /** setData 之后调用：节点级 diff，绝不整页 innerHTML 重建。 */
  View.prototype.update = function () {
    var focus = saveFocus();
    var self = this;
    this.rootInsts.forEach(refreshInst);
    this.loops.forEach(function (loop) { syncLoop(loop); });
    this.condGroups.forEach(syncCondGroup);
    this.swipers.forEach(function (s) { syncSwiper(s, self); });
    // 清理已被 keyed 列表删除的实例所注册的条件组 / swiper / 循环，避免长期运行内存增长
    this.condGroups = this.condGroups.filter(function (g) {
      g.members = g.members.filter(function (m) {
        return m.inst && m.inst.el && m.inst.el.isConnected !== false;
      });
      return g.members.length > 0;
    });
    this.swipers = this.swipers.filter(function (s) {
      return s.inst && s.inst.el && s.inst.el.isConnected !== false;
    });
    // 循环同样要回收：被 keyed 列表删掉的项里若嵌了 wx:for，它的 loop 实例还挂在 this.loops 上，
    // 不摘掉就会对着已经从 DOM 上摘除的子树持续求值 / 写属性。
    this.loops = this.loops.filter(function (loop) {
      return loop && loop.wrap && loop.wrap.isConnected !== false;
    });
    restoreFocus(focus);
  };

  View.prototype.destroy = function () {
    if (this.container) this.container.innerHTML = '';
    this.rootInsts = [];
    this.loops = [];
    this.condGroups = [];
    this.swipers = [];
  };

  function mount(page, wxmlText, container) {
    return new View(page, wxmlText, container);
  }

  /** 自检：R9 要求运行时启动前确认 5 个全局齐备，缺一即明确报错。 */
  function selfCheck(G) {
    var g = G || (typeof window !== 'undefined' ? window : globalThis);
    var needed = ['wx', 'Page', 'App', 'getApp', 'getCurrentPages', 'require', '__jiuge'];
    return needed.filter(function (name) { return typeof g[name] === 'undefined'; });
  }

  return {
    compile: compile,
    tokenize: tokenize,
    evalExpr: evalExpr,
    evalBinding: evalBinding,
    evalBindingRaw: evalBindingRaw,
    parseBindings: parseBindings,
    escapeHtml: escapeHtml,
    convertInlineRpx: convertInlineRpx,
    applySwiperVisibility: applySwiperVisibility,
    mount: mount,
    View: View,
    selfCheck: selfCheck,
  };
});
