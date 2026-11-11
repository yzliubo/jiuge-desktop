'use strict';
// 九格手记 · 轻标签领域模块
//
// 数据存 md_tags 单键，由主进程仓储读写；本模块只管「这个键里装什么」，不碰 IO，
// 也不碰 8 个冻结的 src/utils/*.js。结构固定为可 JSON 序列化的普通对象/数组：
//   { version: 1,
//     tags:  [ { id, name, createdAt } ],        // 标签字典，名称唯一
//     links: [ { target, tagId } ] }              // 关联对，一条 target 最多 3 个标签
// target 形如 'diary:2026-11-07' 或 'cell:work'，本模块只做长度/控制字符清洗，
// 不强行校验格式——导入旧数据时宁可留下，也不要因为格式不认识就丢掉。
//
// 全部导出都是纯函数：输入 state，返回新的 state（不改入参）；normalize 幂等，
// 对任意脏数据（null / 字符串 / 数组 / 字段类型错乱）都不抛异常。

const MAX_TAGS = 60;
const MAX_TAGS_PER_TARGET = 3;
const TAG_NAME_MAX = 12;
const TARGET_MAX = 64;
const ID_MAX = 64;

let seq = 0;

function str(v) {
  return String(v === undefined || v === null ? '' : v);
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function finitePositive(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

function newId() {
  seq += 1;
  return 'tag_' + Date.now().toString(36) + '_' + seq;
}

// 标签名：折空白、按「字」（码点）截到 12 个，避免 surrogate 被切成半个字符。
function cleanName(v) {
  const s = str(v).replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, TAG_NAME_MAX).join('');
}

// target：去掉控制字符（含 \u0000，它是本模块内部拼接用的分隔符）、折空白、限长。
function cleanTarget(v) {
  return str(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TARGET_MAX);
}

function cleanId(v) {
  return str(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, ID_MAX);
}

function empty() {
  return { version: 1, tags: [], links: [] };
}

// normalize 必须幂等：缺失/重复的 id 一律用「由名字 + 下标」推出的确定性兜底值，
// 绝不在 normalize 里用 Date.now() 或随机数，否则 normalize(normalize(x)) 会变。
function normalize(raw) {
  const src = isObj(raw) ? raw : {};
  const seenId = {};
  const seenName = {};
  const tags = [];

  (Array.isArray(src.tags) ? src.tags : []).forEach(function (t, idx) {
    if (tags.length >= MAX_TAGS) return;
    const name = cleanName(isObj(t) ? t.name : '');
    if (!name || seenName[name]) return;
    seenName[name] = true;

    let id = isObj(t) ? cleanId(t.id) : '';
    if (!id || seenId[id]) {
      id = 'tag_' + name + '_' + idx;
      let n = 0;
      while (seenId[id]) {
        n += 1;
        id = 'tag_' + name + '_' + idx + '_' + n;
      }
    }
    seenId[id] = true;
    tags.push({
      id: id,
      name: name,
      createdAt: isObj(t) ? finitePositive(t.createdAt) : 0,
    });
  });

  const tagIds = {};
  tags.forEach(function (t) { tagIds[t.id] = true; });

  const seenLink = {};
  const perTarget = {};
  const links = [];
  (Array.isArray(src.links) ? src.links : []).forEach(function (l) {
    const target = isObj(l) ? cleanTarget(l.target) : '';
    const tagId = isObj(l) ? cleanId(l.tagId) : '';
    // 指向已删除标签的关联直接丢掉，不留悬空引用
    if (!target || !tagIds[tagId]) return;
    if ((perTarget[target] || 0) >= MAX_TAGS_PER_TARGET) return;
    const key = target + '\u0000' + tagId;
    if (seenLink[key]) return;
    seenLink[key] = true;
    perTarget[target] = (perTarget[target] || 0) + 1;
    links.push({ target: target, tagId: tagId });
  });

  return { version: 1, tags: tags, links: links };
}

function addTag(state, name) {
  const s = normalize(state);
  const label = cleanName(name);
  if (!label) return s;
  // 同名不重复建：轻标签靠名字识别，再建一个只会让下拉框里出现两行一样的字
  if (s.tags.some(function (t) { return t.name === label; })) return s;
  if (s.tags.length >= MAX_TAGS) return s;
  s.tags.push({ id: newId(), name: label, createdAt: Date.now() });
  return s;
}

function removeTag(state, id) {
  const s = normalize(state);
  const key = cleanId(id);
  s.tags = s.tags.filter(function (t) { return t.id !== key; });
  // 标签没了，挂在它下面的关联一并清掉，避免下次读回来又多出一堆无效行
  s.links = s.links.filter(function (l) { return l.tagId !== key; });
  return s;
}

function tagRecord(state, target, tagId) {
  const s = normalize(state);
  const t = cleanTarget(target);
  const id = cleanId(tagId);
  if (!t || !s.tags.some(function (tag) { return tag.id === id; })) return s;
  if (s.links.some(function (l) { return l.target === t && l.tagId === id; })) return s;
  if (s.links.filter(function (l) { return l.target === t; }).length >= MAX_TAGS_PER_TARGET) return s;
  s.links.push({ target: t, tagId: id });
  return s;
}

function untagRecord(state, target, tagId) {
  const s = normalize(state);
  const t = cleanTarget(target);
  const id = cleanId(tagId);
  s.links = s.links.filter(function (l) {
    return !(l.target === t && l.tagId === id);
  });
  return s;
}

// 返回该 target 上挂着的标签对象数组 [{ id, name }]（按标签字典顺序），
// 只给渲染层需要的两个字段，不把 createdAt 之类内部字段透出去。
function listFor(state, target) {
  const s = normalize(state);
  const t = cleanTarget(target);
  if (!t) return [];
  const ids = {};
  s.links.forEach(function (l) {
    if (l.target === t) ids[l.tagId] = true;
  });
  return s.tags.filter(function (tag) { return ids[tag.id]; })
    .map(function (tag) { return { id: tag.id, name: tag.name }; });
}

function stats(state) {
  const s = normalize(state);
  const count = {};
  const targets = {};
  s.links.forEach(function (l) {
    count[l.tagId] = (count[l.tagId] || 0) + 1;
    targets[l.target] = true;
  });
  const byTag = s.tags.map(function (t) {
    return { id: t.id, name: t.name, count: count[t.id] || 0 };
  }).sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return {
    tags: s.tags.length,
    links: s.links.length,
    taggedTargets: Object.keys(targets).length,
    byTag: byTag,
  };
}

// 换机合并：只补不改（本机已有的标签/关联一律不覆盖），可反复调用。
// 同名不同 id 时把导入侧的 id 映射到本机标签，这样对侧的关联还能补进来；
// id 撞车但名字不同则视为不可用，绝不把关联挂到错误的标签上。
// added = 新增标签数 + 新增关联数。
function mergeSection(state, section) {
  const s = normalize(state);
  const inc = normalize(section);
  const haveId = {};
  const haveName = {};
  const idMap = {};
  s.tags.forEach(function (t) {
    haveId[t.id] = true;
    haveName[t.name] = true;
  });

  let added = 0;
  inc.tags.forEach(function (t) {
    if (haveName[t.name]) {
      idMap[t.id] = tagIdByName(s, t.name);
      return;
    }
    if (haveId[t.id] || s.tags.length >= MAX_TAGS) {
      idMap[t.id] = '';
      return;
    }
    s.tags.push(t);
    haveId[t.id] = true;
    haveName[t.name] = true;
    idMap[t.id] = t.id;
    added += 1;
  });

  // normalize(section) 已保证 inc.links 的 tagId 一定存在于 inc.tags，
  // 所以这里只需要查 idMap，不用再担心悬空引用。
  const seenLink = {};
  const perTarget = {};
  s.links.forEach(function (l) {
    seenLink[l.target + '\u0000' + l.tagId] = true;
    perTarget[l.target] = (perTarget[l.target] || 0) + 1;
  });
  inc.links.forEach(function (l) {
    const localId = idMap[l.tagId];
    if (!localId) return;
    const key = l.target + '\u0000' + localId;
    if (seenLink[key]) return;
    if ((perTarget[l.target] || 0) >= MAX_TAGS_PER_TARGET) return;
    s.links.push({ target: l.target, tagId: localId });
    seenLink[key] = true;
    perTarget[l.target] = (perTarget[l.target] || 0) + 1;
    added += 1;
  });

  return { state: normalize(s), added: added };
}

function tagIdByName(s, name) {
  const hit = s.tags.filter(function (t) { return t.name === name; })[0];
  return hit ? hit.id : '';
}

module.exports = {
  empty: empty,
  normalize: normalize,
  addTag: addTag,
  removeTag: removeTag,
  tagRecord: tagRecord,
  untagRecord: untagRecord,
  listFor: listFor,
  stats: stats,
  mergeSection: mergeSection,
};
