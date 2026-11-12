'use strict';
// B 架构 M1：journal WAL-lite
// 每次 upsert 先 appendFileSync + fsyncSync 再改内存；崩溃后启动回放未确认条目。
// 对应 04-质量保障方案 §4.4；这是消灭上一版 80ms 丢稿窗口的关键，不是把防抖调短。
const fs = require('fs');
const path = require('path');

function createJournal(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'journal.jsonl');
  const checkpointFile = path.join(dir, 'journal.checkpoint');
  let fd = null;
  let seq = 0;
  let checkpointSeq = 0;

  if (fs.existsSync(checkpointFile)) {
    try {
      checkpointSeq = parseInt(fs.readFileSync(checkpointFile, 'utf8').trim(), 10) || 0;
    } catch (e) {
      checkpointSeq = 0;
    }
  }
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.seq > seq) seq = rec.seq;
      } catch (e) {
        // 半行写入（崩溃残留）跳过，不回放损坏条目
      }
    }
  }

  function ensureFd() {
    if (fd === null) fd = fs.openSync(file, 'a');
    return fd;
  }

  function append(entry) {
    const rec = Object.assign({ seq: ++seq, ts: Date.now() }, entry);
    const line = JSON.stringify(rec) + '\n';
    const handle = ensureFd();
    fs.writeSync(handle, line, null, 'utf8');
    fs.fsyncSync(handle);
    return rec;
  }

  // 只回放 checkpoint 之后、当前 seq 之内的条目
  function pending() {
    if (!fs.existsSync(file)) return [];
    const out = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.seq > checkpointSeq && rec.seq <= seq) out.push(rec);
      } catch (e) {
        // 同上：忽略崩溃半行
      }
    }
    return out;
  }

  // R-18（2026-11-12）：原先只推进 checkpoint 序号、从不截断，journal.jsonl 会随使用时长
  // 无限增长，且每次冷启动要整file读两遍（createJournal + pending）。
  // 截断的安全前提：**全部条目都已 checkpoint**（checkpointSeq >= seq）。
  // 此时回放已不需要任何旧行；未 checkpoint 的条目一律不动，避免丢可恢复数据。
  const ROTATE_BYTES = 256 * 1024;
  function rotate() {
    if (checkpointSeq < seq) return { rotated: false, reason: 'uncheckpointed' };
    if (!fs.existsSync(file)) return { rotated: false, reason: 'absent' };
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { return { rotated: false, reason: 'stat-failed' }; }
    if (size <= ROTATE_BYTES) return { rotated: false, reason: 'small', size: size };
    close();
    const tmp = file + '.tmp';
    // 用「空文件 + rename」而不是 truncate：rename 是原子的，崩在中间不会留下半截文件。
    fs.writeFileSync(tmp, '', 'utf8');
    fs.renameSync(tmp, file);
    return { rotated: true, freed: size };
  }

  function checkpoint(n) {
    const target = Math.max(checkpointSeq, n === undefined ? seq : n);
    const tmp = checkpointFile + '.tmp';
    fs.writeFileSync(tmp, String(target), 'utf8');
    fs.renameSync(tmp, checkpointFile);
    checkpointSeq = target;
    // checkpoint 之后尝试截断；不满足安全前提时静默跳过（不影响 checkpoint 本身）
    try { rotate(); } catch (e) { /* 截断失败不影响主流程，下次 checkpoint 再试 */ }
    return target;
  }

  function close() {
    if (fd !== null) {
      fs.closeSync(fd);
      fd = null;
    }
  }

  return {
    append: append,
    pending: pending,
    checkpoint: checkpoint,
    rotate: rotate,
    close: close,
    get seq() { return seq; },
    get checkpointSeq() { return checkpointSeq; },
    get file() { return file; }
  };
}

module.exports = { createJournal: createJournal };
