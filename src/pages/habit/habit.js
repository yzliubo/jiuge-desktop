const store = require('../../utils/diary-store.js');
const theme = require('../../utils/theme.js');

// 奖励里程碑的周期预设（周 / 月 / 年 / 千日的常见节点）
// 存成字符串，与 input 的 value 同类型，WXML 里直接比较即可高亮当前选中项
const MS_PRESETS = ['7', '30', '90', '180', '365', '1000'];


function toast(title) {
    wx.showToast({ title: title, icon: 'none', duration: 2200 });
}

function daysBetween(dateStr) {
    if (!dateStr) return 0;
    const parts = dateStr.split('-');
    const start = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.max(1, Math.floor((now - start) / 86400000) + 1);
}

function challengeOf(streak) {
    if (streak < 3) {
        return {
            tag: '第一关 · 三天',
            title: '还在暖身，别断',
            desc: '前三天最兴奋，也最容易变成「三天打鱼、两天晒网」。先撑过这三天。',
        };
    }
    if (streak < 90) {
        return {
            tag: '第二关 · 三月',
            title: '开始滑行，机身会晃',
            desc: '第四天起走出跑道，机体小幅摇动，大约三个月后便可水平飞行。',
        };
    }
    if (streak < 1095) {
        return {
            tag: '第三关 · 三年',
            title: '朝稳定飞行前进',
            desc: '过了三个月的考验期，接下来的目标是三年后的稳定飞行境界。',
        };
    }
    return {
        tag: '已入稳定飞行',
        title: '它已经是你的习惯了',
        desc: '写日记和飞机一样，进入稳定飞行状态后就没有问题了。',
    };
}

