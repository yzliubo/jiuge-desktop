'use strict';
// 读书笔记（md_reading）——纯领域层，CommonJS，零第三方依赖。
//
// ---- 三张表各自是什么 ----
// books    : 休闲娱乐 + 主题阅读共用本表。themeId 为空 = 休闲书；非空 = 归属该主题，
//            因此主题书同样有 filePath，能用同一个阅读窗口、章节、进度、三阶九问与笔记落库。
// themes    : 主题（学习单元）本身。V2.14 权威源由 md_growth 迁到 md_reading；
//            md_growth 里的旧书单仅作「一次性导入」来源，导入后原样保留、不再写回。
// notes    : 两类阅读产生的全部笔记汇总，是「读书笔记」数据库的本体。每条冗余存
//            bookTitle，使书被删掉之后笔记仍然可读；orphan 只是派生判断，不落库。
// chapters : 本地章节大纲（不是 AI 思维导图），挂在休闲书上，两层树。
//
// ---- 纯函数约定 ----
// 所有导出函数都是 fn(state, ...args) -> 新 state，绝不原地改传入对象。
// normalize 完全不读时钟：缺失 createdAt 归 0，缺失/重复 id 用「索引兜底 + 确定性
// 后缀」解决；只有 add 类函数（含 newId）才用 Date.now() 生成时间与 id。
// 唯一的时钟例外是 board.stats.thisMonth —— 契约明确要求按 new Date() 的年月比较。
// 所有「今天」/ 回写时间都由调用方传（date / at / patch.createdAt）。

// ---------- 常量 ----------
const MAX_BOOKS = 60;
const MAX_THEMES = 20;
const MAX_NOTES = 2000;
const MAX_CHAPTERS = 300;
// 书签独立成表：书签是「我的位置」，不是「读书笔记」，混进 notes 会污染笔记库语义
const MAX_BOOKMARKS = 200;
const MAX_TAGS = 8;

const TITLE_MAX = 60;
const THEME_TITLE_MAX = 60;
const THEME_NOTE_MAX = 200;
const AUTHOR_MAX = 40;
const BOOK_TITLE_MAX = 80;
const NOTE_MAX = 200;
const TEXT_MAX = 2000;
const QUOTE_MAX = 1000;
const UNIT_MAX = 4;
const TAG_MAX = 24;
const ID_MAX = 80;
const CELL_MAX = 32;
const ANCHOR_MAX = 32;
// 锚点指纹：正文偏移只是「起点提示」，真正保证不失锚的是选区前后的原文片段。
// 每侧 24 字足够消除中文短句的大量重复，又不至于把 md_reading 单键撑大
// （2000 条笔记 × 48 字 ≈ 190 KB，仍在设计上限内）。
const TAIL_MAX = 24;
// 正文标注：颜色只决定怎么画，样式只决定画成什么，都不新增 note.type（九格回写语义不变）
const HL_COLORS = ['yellow', 'green', 'blue', 'pink'];
const NOTE_STYLES = ['highlight', 'underline', 'strike'];
const COLOR_MAX = 24;
const PATH_MAX = 1000;
const EXT_MAX = 8;
const FORMAT_MAX = 12;
// 本地电子书：只登记路径，不把文件内容搬进库（沿用 md_attach 的链接型口径）
const FILE_EXTS = ['epub', 'pdf', 'txt', 'md', 'mobi', 'azw3'];
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const KEYWORD_MAX = 100;
const PAGE_MAX = 99999;
const TS_MAX = 8640000000000000; // JS 可表示的最大时间戳，够用且不引入 Infinity

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MODES = ['leisure', 'theme'];
const MODE_LABEL = { leisure: '休闲娱乐', theme: '主题阅读' };

const NOTE_TYPES = ['highlight', 'note', 'idea', 'link'];
const NOTE_TYPE_LABEL = { highlight: '摘录', note: '笔记', idea: '想法', link: '关联' };

const BOOK_STATUS_LABEL = { todo: '待读', reading: '在读', done: '读完' };

// 本地替代联网 AI 伴读的 IPO 提问模板：读到一段 -> 想到什么 -> 连上什么 -> 拿来做什么
const PROMPTS = [
    { id: 'p-idea', label: '这段让我想到什么', hint: '先接住由原文引出的一闪而过的念头', type: 'idea' },
    { id: 'p-link', label: '它和哪本书/哪件事连得上', hint: '找一找与别的书、别的事之间的关联', type: 'link' },
    { id: 'p-note', label: '我能拿它做什么', hint: '落到一个可以动手去做的具体动作', type: 'note' }
];

// ---------- 小工具（与 growth/board.js 同口径）----------
function str(v) { return typeof v === 'string' ? v : (v === 0 || v ? String(v) : ''); }
function clean(v, max) {
    const s = str(v).replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max) : s;
}
// 路径只 trim，不折叠内部空格（Windows 路径可能含连续空格）
function clip(v, max) {
    const s = str(v).trim();
    return max && s.length > max ? s.slice(0, max) : s;
}
function num(v, min, max, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, Math.round(n)));
}
function pad(n) { return n < 10 ? '0' + n : String(n); }
function tsOf(v) {
    const n = Number(v);
    return (isFinite(n) && n > 0) ? Math.round(n) : 0;
}
function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// 光靠正则不够：「2026-13-40」也是 4-2-2 位数字，必须能回读成真实日期
function validDate(v) {
    const s = clean(v, 10);
    if (!DATE_RE.test(s)) return '';
    const p = s.split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (d.getFullYear() !== Number(p[0]) || d.getMonth() !== Number(p[1]) - 1 || d.getDate() !== Number(p[2])) return '';
    return s;
}

