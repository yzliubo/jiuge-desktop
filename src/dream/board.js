'use strict';
// 梦想（目标板）模块 —— 原九宫格的「梦想」格升成一级模块。
//
// 为什么升出来：梦想是长期、低频、不知从哪下笔的东西，按天要求写必然空着。
// 它需要的是「计划、进度、期限」，不是每天一句话。九格里的那一格让给「娱乐」。
//
// 形态参照「成功助理」的目标页：主题 → 领域分组 → 子目标行（开始/截止/状态/
// 完成%/优先级），右侧量化分析、关联项、总结。这里按桌面端单机场景收窄：
//   领域 = 工作 / 金钱 / 健康 / 成长 / 其他（前四个直接对应九格里的同名模块）
//   期限 = 短期（一年内）/ 中期（2~3 年）/ 长期（5~7 年）
// 存 md_dream 单键，不写日记记录。

const MAX_DREAMS = 120;
const TITLE_MAX = 60;
const SUMMARY_MAX = 400;
const METRIC_NAME_MAX = 20;
const UNIT_MAX = 10;
const MAX_TASK_LINKS = 12;
const MAX_DEPOSITS = 200;
const CENTS_MAX = 100000000000; // 十亿元封顶，够用且不会被脏数据撑爆显示
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 具象化图片只存**文件名**，不存路径、不存 base64：
//   存路径 → 换机/挪目录就断；存 base64 → 每次 repo.set 都要把几 MB 重写一遍 journal。
// 真正的图片文件落在 <userData>/jiuge-data/dream-images/，与图书馆封面同一套办法。
const IMAGE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

const HORIZONS = [
    { key: 'short', label: '短期', hint: '一年内' },
    { key: 'mid', label: '中期', hint: '2~3 年' },
    { key: 'long', label: '长期', hint: '5~7 年' }
];
const HORIZON_LABEL = {};
HORIZONS.forEach(function (h) { HORIZON_LABEL[h.key] = h.label; });

// 六个领域：对应「成功助理」那棵树里的分组，也接上九格里能落地的模块
const AREAS = [
    { key: 'health', label: '健康与精力', gridKey: 'health', hint: '早睡早起 / 每周运动 / 减重' },
    { key: 'career', label: '事业与财务', gridKey: 'work', hint: '业绩 / 年薪 / 存款——动作在 GTD 与账本里' },
    { key: 'family', label: '家庭与社交', gridKey: 'relation', hint: '体检 / 纪念日 / 朋友聚会' },
    { key: 'growth', label: '学习与成长', gridKey: 'growth', hint: '读书 / 语言 / 证书——动作在学习库' },
    { key: 'spirit', label: '精神与休闲', gridKey: 'leisure', hint: '旅行 / 电影 / 冥想——九格里的娱乐格' },
    { key: 'material', label: '物质与环境', gridKey: '', hint: '车 / 房 / 家里那点事' }
];
const AREA_LABEL = {};
AREAS.forEach(function (a) { AREA_LABEL[a.key] = a.label; });

const STATUS = ['todo', 'doing', 'done', 'paused'];
const STATUS_LABEL = { todo: '未开始', doing: '进行中', done: '已达成', paused: '搁置' };
const PRIORITY_LABEL = { high: '高', normal: '普通' };

