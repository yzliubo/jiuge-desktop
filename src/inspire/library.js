'use strict';
// 语料库：名言警句 / 问候语 / 运动提示语，三类都是「使用者可以自己增删改」的内容库。
//
// ---- 为什么内置内容不整份复制进数据文件 ----
// 名言 539 条、问候与运动提示各 30 余条，原本都在 src/utils 里。那 8 个 utils 被
// verify 用 SHA256 与源小程序逐字节对拍，一个字都不能改，也不可能在里面加写接口。
// 若首次启动把它们整份拷进 store.json，数据文件会凭空胖出近 100 KB，而且以后
// 想调整内置文案就再也进不来（用户库里那份才是真的）。
//
// 所以这里用「引用 + 覆盖」三条记录来表达使用者的改动：
//   改内置 → overrides 里存一条（id 不变）
//   删内置 → hidden 里记一个 id（可还原，不是销毁）
//   加自己的 → custom 里存一条
// 列表、抽取、统计、恢复默认全部由这三样推导。内置文案仍然只有代码里一份。
//
// 内置 id 依赖 utils 的数组顺序：q-<index>（quotes.all）。utils 冻结，id 稳定。
// 问候与运动提示的 id 是 g-<period>-<n> / m-<period>-<n> / m-w<weekday>-<n>，
// 词池在本文件里有一份副本——因为 greetings.js 只导出 compose/periodOf，
// 没有导出词池，而它又不能改。副本是「可编辑的那一份」，utils 的 compose
// 只在整类被删空时兜底，保证界面上永远不出现空白。

const quotes = require('../utils/quotes.js');
const greetings = require('../utils/greetings.js');

const MAX_TEXT = 400;
const MAX_GREET = 160;
const MAX_AUTHOR = 60;
const MAX_CUSTOM_PER_KIND = 500;
const MAX_HIDDEN = 2000;

const ANY_PERIOD = 'any';

const KINDS = [
    { key: 'quotes', label: '名言警句', unit: '条', hint: '每天一条；有「我的」条目时约每 7 天轮到一天', hasAuthor: true, max: MAX_TEXT },
    { key: 'greetings', label: '问候语', unit: '句', hint: '按时段轮换，写在这一天的开头', hasAuthor: false, max: MAX_GREET },
    { key: 'moves', label: '运动提示', unit: '句', hint: '问候下面那行「动一动」，按时段与星期轮换', hasAuthor: false, max: MAX_GREET }
];
const KIND_LABEL = {};
const KIND_MAX = {};
KINDS.forEach(function (k) { KIND_LABEL[k.key] = k.label; KIND_MAX[k.key] = k.max; });

const PERIODS = greetings.periods.map(function (p) { return { key: p.key, label: p.label }; });
PERIODS.push({ key: ANY_PERIOD, label: '任何时段' });
const PERIOD_LABEL = {};
PERIODS.forEach(function (p) { PERIOD_LABEL[p.key] = p.label; });

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ---- 内置词池（来自原 greetings.js，原模块未导出，故在此保留可编辑副本）----
const BUILTIN_GREETINGS = {
    dawn: [
        '早安，先把这一页留给自己。',
        '早，今天也从容一点开始。',
        '早安，窗外的光正好，先写三行。',
        '早，先不急着看消息，先看看自己。',
        '早安，三分钟就够，写一个字也算数。'
    ],
    morning: [
        '上午好，别一上来就把自己排满。',
        '上午好，先做最要紧的那一件。',
        '上午好，忙里也给自己留口气。',
        '上午好，慢一点，写得少也算数。'
    ],
    noon: [
        '午安，先放下手头，好好吃顿饭。',
        '午安，歇一会儿再写也不迟。',
        '午安，一天过半，别硬撑。',
        '午安，给上午收个尾，下午再接着来。'
    ],
    afternoon: [
        '下午好，抬头看看远处。',
        '下午好，喝口水，再接着来。',
        '下午好，累了就先松一松肩。',
        '下午好，写两句也是把今天接住了。'
    ],
    evening: [
        '傍晚好，把今天的节奏收一收。',
        '傍晚好，散步回来再写两句。',
        '傍晚好，今天已经很够了。',
        '傍晚好，留一点时间给不赶路的事。'
    ],
    night: [
        '晚上好，写两句就收笔吧。',
        '晚上好，灯下写一行，也就够了。',
        '晚上好，别熬着补，明天也能写。',
        '晚上好，把今天好好合上。'
    ],
    latenight: [
        '夜深了，睡觉比写字更要紧。',
        '这么晚了，明天补记也来得及。',
        '夜深了，先休息，日记会等你。',
        '夜深了，明早再和自己碰面。'
    ]
};