function pctOf(done, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round(done * 100 / total)));
}

function normMode(v) { return str(v) === 'theme' ? 'theme' : 'leisure'; }
function normType(v) {
    const s = str(v);
    return (s === 'highlight' || s === 'note' || s === 'idea' || s === 'link') ? s : 'note';
}
function normStatus(v) {
    const s = str(v);
    return (s === 'todo' || s === 'reading' || s === 'done') ? s : 'todo';
}

// tags：去空白、剥 # 前缀、去重、最多 MAX_TAGS 个
function normTags(raw) {
    const out = [];
    const seen = {};
    const arr = Array.isArray(raw) ? raw : [];
    for (let i = 0; i < arr.length && out.length < MAX_TAGS; i += 1) {
        let s = clean(arr[i], TAG_MAX);
        while (s.charAt(0) === '#') s = s.slice(1).trim();
        s = clean(s, TAG_MAX);
        if (!s || seen[s]) continue;
        seen[s] = true;
        out.push(s);
    }
    return out;
}
function normTagOne(v) {
    let s = clean(v, TAG_MAX);
    while (s.charAt(0) === '#') s = s.slice(1).trim();
    return clean(s, TAG_MAX);
}

// 确定性去重：normalize 不读时钟，不能用 newId，故用 -2 / -3 后缀
function uniqueId(id, seen) {
    if (!seen[id]) { seen[id] = 1; return id; }
    let n = seen[id] || 1;
    let cand = '';
    do { n += 1; cand = id + '-' + n; } while (seen[cand]);
    seen[id] = n;
    seen[cand] = 1;
    return cand;
}

function byCreatedDesc(a, b) {
    const d = b.createdAt - a.createdAt;
    if (d) return d;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}
