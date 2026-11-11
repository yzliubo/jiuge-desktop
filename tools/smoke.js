'use strict';
/**
 * 数据层冒烟（架构 T1 验收判据 ③⑤ / §8.3 L0–L2 通用）。
 *
 * 纯 Node、无 GUI、无 Electron：注入内存 global.wx（Map 模拟同步 KV），直接跑
 * src/utils 的 8 个零改动模块。覆盖：
 *   - 31+ 个数据层方法（实际 60 个）；
 *   - v7 / v6 / 无版本号旧档三条导入路径；
 *   - 8 条冲突策略中的 4 条重点：本机有正文才跳过 / 空壳允许补写 /
 *     配置类必须先于写日记 / 写后回读复核；
 *   - QUOTA_EXCEEDED、2000/200 裁剪、学习库写失败；
 *   - 剪贴板导入与文件导入必须调用同一个 store.importBackup(text)，桌面层无第二份合并逻辑；
 *   - 中文失败文案逐字保留（源码只读未改）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const UTILS_DIR = path.join(ROOT, 'src', 'utils');
const SOURCE = 'G:/workbuddy/2026-10-31-23-19-46';

const results = [];
function assert(name, condition, detail) {
  const ok = !!condition;
  results.push({ name: name, ok: ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail !== undefined ? '  → ' + detail : ''));
  return ok;
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 内存 wx：模拟微信同步 KV；未命中返回 ''；quotaOnSet 时抛含 quota 的 Error。 */
function makeWx(opts) {
  const o = opts || {};
  const map = new Map();
  const counters = { get: 0, set: 0, remove: 0, info: 0 };
  return {
    getStorageSync: function (k) { counters.get += 1; return map.has(k) ? map.get(k) : ''; },
    setStorageSync: function (k, v) {
      counters.set += 1;
      if (o.quotaOnSet) throw new Error('wx.setStorageSync failed: exceed quota size limit (simulated)');
      map.set(k, v);
    },
    removeStorageSync: function (k) { counters.remove += 1; map.delete(k); },
    getStorageInfoSync: function () {
      counters.info += 1;
      return { keys: Array.from(map.keys()), currentSize: 0, limitSize: 0 };
    },
    _map: map,
    _counters: counters,
    resetCounters: function () { counters.get = 0; counters.set = 0; counters.remove = 0; counters.info = 0; },
  };
}

const MODULE_NAMES = ['diary-store', 'work-board', 'money-book', 'study-log',
  'cell-insights', 'greetings', 'quotes', 'theme'];

/** 每次 fresh 清 require.cache，避免 diary-store 的模块级 memo 缓存跨场景污染。 */
function fresh(wx) {
  global.wx = wx;
  MODULE_NAMES.forEach(function (n) {
    const p = path.join(UTILS_DIR, n + '.js');
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* 未加载过 */ }
  });
  return require(path.join(UTILS_DIR, 'diary-store.js'));
}

function record(date, text) {
  return {
    date: date,
    base: { weather: '晴', anniversary: '', body: '不错', mood: '平静' },
    cells: { work: text === undefined ? '今天写了点东西' : text },
    workBoard: {}, moneyBook: {}, studyLog: {},
    template: 'standard', updatedAt: Date.now(),
  };
}

function backup(opts) {
  const o = opts || {};
  const b = {
    app: 'jiuge-notes',
    exportedAt: new Date().toISOString(),
    records: o.records || [],
  };
  if (o.version !== undefined) b.version = o.version;
  if (o.withConfig) {
    b.startedAt = '2020-01-01';
    b.template = 'goal';
    b.modules = { work: false, money: true, growth: true };
    b.milestones = { items: [{ at: 7, reward: '小奖励' }] };
    b.reviews = { 'week_2026-01-05': ['甲', '乙', '丙'], 'month_2026-01': ['丁', '戊', '己'] };
  }
  if (o.capsules) b.capsules = o.capsules;
  if (o.studyLibrary) b.studyLibrary = o.studyLibrary;
  return JSON.stringify(b);
}

