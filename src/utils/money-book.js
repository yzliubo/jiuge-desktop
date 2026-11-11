// 九格手记 · 金钱模块（九宫格内简单收支登记 + 回看汇总）
// 纯函数模块：不直接读写 wx storage，持久化统一交给 utils/diary-store.js。
// 数据挂在当天日记记录的 moneyBook.entries 上，按日期天然分组，随日记一起
// 备份 / 导出 / 跨年回看；历史记录缺字段时视为空账本，零迁移。
// 金额一律以「分」为整数存储，避免浮点累加误差。
// 形态参考极简一笔记账：收/支切换 → 金额 → 分类 → 一句备注，三步内完成。

const MAX_ENTRIES = 30;          // 每天最多 30 笔
const NOTE_MAX = 40;             // 备注字数
const CENTS_MAX = 999999999;     // 单笔上限（分）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 用单字汉字作分类图标：不依赖 emoji 字体，安卓 / iOS 渲染一致
const CATEGORIES = {
    expense: [
        { id: 'food', label: '餐饮', glyph: '食' },
        { id: 'transport', label: '交通', glyph: '行' },
        { id: 'daily', label: '日用', glyph: '用' },
        { id: 'home', label: '居家', glyph: '家' },
        { id: 'medical', label: '医疗', glyph: '医' },
        { id: 'social', label: '人情', glyph: '礼' },
        { id: 'learn', label: '学习', glyph: '学' },
        { id: 'fun', label: '娱乐', glyph: '乐' },
        { id: 'other', label: '其他', glyph: '他' },
    ],
    income: [
        { id: 'salary', label: '工资', glyph: '薪' },
        { id: 'bonus', label: '奖金', glyph: '奖' },
        { id: 'reimburse', label: '报销', glyph: '报' },
        { id: 'gift', label: '红包', glyph: '礼' },
        { id: 'invest', label: '理财', glyph: '息' },
        { id: 'side', label: '兼职', glyph: '副' },
        { id: 'other', label: '其他', glyph: '他' },
    ],
};

const CATEGORY_MAP = {};
CATEGORIES.expense.forEach(function (c) { CATEGORY_MAP[c.id] = c; });
CATEGORIES.income.forEach(function (c) {
    // 两类共用的 other（以及未来的同名项）沿用同一份字面定义
    if (!CATEGORY_MAP[c.id]) CATEGORY_MAP[c.id] = c;
});

let seq = 0;

function entryId() {
    seq += 1;
    return 'm_' + Date.now().toString(36) + '_' + seq;
}

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\r/g, '')
        .replace(/[\n\t]/g, ' ')
        .trim()
        .slice(0, max);
}

function pad(n) {
    return n < 10 ? '0' + n : String(n);
}

// 「12」「12.5」「¥ 12.50」「1,234」都接受；返回整数分，非法或非正返回 0
function parseAmount(value) {
    const s = String(value === undefined || value === null ? '' : value)
        .replace(/[¥￥,\s]/g, '')
        .trim();
    if (!s || !/^\d+(\.\d{0,2})?$/.test(s)) return 0;
    const parts = s.split('.');
    const yuan = Number(parts[0]);
    const frac = ((parts[1] || '') + '00').slice(0, 2);
    const total = yuan * 100 + Number(frac);
    if (!isFinite(total) || total <= 0 || total > CENTS_MAX) return 0;
    return Math.round(total);
}

function formatCents(cents) {
    const n = Math.max(0, Math.round(Number(cents) || 0));
    const yuan = Math.floor(n / 100);
    const frac = n % 100;
    return String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        + '.' + (frac < 10 ? '0' + frac : String(frac));
}

function moneyText(cents) {
    return '¥' + formatCents(cents);
}

function signedText(cents) {
    return (cents < 0 ? '-' : '') + moneyText(Math.abs(cents));
}

function empty() {
    return { entries: [] };
}

// 任何外部数据（旧备份、脏 storage、手工编辑）进来都先过这一层
function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const seen = {};
    const entries = (Array.isArray(src.entries) ? src.entries : [])
        .slice(0, MAX_ENTRIES)
        .map(function (e) {
            const cents = Math.round(Number(e && e.cents) || 0);
            if (cents <= 0 || cents > CENTS_MAX) return null;
            const type = (e && e.type === 'income') ? 'income' : 'expense';
            const cat = String((e && e.category) || '');
            let id = String((e && e.id) || '');
            if (!id || seen[id]) id = entryId();
            seen[id] = true;
            return {
                id: id,
                type: type,
                cents: cents,
                category: CATEGORY_MAP[cat] ? cat : 'other',
                note: cleanText(e && e.note, NOTE_MAX),
                createdAt: Number((e && e.createdAt) || 0),
            };
        })
        .filter(function (e) { return !!e; });
    return { entries: entries };
}

function hasContent(book) {
    return normalize(book).entries.length > 0;
}

