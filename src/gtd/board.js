// 九格手记 · GTD 工作台领域模块
//
// 为什么单独成模块，而不是扩展 utils/work-board.js：
//   1. src/utils 是与小程序源项目**逐字节一致**的等价基线（verify 第 1 条按 SHA256 对拍），
//      动它就等于亲手拆掉「桌面版没有偷偷改业务算法」这条证据线；
//   2. GTD 的本质是**跨天持续流转的清单**（收件箱 → 下一步 → 等待 → 日程 → 将来），
//      而 work-board 的任务挂在「当天日记记录」的 workBoard 字段上，按天归属；
//      把池子塞进某一天，既拿不到全局视角，还会被 work-board.normalize 削字段。
// 因此：数据单独存 md_gtd 单键，由主进程仓储读写；导出时由主进程在 exportBackup
// 结果里注入 gtd 段，导入时先取该段再委托原 importBackup（utils 一行不改）。
//
// 纯函数、不碰 wxStorage、不联网：所有时间由调用方传入 today 字符串，便于测试。

const TITLE_MAX = 80;
const NOTE_MAX = 300;
const WAITING_MAX = 40;
const CONTEXT_MAX = 12;
const PROJECT_MAX = 24;
const MAX_TASKS = 200;
const MAX_PROJECTS = 40;
// 情境名单上限：比内置 6 个多留一倍余量，够个人用到「@电脑/手机/车/书房」这类细分
const MAX_CONTEXTS = 24;
const MAX_REVIEWS = 60;
// 子项上限：一个父任务下超过这个数，说明该建项目而不是继续拆；
// 也防止某条脏数据把 200 条任务全挂到一个人下面，界面直接折叠不动
const MAX_CHILDREN = 30;
// 只允许两层（父 → 子）。三层以上在 GTD 里通常是「事项/项目」的混淆，
// 在窄栏界面里也无法阅读；旧数据里更深的层级会被压平，不会丢任务
const PARENT_DEPTH = 2;
// 今日六点：六个空位。它是「今天做什么」的唯一入口，多了就不叫六点了
const FOCUS_MAX = 6;
// 焦点项可以标注「这件事属于哪一格」，「完成 → 格」时直接写进那一格
const CELL_KEYS = ['work', 'money', 'health', 'relation', 'future', 'emotion', 'dream', 'growth', 'free'];

const STATUS = ['inbox', 'next', 'waiting', 'scheduled', 'someday', 'done'];

const STATUS_LABEL = {
    inbox: '收件箱',
    next: '下一步',
    waiting: '等待',
    scheduled: '日程',
    someday: '将来也许',
    done: '已完成',
};

const STATUS_HINT = {
    inbox: '先记下来，暂不判断——收件箱是要被清空的，不是第二个待办列表',
    next: '一个能立刻做掉的单一动作，必须带上下文',
    waiting: '等别人，写清等谁 / 等什么，否则一周后你也不知道该催什么',
    scheduled: '有明确日期的事，日期到了才出现在今天',
    someday: '想做但不确定什么时候做，每周回顾扫一眼就够',
    done: '已完成，保留 7 天便于回看',
};

// 预置上下文：GTD 的 @context 是「在什么状态下能做」，不是分类标签。
const CONTEXTS = ['@电脑', '@电话', '@外出', '@会议', '@家', '@阅读'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DONE_KEEP_DAYS = 7;

let seq = 0;

function taskId() {
    seq += 1;
    return 'g_' + Date.now().toString(36) + '_' + seq;
}

function projectId() {
    seq += 1;
    return 'p_' + Date.now().toString(36) + '_' + seq;
}

function str(value) {
    return String(value === undefined || value === null ? '' : value);
}

function clean(value, max) {
    return str(value).replace(/\r/g, '').trim().slice(0, max);
}

function num(value) {
    const n = Number(value);
    return isFinite(n) && n > 0 ? n : 0;
}

function pad(n) {
    return n < 10 ? '0' + n : String(n);
}

function todayOf(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}

// 日期差：按 UTC 天数算，避开夏令时与本地时区偏移
function dayNumber(dateStr) {
    const p = str(dateStr).split('-');
    if (p.length !== 3) return 0;
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
}

function diffDays(fromStr, toStr) {
    const a = dayNumber(fromStr);
    const b = dayNumber(toStr);
    if (!a || !b) return 0;
    return Math.round(b - a);
}

// ISO 周键：周一为起点，与 diary-store.weekStartDate 的口径一致
function weekKeyOf(dateStr) {
    const p = str(dateStr).split('-');
    if (p.length !== 3) return '';
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    const wd = d.getDay();
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (wd === 0 ? 6 : wd - 1));
    const first = new Date(monday.getFullYear(), 0, 1);
    const offset = Math.round((dayNumber(todayOf(monday)) - dayNumber(todayOf(first))) / 7);
    return todayOf(monday).slice(0, 4) + '-W' + pad(offset + 1);
}

// 把任意深度的父链压平成两层：沿原始 parentId 往上跳，直到找到第一个
// 「自己也不再往上」的祖先，让本任务直接挂到它下面。
// 成环、断链（父已不存在）、超出深度上限 → 一律回到顶层，任务不丢。
// 用原始映射表而不是逐条改写后的值，保证结果与任务在数组里的顺序无关。
function resolveParent(id, rawParent) {
    let cur = str(rawParent[id]);
    const visited = {};
    visited[id] = true;
    for (let i = 0; i < PARENT_DEPTH + 2 && cur; i++) {
        if (visited[cur]) return '';
        if (!Object.prototype.hasOwnProperty.call(rawParent, cur)) return '';
        visited[cur] = true;
        const up = str(rawParent[cur]);
        if (!up) return cur;
        cur = up;
    }
    return '';
}

function empty() {
    return { version: 1, tasks: [], projects: [], contexts: [], reviews: [], focus: { date: '', items: [] } };
}