function monthKey(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
}
function dateOf(ts) {
    if (!(ts > 0)) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// ---------- 空态 ----------
function empty() {
    return { version: 1, books: [], chapters: [], notes: [], bookmarks: [], themes: [], updatedAt: 0 };
}

// ---------- 实体 normalize：未知字段一律不保留 ----------
function normBook(b, seen, fallbackId) {
    const o = isObj(b) ? b : {};
    const title = clean(o.title, TITLE_MAX);
    if (!title) return null;
    const id = uniqueId(clean(o.id, ID_MAX) || fallbackId, seen);
    const total = num(o.total, 1, 9999, 300);
    const status = normStatus(o.status);
    const done = status === 'done' ? total : num(o.done, 0, total, 0);
    return {
        id: id,
        themeId: clean(o.themeId, ID_MAX),
        title: title,
        author: clean(o.author, AUTHOR_MAX),
        total: total,
        done: done,
        unit: clean(o.unit, UNIT_MAX) || '页',
        status: status,
        note: clean(o.note, NOTE_MAX),
        coverColor: clean(o.coverColor, COLOR_MAX),
        filePath: clip(o.filePath, PATH_MAX),
        fileExt: clean(o.fileExt, EXT_MAX).toLowerCase(),
        fileSize: num(o.fileSize, 0, MAX_FILE_BYTES, 0),
        format: clean(o.format, FORMAT_MAX),
        coverId: clean(o.coverId, ID_MAX),
        source: str(o.source) === 'file' ? 'file' : 'manual',
        startedAt: validDate(o.startedAt),
        finishedAt: status === 'done' ? validDate(o.finishedAt) : '',
        createdAt: num(o.createdAt, 0, TS_MAX, 0)
    };
}

// 主题：一个学习单元；书靠 books[].themeId 归属，笔记靠 notes.themeId 归属
function normTheme(t, seen, fallbackId) {
    const o = isObj(t) ? t : {};
    const title = clean(o.title, THEME_TITLE_MAX);
    if (!title) return null;
    return {
        id: uniqueId(clean(o.id, ID_MAX) || fallbackId, seen),
        title: title,
        note: clean(o.note, THEME_NOTE_MAX),
        createdAt: num(o.createdAt, 0, TS_MAX, 0),
        updatedAt: num(o.updatedAt, 0, TS_MAX, 0)
    };
}

function normChapter(c, seen, fallbackId) {
    const o = isObj(c) ? c : {};
    const title = clean(o.title, TITLE_MAX);
    if (!title) return null;
    const id = uniqueId(clean(o.id, ID_MAX) || fallbackId, seen);
    return {
        id: id,
        bookId: clean(o.bookId, ID_MAX),
        title: title,
        parentId: clean(o.parentId, ID_MAX),
        order: num(o.order, 0, 9999, 0),
        createdAt: num(o.createdAt, 0, TS_MAX, 0)
    };
}

// 章内锚点："<章序>:<起>-<止>"，正文纯文本偏移；只认这个形状，脏值一律丢弃
// 偏移负责「大概在哪一句」，anchorPre / anchorSuf 负责「确认就是这一句」：
// 换书源、重排版、章节被清洗过一轮之后，偏移会失准，前后文片段不会一起失准。
function normAnchor(v) {
    const s = str(v).trim();
    return /^\d{1,4}:\d{1,7}-\d{1,7}$/.test(s) ? s : '';
}
function normColor(v) {
    const s = str(v).toLowerCase();
    return HL_COLORS.indexOf(s) >= 0 ? s : '';
}
function normStyle(v) {
    const s = str(v).toLowerCase();
    return NOTE_STYLES.indexOf(s) >= 0 ? s : '';
}
// 书签锚点："<章序>:<0..1 的滚动比例>"，重排流没有固定页码，用章内位置代替
function normBookAnchor(v) {
    const s = str(v).trim();
    if (!/^\d{1,4}:\d{1,6}(\.\d{1,4})?$/.test(s)) return '';
    const parts = s.split(':');
    const idx = Number(parts[0]);
    const ratio = Number(parts[1]);
    if (!isFinite(idx) || !isFinite(ratio)) return '';
    return String(Math.trunc(idx)) + ':' + String(Math.max(0, Math.min(1, ratio)).toFixed(3));
}

function normNote(n, seen, fallbackId) {
    const o = isObj(n) ? n : {};
    const quote = clean(o.quote, QUOTE_MAX);
    const text = clean(o.text, TEXT_MAX);
    if (!quote && !text) return null; // 完全空的笔记没有意义，与 growth 丢弃空条目一致
    const id = uniqueId(clean(o.id, ID_MAX) || fallbackId, seen);
    const mode = normMode(o.mode);
    return {
        id: id,
        mode: mode,
        bookId: clean(o.bookId, ID_MAX),
        themeId: mode === 'leisure' ? '' : clean(o.themeId, ID_MAX),
        bookTitle: clean(o.bookTitle, BOOK_TITLE_MAX),
        type: normType(o.type),
        quote: quote,
        text: text,
        page: num(o.page, 0, PAGE_MAX, 0),
        tags: normTags(o.tags),
        chapterId: clean(o.chapterId, ID_MAX),
        anchor: normAnchor(o.anchor),
        anchorPre: clean(o.anchorPre, TAIL_MAX),
        anchorSuf: clean(o.anchorSuf, TAIL_MAX),
        color: normColor(o.color),
        style: normStyle(o.style),
        createdAt: num(o.createdAt, 0, TS_MAX, 0),
        pushedAt: num(o.pushedAt, 0, TS_MAX, 0),
        pushedCell: clean(o.pushedCell, CELL_MAX),
        sourceQuoteId: clean(o.sourceQuoteId, ID_MAX)
    };
}

// 书签：{ id, bookId, chapterIndex, anchor, label, createdAt }
function normBookmark(m, seen, fallbackId) {
    const o = isObj(m) ? m : {};
    const bookId = clean(o.bookId, ID_MAX);
    if (!bookId) return null;
    const anchor = normBookAnchor(o.anchor);
    if (!anchor) return null;
    return {
        id: uniqueId(clean(o.id, ID_MAX) || fallbackId, seen),
        bookId: bookId,
        chapterIndex: num(anchor.split(':')[0], 0, 9999, 0),
        anchor: anchor,
        label: clean(o.label, TITLE_MAX) || '书签',
        createdAt: num(o.createdAt, 0, TS_MAX, 0)
    };
}

// 两层树：父本身也是子层时，把当前节点抬为顶层，绝不出现第三层
function clampDepth(chapters) {
    const byId = {};
    chapters.forEach(function (c) { byId[c.id] = c; });
    return chapters.map(function (c) {
        if (!c.parentId) return c;
        const p = byId[c.parentId];
        return (p && p.parentId) ? Object.assign({}, c, { parentId: '' }) : c;
    });
}
function clampParent(chapters, parentId, selfId) {
    if (!parentId || parentId === selfId) return '';
    const p = chapters.filter(function (c) { return c.id === parentId; })[0];
    return (p && p.parentId) ? '' : parentId;
}

// ---------- normalize：任何外部数据进来都先过这一层 ----------
function normalize(raw) {
    const src = isObj(raw) ? raw : {};
    const seen = {};
    function take(list, fn, limit, prefix) {
        return (Array.isArray(list) ? list : []).slice(0, limit).map(function (x, i) {
            return fn(x, seen, prefix + '-' + i) || null;
        }).filter(function (x) { return !!x; });
    }
    const themes = take(src.themes, normTheme, MAX_THEMES, 'th');
    const books = take(src.books, normBook, MAX_BOOKS, 'bk');
    const chapters = clampDepth(take(src.chapters, normChapter, MAX_CHAPTERS, 'ch'));
    const notes = take(src.notes, normNote, MAX_NOTES, 'nt');
    // 书签：同一本书同一位置只留一条（重复点「加书签」不该叠出一串）
    const rawBookmarks = take(src.bookmarks, normBookmark, MAX_BOOKMARKS, 'bm');
    const bmSeen = {};
    const bookmarks = [];
    rawBookmarks.forEach(function (m) {
        const k = m.bookId + '|' + m.anchor;
        if (bmSeen[k]) return;
        bmSeen[k] = true;
        bookmarks.push(m);
    });
    return {
        version: 1,
        themes: themes,
        books: books,
        chapters: chapters,
        notes: notes,
        bookmarks: bookmarks,
        updatedAt: num(src.updatedAt, 0, TS_MAX, 0)
    };
}

// 写操作统一出口：所有列表都重新过一遍 normalize，保证状态始终规范
function rebuild(books, chapters, notes, updatedAt, bookmarks, themes) {
    return normalize({
        version: 1, themes: themes || [], books: books, chapters: chapters, notes: notes,
        bookmarks: bookmarks || [], updatedAt: updatedAt
    });
}

function meta() {
    return {
        modes: MODES.slice(),
        modeLabel: Object.assign({}, MODE_LABEL),
        noteTypes: NOTE_TYPES.slice(),
        noteTypeLabel: Object.assign({}, NOTE_TYPE_LABEL),
        prompts: PROMPTS.map(function (p) { return { id: p.id, label: p.label, hint: p.hint, type: p.type }; }),
        hlColors: HL_COLORS.slice(),
        noteStyles: NOTE_STYLES.slice(),
        limits: {
            books: MAX_BOOKS, notes: MAX_NOTES, chapters: MAX_CHAPTERS, tags: MAX_TAGS,
            title: TITLE_MAX, text: TEXT_MAX, quote: QUOTE_MAX, page: PAGE_MAX,
            bookmarks: MAX_BOOKMARKS,
            fileExts: FILE_EXTS.slice(), fileBytes: MAX_FILE_BYTES
        }
    };
}

// ---------- 书 ----------
// 同一本电子书拖两次不该出现两张卡片：按绝对路径去重（Windows 大小写不敏感）
function bookByPath(state, p) {
    const s = normalize(state);
    const key = clip(p, PATH_MAX).toLowerCase();
    if (!key) return null;
    return s.books.filter(function (b) { return b.filePath.toLowerCase() === key; })[0] || null;
}
function hasPath(state, p) { return !!bookByPath(state, p); }

function addBook(state, patch) {
    const s = normalize(state);
    if (s.books.length >= MAX_BOOKS) return s;
    const p = isObj(patch) ? patch : {};
    const at = tsOf(p.createdAt) || Date.now();
    const raw = {
        id: str(p.id) || newId('bk'),
        themeId: p.themeId,
        title: p.title,
        author: p.author,
        total: p.total,
        done: p.done,
        unit: p.unit,
        status: p.status,
        note: p.note,
        coverColor: p.coverColor,
        filePath: p.filePath,
        fileExt: p.fileExt,
        fileSize: p.fileSize,
        format: p.format,
        coverId: p.coverId,
        source: p.source,
        startedAt: p.startedAt,
        finishedAt: p.finishedAt,
        createdAt: at
    };
    return rebuild(s.books.concat([raw]), s.chapters, s.notes, at, s.bookmarks, s.themes);
}

function updateBook(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.books.some(function (b) { return b.id === key; })) return s;
    const p = isObj(patch) ? patch : {};
    const books = s.books.map(function (b) {
        return b.id === key ? Object.assign({}, b, p, { id: key }) : b;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes);
}

// 只删书和它的章节；笔记一条不动（orphan 由 notesQuery 派生）
function removeBook(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key) return s;
    const books = s.books.filter(function (b) { return b.id !== key; });
    if (books.length === s.books.length) return s;
    const chapters = s.chapters.filter(function (c) { return c.bookId !== key; });
    return rebuild(books, chapters, s.notes, s.updatedAt, s.bookmarks, s.themes);
}

