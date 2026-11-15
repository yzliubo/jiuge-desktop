'use strict';
// 学习成长模块 —— 三种学习活动的**时间尺度不同**，所以拆成三张独立表。
//
// 为什么不是一张表加个 type 字段：
//   · 考试考证有截止日、多科目、一个结果（分数/通过与不通过），要的是倒计时与加权进度；
//   · 技能学习没有截止日，有的是等级、里程碑与练习时长，要的是「练了多少、还差哪一步」；
//   · 主题阅读是一批书围绕一个主题，要的是书单状态、页数推进与摘录。
//   三者的「进度」根本不是同一个东西：科目完成率 / 里程碑达成率 / 页数。混成一个
//   done/total 只会得到三个都不准的数字。
//
// 为什么不用 utils/study-log.js 的 md_study_library：
//   那个模型只有「标题 + done/total + 主题」，且整个 utils 目录是与小程序源项目
//   逐字节一致的等价基线（verify 第 1 条按 SHA256 对拍），改不动。旧库通过
//   importLegacy 一次性搬进来：书/影/画 → 主题阅读的素材条目，课 → 技能学习。
//
// 存 md_growth 单键（主进程仓储读写），导出时由主进程注入 growth 段。
// 纯函数：所有「今天」由调用方传入，便于测试。

const MAX_EXAMS = 20;
const MAX_SKILLS = 30;
const MAX_THEMES = 20;
const MAX_SUBJECTS = 20;
const MAX_MILESTONES = 30;
const MAX_PRACTICES = 90;
const MAX_BOOKS = 60;
const MAX_QUOTES = 40;
const MAX_ATTEMPTS = 12;
const MAX_CLEARED = 10;

const TITLE_MAX = 40;
const ORG_MAX = 20;
const AUTHOR_MAX = 24;
const NOTE_MAX = 200;
const SUBJECT_MAX = 20;
const MILESTONE_MAX = 30;
const BOOK_TITLE_MAX = 50;
const QUOTE_MAX = 200;
const UNIT_MAX = 4;
const BLOCKER_MAX = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 考试状态：报名前 / 已报名 / 已通过 / 未通过
const EXAM_STATUS = [
    { key: 'plan', label: '备考中' },
    { key: 'registered', label: '已报名' },
    { key: 'passed', label: '已通过' },
    { key: 'failed', label: '未通过' }
];
const EXAM_STATUS_LABEL = {};
EXAM_STATUS.forEach(function (s) { EXAM_STATUS_LABEL[s.key] = s.label; });

// 技能等级：五级够用——再细分，自评就会变成编数字
const LEVELS = [
    { level: 1, label: '初识', hint: '知道它是什么' },
    { level: 2, label: '入门', hint: '照着做能做完' },
    { level: 3, label: '熟练', hint: '不看教程也能做' },
    { level: 4, label: '精通', hint: '能改、能优化' },
    { level: 5, label: '传授', hint: '能教别人、能定标准' }
];
function levelLabel(n) {
    const hit = LEVELS.filter(function (l) { return l.level === n; })[0];
    return hit ? hit.label : '未定级';
}

const BOOK_STATUS = [
    { key: 'todo', label: '待读' },
    { key: 'reading', label: '在读' },
    { key: 'done', label: '读完' }
];
const BOOK_STATUS_LABEL = {};
BOOK_STATUS.forEach(function (b) { BOOK_STATUS_LABEL[b.key] = b.label; });

// 考试错因（V3.9）：**固定枚举，不是自由文本**。
// 自由文本写三次也不会重样，统计不出「你总是栽在哪」；只有归类才能跨次比较——
// 两次都栽在「计算失误」，说明该练手算，而不是再刷一遍题。
const EXAM_CAUSES = [
    { key: 'concept', label: '概念没懂' },
    { key: 'calc', label: '计算失误' },
    { key: 'misread', label: '审题偏差' },
    { key: 'time', label: '时间不够' },
    { key: 'material', label: '资料不对' },
    { key: 'practice', label: '练得不够' },
    { key: 'state', label: '状态不好' }
];
const EXAM_CAUSE_LABEL = {};
EXAM_CAUSES.forEach(function (c) { EXAM_CAUSE_LABEL[c.key] = c.label; });

// 卡点挂多久算「不是练得少，是方法不对」：两周。少于两周就催人换方法，只会打断刚起效的节奏
const BLOCKER_STALE_DAYS = 14;

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
function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

// 光靠正则不够：「2026-13-40」也是 4-2-2 位数字，必须能回读成真实日期
function validDate(v) {
    const s = clean(v, 10);
    if (!DATE_RE.test(s)) return '';
    const p = s.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (d.getFullYear() !== Number(p[0]) || d.getMonth() !== Number(p[1]) - 1 || d.getDate() !== Number(p[2])) return '';
    return s;
}

function diffDays(from, to) {
    if (!validDate(from) || !validDate(to)) return 0;
    const a = from.split('-').map(Number);
    const b = to.split('-').map(Number);
    const x = Date.UTC(a[0], a[1] - 1, a[2]);
    const y = Date.UTC(b[0], b[1] - 1, b[2]);
    return Math.round((y - x) / 86400000);
}

// 日期平移：周统计要「今天往前 6 天」，不引第三方库，用 UTC 算再格式化回来
function shiftDate(date, days) {
    if (!validDate(date)) return '';
    const p = date.split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]) + days * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function pctOf(done, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round(done * 100 / total)));
}

// ---------- 空态 ----------
function empty() {
    return { exams: [], skills: [], themes: [], version: 1 };
}

// ---------- normalize：任何外部数据进来都先过这一层 ----------
function normSubject(raw) {
    const s = raw || {};
    const title = clean(s.title, SUBJECT_MAX);
    if (!title) return null;
    const total = num(s.total, 1, 9999, 10);
    return {
        id: str(s.id) || newId('sub'),
        title: title,
        unit: clean(s.unit, UNIT_MAX) || '章',
        total: total,
        done: num(s.done, 0, total, 0)
    };
}

function normSubjects(raw) {
    const seen = {};
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_SUBJECTS).map(function (s) {
        const sub = normSubject(s);
        if (!sub) return null;
        if (seen[sub.id]) sub.id = newId('sub');
        seen[sub.id] = true;
        return sub;
    }).filter(function (x) { return !!x; });
}

// 一次考完的记录（V3.9）。**这部分是只增不改的历史**：重考只清当前分数，
// 不清 attempts——否则「上次为什么没过」这条唯一有价值的复盘线索，会在重置那一刻消失。
function normCauses(raw) {
    const seen = {};
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (k) {
        const key = str(k);
        if (!EXAM_CAUSE_LABEL[key] || seen[key]) return;
        seen[key] = true;
        out.push(key);
    });
    return out.slice(0, 4);
}

