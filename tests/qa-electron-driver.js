'use strict';
/**
 * 严过关（Yan）· QA 自建 Electron 驱动（仅测试用）。
 *
 * 两次真实启动：
 *   run1: JIUGE_TEST_PROBE=1 + JIUGE_TEST_CLOSE_MS=6000 → 探针断言 + 关窗 flush 落盘
 *   run2: JIUGE_TEST_READBACK=1 + JIUGE_TEST_CLOSE_MS=4000 → 回启读回断言
 *
 * 日志捕获：Windows GUI 子系统会吞 stdout，因此以 `--enable-logging=file --log-file=` 落盘日志为准，
 * stdout/stderr 仅作兜底。断言全部由 QA 自己写（不读工程师任何判定）。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TESTS = __dirname;
const ROOT = path.resolve(TESTS, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ENTRY = path.join(TESTS, 'qa-electron-entry.js');
const LOG_DIR = path.join(TESTS, 'qa-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const CHECKS = [];
function put(id, name, ok, detail) {
  CHECKS.push({ id: id, name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + id + ' ' + name + ' → ' + detail);
}

function runOnce(mode, closeMs) {
  return new Promise(function (resolve) {
    const logFile = path.join(LOG_DIR, 'electron-' + mode + '.log');
    try { if (fs.existsSync(logFile)) fs.unlinkSync(logFile); } catch (e) { /* ignore */ }
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;       // 宿主注入，必须清除
    env.ELECTRON_ENABLE_LOGGING = '1';
    if (mode === 'readback') env.JIUGE_TEST_READBACK = '1';
    else env.JIUGE_TEST_PROBE = '1';
    env.JIUGE_TEST_CLOSE_MS = String(closeMs);

    const args = [ENTRY, '--enable-logging=file', '--log-file=' + logFile];
    console.log('[RUN] ' + mode + ' → ' + EXE + ' ' + args.join(' '));
    const child = spawn(EXE, args, { env: env, cwd: ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function (d) { stdout += String(d); });
    child.stderr.on('data', function (d) { stderr += String(d); });
    const timer = setTimeout(function () {
      console.log('[TIMEOUT] ' + mode + ' 60s → kill');
      try { child.kill(); } catch (e) { /* ignore */ }
    }, 60000);
    child.on('error', function (e) { console.log('[SPAWN_ERROR] ' + e.message); });
    child.on('close', function (code) {
      clearTimeout(timer);
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      const jsonPath = path.join(LOG_DIR, 'qa-' + mode + '.json');
      let json = null;
      try { json = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null; } catch (e) { json = null; }
      resolve({ mode: mode, exitCode: code, stdout: stdout, stderr: stderr, log: log, json: json, logBytes: log.length });
    });
  });
}

function combined(r) { return [r.log, r.stdout, r.stderr].join('\n'); }

