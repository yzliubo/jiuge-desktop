'use strict';
/**
 * 应用菜单与快捷键（架构 §2.4 / Q7 最小集）。
 *
 * 所有项只发 `menu:action` 推送（action 值：save / page:1~5 / export / import / settings /
 * theme:<id> / open-data-dir），不改变任何业务逻辑；desktop-features.js 把 action 映射到既有页面方法。
 * 「退出」不直接用 role:'quit'，而是 win.close()，以便完整走 §6.2 的 flush 链路。
 */
function getElectron() {
  try {
    return require('electron');
  } catch (e) {
    return null;
  }
}

const PAGE_ACCELERATORS = ['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4', 'CmdOrCtrl+5'];
const PAGE_LABELS = ['今日', '回看', '胶囊', '坚持', '设置'];
const THEME_LABELS = [
  { id: 'standard', label: '标准版 · 森绿米白' },
  { id: 'tech', label: '科技蓝 · 冷调夜航' },
  { id: 'girl', label: '少女版 · 樱花奶油' },
  { id: 'kids', label: '儿童版 · 糖果积木' },
];

/**
 * @param {Function} send 发送 menu:action，签名 send(action:string)
 * @param {Function} getWindow 返回当前 BrowserWindow（供退出项触发 close 拦截）
 * @returns {object|null} Electron Menu，非 Electron 环境返回 null
 */
function buildMenu(send, getWindow) {
  const electron = getElectron();
  if (!electron || !electron.Menu) return null;
  const emit = typeof send === 'function' ? send : function () {};
  const winOf = typeof getWindow === 'function' ? getWindow : function () { return null; };

  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导入小程序备份文件（v6/v7）',
          accelerator: 'CmdOrCtrl+I',
          click: function () { emit('import'); },
        },
        {
          label: '导出为文件…',
          accelerator: 'CmdOrCtrl+E',
          click: function () { emit('export'); },
        },
        // 三种另存格式的菜单标签逐字复用设置页源码文案，不新造中文字符串
        {
          label: '导出可读文本',
          click: function () { emit('export:text'); },
        },
        {
          label: '导出 Markdown',
          click: function () { emit('export:markdown'); },
        },
        {
          label: '导出 JSON 备份',
          click: function () { emit('export:backup'); },
        },
        {
          label: '打开数据目录',
          click: function () { emit('open-data-dir'); },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: function () {
            const win = winOf();
            if (win && !win.isDestroyed()) win.close();
          },
        },
      ],
    },
    {
      label: '视图',
      submenu: PAGE_LABELS.map(function (label, i) {
        return {
          label: label,
          accelerator: PAGE_ACCELERATORS[i],
          click: function () { emit('page:' + (i + 1)); },
        };
      }).concat([
        { type: 'separator' },
        {
          label: '保存当前格',
          accelerator: 'CmdOrCtrl+S',
          click: function () { emit('save'); },
        },
        { type: 'separator' },
        {
          label: '界面皮肤',
          submenu: THEME_LABELS.map(function (t) {
            return {
              label: t.label,
              click: function () { emit('theme:' + t.id); },
            };
          }),
        },
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: function () { emit('settings'); },
        },
      ]),
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '使用小贴士',
          click: function () { emit('settings'); },
        },
        { type: 'separator' },
        {
          label: '关于九格手记',
          click: function () { emit('settings'); },
        },
      ],
    },
  ];

  const menu = electron.Menu.buildFromTemplate(template);
  if (electron.Menu.setApplicationMenu) electron.Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = {
  buildMenu: buildMenu,
  PAGE_ACCELERATORS: PAGE_ACCELERATORS,
  PAGE_LABELS: PAGE_LABELS,
  THEME_LABELS: THEME_LABELS,
};
