'use strict';
/**
 * 主进程 KV 唯一真源：单文件 store.json + 扁平 KV 对象。
 *
 * 设计要点（架构 §3）：
 *  - 键名 / 值结构与小程序逐字一致，v6/v7 备份可直读直写；
 *  - Map 只是磁盘镜像与写合并缓冲，**不做业务读缓存**（memoAll 等仍在 diary-store 内）；
 *  - kv:set 同步更新 Map → 80ms 防抖合并写盘 + 500ms 限流立即写；
 *  - 原子写：写 tmp 前先留 .bak，再 renameSync 覆盖，任何时刻至少有一份完整旧版；
 *  - 启动解析失败用 .bak 恢复并明确提示，两者都坏则拒绝覆盖写入，绝不静默清空；
 *  - window-state.json / .bak / 导入前快照都是独立文件，从不进入 Map，因此绝不出现在 keys() 里；
 *  - JIUGE_KV_QUOTA 模拟字节阈值，超限回滚该次 Map 变更并返回 QUOTA_EXCEEDED。
 *
 * 本模块只依赖 fs / path，不 require electron，便于 tools/*.js 在纯 Node 下直接验证。
 */
const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 80;
const THROTTLE_MS = 500;
const MAX_IMPORT_SNAPSHOTS = 3;

/** 去掉 UTF-8 BOM（EF BB BF），微信小程序备份可能被记事本另存为带 BOM 的 UTF-8。 */
function stripBom(text) {
  const s = String(text === undefined || text === null ? '' : text);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 本地时区 YYYYMMDD-HHmmss，用于导入前快照文件名。 */
function formatStamp(d) {
  const date = d instanceof Date ? d : new Date();
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return String(date.getFullYear()) + p(date.getMonth() + 1) + p(date.getDate())
    + '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds());
}

/** 本地时区 YYYY-MM-DD，用于导出默认文件名。禁止用 toISOString() 做日期键（架构 §9.3）。 */
function formatDate(d) {
  const date = d instanceof Date ? d : new Date();
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return String(date.getFullYear()) + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
}

/** 单条 KV 的近似序列化字节数；仅供 QUOTA 模拟的增量估算，默认路径完全不调用。 */
function entryBytes(key, value) {
  try {
    return Buffer.byteLength(JSON.stringify(key) + ':' + JSON.stringify(value), 'utf8');
  } catch (e) {
    return 0;
  }
}

function parseFlatObject(raw) {
  const obj = JSON.parse(stripBom(raw));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('store.json 顶层不是扁平 KV 对象');
  }
  return obj;
}

class KvStore {
  /**
   * @param {string} dataDir KV 数据目录（app.getPath('userData')/jiuge-desktop）
   * @param {{quotaBytes?: number, env?: object}} [options]
   */
  constructor(dataDir, options) {
    const opt = options || {};
    const env = opt.env || process.env;
    const rawQuota = Number(env.JIUGE_KV_QUOTA);
    this.quotaLimit = isFinite(rawQuota) && rawQuota > 0 ? Math.floor(rawQuota) : 0;

    this.dataDir = String(dataDir || '');
    this.storePath = path.join(this.dataDir, 'store.json');
    this.bakPath = this.storePath + '.bak';
    this.tmpPath = this.storePath + '.tmp';

    /** @type {Map<string, any>} 唯一真源 */
    this.data = new Map();
    /** @type {Map<string, number>} QUOTA 模拟时的单键字节估算 */
    this.keyBytes = new Map();
    this.totalBytes = 2; // '{}'
    this.dirty = false;
    this.readonly = false;
    /** @type {string[]} 启动恢复提示，交给设置页 / toast 明确展示，绝不静默 */
    this.notices = [];
    this.lastFlushAt = 0;
    this.flushTimer = null;
    this.writeCount = 0;
    this.setCount = 0;
    this.load();
  }

  /** 启动加载：不存在 → 空；解析失败 → .bak 恢复；都坏 → 只读并提示。 */
  load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch (e) {
      this.readonly = true;
      this.notices.push('无法创建数据目录，已停止写入，请手动检查：' + this.dataDir);
      return;
    }