const BUILTIN_MOVES = {
    dawn: [
        '先喝一杯温水，再动笔。',
        '起床后伸展两分钟，让肩颈先醒过来。',
        '开窗透口气，做三次深呼吸。',
        '别急着刷手机，先活动一下手腕脚踝。',
        '早饭前走几步，让身体慢慢开机。',
        '今天试着用走路代替一段车程。'
    ],
    morning: [
        '每坐一小时，起来走动两分钟。',
        '远眺 20 秒，让眼睛歇一歇。',
        '把水杯放近一点，记得补口水。',
        '肩颈绕两圈，别一直低着头。',
        '去接水时多走几步，顺手松松腰。'
    ],
    noon: [
        '饭后慢走十分钟，比立刻坐下舒服。',
        '午饭别太急，嚼慢一点。',
        '想眯一会儿，15 分钟就够。',
        '饭后靠墙站两分钟，松一松腰背。',
        '饭后别马上盯屏幕，站着聊两句也好。'
    ],
    afternoon: [
        '下午容易犯困，站起来伸个懒腰。',
        '去窗边晒两分钟太阳。',
        '手腕转一转，鼠标先放一放。',
        '再喝一杯水，别等口渴才想起来。',
        '上下楼走一趟，把久坐打断。'
    ],
    evening: [
        '饭后出去快走二十分钟。',
        '放下屏幕，让眼睛先下班。',
        '拉伸一下小腿和肩背，今天辛苦了。',
        '散步时别戴耳机，听听周围的声音。',
        '晚饭后站一会儿，比窝着更舒服。'
    ],
    night: [
        '热水泡个脚，比再刷一会儿更解乏。',
        '睡前把手机放远一点。',
        '做两分钟缓慢拉伸，呼吸放长。',
        '今天走够了吗？睡前别再给自己加任务。',
        '熄灯前把肩颈松一松，睡得踏实些。'
    ],
    latenight: [
        '现在最该做的运动，是躺下。',
        '先睡吧，明早再伸展也不晚。',
        '关灯，把恢复交给身体自己。',
        '别再数今天走了几步，先闭眼。'
    ]
};

// 星期维度：只在当天出现，period 记 any
const BUILTIN_DAY_MOVES = [
    ['周末出门走一圈，晒晒太阳。', '给下周留一件想做的小事。'],
    ['新的一周，先把肩膀松下来。'],
    ['今天试试走楼梯，不赶电梯。'],
    ['一周过半，中午出去透透气。'],
    ['把散步安排进今天，别都留到周末。'],
    ['周末在望，今晚别把运动排太满。'],
    ['有空就走远一点，换条路线。']
];

// 固定公历节日：与 greetings.js 同口径（农历节日不做近似推算）
const SPECIAL_DAYS = {
    '01-01': '新的一年，第一页从今天写起。',
    '05-01': '假期里也给自己留三分钟。',
    '06-01': '像小孩一样，先写最开心的一件。',
    '10-01': '假期慢一点，日记也慢一点。'
};
const ANNIVERSARY_LINE = '今天是你标记的日子，值得多写两行。';