function str(v) { return typeof v === 'string' ? v : (v === 0 || v ? String(v) : ''); }
function clean(v, max) {
    const s = str(v).replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max) : s;
}
function num(v, min, max, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, Math.round(n)));
}
function pad(n) { return n < 10 ? '0' + n : String(n); }
function todayOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function newId() { return 'dr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
// 光靠正则不够：「2026-13-40」也是 4-2-2 位数字。日期要回读一遍才算数
function validDate(iso) {
    const t = str(iso);
    if (!DATE_RE.test(t)) return false;
    const p = t.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.getFullYear() === Number(p[0]) && (d.getMonth() + 1) === Number(p[1]) && d.getDate() === Number(p[2]);
}

function dayNumber(iso) {
    const p = String(iso || '').split('-');
    if (p.length !== 3) return NaN;
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime();
}
function diffDays(from, to) {
    const a = dayNumber(from);
    const b = dayNumber(to);
    if (isNaN(a) || isNaN(b)) return 0;
    return Math.round((b - a) / 86400000);
}

const AREA_ALIAS = { work: 'career', money: 'career', relation: 'family', leisure: 'spirit', other: 'material' };
function normArea(raw) {
    const k = str(raw);
    if (AREA_LABEL[k]) return k;
    // 改版前存的领域键映射到新六类，别让老数据掉进「其他」黑洞
    return AREA_ALIAS[k] || 'material';
}
function normHorizon(raw) { return HORIZON_LABEL[str(raw)] ? str(raw) : 'short'; }
function normStatus(raw) {
    const s = str(raw);
    return STATUS.indexOf(s) >= 0 ? s : 'todo';
}
// 图片文件名只认 basename：带 / 或 .. 的一律当没设，避免渲染层塞进越界路径
function normImageId(raw) {
    const s = clean(raw, 80);
    if (!s || !IMAGE_ID_RE.test(s)) return '';
    return s.indexOf('..') < 0 ? s : '';
}

// 梦想账户：先给目标定价，再往里存钱。钱够了就该动手——这是提醒的依据。
function normDeposit(raw) {
    const d = (raw && typeof raw === 'object') ? raw : {};
    const cents = num(d.cents, 0, CENTS_MAX, 0);
    if (!cents) return null;
    return {
        id: clean(d.id, 40) || newId(),
        cents: cents,
        date: validDate(d.date) ? str(d.date) : todayOf(new Date()),
        note: clean(d.note, 60),
        // 钱的来源：从金钱账户划过来（money）还是别处凑的（other）
        source: str(d.source) === 'money' ? 'money' : 'other',
        createdAt: Number(d.createdAt) || Date.now()
    };
}

function normMetric(raw) {
    const m = (raw && typeof raw === 'object') ? raw : {};
    const name = clean(m.name, METRIC_NAME_MAX);
    if (!name) return null;
    return {
        name: name,
        unit: clean(m.unit, UNIT_MAX),
        from: Number(m.from) || 0,
        to: Number(m.to) || 0,
        current: Number(m.current) || 0
    };
}

function normalizeDream(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = clean(raw.title, TITLE_MAX);
    if (!title) return null;
    const createdAt = Number(raw.createdAt) || Date.now();
    const startDate = validDate(raw.startDate) ? str(raw.startDate) : '';
    const dueDate = validDate(raw.dueDate) ? str(raw.dueDate) : '';
    const deposits = [];
    (Array.isArray(raw.deposits) ? raw.deposits : []).slice(-MAX_DEPOSITS).forEach(function (x) {
        const one = normDeposit(x);
        if (one) deposits.push(one);
    });
    const fundSrc = (raw.fund && typeof raw.fund === 'object') ? raw.fund : {};
    const fundTarget = num(fundSrc.target, 0, CENTS_MAX, 0);
    const taskIds = [];
    (Array.isArray(raw.taskIds) ? raw.taskIds : []).forEach(function (id) {
        const k = clean(id, 40);
        if (k && taskIds.indexOf(k) < 0 && taskIds.length < MAX_TASK_LINKS) taskIds.push(k);
    });
    return {
        id: clean(raw.id, 40) || newId(),
        title: title,
        area: normArea(raw.area),
        horizon: normHorizon(raw.horizon),
        status: normStatus(raw.status),
        priority: str(raw.priority) === 'high' ? 'high' : 'normal',
        startDate: startDate,
        dueDate: dueDate,
        progress: num(raw.progress, 0, 100, 0),
        metric: normMetric(raw.metric),
        // target=0 表示没开梦想账户；开了才谈「存够没」
        fund: { target: fundTarget },
        deposits: deposits,
        summary: clean(raw.summary, SUMMARY_MAX),
        // 具象化图片（做到之后会看到的样子）：只记文件名，文件在主进程的 dream-images 目录
        image: normImageId(raw.image),
        taskIds: taskIds,
        createdAt: createdAt,
        updatedAt: Number(raw.updatedAt) || createdAt
    };
}

function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const seen = {};
    const list = [];
    (Array.isArray(src.dreams) ? src.dreams : []).slice(0, MAX_DREAMS).forEach(function (d) {
        const one = normalizeDream(d);
        if (!one) return;
        if (seen[one.id]) one.id = newId();
        seen[one.id] = true;
        list.push(one);
    });
    return { version: 1, theme: clean(src.theme, 80) || '人生因梦想而伟大', dreams: list };
}