function normStatus(raw, doneAt) {
    const s = str(raw);
    if (s === 'done') return 'done';
    if (STATUS.indexOf(s) >= 0) return s;
    // 没有任何状态字段的老数据：归「下一步」而不是「收件箱」——
    // 收件箱是「还没想清楚」的地方，把历史任务全倒进去等于制造一次假警报。
    return 'next';
}

function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const seen = {};

    const base = (Array.isArray(src.tasks) ? src.tasks : [])
        .slice(0, MAX_TASKS)
        .map(function (t) {
            const title = clean(t && t.title, TITLE_MAX);
            if (!title) return null;
            let id = str(t && t.id);
            if (!id || seen[id]) id = taskId();
            seen[id] = true;
            const status = normStatus(t && t.status, t && t.doneAt);
            const createdAt = num(t && t.createdAt) || Date.now();
            const doneAt = status === 'done' ? (num(t && t.doneAt) || createdAt) : 0;
            const due = clean(t && t.dueDate, 10);
            return {
                id: id,
                title: title,
                status: status,
                context: clean(t && t.context, CONTEXT_MAX),
                project: clean(t && t.project, PROJECT_MAX),
                dueDate: DATE_RE.test(due) ? due : '',
                waitingFor: clean(t && t.waitingFor, WAITING_MAX),
                note: clean(t && t.note, NOTE_MAX),
                source: clean(t && t.source, 32),
                createdAt: createdAt,
                updatedAt: num(t && t.updatedAt) || createdAt,
                doneAt: doneAt,
                // 等待计时起点：旧数据没有这个字段时退回 createdAt（宁可算长一点，
                // 也不能用 updatedAt——那会在每次编辑后归零，把"等了 6 天"变成"等了 0 天"）
                waitingSince: num(t && t.waitingSince) || (status === 'waiting' ? createdAt : 0),
                // V2.0 / V2.1 新增字段必须在这里显式放行：
                // work-board.normalize 只放行 4 个字段的坑，本项目踩过两次。
                // contactId 给关系经营的「约一下」，repeat 给重复任务派生。
                contactId: clean(t && t.contactId, 40),
                repeat: ['day', 'week', 'month', 'year'].indexOf(str(t && t.repeat)) >= 0 ? str(t && t.repeat) : '',
                // 原始父引用，下面统一压平；直接信任它会出现三层甚至环
                parentId: str(t && t.parentId),
            };
        })
        .filter(function (t) { return !!t; });

    const rawParent = {};
    base.forEach(function (t) { rawParent[t.id] = t.parentId; });
    base.forEach(function (t) { t.parentId = resolveParent(t.id, rawParent); });

    // 子项上限：超出的上浮为顶层。宁可平铺，也不让一个父下面挂满 200 条
    const kids = {};
    base.forEach(function (t) {
        if (!t.parentId) return;
        kids[t.parentId] = (kids[t.parentId] || 0) + 1;
        if (kids[t.parentId] > MAX_CHILDREN) t.parentId = '';
    });

    const tasks = base;

    // 今日六点：必须在 normalize 里显式放行，否则写进去再读就没了。
    // 上一轮 work-board.normalize 只放行 4 个字段的坑不能踩第二次。
    const taskIds = {};
    tasks.forEach(function (t) { taskIds[t.id] = true; });
    const focus = normalizeFocus(src.focus, taskIds);

    const seenProject = {};
    const projects = (Array.isArray(src.projects) ? src.projects : [])
        .slice(0, MAX_PROJECTS)
        .map(function (p) {
            const name = clean(p && p.name, PROJECT_MAX);
            if (!name) return null;
            let id = str(p && p.id);
            if (!id || seenProject[id]) id = projectId();
            seenProject[id] = true;
            return {
                id: id,
                name: name,
                outcome: clean(p && p.outcome, TITLE_MAX),
                archived: !!(p && p.archived),
                createdAt: num(p && p.createdAt) || Date.now(),
            };
        })
        .filter(function (p) { return !!p; });

    // 情境名单：空数组 = 老数据的「派生模式」（内置 6 个 + 任务里出现过的）；
    // 一旦用户新建 / 改名 / 删过，这里就存一份权威名单，顺序由用户决定。
    // 不在 normalize 里放行的话，写进去下次读就没了——今日六点踩过同一个坑。
    const seenCtx = {};
    const contexts = (Array.isArray(src.contexts) ? src.contexts : [])
        .slice(0, MAX_CONTEXTS)
        .map(function (c) {
            const name = clean(c && c.name, CONTEXT_MAX);
            if (!name || seenCtx[name]) return null;
            seenCtx[name] = true;
            return { name: name, createdAt: num(c && c.createdAt) || Date.now() };
        })
        .filter(function (c) { return !!c; });

    const reviews = (Array.isArray(src.reviews) ? src.reviews : [])
        .slice(-MAX_REVIEWS)
        .map(function (r) {
            const weekKey = clean(r && r.weekKey, 10);
            if (!weekKey) return null;
            return {
                weekKey: weekKey,
                at: num(r && r.at),
                inbox: num(r && r.inbox),
                open: num(r && r.open),
                done: num(r && r.done),
                stalled: num(r && r.stalled),
            };
        })
        .filter(function (r) { return !!r; });

    return { version: 1, tasks: tasks, projects: projects, contexts: contexts, reviews: reviews, focus: focus };
}

// 焦点项是「任务 id + 归属格」的轻量指针，不复制任务内容：
// 任务改了标题，六点里跟着变；任务被删，焦点项自动消失（不留空壳）
function normalizeFocus(raw, taskIds) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const date = DATE_RE.test(str(src.date)) ? str(src.date) : '';
    const seen = {};
    const items = (Array.isArray(src.items) ? src.items : [])
        .slice(0, FOCUS_MAX)
        .map(function (it) {
            const id = str(it && it.id);
            if (!id || seen[id]) return null;
            // 指向已删除任务的焦点项要丢掉，否则六点里会出现一条点不动的空行
            if (!Object.prototype.hasOwnProperty.call(taskIds, id)) return null;
            seen[id] = true;
            const cell = str(it && it.cell);
            return { id: id, cell: CELL_KEYS.indexOf(cell) >= 0 ? cell : '' };
        })
        .filter(function (x) { return !!x; });
    return { date: date, items: items };
}

