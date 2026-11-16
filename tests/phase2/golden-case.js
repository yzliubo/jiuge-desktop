'use strict';
// Phase 2 回归套件（golden-case）：纯 Node 可跑，无第三方依赖
// 对应 docs/04-质量保障方案.md §2 门禁 / §4 数据迁移专项 / §5 性能 / §8 CI
// 用法：node tests/phase2/golden-case.js [--only=migrate|bench]
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.join(os.tmpdir(), 'jiuge-phase2-' + Date.now());
const coreDir = path.resolve(__dirname, '../../src/core');
const utilsDir = path.resolve(__dirname, '../../src/utils');
const diaryPath = path.join(utilsDir, 'diary-store.js');

const contract = require(path.join(coreDir, 'contract.js'));
const { createJournal } = require(path.join(coreDir, 'journal.js'));
const persistence = require(path.join(coreDir, 'persistence.js'));
const { createRepository } = require(path.join(coreDir, 'repository.js'));
const { createMigrator } = require(path.join(coreDir, 'migrate.js'));
const { createLifecycle } = require(path.join(coreDir, 'lifecycle.js'));
const { createApiLayer } = require(path.join(coreDir, 'api-layer.js'));
const { createRecycle } = require(path.join(coreDir, 'recycle.js'));
const v13 = require(path.resolve(__dirname, '../../src/v13/board.js'));
const modSearch = require(path.resolve(__dirname, '../../src/search/query.js'));
const modTags = require(path.resolve(__dirname, '../../src/tags/board.js'));
const modRecur = require(path.resolve(__dirname, '../../src/recur/board.js'));
const modRelation = require(path.resolve(__dirname, '../../src/relation/board.js'));
const modReview = require(path.resolve(__dirname, '../../src/review/term.js'));
const modCross = require(path.resolve(__dirname, '../../src/review/cross.js'));
const modTrace = require(path.resolve(__dirname, '../../src/trace/board.js'));
const modVault = require(path.resolve(__dirname, '../../src/secure/vault.js'));
const modAttach = require(path.resolve(__dirname, '../../src/attach/links.js'));
const modGtd = require(path.resolve(__dirname, '../../src/gtd/board.js'));
const modReading = require(path.resolve(__dirname, '../../src/reading/board.js'));
const modEpub = require(path.resolve(__dirname, '../../src/reading/epub.js'));
const modReaderSource = require(path.resolve(__dirname, '../../src/reading/reader-source.js'));
const modWorktime = require(path.resolve(__dirname, '../../src/worktime/board.js'));
const modFinance = require(path.resolve(__dirname, '../../src/finance/board.js'));
const modFamily = require(path.resolve(__dirname, '../../src/family/board.js'));
const workAgg = require(path.resolve(__dirname, '../../src/worktime/aggregate.js'));
const workClient = require(path.resolve(__dirname, '../../src/worktime/client.js'));

const only = (process.argv.find(function (a) { return a.indexOf('--only=') === 0; }) || '').slice(7);
let passed = 0;
let failed = 0;
const failures = [];

function fresh(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function test(tag, name, fn) {
  if (only && tag !== only) return;
  try {
    fn();
    passed++;
    console.log('  PASS  [' + tag + '] ' + name);
  } catch (e) {
    failed++;
    failures.push({ tag: tag, name: name, error: e.message });
    console.log('  FAIL  [' + tag + '] ' + name + ' :: ' + e.message);
  }
}

function makeRepo(dir) {
  const journal = createJournal(dir);
  const repo = createRepository({ dir: dir, journal: journal, originWindowId: 'test' });
  repo.load();
  return { dir: dir, journal: journal, repo: repo };
}

// 8 utils 不改动一行：主进程注入 global.wx 适配器后重新 require
function freshDiary(adapter) {
  global.wx = adapter;
  ['diary-store.js', 'work-board.js', 'money-book.js', 'study-log.js'].forEach(function (f) {
    try { delete require.cache[require.resolve(path.join(utilsDir, f))]; } catch (e) { /* noop */ }
  });
  return require(diaryPath);
}

function makeRecord(diary, date, text) {
  const rec = diary.emptyRecord(date);
  rec.cells[diary.GRID_KEYS[0]] = text;
  return rec;
}

function pad(n) { return n < 10 ? '0' + n : String(n); }
function dateAt(offset) {
  const d = new Date(2016, 0, 1 + offset);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

console.log('Phase 2 golden-case | workdir: ' + ROOT);
console.log('');

// ---------- L1 契约 ----------
test('contract', '统一响应结构与错误码', function () {
  assert.strictEqual(contract.ok({ a: 1 }).code, 'OK');
  assert.strictEqual(contract.fail('READ_ONLY').code, 'READ_ONLY');
  assert.strictEqual(contract.contentHash({ b: 2, a: 1 }), contract.contentHash({ a: 1, b: 2 }));
});

test('contract', '分页默认 50 / 上限 200 / cursor 正确', function () {
  const items = Array.from({ length: 260 }, function (_, i) { return i; });
  const p1 = contract.paginate(items, 0, 50);
  assert.strictEqual(p1.items.length, 50);
  assert.strictEqual(p1.cursor, '50');
  assert.strictEqual(p1.total, 260);
  const p2 = contract.paginate(items, 0, 9999);
  assert.strictEqual(p2.pageSize, 200);
  assert.strictEqual(p2.items.length, 200);
  const p3 = contract.paginate(items, 250, 50);
  assert.strictEqual(p3.items.length, 10);
  assert.strictEqual(p3.cursor, null);
});

test('contract', '幂等去重 TTL/LRU 容器', function () {
  const idem = contract.createIdempotency({ max: 2 });
  assert.strictEqual(idem.check('r1'), null);
  idem.remember('r1', { revision: 1 });
  assert.strictEqual(idem.check('r1').revision, 1);
  idem.remember('r2', { revision: 2 });
  idem.remember('r3', { revision: 3 });
  assert.strictEqual(idem.size(), 2);
});

// ---------- L2 journal / 原子写 ----------
test('journal', 'append + fsync 后 pending 可读，checkpoint 后清空', function () {
  const dir = fresh('journal');
  const j = createJournal(dir);
  const r1 = j.append({ op: 'set', key: 'k1', value: { v: 1 } });
  j.append({ op: 'set', key: 'k2', value: { v: 2 } });
  assert.strictEqual(r1.seq, 1);
  assert.strictEqual(j.pending().length, 2);
  j.checkpoint(1);
  assert.strictEqual(j.pending().length, 1);
  assert.strictEqual(j.pending()[0].key, 'k2');
  j.checkpoint();
  assert.strictEqual(j.pending().length, 0);
  j.close();
});

test('persistence', '原子写无 tmp 残留 / BOM 容错 / .bak 与快照', function () {
  const dir = fresh('persistence');
  const file = path.join(dir, 'store.json');
  const res = persistence.atomicWriteJson(file, { schemaVersion: 2, entries: { a: 1 } });
  assert(res.bytes > 0);
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  assert.strictEqual(persistence.readJsonSafe(file).entries.a, 1);
  fs.writeFileSync(file, '\uFEFF' + fs.readFileSync(file, 'utf8'), 'utf8');
  assert.strictEqual(persistence.readJsonSafe(file).entries.a, 1);
  assert.strictEqual(persistence.writeBak(file), true);
  assert.strictEqual(fs.existsSync(file + '.bak'), true);
  const snap = persistence.createSnapshot(dir, 'pre-import', { reason: 'test' });
  assert(fs.existsSync(path.join(snap.dir, 'meta.json')));
  assert(persistence.listSnapshots(dir).length >= 1);
  assert.strictEqual(persistence.restoreSnapshot(dir, snap.id), true);
});

// ---------- L2 repository ----------
test('repo', 'set/get/keys/flush/load 往返', function () {
  const ctx = makeRepo(fresh('repo-roundtrip'));
  ctx.repo.set('morning_diary_2026-11-08', { date: '2026-11-08', cells: {} });
  assert.strictEqual(ctx.repo.get('morning_diary_2026-11-08').date, '2026-11-08');
  assert(ctx.repo.keys().indexOf('morning_diary_2026-11-08') >= 0);
  const f = ctx.repo.flush('test');
  assert.strictEqual(f.flushed, true);
  assert.strictEqual(ctx.repo.isDirty(), false);
  const ctx2 = makeRepo(ctx.dir);
  assert.strictEqual(ctx2.repo.get('morning_diary_2026-11-08').date, '2026-11-08');
  ctx.journal.close();
  ctx2.journal.close();
});

test('repo', '强杀恢复：未 flush 的写入经 journal 回放不丢', function () {
  const dir = fresh('repo-crash');
  const j1 = createJournal(dir);
  const r1 = createRepository({ dir: dir, journal: j1 });
  r1.load();
  r1.set('morning_diary_2026-11-08', { date: '2026-11-08', cells: { work: '未落盘的草稿' } });
  r1.set('morning_diary_2026-11-09', { date: '2026-11-09', cells: { work: '第二篇' } });
  assert.strictEqual(fs.existsSync(path.join(dir, 'store.json')), false);
  j1.close();
  // 模拟 taskkill /F：重新打开，不调用 flush
  const j2 = createJournal(dir);
  const r2 = createRepository({ dir: dir, journal: j2 });
  const loaded = r2.load();
  assert.strictEqual(loaded.replayed, 2);
  assert.strictEqual(r2.get('morning_diary_2026-11-08').cells.work, '未落盘的草稿');
  assert.strictEqual(r2.get('morning_diary_2026-11-09').cells.work, '第二篇');
  j2.close();
});

test('repo', '幂等写：同 requestId 只产生一条 journal', function () {
  const ctx = makeRepo(fresh('repo-idempotent'));
  const before = ctx.journal.seq;
  ctx.repo.set('k', { v: 1 }, { requestId: 'req-1' });
  ctx.repo.set('k', { v: 2 }, { requestId: 'req-1' });
  assert.strictEqual(ctx.journal.seq, before + 1);
  assert.strictEqual(ctx.repo.get('k').v, 1);
  ctx.journal.close();
});

test('repo', '按 key 精确失效：changedKeys 只含被改键', function () {
  const ctx = makeRepo(fresh('repo-invalidate'));
  const events = [];
  ctx.repo.onChange(function (e) { events.push(e); });
  ctx.repo.set('a', 1);
  ctx.repo.set('b', 2);
  assert.deepStrictEqual(events.map(function (e) { return e.keys; }), [['a'], ['b']]);
  assert.deepStrictEqual(ctx.repo.getBatch(['a', 'b', 'missing']), { a: 1, b: 2 });
  ctx.journal.close();
});

test('repo', '只读模式拒绝写入', function () {
  const ctx = makeRepo(fresh('repo-readonly'));
  ctx.repo.setReadOnly(true);
  assert.throws(function () { ctx.repo.set('a', 1); }, function (e) { return e.code === 'READ_ONLY'; });
  ctx.repo.setReadOnly(false);
  ctx.repo.set('a', 1);
  assert.strictEqual(ctx.repo.get('a'), 1);
  ctx.journal.close();
});

// ---------- StoragePort：8 utils 零改动接入 ----------
test('utils', '注入 global.wx 后 diary-store 保存/回读/列举正常（零改动）', function () {
  const ctx = makeRepo(fresh('utils-adapter'));
  const diary = freshDiary(ctx.repo.createWxAdapter());
  const rec = makeRecord(diary, '2026-11-08', '桌面版第一篇');
  const saved = diary.save(rec);
  assert(!saved.error, 'save 返回错误: ' + JSON.stringify(saved));
  assert(ctx.repo.has('morning_diary_2026-11-08'));
  const dates = diary.listDates();
  assert(!dates.error);
  assert(dates.data.indexOf('2026-11-08') >= 0);
  const loaded = diary.load('2026-11-08');
  assert(!loaded.error);
  assert.strictEqual(loaded.data.cells[diary.GRID_KEYS[0]], '桌面版第一篇');
  ctx.journal.close();
});

test('utils', '命名空间隔离：UI 状态键不污染 listDates', function () {
  const ctx = makeRepo(fresh('utils-namespace'));
  ctx.repo.set('__window_state', { x: 1 });
  ctx.repo.set('morning_diary_ui_state', { x: 2 });
  const diary = freshDiary(ctx.repo.createWxAdapter());
  const rec = makeRecord(diary, '2026-11-08', 'x');
  diary.save(rec);
  const dates = diary.listDates();
  assert.deepStrictEqual(dates.data, ['2026-11-08']);
  assert(ctx.repo.keys().indexOf('__window_state') < 0);
  ctx.journal.close();
});

test('utils', 'v7 导出可被 importBackup 直读（旧端兼容）', function () {
  const src = makeRepo(fresh('utils-export'));
  const d1 = freshDiary(src.repo.createWxAdapter());
  d1.save(makeRecord(d1, '2026-11-08', '备份内容'));
  const exp = d1.exportBackup();
  assert(!exp.error);
  const parsed = JSON.parse(exp.data);
  assert.strictEqual(parsed.version, 7);
  assert.strictEqual(parsed.app, 'jiuge-notes');
  assert(parsed.records.length >= 1);

  const dst = makeRepo(fresh('utils-import'));
  const d2 = freshDiary(dst.repo.createWxAdapter());
  const imp = d2.importBackup(exp.data);
  assert(!imp.error, 'importBackup 返回错误: ' + JSON.stringify(imp));
  // 返回结构为 ok({...}) 即 { data: { imported, skipped, ... }, error: null }
  const report = imp.data || imp;
  assert(report.imported >= 1, '应导入至少一篇真实正文: ' + JSON.stringify(imp));
  assert.strictEqual(report.sourceVersion, 7);
  assert(dst.repo.has('morning_diary_2026-11-08'));
  src.journal.close();
  dst.journal.close();
});

test('utils', 'v6 / 无版本旧档 / 非法 JSON / 无 records 四条兼容路径', function () {
  const v6 = { version: 6, records: [] };
  const legacy = { records: [] };
  const cases = [
    { text: JSON.stringify(v6), expect: 'ok' },
    { text: JSON.stringify(legacy), expect: 'ok' },
    { text: '{not-json', expect: 'INVALID_JSON' },
    { text: JSON.stringify({ version: 7 }), expect: 'INVALID_FORMAT' }
  ];
  cases.forEach(function (c, i) {
    const ctx = makeRepo(fresh('utils-fixture-' + i));
    const diary = freshDiary(ctx.repo.createWxAdapter());
    const r = diary.importBackup(c.text);
    if (c.expect === 'ok') assert(!r.error, 'case ' + i + ' 不应报错');
    else assert.strictEqual(r.error, c.expect, 'case ' + i);
    ctx.journal.close();
  });
});

// ---------- 迁移六道安全网 ----------
function legacyFixture(dir, raw) {
  const file = path.join(dir, 'legacy-input.json');
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  return file;
}

test('migrate', '六道安全网：orig / 预检 / raw_kv / 双跑 / manifest / 提交', function () {
  const dir = fresh('migrate-full');
  const raw = {
    morning_started_at: '2024-01-01',
    morning_template: 'standard',
    'morning_diary_2026-11-08': { date: '2026-11-08', cells: { work: '迁移内容' }, base: {} },
    'morning_diary_2026-11-07': { date: '2026-11-07', cells: { work: '第二篇' }, base: {} },
    'morning_review_week_2026-W45': { answers: {} },
    __future_app_key__: { keep: true }
  };
  const legacyPath = legacyFixture(dir, raw);
  const dataDir = path.join(dir, 'jiuge-data');
  const ctx = makeRepo(dataDir);
  const migrator = createMigrator({ legacyPath: legacyPath, dataDir: dataDir, repository: ctx.repo });

  // 1 只读锚点
  const p = migrator.prepare();
  assert(p.bytes > 0 && p.sha256.length === 64);
  assert(fs.existsSync(migrator.origPath));
  // 2 预检
  const parsed = migrator.readLegacy();
  const pre = migrator.precheck(parsed.raw);
  assert.strictEqual(pre.ok, true, JSON.stringify(pre.problems));
  assert.strictEqual(pre.stats.diary, 2);
  assert.strictEqual(pre.stats.unknown, 1);
  // 3 未知键 raw_kv
  const mapped = migrator.map(parsed.raw);
  assert.strictEqual(mapped.rawKv.__future_app_key__.keep, true);
  // 4 只读双跑逐键一致
  const dual = migrator.dualRun(parsed.raw, mapped);
  assert.strictEqual(dual.consistent, true);
  assert.strictEqual(dual.compared, 5);
  // 5+6 提交与 manifest
  const result = migrator.run();
  assert(result.ok, JSON.stringify(result));
  assert.strictEqual(result.manifest.schemaVersion, 2);
  assert.strictEqual(result.manifest.migrationComplete, true);
  assert.strictEqual(result.manifest.sourceSha256, p.sha256);
  assert.strictEqual(result.flush.flushed, true);
  assert(fs.existsSync(migrator.manifestPath));
  assert.strictEqual(ctx.repo.get('morning_diary_2026-11-08').cells.work, '迁移内容');
  assert.strictEqual(ctx.repo.get('__raw_kv').__future_app_key__.keep, true);
  assert.strictEqual(migrator.verify().consistent, true);
  ctx.journal.close();
});

test('migrate', '脏数据预检拒绝：不写入、返回 MIGRATION_FAILED', function () {
  const dir = fresh('migrate-dirty');
  const raw = {
    'morning_diary_2026-11-08': { date: '2026-11-99', cells: {} },
    morning_diary_bad: 'not-an-object'
  };
  const legacyPath = legacyFixture(dir, raw);
  const dataDir = path.join(dir, 'jiuge-data');
  const ctx = makeRepo(dataDir);
  const migrator = createMigrator({ legacyPath: legacyPath, dataDir: dataDir, repository: ctx.repo });
  // 键名 morning_diary_bad 不匹配日期正则 -> 被判 unknown，不触发结构问题；
  // 用合法日期键但记录非对象来触发
  const raw2 = { 'morning_diary_2026-11-08': 'not-an-object' };
  fs.writeFileSync(legacyPath, JSON.stringify(raw2), 'utf8');
  const result = migrator.run();
  assert.strictEqual(result.error, 'MIGRATION_FAILED');
  assert.strictEqual(result.readOnly, true);
  assert.strictEqual(ctx.repo.keys().length, 0, '预检失败不得写入任何键');
  ctx.journal.close();
});

test('migrate', '回滚：未导出 v7 拒绝；导出后 orig 复原且数据目录重命名不删除', function () {
  const dir = fresh('migrate-rollback');
  const legacyPath = legacyFixture(dir, {
    'morning_diary_2026-11-08': { date: '2026-11-08', cells: { work: '原始数据' }, base: {} }
  });
  const dataDir = path.join(dir, 'jiuge-data');
  const ctx = makeRepo(dataDir);
  const migrator = createMigrator({ legacyPath: legacyPath, dataDir: dataDir, repository: ctx.repo });
  assert(migrator.run().ok);
  ctx.journal.close();
  const denied = migrator.rollback({});
  assert.strictEqual(denied.error, 'BACKUP_REQUIRED');
  const rb = migrator.rollback({ v7BackupWritten: true });
  assert.strictEqual(rb.ok, true);
  assert(fs.existsSync(legacyPath));
  assert.strictEqual(JSON.parse(fs.readFileSync(legacyPath, 'utf8'))['morning_diary_2026-11-08'].cells.work, '原始数据');
  assert(fs.existsSync(rb.archived), '数据目录必须重命名归档，不能删除');
  ctx.journal.close();
});

// ---------- lifecycle ----------
test('lifecycle', '五处 flush 兜底注册 + dirty 判断 + 单实例锁', function () {
  const ctx = makeRepo(fresh('lifecycle'));
  const lc = createLifecycle(ctx.repo);
  const registered = [];
  const hooks = {};
  ['onBeforeQuit', 'onWindowAllClosed', 'onPowerShutdown', 'onPowerSuspend', 'onProcessExit'].forEach(function (k) {
    hooks[k] = function (fn) { registered.push(fn); };
  });
  const installed = lc.installFlushGuards(hooks);
  assert.strictEqual(installed.length, 5);
  assert.strictEqual(registered.length, 5);
  assert.strictEqual(lc.flush('idle').flushed, false);
  ctx.repo.set('k', 1);
  assert.strictEqual(lc.flush('before-quit').flushed, true);
  assert.strictEqual(ctx.repo.isDirty(), false);
  assert.strictEqual(lc.requestSingleInstanceLock({ requestSingleInstanceLock: function () { return true; } }).granted, true);
  assert.throws(function () {
    lc.requestSingleInstanceLock({ requestSingleInstanceLock: function () { return false; } });
  }, function (e) { return e.code === 'SECOND_INSTANCE'; });
  ctx.journal.close();
});

// ---------- v1 本地 API ----------
test('api', 'v1 路由：分页 / 批量 / 幂等 upsert / 未知通道 / Electron 注册', function () {
  const ctx = makeRepo(fresh('api-layer'));
  const lc = createLifecycle(ctx.repo);
  const api = createApiLayer({ repository: ctx.repo, lifecycle: lc });
  ['2026-11-08', '2026-11-07', '2026-11-06'].forEach(function (d) {
    ctx.repo.set('morning_diary_' + d, { date: d, cells: {} });
  });
  const list = api.handle('v1/diaries:list', { pageSize: 2 });
  assert.strictEqual(list.code, 'OK');
  assert.strictEqual(list.data.items.length, 2);
  assert.strictEqual(list.data.total, 3);
  assert.strictEqual(list.data.cursor, '2');
  const batch = api.handle('v1/diaries:getBatch', { dates: ['2026-11-08', '2026-11-07'] });
  assert.strictEqual(Object.keys(batch.data.records).length, 2);
  const u1 = api.handle('v1/diaries:upsert', { record: { date: '2026-11-08', cells: { work: 'A' } }, requestId: 'req-1' });
  const u2 = api.handle('v1/diaries:upsert', { record: { date: '2026-11-08', cells: { work: 'B' } }, requestId: 'req-1' });
  assert.strictEqual(u1.data.revision, u2.data.revision, '同 requestId 必须幂等');
  assert.strictEqual(ctx.repo.get('morning_diary_2026-11-08').cells.work, 'A');
  const bad = api.handle('v1/unknown:action');
  assert.strictEqual(bad.code, 'CLIENT_EXCEPTION');
  const fakeIpc = { handlers: {}, handle: function (n, fn) { this.handlers[n] = fn; } };
  const names = api.register(fakeIpc);
  assert(names.length >= 7);
  assert.strictEqual(Object.keys(fakeIpc.handlers).length, names.length);
  ctx.journal.close();
});

// ---------- bench 三档（纯 Node 内存层，非 GUI 基线） ----------
test('bench', '200 / 1000 / 3650 篇冷启动 + all() 实测（推算须校准）', function () {
  const rows = [];
  [200, 1000, 3650].forEach(function (n) {
    const dir = fresh('bench-' + n);
    const entries = {};
    for (let i = 0; i < n; i++) {
      const date = dateAt(i);
      entries['morning_diary_' + date] = {
        date: date,
        base: { weather: '', anniversary: '', body: '', mood: '' },
        cells: { work: '第' + i + '篇正文', money: '', health: '', relation: '', future: '', emotion: '', dream: '', growth: '', free: '' },
        workBoard: {}, moneyBook: {}, studyLog: {},
        template: 'standard', updatedAt: 0
      };
    }
    persistence.atomicWriteJson(path.join(dir, 'store.json'), { schemaVersion: 2, revision: 0, entries: entries });
    const journal = createJournal(dir);
    const repo = createRepository({ dir: dir, journal: journal });
    repo.load();
    const diary = freshDiary(repo.createWxAdapter());
    const t0 = performance.now();
    const all = diary.all();
    const ms = performance.now() - t0;
    assert(!all.error);
    assert.strictEqual(all.data.length, n);
    rows.push({ n: n, ms: Math.round(ms * 100) / 100, count: all.data.length });
    journal.close();
  });
  console.log('        bench(实测/纯 Node 内存层): ' + JSON.stringify(rows));
});

// ---------- GTD 工作台（独立模块，数据存 md_gtd，不动 8 个 utils） ----------
const gtdBoard = require(path.resolve(__dirname, '../../src/gtd/board.js'));
const dreamBoard = require(path.resolve(__dirname, '../../src/dream/board.js'));

test('gtd', '捕获默认进收件箱；厘清后可归入下一步 / 等待 / 日程 / 将来', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '改图纸 #现场' });
  assert.strictEqual(s.tasks[0].status, 'inbox');
  const id = s.tasks[0].id;
  s = gtdBoard.clarify(s, id, 'next', { context: '@电脑' });
  assert.strictEqual(s.tasks[0].status, 'next');
  assert.strictEqual(s.tasks[0].context, '@电脑');
  s = gtdBoard.clarify(s, id, 'waiting', { waitingFor: '王工回复变更单' });
  assert.strictEqual(s.tasks[0].status, 'waiting');
  assert.strictEqual(s.tasks[0].waitingFor, '王工回复变更单');
  s = gtdBoard.clarify(s, id, 'scheduled', { dueDate: '2026-11-10' });
  assert.strictEqual(s.tasks[0].dueDate, '2026-11-10');
  s = gtdBoard.clarify(s, id, 'someday', {});
  assert.strictEqual(s.tasks[0].status, 'someday');
  // 非法去向必须报错，不能静默塞进某一组
  let threw = false;
  try { gtdBoard.clarify(s, id, 'done-ish', {}); } catch (e) { threw = true; assert.strictEqual(e.code, 'GTD_BAD_STATUS'); }
  assert(threw, '非法厘清去向未报错');
});

test('gtd', '等待缺「等谁」与日程缺日期会被点名，不静默通过', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'A' });
  s = gtdBoard.addTask(s, { title: 'B' });
  s = gtdBoard.clarify(s, s.tasks[0].id, 'waiting', {});
  s = gtdBoard.clarify(s, s.tasks[1].id, 'scheduled', {});
  const b = gtdBoard.board(s, '2026-11-08');
  assert.strictEqual(b.stats.waitingNoWho, 1);
  assert.strictEqual(b.stats.scheduledNoDate, 1);
  const r = gtdBoard.weeklyReview(s, '2026-11-08');
  assert.strictEqual(r.passed, 3, '周回顾不该把缺字段的两项判为通过');
});

test('gtd', '项目停滞判定：有未完成却没有下一步', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '写验收报告', project: '二期验收', status: 'scheduled' });
  let b = gtdBoard.board(s, '2026-11-08');
  assert.strictEqual(b.projects[0].stalled, true);
  assert.strictEqual(b.stats.stalledProjects, 1);
  s = gtdBoard.addTask(s, { title: '约甲方开会', project: '二期验收', status: 'next', context: '@电话' });
  b = gtdBoard.board(s, '2026-11-08');
  assert.strictEqual(b.projects[0].stalled, false);
  assert.strictEqual(b.projects[0].next, 1);
});

test('gtd', '完成任务只保留 7 天，不无限堆叠', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '收尾' });
  s = gtdBoard.complete(s, s.tasks[0].id);
  assert.strictEqual(s.tasks[0].status, 'done');
  assert(s.tasks[0].doneAt > 0, '完成未写 doneAt');
  const inWindow = gtdBoard.board(s, gtdBoard.todayOf(new Date()));
  assert.strictEqual(inWindow.groups.done.length, 1);
  const later = new Date(Date.now() + 10 * 86400000);
  const outWindow = gtdBoard.board(s, gtdBoard.todayOf(later));
  assert.strictEqual(outWindow.groups.done.length, 0, '超过 7 天的完成项应移出视图');
});

test('gtd', '旧日记 workBoard 任务可一次性收进 GTD，且重复执行幂等', function () {
  const records = [
    { date: '2026-11-06', workBoard: { tasks: [{ id: 't1', text: '老任务A', done: false }, { id: 't2', text: '老任务B', done: true }] } },
    { date: '2026-11-07', workBoard: { tasks: [{ id: 't3', text: '老任务C', done: false }] } }
  ];
  const first = gtdBoard.importLegacy(gtdBoard.empty(), records);
  assert.strictEqual(first.added, 3);
  assert.strictEqual(first.state.tasks.filter(function (t) { return t.status === 'inbox'; }).length, 2);
  assert.strictEqual(first.state.tasks.filter(function (t) { return t.status === 'done'; }).length, 1);
  const second = gtdBoard.importLegacy(first.state, records);
  assert.strictEqual(second.added, 0, '重复迁移不该重复入池');
  assert.strictEqual(second.skipped, 3);
});

test('gtd', '备份 gtd 段合并只补不改：同 id 不覆盖本机', function () {
  let local = gtdBoard.empty();
  local = gtdBoard.addTask(local, { title: '本机任务' });
  const localId = local.tasks[0].id;
  const incoming = {
    tasks: [
      { id: localId, title: '外部同名 id（应被忽略）', status: 'inbox' },
      { id: 'x_1', title: '外部新任务', status: 'next' }
    ],
    projects: [{ id: 'p1', name: '外部项目' }],
    reviews: [{ weekKey: '2026-W45', at: 1, inbox: 2 }]
  };
  const merged = gtdBoard.mergeSection(local, incoming);
  assert.strictEqual(merged.added, 1);
  assert.strictEqual(merged.state.tasks.length, 2);
  assert.strictEqual(merged.state.tasks[0].title, '本机任务', '导入覆盖了本机任务');
  assert.strictEqual(merged.state.projects.length, 1);
  assert.strictEqual(merged.state.reviews.length, 1);
});

test('gtd', '周键口径：周一为起点，跨周会变', function () {
  assert.strictEqual(gtdBoard.weekKeyOf('2026-11-02'), gtdBoard.weekKeyOf('2026-11-08'));
  assert.notStrictEqual(gtdBoard.weekKeyOf('2026-11-08'), gtdBoard.weekKeyOf('2026-11-09'));
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'X' });
  const marked = gtdBoard.markReviewed(s, '2026-11-08');
  assert.strictEqual(marked.reviews.length, 1);
  assert.strictEqual(marked.reviews[0].weekKey, gtdBoard.weekKeyOf('2026-11-08'));
  // 同一周重复记录只保留一条，不刷屏
  const again = gtdBoard.markReviewed(marked, '2026-11-06');
  assert.strictEqual(again.reviews.length, 1);
});

test('gtd', 'normalize 剔除脏数据：空标题丢弃、非法状态回落到下一步、非法日期清空', function () {
  const s = gtdBoard.normalize({
    tasks: [
      { id: 'a', title: '   ' },
      { id: 'a', title: '重复 id 应重发', status: 'bogus', dueDate: '2026/11/10' },
      { id: 'b', title: '合法', status: 'scheduled', dueDate: '2026-11-10', context: '这是一个超过十二个字的超长上下文' }
    ]
  });
  assert.strictEqual(s.tasks.length, 2, '空标题未剔除');
  assert.notStrictEqual(s.tasks[0].id, s.tasks[1].id, '重复 id 未重发');
  assert.strictEqual(s.tasks[0].status, 'next', '非法状态未回落');
  assert.strictEqual(s.tasks[0].dueDate, '', '非法日期未清空');
  assert.strictEqual(s.tasks[1].dueDate, '2026-11-10');
  assert(s.tasks[1].context.length <= gtdBoard.CONTEXT_MAX, '上下文超长未截断');
});

// ---- 项目 / 情境：用户自己维护名单，改名与删除必须连带任务 ----
test('gtd', '情境名单：新建 / 改名 / 删除都落到任务上，normalize 后不丢', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'A', context: '@电脑' });
  assert.deepStrictEqual(gtdBoard.board(s, '2026-11-09').contexts.map(function (c) { return c.name; }).slice(0, 6),
    gtdBoard.CONTEXTS, '派生模式应先给内置六个');

  s = gtdBoard.contextAdd(s, '@车库');
  let names = gtdBoard.board(s, '2026-11-09').contexts.map(function (c) { return c.name; });
  assert(names.indexOf('@车库') >= 0, '新建的情境没出现在分栏');
  // 一条任务都没挂也要留着，否则「刚建就消失」
  assert.strictEqual(gtdBoard.board(s, '2026-11-09').contexts.filter(function (c) { return c.name === '@车库'; })[0].open, 0);

  s = gtdBoard.contextRename(s, '@电脑', '@PC');
  assert.strictEqual(s.tasks[0].context, '@PC', '改名没有连带任务');
  names = gtdBoard.board(s, '2026-11-09').contexts.map(function (c) { return c.name; });
  assert(names.indexOf('@电脑') < 0 && names.indexOf('@PC') >= 0, '旧名字还在分栏里');

  s = gtdBoard.contextRemove(s, '@PC');
  assert.strictEqual(s.tasks[0].context, '', '删情境没清掉任务上的标签');
  assert(gtdBoard.board(s, '2026-11-09').contexts.every(function (c) { return c.name !== '@PC'; }), '删完又被任务派生回来了');

  // 写盘再读：名单不能丢（丢了就退回派生模式，用户建的全没了）
  const reread = gtdBoard.normalize(JSON.parse(JSON.stringify(s)));
  assert.strictEqual(reread.contexts.length, s.contexts.length, 'normalize 把情境名单丢了');
});

