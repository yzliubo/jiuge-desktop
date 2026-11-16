'use strict';
// 电子书指纹：文件大小 + 首 64KB 的 SHA-256（十六进制 64 位）。
//
// 为什么不是「整个文件哈希」：书动辄几十 MB，每次登记都全量读一遍，
// 拖十本书进来就是几百 MB 的同步磁盘 I/O，主进程会卡住窗口。
// 首 64KB 足以区分「同一本书的另一次下载」与「另一本书」——EPUB/PDF 的头部
// 就带着容器结构、元数据与第一段正文，撞车概率在个人书库这个量级可以忽略。
// 大小拼进哈希是为了让「同前缀、不同长度」的两个文件不会认成同一本。
//
// 这里只算、只返回字符串；写不写进 books 由领域层决定，读不读盘由调用方决定。
const fs = require('fs');
const crypto = require('crypto');

const HEAD_BYTES = 64 * 1024;

/**
 * 算一个文件的指纹。
 * @param {string} filePath 本机绝对路径
 * @returns {string} 64 位小写十六进制
 * @throws 文件不存在 / 无权限 / 是目录时抛出，调用方负责转成用户能看懂的话
 */
function fingerprintOf(filePath) {
  const p = String(filePath || '');
  if (!p) throw new Error('缺少文件路径');
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('不是文件：' + p);
  const len = Math.min(st.size, HEAD_BYTES);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(p, 'r');
  try {
    if (len > 0) fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  const h = crypto.createHash('sha256');
  h.update(String(st.size) + ':');
  h.update(buf);
  return h.digest('hex');
}

/** 算指纹但绝不抛：给「登记时顺手算一下」用，算不出来就返回空串（书照样能入库）。 */
function fingerprintSafe(filePath) {
  try { return fingerprintOf(filePath); } catch (_) { return ''; }
}

/** 文件大小（字节），不存在返回 0。避免调用方各写一遍 try/stat。 */
function sizeOf(filePath) {
  try {
    const st = fs.statSync(String(filePath || ''));
    return st.isFile() ? st.size : 0;
  } catch (_) { return 0; }
}

module.exports = { fingerprintOf: fingerprintOf, fingerprintSafe: fingerprintSafe, sizeOf: sizeOf, HEAD_BYTES: HEAD_BYTES };
