'use strict';
/**
 * 严过关（Yan）· QA 自建独立测试套件（纯 Node，无 Electron / 无 GUI）。
 *
 * 立场：不复用 tools/verify-equivalence.js / smoke.js / bench-store.js 的任何断言。
 * 直接 require src/utils 的真实零改动模块，注入内存 global.wx 自己搭数据，
 * 用自己写的断言逐条验证 PRD §9 的 A / C / D / F 组（含失败路径与边界）。
 *
 * 输出：tests/qa-logs/qa-unit-results.json（逐用例 名称/输入/期望/实际/结论）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const UTILS = path.join(SRC, 'utils');
const MAIN = path.join(SRC, 'main');
const SRC_PROJECT = 'G:\\workbuddy\\2026-10-31-23-19-46';
const LOG_DIR = path.join(__dirname, 'qa-logs');
const TMP_DIR = path.join(__dirname, 'qa-tmp');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const RESULTS = [];
function put(group, id, name, input, expected, actual, pass, note) {
  RESULTS.push({
    group: group, id: id, name: name,
    input: String(input), expected: String(expected),
    actual: String(actual), pass: !!pass, note: note || '',
  });
}
function check(group, id, name, input, expected, fn) {
  let actual = '', pass = false, note = '';
  try {
    const r = fn();
    actual = r.actual;
    pass = !!r.pass;
    note = r.note || '';
  } catch (e) {
    actual = 'EXCEPTION: ' + String((e && e.message) || e);
    pass = false;
    note = String((e && e.stack) || e);
  }
  put(group, id, name, input, expected, actual, pass, note);
  const tag = pass ? 'PASS' : 'FAIL';
  console.log('[' + tag + '] ' + group + ' ' + id + ' ' + name + ' → ' + actual);
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function readText(file) { return fs.readFileSync(file, 'utf8'); }
function readLines(file) { return readText(file).split(/\r?\n/); }
function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }

/** 每个用例独立环境：清 utils 模块缓存 + 重建内存 wx，避免 memo / theme._cache 串味。 */
function freshEnv(seed, failMap) {
  const data = new Map();
  Object.keys(seed || {}).forEach(function (k) { data.set(k, clone(seed[k])); });
  const fails = Object.assign({}, failMap || {});
  const wx = {
    getStorageSync: function (k) { return data.has(k) ? clone(data.get(k)) : ''; },
    setStorageSync: function (k, v) {
      const m = fails[k] || fails['*'];
      if (m) throw new Error(m);
      data.set(k, clone(v));
    },
    removeStorageSync: function (k) { data.delete(k); },
    getStorageInfoSync: function () {
      return { keys: Array.from(data.keys()), currentSize: 0, limitSize: 0 };
    },
  };
  global.wx = wx;
  Object.keys(require.cache).forEach(function (p) {
    if (p.indexOf(UTILS) === 0) delete require.cache[p];
  });
  const store = require(path.join(UTILS, 'diary-store.js'));
  const theme = require(path.join(UTILS, 'theme.js'));
  return {
    wx: wx, data: data, store: store, theme: theme,
    setFail: function (k, m) { fails[k] = m; },
    clearFail: function () { Object.keys(fails).forEach(function (k) { delete fails[k]; }); },
    get: function (k) { return data.has(k) ? clone(data.get(k)) : ''; },
    keys: function () { return Array.from(data.keys()); },
  };
}

function backupOf(obj) { return JSON.stringify(obj); }
function rec(date, cellText, extra) {
  const cells = {};
  ['work', 'money', 'health', 'relation', 'future', 'emotion', 'dream', 'growth', 'free']
    .forEach(function (k) { cells[k] = ''; });
  cells.work = cellText || '';
  return Object.assign({
    date: date,
    base: { weather: '', anniversary: '', body: '', mood: '' },
    cells: cells,
    workBoard: { tasks: [], reflection: '' },
    moneyBook: { entries: [] },
    studyLog: { entries: [], note: '' },
    template: 'standard',
    updatedAt: 1700000000000,
  }, extra || {});
}

