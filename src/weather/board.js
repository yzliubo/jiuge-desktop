// 九格手记 · 首页天气与环境（md_weather 单键）
//
// 为什么单独一个键、而不是塞进 base.weather：
//   1. 九格原本有一个手填的「天气」档位（晴 / 阴 / 雨…），那是**你自己写下来的心情背景**，
//      与「此刻窗外几度」是两件事。自动天气写进 base.weather 等于替你改日记，绝对不行；
//   2. 自动天气是外部投影，会过期、会失败、可以关掉，生命周期与日记正文完全不同；
//   3. 备份只带偏好，不带缓存：换台机器重新拉一次就行，不必把别人家的温度带进你的档案。
//
// 三条硬约束（改代码前先读）：
//   · **默认开启但可一键关闭**。关闭后主进程一次远程请求都不发，首页连占位都不渲染；
//   · **只存偏好**。normalize 里没有 report / temperature 字段，缓存只在主进程内存里；
//   · **不碰日记**。本模块没有任何写 base.weather / cells 的函数。
//
// 纯函数、不联网：网络在 client.js，调用方把结果传进来，便于断言。

'use strict';

const KEY = 'md_weather';
const VERSION = 1;

const CITY_MAX = 24;
const LABEL_MAX = 24;
const REGION_MAX = 24;
const MODES = ['auto', 'city'];
const UNITS = ['c', 'f'];

function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}
function str(v, max) {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim();
    return s.slice(0, max);
}
function round1(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 10) / 10;
}

// WMO 天气代码 → 中文描述 + 单色符号。
// 单色符号而不是 emoji：九格是纸面感的界面，一排彩色 emoji 会把「今天是什么日子」压下去。
const WMO = {
    0: ['晴', '☀', 'sun'],
    1: ['晴间多云', '☀', 'sun'],
    2: ['多云', '☁', 'cloud'],
    3: ['阴', '☁', 'cloud'],
    45: ['有雾', '≋', 'fog'],
    48: ['雾凇', '≋', 'fog'],
    51: ['毛毛雨', '☂', 'rain'],
    53: ['小雨', '☂', 'rain'],
    55: ['细雨', '☂', 'rain'],
    56: ['冻毛毛雨', '☂', 'rain'],
    57: ['冻雨', '☂', 'rain'],
    61: ['小雨', '☂', 'rain'],
    63: ['中雨', '☂', 'rain'],
    65: ['大雨', '☂', 'rain'],
    66: ['冻雨', '☂', 'rain'],
    67: ['强冻雨', '☂', 'rain'],
    71: ['小雪', '❄', 'snow'],
    73: ['中雪', '❄', 'snow'],
    75: ['大雪', '❄', 'snow'],
    77: ['米雪', '❄', 'snow'],
    80: ['阵雨', '☂', 'rain'],
    81: ['强阵雨', '☂', 'rain'],
    82: ['暴雨', '☂', 'rain'],
    85: ['阵雪', '❄', 'snow'],
    86: ['强阵雪', '❄', 'snow'],
    95: ['雷阵雨', '⚡', 'storm'],
    96: ['雷阵雨伴冰雹', '⚡', 'storm'],
    99: ['强雷暴伴冰雹', '⚡', 'storm']
};

function describe(code) {
    const hit = WMO[Number(code)];
    if (!hit) return { text: '天气未知', icon: '·', group: 'unknown' };
    return { text: hit[0], icon: hit[1], group: hit[2] };
}

function normalizePlace(raw) {
    const p = raw && typeof raw === 'object' ? raw : null;
    if (!p) return null;
    // 越界与 (0,0) 一律**拒绝**而不是夹到边界：夹一下就会变成「北纬 90 度」这种
    // 看着合法、其实谁都不在的坐标，天气会一直取错而没人发现。
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (lat === 0 && lon === 0) return null;
    const label = str(p.label, LABEL_MAX);
    if (!label) return null;
    return {
        lat: Math.round(lat * 10000) / 10000,
        lon: Math.round(lon * 10000) / 10000,
        label: label,
        region: str(p.region, REGION_MAX)
    };
}

function empty() {
    return {
        version: VERSION,
        // 默认开：主理人 2026-11-11 明确要「首页自动显示当地天气」。
        // 但开关必须在设置页第一屏能看到，关掉后一条请求都不发。
        enabled: true,
        // auto = 按出口 IP 猜城市；city = 使用者手填的城市（离线也能配）
        mode: 'auto',
        city: '',
        place: null,
        unit: 'c',
        updatedAt: 0
    };
}

