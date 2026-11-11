// 九格手记 · 学习模块（书 / 影 / 画 / 课程 的进展记录 + 主题学习）
// 纯函数模块：不直接读写 wx storage，持久化统一交给 utils/diary-store.js。
//
// 数据分两层，理由是一本书会读很多天，若按天复制条目就无法表达「同一本书的进展」：
//   ① 学习库 library：跨天持久的「条目 + 主题」，由 diary-store 存于单键 md_study_library
//      （单键，不按天堆积，不污染 morning_diary_ 日记命名空间）；
//   ② 当天日记的 studyLog：今天推进了哪条、推进到哪、一句心得，随日记一起
//      导出 / 备份 / 跨年回看，与 workBoard / moneyBook 同一套模式。
// 历史记录缺 studyLog 字段视为空，学习库缺失视为空库，零迁移。

const KINDS = [
    { id: 'book', label: '书', glyph: '书', unit: '页', step: 10, defTotal: 300 },
    { id: 'movie', label: '影', glyph: '影', unit: '集', step: 1, defTotal: 12 },
    { id: 'art', label: '画', glyph: '画', unit: '幅', step: 1, defTotal: 10 },
    { id: 'course', label: '课', glyph: '课', unit: '讲', step: 1, defTotal: 24 },
];
const KIND_MAP = {};
KINDS.forEach(function (k) { KIND_MAP[k.id] = k; });

const MAX_ITEMS = 60;
const MAX_TOPICS = 20;
const MAX_LOGS = 30;
const TITLE_MAX = 40;
const NOTE_MAX = 60;
const TOPIC_MAX = 24;
const TOTAL_MAX = 9999;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let seq = 0;

function uid(prefix) {
    seq += 1;
    return prefix + '_' + Date.now().toString(36) + '_' + seq;
}

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\r/g, '')
        .replace(/[\n\t]/g, ' ')
        .trim()
        .slice(0, max);
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function pad(n) {
    return n < 10 ? '0' + n : String(n);
}

function kindOf(id) {
    return KIND_MAP[String(id || '')] || KINDS[0];
}

function kindsOf() {
    return KINDS.map(function (k) {
        return {
            id: k.id, label: k.label, glyph: k.glyph, unit: k.unit,
            step: k.step, cls: 'study-kind-' + k.id,
        };
    });
}

function empty() {
    return { entries: [], note: '' };
}

function emptyLibrary() {
    return { items: [], topics: [] };
}

// 任何外部数据（旧备份、脏 storage、手工编辑）进来都先过这一层
function normalizeLibrary(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const seenTopic = {};
    const topics = (Array.isArray(src.topics) ? src.topics : [])
        .slice(0, MAX_TOPICS)
        .map(function (t) {
            const title = cleanText(t && t.title, TOPIC_MAX);
            if (!title) return null;
            let id = String((t && t.id) || '');
            if (!id || seenTopic[id]) id = uid('t');
            seenTopic[id] = true;
            return {
                id: id,
                title: title,
                note: cleanText(t && t.note, NOTE_MAX),
                createdAt: Number((t && t.createdAt) || 0),
            };
        })
        .filter(function (t) { return !!t; });

    const topicIds = {};
    topics.forEach(function (t) { topicIds[t.id] = true; });
    const seenItem = {};
    const items = (Array.isArray(src.items) ? src.items : [])
        .slice(0, MAX_ITEMS)
        .map(function (it) {
            const title = cleanText(it && it.title, TITLE_MAX);
            if (!title) return null;
            const kind = kindOf(it && it.kind).id;
            const def = KIND_MAP[kind];
            const total = clampInt((it && it.total), 1, TOTAL_MAX, def.defTotal);
            const done = clampInt((it && it.done), 0, total, 0);
            let id = String((it && it.id) || '');
            if (!id || seenItem[id]) id = uid('i');
            seenItem[id] = true;
            const topicId = topicIds[String((it && it.topicId) || '')]
                ? String(it.topicId) : '';
            return {
                id: id,
                kind: kind,
                title: title,
                total: total,
                done: done,
                unit: cleanText(it && it.unit, 4) || def.unit,
                topicId: topicId,
                note: cleanText(it && it.note, NOTE_MAX),
                finished: !!(it && it.finished),
                createdAt: Number((it && it.createdAt) || 0),
                updatedAt: Number((it && it.updatedAt) || 0),
            };
        })
        .filter(function (it) { return !!it; });
    return { items: items, topics: topics };
}