test('gtd', '项目归档：从列表与选择器退场，但任务和历史都留着', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'A', project: '装修' });
  s = gtdBoard.projectAdd(s, '空项目');
  assert.strictEqual(gtdBoard.board(s, '2026-11-09').projects.length, 2, '空项目没进列表');

  s = gtdBoard.projectArchive(s, '装修', true);
  let b = gtdBoard.board(s, '2026-11-09');
  assert(b.projects.every(function (p) { return p.name !== '装修'; }), '归档后还在项目列表');
  assert.strictEqual(b.archivedProjects.length, 1, '归档项目没有单独的出口');
  assert.strictEqual(s.tasks.length, 1, '归档把任务删了');
  assert.strictEqual(s.tasks[0].project, '装修', '归档把任务上的项目清掉了');

  // 改名照旧作用于任务；删除才清归属
  s = gtdBoard.projectRename(s, '装修', '装修二期');
  assert.strictEqual(s.tasks[0].project, '装修二期');
  s = gtdBoard.projectRemove(s, '装修二期');
  assert.strictEqual(s.tasks[0].project, '', '删项目该把任务的归属清掉');
  assert.strictEqual(s.tasks.length, 1, '删项目不该删任务');

  // 同名再建 = 从归档里捞回来，不是并存两个
  s = gtdBoard.projectArchive(s, '空项目', true);
  s = gtdBoard.projectAdd(s, '空项目');
  assert.strictEqual(s.projects.filter(function (p) { return p.name === '空项目'; }).length, 1, '同名项目建出了两份');
  assert.strictEqual(s.projects[0].archived, false, '同名再建没有取消归档');
});

// 软删挂在 StoragePort 上（diary-store 读数据只有这一条路），
// 所以封存后 all / stats / search / 导出正文全部自动干净，不需要改一行 utils。
function makeRecycle(dir) {
  const journal = createJournal(dir);
  const ctx = { dir: dir, journal: journal };
  let recycle = null;
  const repo = createRepository({
    dir: dir,
    journal: journal,
    originWindowId: 'test',
    isHidden: function (k) { return recycle ? recycle.isHidden(k) : false; }
  });
  ctx.loaded = repo.load();
  ctx.repo = repo;
  recycle = createRecycle({
    repository: repo,
    // 与主进程同款：封存/还原后必须重载 diary-store，否则 memo 还返回旧结果
    onChanged: function () { ctx.diary = freshDiary(repo.createWxAdapter()); }
  });
  ctx.recycle = recycle;
  ctx.diary = freshDiary(repo.createWxAdapter());
  return ctx;
}

function seedThree(ctx) {
  ['2026-11-06', '2026-11-07', '2026-11-08'].forEach(function (d) {
    const rec = ctx.diary.emptyRecord(d);
    rec.cells[ctx.diary.GRID_KEYS[0]] = d + ' 写的内容';
    ctx.diary.save(rec);
  });
}

test('recycle', '封存后 all / stats / search 全部看不见这一篇', function () {
  const ctx = makeRecycle(fresh('bin-hide'));
  seedThree(ctx);
  assert.strictEqual(ctx.diary.all().data.length, 3);
  ctx.recycle.seal('2026-11-07');
  const dates = ctx.diary.all().data.map(function (r) { return r.date; });
  assert.strictEqual(dates.length, 2, '封存后仍能读到: ' + dates.join(','));
  assert(dates.indexOf('2026-11-07') < 0, '被封存的日期仍出现在 all 里');
  assert.strictEqual(ctx.diary.stats().data.total, 2, 'stats 未跟着隐藏');
  assert.strictEqual(ctx.diary.search('写的内容').data.length, 2, 'search 未跟着隐藏');
  ctx.journal.close();
});

test('recycle', '封存状态持久化：重启后依然隐藏（含适配器键过滤）', function () {
  const dir = fresh('bin-persist');
  const a = makeRecycle(dir);
  seedThree(a);
  a.recycle.seal('2026-11-07');
  a.repo.flush('test');
  a.journal.close();

  const b = makeRecycle(dir);
  const dates = b.diary.all().data.map(function (r) { return r.date; });
  assert.strictEqual(dates.length, 2, '重启后封存失效: ' + dates.join(','));
  assert.strictEqual(b.recycle.list().total, 1, '封存箱丢失');
  assert.strictEqual(b.repo.createWxAdapter().getStorageSync('morning_diary_2026-11-07'), '', '适配器未隐藏封存键');
  const keys = b.repo.createWxAdapter().getStorageInfoSync().keys;
  assert(keys.indexOf('morning_diary_2026-11-07') < 0, 'keys 视图仍含封存键');
  b.journal.close();
});

test('recycle', '还原后重新出现在时间轴', function () {
  const ctx = makeRecycle(fresh('bin-restore'));
  seedThree(ctx);
  ctx.recycle.seal('2026-11-07');
  assert.strictEqual(ctx.recycle.restore('2026-11-07').ok, true);
  const dates = ctx.diary.all().data.map(function (x) { return x.date; });
  assert(dates.indexOf('2026-11-07') >= 0, '还原后仍读不到');
  assert.strictEqual(ctx.recycle.list().total, 0);
  ctx.journal.close();
});

test('recycle', '彻底删除真的移除键；未封存的不能直接 purge', function () {
  const ctx = makeRecycle(fresh('bin-purge'));
  seedThree(ctx);
  assert.strictEqual(ctx.recycle.purge('2026-11-06').error, 'NOT_IN_BIN', '未封存也能彻底删');
  ctx.recycle.seal('2026-11-06');
  assert.strictEqual(ctx.recycle.purge('2026-11-06').ok, true);
  assert.strictEqual(ctx.repo.has('morning_diary_2026-11-06'), false, '键未被移除');
  assert.strictEqual(ctx.recycle.list().total, 0);
  ctx.journal.close();
});

test('recycle', '超过 30 天自动焚毁，未到期的不动', function () {
  const ctx = makeRecycle(fresh('bin-sweep'));
  seedThree(ctx);
  ctx.recycle.seal('2026-11-06');
  const bin = ctx.repo.get('__bin');
  bin['morning_diary_2026-11-06'].sealedAt = Date.now() - 40 * 86400000;
  ctx.repo.set('__bin', bin);
  assert.strictEqual(ctx.recycle.sweep().burned, 1);
  assert.strictEqual(ctx.repo.has('morning_diary_2026-11-06'), false);
  ctx.recycle.seal('2026-11-07');
  assert.strictEqual(ctx.recycle.sweep().burned, 0, '未到期被误焚');
  assert.strictEqual(ctx.recycle.list().total, 1);
  ctx.journal.close();
});

test('recycle', '正文导出不含已封存记录（删掉的不混进给人看的备份）', function () {
  const ctx = makeRecycle(fresh('bin-export'));
  seedThree(ctx);
  ctx.recycle.seal('2026-11-07');
  const exp = ctx.diary.exportBackup();
  const obj = JSON.parse(exp.data);
  const recDates = (obj.records || []).map(function (r) { return r.date; });
  assert.strictEqual(recDates.length, 2, '导出的 records 含已封存篇目: ' + recDates.join(','));
  assert(recDates.indexOf('2026-11-07') < 0);
  ctx.journal.close();
});

test('recycle', '备份 bin 段带完整原文，跨机恢复后封存箱还在且仍是封存态', function () {
  const src = makeRecycle(fresh('bin-backup-src'));
  seedThree(src);
  src.recycle.seal('2026-11-07');
  const section = src.recycle.snapshotForBackup();
  assert(section.entries['morning_diary_2026-11-07'], '备份段缺条目');
  assert(section.entries['morning_diary_2026-11-07'].record, '备份段没带原文，换机后无法还原');
  src.journal.close();

  const dst = makeRecycle(fresh('bin-backup-dst'));
  assert.strictEqual(dst.recycle.mergeFromBackup(section).added, 1);
  assert.strictEqual(dst.recycle.list().total, 1, '恢复后封存箱是空的');
  assert.strictEqual(dst.diary.all().data.length, 0, '恢复出来不该直接出现在时间轴');
  dst.recycle.restore('2026-11-07');
  assert.strictEqual(dst.diary.all().data.length, 1);
  dst.journal.close();
});

test('recycle', '重复封存幂等，不重置 30 天计时', function () {
  const ctx = makeRecycle(fresh('bin-idem'));
  seedThree(ctx);
  ctx.recycle.seal('2026-11-07');
  const first = ctx.repo.get('__bin')['morning_diary_2026-11-07'].sealedAt;
  assert.strictEqual(ctx.recycle.seal('2026-11-07').already, true);
  assert.strictEqual(ctx.repo.get('__bin')['morning_diary_2026-11-07'].sealedAt, first, '重复封存把倒计时清零了');
  ctx.journal.close();
});

test('gtd', 'waitingSince 进入等待时写入、编辑不重置、离开等待清零', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '等甲方回复' });
  const id = s.tasks[0].id;
  s = gtdBoard.clarify(s, id, 'waiting', { waitingFor: '甲方' });
  assert(s.tasks[0].waitingSince > 0, '进入等待时未记录起点');
  const since = s.tasks[0].waitingSince;
  s = gtdBoard.updateTask(s, id, { note: '催过一次' });
  assert.strictEqual(s.tasks[0].waitingSince, since, '编辑后等待计时被清零');
  s = gtdBoard.clarify(s, id, 'next', {});
  assert.strictEqual(s.tasks[0].waitingSince, 0, '离开等待后未清零');
});

// ---------- 子任务树：父是容器，子才是能动手的那一步 ----------
test('gtd', '挂子项：父得到 2/2 计数，子项继承父的项目与上下文', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '装修房子', status: 'next', context: '@家', project: '家装' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '给工长打电话', status: 'next', parentId: pid });
  s = gtdBoard.addTask(s, { title: '定橱柜', status: 'next', parentId: pid });

  assert.strictEqual(s.tasks[1].parentId, pid);
  assert.strictEqual(s.tasks[1].context, '@家', '子项没继承上下文');
  assert.strictEqual(s.tasks[1].project, '家装', '子项没继承项目');

  const b = gtdBoard.board(s, '2026-11-08');
  const parent = b.groups.next.filter(function (t) { return t.id === pid; })[0];
  assert.strictEqual(parent.childTotal, 2);
  assert.strictEqual(parent.childDone, 0);
  assert.strictEqual(parent.openChildren, 2);
  assert.strictEqual(parent.container, true, '有未完成子项的父没被标成容器');
});

test('gtd', '容器不算可执行下一步：leafNext 只数叶子，insight 明说容器数', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '装修房子', status: 'next' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '给工长打电话', status: 'next', parentId: pid });
  s = gtdBoard.addTask(s, { title: '量尺寸', status: 'next', parentId: pid });

  const b = gtdBoard.board(s, '2026-11-08');
  assert.strictEqual(b.stats.next, 3, '下一步总数应含父与子');
  assert.strictEqual(b.stats.leafNext, 2, '叶子数不对（容器被算成可执行项了）');
  assert.strictEqual(b.stats.containerNext, 1);
  assert.strictEqual(b.stats.parents, 1);
  assert(b.insight.indexOf('容器') >= 0, 'insight 没说明有几条是容器：' + b.insight);

  // 子项全部完成 → 父不再是容器，自己也回到可执行
  s = gtdBoard.complete(s, s.tasks[1].id);
  s = gtdBoard.complete(s, s.tasks[2].id);
  const b2 = gtdBoard.board(s, '2026-11-08');
  const parent = b2.groups.next.filter(function (t) { return t.id === pid; })[0];
  assert.strictEqual(parent.container, false, '子项都完成后父仍是容器');
  assert.strictEqual(b2.stats.leafNext, 1);
  assert.strictEqual(b2.stats.containerNext, 0);
});

test('gtd', '两层封顶：给子项再挂子会被压到同一层，绝不产生第三层', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '装修房子', status: 'next' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '给工长打电话', status: 'next', parentId: pid });
  const kid = s.tasks[1].id;
  s = gtdBoard.addTask(s, { title: '量尺寸', status: 'next', parentId: kid });

  assert.strictEqual(s.tasks[2].parentId, pid, '三层请求没有并到祖父那一层');
  const twoLevel = s.tasks.every(function (t) {
    if (!t.parentId) return true;
    const up = s.tasks.filter(function (x) { return x.id === t.parentId; })[0];
    return !!up && !up.parentId;
  });
  assert(twoLevel, '出现了三层');

  // 旧数据里已有的三层，normalize 也要压平，且任务不丢
  const legacy = {
    tasks: [
      { id: 'a', title: 'A', status: 'next' },
      { id: 'b', title: 'B', status: 'next', parentId: 'a' },
      { id: 'c', title: 'C', status: 'next', parentId: 'b' },
      { id: 'd', title: 'D', status: 'next', parentId: 'c' }
    ]
  };
  const n = gtdBoard.normalize(legacy);
  assert.strictEqual(n.tasks.length, 4, '压平过程中丢了任务');
  assert.strictEqual(n.tasks.filter(function (t) { return t.id === 'd'; })[0].parentId, 'a');
});

test('gtd', '环与断链一律回到顶层，不会卡死也不会挂到不存在的父上', function () {
  // 旧数据里的三层：C 压到祖父 A 那一层（不是丢掉）
  const threeLevel = gtdBoard.normalize({
    tasks: [
      { id: 'a', title: 'A', status: 'next' },
      { id: 'b', title: 'B', status: 'next', parentId: 'a' },
      { id: 'c', title: 'C', status: 'next', parentId: 'b' }
    ]
  });
  assert.strictEqual(threeLevel.tasks[2].parentId, 'a', '三层没压到祖父那一层');

  // 真成环（X↔Y）：两条都回到顶层，不能互相当父
  const ring = gtdBoard.normalize({
    tasks: [
      { id: 'x', title: 'X', status: 'next', parentId: 'y' },
      { id: 'y', title: 'Y', status: 'next', parentId: 'x' }
    ]
  });
  assert.strictEqual(ring.tasks[0].parentId, '', '环 A 侧没断开');
  assert.strictEqual(ring.tasks[1].parentId, '', '环 B 侧没断开');

  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'A', status: 'next' });
  s = gtdBoard.addTask(s, { title: 'B', status: 'next', parentId: s.tasks[0].id });
  const a = s.tasks[0].id;
  const bId = s.tasks[1].id;
  s = gtdBoard.updateTask(s, a, { parentId: bId });
  const afterA = s.tasks.filter(function (t) { return t.id === a; })[0];
  const afterB = s.tasks.filter(function (t) { return t.id === bId; })[0];
  assert.strictEqual(afterA.parentId, '', 'A 挂到自己的子项下了（成环）');
  assert.strictEqual(afterB.parentId, a, 'B 的父被动了');

  // 父 id 不存在 → 当普通任务，不制造孤儿
  const orphan = gtdBoard.addTask(s, { title: 'C', status: 'next', parentId: 'not-exist' });
  assert.strictEqual(orphan.tasks[orphan.tasks.length - 1].parentId, '');
});

test('gtd', '有子项的父任务不能再被挂到别人下面（否则立刻三层）', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '甲', status: 'next' });
  s = gtdBoard.addTask(s, { title: '乙', status: 'next' });
  const jia = s.tasks[0].id;
  const yi = s.tasks[1].id;
  s = gtdBoard.addTask(s, { title: '甲的子项', status: 'next', parentId: jia });
  s = gtdBoard.updateTask(s, jia, { parentId: yi });
  assert.strictEqual(s.tasks.filter(function (t) { return t.id === jia; })[0].parentId, '', '父任务被挂进另一条下面了');
});

test('gtd', '删除父任务只上抬子项，绝不连带删掉真实待办', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '装修房子', status: 'next', project: '家装' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '给工长打电话', status: 'next', parentId: pid });
  s = gtdBoard.addTask(s, { title: '定橱柜', status: 'next', parentId: pid });

  const r = gtdBoard.removeTask(s, pid);
  assert.strictEqual(r.tasks.length, 2, '删父时把子项一起删了');
  assert(r.tasks.every(function (t) { return t.parentId === ''; }), '子项没有上抬成顶层');
  assert(r.tasks.every(function (t) { return t.project === '家装'; }), '上抬后项目丢了');
});

test('gtd', '完成父任务：先查子项数，completeAll 连未完成子项一起收', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '装修房子', status: 'next' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '给工长打电话', status: 'next', parentId: pid });
  s = gtdBoard.addTask(s, { title: '定橱柜', status: 'next', parentId: pid });
  s = gtdBoard.complete(s, s.tasks[1].id);

  const info = gtdBoard.completionInfo(s, pid);
  assert.strictEqual(info.total, 2);
  assert.strictEqual(info.done, 1);
  assert.strictEqual(info.open, 1, '子项未完成数不对');

  const done = gtdBoard.completeAll(s, pid);
  const statuses = done.tasks.map(function (t) { return t.status; });
  assert(statuses.every(function (x) { return x === 'done'; }), 'completeAll 没把父与全部子项收掉：' + statuses.join(','));
  assert.strictEqual(gtdBoard.completionInfo(done, pid).open, 0);

  // 不存在的 id 不该炸
  assert.strictEqual(gtdBoard.completionInfo(done, 'nope').found, false);
});

test('gtd', '一个父最多 30 个子项，超出的上浮为顶层（不清空数据）', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '大父', status: 'next' });
  const pid = s.tasks[0].id;
  for (let i = 0; i < 32; i++) {
    s = gtdBoard.addTask(s, { title: '子 ' + i, status: 'next', parentId: pid });
  }
  const kids = s.tasks.filter(function (t) { return t.parentId === pid; });
  assert.strictEqual(kids.length, gtdBoard.MAX_CHILDREN, '子项没有封顶');
  assert.strictEqual(s.tasks.length, 33, '超限的子项被删掉了');
});

test('gtd', 'normalize 幂等：反复读写不会让父子关系漂移', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '父', status: 'next' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '子', status: 'next', parentId: pid });
  const once = gtdBoard.normalize(s);
  const twice = gtdBoard.normalize(once);
  const mapA = once.tasks.map(function (t) { return t.id + '>' + t.parentId; }).join('|');
  const mapB = twice.tasks.map(function (t) { return t.id + '>' + t.parentId; }).join('|');
  assert.strictEqual(mapA, mapB, '两次 normalize 结果不一致');
});

test('gtd', '跨机恢复：父子都导入时关系保留，只导入子项时不挂空父', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '父', status: 'next' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '子', status: 'next', parentId: pid });

  let dst = gtdBoard.empty();
  const m = gtdBoard.mergeSection(dst, s);
  assert.strictEqual(m.state.tasks.filter(function (t) { return t.parentId === pid; }).length, 1, '合并后父子关系丢了');

  // 只有子项（父不在备份里）→ 子项回到顶层，不指向不存在的 id
  const onlyKid = { tasks: [s.tasks[1]] };
  const r = gtdBoard.mergeSection(gtdBoard.empty(), onlyKid);
  assert.strictEqual(r.state.tasks[0].parentId, '', '子项指向了不存在的父');
});

test('gtd', '项目行的下一步只数叶子：只剩容器时项目算停滞', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '装修房子', status: 'next', project: '家装' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '给工长打电话', status: 'next', parentId: pid });

  let p = gtdBoard.projectRollup(s).filter(function (x) { return x.name === '家装'; })[0];
  assert.strictEqual(p.open, 2);
  assert.strictEqual(p.next, 1, '项目里的下一步把容器也算进去了');
  assert.strictEqual(p.stalled, false);

  // 唯一的叶子挪去等待：项目只剩容器，没有任何能动手的下一步 → 判停滞
  s = gtdBoard.updateTask(s, s.tasks[1].id, { status: 'waiting', waitingFor: '工长' });
  p = gtdBoard.projectRollup(s).filter(function (x) { return x.name === '家装'; })[0];
  assert.strictEqual(p.next, 0);
  assert.strictEqual(p.stalled, true, '只剩容器时项目没判停滞，项目会显得推得动');
});

// ---------- 今日六点：只存指针、只给可执行、跨天不结转 ----------
test('gtd', '六点只收指针：任务改名跟着变，任务删了自动消失', function () {
  const today = '2026-11-08';
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '改图纸', status: 'next' });
  const id = s.tasks[0].id;
  s = gtdBoard.toggleFocus(s, today, id, 'work');
  let f = gtdBoard.focusOf(s, today);
  assert.strictEqual(f.count, 1);
  assert.strictEqual(f.items[0].cell, 'work');

  // 改名：六点里那条跟着变，说明存的是指针不是快照
  s = gtdBoard.updateTask(s, id, { title: '改图纸（含变更单）' });
  f = gtdBoard.focusOf(s, today);
  assert.strictEqual(f.items[0].title, '改图纸（含变更单）');

  // 删任务：焦点项一起消失，不留点不动的空行
  s = gtdBoard.removeTask(s, id);
  f = gtdBoard.focusOf(s, today);
  assert.strictEqual(f.count, 0, '任务删了，六点里还留着空壳');
  assert.strictEqual(gtdBoard.normalize(s).focus.items.length, 0, 'normalize 没清掉指向已删任务的焦点项');
});

test('gtd', '六点上限 6 条，第 7 条进不来也不报错', function () {
  const today = '2026-11-08';
  let s = gtdBoard.empty();
  for (let i = 0; i < 9; i++) s = gtdBoard.addTask(s, { title: 'T' + i, status: 'next' });
  for (let i = 0; i < 9; i++) s = gtdBoard.toggleFocus(s, today, s.tasks[i].id, '');
  assert.strictEqual(gtdBoard.focusOf(s, today).count, 6, '超过了六点上限');
});

test('gtd', '跨天不结转：昨天的六点今天算空，但说得出昨天挑了几件', function () {
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'A', status: 'next' });
  s = gtdBoard.addTask(s, { title: 'B', status: 'next' });
  s = gtdBoard.toggleFocus(s, '2026-11-08', s.tasks[0].id, '');
  s = gtdBoard.toggleFocus(s, '2026-11-08', s.tasks[1].id, '');

  const next = gtdBoard.focusOf(s, '2026-11-09');
  assert.strictEqual(next.count, 0, '昨天的六点被结转了');
  assert.strictEqual(next.stale, true);
  assert.strictEqual(next.staleCount, 2, '没记住昨天挑了几件');

  // 新的一天重新挑，不会把昨天的带过来
  s = gtdBoard.toggleFocus(s, '2026-11-09', s.tasks[1].id, '');
  const day2 = gtdBoard.focusOf(s, '2026-11-09');
  assert.strictEqual(day2.count, 1);
  assert.strictEqual(day2.items[0].title, 'B');
});

test('gtd', '候选只给可执行：容器不在里面，已在六点的不重复出现', function () {
  const today = '2026-11-08';
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: '装修房子', status: 'next' });
  const pid = s.tasks[0].id;
  s = gtdBoard.addTask(s, { title: '给工长打电话', status: 'next', parentId: pid });
  s = gtdBoard.addTask(s, { title: '约甲方', status: 'scheduled', dueDate: '2026-11-06' });

  const c1 = gtdBoard.focusCandidates(s, today);
  const titles = c1.items.map(function (x) { return x.title; });
  assert(titles.indexOf('装修房子') < 0, '容器进了候选（挑出来没法动手）');
  assert(titles.indexOf('给工长打电话') >= 0, '叶子下一步没进候选');
  assert(titles.indexOf('约甲方') >= 0, '逾期日程没进候选');
  assert.strictEqual(c1.items[0].title, '约甲方', '逾期项没有排在最前：' + c1.items[0].title);
  assert(c1.items[0].reason.indexOf('逾期') >= 0, '候选没说清为什么在列表里');

  // 已挑进六点的不再出现在候选里
  s = gtdBoard.toggleFocus(s, today, s.tasks[1].id, '');
  const c2 = gtdBoard.focusCandidates(s, today);
  const t2 = c2.items.map(function (x) { return x.title; });
  assert(t2.indexOf('给工长打电话') < 0, '已在六点的还出现在候选里');
});

test('gtd', 'setFocus 保序且过滤脏 id：调序不会把六点搞乱', function () {
  const today = '2026-11-08';
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'A', status: 'next' });
  s = gtdBoard.addTask(s, { title: 'B', status: 'next' });
  s = gtdBoard.addTask(s, { title: 'C', status: 'next' });
  const ids = s.tasks.map(function (t) { return t.id; });
  s = gtdBoard.setFocus(s, today, [ids[2], 'not-exist', ids[0], ids[0]]);
  const f = gtdBoard.focusOf(s, today);
  assert.deepStrictEqual(f.items.map(function (x) { return x.title; }), ['C', 'A'], 'setFocus 没保序或没过滤脏 id');
});

test('gtd', 'normalize 显式放行 focus：写进去读得出来，非法格归空', function () {
  const today = '2026-11-08';
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'A', status: 'next' });
  const id = s.tasks[0].id;
  s = gtdBoard.toggleFocus(s, today, id, 'not-a-cell');
  const back = gtdBoard.normalize(JSON.parse(JSON.stringify(s)));
  assert.strictEqual(back.focus.date, today, 'normalize 把 focus 丢了');
  assert.strictEqual(back.focus.items.length, 1);
  assert.strictEqual(back.focus.items[0].cell, '', '非法格没有被归空');

  // 幂等：两次 normalize 结果一致
  const twice = gtdBoard.normalize(back);
  assert.deepStrictEqual(twice.focus, back.focus);
});

test('gtd', '六点里的任务完成后仍留在六点，标成已完成', function () {
  const today = '2026-11-08';
  let s = gtdBoard.empty();
  s = gtdBoard.addTask(s, { title: 'A', status: 'next' });
  const id = s.tasks[0].id;
  s = gtdBoard.toggleFocus(s, today, id, 'health');
  s = gtdBoard.complete(s, id);
  const f = gtdBoard.focusOf(s, today);
  assert.strictEqual(f.count, 1, '完成后六点里那条被抹掉了（用户还想「→ 格」）');
  assert.strictEqual(f.doneCount, 1);
  assert.strictEqual(f.items[0].cell, 'health', '归属格丢了，→格不知道写哪');
});

// ---------- 梦想（原九格「梦想」格升成的一级目标板）----------
test('dream', '记一条目标：领域/期限白名单、非法日期丢弃、达成即满进度', function () {
  let s = dreamBoard.empty();
  s = dreamBoard.add(s, {
    title: '今年存下 8 万', area: 'career', horizon: 'short',
    dueDate: '2026-12-31', priority: 'high'
  });
  assert.strictEqual(s.dreams.length, 1);
  const d = s.dreams[0];
  assert.strictEqual(d.area, 'career');
  assert.strictEqual(d.horizon, 'short');
  assert.strictEqual(d.status, 'doing', '新目标应落在进行中');
  assert.strictEqual(d.progress, 0);

  // 脏值：领域/期限回落、日期非法直接丢（不编一个假日期）
  s = dreamBoard.add(s, { title: '学门手艺', area: 'nope', horizon: 'someday', startDate: '2026-13-40' });
  const bad = s.dreams[1];
  assert.strictEqual(bad.area, 'material');
  assert.strictEqual(bad.horizon, 'short');
  assert.strictEqual(bad.startDate, '');

  // 空标题不进列表
  const before = s.dreams.length;
  s = dreamBoard.add(s, { title: '   ' });
  assert.strictEqual(s.dreams.length, before, '空标题被写进去了');

  // 达成 → 进度补满：不能出现「已达成 60%」这种自相矛盾
  s = dreamBoard.update(s, s.dreams[0].id, { status: 'done', progress: 60 });
  assert.strictEqual(s.dreams.filter(function (x) { return x.id === d.id; })[0].progress, 100);
});

test('dream', '三档期限各自归类，统计与平均进度算在正确的桶里', function () {
  let s = dreamBoard.empty();
  s = dreamBoard.add(s, { title: 'A', horizon: 'short', progress: 100, status: 'done' });
  s = dreamBoard.add(s, { title: 'B', horizon: 'short', progress: 20 });
  s = dreamBoard.add(s, { title: 'C', horizon: 'mid', progress: 50 });
  s = dreamBoard.add(s, { title: 'D', horizon: 'long', progress: 0 });
  const b = dreamBoard.board(s, [], '2026-11-08');
  assert.strictEqual(b.stats.total, 4);
  assert.strictEqual(b.stats.byHorizon.short, 2);
  assert.strictEqual(b.stats.byHorizon.mid, 1);
  assert.strictEqual(b.stats.byHorizon.long, 1);
  assert.strictEqual(b.stats.achieved, 1);
  assert.strictEqual(b.stats.avgProgress, 43, '平均进度算错：' + b.stats.avgProgress);
  // 排序：短 → 中 → 长；已达成沉底
  assert.deepStrictEqual(b.rows.map(function (r) { return r.title; }), ['B', 'A', 'C', 'D']);
});

test('dream', '量化指标优先于手填进度：数字推着走，不靠感觉', function () {
  let s = dreamBoard.empty();
  s = dreamBoard.add(s, {
    title: '存款', progress: 99,
    metric: { name: '存款', unit: '万', from: 0, to: 8, current: 3 }
  });
  const row = dreamBoard.board(s, [], '2026-11-08').rows[0];
  assert.strictEqual(row.progress, 38, '有指标时没按数字算：' + row.progress);
  // 目标值等于起始值时无法推导，退回手填值，不除以零
  s = dreamBoard.update(s, s.dreams[0].id, { metric: { name: 'x', from: 5, to: 5, current: 5 }, progress: 42 });
  assert.strictEqual(dreamBoard.board(s, [], '2026-11-08').rows[0].progress, 42);
});

test('dream', '梦想账户：定价 / 存入 / 存够标记 ready，达成后不再算 ready', function () {
  let s = dreamBoard.empty();
  s = dreamBoard.add(s, { title: '换工作站', area: 'money' });
  const id = s.dreams[0].id;
  assert.strictEqual(dreamBoard.board(s, [], '2026-11-08').rows[0].fund, null, '没设账户时不该有账户');

  s = dreamBoard.setFund(s, id, 2000000);
  let row = dreamBoard.board(s, [], '2026-11-08').rows[0];
  assert.strictEqual(row.fund.target, 2000000);
  assert.strictEqual(row.fund.saved, 0);
  assert.strictEqual(row.fund.ready, false);

  s = dreamBoard.deposit(s, id, 800000, '2026-11-01', '第一次', 'money');
  s = dreamBoard.deposit(s, id, 1200000, '2026-11-08', '第二次', 'money');
  row = dreamBoard.board(s, [], '2026-11-08').rows[0];
  assert.strictEqual(row.fund.saved, 2000000);
  assert.strictEqual(row.fund.pct, 100);
  assert.strictEqual(row.fund.ready, true, '存够了却没标 ready');
  // 金额为 0 的存入不记账（避免刷一堆 0 元流水）
  const before = s.dreams[0].deposits.length;
  s = dreamBoard.deposit(s, id, 0, '2026-11-08', '零', 'money');
  assert.strictEqual(s.dreams[0].deposits.length, before);

  // 目标达成后 ready 归 false —— 提醒的依据是「钱够且事没完」
  s = dreamBoard.update(s, id, { status: 'done' });
  assert.strictEqual(dreamBoard.board(s, [], '2026-11-08').rows[0].fund.ready, false);
});

test('dream', 'alerts 只收「钱够 + 未达成」的目标，改完立刻反映', function () {
  let s = dreamBoard.empty();
  s = dreamBoard.add(s, { title: 'A' });
  const id = s.dreams[0].id;
  s = dreamBoard.setFund(s, id, 100000);
  assert.strictEqual(dreamBoard.board(s, [], '2026-11-08').alerts.length, 0);
  s = dreamBoard.deposit(s, id, 100000, '2026-11-08', '', 'money');
  const b = dreamBoard.board(s, [], '2026-11-08');
  assert.strictEqual(b.alerts.length, 1);
  assert.strictEqual(b.alerts[0].title, 'A');
  assert.strictEqual(b.alerts[0].saved, 100000);
  // 标记达成 → 提醒消失
  s = dreamBoard.update(s, id, { status: 'done' });
  assert.strictEqual(dreamBoard.board(s, [], '2026-11-08').alerts.length, 0);
});

test('dream', '关联行动：按 id 挂上任务，任务删了不冒空行，完成数对得上', function () {
  let s = dreamBoard.empty();
  s = dreamBoard.add(s, { title: '考出一建', area: 'growth' });
  const id = s.dreams[0].id;
  s = dreamBoard.linkTask(s, id, 't1');
  s = dreamBoard.linkTask(s, id, 't1');
  s = dreamBoard.linkTask(s, id, 't2');
  assert.strictEqual(s.dreams[0].taskIds.length, 2, '重复关联没去重');

  const tasks = [
    { id: 't1', status: 'done' },
    { id: 't2', status: 'next' }
  ];
  let row = dreamBoard.board(s, tasks, '2026-11-08').rows[0];
  assert.strictEqual(row.taskTotal, 2);
  assert.strictEqual(row.taskDone, 1);
  assert.strictEqual(row.taskOpen, 1);

  // 任务被删（GTD 里删了）→ 关联数下降，不抛错
  row = dreamBoard.board(s, [{ id: 't2', status: 'next' }], '2026-11-08').rows[0];
  assert.strictEqual(row.taskTotal, 1);

  s = dreamBoard.unlinkTask(s, id, 't2');
  assert.strictEqual(s.dreams[0].taskIds.length, 1);
});

test('dream', '超期识别与「还剩多久」的口径：过期的必须是过期', function () {
  let s = dreamBoard.empty();
  s = dreamBoard.add(s, { title: '过期', dueDate: '2026-06-01' });
  s = dreamBoard.add(s, { title: '还剩一个月', dueDate: '2026-12-01' });
  s = dreamBoard.add(s, { title: '远期', dueDate: '2031-12-31' });
  const b = dreamBoard.board(s, [], '2026-11-08');
  assert.strictEqual(b.stats.overdue, 1);
  const byTitle = {};
  b.rows.forEach(function (r) { byTitle[r.title] = r; });
  assert.strictEqual(byTitle['过期'].overdue, true);
  assert(/已超期/.test(byTitle['过期'].pace), byTitle['过期'].pace);
  assert(/剩 1 个月|剩 23 天/.test(byTitle['还剩一个月'].pace), byTitle['还剩一个月'].pace);
  assert(/年/.test(byTitle['远期'].pace), byTitle['远期'].pace);
  // 已达成的不算超期
  s = dreamBoard.update(s, s.dreams[0].id, { status: 'done' });
  assert.strictEqual(dreamBoard.board(s, [], '2026-11-08').stats.overdue, 0);
});

