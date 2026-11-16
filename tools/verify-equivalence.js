'use strict';
/**
 * 等价性 / 全局一致性验证（架构 T1 验收判据 ②⑤⑥⑦ / §9.6）。
 *
 * 纯 Node、无 GUI、无 Electron 依赖，可在任何降级级别（L0/L1/L2）运行：
 *   1. 8 个 utils 的 SHA256 与源项目逐字节一致；
 *   2. 8 个模块导出名清单一致（实测 diary-store 68 个、8 模块合计 167 个；
 *      架构文档写的「60 个导出」是概数，本脚本按源码实测全量对拍）；
 *   3. 常量 CELL_MAX/BASE_MAX/SEARCH_LIMIT/WEEK_GOAL/BACKUP_VERSION/BACKUP_MIN_FULL、
 *      GRID_KEYS 九键、MODULE_DEFS、quotes.size=539 / featured=200；
 *   4. 中文文案逐字保留（源码集合 + 桌面层复用文案）+ 零网络关键字扫描；
 *   5. 四套 THEMES 色值对拍、脏值回落 standard 且不写回；
 *   6. window-state.json / .bak / 导入快照不出现在 kv:keys()；
 *   7. JIUGE_KV_QUOTA 模拟超限触发 QUOTA_EXCEEDED 且 Map 回滚；
 *   8. 运行时 CSS 零残留 rpx；IPC 通道清单、require 路径、CSS 变量、wx API 覆盖面自洽。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
let SOURCE = 'G:/workbuddy/2026-10-31-23-19-46';
process.argv.slice(2).forEach(function (a) {
  if (a.indexOf('--source=') === 0) SOURCE = a.slice('--source='.length);
});

const UTILS = [
  'diary-store.js', 'work-board.js', 'money-book.js', 'study-log.js',
  'cell-insights.js', 'greetings.js', 'quotes.js', 'theme.js',
];

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    const ok = !!(r && r.ok);
    results.push({ name: name, ok: ok, detail: (r && r.detail) || '' });
    console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (r && r.detail ? '  → ' + r.detail : ''));
  } catch (e) {
    results.push({ name: name, ok: false, detail: String(e && e.message || e) });
    console.log('[FAIL] ' + name + '  → 异常：' + String(e && e.stack || e));
  }
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readText(p) { return fs.readFileSync(p, 'utf8'); }
function section(title) { console.log('\n=== ' + title + ' ==='); }

/** 去掉注释，避免把文档示例里的示意代码误判为真实 require / 调用。 */
function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/^\s*\*.*$/gm, '');
}

/** 注入内存 wx，用于纯 Node 下 require 8 个 utils。 */
function installMemoryWx() {
  const map = new Map();
  const wx = {
    getStorageSync: function (k) { return map.has(k) ? map.get(k) : ''; },
    setStorageSync: function (k, v) { map.set(k, v); },
    removeStorageSync: function (k) { map.delete(k); },
    getStorageInfoSync: function () { return { keys: Array.from(map.keys()), currentSize: 0, limitSize: 0 }; },
  };
  global.wx = wx;
  return { wx: wx, map: map };
}
function freshRequire(base) {
  UTILS.forEach(function (n) {
    const p = path.join(base, n);
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* 未加载过 */ }
  });
  const out = {};
  UTILS.forEach(function (n) { out[n] = require(path.join(base, n)); });
  return out;
}

function walk(dir, exts, exclude) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(function (e) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (exclude.indexOf(e.name) >= 0) return;
      out.push.apply(out, walk(full, exts, exclude));
    } else if (exts.indexOf(path.extname(e.name)) >= 0) {
      out.push(full);
    }
  });
  return out;
}

// ==================================================================== 1. 哈希
section('1. 8 个 utils 逐字节 / SHA256 对拍');
check('源项目 utils 与 src/utils 逐字节一致（8 个文件）', function () {
  const rows = [];
  UTILS.forEach(function (n) {
    const a = fs.readFileSync(path.join(SOURCE, 'utils', n));
    const b = fs.readFileSync(path.join(ROOT, 'src', 'utils', n));
    rows.push({ name: n, ok: a.equals(b) && sha256(a) === sha256(b), bytes: a.length, sha: sha256(a) });
  });
  const bad = rows.filter(function (r) { return !r.ok; });
  const detail = rows.map(function (r) { return r.name + '=' + r.sha.slice(0, 12) + '…'; }).join(' ');
  return { ok: bad.length === 0, detail: (bad.length ? '不一致：' + bad.map(function (r) { return r.name; }).join(',') : '8/8 一致') + ' | ' + detail };
});

// ==================================================================== 2. 导出名
section('2. 8 个模块导出名清单对拍');
const mem = installMemoryWx();
let srcMods = null;
let dstMods = null;
check('源项目与目标目录 8 个模块导出名完全一致', function () {
  srcMods = freshRequire(path.join(SOURCE, 'utils'));
  dstMods = freshRequire(path.join(ROOT, 'src', 'utils'));
  let total = 0;
  const diffs = [];
  UTILS.forEach(function (n) {
    const a = Object.keys(srcMods[n]).sort();
    const b = Object.keys(dstMods[n]).sort();
    total += a.length;
    if (a.join(',') !== b.join(',')) diffs.push(n);
  });
  const storeKeys = Object.keys(dstMods['diary-store.js']).length;
  return {
    ok: diffs.length === 0,
    detail: '8 模块合计 ' + total + ' 个导出；diary-store 实测 ' + storeKeys
      + ' 个（架构文档概数写 60，以源码实测为准）；差异：' + (diffs.length ? diffs.join(',') : '无'),
  };
});

// ==================================================================== 3. 常量
section('3. 量化常量与九键 / MODULE_DEFS / 名言库');
const store = dstMods['diary-store.js'];
const quotes = dstMods['quotes.js'];
const theme = dstMods['theme.js'];
const storeText = readText(path.join(ROOT, 'src', 'utils', 'diary-store.js'));
function constOf(name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)').exec(storeText);
  return m ? Number(m[1]) : null;
}
check('CELL_MAX=2000 / BASE_MAX=200 / SEARCH_LIMIT=200 / WEEK_GOAL=5 / BACKUP_VERSION=7 / BACKUP_MIN_FULL=6', function () {
  const expect = { CELL_MAX: 2000, BASE_MAX: 200, SEARCH_LIMIT: 200, BACKUP_VERSION: 7, BACKUP_MIN_FULL: 6 };
  const got = {};
  Object.keys(expect).forEach(function (k) { got[k] = constOf(k); });
  got.WEEK_GOAL = store.WEEK_GOAL;
  const bad = Object.keys(expect).filter(function (k) { return got[k] !== expect[k]; });
  if (got.WEEK_GOAL !== 5) bad.push('WEEK_GOAL');
  return { ok: bad.length === 0, detail: JSON.stringify(got) + (bad.length ? ' 不符：' + bad.join(',') : '') };
});
check('GRID_KEYS 固定九键（顺序不变）', function () {
  const want = 'work,money,health,relation,future,emotion,dream,growth,free';
  const got = (store.GRID_KEYS || []).join(',');
  return { ok: got === want, detail: got };
});
check('MODULE_DEFS 三项 id=work/money/growth', function () {
  const ids = (store.MODULE_DEFS || []).map(function (m) { return m.id; }).join(',');
  return { ok: ids === 'work,money,growth', detail: ids };
});
check('quotes.size=539 / featured=200', function () {
  return { ok: quotes.size === 539 && quotes.featured === 200, detail: 'size=' + quotes.size + ' featured=' + quotes.featured };
});
check('save() 落盘裁剪：单格 2000 / 基础栏 200（行为验证）', function () {
  const r = store.save({
    date: '2026-01-01',
    base: { weather: '晴'.repeat(500), anniversary: '', body: '', mood: '' },
    cells: { work: '甲'.repeat(5000) },
  });
  const ok = !r.error && r.data.cells.work.length === 2000 && r.data.base.weather.length === 200;
  return { ok: ok, detail: 'cells.work=' + (r.data ? r.data.cells.work.length : '?') + ' base.weather=' + (r.data ? r.data.base.weather.length : '?') };
});
check('exportBackup() 写 version=7（Q1：桌面自身导出写 7）', function () {
  const r = store.exportBackup();
  let v = null;
  try { v = JSON.parse(r.data).version; } catch (e) { v = null; }
  return { ok: !r.error && v === 7, detail: 'version=' + v };
});

