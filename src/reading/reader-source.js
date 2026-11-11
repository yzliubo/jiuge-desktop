'use strict';
// 独立阅读窗口的统一取数层：只认本地文件，零第三方依赖。
// EPUB 委托 epub.readBook / readChapter；TXT / MD 本地分章并渲染安全 HTML；
// PDF / MOBI / AZW3 在零依赖下只登记书目，不渲染正文。

const fs = require('fs');
const epub = require('./epub');

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const OVERSIZE_BYTES = 2 * 1024 * 1024;      // 与 epub.js 同口径：单章超 2MB 视为超长
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const UNSUPPORTED_REASON = 'PDF / MOBI / AZW3 在零依赖、纯本地的前提下无法可靠渲染正文，暂只登记书目与笔记';

const FORMATS = {
    epub: { supported: true,  kind: 'epub',        note: '解析 OPF / NCX / nav 目录与 XHTML 正文' },
    txt:  { supported: true,  kind: 'text',        note: '按章节标题或约 1500 字分章，纯文本渲染' },
    md:   { supported: true,  kind: 'text',        note: '按 Markdown 标题分章，极简渲染' },
    pdf:  { supported: false, kind: 'unsupported', note: UNSUPPORTED_REASON },
    mobi: { supported: false, kind: 'unsupported', note: UNSUPPORTED_REASON },
    azw3: { supported: false, kind: 'unsupported', note: UNSUPPORTED_REASON }
};

// 与 epub 章节同口径的基础阅读样式；字号留给外层窗口改 body.style，不写死 font-size。
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

function str(v) { return typeof v === 'string' ? v : (v === 0 || v ? String(v) : ''); }

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 正文里万一出现 on*= / javascript: 之类的纯文本，也用实体中和，保证输出扫不出危险字面量。
function neutralize(s) {
    return String(s == null ? '' : s)
        .replace(/\bon[a-z0-9_:-]*\s*=/gi, function (m) { return m.replace(/=/g, '&#61;'); })
        .replace(/javascript\s*:/gi, 'javascript&#58;');
}

function decodeText(buf) {
    const utf8 = buf.toString('utf8');
    let bad = 0;
    for (let i = 0; i < utf8.length; i++) {
        if (utf8.charCodeAt(i) === 0xfffd) bad += 1;
    }
    if (utf8.length && bad / utf8.length > 0.005) {
        try {
            const gbk = new TextDecoder('gbk').decode(buf);
            if (gbk) return gbk.replace(/^\uFEFF/, '');
        } catch (_) { /* 运行时不支持 gbk 时回退 UTF-8 */ }
    }
    return utf8.replace(/^\uFEFF/, '');
}

function splitByLength(text, size) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        if (text.length - i <= size) { out.push(text.slice(i)); break; }
        const from = i + Math.floor(size * 0.6);
        const to = Math.min(i + size + 200, text.length);
        const seg = text.slice(from, to);
        const re = /\n[ \t]*\n/g;
        let m, last = -1;
        while ((m = re.exec(seg)) !== null) last = from + m.index + m[0].length;
        let cut = last > i ? last : i + size;
        if (cut <= i) cut = i + size;
        out.push(text.slice(i, cut));
        i = cut;
    }
    if (!out.length) out.push(text);
    return out;
}

function splitChapters(text, isMd) {
    const heads = [];
    const re = isMd
        ? /^(#{1,3})[ \t]+(.+)$/gm
        : /^[ \t\u3000]*第[一二三四五六七八九十百千零〇两0-9]{1,8}[章节卷部篇回集](?:[ \t\u3000]*[^\n]{0,40})?$/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
        heads.push({ start: m.index, end: re.lastIndex, title: str(m[2] || m[0]).trim() });
    }
    const parts = [];
    if (heads.length) {
        if (heads[0].start > 0) {
            const pre = text.slice(0, heads[0].start).trim();
            if (pre) parts.push({ title: '', body: pre });
        }
        for (let i = 0; i < heads.length; i++) {
            const end = (i + 1 < heads.length) ? heads[i + 1].start : text.length;
            parts.push({ title: heads[i].title, body: text.slice(heads[i].end, end).trim() });
        }
    } else {
        splitByLength(text, 1500).forEach(function (b) {
            parts.push({ title: '', body: b.trim() });
        });
    }
    if (!parts.length) parts.push({ title: '', body: text.trim() });
    return parts;
}

