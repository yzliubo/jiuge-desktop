'use strict';
// 跨模块弱引用层 —— V2.1 ⑱。存 md_trace 单键（新键，不动冻结的 8 个 utils）。
// 让 GTD 任务与日记、账目与胶囊互指：{ from, to, note }。
// from / to 形如 'diary:2026-11-07' / 'gtd:<id>' / 'capsule:<id>'。
//
// 【关键裁决】目标被删时只「显示为灰色残留」，绝不自动清除——
//   自动清除等于悄悄改历史。本模块是弱引用：不校验指向对象是否存在，
//   也不负责删除它们；markMissing() 只加标记，remove() 才显式删引用。
//   上限 2000 条，脏数据幂等。

const MAX_LINKS = 2000;

function str(v) { return typeof v === 'string' ? v : (v === 0 || v ? String(v) : ''); }
function clean(v, max) {
    const s = str(v).replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max) : s;
}
function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function safeNum(v, dflt) {
    const t = typeof v;
    if (t === 'number') return isFinite(v) ? v : dflt;
    if (t === 'string' || t === 'boolean') { const n = Number(v); return isFinite(n) ? n : dflt; }
    return dflt;
}
// 确定性 id：脏数据缺 id 时由内容派生，保证 normalize 幂等（绝不在这里用随机数/时间）。
function hashId(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return 'tr-' + (h >>> 0).toString(36);
}
function newId() { return 'tr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function normLink(raw) {
    const o = obj(raw);
    const from = clean(o.from, 120);
    const to = clean(o.to, 120);
    if (!from || !to) return null;
    const note = clean(o.note, 300);
    const createdAt = safeNum(o.createdAt, 0);
    let id = clean(o.id, 64);
    if (!id) id = hashId(from + '|' + to + '|' + note + '|' + createdAt);
    return { id: id, from: from, to: to, note: note, createdAt: createdAt };
}

function empty() { return { version: 1, links: [] }; }

// normalize：幂等、脏数据不抛。按 id 去重，保留最后 MAX_LINKS 条（最新的）。
function normalize(state) {
    const src = obj(state);
    const seen = {};
    const links = [];
    (Array.isArray(src.links) ? src.links : []).slice(-MAX_LINKS).forEach(function (x) {
        const one = normLink(x);
        if (!one || seen[one.id]) return;
        seen[one.id] = true;
        links.push(one);
    });
    return { version: 1, links: links };
}

// add(state, patch)：返回新 state。缺 from/to 的脏数据不抛，原样返回。
function add(state, patch) {
    const s = normalize(state);
    const p = obj(patch);
    const from = clean(p.from, 120);
    const to = clean(p.to, 120);
    if (!from || !to) return s;
    const one = normLink({
        id: clean(p.id, 64) || newId(),
        from: from, to: to,
        note: clean(p.note, 300),
        createdAt: safeNum(p.createdAt, 0) || Date.now()
    });
    if (!one) return s;
    if (s.links.some(function (l) { return l.id === one.id; })) return s; // 同 id 幂等
    s.links.push(one);
    return normalize(s);
}

// remove(state, id)：返回新 state；只有显式调用才会删引用。
function remove(state, id) {
    const s = normalize(state);
    const key = str(id);
    s.links = s.links.filter(function (l) { return l.id !== key; });
    return s;
}

function copyLink(l) {
    return { id: l.id, from: l.from, to: l.to, note: l.note, createdAt: l.createdAt };
}

// all(state)：全量只读副本，按 createdAt 倒序（新在前）。不做任何存在性过滤。
function all(state) {
    return normalize(state).links.slice()
        .sort(function (a, b) { return b.createdAt - a.createdAt; })
        .map(copyLink);
}

// listFor(state, target)：返回 from 或 to 命中 target 的引用。
function listFor(state, target) {
    const key = clean(target, 120);
    if (!key) return [];
    return all(state).filter(function (l) { return l.from === key || l.to === key; });
}

// markMissing(state, ids) → 带 missing 标记的「只读视图」，绝不改原数据、绝不删引用。
// ids 可为数组 / Set / 对象（键即目标标识），表示这些目标已被删除或已不存在。
// 返回数组与每项都 Object.freeze：视图是只读的。
//   missing     : to 不在了 → 界面把这条画成灰色残留
//   fromMissing : from 也不在了（顺带标出，不额外处理）
function markMissing(state, ids) {
    const missingSet = {};
    if (ids instanceof Set) {
        ids.forEach(function (v) { missingSet[str(v)] = true; });
    } else if (Array.isArray(ids)) {
        ids.forEach(function (v) { missingSet[str(v)] = true; });
    } else if (ids && typeof ids === 'object') {
        Object.keys(ids).forEach(function (k) { missingSet[str(k)] = true; });
    }
    const view = all(state).map(function (l) {
        return Object.freeze({
            id: l.id, from: l.from, to: l.to, note: l.note, createdAt: l.createdAt,
            missing: !!missingSet[l.to],
            fromMissing: !!missingSet[l.from]
        });
    });
    return Object.freeze(view);
}

// mergeSection：跨机恢复，按 id 只补不改、幂等。返回 { state, added }。
function mergeSection(state, section) {
    const s = normalize(state);
    const incoming = normalize(section);
    const seen = {};
    s.links.forEach(function (l) { seen[l.id] = true; });
    let added = 0;
    incoming.links.forEach(function (l) {
        if (seen[l.id]) return;
        s.links.push(l);
        seen[l.id] = true;
        added += 1;
    });
    return { state: normalize(s), added: added };
}

module.exports = {
    MAX_LINKS: MAX_LINKS,
    empty: empty,
    normalize: normalize,
    add: add,
    remove: remove,
    listFor: listFor,
    all: all,
    markMissing: markMissing,
    mergeSection: mergeSection
};
