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

  function checkpoint(n) {
    const target = Math.max(checkpointSeq, n === undefined ? seq : n);
    const tmp = checkpointFile + '.tmp';
    fs.writeFileSync(tmp, String(target), 'utf8');
    fs.renameSync(tmp, checkpointFile);
    checkpointSeq = target;
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
    close: close,
    get seq() { return seq; },
    get checkpointSeq() { return checkpointSeq; },
    file: file
  };
}

module.exports = { createJournal: createJournal };
