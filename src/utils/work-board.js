// 九格手记 · 工作模块（任务框 + 工作感想）
// 纯函数模块：不直接读写 wx storage，持久化统一交给 utils/diary-store.js。
// 数据挂在当天日记记录的 workBoard 字段上，因此按日期天然分组，
// 与日记一起备份 / 导出 / 跨年回看，历史记录缺字段时视为空板，零迁移。

const TASK_MAX = 60;
const REFLECT_MAX = 500;
const MAX_TASKS = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 分类标签：写在任务文字末尾的 #标签。只认中文、字母、数字、下划线、短横，
// 单标签最多 12 字——够用又不至于把整句任务当成标签吃掉。
const TAG_MAX = 12;
// 未分类的筛选值：用保留串占位，避免和「全部」（空串）撞车
const UNTAGGED = '__untagged__';
const OPEN_CAP = 30;
const DONE_CAP = 30;
const REFLECT_CAP = 50;

let seq = 0;

function taskId() {
    seq += 1;
    return 't_' + Date.now().toString(36) + '_' + seq;
}

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\r/g, '')
        .trim()
        .slice(0, max);
}

// 每次新建实例，避免 /g 正则的 lastIndex 在多次调用间互相干扰
function tagRe() {
    return new RegExp('#([\\u4e00-\\u9fa5A-Za-z0-9_-]{1,' + TAG_MAX + '})', 'g');
}

// 从任务文字里抽出全部标签：去重、转小写（中文不受影响），保持书写顺序
function parseTags(text) {
    const s = String(text === undefined || text === null ? '' : text);
    const out = [];
    const seen = {};
    let m;
    const re = tagRe();
    while ((m = re.exec(s)) !== null) {
        const tag = m[1].toLowerCase().slice(0, TAG_MAX);
        if (!tag || seen[tag]) continue;
        seen[tag] = true;
        out.push(tag);
    }
    return out;
}

// 任务正文（去掉标签后的部分），用于列表里干净地显示
function stripTags(text) {
    const s = String(text === undefined || text === null ? '' : text);
    return s.replace(tagRe(), ' ').replace(/\s+/g, ' ').trim();
}

function tagOf(text) {
    const list = parseTags(text);
    return list.length ? list[0] : '';
}

function empty() {
    return { tasks: [], reflection: '' };
}

// 任何外部数据（旧备份、脏 storage、手工编辑）进来都先过这一层
function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const seen = {};
    const tasks = (Array.isArray(src.tasks) ? src.tasks : [])
        .slice(0, MAX_TASKS)
        .map(function (t) {
            const text = cleanText(t && t.text, TASK_MAX);
            if (!text) return null;
            let id = String((t && t.id) || '');
            if (!id || seen[id]) id = taskId();
            seen[id] = true;
            return {
                id: id,
                text: text,
                done: !!(t && t.done),
                createdAt: Number((t && t.createdAt) || 0),
            };
        })
        .filter(function (t) { return !!t; });
    return { tasks: tasks, reflection: cleanText(src.reflection, REFLECT_MAX) };
}

function hasContent(board) {
    const b = normalize(board);
    return b.tasks.length > 0 || b.reflection.length > 0;
}

function addTask(board, text) {
    const b = normalize(board);
    const t = cleanText(text, TASK_MAX);
    if (!t || b.tasks.length >= MAX_TASKS) return b;
    b.tasks.push({ id: taskId(), text: t, done: false, createdAt: Date.now() });
    return b;
}

function toggleTask(board, id) {
    const b = normalize(board);
    const key = String(id || '');
    b.tasks = b.tasks.map(function (t) {
        return t.id === key ? Object.assign({}, t, { done: !t.done }) : t;
    });
    return b;
}

function removeTask(board, id) {
    const b = normalize(board);
    const key = String(id || '');
    b.tasks = b.tasks.filter(function (t) { return t.id !== key; });
    return b;
}

function setReflection(board, text) {
    const b = normalize(board);
    b.reflection = cleanText(text, REFLECT_MAX);
    return b;
}

// 页面渲染用视图：完成任务带 work-task-done 类（删除线 + 浅色文字）
// text 保留原文（导出 / 汇总都靠它，含标签），title 是去掉标签的正文，
// tags 是解析出的标签数组——三处同时给，谁也不迁就谁。
function view(board) {
    const b = normalize(board);
    let done = 0;
    const tasks = b.tasks.map(function (t) {
        if (t.done) done += 1;
        const tags = parseTags(t.text);
        const title = stripTags(t.text);
        return Object.assign({}, t, {
            cls: t.done ? 'work-task-done' : '',
            title: title || t.text,
            tags: tags,
            tag: tags.length ? tags[0] : '',
        });
    });
    return {
        tasks: tasks,
        total: tasks.length,
        done: done,
        pct: tasks.length ? Math.round(done * 100 / tasks.length) : 0,
    };
}

