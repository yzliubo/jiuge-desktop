'use strict';
// 节气复盘 —— V2.1 ⑯。存 md_term_review 单键（新键，不动冻结的 8 个 utils）。
//
// 克制条款（照 07-借鉴总规划 §6-3）：只做「时间刻度 + 文意象」，
// 不做养生、不做宜忌、不做运势。三候用古典物候名当写回顾的引子，不引申任何建议。
//
// 【诚实降级】24 节气用「公历固定近似表」推算，不联网、不引依赖：
//   节气真实交节时刻由太阳黄经决定，逐年、逐日浮动，还受闰年影响。
//   本表取多年常见的代表日，误差可达 ±1 天，不承诺精确到某一天。
//   要精确交节时刻请另接天文算法——本模块不假装精确。

const TERMS = [
    '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
    '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
    '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'
];

// 每个节气近似的公历起始日 [月, 日]，与 TERMS 索引一一对应。
// 大致对应口诀「上半年来六廿一，下半年来八廿三」，取代表值以便 ±1 天成立。
const TERM_DATES = [
    [1, 5], [1, 20], [2, 4], [2, 19], [3, 6], [3, 21], [4, 5], [4, 20],
    [5, 6], [5, 21], [6, 6], [6, 21], [7, 7], [7, 23], [8, 8], [8, 23],
    [9, 8], [9, 23], [10, 8], [10, 24], [11, 8], [11, 23], [12, 7], [12, 22]
];

// 七十二候（每节气三候）。只取古典物候名作文意象，不引申为养生/宜忌/运势。
const HOU = [
    ['雁北乡', '鹊始巢', '雉始雊'],                 // 小寒
    ['鸡始乳', '征鸟厉疾', '水泽腹坚'],             // 大寒
    ['东风解冻', '蛰虫始振', '鱼陟负冰'],           // 立春
    ['獭祭鱼', '候雁北', '草木萌动'],               // 雨水
    ['桃始华', '仓庚鸣', '鹰化为鸠'],               // 惊蛰
    ['玄鸟至', '雷乃发声', '始电'],                 // 春分
    ['桐始华', '田鼠化为鴽', '虹始见'],             // 清明
    ['萍始生', '鸣鸠拂其羽', '戴胜降于桑'],         // 谷雨
    ['蝼蝈鸣', '蚯蚓出', '王瓜生'],                 // 立夏
    ['苦菜秀', '靡草死', '麦秋至'],                 // 小满
    ['螳螂生', '鵙始鸣', '反舌无声'],               // 芒种
    ['鹿角解', '蝉始鸣', '半夏生'],                 // 夏至
    ['温风至', '蟋蟀居宇', '鹰始鸷'],               // 小暑
    ['腐草为萤', '土润溽暑', '大雨时行'],           // 大暑
    ['凉风至', '白露生', '寒蝉鸣'],                 // 立秋
    ['鹰乃祭鸟', '天地始肃', '禾乃登'],             // 处暑
    ['鸿雁来', '玄鸟归', '群鸟养羞'],               // 白露
    ['雷始收声', '蛰虫坯户', '水始涸'],             // 秋分
    ['鸿雁来宾', '雀入大水为蛤', '菊有黄华'],       // 寒露
    ['豺乃祭兽', '草木黄落', '蜇虫咸俯'],           // 霜降
    ['水始冰', '地始冻', '雉入大水为蜃'],           // 立冬
    ['虹藏不见', '天气上升地气下降', '闭塞而成冬'], // 小雪
    ['鹖鴠不鸣', '虎始交', '荔挺出'],               // 大雪
    ['蚯蚓结', '麋角解', '水泉动']                  // 冬至
];

const MAX_REVIEWS = 480; // 20 年 × 24 节气；封顶防脏数据撑爆
const ANSWER_MAX = 2000;
const KEY_MAX = 40;
const CN_ORDINAL = ['初', '二', '三'];

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

