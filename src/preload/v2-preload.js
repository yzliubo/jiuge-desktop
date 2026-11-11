'use strict';
// 薄桥：只暴露白名单 typed 方法，不注入 global.wx、不 require 任何业务模块。
// 渲染层没有任何裸 KV 通道可绕过主进程。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = [
  'v1/diaries:list',
  'v1/diaries:getBatch',
  'v1/diaries:upsert',
  'v1/config:getMany',
  'v1/config:setMany',
  'v1/app:flush',
  'v1/system:lockState',
  'v1/health:check',
  'v1/health:backup',
  'v1/domain:call',
  'v1/file:save',
  'v1/file:pick',
  'v1/reader:open',
  // 独立账本窗口：与阅读窗同一 preload，开窗只是一条白名单通道
  'v1/finance:open',
  'v1/worktime:sync',
  // 首页天气：两条会发远程 HTTP 的通道（取天气 / 手填城市检索）。
  // 渲染层只说「取今天的天气」，域名、超时、body 上限全在主进程的 weather/client.js。
  'v1/weather:sync',
  'v1/weather:geocode'
];

contextBridge.exposeInMainWorld('jiugeBridge', {
  invoke: function (channel, payload) {
    if (CHANNELS.indexOf(channel) < 0) {
      return Promise.resolve({
        code: 'CLIENT_EXCEPTION',
        message: '通道不在白名单: ' + channel,
        data: null
      });
    }
    return ipcRenderer.invoke(channel, payload || {});
  },
  // 拖放进来的 File 只有 preload 能拿到真实磁盘路径；渲染层只见字符串
  pathForFile: function (file) {
    try {
      if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
    } catch (e) { /* 老版本 Electron 退回 File.path */ }
    return file && file.path ? file.path : '';
  },
  onDataChanged: function (callback) {
    const listener = function (_event, data) { callback(data); };
    ipcRenderer.on('v1/data:changed', listener);
    return function () { ipcRenderer.removeListener('v1/data:changed', listener); };
  }
});
