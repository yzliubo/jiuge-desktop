'use strict';
// 跨期对照 —— V3.10 ㊴。复盘顶部把「上期那句」和「它后来怎么样了」并排摆出来。
//
// 两条底线（跟 RelationView 拒绝评分、复盘「不替你打勾」是同一口径）：
//   1. 只摆事实：上期写了什么、有没有落成下一步、那条现在勾掉了没有。
//      「做到没有」由人回答，这里不判定、不打分、不算完成率。
//   2. 找得到才说，找不到就说找不到。上期没落成下一步，结论是「没有痕迹」，
//      不等于「没做到」——这两句在界面上必须分开，否则系统就在替人定罪。
//
// 为什么不做文本相似度：中文短语的模糊比对很容易把「多陪家人」和「多运动」
// 判成同一件事，一旦误判，用户看到的是系统替他总结错了，比不给结论更糟。
// 所以只认两条硬规则：去掉空白与标点后完全同文，或一句完整包含另一句。

const MAX_LOOKBACK = 6;   // 往回看 6 期：再长就不是对照，是考古
const MIN_PROMISE = 4;    // 少于 4 个字的「同一句」不可信，宁可不判
const HISTORY_MAX = 4;    // 列表里最多摆 4 期，再多右栏一屏放不下

const STATUS_LABEL = {
    inbox: '收件箱',
    next: '下一步',
    waiting: '等待',
    scheduled: '日程',
    someday: '将来也许',
    done: '已完成'
};