function normAttempts(raw) {
    const seen = {};
    return (Array.isArray(raw) ? raw : []).slice(-MAX_ATTEMPTS).map(function (a) {
        const score = num(a && a.score, 0, 1000, 0);
        const passLine = num(a && a.passLine, 0, 1000, 0);
        if (!score && !passLine) return null;
        let id = str(a && a.id);
        if (!id || seen[id]) id = newId('at');
        seen[id] = true;
        return {
            id: id,
            date: validDate(a && a.date),
            score: score,
            passLine: passLine,
            passed: score > 0 && passLine > 0 ? score >= passLine : false,
            causes: normCauses(a && a.causes)
        };
    }).filter(function (x) { return !!x; });
}

function normalizeExam(raw) {
    const e = raw || {};
    const title = clean(e.title, TITLE_MAX);
    if (!title) return null;
    const examDate = validDate(e.examDate);
    const subjects = normSubjects(e.subjects);
    let status = 'plan';
    if (e.status === 'registered') status = 'registered';
    else if (e.status === 'passed') status = 'passed';
    else if (e.status === 'failed') status = 'failed';
    const score = num(e.score, 0, 1000, 0);
    const passLine = num(e.passLine, 0, 1000, 0);
    return {
        id: str(e.id) || newId('ex'),
        title: title,
        org: clean(e.org, ORG_MAX),
        examDate: examDate,
        enrollDate: validDate(e.enrollDate),
        status: status,
        score: score,
        passLine: passLine,
        subjects: subjects,
        attempts: normAttempts(e.attempts),
        note: clean(e.note, NOTE_MAX),
        createdAt: Number(e.createdAt) || Date.now(),
        updatedAt: Number(e.updatedAt) || Date.now()
    };
}

function normMilestones(raw) {
    const seen = {};
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_MILESTONES).map(function (m) {
        const title = clean(m && m.title, MILESTONE_MAX);
        if (!title) return null;
        let id = str(m && m.id);
        if (!id || seen[id]) id = newId('ms');
        seen[id] = true;
        const done = !!(m && m.done);
        return {
            id: id,
            title: title,
            done: done,
            doneAt: done ? (Number(m && m.doneAt) || Date.now()) : 0
        };
    }).filter(function (x) { return !!x; });
}

function normPractices(raw) {
    const seen = {};
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_PRACTICES).map(function (p) {
        const date = validDate(p && p.date);
        if (!date) return null;
        let id = str(p && p.id);
        if (!id || seen[id]) id = newId('pr');
        seen[id] = true;
        return {
            id: id,
            date: date,
            minutes: num(p && p.minutes, 1, 1440, 30),
            note: clean(p && p.note, 60)
        };
    }).filter(function (x) { return !!x; });
}

// 已解决的卡点（V3.9）：卡点如果只有一个「当前值」，解决的那一刻就被覆盖，
// 「上次那个坑是怎么爬出来的」下次还得重走一遍。所以解决时移进这里留档。
function normCleared(raw) {
    const seen = {};
    return (Array.isArray(raw) ? raw : []).slice(-MAX_CLEARED).map(function (c) {
        const text = clean(c && c.text, BLOCKER_MAX);
        if (!text) return null;
        let id = str(c && c.id);
        if (!id || seen[id]) id = newId('cl');
        seen[id] = true;
        return {
            id: id,
            text: text,
            since: validDate(c && c.since),
            clearedAt: validDate(c && c.clearedAt)
        };
    }).filter(function (x) { return !!x; });
}

function normalizeSkill(raw) {
    const k = raw || {};
    const title = clean(k.title, TITLE_MAX);
    if (!title) return null;
    const level = num(k.level, 1, 5, 1);
    const blocker = clean(k.blocker, BLOCKER_MAX);
    return {
        id: str(k.id) || newId('sk'),
        title: title,
        level: level,
        targetLevel: Math.max(level, num(k.targetLevel, 1, 5, Math.min(5, level + 1))),
        milestones: normMilestones(k.milestones),
        practices: normPractices(k.practices),
        // 卡点必须带开始日：只写「卡在哪」而不知道该卡的年龄，就分不清
        // 「刚遇到」和「卡了一个月」——后者才是该换方法的信号
        blocker: blocker,
        blockerSince: blocker ? validDate(k.blockerSince) : '',
        nextUp: clean(k.nextUp, BLOCKER_MAX),
        cleared: normCleared(k.cleared),
        note: clean(k.note, NOTE_MAX),
        createdAt: Number(k.createdAt) || Date.now(),
        updatedAt: Number(k.updatedAt) || Date.now()
    };
}

function normQuotes(raw) {
    const seen = {};
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_QUOTES).map(function (q) {
        const text = clean(q && q.text, QUOTE_MAX);
        if (!text) return null;
        let id = str(q && q.id);
        if (!id || seen[id]) id = newId('q');
        seen[id] = true;
        return {
            id: id,
            text: text,
            page: num(q && q.page, 0, 99999, 0),
            createdAt: Number(q && q.createdAt) || Date.now()
        };
    }).filter(function (x) { return !!x; });
}

function normBooks(raw) {
    const seen = {};
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_BOOKS).map(function (b) {
        const title = clean(b && b.title, BOOK_TITLE_MAX);
        if (!title) return null;
        let id = str(b && b.id);
        if (!id || seen[id]) id = newId('bk');
        seen[id] = true;
        const total = num(b && b.total, 1, 9999, 300);
        let status = 'todo';
        if (b && b.status === 'reading') status = 'reading';
        else if (b && b.status === 'done') status = 'done';
        const done = status === 'done' ? total : num(b && b.done, 0, total, 0);
        const rating = num(b && b.rating, 0, 5, 0);
        return {
            id: id,
            title: title,
            author: clean(b && b.author, AUTHOR_MAX),
            total: total,
            done: done,
            unit: clean(b && b.unit, UNIT_MAX) || '页',
            status: status,
            rating: rating,
            quotes: normQuotes(b && b.quotes),
            note: clean(b && b.note, NOTE_MAX),
            startedAt: validDate(b && b.startedAt),
            finishedAt: status === 'done' ? validDate(b && b.finishedAt) : ''
        };
    }).filter(function (x) { return !!x; });
}

function normalizeTheme(raw) {
    const t = raw || {};
    const title = clean(t.title, TITLE_MAX);
    if (!title) return null;
    return {
        id: str(t.id) || newId('th'),
        title: title,
        note: clean(t.note, NOTE_MAX),
        books: normBooks(t.books),
        createdAt: Number(t.createdAt) || Date.now(),
        updatedAt: Number(t.updatedAt) || Date.now()
    };
}

