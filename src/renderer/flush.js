'use strict';
/**
 * 退出 flush 编排（架构 §6.2 / Q6：绝不静默丢稿）。
 *
 *  链路：app:confirm-exit-request → app:confirm-exit → app:before-flush →
 *        syncWorkReflection() → syncStudyNote() → persist() → stopTimer() →
 *        app:flush-done →（主进程）kv:flush → quit。
 *
 *  - 顺序是硬约束：工作感想 → 今日一句 → 当前格正文 / base / 三大模块；
 *  - P1：有未保存输入时二次确认「还有没保存的内容，确定退出吗？」（架构新增文案之一）；
 *  - 3 秒兜底在主进程，渲染进程没回 flush-done 时主进程自行 kv:flush 后退出。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeFlush = api;
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  'use strict';

  var J = G.__jiuge || {};
  var handling = false;

  function toast(title) {
    if (G.wx && typeof G.wx.showToast === 'function') {
      G.wx.showToast({ title: title, icon: 'none', duration: 2200 });
    }
  }

  function feedback() {
    return G.JiugeUiFeedback || null;
  }

  /** 标记「有未失焦的输入」：页面 JS 的 bindblur 会在 focusout 后落盘，故 focusout 即清脏。 */
  function bindDirtyTracking() {
    if (typeof document === 'undefined') return;
    document.addEventListener('input', function () { G.__jiugeDirty = true; }, true);
    document.addEventListener('change', function () { G.__jiugeDirty = true; }, true);
    document.addEventListener('focusout', function () {
      setTimeout(function () { G.__jiugeDirty = false; }, 0);
    }, true);
  }

  function hasDirtyInput() {
    if (G.__jiugeDirty) return true;
    if (typeof document === 'undefined') return false;
    var el = document.activeElement;
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return false;
    return String(el.value || '').length > 0;
  }

  /** 顺序 1→2→3：与源码 onHide() / finishToday() 的落盘顺序完全一致。 */
  function flushAll(reason) {
    if (handling) return { ok: true, already: true };
    handling = true;
    var rt = G.JiugeRuntime;
    var today = rt ? rt.byId('index') : null;
    var done = [];
    if (today) {
      ['syncWorkReflection', 'syncStudyNote', 'persist'].forEach(function (name) {
        if (typeof today[name] === 'function') {
          try {
            today[name]();
            done.push(name);
          } catch (e) {
            console.error('[退出 flush] ' + name + ' 异常：' + String(e && e.stack || e));
          }
        }
      });
      if (typeof today.stopTimer === 'function') {
        try { today.stopTimer(); done.push('stopTimer'); } catch (e) { /* 同上 */ }
      }
    }
    // 关闭浮层：通知各页 onHide（源码切 tab 语义，兜底感想 / 一句落盘）
    if (rt && typeof rt.pages === 'function') {
      rt.pages().forEach(function (p) {
        if (p && p !== today && typeof p.onHide === 'function') {
          try { p.onHide(); } catch (e) { /* 不阻断退出 */ }
        }
      });
    }
    G.__jiugeDirty = false;
    console.log('[退出 flush] 顺序完成：' + done.join(' → ') + '（来源：' + (reason || 'close') + '）');

    if (!J.flush || typeof J.flush.done !== 'function') {
      console.warn('[退出 flush] 缺少 __jiuge.flush.done，主进程 3 秒兜底会接管');
      return { ok: true, done: done, offline: true };
    }
    J.flush.done({ ok: true, dirty: false }).catch(function (e) {
      console.error('[退出 flush] flush-done 回报失败：' + String(e && e.message || e));
    });
    return { ok: true, done: done };
  }

  function bind() {
    if (!J.flush) return;
    if (typeof J.flush.onConfirmExitRequest === 'function') {
      J.flush.onConfirmExitRequest(function (payload) {
        var dirty = !!(payload && payload.dirty) || hasDirtyInput();
        if (!dirty) {
          if (J.flush.confirmExit) J.flush.confirmExit({ proceed: true });
          return;
        }
        var ui = feedback();
        if (!ui || typeof ui.modal !== 'function') {
          if (J.flush.confirmExit) J.flush.confirmExit({ proceed: true });
          return;
        }
        ui.modal({
          title: '退出确认',
          content: '还有没保存的内容，确定退出吗？',
          confirmText: '退出',
          cancelText: '继续编辑',
          success: function (m) {
            if (J.flush.confirmExit) J.flush.confirmExit({ proceed: !!m.confirm });
          },
        });
      });
    }
    if (typeof J.flush.onBeforeFlush === 'function') {
      J.flush.onBeforeFlush(function (payload) {
        flushAll(payload && payload.reason);
      });
    }
    if (typeof J.flush.onQuotaSimulated === 'function') {
      J.flush.onQuotaSimulated(function (payload) {
        // P4：仅测试用（JIUGE_KV_QUOTA 注入），不产生产品文案
        console.warn('[QUOTA 模拟] limitBytes=' + (payload && payload.limitBytes));
      });
    }
  }

  bindDirtyTracking();
  bind();

  return {
    flushAll: flushAll,
    hasDirtyInput: hasDirtyInput,
    toast: toast,
  };
});