function advanceBook(state, id, delta, date) {
    const s = normalize(state);
    const key = str(id);
    if (!key) return s;
    const d = num(delta, -999999, 999999, 0);
    const fin = validDate(date);
    let hit = false;
    const books = s.books.map(function (b) {
        if (b.id !== key) return b;
        hit = true;
        const done = Math.max(0, Math.min(b.total, b.done + d));
        let status = b.status;
        let finishedAt = b.finishedAt;
        if (done >= b.total) {
            status = 'done';
            finishedAt = fin || finishedAt;
        } else if (d < 0 && b.status === 'done') {
            status = 'reading';
            finishedAt = '';
        } else if (b.status === 'todo' && d > 0) {
            status = 'reading';
        }
        return Object.assign({}, b, { done: done, status: status, finishedAt: finishedAt });
    });
    if (!hit) return s;
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes);
}

function setBookStatus(state, id, status, date) {
    const s = normalize(state);
    const key = str(id);
    const st = str(status);
    if (!key || (st !== 'todo' && st !== 'reading' && st !== 'done')) return s;
    if (!s.books.some(function (b) { return b.id === key; })) return s;
    const d = validDate(date);
    const books = s.books.map(function (b) {
        if (b.id !== key) return b;
        const next = Object.assign({}, b, { status: st });
        if (st === 'done') {
            next.done = b.total;
            next.finishedAt = d || b.finishedAt;
        } else {
            next.finishedAt = '';
            if (b.status === 'done' && b.done >= b.total) next.done = Math.max(0, b.total - 1);
        }
        return next;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes);
}

// ---------- 主题（V2.14：书单权威源迁到 md_reading）----------
function addTheme(state, patch) {
    const s = normalize(state);
    if (s.themes.length >= MAX_THEMES) return s;
    const p = isObj(patch) ? patch : {};
    const at = tsOf(p.createdAt) || Date.now();
    const raw = {
        id: str(p.id) || newId('th'),
        title: p.title,
        note: p.note,
        createdAt: at,
        updatedAt: at
    };
    return rebuild(s.books, s.chapters, s.notes, at, s.bookmarks, s.themes.concat([raw]));
}

function updateTheme(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.themes.some(function (t) { return t.id === key; })) return s;
    const p = isObj(patch) ? patch : {};
    const at = tsOf(p.updatedAt) || Date.now();
    const themes = s.themes.map(function (t) {
        return t.id === key ? Object.assign({}, t, p, { id: key, updatedAt: at }) : t;
    });
    return rebuild(s.books, s.chapters, s.notes, s.updatedAt, s.bookmarks, themes);
}

