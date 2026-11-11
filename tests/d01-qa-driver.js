'use strict';
/**
 * D01 · QA 独立回归驱动（纯 Node 运行）。
 *
 * 用法：node tests/d01-qa-driver.js [label]
 *
 * 职责：
 *   1. 清空隔离 userData → 用真实 electron.exe 跑 tests/d01-qa-entry.js（GUI 吞 stdout，以落盘日志为准；
 *      宿主注入的 ELECTRON_RUN_AS_NODE 必须先删掉，否则 electron 退化成 Node）；
 *   2. **独立**跑回归基线：verify / smoke / bench(×2) / copy-source --check --pages / node --check 全量；
 *   3. 改动范围核验：src 全量 SHA256 + mtime 审计，另用 .sha256.json 单独复核 8 个 utils 逐字节一致；
 *   4. 汇总成 tests/d01-qa-logs/d01-qa-summary-<label>.json 并打印。
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const TESTS = __dirname;
const ROOT = path.resolve(TESTS, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ENTRY = path.join(TESTS, 'd01-qa-entry.js');
const LOG_DIR = path.join(TESTS, 'd01-qa-logs');
const USERDATA = path.join(TESTS, '.d01-qa-userdata');
const LABEL = String(process.argv[2] || 'run').replace(/[^a-z0-9_-]/gi, '') || 'run';
const CLOSE_MS = 9000;

fs.mkdirSync(LOG_DIR, { recursive: true });

const FIXED_FILE = 'renderer/wxml-runtime.js';

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

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function walk(dir, base, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, base, acc);
    else acc.push(p);
  });
  return acc;
}

/** ---------------------------------------------------------------- Electron 一轮 */
function runElectron() {
  return new Promise(function (resolve) {
    const logFile = path.join(LOG_DIR, 'electron-qa-' + LABEL + '.log');
    const outFile = path.join(LOG_DIR, 'd01-qa-' + LABEL + '.json');
    try { if (fs.existsSync(logFile)) fs.unlinkSync(logFile); } catch (e) { /* ignore */ }
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) { /* ignore */ }
    // 每次运行前清空隔离数据目录，保证「首帧空库」断言可复现
    try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;    // 宿主注入，必须清除
    env.ELECTRON_ENABLE_LOGGING = '1';
    env.D01QA_LABEL = LABEL;
    env.JIUGE_TEST_CLOSE_MS = String(CLOSE_MS);

    const args = [ENTRY, '--enable-logging=file', '--log-file=' + logFile];
    console.log('[QA RUN:' + LABEL + '] ' + EXE + ' ' + args.join(' '));
    const child = spawn(EXE, args, { env: env, cwd: ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function (d) { stdout += String(d); });
    child.stderr.on('data', function (d) { stderr += String(d); });
    const timer = setTimeout(function () {
      console.log('[QA TIMEOUT] ' + LABEL + ' 90s → kill');
      try { child.kill(); } catch (e) { /* ignore */ }
    }, 90000);
    child.on('error', function (e) { console.log('[QA SPAWN_ERROR] ' + e.message); });
    child.on('close', function (code) {
      clearTimeout(timer);
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      let json = null;
      try {
        json = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
      } catch (e) {
        json = { error: String((e && e.message) || e), checks: [], facts: {} };
      }
      resolve({ exitCode: code, logBytes: log.length, stdout: stdout, stderr: stderr, json: json });
    });
  });
}

/** ---------------------------------------------------------------- 基线工具 */
function runNode(args, opts) {
  const o = opts || {};
  const t0 = Date.now();
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, o.env || {}),
    });
    return { ok: true, code: 0, ms: Date.now() - t0, out: stdout };
  } catch (e) {
    return {
      ok: false, code: e.status === undefined ? -1 : e.status, ms: Date.now() - t0,
      out: String(e.stdout || '') + String(e.stderr || ''),
    };
  }
}

function num(re, text, group) {
  const m = re.exec(String(text || ''));
  return m ? Number(m[group || 1]) : null;
}

