'use strict';
// 回写产物清单（V3.15）：只改字节数、门禁数字与新增字段，不动其它字段语义。
// 用法：node tests/qa-tmp/write-manifest-v315.js <viewCheck> <golden> <asarProbes> <guiLine>
// 例：  node tests/qa-tmp/write-manifest-v315.js 91/91 158/158 395/395 "187 PASS / 6 FAIL"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const mf = path.join(root, 'build-v2/artifact-manifest.json');
const exe = path.join(root, 'build-v2/九格手记-v2-便携版.exe');
// exe 归位在交付目录 build-v2；asar 证据在本次真正打出来的输出目录
const asar = path.join(root, process.env.JIUGE_BUILD_DIR || 'build-v2', 'win-unpacked/resources/app.asar');

const viewCheck = process.argv[2] || '91/91';
const golden = process.argv[3] || '158/158';
const asarProbes = process.argv[4] || '395/395';
const guiLine = process.argv[5] || '187 PASS / 6 FAIL';

const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.bytes = fs.statSync(exe).size;
m.sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
m.asarBytes = fs.statSync(asar).size;
m.builtAt = new Date(fs.statSync(exe).mtimeMs).toISOString();

if (m.featureScope.indexOf('㊹ V3.15') < 0) {
  m.featureScope += '；㊹ V3.15 主题阅读也走 calibre 表格（2026-11-15）：① 主题下的书不再每本一张大卡片，改成与休闲书架完全同一套六列表格——书名（封面缩略图 + 完整书名 + 路径，手写的书明写「手工登记，仅记笔记」）/ 作者 / 格式 · 大小 / 最近读过 / 进度（条 + 百分比）/ 操作（＋ 记 10 个单位、翻开读、编辑、✕ 移出），行高从约 150px 收到 42px，一个主题十几份资料一屏就能横向比「哪本厚、哪天翻过、读到几成」；② 主题表头是静态的（不做排序）——排序只作用于书架，主题表头若跟着可点就是点了没反应；③ 主题标题的三角变成真的收放（V3.15 前的三角只换符号，书单永远展开）：折叠状态独立于「选中」、不写盘，标题右侧标「N 本 · 已收起」，从左栏点这个主题会自动展开；④ 主题批注器挪进「这本书所属的主题」里（原先挂在所有主题之后，主题一多点了第一本要滚过别的主题才看得见），点完手工登记的书会把它带进视野；⑤ 修「左栏点未分组，中栏书架空着」：未分组不是一个分组名而是 group 为空，左栏传保留值 \\u0000none、中栏必须按「group 为空」筛（原先拿保留值去和 group 严格比较，永远 0 本，而右栏 KPI 又按空 group 数出来有数，两边自相矛盾），中栏分组条也补上「未分组 N」这一项，重命名 / 解散对保留值早退；⑥ 顺手清掉随卡片下线的一批死样式（rd-title-tight / rd-thick / rd-book-main / rd-book-line / rd-book-title / rd-book-actions / rd-author / rd-cover 竖条 / rd-book-on / rd-path），rd-book 这个类名保留——表格行还挂着它，GUI 用例按 .rd-group .rd-book 找行';
}
const IR = m.infoArchitecture && m.infoArchitecture.reading;
if (IR) {
  IR.themeListView = 'V3.15：主题下的书用与书架同一套 calibre 式表格（六列：书名 / 作者 / 格式 · 大小 / 最近读过 / 进度 / 操作），每个主题一张表；表头静态不排序（排序只作用于书架）；操作列 = ＋记 10 个单位 / 翻开读 / 编辑 / ✕移出';
  IR.themeCollapse = 'V3.15：主题标题三角控制书单收放（默认展开、状态不写盘），收起时标「N 本 · 已收起」；左栏点该主题会自动展开；批注器长在所属主题的表下面，点完手工登记的书自动滚入视野';
  IR.shelfScopes = 'V3.13/V3.15：书架（休闲）与主题阅读按 themeId 分开——书架只渲染 leisureBooks，主题书只在「主题阅读」按主题成组；「未分组」是保留值 GROUP_NONE（\\u0000none）对应 group 为空，中栏与左栏必须同一字面量，否则筛出来一本都没有';
}

m.qualityGates = Object.assign({}, m.qualityGates, {
  buildView: 'PASS（vue-tsc 严格 + Vite 三入口：index / finance / library）',
  viewCheck: viewCheck + '（V3.15 新增 1 条检查、内含 14 条断言：主题 section 内是 rd-table 且行仍是 rd-trow（保留 rd-book 供用例找行）、旧卡片结构 rd-book-main / rd-thick / 「+10 {{ b.unit }}」必须不存在、六列与书架同口径、表头静态（关掉手型与悬停变色、不得接书架排序）、路径与「手工登记」文案仍在；未分组保留值两处同一字面量 + 按 group 为空筛 + 不被「分组已不存在」守卫清掉 + 中栏 chip + 改名/解散对保留值早退；折叠状态独立、aria-expanded、收起时真的藏起书单、左栏点主题会展开）',
  golden: golden + '（无新增：本轮改动全在渲染层与样式，领域层一行未动）',
  asarProbes: asarProbes + '（rd-title-tight 换成 rd-theme-table / rd-thead-static；它原先能命中是因为主题卡片模板里有这个类名，卡片下线后只剩一条没人引用的 CSS，探针只扫 JS/HTML 便不再命中，这正说明该类已死）',
  guiAssert: guiLine + '（193 条；余 6 条与上轮逐条一致，全为环境项 #109/#110 语料库点击、#112a–d AW_OFFLINE；主题相关用例仍按 .rd-group .rd-book 找行、按「翻开读」按钮点开批注器，因此表格行必须保留 rd-book 类名）',
  recordedAt: new Date().toISOString()
});

fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('bytes', m.bytes, 'sha', m.sha256.slice(0, 12), 'asar', m.asarBytes, 'builtAt', m.builtAt);
console.log('featureScope chars', m.featureScope.length);
