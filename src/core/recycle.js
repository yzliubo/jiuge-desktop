'use strict';
// M4 封存箱：日记级软删除（删除 → 封存 → 30 天后焚毁）
//
// 设计要点（为什么这么做，而不是改 diary-store）：
// 1. 8 个 utils 与源项目逐字节一致是 verify 第 1 条的等价基线，不能动一行；
//    而且 diary-store 根本没有导出任何删除函数——"删除"这一能力本身是新增的。
// 2. diary-store 读数据只有一条路：repository.createWxAdapter() 的两个方法。
//    所以软删在 adapter 层过滤即可，上层 listDates/all/stats/search/export 全部自动干净。
// 3. 封存时**原值留在 map 里**，只往 __bin 写一条标记 + 摘要。
//    还原 = 删标记（零成本）；彻底删才真删值。这样"手抖"永远可逆。
// 4. __bin 用双下划线前缀，repository.keys() 已过滤该前缀，不会污染日记命名空间。
const DAY_MS = 86400000;

const BIN_KEY = '__bin';
const KEEP_DAYS = 30;
const EXCERPT_MAX = 80;

function str(v) { return typeof v === 'string' ? v : ''; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// 摘要：优先自由格，其次按九格顺序取第一段非空；都不够就看三模块
function excerptOf(record) {
  if (!record || typeof record !== 'object') return { excerpt: '', chars: 0 };
  const order = ['free', 'work', 'growth', 'health', 'relation', 'money', 'emotion', 'dream', 'future'];
  const cells = (record.cells && typeof record.cells === 'object') ? record.cells : {};
  let chars = 0;
  let first = '';
  Object.keys(cells).forEach(function (k) {
    const t = str(cells[k]);
    if (!t) return;
    chars += t.replace(/\s/g, '').length;
  });
  for (let i = 0; i < order.length; i++) {
    const t = str(cells[order[i]]).trim();
    if (t) { first = t; break; }
  }
  if (!first) {
    // 只记了待办/账目/学习也算一篇，摘要退化为一句说明，避免封存箱出现空条目
    if (record.workBoard && Array.isArray(record.workBoard.tasks) && record.workBoard.tasks.length) {
      first = '（这一篇只记了工作看板 ' + record.workBoard.tasks.length + ' 条任务）';
    } else if (record.moneyBook && Array.isArray(record.moneyBook.entries) && record.moneyBook.entries.length) {
      first = '（这一篇只记了 ' + record.moneyBook.entries.length + ' 笔收支）';
    } else {
      first = '（这一篇没有正文）';
    }
  }
  const flat = first.replace(/\s+/g, ' ').trim();
  return {
    excerpt: flat.length > EXCERPT_MAX ? flat.slice(0, EXCERPT_MAX) + '…' : flat,
    chars: chars
  };
}

function createRecycle(opts) {
  const repo = opts.repository;
  const keepDays = num(opts.keepDays) || KEEP_DAYS;
  // 封存/还原/焚毁后都要让 diary-store 的模块级 memo 失效，
  // 否则 all()/writtenDates() 仍返回缓存的旧结果，界面上删了还看得见。
  const onChanged = typeof opts.onChanged === 'function' ? opts.onChanged : function () {};

  function readBin() {
    const raw = repo.get(BIN_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  }

  function writeBin(bin) {
    repo.set(BIN_KEY, bin);
  }

  function isHidden(key) {
    if (!key || typeof key !== 'string') return false;
    const bin = readBin();
    return Object.prototype.hasOwnProperty.call(bin, key);
  }

  function daysLeftOf(sealedAt) {
    const elapsed = Math.floor((Date.now() - num(sealedAt)) / DAY_MS);
    return Math.max(0, keepDays - elapsed);
  }

  function expiresAtOf(sealedAt) {
    return num(sealedAt) + keepDays * DAY_MS;
  }

  function list() {
    const bin = readBin();
    const items = Object.keys(bin).map(function (key) {
      const it = bin[key] || {};
      return {
        key: key,
        date: str(it.date),
        excerpt: str(it.excerpt),
        chars: num(it.chars),
        sealedAt: num(it.sealedAt),
        daysLeft: daysLeftOf(it.sealedAt),
        expiresAt: expiresAtOf(it.sealedAt)
      };
    }).sort(function (a, b) { return b.sealedAt - a.sealedAt; });

    return {
      items: items,
      total: items.length,
      keepDays: keepDays,
      soonest: items.length ? Math.min.apply(null, items.map(function (x) { return x.daysLeft; })) : null
    };
  }

  // 封存：只写标记，不动原值。重复封存幂等（保留最早的时间，避免"重新计算 30 天"）
  function seal(keyOrDate, providedRecord) {
    const raw = str(keyOrDate);
    if (!raw) return { error: 'INVALID_KEY' };
    const key = raw.indexOf('morning_diary_') === 0 ? raw : 'morning_diary_' + raw;
    if (!/^morning_diary_\d{4}-\d{2}-\d{2}$/.test(key)) return { error: 'INVALID_KEY' };

    const bin = readBin();
    if (Object.prototype.hasOwnProperty.call(bin, key)) {
      return { ok: true, already: true, key: key, daysLeft: daysLeftOf(bin[key].sealedAt) };
    }
    const record = providedRecord || repo.get(key);
    if (!record) return { error: 'NOT_FOUND' };

    const digest = excerptOf(record);
    bin[key] = {
      date: str(record.date) || key.slice('morning_diary_'.length),
      excerpt: digest.excerpt,
      chars: digest.chars,
      sealedAt: Date.now()
    };
    writeBin(bin);
    onChanged('seal');
    return { ok: true, already: false, key: key, daysLeft: keepDays };
  }

  function restore(keyOrDate) {
    const raw = str(keyOrDate);
    const key = raw.indexOf('morning_diary_') === 0 ? raw : 'morning_diary_' + raw;
    const bin = readBin();
    if (!Object.prototype.hasOwnProperty.call(bin, key)) return { error: 'NOT_IN_BIN' };
    // 原值若已被彻底删掉（或库被外部改坏），不要假装还原成功
    if (!repo.has(key)) {
      delete bin[key];
      writeBin(bin);
      onChanged('restore-missing');
      return { error: 'SOURCE_GONE' };
    }
    delete bin[key];
    writeBin(bin);
    onChanged('restore');
    return { ok: true, key: key };
  }

  function purge(keyOrDate) {
    const raw = str(keyOrDate);
    const key = raw.indexOf('morning_diary_') === 0 ? raw : 'morning_diary_' + raw;
    const bin = readBin();
    if (!Object.prototype.hasOwnProperty.call(bin, key)) return { error: 'NOT_IN_BIN' };
    delete bin[key];
    writeBin(bin);
    repo.remove(key);
    onChanged('purge');
    return { ok: true, key: key };
  }

  function empty() {
    const bin = readBin();
    const keys = Object.keys(bin);
    if (!keys.length) return { ok: true, removed: 0 };
    // 先清标记再删值：中途失败也不会留下"标记还在但值没了"的悬空条目
    writeBin({});
    keys.forEach(function (k) { if (repo.has(k)) repo.remove(k); });
    onChanged('empty');
    return { ok: true, removed: keys.length };
  }

  // 过期焚毁：启动时跑一次即可。返回数量供数据健康中心展示。
  function sweep(now) {
    const bin = readBin();
    const keys = Object.keys(bin);
    const at = num(now) || Date.now();
    const dead = keys.filter(function (k) {
      return at - num(bin[k] && bin[k].sealedAt) > keepDays * DAY_MS;
    });
    if (!dead.length) return { ok: true, burned: 0 };
    dead.forEach(function (k) { delete bin[k]; });
    writeBin(bin);
    dead.forEach(function (k) { if (repo.has(k)) repo.remove(k); });
    onChanged('sweep');
    return { ok: true, burned: dead.length };
  }

  // 备份用：带完整原文，换机后封存箱还能还原；正文导出（txt/md/JSON records）不含已封存记录
  function snapshotForBackup() {
    const bin = readBin();
    const out = {};
    Object.keys(bin).forEach(function (k) {
      const meta = bin[k] || {};
      out[k] = {
        date: str(meta.date),
        sealedAt: num(meta.sealedAt),
        record: repo.get(k) || null
      };
    });
    return { keepDays: keepDays, entries: out };
  }

  function mergeFromBackup(section) {
    if (!section || typeof section !== 'object') return { added: 0 };
    const entries = section.entries && typeof section.entries === 'object' ? section.entries : {};
    const bin = readBin();
    let added = 0;
    Object.keys(entries).forEach(function (k) {
      if (!/^morning_diary_\d{4}-\d{2}-\d{2}$/.test(k)) return;
      if (Object.prototype.hasOwnProperty.call(bin, k)) return;
      const item = entries[k] || {};
      const record = item.record;
      if (!record) return;
      // 只补不改：库里已有同一天（未封存）时以现有为准，不把用户现存内容悄悄藏起来
      if (repo.has(k)) return;
      repo.set(k, record);
      const digest = excerptOf(record);
      bin[k] = {
        date: str(item.date) || k.slice('morning_diary_'.length),
        excerpt: digest.excerpt,
        chars: digest.chars,
        sealedAt: num(item.sealedAt) || Date.now()
      };
      added += 1;
    });
    if (added) {
      writeBin(bin);
      onChanged('merge');
    }
    return { added: added };
  }

  return {
    BIN_KEY: BIN_KEY,
    KEEP_DAYS: keepDays,
    isHidden: isHidden,
    list: list,
    seal: seal,
    restore: restore,
    purge: purge,
    empty: empty,
    sweep: sweep,
    snapshotForBackup: snapshotForBackup,
    mergeFromBackup: mergeFromBackup,
    daysLeftOf: daysLeftOf
  };
}

module.exports = { createRecycle: createRecycle, BIN_KEY: BIN_KEY, KEEP_DAYS: KEEP_DAYS, excerptOf: excerptOf };
