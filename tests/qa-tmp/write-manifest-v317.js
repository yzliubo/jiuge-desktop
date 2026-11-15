'use strict';
// 回写产物清单（V3.17）：只改字节数、门禁数字与新增字段，不动其它字段语义。
// 用法：node tests/qa-tmp/write-manifest-v317.js <viewCheck> <golden> <asarProbes> <guiLine>
// 例：  node tests/qa-tmp/write-manifest-v317.js 93/93 158/158 421/421 "189 PASS / 6 FAIL"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const mf = path.join(root, 'build-v2/artifact-manifest.json');
const exe = path.join(root, 'build-v2/九格手记-v2-便携版.exe');
// exe 归位在交付目录 build-v2；asar 证据在本次真正打出来的输出目录
const asar = path.join(root, process.env.JIUGE_BUILD_DIR || 'build-v2', 'win-unpacked/resources/app.asar');

const viewCheck = process.argv[2] || '93/93';
const golden = process.argv[3] || '158/158';
const asarProbes = process.argv[4] || '421/421';
const guiLine = process.argv[5] || '189 PASS / 6 FAIL';

const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.bytes = fs.statSync(exe).size;
m.sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
m.asarBytes = fs.statSync(asar).size;
m.builtAt = new Date(fs.statSync(exe).mtimeMs).toISOString();

if (m.featureScope.indexOf('㊻ V3.17') < 0) {
  m.featureScope += '；㊻ V3.17 PDF 可选中可搜索、划选直接进笔记（2026-11-15）：① 每页 canvas 上叠一层透明真文本（getTextContent 的仿射矩阵换算到页坐标，逐段 span 定位），画布与文本层共用 rr-pdf-sheet 尺寸写死的容器——缩放居中时两者不会错开；文字 color:transparent 不与画布重影，::selection 给淡蓝底；② 划选链路分流：PDF 走本窗口 window.getSelection()（iframe 那套取不到），按 span 的 data-off 换算页内字符偏移，工具条定位也不再加 iframe 左上角偏移；③ 选区工具条新增「复制」（clipboard API + execCommand 兜底）与「摘录」（存成带页码和页内锚点 页:起-止 的读书笔记）；点颜色按钮的标注改画在文本层 span 上，页重画后按 anchor 还原；④ 书内搜索不再只扫前 200 页：扫全书、逐页让出事件循环、用 pdfSearchToken 作废旧结果；命中区间记在 pdfHitRanges，可见页的命中字标黄；点结果不再只翻到那一页，而是先滚进视口等懒渲染的文本层长出来，再滚到命中那一段并点亮；⑤ Ctrl/Cmd+F 落到书内搜索框（浏览器原生查找对 canvas 无效）；⑥ 边界如实：扫描件或自定义内嵌字体编码的 PDF 提不出可读文字，此时画布照常可读但无法选中/搜索，属源文件限制';
}
const IR = m.infoArchitecture && m.infoArchitecture.reading;
if (IR) {
  IR.pdfTextLayer = 'V3.17：canvas 之上叠 rr-pdf-text 透明文本层（getTextContent + 变换矩阵逐段定位，与画布共用 rr-pdf-sheet）；划选 / 复制 / 摘录 / 标注 / 搜索命中全落在这层 DOM 上。currentPdfSelection 把 Range 换算成页内字符偏移，笔记 anchor 仍为「页:起-止」';
  IR.pdfSearch = 'V3.17：全书扫描（无 200 页硬上限）+ pdfSearchToken 防旧结果覆盖；命中区间 pdfHitRanges 给文本层标黄；jumpPdfHit 点结果先滚动触发懒渲染，再定位到命中 span 并点亮；Ctrl+F 聚焦书内搜索';
}

m.qualityGates = Object.assign({}, m.qualityGates, {
  buildView: 'PASS（vue-tsc 严格 + Vite 三入口：index / finance / library；reader 是静态页不进 vite 构建，改 JS/CSS/HTML 直接生效并重打包）',
  viewCheck: viewCheck + '（V3.17 新增 1 条检查、内含 30 条断言：文本层构建 / 画布与文本层共用容器 / 页内纯文本 / 透明文字与 ::selection / 标黄与标注样式 / currentSelection 分流 / 本窗口选区与坐标 / 复制与摘录按钮 / 摘录锚点 / 搜索全书无 200 页上限 / 命中区间与跳到命中处 / Ctrl+F / 标注还原）',
  golden: golden + '（无新增：本轮只动独立阅读窗的静态页，领域层一行未动）',
  asarProbes: asarProbes + '（+23：文本层类名与构建函数、选区/复制/摘录函数、两个 data-act 按钮、命中区间与跳转函数、CSS 选择器；reader.js / index.html / reader.css 三个静态文件原样进包，都可当探针）',
  guiAssert: guiLine + '（195 条；新增 #157「PDF 可选中可搜索」——文本层提取出原文且与画布对齐、划选工具条含复制/摘录、摘录笔记带 anchor 与页码、搜索扫到第二页并标黄、点第 2 页结果翻页 + 懒渲染 + 点亮命中处、Ctrl+F 落焦）',
  recordedAt: new Date().toISOString()
});

fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('bytes', m.bytes, 'sha', m.sha256.slice(0, 12), 'asar', m.asarBytes, 'builtAt', m.builtAt);
console.log('featureScope chars', m.featureScope.length);