// ---- 内置目录只建一次 ----
function buildBuiltins() {
    const out = { quotes: [], greetings: [], moves: [] };
    quotes.all.forEach(function (q, i) {
        out.quotes.push({
            id: 'q-' + i,
            text: String(q.text || ''),
            author: String(q.author || ''),
            period: ANY_PERIOD,
            day: -1
        });
    });
    Object.keys(BUILTIN_GREETINGS).forEach(function (period) {
        BUILTIN_GREETINGS[period].forEach(function (text, i) {
            out.greetings.push({ id: 'g-' + period + '-' + (i + 1), text: text, author: '', period: period, day: -1 });
        });
    });
    Object.keys(BUILTIN_MOVES).forEach(function (period) {
        BUILTIN_MOVES[period].forEach(function (text, i) {
            out.moves.push({ id: 'm-' + period + '-' + (i + 1), text: text, author: '', period: period, day: -1 });
        });
    });
    BUILTIN_DAY_MOVES.forEach(function (list, day) {
        list.forEach(function (text, i) {
            out.moves.push({ id: 'm-w' + day + '-' + (i + 1), text: text, author: '', period: ANY_PERIOD, day: day });
        });
    });
    return out;
}
const BUILTIN = buildBuiltins();
const BUILTIN_ID = {
    quotes: {}, greetings: {}, moves: {}
};
KINDS.forEach(function (k) {
    BUILTIN[k.key].forEach(function (it) { BUILTIN_ID[k.key][it.id] = true; });
});

// ---- 小工具 ----
function str(v) { return typeof v === 'string' ? v : (v === 0 || v ? String(v) : ''); }
function cleanText(v, max) {
    const s = str(v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max) : s;
}
function num(v, min, max, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, Math.round(n)));
}
function pad(n) { return n < 10 ? '0' + n : String(n); }
function dateKeyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function newId(kind) { return 'c-' + kind.slice(0, 1) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
function hashOf(s) {
    let h = 2166136261;
    const t = String(s || '');
    for (let i = 0; i < t.length; i += 1) {
        h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
    }
    return h >>> 0;
}
function kindOf(kind) {
    const k = str(kind);
    return KIND_LABEL[k] ? k : '';
}
function normPeriod(raw) {
    const p = str(raw);
    return PERIOD_LABEL[p] ? p : ANY_PERIOD;
}
function normDay(raw) {
    const n = Number(raw);
    return (isFinite(n) && n >= 0 && n <= 6) ? Math.round(n) : -1;
}

// ---- 状态 ----
function empty() {
    return {
        version: 1,
        custom: { quotes: [], greetings: [], moves: [] },
        overrides: { quotes: {}, greetings: {}, moves: {} },
        hidden: { quotes: [], greetings: [], moves: [] }
    };
}

function normalizeCustom(kind, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = cleanText(raw.text, KIND_MAX[kind]);
    if (!text) return null;
    const created = Number(raw.createdAt) || Date.now();
    return {
        id: cleanText(raw.id, 60) || newId(kind),
        text: text,
        author: kind === 'quotes' ? cleanText(raw.author, MAX_AUTHOR) : '',
        period: kind === 'quotes' ? ANY_PERIOD : normPeriod(raw.period),
        day: kind === 'quotes' ? -1 : normDay(raw.day),
        enabled: raw.enabled === false ? false : true,
        createdAt: created,
        updatedAt: Number(raw.updatedAt) || created
    };
}

function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = empty();
    KINDS.forEach(function (k) {
        const kind = k.key;
        const seen = {};
        const customSrc = (src.custom && Array.isArray(src.custom[kind])) ? src.custom[kind] : [];
        customSrc.slice(0, MAX_CUSTOM_PER_KIND).forEach(function (it) {
            const one = normalizeCustom(kind, it);
            if (!one) return;
            if (seen[one.id]) one.id = newId(kind);
            seen[one.id] = true;
            out.custom[kind].push(one);
        });
        // 覆盖只保留指向真实内置条目的那些：旧版本 / 手改文件留下的野 id 不往库里塞
        const ovSrc = (src.overrides && src.overrides[kind] && typeof src.overrides[kind] === 'object') ? src.overrides[kind] : {};
        Object.keys(ovSrc).forEach(function (id) {
            if (!BUILTIN_ID[kind][id]) return;
            const o = ovSrc[id] && typeof ovSrc[id] === 'object' ? ovSrc[id] : {};
            const text = cleanText(o.text, KIND_MAX[kind]);
            if (!text) return;
            out.overrides[kind][id] = {
                text: text,
                author: kind === 'quotes' ? cleanText(o.author, MAX_AUTHOR) : '',
                updatedAt: Number(o.updatedAt) || Date.now()
            };
        });
        const hidSrc = (src.hidden && Array.isArray(src.hidden[kind])) ? src.hidden[kind] : [];
        const hid = [];
        hidSrc.slice(0, MAX_HIDDEN).forEach(function (id) {
            const key = str(id);
            if (BUILTIN_ID[kind][key] && hid.indexOf(key) < 0) hid.push(key);
        });
        out.hidden[kind] = hid;
    });
    return out;
}

