/**
 * 皮肤主题：持久化、读取、原生层应用。
 *
 * 单一真源：storage 的 'skin_theme' 键。内存里只做一层 O(1) 缓存，
 * 缓存没命中才读盘；不往 app.globalData 放 theme —— 一旦有第二份状态就会不同步。
 *
 * 色值来源：本文件的 THEMES 与 styles/theme.wxss 的令牌表是"同一个值抄两处"，
 * 因为原生导航栏 / tabBar 在 view 树之外，只认 API 参数，不认 CSS 变量。
 * 改色时两边都要改（CSS 那份在 .workbuddy/patch-skin-tokens.js 里，改完重跑）。
 */
var KEY = 'skin_theme';
var DEFAULT_ID = 'standard';
var ORDER = ['standard', 'tech', 'girl', 'kids'];

/**
 * tabBar 图标路径。一律写成"相对小程序根目录、不带前导斜杠"的形式：
 * 与 app.json 里 iconPath 的写法逐字一致，两处能直接对拍（`.workbuddy` 里的自检就是这么比的）。
 * 四套目录下文件名完全相同，applySystemChrome 靠 index 顺序换图，文件名一错位就会静默混搭主题。
 */
function tabIcons(id) {
    return [
        ['assets/tab/' + id + '/today-off.png', 'assets/tab/' + id + '/today-on.png'],
        ['assets/tab/' + id + '/review-off.png', 'assets/tab/' + id + '/review-on.png'],
        ['assets/tab/' + id + '/capsule-off.png', 'assets/tab/' + id + '/capsule-on.png'],
        ['assets/tab/' + id + '/habit-off.png', 'assets/tab/' + id + '/habit-on.png'],
    ];
}

var THEMES = {
    standard: {
        id: 'standard', name: '标准版', mood: '森绿米白',
        nav: { backgroundColor: '#F6F8F3', frontColor: '#000000' },
        window: { backgroundColor: '#F6F8F3' },
        tab: {
            color: '#5C7265', selectedColor: '#2F7357', backgroundColor: '#FFFFFF', borderStyle: 'black',
            icon: tabIcons('standard'),
        },
        // 原生 switch 的 color 属性只吃 hex，不认 CSS 变量，所以单独给一份。
        // 与主按钮同色（--c-btn-bg），保证"同一个品牌动作在原生控件和自绘按钮上看起来是同一件事"
        switchColor: '#2F7357',
    },
    tech: {
        id: 'tech', name: '科技蓝', mood: '冷调夜航',
        nav: { backgroundColor: '#0B1729', frontColor: '#ffffff' },
        window: { backgroundColor: '#EEF3FB' },
        tab: {
            color: '#556C86', selectedColor: '#1B62D6', backgroundColor: '#F7FAFE', borderStyle: 'black',
            icon: tabIcons('tech'),
        },
        switchColor: '#1B62D6',
    },
    girl: {
        id: 'girl', name: '少女版', mood: '樱花奶油',
        nav: { backgroundColor: '#FFF6F8', frontColor: '#000000' },
        window: { backgroundColor: '#FDF6F4' },
        tab: {
            color: '#7A5A64', selectedColor: '#C9416F', backgroundColor: '#FFFFFF', borderStyle: 'black',
            icon: tabIcons('girl'),
        },
        switchColor: '#C9416F',
    },
    kids: {
        id: 'kids', name: '儿童版', mood: '糖果积木',
        nav: { backgroundColor: '#FFC22E', frontColor: '#000000' },
        window: { backgroundColor: '#FFFCF2' },
        tab: {
            color: '#5A7180', selectedColor: '#1578B8', backgroundColor: '#FFFFFF', borderStyle: 'black',
            icon: tabIcons('kids'),
        },
        switchColor: '#1578B8',
    },
};

var _cache = null;      // null = 尚未读盘
var _applied = null;    // 上一次成功应用到原生层的主题 id
var _chromeTimer = null;
/**
 * 「有待补刷」标记：换肤可能发生在非 tabBar 页（独立的设置页）。
 * setTabBar* 在非 tabBar 页是否真正生效各机型不一致，失败还不抛错，
 * 所以这里只记一笔，交给最近进入的 tabBar 页在 onShow 里强制应用一次，
 * 用完即清 —— 不额外存主题值，真源仍然只有 storage 里那一个键。
 */
var _pendingTabChrome = false;

function isValidId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(THEMES, id);
}

/** 同步返回当前主题 id；脏数据一律回落 standard，且不写回存储（保持纯读语义）。 */
function getThemeId() {
    if (_cache !== null) return _cache;
    var raw = '';
    try {
        raw = wx.getStorageSync(KEY);
    } catch (e) {
        raw = '';
    }
    if (isValidId(raw)) {
        _cache = raw;
    } else {
        // 不删脏值，留痕便于排查；界面靠返回值回落，不靠存储
        if (raw) console.warn('[theme] 非法主题 id，已回落到 standard：', raw);
        _cache = DEFAULT_ID;
    }
    return _cache;
}

