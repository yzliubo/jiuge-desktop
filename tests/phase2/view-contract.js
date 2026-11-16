'use strict';
// 视图层静态契约门禁（npm run view:check）
// 注意：这是静态门禁，不替代 04-质量保障方案 §2 要求的 GUI 真断言 ≥30 / exe E2E ≥5。
// 它负责把「换证据结构」里可静态判定部分自动化：CSP、零网络、状态类基线、白名单桥、皮肤令牌。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const viewRoot = path.join(root, 'renderer-v2');
const srcRoot = path.join(viewRoot, 'src');
const distDir = path.join(viewRoot, 'dist');
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name + ' :: ' + e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function allVue() {
  const out = [];
  function walk(dir) {
    fs.readdirSync(dir).forEach(function (name) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.vue')) out.push(full);
    });
  }
  walk(srcRoot);
  return out;
}

function allRendererSources() {
  const out = [];
  function walk(dir) {
    fs.readdirSync(dir).forEach(function (name) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(vue|ts|css|html)$/.test(name)) out.push(full);
    });
  }
  walk(viewRoot);
  return out.filter(function (p) { return p.indexOf('node_modules') < 0 && p.indexOf(path.join('renderer-v2', 'dist')) < 0; });
}

console.log('view-contract | Vue3 + TS + Vite 视图层静态门禁');
console.log('');

check('构建产物存在且通过 vue-tsc / vite build', function () {
  assert(fs.existsSync(path.join(distDir, 'index.html')), '缺少 dist/index.html，请先 npm run build:view');
  const assets = fs.readdirSync(path.join(distDir, 'assets'));
  assert(assets.some(function (f) { return f.endsWith('.js'); }), '缺少 JS 产物');
  assert(assets.some(function (f) { return f.endsWith('.css'); }), '缺少 CSS 产物');
});