function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const seen = {};
    function take(list, fn, limit) {
        return (Array.isArray(list) ? list : []).slice(0, limit).map(function (x) {
            const row = fn(x);
            if (!row) return null;
            if (seen[row.id]) row.id = newId('dup');
            seen[row.id] = true;
            return row;
        }).filter(function (x) { return !!x; });
    }
    return {
        exams: take(src.exams, normalizeExam, MAX_EXAMS),
        skills: take(src.skills, normalizeSkill, MAX_SKILLS),
        themes: take(src.themes, normalizeTheme, MAX_THEMES),
        version: 1
    };
}

function meta() {
    return {
        examStatus: EXAM_STATUS,
        examCauses: EXAM_CAUSES,
        levels: LEVELS,
        bookStatus: BOOK_STATUS,
        blockerStaleDays: BLOCKER_STALE_DAYS,
        limits: {
            exams: MAX_EXAMS, skills: MAX_SKILLS, themes: MAX_THEMES,
            subjects: MAX_SUBJECTS, milestones: MAX_MILESTONES, practices: MAX_PRACTICES,
            books: MAX_BOOKS, quotes: MAX_QUOTES, attempts: MAX_ATTEMPTS, cleared: MAX_CLEARED
        }
    };
}

// ---------- 考试考证 ----------
function addExam(state, patch) {
    const s = normalize(state);
    const p = patch || {};
    const title = clean(p.title, TITLE_MAX);
    if (!title || s.exams.length >= MAX_EXAMS) return s;
    s.exams.push(normalizeExam({
        id: newId('ex'),
        title: title,
        org: p.org,
        examDate: p.examDate,
        enrollDate: p.enrollDate,
        status: p.status,
        note: p.note,
        createdAt: Date.now(),
        updatedAt: Date.now()
    }));
    return s;
}

function findExam(s, id) {
    const key = str(id);
    return s.exams.filter(function (e) { return e.id === key; })[0] || null;
}

function updateExam(state, id, patch) {
    const s = normalize(state);
    const e = findExam(s, id);
    if (!e) return s;
    const p = patch || {};
    if (p.title !== undefined) {
        const title = clean(p.title, TITLE_MAX);
        if (title) e.title = title;
    }
    if (p.org !== undefined) e.org = clean(p.org, ORG_MAX);
    if (p.examDate !== undefined) e.examDate = validDate(p.examDate);
    if (p.enrollDate !== undefined) e.enrollDate = validDate(p.enrollDate);
    if (p.status !== undefined && EXAM_STATUS_LABEL[p.status]) e.status = p.status;
    if (p.score !== undefined) e.score = num(p.score, 0, 1000, e.score);
    if (p.passLine !== undefined) e.passLine = num(p.passLine, 0, 1000, e.passLine);
    if (p.note !== undefined) e.note = clean(p.note, NOTE_MAX);
    e.updatedAt = Date.now();
    return s;
}

function removeExam(state, id) {
    const s = normalize(state);
    s.exams = s.exams.filter(function (e) { return e.id !== str(id); });
    return s;
}

function addSubject(state, examId, patch) {
    const s = normalize(state);
    const e = findExam(s, examId);
    const p = patch || {};
    const sub = normSubject({ title: p.title, total: p.total, unit: p.unit });
    if (!e || !sub || e.subjects.length >= MAX_SUBJECTS) return s;
    e.subjects.push(sub);
    e.updatedAt = Date.now();
    return s;
}

function updateSubject(state, examId, subId, patch) {
    const s = normalize(state);
    const e = findExam(s, examId);
    if (!e) return s;
    const sub = e.subjects.filter(function (x) { return x.id === str(subId); })[0];
    if (!sub) return s;
    const p = patch || {};
    if (p.title !== undefined) {
        const title = clean(p.title, SUBJECT_MAX);
        if (title) sub.title = title;
    }
    if (p.total !== undefined) {
        sub.total = num(p.total, 1, 9999, sub.total);
        sub.done = Math.min(sub.done, sub.total);
    }
    if (p.done !== undefined) sub.done = num(p.done, 0, sub.total, sub.done);
    e.updatedAt = Date.now();
    return s;
}

function removeSubject(state, examId, subId) {
    const s = normalize(state);
    const e = findExam(s, examId);
    if (!e) return s;
    e.subjects = e.subjects.filter(function (x) { return x.id !== str(subId); });
    e.updatedAt = Date.now();
    return s;
}

// 记成绩：分数与合格线都填了才判定「通过/未通过」，只有一个数不作数
// 记成绩（V3.9：可带错因）。每次记都进 attempts，等于给这场考试攒一份「历次成绩」；
// 同一天同一组分数重复点保存，只更新那一条的错因，不新增——手滑点两下不该变成考了两次。
// date 是给测试与补记用的（与 board(state, today) 同口径），不传就用今天。
function setExamResult(state, id, score, passLine, causes, date) {
    const s = normalize(state);
    const e = findExam(s, id);
    if (!e) return s;
    e.score = num(score, 0, 1000, 0);
    e.passLine = num(passLine, 0, 1000, 0);
    if (e.score > 0 && e.passLine > 0) {
        e.status = e.score >= e.passLine ? 'passed' : 'failed';
    } else if (e.score === 0 && e.passLine === 0) {
        e.status = 'registered';
    }
    if (e.score || e.passLine) {
        const day = validDate(date) || todayOf(new Date());
        const last = e.attempts[e.attempts.length - 1];
        const same = last && last.date === day && last.score === e.score && last.passLine === e.passLine;
        if (same) {
            if (causes !== undefined) last.causes = normCauses(causes);
        } else {
            if (e.attempts.length >= MAX_ATTEMPTS) e.attempts.shift();
            e.attempts.push({
                id: newId('at'),
                date: day,
                score: e.score,
                passLine: e.passLine,
                passed: e.score > 0 && e.passLine > 0 ? e.score >= e.passLine : false,
                causes: normCauses(causes)
            });
        }
    }
    e.updatedAt = Date.now();
    return s;
}

// 事后补记 / 更正错因：只作用于**最近一次**作答。
// 单独开一条路由而不是揉进 setExamResult，是为了让「改错因」不必重填分数——
// 重填分数会走「同日同分才更新」的判定，隔天补记就凭空多出一次考试。
function setExamCauses(state, id, causes) {
    const s = normalize(state);
    const e = findExam(s, id);
    if (!e) return s;
    const last = e.attempts[e.attempts.length - 1];
    if (!last) return s;
    last.causes = normCauses(causes);
    e.updatedAt = Date.now();
    return s;
}