function empty() {
    return { version: 1, theme: '人生因梦想而伟大', dreams: [] };
}


// ---- 初始那棵树 ----
// 第一次打开就给一棵能用的树：主题 → 六个领域 → 子目标。
// 不是「范例数据」摆着好看，是替用户把「不知道该写什么」这一步做掉——
// 每条都留了可改的期限与量化位，用户删掉不合身的就行。
const SEED = [
    ['health', 'short', '早睡早起（23:30 前睡）', { metric: { name: '每周达标天数', unit: '天', from: 0, to: 7, current: 0 } }],
    ['health', 'short', '每周运动 3 次', { metric: { name: '每周次数', unit: '次', from: 0, to: 3, current: 0 } }],
    ['health', 'mid', '减重 10 斤', { metric: { name: '体重', unit: '斤', from: 160, to: 150, current: 160 } }],
    ['career', 'short', '业绩提升 50%', {}],
    ['career', 'short', '年薪达到目标值', {}],
    ['career', 'mid', '攒下 8 万存款', { fund: true }],
    ['family', 'short', '带父母做一次体检', {}],
    ['family', 'short', '恋爱纪念日去一次旅行', {}],
    ['family', 'short', '每月一次朋友聚会', { metric: { name: '每月次数', unit: '次', from: 0, to: 1, current: 0 } }],
    ['growth', 'short', '阅读 10 本经典书籍', { metric: { name: '已读', unit: '本', from: 0, to: 10, current: 0 } }],
    ['growth', 'mid', '学习一门新语言', {}],
    ['growth', 'mid', '考取目标证书', {}],
    ['spirit', 'short', '看 50 部高分电影', { metric: { name: '已看', unit: '部', from: 0, to: 50, current: 0 } }],
    ['spirit', 'short', '坚持冥想', { metric: { name: '每周次数', unit: '次', from: 0, to: 7, current: 0 } }],
    ['spirit', 'mid', '出国旅行一次', { fund: true }],
    ['material', 'mid', '2 年内换一部好车', { fund: true }],
    ['material', 'mid', '完成房屋软装升级', {}]
];

