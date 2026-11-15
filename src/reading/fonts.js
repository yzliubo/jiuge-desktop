'use strict';
// 本机字体清单：只读系统字体目录，解析 TTF / OTF / TTC 的 name 表，零依赖、零子进程。
//
// ---- 为什么不照 mybook 的 PowerShell + GDI 那条路 ----
// 那条路能跑通，但要用 Base64 中转：Windows PowerShell 5.1 往管道输出时用的是控制台
// OEM 代码页（简体中文即 GBK / 936），按 UTF-8 解码会把「宋体」「微软雅黑」变成一串问号。
// 而且每开一次阅读设置就 spawn 一次进程，代价和收益不成比例。
// 直接从字体文件的字节里取族名，本身就是 UTF-16BE，不存在编码问题。
//
// ---- 为什么 nameID 1 和 16 都要收 ----
// 新式字体（如阿里健康体）把「全族名」与「推荐族名」分开写：nameID 1 带字重后缀
// （"阿里健康体2.0 中文 45 R"），而 Chromium / DirectWrite 按 CSS font-family 匹配的是
// nameID 16（"阿里健康体2.0 中文"）。只收 1 会让这一类字体在样式表里永远命中不了。

const fs = require('fs');
const path = require('path');

const FAMILY_MAX = 64;
const MAX_SCAN = 800;
const MAX_LIST = 600;

let cache = null;

// 定长位置读：读不满就返回已有的部分，调用方自己判长度
function readAt(fd, pos, len) {
    if (len <= 0) return Buffer.alloc(0);
    const b = Buffer.alloc(len);
    let got = 0;
    try { got = fs.readSync(fd, b, 0, len, pos); } catch (_) { return null; }
    return got < len ? b.subarray(0, got) : b;
}

// 返回 { family, zh, en }；解析不出来一律 null（坏字体不能让整次枚举失败）
function parseNames(file) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const head = readAt(fd, 0, 12);
        if (!head || head.length < 12) return null;
        const tag = head.toString('latin1', 0, 4);
        let base = 0;
        if (tag === 'ttcf') {
            // 字体集合：只取第一套字，够用来当族名
            const ofs = readAt(fd, 12, 4);
            if (!ofs || ofs.length < 4) return null;
            base = ofs.readUInt32BE(0);
        } else if (tag !== 'true' && tag !== 'OTTO' && head.readUInt32BE(0) !== 0x00010000) {
            return null;
        }
        const nt = readAt(fd, base + 4, 2);
        if (!nt || nt.length < 2) return null;
        const numTables = nt.readUInt16BE(0);
        if (numTables < 1 || numTables > 256) return null;
        const dir = readAt(fd, base + 12, numTables * 16);
        if (!dir || dir.length < numTables * 16) return null;
        let nameOff = 0;
        for (let i = 0; i < numTables; i += 1) {
            const off = i * 16;
            if (dir.toString('latin1', off, off + 4) === 'name') {
                nameOff = dir.readUInt32BE(off + 8);
                break;
            }
        }
        if (!nameOff) return null;
        const nh = readAt(fd, nameOff, 6);
        if (!nh || nh.length < 6) return null;
        const count = nh.readUInt16BE(2);
        const strOff = nameOff + nh.readUInt16BE(4);
        if (!count || count > 512) return null;
        const recs = readAt(fd, nameOff + 6, count * 12);
        if (!recs) return null;

        let zh1 = '', en1 = '', zh16 = '', en16 = '';
        for (let i = 0; i < count; i += 1) {
            const r = i * 12;
            const platform = recs.readUInt16BE(r);
            // 只认 UTF-16BE：Windows(3) 与 Unicode(0) 平台；Mac(1) 是 latin1，中文族名取不到
            if (platform !== 3 && platform !== 0) continue;
            const lang = recs.readUInt16BE(r + 4);
            const nameID = recs.readUInt16BE(r + 6);
            if (nameID !== 1 && nameID !== 16) continue;
            const len = recs.readUInt16BE(r + 8);
            const off = recs.readUInt16BE(r + 10);
            if (!len || len > 512 || len % 2) continue;
            const raw = readAt(fd, strOff + off, len);
            if (!raw || raw.length < len) continue;
            const s = raw.swap16().toString('utf16le').replace(/\0+$/, '').trim();
            if (!s) continue;
            const isZh = (lang === 0x0804 || lang === 0x0404 || lang === 0x0c04 || lang === 0x1004);
            if (nameID === 16) {
                if (isZh) { if (!zh16) zh16 = s; } else if (!en16) en16 = s;
            } else if (isZh) { if (!zh1) zh1 = s; } else if (!en1) en1 = s;
        }
        const family = zh16 || en16 || zh1 || en1;
        if (!family) return null;
        return { family: family.slice(0, FAMILY_MAX), zh: zh16 || zh1, en: en16 || en1 };
    } catch (_) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* 关不掉也不影响结果 */ } }
    }
}

function fontDirs() {
    const out = [];
    if (process.platform === 'win32') {
        out.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
        if (process.env.LOCALAPPDATA) {
            // 用户级安装（右键「为当前用户安装」）落在这里，系统目录里没有
            out.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
        }
    } else if (process.platform === 'darwin') {
        out.push('/System/Library/Fonts', '/Library/Fonts');
        if (process.env.HOME) out.push(path.join(process.env.HOME, 'Library', 'Fonts'));
    } else {
        if (process.env.HOME) {
            out.push(path.join(process.env.HOME, '.fonts'), path.join(process.env.HOME, '.local', 'share', 'fonts'));
        }
        out.push('/usr/share/fonts', '/usr/local/share/fonts');
    }
    return out;
}

// 递归最多两层就够：Windows\Fonts 是平铺的，Linux 才有 usr/share/fonts/<厂商>/<系列>/
function collect(dir, depth, out) {
    if (!dir || depth > 2 || out.length >= MAX_SCAN) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
        if (out.length >= MAX_SCAN) return;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { collect(p, depth + 1, out); continue; }
        if (!/\.(ttf|otf|ttc)$/i.test(ent.name)) continue;
        out.push(p);
    }
}

function list() {
    if (cache) return cache.slice();
    const files = [];
    fontDirs().forEach(function (d) { collect(d, 0, files); });
    const seen = {};
    const names = [];
    for (const f of files) {
        const n = parseNames(f);
        if (!n) continue;
        // 竖排变体以 @ 开头，CSS 里用不了；同族多字重只留一条
        if (n.family.charAt(0) === '@') continue;
        const key = n.family.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        names.push(n.family);
        if (names.length >= MAX_LIST) break;
    }
    // 中文按拼音、西文按字母；中文名排在后面更好找（localeCompare 的 zh-Hans-CN 就这个效果）
    names.sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' }); });
    cache = names;
    return names.slice();
}

module.exports = { list: list, parseNames: parseNames };
