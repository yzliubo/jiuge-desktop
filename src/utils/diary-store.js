// 九格手记本地数据层
// 页面只调用这里的方法，不直接访问 wx storage；日后接入云数据时替换本文件即可。

const workBoard = require('./work-board.js');
const moneyBook = require('./money-book.js');
const studyLog = require('./study-log.js');
const PREFIX = 'morning_diary_';
// 只有「前缀 + YYYY-MM-DD」才是日记键；UI 状态键一律不得使用该前缀
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STARTED_KEY = 'morning_started_at';
const TEMPLATE_KEY = 'morning_template';
const FIRSTWEEK_KEY = 'morning_firstweek';
const REVIEW_PREFIX = 'morning_review_';
// 学习库是跨天持久对象（一本书会读很多天），存单键；不按天堆积、不占日记命名空间
const STUDY_LIBRARY_KEY = 'md_study_library';
const WEEK_GOAL = 5;
// 单格正文与基础栏的落盘上限：微信 storage 单键 1MB，超了会抛错导致整篇丢失
const CELL_MAX = 2000;
const BASE_MAX = 200;
// 搜索一次最多返回多少条，避免关键词命中上百条时一次性 setData 卡死页面
const SEARCH_LIMIT = 200;
const MODULES_KEY = 'md_modules';
// 三个可选模块。关掉只是不展示面板，日记数据一条不动，随时能开回来。
const MODULE_DEFS = [
    { id: 'work', label: '工作看板', desc: '当日任务清单 + 工作感想' },
    { id: 'money', label: '记一笔收支', desc: '当天收入支出，只存本机' },
    { id: 'growth', label: '学习进展', desc: '在读书 / 影 / 画的推进与主题' },
];
const MILESTONE_KEY = 'morning_milestones'; // 奖励里程碑：周期与内容均可自定义 // 每周达标线：呼应「不必天天满格」的弹性节奏

// PPT「制作基本页面」：日期（自动）、天气、纪念日、身体状况、心情
const BASE_FIELDS = [
    { key: 'weather', label: '天气', options: ['晴', '多云', '阴', '小雨', '大雨', '雪', '风', '雾'] },
    { key: 'anniversary', label: '纪念日', options: [] },
    { key: 'body', label: '身体状况', options: ['很好', '不错', '一般', '疲惫', '不适'] },
    { key: 'mood', label: '心情', options: ['愉悦', '平静', '一般', '低落', '烦躁'] },
];

// 九个数据键固定不变：切换模板只换「标签 + 提问」，历史日记不会丢
const GRID_KEYS = ['work', 'money', 'health', 'relation', 'future', 'emotion', 'dream', 'growth', 'free'];

function buildFields(defs) {
    return defs.map(function (d, i) {
        return {
            key: GRID_KEYS[i],
            label: d[0],
            hint: d[1],
            required: i < 4,
            center: i === 4,
        };
    });
}

// 引导提问库：借鉴格志日记「基于积极心理学的问题库」，按日期确定性轮换
// 同一天打开保持一致，也可手动「换一题」，避免静态提示写几天就枯竭
const PROMPTS = {
    work: [
        '今天最想推进的一件事是什么？',
        '哪件事做完，今天就算值得？',
        '昨天留下的问题，今天能往前挪一步吗？',
        '今天有什么可以交出去，让自己轻一点？',
        '这周的工作里，哪一件最让你有成就感？',
    ],
    money: [
        '今天有一笔让你安心的收支吗？',
        '关于钱，今天做了什么决定？',
        '有没有一笔「其实不必花」的开销？',
        '这个月最想守住的财务边界是什么？',
        '钱花在哪里时，你觉得自己被照顾到了？',
    ],
    health: [
        '身体今天给了你什么信号？',
        '昨天睡得怎么样，今天想怎么补回来？',
        '今天能为身体做的一件小事是什么？',
        '哪一刻你觉得精力最足？',
        '有什么作息，想从今天开始微调？',
    ],
    relation: [
        '今天想主动联系谁？',
        '有谁值得你今天说一句谢谢？',
        '昨天哪次对话，你还放在心上？',
        '今天想怎样对身边的人更温和一点？',
        '有没有一句该说却没说的话？',
    ],
    future: [
        '今天想执行的决心，用一句话写下来。',
        '如果今天只完成一件事，你选哪件？',
        '把今天当成未来某天回看，你希望记得什么？',
        '今天的一个小行动，会通向哪个梦想？',
        '写给明天的自己：请记得……',
    ],
    emotion: [
        '此刻最真实的心情，用一个词说说看。',
        '这份情绪背后，你在意的是什么？',
        '有什么事，写出来就轻了一点？',
        '今天有哪个瞬间让你松了一口气？',
        '如果不评判自己，你想说什么？',
    ],
    dream: [
        '今天离梦想更近的一小步是什么？',
        '那件一直想做的事，今天能碰一下吗？',
        '你希望一年后的自己，正在做什么？',
        '有什么证据说明你已经在路上了？',
        '今天可以为梦想留十分钟吗？',
    ],
    growth: [
        '昨天学到的一件事，今天怎么用？',
        '今天有什么值得复盘的？',
        '哪个错误，现在看反而有收获？',
        '最近反复出现的课题是什么？',
        '今天想给自己留一个什么提问？',
    ],
    free: [
        '现在脑子里最先冒出来的是什么？',
        '有什么小事，不写下来就会忘？',
        '今天想留一句给自己？',
        '随手记：一个画面、一句话、一个人。',
        '如果今天有标题，会叫什么？',
    ],
};

// 四套可切换的提问模板：只改标签与提问，不改数据键
// 只改标签与提问，不改数据键，切换零风险
const TEMPLATES = [
    {
        id: 'standard',
        name: '标准 · 九格',
        note: '工作／金钱／健康／人际 + 给明天',
        fields: buildFields([
            ['工作', '今天要推进的事'],
            ['金钱', '收支与决定'],
            ['健康', '身体与作息'],
            ['人际关系', '想联系的人'],
            ['给明天', '今天想执行的决心'],
            ['今日情绪', '冷静写下感受'],
            ['梦想', '离梦想更近一步'],
            ['学习成长', '新知与复盘'],
            ['自由格', '想写什么都好'],
        ]),
        prompts: PROMPTS,
    },
    {
        id: 'goal',
        name: '目标导向',
        note: '本月计划／三件事／打卡',
        fields: buildFields([
            ['本月计划', '这个月要守住的方向'],
            ['理财习惯', '今天的收支与预算'],
            ['每日打卡', '今天坚持了什么'],
            ['想感谢的人', '今天想对谁好一点'],
            ['今天三件事', '只写三件，做完就算赢'],
            ['情绪感受力', '身体和情绪在说什么'],
            ['培养自信', '今天做成的一件小事'],
            ['复盘不足', '哪里可以更好一点点'],
            ['创意灵感', '冒出来的念头先存着'],
        ]),
        prompts: {
            work: ['这个月的方向，今天能往前挪一点吗？', '本月计划里，最要紧的是哪一件？', '月底回头看，你希望完成什么？'],
            money: ['今天有一笔按计划花掉的钱吗？', '预算还守得住吗？', '这周最值的一笔开销是什么？'],
            health: ['今天哪个打卡完成了？', '坚持得最顺的一个习惯是什么？', '今天想给身体加一件什么小事？'],
            relation: ['今天想主动感谢谁？', '有谁帮了你一把？', '哪句话值得今天说出口？'],
            future: ['今天最重要的三件事，先写第一件。', '如果只做完一件，你选哪件？', '今天的一个小行动，通向本月哪一步？'],
            emotion: ['此刻身体的感觉是什么？', '这份情绪在提醒你什么？', '今天哪一刻你觉得稳住了？'],
            dream: ['今天做成的一件小事是什么？', '有什么证据说明你在推进？', '给自己记一笔小小的功劳。'],
            growth: ['今天哪里卡住了，为什么？', '同一个坑，这次避开了吗？', '明天想调整的一个动作是什么？'],
            free: ['刚才冒出来的念头，先存这儿。', '有什么想法值得试一下？', '写给今天的一个新点子。'],
        },
    },
    {
        id: 'emotion',
        name: '情绪觉察',
        note: '事实 → 情绪 → 感恩 → 成就（成长方法论）',
        fields: buildFields([
            ['今天完成的事', '哪怕很小也算成果'],
            ['让我安心的事', '关于钱与安全感'],
            ['身体的感受', '此刻身体是什么状态'],
            ['想说的话', '有谁、有哪句话'],
            ['写给明天', '留一句给明天的自己'],
            ['此刻的情绪', '如实写，不评判'],
            ['今天的小确幸', '一个被照亮的瞬间'],
            ['我学到了什么', '从事情里抽出一点规律'],
            ['感恩的一件事', '写下来，心情会松一点'],
        ]),
        prompts: {
            work: ['今天完成了什么，哪怕很小？', '哪件事让你觉得没白过？', '给自己记一笔成就。'],
            money: ['今天有什么让你觉得安稳？', '关于钱，此刻踏实吗？', '哪一刻你觉得被照顾到了？'],
            health: ['身体此刻最明显的感觉是什么？', '哪里紧、哪里松？', '今天身体想让你知道什么？'],
            relation: ['今天有谁让你心里一动？', '有句什么话一直没说？', '想怎样对身边的人更温和？'],
            future: ['写给明天：请记得……', '明天想对自己说一句什么？', '把今天的心情交给明天。'],
            emotion: ['此刻的情绪，如实说出来。', '这件事为什么让你有感觉？', '我害怕的是什么？最坏会怎样？'],
            dream: ['今天哪个瞬间被照亮了？', '有什么小到不值一提、却很暖？', '记一个让你笑出来的画面。'],
            growth: ['这件事里，我学到了什么？', '同样的处境，下次会怎么做？', '今天看清了哪一个模式？'],
            free: ['今天想感谢谁或什么？', '写下一件让你松口气的事。', '有什么值得记在心里的？'],
        },
    },
    {
        id: 'simple',
        name: '极简',
        note: '把第一步缩回一句话（空白页恐惧）',
        fields: buildFields([
            ['一句话', '今天最想留的一句'],
            ['一笔', '值得记的一笔'],
            ['身体', '一个词就好'],
            ['一个人', '今天想到谁'],
            ['今天留一句', '写不出就写「无事」'],
            ['心情', '选一个词'],
            ['一个念头', '先存着，不用想明白'],
            ['一个收获', '一句话就够'],
            ['随手记', '一个画面、一句话'],
        ]),
        prompts: {
            work: ['今天留一句就好。', '最先冒出来的一句话是什么？', '今天没什么大事，也值得留一行。'],
            money: ['今天有一笔想记的吗？', '一个词记下钱的事。', '随手一笔，不用展开。'],
            health: ['身体，一个词。', '今天精神怎么样？', '一个字也算数。'],
            relation: ['今天想到了谁？', '一个名字就好。', '有谁在你心里过了一下？'],
            future: ['写不出就写「无事」。', '今天留一句给自己。', '一句话，收工。'],
            emotion: ['此刻心情，一个词。', '今天的底色是什么？', '选一个词就够。'],
            dream: ['刚才闪过什么念头？', '先存着，不用想明白。', '一个词记下它。'],
            growth: ['今天的一个收获？', '一句话就够。', '有什么小发现？'],
            free: ['一个画面、一句话。', '随手记，别删。', '现在脑子里是什么？'],
        },
    },
];