// 删主题不删书：书解绑回休闲书架，笔记一条不动（orphan 由 notesQuery 派生）
function removeTheme(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.themes.some(function (t) { return t.id === key; })) return s;
    const themes = s.themes.filter(function (t) { return t.id !== key; });
    const books = s.books.map(function (b) {
        return b.themeId === key ? Object.assign({}, b, { themeId: '' }) : b;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, themes);
}

// 一次性把 md_growth 的旧主题书单 + 摘录迁进来。旧数据不删、可反复调用（按确定性 id 去重）。
// 摘录沿用 importGrowthQuotes 的 sourceQuoteId，避免两处重复汇总；若旧摘录已汇总过，
// 则就地改写归属到新主题书，保证「各文件的笔记都记在这一个主题之下」。
function importGrowthThemes(state, growth) {
    const s = normalize(state);
    const g = isObj(growth) ? growth : {};
    const now = Date.now();
    let themes = s.themes.slice();
    let books = s.books.slice();
    let notes = s.notes.slice();
    const themeSeen = {};
    const bookSeen = {};
    themes.forEach(function (t) { themeSeen[t.id] = true; });
    books.forEach(function (b) { bookSeen[b.id] = true; });
    let addedThemes = 0, addedBooks = 0, addedNotes = 0, relinked = 0;
    (Array.isArray(g.themes) ? g.themes : []).forEach(function (t) {
        if (!isObj(t) || !str(t.id)) return;
        const tid = clean('gth-' + str(t.id), ID_MAX);
        if (themeSeen[tid]) return;
        themeSeen[tid] = true;
        themes.push({
            id: tid,
            title: clean(t.title, THEME_TITLE_MAX) || '未命名主题',
            note: clean(t.note, THEME_NOTE_MAX),
            createdAt: num(t.createdAt, 0, TS_MAX, 0) || now,
            updatedAt: now
        });
        addedThemes += 1;
        (Array.isArray(t.books) ? t.books : []).forEach(function (b) {
            if (!isObj(b)) return;
            const bid = clean('gthbk-' + str(t.id) + '-' + str(b.id), ID_MAX);
            if (bookSeen[bid]) return;
            bookSeen[bid] = true;
            books.push({
                id: bid,
                themeId: tid,
                title: clean(b.title, TITLE_MAX) || '未命名书',
                author: clean(b.author, AUTHOR_MAX),
                total: num(b.total, 1, 9999, 300),
                done: num(b.done, 0, 9999, 0),
                unit: clean(b.unit, UNIT_MAX) || '页',
                status: normStatus(b.status),
                note: clean(b.note, NOTE_MAX),
                coverColor: '', filePath: '', fileExt: '', fileSize: 0,
                format: '', coverId: '',
                source: 'manual',
                startedAt: validDate(b.startedAt),
                finishedAt: validDate(b.finishedAt),
                createdAt: num(b.createdAt, 0, TS_MAX, 0) || now
            });
            addedBooks += 1;
            (Array.isArray(b.quotes) ? b.quotes : []).forEach(function (q) {
                if (!isObj(q)) return;
                const sid = 'gq-' + str(t.id) + '-' + str(b.id) + '-' + str(q.id);
                let idx = -1;
                for (let i = 0; i < notes.length; i += 1) {
                    if (notes[i].sourceQuoteId === sid) { idx = i; break; }
                }
                const patch = {
                    mode: 'theme', themeId: tid, bookId: bid,
                    bookTitle: clean(b.title, BOOK_TITLE_MAX),
                    type: 'highlight', quote: clean(q.text, QUOTE_MAX), text: '',
                    page: num(q.page, 0, PAGE_MAX, 0), tags: [], chapterId: '',
                    createdAt: num(q.createdAt, 0, TS_MAX, 0) || now, sourceQuoteId: sid
                };
                if (idx >= 0) {
                    notes[idx] = Object.assign({}, notes[idx], patch); // 已汇总过 → 改写归属
                    relinked += 1;
                } else {
                    notes.push(Object.assign({ id: newId('nt'), color: '', style: '',
                        anchor: '', anchorPre: '', anchorSuf: '', pushedAt: 0,
                        pushedCell: '' }, patch));
                    addedNotes += 1;
                }
            });
        });
    });
    if (addedThemes || addedBooks || addedNotes || relinked) {
        return rebuild(books, s.chapters, notes, now, s.bookmarks, themes);
    }
    return s;
}

// ---------- 章节 ----------
function addChapter(state, bookId, patch) {
    const s = normalize(state);
    if (s.chapters.length >= MAX_CHAPTERS) return s;
    const p = isObj(patch) ? patch : {};
    const at = tsOf(p.createdAt) || Date.now();
    const id = str(p.id) || newId('ch');
    const raw = {
        id: id,
        bookId: str(bookId),
        title: p.title,
        parentId: clampParent(s.chapters, str(p.parentId), id),
        order: p.order,
        createdAt: at
    };
    return rebuild(s.books, s.chapters.concat([raw]), s.notes, at, s.bookmarks, s.themes);
}

