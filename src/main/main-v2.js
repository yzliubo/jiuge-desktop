'use strict';
// B 架构 M3 最小可运行入口：加载 Vue3/Vite 静态产物，接上 M0/M1 数据层。
// 本文件不覆盖 src/main/main.js（旧等价移植入口保持可用，便于回滚对比）。
// 启动：npm run start:v2 （需先 npm run build:view）
const { app, BrowserWindow, ipcMain, powerMonitor, dialog, shell,
  globalShortcut, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJournal } = require('../core/journal.js');
const { createRepository } = require('../core/repository.js');
const { createLifecycle } = require('../core/lifecycle.js');
const { createApiLayer } = require('../core/api-layer.js');
const { createMigrator } = require('../core/migrate.js');
const { createRecycle } = require('../core/recycle.js');
const persistence = require('../core/persistence.js');
// 本地使用度量（R-11）：只写事件类型 + 日期 + 计数/耗时，独立于 store.json，不联网
const { createMetrics } = require('../core/metrics.js');
// 本地电子书正文 / 目录解析：EPUB 走 ZIP，TXT/MD 分章，零第三方依赖
const readerSource = require('../reading/reader-source.js');
// 本机字体名：直接读字体文件 name 表，不走 PowerShell（控制台代码页会把中文族名变问号）
const readingFonts = require('../reading/fonts.js');
// 豆瓣封面检索（V3.13）：唯一会把「正在读什么」发到本机之外的通道，只在用户点名时调用
const coverNet = require('../reading/cover-net.js');
// 本机时间源：只读订阅 ActivityWatch（127.0.0.1:5600），不采集、不写回、不落窗口标题
const worktimeMod = require('../worktime/board.js');
const worktimeClient = require('../worktime/client.js');
const worktimeAgg = require('../worktime/aggregate.js');
// 首页天气：IP 定位 + Open-Meteo（两个提供方都免 Key）。只发 GET、只连白名单域名
const weatherMod = require('../weather/board.js');
const weatherClient = require('../weather/client.js');

const DIST = path.resolve(__dirname, '../../renderer-v2/dist/index.html');
// 独立阅读窗口：纯静态页，不进 vite 构建（三栏：目录 / 正文 / 笔记）
const READER_HTML = path.resolve(__dirname, '../../renderer-v2/reader/index.html');
// 独立账本窗口：Vite 第二入口，左（导航+净值）/ 中（模块）/ 右（洞察）三栏。
// 与主窗共用同一个 v2-preload，所以 finance.* 仍走 v1/domain:call 白名单。
const FINANCE_HTML = path.resolve(__dirname, '../../renderer-v2/dist/finance.html');
// 独立图书馆窗口：Vite 第三入口，左（文件夹树）/ 中（书架）/ 右（选中详情）三栏。
// 搬出主窗的理由很实际：书架本身就要「按文件夹看书」，主窗中栏再挂一棵树就什么都不剩。
const LIBRARY_HTML = path.resolve(__dirname, '../../renderer-v2/dist/library.html');
const PROBE = process.env.JIUGE_V2_PROBE === '1';
// 全局速记热键（R-09）：选 Ctrl+Alt+J 是因为它与「九格 / Jiuge」同字母，
// 且不与 Windows 的 Win+Shift+S、Ctrl+Alt+Del 等系统级组合冲突。
const QUICK_CAPTURE_ACCELERATOR = 'Control+Alt+J';
// 干净机 / 数据隔离：E2E 用独立 userData，绝不碰真实用户日记
if (process.env.JIUGE_V2_USERDATA) app.setPath('userData', process.env.JIUGE_V2_USERDATA);
let mainWindow = null;
// 一本书一个阅读窗口：重复点「翻开读」只聚焦，不叠窗
const readerWindows = new Map();
// 账本全局只有一个窗口：重复点顶栏「账本」只聚焦，不叠窗
let financeWindow = null;
// 图书馆同样只有一个窗口：重复点「图书馆」只聚焦，不叠窗
let libraryWindow = null;
let journal = null;
let repo = null;
let lifecycle = null;

function findLegacyStore() {
  const base = app.getPath('userData');
  const candidates = [
    path.join(base, 'store.json'),
    path.join(base, 'jiuge-desktop', 'store.json'),
    path.join(base, '..', 'jiuge-desktop', 'store.json')
  ];
  return candidates.find(function (p) { return fs.existsSync(p); }) || null;
}

