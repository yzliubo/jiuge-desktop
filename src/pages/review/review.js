const store = require('../../utils/diary-store.js');
const moneyBook = require('../../utils/money-book.js');
const studyLog = require('../../utils/study-log.js');
const theme = require('../../utils/theme.js');

const MOODS = ['愉悦', '平静', '一般', '低落', '烦躁'];

// 顶部三个标签：概览（周小结/收支/学习/心情） / 复盘（三问·模块汇总·高频词） / 日记（按日期翻）
const TABS = [
    { key: 'overview', label: '概览' },
    { key: 'review', label: '复盘' },
    { key: 'diary', label: '日记' },
];

// 首屏渲染前 data 里必须有完整形状，否则模板取 {{digest.rows.length}} 会报错
const EMPTY_DIGEST = {
    period: 'week', periodWord: '本周', rangeLabel: '',
    totalDays: 0, writtenDays: 0, chars: 0,
    rows: [], insight: '', note: '',
};

const EMPTY_MOOD = { items: [], note: '', average: '0.0', withMood: 0, days: 30 };

// 工作汇总的初始形状：首屏渲染前模板就要能取到每个字段
const EMPTY_WORK = {
    period: 'week', periodWord: '本周', rangeLabel: '',
    empty: true,
    taskTotal: 0, taskDone: 0, taskOpen: 0, pct: 0,
    reflectCount: 0, reflectChars: 0,
    filters: [], tags: [],
    openTasks: [], doneTasks: [], openMore: 0, doneMore: 0,
    reflections: [], reflectMore: 0,
    activeTag: '', insight: '', note: '',
};

function pretty(date) {
    const parts = date.split('-');
    return Number(parts[0]) + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日';
}

function shortDate(date) {
    const parts = date.split('-');
    return Number(parts[1]) + '月' + Number(parts[2]) + '日';
}

function rangeLabel(start, end) {
    if (!start || !end) return '';
    const a = start.split('-');
    const b = end.split('-');
    return Number(a[1]) + '.' + Number(a[2]) + ' — ' + Number(b[1]) + '.' + Number(b[2]);
}

function buildMoodFilters(cur) {
    const out = [{ value: '', label: '全部', selected: !cur }];
    MOODS.forEach(function (m) {
        out.push({ value: m, label: m, selected: m === cur });
    });
    return out;
}

const BASE_LABELS = {
    weather: '天气',
    anniversary: '纪念日',
    body: '身体',
    mood: '心情',
};