(async function main() {
  const run1 = await runOnce('probe', 6000);
  const run2 = await runOnce('readback', 4000);

  // ---------- run1：启动 / 探针 / 关窗 flush ----------
  put('E-RUN1', 'run1 真实启动并正常退出（exit 0）', run1.exitCode === 0,
    'exitCode=' + run1.exitCode + ' / logBytes=' + run1.logBytes);

  const c1 = combined(run1);
  const bootOk = /bootstrap 结果：\s*\{"ok":true,"pages":5,"loadedScripts":5\}/.test(c1);
  put('B-33', '启动日志 bootstrap 结果 loadedScripts=5 / pages=5', bootOk,
    (c1.match(/\[启动\] bootstrap 结果：[^\n]*/) || ['未找到 bootstrap 行'])[0]);

  const fiveWxml = /\[页面运行时\] 启动完成：5 个常驻 Page 实例，冷启动落在「今日」/.test(c1);
  put('B-34', '启动日志：5 个常驻 Page 实例，冷启动落在「今日」', fiveWxml,
    (c1.match(/\[页面运行时\] 启动完成：[^\n]*/) || ['未找到启动完成行'])[0]);

  const ipcLine = /\[启动\] 同步通道 9 条 \/ 异步通道 6 条 \/ 推送通道 4 条/.test(c1);
  put('B-35', '启动日志：IPC 通道注册齐全（同步 9 / 异步 6 / 推送 4）', ipcLine,
    (c1.match(/\[启动\] 同步通道[^\n]*/) || ['未找到 IPC 注册行'])[0]);

  const probeChecks = (run1.json && run1.json.probe && Array.isArray(run1.json.probe.checks))
    ? run1.json.probe.checks : [];
  const probeFail = probeChecks.filter(function (c) { return !c.ok; });
  put('B-36', 'QA 自建渲染探针断言全部通过', probeChecks.length >= 28 && probeFail.length === 0,
    '断言=' + probeChecks.length + ' / 失败=' + probeFail.length
    + (probeFail.length ? ' → ' + probeFail.map(function (c) { return c.id + ':' + c.name + '(' + c.detail + ')'; }).join(' | ') : ''));

  const jsErr = run1.json && Array.isArray(run1.json.jsErrors) ? run1.json.jsErrors : [];
  put('B-37', '控制台 JS 异常 0（已排除开发模式 CSP / unsafe-eval 白名单）', jsErr.length === 0,
    jsErr.length ? JSON.stringify(jsErr.slice(0, 4)) : '异常 0 条 / 控制台消息 ' + ((run1.json && run1.json.consoleMessages || []).length) + ' 条');

  const flushOrder = /\[退出 flush\] 顺序完成：syncWorkReflection → syncStudyNote → persist → stopTimer/.test(c1);
  put('D-09', '关窗 flush 真调用且顺序为 syncWorkReflection→syncStudyNote→persist→stopTimer', flushOrder,
    (c1.match(/\[退出 flush\] 顺序完成：[^\n]*/) || ['未找到 flush 顺序行'])[0]);

  const flushDone = /app:flush-done\{ok:true\} → kv:flush → quit/.test(c1);
  const noFallback = !/3 秒兜底/.test(c1);
  put('D-10', 'flush-done 回执触发退出（非 3 秒兜底）', flushDone && noFallback,
    'flushDone=' + flushDone + ' / 无兜底=' + noFallback + ' → ' + ((c1.match(/\[退出链路\][^\n]*/g) || []).join(' || ') || '无'));

  const kvFlush = /\[退出链路\] kv:flush → \d+ 字节/.test(c1);
  put('D-11', '退出链路 kv:flush 真实写盘字节数', kvFlush,
    (c1.match(/\[退出链路\] kv:flush → [^\n]*/) || ['未找到 kv:flush 行'])[0]);

  // ---------- run2：回启读回 ----------
  put('E-RUN2', 'run2 回启读回并正常退出（exit 0）', run2.exitCode === 0,
    'exitCode=' + run2.exitCode + ' / logBytes=' + run2.logBytes);

  const rbChecks = (run2.json && run2.json.probe && Array.isArray(run2.json.probe.checks))
    ? run2.json.probe.checks : [];
  const rbFail = rbChecks.filter(function (c) { return !c.ok; });
  put('D-12', '关窗 flush 后回启：工作感想 / 今日一句 / 当前格正文仍在（正文不丢字）',
    rbChecks.length >= 4 && rbFail.length === 0,
    '断言=' + rbChecks.length + ' / 失败=' + rbFail.length
    + (rbFail.length ? ' → ' + rbFail.map(function (c) { return c.id + ':' + c.detail; }).join(' | ') : ''));

  const rbJsErr = run2.json && Array.isArray(run2.json.jsErrors) ? run2.json.jsErrors : [];
  put('D-13', 'run2 控制台 JS 异常 0', rbJsErr.length === 0, rbJsErr.length ? JSON.stringify(rbJsErr.slice(0, 4)) : '异常 0 条');

  // ---------- 汇总 ----------
  const allProbe = probeChecks.concat(rbChecks);
  const total = CHECKS.length;
  const passed = CHECKS.filter(function (c) { return c.ok; }).length;
  const out = {
    generatedAt: new Date().toISOString(),
    driverChecks: CHECKS,
    driverTotal: total,
    driverPassed: passed,
    driverFailed: total - passed,
    probeChecks: allProbe,
    probeTotal: allProbe.length,
    probeFailed: allProbe.filter(function (c) { return !c.ok; }).length,
    run1: { exitCode: run1.exitCode, logBytes: run1.logBytes, jsErrors: jsErr.length, consoleMessages: (run1.json && run1.json.consoleMessages || []).length },
    run2: { exitCode: run2.exitCode, logBytes: run2.logBytes, jsErrors: rbJsErr.length },
    userData: run1.json ? run1.json.userData : '',
  };
  fs.writeFileSync(path.join(LOG_DIR, 'qa-electron-summary.json'), JSON.stringify(out, null, 2), 'utf8');

  console.log('\n================ QA 自建 Electron 探针 ================');
  console.log('探针断言 ' + allProbe.length + ' 条（run1=' + probeChecks.length + ' / run2=' + rbChecks.length + '），失败 ' + out.probeFailed + ' 条');
  console.log('驱动断言 ' + total + ' 条，通过 ' + passed + ' 条，失败 ' + (total - passed) + ' 条');
  console.log('IS_PASS: ' + (out.probeFailed === 0 && out.driverFailed === 0 ? 'YES' : 'NO'));
  process.exitCode = (out.probeFailed === 0 && out.driverFailed === 0) ? 0 : 1;
})().catch(function (e) {
  console.error('QA_ELECTRON_FATAL ' + String((e && e.stack) || e));
  process.exitCode = 2;
});