// 头七天轻松引导：用低门槛的提问降低起步压力
const FIRST_WEEK_PROMPTS = {
    work: '今天工作里，有哪件小事让你挺开心？',
    money: '今天有一笔花得挺值的钱吗？',
    health: '身体哪一刻让你觉得舒服？',
    relation: '今天有谁让你心里一暖？',
    future: '今天想做的一件开心的小事？',
    emotion: '此刻最让你愉快的一个念头？',
    dream: '离梦想更近的一点好消息？',
    growth: '今天学到的一件开心事？',
    free: '写一件今天让你笑出来的事就好。',
};

// 第 1 / 3 / 7 天给一点正反馈，帮助把记录变成习惯
const CELEBRATIONS = {
    1: '第一天写完了，值得为自己庆祝——吃顿丰盛的早餐吧。',
    3: '第三天，已经跨过第一道关卡，去看场电影或买件想要的东西。',
    7: '第七天！大多数人就在这一天放弃，把好朋友约出来分享喜悦。',
};

// 周 / 月结构化复盘提问：按不同周期给出可回答的小问题
const REVIEW_PROMPTS = {
    week: [
        '这周最有触动的一件事是什么？为什么？',
        '回头看，我从中看到了什么规律？',
        '下周想调整的一件小事是什么？',
    ],
    month: [
        '这个月反复出现的主题是什么？',
        '哪个决定，现在看是对的？',
        '下个月想留出余闲给什么？',
    ],
};

const MOOD_LEVEL = { '愉悦': 5, '平静': 4, '一般': 3, '低落': 2, '烦躁': 1 };

// 本机高频词过滤用的停用短语与虚词（纯离线统计，不做语义分析）
const STOP_PHRASES = [
    '今天', '昨天', '明天', '这个', '那个', '什么', '怎么', '自己', '觉得', '感觉',
    '事情', '时候', '可以', '没有', '就是', '还是', '因为', '所以', '然后', '其实',
    '一下', '一点', '一些', '有点', '不错', '一般', '之后', '之前', '现在', '以后',
    '已经', '可能', '应该', '需要', '想要', '这样', '那样', '如何', '有没有', '出来',
    '起来', '下去', '上来', '过去', '回来', '到了', '看到', '想到', '知道', '觉得',
];
const HEAD_STOP = '的了是在有和就都而及与也很还把被让从对为以于之其不没要会能可说做去来吧呢啊哦嗯呀嘛把被让使令';
const TAIL_STOP = '的了着过是在有和就都也还吧呢啊哦嗯呀嘛么把被让从对为以于之其';

// ---------- 会话内读缓存 ----------
// wx.getStorageSync 是同步阻塞主线程的；首页一次 refresh 会分别经由
// stats / firstWeekState / previousToday / 九格 promptFor 反复全量读日记，
// 日记攒到半年后就会明显卡顿。这里做「写时失效」的内存缓存，读走内存，
// 任何一次落盘立刻置脏，保证不会读到旧数据。
let memoAll = null;
let memoWritten = null;
let memoStats = null;
// 高频词统计缓存：2/3/4-gram 三重循环，365 篇单次就要 30ms 以上，
// 而回看页 onShow / 点日期都会调一次。结果与 limit 绑定，换 limit 必须重算。
let memoFreq = null;
let memoFreqLimit = 0;

function invalidateMemo() {
    memoAll = null;
    memoWritten = null;
    memoStats = null;
    memoFreq = null;
    memoFreqLimit = 0;
}

function pad(n) {
    return n < 10 ? '0' + n : '' + n;
}

function formatDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function today() {
    return formatDate(new Date());
}

function emptyBase() {
    return { weather: '', anniversary: '', body: '', mood: '' };
}

function emptyRecord(date) {
    const cells = {};
    GRID_KEYS.forEach(function (k) { cells[k] = ''; });
    return {
        date: date,
        base: emptyBase(),
        cells: cells,
        workBoard: workBoard.empty(),
        moneyBook: moneyBook.empty(),
        studyLog: studyLog.empty(),
        template: getTemplateId(),
        updatedAt: 0,
    };
}

function ok(data) {
    return { data: data, error: null };
}

function fail(code) {
    return { data: null, error: code };
}

function read(date) {
    try {
        return wx.getStorageSync(PREFIX + date) || null;
    } catch (e) {
        return null;
    }
}

function write(record) {
    try {
        wx.setStorageSync(PREFIX + record.date, record);
        invalidateMemo();
        return true;
    } catch (e) {
        // 单键超 1MB / 总容量超 10MB 时 setStorageSync 会抛错。
        // 必须让上层知道是「空间不够」而不是普通异常，否则用户写完就是静默丢稿。
        const msg = String((e && (e.errMsg || e.message)) || '');
        if (/exceed|quota|size|limit/i.test(msg)) return 'QUOTA_EXCEEDED';
        return false;
    }
}

function hasContent(record) {
    if (!record) return false;
    // 只写了任务或感想，也算这一篇有内容（与「留一句也算一篇」同口径）
    if (workBoard.hasContent(record.workBoard)) return true;
    // 只记了一笔收支，也算这一篇有内容
    if (moneyBook.hasContent(record.moneyBook)) return true;
    // 只记了一条学习进展或一句心得，也算这一篇有内容
    if (studyLog.hasContent(record.studyLog)) return true;
    const base = record.base || {};
    if (base.weather || base.anniversary || base.body || base.mood) return true;
    const cells = record.cells || {};
    return Object.keys(cells).some(function (k) {
        const v = cells[k];
        // 只认字符串：历史脏数据混进对象时 String() 会得到 "[object Object]"，
        // 会把空白的一天误判成有内容，进而污染连续天数与导出条数。
        return typeof v === 'string' && v.trim().length > 0;
    });
}

function load(date) {
    const rec = read(date);
    const merged = emptyRecord(date);
    if (rec) {
        merged.base = Object.assign({}, merged.base, rec.base || {});
        merged.cells = Object.assign({}, merged.cells, rec.cells || {});
        merged.workBoard = workBoard.normalize(rec.workBoard);
        merged.moneyBook = moneyBook.normalize(rec.moneyBook);
        merged.studyLog = studyLog.normalize(rec.studyLog);
        merged.template = rec.template || 'standard';
        merged.updatedAt = rec.updatedAt || 0;
    } else {
        merged.template = getTemplateId();
    }
    return ok(merged);
}

function save(record) {
    if (!record || !record.date) return fail('INVALID_DATE');
    try {
        if (!wx.getStorageSync(STARTED_KEY)) wx.setStorageSync(STARTED_KEY, record.date);
    } catch (e) {}
    // 旧调用路径若没带 workBoard / moneyBook / studyLog，回读原记录，避免抹掉已写内容
    let board = record.workBoard;
    let book = record.moneyBook;
    let log = record.studyLog;
    if (!board || !book || !log) {
        const prev = read(record.date);
        if (!board && prev && prev.workBoard) board = prev.workBoard;
        if (!book && prev && prev.moneyBook) book = prev.moneyBook;
        if (!log && prev && prev.studyLog) log = prev.studyLog;
    }
    // 落盘前统一裁剪：单键 1MB 是微信 storage 的硬上限，超了整篇都存不进去。
    // 宁可截断超长正文，也不能让用户点完保存后静默丢稿。
    const cleanBase = emptyBase();
    Object.keys(cleanBase).forEach(function (k) {
        const v = (record.base || {})[k];
        cleanBase[k] = typeof v === 'string' ? v.slice(0, BASE_MAX) : '';
    });
    const cleanCells = {};
    GRID_KEYS.forEach(function (k) {
        const v = (record.cells || {})[k];
        cleanCells[k] = typeof v === 'string' ? v.slice(0, CELL_MAX) : '';
    });
    const next = Object.assign({}, record, {
        base: cleanBase,
        cells: cleanCells,
        template: record.template || getTemplateId(),
        updatedAt: Date.now(),
        workBoard: workBoard.normalize(board),
        moneyBook: moneyBook.normalize(book),
        studyLog: studyLog.normalize(log),
    });
    const w = write(next);
    if (w === true) return ok(next);
    return fail(w === 'QUOTA_EXCEEDED' ? 'QUOTA_EXCEEDED' : 'CLIENT_EXCEPTION');
}