function addTask(state, patch) {
    const s = normalize(state);
    const p = patch || {};
    const title = clean(p.title, TITLE_MAX);
    if (!title || s.tasks.length >= MAX_TASKS) return s;
    // 新捕获一律进「收件箱」：normalize 的 next 兜底只针对没有 status 的历史数据，
    // 抓进来的新念头必须停在收件箱，等厘清——这是 GTD 的入口语义，不能混用。
    const status = p.status ? normStatus(p.status) : 'inbox';
    const now = Date.now();
    const due = clean(p.dueDate, 10);
    // 子项：父必须存在且本身是顶层（两层封顶）。找不到父就当普通任务，
    // 宁可多一条平铺，也不制造挂不上的孤儿。
    const parent = resolveChildParent(s, p.parentId);
    // 子项继承父的项目与上下文：拆「装修房子」时不用把「家装」再输五遍
    const project = clean(p.project, PROJECT_MAX) || (parent ? parent.project : '');
    const context = clean(p.context, CONTEXT_MAX) || (parent ? parent.context : '');
    s.tasks.push({
        id: taskId(),
        title: title,
        status: status,
        context: context,
        project: project,
        dueDate: DATE_RE.test(due) ? due : '',
        waitingFor: clean(p.waitingFor, WAITING_MAX),
        note: clean(p.note, NOTE_MAX),
        source: clean(p.source, 32),
        contactId: clean(p.contactId, 40),
        repeat: ['day', 'week', 'month', 'year'].indexOf(str(p.repeat)) >= 0 ? str(p.repeat) : '',
        createdAt: now,
        updatedAt: now,
        doneAt: 0,
        parentId: parent ? parent.id : '',
    });
    if (project) ensureProject(s, project);
    return s;
}

// 谁能当父：存在、子数未超限。
// 两层封顶——如果指定的父自己已经是子项，就把新项并到它的父（祖父）那一层，
// 而不是拒绝：用户是真想再拆一层，正确做法是摊平到同一层，不是造第三层，
// 也不该把这条扔掉变成孤儿。
function resolveChildParent(state, rawId) {
    const key = str(rawId);
    if (!key) return null;
    let p = findTask(state, key);
    if (!p) return null;
    if (p.parentId) {
        const up = findTask(state, p.parentId);
        if (!up) return null;
        p = up;
    }
    const count = state.tasks.filter(function (t) { return t.parentId === p.id; }).length;
    if (count >= MAX_CHILDREN) return null;
    return p;
}

function ensureProject(state, name) {
    const target = clean(name, PROJECT_MAX);
    if (!target) return state;
    const hit = state.projects.some(function (p) { return p.name === target; });
    if (!hit && state.projects.length < MAX_PROJECTS) {
        state.projects.push({
            id: projectId(),
            name: target,
            outcome: '',
            archived: false,
            createdAt: Date.now(),
        });
    }
    return state;
}

// ---- 项目 / 情境：用户自己维护的那一层 ----
// 项目本来就是实体（state.projects），只补了增 / 改名 / 归档 / 删除四个动作。
// 情境原来是纯派生的（内置 6 个 + 任务里出现过的），一旦用户要新建或改名，
// 派生逻辑会立刻把他改的东西「复活」回来，所以必须落一份名单。

function contextNames(state) {
    const s = (state && Array.isArray(state.contexts)) ? state : normalize(state);
    if (s.contexts.length) return s.contexts.map(function (c) { return c.name; });
    const out = CONTEXTS.slice();
    s.tasks.forEach(function (t) {
        if (t.context && out.indexOf(t.context) < 0) out.push(t.context);
    });
    return out;
}

function seedContexts(s) {
    if (s.contexts.length) return s.contexts;
    s.contexts = contextNames(s).slice(0, MAX_CONTEXTS).map(function (name) {
        return { name: name, createdAt: Date.now() };
    });
    return s.contexts;
}

function contextAdd(state, name) {
    const s = normalize(state);
    const target = clean(name, CONTEXT_MAX);
    if (!target) return s;
    const list = seedContexts(s);
    if (list.length >= MAX_CONTEXTS) return s;
    if (list.some(function (c) { return c.name === target; })) return s;
    list.push({ name: target, createdAt: Date.now() });
    return s;
}

// 改名 = 名单换字 + 所有挂了这个情境的任务跟着换。
// 只改名单不改任务的话，任务上那条旧标签会把旧名字又派生回来，等于改了个寂寞。
function contextRename(state, from, to) {
    const s = normalize(state);
    const oldName = clean(from, CONTEXT_MAX);
    const next = clean(to, CONTEXT_MAX);
    if (!oldName || !next || oldName === next) return s;
    const list = seedContexts(s);
    if (list.some(function (c) { return c.name === next; })) return s;
    const hit = list.filter(function (c) { return c.name === oldName; })[0];
    if (hit) hit.name = next;
    else list.push({ name: next, createdAt: Date.now() });
    s.tasks.forEach(function (t) { if (t.context === oldName) t.context = next; });
    return s;
}

// 删除情境：标签不存在了，任务上的也得清掉，否则下次读回来它又出现在名单里
function contextRemove(state, name) {
    const s = normalize(state);
    const target = clean(name, CONTEXT_MAX);
    if (!target) return s;
    const list = seedContexts(s);
    s.contexts = list.filter(function (c) { return c.name !== target; });
    s.tasks.forEach(function (t) { if (t.context === target) t.context = ''; });
    return s;
}

function findProject(s, name) {
    const key = clean(name, PROJECT_MAX);
    if (!key) return null;
    return s.projects.filter(function (p) { return p.name === key; })[0] || null;
}

function projectAdd(state, name) {
    const s = normalize(state);
    const target = clean(name, PROJECT_MAX);
    if (!target) return s;
    const existed = findProject(s, target);
    // 建一个同名项目 = 把它从归档里捞出来，而不是并存两个同名
    if (existed) { existed.archived = false; return s; }
    if (s.projects.length >= MAX_PROJECTS) return s;
    s.projects.push({
        id: projectId(), name: target, outcome: '', archived: false, createdAt: Date.now(),
    });
    return s;
}