function bootCore() {
  if (!fs.existsSync(DIST)) {
    throw new Error('视图层产物不存在，请先执行 npm run build:view：' + DIST);
  }
  const dataDir = path.join(app.getPath('userData'), 'jiuge-data');
  // 使用度量（R-11）：落 metrics.log，与 store.json 并列但**不在其中**，
  // 所以导出备份时结构上不可能带出指标数据；内容只有日期与计数。
  const metrics = createMetrics(dataDir);
  // 封面是小文件，落在本机数据目录；store 里只存 coverId，不塞 base64 进备份
  const coverDir = path.join(dataDir, 'covers');
  // 梦想的具象化图片：同一条目标一张，文件名 <dreamId>.<ext>，store 里只记文件名。
  // 12MB 封顶——手机原图三五 MB 够用，再大就该先压缩（把几十 MB 的 base64 穿过 IPC 会卡界面）。
  const dreamImageDir = path.join(dataDir, 'dream-images');
  const DREAM_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
  const DREAM_IMAGE_MAX = 12 * 1024 * 1024;
  function dreamImageMime(ext) {
    return ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  }
  function dreamImagePath(name) {
    // 只接受纯文件名：basename 不等于自身的一律拒绝，杜绝越界读写
    const n = String(name || '');
    if (!n || path.basename(n) !== n) return '';
    return path.join(dreamImageDir, n);
  }
  function dropDreamImage(name) {
    const p = dreamImagePath(name);
    if (!p) return;
    try { fs.unlinkSync(p); } catch (_) { /* 文件本来就不在：不算失败 */ }
  }
  journal = createJournal(dataDir);
  // 封存箱与仓储互相依赖：StoragePort 需要问"这个键是不是被软删了"，
  // 而封存箱要读写仓储。用 let 变量做延迟求值，创建 repo 时不做同步调用。
  let recycle = null;
  let autoBackup = { enabled: true, intervalMinutes: 30, kept: 5, lastAt: 0, lastId: '', timer: null };
  repo = createRepository({
    dir: dataDir,
    journal: journal,
    originWindowId: 'main',
    isHidden: function (key) { return recycle ? recycle.isHidden(key) : false; }
  });
  const loaded = repo.load();
  // 第一次打开种一棵初始的梦想树。
  // 注意 repo.get 对不存在的键返回 undefined/''（不是 null），所以要看「里面有没有 dreams」，
  // 不能只看键在不在——否则空库永远种不进去。用户把目标删光了也不会重种（那时 dreams 是 []）。
  try {
    const stored = repo.get('md_dream');
    const hasDreams = stored && Array.isArray(stored.dreams);
    if (!hasDreams) repo.set('md_dream', require('../dream/board.js').seedState());
  } catch (e) { /* 种树失败不该拦住启动 */ }
  lifecycle = createLifecycle(repo);

  // StoragePort：8 utils 下沉主进程，全局仅一份实例，算法零改动
  global.wx = repo.createWxAdapter();
  let diary = require('../utils/diary-store.js');
  // 封存/还原/焚毁之后必须让 diary-store 的模块级 memo 失效（memoAll/memoWritten/
  // memoStats/memoFreq）。它只在内部 write() 里清缓存，没有对外导出，所以只能重载模块。
  // domain 里的函数用闭包引用变量 diary，重载后自动指向新模块，调用方无感。
  function reloadDiary() {
    const p = require.resolve('../utils/diary-store.js');
    delete require.cache[p];
    diary = require(p);
  }
  const quotes = require('../utils/quotes.js');
  // 九格「金钱收支」格按天挂在日记的 moneyBook 上；账本只读它、不改写它。
  const moneyBook = require('../utils/money-book.js');
  const greetings = require('../utils/greetings.js');
  const insights = require('../utils/cell-insights.js');
  // GTD 是桌面端增量能力，单独成模块、存 md_gtd 单键：
  // 8 个 utils 保持与源项目逐字节一致（verify 第 1 条 SHA256 对拍），不动一行。
  const gtd = require('../gtd/board.js');
  const GTD_KEY = 'md_gtd';
  // 梦想（目标板）：原九格里的「梦想」格升成一级模块，存 md_dream 单键。
  // 它要存的是期限、进度、量化指标，不是「今天写一句」。
  const dream = require('../dream/board.js');
  const DREAM_KEY = 'md_dream';
  // 学习成长：考试考证 / 技能学习 / 主题阅读三种活动的时间尺度不同，
  // 领域层用三张独立表（exams / skills / themes），一起存 md_growth 单键。
  const growth = require('../growth/board.js');
  const GROWTH_KEY = 'md_growth';
  const growthStore = {
    read: function () { return growth.normalize(repo.get(GROWTH_KEY)); },
    write: function (next) {
      const norm = growth.normalize(next);
      repo.set(GROWTH_KEY, norm);
      return norm;
    },
    mutate: function (fn) {
      const s = growthStore.read();
      const out = fn(s);
      return growthStore.write(out || s);
    }
  };
  // 语料库：名言警句 / 问候语 / 运动提示。
  // 内置 539 条名言与 72 条问候/提示不复制进数据文件——只记「覆盖 / 隐藏 / 我的」
  // 三种改动，所以 md_inspire 通常只有几百字节，导出备份也轻。
  const inspire = require('../inspire/library.js');
  const INSPIRE_KEY = 'md_inspire';
  // V1.3 时间纵深：纯派生层，不建 store、不新增数据键、不改 8 个冻结 utils。
  // 人生月历 / 正文待办 / 随机重读 / 导出卡 / 一个文件，都从这里出函数。
  const v13 = require('../v13/board.js');
  // ---- V2.0 / V2.1 领域层：各管各的新键，8 个冻结 utils 一行不动 ----
  const searchMod = require('../search/query.js');
  const tagsMod = require('../tags/board.js');
  const recurMod = require('../recur/board.js');
  const relationMod = require('../relation/board.js');
  const termMod = require('../review/term.js');
  // V3.10 跨期对照：周 / 月复盘的「上期那句 → 后来怎么样了」，纯派生、不建键。
  const reviewCross = require('../review/cross.js');
  const traceMod = require('../trace/board.js');
  const secureMod = require('../secure/vault.js');
  const attachMod = require('../attach/links.js');
  // 图书馆（休闲娱乐阅读 + 主题阅读）与「读书笔记」数据库：md_reading 单键。
  // 【P0-1 单一事实源，2026-11-16】主题（themes）与主题**书单**（books[].themeId）的
  // 权威源都在 md_reading，二者没有第二份：board() 已不再接收 themeBooks 参数，
  // 导出汇总的书名兜底也只读 md_reading.books。
  // md_growth 里的旧书单只剩两个用途：① importGrowthThemes 的一次性迁移来源；
  // ② growthAudit 的「迁没迁完」核对（themeBooksFlat 只读派生，不给任何视图当数据用）。
  const readingMod = require('../reading/board.js');
  // 书籍指纹：大小 + 首 64KB SHA-256，用来在文件改名 / 换盘之后认出同一本书
  const readingFp = require('../reading/fingerprint.js');
  // 本地电子书：只用 Node 内置 fs + zlib 读 EPUB 元数据 / 封面，零第三方依赖
  const readingEpub = require('../reading/epub.js');
  // 封面文件 → dataURL（CSP 只允许 img-src 'self' data:，只能主进程读盘转一次）
  function coverDataUrl(coverId) {
    if (!coverId || path.basename(coverId) !== coverId) return '';
    try {
      const buf = fs.readFileSync(path.join(coverDir, coverId));
      const ext = readingEpub.extOf(coverId);
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return 'data:' + mime + ';base64,' + buf.toString('base64');
    } catch (_) { return ''; }
  }
  // 「这本书真的没有封面」也值得记一下：否则每次刷新书架都要把 EPUB 解一遍
  const coverMiss = new Map();
  // 家庭账本（md_finance）：信封预算 + 条件→动作自动分类 + CSV 导入，金额全程整数分。
  const financeMod = require('../finance/board.js');
  // 自由记录（md_freewrite）：闪念 / 长文 / 偏好；胶囊只读派生，绝不复制正文。
  const freeMod = require('../free/board.js');
  // 家庭亲子（md_family）：九格第 6 格的主功能（2026-11-16 由情绪觉察重构）。
  // 成员档案 / 亲子时刻 / 成长足迹三段，全部本机，无联网、无评分。
  const familyMod = require('../family/board.js');
  // 写作法体检：本地纯函数，只给定位与计数，不联网、不代写、不自动落库。
  const writingCheck = require('../writing/check.js');
  // 通用 store：normalize 幂等 + repo.set。新键必须显式包装进备份（见 exportBackup），
  // 否则换机后这些模块的数据会静默丢失。
  function makeDomainStore(key, api) {
    return {
      read: function () { return api.normalize(repo.get(key)); },
      write: function (next) {
        const norm = api.normalize(next);
        repo.set(key, norm);
        return norm;
      },
      mutate: function (fn) {
        const s = this.read();
        const out = fn(s);
        return this.write(out || s);
      }
    };
  }
  const tagsStore = makeDomainStore('md_tags', tagsMod);
  const recurStore = makeDomainStore('md_recur', recurMod);
  const relationStore = makeDomainStore('md_relation', relationMod);
  const termStore = makeDomainStore('md_term_review', termMod);
  const traceStore = makeDomainStore('md_trace', traceMod);
  const attachStore = makeDomainStore('md_attach', attachMod);
  // 图书馆 / 读书笔记：同走 normalize 幂等 + repo.set，且必须显式进备份（见 V2_SECTIONS）
  const readingStore = makeDomainStore('md_reading', readingMod);
  // 家庭账本：独立单键。与九格 MoneyView 只做「只读汇总 + 显式导入」，绝不改写日记。
  const financeStore = makeDomainStore('md_finance', financeMod);
  // 自由记录：独立单键。长文正文不进 cells.free（当日日记 2000 字上限 + 每次全量写 record）。
  const freeStore = makeDomainStore('md_freewrite', freeMod);
  // 家庭亲子：独立单键。成员档案与亲子时刻都不写日记的 cells.emotion——
  // 那一格是「当天一句」，模块页才是结构化记录（与关系经营 / 梦想同一套分层）。
  const familyStore = makeDomainStore('md_family', familyMod);
  // 本机时间源：日聚合 + 规则表，独立键（保留期与清空都能单独做）
  const worktimeStore = makeDomainStore('md_worktime', worktimeMod);
  // 首页天气：只存偏好（开关 / 模式 / 城市 / 坐标），缓存留在内存里。
  // 不进备份是故意的：温度是「此刻的窗外」，不是你的记录，换台机器重新拉一次就行。
  const weatherStore = makeDomainStore('md_weather', weatherMod);
  const WEATHER_TTL = 30 * 60 * 1000;      // 成功一次管 30 分钟
  const WEATHER_FAIL_TTL = 5 * 60 * 1000;  // 失败后 5 分钟内不再打网络，避免断网时反复重试
  let weatherCache = { report: null, fetchedAt: 0, ttl: WEATHER_TTL, error: null };

  // 本地今天（YYYY-MM-DD）：胶囊派生与到期判断只认本地日，不认 UTC。
  function isoDayNow() {
    const d = new Date();
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // 时间戳 → 本地日：闪念有 date 字段，长文只有 createdAt / updatedAt。
  // 九格第 9 格要按「天」看，所以必须在主进程按本地日归集，渲染层不自己算。
  function isoDayOf(ts) {
    const n = Number(ts) || 0;
    if (!n) return '';
    const d = new Date(n);
    const p = function (x) { return x < 10 ? '0' + x : String(x); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 闪念 → 收件箱：按 source 幂等（gtd.addTask 的 source 上限 32 字）。
  // 同步失败只改标记、绝不回滚原文——「不静默丢字」高于「两边绝对一致」。
  function syncFlash(f) {
    const source = String(f.source || '');
    if (!source) return false;
    try {
      const tasks = gtdStore.read().tasks || [];
      const exists = tasks.some(function (t) { return t && t.source === source; });
      if (!exists) {
        gtdStore.mutate(function (s) {
          return gtd.addTask(s, {
            title: String(f.text || '').slice(0, 40), status: 'inbox', source: source
          });
        });
      }
      freeStore.mutate(function (s) { return freeMod.setFlashSync(s, f.id, 'ok', ''); });
      return true;
    } catch (e) {
      freeStore.mutate(function (s) { return freeMod.setFlashSync(s, f.id, 'failed', ''); });
      return false;
    }
  }

  // 本地日界：ActivityWatch 存 UTC，九格按本地日切分。时区只在这里出现一次。
  function localDayBounds(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const start = new Date(y, mo, d, 0, 0, 0, 0).getTime();
    const end = new Date(y, mo, d + 1, 0, 0, 0, 0).getTime();
    if (!(end > start)) return null;
    return { start: start, end: end };
  }
  const inspireStore = {
    read: function () { return inspire.normalize(repo.get(INSPIRE_KEY)); },
    write: function (next) {
      const norm = inspire.normalize(next);
      repo.set(INSPIRE_KEY, norm);
      return norm;
    },
    mutate: function (fn) {
      const s = inspireStore.read();
      const out = fn(s);
      return inspireStore.write(out || s);
    }
  };
  const dreamStore = {
    read: function () { return dream.normalize(repo.get(DREAM_KEY)); },
    write: function (next) {
      const norm = dream.normalize(next);
      repo.set(DREAM_KEY, norm);
      return norm;
    },
    mutate: function (fn) {
      const s = dreamStore.read();
      const out = fn(s);
      return dreamStore.write(out || s);
    }
  };
  const gtdStore = {
    read: function () { return gtd.normalize(repo.get(GTD_KEY)); },
    write: function (next) {
      const norm = gtd.normalize(next);
      repo.set(GTD_KEY, norm);
      return norm;
    },
    mutate: function (fn) {
      const s = gtdStore.read();
      const out = fn(s);
      return gtdStore.write(out || s);
    }
  };

  // V2.14：主题书单权威源在 md_reading.books（themeId 非空的记录）。
  // 这个函数**不是**给视图取数用的——它只从 md_growth 读旧书单，用于两件事：
  //   ① reading.importGrowthThemes 的一次性迁移（旧数据原样保留、可重复调用）；
  //   ② reading.growthAudit 的迁移核对（哪几本还没迁进来）。
  // 曾有 6 处把这个返回值当「主题书单」塞给视图，造成同一份书单三处说法不一；
  // P0-1 已把这些透传全部删掉，只留上面两条只读用途（view:check 仍钉着本函数存在）。
  function themeBooksFlat() {
    const g = growthStore.read();
    const out = [];
    (g.themes || []).forEach(function (t) {
      (t.books || []).forEach(function (b) {
        const pct = b.status === 'done' ? 100 : (b.total > 0 ? Math.round(b.done * 100 / b.total) : 0);
        out.push({
          themeId: t.id, themeTitle: t.title || '',
          bookId: b.id, title: b.title || '', author: b.author || '',
          total: b.total || 0, done: b.done || 0, unit: b.unit || '\u9875',
          status: b.status || 'todo', pct: pct,
          quoteCount: (b.quotes || []).length
        });
      });
    });
    return out;
  }

  // V2.14：主题书从 md_reading.books 派生，带 filePath，可进独立阅读窗读正文。
  function themeGroupsFromReading() {
    const s = readingStore.read();
    const groups = [];
    const idx = {};
    (s.themes || []).forEach(function (t) {
      const g = { themeId: t.id, themeTitle: t.title || '', note: t.note || '', rows: [] };
      idx[t.id] = g;
      groups.push(g);
    });
    (s.books || []).forEach(function (b) {
      const tid = String(b.themeId || '');
      if (!tid) return;
      const g = idx[tid] || { themeId: tid, themeTitle: '未命名主题', note: '', rows: [] };
      if (!idx[tid]) { idx[tid] = g; groups.push(g); }
      g.rows.push(b);
    });
    return groups;
  }

  // 闭包绑定而非值拷贝：reloadDiary() 后所有领域函数自动指向新模块。
  // 这是封存箱能让 all()/stats/search 立刻看到删除结果的前提。
  const domain = {};
  Object.keys(diary).forEach(function (k) {
    if (typeof diary[k] === 'function') {
      domain[k] = function () { return diary[k].apply(null, arguments); };
    } else {
      domain[k] = diary[k];
    }
  });
  Object.assign(domain, {
    'quotes.size': function () { return quotes.size; },
    'quotes.dailyIndex': quotes.dailyIndex,
    'quotes.randomIndex': quotes.randomIndex,
    'quotes.pick': quotes.pick,
    'greetings.compose': greetings.compose,
    'greetings.periodOf': greetings.periodOf,
    'insights.axisOf': insights.axisOf,
    'insights.analyze': insights.analyze,

    // ---- GTD 工作台 ----
    'gtd.read': function () { return gtdStore.read(); },
    'gtd.statusMeta': function () {
      return {
        status: gtd.STATUS,
        label: gtd.STATUS_LABEL,
        hint: gtd.STATUS_HINT,
        contexts: gtd.CONTEXTS,
        limits: {
          title: gtd.TITLE_MAX, note: gtd.NOTE_MAX, waitingFor: gtd.WAITING_MAX,
          context: gtd.CONTEXT_MAX, project: gtd.PROJECT_MAX,
          tasks: gtd.MAX_TASKS, projects: gtd.MAX_PROJECTS, doneKeepDays: gtd.DONE_KEEP_DAYS,
          childMax: gtd.MAX_CHILDREN, depthMax: gtd.PARENT_DEPTH
        }
      };
    },
    'gtd.add': function (patch) {
      return gtdStore.mutate(function (s) { return gtd.addTask(s, patch || {}); });
    },
    'gtd.update': function (id, patch) {
      return gtdStore.mutate(function (s) { return gtd.updateTask(s, id, patch || {}); });
    },
    'gtd.remove': function (id) {
      return gtdStore.mutate(function (s) { return gtd.removeTask(s, id); });
    },
    'gtd.complete': function (id) {
      return gtdStore.mutate(function (s) { return gtd.complete(s, id); });
    },
    // 连同子项一起完成：界面在勾父任务且还有未完成子项时用这条，
    // 不去级联删除、也不静默只完成父项
    'gtd.completeAll': function (id) {
      return gtdStore.mutate(function (s) { return gtd.completeAll(s, id); });
    },
    'gtd.completionInfo': function (id) { return gtd.completionInfo(gtdStore.read(), id); },
    'gtd.reopen': function (id) {
      return gtdStore.mutate(function (s) { return gtd.reopen(s, id); });
    },
    'gtd.clarify': function (id, status, patch) {
      return gtdStore.mutate(function (s) { return gtd.clarify(s, id, status, patch || {}); });
    },
    'gtd.board': function (nowDate) { return gtd.board(gtdStore.read(), nowDate); },
    // 九格「事项」回写用：gtd.board 的 done 组只留最近 7 天，这里直接读原始任务，
    // 否则一周后原格里的「已完成」会被误清掉。只读、带前缀过滤，不暴露整张清单。
    'gtd.refs': function (prefix) {
      const s = gtdStore.read();
      const p = String(prefix || 'g9|');
      return (s.tasks || []).filter(function (t) {
        return t && typeof t.source === 'string' && t.source.indexOf(p) === 0;
      }).map(function (t) {
        return { id: t.id, source: t.source, status: t.status, title: t.title, doneAt: t.doneAt || 0 };
      }).slice(0, 1000);
    },
    // ---- 今日六点：只存指针，跨天不结转 ----
    'gtd.focus': function (nowDate) { return gtd.focusOf(gtdStore.read(), nowDate); },
    'gtd.focusCandidates': function (nowDate) { return gtd.focusCandidates(gtdStore.read(), nowDate); },
    'gtd.focusToggle': function (nowDate, id, cell) {
      return gtdStore.mutate(function (s) { return gtd.toggleFocus(s, nowDate, id, cell); });
    },
    'gtd.focusSet': function (nowDate, ids) {
      return gtdStore.mutate(function (s) { return gtd.setFocus(s, nowDate, ids); });
    },
    'gtd.focusClear': function (nowDate) {
      return gtdStore.mutate(function (s) { return gtd.clearFocus(s, nowDate); });
    },
    'gtd.review': function (nowDate) { return gtd.weeklyReview(gtdStore.read(), nowDate); },
    'gtd.markReviewed': function (nowDate) {
      return gtdStore.mutate(function (s) { return gtd.markReviewed(s, nowDate); });
    },
    'gtd.projects': function () { return gtd.projectRollup(gtdStore.read()); },
    'gtd.contexts': function () { return gtd.contextPool(gtdStore.read()); },
    // ---- 项目 / 情境的用户层：新建 / 改名 / 归档 / 删除 ----
    // 这四个动作都会改任务上的归属字段，所以必须走 mutate（一次落盘），不能只改名单
    'gtd.projectAdd': function (name) {
      return gtdStore.mutate(function (s) { return gtd.projectAdd(s, name); });
    },
    'gtd.projectRename': function (from, to) {
      return gtdStore.mutate(function (s) { return gtd.projectRename(s, from, to); });
    },
    'gtd.projectArchive': function (name, archived) {
      return gtdStore.mutate(function (s) { return gtd.projectArchive(s, name, archived); });
    },
    'gtd.projectRemove': function (name) {
      return gtdStore.mutate(function (s) { return gtd.projectRemove(s, name); });
    },
    'gtd.contextAdd': function (name) {
      return gtdStore.mutate(function (s) { return gtd.contextAdd(s, name); });
    },
    'gtd.contextRename': function (from, to) {
      return gtdStore.mutate(function (s) { return gtd.contextRename(s, from, to); });
    },
    'gtd.contextRemove': function (name) {
      return gtdStore.mutate(function (s) { return gtd.contextRemove(s, name); });
    },
    // ---- 梦想（目标板）----
    'dream.meta': function () { return dream.meta(); },
    // V2.1「主目标倒计时」只读入口：不新增字段，读不到主目标口径就在界面如实说明
    'dream.read': function () { return dreamStore.read(); },
    // 目标板上要看到「关联行动推进到哪」，所以把 GTD 任务一起传进去算
    'dream.board': function (today) { return dream.board(dreamStore.read(), gtdStore.read().tasks, today); },
    'dream.add': function (patch) {
      return dreamStore.mutate(function (s) { return dream.add(s, patch || {}); });
    },
    'dream.update': function (id, patch) {
      return dreamStore.mutate(function (s) { return dream.update(s, id, patch || {}); });
    },
    'dream.remove': function (id) {
      // 删目标时顺手把它的图片一起删掉：store 里的引用没了，留着文件只会变成看不见的垃圾
      const key = String(id || '');
      const one = dreamStore.read().dreams.filter(function (d) { return d.id === key; })[0];
      const out = dreamStore.mutate(function (s) { return dream.remove(s, id); });
      if (one && one.image) dropDreamImage(one.image);
      return out;
    },
    // 具象化图片：渲染层只给「选中的文件路径」，复制与命名都在主进程，
    // store 里落的是文件名（换机丢图可以重选，但绝不把 base64 写进 journal）
    'dream.setImage': function (id, srcPath) {
      const key = String(id || '');
      const one = dreamStore.read().dreams.filter(function (d) { return d.id === key; })[0];
      if (!one) return { ok: false, reason: '找不到这条目标' };
      const src = String(srcPath || '');
      const ext = path.extname(src).slice(1).toLowerCase();
      if (DREAM_IMAGE_EXTS.indexOf(ext) < 0) return { ok: false, reason: '只支持 JPG / PNG / WebP / GIF' };
      let st;
      try { st = fs.statSync(src); } catch (_) { return { ok: false, reason: '找不到这个文件' }; }
      if (!st.isFile()) return { ok: false, reason: '这不是一个文件' };
      if (st.size > DREAM_IMAGE_MAX) return { ok: false, reason: '图片超过 12MB，先压缩一下再选' };
      try {
        if (!fs.existsSync(dreamImageDir)) fs.mkdirSync(dreamImageDir, { recursive: true });
        const name = key + '.' + ext;
        // 换了扩展名就把旧文件删掉，否则同一条目标会留两份图
        if (one.image && one.image !== name) dropDreamImage(one.image);
        fs.copyFileSync(src, path.join(dreamImageDir, name));
        dreamStore.mutate(function (s) { return dream.setImage(s, key, name); });
        return { ok: true, image: name };
      } catch (e) {
        return { ok: false, reason: '保存失败：' + ((e && e.message) || e) };
      }
    },
    'dream.clearImage': function (id) {
      const key = String(id || '');
      const one = dreamStore.read().dreams.filter(function (d) { return d.id === key; })[0];
      if (!one) return { ok: false, reason: '找不到这条目标' };
      const old = one.image;
      dreamStore.mutate(function (s) { return dream.setImage(s, key, ''); });
      if (old) dropDreamImage(old);
      return { ok: true };
    },
    // 图片以 dataURL 回传：视图层 CSP 只放行 img-src 'self' data:，也不该拿到本机路径
    'dream.image': function (id) {
      const key = String(id || '');
      const one = dreamStore.read().dreams.filter(function (d) { return d.id === key; })[0];
      if (!one || !one.image) return '';
      const p = dreamImagePath(one.image);
      if (!p) return '';
      try {
        const buf = fs.readFileSync(p);
        return 'data:' + dreamImageMime(path.extname(one.image).slice(1).toLowerCase()) + ';base64,' + buf.toString('base64');
      } catch (_) { return ''; }
    },
    'dream.setTheme': function (theme) {
      return dreamStore.mutate(function (s) { return dream.setTheme(s, theme); });
    },
    'dream.setFund': function (id, targetCents) {
      return dreamStore.mutate(function (s) { return dream.setFund(s, id, targetCents); });
    },
    // 存款从金钱账户划过来：金额按「分」存，和账本口径一致
    'dream.deposit': function (id, cents, date, note, source) {
      return dreamStore.mutate(function (s) { return dream.deposit(s, id, cents, date, note, source); });
    },
    'dream.linkTask': function (id, taskId) {
      return dreamStore.mutate(function (s) { return dream.linkTask(s, id, taskId); });
    },
    'dream.unlinkTask': function (id, taskId) {
      return dreamStore.mutate(function (s) { return dream.unlinkTask(s, id, taskId); });
    },

    // ---- 学习成长（考试考证 / 技能学习 / 主题阅读）----
    'growth.meta': function () { return growth.meta(); },
    'growth.read': function () { return growthStore.read(); },
    'growth.board': function (today) { return growth.board(growthStore.read(), today); },
    'growth.addExam': function (patch) {
      return growthStore.mutate(function (s) { return growth.addExam(s, patch || {}); });
    },
    'growth.updateExam': function (id, patch) {
      return growthStore.mutate(function (s) { return growth.updateExam(s, id, patch || {}); });
    },
    'growth.removeExam': function (id) {
      return growthStore.mutate(function (s) { return growth.removeExam(s, id); });
    },
    'growth.addSubject': function (examId, patch) {
      return growthStore.mutate(function (s) { return growth.addSubject(s, examId, patch || {}); });
    },
    'growth.updateSubject': function (examId, subId, patch) {
      return growthStore.mutate(function (s) { return growth.updateSubject(s, examId, subId, patch || {}); });
    },
    'growth.removeSubject': function (examId, subId) {
      return growthStore.mutate(function (s) { return growth.removeSubject(s, examId, subId); });
    },
    'growth.setExamResult': function (id, score, passLine, causes) {
      return growthStore.mutate(function (s) { return growth.setExamResult(s, id, score, passLine, causes); });
    },
    // 事后补记 / 更正错因：只改最近一次作答，不重填分数
    'growth.setExamCauses': function (id, causes) {
      return growthStore.mutate(function (s) { return growth.setExamCauses(s, id, causes); });
    },
    'growth.retakeExam': function (id) {
      return growthStore.mutate(function (s) { return growth.retakeExam(s, id); });
    },
    'growth.addSkill': function (patch) {
      return growthStore.mutate(function (s) { return growth.addSkill(s, patch || {}); });
    },
    'growth.updateSkill': function (id, patch) {
      return growthStore.mutate(function (s) { return growth.updateSkill(s, id, patch || {}); });
    },
    'growth.removeSkill': function (id) {
      return growthStore.mutate(function (s) { return growth.removeSkill(s, id); });
    },
    'growth.addMilestone': function (skillId, title) {
      return growthStore.mutate(function (s) { return growth.addMilestone(s, skillId, title); });
    },
    'growth.toggleMilestone': function (skillId, msId) {
      return growthStore.mutate(function (s) { return growth.toggleMilestone(s, skillId, msId); });
    },
    'growth.removeMilestone': function (skillId, msId) {
      return growthStore.mutate(function (s) { return growth.removeMilestone(s, skillId, msId); });
    },
    // 练习记录是技能的唯一「投入」证据：只记日期与分钟，不做评分
    'growth.addPractice': function (skillId, patch) {
      return growthStore.mutate(function (s) { return growth.addPractice(s, skillId, patch || {}); });
    },
    'growth.removePractice': function (skillId, practiceId) {
      return growthStore.mutate(function (s) { return growth.removePractice(s, skillId, practiceId); });
    },
    // V3.9 练习反馈：卡点（带开始日，能算挂了多久）与「下次提高一点什么」
    'growth.setSkillBlocker': function (id, text, today) {
      return growthStore.mutate(function (s) { return growth.setSkillBlocker(s, id, text, today); });
    },
    'growth.clearSkillBlocker': function (id, today) {
      return growthStore.mutate(function (s) { return growth.clearSkillBlocker(s, id, today); });
    },
    'growth.setSkillNextUp': function (id, text) {
      return growthStore.mutate(function (s) { return growth.setSkillNextUp(s, id, text); });
    },
    'growth.addTheme': function (patch) {
      return growthStore.mutate(function (s) { return growth.addTheme(s, patch || {}); });
    },
    'growth.updateTheme': function (id, patch) {
      return growthStore.mutate(function (s) { return growth.updateTheme(s, id, patch || {}); });
    },
    'growth.removeTheme': function (id) {
      return growthStore.mutate(function (s) { return growth.removeTheme(s, id); });
    },
    'growth.addBook': function (themeId, patch) {
      return growthStore.mutate(function (s) { return growth.addBook(s, themeId, patch || {}); });
    },
    'growth.updateBook': function (themeId, bookId, patch) {
      return growthStore.mutate(function (s) { return growth.updateBook(s, themeId, bookId, patch || {}); });
    },
    'growth.removeBook': function (themeId, bookId) {
      return growthStore.mutate(function (s) { return growth.removeBook(s, themeId, bookId); });
    },
    'growth.advanceBook': function (themeId, bookId, delta) {
      return growthStore.mutate(function (s) { return growth.advanceBook(s, themeId, bookId, delta); });
    },
    'growth.setBookStatus': function (themeId, bookId, status) {
      return growthStore.mutate(function (s) { return growth.setBookStatus(s, themeId, bookId, status); });
    },
    'growth.addQuote': function (themeId, bookId, patch) {
      return growthStore.mutate(function (s) { return growth.addQuote(s, themeId, bookId, patch || {}); });
    },
    'growth.removeQuote': function (themeId, bookId, quoteId) {
      return growthStore.mutate(function (s) { return growth.removeQuote(s, themeId, bookId, quoteId); });
    },
    // 旧学习库（md_study_library，utils 里动不了的那份）一次性搬进来，按标题去重
    'growth.importLegacy': function () {
      // readStudyLibrary 直接返回库对象（不是 { data } 契约），这里按原样取
      const lib = diary.readStudyLibrary() || { items: [], topics: [] };
      const out = growth.importLegacy(growthStore.read(), lib);
      growthStore.write(out.state);
      return { addedBooks: out.addedBooks, addedSkills: out.addedSkills };
    },

    'gtd.importLegacy': function () {
      const all = diary.all();
      const records = (all && all.data) || [];
      const res = gtd.importLegacy(gtdStore.read(), records);
      gtdStore.write(res.state);
      return { added: res.added, skipped: res.skipped };
    },

    // ---- 语料库：名言警句 / 问候语 / 运动提示（使用者可自行增删改）----
    // 读：三条 list 走同一份状态；写：全部是「状态进、状态出」，与 gtd/dream 一致。
    'inspire.meta': function () { return inspire.meta(); },
    'inspire.read': function () { return inspireStore.read(); },
    'inspire.stats': function () { return inspire.stats(inspireStore.read()); },
    'inspire.list': function (kind) { return inspire.list(inspireStore.read(), kind); },
    // 首页问候 + 名言：同一天同一时段稳定；offset 用于「换一组」
    'inspire.today': function (opts) { return inspire.today(inspireStore.read(), opts || {}); },
    'inspire.pick': function (kind, opts) { return inspire.pick(inspireStore.read(), kind, opts || {}); },
    'inspire.add': function (kind, patch) {
      return inspireStore.mutate(function (s) { return inspire.add(s, kind, patch || {}); });
    },
    'inspire.update': function (kind, id, patch) {
      return inspireStore.mutate(function (s) { return inspire.update(s, kind, id, patch || {}); });
    },
    // 删内置 = 记一个 hidden（可还原）；删我的 = 真删
    'inspire.remove': function (kind, id) {
      return inspireStore.mutate(function (s) { return inspire.remove(s, kind, id); });
    },
    'inspire.restore': function (kind, id) {
      return inspireStore.mutate(function (s) { return inspire.restore(s, kind, id); });
    },
    // 撤销对内置条目的改写（保留隐藏状态）
    'inspire.revert': function (kind, id) {
      return inspireStore.mutate(function (s) { return inspire.revert(s, kind, id); });
    },
    'inspire.toggle': function (kind, id, enabled) {
      return inspireStore.mutate(function (s) { return inspire.toggle(s, kind, id, enabled); });
    },
    // 恢复内置默认：只清隐藏与覆盖，「我的」条目一条不动
    'inspire.reset': function (kind) {
      return inspireStore.mutate(function (s) { return inspire.reset(s, kind); });
    },

    // ---- V1.3 时间纵深：全部从 diary.all() / repo 派生，零新键 ----
    'v13.calendar': function (opts) {
      const res = diary.all();
      return v13.calendar((res && res.data) || [], opts || {});
    },
    'v13.todos': function () {
      const res = diary.all();
      return v13.todos((res && res.data) || []);
    },
    'v13.random': function (exclude) {
      const res = diary.all();
      const d = new Date();
      const p = function (n) { return (n < 10 ? '0' : '') + n; };
      const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      return v13.pickRandom((res && res.data) || [], exclude || [], { today: today });
    },
    'v13.card': function (date, opts) {
      const res = diary.all();
      const rec = ((res && res.data) || []).find(function (r) { return r && r.date === date; }) || null;
      let quote = '';
      try {
        const pack = inspire.today(inspireStore.read());
        quote = pack && pack.quote ? String(pack.quote.text || '') : '';
      } catch (e) { quote = ''; }
      const labels = {
        work: '工作推进', money: '金钱收支', health: '身心健康', relation: '关系经营',
        future: '今日六条', emotion: '情绪觉察', dream: '休闲娱乐', leisure: '休闲娱乐', growth: '学习成长', free: '自由记录'
      };
      return v13.cardData(rec, labels, { quote: quote, brand: !!(opts && opts.brand) });
    },
    'v13.archiveInfo': function () {
      const keys = repo.keys().filter(function (k) { return k.indexOf('__') !== 0; });
      const storePath = path.join(dataDir, 'store.json');
      let storeBytes = 0;
      try { storeBytes = fs.statSync(storePath).size; } catch (e) { /* 首启可能还没落盘 */ }
      let totalBytes = 0;
      let fileCount = 0;
      try {
        fs.readdirSync(dataDir).forEach(function (f) {
          try {
            const st = fs.statSync(path.join(dataDir, f));
            if (!st.isFile()) return;
            totalBytes += st.size;
            fileCount += 1;
          } catch (e) { /* 忽略正在写的文件 */ }
        });
      } catch (e) { /* 目录还没建 */ }
      return { path: dataDir, storePath: storePath, storeBytes: storeBytes, totalBytes: totalBytes, keyCount: keys.length, fileCount: fileCount };
    },
    // 打包产物只装数据键，绝不装 app.asar / 程序文件 / 日志
    'v13.pack': function () {
      return v13.packSnapshot(repo.keys(), function (k) { return repo.get(k); }, { generator: 'v13' });
    },
    'v13.verifyPack': function (text) {
      const v = v13.verifyPack(text);
      return { ok: v.ok, error: v.error, keyCount: v.keyCount, keys: v.keys, exportedAt: v.exportedAt || '' };
    },
    // 还原只补写不覆盖：本机已有的键一律保留，避免旧包把今天写没了
    'v13.unpack': function (text) {
      return v13.unpackInto(text, function (k) {
        return typeof repo.get(k) !== 'undefined';
      }, function (k, val) { repo.set(k, val); });
    },

    // ---- V2.0b 内容连接：搜索增强 / 正文内链 / 轻标签 / 重复任务 / 耗时 ----
    'search.or': function (kw) {
      const res = diary.all();
      return searchMod.orSearch((res && res.data) || [], String(kw || ''));
    },
    'search.pinyin': function (kw) {
      const res = diary.all();
      return searchMod.pinyinMatch((res && res.data) || [], String(kw || ''));
    },
    'search.linksAll': function () {
      const res = diary.all();
      const out = [];
      ((res && res.data) || []).forEach(function (r) {
        const cells = (r && r.cells) || {};
        Object.keys(cells).forEach(function (cell) {
          const text = typeof cells[cell] === 'string' ? cells[cell] : '';
          searchMod.parseLinks(text).forEach(function (l) {
            out.push({ date: r.date, cell: cell, raw: l.raw, target: l.target, type: l.type });
          });
          // P0-3 反查：回写行尾的〔rd:<noteId>〕也是一种内链——
          // 从日记这一侧能点回图书馆那条笔记，才算「关联是数据，不是一句给人看的文字」。
          readingMod.refIdsIn(text).forEach(function (id) {
            out.push({ date: r.date, cell: cell, raw: '〔rd:' + id + '〕', target: id, type: 'reading' });
          });
        });
      });
      return out;
    },
    'tags.read': function () { return tagsStore.read(); },
    'tags.add': function (name) {
      return tagsStore.mutate(function (s) { return tagsMod.addTag(s, String(name || '')); });
    },
    'tags.remove': function (id) {
      return tagsStore.mutate(function (s) { return tagsMod.removeTag(s, id); });
    },
    'tags.tag': function (target, id) {
      return tagsStore.mutate(function (s) { return tagsMod.tagRecord(s, target, id); });
    },
    'tags.untag': function (target, id) {
      return tagsStore.mutate(function (s) { return tagsMod.untagRecord(s, target, id); });
    },
    'tags.for': function (target) { return tagsMod.listFor(tagsStore.read(), target); },
    'tags.stats': function () { return tagsMod.stats(tagsStore.read()); },
    'recur.read': function () { return recurStore.read(); },
    'recur.derive': function (task, today) {
      const g = gtdStore.read();
      return recurMod.deriveNext(task || {}, (g && g.tasks) || [], today);
    },
    'recur.log': function (taskId, minutes, opts) {
      return recurStore.mutate(function (s) { return recurMod.logMinutes(s, taskId, minutes, opts || {}); });
    },
    'recur.week': function (today) { return recurMod.weekDistribution(recurStore.read(), today); },

    // ---- V2.0a 关系经营：三轴分层 / 通讯录 / 温度 / 四视角 ----
    'relation.meta': function () {
      return {
        circles: relationMod.CIRCLES, circleLabel: relationMod.CIRCLE_LABEL,
        tiers: relationMod.TIERS, tierLabel: relationMod.TIER_LABEL,
        channels: relationMod.CHANNELS, channelLabel: relationMod.CHANNEL_LABEL, channelWeight: relationMod.CHANNEL_WEIGHT,
        depths: relationMod.DEPTHS, depthLabel: relationMod.DEPTH_LABEL, depthWeight: relationMod.DEPTH_WEIGHT,
        limits: { contacts: relationMod.MAX_CONTACTS, logs: relationMod.MAX_LOGS, name: relationMod.NAME_MAX }
      };
    },
    'relation.read': function () { return relationStore.read(); },
    'relation.list': function (opts) { return relationMod.listContacts(relationStore.read(), opts || {}); },
    'relation.addContact': function (patch) {
      return relationStore.mutate(function (s) { return relationMod.addContact(s, patch || {}); });
    },
    'relation.updateContact': function (id, patch) {
      return relationStore.mutate(function (s) { return relationMod.updateContact(s, id, patch || {}); });
    },
    'relation.archiveContact': function (id) {
      return relationStore.mutate(function (s) { return relationMod.archiveContact(s, id); });
    },
    'relation.addLog': function (patch) {
      return relationStore.mutate(function (s) { return relationMod.addLog(s, patch || {}); });
    },
    'relation.removeLog': function (id) {
      return relationStore.mutate(function (s) { return relationMod.removeLog(s, id); });
    },
    'relation.logsFor': function (id) { return relationMod.logsFor(relationStore.read(), id); },
    'relation.temperature': function (id) { return relationMod.temperature(relationStore.read(), id); },
    'relation.analytics': function () { return relationMod.analytics(relationStore.read()); },

    // ---- V2.1 长期形状：节气 / 弱引用 / 单条加密 / 链接型附件 ----
    'term.current': function () {
      const cur = termMod.termOf(new Date());
      let key = '';
      try { key = termMod.termKeyOf(new Date()); } catch (e) { key = String(cur.name || ''); }
      return { name: cur.name, index: cur.index, next: cur.next, daysLeft: cur.daysLeft, hou: cur.hou, key: key };
    },
    'term.meta': function () { return { TERMS: termMod.TERMS, MAX_REVIEWS: termMod.MAX_REVIEWS }; },
    'term.reviews': function () { return termMod.listReviews(termStore.read()); },
    'term.save': function (key, answers) {
      return termStore.mutate(function (s) { return termMod.saveReview(s, key, answers || {}); });
    },
    // V3.10 跨期对照：一次读回最近 6 期 + GTD 任务，交给纯函数并排摆出来。
    // 只读：不写复盘、不写任务、不改任何键；「做到没有」永远由第 1、2 问的人回答。
    'review.cross': function (period, key, current) {
      const p = period === 'month' ? 'month' : 'week';
      const cur = String(key || '');
      if (!cur) return null;
      const keys = reviewCross.keysBack(p, cur, reviewCross.MAX_LOOKBACK);
      const slots = keys.map(function (k) {
        // loadReview 是冻结 utils 的只读函数：键由调用方给，读上期不需要新增存储
        const res = domain.loadReview(p, k);
        const arr = (res && Array.isArray(res.data)) ? res.data : (Array.isArray(res) ? res : []);
        return { key: k, answers: arr };
      });
      return reviewCross.compare({
        period: p,
        key: cur,
        current: current,
        slots: slots,
        tasks: (gtdStore.read() || {}).tasks || []
      });
    },
    'trace.all': function () { return traceMod.all(traceStore.read()); },
    'trace.for': function (target) { return traceMod.listFor(traceStore.read(), target); },
    'trace.missing': function (ids) { return traceMod.markMissing(traceStore.read(), ids || []); },
    'trace.add': function (patch) {
      return traceStore.mutate(function (s) { return traceMod.add(s, patch || {}); });
    },
    'trace.remove': function (id) {
      return traceStore.mutate(function (s) { return traceMod.remove(s, id); });
    },
    'secure.encrypt': function (text, pass) {
      if (!pass) throw new Error('口令不能为空');
      return secureMod.encrypt(String(text || ''), String(pass));
    },
    'secure.decrypt': function (blob, pass) {
      if (!pass) throw new Error('口令不能为空');
      return secureMod.decrypt(blob, String(pass));
    },
    'secure.verify': function (blob, pass) {
      if (!pass) throw new Error('口令不能为空');
      return secureMod.verify(blob, String(pass));
    },
    'attach.list': function () { return attachMod.list(attachStore.read()); },
    'attach.add': function (p) {
      const s = attachStore.read();
      const next = attachMod.add(s, String(p || ''));
      if (!next) return null;
      attachStore.write(next);
      return next;
    },
    'attach.remove': function (id) {
      return attachStore.mutate(function (s) { return attachMod.remove(s, id); });
    },
    'attach.refresh': function () {
      return attachStore.mutate(function (s) { return attachMod.refresh(s); });
    },
    'attach.reconnect': function (missingPath, candidates) {
      return attachStore.mutate(function (s) { return attachMod.reconnect(s, missingPath, candidates || []); });
    },

    // ---- 图书馆 / 读书笔记：两类阅读共用一个笔记库 ----
    'reading.meta': function () { return readingMod.meta(); },
    // ---- 本地电子书：只登记路径，绝不把书的内容复制进库 ----
    'reading.addFiles': function (paths, themeId) {
      const list = Array.isArray(paths) ? paths : [];
      const tid = String(themeId || '');
      let added = 0, skipped = 0, relinked = 0;
      const errors = [];
      list.slice(0, 20).forEach(function (raw) {
        const p = String(raw || '').trim();
        if (!p) return;
        let st;
        try { st = fs.statSync(p); } catch (_) { errors.push('找不到：' + p); return; }
        if (!st.isFile()) { errors.push('不是文件：' + p); return; }
        if (!readingEpub.isAllowed(p)) { errors.push('格式不支持：' + p); return; }
        if (st.size > readingEpub.MAX_FILE_BYTES) { errors.push('超过 100MB：' + p); return; }
        let s = readingStore.read();
        if (readingMod.hasPath(s, p)) { skipped += 1; return; }
        const fp = readingFp.fingerprintSafe(p);
        // P0-2：先按内容指纹认书，再按路径去重。
        // 指纹命中 = 同一本书被改名或搬到别处，**不是**新书：
        //   旧路径还在 → 确实是重复文件，跳过；
        //   旧路径没了 → 就地重新关联（relinkBook 保持 bookId 不变），
        //                笔记 / 章节 / 书签 / 按书筛选全部原样跟着回来。
        const same = fp ? readingMod.bookByFingerprint(s, fp) : null;
        if (same) {
          if (same.filePath && fs.existsSync(same.filePath)) { skipped += 1; return; }
          const ext = readingEpub.extOf(p);
          readingStore.write(readingMod.relinkBook(s, same.id, {
            filePath: p, fileExt: ext, fileSize: st.size, fingerprint: fp,
            format: ext.toUpperCase()
          }));
          relinked += 1;
          return;
        }
        const ext = readingEpub.extOf(p);
        let meta = null;
        try { meta = readingEpub.inspect(p); } catch (_) { meta = null; }
        const title = (meta && meta.title) || readingEpub.titleFromPath(p);
        const author = (meta && meta.author) || '';
        const id = 'bk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        let coverId = '';
        if (meta && meta.cover && meta.cover.data) {
          try {
            if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
            coverId = id + '.' + meta.cover.ext;
            fs.writeFileSync(path.join(coverDir, coverId), meta.cover.data);
          } catch (_) { coverId = ''; }
        }
        s = readingMod.addBook(s, {
          id: id, themeId: tid, title: title, author: author,
          filePath: p, fileExt: ext, fileSize: st.size, fingerprint: fp,
          format: ext.toUpperCase(), coverId: coverId, source: 'file',
          total: 100, unit: '章', status: 'todo', createdAt: Date.now()
        });
        readingStore.write(s);
        added += 1;
      });
      return { added: added, skipped: skipped, relinked: relinked, errors: errors };
    },
    // 重新关联（P0-2）：书换了位置，id 不动。
    // 三道校验都在主进程做——领域层不读盘，渲染层拿不到 fs：
    //   ① 文件必须真的存在且是文件；② 扩展名必须是支持的那几种；
    //   ③ 若这本已有指纹，新文件的指纹必须一致（否则那是另一本书，应该走「添加」而不是「重新关联」）。
    // 大小不一致但指纹一致是允许的（同一次下载多带了附录），只更新 size。
    'reading.relinkBook': function (id, newPath) {
      const key = String(id || '');
      const p = String(newPath || '').trim();
      const s = readingStore.read();
      const b = s.books.filter(function (x) { return x.id === key; })[0];
      if (!b) return { ok: false, code: 'NO_BOOK', reason: '书架上找不到这本书' };
      if (!p) return { ok: false, code: 'NO_PATH', reason: '没有选择文件' };
      let st;
      try { st = fs.statSync(p); } catch (_) { return { ok: false, code: 'MISSING', reason: '这个文件不存在：' + p }; }
      if (!st.isFile()) return { ok: false, code: 'NOT_FILE', reason: '选中的不是文件' };
      if (!readingEpub.isAllowed(p)) return { ok: false, code: 'EXT', reason: '格式不支持（EPUB / PDF / TXT / MD / MOBI / AZW3）' };
      if (st.size > readingEpub.MAX_FILE_BYTES) return { ok: false, code: 'TOO_BIG', reason: '超过 100MB' };
      const fp = readingFp.fingerprintSafe(p);
      if (b.fingerprint && fp && b.fingerprint !== fp) {
        return { ok: false, code: 'NOT_SAME', reason: '这个文件和原来那本内容不一致，像是另一本书——请用「选择电子书」添加' };
      }
      const ext = readingEpub.extOf(p);
      const next = readingMod.relinkBook(s, key, {
        filePath: p, fileExt: ext, fileSize: st.size, fingerprint: fp, format: ext.toUpperCase()
      });
      readingStore.write(next);
      return { ok: true, id: key, filePath: p, fingerprint: fp || b.fingerprint || '', changedSize: st.size !== b.fileSize };
    },
    // 封面：优先用书里自带的那张图；没有才让渲染层回落到首字 / 渐变色。
    // 老书在旧版解析下可能没抽出封面（500KB 上限 / 只认 meta），这里按需补抽一次并落盘，
    // 下次直接走 coverId，不再重复解包。
    'reading.cover': function (id) {
      const s = readingStore.read();
      const b = s.books.filter(function (x) { return x.id === String(id || ''); })[0];
      if (!b) return '';
      const hit = coverDataUrl(b.coverId);
      if (hit) return hit;
      if (!b.filePath || String(b.fileExt || '').toLowerCase() !== 'epub') return '';
      if (!fs.existsSync(b.filePath)) return '';
      let sig = '';
      try { const st = fs.statSync(b.filePath); sig = st.mtimeMs + ':' + st.size; } catch (_) { return ''; }
      if (coverMiss.get(b.id) === sig) return '';
      let meta = null;
      try { meta = readingEpub.inspect(b.filePath); } catch (_) { meta = null; }
      if (!meta || !meta.cover || !meta.cover.data) { coverMiss.set(b.id, sig); return ''; }
      try {
        if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
        const cid = b.id + '.' + meta.cover.ext;
        fs.writeFileSync(path.join(coverDir, cid), meta.cover.data);
        readingStore.mutate(function (st) { return readingMod.updateBook(st, b.id, { coverId: cid }); });
        return coverDataUrl(cid);
      } catch (_) { return ''; }
    },
    'reading.revealBook': function (id) {
      const s = readingStore.read();
      const b = s.books.filter(function (x) { return x.id === String(id || ''); })[0];
      if (!b || !b.filePath || !fs.existsSync(b.filePath)) return { ok: false };
      shell.showItemInFolder(b.filePath);
      return { ok: true };
    },

    // ---- 独立阅读窗口（目录 / 正文 / 笔记）：只读打开，正文按章取 ----
    // 不返回文件内容本身，只返回目录与元数据；正文由 reading.readerChapter 一章一取。
    'reading.readerOpen': function (id) {
      const bookId = String(id || '');
      const now = new Date();
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      const todayStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
      const s = readingStore.read();
      const b = s.books.filter(function (x) { return x.id === bookId; })[0];
      // P0-1：不再回落到 md_growth 旧书单。旧条目本来就没有 filePath，
      // 回落到那里只会开出一个「没有文件」的阅读窗；不如直说该先迁移。
      if (!b) return { ok: false, reason: '书架上找不到这本书（学习成长里的旧书单请先导入图书馆）', today: todayStr };
      // V2.14：主题书已在 books 表里（themeId 非空），和休闲书走同一套 filePath 链路；
      // mode 由 themeId 决定，笔记落库时自动带 themeId 归到该主题下。
      const book = b ? {
        id: b.id, title: b.title, author: b.author,
        format: b.format || String(b.fileExt || '').toUpperCase(),
        filePath: b.filePath, done: b.done, total: b.total, unit: b.unit, status: b.status,
        cover: '', mode: b.themeId ? 'theme' : 'leisure',
        themeId: b.themeId || '', bookTitle: b.title
      } : {
        id: theme.bookId, title: theme.title, author: theme.author,
        format: String(theme.fileExt || 'BOOK').toUpperCase(),
        filePath: theme.filePath || '', done: theme.done, total: theme.total, unit: theme.unit,
        status: theme.status, cover: '', mode: 'theme', themeId: theme.themeId, bookTitle: theme.title
      };
      // 封面同样由主进程读成 dataURL：阅读窗口的 CSP 也不允许 file:
      if (b) book.cover = coverDataUrl(b.coverId);
      let source;
      if (!book.filePath) {
        source = { supported: false, reason: '这本没有关联本机电子书文件，只能在右侧记笔记', kind: '', toc: [], chapterCount: 0 };
      } else if (!fs.existsSync(book.filePath)) {
        source = { supported: false, reason: '原文件已不在原处，请回图书馆重新定位', kind: '', toc: [], chapterCount: 0 };
      } else {
        try {
          source = readerSource.openBook(book.filePath) || {};
        } catch (e) {
          source = { ok: false, supported: false, reason: '打开失败：' + ((e && e.message) || e), toc: [], chapterCount: 0 };
        }
        if (source.ok === false) source.supported = false;
      }
      return {
        ok: true,
        book: book,
        source: {
          supported: !!source.supported,
          reason: source.reason || '',
          kind: source.kind || '',
          format: source.format || book.format,
          toc: source.toc || [],
          chapterCount: source.chapterCount || 0
        },
        meta: readingMod.meta(),
        today: todayStr
      };
    },
    'reading.readerChapter': function (id, index) {
      const s = readingStore.read();
      const b = s.books.filter(function (x) { return x.id === String(id || ''); })[0];
      if (!b || !b.filePath) return { ok: false, html: '', title: '' };
      try {
        return readerSource.chapter(b.filePath, Number(index) || 0);
      } catch (e) {
        return { ok: false, html: '', title: '', reason: (e && e.message) || String(e) };
      }
    },
    // 翻到第几章 → 按比例折算 done。只前进不后退：往回翻不该抹掉已读进度。
    'reading.readerProgress': function (id, index, chapterCount) {
      const bookId = String(id || '');
      const s = readingStore.read();
      const b = s.books.filter(function (x) { return x.id === bookId; })[0];
      if (!b) return { ok: false };
      const total = Math.max(1, Number(chapterCount) || 1);
      const at = Math.min(Math.max(Number(index) || 0, 0), total - 1);
      const target = Math.round(((at + 1) / total) * (b.total || 100));
      // 无论进度有没有往前走，这一下都算「刚读过」：先打点再判进退，
      // 否则往回翻一章（进度不前进）就不会被记成最近在读，书架顺序看着像没动。
      readingStore.write(readingMod.touchBook(s, bookId, Date.now()));
      if (target <= (b.done || 0)) return { ok: true, done: b.done, total: b.total, status: b.status };
      const now = new Date();
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
      const cur = readingStore.read();
      readingStore.write(readingMod.advanceBook(cur, bookId, target - (b.done || 0), date));
      const after = readingStore.read().books.filter(function (x) { return x.id === bookId; })[0];
      return { ok: true, done: after ? after.done : target, total: after ? after.total : b.total, status: after ? after.status : b.status };
    },
    'reading.read': function () { return readingStore.read(); },
    // P0-1：不再把 md_growth 的旧书单透传进来（board() 也只有一个参数了）
    'reading.board': function () {
      const b = readingMod.board(readingStore.read());
      // 文件失效 / 大小是派生值，不落库：每次读 board 现算，文件移走立刻标灰。
      // V3.13：主题分组改由领域层派生（与书架同一口径：进度 / 状态 / 笔记数都齐），
      // 这里只补文件侧的两个派生值，三处（全部 / 书架 / 主题行）一视同仁。
      const withFile = function (x) {
        return Object.assign({}, x, {
          fileMissing: !!(x.filePath && !fs.existsSync(x.filePath)),
          fileSizeText: x.fileSize
            ? (x.fileSize >= 1048576 ? (x.fileSize / 1048576).toFixed(1) + ' MB'
              : Math.max(1, Math.round(x.fileSize / 1024)) + ' KB')
            : ''
        });
      };
      b.books = b.books.map(withFile);
      b.leisureBooks = (b.leisureBooks || []).map(withFile);
      b.themeGroups = (b.themeGroups || []).map(function (g) {
        return Object.assign({}, g, { rows: (g.rows || []).map(withFile) });
      });
      return b;
    },
    'reading.notes': function (opts) { return readingMod.notesQuery(readingStore.read(), opts || {}); },
    // 旧书单迁移核对（P0-1）：只读比对，告诉用户「学习成长里那 N 本还有几本没进图书馆」。
    // 旧书单本身不再进任何视图——它只剩这一个用途和一个迁移入口（reading.importGrowthThemes）。
    'reading.growthAudit': function () {
      return readingMod.growthAudit(readingStore.read(), themeBooksFlat());
    },
    // 书库体检（P0-4）：结构断链 + 指纹重复 + 同名异路径，只报告不自动改数据。
    // 文件在不在要读盘，所以「有没有关联文件」这一项由主进程补，不塞进领域层。
    'reading.audit': function () {
      const s = readingStore.read();
      const report = readingMod.audit(s);
      const missing = [];
      let noFp = 0;
      s.books.forEach(function (b) {
        if (!b.filePath) return;
        if (!fs.existsSync(b.filePath)) missing.push({ id: b.id, title: b.title, filePath: b.filePath });
        // 「这本有没有身份」也是派生值：老书在加指纹之前就登记了，得让用户看见还剩几本没指纹
        if (!b.fingerprint) noFp += 1;
      });
      report.missingFiles = missing;
      report.counts.missingFiles = missing.length;
      report.counts.booksNoFingerprint = noFp;
      return report;
    },
    // 一键修复：只清「指向不存在的东西」的那一个字段，不删任何书 / 笔记。
    // 返回的 changes 是撤销凭据，界面点「撤销本次修复」就把它原样传回 restore。
    'reading.repairDangling': function () {
      const out = readingMod.repairDangling(readingStore.read());
      if (out.fixed) readingStore.write(out.state);
      return { fixed: out.fixed, changes: out.changes };
    },
    'reading.restoreDangling': function (changes) {
      const next = readingMod.restoreDangling(readingStore.read(), changes || []);
      readingStore.write(next);
      return { restored: Array.isArray(changes) ? changes.length : 0 };
    },
    // 检索合流（P1-1）：把书库摊成可检索行，按关键词分组回给主界面。
    // 与 diary 检索共用一套匹配口径（同一个 query.js），两处结果不会一个会搜一个不会。
    'search.library': function (kw, mode) {
      const rows = readingMod.searchIndex(readingStore.read());
      const hits = String(mode) === 'pinyin'
        ? searchMod.indexPinyin(rows, String(kw || ''))
        : searchMod.indexSearch(rows, String(kw || ''));
      const out = { books: [], notes: [], themes: [], total: hits.length };
      hits.forEach(function (r) {
        if (r.type === 'book') out.books.push(r);
        else if (r.type === 'theme') out.themes.push(r);
        else if (out.notes.length < 50) out.notes.push(r);
        else out.notesMore = (out.notesMore || 0) + 1;
      });
      return out;
    },
    // 反向关联（P1-2）：只读派生。一本书 / 一条笔记后来被谁用到——日记里哪几行、生成了哪几条任务。
    // 零落库：每次都现算，改了日记右栏立刻跟着变。
    'reading.refs': function (bookId, noteId) {
      const s = readingStore.read();
      const bid = String(bookId || '');
      const nid = String(noteId || '');
      const notes = nid
        ? s.notes.filter(function (n) { return n.id === nid; })
        : s.notes.filter(function (n) { return bid && n.bookId === bid; });
      const noteIds = {};
      notes.forEach(function (n) { noteIds[n.id] = true; });
      const book = bid ? s.books.filter(function (b) { return b.id === bid; })[0] : null;
      const title = book ? book.title : (notes[0] ? notes[0].bookTitle : '');
      const res = diary.all();
      const diaryRows = [];
      ((res && res.data) || []).forEach(function (r) {
        const cells = (r && r.cells) || {};
        Object.keys(cells).forEach(function (cell) {
          const text = typeof cells[cell] === 'string' ? cells[cell] : '';
          if (!text) return;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            const ids = readingMod.refIdsIn(line);
            const byMark = ids.some(function (id) { return noteIds[id]; });
            // 没有标记的老回写行（加标记之前写的）只能按书名认：这一条是给老数据留的桥
            const byTitle = !nid && title && line.indexOf('《' + title + '》') >= 0 && line.indexOf('【读书·') >= 0;
            if (!byMark && !byTitle) continue;
            diaryRows.push({
              date: r.date, cell: cell,
              text: readingMod.stripRefMarks(line).slice(0, 200),
              noteId: ids.filter(function (id) { return noteIds[id]; })[0] || ''
            });
            if (diaryRows.length >= 30) return;
          }
        });
      });
      const tasks = ((gtdStore.read() || {}).tasks || []).filter(function (t) {
        const src = String((t && t.source) || '');
        return src.indexOf('rd:') === 0 && noteIds[src.slice(3)];
      }).map(function (t) {
        return { id: t.id, title: t.title, status: t.status, doneAt: t.doneAt || 0 };
      });
      return {
        bookId: bid, noteId: nid, title: title,
        noteCount: notes.length,
        theme: book && book.themeId ? (s.themes.filter(function (t) { return t.id === book.themeId; })[0] || null) : null,
        diary: diaryRows, tasks: tasks
      };
    },
    // #行动 落地（P1-3）：照 fl: 闪念→收件箱那条幂等先例，前缀换 rd:。
    // 重复点不叠加（按 source 判重），删笔记时连带清掉未完成的那条。
    'reading.pushAction': function (noteId) {
      const id = String(noteId || '');
      const s = readingStore.read();
      const n = s.notes.filter(function (x) { return x.id === id; })[0];
      if (!n) return { ok: false, reason: '找不到这条笔记' };
      const source = ('rd:' + id).slice(0, 32);
      const cur = gtdStore.read();
      const exists = (cur.tasks || []).filter(function (t) { return t && t.source === source; })[0];
      if (exists) return { ok: true, duplicated: true, taskId: exists.id, status: exists.status };
      const title = String(n.text || n.quote || '').replace(/\s+/g, ' ').trim().slice(0, 40)
        || ('读《' + (n.bookTitle || '这本书') + '》');
      gtdStore.mutate(function (st) {
        return gtd.addTask(st, {
          title: title, status: 'inbox', source: source,
          note: ('《' + (n.bookTitle || '') + '》' + (n.page > 0 ? ' p.' + n.page : '')).slice(0, 120)
        });
      });
      const after = (gtdStore.read().tasks || []).filter(function (t) { return t && t.source === source; })[0];
      return { ok: true, duplicated: false, taskId: after ? after.id : '' };
    },
    // 再曝光（P1-4）：最近一周摘了几条、哪些在读的书 30 天没碰。只读，点行进图书馆。
    'reading.resurface': function (at) { return readingMod.resurface(readingStore.read(), Number(at) || 0); },
    'reading.addBook': function (patch) {
      return readingStore.mutate(function (s) { return readingMod.addBook(s, patch || {}); });
    },
    'reading.updateBook': function (id, patch) {
      return readingStore.mutate(function (s) { return readingMod.updateBook(s, id, patch || {}); });
    },
    'reading.removeBook': function (id) {
      return readingStore.mutate(function (s) { return readingMod.removeBook(s, id); });
    },
    'reading.advanceBook': function (id, delta, date) {
      return readingStore.mutate(function (s) { return readingMod.advanceBook(s, id, delta, date || ''); });
    },
    'reading.setBookStatus': function (id, status, date) {
      return readingStore.mutate(function (s) { return readingMod.setBookStatus(s, id, status, date || ''); });
    },
    // ---- 书架整理（2026-11-14）：拖动排序 / 再读一遍 / 最近在读打点 ----
    // 三条都是纯状态改写：不碰文件、不开新通道，仍走同一条 domain 白名单。
    'reading.reorder': function (ids) {
      return readingStore.mutate(function (s) { return readingMod.reorderBooks(s, ids || []); });
    },
    'reading.reread': function (id, at) {
      return readingStore.mutate(function (s) { return readingMod.rereadBook(s, id, Number(at) || 0); });
    },
    'reading.touch': function (id, at) {
      return readingStore.mutate(function (s) { return readingMod.touchBook(s, id, Number(at) || 0); });
    },
    // V3.5 书架分组 / 收藏：分组只是书上的一个名字，重命名与删除都是领域层一次批量改字段
    'reading.setBookGroup': function (id, group) {
      return readingStore.mutate(function (s) { return readingMod.setBookGroup(s, id, group); });
    },
    'reading.setBookFavorite': function (id, on) {
      return readingStore.mutate(function (s) { return readingMod.setBookFavorite(s, id, on); });
    },
    'reading.renameGroup': function (from, to) {
      return readingStore.mutate(function (s) { return readingMod.renameGroup(s, from, to); });
    },
    'reading.removeGroup': function (name) {
      return readingStore.mutate(function (s) { return readingMod.removeGroup(s, name); });
    },
    // PDF 正文：主进程只给字节，解码与渲染全在阅读窗的本地 pdf.js 里做。
    // Buffer 经结构化克隆到渲染层就是 Uint8Array；不落临时文件、不联网、不改 CSP。
    'reading.readerPdfData': function (id) {
      const bookId = String(id || '');
      const b = readingStore.read().books.filter(function (x) { return x.id === bookId; })[0];
      if (!b || !b.filePath) return { ok: false, reason: '这本书没有关联本机文件' };
      if (String(path.extname(b.filePath)).toLowerCase() !== '.pdf') return { ok: false, reason: '不是 PDF 文件' };
      if (!fs.existsSync(b.filePath)) return { ok: false, reason: '原文件已不在原处' };
      try {
        const st = fs.statSync(b.filePath);
        if (st.size > readerSource.MAX_PDF_BYTES) {
          return { ok: false, reason: 'PDF 超过 ' + Math.round(readerSource.MAX_PDF_BYTES / 1048576) + 'MB，暂不打开' };
        }
        return { ok: true, data: fs.readFileSync(b.filePath) };
      } catch (e) {
        return { ok: false, reason: '读取失败：' + ((e && e.message) || String(e)) };
      }
    },
    // 换封面：渲染层只给「选中的图片路径」，复制进 covers/ 与写库都在主进程。
    // 这一点与「电子书只登记路径」不冲突——封面是展示用小图，不复制走一挪就断。
    'reading.setCover': function (id, srcPath) {
      const bookId = String(id || '');
      const from = String(srcPath || '');
      const found = readingStore.read().books.filter(function (x) { return x.id === bookId; })[0];
      if (!found) return { ok: false, reason: '书架上找不到这本书' };
      // 空路径 = 恢复默认封面（清掉 coverId，渲染层回落到首字/渐变色）
      if (!from) {
        readingStore.mutate(function (s) { return readingMod.updateBook(s, bookId, { coverId: '' }); });
        return { ok: true, reset: true };
      }
      let st;
      try { st = fs.statSync(from); } catch (_) { return { ok: false, reason: '图片打不开' }; }
      if (!st.isFile()) return { ok: false, reason: '不是图片文件' };
      if (st.size > 8 * 1024 * 1024) return { ok: false, reason: '图片超过 8MB' };
      const ext = readingEpub.extOf(from);
      if (['png', 'jpg', 'jpeg', 'gif', 'webp'].indexOf(ext) < 0) {
        return { ok: false, reason: '只支持 PNG / JPG / GIF / WEBP' };
      }
      const coverId = bookId + '.' + ext;
      try {
        if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
        fs.copyFileSync(from, path.join(coverDir, coverId));
      } catch (e) {
        return { ok: false, reason: '封面写入失败' };
      }
      readingStore.mutate(function (s) { return readingMod.updateBook(s, bookId, { coverId: coverId }); });
      return { ok: true };
    },
    // 豆瓣封面（V3.13）：先搜、再由用户点选，**绝不自动套用**。
    // 同名书太多（同一个书名能有十几个版本），自动挑一张等于替人认书；套错比没有更糟。
    // 发出去的只有书名（必要时加作者）——不带路径、不带笔记、不带任何日记字段。
    'reading.doubanCovers': function (id) {
      const bookId = String(id || '');
      const b = readingStore.read().books.filter(function (x) { return x.id === bookId; })[0];
      if (!b) return Promise.resolve({ ok: false, reason: '书架上找不到这本书', items: [] });
      return coverNet.suggest(b.title, b.author).then(function (r) {
        const list = (r && r.items) || [];
        if (!list.length) return { ok: true, items: [], keyword: '', empty: true };
        // 缩略图逐张取，一张失败不影响其他张：那一张在界面上就只有书名没有图
        return Promise.all(list.map(function (it) {
          if (!it.picHost || !it.picPath) return Object.assign({}, it, { thumb: '' });
          return coverNet.fetchCover(it.picHost, it.picPath).then(function (img) {
            return Object.assign({}, it, {
              thumb: 'data:image/' + (img.ext === 'jpg' ? 'jpeg' : img.ext) + ';base64,' + img.buf.toString('base64')
            });
          }).catch(function () { return Object.assign({}, it, { thumb: '' }); });
        })).then(function (items) { return { ok: true, items: items, keyword: r.keyword || '' }; });
      }).catch(function (e) {
        return { ok: false, reason: (e && e.message) || '豆瓣没搜到', items: [] };
      });
    },
    // 用户点中哪一张，就把那张落进 covers/ 并写 coverId；旧的那张顺手删掉，不留孤儿文件
    'reading.doubanApply': function (id, picHost, picPath) {
      const bookId = String(id || '');
      const found = readingStore.read().books.filter(function (x) { return x.id === bookId; })[0];
      if (!found) return Promise.resolve({ ok: false, reason: '书架上找不到这本书' });
      return coverNet.fetchCover(String(picHost || ''), String(picPath || '')).then(function (img) {
        const coverId = bookId + '.' + img.ext;
        try {
          if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
          fs.writeFileSync(path.join(coverDir, coverId), img.buf);
        } catch (_) {
          return { ok: false, reason: '封面写入失败' };
        }
        if (found.coverId && found.coverId !== coverId) {
          try { fs.unlinkSync(path.join(coverDir, found.coverId)); } catch (_) { /* 旧文件可能已经不在 */ }
        }
        readingStore.mutate(function (s) { return readingMod.updateBook(s, bookId, { coverId: coverId }); });
        return { ok: true, bytes: img.buf.length };
      }).catch(function (e) {
        return { ok: false, reason: (e && e.message) || '封面没取到' };
      });
    },
    // 本机字体：只读字体目录 + 解析 name 表，零子进程、零依赖（见 src/reading/fonts.js）
    'reading.systemFonts': function () { return readingFonts.list(); },
    'reading.addChapter': function (bookId, patch) {
      return readingStore.mutate(function (s) { return readingMod.addChapter(s, bookId, patch || {}); });
    },
    'reading.updateChapter': function (id, patch) {
      return readingStore.mutate(function (s) { return readingMod.updateChapter(s, id, patch || {}); });
    },
    'reading.removeChapter': function (id) {
      return readingStore.mutate(function (s) { return readingMod.removeChapter(s, id); });
    },
    'reading.addNote': function (patch) {
      return readingStore.mutate(function (s) { return readingMod.addNote(s, patch || {}); });
    },
    'reading.updateNote': function (id, patch) {
      return readingStore.mutate(function (s) { return readingMod.updateNote(s, id, patch || {}); });
    },
    'reading.removeNote': function (id) {
      const key = String(id || '');
      const out = readingStore.mutate(function (s) { return readingMod.removeNote(s, key); });
      // P1-3：笔记删了，它生成的任务不能留在收件箱里变成孤儿。
      // 只清「未完成」的那条：已完成的是既成事实（你确实做过），不该因为删笔记就消失。
      try {
        const source = ('rd:' + key).slice(0, 32);
        const hit = ((gtdStore.read() || {}).tasks || []).filter(function (t) {
          return t && t.source === source && t.status !== 'done';
        });
        if (hit.length) {
          gtdStore.mutate(function (st) {
            let next = st;
            hit.forEach(function (t) { next = gtd.removeTask(next, t.id); });
            return next;
          });
        }
      } catch (_) { /* 清理失败不影响删笔记本身 */ }
      return out;
    },
    'reading.markPushed': function (id, cell, at) {
      return readingStore.mutate(function (s) { return readingMod.markPushed(s, id, cell, at || 0); });
    },
    // ---- V2.14 主题阅读：书单权威源在 md_reading（themes + books[].themeId）----
    'reading.themes': function () { return themeGroupsFromReading(); },
    'reading.themeAdd': function (patch) {
      const before = readingStore.read();
      const after = readingStore.write(readingMod.addTheme(before, patch || {}));
      const fresh = (after.themes || []).filter(function (t) {
        return !(before.themes || []).some(function (x) { return x.id === t.id; });
      })[0];
      return { id: fresh ? fresh.id : '', ok: !!(after.themes.length > before.themes.length) };
    },
    'reading.themeUpdate': function (id, patch) {
      return readingStore.mutate(function (s) { return readingMod.updateTheme(s, id, patch || {}); });
    },
    'reading.themeRemove': function (id) {
      return readingStore.mutate(function (s) { return readingMod.removeTheme(s, id); });
    },
    // 一次性把 md_growth 旧主题书单 + 摘录迁进 md_reading（旧数据保留、可重复调用）
    'reading.importGrowthThemes': function () {
      const before = readingStore.read();
      const g = growthStore.read();
      const after = readingStore.write(readingMod.importGrowthThemes(before, g));
      const themeBefore = before.books.filter(function (b) { return !!b.themeId; }).length;
      const themeAfter = after.books.filter(function (b) { return !!b.themeId; }).length;
      return {
        addedThemes: after.themes.length - before.themes.length,
        addedBooks: themeAfter - themeBefore,
        addedNotes: after.notes.length - before.notes.length,
        changed: after.updatedAt !== before.updatedAt
      };
    },
    // 主题书翻页：主题书已在 md_reading.books，直接走 advanceBook；旧通道名保持不变
    'reading.themeAdvance': function (themeId, bookId, delta) {
      const now = new Date();
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
      return readingStore.mutate(function (s) { return readingMod.advanceBook(s, bookId, delta || 0, date); });
    },
    // 一次性把第 22 轮学习成长里的旧摘录汇进「读书笔记」，按 sourceQuoteId 去重
    'reading.importGrowthQuotes': function () {
      const g = growthStore.read();
      let st = readingStore.read();
      const seen = {};
      (st.notes || []).forEach(function (n) { if (n && n.sourceQuoteId) seen[n.sourceQuoteId] = 1; });
      let added = 0;
      (g.themes || []).forEach(function (t) {
        (t.books || []).forEach(function (b) {
          (b.quotes || []).forEach(function (q) {
            const sid = 'gq-' + t.id + '-' + b.id + '-' + q.id;
            if (seen[sid]) return;
            seen[sid] = 1;
            st = readingMod.addNote(st, {
              mode: 'theme', themeId: t.id, bookId: b.id, bookTitle: b.title || '',
              type: 'highlight', quote: q.text || '', text: '', page: q.page || 0,
              tags: [], chapterId: '', createdAt: q.createdAt || Date.now(), sourceQuoteId: sid
            });
            added += 1;
          });
        });
      });
      if (added) readingStore.write(st);
      return { added: added };
    },
    // 九格回写行由领域层唯一生成，保证「只追加、带出处」的口径不被视图各写一遍
    // ---- 书签 / 书内搜索（V2.6 R1）----
    'reading.bookmarks': function (bookId) {
      return readingMod.bookmarksOf(readingStore.read(), String(bookId || ''));
    },
    'reading.addBookmark': function (patch) {
      const next = readingMod.addBookmark(readingStore.read(), patch || {});
      readingStore.write(next);
      return readingMod.bookmarksOf(next, String((patch || {}).bookId || ''));
    },
    'reading.removeBookmark': function (id) {
      readingStore.write(readingMod.removeBookmark(readingStore.read(), String(id || '')));
      return { ok: true };
    },
    // 只读扫描：不落库、不快照正文，命中带章节号与前后文
    'reading.searchBook': function (bookId, keyword, limit) {
      const s = readingStore.read();
      const b = s.books.filter(function (x) { return x.id === String(bookId || ''); })[0];
      if (!b || !b.filePath) return { ok: false, reason: '这本书没有关联本机文件', hits: [], total: 0 };
      if (!fs.existsSync(b.filePath)) return { ok: false, reason: '原文件已不在原处', hits: [], total: 0 };
      try {
        return readerSource.search(b.filePath, String(keyword || ''), Number(limit) || 30);
      } catch (e) {
        return { ok: false, reason: (e && e.message) || String(e), hits: [], total: 0 };
      }
    },
    'reading.diaryLine': function (note) { return readingMod.noteToDiaryLine(note || {}); },
    'reading.exportMd': function (bookId) {
      return readingMod.exportMarkdown(readingStore.read(), bookId || '');
    },
    // ---- P2-1 虚拟书架：多值标签（规则集合在 board().shelves 里派生，不落库）----
    'reading.setBookTags': function (id, tags) {
      return readingStore.mutate(function (s) { return readingMod.setBookTags(s, id, tags); });
    },
    'reading.addBookTag': function (id, tag) {
      return readingStore.mutate(function (s) { return readingMod.addBookTag(s, id, tag); });
    },
    'reading.removeBookTag': function (id, tag) {
      return readingStore.mutate(function (s) { return readingMod.removeBookTag(s, id, tag); });
    },
    // ---- P2-2 书目清单：CSV / JSON / OPDS，只含元数据与路径 ----
    // 返回文本由渲染层走 v1/file:save 落盘——不另开一条写文件的路，和导出笔记/导出日记同一条。
    'reading.exportList': function (format) {
      return readingMod.exportList(readingStore.read(), format || 'csv');
    },
    // ---- P2-4 书库根目录 ----
    // 选目录走主进程 dialog：渲染层拿不到绝对路径，也不该拿。
    'reading.pickRoot': function () {
      // E2E 无法点击原生模态框：PROBE 下直接当作「用户取消」，不阻塞自动化
      if (PROBE) return { ok: false, canceled: true };
      const picked = dialog.showOpenDialogSync(mainWindow, {
        title: '选择书库根目录（电子书都放在这个目录下）',
        properties: ['openDirectory']
      });
      if (!picked || !picked.length) return { ok: false, canceled: true };
      return { ok: true, path: picked[0] };
    },
    'reading.addRoot': function (patch) {
      const p = patch || {};
      const dir = String(p.path || '');
      if (!dir) return { ok: false, reason: '没有选择目录' };
      try {
        if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: '选中的不是目录' };
      } catch (_) { return { ok: false, reason: '这个目录不存在：' + dir }; }
      const before = readingStore.read().roots.length;
      const next = readingStore.mutate(function (s) { return readingMod.addRoot(s, { path: dir, label: p.label }); });
      if (next.roots.length === before) return { ok: false, reason: '这个目录已经登记过，或已达到 ' + readingMod.MAX_ROOTS + ' 个上限' };
      const hit = next.roots.filter(function (r) { return r.path === dir; })[0];
      // 登记后顺手报一句「有多少本书挂到了这个根下」——这是用户唯一能验证「有没有生效」的数字
      const linked = next.books.filter(function (b) { return hit && b.rootId === hit.id; }).length;
      return { ok: true, rootId: hit ? hit.id : '', linked: linked };
    },
    // 换盘 / 改目录：只改一条根，所有挂在其下的书按 relPath 重算路径。
    // 校验在落库之前做：目录不存在就不改（否则整库路径会一起指到空气里，且很难回滚）。
    'reading.relocateRoot': function (id, newPath) {
      const key = String(id || '');
      const dir = String(newPath || '').replace(/[\\/]+$/, '');
      const st = readingStore.read();
      const root = (st.roots || []).filter(function (r) { return r.id === key; })[0];
      if (!root) return { ok: false, reason: '这个书库根已经不在了' };
      if (!dir) return { ok: false, reason: '没有选择目录' };
      try {
        if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: '选中的不是目录' };
      } catch (_) { return { ok: false, reason: '这个目录不存在：' + dir }; }
      const next = readingStore.mutate(function (s) { return readingMod.relocateRoot(s, key, dir); });
      const books = next.books.filter(function (b) { return b.rootId === key; });
      const missing = books.filter(function (b) { return !b.filePath || !fs.existsSync(b.filePath); }).length;
      return { ok: true, moved: books.length, missing: missing };
    },
    'reading.updateRoot': function (id, patch) {
      return readingStore.mutate(function (s) { return readingMod.updateRoot(s, id, patch || {}); });
    },
    'reading.removeRoot': function (id) {
      return readingStore.mutate(function (s) { return readingMod.removeRoot(s, String(id || '')); });
    },
    // 只读：某个根下现在有多少本、多少本找不到文件（换机后第一眼要看的就是这两个数）
    'reading.roots': function () {
      const s = readingStore.read();
      return (s.roots || []).map(function (r) {
        const books = s.books.filter(function (b) { return b.rootId === r.id; });
        let missing = 0;
        books.forEach(function (b) { if (!b.filePath || !fs.existsSync(b.filePath)) missing += 1; });
        return {
          id: r.id, label: r.label, path: r.path, createdAt: r.createdAt,
          books: books.length, missing: missing,
          exists: (function () { try { return fs.statSync(r.path).isDirectory(); } catch (_) { return false; } })()
        };
      });
    },

    // ---- 家庭账本（md_finance）：预算信封 + 条件→动作规则 + CSV 导入 ----
    // 口径：领域层只收/发整数 cents，月份由调用方给；不做账号、不做成员、不做同步。
    'finance.meta': function () { return financeMod.meta(); },
    'finance.board': function (month) {
      const m = month || (function () {
        const d = new Date(), mm = d.getMonth() + 1;
        return d.getFullYear() + '-' + (mm < 10 ? '0' + mm : String(mm));
      })();
      return financeMod.board(financeStore.read(), m);
    },
    'finance.read': function () { return financeStore.read(); },
    'finance.add': function (draft) {
      return financeStore.mutate(function (s) { return financeMod.addTxn(s, draft || {}); });
    },
    'finance.update': function (id, patch) {
      return financeStore.mutate(function (s) { return financeMod.updateTxn(s, id, patch || {}); });
    },
    'finance.remove': function (id) {
      return financeStore.mutate(function (s) { return financeMod.removeTxn(s, id); });
    },
    'finance.setBudget': function (patch) {
      return financeStore.mutate(function (s) { return financeMod.setBudget(s, patch || {}); });
    },
    'finance.removeBudget': function (id) {
      return financeStore.mutate(function (s) { return financeMod.removeBudget(s, id); });
    },
    'finance.addRule': function (patch) {
      return financeStore.mutate(function (s) { return financeMod.addRule(s, patch || {}); });
    },
    'finance.updateRule': function (id, patch) {
      return financeStore.mutate(function (s) { return financeMod.updateRule(s, id, patch || {}); });
    },
    'finance.removeRule': function (id) {
      return financeStore.mutate(function (s) { return financeMod.removeRule(s, id); });
    },
    'finance.addCategory': function (patch) {
      return financeStore.mutate(function (s) { return financeMod.addCategory(s, patch || {}); });
    },
    'finance.removeCategory': function (id) {
      return financeStore.mutate(function (s) { return financeMod.removeCategory(s, id); });
    },
    'finance.addAccount': function (patch) {
      return financeStore.mutate(function (s) { return financeMod.addAccount(s, patch || {}); });
    },
    'finance.removeAccount': function (id) {
      return financeStore.mutate(function (s) { return financeMod.removeAccount(s, id); });
    },
    // CSV：解码（UTF-8 BOM / GBK）、表头定位、去重、过规则全在领域层一次做完；
    // 主进程只负责把新状态落库，回执只给报告，不把整份账本回传渲染层。
    'finance.importCsv': function (opts) {
      const out = financeMod.importCsv(financeStore.read(), opts || {});
      if (out.report.added > 0) financeStore.write(out.state);
      return out.report;
    },
    'finance.exportCsv': function () { return financeMod.exportCsv(financeStore.read()); },

    // ---- 完整理财（只读视图）：账户/净值/损益/分类环比/目标/周期/订阅/检索/洞察 ----
    // 全部是同步纯函数，沿用 v1/domain:call；金额一律整数分，元只在渲染层出现。
    'finance.accountRows': function (month) { return financeMod.accountRows(financeStore.read(), month); },
    'finance.netWorth': function (month) { return financeMod.netWorth(financeStore.read(), month); },
    'finance.cashFlow': function (month) { return financeMod.cashFlow(financeStore.read(), month); },
    'finance.categoryReport': function (month) { return financeMod.categoryReport(financeStore.read(), month); },
    'finance.goalRows': function () { return financeMod.goalRows(financeStore.read()); },
    'finance.recurringRows': function (month) { return financeMod.recurringRows(financeStore.read(), month); },
    'finance.detectSubscriptions': function () { return financeMod.detectSubscriptions(financeStore.read()); },
    'finance.search': function (q) { return financeMod.searchTxns(financeStore.read(), q || {}); },
    'finance.insights': function (month) { return financeMod.insights(financeStore.read(), month); },
    // ---- 完整理财（写）----
    'finance.addGoal': function (patch) {
      return financeStore.mutate(function (s) { return financeMod.addGoal(s, patch || {}); });
    },
    'finance.updateGoal': function (id, patch) {
      return financeStore.mutate(function (s) { return financeMod.updateGoal(s, id, patch || {}); });
    },
    'finance.removeGoal': function (id) {
      return financeStore.mutate(function (s) { return financeMod.removeGoal(s, id); });
    },
    'finance.addRecurring': function (patch) {
      return financeStore.mutate(function (s) { return financeMod.addRecurring(s, patch || {}); });
    },
    'finance.updateRecurring': function (id, patch) {
      return financeStore.mutate(function (s) { return financeMod.updateRecurring(s, id, patch || {}); });
    },
    'finance.removeRecurring': function (id) {
      return financeStore.mutate(function (s) { return financeMod.removeRecurring(s, id); });
    },
    'finance.setAccountMeta': function (id, patch) {
      return financeStore.mutate(function (s) { return financeMod.setAccountMeta(s, id, patch || {}); });
    },
    'finance.bulkUpdate': function (ids, patch) {
      const out = financeMod.bulkUpdate(financeStore.read(), ids, patch || {});
      if (out.updated > 0) financeStore.write(out.state);
      return out.updated;
    },

    // ---- 与九格「金钱收支」格联动：只读汇总 + 用户点名才导入 ----
    // 九格按天把收支挂在 morning_diary_* 的 moneyBook.entries 上（cents 正整数 + type）。
    // 这里只遍历读取、标出哪些已导入过；绝不写日记，避免同一笔钱两处各记一半。
    'finance.moneyRows': function () {
      const fin = financeStore.read();
      const imported = {};
      fin.txns.forEach(function (t) { if (t.importedId) imported[t.importedId] = true; });
      const rows = [];
      repo.keys().forEach(function (k) {
        const m = /^morning_diary_(\d{4}-\d{2}-\d{2})$/.exec(k);
        if (!m) return;
        const rec = repo.get(k);
        const book = moneyBook.normalize(rec && rec.moneyBook);
        book.entries.forEach(function (e) {
          const iid = financeMod.moneyImportId(m[1], e.id);
          rows.push({
            id: e.id, date: m[1], type: e.type, cents: e.cents,
            category: e.category, note: e.note,
            importedId: iid, imported: !!imported[iid]
          });
        });
      });
      rows.sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); });
      return { rows: rows, pending: rows.filter(function (r) { return !r.imported; }).length };
    },
    'finance.importMoneyRows': function (rows) {
      const out = financeMod.importMoneyBook(financeStore.read(), rows || []);
      if (out.added > 0) financeStore.write(out.state);
      return { added: out.added, skipped: out.skipped };
    },

    // ---- V2.12 本机时间源：只读订阅 ActivityWatch ----
    // 写边界：本段没有任何「写回 ActivityWatch」的函数（不建 bucket、不打 tag）。
    // 唯一一次跨进程请求在 worktime.sync 里，方法固定 GET，主机固定回环。
    'worktime.read': function () { return worktimeStore.read(); },
    'worktime.meta': function () { return worktimeMod.meta(worktimeStore.read()); },
    'worktime.enable': function (on) {
      return worktimeStore.mutate(function (s) { return worktimeMod.setEnabled(s, on === true); });
    },
    'worktime.setHost': function (host) {
      return worktimeStore.mutate(function (s) { return worktimeMod.setHost(s, host); });
    },
    'worktime.setKeepDays': function (n) {
      return worktimeStore.mutate(function (s) { return worktimeMod.setKeepDays(s, n); });
    },
    'worktime.setToken': function (token) {
      return worktimeStore.mutate(function (s) { return worktimeMod.setToken(s, token); });
    },
    'worktime.addRule': function (patch) {
      return worktimeStore.mutate(function (s) { return worktimeMod.addRule(s, patch || {}); });
    },
    'worktime.updateRule': function (id, patch) {
      return worktimeStore.mutate(function (s) { return worktimeMod.updateRule(s, id, patch || {}); });
    },
    'worktime.removeRule': function (id) {
      return worktimeStore.mutate(function (s) { return worktimeMod.removeRule(s, id); });
    },
    'worktime.day': function (date) {
      return worktimeMod.dayOf(worktimeStore.read(), String(date || ''));
    },
    // 工作视图投入条一次拿全：开关态 + 当天聚合 + 规则（要标签）+ 保留期
    'worktime.dayForView': function (date) {
      const s = worktimeStore.read();
      return {
        enabled: s.enabled,
        host: s.host,
        keepDays: s.keepDays,
        rules: s.rules,
        day: worktimeMod.dayOf(s, String(date || '')),
        error: s.lastError
      };
    },
    'worktime.week': function (endDate) {
      const s = worktimeStore.read();
      const dates = [];
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(endDate || ''));
      if (!m) return worktimeMod.weekStats(s, []);
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - i);
        const p = function (n) { return (n < 10 ? '0' : '') + n; };
        dates.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
      }
      return worktimeMod.weekStats(s, dates);
    },
    'worktime.clearDays': function () {
      return worktimeStore.mutate(function (s) { return worktimeMod.clearDays(s); });
    },
    'worktime.clearError': function () {
      return worktimeStore.mutate(function (s) { return worktimeMod.clearError(s); });
    },
    // 同步：唯一会发 HTTP 的领域函数（异步，走 v1/worktime:sync 专用通道）
    'worktime.sync': function (date) {
      const s = worktimeStore.read();
      const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : diary.today();
      if (!s.enabled) return Promise.resolve({ ok: false, code: 'NOT_ENABLED', msg: '本机时间源未开启' });
      const bounds = localDayBounds(d);
      if (!bounds) return Promise.resolve({ ok: false, code: 'BAD_DATE', msg: '日期不合法' });
      return worktimeClient.collect({
        host: s.host,
        token: s.token,
        dayStart: bounds.start,
        dayEnd: bounds.end
      }).then(function (raw) {
        const out = worktimeAgg.aggregate({
          windowEvents: raw.windowEvents,
          afkEvents: raw.afkEvents,
          rules: s.rules,
          dayStart: bounds.start,
          dayEnd: bounds.end
        });
        // 聚合输出的是绝对毫秒，落库改存「相对当天 0 点的分钟」——跨时区无意义，还能省字节
        const blocks = out.blocks.map(function (b) {
          return [
            Math.round((b.start - bounds.start) / 60000),
            Math.round((b.end - bounds.start) / 60000),
            b.ruleId || '',
            b.app || ''
          ];
        });
        const day = Object.assign({}, out, { blocks: blocks, syncedAt: Date.now() });
        worktimeStore.mutate(function (st) { return worktimeMod.applyDay(st, d, day); });
        return {
          ok: true,
          date: d,
          hostname: raw.hostname,
          version: raw.version,
          partial: raw.partial,
          day: worktimeMod.dayOf(worktimeStore.read(), d)
        };
      }).catch(function (e) {
        const code = (e && e.code) || 'AW_ERROR';
        const msg = (e && e.message) || '同步失败';
        worktimeStore.mutate(function (st) { return worktimeMod.setError(st, code, msg); });
        return { ok: false, code: code, msg: msg };
      });
    },
    // 回写：把一段时间写进当天工作格。只追加、幂等、行在就不重复写（自愈）
    'worktime.writeLine': function (date, key) {
      const s = worktimeStore.read();
      const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : '';
      const day = worktimeMod.dayOf(s, d);
      if (!day) return { ok: false, code: 'NO_DATA', msg: '这一天还没有本机投入数据' };
      const k = String(key || '');
      const b = (day.blocks || []).filter(function (x) { return worktimeMod.blockKey(x) === k; })[0];
      if (!b) return { ok: false, code: 'NO_BLOCK', msg: '找不到这段时间' };
      const rule = (s.rules || []).filter(function (r) { return r.id === b[2]; })[0];
      const line = worktimeMod.blockLine(b, rule ? rule.label : '未归类', b[3]);
      const loaded = diary.load(d);
      if (!loaded || loaded.error || !loaded.data) return { ok: false, code: 'NO_RECORD', msg: '读不到这一天的记录' };
      const rec = loaded.data;
      const cur = String((rec.cells && rec.cells.work) || '');
      if (worktimeMod.hasLine(cur, line)) return { ok: true, already: true, line: line, record: rec };
      const next = Object.assign({}, rec, {
        cells: Object.assign({}, rec.cells || {}, { work: (cur.replace(/\s+$/, '') ? cur.replace(/\s+$/, '') + '\n' : '') + line })
      });
      const saved = diary.save(next);
      if (!saved || saved.error) return { ok: false, code: 'SAVE_FAILED', msg: '写入失败' };
      worktimeStore.mutate(function (st) { return worktimeMod.markWritten(st, d, k); });
      return { ok: true, line: line, record: saved.data };
    },

    // ---- 首页天气与位置（md_weather）----
    // 读：只给偏好 + 内存缓存，不联网。首屏先拿到「上次的温度」再决定要不要刷新，
    // 这样断网时首页仍然有数，不会白着一块。
    'weather.view': function () {
      return weatherMod.view(weatherStore.read(), weatherCache, Date.now());
    },
    'weather.setEnabled': function (on) {
      const s = weatherStore.mutate(function (st) { return weatherMod.setEnabled(st, on === true); });
      // 关掉即清缓存：留着会让人以为「关了还在偷偷取」
      if (!s.enabled) weatherCache = { report: null, fetchedAt: 0, ttl: WEATHER_TTL, error: null };
      return weatherMod.view(s, weatherCache, Date.now());
    },
    'weather.setMode': function (mode) {
      const s = weatherStore.mutate(function (st) { return weatherMod.setMode(st, mode); });
      weatherCache = { report: null, fetchedAt: 0, ttl: WEATHER_TTL, error: null };
      return weatherMod.view(s, weatherCache, Date.now());
    },
    'weather.setCity': function (city, place) {
      const s = weatherStore.mutate(function (st) { return weatherMod.setCity(st, city, place); });
      weatherCache = { report: null, fetchedAt: 0, ttl: WEATHER_TTL, error: null };
      return weatherMod.view(s, weatherCache, Date.now());
    },
    'weather.clearCity': function () {
      const s = weatherStore.mutate(function (st) { return weatherMod.clearCity(st); });
      weatherCache = { report: null, fetchedAt: 0, ttl: WEATHER_TTL, error: null };
      return weatherMod.view(s, weatherCache, Date.now());
    },
    'weather.setUnit': function (unit) {
      const s = weatherStore.mutate(function (st) { return weatherMod.setUnit(st, unit); });
      return weatherMod.view(s, weatherCache, Date.now());
    },
    // 取：唯一会发远程 HTTP 的领域函数之一（另一条是本机时间源）。
    // 关闭态直接返回 NOT_ENABLED，连一次 DNS 都不做——这条是「关了就是真关」的证据。
    'weather.sync': function (force) {
      const s = weatherStore.read();
      if (!s.enabled) return Promise.resolve({ ok: false, code: 'NOT_ENABLED', msg: '首页天气未开启' });
      if (s.mode === 'city' && !s.place) {
        return Promise.resolve({ ok: false, code: 'NO_CITY', msg: '还没有选好城市', view: weatherMod.view(s, weatherCache, Date.now()) });
      }
      const now = Date.now();
      const ttl = weatherCache.error ? WEATHER_FAIL_TTL : WEATHER_TTL;
      const fresh = weatherCache.report && (now - weatherCache.fetchedAt) < ttl;
      if (!force && fresh) {
        return Promise.resolve({ ok: true, cached: true, view: weatherMod.view(s, weatherCache, now) });
      }
      return weatherClient.collect({ place: s.mode === 'city' ? s.place : null }).then(function (raw) {
        const at = Date.now();
        const report = weatherMod.pack(raw.place, raw.current, raw.daily, at);
        weatherCache = { report: report, fetchedAt: at, ttl: WEATHER_TTL, error: null };
        return { ok: true, view: weatherMod.view(weatherStore.read(), weatherCache, at) };
      }).catch(function (e) {
        const err = {
          at: Date.now(),
          code: (e && e.code) || 'WEATHER_ERROR',
          msg: (e && e.message) || '取天气失败'
        };
        // 失败不清掉上次的 report：显示「昨天的温度 + 出错提示」比显示空白有用，
        // 但 stale 标记会让界面把它写灰，不假装是最新的。
        weatherCache = {
          report: weatherCache.report,
          fetchedAt: weatherCache.fetchedAt,
          ttl: WEATHER_TTL,
          error: err
        };
        return { ok: false, code: err.code, msg: err.msg, view: weatherMod.view(weatherStore.read(), weatherCache, Date.now()) };
      });
    },
    // 手填城市：检索一次拿坐标，再交给 setCity 落库（两步分开，失败不会写坏偏好）
    'weather.geocode': function (name) {
      return weatherClient.geocode(String(name || '')).then(function (place) {
        const s = weatherStore.mutate(function (st) { return weatherMod.setCity(st, place.label, place); });
        weatherCache = { report: null, fetchedAt: 0, ttl: WEATHER_TTL, error: null };
        return { ok: true, place: place, view: weatherMod.view(s, weatherCache, Date.now()) };
      }).catch(function (e) {
        return { ok: false, code: (e && e.code) || 'WEATHER_ERROR', msg: (e && e.message) || '找不到这个城市' };
      });
    },

    // ---- 封存箱（软删除）：删除不再等于销毁 ----
    'recycle.list': function () { return recycle.list(); },
    'recycle.seal': function (date) { return recycle.seal(date); },
    'recycle.restore': function (key) { return recycle.restore(key); },
    'recycle.purge': function (key) { return recycle.purge(key); },
    'recycle.empty': function () { return recycle.empty(); },
    'recycle.sweep': function () { return recycle.sweep(); },

    // ---- 内联状态提示：每一格最后一次写的是哪天 ----
    // all() 走 memo 缓存，9 个格共用一次遍历，不必每格调一次
    'cell.lastWrittenMap': function () {
      const res = diary.all();
      const list = (res && res.data) || [];
      const out = {};
      for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        const cells = (rec && rec.cells) || {};
        Object.keys(cells).forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(out, k)) return;
          if (String(cells[k] || '').trim()) out[k] = rec.date;
        });
      }
      return out;
    },

    // ---- 自由记录（md_freewrite）：闪念 / 长文 / 胶囊只读派生 ----
    'free.board': function () { return freeStore.read(); },
    // 九格第 9 格只读派生：某一天的闪念 + 长文 + 胶囊（只给条数，不给封存正文）。
    // 三合一是唯一写入口，九格这一格只回答「今天在这里记了什么」，
    // 所以不把 cells.free 混进来——那是日记正文，由渲染层自己从 record 读。
    'free.day': function (date) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : isoDayNow();
      const s = freeStore.read();
      const flashes = (Array.isArray(s.flashes) ? s.flashes : []).filter(function (f) {
        return String(f.date || isoDayOf(f.createdAt)) === day;
      });
      const docs = (Array.isArray(s.docs) ? s.docs : []).filter(function (d) {
        return isoDayOf(d.updatedAt || d.createdAt) === day;
      }).map(function (d) {
        return {
          id: d.id, title: d.title,
          chars: String(d.body || '').length,
          updatedAt: Number(d.updatedAt) || 0
        };
      });
      let capsules = 0;
      try {
        const res = diary.listCapsules();
        const list = Array.isArray(res && res.data) ? res.data : [];
        capsules = list.filter(function (c) {
          return String((c && c.writtenAt) || '').slice(0, 10) === day;
        }).length;
      } catch (e) { capsules = 0; }
      return {
        date: day,
        flashes: flashes.slice(0, 20),
        docs: docs.slice(0, 20),
        counts: { flash: flashes.length, doc: docs.length, capsule: capsules }
      };
    },
    // 胶囊信息收录：只派生元信息。封存中的信连正文都不往渲染层送，
    // 避免「界面不显示但 IPC 里已经有了」的假保密（沿用 CapsuleContext 老口径）。
    'free.capsuleIndex': function () {
      const res = diary.listCapsules();
      const list = Array.isArray(res && res.data) ? res.data : [];
      const now = isoDayNow();
      return list.map(function (c) {
        const x = c || {};
        const due = !x.opened && String(x.openAt || '') <= now;
        const readable = !!x.opened || due;
        return {
          id: String(x.id || ''), openAt: String(x.openAt || ''),
          writtenAt: String(x.writtenAt || ''), opened: !!x.opened,
          due: due, sealed: !x.opened && !due,
          text: readable ? String(x.text || '') : '',
          preview: readable ? String(x.text || '').slice(0, 40) : ''
        };
      }).filter(function (r) { return !!r.id; });
    },
    // 闪念 → 收件箱：一次调用里完成「原文落库 + 按 source 幂等生成 inbox 任务」。
    'free.flashAdd': function (text, date) {
      const before = {};
      freeStore.read().flashes.forEach(function (f) { before[f.id] = true; });
      const state = freeStore.mutate(function (s) {
        return freeMod.addFlash(s, { text: text, date: date });
      });
      const added = state.flashes.filter(function (f) { return !before[f.id]; });
      if (!added.length) return { item: null, synced: false, reason: 'EMPTY_OR_FULL' };
      const ok = syncFlash(added[0]);
      return { item: freeMod.findFlash(freeStore.read(), added[0].id), synced: ok };
    },
    // 只留原文的闪念：速记的「自由记录」去处、九格第 9 格的一句话、任务转发。
    // 与 flashAdd 的唯一差别是不生成收件箱任务——这些是当日记号，不是待办。
    'free.noteAdd': function (text, date) {
      const before = {};
      freeStore.read().flashes.forEach(function (f) { before[f.id] = true; });
      const state = freeStore.mutate(function (s) {
        return freeMod.addNote(s, { text: text, date: date });
      });
      const added = state.flashes.filter(function (f) { return !before[f.id]; });
      if (!added.length) return { item: null, synced: false, reason: 'EMPTY_OR_FULL' };
      return { item: freeMod.findFlash(freeStore.read(), added[0].id), synced: false };
    },
    'free.flashRetry': function (id) {
      const f = freeMod.findFlash(freeStore.read(), id);
      if (!f) return { item: null, synced: false };
      const ok = syncFlash(f);
      return { item: freeMod.findFlash(freeStore.read(), id), synced: ok };
    },
    'free.flashSyncPending': function () {
      const list = freeMod.pendingSync(freeStore.read());
      let done = 0;
      list.forEach(function (f) { if (syncFlash(f)) done += 1; });
      return { total: list.length, synced: done };
    },
    // Q3 A：删闪念时一并删掉对应「未完成」的收件箱任务，两边都不留孤儿。
    'free.flashRemove': function (id) {
      const f = freeMod.findFlash(freeStore.read(), id);
      if (!f) return freeStore.read();
      try {
        const hit = (gtdStore.read().tasks || []).filter(function (t) {
          return t && t.source === f.source && t.status !== 'done';
        });
        hit.forEach(function (t) {
          gtdStore.mutate(function (s) { return gtd.removeTask(s, t.id); });
        });
      } catch (e) { /* 任务删不掉也不拦着删闪念 */ }
      freeStore.mutate(function (s) { return freeMod.removeFlash(s, id); });
      return freeStore.read();
    },
    'free.docAdd': function (patch) {
      freeStore.mutate(function (s) { return freeMod.addDoc(s, patch || {}); });
      return freeStore.read();
    },
    'free.docUpdate': function (id, patch) {
      freeStore.mutate(function (s) { return freeMod.updateDoc(s, id, patch || {}); });
      return freeStore.read();
    },
    'free.docRemove': function (id) {
      freeStore.mutate(function (s) { return freeMod.removeDoc(s, id); });
      return freeStore.read();
    },
    'free.prefs': function (patch) {
      freeStore.mutate(function (s) { return freeMod.setPrefs(s, patch || {}); });
      return freeStore.read().prefs;
    },

    // ---- 家庭亲子（md_family）：成员档案 / 亲子时刻 / 成长足迹 ----
    // 写路由只回原始状态，派生（本周陪伴 / 覆盖几人 / 距上次几天）统一走 family.board，
    // 与关系经营「派生值读时算」同一口径——界面每次写完重取一次，不在这里各算一份。
    'family.meta': function () { return familyMod.meta(); },
    'family.board': function (today) { return familyMod.board(familyStore.read(), today); },
    'family.addMember': function (patch) {
      familyStore.mutate(function (s) { return familyMod.addMember(s, patch || {}); });
      return familyStore.read();
    },
    'family.updateMember': function (id, patch) {
      familyStore.mutate(function (s) { return familyMod.updateMember(s, id, patch || {}); });
      return familyStore.read();
    },
    // 删成员只删档案，历史时刻保留（归属人显示为空，但那天发生过什么不会被抹掉）
    'family.removeMember': function (id) {
      familyStore.mutate(function (s) { return familyMod.removeMember(s, id); });
      return familyStore.read();
    },
    'family.addMoment': function (patch) {
      familyStore.mutate(function (s) { return familyMod.addMoment(s, patch || {}); });
      return familyStore.read();
    },
    'family.removeMoment': function (id) {
      familyStore.mutate(function (s) { return familyMod.removeMoment(s, id); });
      return familyStore.read();
    },
    'family.addMilestone': function (patch) {
      familyStore.mutate(function (s) { return familyMod.addMilestone(s, patch || {}); });
      return familyStore.read();
    },
    'family.removeMilestone': function (id) {
      familyStore.mutate(function (s) { return familyMod.removeMilestone(s, id); });
      return familyStore.read();
    },
    'family.prefs': function (patch) {
      familyStore.mutate(function (s) { return familyMod.setPrefs(s, patch || {}); });
      return familyStore.read().prefs;
    },
    // 写作法体检：本地纯函数，只给定位与计数，不给改写文本、不联网、不落库。
    'writing.check': function (text) { return writingCheck.analyze(text); },
    'writing.cards': function () { return writingCheck.cards; },

    // ---- 胶囊写信日映射 ----
    // capsuleGroups() 只给"还有几天开启"，不给"已经封存了几天"。
    // writtenAt 在原始 listCapsules() 里有，补一个 id → writtenAt 的映射，界面自己算天数。
    'capsule.writtenMap': function () {
      const res = diary.listCapsules();
      const list = Array.isArray(res && res.data) ? res.data : [];
      const out = {};
      list.forEach(function (c) {
        if (!c || !c.id) return;
        out[c.id] = { writtenAt: String(c.writtenAt || ''), createdAt: Number(c.createdAt) || 0 };
      });
      return out;
    }
  });

  // 封存箱实例：onChanged 负责让 diary-store 的 memo 失效
  recycle = createRecycle({
    repository: repo,
    onChanged: function () { reloadDiary(); }
  });
  // 启动即清一次超期条目（30 天前封存的直接焚毁）
  const swept = recycle.sweep();

  // 备份包装：utils 的 exportBackup 是固定字段清单，不会带上 md_gtd 与封存箱。
  // 这里在结果里注入 gtd / bin 两段，导入时先摘出来再委托原逻辑（只补不改，与原口径一致）。
  // 注意 rawExportBackup 不能在 reload 后继续用旧引用，改成每次取 diary 上的最新函数。
  domain.exportBackup = function () {
    const res = diary.exportBackup();
    if (!res || res.error) return res;
    try {
      const obj = JSON.parse(res.data);
      obj.gtd = gtdStore.read();
      obj.gtdVersion = 1;
      // 梦想也不在日记记录里，导出必须显式带上
      obj.dream = dreamStore.read();
      obj.dreamVersion = 1;
      // 学习成长三张表同样不在日记记录里（旧学习库由 utils 的 exportBackup 负责）
      obj.growth = growthStore.read();
      obj.growthVersion = 1;
      // 语料库只带「我的 + 覆盖 + 隐藏」，内置文案在代码里，不必也不该塞进备份
      obj.inspire = inspireStore.read();
      obj.inspireVersion = 1;
      // V2.0 / V2.1 的六个新键：utils 的 exportBackup 只认固定字段清单，
      // 不在这里显式注入，换机后这些模块的数据会静默丢失。
      obj.tags = tagsStore.read();
      obj.tagsVersion = 1;
      obj.recur = recurStore.read();
      obj.recurVersion = 1;
      obj.relation = relationStore.read();
      obj.relationVersion = 1;
      obj.termReview = termStore.read();
      obj.termReviewVersion = 1;
      obj.trace = traceStore.read();
      obj.traceVersion = 1;
      obj.attach = attachStore.read();
      obj.attachVersion = 1;
      // 图书馆 / 读书笔记：休闲书 + 章节 + 全部笔记（主题书单在 growth 段里，不重复）
      obj.reading = readingStore.read();
      obj.readingVersion = 1;
      // 家庭账本：分类 / 账户 / 流水 / 预算 / 规则全量带走，换机后预算不用重设
      obj.finance = financeStore.read();
      obj.financeVersion = 1;
      // 自由记录：闪念 / 长文 / 偏好全量带走。胶囊不在这里——它随日记备份走，不复制。
      obj.freewrite = freeStore.read();
      obj.freewriteVersion = 1;
      // 家庭亲子：成员 / 时刻 / 足迹三段全量带走，换机后不用重录生日与学校
      obj.family = familyStore.read();
      obj.familyVersion = 1;
      // 本机时间源：规则 + 日聚合。**不含任何窗口标题**（契约里就没有这个字段）
      obj.worktime = worktimeStore.read();
      obj.worktimeVersion = 1;
      // 封存箱带完整原文：换机后还能还原。
      // 正文导出（txt / Markdown / JSON 的 records）不含已封存记录——那是另一条路径。
      obj.bin = recycle.snapshotForBackup();
      return { data: JSON.stringify(obj, null, 0), error: null };
    } catch (e) {
      return res;
    }
  };
  domain.importBackup = function (text) {
    let section = null;
    let binSection = null;
    let dreamSection = null;
    let growthSection = null;
    let inspireSection = null;
    let v2Sections = {};
    try {
      const parsed = JSON.parse(String(text || ''));
      section = parsed && parsed.gtd ? parsed.gtd : null;
      binSection = parsed && parsed.bin ? parsed.bin : null;
      dreamSection = parsed && parsed.dream ? parsed.dream : null;
      growthSection = parsed && parsed.growth ? parsed.growth : null;
      inspireSection = parsed && parsed.inspire ? parsed.inspire : null;
      v2Sections = parsed || {};
    } catch (e) {
      section = null;
      binSection = null;
    }
    const res = diary.importBackup(text);
    const report = res && res.data ? res.data : null;
    if (section && report && !res.error) {
      try {
        const merged = gtd.mergeSection(gtdStore.read(), section);
        gtdStore.write(merged.state);
        report.gtdImported = merged.added;
      } catch (e) {
        report.gtdError = 'GTD 段写入失败，日记部分已导入';
      }
    }
    if (binSection && report && !res.error) {
      try {
        const mergedBin = recycle.mergeFromBackup(binSection);
        report.binImported = mergedBin.added;
      } catch (e) {
        report.binError = '封存箱段写入失败，日记部分已导入';
      }
    }
    if (dreamSection && report && !res.error) {
      try {
        const mergedDream = dream.mergeSection(dreamStore.read(), dreamSection);
        dreamStore.write(mergedDream.state);
        report.dreamImported = mergedDream.added;
      } catch (e) {
        report.dreamError = '梦想段写入失败，日记部分已导入';
      }
    }
    if (growthSection && report && !res.error) {
      try {
        const mergedGrowth = growth.mergeSection(growthStore.read(), growthSection);
        growthStore.write(mergedGrowth.state);
        report.growthImported = mergedGrowth.added;
      } catch (e) {
        report.growthError = '学习成长段写入失败，日记部分已导入';
      }
    }
    if (inspireSection && report && !res.error) {
      try {
        const mergedInspire = inspire.mergeSection(inspireStore.read(), inspireSection);
        inspireStore.write(mergedInspire.state);
        report.inspireImported = mergedInspire.added;
      } catch (e) {
        report.inspireError = '语料库段写入失败，日记部分已导入';
      }
    }
    // V2.0 / V2.1 六个新段统一走 mergeSection：只补不改、幂等。
    // 任一段失败都单独报告，不影响日记主体已导入的部分。
    const V2_SECTIONS = [
      ['tags', tagsStore, tagsMod],
      ['recur', recurStore, recurMod],
      ['relation', relationStore, relationMod],
      ['termReview', termStore, termMod],
      ['trace', traceStore, traceMod],
      ['attach', attachStore, attachMod],
      ['reading', readingStore, readingMod],
      ['finance', financeStore, financeMod],
      ['freewrite', freeStore, freeMod],
      ['family', familyStore, familyMod],
      ['worktime', worktimeStore, worktimeMod]
    ];
    V2_SECTIONS.forEach(function (entry) {
      const key = entry[0];
      const store = entry[1];
      const mod = entry[2];
      const sec = v2Sections && v2Sections[key];
      if (!sec || !report || res.error) return;
      try {
        if (typeof mod.mergeSection === 'function') {
          const merged = mod.mergeSection(store.read(), sec);
          const next = merged && merged.state ? merged.state : merged;
          store.write(next);
          report[key + 'Imported'] = merged && typeof merged.added === 'number' ? merged.added : 0;
          // P0-3：导入不校验引用，就会把「指向不存在的书」的笔记一起搬进来，
          // 表现为「笔记都在、按书筛却一条都没有」。这里把体检结论一并回给界面，
          // 但不删任何一条——脏数据要不要清，是用户点一次「修复断链」的事。
          if (merged && merged.report) report[key + 'Report'] = merged.report;
        } else {
          // recur 没有 mergeSection：只把对侧本机没有的分钟日志补进来，
          // 重复任务是派生数据，不跨机合并（否则会造出两份真相）。
          const cur = store.read();
          const seen = {};
          (cur.logs || []).forEach(function (l) { if (l && l.id) seen[l.id] = 1; });
          const add = (Array.isArray(sec.logs) ? sec.logs : []).filter(function (l) {
            return l && l.id && !seen[l.id];
          });
          if (add.length) store.write(Object.assign({}, cur, { logs: (cur.logs || []).concat(add) }));
          report[key + 'Imported'] = add.length;
        }
      } catch (e) {
        report[key + 'Error'] = key + ' 段写入失败，日记部分已导入';
      }
    });
    return res;
  };

  // ---- 数据健康中心 ----
  // persistence.createSnapshot / listSnapshots / restoreSnapshot 从 Phase 2 就写好了，
  // 主进程一次都没调用过（"差一根线"）。这里接上"启动一份 + 定时一份 + 滚动保留"，
  // 并把状态翻译成用户看得懂的话——数据层其实很强，只是一直没告诉用户。
  function snapshotDirOf(id) { return path.join(dataDir, 'snapshots', id); }

  // ---- 可回滚版本：列出 / 回滚（整改 R-10）----
  // 术语按 D8 统一：这里叫「可回滚版本」，与数据中心页的「导出记录」、
  // 健康卡里的「数据快照数量」是三个不同的东西，文案不混用。
  const SNAPSHOT_ID_RE = /^\d{10,16}-[A-Za-z0-9_-]{1,40}$/;

  function listRestorable() {
    return persistence.listSnapshots(dataDir).map(function (id) {
      let meta = null, createdAt = '', bytes = 0;
      try {
        meta = persistence.readJsonSafe(path.join(snapshotDirOf(id), 'meta.json'));
        createdAt = (meta && meta.createdAt) || '';
      } catch (e) { /* 元数据缺失不影响列出 */ }
      const snapFile = path.join(snapshotDirOf(id), 'store.json');
      try { bytes = fs.statSync(snapFile).size; } catch (e) { bytes = 0; }
      return {
        id: id,
        createdAt: createdAt,
        bytes: bytes,
        count: countEntries(snapFile),
        auto: /-auto$/.test(id),
        reason: (meta && meta.meta && meta.meta.reason) || ''
      };
    });
  }

  // 回滚语义（三条不可省）：
  // ① 先校验 id 与快照可解析——坏快照宁可拒绝，也不能把主库覆盖成坏文件；
  // ② 覆盖前给「当前状态」留一份安全快照——回滚本身也必须可回滚；
  // ③ 覆盖后 repo.reload() 让内存认账，否则下一次 flush 会把回滚结果原样盖回去。
  function restoreSnapshotById(id) {
    const target = String(id || '');
    if (!SNAPSHOT_ID_RE.test(target)) {
      return { ok: false, code: 'INVALID_ID', msg: '版本 id 格式不合法，已中止' };
    }
    if (persistence.listSnapshots(dataDir).indexOf(target) < 0) {
      return { ok: false, code: 'NOT_FOUND', msg: '这个版本已不存在' };
    }
    const snapFile = path.join(snapshotDirOf(target), 'store.json');
    let doc = null;
    try { doc = persistence.readJsonSafe(snapFile); } catch (e) { doc = null; }
    if (!doc || !doc.entries || typeof doc.entries !== 'object') {
      return { ok: false, code: 'BAD_SNAPSHOT', msg: '这个版本的文件读不出来，已中止' };
    }

    const before = { diaries: -1, keys: repo.keys().length, revision: repo.revision };
    try { before.diaries = (((diary.listDates() || {}).data) || []).length; } catch (e) { /* 计数失败不影响回滚 */ }

    if (repo.isDirty()) {
      try { repo.flush('pre-restore'); } catch (e) { /* 落盘失败不阻断：安全快照仍会留下 */ }
    }
    let safetyId = '';
    try {
      safetyId = persistence.createSnapshot(dataDir, 'pre-restore', { reason: 'before-rollback:' + target }).id;
    } catch (e) {
      return { ok: false, code: 'SAFETY_SNAPSHOT_FAILED', msg: '无法为当前数据留底，已中止回滚' };
    }

    if (!persistence.restoreSnapshot(dataDir, target)) {
      return { ok: false, code: 'RESTORE_FAILED', msg: '覆盖主库失败' };
    }
    const reloaded = repo.reload('snapshot-restore');

    const after = { diaries: -1, keys: repo.keys().length, revision: repo.revision };
    try { after.diaries = (((diary.listDates() || {}).data) || []).length; } catch (e) { /* 同上 */ }

    metrics.record('snapshot_restore', { ts: new Date().toISOString(), id: target });
    return { ok: true, restored: target, safetyId: safetyId, before: before, after: after, reloaded: reloaded };
  }

  function pruneAutoSnapshots() {
    const all = persistence.listSnapshots(dataDir); // 目录名以时间戳开头，天然倒序
    const autos = all.filter(function (id) { return /-auto$/.test(id); });
    autos.slice(autoBackup.kept).forEach(function (id) {
      try { fs.rmSync(snapshotDirOf(id), { recursive: true, force: true }); } catch (e) { /* 保留即可 */ }
    });
    return autos.length;
  }

  function runAutoBackup(reason) {
    try {
      // 先 flush 再快照：否则快照到的是内存里还没落盘的旧数据
      if (repo.isDirty()) repo.flush('auto-backup');
      const storeFile = path.join(dataDir, 'store.json');
      if (!fs.existsSync(storeFile)) {
        // 从没落过盘（干净机首启且没写过任何东西）：没有可备份的内容。
        // 这里刻意不制造"空快照"——空快照会让用户以为有备份，比没有更危险。
        return { ok: false, skipped: true, reason: 'empty' };
      }
      const r = persistence.createSnapshot(dataDir, 'auto', { reason: reason || 'timer' });
      autoBackup.lastAt = Date.now();
      autoBackup.lastId = r.id;
      pruneAutoSnapshots();
      return { ok: true, id: r.id };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  function fileStat(f) {
    try {
      const s = fs.statSync(f);
      return { exists: true, bytes: s.size, mtime: s.mtime.toISOString() };
    } catch (e) {
      return { exists: false, bytes: 0, mtime: '' };
    }
  }

  // 记录数：不硬给"一致性"布尔值，而是如实报两个数字。
  // 备份是"写前复制"，天生比主文件旧几篇——把它说成"一致/不一致"是谎话。
  function countEntries(file) {
    try {
      const doc = persistence.readJsonSafe(file);
      if (!doc || !doc.entries) return -1;
      let n = 0;
      Object.keys(doc.entries).forEach(function (k) {
        if (/^morning_diary_\d{4}-\d{2}-\d{2}$/.test(k)) n += 1;
      });
      return n;
    } catch (e) {
      return -2;
    }
  }

  function buildHealth() {
    const storeFile = path.join(dataDir, 'store.json');
    const bakFile = storeFile + '.bak';
    const manifestFile = path.join(dataDir, 'manifest.json');

    const snaps = persistence.listSnapshots(dataDir).map(function (id) {
      let createdAt = '';
      try {
        const meta = persistence.readJsonSafe(path.join(snapshotDirOf(id), 'meta.json'));
        createdAt = (meta && meta.createdAt) || '';
      } catch (e) { /* 元数据缺失不影响列表 */ }
      return { id: id, createdAt: createdAt, auto: /-auto$/.test(id) };
    });

    let diaryCount = -1;
    try { const r = diary.listDates(); diaryCount = ((r && r.data) || []).length; } catch (e) { diaryCount = -2; }

    let gtdOpen = 0;
    try {
      const s = gtdStore.read();
      gtdOpen = (s.tasks || []).filter(function (t) { return t.status !== 'done'; }).length;
    } catch (e) { gtdOpen = -1; }

    let capsuleCount = 0;
    try {
      const r = diary.listCapsules();
      capsuleCount = Array.isArray(r && r.data) ? r.data.length : 0;
    } catch (e) { capsuleCount = -1; }

    const bin = recycle.list();
    const store = fileStat(storeFile);
    const bak = fileStat(bakFile);
    const storeCount = countEntries(storeFile);
    const bakCount = countEntries(bakFile);

    return {
      checkedAt: Date.now(),
      boot: {
        replayed: loaded.replayed || 0,
        loadedKeys: loaded.loaded || 0,
        revision: repo.revision,
        lastExitClean: (loaded.replayed || 0) === 0,
        sweptAtBoot: swept.burned || 0
      },
      store: { bytes: store.bytes, mtime: store.mtime, count: storeCount },
      bak: { exists: bak.exists, bytes: bak.bytes, mtime: bak.mtime, count: bakCount, behind: storeCount >= 0 && bakCount >= 0 ? storeCount - bakCount : -1 },
      snapshots: { count: snaps.length, latest: snaps[0] || null, entries: snaps.slice(0, 5) },
      data: {
        diaries: diaryCount,
        keys: repo.keys().length,
        sealed: bin.total,
        sealedSoonest: bin.soonest,
        gtdOpen: gtdOpen,
        capsules: capsuleCount
      },
      migration: { done: fs.existsSync(manifestFile), manifestAt: fileStat(manifestFile).mtime },
      autoBackup: {
        enabled: autoBackup.enabled,
        intervalMinutes: autoBackup.intervalMinutes,
        kept: autoBackup.kept,
        lastAt: autoBackup.lastAt,
        lastId: autoBackup.lastId
      }
    };
  }

  // 独立阅读窗口：三栏布局需要大宽度，放主窗口里挤不下；一本书一个窗口，重复点只聚焦。
  // 窗口只加载静态 reader 页 + 同一个 preload，渲染层仍然只能走 v1 白名单。
  function openReaderWindow(payload) {
    const q = payload || {};
    const bookId = String(q.bookId || '');
    if (!bookId) return { ok: false, reason: '缺少 bookId' };
    const alive = readerWindows.get(bookId);
    if (alive && !alive.isDestroyed()) {
      if (alive.isMinimized()) alive.restore();
      alive.focus();
      return { ok: true, reused: true };
    }
    const s = readingStore.read();
    const b = s.books.filter(function (x) { return x.id === bookId; })[0];
    // P0-1：旧 growth 书单不再能开阅读窗（它本来就没有 filePath，开出来也是空白窗）
    if (!b) return { ok: false, reason: '书架上找不到这本书（旧书单请先在图书馆里导入）' };
    const title = b.title;
    const win = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 1080,
      minHeight: 680,
      title: '九格手记 · 阅读《' + title + '》',
      backgroundColor: '#faf7f1',
      webPreferences: {
        preload: path.join(__dirname, '../preload/v2-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });
    win.setMenuBarVisibility(false);
    win.loadFile(READER_HTML, { query: { bookId: bookId, mode: b ? (b.themeId ? 'theme' : 'leisure') : 'theme' } });
    // 翻开即「最近在读」：进度同步是手动按钮，只靠它打点的话，
    // 一本刚翻开的书在「最近在读」排序里排不上去，看着像功能没生效。
    // 只写本机 md_reading，不动进度——写失败也不该拦住开窗。
    try {
      const cur = readingStore.read();
      if (cur.books.some(function (x) { return x.id === bookId; })) {
        readingStore.write(readingMod.touchBook(cur, bookId, Date.now()));
      }
    } catch (_) { /* 打点失败不影响阅读 */ }
    win.on('closed', function () { readerWindows.delete(bookId); });
    readerWindows.set(bookId, win);
    return { ok: true, reused: false };
  }

  // 记账是长时间连续操作，独立窗口比内嵌页合适；但规格与主窗一致：
  // 1440×900 / 最小 1024×680，三栏默认 240 / 300、可拖、中栏 ≥420——切窗口不跳尺寸。
  // 仍用同一个 preload：渲染层没有第二条出境口，也没有任何跨窗口直连。
  function openFinanceWindow() {
    if (financeWindow && !financeWindow.isDestroyed()) {
      if (financeWindow.isMinimized()) financeWindow.restore();
      financeWindow.focus();
      return { ok: true, reused: true };
    }
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 680,
      title: '九格手记 · 家庭账本',
      backgroundColor: '#faf7f1',
      webPreferences: {
        preload: path.join(__dirname, '../preload/v2-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });
    win.setMenuBarVisibility(false);
    win.loadFile(FINANCE_HTML);
    win.on('closed', function () { financeWindow = null; });
    financeWindow = win;
    return { ok: true, reused: false };
  }

  // 图书馆：与账本同一套规格（1440×900 / 最小 1024×680），左 252 / 右 300 三栏可拖、中栏 ≥420。
  // 选文件、翻书、写笔记仍然只有一条出境口：同一个 preload，渲染层不碰窗口句柄。
  function openLibraryWindow() {
    if (libraryWindow && !libraryWindow.isDestroyed()) {
      if (libraryWindow.isMinimized()) libraryWindow.restore();
      libraryWindow.focus();
      return { ok: true, reused: true };
    }
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 680,
      title: '九格手记 · 图书馆',
      backgroundColor: '#faf7f1',
      webPreferences: {
        preload: path.join(__dirname, '../preload/v2-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });
    win.setMenuBarVisibility(false);
    win.loadFile(LIBRARY_HTML);
    win.on('closed', function () { libraryWindow = null; });
    libraryWindow = win;
    return { ok: true, reused: false };
  }

  const api = createApiLayer({
    repository: repo,
    lifecycle: lifecycle,
    domain: domain,
    healthChecker: buildHealth,
    backupRunner: runAutoBackup,
    // 可回滚版本（R-10）：列出与回滚都放主进程，渲染层只说「回到这一份」
    snapshotLister: listRestorable,
    snapshotRestorer: restoreSnapshotById,
    // 使用度量（R-11）：渲染层只读汇总，不能写也不能读原始事件
    metricsSummary: function () { return metrics.summary(); },
    metricsSetEnabled: function (p) { return metrics.setEnabled(!!(p && p.enabled)); },
    metricsRecord: function (kind, fields) { return metrics.record(kind, fields); },
    // 快速记录（R-09）：托盘/热键由主进程注册，渲染层只能问「现在有哪些入口」
    quickCapture: function (source) { return triggerQuickCapture(source); },
    // 独立阅读窗口（目录 / 正文 / 笔记三栏）：开窗是主进程职责，渲染层只传 bookId
    readerOpener: openReaderWindow,
    // 独立账本窗口（导航 / 模块 / 洞察三栏）：渲染层只说「开账本」，不碰窗口句柄
    financeOpener: openFinanceWindow,
    // 独立图书馆窗口（文件夹树 / 书架 / 详情三栏）：同上，渲染层只说「开图书馆」
    libraryOpener: openLibraryWindow,
    // 原生文件选择：电子书（图书馆）与图片（梦想具象化）共用一条通道，
    // 靠 payload.kind 切过滤器——新通道等于新失败面，不为一个滤镜再开一条 IPC
    filePicker: function (p) {
      const kind = p && p.kind === 'image' ? 'image' : 'book';
      if (PROBE) {
        const raw = kind === 'image'
          ? process.env.JIUGE_V2_PICK_IMAGE || ''
          : process.env.JIUGE_V2_PICK_FILES || '';
        return { canceled: !raw, paths: raw ? raw.split('|').filter(Boolean) : [] };
      }
      const picked = kind === 'image'
        ? dialog.showOpenDialogSync(mainWindow, {
          title: '给这个梦想选一张具象的图片',
          buttonLabel: '用它',
          properties: ['openFile'],
          filters: [{ name: '图片', extensions: DREAM_IMAGE_EXTS }]
        })
        : dialog.showOpenDialogSync(mainWindow, {
          title: '把本电脑的电子书放进图书馆',
          buttonLabel: '放入图书馆',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '电子书', extensions: readingEpub.ALLOWED_EXTS }]
        });
      return { canceled: !picked, paths: picked || [] };
    },
    fileSaver: function (name, text) {
      let target;
      if (PROBE) {
        // E2E 无法点击 Windows 原生模态另存为对话框：只跳过「选路径」这一步，
        // 写文件仍是真实 fs.writeFileSync，回执仍是真实完整路径 + 字节数。
        // 该分支仅由 JIUGE_V2_PROBE=1 触发，正式运行必须走用户可见的 dialog。
        target = path.join(os.tmpdir(), name);
      } else {
        target = dialog.showSaveDialogSync(mainWindow, {
          title: '导出九格手记',
          defaultPath: path.join(app.getPath('documents'), name),
          filters: [{ name: '所有文件', extensions: ['*'] }]
        });
      }
      if (!target) return { canceled: true };
      // 导出为一张图：渲染层把 canvas 转成 dataURL，仍走同一个 v1/file:save 通道。
      // 识别前缀后按二进制落盘，不必为 PNG 再开一条 IPC（新通道 = 新失败面）。
      const PNG_PREFIX = 'data:image/png;base64,';
      if (text.indexOf(PNG_PREFIX) === 0) {
        const buf = Buffer.from(text.slice(PNG_PREFIX.length), 'base64');
        fs.writeFileSync(target, buf);
        return { canceled: false, path: target, bytes: buf.length };
      }
      fs.writeFileSync(target, text, 'utf8');
      return { canceled: false, path: target, bytes: Buffer.byteLength(text, 'utf8') };
    }
  });
  api.register(ipcMain);
  global.__jiugeApi = api;
  global.__jiugeLoaded = loaded;
  // 暴露给 E2E 探针：产物端到端要能验证"备份真的在跑"，而不只是"函数存在"
  global.__jiugeHealth = buildHealth;
  global.__jiugeBackup = runAutoBackup;
  // 暴露给 E2E：热键/托盘无法被 Playwright 直接按键触发，但可以验证
  // 「热键真的注册了」「托盘真的建起来了」「触发后渲染层真的进到可输入态」。
  global.__jiugeMetrics = metrics;
  global.__jiugeQuickCapture = triggerQuickCapture;
  global.__jiugeAccelerator = QUICK_CAPTURE_ACCELERATOR;
  global.__jiugeTrayReady = function () { return !!tray; };
  global.__jiugeSnapshotRestore = restoreSnapshotById;
  global.__jiugeSnapshotList = listRestorable;

  // 自动备份：启动一份 + 定时滚动（默认 30 分钟 / 保留 5 份）
  // 内部会先 flush 再判断有没有可备份内容：干净机首启且没写过东西时自动跳过，不造空快照。
  runAutoBackup('startup');
  autoBackup.timer = setInterval(function () {
    if (!autoBackup.enabled) return;
    runAutoBackup('timer');
  }, autoBackup.intervalMinutes * 60 * 1000);
  if (autoBackup.timer.unref) autoBackup.timer.unref();
  app.on('will-quit', function () {
    if (autoBackup.timer) { clearInterval(autoBackup.timer); autoBackup.timer = null; }
  });

  // 按 key 精确失效：主进程写后广播到所有窗口，根除「窗口 A 写、窗口 B 读旧值」
  repo.onChange(function (event) {
    BrowserWindow.getAllWindows().forEach(function (win) {
      if (!win.isDestroyed()) win.webContents.send('v1/data:changed', event);
    });
  });

  // 四道 flush 兜底 + process exit；主进程独立落盘，不依赖渲染进程回执
  lifecycle.installFlushGuards({
    onBeforeQuit: function (fn) { app.on('before-quit', fn); },
    onWindowAllClosed: function (fn) { app.on('window-all-closed', fn); },
    onPowerShutdown: function (fn) { powerMonitor.on('shutdown', fn); },
    onPowerSuspend: function (fn) { powerMonitor.on('suspend', fn); },
    onProcessExit: function (fn) { process.on('exit', fn); }
  });

  // 一次性迁移：旧 store.json 存在且 manifest 未生成时执行，失败即只读
  const legacyPath = findLegacyStore();
  const manifestPath = path.join(dataDir, 'manifest.json');
  if (legacyPath && !fs.existsSync(manifestPath)) {
    const result = createMigrator({ legacyPath: legacyPath, dataDir: dataDir, repository: repo }).run();
    if (result.error) {
      repo.setReadOnly(true);
      console.error('[jiuge-v2] 迁移失败，进入只读模式：' + result.error);
    }
  }
  return dataDir;
}

function createWindow() {
  // 窗口尺寸 / 位置记忆。全新 userData（含 E2E）没有 state 文件，仍走默认 1440×900。
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  let bounds = { width: 1440, height: 900, x: undefined, y: undefined };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) {
      bounds = {
        width: Math.max(1024, Math.min(Math.round(s.width), 3840)),
        height: Math.max(680, Math.min(Math.round(s.height), 2160)),
        x: Number.isFinite(s.x) ? s.x : undefined,
        y: Number.isFinite(s.y) ? s.y : undefined
      };
    }
  } catch (e) { /* 首次启动 / 坏文件：用默认 */ }
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x === undefined ? {} : { x: bounds.x, y: bounds.y }),
    minWidth: 1024,
    minHeight: 680,
    title: '九格手记 · 个人记录工作台',
    webPreferences: {
      preload: path.join(__dirname, '../preload/v2-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  mainWindow.loadFile(DIST);
  mainWindow.on('close', function () {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        fs.writeFileSync(stateFile, JSON.stringify(mainWindow.getBounds()));
      }
    } catch (e) { /* 存不住也不影响退出 */ }
  });
  // 热键在窗口加载完成前按下时，排队的速记请求在这里补发（R-09 第②条）
  mainWindow.webContents.on('did-finish-load', flushQuickCapture);
  mainWindow.webContents.on('did-finish-load', function () {
    if (!PROBE) return;
    try {
      const api = global.__jiugeApi;
      const loaded = global.__jiugeLoaded || {};
      fs.writeFileSync(path.join(app.getPath('userData'), 'v2-probe.json'), JSON.stringify({
        pid: process.pid,
        isAsar: __dirname.indexOf('app.asar') >= 0 || DIST.indexOf('app.asar') >= 0,
        resourcePath: DIST,
        loadedUrl: mainWindow.webContents.getURL(),
        apiChannels: api ? api.routeNames().length : 0,
        domainAttached: !!global.wx,
        title: mainWindow.getTitle(),
        userData: app.getPath('userData'),
        replayedAtBoot: loaded.replayed || 0,
        loadedKeys: loaded.loaded || 0,
        contextIsolation: true,
        sandbox: true
      }, null, 2));
    } catch (e) {
      fs.writeFileSync(path.join(app.getPath('userData'), 'v2-probe-error.txt'), String(e && e.stack || e));
    }
  });
  mainWindow.on('closed', function () { mainWindow = null; });
}

// ======================= 全局热键 + 托盘速记（整改 R-09）=======================
// F-09 是 PRD「次日留存 ≥60%」唯一载体，而此前 globalShortcut / new Tray 生产源码零命中。
// 两条硬要求：
//   ① 窗口未就绪时按键不能丢——先 arm 住，等 did-finish-load 再补发；
//   ② 跨 00:00 正确落日——日期在**按键那一刻**取定，不是保存那一刻。
let tray = null;
let quickCaptureArmed = null;   // { date, source, at }

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function localToday() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 16×16 九格图标，内嵌 base64：不为一张托盘图标再加一个构建产物与一条打包清单
const TRAY_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALklEQVR42mNgoAbQz/f/D8Okig0SAwYeYHNa/7UV/2GYrDCgrwGDMxBHUyLxAADfD6XN+UBAjwAAAABJRU5ErkJggg==';

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return false;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return true;
}

// 触发一次快速记录；返回 queued 表示窗口还没准备好，已排队等加载完成补发
function triggerQuickCapture(source) {
  const payload = { date: localToday(), source: String(source || 'hotkey'), at: Date.now() };
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    quickCaptureArmed = payload;
    return { ok: true, queued: true, reason: 'window-created' };
  }
  focusMainWindow();
  if (mainWindow.webContents.isLoading()) {
    quickCaptureArmed = payload;
    return { ok: true, queued: true, reason: 'loading' };
  }
  mainWindow.webContents.send('v1/quickcapture:open', payload);
  return { ok: true, queued: false, date: payload.date };
}

