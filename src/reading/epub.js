'use strict';
// 本地电子书的元数据 / 封面提取：只用 Node 内置 fs + zlib，零第三方依赖。
//
// EPUB 本质是 ZIP。这里不引任何解压库，自己读中央目录 → 按条目 inflateRaw，
// 只取 container.xml / OPF / 封面图三个小文件；不把整本书读进渲染层。
// 安全边界：文件 ≤100MB、条目数 ≤20000、XML 解压上限 8MB、封面 ≤500KB、
// 条目名含 ".." 一律跳过（防 zip 路径穿越），只认图片扩展名。
// PDF / MOBI / TXT 不做解析（零依赖下无法可靠取封面），由主进程用文件名兜底。

const fs = require('fs');
const zlib = require('zlib');

const ALLOWED_EXTS = ['epub', 'pdf', 'txt', 'md', 'mobi', 'azw3'];
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_COVER_BYTES = 500 * 1024;
const MAX_ENTRIES = 20000;
const MAX_INFLATE = 16 * 1024 * 1024;                // 单条解压上限（含超长章节）
const OVERSIZE_BYTES = 2 * 1024 * 1024;             // 单章超过 2MB 记「超长」，降级但照读

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }
function str(v) { return typeof v === 'string' ? v : (v === 0 || v ? String(v) : ''); }

function extOf(p) {
    const m = /\.([a-z0-9]+)$/i.exec(str(p));
    return m ? m[1].toLowerCase() : '';
}
function isAllowed(p) { return ALLOWED_EXTS.indexOf(extOf(p)) >= 0; }

// 文件名去掉扩展名与常见尾巴，作为无 OPF 时的书名兜底
function titleFromPath(p) {
    const parts = str(p).split(/[\\/]/);
    let name = parts.length ? parts[parts.length - 1] : '';
    name = name.replace(/\.[a-z0-9]+$/i, '');
    name = name.replace(/[（(【\[].{0,30}?[)）】\]]\s*$/g, '').trim();
    return name.slice(0, 60);
}

function decodeXml(s) {
    return str(s)
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
        .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}