// 没通过就再来一次：科目进度归零，日期清空，其余（科目结构、机构）保留。
// **attempts 不清**——「上次 58 分、差 2 分、死在计算」是重考唯一的方向感来源。
function retakeExam(state, id) {
    const s = normalize(state);
    const e = findExam(s, id);
    if (!e) return s;
    e.status = 'plan';
    e.score = 0;
    e.passLine = 0;
    e.examDate = '';
    e.enrollDate = '';
    e.subjects.forEach(function (sub) { sub.done = 0; });
    e.updatedAt = Date.now();
    return s;
}

// ---------- 技能学习 ----------
function addSkill(state, patch) {
    const s = normalize(state);
    const p = patch || {};
    const title = clean(p.title, TITLE_MAX);
    if (!title || s.skills.length >= MAX_SKILLS) return s;
    s.skills.push(normalizeSkill({
        id: newId('sk'),
        title: title,
        level: p.level,
        targetLevel: p.targetLevel,
        note: p.note,
        createdAt: Date.now(),
        updatedAt: Date.now()
    }));
    return s;
}

function findSkill(s, id) {
    const key = str(id);
    return s.skills.filter(function (k) { return k.id === key; })[0] || null;
}

function updateSkill(state, id, patch) {
    const s = normalize(state);
    const k = findSkill(s, id);
    if (!k) return s;
    const p = patch || {};
    if (p.title !== undefined) {
        const title = clean(p.title, TITLE_MAX);
        if (title) k.title = title;
    }
    if (p.level !== undefined) k.level = num(p.level, 1, 5, k.level);
    if (p.targetLevel !== undefined) k.targetLevel = Math.max(k.level, num(p.targetLevel, 1, 5, k.targetLevel));
    if (p.nextUp !== undefined) k.nextUp = clean(p.nextUp, BLOCKER_MAX);
    if (p.note !== undefined) k.note = clean(p.note, NOTE_MAX);
    k.updatedAt = Date.now();
    return s;
}

function removeSkill(state, id) {
    const s = normalize(state);
    s.skills = s.skills.filter(function (k) { return k.id !== str(id); });
    return s;
}

function addMilestone(state, skillId, title) {
    const s = normalize(state);
    const k = findSkill(s, skillId);
    const text = clean(title, MILESTONE_MAX);
    if (!k || !text || k.milestones.length >= MAX_MILESTONES) return s;
    k.milestones.push({ id: newId('ms'), title: text, done: false, doneAt: 0 });
    k.updatedAt = Date.now();
    return s;
}

function toggleMilestone(state, skillId, msId) {
    const s = normalize(state);
    const k = findSkill(s, skillId);
    if (!k) return s;
    k.milestones.forEach(function (m) {
        if (m.id !== str(msId)) return;
        m.done = !m.done;
        m.doneAt = m.done ? Date.now() : 0;
    });
    k.updatedAt = Date.now();
    return s;
}

function removeMilestone(state, skillId, msId) {
    const s = normalize(state);
    const k = findSkill(s, skillId);
    if (!k) return s;
    k.milestones = k.milestones.filter(function (m) { return m.id !== str(msId); });
    k.updatedAt = Date.now();
    return s;
}

// 练习记录：技能与考试最大的差别就在这里——它不追「完成」，追「练了多少」
function addPractice(state, skillId, patch) {
    const s = normalize(state);
    const k = findSkill(s, skillId);
    if (!k) return s;
    const p = patch || {};
    const date = validDate(p.date) || todayOf(new Date());
    const minutes = num(p.minutes, 1, 1440, 30);
    // 同一天同一条技能只留一条记录：一天练了三段就合计，不做三段流水
    const hit = k.practices.filter(function (x) { return x.date === date; })[0];
    if (hit) {
        hit.minutes = Math.min(1440, hit.minutes + minutes);
        if (p.note !== undefined) hit.note = clean(p.note, 60);
    } else {
        if (k.practices.length >= MAX_PRACTICES) k.practices.shift();
        k.practices.push({ id: newId('pr'), date: date, minutes: minutes, note: clean(p.note, 60) });
    }
    k.practices.sort(function (a, b) { return a.date.localeCompare(b.date); });
    k.updatedAt = Date.now();
    return s;
}

function removePractice(state, skillId, practiceId) {
    const s = normalize(state);
    const k = findSkill(s, skillId);
    if (!k) return s;
    k.practices = k.practices.filter(function (x) { return x.id !== str(practiceId); });
    k.updatedAt = Date.now();
    return s;
}

// ---------- 练习反馈（V3.9）----------
// 卡点：一句话说明「现在卡在哪」。**只在文本真变了的时候才重置开始日**——
// 每次打开都重存一遍，卡点就永远显示「今天才开始卡」，年龄这个信号就废了。
function setSkillBlocker(state, id, text, today) {
    const s = normalize(state);
    const k = findSkill(s, id);
    if (!k) return s;
    const next = clean(text, BLOCKER_MAX);
    if (!next) return clearSkillBlocker(s, id, today);
    if (next !== k.blocker) {
        k.blocker = next;
        k.blockerSince = validDate(today) || todayOf(new Date());
    } else if (!k.blockerSince) {
        k.blockerSince = validDate(today) || todayOf(new Date());
    }
    k.updatedAt = Date.now();
    return s;
}

// 清掉卡点 = 这条已经过去了。移进 cleared 留档，而不是直接抹掉：
// 「上次那个坑怎么爬出来的」比「现在不卡了」值钱得多。
function clearSkillBlocker(state, id, today) {
    const s = normalize(state);
    const k = findSkill(s, id);
    if (!k) return s;
    if (k.blocker) {
        const day = validDate(today) || todayOf(new Date());
        if (k.cleared.length >= MAX_CLEARED) k.cleared.shift();
        k.cleared.push({
            id: newId('cl'),
            text: k.blocker,
            since: k.blockerSince || day,
            clearedAt: day
        });
    }
    k.blocker = '';
    k.blockerSince = '';
    k.updatedAt = Date.now();
    return s;
}

// 下次练之前先看一眼的那一句：不存历史，存的是「这一轮的靶子」
function setSkillNextUp(state, id, text) {
    const s = normalize(state);
    const k = findSkill(s, id);
    if (!k) return s;
    k.nextUp = clean(text, BLOCKER_MAX);
    k.updatedAt = Date.now();
    return s;
}