function baselines() {
  const out = {};

  const v = runNode(['tools/verify-equivalence.js']);
  out.verify = {
    ok: v.ok, exitCode: v.code, ms: v.ms,
    total: num(/验证项\s*(\d+)\s*条/, v.out),
    passed: num(/验证项\s*\d+\s*条，通过\s*(\d+)\s*条/, v.out),
    failed: num(/失败\s*(\d+)\s*条/, v.out),
    tail: v.out.trim().split('\n').slice(-4).join(' | '),
  };

  const s = runNode(['tools/smoke.js']);
  out.smoke = {
    ok: s.ok, exitCode: s.code, ms: s.ms,
    total: num(/smoke 断言\s*(\d+)\s*条/, s.out),
    passed: num(/smoke 断言\s*\d+\s*条，通过\s*(\d+)\s*条/, s.out),
    failed: num(/失败\s*(\d+)\s*条/, s.out),
    tail: s.out.trim().split('\n').slice(-4).join(' | '),
  };

  const b1 = runNode(['tools/bench-store.js']);
  const b2 = runNode(['tools/bench-store.js']);
  const keyLine = (b2.out.match(/关键数字：[^\n]*/) || [''])[0];
  const secondGet = num(/第二次 kv:get=(\d+)/, b2.out);
  out.bench = {
    ok: b1.ok && b2.ok, firstOk: b1.ok, secondOk: b2.ok,
    firstGet: num(/第一次 kv:get=(\d+)/, b1.out),
    secondGet: secondGet,
    secondWithin30: secondGet !== null && secondGet <= 30,
    tail: keyLine,
  };

  const c = runNode(['tools/copy-source.js', '--check', '--pages']);
  out.copySource = {
    ok: c.ok, exitCode: c.code,
    identical: num(/逐字节一致\s*(\d+)\s*个/, c.out),
    total: num(/合计\s*(\d+)\s*个文件/, c.out),
    abnormal: num(/异常\s*(\d+)\s*个/, c.out),
    tail: (c.out.match(/合计[^\n]*/) || [''])[0],
  };

  const files = walk(path.join(ROOT, 'src'), ROOT, [])
    .concat(walk(path.join(ROOT, 'tools'), ROOT, []))
    .concat(walk(path.join(ROOT, 'tests'), ROOT, []))
    .filter(function (f) { return /\.js$/.test(f); });
  const syntaxBad = [];
  files.forEach(function (f) {
    const r = runNode(['--check', f]);
    if (!r.ok) syntaxBad.push(path.relative(ROOT, f).split(path.sep).join('/'));
  });
  out.nodeCheck = { ok: syntaxBad.length === 0, files: files.length, bad: syntaxBad };
  return out;
}

/** ---------------------------------------------------------------- 改动范围核验 */
function scopeAudit() {
  const srcFiles = walk(path.join(ROOT, 'src'), ROOT, []);
  const records = srcFiles.map(function (f) {
    const st = fs.statSync(f);
    return {
      rel: path.relative(path.join(ROOT, 'src'), f).split(path.sep).join('/'),
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      mtimeMs: st.mtimeMs,
      sha256: sha256(fs.readFileSync(f)),
    };
  });
  const ref = records.filter(function (r) { return /^utils\//.test(r.rel); })
    .reduce(function (m, r) { return Math.min(m, r.mtimeMs); }, Infinity);
  const fixed = records.filter(function (r) { return r.rel === FIXED_FILE; })[0] || null;
  // 桶 1（信息项）：导入基线（utils 落盘 11:07）之后被动过的文件，含构建期生成的清单；
  // 桶 2（判定项）：D01 修复窗口（以 wxml-runtime.js 的 mtime 为锚，前推 15 分钟）内被动过的
  //               产品文件 —— 除 wxml-runtime.js 外必须为空，否则说明修复越界。
  const changedAfterImport = records.filter(function (r) {
    return r.rel !== FIXED_FILE && r.mtimeMs > ref + 5 * 60 * 1000;
  }).map(function (r) { return r.rel + '@' + r.mtime; });
  const fixAnchor = fixed ? fixed.mtimeMs - 15 * 60 * 1000 : Infinity;
  const changedInFixWindow = records.filter(function (r) {
    return r.rel !== FIXED_FILE && r.mtimeMs >= fixAnchor;
  }).map(function (r) { return r.rel + '@' + r.mtime; });

  // 用 .sha256.json 独立复核 8 个 utils 逐字节一致（不依赖 verify 脚本的自述）
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'utils', '.sha256.json'), 'utf8'));
  const utils = Object.keys(manifest).map(function (name) {
    const buf = fs.readFileSync(path.join(ROOT, 'src', 'utils', name));
    const h = sha256(buf);
    return {
      name: name, bytes: buf.length,
      ok: h === manifest[name].sha256 && buf.length === manifest[name].bytes,
      sha256: h,
    };
  });

  const fixedSrc = fs.existsSync(path.join(ROOT, 'src', FIXED_FILE))
    ? fs.readFileSync(path.join(ROOT, 'src', FIXED_FILE), 'utf8') : '';
  const markers = {
    refreshLoopItemsDef: /function refreshLoopItems\(loop\)/.test(fixedSrc),
    shortCircuitCallsIt: /signature === loop\.signature\)\s*\{[\s\S]{0,220}?refreshLoopItems\(loop\)/.test(fixedSrc),
    loopsReclaimFilter: /this\.loops = this\.loops\.filter/.test(fixedSrc),
    lines: fixedSrc.split('\n').length,
  };
  return {
    srcFiles: records.length,
    fixed: fixed,
    changedAfterImport: changedAfterImport,
    changedInFixWindow: changedInFixWindow,
    utilsAllIdentical: utils.every(function (u) { return u.ok; }),
    utils: utils,
    markers: markers,
  };
}