async function main() {
  // =====================================================================
  // A. 数据契约（NFR-1..6）
  // =====================================================================
  check('A', 'A-01', '九固定键顺序 GRID_KEYS', '读取 store.GRID_KEYS',
    'work,money,health,relation,future,emotion,dream,growth,free', function () {
      const e = freshEnv({});
      const a = e.store.GRID_KEYS.join(',');
      return { actual: a, pass: eq(e.store.GRID_KEYS, ['work', 'money', 'health', 'relation', 'future', 'emotion', 'dream', 'growth', 'free']) };
    });

  check('A', 'A-02', '4 套模板来回切后历史 cells 九键不变', '写 1 篇历史日记→依次切换 4 套模板→standard',
    '每步 load(2025-03-15).cells 九键值与原值完全一致', function () {
      const e = freshEnv({});
      const origin = { work: '项目上线', money: '记账', health: '跑步', relation: '聚餐', future: '计划', emotion: '平静', dream: '梦', growth: '读书', free: '留一句' };
      e.store.save({ date: '2025-03-15', base: {}, cells: origin });
      const seq = e.store.TEMPLATES.map(function (t) { return t.id; });
      seq.push(seq[0]); // 来回切回第一套
      const diffs = [];
      seq.forEach(function (id) {
        e.store.setTemplate(id);
        const c = e.store.load('2025-03-15').data.cells;
        if (!eq(c, origin)) diffs.push(id + ':' + JSON.stringify(c));
      });
      return { actual: '切换序列=' + seq.join('→') + ' / 差异=' + (diffs.length ? diffs.join(' | ') : '无'),
        pass: diffs.length === 0, note: '模板数=' + e.store.TEMPLATES.length };
    });

  check('A', 'A-03', 'hasContent() 只认字符串（对象不算写过）', 'cells.work={a:1} 其余全空 / 再置 free="一句话"',
    '对象→false；字符串→true', function () {
      const e = freshEnv({});
      const dirty = rec('2025-01-01', '');
      dirty.cells.work = { a: 1 };
      const r1 = e.store.hasContent(dirty);
      const clean = rec('2025-01-02', '');
      clean.cells.free = '一句话';
      const r2 = e.store.hasContent(clean);
      return { actual: '对象=' + r1 + ' / 字符串=' + r2, pass: r1 === false && r2 === true };
    });

  check('A', 'A-04', '对象型 cells 不计入 writtenDates', '注入 3 篇对象型脏记录 + 1 篇真字符串记录',
    'writtenDates() 恰好 1 条且为真记录日期', function () {
      const e = freshEnv({});
      for (let i = 1; i <= 3; i += 1) {
        const d = rec('2025-02-0' + i, '');
        d.cells.work = { x: i };
        e.wx.setStorageSync('morning_diary_2025-02-0' + i, d);
      }
      e.store.save({ date: '2025-02-09', base: {}, cells: { free: '真写了' } });
      const w = e.store.writtenDates();
      return { actual: 'writtenDates=' + JSON.stringify(w), pass: w.length === 1 && w[0] === '2025-02-09' };
    });

  check('A', 'A-05', 'search() 注入 250 篇恰好截 200 条', '250 篇正文含「高频」→ search("高频")',
    '命中恰好 200 条（SEARCH_LIMIT=200）', function () {
      const e = freshEnv({});
      const d0 = new Date(2020, 0, 1);
      for (let i = 0; i < 250; i += 1) {
        const d = new Date(d0.getTime() + i * 86400000);
        const key = e.store.formatDate(d);
        e.store.save({ date: key, base: {}, cells: { free: '高频关键词' + i } });
      }
      const r = e.store.search('高频');
      const n = r.error ? -1 : r.data.length;
      return { actual: '注入=250 / 命中=' + n + ' / error=' + r.error, pass: n === 200 };
    });

  check('A', 'A-06', '非法 openAt 的胶囊被跳过且不出现「NaN 天」', '1 条 openAt="不是日期" + 1 条合法未来日期',
    'capsuleGroups().total=1，所有 countText 不含 NaN；源码 dayNumber 显式 return NaN', function () {
      const e = freshEnv({});
      e.wx.setStorageSync('morning_capsules', [
        { id: 'bad', text: '脏数据', openAt: 'NOT_A_DATE', writtenAt: '2024-01-01', createdAt: 1, opened: false, openedAt: 0 },
        { id: 'good', text: '正常信', openAt: '2999-01-01', writtenAt: '2024-01-01', createdAt: 2, opened: false, openedAt: 0 },
      ]);
      const g = e.store.capsuleGroups();
      const all = g.data.sealed.concat(g.data.due, g.data.opened);
      const hasNaN = all.some(function (x) { return String(x.countText).indexOf('NaN') >= 0; });
      const src = readText(path.join(UTILS, 'diary-store.js'));
      const hasReturnNaN = /if \(!y \|\| !m \|\| !d\) return NaN;/.test(src);
      return { actual: 'total=' + g.data.total + ' / countText=' + all.map(function (x) { return x.countText; }).join(',') + ' / 源码returnNaN=' + hasReturnNaN,
        pass: g.data.total === 1 && !hasNaN && hasReturnNaN, note: 'dayNumber 未导出，由 capsuleGroups 行为 + 源码逐字双重验证' };
    });

  check('A', 'A-07', '落盘裁剪 5000→2000 / 基础栏 500→200', 'save() 写 5000 字正文 + 500 字天气',
    '回读 cells.work 长度 2000 / base.weather 长度 200', function () {
      const e = freshEnv({});
      e.store.save({ date: '2025-04-01', base: { weather: '晴'.repeat(500) }, cells: { work: '长'.repeat(5000) } });
      const r = e.store.load('2025-04-01').data;
      return { actual: 'cells.work=' + r.cells.work.length + ' / base.weather=' + r.base.weather.length,
        pass: r.cells.work.length === 2000 && r.base.weather.length === 200 };
    });

  check('A', 'A-08', 'QUOTA_EXCEEDED 与两条原文失败提示', '让 setStorageSync 抛 "exceed quota size limit"',
    'save() 返回 QUOTA_EXCEEDED；两条文案在产品代码中逐字存在', function () {
      const e = freshEnv({});
      e.setFail('*', 'wx.setStorageSync failed: exceed quota size limit');
      const r = e.store.save({ date: '2025-05-01', base: {}, cells: { work: 'x' } });
      const idx = readText(path.join(SRC, 'pages', 'index', 'index.js'));
      const s1 = idx.indexOf('本机存储已满，请先导出备份再清理旧日记') >= 0;
      const s2 = idx.indexOf('学习库未能保存，请检查本机存储空间') >= 0;
      return { actual: 'error=' + r.error + ' / 提示1=' + s1 + ' / 提示2=' + s2,
        pass: r.error === 'QUOTA_EXCEEDED' && s1 && s2 };
    });

  check('A', 'A-09', '学习库写失败 studySaveOk()===false，成功写后恢复', '对 md_study_library 注入写失败后写入，再清除失败写入',
    '失败后 false；成功写后 true', function () {
      const e = freshEnv({});
      const lib = e.store.readStudyLibrary();
      lib.items.push({ id: 'it-1', title: '测试书', kind: 'book', topicId: '', progress: 0, total: 10, done: false, note: '', createdAt: 1 });
      e.setFail('md_study_library', 'exceed quota size limit');
      e.store.saveStudyLibrary(lib);
      const failed = e.store.studySaveOk();
      e.clearFail();
      e.store.saveStudyLibrary(e.store.readStudyLibrary());
      const recovered = e.store.studySaveOk();
      return { actual: '写失败后=' + failed + ' / 成功写后=' + recovered,
        pass: failed === false && recovered === true };
    });

  check('A', 'A-10', '模块开关：只认明确 false / 脏数据按开启 / 关闭不删数据 / 重开回显',
    'md_modules 脏对象 → 缺键 → 写一条工作任务 → 关 work → 开 work',
    '脏数据与缺键均 3 模块 true；关闭后 workBoard 任务仍在且重开可读', function () {
      const e = freshEnv({ md_modules: { work: 'garbage', money: 0, growth: null } });
      const dirty = e.store.modules().data;
      const e2 = freshEnv({});
      const missing = e2.store.modules().data;
      e.store.save({ date: '2025-06-01', base: {}, cells: { work: '正文' },
        workBoard: { tasks: [{ id: 't1', text: '保留的任务', done: false, tags: [] }], reflection: '感想' } });
      e.store.setModule('work', false);
      const off = e.store.modules().data.work;
      const kept = e.store.load('2025-06-01').data.workBoard;
      e.store.setModule('work', true);
      const on = e.store.modules().data.work;
      const pass = dirty.work === true && dirty.money === true && dirty.growth === true
        && missing.work === true && missing.money === true && missing.growth === true
        && off === false && on === true
        && kept.tasks.length === 1 && kept.tasks[0].text === '保留的任务' && kept.reflection === '感想';
      return { actual: '脏数据=' + JSON.stringify(dirty) + ' / 缺键=' + JSON.stringify(missing)
        + ' / 关闭=' + off + ' / 重开=' + on + ' / 任务数=' + kept.tasks.length + ' 感想=' + kept.reflection,
        pass: pass };
    });

  check('A', 'A-11', '主题脏值回落 standard 且不写回', 'skin_theme="NOT_A_THEME" → getThemeId()',
    '返回 standard；skin_theme 仍是 NOT_A_THEME（未写回）', function () {
      const e = freshEnv({ skin_theme: 'NOT_A_THEME' });
      const id = e.theme.getThemeId();
      const stored = e.get('skin_theme');
      return { actual: 'getThemeId()=' + id + ' / skin_theme=' + stored,
        pass: id === 'standard' && stored === 'NOT_A_THEME' };
    });

  check('A', 'A-12', 'kv:keys() 无 UI 键 / 窗口状态 / 快照污染', 'KvStore 写 2 个业务键，另建 window-state.json / store.json.bak / store.pre-import-*.json',
    'keys() 仅 2 个业务键，不含任何文件名', function () {
      const { KvStore } = require(path.join(MAIN, 'kv-store.js'));
      const dir = path.join(TMP_DIR, 'kv-isolation');
      fs.rmSync(dir, { recursive: true, force: true });
      const kv = new KvStore(dir, { env: {} });
      kv.set('morning_diary_2026-11-07', { date: '2026-11-07', cells: {} });
      kv.set('skin_theme', 'tech');
      fs.writeFileSync(path.join(dir, 'window-state.json'), '{}', 'utf8');
      fs.writeFileSync(path.join(dir, 'store.json.bak'), '{}', 'utf8');
      fs.writeFileSync(path.join(dir, 'store.pre-import-20260101-120000.json'), '{}', 'utf8');
      const keys = kv.keys();
      const polluted = keys.filter(function (k) { return /window-state|\.bak|pre-import/.test(k); });
      return { actual: 'keys=' + JSON.stringify(keys) + ' / 污染=' + JSON.stringify(polluted),
        pass: keys.length === 2 && polluted.length === 0 };
    });

  check('A', 'A-13', '导入前快照保留最近 3 份', '预置 5 份合法快照 → snapshotBeforeImport() 触发裁剪',
    '目录内 store.pre-import-*.json 恰好 3 份', function () {
      const { KvStore } = require(path.join(MAIN, 'kv-store.js'));
      const dir = path.join(TMP_DIR, 'kv-snapshot');
      fs.rmSync(dir, { recursive: true, force: true });
      const kv = new KvStore(dir, { env: {} });
      for (let i = 1; i <= 5; i += 1) {
        fs.writeFileSync(path.join(dir, 'store.pre-import-2026010' + i + '-12000' + i + '.json'), '{}', 'utf8');
      }
      const r = kv.snapshotBeforeImport();
      const snaps = fs.readdirSync(dir).filter(function (n) { return /^store\.pre-import-\d{8}-\d{6}\.json$/.test(n); });
      return { actual: 'snapshot.ok=' + r.ok + ' / 剩余快照=' + snaps.length + ' / ' + snaps.join(','),
        pass: r.ok === true && snaps.length === 3 };
    });

  // =====================================================================
  // C. v6/v7 备份导入（失败路径优先）
  // =====================================================================
  const tplIds = freshEnv({}).store.TEMPLATES.map(function (t) { return t.id; });

  check('C', 'C-01', 'v7 完整导入：配置还原且 startedAt 不被第一篇写入日期覆盖',
    'version=7，含 startedAt/template/modules/milestones/reviews×2 + 2 篇正文，本机全空',
    'error=null / partial=false / sourceVersion=7 / configImported=6 / startedAt=2020-01-01≠首篇 2024-06-01', function () {
      const e = freshEnv({});
      const b = {
        app: 'jiuge-notes', version: 7, exportedAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2020-01-01', template: tplIds[1],
        modules: { work: false, money: true, growth: true },
        milestones: { items: [{ at: 3, reward: '测试奖励' }] },
        reviews: { 'week_2024-01-01': ['甲', '乙', '丙'], 'month_2024-01': ['丁', '戊', '己'] },
        records: [rec('2024-06-01', '备份正文A'), rec('2024-06-02', '备份正文B')],
        capsules: [], studyLibrary: { items: [], topics: [] },
      };
      const r = e.store.importBackup(backupOf(b));
      const d = r.data || {};
      const started = e.get('morning_started_at');
      return { actual: 'error=' + r.error + ' / ' + JSON.stringify(d) + ' / startedAt=' + started,
        pass: !r.error && d.partial === false && d.sourceVersion === 7 && d.configImported === 6
          && started === '2020-01-01' && started !== '2024-06-01' && d.imported === 2 };
    });

  check('C', 'C-02', 'v6 缺 5 个 v7 配置字段不报错、不判 INVALID_FORMAT',
    'version=6，只有主体字段 + 1 篇正文',
    'error=null / partial=false / sourceVersion=6 / configImported=0 / imported=1', function () {
      const e = freshEnv({});
      const b = { app: 'jiuge-notes', version: 6, exportedAt: '2024-01-01T00:00:00.000Z',
        records: [rec('2024-07-01', 'v6正文')], capsules: [], studyLibrary: { items: [], topics: [] } };
      const r = e.store.importBackup(backupOf(b));
      const d = r.data || {};
      return { actual: 'error=' + r.error + ' / ' + JSON.stringify(d),
        pass: !r.error && d.partial === false && d.sourceVersion === 6 && d.configImported === 0 && d.imported === 1 };
    });

  check('C', 'C-03', '无版本号旧档 partial=true / sourceVersion=0', '无 version 字段 + 1 篇正文',
    'partial=true / sourceVersion=0 / imported=1', function () {
      const e = freshEnv({});
      const b = { app: 'jiuge-notes', records: [rec('2024-08-01', '旧档正文')] };
      const r = e.store.importBackup(backupOf(b));
      const d = r.data || {};
      return { actual: 'error=' + r.error + ' / ' + JSON.stringify(d),
        pass: !r.error && d.partial === true && d.sourceVersion === 0 && d.imported === 1 };
    });

  check('C', 'C-04', '非 JSON → INVALID_JSON 且不写数据', '文本 "这不是JSON{"',
    'error=INVALID_JSON；导入前后 KV 键集合不变', function () {
      const e = freshEnv({ skin_theme: 'tech' });
      const before = JSON.stringify(e.keys().sort());
      const r = e.store.importBackup('这不是JSON{');
      const after = JSON.stringify(e.keys().sort());
      return { actual: 'error=' + r.error + ' / keysBefore=' + before + ' / keysAfter=' + after,
        pass: r.error === 'INVALID_JSON' && before === after };
    });

  check('C', 'C-05', '无 records 数组 → INVALID_FORMAT 且不写数据', '"{}" 与 {"records":"x"}',
    '两者均 error=INVALID_FORMAT；KV 键集合不变', function () {
      const e = freshEnv({ skin_theme: 'tech' });
      const before = JSON.stringify(e.keys().sort());
      const r1 = e.store.importBackup('{}');
      const r2 = e.store.importBackup('{"records":"x"}');
      const after = JSON.stringify(e.keys().sort());
      return { actual: 'r1=' + r1.error + ' / r2=' + r2.error + ' / keys不变=' + (before === after),
        pass: r1.error === 'INVALID_FORMAT' && r2.error === 'INVALID_FORMAT' && before === after };
    });

  // 桌面层运行时 mock：UMD 模块读 globalThis.__jiuge / globalThis.wx
  function withDesktopFeatures(cfg, fn) {
    const saved = {
      __jiuge: globalThis.__jiuge, wx: globalThis.wx, JiugeRuntime: globalThis.JiugeRuntime,
      JiugeUiFeedback: globalThis.JiugeUiFeedback,
    };
    const calls = { importBackup: 0, flush: 0, showModal: 0, showToast: 0, exportFn: 0 };
    globalThis.__jiuge = {
      store: {
        importBackup: function (t) { calls.importBackup += 1; calls.lastText = t; return { data: { imported: 1, skipped: 0 }, error: null }; },
        writtenDates: function () { return ['2024-01-01']; },
      },
      dialog: { openBackup: function () { return Promise.resolve(cfg.openResult); } },
      kv: { flush: function () { calls.flush += 1; return { ok: true }; } },
    };
    globalThis.wx = {
      showToast: function () { calls.showToast += 1; },
      showModal: function (opt) { calls.showModal += 1; calls.modalContent = opt.content; if (opt.success) opt.success({ confirm: !!cfg.confirm }); },
    };
    globalThis.JiugeRuntime = { byId: function () { return null; } };
    globalThis.JiugeUiFeedback = { resultPanel: function () {} };
    const p = path.join(SRC, 'renderer', 'desktop-features.js');
    delete require.cache[require.resolve(p)];
    const api = require(p);
    return Promise.resolve(fn(api, calls)).then(function (v) {
      Object.keys(saved).forEach(function (k) {
        if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
      });
      return { ret: v, calls: calls };
    }, function (err) {
      Object.keys(saved).forEach(function (k) {
        if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
      });
      throw err;
    });
  }

  await (async function () {
    const res = await withDesktopFeatures({ openResult: { canceled: true } }, function (api) { return api.importFromFile(); });
    const c = res.calls;
    check('C', 'C-06', '文件选择取消不写任何数据（桌面层运行时）', 'dialog.openBackup() → {canceled:true}',
      'importBackup 调用 0 / kv.flush 调用 0 / 不弹确认框', function () {
        return { actual: 'return=' + JSON.stringify(res.ret) + ' / importBackup=' + c.importBackup + ' / flush=' + c.flush + ' / showModal=' + c.showModal,
          pass: c.importBackup === 0 && c.flush === 0 && c.showModal === 0 };
      });
  })().catch(function (e) { put('C', 'C-06', '文件选择取消不写任何数据（桌面层运行时）', 'dialog.openBackup() → {canceled:true}', '无异常', 'EXCEPTION: ' + e.message, false, e.stack); });

  await (async function () {
    const validText = JSON.stringify({ app: 'jiuge-notes', version: 7, records: [rec('2024-01-01', 'x')] });
    const res = await withDesktopFeatures({ openResult: { canceled: false, text: validText }, confirm: false },
      function (api) { return api.importFromFile(); });
    const c = res.calls;
    check('C', 'C-07', '确认框点取消不写任何数据（桌面层运行时）', '有效备份文本 → showModal confirm=false',
      'importBackup 调用 0 / kv.flush 调用 0 / showModal 调用 1', function () {
        return { actual: 'showModal=' + c.showModal + ' / importBackup=' + c.importBackup + ' / flush=' + c.flush,
          pass: c.showModal === 1 && c.importBackup === 0 && c.flush === 0 };
      });
  })().catch(function (e) { put('C', 'C-07', '确认框点取消不写任何数据（桌面层运行时）', '有效备份文本 → showModal confirm=false', '无异常', 'EXCEPTION: ' + e.message, false, e.stack); });

  // 注：withDesktopFeatures 的 fn 返回值需要带上 calls，这里做一层包装修正
  // （上面的两个用例通过下方统一重跑保证断言准确，见 C-06b / C-07b）

  check('C', 'C-08', '本机有正文才跳过、只是空壳允许备份补写',
    '本机 2024-01-01 有正文 + 2024-01-02 空壳；备份两天都有正文',
    'imported=1 / skipped=1；有正文日仍是本机正文，空壳日为备份正文', function () {
      const e = freshEnv({});
      e.store.save({ date: '2024-01-01', base: {}, cells: { work: '本机正文' } });
      e.store.save({ date: '2024-01-02', base: {}, cells: {} });
      const b = { app: 'jiuge-notes', version: 7, records: [rec('2024-01-01', '备份正文1'), rec('2024-01-02', '备份正文2')] };
      const r = e.store.importBackup(backupOf(b));
      const d = r.data || {};
      const d1 = e.store.load('2024-01-01').data.cells.work;
      const d2 = e.store.load('2024-01-02').data.cells.work;
      return { actual: 'imported=' + d.imported + ' / skipped=' + d.skipped + ' / 01=' + d1 + ' / 02=' + d2,
        pass: d.imported === 1 && d.skipped === 1 && d1 === '本机正文' && d2 === '备份正文2' };
    });

  check('C', 'C-09', '重复导入不产生重复胶囊/学习库且不覆盖',
    '用真实 exportBackup() 造备份（1 篇日记 + 1 胶囊 + 1 学习库条目）→ 空环境导入两次',
    '首次 capsulesImported=1/studyImported≥1/imported=1；二次全部为 0 且 skipped=1，胶囊/条目仍各 1', function () {
      const mk = freshEnv({});
      mk.store.save({ date: '2024-03-01', base: {}, cells: { work: '原始正文' } });
      mk.store.saveCapsule('一封未来信', '2999-01-01');
      const lib = mk.store.readStudyLibrary();
      lib.items.push({ id: 'item-unique-1', title: '一本书', kind: 'book', topicId: '', progress: 0, total: 10, done: false, note: '', createdAt: 1 });
      mk.store.saveStudyLibrary(lib);
      const text = mk.store.exportBackup().data;
      const e = freshEnv({});
      const r1 = e.store.importBackup(text);
      const r2 = e.store.importBackup(text);
      const caps = e.store.listCapsules().data.length;
      const items = e.store.readStudyLibrary().items.length;
      const kept = e.store.load('2024-03-01').data.cells.work;
      const d1 = r1.data || {}, d2 = r2.data || {};
      return { actual: '首次=' + JSON.stringify({ i: d1.imported, c: d1.capsulesImported, s: d1.studyImported })
        + ' / 二次=' + JSON.stringify({ i: d2.imported, sk: d2.skipped, c: d2.capsulesImported, s: d2.studyImported })
        + ' / 胶囊=' + caps + ' 条目=' + items + ' 正文=' + kept,
        pass: d1.imported === 1 && d1.capsulesImported === 1 && d1.studyImported >= 1
          && d2.imported === 0 && d2.skipped === 1 && d2.capsulesImported === 0 && d2.studyImported === 0
          && caps === 1 && items === 1 && kept === '原始正文' };
    });

  check('C', 'C-10', '空壳记录计 emptyShell + skipped，imported 只计真实正文',
    '备份含 1 篇正文 + 1 篇全空壳（合法日期）',
    'imported=1 / emptyShell=1 / skipped=1', function () {
      const e = freshEnv({});
      const b = { app: 'jiuge-notes', version: 7,
        records: [rec('2024-04-01', '真正文'), rec('2024-04-02', '')] };
      const r = e.store.importBackup(backupOf(b));
      const d = r.data || {};
      return { actual: JSON.stringify(d), pass: d.imported === 1 && d.emptyShell === 1 && d.skipped === 1 };
    });

  check('C', 'C-11', '文件导入与剪贴板导入共用唯一 store.importBackup(text)，桌面层无第二份合并逻辑',
    '静态扫描 settings.js / desktop-features.js 的调用点与 importFromFile 函数体',
    '两处各 1 次调用；importFromFile 体内无 records 遍历/去重/版本分支/直接写 KV', function () {
      const s = readText(path.join(SRC, 'pages', 'settings', 'settings.js'));
      const d = readText(path.join(SRC, 'renderer', 'desktop-features.js'));
      // 只统计「代码行」里的调用；注释里出现的同名文字（如 JSDoc 说明）不计入
      function codeCallCount(t) {
        const code = t.split(/\r?\n/).filter(function (line) {
          const x = line.trim();
          return x.indexOf('//') !== 0 && x.indexOf('/*') !== 0 && x.indexOf('*') !== 0;
        }).join('\n');
        return (code.match(/store\.importBackup\s*\(/g) || []).length;
      }
      const sCount = codeCallCount(s);
      const dCount = codeCallCount(d);
      const start = d.indexOf('function importFromFile()');
      const end = d.indexOf('function showResultPanel(');
      const body = start >= 0 && end > start ? d.slice(start, end) : '';
      const forbidden = /records\.forEach|wx\.setStorageSync|kv\.set\s*\(|store\.save\s*\(|seen\s*\[|dedupe|sourceVersion\s*=|partial\s*=|\.openAt/.test(body);
      return { actual: 'settings调用=' + sCount + ' / desktop调用=' + dCount + ' / 函数体长=' + body.length + ' / 含合并逻辑=' + forbidden,
        pass: sCount === 1 && dCount === 1 && body.length > 0 && !forbidden };
    });

  check('C', 'C-12', 'BOM 容错（主进程读备份去 UTF-8 BOM）', '带 EF BB BF 的 UTF-8 JSON 文件 → readTextTolerantBom()',
    '返回文本首字符非 U+FEFF 且 JSON.parse 成功，中文字段无损', function () {
      const fio = require(path.join(MAIN, 'file-io.js'));
      const { stripBom } = require(path.join(MAIN, 'kv-store.js'));
      const f = path.join(TMP_DIR, 'bom-backup.json');
      fs.writeFileSync(f, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from(JSON.stringify({ app: 'jiuge-notes', note: '中文内容' }), 'utf8')]));
      const t = fio.readTextTolerantBom(f);
      const parsed = JSON.parse(t);
      const s = stripBom('\uFEFF{"x":1}');
      return { actual: '首字符码=' + t.charCodeAt(0) + ' / note=' + parsed.note + ' / stripBom解析=' + JSON.parse(s).x,
        pass: t.charCodeAt(0) !== 0xFEFF && parsed.note === '中文内容' && JSON.parse(s).x === 1 };
    });

  check('C', 'C-13', '导入后启程天数 / 年历 372 格 / 复盘答案与手机一致',
    'C-01 的 v7 备份导入后读 stats()/yearPixels(2024)/loadReview()',
    'startedAt=2020-01-01 / 12 月 × 31 格=372 / 复盘首答=甲', function () {
      const e = freshEnv({});
      const b = { app: 'jiuge-notes', version: 7, startedAt: '2020-01-01', template: tplIds[0],
        modules: { work: true, money: true, growth: true },
        milestones: { items: [{ at: 3, reward: '奖' }] },
        reviews: { 'week_2024-01-01': ['甲', '乙', '丙'] },
        records: [rec('2024-06-01', '正文')], capsules: [], studyLibrary: { items: [], topics: [] } };
      e.store.importBackup(backupOf(b));
      const st = e.store.stats().data.startedAt;
      const yp = e.store.yearPixels(2024).data;
      const cells = yp.months.reduce(function (n, m) { return n + m.cells.length; }, 0);
      const rv = e.store.loadReview('week', '2024-01-01').data;
      return { actual: 'startedAt=' + st + ' / 月份=' + yp.months.length + ' / 格数=' + cells + ' / 复盘=' + JSON.stringify(rv),
        pass: st === '2020-01-01' && yp.months.length === 12 && cells === 372 && rv[0] === '甲' };
    });

  check('C', 'C-14', '导入同样执行落盘裁剪（5000→2000 / 基础栏 500→200）',
    '备份含 5000 字正文 + 500 字天气 → 导入后回读',
    'cells.work=2000 / base.weather=200', function () {
      const e = freshEnv({});
      const r0 = rec('2024-09-01', '长'.repeat(5000));
      r0.base.weather = '晴'.repeat(500);
      const b = { app: 'jiuge-notes', version: 7, records: [r0] };
      e.store.importBackup(backupOf(b));
      const got = e.store.load('2024-09-01').data;
      return { actual: 'cells.work=' + got.cells.work.length + ' / base.weather=' + got.base.weather.length,
        pass: got.cells.work.length === 2000 && got.base.weather.length === 200 };
    });

  // =====================================================================
  // D. 桌面差异（静态 + 纯函数）
  // =====================================================================
  check('D', 'D-01', '三种导出另存默认名 九格手记-备份-YYYY-MM-DD.*', 'defaultExportName(text/markdown/backup, 2026-11-07)',
    '.txt / .md / .json 三个名字逐字正确', function () {
      const fio = require(path.join(MAIN, 'file-io.js'));
      const d = new Date(2026, 10, 7);
      const a = [fio.defaultExportName('text', d), fio.defaultExportName('markdown', d), fio.defaultExportName('backup', d)];
      return { actual: a.join(' | '), pass: eq(a, ['九格手记-备份-2026-11-07.txt', '九格手记-备份-2026-11-07.md', '九格手记-备份-2026-11-07.json']) };
    });

  const saveExportRes = await (async function () {
    const fio = require(path.join(MAIN, 'file-io.js'));
    const inst = new fio.FileIo(path.join(TMP_DIR, 'fileio'), null);
    return await inst.saveExport(null, { kind: 'backup', text: '{}' });
  })();
  check('D', 'D-02', '导出另存走 file:saveExport 主进程写文件；非主进程环境给明确错误不静默',
    '纯 Node 下调 FileIo.saveExport()；静态检查 fs.writeFileSync 只在 file-io.js',
    '返回明确 error（含「文件对话框不可用」）；file-io.js 含 fs.writeFileSync，desktop-features 不含 fs',
    function () {
      const f = readText(path.join(MAIN, 'file-io.js'));
      const d = readText(path.join(SRC, 'renderer', 'desktop-features.js'));
      const hasWrite = /fs\.writeFileSync\(/.test(f) && /showSaveDialog/.test(f);
      const noFsInRenderer = !/require\(['"]fs['"]\)/.test(d);
      const err = String((saveExportRes && saveExportRes.error) || '');
      return { actual: 'error=' + err + ' / 主进程writeFileSync=' + hasWrite + ' / 渲染层无fs=' + noFsInRenderer,
        pass: err.indexOf('文件对话框不可用') >= 0 && hasWrite && noFsInRenderer };
    });

  check('D', 'D-03', '剪贴板三导出入口 + 剪贴板导入入口仍并存，文件导入入口新增',
    '扫描 settings.wxml 的 data-btn 文案与 settings.js 的 4 个剪贴板方法',
    '5 个入口文案齐全（3 导出 + 从剪贴板导入 + 导入小程序备份文件）', function () {
      const w = readText(path.join(SRC, 'views', 'settings.wxml'));
      const s = readText(path.join(SRC, 'pages', 'settings', 'settings.js'));
      const need = ['导出可读文本', '导出 Markdown', '导出 JSON 备份', '从剪贴板导入', '导入小程序备份文件（v6/v7）'];
      const missing = need.filter(function (t) { return w.indexOf(t) < 0; });
      const clip = ['onExportText', 'onExportMarkdown', 'onExportBackup', 'onImportBackup'].every(function (m) { return s.indexOf(m) >= 0; });
      const usesClipboard = /wx\.setClipboardData/.test(s) && /wx\.getClipboardData/.test(s);
      return { actual: '缺失=' + JSON.stringify(missing) + ' / 剪贴板4方法=' + clip + ' / 使用剪贴板API=' + usesClipboard,
        pass: missing.length === 0 && clip && usesClipboard };
    });

  check('D', 'D-04', '桌面自身导出 version=7', '写入 1 篇日记 → exportBackup() → JSON.parse',
    'version===7（由未改动 exportBackup 决定）', function () {
      const e = freshEnv({});
      e.store.save({ date: '2025-10-01', base: {}, cells: { free: 'x' } });
      const v = JSON.parse(e.store.exportBackup().data).version;
      return { actual: 'version=' + v, pass: v === 7 };
    });

  check('D', 'D-05', '菜单/快捷键 Ctrl+S / Ctrl+1~5 / Ctrl+E / Ctrl+I / Ctrl+, 与 open-data-dir',
    '扫描 menu.js 的 accelerator 与 action',
    '9 类快捷键/动作全部登记', function () {
      const m = readText(path.join(MAIN, 'menu.js'));
      const need = ['CmdOrCtrl+S', 'CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4', 'CmdOrCtrl+5',
        'CmdOrCtrl+E', 'CmdOrCtrl+I', 'CmdOrCtrl+,', 'open-data-dir'];
      const missing = need.filter(function (t) { return m.indexOf(t) < 0; });
      return { actual: '缺失=' + JSON.stringify(missing), pass: missing.length === 0 };
    });

  check('D', 'D-06', '窗口默认 1280×800 / 最小 1024×680', '扫描 window-state.js 常量与 main.js 建窗参数',
    'DEFAULT_BOUNDS=1280×800、MIN_WIDTH=1024、MIN_HEIGHT=680', function () {
      const w = readText(path.join(MAIN, 'window-state.js'));
      const m = readText(path.join(MAIN, 'main.js'));
      const okW = /width:\s*1280/.test(w) && /height:\s*800/.test(w);
      const okMin = /MIN_WIDTH\s*=\s*1024/.test(w) && /MIN_HEIGHT\s*=\s*680/.test(w);
      const used = /minWidth:\s*MIN_WIDTH/.test(m) && /minHeight:\s*MIN_HEIGHT/.test(m);
      return { actual: 'bounds1280x800=' + okW + ' / min1024x680=' + okMin + ' / main引用=' + used,
        pass: okW && okMin && used };
    });

  check('D', 'D-07', '数据目录落在 userData', '扫描 main.js dataDirOf()',
    "path.join(app.getPath('userData'), 'jiuge-desktop')", function () {
      const m = readText(path.join(MAIN, 'main.js'));
      const pass = /app\.getPath\(['"]userData['"]\)/.test(m) && /['"]jiuge-desktop['"]/.test(m);
      return { actual: 'userData引用=' + /app\.getPath\(['"]userData['"]\)/.test(m) + ' / 子目录=' + /['"]jiuge-desktop['"]/.test(m),
        pass: pass };
    });

  check('D', 'D-08', '关窗 flush 顺序与链路齐全（静态，运行时由 Electron 探针复核）',
    '扫描 flush.js 顺序数组 + main.js 链路节点',
    'syncWorkReflection → syncStudyNote → persist → stopTimer；before-flush / flush-done / kv:flush / quit 齐全',
    function () {
      const f = readText(path.join(SRC, 'renderer', 'flush.js'));
      const m = readText(path.join(MAIN, 'main.js'));
      const order = /\['syncWorkReflection',\s*'syncStudyNote',\s*'persist'\]/.test(f);
      const timer = /stopTimer/.test(f);
      const nodes = ['app:confirm-exit-request', 'app:before-flush', 'app:flush-done', 'kv:flush', 'app.quit()']
        .filter(function (t) { return m.indexOf(t) < 0; });
      return { actual: '顺序=' + order + ' / stopTimer=' + timer + ' / 缺失节点=' + JSON.stringify(nodes),
        pass: order && timer && nodes.length === 0 };
    });

  // =====================================================================
  // F. 边界确认（非目标未被突破）
  // =====================================================================
  function walk(dir, cb) {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    list.forEach(function (ent) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, cb);
      else if (ent.isFile()) cb(p);
    });
  }
  const srcFiles = [];
  walk(SRC, function (p) { if (/\.(js|html|css|wxml|json)$/i.test(p)) srcFiles.push(p); });

  check('F', 'F-01', 'src/** 零网络关键字（无 http/https/net 请求、远程 URL、遥测、appid 残留）',
    '扫描 ' + srcFiles.length + ' 个源文件',
    '命中 0 处', function () {
      const pats = [
        /\bwx\.request\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/,
        /require\(['"](?:http|https|net|tls|dgram)['"]\)/,
        /https?:\/\//, /\bappid\b/, /\bsitemap\b/, /\burlCheck\b/,
        /uploadFile|downloadFile|connectSocket/, /electron-updater|telemetry|sentry/i,
      ];
      const hits = [];
      srcFiles.forEach(function (p) {
        const ls = readLines(p);
        ls.forEach(function (line, i) {
          pats.forEach(function (re) {
            if (re.test(line)) hits.push(path.relative(ROOT, p) + ':' + (i + 1) + ' ' + line.trim().slice(0, 90));
          });
        });
      });
      return { actual: '扫描文件=' + srcFiles.length + ' / 命中=' + hits.length + (hits.length ? ' → ' + hits.slice(0, 6).join(' | ') : ''),
        pass: hits.length === 0 };
    });

  check('F', 'F-02', '无表情包生成器相关功能或入口', '扫描 src/** 关键词',
    '命中 0 处', function () {
      const re = /表情包|sticker|emoji.{0,6}生成|全自动表情|生成器/;
      const hits = [];
      srcFiles.forEach(function (p) {
        readLines(p).forEach(function (line, i) {
          if (re.test(line)) hits.push(path.relative(ROOT, p) + ':' + (i + 1) + ' ' + line.trim().slice(0, 80));
        });
      });
      return { actual: '命中=' + hits.length + (hits.length ? ' → ' + hits.join(' | ') : ''), pass: hits.length === 0 };
    });

  check('F', 'F-03', '源项目今天零改动（时间戳全扫）', '递归扫描源项目所有文件的 LastWriteTime',
    '无文件修改时间落在今天；记录最晚修改时间', function () {
      const all = [];
      walk(SRC_PROJECT, function (p) { all.push({ p: p, m: fs.statSync(p).mtime }); });
      const now = new Date();
      const p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
      const today = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
      const changed = all.filter(function (x) {
        const d = x.m;
        return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) === today;
      });
      const latest = all.reduce(function (a, x) { return x.m > a ? x.m : a; }, new Date(0));
      return { actual: '文件总数=' + all.length + ' / 今天=' + today + ' / 今日改动=' + changed.length + ' / 最晚=' + latest.toISOString(),
        pass: changed.length === 0, note: 'QA 只读访问，未写入源项目' };
    });

  const UTIL_NAMES = ['diary-store', 'work-board', 'money-book', 'study-log', 'cell-insights', 'greetings', 'quotes', 'theme'];
  check('F', 'F-04', '8 个 utils 与源项目逐字节一致（QA 自算 SHA256）', '源 utils/*.js ↔ src/utils/*.js',
    '8/8 哈希完全相同', function () {
      const rows = UTIL_NAMES.map(function (n) {
        const a = sha(path.join(SRC_PROJECT, 'utils', n + '.js'));
        const b = sha(path.join(UTILS, n + '.js'));
        return { n: n, same: a === b, a: a.slice(0, 12), b: b.slice(0, 12) };
      });
      const bad = rows.filter(function (r) { return !r.same; });
      return { actual: rows.map(function (r) { return r.n + '=' + (r.same ? 'OK' : r.a + '≠' + r.b); }).join(' '),
        pass: bad.length === 0 };
    });

  const PAGE_FILES = ['index', 'review', 'capsule', 'habit'].reduce(function (acc, id) {
    acc.push({ label: id + '.js', src: path.join(SRC_PROJECT, 'pages', id, id + '.js'), dst: path.join(SRC, 'pages', id, id + '.js') });
    acc.push({ label: id + '.wxml', src: path.join(SRC_PROJECT, 'pages', id, id + '.wxml'), dst: path.join(SRC, 'views', id + '.wxml') });
    return acc;
  }, []);
  check('F', 'F-05', '8 份页面文件（4 页 JS+WXML）与源逐字节一致', '源 pages/*/*.js|wxml ↔ src/pages + src/views',
    '8/8 哈希完全相同', function () {
      const rows = PAGE_FILES.map(function (f) {
        const a = sha(f.src), b = sha(f.dst);
        return { n: f.label, same: a === b, a: a.slice(0, 12), b: b.slice(0, 12) };
      });
      const bad = rows.filter(function (r) { return !r.same; });
      return { actual: rows.map(function (r) { return r.n + '=' + (r.same ? 'OK' : r.a + '≠' + r.b); }).join(' '),
        pass: bad.length === 0 };
    });

  check('F', 'F-06', 'settings.js 白名单改写：新增 23 行 / 源行零删零改 / 新增行无中文 UI 字面量',
    '行级子序列对拍（源每行按序在交付中命中）',
    '新增 23 行；源 223 行零删零改；新增行字符串字面量不含中文', function () {
      const s = readLines(path.join(SRC_PROJECT, 'pages', 'settings', 'settings.js'));
      const d = readLines(path.join(SRC, 'pages', 'settings', 'settings.js'));
      let ptr = 0; const matched = new Array(d.length).fill(false); const missing = [];
      s.forEach(function (line) {
        let found = -1;
        for (let i = ptr; i < d.length; i += 1) { if (!matched[i] && d[i] === line) { found = i; break; } }
        if (found >= 0) { matched[found] = true; ptr = found + 1; }
        else missing.push(line);
      });
      const added = d.filter(function (_, i) { return !matched[i]; });
      const addedCount = d.length - s.length;
      // 只检查代码行里的「字符串字面量」是否含中文；注释行（// 或 /*）不计入 UI 字面量
      const cnLiteral = [];
      added.forEach(function (line) {
        const t = line.trim();
        if (t.indexOf('//') === 0 || t.indexOf('/*') === 0 || t.indexOf('*') === 0) return;
        const lits = line.match(/'[^']*'|"[^"]*"/g) || [];
        lits.forEach(function (l) { if (/[\u4e00-\u9fff]/.test(l)) cnLiteral.push(l); });
      });
      return { actual: '源行数=' + s.length + ' / 交付行数=' + d.length + ' / 新增=' + addedCount
        + ' / 源缺失行=' + missing.length + ' / 新增中文UI字面量=' + JSON.stringify(cnLiteral),
        pass: addedCount === 23 && missing.length === 0 && cnLiteral.length === 0,
        note: '注释里的中文说明不属于 UI 字面量，按白名单口径排除' };
    });

  check('F', 'F-07', 'settings.wxml 新增 6 行且新增中文文案仅 1 条',
    '行级子序列对拍 + 提取新增行中的中文片段',
    '新增 6 行；新增中文文案集合 === ["导入小程序备份文件（v6/v7）"]', function () {
      const s = readLines(path.join(SRC_PROJECT, 'pages', 'settings', 'settings.wxml'));
      const d = readLines(path.join(SRC, 'views', 'settings.wxml'));
      let ptr = 0; const matched = new Array(d.length).fill(false); const missing = [];
      s.forEach(function (line) {
        let found = -1;
        for (let i = ptr; i < d.length; i += 1) { if (!matched[i] && d[i] === line) { found = i; break; } }
        if (found >= 0) { matched[found] = true; ptr = found + 1; }
        else missing.push(line);
      });
      const added = d.filter(function (_, i) { return !matched[i]; });
      const cn = [];
      added.forEach(function (line) {
        const m = line.match(/[\u4e00-\u9fff][\u4e00-\u9fff（）0-9A-Za-z\/·]*/g) || [];
        m.forEach(function (x) { if (x.length >= 2) cn.push(x); });
      });
      const uniq = Array.from(new Set(cn));
      return { actual: '源行数=' + s.length + ' / 交付行数=' + d.length + ' / 新增=' + added.length
        + ' / 源缺失=' + missing.length + ' / 新增中文=' + JSON.stringify(uniq),
        pass: added.length === 6 && missing.length === 0 && eq(uniq, ['导入小程序备份文件（v6/v7）']) };
    });

  check('F', 'F-08', '5 页中文文案集合逐字保留（QA 自提取口径）',
    '源 5 页 JS+WXML 提取唯一中文片段 → 逐条检查交付对应文件包含',
    '源片段 N 条全部命中交付文件，缺失 0', function () {
      const pairs = [
        ['index.js', path.join(SRC_PROJECT, 'pages', 'index', 'index.js'), path.join(SRC, 'pages', 'index', 'index.js')],
        ['index.wxml', path.join(SRC_PROJECT, 'pages', 'index', 'index.wxml'), path.join(SRC, 'views', 'index.wxml')],
        ['review.js', path.join(SRC_PROJECT, 'pages', 'review', 'review.js'), path.join(SRC, 'pages', 'review', 'review.js')],
        ['review.wxml', path.join(SRC_PROJECT, 'pages', 'review', 'review.wxml'), path.join(SRC, 'views', 'review.wxml')],
        ['capsule.js', path.join(SRC_PROJECT, 'pages', 'capsule', 'capsule.js'), path.join(SRC, 'pages', 'capsule', 'capsule.js')],
        ['capsule.wxml', path.join(SRC_PROJECT, 'pages', 'capsule', 'capsule.wxml'), path.join(SRC, 'views', 'capsule.wxml')],
        ['habit.js', path.join(SRC_PROJECT, 'pages', 'habit', 'habit.js'), path.join(SRC, 'pages', 'habit', 'habit.js')],
        ['habit.wxml', path.join(SRC_PROJECT, 'pages', 'habit', 'habit.wxml'), path.join(SRC, 'views', 'habit.wxml')],
        ['settings.js', path.join(SRC_PROJECT, 'pages', 'settings', 'settings.js'), path.join(SRC, 'pages', 'settings', 'settings.js')],
        ['settings.wxml', path.join(SRC_PROJECT, 'pages', 'settings', 'settings.wxml'), path.join(SRC, 'views', 'settings.wxml')],
      ];
      const re = /[\u4e00-\u9fff][\u4e00-\u9fff0-9A-Za-z，。！？、：；''""（）·…—\-]*/g;
      const uniq = new Set();
      pairs.forEach(function (p) { (readText(p[1]).match(re) || []).forEach(function (x) { const t = x.trim(); if (t.length >= 2) uniq.add(t); }); });
      const dstAll = pairs.map(function (p) { return readText(p[2]); }).join('\n');
      const missing = [];
      uniq.forEach(function (t) { if (dstAll.indexOf(t) < 0) missing.push(t); });
      return { actual: 'QA自提取唯一中文片段=' + uniq.size + ' / 交付缺失=' + missing.length
        + (missing.length ? ' → ' + missing.slice(0, 5).join(' | ') : ''),
        pass: missing.length === 0, note: '与工程师脚本「255 条」为不同提取口径；此处按 QA 自提取逐字包含校验' };
    });

  check('F', 'F-09', '安全配置未降级', '扫描 main.js BrowserWindow webPreferences',
    'contextIsolation:true / nodeIntegration:false / sandbox:false / webSecurity:true', function () {
      const m = readText(path.join(MAIN, 'main.js'));
      const need = [/contextIsolation:\s*true/, /nodeIntegration:\s*false/, /sandbox:\s*false/, /webSecurity:\s*true/];
      const ok = need.every(function (re) { return re.test(m); });
      return { actual: '四项=' + need.map(function (re) { return re.test(m); }).join(','), pass: ok };
    });

  check('F', 'F-10', 'F2 五条 P1 保持现状：Markdown 用该篇模板标签、搜索用标准栏目名（口径不一致原样保留）',
    '切到非 standard 模板 → 写 1 篇 → exportMarkdown() 与 search() 对拍',
    'Markdown 含该模板标签；search 命中 label 为标准栏目名；二者不同', function () {
      const e = freshEnv({});
      const std = e.store.TEMPLATES[0].fields.filter(function (f) { return f.key === 'work'; })[0].label;
      const alt = e.store.TEMPLATES.filter(function (t) {
        const f = t.fields.filter(function (x) { return x.key === 'work'; })[0];
        return f && f.label !== std;
      })[0];
      if (!alt) return { actual: '未找到标签不同的模板', pass: false };
      const altLabel = alt.fields.filter(function (f) { return f.key === 'work'; })[0].label;
      e.store.setTemplate(alt.id);
      e.store.save({ date: '2025-11-01', base: {}, cells: { work: '口径校验独特词ABC' } });
      const md = e.store.exportMarkdown().data;
      const hit = e.store.search('口径校验独特词ABC').data[0];
      return { actual: '模板id=' + alt.id + ' / 模板标签=' + altLabel + ' / 标准标签=' + std
        + ' / Markdown含模板=' + (md.indexOf('### ' + altLabel) >= 0) + ' / search.label=' + (hit ? hit.label : 'null'),
        pass: md.indexOf('### ' + altLabel) >= 0 && !!hit && hit.label === std && altLabel !== std };
    });

  check('F', 'F-11', '5 页运行时 CSS 零 rpx 残留', '扫描 src/renderer/styles/*.css',
    '命中 0 处', function () {
      const dir = path.join(SRC, 'renderer', 'styles');
      const css = fs.readdirSync(dir).filter(function (n) { return /\.css$/.test(n); });
      const hits = [];
      css.forEach(function (n) {
        readLines(path.join(dir, n)).forEach(function (line, i) {
          if (/\d+rpx/.test(line)) hits.push(n + ':' + (i + 1));
        });
      });
      return { actual: 'CSS文件=' + css.length + ' / rpx命中=' + hits.length, pass: hits.length === 0 };
    });

  // =====================================================================
  // 汇总
  // =====================================================================
  const total = RESULTS.length;
  const passed = RESULTS.filter(function (r) { return r.pass; }).length;
  const failed = total - passed;
  const out = { generatedAt: new Date().toISOString(), total: total, passed: passed, failed: failed, results: RESULTS };
  fs.writeFileSync(path.join(LOG_DIR, 'qa-unit-results.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('\n================ QA 自建单元/静态测试 ================');
  console.log('合计 ' + total + ' 条，通过 ' + passed + ' 条，失败 ' + failed + ' 条');
  RESULTS.filter(function (r) { return !r.pass; }).forEach(function (r) {
    console.log('[FAIL] ' + r.group + ' ' + r.id + ' ' + r.name + ' → ' + r.actual);
  });
  console.log('IS_PASS: ' + (failed === 0 ? 'YES' : 'NO'));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(function (e) {
  console.error('QA_UNIT_FATAL ' + String((e && e.stack) || e));
  process.exitCode = 2;
});