function addEntry(book, input) {
    const b = normalize(book);
    const src = input || {};
    const cents = parseAmount(src.amount);
    if (!cents || b.entries.length >= MAX_ENTRIES) return b;
    const cat = String(src.category || '');
    b.entries.push({
        id: entryId(),
        type: src.type === 'income' ? 'income' : 'expense',
        cents: cents,
        category: CATEGORY_MAP[cat] ? cat : 'other',
        note: cleanText(src.note, NOTE_MAX),
        createdAt: Date.now(),
    });
    return b;
}

function removeEntry(book, id) {
    const b = normalize(book);
    const key = String(id || '');
    b.entries = b.entries.filter(function (e) { return e.id !== key; });
    return b;
}

function categoriesOf(type) {
    const list = CATEGORIES[type === 'income' ? 'income' : 'expense'];
    return list.map(function (c) { return { id: c.id, label: c.label, glyph: c.glyph }; });
}

function categoryLabel(id) {
    const c = CATEGORY_MAP[String(id || '')];
    return c ? c.label : '其他';
}

function categoryGlyph(id) {
    const c = CATEGORY_MAP[String(id || '')];
    return c ? c.glyph : '他';
}

// 当日页面渲染用视图
function view(book) {
    const b = normalize(book);
    let income = 0;
    let expense = 0;
    const entries = b.entries.map(function (e) {
        if (e.type === 'income') income += e.cents;
        else expense += e.cents;
        return {
            id: e.id,
            type: e.type,
            cents: e.cents,
            note: e.note,
            label: categoryLabel(e.category),
            glyph: categoryGlyph(e.category),
            amountText: formatCents(e.cents),
            sign: e.type === 'income' ? '+' : '-',
            cls: e.type === 'income' ? 'money-in' : 'money-out',
        };
    });
    const balance = income - expense;
    return {
        entries: entries,
        count: entries.length,
        incomeCents: income,
        expenseCents: expense,
        balanceCents: balance,
        incomeText: moneyText(income),
        expenseText: moneyText(expense),
        balanceText: signedText(balance),
    };
}

// ---------- 回看页汇总 ----------
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

function periodRange(period, today) {
    if (period === 'year') {
        return {
            start: today.slice(0, 4) + '-01-01',
            end: today,
            unit: '年',
            label: '本年',
            kind: 'year',
        };
    }
    if (period === 'month') {
        return {
            start: today.slice(0, 7) + '-01',
            end: today,
            unit: '月',
            label: '本月',
            kind: 'month',
        };
    }
    const wd = new Date(dayNumber(today) * 86400000).getUTCDay();
    const start = dateOfDay(dayNumber(today) - (wd === 0 ? 6 : wd - 1));
    return { start: start, end: today, unit: '周', label: '本周', kind: 'week' };
}

function buildSlots(range) {
    const slots = [];
    if (range.kind === 'week') {
        const names = ['一', '二', '三', '四', '五', '六', '日'];
        for (let i = 0; i < 7; i += 1) {
            const date = dateOfDay(dayNumber(range.start) + i);
            slots.push({ key: date, label: names[i], start: date, end: date });
        }
    } else if (range.kind === 'month') {
        const bounds = [[1, 7], [8, 14], [15, 21], [22, 28], [29, 31]];
        const prefix = range.start.slice(0, 7);
        bounds.forEach(function (b) {
            slots.push({
                key: b[0] + '-' + b[1],
                label: b[0] + '-' + b[1],
                start: prefix + '-' + pad(b[0]),
                end: prefix + '-' + pad(b[1]),
            });
        });
    } else {
        const prefix = range.start.slice(0, 4);
        for (let i = 1; i <= 12; i += 1) {
            const m = pad(i);
            slots.push({
                key: prefix + '-' + m,
                label: String(i),
                start: prefix + '-' + m + '-01',
                end: prefix + '-' + m + '-31',
            });
        }
    }
    return slots;
}

