'use strict';
// 链接型附件 —— V2.1 ⑳。只存路径，绝不拷贝文件内容。
//
// 【诚实声明】文件被移走、改名、删除后，链接就会失效（broken）。
//   链接型不把文件复制进库，也不保证文件永远在原处；换盘符后请用
//   reconnect() 按「同文件名 + 同大小」模糊重连，失败则标灰，不自动删除记录。
//   拷贝型附件推迟到真实需求出现再做。
//
// 存独立新键（如 md_attach），单键，不动冻结的 8 个 utils。
// 用 fs.statSync 取 size / mtime；上限 500 条，路径去重，脏数据幂等。

const fs = require('fs');

const MAX_LINKS = 500;
const PATH_MAX = 1000;
const NAME_MAX = 255;

function str(v) { return typeof v === 'string' ? v : (v === 0 || v ? String(v) : ''); }
// clip：只 trim、不折叠内部空格（路径/文件名可能含连续空格，不能像普通文本那样压掉）
function clip(v, max) {
    const s = (typeof v === 'string' ? v : (v == null ? '' : String(v))).trim();
    return s.length > max ? s.slice(0, max) : s;
}
function clean(v, max) {
    const s = str(v).replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max) : s;
}
function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function safeNum(v, dflt) {
    const t = typeof v;
    if (t === 'number') return isFinite(v) ? v : dflt;
    if (t === 'string' || t === 'boolean') { const n = Number(v); return isFinite(n) ? n : dflt; }
    return dflt;
}
function basename(p) {
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || '';
}
// 确定性 id：脏数据缺 id 时由内容派生，保证 normalize 幂等。
function hashId(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return 'at-' + (h >>> 0).toString(36);
}
function newId() { return 'at-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function normLink(raw) {
    const o = obj(raw);
    const p = clip(o.path, PATH_MAX);
    if (!p) return null;
    const size = safeNum(o.size, 0);
    const mtime = safeNum(o.mtime, 0);
    const name = clip(o.name, NAME_MAX) || basename(p);
    let id = clip(o.id, 64);
    if (!id) id = hashId(p + '|' + size + '|' + mtime + '|' + name);
    return {
        id: id, path: p, name: name,
        size: size, mtime: mtime,
        broken: o.broken === true
    };
}

function empty() { return { version: 1, links: [] }; }

// normalize：幂等、脏数据不抛。按 path 去重（同路径只留一条），保留最后 MAX_LINKS 条。
// 纯内存归一化，不做 fs I/O —— 否则同一份脏数据两次读盘结果可能不同，就不幂等了。
function normalize(state) {
    const src = obj(state);
    const seenPath = {};
    const seenId = {};
    const links = [];
    (Array.isArray(src.links) ? src.links : []).slice(-MAX_LINKS).forEach(function (x) {
        const one = normLink(x);
        if (!one) return;
        if (seenPath[one.path]) return;
        if (seenId[one.id]) return;
        seenPath[one.path] = true;
        seenId[one.id] = true;
        links.push(one);
    });
    return { version: 1, links: links };
}

// add(state, filePath)：存在则加入并返回新 state；文件不存在 / 路径无效 → 返回 null（不抛）。
// 路径去重：已存同一路径时返回等价 state，不重复添加。
function add(state, filePath) {
    const p = clip(filePath, PATH_MAX);
    if (!p) return null;
    let st;
    try {
        st = fs.statSync(p);
    } catch (e) {
        return null;
    }
    const s = normalize(state);
    if (s.links.some(function (l) { return l.path === p; })) return s;
    s.links.push({
        id: newId(),
        path: p,
        name: basename(p),
        size: safeNum(st.size, 0),
        mtime: safeNum(st.mtimeMs, 0),
        broken: false
    });
    return normalize(s);
}

// remove(state, id)：返回新 state。
function remove(state, id) {
    const s = normalize(state);
    const key = str(id);
    s.links = s.links.filter(function (l) { return l.id !== key; });
    return s;
}

function copyLink(l) {
    return { id: l.id, path: l.path, name: l.name, size: l.size, mtime: l.mtime, broken: l.broken };
}

// list(state)：只读副本数组，按 mtime 倒序。
function list(state) {
    return normalize(state).links.slice()
        .sort(function (a, b) { return b.mtime - a.mtime; })
        .map(copyLink);
}

// refresh(state)：重新 stat 一遍所有路径，刷新 size / mtime / broken。
// 「文件被移走后会失效」就靠它落地：建议在启动时调用一次。返回新 state，不改入参。
function refresh(state) {
    const s = normalize(state);
    s.links = s.links.map(function (l) {
        try {
            const st = fs.statSync(l.path);
            return {
                id: l.id, path: l.path, name: l.name,
                size: safeNum(st.size, 0), mtime: safeNum(st.mtimeMs, 0), broken: false
            };
        } catch (e) {
            return {
                id: l.id, path: l.path, name: l.name,
                size: l.size, mtime: l.mtime, broken: true
            };
        }
    });
    return s;
}

// reconnect(state, missingPath, candidates)：盘符变化时模糊重连。
// 规则：candidates 里找「同文件名 + 同 size」的第一个；命中则更新 path 并清 broken，
//       未命中则把该条 broken=true 标灰。任何情况都不自动删除记录、不改入参。
// candidates 元素可为路径字符串，或带 .path 的对象。
function reconnect(state, missingPath, candidates) {
    const s = normalize(state);
    const old = clip(missingPath, PATH_MAX);
    let idx = -1;
    for (let i = 0; i < s.links.length; i += 1) {
        if (s.links[i].path === old) { idx = i; break; }
    }
    if (idx < 0) return s; // 没有对应链接：原样返回
    const link = s.links[idx];
    const targetName = basename(old) || link.name;
    const cands = Array.isArray(candidates) ? candidates : [];
    let match = null;
    for (let i = 0; i < cands.length; i += 1) {
        const item = cands[i];
        const c = clip(typeof item === 'string' ? item : (item && item.path), PATH_MAX);
        if (!c) continue;
        let st;
        try { st = fs.statSync(c); } catch (e) { continue; }
        if (basename(c) === targetName && safeNum(st.size, 0) === link.size) {
            match = { c: c, st: st };
            break;
        }
    }
    if (match) {
        s.links[idx] = {
            id: link.id, path: match.c, name: basename(match.c),
            size: safeNum(match.st.size, 0), mtime: safeNum(match.st.mtimeMs, 0), broken: false
        };
    } else {
        const grey = copyLink(link);
        grey.broken = true;
        s.links[idx] = grey;
    }
    return normalize(s);
}

// mergeSection：跨机恢复，按 path 只补不改、幂等。返回 { state, added }。
function mergeSection(state, section) {
    const s = normalize(state);
    const incoming = normalize(section);
    const seenPath = {};
    const seenId = {};
    s.links.forEach(function (l) { seenPath[l.path] = true; seenId[l.id] = true; });
    let added = 0;
    incoming.links.forEach(function (l) {
        if (seenPath[l.path] || seenId[l.id]) return;
        s.links.push(l);
        seenPath[l.path] = true;
        seenId[l.id] = true;
        added += 1;
    });
    return { state: normalize(s), added: added };
}

module.exports = {
    MAX_LINKS: MAX_LINKS,
    empty: empty,
    normalize: normalize,
    add: add,
    remove: remove,
    list: list,
    refresh: refresh,
    reconnect: reconnect,
    mergeSection: mergeSection
};
