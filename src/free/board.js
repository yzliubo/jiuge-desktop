'use strict';
// 自由记录（md_freewrite）：闪念快记 + 长文撰写 + 模块偏好。
// 胶囊不在这里——胶囊的权威源是冻结的 utils/diary-store.js，本模块只读派生，绝不复制正文。
// 全部纯函数、零第三方依赖；normalize 必须幂等（golden-case 会二次 normalize 对拍）。

var FLASH_MAX = 500;        // 一条闪念的正文上限
var DOC_BODY_MAX = 20000;   // 长文正文上限：不能塞进 cells.free（当日日记 2000 字 + 全量写）
var DOC_TITLE_MAX = 60;
var TAG_MAX = 24;
var MAX_FLASH = 3000;
var MAX_DOCS = 200;
var TABS = ['capsule', 'flash', 'long'];
var METHODS = ['hemingway'];
var SYNC = ['pending', 'ok', 'failed'];

var seq = 0;

function str(v) { return v === null || v === undefined ? '' : String(v); }
function clip(v, max) { var s = str(v); return s.length > max ? s.slice(0, max) : s; }
function trimClip(v, max) { return clip(str(v).trim(), max); }
function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.floor(n) : 0; }
function bool(v) { return v === true; }
function oneOf(v, list, fallback) { return list.indexOf(str(v)) >= 0 ? str(v) : fallback; }

function newId(prefix) {
  seq += 1;
  return prefix + Date.now().toString(36) + (seq % 46656).toString(36);
}

// gtd.add 的 source 字段上限是 32 字；id 固定 ~12 字，前缀 3 字，留足余量。
function flashSource(id) { return 'fl:' + clip(str(id), 28); }

function normFlash(f) {
  if (!f || typeof f !== 'object') return null;
  var id = trimClip(f.id, 40);
  if (!id) return null;
  var text = trimClip(f.text, FLASH_MAX);
  if (!text) return null;
  var tags = Array.isArray(f.tags) ? f.tags : [];
  return {
    id: id,
    text: text,
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(f.date)) ? str(f.date) : '',
    createdAt: num(f.createdAt),
    tags: tags.map(function (t) { return trimClip(t, TAG_MAX); }).filter(Boolean).slice(0, 6),
    source: trimClip(f.source, 32) || flashSource(id),
    sync: oneOf(f.sync, SYNC, 'pending'),
    taskId: trimClip(f.taskId, 40)
  };
}

function normDoc(d) {
  if (!d || typeof d !== 'object') return null;
  var id = trimClip(d.id, 40);
  if (!id) return null;
  return {
    id: id,
    title: trimClip(d.title, DOC_TITLE_MAX) || '未命名长文',
    body: clip(d.body, DOC_BODY_MAX),
    createdAt: num(d.createdAt),
    updatedAt: num(d.updatedAt),
    method: oneOf(d.method, METHODS, 'hemingway')
  };
}

function dedup(list, limit) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || seen[item.id]) continue;
    seen[item.id] = true;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function normalize(raw) {
  var s = raw && typeof raw === 'object' ? raw : {};
  var p = s.prefs && typeof s.prefs === 'object' ? s.prefs : {};
  var flashes = (Array.isArray(s.flashes) ? s.flashes : [])
    .map(normFlash).filter(Boolean);
  var docs = (Array.isArray(s.docs) ? s.docs : [])
    .map(normDoc).filter(Boolean);
  return {
    flashes: dedup(flashes, MAX_FLASH),
    docs: dedup(docs, MAX_DOCS),
    prefs: {
      lastTab: oneOf(p.lastTab, TABS, 'capsule'),
      method: oneOf(p.method, METHODS, 'hemingway'),
      checkOn: bool(p.checkOn)
    }
  };
}

// 只补不改、按 id 去重，可反复点（照 gtd.importFromWorkBoard 的口径）。
function mergeSection(state, section) {
  var s = normalize(state);
  var other = normalize(section && typeof section === 'object' ? section : {});
  var seenF = {}, seenD = {}, added = 0;
  s.flashes.forEach(function (f) { seenF[f.id] = true; });
  s.docs.forEach(function (d) { seenD[d.id] = true; });
  other.flashes.forEach(function (f) {
    if (seenF[f.id] || s.flashes.length >= MAX_FLASH) return;
    seenF[f.id] = true; s.flashes.push(f); added += 1;
  });
  other.docs.forEach(function (d) {
    if (seenD[d.id] || s.docs.length >= MAX_DOCS) return;
    seenD[d.id] = true; s.docs.push(d); added += 1;
  });
  return { state: normalize(s), added: added };
}

