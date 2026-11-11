'use strict';
// B 架构 M1：单实例锁 + 四道 flush 兜底
// 主进程独立落盘，不依赖渲染进程回执；取锁失败时连 KV 都不初始化。
// 采用注入式钩子，纯 Node 可测；Electron 适配由 main 层传入 app / powerMonitor。
// 对应 04-质量保障方案 §4.4
const contract = require('./contract');

function createLifecycle(repository) {
  function flush(reason) {
    if (!repository.isDirty()) return { flushed: false, reason: reason || 'unknown' };
    return Object.assign({ reason: reason || 'unknown' }, repository.flush(reason));
  }

  // 四道（+ process exit 共五处）兜底；hooks 为函数 setter，注册回调
  function installFlushGuards(hooks) {
    const h = hooks || {};
    const installed = [];
    const bind = function (name, setter) {
      if (typeof setter === 'function') {
        setter(function () { return flush(name); });
        installed.push(name);
      }
    };
    bind('before-quit', h.onBeforeQuit);
    bind('window-all-closed', h.onWindowAllClosed);
    bind('power-shutdown', h.onPowerShutdown);
    bind('power-suspend', h.onPowerSuspend);
    bind('process-exit', h.onProcessExit);
    return installed;
  }

  function requestSingleInstanceLock(appLike) {
    if (!appLike || typeof appLike.requestSingleInstanceLock !== 'function') {
      return { granted: true, simulated: true };
    }
    const granted = appLike.requestSingleInstanceLock();
    if (!granted) {
      const err = new Error('已有实例在运行，本次不初始化 KV');
      err.code = contract.CODE.SECOND_INSTANCE;
      throw err;
    }
    return { granted: true };
  }

  return {
    flush: flush,
    installFlushGuards: installFlushGuards,
    requestSingleInstanceLock: requestSingleInstanceLock
  };
}

module.exports = { createLifecycle: createLifecycle };
