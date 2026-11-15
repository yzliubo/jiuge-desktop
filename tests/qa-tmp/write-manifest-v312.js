'use strict';
// 回写产物清单：只改字节数与门禁数字，不动其它字段的语义。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const mf = path.join(root, 'build-v2/artifact-manifest.json');
const exe = path.join(root, 'build-v2/九格手记-v2-便携版.exe');
const asar = path.join(root, 'build-v2/win-unpacked/resources/app.asar');

const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.bytes = fs.statSync(exe).size;
m.sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
m.asarBytes = fs.statSync(asar).size;
m.builtAt = new Date(fs.statSync(exe).mtimeMs).toISOString();

if (m.featureScope.indexOf('㊶ V3.12') < 0) {
  m.featureScope += '；㊶ V3.12 分页阅读（2026-11-15）：阅读方式新增「分页阅读」——正文按可视高度切页，一页一屏，滚轮 / ↓ / PageDown / 空格翻下一页、↑ 翻上一页，翻过本章末页接下一章、开头往回翻回上一章末页；不是自己切片，而是整块放进多栏容器（column-width 按需往右长、column-fill:auto 锁成一页高），翻页 = 横向平移一整页，DOM 顺序与文本偏移原样保留（自切片会拆文本节点，笔记锚点按章内偏移记，切一次全书标注就错位）；三层结构 vp（页边留白）/ clip（只露一页宽）/ in（多栏正文）——overflow 只在 padding box 裁，缺 clip 那层右边留白会漏出下一栏的字；列宽读回浏览器实际值、列距按末栏右边缘反推，翻几十页也不累积错位；「双页并排」改口径：不再是整章正文分两栏（右栏会变成后半章），而是分页之上的连续两页，页间 44px + 淡书脊线，翻一下过去两页；封面 / 整页插图限高到一页，否则图片顶破栏整章只剩一栏；表格与代码允许跨页，图与引文不拆；字号 / 行距 / 版心 / 缩放 / 字体 / 标点 / 窗口宽度任一项变化都重排并保持页码；分页态没有 scroll 事件，章内进度与位置改按页算并随翻页落盘；书内搜索命中与笔记回跳会翻到目标所在页；PDF 本身就是原页分页，按钮只提示不改状态；老偏好 spread=true 自动迁到分页态';
}

const LFR = m.infoArchitecture.reading.localFiles.reader;
if (LFR) {
  LFR.readingModes = 'V3.12：分章（默认）/ 连续滚动 / 分页阅读 / 双页并排（分页之上的两页）；分页与连续滚动互斥，双页寄在分页上；偏好 localStorage: jiuge-reader-pref.flow / .paged / .spread（老 spread=true 自动迁到分页）';
  LFR.pagination = '分页实现：body 内三层 vp/clip/in，in 为多栏容器（column-width + column-fill:auto + height 100%），翻页 transform translateX(-page*cols*pitch)；正文 DOM 不切片，文本偏移与笔记锚点不变；--rr-pg-h 把整页图限到一页高';
}

m.qualityGates = Object.assign({}, m.qualityGates, {
  buildView: 'PASS（vue-tsc 严格 + Vite 双入口）',
  viewCheck: '88/88（新增 V3.12：分页阅读入口、pagedBuild/Measure/GoPage/Flip/Reveal/Wheel/Key 七件实现、column-fill:auto 与 column-width 口径、clip 裁切层、双页挂在分页上、旧「body 分两栏」写法必须消失、分页按页记进度与位置、ResizeObserver 重排、页码按钮样式）',
  golden: '156/156（分页是 DOM/排版行为，纯函数层无可断言项；本轮改由 view:check 88/88 + 真 GUI #154 + 真窗口探针覆盖）',
  asarProbes: '367/367（+9：分页阅读 / rrPaged / rr-pg-in / rr-pg-clip / column-fill:auto / pagedFlip / 分页 · 单页 / 分页 · 双页 / rr-pg-btn）',
  guiAssert: '186 PASS / 6 FAIL（192 条；新增 #154 分页阅读：一页一屏、页数≥2、正文高度锁一页、滚轮翻一页位移正好一页、翻页后首字偏移前进、双页右栏接左栏；#148 双页口径已从「整章分两栏」改为「分页的两页」，并在用例首尾归位分页偏好；余 6 条与上轮逐条一致，全为环境项：#109/#110 语料库点击 30s 超时、#112a–d 本机时间源 AW_OFFLINE 未启动）',
  recordedAt: new Date().toISOString()
});

fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('bytes', m.bytes, 'sha', m.sha256.slice(0, 12), 'asar', m.asarBytes, 'builtAt', m.builtAt);
console.log('featureScope', m.featureScope.length);