// 只脱「皮」：空白与标点。「每天早睡」与「每天早睡。」是同一件事，
// 但「早点睡」与「早睡」不是同一句——字不同就是不同的说法。
const PUNCT = /[\s\u3000，。、；：！？,.;:!?"'“”‘’（）()【】\[\]《》<>—–~`·…]/g;

function str(v) { return typeof v === 'string' ? v : (v === 0 || v ? String(v) : ''); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }

function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function normPromise(s) {
    return str(s).replace(PUNCT, '');
}

function samePromise(a, b) {
    const x = normPromise(a);
    const y = normPromise(b);
    if (x.length < MIN_PROMISE || y.length < MIN_PROMISE) return false;
    return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

// 周期键回退：周键是周一日期，月键是 YYYY-MM。
// 渲染层有一份同口径的 prevReviewKey 只用于在数据回来前摆标签；
// 真正的对照口径在这里，golden 直接测这一份，避免两处算法漂移。
function prevKey(period, key) {
    const k = str(key);
    if (period === 'month') {
        const m = /^(\d{4})-(\d{2})$/.exec(k);
        if (!m) return '';
        const mo = Number(m[2]) - 1;
        return mo < 1 ? (Number(m[1]) - 1) + '-12' : m[1] + '-' + pad2(mo);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return '';
    const d = new Date(k + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    d.setDate(d.getDate() - 7);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function validKey(period, key) {
    return period === 'month' ? /^\d{4}-\d{2}$/.test(key) : /^\d{4}-\d{2}-\d{2}$/.test(key);
}

function keysBack(period, key, n) {
    const out = [];
    let k = str(key);
    // 脏键直接回空：把「不是日期」当周期键往下推，只会推出 6 个假的空档
    if (!validKey(period, k)) return out;
    const max = n > 0 ? n : MAX_LOOKBACK;
    for (let i = 0; i < max && k; i += 1) {
        out.push(k);
        k = prevKey(period, k);
    }
    return out;
}

function labelOf(period, key) {
    const k = str(key);
    return period === 'month' ? k : k.slice(5);
}

// 第 3 问就是「下期只改哪一条」。答案在库里一直是 3 元素数组，
// 这里不认对象形态——认了就等于悄悄支持第二种落库结构。
function promiseOf(answers) {
    if (!Array.isArray(answers)) return '';
    return str(answers[2]).trim();
}

function dayOf(ts) {
    const n = Number(ts);
    if (!isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function dueText(pending, dueDate, today) {
    if (!pending || !dueDate) return '';
    if (dueDate < today) return '已过 ' + dueDate;
    if (dueDate === today) return '今天到期';
    return '定在 ' + dueDate;
}

// 复盘里点过「落成下一步」的那条任务。V3.10 起 source 带周期键（review:week:2026-11-09），
// V3.7 写的老任务只有 source='review'、周期键写在 note 里——两种都得认，
// 否则升级前所有承诺一次性失联，用户只会看到「没落成」。
function findLink(tasks, period, key, today) {
    const k = str(key);
    if (!k) return null;
    const tag = 'review:' + period + ':' + k;
    const list = Array.isArray(tasks) ? tasks : [];
    let hit = null;
    for (let i = 0; i < list.length; i += 1) {
        const t = list[i];
        if (!t) continue;
        const src = str(t.source);
        if (src === tag || (src.indexOf('review') === 0 && str(t.note).indexOf(k) >= 0)) { hit = t; break; }
    }
    if (!hit) return null;
    const status = str(hit.status) || 'next';
    const pending = status !== 'done';
    return {
        id: str(hit.id),
        title: str(hit.title),
        status: status,
        statusLabel: STATUS_LABEL[status] || status,
        pending: pending,
        dueDate: str(hit.dueDate),
        dueText: dueText(pending, str(hit.dueDate), today),
        doneText: dayOf(hit.doneAt)
    };
}

// compare({ period, key, current, slots, tasks, today })
//   slots: 从本期往前排的 [{ key, answers }]，index 0 = 本期
//   current: 本期还没保存的草稿第 3 问（有就优先用，边写边能对照）
function compare(input) {
    const src = input || {};
    const period = src.period === 'month' ? 'month' : 'week';
    const key = str(src.key);
    const today = str(src.today) || localToday();
    const raw = Array.isArray(src.slots) ? src.slots : [];
    const fallbackKeys = keysBack(period, key, raw.length || MAX_LOOKBACK);

    const list = raw.map(function (s, i) {
        const slotKey = str(s && s.key) || fallbackKeys[i] || '';
        let promise = promiseOf(s && s.answers);
        // 本期的草稿优先：刚敲进去的那句也得立刻进对照，不必先保存
        if (i === 0 && normPromise(src.current)) promise = str(src.current).trim();
        return { key: slotKey, promise: promise };
    });

    let streak = 0;
    if (list.length && normPromise(list[0].promise)) {
        streak = 1;
        for (let i = 1; i < list.length; i += 1) {
            if (!samePromise(list[i - 1].promise, list[i].promise)) break;
            streak += 1;
        }
    }

    const history = [];
    // 从「再上期」开始列：上期那句已经在上面的框里了，再列一遍只是同一句话看两次
    for (let i = 2; i < list.length && history.length < HISTORY_MAX; i += 1) {
        if (!normPromise(list[i].promise)) continue;
        history.push({
            key: list[i].key,
            label: labelOf(period, list[i].key),
            promise: list[i].promise,
            // 与「更新一期」是同一句：让人自己数出这句话被写了几遍
            sameAsNewer: samePromise(list[i].promise, list[i - 1].promise)
        });
    }

    const pKey = prevKey(period, key);
    const prevPromise = list.length > 1 ? list[1].promise : '';
    // 上期没写第 3 问就不去追那条任务：没有承诺可追，硬追会追到再上一期的头上
    const link = prevPromise ? findLink(src.tasks, period, pKey, today) : null;

    return {
        period: period,
        key: key,
        prevKey: pKey,
        prevLabel: labelOf(period, pKey),
        prevPromise: prevPromise,
        streak: streak,
        history: history,
        link: link,
        lookback: list.length,
        hasAny: !!(prevPromise || history.length),
        note: '口径：同一句只认「去掉空白与标点后完全同文，或一句完整包含另一句」，不做模糊相似度。'
    };
}

module.exports = {
    MAX_LOOKBACK: MAX_LOOKBACK,
    MIN_PROMISE: MIN_PROMISE,
    HISTORY_MAX: HISTORY_MAX,
    STATUS_LABEL: STATUS_LABEL,
    localToday: localToday,
    normPromise: normPromise,
    samePromise: samePromise,
    prevKey: prevKey,
    keysBack: keysBack,
    labelOf: labelOf,
    promiseOf: promiseOf,
    findLink: findLink,
    compare: compare
};
