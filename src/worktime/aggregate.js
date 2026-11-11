// 九格手记 · 工作模块「本机时间源」聚合内核
//
// 设计立场（写死在文件头，防止实现漂移）：
//   1. 只吃「已合并的窗口事件 + AFK 事件」，不碰 ActivityWatch 内部库、不复制其查询语言文本；
//   2. 一切时间用绝对毫秒计算，时区只在调用方（决定 dayStart/dayEnd）出现一次；
//   3. 输出只有聚合结果，**不保留窗口标题**；规则匹配用完即弃；
//   4. 纯函数、零依赖、时间由调用方传入，便于 golden 断言。

'use strict';

const MIN = 60 * 1000;
const DEFAULT_ZERO_DURATION = 60 * 1000; // duration=0 且无下一条时，按一分钟兜底
const ZERO_DURATION_MAX_GAP = 5 * 60 * 1000; // 下一条超过 5 分钟，说明中间是断档，不吃进来
const BLOCK_MIN = 10 * MIN; // 小于 10 分钟不叫「一段」，是碎片
const BLOCK_GAP_MERGE = 2 * MIN; // 同一归类间隔 ≤2 分钟视为连续
const BLOCK_MAX = 12;
const APP_MAX = 40;

function toMs(ts) {
    if (typeof ts === 'number') return ts;
    const v = Date.parse(ts);
    return Number.isNaN(v) ? NaN : v;
}

function normalizeApp(app) {
    return String(app == null ? '' : app)
        .trim()
        .toLowerCase()
        .replace(/\.exe$/i, '');
}

/** 事件归一：{s, e, app, title, dur} 并按起点排序；duration<=0 用下一条起点补全 */
function toSegments(events, dayStart, dayEnd) {
    const raw = [];
    for (const ev of events || []) {
        const s = toMs(ev && ev.timestamp);
        if (Number.isNaN(s)) continue;
        const d = Number(ev.duration) > 0 ? Number(ev.duration) * 1000 : 0;
        raw.push({ s, e: s + d, app: normalizeApp(ev.data && ev.data.app), title: (ev.data && ev.data.title) || '', dur: d });
    }
    raw.sort((a, b) => a.s - b.s);
    for (let i = 0; i < raw.length; i++) {
        const cur = raw[i];
        if (cur.dur > 0) continue;
        const next = raw[i + 1];
        if (next && next.s - cur.s <= ZERO_DURATION_MAX_GAP) {
            cur.e = Math.max(cur.s, next.s);
        } else {
            cur.e = cur.s + DEFAULT_ZERO_DURATION;
        }
    }
    // 前台窗口天然互斥：同一时刻只可能有一个应用在前台。
    // 若上游因 heartbeat 合并留下重叠段，按「先到先得」削掉后一段的重叠部分，
    // 否则 windowSec 会把同一分钟算两次，用户一眼就能看出时长超过一天。
    let frontier = -Infinity;
    for (const seg of raw) {
        if (seg.s < frontier) seg.s = frontier;
        if (seg.e <= seg.s) seg.e = seg.s; // 完全被前一段盖住 → 丢弃
        frontier = Math.max(frontier, seg.e);
    }

    // 裁到当日窗口；跨午夜的事件在这一步被切成两半（两天的调用各自拿到自己的部分）
    const out = [];
    for (const seg of raw) {
        const s = Math.max(seg.s, dayStart);
        const e = Math.min(seg.e, dayEnd);
        if (e > s) out.push({ s, e, app: seg.app, title: seg.title });
    }
    return out;
}

function mergeIntervals(list) {
    const arr = (list || []).filter((x) => x.e > x.s).sort((a, b) => a.s - b.s);
    const out = [];
    for (const x of arr) {
        const last = out[out.length - 1];
        if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
        else out.push({ s: x.s, e: x.e });
    }
    return out;
}

/** 从 base 段里扣掉 cut 区间，返回剩余片段 */
function subtractSegments(base, cut) {
    const cuts = mergeIntervals(cut);
    let pieces = [{ s: base.s, e: base.e, app: base.app, title: base.title }];
    for (const c of cuts) {
        const next = [];
        for (const p of pieces) {
            if (c.e <= p.s || c.s >= p.e) {
                next.push(p);
                continue;
            }
            if (c.s > p.s) next.push({ ...p, e: c.s });
            if (c.e < p.e) next.push({ ...p, s: c.e });
        }
        pieces = next;
    }
    return pieces;
}

/** 规则匹配：title 正则 > app 精确；同层按 order 小者优先；宁可留空也不猜 */
function matchRule(app, title, rules) {
    const list = (rules || []).filter((r) => r && r.enabled !== false);
    const appName = normalizeApp(app);
    const byTitle = list
        .filter((r) => r.titleMatch && new RegExp(r.titleMatch, 'i').test(title || ''))
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (byTitle.length) return byTitle[0];
    const byApp = list
        .filter((r) => r.app && normalizeApp(r.app) === appName && !r.titleMatch)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (byApp.length) return byApp[0];
    return null;
}

