'use strict';
/**
 * 严过关（Yan）· QA 自建 Electron 启动器（仅测试用）。
 *
 * 目的：以**真实产品 main.js** 启动应用（窗口/安全配置/菜单/关窗 flush 链路全部真跑），
 * 只把 main.js 里 `require('../../tools/renderer-probe.js')` 重定向到 QA 自己的探针
 * `tests/qa-probe.js` —— 断言自己写，不污染 src/ 与 tools/。
 *
 * 数据目录隔离到 tests/.qa-userdata，两次启动（probe / readback）共用，绝不碰真实用户数据。
 * 结果落 tests/qa-logs/qa-probe.json | qa-readback.json，由 qa-electron-driver.js 汇总。
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const electron = require('electron');
const { app, BrowserWindow } = electron;

const TESTS = __dirname;
const LOG_DIR = path.join(TESTS, 'qa-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// 隔离数据目录（两次启动共享；与真实 %APPDATA% 用户数据完全无关）
const QA_USERDATA = path.join(TESTS, '.qa-userdata');
app.setPath('userData', QA_USERDATA);

const mode = process.env.JIUGE_TEST_READBACK === '1' ? 'readback' : 'probe';
const outFile = path.join(LOG_DIR, 'qa-' + mode + '.json');

const consoleMessages = [];
const jsErrors = [];
let lastProbe = null;

// 把产品 main.js 对工程师探针的 require 重定向到 QA 自己的探针
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '../../tools/renderer-probe.js') return require('./qa-probe.js');
  return origLoad.apply(this, arguments);
};

function isRealJsError(level, message) {
  const lv = String(level);
  const isErr = lv === '3' || /error/i.test(lv);
  if (!isErr) return false;
  const m = String(message || '');
  // 白名单（主理人已裁定）：开发模式 CSP / unsafe-eval 警告；宿主 NODE_OPTIONS 提示
  if (/Content Security Policy|unsafe-eval|NODE_OPTION/i.test(m)) return false;
  return true;
}

function attach(wc) {
  wc.on('console-message', function (evt, level, message, line, sourceId) {
    const rec = { level: String(level), message: String(message), line: line, source: String(sourceId) };
    consoleMessages.push(rec);
    if (isRealJsError(level, message)) jsErrors.push(rec);
  });
  wc.on('render-process-gone', function (e, d) {
    jsErrors.push({ level: 'crash', message: 'render-process-gone ' + JSON.stringify(d || {}) });
  });
  if (typeof wc.on === 'function') {
    wc.on('preload-error', function (e, p, err) {
      jsErrors.push({ level: 'preload', message: 'preload-error ' + String((err && err.message) || err) });
    });
  }
}

function writeOut(probeResult) {
  const data = {
    mode: mode,
    generatedAt: new Date().toISOString(),
    userData: QA_USERDATA,
    probe: probeResult,
    jsErrors: jsErrors,
    consoleMessages: consoleMessages,
  };
  try { fs.writeFileSync(outFile, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  const n = probeResult && probeResult.checks ? probeResult.checks.length : 0;
  console.log('[QA_ENTRY] 结果写入 ' + outFile + ' / 断言数=' + n);
}

// 真实产品入口（窗口、安全配置、菜单、flush 链路、KP 真源全部走产品代码）
require(path.resolve(TESTS, '..', 'src', 'main', 'main.js'));

app.whenReady().then(function () {
  // main.js 的 boot() 在本回调之前已同步建窗；等一拍拿窗口挂 console 监听
  setTimeout(function () {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) attach(wins[0].webContents);
  }, 250);

  // main.js 在 1800ms 注入探针；这里 2800ms 读取结构化结果（探针已执行完）
  setTimeout(function () {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w || w.isDestroyed()) { writeOut(null); return; }
    w.webContents.executeJavaScript('window.__QA_RESULT__ || null').then(function (res) {
      lastProbe = res;
      writeOut(res);
    }).catch(function (e) {
      writeOut({ error: String((e && e.message) || e) });
    });
  }, 2800);
});

// 退出前再写一次，把关闭阶段新增的控制台消息一并落盘
app.on('before-quit', function () { writeOut(lastProbe); });