function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const seen = {};
    const entries = (Array.isArray(src.entries) ? src.entries : [])
        .slice(0, MAX_LOGS)
        .map(function (e) {
            if (!e || !cleanText(e.title, TITLE_MAX)) return null;
            let id = String(e.id || '');
            if (!id || seen[id]) id = uid('l');
            seen[id] = true;
            const kind = kindOf(e.kind).id;
            return {
                id: id,
                itemId: cleanText(e.itemId, 40),
                title: cleanText(e.title, TITLE_MAX),
                kind: kind,
                unit: cleanText(e.unit, 4) || KIND_MAP[kind].unit,
                done: clampInt(e.done, 0, TOTAL_MAX, 0),
                total: clampInt(e.total, 1, TOTAL_MAX, KIND_MAP[kind].defTotal),
                delta: clampInt(e.delta, -TOTAL_MAX, TOTAL_MAX, 0),
                topicId: cleanText(e.topicId, 40),
                action: e.action === 'new' || e.action === 'done' || e.action === 'note'
                    ? e.action : 'progress',
                note: cleanText(e.note, NOTE_MAX),
                createdAt: Number(e.createdAt || 0),
            };
        })
        .filter(function (e) { return !!e; });
    return { entries: entries, note: cleanText(src.note, 120) };
}

function hasContent(log) {
    const d = normalize(log);
    return d.entries.length > 0 || !!d.note;
}