// ================================================================ 1. 31+ 方法
section('1. 数据层方法冒烟（内存 global.wx，无 Electron / 无 GUI）');
const wx0 = makeWx();
const s0 = fresh(wx0);
const CALLS = [
  ['today', []], ['formatDate', [new Date('2026-11-07T10:00:00')]], ['emptyRecord', ['2026-01-01']],
  ['load', ['2026-01-01']], ['save', [record('2026-01-01', '第一天')]], ['listDates', []],
  ['all', []], ['writtenDates', []], ['stats', []], ['hasContent', [record('2026-01-01', 'x')]],
  ['milestones', []], ['milestoneView', [10]], ['saveMilestones', [[{ at: 7, reward: '奖励' }]]],
  ['resetMilestones', []], ['getTemplateId', []], ['activeTemplate', []], ['activeGridFields', []],
  ['fieldsFor', ['goal']], ['setTemplate', ['goal']], ['setTemplate', ['standard']],
  ['firstWeekEnabled', []], ['setFirstWeekEnabled', [true]], ['modules', []],
  ['setModule', ['work', false]], ['setModule', ['work', true]], ['firstWeekState', []],
  ['promptFor', ['work', '2026-01-01', 0]], ['previousToday', []], ['sameDayAcrossYears', ['01-01']],
  ['search', ['第一天']], ['weeklyReview', []], ['frequentPhrases', [12]], ['moodTrend', [30]],
  ['reviewPeriodKey', ['week']], ['reviewPrompts', ['week']],
  ['loadReview', ['week', '2026-01-05']], ['saveReview', ['week', '2026-01-05', ['甲', '乙', '丙']]],
  ['yearPixels', [2026]], ['randomEntry', []], ['exportText', []], ['exportMarkdown', []],
  ['exportBackup', []], ['capsulePresets', []], ['saveCapsule', ['给未来', '2027-01-01']],
  ['listCapsules', []], ['dueCapsules', []], ['openCapsule', ['not-exist']], ['capsuleGroups', []],
  ['prettyDate', ['2026-01-01']], ['workSummary', []], ['workDigest', ['week']],
  ['workTagPool', [6]], ['moneySummary', ['week']], ['moduleDigest', ['week']],
  ['readStudyLibrary', []], ['saveStudyLibrary', [{ items: [], topics: [] }]], ['studySaveOk', []],
  ['studySummary', ['week']], ['studyLibraryText', []],
];
let called = 0;
let thrown = [];
CALLS.forEach(function (item) {
  const name = item[0];
  const args = item[1];
  if (typeof s0[name] !== 'function') { thrown.push(name + '(缺失)'); return; }
  try {
    s0[name].apply(null, args);
    called += 1;
  } catch (e) {
    thrown.push(name + '(' + String(e && e.message || e) + ')');
  }
});
assert('31+ 个数据层方法可调用（无异常）', called >= 31 && thrown.length === 0,
  '实际调用 ' + called + '/' + CALLS.length + ' 个，异常 ' + thrown.length + (thrown.length ? '：' + thrown.join('; ') : ''));
assert('exportBackup() 桌面自身导出 version=7', (function () {
  const r = s0.exportBackup();
  try { return JSON.parse(r.data).version === 7; } catch (e) { return false; }
})(), 'version=7');

// ================================================================ 2. 三条导入路径
section('2. v7 / v6 / 无版本号旧档三条导入路径');
const s7 = fresh(makeWx());
const r7 = s7.importBackup(backup({
  version: 7, withConfig: true,
  records: [record('2026-01-01', '第一天'), record('2026-01-02', '第二天')],
}));
assert('v7 完整导入：imported=2 / partial=false / sourceVersion=7 / configImported>0',
  !r7.error && r7.data.imported === 2 && r7.data.partial === false
  && r7.data.sourceVersion === 7 && r7.data.configImported > 0,
  JSON.stringify(r7.data || r7.error));

const s6 = fresh(makeWx());
const r6 = s6.importBackup(backup({ version: 6, records: [record('2026-01-03', '第三天')] }));
assert('v6 缺 5 个 v7 配置字段：不报错 / 不判 INVALID_FORMAT / partial=false',
  !r6.error && r6.data.imported === 1 && r6.data.partial === false
  && r6.data.sourceVersion === 6 && r6.data.configImported === 0,
  JSON.stringify(r6.data || r6.error));

const sold = fresh(makeWx());
const rold = sold.importBackup(backup({ records: [record('2026-01-04', '旧档')] }));
assert('无版本号旧档：partial=true / sourceVersion=0（提示「旧版备份」）',
  !rold.error && rold.data.partial === true && rold.data.sourceVersion === 0,
  JSON.stringify(rold.data || rold.error));

