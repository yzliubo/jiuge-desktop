const store = require('../../utils/diary-store.js');
const theme = require('../../utils/theme.js');

// 使用小贴士：全部为九格手记自己的用法说明，不引用任何第三方方法论文本
const USAGE_TIPS = [
    { no: '01', title: '一个字也算数', desc: '格子不必填满，写一句、写一个词都可以保存。' },
    { no: '02', title: '先写今天，再写打算', desc: '左侧写已经发生的事，中心格留给明天想做的一小步。' },
    { no: '03', title: '状态随手记', desc: '第一次点格子会问天气、身体和心情，跳过也没关系。' },
    { no: '04', title: '同一天，跨年并排', desc: '在「回看」里能看到往年的今天，方便对照自己的变化。' },
];

const KEEP_TIPS = [
    { no: '1', name: '把入口放在顺手的地方', desc: '固定一个时间段打开，比靠意志力提醒更有效。' },
    { no: '2', name: '给自己设小奖励', desc: '连续几天后兑现一点小奖励，节点和内容都能自己改。' },
    { no: '3', name: '断了就接着写', desc: '漏掉一天不用补满，从今天继续就好。' },
];

function toast(title) {
    wx.showToast({ title: title, icon: 'none', duration: 2200 });
}

function moduleListOf() {
    const r = store.modules();
    const mods = r.error ? {} : r.data;
    return store.MODULE_DEFS.map(function (m) {
        // modules() 只认明确 false：脏数据 / 缺键一律按开启，老用户升级无感
        return { id: m.id, label: m.label, desc: m.desc, on: mods[m.id] !== false };
    });
}

/**
 * 设置页：皮肤 / 模板 / 模块 / 头七天 / 数据管理 / 小贴士 / 关于
 *
 * 页面只当「读写入口 + 视图」，所有状态仍是 storage 里那一份：
 * 改完不缓存在页面，回到今日页 / 坚持页由它们的 onShow 重新读 ——
 * 多存一份状态就多一处不同步。
 */
