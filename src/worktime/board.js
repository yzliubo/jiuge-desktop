// 九格手记 · 工作模块「本机时间源」领域模块（md_worktime 单键）
//
// 为什么独立成模块、而不是塞进 md_gtd：
//   1. 时间数据是**外部系统的只读投影**，生命周期与 GTD 清单完全不同（清单要长期带着，
//      投入数据越久越没用也越敏感），混在一个键里没法单独设保留期、单独清空；
//   2. GTD 的 normalize 白名单是逐字段写死的，塞进 days / rules 这类大结构会被静默削掉
//      （第 12 轮 addTask 踩过一次，不是理论风险）；
//   3. 备份注入、打包清单、门禁都要按模块点名，独立键与 md_reading / md_gtd 同一先例。
//
// 三条硬约束（改代码前先读）：
//   · **本模块不存窗口标题**。normalize 里根本没有 title 字段，聚合层（aggregate.js）用完即弃；
//   · **默认关闭**。enabled:false 时主进程一次请求都不发，界面也不显示任何时间源卡片；
//   · **只读**。client.js 只发 GET，不建 bucket、不打 tag、不写回 ActivityWatch。
//
// 纯函数、不碰 wxStorage、不联网：所有时间与外部数据由调用方传入，便于 golden 断言。

'use strict';

const KEY = 'md_worktime';
const VERSION = 1;

const RULE_MAX = 40;
const DAYS_DEFAULT = 180;
const DAYS_MAX = 400;
const DAYS_MIN = 30;
const APP_MAX = 40;
const RULE_ROW_MAX = 40;
const BLOCK_MAX = 12;
const WRITTEN_MAX = 40;
const LABEL_MAX = 20;
const APP_NAME_MAX = 40;
const TITLE_RE_MAX = 120;
const TOKEN_MAX = 120;
const ERROR_MAX = 120;

// 规则可以落到哪一格：与九格键一致（'dream' 是 V1.x 旧键，只在显示名上保留，不放进规则）
const CELL_KEYS = ['work', 'money', 'health', 'relation', 'future', 'emotion', 'leisure', 'growth', 'free'];

// 只允许回环地址：非回环一律拒绝保存，避免把「本机时间源」变成「远程上报」
const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{2,5})?$/;

const DAY_SEC_MAX = 24 * 3600;

function clampInt(v, min, max, dflt) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}
function str(v, max) {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim();
    return s.slice(0, max);
}
function isDateStr(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function normalizeRule(raw, idx) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const id = str(r.id, 24) || ('r_' + (idx + 1));
    const app = str(r.app, APP_NAME_MAX).toLowerCase().replace(/\.exe$/, '');
    const titleMatch = str(r.titleMatch, TITLE_RE_MAX);
    if (!app && !titleMatch) return null; // 空规则会命中一切，等同「全部归一类」，宁可丢掉
    const target = r.target && typeof r.target === 'object' ? r.target : {};
    const cell = CELL_KEYS.indexOf(String(target.cell || '')) >= 0 ? String(target.cell) : 'work';
    return {
        id: id,
        order: clampInt(r.order, 0, 9999, idx * 10),
        app: app,
        titleMatch: titleMatch,
        label: str(r.label, LABEL_MAX) || app || '未命名',
        enabled: r.enabled !== false,
        target: {
            cell: cell,
            projectId: str(target.projectId, 24),
            context: str(target.context, 12)
        }
    };
}