const sBad = fresh(makeWx());
assert('非 JSON → INVALID_JSON；无 records 数组 → INVALID_FORMAT',
  sBad.importBackup('not json').error === 'INVALID_JSON'
  && sBad.importBackup(JSON.stringify({ app: 'jiuge-notes' })).error === 'INVALID_FORMAT');

// ================================================================ 3. 冲突策略
section('3. 8 条冲突策略中的 4 条重点（C3–C5 / C9 / NFR-2）');
const wx1 = makeWx();
const s1 = fresh(wx1);
s1.save(record('2026-02-01', '本机正文'));
const before = s1.load('2026-02-01').data.cells.work;
const rr1 = s1.importBackup(backup({ version: 7, records: [record('2026-02-01', '备份正文')] }));
assert('① 本机有正文才跳过，绝不覆盖', rr1.data.skipped >= 1
  && s1.load('2026-02-01').data.cells.work === before,
  'skipped=' + rr1.data.skipped + ' 正文=' + s1.load('2026-02-01').data.cells.work);

const wx2 = makeWx();
const s2 = fresh(wx2);
wx2.setStorageSync('morning_diary_2026-02-02', s2.emptyRecord('2026-02-02'));
const rr2 = s2.importBackup(backup({ version: 7, records: [record('2026-02-02', '补写正文')] }));
assert('② 本机只是空壳 → 允许备份补写',
  s2.load('2026-02-02').data.cells.work === '补写正文' && rr2.data.imported >= 1,
  'imported=' + rr2.data.imported + ' 正文=' + s2.load('2026-02-02').data.cells.work);

const wx3 = makeWx();
const s3 = fresh(wx3);
const rr3 = s3.importBackup(backup({
  version: 7, withConfig: true, records: [record('2026-03-01', '换机第一篇')],
}));
const st3 = s3.stats();
assert('③ 配置类先于写日记：startedAt 不被第一篇写入日期覆盖',
  st3.data.startedAt === '2020-01-01' && rr3.data.configImported >= 5,
  'startedAt=' + st3.data.startedAt + ' configImported=' + rr3.data.configImported);

const wx4 = makeWx();
const s4 = fresh(wx4);
const emptyRec = { date: '2026-04-01', cells: {}, base: {} };
const rr4 = s4.importBackup(backup({
  version: 7, records: [emptyRec, record('2026-04-02', '有正文')],
}));
assert('④ 写后回读复核：空壳计 emptyShell + skipped，imported 只计真实正文',
  rr4.data.emptyShell === 1 && rr4.data.skipped === 1 && rr4.data.imported === 1,
  JSON.stringify(rr4.data));

// 附加：学习库按 id 合并 / 胶囊按 id 去重、跳过非法 openAt（C7）
const wx5 = makeWx();
const s5 = fresh(wx5);
const lib = {
  items: [{ id: 'it1', title: '书', kind: 'book', done: 1, total: 10, unit: '页', topicId: 'tp1', note: '' }],
  topics: [{ id: 'tp1', title: '主题' }],
};
const caps = [
  { id: 'c1', text: '第一封', openAt: '2027-01-01', writtenAt: '2026-01-01', opened: false },
  { id: 'bad', text: '非法', openAt: 'not-a-date', writtenAt: '2026-01-01', opened: false },
];
const b5 = backup({ version: 7, records: [], capsules: caps, studyLibrary: lib });
s5.importBackup(b5);
const first = s5.importBackup(b5);
assert('附加：重复导入不产生重复胶囊 / 学习库条目，且跳过非法 openAt',
  s5.listCapsules().data.length === 1 && s5.readStudyLibrary().items.length === 1
  && s5.capsuleGroups().data.total === 1,
  '胶囊=' + s5.listCapsules().data.length + ' 学习库条目=' + s5.readStudyLibrary().items.length
  + ' 二次导入 capsulesImported=' + first.data.capsulesImported);

// ================================================================ 4. QUOTA / 裁剪 / 文案
section('4. QUOTA_EXCEEDED / 落盘裁剪 / 学习库写失败 / 中文文案逐字保留');
const sq = fresh(makeWx({ quotaOnSet: true }));
const rq = sq.save({ date: '2026-05-01', cells: { work: '正文' }, base: {} });
assert('JIUGE_KV_QUOTA 模拟：save() 返回 QUOTA_EXCEEDED',
  rq.error === 'QUOTA_EXCEEDED', 'error=' + rq.error);