// 加载完成后补发被 arm 的那一次（窗口未就绪也不丢）
function flushQuickCapture() {
  if (!quickCaptureArmed || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) return;
  const payload = quickCaptureArmed;
  quickCaptureArmed = null;
  try {
    mainWindow.webContents.send('v1/quickcapture:open', payload);
  } catch (e) { /* 窗口刚好被销毁：这一次算丢，但不静默崩主进程 */ }
}

function trayImage() {
  return nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_ICON_B64);
}

function requestQuit() {
  let choice = 1;
  try {
    choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['取消', '退出'],
      defaultId: 0,
      cancelId: 0,
      title: '退出九格手记',
      message: '确定要退出吗？',
      detail: '退出前会把未落盘的内容写入磁盘。以后要记录，重新打开即可。'
    });
  } catch (e) {
    choice = 1; // 对话框不可用时不要卡住退出流程
  }
  if (choice === 1) {
    app.isQuitting = true;
    app.quit();
  }
}

function ensureTray() {
  if (tray) return tray;
  try {
    tray = new Tray(trayImage());
    tray.setToolTip('九格手记 · 记录今天');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开九格手记', click: function () { focusMainWindow(); } },
      { label: '快速记录（Ctrl+Alt+J）', click: function () { triggerQuickCapture('tray'); } },
      { type: 'separator' },
      { label: '退出', click: function () { requestQuit(); } }
    ]));
    tray.on('click', function () { focusMainWindow(); });
    return tray;
  } catch (e) {
    tray = null;
    return null;
  }
}