test('dream', 'normalize 幂等 + 上限 + 跨机合并去重', function () {
  let s = dreamBoard.empty();
  for (let i = 0; i < dreamBoard.MAX_DREAMS + 5; i++) {
    s = dreamBoard.add(s, { title: 'T' + i });
  }
  assert.strictEqual(s.dreams.length, dreamBoard.MAX_DREAMS, '没有裁到上限');
  const twice = dreamBoard.normalize(dreamBoard.normalize(s));
  assert.deepStrictEqual(twice.dreams[0], dreamBoard.normalize(s).dreams[0], 'normalize 不幂等');

  const mine = dreamBoard.add(dreamBoard.empty(), { title: '我这条' });
  const other = dreamBoard.add(dreamBoard.empty(), { title: '别人的' });
  const first = dreamBoard.mergeSection(mine, other);
  assert.strictEqual(first.added, 1);
  const again = dreamBoard.mergeSection(first.state, other);
  assert.strictEqual(again.added, 0, '重复导入把同一条又加了一遍');
});

// ---------- 学习成长：考试 / 技能 / 阅读（三张表，三种口径） ----------
const growthBoard = require(path.resolve(__dirname, '../../src/growth/board.js'));
const inspireLib = require(path.resolve(__dirname, '../../src/inspire/library.js'));

test('growth', '三张表互不干扰，统计各按各的单位算', function () {
  let s = growthBoard.empty();
  s = growthBoard.addExam(s, { title: '一建 · 市政' });
  s = growthBoard.addSkill(s, { title: 'Python' });
  s = growthBoard.addTheme(s, { title: '给排水规范' });
  assert.strictEqual(s.exams.length, 1);
  assert.strictEqual(s.skills.length, 1);
  assert.strictEqual(s.themes.length, 1);

  const b = growthBoard.board(s, '2026-11-09');
  assert.strictEqual(b.stats.total, 3);
  assert.strictEqual(b.stats.examTotal, 1);
  assert.strictEqual(b.stats.skillTotal, 1);
  assert.strictEqual(b.stats.themeTotal, 1);
  // 三种活动不该被折算成一个「总进度」
  assert.strictEqual(b.stats.pct, undefined);
});

test('growth', '考试：科目加权进度、阶段判定、倒计时', function () {
  let s = growthBoard.empty();
  s = growthBoard.addExam(s, { title: '一建', examDate: '2026-11-20' });
  const id = s.exams[0].id;
  s = growthBoard.addSubject(s, id, { title: '实务', total: 40 });
  s = growthBoard.addSubject(s, id, { title: '管理', total: 20 });
  const sub = s.exams[0].subjects[0].id;
  s = growthBoard.updateSubject(s, id, sub, { done: 10 }); // 25%
  // 两科平均：(25 + 0) / 2 = 13
  let row = growthBoard.board(s, '2026-11-09').exams[0];
  assert.strictEqual(row.pct, 13);
  assert.strictEqual(row.subjectDone, 0);
  assert.strictEqual(row.subjectCount, 2);
  assert.strictEqual(row.daysLeft, 11);
  assert.strictEqual(row.stage, 'sprint');
  assert(/距考试 11 天/.test(row.countdown));

  // 阶段：>90 打基础、30~89 强化、≤29 冲刺、0 今天、<0 已过
  function stageOf(day, today) {
    let x = growthBoard.empty();
    x = growthBoard.addExam(x, { title: 'T', examDate: day });
    return growthBoard.board(x, today).exams[0].stage;
  }
  assert.strictEqual(stageOf('2027-06-01', '2026-11-09'), 'base');
  assert.strictEqual(stageOf('2027-01-20', '2026-11-09'), 'build');
  assert.strictEqual(stageOf('2026-11-09', '2026-11-09'), 'today');
  assert.strictEqual(stageOf('2026-11-01', '2026-11-09'), 'past');
});

test('growth', '考试：报名逾期只在「备考中」时提醒，记了成绩才判通过', function () {
  let s = growthBoard.empty();
  s = growthBoard.addExam(s, { title: '一建', examDate: '2026-11-20', enrollDate: '2026-09-10' });
  const id = s.exams[0].id;
  let row = growthBoard.board(s, '2026-11-09').exams[0];
  assert.strictEqual(row.enrollMissed, true, '报名日已过 + 备考中，应该提醒');
  assert.strictEqual(growthBoard.board(s, '2026-11-09').stats.examEnrollMissed, 1);

  // 标成已报名 → 不再提醒
  s = growthBoard.updateExam(s, id, { status: 'registered' });
  assert.strictEqual(growthBoard.board(s, '2026-11-09').exams[0].enrollMissed, false);

  // 只填分数不填合格线：不作数
  s = growthBoard.setExamResult(s, id, 96, 0);
  assert.strictEqual(s.exams[0].status, 'registered');
  // 两个都填才判
  s = growthBoard.setExamResult(s, id, 96, 96);
  assert.strictEqual(s.exams[0].status, 'passed');
  assert(/已通过/.test(growthBoard.board(s, '2026-11-09').exams[0].resultText));
  // 通过后进度补满
  assert.strictEqual(growthBoard.board(s, '2026-11-09').exams[0].pct, 100);
});

test('growth', '考试：再来一次只清进度与日期，科目结构留着', function () {
  let s = growthBoard.empty();
  s = growthBoard.addExam(s, { title: '一建', examDate: '2026-11-01' });
  const id = s.exams[0].id;
  s = growthBoard.addSubject(s, id, { title: '实务', total: 40 });
  const sub = s.exams[0].subjects[0].id;
  s = growthBoard.updateSubject(s, id, sub, { done: 40 });
  s = growthBoard.setExamResult(s, id, 80, 96);
  assert.strictEqual(s.exams[0].status, 'failed');

  s = growthBoard.retakeExam(s, id);
  assert.strictEqual(s.exams[0].status, 'plan');
  assert.strictEqual(s.exams[0].examDate, '');
  assert.strictEqual(s.exams[0].score, 0);
  assert.strictEqual(s.exams[0].subjects.length, 1, '科目结构被清掉了');
  assert.strictEqual(s.exams[0].subjects[0].done, 0, '科目进度没归零');
});

test('growth', '技能：里程碑达成率、本周练习只算 7 天、同日合并', function () {
  let s = growthBoard.empty();
  s = growthBoard.addSkill(s, { title: 'Python' });
  const id = s.skills[0].id;
  s = growthBoard.addMilestone(s, id, '能独立写爬虫');
  s = growthBoard.addMilestone(s, id, '能读别人的项目');
  const ms = s.skills[0].milestones[0].id;
  s = growthBoard.toggleMilestone(s, id, ms);

  // 同一天三段练习合成一条
  s = growthBoard.addPractice(s, id, { date: '2026-11-08', minutes: 45 });
  s = growthBoard.addPractice(s, id, { date: '2026-11-08', minutes: 30 });
  // 窗口外的一天不算本周
  s = growthBoard.addPractice(s, id, { date: '2026-10-01', minutes: 60 });
  assert.strictEqual(s.skills[0].practices.filter(function (p) { return p.date === '2026-11-08'; }).length, 1);
  const day8 = s.skills[0].practices.filter(function (p) { return p.date === '2026-11-08'; })[0];
  assert.strictEqual(day8.minutes, 75, '同一天两笔没合并');

  const row = growthBoard.board(s, '2026-11-09').skills[0];
  assert.strictEqual(row.milestoneDone, 1);
  assert.strictEqual(row.milestonePct, 50);
  assert.strictEqual(row.weekMinutes, 75, '本周练习把窗口外的算进来了');
  assert.strictEqual(row.minutes, 135);
  assert.strictEqual(row.hoursText, '2.3');
  assert.strictEqual(row.levelText.indexOf('初识') > 0, true);
  assert.strictEqual(row.ready, false);
});

test('growth', '技能：里程碑全达成且没到目标等级 → 可升级', function () {
  let s = growthBoard.empty();
  s = growthBoard.addSkill(s, { title: 'Excel' });
  const id = s.skills[0].id;
  assert.strictEqual(s.skills[0].targetLevel, 2, '默认目标等级应是当前 +1');
  s = growthBoard.addMilestone(s, id, '能写透视表');
  const ms = s.skills[0].milestones[0].id;
  s = growthBoard.toggleMilestone(s, id, ms);
  let row = growthBoard.board(s, '2026-11-09').skills[0];
  assert.strictEqual(row.ready, true);
  assert.strictEqual(growthBoard.board(s, '2026-11-09').stats.skillReady, 1);
  assert(/可以升到/.test(growthBoard.board(s, '2026-11-09').alerts[0].text));

  // 调到目标等级后不再提示
  s = growthBoard.updateSkill(s, id, { level: 2 });
  assert.strictEqual(growthBoard.board(s, '2026-11-09').skills[0].ready, false);
  // 目标等级不允许低于当前
  s = growthBoard.updateSkill(s, id, { targetLevel: 1 });
  assert.strictEqual(s.skills[0].targetLevel, 2);
});

test('growth', '阅读：翻满自动读完并记日期，重读退回一格', function () {
  let s = growthBoard.empty();
  s = growthBoard.addTheme(s, { title: '给排水规范' });
  const th = s.themes[0].id;
  s = growthBoard.addBook(s, th, { title: '室外排水设计标准', total: 200 });
  const bk = s.themes[0].books[0].id;

  s = growthBoard.advanceBook(s, th, bk, 50);
  assert.strictEqual(s.themes[0].books[0].status, 'reading');
  assert.strictEqual(s.themes[0].books[0].done, 50);
  assert.strictEqual(s.themes[0].books[0].startedAt.length, 10);

  s = growthBoard.advanceBook(s, th, bk, 999);
  assert.strictEqual(s.themes[0].books[0].done, 200, '页数超过总页数');
  assert.strictEqual(s.themes[0].books[0].status, 'done');
  assert.strictEqual(s.themes[0].books[0].finishedAt.length, 10);

  // 读完再点「重读」：退回一格，不能停在 100% 又说在读
  s = growthBoard.setBookStatus(s, th, bk, 'reading');
  assert.strictEqual(s.themes[0].books[0].status, 'reading');
  assert.strictEqual(s.themes[0].books[0].done, 199);
  assert.strictEqual(s.themes[0].books[0].finishedAt, '');

  const row = growthBoard.board(s, '2026-11-09').themes[0];
  assert.strictEqual(row.bookTotal, 1);
  assert.strictEqual(row.bookDone, 0);
  assert.strictEqual(row.currentTitle, '室外排水设计标准');
});

test('growth', '阅读：摘录按书存，删书不误删同主题其他书', function () {
  let s = growthBoard.empty();
  s = growthBoard.addTheme(s, { title: '规范' });
  const th = s.themes[0].id;
  s = growthBoard.addBook(s, th, { title: 'A', total: 100 });
  s = growthBoard.addBook(s, th, { title: 'B', total: 100 });
  const a = s.themes[0].books[0].id;
  s = growthBoard.addQuote(s, th, a, { text: '雨水管渠设计重现期…', page: 12 });
  assert.strictEqual(s.themes[0].books[0].quotes.length, 1);
  assert.strictEqual(growthBoard.board(s, '2026-11-09').themes[0].quoteTotal, 1);

  s = growthBoard.removeBook(s, th, a);
  assert.strictEqual(s.themes[0].books.length, 1);
  assert.strictEqual(s.themes[0].books[0].title, 'B');
  assert.strictEqual(growthBoard.board(s, '2026-11-09').themes[0].quoteTotal, 0);
});

test('growth', '旧学习库导入：书/影/画进阅读、课进技能、按标题去重、幂等', function () {
  const legacy = {
    items: [
      { id: 'i1', kind: 'book', title: '设计心理学', total: 300, done: 120, unit: '页', topicId: 't1', finished: false },
      { id: 'i2', kind: 'book', title: '给水工程', total: 400, done: 400, unit: '页', topicId: '', finished: true },
      { id: 'i3', kind: 'movie', title: '寿司之神', total: 1, done: 1, unit: '集', topicId: 't1', finished: true },
      { id: 'i4', kind: 'course', title: '数据分析入门', total: 24, done: 24, unit: '讲', topicId: '', finished: true }
    ],
    topics: [{ id: 't1', title: '设计' }]
  };
  let s = growthBoard.empty();
  const first = growthBoard.importLegacy(s, legacy);
  s = first.state;
  assert.strictEqual(first.addedBooks, 3);
  assert.strictEqual(first.addedSkills, 1);
  assert.strictEqual(s.themes.length, 2, '有主题的进「设计」，没主题的进兜底主题');
  const design = s.themes.filter(function (t) { return t.title === '设计'; })[0];
  assert.strictEqual(design.books.length, 2);
  assert.strictEqual(design.books.filter(function (b) { return b.title === '设计心理学'; })[0].status, 'reading');
  assert.strictEqual(s.skills[0].title, '数据分析入门');

  // 再导一次不翻倍
  const again = growthBoard.importLegacy(s, legacy);
  assert.strictEqual(again.addedBooks, 0);
  assert.strictEqual(again.addedSkills, 0);
  assert.strictEqual(again.state.themes.length, 2);
});

// V3.9 练习反馈：技能卡点带年龄，考试错因只增不改
test('growth', 'V3.9 技能卡点：天数从开始日算、改文本才重置、清走进留档', function () {
  let s = growthBoard.empty();
  s = growthBoard.addSkill(s, { title: 'Python' });
  const id = s.skills[0].id;

  // 没卡点时不该凭空出现 0 天
  assert.strictEqual(growthBoard.board(s, '2026-11-15').skills[0].blockerDays, 0);
  assert.strictEqual(growthBoard.board(s, '2026-11-15').skills[0].stuck, false);

  s = growthBoard.setSkillBlocker(s, id, '看不懂 groupby 的返回结构', '2026-10-20');
  let row = growthBoard.board(s, '2026-11-15').skills[0];
  assert.strictEqual(row.blocker, '看不懂 groupby 的返回结构');
  assert.strictEqual(row.blockerDays, 27, '10-20 到 11-15 应是 26 天差、按「第 N 天」记 27');
  assert.strictEqual(row.stuck, true, '27 天该判「挂着」');
  assert.strictEqual(row.blockerText, '已卡 27 天');

  // 同一条文本重存不该把年龄清零——否则每次打开都变「今天才开始卡」
  s = growthBoard.setSkillBlocker(s, id, '看不懂 groupby 的返回结构', '2026-11-14');
  assert.strictEqual(growthBoard.board(s, '2026-11-15').skills[0].blockerDays, 27, '重存同一句把开始日重置了');

  // 当天记的算第 1 天，不写 0 天
  let fresh = growthBoard.empty();
  fresh = growthBoard.addSkill(fresh, { title: 'A' });
  fresh = growthBoard.setSkillBlocker(fresh, fresh.skills[0].id, '刚卡住', '2026-11-15');
  assert.strictEqual(growthBoard.board(fresh, '2026-11-15').skills[0].blockerDays, 1);

  // 阈值边界：10-20 起算，11-01 是第 13 天（不报警），11-02 是第 14 天（报警）
  assert.strictEqual(growthBoard.board(s, '2026-11-01').skills[0].blockerDays, 13);
  assert.strictEqual(growthBoard.board(s, '2026-11-01').skills[0].stuck, false, '13 天不该报警');
  assert.strictEqual(growthBoard.board(s, '2026-11-02').skills[0].stuck, true, '14 天该报警');

  // 清走：卡点清空、留档保住开始日与解决日
  s = growthBoard.clearSkillBlocker(s, id, '2026-11-16');
  row = growthBoard.board(s, '2026-11-16').skills[0];
  assert.strictEqual(row.blocker, '');
  assert.strictEqual(row.blockerDays, 0);
  assert.strictEqual(row.clearedCount, 1);
  assert.strictEqual(row.clearedRecent[0].text, '看不懂 groupby 的返回结构');
  assert.strictEqual(row.clearedRecent[0].since, '2026-10-20', '留档没保住开始日，就算不出「卡了多久才过」');
  assert.strictEqual(row.clearedRecent[0].clearedAt, '2026-11-16');

  // 空文本等价于清走（前端把人清空输入框当「已过去」处理，不该留个空白卡点）
  let empty2 = growthBoard.empty();
  empty2 = growthBoard.addSkill(empty2, { title: 'B' });
  const bid = empty2.skills[0].id;
  empty2 = growthBoard.setSkillBlocker(empty2, bid, '卡了', '2026-11-01');
  empty2 = growthBoard.setSkillBlocker(empty2, bid, '   ', '2026-11-05');
  assert.strictEqual(empty2.skills[0].blocker, '');
  assert.strictEqual(empty2.skills[0].cleared.length, 1, '清空文本该走留档，而不是留个空卡点');
});

test('growth', 'V3.9 技能：下次提高一点什么单独存，不进里程碑', function () {
  let s = growthBoard.empty();
  s = growthBoard.addSkill(s, { title: 'Python' });
  const id = s.skills[0].id;
  s = growthBoard.setSkillNextUp(s, id, '手写一遍三种聚合的差别');
  const row = growthBoard.board(s, '2026-11-15').skills[0];
  assert.strictEqual(row.nextUp, '手写一遍三种聚合的差别');
  assert.strictEqual(row.milestoneTotal, 0, '「下次提高」被当成里程碑了');
  // 超长裁剪到 60，不走 NOTE_MAX
  s = growthBoard.setSkillNextUp(s, id, 'x'.repeat(200));
  assert.strictEqual(s.skills[0].nextUp.length, 60);
});

test('growth', 'V3.9 考试错因：只增不改、重考不清历史、同日同分不重复', function () {
  let s = growthBoard.empty();
  s = growthBoard.addExam(s, { title: '一建', examDate: '2026-11-20' });
  const id = s.exams[0].id;

  // 未通过 + 错因
  s = growthBoard.setExamResult(s, id, 58, 60, ['calc', 'time'], '2026-09-20');
  let row = growthBoard.board(s, '2026-11-15').exams[0];
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.attemptCount, 1);
  assert.strictEqual(row.failCount, 1);
  assert.deepStrictEqual(row.lastFail.causesLabel, ['计算失误', '时间不够']);
  assert.strictEqual(row.lastFail.gap, -2, '差 2 分应以负数记，界面取绝对值');

  // 同日同分重存：只更新错因，不新增一次考试
  s = growthBoard.setExamResult(s, id, 58, 60, ['calc'], '2026-09-20');
  assert.strictEqual(growthBoard.board(s, '2026-11-15').exams[0].attemptCount, 1, '手滑点两下变成了考两次');
  assert.deepStrictEqual(growthBoard.board(s, '2026-11-15').exams[0].lastFail.causesLabel, ['计算失误']);

  // 重考：当前成绩清空，历史留住——这是重考唯一的方向感
  s = growthBoard.retakeExam(s, id);
  row = growthBoard.board(s, '2026-11-15').exams[0];
  assert.strictEqual(row.score, 0);
  assert.strictEqual(row.status, 'plan');
  assert.strictEqual(row.attemptCount, 1, '重考把历史成绩一起清了');
  assert.strictEqual(row.lastFail.score, 58);

  // 第二次没过：两条历史，错因跨次聚合
  s = growthBoard.setExamResult(s, id, 55, 60, ['calc'], '2027-09-19');
  row = growthBoard.board(s, '2027-09-20').exams[0];
  assert.strictEqual(row.attemptCount, 2);
  assert.strictEqual(row.failCount, 2);
  assert.strictEqual(row.causeTop[0].key, 'calc');
  assert.strictEqual(row.causeTop[0].count, 2, '两次都栽在计算，却没聚合出来');
  assert.strictEqual(row.lastFail.date, '2027-09-19', 'lastFail 不是最近一次');

  // 事后补记错因：只改最近一条，不动分数、不新增
  s = growthBoard.setExamCauses(s, id, ['concept', 'misread']);
  row = growthBoard.board(s, '2027-09-20').exams[0];
  assert.strictEqual(row.attemptCount, 2);
  assert.deepStrictEqual(row.lastFail.causesLabel, ['概念没懂', '审题偏差']);
  assert.strictEqual(row.lastFail.score, 55, '补记错因把分数改了');

  // 通过之后再重考：通过的那次也留在历史里
  s = growthBoard.setExamResult(s, id, 72, 60, [], '2028-09-18');
  s = growthBoard.retakeExam(s, id);
  row = growthBoard.board(s, '2028-09-19').exams[0];
  assert.strictEqual(row.attemptCount, 3);
  assert.strictEqual(row.failCount, 2, '通过的记录被算成未过了');
});

test('growth', 'V3.9 错因归类：非法 key 丢弃、最多 4 条、跨考试汇总', function () {
  let s = growthBoard.empty();
  s = growthBoard.addExam(s, { title: 'A' });
  s = growthBoard.addExam(s, { title: 'B' });
  const a = s.exams[0].id;
  const b = s.exams[1].id;
  s = growthBoard.setExamResult(s, a, 50, 60, ['calc', '瞎写', 'calc', 'time', 'concept', 'practice', 'state'], '2026-09-20');
  const row = growthBoard.board(s, '2026-11-15').exams.filter(function (e) { return e.id === a; })[0];
  assert.deepStrictEqual(row.attempts[0].causes, ['calc', 'time', 'concept', 'practice'], '非法 key 没丢 / 没截到 4 条 / 没去重');

  s = growthBoard.setExamResult(s, b, 40, 60, ['calc'], '2026-09-21');
  const board = growthBoard.board(s, '2026-11-15');
  assert.strictEqual(board.causeTop[0].key, 'calc');
  assert.strictEqual(board.causeTop[0].count, 2, '跨考试没汇总');
  assert.strictEqual(board.stats.examAttempts, 2);
  assert.strictEqual(board.stats.examFails, 2);

  // 没记过成绩就补错因：不报错、不凭空造一条作答
  let fresh = growthBoard.empty();
  fresh = growthBoard.addExam(fresh, { title: 'C' });
  const c = fresh.exams[0].id;
  const after = growthBoard.setExamCauses(fresh, c, ['calc']);
  assert.strictEqual(after.exams[0].attempts.length, 0, '没有作答却造出了一条历史');
});

test('growth', 'V3.9 兼容：老数据没有 attempts / blocker 也不炸，脏值丢弃', function () {
  // 老版本存的 md_growth：技能只有里程碑与练习、考试只有当前分数
  const legacy = {
    version: 1,
    exams: [{ id: 'ex1', title: '老考试', status: 'passed', score: 80, passLine: 60 }],
    skills: [{ id: 'sk1', title: '老技能', level: 2, milestones: [], practices: [] }],
    themes: []
  };
  const s = growthBoard.normalize(legacy);
  assert.strictEqual(s.exams[0].attempts.length, 0, '老数据被凭空补了历史');
  assert.strictEqual(s.skills[0].blocker, '');
  assert.strictEqual(s.skills[0].blockerSince, '');
  assert.strictEqual(s.skills[0].cleared.length, 0);
  assert.strictEqual(growthBoard.board(s, '2026-11-15').skills[0].blockerDays, 0);
  // 幂等：新字段反复 normalize 不漂移
  assert.deepStrictEqual(growthBoard.normalize(s).skills[0], s.skills[0]);

  // 脏 attempts：没有分数或合格线的那条要丢；causes 里的非字符串丢掉
  const dirty = growthBoard.normalize({
    exams: [{
      title: 'T', status: 'failed', score: 50, passLine: 60,
      attempts: [
        { score: 0, passLine: 0, causes: ['calc'] },
        { id: 'at1', date: '2026-09-20', score: 50, passLine: 60, causes: ['calc', null, 7] }
      ]
    }],
    skills: [{ title: 'K', blocker: '卡住', blockerSince: '2026-13-40', cleared: [{ text: '' }] }]
  });
  assert.strictEqual(dirty.exams[0].attempts.length, 1, '没有分数的那条没丢');
  assert.deepStrictEqual(dirty.exams[0].attempts[0].causes, ['calc']);
  assert.strictEqual(dirty.exams[0].attempts[0].passed, false);
  assert.strictEqual(dirty.skills[0].blockerSince, '', '非法日期没丢');
  assert.strictEqual(dirty.skills[0].cleared.length, 0, '空文本留档没被丢掉');

  // 有卡点但开始日非法：按「今天」兜底，不写 0 天
  assert.strictEqual(growthBoard.board(dirty, '2026-11-15').skills[0].blockerDays, 1);
});

test('growth', 'normalize：非法日期丢弃、超限裁剪、幂等、脏数据不抛', function () {
  let s = growthBoard.empty();
  s = growthBoard.addExam(s, { title: '一建' });
  const id = s.exams[0].id;
  s = growthBoard.updateExam(s, id, { examDate: '2026-13-40' });
  assert.strictEqual(s.exams[0].examDate, '', '2026-13-40 过正则但不是真日期，必须丢');
  s = growthBoard.updateExam(s, id, { examDate: '2026-11-20' });
  assert.strictEqual(s.exams[0].examDate, '2026-11-20');

  // 上限：技能超过 MAX_SKILLS
  let big = growthBoard.empty();
  for (let i = 0; i < growthBoard.MAX_SKILLS + 5; i++) big = growthBoard.addSkill(big, { title: 'S' + i });
  assert.strictEqual(big.skills.length, growthBoard.MAX_SKILLS);

  // 幂等：反复 normalize 不漂移
  const once = growthBoard.normalize(big);
  const twice = growthBoard.normalize(once);
  assert.deepStrictEqual(twice.skills[0], once.skills[0], 'normalize 不幂等');
  assert.strictEqual(twice.skills.length, once.skills.length);

  // 脏数据：字符串 / null / 缺字段都不该抛
  assert.strictEqual(growthBoard.normalize(null).exams.length, 0);
  assert.strictEqual(growthBoard.normalize({ exams: 'nope', skills: [null, 1, {}], themes: {} }).skills.length, 0);
  // 子项 done 不许超过 total
  let e = growthBoard.addExam(growthBoard.empty(), { title: 'T' });
  const eid = e.exams[0].id;
  e = growthBoard.addSubject(e, eid, { title: 'S', total: 10 });
  const sid = e.exams[0].subjects[0].id;
  e = growthBoard.updateSubject(e, eid, sid, { done: 999 });
  assert.strictEqual(e.exams[0].subjects[0].done, 10);
});

test('growth', '换机合并：只补不改、按 id 去重；排序把已考完的沉底', function () {
  const mine = growthBoard.addExam(growthBoard.empty(), { title: '我的', examDate: '2026-12-01' });
  const other = growthBoard.addExam(growthBoard.empty(), { title: '别人的', examDate: '2026-11-15' });
  const first = growthBoard.mergeSection(mine, other);
  assert.strictEqual(first.added, 1);
  const again = growthBoard.mergeSection(first.state, other);
  assert.strictEqual(again.added, 0, '重复导入把同一条又加了一遍');

  let s = growthBoard.empty();
  s = growthBoard.addExam(s, { title: '已考完', examDate: '2026-10-01' });
  s = growthBoard.addExam(s, { title: '下月', examDate: '2026-12-01' });
  s = growthBoard.addExam(s, { title: '没定日期' });
  const rows = growthBoard.board(s, '2026-11-09').exams;
  assert.strictEqual(rows[0].title, '下月', '有日期的应排在前面');
  assert.strictEqual(rows[rows.length - 1].title, '已考完', '考完的应沉底');
});

test('inspire', '内置三条齐全，且空状态不把 539 条名言复制进数据', function () {
  const s = inspireLib.empty();
  const st = inspireLib.stats(s);
  assert.strictEqual(st.quotes.builtin, 539, '名言内置数量不对：' + st.quotes.builtin);
  assert.strictEqual(st.greetings.builtin, 29, '问候语内置数量不对：' + st.greetings.builtin);
  assert.strictEqual(st.moves.builtin, 43, '运动提示内置数量不对：' + st.moves.builtin);
  // 空状态只装三样空容器：一旦有人把内置正文塞进来，这段会立刻变成几十 KB
  const bytes = Buffer.byteLength(JSON.stringify(s), 'utf8');
  assert(bytes < 400, '空状态体积异常（疑似把内置正文复制进库）：' + bytes);
});

test('inspire', '今日三条：同一天同一时段稳定，换一组会变', function () {
  const s = inspireLib.empty();
  const a = inspireLib.today(s, { now: new Date(2026, 10, 9, 9, 10) });
  const b = inspireLib.today(s, { now: new Date(2026, 10, 9, 9, 55) });
  assert.strictEqual(a.quote.id, b.quote.id, '同一天同一时段的名言不稳定');
  assert.strictEqual(a.greeting.text, b.greeting.text, '同一天同一时段的问候不稳定');
  assert(a.greeting.text.length > 2 && a.greeting.hint.length > 2, '问候 / 运动提示为空');
  assert.strictEqual(a.dateKey, '2026-11-09');

  const c = inspireLib.today(s, { now: new Date(2026, 10, 9, 9, 10), offset: 1 });
  assert.notStrictEqual(c.quote.id, a.quote.id, '换一组名言没变');
  assert.notStrictEqual(c.greeting.text, a.greeting.text, '换一组问候没变');
});

test('inspire', '删内置只记 hidden、可还原；原文一个字没动', function () {
  let s = inspireLib.empty();
  const first = inspireLib.list(s, 'greetings').items[0];
  s = inspireLib.remove(s, 'greetings', first.id);
  assert.strictEqual(inspireLib.stats(s).greetings.hidden, 1);
  assert.strictEqual(inspireLib.list(s, 'greetings').items[0].enabled, false, '删了还启用');
  assert.strictEqual(inspireLib.list(s, 'greetings').items[0].text, first.text, '内置原文被改动了');

  s = inspireLib.restore(s, 'greetings', first.id);
  assert.strictEqual(inspireLib.stats(s).greetings.hidden, 0);
  assert.strictEqual(inspireLib.list(s, 'greetings').items[0].enabled, true, '还原没生效');
});

test('inspire', '改内置走覆盖、可退回原句；改回原文不留覆盖', function () {
  let s = inspireLib.empty();
  const q = inspireLib.list(s, 'quotes').items[0];
  s = inspireLib.update(s, 'quotes', q.id, { text: '改过的句子', author: '某人' });
  assert.strictEqual(inspireLib.list(s, 'quotes').items[0].text, '改过的句子');
  assert.strictEqual(inspireLib.stats(s).quotes.overridden, 1);
  assert.strictEqual(inspireLib.list(s, 'quotes').items[0].builtin, true, '改完就不是内置了？');

  s = inspireLib.revert(s, 'quotes', q.id);
  assert.strictEqual(inspireLib.list(s, 'quotes').items[0].text, q.text, '撤销修改没退回原句');
  assert.strictEqual(inspireLib.stats(s).quotes.overridden, 0);

  // 改成与原文相同 → 覆盖记录应自动消失，不留下无意义的补丁
  s = inspireLib.update(s, 'quotes', q.id, { text: q.text, author: q.author });
  assert.strictEqual(inspireLib.stats(s).quotes.overridden, 0, '改回原文仍留着覆盖记录');
});

test('inspire', '恢复默认只清隐藏与覆盖，「我的」一条不动；整类删空仍有兜底', function () {
  let s = inspireLib.empty();
  s = inspireLib.add(s, 'quotes', { text: '我自己的一句', author: '我' });
  s = inspireLib.add(s, 'moves', { text: '起来走两步', period: 'any' });
  const q0 = inspireLib.list(s, 'quotes').items[0];
  s = inspireLib.update(s, 'quotes', q0.id, { text: '被我改过' });
  s = inspireLib.remove(s, 'quotes', q0.id);
  assert.strictEqual(inspireLib.stats(s).quotes.custom, 1);

  s = inspireLib.reset(s, 'quotes');
  assert.strictEqual(inspireLib.stats(s).quotes.hidden, 0, '恢复默认没清隐藏');
  assert.strictEqual(inspireLib.stats(s).quotes.overridden, 0, '恢复默认没清覆盖');
  assert.strictEqual(inspireLib.stats(s).quotes.custom, 1, '恢复默认把「我的」删了');

  // 整类问候全删：首页仍要有一句话，不能空着
  let e = inspireLib.empty();
  inspireLib.list(e, 'greetings').items.forEach(function (it) { e = inspireLib.remove(e, 'greetings', it.id); });
  inspireLib.list(e, 'moves').items.forEach(function (it) { e = inspireLib.remove(e, 'moves', it.id); });
  const t = inspireLib.today(e, { now: new Date(2026, 10, 9, 9, 30) });
  assert(t.greeting.text.length > 2 && t.greeting.hint.length > 2, '整类删空后首页空了');
});

test('inspire', '「我的」名言会轮到；换一条不重复当前这条', function () {
  let s = inspireLib.empty();
  s = inspireLib.add(s, 'quotes', { text: '只属于我的一句' });
  const cid = s.custom.quotes[0].id;
  let hit = false;
  for (let i = 0; i < 21; i++) {
    const d = new Date(2026, 10, 1 + i, 8, 0);
    const t = inspireLib.today(s, { now: d });
    if (t.quote.id === cid) hit = true;
  }
  assert(hit, '自己加的名言 21 天里一次都没轮到');

  const a = inspireLib.today(s, { now: new Date(2026, 10, 9, 9, 0) });
  const b = inspireLib.pick(s, 'quotes', { exclude: a.quote.id, round: 1 });
  assert(b && b.id !== a.quote.id, '换一条换成了同一条');
});

