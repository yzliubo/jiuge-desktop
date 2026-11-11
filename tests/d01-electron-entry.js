'use strict';
/**
 * D01 缺陷验证 · Electron 启动器（仅测试用）。
 *
 * 以**真实产品 main.js** 启动应用（窗口 / 安全配置 / 5 个常驻 Page / flush 链路全真跑），
 * 只是在渲染进程就绪后注入 tests/d01-probe.js 的 d01Probe()，把结构化结果落盘。
 *
 * 数据目录隔离到 tests/.d01-userdata，绝不碰真实用户数据；不改 src/ 与 tools/ 任何一行。
 * 与 main.js 的关系：不设置 JIUGE_TEST_PROBE（避免产品探针二次注入），完全由本文件驱动。
 */
const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { app, BrowserWindow } = electron;

const TESTS = __dirname;
const LOG_DIR = path.join(TESTS, 'd01-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const LABEL = String(process.env.D01_LABEL || 'run').replace(/[^a-z0-9_-]/gi, '') || 'run';
const OUT_FILE = path.join(LOG_DIR, 'd01-' + LABEL + '.json');

// 隔离数据目录（每次运行前由 driver 清理，保证「首帧空库」这类断言可复现）
app.setPath('userData', path.join(TESTS, '.d01-userdata'));

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
    userData: path.join(TESTS, '.d01-userdata'),
    checks: checks,
    facts: (probeResult && probeResult.facts) || {},
    failed: checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.id; }),
    jsErrors: jsErrors,
    consoleMessages: consoleMessages,
  };
  try { fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  console.log('[D01_ENTRY] 结果写入 ' + OUT_FILE + ' / 断言数=' + checks.length
    + ' / 失败=' + data.failed.join(','));
}

// 真实产品入口
require(path.resolve(TESTS, '..', 'src', 'main', 'main.js'));

const { d01Probe } = require('./d01-probe.js');

app.whenReady().then(function () {
  // main.js 的 boot() 在本回调之前已同步建窗；等一拍挂 console 监听
  setTimeout(function () {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) attach(wins[0].webContents);
  }, 250);

  // 3200ms：页面脚本、首帧 WXML、主题 CSS 均已就绪（main.js 自身探针在 1800ms）
  setTimeout(function () {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w || w.isDestroyed()) { writeOut({ checks: [{ id: 'D01-FATAL', name: '窗口不可用', ok: false, detail: 'no window' }] }); return; }
    const code = '(' + d01Probe.toString() + ')()';
    w.webContents.executeJavaScript(code).then(function (res) {
      writeOut(res || { checks: [], facts: {} });
    }).catch(function (e) {
      writeOut({ checks: [{ id: 'D01-FATAL', name: '注入失败', ok: false, detail: String((e && e.message) || e) }] });
    });
  }, 3200);
});

// 退出前再写一次，把关闭阶段新增的控制台异常一并落盘
app.on('before-quit', function () {
  if (!written) writeOut({ checks: [], facts: {} });
});
