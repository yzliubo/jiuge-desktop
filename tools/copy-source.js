'use strict';
/**
 * 移植期一次性离线脚本（运行时不执行，产物直接入库随 exe 发布）。
 *
 * 只读从源项目复制 8 个 utils 与（可选）5 页 JS / 5 个 WXML 到 src/，
 * **逐字节复制**（Buffer，不做编码转换），并输出源端与目标端的 SHA256 对拍清单。
 * 绝不写源项目任何文件（F4）。
 *
 * 用法：
 *   node tools/copy-source.js                        # 默认：仅复制 8 个 utils（T1）
 *   node tools/copy-source.js --pages               # 追加复制 5 页 JS + 5 WXML（T3/T4 全量）
 *   node tools/copy-source.js --pages --only=index  # 只复制今日页（T2，避免越界到其它批次）
 *   node tools/copy-source.js --source=<路径>       # 覆盖源项目根目录
 *   node tools/copy-source.js --check               # 只校验不复制
 *
 * 注意：settings.js 在架构 §4.5 是【适配改写】（需新增文件导入入口），
 * --pages 复制出来的只能是 T4 的改写基底，**不可直接当最终产物**，脚本会明确打印该提示。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SOURCE = 'G:/workbuddy/2026-10-31-23-19-46';
const DEST_ROOT = path.resolve(__dirname, '..');

const UTILS = [
  'diary-store.js', 'work-board.js', 'money-book.js', 'study-log.js',
  'cell-insights.js', 'greetings.js', 'quotes.js', 'theme.js',
];
const PAGE_IDS = ['index', 'review', 'capsule', 'habit', 'settings'];
// 架构 §4.5 / §4.6：settings.js 与 settings.wxml 是【适配改写】，逐字节对拍不适用；
// 改为校验「源文件的每一行按原顺序全部保留」（只增不改不删），并由 verify-equivalence.js 复查白名单。
const ADAPTED = { 'pages/settings/settings.js': true, 'views/settings.wxml': true };

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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 逐字节复制一个文件；返回源/目标哈希与字节数。 */
function copyOne(srcPath, destPath, doCopy) {
  const srcBuf = fs.readFileSync(srcPath);
  if (doCopy) {
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, srcBuf);
  }
  const dstBuf = fs.existsSync(destPath) ? fs.readFileSync(destPath) : null;
  const srcHash = sha256(srcBuf);
  const dstHash = dstBuf ? sha256(dstBuf) : '';
  return {
    file: path.basename(srcPath),
    source: srcPath,
    dest: destPath,
    bytes: srcBuf.length,
    sha256: srcHash,
    targetSha256: dstHash,
    identical: srcHash === dstHash,
  };
}