// ---- 合并视图：内置（含覆盖与隐藏标记）+ 我的 ----
function itemsOf(state, kind) {
    const s = normalize(state);
    const hid = {};
    s.hidden[kind].forEach(function (id) { hid[id] = true; });
    const out = [];
    BUILTIN[kind].forEach(function (b) {
        const ov = s.overrides[kind][b.id] || null;
        const hidden = !!hid[b.id];
        out.push({
            id: b.id,
            text: ov ? ov.text : b.text,
            author: ov ? ov.author : b.author,
            period: b.period,
            periodLabel: PERIOD_LABEL[b.period] || '',
            day: b.day,
            dayLabel: b.day >= 0 ? WEEKDAY_LABEL[b.day] : '',
            builtin: true,
            custom: false,
            enabled: !hidden,
            hidden: hidden,
            overridden: !!ov,
            updatedAt: ov ? ov.updatedAt : 0
        });
    });
    s.custom[kind].forEach(function (c) {
        out.push({
            id: c.id,
            text: c.text,
            author: c.author,
            period: c.period,
            periodLabel: PERIOD_LABEL[c.period] || '',
            day: c.day,
            dayLabel: c.day >= 0 ? WEEKDAY_LABEL[c.day] : '',
            builtin: false,
            custom: true,
            enabled: c.enabled !== false,
            hidden: false,
            overridden: false,
            updatedAt: c.updatedAt
        });
    });
    return out;
}

function statsOf(state, kind) {
    const list = itemsOf(state, kind);
    let builtin = 0, custom = 0, enabled = 0, hidden = 0, overridden = 0;
    list.forEach(function (it) {
        if (it.builtin) builtin += 1; else custom += 1;
        if (it.enabled) enabled += 1;
        if (it.hidden) hidden += 1;
        if (it.overridden) overridden += 1;
    });
    return { builtin: builtin, custom: custom, total: list.length, enabled: enabled, hidden: hidden, overridden: overridden };
}

function stats(state) {
    const s = normalize(state);
    const out = {};
    KINDS.forEach(function (k) { out[k.key] = statsOf(s, k.key); });
    return out;
}

function list(state, kind) {
    const k = kindOf(kind);
    if (!k) return { kind: '', items: [], stats: null };
    return {
        kind: k,
        label: KIND_LABEL[k],
        items: itemsOf(state, k),
        stats: statsOf(state, k)
    };
}

function meta() {
    return {
        kinds: KINDS.map(function (k) { return { key: k.key, label: k.label, unit: k.unit, hint: k.hint, hasAuthor: k.hasAuthor, max: k.max }; }),
        periods: PERIODS,
        weekdays: WEEKDAY_LABEL.map(function (label, i) { return { value: i, label: label }; }),
        limits: { text: MAX_TEXT, greet: MAX_GREET, author: MAX_AUTHOR, custom: MAX_CUSTOM_PER_KIND }
    };
}

// ---- 抽取 ----
// 资格：启用，且（任何时段 或 当前时段），且（不限星期 或 就是今天）
function eligible(items, ctx) {
    const period = ctx && ctx.period ? ctx.period : ANY_PERIOD;
    const weekday = ctx && typeof ctx.weekday === 'number' ? ctx.weekday : new Date().getDay();
    return items.filter(function (it) {
        if (!it.enabled) return false;
        if (it.period !== ANY_PERIOD && it.period !== period) return false;
        if (it.day >= 0 && it.day !== weekday) return false;
        return true;
    });
}

