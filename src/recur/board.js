'use strict';
// 九格手记 · 重复任务派生 + 事后耗时登记
//
// 不做计时器：分钟数是事后手填的，模块只负责「完成后派生下一条」和「按周汇总」。
// 数据由主进程仓储读写，本模块只管状态对象，纯函数、零第三方依赖。
// 状态（可 JSON 序列化）：
//   { version: 1,
//     tasks: [ { id, title, context, repeat, due, done } ],  // 可选：id → context 的索引
//     logs:  [ { id, taskId, context, date, minutes } ] }    // 耗时流水，最多 2000 条
//
// 日期一律是 'YYYY-MM-DD' 纯字符串 + 整数运算：不 new Date 解析、不引日期库、不踩时区。
// 唯一例外是 logMinutes 未显式给日期时用一次系统时钟取「今天」——接口只有三个必填参数，
// 拿不到 today；为便于测试，第 4 参数 opts 可注入 { date, context }（或只传日期字符串），
// 不传时才读系统时钟。weekDistribution 的 today 始终由调用方传入。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPEATS = ['day', 'week', 'month', 'year'];
const MAX_LOGS = 2000;
const MAX_TASKS = 2000;
const MAX_MINUTES = 1440;
const TITLE_MAX = 80;
const CONTEXT_MAX = 24;
const ID_MAX = 64;
const UNCLASSIFIED = '未分类';

let logSeq = 0;

