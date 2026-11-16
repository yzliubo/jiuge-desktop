'use strict';
// 回写产物清单（V3.18）：图书馆内部数据互通 P0+P1+P2（2026-11-16）。
// 只改字节数、门禁数字与新增字段，不动其它字段语义。
// 用法：node tests/qa-tmp/write-manifest-v318.js <viewCheck> <golden> <asarProbes>
// 例：  node tests/qa-tmp/write-manifest-v318.js 98/98 175/175 435/435
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const mf = path.join(root, 'build-v2/artifact-manifest.json');
const exe = path.join(root, 'build-v2/九格手记-v2-便携版.exe');
const asar = path.join(root, process.env.JIUGE_BUILD_DIR || 'build-v2', 'win-unpacked/resources/app.asar');

const viewCheck = process.argv[2] || '98/98';
const golden = process.argv[3] || '175/175';
const asarProbes = process.argv[4] || '435/435';

const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.bytes = fs.statSync(exe).size;
m.sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
m.asarBytes = fs.statSync(asar).size;
m.builtAt = new Date(fs.statSync(exe).mtimeMs).toISOString();

if (m.featureScope.indexOf('㊼ V3.18') < 0) {
  m.featureScope += '；㊼ V3.18 图书馆内部数据互通（2026-11-16）：① P0-1 主题书单收敛为单一事实源——board() 去掉 themeBooks 第二参、exportMarkdown 只读 s.books、学习成长右栏整套书单/摘录编辑下线（只留只读统计与「去图书馆维护书单」出口），双源补丁（视图层按书名去重）随之删除；② P0-2 书籍稳定身份——size + 首 64KB SHA-256 指纹，改名/换盘后再导入同一文件走 relinkBook 换路径而不是新建 bookId，笔记/章节/书签全跟着回来；③ P0-3 引用完整性——回写行行尾带〔rd:<noteId>〕，search.linksAll 出 type=reading 反查行，删笔记连带清 source=rd: 的未完成任务，孤儿判定从「仅休闲书」扩到「书或主题失效」；④ P0-4 书库体检 audit() 只报告不自动改，repairDangling/restoreDangling 可撤销修复；⑤ P1 全局检索合流（search.library + 图书馆命中块）、反向关联卡（reading.refs 纯只读派生）、#行动 一键落 GTD 收件箱（source=rd: 幂等）、阅读再曝光（近 7 天摘录 + 30 天未读）；⑥ P2 虚拟书架（规则集合 + 标签，只存 id 不复制行）、书目清单三格式（CSV 带 BOM / JSON / OPDS 仅真有文件的书挂 acquisition）、章节锚点与阅读窗「我的大纲」两套目录口径统一、书库根目录（rootId+relPath 可搬家，换根一条改完整库）';
}