function normalizeDay(raw) {
    const d = raw && typeof raw === 'object' ? raw : null;
    if (!d) return null;
    const apps = (Array.isArray(d.apps) ? d.apps : [])
        .map(function (a) {
            const pair = Array.isArray(a) ? a : [a && a.app, a && a.min];
            const name = str(pair[0], APP_NAME_MAX).toLowerCase();
            const min = clampInt(pair[1], 0, 1440, 0);
            return name ? [name, min] : null;
        })
        .filter(Boolean)
        .filter(function (a) { return a[1] > 0; })
        .slice(0, APP_MAX);

    const rules = (Array.isArray(d.rules) ? d.rules : [])
        .map(function (a) {
            const pair = Array.isArray(a) ? a : [a && a.id, a && a.min];
            const id = str(pair[0], 24);
            const min = clampInt(pair[1], 0, 1440, 0);
            return id ? [id, min] : null;
        })
        .filter(Boolean)
        .slice(0, RULE_ROW_MAX);

    const blocks = (Array.isArray(d.blocks) ? d.blocks : [])
        .map(function (b) {
            const arr = Array.isArray(b) ? b : [b && b.start, b && b.end, b && b.ruleId, b && b.app];
            const s = clampInt(arr[0], 0, 1439, -1);
            const e = clampInt(arr[1], 0, 1440, -1);
            if (s < 0 || e <= s) return null;
            return [s, e, str(arr[2], 24), str(arr[3], APP_NAME_MAX).toLowerCase()];
        })
        .filter(Boolean)
        .slice(0, BLOCK_MAX);

    const written = (Array.isArray(d.written) ? d.written : [])
        .map(function (k) { return str(k, 24); })
        .filter(Boolean)
        .slice(0, WRITTEN_MAX);

    return {
        activeSec: clampInt(d.activeSec, 0, DAY_SEC_MAX, 0),
        windowSec: clampInt(d.windowSec, 0, DAY_SEC_MAX, 0),
        afkSec: clampInt(d.afkSec, 0, DAY_SEC_MAX, 0),
        unclassifiedRatio: clampInt(d.unclassifiedRatio, 0, 100, 0),
        apps: apps,
        rules: rules,
        blocks: blocks,
        written: written,
        syncedAt: clampInt(d.syncedAt, 0, 4102444800000, 0)
    };
}

function empty() {
    return {
        v: VERSION,
        enabled: false,
        host: '127.0.0.1:5600',
        token: '',
        keepDays: DAYS_DEFAULT,
        rules: [],
        days: {},
        lastError: null
    };
}

function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const keepDays = clampInt(src.keepDays, DAYS_MIN, DAYS_MAX, DAYS_DEFAULT);

    const rules = [];
    const seenRule = {};
    (Array.isArray(src.rules) ? src.rules : []).forEach(function (r, i) {
        const nr = normalizeRule(r, i);
        if (!nr || seenRule[nr.id]) return;
        seenRule[nr.id] = 1;
        rules.push(nr);
    });
    rules.sort(function (a, b) { return a.order - b.order; });

    // 只留最近的 keepDays 天：日期字符串按字典序即时间序
    const days = {};
    Object.keys(src.days && typeof src.days === 'object' ? src.days : {})
        .filter(isDateStr)
        .sort()
        .reverse()
        .slice(0, keepDays)
        .forEach(function (k) {
            const d = normalizeDay(src.days[k]);
            if (d) days[k] = d;
        });

    let lastError = null;
    if (src.lastError && typeof src.lastError === 'object') {
        lastError = {
            at: clampInt(src.lastError.at, 0, 4102444800000, 0),
            code: str(src.lastError.code, 24),
            msg: str(src.lastError.msg, ERROR_MAX)
        };
    }

    const host = String(src.host || '').trim();

    return {
        v: VERSION,
        enabled: src.enabled === true,
        host: HOST_RE.test(host) ? host : '127.0.0.1:5600',
        token: str(src.token, TOKEN_MAX),
        keepDays: keepDays,
        rules: rules.slice(0, RULE_MAX),
        days: days,
        lastError: lastError
    };
}

// ---- 设置 ----

function setEnabled(state, on) {
    return Object.assign({}, normalize(state), { enabled: on === true });
}

function setHost(state, host) {
    const h = String(host || '').trim();
    if (!HOST_RE.test(h)) {
        const e = new Error('只支持本机回环地址（127.0.0.1 / localhost / [::1]）');
        e.code = 'BAD_HOST';
        throw e;
    }
    return Object.assign({}, normalize(state), { host: h });
}

function setKeepDays(state, n) {
    return Object.assign({}, normalize(state), { keepDays: clampInt(n, DAYS_MIN, DAYS_MAX, DAYS_DEFAULT) });
}

function setToken(state, token) {
    return Object.assign({}, normalize(state), { token: str(token, TOKEN_MAX) });
}

function setError(state, code, msg) {
    const s = normalize(state);
    s.lastError = { at: Date.now(), code: str(code, 24), msg: str(msg, ERROR_MAX) };
    return s;
}