test('inspire', '换机合并只补不改、幂等；脏数据不抛且 normalize 幂等', function () {
  const mine = inspireLib.add(inspireLib.empty(), 'quotes', { text: '我的' });
  const other = inspireLib.add(inspireLib.empty(), 'moves', { text: '别人的' });
  const first = inspireLib.mergeSection(mine, other);
  assert.strictEqual(first.added, 1);
  const again = inspireLib.mergeSection(first.state, other);
  assert.strictEqual(again.added, 0, '重复导入又把同一条加了一遍');

  const dirty = inspireLib.normalize({ custom: 'nope', overrides: { quotes: { 'q-0': { text: '' } } }, hidden: { quotes: ['q-0', 'q-0', '野id'] } });
  assert.strictEqual(dirty.hidden.quotes.length, 1, '重复 / 野 id 没被清掉');
  assert.deepStrictEqual(inspireLib.normalize(dirty), dirty, 'normalize 不幂等');
  assert.strictEqual(inspireLib.normalize(null).custom.quotes.length, 0);
});

// ---------- V1.3 时间纵深：五项能力的数据层口径 ----------
test('v13', '人生月历：100 年 1200 格、按写过天数分档、未填生日不假装知道生日', function () {
  const recs = [
    { date: '2020-03-02', cells: { work: '开工' } },
    { date: '2020-03-09', cells: { work: '又一篇' } },
    { date: '2020-03-10', cells: { work: '   ' } },
    { date: '2024-07-01', cells: { free: '**一句话**' } }
  ];
  const c = v13.calendar(recs, { now: new Date(2026, 10, 9), years: 100 });
  assert.strictEqual(c.months.length, 1200);
  assert.strictEqual(c.basis, 'record');
  assert.strictEqual(c.startYear, 2020);
  assert(/从第一条记录算起/.test(c.headline));
  assert(!/你已走过/.test(c.headline), '没填生日却说了「你已走过」');
  const mar = c.months.find(function (m) { return m.key === '2020-03'; });
  assert.strictEqual(mar.count, 2, '空白格被算成写过');
  assert.strictEqual(mar.level, 1, '2 天应落在最浅的着色档');
  const born = v13.calendar(recs, { now: new Date(2026, 10, 9), years: 100, birth: '1980-06' });
  assert.strictEqual(born.startYear, 1980);
  assert(/你已走过/.test(born.headline));
});

test('v13', '正文待办：跨格 / 同日 / 去重 / 已完成，且一个字都不改写正文', function () {
  const src = '- [ ] 报审图纸\n- [x] 打电话\n- [ ] 报审图纸';
  const recs = [
    { date: '2026-11-01', cells: { work: src, free: '- [ ] 买书' } },
    { date: '2026-11-02', cells: { work: '- [ ] 报审图纸' } },
    { date: '2026-11-03', cells: { work: '普通一句话，没有复选框' } }
  ];
  const t = v13.todos(recs);
  assert.strictEqual(t.open.length, 3);
  assert.strictEqual(t.done.length, 1);
  assert.strictEqual(recs[0].cells.work, src, '正文被改写了');
  assert.strictEqual(v13.todos([]).total, 0);
});

test('v13', '随机重读：不翻今天、不翻空记录、窗口内不重复', function () {
  const recs = [
    { date: '2026-11-09', cells: { work: '今天' } },
    { date: '2026-11-08', cells: { work: '昨天' } },
    { date: '2026-11-07', cells: { free: '' } },
    { date: '2026-11-06', cells: { work: '前天' } }
  ];
  const first = v13.pickRandom(recs, [], { today: '2026-11-09', rand: function () { return 0; } });
  assert.strictEqual(first.date, '2026-11-08');
  const second = v13.pickRandom(recs, ['2026-11-08'], { today: '2026-11-09', rand: function () { return 0; } });
  assert.strictEqual(second.date, '2026-11-06');
  assert.strictEqual(v13.pickRandom(recs, ['2026-11-08', '2026-11-06'], { today: '2026-11-09' }), null);
});

test('v13', '一个文件：打包 → 校验 → 键一致，且拒绝程序文件与不兼容版本', function () {
  const keys = ['md_gtd', 'md_dream', 'diary_2026-11-01'];
  const db = { md_gtd: { tasks: [] }, md_dream: { themes: [] }, 'diary_2026-11-01': { cells: {} } };
  const p = v13.packSnapshot(keys, function (k) { return db[k]; }, {});
  assert.strictEqual(p.keyCount, 3);
  const v = v13.verifyPack(p.text);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.keyCount, 3);
  assert.deepStrictEqual(v.keys, keys.slice().sort());
  assert.strictEqual(v13.verifyPack('{}').ok, false);
  const bad = JSON.parse(p.text); bad.data['app.asar'] = {};
  assert.strictEqual(v13.verifyPack(JSON.stringify(bad)).ok, false, '程序文件混进了打包');
  const bad2 = JSON.parse(p.text); bad2.version = 99;
  assert.strictEqual(v13.verifyPack(JSON.stringify(bad2)).ok, false, '不兼容版本被当成有效包');
});

test('v13', '还原只补不覆盖、幂等；非数据键不进包', function () {
  const db = { a: 1 };
  const keys = ['a', 'b', '__hidden'];
  const vals = { a: 999, b: 2, __hidden: 3 };
  const p = v13.packSnapshot(keys, function (k) { return vals[k]; }, {});
  assert.strictEqual(p.keyCount, 2, '__ 前缀键被当成数据键');
  const exists = function (k) { return Object.prototype.hasOwnProperty.call(db, k); };
  const write = function (k, v) { db[k] = v; };
  const r = v13.unpackInto(p.text, exists, write);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(db.a, 1, '覆盖了本机已有的键');
  assert.strictEqual(db.b, 2);
  assert.strictEqual(db.__hidden, undefined);
  assert.strictEqual(v13.unpackInto(p.text, exists, write).added, 0, '重复导入又写了一遍');
});

// ---------- v2 数据层回归追加用例 ----------
test('v2', '9 个数据层模块 require 成功、关键导出齐全', function () {
  const mods = [
    [modSearch, ['orSearch', 'parseLinks', 'pinyinInitials', 'pinyinMatch', 'stripMarkdown']],
    [modTags, ['normalize', 'addTag', 'tagRecord', 'listFor', 'mergeSection']],
    [modRecur, ['deriveNext', 'logMinutes', 'weekDistribution', 'normalize']],
    [modRelation, ['normalize', 'addContact', 'addLog', 'logsFor', 'temperature', 'analytics', 'mergeSection', 'validDate']],
    [modReview, ['termOf', 'termKeyOf', 'saveReview', 'listReviews', 'mergeSection', 'normalize']],
    [modTrace, ['normalize', 'add', 'remove', 'all', 'listFor', 'markMissing', 'mergeSection']],
    [modVault, ['encrypt', 'decrypt', 'isEncrypted', 'verify']],
    [modAttach, ['normalize', 'add', 'remove', 'list', 'refresh', 'reconnect', 'mergeSection']],
    [modGtd, ['normalize', 'addTask', 'board', 'mergeSection']],
  ];
  assert.strictEqual(mods.length, 9);
  mods.forEach(function (pair) {
    const m = pair[0];
    assert.ok(m && typeof m === 'object', '模块导出应为对象');
    pair[1].forEach(function (k) {
      assert.strictEqual(typeof m[k], 'function', '缺少关键函数 ' + k);
    });
  });
  assert.ok(Array.isArray(modReview.TERMS));
  assert.strictEqual(typeof modRelation.MAX_CONTACTS, 'number');
});

test('v2', 'search/query：orSearch 或匹配 / 空关键词 / parseLinks 三类 / pinyinInitials', function () {
  const recs = [
    { date: '2026-11-07', cells: { a: '今天买了苹果' } },
    { date: '2026-11-08', cells: { a: '昨天吃了香蕉' } },
    { date: '2026-11-09', cells: { a: '无关橘子' } },
  ];
  const hit = modSearch.orSearch(recs, '苹果 | 香蕉');
  assert.strictEqual(hit.length, 2, 'A | B 应命中两条不同正文');
  assert.ok(hit.some(function (r) { return r.cells.a.indexOf('苹果') >= 0; }));
  assert.ok(hit.some(function (r) { return r.cells.a.indexOf('香蕉') >= 0; }));
  assert.deepStrictEqual(modSearch.orSearch(recs, ''), [], '空关键词返回空数组');
  assert.deepStrictEqual(modSearch.orSearch(recs, '   '), [], '全空白关键词返回空数组');
  assert.deepStrictEqual(modSearch.orSearch(recs, ' | '), [], '全是空项返回空数组');

  const links = modSearch.parseLinks('[[2026-11-07]] [[@老王]] [[cap:x]]');
  assert.strictEqual(links.length, 3);
  assert.deepStrictEqual(links.map(function (l) { return l.type; }), ['date', 'person', 'capsule']);
  assert.strictEqual(links[0].target, '2026-11-07');
  assert.strictEqual(links[1].target, '老王');
  assert.strictEqual(links[2].target, 'x');

  assert.strictEqual(modSearch.pinyinInitials('张三'), 'zs');
});

test('v2', 'tags/board：normalize 幂等不抛 / addTag+tagRecord+listFor / mergeSection 只补不改且二次 added=0', function () {
  const once = modTags.normalize({ tags: [{ name: '重要' }], links: [] });
  assert.deepStrictEqual(modTags.normalize(once), once);
  assert.doesNotThrow(function () {
    modTags.normalize(null); modTags.normalize('bad'); modTags.normalize(42);
  });

  let s = modTags.addTag(modTags.empty(), '重要');
  assert.strictEqual(s.tags.length, 1);
  const id = s.tags[0].id;
  s = modTags.tagRecord(s, 'diary:2026-11-07', id);
  const listed = modTags.listFor(s, 'diary:2026-11-07');
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].name, '重要');
  assert.strictEqual(listed[0].id, id);

  const sec = { tags: [{ id: 'z', name: '新' }], links: [] };
  const m1 = modTags.mergeSection(s, sec);
  assert.strictEqual(m1.added, 1);
  assert.strictEqual(
    m1.state.tags.filter(function (t) { return t.name === '重要'; })[0].id,
    id, '只补不改：本机已有标签不被覆盖'
  );
  const m2 = modTags.mergeSection(m1.state, sec);
  assert.strictEqual(m2.added, 0, '二次合并 added 必须为 0');
});

test('v2', 'recur/board：deriveNext 防堆积 / logMinutes 夹 0..1440 / weekDistribution 有 total', function () {
  const today = '2026-11-09';
  const twin = { id: 't0', title: 'A', context: 'c', repeat: 'week', due: '2026-11-01' };
  const openTwin = { id: 't1', title: 'A', context: 'c', done: false };
  assert.strictEqual(
    modRecur.deriveNext(twin, [twin, openTwin], today), null,
    '已有同 title+context 未完成实例应返回 null（防堆积）'
  );
  assert.ok(modRecur.deriveNext(twin, [twin], today), '无 twin 时应能派生（对照）');

  assert.strictEqual(modRecur.logMinutes({}, 't1', 99999, today).logs[0].minutes, 1440);
  assert.strictEqual(modRecur.logMinutes({}, 't1', -5, today).logs[0].minutes, 0);

  const dist = modRecur.weekDistribution({}, today);
  assert.strictEqual(typeof dist.total, 'number');
  assert.strictEqual(dist.total, 0);
});

test('v2', 'relation/board：normalize 幂等 / 3 人 log 每人 1 次 / 温度单调降 / 无记录 null / 非法日期 / 归档流水可查 / analytics 四视角', function () {
  const now = '2026-11-09';
  // 幂等用 once 模式：避免两次 normalize(脏数据) 各自重算 Date.now() 造成假失败
  const once = modRelation.normalize({
    contacts: [{ id: 'x1', name: '甲', createdAt: 1 }], logs: [], archived: [],
  });
  assert.deepStrictEqual(modRelation.normalize(once), once);
  assert.doesNotThrow(function () { modRelation.normalize(null); modRelation.normalize('bad'); });

  let s = modRelation.empty();
  s = modRelation.addContact(s, { id: 'c1', name: '甲', tier: 'core' });
  s = modRelation.addContact(s, { id: 'c2', name: '乙', tier: 'core' });
  s = modRelation.addContact(s, { id: 'c3', name: '丙', tier: 'core' });
  s = modRelation.addLog(s, { contactIds: ['c1', 'c2', 'c3'], date: '2026-11-01', channel: 'meal', depth: 'deep' });
  assert.strictEqual(modRelation.logsFor(s, 'c1', now).length, 1, '一条 3 人 log，每人只计 1 次');
  assert.strictEqual(modRelation.logsFor(s, 'c2', now).length, 1);
  assert.strictEqual(modRelation.logsFor(s, 'c3', now).length, 1);

  const t1 = modRelation.temperature(s, 'c1', now);
  const t2 = modRelation.temperature(s, 'c1', '2026-12-09');
  const t3 = modRelation.temperature(s, 'c1', '2027-05-28');
  assert.ok(typeof t1 === 'number' && t1 > t2 && t2 > t3, '温度随天数单调下降：' + [t1, t2, t3]);
  assert.strictEqual(modRelation.temperature(s, 'nobody', now), null, '无记录返回 null 而非 0');

  // 非法日期：实现并非丢弃，而是降级为系统当天，故断言「原非法串绝不入库 + 落库日期合法」
  let bad = modRelation.addContact(modRelation.empty(), { id: 'd1', name: '丁' });
  bad = modRelation.addLog(bad, { contactIds: ['d1'], date: '2026-13-40' });
  assert.strictEqual(bad.logs.length, 1);
  assert.notStrictEqual(bad.logs[0].date, '2026-13-40', '非法日期串不得写入');
  assert.strictEqual(modRelation.validDate(bad.logs[0].date), true, '落库日期应是合法日期（实现降级为今天）');

  const archived = modRelation.archiveContact(s, 'c1');
  assert.strictEqual(archived.contacts.some(function (c) { return c.id === 'c1'; }), false);
  assert.strictEqual(archived.archived.some(function (c) { return c.id === 'c1'; }), true);
  assert.strictEqual(modRelation.logsFor(archived, 'c1', now).length, 1, '归档后历史流水仍可查');

  const a = modRelation.analytics(s, now);
  ['cooling', 'structure', 'channels', 'giveFirst'].forEach(function (k) {
    assert.ok(a[k] && typeof a[k] === 'object', 'analytics 缺少视角 ' + k);
  });
});

test('v2', 'review/term：TERMS=24 / termOf 合理 / saveReview 与 mergeSection 幂等', function () {
  assert.strictEqual(modReview.TERMS.length, 24);
  const t = modReview.termOf('2026-11-02');
  assert.ok(modReview.TERMS.indexOf(t.name) >= 0, 'name 应是 24 节气之一');
  assert.ok(modReview.TERMS.indexOf(t.next) >= 0, 'next 应是 24 节气之一');
  assert.ok(Number.isInteger(t.daysLeft) && t.daysLeft > 0 && t.daysLeft <= 20, 'daysLeft 应在 1..20');

  const s1 = modReview.saveReview(modReview.empty(), '2026-霜降', { text: 'a' });
  const s2 = modReview.saveReview(s1, '2026-霜降', { text: 'b' });
  assert.strictEqual(
    s2.reviews.filter(function (r) { return r.termKey === '2026-霜降'; }).length, 1,
    '同 termKey 只留 1 条（写/改幂等）'
  );

  const sec = {
    reviews: [
      { termKey: '2026-霜降', answers: { text: 'z' } },
      { termKey: '2026-立冬', answers: { text: 'n' } },
    ],
  };
  const base = { reviews: [{ termKey: '2026-霜降', answers: { text: 'a' } }] };
  const m1 = modReview.mergeSection(base, sec);
  assert.strictEqual(m1.added, 1);
  assert.strictEqual(
    m1.state.reviews.filter(function (r) { return r.termKey === '2026-霜降'; })[0].answers.text,
    'a', '只补不改：本机已有 termKey 不被覆盖'
  );
  const m2 = modReview.mergeSection(m1.state, sec);
  assert.strictEqual(m2.added, 0, '二次合并 added 必须为 0');
});

test('v2', 'trace/board：normalize 幂等 / markMissing 不减少引用 / mergeSection 只补不改', function () {
  const once = modTrace.normalize({ links: [{ from: 'a', to: 'b' }] });
  assert.deepStrictEqual(modTrace.normalize(once), once);
  assert.doesNotThrow(function () { modTrace.normalize(null); modTrace.normalize([1, 2, 3]); });

  const s = { links: [{ from: 'a', to: 'b', note: 'n' }, { from: 'b', to: 'c' }] };
  const before = modTrace.all(s).length;
  const view = modTrace.markMissing(s, ['b']);
  assert.strictEqual(view.length, before, 'markMissing 不得减少引用条数（灰色残留不自动清除）');
  assert.ok(view.some(function (x) { return x.missing === true; }), '失效目标应被标 missing');
  assert.strictEqual(modTrace.all(s).length, before, 'markMissing 返回只读视图，不改原数据');

  const sec = { links: [{ id: 'q', from: 'x', to: 'y' }, { id: 'r', from: 'y', to: 'z' }] };
  const m1 = modTrace.mergeSection({ links: [{ id: 'q', from: 'x', to: 'y' }] }, sec);
  assert.strictEqual(m1.added, 1);
  assert.strictEqual(
    m1.state.links.filter(function (l) { return l.id === 'q'; }).length, 1,
    '只补不改：同 id 不重复不覆盖'
  );
  const m2 = modTrace.mergeSection(m1.state, sec);
  assert.strictEqual(m2.added, 0, '二次合并 added 必须为 0');
});

test('v2', 'secure/vault：正确口令往返 / 错误口令抛错 / 篡改 data 抛错 / salt 随机 / 不含口令', function () {
  const PASS = 'jiuge-V2-Test-Pass-9f3a!';
  const blob = modVault.encrypt('九格手记机密', PASS);
  assert.strictEqual(modVault.isEncrypted(blob), true);
  assert.strictEqual(modVault.decrypt(blob, PASS), '九格手记机密', '正确口令往返成功');
  assert.throws(function () { modVault.decrypt(blob, PASS + '-wrong'); }, '错误口令应抛错');

  const tampered = Object.assign({}, blob);
  tampered.data = (blob.data.charAt(0) === 'A' ? 'B' : 'A') + blob.data.slice(1);
  assert.throws(function () { modVault.decrypt(tampered, PASS); }, '篡改 data 后 GCM 认证失败应抛错');

  assert.notStrictEqual(blob.salt, modVault.encrypt('九格手记机密', PASS).salt, '两次 encrypt 的 salt 必须不同');
  assert.strictEqual(JSON.stringify(blob).indexOf(PASS), -1, '返回值绝不含口令');
  assert.deepStrictEqual(Object.keys(blob).sort(), ['data', 'iv', 'salt', 'tag', 'v']);
});

test('v2', 'attach/links：normalize 幂等 / 缺失路径 add 返回 null / refresh 标 broken / mergeSection 幂等', function () {
  const once = modAttach.normalize({ links: [{ path: '/x/a' }] });
  assert.deepStrictEqual(modAttach.normalize(once), once);
  assert.doesNotThrow(function () { modAttach.normalize(null); modAttach.normalize('bad'); });

  assert.strictEqual(
    modAttach.add(modAttach.empty(), path.join(os.tmpdir(), 'jiuge-v2-no-such-' + Date.now() + '.bin')),
    null, '不存在的路径 add 应返回 null'
  );

  // 临时文件放 os.tmpdir()，绝不写进工程；改名模拟「文件被移走」后 refresh 应标 broken
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-v2-'));
  const file = path.join(dir, 'a.txt');
  const moved = path.join(dir, 'a-moved.txt');
  try {
    fs.writeFileSync(file, 'x');
    const added = modAttach.add(modAttach.empty(), file);
    assert.strictEqual(added.links.length, 1);
    fs.renameSync(file, moved);
    const refreshed = modAttach.refresh(added);
    assert.strictEqual(refreshed.links[0].broken, true, '失效项应被标 broken');
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* noop */ }
    try { fs.unlinkSync(moved); } catch (e) { /* noop */ }
    try { fs.rmdirSync(dir); } catch (e) { /* noop */ }
  }

  const sec = { links: [{ path: '/p' }, { path: '/q' }] };
  const m1 = modAttach.mergeSection({ links: [{ path: '/p' }] }, sec);
  assert.strictEqual(m1.added, 1);
  const m2 = modAttach.mergeSection(m1.state, sec);
  assert.strictEqual(m2.added, 0, '二次合并 added 必须为 0');
});

test('v2', 'gtd/board：normalize 与 addTask 均保留 contactId / repeat', function () {
  const n = modGtd.normalize({ tasks: [{ title: 'A', contactId: 'c1', repeat: 'week' }] });
  assert.strictEqual(n.tasks.length, 1);
  assert.strictEqual(n.tasks[0].contactId, 'c1');
  assert.strictEqual(n.tasks[0].repeat, 'week');

  const added = modGtd.normalize(modGtd.addTask(modGtd.empty(), { title: 'B', contactId: 'c2', repeat: 'day' }));
  const b = added.tasks.filter(function (t) { return t.title === 'B'; })[0];
  assert.ok(b, 'addTask 应新增任务');
  assert.strictEqual(b.contactId, 'c2', '读回 contactId 仍在');
  assert.strictEqual(b.repeat, 'day', '读回 repeat 仍在');
});

test('v2', 'reading/board：normalize / 翻页 / 删书不删笔记 / 标签归一', function () {
  let s = modReading.empty();
  s = modReading.normalize(modReading.addBook(s, { title: '城门', author: '老刘', total: 10 }));
  assert.strictEqual(s.books.length, 1, '加书失败');
  assert.strictEqual(modReading.normalize(s).books.length, 1, 'normalize 不幂等');
  const bk = s.books[0];
  s = modReading.normalize(modReading.advanceBook(s, bk.id, 10, '2026-11-09'));
  assert.strictEqual(s.books[0].status, 'done', '翻满应自动读完');
  s = modReading.normalize(modReading.advanceBook(s, bk.id, -1, '2026-11-09'));
  assert.strictEqual(s.books[0].status, 'reading', '回翻应退回在读');
  s = modReading.normalize(modReading.addNote(s, {
    mode: 'leisure', bookId: bk.id, bookTitle: '城门', type: 'highlight',
    quote: '一句原文', text: '我的批注', page: 7, tags: ['#城市', '城市', ' 水 ']
  }));
  assert.ok(s.notes[0].tags.indexOf('城市') >= 0 && s.notes[0].tags.indexOf('水') >= 0, '标签应剥 # 并去空白');
  assert.strictEqual(s.notes[0].tags.length, 2, '标签应去重');
  s = modReading.normalize(modReading.removeBook(s, bk.id));
  assert.strictEqual(s.books.length, 0, '移出书架失败');
  assert.strictEqual(s.notes.length, 1, '移出书架不该删掉笔记');
  assert.strictEqual(modReading.notesQuery(s, {}).items[0].orphan, true, '原书移出应标 orphan');
});

test('v2', 'reading/board：书架顺序 / 拖动重排 / 最近在读 / 再读一遍 / 按书导出', function () {
  let s = modReading.empty();
  s = modReading.addBook(s, { id: 'b1', title: '甲', total: 100 });
  s = modReading.addBook(s, { id: 'b2', title: '乙', total: 100 });
  s = modReading.addBook(s, { id: 'b3', title: '丙', total: 100 });
  // 新书排最前：每本的 order 比现有最小值再小一，刚放上书架的那本立刻在第一屏
  assert.deepStrictEqual(modReading.board(s).books.map(function (b) { return b.id; }), ['b3', 'b2', 'b1'],
    '新书没排在最前');
  assert.strictEqual(modReading.normalize(s).books.length, 3, 'order 字段应进白名单，不被 normalize 削掉');

  // 拖动重排：只认传入的 id 次序，未列入的保持相对次序接在后面
  s = modReading.normalize(modReading.reorderBooks(s, ['b1', 'b3']));
  const order = modReading.board(s).books.map(function (b) { return b.id; });
  assert.deepStrictEqual(order, ['b1', 'b3', 'b2'], '拖动重排没生效：' + JSON.stringify(order));
  const first = modReading.board(s).books[0];
  assert.strictEqual(first.order, 0, '重排后应从头编号');
  // 传入未知 id / 空数组：不炸、不改顺序
  assert.deepStrictEqual(
    modReading.board(modReading.normalize(modReading.reorderBooks(s, ['nope', 'b3', 'b1']))).books.map(function (b) { return b.id; }),
    ['b3', 'b1', 'b2'], '含未知 id 的重排把顺序弄乱了');

  // 最近在读：只改时间，不碰进度与状态
  s = modReading.normalize(modReading.advanceBook(s, 'b1', 30, '2026-11-14'));
  s = modReading.normalize(modReading.touchBook(s, 'b1', 1763000000000));
  let b1 = s.books.filter(function (b) { return b.id === 'b1'; })[0];
  assert.strictEqual(b1.lastReadAt, 1763000000000, '最近在读没打上时间戳');
  assert.strictEqual(b1.done, 30, '打点不该改进度');
  assert.strictEqual(b1.status, 'reading', '打点不该改状态');

  // 再读一遍：进度归零、状态回在读、时间戳刷新，书签与笔记一条不动
  s = modReading.normalize(modReading.addBookmark(s, { bookId: 'b1', chapterIndex: 2, anchor: 'a-1' }));
  s = modReading.normalize(modReading.addNote(s, {
    mode: 'leisure', bookId: 'b1', bookTitle: '甲', type: 'highlight', quote: '一句', text: '想法', page: 3, tags: []
  }));
  const marksBefore = s.bookmarks.length;
  const notesBefore = s.notes.length;
  s = modReading.normalize(modReading.rereadBook(s, 'b1', 1763000009999));
  b1 = s.books.filter(function (b) { return b.id === 'b1'; })[0];
  assert.strictEqual(b1.done, 0, '再读一遍没把进度归零');
  assert.strictEqual(b1.status, 'reading', '再读一遍应回到在读');
  assert.strictEqual(b1.finishedAt, '', '再读一遍应清掉读完时间');
  assert.strictEqual(b1.lastReadAt, 1763000009999, '再读一遍应刷新最近在读');
  assert.strictEqual(s.bookmarks.length, marksBefore, '再读一遍不该删书签');
  assert.strictEqual(s.notes.length, notesBefore, '再读一遍不该删笔记');

  // 按书导出：只导这一本的笔记，全库汇总仍是另一条路
  s = modReading.normalize(modReading.addNote(s, {
    mode: 'leisure', bookId: 'b2', bookTitle: '乙', type: 'note', quote: '', text: '乙书的想法', page: 9, tags: []
  }));
  const one = modReading.exportMarkdown(s, 'b1');
  const all = modReading.exportMarkdown(s, '');
  assert.ok(one.indexOf('一句') >= 0, '按书导出漏了这本书的笔记');
  assert.ok(one.indexOf('乙书的想法') < 0, '按书导出混进了别的书的笔记');
  assert.ok(all.indexOf('一句') >= 0 && all.indexOf('乙书的想法') >= 0, '全库汇总漏了笔记');
  const other = modReading.exportMarkdown(s, 'b2');
  assert.ok(other.indexOf('乙书的想法') >= 0, '按书导出的另一本取错');
  assert.ok(other.indexOf('一句') < 0, '按书导出混进了别的书的笔记');
});

test('v2', 'reading/board：书架分组 / 收藏 / 重命名合并 / 解散不删书', function () {
  let s = modReading.empty();
  s = modReading.normalize(modReading.addBook(s, { id: 'b1', title: '甲', total: 100, group: '技术', favorite: true }));
  s = modReading.normalize(modReading.addBook(s, { id: 'b2', title: '乙', total: 100 }));
  s = modReading.normalize(modReading.addBook(s, { id: 'b3', title: '丙', total: 100 }));
  let bd = modReading.board(s);
  assert.deepStrictEqual(bd.groups, [{ name: '技术', count: 1 }], '分组清单没从 books 派生');
  assert.strictEqual(bd.favoriteCount, 1, '收藏数不对');

  // 收藏开关：开一次、关一次，别只认 true 不认 false
  s = modReading.normalize(modReading.setBookFavorite(s, 'b2', true));
  s = modReading.normalize(modReading.setBookFavorite(s, 'b1', false));
  bd = modReading.board(s);
  assert.strictEqual(bd.favoriteCount, 1, '收藏开关没生效');
  assert.strictEqual(bd.books.filter(function (x) { return x.id === 'b2'; })[0].favorite, true);

  s = modReading.normalize(modReading.setBookGroup(s, 'b2', '技术'));
  s = modReading.normalize(modReading.setBookGroup(s, 'b3', '工具'));
  bd = modReading.board(s);
  assert.strictEqual(bd.groups.reduce(function (m, g) { return m + g.count; }, 0), 3, '分组总数不对');

  // 重命名到已有组 = 合并，一本书都不能丢
  s = modReading.normalize(modReading.renameGroup(s, '工具', '技术'));
  bd = modReading.board(s);
  assert.deepStrictEqual(bd.groups, [{ name: '技术', count: 3 }], '重命名合并没生效');
  assert.strictEqual(s.books.length, 3, '合并把书弄丢了');

  // 解散只清标签，绝不删书
  s = modReading.normalize(modReading.removeGroup(s, '技术'));
  bd = modReading.board(s);
  assert.deepStrictEqual(bd.groups, [], '解散后仍残留分组');
  assert.strictEqual(s.books.length, 3, '解散分组把书删了');
  assert.ok(s.books.every(function (x) { return x.group === ''; }), '解散后分组字段没清空');

  // 脏数据：长名截断、非布尔收藏丢掉、normalize 幂等
  const dirty = { books: [{ id: 'd1', title: '丁', group: 'x'.repeat(200), favorite: 'yes' }] };
  const n1 = modReading.normalize(dirty);
  assert.ok(n1.books[0].group.length <= 24, '分组名没截断');
  assert.strictEqual(n1.books[0].favorite, false, 'favorite 非布尔没被丢掉');
  assert.deepStrictEqual(modReading.normalize(n1), n1, 'normalize 不幂等');
});

test('v2', 'reading/board：回写行 / 防重复 / 合并幂等 / 主题书单自建', function () {
  const n = {
    mode: 'theme', bookTitle: '给水排水', page: 32, tags: ['管网', '读书'],
    quote: '原文一句', text: '我的想法', createdAt: Date.now()
  };
  const line = modReading.noteToDiaryLine(n);
  assert.ok(line.indexOf('【读书·主题阅读】') === 0, '回写行缺阅读模式');
  assert.ok(line.indexOf('《给水排水》') >= 0 && line.indexOf('p.32') >= 0, '回写行缺书名 / 页码');
  assert.ok(line.indexOf('#管网') >= 0 && line.indexOf('我的想法') >= 0, '回写行缺标签 / 正文');
  // P0-3：回写行要能反查回原笔记（行尾标记是唯一凭据），正文本身仍是给人读的。
  // 没有 id 的临时对象（比如还没落库就预览）不硬塞标记——宁缺勿错。
  assert.strictEqual(line.indexOf('〔rd:'), -1, '没有 id 的笔记不该带 rd: 标记');
  let s = modReading.normalize(modReading.addNote(modReading.empty(),
    Object.assign({}, n, { bookId: 'b1', themeId: 't1', type: 'highlight' })));
  const id = s.notes[0].id;
  const marked = modReading.noteToDiaryLine(s.notes[0]);
  assert.deepStrictEqual(modReading.refIdsIn(marked), [id], 'rd: 标记没带出真实笔记 id');
  assert.strictEqual(modReading.stripRefMarks(marked).indexOf('〔rd:'), -1, '剥标记后仍留着 rd:');
  let p = modReading.normalize(modReading.markPushed(s, id, 'growth', 1000));
  p = modReading.normalize(modReading.markPushed(p, id, 'leisure', 2000));
  assert.strictEqual(p.notes[0].pushedAt, 1000, '重复回写不得覆盖标记');
  assert.strictEqual(p.notes[0].pushedCell, 'growth', '重复回写不得改落格');
  // P0-1：board() 不再接收、也不再返回旧 growth 主题书单。
  // 主题书的唯一来源是 md_reading.books 里 themeId 非空的记录。
  const bd = modReading.board(p);
  assert.strictEqual(bd.themeBooks, undefined, 'board 仍在透传旧 growth 主题书单');
  assert.strictEqual(bd.stats.themeBooks, 0, '这本书写在 themes 之外，不该算成主题书');
  // V2.14：主题书自建进 md_reading.books（themeId 非空），与休闲书共用一张表
  let t = modReading.addTheme(modReading.empty(), { id: 't9', title: '主题九' });
  t = modReading.addBook(t, { id: 'bk9', title: '主题九的书', themeId: 't9', filePath: 'C:/a.epub' });
  assert.strictEqual(modReading.normalize(t).books.length, 1, '主题书应写进 state.books');
  assert.strictEqual(modReading.normalize(t).books[0].themeId, 't9', '主题书应带 themeId 归属');
  assert.strictEqual(modReading.normalize(t).themes.length, 1, '主题表应落库');
  // 一次性迁移：旧 growth 数据迁入，可重复调用
  const legacy = { themes: [{ id: 'old1', title: '旧主题', books: [{ id: 'ob1', title: '旧书', quotes: [{ id: 'q1', text: '旧摘录', page: 3 }] }] }] };
  let migrated = modReading.importGrowthThemes(modReading.empty(), legacy);
  assert.strictEqual(migrated.themes.length, 1, '迁移后主题数');
  assert.strictEqual(migrated.books[0].themeId, 'gth-old1', '迁移书归属主题');
  assert.ok(migrated.notes.some(function (n) { return n.mode === 'theme' && n.quote === '旧摘录'; }), '迁移摘录进笔记');
  assert.strictEqual(modReading.importGrowthThemes(migrated, legacy).themes.length, 1, '重复迁移幂等');
  assert.strictEqual(modReading.mergeSection(modReading.empty(), p).state.notes.length, 1, '合并应补进笔记');
  assert.strictEqual(modReading.mergeSection(p, p).added, 0, '二次合并必须幂等');
  assert.ok(modReading.exportMarkdown(p, '').indexOf('# 读书笔记') === 0, '汇总导出缺标题');
  assert.strictEqual(modReading.notesQuery(p, { tag: '管网' }).items.length, 1, '按标签检索失败');
});