function projectRename(state, from, to) {
    const s = normalize(state);
    const oldName = clean(from, PROJECT_MAX);
    const next = clean(to, PROJECT_MAX);
    if (!oldName || !next || oldName === next) return s;
    const p = findProject(s, oldName);
    if (!p) return s;
    if (findProject(s, next)) return s;   // 重名不合并：悄悄吞并另一个项目比失败更糟
    p.name = next;
    s.tasks.forEach(function (t) { if (t.project === oldName) t.project = next; });
    return s;
}

// 归档：项目与它名下的任务都留着，只是从「可选项」里退场。
// 项目完成之后最该做的是让它消失，而不是删掉历史。
function projectArchive(state, name, archived) {
    const s = normalize(state);
    const p = findProject(s, name);
    if (!p) return s;
    p.archived = archived !== false;
    return s;
}

function projectRemove(state, name) {
    const s = normalize(state);
    const target = clean(name, PROJECT_MAX);
    if (!target) return s;
    s.projects = s.projects.filter(function (p) { return p.name !== target; });
    // 删项目不清任务：任务还得有人做，只是不再挂在任何项目下
    s.tasks.forEach(function (t) { if (t.project === target) t.project = ''; });
    return s;
}

function findTask(state, id) {
    const key = str(id);
    return state.tasks.filter(function (t) { return t.id === key; })[0] || null;
}

function updateTask(state, id, patch) {
    const s = normalize(state);
    const t = findTask(s, id);
    if (!t) return s;
    const p = patch || {};
    if (p.title !== undefined) {
        const title = clean(p.title, TITLE_MAX);
        if (title) t.title = title;
    }
    if (p.context !== undefined) t.context = clean(p.context, CONTEXT_MAX);
    if (p.project !== undefined) {
        t.project = clean(p.project, PROJECT_MAX);
        if (t.project) ensureProject(s, t.project);
    }
    if (p.dueDate !== undefined) {
        const due = clean(p.dueDate, 10);
        t.dueDate = DATE_RE.test(due) ? due : '';
    }
    if (p.waitingFor !== undefined) t.waitingFor = clean(p.waitingFor, WAITING_MAX);
    if (p.note !== undefined) t.note = clean(p.note, NOTE_MAX);
    if (p.contactId !== undefined) t.contactId = clean(p.contactId, 40);
    if (p.repeat !== undefined) {
        t.repeat = ['day', 'week', 'month', 'year'].indexOf(str(p.repeat)) >= 0 ? str(p.repeat) : '';
    }
    if (p.parentId !== undefined) {
        const key = str(p.parentId);
        if (!key) {
            t.parentId = '';
        } else {
            // 自己已经有子项的人不能再当别人的子项——那会立刻变三层。
            // 这种情况静默保持原样：把父任务挪进另一条下面，用户八成不是这个意思。
            const hasKids = s.tasks.some(function (x) { return x.parentId === t.id; });
            const parent = resolveChildParent(s, key);
            if (parent && parent.id !== t.id && !hasKids) t.parentId = parent.id;
        }
    }
    if (p.status !== undefined) {
        const next = normStatus(p.status);
        const prev = t.status;
        t.status = next;
        t.doneAt = next === 'done' ? Date.now() : 0;
        // 等待计时从「进入等待那一刻」起算。重复设为 waiting 不重置，避免点一次表单就清零。
        if (next === 'waiting') {
            if (prev !== 'waiting' || !t.waitingSince) t.waitingSince = Date.now();
        } else {
            t.waitingSince = 0;
        }
    }
    t.updatedAt = Date.now();
    return s;
}

function removeTask(state, id) {
    const s = normalize(state);
    const key = str(id);
    // 删容器不删内容：子项上抬成顶层，别让删一个「装修」连带丢掉五个真动作。
    // 这是有意的选择——级联删除看起来干净，代价是用户的真实待办跟着蒸发。
    s.tasks.forEach(function (t) { if (t.parentId === key) t.parentId = ''; });
    s.tasks = s.tasks.filter(function (t) { return t.id !== key; });
    return s;
}

// 父任务下还有几件没做完：界面据此拦「直接勾掉父项」，也据此显示 3/5
function completionInfo(state, id) {
    const s = normalize(state);
    const t = findTask(s, id);
    if (!t) return { found: false, total: 0, done: 0, open: 0 };
    const kids = s.tasks.filter(function (x) { return x.parentId === t.id; });
    const open = kids.filter(function (x) { return x.status !== 'done'; }).length;
    return { found: true, total: kids.length, done: kids.length - open, open: open };
}

// 「连同 N 个子项一起完成」：一次把父与未完成子项都标记完成。
// 不删任何东西——完成后仍在清单里（7 天内可回看、可重开）。
function completeAll(state, id) {
    const s = normalize(state);
    const key = str(id);
    let at = 0;
    s.tasks.forEach(function (t) {
        if (t.id !== key && t.parentId !== key) return;
        if (t.status === 'done') return;
        at = Date.now();
        t.status = 'done';
        t.doneAt = at;
        t.updatedAt = at;
        t.waitingSince = 0;
    });
    return s;
}

function complete(state, id) {
    return updateTask(state, id, { status: 'done' });
}

function reopen(state, id) {
    return updateTask(state, id, { status: 'next' });
}

// 厘清：GTD 的核心动作——把「记下来的一句话」变成「能执行的动作」或「明确的等待 / 日程」
function clarify(state, id, status, patch) {
    const next = str(status);
    if (['next', 'waiting', 'scheduled', 'someday', 'inbox'].indexOf(next) < 0) {
        const err = new Error('不支持的厘清去向: ' + next);
        err.code = 'GTD_BAD_STATUS';
        throw err;
    }
    return updateTask(state, id, Object.assign({}, patch || {}, { status: next }));
}