function listDates() {
    try {
        const info = wx.getStorageInfoSync();
        const keys = (info.keys || []).filter(function (k) {
            return k.indexOf(PREFIX) === 0 && DATE_KEY_RE.test(k.slice(PREFIX.length));
        });
        return ok(keys.map(function (k) { return k.slice(PREFIX.length); }).sort().reverse());
    } catch (e) {
        return fail('CLIENT_EXCEPTION');
    }
}

function all() {
    if (memoAll) return memoAll;
    const result = listDates();
    if (result.error) return result;
    memoAll = ok(result.data.map(read).filter(function (r) {
        return r && typeof r.date === 'string' && DATE_KEY_RE.test(r.date);
    }));
    return memoAll;
}

// 调用极频繁（首页九格 promptFor、firstWeekState、导出前校验）
function writtenDates() {
    if (memoWritten) return memoWritten.slice();
    const result = all();
    if (result.error) return [];
    memoWritten = result.data.filter(hasContent).map(function (x) { return x.date; }).sort().reverse();
    return memoWritten.slice();
}

function dayNumber(dateStr) {
    const p = String(dateStr || '').split('-');
    const y = Number(p[0]);
    const m = Number(p[1]);
    const d = Number(p[2]);
    // 脏数据（空值 / 旧格式）会让差值变成 NaN，界面上就会出现「已到期 NaN 天」
    if (!y || !m || !d) return NaN;
    return Date.UTC(y, m - 1, d) / 86400000;
}

function bestStreakOf(dates) {
    if (!dates.length) return 0;
    const asc = dates.slice().sort();
    let best = 1;
    let cur = 1;
    for (let i = 1; i < asc.length; i += 1) {
        if (dayNumber(asc[i]) - dayNumber(asc[i - 1]) === 1) cur += 1;
        else cur = 1;
        if (cur > best) best = cur;
    }
    return best;
}

function weekStartDate() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const wd = d.getDay();
    d.setDate(d.getDate() - (wd === 0 ? 6 : wd - 1));
    return d;
}

function weekEndDate() {
    const s = weekStartDate();
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    return e;
}

// 历史记录一律按「标准栏目名」归档，避免切换模板后回看口径漂移
function labelOf(key) {
    let label = key;
    TEMPLATES[0].fields.forEach(function (f) { if (f.key === key) label = f.label; });
    BASE_FIELDS.forEach(function (f) { if (f.key === key) label = f.label; });
    return label;
}

function topKey(map) {
    let best = '';
    let n = 0;
    Object.keys(map).forEach(function (k) {
        if (map[k] > n) { n = map[k]; best = k; }
    });
    return best;
}

function stats() {
    if (memoStats) return memoStats;
    const dates = writtenDates();
    const set = {};
    dates.forEach(function (d) { set[d] = true; });

    // 连续天数：今天尚未写时，从昨天开始回溯，避免早晨打开就断签
    let cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    if (!set[formatDate(cursor)]) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (set[formatDate(cursor)]) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
    }

    // 本周已写几天：只数「本周开始 → 今天」这段，未来日期不算。
    // 备份里混进未来日期的记录时，否则会出现「本周节奏 6 / 3 天」这种自相矛盾的数。
    const start = formatDate(weekStartDate());
    const nowStr = formatDate(new Date());
    const weekCount = dates.filter(function (d) { return d >= start && d <= nowStr; }).length;
    const wd = new Date().getDay();
    const weekTotal = wd === 0 ? 7 : wd;

    let gentle;
    if (!dates.length) gentle = '从今天写第一行开始，不必追求完美。';
    else if (streak === 0) gentle = '断了也没关系，今天写一行就接上了。';
    else if (weekCount >= WEEK_GOAL) gentle = '这周已经稳稳写了 ' + weekCount + ' 天，保持就好。';
    else gentle = '本周已写 ' + weekCount + ' 天，不必天天满格。';

    let startedAt = '';
    try { startedAt = wx.getStorageSync(STARTED_KEY) || ''; } catch (e) {}

    memoStats = ok({
        total: dates.length,
        streak: streak,
        bestStreak: bestStreakOf(dates),
        weekCount: weekCount,
        weekTotal: weekTotal,
        weekGoal: WEEK_GOAL,
        gentle: gentle,
        startedAt: startedAt,
        thousandProgress: Math.min(dates.length, 1000) / 1000,
        latest: dates[0] || '',
    });
    return memoStats;
}

// ---------- 奖励里程碑（周期与内容都可自定义） ----------
// 奖励里程碑只给一组常见节点作默认值，用户可自由增删改
const DEFAULT_MILESTONES = [
    { at: 3, reward: '一顿美食' },
    { at: 90, reward: '一次旅行' },
    { at: 365, reward: '游乐场 / K歌' },
    { at: 1000, reward: '为梦想而生' },
];

const MAX_MILESTONES = 12;
const MAX_REWARD_LEN = 30;

function cleanReward(s) {
    return String(s || '').replace(/[\r\n]/g, ' ').trim().slice(0, MAX_REWARD_LEN);
}