// ---------- 主题阅读 ----------
function addTheme(state, patch) {
    const s = normalize(state);
    const p = patch || {};
    const title = clean(p.title, TITLE_MAX);
    if (!title || s.themes.length >= MAX_THEMES) return s;
    s.themes.push(normalizeTheme({
        id: newId('th'),
        title: title,
        note: p.note,
        createdAt: Date.now(),
        updatedAt: Date.now()
    }));
    return s;
}

function findTheme(s, id) {
    const key = str(id);
    return s.themes.filter(function (t) { return t.id === key; })[0] || null;
}

function updateTheme(state, id, patch) {
    const s = normalize(state);
    const t = findTheme(s, id);
    if (!t) return s;
    const p = patch || {};
    if (p.title !== undefined) {
        const title = clean(p.title, TITLE_MAX);
        if (title) t.title = title;
    }
    if (p.note !== undefined) t.note = clean(p.note, NOTE_MAX);
    t.updatedAt = Date.now();
    return s;
}

function removeTheme(state, id) {
    const s = normalize(state);
    s.themes = s.themes.filter(function (t) { return t.id !== str(id); });
    return s;
}

function addBook(state, themeId, patch) {
    const s = normalize(state);
    const t = findTheme(s, themeId);
    const p = patch || {};
    const title = clean(p.title, BOOK_TITLE_MAX);
    if (!t || !title || t.books.length >= MAX_BOOKS) return s;
    const total = num(p.total, 1, 9999, 300);
    t.books.push({
        id: newId('bk'),
        title: title,
        author: clean(p.author, AUTHOR_MAX),
        total: total,
        done: 0,
        unit: clean(p.unit, UNIT_MAX) || '页',
        status: 'todo',
        rating: 0,
        quotes: [],
        note: '',
        startedAt: '',
        finishedAt: ''
    });
    t.updatedAt = Date.now();
    return s;
}

function findBook(t, id) {
    const key = str(id);
    return t.books.filter(function (b) { return b.id === key; })[0] || null;
}

function updateBook(state, themeId, bookId, patch) {
    const s = normalize(state);
    const t = findTheme(s, themeId);
    if (!t) return s;
    const b = findBook(t, bookId);
    if (!b) return s;
    const p = patch || {};
    if (p.title !== undefined) {
        const title = clean(p.title, BOOK_TITLE_MAX);
        if (title) b.title = title;
    }
    if (p.author !== undefined) b.author = clean(p.author, AUTHOR_MAX);
    if (p.unit !== undefined) b.unit = clean(p.unit, UNIT_MAX) || b.unit;
    if (p.total !== undefined) {
        b.total = num(p.total, 1, 9999, b.total);
        b.done = Math.min(b.done, b.total);
    }
    if (p.done !== undefined) b.done = num(p.done, 0, b.total, b.done);
    if (p.note !== undefined) b.note = clean(p.note, NOTE_MAX);
    if (p.rating !== undefined) b.rating = num(p.rating, 0, 5, b.rating);
    t.updatedAt = Date.now();
    return s;
}

function removeBook(state, themeId, bookId) {
    const s = normalize(state);
    const t = findTheme(s, themeId);
    if (!t) return s;
    t.books = t.books.filter(function (b) { return b.id !== str(bookId); });
    t.updatedAt = Date.now();
    return s;
}

// 翻页：读满自动转「读完」，并记下读完日期——阅读的进度单位是页，不是「一件事」
function advanceBook(state, themeId, bookId, delta) {
    const s = normalize(state);
    const t = findTheme(s, themeId);
    if (!t) return s;
    const b = findBook(t, bookId);
    if (!b) return s;
    const step = num(delta, -9999, 9999, 10);
    b.done = Math.max(0, Math.min(b.total, b.done + step));
    if (b.done >= b.total) {
        if (b.status !== 'done') b.finishedAt = todayOf(new Date());
        b.status = 'done';
    } else if (b.done > 0) {
        b.status = 'reading';
        if (!b.startedAt) b.startedAt = todayOf(new Date());
        b.finishedAt = '';
    } else {
        b.status = 'todo';
        b.finishedAt = '';
    }
    t.updatedAt = Date.now();
    return s;
}

// 读完 / 重读：状态是派生出来的（页数决定读没读完），这里只处理「没页数概念」的场景
function setBookStatus(state, themeId, bookId, status) {
    const s = normalize(state);
    const t = findTheme(s, themeId);
    if (!t) return s;
    const b = findBook(t, bookId);
    if (!b) return s;
    if (status === 'done') {
        b.done = b.total;
        b.status = 'done';
        b.finishedAt = b.finishedAt || todayOf(new Date());
    } else if (status === 'reading') {
        b.status = 'reading';
        b.done = Math.max(1, Math.min(b.done, b.total - 1));
        if (!b.startedAt) b.startedAt = todayOf(new Date());
        b.finishedAt = '';
    } else {
        b.status = 'todo';
        b.done = 0;
        b.finishedAt = '';
    }
    t.updatedAt = Date.now();
    return s;
}

function addQuote(state, themeId, bookId, patch) {
    const s = normalize(state);
    const t = findTheme(s, themeId);
    if (!t) return s;
    const b = findBook(t, bookId);
    if (!b) return s;
    const p = patch || {};
    const text = clean(p.text, QUOTE_MAX);
    if (!text || b.quotes.length >= MAX_QUOTES) return s;
    b.quotes.push({ id: newId('q'), text: text, page: num(p.page, 0, 99999, 0), createdAt: Date.now() });
    b.updatedAt = Date.now();
    t.updatedAt = Date.now();
    return s;
}

function removeQuote(state, themeId, bookId, quoteId) {
    const s = normalize(state);
    const t = findTheme(s, themeId);
    if (!t) return s;
    const b = findBook(t, bookId);
    if (!b) return s;
    b.quotes = b.quotes.filter(function (q) { return q.id !== str(quoteId); });
    t.updatedAt = Date.now();
    return s;
}

// ---------- 视图 ----------
function examStage(daysLeft) {
    if (daysLeft < 0) return { key: 'past', label: '已过考试日' };
    if (daysLeft === 0) return { key: 'today', label: '今天考试' };
    if (daysLeft <= 29) return { key: 'sprint', label: '冲刺' };
    if (daysLeft <= 89) return { key: 'build', label: '强化' };
    return { key: 'base', label: '打基础' };
}

