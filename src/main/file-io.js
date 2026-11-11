'use strict';
/**
 * 文件 I/O 全部在主进程：渲染进程不碰 fs / dialog（架构 §2.1、硬约束 7）。
 *
 *  - 导入：dialog.showOpenDialog 单选 → UTF-8 BOM 容错读取 → **原样回传文本**，桌面层不预解析；
 *  - 导入前快照：读取成功即由主进程写 store.pre-import-*.json（唯一破坏性操作前的安全网）；
 *  - 导出：dialog.showSaveDialog + 主进程 writeFileSync，默认文档目录 + 九格手记-备份-YYYY-MM-DD.*；
 *  - 打开数据目录：shell.showItemInFolder(store.json)，只读入口，不提供路径自定义。
 *
 * electron 相关对象惰性获取，使 tools/*.js 可在纯 Node 下 require 本模块做纯函数测试。
 */
const fs = require('fs');
const path = require('path');
const { formatDate, stripBom } = require('./kv-store.js');

const EXPORT_META = {
  text: { ext: '.txt', name: '可读文本', exts: ['txt'] },
  markdown: { ext: '.md', name: 'Markdown', exts: ['md', 'markdown'] },
  backup: { ext: '.json', name: 'JSON 备份', exts: ['json'] },
};

function getElectron() {
  try {
    return require('electron');
  } catch (e) {
    return null;
  }
}

function documentsDir() {
  const electron = getElectron();
  if (electron && electron.app && typeof electron.app.getPath === 'function') {
    try { return electron.app.getPath('documents'); } catch (e) { /* 继续回落 */ }
    try { return electron.app.getPath('home'); } catch (e) { /* 继续回落 */ }
  }
  return process.cwd();
}

/** 导出默认名：九格手记-备份-YYYY-MM-DD.json / .md / .txt（架构 §9.3、PRD Q5）。 */
function defaultExportName(kind, date) {
  const meta = EXPORT_META[kind] || EXPORT_META.text;
  return '九格手记-备份-' + formatDate(date || new Date()) + meta.ext;
}

/** 去 UTF-8 BOM 的 buffer 读取，返回原样文本。 */
function readTextTolerantBom(filePath) {
  const buf = fs.readFileSync(filePath);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return stripBom((hasBom ? buf.slice(3) : buf).toString('utf8'));
}

class FileIo {
  /**
   * @param {string} dataDir KV 数据目录
   * @param {object} kvStore KvStore 实例（用于导入前快照）
   */
  constructor(dataDir, kvStore) {
    this.dataDir = String(dataDir || '');
    this.kvStore = kvStore;
  }

  /** A1 file:openBackup —— 选择器 → BOM 容错读取 → 导入前快照 → 原样文本。 */
  async openBackup(win) {
    const electron = getElectron();
    if (!electron || !electron.dialog) {
      return { canceled: false, error: '文件对话框不可用：当前不是 Electron 主进程环境' };
    }
    let picked;
    try {
      picked = await electron.dialog.showOpenDialog(win, {
        title: '选择小程序备份文件',
        properties: ['openFile'],
        filters: [
          { name: '备份文件', extensions: ['json', 'txt'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
    } catch (e) {
      return { canceled: false, error: '打开文件对话框失败：' + String(e && e.message || e) };
    }
    if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths.length) {
      // 用户取消：不写任何数据、不提示错误
      return { canceled: true };
    }
    const filePath = picked.filePaths[0];
    let text = '';
    try {
      text = readTextTolerantBom(filePath);
    } catch (e) {
      // 读失败给明确错误，不静默
      return { canceled: false, error: '读取文件失败：' + String(e && e.message || e) };
    }
    // 唯一破坏性操作（导入）之前的安全网；不提供 UI 回滚入口，但文件在「打开数据目录」里可见
    let snapshot = { ok: true, path: '' };
    if (this.kvStore && typeof this.kvStore.snapshotBeforeImport === 'function') {
      snapshot = this.kvStore.snapshotBeforeImport();
    }
    return {
      canceled: false,
      text: text,
      path: filePath,
      snapshotPath: snapshot.path || '',
      snapshotError: snapshot.ok ? '' : (snapshot.error || ''),
    };
  }

  /** A2 file:saveExport —— 另存为文件，内容与 exportText/exportMarkdown/exportBackup 逐字一致。 */
  async saveExport(win, req) {
    const electron = getElectron();
    if (!electron || !electron.dialog) {
      return { canceled: false, error: '文件对话框不可用：当前不是 Electron 主进程环境' };
    }
    const request = req || {};
    const kind = EXPORT_META[request.kind] ? request.kind : 'text';
    const meta = EXPORT_META[kind];
    const name = request.defaultName || defaultExportName(kind, new Date());
    let picked;
    try {
      picked = await electron.dialog.showSaveDialog(win, {
        title: '导出为文件',
        defaultPath: path.join(documentsDir(), name),
        filters: [
          { name: meta.name, extensions: meta.exts },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
    } catch (e) {
      return { canceled: false, error: '打开保存对话框失败：' + String(e && e.message || e) };
    }
    if (!picked || picked.canceled || !picked.filePath) return { canceled: true };
    try {
      fs.writeFileSync(picked.filePath, String(request.text === undefined ? '' : request.text), 'utf8');
      return { canceled: false, path: picked.filePath };
    } catch (e) {
      return { canceled: false, error: '写入文件失败：' + String(e && e.message || e) };
    }
  }

  /** A3 file:openDataDir —— 只读入口，打开到 store.json 所在位置。 */
  openDataDir() {
    const electron = getElectron();
    if (!electron || !electron.shell || typeof electron.shell.showItemInFolder !== 'function') {
      return { ok: false, error: '无法打开数据目录：当前不是 Electron 主进程环境' };
    }
    const target = path.join(this.dataDir, 'store.json');
    try {
      electron.shell.showItemInFolder(fs.existsSync(target) ? target : this.dataDir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '打开数据目录失败：' + String(e && e.message || e) };
    }
  }
}

module.exports = {
  FileIo: FileIo,
  defaultExportName: defaultExportName,
  documentsDir: documentsDir,
  readTextTolerantBom: readTextTolerantBom,
  EXPORT_META: EXPORT_META,
};
