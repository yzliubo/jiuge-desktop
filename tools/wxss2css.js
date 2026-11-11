'use strict';
/**
 * 移植期一次性离线脚本：WXSS → CSS（运行时无转换，架构 §1.6 / R2）。
 *
 *  - 机械替换 \d+rpx → px，比例 **1rpx = 0.5px**（对应小程序 375px 设计宽的 CSS 像素）；
 *  - 其余内容（150 个 --c-* 令牌、四套 .theme-* 同构块、注释、@keyframes、选择器）**逐字保留**；
 *  - @import 行注释化：改由 index.html 的 `<link>` 顺序加载，顺序等价；
 *  - 产物写入 src/renderer/styles/*.css 并入库，输出每个文件的替换计数；
 *  - 结束时自检产物里不得残留 rpx（§9.6-10 红线）。
 *
 * 用法：
 *   node tools/wxss2css.js                        # 默认：theme.wxss + app.wxss（T1）
 *   node tools/wxss2css.js --pages               # 追加转换 5 页 WXSS（全量）
 *   node tools/wxss2css.js --pages --only=index  # 只转换今日页（T2）
 *   node tools/wxss2css.js --source=<路径>       # 覆盖源项目根目录
 *   node tools/wxss2css.js --check               # 只校验不写文件
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SOURCE = 'G:/workbuddy/2026-10-31-23-19-46';
const DEST_ROOT = path.resolve(__dirname, '..');
const RPX_PER_PX = 0.5;

const PAGE_IDS = ['index', 'review', 'capsule', 'habit', 'settings'];

function parseArgs(argv) {
  const out = { source: DEFAULT_SOURCE, pages: false, check: false, only: '' };
  (argv || []).forEach(function (a) {
    if (a === '--pages') out.pages = true;
    else if (a === '--check') out.check = true;
    else if (a.indexOf('--source=') === 0) out.source = a.slice('--source='.length);
    else if (a.indexOf('--only=') === 0) out.only = a.slice('--only='.length);
  });
  return out;
}

/** --only=index,review 时只处理指定页面；未指定则全量 5 页。 */
function pageIdsOf(opts) {
  if (!opts.only) return PAGE_IDS.slice();
  const wanted = String(opts.only).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return PAGE_IDS.filter(function (id) { return wanted.indexOf(id) >= 0; });
}

/** 唯一的转换规则：数值 × 0.5，单位 rpx → px。 */
function convertRpx(text) {
  let count = 0;
  const out = String(text).replace(/(-?\d+(?:\.\d+)?)rpx/g, function (_m, num) {
    count += 1;
    const px = Number(num) * RPX_PER_PX;
    // 去掉无意义的尾随 0，保留最多 4 位小数
    const s = String(Math.round(px * 10000) / 10000);
    return s + 'px';
  });
  return { text: out, count: count };
}

/** @import 注释化，并在文件头加一行顺序提示（其余内容不动）。 */
function commentImports(text) {
  let count = 0;
  const out = String(text).split('\n').map(function (line) {
    if (/^\s*@import\s+/i.test(line)) {
      count += 1;
      return '/* [wxss2css] ' + line.trim() + '  → 由 index.html 的 <link> 顺序加载，运行时不再 @import */';
    }
    return line;
  }).join('\n');
  return { text: out, count: count };
}

function buildJobs(opts) {
  const jobs = [
    { src: path.join(opts.source, 'styles', 'theme.wxss'), dest: path.join(DEST_ROOT, 'src', 'renderer', 'styles', 'theme.css'), label: 'theme.wxss → theme.css' },
    { src: path.join(opts.source, 'app.wxss'), dest: path.join(DEST_ROOT, 'src', 'renderer', 'styles', 'app.css'), label: 'app.wxss → app.css' },
  ];
  if (opts.pages) {
    pageIdsOf(opts).forEach(function (id) {
      jobs.push({
        src: path.join(opts.source, 'pages', id, id + '.wxss'),
        dest: path.join(DEST_ROOT, 'src', 'renderer', 'styles', id + '.css'),
        label: id + '.wxss → ' + id + '.css',
      });
    });
  }
  return jobs;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const wantedPages = opts.pages ? pageIdsOf(opts) : [];
  console.log('源项目（只读）：' + opts.source);
  console.log('产物目录：' + path.join(DEST_ROOT, 'src', 'renderer', 'styles'));
  console.log('转换比例：1rpx = ' + RPX_PER_PX + 'px；模式：' + (opts.check ? '仅校验' : '转换 + 写盘')
    + (opts.pages ? '（页面：' + wantedPages.join(',') + '）' : '（仅全局两份）'));
  console.log('');

  const jobs = buildJobs(opts);
  let totalRpx = 0;
  let totalImports = 0;
  let residual = 0;
  const rows = [];

  jobs.forEach(function (job) {
    let raw = '';
    try {
      raw = fs.readFileSync(job.src, 'utf8');
    } catch (e) {
      console.log('[失败] ' + job.label + ' → ' + String(e && e.message || e));
      residual += 1;
      return;
    }
    const converted = convertRpx(raw);
    const imported = commentImports(converted.text);
    totalRpx += converted.count;
    totalImports += imported.count;

    const leftovers = (imported.text.match(/\d+rpx/g) || []).length;
    if (leftovers) residual += leftovers;

    if (!opts.check) {
      fs.mkdirSync(path.dirname(job.dest), { recursive: true });
      fs.writeFileSync(job.dest, imported.text, 'utf8');
    }
    const sha = crypto.createHash('sha256').update(imported.text).digest('hex');
    rows.push({ label: job.label, rpx: converted.count, imports: imported.count, residual: leftovers, sha256: sha });
    console.log('[完成] ' + job.label + '  rpx 替换 ' + converted.count + ' 处，@import 注释化 '
      + imported.count + ' 处，残留 rpx ' + leftovers + ' 处，sha256=' + sha.slice(0, 16) + '…');
  });

  console.log('');
  console.log('合计 rpx 替换 ' + totalRpx + ' 处，@import 注释化 ' + totalImports + ' 处。');
  console.log('产物残留 rpx 检查：' + (residual === 0 ? '通过（0 处）' : '失败（' + residual + ' 处）'));
  if (residual) process.exitCode = 1;
  return { rows: rows, totalRpx: totalRpx, totalImports: totalImports, residual: residual };
}

if (require.main === module) main();

module.exports = {
  convertRpx: convertRpx,
  commentImports: commentImports,
  pageIdsOf: pageIdsOf,
  buildJobs: buildJobs,
  parseArgs: parseArgs,
  RPX_PER_PX: RPX_PER_PX,
  DEFAULT_SOURCE: DEFAULT_SOURCE,
  PAGE_IDS: PAGE_IDS,
};