// ---------- 学习库：条目 ----------
function addItem(library, input) {
    const lib = normalizeLibrary(library);
    const src = input || {};
    const title = cleanText(src.title, TITLE_MAX);
    if (!title || lib.items.length >= MAX_ITEMS) return { library: lib, item: null };
    const def = kindOf(src.kind);
    const total = clampInt(src.total, 1, TOTAL_MAX, def.defTotal);
    const topicIds = {};
    lib.topics.forEach(function (t) { topicIds[t.id] = true; });
    const topicId = topicIds[String(src.topicId || '')] ? String(src.topicId) : '';
    const item = {
        id: uid('i'),
        kind: def.id,
        title: title,
        total: total,
        done: 0,
        unit: def.unit,
        topicId: topicId,
        note: '',
        finished: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    lib.items.push(item);
    return { library: lib, item: item };
}

function removeItem(library, id) {
    const lib = normalizeLibrary(library);
    const key = String(id || '');
    lib.items = lib.items.filter(function (it) { return it.id !== key; });
    return lib;
}

// 返回 { library, item, before, after, delta }，便于页面决定要不要记一条流水
function setProgress(library, id, done) {
    const lib = normalizeLibrary(library);
    const key = String(id || '');
    let item = null;
    let before = 0;
    let after = 0;
    lib.items.forEach(function (it) {
        if (it.id !== key) return;
        before = it.done;
        after = clampInt(done, 0, it.total, before);
        it.done = after;
        it.updatedAt = Date.now();
        item = it;
    });
    return { library: lib, item: item, before: before, after: after, delta: after - before };
}

function advance(library, id, step) {
    const lib = normalizeLibrary(library);
    const found = lib.items.filter(function (it) { return it.id === String(id || ''); })[0];
    if (!found) return { library: lib, item: null, before: 0, after: 0, delta: 0 };
    const n = clampInt(step, 1, 100, kindOf(found.kind).step);
    return setProgress(lib, id, found.done + n);
}

function rewind(library, id, step) {
    const lib = normalizeLibrary(library);
    const found = lib.items.filter(function (it) { return it.id === String(id || ''); })[0];
    if (!found) return { library: lib, item: null, before: 0, after: 0, delta: 0 };
    const n = clampInt(step, 1, 100, kindOf(found.kind).step);
    return setProgress(lib, id, found.done - n);
}

function toggleFinished(library, id) {
    const lib = normalizeLibrary(library);
    let item = null;
    lib.items.forEach(function (it) {
        if (it.id !== String(id || '')) return;
        it.finished = !it.finished;
        it.updatedAt = Date.now();
        item = it;
    });
    return { library: lib, item: item };
}

function setItemNote(library, id, note) {
    const lib = normalizeLibrary(library);
    lib.items.forEach(function (it) {
        if (it.id !== String(id || '')) return;
        it.note = cleanText(note, NOTE_MAX);
        it.updatedAt = Date.now();
    });
    return lib;
}

function assignTopic(library, id, topicId) {
    const lib = normalizeLibrary(library);
    const valid = {};
    lib.topics.forEach(function (t) { valid[t.id] = true; });
    const key = valid[String(topicId || '')] ? String(topicId) : '';
    lib.items.forEach(function (it) {
        if (it.id !== String(id || '')) return;
        it.topicId = key;
        it.updatedAt = Date.now();
    });
    return lib;
}

// ---------- 学习库：主题 ----------
function addTopic(library, input) {
    const lib = normalizeLibrary(library);
    const src = typeof input === 'string' ? { title: input } : (input || {});
    const title = cleanText(src.title, TOPIC_MAX);
    if (!title || lib.topics.length >= MAX_TOPICS) return { library: lib, topic: null };
    const topic = {
        id: uid('t'),
        title: title,
        note: cleanText(src.note, NOTE_MAX),
        createdAt: Date.now(),
    };
    lib.topics.push(topic);
    return { library: lib, topic: topic };
}

function removeTopic(library, id) {
    const lib = normalizeLibrary(library);
    const key = String(id || '');
    lib.topics = lib.topics.filter(function (t) { return t.id !== key; });
    // 主题删掉后条目不删，只解开归属，避免连带丢失学习进展
    lib.items.forEach(function (it) {
        if (it.topicId === key) it.topicId = '';
    });
    return lib;
}

function topicOf(library, id) {
    const lib = normalizeLibrary(library);
    const found = lib.topics.filter(function (t) { return t.id === String(id || ''); })[0];
    return found || null;
}

function topicTitle(library, id) {
    const t = topicOf(library, id);
    return t ? t.title : '';
}

// ---------- 当天流水 ----------
function addLog(log, input) {
    const d = normalize(log);
    const src = input || {};
    const title = cleanText(src.title, TITLE_MAX);
    if (!title || d.entries.length >= MAX_LOGS) return d;
    const kind = kindOf(src.kind).id;
    d.entries.push({
        id: uid('l'),
        itemId: cleanText(src.itemId, 40),
        title: title,
        kind: kind,
        unit: cleanText(src.unit, 4) || KIND_MAP[kind].unit,
        done: clampInt(src.done, 0, TOTAL_MAX, 0),
        total: clampInt(src.total, 1, TOTAL_MAX, KIND_MAP[kind].defTotal),
        delta: clampInt(src.delta, -TOTAL_MAX, TOTAL_MAX, 0),
        topicId: cleanText(src.topicId, 40),
        action: src.action === 'new' || src.action === 'done' || src.action === 'note'
            ? src.action : 'progress',
        note: cleanText(src.note, NOTE_MAX),
        createdAt: Date.now(),
    });
    return d;
}

function removeLog(log, id) {
    const d = normalize(log);
    const key = String(id || '');
    d.entries = d.entries.filter(function (e) { return e.id !== key; });
    return d;
}

function setDayNote(log, note) {
    const d = normalize(log);
    d.note = cleanText(note, 120);
    return d;
}

function actionLabel(action) {
    if (action === 'new') return '加入';
    if (action === 'done') return '完成';
    if (action === 'note') return '记了一句';
    return '推进';
}

// ---------- 视图 ----------
function pctOf(done, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round(done * 100 / total)));
}