// 拼一个最小合法 ZIP（stored 条目），用来真验证 EPUB 解析而不是只断言常量
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach(function (f) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);            // method = stored
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([lh, name, data]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);           // method = stored
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    offset += 30 + name.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, eocd]));
}

test('v2', 'reading/epub：零依赖 ZIP + OPF 解析出书名 / 作者 / 封面，坏文件不抛', function () {
  const coverBytes = Buffer.from('fake-jpeg-cover-bytes');
  const epub = makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>城门与水管</dc:title><dc:creator>老刘</dc:creator><meta name="cover" content="cover-image"/></metadata><manifest><item id="cover-image" href="images/cover.jpg" media-type="image/jpeg"/><item id="ncx" href="toc.ncx"/></manifest></package>' },
    { name: 'OEBPS/images/cover.jpg', data: coverBytes }
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-epub-'));
  const file = path.join(dir, 'book.epub');
  try {
    fs.writeFileSync(file, epub);
    const info = modEpub.inspect(file);
    assert.ok(info, '合法 EPUB 应解析出元数据');
    assert.strictEqual(info.title, '城门与水管', 'OPF 书名没读出来');
    assert.strictEqual(info.author, '老刘', 'OPF 作者没读出来');
    assert.ok(info.cover, '没找到 cover meta 指向的图片');
    assert.strictEqual(info.cover.ext, 'jpg');
    assert.strictEqual(Buffer.compare(info.cover.data, coverBytes), 0, '封面字节不一致');
    assert.strictEqual(modEpub.inspect(path.join(dir, 'book.pdf')), null, '非 EPUB 不该解析');
    fs.writeFileSync(path.join(dir, 'bad.epub'), Buffer.from('not a zip'));
    assert.strictEqual(modEpub.inspect(path.join(dir, 'bad.epub')), null, '坏 zip 应返回 null 而不是抛');
    assert.strictEqual(modEpub.isAllowed('C:/b/a.EPUB'), true);
    assert.strictEqual(modEpub.isAllowed('C:/b/a.exe'), false);
    assert.strictEqual(modEpub.titleFromPath('C:/b/城门与水管（校订版）.epub'), '城门与水管');
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* noop */ }
    try { fs.unlinkSync(path.join(dir, 'bad.epub')); } catch (e) { /* noop */ }
    try { fs.rmdirSync(dir); } catch (e) { /* noop */ }
  }
});

test('v2', 'reading/epub 封面：meta / properties / guide 三级兜底，4MB 上限，格式按魔数纠正（V3.11）', function () {
  // 真实 PNG 头 + 700KB 填充：超过旧 500KB 上限，用来钉住「书里有封面就必须抽到」
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(700 * 1024, 7)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-epub-cover-'));
  const files = [];
  function write(name, buf) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, buf);
    files.push(p);
    return p;
  }
  try {
    // ① 规范 meta 封面 + 大图：旧逻辑按 500KB 卡，会静默回落成色块
    const a = write('a.epub', makeZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
      { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>大图封面</dc:title><meta name="cover" content="ci"/></metadata><manifest><item id="ci" href="images/cover.png" media-type="image/png"/></manifest><spine><itemref idref="ci"/></spine></package>' },
      { name: 'OEBPS/images/cover.png', data: png }
    ]));
    const ia = modEpub.inspect(a);
    assert.ok(ia && ia.cover, '700KB 封面应当抽到（上限已放宽到 4MB）');
    assert.strictEqual(ia.cover.data.length, png.length, '大封面字节被截断');

    // ② 只有 guide type="cover" 指向封面页，页内 src 用 ../ 跨目录
    const b = write('b.epub', makeZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
      { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>guide 封面</dc:title></metadata><manifest><item id="cp" href="text/cover.xhtml" media-type="application/xhtml+xml"/><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine><guide><reference type="cover" title="Cover" href="text/cover.xhtml"/></guide></package>' },
      { name: 'OEBPS/text/cover.xhtml', data: '<html><body><img src="../images/front.jpg" alt="cover"/></body></html>' },
      { name: 'OEBPS/text/ch1.xhtml', data: '<html><body><p>正文</p></body></html>' },
      { name: 'OEBPS/images/front.jpg', data: png }
    ]));
    const ib = modEpub.inspect(b);
    assert.ok(ib && ib.cover, 'guide 指向的封面页没取到首图（../ 相对路径没解析？）');
    assert.strictEqual(ib.cover.ext, 'png', '扩展名写 jpg、内容是 PNG，应按魔数纠正，否则 dataURL 声明错 mime 会白图');

    // ③ EPUB3 的 properties="cover-image"，文件名不含 cover
    const c = write('c.epub', makeZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
      { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>EPUB3</dc:title></metadata><manifest><item id="i1" href="img/c1.png" media-type="image/png" properties="cover-image"/></manifest><spine><itemref idref="i1"/></spine></package>' },
      { name: 'OEBPS/img/c1.png', data: png }
    ]));
    assert.ok(modEpub.inspect(c).cover, 'properties="cover-image" 没认出来');

    // ④ 真的没有封面：正文里的插图不许被当成封面
    const d = write('d.epub', makeZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
      { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>没有封面</dc:title></metadata><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="i1" href="images/fig1.png" media-type="image/png"/></manifest><spine><itemref idref="ch1"/></spine></package>' },
      { name: 'OEBPS/ch1.xhtml', data: '<html><body><img src="images/fig1.png"/><p>正文</p></body></html>' },
      { name: 'OEBPS/images/fig1.png', data: png }
    ]));
    assert.strictEqual(modEpub.inspect(d).cover, null, '把正文插图当封面了：宁可没有，也不能给错');
  } finally {
    files.forEach(function (p) { try { fs.unlinkSync(p); } catch (e) { /* noop */ } });
    try { fs.rmdirSync(dir); } catch (e) { /* noop */ }
  }
});

test('v2', 'reading/board：本地书字段读回不丢、路径去重、normalize 幂等', function () {
  let s = modReading.empty();
  const patch = {
    title: '城门与水管', author: '老刘', filePath: 'C:/books/a b/城门.epub',
    fileExt: 'epub', fileSize: 204800, format: 'EPUB', coverId: 'bk1.jpg', source: 'file'
  };
  s = modReading.normalize(modReading.addBook(s, patch));
  const b = s.books[0];
  assert.strictEqual(b.filePath, 'C:/books/a b/城门.epub', '路径里的连续空格不能被折叠');
  assert.strictEqual(b.fileSize, 204800);
  assert.strictEqual(b.source, 'file');
  assert.strictEqual(b.coverId, 'bk1.jpg');
  assert.strictEqual(modReading.normalize(s).books[0].filePath, b.filePath, '二次 normalize 丢字段');
  assert.strictEqual(modReading.hasPath(s, 'c:/books/a b/城门.EPUB'), true, 'Windows 路径应大小写不敏感去重');
  assert.strictEqual(modReading.hasPath(s, 'C:/books/别的.epub'), false);
  const bd = modReading.board(s);
  assert.strictEqual(bd.books[0].hasFile, true, 'board 应派生 hasFile');
  assert.strictEqual(modReading.notesQuery(s, {}).items.length, 0);
  const m = modReading.mergeSection(modReading.empty(), s);
  assert.strictEqual(m.state.books[0].filePath, b.filePath, '备份合并应带回文件路径');
  assert.strictEqual(modReading.mergeSection(m.state, s).added, 0, '二次合并幂等');
});

test('v2', 'reading/epub：目录（NCX 两层）+ 按章正文 + 图片内联 + 脚本剥离', function () {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const book = makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>城门与水管</dc:title><dc:creator>老刘</dc:creator><meta name="cover" content="ci"/></metadata><manifest><item id="ci" href="images/cover.png" media-type="image/png"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>' },
    { name: 'OEBPS/toc.ncx', data: '<ncx><navMap><navPoint id="n1"><navLabel><text>第一章 水管</text></navLabel><content src="ch1.xhtml"/><navPoint id="n1a"><navLabel><text>第一节 阀门</text></navLabel><content src="ch1.xhtml#v"/></navPoint></navPoint><navPoint id="n2"><navLabel><text>第二章 城门</text></navLabel><content src="ch2.xhtml"/></navPoint></navMap></ncx>' },
    { name: 'OEBPS/ch1.xhtml', data: '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch1</title></head><body onload="alert(1)"><h1 id="v">第一章 水管</h1><p>城里的水管埋在地下。</p><script>alert(2)</script><img src="images/cover.png"/><img src="http://evil.example/x.png"/></body></html>' },
    { name: 'OEBPS/ch2.xhtml', data: '<html><body><h1>第二章 城门</h1><p>城门每天开合。</p></body></html>' },
    { name: 'OEBPS/images/cover.png', data: png }
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-epub-read-'));
  const file = path.join(dir, 'book.epub');
  try {
    fs.writeFileSync(file, book);
    const meta = modEpub.readBook(file);
    assert.ok(meta.ok, '合法 EPUB 应能读出目录：' + meta.reason);
    assert.strictEqual(meta.chapterCount, 2, 'spine 章节数不对');
    assert.ok(meta.toc.length >= 2, 'NCX 目录没解析出来');
    assert.ok(meta.toc[0].title.indexOf('第一章') >= 0, '目录标题不对：' + meta.toc[0].title);
    assert.strictEqual(meta.toc[0].index, 0, '目录项没映射到章节序号');
    assert.ok(meta.toc.filter(function (x) { return x.level === 2; }).length >= 1, '嵌套 navPoint 应保留二级');
    const ch = modEpub.readChapter(file, 0);
    assert.ok(ch.ok, '第一章应读到');
    assert.ok(ch.html.indexOf('城里的水管埋在地下') >= 0, '正文没读到');
    assert.ok(ch.html.indexOf('data:image/png;base64,') >= 0, '章内图片没转 dataURL');
    assert.ok(!/<script/i.test(ch.html), '正文残留 script');
    assert.ok(!/onload\s*=/i.test(ch.html), '正文残留事件属性');
    assert.ok(!/https?:\/\//i.test(ch.html), '正文残留外链');
    assert.strictEqual(modEpub.readChapter(file, 99).ok, false, '越界应返回 ok:false');
    assert.strictEqual(modEpub.readBook(path.join(dir, 'nope.epub')).ok, false, '不存在应返回 ok:false');
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* noop */ }
    try { fs.rmdirSync(dir); } catch (e) { /* noop */ }
  }
});

test('v2', 'reading/reader-source：TXT / MD 分章、PDF 只验文件头并交给阅读窗、编码兜底不抛', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-text-'));
  const md = path.join(dir, 'note.md');
  const txt = path.join(dir, 'book.txt');
  const pdf = path.join(dir, 'a.pdf');
  const badPdf = path.join(dir, 'broken.pdf');
  const mobi = path.join(dir, 'b.mobi');
  try {
    fs.writeFileSync(md, '# 第一节 开头\n\n第一段 **重点**。\n\n## 子标题\n\n- 一条\n- 两条\n\n> 引用一句\n', 'utf8');
    const m = modReaderSource.openBook(md);
    assert.ok(m.ok && m.supported, 'MD 应支持：' + JSON.stringify(m).slice(0, 160));
    assert.ok(m.chapterCount >= 2, 'MD 应按标题分章');
    const mc = modReaderSource.chapter(md, 0);
    assert.ok(mc.ok && mc.html.indexOf('第一段') >= 0, 'MD 正文没读到');
    assert.ok(mc.html.indexOf('<strong>') >= 0, 'MD 粗体没渲染');
    fs.writeFileSync(txt, '第一章 起\n内容一。\n\n第二章 承\n内容二。\n\n第三章 转\n内容三。\n', 'utf8');
    const t = modReaderSource.openBook(txt);
    assert.ok(t.ok && t.chapterCount >= 3, 'TXT 应按章节分章');
    assert.ok(modReaderSource.chapter(txt, 1).html.indexOf('内容二') >= 0, 'TXT 第二章没读到');
    // V3.5：PDF 不再「明确不支持」。主进程只认 %PDF- 文件头 + 体积上限，
    // 页数 / 目录 / 文字层全交给阅读窗的本地 pdf.js，所以这里 chapterCount 必须是 0。
    fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const p = modReaderSource.openBook(pdf);
    assert.ok(p.ok && p.supported && p.kind === 'pdf' && p.pdf === true,
      '合法 PDF 头应交给阅读窗：' + JSON.stringify(p).slice(0, 200));
    assert.strictEqual(p.chapterCount, 0, '主进程不该解析 PDF 页数');
    assert.deepStrictEqual(p.toc, [], 'PDF 目录由阅读窗按页生成');
    assert.strictEqual(modReaderSource.FORMATS.pdf.supported, true, 'FORMATS.pdf 应标为支持');
    assert.ok(modReaderSource.MAX_PDF_BYTES > 0, 'PDF 必须有体积上限');
    fs.writeFileSync(badPdf, 'x');
    const bp = modReaderSource.openBook(badPdf);
    assert.strictEqual(bp.ok, false, '假 PDF 不能放行');
    assert.strictEqual(bp.kind, 'pdf', '假 PDF 也要保留 pdf 类型，界面才能给对的提示');
    assert.ok(bp.reason && bp.reason.indexOf('文件头') >= 0, '假 PDF 应说明是文件头问题');
    fs.writeFileSync(mobi, 'x');
    const mb = modReaderSource.openBook(mobi);
    assert.ok(mb.ok && mb.supported === false && mb.reason, 'MOBI / AZW3 仍如实标注不支持');
    assert.strictEqual(modReaderSource.openBook(path.join(dir, 'nope.epub')).ok, false, '不存在应 ok:false');
    assert.strictEqual(modReaderSource.chapter(md, 999).ok, false, '越界应 ok:false');
  } finally {
    [md, txt, pdf, badPdf, mobi].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { /* noop */ } });
    try { fs.rmdirSync(dir); } catch (e) { /* noop */ }
  }
});


test('v2', 'reading/board：书签增删 / 同位置去重 / 上限 / 老数据兼容', function () {
  let s = modReading.empty();
  assert.deepStrictEqual(s.bookmarks, [], '空态必须有 bookmarks 数组');
  s = modReading.addBookmark(s, { bookId: 'b1', anchor: '3:0.42', label: '第三章' });
  assert.strictEqual(s.bookmarks.length, 1, '书签没写进去');
  assert.strictEqual(s.bookmarks[0].chapterIndex, 3, '章序没从 anchor 解析出来');
  assert.strictEqual(s.bookmarks[0].anchor, '3:0.420', '滚动比例没收敛到三位');
  s = modReading.addBookmark(s, { bookId: 'b1', anchor: '3:0.420' });
  assert.strictEqual(s.bookmarks.length, 1, '同一位置重复加书签应去重');
  s = modReading.addBookmark(s, { bookId: 'b1', anchor: '乱写' });
  assert.strictEqual(s.bookmarks.length, 1, '脏 anchor 应被丢弃');
  s = modReading.addBookmark(s, { bookId: 'b1', anchor: '1:0.1' });
  const list = modReading.bookmarksOf(s, 'b1');
  assert.strictEqual(list[0].chapterIndex, 1, '书签应按章序排序');
  s = modReading.addNote(s, { bookId: 'b1', mode: 'leisure', bookTitle: '书', quote: '一句原文' });
  const after = modReading.removeBookmark(s, s.bookmarks[0].id);
  assert.strictEqual(after.bookmarks.length, 1, '删书签数量不对');
  assert.strictEqual(after.notes.length, 1, '删书签不得连累笔记');
  const old = modReading.normalize({ books: [], chapters: [], notes: [] });
  assert.deepStrictEqual(old.bookmarks, [], '老数据（无 bookmarks）应兼容成空数组');
  let big = modReading.empty();
  for (let i = 0; i < 230; i += 1) big = modReading.addBookmark(big, { bookId: 'b1', anchor: i + ':0.1' });
  assert.ok(big.bookmarks.length <= modReading.MAX_BOOKMARKS, '书签未按上限裁剪');
  // 2 条书签 + 1 条笔记，合并应全部带进来
  assert.strictEqual(modReading.mergeSection(modReading.empty(), s).added, 3, '备份合并应带上书签');
  assert.strictEqual(modReading.mergeSection(s, s).added, 0, '二次合并书签必须幂等');
  assert.ok(modReading.exportMarkdown(s, '').indexOf('# 读书笔记') === 0, '加书签后导出不应崩');
});

test('v2', 'reading/board：标注三字段 anchor / color / style 归一化与读回', function () {
  let s = modReading.empty();
  s = modReading.addNote(s, {
    bookId: 'b1', mode: 'leisure', bookTitle: '书', quote: '一段原文',
    chapterId: 'ch-2', anchor: '2:10-24', color: 'green', style: 'highlight'
  });
  const n = s.notes[0];
  assert.strictEqual(n.anchor, '2:10-24', '锚点没存住');
  assert.strictEqual(n.color, 'green', '颜色没存住');
  assert.strictEqual(n.style, 'highlight', '样式没存住');
  const d = modReading.addNote(s, {
    bookId: 'b1', mode: 'leisure', bookTitle: '书', text: '只有想法',
    anchor: '乱写', color: 'pinkk', style: 'bold'
  });
  assert.strictEqual(d.notes[1].anchor, '', '脏锚点应丢弃');
  assert.strictEqual(d.notes[1].color, '', '未知颜色应丢弃');
  assert.strictEqual(d.notes[1].style, '', '未知样式应丢弃');
  const again = modReading.normalize(s);
  assert.strictEqual(again.notes[0].anchor, '2:10-24', '二次 normalize 丢了锚点');
  const m = modReading.meta();
  assert.ok(m.hlColors.indexOf('green') >= 0, 'meta 未暴露高亮色板');
  assert.ok(m.noteStyles.indexOf('underline') >= 0, 'meta 未暴露标注样式');
  assert.strictEqual(modReading.board(s).stats.bookmarks, 0, 'stats 应带书签数');
});


test('v2', 'reading/epub：完全接管书内样式 / 行内白名单 / 超长章节降级 / 两份基线一致', function () {
  const bookCss = 'p{line-height:3;color:#ff0000;font-size:10px;letter-spacing:3px;text-align:right;}'
    + '.c{text-align:center;color:#00f;}h1{font-size:9em;}';
  const body = '<html><head><style>' + bookCss + '</style></head><body>'
    + '<h1>第一章</h1>'
    + '<p class="c">书内样式想让它居中变蓝。</p>'
    + '<p>城里的水管埋在地下。</p>'
    + '<p style="font-size:11px;color:#ff0000;text-align:center;text-indent:0">行内样式一段。</p>'
    + '</body></html>';
  const book = makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>排印书</dc:title></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>' },
    { name: 'OEBPS/ch1.xhtml', data: body },
    // 超长章节：约 2.4MB，必须照读但标 oversize（不能像旧版那样直接失败）
    { name: 'OEBPS/ch2.xhtml', data: '<html><body><h1>第二章</h1><p>' + '水管很长。'.repeat(370000) + '</p></body></html>' }
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-typeset-'));
  const file = path.join(dir, 'book.epub');
  try {
    fs.writeFileSync(file, book);
    const r = modEpub.readChapter(file, 0);
    assert.ok(r.ok, '章节应能读出：' + (r.reason || ''));
    assert.ok(r.cssBytes > 0, '应统计出被丢弃的书内 CSS 体积');
    // 书内 <style> 整体丢弃：影响排版的属性一条都不许漏进正文
    ['line-height:3', 'font-size:10px', 'letter-spacing:3px', 'font-size:9em', '.c{'].forEach(function (k) {
      assert.strictEqual(r.html.indexOf(k), -1, '书内样式没被接管：' + k);
    });
    assert.strictEqual((r.html.match(/<style/gi) || []).length, 1, '正文里应只有引擎自己的一份样式表');
    assert.strictEqual(r.html.indexOf('word-break:break-all'), -1, '排印基线不许出现全断断词');
    // 行内样式：字号/颜色剥掉，居中保留（这是「白名单」而不是「全删」的分界）
    assert.strictEqual(r.html.indexOf('font-size:11px'), -1, '行内字号没被剥');
    assert.strictEqual(r.html.indexOf('#ff0000'), -1, '行内颜色没被剥');
    assert.ok(r.html.indexOf('text-align:center') >= 0, '行内居中该保留');
    assert.strictEqual(r.oversize, false, '普通章节不该标超长');

    const big = modEpub.readChapter(file, 1);
    assert.ok(big.ok, '超长章节应降级照读而不是直接失败');
    assert.strictEqual(big.oversize, true, '超过 2MB 的章节应标 oversize');
    assert.ok(big.bytes > 2 * 1024 * 1024, '字节数没透出来');

    // 两份 BASE_CSS 必须逐字一致：一处改了另一处没跟上，就是「同一本书两种排版」
    const pick = function (rel) {
      const src = fs.readFileSync(path.resolve(__dirname, '../../' + rel), 'utf8');
      const a = src.indexOf('const BASE_CSS = [');
      const b = src.indexOf("].join('\\n');", a);
      assert.ok(a >= 0 && b > a, rel + ' 找不到 BASE_CSS');
      return src.slice(a, b);
    };
    assert.strictEqual(pick('src/reading/epub.js'), pick('src/reading/reader-source.js'),
      'epub.js 与 reader-source.js 的 BASE_CSS 已漂移');
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* noop */ }
    try { fs.rmdirSync(dir); } catch (e) { /* noop */ }
  }
});

// ---- V2.12 本机时间源（md_worktime）：聚合口径 + 契约白名单 + 只读边界 ----
const WT_DAY = Date.parse('2026-11-11T00:00:00+08:00');
const wtAt = function (h, m) { return new Date(WT_DAY + h * 3600000 + (m || 0) * 60000).toISOString(); };
const wtEv = function (h, m, min, app, title) {
  return { timestamp: wtAt(h, m), duration: min * 60, data: { app: app, title: title || '' } };
};

test('worktime', '契约：默认关闭、标题字段进不了库、非法 host 被拉回回环', function () {
  const empty = modWorktime.empty();
  assert.strictEqual(empty.enabled, false, '默认必须关闭');
  const dirty = modWorktime.normalize({
    enabled: true,
    host: 'http://evil.example.com:5600',
    days: { '2026-11-11': { activeSec: 600, apps: [['Code', 10]], title: '银行密码 - Chrome' } },
    rules: [{ id: 'r1', app: 'Code', label: '编程' }]
  });
  assert.strictEqual(dirty.host, '127.0.0.1:5600', '非回环 host 必须被拒并回落');
  const day = dirty.days['2026-11-11'];
  assert.ok(day, '日数据应该保留');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(day, 'title'), false, '契约里不允许存在 title 字段');
  const raw = JSON.stringify(dirty);
  assert.strictEqual(raw.indexOf('银行密码'), -1, '窗口标题一个字都不许进状态');
  assert.throws(function () { modWorktime.setHost(dirty, '192.168.1.9:5600'); }, /回环/);
});

test('worktime', '规则：空规则被拒、上限 40、CRUD 与排序', function () {
  let s = modWorktime.empty();
  assert.throws(function () { modWorktime.addRule(s, { label: '空' }); }, /应用名/);
  s = modWorktime.addRule(s, { app: 'Code.exe', label: '编程', target: { cell: 'work' } });
  s = modWorktime.addRule(s, { app: 'chrome', titleMatch: '污水|给排水', label: '项目A' });
  assert.strictEqual(s.rules.length, 2, '两条规则应写入');
  assert.strictEqual(s.rules[0].app, 'code', '应用名要归一化');
  assert.strictEqual(s.rules[1].target.cell, 'work', '未填格位时落工作格');
  const id = s.rules[0].id;
  s = modWorktime.updateRule(s, id, { label: '写代码' });
  assert.strictEqual(s.rules.filter(function (r) { return r.id === id; })[0].label, '写代码');
  s = modWorktime.removeRule(s, id);
  assert.strictEqual(s.rules.length, 1, '删除应生效');
  for (let i = 0; i < 45; i++) {
    try { s = modWorktime.addRule(s, { app: 'app' + i, label: 'x' }); } catch (e) { assert.strictEqual(e.code, 'RULE_LIMIT'); }
  }
  assert.strictEqual(s.rules.length, modWorktime.RULE_MAX, '规则必须封在 40 条');
});

test('worktime', '日数据：重同步保留已记标记、按 keepDays 裁剪', function () {
  let s = modWorktime.empty();
  s = modWorktime.applyDay(s, '2026-11-11', workAgg.aggregate({
    windowEvents: [wtEv(9, 0, 30, 'Code')], afkEvents: [], rules: [], dayStart: WT_DAY, dayEnd: WT_DAY + 86400000
  }));
  s = modWorktime.markWritten(s, '2026-11-11', '540-570');
  s = modWorktime.applyDay(s, '2026-11-11', workAgg.aggregate({
    windowEvents: [wtEv(9, 0, 60, 'Code')], afkEvents: [], rules: [], dayStart: WT_DAY, dayEnd: WT_DAY + 86400000
  }));
  assert.deepStrictEqual(s.days['2026-11-11'].written, ['540-570'], '重同步不许把「已记过」清掉');
  assert.strictEqual(s.days['2026-11-11'].activeSec, 3600, '时长应更新为新值');

  let many = modWorktime.setKeepDays(modWorktime.empty(), 30);
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    many = modWorktime.applyDay(many, d, { activeSec: 60, apps: [['code', 1]] });
  }
  assert.strictEqual(Object.keys(many.days).length, 30, '只保留 keepDays 天');
  assert.ok(many.days['2026-02-09'], '保留的应是最新 30 天');
  assert.strictEqual(many.days['2026-01-01'], undefined, '最旧的应被裁掉');
});

test('worktime', '回写：行格式、块键、幂等自愈（行在就不重复写）', function () {
  const line = modWorktime.blockLine([540, 615, 'r1'], '编程', 'Code');
  assert.strictEqual(line, '- 09:00–10:15 Code · 编程（75 分钟）');
  assert.strictEqual(modWorktime.blockKey([540, 615, 'r1']), '540-615');
  assert.strictEqual(modWorktime.hasLine('- 前面\n' + line + '\n- 后面', line), true);
  assert.strictEqual(modWorktime.hasLine('- 别的内容', line), false);
});

test('worktime', '周汇总：合并多天、未归类按已归类反算', function () {
  let s = modWorktime.addRule(modWorktime.empty(), { id: 'r1', app: 'code', label: '编程' });
  s = modWorktime.applyDay(s, '2026-11-10', { activeSec: 3600, windowSec: 3600, apps: [['code', 30], ['chrome', 30]], rules: [['r1', 30]] });
  s = modWorktime.applyDay(s, '2026-11-11', { activeSec: 1800, windowSec: 1800, apps: [['code', 30]], rules: [['r1', 30]] });
  const w = modWorktime.weekStats(s, ['2026-11-09', '2026-11-10', '2026-11-11']);
  assert.strictEqual(w.days, 2, '只有两天有数据');
  assert.strictEqual(w.activeMin, 90);
  assert.strictEqual(w.byRule[0].label, '编程');
  assert.strictEqual(w.byRule[0].min, 60);
  assert.strictEqual(w.unclassifiedRatio, 33, '未归类 = 30 / 90 ≈ 33%');
});

test('worktime', '备份合并：只补不改（本机已有的日期不被旧包覆盖）', function () {
  let s = modWorktime.applyDay(modWorktime.empty(), '2026-11-11', { activeSec: 7200, apps: [['code', 120]] });
  const res = modWorktime.mergeSection(s, {
    rules: [{ id: 'r1', app: 'code', label: '编程' }],
    days: { '2026-11-11': { activeSec: 60, apps: [['code', 1]] }, '2026-11-10': { activeSec: 1800, apps: [['chrome', 30]] } }
  });
  assert.strictEqual(res.added, 2, '一天 + 一条规则');
  assert.strictEqual(res.state.days['2026-11-11'].activeSec, 7200, '本机当天不许被旧包改小');
  assert.strictEqual(res.state.days['2026-11-10'].activeSec, 1800, '缺的日期应补进来');
  const again = modWorktime.mergeSection(res.state, res.state);
  assert.strictEqual(again.added, 0, '重复导入必须幂等');
});

test('worktime', '聚合：遮挡同名重叠不重复计时、跨午夜各取一半', function () {
  const r = workAgg.aggregate({
    windowEvents: [
      { timestamp: wtAt(9, 0), duration: 1800, data: { app: 'Code' } },
      { timestamp: wtAt(9, 20), duration: 1800, data: { app: 'Code' } }
    ],
    afkEvents: [], rules: [], dayStart: WT_DAY, dayEnd: WT_DAY + 86400000
  });
  assert.strictEqual(r.windowSec, 3000, '重叠段应削齐为 50 分钟');

  const cross = { timestamp: new Date(WT_DAY + 23 * 3600000 + 30 * 60000).toISOString(), duration: 3600, data: { app: 'Code' } };
  const a = workAgg.aggregate({ windowEvents: [cross], afkEvents: [], rules: [], dayStart: WT_DAY, dayEnd: WT_DAY + 86400000 });
  const b = workAgg.aggregate({ windowEvents: [cross], afkEvents: [], rules: [], dayStart: WT_DAY + 86400000, dayEnd: WT_DAY + 2 * 86400000 });
  assert.strictEqual(a.activeSec + b.activeSec, 3600, '跨午夜切两半，总和不许多算');
});

test('worktime', '聚合：AFK 并集扣除、零时长补全、规则 title 压过 app', function () {
  const r = workAgg.aggregate({
    windowEvents: [wtEv(9, 0, 60, 'Code')],
    afkEvents: [
      { timestamp: wtAt(9, 30), duration: 900, data: { status: 'afk' } },
      { timestamp: wtAt(9, 20), duration: 900, data: { status: 'afk' } }
    ],
    rules: [], dayStart: WT_DAY, dayEnd: WT_DAY + 86400000
  });
  assert.strictEqual(r.afkSec, 1500, 'AFK 取并集');
  assert.strictEqual(r.activeSec, 3600 - 1500, '活跃 = 窗口 - AFK');

  const zero = workAgg.aggregate({
    windowEvents: [
      { timestamp: wtAt(9, 0), duration: 0, data: { app: 'Code' } },
      wtEv(9, 3, 10, 'Chrome')
    ],
    afkEvents: [], rules: [], dayStart: WT_DAY, dayEnd: WT_DAY + 86400000
  });
  assert.strictEqual(zero.windowSec, 780, '零时长补到下一段起点');

  const rules = [
    { id: 'app', app: 'chrome', label: '浏览', order: 1 },
    { id: 'title', app: 'chrome', titleMatch: '污水|给排水', label: '项目A', order: 9 }
  ];
  assert.strictEqual(workAgg.matchRule('chrome', '污水处理方案', rules).id, 'title');
  assert.strictEqual(workAgg.matchRule('chrome', '知乎', rules).id, 'app');
});

test('worktime', '客户端：host 解析、bucket 选择只认本机、非回环拒绝', function () {
  assert.deepStrictEqual(workClient.parseHost('127.0.0.1:5600'), { hostname: '127.0.0.1', port: 5600 });
  assert.deepStrictEqual(workClient.parseHost('localhost'), { hostname: 'localhost', port: 5600 });
  assert.throws(function () { workClient.parseHost('10.0.0.5:5600'); }, /回环/);
  const buckets = {
    'aw-watcher-window_other': {},
    'aw-watcher-window_this': {},
    'aw-watcher-afk_this': {},
    'aw-watcher-web_this': {}
  };
  assert.strictEqual(workClient.pickBucket(buckets, 'aw-watcher-window_', 'this'), 'aw-watcher-window_this');
  assert.strictEqual(workClient.pickBucket(buckets, 'aw-watcher-window_', 'nope'), 'aw-watcher-window_other');
  assert.strictEqual(workClient.pickBucket(buckets, 'aw-watcher-afk_', 'this'), 'aw-watcher-afk_this');
  assert.strictEqual(workClient.pickBucket(buckets, 'aw-watcher-web_', 'this'), 'aw-watcher-web_this');
});

// ============================================================
// 家庭账本（md_finance）：整数分 / 信封预算 / 条件→动作规则 / CSV 导入
// ============================================================
// 一份 GBK 编码的支付宝样例（前两行是说明文字、金额列叫「金额」、收支列叫「收/支」），
// 内嵌 base64 是为了让本套件纯 Node 可跑，不依赖任何外部文件或第三方库。
const FIN_GBK_B64 = '1qe4trGmvbvS18P3z7gKtbyz9sqxvOSjujIwMjYtMTEtMTEKvbvS18qxvOQsvfC27izK1S/Wpyy9u9LXttS3vSyxuNeiLL270tfXtMysLL270te2qbWlusUKMjAyNi0xMS0wMSAxMDowMDowMCwxMi4zMCzWp7P2LNChud0sIs7nt7ksvNO1sCIsvbvS17PJuaYsQTEKMjAyNi0xMS0wMiAxMTowMDowMCw1MDAwLjAwLMrVyOssuavLviy5pNfKLL270tezybmmLEEyCjIwMjYtMTEtMDMgMTI6MDA6MDAsOC4wMCzWp7P2LMSzteoszcu/7izS0c3Lv+4sQTMK';

