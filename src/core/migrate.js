'use strict';
// B 架构 M0：一次性迁移器（六道安全网）
// 1 只读 orig 锚点 2 预检 9 固定键 3 未知键 raw_kv 4 只读双跑逐键比对
// 5 manifest.json 6 一键回滚（回滚前强制导出 v7，不假装无损）
// 对应 04-质量保障方案 §4.1、03 技术方案 §4.1
const fs = require('fs');
const path = require('path');
const contract = require('./contract');
const persistence = require('./persistence');

const DIARY_KEY_RE = /^morning_diary_(\d{4}-\d{2}-\d{2})$/;
const REVIEW_PREFIX = 'morning_review_';

// 已知配置键：与小程序 9 固定键语义一致；不在此集合的键进 raw_kv 兜底
const KNOWN_EXACT = new Set([
  'morning_started_at', 'morning_template', 'morning_firstweek',
  'md_modules', 'md_study_library', 'md_quote_today', 'md_base_intake',
  'skin_theme', 'skin_tip_seen', 'morning_milestones', 'morning_capsules',
  'morning_capsule', 'md_milestones', 'md_capsules'
]);

function isKnownKey(key) {
  if (KNOWN_EXACT.has(key)) return true;
  if (DIARY_KEY_RE.test(key)) return true;
  if (key.indexOf(REVIEW_PREFIX) === 0) return true;
  return false;
}

function createMigrator(opts) {
  const legacyPath = opts.legacyPath;
  const dataDir = opts.dataDir;
  const repository = opts.repository;
  const legacyDir = path.join(dataDir, 'legacy');
  const origPath = path.join(legacyDir, 'store.json.orig');
  const manifestPath = path.join(dataDir, 'manifest.json');
  let prepared = null;

  function prepare() {
    if (!fs.existsSync(legacyPath)) return { skipped: true, reason: 'NO_LEGACY' };
    fs.mkdirSync(legacyDir, { recursive: true });
    const buf = fs.readFileSync(legacyPath);
    // 只读锚点：永不删除，回滚的唯一依据
    fs.writeFileSync(origPath, buf);
    prepared = { bytes: buf.length, sha256: contract.sha256(buf) };
    return prepared;
  }

  function readLegacy() {
    let raw;
    try {
      const text = fs.readFileSync(origPath, 'utf8').replace(/^\uFEFF/, '');
      raw = JSON.parse(text);
    } catch (e) {
      return { error: contract.CODE.INVALID_JSON };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: contract.CODE.INVALID_FORMAT };
    }
    return { raw: raw };
  }

  function precheck(raw) {
    const stats = { diary: 0, config: 0, review: 0, unknown: 0 };
    const problems = [];
    const allKeys = Object.keys(raw);
    for (let i = 0; i < allKeys.length; i++) {
      const key = allKeys[i];
      const value = raw[key];
      const m = DIARY_KEY_RE.exec(key);
      if (m) {
        stats.diary++;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          problems.push(key + ': 日记记录不是对象');
        } else if (value.date && value.date !== m[1]) {
          problems.push(key + ': 记录 date 与键名不一致');
        } else if (value.cells && typeof value.cells !== 'object') {
          problems.push(key + ': cells 结构非法');
        }
      } else if (key.indexOf(REVIEW_PREFIX) === 0) {
        stats.review++;
      } else if (isKnownKey(key)) {
        stats.config++;
      } else {
        stats.unknown++;
      }
    }
    return { stats: stats, problems: problems, ok: problems.length === 0 };
  }

  function map(raw) {
    const entries = {};
    const rawKv = {};
    const allKeys = Object.keys(raw);
    for (let i = 0; i < allKeys.length; i++) {
      const key = allKeys[i];
      if (isKnownKey(key)) entries[key] = raw[key];
      else rawKv[key] = raw[key];
    }
    if (Object.keys(rawKv).length > 0) entries.__raw_kv = rawKv;
    return { entries: entries, rawKv: rawKv };
  }

  // 只读双跑灰度：旧扁平 KV 与新映射逐键 contentHash 比对，全部一致才允许提交
  function dualRun(raw, mapped) {
    const knownKeys = Object.keys(raw).filter(isKnownKey);
    const diffs = [];
    for (let i = 0; i < knownKeys.length; i++) {
      const key = knownKeys[i];
      if (contract.contentHash(raw[key]) !== contract.contentHash(mapped.entries[key])) {
        diffs.push(key);
      }
    }
    return { compared: knownKeys.length, diffs: diffs, consistent: diffs.length === 0 };
  }

  function run() {
    const p = prepare();
    if (p.skipped) return { skipped: true, reason: p.reason };
    const parsed = readLegacy();
    if (parsed.error) return { error: parsed.error };
    const pre = precheck(parsed.raw);
    if (!pre.ok) {
      return { error: contract.CODE.MIGRATION_FAILED, problems: pre.problems, readOnly: true };
    }
    const mapped = map(parsed.raw);
    const dual = dualRun(parsed.raw, mapped);
    if (!dual.consistent) {
      return { error: contract.CODE.MIGRATION_FAILED, diffs: dual.diffs, readOnly: true };
    }
    const keys = Object.keys(mapped.entries);
    for (let i = 0; i < keys.length; i++) repository.set(keys[i], mapped.entries[keys[i]]);
    const flushed = repository.flush('migration');
    const manifest = {
      schemaVersion: 2,
      migratedFrom: 'legacy-kv',
      sourceSha256: p.sha256,
      sourceBytes: p.bytes,
      checksums: repository.contentHashMap(),
      migratedAt: new Date().toISOString(),
      migrationComplete: true,
      writtenKeys: keys.length
    };
    persistence.atomicWriteJson(manifestPath, manifest);
    return { ok: true, prepared: p, precheck: pre, dual: dual, manifest: manifest, flush: flushed };
  }

  // 回滚：必须已导出 v7 备份；orig 复原 + jiuge-data 重命名（绝不删除）
  function rollback(opts2) {
    if (!(opts2 && opts2.v7BackupWritten)) {
      return {
        error: contract.CODE.BACKUP_REQUIRED,
        message: '回滚前必须导出一份 v7 备份；迁移后新写的内容需通过这份备份导回，不假装无损'
      };
    }
    if (!fs.existsSync(origPath)) return { error: 'NO_ORIG' };
    fs.copyFileSync(origPath, legacyPath);
    const archived = dataDir + '.rollback-' + Date.now();
    fs.renameSync(dataDir, archived);
    return { ok: true, archived: archived, legacyPath: legacyPath };
  }

  function verify() {
    const parsed = readLegacy();
    if (parsed.error) return { error: parsed.error };
    return dualRun(parsed.raw, map(parsed.raw));
  }

  return {
    prepare: prepare,
    readLegacy: readLegacy,
    precheck: precheck,
    map: map,
    dualRun: dualRun,
    run: run,
    rollback: rollback,
    verify: verify,
    isKnownKey: isKnownKey,
    origPath: origPath,
    manifestPath: manifestPath
  };
}

module.exports = { createMigrator: createMigrator, isKnownKey: isKnownKey, DIARY_KEY_RE: DIARY_KEY_RE };