// 单实例锁：取锁失败时连 KV 都不初始化
// E2E 诊断（仅 PROBE）：主进程中途消失时，要靠这份流水判断是「自己退出」还是「被带走」
if (PROBE) {
  const diagLog = function (tag, extra) {
    try {
      fs.appendFileSync(
        path.join(app.getPath('userData'), 'v2-probe-lifecycle.log'),
        new Date().toISOString() + ' ' + tag + (extra === undefined ? '' : ' ' + JSON.stringify(extra)) + '\n'
      );
    } catch (e) { /* noop */ }
  };
  diagLog('boot', { pid: process.pid });
  process.on('uncaughtException', function (e) { diagLog('uncaughtException', String((e && e.stack) || e)); });
  process.on('unhandledRejection', function (e) { diagLog('unhandledRejection', String((e && e.stack) || e)); });
  process.on('exit', function (code) { diagLog('process-exit', { code: code }); });
  app.on('child-process-gone', function (ev, d) { diagLog('child-process-gone', d); });
  app.on('render-process-gone', function (ev, wc, d) { diagLog('render-process-gone', d); });
  app.on('before-quit', function () { diagLog('before-quit'); });
  app.on('will-quit', function () { diagLog('will-quit'); });
  app.on('quit', function (ev, code) { diagLog('quit', { code: code }); });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(function () {
    bootCore();
    createWindow();
    // ---- 全局热键 + 托盘（R-09）----
    // 注册失败不阻断启动：可能被其它程序占用，此时托盘条目仍可用。
    try {
      globalShortcut.register(QUICK_CAPTURE_ACCELERATOR, function () { triggerQuickCapture('hotkey'); });
    } catch (e) { /* 占用/无权限时静默降级到托盘入口 */ }
    ensureTray();
    // 启动即记一条 app_start：留存率与「第 4 周」都要有起点
    try { if (global.__jiugeMetrics) global.__jiugeMetrics.record('app_start', { ts: new Date().toISOString(), version: app.getVersion() }); } catch (e) { /* 度量失败不影响启动 */ }
  });
  app.on('will-quit', function () {
    try { globalShortcut.unregisterAll(); } catch (e) { /* already gone */ }
    try { if (tray) { tray.destroy(); tray = null; } } catch (e) { /* noop */ }
  });
  app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
  });
}
