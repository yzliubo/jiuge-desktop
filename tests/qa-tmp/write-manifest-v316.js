'use strict';
// 回写产物清单（V3.16）：只改字节数、门禁数字与新增字段，不动其它字段语义。
// 用法：node tests/qa-tmp/write-manifest-v316.js <viewCheck> <golden> <asarProbes> <guiLine>
// 例：  node tests/qa-tmp/write-manifest-v316.js 92/92 158/158 398/398 "188 PASS / 6 FAIL"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const mf = path.join(root, 'build-v2/artifact-manifest.json');
const exe = path.join(root, 'build-v2/九格手记-v2-便携版.exe');
// exe 归位在交付目录 build-v2；asar 证据在本次真正打出来的输出目录
const asar = path.join(root, process.env.JIUGE_BUILD_DIR || 'build-v2', 'win-unpacked/resources/app.asar');

const viewCheck = process.argv[2] || '92/92';
const golden = process.argv[3] || '158/158';
const asarProbes = process.argv[4] || '398/398';
const guiLine = process.argv[5] || '188 PASS / 6 FAIL';

const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.bytes = fs.statSync(exe).size;
m.sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
m.asarBytes = fs.statSync(asar).size;
m.builtAt = new Date(fs.statSync(exe).mtimeMs).toISOString();

if (m.featureScope.indexOf('㊺ V3.16') < 0) {
  m.featureScope += '；㊺ V3.16 PDF 正文不再发虚（2026-11-15）：① 画布位图改成按 window.devicePixelRatio 出图（位图宽高 = viewport × dpr，渲染时向 pdf.js 传 transform [dpr,0,0,dpr,0,0]），CSS 尺寸仍写死成逻辑像素——PDF 走 canvas、没有矢量文本可用，位图 1x 而屏幕 125%/150%/200% 时浏览器只能把整幅位图放大，正文笔画整体发灰发糊，这是「PDF 渲染字体很模糊」的根因；② 画布尺寸不再交给 CSS width:100% 拉伸（原来 floor 出的位图宽比容器窄不到 1px，被拉伸回去就是一次非整数重采样），改成 canvas.style.width/height 写死像素值；③ 去掉 160~320 那类宽底下限：窗口一窄画布比容器宽、再被 max-width 压回去，同样是一次重采样；④ 容器自身变形也要重画——加 window resize（阈值 2px）+ ResizeObserver 盯 PDF 滚动区 + matchMedia 监听 dpr 变化（窗口从一块屏拖到另一块缩放不同的屏），每页记下 data-cssw / data-dpr 判过期；⑤ PDF 滚动区常驻滚动条槽位（scrollbar-gutter: stable）——首屏画完后才冒出的滚动条会吃掉 17px，页容器跟着变窄，已画好的画布被压一次就是重采样（在 dpr=2 的 GUI 环境里实测到 bw/cw=2.05 才露出来）；⑥ GUI 新增 #156 直接量像素密度：位图宽/CSS 宽必须约等于 devicePixelRatio（±0.05），并把窗口调窄验证画布真的重画而不是被压小';
}
const IR = m.infoArchitecture && m.infoArchitecture.reading;
if (IR) {
  IR.pdfRenderDensity = 'V3.16：PDF 页画布按 devicePixelRatio 出位图（canvas.width = viewport.width × dpr，render 时 transform 同倍），CSS 尺寸写死为逻辑像素；容器宽变化 >2px 或 dpr 变化即重画（resize + ResizeObserver + matchMedia），滚动条槽位常驻；探针 tests/qa-tmp/probe-pdf-hidpi.js 量「位图/CSS = dpr」';
}

m.qualityGates = Object.assign({}, m.qualityGates, {
  buildView: 'PASS（vue-tsc 严格 + Vite 三入口：index / finance / library；reader 是静态页不进 vite 构建，改 JS/CSS 直接生效）',
  viewCheck: viewCheck + '（V3.16 新增 1 条检查、内含 15 条断言：renderPdfPage 必须读 devicePixelRatio 且位图宽高按 dpr 放大、render 传 transform 矩阵、canvas.style.width/height 写死像素、PDF 画布样式不得回到 width:100%（须 max-width:100%）、宽度取容器真实宽（不许 320 下限）、每页记 data-cssw/data-dpr、resize 阈值 2px、matchMedia 监听 dpr、ResizeObserver 盯滚动区、scrollbar-gutter: stable）',
  golden: golden + '（无新增：PDF 渲染在阅读窗静态页里，领域层一行未动）',
  asarProbes: asarProbes + '（+3：vp.width * dpr / vp.height * dpr / onPdfLayoutChange。刻意不用裸的 devicePixelRatio —— vendor/pdf.min.js 里本来就有这个词，探针会假通过）',
  guiAssert: guiLine + '（194 条；新增 #156「PDF 画布按屏幕密度出图」——位图宽/CSS 宽 ≈ devicePixelRatio、CSS 尺寸是写死像素、窗口调窄后画布重画而不是被压小；这条用例在 dpr=2 的测试环境里顺带暴露了滚动条挤窄容器的问题）',
  recordedAt: new Date().toISOString()
});

fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('bytes', m.bytes, 'sha', m.sha256.slice(0, 12), 'asar', m.asarBytes, 'builtAt', m.builtAt);
console.log('featureScope chars', m.featureScope.length);
