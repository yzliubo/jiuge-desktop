'use strict';
// 本地使用度量（整改 R-11）
//
// 为什么要有它：docs/02 把「次日留存 ≥60% / 第 4 周 ≥40% / 迁移完成率 ≥90%」
// 写成验收指标，但生产源码里 metrics.log 零命中——三个指标没有数据源，
// 门禁只能判「不可验收」而不是「不达标」。
//
// 三条硬约束（写在这个文件里，不靠约定）：
//   ① **绝不写正文**：只允许 kind 白名单里登记的字段，其余一律丢弃；
//   ② **不落 store.json**：写 <dataDir>/metrics.log（JSONL），因此 exportBackup
//      序列化 store 时结构上不可能把它带出去；
//   ③ **不联网**：纯 fs.appendFileSync，没有任何网络调用。
//
// 轮转：超过 maxBytes 就改名成 metrics.log.1 再重开，避免重演 WAL 只追加不截断。

const fs = require('fs');
const path = require('path');

// 字段白名单：只有这里登记的键会被写入。任何正文类字段（text/content/note/body）
// 都不在表内，写进来也会被丢掉。
const ALLOWED = {
  app_start: ['ts', 'version'],
  entry_save: ['ts', 'date', 'ms'],
  search_use: ['ts', 'mode'],
  migrate: ['ts', 'stage'],
  quick_capture: ['ts', 'date'],
  snapshot_restore: ['ts', 'id'],
  backup_run: ['ts', 'reason'],
  // V3.8 成效侧：从「用得多不多」补到「有没有真的推动」。
  // 只记「发生了一次、落在哪一天」，不记任务标题、不记目标名、不记复盘答案。
  // kind 是一小组枚举（progress/metric/status/period），不是自由文本。
  outcome_task_done: ['ts', 'date', 'n'],
  outcome_dream_move: ['ts', 'date', 'kind'],
  outcome_read_move: ['ts', 'date', 'n'],
  outcome_review: ['ts', 'date', 'period']
};

// 成效侧的四类事件：完成一件任务 / 目标被推动 / 阅读往前翻 / 复盘落成。
// 名字里带 outcome_ 前缀的才进成效汇总，别的 kind 混进来也不算。
const OUTCOME_KINDS = ['task_done', 'dream_move', 'read_move', 'review'];


const FORBIDDEN_FIELDS = ['text', 'content', 'body', 'note', 'title', 'raw', 'payload'];

function pad(n) { return (n < 10 ? '0' : '') + n; }
function localDate(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}
function dayDiff(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((tb - ta) / 86400000);
}
function pct(list, p) {
  if (!list.length) return 0;
  const a = list.slice().sort(function (x, y) { return x - y; });
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}