const sn = fresh(makeWx());
const rn = sn.save({
  date: '2026-06-01',
  cells: { work: '甲'.repeat(5000) },
  base: { weather: '乙'.repeat(500), anniversary: '', body: '', mood: '' },
});
assert('5000 字正文稳定裁到 2000 / 基础栏裁到 200',
  rn.data.cells.work.length === 2000 && rn.data.base.weather.length === 200,
  'cells=' + rn.data.cells.work.length + ' base=' + rn.data.base.weather.length);

const ss = fresh(makeWx({ quotaOnSet: true }));
ss.saveStudyLibrary({ items: [], topics: [] });
assert('学习库写失败 → studySaveOk() === false（界面显式提示）', ss.studySaveOk() === false,
  'studySaveOk=' + ss.studySaveOk());

const pageText = ['index', 'review', 'capsule', 'habit', 'settings'].map(function (id) {
  return fs.readFileSync(path.join(SOURCE, 'pages', id, id + '.js'), 'utf8');
}).join('\n');
assert('两条原文失败提示在源码中逐字存在（未被润色）',
  pageText.indexOf('本机存储已满，请先导出备份再清理旧日记') >= 0
  && pageText.indexOf('学习库未能保存，请检查本机存储空间') >= 0);

// ================================================================ 5. 唯一导入入口
section('5. 剪贴板导入与文件导入共用唯一 importBackup(text)');
const dfText = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop-features.js'), 'utf8');
const settingsText = fs.readFileSync(path.join(SOURCE, 'pages', 'settings', 'settings.js'), 'utf8');
assert('源码「从剪贴板导入」调用 store.importBackup(text)',
  /store\.importBackup\(text\)/.test(settingsText));
assert('桌面「导入备份文件」调用同一个 store.importBackup(text)',
  /store\.importBackup\(text\)\s*;/.test(dfText));
assert('桌面层未另写合并 / 去重 / 版本分支逻辑',
  !/imported\s*\+=\s*1|skipped\s*\+=\s*1|hasContent\(local\)|sourceVersion\s*=\s*/.test(dfText));

// ================================================================ 6. C1–C10 导入契约逐条实测
section('6. C1–C10 导入契约逐条实测（T4 / PRD §5）');
const settingsWxml = fs.readFileSync(path.join(ROOT, 'src', 'views', 'settings.wxml'), 'utf8');
const dfSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'desktop-features.js'), 'utf8');

assert('C1 设置页「文件导入」与「从剪贴板导入」入口并存',
  settingsWxml.indexOf('导入小程序备份文件（v6/v7）') >= 0
  && settingsWxml.indexOf('从剪贴板导入') >= 0,
  '入口 2 个：文件导入 + 剪贴板导入');

assert('C2 取消 / 错误不写任何数据',
  sBad.importBackup('not json').error === 'INVALID_JSON'
  && /res\.canceled/.test(dfSource)
  && /if \(!res \|\| res\.canceled\)/.test(dfSource),
  'INVALID_JSON + 取消分支 return（无写入）');

assert('C3 v6 缺 5 个 v7 配置字段不报错、不判 INVALID_FORMAT',
  !r6.error && r6.data.partial === false && r6.data.sourceVersion === 6
  && r6.data.configImported === 0,
  'imported=' + r6.data.imported + ' / configImported=' + r6.data.configImported + ' / partial=' + r6.data.partial);

assert('C4 v7 配置还原且顺序先于写日记',
  rr3.data.configImported >= 5 && st3.data.startedAt === '2020-01-01',
  'configImported=' + rr3.data.configImported + ' / startedAt=' + st3.data.startedAt);

assert('C5 无版本号旧档 partial=true 并提示「旧版备份」',
  rold.data.partial === true && rold.data.sourceVersion === 0
  && /旧版/.test(dfSource),
  'partial=' + rold.data.partial + ' / sourceVersion=' + rold.data.sourceVersion);