function view(library, filter) {
    const lib = normalizeLibrary(library);
    const f = filter || {};
    const kindFilter = String(f.kind || '');
    const topicFilter = String(f.topicId || '');
    const topicMap = {};
    lib.topics.forEach(function (t) { topicMap[t.id] = t.title; });
    const topicOptions = [{ id: '', title: '不归属主题' }].concat(lib.topics.map(function (t) {
        return { id: t.id, title: t.title };
    }));
    const topicIndexMap = {};
    topicOptions.forEach(function (o, i) { topicIndexMap[o.id] = i; });

    const all = lib.items.slice().sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const items = all.filter(function (it) {
        if (kindFilter && it.kind !== kindFilter) return false;
        if (topicFilter && it.topicId !== topicFilter) return false;
        return true;
    }).map(function (it) {
        const k = kindOf(it.kind);
        return {
            id: it.id,
            kind: it.kind,
            kindLabel: k.label,
            kindGlyph: k.glyph,
            kindCls: 'study-kind-' + it.kind,
            title: it.title,
            total: it.total,
            done: it.done,
            unit: it.unit,
            step: k.step,
            pct: it.finished ? 100 : pctOf(it.done, it.total),
            progressText: it.done + ' / ' + it.total + ' ' + it.unit,
            topicId: it.topicId,
            topicIndex: topicIndexMap[it.topicId] || 0,
            topicTitle: it.topicId ? (topicMap[it.topicId] || '') : '',
            note: it.note,
            finished: it.finished,
            statusLabel: it.finished ? '已完成' : (it.done ? '进行中' : '未开始'),
            cls: it.finished ? 'study-item-finished' : '',
        };
    });

    const kindCounts = {};
    KINDS.forEach(function (k) { kindCounts[k.id] = 0; });
    all.forEach(function (it) { kindCounts[it.kind] += 1; });

    let finished = 0;
    let sumPct = 0;
    all.forEach(function (it) {
        if (it.finished) finished += 1;
        sumPct += it.finished ? 100 : pctOf(it.done, it.total);
    });

    const topics = lib.topics.map(function (t) {
        const list = all.filter(function (it) { return it.topicId === t.id; });
        let done = 0;
        let sum = 0;
        list.forEach(function (it) {
            if (it.finished) done += 1;
            sum += it.finished ? 100 : pctOf(it.done, it.total);
        });
        return {
            id: t.id,
            title: t.title,
            note: t.note,
            count: list.length,
            finished: done,
            pct: list.length ? Math.round(sum / list.length) : 0,
            progressText: done + ' / ' + list.length + ' 项完成',
            items: list.slice(0, 6).map(function (it) {
                return {
                    id: it.id,
                    title: it.title,
                    kindLabel: kindOf(it.kind).label,
                    pct: it.finished ? 100 : pctOf(it.done, it.total),
                    finished: it.finished,
                };
            }),
        };
    }).sort(function (a, b) { return b.pct - a.pct; });

    return {
        items: items,
        allCount: all.length,
        filteredCount: items.length,
        kindCounts: kindCounts,
        kinds: kindsOf(),
        topics: topics,
        topicOptions: topicOptions,
        overall: {
            total: all.length,
            finished: finished,
            doing: all.length - finished,
            avgPct: all.length ? Math.round(sumPct / all.length) : 0,
        },
    };
}

function viewDay(log, library) {
    const d = normalize(log);
    const lib = normalizeLibrary(library);
    const entries = d.entries.slice().sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
    }).map(function (e) {
        return {
            id: e.id,
            title: e.title,
            kindLabel: kindOf(e.kind).label,
            kindGlyph: kindOf(e.kind).glyph,
            kindCls: 'study-kind-' + e.kind,
            actionLabel: actionLabel(e.action),
            progressText: e.done + ' / ' + e.total + ' ' + e.unit,
            deltaText: e.delta > 0 ? '+' + e.delta : (e.delta < 0 ? String(e.delta) : ''),
            topicTitle: e.topicId ? (topicTitle(lib, e.topicId) || '') : '',
            note: e.note,
        };
    });
    let steps = 0;
    d.entries.forEach(function (e) { if (e.delta > 0) steps += e.delta; });
    return { entries: entries, count: entries.length, steps: steps, note: d.note };
}

// ---------- 回看页 / 汇总浮层 ----------
function dayNumber(dateStr) {
    const p = String(dateStr).split('-');
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
}

