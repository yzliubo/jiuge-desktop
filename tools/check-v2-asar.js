// 校验脚本：从打包后的 app.asar 里抽 Vue 产物，确认新 UI 与新模块真的进包了。
// 整改（R-07）：原先自注「不进 CI」，导致 11-12 交付包掉了 300 条语料无人发现。
// 现已纳入门禁（npm run asar:check，并串在 dist:v2 之后），未命中即失败。
const asar = require('@electron/asar');
const fs = require('fs');
const crypto = require('crypto');

// 打包目录可用环境变量指到别处：本机 build-v2/win-unpacked 有时会被
// 残留进程 / 杀软句柄占住，改输出到 build-v2b 时用它核对，不必动产物位置。
// JIUGE_EXE_PATH 可单独指定 exe（例如 asar 在 build-v2b、已交付 exe 在 build-v2）。
const outDir = process.env.JIUGE_BUILD_DIR || 'build-v2';
const asarPath = outDir + '/win-unpacked/resources/app.asar';
const list = asar.listPackage(asarPath);

function entry(rel) {
  const hit = list.filter(function (x) {
    return x.replace(/\\/g, '/').replace(/^\//, '') === rel;
  })[0];
  return hit || null;
}

function posix(p) {
  return p.replace(/\\/g, '/').replace(/^\//, '');
}

function read(rel) {
  const raw = rel.replace(/\\/g, '/').replace(/^\//, '');
  // Windows 上 asar 的 listPackage 给的是反斜杠，extractFile 也只认反斜杠；
  // 手工拼的正斜杠路径必须补一个变体，否则「在包内 YES、读出来却 not found」。
  const variants = [raw, '/' + raw, rel, rel.replace(/^\\/, ''),
    raw.split('/').join('\\'), '\\' + raw.split('/').join('\\')];
  for (let i = 0; i < variants.length; i++) {
    try {
      return asar.extractFile(asarPath, variants[i]);
    } catch (e) { /* 换下一种写法 */ }
  }
  throw new Error('asar 内读不出: ' + rel);
}

const jsEntries = list.filter(function (x) {
  const p = x.replace(/\\/g, '/');
  return p.indexOf('/assets/') >= 0 && p.slice(-3) === '.js';
});

let bundle = '';
jsEntries.forEach(function (x) {
  bundle += read(x).toString('utf8');
});
// 独立阅读窗口是纯静态页（不进 vite 构建），单独读进来一起做文案/选择器探针
['renderer-v2/reader/index.html', 'renderer-v2/reader/reader.js', 'renderer-v2/reader/reader.css'].forEach(function (rel) {
  if (entry(rel)) { try { bundle += read(rel).toString('utf8'); } catch (e) { /* 缺文件由下面探针报 NO */ } }
});
// 两个 HTML 入口：主窗 index.html 与独立账本窗 finance.html（Vite 双入口构建产物）
['renderer-v2/dist/index.html', 'renderer-v2/dist/finance.html'].forEach(function (rel) {
  if (entry(rel)) { try { bundle += read(rel).toString('utf8'); } catch (e) { /* 缺文件由下面探针报 NO */ } }
});

const probes = [
  // GTD 工作台
  'GTD 工作台', '收件箱', '下一步', '将来也许', '每周回顾', '停滞',
  // 各格主功能
  '单格工作台', '完整账本', '学习成长',
  // 模块目录 + 富文本 + 引导词
  '工作推进', '金钱收支', '身心健康', '关系经营', '情绪觉察', '休闲娱乐', '学习成长', '自由记录',
  '单格洞察', 'insight-btn', '格式工具栏', '插入为引用', '换一条', '清除格式', '引导词',
  // 右栏按模块联动（9 个子面板各自的专属标题）
  '清单健康', '本月收支', '本期指标', '月度分布', '复盘完成度',
  '胶囊状态', '下一个奖励', '本机数据规模', '当前配置',
  // V1.1 封存箱 / 补记 / 数据健康 / 内联提示
  '封存箱', '还有', '离开', '数据健康', '上次退出', '自动备份',
  '立即备份', '补记', '回到今天', '天没写', '已封存',
  // 中栏只写 / 右栏只读（单格工作台去重）
  '最近写过', // 2026-11-10 移除「都在右栏」：界面减负已删该文案，探针不应长期报 NO
  // 子任务树
  '子项', '一并完成', '提升', '容器',
  // 今日六条 / 厘清向导 / 速记分流 / 记录窗
  '今日六条', '挑一件', '两分钟能做完', '参考资料', '完整记录', '保存到今天',
  // 六条并入「未来」格后的工作台（今日页不再有横条）
  'focus-view', 'cell-focus', '今天做哪六件', '给今天留一句',
  // 定位 ≠ 过滤 / 未来 7 天
  '未来 7 天', '上一处', '没有命中', '列表仍是',
  // 梦想一级目标板 / 梦想账户 / 九格里的娱乐格
  '梦想', '拆成行动', '梦想账户', '已存够', '标记达成之前', '娱乐',
  // 问候头与名言分家：时间置顶、问候头无底色、名言独立成块
  '每日名言警句', 'greeting-time', 'quote-block',
  // 栏宽可拖 / 皮肤收进标题栏 / 右栏「本页选项」
  'col-divider', 'skin-pick', 'skin-dot', 'today-opt', '本页选项', '纯本地',
  // 工作台分栏分行 + 右栏任务详情（每周回顾整块搬进右栏）
  'gtd-side', 'gtd-colhead', 'side-proj', 'side-ctx', '任务详情', '清除筛选',
  'wc-detail', 'wc-save', 'wc-st-on', '拆一条能动手的子项', '待厘清',
  // 学习成长三块（考试考证 / 技能学习 / 主题阅读）
  '考试考证', '技能学习', '主题阅读', '导入旧学习库', 'g-tab', 'ch-bar', 'g-acts',
  'gc-quote', '里程碑', '摘录', '该看一眼',
  // 语料库（名言 / 问候 / 运动提示）：三类可编辑、删内置只记隐藏
  '语料库', '名言警句', '问候语', '运动提示', '动一动', '恢复内置默认', '已移除', '三类语料',
  // 图书馆 / 读书笔记（V2.3）：两类阅读 + 行内批注 + 伴读三问 + 九格回写
  '图书馆', '休闲娱乐阅读', '读书笔记 · 数据库', '伴读三问', '批注贴着原文长',
  '闪念入格', '已入九格', '汇总旧摘录', 'reading.addNote', 'reading.importGrowthQuotes',
  // V2.14：主题阅读自建书单（权威源迁到 md_reading），与休闲功能一致
  '主题书单现在由这里维护', '导入学习成长的旧主题书单', '建主题', '主题新书名',
  'reading.themeAdd', 'reading.importGrowthThemes', '翻开读',
  // 本地电子书（V2.4）：拖放 / 选择 / 详细列表 / 封面预览
  '把本电脑的电子书拖到这里', '选择电子书', '详细列表', '封面预览',
  'rd-card-img', 'reading.addFiles', 'reading.cover',
  // 独立阅读窗口（V2.5）：目录 / 正文 / 笔记三栏，正文走沙箱 iframe
  '把本电脑的电子书拖到这里', '翻开读', 'rr-toc', 'rr-page', 'rr-note-list',
  '划选问一句', '闪念入格', '同步进度', 'reading.readerChapter', 'reading.readerProgress',
  // V2.6：书签 / 书内搜索 / 划选标注 / 多字体
  '在本书里找一句话', '混排 · 宋体正文 / 黑体标题', 'rr-typeface', 'rr-bm-add',
  'rangeByOffset', 'data-typeface', 'reading.addBookmark', 'reading.searchBook',
  // V2.7：中文排印基线
  '版心 窄边', '段距 紧凑', '标点挤压', 'text-justify:inter-ideograph', '--rr-para', 'MARGIN_PRESET',
  // V2.8：完读率轻互动
  '本章读完', '继续下一章', '上次读到', '这是这本书的第', 'rr-endcard', 'phraseOf',
  // V2.9：三阶九问浮窗 + 双击开读 + 进度底栏
  '读前 · 定盘', '读中 · 拆解', '读后 · 收束', 'Q1 · 我为什么翻开它', 'Q4 · 这句话在说什么',
  'Q9 · 哪一句带走', '读中三问问完了', 'rr-ask', '双击直接翻开', 'rr-status-msg',
  '引原文', 'rr-ask-quote', 'pickAskQuote',
  // V2.10：右栏三阶九问面板取代自由表单；浮窗只留读中三问；划线工具条带快捷问
  '三阶九问', 'rr-q9-list', 'rr-q9-edit', 'renderQ9', 'commitQ9',
  'data-ask="0"', 'data-ask="2"', 'contextmenu', 'Q2 · 它打算怎么回答',
  // V3.0 独立家庭账本窗口（Vite 双入口）：三栏 + 九模块 + 会计骨架
  '九格手记 · 家庭账本', 'fin-card', 'fw-kpi', 'fin-trend', '净资产', '本月速览', '资产负债表',
  '储蓄率', '自动分类规则', '储蓄目标', '周期与订阅', '规则命中',
  '导入', '导出 CSV', '信封', '超支', '整数分', '交易对方', 'finance.netWorth',
  'finance.bulkUpdate', 'finance.detectSubscriptions', 'finance.insights',
  // V3.1 规格统一 + 三库联动：主窗同尺寸 / 手记收支只读联动 / 梦想账户并入储蓄目标
  '手记收支 · 九格', '导入到账本', '导入本月待导入', '手记待导入',
  '梦想账户已并入本页', '存入梦想账户', '栏宽已恢复默认',
  'finance.moneyRows', 'finance.importMoneyRows', 'dream.deposit',
  // 多语言：设置页语言选择 + 渲染层词典
  '8 · 语言', '跟随系统 / Auto', '繁體中文', '日本語', 'English',
  'jiuge.ui.locale', 'data-i18n-src', 'Nine Squares Journal',
  // V3.2 自由记录三合一 + 胶囊降级（docs/28）
  '自由记录 · 三合一', '① 胶囊收录', '② 闪念快记', '③ 长文撰写',
  '胶囊 · 给未来的信', '今日到期', '已同步收件箱', '海明威', '不套 ARI',
  'free.board', 'free.flashAdd', 'free.docAdd', 'writing.check'
];

console.log('  asar: ' + asarPath);
console.log('  资源条目: ' + list.length + ' 个，其中 js 产物 ' + jsEntries.length + ' 个，合计 ' + bundle.length + ' 字节');
console.log('  src/gtd/board.js 在包内: ' + (entry('src/gtd/board.js') ? 'YES' : 'NO'));
console.log('  src/core/recycle.js 在包内: ' + (entry('src/core/recycle.js') ? 'YES' : 'NO'));
console.log('  src/inspire/library.js 在包内: ' + (entry('src/inspire/library.js') ? 'YES' : 'NO'));
console.log('  src/reading/board.js 在包内: ' + (entry('src/reading/board.js') ? 'YES' : 'NO'));
console.log('  src/reading/epub.js 在包内: ' + (entry('src/reading/epub.js') ? 'YES' : 'NO'));
console.log('  src/reading/reader-source.js 在包内: ' + (entry('src/reading/reader-source.js') ? 'YES' : 'NO'));
console.log('  renderer-v2/reader/index.html 在包内: ' + (entry('renderer-v2/reader/index.html') ? 'YES' : 'NO'));
// V3.0 新入口：漏了 finance.html 或 src/finance/board.js，独立账本窗会白屏 / 主进程 require 直接崩
console.log('  renderer-v2/dist/finance.html 在包内: ' + (entry('renderer-v2/dist/finance.html') ? 'YES' : 'NO'));
console.log('  src/finance/board.js 在包内: ' + (entry('src/finance/board.js') ? 'YES' : 'NO'));
const financeJs = jsEntries.filter(function (x) { return /\/finance-.*\.js$/.test(posix(x)); });
console.log('  dist/assets/finance-*.js 在包内: ' + (financeJs.length ? 'YES (' + financeJs.map(posix).join(', ') + ')' : 'NO'));
console.log('  src/free/board.js 在包内: ' + (entry('src/free/board.js') ? 'YES' : 'NO'));
console.log('  src/writing/check.js 在包内: ' + (entry('src/writing/check.js') ? 'YES' : 'NO'));
console.log('  packaged main: ' + JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')).main);
console.log('');
const misses = [];
probes.forEach(function (s) {
  const hit = bundle.indexOf(s) >= 0;
  if (!hit) misses.push(s);
  console.log('  ' + s + ' => ' + (hit ? 'YES' : 'NO'));
});
console.log('');
console.log('  探针合计 ' + probes.length + ' 条，未命中 ' + misses.length + ' 条' + (misses.length ? '：' + misses.join(' / ') : ''));

const exePath = process.env.JIUGE_EXE_PATH || (outDir + '/九格手记-v2-便携版.exe');
const buf = fs.readFileSync(exePath);
console.log('');
console.log('  exe: ' + exePath);
console.log('  exe 字节: ' + buf.length);
console.log('  exe SHA256: ' + crypto.createHash('sha256').update(buf).digest('hex'));
console.log('  app.asar 字节: ' + fs.statSync(asarPath).size);

// ---- 门禁判定（R-07）：探针未全命中即失败，不再只打印给人看 ----
// 必查模块：只列**以源码形式入包**的领域模块。四语言与视图是打进 dist 资产的，
// 不以源码形式入包，由上面的语料/文案探针覆盖，不要写进这里（否则门禁必挂）。
const requiredEntries = ['src/free/board.js', 'src/writing/check.js'];
const missingEntries = requiredEntries.filter(function (r) { return !entry(r); });
console.log('');
if (misses.length || missingEntries.length) {
  console.log('  [FAIL] 交付包内容不符合预期');
  if (misses.length) console.log('         语料/文案未命中 ' + misses.length + ' 条：' + misses.join(' / '));
  if (missingEntries.length) console.log('         缺少模块文件：' + missingEntries.join(' / '));
  process.exitCode = 1;
} else {
  console.log('  [PASS] 全部探针命中，交付包内容符合预期');
}
process.exit(process.exitCode || 0);