function pickFrom(pool, seed, excludeId, offset) {
    if (!pool.length) return null;
    const off = num(offset, 0, 9999, 0);
    if (excludeId && pool.length > 1) {
        const rest = pool.filter(function (it) { return it.id !== excludeId; });
        return rest[(hashOf(seed) + off) % rest.length];
    }
    return pool[(hashOf(seed) + off) % pool.length];
}

// 名言：内置优先按「精选池」出（quotes.dailyIndex 的日期散列保证同一天稳定）；
// 若这一天抽中的那条被删了，就顺着往后找下一条还在的。
// 有「我的」条目时，每 7 天轮到一天给自己的话——否则自己加的话永远看不到。
function pickQuote(state, ctx) {
    const s = normalize(state);
    const dateKey = (ctx && ctx.dateKey) ? ctx.dateKey : dateKeyOf(new Date());
    const offset = ctx ? num(ctx.offset, 0, 9999, 0) : 0;
    // 「换一组」：在全部启用的条目里按偏移取一条，内置与我的一视同仁
    if (offset > 0) {
        const pool = itemsOf(s, 'quotes').filter(function (it) { return it.enabled; });
        const hit = pickFrom(pool, dateKey + '#alt', '', offset);
        if (hit) {
            return { id: hit.id, text: hit.text, author: hit.author, builtin: hit.builtin, custom: hit.custom, source: 'offset' };
        }
    }
    const custom = s.custom.quotes.filter(function (c) { return c.enabled !== false; });
    if (custom.length && hashOf(dateKey + '#lib') % 7 === 0) {
        const c = custom[hashOf(dateKey + '#custom') % custom.length];
        return { id: c.id, text: c.text, author: c.author, builtin: false, custom: true, source: 'custom' };
    }
    const builtins = itemsOf(s, 'quotes').filter(function (it) { return it.builtin && it.enabled; });
    if (!builtins.length) {
        if (custom.length) {
            const c = custom[hashOf(dateKey + '#custom') % custom.length];
            return { id: c.id, text: c.text, author: c.author, builtin: false, custom: true, source: 'custom' };
        }
        // 经典兜底：整类被删空时仍给一句，不让首页空着
        const idx = quotes.dailyIndex(dateKey);
        const q = quotes.pick(idx);
        return { id: 'q-' + idx, text: q.text, author: q.author, builtin: true, custom: false, source: 'fallback' };
    }
    const byId = {};
    builtins.forEach(function (it) { byId[it.id] = it; });
    let idx = quotes.dailyIndex(dateKey);
    for (let step = 0; step < 600; step += 1) {
        const id = 'q-' + idx;
        if (byId[id]) {
            const hit = byId[id];
            return { id: hit.id, text: hit.text, author: hit.author, builtin: true, custom: false, source: 'daily' };
        }
        idx = (idx + 1) % quotes.all.length;
    }
    const first = builtins[0];
    return { id: first.id, text: first.text, author: first.author, builtin: true, custom: false, source: 'daily' };
}

function specialLine(now, anniversary) {
    const md = pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    if (SPECIAL_DAYS[md]) return SPECIAL_DAYS[md];
    if (String(anniversary || '').trim()) return ANNIVERSARY_LINE;
    return '';
}

/**
 * 今日三条：一句问候、一条运动提示、一条名言。
 * opts: { now(ms 或 Date), dateKey, anniversary, offset }
 * 同一天同一时段结果稳定（hash 种子是 date|period），换一组传 offset。
 */