// ==================================================================== 4. 文案
section('4. 中文文案逐字保留 + 主题脏值回落');
const SOURCE_PAGES = ['index', 'review', 'capsule', 'habit', 'settings']
  .map(function (id) { return path.join(SOURCE, 'pages', id, id + '.js'); });
const sourceTexts = SOURCE_PAGES.map(function (p) { return readText(p); }).join('\n')
  + '\n' + UTILS.map(function (n) { return readText(path.join(SOURCE, 'utils', n)); }).join('\n');

const SOURCE_PHRASES = [
  '本机存储已满，请先导出备份再清理旧日记',
  '学习库未能保存，请检查本机存储空间',
  '换肤生效了，但这次没存上，下次打开会回到原来的主题',
  '只能补记今天或更早的日子',
  '导入只补写本机没有的日期，不会覆盖已有记录。',
  '开始导入',
  '剪贴板内容不是有效的备份 JSON',
  '未识别到备份数据',
  '导入备份',
];
check('源项目关键中文文案逐字存在（源项目只读、未被改动）', function () {
  const missing = SOURCE_PHRASES.filter(function (p) { return sourceTexts.indexOf(p) < 0; });
  return { ok: missing.length === 0, detail: SOURCE_PHRASES.length + ' 条，缺失：' + (missing.length ? missing.join(' / ') : '无') };
});

const DESKTOP_FILES = [
  'src/renderer/desktop-features.js', 'src/renderer/flush.js',
  'src/renderer/theme-css.js', 'src/renderer/ui-feedback.js',
  'src/renderer/nav.js', 'src/renderer/index.html',
].map(function (p) { return path.join(ROOT, p); });
const desktopText = DESKTOP_FILES.map(function (p) { return fs.existsSync(p) ? readText(p) : ''; }).join('\n');
const DESKTOP_REQUIRED = [
  '剪贴板内容不是有效的备份 JSON', '未识别到备份数据', '导入备份',
  '导入只补写本机没有的日期，不会覆盖已有记录。', '开始导入', '导入失败：',
  '换肤生效了，但这次没存上，下次打开会回到原来的主题',
  '还有没保存的内容，确定退出吗？', '导入小程序备份文件（v6/v7）',
];
check('桌面层复用文案逐字一致（不润色、不改口径）', function () {
  const missing = DESKTOP_REQUIRED.filter(function (p) { return desktopText.indexOf(p) < 0; });
  return { ok: missing.length === 0, detail: DESKTOP_REQUIRED.length + ' 条，缺失：' + (missing.length ? missing.join(' / ') : '无') };
});
check('未把「这台手机上」擅自改成电脑口径', function () {
  const all = walk(path.join(ROOT, 'src'), ['.js', '.html', '.css'], []).map(readText).join('\n');
  const ok = all.indexOf('这台电脑上') < 0;
  return { ok: ok, detail: ok ? '未出现改写文案' : '出现了改写文案' };
});
check('theme.getThemeId() 脏值回落 standard 且**不写回** skin_theme', function () {
  const wx = global.wx;
  const map = new Map();
  wx.getStorageSync = function (k) { return map.has(k) ? map.get(k) : ''; };
  wx.setStorageSync = function (k, v) { map.set(k, v); };
  wx.getStorageInfoSync = function () { return { keys: Array.from(map.keys()) }; };
  const themePath = path.join(ROOT, 'src', 'utils', 'theme.js');
  delete require.cache[require.resolve(themePath)];
  const t = require(themePath);
  map.set('skin_theme', 'NOT_A_THEME');
  const id = t.getThemeId();
  const wroteBack = map.get('skin_theme') !== 'NOT_A_THEME';
  return { ok: id === 'standard' && !wroteBack, detail: 'getThemeId()=' + id + ' skin_theme 仍为 ' + map.get('skin_theme') };
});
installMemoryWx();

// ==================================================================== 5. 主题色值
section('5. 四套 THEMES 色值对拍');
const THEME_EXPECT = {
  standard: ['#F6F8F3', '#F6F8F3', '#5C7265', '#2F7357', '#FFFFFF', '#2F7357'],
  tech: ['#0B1729', '#EEF3FB', '#556C86', '#1B62D6', '#F7FAFE', '#1B62D6'],
  girl: ['#FFF6F8', '#FDF6F4', '#7A5A64', '#C9416F', '#FFFFFF', '#C9416F'],
  kids: ['#FFC22E', '#FFFCF2', '#5A7180', '#1578B8', '#FFFFFF', '#1578B8'],
};
check('theme.js THEMES 四套色值逐字照搬架构 §9.4', function () {
  const bad = [];
  Object.keys(THEME_EXPECT).forEach(function (id) {
    const t = theme.THEMES[id];
    const e = THEME_EXPECT[id];
    const got = [t.nav.backgroundColor, t.window.backgroundColor, t.tab.color,
      t.tab.selectedColor, t.tab.backgroundColor, t.switchColor];
    if (got.join('|') !== e.join('|')) bad.push(id + '=' + got.join('|'));
  });
  return { ok: bad.length === 0, detail: bad.length ? bad.join(' ; ') : '4/4 套一致' };
});
check('theme-css.js 的 THEME_COLORS 与 THEMES 对拍', function () {
  const cssPath = path.join(ROOT, 'src', 'renderer', 'theme-css.js');
  delete require.cache[require.resolve(cssPath)];
  const tc = require(cssPath);
  const vars = tc.cssVars();
  const bad = [];
  Object.keys(THEME_EXPECT).forEach(function (id) {
    const v = vars[id];
    const e = THEME_EXPECT[id];
    const got = [v.navBg, v.windowBg, v.tabColor, v.selectedColor, v.tabBg, v.switchColor];
    if (got.join('|') !== e.join('|')) bad.push(id);
  });
  return { ok: bad.length === 0, detail: bad.length ? '不符：' + bad.join(',') : '4/4 套一致' };
});
check('theme.css 四套 .theme-* 同构块齐全且各自定义 --c-bg', function () {
  const css = readText(path.join(ROOT, 'src', 'renderer', 'styles', 'theme.css'));
  const bad = Object.keys(THEME_EXPECT).filter(function (id) {
    const re = new RegExp('\\.theme-' + id + '\\s*\\{[^}]*--c-bg\\s*:', 'm');
    return !re.test(css);
  });
  return { ok: bad.length === 0, detail: bad.length ? '缺：' + bad.join(',') : '4/4 块齐全' };
});

