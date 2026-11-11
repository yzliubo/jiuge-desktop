'use strict';
// B 架构 M0：统一响应 / 错误码 / 幂等 / 分页 / 稳定哈希
// 对应 docs/04-质量保障方案.md §2 门禁、§4.3 导入契约、03 技术方案 §6 API 规范
const crypto = require('crypto');

const CODE = {
  OK: 'OK',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_FORMAT: 'INVALID_FORMAT',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  CLIENT_EXCEPTION: 'CLIENT_EXCEPTION',
  CONFLICT: 'CONFLICT',
  READ_ONLY: 'READ_ONLY',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  SECOND_INSTANCE: 'SECOND_INSTANCE',
  BACKUP_REQUIRED: 'BACKUP_REQUIRED',
  PARTIAL: 'PARTIAL'
};

function ok(data, message) {
  return { code: CODE.OK, message: message || 'ok', data: data === undefined ? null : data };
}

function fail(code, message, data) {
  return { code: code, message: message || code, data: data === undefined ? null : data };
}

// 稳定序列化：键名排序，保证 contentHash 不受对象插入顺序影响
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(function (k) {
    return JSON.stringify(k) + ':' + stableStringify(value[k]);
  }).join(',') + '}';
}

function contentHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 所有列表强制分页：默认 50，上限 200，禁止无上限全量返回
function paginate(items, cursor, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
  const start = Math.max(parseInt(cursor, 10) || 0, 0);
  const slice = list.slice(start, start + size);
  return {
    items: slice,
    cursor: start + size < list.length ? String(start + size) : null,
    total: list.length,
    pageSize: size
  };
}

// 写操作幂等：requestId 去重，24h TTL，LRU 上限
function createIdempotency(opts) {
  const ttlMs = (opts && opts.ttlMs) || 24 * 60 * 60 * 1000;
  const max = (opts && opts.max) || 2000;
  const seen = new Map();
  return {
    check: function (requestId) {
      if (!requestId) return null;
      const hit = seen.get(requestId);
      if (!hit) return null;
      if (Date.now() - hit.ts > ttlMs) {
        seen.delete(requestId);
        return null;
      }
      return hit.result;
    },
    remember: function (requestId, result) {
      if (!requestId) return;
      if (seen.size >= max) seen.delete(seen.keys().next().value);
      seen.set(requestId, { ts: Date.now(), result: result });
    },
    size: function () { return seen.size; }
  };
}

module.exports = {
  CODE: CODE,
  ok: ok,
  fail: fail,
  stableStringify: stableStringify,
  contentHash: contentHash,
  sha256: sha256,
  paginate: paginate,
  createIdempotency: createIdempotency
};
