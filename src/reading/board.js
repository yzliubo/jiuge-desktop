'use strict';
// 读书笔记（md_reading）——纯领域层，CommonJS，零第三方依赖。
//
// ---- 三张表各自是什么 ----
// books    : 休闲娱乐 + 主题阅读共用本表。themeId 为空 = 休闲书；非空 = 归属该主题，
//            因此主题书同样有 filePath，能用同一个阅读窗口、章节、进度、三阶九问与笔记落库。
// themes    : 主题（学习单元）本身。
//            【P0-1 单一事实源，2026-11-16】主题与主题书单**只有** md_reading 这一份权威数据：
//            themes[] 是主题表，books[].themeId 是书与主题的唯一关联。
//            md_growth 里的旧主题书单不再被任何视图透传，只作一次性迁移来源
//            （importGrowthThemes，幂等）与只读历史；迁没迁完用 growthAudit 核对。
//            注意 board() 已没有第二个参数——曾经那个 themeBooks 形参就是把旧书单
//            塞进图书馆视图的那条路，同一份书单因此有三份说法。
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
// 书架分组：分组不是独立实体，就是书上的一个名字。分组清单由 board() 从 books 派生，
// 这样「重命名 / 删除分组」只是一次批量改字段，不用给 state 添一张表、也不用改 rebuild 的所有调用点。
const MAX_GROUPS = 20;
const GROUP_MAX = 24;
// P2-1 虚拟书架：书上直接挂多值标签（≤8），与 group 并存。
// group 是「这一摞放哪」，tags 是「它身上有哪些钩子」——同一本书只能在一个分组，
// 却可以同时是「污水处理」「待精读」。规则集合（shelves）完全由这两个字段派生，不另建表。
const MAX_SHELVES = 12;
const SHELF_KEY_MAX = 40;
// P2-4 书库根目录：整库换机的唯一开关。
// books 里存 rootId + relPath，filePath 仍是「本机绝对路径」（所有既有消费方不用改），
// 换机器只要改 root.path，一次把所有书的 filePath 重新拼出来。
const MAX_ROOTS = 6;
const ROOT_LABEL_MAX = 24;
const REL_PATH_MAX = 500;

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
// 书籍指纹：文件大小 + 首 64KB 的 SHA-256（十六进制 64 位）。由主进程算、领域层只存。
// 它是书在「改了名 / 换了盘」之后还能被认出来的那一半身份——另一半是永不改变的 bookId。
const FP_MAX = 64;
const FP_RE = /^[0-9a-f]{64}$/;
// 回写行的可反查标记：〔rd:<noteId>〕。纯文本、跟在行尾，冻结 utils 的 search/cleanLen 照旧可用。
// 之所以放行尾而不是行首：行首的「【读书·休闲娱乐】」是既有检索与分组认的前缀，不能让位。
const REF_MARK_RE = /〔rd:([A-Za-z0-9_-]{1,80})〕/g;
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
    return { version: 1, books: [], chapters: [], notes: [], bookmarks: [], themes: [], roots: [], updatedAt: 0 };
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
        // 内容指纹：只认 64 位小写十六进制，脏值一律丢掉（宁可没有身份，也不留半截指纹）
        fingerprint: FP_RE.test(str(o.fingerprint)) ? str(o.fingerprint) : '',
        format: clean(o.format, FORMAT_MAX),
        coverId: clean(o.coverId, ID_MAX),
        source: str(o.source) === 'file' ? 'file' : 'manual',
        startedAt: validDate(o.startedAt),
        finishedAt: status === 'done' ? validDate(o.finishedAt) : '',
        createdAt: num(o.createdAt, 0, TS_MAX, 0),
        // 书架顺序：拖动排序写这里，越小越靠前。老数据全为 0，回落到 createdAt 次序。
        order: num(o.order, -99999, 99999, 0),
        // 最近在读：翻开阅读窗 / 同步进度时刷新。**毫秒时间戳**而非日期串——
        // 同一天里先后翻过几本，只有时间戳才排得出「刚才那本」。
        lastReadAt: num(o.lastReadAt, 0, TS_MAX, 0),
        // 书架分组与收藏：空串 = 未分组；收藏只是个布尔视图，不另建「收藏夹」表
        group: clean(o.group, GROUP_MAX),
        // 多值标签（P2-1）：与 group 并存的钩子，规则集合靠它派生；一本书最多 8 个
        tags: normTags(o.tags),
        // 书库根（P2-4）：rootId + relPath 是可搬家的那半边，filePath 是本机解析结果
        rootId: clean(o.rootId, ID_MAX),
        relPath: relPathOf(o.relPath),
        favorite: o.favorite === true
    };
}

// 书库根：一条记录 = 一个「书都放在这个目录下」的声明。
// 只存路径与名字，不扫盘、不建索引——扫盘是主进程的事，领域层永远只算字符串。
function normRoot(r, seen, fallbackId) {
    const o = isObj(r) ? r : {};
    const p = clip(o.path, PATH_MAX);
    if (!p) return null;
    return {
        id: uniqueId(clean(o.id, ID_MAX) || fallbackId, seen),
        label: clean(o.label, ROOT_LABEL_MAX),
        path: p,
        createdAt: num(o.createdAt, 0, TS_MAX, 0)
    };
}

