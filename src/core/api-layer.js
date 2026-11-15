'use strict';
// B 架构 M1：本地 API 层（v1 路由 / 统一响应 / 幂等 / 分页）
// 全部异步 invoke/handle，彻底移除 sendSync；渲染层没有任何裸 KV 通道可绕过主进程。
// 对应 03 技术方案 §6 API 清单、04-质量保障方案 §2 门禁
const contract = require('./contract');

const DIARY_KEY_RE = /^morning_diary_(\d{4}-\d{2}-\d{2})$/;

function createApiLayer(opts) {
  const repo = opts.repository;
  const lifecycle = opts.lifecycle;
  const domain = opts.domain || null;
  const seen = new Map();
  const routes = {};

  function route(name, handler) { routes[name] = handler; }

  function wrap(result) {
    if (result && typeof result.code === 'string') return result;
    return contract.ok(result);
  }

  // 分页列表：一次往返返回组装结果，替代上一版「keys() 再逐篇 get」的 O(N) 同步 IPC
  route('v1/diaries:list', function (p) {
    const q = p || {};
    if (domain) {
      const dates = domain.listDates();
      if (dates.error) return contract.fail(dates.error);
      const page = contract.paginate(dates.data, q.cursor, q.pageSize);
      const all = domain.all();
      const byDate = {};
      (all.data || []).forEach(function (rec) { byDate[rec.date] = rec; });
      return contract.ok({
        items: page.items.map(function (d) { return byDate[d]; }).filter(Boolean),
        cursor: page.cursor,
        total: page.total
      });
    }
    const keys = repo.keys().filter(function (k) { return DIARY_KEY_RE.test(k); }).sort().reverse();
    const page = contract.paginate(keys, q.cursor, q.pageSize);
    return contract.ok({
      items: page.items.map(function (k) { return repo.get(k); }),
      cursor: page.cursor,
      total: page.total
    });
  });

  route('v1/diaries:getBatch', function (p) {
    const dates = (p && Array.isArray(p.dates)) ? p.dates : [];
    return contract.ok({
      records: repo.getBatch(dates.map(function (d) { return 'morning_diary_' + d; }))
    });
  });

  route('v1/diaries:upsert', function (p) {
    const q = p || {};
    if (!q.record || !q.record.date) return contract.fail('INVALID_FORMAT', '缺少 record.date');
    const t0 = Date.now();
    const requestId = q.requestId ? String(q.requestId) : '';
    if (requestId && seen.has(requestId)) return seen.get(requestId);
    const key = 'morning_diary_' + q.record.date;
    let payload;
    if (domain) {
      // 走 diary-store.save()：保留 2000/200 裁剪、配置语义、normalize 等业务算法
      const saved = domain.save(q.record);
      if (saved.error) return contract.fail(saved.error);
      payload = contract.ok({
        record: saved.data,
        revision: repo.revision,
        changedKeys: [key],
        fsync: true
      });
    } else {
      const res = repo.set(key, q.record, { requestId: q.requestId });
      payload = contract.ok({
        record: repo.get(key),
        revision: res.revision,
        changedKeys: res.changedKeys,
        fsync: res.fsync
      });
    }
    if (requestId) seen.set(requestId, payload);
    // 使用度量（R-11）：只记「哪一天保存 + 耗时」，不记任何正文。
    // 这段耗时含 journal 的 writeSync + fsyncSync，正是用户感知的那一段。
    try {
      if (typeof opts.metricsRecord === 'function') {
        opts.metricsRecord('entry_save', {
          ts: new Date().toISOString(),
          date: String(q.record.date),
          ms: Date.now() - t0
        });
      }
    } catch (e) { /* 度量失败绝不影响保存 */ }
    return payload;
  });

  route('v1/config:getMany', function (p) {
    const keys = (p && Array.isArray(p.keys)) ? p.keys : [];
    return contract.ok({ values: repo.getBatch(keys) });
  });

  route('v1/config:setMany', function (p) {
    const q = p || {};
    const patch = q.patch && typeof q.patch === 'object' ? q.patch : {};
    const changedKeys = [];
    let revision = repo.revision;
    Object.keys(patch).forEach(function (key, i) {
      const res = repo.set(key, patch[key], { requestId: q.requestId ? q.requestId + ':' + i : undefined });
      revision = res.revision;
      changedKeys.push(key);
    });
    return contract.ok({ revision: revision, changedKeys: changedKeys });
  });

  route('v1/app:flush', function (p) {
    return contract.ok(lifecycle.flush(p && p.reason));
  });

  route('v1/system:lockState', function () {
    return contract.ok({ revision: repo.revision, dirty: repo.isDirty(), keys: repo.keys().length });
  });

  // 数据健康中心：把 persistence 里早已实现、却从未被调用过的能力翻译成用户看得懂的状态
  route('v1/health:check', function () {
    if (!opts.healthChecker) return contract.fail('CLIENT_EXCEPTION', '未提供健康检查器');
    try {
      return contract.ok(opts.healthChecker());
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // 手动触发一次快照（数据中心「立即备份」按钮走这里，与定时备份同一实现）
  route('v1/health:backup', function () {
    if (!opts.backupRunner) return contract.fail('CLIENT_EXCEPTION', '未提供备份器');
    try {
      return contract.ok(opts.backupRunner('manual'));
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  function handle(channel, payload) {
    const fn = routes[channel];
    if (!fn) return contract.fail('CLIENT_EXCEPTION', '未知通道: ' + channel);
    try {
      const out = fn(payload);
      // 本机时间源要发一次 HTTP，天然异步；其余路由仍走同步返回，行为不变。
      // 只在这里放行 Promise，渲染层拿到的仍是同一个统一响应结构。
      if (out && typeof out.then === 'function') {
        return out.then(wrap, function (e) {
          return contract.fail((e && e.code) || 'CLIENT_EXCEPTION', (e && e.message) || String(e));
        });
      }
      return wrap(out);
    } catch (e) {
      return contract.fail(e.code || 'CLIENT_EXCEPTION', e.message);
    }
  }

  // Electron 接线：ipcMain.handle 全异步，preload 只暴露白名单 typed 方法
  function register(ipcMain, prefix) {
    const names = Object.keys(routes);
    names.forEach(function (name) {
      ipcMain.handle((prefix || '') + name, function (_event, payload) {
        return handle(name, payload);
      });
    });
    return names;
  }

  route('v1/file:save', function (p) {
    const q = p || {};
    if (!opts.fileSaver) return contract.fail('CLIENT_EXCEPTION', '未提供文件保存器');
    try {
      return contract.ok(opts.fileSaver(String(q.name || 'export.txt'), String(q.text || '')));
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // 本地电子书 / 梦想图片选择：只返回路径字符串，渲染层拿不到文件内容，也不存在裸 KV 通道
  route('v1/file:pick', function (p) {
    if (!opts.filePicker) return contract.fail('CLIENT_EXCEPTION', '未提供文件选择器');
    try {
      return contract.ok(opts.filePicker(p || {}));
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // 独立阅读窗口：渲染层只传 bookId，窗口由主进程创建与复用
  route('v1/reader:open', function (p) {
    if (!opts.readerOpener) return contract.fail('CLIENT_EXCEPTION', '未提供阅读窗口');
    try {
      return contract.ok(opts.readerOpener(p || {}));
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // 独立账本窗口：与阅读窗同一形态，渲染层只说「开账本」，窗口由主进程创建与复用
  route('v1/finance:open', function () {
    if (!opts.financeOpener) return contract.fail('CLIENT_EXCEPTION', '未提供账本窗口');
    try {
      return contract.ok(opts.financeOpener());
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // 独立图书馆窗口（V3.14）：同上。书架搬出主窗是因为左侧要挂一棵文件夹树，
  // 主窗中栏放不下；开窗仍是主进程的事，渲染层只说「开图书馆」。
  route('v1/library:open', function () {
    if (!opts.libraryOpener) return contract.fail('CLIENT_EXCEPTION', '未提供图书馆窗口');
    try {
      return contract.ok(opts.libraryOpener());
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // 领域层白名单：8 utils 的 68 个能力以显式白名单暴露，渲染层不得越权调用
  const DOMAIN_WHITELIST = [
    'today', 'formatDate', 'emptyRecord', 'hasContent', 'load', 'listDates', 'all', 'writtenDates', 'stats',
    'milestones', 'milestoneView', 'saveMilestones', 'resetMilestones',
    'getTemplateId', 'activeTemplate', 'activeGridFields', 'fieldsFor', 'setTemplate',
    'firstWeekEnabled', 'setFirstWeekEnabled', 'modules', 'setModule', 'firstWeekState',
    'promptFor', 'previousToday', 'sameDayAcrossYears', 'search', 'weeklyReview',
    'frequentPhrases', 'moodTrend', 'reviewPeriodKey', 'reviewPrompts', 'loadReview', 'saveReview',
    // V3.10 跨期对照：只读派生，一次回看最近 6 期（含本期草稿），不写任何东西
    'review.cross',
    'yearPixels', 'randomEntry', 'exportText', 'exportMarkdown', 'exportBackup', 'importBackup',
    'capsulePresets', 'saveCapsule', 'listCapsules', 'dueCapsules', 'openCapsule', 'capsuleGroups', 'prettyDate',
    'workSummary', 'workDigest', 'workTagPool', 'moneySummary', 'moduleDigest',
    'readStudyLibrary', 'saveStudyLibrary', 'studySaveOk', 'studySummary', 'studyLibraryText',
    'quotes.size', 'quotes.dailyIndex', 'quotes.randomIndex', 'quotes.pick',
    'greetings.compose', 'greetings.periodOf', 'insights.axisOf', 'insights.analyze',
    'gtd.read', 'gtd.statusMeta', 'gtd.add', 'gtd.update', 'gtd.remove',
    'gtd.complete', 'gtd.completeAll', 'gtd.completionInfo', 'gtd.reopen', 'gtd.clarify',
    'gtd.board', 'gtd.review',
    'gtd.focus', 'gtd.focusCandidates', 'gtd.focusToggle', 'gtd.focusSet', 'gtd.focusClear',
    'gtd.markReviewed', 'gtd.projects', 'gtd.contexts', 'gtd.importLegacy',
    'gtd.projectAdd', 'gtd.projectRename', 'gtd.projectArchive', 'gtd.projectRemove',
    'gtd.contextAdd', 'gtd.contextRename', 'gtd.contextRemove',
    // 梦想（原九格「梦想」格升成的一级模块）：存 md_dream 单键
    'dream.meta', 'dream.read', 'dream.board', 'dream.add', 'dream.update', 'dream.remove',
    'dream.setTheme', 'dream.linkTask', 'dream.unlinkTask',
    'dream.setFund', 'dream.deposit',
    // 具象化图片：只搬文件名与 dataURL，图片文件由主进程读写，绝不经渲染层
    'dream.setImage', 'dream.clearImage', 'dream.image',
    // 学习成长（考试考证 / 技能学习 / 主题阅读）：三张表共一个 md_growth 键
    'growth.meta', 'growth.read', 'growth.board',
    'growth.addExam', 'growth.updateExam', 'growth.removeExam',
    'growth.addSubject', 'growth.updateSubject', 'growth.removeSubject',
    'growth.setExamResult', 'growth.setExamCauses', 'growth.retakeExam',
    'growth.addSkill', 'growth.updateSkill', 'growth.removeSkill',
    'growth.addMilestone', 'growth.toggleMilestone', 'growth.removeMilestone',
    'growth.addPractice', 'growth.removePractice',
    // V3.9 练习反馈：卡点 / 下次提高一点什么（写成长模块自己的键，不新增存储）
    'growth.setSkillBlocker', 'growth.clearSkillBlocker', 'growth.setSkillNextUp',
    'growth.addTheme', 'growth.updateTheme', 'growth.removeTheme',
    'growth.addBook', 'growth.updateBook', 'growth.removeBook',
    'growth.advanceBook', 'growth.setBookStatus', 'growth.addQuote', 'growth.removeQuote',
    'growth.importLegacy',
    // 封存箱（软删除）与内联状态提示
    'recycle.list', 'recycle.seal', 'recycle.restore', 'recycle.purge', 'recycle.empty', 'recycle.sweep',
    'cell.lastWrittenMap', 'capsule.writtenMap',
    // 语料库（名言警句 / 问候语 / 运动提示）：存 md_inspire 单键，
    // 内置条目以「引用 + 覆盖」进库，数据文件只装使用者真正改过的部分
    'inspire.meta', 'inspire.read', 'inspire.stats', 'inspire.list', 'inspire.today', 'inspire.pick',
    'inspire.add', 'inspire.update', 'inspire.remove', 'inspire.restore', 'inspire.revert',
    'inspire.toggle', 'inspire.reset',
    // V1.3 时间纵深：零新键、纯派生；unpack 是唯一写路径，且只补写不覆盖
    'v13.calendar', 'v13.todos', 'v13.random', 'v13.card',
    'v13.archiveInfo', 'v13.pack', 'v13.verifyPack', 'v13.unpack',
    // V2.0b 内容连接：搜索增强 / 内链 / 轻标签 / 重复任务 / 耗时
    'search.or', 'search.pinyin', 'search.linksAll',
    'tags.read', 'tags.add', 'tags.remove', 'tags.tag', 'tags.untag', 'tags.for', 'tags.stats',
    'recur.read', 'recur.derive', 'recur.log', 'recur.week',
    // V2.0a 关系经营（md_relation 单键，派生值不存）
    'relation.meta', 'relation.read', 'relation.list', 'relation.addContact', 'relation.updateContact',
    'relation.archiveContact', 'relation.addLog', 'relation.removeLog', 'relation.logsFor',
    'relation.temperature', 'relation.analytics',
    // V2.1 长期形状
    'term.current', 'term.meta', 'term.reviews', 'term.save',
    'trace.all', 'trace.for', 'trace.missing', 'trace.add', 'trace.remove',
    'secure.encrypt', 'secure.decrypt', 'secure.verify',
    'attach.list', 'attach.add', 'attach.remove', 'attach.refresh', 'attach.reconnect',
    // 图书馆 / 读书笔记（md_reading）：与 growth 是「只读引用 + 翻页转发」关系，
    // 白名单里不含任何写 md_growth 书单的 reading.* 函数，防两处写。
    'reading.meta', 'reading.read', 'reading.board', 'reading.notes', 'reading.themeBooks',
    'reading.addFiles', 'reading.cover', 'reading.revealBook',
    // 独立阅读窗口：只读打开 + 按章取正文 + 翻章记进度；不含任何写书单的函数
    'reading.readerOpen', 'reading.readerChapter', 'reading.readerProgress',
    'reading.bookmarks', 'reading.addBookmark', 'reading.removeBookmark', 'reading.searchBook',
    'reading.addBook', 'reading.updateBook', 'reading.removeBook',
    'reading.advanceBook', 'reading.setBookStatus',
    // 2026-11-14 书架整理：排序 / 再读一遍 / 最近在读 / 换封面 / 本机字体
    'reading.reorder', 'reading.reread', 'reading.touch', 'reading.setCover', 'reading.systemFonts',
    // V3.13 豆瓣封面走**专用异步通道**（v1/reading:doubanCovers / :doubanApply），
    // 不在这里登记——domain:call 是同步白名单，登记一个返回 Promise 的函数会在序列化时炸。
    // V3.5：书架分组 / 收藏夹（写 books 标签）+ PDF 原页字节（只读，不落临时文件）
    'reading.setBookGroup', 'reading.setBookFavorite', 'reading.renameGroup', 'reading.removeGroup',
    'reading.readerPdfData',
    'reading.addChapter', 'reading.updateChapter', 'reading.removeChapter',
    'reading.addNote', 'reading.updateNote', 'reading.removeNote', 'reading.markPushed',
    'reading.themeAdvance', 'reading.importGrowthQuotes', 'reading.diaryLine', 'reading.exportMd',
    // V2.14 主题阅读自建书单：主题表 + 主题书导入 + 一次性迁移旧 growth 书单
    'reading.themes', 'reading.themeAdd', 'reading.themeUpdate', 'reading.themeRemove',
    'reading.importGrowthThemes',
    // 本机时间源（md_worktime）：只读订阅 ActivityWatch。
    // 白名单里没有任何「写回 ActivityWatch」的函数——客户端只发 GET，这条在这里也钉死。
    'worktime.read', 'worktime.meta', 'worktime.enable', 'worktime.setHost', 'worktime.setKeepDays',
    'worktime.setToken', 'worktime.addRule', 'worktime.updateRule', 'worktime.removeRule',
    'worktime.day', 'worktime.week', 'worktime.dayForView', 'worktime.clearDays', 'worktime.clearError',
    'worktime.writeLine',
    // 首页天气：只读与本机偏好写入走同步白名单；
    // 真正联网的两条（weather.sync / weather.geocode）像 worktime.sync 一样走专用异步通道，
    // 不进这里——那条路由的前提是「领域函数都是同步纯函数」。
    'weather.view', 'weather.setEnabled', 'weather.setMode', 'weather.setCity',
    'weather.clearCity', 'weather.setUnit',
    // 家庭账本（md_finance）：与九格 MoneyView 只做「只读汇总 + 显式导入」，
    // 导入写 md_finance 的 txns（按 importedId 去重），绝不改写 morning_diary_*。
    // 金额一律整数分，导入/导出都是本机文件，不含任何联网函数。
    'finance.meta', 'finance.board', 'finance.read',
    'finance.add', 'finance.update', 'finance.remove',
    'finance.setBudget', 'finance.removeBudget',
    'finance.addRule', 'finance.updateRule', 'finance.removeRule',
    'finance.addCategory', 'finance.removeCategory',
    'finance.addAccount', 'finance.removeAccount',
    'finance.importCsv', 'finance.exportCsv',
    // 手记收支联动：只读扫描日记 + 点名导入（仍只写 md_finance）
    'finance.moneyRows', 'finance.importMoneyRows',
    // 完整理财：只读视图 + 目标/周期/账户/批量编辑的写操作，仍是同一份 md_finance
    'finance.accountRows', 'finance.netWorth', 'finance.cashFlow', 'finance.categoryReport',
    'finance.goalRows', 'finance.recurringRows', 'finance.detectSubscriptions',
    'finance.search', 'finance.insights',
    'finance.addGoal', 'finance.updateGoal', 'finance.removeGoal',
    'finance.addRecurring', 'finance.updateRecurring', 'finance.removeRecurring',
    'finance.setAccountMeta', 'finance.bulkUpdate',
    // 自由记录（md_freewrite）：闪念 / 长文 / 胶囊只读派生；胶囊本身仍走 diary-store 的白名单。
    // 同步到收件箱的动作发生在主进程路由里，渲染层拿不到跨 store 的写权限。
    'free.board', 'free.capsuleIndex',
    'free.flashAdd', 'free.flashRetry', 'free.flashSyncPending', 'free.flashRemove',
    'free.docAdd', 'free.docUpdate', 'free.docRemove', 'free.prefs',
    // 写作法体检：本地纯函数，只返回定位与计数，不联网、不代写。
    'writing.check', 'writing.cards'
  ];

  // ---- 成效侧度量（V3.8）：只回答「有没有真的推动」，一个字的正文都不记 ----
  // 判定只看①调用名 ②参数里的**键名**是否出现，绝不把参数值写进日志。
  // 读值就意味着任务标题、复盘答案有机会落盘——那正是 metrics.js 白名单要防的事。
  function todayIso() {
    const d = new Date();
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function outcomeEvent(name, args) {
    const list = Array.isArray(args) ? args : [];
    const ts = new Date().toISOString();
    const date = todayIso();
    if (name === 'gtd.complete') return { k: 'outcome_task_done', fields: { ts: ts, date: date, n: 1 } };
    if (name === 'reading.advanceBook' || name === 'reading.readerProgress') {
      // 两条都是「真的往前读了」：书架手动 +10 与阅读窗同步进度。
      // 只记发生次数，不记读了几页 / 读到第几章（那是正文层的事，不必进日志）。
      return { k: 'outcome_read_move', fields: { ts: ts, date: date, n: 1 } };
    }
    if (name === 'dream.deposit') return { k: 'outcome_dream_move', fields: { ts: ts, date: date, kind: 'deposit' } };
    if (name === 'dream.update') {
      // 只改标题 / 备注 / 配图不算「推动」：目标被推动＝进度、量化指标或状态变了
      const patch = (list[1] && typeof list[1] === 'object') ? list[1] : null;
      if (!patch) return null;
      const kind = patch.metric !== undefined ? 'metric'
        : (patch.progress !== undefined ? 'progress'
          : (patch.status !== undefined ? 'status' : ''));
      return kind ? { k: 'outcome_dream_move', fields: { ts: ts, date: date, kind: kind } } : null;
    }
    if (name === 'saveReview') {
      // 只统计「真的写了至少一问」的落成；清空答案 / 手滑保存不算成效
      const answers = Array.isArray(list[2]) ? list[2] : [];
      const filled = answers.filter(function (x) { return String(x || '').trim().length > 0; }).length;
      if (!filled) return null;
      const period = String(list[0] || '') === 'month' ? 'month' : 'week';
      return { k: 'outcome_review', fields: { ts: ts, date: date, period: period } };
    }
    return null;
  }

  route('v1/domain:call', function (p) {
    const q = p || {};
    const name = typeof q.name === 'string' ? q.name : '';
    if (!domain) return contract.fail('CLIENT_EXCEPTION', '领域层未挂载');
    if (DOMAIN_WHITELIST.indexOf(name) < 0) return contract.fail('CLIENT_EXCEPTION', '函数不在白名单: ' + name);
    const fn = domain[name];
    if (typeof fn !== 'function') return contract.fail('CLIENT_EXCEPTION', '领域函数不可用: ' + name);
    const args = Array.isArray(q.args) ? q.args : [];
    try {
      const result = fn.apply(null, args);
      // 检索使用率（R-11）：只记「用了哪种检索」，不记关键词
      if (name.indexOf('search.') === 0 && typeof opts.metricsRecord === 'function') {
        try { opts.metricsRecord('search_use', { ts: new Date().toISOString(), mode: name }); } catch (e) { /* 度量失败不影响检索 */ }
      }
      // 成效侧：调用成功后记一笔「发生了」，失败抛错就不记——没发生的事不该算成效
      if (typeof opts.metricsRecord === 'function') {
        try {
          const ev = outcomeEvent(name, args);
          if (ev) opts.metricsRecord(ev.k, ev.fields);
        } catch (e) { /* 度量失败绝不影响业务调用 */ }
      }
      return contract.ok(result === undefined ? null : result);
    } catch (e) {
      return contract.fail((e && e.code) || 'CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // 本机时间源同步：单独一条通道，因为它是会发 HTTP 的路由之一（另一条是 weather:sync）。
  // 放进 domain:call 会让「领域函数都是同步纯函数」这条前提失效（那套白名单是按同步写的）。
  route('v1/worktime:sync', function (p) {
    if (!domain) return Promise.resolve(contract.fail('CLIENT_EXCEPTION', '领域层未挂载'));
    const fn = domain['worktime.sync'];
    if (typeof fn !== 'function') return Promise.resolve(contract.fail('CLIENT_EXCEPTION', '时间源不可用'));
    const q = p || {};
    return Promise.resolve().then(function () {
      return fn(String(q.date || ''));
    }).then(function (r) {
      if (r && r.ok === false) return contract.fail(r.code || 'AW_ERROR', r.msg || '同步失败', r);
      return contract.ok(r);
    }, function (e) {
      return contract.fail((e && e.code) || 'CLIENT_EXCEPTION', (e && e.message) || String(e));
    });
  });

  // 首页天气：与 worktime 同一类——会发远程 HTTP，所以必须单独一条异步路由。
  // 关闭态在领域层就返回 NOT_ENABLED，路由这层不需要再判断，避免两处口径打架。
  function asyncDomain(name) {
    return function (p) {
      if (!domain) return Promise.resolve(contract.fail('CLIENT_EXCEPTION', '领域层未挂载'));
      const fn = domain[name];
      if (typeof fn !== 'function') return Promise.resolve(contract.fail('CLIENT_EXCEPTION', '领域函数不可用: ' + name));
      const q = p || {};
      return Promise.resolve().then(function () {
        return fn.apply(null, Array.isArray(q.args) ? q.args : []);
      }).then(function (r) {
        if (r && r.ok === false) return contract.fail(r.code || 'CLIENT_EXCEPTION', r.msg || '调用失败', r);
        return contract.ok(r);
      }, function (e) {
        return contract.fail((e && e.code) || 'CLIENT_EXCEPTION', (e && e.message) || String(e));
      });
    };
  }
  route('v1/weather:sync', asyncDomain('weather.sync'));
  route('v1/weather:geocode', asyncDomain('weather.geocode'));

  // 豆瓣封面（V3.13）：同样会发远程 HTTP，只能走异步路由，不能进 domain:call
  // （那条白名单是按「同步纯函数」写的，返回 Promise 会让 IPC 序列化直接报
  //  "An object could not be cloned"）。
  // 与 weather 的区别：**「没搜到」不是通道错误**。搜不到书、豆瓣抽风、没网，
  // 都算一次正常往返，由渲染层按 r.ok / r.reason 决定怎么说；只有领域层抛异常才走 fail。
  function asyncPass(name) {
    return function (p) {
      if (!domain) return Promise.resolve(contract.fail('CLIENT_EXCEPTION', '领域层未挂载'));
      const fn = domain[name];
      if (typeof fn !== 'function') return Promise.resolve(contract.fail('CLIENT_EXCEPTION', '领域函数不可用: ' + name));
      const q = p || {};
      return Promise.resolve().then(function () {
        return fn.apply(null, Array.isArray(q.args) ? q.args : []);
      }).then(function (r) {
        return contract.ok(r === undefined ? null : r);
      }, function (e) {
        return contract.fail((e && e.code) || 'CLIENT_EXCEPTION', (e && e.message) || String(e));
      });
    };
  }
  route('v1/reading:doubanCovers', asyncPass('reading.doubanCovers'));
  route('v1/reading:doubanApply', asyncPass('reading.doubanApply'));

  // ---- 可回滚版本（R-10）：列出与回滚都由主进程执行 ----
  // 渲染层拿不到文件路径，只传一个 id；id 的合法性与快照可读性由主进程校验。
  route('v1/snapshot:list', function () {
    if (typeof opts.snapshotLister !== 'function') return contract.fail('CLIENT_EXCEPTION', '未提供快照列表');
    try {
      return contract.ok({ items: opts.snapshotLister() });
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  route('v1/snapshot:restore', function (p) {
    if (typeof opts.snapshotRestorer !== 'function') return contract.fail('CLIENT_EXCEPTION', '未提供回滚能力');
    const q = p || {};
    try {
      const r = opts.snapshotRestorer(q.id);
      if (r && r.ok === false) return contract.fail(r.code || 'RESTORE_FAILED', r.msg || '回滚失败', r);
      return contract.ok(r);
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // ---- 使用度量（R-11）：只读汇总 + 开关；渲染层不能写原始事件 ----
  route('v1/metrics:summary', function () {
    if (typeof opts.metricsSummary !== 'function') return contract.fail('CLIENT_EXCEPTION', '未提供度量');
    try {
      return contract.ok(opts.metricsSummary());
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  route('v1/metrics:setEnabled', function (p) {
    if (typeof opts.metricsSetEnabled !== 'function') return contract.fail('CLIENT_EXCEPTION', '未提供度量开关');
    try {
      return contract.ok(opts.metricsSetEnabled({ enabled: !!(p && p.enabled) }));
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  // ---- 快速记录（R-09）：托盘点「快速记录」或热键都走这里 ----
  // 热键本身在主进程注册；这条路由是给托盘菜单与「窗口未就绪时补发」用的。
  route('v1/quickcapture:trigger', function (p) {
    if (typeof opts.quickCapture !== 'function') return contract.fail('CLIENT_EXCEPTION', '未提供快速记录');
    try {
      return contract.ok(opts.quickCapture((p && p.source) || 'ipc'));
    } catch (e) {
      return contract.fail('CLIENT_EXCEPTION', (e && e.message) || String(e));
    }
  });

  return {
    handle: handle,
    register: register,
    routeNames: function () { return Object.keys(routes); },
    domainWhitelist: function () { return DOMAIN_WHITELIST.slice(); }
  };
}

module.exports = { createApiLayer: createApiLayer, DIARY_KEY_RE: DIARY_KEY_RE };