check('dist/index.html 只引用本地相对资源，无远程 URL', function () {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  assert(!/https?:\/\//.test(html), '产物含远程 URL');
  assert(/\.\/assets\//.test(html), '产物未引用 ./assets/ 本地资源');
});

check('严格 CSP：无 unsafe-eval、connect-src none', function () {
  const html = read('renderer-v2/index.html');
  assert(/Content-Security-Policy/.test(html), '缺少 CSP');
  assert(!/unsafe-eval/.test(html), 'CSP 含 unsafe-eval');
  assert(/connect-src 'none'/.test(html), 'CSP 未禁用网络连接');
  assert(/default-src 'self'/.test(html), 'CSP 默认源不是 self');
});

check('三栏布局 + 左右边界可拖 + 1024 断点 + 中部最小宽度', function () {
  const app = read('renderer-v2/src/App.vue');
  // 2026-11-08 22:32：grid 改 flex，两侧宽度由拖拽写进 CSS 变量（--nav-w / --rail-w）
  assert(/\.columns\s*\{[\s\S]{0,120}display:\s*flex/.test(app), '缺少 flex 三栏主布局');
  assert(/--nav-w/.test(app) && /--rail-w/.test(app), '栏宽没走 CSS 变量（拖拽改不动宽度）');
  assert(/col-divider/.test(app) && /role="separator"/.test(app), '缺少可拖边界（或没给无障碍角色）');
  assert(/setPointerCapture/.test(app), '边界没做指针捕获（拖快点就丢手）');
  assert(/localStorage\.setItem\(LAYOUT_KEY/.test(app), '栏宽没持久化（重开就丢）');
  assert(/CENTER_MIN = 420/.test(app), '中栏最小宽度没锁死（两侧能把主栏挤没）');
  // 2026-11-13 整改：最小窗实测视口 1025，max-width:1024 永不命中；
  // D1 裁决改为 1120 折右栏、保左栏 240，并要求抽屉/唤起/Esc 三件齐备。
  assert(/max-width:\s*1120px/.test(app), '缺少 1120 窄态断点');
  assert(!/max-width:\s*1024px/.test(app), '旧 1024 断点回来了（窄态分支不可达）');
  // 窄态必须是「折右栏 + 可唤起抽屉」，不是把左栏压成 64px 图标化（无图标资源会竖排崩坏）
  assert(/\.columns\.rail-open :deep\(\.context\)/.test(app), '窄态右栏抽屉选择器不对（会点了没反应）');
  assert(/\.columns :deep\(\.context\) \{ display: none/.test(app), '窄态右栏没先隐藏（会算成视口外溢出）');
  assert(/\.columns :deep\(\.nav\) \{ width: 240px/.test(app), '窄态左栏没保住 240px');
  assert(/rail-toggle/.test(app) && /rail-scrim/.test(app), '窄态缺右栏唤起按钮或遮罩');
  assert(/Escape' && railOpen\.value/.test(app) && /closeRail\(\)/.test(app), '抽屉没有 Esc 关闭');
  assert(/minWidth:\s*1024/.test(read('src/main/main-v2.js')), '窗口最小宽度未锁定 1024');
});

check('DOM 行为基线：状态类绑定 ≥10 处（专断 class 而非 data）', function () {
  const names = new Set();
  allVue().forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /'([\w-]+-on)'/g;
    let m;
    while ((m = re.exec(text)) !== null) names.add(m[1]);
  });
  assert(names.size >= 10, '状态类仅 ' + names.size + ' 处，需 ≥10；实得: ' + Array.from(names).join(', '));
  console.log('        状态类 ' + names.size + ' 处: ' + Array.from(names).sort().join(', '));
});

check('无障碍断言：aria-selected / checked / current / expanded / pressed 覆盖', function () {
  const joined = allVue().map(function (f) { return fs.readFileSync(f, 'utf8'); }).join('\n');
  ['aria-selected', 'aria-checked', 'aria-current', 'aria-expanded', 'aria-pressed'].forEach(function (a) {
    assert(joined.indexOf(':' + a) >= 0, '缺少 :' + a);
  });
});

check('安全：无 v-html 直插日记正文', function () {
  allVue().forEach(function (file) {
    assert(!/v-html/.test(fs.readFileSync(file, 'utf8')), path.basename(file) + ' 含 v-html');
  });
});

check('零网络：渲染层源码无任何 http(s) 外链', function () {
  allRendererSources().forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    assert(!/https?:\/\//.test(text), path.relative(root, file) + ' 含远程 URL');
  });
});

check('唯一出境口：只有 bridge.ts 访问 jiugeBridge / ipcRenderer', function () {
  const offenders = allRendererSources().filter(function (file) {
    if (path.basename(file) === 'bridge.ts') return false;
    const text = fs.readFileSync(file, 'utf8');
    return /jiugeBridge|ipcRenderer|\brequire\(/.test(text);
  });
  assert(offenders.length === 0, '越权访问: ' + offenders.map(function (f) { return path.basename(f); }).join(', '));
});

check('preload 白名单通道与 v1 API 路由一致', function () {
  const preload = read('src/preload/v2-preload.js');
  const api = read('src/core/api-layer.js');
  // 通道分两类：invoke 类必须有对应路由；**推送类**（ipcRenderer.on）由主进程单向发，
  // 本来就没有路由，不能要求它在 api-layer 里存在。
  // 原先只硬编码豁免 v1/data:changed，R-09 新增 v1/quickcapture:open 后立刻误报——
  // 改成按「是否只用 on 订阅」自动排除，以后再加推送通道不必改这条断言。
  const pushChannels = (preload.match(/ipcRenderer\.on\('(v1\/[A-Za-z:]+)'/g) || [])
    .map(function (s) { return s.split("'")[1]; });
  const channels = (preload.match(/'v1\/[A-Za-z:]+'/g) || [])
    .map(function (s) { return s.slice(1, -1); })
    .filter(function (c) { return pushChannels.indexOf(c) < 0; });
  assert(channels.length >= 7, '白名单通道不足');
  channels.forEach(function (c) {
    assert(api.indexOf("'" + c + "'") >= 0, '白名单通道在 api-layer 中不存在: ' + c);
  });
  assert(/contextIsolation:\s*true/.test(read('src/main/main-v2.js')), '未开启 contextIsolation');
  assert(/sandbox:\s*true/.test(read('src/main/main-v2.js')), '未开启 sandbox');
  assert(!/(?:global|globalThis)\.wx\s*=/.test(preload), 'preload 仍注入 wx 全局（应已移除）');
});

check('主进程接线：单实例锁 / 四道 flush / 精确失效广播 / 一次性迁移', function () {
  const main = read('src/main/main-v2.js');
  assert(/requestSingleInstanceLock/.test(main), '缺少单实例锁');
  ['onBeforeQuit', 'onWindowAllClosed', 'onPowerShutdown', 'onPowerSuspend', 'onProcessExit'].forEach(function (h) {
    assert(main.indexOf(h) >= 0, '缺少 flush 钩子 ' + h);
  });
  assert(/v1\/data:changed/.test(main), '缺少按 key 精确失效广播');
  assert(/createMigrator/.test(main), '缺少一次性迁移器');
  assert(/setReadOnly\(true\)/.test(main), '迁移失败未进入只读模式');
});

check('两层设计令牌：四套皮肤 × 明暗基底', function () {
  const css = read('renderer-v2/src/styles/tokens.css');
  ['forest', 'night', 'sakura', 'candy'].forEach(function (s) {
    assert(css.indexOf('[data-skin="' + s + '"]') >= 0, '缺少皮肤令牌 ' + s);
  });
  assert(/\[data-surface="light"\]/.test(css) && /\[data-surface="dark"\]/.test(css), '缺少明暗基底令牌');
  assert(!/filter:/.test(css), '令牌层禁止叠 filter');
});

check('数据中心唯一入口：其它视图不得直接发起导入/导出备份/迁移', function () {
  // 只看行为，不咬文案：设置页「小贴士」里提一句「导出备份」不是第二入口。
  // V1.3 修正口径：LifeView 的「导出为一张图」是 PNG 图片，不是备份，且仍走
  // 同一个 v1/file:save 通道（主进程识别 dataURL 后按二进制落盘）。
  // 给它豁免，但必须满足：只有一个 saveExport 调用、确实画的是 PNG、
  // 且不得夹带任何备份 / 迁移能力——否则「唯一入口」就被悄悄拆了。
  const forbidden = /saveExport\s*\(|importBackup|exportBackup|exportText|exportMarkdown|createMigrator|v1\/file:save/;
  const offenders = allVue().filter(function (file) {
    const base = path.basename(file);
    if (base === 'DataCenter.vue') return false;
    const text = fs.readFileSync(file, 'utf8');
    if (base === 'LifeView.vue') {
      if (/importBackup|exportBackup|exportText|exportMarkdown|createMigrator/.test(text)) return true;
      if (!/toDataURL\('image\/png'\)/.test(text)) return true;
      return (text.match(/saveExport\s*\(/g) || []).length !== 1;
    }
    // V2.3 语义升级（同 V1.3 PNG 先例）：ReadingView 导出的是「读书笔记」汇总文本，
    // 不是备份，仍走同一个 v1/file:save。只许一次调用、不得夹带备份 / 迁移 / 图片能力。
    if (base === 'ReadingView.vue') {
      if (/importBackup|exportBackup|exportText|exportMarkdown|createMigrator|toDataURL/.test(text)) return true;
      if (text.indexOf('reading.exportMd') < 0) return true;
      return (text.match(/saveExport\s*\(/g) || []).length !== 1;
    }
    // 家庭账本（同 V2.3 读书笔记先例）：导出的是本月流水 CSV，不是备份、不是迁移，
    // 仍走同一个 v1/file:save。只许一次调用、必须点名 finance.exportCsv、不得夹带备份/图片能力。
    if (base === 'FinanceView.vue') {
      if (/importBackup|exportBackup|exportText|exportMarkdown|createMigrator|toDataURL/.test(text)) return true;
      if (text.indexOf('finance.exportCsv') < 0) return true;
      return (text.match(/saveExport\s*\(/g) || []).length !== 1;
    }
    // P2-2 语义扩展（同 V1.3 / V2.3 先例）：图书馆导出的是「书目清单」
    // ——CSV / JSON / OPDS，只含元数据与路径，没有正文，也不是备份/迁移。
    // 仍然只走同一个 v1/file:save。条件：只许一次调用、必须点名 reading.exportList、
    // 不得夹带备份 / 迁移 / 图片能力。
    if (base === 'LibraryWindow.vue') {
      if (/importBackup|exportBackup|exportText|exportMarkdown|createMigrator|toDataURL/.test(text)) return true;
      if (text.indexOf('reading.exportList') < 0) return true;
      return (text.match(/saveExport\s*\(/g) || []).length !== 1;
    }
    return forbidden.test(text);
  });
  assert(offenders.length === 0, '存在第二入口: ' + offenders.map(function (f) { return path.basename(f); }).join(', '));
  const dc = read('renderer-v2/src/components/DataCenter.vue');
  assert(/仅复制文本，不是备份/.test(dc), '剪贴板未标注「不是备份」');
  assert(/回执/.test(dc), '缺少含路径回执');
  assert(/callDomainRaw<ImportReport>\('importBackup'/.test(dc), '导入未区分业务错误码');
});

check('根 package.json 仍为零运行时依赖（保 verify 69/69）', function () {
  const pkg = JSON.parse(read('package.json'));
  assert(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '根包出现 dependencies');
  assert(Object.keys(pkg.devDependencies || {}).length === 2, '根包 devDependencies 不是 2 个');
  ['golden', 'migrate:verify', 'bench:core', 'view:check', 'build:view', 'start:v2', 'dist:v2', 'test:gui', 'test:exe'].forEach(function (s) {
    assert(pkg.scripts[s], '缺少脚本 ' + s);
  });
});

// ---------- 原小程序 5 页功能补齐后的新增门禁 ----------

check('原小程序 5 页能力桌面化 + V1.1 新增视图全部接入主窗', function () {
  const app = read('renderer-v2/src/App.vue');
  ['GreetingBar', 'GridEditor', 'InsightView', 'ReviewView', 'CapsuleView', 'HabitView', 'SettingsView', 'DataCenter', 'BinView'].forEach(function (c) {
    assert(new RegExp("import " + c + " from").test(app), 'App.vue 未接入 ' + c);
  });
  // 2026-11-08 22:32：今日状态与三块录入面板从主栏搬进右栏「本页选项」
  assert(app.indexOf('<TodayExtras') < 0 && app.indexOf('<ModulePanels') < 0, '今日状态/录入面板还挂在主栏');
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  assert(/import TodayOptions from/.test(panel), '右栏未接入本页选项卡');
  assert(/<TodayOptions[\s\S]{0,80}view === 'today'/.test(panel), '本页选项没绑在今天视图下');
  const opts = read('renderer-v2/src/components/context/TodayOptions.vue');
  assert(/TodayExtras/.test(opts) && /ModulePanels/.test(opts), '本页选项卡里没有今日状态 / 快速录入');
  // 右栏能写的是设置类数据，正文仍只在主栏
  assert(/@save/.test(opts) && /emit\('save'/.test(opts), '本页选项没接 save（改了存不下去）');
  const types = read('renderer-v2/src/types.ts');
  // 2026-11-13：一级导航里的「自由记录」撤掉——它与九格「自由」格是同一个视图，
  // 同一功能两个入口。入口收敛到「今天 → 自由记录」这条九格目录。导航 6 项 + 设置。
  ['今天', '时间轴', '回顾', '坚持', '数据中心'].forEach(function (n) {
    assert(types.indexOf("label: '" + n + "'") >= 0, '一级导航缺少 ' + n);
  });
  assert(!/label: '胶囊'/.test(types), '胶囊仍在占一级导航');
  assert(!/key: 'free', label/.test(types), '自由记录仍占着一级导航（与九格同功能）');
  assert(/class="capsule-btn"/.test(app), '顶栏缺少胶囊按钮');
  assert(/mode="timeline"/.test(app) && /mode="retro"/.test(app), '时间轴 / 回顾未分别指定单一职责');
  assert(/@go-data="navigate\('data'\)"/.test(app), '设置页未跳转数据中心');
  assert(!/class="placeholder"/.test(app), '仍存在占位视图');
});

check('信息架构：问候名言置顶中栏、单格洞察在标题栏、九格直挂今天下级', function () {
  const app = read('renderer-v2/src/App.vue');
  const gi = app.indexOf('<GreetingBar');
  const grid = app.indexOf('<GridEditor');
  assert(gi >= 0 && grid >= 0 && gi < grid, '问候条未放在九格编辑器之前（中栏顶部）');
  assert(/<InsightView v-else-if="view === 'insight'"/.test(app), '洞察模块未独立成视图');
  assert(/insight: '单格洞察'/.test(app), '标题栏缺少模块名');
  // 2026-11-08 23:16：单格洞察从左栏二级目录上移到标题栏
  assert(/class="insight-btn"/.test(app), '标题栏没有单格洞察入口');
  const bar = app.slice(app.indexOf('<header class="titlebar">'), app.indexOf('</header>'));
  assert(/insight-btn[\s\S]{0,200}navigate\('insight'\)/.test(bar), '标题栏按钮没绑 insight 路由');
  const nav = read('renderer-v2/src/components/NavSidebar.vue');
  assert(nav.indexOf('nav-insight') < 0, '左栏还留着单格洞察');
  // 九格直接挂在「今天」下：没有「今日 · 二级」标签，也没有「记录模块」折叠组
  assert(nav.indexOf('记录模块') < 0, '「记录模块」折叠组还在');
  assert(nav.indexOf('sub-label') < 0, '「今日 · 二级」标签还在');
  assert(!/modulesOpen/.test(nav), '折叠开关还在（九格又被藏起来了）');
  assert(/v-for="key in GRID_KEYS"/.test(nav), '九格目录没直接渲染在今天下级');
  assert(/'insight'/.test(read('renderer-v2/src/types.ts')), 'ViewKey 缺少 insight');
  const extras = read('renderer-v2/src/components/TodayExtras.vue');
  assert(!/insights\.analyze/.test(extras) && !/quotes\.pick/.test(extras), '今日补充区仍残留旧问候/洞察逻辑');
  const insight = read('renderer-v2/src/components/InsightView.vue');
  ['metrics', 'heat', 'coverage', 'phrases', 'excerpts', 'compare'].forEach(function (k) {
    assert(insight.indexOf(k) >= 0, '独立洞察模块未铺开 ' + k);
  });
});

check('九格一律四字名，且数据键一个不动', function () {
  const types = read('renderer-v2/src/types.ts');
  const want = {
    work: '工作推进', money: '金钱收支', health: '身心健康', relation: '关系经营',
    future: '今日六条', emotion: '家庭亲子', dream: '休闲娱乐', growth: '学习成长', free: '自由记录'
  };
  Object.keys(want).forEach(function (k) {
    assert(new RegExp(k + ": '" + want[k] + "'").test(types), '九格名不是四字或缺失：' + k + ' 应为 ' + want[k]);
  });
  // 2026-11-16：第 6 格整格换成「家庭亲子」（原「情绪觉察」）。
  // 数据键仍是 emotion：历史 cells.emotion 正文、导出、检索、备份一个字节都不动。
  assert(/emotion: '家庭亲子'/.test(types), '第 6 格显示名不是「家庭亲子」');
  // 键顺序仍是「九格」原顺序（改标签不许动数据契约）
  assert(/'work', 'money', 'health', 'relation', 'future',/.test(types), 'GRID_KEYS 键顺序被改动');
  // 2026-11-13 整改（T6/Q6）：渲染层第 7 键 leisure 与冻结领域层 dream 不一致，
  // 曾导致「休闲娱乐」格写进去的内容被 save() 静默丢弃。键回归 dream，只换显示名。
  assert(/'emotion', 'dream', 'growth', 'free'/.test(types), 'GRID_KEYS 第 7 键没回归 dream');
  // leisure 现在是「休闲娱乐专属页」的 ViewKey，不是九格数据键；只在 GRID_KEYS 块里禁它。
  const gridBlock = (types.match(/export const GRID_KEYS[\s\S]*?\] as const/) || [''])[0];
  assert(!/'leisure'/.test(gridBlock), '九格数据键里又出现 leisure（会再次静默丢字）');
  assert(/dream: '休闲娱乐'/.test(types), 'dream 键的显示名不是「休闲娱乐」');
});

check('家庭亲子：界面文案与引导语不再残留「情绪觉察」', function () {
  const settings = read('renderer-v2/src/components/SettingsView.vue');
  const locales = read('renderer-v2/src/i18n/locales.json');
  const dict = read('renderer-v2/src/i18n/dict.json');
  const prompts = read('renderer-v2/src/composables/promptLibrary.ts');
  const ui = read('renderer-v2/src/views/FamilyView.vue') + read('renderer-v2/src/components/context/FamilyContext.vue');
  assert(/id: 'emotion', name: '家庭亲子'/.test(settings), '设置页模板仍挂旧名「情绪觉察」');
  assert(!/情绪觉察/.test(locales) && !/情绪觉察/.test(dict), '多语言词典仍有旧名「情绪觉察」');
  assert(/成长足迹/.test(ui) && /亲子时刻/.test(ui) && /本周陪伴/.test(ui), '家庭亲子三块/右栏文案缺失');
  // 引导语：第 6 格不随模板变，旧 emotion 模板的情绪问法不许再喂给家庭亲子
  assert(/if \(key === 'emotion'\)[\s\S]{0,260}return FAMILY_PROMPTS\[i\]/.test(prompts),
    'gridPrompt 没把第 6 格固定到家庭亲子题组');
  assert(/if \(key === 'emotion'\) return FAMILY_PROMPTS\[0\]/.test(prompts), '兜底用语没换成亲子题');
});

check('职责单一：时间轴=日记 / 回顾=复盘 / 全局概览并入单格洞察下方', function () {
  const review = read('renderer-v2/src/components/ReviewView.vue');
  const app = read('renderer-v2/src/App.vue');
  const insight = read('renderer-v2/src/components/InsightView.vue');
  assert(/defineProps<\{ mode: 'timeline' \| 'retro' \}>/.test(review), 'ReviewView 未按 mode 拆职责');
  assert(!/role="tablist"/.test(review) && !/rv-tab/.test(review), '时间轴 / 回顾仍存在重复的三 tab');
  assert(!/grid-cards/.test(review), '概览六卡仍留在 ReviewView');
  assert(!/weeklyReview|moodTrend|frequentPhrases|moneySummary|studySummary/.test(review), 'ReviewView 仍在拉概览数据');
  assert(/mode="timeline"/.test(app) && /mode="retro"/.test(app), 'App.vue 未分别传入 mode');
  ['本周小结', '近 30 天心情', '工作 · 任务与感想', '收支汇总', '学习进展', '反复出现的字句'].forEach(function (t) {
    assert(insight.indexOf(t) >= 0, '全局概览缺卡片: ' + t);
  });
  assert(/class="overview-section"/.test(insight), '洞察模块缺少全局概览区块');
  // 用模板里的锚点，不用 lastIndexOf（CSS 里也有 .foot-note）
  const lastInsight = insight.indexOf('class="foot-note"');
  const overviewAt = insight.indexOf('class="overview-section"');
  assert(lastInsight >= 0 && overviewAt > lastInsight, '全局概览未放在单格洞察下方');
  assert(/weeklyReview/.test(insight) && /moodTrend/.test(insight), '概览六卡未接领域数据');
  assert(fs.existsSync(path.join(srcRoot, 'composables/useReviewFormat.ts')), '公共格式化函数未抽取');
  assert(/labelText/.test(review) && /labelText/.test(insight), '两个视图未复用同一格式化函数');
});

check('领域函数白名单：渲染层所有调用名都在 DOMAIN_WHITELIST 内', function () {
  const api = read('src/core/api-layer.js');
  const block = api.match(/const DOMAIN_WHITELIST = \[([\s\S]*?)\];/);
  assert(block, '未找到 DOMAIN_WHITELIST');
  const allowed = {};
  (block[1].match(/'([^']+)'/g) || []).forEach(function (s) { allowed[s.slice(1, -1)] = true; });
  const re = /(?:callDomainRaw|callDomain|domainCall)\s*(?:<[\s\S]*?>)?\s*\(\s*'([^']+)'/g;
  const used = {};
  let count = 0;
  allVue().forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(text)) !== null) {
      used[m[1]] = true;
      count++;
      assert(allowed[m[1]], path.basename(file) + ' 调用了未白名单的领域函数: ' + m[1]);
    }
  });
  // 导出格式走动态 fn 字段，单独核对
  const dc = read('renderer-v2/src/components/DataCenter.vue');
  (dc.match(/fn:\s*'([^']+)'/g) || []).forEach(function (s) {
    const name = s.match(/'([^']+)'/)[1];
    assert(allowed[name], '导出格式 "' + name + '" 不在白名单');
    count++;
  });
  assert(count >= 30, '领域调用仅 ' + count + ' 处，疑似功能未接全');
  console.log('        领域调用 ' + count + ' 处 / 白名单 ' + Object.keys(allowed).length + ' 项');
});

check('新增两条 v1 通道在 preload / api-layer / bridge 三处一致', function () {
  const preload = read('src/preload/v2-preload.js');
  const api = read('src/core/api-layer.js');
  const bridge = read('renderer-v2/src/bridge.ts');
  ['v1/domain:call', 'v1/file:save'].forEach(function (c) {
    assert(preload.indexOf("'" + c + "'") >= 0, 'preload 白名单缺少 ' + c);
    assert(api.indexOf("route('" + c + "'") >= 0, 'api-layer 未注册 ' + c);
    assert(bridge.indexOf("'" + c + "'") >= 0, 'bridge 未封装 ' + c);
  });
  assert(/DOMAIN_WHITELIST\.indexOf\(name\)/.test(api), '领域调用未做白名单校验');
  assert(/JSON\.parse\(JSON\.stringify\(payload\)\)/.test(bridge), '出境数据未去 Vue Proxy');
});

check('另存为是真实文件写：dialog + fs.writeFileSync，探针分支受 PROBE 保护', function () {
  const main = read('src/main/main-v2.js');
  assert(/dialog\.showSaveDialogSync/.test(main), '正式运行缺少用户可见的另存为对话框');
  assert(/fs\.writeFileSync\(target, text, 'utf8'\)/.test(main), '没有真实写文件');
  assert(/Buffer\.byteLength\(text, 'utf8'\)/.test(main), '回执字节数未按 UTF-8 计算');
  assert(/if \(PROBE\)/.test(main), 'E2E 自动接受分支未受 PROBE 保护');
});

check('胶囊到期前不泄露正文：封存组不渲染 preview', function () {
  const cap = read('renderer-v2/src/components/CapsuleView.vue');
  assert(/g === 'sealed' \? '内容封存中/.test(cap), '封存组仍展示正文预览');
  assert(/daysLeft/.test(cap) && /还没到开启的日子/.test(cap), '未做开启日守门');
  assert(/callDomainRaw<\{ id\?: string \}>\('saveCapsule'/.test(cap), '未区分 DATE_NOT_FUTURE 等业务错误码');
});

check('领域返回形状按 8 utils 真实契约解包（防「按想象写」回归）', function () {
  const extras = read('renderer-v2/src/components/TodayExtras.vue');
  assert(/f\.hint/.test(extras), '九格提示应取 activeGridFields 的 hint');
  assert(/WEATHER = \['晴'/.test(extras), '天气档位与原 BASE_FIELDS 不一致');
  const bar = read('renderer-v2/src/components/GreetingBar.vue');
  assert(/greeting\.text/.test(bar), 'greetings.compose 返回 {text,tag,hint} 对象');
  assert(/quotes\.dailyIndex/.test(bar), '每日名言未按日期确定性取索引');
  assert(/quote\.author/.test(bar), 'quotes.pick 返回 {text,author} 对象');
  const insight = read('renderer-v2/src/components/InsightView.vue');
  assert(/heatLevel\(.*cls/.test(insight), 'analyze.heat 的 cls 是复合类名，需提取 heat-lvN');
  assert(/c\.pct/.test(insight) && /p\.word/.test(insight), 'coverage / phrases 字段未按真实结构渲染');
  const panels = read('renderer-v2/src/components/ModulePanels.vue');
  // 学习这块已从旧学习库（md_study_library）换成 md_growth：
  // 快速录入只借「书」一种，有同名书就翻页、没有就先建书，不再写旧库（否则写进去没人显示）
  assert(/growth\.board/.test(panels) && /growth\.advanceBook/.test(panels), '快速录入未接 md_growth');
  assert(panels.indexOf('saveStudyLibrary') < 0, '快速录入还在写旧学习库（写进去没有界面显示）');
  assert(panels.indexOf('studyLibraryText') < 0, '面板仍按旧 studyLibraryText 契约渲染');
  const review = read('renderer-v2/src/components/ReviewView.vue');
  assert(/raw\.months/.test(review), 'yearPixels 返回 {months:[{cells}]}，不是扁平数组');
  assert(/asArray\(/.test(review), '汇总返回值形态不一，未统一抽数组');
  const habit = read('renderer-v2/src/components/HabitView.vue');
  assert(/mv\.list/.test(habit), 'milestoneView 的里程碑在 list 字段');
  assert(/dayNo/.test(habit), 'firstWeekState 用 dayNo，不是 day');
});

// ---------- GTD 工作台 + 九格双击进主功能 ----------

check('九格双击进入主功能：双击空白处触发、textarea 内保留系统选词', function () {
  const grid = read('renderer-v2/src/components/GridEditor.vue');
  assert(/\(e: 'open-cell', key: string\)/.test(grid), 'GridEditor 未声明 open-cell 事件');
  assert(/@dblclick="onCellDblClick\(\$event, key\)"/.test(grid), '格子未绑定双击');
  assert(/el\.tagName === 'TEXTAREA'/.test(grid), '未排除 textarea，写字时双击选词会跳页');
  assert(/进入' \+ GRID_LABELS\[key\] \+ '主功能/.test(grid), '缺少可见的展开入口（键盘/鼠标可达性）');
  const app = read('renderer-v2/src/App.vue');
  ['WorkView', 'MoneyView', 'StudyView', 'CellView'].forEach(function (c) {
    assert(app.indexOf("import " + c + " from './views/" + c + ".vue'") >= 0, 'App.vue 未接入 ' + c);
  });
  assert(/@open-cell="openCell"/.test(app), '九格事件未接到 App');
  assert(/cellKey\.value = key/.test(app) && /view\.value = 'cell'/.test(app), 'openCell 未切到 cell 视图');
  assert(/'cell'/.test(read('renderer-v2/src/types.ts')), "ViewKey 缺少 'cell'");
  assert(/view === 'cell'/.test(app), '缺少 cell 视图分支');
});

check('GTD 独立成模块：数据不进 utils、不进日记记录', function () {
  const board = read('src/gtd/board.js');
  ['normalize', 'addTask', 'clarify', 'board', 'weeklyReview', 'importLegacy', 'mergeSection']
    .forEach(function (fn) {
      assert(new RegExp(fn + ': ' + fn).test(board), 'GTD 缺少导出 ' + fn);
    });
  const utils = fs.readdirSync(path.join(__dirname, '../../src/utils')).filter(function (f) {
    return /\.js$/.test(f);
  });
  assert(utils.length === 8, 'src/utils 不再是 8 个文件（等价基线被改动）: ' + utils.join(','));
  const main = read('src/main/main-v2.js');
  assert(/GTD_KEY = 'md_gtd'/.test(main), '未使用独立数据键 md_gtd');
  assert(/repo\.get\(GTD_KEY\)/.test(main) && /repo\.set\(GTD_KEY/.test(main), 'GTD 未走仓储读写');
  // 打包清单漏一个 src 子目录，打出来的 exe 一启动就 require 失败。
  // 不逐个数：直接从主进程的 require 里推出「应该进包哪些目录」，再核对 yml——
  // 这样以后新增 src/xxx 模块而忘了写打包配置，静态门禁当场报错。
  const mainSrc = read('src/main/main-v2.js');
  const yml = read('electron-builder-v2.yml');
  const needDirs = {};
  (mainSrc.match(/require\('\.\.\/([a-z-]+)\//g) || []).forEach(function (m) {
    const d = m.replace(/require\('\.\.\//, '').replace(/\/$/, '');
    if (d && d !== 'main' && d !== 'preload') needDirs[d] = true;
  });
  assert(Object.keys(needDirs).length >= 3, '没解析出主进程依赖的模块目录：' + JSON.stringify(needDirs));
  Object.keys(needDirs).forEach(function (d) {
    assert(new RegExp('src/' + d + '/\\*\\*/\\*').test(yml), '打包配置漏了 src/' + d + '（产物缺模块，exe 会启动失败）');
  });
});

check('备份注入：gtd 段 + 封存箱 bin 段，且改走 diary.exportBackup 的最新引用', function () {
  const main = read('src/main/main-v2.js');
  // 不能缓存 rawExportBackup：封存箱会 reload diary-store，缓存旧引用会指向旧模块
  assert(!/rawExportBackup = diary\.exportBackup/.test(main), '仍缓存旧 exportBackup 引用（reload 后失效）');
  assert(/diary\.exportBackup\(\)/.test(main), '导出未走当前 diary 实例');
  assert(/obj\.gtd = gtdStore\.read\(\)/.test(main), '导出未注入 gtd 段（换机就丢 GTD）');
  assert(/obj\.bin = recycle\.snapshotForBackup\(\)/.test(main), '导出未注入封存箱段（换机就丢封存箱）');
  assert(/section = parsed && parsed\.gtd/.test(main), '导入未先摘出 gtd 段');
  assert(/binSection = parsed && parsed\.bin/.test(main), '导入未先摘出封存箱段');
  assert(/gtd\.mergeSection/.test(main), '导入未走「只补不改」合并');
  assert(/recycle\.mergeFromBackup/.test(main), '封存箱段未合并');
  assert(/report\.gtdImported/.test(main), '导入回执未带 GTD 段计数');
  assert(/report\.binImported/.test(main), '导入回执未带封存箱计数');
});

check('GTD 通道在白名单内且渲染层无越权调用', function () {
  const api = read('src/core/api-layer.js');
  ['gtd.read', 'gtd.statusMeta', 'gtd.add', 'gtd.update', 'gtd.remove', 'gtd.complete',
    'gtd.reopen', 'gtd.clarify', 'gtd.board', 'gtd.review', 'gtd.markReviewed',
    'gtd.projects', 'gtd.contexts', 'gtd.importLegacy'].forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, '白名单缺少 ' + n);
  });
  const main = read('src/main/main-v2.js');
  const calls = [];
  allVue().forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /(?:callDomain|domainCall)(?:<[^>]*>)?\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(text)) !== null) calls.push(m[1]);
  });
  const gtdCalls = calls.filter(function (c) { return c.indexOf('gtd.') === 0; });
  assert(gtdCalls.length >= 5, 'GTD 视图调用过少，疑似未真接：' + gtdCalls.length);
  gtdCalls.forEach(function (c) {
    assert(api.indexOf("'" + c + "'") >= 0, '渲染层调用了白名单外的 ' + c);
    assert(main.indexOf("'" + c + "':") >= 0, '主进程未挂载 ' + c);
  });
});

// ---------- 九格模块目录 + 富文本编辑 + 引导词 ----------

check('九格模块目录：9 项直挂「今天」下级、常驻展开、点击直达完整功能页', function () {
  const nav = read('renderer-v2/src/components/NavSidebar.vue');
  assert(/v-for="key in GRID_KEYS"/.test(nav), '目录未按 GRID_KEYS 渲染九格模块');
  assert(/emit\('open-cell', key\)/.test(nav), '目录项未发出 open-cell');
  assert(/class="nav-sub-item nav-mod"/.test(nav), '目录项缺少 nav-mod 标记');
  // 2026-11-08 23:16：折叠开关去掉——九格直接是「今天」的子项，不再藏一层
  assert(!/modulesOpen/.test(nav), '模块目录又塞回了折叠开关');
  assert(!/nav-sub-group/.test(nav), '「记录模块」这一层组还在');
  assert(/mod-dot-on/.test(nav), '目录项缺少「今日已写」状态点');
  const app = read('renderer-v2/src/App.vue');
  assert(/@open-cell="openCell"/.test(app), 'App 未接目录的 open-cell');
  assert(/:cell-key="cellKey"/.test(app) && /:filled-keys="todayFilled"/.test(app), 'App 未把当前格与已写格传给左栏');
  assert(/GRID_KEYS\.filter\(\(k\) => !!record\.value\.cells\[k\]\)/.test(app), '已写格判断未按今天的记录来');
});

check('梦想升成一级目标板、娱乐补进九格：格数、目录、账户与提醒都在', function () {
  const types = read('renderer-v2/src/types.ts');
  const keys = types.slice(types.indexOf('export const GRID_KEYS'), types.indexOf('] as const;'));
  const list = keys.match(/'[a-z]+'/g) || [];
  assert(list.length === 9, '九格不是 9 个：' + keys);
  // 2026-11-13 整改：第 7 格数据键回归领域层 dream，显示名改「休闲娱乐」。
  // 旧口径「leisure 替掉 dream」会让 save() 丢字，已作废。
  assert(list.indexOf("'dream'") >= 0, '九格里没有第 7 格 dream');
  assert(list.indexOf("'leisure'") < 0, '渲染层残留 leisure 键（会静默丢字）');
  // 标签要保留：旧数据的 cells.dream 仍要能显示名字
  assert(/dream: '休闲娱乐'/.test(types), '把第 7 格标签删了，旧数据会显示成空标签');
  assert(/\{ key: 'dream', label: '梦想' \}/.test(types), '左栏没有「梦想」一级目录');

  const app = read('renderer-v2/src/App.vue');
  assert(/<DreamView/.test(app) && /view === 'dream'/.test(app), 'App 没接梦想页');
  assert(/<DreamAlert/.test(app), 'App 没接梦想账户浮窗');

  const grid = read('renderer-v2/src/components/GridEditor.vue');
  assert(grid.indexOf('/ 9 格') < 0, '九格页头写死「/ 9 格」');
  assert(/GRID_KEYS\.length/.test(grid), '页头没按 GRID_KEYS.length 报数');
  assert(/grid-template-columns: repeat\(3/.test(grid), '九格不是三列了');

  const main = read('src/main/main-v2.js');
  ['dream.board', 'dream.add', 'dream.update', 'dream.remove', 'dream.setFund', 'dream.deposit',
    'dream.image', 'dream.setImage', 'dream.clearImage'].forEach(function (k) {
    assert(main.indexOf("'" + k + "'") >= 0, '主进程缺 ' + k);
  });
  assert(/obj\.dream = dreamStore\.read\(\)/.test(main), '导出备份没带梦想（换机会丢）');
  assert(/dream\.mergeSection/.test(main), '导入备份没合并梦想');
  const api = read('src/core/api-layer.js');
  ['dream.meta', 'dream.board', 'dream.add', 'dream.update', 'dream.remove',
    'dream.setTheme', 'dream.linkTask', 'dream.unlinkTask', 'dream.setFund', 'dream.deposit',
    'dream.image', 'dream.setImage', 'dream.clearImage'].forEach(function (k) {
    assert(api.indexOf("'" + k + "'") >= 0, '白名单缺 ' + k);
  });
  // 打包清单漏 src/dream，exe 一启动就白屏（已经踩过一次）
  assert(/src\/dream\/\*\*\/\*/.test(read('electron-builder-v2.yml')), '打包配置未包含 src/dream');

  const view = read('renderer-v2/src/views/DreamView.vue');
  // 分档标签由主进程 horizons 数据驱动，不靠界面写死一句说明；门禁改为验结构。
  assert(/class="hz-tabs"/.test(view) && /v-for="h in horizons"/.test(view), '界面没有期限分档 tab');
  assert(/h\.label/.test(view) && /h\.hint/.test(view), '分档标签没接主进程 horizons 数据');
  assert(/dream\.linkTask/.test(view) && /'gtd\.add'/.test(view), '目标不能拆成 GTD 行动');
  assert(view.indexOf('confirm(') < 0, '用了原生 confirm');
  // 2026-11-10：详细设置搬到右栏，中栏只留看板——同一份数据不能两个编辑入口
  assert(view.indexOf('goal-detail') < 0, '中栏还留着内联详情（应移到右栏）');
  assert(view.indexOf('dream.setFund') < 0 && view.indexOf('dream.deposit') < 0, '中栏还在写账户（应在右栏）');
  assert(/\(e: 'select-dream', id: string\)/.test(view), '中栏没有选中事件，右栏接不到当前目标');
  assert(/goal-on/.test(view), '选中行没有高亮，改哪条看不出来');
  assert(/props\.selected/.test(view), '中栏没接选中态');

  const alert = read('renderer-v2/src/components/DreamAlert.vue');
  assert(/role="alertdialog"/.test(alert), '浮窗不是 alertdialog，读屏读不到');
  assert(/dream\.board/.test(alert), '浮窗没读梦想数据');
  assert(/alerts/.test(alert), '浮窗没读 alerts 字段');
  assert(/标记达成之前/.test(alert), '浮窗没说清「到达成为止一直提醒」');
  assert(/setInterval/.test(alert), '浮窗只在挂载时查一次，存够后不会自己弹');

  // 右栏 = 图片窗 + 选中那条的详细设置（可写，只写选中的一条）
  const ctx = read('renderer-v2/src/components/context/DreamContext.vue');
  assert(/dream\.board/.test(ctx), '右栏没读梦想数据');
  assert(/ctx-kv/.test(ctx) && /三档期限/.test(ctx), '右栏没有三档期限分布');
  assert(/props\.dreamId/.test(ctx), '右栏没接当前选中的目标');
  assert(/class="dctx-photo"/.test(ctx), '右栏顶部没有梦想图片展示窗');
  assert(/dream\.image/.test(ctx) && /dream\.setImage/.test(ctx) && /dream\.clearImage/.test(ctx),
    '图片窗没接读图 / 设图 / 移除');
  assert(/pickImageFile/.test(ctx), '图片窗不能自己选图（没接原生选择器）');
  assert(/dream\.setFund/.test(ctx) && /dream\.deposit/.test(ctx), '右栏没接账户与存入');
  assert(/yuanToCents/.test(ctx), '金额没有「元进分存」的换算');
  assert(/量化分析/.test(ctx) && /日期与总结/.test(ctx), '右栏缺量化 / 日期总结两块');
  assert(/<input/.test(ctx) && /<textarea/.test(ctx), '右栏详情只读，改不了设置');

  const app2 = read('renderer-v2/src/App.vue');
  assert(/:dream-id="dreamSel"/.test(app2) && /@select-dream="dreamSel = \$event"/.test(app2),
    'App 没把梦想选中态接到右栏');
});

check('富文本存 Markdown 而非 HTML：四条纯文本链路不被污染', function () {
  const rt = read('renderer-v2/src/composables/useRichText.ts');
  ['htmlToMarkdown', 'markdownToHtml', 'stripMarkdown', 'markdownLength'].forEach(function (fn) {
    assert(new RegExp('export function ' + fn).test(rt), '缺少导出 ' + fn);
  });
  // 安全性：先转义再套标记，禁止把原文直接塞进 innerHTML
  assert(/function escapeHtml/.test(rt) && /inlineMarkdown\(raw[\s\S]{0,80}escapeHtml/.test(rt),
    'Markdown→HTML 未先转义，存在注入面');
  assert(/\*\*/.test(rt) && /~~/.test(rt) && /<blockquote>/.test(rt), '未覆盖粗体/删除线/引用');
  const cmp = read('renderer-v2/src/components/RichText.vue');
  assert(/htmlToMarkdown\(el\.innerHTML\)/.test(cmp), 'DOM 未序列化成 Markdown');
  assert(/getData\('text\/plain'\)/.test(cmp), '粘贴未降级为纯文本');
  assert(/compositionstart/.test(cmp) && /compositionend/.test(cmp), '中文输入法组合期未保护（会反复回写、光标乱跳）');
  assert(!/v-html/.test(cmp), '出现 v-html（CSP 与安全门禁都要求禁止）');
  // 九格与完整页都必须用同一套编辑器，否则完整页写了粗体、九格会露出 ** 标记
  const grid = read('renderer-v2/src/components/GridEditor.vue');
  const cell = read('renderer-v2/src/views/CellView.vue');
  assert(/<RichText/.test(grid) && /compact/.test(grid), '九格未接入富文本紧凑模式');
  assert(/<RichText/.test(cell), '完整书写页未接入富文本');
});

check('引导词接小程序同源 promptFor：可换一条、可插入引用', function () {
  const cmp = read('renderer-v2/src/components/RichText.vue');
  assert(/callDomain<string>\('promptFor'/.test(cmp), '引导词未走 diary-store.promptFor');
  assert(/promptOffset/.test(cmp) && /nextPrompt/.test(cmp), '缺少「换一条」');
  assert(/insertPrompt/.test(cmp) && /'\\n\\n' : ''\) \+ '> '/.test(cmp), '引导词未以引用块插入');
  assert(/第一|promptKey/.test(cmp), '引导词未按格绑定');
  const api = read('src/core/api-layer.js');
  assert(api.indexOf("'promptFor'") >= 0, 'promptFor 不在领域白名单');
  const cell = read('renderer-v2/src/views/CellView.vue');
  assert(/:prompt-key="cellKey"/.test(cell), '完整页未把当前格传给引导词');
});

check('右栏按模块联动：子面板一一对应，且只有「选中项详情」可写', function () {
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  assert(/:data-context="view"/.test(panel), '右栏未按当前视图打标记');
  const subs = [
    'TodayContext', 'WorkContext', 'StudyContext', 'CellContext', 'InsightContext', 'TimelineContext',
    'ReviewContext', 'CapsuleContext', 'HabitContext', 'DataContext', 'BinContext', 'InspireContext',
    'SettingsContext'
  ];
  subs.forEach(function (n) {
    assert(new RegExp('import ' + n + ' from').test(panel), 'ContextPanel 未接入 ' + n);
    assert(fs.existsSync(path.join(root, 'renderer-v2/src/components/context/' + n + '.vue')), '缺少子面板 ' + n + '.vue');
  });
  // 每个模块必须有专属分支，不能出现「fallback 到同一份卡片」
  assert(/v-if="view === 'today'"/.test(panel), '缺少 today 的专属右栏分支');
  ['cell', 'insight', 'timeline', 'review', 'capsule', 'free', 'habit', 'data', 'inspire'].forEach(function (v) {
    assert(new RegExp("v-else-if=\"view === '" + v + "'\"").test(panel), '缺少 ' + v + ' 的专属右栏分支');
  });
  // 单格分支：工作格与学习格各自成栏（要能改选中项的详情），金钱与其余六格仍在 CellContext
  assert(/cellKey === 'work'/.test(panel) && /<WorkContext/.test(panel), '工作格未路由到 WorkContext');
  assert(/cellKey === 'growth'/.test(panel) && /<StudyContext/.test(panel), '学习格未路由到 StudyContext');
  const cell = read('renderer-v2/src/components/context/CellContext.vue');
  assert(/cellKey === 'money'/.test(cell), '单格右栏未按格分支');
  assert(/moneySummary/.test(cell) && /insights\.analyze/.test(cell), '单格右栏未接真实领域能力');
  // 工作格与学习格已经在各自面板里，CellContext 不该再留会漂移的副本
  assert(cell.indexOf('gtd.board') < 0 && cell.indexOf('每周回顾') < 0, 'CellContext 仍留着工作格副本（会与 WorkContext 漂移）');
  assert(cell.indexOf('readStudyLibrary') < 0 && cell.indexOf('growth.board') < 0, 'CellContext 仍留着学习格副本（会与 StudyContext 漂移）');

  // 只读约束：除「本页选项」与「选中项详情」外，右栏不得出现写方法。
  // 右栏与中栏同写一份数据会造成状态打架；这两种例外都只写「当前这一条 / 这一页的设置」。
  const writeCalls = ['saveReview', 'gtd.add', 'gtd.complete', 'gtd.clarify', 'gtd.remove',
    'setTemplate', 'setModule', 'saveMilestones', 'saveCapsule', 'importBackup', 'upsertDiary'];
  const readonly = subs.filter(function (n) {
    return n !== 'WorkContext' && n !== 'StudyContext' && n !== 'TodayOptions';
  });
  const offenders = [];
  readonly.forEach(function (n) {
    const text = read('renderer-v2/src/components/context/' + n + '.vue');
    writeCalls.forEach(function (w) {
      if (text.indexOf("'" + w + "'") >= 0) offenders.push(n + ':' + w);
    });
  });
  assert(offenders.length === 0, '右栏出现写操作（应改为跳转中栏）: ' + offenders.join(', '));

  // WorkContext 可以写，但每一次写都必须钉在「当前选中的那一条」上：
  // 所有 gtd 写调用的第二个参数都是 sel.value.id，不许出现按 id 名随便改别的任务。
  const wc = read('renderer-v2/src/components/context/WorkContext.vue');
  const writes = wc.match(/callDomain\('gtd\.(update|remove|complete|reopen|completeAll|clarify|focusToggle|markReviewed)', null, [^)]*/g) || [];
  assert(writes.length >= 6, '右栏任务详情没有真正的写入口：' + writes.length);
  writes.forEach(function (w) {
    assert(/null, (sel\.value\.id|localDate|k\.id)/.test(w), '右栏写操作没钉住选中项: ' + w.slice(0, 60));
  });

  // StudyContext 同理：每一次写都必须落在「当前选中的那条考试 / 技能 / 主题」上
  const sc = read('renderer-v2/src/components/context/StudyContext.vue');
  const gWrites = sc.match(/callDomain\('growth\.[A-Za-z]+', null, [^)]*/g) || [];
  assert(gWrites.length >= 6, '学习右栏没有真正的写入口：' + gWrites.length);
  gWrites.forEach(function (w) {
    assert(/null, (exam|skill|theme)\.value\.id/.test(w), '学习右栏写操作没钉住选中项: ' + w.slice(0, 60));
  });

  // 类名前缀：上一轮 .heat-cell 与左栏热力撞名的教训，右栏统一 ctx-
  subs.forEach(function (n) {
    const text = read('renderer-v2/src/components/context/' + n + '.vue');
    assert(!/class="heat-cell/.test(text), n + ' 使用了无前缀 heat-cell');
  });
});

// ---- V1.1「把每一天接上，把数据守住」四项 ----

check('封存箱：软删挂在 StoragePort 上，不改一行冻结 utils', function () {
  const repo = read('src/core/repository.js');
  assert(/opts\.isHidden/.test(repo), '仓储未支持隐藏判定注入');
  assert(/if \(hidden\(key\)\) return ''/.test(repo), 'getStorageSync 未过滤封存键');
  assert(/return !hidden\(k\)/.test(repo), 'keys 视图未过滤封存键');

  const bin = read('src/core/recycle.js');
  assert(/const BIN_KEY = '__bin'/.test(bin), '封存箱未用 __ 前缀独立键');
  assert(/const KEEP_DAYS = 30/.test(bin), '保留天数不是 30');
  ['isHidden', 'seal', 'restore', 'purge', 'empty', 'sweep'].forEach(function (fn) {
    assert(new RegExp('function ' + fn + '\\(').test(bin), '封存箱缺 ' + fn);
  });
  // 封存只写标记、不动原值，否则还原就得靠备份
  const sealBody = bin.slice(bin.indexOf('function seal'), bin.indexOf('function restore'));
  assert(sealBody.length > 100, '未找到 seal 函数体');
  assert(!/repo\.remove\(/.test(sealBody), 'seal 里删了原值，还原会失败');

  const main = read('src/main/main-v2.js');
  assert(/recycle \? recycle\.isHidden\(key\) : false/.test(main), '主进程未注入隐藏判定');
  assert(/recycle = createRecycle/.test(main), '主进程未实例化封存箱');
  assert(/recycle\.sweep\(\)/.test(main), '启动未清理超期条目');
  // memo 失效：diary-store 只在内部 write() 清缓存，没有对外导出，只能重载模块
  assert(/delete require\.cache\[p\]/.test(main), '封存后未重载 diary-store，memo 会返回旧结果');
  assert(/domain\[k\] = function \(\) \{ return diary\[k\]\.apply/.test(main), 'domain 用了值拷贝，reload 后仍指向旧模块');
});

check('补记：记录读写跟 selectedDate，统计锚定真实今天', function () {
  const app = read('renderer-v2/src/App.vue');
  assert(/const selectedDate = ref\(today\)/.test(app), '缺少 selectedDate 状态');
  assert(/const isBackfill = computed/.test(app), '未区分补记态');
  assert(/<GreetingBar :today="today"/.test(app), '问候条统计被 selectedDate 污染');
  assert(/class="backfill-banner"/.test(app), '补记时缺少横幅提示');
  // 界面减负：口径说明不再常驻，改由上面的 :today="today" 绑定保证统计锚定真实今天。
  assert(app.indexOf('右侧统计仍按真实今天计算') < 0, '补记横幅仍堆着统计口径解释');
  assert(/next > today/.test(app), '允许补记未来日期');
  assert(/isContentEditable/.test(app), '快捷键未避开输入框（会抢系统按词移动光标）');

  const grid = read('renderer-v2/src/components/GridEditor.vue');
  assert(/backfill\?/.test(grid) && /保存补记/.test(grid), '九格未体现补记态');
});

check('数据健康中心：接上 persistence 既有能力，自动备份真的在跑', function () {
  const main = read('src/main/main-v2.js');
  assert(/persistence\.createSnapshot\(dataDir, 'auto'/.test(main), '自动备份未调用 createSnapshot');
  assert(/persistence\.listSnapshots\(dataDir\)/.test(main), '未使用 listSnapshots');
  assert(/autoBackup\.timer = setInterval/.test(main), '没有定时备份');
  assert(/autoBackup\.intervalMinutes \* 60 \* 1000/.test(main), '定时器未按配置间隔');
  assert(/pruneAutoSnapshots/.test(main), '没有滚动保留');
  assert(/if \(repo\.isDirty\(\)\) repo\.flush\('auto-backup'\)/.test(main), '快照前未 flush，会快照到旧数据');
  assert(/clearInterval\(autoBackup\.timer\)/.test(main), '退出未清定时器');
  assert(/healthChecker: buildHealth/.test(main), '未挂载健康检查器');

  const api = read('src/core/api-layer.js');
  assert(/route\('v1\/health:check'/.test(api), '缺少 health:check 路由');
  assert(/route\('v1\/health:backup'/.test(api), '缺少手动备份路由');

  const dc = read('renderer-v2/src/components/DataCenter.vue');
  assert(/class="health"/.test(dc), '数据中心没有健康卡');
  assert(/落后/.test(dc), '未如实说明备份落后篇数（说"一致"是谎话）');
  ['上次退出', '主文件', '备份文件', '快照', '数据规模', '自动备份'].forEach(function (k) {
    assert(dc.indexOf(k) >= 0, '健康卡缺少「' + k + '」');
  });
});

check('内联状态提示：三处都由软件算天数，不让用户自己盯日期', function () {
  const grid = read('renderer-v2/src/components/GridEditor.vue');
  assert(/天没写/.test(grid), '九格缺少「N 天没写」提示');
  assert(/cell\.lastWrittenMap/.test(grid), '九格提示未接真实数据');
  assert(/gap < 7/.test(grid), '提示未做阈值，会天天烦人');

  const work = read('renderer-v2/src/views/WorkView.vue');
  assert(/逾期 /.test(work), 'GTD 缺少「逾期 N 天」');
  assert(/waitingSince/.test(work), '等待天数未用准确起点（用 updatedAt 会在编辑后归零）');

  const cap = read('renderer-v2/src/components/CapsuleView.vue');
  assert(/已封存 /.test(cap), '胶囊缺少「已封存 N 天」');

  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  assert(/BinContext/.test(panel), '右栏没有封存箱专属面板');
  assert(/view === 'bin'/.test(panel), '封存箱缺少专属右栏分支');
});

check('中栏只写、右栏只读：单格工作台不再重复右栏的统计模块', function () {
  const cell = read('renderer-v2/src/views/CellView.vue');
  // 2026-11-08 主理人指出：中栏下部的指标 / 环比 / 热力 / 历史与右栏重复，已删除
  assert(cell.indexOf('class="metrics"') < 0, '中栏仍残留六项指标');
  assert(cell.indexOf('class="compare"') < 0, '中栏仍残留近 30 天环比');
  assert(cell.indexOf('cell-heat') < 0, '中栏仍残留 30 天热力');
  assert(cell.indexOf('class="history"') < 0, '中栏仍残留跨天历史');
  assert(cell.indexOf('insights.analyze') < 0, '中栏仍在拉洞察数据（右栏已拉，重复 IPC）');
  assert(/<RichText/.test(cell) && /保存到今日/.test(cell), '中栏应保留书写与保存');
  // 界面减负：不再写「统计去右栏看」，右栏接管由下面的 CellContext 结构断言保证。
  assert(cell.indexOf('都在右栏') < 0, '中栏仍堆着导航解释文案');

  const ctx = read('renderer-v2/src/components/context/CellContext.vue');
  assert(/最近写过/.test(ctx), '右栏未接管该格跨天历史');
  assert(/listDiaries/.test(ctx) && /stripMarkdown/.test(ctx), '右栏历史未接真实数据或未剥离 Markdown');
  assert(/slice\(0, 5\)/.test(ctx), '右栏历史未限条数，会挤爆侧栏');
  ['本期指标', '近 30 天', '这一格的读法'].forEach(function (k) {
    assert(ctx.indexOf(k) >= 0, '右栏缺少「' + k + '」');
  });
});

check('子任务树：只有两层、容器不可勾、删父只上抬不级联', function () {
  const gtd = read('src/gtd/board.js');
  // 数据层：父引用、压平、封顶
  assert(/parentId/.test(gtd), '任务没有 parentId');
  assert(/function resolveParent/.test(gtd), '缺少父链压平函数（会出现三层）');
  assert(/PARENT_DEPTH/.test(gtd) && /MAX_CHILDREN/.test(gtd), '缺少深度 / 子项数封顶常量');
  assert(/if \(visited\[cur\]\) return ''/.test(gtd), '没有环检测');
  // 删父只上抬，绝不级联删
  assert(/子项上抬成顶层/.test(gtd), '删除语义未写明「上抬而非级联」');
  assert(/t\.parentId === key\) t\.parentId = ''/.test(gtd), '删父时没有把子项上抬');
  // 容器不参与「可执行」
  assert(/container: \(kidOpen\[t\.id\] \|\| 0\) > 0/.test(gtd), 'board 没有标记容器');
  assert(/leafNext/.test(gtd) && /containerNext/.test(gtd), '没有区分叶子与容器计数');
  // 完成：查子项数 + 一并完成
  assert(/function completionInfo/.test(gtd) && /function completeAll/.test(gtd), '缺少完成前的子项检查 / 一并完成');
  assert(/completeAll: completeAll/.test(gtd), 'completeAll 未导出');

  const main = read('src/main/main-v2.js');
  assert(/'gtd\.completeAll'/.test(main), '主进程未注册 gtd.completeAll');
  assert(/childMax: gtd\.MAX_CHILDREN/.test(main), 'statusMeta 没把子项上限告诉界面');
  const api = read('src/core/api-layer.js');
  assert(api.indexOf("'gtd.completeAll'") >= 0, 'completeAll 不在领域白名单');

  const view = read('renderer-v2/src/views/WorkView.vue');
  assert(/treeRows/.test(view), '工作台没有组装两层树');
  assert(/gtd-kid-count/.test(view), '父行没有 已完成/总数 子项计数');
  assert(/gtd-kids-wrap/.test(view) && /gtd-kid\b/.test(view), '没有缩进的子项渲染');
  assert(/blockedId/.test(view) && /一并完成/.test(view), '勾父任务时没有拦截与「一并完成」出口');
  assert(/gtd-completeAll|'gtd\.completeAll'/.test(view), '界面没走 completeAll');
  assert(/parentId: ''/.test(view) && /提升/.test(view), '子项无法提升为独立任务');
  assert(/t\.status === 'next' \|\| t\.status === 'waiting'/.test(view), '收件箱/日程/将来也许也在拆子项（语义不对）');
  // 原生 confirm 会打断键盘流、也会卡住自动化断言
  assert(view.indexOf('confirm(') < 0, '用了原生 confirm 弹窗');

  const ctxPanel = read('renderer-v2/src/components/context/WorkContext.vue');
  assert(/openChildren/.test(ctxPanel), '右栏「先看这三条」未排除容器（会挑出没法动手的条目）');
});

check('工作台分栏分行：左栏三段可筛选、行内列对齐、点任务联动右栏', function () {
  const work = read('renderer-v2/src/views/WorkView.vue');
  // 分栏：清单 / 项目 / 情境 三段，竖排在左
  assert(/class="gtd-side"/.test(work), '工作台没有左侧分栏');
  assert(/class="side-sec"/.test(work), '分栏没有分段');
  assert(/清单<\/span>/.test(work) && /项目\s*<button class="side-plus"/.test(work), '分栏缺少「清单 / 项目」两段');
  // 项目 / 情境的名单是用户自己维护的：＋新建、双击改名、右键出菜单、项目可归档
  assert(/side-plus/.test(work) && /openSideAdd/.test(work), '分栏没有「＋」新建入口');
  assert(/dblclick\.stop="openSideEdit/.test(work), '项目/情境不能双击改名');
  assert(/openSideMenu/.test(work) && /actSideArchive/.test(work), '项目/情境缺右键菜单或归档动作');
  assert(/archivedProjects/.test(work) && /side-arch-list/.test(work), '归档项目没有回收出口（归档等于删除）');
  // 行内三格点一下就能改，面板底部还能设今日六条
  assert(/openPicker\(row\.task, 'ctx'/.test(work) && /openPicker\(row\.task, 'proj'/.test(work), '行内情境/项目不能点选');
  assert(/openPicker\(row\.task, 'due'/.test(work) && /pickValue\('due'/.test(work), '行内到期不能点选');
  assert(/toggleFocusOf/.test(work), '行内面板没有「今日六条」开关');
  // 项目与情境都要能点：只显示不能点，等于摆着看
  assert(/toggleProject/.test(work) && /projectFilter/.test(work), '项目分栏只能看不能筛');
  assert(/toggleContext/.test(work) && /contextFilter/.test(work), '情境不能筛选');
  // 分行：列头 + 三段固定列，扫一眼就能看出哪条逾期、哪条没情境
  assert(/class="gtd-colhead"/.test(work), '缺少列头，分行对不齐');
  assert(/gtd-cell-ctx/.test(work) && /gtd-cell-proj/.test(work) && /gtd-cell-due/.test(work), '行内没有拆成情境/项目/到期三列');
  // 已完成的 7 天内条目要能回看、能重开（board 一直在给 done 组，界面以前进不去）
  assert(/已完成/.test(work) && /counts\.done/.test(work), '看不到最近 7 天完成的任务');
  assert(/重开/.test(work), '已完成的任务没法重开');
  // 搜索与排序
  assert(/keyword/.test(work) && /gtd-search/.test(work), '清单没有搜索（找一条只能靠翻）');
  assert(/sortMode/.test(work) && /按到期|'due'/.test(work), '没有排序切换');
  // 选中态交给外壳：中栏只负责高亮，不自己另存一份
  assert(/emit\('select-task'/.test(work) && /props\.selected/.test(work), '点任务没有把选中态交给外壳');

  // 每周回顾整块搬到右栏：中栏不许再留副本（同一件事两处画，改一处就漂）
  assert(work.indexOf('class="review"') < 0, '中栏还留着每周回顾块');
  assert(work.indexOf('check-row') < 0, '中栏还留着五项检查');
  const wc = read('renderer-v2/src/components/context/WorkContext.vue');
  ['每周回顾', 'check-row', 'review-actions', '五项检查通过'].forEach(function (k) {
    assert(wc.indexOf(k) >= 0, '右栏缺少「' + k + '」');
  });

  // 外壳：一份选中态，同时喂给中栏与右栏
  const app = read('renderer-v2/src/App.vue');
  assert(/const gtdSel = ref\(''\)/.test(app), '外壳没有持有选中态');
  assert(/@select-task="gtdSel = \$event"/.test(app), '中栏/右栏的选中事件没接上');
  assert(/:task-id="gtdSel"/.test(app), '选中态没传给右栏');
});

check('学习成长三块：考试 / 技能 / 阅读各自成表，进度不折算成同一个百分比', function () {
  const g = read('src/growth/board.js');
  // 三张表：不是一张表加 type 字段——三种活动的「进度」不是同一个东西
  ['exams', 'skills', 'themes'].forEach(function (k) {
    assert(g.indexOf(k) >= 0, '缺 ' + k + ' 表');
  });
  assert(/function examRow/.test(g) && /subjectDone/.test(g) && /stageLabel/.test(g), '考试缺科目加权或阶段判定');
  assert(/function skillRow/.test(g) && /milestonePct/.test(g) && /weekMinutes/.test(g), '技能缺里程碑达成率或本周练习');
  assert(/function advanceBook/.test(g) && /finishedAt/.test(g), '阅读未按页推进或未记读完日');
  // 日期必须能回读：光靠 /^\d{4}-\d{2}-\d{2}$/ 会放过 2026-13-40
  assert(/function validDate/.test(g) && /getFullYear\(\) !== Number/.test(g), '日期没做回读校验');
  assert(/MAX_SUBJECTS/.test(g) && /MAX_PRACTICES/.test(g) && /MAX_QUOTES/.test(g) && /MAX_BOOKS/.test(g), '缺容量上限');
  // 旧学习库映射：课 → 技能，书/影/画 → 阅读；按标题去重，导两次不翻倍
  assert(/function importLegacy/.test(g) && /kind === 'course'/.test(g), '缺旧学习库导入或课程映射');
  assert(/未归类（旧学习库）/.test(g) && /theme\.books\.some/.test(g), '旧库导入没给兜底主题或没去重');

  const main = read('src/main/main-v2.js');
  assert(/GROWTH_KEY = 'md_growth'/.test(main), '未使用独立数据键 md_growth');
  assert(/obj\.growth = growthStore\.read\(\)/.test(main), '导出未注入 growth 段（换机就丢学习库）');
  assert(/growth\.mergeSection/.test(main) && /report\.growthImported/.test(main), '导入未合并 growth 段');
  assert(/'growth\.addExam'/.test(main) && /'growth\.addPractice'/.test(main), '主进程未注册三块领域函数');

  const api = read('src/core/api-layer.js');
  ['growth.board', 'growth.addExam', 'growth.addSkill', 'growth.addTheme',
    'growth.advanceBook', 'growth.addQuote', 'growth.importLegacy'].forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, n + ' 不在领域白名单');
  });
  const yml = read('electron-builder-v2.yml');
  assert(/src\/growth\/\*\*\/\*/.test(yml), '打包清单漏了 src/growth（exe 一启动就 require 失败）');

  const view = read('renderer-v2/src/views/StudyView.vue');
  assert(/考试考证/.test(view) && /技能学习/.test(view) && /主题阅读/.test(view), '三块没有各自入口');
  assert(/g-tab/.test(view) && /active === 'exam'/.test(view), 'tab 未驱动三套列表');
  assert(/growth\.addPractice/.test(view), '技能行没有练习快捷入口');
  assert(/growth\.advanceBook/.test(view), '阅读行没有翻页快捷入口');
  assert(/growth\.importLegacy/.test(view), '没有旧学习库导入入口');

  const ctx = read('renderer-v2/src/components/context/StudyContext.vue');
  ['growth.addSubject', 'growth.toggleMilestone'].forEach(function (n) {
    assert(ctx.indexOf(n) >= 0, '右栏三套详情表单不齐：缺 ' + n);
  });
  // P0-1（2026-11-16）：成长右栏不再写书单。
  // 书单的唯一写入方是图书馆（md_reading.books），这里再多写一遍就是「第二份真相」。
  // 旧条目仍只读展示，且必须给出去图书馆的入口与迁移欠账提示。
  ['growth.addBook', 'growth.advanceBook', 'growth.setBookStatus', 'growth.removeBook',
    'growth.addQuote', 'growth.removeQuote'].forEach(function (n) {
    assert(ctx.indexOf(n) < 0, '学习右栏仍在写 md_growth 书单（应与图书馆单源）：' + n);
  });
  assert(ctx.indexOf("emit('navigate', 'reading')") >= 0,
    '学习右栏没有「去图书馆维护书单」的出口');
  assert(ctx.indexOf("'reading.growthAudit'") >= 0, '学习右栏没有接旧书单迁移核对（欠账看不见）');
});

check('今日六点：只存指针、只在可执行里挑、跨天不结转', function () {
  const gtd = read('src/gtd/board.js');
  assert(/FOCUS_MAX = 6/.test(gtd), '六点没有上限常量');
  // 必须在 normalize 里显式放行，否则写进去再读就没了
  assert(/normalizeFocus\(src\.focus/.test(gtd), 'normalize 没有放行 focus');
  assert(/focus: focus/.test(gtd), 'normalize 返回值里没有 focus');
  assert(/function buildFocus/.test(gtd), '缺少 buildFocus');
  assert(/s\.focus\.date === today/.test(gtd), '六点没有跨天判定（会结转成永久积压）');
  // 候选只给可执行
  assert(/if \(t\.openChildren > 0\) return;/.test(gtd), '容器进了六点候选');
  // 删任务后焦点项自动消失
  assert(/hasOwnProperty\.call\(taskIds, id\)\) return null/.test(gtd), 'normalize 没清掉指向已删任务的焦点项');

  const main = read('src/main/main-v2.js');
  ['gtd.focus', 'gtd.focusCandidates', 'gtd.focusToggle', 'gtd.focusSet', 'gtd.focusClear'].forEach(function (k) {
    assert(main.indexOf("'" + k + "'") >= 0, '主进程缺通道 ' + k);
  });
  const api = read('src/core/api-layer.js');
  ['gtd.focus', 'gtd.focusCandidates', 'gtd.focusToggle', 'gtd.focusSet', 'gtd.focusClear'].forEach(function (k) {
    assert(api.indexOf("'" + k + "'") >= 0, '白名单缺 ' + k);
  });

  const app = read('renderer-v2/src/App.vue');
  // 2026-11-08 22:15：六条从今日页顶部横条并入「未来」格（改名「今日六条」）。
  // 这里反过来守：App 里不许再直挂 FocusBar，否则今日页又会长出第二条。
  assert(app.indexOf('<FocusBar') < 0, 'App 里还直挂着 FocusBar（今日页顶部又会长出横条）');
  assert(/cellKey === 'future'/.test(app), '「今日六条」格没接自己的主功能页');
  assert(/<FocusView/.test(app), 'App 没接 FocusView');
  assert(/<FocusView[\s\S]{0,80}v-else-if="cellKey === 'future'"/.test(app), 'FocusView 没绑到 future 格');
  const fv = read('renderer-v2/src/views/FocusView.vue');
  assert(/<FocusBar/.test(fv), 'FocusView 里没有六条本体');
  assert(/prompt-key="CELL"|:prompt-key="CELL"/.test(fv), '「给今天留一句」没接引导词');
  assert(/cells\[CELL\]/.test(fv), '这一格的正文没写回 cells.future');
  // 九格仍 9 格，且「未来」已改名「今日六条」，键不动（不动历史数据）
  const types = read('renderer-v2/src/types.ts');
  assert(/future: '今日六条'/.test(types), '九格「未来」没改名今日六条');
  assert(/'relation', 'future',/.test(types), 'future 键被改动（会丢历史数据）');
  // 入口藏在格子里，徽标必须给出「挑了几件 / 完成几件」
  const ge = read('renderer-v2/src/components/GridEditor.vue');
  assert(/class="cell-focus"/.test(ge) && /focusBadge/.test(ge), '九格没有六条进度徽标');
  assert(/'gtd\.focus'/.test(ge), '徽标没接 gtd.focus');

  const fb = read('renderer-v2/src/components/FocusBar.vue');
  assert(/for \(let i = 0; i < 6; i\+\+\)/.test(fb), '没有画满六个空位');
  assert(/fb-write/.test(fb) && /commitWrite/.test(fb), '没有「→ 格」');
  assert(/next\.cells\[key\]/.test(fb), '「→ 格」没写进记录');
  assert(/focusSet/.test(fb), '调序没走 focusSet');
  assert(fb.indexOf('confirm(') < 0, '用了原生 confirm');
  // 补记态不会串：六条锚定真实今天，不跟 selectedDate
  assert(/localDate\(\)/.test(fb), '六条没锚定真实今天');
});

check('厘清向导三步 + 速记四处分流 + 工作/账本记录窗', function () {
  const view = read('renderer-v2/src/views/WorkView.vue');
  assert(/clarifyStep/.test(view) && /第 \$\{clarifyStep\}|第 ' \+ clarifyStep/.test(view), '没有三步向导状态');
  assert(/wizardToStep2|wizardToStep3/.test(view), '缺少向导步骤推进');
  assert(/wizardIsMaterial/.test(view) && /someday/.test(view), '缺少「只是资料」出口');
  assert(/wizardTwoMinutes/.test(view), '缺少「两分钟做掉」出口');
  assert(/wizardCommit/.test(view), '缺少向导提交');
  // 今天做 = 进下一步并占一格六点
  assert(/gtd\.focusToggle/.test(view), '「今天做」没有占一格六点');
  // 原表单必须保留为高级模式，熟手不能被向导拖慢
  assert(/clarifyMode === 'advanced'/.test(view), '没有保留高级模式');
  assert(/class="cp-target"/.test(view), '高级模式里原表单丢了');

  const quick = read('renderer-v2/src/components/QuickNote.vue');
  ['free', 'gtd', 'capsule', 'ref'].forEach(function (k) {
    assert(quick.indexOf("key: '" + k + "'") >= 0, '速记缺去处 ' + k);
  });
  assert(/localStorage\.getItem\(TARGET_KEY\)/.test(quick), '速记没记住上次去处');
  assert(/localStorage\.setItem\(TARGET_KEY/.test(quick), '速记没写入上次去处');
  assert(/cap-date/.test(quick), '选胶囊没给开启日期');

  const app = read('renderer-v2/src/App.vue');
  assert(/payload\.target === 'gtd'/.test(app) && /'gtd\.add'/.test(app), '速记没接 GTD 收件箱');
  assert(/'saveCapsule'/.test(app), '速记没接胶囊');
  assert(/#资料/.test(app), '参考资料没有标记口径');

  const editor = read('renderer-v2/src/components/CellNoteEditor.vue');
  assert(/<RichText/.test(editor), '记录窗不是富文本');
  assert(/:prompt-key="cellKey"/.test(editor), '记录窗没有引导词');
  assert(/保存到今天/.test(editor), '记录窗没有「保存到今天」');
  assert(/cells\[props\.cellKey\]/.test(editor), '记录窗没写进对应格子');

  const work = read('renderer-v2/src/views/WorkView.vue');
  const money = read('renderer-v2/src/views/MoneyView.vue');
  assert(/<CellNoteEditor/.test(work) && /cell-key="work"/.test(work), '工作台没接记录窗');
  assert(/<CellNoteEditor/.test(money) && /cell-key="money"/.test(money), '账本没接记录窗');
});

check('定位 ≠ 过滤：定位不筛列表、过滤才筛，心情筛选只在过滤可用', function () {
  const rv = read('renderer-v2/src/components/ReviewView.vue');
  // 分水岭：定位模式必须画全量列表（viewRows），不许画 matchRows
  assert(/const viewRows = computed<LocRow\[\]>/.test(rv), '缺少定位用的全量列表');
  assert(/v-for="r in viewRows"/.test(rv), '定位模式没画全量列表（那就退化成过滤了）');
  assert(rv.indexOf('v-for="r in matchRows"') < 0, '定位模式直接遍历命中项，列表会跟着筛');
  // 跳转：Enter / Shift+Enter 上下依次，且要滚动到当前处
  assert(/function jump\(delta: number\)/.test(rv), '缺少「跳到下一处」');
  assert(/scrollIntoView/.test(rv), '跳转没有滚到当前处（等于没跳）');
  assert(/step\(\$event\.shiftKey\)/.test(rv), 'Enter / Shift+Enter 没分方向');
  assert(/\(activeIdx\.value \+ delta \+ n\) % n/.test(rv), '跳转没做首尾循环');
  // 高亮不引依赖、不动 DOM 字符串
  assert(/function segments\(text: string\)/.test(rv), '缺少命中切段渲染');
  assert(rv.indexOf('v-html=') < 0 && rv.indexOf('innerHTML') < 0, '高亮把正文当 HTML 直插了（CSP 下有注入面）');
  // 没命中要说清列表还是全量
  assert(/没有命中 · 列表仍是/.test(rv), '没命中时没说清列表仍是全量');
  // 心情筛选属于过滤
  assert(/:disabled="searchMode === 'locate'"/.test(rv), '定位模式下心情筛选没置灰');
  // 两种模式各走一侧数据源：过滤走服务端 search，定位走全量
  assert(/'search'/.test(rv), '过滤模式没接 search 领域函数');
  assert(/'all'/.test(rv), '定位模式没取全量日记');
});

check('未来 7 天在右栏：三源合并、只读、每行可跳', function () {
  const ctx = read('renderer-v2/src/components/context/TodayContext.vue');
  ['gtd.board', 'capsuleGroups', 'milestoneView'].forEach(function (k) {
    assert(ctx.indexOf("'" + k + "'") >= 0, '未来 7 天缺数据源 ' + k);
  });
  assert(/d > 7/.test(ctx) && /d < 0/.test(ctx), '未来 7 天没有窗口边界（会把远期和逾期混进来）');
  assert(/soonOverdue/.test(ctx), '逾期没单独计数');
  // 里程碑按「第 N 天」算，换算成日历日必须标「约」
  assert(/'约' \+ whenLabel/.test(ctx), '里程碑日期没标「约」，是把估算当排期');
  // 只读：右栏不出现输入控件
  const card = ctx.slice(ctx.indexOf('ctx-soon-card'), ctx.indexOf('往年今天'));
  assert(card.indexOf('<input') < 0 && card.indexOf('<textarea') < 0, '右栏预览里出现了输入控件');
  // 位置：中栏不放（会挤掉九格）
  const app = read('renderer-v2/src/App.vue');
  assert(app.indexOf('未来 7 天') < 0, '「未来 7 天」被塞进了中栏');
  // 只读但会被通知刷新：中栏改清单后右栏重取
  assert(/:tick="tick"/.test(read('renderer-v2/src/components/ContextPanel.vue')), '右栏没接 tick，改完清单不刷新');
});

check('问候头与名言分家：时间置顶、问候头无底色、名言独立成块在其下', function () {
  const bar = read('renderer-v2/src/components/GreetingBar.vue');
  const t = bar.indexOf('class="greeting-time"');
  const line = bar.indexOf('class="greeting-line"');
  const qb = bar.indexOf('class="quote-block"');
  const ql = bar.indexOf('class="quote-line"');
  assert(t > 0 && t < line, '时间没排在问候语之前（等于没置顶）');
  assert(qb > line && ql > qb, '名言块不在问候头之后，或名言不在块内');
  // 无底色：问候头的样式块里不许出现 background / border
  const headCss = bar.slice(bar.indexOf('.greeting-bar {'), bar.indexOf('.greeting-time {'));
  assert(!/background/.test(headCss), '问候头仍写了 background');
  assert(!/border/.test(headCss), '问候头仍写了 border');
  // 字体加大：问候语字号必须上到 20px 以上
  assert(/font-size:\s*clamp\(2\d|font-size:\s*2\dpx/.test(bar), '问候语字号没加大');
  // 名言块必须自己有色，否则与无底色的问候头糊成一片
  const qCss = bar.slice(qb);
  assert(/background:/.test(qCss) && /border-left:/.test(qCss), '名言块没有底色或竖线，与问候头分不开');
  // 两块各有各的名字，不能再用一个「问候与名言」糊住
  assert(/aria-label="今日问候"/.test(bar) && /aria-label="每日名言警句"/.test(bar), '两个模块共用一个 aria 名字');
});

check('皮肤收进标题栏、版权声明只留在全局底栏、本页选项在右栏', function () {
  const app = read('renderer-v2/src/App.vue');
  // 皮肤点必须在 titlebar 段里，不能又跑回右栏底部
  const bar = app.slice(app.indexOf('<header class="titlebar">'), app.indexOf('</header>'));
  assert(/class="skin-pick"/.test(bar), '标题栏里没有皮肤选择');
  assert(/class="skin-dot"/.test(bar), '皮肤色点缺失');
  assert(/role="radiogroup"/.test(bar), '皮肤组缺少 radiogroup 语义');
  // 色点色值不许硬编码十六进制：靠外层 data-skin 让 --palette-primary 解析成各皮肤色
  assert(/data-skin="\$\{?s\.id\}?"|:data-skin="s\.id"/.test(app), '色点没走皮肤作用域（会硬编码色值）');
  assert(!/#0f6e56|#185fa5|#993556|#854f0b/.test(app), '顶栏色点硬编码了色值（皮肤改了要改两处）');

  // 2026-11-09：这句声明原来在右栏每一个面板底部各印一遍，一页页重复等于噪音。
  // 收成全局底栏一条；反过来也要钉住——右栏不许再挂回来，废组件不许留着被人复用。
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  assert(panel.indexOf('ContextFooter') < 0, '右栏又重新挂上了版权卡（声明应只在底栏有一处）');
  assert(!fs.existsSync(path.join(root, 'renderer-v2/src/components/context/ContextFooter.vue')),
    'ContextFooter.vue 已废弃，不该再存在（留着就会被挂回去）');
  const status = read('renderer-v2/src/components/StatusBar.vue');
  assert(/V1\.0/.test(status), '底栏没有版本号');
  assert(/纯本地/.test(status), '底栏没有「纯本地」声明（合规口径不能说没就没）');
  // 接入本机时间源 + 首页天气后，「零网络」不能一句写死。
  // 2026-11-13 术语降级：「仅本机回环」是内部术语，面向用户改「仅本机使用」。
  // 四态都必须存在，且必须接上 wxOn / wtOn 两个开关，不能一边开天气一边写零网络。
  ['零网络', '仅本机使用', '仅天气联网', '仅本机 + 天气联网'].forEach(function (s) {
    assert(status.indexOf(s) >= 0, '底栏缺声明态：' + s);
  });
  assert(!/仅本机回环/.test(status), '底栏又出现内部术语「仅本机回环」');
  assert(/wtOn/.test(status) && /wt-on/.test(app), '底栏没接上时间源开关状态');
  assert(/wxOn/.test(status), '底栏没接上天气开关状态（开天气仍会写零网络）');
  assert(/不上传/.test(status), '底栏声明没写清「不上传」');
  // .cell 是九格的类：底栏一用，GUI 里数格子就数成 11 个（本轮真实踩过）
  assert(!/class="cell"/.test(status) && !/^\.cell\s*\{/m.test(status), '底栏用了 .cell，会和九格撞名');
  // 底栏只是一条读数，高度必须压住：28px 是原来的一整行内容高度
  assert(/grid-template-rows:[^;]*22px/.test(app), '底栏行高没压到 22px（又在占内容的高度）');

  // 右栏分层写清楚：只读关联 + 可写选项，别让后人以为右栏还是纯只读
  assert(/只读/.test(panel) && /可写/.test(panel), '右栏注释没写清两层职责（只读关联 / 可写选项）');
});

check('语料库：三类可增删改，删内置只记隐藏、恢复默认不动「我的」', function () {
  const lib = read('src/inspire/library.js');
  ['quotes', 'greetings', 'moves'].forEach(function (k) {
    assert(lib.indexOf("'" + k + "'") >= 0, '语料库缺少类别 ' + k);
  });
  // 数据形状：只装「我的 / 覆盖 / 隐藏」三样，内置正文留在代码里
  assert(/custom:\s*\{[^}]*quotes/.test(lib), '状态里没有 custom 段');
  assert(/overrides:\s*\{[^}]*quotes/.test(lib), '状态里没有 overrides 段');
  assert(/hidden:\s*\{[^}]*quotes/.test(lib), '状态里没有 hidden 段');
  assert(/quotes\.all\.forEach/.test(lib), '内置名言没有从 utils 引用，疑似整份复制进数据文件');

  // 主进程注册的每个 inspire.* 都必须在 IPC 白名单里，漏一个界面就报「函数不在白名单」
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  assert(/INSPIRE_KEY = 'md_inspire'/.test(main), '语料库没用独立数据键 md_inspire');
  const names = (main.match(/'(inspire\.[A-Za-z]+)'\s*:/g) || []).map(function (s) {
    return s.replace(/'/g, '').replace(':', '').trim();
  });
  assert(names.length >= 10, '主进程注册的语料库能力过少：' + names.length);
  names.forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, '白名单缺少 ' + n);
  });
  // 备份要带上，否则换机后自己的改写全丢
  assert(/obj\.inspire = inspireStore\.read\(\)/.test(main), '备份没有带上语料库段');
  assert(/parsed\.inspire/.test(main), '导入没有读语料库段');

  // 入口：数据中心下的二级目录 + App 的独立视图
  const nav = read('renderer-v2/src/components/NavSidebar.vue');
  assert(/nav-lib/.test(nav) && /emit\('navigate', 'inspire'\)/.test(nav), '左栏没有语料库二级入口');
  const app = read('renderer-v2/src/App.vue');
  assert(/import LibraryView from/.test(app) && /view === 'inspire'/.test(app), 'App 没接语料库视图');

  // 视图：六类动作都在，且「删内置」与「删我的」文案分开说
  const view = read('renderer-v2/src/views/LibraryView.vue');
  ['inspire.add', 'inspire.update', 'inspire.remove', 'inspire.restore', 'inspire.revert', 'inspire.reset'].forEach(function (n) {
    assert(view.indexOf("'" + n + "'") >= 0, '语料库视图缺少 ' + n);
  });
  assert(/内置原文没删/.test(view) && /已删除这一条/.test(view), '删内置与删自己的提示没分开');
  assert(/恢复内置默认/.test(view) && /一条没动/.test(view), '恢复默认没说明「我的」条目会保留');

  // 首页三条都从语料库取；语料库不可读才退回 utils
  const bar = read('renderer-v2/src/components/GreetingBar.vue');
  assert(/inspire\.today/.test(bar), '问候条没有从语料库取内容');
  assert(/动一动/.test(bar), '运动提示没有单独标出「动一动」');
  assert(/inspire\.pick/.test(bar) && /换一条/.test(bar), '名言没有「换一条」');
  assert(/emit\('navigate', 'inspire'\)/.test(bar), '问候条没有进语料库的入口');

  // 右栏只读：语料库的写操作一律留在中栏
  const ctx = read('renderer-v2/src/components/context/InspireContext.vue');
  ['inspire.add', 'inspire.update', 'inspire.remove', 'inspire.reset', 'inspire.toggle'].forEach(function (n) {
    assert(ctx.indexOf("'" + n + "'") < 0, '右栏出现写操作 ' + n + '（应改为跳转中栏）');
  });
});

// ---------- V1.3 时间纵深：五项能力 + 三条诚实边界 ----------
check('V1.3 时间纵深：零新键，主进程 / 白名单 / 打包配置都接上', function () {
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const names = (main.match(/'(v13\.[A-Za-z]+)'\s*:/g) || []).map(function (s) {
    return s.replace(/'/g, '').replace(':', '').trim();
  });
  assert(names.length >= 8, '主进程注册的 v13 能力过少：' + names.length);
  names.forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, '白名单缺少 ' + n);
  });
  assert(/src\/v13\//.test(read('electron-builder-v2.yml')), '打包配置漏了 src/v13');
  assert(!/md_v13|V13_KEY/.test(main), 'V1.3 不该新增数据键');
  assert(/data:image\/png;base64,/.test(main), '主进程没接 PNG 二进制落盘');
});

check('V1.3 人生月历：100 年 1200 格，未填生日不假装知道用户活了多久', function () {
  const lib = read('src/v13/board.js');
  const view = read('renderer-v2/src/views/LifeView.vue');
  assert(/years \* 12/.test(lib), '月历不是 100 年 × 12 月');
  assert(/从第一条记录算起/.test(lib), '未填生日时没有明示估算口径');
  assert(/basis === 'birth'/.test(lib), '填 / 未填生日的文案没分开');
  assert(/v13-month/.test(view) && /calYears/.test(view), '视图没画月历格');
  const nav = read('renderer-v2/src/components/NavSidebar.vue');
  assert(/nav-life/.test(nav) && /emit\('navigate', 'life'\)/.test(nav), '左栏没有时间纵深二级入口');
  const app = read('renderer-v2/src/App.vue');
  assert(/import LifeView from/.test(app) && /view === 'life'/.test(app), 'App 没接时间纵深视图');
});

check('V1.3 待办汇总只读、导出图默认无水印、一个文件只装数据', function () {
  const digest = read('renderer-v2/src/components/TodoDigest.vue');
  assert(!/domainCall\s*\(|saveExport\s*\(|upsertDiary/.test(digest), '待办汇总出现写调用');
  const view = read('renderer-v2/src/views/LifeView.vue');
  assert(/brand = ref\(false\)/.test(view), '导出图默认带了品牌水印');
  assert(/ctx\.fillText\(data\.brand \|\| ''/.test(view), '页脚没有按开关才写品牌');
  const lib = read('src/v13/board.js');
  assert(/app\.asar/.test(lib), '打包校验没排除程序文件');
  assert(/isDataKey/.test(lib), '打包没过滤非数据键');
  const dc = read('renderer-v2/src/components/DataCenter.vue');
  assert(/v13\.archiveInfo/.test(dc) && /v13\.pack/.test(dc) && /v13\.unpack/.test(dc), '数据中心没接「一个文件」');
  assert(/只装数据/.test(dc), '没说明打包产物不含程序文件');
});

// ---------- V2 领域层 / 备份 / GTD 新字段 / 三视图 / 诚实边界 ----------

check('V2 领域层：八个新模块都进了打包配置、白名单与主进程', function () {
  const yml = read('electron-builder-v2.yml');
  const api = read('src/core/api-layer.js');
  const main = read('src/main/main-v2.js');
  ['search', 'tags', 'recur', 'relation', 'review', 'trace', 'secure', 'attach'].forEach(function (d) {
    assert(yml.indexOf('src/' + d + '/') >= 0, '打包配置漏了 src/' + d);
  });
  ['search.', 'tags.', 'recur.', 'relation.', 'term.', 'trace.', 'secure.', 'attach.'].forEach(function (p) {
    assert(api.indexOf("'" + p) >= 0, '领域白名单缺少 ' + p + ' 前缀函数');
  });
  assert(/makeDomainStore/.test(main), '主进程缺少 makeDomainStore');
  ['md_tags', 'md_recur', 'md_relation', 'md_term_review', 'md_trace', 'md_attach'].forEach(function (k) {
    assert(main.indexOf("'" + k + "'") >= 0, '主进程缺少数据键 ' + k);
  });
});

check('V2 备份：六个新段导出导入都显式接线', function () {
  const main = read('src/main/main-v2.js');
  const exp = main.slice(main.indexOf('domain.exportBackup'), main.indexOf('domain.importBackup'));
  const imp = main.slice(main.indexOf('domain.importBackup'));
  ['tags', 'recur', 'relation', 'termReview', 'trace', 'attach'].forEach(function (k) {
    assert(new RegExp('obj\\.' + k + '\\s*=').test(exp), 'exportBackup 未注入 obj.' + k);
  });
  assert(imp.indexOf('V2_SECTIONS') >= 0, 'importBackup 缺少 V2_SECTIONS');
  assert(imp.indexOf('mergeSection') >= 0, 'importBackup 缺少 mergeSection 合并');
  assert(main.indexOf('obj.secure') < 0, '加密密文不应落独立键 obj.secure');
});

check('V2 GTD 新字段显式放行：contactId 与 repeat 不会被 normalize 削掉', function () {
  const board = read('src/gtd/board.js');
  assert(board.indexOf('contactId: clean(t && t.contactId') >= 0, 'normalize 未放行 contactId');
  assert(board.indexOf("repeat: ['day', 'week', 'month', 'year']") >= 0, 'normalize 未放行 repeat 档位');
  assert(board.indexOf('contactId: clean(p.contactId') >= 0, 'addTask 分支未接 contactId');
  assert(board.indexOf('if (p.contactId !== undefined)') >= 0, 'updateTask 分支未放行 contactId');
});

check('V2 三个新视图接入主窗与左栏，且右栏文案跟着换', function () {
  const app = read('renderer-v2/src/App.vue');
  ['RelationView', 'ConnectView', 'LongView'].forEach(function (c) {
    assert(app.indexOf('import ' + c + ' from') >= 0, 'App 未接入 ' + c);
  });
  ['relation', 'connect', 'long'].forEach(function (v) {
    assert(app.indexOf("view === '" + v + "'") >= 0, 'App 缺少 ' + v + ' 视图分支');
  });
  const nav = read('renderer-v2/src/components/NavSidebar.vue');
  ['connect', 'long'].forEach(function (v) {
    assert(nav.indexOf('nav-' + v) >= 0, '左栏缺少 nav-' + v);
    assert(nav.indexOf("emit('navigate', '" + v + "')") >= 0, '左栏 ' + v + ' 未发出 navigate');
  });
  // 2026-11-16：关系经营从「时间轴」二级目录并回九格第 4 格。
  // 左栏不许再有第二行同名入口；九格这一行点进去就是关系台，且要能高亮。
  assert(nav.indexOf('nav-relation') < 0, '时间轴下还留着关系经营二级入口（与九格重复）');
  assert(nav.indexOf('└ 关系经营') < 0, '时间轴下还画着「└ 关系经营」');
  assert(/props\.active === 'relation' && key === 'relation'/.test(nav), '九格关系行没有接上关系台高亮');
  assert(/if \(key === 'relation'\) \{ navigate\('relation'\); return; \}/.test(app),
    '九格关系格未直通关系台（仍会落到通用单格页）');
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  ['relation:', 'connect:', 'long:'].forEach(function (k) {
    assert(panel.indexOf(k) >= 0, '右栏 HINTS 缺少 ' + k);
  });
  assert(panel.indexOf("relation: '关系经营'") >= 0, '右栏 headTitle 未把 relation 映射成关系经营');
  const types = read('renderer-v2/src/types.ts');
  ["'relation'", "'connect'", "'long'"].forEach(function (k) {
    assert(types.indexOf(k) >= 0, 'ViewKey 缺少 ' + k);
  });
});

check('V2 界面减负：元解释不常驻主界面，必要边界统一收进设置页', function () {
  const rel = read('renderer-v2/src/views/RelationView.vue');
  assert(rel.indexOf('我能帮他什么') >= 0, '关系视图缺少「我能帮他什么」');
  assert(rel.indexOf('约一下') >= 0 && rel.indexOf('记一次') >= 0, '缺少「约一下 / 记一次」两个入口');
  ['健康度评分', '他给过我什么'].forEach(function (w) {
    let from = 0;
    let at;
    while ((at = rel.indexOf(w, from)) >= 0) {
      const before = rel.slice(Math.max(0, at - 16), at);
      assert(/不做|不算|没有/.test(before), w + ' 被当成真实功能使用（应只在否定语境里出现）');
      from = at + w.length;
    }
  });

  // 只看 <template>：script 里出现 domain 名 / 公式是实现，不是界面噪音。
  function tpl(src) {
    const m = src.match(/<template>([\s\S]*?)<\/template>/);
    return m ? m[1] : src;
  }
  const long = read('renderer-v2/src/views/LongView.vue');
  const con = read('renderer-v2/src/views/ConnectView.vue');
  const banned = [
    '牺牲精度', '诚实说明', '诚实降级', '克制条款', '心理学常数',
    '自动清除等于', '零新键', '纯 Markdown', '原地重置', '不编造倒计时',
    'search.or', 'recur.week', 'relation.meta', 'gtd.add'
  ];
  [['关系', tpl(rel)], ['长期', tpl(long)], ['内容连接', tpl(con)]].forEach(function (pair) {
    banned.forEach(function (w) {
      assert(pair[1].indexOf(w) < 0, pair[0] + '视图又常驻了设计/实现解释：' + w);
    });
  });
  // 必须当场告知的风险，保留一句最短的
  assert(long.indexOf('忘记口令即不可恢复') >= 0, '加密区缺少口令不可恢复的即时告知');

  // 被移走的边界统一收进设置页默认收起的入口，信息不丢、界面不吵
  const settings = read('renderer-v2/src/components/SettingsView.vue');
  assert(/<details[\s\S]*?<summary[^>]*>功能说明与边界<\/summary>/.test(settings), '设置页缺少统一说明入口');
  assert(!/<details[^>]*\sopen/.test(settings), '说明入口不应默认展开');
  ['无任何后门', '只存路径', '不做养生', '不做计时器', '启发式近似', 'e^(−S/6)', '不自动清除'].forEach(function (t) {
    assert(settings.indexOf(t) >= 0, '说明入口缺少约束：' + t);
  });
  assert(settings.indexOf('WRITE_TIPS') < 0 && settings.indexOf('v-for="(t, i) in') < 0, '设置页还留着提示词清单');

  const digest = read('renderer-v2/src/components/TodoDigest.vue');
  assert(digest.indexOf('domainCall(') < 0 && digest.indexOf('saveExport(') < 0, '待办汇总出现写调用（应只读）');
});

// ---------- 图书馆 / 读书笔记（docs/13）----------
check('图书馆接线：顶栏入口 / ViewKey / 独立窗口 / 右栏四处在位，一级导航仍 6+1', function () {
  const app = read('renderer-v2/src/App.vue');
  // V3.14：图书馆改成独立窗口，主窗不再内嵌视图；顶栏按钮与 ViewKey 仍必须留着，
  // 否则右栏「图书馆 →」、学习台的在读书等旧入口会跳空。
  assert(app.indexOf('class="reading-btn"') >= 0, '顶栏缺少「图书馆」按钮');
  assert(app.indexOf('openLibrary') >= 0, '顶栏按钮没接开窗');
  assert(app.indexOf("if (key === 'reading')") >= 0, "navigate('reading') 没保留（旧入口会跳空）");
  assert(app.indexOf('LibraryView v-else-if') >= 0, 'LibraryView（语料库）被串到别的视图了');
  const types = read('renderer-v2/src/types.ts');
  assert(types.indexOf("'reading'") >= 0, 'ViewKey 缺少 reading');
  const decl = types.match(/NAV_ITEMS[\s\S]*?\];/);
  assert(decl && (decl[0].match(/\{ key: '/g) || []).length === 6, '一级导航必须仍是 6 项 + 设置（GUI #122）');
  // 右栏的 ReadingContext 仍在（主窗右栏的 reading 分支保留，只是主窗不再切到该页；
  // ContextPanel 仍是 reading 页面的定义处，独立窗口改用自带三栏，故这里只锁「不被拆掉」）
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  assert(panel.indexOf('import ReadingContext from') >= 0, '右栏未接入 ReadingContext');
  assert(panel.indexOf("view === 'reading'") >= 0, '右栏缺少 reading 分支');
  assert(panel.indexOf("reading: ''") >= 0, '右栏 HINTS 缺少 reading');
  const win = read('renderer-v2/src/views/LibraryWindow.vue');
  assert(win.indexOf('九格手记 · 图书馆') >= 0 || win.indexOf('图书馆独立窗口') >= 0, '独立窗口视图没立起来');
});

check('图书馆：主题阅读 V2.14 自建书单（md_reading），功能与休闲一致', function () {
  const v = read('renderer-v2/src/views/ReadingView.vue');
  assert(v.indexOf('reading.themeAdvance') >= 0, '主题翻页通道仍在');
  assert(v.indexOf('reading.themeAdd') >= 0 && v.indexOf('addNewTheme') >= 0, '主题页缺少自建主题');
  assert(v.indexOf('reading.addFiles') >= 0 && v.indexOf('pickThemeFiles') >= 0, '主题页缺少导入电子书');
  assert(v.indexOf('reading.importGrowthThemes') >= 0, '主题页缺少一次性迁移旧书单');
  assert(v.indexOf('themes') >= 0 && v.indexOf('themeGroups') >= 0, '主题分组未接新权威源');
  assert(v.indexOf('reading.addBook') >= 0, '休闲阅读缺少自建书单');
  // 主题页与休闲页同款批注器：章节大纲 / 伴读三问 / 闪念 / 已有笔记
  assert(v.indexOf('主题阅读器') >= 0 && v.indexOf('章节大纲') >= 0 && v.indexOf('伴读三问') >= 0,
    '主题批注器未与休闲阅读对齐');
  const main = read('src/main/main-v2.js');
  assert(main.indexOf('function themeBooksFlat()') >= 0, '旧 growth 书单只读派生仍保留（导入用）');
  assert(main.indexOf('function themeGroupsFromReading()') >= 0, '主进程缺少主题书新派生');
  assert(main.indexOf("'reading.importGrowthThemes'") >= 0, '主进程缺旧书单迁移路由');
  assert(main.indexOf("mode: b.themeId ? 'theme' : 'leisure'") >= 0, '阅读窗未按 themeId 判 mode');
  assert(main.indexOf('obj.reading = readingStore.read()') >= 0, '备份导出未注入 reading 段');
  assert(main.indexOf("['reading', readingStore, readingMod]") >= 0, '备份导入未接 reading 段');
  const board = read('src/reading/board.js');
  assert(board.indexOf('function addTheme') >= 0 && board.indexOf('function importGrowthThemes') >= 0,
    '领域层缺少主题 mutator');
  const white = read('src/core/api-layer.js');
  assert(white.indexOf("'reading.themeAdvance'") >= 0, '白名单缺 reading.themeAdvance');
  assert(white.indexOf("'reading.importGrowthThemes'") >= 0, '白名单缺 reading.importGrowthThemes');
  assert(white.indexOf("'reading.exportMd'") >= 0, '白名单缺 reading.exportMd');
  assert(read('electron-builder-v2.yml').indexOf('src/reading/**/*') >= 0, '打包清单漏了 src/reading');
});

check('九格回写：只追加、带出处、防重复、补记态不冒充当天', function () {
  const v = read('renderer-v2/src/views/ReadingView.vue');
  assert(v.indexOf('old ? old + ') >= 0 && v.indexOf('base.cells[target] = old') >= 0, '回写必须是追加而非覆盖');
  assert(!/base\.cells\[target\]\s*=\s*line\s*;/.test(v), '出现覆盖式回写');
  // 冻结 utils 的 GRID_KEYS 第 7 格仍是 dream，渲染层写成 leisure 会被 save() 静默丢掉。
  // 图书馆回写必须经 safeCell 绕行（docs/13 §10），不许直接写 leisure。
  assert(v.indexOf('function safeCell') >= 0 && v.indexOf("cell === 'leisure' ? 'free'") >= 0,
    '缺少 leisure 失效键的绕行映射');
  assert(v.indexOf("n.mode === 'theme' ? 'growth' : 'free'") >= 0, '休闲阅读笔记不得直写 leisure');
  assert(v.indexOf('reading.diaryLine') >= 0, '回写行未由领域层生成');
  assert(v.indexOf('reading.markPushed') >= 0, '缺少防重复标记');
  assert(v.indexOf('props.backfill') >= 0, '补记态未拦截');
  assert(v.indexOf('闪念入格') >= 0, '缺少即时想法一键入格');
  const b = read('src/reading/board.js');
  assert(b.indexOf('function noteToDiaryLine') >= 0, '领域层缺少回写行生成');
  assert(b.indexOf('function markPushed') >= 0, '领域层缺少防重复');
});

check('图书馆右栏只读；方法学四个落点都在界面上', function () {
  const c = read('renderer-v2/src/components/context/ReadingContext.vue');
  ['reading.add', 'reading.update', 'reading.remove', 'saveExport', 'upsertDiary'].forEach(function (w) {
    assert(c.indexOf(w) < 0, '右栏出现写调用：' + w);
  });
  const v = read('renderer-v2/src/views/ReadingView.vue');
  ['伴读三问', '批注贴着原文长', '章节大纲', '读书笔记 · 数据库', '已入九格'].forEach(function (w) {
    assert(v.indexOf(w) >= 0, '阅读视图缺少：' + w);
  });
});

// ---------- 本地电子书（V2.4）----------
check('本地电子书：通道一致、渲染层零越权、只登记路径', function () {
  const pre = read('src/preload/v2-preload.js');
  const api = read('src/core/api-layer.js');
  assert(pre.indexOf("'v1/file:pick'") >= 0, 'preload 未放行文件选择通道');
  assert(api.indexOf("route('v1/file:pick'") >= 0, 'api-layer 未实现文件选择路由');
  assert(pre.indexOf('getPathForFile') >= 0, '拖放取路径未走 webUtils.getPathForFile');
  const bridge = read('renderer-v2/src/bridge.ts');
  assert(bridge.indexOf('pathForFile(file: File)') >= 0, 'bridge 未封装拖放路径');
  assert(bridge.indexOf('pickBookFiles') >= 0, 'bridge 未封装点击选择');
  const v = read('renderer-v2/src/views/ReadingView.vue');
  assert(v.indexOf('type="file"') < 0, '阅读视图出现裸文件选择框');
  assert(v.indexOf('jiugeBridge') < 0 && v.indexOf('ipcRenderer') < 0, '阅读视图越过 bridge 出境');
  const main = read('src/main/main-v2.js');
  assert(main.indexOf('reading.addFiles') >= 0 && main.indexOf('fs.statSync(p)') >= 0, '登记前未校验文件');
  assert(main.indexOf('readingMod.hasPath') >= 0, '缺少路径去重');
  // V2.5：「本机打开」下线，正文改在应用内读；开窗是主进程职责，渲染层只传 bookId
  assert(main.indexOf('shell.openPath') < 0, '「本机打开」应已移除，正文必须在应用内读');
  assert(main.indexOf('READER_HTML') >= 0 && main.indexOf('openReaderWindow') >= 0, '主进程缺独立阅读窗口');
  // 「只登记路径」这条只管电子书：入馆那段不许出现任何复制。
  // 梦想图片是另一回事——12MB 以内的配图必须复制进数据目录，否则原图一挪就断。
  const libBlock = main.slice(main.indexOf("'reading.addFiles'"), main.indexOf("'reading.cover'"));
  // 只查 copyFileSync：EPUB 封面那点小图本来就 writeFileSync 到 covers/，不是正文
  assert(libBlock.indexOf('fs.copyFileSync') < 0, '不允许把电子书正文复制进库');
  const white = read('src/core/api-layer.js');
  ["'reading.addFiles'", "'reading.cover'", "'reading.revealBook'"].forEach(function (w) {
    assert(white.indexOf(w) >= 0, '领域白名单缺少 ' + w);
  });
  ["'reading.readerOpen'", "'reading.readerChapter'", "'reading.readerProgress'"].forEach(function (w) {
    assert(white.indexOf(w) >= 0, '领域白名单缺少 ' + w);
  });
  assert(white.indexOf("'reading.openBook'") < 0, '白名单仍留着 reading.openBook（本机打开已下线）');
});

check('本地电子书：零依赖解析、体积上限、封面只走 dataURL', function () {
  const e = read('src/reading/epub.js');
  const requires = e.match(/require\('[^']+'\)/g) || [];
  assert(requires.length > 0 && requires.every(function (r) {
    return r === "require('fs')" || r === "require('zlib')";
  }), 'EPUB 解析引入了第三方依赖（根包必须零运行时依赖）');
  assert(e.indexOf('MAX_FILE_BYTES') >= 0 && e.indexOf('MAX_COVER_BYTES') >= 0, '缺少体积上限');
  assert(e.indexOf("'..'") >= 0, '缺少 zip 路径穿越防护');
  const main = read('src/main/main-v2.js');
  assert(main.indexOf("'data:' + mime + ';base64,'") >= 0, '封面不是 dataURL（CSP 不允许 file:）');
  assert(/img-src 'self' data:/.test(read('renderer-v2/index.html')), 'CSP 变了，封面展示方式要重评');
  const b = read('src/reading/board.js');
  assert(b.indexOf('bookByPath') >= 0 && b.indexOf('filePath: clip') >= 0, '路径字段未进 normalize');
});

check('本地电子书：拖放 / 选择 / 详细列表 / 封面预览四个入口都在', function () {
  const v = read('renderer-v2/src/views/ReadingView.vue');
  ['rd-drop', '选择电子书', '详细列表', '封面预览', 'rd-grid', 'rd-card-img', '翻开读'].forEach(function (w) {
    assert(v.indexOf(w) >= 0, '缺少：' + w);
  });
  assert(v.indexOf('@drop="onDrop"') >= 0 && v.indexOf('@dragover.prevent') >= 0, '拖放事件没接');
  assert(v.indexOf('localStorage.setItem(VIEW_KEY, m)') >= 0, '陈列偏好未记忆');
  assert(v.indexOf('reading.addFiles') >= 0 && v.indexOf('reading.cover') >= 0, '领域调用没接');
  assert(v.indexOf('本机打开') < 0, '书架仍留着「本机打开」按钮');
  assert(v.indexOf('openReader') >= 0 && v.indexOf('startBook') >= 0, '「翻开读」没接独立阅读窗口');
});

check('书架整理：搜索 / 排序 / 拖动 / 编辑信息 / 再读 / 按书导出', function () {
  const v = read('renderer-v2/src/views/ReadingView.vue');
  // V3.14：搜索与排序并进页签行，原来那一整行「书架整理」（rd-tools）已拆掉，
  // 钩子改为直接锁「搜索框 + 排序组」这两个实体，别锁容器名。
  ['rd-search', 'rd-sort', 'shelfKw', 'sortMode', 'onDragStart', 'onDropBook', 'openEdit', 'saveEdit',
    'pickCover', 'resetCover', 'reread', 'markDone', 'exportBook', 'lastReadAt', 'fmtRecent',
    'reading.reorder', 'reading.reread', 'reading.updateBook', 'reading.setCover'].forEach(function (w) {
    assert(v.indexOf(w) >= 0, '书架整理缺少：' + w);
  });
  // 搜索与排序只作用于渲染层：两处列表都必须用过滤后的 shelfBooks，否则搜索形同虚设
  assert((v.match(/v-for="b in shelfBooks"/g) || []).length >= 2, '详细列表 / 封面预览没接过滤后的书架');
  assert(v.indexOf(':draggable="canDrag"') >= 0, '拖动没接 canDrag');
  assert(v.indexOf("sortMode.value === 'manual' && !shelfKw.value.trim()") >= 0,
    '搜索态或最近在读态下仍可拖，会把看不见的书挤出可见区');
  assert(v.indexOf('rd-modal') >= 0 && v.indexOf('aria-modal="true"') >= 0, '编辑书籍信息缺模态语义');
  assert(v.indexOf('原文件没动') >= 0, '改书名必须明确「不动原文件」的口径');
  // 领域层：顺序与最近在读都由 board 统一重排，渲染层不许自己动数组
  const b = read('src/reading/board.js');
  ['reorderBooks', 'rereadBook', 'touchBook', 'lastReadAt:', 'order: num'].forEach(function (w) {
    assert(b.indexOf(w) >= 0, '领域层缺少：' + w);
  });
  // 主进程四条新路由 + 白名单：少一条就是「按钮点了没反应」
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  ["'reading.reorder'", "'reading.reread'", "'reading.touch'", "'reading.setCover'"].forEach(function (w) {
    assert(main.indexOf(w) >= 0, '主进程缺路由：' + w);
    assert(api.indexOf(w) >= 0, '白名单缺：' + w);
  });
});

check('阅读窗口本机字体：只读枚举 / 不起子进程 / 换字只换规则', function () {
  const html = read('renderer-v2/reader/index.html');
  const js = read('renderer-v2/reader/reader.js');
  const fonts = read('src/reading/fonts.js');
  assert(html.indexOf('rrSystemFonts') >= 0 && html.indexOf('本机已装字体') >= 0, '缺少「本机字体」这一档');
  // 只占一个控件位：实测多一个下拉就会把「缩放 / 行距」挤到工具栏第二行
  assert((html.match(/<select/g) || []).length === 4, '工具栏下拉从 4 个变多了，先确认缩放/行距没被挤到第二行');
  assert(js.indexOf("const SYS_PREFIX = 'sys:'") >= 0, '本机字体没加前缀，会和 fixed 方案值撞键');
  assert(js.indexOf("'reading.systemFonts'") >= 0, '本机字体没走领域白名单');
  assert(js.indexOf('applyDeviceFont') >= 0 && js.indexOf('rr-device-font') >= 0,
    '按族名生成的规则没单独成表，选什么字体都不会生效');
  assert(js.indexOf('fontListCache') >= 0, '字体清单没缓存，每切一次方案都要重扫一遍');
  // 字体枚举放在主进程：直接读字体文件，不 spawn PowerShell（那条路要靠 Base64 绕开代码页）
  assert(fonts.indexOf("require('fs')") >= 0, '字体枚举没走文件系统');
  ['child_process', 'execSync', 'spawn(', 'powershell'].forEach(function (w) {
    assert(fonts.indexOf(w) < 0, '字体枚举起了子进程：' + w);
  });
  // nameID 16 是 Chromium 按 CSS font-family 匹配的那一套，只收 1 会让新式字体永远命中不了
  assert(fonts.indexOf('nameID !== 1 && nameID !== 16') >= 0, '族名只收 nameID 1，新式字体命不中');
  assert(fonts.indexOf('0x0804') >= 0, '没认中文语言位，中文族名会退化成英文名');
  assert(read('src/main/main-v2.js').indexOf("'reading.systemFonts'") >= 0, '主进程缺字体路由');
});

check('独立阅读窗口：三栏骨架、正文沙箱、渲染层零越权', function () {
  const html = read('renderer-v2/reader/index.html');
  const js = read('renderer-v2/reader/reader.js');
  const css = read('renderer-v2/reader/reader.css');
  ['rr-app', 'rr-top', 'rr-left', 'rr-main', 'rr-right', 'rr-toc', 'rr-page', 'rr-unsupported',
    'rr-ask', 'rr-q9-list', 'rr-flash', 'rr-note-list', 'rr-status', 'rr-status-msg'].forEach(function (w) {
    assert(html.indexOf(w) >= 0, '阅读窗口缺少：' + w);
  });
  assert(/sandbox="allow-same-origin"/.test(html), '正文 iframe 必须是 allow-same-origin（父窗口要读划选）');
  assert(html.indexOf('allow-scripts') < 0, '正文 iframe 不得放行脚本');
  ['require(', 'ipcRenderer', 'fetch(', 'XMLHttpRequest', 'type="file"', 'http://', 'https://'].forEach(function (w) {
    assert(js.indexOf(w) < 0 && html.indexOf(w) < 0, '阅读窗口越过 bridge 出境：' + w);
  });
  assert(js.indexOf('function safeCell') >= 0 && js.indexOf("cell === 'leisure' ? 'free'") >= 0,
    '阅读窗口缺 leisure 失效键的绕行映射');
  assert(js.indexOf('old ? old + ') >= 0, '阅读窗口的九格回写必须追加而非覆盖');
  assert(js.indexOf('v1/diaries:upsert') >= 0, '阅读窗口没走日记写入口');
  assert(js.indexOf('v1/domain:call') >= 0, '阅读窗口没走领域白名单');
  assert(/grid-template-columns/.test(css) && css.indexOf('rr-left') >= 0 && css.indexOf('rr-right') >= 0,
    '三栏布局未成立（缺少左/右栏栅格）');
  const main = read('src/main/main-v2.js');
  assert(main.indexOf('readerOpener: openReaderWindow') >= 0, '开窗函数没挂到 api-layer');
  assert(main.indexOf("query: { bookId: bookId, mode:") >= 0, '开窗未传 bookId / mode');
  const api = read('src/core/api-layer.js');
  assert(api.indexOf("route('v1/reader:open'") >= 0, '缺 v1/reader:open 路由');
  assert(read('src/preload/v2-preload.js').indexOf("'v1/reader:open'") >= 0, 'preload 未放行阅读窗口通道');
  assert(read('electron-builder-v2.yml').indexOf('renderer-v2/reader/**/*') >= 0, '打包清单漏了 reader 目录');
  assert(read('src/reading/reader-source.js').indexOf('MAX_TEXT_BYTES') >= 0, '缺文本体积上限');
});

check('V3.5 阅读方式：PDF 原页 / 连续滚动 / 双页 / 全屏', function () {
  const html = read('renderer-v2/reader/index.html');
  const js = read('renderer-v2/reader/reader.js');
  const css = read('renderer-v2/reader/reader.css');
  const src = read('src/reading/reader-source.js');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  // 解码器必须真的随包分发：只写个 script 标签、文件却漏了，打包后就是白屏
  assert(read('renderer-v2/reader/vendor/pdf.min.js').length > 100000, 'PDF 解码器主文件缺失');
  assert(read('renderer-v2/reader/vendor/pdf.worker.min.js').length > 500000, 'PDF 解码器 worker 缺失');
  // worker 先于 pdf.min.js 才有全局 WorkerMessageHandler，才能走主线程 fake worker
  assert(html.indexOf('<script src="./vendor/pdf.worker.min.js"') < html.indexOf('<script src="./vendor/pdf.min.js"'),
    'worker 必须排在解码器前面（注释里也提到了文件名，所以按完整 script 标签比）');
  assert(html.indexOf("connect-src 'none'") >= 0 && html.indexOf("object-src 'none'") >= 0,
    'PDF 解码不许放宽网络出口 / 插件对象');
  ['rrPdf', 'rrFlow', 'rrSpread', 'rrFull', 'rrFullExit', 'rrModes'].forEach(function (w) {
    assert(html.indexOf(w) >= 0, '阅读窗缺少阅读方式控件：' + w);
  });
  assert(/pdf:\s*\{ supported: true/.test(src), 'PDF 仍被登记为不支持渲染');
  assert(src.indexOf('MAX_PDF_BYTES') >= 0, 'PDF 没有体积上限');
  assert(main.indexOf("'reading.readerPdfData'") >= 0 && api.indexOf("'reading.readerPdfData'") >= 0,
    'PDF 字节通道没接主进程与白名单');
  ['getDocument({ data: bytes', 'IntersectionObserver', 'useSystemFonts: true'].forEach(function (w) {
    assert(js.indexOf(w) >= 0, 'PDF 渲染链路缺：' + w);
  });
  assert(js.indexOf('function currentToc') >= 0, '目录重建没统一入口，书签刷新会把「第 N 页」冲成「第 N 节」');
  ['function loadFlow', 'function appendFlowChapter', 'function onFlowScroll', 'function mapRoot',
    'function setSpreadMode', 'function setFullMode', 'requestFullscreen', 'fullscreenchange'].forEach(function (w) {
    assert(js.indexOf(w) >= 0, '阅读方式缺实现：' + w);
  });
  assert(js.indexOf('FLOW_MAX') >= 0, '连续滚动没有章节拼接上限');
  assert(js.indexOf('const map = buildTextMap(root)') >= 0, '连续滚动没按章建文本表，标注会错位');
  assert(css.indexOf('rr-pdf-spread') >= 0 && css.indexOf('data-full="1"') >= 0, '双页 / 全屏样式缺失');
  assert(css.indexOf('body[data-full="1"] .rr-ask') >= 0, '全屏没收起伴读浮窗');
});

check('V3.11 书架三陈列 + 封面按书封比例 + 底栏选项条居中', function () {
  const view = read('renderer-v2/src/views/ReadingView.vue');
  const epub = read('src/reading/epub.js');
  const main = read('src/main/main-v2.js');
  const css = read('renderer-v2/reader/reader.css');
  const html = read('renderer-v2/reader/index.html');
  // 三种陈列：详细列表 / 封面预览 / 封面墙（只摆封面）
  assert(view.indexOf("viewMode === 'shelf'") >= 0, '缺「封面墙」第三种陈列');
  assert(view.indexOf('rd-wall') >= 0 && view.indexOf('rd-spine-box') >= 0, '封面墙结构缺失');
  assert(view.indexOf("setViewMode('shelf')") >= 0, '封面墙没有切换入口');
  // 封面比例：列表封面固定 2:3 并居中，不能再被行高 stretch 拉成窄条
  assert(/\.rd-cover \{[^}]*aspect-ratio: 2 \/ 3/.test(view), '列表封面没有固定 2:3 比例');
  assert(/\.rd-cover \{[^}]*align-self: center/.test(view), '列表封面仍会被行高拉满');
  // 封面一律取书内图：旧 500KB 上限会让「书里明明有」的书回落成色块
  assert(epub.indexOf('MAX_COVER_BYTES = 4 * 1024 * 1024') >= 0, '封面上限仍是旧的 500KB');
  assert(epub.indexOf('function firstImageHref') >= 0 && epub.indexOf('function sniffExt') >= 0,
    '封面抽取缺「封面页首图」与「按魔数纠格式」');
  assert(epub.indexOf("type=[\"']cover[\"']") >= 0, 'guide type=cover 的封面页兜底没接');
  // 老书回填 + 请求去重：没有这两条，升级后旧书的封面永远是色块
  assert(main.indexOf('function coverDataUrl') >= 0 && main.indexOf('const coverMiss = new Map()') >= 0,
    '主进程缺封面回填 / 未命中缓存');
  assert(view.indexOf('const coverTried = new Set') >= 0, '封面请求没有去重，每次刷新都会重解一遍 EPUB');
  // 阅读窗底栏：三栏 grid 让选项条真正居中，页码仍贴右
  assert(html.indexOf('rr-modes-group') >= 0, '底栏选项条没有独立包裹层，无法脱离左对齐');
  assert(/\.rr-modes \{[^}]*grid-template-columns: 1fr auto 1fr/.test(css), '底栏仍用 flex，选项条不会居中');
  assert(/\.rr-modes-pages \{[^}]*justify-self: end/.test(css), '底栏页码没贴右');
});

check('V3.12 分页阅读：真分页（一页一屏 + 滚轮翻页），双页是连续两页', function () {
  const html = read('renderer-v2/reader/index.html');
  const js = read('renderer-v2/reader/reader.js');
  const css = read('renderer-v2/reader/reader.css');
  assert(html.indexOf('id="rrPaged"') >= 0 && html.indexOf('分页阅读') >= 0, '缺「分页阅读」这一档');
  ['function pagedBuild', 'function pagedMeasure', 'function pagedGoPage', 'function pagedFlip',
    'function pagedReveal', 'function onPagedWheel', 'function onPagedKey'].forEach(function (w) {
    assert(js.indexOf(w) >= 0, '分页缺实现：' + w);
  });
  // 分页的骨架必须是「多栏 + 锁高 + 横移」，而不是把整章切两栏往下滚
  assert(js.indexOf('column-fill:auto') >= 0, '分页容器没锁成一页高（column-fill:auto 缺失）');
  assert(js.indexOf('inner.style.columnWidth') >= 0, '列宽没交给 column-width：写成 column-count 会被当成上限，内容只会往下溢出');
  assert(js.indexOf('rr-pg-clip') >= 0, '缺裁切层：overflow 只在 padding box 裁，右边留白会漏出下一栏的字');
  assert(js.indexOf("b.style.columnCount = '2'") < 0, '还在用旧做法：把整章正文分成两栏（右栏会变成后半章）');
  // 双页并排必须寄在分页上：翻开两页、滚一下翻过去两页
  assert(js.indexOf('if (want) { pref.paged = true;') >= 0, '双页并排没挂到分页态上');
  assert(js.indexOf('PAGED_GAP') >= 0 && js.indexOf('paged.step = cols * pitch') >= 0,
    '双页的翻页步长没按「两页」算');
  // 分页态没有 scroll 事件：进度与位置要自己记，否则章内进度永远是 0
  assert(js.indexOf('if (paged.on) return paged.pages <= 1 ? 100') >= 0, '分页态本章进度没按页算');
  assert(js.indexOf('if (paged.on) return pagedRatio();') >= 0, '分页态位置没按页记');
  assert(js.indexOf('new ResizeObserver') >= 0, '窗口 / 侧栏变宽没重排页，一页里装多少字就错了');
  assert(css.indexOf('.rr-pg-btn') >= 0, '页码两侧的翻页按钮没样式');
});

check('V3.13 图书馆：主题书不进休闲书架 / 占位印完整书名 / calibre 式列表 / 豆瓣封面只在主进程', function () {
  const board = read('src/reading/board.js');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const preload = read('src/preload/v2-preload.js');
  const bridge = read('renderer-v2/src/bridge.ts');
  const shelf = read('renderer-v2/src/views/ReadingView.vue');
  const net = read('src/reading/cover-net.js');

  // ① 主题书与休闲书架分开：领域层要给出「只含休闲书」的那一份，字段一行算出主题数
  assert(board.indexOf('leisureBooks: leisureBooks') >= 0, '领域层没给书架单独一份（leisureBooks）');
  assert(board.indexOf('const leisureBooks = books.filter') >= 0, '书架没把主题书排除掉');
  assert(board.indexOf('themeBooks: s.books.length - leisureCount') >= 0, '统计头没有分开算主题书');
  assert(board.indexOf('themeGroups: themeGroups') >= 0, '主题分组没在领域层派生（渲染层各算一套必然口径不一）');
  assert(shelf.indexOf('bd.leisureBooks ||') >= 0, '书架没取 leisureBooks（主题书还会混进来）');
  // 主题书行必须与书架同一套派生：进度 / 状态 / 笔记数，缺一个就是「主题下显示 0 条笔记」
  assert(board.indexOf('function decorateRow') >= 0 && board.indexOf('g.rows.push(rowsById[b.id])') >= 0,
    '主题书行没走同一套派生字段');

  // ② 没有封面时占位印完整书名（不是首字），字号按字数分级
  assert(shelf.indexOf('function coverNameStyle') >= 0, '缺占位封面的字号分级');
  assert(shelf.indexOf("{{ b.title }}</span>") >= 0, '占位封面没印完整书名');
  assert(shelf.indexOf("b.title.slice(0, 1)") < 0 && shelf.indexOf('class="rd-card-initial" aria-hidden="true">{{ initialOf') < 0,
    '占位封面还在印首字');

  // ③ 详细列表是表：列头 + 可点排序 + 紧凑行，而不是每行一条卡片
  ['rd-thead', 'rd-trow', 'toggleSort', 'ariaSort', '最近读过', '格式 · 大小'].forEach(function (w) {
    assert(shelf.indexOf(w) >= 0, 'calibre 式列表缺：' + w);
  });
  assert(shelf.indexOf('if (sortMode.value === \'manual\') return list;') >= 0, '手动排序（书架自己的顺序）被列排序顶掉了');
  // 表格容器沿用 rd-shelf 这个老钩子（用例按「书架容器」找行），必须同时是 rd-table
  assert(shelf.indexOf('class="rd-table rd-shelf"') >= 0, '列表容器不是表格（或丢了书架那个老钩子）');

  // ④ 豆瓣封面：网络只在主进程，白名单写在客户端里，渲染层一个 URL 都没有
  assert(net.indexOf("book.douban.com") >= 0 && net.indexOf('HOST_IMG') >= 0, '豆瓣客户端缺域名白名单');
  assert(net.indexOf('/^img\\d+\\.doubanio\\.com$/') >= 0, '图片域名不是按 host 严格匹配的（后缀通配会被 img.doubanio.com.evil.com 绕过）');
  assert(net.indexOf('function sniffExt') >= 0, '封面格式没按魔数认（.jpg 里装 webp 会打不开）');
  assert(main.indexOf("'reading.doubanCovers'") >= 0 && main.indexOf("'reading.doubanApply'") >= 0, '主进程缺豆瓣路由');
  assert(api.indexOf("route('v1/reading:doubanCovers'") >= 0 && api.indexOf("route('v1/reading:doubanApply'") >= 0,
    '豆瓣路由没走专用异步通道（挤进 domain:call 会因返回 Promise 直接序列化失败）');
  // 名字只应出现一次：asyncPass 注册那一处。出现在白名单数组里就是又走回同步通道了
  const cnt = function (s, sub) { return s.split(sub).length - 1; };
  assert(cnt(api, "'reading.doubanCovers'") === 1 && cnt(api, "'reading.doubanApply'") === 1,
    '豆瓣路由被登记进同步白名单了（domain:call 返回 Promise 会在序列化时报 could not be cloned）');
  assert(preload.indexOf("'v1/reading:doubanCovers'") >= 0 && preload.indexOf("'v1/reading:doubanApply'") >= 0,
    'preload 通道白名单没加豆瓣两条');
  assert(bridge.indexOf('export function doubanCovers') >= 0 && bridge.indexOf('export function doubanApply') >= 0,
    '渲染层缺豆瓣桥函数');
  // 渲染层不许出现任何豆瓣地址：能出现的只有「按钮」和「候选图 dataURL」
  assert(shelf.indexOf('doubanio') < 0 && shelf.indexOf('douban.com') < 0, '渲染层出现了豆瓣域名（网络必须只留在主进程）');
  assert(shelf.indexOf('doubanCovers(b.id)') >= 0 && shelf.indexOf('doubanApply(b.id') >= 0, '界面没接豆瓣桥');
});

check('V3.14 图书馆独立窗口：三栏 / 左栏文件夹树 / 搜索并进页签行 / 手写加书下线', function () {
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const preload = read('src/preload/v2-preload.js');
  const bridge = read('renderer-v2/src/bridge.ts');
  const app = read('renderer-v2/src/App.vue');
  const shelf = read('renderer-v2/src/views/ReadingView.vue');
  const win = read('renderer-v2/src/views/LibraryWindow.vue');
  const vite = read('renderer-v2/vite.config.ts');
  const html = read('renderer-v2/library.html');

  // ① 第三个 Vite 入口 + 主进程独立窗口 + 一条白名单通道
  assert(vite.indexOf("library: 'library.html'") >= 0, 'Vite 没加图书馆入口');
  assert(html.indexOf('九格手记 · 图书馆') >= 0, '独立窗口 HTML 的标题不对');
  assert(main.indexOf('const LIBRARY_HTML') >= 0 && main.indexOf('function openLibraryWindow') >= 0,
    '主进程缺图书馆窗口创建');
  assert(main.indexOf('libraryOpener: openLibraryWindow') >= 0, '开窗函数没接进 API 层');
  assert(api.indexOf("route('v1/library:open'") >= 0, 'API 层缺 library:open 路由');
  assert(preload.indexOf("'v1/library:open'") >= 0, 'preload 白名单缺 library:open');
  assert(bridge.indexOf('export function openLibrary') >= 0, '渲染层缺开窗桥函数');
  // 复用不叠窗：有活窗口就 focus，不许再 new 一个
  assert(main.indexOf('if (libraryWindow && !libraryWindow.isDestroyed())') >= 0, '重复点会叠出第二个图书馆窗口');

  // ② 三栏 + 皮肤作用域：独立窗口不继承主窗的 data-skin，漏了 --palette-* 全是空值
  ['lib-left', 'lib-main', 'lib-right', 'lib-tree', 'lib-kids', 'lib-book'].forEach(function (c) {
    assert(win.indexOf(c) >= 0, '三栏 / 层级缺：' + c);
  });
  assert(win.indexOf(':data-skin="skin"') >= 0 && win.indexOf('data-surface="light"') >= 0,
    '独立窗口没挂皮肤作用域（图标、选中态、右侧数字会一起变透明）');
  assert(win.indexOf('休闲阅读') >= 0 && win.indexOf('主题阅读') >= 0, '左栏缺两个栏目');
  assert(win.indexOf('class="lib-count"') >= 0, '左栏每一行缺右侧册数');
  // 中栏必须复用同一套 ReadingView：另写一份书架等于两套口径
  assert(win.indexOf("import ReadingView from './ReadingView.vue'") >= 0, '中栏没复用 ReadingView');
  // 「全部藏书」这类重复叶子不画：根节点自己就是「这一摞全看」
  // 只扫树块：右栏在没有选中书时，标题就叫「全部藏书」（那是范围的说明，不是又一个节点）
  const treeStart = win.indexOf('class="lib-tree"');
  const treeBlock = win.slice(treeStart, win.indexOf('</aside>', treeStart));
  assert(treeStart >= 0 && treeBlock.indexOf('>全部藏书<') < 0, '左栏又画了一个与根节点等价的「全部藏书」叶子');

  // ③ 主窗不再内嵌图书馆：入口只剩「开窗」这一个动作
  assert(app.indexOf("import ReadingView from './views/ReadingView.vue'") < 0, '主窗还内嵌着图书馆视图');
  assert(app.indexOf("if (key === 'reading') { void openLibrary(); return; }") >= 0,
    "旧入口 navigate('reading') 没改成开窗（右栏 / 学习台的链接会跳空）");
  assert(app.indexOf('@click="openLibrary()"') >= 0, '顶栏「图书馆」按钮没接开窗');

  // ④ 搜索并进页签行最左侧；手写加书那一行下线
  const navStart = shelf.indexOf('<nav class="rd-tabs"');
  const navEnd = shelf.indexOf('</nav>', navStart);
  assert(navStart >= 0 && navEnd > navStart, '图书馆没有页签行');
  const navBlock = shelf.slice(navStart, navEnd);
  assert(navBlock.indexOf('class="rd-input rd-search"') >= 0, '搜索框没并进页签行');
  assert(navBlock.indexOf('rd-search') < navBlock.indexOf('class="rd-tab"'), '搜索框没在页签行的最左侧');
  assert((navBlock.match(/class="rd-tab"/g) || []).length === 3, '页签行不是三个分区');
  assert(shelf.indexOf('class="rd-tools"') < 0, '页签行并入后还留着一整行「书架整理」');
  assert(shelf.indexOf('＋ 放上书架') < 0, '手写书名那一行（放上书架）还在');
  assert(shelf.indexOf('function addBook') < 0 && shelf.indexOf('newTitle') < 0, '手写加书的代码没拆干净');
  // 左栏点节点 → 中栏换范围：这条线只认 scope 一个来源
  assert(shelf.indexOf('props.scope') >= 0 && shelf.indexOf('function applyScope') >= 0,
    '中栏没接左栏的 scope（两侧各存一份范围，迟早对不上）');
  assert(win.indexOf(':scope="scope"') >= 0, '左栏的范围没传给中栏');
});

check('V3.15 主题阅读也走 calibre 式表格：同一套列 / 静态表头 / 不再是大卡片', function () {
  const shelf = read('renderer-v2/src/views/ReadingView.vue');
  const themeStart = shelf.indexOf('v-for="g in themeGroups"');
  const themeEnd = shelf.indexOf('主题批注器', themeStart);
  assert(themeStart >= 0 && themeEnd > themeStart, '找不到主题阅读区块');
  const block = shelf.slice(themeStart, themeEnd);

  // ① 主题下的书是表格，不是每本一张大卡片
  assert(block.indexOf('class="rd-table rd-theme-table"') >= 0, '主题下的书不是表格');
  assert(block.indexOf('class="rd-trow rd-book"') >= 0, '主题行没走表格行（rd-trow）');
  // 行必须同时留 rd-book：GUI 用例按「.rd-group .rd-book」找行，类名不能删
  assert(block.indexOf('rd-book-main') < 0 && block.indexOf('rd-thick') < 0, '主题里还留着大卡片的主体结构');
  assert(block.indexOf('+10 {{ b.unit }}') < 0, '主题卡片那种「+10 页」大按钮还在');

  // ② 六列与休闲书架同口径
  ['书名', '作者', '格式 · 大小', '最近读过', '进度', '操作'].forEach(function (w) {
    assert(block.indexOf('>' + w + '<') >= 0, '主题表缺列：' + w);
  });
  assert(block.indexOf('rd-tbar') >= 0 && block.indexOf('rd-tpct') >= 0, '主题表进度列不是「条 + 百分比」');

  // ③ 表头静态：只做列名、不排序（排序只作用于书架，主题点表头没反应才是问题）
  assert(block.indexOf('rd-thead-static') >= 0, '主题表头不是静态的');
  assert(block.indexOf("toggleSort('title')") < 0, '主题表头接上了只作用于书架的排序');
  assert(shelf.indexOf('.rd-thead-static .rd-th-title') >= 0, '静态表头没把「手型 + 悬停变色」关掉');

  // ④ 路径仍是「只登记路径」这条承诺的可见证据；手写的书要写清没有文件
  assert(block.indexOf('class="rd-tpath"') >= 0, '主题表把路径丢了');
  assert(block.indexOf('手工登记，仅记笔记') >= 0, '没有电子书的主题书没标清楚');

  // ⑤「未分组」是保留值，不是分组名：左栏传 \u0000none 过来，中栏必须按「group 为空」筛。
  // 踩过的坑：拿保留值去和 book.group 严格比较，永远是 0 本（右栏 KPI 有数、书架空着）。
  const win = read('renderer-v2/src/views/LibraryWindow.vue');
  assert(shelf.indexOf("const GROUP_NONE = '\\u0000none'") >= 0, '中栏缺「未分组」这个保留值');
  assert(win.indexOf("const UNGROUPED = '\\u0000none'") >= 0,
    '左栏「未分组」的保留值变了（两处必须同一字面量，否则又是两个口径）');
  assert(shelf.indexOf('g === GROUP_NONE) list = list.filter((b) => !b.group)') >= 0,
    '中栏没按「group 为空」筛未分组');
  assert(shelf.indexOf('g !== GROUP_FAV && g !== GROUP_NONE') >= 0, '「未分组」会被「分组已不存在」的守卫清掉');
  assert(shelf.indexOf('ungroupedCount') >= 0 && shelf.indexOf("'rd-gchip-on': groupFilter === GROUP_NONE") >= 0,
    '中栏分组条缺「未分组」这一项（筛了却看不见筛的是什么）');
  assert(shelf.indexOf('from === GROUP_FAV || from === GROUP_NONE') >= 0
    && shelf.indexOf('name === GROUP_FAV || name === GROUP_NONE') >= 0,
    '保留值还能被改名 / 解散（对不存在的分组动手）');

  // ⑥ 主题三角真的收放：折叠状态独立于「选中」，左栏点主题要顺手展开
  assert(shelf.indexOf('const closedThemes = ref<string[]>([])') >= 0, '主题没有折叠状态');
  assert(shelf.indexOf("{{ isThemeClosed(g.themeId) ? '▸' : '▾' }}") >= 0, '标题三角没跟折叠状态走');
  assert(shelf.indexOf(':aria-expanded="!isThemeClosed(g.themeId)"') >= 0, '标题没报出展开状态');
  assert(shelf.indexOf('<template v-if="!isThemeClosed(g.themeId)">') >= 0, '收起时书单没有被真的藏起来');
  assert(shelf.indexOf('closedThemes.value.filter((x) => x !== s.themeId)') >= 0, '左栏点主题不会把收起的主题展开');
});

check('V3.5 书架分组 / 收藏夹：字段、路由、界面三处齐', function () {
  const board = read('src/reading/board.js');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const shelf = read('renderer-v2/src/views/ReadingView.vue');
  ['MAX_GROUPS', 'group: clean(o.group', 'favorite: o.favorite === true',
    'function setBookGroup', 'function setBookFavorite', 'function renameGroup', 'function removeGroup',
    'favoriteCount: favoriteCount'].forEach(function (w) {
    assert(board.indexOf(w) >= 0, '领域层缺分组/收藏：' + w);
  });
  ['reading.setBookGroup', 'reading.setBookFavorite', 'reading.renameGroup', 'reading.removeGroup'].forEach(function (w) {
    assert(main.indexOf("'" + w + "'") >= 0, '主进程缺路由：' + w);
    assert(api.indexOf("'" + w + "'") >= 0, '白名单缺：' + w);
  });
  ['rd-groups', 'rd-gchip', 'rd-fav', 'rdEditGroup', 'setGroupFilter', 'createGroup', 'toggleFavorite',
    'renameGroupNow', 'removeGroupNow'].forEach(function (w) {
    assert(shelf.indexOf(w) >= 0, '书架界面缺分组/收藏：' + w);
  });
  assert(shelf.indexOf('groupFilter.value === GROUP_ALL') >= 0, '分组筛选态应禁用拖动');
});

check('V3.6 学习成长右栏：在读书 / 主题学习状态 + 快捷访问', function () {
  const ctx = read('renderer-v2/src/components/context/StudyContext.vue');
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  const api = read('src/core/api-layer.js');
  // 两份数据、一个视图：主题进度来自 md_growth，书架在读书来自 md_reading
  assert(ctx.indexOf("'growth.board'") >= 0 && ctx.indexOf("'reading.board'") >= 0,
    '右栏没同时读学习库与图书馆两份派生数据');
  assert(/Promise\.all\(\[/.test(ctx), '两份数据应并发取，别串成两次等');
  assert(ctx.indexOf("b.status !== 'reading'") >= 0, '在读书没做状态过滤');
  // P0-1（2026-11-16）：书单已收敛到 md_reading.books 单一事实源，
  // 视图层不再按书名做「双源补丁」式去重。这里反过来钉住：seen[ 必须已删掉。
  assert(ctx.indexOf('seen[') < 0,
    '学习右栏仍在视图层做跨源去重（双源补丁应已随 P0-1 删除）');
  assert(ctx.indexOf("'reading.readerOpen'") >= 0 && api.indexOf("'reading.readerOpen'") >= 0,
    '继续读没接独立阅读窗通道，或白名单漏登记');
  assert(ctx.indexOf("emit('navigate', 'reading')") >= 0, '缺「去图书馆」快捷入口');
  assert(ctx.indexOf('openTheme(t)') >= 0 && ctx.indexOf("emit('select-item', t.id)") >= 0,
    '主题学习行没有选中联动');
  ['aria-label="目前在读的图书"', 'aria-label="主题学习状态"', 'gc-bar', 'gc-now-go',
    'progressText', 'readingCount', 'quoteTotal', 'lastReadAt'].forEach(function (w) {
    assert(ctx.indexOf(w) >= 0, '右栏缺状态信息或控件：' + w);
  });
  const block = panel.slice(panel.indexOf('<StudyContext'), panel.indexOf('<CellContext'));
  assert(block.indexOf('@navigate=') >= 0, 'ContextPanel 没把 navigate 转发给学习右栏');
  // 本轮只是只读联动：不新增 growth.* 写调用，已有写仍钉住当前选中项
  const writes = ctx.match(/callDomain\('growth\.[A-Za-z]+', null, [^)]*/g) || [];
  writes.forEach(function (w) {
    assert(/null, (exam|skill|theme)\.value\.id/.test(w), '新增了不钉选中项的学习库写操作');
  });
});

check('V3.7 复盘证据面板：Check 派生 / 三问口径 / Act 落点 / 零新增字段路由', function () {
  const rv = read('renderer-v2/src/components/ReviewView.vue');
  const api = read('src/core/api-layer.js');
  const main = read('src/main/main-v2.js');
  // Check：五格证据全部来自已有只读派生，且并发取，不新增 domain 路由
  ['gtd.board', 'gtd.focus', 'reading.board', 'dream.board', 'moduleDigest', 'writtenDates'].forEach(function (n) {
    assert(rv.indexOf("'" + n + "'") >= 0, '证据面板缺只读数据源：' + n);
  });
  assert(/Promise\.all\(\[/.test(rv), '证据未并发取');
  assert(rv.indexOf('本期证据 · 只读') >= 0 && rv.indexOf('不是评分') >= 0,
    '没写清只读 / 非评分口径');
  assert(rv.indexOf('不显示估算值') >= 0, '空态没如实说明');
  assert(rv.indexOf('六条只锚定今天') >= 0 && rv.indexOf('不编一个跨天百分比') >= 0,
    '没有守住「六条不结转、不编本周完成率」的诚实口径');
  // 三问固定成证据 → 归因 → 一个改动；答案仍是 3 元素数组，落库结构一字未动
  const lib = read('renderer-v2/src/composables/promptLibrary.ts');
  const rail = read('renderer-v2/src/components/context/ReviewContext.vue');
  ['这期哪些做法真的有效？', '为什么有效，或者为什么没效？', '下期只改哪一条？'].forEach(function (q) {
    assert(lib.indexOf(q) >= 0, '缺三问口径：' + q);
  });
  assert(rv.indexOf('REVIEW_EVIDENCE_QUESTIONS') >= 0 && rail.indexOf('REVIEW_EVIDENCE_QUESTIONS') >= 0,
    '中栏与右栏没共用同一份三问常量');
  assert(rv.indexOf('REVIEW_QUESTIONS') >= 0 && rv.indexOf('换个角度') >= 0,
    '轮换题组没退成提示');
  assert(rv.indexOf("callDomain('saveReview', null, period.value, reviewKey.value, answers.value)") >= 0,
    '三问落库结构被改了');
  // 上期回显：渲染层算上期键 + 已有 loadReview，不给领域层加参数 / 加字段
  assert(rv.indexOf('function prevReviewKey') >= 0, '上期键没在渲染层算');
  assert(rv.indexOf("callDomain<string[]>('loadReview'") >= 0, '没读上期那句');
  assert(rv.indexOf('不替你打勾') >= 0, '上期结论被自动判定做到了');
  // 存完三问要通知外壳刷新右栏完成度，否则中栏已存满、右栏还写旧数字
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  const app = read('renderer-v2/src/App.vue');
  assert(rv.indexOf("emit('changed')") >= 0 && app.indexOf('mode="retro" @changed="gtdTick += 1"') >= 0,
    '存完三问没通知外壳刷新右栏');
  assert(panel.indexOf('<ReviewContext v-else-if="view === \'review\'" :tick="tick"') >= 0,
    '右栏复盘没接 tick');
  assert(rail.indexOf('watch(() => props.tick') >= 0, '右栏复盘没监听 tick 重取');
  // Act：本页唯一写操作是用户主动点击的 gtd.add，带去重 + 建成复核 + 不占六条
  assert(rv.indexOf("callDomain('gtd.add', null") >= 0 && api.indexOf("'gtd.add'") >= 0,
    'Act 没落成 GTD 下一步，或白名单漏登记');
  assert(rv.indexOf('hasSame') >= 0 && rv.indexOf('created') >= 0, 'Act 缺去重或建成后复核');
  assert(rv.indexOf('六条本身不结转') >= 0, 'Act 没说清不占今日六条');
  assert(rv.indexOf("'gtd.focusSet'") < 0 && rv.indexOf("'gtd.focusToggle'") < 0,
    'Act 直接改了今日六条（跨天不结转）');
  const fresh = ['reviewEvidence', 'reviewAct', 'reviewPrev'];
  fresh.forEach(function (n) {
    assert(api.indexOf("'" + n + "'") < 0 && main.indexOf("'" + n + "'") < 0,
      '本轮不该新增 domain 路由：' + n);
  });
});


check('阅读器详细功能：书签 / 书内搜索 / 划选标注 / 多字体排版', function () {
  const html = read('renderer-v2/reader/index.html');
  const js = read('renderer-v2/reader/reader.js');
  ['rr-ltab', 'rr-search-input', 'rr-typeface', 'rr-selbar', 'rr-divider', 'rr-bm-add', 'rr-style-filter'].forEach(function (w) {
    assert(html.indexOf(w) >= 0, '阅读窗口缺少：' + w);
  });
  // 多字体：标题黑体、正文宋体、引文楷体、西文衬线、代码等宽，至少五种字体名
  ['SimSun', 'KaiTi', 'Microsoft YaHei', 'Georgia', 'Consolas'].forEach(function (f) {
    assert(js.indexOf(f) >= 0, '多字体方案缺少字体栈：' + f);
  });
  assert(js.indexOf('data-typeface') >= 0 && js.indexOf("'mixed'") >= 0, '字体方案没有 data-typeface 切换');
  assert(js.indexOf('body.rr-typo h1') >= 0 && js.indexOf('body.rr-typo p') >= 0,
    '标题与正文没有分开设定字体（会满屏一种字）');
  // 标注：锚点 + mark 包裹（不用跨 realm 会失败的 CSS Custom Highlight）
  assert(js.indexOf('function rangeByOffset') >= 0 && js.indexOf('function offsetAt') >= 0, '缺章内文本锚点');
  assert(js.indexOf('function applyMark') >= 0 && js.indexOf('wrapRange') >= 0, '缺划选标注');
  assert(js.indexOf('CSS.highlights') < 0, '不应再用 CSS Custom Highlight（沙箱 iframe 跨 realm 会失败）');
  assert(js.indexOf('function gotoNote') >= 0 && js.indexOf('function savePos') >= 0, '缺笔记回跳 / 精确位置');
  // 通道与数据层
  const main = read('src/main/main-v2.js');
  ['reading.bookmarks', 'reading.addBookmark', 'reading.removeBookmark', 'reading.searchBook'].forEach(function (w) {
    assert(main.indexOf(w) >= 0, '主进程缺 ' + w);
  });
  const api = read('src/core/api-layer.js');
  ["'reading.bookmarks'", "'reading.addBookmark'", "'reading.removeBookmark'", "'reading.searchBook'"].forEach(function (w) {
    assert(api.indexOf(w) >= 0, '白名单缺 ' + w);
  });
  const b = read('src/reading/board.js');
  assert(b.indexOf('function normAnchor') >= 0 && b.indexOf('HL_COLORS') >= 0, '笔记标注字段没进 normalize');
  assert(b.indexOf('function normBookmark') >= 0 && b.indexOf('MAX_BOOKMARKS') >= 0, '缺书签实体与上限');
  // 2026-11-11 口径同步：字体方案（themes）并入后，合并段落是五段且顺序有调整。
  // 逐个 key 验，比写死整个数组字面量稳，也不会把「漏段」放过去。
  const merge = b.slice(b.indexOf('function mergeSection'), b.indexOf('function mergeSection') + 600);
  ['books', 'chapters', 'notes', 'bookmarks', 'themes'].forEach(function (k) {
    assert(new RegExp("'" + k + "'").test(merge), '备份合并漏了 ' + k);
  });
  const rs = read('src/reading/reader-source.js');
  assert(rs.indexOf('function search') >= 0 && rs.indexOf('function plainText') >= 0, '缺书内搜索');
});


check('阅读器排印基线：完全接管书内样式 / 中文排印 / 版心段距标点', function () {
  const js = read('renderer-v2/reader/reader.js');
  const html = read('renderer-v2/reader/index.html');
  // 中文排印 P0 三条：2em 缩进、两端对齐 + inter-ideograph、绝不设全断断词
  assert(js.indexOf('text-indent:2em') >= 0, '正文缺首行缩进 2em');
  assert(js.indexOf('text-align:justify') >= 0 && js.indexOf('text-justify:inter-ideograph') >= 0,
    '正文缺两端对齐 / inter-ideograph');
  assert(js.indexOf('break-all') < 0, '排印基线不许出现 word-break 全断值（会废掉 CJK 避头尾）');
  assert(js.indexOf('word-break:normal') >= 0, '应显式声明 word-break:normal');
  // 标题 / 列表 / 引文 / 代码必须掰回左对齐、不缩进，否则两端对齐会毁版面
  assert(js.indexOf('text-indent:0') >= 0, '标题/列表/引文没有取消缩进');
  assert(js.indexOf('body.rr-typo blockquote') >= 0 && js.indexOf('body.rr-typo th,body.rr-typo td') >= 0,
    '引文与表格没有单独排版规则');
  // 中文无斜体：em/i 转正体
  assert(/em,body\.rr-typo i\{font-style:normal/.test(js), '中文 em/i 仍是斜体（中文没有斜体）');
  // 段距走变量、版心三档、标点特性检测降级
  assert(js.indexOf('--rr-para') >= 0 && js.indexOf('PARA_GAP') >= 0, '段距没有做成变量/三档');
  assert(js.indexOf('MARGIN_PRESET') >= 0 && js.indexOf("wide: { max: 600") >= 0, '缺版心三档');
  assert(js.indexOf('punctTrimValue') >= 0 && js.indexOf('trim-start') >= 0,
    '标点挤压没有按实际支持的值探测（Chromium 126 认 trim-start，不认 trim-all）');
  assert(js.indexOf('supportsCjkLatinSpacing') >= 0, '中西文间距未做特性检测');
  assert(js.indexOf('oversize') >= 0, '缺超长章节提示');
  ['rrMargin', 'rrPara', 'rrPunct'].forEach(function (w) {
    assert(html.indexOf(w) >= 0, '工具栏缺少排印控件：' + w);
  });
  // 接管：epub.js 不得把书内 <style> 拼回去，且行内样式走白名单
  const ep = read('src/reading/epub.js');
  assert(ep.indexOf('cleanInlineStyle') >= 0 && ep.indexOf('INLINE_KEEP') >= 0, '行内样式没有白名单');
  assert(ep.indexOf('font-size|') >= 0 || ep.indexOf('INLINE_KEEP = /^') >= 0, '行内白名单没定义');
  assert(ep.indexOf("'\\n' + epubCss + '\\n</style>") < 0, '书内 CSS 仍被注入正文（未完全接管）');
  assert(ep.indexOf('OVERSIZE_BYTES') >= 0, 'epub.js 缺超长章节阈值');
});


check('完读率轻互动：续读条 / 进度三件套 / 章末卡 / 文案不发糖', function () {
  const js = read('renderer-v2/reader/reader.js');
  const html = read('renderer-v2/reader/index.html');
  // T1 续读条：只在打开时出现，不常驻
  assert(html.indexOf('rrResume"') >= 0 && html.indexOf('rr-resume-text') >= 0, '缺续读引导条');
  assert(/id="rrResume"[^>]*hidden/.test(html), '续读条不能默认常驻（应初始 hidden）');
  assert(js.indexOf('function showResumeBar') >= 0 && js.indexOf("'上次读到'") >= 0, '缺续读条文案');
  assert(js.indexOf('86400000') >= 0, '续读条没算「距上次几天」');
  // T2 进度三件套
  const line = js.slice(js.indexOf('function progressLine'), js.indexOf('function progressLine') + 400);
  ['章进度', '', ''].forEach(function () {});
  assert(line.indexOf('已读 ') >= 0 && line.indexOf('全书 ') >= 0 && line.indexOf('本章 ') >= 0,
    '进度行缺三件套（章进度 / 全书 / 本章）');
  assert(js.indexOf('function doneChapters') >= 0 && js.indexOf('raw <= t') >= 0,
    '已读章数没区分「页数口径」与「章口径」（会排出 0 / 100 章这种假进度）');
  // T3 章末卡：正文流内静卡，不是弹窗；两个动作都在
  assert(js.indexOf('function renderEndCard') >= 0 && html.indexOf('rr-endcard') >= 0, '缺章末轻卡');
  assert(html.indexOf('data-act="next"') >= 0 && html.indexOf('data-act="note"') >= 0,
    '章末卡缺「继续下一章 / 写一句感想」');
  assert(js.indexOf('function maybeShowEndCard') >= 0 && js.indexOf('chapterPct() < 95') >= 0,
    '章末卡触发条件不对（应滚到 95% 才算读完）');
  assert(js.indexOf('endCardShown = false') >= 0, '换章后没有重置章末卡状态');
  // 章末感想必须走现有九格回写通道，不许另开一条写路径
  assert(js.indexOf('async function saveEndNote') >= 0 && js.indexOf('await pushNote(fresh)') >= 0,
    '章末感想没有复用九格回写通道');
  // T5 摘录计数
  assert(js.indexOf('这是这本书的第 ') >= 0, '摘录 toast 没带本书第几句');
  // T7 文案包：四档齐全 + 不发糖
  ['start:', 'middle:', 'end:', 'relay:'].forEach(function (k) {
    assert(js.indexOf(k) >= 0, '文案包缺阶段：' + k);
  });
  ['恭喜', '太棒', '真棒', '厉害了', '你真'].forEach(function (w) {
    assert(js.indexOf(w) < 0, '文案包里出现发糖词：' + w);
  });
  assert(js.indexOf('function phraseOf') >= 0 && js.indexOf('lastPhrase') >= 0,
    '文案没有做同阶段不重复');
  assert(js.indexOf('function stageOf') >= 0, '缺开头/中段/尾段判定');
  // 轻互动一律触发式：不许弹模态
  assert(js.indexOf('alert(') < 0 && js.indexOf('confirm(') < 0, '轻互动里出现了模态弹窗');
});


check('三阶九问浮窗：单问触发 / 可跳过 / 前附页不出卡 / 可拖 / 进度在底栏', function () {
  const html = read('renderer-v2/reader/index.html');
  const js = read('renderer-v2/reader/reader.js');
  const css = read('renderer-v2/reader/reader.css');
  // 浮窗骨架
  ['rr-ask', 'rr-ask-head', 'rr-ask-input', 'rr-ask-save', 'rr-ask-skip', 'rr-ask-open'].forEach(function (w) {
    assert(html.indexOf(w) >= 0, '浮窗缺少：' + w);
  });
  assert(/id="rrAsk"[^>]*hidden/.test(html), '浮窗应初始隐藏（不能常驻挡正文）');
  // 浮窗只留读中三问：读前读后归右栏面板，浮窗不再有「切阶段」
  assert(html.indexOf('rr-ask-stage') < 0 && js.indexOf('cycleAskStage') < 0,
    '浮窗仍带「切阶段」：伴读浮窗应只保留读中三问');
  // 右栏：三阶九问取代原自由表单（类型 / 摘录 / 想法 / 页码 / 标签）
  ['rr-q9-tabs', 'rr-q9-list'].forEach(function (w) {
    assert(html.indexOf(w) >= 0, '右栏九问面板缺少：' + w);
  });
  ['id="rrType"', 'id="rrQuote"', 'id="rrText"', 'id="rrPageNo"', 'id="rrTags"', 'id="rrSave"'].forEach(function (w) {
    assert(html.indexOf(w) < 0, '右栏仍留着旧的自由表单字段：' + w);
  });
  assert(js.indexOf('function renderQ9') >= 0 && js.indexOf('function commitQ9') >= 0,
    '九问面板没有渲染 / 落库实现');
  // 划线工具条带三问快捷入口（重述 / 连接 / 行动），右击也走同一条
  ['data-ask="0"', 'data-ask="1"', 'data-ask="2"'].forEach(function (w) {
    assert(html.indexOf(w) >= 0, '划线工具条缺少快捷问：' + w);
  });
  assert(js.indexOf("doc.addEventListener('contextmenu'") >= 0, '右击划线没有接过工具条');
  // 三阶九问：三个阶段与九问都要在，且每题带落库类型/标签
  ['pre:', 'mid:', 'post:'].forEach(function (k) {
    assert(js.indexOf(k) >= 0, '缺阶段：' + k);
  });
  ['Q1 · 我为什么翻开它', 'Q3 · 什么算', 'Q4 · 这句话在说什么', 'Q5 · 接得上我的什么',
    'Q6 · 下次什么场景怎么做', 'Q7 · 这一章在论证什么', 'Q8 · 我信几分', 'Q9 · 哪一句带走'].forEach(function (q) {
    assert(js.indexOf(q) >= 0, '缺问题：' + q);
  });
  assert(js.indexOf("type: 'link', tag: '连接'") >= 0, 'Q5 没落到 link 类型');
  // 单问触发：一次只渲染一问，不许退回并列三按钮
  assert(html.indexOf('rr-prompts') < 0, '右栏并列三问块应已下线');
  assert(js.indexOf("querySelectorAll('.rr-prompt')") < 0, '又变回并列三问');
  // 全可跳过、不设配额
  assert(js.indexOf('function skipAsk') >= 0, '缺「跳过」');
  assert(js.indexOf('读中三问问完了') >= 0, '缺阶段完成态');
  assert(!/连续打卡|每日配额|红点提醒/.test(js), '轻互动里出现配额/打卡类字眼');
  // 章末卡是「不入正文」的顶部浮层：DOM 在父窗口，靠上、半透明、字号更小
  assert(/<section class="rr-endcard"[^>]*id="rrEndCard"/.test(html), '章末卡不在父窗口 DOM 里');
  assert(js.indexOf("doc.body.appendChild(buildEndCard())") < 0, '章末卡仍往正文里插节点');
  assert(/\.rr-endcard[\s\S]{0,240}position: fixed/.test(css), '章末卡不是浮层');
  assert(/\.rr-endcard[\s\S]{0,400}width: 380px/.test(css), '章末卡没收窄（会空一大片）');
  assert(js.indexOf('function positionEndCard') >= 0 && js.indexOf("querySelector('.rr-main')") >= 0,
    '章末卡没按中栏实测定位（会横跨到侧栏）');
  assert(/\.rr-endcard[\s\S]{0,600}rgba\(255, 252, 245, 0\.[0-8]\d?\)/.test(css), '章末卡不是半透明');
  assert(/\.rr-endcard[\s\S]{0,400}font-size: 11\.5px/.test(css), '章末卡字号没压小');
  assert(css.indexOf('backdrop-filter: blur') >= 0, '章末卡没有毛玻璃穿透');
  // hidden 必须真的藏：卡片与浮窗里都有 display:flex 的块，类选择器会盖过 UA 的 [hidden]
  assert(/\.rr-endcard \[hidden\][\s\S]{0,80}display: none !important/.test(css),
    '章末卡输入区默认没藏住（hidden 被 display:flex 盖掉）');
  // 划线工具条必须压过章末轻卡：划在章末那一段时，提示卡正好盖住工具条左半边（出图时发现）
  const zIndexOf = function (sel) {
    const m = css.match(new RegExp(sel + '[\\s\\S]{0,220}?z-index:\\s*(\\d+)'));
    return m ? Number(m[1]) : -1;
  };
  assert(zIndexOf('\\.rr-selbar') > zIndexOf('\\.rr-endcard'),
    '划线工具条被章末卡盖住（z-index 顺序反了）：'
    + zIndexOf('\\.rr-selbar') + ' vs ' + zIndexOf('\\.rr-endcard'));
  // 底栏：进度 + 本次/累计时长
  assert(html.indexOf('id="rrTime"') >= 0, '底栏缺时长位');
  assert(js.indexOf('function renderTime') >= 0 && js.indexOf('function flushTime') >= 0, '缺时长统计');
  assert(js.indexOf("'本次 '") >= 0 && js.indexOf("' · 累计 '") >= 0, '时长文案缺本次/累计');
  assert(js.indexOf('TIME_KEY') >= 0, '时长没按书累计');
  // 浮窗默认避开右栏，别压住笔记按钮
  assert(js.indexOf('function placeAskDefault') >= 0, '浮窗没有按正文区算默认位置（窄窗口会压正文）');
  // 前附页不出章末卡（封面 / 版权页 / 目录）
  assert(js.indexOf('function isFrontMatter') >= 0 && js.indexOf('封面|封底|版权') >= 0, '缺前附页识别');
  assert(js.indexOf('if (isFrontMatter(currentIndex)) return;') >= 0, '章末卡没排除前附页');
  // 引用原文：浮窗里能引、能显示、能落到笔记并带锚点（右栏才跳得回去）
  ['rrAskQuote', 'rrAskQuoteText', 'rrAskQuoteClear', 'rrAskPick'].forEach(function (w) {
    assert(html.indexOf(w) >= 0, '引用原文缺少：' + w);
  });
  assert(js.indexOf('function pickAskQuote') >= 0 && js.indexOf('function clearAskQuote') >= 0,
    '缺「引原文 / 去掉引用」');
  assert(js.indexOf('quote: askQuote.text') >= 0 && js.indexOf('anchor: askQuote.anchor') >= 0,
    '三阶问落库时没带引用与锚点');
  // 浮窗可拖、位置记忆
  assert(js.indexOf('function bindAskDrag') >= 0 && js.indexOf('ASK_POS_KEY') >= 0, '浮窗不可拖 / 不记位置');
  assert(css.indexOf('cursor: move') >= 0, '浮窗标题栏没有可拖提示');
  // 进度移到底栏，顶栏留空
  const fAt = html.indexOf('<footer class="rr-status"');
  const footer = html.slice(fAt, html.indexOf('</footer>', fAt));
  assert(footer.indexOf('rrProgressSync') >= 0 && footer.indexOf('rrProgressText') >= 0, '进度没在底栏');
  const tAt = html.indexOf('class="rr-top"');
  const top = html.slice(tAt, html.indexOf('</header>', tAt));
  assert(top.indexOf('rrProgressSync') < 0, '顶栏还留着「同步进度」');
  // 正文常规字重、标题黑体加粗
  assert(js.indexOf("'font-weight:400;'") >= 0, '正文没显式常规字重');
  assert(/body\.rr-typo p,body\.rr-typo li/.test(js), '正文元素字重未统一');
  assert(/em,body\.rr-typo i\{font-style:normal;font-weight:400/.test(js), 'em 仍在加黑');
  assert(/h1,body\.rr-typo h2[\s\S]{0,200}font-weight:700/.test(js), '标题不是加粗黑体');
  // 双击书架直接翻开
  const v = read('renderer-v2/src/views/ReadingView.vue');
  assert(v.indexOf('@dblclick="startBook(b)"') >= 0, '书架行没有双击开读');
  assert(v.indexOf("@dblclick=\"startThemeBook(b)\"") >= 0, '主题书行没有双击开读');
  assert((v.match(/@dblclick\.stop/g) || []).length >= 2, '书行动作区没拦双击冒泡（会误触发开读）');
});

// ---- V2.12 本机时间源（md_worktime）----

check('本机时间源：只发 GET、只连回环、只经主进程（渲染层没有网络）', function () {
  const client = read('src/worktime/client.js');
  assert(/require\('node:http'\)/.test(client), '客户端没用内置 node:http（别引第三方库）');
  assert(!/https/.test(client), '客户端出现了 https（本机回环不该有 TLS）');
  assert(/method: 'GET'/.test(client), '客户端没把方法钉成 GET');
  ['POST', 'PUT', 'DELETE', 'PATCH'].forEach(function (m) {
    assert(client.indexOf("'" + m + "'") < 0, '客户端出现写方法 ' + m + '（只读边界破了）');
  });
  assert(/board\.HOST_RE\.test/.test(client), '客户端没有回环校验');
  assert(/'Bearer '/.test(client), '没做可选 API Key（rust 版会 401）');

  const api = read('src/core/api-layer.js');
  ['worktime.read', 'worktime.sync', 'worktime.addRule', 'worktime.clearDays', 'worktime.writeLine'].forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, '领域白名单缺 ' + n);
  });
  assert(api.indexOf("'v1/worktime:sync'") >= 0, '缺少同步通道（异步路由）');
  const preload = read('src/preload/v2-preload.js');
  assert(preload.indexOf("'v1/worktime:sync'") >= 0, 'preload 白名单缺同步通道');
  const yml = read('electron-builder-v2.yml');
  assert(yml.indexOf('src/worktime/**/*') >= 0, '打包配置漏了 src/worktime（exe 一启动就会 require 失败）');

  allRendererSources().forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    assert(!/fetch\(|XMLHttpRequest/.test(text), path.basename(file) + ' 在渲染层直接发请求');
  });
});

check('本机时间源：默认关闭、契约里没有 title 字段、备份与导入都接上', function () {
  const wt = require(path.join(root, 'src/worktime/board.js'));
  assert(wt.empty().enabled === false, '默认必须是关闭');
  const s = wt.normalize({
    enabled: true,
    days: { '2026-11-11': { activeSec: 60, title: '某某银行 - Chrome' } },
    rules: [{ id: 'r1', app: 'code', label: '编程' }]
  });
  assert(JSON.stringify(s).indexOf('某某银行') < 0, '窗口标题进了状态（必须在归一化阶段就丢弃）');
  assert(Object.prototype.hasOwnProperty.call(s.days['2026-11-11'], 'title') === false, '日记录里出现了 title 字段');
  let hostRejected = false;
  try { wt.setHost(wt.empty(), '10.1.1.1:5600'); } catch (e) { hostRejected = /回环/.test(e.message); }
  assert(hostRejected, '非回环地址没被拒');

  const main = read('src/main/main-v2.js');
  assert(/obj\.worktime = worktimeStore\.read\(\)/.test(main), '导出备份没带 worktime 段');
  assert(/\['worktime', worktimeStore, worktimeMod\]/.test(main), '导入备份没接 worktime 段');
  assert(/localDayBounds/.test(main), '缺少本地日界换算（UTC 与本地日会错位）');
});

check('本机时间源：界面四处齐、关着就不渲染、右栏不碰规则与开关', function () {
  const strip = read('renderer-v2/src/components/WorktimeStrip.vue');
  assert(/v-if="enabled"/.test(strip), '投入条没有按开关渲染（关着也会占位置）');
  assert(strip.indexOf('未归类') >= 0 && strip.indexOf('记一条') >= 0, '投入条缺未归类比例或「记一条」');
  assert(!/window\.|document\.|fetch\(/.test(strip), '投入条直接碰了浏览器网络/全局对象');

  const work = read('renderer-v2/src/views/WorkView.vue');
  assert(work.indexOf('<WorktimeStrip') >= 0, '工作视图没挂投入条');

  const wc = read('renderer-v2/src/components/context/WorkContext.vue');
  assert(wc.indexOf('本机时间源') >= 0, '右栏没有本机时间源卡');
  assert(/v-if="wt && wt\.enabled"/.test(wc), '右栏时间源卡没跟着开关走');
  ['worktime.addRule', 'worktime.removeRule', 'worktime.enable', 'worktime.clearDays', 'worktime.setHost'].forEach(function (n) {
    assert(wc.indexOf(n) < 0, '右栏出现了 ' + n + '（开关与规则只该在设置页）');
  });

  const set = read('renderer-v2/src/components/SettingsView.vue');
  ['worktime.enable', 'worktime.addRule', 'worktime.removeRule', 'worktime.clearDays', 'worktime.setHost', 'worktime.setKeepDays'].forEach(function (n) {
    assert(set.indexOf(n) >= 0, '设置页缺少 ' + n);
  });
  assert(set.indexOf('九格自己不采集任何东西') >= 0, '设置页没有「九格不采集」的常驻声明');
  assert(set.indexOf('窗口标题只用于归类匹配') >= 0, '设置页没说清标题用完即丢');
});

check('口径一致：关于页不再写死「不联网」，两处都得是双态', function () {
  const set = read('renderer-v2/src/components/SettingsView.vue');
  assert(set.indexOf('不联互联网') >= 0, '关于页没有改成「不联互联网」的精确口径');
  assert(set.indexOf('本机时间源已开启') >= 0 && set.indexOf('不发起任何网络请求（含本机回环）') >= 0,
    '关于页没有双态说明');
});

// ---------- 首页天气：默认开、关了真关、只经主进程 ----------
check('首页天气：只经主进程、渲染层没有 URL、关了就不发请求', function () {
  const pill = read('renderer-v2/src/components/WeatherPill.vue');
  const use = read('renderer-v2/src/composables/useWeather.ts');
  const bridge = read('renderer-v2/src/bridge.ts');
  const main = read('src/main/main-v2.js');
  const client = read('src/weather/client.js');
  const board = read('src/weather/board.js');
  const preload = read('src/preload/v2-preload.js');
  const api = read('src/core/api-layer.js');
  const builder = read('electron-builder-v2.yml');

  // 渲染层只能说「取天气」：域名、超时、UA 全在主进程
  assert(pill.indexOf('fetch(') < 0 && use.indexOf('fetch(') < 0, '渲染层自己发了网络请求');
  assert(!/https?:\/\//.test(pill + use + bridge), '渲染层出现了远程地址（应只写在 weather/client.js）');
  assert(pill.indexOf('useWeather') >= 0 && use.indexOf('weatherSync') >= 0, '天气条没接上 useWeather');

  // 关闭态必须在领域层就短路，而不是「取了不用」
  assert(main.indexOf("code: 'NOT_ENABLED', msg: '首页天气未开启'") >= 0,
    '关掉天气后主进程没有短路（还在发请求）');
  assert(/if \(!state\.enabled\) return;/.test(use), '渲染层关闭态没有跳过请求');
  assert(/v-if="state\.enabled"/.test(pill), '关闭后天气条仍占位（应该整块消失）');

  // 网络边界：白名单 + 只 GET + 超时 + 体积上限，四条都要在客户端里看得见
  ['ipwho.is', 'api.open-meteo.com'].forEach(function (h) {
    assert(client.indexOf(h) >= 0, '客户端缺少 ' + h);
  });
  assert(/HOSTS\.indexOf|checkHost/.test(client), '客户端没有域名白名单校验');
  assert(/method: 'GET'/.test(client) && client.indexOf('POST') < 0, '天气客户端不是只 GET');
  assert(/TIMEOUT_MS/.test(client) && /MAX_BODY/.test(client), '客户端缺超时或体积上限');
  assert(/node:https/.test(client) && client.indexOf('require(\'axios\')') < 0, '天气客户端引入了第三方 HTTP 库');

  // 偏好只存偏好：契约里不许有温度 / 报告字段（温度是外部投影，不进备份）
  assert(/KEY = 'md_weather'/.test(board), '天气键名不是 md_weather');
  assert(!/report:/.test(board.slice(board.indexOf('function normalize'), board.indexOf('function setEnabled'))),
    'normalize 里出现了 report（缓存被写进备份了）');
  assert(main.indexOf("['weather', weatherStore") < 0, '天气缓存被接进备份段（应只存偏好）');

  // 通道：preload 白名单 + api 路由 + 打包配置三处都得有
  ['v1/weather:sync', 'v1/weather:geocode'].forEach(function (c) {
    assert(preload.indexOf(c) >= 0, 'preload 白名单缺 ' + c);
    assert(api.indexOf(c) >= 0, 'api-layer 缺路由 ' + c);
  });
  ['weather.view', 'weather.setEnabled', 'weather.setCity'].forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, 'domain 白名单缺 ' + n);
  });
  assert(builder.indexOf('src/weather/**/*') >= 0, '打包配置漏了 src/weather（exe 启动会白屏）');

  // 设置页必须能关掉，且开关与首页共用同一份状态
  const set = read('renderer-v2/src/components/SettingsView.vue');
  assert(set.indexOf('useWeather') >= 0 && set.indexOf('setEnabled') >= 0, '设置页没有天气开关');
  assert(set.indexOf('不发送日记') >= 0, '设置页没说清不发送日记内容');

  // 底栏必须按天气开关改口，否则就是「一边联网一边写零网络」
  const status = read('renderer-v2/src/components/StatusBar.vue');
  assert(/仅天气联网/.test(status), '底栏没有「仅天气联网」这一态');
  assert(/wxOn/.test(status), '底栏没接天气开关');
});

// ---------- V2.14：联网天气 ↔ 今天概况（主理人改口径） ----------
check('联网天气关联今天概况：映射只一份、只联动今天、点一次保存就落盘', function () {
  const board = read('src/weather/board.js');
  const use = read('renderer-v2/src/composables/useWeather.ts');
  const extras = read('renderer-v2/src/components/TodayExtras.vue');
  const pill = read('renderer-v2/src/components/WeatherPill.vue');
  const ctx = read('renderer-v2/src/components/context/TodayContext.vue');
  const app = read('renderer-v2/src/App.vue');
  const set = read('renderer-v2/src/components/SettingsView.vue');
  const bridge = read('renderer-v2/src/bridge.ts');

  // 8 档折算只在领域层做一次：渲染层再抄一份 WMO 代码表，两套映射迟早漂移
  assert(/toBaseWeather\s*\(/.test(board) && /baseWeather:/.test(board), '领域层没有 8 档折算');
  assert(/baseWeather/.test(bridge), 'bridge 的 WeatherNow 没有 baseWeather');
  assert(!/weather_code|WMO|CODE_TO_BASE/.test(extras + ctx + pill), '渲染层重复实现了 WMO 映射');
  assert(/autoWeather/.test(use), 'useWeather 没有给出可自动带入的档位');

  // 断网才手填：autoWeather 在 error / 关闭态返回空串；且只对今天生效
  assert(/state\.error/.test(use) && /return ''/.test(use), '断网没有转手填');
  assert(/localDate\(\)/.test(extras) && /isToday/.test(extras), '没有按日期限定「只联动今天」');
  assert(/manual/.test(extras) && /autoWx/.test(extras), '没有手填 / 自动二态');

  // 「点击保存直接记录」：两个保存按钮都带 base，浮层一键落盘由 App 收口
  const saves = extras.match(/persist\(\{ base: base\.value \}\)/g) || [];
  assert(saves.length >= 2, '不是两个保存按钮都带上 base（会逼用户点两次）');
  assert(/@click="saveAll"/.test(extras), '「保存今日记录」没接 saveAll');
  assert(/记进今天/.test(pill), '天气浮层没有「记进今天」');
  assert(/onSaveToToday/.test(app) && /base\s*=\s*Object\.assign/.test(app), 'App 没接浮层保存');

  // 概览卡标来源；上一轮「永不覆盖」的旧口径必须清干净，不能两处说法打架
  assert(/wxTag/.test(ctx) && /联网/.test(ctx), '今天概览没有标出联网来源');
  assert(set.indexOf('不会被自动值覆盖') < 0, '设置页还留着上一轮旧口径');
  assert(board.indexOf('绝对不行') < 0, 'board.js 还留着上一轮旧口径注释');
});

// ---------- 账本窗口 V3.1：规格与主窗一致 + 三库联动只走白名单 ----------
check('账本窗与主窗同规格；手记收支只读联动、梦想账户并入储蓄目标', function () {
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const view = read('renderer-v2/src/views/FinanceView.vue');

  // 两个 BrowserWindow 的宽高与下限必须逐字相同
  assert(/width:\s*1440,[\s\S]{0,80}height:\s*900,[\s\S]{0,80}minWidth:\s*1024,[\s\S]{0,80}minHeight:\s*680/.test(main),
    '主窗规格被改动或没找到');
  const fin = main.slice(main.indexOf('function openFinanceWindow'), main.indexOf('function openFinanceWindow') + 900);
  assert(/width:\s*1440/.test(fin) && /height:\s*900/.test(fin), '账本窗宽高与主窗不一致');
  assert(/minWidth:\s*1024/.test(fin) && /minHeight:\s*680/.test(fin), '账本窗最小尺寸与主窗不一致');
  // 三栏规格也要一致：默认 240 / 300、中栏 ≥420、可拖、双击复位
  assert(/NAV_DEF\s*=\s*240/.test(view) && /RAIL_DEF\s*=\s*300/.test(view)
    && /CENTER_MIN\s*=\s*420/.test(view), '账本窗栏宽常量与主窗不一致');
  assert(/var\(--nav-w, 240px\)/.test(view) && /var\(--rail-w, 300px\)/.test(view),
    '栏宽没走与主窗同款 CSS 变量');
  assert(/col-divider/.test(view) && /resetLayout/.test(view), '账本窗缺可拖栏宽或双击复位');

  // 两个新通道：白名单 / 主进程 / 视图三处齐
  ['finance.moneyRows', 'finance.importMoneyRows'].forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, '白名单缺 ' + n);
    assert(main.indexOf("'" + n + "'") >= 0, '主进程缺 ' + n);
    assert(view.indexOf("'" + n + "'") >= 0, '视图没调用 ' + n);
  });
  // 只读联动：账本绝不改写九格日记；梦想账户的存入必须写回 dream.deposit
  assert(view.indexOf('diaries:upsert') < 0 && view.indexOf('morning_diary_') < 0,
    '账本窗在改写九格日记（只允许只读汇总）');
  assert(/dream\.deposit/.test(view), '梦想账户存入没写回 dream.deposit');
  assert(/finance\.updateGoal/.test(view), '本地储蓄目标存入没走 finance.updateGoal');
  assert(/moneyBook\.normalize/.test(main), '主进程没有清洗手记收支数据');
});

// ---------- 2026-11-11 九格界面：去日期 / 标题直达 / 按模块引导语 ----------
check('九格页头无日期、标题单击进模块、占位语按模块随机取词', function () {
  const grid = read('renderer-v2/src/components/GridEditor.vue');
  const tpl = grid.slice(grid.indexOf('<template>'), grid.indexOf('</template>'));

  // 1) 日期文字下线，但补记标记、进度统计、保存态一个都不能丢
  assert(!/\{\{\s*record\.date\s*\}\}/.test(tpl), '九格页头还在渲染日期');
  assert(/class="date-title"/.test(tpl) && /v-if="backfill"/.test(tpl), '补记标记被一起删了');
  assert(/已写 \{\{ filledCount \}\} \/ \{\{ GRID_KEYS\.length \}\} 格/.test(tpl), '页头进度统计被删了');
  assert(/'badge-on': dirty/.test(tpl), '保存状态徽标被删了');

  // 2) 标题即入口：可单击、可读、键盘可达，双击兜底仍在且按钮双击不重复跳转
  assert(/<button[\s\S]{0,80}class="cell-label"/.test(tpl), '格位标题不是 button（键盘不可达）');
  assert(/class="cell-label"[\s\S]{0,320}@click\.stop="emit\('open-cell', key\)"/.test(tpl),
    '单击标题没有走 open-cell');
  assert(/'进入' \+ GRID_LABELS\[key\] \+ '模块'/.test(tpl), '标题缺 aria-label');
  assert(/@dblclick="onCellDblClick\(\$event, key\)"/.test(tpl), '双击进主功能的兜底入口被删了');
  assert(/el\.tagName === 'BUTTON'/.test(grid), '按钮双击会连发跳转');

  // 3) 占位语：按 key 绑定、走同源 promptFor、leisure 视图层补词、按日随机、可换一批
  assert(tpl.indexOf('随手一句，可写多行') < 0, '九格仍共用同一句占位语');
  assert(/:placeholder="prompts\[key\] \|\| FALLBACK_PROMPTS\[key\]"/.test(tpl), '占位语没按格位绑定');
  assert(/callDomain<string>\('promptFor'/.test(grid), '引导语没接领域层同源题库');
  assert(/LEISURE_PROMPTS/.test(grid) && /k === 'dream'/.test(grid), '休闲娱乐格没有专属引导语');
  assert(/GRID_LIBRARY\.standard\.dream/.test(grid) && /FIRST_WEEK_EASY\.dream/.test(grid),
    '休闲娱乐引导语没从 dream 词库取（键回归后漏改会退回通用词）');
  assert(/dailyOffset/.test(grid) && /firstWeekState/.test(grid), '缺按日随机或头七天判定');
  assert(/shufflePrompts/.test(grid) && /换一批引导语/.test(tpl), '缺「换一批引导语」入口');
});

check('多语言：设置页语言选择、渲染层词典与零改写红线', function () {
  const src = function (rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); };
  const set = src('renderer-v2/src/components/SettingsView.vue');
  const app = src('renderer-v2/src/App.vue');
  const fin = src('renderer-v2/src/finance-main.ts');
  const i18n = src('renderer-v2/src/i18n/useI18n.ts');
  assert(set.indexOf('8 · 语言') >= 0 && set.indexOf('setLocale') >= 0, '设置页缺语言选择');
  assert(set.indexOf('data-no-i18n') >= 0, '语言名按钮没有免翻译标记');
  assert(app.indexOf('initI18n()') >= 0 && fin.indexOf('initI18n()') >= 0, '主窗 / 账本窗没初始化语言');
  assert(i18n.indexOf('input, textarea, [contenteditable]') >= 0, '语言层没排除输入与用户内容区');
  assert(!/fetch\(|XMLHttpRequest/.test(i18n), '语言层发起了网络请求');
  const d = JSON.parse(src('renderer-v2/src/i18n/dict.json'));
  assert(d.exact && d.exact['en-US'] && d.patterns.length >= 1, '词典缺英文或参数模板');
  const l = JSON.parse(src('renderer-v2/src/i18n/locales.json'));
  ['en-US', 'zh-Hant', 'ja-JP', 'zh-Hans'].forEach(function (c) {
    assert(l[c] && l[c].meta && l[c].meta.code === c, '语言包缺 ' + c);
  });
});

// ---------- 自由记录模块三合一 + 胶囊降级（docs/28）----------
check('自由记录：胶囊降顶栏 / 三 tab / 新键六处接线 / 闪念同步只在主进程', function () {
  const types = read('renderer-v2/src/types.ts');
  const app = read('renderer-v2/src/App.vue');
  const modal = read('renderer-v2/src/components/CapsuleModal.vue');
  const free = read('renderer-v2/src/views/FreeView.vue');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const yml = read('electron-builder-v2.yml');
  const board = read('src/free/board.js');

  assert(types.indexOf("'free'") >= 0, 'ViewKey 缺少 free');
  assert(app.indexOf("import FreeView from './views/FreeView.vue'") >= 0, 'App 未接入 FreeView');
  assert(app.indexOf("view === 'free'") >= 0, 'App 缺少 free 视图分支');
  assert(app.indexOf('class="capsule-btn"') >= 0 && app.indexOf("openCapsuleModal('write')") >= 0, '顶栏胶囊按钮未接线');
  assert(app.indexOf('<CapsuleModal') >= 0, '弹窗未挂载');
  assert(/navigate\('free'\)/.test(app), '九格自由格未落到同一视图（入口唯一）');

  // 弹窗两态：书写态复用原组件，领域层与「封存中不泄露正文」一行未改
  assert(modal.indexOf('<CapsuleView') >= 0, '书写态没复用 CapsuleView');
  assert(modal.indexOf('capsuleGroups') >= 0, '到期态没有数据来源');
  assert(modal.indexOf('openCapsule') >= 0, '到期态不能开读');

  ['① 胶囊收录', '② 闪念快记', '③ 长文撰写'].forEach(function (t) {
    assert(free.indexOf(t) >= 0, '自由记录缺 tab：' + t);
  });
  assert(free.indexOf('free.flashAdd') >= 0 && free.indexOf('free.board') >= 0, '闪念未接新键');
  // 2026-11-13：一级导航撤掉「自由记录」——它与九格「自由」格是同一个视图。
  // 视图不删，入口收敛到九格目录（openCell('free') → view 'free'），那一行要自己亮起来。
  assert(!/key: 'free', label/.test(types), '自由记录仍占着一级导航');
  assert(read('renderer-v2/src/components/NavSidebar.vue').indexOf("props.active === 'free' && key === 'free'") >= 0,
    '九格目录里的「自由记录」进页后没有选中态');
  // 2026-11-13：写作法统计卡从中栏搬到右栏。体检调用点随共享状态移入
  // composables/useWritingCheck.ts（中栏写、右栏读同一份结果）；断言改为
  // 「共享层有且只有一份调用点 + 视图接的是这一层 + 右栏真有那张卡」，
  // 避免两处各调一次 writing.check 导致数字对不上。
  const wc = read('renderer-v2/src/composables/useWritingCheck.ts');
  const ctx = read('renderer-v2/src/components/ContextPanel.vue');
  assert(wc.indexOf('writing.check') >= 0, '写作法体检未接线');
  assert(free.indexOf('useWritingCheck') >= 0 && free.indexOf('writing.check') < 0,
    '写作法体检出现第二个调用点（必须只在共享层算一次）');
  assert(ctx.indexOf('WritingContext') >= 0, '右栏未接入写作法卡');
  assert(free.indexOf('fw-stats') < 0, '中栏还留着写作法统计卡（应只在右栏一份）');
  // 长文正文绝不落进当日日记格（2000 字上限 + 每次保存整篇 record 全量写）
  assert(!/\.cells\.free\s*=|\.cells\.free\s*\+/.test(free), '长文正文误写进 cells.free');
  assert(!/v-html|fetch\(|XMLHttpRequest/.test(free), '自由记录视图出现越权或直插正文');
  assert(!/https?:\/\//.test(free), '自由记录视图含远程 URL');
  assert(free.indexOf('gtd.add') < 0, '渲染层越权写 GTD');

  // 胶囊权威源仍是冻结的 diary-store：渲染层只能读主进程派生的元信息
  assert(main.indexOf("'free.capsuleIndex'") >= 0, '主进程缺胶囊只读派生路由');
  assert(free.indexOf('listCapsules') < 0, '渲染层直接读 listCapsules 会泄露封存正文');
  assert(main.indexOf("makeDomainStore('md_freewrite', freeMod)") >= 0, '缺 md_freewrite 单键');
  assert(main.indexOf('obj.freewrite = freeStore.read()') >= 0, '备份未注入 freewrite 段');
  assert(main.indexOf("['freewrite', freeStore, freeMod]") >= 0, '备份导入未接 freewrite 段');
  ['free.board', 'free.flashAdd', 'free.docAdd', 'writing.check'].forEach(function (k) {
    assert(api.indexOf("'" + k + "'") >= 0, '白名单缺 ' + k);
  });
  assert(yml.indexOf('src/free/**/*') >= 0 && yml.indexOf('src/writing/**/*') >= 0, '打包清单漏新领域层');
  assert(board.indexOf('function mergeSection') >= 0 && board.indexOf('function normalize') >= 0,
    '新键领域层缺 normalize / mergeSection');
  assert(board.indexOf('DOC_BODY_MAX = 20000') >= 0, '长文上限被改小或写死');
  assert(main.indexOf('gtd.addTask(s, {') >= 0, '主进程未做闪念 → 收件箱同步');

  // 2026-11-16 打通：三合一是唯一写入口，九格第 9 格只显示当天摘要。
  // 三处速记入口（顶栏速记 / 一键留一句 / 任务转发）全部改落 md_freewrite，
  // 不再往 cells.free 拼一行——否则「格子里有、三合一里没有」的老毛病会换个方向再来一次。
  assert(main.indexOf("'free.day'") >= 0, '主进程缺 free.day 当天摘要路由');
  assert(main.indexOf("'free.noteAdd'") >= 0, '主进程缺 free.noteAdd（只留原文、不生成收件箱任务）');
  assert(api.indexOf("'free.day'") >= 0 && api.indexOf("'free.noteAdd'") >= 0, '白名单缺 free.day / free.noteAdd');
  const ge = read('renderer-v2/src/components/GridEditor.vue');
  assert(ge.indexOf("'free.day'") >= 0 && ge.indexOf("'free.noteAdd'") >= 0, '九格第 9 格未接当天摘要 / 快记');
  assert(ge.indexOf('cf-list') >= 0 && ge.indexOf('cf-add') >= 0 && ge.indexOf('cf-open') >= 0,
    '九格自由格缺摘要 / 快记 / 打开入口三块结构');
  assert(!/v-model="draft\.cells\['free'\]"/.test(ge), '九格自由格又变回独立正文（会出现两份事实源）');
  assert(read('renderer-v2/src/App.vue').indexOf("'free.noteAdd'") >= 0, '速记未落自由记录（仍在写 cells.free）');
  assert(read('renderer-v2/src/components/TodayExtras.vue').indexOf("'free.noteAdd'") >= 0, '一键留一句未落自由记录');
  assert(read('renderer-v2/src/views/WorkView.vue').indexOf("'free.noteAdd'") >= 0, '任务转发未落自由记录');
});

check('家庭亲子：主栏记录窗 + 右栏登记三块 / md_family 六处接线 / 历史 cells.emotion 一个字节不动', function () {
  const types = read('renderer-v2/src/types.ts');
  const app = read('renderer-v2/src/App.vue');
  const view = read('renderer-v2/src/views/FamilyView.vue');
  const ctx = read('renderer-v2/src/components/context/FamilyContext.vue');
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  const nav = read('renderer-v2/src/components/NavSidebar.vue');
  const board = read('src/family/board.js');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const yml = read('electron-builder-v2.yml');

  assert(types.indexOf("'family'") >= 0, 'ViewKey 缺少 family');
  assert(app.indexOf("import FamilyView from './views/FamilyView.vue'") >= 0, 'App 未接入 FamilyView');
  assert(app.indexOf("view === 'family'") >= 0, 'App 缺少 family 视图分支');
  assert(/if \(key === 'emotion'\) \{ navigate\('family'\); return; \}/.test(app),
    '第 6 格未直通家庭亲子页（会落到通用单格页）');
  assert(/props\.active === 'family' && key === 'emotion'/.test(nav), '家庭亲子进页后九格这一行没有选中态');

  // 2026-11-16：成员登记整块移到右栏，主栏只留「今天 · 亲子时刻 / 成长足迹」+ 一段正文。
  ['今天 · 亲子时刻', '成长足迹'].forEach(function (t) {
    assert(view.indexOf(t) >= 0, '家庭亲子缺 tab：' + t);
  });
  assert(ctx.indexOf('家庭成员') >= 0, '右栏未接家庭成员登记块');
  assert(view.indexOf('CellRecordEditor') >= 0 && view.indexOf('cell-key="emotion"') >= 0,
    '主栏缺记录窗口（或没写回 cells.emotion）');
  ['family.board', 'family.addMember', 'family.addMoment', 'family.addMilestone'].forEach(function (k) {
    assert((view + ctx).indexOf(k) >= 0, '家庭亲子视图未接 ' + k);
  });
  assert(!/v-html|fetch\(|https?:\/\//.test(view), '家庭亲子视图出现越权 / 联网');
  assert(panel.indexOf('FamilyContext') >= 0 && ctx.indexOf('family.board') >= 0, '右栏未接入家庭亲子上下文');
  // 这一格仍是日记正文：历史情绪记录在 cells.emotion 里，视图不许绕开 save() 直写
  assert(!/cells\.emotion\s*=/.test(view + app), '家庭亲子视图越权改写日记正文');

  assert(main.indexOf("makeDomainStore('md_family', familyMod)") >= 0, '缺 md_family 单键');
  assert(main.indexOf('obj.family = familyStore.read()') >= 0, '备份未注入 family 段');
  assert(main.indexOf("['family', familyStore, familyMod]") >= 0, '备份导入未接 family 段');
  ['family.meta', 'family.board', 'family.addMember', 'family.updateMember',
    'family.removeMember', 'family.addMoment', 'family.removeMoment',
    'family.addMilestone', 'family.removeMilestone'].forEach(function (k) {
    assert(api.indexOf("'" + k + "'") >= 0, '白名单缺 ' + k);
  });
  assert(yml.indexOf('src/family/**/*') >= 0, '打包清单漏 family 领域层');
  assert(board.indexOf('function normalize') >= 0 && board.indexOf('function mergeSection') >= 0,
    'family 领域层缺 normalize / mergeSection');
  assert(board.indexOf('function board') >= 0 && board.indexOf('function ageOf') >= 0,
    'family 领域层缺派生 / 年龄');
  // 删成员不删历史：归一化时不许按成员表过滤 memberIds
  assert(board.indexOf('normMoment(m, null)') >= 0, '归一化仍在按成员表裁剪历史时刻的归属');
});

check('V3.8 今天页成长主线：三源只读派生 + 证据回流 + 成效侧指标口径', function () {
  const today = read('renderer-v2/src/components/context/TodayContext.vue');
  const dream = read('src/dream/board.js');
  const metrics = read('src/core/metrics.js');
  const api = read('src/core/api-layer.js');
  const dc = read('renderer-v2/src/components/DataCenter.vue');

  // ① 右栏只读三源、并发取，零写调用
  ['dream.board', 'gtd.board', 'reading.board'].forEach(function (n) {
    assert(today.indexOf("'" + n + "'") >= 0, '成长主线缺只读数据源：' + n);
  });
  assert(/Promise\.all\(\[/.test(today), '三源没有并发取');
  ['dream.update', 'dream.add', 'gtd.complete', 'reading.advanceBook', 'reading.updateBook'].forEach(function (n) {
    assert(today.indexOf("'" + n + "'") < 0, '右栏越权写：' + n);
  });
  assert(today.indexOf('aria-label="成长主线"') >= 0, '缺「成长主线」卡');
  assert(today.indexOf('g.evidence.text') >= 0, '目标行没显示证据回流');
  assert(today.indexOf('个在推') >= 0 && today.indexOf('天没动') >= 0, '没把「在推」与「挂着」分开说');
  // 三块快捷入口：目标去梦想页、完成/可执行去工作格、在读去图书馆
  assert(today.indexOf("emit('navigate', 'dream')") >= 0, '目标行没跳梦想页');
  assert(today.indexOf("emit('open-cell', 'work')") >= 0, '本周推进没跳工作格');
  assert(today.indexOf("emit('navigate', 'reading')") >= 0, '在读没跳图书馆');

  // ② 证据派生：只认有日期的事实，窗口常量单点
  assert(dream.indexOf('const EVIDENCE_DAYS = 30') >= 0, '证据窗口不是单点常量');
  assert(dream.indexOf('evidence: evidence') >= 0, 'board 没派生 evidence');
  assert(dream.indexOf('evidenceCount') >= 0 && dream.indexOf('staleCount') >= 0, 'stats 缺在推/挂着计数');
  assert(dream.indexOf('evidenceDays: EVIDENCE_DAYS') >= 0, 'board 没把窗口天数交给界面');
  assert(dream.indexOf('doneAt') >= 0 && dream.indexOf('inWindow(') >= 0, '证据没按完成时间判断');
  // 证据是派生，不许反写进状态：normalizeDream 里不该出现 evidence 字段
  const normPart = dream.slice(dream.indexOf('function normalizeDream'), dream.indexOf('function normalize('));
  assert(normPart.indexOf('evidence') < 0, '证据被写进了领域状态（应只派生）');

  // ③ 成效侧指标：白名单四类 + 汇总 available + 前端区分「没有」与「0」
  ['outcome_task_done', 'outcome_dream_move', 'outcome_read_move', 'outcome_review'].forEach(function (k) {
    assert(metrics.indexOf(k) >= 0, '指标白名单缺：' + k);
  });
  assert(metrics.indexOf('available: outcomeEvents > 0') >= 0, '汇总没给 available，界面只能靠 0 猜');
  assert(api.indexOf('function outcomeEvent') >= 0, '成效事件判定没集中在一处');
  assert(api.indexOf('patch.metric !== undefined') >= 0, '目标推进没按「键是否出现」判断');
  assert(dc.indexOf('成效侧') >= 0 && dc.indexOf('metrics.outcome.available') >= 0, '数据中心没接成效侧');
});

check('V3.9 练习反馈：卡点带年龄、错因只增不改、#行动 只读回显', function () {
  const g = read('src/growth/board.js');
  const rail = read('renderer-v2/src/components/context/StudyContext.vue');
  const view = read('renderer-v2/src/views/StudyView.vue');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');

  // ① 卡点必须有开始日，年龄才能算出来；窗口常量单点
  assert(g.indexOf('const BLOCKER_STALE_DAYS = 14') >= 0, '卡点阈值不是单点常量');
  assert(g.indexOf('blockerSince: blocker ? validDate(k.blockerSince)') >= 0, '卡点开始日没进 normalize');
  // 只有文本真变了才重置开始日——否则每次打开都显示「今天才开始卡」
  const blk = g.slice(g.indexOf('function setSkillBlocker'), g.indexOf('function clearSkillBlocker'));
  assert(blk.indexOf('if (next !== k.blocker)') >= 0, '重存同一句会重置卡点年龄');
  assert(blk.indexOf('clearSkillBlocker(s, id, today)') >= 0, '空文本没走「算过去」，会留个空卡点');
  // 清走必须留档（带 since），否则「上次怎么过的」查不到
  const clr = g.slice(g.indexOf('function clearSkillBlocker'), g.indexOf('function setSkillNextUp'));
  assert(clr.indexOf('k.cleared.push') >= 0 && clr.indexOf('since: k.blockerSince') >= 0, '清掉卡点没留档或没保住开始日');
  assert(g.indexOf('clearedRecent: k.cleared.slice(-3).reverse()') >= 0, 'board 没派生已解决卡点');

  // ② 错因是固定枚举，不是自由文本；attempts 只增不改
  assert(g.indexOf('const EXAM_CAUSES = [') >= 0, '错因没有固定枚举');
  assert(g.indexOf('attempts: normAttempts(e.attempts)') >= 0, 'attempts 没进 normalize');
  const retake = g.slice(g.indexOf('function retakeExam'), g.indexOf('// ---------- 技能学习'));
  assert(retake.indexOf('attempts') < 0, '重考把历史成绩一起清了');
  const setRes = g.slice(g.indexOf('function setExamResult'), g.indexOf('function setExamCauses'));
  assert(setRes.indexOf('e.attempts.push') >= 0, '记成绩没进历史');
  assert(setRes.indexOf('last.date === day') >= 0, '同日同分没去重，手滑点两下会变成考两次');
  // 补记错因单独一条路由：不重填分数、不新增作答
  assert(g.indexOf('function setExamCauses') >= 0, '缺「只存错因」的领域函数');
  const setC = g.slice(g.indexOf('function setExamCauses'), g.indexOf('function retakeExam'));
  assert(setC.indexOf('e.attempts') >= 0 && setC.indexOf('push') < 0, '补记错因不该新增一条作答');

  // ③ 领域接线：新函数都进白名单与主进程路由
  ['growth.setSkillBlocker', 'growth.clearSkillBlocker', 'growth.setSkillNextUp', 'growth.setExamCauses'].forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, '领域白名单漏了：' + n);
    assert(main.indexOf("'" + n + "'") >= 0, '主进程漏了路由：' + n);
  });

  // ④ 右栏：卡点/下次/错因都在选中项详情里，写调用钉住 sel.id
  assert(rail.indexOf('练习卡点') >= 0 && rail.indexOf('下次练，提高一点什么') >= 0, '右栏缺卡点或「下次提高」');
  assert(rail.indexOf("callDomain('growth.setSkillBlocker', null, skill.value.id") >= 0, '卡点没按选中项写');
  assert(rail.indexOf("callDomain('growth.clearSkillBlocker', null, skill.value.id") >= 0, '清卡点没按选中项写');
  assert(rail.indexOf('gc-cause-on') >= 0 && rail.indexOf('只存错因') >= 0, '右栏缺错因勾选或补记入口');
  assert(rail.indexOf('历次最常错') >= 0, '右栏没把跨次错因摆出来');
  // #行动 回显：走已有 notes 路由 + 已有标签，只读
  assert(rail.indexOf("callDomain<NoteBoard | null>('reading.notes', null, { tag: '行动' })") >= 0, '#行动 回显没接已有笔记查询');
  assert(rail.indexOf('阅读里的行动') >= 0, '缺「阅读里的行动」卡');
  ['reading.addNote', 'reading.updateNote', 'reading.removeNote'].forEach(function (n) {
    assert(rail.indexOf("'" + n + "'") < 0, '回显卡越权写笔记：' + n);
  });

  // ⑤ 中栏行内信号：卡点天数与未过次数可见，但不挤掉等级/本周
  assert(view.indexOf('s.blockerText') >= 0 && view.indexOf('g-badge-on') >= 0, '中栏技能行没显示卡点天数');
  assert(view.indexOf('e.failCount') >= 0, '中栏考试行没显示未过次数');
  assert(view.indexOf('{{ s.levelText }}') >= 0, '为了塞卡点把等级/本周挤掉了');
});

check('V3.10 跨期对照：只摆事实不判定 / 一条只读路由 / 老 source 兼容', function () {
  const rv = read('renderer-v2/src/components/ReviewView.vue');
  const cross = read('src/review/cross.js');
  const api = read('src/core/api-layer.js');
  const main = read('src/main/main-v2.js');

  // ① 纯模块：不碰存储、不碰文件、不引第三方——对照是算出来的，不是查出来的
  ['require(', 'fs.', 'store', 'readFileSync'].forEach(function (w) {
    assert(cross.indexOf(w) < 0, '跨期对照模块里出现了 IO：' + w);
  });
  assert(cross.indexOf('function samePromise') >= 0 && cross.indexOf('MIN_PROMISE') >= 0,
    '同一句判定没有下限，短句会被误判');

  // ② 三种下落分开表达，缺一种就会把「没痕迹」说成「没做到」
  ['rv-cross-done', 'rv-cross-open', 'rv-cross-none'].forEach(function (c) {
    assert(rv.indexOf("'" + c + "'") >= 0 || rv.indexOf(c) >= 0, '缺一种下落样式：' + c);
  });
  assert(rv.indexOf('没有痕迹，不等于没做到') >= 0, '「没落成」被写成了「没做到」');
  assert(rv.indexOf('没勾掉不等于没做到') >= 0, '「还没动」被写成了「没做到」');
  assert(rv.indexOf('不替你打勾') >= 0, '上一轮守住的口径被删了');
  // 反例钉住：不许退回模糊相似度（一个字不同就是不同说法，系统不替人联想）
  assert(cross.indexOf('为什么不做文本相似度') >= 0, '「为什么不做模糊比对」的依据被删了');
  assert(cross.indexOf('模糊相似度算法') < 0, '别把模糊相似度塞回来');

  // ③ 卡里不许有写调用：对照卡只读，写操作仍只在 pushAct 那一处
  const cardStart = rv.indexOf('class="card rv-prev rv-cross"');
  const cardEnd = rv.indexOf('rv-q-title');
  assert(cardStart > 0 && cardEnd > cardStart, '找不到跨期对照卡的范围');
  const card = rv.slice(cardStart, cardEnd);
  ['callDomain', '@click', 'v-model'].forEach(function (w) {
    assert(card.indexOf(w) < 0, '跨期对照卡里出现了写入口：' + w);
  });
  assert((rv.match(/callDomain\('gtd\.add'/g) || []).length === 1, 'gtd.add 不该在别处再出现');

  // ④ 一条新路由，且只读；白名单与主进程同时登记
  assert(main.indexOf("'review.cross': function") >= 0, '主进程缺 review.cross');
  assert(api.indexOf("'review.cross'") >= 0, '白名单漏登记 review.cross');
  assert(rv.indexOf("callDomain<CrossView | null>('review.cross'") >= 0, '渲染层没接跨期对照');
  // 落成下一步时把周期键写进 source，下期才追得到；老任务靠 note 里的键兼容
  assert(rv.indexOf("source: 'review:' + period.value + ':' + reviewKey.value") >= 0, 'source 没带周期键');
  assert(cross.indexOf("src.indexOf('review') === 0 && str(t.note).indexOf(k) >= 0") >= 0,
    '老 source 的承诺没做兼容');

  // ⑤ 周期键仍由渲染层先算一份用于首屏标签，领域层算的那份为准
  assert(rv.indexOf('function prevReviewKey') >= 0, '首屏标签没退路了');
  assert(rv.indexOf('(c && c.prevLabel) ||') >= 0, '没有以领域层算的周期键为准');
});

check('V3.16 PDF 正文明晰：画布按 devicePixelRatio 出图 / 不被 CSS 拉伸 / 变形后重画', function () {
  const rd = read('renderer-v2/reader/reader.js');
  const css = read('renderer-v2/reader/reader.css');
  const fn = rd.slice(rd.indexOf('async function renderPdfPage'), rd.indexOf('function refreshPdfVisible'));

  // ① 位图按屏幕密度放大：PDF 走 canvas，没有矢量文本可用。
  //    1x 位图在 125%/150% 缩放的屏上只能被整幅上采样 —— 这就是「字发虚」的根。
  assert(fn.indexOf('window.devicePixelRatio') >= 0, 'PDF 画布没读 devicePixelRatio（位图还是 1x，缩放屏上必然发虚）');
  assert(fn.indexOf('Math.round(vp.width * dpr)') >= 0, '画布位图宽没按 dpr 放大');
  assert(fn.indexOf('Math.round(vp.height * dpr)') >= 0, '画布位图高没按 dpr 放大');
  assert(fn.indexOf('transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0]') >= 0,
    '渲染时没给 pdf.js 传缩放矩阵，位图放大了内容却没放大');

  // ② CSS 尺寸显式写死成逻辑像素：交给 width:100% 就是第二次重采样
  assert(fn.indexOf("cv.style.width = Math.floor(vp.width) + 'px'") >= 0, '画布没写死 CSS 宽（会被样式拉伸）');
  assert(fn.indexOf("cv.style.height = Math.floor(vp.height) + 'px'") >= 0, '画布没写死 CSS 高');
  assert(css.indexOf('.rr-pdf-page canvas { display: block; max-width: 100%; height: auto; }') >= 0,
    'PDF 画布的样式又变回拉伸型（width:100%）');

  // ③ 宽度取容器真实宽。曾经的 320 下限：窗口一窄，画布比容器宽，再被 max-width 压回去 → 又糊
  assert(fn.indexOf('const w = cw > 0 ? cw : 320') >= 0, '画布宽度没取容器真实宽（下限兜底会把小窗的画布拉宽再压缩）');

  // ④ 窗口变形 / 换屏：画布有固有尺寸，宽度或 dpr 变了必须重画，不能靠 CSS 撑
  assert(fn.indexOf('box.dataset.cssw') >= 0 && fn.indexOf('box.dataset.dpr') >= 0,
    '没记下每页是按多大宽度、多少倍密度画的，变形后无从判断是否过期');
  assert(rd.indexOf('function onPdfLayoutChange') >= 0, '缺窗口变形后的重画处理');
  assert(rd.indexOf("window.addEventListener('resize', onPdfLayoutChange)") >= 0, '窗口 resize 没接到 PDF 重画上');
  assert(rd.indexOf('Math.abs(b.clientWidth - cw) > 2') >= 0, '宽度变化小于阈值就没重画（差 2px 以上必须重画）');
  assert(rd.indexOf('function watchPdfDpr') >= 0, '没监听 dpr 变化（拖到另一块缩放不同的屏就糊）');
  assert(rd.indexOf("matchMedia('(resolution: ' + cur + 'dppx)')") >= 0, 'dpr 监听没按当前密度建 media query');

  // ⑤ 容器自己变窄，window resize 抓不到：滚动条一冒出来就吃掉 17px，
  //    已画好的画布被 max-width 压一次就是重采样（GUI 在 dpr=2 的环境里实测到的）
  assert(rd.indexOf('new ResizeObserver') >= 0, '没盯容器自身尺寸（滚动条出现 / 侧栏折叠都改宽度）');
  assert(rd.indexOf('pdfStageObserver.observe(pdfStage)') >= 0, 'ResizeObserver 没盯在 PDF 滚动区上');
  assert(css.indexOf('scrollbar-gutter: stable') >= 0,
    'PDF 滚动区没常驻滚动条槽位（首屏画完后宽度会跳 17px）');
});

check('V3.17 PDF 可选中可搜索：透明文本层 / 划选摘录 / 命中标黄 / 点结果跳到命中处', function () {
  const rd = read('renderer-v2/reader/reader.js');
  const css = read('renderer-v2/reader/reader.css');
  const html = read('renderer-v2/reader/index.html');

  // ① 文本层：getTextContent 的变换矩阵换算到页坐标，span 与画布同住一张「纸」
  assert(rd.indexOf('page.getTextContent()') >= 0, '没取 PDF 的文字内容');
  assert(rd.indexOf('function buildPdfTextLayer') >= 0, '缺文本层构建函数');
  assert(rd.indexOf('function pdfMatMul') >= 0, '没把 PDF 变换矩阵换算到页坐标');
  assert(rd.indexOf("mk('div', 'rr-pdf-text')") >= 0, '文本层类名不见了');
  assert(rd.indexOf("mk('div', 'rr-pdf-sheet')") >= 0, '画布与文本层没共用定位容器（缩放会错开）');
  assert(rd.indexOf('sheet.appendChild(layer)') >= 0, '文本层没挂在画布同一张纸上');
  assert(rd.indexOf('box.__pdfText') >= 0, '没记下页内纯文本（搜索偏移 / 锚点 / 摘录都用同一份）');

  // ② 文本层样式：透明文字才不会与画布重影，但划选要有可见底色
  assert(css.indexOf('.rr-pdf-text {') >= 0, '缺文本层样式');
  assert(css.indexOf('user-select: text') >= 0, '文本层不许选中');
  assert(css.indexOf('color: transparent') >= 0, '文字没透明（会与画布叠出重影）');
  assert(css.indexOf('.rr-pdf-text ::selection') >= 0, '划选时没有可见底色');
  assert(css.indexOf('.rr-pdf-text span.rr-pdf-hit') >= 0, '搜索命中没标黄');
  assert(css.indexOf('.rr-pdf-text span.rr-pdf-mark') >= 0, '划选标注没颜色');

  // ③ 选区链路：PDF 住在本窗口，不能照搬 iframe 的 getSelection / 坐标
  assert(rd.indexOf('function currentPdfSelection') >= 0, 'PDF 没有自己的选区读取');
  assert(rd.indexOf('if (isPdf) return currentPdfSelection();') >= 0, 'currentSelection 没分流到 PDF');
  assert(rd.indexOf('function pdfOffsetAt') >= 0, '没把选区换算成页内字符偏移');
  assert(rd.indexOf('function clearReaderSelection') >= 0, '清选区还写死在 iframe 上');
  assert(rd.indexOf("document.addEventListener('mouseup'") >= 0, '主文档没挂 PDF 划选监听');
  assert(rd.indexOf('if (isPdf) {\n    x = s.rect.left - stageRect.left;') >= 0,
    '工具条定位没区分「本窗口坐标」与「iframe 坐标」');

  // ④ 复制 / 摘录：划选之后要有两条最短路把原文带出去、带进笔记
  assert(html.indexOf('data-act="copy"') >= 0, '选区工具条没有「复制」');
  assert(html.indexOf('data-act="quote"') >= 0, '选区工具条没有「摘录」');
  assert(rd.indexOf('function copySelectionText') >= 0, '缺复制实现');
  assert(rd.indexOf('function saveQuoteFromSelection') >= 0, '缺摘录实现');
  assert(rd.indexOf("anchor: ch + ':' + s.start + '-' + s.end") >= 0, '摘录没带页内锚点');

  // ⑤ 搜索：不再只扫前 200 页；命中区间画到文本层，点结果滚到那一处
  assert(rd.indexOf('Math.min(pdfPages, 200)') < 0, '搜索还剩「只扫前 200 页」的硬上限');
  assert(rd.indexOf('p <= pdfPages') >= 0, '搜索没扫全书');
  assert(rd.indexOf('pdfHitRanges') >= 0, '没记命中区间');
  assert(rd.indexOf('function paintPdfHits') >= 0, '命中没画到文本层');
  assert(rd.indexOf('function jumpPdfHit') >= 0, '点结果只跳页、不定位到命中处');
  assert(rd.indexOf('rr-pdf-hit-on') >= 0, '点结果后没有点亮反馈');
  assert(rd.indexOf('pdfSearchToken') >= 0, '连续发起两次搜索时旧结果会覆盖新的');

  // ⑥ 顺手的两处：Ctrl+F 落到书内搜索；标注在页重画后还原
  assert(rd.indexOf("e.key === 'f' || e.key === 'F'") >= 0, 'Ctrl+F 没落到书内搜索');
  assert(rd.indexOf('if (isPdf) { paintPdfMarks(); return; }') >= 0, 'PDF 标注还原没接上文本层');
});

// ------------------------------------------------------------
// P2（2026-11-16）：虚拟书架 / 书目清单 / 目录口径 / 书库根目录
// ------------------------------------------------------------
check('P2-1 虚拟书架：标签是书上的字段，规则集合只派生 id，不另建表', function () {
  const board = read('src/reading/board.js');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const lib = read('renderer-v2/src/views/LibraryWindow.vue');
  const rv = read('renderer-v2/src/views/ReadingView.vue');

  // 标签挂在书上（多值），归一化沿用笔记那套 normTags —— 一套标签规则不写两遍
  assert(/tags:\s*normTags\(o\.tags\)/.test(board), '书籍没有多值标签字段，或没走统一归一化');
  assert(board.indexOf('if (!t || b.tags.length >= MAX_TAGS') >= 0, '加标签没守 8 个上限');
  // 规则集合必须是派生：只给 id 列表，绝不复制书籍记录
  assert(board.indexOf('shelves: shelves.slice(') >= 0, 'board 没有返回虚拟书架');
  assert(/ids:\s*ids\s*\}/.test(board), '规则集合没带 id 列表（界面就拿不到成员）');
  ['reading.setBookTags', 'reading.addBookTag', 'reading.removeBookTag'].forEach(function (n) {
    assert(api.indexOf("'" + n + "'") >= 0, '标签写通道没过白名单：' + n);
    assert(main.indexOf("'" + n + "'") >= 0, '标签写通道没接线：' + n);
  });
  // 界面：左栏两级（规则 + 标签）、中栏按 id 筛、筛选态可取消
  assert(lib.indexOf('虚拟书架') >= 0, '左栏没有虚拟书架节点');
  assert(lib.indexOf('ruleShelves') >= 0 && lib.indexOf('tagShelves') >= 0, '左栏没分成「规则」与「标签」两组');
  assert(lib.indexOf("kind: 'shelf'") >= 0 && lib.indexOf('shelfKey') >= 0, '左栏没把虚拟书架接到 scope 上');
  assert(rv.indexOf('shelfFilter') >= 0, '中栏没有虚拟书架筛选');
  assert(rv.indexOf('clearShelfFilter') >= 0, '中栏的虚拟书架筛选没法取消');
  // 标签编辑入口在右栏（LibraryWindow），不在阅读器里各写一份
  assert(lib.indexOf('@keydown.enter.prevent="addTag"') >= 0, '右栏没有加标签的入口');
  assert(lib.indexOf('dropTag(t)') >= 0, '右栏没法去掉标签');
});

check('P2-2 书目清单：三种格式共用一张行表，只出元数据与路径', function () {
  const board = read('src/reading/board.js');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const lib = read('renderer-v2/src/views/LibraryWindow.vue');

  assert(board.indexOf('function listRows(') >= 0, '没有统一的清单行表（三种格式会各写一套）');
  ['json', 'opds'].forEach(function (f) {
    assert(board.indexOf("'" + f + "'") >= 0, '导出缺格式：' + f);
  });
  // 三种格式都从 rows 出发，且行表里不含任何笔记正文
  assert(board.indexOf('const rows = listRows(s)') >= 0, '导出没从统一行表出发');
  assert(board.indexOf('function listRows') >= 0 && board.indexOf('noteCount: noteCount[b.id]') >= 0,
    '行表没带笔记数（却可能去数正文）');
  // CSV 必须带 BOM（Excel 打开中文不乱码），JSON 要自证「不含正文」
  assert(board.indexOf("'\\ufeff' + header") >= 0, 'CSV 没带 UTF-8 BOM');
  assert(board.indexOf('只含书目元数据与路径，不含书籍正文') >= 0, 'JSON 没写清这份清单不含正文');
  // OPDS 只给真有的文件挂 acquisition 链接
  assert(board.indexOf('http://opds-spec.org/acquisition') >= 0, 'OPDS 缺 acquisition 链接');
  assert(board.indexOf("r.filePath\n                ? '    <link rel=\"http://opds-spec.org/acquisition\"") >= 0,
    '没有文件的书也挂了打不开的链接');
  // 通道与落盘
  assert(api.indexOf("'reading.exportList'") >= 0 && main.indexOf("'reading.exportList'") >= 0, '清单导出通道没接上');
  assert(lib.indexOf('reading.exportList') >= 0, '界面没接清单导出');
});

check('P2-3 目录口径：自填章节与书内目录分开，只靠 ch-<节序> 对齐', function () {
  const board = read('src/reading/board.js');
  const rd = read('renderer-v2/reader/reader.js');
  const rv = read('renderer-v2/src/views/ReadingView.vue');

  assert(board.indexOf('anchor: normChapterAnchor(o.anchor)') >= 0, '章节没有锚点字段');
  assert(/function normChapterAnchor[\s\S]{0,200}ch-/.test(board), '锚点没统一成 ch-<节序>');
  assert(board.indexOf('anchor: p.anchor') >= 0, '新增章节时锚点进不去');
  // 阅读窗：我的大纲与书自带目录分成两段渲染，各自独立
  assert(rd.indexOf('myOutline') >= 0, '阅读窗没有接「我的大纲」');
  assert(rd.indexOf('我的大纲') >= 0 && rd.indexOf('书里的目录') >= 0, '两套目录没有分开标注');
  assert(rd.indexOf("setAttribute('data-mine', '1')") >= 0, '我的大纲条目没打标记');
  assert(rd.indexOf("getAttribute('data-mine') === '1'") >= 0, '我的大纲也会被当前章节高亮（两处高亮）');
  assert(rd.indexOf("domain('reading.read', [])") >= 0, '阅读窗没读章节表');
  // 界面：章节行能填/清「第几节」
  assert(rv.indexOf('setChapterAnchor') >= 0, '章节行没法锚定书内位置');
  assert(rv.indexOf("'ch-' + Math.trunc(n)") >= 0, '锚点没按 ch-<节序> 生成');
});

check('P2-4 书库根目录：根 + 相对路径，换机只改一条，删根不删书', function () {
  const board = read('src/reading/board.js');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');
  const lib = read('renderer-v2/src/views/LibraryWindow.vue');

  // 数据：roots 是表内一张表，books 上存 rootId + relPath
  assert(board.indexOf('roots: roots,') >= 0, 'normalize 没带上 roots');
  assert(board.indexOf('rootId: clean(o.rootId, ID_MAX)') >= 0, '书没有归属根字段');
  assert(board.indexOf('relPath: relPathOf(o.relPath)') >= 0, '书没有相对路径字段（存正斜杠的那半边）');
  // 路径解析只在 normalize 一处：① 现拼 ② 老库自动纳入
  assert(board.indexOf('b.filePath = joinRoot(root.path, b.relPath)') >= 0, '有根时没按 relPath 现拼绝对路径');
  assert(board.indexOf('const rel = underRoot(b.filePath, roots[i].path)') >= 0, '老书没自动纳入已登记的根');
  // 换机 = 改一条根，所有书跟着走；删根只解绑
  assert(/function relocateRoot[\s\S]{0,900}joinRoot\(path, b\.relPath\)/.test(board), '换根没有重算所有书的路径');
  assert(/function removeRoot[\s\S]{0,700}rootId: '', relPath: ''/.test(board), '删根没有解绑');
  assert(/function removeRoot[\s\S]{0,700}s\.books\.filter\(function \(r\)/.test(board) === false,
    '删根竟然过滤了 books（会丢书）');
  // rebuild 的 roots 一个都不能漏（漏一次整库的根就没了）。
  // 用「收尾形态」判：任何一次重建都不允许在 themes 处收尾，且必须有把它拼在末尾的调用。
  assert(board.indexOf('s.themes);') < 0, '有 rebuild 调用在 themes 处收尾，漏了 roots');
  const rooted = (board.match(/return rebuild\([^;]*?s\.themes, (s\.roots|roots)/g) || []).length;
  assert(rooted >= 20, '带 roots 的重建少于预期（写操作可能被回退）：' + rooted);
  assert(board.indexOf('s.themes.concat([raw]), s.roots') >= 0, '加书签的重建漏了 roots');
  assert(board.indexOf('s.themes, s.roots.concat([raw])') >= 0, '加根的重建没把自己写进去');
  // 通道
  ['reading.roots', 'reading.pickRoot', 'reading.addRoot', 'reading.relocateRoot', 'reading.removeRoot']
    .forEach(function (n) {
      assert(api.indexOf("'" + n + "'") >= 0, '书库根通道没过白名单：' + n);
      assert(main.indexOf("'" + n + "'") >= 0, '书库根通道没接线：' + n);
    });
  // 主进程落库前必须验目录：否则整库路径会一起指到空气里
  assert(/reading\.relocateRoot[\s\S]{0,700}fs\.statSync\(dir\)\.isDirectory\(\)/.test(main), '换根没验目录存在');
  assert(lib.indexOf('书库根') >= 0 && lib.indexOf('relocateRootDir') >= 0, '左栏没有书库根那一块');
});

// 2026-11-16 实测踩坑：LibraryWindow 里一条注释开头写 <!--、结尾写成 */，
// 注释永远不闭合，把后面 23 行（含反向关联卡整块）吞成注释节点。
// 编译不报错、类型检查不报错、页面只是「少了一块」，只有 asar 探针在打包后才抓到。
// 这条门禁把问题提前到 view:check：模板注释必须成对，且注释体内不许出现 C 风格结尾。
check('模板注释成对闭合：<!-- 配 -->，注释体内不出现 */（写错会整块静默不渲染）', function () {
  const bad = [];
  function scan(label, body) {
    const open = (body.match(/<!--/g) || []).length;
    const close = (body.match(/-->/g) || []).length;
    if (open !== close) { bad.push(label + '（<!-- ' + open + ' 个 / --> ' + close + ' 个）'); return; }
    const re = /<!--([\s\S]*?)-->/g;
    let m;
    while ((m = re.exec(body))) {
      if (m[1].indexOf('*/') >= 0) { bad.push(label + '（注释体内出现 */）'); return; }
    }
  }
  allVue().forEach(function (f) {
    const t = fs.readFileSync(f, 'utf8');
    const m = t.match(/<template>([\s\S]*)<\/template>/);
    if (m) scan(path.relative(root, f), m[1]);
  });
  ['renderer-v2/index.html', 'renderer-v2/finance.html', 'renderer-v2/library.html', 'renderer-v2/reader/index.html'].forEach(function (rel) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) scan(rel, fs.readFileSync(p, 'utf8'));
  });
  assert(bad.length === 0, '注释写错会让整块 UI 静默消失：' + bad.join('；'));
});

check('2026-11-16 扩展：休闲页 / 关系右栏 / 农历纪念日 / 九格事项回写', function () {
  const app = read('renderer-v2/src/App.vue');
  const types = read('renderer-v2/src/types.ts');
  const leisure = read('renderer-v2/src/views/LeisureView.vue');
  const digest = read('renderer-v2/src/composables/readingDigest.ts');
  const reader = read('renderer-v2/reader/reader.js');
  const relView = read('renderer-v2/src/views/RelationView.vue');
  const relCtx = read('renderer-v2/src/components/context/RelationContext.vue');
  const panel = read('renderer-v2/src/components/ContextPanel.vue');
  const famCtx = read('renderer-v2/src/components/context/FamilyContext.vue');
  const famBoard = read('src/family/board.js');
  const lunar = read('src/family/lunar.js');
  const reminder = read('renderer-v2/src/components/FamilyReminder.vue');
  const grid = read('renderer-v2/src/components/GridEditor.vue');
  const main = read('src/main/main-v2.js');
  const api = read('src/core/api-layer.js');

  // 第 7 格：专属页 + 当日阅读账（时长仍只在本机，不进 md_reading）
  assert(types.indexOf("| 'leisure'") >= 0, 'ViewKey 缺休闲娱乐专属页');
  assert(/if \(key === 'dream'\) \{ navigate\('leisure'\); return; \}/.test(app), '第 7 格未直通休闲页');
  assert(leisure.indexOf('CellRecordEditor') >= 0 && leisure.indexOf("cell-key=\"dream\"") >= 0,
    '休闲页主栏没写回 cells.dream');
  assert(leisure.indexOf('reading.notes') >= 0 && digest.indexOf('jiuge-reader-day:') >= 0,
    '休闲页没接当日笔记或阅读账');
  assert(reader.indexOf("DAY_TIME_KEY = 'jiuge-reader-day:'") >= 0, '阅读窗没有按天记账');
  assert(panel.indexOf('LeisureContext') >= 0, '右栏未接休闲阅读上下文');

  // 关系经营：通讯录整块退到右栏，主栏留记录窗口
  assert(relView.indexOf('CellRecordEditor') >= 0 && relView.indexOf("cell-key=\"relation\"") >= 0,
    '关系经营主栏缺记录窗口');
  assert(relView.indexOf('class="rel-book"') < 0, '通讯录还占着主栏');
  assert(relCtx.indexOf('rel-ctx') >= 0 && relCtx.indexOf('relation.addContact') >= 0,
    '右栏通讯录未接登记路由');
  assert(panel.indexOf('RelationContext') >= 0, '右栏未接 RelationContext');

  // 家庭亲子：登记与农历退到右栏，主栏写正文
  assert(famCtx.indexOf('calendarType') >= 0 && famCtx.indexOf('anniversaryOn') >= 0,
    '右栏缺阳历/农历与纪念日开关');
  assert(require('fs').existsSync(path.join(root, 'src/family/lunar.js')), '缺农历换算模块');
  assert(lunar.indexOf('LUNAR_INFO') >= 0 && lunar.indexOf('lunarToSolar') >= 0, '农历表/换算函数缺失');
  assert(famBoard.indexOf('anniversariesOf') >= 0 && famBoard.indexOf('require(\'./lunar.js\')') >= 0,
    'family 领域层没接纪念日派生');
  assert(reminder.indexOf('family.board') >= 0 && app.indexOf('<FamilyReminder') >= 0,
    '纪念日全局轻提醒没接上');

  // 九格事项：source 回写位置 + 完成后原行标记 + 原始任务只读通道
  assert(grid.indexOf('cell-task') >= 0 && grid.indexOf("'g9|'") >= 0,
    '九格没有事项按钮或回写来源串');
  assert(grid.indexOf('DONE_MARK') >= 0 && grid.indexOf('gtd.refs') >= 0,
    '完成标记或原始任务回读缺失');
  assert(main.indexOf("'gtd.refs'") >= 0 && api.indexOf("'gtd.refs'") >= 0,
    'gtd.refs 路由/白名单缺失');
});

console.log('');
console.log('========================================');
console.log('  PASS ' + passed + ' | FAIL ' + failed);
console.log('  说明：静态门禁，不替代 GUI 真断言 ≥30 / exe E2E ≥5');
console.log('========================================');
process.exitCode = failed > 0 ? 1 : 0;