// ---------- 今日六点 ----------
// 六点只存「任务 id + 归属格」的指针，不复制标题：任务改了标题，六点跟着变；
// 任务被删，那条自动消失。跨天不结转——昨天的六点今天还留着，就成了永久积压。
function buildFocus(s, today) {
    const fresh = s.focus.date === today;
    const picked = fresh ? s.focus.items : [];
    const kidOpen = {};
    s.tasks.forEach(function (t) {
        if (!t.parentId || t.status === 'done') return;
        kidOpen[t.parentId] = (kidOpen[t.parentId] || 0) + 1;
    });
    const items = picked.map(function (it) {
        const t = findTask(s, it.id);
        if (!t) return null;
        return {
            id: t.id,
            cell: it.cell,
            title: t.title,
            project: t.project,
            context: t.context,
            dueDate: t.dueDate,
            status: t.status,
            done: t.status === 'done',
            overdue: !!t.dueDate && t.status !== 'done' && t.dueDate < today,
            dueToday: !!t.dueDate && t.status !== 'done' && t.dueDate === today,
            openChildren: kidOpen[t.id] || 0,
        };
    }).filter(function (x) { return !!x; });
    return {
        today: today,
        // date 与 today 不一致 = 昨天的六点，界面上按「空」处理并说明不结转
        date: fresh ? today : '',
        stale: !fresh && s.focus.items.length > 0,
        staleCount: fresh ? 0 : s.focus.items.length,
        count: items.length,
        doneCount: items.filter(function (x) { return x.done; }).length,
        items: items,
    };
}

function focusOf(state, nowDate) {
    const s = normalize(state);
    const today = DATE_RE.test(str(nowDate)) ? str(nowDate) : todayOf();
    return buildFocus(s, today);
}

// 候选：默认给「能动手的叶子」，而不是整份清单——
// 六点是从可执行里挑六件，不是从愿望里挑六件
function focusCandidates(state, nowDate) {
    const s = normalize(state);
    const today = DATE_RE.test(str(nowDate)) ? str(nowDate) : todayOf();
    const b = board(s, today);
    const picked = {};
    if (s.focus.date === today) s.focus.items.forEach(function (it) { picked[it.id] = true; });

    const rows = [];
    function push(t, reason, rank) {
        if (picked[t.id] || t.status === 'done') return;
        rows.push({
            id: t.id,
            title: t.title,
            project: t.project,
            context: t.context,
            dueDate: t.dueDate,
            overdue: !!t.overdue,
            dueToday: !!t.dueToday,
            openChildren: t.openChildren || 0,
            reason: reason,
            rank: rank,
        });
    }
    b.groups.scheduled.forEach(function (t) {
        if (t.overdue) push(t, '逾期 ' + Math.max(1, diffDays(t.dueDate, today)) + ' 天', 0);
        else if (t.dueToday) push(t, '今天到期', 1);
        else push(t, t.dueDate.slice(5), 2);
    });
    b.groups.next.forEach(function (t) {
        // 容器不进候选：能挑的必须是能动手的那一条
        if (t.openChildren > 0) return;
        if (t.overdue) push(t, '逾期 ' + Math.max(1, diffDays(t.dueDate, today)) + ' 天', 0);
        else push(t, '下一步', 3);
    });

    rows.sort(function (a, b2) {
        if (a.rank !== b2.rank) return a.rank - b2.rank;
        return a.title.localeCompare(b2.title);
    });
    return {
        today: today,
        picked: Object.keys(picked).length,
        total: rows.length,
        items: rows.slice(0, 30),
        leafNext: b.stats.leafNext,
        note: '候选只给能动手的：日程（逾期优先）与不带子项的下一步；容器要先拆出子项才进得来。',
    };
}

function toggleFocus(state, nowDate, id, cell) {
    const s = normalize(state);
    const today = DATE_RE.test(str(nowDate)) ? str(nowDate) : todayOf();
    const key = str(id);
    if (!findTask(s, key)) return s;
    // 切天视为重新挑：昨天的六个不继承，避免「欠着六件事」的永久负债
    const items = s.focus.date === today ? s.focus.items.slice(0) : [];
    const at = items.map(function (x) { return x.id; }).indexOf(key);
    if (at >= 0) {
        items.splice(at, 1);
    } else if (items.length < FOCUS_MAX) {
        const c = str(cell);
        items.push({ id: key, cell: CELL_KEYS.indexOf(c) >= 0 ? c : '' });
    }
    s.focus = { date: today, items: items };
    return s;
}

// 整组替换：上下调序与拖拽都走这条，避免顺序靠 DOM 事件拼
function setFocus(state, nowDate, ids) {
    const s = normalize(state);
    const today = DATE_RE.test(str(nowDate)) ? str(nowDate) : todayOf();
    const cellOf = {};
    if (s.focus.date === today) {
        s.focus.items.forEach(function (it) { cellOf[it.id] = it.cell; });
    }
    const seen = {};
    const items = [];
    (Array.isArray(ids) ? ids : []).forEach(function (raw) {
        const key = str(raw);
        if (!key || seen[key] || items.length >= FOCUS_MAX) return;
        if (!findTask(s, key)) return;
        seen[key] = true;
        items.push({ id: key, cell: cellOf[key] || '' });
    });
    s.focus = { date: today, items: items };
    return s;
}

function clearFocus(state, nowDate) {
    const s = normalize(state);
    const today = DATE_RE.test(str(nowDate)) ? str(nowDate) : todayOf();
    s.focus = { date: today, items: [] };
    return s;
}

