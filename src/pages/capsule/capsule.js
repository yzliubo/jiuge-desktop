const store = require('../../utils/diary-store.js');
const theme = require('../../utils/theme.js');

function tomorrow() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return store.formatDate(d);
}

Page({
    data: {
        // 皮肤：根 view 拼 theme-{{theme}}；onLoad 覆盖成 storage 里的真实值
        theme: 'standard',
        groups: { due: [], sealed: [], opened: [] },
        dueCount: 0,
        sealedCount: 0,
        openedCount: 0,
        total: 0,
        capsuleText: '',
        capsuleOpenAt: '',
        capsuleOpenAtLabel: '',
        capsuleMinDate: '',
        capsulePresets: [],
        openedId: '',
        openedText: '',
        openedFrom: '',
    },

    onLoad() {
        // 本页不是冷启动首屏，不需要 force
        const themeId = theme.getThemeId();
        this.setData({ theme: themeId });
        theme.applySystemChrome(themeId);

        const presets = store.capsulePresets();
        const openAt = presets[0] ? presets[0].value : tomorrow();
        this.setData({
            capsuleMinDate: tomorrow(),
            capsuleOpenAt: openAt,
            capsuleOpenAtLabel: store.prettyDate(openAt),
            capsulePresets: presets.map(function (p) {
                return { label: p.label, value: p.value, selected: p.value === openAt };
            }),
        });
    },

    onShow() {
        // 兜底：可能刚在设置页换过肤；第二参数是「有待补刷」标记（非 tabBar 页换肤时置位）
        this.applyTheme(null, theme.takePendingTabChrome());
        this.refresh();
    },

    /** 幂等；被本页换肤、或被设置页广播时都会调到这里。force 用于强制重刷原生层。 */
    applyTheme(id, force) {
        const next = theme.isValidId(id) ? id : theme.getThemeId();
        if (next !== this.data.theme) this.setData({ theme: next });
        theme.applySystemChrome(next, force);
    },

    refresh() {
        const r = store.capsuleGroups();
        if (r.error) {
            wx.showToast({ title: '读取失败', icon: 'none' });
            return;
        }
        const g = r.data;
        this.setData({
            groups: g,
            dueCount: g.dueCount,
            sealedCount: g.sealedCount,
            openedCount: g.openedCount,
            total: g.total,
        });
    },

    onCapsuleInput(e) {
        this.setData({ capsuleText: e.detail.value });
    },

    onPickCapsulePreset(e) {
        const v = e.currentTarget.dataset.value;
        if (!v) return;
        this.setData({
            capsuleOpenAt: v,
            capsuleOpenAtLabel: store.prettyDate(v),
            capsulePresets: this.data.capsulePresets.map(function (p) {
                return { label: p.label, value: p.value, selected: p.value === v };
            }),
        });
    },

    onCapsuleDateChange(e) {
        const v = e.detail.value;
        if (!v) return;
        if (v <= store.today()) {
            wx.showToast({ title: '请选一个未来的日子', icon: 'none' });
            return;
        }
        this.setData({
            capsuleOpenAt: v,
            capsuleOpenAtLabel: store.prettyDate(v),
            capsulePresets: this.data.capsulePresets.map(function (p) {
                return { label: p.label, value: p.value, selected: p.value === v };
            }),
        });
    },

    onSendCapsule() {
        const text = String(this.data.capsuleText || '').trim();
        if (!text) { wx.showToast({ title: '先写点什么吧', icon: 'none' }); return; }
        const r = store.saveCapsule(text, this.data.capsuleOpenAt);
        if (r.error) {
            const msg = r.error === 'DATE_NOT_FUTURE' ? '请选一个未来的日期'
                : (r.error === 'EMPTY_TEXT' ? '先写点什么吧' : '寄出失败');
            wx.showToast({ title: msg, icon: 'none' });
            return;
        }
        this.setData({ capsuleText: '' });
        this.refresh();
        wx.showToast({ title: '已封存，到那天才能打开', icon: 'none', duration: 2200 });
    },

    // 到期的信拆开；已开启的重读；未到期的轻点只给提示，绝不提前泄露内容
    onShowCapsule(e) {
        const id = e.currentTarget.dataset.id;
        if (!id) return;
        const g = this.data.groups;
        const pool = g.due.concat(g.sealed, g.opened);
        let item = null;
        pool.forEach(function (x) { if (x.id === id) item = x; });
        if (!item) return;

        if (item.opened) {
            this.setData({ openedId: id, openedText: item.text, openedFrom: item.writtenAtLabel });
            return;
        }
        if (item.daysLeft > 0) {
            wx.showToast({ title: '还没到开启的日子', icon: 'none' });
            return;
        }
        const r = store.openCapsule(id);
        if (r.error) { wx.showToast({ title: '开启失败', icon: 'none' }); return; }
        this.setData({
            openedId: id,
            openedText: r.data.text,
            openedFrom: store.prettyDate(r.data.writtenAt || r.data.openAt),
        });
        this.refresh();
    },

    onCloseCapsuleRead() {
        this.setData({ openedId: '', openedText: '', openedFrom: '' });
    },
});