Page({
    data: {
        // 皮肤：根 view 拼 theme-{{theme}}；onLoad 覆盖成 storage 里的真实值
        theme: 'standard',
        streak: 0,
        total: 0,
        startedDays: 0,
        bestStreak: 0,
        weekCount: 0,
        weekGoal: 5,
        gentle: '',
        progressWidth: '0%',
        challengeTag: '',
        challengeTitle: '',
        challengeDesc: '',
        milestones: [],
        milestoneNext: '',
        msPresets: MS_PRESETS,
        msOpen: false,
        msIndex: -1,
        msDays: '',
        msReward: '',
        firstWeekActive: false,
        firstWeekDayNo: 1,
        firstWeekCelebration: '',
        recordCount: 0,
    },

    onLoad() {
        // 本页不是冷启动首屏，不需要 force
        const themeId = theme.getThemeId();
        this.setData({ theme: themeId });
        theme.applySystemChrome(themeId);
    },

    onShow() {
        // 兜底：可能刚在设置页换过肤；第二参数是「有待补刷」标记（非 tabBar 页换肤时置位）
        this.applyTheme(null, theme.takePendingTabChrome());
        this.refresh();
        this.refreshCount();
    },

    /** 幂等；被本页换肤、或被设置页广播时都会调到这里。force 用于强制重刷原生层。 */
    applyTheme(id, force) {
        const next = theme.isValidId(id) ? id : theme.getThemeId();
        if (next !== this.data.theme) this.setData({ theme: next });
        theme.applySystemChrome(next, force);
    },

    refreshCount() {
        this.setData({ recordCount: store.writtenDates().length });
    },

    refresh() {
        const result = store.stats();
        if (result.error) {
            wx.showToast({ title: '读取失败', icon: 'none' });
            return;
        }
        const s = result.data;
        const challenge = challengeOf(s.streak);

        const fw = store.firstWeekState();
        const firstWeek = fw.error ? { active: false, dayNo: 1, celebration: '' } : fw.data;

        this.setData({
            streak: s.streak,
            total: s.total,
            startedDays: daysBetween(s.startedAt),
            bestStreak: s.bestStreak,
            weekCount: s.weekCount,
            weekGoal: s.weekGoal,
            gentle: s.gentle,
            progressWidth: (Math.min(s.total, 1000) / 10).toFixed(1) + '%',
            challengeTag: challenge.tag,
            challengeTitle: challenge.title,
            challengeDesc: challenge.desc,
            firstWeekActive: firstWeek.active,
            firstWeekDayNo: firstWeek.dayNo,
            firstWeekCelebration: firstWeek.celebration,
        });
        this.refreshMilestones(s.total);
    },

    // ---------- 奖励里程碑（周期与内容自定义） ----------
    refreshMilestones(total) {
        const total0 = typeof total === 'number' ? total : this.data.total;
        const r = store.milestoneView(total0);
        if (r.error) return;
        const d = r.data;
        let lead = '';
        if (!d.count) lead = '';
        else if (d.next) lead = '下一个里程碑：第 ' + d.next.at + ' 天 · 还差 ' + d.next.remain + ' 天';
        else lead = '设定的奖励都已达成，给自己定一个新的。';
        this.setData({ milestones: d.list, milestoneNext: lead });
    },

    onOpenMilestone(e) {
        const idx = Number(e.currentTarget.dataset.index);
        const m = this.data.milestones[idx];
        if (!m) return;
        this.setData({
            msOpen: true,
            msIndex: idx,
            msDays: String(m.at),
            msReward: m.reward,
        });
    },

    onAddMilestone() {
        this.setData({ msOpen: true, msIndex: -1, msDays: '', msReward: '' });
    },

    onMsDays(e) {
        this.setData({ msDays: e.detail.value });
    },

    onMsReward(e) {
        this.setData({ msReward: e.detail.value });
    },

    onMsPreset(e) {
        this.setData({ msDays: String(e.currentTarget.dataset.days) });
    },

    onCloseMilestone() {
        this.setData({ msOpen: false });
    },

    onSaveMilestone() {
        const days = Math.floor(Number(this.data.msDays));
        if (!days || days < 1 || days > 10000) {
            toast('周期请填 1 到 10000 天');
            return;
        }
        const reward = String(this.data.msReward || '').trim().slice(0, 30);
        if (!reward) {
            toast('还没写奖励内容');
            return;
        }

        const idx = this.data.msIndex;
        const list = [];
        this.data.milestones.forEach(function (m, i) {
            if (i === idx) return;
            list.push({ at: m.at, reward: m.reward });
        });

        let merged = false;
        for (let i = 0; i < list.length; i += 1) {
            if (list[i].at === days) {
                if (idx >= 0) {
                    // 编辑时周期撞车：用新内容覆盖那一条，避免出现两条同周期奖励
                    list[i].reward = reward;
                    merged = true;
                } else {
                    toast('第 ' + days + ' 天已有奖励，换个周期或先删掉它');
                    return;
                }
            }
        }
        if (!merged) list.push({ at: days, reward: reward });

        const r = store.saveMilestones(list);
        if (r.error) {
            toast('保存失败');
            return;
        }
        this.setData({ msOpen: false });
        this.refreshMilestones(this.data.total);
        toast('已保存');
    },

    onDeleteMilestone() {
        const idx = this.data.msIndex;
        if (idx < 0) {
            this.setData({ msOpen: false });
            return;
        }
        const self = this;
        const m = this.data.milestones[idx];
        if (!m) {
            this.setData({ msOpen: false });
            return;
        }
        wx.showModal({
            title: '删除这个奖励',
            content: '「第 ' + m.at + ' 天 · ' + m.reward + '」会从里程碑里移除。',
            confirmText: '删除',
            success: function (res) {
                if (!res.confirm) return;
                const list = [];
                self.data.milestones.forEach(function (x, i) {
                    if (i !== idx) list.push({ at: x.at, reward: x.reward });
                });
                const r = store.saveMilestones(list);
                if (r.error) {
                    toast('删除失败');
                    return;
                }
                self.setData({ msOpen: false });
                self.refreshMilestones(self.data.total);
                toast('已删除');
            },
        });
    },

    onResetMilestones() {
        const self = this;
        wx.showModal({
            title: '恢复默认奖励',
            content: '恢复为默认的奖励节点（三天 / 三个月 / 纪念日 / 千日），自定义内容会被清空。',
            confirmText: '恢复',
            success: function (res) {
                if (!res.confirm) return;
                const r = store.resetMilestones();
                if (r.error) {
                    toast('恢复失败');
                    return;
                }
                self.setData({ msOpen: false });
                self.refreshMilestones(self.data.total);
                toast('已恢复默认');
            },
        });
    },

    // ---------- 设置入口 ----------
    // 数据管理与使用小贴士已并入独立设置页：本页只留入口，
    // 皮肤 / 模板 / 模块也都在那边，坚持页主区回到「数据与操作」。
    onOpenSettings() {
        wx.navigateTo({
            url: '/pages/settings/settings',
            fail: function () { toast('设置页没打开，请重试'); },
        });
    },
});