function sanitizeMilestones(list) {
    const out = [];
    const seen = {};
    (Array.isArray(list) ? list : []).forEach(function (m) {
        const at = Math.floor(Number(m && m.at));
        if (!at || at < 1 || at > 10000) return;
        if (seen[at]) return;
        seen[at] = true;
        out.push({ at: at, reward: cleanReward(m.reward) || '给自己一份奖励' });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out.slice(0, MAX_MILESTONES);
}

// null 表示从未自定义（用默认）；空数组表示用户把奖励全删了，不能拿默认值回填
function readMilestones() {
    try {
        const v = wx.getStorageSync(MILESTONE_KEY);
        if (v && typeof v === 'object' && Array.isArray(v.items)) return v.items;
    } catch (e) {}
    return null;
}

function milestones() {
    const saved = readMilestones();
    if (saved === null) {
        return ok(DEFAULT_MILESTONES.map(function (m) { return { at: m.at, reward: m.reward }; }));
    }
    return ok(sanitizeMilestones(saved));
}

function saveMilestones(list) {
    const clean = sanitizeMilestones(list);
    try { wx.setStorageSync(MILESTONE_KEY, { items: clean }); return ok(clean); }
    catch (e) { return fail('CLIENT_EXCEPTION'); }
}

function resetMilestones() {
    try { wx.removeStorageSync(MILESTONE_KEY); } catch (e) {}
    return milestones();
}

function periodHint(at) {
    if (at === 1000) return '千日';
    if (at % 365 === 0) return (at / 365) + ' 年';
    if (at % 30 === 0) return (at / 30) + ' 个月';
    if (at % 7 === 0) return (at / 7) + ' 周';
    return '';
}

// 给页面供数：每条带达成状态、还差几天、周期换算提示
function milestoneView(total) {
    const r = milestones();
    if (r.error) return r;
    const n = Math.max(0, Math.floor(Number(total) || 0));
    let next = null;
    const list = r.data.map(function (m) {
        const done = n >= m.at;
        const item = {
            at: m.at,
            reward: m.reward,
            label: '第 ' + m.at + ' 天',
            hint: periodHint(m.at),
            done: done,
            remain: Math.max(0, m.at - n),
        };
        if (!done && !next) next = item;
        return item;
    });
    return ok({ total: n, list: list, next: next, count: list.length });
}

// ---------- 模板 ----------
function templateById(id) {
    let found = TEMPLATES[0];
    TEMPLATES.forEach(function (t) { if (t.id === id) found = t; });
    return found;
}

function getTemplateId() {
    try {
        const v = wx.getStorageSync(TEMPLATE_KEY);
        let valid = false;
        TEMPLATES.forEach(function (t) { if (t.id === v) valid = true; });
        return valid ? v : 'standard';
    } catch (e) {
        return 'standard';
    }
}

function activeTemplate() {
    return templateById(getTemplateId());
}

function activeGridFields() {
    return activeTemplate().fields;
}

function fieldsFor(id) {
    return templateById(id).fields;
}

function setTemplate(id) {
    let valid = false;
    TEMPLATES.forEach(function (t) { if (t.id === id) valid = true; });
    if (!valid) return fail('INVALID_TEMPLATE');
    try { wx.setStorageSync(TEMPLATE_KEY, id); return ok(id); }
    catch (e) { return fail('CLIENT_EXCEPTION'); }
}

// ---------- 头七天轻松引导 ----------
function firstWeekEnabled() {
    try { return wx.getStorageSync(FIRSTWEEK_KEY) !== 'off'; }
    catch (e) { return true; }
}

function setFirstWeekEnabled(on) {
    try { wx.setStorageSync(FIRSTWEEK_KEY, on ? 'on' : 'off'); return ok(on); }
    catch (e) { return fail('CLIENT_EXCEPTION'); }
}

// ---------- 功能模块开关 ----------
function defaultModules() {
    return { work: true, money: true, growth: true };
}

function modules() {
    const out = defaultModules();
    try {
        const raw = wx.getStorageSync(MODULES_KEY);
        // 只认明确的 false，其余（含脏数据、旧版本没有这个键）一律按开启
        if (raw && typeof raw === 'object') {
            MODULE_DEFS.forEach(function (m) {
                if (raw[m.id] === false) out[m.id] = false;
            });
        }
        return ok(out);
    } catch (e) {
        return ok(out);
    }
}

function setModule(id, on) {
    const valid = MODULE_DEFS.some(function (m) { return m.id === id; });
    if (!valid) return fail('INVALID_MODULE');
    const cur = modules();
    const next = cur.error ? defaultModules() : cur.data;
    next[id] = !!on;
    try {
        wx.setStorageSync(MODULES_KEY, next);
        return ok(next);
    } catch (e) {
        return fail('CLIENT_EXCEPTION');
    }
}

function firstWeekState() {
    const total = writtenDates().length;
    const enabled = firstWeekEnabled();
    return ok({
        enabled: enabled,
        active: enabled && total < 7,
        total: total,
        dayNo: Math.min(total + 1, 7),
        celebration: CELEBRATIONS[total] || '',
    });
}

// 引导提问：按日期确定性轮换，offset 用于「换一题」
// 头七天默认只给轻松的题；用户主动换题时回到所选模板的题库
function promptFor(key, dateStr, offset) {
    const off = offset || 0;
    if (off === 0 && firstWeekEnabled() && writtenDates().length < 7 && FIRST_WEEK_PROMPTS[key]) {
        return FIRST_WEEK_PROMPTS[key];
    }
    const tpl = activeTemplate();
    const list = (tpl.prompts && tpl.prompts[key]) || PROMPTS[key] || [];
    if (!list.length) return '';
    const seed = parseInt(String(dateStr || today()).replace(/-/g, ''), 10) + off;
    const idx = ((seed % list.length) + list.length) % list.length;
    return list[idx];
}

// ---------- 写前回看去年今日 ----------
function previousToday() {
    const md = today().slice(5);
    const result = sameDayAcrossYears(md);
    if (result.error) return result;
    const thisYear = new Date().getFullYear();
    const past = result.data.filter(function (r) {
        return r && typeof r.date === 'string' && Number(r.date.slice(0, 4)) < thisYear;
    });
    return ok(past.length ? past[0] : null);
}

// 同日跨年：同一月日，跨年份并排回看
function sameDayAcrossYears(monthDay) {
    const result = all();
    if (result.error) return result;
    const items = result.data.filter(function (x) {
        return x && typeof x.date === 'string'
            && x.date.slice(5) === monthDay && hasContent(x);
    });
    items.sort(function (a, b) { return b.date.localeCompare(a.date); });
    return ok(items);
}

// 对应书中「使用查找功能找出忘记的那一天」
// 少数派《序日使用指南》补上「按正文文字或心情查找」；心情筛选可单独用，不必先输关键词
function search(keyword, mood) {
    const kw = String(keyword || '').trim();
    const m = String(mood || '').trim();
    if (!kw && !m) return ok([]);
    const result = all();
    if (result.error) return result;

    const labelMap = {};
    TEMPLATES[0].fields.forEach(function (f) { labelMap[f.key] = f.label; });
    BASE_FIELDS.forEach(function (f) { labelMap[f.key] = f.label; });

    const hits = [];
    result.data.forEach(function (rec) {
        if (hits.length >= SEARCH_LIMIT) return;
        if (!hasContent(rec)) return;
        if (m && String((rec.base || {}).mood || '').trim() !== m) return;

        // 只按心情浏览：每篇给一条摘要，避免同一天刷出十几条
        if (!kw) {
            const fields = fieldsFor(rec.template);
            let excerpt = '';
            for (let i = 0; i < fields.length; i += 1) {
                const t = String((rec.cells || {})[fields[i].key] || '').trim();
                if (t) { excerpt = t.length > 90 ? t.slice(0, 90) + '…' : t; break; }
            }
            hits.push({ date: rec.date, label: '心情 · ' + m, text: excerpt });
            return;
        }

        Object.keys(rec.cells || {}).forEach(function (k) {
            if (hits.length >= SEARCH_LIMIT) return;
            const text = String(rec.cells[k] || '');
            if (text.indexOf(kw) >= 0) hits.push({ date: rec.date, label: labelMap[k] || k, text: text });
        });
        Object.keys(rec.base || {}).forEach(function (k) {
            const text = String(rec.base[k] || '');
            if (text && text.indexOf(kw) >= 0) hits.push({ date: rec.date, label: labelMap[k] || k, text: text });
        });
    });
    return ok(hits);
}

// 本周小结：把一周聚合成几句提炼，对应「日 / 周 / 月 / 年」多维度复盘
function weeklyReview() {
    const result = all();
    if (result.error) return result;
    const start = formatDate(weekStartDate());
    const end = formatDate(weekEndDate());
    const items = result.data.filter(function (r) {
        return r.date >= start && r.date <= end && hasContent(r);
    });

    const moodCounts = {};
    const fieldCounts = {};
    const excerpts = [];
    let chars = 0;
    items.forEach(function (r) {
        const mood = String((r.base || {}).mood || '').trim();
        if (mood) moodCounts[mood] = (moodCounts[mood] || 0) + 1;
        Object.keys(r.cells || {}).forEach(function (k) {
            const t = String(r.cells[k] || '').trim();
            if (!t) return;
            fieldCounts[k] = (fieldCounts[k] || 0) + 1;
            chars += t.length;
            if (t.length <= 60 && excerpts.length < 2) {
                excerpts.push({ date: r.date, label: labelOf(k), text: t });
            }
        });
    });

    const topMood = topKey(moodCounts);
    const topField = topKey(fieldCounts);
    let summary;
    if (!items.length) {
        summary = '这一周还没动笔，今天写一行就好。';
    } else {
        summary = '本周写了 ' + items.length + ' 天';
        if (topField) summary += '，最常写的是「' + labelOf(topField) + '」';
        if (topMood) summary += '，心情以「' + topMood + '」为主';
        summary += '。';
    }

    return ok({
        start: start,
        end: end,
        days: items.length,
        chars: chars,
        topMood: topMood,
        topFieldLabel: topField ? labelOf(topField) : '',
        summary: summary,
        excerpts: excerpts,
    });
}

// 本机高频词：纯离线 n-gram 统计，不做语义分析
// 只保留至少出现在 2 篇不同日记里的 2~4 字片段，并对重叠片段去重
function frequentPhrases(limit) {
    const want = limit || 12;
    // 命中缓存直接返回：同一份日记数据反复进回看页时不再重算 n-gram
    if (memoFreq && memoFreqLimit === want) return memoFreq;
    const result = all();
    if (result.error) return result;
    const counts = {};
    const daySets = {};

    result.data.forEach(function (rec) {
        if (!hasContent(rec)) return;
        let text = '';
        Object.keys(rec.cells || {}).forEach(function (k) {
            text += String(rec.cells[k] || '') + ' ';
        });
        const chunks = text.match(/[\u4e00-\u9fa5]+/g) || [];
        chunks.forEach(function (chunk) {
            for (let size = 2; size <= 4; size += 1) {
                for (let i = 0; i + size <= chunk.length; i += 1) {
                    const p = chunk.slice(i, i + size);
                    if (STOP_PHRASES.indexOf(p) >= 0) continue;
                    if (HEAD_STOP.indexOf(p.charAt(0)) >= 0) continue;
                    if (TAIL_STOP.indexOf(p.charAt(size - 1)) >= 0) continue;
                    counts[p] = (counts[p] || 0) + 1;
                    if (!daySets[p]) daySets[p] = {};
                    daySets[p][rec.date] = true;
                }
            }
        });
    });

    const candidates = Object.keys(counts).map(function (p) {
        return { phrase: p, count: counts[p], days: Object.keys(daySets[p]).length };
    }).filter(function (x) {
        return x.days >= 2 && x.count >= 2;
    });
    candidates.sort(function (a, b) {
        const sa = a.days * 10 + a.count + a.phrase.length * 4;
        const sb = b.days * 10 + b.count + b.phrase.length * 4;
        return sb - sa;
    });

    // 重叠片段保留更具体（更长）的那个，避免出现「项目推」这类被截断的词
    const picked = [];
    candidates.forEach(function (x) {
        if (picked.length >= want) return;
        let replaceAt = -1;
        for (let i = 0; i < picked.length; i += 1) {
            const p = picked[i].phrase;
            if (p.indexOf(x.phrase) >= 0) return;
            if (x.phrase.indexOf(p) >= 0) { replaceAt = i; break; }
        }
        if (replaceAt >= 0) picked[replaceAt] = x;
        else picked.push(x);
    });

    memoFreq = ok({
        phrases: picked,
        scanned: result.data.filter(hasContent).length,
        note: '本地统计反复出现的字句，非语义分析；数据不离开本机。',
    });
    memoFreqLimit = want;
    return memoFreq;
}

// 近 N 天心情趋势（借鉴心光 30 天趋势图，纯本地计算）
function moodTrend(days) {
    const n = days || 30;
    const result = all();
    if (result.error) return result;
    const byDate = {};
    result.data.forEach(function (r) { byDate[r.date] = r; });

    const items = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = n - 1; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = formatDate(d);
        const rec = byDate[key];
        const written = !!(rec && hasContent(rec));
        const mood = written ? String((rec.base || {}).mood || '') : '';
        const level = MOOD_LEVEL[mood] || 0;
        items.push({
            date: key,
            day: d.getDate(),
            written: written,
            mood: mood,
            level: level,
            cls: level ? 'mt-' + level : (written ? 'mt-written' : 'mt-empty'),
        });
    }

    const levels = items.filter(function (x) { return x.level > 0; }).map(function (x) { return x.level; });
    const avg = levels.length ? levels.reduce(function (a, b) { return a + b; }, 0) / levels.length : 0;
    let note;
    if (!levels.length) note = '还没记过心情，从今天选一个就好。';
    else if (avg >= 4) note = '最近心情整体舒展，继续保持这个节奏。';
    else if (avg >= 3) note = '最近心情比较平稳，写下来就很好。';
    else note = '最近有些起伏，写下来本身就是一种照顾。';

    return ok({
        items: items,
        days: n,
        withMood: levels.length,
        average: avg.toFixed(1),
        note: note,
    });
}

// ---------- 周 / 月结构化复盘 ----------
function reviewPeriodKey(period) {
    if (period === 'month') return today().slice(0, 7);
    return formatDate(weekStartDate());
}

function reviewPrompts(period) {
    return REVIEW_PROMPTS[period] || REVIEW_PROMPTS.week;
}

function loadReview(period, key) {
    const p = REVIEW_PROMPTS[period] ? period : 'week';
    try {
        const v = wx.getStorageSync(REVIEW_PREFIX + p + '_' + key);
        const base = ['', '', ''];
        if (v && Array.isArray(v)) {
            for (let i = 0; i < 3; i += 1) base[i] = String(v[i] || '');
        }
        return ok(base);
    } catch (e) {
        return ok(['', '', '']);
    }
}

function saveReview(period, key, answers) {
    const p = REVIEW_PROMPTS[period] ? period : 'week';
    const a = (answers || []).slice(0, 3).map(function (x) { return String(x || '').slice(0, 500); });
    while (a.length < 3) a.push('');
    try {
        wx.setStorageSync(REVIEW_PREFIX + p + '_' + key, a);
        return ok(a);
    } catch (e) {
        return fail('CLIENT_EXCEPTION');
    }
}

// ---------- 未来胶囊：写给未来的自己，到期才可开启 ----------
// 设计说明：把想说的话封存，到期才可开启；信件与日记一起纳入本地备份。
const CAPSULE_KEY = 'morning_capsules';
let capsuleSeq = 0;

function readCapsules() {
    try {
        const v = wx.getStorageSync(CAPSULE_KEY);
        return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
}

function writeCapsules(list) {
    try { wx.setStorageSync(CAPSULE_KEY, list); return true; }
    catch (e) { return false; }
}

// 快捷寄出日期，免得手动翻日历
function capsulePresets() {
    const d = new Date();
    const out = [];
    function add(label, days, months, years) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (days) t.setDate(t.getDate() + days);
        if (months) t.setMonth(t.getMonth() + months);
        if (years) t.setFullYear(t.getFullYear() + years);
        out.push({ label: label, value: formatDate(t) });
    }
    add('7 天后', 7, 0, 0);
    add('一个月后', 0, 1, 0);
    add('半年后', 0, 6, 0);
    add('明年今天', 0, 0, 1);
    return out;
}

function saveCapsule(text, openAt) {
    const t = String(text || '').trim().slice(0, 500);
    if (!t) return fail('EMPTY_TEXT');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(openAt)) return fail('INVALID_DATE');
    if (openAt <= today()) return fail('DATE_NOT_FUTURE');
    capsuleSeq += 1;
    const item = {
        id: 'c_' + Date.now() + '_' + capsuleSeq,
        text: t,
        openAt: openAt,
        writtenAt: today(),
        createdAt: Date.now(),
        opened: false,
        openedAt: 0,
    };
    const list = readCapsules();
    list.push(item);
    return writeCapsules(list) ? ok(item) : fail('CLIENT_EXCEPTION');
}