    let raw = null;
    try {
      raw = fs.readFileSync(this.storePath, 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        this.notices.push('数据文件读取失败：' + e.message);
        // 仍尝试从 .bak 恢复，不静默清空
      }
    }

    if (raw !== null) {
      try {
        const obj = parseFlatObject(raw);
        this.applyObject(obj);
        return;
      } catch (e) {
        this.notices.push('数据文件损坏（' + e.message + '），正在尝试从上一份备份恢复');
      }
    } else if (fs.existsSync(this.bakPath)) {
      // store.json 缺失但 .bak 存在：同样尝试恢复，避免用户以为日记丢了
      this.notices.push('数据文件缺失，正在尝试从上一份备份恢复');
    }

    const restored = this.restoreFromBak();
    if (restored) {
      this.notices.push('数据文件损坏，已从上一份备份恢复');
      return;
    }
    if (raw !== null || fs.existsSync(this.bakPath)) {
      this.readonly = true;
      this.notices.push('数据文件与备份均无法读取，已停止写入，请手动处理数据目录中的文件');
    }
    // 全新安装：raw === null 且无 .bak → 空 Map，不产生任何提示
  }

  applyObject(obj) {
    this.data = new Map();
    this.keyBytes = new Map();
    this.totalBytes = 2;
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      this.data.set(k, v);
      if (this.quotaLimit > 0) {
        const b = entryBytes(k, v);
        this.keyBytes.set(k, b);
        this.totalBytes += b + 1; // 逗号分隔的近似
      }
    });
  }

  /** @returns {boolean} 是否成功从 .bak 恢复 */
  restoreFromBak() {
    try {
      const obj = parseFlatObject(fs.readFileSync(this.bakPath, 'utf8'));
      this.applyObject(obj);
      return true;
    } catch (e) {
      return false;
    }
  }

  toObject() {
    const out = {};
    this.data.forEach((v, k) => { out[k] = v; });
    return out;
  }

  /** 对齐 wx.getStorageSync：未命中返回 ''（不是 undefined / null）。 */
  get(key) {
    if (typeof key !== 'string') return '';
    return this.data.has(key) ? this.data.get(key) : '';
  }

  /**
   * 同步更新 Map + 防抖合并写盘 + QUOTA 模拟回滚。
   * @returns {{ok: boolean, error?: string, limitBytes?: number, sizeBytes?: number}}
   */
  set(key, value) {
    if (this.readonly) return { ok: false, error: 'CLIENT_EXCEPTION' };
    if (typeof key !== 'string' || !key) return { ok: false, error: 'CLIENT_EXCEPTION' };
    this.setCount += 1;

    const had = this.data.has(key);
    const prev = this.data.get(key);
    this.data.set(key, value);

    if (this.quotaLimit > 0) {
      const nextEntry = entryBytes(key, value);
      const prevEntry = had ? (this.keyBytes.get(key) || 0) : 0;
      const nextBytes = this.totalBytes + (nextEntry - prevEntry);
      if (nextBytes > this.quotaLimit) {
        // 回滚该次 Map 变更：绝不让超限的值留在内存真源里
        if (had) this.data.set(key, prev);
        else this.data.delete(key);
        return {
          ok: false,
          error: 'QUOTA_EXCEEDED',
          limitBytes: this.quotaLimit,
          sizeBytes: nextBytes,
        };
      }
      this.keyBytes.set(key, nextEntry);
      this.totalBytes = nextBytes;
    }

    this.dirty = true;
    if (Date.now() - this.lastFlushAt >= THROTTLE_MS) {
      this.cancelTimer();
      const r = this.flush();
      if (!r.ok) return r;
    } else {
      this.scheduleFlush();
    }
    return { ok: true };
  }

  remove(key) {
    if (this.readonly) return { ok: false, error: 'CLIENT_EXCEPTION' };
    if (typeof key !== 'string' || !key) return { ok: false, error: 'CLIENT_EXCEPTION' };
    const had = this.data.has(key);
    const prev = this.data.get(key);
    this.data.delete(key);

    if (this.quotaLimit > 0 && had) {
      const b = this.keyBytes.get(key) || 0;
      this.keyBytes.delete(key);
      this.totalBytes = Math.max(2, this.totalBytes - b - 1);
    }

    this.dirty = true;
    if (Date.now() - this.lastFlushAt >= THROTTLE_MS) {
      this.cancelTimer();
      const r = this.flush();
      if (!r.ok) {
        if (had) this.data.set(key, prev);
        return r;
      }
    } else {
      this.scheduleFlush();
    }
    return { ok: true };
  }

  /** 供 getStorageInfoSync().keys；Map 内只有业务键，窗口状态与快照从不在其中。 */
  keys() {
    return Array.from(this.data.keys());
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flush();
    }, DEBOUNCE_MS);
  }

  cancelTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** 强制原子落盘；保存 / 导入结束 / 导出前 / 退出前调用。 */
  flush() {
    this.cancelTimer();
    try {
      return this.atomicWrite();
    } catch (e) {
      return { ok: false, error: 'CLIENT_EXCEPTION', message: String(e && e.message || e) };
    }
  }

  /**
   * 原子写：先留 .bak，再写 store.json.tmp，最后 renameSync 覆盖。
   * 任何时刻至少有一份完整旧版，崩溃也不会留下半截 JSON。
   */
  atomicWrite() {
    if (this.readonly) return { ok: false, error: 'CLIENT_EXCEPTION' };
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.storePath)) {
      try {
        fs.copyFileSync(this.storePath, this.bakPath);
      } catch (e) {
        // 留 .bak 失败不阻断本次写入，下一轮仍会重试
      }
    }
    const text = JSON.stringify(this.toObject());
    fs.writeFileSync(this.tmpPath, text, { encoding: 'utf8', flag: 'w' });
    fs.renameSync(this.tmpPath, this.storePath);
    this.dirty = false;
    this.lastFlushAt = Date.now();
    this.writeCount += 1;
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
  }

  /** 导入前安全网：写一份带时间戳的快照，保留最近 3 份。 */
  snapshotBeforeImport() {
    const snapPath = path.join(this.dataDir, 'store.pre-import-' + formatStamp(new Date()) + '.json');
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(snapPath, JSON.stringify(this.toObject()), { encoding: 'utf8', flag: 'w' });
      this.pruneImportSnapshots();
      return { ok: true, path: snapPath };
    } catch (e) {
      return { ok: false, error: 'CLIENT_EXCEPTION', message: String(e && e.message || e) };
    }
  }

  pruneImportSnapshots() {
    let files = [];
    try {
      files = fs.readdirSync(this.dataDir)
        .filter((name) => /^store\.pre-import-\d{8}-\d{6}\.json$/.test(name))
        .map((name) => {
          const full = path.join(this.dataDir, name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (e) { mtime = 0; }
          return { name: name, full: full, mtime: mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e) {
      return;
    }
    files.slice(MAX_IMPORT_SNAPSHOTS).forEach((item) => {
      try { fs.unlinkSync(item.full); } catch (e) { /* 清理失败不影响导入 */ }
    });
  }

  status() {
    return {
      storePath: this.storePath,
      readonly: this.readonly,
      dirty: this.dirty,
      notices: this.notices.slice(),
      quotaLimit: this.quotaLimit,
      writeCount: this.writeCount,
      setCount: this.setCount,
      keyCount: this.data.size,
    };
  }

  dispose() {
    this.cancelTimer();
  }
}

function createKvStore(dataDir, options) {
  return new KvStore(dataDir, options);
}

module.exports = {
  KvStore: KvStore,
  createKvStore: createKvStore,
  stripBom: stripBom,
  formatStamp: formatStamp,
  formatDate: formatDate,
  DEBOUNCE_MS: DEBOUNCE_MS,
  THROTTLE_MS: THROTTLE_MS,
  MAX_IMPORT_SNAPSHOTS: MAX_IMPORT_SNAPSHOTS,
};