// 按所选周期（本周 / 本月 / 本年）汇总多天收支。
// 纯本地统计，只陈述节奏与构成，不评分、不排名、不作消费评价。
function summarize(records, period, nowDate) {
    const kind = period === 'month' || period === 'year' ? period : 'week';
    const today = String(nowDate || todayOf(new Date()));
    const range = periodRange(kind, today);

    const rows = [];
    (Array.isArray(records) ? records : []).forEach(function (r) {
        if (!r || !DATE_RE.test(String(r.date || ''))) return;
        if (r.date < range.start || r.date > range.end) return;
        normalize(r.moneyBook).entries.forEach(function (e) {
            rows.push({ date: r.date, entry: e });
        });
    });
    rows.sort(function (a, b) {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return (b.entry.createdAt || 0) - (a.entry.createdAt || 0);
    });

    let income = 0;
    let expense = 0;
    let incomeCount = 0;
    let expenseCount = 0;
    const daySet = {};
    const catMap = {};
    rows.forEach(function (row) {
        const e = row.entry;
        daySet[row.date] = true;
        if (e.type === 'income') {
            income += e.cents;
            incomeCount += 1;
        } else {
            expense += e.cents;
            expenseCount += 1;
            if (!catMap[e.category]) catMap[e.category] = 0;
            catMap[e.category] += e.cents;
        }
    });

    const catList = Object.keys(catMap).map(function (id) {
        return { id: id, label: categoryLabel(id), cents: catMap[id] };
    }).sort(function (a, b) { return b.cents - a.cents; });
    let byCategory = catList.slice(0, 5).map(function (c) {
        return {
            id: c.id,
            label: c.label,
            cents: c.cents,
            text: moneyText(c.cents),
            pct: expense ? Math.max(2, Math.round(c.cents * 100 / expense)) : 0,
        };
    });
    if (catList.length > 5) {
        let rest = 0;
        catList.slice(5).forEach(function (c) { rest += c.cents; });
        byCategory.push({
            id: '_rest',
            label: '其余',
            cents: rest,
            text: moneyText(rest),
            pct: expense ? Math.max(2, Math.round(rest * 100 / expense)) : 0,
        });
    }

    const slots = buildSlots(range);
    const slotMap = {};
    slots.forEach(function (s) { slotMap[s.key] = { expense: 0, income: 0 }; });
    rows.forEach(function (row) {
        const d = row.date;
        slots.forEach(function (s) {
            if (d >= s.start && d <= s.end) {
                if (row.entry.type === 'income') slotMap[s.key].income += row.entry.cents;
                else slotMap[s.key].expense += row.entry.cents;
            }
        });
    });
    let maxVal = 0;
    slots.forEach(function (s) {
        const v = slotMap[s.key];
        if (v.expense > maxVal) maxVal = v.expense;
        if (v.income > maxVal) maxVal = v.income;
    });
    const trend = slots.map(function (s) {
        const v = slotMap[s.key];
        return {
            label: s.label,
            expenseText: moneyText(v.expense),
            incomeText: moneyText(v.income),
            expenseH: maxVal && v.expense ? Math.max(6, Math.round(v.expense * 100 / maxVal)) : 0,
            incomeH: maxVal && v.income ? Math.max(6, Math.round(v.income * 100 / maxVal)) : 0,
        };
    });

    const recent = rows.slice(0, 6).map(function (row) {
        const e = row.entry;
        return {
            id: row.date + '_' + e.id,
            dateLabel: shortLabel(row.date),
            type: e.type,
            label: categoryLabel(e.category),
            note: e.note,
            sign: e.type === 'income' ? '+' : '-',
            text: formatCents(e.cents),
            amountText: (e.type === 'income' ? '+' : '-') + moneyText(e.cents),
        };
    });

    const balance = income - expense;
    let insight;
    if (!rows.length) {
        insight = '这一' + range.unit + '还没有收支记录，随手记一笔就好。';
    } else {
        insight = '这一' + range.unit + '记下 ' + rows.length + ' 笔（收入 ' + incomeCount
            + ' / 支出 ' + expenseCount + '），花了 ' + moneyText(expense)
            + '、进账 ' + moneyText(income) + '。';
        if (byCategory.length) insight += '支出里记下最多的是「' + byCategory[0].label + '」。';
    }

    const lines = [
        '收支 · 汇总（' + range.label + ' ' + shortLabel(range.start) + ' — ' + shortLabel(range.end) + '）',
        '共 ' + rows.length + ' 笔 · 有账 ' + Object.keys(daySet).length + ' 天',
        '支出 ' + moneyText(expense) + ' · 收入 ' + moneyText(income) + ' · 结余 ' + signedText(balance),
        insight,
        '',
    ];
    if (byCategory.length) {
        lines.push('【支出分类】');
        byCategory.forEach(function (c) {
            lines.push('  ' + c.label + '  ' + c.text + '  ' + c.pct + '%');
        });
        lines.push('');
    }
    if (recent.length) {
        lines.push('【最近几笔】');
        recent.forEach(function (r) {
            lines.push('  ' + r.dateLabel + '  ' + r.amountText + '  ' + r.label
                + (r.note ? '  ' + r.note : ''));
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
        incomeCount: incomeCount,
        expenseCount: expenseCount,
        days: Object.keys(daySet).length,
        incomeCents: income,
        expenseCents: expense,
        balanceCents: balance,
        incomeText: moneyText(income),
        expenseText: moneyText(expense),
        balanceText: signedText(balance),
        byCategory: byCategory,
        trend: trend,
        recent: recent,
        insight: insight,
        text: lines.join('\n'),
        note: '按所选周期汇总本机记下的收支，纯离线统计，不做语义分析。',
    };
}

module.exports = {
    MAX_ENTRIES: MAX_ENTRIES,
    NOTE_MAX: NOTE_MAX,
    CENTS_MAX: CENTS_MAX,
    CATEGORIES: CATEGORIES,
    parseAmount: parseAmount,
    formatCents: formatCents,
    moneyText: moneyText,
    signedText: signedText,
    empty: empty,
    normalize: normalize,
    hasContent: hasContent,
    addEntry: addEntry,
    removeEntry: removeEntry,
    categoriesOf: categoriesOf,
    categoryLabel: categoryLabel,
    categoryGlyph: categoryGlyph,
    view: view,
    summarize: summarize,
};