// ---------- 路径：根 + 相对路径（P2-4）----------
// 全部是纯字符串运算，不碰 fs：领域层不认识盘符，只认识「分隔符」。
// 相对路径**统一存正斜杠**，这样备份拿到另一套系统上也读得懂；
// 拼回绝对路径时才换成本机习惯的分隔符（看根路径自己用的是什么）。
function normSlashes(p) { return str(p).replace(/\\/g, '/'); }
function sepOf(p) { return str(p).indexOf('\\') >= 0 ? '\\' : '/'; }
// 相对路径的规范形：正斜杠、无前导斜杠、无空段、无 . 段。存进去的是这个形，
// 拼回去的也只会是这个形——否则「同一个文件两种相对路径」会让指纹判重之外的判重全失效。
function relPathOf(v) {
    const raw = normSlashes(clip(v, REL_PATH_MAX));
    const segs = raw.split('/').filter(function (x) { return !!x && x !== '.'; });
    return segs.slice(0, 64).join('/');
}
function joinRoot(rootPath, relPath) {
    const base = str(rootPath).replace(/[\\/]+$/, '');
    const rel = relPathOf(relPath);
    if (!base) return '';
    if (!rel) return base;
    const sep = sepOf(rootPath);
    return base + sep + rel.split('/').join(sep);
}
// book 落在 root 下时返回相对路径（保留原大小写），否则返回空串。
// 比较用忽略大小写的正斜杠形式：Windows 的大小写不敏感不该让同一本书认不出来。
function underRoot(filePath, rootPath) {
    const f = normSlashes(filePath);
    const r = normSlashes(rootPath).replace(/\/+$/, '');
    if (!r || !f) return '';
    const pre = r + '/';
    if (f.slice(0, pre.length).toLowerCase() !== pre.toLowerCase()) return '';
    return f.slice(pre.length);
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
        // P2-3 两套目录的统一锚点：「ch-<书内节序>」。
        // chapters[] 是**我自己的大纲**（可以跳着读、可以只列要精读的几章、可以两层）；
        // 书自带的 NCX/nav 是**出版方的结构**（只读、由 epub.js 解析）。
        // 两者不合并成一张表，靠这个锚点对齐：填了锚点的自填章节，点一下就能跳到书里那一节。
        anchor: normChapterAnchor(o.anchor),
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

// 章节锚点：与阅读窗同一个写法 `ch-<书内节序>`（reader.js 里 chapterId 也是这个形）。
// 与书签的 "章序:比例" 不同——那是「位置」，这只是「哪一节」，所以不带小数。
function normChapterAnchor(v) {
    const s = str(v).trim();
    const m = /^ch-(\d{1,4})$/.exec(s);
    if (!m) return '';
    return 'ch-' + String(Math.trunc(Number(m[1])));
}
function chapterSeq(anchor) {
    const s = str(anchor);
    const m = /^ch-(\d{1,4})$/.exec(s);
    return m ? Number(m[1]) : -1;
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
    const roots = take(src.roots, normRoot, MAX_ROOTS, 'rt');
    const books = take(src.books, normBook, MAX_BOOKS, 'bk');
    // P2-4 路径解析：normalize 是唯一一处把「根 + 相对路径」换成绝对路径的地方。
    // ① 有 rootId + relPath → 现拼（换机只改 root.path，所有书跟着走）
    // ② 只有绝对路径 → 若落在某个已声明根下，就地补 rootId/relPath（老库零手工纳入）
    const rootById = {};
    roots.forEach(function (r) { rootById[r.id] = r; });
    books.forEach(function (b) {
        const root = b.rootId ? rootById[b.rootId] : null;
        if (root && b.relPath) {
            b.filePath = joinRoot(root.path, b.relPath);
            return;
        }
        if (b.rootId || !b.filePath) return;
        for (let i = 0; i < roots.length; i += 1) {
            const rel = underRoot(b.filePath, roots[i].path);
            if (rel) {
                b.rootId = roots[i].id;
                b.relPath = rel;
                return;
            }
        }
    });
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
        roots: roots,
        updatedAt: num(src.updatedAt, 0, TS_MAX, 0)
    };
}