function inlineMd(s) {
    return String(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderMarkdown(raw) {
    let text = esc(raw);
    const codes = [];
    text = text.replace(/```[ \t]*\n?([\s\S]*?)```/g, function (_, code) {
        codes.push('<pre><code>' + code.replace(/\n+$/, '') + '</code></pre>');
        return '\n\n\u0000CODE' + (codes.length - 1) + '\u0000\n\n';
    });
    const blocks = text.split(/\n[ \t]*\n+/);
    let html = blocks.map(function (block) {
        const b = block.trim();
        if (!b) return '';
        if (/^\u0000CODE\d+\u0000$/.test(b)) return b;
        const lines = b.split('\n');
        if (/^#{1,3}[ \t]+/.test(lines[0])) {
            return lines.map(function (ln) {
                const h = /^(#{1,3})[ \t]+(.+)$/.exec(ln);
                return h
                    ? ('<h' + h[1].length + '>' + inlineMd(h[2]) + '</h' + h[1].length + '>')
                    : ('<p>' + inlineMd(ln) + '</p>');
            }).join('\n');
        }
        if (/^[ \t]*[-*][ \t]+/.test(lines[0])) {
            return '<ul>' + lines.map(function (ln) {
                const li = /^[ \t]*[-*][ \t]+(.+)$/.exec(ln);
                return li ? ('<li>' + inlineMd(li[1]) + '</li>') : '';
            }).join('') + '</ul>';
        }
        if (/^[ \t]*\d+\.[ \t]+/.test(lines[0])) {
            return '<ol>' + lines.map(function (ln) {
                const li = /^[ \t]*\d+\.[ \t]+(.+)$/.exec(ln);
                return li ? ('<li>' + inlineMd(li[1]) + '</li>') : '';
            }).join('') + '</ol>';
        }
        if (/^[ \t]*&gt;[ \t]?/.test(lines[0])) {
            return '<blockquote>' + lines.map(function (ln) {
                return inlineMd(ln.replace(/^[ \t]*&gt;[ \t]?/, ''));
            }).join('<br>') + '</blockquote>';
        }
        return '<p>' + lines.map(inlineMd).join('<br>') + '</p>';
    }).join('\n');
    html = html.replace(/\u0000CODE(\d+)\u0000/g, function (_, n) { return codes[Number(n)] || ''; });
    return html;
}

function renderPlain(raw) {
    const text = esc(raw);
    return text.split(/\n[ \t]*\n+/).map(function (para) {
        const p = para.trim();
        return p ? ('<p>' + p.split('\n').join('<br>') + '</p>') : '';
    }).join('\n');
}

function buildTextHtml(title, bodyHtml) {
    const safeTitle = neutralize(esc(title));
    const safeBody = neutralize(bodyHtml);
    return '<!doctype html><html><head><meta charset="utf-8"><style>\n' +
        BASE_CSS + '\n</style></head><body><h1 class="chapter-title">' +
        safeTitle + '</h1>' + safeBody + '</body></html>';
}

let _textCache = null;

function sampleMatchesText(filePath, head, size) {
    try {
        const n = Math.min(64, size);
        const fd = fs.openSync(filePath, 'r');
        const sample = Buffer.alloc(n);
        try { fs.readSync(fd, sample, 0, n, 0); } finally { fs.closeSync(fd); }
        return Buffer.compare(sample, head.slice(0, n)) === 0;
    } catch (_) {
        return false;
    }
}

function loadText(filePath, ext) {
    let stat;
    try { stat = fs.statSync(filePath); } catch (_) { return null; }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const key = String(filePath) + '|' + stat.size + '|' + stat.mtimeMs;
    if (_textCache && _textCache.key === key) {
        if (sampleMatchesText(filePath, _textCache.head, stat.size)) return _textCache;
        _textCache = null;
    }
    let buf;
    try {
        const n = Math.min(stat.size, MAX_TEXT_BYTES);
        const fd = fs.openSync(filePath, 'r');
        buf = Buffer.alloc(n);
        try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
    } catch (_) { return null; }
    const text = decodeText(buf);
    const isMd = ext === 'md';
    const parts = splitChapters(text, isMd);
    const toc = [], chapters = [], bodies = [];
    parts.forEach(function (p, i) {
        const title = p.title || ('第 ' + (i + 1) + ' 节');
        toc.push({ id: 'ch-' + i, title: title, level: 1, index: i });
        chapters.push({ id: 'ch-' + i, title: title });
        bodies.push({ isMd: isMd, raw: p.body });
    });
    const entry = {
        key: key,
        ext: ext,
        head: buf.slice(0, 64),
        toc: toc,
        chapters: chapters,
        bodies: bodies,
        title: epub.titleFromPath(filePath)
    };
    _textCache = entry;                 // 文本分章结果也只缓存最近 1 本
    return entry;
}

function emptyResult(reason) {
    return {
        ok: false, supported: false, reason: reason, kind: 'unsupported',
        format: '', title: '', author: '', toc: [], chapterCount: 0, chapters: []
    };
}

function cloneToc(t) { return { id: t.id, title: t.title, level: t.level, index: t.index }; }

function openBook(filePath) {
    try {
        let stat;
        try { stat = fs.statSync(filePath); } catch (_) { return emptyResult('文件不存在'); }
        if (!stat.isFile()) return emptyResult('不是普通文件');
        if (stat.size > MAX_FILE_BYTES) return emptyResult('文件超过 100MB');
        const ext = epub.extOf(filePath).toLowerCase();
        const fmt = FORMATS[ext];
        if (ext === 'epub') {
            const r = epub.readBook(filePath);
            if (!r.ok) {
                return Object.assign(emptyResult(r.reason || 'EPUB 解析失败'), {
                    kind: 'epub', format: 'epub', title: epub.titleFromPath(filePath)
                });
            }
            return {
                ok: true, supported: true, reason: '', kind: 'epub', format: 'epub',
                title: r.title, author: r.author,
                toc: r.toc.map(cloneToc),
                chapterCount: r.chapterCount,
                chapters: r.chapters.map(function (c) { return { id: c.id, title: c.title }; })
            };
        }
        if (ext === 'txt' || ext === 'md') {
            const t = loadText(filePath, ext);
            if (!t) {
                return Object.assign(emptyResult('文本文件读取失败'), {
                    kind: 'text', format: ext, title: epub.titleFromPath(filePath)
                });
            }
            return {
                ok: true, supported: true, reason: '', kind: 'text', format: ext,
                title: t.title, author: '',
                toc: t.toc.map(cloneToc),
                chapterCount: t.chapters.length,
                chapters: t.chapters.map(function (c) { return { id: c.id, title: c.title }; })
            };
        }
        if (fmt && fmt.kind === 'unsupported') {
            return {
                ok: true, supported: false, reason: UNSUPPORTED_REASON, kind: 'unsupported', format: ext,
                title: epub.titleFromPath(filePath), author: '', toc: [], chapterCount: 0, chapters: []
            };
        }
        return Object.assign(emptyResult('不支持的文件类型'), {
            format: ext, title: epub.titleFromPath(filePath)
        });
    } catch (_) {
        return emptyResult('读取失败');
    }
}

function chapter(filePath, index) {
    try {
        const ext = epub.extOf(filePath).toLowerCase();
        if (ext === 'epub') {
            const r = epub.readChapter(filePath, index);
            return {
                ok: !!r.ok,
                html: r.ok ? r.html : '',
                title: r.ok ? r.title : '',
                bytes: r.bytes || 0,
                oversize: !!r.oversize,
                cssBytes: r.cssBytes || 0,
                reason: r.reason || ''
            };
        }
        if (ext === 'txt' || ext === 'md') {
            const t = loadText(filePath, ext);
            if (!t) return { ok: false, html: '', title: '' };
            const i = Math.trunc(Number(index));
            if (!isFinite(i) || i < 0 || i >= t.bodies.length) return { ok: false, html: '', title: '' };
            const body = t.bodies[i];
            const bodyHtml = body.isMd ? renderMarkdown(body.raw) : renderPlain(body.raw);
            return {
                ok: true,
                html: buildTextHtml(t.chapters[i].title, bodyHtml),
                title: t.chapters[i].title,
                bytes: bodyHtml.length,
                oversize: bodyHtml.length > OVERSIZE_BYTES,
                cssBytes: 0,
                reason: ''
            };
        }
        return { ok: false, html: '', title: '' };
    } catch (_) {
        return { ok: false, html: '', title: '' };
    }
}

// 书内搜索：逐章取 HTML → 去标签成纯文本 → 不区分大小写找关键词。
// 只读、不落库；命中带前后文，UI 直接展示，点一下按 chapterIndex 跳章。
function plainText(html) {
    return str(html)
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function search(filePath, keyword, limit) {
    const kw = str(keyword).trim();
    if (!kw) return { ok: false, reason: '请输入要查找的词', hits: [], total: 0 };
    const info = openBook(filePath);
    if (!info.ok) return { ok: false, reason: info.reason || '打不开这本书', hits: [], total: 0 };
    if (!info.supported) return { ok: false, reason: info.reason || '该格式暂不支持搜索正文', hits: [], total: 0 };
    const max = Math.max(1, Math.min(Number(limit) || 30, 60));
    const total = Math.min(info.chapterCount, 300);
    const lowerKw = kw.toLowerCase();
    const hits = [];
    let sum = 0;
    for (let i = 0; i < total; i += 1) {
        if (hits.length >= max) break;
        const c = chapter(filePath, i);
        if (!c.ok) continue;
        const text = plainText(c.html);
        const lower = text.toLowerCase();
        let from = 0;
        let at = lower.indexOf(lowerKw, from);
        while (at >= 0) {
            sum += 1;
            if (hits.length < max) {
                const s = Math.max(0, at - 28);
                const e = Math.min(text.length, at + kw.length + 28);
                hits.push({
                    chapterIndex: i,
                    title: c.title || ('第 ' + (i + 1) + ' 节'),
                    snippet: (s > 0 ? '…' : '') + text.slice(s, e) + (e < text.length ? '…' : ''),
                    offset: at
                });
            }
            from = at + lowerKw.length;
            if (sum >= 200) break;
            at = lower.indexOf(lowerKw, from);
        }
        if (sum >= 200) break;
    }
    return { ok: true, hits: hits, total: sum, keyword: kw };
}

module.exports = {
    openBook: openBook,
    chapter: chapter,
    search: search,
    FORMATS: FORMATS,
    MAX_TEXT_BYTES: MAX_TEXT_BYTES
};