function updateChapter(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.chapters.some(function (c) { return c.id === key; })) return s;
    const p = isObj(patch) ? patch : {};
    const others = s.chapters.filter(function (c) { return c.id !== key; });
    const chapters = s.chapters.map(function (c) {
        if (c.id !== key) return c;
        const next = Object.assign({}, c, p, { id: key });
        if (p.parentId !== undefined) next.parentId = clampParent(others, str(p.parentId), key);
        return next;
    });
    return rebuild(s.books, chapters, s.notes, s.updatedAt, s.bookmarks, s.themes);
}

// 删父章节时子章节上抬为顶层，绝不级联删
function removeChapter(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.chapters.some(function (c) { return c.id === key; })) return s;
    const chapters = s.chapters
        .filter(function (c) { return c.id !== key; })
        .map(function (c) { return c.parentId === key ? Object.assign({}, c, { parentId: '' }) : c; });
    return rebuild(s.books, chapters, s.notes, s.updatedAt, s.bookmarks, s.themes);
}

// ---------- 笔记 ----------
function addNote(state, patch) {
    const s = normalize(state);
    if (s.notes.length >= MAX_NOTES) return s;
    const p = isObj(patch) ? patch : {};
    const at = tsOf(p.createdAt) || Date.now();
    const raw = {
        id: str(p.id) || newId('nt'),
        mode: p.mode,
        bookId: p.bookId,
        themeId: p.themeId,
        bookTitle: p.bookTitle,
        type: p.type,
        quote: p.quote,
        text: p.text,
        page: p.page,
        tags: p.tags,
        chapterId: p.chapterId,
        anchor: p.anchor,
        color: p.color,
        style: p.style,
        createdAt: at,
        pushedAt: p.pushedAt,
        pushedCell: p.pushedCell,
        sourceQuoteId: p.sourceQuoteId
    };
    return rebuild(s.books, s.chapters, s.notes.concat([raw]), at, s.bookmarks, s.themes);
}

function updateNote(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.notes.some(function (n) { return n.id === key; })) return s;
    const p = isObj(patch) ? patch : {};
    const notes = s.notes.map(function (n) {
        return n.id === key ? Object.assign({}, n, p, { id: key }) : n;
    });
    return rebuild(s.books, s.chapters, notes, s.updatedAt, s.bookmarks, s.themes);
}

function removeNote(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key) return s;
    const notes = s.notes.filter(function (n) { return n.id !== key; });
    if (notes.length === s.notes.length) return s;
    return rebuild(s.books, s.chapters, notes, s.updatedAt, s.bookmarks, s.themes);
}

// 只写 pushedAt / pushedCell；已回写过的重复调用保持原值不覆盖
function markPushed(state, id, cell, at) {
    const s = normalize(state);
    const key = str(id);
    if (!key) return s;
    const ts = num(at, 0, TS_MAX, 0);
    const c = clean(cell, CELL_MAX);
    let hit = false;
    const notes = s.notes.map(function (n) {
        if (n.id !== key || n.pushedAt > 0) return n;
        hit = true;
        return Object.assign({}, n, { pushedAt: ts, pushedCell: c });
    });
    if (!hit) return s;
    return rebuild(s.books, s.chapters, notes, s.updatedAt, s.bookmarks, s.themes);
}

// ---------- 看板 ----------
// ---------- 书签：只做「位置收藏」，不参与九格回写 ----------
function addBookmark(state, patch) {
    const s = normalize(state);
    if (s.bookmarks.length >= MAX_BOOKMARKS) return s;
    const p = isObj(patch) ? patch : {};
    const anchor = normBookAnchor(p.anchor);
    if (!anchor || !str(p.bookId)) return s;
    // 同一位置只留一条：重复点不该叠
    const dup = s.bookmarks.filter(function (m) {
        return m.bookId === str(p.bookId) && m.anchor === anchor;
    })[0];
    if (dup) return s;
    const raw = {
        id: str(p.id) || newId('bm'),
        bookId: str(p.bookId),
        chapterIndex: num(anchor.split(':')[0], 0, 9999, 0),
        anchor: anchor,
        label: p.label,
        createdAt: tsOf(p.createdAt) || Date.now()
    };
    return rebuild(s.books, s.chapters, s.notes, raw.createdAt, s.bookmarks.concat([raw]), s.themes);
}

function removeBookmark(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key) return s;
    return rebuild(s.books, s.chapters, s.notes, s.updatedAt,
        s.bookmarks.filter(function (m) { return m.id !== key; }), s.themes);
}

function bookmarksOf(state, bookId) {
    const s = normalize(state);
    const id = str(bookId);
    return s.bookmarks.filter(function (m) { return !id || m.bookId === id; })
        .slice()
        .sort(function (a, z) {
            if (a.chapterIndex !== z.chapterIndex) return a.chapterIndex - z.chapterIndex;
            return String(a.anchor).localeCompare(String(z.anchor));
        });
}

