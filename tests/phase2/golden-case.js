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
const modTrace = require(path.resolve(__dirname, '../../src/trace/board.js'));
const modVault = require(path.resolve(__dirname, '../../src/secure/vault.js'));
const modAttach = require(path.resolve(__dirname, '../../src/attach/links.js'));
const modGtd = require(path.resolve(__dirname, '../../src/gtd/board.js'));
const modReading = require(path.resolve(__dirname, '../../src/reading/board.js'));
const modEpub = require(path.resolve(__dirname, '../../src/reading/epub.js'));
const modReaderSource = require(path.resolve(__dirname, '../../src/reading/reader-source.js'));
const modWorktime = require(path.resolve(__dirname, '../../src/worktime/board.js'));
const modFinance = require(path.resolve(__dirname, '../../src/finance/board.js'));
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

test('v2', 'reading/board：回写行 / 防重复 / 合并幂等 / 主题书单只读', function () {
  const n = {
    mode: 'theme', bookTitle: '给水排水', page: 32, tags: ['管网', '读书'],
    quote: '原文一句', text: '我的想法', createdAt: Date.now()
  };
  const line = modReading.noteToDiaryLine(n);
  assert.ok(line.indexOf('【读书·主题阅读】') === 0, '回写行缺阅读模式');
  assert.ok(line.indexOf('《给水排水》') >= 0 && line.indexOf('p.32') >= 0, '回写行缺书名 / 页码');
  assert.ok(line.indexOf('#管网') >= 0 && line.indexOf('我的想法') >= 0, '回写行缺标签 / 正文');
  let s = modReading.normalize(modReading.addNote(modReading.empty(),
    Object.assign({}, n, { bookId: 'b1', themeId: 't1', type: 'highlight' })));
  const id = s.notes[0].id;
  let p = modReading.normalize(modReading.markPushed(s, id, 'growth', 1000));
  p = modReading.normalize(modReading.markPushed(p, id, 'leisure', 2000));
  assert.strictEqual(p.notes[0].pushedAt, 1000, '重复回写不得覆盖标记');
  assert.strictEqual(p.notes[0].pushedCell, 'growth', '重复回写不得改落格');
  const themeBooks = [{ themeId: 't1', themeTitle: '给排水', bookId: 'b1', title: '给水排水', total: 100, done: 20, pct: 20, status: 'reading' }];
  const bd = modReading.board(p, themeBooks);
  assert.strictEqual(bd.themeBooks.length, 1, 'board 应原样带出主题书单');
  assert.strictEqual(modReading.normalize(p).books.length, 0, '主题书单不得写进 state.books（不能有两份书单）');
  assert.strictEqual(modReading.mergeSection(modReading.empty(), p).state.notes.length, 1, '合并应补进笔记');
  assert.strictEqual(modReading.mergeSection(p, p).added, 0, '二次合并必须幂等');
  assert.ok(modReading.exportMarkdown(p, themeBooks).indexOf('# 读书笔记') === 0, '汇总导出缺标题');
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
  const bd = modReading.board(s, []);
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

test('v2', 'reading/reader-source：TXT / MD 分章、PDF 明确不支持、编码兜底不抛', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-text-'));
  const md = path.join(dir, 'note.md');
  const txt = path.join(dir, 'book.txt');
  const pdf = path.join(dir, 'a.pdf');
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
    fs.writeFileSync(pdf, 'x');
    const p = modReaderSource.openBook(pdf);
    assert.ok(p.ok && p.supported === false && p.reason, 'PDF 应如实标注不支持');
    assert.strictEqual(modReaderSource.openBook(path.join(dir, 'nope.epub')).ok, false, '不存在应 ok:false');
    assert.strictEqual(modReaderSource.chapter(md, 999).ok, false, '越界应 ok:false');
  } finally {
    [md, txt, pdf].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { /* noop */ } });
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
  assert.ok(modReading.exportMarkdown(s, []).indexOf('# 读书笔记') === 0, '加书签后导出不应崩');
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
  assert.strictEqual(modReading.board(s, []).stats.bookmarks, 0, 'stats 应带书签数');
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

console.log('');
if (failed > 0) {
  console.log('  失败明细: ' + JSON.stringify(failures, null, 2));
}
console.log('========================================');
process.exitCode = failed > 0 ? 1 : 0;
