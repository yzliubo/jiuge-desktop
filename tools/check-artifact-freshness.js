'use strict';
/*
 * 交付物新鲜度守卫（整改清单 R-02 / R-04 / R-08）
 *
 * 背景（2026-11-12 事故）：dist 于 09:16 重建，而交付 exe 的载荷 asar 是 09:03 打的，
 * 结果是交付 exe 里 300 条新增语料命中 0，而源码与 dist 都是 1。
 * 当时没有任何机制能拦住这件事——只能靠人事后 grep 才发现。
 *
 * 本脚本只做一件事：**证明交付物里装的就是当前 dist**。
 * 不用时间戳单独判断（时间戳会被 copy/touch 欺骗），而是直接做字节包含检查：
 * 把 dist 的每个 js 资产读成 Buffer，检查它是否**逐字节出现**在 asar 里。
 *
 * 用法：
 *   node tools/check-artifact-freshness.js --source-dist   # 只查「源码是否比 dist 新」
 *   node tools/check-artifact-freshness.js                 # 查交付物（dist vs asar + exe 唯一性）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'renderer-v2/dist');
const MODE_SOURCE_DIST = process.argv.includes('--source-dist');

function fail(msg, hint) {
  console.error('  [FAIL] ' + msg);
  if (hint) console.error('         → ' + hint);
  process.exitCode = 1;
  return false;
}
function ok(msg) {
  console.log('  [PASS] ' + msg);
  return true;
}

function walk(dir, exts, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'build', 'build-v2', 'build-v2b', '.git'].includes(e.name)) continue;
      if (e.name.startsWith('_backup')) continue;
      walk(p, exts, out);
    } else if (exts.some(function (x) { return e.name.endsWith(x); })) {
      out.push(p);
    }
  }
  return out;
}

function newestMtime(files) {
  let m = 0, f = null;
  for (const p of files) {
    const t = fs.statSync(p).mtimeMs;
    if (t > m) { m = t; f = p; }
  }
  return { ms: m, file: f };
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmt(ms) {
  if (!ms) return '-';
  const d = new Date(ms); // 本地时间，避免 UTC 显示让人误判 8 小时
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

console.log('========================================');
console.log('交付物新鲜度守卫');

// ---------- 模式一：源码 vs dist ----------
if (MODE_SOURCE_DIST) {
  const srcNewest = newestMtime(walk(path.join(ROOT, 'src'), ['.js']).concat(walk(path.join(ROOT, 'renderer-v2/src'), ['.js', '.ts', '.vue', '.css'])));
  const distNewest = newestMtime(walk(DIST, ['.js', '.css', '.html']));
  if (!distNewest.ms) {
    fail('dist 不存在或为空', '请先执行 npm run build:view');
  } else if (srcNewest.ms > distNewest.ms) {
    fail('源码比 dist 新，dist 已过期', '最新源码：' + path.relative(ROOT, srcNewest.file) + ' @ ' + fmt(srcNewest.ms) + '；dist @ ' + fmt(distNewest.ms) + '。请先 npm run build:view');
  } else {
    ok('dist 不早于全部源码（源码 @ ' + fmt(srcNewest.ms) + '，dist @ ' + fmt(distNewest.ms) + '）');
  }
  console.log('========================================');
  process.exit(process.exitCode || 0);
}

// ---------- 模式二：交付物 ----------
// 1) dist 存在
const distAssets = walk(DIST, ['.js', '.html']).filter(function (p) { return p.endsWith('.js'); });
const distNewest = newestMtime(walk(DIST, ['.js', '.css', '.html']));
if (!distAssets.length || !distNewest.ms) {
  fail('dist 不存在或没有 js 资产', '请先执行 npm run build:view');
}

// 2) 交付 exe 唯一（R-04）
// 输出目录可能不止一个：build-v2 是交付位，build-v2b / build-v2c 是「产物位被别的进程
// （宿主 WorkBuddy / 杀软）长期占着 app.asar 时」改出来的输出位——electron-builder 覆盖不了
// 被占用的 asar，交付位又不能空着。三处一起扫：取**最新**的 asar 做新鲜度证据，exe 仍要求全局唯一。
const buildDirs = ['build-v2', 'build-v2b', 'build-v2c', 'build-v2d'].map(function (d) { return path.join(ROOT, d); }).filter(fs.existsSync);
let exes = [];
for (const d of buildDirs) {
  for (const f of fs.readdirSync(d)) {
    if (f.toLowerCase().endsWith('.exe')) exes.push(path.join(d, f));
  }
}
if (exes.length !== 1) {
  fail('交付目录下 exe 数量为 ' + exes.length + '，应为 1', '多余产物请移入 _archive/：\n         ' + exes.map(function (p) { return path.relative(ROOT, p); }).join('\n         '));
} else {
  ok('交付 exe 唯一：' + path.relative(ROOT, exes[0]) + '（' + fs.statSync(exes[0]).size + ' B）');
}

// 3) 找 app.asar
const asars = [];
for (const d of buildDirs) {
  const a = path.join(d, 'win-unpacked/resources/app.asar');
  if (fs.existsSync(a)) asars.push(a);
}
if (!asars.length) {
  fail('未找到任何 app.asar', '请先打包：npm run dist:v2');
} else {
  const asar = asars.sort(function (a, b) { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; })[0];
  const asarMtime = fs.statSync(asar).mtimeMs;
  console.log('  当前 asar：' + path.relative(ROOT, asar) + '（' + fs.statSync(asar).size + ' B，' + fmt(asarMtime) + '）');

  // 3a) 时间上 asar 不应早于 dist
  if (asarMtime < distNewest.ms) {
    fail('asar 比 dist 旧：asar @ ' + fmt(asarMtime) + '，dist @ ' + fmt(distNewest.ms), '这是 11-12 事故的同一形态。请重打包：npm run dist:v2');
  } else {
    ok('asar 不早于 dist（asar @ ' + fmt(asarMtime) + '，dist @ ' + fmt(distNewest.ms) + '）');
  }

  // 3b) 字节包含检查：dist 每个 js 资产必须逐字节出现在 asar 里
  const asarBuf = fs.readFileSync(asar);
  let bad = [];
  for (const a of distAssets) {
    const needle = fs.readFileSync(a);
    if (!asarBuf.includes(needle)) bad.push(path.relative(DIST, a));
  }
  if (bad.length) {
    fail('asar 内不含当前 dist 的这些资产（交付物与源码不同步）：' + bad.join(', '), '请重打包：npm run dist:v2');
  } else {
    ok('asar 逐字节包含当前 dist 全部 js 资产（' + distAssets.length + ' 个）——交付物与源码同步');
  }
}

console.log('========================================');
process.exit(process.exitCode || 0);