test('v2', 'finance/board：金额全程整数分，元只在 formatCents 出现', function () {
  assert.strictEqual(modFinance.parseAmountCents('¥1,234.50'), 123450);
  assert.strictEqual(modFinance.parseAmountCents('-12.3'), -1230);
  assert.strictEqual(modFinance.parseAmountCents('(12.34)'), -1234);
  assert.strictEqual(modFinance.parseAmountCents('12元'), 1200);
  assert.strictEqual(modFinance.parseAmountCents('1,234'), 123400);
  assert.strictEqual(modFinance.formatCents(-123450), '-1234.50');
  assert.strictEqual(modFinance.formatCents(7), '0.07');
  assert.strictEqual(modFinance.parseAmountCents('0.1') + modFinance.parseAmountCents('0.2'), 30);
});

test('v2', 'finance/normalize：白名单收敛、幂等、空库播种默认分类', function () {
  const fresh = modFinance.normalize(null);
  assert.strictEqual(fresh.version, 1);
  assert.strictEqual(fresh.txns.length, 0);
  assert.ok(fresh.categories.length >= 10, '空库要有默认分类');
  assert.ok(fresh.accounts.length >= 4, '空库要有默认账户');
  const dirty = modFinance.normalize({
    txns: [{ date: '2026-02-30', amountCents: 1.9, kind: 'hack', evil: 'x' }], junk: 1
  });
  assert.strictEqual(dirty.txns[0].date, '', '非法日期应丢弃');
  assert.strictEqual(dirty.txns[0].amountCents, 2, '金额收敛为整数');
  assert.strictEqual(dirty.txns[0].kind, 'expense', '未知类型收敛到白名单');
  assert.ok(!('evil' in dirty.txns[0]), '未知字段不得保留');
  assert.ok(!('junk' in dirty), '未知顶层字段不得保留');
  assert.deepStrictEqual(modFinance.normalize(dirty), dirty, 'normalize 必须幂等');
  const emptied = modFinance.normalize({ categories: [], accounts: [], txns: [], budgets: [], rules: [] });
  assert.strictEqual(emptied.categories.length, 0, '用户主动删空的分类不许被重新种回来');
});

test('v2', 'finance/board：转账双腿互指且不计入支出，删除带走对侧', function () {
  let s = modFinance.normalize(null);
  s = modFinance.addTxn(s, { date: '2026-11-03', kind: 'expense', amountCents: -3250, category: 'cat_food', payee: '小馆' });
  s = modFinance.addTxn(s, { date: '2026-11-04', kind: 'income', amountCents: 1200000, category: 'cat_salary' });
  s = modFinance.addTxn(s, { date: '2026-11-05', kind: 'transfer', amountCents: 100000, account: 'acc_bank', toAccount: 'acc_cash' });
  assert.strictEqual(s.txns.length, 4);
  const legs = s.txns.filter(function (t) { return t.kind === 'transfer'; });
  assert.strictEqual(legs.length, 2);
  assert.strictEqual(legs[0].amountCents + legs[1].amountCents, 0, '转账两腿必须相消');
  assert.strictEqual(legs[0].transferId, legs[1].id);
  const b = modFinance.board(s, '2026-11');
  assert.strictEqual(b.totals.expenseCents, 3250);
  assert.strictEqual(b.totals.incomeCents, 1200000);
  assert.strictEqual(b.totals.netCents, 1196750);
  assert.strictEqual(b.totals.transferCents, 0, '转账不能污染收支统计');
  assert.strictEqual(b.byCategory[0].name, '餐饮');
  const after = modFinance.removeTxn(s, legs[0].id);
  assert.strictEqual(after.txns.length, 2, '删一条转账必须同时删掉对侧');
});

test('v2', 'finance/预算：信封结转、关闭结转、超支为负', function () {
  let z = modFinance.normalize(null);
  z = modFinance.setBudget(z, { month: '2026-10', category: 'cat_food', limitCents: 50000, rollover: true });
  z = modFinance.addTxn(z, { date: '2026-10-05', kind: 'expense', amountCents: -1000, category: 'cat_food' });
  const r = modFinance.board(z, '2026-11').budgets.filter(function (x) { return x.category === 'cat_food'; })[0];
  assert.strictEqual(r.carryInCents, 49000, '上月未花完的应结转');
  assert.strictEqual(r.remainingCents, 99000, '本月额度 + 结转 = 可用');

  let z2 = modFinance.normalize(null);
  z2 = modFinance.setBudget(z2, { month: '2026-10', category: 'cat_food', limitCents: 50000, rollover: false });
  z2 = modFinance.addTxn(z2, { date: '2026-10-05', kind: 'expense', amountCents: -1000, category: 'cat_food' });
  const r2 = modFinance.board(z2, '2026-11').budgets.filter(function (x) { return x.category === 'cat_food'; })[0];
  assert.strictEqual(r2.carryInCents, 0, '关闭结转后不带余额');
  assert.strictEqual(r2.remainingCents, 50000);

  let z3 = modFinance.setBudget(modFinance.normalize(null), { month: '2026-11', category: 'cat_food', limitCents: 1000 });
  z3 = modFinance.addTxn(z3, { date: '2026-11-01', kind: 'expense', amountCents: -2000, category: 'cat_food' });
  const r3 = modFinance.board(z3, '2026-11').budgets.filter(function (x) { return x.category === 'cat_food'; })[0];
  assert.strictEqual(r3.remainingCents, -1000, '超支要如实为负，不许夹到 0');
  assert.ok(r3.usedBp > 10000, '超支进度应超过 100%');
});

test('v2', 'finance/规则：条件→动作按优先级串行、stop 生效', function () {
  let r = modFinance.normalize(null);
  r = modFinance.addRule(r, {
    name: '午饭归餐饮', priority: 10, stop: true, match: 'all',
    conditions: [{ field: 'note', op: 'contains', value: '午饭' }],
    actions: [{ type: 'setCategory', value: 'cat_food' }, { type: 'setNote', value: '已归类' }]
  });
  r = modFinance.addRule(r, {
    name: '小额打标', priority: 5, stop: false, match: 'all',
    conditions: [{ field: 'amountCents', op: 'gte', value: '1000' }],
    actions: [{ type: 'setPayee', value: '小额商户' }]
  });
  const out = modFinance.applyRules(r, { note: '午饭,加蛋', amountCents: -3250, category: '', payee: '' });
  assert.strictEqual(out.txn.payee, '小额商户', '优先级小的先跑');
  assert.strictEqual(out.txn.category, 'cat_food');
  assert.strictEqual(out.txn.note, '已归类', '后一条规则看得到前一条改过的值');
  assert.strictEqual(out.ruleIds.length, 2);

  let s = modFinance.normalize(null);
  s = modFinance.addRule(s, {
    name: '首条命中即止', priority: 1, stop: true,
    conditions: [{ field: 'payee', op: 'eq', value: 'A' }],
    actions: [{ type: 'setCategory', value: 'cat_food' }]
  });
  s = modFinance.addRule(s, {
    name: '不该跑', priority: 2,
    conditions: [{ field: 'payee', op: 'eq', value: 'A' }],
    actions: [{ type: 'setPayee', value: 'B' }]
  });
  const stopped = modFinance.applyRules(s, { payee: 'A' });
  assert.strictEqual(stopped.ruleIds.length, 1, 'stop 必须截断后续规则');
  assert.strictEqual(stopped.txn.payee, 'A');
});

test('v2', 'finance/CSV：GBK 嗅探、说明行跳过、引号逗号、退款排除、收入方向', function () {
  const out = modFinance.importCsv(modFinance.normalize(null), { data: FIN_GBK_B64, filename: '支付宝交易明细.csv' });
  assert.strictEqual(out.report.encoding, 'gbk');
  assert.strictEqual(out.report.platform, 'alipay');
  assert.strictEqual(out.report.headerLine, 3, '前两行说明文字要跳过');
  assert.strictEqual(out.report.added, 2);
  assert.strictEqual(out.report.skipped, 1, '已退款行要排除');
  assert.strictEqual(out.report.duplicates, 0);
  assert.strictEqual(out.state.txns[0].amountCents, -1230);
  assert.strictEqual(out.state.txns[0].note, '午饭,加蛋', '引号内的逗号不能被切列');
  assert.strictEqual(out.state.txns[1].kind, 'income', '收/支=收入 不能记成支出');
  assert.strictEqual(out.state.txns[1].amountCents, 500000);
  assert.ok(out.state.txns[0].importedId.indexOf('imp_') === 0);
});

test('v2', 'finance/CSV：UTF-8 BOM、日期斜杠、重复导入零新增', function () {
  const text = '交易时间,金额,收/支,交易对方,备注\n2026/11/6,3.50,支出,便利店,矿泉水\n';
  const b64 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]).toString('base64');
  const out = modFinance.importCsv(modFinance.normalize(null), { data: b64, filename: '微信支付账单.csv' });
  assert.strictEqual(out.report.encoding, 'utf-8-bom');
  assert.strictEqual(out.report.added, 1);
  assert.strictEqual(out.state.txns[0].date, '2026-11-06', '2026/11/6 要规整成 YYYY-MM-DD');
  assert.strictEqual(out.state.txns[0].amountCents, -350);

  const first = modFinance.importCsv(modFinance.normalize(null), { data: FIN_GBK_B64, filename: '支付宝交易明细.csv' });
  const again = modFinance.importCsv(first.state, { data: FIN_GBK_B64, filename: '支付宝交易明细.csv' });
  assert.strictEqual(again.report.added, 0, '同一份文件重复导入不许新增');
  assert.strictEqual(again.report.duplicates, 2);
  assert.strictEqual(again.state.txns.length, first.state.txns.length);
});

test('v2', 'finance/CSV：缺表头要如实报错，不再造位置 0 假命中', function () {
  const b64 = Buffer.from('随便一列\n没有日期也没有金额\n', 'utf8').toString('base64');
  const out = modFinance.importCsv(modFinance.normalize(null), { data: b64, filename: 'x.csv' });
  assert.strictEqual(out.report.added, 0);
  assert.strictEqual(out.report.headerLine, -1);
  assert.ok(out.report.errors.length > 0);
});

test('v2', 'finance/导出与备份合并：只补不改、二次幂等', function () {
  const out = modFinance.importCsv(modFinance.normalize(null), { data: FIN_GBK_B64, filename: '支付宝交易明细.csv' });
  const csv = modFinance.exportCsv(out.state);
  assert.ok(csv.indexOf('金额(元)') >= 0);
  assert.ok(csv.indexOf('-12.30') >= 0, '导出也要按整数分还原成元');
  const merged = modFinance.mergeSection(modFinance.normalize(null), out.state);
  assert.strictEqual(merged.state.txns.length, 2);
  assert.strictEqual(merged.added, 2);
  const twice = modFinance.mergeSection(merged.state, out.state);
  assert.strictEqual(twice.added, 0, '合并必须幂等');
  assert.strictEqual(twice.state.txns.length, 2);
});

test('v2', 'finance/日期与月份：非法值一律丢弃，不读时钟', function () {
  assert.strictEqual(modFinance.validDate('2026-02-30'), '');
  assert.strictEqual(modFinance.validDate('2026-11-03'), '2026-11-03');
  assert.strictEqual(modFinance.validMonth('2026-13'), '');
  assert.strictEqual(modFinance.validMonth('2026-09'), '2026-09');
  const b = modFinance.board(modFinance.normalize(null), '2026-11');
  assert.strictEqual(b.totals.netCents, 0);
  assert.strictEqual(b.trend.length, 6);
  assert.deepStrictEqual(modFinance.parseCsv('a,b\n1,"x,y"\n'), [['a', 'b'], ['1', 'x,y']]);
});

test('v2', 'finance/接线：领域函数过白名单、API 往返不丢整数分', function () {
  const ctx = makeRepo(fresh('finance-api'));
  const lc = createLifecycle(ctx.repo);
  let st = modFinance.normalize(null);
  const domain = {
    'finance.board': function (m) { return modFinance.board(st, m); },
    'finance.add': function (d) { st = modFinance.addTxn(st, d); return st; },
    'finance.importCsv': function (o) {
      const out = modFinance.importCsv(st, o);
      if (out.report.added > 0) st = out.state;
      return out.report;
    }
  };
  const api = createApiLayer({ repository: ctx.repo, lifecycle: lc, domain: domain });
  const added = api.handle('v1/domain:call', {
    name: 'finance.add', args: [{ date: '2026-11-03', kind: 'expense', amountCents: -3250, category: 'cat_food' }]
  });
  assert.strictEqual(added.code, 'OK');
  const b = api.handle('v1/domain:call', { name: 'finance.board', args: ['2026-11'] });
  assert.strictEqual(b.data.totals.expenseCents, 3250, '过一层 IPC 后仍是整数分');
  const bad = api.handle('v1/domain:call', { name: 'finance.nope', args: [] });
  assert.strictEqual(bad.code, 'CLIENT_EXCEPTION', '未登记的函数必须被白名单挡住');
  const imp = api.handle('v1/domain:call', {
    name: 'finance.importCsv', args: [{ data: FIN_GBK_B64, filename: '支付宝交易明细.csv' }]
  });
  assert.strictEqual(imp.code, 'OK');
  assert.strictEqual(imp.data.added, 2);
  ctx.journal.close();
});

// ------------------------------------------------------------
// 独立账本窗口：账户 / 净值 / 损益 / 目标 / 周期 / 订阅 / 检索 / 批量 / 洞察
// ------------------------------------------------------------
function finSeed() {
  let s = modFinance.normalize(null);
  s = modFinance.setAccountMeta(s, 'acc_bank', { openingCents: 1000000, side: 'asset' });
  s = modFinance.addTxn(s, { date: '2026-11-02', kind: 'income', amountCents: 800000, category: 'cat_salary', account: 'acc_bank' });
  s = modFinance.addTxn(s, { date: '2026-11-03', kind: 'expense', amountCents: -3250, category: 'cat_food', account: 'acc_alipay', payee: '楼下小馆' });
  s = modFinance.addTxn(s, { date: '2026-11-04', kind: 'expense', amountCents: -12000, category: 'cat_house', account: 'acc_bank' });
  return s;
}

test('v2', 'finance/资产负债表：期初 + 流水推余额，净值按余额符号算', function () {
  const nw = modFinance.netWorth(finSeed(), '2026-11');
  assert.strictEqual(nw.assetsCents, 1788000);
  assert.strictEqual(nw.liabilitiesCents, 3250);
  assert.strictEqual(nw.netCents, 1784750);
  assert.strictEqual(nw.accounts.length, 4);
  assert.strictEqual(nw.series.length, 6);
  assert.strictEqual(nw.groups[0].assetCents, 1788000);
  assert.strictEqual(nw.groups[0].liabilityCents, 3250);
  // 转账两条互指、金额相消，不能凭空多出净值
  let s = modFinance.addTxn(finSeed(), { date: '2026-11-05', kind: 'transfer', amountCents: 5000, account: 'acc_bank', toAccount: 'acc_alipay' });
  assert.strictEqual(modFinance.netWorth(s, '2026-11').netCents, 1784750, '转账不能改变净资产');
});

test('v2', 'finance/损益表与分类环比：整数分、基点在展示层之外算好', function () {
  const cf = modFinance.cashFlow(finSeed(), '2026-11');
  assert.strictEqual(cf.incomeCents, 800000);
  assert.strictEqual(cf.expenseCents, 15250);
  assert.strictEqual(cf.netCents, 784750);
  assert.strictEqual(cf.savingBp, 9809);
  assert.strictEqual(cf.months.length, 6);
  const rep = modFinance.categoryReport(finSeed(), '2026-11');
  assert.strictEqual(rep.prevMonth, '2026-10');
  assert.strictEqual(rep.totalCents, 15250);
  assert.strictEqual(rep.rows.length, 2);
  assert.strictEqual(rep.rows[0].spentCents, 12000);
  assert.strictEqual(rep.rows[0].shareBp + rep.rows[1].shareBp, 10000);
});

test('v2', 'finance/目标：进度基点、追加存款、删除都保持整数分', function () {
  let s = modFinance.addGoal(finSeed(), { name: '应急基金', targetCents: 5000000, savedCents: 1250000 });
  assert.strictEqual(modFinance.goalRows(s)[0].progressBp, 2500);
  assert.strictEqual(modFinance.goalRows(s)[0].remainingCents, 3750000);
  s = modFinance.updateGoal(s, 'goal_1', { savedCents: 1500000 });
  assert.strictEqual(modFinance.goalRows(s)[0].progressBp, 3000);
  s = modFinance.removeGoal(s, 'goal_1');
  assert.strictEqual(modFinance.goalRows(s).length, 0);
  assert.strictEqual(modFinance.addGoal(s, { name: '空目标', targetCents: 0 }).goals.length, 0, '零额度目标不该入库');
});

test('v2', 'finance/周期账单：只给建议不写库，季度不落到非季度月', function () {
  let s = modFinance.addRecurring(finSeed(), {
    name: '房租', payee: '房东', amountCents: -300000, category: 'cat_house',
    account: 'acc_bank', startDate: '2026-01-05', interval: 'monthly'
  });
  assert.strictEqual(s.txns.length, 3, '建周期账单绝不能自动写流水');
  let due = modFinance.recurringRows(s, '2026-11');
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].date, '2026-11-05');
  assert.strictEqual(due[0].recorded, false);
  s = modFinance.addTxn(s, { date: '2026-11-05', kind: 'expense', amountCents: -300000, category: 'cat_house', account: 'acc_bank', payee: '房东' });
  assert.strictEqual(modFinance.recurringRows(s, '2026-11')[0].recorded, true, '同月同对方同金额应判为已记');
  let q = modFinance.addRecurring(finSeed(), { name: '季费', amountCents: -9000, startDate: '2026-01-05', interval: 'quarterly' });
  assert.strictEqual(modFinance.recurringRows(q, '2026-11').length, 0, '11 月不是 1 月起算的季度月');
  assert.strictEqual(modFinance.recurringRows(q, '2026-10').length, 1);
});

test('v2', 'finance/订阅识别：连续月且金额接近才算，单次消费不误判', function () {
  let s = finSeed();
  for (let i = 1; i <= 3; i++) {
    s = modFinance.addTxn(s, { date: '2026-0' + i + '-05', kind: 'expense', amountCents: -1500, category: 'cat_sub', payee: '视频会员', account: 'acc_alipay' });
  }
  const subs = modFinance.detectSubscriptions(s);
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].payee, '视频会员');
  assert.strictEqual(subs[0].typicalCents, 1500);
  assert.strictEqual(subs[0].count, 3);
  assert.strictEqual(modFinance.detectSubscriptions(modFinance.normalize(null)).length, 0);
});

test('v2', 'finance/检索与批量修正：金额区间用分比较，批量不重跑规则', function () {
  let s = finSeed();
  for (let i = 1; i <= 3; i++) {
    s = modFinance.addTxn(s, { date: '2026-0' + i + '-05', kind: 'expense', amountCents: -1500, category: 'cat_sub', payee: '视频会员', account: 'acc_alipay' });
  }
  assert.strictEqual(modFinance.searchTxns(s, { keyword: '会员' }).length, 3);
  assert.strictEqual(modFinance.searchTxns(s, { minCents: 1000, maxCents: 2000 }).length, 3);
  assert.strictEqual(modFinance.searchTxns(s, { from: '2026-02-01', to: '2026-02-28' }).length, 1);
  assert.strictEqual(modFinance.searchTxns(s, { kind: 'income' }).length, 1);
  const ids = modFinance.searchTxns(s, { keyword: '会员' }).map(function (t) { return t.id; });
  const out = modFinance.bulkUpdate(s, ids, { category: 'cat_fun', payee: '不该被改' });
  assert.strictEqual(out.updated, 3);
  const after = out.state.txns.filter(function (t) { return ids.indexOf(t.id) >= 0; });
  assert.strictEqual(after[0].category, 'cat_fun');
  assert.strictEqual(after[0].payee, '视频会员', '白名单外的字段必须被丢弃');
  assert.deepStrictEqual(after[0].ruleIds, [], '批量修正不重跑规则');
});

test('v2', 'finance/洞察：没设额度不报超支，设了才如实报', function () {
  let s = finSeed();
  assert.strictEqual(modFinance.insights(s, '2026-11').overspent.length, 0);
  s = modFinance.setBudget(s, { month: '2026-11', category: 'cat_food', limitCents: 1000, rollover: true });
  const ins = modFinance.insights(s, '2026-11');
  assert.strictEqual(ins.overspent.length, 1);
  assert.strictEqual(ins.overspent[0].overCents, 2250);
  assert.strictEqual(ins.netWorthCents, 1784750);
  assert.strictEqual(ins.subscriptionCents, 0);
  assert.strictEqual(ins.topCategory.spentCents, 12000);
});

test('v2', 'finance/新段落：normalize 白名单、老数据兼容、mergeSection 幂等', function () {
  const dirty = modFinance.normalize({
    goals: [{ id: 'goal_1', name: 'X', targetCents: 100, evil: 1 }],
    recurring: [{ id: 'rec_1', name: 'Y', amountCents: -500, startDate: '2026-01-01', evil: 2 }]
  });
  assert.strictEqual(dirty.goals[0].evil, undefined, '未知字段必须被削掉');
  assert.strictEqual(dirty.recurring[0].evil, undefined);
  assert.deepStrictEqual(modFinance.normalize(dirty), dirty, 'normalize 必须幂等');
  const old = modFinance.normalize({ txns: [], categories: [], accounts: [], budgets: [], rules: [] });
  assert.strictEqual(old.goals.length, 0, 'V1 老账本读进来新段落为空');
  assert.strictEqual(old.recurring.length, 0);
  // section 要显式给全空段：只给 goals 会被当成「空库」而重新播种默认分类/账户。
  const section = {
    categories: [], accounts: [], txns: [], budgets: [], rules: [], recurring: [],
    goals: [{ id: 'goal_9', name: 'Z', targetCents: 200 }]
  };
  const merged = modFinance.mergeSection(old, section);
  assert.strictEqual(merged.added, 1);
  assert.strictEqual(modFinance.mergeSection(merged.state, section).added, 0);
});

test('v2', 'finance/手记收支导入：符号、去重指纹、分类兜底、幂等', function () {
  const s = modFinance.normalize(null);
  const rows = [
    { id: 'e1', date: '2026-11-03', type: 'expense', cents: 1250, category: 'food', note: '午饭' },
    { id: 'e2', date: '2026-11-04', type: 'income', cents: 500000, category: 'other', note: '工资' }
  ];
  const one = modFinance.importMoneyBook(s, rows);
  assert.strictEqual(one.added, 2);
  assert.strictEqual(one.skipped, 0);
  assert.strictEqual(one.state.txns.length, 2);
  assert.strictEqual(one.state.txns[0].amountCents, -1250, '支出落成负整数分');
  assert.strictEqual(one.state.txns[1].amountCents, 500000, '收入落成正整数分');
  assert.ok(one.state.txns.every(function (t) { return t.importedId.indexOf('mb:') === 0; }));
  assert.ok(one.state.txns.every(function (t) { return t.ruleIds.length === 0; }), '导入不重跑规则');
  const two = modFinance.importMoneyBook(one.state, rows);
  assert.strictEqual(two.added, 0, '同一笔手记重复导入零新增');
  assert.strictEqual(two.skipped, 2);
  assert.deepStrictEqual(modFinance.normalize(two.state), two.state, '导入后 normalize 幂等');
  const bad = modFinance.importMoneyBook(s, [
    { id: 'x', date: '2026-02-30', type: 'expense', cents: 100, category: 'food', note: '' }
  ]);
  assert.strictEqual(bad.added, 0, '非法日期不入库');
});

test('v2', 'finance/窗口接线：新增领域函数过白名单、开窗通道已注册', function () {
  const ctx = makeRepo(fresh('finance-window-api'));
  const lc = createLifecycle(ctx.repo);
  let st = finSeed();
  const domain = {
    'finance.netWorth': function (m) { return modFinance.netWorth(st, m); },
    'finance.addGoal': function (p) { st = modFinance.addGoal(st, p); return st; },
    'finance.bulkUpdate': function (ids, patch) {
      const out = modFinance.bulkUpdate(st, ids, patch);
      st = out.state;
      return out.updated;
    }
  };
  const api = createApiLayer({ repository: ctx.repo, lifecycle: lc, domain: domain, financeOpener: function () { return { ok: true, reused: false }; } });
  const nw = api.handle('v1/domain:call', { name: 'finance.netWorth', args: ['2026-11'] });
  assert.strictEqual(nw.code, 'OK');
  assert.strictEqual(nw.data.netCents, 1784750, '过一层 IPC 后净值仍是整数分');
  const g = api.handle('v1/domain:call', { name: 'finance.addGoal', args: [{ name: 'G', targetCents: 1000 }] });
  assert.strictEqual(g.code, 'OK');
  const win = api.handle('v1/finance:open', {});
  assert.strictEqual(win.code, 'OK');
  assert.strictEqual(win.data.ok, true);
  const blocked = api.handle('v1/domain:call', { name: 'finance.notRegistered', args: [] });
  assert.strictEqual(blocked.code, 'CLIENT_EXCEPTION');
  ctx.journal.close();
});

// ---------- 自由记录（md_freewrite）+ 写作法体检（docs/28）----------
const modFree = require(path.resolve(__dirname, '../../src/free/board.js'));
const modWriting = require(path.resolve(__dirname, '../../src/writing/check.js'));

test('v2', 'free/新段落：normalize 幂等、脏数据白名单、mergeSection 只补不改', function () {
  const a = modFree.normalize(null);
  assert.deepStrictEqual(a, modFree.normalize(a));
  const s = modFree.addFlash(a, { text: '周末导照片', date: '2026-11-12' });
  assert.strictEqual(s.flashes[0].sync, 'pending');
  assert.ok(s.flashes[0].source.length <= 32, 'source 超过 gtd 上限');
  assert.deepStrictEqual(s, modFree.normalize(s));
  const d = modFree.addDoc(s, { title: '', body: '字'.repeat(25000) });
  assert.strictEqual(d.docs[0].body.length, 20000, '长文上限不是 2 万字');
  assert.strictEqual(d.docs[0].title, '未命名长文');
  const dirty = modFree.normalize({ flashes: [{ id: 'x', text: ' y ', evil: 1 }], evil: 1 });
  assert.deepStrictEqual(dirty, modFree.normalize(dirty));
  assert.strictEqual(Object.keys(dirty.flashes[0]).indexOf('evil'), -1);
  const m = modFree.mergeSection(a, d);
  assert.ok(m.added >= 2);
  assert.strictEqual(modFree.mergeSection(m.state, d).added, 0, '第二次合并又补了一遍');
});

test('v2', 'free/写作法体检：长句分级、弱化词定位、逐句拼接不丢字、永不改写', function () {
  const first = '他非常慢慢地被进行了一番说明，其实没有予以解释。';
  const text = first + '字'.repeat(65) + '。';
  const r = modWriting.analyze(text);
  assert.strictEqual(r.sentences[1].level, 'hard');
  assert.ok(r.counts.weak >= 3);
  assert.ok(r.counts.passive >= 1 && r.counts.heavy >= 2);
  assert.strictEqual(r.sentences.map(function (x) { return x.text; }).join(''), text);
  assert.strictEqual(r.sentences[0].text, first, '体检改写了原文');
});

test('v2', 'free/接线：白名单、备份注入与导入、打包清单三处齐', function () {
  const api = fs.readFileSync(path.resolve(__dirname, '../../src/core/api-layer.js'), 'utf8');
  const main = fs.readFileSync(path.resolve(__dirname, '../../src/main/main-v2.js'), 'utf8');
  const yml = fs.readFileSync(path.resolve(__dirname, '../../electron-builder-v2.yml'), 'utf8');
  ['free.board', 'free.flashAdd', 'free.docAdd', 'writing.check'].forEach(function (k) {
    assert.ok(api.indexOf("'" + k + "'") >= 0, '白名单缺 ' + k);
  });
  assert.ok(main.indexOf('obj.freewrite = freeStore.read()') >= 0, '备份没带新键');
  assert.ok(main.indexOf("['freewrite', freeStore, freeMod]") >= 0, '导入没接新键');
  assert.ok(yml.indexOf('src/free/**/*') >= 0 && yml.indexOf('src/writing/**/*') >= 0, '打包清单漏了');
});

test('dream', '证据回流：近 30 天完成的任务 / 存入的钱才算「在推」，过期记录不算（V3.8）', function () {
  const day = function (iso) { return new Date(iso + 'T10:00:00').getTime(); };
  let s = dreamBoard.empty();
  s = dreamBoard.add(s, { title: '每周运动 3 次', area: 'health', horizon: 'short' });
  const id = s.dreams[0].id;
  s = dreamBoard.linkTask(s, id, 't-old');
  s = dreamBoard.linkTask(s, id, 't-new');
  s = dreamBoard.linkTask(s, id, 't-open');
  const tasks = [
    { id: 't-old', title: '两个月前做的', status: 'done', doneAt: day('2026-09-01') },
    { id: 't-new', title: '上周做的', status: 'done', doneAt: day('2026-11-12') },
    { id: 't-open', title: '还没做的', status: 'next', doneAt: 0 }
  ];
  const b = dreamBoard.board(s, tasks, '2026-11-15');
  const row = b.rows[0];
  assert.strictEqual(row.evidence.windowDays, 30, '证据窗口不是 30 天');
  assert.strictEqual(row.evidence.doneCount, 1, '窗口内完成数算错：' + row.evidence.doneCount);
  assert.deepStrictEqual(row.evidence.doneTitles, ['上周做的'], '窗口外的完成被算成了证据');
  assert.strictEqual(row.evidence.lastDoneDate, '2026-11-12');
  assert.strictEqual(row.evidence.has, true);
  assert.strictEqual(b.stats.evidenceCount, 1);
  assert.strictEqual(b.stats.staleCount, 0);
  assert.strictEqual(b.evidenceDays, 30);

  // 把唯一一条窗口内完成抽走 → 同一目标立刻变「挂着」，且不靠进度条判断
  const b2 = dreamBoard.board(s, [tasks[0], tasks[2]], '2026-11-15');
  assert.strictEqual(b2.rows[0].evidence.has, false, '30 天前的完成仍被算作证据');
  assert.strictEqual(b2.rows[0].evidence.doneCount, 0);
  assert.strictEqual(b2.stats.evidenceCount, 0);
  // 但刚建的目标不算「挂着」：还没到能说「没动」的时候
  assert.strictEqual(b2.stats.staleCount, 0, '刚建的目标被判成「30 天没动」');
  const oldState = dreamBoard.normalize({
    dreams: [{ id: 'dr-old', title: '半年前定的', status: 'doing', progress: 30, createdAt: day('2026-05-01') }]
  });
  const bOld = dreamBoard.board(oldState, [], '2026-11-15');
  assert.strictEqual(bOld.stats.staleCount, 1, '建了半年的零证据目标没算挂着');
  assert.strictEqual(bOld.stats.evidenceCount, 0);

  // 存款有日期可回查，单独也能当证据；本窗口外的存款不算
  let s3 = dreamBoard.empty();
  s3 = dreamBoard.add(s3, { title: '换工作站' });
  const i3 = s3.dreams[0].id;
  s3 = dreamBoard.setFund(s3, i3, 1000000);
  s3 = dreamBoard.deposit(s3, i3, 300000, '2026-11-10', '', 'money');
  const r3 = dreamBoard.board(s3, [], '2026-11-15').rows[0];
  assert.strictEqual(r3.evidence.has, true, '窗口内存款没算证据');
  assert.ok(r3.evidence.text.indexOf('存入') >= 0, '存款证据没写清来源：' + r3.evidence.text);
  s3 = dreamBoard.deposit(s3, i3, 100000, '2026-08-01', '', 'money');
  const r4 = dreamBoard.board(s3, [], '2026-11-15').rows[0];
  assert.strictEqual(r4.evidence.depositCount, 1, '窗口外存款被算进来了');
  assert.strictEqual(r4.evidence.lastDepositDate, '2026-11-10', '最近一笔存款取错');

  // 什么都没挂：要说得清是「没挂事」，不是含糊的「没推动」
  const bare = dreamBoard.board(dreamBoard.add(dreamBoard.empty(), { title: '空目标' }), [], '2026-11-15');
  assert.ok(bare.rows[0].evidence.text.indexOf('还没挂') >= 0, '空目标文案不诚实：' + bare.rows[0].evidence.text);
  // 任务列表整个缺失也不能崩（老数据 / 首启没有 md_gtd）
  assert.strictEqual(dreamBoard.board(s, undefined, '2026-11-15').stats.evidenceCount, 0);
});