function listCapsules() {
    return ok(readCapsules().slice().sort(function (a, b) {
        return String(a.openAt).localeCompare(String(b.openAt));
    }));
}

// 到期（含逾期）且尚未开启的信，供今日页顶部提示
function dueCapsules() {
    const t = today();
    return ok(readCapsules().filter(function (x) {
        return !x.opened && x.openAt <= t;
    }).sort(function (a, b) {
        return String(a.openAt).localeCompare(String(b.openAt));
    }));
}

function openCapsule(id) {
    const list = readCapsules();
    let found = null;
    list.forEach(function (x) { if (x.id === id) found = x; });
    if (!found) return fail('NOT_FOUND');
    found.opened = true;
    found.openedAt = Date.now();
    return writeCapsules(list) ? ok(found) : fail('CLIENT_EXCEPTION');
}

// 日期中文化：胶囊页与今日页共用，避免各页重复实现
function prettyDate(s) {
    if (!s) return '';
    const p = String(s).split('-');
    return Number(p[0]) + '年' + Number(p[1]) + '月' + Number(p[2]) + '日';
}

// 胶囊分类 + 到期倒计时：按「待开启 / 封存中 / 已开启」三组供数，页面只负责渲染
// daysLeft：正数=还有几天，0=今天可开启，负数=已逾期天数
function capsuleGroups() {
    const tNum = dayNumber(today());
    const groups = { due: [], sealed: [], opened: [] };

    readCapsules().forEach(function (x) {
        const openNum = dayNumber(x.openAt);
        if (isNaN(openNum)) return;
        const diff = openNum - tNum;
        let countText;
        if (x.opened) countText = '已开启';
        else if (diff > 1) countText = '还有 ' + diff + ' 天';
        else if (diff === 1) countText = '明天开启';
        else if (diff === 0) countText = '今天可开启';
        else countText = '已到期 ' + (-diff) + ' 天';

        // 封存进度：从寄出日到开启日已经走过多少（纯本地计算，无网络）
        const from = dayNumber(x.writtenAt || x.openAt);
        const span = dayNumber(x.openAt) - from;
        const passed = span > 0 ? tNum - from : 0;
        const percent = span > 0 ? Math.max(0, Math.min(100, Math.round(passed * 100 / span))) : 100;

        const text = String(x.text || '');
        const item = {
            id: x.id,
            text: text,
            openAt: x.openAt,
            openAtLabel: prettyDate(x.openAt),
            writtenAt: x.writtenAt || '',
            writtenAtLabel: prettyDate(x.writtenAt || x.openAt),
            opened: !!x.opened,
            daysLeft: diff,
            overdueDays: diff < 0 ? -diff : 0,
            countText: countText,
            progress: percent,
            preview: text.length > 70 ? text.slice(0, 70) + '…' : text,
        };
        if (x.opened) groups.opened.push(item);
        else if (diff <= 0) groups.due.push(item);
        else groups.sealed.push(item);
    });

    groups.due.sort(function (a, b) { return a.openAt.localeCompare(b.openAt); });
    groups.sealed.sort(function (a, b) { return a.openAt.localeCompare(b.openAt); });
    groups.opened.sort(function (a, b) { return b.openAt.localeCompare(a.openAt); });

    return ok({
        due: groups.due,
        sealed: groups.sealed,
        opened: groups.opened,
        total: groups.due.length + groups.sealed.length + groups.opened.length,
        dueCount: groups.due.length,
        sealedCount: groups.sealed.length,
        openedCount: groups.opened.length,
    });
}

// 全年像素年历：一天一格，把长期记录变成一张图
function yearPixels(year) {
    const result = all();
    if (result.error) return result;
    const byDate = {};
    result.data.forEach(function (r) { byDate[r.date] = r; });

    const now = new Date();
    const thisYear = now.getFullYear();
    const months = [];
    let writtenCount = 0;
    let totalDays = 0;

    for (let m = 1; m <= 12; m += 1) {
        const daysInMonth = new Date(year, m, 0).getDate();
        const cells = [];
        for (let d = 1; d <= 31; d += 1) {
            if (d > daysInMonth) {
                cells.push({ day: d, blank: true, cls: 'px-blank' });
                continue;
            }
            totalDays += 1;
            const key = year + '-' + pad(m) + '-' + pad(d);
            const rec = byDate[key];
            const written = !!(rec && hasContent(rec));
            const level = written ? (MOOD_LEVEL[String((rec.base || {}).mood || '')] || 0) : 0;
            const isFuture = year > thisYear ||
                (year === thisYear && new Date(year, m - 1, d) > now);

            let cls;
            if (isFuture) cls = 'px-future';
            else if (!written) cls = 'px-empty';
            else if (level) cls = 'px-' + level;
            else cls = 'px-written';

            if (written) writtenCount += 1;
            cells.push({ date: key, day: d, written: written, mood: level, cls: cls });
        }
        months.push({ month: m, label: m + '月', cells: cells });
    }

    return ok({
        year: year,
        months: months,
        writtenCount: writtenCount,
        totalDays: totalDays,
        canNext: year < thisYear,
    });
}

// 随机重读一篇：填满「尚未跨年」前的回看空窗
function randomEntry(excludeDate) {
    const result = all();
    if (result.error) return result;
    const items = result.data.filter(hasContent);
    if (!items.length) return ok(null);
    const pool = items.filter(function (r) { return r.date !== excludeDate; });
    const arr = pool.length ? pool : items;
    return ok(arr[Math.floor(Math.random() * arr.length)]);
}