function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const mode = MODES.indexOf(String(r.mode || '')) >= 0 ? String(r.mode) : 'auto';
    const place = normalizePlace(r.place);
    return {
        version: VERSION,
        enabled: r.enabled !== false,
        mode: mode,
        // mode=city 时以城市名为准；手填了城市就保留，便于下次再切回来
        city: str(r.city, CITY_MAX),
        // 坐标与模式分开存：从 city 切回 auto 时不抹掉坐标，切回来还认这个城市
        place: place,
        unit: UNITS.indexOf(String(r.unit || '')) >= 0 ? String(r.unit) : 'c',
        updatedAt: clampNum(r.updatedAt, 0, 4102444800000, 0)
    };
}

function setEnabled(s, on) {
    const next = normalize(s);
    next.enabled = on === true;
    next.updatedAt = Date.now();
    return next;
}

function setMode(s, mode) {
    const next = normalize(s);
    next.mode = MODES.indexOf(String(mode || '')) >= 0 ? String(mode) : 'auto';
    if (next.mode === 'auto') next.place = null;
    next.updatedAt = Date.now();
    return next;
}

// 手填城市：city 是给输入框看的原文，place 是检索回来的坐标。
// 两者都存，是因为改一个字就要重新检索——不能拿旧坐标去配新名字。
function setCity(s, city, place) {
    const next = normalize(s);
    next.city = str(city, CITY_MAX);
    next.place = normalizePlace(place);
    next.mode = next.place ? 'city' : next.mode;
    next.updatedAt = Date.now();
    return next;
}

function clearCity(s) {
    const next = normalize(s);
    next.city = '';
    next.place = null;
    next.mode = 'auto';
    next.updatedAt = Date.now();
    return next;
}

function setUnit(s, unit) {
    const next = normalize(s);
    next.unit = UNITS.indexOf(String(unit || '')) >= 0 ? String(unit) : 'c';
    next.updatedAt = Date.now();
    return next;
}

// 把「偏好 + 内存缓存」拼成渲染层要的形状。
// 只读：不改任何状态；缓存过期也不在这里清理，交给调用方决定要不要拉新的。
function view(s, cache, now) {
    const st = normalize(s);
    const c = cache && typeof cache === 'object' ? cache : null;
    const t = Number(now) || Date.now();
    const fresh = !!(c && c.report && (t - Number(c.fetchedAt || 0) < Number(c.ttl || 0)));
    return {
        enabled: st.enabled,
        mode: st.mode,
        city: st.city,
        place: st.place,
        unit: st.unit,
        report: c && c.report ? c.report : null,
        fetchedAt: c ? Number(c.fetchedAt || 0) : 0,
        stale: !!(c && c.report) && !fresh,
        error: c && c.error ? c.error : null
    };
}

// 网络结果 → 渲染层契约。只留要显示的字段，上游多给的一概不落。
function pack(place, current, daily, fetchedAt) {
    const cur = current && typeof current === 'object' ? current : {};
    const day = daily && typeof daily === 'object' ? daily : {};
    const d = describe(cur.weather_code);
    return {
        place: {
            label: str(place && place.label, LABEL_MAX) || '当前位置',
            region: str(place && place.region, REGION_MAX)
        },
        now: {
            temp: round1(cur.temperature_2m),
            feels: round1(cur.apparent_temperature),
            humidity: round1(cur.relative_humidity_2m),
            wind: round1(cur.wind_speed_10m),
            isDay: cur.is_day !== 0,
            code: Number(cur.weather_code),
            text: d.text,
            icon: d.icon,
            group: d.group
        },
        today: {
            max: round1(Array.isArray(day.temperature_2m_max) ? day.temperature_2m_max[0] : null),
            min: round1(Array.isArray(day.temperature_2m_min) ? day.temperature_2m_min[0] : null),
            rainProb: round1(Array.isArray(day.precipitation_probability_max) ? day.precipitation_probability_max[0] : null)
        },
        fetchedAt: Number(fetchedAt) || Date.now()
    };
}

module.exports = {
    KEY: KEY,
    VERSION: VERSION,
    CITY_MAX: CITY_MAX,
    MODES: MODES,
    WMO: WMO,
    describe: describe,
    empty: empty,
    normalize: normalize,
    setEnabled: setEnabled,
    setMode: setMode,
    setCity: setCity,
    clearCity: clearCity,
    setUnit: setUnit,
    view: view,
    pack: pack
};