function seedState() {
    const s = empty();
    SEED.forEach(function (row) {
        const one = normalizeDream({
            id: newId(),
            title: row[2],
            area: row[0],
            horizon: row[1],
            status: 'doing',
            metric: row[3] && row[3].metric ? row[3].metric : null,
            fund: row[3] && row[3].fund ? { target: 0 } : { target: 0 },
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
        if (one) s.dreams.push(one);
    });
    return normalize(s);
}

// 有量化指标时，进度由「当前值」推导：写进度条是主观的，填数字不是
function progressOf(d) {
    const m = d.metric;
    if (!m || !m.name) return d.progress;
    if (m.to === m.from) return d.progress;
    const raw = (m.current - m.from) / (m.to - m.from);
    return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

function add(state, patch) {
    const s = normalize(state);
    const p = patch || {};
    const one = normalizeDream({
        id: newId(),
        title: p.title,
        area: p.area,
        horizon: p.horizon,
        status: p.status || 'doing',
        priority: p.priority,
        startDate: p.startDate,
        dueDate: p.dueDate,
        progress: p.progress,
        metric: p.metric,
        summary: p.summary,
        createdAt: Date.now(),
        updatedAt: Date.now()
    });
    if (!one) return s;
    s.dreams.push(one);
    return normalize(s);
}

function update(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    const p = patch || {};
    const one = s.dreams.filter(function (d) { return d.id === key; })[0];
    if (!one) return s;
    if (p.title !== undefined) {
        const t = clean(p.title, TITLE_MAX);
        if (t) one.title = t;
    }
    if (p.area !== undefined) one.area = normArea(p.area);
    if (p.horizon !== undefined) one.horizon = normHorizon(p.horizon);
    if (p.status !== undefined) one.status = normStatus(p.status);
    if (p.priority !== undefined) one.priority = str(p.priority) === 'high' ? 'high' : 'normal';
    if (p.startDate !== undefined) one.startDate = validDate(p.startDate) ? str(p.startDate) : '';
    if (p.dueDate !== undefined) one.dueDate = validDate(p.dueDate) ? str(p.dueDate) : '';
    if (p.progress !== undefined) one.progress = num(p.progress, 0, 100, one.progress);
    if (p.metric !== undefined) one.metric = normMetric(p.metric);
    if (p.summary !== undefined) one.summary = clean(p.summary, SUMMARY_MAX);
    // 达成时把进度补满：一个 100% 才算达成的目标，不该停在 60%
    if (one.status === 'done') one.progress = 100;
    one.updatedAt = Date.now();
    return normalize(s);
}

function remove(state, id) {
    const s = normalize(state);
    const key = str(id);
    s.dreams = s.dreams.filter(function (d) { return d.id !== key; });
    return s;
}

// 具象化图片：只换文件名，文件复制/删除由主进程负责（领域层不碰 fs）
function setImage(state, id, imageId) {
    const s = normalize(state);
    const one = s.dreams.filter(function (d) { return d.id === str(id); })[0];
    if (!one) return s;
    one.image = normImageId(imageId);
    one.updatedAt = Date.now();
    return normalize(s);
}

// 给梦想定价（分）。设成 0 等于关掉账户，已存记录不删——用户在账上的钱不能凭空消失
function setFund(state, id, targetCents) {
    const s = normalize(state);
    const one = s.dreams.filter(function (d) { return d.id === str(id); })[0];
    if (!one) return s;
    one.fund = { target: num(targetCents, 0, CENTS_MAX, 0) };
    one.updatedAt = Date.now();
    return normalize(s);
}

function deposit(state, id, cents, date, note, source) {
    const s = normalize(state);
    const one = s.dreams.filter(function (d) { return d.id === str(id); })[0];
    if (!one) return s;
    const rec = normDeposit({ cents: cents, date: date, note: note, source: source });
    if (!rec) return s;
    if (one.deposits.length >= MAX_DEPOSITS) one.deposits.shift();
    one.deposits.push(rec);
    one.updatedAt = Date.now();
    return normalize(s);
}

function savedOf(d) {
    return (Array.isArray(d.deposits) ? d.deposits : []).reduce(function (n, x) { return n + (Number(x.cents) || 0); }, 0);
}

function setTheme(state, theme) {
    const s = normalize(state);
    s.theme = clean(theme, 80) || s.theme;
    return s;
}

function linkTask(state, id, taskId) {
    const s = normalize(state);
    const key = str(id);
    const tid = clean(taskId, 40);
    if (!tid) return s;
    const one = s.dreams.filter(function (d) { return d.id === key; })[0];
    if (!one) return s;
    if (one.taskIds.indexOf(tid) < 0 && one.taskIds.length < MAX_TASK_LINKS) one.taskIds.push(tid);
    one.updatedAt = Date.now();
    return normalize(s);
}

function unlinkTask(state, id, taskId) {
    const s = normalize(state);
    const key = str(id);
    const tid = str(taskId);
    const one = s.dreams.filter(function (d) { return d.id === key; })[0];
    if (!one) return s;
    one.taskIds = one.taskIds.filter(function (x) { return x !== tid; });
    one.updatedAt = Date.now();
    return normalize(s);
}

// 梦想页要的不是「几件事」，而是「哪件事正把这几个目标往前推」
function board(state, tasks, today) {
    const s = normalize(state);
    const now = validDate(today) ? str(today) : todayOf(new Date());
    const taskMap = {};
    (Array.isArray(tasks) ? tasks : []).forEach(function (t) {
        if (t && t.id) taskMap[t.id] = t;
    });

    const byHorizon = {};
    HORIZONS.forEach(function (h) { byHorizon[h.key] = 0; });
    const byArea = {};
    AREAS.forEach(function (a) { byArea[a.key] = 0; });
    let progressSum = 0;
    let achieved = 0;
    let overdue = 0;

    const rows = s.dreams.map(function (d) {
        const progress = d.status === 'done' ? 100 : progressOf(d);
        const linked = d.taskIds.map(function (id) { return taskMap[id]; }).filter(function (t) { return !!t; });
        const openTasks = linked.filter(function (t) { return t.status !== 'done'; }).length;
        const isOverdue = !!d.dueDate && d.status !== 'done' && d.dueDate < now;
        const saved = savedOf(d);
        const target = (d.fund && d.fund.target) || 0;
        const fundPct = target > 0 ? Math.min(100, Math.round(saved * 100 / target)) : 0;
        // 钱够了并不等于事做完了：这里只表示「可以动手了」
        const ready = target > 0 && saved >= target && d.status !== 'done';
        byHorizon[d.horizon] += 1;
        byArea[d.area] += 1;
        progressSum += progress;
        if (d.status === 'done') achieved += 1;
        if (isOverdue) overdue += 1;
        return {
            id: d.id,
            title: d.title,
            area: d.area,
            areaLabel: AREA_LABEL[d.area],
            horizon: d.horizon,
            horizonLabel: HORIZON_LABEL[d.horizon],
            status: d.status,
            statusLabel: STATUS_LABEL[d.status],
            priority: d.priority,
            priorityLabel: PRIORITY_LABEL[d.priority],
            startDate: d.startDate,
            dueDate: d.dueDate,
            progress: progress,
            metric: d.metric,
            fund: target > 0 ? { target: target, saved: saved, pct: fundPct, ready: ready } : null,
            deposits: d.deposits.length,
            summary: d.summary,
            // image 是文件名，hasImage 给界面判断「配没配图」，省得前端判空判错
            image: d.image || '',
            hasImage: !!d.image,
            taskTotal: linked.length,
            taskOpen: openTasks,
            taskDone: linked.length - openTasks,
            dueDays: d.dueDate ? diffDays(now, d.dueDate) : null,
            overdue: isOverdue,
            // 期限不是「还剩 12 天」这种冷数字，要说得出「已经在收尾」还是「还没动」
            pace: (function () {
                if (d.status === 'done') return '已达成';
                if (!d.dueDate) return '';
                const left = diffDays(now, d.dueDate);
                if (left < 0) return '已超期 ' + (-left) + ' 天';
                if (left === 0) return '今天到期';
                if (left <= 30) return '剩 ' + left + ' 天';
                if (left <= 365) return '剩 ' + Math.round(left / 30) + ' 个月';
                return '剩 ' + Math.round(left / 365 * 10) / 10 + ' 年';
            })(),
            createdAt: d.createdAt,
            updatedAt: d.updatedAt
        };
    });

    rows.sort(function (a, b) {
        const hi = HORIZONS.map(function (h) { return h.key; });
        if (a.horizon !== b.horizon) return hi.indexOf(a.horizon) - hi.indexOf(b.horizon);
        if (a.status === 'done' && b.status !== 'done') return 1;
        if (b.status === 'done' && a.status !== 'done') return -1;
        if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        return b.updatedAt - a.updatedAt;
    });

    const alerts = rows.filter(function (r) { return r.fund && r.fund.ready; })
        .map(function (r) { return { id: r.id, title: r.title, saved: r.fund.saved, target: r.fund.target, horizonLabel: r.horizonLabel }; });

    const stats = {
        total: rows.length,
        achieved: achieved,
        overdue: overdue,
        avgProgress: rows.length ? Math.round(progressSum / rows.length) : 0,
        byHorizon: byHorizon,
        byArea: byArea
    };

    let insight;
    if (!rows.length) {
        insight = '还没有目标。写一条具体的：什么时候、做到什么数——「多挣钱」不是目标，「今年存下 8 万」才是。';
    } else if (stats.overdue > 0) {
        insight = '有 ' + stats.overdue + ' 个目标已超期，先改期限或改成「搁置」——挂着的过期目标会让人对整页都麻木。';
    } else if (achieved > 0) {
        insight = rows.length + ' 个目标，已达成 ' + achieved + ' 个，平均进度 ' + stats.avgProgress + '%。'
            + (byHorizon.long ? '长期目标 ' + byHorizon.long + ' 个。' : '');
    } else {
        insight = rows.length + ' 个目标，平均进度 ' + stats.avgProgress + '%。'
            + (byHorizon.short ? '短期 ' + byHorizon.short + ' 个：今年能看见结果的那几个。' : '');
    }

    return {
        theme: s.theme,
        rows: rows,
        // 账户存够、目标还没达成的——浮窗提醒读这个字段
        alerts: alerts,
        stats: stats,
        insight: insight,
        horizons: HORIZONS,
        areas: AREAS,
        statusMeta: STATUS,
        limits: { dreams: MAX_DREAMS, title: TITLE_MAX, summary: SUMMARY_MAX, taskLinks: MAX_TASK_LINKS }
    };
}

function meta() {
    return {
        horizons: HORIZONS,
        areas: AREAS,
        status: STATUS,
        statusLabel: STATUS_LABEL,
        priorityLabel: PRIORITY_LABEL,
        limits: { dreams: MAX_DREAMS, title: TITLE_MAX, summary: SUMMARY_MAX, taskLinks: MAX_TASK_LINKS }
    };
}

// 跨机恢复：按 id 合并，只补不改
function mergeSection(state, section) {
    const s = normalize(state);
    const incoming = normalize(section);
    const seen = {};
    s.dreams.forEach(function (d) { seen[d.id] = true; });
    let added = 0;
    incoming.dreams.forEach(function (d) {
        if (seen[d.id]) return;
        s.dreams.push(d);
        seen[d.id] = true;
        added += 1;
    });
    return { state: normalize(s), added: added };
}

module.exports = {
    MAX_DREAMS: MAX_DREAMS,
    TITLE_MAX: TITLE_MAX,
    SUMMARY_MAX: SUMMARY_MAX,
    MAX_TASK_LINKS: MAX_TASK_LINKS,
    HORIZONS: HORIZONS,
    HORIZON_LABEL: HORIZON_LABEL,
    AREAS: AREAS,
    AREA_LABEL: AREA_LABEL,
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    PRIORITY_LABEL: PRIORITY_LABEL,
    empty: empty,
    seedState: seedState,
    normalize: normalize,
    add: add,
    update: update,
    remove: remove,
    setTheme: setTheme,
    setFund: setFund,
    setImage: setImage,
    normImageId: normImageId,
    deposit: deposit,
    savedOf: savedOf,
    linkTask: linkTask,
    unlinkTask: unlinkTask,
    progressOf: progressOf,
    board: board,
    meta: meta,
    mergeSection: mergeSection
};
