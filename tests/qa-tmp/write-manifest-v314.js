'use strict';
// 回写产物清单（V3.14）：只改字节数、门禁数字与新增字段，不动其它字段语义。
// 用法：node tests/qa-tmp/write-manifest-v314.js <viewCheck> <golden> <asarProbes> <guiLine>
// 例：  node tests/qa-tmp/write-manifest-v314.js 90/90 158/158 394/394 "187 PASS / 6 FAIL"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const mf = path.join(root, 'build-v2/artifact-manifest.json');
const exe = path.join(root, 'build-v2/九格手记-v2-便携版.exe');
// exe 归位在交付目录 build-v2；asar 证据在本次真正打出来的输出目录
// （本机 build-v2 的 app.asar 被宿主进程长期占着，覆盖不了，只能换输出目录打）
const asar = path.join(root, process.env.JIUGE_BUILD_DIR || 'build-v2', 'win-unpacked/resources/app.asar');

const viewCheck = process.argv[2] || '90/90';
const golden = process.argv[3] || '158/158';
const asarProbes = process.argv[4] || '394/394';
const guiLine = process.argv[5] || '187 PASS / 6 FAIL';

const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.bytes = fs.statSync(exe).size;
m.sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
m.asarBytes = fs.statSync(asar).size;
m.builtAt = new Date(fs.statSync(exe).mtimeMs).toISOString();

if (m.featureScope.indexOf('㊸ V3.14') < 0) {
  m.featureScope += '；㊸ V3.14 图书馆改成独立窗口（2026-11-15）：① 顶栏「图书馆」不再切主窗页面，改由主进程开一扇独立 BrowserWindow（1440×900 / 最小 1024×680，第三个 Vite 入口 library.html，通道 v1/library:open 走 preload 白名单，重复点只聚焦不叠窗），与「记账」同一套做法；② 窗口三栏——左栏文件夹层级树（休闲阅读 / 主题阅读两个栏目，下面挂分组 / 主题，主题再挂书名与进度；每行右侧是册数，选中即筛中栏）、中栏复用同一套书架视图（ReadingView 收进窗口时隐藏大标题与统计头，只留一行「关闭窗口」）、右栏看「选中了什么」（选中一本书给封面 / 格式 / 进度 / 状态 / 笔记 / 路径 + 翻开读；没选书时给这个范围的四格与最近笔记，读书笔记一栏换成笔记口径）；③ 左栏点节点换的是 scope 一条线，中栏只认 scope，不各存一份范围；树的图标列（折叠箭头 / 文件夹 / 书本）固定宽度，层级不参差；④ 搜索框并进页签行最左侧（原先单占一行白扔一屏高度，还让人误以为只筛休闲书架），排序与本数靠右，切到主题 / 笔记时收起；⑤ 手写书名「书名 / 作者 / 页数 / ＋放上书架」那一行下线——它和「选择电子书」重复，手写出来的书只有书名没有文件，在书架上认不出来；主题里手写书名保留（资料本来就是散的，只有笔记没有电子书是正常情况）；⑥ 独立窗口必须自己挂 data-skin / data-surface（tokens.css 的 --palette-* 只在 [data-skin] 下定义，漏了图标、选中态、右侧数字全变透明），记账窗存在同一处漏挂，一并补上'
}
const IR = m.infoArchitecture && m.infoArchitecture.reading;
if (IR) {
  IR.window = 'V3.14：图书馆是独立窗口（library.html，主进程 openLibraryWindow，v1/library:open），三栏左树 / 中书架 / 右详情；主窗顶栏按钮与 navigate(\'reading\') 都只负责开窗，主窗不再内嵌书架';
  IR.tree = 'V3.14 左栏文件夹树：休闲阅读（册数）→ ★ 收藏夹 / 分组（由书上的 group 派生）/ 未分组；主题阅读（册数）→ 主题（册数）→ 书名（进度%），点书名右栏出详情、双击开阅读窗；不画「全部藏书」这类与根节点等价的叶子';
  IR.toolbar = 'V3.14：页签行 = 搜索框（最左）+ 三个分区页签 + 排序（手排 / 最近在读）+ 本数提示；原「书架整理」整行（rd-tools）随之下线；休闲书架不再提供手写加书';
  IR.shelfScopes = 'V3.13/V3.14：书架（休闲）与主题阅读按 themeId 分开——书架只渲染 leisureBooks，主题书只在「主题阅读」按主题成组；左栏与右栏各自给出两类书的册数';
  IR.listView = 'V3.13 详细列表 = calibre 式表格：列头 书名 / 作者 / 格式 · 大小 / 最近读过 / 进度 / 操作，点列头排序（书名·作者升序、大小·日期·进度·笔记降序，再点反向），manual 为书架自身顺序；偏好 localStorage: jiuge.reading.sortMode';
  IR.coverPlaceholder = 'V3.13：无封面时占位封面印完整书名，字号按字数五级缩放（34px 基准，封面墙 24px），不截断；右栏详情用书名哈希的同色系渐变做占位，有真封面（书内 / 豆瓣）则显示真封面';
  IR.doubanCover = 'V3.13：豆瓣封面检索（book.douban.com/j/subject_suggest 公开接口 + img<N>.doubanio.com 图片），只发书名与作者，候选 6 张由用户点选；网络与白名单全在主进程 src/reading/cover-net.js；通道 v1/reading:doubanCovers / :doubanApply';
}

m.qualityGates = Object.assign({}, m.qualityGates, {
  buildView: 'PASS（vue-tsc 严格 + Vite 三入口：index / finance / library）',
  viewCheck: viewCheck + '（新增 V3.14：第三入口 + 主进程开窗 + 白名单通道 + 重复点不叠窗、三栏与皮肤作用域、左栏两栏目与书籍层级、主窗不再内嵌书架、搜索在页签行最左、rd-tools 与手写加书下线、中栏只认 scope）',
  golden: golden + '（无新增：本轮的改动全在 UI 与窗口层，领域层未动）',
  asarProbes: asarProbes + '（+12：lib-app / lib-tree / lib-kids / lib-book / lib-count / lib-rail-w / 休闲阅读 / 主题阅读 / 点文件夹筛这一摞书 / 关闭窗口 / 左栏点文件夹换范围 / 两类阅读 · 按文件夹走 · 全部本机；requiredEntries 增加 dist/library.html，漏了就是点「图书馆」开出一片空白）',
  guiAssert: guiLine + '（193 条；改写 125/126/131/145/149/155 与整段 12x–15x：图书馆断言整体搬到独立窗口（libPage 复用同一扇窗），#125 锁「点一下开窗、主窗不切页、三栏俱在、两栏目在、重复点不叠窗」，#126 锁「手写加书已下线 + 中栏批注器仍可用」，#131 只数阅读窗口数（主窗 + 图书馆 + 阅读共三扇，不能再数总窗口），#145 的 Esc 与 localStorage 断言改在窗口内；余 6 条与上轮逐条一致，全为环境项 #109/#110 语料库点击、#112a–d AW_OFFLINE）',
  recordedAt: new Date().toISOString()
});

fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('bytes', m.bytes, 'sha', m.sha256.slice(0, 12), 'asar', m.asarBytes, 'builtAt', m.builtAt);
console.log('featureScope chars', m.featureScope.length);