function dateOfDay(n) {
    const d = new Date(n * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function todayOf(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function shortLabel(date) {
    const p = String(date).split('-');
    return Number(p[1]) + '.' + Number(p[2]);
}

function periodRange(period, todayStr) {
    if (period === 'year') {
        return { start: todayStr.slice(0, 4) + '-01-01', end: todayStr, label: '本年', unit: '年' };
    }
    if (period === 'month') {
        return { start: todayStr.slice(0, 7) + '-01', end: todayStr, label: '本月', unit: '月' };
    }
    const wd = new Date(dayNumber(todayStr) * 86400000).getUTCDay();
    const start = dateOfDay(dayNumber(todayStr) - (wd === 0 ? 6 : wd - 1));
    return { start: start, end: todayStr, label: '本周', unit: '周' };
}

// 全量汇总：格子内「学习汇总 ›」浮层用（不分周期，看整座学习库）
function libraryText(library) {
    const v = view(library);
    const lines = ['学习 · 进展汇总', '共 ' + v.overall.total + ' 项 · 已完成 ' + v.overall.finished
        + ' 项 · 整体推进 ' + v.overall.avgPct + '%', ''];
    if (v.topics.length) {
        lines.push('【主题】');
        v.topics.forEach(function (t) {
            lines.push('  ' + t.title + '  ' + t.progressText + ' · 推进 ' + t.pct + '%');
        });
        lines.push('');
    }
    KINDS.forEach(function (k) {
        const list = v.items.filter(function (it) { return it.kind === k.id; });
        if (!list.length) return;
        lines.push('【' + k.label + '】');
        list.forEach(function (it) {
            lines.push('  ' + (it.finished ? '✓ ' : '○ ') + it.title + '  ' + it.progressText
                + (it.topicTitle ? '  #' + it.topicTitle : '')
                + (it.note ? '  「' + it.note + '」' : ''));
        });
        lines.push('');
    });
    if (!v.items.length) lines.push('还没有学习条目。点九宫格「学习成长」格，加一本正在读的书就好。', '');
    lines.push('—— 九格手记 · 数据只存在本机');
    return {
        empty: v.items.length === 0,
        view: v,
        text: lines.join('\n'),
        note: '按学习库当前状态汇总，纯离线统计，不作学习评价。',
    };
}

// 周期汇总：回看页「学习进展」卡片用（本期推进流水 + 学习库现状）
// 纯本地统计，只陈述记了什么、推进到哪，不评分、不排名、不作学习评价。
function summarize(records, library, period, nowDate) {
    const kind = period === 'month' || period === 'year' ? period : 'week';
    const todayStr = String(nowDate || todayOf(new Date()));
    const range = periodRange(kind, todayStr);
    const lib = normalizeLibrary(library);
    const topicMap = {};
    lib.topics.forEach(function (t) { topicMap[t.id] = t.title; });

    const rows = [];
    (Array.isArray(records) ? records : []).forEach(function (r) {
        if (!r || !DATE_RE.test(String(r.date || ''))) return;
        if (r.date < range.start || r.date > range.end) return;
        normalize(r.studyLog).entries.forEach(function (e) {
            rows.push({ date: r.date, entry: e });
        });
    });
    rows.sort(function (a, b) {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return (b.entry.createdAt || 0) - (a.entry.createdAt || 0);
    });

    const daySet = {};
    const itemSet = {};
    const byKind = {};
    const topicHits = {};
    KINDS.forEach(function (k) { byKind[k.id] = { id: k.id, label: k.label, count: 0, steps: 0 }; });
    let steps = 0;
    let finishedHits = 0;
    rows.forEach(function (row) {
        const e = row.entry;
        daySet[row.date] = true;
        if (e.itemId) itemSet[e.itemId] = true;
        if (e.delta > 0) steps += e.delta;
        if (e.action === 'done') finishedHits += 1;
        if (!byKind[e.kind]) byKind[e.kind] = { id: e.kind, label: kindOf(e.kind).label, count: 0, steps: 0 };
        byKind[e.kind].count += 1;
        if (e.delta > 0) byKind[e.kind].steps += e.delta;
        if (e.topicId && topicMap[e.topicId]) {
            topicHits[e.topicId] = (topicHits[e.topicId] || 0) + 1;
        }
    });

    let maxKind = 0;
    const kindList = KINDS.map(function (k) { return byKind[k.id]; });
    kindList.forEach(function (x) { if (x.count > maxKind) maxKind = x.count; });
    kindList.forEach(function (x) { x.pct = maxKind ? Math.max(4, Math.round(x.count * 100 / maxKind)) : 0; });

    const v = view(lib);
    const topics = v.topics.map(function (t) {
        return {
            id: t.id,
            title: t.title,
            pct: t.pct,
            count: t.count,
            finished: t.finished,
            progressText: t.progressText,
            hits: topicHits[t.id] || 0,
            active: !!(topicHits[t.id]),
        };
    });

    const recent = rows.slice(0, 6).map(function (row) {
        const e = row.entry;
        return {
            id: row.date + '_' + e.id,
            dateLabel: shortLabel(row.date),
            kindLabel: kindOf(e.kind).label,
            title: e.title,
            actionLabel: actionLabel(e.action),
            progressText: e.done + ' / ' + e.total + ' ' + e.unit,
            note: e.note,
        };
    });

    let insight;
    if (!rows.length) {
        insight = '这一' + range.unit + '还没有学习进展记录，翻两页、看一集，随手记一笔就好。';
    } else {
        insight = '这一' + range.unit + '记下 ' + rows.length + ' 条进展、涉及 '
            + Object.keys(itemSet).length + ' 项内容，分布在 ' + Object.keys(daySet).length + ' 天。';
        let topKind = null;
        kindList.forEach(function (x) { if (!topKind || x.count > topKind.count) topKind = x; });
        if (topKind && topKind.count) insight += '记得最多的是「' + topKind.label + '」。';
        if (finishedHits) insight += '完成了 ' + finishedHits + ' 项。';
    }

    const lines = [
        '学习 · 进展（' + range.label + ' ' + shortLabel(range.start) + ' — ' + shortLabel(range.end) + '）',
        '本期 ' + rows.length + ' 条进展 · 有学习 ' + Object.keys(daySet).length + ' 天 · 推进 ' + steps + ' 个单位',
        '学习库：共 ' + v.overall.total + ' 项 · 已完成 ' + v.overall.finished + ' 项 · 整体推进 ' + v.overall.avgPct + '%',
        insight,
        '',
    ];
    lines.push('【四类分布】');
    kindList.forEach(function (x) {
        lines.push('  ' + x.label + '  ' + x.count + ' 条' + (x.steps ? ' · 推进 ' + x.steps : ''));
    });
    lines.push('');
    if (topics.length) {
        lines.push('【主题进度】');
        topics.forEach(function (t) {
            lines.push('  ' + t.title + '  ' + t.progressText + ' · 推进 ' + t.pct + '%'
                + (t.hits ? '（本期 ' + t.hits + ' 条）' : ''));
        });
        lines.push('');
    }
    if (recent.length) {
        lines.push('【最近记录】');
        recent.forEach(function (r) {
            lines.push('  ' + r.dateLabel + '  ' + r.kindLabel + ' · ' + r.title + '  '
                + r.actionLabel + '  ' + r.progressText + (r.note ? '  「' + r.note + '」' : ''));
        });
        lines.push('');
    }
    lines.push('—— 九格手记 · 数据只存在本机');

    return {
        empty: rows.length === 0,
        period: kind,
        periodLabel: range.label,
        rangeLabel: shortLabel(range.start) + ' — ' + shortLabel(range.end),
        count: rows.length,
        days: Object.keys(daySet).length,
        items: Object.keys(itemSet).length,
        steps: steps,
        finishedHits: finishedHits,
        byKind: kindList,
        topics: topics,
        recent: recent,
        overall: v.overall,
        insight: insight,
        text: lines.join('\n'),
        note: '按所选周期汇总本机记下的学习进展，纯离线统计，不评分、不作学习评价。',
    };
}

module.exports = {
    KINDS: KINDS,
    MAX_ITEMS: MAX_ITEMS,
    MAX_TOPICS: MAX_TOPICS,
    MAX_LOGS: MAX_LOGS,
    TITLE_MAX: TITLE_MAX,
    NOTE_MAX: NOTE_MAX,
    TOPIC_MAX: TOPIC_MAX,
    kindsOf: kindsOf,
    kindOf: kindOf,
    empty: empty,
    emptyLibrary: emptyLibrary,
    normalize: normalize,
    normalizeLibrary: normalizeLibrary,
    hasContent: hasContent,
    addItem: addItem,
    removeItem: removeItem,
    setProgress: setProgress,
    advance: advance,
    rewind: rewind,
    toggleFinished: toggleFinished,
    setItemNote: setItemNote,
    assignTopic: assignTopic,
    addTopic: addTopic,
    removeTopic: removeTopic,
    topicOf: topicOf,
    topicTitle: topicTitle,
    addLog: addLog,
    removeLog: removeLog,
    setDayNote: setDayNote,
    actionLabel: actionLabel,
    view: view,
    viewDay: viewDay,
    libraryText: libraryText,
    summarize: summarize,
};
