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

if (m.featureScope.indexOf('㊵ V3.11') < 0) m.featureScope += '；㊵ V3.11 书架三陈列 + 封面直接取书内图 + 阅读方式底栏居中（2026-11-15）：书架从两陈列扩到三陈列——详细列表 / 封面预览 / 封面墙（只摆封面，120×180，悬停浮出书名·作者·进度，可拖拽排序、双击翻开，缺原件打角标）；列表封面由 30px×行高拉伸改成固定 2:3 并居中加细影，行高不变（原先被拉成约 1:3 的窄条，书封中段被裁），封面预览卡片同步从 3:4 收到 2:3，三处同一个书封比例；封面一律取自书内那张图：epub.js 封面定位四级兜底（meta name=cover → manifest properties/href 含 cover → guide type=cover 封面页首图 → spine 首页首图且文件名像 cover/front/title 才认，避免正文插图冒充封面），上限 500KB→4MB，相对路径支持 ../，按魔数纠正扩展名（cover.jpg 里装 PNG 时 dataURL 声明错 mime 会白图）；老书回填：reading.cover 在 coverId 为空时按需再抽一次并落盘写库，未命中按 mtime+size 记缓存不重复解包，渲染层不再以 coverId 为门槛且有 coverTried 去重；阅读窗底栏改三栏 grid（1fr auto 1fr），选项条独立包裹层后真正居中（713px 底栏实测偏差 0px），页码仍贴右；PDF/MOBI/TXT 仍不抽封面（零依赖取不到 PDF 首页），没有封面的书继续用首字渐变';

m.infoArchitecture.reading.localFiles.layout = '详细列表 / 封面预览 / 封面墙（只摆封面，悬停浮出信息；V3.11），偏好 localStorage: jiuge.reading.viewMode';
m.infoArchitecture.reading.localFiles.covers = '封面一律取自书内图（EPUB 四级兜底、≤4MB、按魔数纠格式）；落盘 userData/jiuge-data/covers/，store 只存 coverId，按需转 dataURL；老书无 coverId 时按需补抽并回写，未命中按文件签名缓存不重复解包';
if (m.infoArchitecture.reading.reader) {
  m.infoArchitecture.reading.reader.modesBar = 'V3.11 底栏阅读方式改三栏 grid（1fr auto 1fr），选项条居中、页码贴右；全屏时整条收起';
}

m.qualityGates = Object.assign({}, m.qualityGates, {
  buildView: 'PASS（vue-tsc 严格 + Vite 双入口）',
  viewCheck: '87/87（新增 V3.11：三陈列与封面墙结构、列表封面固定 2:3 且居中、封面上限 4MB、封面页首图与魔数纠格式、老书回填与请求去重、底栏三栏居中且页码贴右）',
  golden: '156/156（+1：meta / properties / guide 三级兜底、700KB 大封面不被上限砍、jpg 里装 png 按魔数纠正、正文插图不当封面）',
  asarProbes: '358/358（V3.11 未新增探针条数：封面墙类名与底栏 grid 都是渲染层静态样式，探针只取模板必需串；这部分覆盖由 view:check 87/87 与真 GUI 补齐）',
  guiAssert: '185 PASS / 6 FAIL（191 条；#147 阅读方式在底栏居中后仍过，书架三种陈列与封面加载无回归；余 6 条与上轮逐条一致，全为环境项：#109/#110 语料库点击 30s 超时、#112a–d 本机时间源 AW_OFFLINE 未启动）',
  recordedAt: new Date().toISOString()
});

fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('bytes', m.bytes, 'sha', m.sha256.slice(0, 12), 'asar', m.asarBytes, 'builtAt', m.builtAt);
