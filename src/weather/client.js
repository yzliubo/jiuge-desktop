// 九格手记 · 首页天气客户端（主进程专用）
//
// 边界写死在这里，评审时只看这个文件就够：
//   1. 只发 **GET**，只连**三个白名单域名**（下面 HOSTS），别的 host 一律 BLOCKED_HOST；
//   2. 只读公开气象数据，**不带任何用户数据**：不发日记、不发机器名、不发九格里的任何字段；
//      唯一会离开这台机器的是出口 IP 本身（IP 定位必然如此，设置页如实写了）；
//   3. 两个提供方都**免注册、免 API Key**，因此没有密钥要管、没有账号要泄露；
//   4. 零依赖：node:https 内置，不引 axios / undici，包装体积不变；
//   5. 关掉开关时，本文件不会被调用（调用点在工作模块之外的 weather.sync 里）。
//
// 提供方：
//   · 定位：ipwho.is（HTTPS、免费、支持 lang=zh-CN，返回中文城市名）
//   · 天气：Open-Meteo（HTTPS、免费、无需 Key，WMO 天气代码）
//   · 城市检索：Open-Meteo Geocoding（手填城市时用，同样免 Key）

'use strict';

const https = require('node:https');

const HOSTS = ['ipwho.is', 'api.open-meteo.com', 'geocoding-api.open-meteo.com'];
const TIMEOUT_MS = 4500;
const MAX_BODY = 256 * 1024;
const UA = 'jiuge-desktop/1.0 (weather; +local)';

function fail(code, msg) {
    const e = new Error(msg || code);
    e.code = code;
    return e;
}

// 白名单校验放在请求函数里，而不是调用方：新增一个调用点也不会漏掉
function checkHost(host) {
    if (HOSTS.indexOf(String(host || '')) < 0) throw fail('BLOCKED_HOST', '域名不在白名单: ' + host);
    return String(host);
}

function getJson(host, path, timeoutMs) {
    return new Promise(function (resolve, reject) {
        let h;
        try {
            h = checkHost(host);
        } catch (e) {
            reject(e);
            return;
        }
        const req = https.request({
            hostname: h,
            port: 443,
            path: path,
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'User-Agent': UA,
                // 不吃任何 cookie：这台机器不该因为看天气被种一个标识
                Cookie: ''
            },
            timeout: timeoutMs || TIMEOUT_MS
        }, function (res) {
            let body = '';
            let size = 0;
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                size += Buffer.byteLength(chunk, 'utf8');
                if (size > MAX_BODY) {
                    req.destroy();
                    reject(fail('WEATHER_TOO_LARGE', '返回数据超过上限'));
                    return;
                }
                body += chunk;
            });
            res.on('end', function () {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(fail('WEATHER_HTTP_' + res.statusCode, '天气服务返回 ' + res.statusCode));
                    return;
                }
                let json;
                try {
                    json = JSON.parse(body);
                } catch (e) {
                    reject(fail('WEATHER_BAD_JSON', '返回的不是 JSON'));
                    return;
                }
                resolve(json);
            });
        });
        req.on('timeout', function () {
            req.destroy();
            reject(fail('WEATHER_TIMEOUT', '天气请求超时'));
        });
        req.on('error', function (e) {
            if (e && e.code === 'ENOTFOUND') reject(fail('WEATHER_OFFLINE', '网络不可用'));
            else if (e && e.code === 'ETIMEDOUT') reject(fail('WEATHER_TIMEOUT', '天气请求超时'));
            else if (e && e.code === 'ECONNREFUSED') reject(fail('WEATHER_OFFLINE', '网络不可用'));
            else reject(fail((e && e.code) || 'WEATHER_NET_ERROR', (e && e.message) || '连接失败'));
        });
        req.end();
    });
}

function validCoord(lat, lon) {
    return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))
        && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180
        && !(Number(lat) === 0 && Number(lon) === 0); // 几内亚湾「0,0」是定位失败的常见默认值
}

// IP 定位：只取城市与坐标，其余字段（运营商、邮编、旗帜）一律不读、不传、不落。
async function locate() {
    const j = await getJson('ipwho.is', '/?lang=zh-CN');
    if (!j || j.success === false) throw fail('WEATHER_LOCATE_FAILED', '定位服务没有返回结果');
    if (!validCoord(j.latitude, j.longitude)) throw fail('WEATHER_LOCATE_FAILED', '定位坐标不合法');
    return {
        lat: Number(j.latitude),
        lon: Number(j.longitude),
        label: String(j.city || j.region || '当前位置').slice(0, 24),
        region: String(j.region || '').slice(0, 24)
    };
}

// 手填城市检索：只取第一条，返回的 name / admin1 都是中文。
async function geocode(name) {
    const q = String(name || '').trim().slice(0, 24);
    if (!q) throw fail('WEATHER_BAD_CITY', '城市名是空的');
    const j = await getJson('geocoding-api.open-meteo.com',
        '/v1/search?name=' + encodeURIComponent(q) + '&count=1&language=zh&format=json');
    const hit = j && Array.isArray(j.results) ? j.results[0] : null;
    if (!hit || !validCoord(hit.latitude, hit.longitude)) throw fail('WEATHER_NO_CITY', '找不到这个城市');
    return {
        lat: Number(hit.latitude),
        lon: Number(hit.longitude),
        label: String(hit.name || q).slice(0, 24),
        region: String(hit.admin1 || hit.country || '').slice(0, 24)
    };
}

// 当前 + 今日：一次请求拿全，少一次往返。
// 时区用 auto：拿当地时区，界面上的「今天」才是当地的今天。
function forecast(lat, lon) {
    if (!validCoord(lat, lon)) return Promise.reject(fail('WEATHER_BAD_COORD', '坐标不合法'));
    const q = [
        'latitude=' + Number(lat).toFixed(4),
        'longitude=' + Number(lon).toFixed(4),
        'current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
        'daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        'timezone=auto',
        'forecast_days=1'
    ].join('&');
    return getJson('api.open-meteo.com', '/v1/forecast?' + q).then(function (j) {
        if (!j || !j.current) throw fail('WEATHER_BAD_JSON', '天气服务返回结构不对');
        return j;
    });
}

/**
 * 一次取天气：先用传入坐标，没有就按出口 IP 定位。
 * @returns {Promise<{place, current, daily}>}
 */
async function collect(opts) {
    const o = opts || {};
    let place = o.place && validCoord(o.place.lat, o.place.lon) ? {
        lat: Number(o.place.lat),
        lon: Number(o.place.lon),
        label: String(o.place.label || '当前位置').slice(0, 24),
        region: String(o.place.region || '').slice(0, 24)
    } : null;
    if (!place) place = await locate();
    const j = await forecast(place.lat, place.lon);
    return { place: place, current: j.current, daily: j.daily };
}

module.exports = {
    HOSTS: HOSTS,
    TIMEOUT_MS: TIMEOUT_MS,
    checkHost: checkHost,
    getJson: getJson,
    validCoord: validCoord,
    locate: locate,
    geocode: geocode,
    forecast: forecast,
    collect: collect
};