// ==================================================================== 6. KV 命名空间
section('6. KV 命名空间隔离 / QUOTA 模拟 / rpx 残留');
const { KvStore } = require('../src/main/kv-store.js');
let tmpDir = '';
check('window-state.json / .bak / 导入快照不出现在 kv:keys()', function () {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-verify-'));
  const kv = new KvStore(tmpDir);
  kv.set('morning_diary_2026-11-07', { date: '2026-11-07' });
  kv.set('skin_theme', 'tech');
  fs.writeFileSync(path.join(tmpDir, 'window-state.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'store.json.bak'), '{}', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'store.pre-import-20261107-101010.json'), '{}', 'utf8');
  kv.snapshotBeforeImport();
  kv.flush();
  const keys = kv.keys();
  const polluted = keys.filter(function (k) { return /window-state|\.bak|pre-import|\.json/.test(k); });
  return { ok: polluted.length === 0 && keys.length === 2,
    detail: 'keys=' + JSON.stringify(keys) + ' 污染=' + JSON.stringify(polluted) };
});
check('原子写留下 store.json.bak 且 store.json 可解析', function () {
  const p = path.join(tmpDir, 'store.json');
  const bak = path.join(tmpDir, 'store.json.bak');
  let parsed = null;
  try { parsed = JSON.parse(readText(p)); } catch (e) { parsed = null; }
  return { ok: fs.existsSync(bak) && !!parsed && Object.keys(parsed).length === 2,
    detail: 'bak=' + fs.existsSync(bak) + ' keys=' + (parsed ? Object.keys(parsed).length : '?') };
});
check('导入前快照保留最近 3 份', function () {
  const kv2 = new KvStore(tmpDir);
  kv2.set('a', 1);
  for (let i = 0; i < 5; i += 1) {
    const p = path.join(tmpDir, 'store.pre-import-2026110' + (1 + i) + '-10101' + i + '.json');
    fs.writeFileSync(p, '{}', 'utf8');
  }
  kv2.snapshotBeforeImport();
  const snaps = fs.readdirSync(tmpDir).filter(function (n) { return /^store\.pre-import-\d{8}-\d{6}\.json$/.test(n); });
  return { ok: snaps.length <= 3, detail: '快照数=' + snaps.length + '（上限 3）' };
});
check('JIUGE_KV_QUOTA 超限返回 QUOTA_EXCEEDED 且 Map 回滚', function () {
  const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-quota-'));
  const kv = new KvStore(qdir, { env: { JIUGE_KV_QUOTA: '160' } });
  kv.set('a', 'x');
  const r = kv.set('a', 'x'.repeat(500));
  const rolledBack = kv.get('a') === 'x';
  return { ok: !r.ok && r.error === 'QUOTA_EXCEEDED' && rolledBack,
    detail: 'error=' + r.error + ' limitBytes=' + r.limitBytes + ' 回滚=' + rolledBack };
});
check('preload 的 kv:set 失败 throw 含 exceed/quota/size/limit 字样', function () {
  const p = readText(path.join(ROOT, 'src', 'preload', 'preload.js'));
  const has = /exceed quota size limit/.test(p) && /QUOTA_EXCEEDED/.test(p);
  return { ok: has, detail: has ? '已实现（diary-store.write() 可判定 QUOTA_EXCEEDED）' : '缺失' };
});
check('运行时 CSS 零残留 rpx', function () {
  const files = walk(path.join(ROOT, 'src', 'renderer', 'styles'), ['.css'], []);
  const bad = files.filter(function (f) { return /\d+rpx/.test(readText(f)); });
  return { ok: bad.length === 0, detail: files.length + ' 个 CSS，残留 ' + bad.length + ' 个' };
});

// ==================================================================== 7. 全局一致性
section('7. 全局一致性：IPC 通道 / require 路径 / CSS 变量 / wx API 覆盖面');
check('全部交付 JS 通过 node --check 语法校验（含浏览器脚本）', function () {
  const { spawnSync } = require('child_process');
  const files = walk(path.join(ROOT, 'src'), ['.js'], [])
    .concat(walk(path.join(ROOT, 'tools'), ['.js'], []));
  const bad = [];
  files.forEach(function (f) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(path.relative(ROOT, f));
  });
  return { ok: bad.length === 0,
    detail: files.length + ' 个 JS，语法错误 ' + bad.length + (bad.length ? '：' + bad.join(',') : '') };
});
const SYNC_CHANNELS = ['kv:get', 'kv:set', 'kv:remove', 'kv:keys', 'kv:flush',
  'clipboard:write', 'clipboard:read', 'sys:windowBounds', 'sys:userDataPath'];
const ASYNC_CHANNELS = ['file:openBackup', 'file:saveExport', 'file:openDataDir',
  'app:flush-done', 'app:confirm-exit', 'theme:changed'];
const PUSH_CHANNELS = ['menu:action', 'app:before-flush', 'app:confirm-exit-request', 'kv:quota-simulated'];
const ipcText = readText(path.join(ROOT, 'src', 'main', 'ipc-handlers.js'));
const preloadText = readText(path.join(ROOT, 'src', 'preload', 'preload.js'));
const mainText = readText(path.join(ROOT, 'src', 'main', 'main.js'));
check('§2.3 全部 9 同步 + 6 异步 + 4 推送通道登记齐全', function () {
  const missing = SYNC_CHANNELS.concat(ASYNC_CHANNELS).filter(function (c) { return ipcText.indexOf("'" + c + "'") < 0; });
  const pushMissing = PUSH_CHANNELS.filter(function (c) { return ipcText.indexOf("'" + c + "'") < 0 && mainText.indexOf("'" + c + "'") < 0; });
  const all = missing.concat(pushMissing);
  return { ok: all.length === 0, detail: '同步 ' + SYNC_CHANNELS.length + ' / 异步 ' + ASYNC_CHANNELS.length
    + ' / 推送 ' + PUSH_CHANNELS.length + '，缺失：' + (all.length ? all.join(',') : '无') };
});
check('preload 订阅 / 转发通道名与 ipc-handlers 一致', function () {
  const needed = ['kv:get', 'kv:set', 'kv:remove', 'kv:keys', 'kv:flush',
    'clipboard:write', 'clipboard:read', 'sys:windowBounds', 'sys:userDataPath',
    'file:openBackup', 'file:saveExport', 'file:openDataDir',
    'app:flush-done', 'app:confirm-exit',
    'menu:action', 'app:before-flush', 'app:confirm-exit-request', 'kv:quota-simulated'];
  const missing = needed.filter(function (c) { return preloadText.indexOf("'" + c + "'") < 0; });
  return { ok: missing.length === 0, detail: needed.length + ' 条，缺失：' + (missing.length ? missing.join(',') : '无') };
});
check('所有相对 require() 路径可解析（排除注释中的示意代码）', function () {
  const files = walk(path.join(ROOT, 'src'), ['.js'], []);
  const bad = [];
  let total = 0;
  files.forEach(function (f) {
    const text = stripComments(readText(f));
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      total += 1;
      const target = path.resolve(path.dirname(f), m[1]);
      if (!fs.existsSync(target) && !fs.existsSync(target + '.js')) bad.push(path.relative(ROOT, f) + ' → ' + m[1]);
    }
  });
  return { ok: bad.length === 0, detail: total + ' 条真实相对 require，缺失 ' + bad.length + (bad.length ? '：' + bad.join(' ; ') : '') };
});
check('shell.css 引用的 --c-* / --sp-* / --fs-* 等令牌均在 theme.css / app.css 有定义', function () {
  const defined = new Set();
  ['theme.css', 'app.css', 'shell.css'].forEach(function (n) {
    const t = readText(path.join(ROOT, 'src', 'renderer', 'styles', n));
    const re = /(--[a-zA-Z0-9-]+)\s*:/g;
    let m;
    while ((m = re.exec(t)) !== null) defined.add(m[1]);
  });
  const shell = readText(path.join(ROOT, 'src', 'renderer', 'styles', 'shell.css'));
  const used = new Set();
  const re2 = /var\(\s*(--[a-zA-Z0-9-]+)/g;
  let m2;
  while ((m2 = re2.exec(shell)) !== null) used.add(m2[1]);
  const missing = Array.from(used).filter(function (v) { return !defined.has(v); });
  return { ok: missing.length === 0, detail: '引用 ' + used.size + ' 个令牌，未定义 ' + missing.length + (missing.length ? '：' + missing.join(',') : '') };
});
check('页面 JS 用到的 wx.* API 全部由 wx-shim.js / preload polyfill 覆盖', function () {
  const pageText = SOURCE_PAGES.map(function (p) { return readText(p); }).join('\n');
  const used = new Set();
  const re = /\bwx\.([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(pageText)) !== null) used.add(m[1]);
  const shim = readText(path.join(ROOT, 'src', 'renderer', 'wx-shim.js'));
  const CHROME = { setNavigationBarColor: 1, setBackgroundColor: 1, setTabBarStyle: 1, setTabBarItem: 1 };
  const missing = Array.from(used).filter(function (name) {
    if (CHROME[name]) return false; // 原生 chrome API 故意不提供，让 theme.js callApi() 静默跳过
    const decl = new RegExp('\\b' + name + '\\s*:');
    return !decl.test(shim) && !decl.test(preloadText);
  });
  return { ok: missing.length === 0, detail: '页面用到 ' + used.size + ' 个 API：' + Array.from(used).sort().join(',')
    + '；未覆盖 ' + missing.length + (missing.length ? '：' + missing.join(',') : '') };
});
check('getSystemInfoSync().windowWidth 固定 375（不返回真实窗口宽）', function () {
  const shim = readText(path.join(ROOT, 'src', 'renderer', 'wx-shim.js'));
  const ok = /windowWidth:\s*375/.test(shim) && !/windowWidth:\s*window\./.test(shim);
  return { ok: ok, detail: ok ? '固定 375，与 1rpx=0.5px 一致' : '未固定' };
});
check('setData 走节点级 diff，运行时不含整页 innerHTML 重建', function () {
  const wxml = readText(path.join(ROOT, 'src', 'renderer', 'wxml-runtime.js'));
  const page = readText(path.join(ROOT, 'src', 'renderer', 'page-runtime.js'));
  const ok = /节点级 diff/.test(wxml) && /update\s*\(\s*\)/.test(page + wxml) && !/innerHTML\s*=\s*[^;]*page/i.test(page);
  const focus = /saveFocus/.test(wxml) && /restoreFocus/.test(wxml) && /selectionStart/.test(wxml);
  return { ok: ok && focus, detail: '节点级 diff=' + ok + ' 焦点/选区双保险=' + focus };
});
check('文件导入与剪贴板导入共用唯一 store.importBackup(text)，桌面层无第二份合并逻辑', function () {
  const df = stripComments(readText(path.join(ROOT, 'src', 'renderer', 'desktop-features.js')));
  const calls = (df.match(/store\.importBackup\s*\(/g) || []).length;
  const merged = /imported\s*\+=\s*1|skipped\s*\+=\s*1|hasContent\(local\)/.test(df);
  const srcSettings = readText(path.join(SOURCE, 'pages', 'settings', 'settings.js'));
  const srcUses = /store\.importBackup\(text\)/.test(srcSettings);
  return { ok: calls === 1 && !merged && srcUses,
    detail: 'desktop-features 代码调用 ' + calls + ' 次；无合并逻辑=' + !merged + '；源码剪贴板导入用同函数=' + srcUses };
});
check('关窗链路节点齐全：before-flush → flush-done → kv:flush → quit', function () {
  const flush = readText(path.join(ROOT, 'src', 'renderer', 'flush.js'));
  const order = ['syncWorkReflection', 'syncStudyNote', 'persist'];
  const idx = order.map(function (n) { return flush.indexOf("'" + n + "'"); });
  const ordered = idx[0] >= 0 && idx[0] < idx[1] && idx[1] < idx[2];
  const chain = /app:before-flush/.test(mainText) && /app:flush-done/.test(mainText)
    && /kv:flush/.test(mainText) && /app\.quit\(\)/.test(mainText)
    && /flush\.done/.test(flush);
  return { ok: ordered && chain, detail: '渲染侧顺序=' + ordered + ' 主进程链路=' + chain };
});

// ==================================================================== 8. 零网络
section('8. 纯本地零网络关键字扫描');
check('src/** 与根配置中无网络请求 / 远程 URL / 遥测 / appid 残留', function () {
  const files = walk(path.join(ROOT, 'src'), ['.js', '.html', '.css', '.json'], []);
  ['package.json', 'electron-builder.yml'].forEach(function (n) { files.push(path.join(ROOT, n)); });
  const BATTERY = [
    /\bwx\.request\s*\(/, /\bwx\.uploadFile\s*\(/, /\bwx\.downloadFile\s*\(/,
    /connectSocket\s*\(/, /\bfetch\s*\(/, /new\s+XMLHttpRequest/, /new\s+WebSocket\s*\(/,
    /<webview\b/, /dangerouslySetInnerHTML/, /\bappid\b/, /sitemap\.json/,
  ];
  const URL_RE = /['"`]https?:\/\/[^'"`\s]+['"`]/;
  // OPDS 导出（P2-2）必须写 XML 命名空间，而命名空间是**标识符**不是**地址**：
  // 它随文件落盘、由阅读器解释，本程序从不请求它。
  // 这里用**逐字白名单**放行四个命名空间（不是把正则放宽），并且限制只能出现在
  // src/reading/board.js——换任何别的 URL、或把它挪到别的文件，仍然会被拦下。
  const NS_OK = [
    'http://www.w3.org/2005/Atom',
    'http://purl.org/dc/terms/',
    'http://opds-spec.org/2010/catalog',
    'http://opds-spec.org/acquisition'
  ];
  const NS_HOME = 'src\\reading\\board.js';
  const stripNs = function (t) {
    return NS_OK.reduce(function (acc, ns) { return acc.split(ns).join(''); }, t);
  };
  const bad = [];
  files.forEach(function (f) {
    const t = readText(f);
    BATTERY.forEach(function (re) { if (re.test(t)) bad.push(path.relative(ROOT, f) + ' → ' + re.source); });
    if (URL_RE.test(stripNs(t))) bad.push(path.relative(ROOT, f) + ' → 远程 URL');
    if (path.relative(ROOT, f) !== NS_HOME) {
      NS_OK.forEach(function (ns) {
        if (t.indexOf(ns) >= 0) bad.push(path.relative(ROOT, f) + ' → XML 命名空间越界：' + ns);
      });
    }
  });
  return { ok: bad.length === 0, detail: files.length + ' 个文件，命中 ' + bad.length + (bad.length ? '：' + bad.join(' ; ') : '') };
});
check('tools/ 离线脚本未引入 http/https/net 模块或实际网络调用', function () {
  const files = walk(path.join(ROOT, 'tools'), ['.js'], []);
  const bad = files.filter(function (f) {
    const t = readText(f);
    return /require\(['"](?:http|https|net|dgram|tls)['"]\)/.test(t) || /\bfetch\s*\(/.test(t);
  });
  return { ok: bad.length === 0, detail: files.length + ' 个脚本，异常 ' + bad.length };
});
check('安全配置：contextIsolation:true / nodeIntegration:false / sandbox:false / webSecurity:true', function () {
  const ok = /contextIsolation:\s*true/.test(mainText) && /nodeIntegration:\s*false/.test(mainText)
    && /sandbox:\s*false/.test(mainText) && /webSecurity:\s*true/.test(mainText)
    && /will-navigate/.test(mainText) && /setWindowOpenHandler/.test(mainText);
  return { ok: ok, detail: ok ? '未降级（R3 未触发）' : '配置不符' };
});

// ==================================================================== 9. T2 今日页
section('9. T2 今日页：零复制对拍 / 数据层等价 / 运行时覆盖');
const IDX_JS_SRC = path.join(SOURCE, 'pages', 'index', 'index.js');
const IDX_JS_DST = path.join(ROOT, 'src', 'pages', 'index', 'index.js');
const IDX_WXML_SRC = path.join(SOURCE, 'pages', 'index', 'index.wxml');
const IDX_WXML_DST = path.join(ROOT, 'src', 'views', 'index.wxml');
const IDX_CSS_SRC = path.join(SOURCE, 'pages', 'index', 'index.wxss');
const IDX_CSS_DST = path.join(ROOT, 'src', 'renderer', 'styles', 'index.css');

check('index.js / index.wxml 与源项目逐字节一致（零改动 SHA256 对拍）', function () {
  const pairs = [[IDX_JS_SRC, IDX_JS_DST, 'index.js'], [IDX_WXML_SRC, IDX_WXML_DST, 'index.wxml']];
  const bad = [];
  const detail = [];
  pairs.forEach(function (p) {
    const a = fs.readFileSync(p[0]);
    const b = fs.readFileSync(p[1]);
    const ha = sha256(a);
    const hb = sha256(b);
    detail.push(p[2] + '=' + a.length + 'B/' + ha.slice(0, 12) + '…');
    if (!a.equals(b) || ha !== hb) bad.push(p[2]);
  });
  return { ok: bad.length === 0,
    detail: detail.join(' | ') + '；差异=' + (bad.length ? bad.join(',') : '无') };
});

check('今日页中文文案集合逐字一致（源 vs 目标）', function () {
  const re = /'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'|"([^"\n]*[\u4e00-\u9fa5][^"\n]*)"/g;
  const pairs = [[IDX_JS_SRC, IDX_JS_DST], [IDX_WXML_SRC, IDX_WXML_DST]];
  let total = 0;
  const missing = [];
  pairs.forEach(function (p) {
    const a = readText(p[0]);
    const b = readText(p[1]);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(a)) !== null) {
      const s = m[1] !== undefined ? m[1] : m[2];
      total += 1;
      if (b.indexOf(s) < 0) missing.push(s.slice(0, 16));
    }
  });
  return { ok: missing.length === 0 && total > 100,
    detail: total + ' 条中文字符串，缺失 ' + missing.length + (missing.length ? '：' + missing.join(' / ') : '') };
});

check('index.css 机械转换：源 rpx 全部转 px，产物零残留 rpx', function () {
  const src = readText(IDX_CSS_SRC);
  const css = readText(IDX_CSS_DST);
  const n = (src.match(/(-?\d+(?:\.\d+)?)rpx/g) || []).length;
  const residual = (css.match(/\d+rpx/g) || []).length;
  const pxCount = (css.match(/\d+px/g) || []).length;
  return { ok: n > 0 && residual === 0 && pxCount > 0,
    detail: '源 rpx=' + n + ' 处 → 产物 px=' + pxCount + ' 处，残留 rpx=' + residual };
});

check('index.css 引用的 CSS 变量全部在 theme.css / app.css / shell.css 有定义', function () {
  const defined = new Set();
  ['theme.css', 'app.css', 'shell.css'].forEach(function (n) {
    const t = readText(path.join(ROOT, 'src', 'renderer', 'styles', n));
    let m;
    const re = /(--[a-zA-Z0-9-]+)\s*:/g;
    while ((m = re.exec(t)) !== null) defined.add(m[1]);
  });
  const css = readText(IDX_CSS_DST);
  const used = new Set();
  let m2;
  const re2 = /var\(\s*(--[a-zA-Z0-9-]+)/g;
  while ((m2 = re2.exec(css)) !== null) used.add(m2[1]);
  const missing = Array.from(used).filter(function (v) { return !defined.has(v); });
  return { ok: missing.length === 0,
    detail: '引用 ' + used.size + ' 个 / 已定义 ' + defined.size + ' 个 / 未定义 '
      + missing.length + (missing.length ? '：' + missing.join(',') : '') };
});

check('index.html 按序引入 theme → app → index → shell 四份 CSS', function () {
  const html = readText(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const names = ['styles/theme.css', 'styles/app.css', 'styles/index.css', 'styles/shell.css'];
  const pos = names.map(function (n) { return html.indexOf(n); });
  const ok = pos.every(function (v, i) { return v >= 0 && (i === 0 || v > pos[i - 1]); });
  return { ok: ok, detail: names.map(function (n, i) { return n + '@' + pos[i]; }).join(' → ') };
});

check('切 4 套模板来回后历史 cells 的九固定键值不变（NFR-1 / B2）', function () {
  installMemoryWx();
  const s = freshRequire(path.join(ROOT, 'src', 'utils'))['diary-store.js'];
  const cells = {};
  s.GRID_KEYS.forEach(function (k, i) { cells[k] = '历史正文' + i; });
  s.save({ date: '2026-06-01', cells: cells, base: {}, workBoard: {}, moneyBook: {}, studyLog: {} });
  const before = JSON.stringify(s.load('2026-06-01').data.cells);
  const ids = s.TEMPLATES.map(function (t) { return t.id; });
  ids.forEach(function (id) { s.setTemplate(id); });
  ids.slice().reverse().forEach(function (id) { s.setTemplate(id); });
  const rec = s.load('2026-06-01').data;
  const after = JSON.stringify(rec.cells);
  const keys = Object.keys(rec.cells).sort().join(',');
  const want = s.GRID_KEYS.slice().sort().join(',');
  return { ok: before === after && keys === want,
    detail: '模板 ' + ids.length + ' 套 / 九键=' + keys + ' / 前后一致=' + (before === after) };
});

check('md_modules 脏数据按开启 / 关模块不删数据 / 重开回显（NFR-3 / B2）', function () {
  const m = installMemoryWx();
  const s = freshRequire(path.join(ROOT, 'src', 'utils'))['diary-store.js'];
  m.map.set('md_modules', { work: 'DIRTY', money: null, growth: 0 });
  const dirty = s.modules().data;
  const dirtyOk = dirty.work !== false && dirty.money !== false && dirty.growth !== false;
  s.setModule('work', false);
  s.save({
    date: '2026-06-02', cells: { work: '格子正文' }, base: {},
    workBoard: { tasks: [{ id: 't1', text: '任务', done: false }], reflection: '感想' },
    moneyBook: {}, studyLog: {},
  });
  const before = JSON.stringify(s.load('2026-06-02').data.workBoard);
  const during = JSON.stringify(s.load('2026-06-02').data.workBoard);
  s.setModule('work', true);
  const after = JSON.stringify(s.load('2026-06-02').data.workBoard);
  return { ok: dirtyOk && before === during && before === after,
    detail: '脏数据按开启=' + dirtyOk + ' / 关闭后数据完整=' + (before === during)
      + ' / 重开回显=' + (before === after) };
});

check('四套皮肤 setThemeId 落盘且 getThemeId 回读一致（P0-06 / B2）', function () {
  installMemoryWx();
  const t = freshRequire(path.join(ROOT, 'src', 'utils'))['theme.js'];
  const ids = ['standard', 'tech', 'girl', 'kids'];
  const bad = [];
  ids.forEach(function (id) {
    const r = t.setThemeId(id);
    if (r.error || t.getThemeId() !== id) bad.push(id);
  });
  return { ok: bad.length === 0, detail: ids.length + ' 套，异常 ' + bad.length + (bad.length ? '：' + bad.join(',') : '') };
});

check('运行时覆盖今日页全部 WXML 语法与组件', function () {
  const wxml = readText(IDX_WXML_DST);
  const cm = readText(path.join(ROOT, 'src', 'renderer', 'component-map.js'));
  const rt = readText(path.join(ROOT, 'src', 'renderer', 'wxml-runtime.js'));
  const pairs = [
    ['wx:if', /wx:if=/, rt, /wx:if/],
    ['wx:elif', /wx:elif=/, rt, /wx:elif/],
    ['wx:else', /wx:else/, rt, /wx:else/],
    ['wx:for', /wx:for=/, rt, /wx:for/],
    ['wx:for-item', /wx:for-item=/, rt, /wx:for-item/],
    ['wx:for-index', /wx:for-index=/, rt, /wx:for-index/],
    ['wx:key=*this', /wx:key="\*this"/, rt, /\*this/],
    ['block', /<block[\s>]/, cm, /'block'\s*:/],
    ['scroll-view', /<scroll-view/, cm, /'scroll-view'\s*:/],
    ['picker mode=selector', /mode="selector"/, cm, /selector/],
    ['range-key', /range-key=/, cm, /rangeKey/],
    ['catch*', /catch(?:tap|touchmove)=/, cm, /isCatch/],
    ['bindtouch*', /bindtouch(?:start|end)=/, cm, /touchstart/],
    ['catchtouchmove', /catchtouchmove=/, cm, /touchmove/],
    ['bindconfirm', /bindconfirm=/, cm, /confirm/],
    ['input/textarea', /<(?:input|textarea)/, cm, /'textarea'\s*:/],
    ['button', /<button/, cm, /'button'\s*:/],
  ];
  const missing = [];
  pairs.forEach(function (p) {
    if (p[1].test(wxml) && !p[3].test(p[2])) missing.push(p[0]);
  });
  return { ok: missing.length === 0,
    detail: pairs.length + ' 类语法/组件，未覆盖 ' + missing.length + (missing.length ? '：' + missing.join(',') : '') };
});

check('运行时本批扩展：首帧条件显隐 / 循环 scope 就地更新 / select 子节点跳过', function () {
  const rt = readText(path.join(ROOT, 'src', 'renderer', 'wxml-runtime.js'));
  const a = /首帧也必须应用/.test(rt) && /this\.condGroups\.forEach\(syncCondGroup\)/.test(rt);
  const b = /就地更新循环变量/.test(rt) && /inst\.scope\[loop\.itemName\]/.test(rt);
  const c = /node\.info\.control === 'selector'/.test(rt) && /inst\.children = \[\]/.test(rt);
  const d = /isConnected/.test(rt);
  return { ok: a && b && c && d,
    detail: '首帧条件=' + a + ' / scope 就地=' + b + ' / select 子节点=' + c + ' / detached 清理=' + d };
});

check('picker mode=date 映射为 input[type=date] 且 e.detail.value 仍为 YYYY-MM-DD', function () {
  const cmPath = path.join(ROOT, 'src', 'renderer', 'component-map.js');
  delete require.cache[require.resolve(cmPath)];
  const CM = require(cmPath);
  const info = CM.resolve('picker', { mode: 'date' });
  const detail = CM.detailFor('date', { value: '2027-01-01' }, { type: 'change' }, 0);
  const ok = info.htmlTag === 'input' && info.inputType === 'date' && info.control === 'date'
    && detail.value === '2027-01-01';
  return { ok: ok,
    detail: 'htmlTag=' + info.htmlTag + ' / type=' + info.inputType + ' / detail.value=' + detail.value };
});

check('渲染探针脚本存在、语法正确且覆盖失焦 / 滑杆 / 回启断言', function () {
  const p = path.join(ROOT, 'tools', 'renderer-probe.js');
  const t = fs.existsSync(p) ? readText(p) : '';
  const r = require('child_process').spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  const ok = !!t && r.status === 0
    && /时钟刷新 6 次 · 输入框保持焦点/.test(t)
    && /鼠标事件包装 e\.touches\[0\]\.clientX 生效/.test(t)
    && /回启后工作感想仍在/.test(t);
  return { ok: ok, detail: '语法=' + (r.status === 0 ? 'OK' : 'FAIL') + ' / 三类断言齐备=' + ok };
});

check('今日页 23 项由零复制 JS + WXML + 机械转换 CSS 三文件承担', function () {
  const files = [IDX_JS_DST, IDX_WXML_DST, IDX_CSS_DST];
  const ok = files.every(function (f) { return fs.existsSync(f) && fs.statSync(f).size > 1000; });
  const js = readText(IDX_JS_DST);
  const methodCount = (js.match(/^    [a-zA-Z_][a-zA-Z0-9_]*\(/gm) || []).length;
  return { ok: ok && methodCount > 50,
    detail: 'JS 方法 ' + methodCount + ' 个 / 三文件字节 '
      + files.map(function (f) { return fs.statSync(f).size; }).join('+') };
});

// ==================================================================== 10. T3 + T4
section('10. T3 回看页 / T4 胶囊·坚持·设置页：零复制对拍 / 白名单改写 / 全页覆盖');
const ALL_PAGES = ['index', 'review', 'capsule', 'habit', 'settings'];
const ZERO_COPY_PAGES = ['review', 'capsule', 'habit'];
function srcPage(id, ext) { return path.join(SOURCE, 'pages', id, id + '.' + ext); }
function dstPageJs(id) { return path.join(ROOT, 'src', 'pages', id, id + '.js'); }
function dstView(id) { return path.join(ROOT, 'src', 'views', id + '.wxml'); }
function srcDateKey(d) {
  function p(n) { return n < 10 ? '0' + n : '' + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 比对「目标 = 源 + 若干新增行」：返回新增行与源行缺失数（用于白名单改写审查）。 */
function extraLines(srcText, dstText) {
  const s = String(srcText).split('\n');
  const d = String(dstText).split('\n');
  let i = 0;
  let j = 0;
  const added = [];
  while (i < s.length && j < d.length) {
    if (s[i] === d[j]) { i += 1; j += 1; }
    else { added.push(d[j]); j += 1; }
  }
  while (j < d.length) { added.push(d[j]); j += 1; }
  return { added: added, missing: s.length - i };
}

check('T3/T4 六份页面文件（review/capsule/habit 的 JS+WXML）与源逐字节一致', function () {
  const bad = [];
  const detail = [];
  ZERO_COPY_PAGES.forEach(function (id) {
    [['js', srcPage(id, 'js'), dstPageJs(id)], ['wxml', srcPage(id, 'wxml'), dstView(id)]].forEach(function (t) {
      const a = fs.readFileSync(t[1]);
      const b = fs.readFileSync(t[2]);
      detail.push(id + '.' + t[0] + '=' + a.length + 'B');
      if (!a.equals(b)) bad.push(id + '.' + t[0]);
    });
  });
  return { ok: bad.length === 0, detail: detail.join(' ') + ' / 差异=' + (bad.length ? bad.join(',') : '无') };
});

check('settings.js / settings.wxml 为白名单适配改写（源行零删零改）', function () {
  const pairs = [
    ['settings.js', srcPage('settings', 'js'), dstPageJs('settings')],
    ['settings.wxml', srcPage('settings', 'wxml'), dstView('settings')],
  ];
  const bad = [];
  const detail = [];
  pairs.forEach(function (p) {
    const e = extraLines(readText(p[1]), readText(p[2]));
    detail.push(p[0] + ': 新增 ' + e.added.length + ' 行 / 源缺失 ' + e.missing + ' 行');
    if (e.missing !== 0) bad.push(p[0] + '(源行被删改)');
  });
  return { ok: bad.length === 0, detail: detail.join(' | ') + (bad.length ? ' 异常:' + bad.join(',') : '') };
});

check('settings.js 新增代码仅 4 个转调方法，无合并/去重/版本分支与中文 UI 字面量', function () {
  const e = extraLines(readText(srcPage('settings', 'js')), readText(dstPageJs('settings')));
  const added = e.added.join('\n');
  const methods = ['onImportBackupFile', 'onExportTextFile', 'onExportMarkdownFile', 'onExportBackupFile'];
  const hasAll = methods.every(function (n) { return added.indexOf(n) >= 0; });
  const codeOnly = e.added.filter(function (l) {
    return l.trim().indexOf('//') !== 0 && l.trim() !== '';
  }).join('\n');
  const noMerge = !/imported\s*\+=|skipped\s*\+=|hasContent\(local\)|sourceVersion\s*=/.test(codeOnly)
    && !/importBackup\s*\(/.test(codeOnly);
  const noChineseLiteral = !/'[^'\n]*[\u4e00-\u9fa5][^'\n]*'|"[^"\n]*[\u4e00-\u9fa5][^"\n]*"/.test(codeOnly);
  return { ok: hasAll && noMerge && noChineseLiteral,
    detail: '4 方法=' + hasAll + ' / 无合并逻辑=' + noMerge + ' / 无中文 UI 字面量=' + noChineseLiteral };
});

check('settings.wxml 只 +1 行导入入口，新增中文文案仅白名单 1 条', function () {
  const e = extraLines(readText(srcPage('settings', 'wxml')), readText(dstView('settings')));
  const added = e.added.join('\n');
  const zh = added.match(/[\u4e00-\u9fa5][^<>\n]*/g) || [];
  const allowed = ['导入小程序备份文件（v6/v7）'];
  const unexpected = zh.filter(function (s) { return allowed.indexOf(s.trim()) < 0 && s.trim().length > 0; });
  return { ok: e.missing === 0 && zh.length > 0 && unexpected.length === 0,
    detail: '新增 ' + e.added.length + ' 行 / 中文片段 ' + zh.length + ' 条 / 非白名单 ' + unexpected.length
      + (unexpected.length ? '：' + unexpected.join(' / ') : '') };
});

check('5 页 CSS 全部机械转换：源 rpx 计数对齐、产物零残留', function () {
  const rows = [];
  const bad = [];
  ALL_PAGES.forEach(function (id) {
    const src = readText(srcPage(id, 'wxss'));
    const css = readText(path.join(ROOT, 'src', 'renderer', 'styles', id + '.css'));
    const n = (src.match(/(-?\d+(?:\.\d+)?)rpx/g) || []).length;
    const residual = (css.match(/\d+rpx/g) || []).length;
    rows.push(id + ':' + n + '→' + residual);
    if (n <= 0 || residual !== 0) bad.push(id);
  });
  return { ok: bad.length === 0, detail: rows.join(' ') + '（源 rpx 处数 → 产物残留）' };
});

check('5 页 CSS 引用的 CSS 变量全部在 theme/app/shell.css 有定义', function () {
  const defined = new Set();
  ['theme.css', 'app.css', 'shell.css'].forEach(function (n) {
    const t = readText(path.join(ROOT, 'src', 'renderer', 'styles', n));
    let m;
    const re = /(--[a-zA-Z0-9-]+)\s*:/g;
    while ((m = re.exec(t)) !== null) defined.add(m[1]);
  });
  const used = new Set();
  ALL_PAGES.forEach(function (id) {
    const t = readText(path.join(ROOT, 'src', 'renderer', 'styles', id + '.css'));
    let m;
    const re = /var\(\s*(--[a-zA-Z0-9-]+)/g;
    while ((m = re.exec(t)) !== null) used.add(m[1]);
  });
  const missing = Array.from(used).filter(function (v) { return !defined.has(v); });
  return { ok: missing.length === 0,
    detail: '5 页引用 ' + used.size + ' 个变量 / 已定义 ' + defined.size + ' 个 / 未定义 ' + missing.length
      + (missing.length ? '：' + missing.join(',') : '') };
});

check('index.html 按 theme→app→index→review→capsule→habit→settings→shell 顺序引入 8 份 CSS', function () {
  const html = readText(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const names = ['theme.css', 'app.css', 'index.css', 'review.css', 'capsule.css', 'habit.css', 'settings.css', 'shell.css'];
  const pos = names.map(function (n) { return html.indexOf('styles/' + n); });
  const ok = pos.every(function (v, i) { return v >= 0 && (i === 0 || v > pos[i - 1]); });
  return { ok: ok, detail: names.map(function (n, i) { return n + '@' + pos[i]; }).join(' → ') };
});

check('5 页 JS/WXML 中文文案逐字保留（settings 改写仅新增白名单 1 条）', function () {
  const re = /'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'|"([^"\n]*[\u4e00-\u9fa5][^"\n]*)"/g;
  let total = 0;
  const missing = [];
  ALL_PAGES.forEach(function (id) {
    [[srcPage(id, 'js'), dstPageJs(id)], [srcPage(id, 'wxml'), dstView(id)]].forEach(function (p) {
      const a = readText(p[0]);
      const b = readText(p[1]);
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(a)) !== null) {
        const s = m[1] !== undefined ? m[1] : m[2];
        total += 1;
        if (b.indexOf(s) < 0) missing.push(s.slice(0, 16));
      }
    });
  });
  return { ok: missing.length === 0 && total > 200,
    detail: total + ' 条中文字符串，缺失 ' + missing.length + (missing.length ? '：' + missing.join(' / ') : '') };
});

check('运行时覆盖 5 页全部 WXML 语法与组件（含 swiper / switch / date picker）', function () {
  const wxml = ALL_PAGES.map(function (id) { return readText(dstView(id)); }).join('\n');
  const cm = readText(path.join(ROOT, 'src', 'renderer', 'component-map.js'));
  const rt = readText(path.join(ROOT, 'src', 'renderer', 'wxml-runtime.js'));
  const pairs = [
    ['wx:if', /wx:if=/, rt, /wx:if/],
    ['wx:elif', /wx:elif=/, rt, /wx:elif/],
    ['wx:else', /wx:else/, rt, /wx:else/],
    ['wx:for', /wx:for=/, rt, /wx:for/],
    ['wx:for-item', /wx:for-item=/, rt, /wx:for-item/],
    ['wx:key=*this', /wx:key="\*this"/, rt, /\*this/],
    ['block', /<block[\s>]/, cm, /'block'\s*:/],
    ['scroll-view', /<scroll-view/, cm, /'scroll-view'\s*:/],
    ['swiper', /<swiper[\s>]/, cm, /'swiper'\s*:/],
    ['swiper-item 显隐', /<swiper[\s>]/, rt, /applySwiperVisibility/],
    ['switch', /<switch/, cm, /'switch'\s*:/],
    ['picker mode=date', /mode="date"/, cm, /'date'/],
    ['picker start→min', /start="\{\{/, cm, /setAttribute\('min'/],
    ['picker mode=selector', /mode="selector"/, cm, /selector/],
    ['catch*', /catch(?:tap|touchmove)=/, cm, /isCatch/],
    ['内联 style rpx→px', /rpx/g, rt, /convertInlineRpx/],
    ['button', /<button/, cm, /'button'\s*:/],
  ];
  const missing = [];
  pairs.forEach(function (p) {
    if (p[1].test(wxml) && !p[3].test(p[2])) missing.push(p[0]);
  });
  return { ok: missing.length === 0,
    detail: pairs.length + ' 类语法/组件，未覆盖 ' + missing.length + (missing.length ? '：' + missing.join(',') : '') };
});

check('5 页 JS 在独立函数作用域执行（避免顶层 const 重复声明）', function () {
  const pre = readText(path.join(ROOT, 'src', 'preload', 'preload.js'));
  const pr = readText(path.join(ROOT, 'src', 'renderer', 'page-runtime.js'));
  const ok = /readPageScript/.test(pre) && /new Function\(source\)/.test(pr)
    && /__jiugeCurrentPageId/.test(pr);
  return { ok: ok, detail: 'preload.readPageScript=' + /readPageScript/.test(pre)
    + ' / new Function(source)=' + /new Function\(source\)/.test(pr)
    + ' / 页 id 注入=' + /__jiugeCurrentPageId/.test(pr) };
});

check('search() 命中恰好 200 条上限（NFR-4 / T3 验收）', function () {
  const m = installMemoryWx();
  const s = freshRequire(path.join(ROOT, 'src', 'utils'))['diary-store.js'];
  const base = new Date(2025, 0, 1);
  for (let i = 0; i < 250; i += 1) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const key = srcDateKey(d);
    m.map.set('morning_diary_' + key, {
      date: key, cells: { work: '高频词命中' + i }, base: {},
      workBoard: {}, moneyBook: {}, studyLog: {}, template: 'standard', updatedAt: 0,
    });
  }
  const r = s.search('高频词');
  return { ok: !r.error && r.data.length === 200,
    detail: '注入 250 篇 → 命中 ' + (r.data ? r.data.length : '?') + ' 条（上限 200）' };
});

check('yearPixels() 一次返回 12×31=372 格，未分片 / 未改 P1', function () {
  installMemoryWx();
  const s = freshRequire(path.join(ROOT, 'src', 'utils'))['diary-store.js'];
  const r = s.yearPixels(2026);
  const months = r.data ? r.data.months : [];
  const cells = months.reduce(function (n, mo) { return n + (mo.cells ? mo.cells.length : 0); }, 0);
  return { ok: months.length === 12 && cells === 372,
    detail: '月份=' + months.length + ' / 格数=' + cells };
});

check('F2：Markdown 用该篇当时模板标签、搜索用标准栏目名，口径不一致原样保留', function () {
  const m = installMemoryWx();
  const s = freshRequire(path.join(ROOT, 'src', 'utils'))['diary-store.js'];
  m.map.set('morning_diary_2026-05-01', {
    date: '2026-05-01', cells: { work: '口径校验正文' }, base: {},
    workBoard: {}, moneyBook: {}, studyLog: {}, template: 'goal', updatedAt: 0,
  });
  const md = s.exportMarkdown().data;
  const hits = s.search('口径校验正文').data;
  const tplLabel = s.fieldsFor('goal').filter(function (f) { return f.key === 'work'; })[0].label;
  const stdLabel = s.GRID_FIELDS.filter(function (f) { return f.key === 'work'; })[0].label;
  const ok = tplLabel !== stdLabel && md.indexOf(tplLabel) >= 0
    && JSON.stringify(hits).indexOf(stdLabel) >= 0;
  return { ok: ok, detail: '模板标签=' + tplLabel + ' / 标准标签=' + stdLabel
    + ' / Markdown 含模板=' + (md.indexOf(tplLabel) >= 0)
    + ' / 搜索含标准=' + (JSON.stringify(hits).indexOf(stdLabel) >= 0) };
});

check('capsuleGroups() 跳过非法 openAt，不出现「NaN 天」', function () {
  const m = installMemoryWx();
  const s = freshRequire(path.join(ROOT, 'src', 'utils'))['diary-store.js'];
  m.map.set('morning_capsules', [
    { id: 'ok', text: '合法', openAt: '2027-01-01', writtenAt: '2026-01-01', opened: false },
    { id: 'bad', text: '非法', openAt: 'not-a-date', writtenAt: '2026-01-01', opened: false },
  ]);
  const g = s.capsuleGroups().data;
  const txt = JSON.stringify(g);
  return { ok: txt.indexOf('NaN') < 0 && g.total === 1,
    detail: 'total=' + g.total + ' / NaN 出现=' + (txt.indexOf('NaN') >= 0) };
});

check('menu:action 三种导出另存映射与 desktop-features 一致，导入唯一入口未破', function () {
  const menu = readText(path.join(ROOT, 'src', 'main', 'menu.js'));
  const df = readText(path.join(ROOT, 'src', 'renderer', 'desktop-features.js'));
  const acts = ['export:text', 'export:markdown', 'export:backup'];
  const menuOk = acts.every(function (a) { return menu.indexOf("'" + a + "'") >= 0; });
  const dfOk = /a\.indexOf\('export:'\)/.test(df) && /EXPORT_META\[kind\]/.test(df);
  const calls = (stripComments(df).match(/store\.importBackup\s*\(/g) || []).length;
  return { ok: menuOk && dfOk && calls === 1,
    detail: '菜单 3 项=' + menuOk + ' / 桌面分发=' + dfOk + ' / importBackup 代码调用=' + calls };
});

check('nav.js 覆盖 5 页 URL 与 5 项侧栏入口', function () {
  const nav = readText(path.join(ROOT, 'src', 'renderer', 'nav.js'));
  const html = readText(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const urlOk = ALL_PAGES.every(function (id) { return nav.indexOf("'/pages/" + id + "/" + id + "'") >= 0; });
  const navOk = ALL_PAGES.every(function (id) { return html.indexOf('data-nav="' + id + '"') >= 0; });
  return { ok: urlOk && navOk, detail: 'URL 映射=' + urlOk + ' / 侧栏 5 项=' + navOk };
});

// ==================================================================== 11. T5 打包交付
section('11. T5 打包 / 启动 / 交付说明一致性');
const README_PATH = path.join(ROOT, 'README.md');
// 整改（R-06）：原实现 BUILD_DIR 指向 ROOT/build，校验的是 build/ 下两个 V1 exe 的
// 字节与 SHA256，而 V3.3 的交付物在 build-v2、由 electron-builder-v2.yml 产出。
// 结果是 verify 69/69 全绿却从未验过交付物。现改为以 artifact-manifest.json 为唯一声明源。
const MANIFEST_PATH = path.join(ROOT, 'build-v2', 'artifact-manifest.json');

check('electron-builder-v2.yml 配置合法：portable 单目标 + 期望产物命名', function () {
  const y = readText(path.join(ROOT, 'electron-builder-v2.yml'));
  const illegal = /^\s*(fileVersion|productVersion)\s*:/m.test(y);
  const hasPortable = /target:\s*portable/.test(y);
  const nameOk = /artifactName:\s*九格手记-v2-便携版\.exe/.test(y);
  const outOk = /output:\s*build-v2/.test(y);
  return { ok: !illegal && hasPortable && nameOk && outOk,
    detail: '非法字段=' + illegal + ' / portable=' + hasPortable + ' / 产物名=' + nameOk + ' / 输出目录=' + outOk };
});

check('交付 exe 唯一，字节数与 SHA256 与 artifact-manifest.json 一致', function () {
  // 这一条替代原先「两个 V1 exe 与 README 对拍」的断言：
  // 它必须能拦住「交付物被替换 / 清单没更新 / 拿旧包冒充新包」三种情况。
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { ok: false, detail: '缺少 build-v2/artifact-manifest.json' };
  }
  const mf = JSON.parse(readText(MANIFEST_PATH));
  const outDir = path.join(ROOT, mf.buildOutputDir || 'build-v2');
  if (!fs.existsSync(outDir)) return { ok: false, detail: '输出目录不存在：' + mf.buildOutputDir };
  const exes = fs.readdirSync(outDir).filter(function (n) { return /\.exe$/i.test(n); });
  if (exes.length !== 1) {
    return { ok: false, detail: '交付目录下 exe 数量=' + exes.length + '（应为 1）：' + exes.join(', ') };
  }
  const f = path.join(outDir, exes[0]);
  const buf = fs.readFileSync(f);
  const sha = sha256(buf);
  const nameOk = exes[0] === mf.artifact;
  const bytesOk = buf.length === mf.bytes;
  const shaOk = sha === mf.sha256;
  return {
    ok: nameOk && bytesOk && shaOk,
    detail: exes[0] + ' = ' + buf.length + 'B/' + sha.slice(0, 12) + '…'
      + '；清单=' + mf.bytes + 'B/' + String(mf.sha256).slice(0, 12) + '…'
      + '；产物名一致=' + nameOk + ' 字节一致=' + bytesOk + ' SHA一致=' + shaOk
  };
});

check('README.md 覆盖 10 个必备章节，并明确区分「另存为文件」与「复制到剪贴板」', function () {
  const r = readText(README_PATH);
  const keys = [
    '两种启动方式', '数据放在哪里', '从手机迁移', '导出：另存为文件 vs 复制到剪贴板',
    '快捷键', '四套皮肤', '仍要运行', '打包级别：L0', '断网也能用', '宿主环境提示',
  ];
  const missing = keys.filter(function (k) { return r.indexOf(k) < 0; });
  const exportOk = /设置页那三个导出按钮仍然是「复制到剪贴板」/.test(r)
    && /要存成文件请用「文件」菜单/.test(r);
  return { ok: missing.length === 0 && exportOk,
    detail: '10 章缺失 ' + missing.length + (missing.length ? '：' + missing.join(',') : '')
      + ' / 导出区分说明=' + exportOk };
});

check('README.md 如实标注未签名 / L0 / 补齐命令，且不含远程 URL', function () {
  const r = readText(README_PATH);
  const ok = /没有购买代码签名证书/.test(r) && /打包级别：L0/.test(r)
    && /npm run dist/.test(r) && !/https?:\/\//.test(r);
  return { ok: ok, detail: '未签名=' + /没有购买代码签名证书/.test(r)
    + ' / L0=' + /打包级别：L0/.test(r) + ' / 补齐命令=' + /npm run dist/.test(r)
    + ' / 无远程 URL=' + !/https?:\/\//.test(r) };
});

check('打包产物资源全部走本地 file://，主进程无 loadURL / 远程地址', function () {
  const m = readText(path.join(ROOT, 'src', 'main', 'main.js'));
  const html = readText(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const ok = /loadFile\(/.test(m) && !/loadURL\(/.test(m) && !/https?:\/\//.test(m)
    && !/https?:\/\//.test(html);
  return { ok: ok,
    detail: 'main.js loadFile=' + /loadFile\(/.test(m) + ' / loadURL=' + /loadURL\(/.test(m)
      + ' / index.html 无远程 URL=' + !/https?:\/\//.test(html) };
});

check('运行时零第三方依赖：package.json 无 dependencies，仅 2 个 devDependencies', function () {
  const p = JSON.parse(readText(path.join(ROOT, 'package.json')));
  const deps = Object.keys(p.dependencies || {});
  const dev = Object.keys(p.devDependencies || {});
  const ok = deps.length === 0 && dev.length === 2
    && dev.indexOf('electron') >= 0 && dev.indexOf('electron-builder') >= 0;
  return { ok: ok, detail: 'dependencies=' + deps.length + ' / devDependencies=' + dev.join(',') };
});

// ==================================================================== 汇总
const failed = results.filter(function (r) { return !r.ok; });
console.log('\n============================================================');
console.log('验证项 ' + results.length + ' 条，通过 ' + (results.length - failed.length) + ' 条，失败 ' + failed.length + ' 条');
if (failed.length) failed.forEach(function (r) { console.log('  [FAIL] ' + r.name + ' → ' + r.detail); });
console.log('IS_PASS: ' + (failed.length ? 'NO' : 'YES'));
console.log('============================================================');

try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结论 */ }
process.exitCode = failed.length ? 1 : 0;