function projectRollup(state, opts) {
    const s = normalize(state);
    const withArchived = !!(opts && opts.includeArchived);
    const map = {};
    const order = [];

    // 父任务只有在子项全做完之后才算「可执行下一步」。
    // 否则「装修房子（3 个子项都没动）」会被算成项目里有 1 个下一步，
    // 停滞判定跟着失效——项目看着推得动，其实一步也迈不出去。
    const kidOpen = {};
    s.tasks.forEach(function (t) {
        if (!t.parentId || t.status === 'done') return;
        kidOpen[t.parentId] = (kidOpen[t.parentId] || 0) + 1;
    });
    const isLeaf = function (t) { return !kidOpen[t.id]; };

    s.projects.forEach(function (p) {
        map[p.name] = {
            id: p.id,
            name: p.name,
            outcome: p.outcome,
            archived: p.archived,
            total: 0,
            done: 0,
            open: 0,
            next: 0,
            waiting: 0,
            overdue: 0,
            lastAt: 0,
            stalled: false,
        };
        order.push(p.name);
    });

    s.tasks.forEach(function (t) {
        if (!t.project) return;
        if (!map[t.project]) {
            map[t.project] = {
                id: '',
                name: t.project,
                outcome: '',
                archived: false,
                total: 0, done: 0, open: 0, next: 0, waiting: 0, overdue: 0, lastAt: 0, stalled: false,
            };
            order.push(t.project);
        }
        const row = map[t.project];
        row.total += 1;
        if (t.status === 'done') row.done += 1;
        else row.open += 1;
        if (t.status === 'next' && isLeaf(t)) row.next += 1;
        if (t.status === 'waiting') row.waiting += 1;
        row.lastAt = Math.max(row.lastAt, t.updatedAt);
    });

    const list = order.map(function (name) {
        const row = map[name];
        // 项目停滞：还有未完成的事，却没有任何一个「下一步」——
        // 这是 GTD 里最典型的死角，项目看着没丢，其实推不动。
        row.stalled = row.open > 0 && row.next === 0;
        row.pct = row.total ? Math.round(row.done * 100 / row.total) : 0;
        return row;
    }).filter(function (r) { return withArchived || !r.archived; });

    return list.sort(function (a, b) {
        if (a.stalled !== b.stalled) return a.stalled ? -1 : 1;
        if (b.open !== a.open) return b.open - a.open;
        return b.lastAt - a.lastAt;
    });
}

function board(state, nowDate) {
    const s = normalize(state);
    const today = DATE_RE.test(str(nowDate)) ? str(nowDate) : todayOf();
    const groups = { inbox: [], next: [], waiting: [], scheduled: [], someday: [], done: [] };
    const contexts = {};
    const contextOrder = [];

    // 子项计数一次算完：整棵树只遍历一遍，不在每条任务上再查一次数组
    const kidTotal = {};
    const kidOpen = {};
    s.tasks.forEach(function (t) {
        if (!t.parentId) return;
        kidTotal[t.parentId] = (kidTotal[t.parentId] || 0) + 1;
        if (t.status !== 'done') kidOpen[t.parentId] = (kidOpen[t.parentId] || 0) + 1;
    });

    s.tasks.forEach(function (t) {
        const overdue = !!t.dueDate && t.status !== 'done' && t.dueDate < today;
        const dueToday = !!t.dueDate && t.status !== 'done' && t.dueDate === today;
        const ageDays = diffDays(todayOf(new Date(t.createdAt)), today);
        const item = Object.assign({}, t, {
            ageDays: ageDays,
            overdue: overdue,
            dueToday: dueToday,
            needWho: t.status === 'waiting' && !t.waitingFor,
            needDate: t.status === 'scheduled' && !t.dueDate,
            statusLabel: STATUS_LABEL[t.status],
            // 子任务树：childTotal / childDone / openChildren 三个数就够了，
            // 界面不必自己再拿全量任务算一遍
            childTotal: kidTotal[t.id] || 0,
            childDone: (kidTotal[t.id] || 0) - (kidOpen[t.id] || 0),
            openChildren: kidOpen[t.id] || 0,
            hasChildren: (kidTotal[t.id] || 0) > 0,
            // 有未完成子项的父任务不是「下一步」——它是容器。
            // 「装修房子」和「给工长打电话」混在一个列表里，挑出来的六点必然没法动手。
            container: (kidOpen[t.id] || 0) > 0,
        });
        groups[t.status].push(item);

        if (t.status !== 'done' && t.context) {
            if (!contexts[t.context]) {
                contexts[t.context] = { name: t.context, open: 0, next: 0 };
                contextOrder.push(t.context);
            }
            contexts[t.context].open += 1;
            if (t.status === 'next') contexts[t.context].next += 1;
        }
    });

    // 日程按日期升序（越近越靠前，逾期置顶由 overdue 类名体现）
    groups.scheduled.sort(function (a, b) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
    });
    // 收件箱按「躺了多久」倒序：越老越该被处理
    groups.inbox.sort(function (a, b) { return b.ageDays - a.ageDays; });
    // 完成只留最近 7 天
    groups.done.sort(function (a, b) { return b.doneAt - a.doneAt; });
    groups.done = groups.done.filter(function (t) {
        return diffDays(todayOf(new Date(t.doneAt)), today) <= DONE_KEEP_DAYS;
    });

    const projects = projectRollup(s);
    // 归档项目只在「归档」那一段里出现：任务行、厘清、右栏的项目下拉都不该再看到它
    const archivedProjects = projectRollup(s, { includeArchived: true })
        .filter(function (p) { return p.archived; });
    const openTasks = s.tasks.filter(function (t) { return t.status !== 'done'; });

    const weekAgo = todayOf(new Date(Date.now() - 6 * 86400000));
    const doneThisWeek = s.tasks.filter(function (t) {
        if (t.status !== 'done' || !t.doneAt) return false;
        const d = todayOf(new Date(t.doneAt));
        return d >= weekAgo && d <= today;
    });

    const contextList = contextOrder.map(function (k) { return contexts[k]; })
        .sort(function (a, b) { return b.open - a.open; });
    // 名单里的情境即使一条任务都没挂也要出现在分栏里——否则「刚新建就消失」，
    // 用户没法先建好情境再往里放任务
    contextNames(s).forEach(function (c) {
        if (!contexts[c]) contextList.push({ name: c, open: 0, next: 0 });
    });

    const stats = {
        inbox: groups.inbox.length,
        next: groups.next.length,
        waiting: groups.waiting.length,
        scheduled: groups.scheduled.length,
        someday: groups.someday.length,
        done7: groups.done.length,
        openTotal: openTasks.length,
        dueToday: groups.scheduled.filter(function (t) { return t.dueToday; }).length,
        overdue: groups.scheduled.filter(function (t) { return t.overdue; }).length
            + groups.next.filter(function (t) { return t.overdue; }).length,
        waitingNoWho: groups.waiting.filter(function (t) { return t.needWho; }).length,
        scheduledNoDate: groups.scheduled.filter(function (t) { return t.needDate; }).length,
        stalledProjects: projects.filter(function (p) { return p.stalled; }).length,
        doneThisWeek: doneThisWeek.length,
        oldestInbox: groups.inbox.length ? groups.inbox[0].ageDays : 0,
        // 下一步里真正能动手的条数：容器（还有未完成子项）不算。
        // 这两个数是「今日六点」将来挑活的前提，也让用户一眼看出清单虚胖。
        leafNext: groups.next.filter(function (t) { return t.openChildren === 0; }).length,
        containerNext: groups.next.filter(function (t) { return t.openChildren > 0; }).length,
        parents: s.tasks.filter(function (t) { return (kidTotal[t.id] || 0) > 0; }).length,
    };

    let insight;
    if (!s.tasks.length) {
        insight = 'GTD 空着。先把脑子里的事一股脑倒进收件箱，厘清是第二步的事。';
    } else if (stats.inbox > 0) {
        insight = '收件箱还有 ' + stats.inbox + ' 条没厘清'
            + (stats.oldestInbox > 0 ? '，最久的一条躺了 ' + stats.oldestInbox + ' 天' : '')
            + '。收件箱不是待办列表，清空它比做完它更重要。';
    } else if (stats.stalledProjects > 0) {
        insight = '收件箱清空了，但有 ' + stats.stalledProjects + ' 个项目没有任何「下一步」——项目不是忘了，是推不动。';
    } else if (stats.overdue > 0) {
        insight = '没有积压的收件箱，但 ' + stats.overdue + ' 项已过期，先处理它们。';
    } else {
        insight = '清单是干净的：' + stats.leafNext + ' 项可执行下一步'
            + (stats.containerNext > 0
                ? '（另有 ' + stats.containerNext + ' 条是带子项的容器，不能直接动手）'
                : '')
            + '、' + stats.waiting + ' 项等待、' + stats.scheduled + ' 项日程；本周已完成 '
            + stats.doneThisWeek + ' 项。';
    }

    return {
        today: today,
        empty: s.tasks.length === 0,
        groups: groups,
        projects: projects,
        archivedProjects: archivedProjects,
        contexts: contextList.slice(0, MAX_CONTEXTS),
        stats: stats,
        focus: buildFocus(s, today),
        insight: insight,
        note: '口径：收件箱=还没厘清；下一步=单个可执行动作且带上下文；等待=等别人且有对象；'
            + '日程=有明确日期；将来也许=暂不排期。项目停滞的判定是「有未完成却没有下一步」。'
            + '子任务只允许两层：父是容器，子才是能动手的下一步；容器不算可执行项。',
    };
}

