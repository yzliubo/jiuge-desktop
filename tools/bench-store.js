'use strict';
/**
 * 读放大基线验证（架构 §3.3 / T1 验收判据 ④ / 硬约束 3）。
 *
 * 注入 200 篇日记，用内存 global.wx 统计 wx.getStorageSync（等价于 kv:get）调用次数：
 *   - 第一次渲染预热 diary-store 的 memoAll / memoWritten / memoStats / memoFreq；
 *   - 第二次渲染（无写操作）kv:get 次数必须 ≤ 30（架构基线 24）；
 *   - 任一 kv:set 之后首次 all() 必须重新触发全量读（写时失效协议）。
 *
 * 适配层**不引入第二份业务缓存**：以上缓存语义完全由零改动的 diary-store.js 自己控制。
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const UTILS_DIR = path.join(ROOT, 'src', 'utils');

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function dateKey(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function makeWx() {
  const map = new Map();
  const counters = { get: 0, set: 0, info: 0 };
  return {
    getStorageSync: function (k) { counters.get += 1; return map.has(k) ? map.get(k) : ''; },
    setStorageSync: function (k, v) { counters.set += 1; map.set(k, v); },
    removeStorageSync: function (k) { map.delete(k); },
    getStorageInfoSync: function () {
      counters.info += 1;
      return { keys: Array.from(map.keys()), currentSize: 0, limitSize: 0 };
    },
    _map: map,
    _counters: counters,
    resetCounters: function () { counters.get = 0; counters.set = 0; counters.info = 0; },
    getCount: function () { return counters.get; },
    infoCount: function () { return counters.info; },
  };
}

function fresh(wx) {
  global.wx = wx;
  ['diary-store', 'work-board', 'money-book', 'study-log', 'cell-insights', 'greetings', 'quotes', 'theme']
    .forEach(function (n) {
      const p = path.join(UTILS_DIR, n + '.js');
      try { delete require.cache[require.resolve(p)]; } catch (e) { /* 未加载过 */ }
    });
  return require(path.join(UTILS_DIR, 'diary-store.js'));
}

/** 模拟一次页面 refresh 的读取组合（今日页 + 回看页的典型调用）。 */
function renderPass(store, gridKeys, today) {
  store.stats();
  store.firstWeekState();
  store.previousToday();
  gridKeys.forEach(function (k) { store.promptFor(k, today, 0); });
  store.writtenDates();
  store.modules();
  store.getTemplateId();
  store.loadReview('week', store.reviewPeriodKey('week'));
  store.frequentPhrases(12);
  store.moodTrend(30);
  store.weeklyReview();
  store.moduleDigest('week');
}

function main() {
  const wx = makeWx();
  const store = fresh(wx);
  const today = store.today();

  // 注入 200 篇日记（直接写 KV，模拟已有半年数据的老用户）
  const base = new Date(2026, 0, 1);
  for (let i = 0; i < 200; i += 1) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const key = dateKey(d);
    wx.setStorageSync('morning_diary_' + key, {
      date: key,
      base: { weather: '晴', anniversary: '', body: '不错', mood: '平静' },
      cells: { work: '今天推进了项目，也记下了一点想法。', money: '', health: '', relation: '',
        future: '', emotion: '', dream: '', growth: '', free: '' },
      workBoard: {}, moneyBook: {}, studyLog: {},
      template: 'standard', updatedAt: Date.now(),
    });
  }
  wx.setStorageSync('morning_started_at', '2026-01-01');

  // 第一次渲染：建立 memoAll / memoWritten / memoStats / memoFreq
  wx.resetCounters();
  renderPass(store, store.GRID_KEYS, today);
  const firstGet = wx.getCount();
  const firstInfo = wx.infoCount();

  // 第二次渲染：缓存命中，读放大应收敛到架构基线（≤30 次 kv:get）
  wx.resetCounters();
  renderPass(store, store.GRID_KEYS, today);
  const secondGet = wx.getCount();
  const secondInfo = wx.infoCount();

  // 写时失效：任一 kv:set 之后首次 all() 必须重新触发全量读
  store.save({ date: today, cells: { work: '刚写的一格' }, base: {} });
  wx.resetCounters();
  const allRes = store.all();
  const afterWriteGet = wx.getCount();
  const afterWriteInfo = wx.infoCount();

  const results = [];
  function assert(name, ok, detail) {
    results.push({ name: name, ok: ok });
    console.log((ok ? '[PASS] ' : '[FAIL] ') + name + '  → ' + detail);
  }

  console.log('=== 200 篇日记读放大基线（1rpx 无关，纯数据层） ===');
  assert('注入 200 篇日记', wx._map.size >= 201, 'KV 键数=' + wx._map.size);
  assert('第一次渲染触发全量读（预热 memo）', firstGet >= 200,
    'kv:get=' + firstGet + ' / getStorageInfoSync=' + firstInfo);
  assert('第二次渲染 kv:get ≤ 30（架构基线 24）', secondGet <= 30,
    'kv:get=' + secondGet + ' / getStorageInfoSync=' + secondInfo);
  assert('任一 kv:set 之后首次 all() 重新触发全量读', afterWriteGet >= 200 && !allRes.error,
    'kv:get=' + afterWriteGet + ' / getStorageInfoSync=' + afterWriteInfo + ' / all 条数=' + (allRes.data ? allRes.data.length : '?'));

  const failed = results.filter(function (r) { return !r.ok; });
  console.log('\n============================================================');
  console.log('bench 断言 ' + results.length + ' 条，通过 ' + (results.length - failed.length) + ' 条，失败 ' + failed.length + ' 条');
  console.log('关键数字：第一次 kv:get=' + firstGet + '，第二次 kv:get=' + secondGet
    + '，写后 all() kv:get=' + afterWriteGet);
  console.log('IS_PASS: ' + (failed.length ? 'NO' : 'YES'));
  console.log('============================================================');
  process.exitCode = failed.length ? 1 : 0;
}

main();