function clearError(state) {
    const s = normalize(state);
    s.lastError = null;
    return s;
}

// ---- 规则 ----

function addRule(state, patch) {
    const s = normalize(state);
    // id 里必须带序号：只靠「毫秒 + 0~99 随机」在同毫秒批量建规则时会撞 id，
    // 撞了就被 normalize 去重，于是「上限 40 条」这条用例偶尔只数到 39。
    // 这不是测试的问题，是真会少一条规则。
    const seed = 'r_' + Date.now().toString(36) + '_' + (s.rules.length + 1).toString(36)
        + Math.floor(Math.random() * 100);
    const r = normalizeRule(Object.assign({ id: seed }, patch || {}), s.rules.length);
    if (!r) {
        const e = new Error('规则要至少填应用名或标题关键词');
        e.code = 'INVALID_RULE';
        throw e;
    }
    if (s.rules.length >= RULE_MAX) {
        const e = new Error('规则最多 ' + RULE_MAX + ' 条，先删一条再建');
        e.code = 'RULE_LIMIT';
        throw e;
    }
    r.order = (s.rules.length + 1) * 10;
    s.rules = s.rules.concat([r]);
    return s;
}

function updateRule(state, id, patch) {
    const s = normalize(state);
    const key = str(id, 24);
    s.rules = s.rules.map(function (r) {
        if (r.id !== key) return r;
        const merged = normalizeRule(Object.assign({}, r, patch || {}, { id: r.id }), r.order / 10);
        return merged || r;
    });
    return s;
}

function removeRule(state, id) {
    const s = normalize(state);
    const key = str(id, 24);
    s.rules = s.rules.filter(function (r) { return r.id !== key; });
    return s;
}

function rulesOf(state) {
    return normalize(state).rules.slice();
}

// ---- 日数据 ----

function applyDay(state, date, result) {
    const s = normalize(state);
    const d = isDateStr(date) ? date : '';
    if (!d) return s;
    const day = normalizeDay(Object.assign({}, result || {}, {
        syncedAt: (result && result.syncedAt) || Date.now()
    }));
    if (!day) return s;
    // 重同步时保留「已记过」标记，否则同一段会被写第二遍
    if (s.days[d] && s.days[d].written) day.written = s.days[d].written;
    s.days[d] = day;
    // 裁剪：日期倒序保留 keepDays
    const keys = Object.keys(s.days).sort().reverse();
    if (keys.length > s.keepDays) {
        const keep = {};
        keys.slice(0, s.keepDays).forEach(function (k) { keep[k] = s.days[k]; });
        s.days = keep;
    }
    s.lastError = null;
    return s;
}

function dayOf(state, date) {
    const s = normalize(state);
    return isDateStr(date) && s.days[date] ? s.days[date] : null;
}

function markWritten(state, date, blockKey) {
    const s = normalize(state);
    const d = isDateStr(date) ? date : '';
    if (!d || !s.days[d]) return s;
    const key = str(blockKey, 24);
    if (!key) return s;
    const written = s.days[d].written || [];
    if (written.indexOf(key) < 0) s.days[d].written = written.concat([key]).slice(-WRITTEN_MAX);
    return s;
}

function clearDays(state) {
    const s = normalize(state);
    s.days = {};
    return s;
}

function meta(state) {
    const s = normalize(state);
    const dates = Object.keys(s.days).sort();
    const last = dates.length ? dates[dates.length - 1] : '';
    return {
        enabled: s.enabled,
        host: s.host,
        hasToken: !!s.token,
        keepDays: s.keepDays,
        ruleCount: s.rules.length,
        dayCount: dates.length,
        lastDate: last,
        lastSync: last && s.days[last] ? s.days[last].syncedAt : 0,
        bytes: JSON.stringify(s.days).length
    };
}