/** 写缓存 + 同步落盘。返回 {data} 或 {error, data}：error 时界面已生效，只是没存上。 */
function setThemeId(id) {
    if (!isValidId(id)) return { error: 'INVALID_THEME' };
    _cache = id;
    // 换肤入口可能不在 tabBar 页：给下一个进 tabBar 页的时机留一次强制重刷
    _pendingTabChrome = true;
    try {
        wx.setStorageSync(KEY, id);
        return { data: id };
    } catch (e) {
        return { error: 'CLIENT_EXCEPTION', data: id };
    }
}

/** 读取并清空「有待补刷」。tabBar 页 onShow 用：applyTheme(null, takePendingTabChrome())。 */
function takePendingTabChrome() {
    var v = _pendingTabChrome;
    _pendingTabChrome = false;
    return v;
}

/**
 * 在 mock 环境或非 tabBar 页里，这些原生 API 可能整个不存在（Node 冒烟测试就是这样）。
 * 逐个探测再调，缺了就当没有这一步，绝不让"换肤"把页面初始化带崩。
 */
function callApi(name, arg) {
    try {
        if (typeof wx !== 'undefined' && wx && typeof wx[name] === 'function') {
            wx[name](arg);
            return true;
        }
    } catch (e) {
        // 非 tabBar 页调 setTabBarXxx 会 throw / fail，静默即可
    }
    return false;
}

/** 色值层：纯参数下发、无 IO，调用 4 次也没有代价，所以永不合并、立即执行。 */
function applyColorChrome(t) {
    // 关掉过渡动画：默认 300ms 的"浅→深"渐变很显眼，设 0 后是一帧跳变
    callApi('setNavigationBarColor', {
        frontColor: t.nav.frontColor,
        backgroundColor: t.nav.backgroundColor,
        animation: { duration: 0, timingFunc: 'linear' },
    });
    callApi('setBackgroundColor', {
        backgroundColor: t.window.backgroundColor,
        backgroundColorTop: t.window.backgroundColor,
        backgroundColorBottom: t.window.backgroundColor,
    });
    callApi('setTabBarStyle', {
        color: t.tab.color,
        selectedColor: t.tab.selectedColor,
        backgroundColor: t.tab.backgroundColor,
        borderStyle: t.tab.borderStyle,
    });
}

/** 图标层：要读 PNG，这才是会排队的东西，且此刻 tabBar 被浮层盖住，晚 60ms 没人看得见。 */
function scheduleIconChrome(t) {
    if (_chromeTimer) clearTimeout(_chromeTimer);
    _chromeTimer = setTimeout(function () {
        _chromeTimer = null;
        t.tab.icon.forEach(function (pair, i) {
            callApi('setTabBarItem', {
                index: i,
                iconPath: pair[0],
                selectedIconPath: pair[1],
                fail: function (err) {
                    console.warn('[theme] tabBar 图标切换失败 idx=' + i, err);
                },
            });
        });
    }, 60);
}

/**
 * 应用原生层（导航栏 / 窗口底色 / tabBar 图标）。
 * 幂等：同一 id 重复调用直接返回；force = true 时强制重刷。
 *
 * 分两层，不能合成一个 debounce：冷启动那次如果被 60ms 窗口推迟，
 * 导航栏会先按 app.json 的静态值渲染一帧再跳色 —— 那正是要消除的闪烁。
 */
function applySystemChrome(id, force) {
    var next = isValidId(id) ? id : DEFAULT_ID;
    if (!force && _applied === next) return;
    _applied = next;

    var t = THEMES[next];
    applyColorChrome(t);   // 立即
    scheduleIconChrome(t); // 60ms 合并
}

/** 根 view 的 class 片段。绝大多数页面直接写 class="theme-root theme-{{theme}}" 即可，此函数备用。 */
function themeClass(id) {
    return 'theme-root theme-' + (isValidId(id) ? id : getThemeId());
}

/** 供设置面板 wx:for 用。静态数据，只在 onLoad 取一次。 */
function list() {
    return ORDER.map(function (id) {
        return { id: id, name: THEMES[id].name, mood: THEMES[id].mood };
    });
}

module.exports = {
    THEMES: THEMES,
    ORDER: ORDER,
    DEFAULT_ID: DEFAULT_ID,
    isValidId: isValidId,
    getThemeId: getThemeId,
    setThemeId: setThemeId,
    takePendingTabChrome: takePendingTabChrome,
    applySystemChrome: applySystemChrome,
    themeClass: themeClass,
    list: list,
};
