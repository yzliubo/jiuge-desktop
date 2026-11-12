'use strict';
// 自由记录领域层 + 写作法体检：纯 Node 自测，零第三方依赖。
// 运行：node tests/qa-tmp/free-selftest.js
const assert = require('assert');
const free = require('../../src/free/board.js');
const writing = require('../../src/writing/check.js');

let pass = 0;
function t(name, fn) {
  fn();
  pass += 1;
  console.log('  ok  ' + name);
}
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); }

console.log('\n== src/free/board.js ==');

t('空库 normalize 幂等', function () {
  const a = free.normalize(null);
  eq(a, free.normalize(a));
  eq(a.flashes.length, 0); eq(a.docs.length, 0);
  eq(a.prefs.lastTab, 'capsule');
});

t('新增闪念 → source 合法 / sync 待同步 / 二次 normalize 稳定', function () {
  let s = free.addFlash(free.normalize(null), { text: '周末把旧硬盘照片导出来', date: '2026-11-12' });
  eq(s.flashes.length, 1);
  eq(s.flashes[0].sync, 'pending');
  assert(s.flashes[0].source.indexOf('fl:') === 0, 'source 前缀');
  assert(s.flashes[0].source.length <= 32, 'source 不能超过 gtd 上限');
  eq(s.flashes[0].date, '2026-11-12');
  eq(s, free.normalize(s));
  eq(free.pendingSync(s).length, 1);
});

t('空文本 / 超长文本 / 非法日期', function () {
  eq(free.addFlash(free.normalize(null), { text: '   ' }).flashes.length, 0);
  const s = free.addFlash(free.normalize(null), { text: 'x'.repeat(900), date: 'bad' });
  eq(s.flashes[0].text.length, free.FLASH_MAX);
  eq(s.flashes[0].date, '');
});

t('同步标记：ok 后不再进待同步队列，failed 可重试', function () {
  let s = free.addFlash(free.normalize(null), { text: 'A' });
  const id = s.flashes[0].id;
  s = free.setFlashSync(s, id, 'ok', 'task-1');
  eq(s.flashes[0].sync, 'ok');
  eq(s.flashes[0].taskId, 'task-1');
  eq(free.pendingSync(s).length, 0);
  s = free.setFlashSync(s, id, 'failed', '');
  eq(free.pendingSync(s).length, 1);
  eq(s.flashes[0].text, 'A', '同步失败不能丢原文');
});

t('按 source 去重的幂等前提：两条不同闪念 id 必不相同', function () {
  let s = free.addFlash(free.normalize(null), { text: 'A' });
  s = free.addFlash(s, { text: 'B' });
  assert.notStrictEqual(s.flashes[0].id, s.flashes[1].id);
  assert.notStrictEqual(s.flashes[0].source, s.flashes[1].source);
});

t('删除闪念后不复活', function () {
  let s = free.addFlash(free.normalize(null), { text: 'A' });
  s = free.removeFlash(s, s.flashes[0].id);
  eq(s.flashes.length, 0);
  eq(s, free.normalize(s));
});

t('长文 CRUD + 2 万字截断 + 标题兜底', function () {
  let s = free.addDoc(free.normalize(null), { title: '', body: '正文'.repeat(15000) });
  eq(s.docs.length, 1);
  eq(s.docs[0].title, '未命名长文');
  eq(s.docs[0].body.length, free.DOC_BODY_MAX);
  const id = s.docs[0].id;
  s = free.updateDoc(s, id, { title: '给十年后的自己', body: '短一点' });
  eq(free.findDoc(s, id).title, '给十年后的自己');
  eq(free.findDoc(s, id).body, '短一点');
  s = free.removeDoc(s, id);
  eq(s.docs.length, 0);
});

t('prefs 非法值回落，不产生未知键', function () {
  const s = free.setPrefs(free.normalize(null), { lastTab: 'evil', method: 'gpt', checkOn: 'yes' });
  eq(s.prefs, { lastTab: 'capsule', method: 'hemingway', checkOn: false });
  eq(Object.keys(s).sort(), ['docs', 'flashes', 'prefs']);
});

t('mergeSection 只补不改、可重复调用', function () {
  let a = free.addFlash(free.normalize(null), { text: '来自另一台机器' });
  a = free.addDoc(a, { title: '另一台机器的长文', body: 'x' });
  const b = free.addFlash(free.normalize(null), { text: '本机已有闪念' });
  let m = free.mergeSection(b, a);
  eq(m.added, 2);
  eq(m.state.flashes.length, 2);
  eq(m.state.docs.length, 1);
  const again = free.mergeSection(m.state, a);
  eq(again.added, 0, '第二次不该再补');
  eq(again.state, m.state);
});

t('脏数据 / 未知字段被白名单削掉，仍幂等', function () {
  const dirty = {
    flashes: [{ id: 'c1', text: '  hello  ', evil: 1, sync: '???', tags: ['a', 'b'] }],
    docs: [{ id: 'd1', title: 'T', body: 'B', evil: 2 }],
    prefs: { lastTab: 'long', checkOn: true }, evilRoot: 1
  };
  const s = free.normalize(dirty);
  eq(Object.keys(s).sort(), ['docs', 'flashes', 'prefs']);
  eq(Object.keys(s.flashes[0]).indexOf('evil'), -1);
  eq(s.flashes[0].sync, 'pending');
  eq(s.flashes[0].text, 'hello');
  eq(s, free.normalize(s));
});

console.log('\n== src/writing/check.js ==');

t('句子切分拼接后逐字等于原文', function () {
  const text = '第一句。第二句！第三句？\n第四行；没有标点的尾巴';
  const r = writing.analyze(text);
  eq(r.sentences.map(function (s) { return s.text; }).join(''), text);
});

t('长句分级：>40 黄、>60 红', function () {
  const soft = '字'.repeat(45) + '。';
  const hard = '字'.repeat(65) + '。';
  const short = '短句。';
  const r = writing.analyze(soft + hard + short);
  eq(r.sentences[0].level, 'soft');
  eq(r.sentences[1].level, 'hard');
  eq(r.sentences[2].level, '');
  eq(r.counts.long, 2);
});

t('弱化词 / 被动 / 繁化动词都能定位', function () {
  const r = writing.analyze('他非常慢慢地被进行了一番说明，其实没有予以解释。');
  assert(r.counts.weak >= 3, '弱化词命中数 ' + r.counts.weak);
  assert(r.counts.passive >= 1, '被动词命中数 ' + r.counts.passive);
  assert(r.counts.heavy >= 2, '繁化动词命中数 ' + r.counts.heavy);
  const hit = r.sentences[0].hits[0];
  assert(hit.start >= 0 && hit.end > hit.start, '命中区间合法');
});

t('可读性只给三档，不编造年级分', function () {
  eq(writing.analyze('短。句。真。好。').readability, '偏短');
  eq(writing.analyze('字'.repeat(28) + '。').readability, '适中');
  eq(writing.analyze('字'.repeat(50) + '。').readability, '偏长');
  eq(writing.analyze('').counts.sentences, 0);
  eq(writing.analyze('').avg, 0);
});

t('技巧卡三条，只提问不改写', function () {
  eq(writing.cards.length, 3);
  assert(writing.cards.every(function (c) { return c.title && c.body && !c.rewrite; }));
});

console.log('\nALL OK  ' + pass + ' 条\n');
