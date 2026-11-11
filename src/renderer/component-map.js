'use strict';
/**
 * WXML 组件映射表（架构 §1.5）：把小程序标签 / 属性 / 事件归一化成桌面 DOM。
 *
 * 映射规则（逐条对齐架构）：
 *   view→div / text→span / block→无 DOM（display:contents）
 *   input→input / textarea→textarea / button→button（忽略 hover-class / open-type）
 *   scroll-view→div.scroll（scroll-y / scroll-x → overflow）
 *   swiper / swiper-item→div（保留 bindchange 的 {detail:{current}}）
 *   picker mode=date→input[type=date]（start→min，值仍 YYYY-MM-DD；胶囊页 min=明天）
 *   picker mode=selector→select（range / range-key）
 *   switch→input[type=checkbox]（checked→e.detail.value，色值 --c-switch 取 THEMES[id].switchColor）
 *
 * 事件：bindtap/catchtap/bindinput/bindchange/bindblur/bindconfirm/bindtouch* → 事件代理；
 *       e.currentTarget.dataset 取 data-*；e.detail.value；e.touches[0].clientX 由鼠标包装。
 *
 * 本文件是浏览器 <script>，采用 IIFE 挂全局，同时兼容 Node require（供工具脚本做纯函数校验）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeComponentMap = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var TAG_MAP = {
    'view': 'div',
    'text': 'span',
    'block': 'span',
    'input': 'input',
    'textarea': 'textarea',
    'button': 'button',
    'scroll-view': 'div',
    'swiper': 'div',
    'swiper-item': 'div',
    'picker': 'input',
    'switch': 'input',
    'image': 'img',
    'icon': 'span',
    'form': 'form',
    'label': 'label',
    'navigator': 'div',
    'progress': 'div',
    'slider': 'input',
    'checkbox': 'input',
    'radio': 'input',
  };

  /** WXML 里这些标签按自闭合处理，tokenizer 不把它们压入栈。 */
  var VOID_TAGS = { 'input': true, 'image': true, 'icon': true, 'progress': true, 'slider': true };

  /** 不落到 DOM 上的小程序专有属性（由运行时或忽略处理）。 */
  var IGNORED_ATTRS = {
    'hover-class': true, 'hover-start-time': true, 'hover-stay-time': true,
    'open-type': true, 'form-type': true, 'hover-stop-propagation': true,
    'enable-back-to-top': true, 'enable-flex': true, 'enhanced': true,
    'show-scrollbar': true, 'refresher-enabled': true, 'scroll-anchoring': true,
    'cursor-spacing': true, 'cursor': true, 'confirm-type': true, 'confirm-hold': true,
    'adjust-position': true, 'hold-keyboard': true, 'auto-height': true,
    'fixed': true, 'selection-start': true, 'selection-end': true,
    'decode': true, 'space': true, 'user-select': true,
    'indicator-dots': true, 'indicator-color': true, 'indicator-active-color': true,
    'circular': true, 'vertical': true, 'previous-margin': true, 'next-margin': true,
    'easing-function': true, 'display-multiple-items': true,
    'range-key': true, 'disabled': false, 'animation': true,
  };

  var EVENT_MAP = {
    'tap': 'click',
    'longpress': 'contextmenu',
    'longtap': 'contextmenu',
    'input': 'input',
    'change': 'change',
    'blur': 'blur',
    'focus': 'focus',
    'confirm': 'keydown',
    'submit': 'submit',
    'reset': 'reset',
    'touchstart': 'mousedown',
    'touchmove': 'mousemove',
    'touchend': 'mouseup',
    'touchcancel': 'mouseleave',
    'scroll': 'scroll',
    'scrolltolower': 'scroll',
    'scrolltoupper': 'scroll',
    'animationfinish': 'transitionend',
    'transitionend': 'transitionend',
  };

  /**
   * 解析标签：返回 DOM 元素标签名、input type、附加 class、控件种类。
   * @param {string} tag WXML 标签名
   * @param {object} attrs 已解析的属性（原样，值仍是模板字符串）
   */
  function resolve(tag, attrs) {
    var a = attrs || {};
    var out = {
      htmlTag: TAG_MAP[tag] || 'div',
      inputType: '',
      addClass: '',
      control: '',
      isVirtual: tag === 'block',
      voidTag: !!VOID_TAGS[tag],
    };
    if (tag === 'block') out.addClass = 'j-block';
    if (tag === 'scroll-view') {
      out.addClass = 'j-scroll';
      out.scrollY = hasAttr(a, 'scroll-y');
      out.scrollX = hasAttr(a, 'scroll-x');
    }
    if (tag === 'swiper') {
      out.addClass = 'j-swiper';
      out.control = 'swiper';
    }
    if (tag === 'swiper-item') out.addClass = 'j-swiper-item';
    if (tag === 'picker') {
      var mode = String(a.mode || 'selector');
      if (mode === 'date') {
        out.htmlTag = 'input';
        out.inputType = 'date';
        out.control = 'date';
      } else if (mode === 'time') {
        out.htmlTag = 'input';
        out.inputType = 'time';
        out.control = 'time';
      } else {
        out.htmlTag = 'select';
        out.control = 'selector';
        out.rangeKey = String(a['range-key'] || '');
      }
    }
    if (tag === 'switch') {
      out.htmlTag = 'input';
      out.inputType = 'checkbox';
      out.addClass = 'j-switch';
      out.control = 'switch';
    }
    if (tag === 'input' || tag === 'textarea') {
      out.control = tag;
      if (tag === 'input' && a.type) out.inputType = String(a.type);
    }
    if (tag === 'button') out.addClass = 'j-button';
    return out;
  }

  function hasAttr(attrs, name) {
    return Object.prototype.hasOwnProperty.call(attrs || {}, name);
  }

  /** wx: 指令与 bind/catch 事件名是否属于运行时专有属性。 */
  function isRuntimeAttr(name) {
    return name === 'wx:if' || name === 'wx:elif' || name === 'wx:else'
      || name === 'wx:for' || name === 'wx:for-item' || name === 'wx:for-index' || name === 'wx:key'
      || name.indexOf('bind') === 0 || name.indexOf('catch') === 0
      || name.indexOf('wx:') === 0;
  }

  /** bind* / catch* → DOM 事件名；catch* 需 stopPropagation。 */
  function eventInfo(name) {
    var isCatch = name.indexOf('catch') === 0;
    var short = isCatch ? name.slice('catch'.length) : (name.indexOf('bind') === 0 ? name.slice('bind'.length) : '');
    short = short.replace(/^:/, '');
    return {
      isCatch: isCatch,
      short: short,
      domEvent: EVENT_MAP[short] || short,
      confirmKey: short === 'confirm' ? 'Enter' : '',
    };
  }

  function datasetFrom(el) {
    var out = {};
    if (!el || !el.dataset) return out;
    Object.keys(el.dataset).forEach(function (k) { out[k] = el.dataset[k]; });
    return out;
  }

  /** 鼠标事件包装成小程序同形 e.touches[0].clientX（今日状态滑杆用）。 */
  function touchesFrom(domEvent) {
    var e = domEvent || {};
    var t = {
      clientX: typeof e.clientX === 'number' ? e.clientX : 0,
      clientY: typeof e.clientY === 'number' ? e.clientY : 0,
      pageX: typeof e.pageX === 'number' ? e.pageX : 0,
      pageY: typeof e.pageY === 'number' ? e.pageY : 0,
      identifier: 0,
    };
    return { touches: [t], changedTouches: [t] };
  }

  /** 构造 e.detail：input/textarea/date/selector/switch/swiper 各自对齐源码读取口径。 */
  function detailFor(control, el, domEvent, swiperCurrent) {
    var e = domEvent || {};
    var detail = {};
    if (control === 'switch') detail.value = !!(el && el.checked);
    else if (control === 'selector') {
      detail.value = el ? String(el.selectedIndex) : '0';
    } else if (control === 'swiper') {
      detail.current = typeof swiperCurrent === 'number' ? swiperCurrent : 0;
      detail.source = 'touch';
    } else if (el && typeof el.value !== 'undefined') {
      detail.value = el.value;
    }
    if (control === 'confirm' || e.type === 'keydown') {
      detail.value = el && typeof el.value !== 'undefined' ? el.value : detail.value;
    }
    return detail;
  }

  /** 完整的事件对象（对齐页面 JS 的 e.currentTarget.dataset / e.detail / e.touches）。 */
  function buildEvent(opts) {
    var o = opts || {};
    var el = o.el;
    var t = touchesFrom(o.domEvent);
    var ev = {
      type: o.short || '',
      timeStamp: Date.now(),
      currentTarget: {
        id: el && el.id ? el.id : '',
        dataset: datasetFrom(el),
        offsetTop: el && typeof el.offsetTop === 'number' ? el.offsetTop : 0,
        offsetLeft: el && typeof el.offsetLeft === 'number' ? el.offsetLeft : 0,
      },
      target: {
        id: o.domEvent && o.domEvent.target ? (o.domEvent.target.id || '') : '',
        dataset: datasetFrom(o.domEvent && o.domEvent.target ? o.domEvent.target : el),
      },
      detail: o.detail || {},
      touches: t.touches,
      changedTouches: t.changedTouches,
      _domEvent: o.domEvent || null,
    };
    return ev;
  }

  /**
   * 把动态控件值写入 DOM（setData 刷新时调用）。
   * 对 input/textarea 若正处于焦点则跳过 value 回写，避免打断输入（R4）。
   * @param {object} info resolve() 的结果
   * @param {HTMLElement} el 目标元素
   * @param {object} values { value, checked, range, rangeKey, min, max, start, current }
   */
  function applyControl(info, el, values) {
    if (!el) return;
    var v = values || {};
    if (info.control === 'switch') {
      var next = !!v.checked;
      if (el.checked !== next) el.checked = next;
      if (v.color) el.style.setProperty('--c-switch', v.color);
      return;
    }
    if (info.control === 'date' || info.control === 'time') {
      if (typeof v.value === 'string' && el.value !== v.value) el.value = v.value;
      if (v.start) el.setAttribute('min', String(v.start));
      if (v.end) el.setAttribute('max', String(v.end));
      return;
    }
    if (info.control === 'selector') {
      renderOptions(el, v.range, v.rangeKey, v.value);
      return;
    }
    if (info.control === 'swiper') {
      // current 变化由 wxml-runtime 决定是否触发 bindchange，这里只记录
      if (typeof v.current === 'number') el.setAttribute('data-j-current', String(v.current));
      return;
    }
    if (info.control === 'input' || info.control === 'textarea') {
      if (typeof v.value === 'undefined') return;
      var text = String(v.value === null || v.value === undefined ? '' : v.value);
      if (document.activeElement === el) return; // 焦点双保险：不覆盖正在输入的内容
      if (el.value !== text) el.value = text;
      return;
    }
    if (info.control === 'scroll-view' || info.addClass === 'j-scroll') {
      el.style.overflowY = info.scrollY ? 'auto' : 'hidden';
      el.style.overflowX = info.scrollX ? 'auto' : 'hidden';
    }
  }

  /** picker mode=selector 的 option 列表；用 DOM API 生成，天然防注入。 */
  function renderOptions(select, range, rangeKey, selected) {
    if (!select || select.tagName !== 'SELECT') return;
    var arr = Array.isArray(range) ? range : [];
    var key = String(rangeKey || '');
    var wanted = String(selected === undefined || selected === null ? '' : selected);
    var signature = arr.length + '|' + key + '|' + arr.map(function (item) {
      if (item === null || item === undefined) return '';
      return key && typeof item === 'object' ? String(item[key] || '') : String(item);
    }).join('\u0001');
    if (select.getAttribute('data-j-signature') === signature) {
      if (wanted !== '' && String(select.selectedIndex) !== wanted) {
        var idx = Number(wanted);
        if (isFinite(idx) && idx >= 0 && idx < arr.length) select.selectedIndex = idx;
      }
      return;
    }
    while (select.firstChild) select.removeChild(select.firstChild);
    arr.forEach(function (item, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      if (item === null || item === undefined) opt.textContent = '';
      else if (key && typeof item === 'object') opt.textContent = String(item[key] === undefined ? '' : item[key]);
      else opt.textContent = String(item);
      select.appendChild(opt);
    });
    select.setAttribute('data-j-signature', signature);
    var idx2 = Number(wanted);
    if (wanted !== '' && isFinite(idx2) && idx2 >= 0 && idx2 < arr.length) select.selectedIndex = idx2;
  }

  return {
    TAG_MAP: TAG_MAP,
    VOID_TAGS: VOID_TAGS,
    IGNORED_ATTRS: IGNORED_ATTRS,
    EVENT_MAP: EVENT_MAP,
    resolve: resolve,
    hasAttr: hasAttr,
    isRuntimeAttr: isRuntimeAttr,
    eventInfo: eventInfo,
    datasetFrom: datasetFrom,
    touchesFrom: touchesFrom,
    detailFor: detailFor,
    buildEvent: buildEvent,
    applyControl: applyControl,
    renderOptions: renderOptions,
  };
});