Page({
    data: {
        theme: 'standard',
        skinList: theme.list(),
        // 原生 switch 的 color 只吃 hex，不认 CSS 变量，所以要从 THEMES 里带出来
        switchColor: theme.THEMES[theme.DEFAULT_ID].switchColor,
        templateName: '',
        templateNote: '',
        moduleList: [],
        firstWeek: { enabled: true },
        recordCount: 0,
        tipsOpen: false,
        usageTips: USAGE_TIPS,
        keepTips: KEEP_TIPS,
    },

    onLoad() {
        // 本页不是冷启动首屏，但可能是唯一带换肤入口的页面：
        // force = true 保证从任何入口进来，原生层（导航栏 / tabBar）都与 storage 一致
        this.applyTheme(theme.getThemeId(), true);
        // 「设置 · 新」只提示一次：进到设置页就算见过
        try { wx.setStorageSync('skin_tip_seen', 1); } catch (e) {}
    },

    onShow() {
        this.applyTheme();
        this.refresh();
    },

    /** 幂等；被本页换肤、或被别的页广播时都会调到这里。force 用于强制重刷原生层。 */
    applyTheme(id, force) {
        const next = theme.isValidId(id) ? id : theme.getThemeId();
        if (next !== this.data.theme || force) {
            this.setData({ theme: next, switchColor: theme.THEMES[next].switchColor });
        }
        theme.applySystemChrome(next, force);
    },

    refresh() {
        const tpl = store.activeTemplate();
        const fw = store.firstWeekState();
        this.setData({
            templateName: tpl.name,
            templateNote: tpl.note,
            moduleList: moduleListOf(),
            firstWeek: fw.error ? { enabled: true } : { enabled: !!fw.data.enabled },
            recordCount: store.writtenDates().length,
        });
    },

    // ---------- 界面皮肤 ----------
    /**
     * 换肤是全局动作：先落盘，再改本页，最后广播给页面栈里其它页。
     * 广播必须带 force —— 本页已经把 _applied 推到这个 id，
     * 其它 tabBar 页若只传 id 会命中「幂等短路」，tabBar 图标就留在旧主题上。
     */
    onPickSkin(e) {
        const self = this;
        const id = e.currentTarget.dataset.id;
        if (!theme.isValidId(id) || id === this.data.theme) return;

        const r = theme.setThemeId(id);
        this.applyTheme(id, true);

        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        pages.forEach(function (p) {
            if (p && p !== self && typeof p.applyTheme === 'function') p.applyTheme(id, true);
        });

        if (r.error) {
            toast('换肤生效了，但这次没存上，下次打开会回到原来的主题');
        }
    },

    // ---------- 页面模板 ----------
    // 只换标签与提问，九个数据键不变，已写内容不受影响
    onSwitchTemplate() {
        const self = this;
        wx.showActionSheet({
            itemList: store.TEMPLATES.map(function (t) { return t.name; }),
            success: function (res) {
                const tpl = store.TEMPLATES[res.tapIndex];
                if (!tpl) return;
                const r = store.setTemplate(tpl.id);
                if (r.error) { toast('切换失败'); return; }
                self.refresh();
                toast('已切换 · ' + tpl.name);
            },
        });
    },

    // ---------- 功能模块 / 头七天 ----------
    // 关模块不删数据：只改展示开关，老内容仍在记录里，开回来就能看见
    onToggleModule(e) {
        const id = e.currentTarget.dataset.id;
        const on = !!(e.detail && e.detail.value);
        const r = store.setModule(id, on);
        if (r.error) {
            toast('设置没存上，请重试');
            this.refresh();
            return;
        }
        this.refresh();
        const def = store.MODULE_DEFS.filter(function (m) { return m.id === id; })[0];
        toast(on ? (def ? def.label : '模块') + ' 已开启' : '已收起，内容仍在本机');
    },

    onToggleFirstWeek(e) {
        const on = !!(e.detail && e.detail.value);
        const r = store.setFirstWeekEnabled(on);
        if (r.error) { toast('设置没存上，请重试'); return; }
        this.refresh();
        toast(on ? '头七天引导已开启' : '头七天引导已关闭');
    },

    // ---------- 数据管理 ----------
    onExportText() {
        if (!store.writtenDates().length) { toast('还没有日记可导出'); return; }
        const r = store.exportText();
        if (r.error) { toast('导出失败：' + r.error); return; }
        wx.setClipboardData({
            data: r.data,
            success: function () { toast('已复制，可粘贴存档'); },
        });
    },

    onExportMarkdown() {
        if (!store.writtenDates().length) { toast('还没有日记可导出'); return; }
        const r = store.exportMarkdown();
        if (r.error) { toast('导出失败：' + r.error); return; }
        wx.setClipboardData({
            data: r.data,
            success: function () { toast('Markdown 已复制，可直接粘贴到笔记软件'); },
        });
    },

    onExportBackup() {
        if (!store.writtenDates().length) { toast('还没有日记可备份'); return; }
        const r = store.exportBackup();
        if (r.error) { toast('导出失败：' + r.error); return; }
        wx.setClipboardData({
            data: r.data,
            success: function () { toast('备份已复制，请妥善保存'); },
        });
    },

    onImportBackup() {
        const self = this;
        wx.getClipboardData({
            success: function (res) {
                const text = String((res && res.data) || '');
                if (!text.trim()) { toast('剪贴板是空的，请先复制备份 JSON'); return; }
                let parsed;
                try { parsed = JSON.parse(text); }
                catch (e) { toast('剪贴板内容不是有效的备份 JSON'); return; }
                const records = parsed && parsed.records;
                if (!records || !Array.isArray(records)) { toast('未识别到备份数据'); return; }
                wx.showModal({
                    title: '导入备份',
                    content: '检测到 ' + records.length + ' 篇日记。导入只补写本机没有的日期，不会覆盖已有记录。',
                    confirmText: '开始导入',
                    success: function (m) {
                        if (!m.confirm) return;
                        const r = store.importBackup(text);
                        if (r.error) { toast('导入失败：' + r.error); return; }
                        self.refresh();
                        const d = r.data;
                        // 旧版备份（无版本号或 version < 6）字段不全，只导入了能识别的部分，必须说明。
                        // showToast 的文案长度上限属平台口径，超长会被截断，
                        // 这里压到 14 字上下：导入篇数 + 旧版来源 + 跳过篇数三样都保留。
                        if (d.partial) {
                            toast('导入' + d.imported + '篇（旧版，跳过' + d.skipped + '篇）');
                            return;
                        }
                        toast('导入 ' + d.imported + ' 篇，跳过 ' + d.skipped + ' 篇');
                    },
                });
            },
        });
    },

    // 【桌面新增】文件导入与三种导出另存的唯一转调入口：
    // 不另写合并、去重、版本分支，全部复用 store.importBackup(text) 与 desktop-features。
    onImportBackupFile() {
        const self = this;
        const desktop = typeof JiugeDesktopFeatures !== 'undefined' ? JiugeDesktopFeatures : null;
        if (!desktop || typeof desktop.importFromFile !== 'function') return;
        desktop.importFromFile().then(function (r) {
            if (r && r.ok) self.refresh();
        });
    },

    onExportTextFile() {
        if (typeof JiugeDesktopFeatures !== 'undefined') JiugeDesktopFeatures.exportToFile('text');
    },

    onExportMarkdownFile() {
        if (typeof JiugeDesktopFeatures !== 'undefined') JiugeDesktopFeatures.exportToFile('markdown');
    },

    onExportBackupFile() {
        if (typeof JiugeDesktopFeatures !== 'undefined') JiugeDesktopFeatures.exportToFile('backup');
    },

    // ---------- 使用小贴士 ----------
    toggleTips() {
        this.setData({ tipsOpen: !this.data.tipsOpen });
    },
});
