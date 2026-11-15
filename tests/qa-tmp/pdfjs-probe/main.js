'use strict';
const path = require('path');
const { app, BrowserWindow } = require('electron');
app.whenReady().then(function () {
  const win = new BrowserWindow({
    width: 1000, height: 900,
    webPreferences: {
      nodeIntegration: true, contextIsolation: false, webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile(path.join(__dirname, 'probe.html'));
});