function createMetrics(dir, opts) {
  const file = path.join(dir, 'metrics.log');
  const offFlag = path.join(dir, 'metrics.off');
  const maxBytes = (opts && opts.maxBytes) || 2 * 1024 * 1024;
  const keep = (opts && opts.keep) || 1;

  function enabled() { return !fs.existsSync(offFlag); }

  function setEnabled(on) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (on) {
        if (fs.existsSync(offFlag)) fs.unlinkSync(offFlag);
      } else {
        fs.writeFileSync(offFlag, '1', 'utf8');
      }
      return { ok: true, enabled: enabled() };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }

  function rotateIfNeeded() {
    try {
      const st = fs.statSync(file);
      if (st.size < maxBytes) return;
      for (let i = keep; i >= 1; i--) {
        const from = i === 1 ? file : file + '.' + (i - 1);
        const to = file + '.' + i;
        if (fs.existsSync(from)) {
          if (fs.existsSync(to)) fs.unlinkSync(to);
          fs.renameSync(from, to);
        }
      }
    } catch (e) { /* 文件还不存在，首写不算轮转 */ }
  }

  function record(kind, fields) {
    if (!enabled()) return { ok: false, disabled: true };
    const allow = ALLOWED[kind];
    if (!allow) return { ok: false, reason: 'unknown-kind: ' + kind };
    const rec = { k: kind };
    for (let i = 0; i < allow.length; i++) {
      const key = allow[i];
      if (fields && fields[key] !== undefined && fields[key] !== null) rec[key] = fields[key];
    }
    // 双保险：即使有人往 fields 里塞正文，也不会被写出去
    for (let i = 0; i < FORBIDDEN_FIELDS.length; i++) delete rec[FORBIDDEN_FIELDS[i]];
    if (!rec.ts) rec.ts = new Date().toISOString();
    try {
      fs.mkdirSync(dir, { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  function readAll() {
    const out = [];
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.k) out.push(rec);
      } catch (e) { /* 崩溃半行忽略，与 journal 同口径 */ }
    }
    return out;
  }

  // 汇总：只回答「能不能算、算出来多少」，算不出来的显式标 null，不编数字。
  function summary() {
    const recs = readAll();
    const today = localDate();
    const saveDates = {};
    const saveMs = [];
    let searchUses = 0;
    let migrateStart = 0;
    let migrateSuccess = 0;
    let firstDay = '';
    let starts = 0;
    // V3.8 成效侧三档：近 7 天 / 近 30 天 / 全期。窗口口径与「周有效记录天数」同源，
    // 都是「含今天往前 N 个自然日」，免得两个数字用两套算法。
    const out7 = { taskDone: 0, dreamMove: 0, readMove: 0, review: 0 };
    const out30 = { taskDone: 0, dreamMove: 0, readMove: 0, review: 0 };
    const outAll = { taskDone: 0, dreamMove: 0, readMove: 0, review: 0 };
    let outcomeEvents = 0;

    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const ts = String(r.ts || '');
      const d = ts ? localDate(new Date(ts)) : '';
      if (d && (!firstDay || d < firstDay)) firstDay = d;
      if (r.k === 'app_start') starts += 1;
      if (r.k === 'entry_save') {
        const day = String(r.date || d);
        if (day) saveDates[day] = true;
        if (typeof r.ms === 'number' && r.ms >= 0) saveMs.push(r.ms);
      }
      if (r.k === 'search_use') searchUses += 1;
      if (r.k === 'migrate') {
        if (r.stage === 'start') migrateStart += 1;
        if (r.stage === 'success') migrateSuccess += 1;
      }
      // 成效侧：完成一件算一件（gtd.completeAll 会带 n），其余按事件次数算
      if (String(r.k).indexOf('outcome_') === 0 && d) {
        const key = String(r.k).slice(8);
        if (OUTCOME_KINDS.indexOf(key) >= 0) {
          const n = key === 'task_done' ? (Number(r.n) || 1) : 1;
          const bucket = key === 'task_done' ? 'taskDone'
            : (key === 'dream_move' ? 'dreamMove' : (key === 'read_move' ? 'readMove' : 'review'));
          const diff = dayDiff(d, today);
          outAll[bucket] += n;
          outcomeEvents += 1;
          if (diff >= 0 && diff < 7) out7[bucket] += n;
          if (diff >= 0 && diff < 30) out30[bucket] += n;
        }
      }
    }

    const days = Object.keys(saveDates).sort();
    // ① 周有效记录天数：最近 7 个自然日内有落笔的不同日期数（目标 5）
    const weekDays = days.filter(function (d) {
      const diff = dayDiff(d, today);
      return diff >= 0 && diff < 7;
    }).length;

    // ② 次日留存：以首次出现记录的日子为 D0；D0+1 有落笔则留存
    let nextDay = null;
    if (firstDay) {
      const target = days.filter(function (d) { return dayDiff(firstDay, d) === 1; }).length > 0;
      // 只有 D0+1 已经过去，这个值才有意义；否则如实返回 null（未到可判定时间）
      const elapsed = dayDiff(firstDay, today);
      nextDay = elapsed >= 1 ? (target ? 1 : 0) : null;
    }

    // ③ 第 4 周留存：D0+21 ~ D0+27 之间是否有落笔
    let week4 = null;
    if (firstDay) {
      const elapsed = dayDiff(firstDay, today);
      if (elapsed >= 27) {
        const hit = days.some(function (d) {
          const k = dayDiff(firstDay, d);
          return k >= 21 && k <= 27;
        });
        week4 = hit ? 1 : 0;
      }
    }

    // ④ 迁移完成率：success / start（旧档迁移是一次性动作，样本为 0/1）
    const migrateRate = migrateStart > 0 ? Math.round((migrateSuccess / migrateStart) * 1000) / 10 : null;

    // ⑤ 检索使用率：有检索事件的天数 / 有落笔的天数
    const searchDays = {};
    for (let i = 0; i < recs.length; i++) {
      if (recs[i].k !== 'search_use') continue;
      const d = localDate(new Date(recs[i].ts));
      searchDays[d] = true;
    }
    const searchRate = days.length ? Math.round((Object.keys(searchDays).length / days.length) * 1000) / 10 : null;

    return {
      ok: true,
      enabled: enabled(),
      file: file,
      sampleSize: recs.length,
      firstDay: firstDay || null,
      metrics: {
        weekActiveDays: weekDays,
        nextDayRetention: nextDay,
        week4Retention: week4,
        migrateRate: migrateRate,
        searchUsageRate: searchRate,
        saveLatencyP50: saveMs.length ? Math.round(pct(saveMs, 50)) : null,
        saveLatencyP95: saveMs.length ? Math.round(pct(saveMs, 95)) : null
      },
      counts: {
        appStart: starts,
        entrySave: saveDates && Object.keys(saveDates).length,
        saveEvents: saveMs.length,
        searchUse: searchUses,
        migrateStart: migrateStart,
        migrateSuccess: migrateSuccess
      },
      // 成效侧：一条都没有时 available=false，界面据此写「还没有成效事件」，
      // 而不是拿一排 0 冒充「你什么都没做成」。
      outcome: {
        available: outcomeEvents > 0,
        events: outcomeEvents,
        window7: out7,
        window30: out30,
        total: outAll
      }
    };
  }

  return {
    record: record,
    summary: summary,
    setEnabled: setEnabled,
    enabled: enabled,
    file: file
  };
}

module.exports = {
  createMetrics: createMetrics,
  ALLOWED: ALLOWED,
  OUTCOME_KINDS: OUTCOME_KINDS,
  FORBIDDEN_FIELDS: FORBIDDEN_FIELDS
};