function dateLabel(date) {
    const p = String(date || '').split('-');
    return Number(p[1]) + '月' + Number(p[2]) + '日';
}

function dayNumber(dateStr) {
    const p = String(dateStr).split('-');
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
}

function pad(n) {
    return n < 10 ? '0' + n : String(n);
}

function todayOf(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 周期区间：与 diary-store.weekStartDate 口径一致（周一为一周起点），
// 终点一律是「今天」，未来的日子不参与统计
function rangeOf(period, nowStr) {
    const p = period === 'month' || period === 'year' ? period : 'week';
    const parts = String(nowStr).split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    let start;
    if (p === 'week') {
        const base = new Date(y, m - 1, d);
        const wd = base.getDay();
        start = new Date(y, m - 1, d - (wd === 0 ? 6 : wd - 1));
    } else if (p === 'month') {
        start = new Date(y, m - 1, 1);
    } else {
        start = new Date(y, 0, 1);
    }
    return { period: p, start: todayOf(start), end: nowStr };
}

const PERIOD_WORD = { week: '本周', month: '本月', year: '本年' };

// 回看页「概览 · 工作」用：把一段日期里的任务与感想摊平成四个指标 +
// 标签分类 + 未完成 / 已完成两组清单 + 感想摘录。
// 任务状态取「最后一次落盘的样子」，不追历史变化——本机没存过中间态。
function digest(records, period, nowDate, tagFilter) {
    const nowStr = String(nowDate || todayOf(new Date()));
    const range = rangeOf(period, nowStr);
    const filter = String(tagFilter || '');

    const entries = (Array.isArray(records) ? records : [])
        .filter(function (r) {
            return r && typeof r.date === 'string' && DATE_RE.test(r.date)
                && r.date >= range.start && r.date <= range.end;
        })
        .sort(function (a, b) { return b.date.localeCompare(a.date); });

    let taskTotal = 0;
    let taskDone = 0;
    let reflectCount = 0;
    let reflectChars = 0;
    const tagMap = {};
    const tagOrder = [];
    const openAll = [];
    const doneAll = [];
    const reflections = [];

    entries.forEach(function (entry) {
        const board = normalize(entry.workBoard);
        const v = view(board);
        taskTotal += v.total;
        taskDone += v.done;

        if (board.reflection) {
            reflectCount += 1;
            reflectChars += board.reflection.length;
            reflections.push({
                date: entry.date,
                dateLabel: dateLabel(entry.date),
                text: board.reflection,
                chars: board.reflection.length,
            });
        }

        v.tasks.forEach(function (t) {
            // 标签计数与筛选无关：chips 上的数字要反映整期，不能跟着筛选缩水
            const keys = t.tags.length ? t.tags : [UNTAGGED];
            keys.forEach(function (k) {
                if (!tagMap[k]) {
                    tagMap[k] = {
                        tag: k,
                        key: k === UNTAGGED ? 'untagged' : 'tag-' + k,
                        label: k === UNTAGGED ? '未分类' : '#' + k,
                        total: 0,
                        done: 0,
                        open: 0,
                    };
                    tagOrder.push(k);
                }
                const row = tagMap[k];
                row.total += 1;
                if (t.done) row.done += 1;
                else row.open += 1;
            });

            if (filter) {
                const hit = filter === UNTAGGED
                    ? t.tags.length === 0
                    : t.tags.indexOf(filter) >= 0;
                if (!hit) return;
            }

            const item = {
                id: t.id,
                date: entry.date,
                dateLabel: dateLabel(entry.date),
                title: t.title,
                tag: t.tag,
                tags: t.tags,
                done: t.done,
            };
            if (t.done) doneAll.push(item);
            else openAll.push(item);
        });
    });

    // 标签排序：条数多的在前，未分类永远垫底（它不是分类，是「还没分类」）
    const tags = tagOrder
        .map(function (k) { return tagMap[k]; })
        .sort(function (a, b) {
            const an = a.tag === UNTAGGED ? 1 : 0;
            const bn = b.tag === UNTAGGED ? 1 : 0;
            if (an !== bn) return an - bn;
            if (b.total !== a.total) return b.total - a.total;
            return a.label.localeCompare(b.label);
        })
        .map(function (row) {
            return Object.assign({}, row, {
                pct: row.total ? Math.round(row.done * 100 / row.total) : 0,
            });
        });

    const filters = [{
        key: 'all',
        tag: '',
        label: '全部',
        total: taskTotal,
        active: !filter,
    }].concat(tags.map(function (row) {
        return {
            key: row.key,
            tag: row.tag,
            label: row.label,
            total: row.total,
            active: row.tag === filter,
        };
    }));

    const openMore = Math.max(0, openAll.length - OPEN_CAP);
    const doneMore = Math.max(0, doneAll.length - DONE_CAP);
    const reflectMore = Math.max(0, reflections.length - REFLECT_CAP);

    const openTasks = openAll.slice(0, OPEN_CAP);
    const doneTasks = doneAll.slice(0, DONE_CAP);
    const pct = taskTotal ? Math.round(taskDone * 100 / taskTotal) : 0;

    // 一句话结论：先说欠账，再说分类分布；没数据就指引到首页
    const word = PERIOD_WORD[range.period];
    // 并列第一的标签一起点名，别让排序把「工作 / 紧急 / 现场 各 1 项」说成只有工作最多
    const ranked = tags.filter(function (r) { return r.tag !== UNTAGGED; });
    const topTagText = ranked.length
        ? ranked.filter(function (r) { return r.total === ranked[0].total; })
            .slice(0, 2)
            .map(function (r) { return String.fromCharCode(12300) + r.tag + String.fromCharCode(12301); })
            .join('') + '最多（' + ranked[0].total + ' 项）'
        : '';
    let insight;
    if (!taskTotal && !reflectCount) {
        insight = word + '还没有工作记录，点首页「工作」格写一条任务就好。';
    } else if (!taskTotal) {
        insight = word + '记了 ' + reflectCount + ' 篇工作感想，没建任务；随手写一条会更清楚推进到哪了。';
    } else {
        insight = word + '记下 ' + taskTotal + ' 项任务，完成 ' + taskDone + ' 项（' + pct + '%）';
        if (openAll.length) insight += '，还有 ' + openAll.length + ' 项没勾掉';
        if (topTagText) insight += '；标签' + topTagText;
        insight += '。';
    }

    return {
        period: range.period,
        periodWord: word,
        start: range.start,
        end: range.end,
        empty: taskTotal === 0 && reflectCount === 0,
        taskTotal: taskTotal,
        taskDone: taskDone,
        taskOpen: taskTotal - taskDone,
        pct: pct,
        reflectCount: reflectCount,
        reflectChars: reflectChars,
        filters: filters,
        tags: tags,
        openTasks: openTasks,
        doneTasks: doneTasks,
        openMore: openMore,
        doneMore: doneMore,
        reflections: reflections.slice(0, REFLECT_CAP),
        reflectMore: reflectMore,
        activeTag: filter,
        insight: insight,
        note: '口径：该周期内记下的任务，按最后一次落盘的状态统计；标签写在任务文字里，形如「改图纸 #现场」。',
    };
}

// 常用标签池：首页输入框下方给几个可点的标签，省得手机上敲 #
function tagPool(records, limit) {
    const cap = limit > 0 ? limit : 6;
    const map = {};
    const order = [];
    (Array.isArray(records) ? records : []).forEach(function (r) {
        const board = normalize(r && r.workBoard);
        board.tasks.forEach(function (t) {
            parseTags(t.text).forEach(function (tag) {
                if (!map[tag]) {
                    map[tag] = { tag: tag, label: '#' + tag, count: 0, last: 0 };
                    order.push(tag);
                }
                map[tag].count += 1;
                const stamp = dayNumber(r.date);
                if (stamp > map[tag].last) map[tag].last = stamp;
            });
        });
    });
    return order
        .map(function (k) { return map[k]; })
        .sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return b.last - a.last;
        })
        .slice(0, cap);
}

