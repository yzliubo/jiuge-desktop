'use strict';
// 写作法体检：本地纯函数、零依赖、零联网、零模型。
// 口径照 Hemingway Editor 官方帮助（2026-11-11 核实）：黄/红标难句、蓝色标弱化词、
// Write/Edit 双模式（写作态不打扰）；中文用句长近似，**不套 ARI**（ARI 以英文词/字符定义）。
// 只给定位与计数，永不给改写文本、永不自动落库。

// 【R-28 / D9 裁决，2026-11-12】以下两个阈值是**启发式默认值，未经真实中文语料校准**。
// 产品口径已定为「本期不定义阈值」：它们是提示强度参数，不是验收标准。
// 因此门禁**只允许否定性断言**（不崩溃、不改写正文、不出现未接线内容），
// 严禁添加「体检正确率 / 标色准确率」这类断言——没有校准就没有正确率可言。
var SOFT_LEN = 40;   // 中文单句超过 40 字：偏长
var HARD_LEN = 60;   // 超过 60 字：过长
var WEAK = [
  '非常', '其实', '基本上', '有点', '简直', '似乎', '大概', '也许', '相当',
  '十分', '格外', '略微', '稍稍', '慢慢地', '突然', '果然', '显然', '仅仅',
  '几乎', '多少', '多少有些', '一定程度', '某种意义上'
];
var PASSIVE_RE = /被|由[^，。！？]{0,8}所|受到|得以/g;
var HEAVY_RE = /进行|加以|予以|做出|作出/g;
var SENT_END = '。！？!?；;\n';

function str(v) { return v === null || v === undefined ? '' : String(v); }

// 逐字符切句，保留起止偏移：视图按句拼接后与原文逐字相同，不会吃掉标点或换行。
function splitSentences(text) {
  var out = [];
  var buf = '';
  for (var i = 0; i < text.length; i += 1) {
    var ch = text.charAt(i);
    buf += ch;
    if (SENT_END.indexOf(ch) >= 0) {
      out.push({ text: buf, start: i - buf.length + 1, end: i + 1 });
      buf = '';
    }
  }
  if (buf) out.push({ text: buf, start: text.length - buf.length, end: text.length });
  return out;
}

function hitsOf(sentence) {
  var hits = [];
  for (var i = 0; i < WEAK.length; i += 1) {
    var w = WEAK[i];
    var at = sentence.indexOf(w);
    while (at >= 0) {
      hits.push({ start: at, end: at + w.length, type: 'weak' });
      at = sentence.indexOf(w, at + w.length);
    }
  }
  var re;
  re = new RegExp(PASSIVE_RE.source, 'g');
  var m = re.exec(sentence);
  while (m) {
    hits.push({ start: m.index, end: m.index + m[0].length, type: 'passive' });
    if (!m[0].length) re.lastIndex += 1;
    m = re.exec(sentence);
  }
  re = new RegExp(HEAVY_RE.source, 'g');
  m = re.exec(sentence);
  while (m) {
    hits.push({ start: m.index, end: m.index + m[0].length, type: 'heavy' });
    if (!m[0].length) re.lastIndex += 1;
    m = re.exec(sentence);
  }
  // 重叠的命中只留先出现的那条（例如「进行」与「基本上」不会叠在同一段字上）
  hits.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
  var kept = [], lastEnd = -1;
  for (var j = 0; j < hits.length; j += 1) {
    if (hits[j].start >= lastEnd) { kept.push(hits[j]); lastEnd = hits[j].end; }
  }
  return kept;
}

function countType(hits, type) {
  var n = 0;
  for (var i = 0; i < hits.length; i += 1) if (hits[i].type === type) n += 1;
  return n;
}

function analyze(text) {
  var body = str(text);
  var sentences = splitSentences(body).map(function (s) {
    var zh = (s.text.match(/[\u4e00-\u9fa5]/g) || []).length;
    var hits = hitsOf(s.text);
    return {
      text: s.text, start: s.start, end: s.end, zh: zh, hits: hits,
      level: zh > HARD_LEN ? 'hard' : (zh > SOFT_LEN ? 'soft' : '')
    };
  });
  var counts = { soft: 0, hard: 0, long: 0, weak: 0, passive: 0, heavy: 0, sentences: sentences.length };
  var chars = 0;
  sentences.forEach(function (s) {
    chars += s.zh;
    if (s.level === 'soft') counts.soft += 1;
    if (s.level === 'hard') counts.hard += 1;
    counts.weak += countType(s.hits, 'weak');
    counts.passive += countType(s.hits, 'passive');
    counts.heavy += countType(s.hits, 'heavy');
  });
  counts.long = counts.soft + counts.hard;
  var avg = sentences.length ? Math.round(chars / sentences.length) : 0;
  return {
    sentences: sentences,
    counts: counts,
    chars: chars,
    avg: avg,
    readability: avg < 20 ? '偏短' : (avg <= 40 ? '适中' : '偏长'),
    rules: { softLen: SOFT_LEN, hardLen: HARD_LEN, weakWords: WEAK.length }
  };
}

// 技巧卡只提问、不评分、不落库；卡库可继续加金字塔原理 / 风格的要素 / 卢曼卡片写作。
var CARDS = [
  { id: 'one-true', title: '写一句最真的话', body: '起手别铺陈，先写下你确知的那句，其余让它自己长出来。' },
  { id: 'iceberg', title: '冰山检查', body: '哪一句把本该留在水下的意思说破了？划掉它，看意思还在不在。' },
  { id: 'cut', title: '删掉最顺的段落', body: '写得最得意的往往是在讨好自己，试着整段删掉再读一遍。' }
];

module.exports = {
  analyze: analyze, splitSentences: splitSentences, cards: CARDS,
  WEAK: WEAK, SOFT_LEN: SOFT_LEN, HARD_LEN: HARD_LEN
};