/** ---------------------------------------------------------------- main */
(async function main() {
  if (!fs.existsSync(EXE)) {
    console.error('[QA FATAL] 找不到 electron.exe：' + EXE);
    process.exitCode = 2;
    return;
  }
  const r = await runElectron();
  const json = (r && r.json) || { checks: [], facts: {} };
  const checks = Array.isArray(json.checks) ? json.checks : [];
  const failed = checks.filter(function (c) { return !c.ok; });

  console.log('\n================ D01 QA 独立探针（' + LABEL + '）================');
  checks.forEach(function (c) {
    console.log('[' + (c.ok ? 'PASS' : 'FAIL') + '] ' + c.id + ' ' + c.name + ' → ' + c.detail);
  });

  console.log('\n================ 回归基线（QA 独立执行）================');
  const base = baselines();
  console.log('verify      : ' + (base.verify.passed + '/' + base.verify.total) + '  ' + base.verify.tail);
  console.log('smoke       : ' + (base.smoke.passed + '/' + base.smoke.total) + '  ' + base.smoke.tail);
  console.log('bench       : 第一次 kv:get=' + base.bench.firstGet + ' / 第二次 kv:get=' + base.bench.secondGet
    + '（≤30 通过=' + base.bench.secondWithin30 + '）');
  console.log('copy-source : ' + base.copySource.identical + '/' + base.copySource.total
    + ' 逐字节一致，异常 ' + base.copySource.abnormal);
  console.log('node --check: ' + (base.nodeCheck.ok ? '全量通过' : '失败') + '（' + base.nodeCheck.files + ' 个文件）'
    + (base.nodeCheck.bad.length ? ' 失败清单=' + base.nodeCheck.bad.join(',') : ''));

  console.log('\n================ 改动范围核验 ================');
  const scope = scopeAudit();
  console.log('src 文件数 : ' + scope.srcFiles + ' / 唯一改动=' + (scope.fixed ? scope.fixed.rel : '(未找到)')
    + '（' + (scope.fixed ? scope.fixed.bytes + ' 字节，' + scope.fixed.mtime : '') + '）');
  console.log('可疑改动   : ' + (scope.changedInFixWindow.length
    ? scope.changedInFixWindow.join(',')
    : '无（D01 修复窗口内除 wxml-runtime.js 外无产品文件被动过）'));
  console.log('导入后被改 : ' + (scope.changedAfterImport.length ? scope.changedAfterImport.join(',') : '无'));
  console.log('utils 8 文件逐字节一致 : ' + scope.utilsAllIdentical
    + '（' + scope.utils.filter(function (u) { return u.ok; }).length + '/8）');
  console.log('修复标记   : refreshLoopItems=' + scope.markers.refreshLoopItemsDef
    + ' / 短路分支调用=' + scope.markers.shortCircuitCallsIt
    + ' / loops 回收=' + scope.markers.loopsReclaimFilter
    + ' / 总行数=' + scope.markers.lines);

  const summary = {
    label: LABEL,
    generatedAt: new Date().toISOString(),
    machine: machineInfo(),
    electron: { exitCode: r.exitCode, logBytes: r.logBytes },
    checksTotal: checks.length,
    checksPassed: checks.length - failed.length,
    checksFailed: failed.map(function (c) { return c.id; }),
    checks: checks,
    facts: json.facts || {},
    jsErrors: Array.isArray(json.jsErrors) ? json.jsErrors : [],
    consoleMessageCount: Array.isArray(json.consoleMessages) ? json.consoleMessages.length : 0,
    baselines: base,
    scope: scope,
  };
  const summaryFile = path.join(LOG_DIR, 'd01-qa-summary-' + LABEL + '.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n机器配置：' + summary.machine.cpu + ' / ' + summary.machine.cores + ' 核 / '
    + summary.machine.memGB + 'GB / ' + summary.machine.platform + ' / node ' + summary.machine.node);
  console.log('electron exitCode=' + r.exitCode + ' / 控制台消息 ' + summary.consoleMessageCount
    + ' 条 / JS 异常 ' + summary.jsErrors.length + ' 条');
  if (summary.jsErrors.length) console.log('JS 异常：' + JSON.stringify(summary.jsErrors.slice(0, 5)));
  console.log('QA 断言 ' + checks.length + ' 条，通过 ' + (checks.length - failed.length) + ' 条，失败 ' + failed.length + ' 条');
  console.log('汇总写入：' + summaryFile);
  console.log('IS_PASS: ' + (failed.length === 0 && base.verify.ok && base.smoke.ok && base.bench.secondWithin30
    && base.copySource.ok && base.nodeCheck.ok && scope.utilsAllIdentical && scope.changedInFixWindow.length === 0
    ? 'YES' : 'NO'));
  process.exitCode = (failed.length === 0 && base.verify.ok && base.smoke.ok && base.bench.secondWithin30
    && base.copySource.ok && base.nodeCheck.ok) ? 0 : 1;
})().catch(function (e) {
  console.error('QA_DRIVER_FATAL ' + String((e && e.stack) || e));
  process.exitCode = 2;
});