// 近 N 天合计：周回顾用「投入 vs 完成」对照，不参与任何评分
function weekStats(state, dates) {
    const s = normalize(state);
    const list = (Array.isArray(dates) ? dates : []).filter(isDateStr);
    let activeSec = 0;
    let windowSec = 0;
    const byRule = {};
    let unclassifiedSec = 0;
    let covered = 0;
    list.forEach(function (d) {
        const day = s.days[d];
        if (!day) return;
        covered += 1;
        activeSec += day.activeSec;
        windowSec += day.windowSec;
        const classified = day.rules.reduce(function (n, r) { return n + (r[1] || 0); }, 0);
        unclassifiedSec += Math.max(0, Math.round(day.activeSec / 60) - classified) * 60;
        day.rules.forEach(function (r) { byRule[r[0]] = (byRule[r[0]] || 0) + r[1]; });
    });
    return {
        days: covered,
        activeMin: Math.round(activeSec / 60),
        windowMin: Math.round(windowSec / 60),
        unclassifiedRatio: activeSec > 0 ? Math.round((unclassifiedSec / activeSec) * 100) : 0,
        byRule: Object.keys(byRule).map(function (id) {
            const rule = s.rules.filter(function (r) { return r.id === id; })[0];
            return { id: id, label: rule ? rule.label : id, min: Math.round(byRule[id]) };
        }).sort(function (a, b) { return b.min - a.min; })
    };
}

// 备份：规则全带，日数据只补不改（换机后两边的日子各归各的）
function mergeSection(state, section) {
    const s = normalize(state);
    const sec = section && typeof section === 'object' ? section : {};
    let added = 0;

    const have = {};
    s.rules.forEach(function (r) { have[r.id] = 1; });
    (Array.isArray(sec.rules) ? sec.rules : []).forEach(function (r, i) {
        if (s.rules.length >= RULE_MAX) return;
        const nr = normalizeRule(r, i);
        if (!nr || have[nr.id]) return;
        have[nr.id] = 1;
        s.rules.push(nr);
        added += 1;
    });
    s.rules.sort(function (a, b) { return a.order - b.order; });

    Object.keys(sec.days && typeof sec.days === 'object' ? sec.days : {}).forEach(function (d) {
        if (!isDateStr(d) || s.days[d]) return;
        const day = normalizeDay(sec.days[d]);
        if (!day) return;
        s.days[d] = day;
        added += 1;
    });

    // 导入的备份可能带 400 天，仍按本机 keepDays 裁一次
    const keys = Object.keys(s.days).sort().reverse();
    if (keys.length > s.keepDays) {
        const keep = {};
        keys.slice(0, s.keepDays).forEach(function (k) { keep[k] = s.days[k]; });
        s.days = keep;
    }
    return { state: s, added: added };
}

// ---- 回写工作格：只追加、幂等、可自愈 ----

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function blockKey(block) {
    const b = Array.isArray(block) ? block : [block && block.start, block && block.end];
    return clampInt(b[0], 0, 1439, 0) + '-' + clampInt(b[1], 0, 1440, 0);
}

function blockLine(block, label, app) {
    const b = Array.isArray(block) ? block : [block && block.start, block && block.end, block && block.ruleId, block && block.app];
    const s = clampInt(b[0], 0, 1439, 0);
    const e = clampInt(b[1], 0, 1440, 0);
    const min = Math.max(1, e - s);
    const from = pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
    const to = pad2(Math.floor(e / 60)) + ':' + pad2(e % 60);
    const who = str(app || b[3], 24) || '本机';
    const what = str(label, LABEL_MAX) || '未归类';
    return '- ' + from + '–' + to + ' ' + who + ' · ' + what + '（' + min + ' 分钟）';
}

function hasLine(text, line) {
    return String(text || '').indexOf(String(line || '')) >= 0;
}

module.exports = {
    KEY: KEY,
    VERSION: VERSION,
    RULE_MAX: RULE_MAX,
    DAYS_DEFAULT: DAYS_DEFAULT,
    DAYS_MAX: DAYS_MAX,
    CELL_KEYS: CELL_KEYS,
    HOST_RE: HOST_RE,
    empty: empty,
    normalize: normalize,
    meta: meta,
    setEnabled: setEnabled,
    setHost: setHost,
    setKeepDays: setKeepDays,
    setToken: setToken,
    setError: setError,
    clearError: clearError,
    addRule: addRule,
    updateRule: updateRule,
    removeRule: removeRule,
    rulesOf: rulesOf,
    applyDay: applyDay,
    dayOf: dayOf,
    markWritten: markWritten,
    clearDays: clearDays,
    weekStats: weekStats,
    mergeSection: mergeSection,
    blockKey: blockKey,
    blockLine: blockLine,
    hasLine: hasLine
};