function buildJobs(opts) {
  const jobs = [];
  UTILS.forEach(function (name) {
    jobs.push({
      src: path.join(opts.source, 'utils', name),
      dest: path.join(DEST_ROOT, 'src', 'utils', name),
      label: 'utils/' + name,
    });
  });
  if (opts.pages) {
    pageIdsOf(opts).forEach(function (id) {
      jobs.push({
        src: path.join(opts.source, 'pages', id, id + '.js'),
        dest: path.join(DEST_ROOT, 'src', 'pages', id, id + '.js'),
        label: 'pages/' + id + '/' + id + '.js',
      });
      jobs.push({
        src: path.join(opts.source, 'pages', id, id + '.wxml'),
        dest: path.join(DEST_ROOT, 'src', 'views', id + '.wxml'),
        label: 'views/' + id + '.wxml',
      });
    });
  }
  return jobs;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const wantedPages = opts.pages ? pageIdsOf(opts) : [];
  console.log('源项目（只读）：' + opts.source);
  console.log('交付目录：' + DEST_ROOT);
  console.log('模式：' + (opts.check ? '仅校验' : '复制 + 校验')
    + (opts.pages ? '（页面：' + wantedPages.join(',') + '）' : '（仅 8 个 utils）'));
  console.log('');

  const jobs = buildJobs(opts);
  const rows = [];
  let failed = 0;
  jobs.forEach(function (job) {
    try {
      const r = copyOne(job.src, job.dest, !opts.check);
      r.label = job.label;
      if (ADAPTED[job.label]) {
        r.adapted = true;
        // 白名单改写判据：源文件的每一行按原顺序全部保留（只增不改不删）
        const s = fs.readFileSync(job.src, 'utf8').split('\n');
        const d = fs.readFileSync(job.dest, 'utf8').split('\n');
        let i = 0;
        for (let j = 0; j < d.length && i < s.length; j += 1) {
          if (s[i] === d[j]) i += 1;
        }
        r.identical = (i === s.length);
        r.bytes = fs.statSync(job.dest).size;
      }
      rows.push(r);
      const tag = r.adapted ? (r.identical ? '[白名单改写]' : '[改写异常]')
        : (r.identical ? '[一致]' : '[不一致]');
      console.log(tag + ' ' + r.label + '  ' + r.bytes + ' 字节  sha256=' + r.sha256);
      if (!r.identical) failed += 1;
    } catch (e) {
      failed += 1;
      console.log('[失败] ' + job.label + ' → ' + String(e && e.message || e));
    }
  });

  if (!opts.check) {
    // T1 兼容：utils 专用清单保持原路径 / 原格式
    const utilsListPath = path.join(DEST_ROOT, 'src', 'utils', '.sha256.json');
    const utilsManifest = {};
    rows.filter(function (r) { return r.label.indexOf('utils/') === 0; }).forEach(function (r) {
      utilsManifest[r.file] = { sha256: r.sha256, bytes: r.bytes, source: r.source };
    });
    ensureDir(path.dirname(utilsListPath));
    fs.writeFileSync(utilsListPath, JSON.stringify(utilsManifest, null, 2), 'utf8');
    console.log('');
    console.log('utils SHA256 清单已写入：' + utilsListPath);

    // 全量清单（含本批页面 JS / WXML），供 verify-equivalence.js 与 QA 复核
    const allPath = path.join(DEST_ROOT, 'src', '.copy-manifest.json');
    // 清单按批次累积：--only=review / --only=capsule 不应抹掉先前批次的条目
    let previous = {};
    try { previous = JSON.parse(fs.readFileSync(allPath, 'utf8')); } catch (e) { previous = {}; }
    const allManifest = {};
    rows.forEach(function (r) {
      allManifest[r.label] = { sha256: r.sha256, targetSha256: r.targetSha256, bytes: r.bytes, source: r.source };
    });
    fs.writeFileSync(allPath, JSON.stringify(Object.assign(previous, allManifest), null, 2), 'utf8');
    console.log('全量复制清单已写入：' + allPath);
  }

  if (opts.pages && wantedPages.indexOf('settings') >= 0) {
    console.log('');
    console.log('[提醒] settings.js 属【适配改写】：T4 需按架构 §4.5 新增「导入小程序备份文件」入口与结果面板，');
    console.log('        复制件只是改写基底；其余 4 页 JS 与 5 个 WXML 均为零复制。');
  }

  console.log('');
  console.log('合计 ' + rows.length + ' 个文件，逐字节一致 ' + (rows.length - failed) + ' 个，异常 ' + failed + ' 个。');
  if (failed) {
    console.error('存在不一致文件，请检查源项目是否被改动。');
    process.exitCode = 1;
  }
  return { rows: rows, failed: failed };
}

if (require.main === module) main();

module.exports = {
  parseArgs: parseArgs,
  pageIdsOf: pageIdsOf,
  buildJobs: buildJobs,
  copyOne: copyOne,
  sha256: sha256,
  UTILS: UTILS,
  PAGE_IDS: PAGE_IDS,
  DEFAULT_SOURCE: DEFAULT_SOURCE,
  DEST_ROOT: DEST_ROOT,
};