function today(state, opts) {
    const o = opts || {};
    const now = (o.now instanceof Date && !isNaN(o.now.getTime()))
        ? o.now
        : (typeof o.now === 'number' ? new Date(o.now) : new Date());
    const period = greetings.periodOf(now.getHours());
    const scope = greetings.scopeKey(now);
    const dateKey = o.dateKey || dateKeyOf(now);
    const anniversary = String(o.anniversary || '');
    const offset = num(o.offset, 0, 9999, 0);
    const base = greetings.compose({ now: now, anniversary: anniversary });

    const s = normalize(state);
    const ctx = { period: period.key, weekday: now.getDay(), dateKey: dateKey };
    const greetPool = eligible(itemsOf(s, 'greetings'), ctx);
    const movePool = eligible(itemsOf(s, 'moves'), ctx);
    const greetItem = pickFrom(greetPool, scope + '#greet', '', offset);
    const moveItem = pickFrom(movePool, scope + '#move', '', offset);
    const line = specialLine(now, anniversary);
    const quote = pickQuote(s, { dateKey: dateKey, offset: offset });

    const greetText = greetItem ? greetItem.text : base.text;
    return {
        tag: base.tag,
        greeting: {
            text: greetText + (greetItem && line ? ' ' + line : ''),
            // 没有可用的问候语时 base.text 已经带上了节日 / 纪念日那一句，不再重复拼
            hint: moveItem ? moveItem.text : base.hint,
            period: period.key,
            periodLabel: period.label,
            id: greetItem ? greetItem.id : '',
            hintId: moveItem ? moveItem.id : ''
        },
        quote: quote,
        scope: scope,
        dateKey: dateKey,
        counts: { greetings: greetPool.length, moves: movePool.length }
    };
}

// 「换一条」：只在启用且当期可用的池里换，排除当前这条
function pick(state, kind, opts) {
    const k = kindOf(kind);
    if (!k) return null;
    const o = opts || {};
    const now = (o.now instanceof Date && !isNaN(o.now.getTime())) ? o.now : new Date();
    const dateKey = o.dateKey || dateKeyOf(now);
    if (k === 'quotes') {
        const pool = itemsOf(state, k).filter(function (it) { return it.enabled; });
        if (!pool.length) return pickQuote(state, { dateKey: dateKey });
        const hit = pickFrom(pool, dateKey + '#shuffle-' + (o.round || 0), o.exclude || '', 0);
        return hit ? { id: hit.id, text: hit.text, author: hit.author, builtin: hit.builtin, custom: hit.custom, source: 'shuffle' } : null;
    }
    const period = o.period || greetings.periodOf(now.getHours()).key;
    const pool = eligible(itemsOf(state, k), { period: period, weekday: now.getDay() });
    const hit = pickFrom(pool, dateKey + '|' + period + '#shuffle-' + (o.round || 0), o.exclude || '', 0);
    return hit ? { id: hit.id, text: hit.text, author: hit.author, period: hit.period, builtin: hit.builtin, custom: hit.custom } : null;
}

// ---- 写操作：都是「状态进、状态出」，与 dream/growth 一致 ----
function add(state, kind, patch) {
    const s = normalize(state);
    const k = kindOf(kind);
    if (!k) return s;
    if (s.custom[k].length >= MAX_CUSTOM_PER_KIND) return s;
    const one = normalizeCustom(k, {
        id: newId(k),
        text: patch && patch.text,
        author: patch && patch.author,
        period: patch && patch.period,
        day: patch && patch.day,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
    });
    if (!one) return s;
    s.custom[k].push(one);
    return normalize(s);
}

function update(state, kind, id, patch) {
    const s = normalize(state);
    const k = kindOf(kind);
    const key = str(id);
    if (!k || !key) return s;
    const p = patch || {};
    const text = cleanText(p.text, KIND_MAX[k]);
    const author = k === 'quotes' ? cleanText(p.author, MAX_AUTHOR) : '';

    const mine = s.custom[k].filter(function (c) { return c.id === key; })[0];
    if (mine) {
        if (text) mine.text = text;
        if (k === 'quotes') mine.author = author;
        if (p.period !== undefined) mine.period = k === 'quotes' ? ANY_PERIOD : normPeriod(p.period);
        if (p.enabled !== undefined) mine.enabled = p.enabled !== false;
        mine.updatedAt = Date.now();
        return normalize(s);
    }
    if (!BUILTIN_ID[k][key]) return s;
    // 改内置：存覆盖。改回与原文一致就删掉覆盖，避免留一堆无意义的记录
    const origin = BUILTIN[k].filter(function (b) { return b.id === key; })[0];
    if (!origin) return s;
    const nextText = text || origin.text;
    const nextAuthor = k === 'quotes' ? (p.author !== undefined ? author : (s.overrides[k][key] ? s.overrides[k][key].author : origin.author)) : '';
    if (nextText === origin.text && nextAuthor === origin.author) {
        delete s.overrides[k][key];
    } else {
        s.overrides[k][key] = { text: nextText, author: nextAuthor, updatedAt: Date.now() };
    }
    return normalize(s);
}

