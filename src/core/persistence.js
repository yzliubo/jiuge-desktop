'use strict';
// B 架构 M1：原子写 / .bak / 快照
// tmp -> fsync -> rename -> 目录 fsync；写前复制 .bak；破坏性操作前强制快照。
// 对应 04-质量保障方案 §4.4、§9 checklist
const fs = require('fs');
const path = require('path');

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const text = JSON.stringify(obj);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Windows 不支持目录 fsync，失败时静默降级（文件本身已 fsync）
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (e) { /* noop */ }
  return { bytes: Buffer.byteLength(text, 'utf8') };
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function writeBak(file) {
  if (!fs.existsSync(file)) return false;
  fs.copyFileSync(file, file + '.bak');
  return true;
}

function restoreBak(file) {
  const bak = file + '.bak';
  if (!fs.existsSync(bak)) return false;
  fs.copyFileSync(bak, file);
  return true;
}

function createSnapshot(dataDir, label, meta) {
  const storeFile = path.join(dataDir, 'store.json');
  const snapDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const id = String(Date.now()) + '-' + String(label || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(snapDir, id);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(storeFile)) fs.copyFileSync(storeFile, path.join(dir, 'store.json'));
  atomicWriteJson(path.join(dir, 'meta.json'), {
    id: id,
    label: label || 'manual',
    createdAt: new Date().toISOString(),
    meta: meta || null
  });
  return { id: id, dir: dir };
}

function listSnapshots(dataDir) {
  const snapDir = path.join(dataDir, 'snapshots');
  if (!fs.existsSync(snapDir)) return [];
  return fs.readdirSync(snapDir).filter(function (name) {
    return fs.existsSync(path.join(snapDir, name, 'meta.json'));
  }).sort().reverse();
}

function restoreSnapshot(dataDir, id) {
  const src = path.join(dataDir, 'snapshots', id, 'store.json');
  if (!fs.existsSync(src)) return false;
  const storeFile = path.join(dataDir, 'store.json');
  writeBak(storeFile);
  fs.copyFileSync(src, storeFile);
  return true;
}

module.exports = {
  atomicWriteJson: atomicWriteJson,
  readJsonSafe: readJsonSafe,
  writeBak: writeBak,
  restoreBak: restoreBak,
  createSnapshot: createSnapshot,
  listSnapshots: listSnapshots,
  restoreSnapshot: restoreSnapshot
};