function str(v) {
  return String(v === undefined || v === null ? '' : v);
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function pad4(n) { return ('0000' + n).slice(-4); }

function cleanText(v, max) {
  return str(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function cleanTitle(v) { return cleanText(v, TITLE_MAX); }
function cleanContext(v) { return cleanText(v, CONTEXT_MAX); }
function cleanId(v) { return cleanText(v, ID_MAX); }

function clampMinutes(v) {
  const n = num(v);
  return Math.max(0, Math.min(MAX_MINUTES, Math.round(n)));
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const t = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return t[m - 1] || 0;
}

// 严格解析：'2026-02-30' 这种回读不成的假日期要判为无效。
function parseDate(v) {
  const s = str(v);
  if (!DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y: y, m: m, d: d };
}

function fmtDate(p) {
  return pad4(p.y) + '-' + pad2(p.m) + '-' + pad2(p.d);
}

function validDate(v) {
  const p = parseDate(v);
  return p ? fmtDate(p) : '';
}

// 逐日推进：n 只可能是 1 / 7 / 小负数，循环最多几次，无需 Date 与第三方库。
function addDays(p, n) {
  let y = p.y;
  let m = p.m;
  let d = p.d + num(n);
  while (d > daysInMonth(y, m)) {
    d -= daysInMonth(y, m);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  while (d < 1) {
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
    d += daysInMonth(y, m);
  }
  return { y: y, m: m, d: d };
}

// 按月平移并把日号夹到目标月的最后一天：1/31 + 1 月 = 2/28，闰年 = 2/29。
// 年重复走 addMonths(p, 12)，因此 2/29 + 1 年同样安全。
function addMonths(p, n) {
  const total = p.y * 12 + (p.m - 1) + num(n);
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return { y: y, m: m, d: Math.min(p.d, daysInMonth(y, m)) };
}

function shiftDate(p, repeat) {
  if (repeat === 'day') return addDays(p, 1);
  if (repeat === 'week') return addDays(p, 7);
  if (repeat === 'month') return addMonths(p, 1);
  if (repeat === 'year') return addMonths(p, 12);
  return p;
}

// Sakamoto 算法：返回 0=周日 .. 6=周六，纯整数运算，不依赖 Date / 时区。
function weekday(y, m, d) {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = m < 3 ? y - 1 : y;
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100)
    + Math.floor(yy / 400) + t[m - 1] + d) % 7;
}

function mondayOf(p) {
  const back = (weekday(p.y, p.m, p.d) + 6) % 7;
  return addDays(p, -back);
}

function todayOf() {
  const d = new Date();
  return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function newLogId() {
  logSeq += 1;
  return 'min_' + Date.now().toString(36) + '_' + logSeq;
}

function isDone(x) {
  return x.done === true || x.done === 1 || x.status === 'done'
    || num(x.completedAt) > 0 || num(x.doneAt) > 0;
}

// 完成后派生下一条重复任务；不满足条件返回 null。
// 防堆积硬规则：allTasks 里若已有「同 title + 同 context 且未完成」的实例就不派生。
// 判定「未完成」看 done === true / status === 'done' / completedAt / doneAt。
// 当前正在被完成的那条按对象身份（或同 id）排除，否则调用方还没改状态时会永远派生不出来。
// 下一条的日期基准取 max(due, today)：逾期完成后不会把新任务派生回过去。
function deriveNext(task, allTasks, today) {
  const t = isObj(task) ? task : {};
  const repeat = cleanText(t.repeat, 12).toLowerCase();
  if (REPEATS.indexOf(repeat) < 0) return null;
  const title = cleanTitle(t.title);
  const context = cleanContext(t.context);
  if (!title) return null;

  const list = Array.isArray(allTasks) ? allTasks : [];
  const hasOpenTwin = list.some(function (x) {
    if (!isObj(x)) return false;
    if (x === task) return false;
    if (t.id && x.id && str(t.id) === str(x.id)) return false;
    if (isDone(x)) return false;
    return cleanTitle(x.title) === title && cleanContext(x.context) === context;
  });
  if (hasOpenTwin) return null;

  const day = parseDate(today);
  const due = parseDate(t.due);
  let base = due;
  if (!base) base = day;
  else if (day && fmtDate(day) > fmtDate(base)) base = day;
  if (!base) return null;

  // 只回传核心字段：其余元数据由调用方按自己的任务模型补齐，避免两处真相。
  return {
    title: title,
    context: context,
    repeat: repeat,
    due: fmtDate(shiftDate(base, repeat)),
    done: false,
  };
}

// normalize 幂等：缺失/重复 id 用「下标」推确定性兜底值，绝不在里面用时间或随机数。
// 分钟数夹到 0..1440，非数字按 0；logs 只留最近 2000 条（丢最老的）。
function normalize(raw) {
  const src = isObj(raw) ? raw : {};

  const seenTask = {};
  const tasks = (Array.isArray(src.tasks) ? src.tasks : []).slice(-MAX_TASKS)
    .map(function (t, idx) {
      const row = isObj(t) ? t : {};
      let id = cleanId(row.id);
      if (!id || seenTask[id]) {
        id = 'task_' + idx;
        let n = 0;
        while (seenTask[id]) { n += 1; id = 'task_' + idx + '_' + n; }
      }
      seenTask[id] = true;
      const repeat = cleanText(row.repeat, 12).toLowerCase();
      return {
        id: id,
        title: cleanTitle(row.title),
        context: cleanContext(row.context),
        repeat: REPEATS.indexOf(repeat) >= 0 ? repeat : null,
        due: validDate(row.due),
        done: row.done === true || row.done === 1 || row.status === 'done',
      };
    });

  const seenLog = {};
  const logs = (Array.isArray(src.logs) ? src.logs : []).slice(-MAX_LOGS)
    .map(function (l, idx) {
      const row = isObj(l) ? l : {};
      let id = cleanId(row.id);
      if (!id || seenLog[id]) {
        id = 'min_' + idx;
        let n = 0;
        while (seenLog[id]) { n += 1; id = 'min_' + idx + '_' + n; }
      }
      seenLog[id] = true;
      return {
        id: id,
        taskId: cleanId(row.taskId),
        context: cleanContext(row.context) || UNCLASSIFIED,
        date: validDate(row.date),
        minutes: clampMinutes(row.minutes),
      };
    });

  return { version: 1, tasks: tasks, logs: logs };
}

function contextOfTask(s, id) {
  const hit = s.tasks.filter(function (t) { return t.id === id; })[0];
  return hit ? hit.context : '';
}

// 登记一次耗时。第 4 参数 opts 是可选的测试注入口：
//   · 传字符串当作日期；传对象用 { date, context }；
//   · 不传日期时取系统当天（本模块唯一读时钟的地方）；
//   · context 优先取 opts.context，其次查 state.tasks 的 id → context，最后落 '未分类'。
// 同一 taskId 同一天重复登记按累加处理（与 growth.addPractice 口径一致），总量夹在 1440。
function logMinutes(state, taskId, minutes, opts) {
  const s = normalize(state);
  const id = cleanId(taskId);
  if (!id) return s;
  const o = isObj(opts) ? opts : (typeof opts === 'string' ? { date: opts } : {});
  const date = validDate(o.date) || todayOf();
  const context = cleanContext(o.context || contextOfTask(s, id)) || UNCLASSIFIED;
  const add = clampMinutes(minutes);

  const hit = s.logs.filter(function (l) {
    return l.taskId === id && l.date === date;
  })[0];
  if (hit) {
    hit.minutes = clampMinutes(hit.minutes + add);
    if (o.context) hit.context = context;
  } else {
    s.logs.push({ id: newLogId(), taskId: id, context: context, date: date, minutes: add });
  }
  return normalize(s);
}

// 本周投入分布。口径：周一为起点，统计 [本周一, today]（含两端）的日志，
// 未来日期与无有效日期的脏记录不计入；byContext 按分钟倒序，只列分钟 > 0 的情境。
function weekDistribution(state, today) {
  const s = normalize(state);
  const day = parseDate(today);
  if (!day) return { total: 0, byContext: [] };
  const from = fmtDate(mondayOf(day));
  const to = fmtDate(day);

  const acc = {};
  let total = 0;
  s.logs.forEach(function (l) {
    if (!l.date || l.date < from || l.date > to) return;
    const c = l.context || UNCLASSIFIED;
    acc[c] = (acc[c] || 0) + l.minutes;
    total += l.minutes;
  });

  const byContext = Object.keys(acc).map(function (c) {
    return { context: c, minutes: acc[c] };
  }).filter(function (row) { return row.minutes > 0; })
    .sort(function (a, b) {
      if (b.minutes !== a.minutes) return b.minutes - a.minutes;
      return a.context.localeCompare(b.context);
    });
  return { total: total, byContext: byContext };
}

module.exports = {
  deriveNext: deriveNext,
  logMinutes: logMinutes,
  weekDistribution: weekDistribution,
  normalize: normalize,
};
