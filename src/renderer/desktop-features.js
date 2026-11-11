'use strict';
/**
 * 桌面增量能力（架构 §6.1 / T1-A6 / T4-D4~D6）。
 *
 *  - 文件导入：原生打开对话框 → BOM 容错文本 → 确认框 → **store.importBackup(text)**
 *    （与源码「从剪贴板导入」调用的是同一个函数，桌面层绝不另写合并/去重/版本分支）；
 *  - 三种导出另存：内容与 exportText / exportMarkdown / exportBackup 逐字一致，
 *    默认名 九格手记-备份-YYYY-MM-DD.json/.md/.txt 由主进程 file-io.js 生成；
 *  - 剪贴板导出入口**原样保留**（settings.js 源码已实现，本文件不重复、不改写文案）；
 *  - 打开数据目录（只读）、菜单动作映射、P1 导入结果面板。
 *
 * 文案纪律：确认框 / 成功 / 失败提示逐字取自 settings.js 实参；
 * 仅「导入小程序备份文件（v6/v7）」入口文案、文件读取错误提示、P1 结果面板为本次新增。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.JiugeDesktopFeatures = api;
})(typeof window !== 'undefined' ? window : globalThis, function (G) {
  'use strict';

  var J = G.__jiuge || {};
  var store = J.store;

  function toast(title) {
    if (G.wx && typeof G.wx.showToast === 'function') {
      G.wx.showToast({ title: title, icon: 'none', duration: 2200 });
    }
  }

  function refreshSettings() {
    var rt = G.JiugeRuntime;
    var sp = rt ? rt.byId('settings') : null;
    if (sp && typeof sp.refresh === 'function') {
      try { sp.refresh(); } catch (e) { console.error('[设置页刷新异常] ' + e.message); }
    }
  }

  function forceFlush() {
    try {
      if (J.kv && typeof J.kv.flush === 'function') return J.kv.flush();
    } catch (e) {
      console.error('[kv:flush 异常] ' + e.message);
    }
    return { ok: false, error: 'CLIENT_EXCEPTION' };
  }

  /**
   * 【新增】导入小程序备份文件（v6/v7）。
   * 与剪贴板导入共用唯一的 store.importBackup(text)，确认框文案逐字取自 settings.js:195-213。
   */
  function importFromFile() {
    if (!J.dialog || typeof J.dialog.openBackup !== 'function' || !store) {
      toast('文件对话框不可用');
      return Promise.resolve({ ok: false, error: 'CLIENT_EXCEPTION' });
    }
    return J.dialog.openBackup().then(function (res) {
      // 用户取消：不写任何数据、不提示错误
      if (!res || res.canceled) return { ok: false, canceled: true };
      if (res.error) { toast(res.error); return { ok: false, error: res.error }; }

      var text = String(res.text === undefined || res.text === null ? '' : res.text);
      var parsed = null;
      try { parsed = JSON.parse(text); }
      catch (e) {
        toast('剪贴板内容不是有效的备份 JSON');
        return { ok: false, error: 'INVALID_JSON' };
      }
      var records = parsed && parsed.records;
      if (!records || !Array.isArray(records)) {
        toast('未识别到备份数据');
        return { ok: false, error: 'INVALID_FORMAT' };
      }

      return new Promise(function (resolve) {
        G.wx.showModal({
          title: '导入备份',
          content: '检测到 ' + records.length + ' 篇日记。导入只补写本机没有的日期，不会覆盖已有记录。',
          confirmText: '开始导入',
          success: function (m) {
            if (!m.confirm) { resolve({ ok: false, canceled: true }); return; }
            // 唯一合并实现：剪贴板导入（settings.js:201）与文件导入共用同一个函数引用
            var r = store.importBackup(text);
            if (r.error) { toast('导入失败：' + r.error); resolve({ ok: false, error: r.error }); return; }
            forceFlush();
            refreshSettings();
            var d = r.data;
            if (d.partial) toast('导入' + d.imported + '篇（旧版，跳过' + d.skipped + '篇）');
            else toast('导入 ' + d.imported + ' 篇，跳过 ' + d.skipped + ' 篇');
            showResultPanel(d);
            resolve({ ok: true, data: d });
          },
        });
      });
    }).catch(function (e) {
      toast('读取文件失败：' + String(e && e.message || e));
      return { ok: false, error: 'CLIENT_EXCEPTION' };
    });
  }

  /** P1 结果面板：只展示 importBackup 返回结构里的既有字段，不改一个字段。 */
  function showResultPanel(d) {
    var ui = G.JiugeUiFeedback;
    if (!ui || typeof ui.resultPanel !== 'function' || !d) return;
    ui.resultPanel([
      ['导入篇数', String(d.imported)],
      ['跳过篇数', String(d.skipped)],
      ['胶囊', String(d.capsulesImported)],
      ['学习库', String(d.studyImported)],
      ['配置项', String(d.configImported)],
      ['空壳', String(d.emptyShell)],
      ['来源版本', String(d.sourceVersion)],
      ['旧版备份', d.partial ? '是（只导入了可识别部分）' : '否'],
    ]);
  }

  var EXPORT_META = {
    text: { fn: 'exportText', empty: '还没有日记可导出' },
    markdown: { fn: 'exportMarkdown', empty: '还没有日记可导出' },
    backup: { fn: 'exportBackup', empty: '还没有日记可备份' },
  };

  /** 三种导出另存为文件；剪贴板导出入口由设置页源码原样保留，本文件不重复实现。 */
  function exportToFile(kind) {
    var meta = EXPORT_META[kind] || EXPORT_META.backup;
    var target = EXPORT_META[kind] ? kind : 'backup';
    if (!store || !J.dialog || typeof J.dialog.saveExport !== 'function') {
      toast('文件对话框不可用');
      return Promise.resolve({ ok: false, error: 'CLIENT_EXCEPTION' });
    }
    var dates = store.writtenDates ? store.writtenDates() : [];
    if (!dates.length) { toast(meta.empty); return Promise.resolve({ ok: false, error: 'EMPTY' }); }
    forceFlush(); // 导出前强制落盘，保证文件包含刚写的格子
    var r = store[meta.fn]();
    if (r.error) { toast('导出失败：' + r.error); return Promise.resolve({ ok: false, error: r.error }); }
    return J.dialog.saveExport({ kind: target, text: r.data }).then(function (res) {
      if (!res || res.canceled) return { ok: false, canceled: true };
      if (res.error) { toast(res.error); return { ok: false, error: res.error }; }
      // 保存对话框本身已是明确反馈，不新增任何产品文案
      return { ok: true, path: res.path };
    }).catch(function (e) {
      toast('写入文件失败：' + String(e && e.message || e));
      return { ok: false, error: 'CLIENT_EXCEPTION' };
    });
  }

  /** 【P1】打开数据目录（只读入口，不提供路径自定义）。 */
  function openDataDir() {
    if (!J.dialog || typeof J.dialog.openDataDir !== 'function') return Promise.resolve({ ok: false });
    return J.dialog.openDataDir().then(function (res) {
      if (res && res.error) toast(res.error);
      return res || { ok: false };
    }).catch(function (e) {
      toast('打开数据目录失败：' + String(e && e.message || e));
      return { ok: false, error: 'CLIENT_EXCEPTION' };
    });
  }

  /** 菜单 / 快捷键动作（nav.js 已消费 page:* / settings / theme:* / save）。 */
  function onMenuAction(action) {
    var a = String(action || '');
    if (a === 'import') return importFromFile();
    // Ctrl+E 默认另存 JSON 备份；菜单里另三项走同一 saveExport 通道的其它格式
    if (a === 'export') return exportToFile('backup');
    if (a.indexOf('export:') === 0) {
      var kind = a.slice('export:'.length);
      if (EXPORT_META[kind]) return exportToFile(kind);
    }
    if (a === 'open-data-dir') return openDataDir();
    return Promise.resolve({ ok: false, ignored: a });
  }

  function clipboardExport(kind) {
    // 剪贴板导出入口由 settings.js 源码原样实现，这里只做等价转调，不重复写文案
    var meta = EXPORT_META[kind] || EXPORT_META.backup;
    if (!store) return { ok: false, error: 'CLIENT_EXCEPTION' };
    var r = store[meta.fn]();
    if (r.error) return r;
    if (G.wx && typeof G.wx.setClipboardData === 'function') {
      G.wx.setClipboardData({ data: r.data });
    }
    return r;
  }

  return {
    importFromFile: importFromFile,
    exportToFile: exportToFile,
    clipboardExport: clipboardExport,
    openDataDir: openDataDir,
    onMenuAction: onMenuAction,
    forceFlush: forceFlush,
    showResultPanel: showResultPanel,
    EXPORT_META: EXPORT_META,
  };
});