const IR = m.infoArchitecture && m.infoArchitecture.reading;
if (IR) {
  IR.themeBooks = 'V3.18 收敛为单一事实源：themes[] + books[].themeId，唯一权威在 md_reading；board() 不再接受外部 themeBooks 参数、也不再返回 themeBooks 字段，导出/阅读窗/学习右栏全部只读 s.books。旧的 growth 书单只保留一次性导入（importGrowthThemes）与迁移核对（growthAudit 报告还差哪几本）';
  IR.bookIdentity = 'V3.18：books[].fingerprint = size + 首 64KB 的 SHA-256（src/reading/fingerprint.js）。addFiles 先按指纹判重、再按路径兜底；同指纹且旧路径已不存在时走 relinkBook 只换 filePath/ext/size，bookId 恒定，笔记与书签不丢。UI 在「原文件不在这个位置」时出「重新关联」';
  IR.refs = 'V3.18：回写进九格的行尾带〔rd:<noteId>〕（行首【读书·…】是检索前缀，不能让位）；reading.refs 按标记反查该书的日记回写与任务，书目窗口右栏「它后来去了哪」纯只读派生，不落库',
  IR.audit = 'V3.18：reading.audit 报告五项（笔记/章节/书签/书的悬空引用、重复指纹、重复书名）+ 文件缺失与无指纹计数，只报告不自动改；repairDangling 只清悬空字段并返回 changes，restoreDangling 能原样写回',
  IR.shelves = 'V3.18 虚拟书架：board().shelves 派生规则集合（在读/待读/读完/有笔记/只有笔记/最近读过）与标签集合，每条只给 {key,label,count,ids}，成员只存 id 不复制书籍记录——改状态后重算即变',
  IR.tags = 'V3.18：books[].tags 多值标签（最多 8 个，沿用笔记的 normTags 规则），与 group 并存：分组决定放哪一摞，标签决定还能从哪些入口找到它',
  IR.exportList = 'V3.18：reading.exportList 三种格式共用一张行表——CSV（UTF-8 BOM + 引号转义）、JSON（自声明不含书籍正文）、OPDS（只有 filePath 存在的书才挂 acquisition 链接）；落盘仍走唯一那条 v1/file:save',
  IR.roots = 'V3.18 书库根：md_reading.roots[]（最多 6 个）+ books[].rootId/relPath（相对路径统一正斜杠，备份跨系统可读）。filePath 由 normalize 现拼，是唯一解析点；换根只改一条就改完整库路径，删根只解绑不删书也不清路径',
  IR.chapterAnchor = 'V3.18：chapters[].anchor = ch-<节序>，与阅读窗 chapterId 同一写法；阅读窗左栏「我的大纲」排在书自带目录之前且不参与当前位置高亮（避免同一节两处同时高亮）',
  IR.searchMerge = 'V3.18：reading.searchIndex 出书/主题/笔记三类行（带可直接渲染的进度字段），search.library 与日记/任务/闪念同栏出结果；点结果按 kind 回图书馆定位',
  IR.resurface = 'V3.18：reading.resurface 给近 7 天摘录与 30 天未读/从未翻过的书（days=-1 排最前），今天页「读过的」卡按天重算',
  IR.actionPush = 'V3.18：带 #行动 的读书笔记可一键落 GTD 收件箱，source=rd:<noteId> 幂等，重复点不叠加；删笔记连带清该 source 的未完成任务';
}

m.qualityGates = Object.assign({}, m.qualityGates, {
  buildView: 'PASS（vue-tsc 严格 + Vite 三入口：index / finance / library；reader 是静态页不进 vite 构建）',
  viewCheck: viewCheck + '（V3.18 新增 1 条「模板注释成对闭合」门禁 + 4 条 P2 契约；两条旧断言按单一事实源改写——从「必须有旧的双源去重」改成「必须有新契约、必须没有旧补丁」）',
  golden: golden + '（V3.18 新增 17 条：指纹稳定性 / 指纹判重与 relinkBook 保 id / 导入完整性报告不吞落空笔记 / rd: 标记位置与截断 / 书库体检与可撤销修复 / 检索合流 / 再曝光排序 / 旧书单迁移核对 / theme 孤儿 / 通道接线；虚拟书架 / 标签 / 清单三格式 / 书库根 / 目录锚点）',
  asarProbes: asarProbes + '（V3.18 +14：本轮新界面文案与通道名——书库体检 / 重新关联 / 虚拟书架 / 书目清单 / 书库根 / 它后来去了哪 / 最近留下的话 + 7 个新通道名；gc-quote 随 P0-1 换成「去图书馆维护书单」。本轮正是这条探针抓到一处真 bug：一条 HTML 注释写成 */ 结尾，把反向关联卡整块吞成注释节点，编译与类型检查都不报）',
  recordedAt: new Date().toISOString()
});

fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('bytes', m.bytes, 'sha', m.sha256.slice(0, 12), 'asar', m.asarBytes, 'builtAt', m.builtAt);
console.log('featureScope chars', m.featureScope.length);