assert('C6 非 JSON → INVALID_JSON；无 records 数组 → INVALID_FORMAT',
  sBad.importBackup('not json').error === 'INVALID_JSON'
  && sBad.importBackup(JSON.stringify({ app: 'jiuge-notes' })).error === 'INVALID_FORMAT',
  'INVALID_JSON / INVALID_FORMAT');

// C7 用独立场景重建：前面各节的 fresh() 会替换 global.wx，旧模块实例再读会命中空 Map，
// 因此这里不复用 s1/s5，避免测试脚本自身的全局污染（产品代码不受影响）。
const wxC7 = makeWx();
const sC7 = fresh(wxC7);
sC7.save({ date: '2026-08-01', cells: { work: '本机正文' }, base: {}, workBoard: {}, moneyBook: {}, studyLog: {} });
const libC7 = {
  items: [{ id: 'it1', title: '书', kind: 'book', done: 1, total: 10, unit: '页', topicId: 'tp1', note: '' }],
  topics: [{ id: 'tp1', title: '主题' }],
};
const capsC7 = [
  { id: 'c1', text: '第一封', openAt: '2027-01-01', writtenAt: '2026-01-01', opened: false },
  { id: 'bad', text: '非法', openAt: 'not-a-date', writtenAt: '2026-01-01', opened: false },
];
const bC7 = backup({
  version: 7, records: [record('2026-08-01', '备份正文')], capsules: capsC7, studyLibrary: libC7,
});
sC7.importBackup(bC7);
const secondC7 = sC7.importBackup(bC7);
assert('C7 重复导入不产生重复胶囊/学习库条目，有正文日不被覆盖',
  secondC7.data.capsulesImported === 0
  && sC7.listCapsules().data.length === 1
  && sC7.readStudyLibrary().items.length === 1
  && sC7.load('2026-08-01').data.cells.work === '本机正文',
  '二次 capsulesImported=' + secondC7.data.capsulesImported
  + ' / 胶囊=' + sC7.listCapsules().data.length
  + ' / 学习库=' + sC7.readStudyLibrary().items.length
  + ' / 有正文日正文=' + sC7.load('2026-08-01').data.cells.work);

assert('C8 导入前确认框显示篇数与「只补写不覆盖」，导入后反馈 imported/skipped',
  /检测到 ' \+ records\.length \+ ' 篇日记。导入只补写本机没有的日期，不会覆盖已有记录。/.test(dfSource)
  && /confirmText: '开始导入'/.test(dfSource)
  && /d\.imported/.test(dfSource) && /d\.skipped/.test(dfSource),
  '确认框文案逐字 + imported/skipped 反馈');

assert('C9 空壳计 emptyShell + skipped，imported 只计真实正文',
  rr4.data.emptyShell === 1 && rr4.data.skipped === 1 && rr4.data.imported === 1,
  'imported=' + rr4.data.imported + ' / skipped=' + rr4.data.skipped
  + ' / emptyShell=' + rr4.data.emptyShell);

const wx10 = makeWx();
const s10 = fresh(wx10);
s10.importBackup(backup({
  version: 7, withConfig: true, records: [record('2026-07-01', '启程校验')],
}));
const st10 = s10.stats();
const yp10 = s10.yearPixels(2026);
const rv10 = s10.loadReview('week', '2026-01-05');
assert('C10 导入后启程天数 / 连续天数 / 年历 / 复盘答案与手机一致',
  st10.data.startedAt === '2020-01-01'
  && s10.writtenDates().length === 1
  && yp10.data.months.length === 12
  && rv10.data && rv10.data.length === 3 && rv10.data[0] === '甲',
  'startedAt=' + st10.data.startedAt + ' / writtenDates=' + s10.writtenDates().length
  + ' / 年历月份=' + yp10.data.months.length
  + ' / 复盘首答=' + (rv10.data ? rv10.data[0] : '?'));

// ================================================================ 汇总
const failed = results.filter(function (r) { return !r.ok; });
console.log('\n============================================================');
console.log('smoke 断言 ' + results.length + ' 条，通过 ' + (results.length - failed.length) + ' 条，失败 ' + failed.length + ' 条');
if (failed.length) failed.forEach(function (r) { console.log('  [FAIL] ' + r.name + ' → ' + r.detail); });
console.log('IS_PASS: ' + (failed.length ? 'NO' : 'YES'));
console.log('============================================================');
process.exitCode = failed.length ? 1 : 0;