function stamp(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return formatDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 导出 Markdown：少数派《本地存储 + 线上获取》主张 JSON / Markdown 这类「公有数据结构」，
// 《我的日记方法及实践路径》称「便利导出、本地优先的文本编辑才是日记的灵魂」。
// 本格式可直接拖进 Obsidian / Logseq / 思源笔记，不被专有格式锁住。
function exportMarkdown() {
    const result = all();
    if (result.error) return result;
    const items = result.data.filter(hasContent).sort(function (a, b) {
        return b.date.localeCompare(a.date);
    });
    const lines = [
        '# 九格手记',
        '',
        '> 导出时间：' + stamp(Date.now()) + ' · 共 ' + items.length + ' 篇',
        '> 数据只存在本机。本文件为标准 Markdown，可直接导入 Obsidian / Logseq / 思源笔记。',
        '',
    ];
    items.forEach(function (r) {
        lines.push('## ' + r.date);
        lines.push('');
        const b = r.base || {};
        const meta = [];
        if (b.weather) meta.push('天气：' + b.weather);
        if (b.body) meta.push('身体：' + b.body);
        if (b.mood) meta.push('心情：' + b.mood);
        if (b.anniversary) meta.push('纪念日：' + b.anniversary);
        if (meta.length) { lines.push('`' + meta.join(' · ') + '`'); lines.push(''); }
        fieldsFor(r.template).forEach(function (f) {
            const t = String((r.cells || {})[f.key] || '').trim();
            if (!t) return;
            lines.push('### ' + f.label);
            lines.push('');
            lines.push(t.split('\n').join('\n\n'));
            lines.push('');
        });
        const wb = workBoard.normalize(r.workBoard);
        if (workBoard.hasContent(wb)) {
            lines.push('### 工作模块 · 任务与感想');
            lines.push('');
            wb.tasks.forEach(function (t) {
                lines.push('- [' + (t.done ? 'x' : ' ') + '] ' + t.text);
            });
            if (wb.tasks.length) lines.push('');
            if (wb.reflection) {
                lines.push('**工作感想**：' + wb.reflection.split('\n').join('\n\n'));
                lines.push('');
            }
        }
        const mb = moneyBook.view(r.moneyBook);
        if (mb.count) {
            lines.push('### 金钱模块 · 收支');
            lines.push('');
            mb.entries.forEach(function (e) {
                lines.push('- ' + e.sign + '¥' + e.amountText + '  ' + e.label
                    + (e.note ? ' · ' + e.note : '')
                    + '（' + (e.type === 'income' ? '收入' : '支出') + '）');
            });
            lines.push('');
            lines.push('今日小计：收入 ' + mb.incomeText + ' · 支出 ' + mb.expenseText
                + ' · 结余 ' + mb.balanceText);
            lines.push('');
        }
        const sl = studyLog.normalize(r.studyLog);
        if (studyLog.hasContent(sl)) {
            lines.push('### 学习模块 · 今日进展');
            lines.push('');
            sl.entries.forEach(function (e) {
                lines.push('- ' + studyLog.kindOf(e.kind).label + '《' + e.title + '》'
                    + studyLog.actionLabel(e.action) + '  ' + e.done + '/' + e.total + ' ' + e.unit
                    + (e.note ? ' · ' + e.note : ''));
            });
            if (sl.entries.length) lines.push('');
            if (sl.note) {
                lines.push('**今日一句**：' + sl.note);
                lines.push('');
            }
        }
        lines.push('*记录于 ' + (stamp(r.updatedAt) || '时间未记录') + '*');
        lines.push('');
        lines.push('---');
        lines.push('');
    });
    const lib = readStudyLibrary();
    const lv = studyLog.view(lib);
    if (lv.allCount || lv.topics.length) {
        lines.push('## 学习库 · 条目与主题');
        lines.push('');
        lines.push('共 ' + lv.overall.total + ' 项 · 已完成 ' + lv.overall.finished
            + ' 项 · 整体推进 ' + lv.overall.avgPct + '%');
        lines.push('');
        lv.topics.forEach(function (t) {
            lines.push('- 主题：' + t.title + '（' + t.progressText + '，推进 ' + t.pct + '%）');
        });
        lv.items.forEach(function (it) {
            lines.push('- [' + (it.finished ? 'x' : ' ') + '] ' + it.kindLabel + '《' + it.title + '》  '
                + it.progressText + (it.topicTitle ? '  #' + it.topicTitle : '')
                + (it.note ? '  「' + it.note + '」' : ''));
        });
        lines.push('');
    }
    return ok(lines.join('\n'));
}

// 导出为可读文本（复制到剪贴板，可发到文件传输助手存档）
// 每篇带完整记录时间戳：少数派《我的日记工具选择路径》点名 flomo 导出无时间戳之痛
function exportText() {
    const result = all();
    if (result.error) return result;
    const items = result.data.filter(hasContent).sort(function (a, b) {
        return b.date.localeCompare(a.date);
    });
    const lines = [
        '九格手记 · 导出',
        '导出时间：' + stamp(Date.now()),
        '共 ' + items.length + ' 篇',
        '',
    ];
    items.forEach(function (r) {
        lines.push('────────────────');
        lines.push('【' + r.date + '】  记录于 ' + (stamp(r.updatedAt) || '时间未记录'));
        const b = r.base || {};
        const basics = [];
        if (b.weather) basics.push('天气：' + b.weather);
        if (b.body) basics.push('身体：' + b.body);
        if (b.mood) basics.push('心情：' + b.mood);
        if (b.anniversary) basics.push('纪念日：' + b.anniversary);
        if (basics.length) lines.push(basics.join('   '));
        const fields = fieldsFor(r.template);
        fields.forEach(function (f) {
            const t = String((r.cells || {})[f.key] || '').trim();
            if (t) lines.push('· ' + f.label + '：' + t);
        });
        const wb = workBoard.normalize(r.workBoard);
        if (workBoard.hasContent(wb)) {
            if (wb.tasks.length) {
                lines.push('· 工作任务：' + wb.tasks.map(function (t) {
                    return (t.done ? '✓ ' : '○ ') + t.text;
                }).join('；'));
            }
            if (wb.reflection) lines.push('· 工作感想：' + wb.reflection);
        }
        const mb = moneyBook.view(r.moneyBook);
        if (mb.count) {
            lines.push('· 收支：收入 ' + mb.incomeText + ' / 支出 ' + mb.expenseText
                + ' / 结余 ' + mb.balanceText);
            mb.entries.forEach(function (e) {
                lines.push('  ' + e.sign + '¥' + e.amountText + '  ' + e.label
                    + (e.note ? ' · ' + e.note : ''));
            });
        }
        const sl = studyLog.normalize(r.studyLog);
        if (studyLog.hasContent(sl)) {
            sl.entries.forEach(function (e) {
                lines.push('· 学习：' + studyLog.kindOf(e.kind).label + '《' + e.title + '》'
                    + studyLog.actionLabel(e.action) + '  ' + e.done + '/' + e.total + ' ' + e.unit
                    + (e.note ? ' · ' + e.note : ''));
            });
            if (sl.note) lines.push('· 今日一句：' + sl.note);
        }
        lines.push('');
    });
    const lib = readStudyLibrary();
    const lv = studyLog.view(lib);
    if (lv.allCount || lv.topics.length) {
        lines.push('────────────────');
        lines.push('学习库 · 共 ' + lv.overall.total + ' 项，已完成 ' + lv.overall.finished
            + ' 项，整体推进 ' + lv.overall.avgPct + '%');
        lv.topics.forEach(function (t) {
            lines.push('  主题 ' + t.title + '：' + t.progressText + '，推进 ' + t.pct + '%');
        });
        lv.items.forEach(function (it) {
            lines.push('  [' + (it.finished ? 'x' : ' ') + '] ' + it.kindLabel + '《' + it.title + '》  '
                + it.progressText + (it.topicTitle ? '  #' + it.topicTitle : ''));
        });
        lines.push('');
    }
    return ok(lines.join('\n'));
}

// 导出 JSON 备份（换手机 / 清缓存前用，可再导入还原）
// version 7：在 v6（胶囊 / 工作任务与感想 / 收支 / 学习流水与学习库）之上，
// 补上周月复盘、奖励里程碑、模块开关、模板、开始日 —— 换机后这些不必重设。
const BACKUP_VERSION = 7;
const BACKUP_MIN_FULL = 6; // 低于这个版本号：只导入能识别的部分，页面提示「旧版备份」

// 复盘按「周期_键」存成独立小键，导出时扫一遍前缀收集，不需要额外索引
function readReviewMap() {
    const out = {};
    try {
        const info = wx.getStorageInfoSync();
        (info.keys || []).forEach(function (k) {
            if (k.indexOf(REVIEW_PREFIX) !== 0) return;
            const v = wx.getStorageSync(k);
            if (!Array.isArray(v)) return;
            const answers = [];
            for (let i = 0; i < 3; i += 1) answers.push(String(v[i] || '').slice(0, 500));
            out[k.slice(REVIEW_PREFIX.length)] = answers;
        });
    } catch (e) {}
    return out;
}

// 读裸配置：没设置过（undefined / 空串）返回 null，与「用户设成了空」区分开
function readConfigRaw(key) {
    try {
        const v = wx.getStorageSync(key);
        return (v === undefined || v === null || v === '') ? null : v;
    } catch (e) {
        return null;
    }
}

function hasLocalKey(key) {
    const v = readConfigRaw(key);
    return !(v === null);
}

function exportBackup() {
    const result = all();
    if (result.error) return result;
    return ok(JSON.stringify({
        app: 'jiuge-notes',
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        records: result.data,
        capsules: readCapsules(),
        studyLibrary: readStudyLibrary(),
        // ---- v7 新增，缺一项换机后就少一样设置 ----
        reviews: readReviewMap(),
        milestones: readConfigRaw(MILESTONE_KEY),
        modules: readConfigRaw(MODULES_KEY),
        template: getTemplateId(),
        startedAt: readConfigRaw(STARTED_KEY),
    }));
}

// 导入备份：只补写本机不存在的日期与胶囊，绝不覆盖已有数据
// 返回结构保持向后兼容：imported / skipped / capsulesImported / studyImported 原样保留，
// 只新增 partial / sourceVersion / configImported 等字段供页面提示用。
function importBackup(text) {
    let parsed;
    try { parsed = JSON.parse(String(text || '')); }
    catch (e) { return fail('INVALID_JSON'); }
    const records = parsed && parsed.records;
    if (!records || !Array.isArray(records)) return fail('INVALID_FORMAT');

    // 旧档没有版本号、或版本低于 6：字段不全，只能导入能识别的部分
    const hasVersion = parsed && typeof parsed.version === 'number' && isFinite(parsed.version);
    const sourceVersion = hasVersion ? Math.floor(parsed.version) : 0;
    const partial = !hasVersion || sourceVersion < BACKUP_MIN_FULL;

    // ---- 配置类（v7）：本机没有值才写，与「导入只补不改」同一口径 ----
    // 必须放在写日记之前：save() 会把开始日补成「第一篇写进去的日期」，
    // 先写日记再还原开始日就晚了，启程天数会凭空少几天。
    let configImported = 0;
    if (typeof parsed.startedAt === 'string' && DATE_KEY_RE.test(parsed.startedAt)
        && !hasLocalKey(STARTED_KEY)) {
        try { wx.setStorageSync(STARTED_KEY, parsed.startedAt); configImported += 1; } catch (e) {}
    }
    if (typeof parsed.template === 'string' && !hasLocalKey(TEMPLATE_KEY)) {
        let valid = false;
        TEMPLATES.forEach(function (t) { if (t.id === parsed.template) valid = true; });
        if (valid) {
            try { wx.setStorageSync(TEMPLATE_KEY, parsed.template); configImported += 1; } catch (e) {}
        }
    }
    if (parsed.modules && typeof parsed.modules === 'object' && !hasLocalKey(MODULES_KEY)) {
        const nextMods = defaultModules();
        MODULE_DEFS.forEach(function (m) {
            if (parsed.modules[m.id] === false) nextMods[m.id] = false;
        });
        try { wx.setStorageSync(MODULES_KEY, nextMods); configImported += 1; } catch (e) {}
    }
    // 里程碑：本机没自定义过（readMilestones() 为 null，界面在用默认值）才还原
    if (parsed.milestones && typeof parsed.milestones === 'object'
        && Array.isArray(parsed.milestones.items) && readMilestones() === null) {
        try {
            wx.setStorageSync(MILESTONE_KEY, { items: sanitizeMilestones(parsed.milestones.items) });
            configImported += 1;
        } catch (e) {}
    }
    if (parsed.reviews && typeof parsed.reviews === 'object') {
        Object.keys(parsed.reviews).forEach(function (k) {
            // 只认自己的两个周期键：week_YYYY-MM-DD / month_YYYY-MM
            if (!/^(week_\d{4}-\d{2}-\d{2}|month_\d{4}-\d{2})$/.test(k)) return;
            const v = parsed.reviews[k];
            if (!Array.isArray(v)) return;
            if (hasLocalKey(REVIEW_PREFIX + k)) return;
            const answers = [];
            for (let i = 0; i < 3; i += 1) answers.push(String(v[i] || '').slice(0, 500));
            try { wx.setStorageSync(REVIEW_PREFIX + k, answers); configImported += 1; } catch (e) {}
        });
    }

    // 配置里含「开始日」，它进过 stats() 的缓存：改完立刻置脏，否则启程天数要等下次重启才更新
    if (configImported) invalidateMemo();

    let imported = 0;
    let skipped = 0;
    let emptyShell = 0;
    records.forEach(function (raw) {
        if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) { skipped += 1; return; }
        const local = read(raw.date);
        // 本机已有这一天：写了正文就保留本机（绝不覆盖用户当前数据）；
        // 但「只是点开过、一个字没写」的空壳记录不该挡住换机恢复。
        if (local && hasContent(local)) { skipped += 1; return; }
        const rec = emptyRecord(raw.date);
        const base = raw.base || {};
        Object.keys(rec.base).forEach(function (k) {
            if (typeof base[k] === 'string') rec.base[k] = base[k].slice(0, 200);
        });
        const cells = raw.cells || {};
        Object.keys(rec.cells).forEach(function (k) {
            if (typeof cells[k] === 'string') rec.cells[k] = cells[k].slice(0, 2000);
        });
        rec.template = templateById(raw.template).id;
        rec.updatedAt = Number(raw.updatedAt) || Date.now();
        rec.workBoard = workBoard.normalize(raw.workBoard);
        rec.moneyBook = moneyBook.normalize(raw.moneyBook);
        rec.studyLog = studyLog.normalize(raw.studyLog);
        if (write(rec) !== true) { skipped += 1; return; }
        // 写成功 ≠ 这一天真有内容：备份里也可能有「只点开过」的空壳，
        // 按落盘结果回读一遍再用 hasContent 复核，imported 必须是真实正文篇数。
        if (hasContent(read(raw.date))) imported += 1;
        else { emptyShell += 1; skipped += 1; }
    });

    // 学习库按 id 合并：只补本机没有的条目与主题，不覆盖已有进展
    let studyImported = 0;
    if (parsed.studyLibrary) {
        const incomingLib = studyLog.normalizeLibrary(parsed.studyLibrary);
        const currentLib = readStudyLibrary();
        const seenItems = {};
        const seenTopics = {};
        currentLib.items.forEach(function (x) { seenItems[x.id] = true; });
        currentLib.topics.forEach(function (x) { seenTopics[x.id] = true; });
        incomingLib.topics.forEach(function (t) {
            if (seenTopics[t.id]) return;
            currentLib.topics.push(t);
            seenTopics[t.id] = true;
            studyImported += 1;
        });
        incomingLib.items.forEach(function (it) {
            if (seenItems[it.id]) return;
            if (it.topicId && !seenTopics[it.topicId]) it.topicId = '';
            currentLib.items.push(it);
            seenItems[it.id] = true;
            studyImported += 1;
        });
        if (studyImported) writeStudyLibrary(currentLib);
    }

    let capsulesImported = 0;
    const existing = readCapsules();
    const seen = {};
    existing.forEach(function (x) { seen[x.id] = true; });
    const incoming = (parsed.capsules && Array.isArray(parsed.capsules)) ? parsed.capsules : [];
    incoming.forEach(function (raw) {
        if (!raw || typeof raw.id !== 'string' || seen[raw.id]) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.openAt || '')) return;
        existing.push({
            id: raw.id,
            text: String(raw.text || '').slice(0, 500),
            openAt: raw.openAt,
            writtenAt: String(raw.writtenAt || ''),
            createdAt: Number(raw.createdAt) || Date.now(),
            opened: !!raw.opened,
            openedAt: Number(raw.openedAt) || 0,
        });
        seen[raw.id] = true;
        capsulesImported += 1;
    });
    if (capsulesImported) writeCapsules(existing);

    return ok({
        imported: imported,
        skipped: skipped,
        capsulesImported: capsulesImported,
        studyImported: studyImported,
        // 新增字段（不改动上面的老字段，老页面照旧能取到自己要的）
        partial: partial,
        sourceVersion: sourceVersion,
        configImported: configImported,
        emptyShell: emptyShell,
    });
}


