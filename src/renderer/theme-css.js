'use strict';
/**
 * CSS 变量整体换肤（架构 §1.6 / §6.3 / §9.4）。
 *
 *  - 读 __jiuge.theme.getThemeId()（脏值回落 standard 且**不写回**，复用 theme.js 的纯读语义）；
 *  - 给 <html> 挂 .theme-root .theme-standard|tech|girl|kids，标题栏 / 侧边栏 / 主区一起变色；
 *  - --c-switch = THEMES[id].switchColor（逐字照搬 theme.js 的四套色值，桌面唯一新增令牌）；
 *  - 换肤广播复用源码 getCurrentPages().forEach(p => p.applyTheme(id, true))，不新增事件总线。
 *
 * 不使用主进程原生标题栏叠层，因此 theme:changed（A6）默认不调用。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeThemeCss = api;
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  'use strict';

  var J = G.__jiuge || {};

  // 逐字照搬 utils/theme.js 的 THEMES（nav.backgroundColor / window.backgroundColor / tab.* / switchColor）
  // 仅用于 contextBridge 代理不可用时的兜底，绝不另行配色。
  var THEME_COLORS = {
    standard: {
      navBg: '#F6F8F3', windowBg: '#F6F8F3',
      tabColor: '#5C7265', selectedColor: '#2F7357', tabBg: '#FFFFFF',
      switchColor: '#2F7357',
    },
    tech: {
      navBg: '#0B1729', windowBg: '#EEF3FB',
      tabColor: '#556C86', selectedColor: '#1B62D6', tabBg: '#F7FAFE',
      switchColor: '#1B62D6',
    },
    girl: {
      navBg: '#FFF6F8', windowBg: '#FDF6F4',
      tabColor: '#7A5A64', selectedColor: '#C9416F', tabBg: '#FFFFFF',
      switchColor: '#C9416F',
    },
    kids: {
      navBg: '#FFC22E', windowBg: '#FFFCF2',
      tabColor: '#5A7180', selectedColor: '#1578B8', tabBg: '#FFFFFF',
      switchColor: '#1578B8',
    },
  };

  var DEFAULT_ID = 'standard';

  function isValid(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(THEME_COLORS, id);
  }

  /** 读当前主题 id：优先用 theme.getThemeId()（脏值已在源码内回落且不写回）。 */
  function currentId() {
    var id = '';
    try {
      if (J.theme && typeof J.theme.getThemeId === 'function') id = J.theme.getThemeId();
    } catch (e) {
      id = '';
    }
    return isValid(id) ? id : DEFAULT_ID;
  }

  function switchColorOf(id) {
    try {
      if (J.theme && J.theme.THEMES && J.theme.THEMES[id]) {
        var c = J.theme.THEMES[id].switchColor;
        if (typeof c === 'string' && c) return c;
      }
    } catch (e) { /* 回落本地照搬值 */ }
    return THEME_COLORS[id].switchColor;
  }

  /**
   * 应用主题到 <html>。
   * @param {string} [id] 省略时读 theme.getThemeId()（脏值回落 standard，不写回 skin_theme）
   */
  function apply(id) {
    var next = isValid(id) ? id : currentId();
    if (typeof document !== 'undefined' && document.documentElement) {
      var html = document.documentElement;
      html.className = 'theme-root theme-' + next;
      html.style.setProperty('--c-switch', switchColorOf(next));
      var colors = THEME_COLORS[next];
      html.style.setProperty('--shell-nav-bg', colors.navBg);
      html.style.setProperty('--shell-window-bg', colors.windowBg);
      html.style.setProperty('--shell-tab-color', colors.tabColor);
      html.style.setProperty('--shell-tab-selected', colors.selectedColor);
      html.style.setProperty('--shell-tab-bg', colors.tabBg);
    }
    return next;
  }

  /**
   * 主动换肤（菜单 / 快捷键入口）：落盘 → 应用 → 广播给 5 个常驻 Page 实例。
   * 失败文案逐字取自 settings.js:108，不润色。
   */
  function change(id) {
    if (!isValid(id)) return { ok: false, error: 'INVALID_THEME' };
    var r = { error: 'CLIENT_EXCEPTION' };
    try {
      if (J.theme && typeof J.theme.setThemeId === 'function') r = J.theme.setThemeId(id);
    } catch (e) {
      r = { error: 'CLIENT_EXCEPTION' };
    }
    var applied = apply(id);
    var pages = typeof G.getCurrentPages === 'function' ? G.getCurrentPages() : [];
    pages.forEach(function (p) {
      if (p && typeof p.applyTheme === 'function') {
        try { p.applyTheme(applied, true); } catch (e) { console.error('[换肤广播异常] ' + e.message); }
      }
    });
    if (r && r.error && G.wx && typeof G.wx.showToast === 'function') {
      G.wx.showToast({ title: '换肤生效了，但这次没存上，下次打开会回到原来的主题', icon: 'none', duration: 2200 });
    }
    return { ok: !(r && r.error), id: applied, error: r && r.error ? r.error : null };
  }

  /** 供验收脚本对拍：四套主题的完整色值表。 */
  function cssVars() {
    var out = {};
    Object.keys(THEME_COLORS).forEach(function (id) { out[id] = Object.assign({}, THEME_COLORS[id]); });
    return out;
  }

  return {
    apply: apply,
    change: change,
    currentId: currentId,
    cssVars: cssVars,
    isValid: isValid,
    THEME_COLORS: THEME_COLORS,
    DEFAULT_ID: DEFAULT_ID,
  };
});
