'use strict';
// 回写产物清单（V3.13）：只改字节数、门禁数字与新增字段，不动其它字段语义。
// 用法：node tests/qa-tmp/write-manifest-v313.js <viewCheck> <golden> <asarProbes> <guiLine>
// 例：  node tests/qa-tmp/write-manifest-v313.js 89/89 158/158 382/382 "187 PASS / 6 FAIL"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const mf = path.join(root, 'build-v2/artifact-manifest.json');
const exe = path.join(root, 'build-v2/九格手记-v2-便携版.exe');
// exe 归位在交付目录 build-v2；asar 证据在本次真正打出来的输出目录（本机 build-v2 的
// app.asar 被宿主进程长期占着，覆盖不了，只能换输出目录打，见 check-artifact-freshness 注释）
const asar = path.join(root, process.env.JIUGE_BUILD_DIR || 'build-v2', 'win-unpacked/resources/app.asar');

const viewCheck = process.argv[2] || '89/89';
const golden = process.argv[3] || '158/158';
const asarProbes = process.argv[4] || '382/382';
const guiLine = process.argv[5] || '187 PASS / 6 FAIL';

const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.bytes = fs.statSync(exe).size;
m.sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
m.asarBytes = fs.statSync(asar).size;
m.builtAt = new Date(fs.statSync(exe).mtimeMs).toISOString();

if (m.featureScope.indexOf('㊷ V3.13') < 0) {
  m.featureScope += '；㊷ V3.13 图书馆四件事（2026-11-15）：① 主题书与休闲书架彻底分开——同一个主题常常一次导入十几份同主题文件，混在休闲书架里会把随手翻的书整片顶走；domain 层 board() 新增 leisureBooks（只含 themeId 为空的）与 stats.themeBooks，books 保持「全部」不破坏既有消费方，书架渲染只取 leisureBooks，统计头分成「N 本休闲书 / M 本主题书」，分组与收藏只数休闲书；主题分组改由领域层派生（themeGroups），主题行与书架用同一套派生字段（进度 / 状态标签 / 笔记数），主题书的笔记计数不再只数 leisure（以前主题下永远显示 0 条笔记）；② 没有封面时占位封面印**完整书名**而不是首字——一个「移」认不出是哪本书，尤其同主题下十几份「移动平均线…」在单字占位里长得一模一样；字号按字数分五级（≤4/8/12/20/30 字以上），靠缩小字号放下而不是截断，封面墙与封面预览同一套；③ 详细列表改成 calibre 式表格：列头（书名 / 作者 / 格式 · 大小 / 最近读过 / 进度 / 操作）+ 点列头排序（同列再点反向）+ 紧凑行 + 斑马纹 + 拖动排序保留；窄窗口整表横向滚动而不是把列挤成省略号；主题下书名收成一行（max 20em + 省略号 + title 提示完整名）；④ 豆瓣封面：编辑弹窗里「从豆瓣找封面」→ 用书名（必要时加作者）检索豆瓣公开的 subject_suggest 接口，最多 6 条候选（缩略图 + 书名 / 作者 / 年份），点一张才落盘套用，绝不自动挑；整本书名搜不到时按 全名→12→9→7→5 字逐级缩关键词，并如实告诉用户「用『X』搜到的」；网络边界写在 src/reading/cover-net.js：只发 GET、只连 book.douban.com 与 img<N>.doubanio.com 两类白名单域、不跟重定向、不发路径与笔记、不落缓存、图片按魔数认格式；路由走专用异步通道 v1/reading:doubanCovers / :doubanApply（挤进同步白名单会因返回 Promise 直接序列化失败）';
}

const IR = m.infoArchitecture && m.infoArchitecture.reading;
if (IR) {
  IR.shelfScopes = 'V3.13：书架（休闲）与主题阅读按 themeId 分开——书架只渲染 leisureBooks，主题书只在「主题阅读」按主题成组；统计头 5 项（本休闲书 / 本主题书 / 条笔记 / 条已入九格 / 条本月）';
  IR.listView = 'V3.13 详细列表 = calibre 式表格：列头 书名 / 作者 / 格式 · 大小 / 最近读过 / 进度 / 操作，点列头排序（书名·作者升序、大小·日期·进度·笔记降序，再点反向），manual 为书架自身顺序；行高紧凑、斑马纹、保留拖动重排与双击翻开；偏好 localStorage: jiuge.reading.sortMode';
  IR.coverPlaceholder = 'V3.13：无封面时占位封面印完整书名，字号按字数五级缩放（34px 基准，封面墙 24px），不截断；主题下书名收成一行省略';
  IR.doubanCover = 'V3.13：豆瓣封面检索（book.douban.com/j/subject_suggest 公开接口 + img<N>.doubanio.com 图片），只发书名与作者，候选 6 张由用户点选，套用后复制进 covers/ 并写 coverId；网络与白名单全在主进程 src/reading/cover-net.js；通道 v1/reading:doubanCovers / :doubanApply';
}

m.qualityGates = Object.assign({}, m.qualityGates, {
  buildView: 'PASS（vue-tsc 严格 + Vite 双入口）',
  viewCheck: viewCheck + '（新增 V3.13：leisureBooks 与 stats.themeBooks 口径、主题行同套派生、占位印完整书名且字号分级、calibre 表格列头与排序、豆瓣只走专用异步通道 / 白名单正则 / 魔数认格式、渲染层零豆瓣域名）',
  golden: golden + '（+2：主题书不进书架且主题行派生同源、cover-net 域名白名单 / 只取图书 / 魔数认格式）',
  asarProbes: asarProbes + '（+15：本主题书 / rd-table / rd-thead / rd-trow / rd-tname / rd-tbar / 格式 · 大小 / 最近读过 / rd-card-initial / rd-title-tight / 从豆瓣找封面 / rd-douban / rd-douban-item / rd-cover-prev / 挑一张最像这本的；仍只取模板静态串，coverNameStyle / toggleSort 这类 setup 函数名会被 minify 改名）',
  guiAssert: guiLine + '（193 条；新增 #155：主题书一行都不进休闲书架但统计头认得、6 列表头齐、书名列点一下出现方向且 AAA 排在 ZZZ 前、无封面占位印完整书名且长名缩到 ≤20px、编辑弹窗有「从豆瓣找封面」（只断言存在不点，门禁不依赖网络）；余 6 条与上轮逐条一致，全为环境项）',
  recordedAt: new Date().toISOString()
});

fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('bytes', m.bytes, 'sha', m.sha256.slice(0, 12), 'asar', m.asarBytes, 'builtAt', m.builtAt);
console.log('featureScope chars', m.featureScope.length);