// 把任意入参解析成「该日历日的 UTC 零点时间戳」：只取年月日，忽略时分秒与时区，
// 因此后续所有比较都在同一套抽象日号里进行，不受本地时区/DST 干扰。
function parseDay(input) {
    let y = 0, m = 0, d = 0;
    if (input instanceof Date) {
        y = input.getFullYear(); m = input.getMonth() + 1; d = input.getDate();
    } else if (typeof input === 'number' && isFinite(input)) {
        const t = new Date(input);
        y = t.getFullYear(); m = t.getMonth() + 1; d = t.getDate();
    } else {
        const t = str(input).slice(0, 10).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (t) { y = Number(t[1]); m = Number(t[2]); d = Number(t[3]); }
    }
    if (!(y >= 1970 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) {
        const now = new Date();
        y = now.getFullYear(); m = now.getMonth() + 1; d = now.getDate();
    }
    return { y: y, day: Date.UTC(y, m - 1, d) };
}

// 内部：把 [y-1, y, y+1] 三年的 24 个节气起点铺开排序，
// 天然处理跨年（冬至 12/22 → 次年小寒 1/5）与年初（1/1~1/4 仍属上年冬至）。
function resolve(date) {
    const p = parseDay(date);
    const points = [];
    [p.y - 1, p.y, p.y + 1].forEach(function (yr) {
        for (let i = 0; i < 24; i += 1) {
            points.push({ i: i, t: Date.UTC(yr, TERM_DATES[i][0] - 1, TERM_DATES[i][1]) });
        }
    });
    points.sort(function (a, b) { return a.t - b.t; });
    let cur = points[0];
    let nxt = points[1];
    for (let k = 0; k < points.length - 1; k += 1) {
        if (points[k].t <= p.day && points[k + 1].t > p.day) {
            cur = points[k]; nxt = points[k + 1]; break;
        }
    }
    return { p: p, cur: cur, nxt: nxt };
}

// termOf(date) → { name, index, next, daysLeft, hou }
// date 可为 Date / 'YYYY-MM-DD' / 时间戳 / 省略（默认今天）。
function termOf(date) {
    const r = resolve(date);
    const daysLeft = Math.round((r.nxt.t - r.p.day) / 86400000);
    const elapsed = Math.round((r.p.day - r.cur.t) / 86400000);
    const houIdx = Math.max(0, Math.min(2, Math.floor(elapsed / 5)));
    const h = HOU[r.cur.i];
    const hou = '三候（当前第' + CN_ORDINAL[houIdx] + '候）：' +
        '一候' + h[0] + '、二候' + h[1] + '、三候' + h[2];
    return {
        name: TERMS[r.cur.i],
        index: r.cur.i,
        next: TERMS[r.nxt.i],
        daysLeft: daysLeft,
        hou: hou
    };
}

// 某个具体节气实例的稳定键，如 '2026-霜降'。
// 年份取「该节气起始日所在年」，所以跨年的冬至（12/22~次年 1/4）只有唯一键。
function termKeyOf(date) {
    const r = resolve(date);
    return new Date(r.cur.t).getUTCFullYear() + '-' + TERMS[r.cur.i];
}

function cleanAnswers(raw) {
    if (Array.isArray(raw)) {
        const out = [];
        raw.slice(0, 20).forEach(function (a) { out.push(clean(a, ANSWER_MAX)); });
        return out;
    }
    const o = obj(raw);
    if (Object.keys(o).length) {
        const out = {};
        Object.keys(o).slice(0, 20).forEach(function (k) {
            const v = o[k];
            if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                out[String(k).slice(0, KEY_MAX)] = typeof v === 'string' ? clean(v, ANSWER_MAX) : v;
            }
        });
        return out;
    }
    return { text: clean(raw, ANSWER_MAX) };
}

function normReview(raw) {
    const o = obj(raw);
    const termKey = clean(o.termKey, KEY_MAX);
    if (!termKey) return null;
    return {
        termKey: termKey,
        answers: cleanAnswers(o.answers),
        savedAt: safeNum(o.savedAt, 0)
    };
}

function empty() { return { version: 1, reviews: [] }; }

// normalize：幂等、脏数据不抛。按 termKey 去重，保留最后 MAX_REVIEWS 条。
function normalize(state) {
    const src = obj(state);
    const seen = {};
    const list = [];
    (Array.isArray(src.reviews) ? src.reviews : []).slice(-MAX_REVIEWS).forEach(function (r) {
        const one = normReview(r);
        if (!one || seen[one.termKey]) return;
        seen[one.termKey] = true;
        list.push(one);
    });
    return { version: 1, reviews: list };
}

// saveReview：写/改某个节气的回顾，返回新 state（不改入参）。
function saveReview(state, termKey, answers) {
    const s = normalize(state);
    const key = clean(termKey, KEY_MAX);
    if (!key) return s;
    const one = { termKey: key, answers: cleanAnswers(answers), savedAt: Date.now() };
    let found = false;
    s.reviews = s.reviews.map(function (r) {
        if (r.termKey === key) { found = true; return one; }
        return r;
    });
    if (!found) s.reviews.push(one);
    return normalize(s);
}

// listReviews：按 termKey 倒序返回只读副本数组。
function listReviews(state) {
    return normalize(state).reviews.slice().sort(function (a, b) {
        return a.termKey < b.termKey ? 1 : (a.termKey > b.termKey ? -1 : 0);
    }).map(function (r) {
        return { termKey: r.termKey, answers: r.answers, savedAt: r.savedAt };
    });
}

// mergeSection：跨机恢复，按 termKey 只补不改、幂等。返回 { state, added }。
function mergeSection(state, section) {
    const s = normalize(state);
    const incoming = normalize(section);
    const seen = {};
    s.reviews.forEach(function (r) { seen[r.termKey] = true; });
    let added = 0;
    incoming.reviews.forEach(function (r) {
        if (seen[r.termKey]) return;
        s.reviews.push(r);
        seen[r.termKey] = true;
        added += 1;
    });
    return { state: normalize(s), added: added };
}

module.exports = {
    TERMS: TERMS,
    MAX_REVIEWS: MAX_REVIEWS,
    termOf: termOf,
    termKeyOf: termKeyOf,
    empty: empty,
    normalize: normalize,
    saveReview: saveReview,
    listReviews: listReviews,
    mergeSection: mergeSection
};