Page({
    data: {
        // 皮肤：根 view 拼 theme-{{theme}}；onLoad 覆盖成 storage 里的真实值
        theme: 'standard',

        // ---------- 标签 ----------
        tabs: TABS,
        tabIndex: 0,

        // ---------- 概览 ----------
        // 本周小结
        weekly: { days: 0, chars: 0, summary: '', excerpts: [], topMood: '' },
        weeklyRange: '',
        // 近 30 天心情
        moodItems: [],
        moodNote: '',
        moodAverage: '0.0',
        moodWithMood: 0,
        // 收支汇总：来自九宫格金钱格，按周 / 月 / 年切换
        moneyPeriod: 'week',
        moneySummary: null,
        // 学习进展：来自九宫格「学习成长」格，按周 / 月 / 年切换
        studyPeriod: 'week',
        studySummary: null,
        // 工作统计：来自九宫格「工作」格，任务完成情况 / 标签分类 / 感想摘录
        workPeriod: 'week',
        // 标签筛选值：'' = 全部，'__untagged__' = 未分类，其余为标签名
        workTagFilter: '',
        workDigest: EMPTY_WORK,
        // 已完成清单和感想摘录都可能很长，默认只给数字，点标题再展开
        workDoneOpen: false,
        workReflectOpen: false,

        // ---------- 复盘 ----------
        // 九格模块汇总：本周 / 本月 / 本年
        digestPeriod: 'week',
        digest: EMPTY_DIGEST,
        // 哪些格子展开了「最近一句」：{ 格key: true }。默认全收起，
        // 换周期不清空——格子 key 不变，展开的那几格继续展开，正文跟着刷新
        digestOpen: {},
        reviewPeriod: 'week',
        reviewKey: '',
        reviewRows: [],
        phrases: [],
        phraseScanned: 0,
        phraseNote: '',

        // ---------- 日记 ----------
        selectedDate: '',
        selectedDateLabel: '',
        monthDayLabel: '',
        sameDay: [],
        randomShown: false,
        randomCard: null,
        searchKeyword: '',
        searched: false,
        searchHits: [],
        moodFilter: '',
        moodFilters: buildMoodFilters(''),
        allDates: [],
        totalCount: 0,
        // 这一年的每一天
        pixelYear: new Date().getFullYear(),
        pixelMonths: [],
        pixelWritten: 0,
        canNextPixel: false,
        // 点「全部日记」回到顶部：scroll-view 不吃 pageScrollTo，用锚点
        diaryAnchor: '',
    },

    onLoad() {
        // 本页不是冷启动首屏，不需要 force：导航栏在 app.js / 首页 onLoad 时已经刷过
        const themeId = theme.getThemeId();
        this.setData({ theme: themeId });
        theme.applySystemChrome(themeId);

        this.setData({ selectedDate: store.today() });
        this._reviewLoadedKey = '';
        this.refresh();
    },

    onShow() {
        // 兜底：可能刚在设置页换过肤；第二参数是「有待补刷」标记（非 tabBar 页换肤时置位）
        this.applyTheme(null, theme.takePendingTabChrome());
        this.consumeEntryTab();
        this.refresh();
    },

    // 今日页点「往年今天」时指定落在哪个标签（tabBar 不能带参，走 globalData 中转一次）
    consumeEntryTab() {
        let idx = null;
        try {
            const app = getApp();
            if (app && app.globalData && typeof app.globalData.reviewTab === 'number') {
                idx = app.globalData.reviewTab;
                app.globalData.reviewTab = null;
            }
        } catch (e) {}
        if (idx === null || !(idx >= 0 && idx < TABS.length)) return;
        if (idx === this.data.tabIndex) return;
        this.setData({ tabIndex: idx });
    },

    /** 幂等；被本页换肤、或被设置页广播时都会调到这里。force 用于强制重刷原生层。 */
    applyTheme(id, force) {
        const next = theme.isValidId(id) ? id : theme.getThemeId();
        if (next !== this.data.theme) this.setData({ theme: next });
        theme.applySystemChrome(next, force);
    },

    // ---------- 标签切换 ----------
    // 点标签与滑动都只是改 tabIndex：swiper 受控于 current，两边不会打架
    onTabTap(e) {
        const idx = Number(e.currentTarget.dataset.index);
        if (!(idx >= 0 && idx < TABS.length) || idx === this.data.tabIndex) return;
        this.setData({ tabIndex: idx });
    },

    onTabChange(e) {
        const idx = Number(e.detail && e.detail.current);
        if (!(idx >= 0 && idx < TABS.length) || idx === this.data.tabIndex) return;
        this.setData({ tabIndex: idx });
    },

    onDateChange(e) {
        this.setData({ selectedDate: e.detail.value });
        this.refresh();
    },

    refresh() {
        const date = this.data.selectedDate || store.today();
        const monthDay = date.slice(5);
        const result = store.sameDayAcrossYears(monthDay);
        const cards = result.error ? [] : result.data.map(this.toYearCard);
        const dates = store.writtenDates();
        const weekly = store.weeklyReview();
        const w = weekly.error ? { days: 0, chars: 0, summary: '', excerpts: [], topMood: '', start: '', end: '' } : weekly.data;
        const fp = store.frequentPhrases(12);
        const phrases = fp.error ? { phrases: [], scanned: 0, note: '' } : fp.data;

        this.setData({
            selectedDate: date,
            selectedDateLabel: pretty(date),
            monthDayLabel: shortDate(date),
            sameDay: cards,
            allDates: dates,
            totalCount: dates.length,
            weekly: w,
            weeklyRange: rangeLabel(w.start, w.end),
            phrases: phrases.phrases,
            phraseScanned: phrases.scanned,
            phraseNote: phrases.note,
            moodFilters: buildMoodFilters(this.data.moodFilter),
        });

        this.loadReviewData(false);
        this.loadMoneySummary();
        this.loadStudySummary();
        this.loadWorkDigest();
        this.loadDigest();
        this.loadMood();
        this.refreshPixels();
        if (this.data.searched) this.runSearch();
    },

    // ---------- 复盘：九格模块汇总 ----------
    loadDigest() {
        const r = store.moduleDigest(this.data.digestPeriod);
        if (r.error || !r.data) {
            this.setData({ digest: EMPTY_DIGEST });
            return;
        }
        const d = r.data;
        this.setData({
            digest: Object.assign({}, d, { rangeLabel: rangeLabel(d.start, d.end) }),
        });
    },

    onDigestPeriod(e) {
        const p = e.currentTarget.dataset.period;
        this.setData({ digestPeriod: p === 'month' || p === 'year' ? p : 'week' });
        this.loadDigest();
    },

    /**
     * 点一行展开/收起「最近一句」。
     * 只用一格 setData（digestOpen.key）而不是重设整个 digest.rows，
     * 这样九行不会跟着重绘；没有摘录的行不响应，避免点了没反应还以为卡住。
     */
    onDigestRowTap(e) {
        const key = e.currentTarget.dataset.key;
        if (!key) return;
        const rows = this.data.digest.rows || [];
        const row = rows.filter(function (r) { return r.key === key; })[0];
        if (!row || !row.last) return;
        const patch = {};
        patch['digestOpen.' + key] = !this.data.digestOpen[key];
        this.setData(patch);
    },

    // ---------- 概览：近 30 天心情 ----------
    loadMood() {
        const r = store.moodTrend(30);
        if (r.error) {
            this.setData({
                moodItems: [], moodNote: EMPTY_MOOD.note,
                moodAverage: EMPTY_MOOD.average, moodWithMood: 0,
            });
            return;
        }
        const t = r.data;
        // 柱高只表达「当天心情」，没记心情但写过字的给一根矮柱，完全空白的最矮
        const items = t.items.map(function (x) {
            return Object.assign({}, x, {
                barH: x.level ? x.level * 14 + 18 : (x.written ? 32 : 10),
            });
        });
        this.setData({
            moodItems: items,
            moodNote: t.note,
            moodAverage: t.average,
            moodWithMood: t.withMood,
        });
    },

    // ---------- 日记：这一年的每一天 ----------
    refreshPixels() {
        const r = store.yearPixels(this.data.pixelYear);
        if (r.error) {
            this.setData({ pixelMonths: [], pixelWritten: 0, canNextPixel: false });
            return;
        }
        this.setData({
            pixelMonths: r.data.months,
            pixelWritten: r.data.writtenCount,
            canNextPixel: r.data.canNext,
        });
    },

    onPrevYear() {
        this.setData({ pixelYear: this.data.pixelYear - 1 });
        this.refreshPixels();
    },

    onNextYear() {
        if (!this.data.canNextPixel) return;
        this.setData({ pixelYear: this.data.pixelYear + 1 });
        this.refreshPixels();
    },

    // 历史日记按当时所用模板的栏目名渲染（记录在 rec.template 里）
    toYearCard(rec) {
        const lines = [];
        store.fieldsFor(rec.template).forEach(function (f) {
            const text = String((rec.cells || {})[f.key] || '').trim();
            if (text) lines.push({ label: f.label, text: text });
        });
        const basic = [];
        Object.keys(BASE_LABELS).forEach(function (k) {
            const v = String((rec.base || {})[k] || '').trim();
            if (v) basic.push(BASE_LABELS[k] + '·' + v);
        });
        return {
            date: rec.date,
            year: rec.date.slice(0, 4),
            dateLabel: shortDate(rec.date),
            basicText: basic.join('   '),
            lines: lines,
        };
    },

    onRandom() {
        const r = store.randomEntry(this.data.selectedDate);
        if (r.error) {
            wx.showToast({ title: '读取失败', icon: 'none' });
            return;
        }
        this.setData({
            randomShown: true,
            randomCard: r.data ? this.toYearCard(r.data) : null,
        });
    },

    onSearchInput(e) {
        this.setData({ searchKeyword: e.detail.value });
    },

    doSearch() {
        this.setData({ searched: true });
        this.runSearch();
    },

    // 心情筛选可单独使用，也可与关键词叠加
    onPickMoodFilter(e) {
        const v = e.currentTarget.dataset.value || '';
        this.setData({ moodFilter: v, searched: true, moodFilters: buildMoodFilters(v) });
        this.runSearch();
    },

    runSearch() {
        const result = store.search(this.data.searchKeyword, this.data.moodFilter);
        if (result.error) {
            this.setData({ searchHits: [] });
            return;
        }
        const hits = result.data.map(function (h, i) {
            return {
                id: i,
                date: h.date,
                label: h.label,
                text: h.text.length > 90 ? h.text.slice(0, 90) + '…' : h.text,
            };
        });
        this.setData({ searchHits: hits });
    },

    // 点「全部日记」里的一条：换日期并回到「日记」标签顶部
    viewDate(e) {
        const date = e.currentTarget.dataset.date;
        const self = this;
        this.setData({ selectedDate: date, diaryAnchor: 'diary-top' }, function () {
            // 锚点复位，否则再次点同一位置不会触发滚动
            setTimeout(function () {
                if (self.data.diaryAnchor) self.setData({ diaryAnchor: '' });
            }, 320);
        });
        this.refresh();
    },

    // 回看页就地补记：tabBar 页无法带参跳转，经 globalData 中转后 switchTab
    goBackfill(date) {
        if (!date || date > store.today()) {
            wx.showToast({ title: '只能补记今天或更早的日子', icon: 'none' });
            return;
        }
        try {
            const app = getApp();
            if (app && app.globalData) app.globalData.backfillDate = date;
        } catch (e) {}
        wx.switchTab({ url: '/pages/index/index' });
    },

    onEditDate(e) {
        this.goBackfill(e.currentTarget.dataset.date);
    },

    onEditSelected() {
        this.goBackfill(this.data.selectedDate);
    },

    // ---------- 复盘：周 / 月复盘三问 ----------
    loadReviewData(force) {
        const period = this.data.reviewPeriod === 'month' ? 'month' : 'week';
        const key = store.reviewPeriodKey(period);
        if (!force && this._reviewLoadedKey === key) return;
        const r = store.loadReview(period, key);
        const answers = r.error ? ['', '', ''] : r.data;
        const questions = store.reviewPrompts(period);
        const rows = questions.map(function (q, i) {
            return { index: i, q: q, a: answers[i] || '' };
        });
        this._reviewLoadedKey = key;
        this.setData({ reviewPeriod: period, reviewKey: key, reviewRows: rows });
    },

    onReviewPeriod(e) {
        const period = e.currentTarget.dataset.period === 'month' ? 'month' : 'week';
        this._reviewLoadedKey = '';
        this.setData({ reviewPeriod: period });
        this.loadReviewData(true);
    },

    onReviewInput(e) {
        const idx = Number(e.currentTarget.dataset.index);
        const value = e.detail.value;
        const rows = this.data.reviewRows.map(function (row) {
            return row.index === idx ? Object.assign({}, row, { a: value }) : row;
        });
        this.setData({ reviewRows: rows });
    },

    onSaveReview() {
        const period = this.data.reviewPeriod;
        const key = this.data.reviewKey;
        const answers = this.data.reviewRows.map(function (row) { return row.a; });
        const r = store.saveReview(period, key, answers);
        if (r.error) { wx.showToast({ title: '保存失败', icon: 'none' }); return; }
        this._reviewLoadedKey = key;
        wx.showToast({ title: '复盘已保存', icon: 'success', duration: 1600 });
    },

    // ---------- 概览：收支汇总（来自九宫格金钱格） ----------
    loadMoneySummary() {
        const period = this.data.moneyPeriod === 'month' || this.data.moneyPeriod === 'year'
            ? this.data.moneyPeriod : 'week';
        const r = store.moneySummary(period);
        this.setData({
            moneySummary: r.error ? moneyBook.summarize([], period, store.today()) : r.data,
        });
    },

    onMoneyPeriod(e) {
        const p = e.currentTarget.dataset.period;
        this.setData({ moneyPeriod: p === 'month' || p === 'year' ? p : 'week' });
        this.loadMoneySummary();
    },

    onCopyMoneySummary() {
        const data = this.data.moneySummary;
        if (!data || !data.text) return;
        wx.setClipboardData({
            data: data.text,
            success: function () {
                wx.showToast({ title: '收支汇总已复制', icon: 'none' });
            },
        });
    },

    // ---------- 概览：学习进展汇总（来自九宫格「学习成长」格） ----------
    loadStudySummary() {
        const period = this.data.studyPeriod === 'month' || this.data.studyPeriod === 'year'
            ? this.data.studyPeriod : 'week';
        const r = store.studySummary(period);
        this.setData({
            studySummary: r.error
                ? studyLog.summarize([], studyLog.emptyLibrary(), period, store.today())
                : r.data,
        });
    },

    onStudyPeriod(e) {
        const p = e.currentTarget.dataset.period;
        this.setData({ studyPeriod: p === 'month' || p === 'year' ? p : 'week' });
        this.loadStudySummary();
    },

    onCopyStudySummary() {
        const data = this.data.studySummary;
        if (!data || !data.text) return;
        wx.setClipboardData({
            data: data.text,
            success: function () {
                wx.showToast({ title: '学习汇总已复制', icon: 'none' });
            },
        });
    },

    // ---------- 概览：工作模块统计（任务 / 标签 / 感想） ----------
    loadWorkDigest() {
        const r = store.workDigest(this.data.workPeriod, this.data.workTagFilter);
        if (r.error || !r.data) {
            this.setData({ workDigest: EMPTY_WORK });
            return;
        }
        const d = r.data;
        this.setData({
            workDigest: Object.assign({}, d, { rangeLabel: rangeLabel(d.start, d.end) }),
        });
    },

    // 换周期时清掉标签筛选：上个窗口里的标签，新窗口里可能一条都没有，
    // 留着会让「筛选中的标签没有对应 chip」，看着像丢失
    onWorkPeriod(e) {
        const p = e.currentTarget.dataset.period;
        const period = p === 'month' || p === 'year' ? p : 'week';
        if (period === this.data.workPeriod && !this.data.workTagFilter) return;
        this.setData({ workPeriod: period, workTagFilter: '' });
        this.loadWorkDigest();
    },

    // 再点一次已选中的标签即取消筛选；「全部」始终回到不筛选
    onWorkTag(e) {
        const tag = e.currentTarget.dataset.tag || '';
        const next = tag && tag === this.data.workTagFilter ? '' : tag;
        if (next === this.data.workTagFilter) return;
        this.setData({ workTagFilter: next });
        this.loadWorkDigest();
    },

    onToggleWorkDone() {
        this.setData({ workDoneOpen: !this.data.workDoneOpen });
    },

    onToggleWorkReflect() {
        this.setData({ workReflectOpen: !this.data.workReflectOpen });
    },
});