function board(state, themeBooks) {
    const s = normalize(state);
    const tb = Array.isArray(themeBooks) ? themeBooks : []; // 原样带上，不复制进 state
    const notes = s.notes;
    const tagCount = {};
    const noteCountByBook = {};
    let highlights = 0, ideas = 0, pushed = 0, leisureNotes = 0, themeNotes = 0;
    const now = new Date(); // 契约明确要求：thisMonth 按当前年月比较
    const yy = now.getFullYear();
    const mm = now.getMonth() + 1;
    let thisMonth = 0;
    notes.forEach(function (n) {
        if (n.type === 'highlight') highlights += 1;
        if (n.type === 'idea') ideas += 1;
        if (n.pushedAt > 0) pushed += 1;
        if (n.mode === 'leisure') {
            leisureNotes += 1;
            noteCountByBook[n.bookId] = (noteCountByBook[n.bookId] || 0) + 1;
        } else {
            themeNotes += 1;
        }
        n.tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; });
        const d = new Date(n.createdAt);
        if (!isNaN(d.getTime()) && d.getFullYear() === yy && d.getMonth() + 1 === mm) thisMonth += 1;
    });
    const stats = {
        books: s.books.length,
        notes: notes.length,
        highlights: highlights,
        ideas: ideas,
        pushed: pushed,
        leisureNotes: leisureNotes,
        themeNotes: themeNotes,
        tagCount: Object.keys(tagCount).length,
        bookmarks: s.bookmarks.length,
        thisMonth: thisMonth
    };
    const books = s.books.map(function (b) {
        return Object.assign({}, b, {
            pct: pctOf(b.done, b.total),
            progressText: b.done + '/' + b.total + ' ' + b.unit,
            statusLabel: BOOK_STATUS_LABEL[b.status] || '待读',
            noteCount: noteCountByBook[b.id] || 0,
            hasFile: !!b.filePath,
            orphan: false
        });
    });
    const recent = notes.slice().sort(byCreatedDesc).slice(0, 8);
    const tagTop = Object.keys(tagCount).map(function (t) { return { tag: t, count: tagCount[t] }; })
        .sort(function (a, b) { return b.count - a.count || (a.tag < b.tag ? -1 : (a.tag > b.tag ? 1 : 0)); })
        .slice(0, 12);
    return { stats: stats, books: books, themes: s.themes, themeBooks: tb, recent: recent, tagTop: tagTop };
}

// ---------- 查询 ----------
function notesQuery(state, opts) {
    const s = normalize(state);
    const o = isObj(opts) ? opts : {};
    const bookIds = {};
    s.books.forEach(function (b) { bookIds[b.id] = true; });
    const modeStr = str(o.mode);
    const fMode = (modeStr === 'leisure' || modeStr === 'theme') ? modeStr : '';
    const fType = (o.type === 'highlight' || o.type === 'note' || o.type === 'idea' || o.type === 'link') ? o.type : '';
    const fBookId = str(o.bookId);
    const fThemeId = str(o.themeId);
    const fTag = normTagOne(o.tag);
    const kw = clean(o.keyword, KEYWORD_MAX).toLowerCase();

    const items = s.notes.filter(function (n) {
        if (fMode && n.mode !== fMode) return false;
        if (fType && n.type !== fType) return false;
        if (fBookId && n.bookId !== fBookId) return false;
        if (fThemeId && n.themeId !== fThemeId) return false;
        if (fTag && n.tags.indexOf(fTag) < 0) return false;
        if (typeof o.pushed === 'boolean' && (n.pushedAt > 0) !== o.pushed) return false;
        if (kw) {
            const hay = (n.quote + ' ' + n.text + ' ' + n.bookTitle + ' ' + n.tags.join(' ')).toLowerCase();
            if (hay.indexOf(kw) < 0) return false;
        }
        return true;
    }).sort(byCreatedDesc);

    const decorated = items.map(function (n) {
        return Object.assign({}, n, {
            typeLabel: NOTE_TYPE_LABEL[n.type] || '',
            modeLabel: MODE_LABEL[n.mode] || '',
            pushed: n.pushedAt > 0,
            orphan: n.mode === 'leisure' && !bookIds[n.bookId]
        });
    });

    // 分面统计基于过滤后的 items，按 count 倒序
    function tally(keysOf, field) {
        const m = {};
        decorated.forEach(function (n) {
            keysOf(n).forEach(function (k) { if (k) m[k] = (m[k] || 0) + 1; });
        });
        return Object.keys(m).map(function (k) {
            const row = { count: m[k] };
            row[field] = k;
            return row;
        }).sort(function (a, b) {
            return b.count - a.count || (a[field] < b[field] ? -1 : (a[field] > b[field] ? 1 : 0));
        });
    }
    const byTag = tally(function (n) { return n.tags; }, 'tag');
    const byBook = tally(function (n) { return [n.bookId]; }, 'bookId');
    const byType = tally(function (n) { return [n.type]; }, 'type');
    const mm = {};
    decorated.forEach(function (n) {
        const k = monthKey(n.createdAt);
        if (k) mm[k] = (mm[k] || 0) + 1;
    });
    const byMonth = Object.keys(mm).map(function (k) { return { month: k, count: mm[k] }; })
        .sort(function (a, b) { return a.month < b.month ? 1 : (a.month > b.month ? -1 : 0); });

    return { items: decorated, total: decorated.length, byTag: byTag, byBook: byBook, byType: byType, byMonth: byMonth };
}