test('v2', 'metrics/成效侧：完成 / 目标推进 / 阅读推进 / 复盘只记次数，不记标题与答案（V3.8）', function () {
  const os = require('os');
  const { createMetrics, ALLOWED } = require(path.resolve(__dirname, '../../src/core/metrics.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-outcome-'));
  const m = createMetrics(dir);

  // ① 白名单只放行计数与枚举，正文类字段即使硬塞也写不进去
  ['outcome_task_done', 'outcome_dream_move', 'outcome_read_move', 'outcome_review'].forEach(function (k) {
    assert.ok(ALLOWED[k], '成效侧缺白名单：' + k);
  });
  const ts = new Date().toISOString();
  m.record('outcome_task_done', { ts: ts, date: '2026-11-15', n: 3, title: '绝不该出现的任务标题' });
  m.record('outcome_dream_move', { ts: ts, date: '2026-11-15', kind: 'progress', title: '绝不该出现的目标名' });
  m.record('outcome_read_move', { ts: ts, date: '2026-11-15', n: 1 });
  m.record('outcome_review', { ts: ts, date: '2026-11-15', period: 'week', text: '绝不该出现的复盘答案' });
  const raw = fs.readFileSync(m.file, 'utf8');
  assert.ok(raw.indexOf('绝不该出现') < 0, '成效指标里出现了正文');

  // ② 汇总真的算出来，且与「近 7 / 近 30 天」同口径
  const o = m.summary().outcome;
  assert.strictEqual(o.available, true);
  assert.strictEqual(o.events, 4);
  assert.strictEqual(o.total.taskDone, 3, 'n 没累加：' + o.total.taskDone);
  assert.strictEqual(o.window7.taskDone, 3);
  assert.strictEqual(o.window30.taskDone, 3);
  assert.strictEqual(o.window7.dreamMove, 1);
  assert.strictEqual(o.window7.readMove, 1);
  assert.strictEqual(o.window7.review, 1);
  assert.strictEqual(o.total.dreamMove, 1);

  // ③ 一条成效事件都没有时 available=false：界面据此写「还没有」，不是一排 0
  const empty = createMetrics(fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-outcome0-')));
  const o0 = empty.summary().outcome;
  assert.strictEqual(o0.available, false);
  assert.strictEqual(o0.events, 0);

  // ④ 接线：四类事件由 domain:call 成功后才记；只认参数键名，不读值
  const api = fs.readFileSync(path.resolve(__dirname, '../../src/core/api-layer.js'), 'utf8');
  ['gtd.complete', 'reading.advanceBook', 'reading.readerProgress', 'dream.deposit', 'dream.update', 'saveReview'].forEach(function (n) {
    assert.ok(api.indexOf("'" + n + "'") >= 0, '成效侧漏了接线：' + n);
  });
  assert.ok(api.indexOf('function outcomeEvent') >= 0, '成效事件没有统一判定函数');
  assert.ok(api.indexOf('patch.metric !== undefined') >= 0 && api.indexOf('patch.title') < 0,
    '目标推进在按值判断（读值就有机会把标题写进日志）');
  assert.ok(api.indexOf('trim().length > 0') >= 0, '复盘落成没区分「真的写了」与「清空答案」');
  // 前端必须展示成效侧，且区分「没有事件」与「全是 0」
  const dc = fs.readFileSync(path.resolve(__dirname, '../../renderer-v2/src/components/DataCenter.vue'), 'utf8');
  assert.ok(dc.indexOf('成效侧') >= 0, '数据中心没有成效侧区块');
  assert.ok(dc.indexOf('metrics.outcome.available') >= 0, '数据中心没区分「没有成效事件」');
});

test('v2', 'metrics/隐私：指标只写本机独立文件，正文与关键词一律丢弃（R-11）', function () {
  const os = require('os');
  const { createMetrics } = require(path.resolve(__dirname, '../../src/core/metrics.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-metrics-'));
  const m = createMetrics(dir);

  // ① 正文类字段必须被白名单丢掉：即使调用方硬塞也写不进去
  m.record('entry_save', {
    ts: new Date().toISOString(), date: '2026-11-12', ms: 12,
    text: '这是一句绝不该出现在指标里的正文', content: '同上', body: '同上'
  });
  m.record('search_use', { ts: new Date().toISOString(), mode: 'search.or', text: '私密关键词' });

  const raw = fs.readFileSync(m.file, 'utf8');
  assert.ok(raw.indexOf('绝不该出现') < 0, '指标文件里出现了正文');
  assert.ok(raw.indexOf('私密关键词') < 0, '指标文件里出现了检索关键词');
  assert.ok(raw.indexOf('"ms":12') >= 0, '该记的耗时没记下来');

  // ② 汇总能真的算出东西（不是永远空表）
  const s = m.summary();
  assert.strictEqual(s.metrics.saveLatencyP50, 12, '保存耗时没进汇总');
  assert.strictEqual(s.enabled, true);

  // ③ 停用后不再写
  m.setEnabled(false);
  m.record('entry_save', { ts: new Date().toISOString(), date: '2026-11-13', ms: 99999 });
  assert.ok(fs.readFileSync(m.file, 'utf8').indexOf('99999') < 0, '停用后仍在写指标');

  // ④ 结构性保证：指标落在 dataDir 独立文件，备份导出里没有 metrics 字段
  const main = fs.readFileSync(path.resolve(__dirname, '../../src/main/main-v2.js'), 'utf8');
  assert.ok(main.indexOf('createMetrics(dataDir)') >= 0, '指标没有落在 dataDir');
  assert.ok(main.indexOf('obj.metrics') < 0, '备份注入里出现了 metrics 字段（指标会被导出）');

  // ⑤ 通道与开关都在白名单里，渲染层没有写原始事件的通道
  const api = fs.readFileSync(path.resolve(__dirname, '../../src/core/api-layer.js'), 'utf8');
  assert.ok(api.indexOf("'v1/metrics:summary'") >= 0, '缺少指标汇总路由');
  assert.ok(api.indexOf("'v1/metrics:setEnabled'") >= 0, '缺少指标开关路由');
  const preload = fs.readFileSync(path.resolve(__dirname, '../../src/preload/v2-preload.js'), 'utf8');
  assert.ok(preload.indexOf('v1/metrics:record') < 0, 'preload 暴露了写原始事件的通道');
});

test('review', '跨期对照：同一句只认同文或包含，短句不判（V3.10）', function () {
  const same = modCross.samePromise;
  assert.strictEqual(same('每天早睡，23 点前关灯', '每天早睡 23 点前关灯'), true, '标点差异被当成两句话');
  assert.strictEqual(same('每天 23 点前关灯，手机放客厅', '每天23点前关灯'), true, '包含关系没认出来');
  assert.strictEqual(same('多陪家人', '多运动'), false, '模糊比相似把两件事判成一件');
  assert.strictEqual(same('早睡', '每天早睡'), false, '少于 4 个字的短句不该判同一句');
  assert.strictEqual(same('', ''), false);
  // 只脱标点、不脱字：字不同就是不同说法，系统不替人改写
  assert.strictEqual(modCross.normPromise('每天早睡（23 点前）'), '每天早睡23点前');
});

test('review', '跨期对照：周期键回退跨年不断、脏键不炸（V3.10）', function () {
  assert.deepStrictEqual(modCross.keysBack('week', '2026-11-09', 3), ['2026-11-09', '2026-11-02', '2026-10-26']);
  assert.deepStrictEqual(modCross.keysBack('week', '2026-01-05', 2), ['2026-01-05', '2025-12-29'], '周键跨年断了');
  assert.deepStrictEqual(modCross.keysBack('month', '2026-01', 3), ['2026-01', '2025-12', '2025-11'], '月键跨年断了');
  assert.deepStrictEqual(modCross.keysBack('week', '不是日期', 3), [], '脏键没被拒绝');
  assert.strictEqual(modCross.prevKey('week', ''), '');
});

test('review', '跨期对照：三种下落分开说，「没有痕迹」不等于「没做到」（V3.10）', function () {
  const slots = [
    { key: '2026-11-09', answers: ['本周把复盘挪到周一', '因为周日容易被打断', '每天 23 点前关灯，手机放客厅'] },
    { key: '2026-11-02', answers: ['a', 'b', '每天23点前关灯 手机放客厅'] },
    { key: '2026-10-26', answers: ['a', 'b', '每天 23 点前关灯，手机放客厅。'] },
    { key: '2026-10-19', answers: ['', '', ''] }
  ];
  const done = {
    id: 't1', title: '把充电器挪到客厅', status: 'done',
    doneAt: new Date(2026, 10, 12, 10).getTime(), source: 'review', note: '来自 2026-11-02 周复盘的第 3 问'
  };
  const base = { period: 'week', key: '2026-11-09', slots: slots, today: '2026-11-15' };

  // ① 老口径（source='review'，键在 note 里）：升级前落成的承诺也得追上
  const r1 = modCross.compare(Object.assign({ tasks: [done] }, base));
  assert.strictEqual(r1.prevPromise, '每天23点前关灯 手机放客厅');
  assert.ok(r1.link && r1.link.pending === false, '老 source 的任务没追上');
  assert.strictEqual(r1.link.doneText, '2026-11-12');
  assert.strictEqual(r1.streak, 3, '连续三期说同一件事没数对');
  assert.strictEqual(r1.history.length, 1, '前几期不该重复列上期那句');
  assert.strictEqual(r1.history[0].key, '2026-10-26');
  assert.strictEqual(r1.history[0].sameAsNewer, true, '与前一期同一句没标出来');

  // ② 新口径（source 带周期键）：没勾掉就是「还在清单里」，不判「没做到」
  const open = Object.assign({}, done, {
    id: 't2', status: 'next', doneAt: 0, dueDate: '2026-11-13', source: 'review:week:2026-11-02'
  });
  const r2 = modCross.compare(Object.assign({ tasks: [open] }, base));
  assert.strictEqual(r2.link.pending, true);
  assert.strictEqual(r2.link.dueText, '已过 2026-11-13', '逾期没说清');

  // ③ 压根没落成：结论是「没有痕迹」，不是「没做到」——findLink 必须返回 null
  assert.strictEqual(modCross.compare(Object.assign({ tasks: [] }, base)).link, null, '没有记录却硬塞了一条下落');

  // ④ 别的周期的任务不能串台
  const other = Object.assign({}, done, { source: 'review:week:2026-10-26', note: '来自 2026-10-26 周复盘的第 3 问' });
  assert.strictEqual(modCross.compare(Object.assign({ tasks: [other] }, base)).link, null, '把别的期的承诺算到上期头上');
});

test('review', '跨期对照：上期空则不追、本期草稿可覆盖、全空不出卡（V3.10）', function () {
  const slots = [
    { key: '2026-11-09', answers: ['a', 'b', '每天 23 点前关灯'] },
    { key: '2026-11-02', answers: ['a', 'b', ''] },
    { key: '2026-10-26', answers: ['a', 'b', '每天 23 点前关灯'] }
  ];
  const r = modCross.compare({
    period: 'week', key: '2026-11-09', slots: slots, today: '2026-11-15',
    tasks: [{ id: 't', title: '不该被追上', status: 'done', doneAt: 0, source: 'review:week:2026-11-02' }]
  });
  assert.strictEqual(r.prevPromise, '', '上期空着却有了承诺');
  assert.strictEqual(r.link, null, '上期没写第 3 问却去追了任务');
  assert.strictEqual(r.streak, 1, '上期空着还算连续');
  assert.strictEqual(r.history.length, 1, '再上期那句应该还在');
  assert.strictEqual(r.history[0].sameAsNewer, false, '隔了一期空档不能算同一句');
  assert.strictEqual(r.hasAny, true);

  // 本期草稿优先：还没保存的那句也要立刻参与对照
  const draft = modCross.compare({
    period: 'week', key: '2026-11-09', current: '每天早睡，23 点前关灯', tasks: [], today: '2026-11-15',
    slots: [{ key: '2026-11-09', answers: ['', '', ''] }, { key: '2026-11-02', answers: ['', '', '每天早睡 23 点前关灯'] }]
  });
  assert.strictEqual(draft.streak, 2, '草稿没参与对照');

  // 一期都没写：hasAny=false，界面据此不摆这张卡（空卡片比没有更烦）
  const empty = modCross.compare({ period: 'week', key: '2026-11-09', slots: [{ key: '2026-11-09', answers: ['', '', ''] }], tasks: [] });
  assert.strictEqual(empty.hasAny, false);
  assert.strictEqual(empty.streak, 0);
});

test('review', '跨期对照接线：路由只读、白名单登记、source 带周期键（V3.10）', function () {
  const main = fs.readFileSync(path.resolve(__dirname, '../../src/main/main-v2.js'), 'utf8');
  const api = fs.readFileSync(path.resolve(__dirname, '../../src/core/api-layer.js'), 'utf8');
  const view = fs.readFileSync(path.resolve(__dirname, '../../renderer-v2/src/components/ReviewView.vue'), 'utf8');
  assert.ok(main.indexOf("'review.cross': function") >= 0, '主进程缺 review.cross 路由');
  assert.ok(api.indexOf("'review.cross'") >= 0, '白名单漏登记 review.cross');
  // 只读：这条路由里不许出现任何写操作，否则「对照」会顺手改掉被对照的东西。
  // 截到下一个路由为止，别把后一条 trace.add 的 mutate 算进来
  const at = main.indexOf("'review.cross': function");
  const next = main.indexOf("'trace.", at);
  const seg = main.slice(at, next > at ? next : at + 1200);
  ['mutate', '.add(', 'remove', 'saveReview'].forEach(function (w) {
    assert.ok(seg.indexOf(w) < 0, '跨期对照路由里出现了写操作：' + w);
  });
  assert.ok(view.indexOf("callDomain<CrossView | null>('review.cross'") >= 0, '渲染层没接上跨期对照');
  assert.ok(view.indexOf("source: 'review:' + period.value + ':' + reviewKey.value") >= 0,
    '落成下一步时没把周期键写进 source');
});

test('v2', 'reading/board：主题书不进休闲书架，主题行与书架同一套派生（V3.13）', function () {
  const s0 = modReading.empty();
  const s1 = modReading.addBook(s0, { id: 'l1', title: '活着', total: 300, status: 'reading' });
  const s2 = modReading.addBook(s1, { id: 'l2', title: '量化投资之道', total: 200 });
  // 主题书：同一个主题下三份同主题文件
  const s3 = modReading.addBook(s2, { id: 't1', title: 'GB 18918 解读', total: 100, themeId: 'th1', unit: '页' });
  const s4 = modReading.addBook(s3, { id: 't2', title: 'A2O 工艺', total: 100, themeId: 'th1' });
  const s5 = modReading.addBook(s4, { id: 't3', title: 'MBR 膜污染', total: 100, themeId: 'th2' });
  const s = modReading.normalize(modReading.addTheme(s5, { id: 'th1', title: '污水处理工艺' }));
  // 一条主题书的笔记：主题行也要数上（以前只数 leisure，主题下永远 0 条）
  const s6 = modReading.normalize(modReading.addNote(s, {
    mode: 'theme', themeId: 'th1', bookId: 't1', bookTitle: 'GB 18918 解读', type: 'highlight', text: '一条批注'
  }));

  const b = modReading.board(s6);
  assert.deepStrictEqual(b.books.map(function (x) { return x.id; }), ['t3', 't2', 't1', 'l2', 'l1'],
    'books 应仍是全部（其他消费方按旧口径读）');
  assert.deepStrictEqual(b.leisureBooks.map(function (x) { return x.id; }), ['l2', 'l1'],
    '书架里不该出现主题书');
  assert.strictEqual(b.stats.books, 2, '统计头的「休闲书」被主题书撑大了');
  assert.strictEqual(b.stats.themeBooks, 3, '统计头没分开算主题书');
  // 书架顺序 / 派生字段与主题行一致
  const t1 = b.themeGroups.filter(function (g) { return g.themeId === 'th1'; })[0];
  assert.ok(t1 && t1.rows.length === 2, '主题分组没带上该主题的书');
  const row = t1.rows.filter(function (x) { return x.id === 't1'; })[0];
  assert.strictEqual(row.progressText, '0/100 页', '主题行缺进度文本（渲染层会显示空白）');
  assert.strictEqual(row.statusLabel, '待读', '主题行缺状态文案');
  assert.strictEqual(row.noteCount, 1, '主题行的笔记数没算上（只数了 leisure）');
  // 主题表里没登记的主题 id 也要能成组，不然书会「消失」在界面上
  assert.ok(b.themeGroups.some(function (g) { return g.themeId === 'th2'; }), '未登记的主题没兜底成组');
  // 分组 / 收藏只数休闲书：主题书身上残留的标签不该出现在书架的筛选条上
  assert.deepStrictEqual(b.groups, [], '分组清单混进了主题书');
});

test('v2', 'reading/cover-net：只认豆瓣两类域名、只取图书、格式按魔数（V3.13）', function () {
  const net = require(path.resolve(__dirname, '../../src/reading/cover-net.js'));
  // 域名白名单留在客户端里：新增一个调用点也绕不过去
  assert.ok(net.checkJsonHost('book.douban.com') === 'book.douban.com', '检索域名应放行');
  assert.ok(net.checkImgHost('img9.doubanio.com') === 'img9.doubanio.com', '封面域名应放行');
  ['evil.com', 'img.doubanio.com.evil.com', 'book.douban.com.evil.com', 'doubanio.com'].forEach(function (h) {
    assert.throws(function () { net.checkImgHost(h); }, /BLOCKED_HOST|白名单/, '图片域名白名单被绕过了：' + h);
  });
  assert.throws(function () { net.checkJsonHost('img9.doubanio.com'); }, /白名单/, '图片域不该能当检索域用');

  // 只认 type 'b'（图书）：影视 / 音乐条目混进来会让人套错封面
  const buf = Buffer.from(JSON.stringify([
    { title: '活着', author_name: '余华', year: '2012', type: 'b', pic: 'https://img9.doubanio.com/view/subject/s/public/s1.jpg', url: 'https://book.douban.com/subject/1/' },
    { title: '活着（电影）', type: 'm', pic: 'https://img9.doubanio.com/view/subject/s/public/s2.jpg' },
    { title: '', type: 'b', pic: 'https://img9.doubanio.com/view/subject/s/public/s3.jpg' },
    { title: '野图', type: 'b', pic: 'https://evil.com/view/subject/s/public/s4.jpg' }
  ]));
  const list = net.parseSuggest(buf);
  assert.strictEqual(list.length, 1, '非图书 / 空书名 / 野域名的条目都应被丢掉');
  assert.strictEqual(list[0].title, '活着');
  assert.strictEqual(list[0].picHost, 'img9.doubanio.com');
  assert.strictEqual(list[0].picPath, '/view/subject/s/public/s1.jpg');
  assert.deepStrictEqual(net.parseSuggest(Buffer.from('不是 json')), [], '脏响应应返回空数组而不是抛');

  // 大图优先：s → l，失败由调用方退回 s
  assert.strictEqual(net.biggerPic('/view/subject/s/public/s1.jpg'), '/view/subject/l/public/s1.jpg');
  assert.strictEqual(net.biggerPic('/view/subject/l/public/s1.jpg'), '/view/subject/l/public/s1.jpg', '已经是 l 就别动');

  // 格式按魔数认（豆瓣的 .jpg 偶尔其实是 webp，扩展名骗人会让封面打不开）
  assert.strictEqual(net.sniffExt(Buffer.from('ffd8ffe000104a464946', 'hex')), 'jpg');
  assert.strictEqual(net.sniffExt(Buffer.from('89504e470d0a1a0a0000', 'hex')), 'png');
  assert.strictEqual(net.sniffExt(Buffer.from('474946383961', 'hex')), 'gif');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.strictEqual(net.sniffExt(webp), 'webp');
  assert.strictEqual(net.sniffExt(Buffer.from('<html></html>')), '', '不是图片就该返回空');
});

// ------------------------------------------------------------
// P0/P1 图书馆内部互通（2026-11-16）
// 指纹身份 / 引用完整性 / 体检与可逆修复 / 检索合流 / 再曝光 / 迁移核对
// ------------------------------------------------------------
const modFp = require(path.resolve(__dirname, '../../src/reading/fingerprint.js'));

test('v2', 'reading/fingerprint：大小 + 首 64KB 就是身份，改名不变、改内容就变', function () {
  const dir = fresh('reading-fp');
  const a = path.join(dir, 'a.epub');
  fs.writeFileSync(a, Buffer.alloc(1000, 7));
  const fa = modFp.fingerprintOf(a);
  assert.ok(/^[0-9a-f]{64}$/.test(fa), '指纹应是 64 位小写十六进制');
  assert.strictEqual(modFp.fingerprintOf(a), fa, '同内容两次指纹不一致（掺了时间或路径？）');
  // 改名 / 换目录：路径变了，身份不能变——这是「重新关联」能成立的前提
  const b = path.join(dir, 'renamed.epub');
  fs.copyFileSync(a, b);
  assert.strictEqual(modFp.fingerprintOf(b), fa, '改名或搬目录后认不出是同一本');
  // 内容改一个字节 → 必须变
  const bufC = Buffer.alloc(1000, 7);
  bufC[999] = 8;
  const c = path.join(dir, 'c.epub');
  fs.writeFileSync(c, bufC);
  assert.notStrictEqual(modFp.fingerprintOf(c), fa, '内容变了指纹没变');
  // 同前缀、只是长了一个字节 → 大小拼进哈希，必须不同
  const d = path.join(dir, 'd.epub');
  fs.writeFileSync(d, Buffer.alloc(1001, 7));
  assert.notStrictEqual(modFp.fingerprintOf(d), fa, '同前缀不同长度被认成同一本');
  // 空文件也要能算（0 字节不能走成「没有身份」）
  const e = path.join(dir, 'e.epub');
  fs.writeFileSync(e, Buffer.alloc(0));
  assert.ok(/^[0-9a-f]{64}$/.test(modFp.fingerprintOf(e)), '空文件算不出指纹');
  // 算不出来时不许把登记流程带崩
  assert.strictEqual(modFp.fingerprintSafe(path.join(dir, 'nope.epub')), '', '算不出来应返回空串');
  assert.throws(function () { modFp.fingerprintOf(dir); }, /不是文件/, '目录应当被拒');
  assert.strictEqual(modFp.sizeOf(a), 1000);
  assert.strictEqual(modFp.sizeOf(path.join(dir, 'nope.epub')), 0, '不存在的文件大小应为 0');
});

test('v2', 'reading/指纹判重：同一本书换了位置走 relink，bookId / 笔记 / 章节一个不丢', function () {
  const fp = 'ab'.repeat(32);
  // 章节走原始数据构造：addChapter 会做存在性校验，而这里要验的是「已有章节在 relink 后还在」
  const s = modReading.normalize({
    books: [{ id: 'bk1', title: '给水排水工程', filePath: '/old/a.epub', fileExt: 'epub', fileSize: 100, fingerprint: fp }],
    chapters: [{ id: 'c1', bookId: 'bk1', title: '第一章' }],
    notes: [{ id: 'n1', bookId: 'bk1', bookTitle: '给水排水工程', text: '一条笔记' }]
  });

  assert.ok(modReading.bookByFingerprint(s, fp.toUpperCase()), '指纹匹配应大小写不敏感');
  assert.strictEqual(modReading.bookByFingerprint(s, 'zz'), null, '脏指纹不该命中任何书');
  assert.strictEqual(modReading.bookByFingerprint(s, ''), null, '空指纹把老书互相认成一本就完了');
  // 老书（没算过指纹）不该被空指纹认领
  const withOld = modReading.addBook(s, { id: 'bk0', title: '老书', filePath: '/old/b.epub' });
  assert.strictEqual(modReading.bookByFingerprint(withOld, ''), null);
  assert.strictEqual(modReading.hasFingerprint(withOld, fp), true);

  const r = modReading.relinkBook(s, 'bk1', {
    filePath: '/new/改名后.epub', fileExt: '.EPUB', fileSize: 120, fingerprint: fp
  });
  const b = r.books.filter(function (x) { return x.id === 'bk1'; })[0];
  assert.ok(b, '重新关联把书本身弄丢了');
  assert.strictEqual(b.filePath, '/new/改名后.epub');
  assert.strictEqual(b.fileExt, 'epub', '扩展名应归一成小写并去掉点');
  assert.strictEqual(b.fileSize, 120);
  assert.strictEqual(b.fingerprint, fp);
  assert.strictEqual(r.notes.filter(function (n) { return n.bookId === 'bk1'; }).length, 1,
    '笔记挂在 bookId 上，重新关联后不该失联');
  assert.strictEqual(r.chapters.filter(function (c) { return c.bookId === 'bk1'; }).length, 1,
    '章节挂在 bookId 上，重新关联后不该失联');
  assert.strictEqual(r.books.length, s.books.length, '重新关联不该多出一本书（那正是重复登记的来源）');

  // 失败边界：不存在的书 / 空路径 / 非法指纹，一律不动
  assert.strictEqual(modReading.relinkBook(s, 'nope', { filePath: '/x.epub' }).books.length, s.books.length,
    '不存在的书被凭空写了一条');
  const emptyPatch = modReading.relinkBook(s, 'bk1', { filePath: '' });
  assert.strictEqual(emptyPatch.books.filter(function (x) { return x.id === 'bk1'; })[0].filePath, '/old/a.epub',
    '空路径把已有路径抹掉了');
  const badFp = modReading.relinkBook(s, 'bk1', { filePath: '/n.epub', fingerprint: 'xx' });
  assert.strictEqual(badFp.books.filter(function (x) { return x.id === 'bk1'; })[0].fingerprint, fp,
    '非法指纹覆盖了已有身份');
});

test('v2', 'reading/导入：只补不改，并如实报出这批数据里有多少条引用落空', function () {
  const base = modReading.normalize(modReading.addBook(modReading.empty(), { id: 'bk1', title: '活着' }));
  // 备份里带着指向「没跟过来」的书 / 主题的笔记、章节、书签：合并后全是断链
  const incoming = modReading.normalize({
    notes: [{ id: 'nX', bookId: 'bkGhost', bookTitle: '失踪的书', text: '孤儿笔记' }],
    chapters: [{ id: 'cX', bookId: 'bkGhost', title: '第一章' }],
    bookmarks: [{ id: 'mX', bookId: 'bkGhost', anchor: '0:0.5', label: 'p.3' }],
    books: [{ id: 'bkY', title: '主题没了的书', themeId: 'thGhost' }]
  });
  const out = modReading.mergeSection(base, incoming);
  assert.strictEqual(out.added, 4, '四类都该补进来');
  assert.strictEqual(out.report.danglingNotes, 1);
  assert.strictEqual(out.report.danglingChapters, 1);
  assert.strictEqual(out.report.danglingBookmarks, 1);
  assert.strictEqual(out.report.danglingBooks, 1);
  assert.strictEqual(out.report.clean, false, '有落空引用却报 clean');
  assert.strictEqual(out.report.samples.length, 1, '明细应只列落空的笔记，不带整条正文');
  assert.strictEqual(out.report.samples[0].bookTitle, '失踪的书');
  // 关键：报告归报告，合并绝不替人删数据
  assert.ok(out.state.notes.some(function (n) { return n.id === 'nX'; }), '合并把落空的笔记吞了');
  // 干净的合并 report.clean 为真，且二次合并仍是幂等
  assert.strictEqual(modReading.mergeSection(base, base).report.clean, true);
  assert.strictEqual(modReading.mergeSection(out.state, incoming).added, 0, '二次合并必须幂等');
});

test('v2', 'reading/回写：行尾带〔rd:id〕可反查，前缀不动、截断不切、无 id 不硬造', function () {
  const note = { id: 'nt-1', mode: 'theme', bookTitle: '给水排水工程', page: 42, text: '混凝沉淀要控 pH', tags: ['给水'] };
  const line = modReading.noteToDiaryLine(note);
  assert.strictEqual(line.indexOf('【读书·主题阅读】'), 0, '检索前缀被标记挤掉了');
  assert.strictEqual(line.slice(-9), '〔rd:nt-1〕', '标记必须钉在行尾');
  assert.strictEqual(modReading.noteToDiaryLine(note), line, '同一笔记两次生成必须逐字节一致');

  assert.deepStrictEqual(modReading.refIdsIn('a 〔rd:x1〕 b 〔rd:x2〕 〔rd:x1〕'), ['x1', 'x2'],
    '一行多个标记应全取到且去重');
  assert.deepStrictEqual(modReading.refIdsIn('〔rd:〕 〔rd:带 空格 id〕'), [], '脏标记不该当成引用');
  assert.deepStrictEqual(modReading.refIdsIn(line), ['nt-1']);
  assert.strictEqual(modReading.stripRefMarks('正文 〔rd:x1〕'), '正文', '人读文本不该多出空格');
  assert.strictEqual(modReading.stripRefMarks(line).indexOf('〔'), -1);

  // 老数据 / 手写笔记没有 id：不伪造一个假标记（假 id 反查回去是空的）
  assert.strictEqual(modReading.noteToDiaryLine({ bookTitle: '活着', text: 'x' }).indexOf('〔rd:'), -1);
  // 超长正文先截断再挂标记，不能把标记切掉
  const long = modReading.noteToDiaryLine({ id: 'nt-2', bookTitle: 'x', text: 'a'.repeat(1000) });
  assert.ok(long.length <= 300, '回写行超长：' + long.length);
  assert.strictEqual(long.slice(-9), '〔rd:nt-2〕', '截断把标记切没了');
});

test('v2', 'reading/体检：五项只报告不自动改，修复只清悬空字段且能原样撤销', function () {
  const fp = 'cd'.repeat(32);
  // 断链只能靠「原始数据」造出来：走 addChapter / addBookmark 会先做存在性校验，
  // 而真实断链是「书删了，指向它的行还留着」——那正是要体检出来的东西。
  const s = modReading.normalize({
    themes: [{ id: 'th1', title: '污水处理工艺' }],
    books: [
      { id: 'b1', title: '给水排水工程', themeId: 'th1' },
      { id: 'b2', title: '活着' },
      { id: 'b3', title: '主题没了的书', themeId: 'thGhost' },
      { id: 'b4', title: '重登的书', filePath: '/x/1.epub', fingerprint: fp },
      { id: 'b5', title: '重登的书', filePath: '/x/2.epub', fingerprint: fp }
    ],
    chapters: [{ id: 'c1', bookId: 'bGhost', title: '悬空章' }],
    notes: [
      { id: 'n1', bookId: 'b1', bookTitle: '给水排水工程', text: '正常笔记' },
      { id: 'n2', bookId: 'bGhost', bookTitle: '已删的书', text: '悬空笔记' },
      { id: 'n3', mode: 'theme', themeId: 'thGhost', text: '悬空主题笔记' }
    ],
    bookmarks: [{ id: 'm1', bookId: 'bGhost', anchor: '0:0.5', label: 'p.3' }]
  });

  const a = modReading.audit(s);
  assert.strictEqual(a.counts.danglingNotes, 2, '悬空笔记数不对（书没了 + 主题没了各一条）');
  assert.strictEqual(a.counts.danglingChapters, 1);
  assert.strictEqual(a.counts.danglingBookmarks, 1);
  assert.strictEqual(a.counts.danglingBooks, 1);
  assert.strictEqual(a.counts.dupFingerprints, 1, '同指纹两条应报重复登记');
  assert.strictEqual(a.counts.dupTitles, 1, '同名但指向两个文件应报同名重复');
  assert.strictEqual(a.counts.notesNoSource, 0);
  assert.strictEqual(a.dupFingerprints[0].books.length, 2);
  // 只读：再查一遍数字不变
  assert.strictEqual(modReading.audit(s).counts.danglingNotes, 2, '体检自己改了数据');

  const rep = modReading.repairDangling(s);
  assert.strictEqual(rep.fixed, 3, '应修 2 条笔记的悬空引用 + 1 本书的悬空主题');
  assert.strictEqual(rep.changes.length, 3);
  const a2 = modReading.audit(rep.state);
  assert.strictEqual(a2.counts.danglingNotes, 0);
  assert.strictEqual(a2.counts.danglingBooks, 0);
  assert.strictEqual(a2.counts.books, 5, '修复把书删了');
  assert.strictEqual(a2.counts.notes, 3, '修复把笔记删了');

  const back = modReading.restoreDangling(rep.state, rep.changes);
  const a3 = modReading.audit(back);
  assert.strictEqual(a3.counts.danglingNotes, 2, '撤销没把引用写回去');
  assert.strictEqual(a3.counts.danglingBooks, 1);
  assert.deepStrictEqual(modReading.restoreDangling(rep.state, []), modReading.normalize(rep.state),
    '空改动清单不该动数据');
  // 没有断链时不能报一个假 fixed
  assert.strictEqual(modReading.repairDangling(modReading.empty()).fixed, 0);
});

test('v2', 'reading/检索合流：书 / 主题 / 笔记摊成一张行表，关键词与拼音共用同一套匹配', function () {
  let s = modReading.empty();
  s = modReading.addTheme(s, { id: 'th1', title: '污水处理工艺', note: 'A2O 与 MBR 对比' });
  s = modReading.addBook(s, { id: 'b1', title: '给水排水工程', author: '严煦世', themeId: 'th1', total: 300, done: 120 });
  s = modReading.addBook(s, { id: 'b2', title: '活着', author: '余华' });
  s = modReading.addNote(s, {
    id: 'n1', mode: 'theme', themeId: 'th1', bookId: 'b1', bookTitle: '给水排水工程',
    type: 'highlight', text: '混凝沉淀池的设计要点', tags: ['规范']
  });

  const rows = modReading.searchIndex(s);
  assert.deepStrictEqual(rows.map(function (r) { return r.type; }).sort(), ['book', 'book', 'note', 'theme'],
    '五张表应摊成书 / 主题 / 笔记三类行');
  const rb = rows.filter(function (r) { return r.type === 'book' && r.id === 'b1'; })[0];
  assert.strictEqual(rb.progressText, '120/300 页', '书行没带进度，图书馆列表渲染不出来');
  assert.strictEqual(rb.pct, 40);
  assert.strictEqual(rb.hasFile, false, '没文件的书写成有文件，点开就是空的');

  assert.deepStrictEqual(modSearch.indexSearch(rows, '混凝').map(function (r) { return r.id; }), ['n1'],
    '笔记正文没进索引');
  assert.deepStrictEqual(modSearch.indexSearch(rows, '严煦世').map(function (r) { return r.id; }), ['b1'],
    '作者没进索引');
  assert.deepStrictEqual(modSearch.indexSearch(rows, 'MBR').map(function (r) { return r.id; }), ['th1'],
    '主题备注没进索引');
  assert.deepStrictEqual(modSearch.indexSearch(rows, '规范').map(function (r) { return r.id; }), ['n1'],
    '标签没进索引');
  assert.deepStrictEqual(modSearch.indexSearch(rows, ''), [], '空关键词应返回空数组');
  // 拼音首字母：打 hz 能找到《活着》，与日记检索同一套 initials
  assert.deepStrictEqual(modSearch.indexPinyin(rows, 'hz').map(function (r) { return r.id; }), ['b2']);
  assert.deepStrictEqual(modSearch.indexPinyin(rows, ''), [], '空拼音应返回空数组');
  // 脏行不该把检索带崩
  assert.deepStrictEqual(modSearch.indexSearch([null, 1, 'x'], 'a'), []);
});

test('v2', 'reading/再曝光：近 7 天摘录 + 30 天没翻过的在读，只读不写', function () {
  const NOW = Date.parse('2026-11-16T10:00:00+08:00');
  const day = 86400000;
  let s = modReading.empty();
  s = modReading.addBook(s, { id: 'b1', title: '在读但荒了', status: 'reading', total: 300, done: 30, lastReadAt: NOW - 40 * day });
  s = modReading.addBook(s, { id: 'b2', title: '从没翻过', status: 'reading', total: 100, done: 0 });
  s = modReading.addBook(s, { id: 'b3', title: '昨天刚读', status: 'reading', total: 200, done: 100, lastReadAt: NOW - day });
  s = modReading.addBook(s, { id: 'b4', title: '读完了', status: 'done', total: 100 });
  s = modReading.addNote(s, { id: 'n1', bookId: 'b1', bookTitle: '在读但荒了', text: '三天前', createdAt: NOW - 3 * day });
  s = modReading.addNote(s, { id: 'n2', bookId: 'b3', bookTitle: '昨天刚读', text: '十天前', createdAt: NOW - 10 * day });

  const r = modReading.resurface(s, NOW);
  assert.deepStrictEqual(r.recent.map(function (n) { return n.id; }), ['n1'], '7 天外的摘录不该算「最近摘的」');
  assert.strictEqual(r.recentCount, 1);
  assert.strictEqual(r.readingCount, 3, '读完的书不该算在读');
  assert.deepStrictEqual(r.stale.map(function (x) { return x.id; }), ['b2', 'b1'],
    '从没翻过的该排最前，其余越久没读越靠前');
  assert.strictEqual(r.stale[0].days, -1, '从没读过应是 -1，不是 0（0 会被读成「今天刚读」）');
  assert.strictEqual(r.stale[1].days, 40);
  assert.strictEqual(r.stale[1].pct, 10);
  assert.strictEqual(r.stale[1].progressText, '30/300 页');
  assert.deepStrictEqual(modReading.resurface(s, NOW), r, '再曝光必须只读');
  // 时间源由调用方传：同一个 state 换一个「今天」，结果就该跟着变
  const later = modReading.resurface(s, NOW + 40 * day);
  assert.ok(later.stale.some(function (x) { return x.id === 'b3'; }), '过了 30 天，昨天刚读的也该进「荒了」');
});

test('v2', 'reading/迁移核对：旧 md_growth 书单逐条对账，两边都不写', function () {
  let s = modReading.empty();
  s = modReading.addTheme(s, { id: 'gth-th1', title: '污水处理工艺' });
  s = modReading.addBook(s, { id: 'gthbk-th1-g1', title: '已迁的书', themeId: 'gth-th1' });
  const legacy = [
    { themeId: 'th1', themeTitle: '污水处理工艺', bookId: 'g1', title: '已迁的书' },
    { themeId: 'th1', themeTitle: '污水处理工艺', bookId: 'g2', title: '还没迁的书' }
  ];
  const g = modReading.growthAudit(s, legacy);
  assert.strictEqual(g.legacyBooks, 2);
  assert.strictEqual(g.migratedBooks, 1);
  assert.strictEqual(g.pendingBooks, 1, '迁移欠账算错了，界面上就看不见该迁的');
  assert.strictEqual(g.legacyThemes, 1);
  assert.strictEqual(g.pending[0].migratesTo, 'gthbk-th1-g2', '迁移后的 id 规则要与 importGrowthThemes 一致');
  assert.strictEqual(g.pending[0].title, '还没迁的书');
  assert.strictEqual(modReading.growthAudit(s, null).legacyBooks, 0, '没有旧书单时不该报欠账');
  assert.strictEqual(modReading.growthAudit(s, [null, 1, 'x']).legacyBooks, 0, '脏行应被跳过而不是抛');
  // 核对是只读：跑两遍 state 不变
  assert.strictEqual(modReading.growthAudit(s, legacy).pendingBooks, 1);
});

test('v2', 'reading/notesQuery：主题书 / 主题没了也算孤儿，不再只查休闲书', function () {
  let s = modReading.empty();
  s = modReading.addTheme(s, { id: 'th1', title: '污水处理工艺' });
  s = modReading.addBook(s, { id: 'b1', title: '主题书', themeId: 'th1' });
  s = modReading.addBook(s, { id: 'b2', title: '休闲书' });
  s = modReading.addNote(s, { id: 'n1', mode: 'theme', themeId: 'th1', bookId: 'b1', bookTitle: '主题书', text: 'A' });
  s = modReading.addNote(s, { id: 'n2', bookId: 'b2', bookTitle: '休闲书', text: 'B' });
  assert.deepStrictEqual(modReading.notesQuery(s, {}).items.filter(function (n) { return n.orphan; }), [],
    '都还在的书不该被标孤儿');

  const s2 = modReading.removeBook(s, 'b1');
  const orphan1 = modReading.notesQuery(s2, {}).items.filter(function (n) { return n.orphan; })
    .map(function (n) { return n.id; });
  assert.deepStrictEqual(orphan1, ['n1'], '主题书的笔记在书被删后仍显得正常，等于把断链藏起来了');

  const s3 = modReading.removeTheme(s2, 'th1');
  const orphan2 = modReading.notesQuery(s3, {}).items.filter(function (n) { return n.orphan; })
    .map(function (n) { return n.id; });
  assert.ok(orphan2.indexOf('n1') >= 0, '主题没了也算孤儿');
  assert.ok(orphan2.indexOf('n2') < 0, '好好的休闲笔记不该被标孤儿');
});

test('v2', 'reading/接线：新通道全过白名单、旧 themeBooks 下线、反查与清任务都接上', function () {
  const apiSrc = fs.readFileSync(path.resolve(__dirname, '../../src/core/api-layer.js'), 'utf8');
  ['reading.relinkBook', 'reading.audit', 'reading.repairDangling', 'reading.restoreDangling',
    'reading.growthAudit', 'reading.refs', 'reading.pushAction', 'reading.resurface', 'search.library'
  ].forEach(function (n) {
    assert.ok(apiSrc.indexOf("'" + n + "'") >= 0, '新通道没登记进 DOMAIN_WHITELIST：' + n);
  });
  assert.ok(apiSrc.indexOf("'reading.themeBooks'") < 0,
    '旧的 themeBooks 通道还在（单一事实源没落到底）');

  const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../src/main/main-v2.js'), 'utf8');
  const rm = mainSrc.slice(mainSrc.indexOf("'reading.removeNote'"), mainSrc.indexOf("'reading.markPushed'"));
  assert.ok(rm.indexOf("('rd:' + key)") >= 0, '删笔记没按 rd: 前缀找它生成的任务');
  assert.ok(rm.indexOf("status !== 'done'") >= 0, '删笔记把已完成的任务也清了（做过的事被抹掉）');

  const la = mainSrc.slice(mainSrc.indexOf("'search.linksAll'"), mainSrc.indexOf("'tags.read'"));
  assert.ok(la.indexOf('refIdsIn') >= 0 && la.indexOf("type: 'reading'") >= 0,
    'linksAll 没把〔rd:〕行当成一种内链吐出来');
  const pa = mainSrc.slice(mainSrc.indexOf("'reading.pushAction'"), mainSrc.indexOf("'reading.resurface'"));
  assert.ok(pa.indexOf("'rd:' + id") >= 0 && pa.indexOf('duplicated') >= 0,
    '#行动 落收件箱必须按 source 幂等，否则点两次两条任务');
});

// ------------------------------------------------------------
// P2（2026-11-16）：虚拟书架 / 书目清单 / 目录口径 / 书库根目录
// ------------------------------------------------------------
test('v2', 'reading/标签：一套归一化（去 # / 去重 / 上限 8），加删都幂等', function () {
  let s = modReading.addBook(modReading.empty(), { id: 'b1', title: '给水排水工程' });
  s = modReading.addBookTag(s, 'b1', '#污水处理');
  s = modReading.addBookTag(s, 'b1', '污水处理');
  s = modReading.addBookTag(s, 'b1', '  ');
  assert.deepStrictEqual(s.books[0].tags, ['污水处理'], '# 前缀没去掉，或重复标签叠了两条');
  for (let i = 0; i < 12; i += 1) s = modReading.addBookTag(s, 'b1', 't' + i);
  assert.strictEqual(s.books[0].tags.length, 8, '标签上限没守住');
  s = modReading.removeBookTag(s, 'b1', 't0');
  assert.strictEqual(s.books[0].tags.length, 7);
  assert.deepStrictEqual(modReading.removeBookTag(s, 'b1', '不存在的'), modReading.normalize(s),
    '删不存在的标签不该改内容');
  assert.deepStrictEqual(modReading.addBookTag(s, 'nope', 'x'), modReading.normalize(s),
    '不存在的书不该被加标签');
  // 整组设置：脏值一律丢弃，与笔记那套 normTags 同一口径
  const set = modReading.setBookTags(s, 'b1', ['#a', 'a', '', 'b', 1, null, 'c']);
  assert.deepStrictEqual(set.books[0].tags, ['a', 'b', '1', 'c'],
    '整组设置要去 # / 去重 / 丢空值（数字会按既有 clean 口径转成字符串）');
});

test('v2', 'reading/虚拟书架：规则集合只派生 id，改一本书状态全场同刻跟着变', function () {
  const now = Date.parse('2026-11-16T10:00:00+08:00');
  const day = 86400000;
  let s = modReading.empty();
  s = modReading.normalize({
    books: [
      { id: 'b1', title: '在读的', status: 'reading', total: 100, done: 40, lastReadAt: now - 5 * day },
      { id: 'b2', title: '读完的', status: 'done', total: 100 },
      { id: 'b3', title: '只有笔记的', status: 'todo', total: 100 },
      { id: 'b4', title: '很久没读的', status: 'reading', total: 100, lastReadAt: now - 200 * day }
    ],
    notes: [{ id: 'n1', bookId: 'b3', bookTitle: '只有笔记的', text: '一条' }]
  });
  s = modReading.addBookTag(s, 'b1', '污水处理');
  s = modReading.addBookTag(s, 'b4', '污水处理');
  const bd = modReading.board(s);
  const byKey = {};
  bd.shelves.forEach(function (x) { byKey[x.key] = x; });
  assert.deepStrictEqual(byKey.reading.ids, ['b1', 'b4'], '在读集合错了（b4 是 reading 状态，只是很久没翻）');
  assert.deepStrictEqual(byKey.done.ids, ['b2']);
  assert.deepStrictEqual(byKey.todo.ids, ['b3']);
  assert.deepStrictEqual(byKey.noted.ids, ['b3'], '有笔记的集合没算上');
  assert.deepStrictEqual(byKey.nofile.ids.map(function (x) { return x; }).sort(), ['b1', 'b2', 'b3', 'b4'],
    '没有文件的都该进「只有笔记」');
  assert.deepStrictEqual(byKey['tag:污水处理'].ids, ['b1', 'b4'], '标签集合没派生出来');
  assert.strictEqual(byKey.reading.count, 2);
  // 只给 id，不复制记录：集合成员必须是 id 字符串，不是书对象
  byKey.reading.ids.forEach(function (id) { assert.strictEqual(typeof id, 'string'); });
  // 改状态后同一份 state 重算：书架立刻跟着变（因为它是派生，不是副本）
  const s2 = modReading.setBookStatus(s, 'b1', 'done');
  const byKey2 = {};
  modReading.board(s2).shelves.forEach(function (x) { byKey2[x.key] = x; });
  assert.deepStrictEqual(byKey2.done.ids.sort(), ['b1', 'b2'], '书架没跟着状态变——说明存了一份副本');
});

test('v2', 'reading/书库根：登记即纳入老书，换根一次重算，删根只解绑不删书', function () {
  const BS = '\\';
  const root = 'D:' + BS + 'Books';
  let s = modReading.normalize({
    books: [
      { id: 'b1', title: '甲', filePath: root + BS + 'ws' + BS + 'a.epub' },
      { id: 'b2', title: '乙', filePath: root + BS + 'ws' + BS + 'b.epub' },
      { id: 'b3', title: '丙', filePath: 'E:' + BS + 'elsewhere' + BS + 'c.pdf' }
    ]
  });
  // 登记根 → 老书自动补 rootId / relPath（零手工纳入），根外的书不动
  s = modReading.addRoot(s, { id: 'rt1', label: '书库', path: root });
  assert.strictEqual(s.books[0].rootId, 'rt1');
  assert.strictEqual(s.books[0].relPath, 'ws/a.epub', '相对路径必须存正斜杠（备份要跨系统读得懂）');
  assert.strictEqual(s.books[2].rootId, '', '根外的书不该被认领');
  assert.strictEqual(s.books[2].relPath, '');
  // 同一个目录不重复登记
  assert.strictEqual(modReading.addRoot(s, { id: 'rt2', path: root }).roots.length, 1);
  // 换根 = 整库搬家：一条改完，所有挂在它下面的书路径跟着走，id 一个不变
  const moved = modReading.relocateRoot(s, 'rt1', 'F:' + BS + 'Library');
  assert.strictEqual(moved.books[0].filePath, 'F:' + BS + 'Library' + BS + 'ws' + BS + 'a.epub');
  assert.strictEqual(moved.books[1].filePath, 'F:' + BS + 'Library' + BS + 'ws' + BS + 'b.epub');
  assert.strictEqual(moved.books[2].filePath, 'E:' + BS + 'elsewhere' + BS + 'c.pdf', '根外的书被顺手改了');
  assert.deepStrictEqual(moved.books.map(function (b) { return b.id; }), ['b1', 'b2', 'b3']);
  // 归一化幂等：再 normalize 一次不会把路径拼成两遍
  assert.deepStrictEqual(modReading.normalize(moved), moved, 'roots 解析不幂等');
  // 删根只解绑：书一本不少，filePath 保持原样（书还在原地，只是不再跟着根搬）
  const off = modReading.removeRoot(moved, 'rt1');
  assert.strictEqual(off.books.length, 3, '删根把书删了');
  assert.strictEqual(off.roots.length, 0);
  assert.strictEqual(off.books[0].rootId, '');
  assert.strictEqual(off.books[0].relPath, '');
  assert.strictEqual(off.books[0].filePath, moved.books[0].filePath, '删根把绝对路径抹了');
  // 上限 6
  let many = modReading.empty();
  for (let i = 0; i < 9; i += 1) many = modReading.addRoot(many, { path: 'Z:' + BS + 'r' + i });
  assert.strictEqual(many.roots.length, modReading.MAX_ROOTS);
});

test('v2', 'reading/书库根：roots 在每一种写操作后都不丢（漏一次整库就失忆）', function () {
  const BS = '\\';
  const base = modReading.normalize({
    roots: [{ id: 'rt1', path: 'D:' + BS + 'Books' }],
    books: [{ id: 'b1', title: '甲', rootId: 'rt1', relPath: 'a.epub' }]
  });
  const steps = {
    addBook: function (s) { return modReading.addBook(s, { id: 'b2', title: '乙' }); },
    updateBook: function (s) { return modReading.updateBook(s, 'b1', { author: '某人' }); },
    setBookStatus: function (s) { return modReading.setBookStatus(s, 'b1', 'reading'); },
    advanceBook: function (s) { return modReading.advanceBook(s, 'b1', 5, '2026-11-16'); },
    touchBook: function (s) { return modReading.touchBook(s, 'b1', 1); },
    setBookGroup: function (s) { return modReading.setBookGroup(s, 'b1', '污水'); },
    setBookFavorite: function (s) { return modReading.setBookFavorite(s, 'b1', true); },
    addBookTag: function (s) { return modReading.addBookTag(s, 'b1', 'x'); },
    relinkBook: function (s) { return modReading.relinkBook(s, 'b1', { filePath: 'D:' + BS + 'Books' + BS + 'a.epub' }); },
    addTheme: function (s) { return modReading.addTheme(s, { id: 'th1', title: '主题' }); },
    addChapter: function (s) { return modReading.addChapter(s, 'b1', { title: '章' }); },
    addNote: function (s) { return modReading.addNote(s, { id: 'n1', bookId: 'b1', bookTitle: '甲', text: '笔记' }); },
    addBookmark: function (s) { return modReading.addBookmark(s, { id: 'm1', bookId: 'b1', anchor: '0:0.5' }); },
    removeBookmark: function (s) { return modReading.removeBookmark(s, 'm1'); },
    removeChapter: function (s) { return modReading.removeChapter(s, 'c-x'); },
    mergeSection: function (s) { return modReading.mergeSection(s, modReading.empty()).state; },
    repairDangling: function (s) { return modReading.repairDangling(s).state; }
  };
  Object.keys(steps).forEach(function (name) {
    const out = steps[name](base);
    assert.strictEqual(out.roots.length, 1, '写操作「' + name + '」把书库根弄丢了');
    assert.strictEqual(out.roots[0].id, 'rt1');
    assert.strictEqual(out.books[0].filePath, 'D:' + BS + 'Books' + BS + 'a.epub',
      '写操作「' + name + '」之后书的解析路径变了');
  });
});

test('v2', 'reading/清单导出：CSV 带 BOM 且转义正确，JSON 不含正文，OPDS 只给真文件挂链接', function () {
  let s = modReading.normalize({
    books: [
      { id: 'b1', title: '含"引号"的书', author: '某人', status: 'reading', total: 300, done: 120, group: '污水' },
      { id: 'b2', title: '有文件的书', status: 'done', total: 100, filePath: 'D:/Books/b2.epub', fileExt: 'epub' }
    ],
    notes: [{ id: 'n1', bookId: 'b1', bookTitle: '含"引号"的书', text: '这段正文不该出现在清单里' }]
  });
  s = modReading.addBookTag(s, 'b1', '规范');

  const csv = modReading.exportList(s, 'csv');
  assert.strictEqual(csv.format, 'csv');
  assert.strictEqual(csv.ext, 'csv');
  assert.strictEqual(csv.rows, 2);
  assert.strictEqual(csv.text.charCodeAt(0), 0xFEFF, 'CSV 没带 UTF-8 BOM（Excel 打开会乱码）');
  assert.strictEqual(csv.text.trimEnd().split('\n').length, 3, 'CSV 应有表头 + 2 行');
  assert.ok(csv.text.indexOf('"含""引号""的书"') >= 0, 'CSV 引号没转义（会把一列撑成两列）');
  assert.ok(csv.text.indexOf('这段正文不该出现') < 0, 'CSV 里混进了笔记正文');

  const json = modReading.exportList(s, 'json');
  const obj = JSON.parse(json.text);
  assert.strictEqual(obj.schema, 'jiuge.books/v1');
  assert.strictEqual(obj.count, 2);
  assert.ok(obj.note.indexOf('不含书籍正文') >= 0, 'JSON 没写清自己不含正文');
  assert.deepStrictEqual(obj.books[0].tags, ['规范']);
  assert.strictEqual(obj.books[0].noteCount, 1);
  assert.ok(json.text.indexOf('这段正文不该出现') < 0, 'JSON 里混进了笔记正文');

  const opds = modReading.exportList(s, 'opds');
  assert.strictEqual(opds.ext, 'xml');
  assert.ok(/^<\?xml/.test(opds.text), 'OPDS 缺 XML 声明');
  assert.ok(opds.text.indexOf('<feed xmlns="http://www.w3.org/2005/Atom"') >= 0, 'OPDS 根元素不对');
  assert.strictEqual((opds.text.match(/<entry>/g) || []).length, 2, 'OPDS 条目数不对');
  assert.strictEqual((opds.text.match(/acquisition/g) || []).length, 1,
    '只有有文件的那本才该有 acquisition 链接');
  assert.ok(opds.text.indexOf('&quot;') >= 0 || opds.text.indexOf('含"引号"') < 0,
    'OPDS 没转义引号，XML 会坏');
  assert.ok(opds.text.indexOf('</feed>') >= 0, 'OPDS 没闭合');

  // 脏格式名不抛，退回 csv
  assert.strictEqual(modReading.exportList(s, 'xml').format, 'csv');
  assert.strictEqual(modReading.exportList(s, null).format, 'csv');
});

test('v2', 'reading/目录口径：章节锚点归一成 ch-<节序>，非法值丢弃，能清空', function () {
  let s = modReading.normalize({
    books: [{ id: 'b1', title: '书' }],
    chapters: [
      { id: 'c1', bookId: 'b1', title: '第一章', anchor: 'ch-3' },
      { id: 'c2', bookId: 'b1', title: '第二章', anchor: '第4节' },
      { id: 'c3', bookId: 'b1', title: '第三章', anchor: 'ch-' },
      { id: 'c4', bookId: 'b1', title: '第四章' }
    ]
  });
  assert.strictEqual(s.chapters[0].anchor, 'ch-3');
  assert.strictEqual(s.chapters[1].anchor, '', '非法锚点没被丢掉（会让「跳哪一节」变成猜）');
  assert.strictEqual(s.chapters[2].anchor, '');
  assert.strictEqual(s.chapters[3].anchor, '');
  assert.strictEqual(modReading.chapterSeq('ch-7'), 7);
  assert.strictEqual(modReading.chapterSeq('ch-'), -1);
  assert.strictEqual(modReading.chapterSeq(''), -1);
  // 加章节时能带锚点；改章节能改锚点，也能清回纯大纲
  let s2 = modReading.addChapter(s, 'b1', { id: 'c5', title: '第五章', anchor: 'ch-5' });
  assert.strictEqual(s2.chapters.filter(function (c) { return c.id === 'c5'; })[0].anchor, 'ch-5');
  s2 = modReading.updateChapter(s2, 'c5', { anchor: '' });
  assert.strictEqual(s2.chapters.filter(function (c) { return c.id === 'c5'; })[0].anchor, '');
  // 归一化幂等：锚点不会被反复加前缀
  assert.deepStrictEqual(modReading.normalize(s2), s2);
});

test('v2', 'reading/体检：根被删了但书还挂着它的 id，要报出来但不当急病处理', function () {
  const s = modReading.normalize({
    books: [{ id: 'b1', title: '甲', rootId: 'rt-gone', relPath: 'a.epub', filePath: 'D:/Books/a.epub' }]
  });
  const a = modReading.audit(s);
  assert.strictEqual(a.counts.danglingRoots, 1, '根没了却没报（「这书该跟着根走」会静默失效）');
  assert.strictEqual(a.dangling.roots[0].rootId, 'rt-gone');
  // 修复不动它：根可以再登记回来，届时同一本书会自动重新挂上
  const rep = modReading.repairDangling(s);
  assert.strictEqual(rep.fixed, 0, '修断链顺手把根引用清了（会让书再也挂不回根）');
  // 根登记回来，书自动重新挂上
  const back = modReading.addRoot(s, { id: 'rt-gone', path: 'D:' + String.fromCharCode(92) + 'Books' });
  assert.strictEqual(back.books[0].rootId, 'rt-gone');
  assert.strictEqual(modReading.audit(back).counts.danglingRoots, 0);
});

test('v2', '家庭亲子/归一化：脏数据不炸、幂等、历史归属不被成员表擦掉', function () {
  const raw = {
    members: [
      { id: 'm1', name: ' 小满 ', role: 'child', birthday: '2021-03-05', school: '中班' },
      { id: 'm1', name: '重复 id', role: 'child' },
      { name: '', role: 'child' }
    ],
    moments: [
      { id: 'x1', date: '2026-11-16', memberIds: ['m1', 'm-gone'], kind: 'play', minutes: 40, text: '拼完恐龙拼图' },
      { id: 'x2', date: '2026-13-40', memberIds: [], kind: '不存在的类型', minutes: 99999, text: '日期非法' }
    ],
    milestones: [{ id: 'g1', date: '2026-11-15', memberIds: ['m1'], kind: 'first', title: '第一次自己穿鞋' }]
  };
  const s = modFamily.normalize(raw);
  assert.strictEqual(s.members.length, 1, '重复 id / 空名成员没被清掉');
  assert.strictEqual(s.members[0].name, '小满');
  // 成员已删的 id 在归一化时保留：那天陪的是谁，不能因为删了档案就说不清
  assert.deepStrictEqual(s.moments.filter(function (m) { return m.id === 'x1'; })[0].memberIds, ['m1', 'm-gone'],
    '归一化按成员表裁剪了历史时刻的归属');
  const bad = s.moments.filter(function (m) { return m.id === 'x2'; })[0];
  assert.strictEqual(bad.kind, 'company', '非法类型没回落到「陪伴」');
  assert.strictEqual(bad.minutes, 1440, '时长没按一天封顶');
  assert.deepStrictEqual(modFamily.normalize(s), s, 'normalize 不是幂等的');
});

test('v2', '家庭亲子/成员：生日算年龄，三岁以内到月，非法生日当没填', function () {
  assert.strictEqual(modFamily.ageOf('2021-03-05', '2026-11-16').text, '5 岁');
  assert.strictEqual(modFamily.ageOf('2025-08-20', '2026-11-16').text, '1 岁 2 个月');
  assert.strictEqual(modFamily.ageOf('2026-01-10', '2026-11-16').text, '10 个月');
  assert.strictEqual(modFamily.ageOf('2026-13-40', '2026-11-16').text, '', '非法生日被当成有效日期');
  const s = modFamily.normalize({ members: [{ id: 'm1', name: '小满', birthday: '2026-13-40' }] });
  assert.strictEqual(s.members[0].birthday, '', '非法生日没被丢掉');
});

test('v2', '家庭亲子/时刻：正文必填、成员上限、已删成员不接受新记录', function () {
  let s = modFamily.empty();
  s = modFamily.addMember(s, { name: '小满' });
  s = modFamily.addMember(s, { name: '小满妈', role: 'partner' });
  const ids = s.members.map(function (m) { return m.id; });
  s = modFamily.addMoment(s, { text: '', memberIds: ids });
  assert.strictEqual(s.moments.length, 0, '空正文也建了一条时刻');
  s = modFamily.addMoment(s, { text: '一起读绘本', memberIds: ids.concat(['ghost']) });
  assert.strictEqual(s.moments.length, 1);
  assert.deepStrictEqual(s.moments[0].memberIds, ids, '新记录挂到了不存在的成员上');
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  s = modFamily.addMoment(s, { text: '太多人', memberIds: many });
  assert.ok(s.moments[0].memberIds.length <= 6, '成员数没有上限');
});

test('v2', '家庭亲子/周窗口：周日归上一周，周一才是新一周', function () {
  // 2026-11-16 是周一
  const w1 = modFamily.weekWindow('2026-11-16');
  assert.strictEqual(w1.start, '2026-11-16');
  assert.strictEqual(w1.end, '2026-11-22');
  const w2 = modFamily.weekWindow('2026-11-22'); // 周日
  assert.strictEqual(w2.start, '2026-11-16', '周日被算进了下一周（当天统计会忽然归零）');
});

test('v2', '家庭亲子/派生：本周覆盖与未覆盖只数事实，删成员不删历史', function () {
  let s = modFamily.empty();
  s = modFamily.addMember(s, { name: '小满' });
  s = modFamily.addMember(s, { name: '小满妈', role: 'partner' });
  const kid = s.members[0].id;
  const mom = s.members[1].id;
  s = modFamily.addMoment(s, { date: '2026-11-16', memberIds: [kid], minutes: 40, text: '拼图' });
  s = modFamily.addMoment(s, { date: '2026-11-17', memberIds: [kid, mom], minutes: 20, text: '一起散步' });
  const b = modFamily.board(s, '2026-11-17');
  assert.strictEqual(b.weekStats.moments, 2);
  assert.strictEqual(b.weekStats.minutes, 60);
  assert.strictEqual(b.weekStats.covered, 2);
  assert.strictEqual(b.weekStats.days, 2);
  assert.strictEqual(b.streak, 2, '连续记录天数算错');
  assert.deepStrictEqual(b.weekStats.untouched, []);
  // 删掉妈妈：历史时刻仍在，归属 id 不被擦掉，但「覆盖成员」按现存成员算
  s = modFamily.removeMember(s, mom);
  const b2 = modFamily.board(s, '2026-11-17');
  assert.strictEqual(b2.counts.members, 1);
  assert.strictEqual(b2.counts.moments, 2, '删成员把历史时刻一起删了');
  assert.strictEqual(b2.moments.filter(function (m) { return m.text === '一起散步'; })[0].memberIds.length, 2,
    '删成员把历史时刻的归属擦掉了');
  assert.strictEqual(b2.weekStats.covered, 1);
});

test('v2', '家庭亲子/跨机合并：只补不改、按 id 去重、可反复导入', function () {
  let mine = modFamily.empty();
  mine = modFamily.addMember(mine, { name: '小满' });
  // addMember 不吃外部 id（防止撞 id），所以拿回来的 id 才是真 id
  const mineId = mine.members[0].id;
  mine = modFamily.addMoment(mine, { text: '我的记录', date: '2026-11-16' });
  const other = modFamily.normalize({
    members: [{ id: mineId, name: '改名了' }, { id: 'm2', name: '小满妈' }],
    moments: [{ id: 'z1', text: '对面的记录', date: '2026-11-15' }]
  });
  const once = modFamily.mergeSection(mine, other);
  assert.strictEqual(once.added, 2, '新增条目数不对（成员 1 + 时刻 1）');
  assert.strictEqual(once.state.members.filter(function (m) { return m.id === mineId; })[0].name, '小满',
    '合并覆盖了本机已有成员的名字（只补不改）');
  const twice = modFamily.mergeSection(once.state, other);
  assert.strictEqual(twice.added, 0, '同一份备份导入两次又加了一遍');
  assert.deepStrictEqual(twice.state, once.state, '重复导入不改内容却不是幂等');
});

test('v2', '家庭亲子/农历生日：公历↔农历互推、闰月缺失退回普通月、幂等', function () {
  const lunar = require(path.resolve(__dirname, '../../src/family/lunar.js'));
  // 三个已知春节锚点：换算错一天，纪念日就会提醒错一天
  assert.deepStrictEqual(lunar.solarToLunar(2024, 2, 10), { year: 2024, month: 1, day: 1, leap: false });
  assert.deepStrictEqual(lunar.solarToLunar(2025, 1, 29), { year: 2025, month: 1, day: 1, leap: false });
  assert.deepStrictEqual(lunar.solarToLunar(2026, 2, 17), { year: 2026, month: 1, day: 1, leap: false });
  assert.deepStrictEqual(lunar.lunarToSolar(2026, 1, 1, false), { year: 2026, month: 2, day: 17 });
  assert.deepStrictEqual(lunar.lunarToSolar(2024, 8, 15, false), { year: 2024, month: 9, day: 17 },
    '中秋换算不对');
  // 表外年份明确返回 null，不猜
  assert.strictEqual(lunar.lunarToSolar(1899, 1, 1, false), null);
  assert.strictEqual(lunar.lunarToSolar(2050, 1, 1, false), null);
  // 闰月不存在时退回普通月，并标记 shifted
  const shifted = lunar.resolveLunar(2026, 6, 1, true);
  assert.strictEqual(shifted.shifted, true, '没有闰月却没退回普通月');
  assert(!!shifted.date, '退回后应该有可用的公历日期');
});

test('v2', '家庭亲子/纪念日：阳历与农历都能算下一次，未勾选不进提醒', function () {
  let s = modFamily.empty();
  s = modFamily.addMember(s, { name: '阳历宝', birthday: '2018-11-20', anniversaryOn: true });
  s = modFamily.addMember(s, {
    name: '农历宝', calendarType: 'lunar', birthYear: 2018, lunarMonth: 8, lunarDay: 15, anniversaryOn: true
  });
  s = modFamily.addMember(s, { name: '不提醒', birthday: '2018-11-20', anniversaryOn: false });
  const b = modFamily.board(s, '2026-11-16');
  // 默认窗口 30 天：这里只有阳历那条在窗口内；农历那条要放宽窗口才看得到。
  assert.strictEqual(b.anniversaries.length, 1, '未勾纪念日的成员不该进提醒');
  const all = modFamily.anniversariesOf(s, '2026-11-16', 400);
  assert.strictEqual(all.length, 2, '未勾纪念日的成员不该进提醒');
  const solar = all.filter(function (a) { return a.kind === 'solar'; })[0];
  const lunarOne = all.filter(function (a) { return a.kind === 'lunar'; })[0];
  assert.strictEqual(solar.date, '2026-11-20', '阳历生日没算到今年');
  assert.strictEqual(solar.daysUntil, 4, '距生日天数不对');
  assert(lunarOne.date > '2026-11-16', '农历生日没有顺延到下一次');
  assert(modFamily.lunarLabel(s.members[1]).indexOf('农历八月十五') >= 0, '农历生日文案不对');
  assert(modFamily.ageLunarOf(s.members[1], '2026-11-16').text.indexOf('岁') >= 0, '农历年龄没算出来');
  assert.deepStrictEqual(modFamily.normalize(s), s, '新增历法字段后 normalize 不再幂等');
});

console.log('');
if (failed > 0) {
  console.log('  失败明细: ' + JSON.stringify(failures, null, 2));
}
console.log('========================================');
process.exitCode = failed > 0 ? 1 : 0;
