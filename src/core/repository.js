'use strict';
// B 架构 M2 地基：结构化仓储（单一真源）+ 按 key 精确失效 + StoragePort
// 主进程内函数调用替代上一版 N 次跨进程 sendSync，跨进程 IPC 从 O(篇数) 降为 O(1)。
// 对应 03 技术方案 §3.3 / §4.2，04-质量保障方案 §4.5、§5
const fs = require('fs');
const path = require('path');
const contract = require('./contract');
const persistence = require('./persistence');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createRepository(opts) {
  const dir = opts.dir;
  const journal = opts.journal;
  const dataFile = path.join(dir, 'store.json');
  const idempotency = contract.createIdempotency(opts.idempotency);
  const listeners = [];
  let map = new Map();
  let revision = 0;
  let dirty = false;
  let readOnly = false;

  fs.mkdirSync(dir, { recursive: true });

  function load() {
    const doc = persistence.readJsonSafe(dataFile);
    if (doc && doc.entries && typeof doc.entries === 'object') {
      map = new Map(Object.entries(doc.entries));
      revision = doc.revision || 0;
    }
    const pending = journal.pending();
    for (let i = 0; i < pending.length; i++) {
      const rec = pending[i];
      if (rec.op === 'set') map.set(rec.key, clone(rec.value));
      else if (rec.op === 'remove') map.delete(rec.key);
      if (rec.seq > revision) revision = rec.seq;
    }
    dirty = pending.length > 0;
    return { loaded: map.size, replayed: pending.length, revision: revision };
  }

  function assertWritable() {
    if (readOnly) {
      const err = new Error('数据目录只读，拒绝写入');
      err.code = contract.CODE.READ_ONLY;
      throw err;
    }
  }

  function emit(changedKeys) {
    const event = { keys: changedKeys, revision: revision, originWindowId: opts.originWindowId || 'main' };
    for (let i = 0; i < listeners.length; i++) listeners[i](event);
  }

  function set(key, value, meta) {
    assertWritable();
    const requestId = meta && meta.requestId;
    const cached = idempotency.check(requestId);
    if (cached) return clone(cached);
    // 先落 journal（fsync）再改内存：崩溃可回放，落盘确认语义
    const rec = journal.append({ op: 'set', key: key, value: clone(value) });
    map.set(key, clone(value));
    revision = Math.max(revision, rec.seq);
    dirty = true;
    const result = {
      revision: revision,
      changedKeys: [key],
      journalSeq: rec.seq,
      fsync: true
    };
    idempotency.remember(requestId, result);
    emit(result.changedKeys);
    return clone(result);
  }

  function remove(key, meta) {
    assertWritable();
    const requestId = meta && meta.requestId;
    const cached = idempotency.check(requestId);
    if (cached) return clone(cached);
    const rec = journal.append({ op: 'remove', key: key });
    map.delete(key);
    revision = Math.max(revision, rec.seq);
    dirty = true;
    const result = { revision: revision, changedKeys: [key], journalSeq: rec.seq, fsync: true };
    idempotency.remember(requestId, result);
    emit(result.changedKeys);
    return clone(result);
  }

  function get(key) { return clone(map.get(key)); }
  function getBatch(keys) {
    const out = {};
    const list = Array.isArray(keys) ? keys : [];
    for (let i = 0; i < list.length; i++) {
      if (map.has(list[i])) out[list[i]] = clone(map.get(list[i]));
    }
    return out;
  }
  function has(key) { return map.has(key); }
  // UI 状态 / 快照 / 指标日志一律用 __ 前缀，不进日记命名空间
  function keys() {
    return Array.from(map.keys()).filter(function (k) { return k.indexOf('__') !== 0; });
  }
  function entries() { return Object.fromEntries(map); }
  function isDirty() { return dirty; }
  function setReadOnly(value) { readOnly = !!value; }
  function onChange(fn) { listeners.push(fn); return function () {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  }; }

  function flush(reason) {
    if (!dirty) return { flushed: false, reason: reason || 'unknown' };
    persistence.writeBak(dataFile);
    const res = persistence.atomicWriteJson(dataFile, {
      schemaVersion: 2,
      revision: revision,
      updatedAt: Date.now(),
      entries: entries()
    });
    journal.checkpoint(journal.seq);
    dirty = false;
    return { flushed: true, bytes: res.bytes, revision: revision, reason: reason || 'unknown' };
  }

  function contentHashMap() {
    const out = {};
    const list = keys();
    for (let i = 0; i < list.length; i++) out[list[i]] = contract.contentHash(map.get(list[i]));
    return out;
  }

  // StoragePort：8 个 utils 不改动一行，靠主进程注入的 global.wx 适配器复用
  // 小程序语义：不存在的键返回空字符串；getStorageInfoSync().keys 提供全量键视图
  //
  // 软删除（封存箱）就挂在这两个方法上：diary-store 读数据只有这一条路，
  // 所以过滤放在这里，listDates/all/stats/search/export 全部自动干净，
  // 不需要改动任何一个冻结的 utils 文件。
  // opts.isHidden 延迟求值：createRepository 时封存箱模块可能还没建好（反向依赖）。
  function hidden(key) {
    if (typeof opts.isHidden !== 'function') return false;
    try { return !!opts.isHidden(key); } catch (e) { return false; }
  }

  function createWxAdapter() {
    return {
      getStorageSync: function (key) {
        if (hidden(key)) return '';
        return map.has(key) ? clone(map.get(key)) : '';
      },
      setStorageSync: function (key, value) { set(key, value); },
      removeStorageSync: function (key) { remove(key); },
      getStorageInfoSync: function () {
        return {
          keys: Array.from(map.keys()).filter(function (k) { return !hidden(k); }),
          currentSize: 0,
          limitSize: 10 * 1024 * 1024
        };
      }
    };
  }

  return {
    load: load,
    set: set,
    remove: remove,
    get: get,
    getBatch: getBatch,
    has: has,
    keys: keys,
    entries: entries,
    isDirty: isDirty,
    setReadOnly: setReadOnly,
    onChange: onChange,
    flush: flush,
    contentHashMap: contentHashMap,
    createWxAdapter: createWxAdapter,
    dataFile: dataFile,
    get revision() { return revision; }
  };
}

module.exports = { createRepository: createRepository };