function examRow(e, today) {
    const subjects = e.subjects.map(function (sub) {
        return Object.assign({}, sub, {
            pct: pctOf(sub.done, sub.total),
            progressText: sub.done + ' / ' + sub.total + ' ' + sub.unit
        });
    });
    const sumPct = subjects.reduce(function (n, sub) { return n + sub.pct; }, 0);
    const pct = subjects.length ? Math.round(sumPct / subjects.length) : 0;
    const daysLeft = e.examDate ? diffDays(today, e.examDate) : 0;
    const stage = e.examDate ? examStage(daysLeft) : { key: 'none', label: '未定日期' };
    const doneSubjects = subjects.filter(function (sub) { return sub.done >= sub.total; }).length;

    let countdown = '未定考试日期';
    if (e.examDate) {
        if (daysLeft > 0) countdown = '距考试 ' + daysLeft + ' 天';
        else if (daysLeft === 0) countdown = '今天考试';
        else countdown = '考试日已过 ' + Math.abs(daysLeft) + ' 天';
    }

    let resultText = '未出成绩';
    if (e.status === 'passed') resultText = '已通过' + (e.score ? '（' + e.score + (e.passLine ? ' / 合格 ' + e.passLine : '') + '）' : '');
    else if (e.status === 'failed') resultText = '未通过' + (e.score ? '（' + e.score + (e.passLine ? ' / 合格 ' + e.passLine : '') + '）' : '');
    else if (e.status === 'registered') resultText = '已报名，待考';

    // 报名提醒只在「还没报名、报名日已过」时出现；报过名的不再吵
    const enrollMissed = !!e.enrollDate && e.status === 'plan' && diffDays(today, e.enrollDate) < 0;
    const soon = !!e.examDate && daysLeft >= 0 && daysLeft <= 7;

    // 历次作答：错因在这里翻译成人话，并跨次统计「最常栽在哪」
    const attempts = e.attempts.map(function (a) {
        return Object.assign({}, a, {
            causesLabel: a.causes.map(function (k) { return EXAM_CAUSE_LABEL[k]; }).filter(function (x) { return !!x; }),
            gap: (a.score && a.passLine) ? a.score - a.passLine : 0
        });
    });
    const fails = attempts.filter(function (a) { return !a.passed; });
    const lastFail = fails.length ? fails[fails.length - 1] : null;
    const causeCount = {};
    attempts.forEach(function (a) {
        a.causes.forEach(function (k) { causeCount[k] = (causeCount[k] || 0) + 1; });
    });
    const causeTop = Object.keys(causeCount).map(function (k) {
        return { key: k, label: EXAM_CAUSE_LABEL[k] || k, count: causeCount[k] };
    }).sort(function (a, b) {
        return b.count - a.count || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
    });

    return Object.assign({}, e, {
        subjects: subjects,
        pct: e.status === 'passed' ? 100 : pct,
        subjectCount: subjects.length,
        subjectDone: doneSubjects,
        daysLeft: daysLeft,
        stage: stage.key,
        stageLabel: stage.label,
        countdown: countdown,
        resultText: resultText,
        enrollMissed: enrollMissed,
        soon: soon,
        attempts: attempts,
        attemptCount: attempts.length,
        failCount: fails.length,
        lastFail: lastFail,
        causeTop: causeTop
    });
}

function skillRow(k, today) {
    const total = k.milestones.length;
    const done = k.milestones.filter(function (m) { return m.done; }).length;
    const minutes = k.practices.reduce(function (n, p) { return n + p.minutes; }, 0);
    const weekFrom = shiftDate(today, -6);
    const weekMinutes = k.practices.reduce(function (n, p) {
        return (p.date >= weekFrom && p.date <= today) ? n + p.minutes : n;
    }, 0);
    const next = k.milestones.filter(function (m) { return !m.done; })[0];
    const ready = total > 0 && done === total && k.level < k.targetLevel;
    // 卡点年龄：从「开始卡」算到「今天」。当天记的算第 1 天，不写 0 天——
    // 「0 天」看着像没记上。
    const blockerDays = k.blocker
        ? Math.max(1, diffDays(k.blockerSince || today, today) + 1)
        : 0;
    return Object.assign({}, k, {
        milestones: k.milestones.map(function (m) {
            return Object.assign({}, m, { doneText: m.done ? '已达成' : '待达成' });
        }),
        practices: k.practices.slice().sort(function (a, b) { return b.date.localeCompare(a.date); }),
        levelLabel: levelLabel(k.level),
        targetLabel: levelLabel(k.targetLevel),
        levelText: k.level + ' / 5 · ' + levelLabel(k.level),
        milestoneDone: done,
        milestoneTotal: total,
        milestonePct: pctOf(done, total),
        minutes: minutes,
        hoursText: (minutes / 60).toFixed(1),
        weekMinutes: weekMinutes,
        weekText: weekMinutes >= 60 ? (weekMinutes / 60).toFixed(1) + ' 小时' : weekMinutes + ' 分钟',
        lastPractice: k.practices.length ? k.practices[k.practices.length - 1].date : '',
        nextTitle: next ? next.title : '',
        ready: ready,
        // V3.9 练习反馈：卡点年龄比练习时长更能说明问题——练了 40 小时、卡点挂了 30 天，
        // 缺的不是时间，是方法
        blockerDays: blockerDays,
        blockerText: k.blocker ? '已卡 ' + blockerDays + ' 天' : '',
        stuck: blockerDays >= BLOCKER_STALE_DAYS,
        clearedCount: k.cleared.length,
        clearedRecent: k.cleared.slice(-3).reverse()
    });
}

function themeRow(t) {
    const books = t.books.map(function (b) {
        return Object.assign({}, b, {
            pct: b.status === 'done' ? 100 : pctOf(b.done, b.total),
            progressText: b.done + ' / ' + b.total + ' ' + b.unit,
            statusLabel: BOOK_STATUS_LABEL[b.status] || '待读',
            stars: b.rating ? '★★★★★'.slice(0, b.rating) : '',
            quoteCount: b.quotes.length
        });
    });
    const doneBooks = books.filter(function (b) { return b.status === 'done'; }).length;
    const sumPct = books.reduce(function (n, b) { return n + b.pct; }, 0);
    const current = books.filter(function (b) { return b.status === 'reading'; });
    const quoteTotal = books.reduce(function (n, b) { return n + b.quotes.length; }, 0);
    return Object.assign({}, t, {
        books: books,
        bookTotal: books.length,
        bookDone: doneBooks,
        readingCount: current.length,
        pct: books.length ? Math.round(sumPct / books.length) : 0,
        quoteTotal: quoteTotal,
        currentTitle: current.length ? current[0].title : '',
        bookText: doneBooks + ' / ' + books.length + ' 本读完'
    });
}

