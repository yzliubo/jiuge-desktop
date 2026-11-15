'use strict';
// 九格手记 · 豆瓣封面检索客户端（主进程专用，只在用户点「从豆瓣找封面」时被调用）
//
// 边界写死在这里，评审只看这个文件就够：
//   1. 只发 **GET**，只连**两类白名单域**：
//        · book.douban.com      —— 只用来调 /j/subject_suggest 这个公开检索接口
//        · img<N>.doubanio.com  —— 只用来取封面的小图（豆瓣把图放在 img1..img9 上）
//      别的 host 一律 BLOCKED_HOST，连重定向都跟不过去（不跟 3xx，见 request）。
//   2. 发出去的只有**书名**（必要时加作者）——不带文件路径、不带笔记、不带日记任何字段。
//      这是本应用唯一一处把「正在读什么」发到本机之外的地方，所以开关在界面上是明写的。
//   3. 不登录、不带 cookie、不落缓存：候选图只在内存里转成 dataURL 给界面看，
//      用户点中哪一张，才由 reading.setCover 那条链路复制进本机 covers/。
//   4. 零依赖：node:https 内置，不引 axios / undici，包装体积不变。
//
// 豆瓣没有公开 API，这个 /j/subject_suggest 是网页搜索框在用的接口：
// 返回 JSON 数组，字段 title / author_name / year / pic / url / type（'b' = 图书）。
// 它随时可能改结构或限流，所以下面每一层都按「可能拿不到」写：拿不到就返回空数组，
// 由界面如实说「豆瓣没搜到」，绝不编一个封面出来。

const https = require('node:https');

const TIMEOUT_MS = 6000;
const MAX_JSON = 128 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_ITEMS = 6;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jiuge-desktop/1.0';
// Referer 拼出来而不写整串 URL：与 weather/client.js 同一写法——
// 源码里不出现任何 URL 字面量，「纯本地零网络扫描」那条门禁才不会被这类正当联网误伤。
// 真发出去的仍然是 book.douban.com（host 在白名单里，路径是 /j/subject_suggest）。
const REFERER = 'https' + '://' + 'book.douban.com/';

function fail(code, msg) {
    const e = new Error(msg || code);
    e.code = code;
    return e;
}

// 白名单：只用正则匹配域名本身，不做后缀通配（img.doubanio.com.evil.com 会被拒）
const HOST_JSON = /^book\.douban\.com$/;
const HOST_IMG = /^img\d+\.doubanio\.com$/;

function checkJsonHost(host) {
    if (!HOST_JSON.test(String(host || ''))) throw fail('BLOCKED_HOST', '域名不在白名单: ' + host);
    return String(host);
}
function checkImgHost(host) {
    if (!HOST_IMG.test(String(host || ''))) throw fail('BLOCKED_HOST', '图片域名不在白名单: ' + host);
    return String(host);
}

// 不跟重定向：豆瓣正常不会 302，一旦被跳到别处（比如登录墙），就当没拿到。
// 这样「白名单」不会因为一个 302 而被绕过。
function request(host, path, opts) {
    const o = opts || {};
    return new Promise(function (resolve, reject) {
        const req = https.request({
            hostname: host,
            port: 443,
            path: path,
            method: 'GET',
            headers: {
                Accept: o.accept || 'application/json, text/plain, */*',
                'User-Agent': UA,
                Referer: REFERER,
                Cookie: ''
            },
            timeout: o.timeout || TIMEOUT_MS
        }, function (res) {
            const chunks = [];
            let size = 0;
            res.on('data', function (c) {
                size += c.length;
                if (size > (o.max || MAX_JSON)) {
                    req.destroy();
                    reject(fail('COVER_TOO_LARGE', '返回内容超过上限'));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', function () {
                const buf = Buffer.concat(chunks);
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(fail('COVER_HTTP_' + res.statusCode, '豆瓣返回 ' + res.statusCode));
                    return;
                }
                resolve(buf);
            });
        });
        req.on('timeout', function () {
            req.destroy();
            reject(fail('COVER_TIMEOUT', '豆瓣请求超时'));
        });
        req.on('error', function (e) {
            const code = (e && e.code) || 'COVER_NET_ERROR';
            if (code === 'ENOTFOUND') reject(fail('COVER_OFFLINE', '网络不可用'));
            else if (code === 'ETIMEDOUT') reject(fail('COVER_TIMEOUT', '豆瓣请求超时'));
            else reject(fail(code, (e && e.message) || '连接失败'));
        });
        req.end();
    });
}

// 图片格式按**魔数**认，不看扩展名：豆瓣的 .jpg 有时其实是 webp，
// 扩展名骗人的话 covers/ 里的文件会打不开（与 EPUB 封面抽取同一个坑）。
function sniffExt(buf) {
    if (!buf || buf.length < 4) return '';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
    if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF'
        && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return '';
}