function findFlash(s, id) {
  for (var i = 0; i < s.flashes.length; i++) {
    if (s.flashes[i].id === str(id)) return s.flashes[i];
  }
  return null;
}
function findDoc(s, id) {
  for (var i = 0; i < s.docs.length; i++) {
    if (s.docs[i].id === str(id)) return s.docs[i];
  }
  return null;
}

// 闪念先落库（sync:'pending'），再由主进程串行同步到 gtd 收件箱；
// 同步失败只改标记、绝不回滚原文——「不静默丢字」高于「两边绝对一致」。
function addFlash(state, patch) {
  var s = normalize(state);
  var p = patch || {};
  var text = trimClip(p.text, FLASH_MAX);
  if (!text || s.flashes.length >= MAX_FLASH) return s;
  var id = newId('f');
  s.flashes.unshift({
    id: id, text: text,
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(p.date)) ? str(p.date) : '',
    createdAt: Date.now(),
    tags: [], source: flashSource(id), sync: 'pending', taskId: ''
  });
  return normalize(s);
}

function setFlashSync(state, id, sync, taskId) {
  var s = normalize(state);
  var f = findFlash(s, id);
  if (!f) return s;
  f.sync = oneOf(sync, SYNC, 'failed');
  f.taskId = trimClip(taskId, 40);
  return normalize(s);
}

function removeFlash(state, id) {
  var s = normalize(state);
  s.flashes = s.flashes.filter(function (f) { return f.id !== str(id); });
  return s;
}

function pendingSync(state) {
  return normalize(state).flashes.filter(function (f) { return f.sync !== 'ok'; });
}

function addDoc(state, patch) {
  var s = normalize(state);
  if (s.docs.length >= MAX_DOCS) return s;
  var p = patch || {};
  var now = Date.now();
  s.docs.unshift({
    id: newId('d'),
    title: trimClip(p.title, DOC_TITLE_MAX) || '未命名长文',
    body: clip(p.body, DOC_BODY_MAX),
    createdAt: now, updatedAt: now,
    method: oneOf(p.method, METHODS, 'hemingway')
  });
  return normalize(s);
}

function updateDoc(state, id, patch) {
  var s = normalize(state);
  var d = findDoc(s, id);
  if (!d) return s;
  var p = patch || {};
  if (p.title !== undefined) d.title = trimClip(p.title, DOC_TITLE_MAX) || '未命名长文';
  if (p.body !== undefined) d.body = clip(p.body, DOC_BODY_MAX);
  if (p.method !== undefined) d.method = oneOf(p.method, METHODS, 'hemingway');
  d.updatedAt = Date.now();
  return normalize(s);
}

function removeDoc(state, id) {
  var s = normalize(state);
  s.docs = s.docs.filter(function (d) { return d.id !== str(id); });
  return s;
}

function setPrefs(state, patch) {
  var s = normalize(state);
  var p = patch || {};
  if (p.lastTab !== undefined) s.prefs.lastTab = oneOf(p.lastTab, TABS, 'capsule');
  if (p.method !== undefined) s.prefs.method = oneOf(p.method, METHODS, 'hemingway');
  if (p.checkOn !== undefined) s.prefs.checkOn = bool(p.checkOn);
  return s;
}

module.exports = {
  FLASH_MAX: FLASH_MAX, DOC_BODY_MAX: DOC_BODY_MAX, DOC_TITLE_MAX: DOC_TITLE_MAX,
  MAX_FLASH: MAX_FLASH, MAX_DOCS: MAX_DOCS,
  normalize: normalize, mergeSection: mergeSection, flashSource: flashSource,
  addFlash: addFlash, setFlashSync: setFlashSync, removeFlash: removeFlash,
  pendingSync: pendingSync, findFlash: findFlash,
  addDoc: addDoc, updateDoc: updateDoc, removeDoc: removeDoc, findDoc: findDoc,
  setPrefs: setPrefs
};