// GTD 每周回顾：五个固定检查项，不给「随便看看」的模糊入口
function weeklyReview(state, nowDate) {
    const s = normalize(state);
    const today = DATE_RE.test(str(nowDate)) ? str(nowDate) : todayOf();
    const b = board(s, today);
    const weekKey = weekKeyOf(today);

    const checks = [
        {
            key: 'inbox',
            label: '收件箱清空',
            done: b.stats.inbox === 0,
            detail: b.stats.inbox === 0 ? '已清空' : '还有 ' + b.stats.inbox + ' 条待厘清',
        },
        {
            key: 'waiting',
            label: '等待项有人可催',
            done: b.stats.waitingNoWho === 0,
            detail: b.stats.waitingNoWho === 0 ? '都写明了等谁' : b.stats.waitingNoWho + ' 条没写等谁',
        },
        {
            key: 'scheduled',
            label: '日程都有日期',
            done: b.stats.scheduledNoDate === 0,
            detail: b.stats.scheduledNoDate === 0 ? '都有明确日期' : b.stats.scheduledNoDate + ' 条缺日期',
        },
        {
            key: 'projects',
            label: '每个项目都有下一步',
            done: b.stats.stalledProjects === 0,
            detail: b.stats.stalledProjects === 0 ? '项目都在推进' : b.stats.stalledProjects + ' 个项目停滞',
        },
        {
            key: 'someday',
            label: '将来也许扫过一遍',
            done: true,
            detail: b.stats.someday + ' 条（扫一眼即可，不用现在做）',
        },
    ];

    const passed = checks.filter(function (c) { return c.done; }).length;
    const lastAt = s.reviews.filter(function (r) { return r.weekKey === weekKey; })[0];
    const history = s.reviews.slice(-8).map(function (r) {
        return {
            weekKey: r.weekKey,
            at: r.at,
            inbox: r.inbox,
            open: r.open,
            done: r.done,
            stalled: r.stalled,
        };
    });

    return {
        weekKey: weekKey,
        today: today,
        checks: checks,
        passed: passed,
        total: checks.length,
        allPass: passed === checks.length,
        reviewedAt: lastAt ? lastAt.at : 0,
        reviewedThisWeek: !!lastAt,
        history: history,
        stats: b.stats,
        insight: passed === checks.length
            ? '五项检查全过，这周可以收工。'
            : '五项里过了 ' + passed + ' 项，先补没过的：'
                + checks.filter(function (c) { return !c.done; }).map(function (c) { return c.label; }).join('、') + '。',
        note: '周回顾只做五件事：清收件箱、催等待、给日程定日期、给项目定下一步、扫一遍将来也许。',
    };
}

function markReviewed(state, nowDate) {
    const s = normalize(state);
    const today = DATE_RE.test(str(nowDate)) ? str(nowDate) : todayOf();
    const weekKey = weekKeyOf(today);
    const b = board(s, today);
    s.reviews = s.reviews.filter(function (r) { return r.weekKey !== weekKey; });
    s.reviews.push({
        weekKey: weekKey,
        at: Date.now(),
        inbox: b.stats.inbox,
        open: b.stats.openTotal,
        done: b.stats.doneThisWeek,
        stalled: b.stats.stalledProjects,
    });
    s.reviews = s.reviews.slice(-MAX_REVIEWS);
    return s;
}

