const store = require('../../utils/diary-store.js');
const quoteBank = require('../../utils/quotes.js');
const greetings = require('../../utils/greetings.js');
const insights = require('../../utils/cell-insights.js');
const workBoard = require('../../utils/work-board.js');
const moneyBook = require('../../utils/money-book.js');
const studyLog = require('../../utils/study-log.js');
const theme = require('../../utils/theme.js');

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// UI 状态键必须避开数据层 PREFIX('morning_diary_')：
// listDates() 会把该前缀的所有键当作日记读取，非日记对象会让回看逻辑崩溃。
const QUOTE_TODAY_KEY = 'md_quote_today';
const LEGACY_QUOTE_KEY = 'morning_diary_quote_today';
const BASE_INTAKE_KEY = 'md_base_intake';
// 运动小人：八段锦八式连续演练，每 6 秒推进一式、48 秒演完一整套。
// 起始式由「日期 + 小时」稳定散列决定；21 点至次日 5 点固定收势，不演练。
const BADUANJIN = ['tuotian', 'kaigong', 'danjv', 'houqiao', 'yaotou', 'panzu', 'zanquan', 'qidian'];
const FORM_SECONDS = 6;

function motionFor(date) {
    const h = date.getHours();
    if (h >= 21 || h < 5) return 'calm';
    const seed = date.getFullYear() + date.getMonth() * 7 + date.getDate() * 3 + h * 5;
    const start = ((seed % BADUANJIN.length) + BADUANJIN.length) % BADUANJIN.length;
    const step = Math.floor((date.getMinutes() * 60 + date.getSeconds()) / FORM_SECONDS);
    return BADUANJIN[(start + step) % BADUANJIN.length];
}


// 「换一句」功能已下线，旧 offset 键只清理、不再迁移值
const DEPRECATED_GREETING_KEYS = ['morning_diary_greeting_offset', 'md_greeting_offset'];

// 今日状态：由差到高的滑动刻度。心情 5 档与数据层 MOOD_LEVEL 完全一致，
// 保证像素年历着色与近 30 天心情趋势不受改造影响。
const SLIDER_DEFS = {
    weather: {
        title: '今天的天气',
        hint: '从左往右，由糟到好，凭感觉滑一下',
        steps: ['大雨', '雪', '小雨', '雾', '阴', '风', '多云', '晴'],
    },
    body: {
        title: '身体状态',
        hint: '从左往右，身体越来越舒服',
        steps: ['不适', '疲惫', '一般', '不错', '很好'],
    },
    mood: {
        title: '此刻心情',
        hint: '从左往右，心情越来越好',
        steps: ['烦躁', '低落', '一般', '平静', '愉悦'],
    },
};

// 今日状态滑杆的 5 段色阶不在这里了：色值进 WXSS 令牌（--c-scale-1..5），
// 这里只留"第几档"。原来 5 个色值被直接当文字色用，白底只有 1.6–2.1:1，
// 四套主题下都不达标；现在文字色走 ink 令牌、色阶只做圆点描边与轨道填充。
function levelAt(ratio) {
    const r = Math.max(0, Math.min(1, ratio));
    return Math.round(r * 4) + 1;
}

function pctAt(index, total) {
    return total <= 1 ? 0 : Math.round(index * 1000 / (total - 1)) / 10;
}

// 与 diary-store.hasContent 同一判据：只认字符串。
// 历史脏数据（或手工改过的备份）里格子可能是对象，String() 会得到 "[object Object]"，
// 一路渲染到界面上就是「[object Object]」。非字符串一律当空串。
function asText(v) {
    return typeof v === 'string' ? v : '';
}

// 首次可发现性用的一次性标记：storage 不可用时当作"已经看过"，不要为了一个提示把页面打挂
function skinTipInitial() {
    try {
        return !wx.getStorageSync('skin_tip_seen');
    } catch (e) {
        return false;
    }
}

function buildBaseRows(base) {
    return ['weather', 'body', 'mood'].map(function (f) {
        const def = SLIDER_DEFS[f];
        const value = asText((base || {})[f]);
        const idx = def.steps.indexOf(value);
        const ratio = idx < 0 ? 0.5 : idx / (def.steps.length - 1);
        return {
            field: f,
            label: f === 'weather' ? '天气' : (f === 'body' ? '身体' : '心情'),
            value: value,
            display: value || '滑动选择',
            empty: !value,
            pct: pctAt(idx < 0 ? Math.floor((def.steps.length - 1) / 2) : idx, def.steps.length),
            lv: levelAt(ratio),
        };
    });
}

function excerptOf(rec) {
    const fields = store.fieldsFor(rec.template);
    for (let i = 0; i < fields.length; i += 1) {
        const t = asText((rec.cells || {})[fields[i].key]).trim();
        if (t) return t.length > 42 ? t.slice(0, 42) + '…' : t;
    }
    return '';
}

function isValidDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function summaryOf(base) {
    const b = base || {};
    const parts = [b.weather, b.body, b.mood].filter(function (v) {
        return !!asText(v).trim();
    });
    return parts.length ? parts.join(' · ') : '还没记录';
}

// 收集浮层的三行：已填的项显示原值，未填的项停在中间档但不算「已选」
// 刻度表外的非空值（手改备份 / 旧版数据）也按「已选」显示并原样保留：
// 保存时 base[r.field] = r.selected ? r.value : ''，认成未选就等于把用户的值清空了。
function buildIntakeRows(base) {
    const b = base || {};
    return ['weather', 'body', 'mood'].map(function (f) {
        const def = SLIDER_DEFS[f];
        const n = def.steps.length;
        // 与 buildBaseRows 同一判据：非字符串一律当空，避免「[object Object]」被当成有效值
        const cur = asText(b[f]);
        const known = def.steps.indexOf(cur);
        const foreign = known < 0 && !!cur;
        const selected = known >= 0 || foreign;
        const idx = known >= 0 ? known : Math.floor((n - 1) / 2);
        return {
            field: f,
            label: f === 'weather' ? '天气' : (f === 'body' ? '身体' : '心情'),
            value: known >= 0 ? def.steps[idx] : cur,
            selected: selected,
            // 原值不在刻度表上：滑一下才换成刻度内的值，用户点「清除」才清
            foreign: foreign,
            index: idx,
            count: n,
            pct: pctAt(idx, n),
            // 0 = 未选（圆点与轨道走装饰档），1–5 = 由差到好
            lv: known >= 0 ? levelAt(idx / (n - 1)) : 0,
        };
    });
}