function firstTag(xml, tag) {
    const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
    const m = re.exec(xml);
    return m ? decodeXml(m[1]) : '';
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 返回 ZIP 中央目录条目（只记名字与偏移，不解压）
function centralDirectory(buf) {
    const min = Math.max(0, buf.length - 22 - 65535);
    let eocd = -1;
    for (let i = buf.length - 22; i >= min; i -= 1) {
        if (i + 22 <= buf.length && u32(buf, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = Math.min(u16(buf, eocd + 10), MAX_ENTRIES);
    let off = u32(buf, eocd + 16);
    const out = [];
    for (let i = 0; i < count; i += 1) {
        if (off + 46 > buf.length || u32(buf, off) !== 0x02014b50) break;
        const nameLen = u16(buf, off + 28);
        const extraLen = u16(buf, off + 30);
        const commentLen = u16(buf, off + 32);
        const end = off + 46 + nameLen;
        if (end > buf.length) break;
        out.push({
            name: buf.toString('utf8', off + 46, end).replace(/\\/g, '/'),
            method: u16(buf, off + 10),
            compressedSize: u32(buf, off + 20),
            size: u32(buf, off + 24),
            localOffset: u32(buf, off + 42)
        });
        off = end + extraLen + commentLen;
    }
    return out;
}

function entryData(buf, e) {
    if (!e || e.compressedSize === 0xffffffff || e.size > MAX_INFLATE) return null;
    const o = e.localOffset;
    if (o + 30 > buf.length || u32(buf, o) !== 0x04034b50) return null;
    const start = o + 30 + u16(buf, o + 26) + u16(buf, o + 28);
    if (start + e.compressedSize > buf.length) return null;
    const raw = buf.slice(start, start + e.compressedSize);
    if (e.method === 0) return raw;
    if (e.method !== 8) return null;
    try { return zlib.inflateRawSync(raw); } catch (_) { return null; }
}

/** 解析 EPUB，返回 { title, author, cover:{data:Buffer,ext}|null }；失败返回 null。 */
function inspect(filePath) {
    try {
        if (extOf(filePath) !== 'epub') return null;
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;
        const buf = fs.readFileSync(filePath);
        const entries = centralDirectory(buf);
        if (!entries || !entries.length) return null;
        const byName = {};
        entries.forEach(function (e) {
            if (e.name.indexOf('..') >= 0) return;
            byName[e.name.replace(/^\/+/, '')] = e;
        });
        const cx = entryData(buf, byName['META-INF/container.xml']);
        if (!cx) return null;
        const root = /rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(cx.toString('utf8'));
        const opfPath = root ? root[1] : Object.keys(byName).filter(function (n) { return /\.opf$/i.test(n); })[0];
        if (!opfPath) return null;
        const ox = entryData(buf, byName[opfPath.replace(/^\/+/, '')]);
        if (!ox) return null;
        const xml = ox.toString('utf8');

        let href = '';
        const meta = /<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(xml)
            || /<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']cover["'][^>]*>/i.exec(xml);
        if (meta) {
            const id = escapeRe(meta[1]);
            const item = new RegExp('<item\\b[^>]*id=["\']' + id + '["\'][^>]*href=["\']([^"\']+)["\'][^>]*>', 'i').exec(xml)
                || new RegExp('<item\\b[^>]*href=["\']([^"\']+)["\'][^>]*id=["\']' + id + '["\'][^>]*>', 'i').exec(xml);
            if (item) href = item[1];
        }
        if (!href) {
            const items = xml.match(/<item\b[^>]*>/gi) || [];
            for (let i = 0; i < items.length; i += 1) {
                if (/cover/i.test(items[i]) && /image\//i.test(items[i])) {
                    const h = /href=["']([^"']+)["']/i.exec(items[i]);
                    if (h) { href = h[1]; break; }
                }
            }
        }
        let cover = null;
        if (href) {
            let decoded = href;
            try { decoded = decodeURIComponent(href); } catch (_) { /* 保持原样 */ }
            const dir = opfPath.indexOf('/') >= 0 ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
            const full = (dir + decoded).replace(/\/+/g, '/').replace(/^\.\//, '');
            const ce = byName[full] || byName[full.replace(/^\.\//, '')];
            const extM = /\.(jpe?g|png|gif|webp)$/i.exec(ce ? ce.name : '');
            if (ce && extM && ce.compressedSize <= MAX_COVER_BYTES) {
                const data = entryData(buf, ce);
                if (data && data.length) {
                    cover = { data: data, ext: extM[1].toLowerCase() === 'jpeg' ? 'jpg' : extM[1].toLowerCase() };
                }
            }
        }
        return {
            title: firstTag(xml, 'dc:title'),
            author: firstTag(xml, 'dc:creator'),
            cover: cover
        };
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// 目录 + 章节正文：给独立阅读窗口用。仍只复用上面的 ZIP 内部件，不引任何新模块。
// 解析结果按「路径 + size + mtimeMs」只缓存最近 1 本，翻章不重读整本大文件。
// 输出统一净化为可安全塞进 iframe srcdoc 的完整 HTML 文档。
// ---------------------------------------------------------------------------

const MAX_CHAPTERS = 2000;
const MAX_CHAPTER_BYTES = MAX_INFLATE;                 // 单章解压上限 16MB
const MAX_IMG_COUNT = 30;
const MAX_IMG_BYTES = 6 * 1024 * 1024;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const PLACEHOLDER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const URL_ATTR_RE = /^(src|href|poster|xlink:href|background|data|action|formaction|cite|longdesc|usemap|icon|manifest|codebase|profile)$/i;
const IMG_ATTR_RE = /^(src|xlink:href|poster|background|data)$/i;
const BAD_URL_RE = /^\s*(?:javascript:|vbscript:|data:text\/html)/i;
const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

const BASE_CSS = [
    'html,body{margin:0;padding:0;}',
    'body{color:#2f2b26;background:#fff;line-height:1.8;-webkit-text-size-adjust:100%;}',
    'p{margin:0 0 .6em;}',
    'img,image,svg,video{max-width:100%;height:auto;}',
    'table{border-collapse:collapse;max-width:100%;}',
    'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f6f6;padding:12px;border-radius:4px;overflow:auto;}',
    'code{font-family:Consolas,Monaco,monospace;background:#f2f2f2;padding:0 .3em;border-radius:3px;}',
    'pre code{background:none;padding:0;}',
    'a{color:#2b6cb0;overflow-wrap:anywhere;}',
    '.chapter-title{margin-top:0;}'
].join('\n');

function mimeOf(ext) {
    const e = String(ext).toLowerCase();
    return (e === 'jpg' || e === 'jpeg') ? 'jpeg' : e;
}

// readBook 口径：相对 OPF 目录规范化，去锚点、解码；含 ".." 的穿越条目一律拒绝。
function normRel(href) {
    if (typeof href !== 'string') return null;
    let s = href.split('#')[0].split(String.fromCharCode(92)).join('/');
    try { s = decodeURIComponent(s); } catch (_) { /* 保持原样 */ }
    s = s.replace(/^\/+/, '');
    if (PROTOCOL_RE.test(s)) return null;
    if (!s) return null;
    const segs = s.split('/');
    const out = [];
    for (let i = 0; i < segs.length; i++) {
        const g = segs[i];
        if (g === '' || g === '.') continue;
        if (g === '..' || g.indexOf('..') >= 0) return null;
        out.push(g);
    }
    return out.length ? out.join('/') : null;
}

// 章内资源口径：相对章节文件所在目录解析，允许 ".." 回退但不许逃出包根。
function resolveZipPath(baseDir, href) {
    let s = String(href == null ? '' : href).split('#')[0].split(String.fromCharCode(92)).join('/');
    try { s = decodeURIComponent(s); } catch (_) { /* 保持原样 */ }
    s = s.replace(/^\/+/, '');
    if (PROTOCOL_RE.test(s)) return '';
    const segs = String(baseDir || '').concat(s).split('/');
    const out = [];
    for (let i = 0; i < segs.length; i++) {
        const g = segs[i];
        if (g === '' || g === '.') continue;
        if (g === '..') { if (!out.length) return ''; out.pop(); continue; }
        out.push(g);
    }
    return out.join('/');
}

// NCX：按 navPoint 出现顺序取目录，嵌套深度即 level（压到最多 2 层）。
function parseNcx(xml) {
    const out = [];
    const stack = [];
    let inText = false;
    let m;
    const re = /(<navPoint\b[^>]*>|<\/navPoint\s*>|<content\b[^>]*>|<text\b[^>]*>|<\/text\s*>|<navLabel\b[^>]*>|<\/navLabel\s*>)|([^<]+)/gi;
    while ((m = re.exec(xml)) !== null) {
        if (m[1]) {
            const t = m[1];
            if (/^<navPoint\b/i.test(t)) {
                const np = { title: '', href: '', level: Math.min(stack.length + 1, 2), _raw: '' };
                out.push(np);
                stack.push(np);
            } else if (/^<\/navPoint/i.test(t)) {
                stack.pop();
            } else if (/^<text\b/i.test(t)) {
                inText = true;
            } else if (/^<\/text/i.test(t)) {
                inText = false;
            } else if (/^<content\b/i.test(t)) {
                const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(t);
                if (src && stack.length) stack[stack.length - 1].href = src[1];
            }
        } else if (m[2] && inText && stack.length) {
            stack[stack.length - 1]._raw += m[2];
        }
    }
    out.forEach(function (np) { np.title = decodeXml(np._raw); delete np._raw; });
    return out;
}

// EPUB3 nav：优先 epub:type="toc" 的 nav，否则第一个 nav；按 ol 嵌套给 level。
function parseNav(xml) {
    const navs = xml.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi) || [];
    let body = '';
    for (let i = 0; i < navs.length; i++) {
        if (/epub:type\s*=\s*["'][^"']*toc/i.test(navs[i]) || /\btype\s*=\s*["']toc["']/i.test(navs[i])) { body = navs[i]; break; }
    }
    if (!body) body = navs[0] || '';
    if (!body) return [];
    body = body.replace(/^<nav\b[^>]*>/i, '').replace(/<\/nav>\s*$/i, '');
    const out = [];
    let depth = 0;
    let cur = null;
    let m;
    const re = /(<ol\b[^>]*>|<\/ol\s*>|<a\b[^>]*>|<\/a\s*>)|([^<]+)/gi;
    while ((m = re.exec(body)) !== null) {
        if (m[1]) {
            const t = m[1];
            if (/^<ol\b/i.test(t)) depth += 1;
            else if (/^<\/ol/i.test(t)) { if (depth > 0) depth -= 1; }
            else if (/^<a\b/i.test(t)) {
                const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(t);
                cur = { title: '', href: href ? href[1] : '', level: Math.min(depth || 1, 2), _raw: '' };
            } else if (/^<\/a/i.test(t)) {
                if (cur) { cur.title = decodeXml(cur._raw); out.push(cur); cur = null; }
            }
        } else if (m[2] && cur) {
            cur._raw += m[2];
        }
    }
    return out;
}

function parseBook(buf) {
    const entries = centralDirectory(buf);
    if (!entries || !entries.length) return { error: 'zip' };
    const byName = {};
    entries.forEach(function (e) {
        if (e.name.indexOf('..') >= 0) return;
        byName[e.name.replace(/^\/+/, '')] = e;
    });

    const cx = entryData(buf, byName['META-INF/container.xml']);
    let opfPath = '';
    if (cx) {
        const root = /rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(cx.toString('utf8'));
        if (root) opfPath = root[1];
    }
    if (!opfPath) {
        opfPath = Object.keys(byName).filter(function (n) { return /\.opf$/i.test(n); })[0] || '';
    }
    opfPath = resolveZipPath('', opfPath);
    if (!opfPath) return { error: 'opf' };
    const ox = entryData(buf, byName[opfPath]);
    if (!ox) return { error: 'opf' };
    const xml = ox.toString('utf8');
    const slash = opfPath.lastIndexOf('/');
    const opfDir = slash >= 0 ? opfPath.slice(0, slash + 1) : '';

    const byId = {};
    let ncxByType = '';
    let navRel = '';
    const items = xml.match(/<item\b[^>]*>/gi) || [];
    items.forEach(function (tag) {
        const idM = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag);
        const hrefM = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (!idM || !hrefM) return;
        const rel = normRel(hrefM[1]);
        if (rel === null) return;
        byId[idM[1].trim()] = rel;
        const mt = /media-type\s*=\s*["']([^"']+)["']/i.exec(tag);
        const props = /properties\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (mt && /application\/x-dtbncx\+xml/i.test(mt[1])) ncxByType = rel;
        if (props && /(^|\s)nav(\s|$)/i.test(props[1])) navRel = rel;
    });

    const spineM = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(xml);
    const spineTag = spineM ? spineM[0] : '';
    const spineBody = spineM ? spineM[1] : xml;
    const tocId = (/\btoc\s*=\s*["']([^"']+)["']/i.exec(spineTag) || [])[1] || '';
    const refs = spineBody.match(/<itemref\b[^>]*>/gi) || [];
    const chapters = [];
    const chapterFull = [];
    refs.forEach(function (tag) {
        if (chapters.length >= MAX_CHAPTERS) return;
        const idref = (/\bidref\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
        const rel = idref ? byId[idref.trim()] : undefined;
        if (!rel) return;
        chapters.push({ id: 'ch-' + chapters.length, title: '', href: rel });
        chapterFull.push(opfDir + rel);
    });

    const ncxRel = (tocId && byId[tocId.trim()]) || ncxByType || '';
    let rows = [];
    if (ncxRel) {
        const ne = byName[opfDir + ncxRel];
        const nd = ne ? entryData(buf, ne) : null;
        if (nd) rows = parseNcx(nd.toString('utf8'));
    }
    if (!rows.length && navRel) {
        const ve = byName[opfDir + navRel];
        const vd = ve ? entryData(buf, ve) : null;
        if (vd) rows = parseNav(vd.toString('utf8'));
    }
    if (!rows.length) {
        rows = chapters.map(function (c, i) {
            return { title: '第 ' + (i + 1) + ' 节', href: c.href, level: 1 };
        });
    }

    const toc = [];
    rows.forEach(function (row) {
        const rel = normRel(row.href);
        if (rel === null) return;
        let index = -1;
        for (let i = 0; i < chapters.length; i++) {
            if (chapters[i].href === rel) { index = i; break; }
        }
        if (index < 0) return;
        const t = str(row.title).trim();
        toc.push({
            id: 'toc-' + toc.length,
            title: t,
            level: Math.min(2, Math.max(1, Number(row.level) || 1)),
            index: index
        });
        if (t && !chapters[index].title) chapters[index].title = t;
    });
    chapters.forEach(function (c, i) { if (!c.title) c.title = '第 ' + (i + 1) + ' 节'; });

    return {
        byName: byName,
        chapters: chapters,
        chapterFull: chapterFull,
        toc: toc,
        title: firstTag(xml, 'dc:title'),
        author: firstTag(xml, 'dc:creator')
    };
}

let _bookCache = null;

// 命中缓存时再抽样比对文件头，避免文件被替换（size / mtimeMs 恰好相同）后读到旧内容。
function sampleMatches(filePath, buf, size) {
    try {
        const n = Math.min(64, size);
        const fd = fs.openSync(filePath, 'r');
        const sample = Buffer.alloc(n);
        try { fs.readSync(fd, sample, 0, n, 0); } finally { fs.closeSync(fd); }
        return Buffer.compare(sample, buf.slice(0, n)) === 0;
    } catch (_) {
        return false;
    }
}

function loadBook(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch (_) { return { error: 'file' }; }
    if (!stat.isFile()) return { error: 'file' };
    if (stat.size === 0 || stat.size > MAX_FILE_BYTES) return { error: 'size' };
    const key = String(filePath) + '|' + stat.size + '|' + stat.mtimeMs;
    if (_bookCache && _bookCache.key === key) {
        if (sampleMatches(filePath, _bookCache.buf, stat.size)) return _bookCache;
        _bookCache = null;
    }
    let buf;
    try { buf = fs.readFileSync(filePath); } catch (_) { return { error: 'file' }; }
    const parsed = parseBook(buf);
    const entry = { key: key, buf: buf };
    Object.keys(parsed).forEach(function (k) { entry[k] = parsed[k]; });
    _bookCache = entry;                 // 只保留最近 1 本
    return entry;
}

function failReason(err) {
    if (err === 'file') return '文件不存在或不是普通文件';
    if (err === 'size') return '文件为空或超过 100MB';
    if (err === 'zip') return '无法读取 ZIP 中央目录（可能不是有效 EPUB）';
    if (err === 'opf') return '缺少 OPF 或无法定位 OPF';
    return '解析失败';
}

function emptyBook(reason) {
    return { ok: false, reason: reason, format: 'epub', title: '', author: '', toc: [], chapterCount: 0, chapters: [] };
}

function readBook(filePath) {
    try {
        if (extOf(filePath) !== 'epub') return emptyBook('不是 EPUB 文件');
        const b = loadBook(filePath);
        if (b.error) return emptyBook(failReason(b.error));
        return {
            ok: true,
            reason: '',
            format: 'epub',
            title: b.title || titleFromPath(filePath),
            author: b.author,
            toc: b.toc.map(function (t) { return { id: t.id, title: t.title, level: t.level, index: t.index }; }),
            chapterCount: b.chapters.length,
            chapters: b.chapters.map(function (c) { return { id: c.id, title: c.title, href: c.href }; })
        };
    } catch (_) {
        return emptyBook('解析失败');
    }
}

// ---------- 章节正文净化 ----------

// 书内行内样式只放行「语义类」属性。字号 / 字体 / 行距 / 颜色 / 背景一律剥掉：
// 这几样必须由阅读器的排印基线统一接管，否则书的样式与用户设置互相打架，
// 同一本书在不同机器上两种样（docs/15 §2 结论：完全接管才可预期、可测试）。
const INLINE_KEEP = /^(?:text-align|text-decoration|font-weight|font-style|vertical-align|max-width|min-width|width|height|border|border-collapse|border-width|border-style|border-color)$/i;

function cleanInlineStyle(css) {
    return cleanStyle(css).split(';').map(function (decl) {
        const i = decl.indexOf(':');
        if (i < 0) return '';
        const k = decl.slice(0, i).trim();
        let v = decl.slice(i + 1).trim();
        if (!k || !v || !INLINE_KEEP.test(k)) return '';
        if (/^font-style$/i.test(k)) return /italic|oblique/i.test(v) ? 'font-style:normal' : 'font-style:' + v;
        if (/^text-align$/i.test(k)) return /^(?:left|center|right)$/i.test(v) ? 'text-align:' + v : '';
        if (/(?:expression|javascript|url\s*\()/i.test(v)) return '';
        return k + ':' + v;
    }).filter(Boolean).join(';');
}

function cleanStyle(css) {
    return String(css == null ? '' : css)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@import[^;{}]*;?/gi, '')
        .replace(/expression\s*\([^)]*\)/gi, '')
        .replace(/expression\s*\(/gi, '')
        .replace(/url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi, 'none')
        .replace(/(?:javascript|vbscript)\s*:/gi, '');
}

function inlineImage(v, ctx) {
    if (ctx.imgCount >= MAX_IMG_COUNT || ctx.imgBytes >= MAX_IMG_BYTES) return null;
    const full = resolveZipPath(ctx.chapterDir, v);
    if (!full) return null;
    const m = IMG_EXT_RE.exec(full);
    if (!m) return null;
    const e = ctx.byName[full];
    if (!e || e.size > MAX_IMG_BYTES) return null;
    const data = entryData(ctx.buf, e);
    if (!data || !data.length || ctx.imgBytes + data.length > MAX_IMG_BYTES) return null;
    ctx.imgCount += 1;
    ctx.imgBytes += data.length;
    return 'data:image/' + mimeOf(m[1]) + ';base64,' + data.toString('base64');
}

function cleanUrl(name, val, ctx, tag) {
    const v = String(val == null ? '' : val).trim();
    const ln = name.toLowerCase();
    if (BAD_URL_RE.test(v)) return '#';
    if (/^data:image\//i.test(v)) return v;                  // 书里本来就是内联图
    const external = /^(?:https?:)?\/\//i.test(v) || PROTOCOL_RE.test(v);
    const asImage = IMG_ATTR_RE.test(name) && !(ln.indexOf('href') >= 0 && /^a$/i.test(tag));
    if (asImage) return external ? PLACEHOLDER_PNG : (inlineImage(v, ctx) || PLACEHOLDER_PNG);
    return external ? '#' : v;
}

function cleanAttrs(tag, attrs, ctx) {
    const list = [];
    let m;
    const re = /([^\s=/>"']+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g;
    while ((m = re.exec(attrs)) !== null) {
        const name = m[1];
        const raw = m[2];
        let val = raw;
        if (raw && (raw.charAt(0) === '"' || raw.charAt(0) === "'")) val = raw.slice(1, -1);
        const ln = name.toLowerCase();
        if (/^on[a-z0-9_:-]*$/i.test(name)) continue;         // 事件属性一律删
        if (/^xmlns/i.test(name)) continue;                    // 命名空间声明可能带 http://
        if (ln === 'srcset') continue;                         // 多 URL 属性直接去掉
        if (ln === 'style') {
            const cs = cleanInlineStyle(val);      // 只留语义属性，其余交给排印基线
            if (cs) list.push([name, cs]);
        }
        else if (URL_ATTR_RE.test(name)) {
            const nv = cleanUrl(name, val, ctx, tag);
            if (nv === null) continue;
            list.push([name, nv]);
        } else if (raw == null) list.push([name, null]);
        else if (val != null && (BAD_URL_RE.test(val) || /:\/\//.test(val) || /^\/\//.test(val))) list.push([name, '#']);
        else list.push([name, val]);
    }
    if (/^(img|image)$/i.test(tag)) {
        let found = false;
        for (let i = 0; i < list.length; i++) {
            if (list[i][0].toLowerCase() === 'style') {
                list[i][1] = String(list[i][1] || '').replace(/;?\s*$/, '') + ';max-width:100%;height:auto';
                found = true;
                break;
            }
        }
        if (!found) list.push(['style', 'max-width:100%;height:auto']);
    }
    return list.map(function (a) {
        if (a[1] === null) return ' ' + a[0];
        return ' ' + a[0] + '="' + String(a[1])
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;') + '"';
    }).join('');
}

function sanitizeFragment(frag, ctx) {
    let s = String(frag == null ? '' : frag)
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<script\b[^>]*>/gi, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
        .replace(/<iframe\b[^>]*>/gi, '')
        .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '')
        .replace(/<object\b[^>]*>/gi, '')
        .replace(/<embed\b[^>]*>/gi, '')
        .replace(/<link\b[^>]*>/gi, '')
        .replace(/<base\b[^>]*>/gi, '')
        .replace(/<meta\b[^>]*>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
        .replace(/<style\b[^>]*>/gi, '');
    s = s.replace(/<([a-z][a-z0-9:-]*)\b([^>]*)>/gi, function (all, tag, attrs) {
        return '<' + tag + cleanAttrs(tag, attrs, ctx) + '>';
    });
    return s;
}

function extractStyles(src) {
    const out = [];
    let m;
    const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
    while ((m = re.exec(src)) !== null) out.push(cleanStyle(m[1]));
    return out.join('\n');
}

function extractBody(src) {
    const m = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(src);
    if (m) return m[1];
    return String(src)
        .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
        .replace(/<\/?(?:html|body)\b[^>]*>/gi, '');
}

// 书内 <style> 块整体丢弃：只测量体积用于统计，不注入。
// 理由（docs/15 §2 / §7）：多看、微信读书都强制覆盖书内样式；九格若「部分放行」，
// 书的 line-height、font-size、background 会与用户设置打架，且不可测试。
function buildHtml(rawXml, ctx) {
    const src = String(rawXml == null ? '' : rawXml);
    const droppedCss = extractStyles(src);
    const noStyle = src.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    const body = sanitizeFragment(extractBody(noStyle), ctx);
    return {
        html: '<!doctype html><html><head><meta charset="utf-8"><style>\n' +
            BASE_CSS + '\n</style></head><body>' + body + '</body></html>',
        cssBytes: droppedCss.length
    };
}

function readChapter(filePath, index) {
    try {
        if (extOf(filePath) !== 'epub') return { ok: false, title: '', html: '' };
        const b = loadBook(filePath);
        if (b.error) return { ok: false, title: '', html: '' };
        const idx = Math.trunc(Number(index));
        if (!isFinite(idx) || idx < 0 || idx >= b.chapters.length) return { ok: false, title: '', html: '' };
        const full = b.chapterFull[idx];
        const e = b.byName[full];
        if (!e) return { ok: false, title: '', html: '' };
        const data = entryData(b.buf, e);
        if (!data) return { ok: false, title: '', html: '', bytes: 0, reason: '章节解压失败' };
        if (data.length > MAX_CHAPTER_BYTES) {
            return { ok: false, title: '', html: '', bytes: data.length,
                reason: '本章解压后 ' + Math.round(data.length / 1048576) + 'MB，超过 16MB 上限，暂不支持内置渲染' };
        }
        const oversize = data.length > OVERSIZE_BYTES;
        const slash = full.lastIndexOf('/');
        const ctx = {
            buf: b.buf,
            byName: b.byName,
            chapterDir: slash >= 0 ? full.slice(0, slash + 1) : '',
            imgCount: 0,
            imgBytes: 0
        };
        const built = buildHtml(data.toString('utf8'), ctx);
        return {
            ok: true,
            title: b.chapters[idx].title,
            html: built.html,
            bytes: data.length,
            oversize: oversize,
            cssBytes: built.cssBytes
        };
    } catch (_) {
        return { ok: false, title: '', html: '', bytes: 0, reason: '章节解析异常' };
    }
}

module.exports = {
    ALLOWED_EXTS: ALLOWED_EXTS,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_COVER_BYTES: MAX_COVER_BYTES,
    extOf: extOf,
    isAllowed: isAllowed,
    titleFromPath: titleFromPath,
    inspect: inspect,
    // 给 golden 用例用的内部件：拼一个最小合法 ZIP，才能真验证解析而不是断言常量
    _zip: { centralDirectory: centralDirectory, entryData: entryData },
    readBook: readBook,
    readChapter: readChapter
};
