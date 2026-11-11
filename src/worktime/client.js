// 九格手记 · 本机时间源只读客户端（主进程专用）
//
// 边界写死在这里，评审时只看这个文件就够：
//   1. 只发 **GET**。不建 bucket、不打 tag、不写回 ActivityWatch（写回会把两个软件的状态耦死）；
//   2. 只连 **回环地址**（127.0.0.1 / localhost / [::1]），拒绝任何远程 host——这一条在
//      board.setHost 也拦一次，两处都拦是故意的：单点校验早晚被绕过；
//   3. 只取三样：`/api/0/info`、`/api/0/buckets/`、`/api/0/buckets/<id>/events`；
//   4. **不落窗口标题**。事件原样交给 aggregate.js 做匹配，匹配完就丢；
//   5. 零依赖：node:http 内置，不引 axios / undici，包装体积不变。
//
// ActivityWatch 默认 localhost:5600 且无鉴权；aw-server-rust 可开 API Key（除 info 外都要 Bearer）。

'use strict';

const http = require('node:http');
const board = require('./board.js');

const TIMEOUT_MS = 1600;
const MAX_BODY = 12 * 1024 * 1024; // 一天窗口事件通常 < 2 MB，12 MB 是防爆上限

function fail(code, msg) {
    const e = new Error(msg || code);
    e.code = code;
    return e;
}

function parseHost(host) {
    const h = String(host || '127.0.0.1:5600').trim();
    if (!board.HOST_RE.test(h)) throw fail('BAD_HOST', '只支持本机回环地址');
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
    const hostname = m ? m[1].replace(/^\[|\]$/g, '') : '127.0.0.1';
    const port = m && m[2] ? Number(m[2]) : 5600;
    if (!(port > 0 && port < 65536)) throw fail('BAD_HOST', '端口不合法');
    return { hostname: hostname, port: port };
}

function getJson(host, path, token, timeoutMs) {
    return new Promise(function (resolve, reject) {
        let target;
        try {
            target = parseHost(host);
        } catch (e) {
            reject(e);
            return;
        }
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: path,
            method: 'GET',
            headers: headers,
            timeout: timeoutMs || TIMEOUT_MS
        }, function (res) {
            let body = '';
            let size = 0;
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                size += chunk.length;
                if (size > MAX_BODY) {
                    req.destroy();
                    reject(fail('AW_TOO_LARGE', '返回数据超过上限'));
                    return;
                }
                body += chunk;
            });
            res.on('end', function () {
                if (res.statusCode === 401 || res.statusCode === 403) {
                    reject(fail('AW_AUTH', '这个实例开启了 API Key'));
                    return;
                }
                if (res.statusCode === 404) {
                    reject(fail('AW_NOT_FOUND', '接口不存在（版本可能过旧）'));
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(fail('AW_HTTP_' + res.statusCode, '服务返回 ' + res.statusCode));
                    return;
                }
                let json;
                try {
                    json = JSON.parse(body);
                } catch (e) {
                    reject(fail('AW_NOT_AW', '返回的不是 JSON，可能不是 ActivityWatch'));
                    return;
                }
                resolve(json);
            });
        });
        req.on('timeout', function () {
            req.destroy();
            reject(fail('AW_TIMEOUT', '同步超时'));
        });
        req.on('error', function (e) {
            if (e && e.code === 'ECONNREFUSED') reject(fail('AW_OFFLINE', '本机时间源未运行'));
            else if (e && e.code === 'ETIMEDOUT') reject(fail('AW_TIMEOUT', '同步超时'));
            else reject(fail('AW_NET_ERROR', (e && e.message) || '连接失败'));
        });
        req.end();
    });
}

function pickBucket(buckets, prefix, hostname) {
    const ids = Object.keys(buckets || {});
    const same = ids.filter(function (id) { return id.indexOf(prefix) === 0 && hostname && id.slice(-(hostname.length + 1)) === '_' + hostname; });
    if (same.length) return same.sort()[0];
    const any = ids.filter(function (id) { return id.indexOf(prefix) === 0; });
    return any.length ? any.sort()[0] : '';
}

/**
 * 探测 + 取一天的事件。
 * @returns {Promise<{hostname,version,buckets:{window,afk},windowEvents:Array,afkEvents:Array,partial:boolean}>}
 */
async function collect(opts) {
    const o = opts || {};
    const host = o.host;
    const token = o.token || '';
    const timeout = o.timeout || TIMEOUT_MS;

    let info;
    try {
        info = await getJson(host, '/api/0/info', '', timeout);
    } catch (e) {
        // info 是唯一允许不带 Key 的接口，所以 401 只可能来自别的实现，统一按「不是 AW」处理
        throw e;
    }
    if (!info || typeof info !== 'object' || typeof info.hostname !== 'string') {
        throw fail('AW_NOT_AW', '5600 端口上的服务不是 ActivityWatch');
    }

    const buckets = await getJson(host, '/api/0/buckets/', token, timeout);
    if (!buckets || typeof buckets !== 'object') throw fail('AW_NOT_AW', 'bucket 列表格式不对');

    const winId = pickBucket(buckets, 'aw-watcher-window_', info.hostname);
    const afkId = pickBucket(buckets, 'aw-watcher-afk_', info.hostname);

    const start = new Date(Number(o.dayStart)).toISOString();
    const end = new Date(Number(o.dayEnd)).toISOString();
    const q = '?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end) + '&limit=-1';

    let windowEvents = [];
    let afkEvents = [];
    if (winId) windowEvents = await getJson(host, '/api/0/buckets/' + encodeURIComponent(winId) + '/events' + q, token, timeout);
    if (afkId) afkEvents = await getJson(host, '/api/0/buckets/' + encodeURIComponent(afkId) + '/events' + q, token, timeout);
    if (!Array.isArray(windowEvents)) windowEvents = [];
    if (!Array.isArray(afkEvents)) afkEvents = [];

    return {
        hostname: info.hostname,
        version: String(info.version || ''),
        buckets: { window: winId, afk: afkId },
        windowEvents: windowEvents,
        afkEvents: afkEvents,
        partial: !afkId
    };
}

module.exports = {
    TIMEOUT_MS: TIMEOUT_MS,
    parseHost: parseHost,
    getJson: getJson,
    pickBucket: pickBucket,
    collect: collect
};