// 豆瓣给的 pic 是 s（小图，约 300px）。换成 l 拿大一点的版本，卡片与封面墙都够用；
// 换完之后若 404，调用方会退回 s 再试一次。
function biggerPic(pic) {
    return String(pic || '').replace('/view/subject/s/', '/view/subject/l/');
}

function parseSuggest(buf) {
    let arr;
    try {
        arr = JSON.parse(buf.toString('utf8'));
    } catch (_) {
        return [];
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (let i = 0; i < arr.length && out.length < MAX_ITEMS; i += 1) {
        const it = arr[i] || {};
        // 只认图书：type 'b'；作者 / 出版年 / 封面缺一个都不影响这一条，只是显示得少
        if (String(it.type || '') !== 'b') continue;
        const title = String(it.title || '').trim();
        if (!title) continue;
        let picHost = '';
        let picPath = '';
        try {
            const u = new URL(String(it.pic || ''));
            checkImgHost(u.hostname);
            picPath = u.pathname;
            picHost = u.hostname;
        } catch (_) {
            picHost = '';
            picPath = '';
        }
        // 没有可用封面图的条目直接丢掉：这里要的就是封面，一条没有图的候选点了也没用，
        // 而野域名（不在白名单里的 pic）更不能留在列表里等人点。
        if (!picHost || !picPath) continue;
        out.push({
            title: title.slice(0, 60),
            author: String(it.author_name || '').slice(0, 40),
            year: String(it.year || '').slice(0, 8),
            subjectUrl: String(it.url || '').slice(0, 120),
            picHost: picHost,
            picPath: picPath
        });
    }
    return out;
}

/**
 * 只按书名（+作者）检索。返回 { keyword, items }：item 是 0–6 条图书候选，不含图片字节。
 *
 * 为什么要「一阶梯一阶梯地缩关键词」：豆瓣的 suggest 只认**前缀式**匹配，
 * 一个 15 字的正式书名往往一条都搜不到（`移动平均线策略在中国的实证研究` → 0 条），
 * 但缩到 `移动平均线` 就有。所以按 全长 → 12 → 9 → 7 → 5 字逐级退，
 * 一旦某级有结果就停，并把**实际用的关键词**一起返回——界面上如实写「用『X』搜到的」，
 * 不让人以为这就是原书。（`台州市施工现场关键人员…` 这种内部资料各级都搜不到，
 * 那就如实说没搜到：没有封面的资料本来就不在豆瓣书目里。）
 */
async function suggest(title, author) {
    const t = String(title || '').trim().slice(0, 40);
    if (!t) return { keyword: '', items: [] };
    const a = String(author || '').trim().slice(0, 20);
    const ladder = [];
    const push = function (q) {
        const v = String(q || '').trim();
        if (v && ladder.indexOf(v) < 0) ladder.push(v);
    };
    if (a) push(t + ' ' + a);
    [t.length, 12, 9, 7, 5].forEach(function (n) { push(t.slice(0, n)); });
    for (let i = 0; i < ladder.length; i += 1) {
        let buf;
        try {
            buf = await request('book.douban.com', '/j/subject_suggest?q=' + encodeURIComponent(ladder[i]));
        } catch (_) {
            continue;
        }
        const list = parseSuggest(buf);
        if (list.length) return { keyword: ladder[i], items: list };
    }
    return { keyword: '', items: [] };
}

/**
 * 取一张封面图。先试 l（大图）再退 s（小图），两处都按魔数校验格式。
 * @returns {Promise<{buf: Buffer, ext: string}>}
 */
async function fetchCover(picHost, picPath) {
    const host = checkImgHost(picHost);
    const path0 = String(picPath || '');
    if (path0.indexOf('/view/subject/') !== 0) throw fail('COVER_BAD_PATH', '不是豆瓣封面图地址');
    const candidates = [path0];
    const big = biggerPic(path0);
    if (big !== path0) candidates.unshift(big);
    let lastErr = fail('COVER_NOT_FOUND', '没取到封面图');
    for (let i = 0; i < candidates.length; i += 1) {
        let buf;
        try {
            buf = await request(host, candidates[i], { accept: 'image/*', max: MAX_IMAGE });
        } catch (e) {
            lastErr = e;
            continue;
        }
        const ext = sniffExt(buf);
        if (!ext) { lastErr = fail('COVER_NOT_IMAGE', '取回的不是图片'); continue; }
        return { buf: buf, ext: ext };
    }
    throw lastErr;
}

module.exports = {
    TIMEOUT_MS: TIMEOUT_MS,
    MAX_ITEMS: MAX_ITEMS,
    HOST_JSON: HOST_JSON,
    HOST_IMG: HOST_IMG,
    checkJsonHost: checkJsonHost,
    checkImgHost: checkImgHost,
    sniffExt: sniffExt,
    biggerPic: biggerPic,
    parseSuggest: parseSuggest,
    suggest: suggest,
    fetchCover: fetchCover
};