function board(state, today) {
    const s = normalize(state);
    const day = validDate(today) || todayOf(new Date());
    const exams = s.exams.map(function (e) { return examRow(e, day); })
        .sort(function (a, b) {
            // 有日期的在前、越近越前；已考完的沉底（还要处理成绩，但不该压在头上）
            const ap = a.stage === 'past' ? 1 : 0;
            const bp = b.stage === 'past' ? 1 : 0;
            if (ap !== bp) return ap - bp;
            if (a.examDate && b.examDate && a.examDate !== b.examDate) return a.examDate.localeCompare(b.examDate);
            if (a.examDate && !b.examDate) return -1;
            if (!a.examDate && b.examDate) return 1;
            return b.updatedAt - a.updatedAt;
        });
    const skills = s.skills.map(function (k) { return skillRow(k, day); })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    const themes = s.themes.map(function (t) { return themeRow(t); })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });

    const examSoon = exams.filter(function (e) { return e.soon; }).length;
    const examPast = exams.filter(function (e) { return e.stage === 'past' && e.status !== 'passed' && e.status !== 'failed'; }).length;
    const skillMinutes = skills.reduce(function (n, k) { return n + k.minutes; }, 0);
    const skillWeek = skills.reduce(function (n, k) { return n + k.weekMinutes; }, 0);
    const skillReady = skills.filter(function (k) { return k.ready; }).length;
    const bookTotal = themes.reduce(function (n, t) { return n + t.bookTotal; }, 0);
    const bookDone = themes.reduce(function (n, t) { return n + t.bookDone; }, 0);
    const quoteTotal = themes.reduce(function (n, t) { return n + t.quoteTotal; }, 0);

    // 错因汇总（V3.9）：单场考试看不出规律，几次并起来才看得出「你总是栽在哪」
    const examCauseCount = {};
    let examAttempts = 0;
    let examFails = 0;
    exams.forEach(function (e) {
        examAttempts += e.attemptCount;
        examFails += e.failCount;
        e.causeTop.forEach(function (c) { examCauseCount[c.key] = (examCauseCount[c.key] || 0) + c.count; });
    });
    const causeTop = Object.keys(examCauseCount).map(function (k) {
        return { key: k, label: EXAM_CAUSE_LABEL[k] || k, count: examCauseCount[k] };
    }).sort(function (a, b) {
        return b.count - a.count || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
    });

    const stats = {
        examTotal: exams.length,
        examOpen: exams.filter(function (e) { return e.status === 'plan' || e.status === 'registered'; }).length,
        examSoon: examSoon,
        examPast: examPast,
        examPassed: exams.filter(function (e) { return e.status === 'passed'; }).length,
        examEnrollMissed: exams.filter(function (e) { return e.enrollMissed; }).length,
        examAttempts: examAttempts,
        examFails: examFails,
        skillTotal: skills.length,
        skillMinutes: skillMinutes,
        skillHours: Number((skillMinutes / 60).toFixed(1)),
        skillWeek: skillWeek,
        skillReady: skillReady,
        skillBlocked: skills.filter(function (k) { return !!k.blocker; }).length,
        skillStuck: skills.filter(function (k) { return k.stuck; }).length,
        themeTotal: themes.length,
        bookTotal: bookTotal,
        bookDone: bookDone,
        quoteTotal: quoteTotal,
        total: exams.length + skills.length + themes.length
    };

    // 提醒：只有「今天真的该看一眼」的才进来，凑数的提醒等于没有提醒
    const alerts = [];
    exams.forEach(function (e) {
        if (e.enrollMissed) {
            alerts.push({ kind: 'exam', id: e.id, title: e.title, level: 'warn', text: '报名截止已过，还没标已报名' });
        } else if (e.soon) {
            alerts.push({ kind: 'exam', id: e.id, title: e.title, level: 'warn', text: e.daysLeft === 0 ? '今天考试' : '距考试 ' + e.daysLeft + ' 天' });
        } else if (e.stage === 'past' && e.status !== 'passed' && e.status !== 'failed') {
            alerts.push({ kind: 'exam', id: e.id, title: e.title, level: 'info', text: '考完了，去记成绩' });
        } else if (e.status === 'failed' && e.lastFail && e.lastFail.causesLabel.length) {
            // 记了错因就别浪费：下次动手前先看一眼「上次死在哪」
            alerts.push({ kind: 'exam', id: e.id, title: e.title, level: 'info', text: '上次错在：' + e.lastFail.causesLabel.join('、') });
        }
    });
    // 卡点先看，因为它比「可以升级」更该动：卡着的时候升级只是摆设
    skills.forEach(function (k) {
        if (k.stuck) {
            alerts.push({
                kind: 'skill', id: k.id, title: k.title, level: 'warn',
                text: '卡点挂了 ' + k.blockerDays + ' 天 —— 不是练得少，是这个方法不对'
            });
        } else if (k.ready) {
            alerts.push({ kind: 'skill', id: k.id, title: k.title, level: 'info', text: '里程碑全达成，可以升到「' + k.targetLabel + '」' });
        }
    });
    themes.forEach(function (t) {
        if (t.bookTotal > 0 && t.bookDone === t.bookTotal) {
            alerts.push({ kind: 'theme', id: t.id, title: t.title, level: 'done', text: '这个主题读完了' });
        }
    });

    let insight;
    if (!stats.total) {
        insight = '三块都还空着。考试考证填一个考试日，技能学习列一条 milestone，主题阅读先放一本书——哪种先动都行。';
    } else if (examSoon) {
        insight = '有 ' + examSoon + ' 场考试在 7 天内，先把冲刺排上；科目进度是加权值，别只看总进度条。';
    } else if (stats.examEnrollMissed) {
        insight = '有 ' + stats.examEnrollMissed + ' 场考试的报名日已过，但状态还是「备考中」——要么补报名，要么改状态，别让它挂着。';
    } else if (stats.skillStuck) {
        insight = '有 ' + stats.skillStuck + ' 项技能的卡点已经挂了 ' + BLOCKER_STALE_DAYS + ' 天以上。'
            + (causeTop.length ? '上次考试的错因也集中在「' + causeTop[0].label + '」。' : '')
            + '卡点不下走，只能换方法：拆小一号的题、找人看一次、或者换一份材料。';
    } else if (skillReady) {
        insight = '有 ' + skillReady + ' 项技能的里程碑全达成了，等级该往上调一格——不调，进度条会骗人。';
    } else if (stats.examPast) {
        insight = '有 ' + stats.examPast + ' 场考完还没记成绩。记了才好判断下一步：补考、还是换一个。';
    } else if (stats.bookTotal && stats.bookDone === stats.bookTotal) {
        insight = '书单读完了，趁记忆还在，把摘录补上再开下一个主题。';
    } else if (stats.skillBlocked) {
        insight = '有 ' + stats.skillBlocked + ' 项技能写着卡点，还没到该报警的天数——先照着「下次提高一点什么」练一轮。';
    } else {
        insight = '本周练习 ' + (skillWeek >= 60 ? (skillWeek / 60).toFixed(1) + ' 小时' : skillWeek + ' 分钟')
            + '；在读 ' + themes.reduce(function (n, t) { return n + t.readingCount; }, 0) + ' 本。'
            + (stats.skillTotal ? '技能不追完成，追的是「这周有没有练」。' : '');
    }

    return {
        today: day,
        exams: exams,
        skills: skills,
        themes: themes,
        stats: stats,
        alerts: alerts,
        causeTop: causeTop,
        blockerStaleDays: BLOCKER_STALE_DAYS,
        insight: insight,
        note: '口径：考试的进度按科目完成率取平均（不是按章节数加权）；技能不设完成，只看里程碑达成率与累计练习时长；'
            + '阅读按页数推进，读满自动转「读完」。三块各自独立，互不折算成同一个百分比。'
    };
}