// 把多天的工作感想汇总成一份可回看、可复制的「工作感想」。
// 口径：只汇总写过感想的日期；任务作为当天的附证一并带上。
// 纯本地统计，不做语义分析，数据不离开本机。
function summarize(records, nowDate) {
    const allBoards = (Array.isArray(records) ? records : [])
        .filter(function (r) { return r && typeof r.date === 'string' && DATE_RE.test(r.date); })
        .map(function (r) {
            return { date: r.date, board: normalize(r.workBoard) };
        })
        .sort(function (a, b) { return b.date.localeCompare(a.date); });

    let taskDone = 0;
    let taskTotal = 0;
    let taskOnlyDays = 0;
    let chars = 0;
    const items = [];

    allBoards.forEach(function (entry) {
        const v = view(entry.board);
        taskDone += v.done;
        taskTotal += v.total;
        if (!entry.board.reflection) {
            if (v.total) taskOnlyDays += 1;
            return;
        }
        chars += entry.board.reflection.length;
        items.push({
            date: entry.date,
            dateLabel: dateLabel(entry.date),
            text: entry.board.reflection,
            chars: entry.board.reflection.length,
            tasks: v.tasks,
            taskDone: v.done,
            taskTotal: v.total,
            hasTasks: v.total > 0,
        });
    });

    const todayStr = String(nowDate || todayOf(new Date()));
    const todayNum = dayNumber(todayStr);
    const recent = items.filter(function (x) {
        const diff = todayNum - dayNumber(x.date);
        return diff >= 0 && diff < 30;
    });
    let recentTaskDone = 0;
    let recentTaskTotal = 0;
    allBoards.forEach(function (entry) {
        const diff = todayNum - dayNumber(entry.date);
        if (diff < 0 || diff >= 30) return;
        const v = view(entry.board);
        recentTaskDone += v.done;
        recentTaskTotal += v.total;
    });

    let insight;
    if (!items.length) {
        insight = '还没有写过工作感想，今天写一句就好。';
    } else if (!recent.length) {
        insight = '已经记下 ' + items.length + ' 篇工作感想，最近 30 天还没写，随手补一句也好。';
    } else {
        insight = '近 30 天记了 ' + recent.length + ' 篇工作感想，完成任务 '
            + recentTaskDone + ' / ' + recentTaskTotal + ' 项。最近一篇是 '
            + items[0].dateLabel + '：「' + items[0].text.slice(0, 22)
            + (items[0].text.length > 22 ? '…' : '') + '」';
    }

    // 按月倒序分组，避免几十天感想摊成一条长列表
    const monthMap = {};
    const monthOrder = [];
    items.forEach(function (item) {
        const key = item.date.slice(0, 7);
        if (!monthMap[key]) {
            monthMap[key] = [];
            monthOrder.push(key);
        }
        monthMap[key].push(item);
    });
    const months = monthOrder.map(function (key) {
        const p = key.split('-');
        return {
            key: key,
            label: Number(p[0]) + ' 年 ' + Number(p[1]) + ' 月',
            items: monthMap[key],
        };
    });

    const lines = [
        '工作感想 · 汇总',
        '共 ' + items.length + ' 篇 · 累计 ' + chars + ' 字 · 完成任务 ' + taskDone + ' / ' + taskTotal + ' 项',
        insight,
        '',
    ];
    months.forEach(function (m) {
        lines.push('【' + m.label + '】');
        m.items.forEach(function (item) {
            lines.push(item.dateLabel + (item.hasTasks ? ' · 完成 ' + item.taskDone + '/' + item.taskTotal + ' 项' : ''));
            if (item.hasTasks) {
                lines.push('  任务：' + item.tasks.map(function (t) {
                    return (t.done ? '✓ ' : '○ ') + t.text;
                }).join('  '));
            }
            lines.push('  感想：' + item.text.split('\n').join(' / '));
        });
        lines.push('');
    });
    lines.push('—— 九格手记 · 数据只存在本机');
    const text = lines.join('\n');

    return {
        empty: items.length === 0,
        count: items.length,
        chars: chars,
        taskDone: taskDone,
        taskTotal: taskTotal,
        taskOnlyDays: taskOnlyDays,
        recentCount: recent.length,
        months: months,
        items: items,
        insight: insight,
        text: text,
        note: '按日期汇总本机写下的工作感想，纯离线统计，不做语义分析。',
    };
}

module.exports = {
    TASK_MAX: TASK_MAX,
    REFLECT_MAX: REFLECT_MAX,
    MAX_TASKS: MAX_TASKS,
    TAG_MAX: TAG_MAX,
    UNTAGGED: UNTAGGED,
    normalize: normalize,
    empty: empty,
    hasContent: hasContent,
    addTask: addTask,
    toggleTask: toggleTask,
    removeTask: removeTask,
    setReflection: setReflection,
    parseTags: parseTags,
    stripTags: stripTags,
    tagOf: tagOf,
    view: view,
    dateLabel: dateLabel,
    rangeOf: rangeOf,
    digest: digest,
    tagPool: tagPool,
    summarize: summarize,
};