// ---------- 日记行（纯函数，不依赖 state）----------
function noteToDiaryLine(note) {
    const n = isObj(note) ? note : {};
    const mode = MODE_LABEL[str(n.mode)] || MODE_LABEL.leisure;
    const title = clean(n.bookTitle, BOOK_TITLE_MAX);
    const page = num(n.page, 0, PAGE_MAX, 0);
    const tags = normTags(n.tags);
    const quote = clean(n.quote, QUOTE_MAX);
    const text = clean(n.text, TEXT_MAX);

    let line = '【读书·' + mode + '】《' + title + '》';
    if (page > 0) line += 'p.' + page;                       // 紧跟书名，无空格
    if (tags.length) line += ' ' + tags.map(function (t) { return '#' + t; }).join(' ');
    if (quote) line += ' 「' + quote + '」→ ' + text;
    else line += ' ' + text;
    line = line.replace(/\s+/g, ' ').trim();
    if (line.length > 300) line = line.slice(0, 300) + '…';
    return line;
}

// ---------- 导出 Markdown ----------
function exportMarkdown(state, themeBooks) {
    const s = normalize(state);
    const lines = ['# 读书笔记', ''];
    if (!s.notes.length) {
        lines.push('还没有笔记');
        return lines.join('\n') + '\n';
    }
    const tb = Array.isArray(themeBooks) ? themeBooks : [];
    const themeTitleByBook = {};
    tb.forEach(function (r) {
        if (isObj(r) && r.bookId && !themeTitleByBook[r.bookId]) themeTitleByBook[r.bookId] = str(r.title);
    });
    const bookTitleById = {};
    s.books.forEach(function (b) { bookTitleById[b.id] = b.title; });

    function lineOf(n) {
        const date = dateOf(n.createdAt) || '未记日期';
        const body = n.quote ? ('「' + n.quote + '」' + (n.text ? ' → ' + n.text : '')) : n.text;
        const bits = [];
        if (n.page > 0) bits.push('p.' + n.page);
        n.tags.forEach(function (t) { bits.push('#' + t); });
        const tail = bits.length ? '（' + bits.join(' ') + '）' : '';
        return '- **' + date + '** 【' + (NOTE_TYPE_LABEL[n.type] || '') + '】' + body + tail;
    }

    MODES.forEach(function (mode) {
        const inMode = s.notes.filter(function (n) { return n.mode === mode; }).sort(byCreatedDesc);
        if (!inMode.length) return;
        lines.push('## ' + MODE_LABEL[mode], '');
        const groups = [];
        const byKey = {};
        inMode.forEach(function (n) {
            const title = n.bookTitle || bookTitleById[n.bookId] || themeTitleByBook[n.bookId] || n.bookId || '未分类';
            if (!byKey[title]) { byKey[title] = { title: title, notes: [] }; groups.push(byKey[title]); }
            byKey[title].notes.push(n);
        });
        groups.forEach(function (g) {
            lines.push('### 《' + g.title + '》', '');
            g.notes.forEach(function (n) { lines.push(lineOf(n)); });
            lines.push('');
        });
    });

    const tagCount = {};
    s.notes.forEach(function (n) { n.tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; }); });
    const tags = Object.keys(tagCount).sort(function (a, b) {
        return tagCount[b] - tagCount[a] || (a < b ? -1 : (a > b ? 1 : 0));
    });
    lines.push('## 按标签', '');
    if (!tags.length) {
        lines.push('- （暂无标签）', '');
    } else {
        tags.forEach(function (t) { lines.push('- #' + t + ' (' + tagCount[t] + ')'); });
        lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n';
}

// ---------- 按 id 并集合并：只补不改，幂等 ----------
function mergeSection(state, section) {
    const s = normalize(state);
    const incoming = normalize(section);
    let added = 0;
    ['themes', 'books', 'chapters', 'notes', 'bookmarks'].forEach(function (key) {
        const seen = {};
        s[key].forEach(function (r) { seen[r.id] = true; });
        incoming[key].forEach(function (r) {
            if (seen[r.id]) return;
            s[key].push(r);
            seen[r.id] = true;
            added += 1;
        });
    });
    return { state: normalize(s), added: added };
}

module.exports = {
    MODES: MODES,
    MODE_LABEL: MODE_LABEL,
    NOTE_TYPES: NOTE_TYPES,
    NOTE_TYPE_LABEL: NOTE_TYPE_LABEL,
    PROMPTS: PROMPTS,
    MAX_BOOKS: MAX_BOOKS,
    MAX_THEMES: MAX_THEMES,
    MAX_NOTES: MAX_NOTES,
    MAX_CHAPTERS: MAX_CHAPTERS,
    MAX_TAGS: MAX_TAGS,
    MAX_BOOKMARKS: MAX_BOOKMARKS,
    HL_COLORS: HL_COLORS,
    NOTE_STYLES: NOTE_STYLES,
    FILE_EXTS: FILE_EXTS,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    empty: empty,
    normalize: normalize,
    meta: meta,
    addTheme: addTheme,
    updateTheme: updateTheme,
    removeTheme: removeTheme,
    importGrowthThemes: importGrowthThemes,
    addBook: addBook,
    updateBook: updateBook,
    removeBook: removeBook,
    advanceBook: advanceBook,
    setBookStatus: setBookStatus,
    addChapter: addChapter,
    updateChapter: updateChapter,
    removeChapter: removeChapter,
    addNote: addNote,
    updateNote: updateNote,
    removeNote: removeNote,
    markPushed: markPushed,
    addBookmark: addBookmark,
    removeBookmark: removeBookmark,
    bookmarksOf: bookmarksOf,
    board: board,
    notesQuery: notesQuery,
    noteToDiaryLine: noteToDiaryLine,
    exportMarkdown: exportMarkdown,
    mergeSection: mergeSection,
    bookByPath: bookByPath,
    hasPath: hasPath
};