// 「工作感想汇总」浮层只推 wxml 真正引用的字段：
// 顶层 items 与 months 内容完全重复，text 是给「复制」用的全文（不进视图层），
// 三样一起塞 setData，365 天就要推五百多 KB，小程序单次 setData 有体积上限。
function buildWorkSummaryPayload(d) {
    return {
        empty: !!d.empty,
        count: d.count,
        chars: d.chars,
        taskDone: d.taskDone,
        taskTotal: d.taskTotal,
        insight: d.insight,
        note: d.note,
        months: (d.months || []).map(function (m) {
            return {
                key: m.key,
                label: m.label,
                items: (m.items || []).map(function (x) {
                    return {
                        date: x.date,
                        dateLabel: x.dateLabel,
                        text: x.text,
                        hasTasks: x.hasTasks,
                        taskDone: x.taskDone,
                        taskTotal: x.taskTotal,
                        tasks: (x.tasks || []).map(function (t) {
                            return { id: t.id, text: t.text, done: t.done };
                        }),
                    };
                }),
            };
        }),
    };
}

Page({
    data: {
        /* 皮肤：根 view 的 class 用它拼 theme-{{theme}}，值域只有 standard|tech|girl|kids。
           onLoad 里会覆盖成 storage 里的真实值，这里先放标准版让首帧有兜底。
           换肤入口已独立成「设置」页，本页只负责跟随（applyTheme）。 */
        theme: 'standard',
        skinTip: skinTipInitial(),
        dateKey: '',
        dateLabel: '',
        weekLabel: '',
        dayOfYear: 0,
        greeting: { tag: '', text: '', hint: '', scope: '' },
        motion: 'tuotian',
        dailyQuote: { text: '', author: '', index: 0, long: false },
        quoteTotal: quoteBank.size,
        streak: 0,
        weekCount: 0,
        weekTotal: 0,
        isBackfill: false,
        backfillLabel: '',
        base: { weather: '', anniversary: '', body: '', mood: '' },
        baseRows: [],
        intakeOpen: false,
        intakeRows: [],
        intakeAnniversary: '',
        intakeSummary: '还没记录',
        intakeDone: false,
        gridCells: [],
        filledCount: 0,
        clockText: '--:--',
        clockPeriod: '',
        editing: false,
        editKey: '',
        editLabel: '',
        editHint: '',
        editPrompt: '',
        editValue: '',
        // editPanel 决定该格是否展开模块面板；关掉模块后它就是普通写字格
        editPanel: '',
        editPlain: true,
        // 功能模块开关的当前值（开关本体在「设置」页，本页只读它决定九格形态）
        firstWeek: { active: false, dayNo: 1, celebration: '', enabled: true },
        previous: null,
        templateName: '',
        templateNote: '',
        // 胶囊已独立成栏：今日页只做「有待拆的信」的导流提醒
        capsuleDueCount: 0,
        // 单格历史内容分析
        insightOpen: false,
        insightTitle: '',
        insightAxis: '',
        insight: null,
        // 工作模块：任务框 + 当日感想 + 跨日汇总
        workLabel: '工作',
        workDateHint: '今天',
        workInput: '',
        workTasks: [],
        workReflection: '',
        // 常用标签：全部历史里用得最多的几个，点一下追加到输入框
        workTagChips: [],
        workDoneCount: 0,
        workTotal: 0,
        workPct: 0,
        workSummaryOpen: false,
        workSummaryData: null,
        // 金钱模块：收支登记态（挂在当天日记 moneyBook，汇总交给「回看」页）
        moneyType: 'expense',
        moneyAmount: '',
        moneyNote: '',
        moneyCategory: 'food',
        moneyCategories: moneyBook.categoriesOf('expense'),
        moneyEntries: [],
        moneyCount: 0,
        moneyIncomeText: '¥0.00',
        moneyExpenseText: '¥0.00',
        moneyBalanceText: '¥0.00',
        // 学习模块：库在单键，当天流水随日记保存；书 / 影 / 画 / 课 + 主题
        studyTab: 'items',
        studyKindFilter: '',
        studyTopicFilter: '',
        studyKinds: studyLog.kindsOf(),
        studyItems: [],
        studyTopics: [],
        studyTopicOptions: [{ id: '', title: '不归属主题' }],
        studyKindCounts: {},
        studyOverall: { total: 0, finished: 0, doing: 0, avgPct: 0 },
        studyTitle: '',
        studyTotal: '',
        studyNewKind: 'book',
        studyNewTopicId: '',
        studyTopicTitle: '',
        studyDayLogs: [],
        studyDayCount: 0,
        studyDaySteps: 0,
        studyDayNote: '',
        studySummaryOpen: false,
        studySummaryData: null,
    },

    // 旧版本把 UI 状态写进了 morning_diary_ 命名空间，这里一次性搬走并清干净
    migrateLegacyKeys() {
        try {
            const oldQuote = wx.getStorageSync(LEGACY_QUOTE_KEY);
            if (oldQuote) {
                if (!wx.getStorageSync(QUOTE_TODAY_KEY)) wx.setStorageSync(QUOTE_TODAY_KEY, oldQuote);
                wx.removeStorageSync(LEGACY_QUOTE_KEY);
            }
            // 「换一句」下线后，两代 offset 键都不再有意义，直接清掉
            DEPRECATED_GREETING_KEYS.forEach(function (k) { wx.removeStorageSync(k); });
            // 「给明天留半句」已下线，清掉老用户残留的接龙草稿
            wx.removeStorageSync('morning_handoff');
        } catch (e) {}
    },

    onLoad(options) {
        // onLoad 早于首帧渲染，这里的 setData 会合并进第一帧 —— 「不闪」的最佳时机。
        // force = true：冷启动的首个页面必须把原生层刷一遍（app.json 的静态值可能已经生效）。
        const themeId = theme.getThemeId();
        this.setData({ theme: themeId });
        theme.applySystemChrome(themeId, true);

        this.migrateLegacyKeys();
        this._cells = {};
        this._workBoard = workBoard.empty();
        this._moneyBook = moneyBook.empty();
        this._studyLibrary = store.readStudyLibrary();
        this._studyLog = studyLog.empty();
        const modRes = store.modules();
        this._modules = modRes.error ? { work: true, money: true, growth: true } : modRes.data;
        this._promptOffsets = {};
        this._recordTemplate = store.getTemplateId();
        const fromOpt = options && options.date;
        if (fromOpt && isValidDate(fromOpt) && fromOpt <= store.today()) {
            this.applyDate(fromOpt);
        } else {
            this.applyDate(store.today());
        }
    },

    onShow() {
        // 兜底：可能刚在「设置」页被换过肤（换肤时是主动广播，这里管"被切回来"的情况）。
        // 第二参数是「有待补刷」标记：设置页不是 tabBar 页，那里的 setTabBar* 不一定真生效，
        // 回到本页时强制重刷一次原生层，用完即清。
        this.applyTheme(null, theme.takePendingTabChrome());
        // 设置页里改过功能模块：页面栈里本页不会重建，必须在这里重读 storage。
        // 开关只有一份真源（md_modules），页内 _modules 只是渲染用的镜像，不重读就会一直显示旧形态。
        const modRes = store.modules();
        this._modules = modRes.error ? { work: true, money: true, growth: true } : modRes.data;
        // tabBar 页不能带参跳转：回看页写入 globalData.backfillDate，这里消费一次
        try {
            const app = getApp();
            if (app && app.globalData && app.globalData.backfillDate) {
                const d = app.globalData.backfillDate;
                app.globalData.backfillDate = '';
                if (isValidDate(d) && d <= store.today()) this.applyDate(d);
            }
        } catch (e) {}
        // 跨天回到前台：与定时器走同一个出口，浮层开着时只挂起、不静默切走日期
        this.switchDateIfNeeded();
        this.refreshGreeting(this._greetingAnniversary || '');
        this.refresh();
        this.startTimer();
    },

    onHide() {
        this.stopTimer();
        // 切 tab 前把还没失焦的感想与今日一句落盘，避免输入丢失
        this.syncWorkReflection();
        this.syncStudyNote();
    },

    onUnload() {
        this.stopTimer();
    },

    applyDate(key) {
        const p = key.split('-');
        const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
        const isBf = key !== store.today();
        // 当天手动换过的名言优先；否则按日期散列取「每日名言」
        const picked = this.pickedQuoteIndex(key);
        const qIndex = picked >= 0 ? picked : quoteBank.dailyIndex(key);
        this._promptOffsets = {};
        this.setData({
            dateKey: key,
            dateLabel: (d.getMonth() + 1) + '月' + d.getDate() + '日',
            weekLabel: WEEK[d.getDay()],
            dayOfYear: dayOfYear,
            dailyQuote: quoteBank.pick(qIndex),
            isBackfill: isBf,
            backfillLabel: Number(p[0]) + '年' + Number(p[1]) + '月' + Number(p[2]) + '日',
            workInput: '',
            workSummaryOpen: false,
            moneyAmount: '',
            moneyNote: '',
            moneyType: 'expense',
            moneyCategory: 'food',
            moneyCategories: moneyBook.categoriesOf('expense'),
            studyTitle: '',
            studyTotal: '',
            studyTopicTitle: '',
            studyNewTopicId: '',
            studyTab: 'items',
        });
        // 问候语按「此刻」生成：补记历史日记时仍然问候今天
        this._greetingAnniversary = '';
        this.refreshGreeting();
    },

    // 问候语：按当前日期 + 时段稳定取一组；同一时段内不因刷新而跳变
    // 界面不再显示 tag（与上方抬头重复），也不提供「换一句」入口
    refreshGreeting(anniversary) {
        const ann = String(anniversary === undefined ? (this._greetingAnniversary || '') : anniversary).trim();
        this._greetingAnniversary = ann;
        const g = greetings.compose({ anniversary: ann });
        this._greetingScope = g.scope;
        this.setData({ greeting: g, motion: motionFor(new Date()) });
    },

    // 只用一个 storage 键记住「当天换过的名言」，避免按天堆积 key（数据层已有性能负担）
    pickedQuoteIndex(key) {
        try {
            const v = wx.getStorageSync(QUOTE_TODAY_KEY);
            if (!v || v.date !== key) return -1;
            const n = Number(v.index);
            return isFinite(n) && n >= 0 && n < quoteBank.size ? Math.floor(n) : -1;
        } catch (e) {
            return -1;
        }
    },

    onNextQuote() {
        const cur = this.data.dailyQuote ? this.data.dailyQuote.index : -1;
        const idx = quoteBank.randomIndex(cur);
        this.setData({ dailyQuote: quoteBank.pick(idx) });
        try {
            wx.setStorageSync(QUOTE_TODAY_KEY, { date: this.data.dateKey, index: idx });
        } catch (e) {}
    },

    onBackToToday() {
        this.applyDate(store.today());
        this.refresh();
    },

    // 跨天切日期的唯一出口：定时器与 onShow 都必须走这里，避免一处有保护、一处没有。
    // 补记历史日期时不动（用户是故意在看过往）；浮层开着（写字 / 今日状态）时
    // 只把新日期记账到 _pendingDateKey，不切日期也不清输入框，等浮层关闭后由
    // flushPendingDate() 补切——否则用户正在输入的正文或记账金额会连同日期一起被清掉。
    switchDateIfNeeded() {
        if (this.data.isBackfill) return;
        const today = store.today();
        if (!this.data.dateKey || today === this.data.dateKey) return;
        if (this.data.editing || this.data.intakeOpen) {
            this._pendingDateKey = today;
            return;
        }
        this._pendingDateKey = '';
        this.applyDate(today);
        this.refresh();
    },

    // hero 右上角显示当前时间（24 小时制）：只报时间，不制造「写了多久」的压力
    startTimer() {
        this.stopTimer();
        this._clockKey = '';
        const update = () => {
            const now = new Date();
            const hh = pad2(now.getHours());
            const mm = pad2(now.getMinutes());
            const key = hh + ':' + mm;
            // 每分钟才 setData 一次，避免每秒无意义地重绘页面
            if (key !== this._clockKey) {
                this._clockKey = key;
                this.setData({
                    clockText: key,
                    clockPeriod: greetings.periodOf(now.getHours()).label,
                });
            }
            // 跨零点：页面停在昨天会继续往昨天的记录里写，必须自己切到新的一天
            this.switchDateIfNeeded();
            // 跨时段（含跨零点）自动换一组问候，不必等重新进入页面
            if (greetings.scopeKey(now) !== this._greetingScope) {
                this.refreshGreeting(this._greetingAnniversary || '');
            }
            // 八段锦每 6 秒推进一式，48 秒演完一整套
            const nextMotion = motionFor(now);
            if (nextMotion !== this.data.motion) this.setData({ motion: nextMotion });
        };
        update();
        this._timer = setInterval(update, 1000);
    },

    // 浮层关掉后补做跨天切换：写到一半被换掉，比不换更让人懵
    flushPendingDate() {
        if (!this._pendingDateKey) return;
        if (this.data.editing || this.data.intakeOpen) return;
        const pending = this._pendingDateKey;
        this._pendingDateKey = '';
        if (pending === this.data.dateKey) return;
        this.applyDate(pending);
        this.refresh();
    },

    stopTimer() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },

    refresh() {
        const result = store.load(this.data.dateKey);
        if (result.error) {
            wx.showToast({ title: '读取失败', icon: 'none' });
            return;
        }
        const rec = result.data;
        this._cells = Object.assign({}, rec.cells);
        this._workBoard = workBoard.normalize(rec.workBoard);
        this._moneyBook = moneyBook.normalize(rec.moneyBook);
        this._studyLibrary = studyLog.normalizeLibrary(store.readStudyLibrary());
        this._studyLog = studyLog.normalize(rec.studyLog);
        const wv = workBoard.view(this._workBoard);
        const mv = moneyBook.view(this._moneyBook);
        const sv = studyLog.view(this._studyLibrary, {
            kind: this.data.studyKindFilter,
            topicId: this.data.studyTopicFilter,
        });
        const sd = studyLog.viewDay(this._studyLog, this._studyLibrary);
        // 补记历史日记时保留该篇自己的模板，不被当前模板覆盖
        this._recordTemplate = rec.template || store.getTemplateId();
        const stat = store.stats();
        const s = stat.error ? {} : stat.data;
        const fw = store.firstWeekState();
        const tpl = store.activeTemplate();
        let workLabel = '工作';
        tpl.fields.forEach(function (f) { if (f.key === 'work') workLabel = f.label; });
        // 跨年回看属于锦上添花：任何异常都不能拖垮九宫格等主界面数据
        let prevRes;
        try { prevRes = store.previousToday(); }
        catch (e) { prevRes = { data: null, error: 'CLIENT_EXCEPTION' }; }
        const prev = prevRes && !prevRes.error ? prevRes.data : null;
        const intakeDone = !!this.intakeMark() ||
            !!(asText(rec.base.weather) && asText(rec.base.body) && asText(rec.base.mood));
        this.setData({
            base: rec.base,
            baseRows: buildBaseRows(rec.base),
            intakeSummary: summaryOf(rec.base),
            intakeDone: intakeDone,
            gridCells: this.buildCells(),
            filledCount: this.countFilled(),
            streak: s.streak || 0,
            weekCount: s.weekCount || 0,
            weekTotal: s.weekTotal || 0,
            firstWeek: fw.error ? { active: false, dayNo: 1, celebration: '', enabled: true } : fw.data,
            previous: prev ? { year: String(prev.date || '').slice(0, 4), excerpt: excerptOf(prev) } : null,
            templateName: tpl.name,
            templateNote: tpl.note,
            workLabel: workLabel,
            workDateHint: this.data.isBackfill ? this.data.backfillLabel : '今天',
            workTasks: wv.tasks,
            workReflection: this._workBoard.reflection,
            workDoneCount: wv.done,
            workTotal: wv.total,
            workPct: wv.pct,
            workTagChips: this.buildWorkTags(),
            moneyEntries: mv.entries,
            moneyCount: mv.count,
            moneyIncomeText: mv.incomeText,
            moneyExpenseText: mv.expenseText,
            moneyBalanceText: mv.balanceText,
            studyItems: sv.items,
            studyTopics: sv.topics,
            studyTopicOptions: sv.topicOptions,
            studyKindCounts: sv.kindCounts,
            studyOverall: sv.overall,
            studyDayLogs: sd.entries,
            studyDayCount: sd.count,
            studyDaySteps: sd.steps,
            studyDayNote: sd.note,
        });
        // 纪念日栏填了内容就加一句问候，清空后自动撤掉
        const ann = String((rec.base || {}).anniversary || '').trim();
        if (ann !== (this._greetingAnniversary || '')) this.refreshGreeting(ann);
        this.loadDueCount();
    },

    // 这一格该不该展开模块面板：模块关掉就退回普通写字格
    panelFor(key) {
        const mods = this._modules || {};
        if (mods[key] === false) return '';
        return ['work', 'money', 'growth'].indexOf(key) >= 0 ? key : '';
    },

    buildCells() {
        const self = this;
        const cells = this._cells || {};
        const mods = this._modules || {};
        const wv = workBoard.view(this._workBoard);
        const mv = moneyBook.view(this._moneyBook);
        const sv = studyLog.view(this._studyLibrary);
        return store.activeGridFields().map(function (f) {
            const text = asText(cells[f.key]);
            const trimmed = text.trim();
            const question = store.promptFor(f.key, self.data.dateKey, (self._promptOffsets || {})[f.key] || 0);
            const short = question.length > 18 ? question.slice(0, 18) + '…' : question;
            return {
                key: f.key,
                label: f.label,
                hint: f.hint,
                prompt: short,
                required: !!f.required,
                center: !!f.center,
                filled: trimmed.length > 0,
                taskStat: f.key === 'work' && mods.work !== false && wv.total ? wv.done + '/' + wv.total + ' 项' : '',
                moneyStat: f.key === 'money' && mods.money !== false && mv.count ? mv.count + ' 笔' : '',
                studyStat: f.key === 'growth' && mods.growth !== false && sv.allCount ? sv.allCount + ' 项在学' : '',
                preview: text.length > 24 ? text.slice(0, 24) + '…' : text,
            };
        });
    },

    countFilled() {
        const cells = this._cells || {};
        let n = 0;
        store.activeGridFields().forEach(function (f) {
            if (asText(cells[f.key]).trim()) n += 1;
        });
        return n;
    },

    persist() {
        const result = store.save({
            date: this.data.dateKey,
            base: this.data.base,
            cells: this._cells,
            workBoard: this._workBoard || workBoard.empty(),
            moneyBook: this._moneyBook || moneyBook.empty(),
            studyLog: this._studyLog || studyLog.empty(),
            template: this._recordTemplate || store.getTemplateId(),
            updatedAt: 0,
        });
        if (!result.error) return true;
        // 空间不足必须说清楚：只提示「保存失败」，用户会以为已经存上了，退出即丢稿
        const quota = result.error === 'QUOTA_EXCEEDED';
        wx.showToast({
            title: quota ? '本机存储已满，请先导出备份再清理旧日记' : '保存失败，请重试',
            icon: 'none',
            duration: 2500,
        });
        return false;
    },

    // 今日状态收集：单个 md_base_intake 键记住「当天已完成 / 已跳过」，
    // 绝不落到 morning_diary_ 日记命名空间，也不按天堆积 key
    intakeMark() {
        try {
            const v = wx.getStorageSync(BASE_INTAKE_KEY);
            return (v && v.date === this.data.dateKey) ? v : null;
        } catch (e) {
            return null;
        }
    },

    needsIntake() {
        if (this.data.isBackfill) return false; // 补记以往的日子不打断
        if (this.intakeMark()) return false;   // 当天已完成或跳过
        const b = this.data.base || {};
        return !(asText(b.weather) && asText(b.body) && asText(b.mood)); // 三项本来就有值也不弹
    },

    openIntake(pendingKey) {
        this._pendingCellKey = pendingKey || '';
        this._intakeTrack = null;
        this.setData({
            editing: false,
            intakeOpen: true,
            intakeRows: buildIntakeRows(this.data.base),
            intakeAnniversary: String((this.data.base || {}).anniversary || ''),
        }, () => this.measureIntakeTrack());
    },

    measureIntakeTrack() {
        const self = this;
        wx.createSelectorQuery().in(this).select('.intake-track').boundingClientRect(function (rect) {
            if (rect && rect.width > 0) {
                self._intakeTrack = { left: rect.left, width: rect.width };
            }
        }).exec();
    },

    // 选择器查询尚未回来时按 rpx 反推轨道范围，保证第一次触摸也能用
    ensureIntakeTrack() {
        if (this._intakeTrack && this._intakeTrack.width > 0) return this._intakeTrack;
        const w = wx.getSystemInfoSync().windowWidth;
        const unit = w / 750;
        const left = (32 + 32) * unit; // sheet 左右各 32rpx padding
        this._intakeTrack = { left: left, width: w - left * 2 };
        return this._intakeTrack;
    },

    onIntakeSlide(e) {
        const field = e.currentTarget.dataset.field;
        const t = this.ensureIntakeTrack();
        const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
        if (!field || !t || !t.width || !touch) return;
        const rows = this.data.intakeRows || [];
        let hit = null;
        for (let i = 0; i < rows.length; i += 1) {
            if (rows[i].field === field) hit = rows[i];
        }
        if (!hit) return;
        let ratio = (touch.clientX - t.left) / t.width;
        ratio = Math.max(0, Math.min(1, ratio));
        const idx = Math.round(ratio * (hit.count - 1));
        // foreign 行（刻度表外的原值）停在中间档：滑到中间也要真的换成刻度值，不能直接 return
        if (hit.selected && !hit.foreign && hit.index === idx) return;
        const def = SLIDER_DEFS[field];
        const next = rows.map(function (r) {
            if (r.field !== field) return r;
            return Object.assign({}, r, {
                selected: true,
                foreign: false,
                index: idx,
                value: def.steps[idx],
                pct: pctAt(idx, r.count),
                lv: levelAt(idx / (r.count - 1)),
            });
        });
        this.setData({ intakeRows: next });
    },

    onIntakeClear(e) {
        const field = e.currentTarget.dataset.field;
        const rows = (this.data.intakeRows || []).map(function (r) {
            if (r.field !== field) return r;
            const idx = Math.floor((r.count - 1) / 2);
            return Object.assign({}, r, {
                selected: false,
                index: idx,
                value: '',
                pct: pctAt(idx, r.count),
                lv: 0,
            });
        });
        this.setData({ intakeRows: rows });
    },

    onIntakeAnniversaryInput(e) {
        this.setData({ intakeAnniversary: e.detail.value });
    },

    // 点遮罩 / × 只关浮层、不写标记：下次点格子仍会收集
    closeIntake() {
        this.setData({ intakeOpen: false });
        this._pendingCellKey = '';
        this.flushPendingDate();
    },

    commitIntake(done) {
        const base = Object.assign({}, this.data.base);
        (this.data.intakeRows || []).forEach(function (r) {
            // 未选中就必须显式写空串：只写选中项的话，「点清除 → 保存」会被旧值原样带回来
            base[r.field] = r.selected ? r.value : '';
        });
        base.anniversary = String(this.data.intakeAnniversary || '').trim();
        try {
            wx.setStorageSync(BASE_INTAKE_KEY, { date: this.data.dateKey, done: !!done });
        } catch (e) {}
        this.setData({
            base: base,
            baseRows: buildBaseRows(base),
            intakeSummary: summaryOf(base),
            intakeDone: true,
            intakeOpen: false,
            gridCells: this.buildCells(),
        });
        this.persist();
        // 纪念日变了要同步刷新问候语里那句提示
        this.refreshGreeting(base.anniversary);
        const pending = this._pendingCellKey || '';
        this._pendingCellKey = '';
        if (pending) this.openCellByKey(pending);
        // 浮层已经关了：如果期间跨过零点，这里补切到新的一天（还开着格子的会跳过）
        this.flushPendingDate();
    },

    onSkipIntake() { this.commitIntake(false); },
    onSaveIntake() { this.commitIntake(true); },

    // 一行状态条：随时手动修改今日状态，但不再单独占一张卡片
    onOpenIntake() { this.openIntake(''); },

    openCellByKey(key) {
        const field = store.activeGridFields().filter(function (f) { return f.key === key; })[0];
        if (!field) return;
        const offset = (this._promptOffsets || {})[key] || 0;
        const panel = this.panelFor(key);
        this.setData({
            editing: true,
            editKey: key,
            editPanel: panel,
            editPlain: !panel,
            editLabel: field.label,
            editHint: field.hint,
            editPrompt: store.promptFor(key, this.data.dateKey, offset),
            editValue: String((this._cells || {})[key] || ''),
            insightOpen: false,
            moneyAmount: '',
            moneyNote: '',
            studyTab: key === 'growth' ? 'items' : this.data.studyTab,
            studyTitle: '',
            studyTotal: '',
            studyTopicTitle: '',
            studyNewTopicId: '',
        });
    },

    openCell(e) {
        const key = e.currentTarget.dataset.key;
        // 当天第一次写格子：先收集今日状态；完成或跳过后当天不再弹
        if (this.needsIntake()) {
            this.openIntake(key);
            return;
        }
        this.openCellByKey(key);
    },

    onRotatePrompt() {
        const key = this.data.editKey;
        if (!key) return;
        this._promptOffsets = this._promptOffsets || {};
        this._promptOffsets[key] = (this._promptOffsets[key] || 0) + 1;
        this.setData({
            editPrompt: store.promptFor(key, this.data.dateKey, this._promptOffsets[key]),
            gridCells: this.buildCells(),
        });
    },

    closeCell() {
        this.syncWorkReflection();
        this.syncStudyNote();
        this.setData({ editing: false, insightOpen: false });
        this.flushPendingDate();
    },

    onEditInput(e) {
        this.setData({ editValue: e.detail.value });
    },

    // 打开当前格的历史分析浮层（盖在编辑浮层之上，关闭后回到编辑态）
    onOpenInsight() {
        const key = this.data.editKey;
        if (!key) return;
        this.setData({
            insightOpen: true,
            insightTitle: this.data.editLabel || '这一格',
            insightAxis: insights.axisOf(key),
            insight: insights.analyze(key),
        });
    },

    closeInsight() {
        this.setData({ insightOpen: false });
    },

    clearCell() {
        this.setData({ editValue: '' });
    },

    saveCell() {
        this.syncWorkReflection();
        this.syncStudyNote();
        const key = this.data.editKey;
        if (!key) {
            this.setData({ editing: false, insightOpen: false });
            return false;
        }
        // 先在内存副本上改，落盘确认成功后才认这笔账
        const prevCells = this._cells;
        const nextCells = Object.assign({}, prevCells);
        nextCells[key] = this.data.editValue;
        this._cells = nextCells;
        if (!this.persist()) {
            // 存不上就把内存回滚到磁盘状态：不关浮层、不清输入框。
            // 用户写下的内容还在 editValue 里，可以自己复制出来，
            // 不会被「浮层关掉 + 格子显示新内容」骗成已经存好了。
            this._cells = prevCells;
            this.setData({ editing: true, insightOpen: false });
            return false;
        }
        this.setData({
            editing: false,
            insightOpen: false,
            gridCells: this.buildCells(),
            filledCount: this.countFilled(),
        });
        this.flushPendingDate();
        return true;
    },

    // ---- 工作模块：任务框 / 完成态 / 感想 / 汇总 ----
    // 统一写盘入口：任务与感想都挂在当天日记的 workBoard 字段，走 persist() 单一路径
    setWorkBoard(next) {
        this._workBoard = workBoard.normalize(next);
        const v = workBoard.view(this._workBoard);
        this.setData({
            workTasks: v.tasks,
            workDoneCount: v.done,
            workTotal: v.total,
            workPct: v.pct,
            workReflection: this._workBoard.reflection,
            workTagChips: this.buildWorkTags(),
            gridCells: this.buildCells(),
        });
        this.persist();
    },

    // 感想输入时不逐字写盘；失焦 / 切 tab / 其它动作前统一同步一次
    syncWorkReflection() {
        if (!this._workBoard) return;
        const cur = String(this.data.workReflection || '');
        if (this._workBoard.reflection !== cur) {
            this._workBoard = workBoard.setReflection(this._workBoard, cur);
            this.persist();
        }
    },

    onWorkInput(e) {
        this.setData({ workInput: e.detail.value });
    },

    // 常用标签池：全部历史里用得最多的 6 个；读失败就当作没有，不弹错
    buildWorkTags() {
        const r = store.workTagPool(6);
        return r.error ? [] : r.data;
    },

    // 手机上敲 # 麻烦：点标签追加到输入框末尾；同一个标签不重复追加
    onPickWorkTag(e) {
        const tag = e.currentTarget.dataset.tag;
        if (!tag) return;
        const cur = String(this.data.workInput || '');
        if (workBoard.parseTags(cur).indexOf(tag) >= 0) {
            wx.showToast({ title: '这条已经有这个标签了', icon: 'none' });
            return;
        }
        const next = (cur ? cur.replace(/\s+$/, '') + ' ' : '') + '#' + tag;
        this.setData({ workInput: next.slice(0, workBoard.TASK_MAX) });
    },

    onAddWorkTask() {
        this.syncWorkReflection();
        const text = String(this.data.workInput || '').trim();
        if (!text) {
            wx.showToast({ title: '先写一条任务', icon: 'none' });
            return;
        }
        if ((this._workBoard.tasks || []).length >= workBoard.MAX_TASKS) {
            wx.showToast({ title: '今天最多 20 条', icon: 'none' });
            return;
        }
        this.setWorkBoard(workBoard.addTask(this._workBoard, text));
        this.setData({ workInput: '' });
    },

    // 点整个任务框即切换完成态：删除线 + 文字变浅由 .work-task-done 负责
    onToggleWorkTask(e) {
        this.syncWorkReflection();
        this.setWorkBoard(workBoard.toggleTask(this._workBoard, e.currentTarget.dataset.id));
    },

    onRemoveWorkTask(e) {
        this.syncWorkReflection();
        this.setWorkBoard(workBoard.removeTask(this._workBoard, e.currentTarget.dataset.id));
    },

    onWorkReflectionInput(e) {
        this.setData({ workReflection: e.detail.value });
    },

    onWorkReflectionBlur() {
        this.syncWorkReflection();
    },

    onOpenWorkSummary() {
        this.syncWorkReflection();
        const r = store.workSummary();
        const data = r.error ? workBoard.summarize([]) : r.data;
        // 复制用的是整份纯文本：放实例上，不进 setData（体积和整本汇总一样大）
        this._workSummaryText = data.text || '';
        this.setData({
            workSummaryOpen: true,
            workSummaryData: buildWorkSummaryPayload(data),
        });
    },

    closeWorkSummary() {
        this.setData({ workSummaryOpen: false });
    },

    onCopyWorkSummary() {
        const text = this._workSummaryText || '';
        if (!text) return;
        wx.setClipboardData({
            data: text,
            success: function () {
                wx.showToast({ title: '工作感想已复制', icon: 'none' });
            },
        });
    },

    // ---- 金钱模块：收/支切换 → 金额 → 分类 → 一句备注 ----
    // 每笔即时落盘，统一挂在当天日记的 moneyBook 字段，走 persist() 单一路径；
    // 汇总不在本页，交给「回看」页的收支汇总卡片。
    setMoneyBook(next) {
        this._moneyBook = moneyBook.normalize(next);
        const v = moneyBook.view(this._moneyBook);
        this.setData({
            moneyEntries: v.entries,
            moneyCount: v.count,
            moneyIncomeText: v.incomeText,
            moneyExpenseText: v.expenseText,
            moneyBalanceText: v.balanceText,
            gridCells: this.buildCells(),
        });
        this.persist();
    },

    onSwitchMoneyType(e) {
        const type = e.currentTarget.dataset.type === 'income' ? 'income' : 'expense';
        const cats = moneyBook.categoriesOf(type);
        this.setData({
            moneyType: type,
            moneyCategories: cats,
            moneyCategory: cats.length ? cats[0].id : 'other',
        });
    },

    onPickMoneyCategory(e) {
        this.setData({ moneyCategory: e.currentTarget.dataset.id });
    },

    onMoneyAmountInput(e) {
        this.setData({ moneyAmount: e.detail.value });
    },

    onMoneyNoteInput(e) {
        this.setData({ moneyNote: e.detail.value });
    },

    onAddMoneyEntry() {
        const cents = moneyBook.parseAmount(this.data.moneyAmount);
        if (!cents) {
            wx.showToast({ title: '先填一个金额', icon: 'none' });
            return;
        }
        if (this.data.moneyCount >= moneyBook.MAX_ENTRIES) {
            wx.showToast({ title: '今天最多 30 笔', icon: 'none' });
            return;
        }
        this.setMoneyBook(moneyBook.addEntry(this._moneyBook, {
            type: this.data.moneyType,
            amount: this.data.moneyAmount,
            category: this.data.moneyCategory,
            note: this.data.moneyNote,
        }));
        this.setData({ moneyAmount: '', moneyNote: '' });
        wx.showToast({ title: '记下了', icon: 'none' });
    },

    onRemoveMoneyEntry(e) {
        this.setMoneyBook(moneyBook.removeEntry(this._moneyBook, e.currentTarget.dataset.id));
    },

    // ---- 学习模块：书 / 影 / 画 / 课 进展记录 + 主题学习 ----
    // 学习库存单键、当天流水随日记；两者都经 store 单一入口，不直接碰 storage。
    setStudyLibrary(next) {
        this._studyLibrary = store.saveStudyLibrary(next);
        // 学习库是单键全量写入，写失败时页面若照旧显示新条目，
        // 就成了「看着存上了其实没有」——必须让用户当场知道
        if (!store.studySaveOk()) {
            wx.showToast({ title: '学习库未能保存，请检查本机存储空间', icon: 'none', duration: 2500 });
        }
        this.refreshStudyView();
        this.persist();
    },

    setStudyLog(next) {
        this._studyLog = studyLog.normalize(next);
        const d = studyLog.viewDay(this._studyLog, this._studyLibrary);
        this.setData({
            studyDayLogs: d.entries,
            studyDayCount: d.count,
            studyDaySteps: d.steps,
            studyDayNote: d.note,
        });
        this.persist();
    },

    refreshStudyView() {
        const v = studyLog.view(this._studyLibrary, {
            kind: this.data.studyKindFilter,
            topicId: this.data.studyTopicFilter,
        });
        const d = studyLog.viewDay(this._studyLog, this._studyLibrary);
        this.setData({
            studyItems: v.items,
            studyTopics: v.topics,
            studyTopicOptions: v.topicOptions,
            studyKindCounts: v.kindCounts,
            studyOverall: v.overall,
            studyDayLogs: d.entries,
            studyDayCount: d.count,
            studyDaySteps: d.steps,
            studyDayNote: d.note,
            studyNewTopicId: '',
            gridCells: this.buildCells(),
        });
    },

    // 每次进度变化 / 新建 / 标记完成都留一条按日期分组的流水
    logStudy(item, action, delta) {
        if (!item) return;
        this.setStudyLog(studyLog.addLog(this._studyLog, {
            itemId: item.id,
            title: item.title,
            kind: item.kind,
            unit: item.unit,
            done: item.done,
            total: item.total,
            delta: delta || 0,
            topicId: item.topicId,
            action: action,
        }));
    },

    syncStudyNote() {
        if (!this._studyLog) return;
        const cur = String(this.data.studyDayNote || '');
        if (this._studyLog.note !== cur) {
            this.setStudyLog(studyLog.setDayNote(this._studyLog, cur));
        }
    },

    onStudyTab(e) {
        this.syncStudyNote();
        const tab = e.currentTarget.dataset.tab;
        this.setData({ studyTab: tab === 'topics' || tab === 'today' ? tab : 'items' });
    },

    onStudyKindFilter(e) {
        this.setData({ studyKindFilter: e.currentTarget.dataset.kind || '' });
        this.refreshStudyView();
    },

    onStudyTopicFilter(e) {
        this.setData({ studyTopicFilter: e.currentTarget.dataset.topic || '' });
        this.refreshStudyView();
    },

    onPickStudyNewKind(e) {
        this.setData({ studyNewKind: e.currentTarget.dataset.kind || 'book' });
    },

    onPickStudyNewTopic(e) {
        this.setData({ studyNewTopicId: e.currentTarget.dataset.topic || '' });
    },

    onStudyTitleInput(e) { this.setData({ studyTitle: e.detail.value }); },
    onStudyTotalInput(e) { this.setData({ studyTotal: e.detail.value }); },
    onStudyTopicTitleInput(e) { this.setData({ studyTopicTitle: e.detail.value }); },

    onAddStudyItem() {
        this.syncStudyNote();
        const title = String(this.data.studyTitle || '').trim();
        if (!title) {
            wx.showToast({ title: '先写个名字', icon: 'none' });
            return;
        }
        if (this._studyLibrary.items.length >= studyLog.MAX_ITEMS) {
            wx.showToast({ title: '学习库最多 60 项', icon: 'none' });
            return;
        }
        const r = studyLog.addItem(this._studyLibrary, {
            kind: this.data.studyNewKind,
            title: title,
            total: this.data.studyTotal,
            topicId: this.data.studyNewTopicId,
        });
        if (!r.item) return;
        this.setStudyLibrary(r.library);
        this.logStudy(r.item, 'new', 0);
        this.setData({ studyTitle: '', studyTotal: '', studyNewTopicId: '' });
        wx.showToast({ title: '已加入学习库', icon: 'none' });
    },

    onStudyAdvance(e) {
        this.syncStudyNote();
        const ds = e.currentTarget.dataset;
        const r = studyLog.advance(this._studyLibrary, ds.id, Number(ds.step) || 1);
        if (!r.item || !r.delta) return;
        this.setStudyLibrary(r.library);
        this.logStudy(r.item, 'progress', r.delta);
    },

    onStudyRewind(e) {
        this.syncStudyNote();
        const ds = e.currentTarget.dataset;
        const r = studyLog.rewind(this._studyLibrary, ds.id, Number(ds.step) || 1);
        if (!r.item || !r.delta) return;
        this.setStudyLibrary(r.library);
        this.logStudy(r.item, 'progress', r.delta);
    },

    onStudyProgressBlur(e) {
        const r = studyLog.setProgress(this._studyLibrary,
            e.currentTarget.dataset.id, e.detail.value);
        if (!r.item || !r.delta) return;
        this.setStudyLibrary(r.library);
        this.logStudy(r.item, 'progress', r.delta);
    },

    onStudyToggleFinished(e) {
        this.syncStudyNote();
        const r = studyLog.toggleFinished(this._studyLibrary, e.currentTarget.dataset.id);
        if (!r.item) return;
        this.setStudyLibrary(r.library);
        if (r.item.finished) this.logStudy(r.item, 'done', 0);
    },

    onStudyItemNoteBlur(e) {
        const r = studyLog.setItemNote(this._studyLibrary,
            e.currentTarget.dataset.id, e.detail.value);
        this.setStudyLibrary(r);
    },

    onStudyAssignTopic(e) {
        const idx = Number(e.detail.value) || 0;
        const opt = this.data.studyTopicOptions[idx] || { id: '' };
        this.setStudyLibrary(studyLog.assignTopic(this._studyLibrary,
            e.currentTarget.dataset.id, opt.id));
    },

    onStudyRemoveItem(e) {
        const self = this;
        const id = e.currentTarget.dataset.id;
        const it = (this._studyLibrary.items || []).filter(function (x) {
            return x.id === id;
        })[0];
        if (!it) return;
        wx.showModal({
            title: '移出学习库',
            content: '「' + it.title + '」会移走，已经记下的进展流水仍留在日记里。',
            confirmText: '移出',
            success: function (m) {
                if (!m.confirm) return;
                self.setStudyLibrary(studyLog.removeItem(self._studyLibrary, id));
            },
        });
    },

    onAddStudyTopic() {
        const title = String(this.data.studyTopicTitle || '').trim();
        if (!title) {
            wx.showToast({ title: '先写主题名', icon: 'none' });
            return;
        }
        if (this._studyLibrary.topics.length >= studyLog.MAX_TOPICS) {
            wx.showToast({ title: '最多 20 个主题', icon: 'none' });
            return;
        }
        const r = studyLog.addTopic(this._studyLibrary, title);
        if (!r.topic) return;
        this.setStudyLibrary(r.library);
        this.setData({ studyTopicTitle: '' });
        wx.showToast({ title: '主题已建好', icon: 'none' });
    },

    onStudyRemoveTopic(e) {
        const id = e.currentTarget.dataset.id;
        this.setData({ studyTopicFilter: '' });
        this.setStudyLibrary(studyLog.removeTopic(this._studyLibrary, id));
    },

    onStudyDayNoteInput(e) { this.setData({ studyDayNote: e.detail.value }); },
    onStudyDayNoteBlur() { this.syncStudyNote(); },

    onRemoveStudyLog(e) {
        this.setStudyLog(studyLog.removeLog(this._studyLog, e.currentTarget.dataset.id));
    },

    onOpenStudySummary() {
        this.syncStudyNote();
        const r = store.studyLibraryText();
        this.setData({
            studySummaryOpen: true,
            studySummaryData: r.error ? studyLog.libraryText(studyLog.emptyLibrary()) : r.data,
        });
    },

    closeStudySummary() { this.setData({ studySummaryOpen: false }); },

    onCopyStudySummary() {
        const data = this.data.studySummaryData;
        if (!data || !data.text) return;
        wx.setClipboardData({
            data: data.text,
            success: function () {
                wx.showToast({ title: '学习汇总已复制', icon: 'none' });
            },
        });
    },

    // ---------- 皮肤跟随 / 设置入口 ----------
    /**
     * 幂等：别的页（设置页）换肤时广播过来、onShow 兜底都走这里。
     * setData 前先比对，避免无谓重绘。
     * force 用于强制重刷原生层：设置页换完肤时 _applied 已经推到新 id，
     * 本页若只传 id 会命中幂等短路，tabBar 图标与导航栏就留在旧主题上。
     */
    applyTheme(id, force) {
        const next = theme.isValidId(id) ? id : theme.getThemeId();
        if (next !== this.data.theme) this.setData({ theme: next });
        theme.applySystemChrome(next, force);
    },

    // 设置已独立成页：本页只留一个入口，不再有浮层
    onOpenSettings() {
        // 「· 新」只出现一次：进到设置页就算见过，写标记但不阻塞跳转
        try {
            if (this.data.skinTip) wx.setStorageSync('skin_tip_seen', 1);
        } catch (e) {}
        if (this.data.skinTip) this.setData({ skinTip: false });
        wx.navigateTo({
            url: '/pages/settings/settings',
            fail: function () {
                wx.showToast({ title: '设置页没打开，请重试', icon: 'none' });
            },
        });
    },

    onEndFirstWeek() {
        const self = this;
        wx.showModal({
            title: '结束头七天引导',
            content: '之后九宫格会回到当前模板的常规提问。头 7 天的引导仍可在「坚持」页查看。',
            confirmText: '结束引导',
            success: function (m) {
                if (!m.confirm) return;
                const r = store.setFirstWeekEnabled(false);
                if (!r.error) self.refresh();
            },
        });
    },

    // 一键留一句：把第一步缩回一句话，降低空白页压力
    onQuickNote(e) {
        const text = e.currentTarget.dataset.text;
        if (!text) return;
        const key = 'free';
        const cur = String((this._cells || {})[key] || '');
        if (cur.indexOf(text) >= 0) {
            wx.showToast({ title: '已经记下啦', icon: 'none' });
            return;
        }
        this._cells = Object.assign({}, this._cells);
        this._cells[key] = cur ? cur + '\n' + text : text;
        this.persist();
        this.setData({
            gridCells: this.buildCells(),
            filledCount: this.countFilled(),
        });
        wx.showToast({ title: '已记下 · 这也算一篇', icon: 'none', duration: 2000 });
    },

    onViewPrevious() {
        // 回看页现在分「概览 / 复盘 / 日记」三页：从「往年今天」进来必须落在日记页，
        // 否则用户上次停在概览，点进来看到的不是往年同日。tabBar 不能带参，走 globalData。
        try {
            const app = getApp();
            if (app && app.globalData) app.globalData.reviewTab = 2;
        } catch (e) {}
        wx.switchTab({ url: '/pages/review/review' });
    },

    // 胶囊已独立成栏：今日页只提示，不读写
    loadDueCount() {
        const r = store.dueCapsules();
        this.setData({ capsuleDueCount: r.error ? 0 : r.data.length });
    },

    onGoCapsule() {
        wx.switchTab({ url: '/pages/capsule/capsule' });
    },

    finishToday() {
        this.syncWorkReflection();
        this.syncStudyNote();
        const okSave = this.persist();
        if (!okSave) return;
        const stat = store.stats();
        const s = stat.error ? {} : stat.data;
        this.setData({
            streak: s.streak || 0,
            weekCount: s.weekCount || 0,
            weekTotal: s.weekTotal || 0,
        });
        const fw = store.firstWeekState();
        if (!fw.error) this.setData({ firstWeek: fw.data });
        wx.showToast({
            title: this.data.isBackfill ? '已补记 · 保存好了'
                : ((s.streak || 0) > 0 ? '已记录 · 连续' + s.streak + '天' : '今日已记录 · 明天继续'),
            icon: 'success',
            duration: 1800,
        });
    },
});