function cutBlocks(pieces) {
    const sorted = pieces.slice().sort((a, b) => a.s - b.s);
    const merged = [];
    for (const p of sorted) {
        const last = merged[merged.length - 1];
        if (last && last.label === p.label && p.s - last.e <= BLOCK_GAP_MERGE) {
            last.e = Math.max(last.e, p.e);
        } else {
            merged.push({ s: p.s, e: p.e, label: p.label, app: p.app, ruleId: p.ruleId || null });
        }
    }
    return merged
        .filter((b) => b.e - b.s >= BLOCK_MIN)
        .sort((a, b) => b.e - b.s - (a.e - a.s))
        .slice(0, BLOCK_MAX)
        .sort((a, b) => a.s - b.s);
}

/**
 * @param {object} o
 * @param {Array}  o.windowEvents  aw-watcher-window 事件
 * @param {Array}  o.afkEvents     aw-watcher-afk 事件
 * @param {number} o.dayStart      本地日 00:00 的绝对毫秒
 * @param {number} o.dayEnd        次日 00:00 的绝对毫秒
 * @param {Array}  o.rules         归类规则
 */
function aggregate(o) {
    const dayStart = Number(o.dayStart);
    const dayEnd = Number(o.dayEnd);
    const windows = toSegments(o.windowEvents, dayStart, dayEnd);

    const afk = [];
    let afkCovered = false;
    for (const ev of o.afkEvents || []) {
        const s = toMs(ev && ev.timestamp);
        if (Number.isNaN(s)) continue;
        afkCovered = true;
        const d = Number(ev.duration) > 0 ? Number(ev.duration) * 1000 : 0;
        const e = s + d;
        if (String((ev.data && ev.data.status) || '') === 'afk') afk.push({ s, e });
    }
    const afkMerged = mergeIntervals(afk.map((x) => ({
        s: Math.max(x.s, dayStart),
        e: Math.min(x.e, dayEnd)
    })).filter((x) => x.e > x.s));

    let windowSec = 0;
    let activeSec = 0;
    let afkInWindowSec = 0;
    const byApp = new Map();
    const byRule = new Map();
    const pieces = [];

    for (const seg of windows) {
        windowSec += seg.e - seg.s;
        const rest = subtractSegments(seg, afkMerged);
        const removed = seg.e - seg.s - rest.reduce((n, p) => n + (p.e - p.s), 0);
        afkInWindowSec += removed;

        for (const p of rest) {
            const dur = p.e - p.s;
            activeSec += dur;
            byApp.set(p.app || '(unknown)', (byApp.get(p.app || '(unknown)') || 0) + dur);
            const rule = matchRule(p.app, p.title, o.rules);
            if (rule) {
                byRule.set(rule.id, (byRule.get(rule.id) || 0) + dur);
                pieces.push({ s: p.s, e: p.e, label: rule.label || rule.id, ruleId: rule.id, app: p.app });
            } else {
                pieces.push({ s: p.s, e: p.e, label: '未归类', ruleId: null, app: p.app });
            }
        }
    }

    const toMin = (sec) => Math.round(sec / 60000);
    const apps = [...byApp.entries()]
        .map(([app, sec]) => ({ app, min: toMin(sec) }))
        .filter((x) => x.min > 0)
        .sort((a, b) => b.min - a.min);
    const appOverflow = Math.max(0, apps.length - APP_MAX);

    const classifiedSec = [...byRule.values()].reduce((a, b) => a + b, 0);

    return {
        windowSec: Math.round(windowSec / 1000),
        activeSec: Math.round(activeSec / 1000),
        afkSec: Math.round(afkMerged.reduce((n, x) => n + (x.e - x.s), 0) / 1000),
        afkInWindowSec: Math.round(afkInWindowSec / 1000),
        afkCovered,
        unclassifiedRatio: activeSec > 0 ? Math.round((1 - classifiedSec / activeSec) * 100) : 0,
        apps: apps.slice(0, APP_MAX),
        appOverflow,
        rules: [...byRule.entries()].map(([id, sec]) => ({ id, min: toMin(sec) })).sort((a, b) => b.min - a.min),
        blocks: cutBlocks(pieces).map((b) => ({
            start: b.s,
            end: b.e,
            min: Math.round((b.e - b.s) / 60000),
            app: b.app,
            label: b.label,
            ruleId: b.ruleId
        }))
    };
}

module.exports = { aggregate, normalizeApp, matchRule, mergeIntervals, subtractSegments, toSegments };