// ---------- 学习模块：学习库单键读写 ----------
// 只用一个键存全库，避免按天堆积；条目 / 主题 / 进度都由 study-log 纯函数清洗。
function readStudyLibrary() {
    try {
        return studyLog.normalizeLibrary(wx.getStorageSync(STUDY_LIBRARY_KEY));
    } catch (e) {
        return studyLog.emptyLibrary();
    }
}

let lastStudySaveOk = true;

function writeStudyLibrary(lib) {
    const next = studyLog.normalizeLibrary(lib);
    try {
        wx.setStorageSync(STUDY_LIBRARY_KEY, next);
        lastStudySaveOk = true;
    } catch (e) {
        // 学习库是单键全量对象，写失败若静默吞掉，用户刚加的条目会凭空消失
        lastStudySaveOk = false;
    }
    return next;
}

// 页面侧唯一写入口：保存后立刻回读，保证拿到的是清洗后的、真实落盘的库
function saveStudyLibrary(lib) {
    writeStudyLibrary(lib);
    return readStudyLibrary();
}

// 供页面在保存后判断是否真的写进了本机
function studySaveOk() {
    return lastStudySaveOk;
}

// 周期汇总：回看页「学习进展」卡片
function studySummary(period) {
    const result = all();
    if (result.error) return result;
    return ok(studyLog.summarize(result.data, readStudyLibrary(), period, today()));
}

// 全量汇总：九宫格「学习成长」格内的「学习汇总 ›」浮层
function studyLibraryText() {
    return ok(studyLog.libraryText(readStudyLibrary()));
}

// ---------- 工作模块汇总 ----------
// 把多天的工作感想按日期聚合成一份可回看、可复制的「工作感想」；
// 纯离线统计，不改动原始记录，也不做语义分析。
function workSummary() {
    const result = all();
    if (result.error) return result;
    return ok(workBoard.summarize(result.data, today()));
}