// 迁移：把既有日记里 workBoard 的任务一次性收进收件箱。
// 只补不改、按 source 去重，可反复点。
function importLegacy(state, records) {
    const s = normalize(state);
    const seen = {};
    s.tasks.forEach(function (t) { if (t.source) seen[t.source] = true; });

    let added = 0;
    let skipped = 0;
    (Array.isArray(records) ? records : []).forEach(function (r) {
        if (!r || !DATE_RE.test(str(r.date))) return;
        const tasks = (r.workBoard && Array.isArray(r.workBoard.tasks)) ? r.workBoard.tasks : [];
        tasks.forEach(function (t) {
            const text = clean(t && t.text, TITLE_MAX);
            if (!text) return;
            const source = 'wb:' + r.date + ':' + str(t && t.id || text);
            if (seen[source]) { skipped += 1; return; }
            if (s.tasks.length >= MAX_TASKS) { skipped += 1; return; }
            seen[source] = true;
            const now = Date.now();
            s.tasks.push({
                id: taskId(),
                title: text,
                // 已完成的历史任务直接记完成，没完成的进收件箱等厘清
                status: t && t.done ? 'done' : 'inbox',
                context: '',
                project: '',
                dueDate: '',
                waitingFor: '',
                note: '',
                source: source,
                createdAt: num(t && t.createdAt) || now,
                updatedAt: now,
                doneAt: t && t.done ? (num(t && t.createdAt) || now) : 0,
            });
            added += 1;
        });
    });

    s.tasks = s.tasks.slice(-MAX_TASKS);
    return { state: s, added: added, skipped: skipped };
}

// 导入备份时用：只补不改，同 id 不覆盖本机已有
function mergeSection(state, incoming) {
    const s = normalize(state);
    const inc = normalize(incoming);
    const have = {};
    s.tasks.forEach(function (t) { have[t.id] = true; });
    let added = 0;
    inc.tasks.forEach(function (t) {
        if (have[t.id]) return;
        if (s.tasks.length >= MAX_TASKS) return;
        s.tasks.push(t);
        have[t.id] = true;
        added += 1;
    });
    const haveP = {};
    s.projects.forEach(function (p) { haveP[p.name] = true; });
    inc.projects.forEach(function (p) {
        if (haveP[p.name]) return;
        if (s.projects.length >= MAX_PROJECTS) return;
        s.projects.push(p);
        haveP[p.name] = true;
    });
    // 情境名单：本地还是派生模式（空）就把导入的整份接过来；
    // 两边都有就按名字并集，本地顺序优先——导入不该打乱用户自己排好的顺序
    if (inc.contexts.length) {
        if (!s.contexts.length) {
            s.contexts = inc.contexts.slice(0, MAX_CONTEXTS);
        } else {
            const haveC = {};
            s.contexts.forEach(function (c) { haveC[c.name] = true; });
            inc.contexts.forEach(function (c) {
                if (haveC[c.name] || s.contexts.length >= MAX_CONTEXTS) return;
                s.contexts.push(c);
                haveC[c.name] = true;
            });
        }
    }
    const haveR = {};
    s.reviews.forEach(function (r) { haveR[r.weekKey] = true; });
    inc.reviews.forEach(function (r) {
        if (haveR[r.weekKey]) return;
        s.reviews.push(r);
    });
    s.reviews = s.reviews.slice(-MAX_REVIEWS);
    return { state: s, added: added };
}

function contextPool(state) {
    const s = normalize(state);
    const map = {};
    contextNames(s).forEach(function (c) { map[c] = { name: c, count: 0, last: 0 }; });
    s.tasks.forEach(function (t) {
        if (!t.context) return;
        if (!map[t.context]) map[t.context] = { name: t.context, count: 0, last: 0 };
        map[t.context].count += 1;
        map[t.context].last = Math.max(map[t.context].last, t.updatedAt);
    });
    return Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return b.last - a.last;
        })
        .slice(0, 10);
}

module.exports = {
    TITLE_MAX: TITLE_MAX,
    NOTE_MAX: NOTE_MAX,
    WAITING_MAX: WAITING_MAX,
    CONTEXT_MAX: CONTEXT_MAX,
    PROJECT_MAX: PROJECT_MAX,
    MAX_TASKS: MAX_TASKS,
    MAX_PROJECTS: MAX_PROJECTS,
    MAX_CHILDREN: MAX_CHILDREN,
    PARENT_DEPTH: PARENT_DEPTH,
    FOCUS_MAX: FOCUS_MAX,
    CELL_KEYS: CELL_KEYS,
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    STATUS_HINT: STATUS_HINT,
    CONTEXTS: CONTEXTS,
    DONE_KEEP_DAYS: DONE_KEEP_DAYS,
    todayOf: todayOf,
    weekKeyOf: weekKeyOf,
    diffDays: diffDays,
    empty: empty,
    normalize: normalize,
    addTask: addTask,
    updateTask: updateTask,
    removeTask: removeTask,
    complete: complete,
    completeAll: completeAll,
    completionInfo: completionInfo,
    reopen: reopen,
    clarify: clarify,
    board: board,
    focusOf: focusOf,
    focusCandidates: focusCandidates,
    toggleFocus: toggleFocus,
    setFocus: setFocus,
    clearFocus: clearFocus,
    projectRollup: projectRollup,
    // 项目 / 情境的用户层动作（增 / 改名 / 归档 / 删除）
    projectAdd: projectAdd,
    projectRename: projectRename,
    projectArchive: projectArchive,
    projectRemove: projectRemove,
    contextAdd: contextAdd,
    contextRename: contextRename,
    contextRemove: contextRemove,
    contextNames: contextNames,
    weeklyReview: weeklyReview,
    markReviewed: markReviewed,
    importLegacy: importLegacy,
    mergeSection: mergeSection,
    contextPool: contextPool,
};