function remove(state, kind, id) {
    const s = normalize(state);
    const k = kindOf(kind);
    const key = str(id);
    if (!k || !key) return s;
    const before = s.custom[k].length;
    s.custom[k] = s.custom[k].filter(function (c) { return c.id !== key; });
    if (s.custom[k].length !== before) return s;
    if (BUILTIN_ID[k][key] && s.hidden[k].indexOf(key) < 0) s.hidden[k].push(key);
    return normalize(s);
}

// 还原：内置取消隐藏；我的重新启用
function restore(state, kind, id) {
    const s = normalize(state);
    const k = kindOf(kind);
    const key = str(id);
    if (!k || !key) return s;
    s.hidden[k] = s.hidden[k].filter(function (x) { return x !== key; });
    s.custom[k].forEach(function (c) { if (c.id === key) c.enabled = true; });
    return normalize(s);
}

// 撤销对内置条目的修改（保留隐藏状态）
function revert(state, kind, id) {
    const s = normalize(state);
    const k = kindOf(kind);
    const key = str(id);
    if (!k || !key) return s;
    delete s.overrides[k][key];
    return normalize(s);
}

function toggle(state, kind, id, enabled) {
    const s = normalize(state);
    const k = kindOf(kind);
    const key = str(id);
    if (!k || !key) return s;
    const on = enabled !== false;
    const mine = s.custom[k].filter(function (c) { return c.id === key; })[0];
    if (mine) {
        mine.enabled = on;
        mine.updatedAt = Date.now();
        return normalize(s);
    }
    if (!BUILTIN_ID[k][key]) return s;
    if (on) s.hidden[k] = s.hidden[k].filter(function (x) { return x !== key; });
    else if (s.hidden[k].indexOf(key) < 0) s.hidden[k].push(key);
    return normalize(s);
}

// 恢复内置默认：清掉隐藏与覆盖，「我的」条目一条不动。
// 只清不删——这是「恢复默认」，不是「清空语料库」。
function reset(state, kind) {
    const s = normalize(state);
    const k = kindOf(kind);
    if (!k) return s;
    s.hidden[k] = [];
    s.overrides[k] = {};
    return normalize(s);
}

function mergeSection(state, section) {
    const s = normalize(state);
    const incoming = normalize(section);
    let added = 0;
    KINDS.forEach(function (k) {
        const kind = k.key;
        const seen = {};
        s.custom[kind].forEach(function (c) { seen[c.id] = true; });
        incoming.custom[kind].forEach(function (c) {
            if (seen[c.id]) return;
            s.custom[kind].push(c);
            seen[c.id] = true;
            added += 1;
        });
        // 覆盖：只补本地没有的，不覆盖本机已改过的
        Object.keys(incoming.overrides[kind]).forEach(function (id) {
            if (!s.overrides[kind][id]) s.overrides[kind][id] = incoming.overrides[kind][id];
        });
        incoming.hidden[kind].forEach(function (id) {
            if (s.hidden[kind].indexOf(id) < 0) s.hidden[kind].push(id);
        });
    });
    return { state: normalize(s), added: added };
}

module.exports = {
    KINDS: KINDS,
    KIND_LABEL: KIND_LABEL,
    PERIODS: PERIODS,
    WEEKDAY_LABEL: WEEKDAY_LABEL,
    MAX_TEXT: MAX_TEXT,
    MAX_GREET: MAX_GREET,
    empty: empty,
    normalize: normalize,
    meta: meta,
    list: list,
    stats: stats,
    today: today,
    pick: pick,
    add: add,
    update: update,
    remove: remove,
    restore: restore,
    revert: revert,
    toggle: toggle,
    reset: reset,
    mergeSection: mergeSection
};
