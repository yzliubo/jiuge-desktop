'use strict';
/**
 * D01 · QA 独立回归启动器（仅测试用）。
 *
 * 用**真实产品 main.js** 起窗（窗口安全配置、5 个常驻 Page、flush 链路全真跑），
 * 渲染进程就绪后注入 tests/d01-qa-probe.js 的 d01QaProbe()，把结构化结果落盘。
 *
 * 与工程师的 d01-electron-entry.js 差异：独立日志目录 / 独立 userData / 独立探针，
 * 不设置 JIUGE_TEST_PROBE（避免产品探针二次注入），不改 src/ 与 tools/ 任何一行。
 * Windows GUI 子进程会吞 stdout，故日志走 `--enable-logging=file --log-file=`。
 */
const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { app, BrowserWindow } = electron;

const TESTS = __dirname;
const LOG_DIR = path.join(TESTS, 'd01-qa-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const LABEL = String(process.env.D01QA_LABEL || 'run').replace(/[^a-z0-9_-]/gi, '') || 'run';
const OUT_FILE = path.join(LOG_DIR, 'd01-qa-' + LABEL + '.json');

// 数据目录隔离：绝不写真实 %APPDATA%，也不与工程师的 .d01-userdata 混用
app.setPath('userData', path.join(TESTS, '.d01-qa-userdata'));

const consoleMessages = [];
const jsErrors = [];
let written = false;

function isRealJsError(level, message) {
  const lv = String(level);
  const isErr = lv === '3' || /error/i.test(lv);
  if (!isErr) return false;
  const m = String(message || '');
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
}

function writeOut(probeResult) {
  written = true;
  const checks = probeResult && Array.isArray(probeResult.checks) ? probeResult.checks : [];
  const data = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    userData: path.join(TESTS, '.d01-qa-userdata'),
    checks: checks,
    facts: (probeResult && probeResult.facts) || {},
    failed: checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.id; }),
    jsErrors: jsErrors,
    consoleMessages: consoleMessages,
  };
  try { fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  console.log('[D01QA_ENTRY] 结果写入 ' + OUT_FILE + ' / 断言数=' + checks.length
    + ' / 失败=' + data.failed.join(','));
}

// 真实产品入口
require(path.resolve(TESTS, '..', 'src', 'main', 'main.js'));

const { d01QaProbe } = require('./d01-qa-probe.js');

app.whenReady().then(function () {
  // main.js 的 boot() 在本回调之前已同步建窗；等一拍挂 console 监听
  setTimeout(function () {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) attach(wins[0].webContents);
  }, 250);

  // 3600ms：页面脚本、首帧 WXML、主题 CSS 均已就绪（main.js 自身探针在 1800ms）
  setTimeout(function () {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w || w.isDestroyed()) {
      writeOut({ checks: [{ id: 'QA-FATAL', name: '窗口不可用', ok: false, detail: 'no window' }] });
      return;
    }
    const code = '(' + d01QaProbe.toString() + ')()';
    w.webContents.executeJavaScript(code).then(function (res) {
      writeOut(res || { checks: [], facts: {} });
    }).catch(function (e) {
      writeOut({ checks: [{ id: 'QA-FATAL', name: '注入失败', ok: false, detail: String((e && e.message) || e) }] });
    });
  }, 3600);
});

// 退出前再写一次，把关闭阶段新增的控制台异常一并落盘
app.on('before-quit', function () {
  if (!written) writeOut({ checks: [], facts: {} });
});