// 回看页「概览 · 工作」用：按周期统计任务完成情况、标签分类与感想摘录。
// 工作格既有格子里的自由书写，也有 workBoard 里的任务与感想，这里只取结构化那段；
// 格子文本的统计仍由 moduleDigest 负责，两边口径互不干扰。
function workDigest(period, tagFilter) {
    const result = all();
    if (result.error) return result;
    return ok(workBoard.digest(result.data, period, today(), tagFilter));
}

// 首页工作面板的常用标签：全部历史里用得最多的几个，纯读不写
function workTagPool(limit) {
    const result = all();
    if (result.error) return result;
    return ok(workBoard.tagPool(result.data, limit));
}

// ---------- 金钱模块汇总 ----------
// 按周 / 月 / 年汇总九宫格金钱格记下的收支，供「回看」页呈现；
// 纯离线统计，不改动原始记录，也不作消费评价。
function moneySummary(period) {
    const result = all();
    if (result.error) return result;
    return ok(moneyBook.summarize(result.data, period, today()));
}

// ---------- 九格模块汇总 ----------
// 回看页「概览」用：按周 / 月 / 年统计九格各自被写到的天数、字数与最近一句。
// 工作 / 金钱 / 学习三格存的是结构化数据，按各自 hasContent 的口径判定；
// 其余六格按格子文本判定。九格的 key 跨模板固定，标签统一取标准栏目名，
// 这样换过模板的历史日记也能并到同一行里统计。
const DIGEST_PERIOD_WORD = { week: '本周', month: '本月', year: '本年' };

// 单格内容抽取：统一成 {text, chars, count}
// 工作 / 金钱 / 学习这三格既有格子里的自由书写，也有各自的结构化数据，
// 两边都算内容——只写了一句感想而没建任务，也是写过这一格。
function digestCell(rec, key) {
    const cellText = String((rec.cells || {})[key] || '').trim();
    if (key === 'work') {
        const board = workBoard.normalize(rec.workBoard);
        const taskText = board.tasks.map(function (t) { return t.text; }).join('、');
        const parts = [cellText, board.reflection, taskText].filter(function (s) { return !!s; });
        if (!parts.length) return null;
        return {
            text: parts.join(' · '),
            chars: cellText.length + board.reflection.length + taskText.length,
            count: board.tasks.filter(function (t) { return t.done; }).length,
        };
    }
    if (key === 'money') {
        const book = moneyBook.normalize(rec.moneyBook);
        const entryText = book.entries.map(function (e) {
            const amount = moneyBook.signedText(e.type === 'income' ? e.cents : -e.cents);
            return (e.note || moneyBook.categoryLabel(e.category)) + ' ' + amount;
        }).join('、');
        const parts = [cellText, entryText].filter(function (s) { return !!s; });
        if (!parts.length) return null;
        return {
            text: parts.join(' · '),
            chars: cellText.length + entryText.length,
            count: book.entries.length,
        };
    }
    if (key === 'growth') {
        const log = studyLog.normalize(rec.studyLog);
        const entryText = log.entries.map(function (e) {
            return e.title + ' ' + studyLog.actionLabel(e.action);
        }).join('、');
        const note = String(log.note || '').trim();
        const parts = [cellText, entryText, note].filter(function (s) { return !!s; });
        if (!parts.length) return null;
        return {
            text: parts.join(' · '),
            chars: cellText.length + entryText.length + note.length,
            count: log.entries.length,
        };
    }
    if (!cellText) return null;
    return { text: cellText, chars: cellText.length, count: 0 };
}

function moduleDigest(period) {
    const result = all();
    if (result.error) return result;

    const p = period === 'month' || period === 'year' ? period : 'week';
    const now = new Date();
    let start;
    if (p === 'week') start = weekStartDate();
    else if (p === 'month') start = new Date(now.getFullYear(), now.getMonth(), 1);
    else start = new Date(now.getFullYear(), 0, 1);

    const fromKey = formatDate(start);
    const toKey = today();
    const span = dayNumber(toKey) - dayNumber(fromKey);
    const totalDays = span >= 0 ? span + 1 : 1;

    const acc = {};
    GRID_KEYS.forEach(function (k) {
        acc[k] = { key: k, label: labelOf(k), days: 0, chars: 0, count: 0, last: '', lastDate: '' };
    });

    let writtenDays = 0;
    let chars = 0;

    result.data.forEach(function (rec) {
        if (!rec || rec.date < fromKey || rec.date > toKey) return;
        if (!hasContent(rec)) return;
        writtenDays += 1;
        GRID_KEYS.forEach(function (k) {
            const hit = digestCell(rec, k);
            if (!hit) return;
            const a = acc[k];
            a.days += 1;
            a.chars += hit.chars;
            a.count += hit.count;
            chars += hit.chars;
            // 同一天只取一次；日期更大的覆盖，得到「最近一句」
            if (rec.date >= a.lastDate) {
                a.lastDate = rec.date;
                a.last = hit.text.length > 46 ? hit.text.slice(0, 46) + '…' : hit.text;
            }
        });
    });

    const rows = GRID_KEYS.map(function (k) {
        const a = acc[k];
        let meta = a.days + ' 天';
        if (k === 'work') meta += ' · 完成 ' + a.count + ' 项';
        else if (k === 'money') meta += ' · ' + a.count + ' 笔';
        else if (k === 'growth') meta += ' · ' + a.count + ' 条';
        else if (a.chars) meta += ' · ' + a.chars + ' 字';
        return {
            key: a.key,
            label: a.label,
            days: a.days,
            chars: a.chars,
            count: a.count,
            pct: Math.min(100, Math.round(a.days * 100 / totalDays)),
            last: a.last,
            lastDate: a.lastDate,
            metaText: meta,
        };
    });

    // 排序只用于生成一句话结论，rows 本身保持九格原始顺序，方便对位查找
    const word = DIGEST_PERIOD_WORD[p];
    const used = rows.filter(function (r) { return r.days > 0; })
        .sort(function (a, b) { return b.days - a.days; });
    const idle = rows.filter(function (r) { return r.days === 0; });
    let insight;
    if (!writtenDays) {
        insight = word + '还没有记录，先在「今日」写一行。';
    } else {
        insight = word + '写了 ' + writtenDays + ' 天、' + chars + ' 字';
        if (used.length) insight += '，「' + used[0].label + '」写得最多（' + used[0].days + ' 天）';
        if (idle.length && idle.length < rows.length) {
            insight += '；' + idle.slice(0, 2).map(function (r) { return r.label; }).join('、') + ' 还空着';
        }
        insight += '。';
    }

    return ok({
        period: p,
        periodWord: word,
        start: fromKey,
        end: toKey,
        totalDays: totalDays,
        writtenDays: writtenDays,
        chars: chars,
        rows: rows,
        insight: insight,
        note: '按每格「有内容」的日期计数，同一天同一格只算一次。',
    });
}


module.exports = {
    PREFIX: PREFIX,
    STARTED_KEY: STARTED_KEY,
    WEEK_GOAL: WEEK_GOAL,
    BASE_FIELDS: BASE_FIELDS,
    GRID_FIELDS: TEMPLATES[0].fields,
    GRID_KEYS: GRID_KEYS,
    PROMPTS: PROMPTS,
    TEMPLATES: TEMPLATES,
    REVIEW_PROMPTS: REVIEW_PROMPTS,
    today: today,
    formatDate: formatDate,
    emptyRecord: emptyRecord,
    hasContent: hasContent,
    load: load,
    save: save,
    listDates: listDates,
    all: all,
    writtenDates: writtenDates,
    stats: stats,
    milestones: milestones,
    milestoneView: milestoneView,
    saveMilestones: saveMilestones,
    resetMilestones: resetMilestones,
    getTemplateId: getTemplateId,
    activeTemplate: activeTemplate,
    activeGridFields: activeGridFields,
    fieldsFor: fieldsFor,
    setTemplate: setTemplate,
    firstWeekEnabled: firstWeekEnabled,
    setFirstWeekEnabled: setFirstWeekEnabled,
    MODULE_DEFS: MODULE_DEFS,
    modules: modules,
    setModule: setModule,
    firstWeekState: firstWeekState,
    promptFor: promptFor,
    previousToday: previousToday,
    sameDayAcrossYears: sameDayAcrossYears,
    search: search,
    weeklyReview: weeklyReview,
    frequentPhrases: frequentPhrases,
    moodTrend: moodTrend,
    reviewPeriodKey: reviewPeriodKey,
    reviewPrompts: reviewPrompts,
    loadReview: loadReview,
    saveReview: saveReview,
    yearPixels: yearPixels,
    randomEntry: randomEntry,
    exportText: exportText,
    exportBackup: exportBackup,
    capsulePresets: capsulePresets,
    saveCapsule: saveCapsule,
    listCapsules: listCapsules,
    dueCapsules: dueCapsules,
    openCapsule: openCapsule,
    capsuleGroups: capsuleGroups,
    prettyDate: prettyDate,
    exportMarkdown: exportMarkdown,
    importBackup: importBackup,
    workSummary: workSummary,
    workDigest: workDigest,
    workTagPool: workTagPool,
    moneySummary: moneySummary,
    moduleDigest: moduleDigest,
    readStudyLibrary: readStudyLibrary,
    saveStudyLibrary: saveStudyLibrary,
    studySaveOk: studySaveOk,
    studySummary: studySummary,
    studyLibraryText: studyLibraryText,
};
