'use strict';
/**
 * UI 反馈层（架构 §1.5 / 硬约束 6）：toast / modal / actionSheet 的 DOM 实现。
 *
 *  **只渲染传入文案，不改一个字**：title / content / confirmText / itemList 全部逐字输出，
 *  用 textContent 写入，既等价 WXML 文本转义，也不会让日记正文里的 < / & 破坏 DOM。
 *  按钮默认文字「取消」「确定」为小程序 showModal 的平台默认值，不是对源码文案的润色。
 *
 *  支持 icon:'none'（不渲染图标）、duration（toast 定时消失）、success({confirm}) /
 *  success({tapIndex}) / fail(errMsg) 回调语义。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeUiFeedback = api;
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  'use strict';

  function rootEl() {
    if (typeof document === 'undefined') return null;
    return document.getElementById('jiuge-feedback-root') || document.body;
  }

  function make(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  var toastTimer = null;
  var toastEl = null;

  function toast(opt) {
    var o = opt || {};
    var host = rootEl();
    if (!host) return;
    var title = String(o.title === undefined || o.title === null ? '' : o.title);
    var duration = Number(o.duration);
    if (!isFinite(duration) || duration <= 0) duration = 1500;
    duration = Math.max(500, Math.min(duration, 10000));
    // icon:'none' 的语义是「不显示图标」，本实现不渲染任何图标，文案原样输出
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = make('div', 'jiuge-toast', title);
    host.appendChild(toastEl);
    toastTimer = setTimeout(function () {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = null;
      toastTimer = null;
    }, duration);
  }

  function closeLayer(layer) {
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
  }

  function modal(opt) {
    var o = opt || {};
    var host = rootEl();
    if (!host) {
      if (typeof o.success === 'function') o.success({ confirm: false, cancel: true });
      return;
    }
    var title = String(o.title === undefined || o.title === null ? '' : o.title);
    var content = String(o.content === undefined || o.content === null ? '' : o.content);
    var confirmText = String(o.confirmText === undefined || o.confirmText === null ? '确定' : o.confirmText);
    var cancelText = String(o.cancelText === undefined || o.cancelText === null ? '取消' : o.cancelText);
    var showCancel = o.showCancel !== false;

    var mask = make('div', 'jiuge-mask');
    var box = make('div', 'jiuge-modal');
    box.appendChild(make('div', 'jiuge-modal-title', title));
    box.appendChild(make('div', 'jiuge-modal-content', content));
    var actions = make('div', 'jiuge-modal-actions');

    function done(result) {
      closeLayer(mask);
      if (typeof o.success === 'function') o.success(result);
      if (typeof o.complete === 'function') o.complete(result);
    }

    if (showCancel) {
      var cancelBtn = make('button', 'jiuge-btn jiuge-btn-ghost', cancelText);
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', function () { done({ confirm: false, cancel: true }); });
      actions.appendChild(cancelBtn);
    }
    var confirmBtn = make('button', 'jiuge-btn jiuge-btn-primary', confirmText);
    confirmBtn.type = 'button';
    confirmBtn.addEventListener('click', function () { done({ confirm: true, cancel: false }); });
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    mask.addEventListener('click', function () { done({ confirm: false, cancel: true }); });
    mask.appendChild(box);
    host.appendChild(mask);
    try { confirmBtn.focus(); } catch (e) { /* 焦点失败不影响 */ }
  }

  function actionSheet(opt) {
    var o = opt || {};
    var host = rootEl();
    var list = Array.isArray(o.itemList) ? o.itemList : [];
    if (!host || !list.length) {
      if (typeof o.fail === 'function') o.fail({ errMsg: 'showActionSheet:fail cancel' });
      return;
    }
    var mask = make('div', 'jiuge-mask');
    var sheet = make('div', 'jiuge-sheet');

    function done(result, isCancel) {
      closeLayer(mask);
      if (isCancel) {
        if (typeof o.fail === 'function') o.fail({ errMsg: 'showActionSheet:fail cancel' });
      } else if (typeof o.success === 'function') {
        o.success(result);
      }
      if (typeof o.complete === 'function') o.complete(result);
    }

    list.forEach(function (item, i) {
      var btn = make('button', 'jiuge-sheet-item', item);
      btn.type = 'button';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        done({ tapIndex: i }, false);
      });
      sheet.appendChild(btn);
    });
    mask.addEventListener('click', function () { done({}, true); });
    sheet.addEventListener('click', function (e) { e.stopPropagation(); });
    mask.appendChild(sheet);
    host.appendChild(mask);
  }

  /** P1 导入结果面板：只做展示，不改动 importBackup 的返回结构。 */
  function resultPanel(lines) {
    var host = rootEl();
    if (!host || !Array.isArray(lines) || !lines.length) return;
    var mask = make('div', 'jiuge-mask');
    var box = make('div', 'jiuge-modal');
    box.appendChild(make('div', 'jiuge-modal-title', '导入结果'));
    var panel = make('div', 'jiuge-result');
    lines.forEach(function (line) {
      var row = make('div', 'jiuge-result-row');
      row.appendChild(make('span', '', line[0]));
      row.appendChild(make('span', '', line[1]));
      panel.appendChild(row);
    });
    box.appendChild(panel);
    var actions = make('div', 'jiuge-modal-actions');
    var okBtn = make('button', 'jiuge-btn jiuge-btn-primary', '知道了');
    okBtn.type = 'button';
    okBtn.addEventListener('click', function () { closeLayer(mask); });
    actions.appendChild(okBtn);
    box.appendChild(actions);
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    mask.addEventListener('click', function () { closeLayer(mask); });
    mask.appendChild(box);
    host.appendChild(mask);
  }

  return {
    toast: toast,
    modal: modal,
    actionSheet: actionSheet,
    resultPanel: resultPanel,
  };
});
