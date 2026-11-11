'use strict';
// V1.3「把时间的纵深做出来」——零新键、零状态、不碰 8 个冻结 utils。
// 全部是纯函数：输入是 diary.all() 的记录数组或仓库键值，输出只是派生数据。
// 主进程只负责把 diary / repo / dataDir 接进来（见 main-v2.js 的 v13.* 注册）。
//
// 五件事：人生月历、正文待办汇总、随机重读、导出卡数据、「一个文件」打包。
// 设计红线：
//   ① 不改写任何正文（待办汇总只读，勾选必须回原文，否则两处真相）；
//   ② 不假装知道用户能活多久（未填生日时统一说「从第一条记录算起」）；
//   ③ 打包产物只装数据键，绝不装程序文件、日志、备份目录里的可执行物。

const APP_TAG = 'jiuge-notes';
const PACK_KIND = 'jiuge-pack';
const PACK_VERSION = 1;
const TODO_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/;

function pad(n) { return (n < 10 ? '0' + n : String(n)); }
function monthKey(y, m) { return String(y) + '-' + pad(m + 1); }
function isDateKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// 富文本存的是 Markdown 子集；统计「有没有写字」时要把标记剥掉，
// 否则一个只有 `**` 的格子会被当成有内容。
function stripMarkdown(text) {
  return String(text || '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*]\s+\[[ xX]\]\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();
}

function cellText(record) {
  const cells = (record && record.cells) || {};
  return Object.keys(cells).map(function (k) {
    return typeof cells[k] === 'string' ? cells[k] : String(cells[k] == null ? '' : cells[k]);
  }).join('\n');
}

function hasContent(record) { return stripMarkdown(cellText(record)).length > 0; }

function cleanRecords(records) {
  return (Array.isArray(records) ? records : []).filter(function (r) {
    return r && isDateKey(r.date);
  });
}

// ---------- A1 人生月历：100 年 × 12 月 = 1200 格 ----------
// 口径（docs/10 D2）：填了出生年月就从出生年算；没填就从第一条记录那年起算，
// 并在文案里明确「从第一条记录算起」——绝不输出「你已走过 N 个月」这种假装
// 知道生日的话。两种口径都画满 100 年，格子数固定 1200，便于门禁断言。
function calendar(records, opts) {
  const o = opts || {};
  const list = cleanRecords(records);
  const now = o.now instanceof Date ? o.now : new Date();
  const years = Math.max(1, Math.min(100, Number(o.years) || 100));
  const byMonth = Object.create(null);
  let first = null;
  list.forEach(function (r) {
    const k = String(r.date).slice(0, 7);
    if (hasContent(r)) byMonth[k] = (byMonth[k] || 0) + 1;
    if (!first || r.date < first) first = r.date;
  });
  const birth = typeof o.birth === 'string' && /^\d{4}(-\d{2})?$/.test(o.birth) ? o.birth : '';
  const basis = birth ? 'birth' : 'record';
  let startYear;
  if (birth) startYear = Number(birth.slice(0, 4));
  else if (first) startYear = Number(first.slice(0, 4));
  else startYear = now.getFullYear();

  const months = [];
  let written = 0;
  let passed = 0;
  for (let i = 0; i < years * 12; i++) {
    const y = startYear + Math.floor(i / 12);
    const m = i % 12;
    const key = monthKey(y, m);
    const count = byMonth[key] || 0;
    if (count > 0) written += 1;
    if (key <= monthKey(now.getFullYear(), now.getMonth())) passed += 1;
    // 0 = 空白，1~4 按当月写过几天分档；不用连续色阶，避免 1200 个色值
    const level = count === 0 ? 0 : count >= 12 ? 4 : count >= 6 ? 3 : count >= 3 ? 2 : 1;
    months.push({ key: key, year: y, month: m + 1, count: count, level: level, future: y > now.getFullYear() });
  }
  return {
    basis: basis,
    startYear: startYear,
    years: years,
    firstRecordDate: first,
    months: months,
    writtenMonths: written,
    passedMonths: passed,
    totalRecords: list.length,
    // 视图只能用这句话；未填生日时「你已走过」是错的
    headline: basis === 'birth'
      ? '你已走过 ' + passed + ' 个月，其中 ' + written + ' 个月留下过记录'
      : '从第一条记录算起 ' + passed + ' 个月，其中 ' + written + ' 个月留下过记录'
  };
}

// ---------- A2 正文待办汇总：只读 ----------
// 同一天同一格里完全相同的一行只算一条；已封存的记录不会出现在 diary.all() 里。
function todos(records) {
  const open = [];
  const done = [];
  const seen = Object.create(null);
  cleanRecords(records).forEach(function (r) {
    const cells = (r && r.cells) || {};
    Object.keys(cells).forEach(function (cell) {
      const raw = typeof cells[cell] === 'string' ? cells[cell] : '';
      raw.split(/\r?\n/).forEach(function (line, idx) {
        const m = TODO_RE.exec(line);
        if (!m) return;
        const text = m[2].trim();
        if (!text) return;
        const dedupe = r.date + '|' + cell + '|' + (m[1] === ' ' ? 'o' : 'x') + '|' + text;
        if (seen[dedupe]) return;
        seen[dedupe] = 1;
        const row = { date: r.date, cell: cell, text: text, line: idx + 1, raw: line.trim() };
        (m[1] === ' ' ? open : done).push(row);
      });
    });
  });
  open.sort(function (a, b) { return b.date.localeCompare(a.date); });
  done.sort(function (a, b) { return b.date.localeCompare(a.date); });
  return { open: open, done: done, total: open.length + done.length, days: Object.keys(seen).length };
}

// ---------- A4 随机重读 ----------
// 排除今天与空记录；exclude 是最近看过的日期数组，窗口内不重复。
function pickRandom(records, exclude, opts) {
  const o = opts || {};
  const today = typeof o.today === 'string' ? o.today : '';
  const skip = Object.create(null);
  (Array.isArray(exclude) ? exclude : []).forEach(function (d) { skip[d] = 1; });
  const pool = cleanRecords(records).filter(function (r) {
    return r.date !== today && !skip[r.date] && hasContent(r);
  });
  if (pool.length === 0) return null;
  const rand = typeof o.rand === 'function' ? o.rand : Math.random;
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  return pool[i];
}

// ---------- A3 导出为一张图：只准备数据，绘制在渲染层 ----------
// 默认不带软件名水印（docs/10 D3）；视图里给「显示软件名」开关，默认关。
function cardData(record, labels, opts) {
  const o = opts || {};
  const r = record || {};
  const map = labels || {};
  const cells = r.cells || {};
  const lines = [];
  Object.keys(cells).forEach(function (k) {
    const text = stripMarkdown(typeof cells[k] === 'string' ? cells[k] : '');
    if (text) lines.push({ label: map[k] || k, text: text.slice(0, 120) });
  });
  return {
    date: isDateKey(r.date) ? r.date : '',
    lines: lines,
    quote: typeof o.quote === 'string' ? o.quote : '',
    brand: o.brand === true ? '九格手记' : ''
  };
}

// ---------- §10 一个文件：只装数据键 ----------
// 不做 zip（零依赖下手写 zip 容易出错，且引入新的失败面）：
// 用一个带 kind/version 的 JSON 文本容器，扩展名 .jiuge，可解析、可校验、可还原。
function isDataKey(k) {
  return typeof k === 'string' && k.indexOf('__') !== 0 && k.length > 0;
}

function packSnapshot(keys, readKey, meta) {
  const out = Object.create(null);
  const used = [];
  (Array.isArray(keys) ? keys : []).forEach(function (k) {
    if (!isDataKey(k)) return;
    used.push(k);
    out[k] = readKey(k);
  });
  const payload = {
    app: APP_TAG,
    kind: PACK_KIND,
    version: PACK_VERSION,
    exportedAt: new Date().toISOString(),
    keyCount: used.length,
    keys: Object.keys(out).sort(),
    data: out,
    meta: meta || {}
  };
  const text = JSON.stringify(payload);
  return { text: text, keyCount: used.length, keys: payload.keys, bytes: Buffer.byteLength(text, 'utf8') };
}

function verifyPack(text) {
  let obj;
  try { obj = JSON.parse(String(text || '')); } catch (e) {
    return { ok: false, error: '不是有效的 .jiuge 文件', keys: [], keyCount: 0 };
  }
  if (!obj || obj.app !== APP_TAG || obj.kind !== PACK_KIND) {
    return { ok: false, error: '不是九格的数据打包文件', keys: [], keyCount: 0 };
  }
  if (obj.version !== PACK_VERSION) {
    return { ok: false, error: '打包文件版本不兼容：' + obj.version, keys: [], keyCount: 0 };
  }
  if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
    return { ok: false, error: '打包文件里没有数据段', keys: [], keyCount: 0 };
  }
  const keys = Object.keys(obj.data).filter(isDataKey).sort();
  if (keys.some(function (k) { return String(k).indexOf('app.asar') >= 0 || /\.(exe|dll|js)$/.test(k); })) {
    return { ok: false, error: '打包文件里混进了程序文件', keys: [], keyCount: 0 };
  }
  return { ok: true, error: '', keys: keys, keyCount: keys.length, data: obj.data, exportedAt: obj.exportedAt || '' };
}

// 只补写不覆盖：本机已有的键一律保留，避免「导入一份旧包把今天写没了」。
function unpackInto(text, existsKey, writeKey) {
  const v = verifyPack(text);
  if (!v.ok) return { ok: false, added: 0, skipped: 0, error: v.error, keys: [] };
  let added = 0;
  let skipped = 0;
  v.keys.forEach(function (k) {
    if (existsKey(k)) { skipped += 1; return; }
    writeKey(k, v.data[k]);
    added += 1;
  });
  return { ok: true, added: added, skipped: skipped, error: '', keys: v.keys };
}

module.exports = {
  APP_TAG: APP_TAG,
  PACK_KIND: PACK_KIND,
  PACK_VERSION: PACK_VERSION,
  stripMarkdown: stripMarkdown,
  cellText: cellText,
  hasContent: hasContent,
  calendar: calendar,
  todos: todos,
  pickRandom: pickRandom,
  cardData: cardData,
  packSnapshot: packSnapshot,
  verifyPack: verifyPack,
  unpackInto: unpackInto
};
