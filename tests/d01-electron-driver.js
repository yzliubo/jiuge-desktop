'use strict';
/**
 * D01 缺陷验证 · Electron 驱动（仅测试用，纯 Node 运行）。
 *
 * 用法：
 *   node tests/d01-electron-driver.js before   # 修复前取证
 *   node tests/d01-electron-driver.js after    # 修复后验收
 *
 * 说明：Windows GUI 子系统会吞 stdout，故以 `--enable-logging=file --log-file=` 落盘日志为准，
 * 断言结果由 tests/d01-electron-entry.js 写入 tests/d01-logs/d01-<label>.json，本文件负责
 * 汇总打印 + 机器配置记录。宿主注入的 ELECTRON_RUN_AS_NODE 必须先清除，否则 electron.exe 会当 Node 跑。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TESTS = __dirname;
const ROOT = path.resolve(TESTS, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ENTRY = path.join(TESTS, 'd01-electron-entry.js');
const LOG_DIR = path.join(TESTS, 'd01-logs');
const LABEL = String(process.argv[2] || 'run').replace(/[^a-z0-9_-]/gi, '') || 'run';
const CLOSE_MS = 8000;

fs.mkdirSync(LOG_DIR, { recursive: true });

function machineInfo() {
  const cpus = os.cpus();
  return {
    platform: os.platform() + ' ' + os.release() + ' / ' + process.arch,
    cpu: cpus.length ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    memGB: Math.round(os.totalmem() / 1073741824),
    node: process.version,
  };
}

function runOnce() {
  return new Promise(function (resolve) {
    const logFile = path.join(LOG_DIR, 'electron-' + LABEL + '.log');
    try { if (fs.existsSync(logFile)) fs.unlinkSync(logFile); } catch (e) { /* ignore */ }
    const outFile = path.join(LOG_DIR, 'd01-' + LABEL + '.json');
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) { /* ignore */ }

    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;   // 宿主注入，必须清除，否则 electron 退化成 Node
    env.ELECTRON_ENABLE_LOGGING = '1';
    env.D01_LABEL = LABEL;
    env.JIUGE_TEST_CLOSE_MS = String(CLOSE_MS);

    const args = [ENTRY, '--enable-logging=file', '--log-file=' + logFile];
    console.log('[D01 RUN:' + LABEL + '] ' + EXE + ' ' + args.join(' '));
    const child = spawn(EXE, args, { env: env, cwd: ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function (d) { stdout += String(d); });
    child.stderr.on('data', function (d) { stderr += String(d); });
    const timer = setTimeout(function () {
      console.log('[D01 TIMEOUT] ' + LABEL + ' 60s → kill');
      try { child.kill(); } catch (e) { /* ignore */ }
    }, 60000);
    child.on('error', function (e) { console.log('[D01 SPAWN_ERROR] ' + e.message); });
    child.on('close', function (code) {
      clearTimeout(timer);
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      let json = null;
      try {
        json = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
      } catch (e) {
        json = { error: String((e && e.message) || e), checks: [], facts: {} };
      }
      resolve({ exitCode: code, log: log, stdout: stdout, stderr: stderr, json: json, logBytes: log.length });
    });
  });
}

(async function main() {
  if (!fs.existsSync(EXE)) {
    console.error('[D01 FATAL] 找不到 electron.exe：' + EXE);
    process.exitCode = 2;
    return;
  }
  const r = await runOnce();
  const json = r.json || { checks: [], facts: {} };
  const checks = Array.isArray(json.checks) ? json.checks : [];
  const failed = checks.filter(function (c) { return !c.ok; });

  console.log('\n================ D01 探针（' + LABEL + '）================');
  checks.forEach(function (c) {
    console.log('[' + (c.ok ? 'PASS' : 'FAIL') + '] ' + c.id + ' ' + c.name + ' → ' + c.detail);
  });
  const summary = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    machine: machineInfo(),
    exitCode: r.exitCode,
    logBytes: r.logBytes,
    checksTotal: checks.length,
    checksPassed: checks.length - failed.length,
    checksFailed: failed.map(function (c) { return c.id; }),
    facts: json.facts || {},
    jsErrors: Array.isArray(json.jsErrors) ? json.jsErrors : [],
    consoleMessages: Array.isArray(json.consoleMessages) ? json.consoleMessages.length : 0,
  };
  fs.writeFileSync(path.join(LOG_DIR, 'd01-summary-' + LABEL + '.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n机器配置：' + summary.machine.cpu + ' / ' + summary.machine.cores + ' 核 / '
    + summary.machine.memGB + 'GB / ' + summary.machine.platform + ' / node ' + summary.machine.node);
  console.log('electron exitCode=' + r.exitCode + ' / logBytes=' + r.logBytes
    + ' / 控制台消息 ' + summary.consoleMessages + ' 条 / JS 异常 ' + summary.jsErrors.length + ' 条');
  if (summary.jsErrors.length) console.log('JS 异常：' + JSON.stringify(summary.jsErrors.slice(0, 5)));
  console.log('断言 ' + checks.length + ' 条，通过 ' + (checks.length - failed.length) + ' 条，失败 ' + failed.length + ' 条');
  console.log('IS_PASS: ' + (failed.length === 0 ? 'YES' : 'NO'));
  process.exitCode = failed.length === 0 ? 0 : 1;
})().catch(function (e) {
  console.error('D01_DRIVER_FATAL ' + String((e && e.stack) || e));
  process.exitCode = 2;
});