// 写操作统一出口：所有列表都重新过一遍 normalize，保证状态始终规范。
// roots 必须跟着一起传：漏传一次，整库的根目录声明就没了（golden 里有逐函数守卫）。
function rebuild(books, chapters, notes, updatedAt, bookmarks, themes, roots) {
    return normalize({
        version: 1, themes: themes || [], books: books, chapters: chapters, notes: notes,
        bookmarks: bookmarks || [], roots: roots || [], updatedAt: updatedAt
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

// 按内容指纹找同一本书：文件被改名或搬走之后，路径断了，指纹还在。
// 只认合法指纹，空串一律不匹配——否则所有「没算过指纹」的老书会互相认成同一本。
function bookByFingerprint(state, fp) {
    const s = normalize(state);
    const key = str(fp).toLowerCase();
    if (!FP_RE.test(key)) return null;
    return s.books.filter(function (b) { return b.fingerprint === key; })[0] || null;
}
function hasFingerprint(state, fp) { return !!bookByFingerprint(state, fp); }

// 重新关联：只换 filePath（顺带刷新大小/扩展名/指纹），**bookId 一个字都不动**。
// 这是「关联会突然断」的正解——笔记、章节、书签、按书筛选全都挂在 bookId 上，
// 只要 id 不变，换盘换目录等于什么都没发生。
// 校验（文件存在 / 扩展名 / 指纹是否仍是同一本）需要读盘，由主进程做完再传进来；
// 这里只守住纯函数边界：不存在的书不动、空路径不写、指纹非法不落。
function relinkBook(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.books.some(function (b) { return b.id === key; })) return s;
    const p = isObj(patch) ? patch : {};
    const nextPath = clip(p.filePath, PATH_MAX);
    if (!nextPath) return s;
    const fp = str(p.fingerprint).toLowerCase();
    const books = s.books.map(function (b) {
        if (b.id !== key) return b;
        return Object.assign({}, b, {
            filePath: nextPath,
            fileExt: clean(p.fileExt, EXT_MAX).toLowerCase().replace(/^\.+/, '') || b.fileExt,
            // 大小不明时保留旧值：宁可标一个可能过期的大小，也不把「100MB 上限」判断弄丢
            fileSize: num(p.fileSize, 0, MAX_FILE_BYTES, b.fileSize) || b.fileSize,
            fingerprint: FP_RE.test(fp) ? fp : b.fingerprint,
            format: clean(p.format, FORMAT_MAX) || b.format || clean(p.fileExt, EXT_MAX).toUpperCase()
        });
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

function addBook(state, patch) {
    const s = normalize(state);
    if (s.books.length >= MAX_BOOKS) return s;
    const p = isObj(patch) ? patch : {};
    const at = tsOf(p.createdAt) || Date.now();
    // 新书排最前：取现有最小 order 再减一，不动别人，只给自己一个更小的位。
    // 刚拖进来的那本立刻在第一屏，不用滚到底去找（对齐 mybook 1.2.13「读完的书自动排第一」）。
    const minOrder = s.books.reduce(function (m, b) { return Math.min(m, b.order); }, 0);
    const order = (typeof p.order === 'number' && isFinite(p.order))
        ? num(p.order, -99999, 99999, 0)
        : Math.max(-99999, minOrder - 1);
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
        fingerprint: p.fingerprint,
        format: p.format,
        coverId: p.coverId,
        source: p.source,
        startedAt: p.startedAt,
        finishedAt: p.finishedAt,
        lastReadAt: p.lastReadAt,
        order: order,
        group: p.group,
        favorite: p.favorite,
        createdAt: at
    };
    return rebuild(s.books.concat([raw]), s.chapters, s.notes, at, s.bookmarks, s.themes, s.roots);
}

function updateBook(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.books.some(function (b) { return b.id === key; })) return s;
    const p = isObj(patch) ? patch : {};
    const books = s.books.map(function (b) {
        return b.id === key ? Object.assign({}, b, p, { id: key }) : b;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

// 只删书和它的章节；笔记一条不动（orphan 由 notesQuery 派生）
function removeBook(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key) return s;
    const books = s.books.filter(function (b) { return b.id !== key; });
    if (books.length === s.books.length) return s;
    const chapters = s.chapters.filter(function (c) { return c.bookId !== key; });
    return rebuild(books, chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
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
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
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
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

// 拖动排序：ids 是按新顺序排好的书 id。
// 只认书架上真有的 id；未出现在 ids 里的书保持原相对次序接在后面——
// 渲染层只传了「当前筛选后看得见的那些」时，被筛掉的不会因此被挤没。
function reorderBooks(state, ids) {
    const s = normalize(state);
    const list = Array.isArray(ids) ? ids.map(str) : [];
    const pos = {};
    let n = 0;
    list.forEach(function (id) {
        if (id && !(id in pos)) pos[id] = n;
        n += 1;
    });
    if (!n) return s;
    const head = [];
    const tail = [];
    s.books.forEach(function (b) {
        if (b.id in pos) head.push(Object.assign({}, b, { order: pos[b.id] }));
        else tail.push(b);
    });
    if (!head.length) return s;
    let maxOrder = head.reduce(function (m, b) { return Math.max(m, b.order); }, -1);
    const rest = tail.map(function (b) {
        maxOrder += 1;
        return Object.assign({}, b, { order: maxOrder });
    });
    return rebuild(head.concat(rest), s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

// 再读一遍：只重置进度与「读完」状态，书签 / 标注 / 章节 / 笔记一条不动。
// 与 removeBook 的分界很清楚——这本还在书架上，只是从头再读一遍。
function rereadBook(state, id, at) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.books.some(function (b) { return b.id === key; })) return s;
    const ts = tsOf(at) || Date.now();
    const books = s.books.map(function (b) {
        if (b.id !== key) return b;
        return Object.assign({}, b, {
            done: 0, status: 'reading', finishedAt: '', startedAt: b.startedAt || '', lastReadAt: ts
        });
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

// 最近在读打点：翻开阅读窗 / 同步进度时调用。只改时间，不碰进度与状态。
function touchBook(state, id, at) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.books.some(function (b) { return b.id === key; })) return s;
    const ts = tsOf(at) || Date.now();
    const books = s.books.map(function (b) {
        return b.id === key ? Object.assign({}, b, { lastReadAt: ts }) : b;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

// ---------- 多值标签（P2-1）----------
// group 是「放哪一摞」，tags 是「身上有哪些钩子」。一本书只能在一个分组里，
// 但可以同时是「污水处理」「待精读」「有电子书」。规则集合（board().shelves）全部由它派生，
// 因此「加一个标签」= 改一个字段，不新增表、不复制书籍记录。
function setBookTags(state, id, tags) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.books.some(function (b) { return b.id === key; })) return s;
    const next = normTags(tags);
    const books = s.books.map(function (b) {
        return b.id === key ? Object.assign({}, b, { tags: next }) : b;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}
// 单条增删：满了不再加（返回原 state），删不存在的标签也不动——
// 界面上的「+ / ×」各点一次就是一次明确的意图，不需要再猜。
function addBookTag(state, id, tag) {
    const s = normalize(state);
    const b = s.books.filter(function (x) { return x.id === str(id); })[0];
    if (!b) return s;
    const t = normTagOne(tag);
    if (!t || b.tags.length >= MAX_TAGS || b.tags.indexOf(t) >= 0) return s;
    return setBookTags(s, b.id, b.tags.concat([t]));
}
function removeBookTag(state, id, tag) {
    const s = normalize(state);
    const b = s.books.filter(function (x) { return x.id === str(id); })[0];
    if (!b) return s;
    const t = normTagOne(tag);
    if (!t || b.tags.indexOf(t) < 0) return s;
    return setBookTags(s, b.id, b.tags.filter(function (x) { return x !== t; }));
}

// ---------- 书库根目录（P2-4）----------
// 一条根记录只做一件事：声明「我的书都在这棵树下」。
// 书身上存 rootId + relPath，filePath 由 normalize 现拼——换机器只要改 root.path，
// 60 本书的路径一次全对，不用逐本「重新关联」。
function rootsOf(state) { return normalize(state).roots.slice(); }

function addRoot(state, patch) {
    const s = normalize(state);
    if (s.roots.length >= MAX_ROOTS) return s;
    const p = isObj(patch) ? patch : {};
    const path = clip(p.path, PATH_MAX).replace(/[\\/]+$/, '');
    if (!path) return s;
    const key = normSlashes(path).toLowerCase();
    if (s.roots.some(function (r) { return normSlashes(r.path).toLowerCase() === key; })) return s;
    const raw = {
        id: str(p.id) || newId('rt'),
        label: p.label,
        path: path,
        createdAt: tsOf(p.createdAt) || Date.now()
    };
    // 走 rebuild 而不是 push：normalize 的 ② 步会顺手把落在该根下的老书补上 rootId/relPath
    return rebuild(s.books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots.concat([raw]));
}

// 改根路径 = 整库搬家。所有挂在它下面的书按 relPath 重算 filePath（不读盘、不校验存在性，
// 校验是主进程的事）。改 label 走同一条路，只是没有书需要重算。
function relocateRoot(state, id, newPath) {
    const s = normalize(state);
    const key = str(id);
    const root = s.roots.filter(function (r) { return r.id === key; })[0];
    if (!root) return s;
    const path = clip(newPath, PATH_MAX).replace(/[\\/]+$/, '');
    if (!path) return s;
    const roots = s.roots.map(function (r) {
        return r.id === key ? Object.assign({}, r, { path: path }) : r;
    });
    const books = s.books.map(function (b) {
        if (b.rootId !== key || !b.relPath) return b;
        return Object.assign({}, b, { filePath: joinRoot(path, b.relPath) });
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, roots);
}

function updateRoot(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    const root = s.roots.filter(function (r) { return r.id === key; })[0];
    if (!root) return s;
    const p = isObj(patch) ? patch : {};
    const path = str(p.path) ? str(p.path) : root.path;
    const next = relocateRoot(s, key, path);
    if (!str(p.label)) return next;
    const roots = next.roots.map(function (r) {
        return r.id === key ? Object.assign({}, r, { label: clean(p.label, ROOT_LABEL_MAX) }) : r;
    });
    return rebuild(next.books, next.chapters, next.notes, next.updatedAt, next.bookmarks, next.themes, roots);
}

// 删根只解绑，不删书、也不清 filePath：书还在原地，只是不再跟着某个根搬。
// 反过来的「删根顺带删书」是最容易让人丢数据的设计，坚决不做。
function removeRoot(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.roots.some(function (r) { return r.id === key; })) return s;
    const roots = s.roots.filter(function (r) { return r.id !== key; });
    const books = s.books.map(function (b) {
        if (b.rootId !== key) return b;
        return Object.assign({}, b, { rootId: '', relPath: '' });
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, roots);
}

// 给主进程用：本书此刻应该去哪个绝对路径读。根被删/被改名时以 filePath 为准。
function resolveBookPath(state, id) {
    const s = normalize(state);
    const b = s.books.filter(function (x) { return x.id === str(id); })[0];
    return b ? b.filePath : '';
}

// ---------- 书架分组 / 收藏（V3.5）----------
// 分组不是独立实体：书上一个 group 名字而已，清单由 board() 从 books 派生。
// 好处是「重命名 / 删除分组」只是一次批量改字段，不用往 state 里添表、不用改 rebuild 的所有调用点，
// 也不会出现「分组还在、书没了」或反过来「书的 groupId 指向一个不存在的 id」这类脏数据。
function groupNames(s) {
    const seen = {};
    const out = [];
    s.books.forEach(function (b) {
        if (b.group && !seen[b.group]) { seen[b.group] = true; out.push(b.group); }
    });
    return out;
}

function setBookGroup(state, id, group) {
    const s = normalize(state);
    const key = str(id);
    const name = clean(group, GROUP_MAX);
    if (!key || !s.books.some(function (b) { return b.id === key; })) return s;
    const names = groupNames(s);
    // 新分组要占一个名额；已有分组、清空分组都不占
    if (name && names.indexOf(name) < 0 && names.length >= MAX_GROUPS) return s;
    const books = s.books.map(function (b) {
        return b.id === key ? Object.assign({}, b, { group: name }) : b;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

function setBookFavorite(state, id, on) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.books.some(function (b) { return b.id === key; })) return s;
    const yes = on === true || on === 1 || on === '1' || on === 'true';
    const books = s.books.map(function (b) {
        return b.id === key ? Object.assign({}, b, { favorite: yes }) : b;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

// 重命名 / 合并 / 清空：目标名已存在就是合并，目标为空就是清空（等于 removeGroup）。
// 无论哪一种都只改标签，一本书都不会被删掉。
function renameGroup(state, from, to) {
    const s = normalize(state);
    const a = clean(from, GROUP_MAX);
    const b = clean(to, GROUP_MAX);
    if (!a || a === b) return s;
    if (!s.books.some(function (x) { return x.group === a; })) return s;
    if (b && groupNames(s).indexOf(b) >= 0 && groupNames(s).length - 1 >= MAX_GROUPS) return s;
    const books = s.books.map(function (x) {
        return x.group === a ? Object.assign({}, x, { group: b }) : x;
    });
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

function removeGroup(state, name) { return renameGroup(state, name, ''); }

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
    return rebuild(s.books, s.chapters, s.notes, at, s.bookmarks, s.themes.concat([raw]), s.roots);
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
    return rebuild(s.books, s.chapters, s.notes, s.updatedAt, s.bookmarks, themes, s.roots);
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
    return rebuild(books, s.chapters, s.notes, s.updatedAt, s.bookmarks, themes, s.roots);
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
        return rebuild(books, s.chapters, notes, now, s.bookmarks, themes, s.roots);
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
        anchor: p.anchor,
        createdAt: at
    };
    return rebuild(s.books, s.chapters.concat([raw]), s.notes, at, s.bookmarks, s.themes, s.roots);
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
    return rebuild(s.books, chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

// 删父章节时子章节上抬为顶层，绝不级联删
function removeChapter(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.chapters.some(function (c) { return c.id === key; })) return s;
    const chapters = s.chapters
        .filter(function (c) { return c.id !== key; })
        .map(function (c) { return c.parentId === key ? Object.assign({}, c, { parentId: '' }) : c; });
    return rebuild(s.books, chapters, s.notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
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
    return rebuild(s.books, s.chapters, s.notes.concat([raw]), at, s.bookmarks, s.themes, s.roots);
}

function updateNote(state, id, patch) {
    const s = normalize(state);
    const key = str(id);
    if (!key || !s.notes.some(function (n) { return n.id === key; })) return s;
    const p = isObj(patch) ? patch : {};
    const notes = s.notes.map(function (n) {
        return n.id === key ? Object.assign({}, n, p, { id: key }) : n;
    });
    return rebuild(s.books, s.chapters, notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

function removeNote(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key) return s;
    const notes = s.notes.filter(function (n) { return n.id !== key; });
    if (notes.length === s.notes.length) return s;
    return rebuild(s.books, s.chapters, notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
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
    return rebuild(s.books, s.chapters, notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
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
    return rebuild(s.books, s.chapters, s.notes, raw.createdAt, s.bookmarks.concat([raw]), s.themes, s.roots);
}

function removeBookmark(state, id) {
    const s = normalize(state);
    const key = str(id);
    if (!key) return s;
    return rebuild(s.books, s.chapters, s.notes, s.updatedAt,
        s.bookmarks.filter(function (m) { return m.id !== key; }), s.themes, s.roots);
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

// 一行书的派生字段：休闲书架、主题书行、阅读窗口三处共用同一口径，
// 免得「同一本书在列表里有进度、在主题下没有」。只在渲染时派生，绝不写回 state。
function decorateRow(b, noteCount) {
    return Object.assign({}, b, {
        pct: pctOf(b.done, b.total),
        progressText: b.done + '/' + b.total + ' ' + b.unit,
        statusLabel: BOOK_STATUS_LABEL[b.status] || '待读',
        noteCount: noteCount || 0,
        hasFile: !!b.filePath,
        orphan: false
    });
}

// P0-1（2026-11-16）：主题书单只剩一个来源——md_reading.books 里 themeId 非空的记录。
// 旧签名 board(state, themeBooks) 的第二参已删：它当年是把 md_growth 的旧书单原样透传给视图，
// 结果同一份书单在「学习成长」「图书馆左栏」「导出汇总」三处各有各的说法。
// 旧数据仍在 md_growth 里（只读历史），要进图书馆得走 importGrowthThemes 一次性迁移。
function board(state) {
    const s = normalize(state);
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
        } else {
            themeNotes += 1;
        }
        // V3.13：主题书的笔记也要计数——主题行同样要显示「N 条笔记」，
        // 之前只数 leisure，主题下的书永远显示 0 条，看着像笔记没存上。
        noteCountByBook[n.bookId] = (noteCountByBook[n.bookId] || 0) + 1;
        n.tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; });
        const d = new Date(n.createdAt);
        if (!isNaN(d.getTime()) && d.getFullYear() === yy && d.getMonth() + 1 === mm) thisMonth += 1;
    });
    // V3.13：一本算一类。主题阅读常常一次导入十几份同主题文件，
    // 混进「休闲娱乐阅读」的书架会把随手翻的书整片顶走，统计头也会虚高。
    let leisureCount = 0;
    s.books.forEach(function (b) { if (!b.themeId) leisureCount += 1; });
    const stats = {
        books: leisureCount,
        themeBooks: s.books.length - leisureCount,
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
    // 书架次序：order 升序 → 同 order 按 createdAt 升序。
    // order 是本轮新字段，老数据全是 0，于是自然回落到「先加的在前」，与加这个字段之前的观感一致。
    const ordered = s.books.slice().sort(function (a, b) {
        return (a.order - b.order) || (a.createdAt - b.createdAt);
    });
    const rowsById = {};
    const books = ordered.map(function (b) {
        const row = decorateRow(b, noteCountByBook[b.id] || 0);
        rowsById[b.id] = row;
        return row;
    });
    // 书架（休闲）与主题书分开给：books 保持「全部」不破坏既有消费方，
    // 书架渲染只取 leisureBooks —— 用户看到的书架里不再混主题书。
    const leisureBooks = books.filter(function (b) { return !b.themeId; });
    // 主题分组：按 themes 顺序，未登记的主题排在最后（书上的 themeId 是权威，不是主题表）
    const groupsById = {};
    const themeGroups = [];
    s.themes.forEach(function (t) {
        const g = { themeId: t.id, themeTitle: t.title || '', note: t.note || '', rows: [] };
        groupsById[t.id] = g;
        themeGroups.push(g);
    });
    ordered.forEach(function (b) {
        const tid = String(b.themeId || '');
        if (!tid) return;
        let g = groupsById[tid];
        if (!g) {
            g = { themeId: tid, themeTitle: '未命名主题', note: '', rows: [] };
            groupsById[tid] = g;
            themeGroups.push(g);
        }
        g.rows.push(rowsById[b.id]);
    });
    const recent = notes.slice().sort(byCreatedDesc).slice(0, 8);
    const tagTop = Object.keys(tagCount).map(function (t) { return { tag: t, count: tagCount[t] }; })
        .sort(function (a, b) { return b.count - a.count || (a.tag < b.tag ? -1 : (a.tag > b.tag ? 1 : 0)); })
        .slice(0, 12);
    // 书架分组 / 收藏夹：只给标签条用的派生清单，不改 books 顺序。
    // 只数休闲书：分组与收藏是「书架」的功能，主题书身上即便残留旧标签也不该出现在这里。
    const gCount = {};
    let favoriteCount = 0;
    leisureBooks.forEach(function (b) {
        if (b.group) gCount[b.group] = (gCount[b.group] || 0) + 1;
        if (b.favorite) favoriteCount += 1;
    });
    const groups = Object.keys(gCount).map(function (name) {
        return { name: name, count: gCount[name] };
    }).sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)); });
    // P2-1 虚拟书架：规则集合。**只出 id 列表**（引用），不复制任何书籍记录——
    // 于是改一本书的状态，所有书架同一刻跟着变，不存在「书架里还存着旧副本」这种鬼。
    // 规则固定成六条 + 标签集合，不做用户自定义规则（那需要一张真表，本轮零新键的底线）。
    const nowMs = now.getTime();
    const RECENT_MS = 30 * 86400000;
    const shelfDefs = [
        { key: 'reading', label: '在读', test: function (b) { return b.status === 'reading'; } },
        { key: 'todo', label: '待读', test: function (b) { return b.status === 'todo'; } },
        { key: 'done', label: '读完', test: function (b) { return b.status === 'done'; } },
        { key: 'noted', label: '有笔记', test: function (b) { return (noteCountByBook[b.id] || 0) > 0; } },
        { key: 'nofile', label: '只有笔记', test: function (b) { return !b.filePath; } },
        { key: 'recent', label: '最近读过', test: function (b) { return b.lastReadAt > 0 && nowMs - b.lastReadAt <= RECENT_MS; } }
    ];
    const shelves = [];
    shelfDefs.forEach(function (d) {
        const ids = ordered.filter(d.test).map(function (b) { return b.id; });
        shelves.push({ key: d.key, kind: 'rule', label: d.label, count: ids.length, ids: ids });
    });
    // 标签集合：每个标签就是一摞（与 group 并存，一本书可以出现在多摞里）
    const byTagIds = {};
    ordered.forEach(function (b) {
        b.tags.forEach(function (t) { (byTagIds[t] || (byTagIds[t] = [])).push(b.id); });
    });
    Object.keys(byTagIds)
        .sort(function (a, b) { return byTagIds[b].length - byTagIds[a].length || (a < b ? -1 : (a > b ? 1 : 0)); })
        .slice(0, MAX_SHELVES)
        .forEach(function (t) {
            shelves.push({ key: 'tag:' + t, kind: 'tag', label: '#' + t, count: byTagIds[t].length, ids: byTagIds[t] });
        });
    return {
        stats: stats, books: books, leisureBooks: leisureBooks, themeGroups: themeGroups,
        themes: s.themes,
        groups: groups, favoriteCount: favoriteCount, recent: recent, tagTop: tagTop,
        shelves: shelves.slice(0, MAX_SHELVES + 6),
        roots: s.roots
    };
}

// ---------- 查询 ----------
function notesQuery(state, opts) {
    const s = normalize(state);
    const o = isObj(opts) ? opts : {};
    const bookIds = {};
    s.books.forEach(function (b) { bookIds[b.id] = true; });
    const themeIds = {};
    s.themes.forEach(function (t) { themeIds[t.id] = true; });
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
            // orphan 只说「引用的东西不在了」，不按 mode 分。原先只查 leisure 书，
            // 主题书的笔记在书被删之后照样显示正常，等于把断链藏起来了。
            orphan: (!!n.bookId && !bookIds[n.bookId]) || (!!n.themeId && !themeIds[n.themeId])
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
    if (line.length > 280) line = line.slice(0, 280) + '…';
    // 可反查标记放最后：正文截断也不会把它截掉，人读时是一小段方括号，
    // 机器读时它就是「这一行从哪条笔记来的」唯一凭据（反查见 refIdsIn）。
    const id = clean(n.id, ID_MAX);
    if (id) line += ' 〔rd:' + id + '〕';
    return line;
}

// 从任意正文里取出所有 rd: 引用（回写行 → 笔记的唯一反向通道）。
// 纯函数、不改文本，冻结 utils 不需要认识这个标记。
function refIdsIn(text) {
    const s = str(text);
    const out = [];
    const seen = {};
    let m;
    REF_MARK_RE.lastIndex = 0;
    while ((m = REF_MARK_RE.exec(s)) !== null) {
        const id = m[1];
        if (id && !seen[id]) { seen[id] = true; out.push(id); }
    }
    return out;
}
// 去掉标记之后的「人读文本」：右栏做摘要、导出正文时用，不破坏原文。
function stripRefMarks(text) {
    return str(text).replace(REF_MARK_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
}

// ---------- 导出 Markdown ----------
// P0-1：书名的兜底只从 s.books 取。原先第三个来源是 md_growth 的旧书单，
// 一份汇总里的书名可能来自一份早就没人维护的旧数据——这正是「三份表示」里最难查的那份。
function exportMarkdown(state, bookId) {
    const s = normalize(state);
    // bookId 非空时只导出这一本（对齐 mybook「标注统一导出」的按书口径）；
    // 空则导出全库汇总。两条路共用同一套排版，不维护第二份格式。
    const only = str(bookId);
    const pool = only ? s.notes.filter(function (n) { return n.bookId === only; }) : s.notes;
    const scopeBook = only ? s.books.filter(function (b) { return b.id === only; })[0] : null;
    const lines = [scopeBook ? ('# 《' + scopeBook.title + '》读书笔记') : '# 读书笔记', ''];
    if (!pool.length) {
        lines.push(only ? '这本书还没有笔记' : '还没有笔记');
        return lines.join('\n') + '\n';
    }
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
        const inMode = pool.filter(function (n) { return n.mode === mode; }).sort(byCreatedDesc);
        if (!inMode.length) return;
        lines.push('## ' + MODE_LABEL[mode], '');
        const groups = [];
        const byKey = {};
        inMode.forEach(function (n) {
            const title = n.bookTitle || bookTitleById[n.bookId] || n.bookId || '未分类';
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
    pool.forEach(function (n) { n.tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; }); });
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

// ---------- 书目清单导出（P2-2）----------
// 只导**元数据 + 路径**：书名 / 作者 / 状态 / 进度 / 主题 / 分组 / 标签 / 根 / 相对路径 / 笔记数。
// 正文一个字都不带——库里本来就没有正文，也不该在这条路上把书的内容拆出来。
// 三种形态共用一张行表，所以三种格式的书目永远一致（不会有「CSV 里有、OPDS 里没有」）。
function listRows(s) {
    const themeById = {};
    s.themes.forEach(function (t) { themeById[t.id] = t.title; });
    const rootById = {};
    s.roots.forEach(function (r) { rootById[r.id] = r; });
    const noteCount = {};
    s.notes.forEach(function (n) { noteCount[n.bookId] = (noteCount[n.bookId] || 0) + 1; });
    return s.books.slice().sort(function (a, b) {
        return (a.order - b.order) || (a.createdAt - b.createdAt);
    }).map(function (b) {
        const root = rootById[b.rootId];
        return {
            id: b.id,
            title: b.title,
            author: b.author,
            status: b.status,
            statusLabel: BOOK_STATUS_LABEL[b.status] || '待读',
            progress: b.done + '/' + b.total + ' ' + b.unit,
            pct: pctOf(b.done, b.total),
            theme: b.themeId ? (themeById[b.themeId] || '') : '',
            group: b.group,
            tags: b.tags.slice(),
            fileExt: b.fileExt,
            fileSize: b.fileSize,
            root: root ? (root.label || root.path) : '',
            relPath: b.relPath,
            filePath: b.filePath,
            noteCount: noteCount[b.id] || 0,
            createdAt: b.createdAt,
            finishedAt: b.finishedAt,
            lastReadAt: b.lastReadAt
        };
    });
}

function csvCell(v) {
    const s = str(v).replace(/[\r\n]+/g, ' ');
    return '"' + s.replace(/"/g, '""') + '"';
}
function xmlEsc(v) {
    return str(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function isoOf(ms) {
    const n = num(ms, 0, TS_MAX, 0);
    if (!n) return '';
    const d = new Date(n);
    return isNaN(d.getTime()) ? '' : d.toISOString();
}

// format: 'csv' | 'json' | 'opds'，其余一律按 csv（不猜、不抛）。
// 返回 { format, mime, ext, text, rows } —— 落盘由主进程走唯一那条 file:save。
function exportList(state, format) {
    const s = normalize(state);
    const f0 = str(format).toLowerCase();
    const f = (f0 === 'json' || f0 === 'opds') ? f0 : 'csv';
    const rows = listRows(s);
    if (f === 'json') {
        return {
            format: f, mime: 'application/json', ext: 'json', rows: rows.length,
            text: JSON.stringify({
                schema: 'jiuge.books/v1',
                count: rows.length,
                // 说明写进文件本身：拿到这份清单的人要知道它没有正文
                note: '只含书目元数据与路径，不含书籍正文',
                books: rows
            }, null, 2) + '\n'
        };
    }
    if (f === 'opds') {
        const head = '<?xml version="1.0" encoding="utf-8"?>\n'
            + '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" '
            + 'xmlns:opds="http://opds-spec.org/2010/catalog">\n'
            + '  <id>urn:jiuge:books</id>\n'
            + '  <title>九格 · 书目</title>\n'
            + '  <updated>' + (isoOf(s.updatedAt) || '1970-01-01T00:00:00.000Z') + '</updated>\n'
            + '  <author><name>九格</name></author>\n';
        const body = rows.map(function (r) {
            const cats = r.tags.map(function (t) { return '    <category term="' + xmlEsc(t) + '"/>\n'; }).join('');
            const type = r.fileExt === 'pdf' ? 'application/pdf'
                : (r.fileExt === 'epub' ? 'application/epub+zip' : 'text/plain');
            // 没有文件的书只出条目、不出 acquisition 链接：给一个打不开的链接等于骗阅读器
            const link = r.filePath
                ? '    <link rel="http://opds-spec.org/acquisition" href="file:///'
                  + xmlEsc(normSlashes(r.filePath).replace(/^\/+/, '')) + '" type="' + type + '"/>\n'
                : '';
            return '  <entry>\n'
                + '    <id>urn:jiuge:book:' + xmlEsc(r.id) + '</id>\n'
                + '    <title>' + xmlEsc(r.title) + '</title>\n'
                + '    <updated>' + (isoOf(r.lastReadAt || r.createdAt) || '1970-01-01T00:00:00.000Z') + '</updated>\n'
                + (r.author ? '    <author><name>' + xmlEsc(r.author) + '</name></author>\n' : '')
                + '    <dc:format>' + xmlEsc(r.fileExt ? r.fileExt.toUpperCase() : '无电子书') + '</dc:format>\n'
                + '    <dc:extent>' + xmlEsc(r.progress) + '</dc:extent>\n'
                + cats + link
                + '  </entry>\n';
        }).join('');
        return {
            format: f, mime: 'application/atom+xml;profile=opds-catalog', ext: 'xml', rows: rows.length,
            text: head + body + '</feed>\n'
        };
    }
    const cols = ['title', 'author', 'statusLabel', 'progress', 'pct', 'theme', 'group', 'tags',
        'fileExt', 'fileSize', 'root', 'relPath', 'filePath', 'noteCount',
        'createdAt', 'finishedAt', 'lastReadAt'];
    const header = cols.map(csvCell).join(',');
    const lines = rows.map(function (r) {
        return cols.map(function (c) {
            return csvCell(c === 'tags' ? r.tags.join(' ') : (c === 'pct' ? r.pct + '%' : r[c]));
        }).join(',');
    });
    // UTF-8 BOM：Excel 打开中文 CSV 不加 BOM 会整列乱码，这是唯一一个「格式细节比纯文本更重要」的地方
    return {
        format: f, mime: 'text/csv;charset=utf-8', ext: 'csv', rows: rows.length,
        text: '\ufeff' + header + '\n' + lines.join('\n') + '\n'
    };
}

// ---------- 引用完整性：断链体检 ----------
// 只判结构，不碰磁盘——「文件还在不在」由主进程补（它才有 fs）。
// 判定口径只有一句：**有引用、但被引用的东西不在了**。空引用不算断链
// （随手记一条没有出处的想法是合法的），否则每条手写笔记都会被标成病。
function refIndex(s) {
    const idx = { books: {}, themes: {}, chapters: {}, roots: {} };
    s.books.forEach(function (b) { idx.books[b.id] = b; });
    s.themes.forEach(function (t) { idx.themes[t.id] = t; });
    s.chapters.forEach(function (c) { idx.chapters[c.id] = c; });
    s.roots.forEach(function (r) { idx.roots[r.id] = r; });
    return idx;
}

function danglingOf(s) {
    const idx = refIndex(s);
    const notes = s.notes.filter(function (n) {
        return (!!n.bookId && !idx.books[n.bookId]) || (!!n.themeId && !idx.themes[n.themeId]);
    });
    const chapters = s.chapters.filter(function (c) { return !!c.bookId && !idx.books[c.bookId]; });
    const bookmarks = s.bookmarks.filter(function (m) { return !idx.books[m.bookId]; });
    const books = s.books.filter(function (b) { return !!b.themeId && !idx.themes[b.themeId]; });
    // P2-4：根被删了但书还挂着它的 id。这类不算急病（filePath 还在，书照样能打开），
    // 但必须在体检里看得见——否则「这书应该跟着根走」这件事会静默失效。
    const roots = s.books.filter(function (b) { return !!b.rootId && !idx.roots[b.rootId]; });
    return { notes: notes, chapters: chapters, bookmarks: bookmarks, books: books, roots: roots };
}

// 只补不删：导入时绝不动用户已有的笔记，只如实报告「这批数据里有多少条引用落空」，
// 让人自己决定是回滚备份还是做一次修复。
function mergeSection(state, section) {
    const s = normalize(state);
    const incoming = normalize(section);
    let added = 0;
    ['themes', 'books', 'chapters', 'notes', 'bookmarks', 'roots'].forEach(function (key) {
        const seen = {};
        s[key].forEach(function (r) { seen[r.id] = true; });
        incoming[key].forEach(function (r) {
            if (seen[r.id]) return;
            s[key].push(r);
            seen[r.id] = true;
            added += 1;
        });
    });
    const next = normalize(s);
    const d = danglingOf(next);
    const report = {
        danglingNotes: d.notes.length,
        danglingChapters: d.chapters.length,
        danglingBookmarks: d.bookmarks.length,
        danglingBooks: d.books.length,
        danglingRoots: d.roots.length,
        clean: !(d.notes.length || d.chapters.length || d.bookmarks.length || d.books.length || d.roots.length),
        // 只带 id 与书名/摘句，够界面列出「哪几条落空了」，不复制整条笔记
        samples: d.notes.slice(0, 20).map(function (n) {
            return { id: n.id, bookId: n.bookId, themeId: n.themeId, bookTitle: n.bookTitle, text: (n.quote || n.text || '').slice(0, 40) };
        })
    };
    return { state: next, added: added, report: report };
}

// 书库体检（P0-4）。对标 calibre 的 check_library：**只报告，不自动改数据**。
// 五项：断链 / 指纹重复 / 同名异路径 / 主题书无主题 / 没有出处的笔记。
// counts 用于界面上的四个数字，detail 用于展开看是哪几条。
function audit(state) {
    const s = normalize(state);
    const d = danglingOf(s);
    const byFp = {};
    s.books.forEach(function (b) {
        if (!b.fingerprint) return;
        (byFp[b.fingerprint] || (byFp[b.fingerprint] = [])).push({ id: b.id, title: b.title, filePath: b.filePath });
    });
    const dupFingerprints = Object.keys(byFp).filter(function (k) { return byFp[k].length > 1; })
        .map(function (k) { return { fingerprint: k, books: byFp[k] }; });
    // 同名异路径：同名不算病，「同名但指向两个不同文件」才是——后者多半是同一本被登记了两遍
    const byTitle = {};
    s.books.forEach(function (b) {
        const k = b.title;
        (byTitle[k] || (byTitle[k] = [])).push({ id: b.id, filePath: b.filePath, fingerprint: b.fingerprint });
    });
    const dupTitles = Object.keys(byTitle).filter(function (k) {
        const rows = byTitle[k];
        if (rows.length < 2) return false;
        const paths = {};
        let n = 0;
        rows.forEach(function (r) {
            const p = String(r.filePath || '').toLowerCase();
            if (!p || paths[p]) return;
            paths[p] = true;
            n += 1;
        });
        return n > 1 || (rows.length > 1 && n === 0);
    }).map(function (k) { return { title: k, books: byTitle[k] }; });
    return {
        counts: {
            books: s.books.length,
            notes: s.notes.length,
            themes: s.themes.length,
            danglingNotes: d.notes.length,
            danglingChapters: d.chapters.length,
            danglingBookmarks: d.bookmarks.length,
            danglingBooks: d.books.length,
            danglingRoots: d.roots.length,
            dupFingerprints: dupFingerprints.length,
            dupTitles: dupTitles.length,
            notesNoSource: s.notes.filter(function (n) { return !n.bookId && !n.themeId; }).length
        },
        dangling: {
            notes: d.notes.slice(0, 50).map(function (n) { return { id: n.id, bookId: n.bookId, themeId: n.themeId, bookTitle: n.bookTitle }; }),
            chapters: d.chapters.slice(0, 50).map(function (c) { return { id: c.id, bookId: c.bookId, title: c.title }; }),
            bookmarks: d.bookmarks.slice(0, 50).map(function (m) { return { id: m.id, bookId: m.bookId, label: m.label }; }),
            books: d.books.slice(0, 50).map(function (b) { return { id: b.id, themeId: b.themeId, title: b.title }; }),
            roots: d.roots.slice(0, 50).map(function (b) { return { id: b.id, rootId: b.rootId, title: b.title }; })
        },
        dupFingerprints: dupFingerprints.slice(0, 20),
        dupTitles: dupTitles.slice(0, 20)
    };
}

// 修断链：只清「指向不存在的东西」的那一个字段，书/笔记本身一条不删。
// 返回 changes 供 restoreDangling 逆操作——撤销不靠再存一份快照，靠这份改动清单本身。
// 撤销只在本次会话有效；关窗即失效，这是有意的（不新增数据键）。
function repairDangling(state) {
    const s = normalize(state);
    const idx = refIndex(s);
    const changes = [];
    const notes = s.notes.map(function (n) {
        let next = n;
        if (n.bookId && !idx.books[n.bookId]) {
            changes.push({ coll: 'notes', id: n.id, field: 'bookId', from: n.bookId });
            next = Object.assign({}, next, { bookId: '' });
        }
        if (n.themeId && !idx.themes[n.themeId]) {
            changes.push({ coll: 'notes', id: n.id, field: 'themeId', from: n.themeId });
            next = Object.assign({}, next, { themeId: '' });
        }
        return next;
    });
    const books = s.books.map(function (b) {
        if (b.themeId && !idx.themes[b.themeId]) {
            changes.push({ coll: 'books', id: b.id, field: 'themeId', from: b.themeId });
            return Object.assign({}, b, { themeId: '' });
        }
        return b;
    });
    if (!changes.length) return { state: s, changes: [], fixed: 0 };
    return { state: rebuild(books, s.chapters, notes, s.updatedAt, s.bookmarks, s.themes, s.roots), changes: changes, fixed: changes.length };
}

function restoreDangling(state, changes) {
    const s = normalize(state);
    const list = Array.isArray(changes) ? changes : [];
    if (!list.length) return s;
    const byColl = { notes: {}, books: {} };
    list.forEach(function (c) {
        if (!isObj(c) || !byColl[c.coll] || !str(c.id) || !str(c.field)) return;
        (byColl[c.coll][c.id] || (byColl[c.coll][c.id] = {}))[c.field] = str(c.from);
    });
    const notes = s.notes.map(function (n) {
        const patch = byColl.notes[n.id];
        return patch ? Object.assign({}, n, patch) : n;
    });
    const books = s.books.map(function (b) {
        const patch = byColl.books[b.id];
        return patch ? Object.assign({}, b, patch) : b;
    });
    return rebuild(books, s.chapters, notes, s.updatedAt, s.bookmarks, s.themes, s.roots);
}

// ---------- 检索索引（P1-1）----------
// 纯派生：把五张表摊成一张可检索的行表，主界面与图书馆共用同一批关键词。
// 正文不进来（正文在书里，不在库里），索引的是「元数据 + 摘录 + 想法 + 标签」——
// 与 Zotero Quick Search 的口径一致：metadata + tags + 你写下的文字。
function searchIndex(state) {
    const s = normalize(state);
    const rows = [];
    s.books.forEach(function (b) {
        rows.push({
            type: 'book', id: b.id, title: b.title,
            text: [b.author, b.format, b.note, b.group].join(' ').trim(),
            tags: b.tags.slice(), bookId: b.id, bookTitle: b.title, themeId: b.themeId,
            createdAt: b.createdAt, status: b.status, pct: pctOf(b.done, b.total),
            progressText: b.done + '/' + b.total + ' ' + b.unit, hasFile: !!b.filePath
        });
    });
    s.themes.forEach(function (t) {
        rows.push({
            type: 'theme', id: t.id, title: t.title, text: t.note || '', tags: [],
            bookId: '', bookTitle: '', themeId: t.id, createdAt: t.createdAt
        });
    });
    s.notes.forEach(function (n) {
        rows.push({
            type: 'note', id: n.id, title: n.bookTitle || '',
            text: [n.quote, n.text].join(' ').trim(), tags: n.tags,
            bookId: n.bookId, bookTitle: n.bookTitle, themeId: n.themeId,
            createdAt: n.createdAt, noteType: n.type, mode: n.mode,
            typeLabel: NOTE_TYPE_LABEL[n.type] || '', modeLabel: MODE_LABEL[n.mode] || ''
        });
    });
    return rows;
}

// ---------- 阅读再曝光（P1-4）----------
// Readwise 的 Daily Review 落地版：不要求用户主动想起书，让书自己回来找你。
// at 由调用方传（毫秒），与 board.stats.thisMonth 一样是唯一允许读时钟的地方之外的口径。
function resurface(state, at) {
    const s = normalize(state);
    const now = tsOf(at) || Date.now();
    const WEEK = 7 * 86400000;
    const MONTH = 30 * 86400000;
    const recent = s.notes.filter(function (n) { return n.createdAt > 0 && now - n.createdAt <= WEEK; })
        .sort(byCreatedDesc);
    const reading = s.books.filter(function (b) { return b.status === 'reading'; });
    const stale = reading.filter(function (b) { return !b.lastReadAt || now - b.lastReadAt > MONTH; })
        .map(function (b) {
            return {
                id: b.id, title: b.title, pct: pctOf(b.done, b.total),
                progressText: b.done + '/' + b.total + ' ' + b.unit,
                lastReadAt: b.lastReadAt,
                days: b.lastReadAt > 0 ? Math.floor((now - b.lastReadAt) / 86400000) : -1
            };
        })
        .sort(function (a, b) {
            // 从没翻过的排最前（days = -1）：登记了却一次没打开，比「读到一半放下」更需要被推一把；
            // 其余按「越久没读越靠前」，同样久的先露进度浅的那本（离重新上手更近）。
            const an = a.days < 0 ? 1 : 0;
            const bn = b.days < 0 ? 1 : 0;
            if (an !== bn) return bn - an;
            if (a.days !== b.days) return b.days - a.days;
            return a.pct - b.pct;
        });
    return {
        recent: recent.slice(0, 5).map(function (n) {
            return { id: n.id, bookId: n.bookId, bookTitle: n.bookTitle, quote: n.quote, text: n.text, createdAt: n.createdAt };
        }),
        recentCount: recent.length,
        readingCount: reading.length,
        stale: stale.slice(0, 3),
        staleCount: stale.length
    };
}

// ---------- 旧书单迁移核对（P0-1 的收尾）----------
// md_growth 的旧主题书单不再参与任何展示，但「迁没迁完」必须能被查。
// legacyBooks 由主进程用 themeBooksFlat() 从 md_growth 只读派生后传进来——
// 领域层不直接读别的键，这样「旧数据只在一个地方派生」这件事仍然成立。
// 只读比对，不写任何一边；要迁就走 importGrowthThemes（幂等）。
function growthAudit(state, legacyBooks) {
    const s = normalize(state);
    const bookIds = {};
    s.books.forEach(function (b) { bookIds[b.id] = true; });
    const rows = [];
    (Array.isArray(legacyBooks) ? legacyBooks : []).forEach(function (r) {
        if (!isObj(r)) return;
        const migratedId = 'gthbk-' + str(r.themeId) + '-' + str(r.bookId);
        rows.push({
            themeId: 'gth-' + str(r.themeId), themeTitle: str(r.themeTitle),
            legacyBookId: str(r.bookId), title: str(r.title),
            migrated: !!bookIds[migratedId], migratesTo: migratedId
        });
    });
    const pending = rows.filter(function (r) { return !r.migrated; });
    const themeSeen = {};
    rows.forEach(function (r) { themeSeen[r.themeId] = true; });
    return {
        legacyBooks: rows.length,
        migratedBooks: rows.length - pending.length,
        pendingBooks: pending.length,
        pending: pending.slice(0, 50),
        legacyThemes: Object.keys(themeSeen).length
    };
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
    // 书架整理三件套（2026-11-14）：拖动排序 / 再读一遍 / 最近在读打点
    reorderBooks: reorderBooks,
    rereadBook: rereadBook,
    touchBook: touchBook,
    // 书架分组 / 收藏（V3.5）
    setBookGroup: setBookGroup,
    setBookFavorite: setBookFavorite,
    renameGroup: renameGroup,
    removeGroup: removeGroup,
    MAX_GROUPS: MAX_GROUPS,
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
    refIdsIn: refIdsIn,
    stripRefMarks: stripRefMarks,
    exportMarkdown: exportMarkdown,
    mergeSection: mergeSection,
    // P0-2 书籍身份：指纹判重 + 重新关联（id 不变）
    bookByFingerprint: bookByFingerprint,
    hasFingerprint: hasFingerprint,
    relinkBook: relinkBook,
    // P2-1 虚拟书架：多值标签（规则集合由 board().shelves 派生）
    MAX_SHELVES: MAX_SHELVES,
    setBookTags: setBookTags,
    addBookTag: addBookTag,
    removeBookTag: removeBookTag,
    // P2-2 书目清单：CSV / JSON / OPDS 共用一张行表
    listRows: listRows,
    exportList: exportList,
    // P2-3 两套目录的锚点：ch-<书内节序>
    chapterSeq: chapterSeq,
    // P2-4 书库根目录：根 + 相对路径，整库换机只改一条
    MAX_ROOTS: MAX_ROOTS,
    rootsOf: rootsOf,
    addRoot: addRoot,
    updateRoot: updateRoot,
    relocateRoot: relocateRoot,
    removeRoot: removeRoot,
    resolveBookPath: resolveBookPath,
    joinRoot: joinRoot,
    underRoot: underRoot,
    // P0-4 书库体检：只报告 + 可逆修复
    audit: audit,
    repairDangling: repairDangling,
    restoreDangling: restoreDangling,
    // P1-1 检索合流 / P1-4 再曝光 / P0-1 迁移核对
    searchIndex: searchIndex,
    resurface: resurface,
    growthAudit: growthAudit,
    bookByPath: bookByPath,
    hasPath: hasPath
};
