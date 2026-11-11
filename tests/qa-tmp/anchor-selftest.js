'use strict';
// 临时自测：把 reader.js 里的锚点模块原样切出来，在真实 Chromium DOM 上跑行为断言。
// 不是门禁，只为验证「偏移失准后按原文自愈」这条链路真的成立。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const readerPath = path.join(__dirname, '..', '..', 'renderer-v2', 'reader', 'reader.js');
const src = fs.readFileSync(readerPath, 'utf8');
const from = src.indexOf('const TEXT_SKIP');
const to = src.indexOf('function currentSelection');
if (from < 0 || to < 0 || to <= from) {
  console.error('切不出锚点模块，检查 reader.js 结构');
  process.exit(2);
}
const block = src.slice(from, to);

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>.red{color:red}</style></head><body>
<script>var scriptOnly = "脚本里的文字不该算进偏移";</script>
<p id="p1">第一段：读书要慢。</p>
<p id="p2">第二段：读书要慢。</p>
<p id="p4">第三段：读书要慢，但要记。</p>
<div><span>换行</span><span>切开的</span>两段文字</div>
</body></html>`;

const TEST = `
(function(){
  const api = (new Function(${JSON.stringify(block)} +
    '\\nreturn {buildTextMap:buildTextMap, rangeByOffset:rangeByOffset, resolveAnchor:resolveAnchor,' +
    ' offsetAt:offsetAt, measureQuote:measureQuote, normWs:normWs};'))();
  const out = [];
  const assert = function(name, cond, extra){ out.push({name:name, ok:!!cond, extra:extra||''}); };
  const map = api.buildTextMap(document.body);
  assert('建表成功', !!map && map.length > 0, 'len=' + (map && map.length));
  assert('script 文本不进偏移表', map.text.indexOf('脚本里的文字') < 0);
  assert('style 文本不进偏移表', map.text.indexOf('color:red') < 0);
  assert('正文进偏移表', map.text.indexOf('第一段：读书要慢。') >= 0);

  const at1 = map.text.indexOf('第一段：读书要慢。');
  const quote1 = '第一段：读书要慢。';
  // 1) 偏移正确 -> exact
  const a = api.resolveAnchor(map, {anchor:'0:'+at1+'-'+(at1+quote1.length), quote:quote1});
  assert('偏移正确时 exact=true', a && a.exact === true, a ? ('start='+a.start) : 'null');
  assert('取回的原文与 quote 一致', a && a.range.toString() === quote1, a ? a.range.toString() : 'null');

  // 2) 偏移错了 40 字（模拟换了书源 / 重排版）-> 按 quote 自愈
  const bad = at1 + 40;
  const b = api.resolveAnchor(map, {anchor:'0:'+bad+'-'+(bad+quote1.length), quote:quote1});
  assert('偏移错位时能自愈', b && b.exact === false, b ? ('start='+b.start) : 'null');
  assert('自愈后落点正确', b && b.range.toString() === quote1, b ? b.range.toString() : 'null');

  // 3) 重复句靠前后文消歧：三处都有「读书要慢」
  const dup = api.resolveAnchor(map, {
    anchor:'0:0-4', quote:'读书要慢', anchorPre:'第一段：', anchorSuf:'。第二段'
  });
  assert('重复句按前文选中第一处',
    dup && dup.range.toString() === '读书要慢' && dup.start === map.text.indexOf('读书要慢'),
    dup ? ('start='+dup.start) : 'null');

  const dup2 = api.resolveAnchor(map, {
    anchor:'0:0-4', quote:'读书要慢', anchorPre:'第三段：', anchorSuf:'，但要记'
  });
  assert('重复句按前文选中第三处',
    dup2 && dup2.start === map.text.indexOf('读书要慢', map.text.indexOf('第三段：')),
    dup2 ? ('start='+dup2.start) : 'null');

  // 4) 原文彻底不在了 -> null，不能乱标
  const c = api.resolveAnchor(map, {anchor:'0:5-9', quote:'这句话这本书里没有'});
  assert('原文不存在返回 null', c === null);

  // 4b) 空 quote 不许靠 indexOf('') 造出位置 0 的假命中
  const f = api.resolveAnchor(map, {anchor:'0:9999-10001'});
  assert('空 quote 不给位置 0 的假命中', !f || f.start !== 0, f ? ('start='+f.start) : 'null');

  // 5) 没有 quote 的老数据：退回偏移，标 exact=false 提醒
  const d = api.resolveAnchor(map, {anchor:'0:0-3'});
  assert('无 quote 时仍按偏移定位且标注不精确', d && d.exact === false && d.start === 0);

  // 6) 跨节点的区间能正确取回（换行切开的两个 span）
  const cross0 = map.text.indexOf('换行切开的两段文字');
  const e = api.resolveAnchor(map, {anchor:'0:'+cross0+'-'+(cross0+9), quote:'换行切开的两段文字'});
  assert('跨节点区间可定位', e && e.range.toString() === '换行切开的两段文字',
    JSON.stringify({cross0:cross0, got:e ? e.range.toString() : null,
      len:e ? e.range.toString().length : 0, exact:e ? e.exact : null}));

  return {total: out.length, fail: out.filter(function(x){return !x.ok;}).length, items: out};
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  let res;
  try {
    res = await win.webContents.executeJavaScript(TEST);
  } catch (e) {
    console.error('执行失败:', e && e.message ? e.message : e);
    app.exit(2);
    return;
  }
  res.items.forEach(function (it) {
    console.log((it.ok ? '[PASS] ' : '[FAIL] ') + it.name + (it.extra ? '  → ' + it.extra : ''));
  });
  console.log('----');
  console.log('断言 ' + res.total + ' 条，失败 ' + res.fail + ' 条');
  app.exit(res.fail ? 1 : 0);
});