// ---------- 旧学习库导入（md_study_library → md_growth） ----------
// 旧模型只有「书/影/画/课 + done/total + 主题」。映射：
//   书 → 主题阅读里的一本书（若有主题名，按主题名开主题；没有就进「未归类」主题）
//   影/画 → 主题阅读里的一本书，单位改成「集/幅」——它们是同一个「按进度读/看」的形状
//   课 → 技能学习（课程更接近「学一门技能」，且旧数据没有考试日期，进考试会造出假倒计时）
// 幂等：按标题去重，导两次不会翻倍。
function importLegacy(state, library) {
    const s = normalize(state);
    const lib = (library && typeof library === 'object') ? library : {};
    const items = Array.isArray(lib.items) ? lib.items : [];
    const topics = Array.isArray(lib.topics) ? lib.topics : [];
    const topicTitle = {};
    topics.forEach(function (t) {
        const title = clean(t && t.title, TITLE_MAX);
        if (title) topicTitle[str(t && t.id)] = title;
    });

    let addedBooks = 0;
    let addedSkills = 0;

    function themeByTitle(title) {
        const hit = s.themes.filter(function (t) { return t.title === title; })[0];
        if (hit) return hit;
        const created = normalizeTheme({ id: newId('th'), title: title, note: '', createdAt: Date.now() });
        s.themes.push(created);
        return created;
    }

    items.forEach(function (it) {
        const title = clean(it && it.title, BOOK_TITLE_MAX);
        if (!title) return;
        const kind = str(it && it.kind);
        const total = num(it && it.total, 1, 9999, 1);
        const done = num(it && it.done, 0, total, 0);
        const finished = !!(it && it.finished);
        if (kind === 'course') {
            const dup = s.skills.filter(function (k) { return k.title === title; })[0];
            if (dup) return;
            if (s.skills.length >= MAX_SKILLS) return;
            const skill = normalizeSkill({
                id: newId('sk'), title: title, level: finished ? 3 : 2,
                targetLevel: Math.max(3, finished ? 4 : 3),
                createdAt: Date.now(), updatedAt: Date.now()
            });
            s.skills.push(skill);
            addedSkills += 1;
            return;
        }
        const themeName = clean(topicTitle[str(it && it.topicId)], TITLE_MAX) || '未归类（旧学习库）';
        const theme = themeByTitle(themeName);
        if (theme.books.length >= MAX_BOOKS) return;
        if (theme.books.some(function (b) { return b.title === title; })) return;
        const unit = clean(it && it.unit, UNIT_MAX) || (kind === 'movie' ? '集' : (kind === 'art' ? '幅' : '页'));
        theme.books.push({
            id: newId('bk'),
            title: title,
            author: '',
            total: total,
            done: finished ? total : done,
            unit: unit,
            status: finished ? 'done' : (done > 0 ? 'reading' : 'todo'),
            rating: 0,
            quotes: [],
            note: clean(it && it.note, NOTE_MAX),
            startedAt: '',
            finishedAt: ''
        });
        addedBooks += 1;
        theme.updatedAt = Date.now();
    });

    return { state: normalize(s), addedBooks: addedBooks, addedSkills: addedSkills };
}

// 换机合并：只补不改，按 id 去重
function mergeSection(state, section) {
    const s = normalize(state);
    const incoming = normalize(section);
    const seen = {};
    s.exams.concat(s.skills).concat(s.themes).forEach(function (x) { seen[x.id] = true; });
    let added = 0;
    ['exams', 'skills', 'themes'].forEach(function (key) {
        incoming[key].forEach(function (x) {
            if (seen[x.id]) return;
            s[key].push(x);
            seen[x.id] = true;
            added += 1;
        });
    });
    return { state: normalize(s), added: added };
}

module.exports = {
    MAX_EXAMS: MAX_EXAMS,
    MAX_SKILLS: MAX_SKILLS,
    MAX_THEMES: MAX_THEMES,
    MAX_SUBJECTS: MAX_SUBJECTS,
    MAX_MILESTONES: MAX_MILESTONES,
    MAX_PRACTICES: MAX_PRACTICES,
    MAX_BOOKS: MAX_BOOKS,
    MAX_QUOTES: MAX_QUOTES,
    LEVELS: LEVELS,
    EXAM_STATUS: EXAM_STATUS,
    EXAM_CAUSES: EXAM_CAUSES,
    BOOK_STATUS: BOOK_STATUS,
    BLOCKER_STALE_DAYS: BLOCKER_STALE_DAYS,
    levelLabel: levelLabel,
    empty: empty,
    normalize: normalize,
    meta: meta,
    board: board,
    addExam: addExam,
    updateExam: updateExam,
    removeExam: removeExam,
    addSubject: addSubject,
    updateSubject: updateSubject,
    removeSubject: removeSubject,
    setExamResult: setExamResult,
    setExamCauses: setExamCauses,
    retakeExam: retakeExam,
    addSkill: addSkill,
    updateSkill: updateSkill,
    removeSkill: removeSkill,
    addMilestone: addMilestone,
    toggleMilestone: toggleMilestone,
    removeMilestone: removeMilestone,
    addPractice: addPractice,
    removePractice: removePractice,
    setSkillBlocker: setSkillBlocker,
    clearSkillBlocker: clearSkillBlocker,
    setSkillNextUp: setSkillNextUp,
    addTheme: addTheme,
    updateTheme: updateTheme,
    removeTheme: removeTheme,
    addBook: addBook,
    updateBook: updateBook,
    removeBook: removeBook,
    advanceBook: advanceBook,
    setBookStatus: setBookStatus,
    addQuote: addQuote,
    removeQuote: removeQuote,
    importLegacy: importLegacy,
    mergeSection: mergeSection
};
