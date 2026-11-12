// 首页天气门禁：偏好归一化 / 文案映射 / 缓存判定 / 网络白名单。
//
// 为什么不打真网络：门禁要能在断网的机器上跑。真联调单独用
//   JIUGE_WX_LIVE=1 node tests/phase2/weather-case.js
// 打开（会真的向 ipwho.is 与 Open-Meteo 各发一次 GET，并打印城市与温度）。
//
// 不替代 GUI 断言：这里只证明「数据形状与边界」对，界面是否好看要看 gui-assert。
'use strict';

const assert = require('assert');
const board = require('../../src/weather/board.js');
const client = require('../../src/weather/client.js');

let passed = 0;
let failed = 0;
const queue = [];

function check(name, fn) {
    queue.push(async function () {
        try {
            await fn();
            passed += 1;
            console.log('  PASS  ' + name);
        } catch (e) {
            failed += 1;
            console.log('  FAIL  ' + name + '\n        ' + (e && e.message));
        }
    });
}

console.log('\n[首页天气] 偏好与契约');

check('默认开启、自动定位、摄氏度——主理人要的是「打开就有」', function () {
    const s = board.normalize(undefined);
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.mode, 'auto');
    assert.strictEqual(s.unit, 'c');
    assert.strictEqual(s.place, null);
    assert.strictEqual(s.version, board.VERSION);
});

check('关掉后 normalize 幂等：不会因为少传字段又变回开', function () {
    const off = board.setEnabled(board.empty(), false);
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(board.normalize(off).enabled, false);
    assert.strictEqual(board.normalize(board.normalize(off)).enabled, false);
});

check('坐标越界 / 没名字的坐标都存不进来（脏坐标会把天气取到几内亚湾）', function () {
    assert.strictEqual(board.normalize({ place: { lat: 200, lon: 0, label: 'x' } }).place, null);
    assert.strictEqual(board.normalize({ place: { lat: 31, lon: 121 } }).place, null, '没有名字的坐标不该被接受');
    const ok = board.normalize({ place: { lat: 31.2222174, lon: 121.4580564, label: '上海', region: '上海市' } });
    assert.ok(ok.place);
    assert.strictEqual(ok.place.lat, 31.2222, '坐标要压到 4 位小数，省字节也够准');
});

check('手填城市：city 与坐标分开存，改一个字不会拿旧坐标配新名字', function () {
    const s = board.setCity(board.empty(), '苏州', { lat: 31.3, lon: 120.6, label: '苏州', region: '江苏省' });
    assert.strictEqual(s.mode, 'city');
    assert.strictEqual(s.city, '苏州');
    const back = board.clearCity(s);
    assert.strictEqual(back.mode, 'auto');
    assert.strictEqual(back.place, null);
});

check('WMO 代码映射：常见档位都有中文与符号，未知不崩', function () {
    assert.strictEqual(board.describe(0).text, '晴');
    assert.strictEqual(board.describe(3).text, '阴');
    assert.strictEqual(board.describe(65).text, '大雨');
    assert.strictEqual(board.describe(95).group, 'storm');
    assert.strictEqual(board.describe(1234).group, 'unknown');
    assert.ok(board.describe(0).icon);
});

check('pack：上游多给的字段一律不落，只留界面要显示的', function () {
    const report = board.pack(
        { label: '上海', region: '上海市', ip: '1.2.3.4', isp: '不该出现' },
        {
            temperature_2m: 11.66, apparent_temperature: 10.14, relative_humidity_2m: 67,
            wind_speed_10m: 3.4, is_day: 1, weather_code: 0, extra: '不该出现'
        },
        { temperature_2m_max: [17.04], temperature_2m_min: [6.06], precipitation_probability_max: [0] },
        1700000000000
    );
    assert.strictEqual(report.now.temp, 11.7);
    assert.strictEqual(report.today.max, 17);
    assert.strictEqual(report.today.min, 6.1);
    assert.strictEqual(report.now.text, '晴');
    assert.ok(JSON.stringify(report).indexOf('1.2.3.4') < 0, 'IP 不许进天气契约');
    assert.ok(JSON.stringify(report).indexOf('不该出现') < 0, '上游多余字段不许透传');
});

check('8 档与 diary-store BASE_FIELDS 逐字一致：不许出现落不进日记的词', function () {
    const store = require('../../src/utils/diary-store.js');
    const field = store.BASE_FIELDS.filter(function (f) { return f.key === 'weather'; })[0];
    assert.ok(field, 'diary-store 里没有 weather 基础字段');
    assert.deepStrictEqual(board.BASE_WEATHER, field.options);
});

check('WMO → 8 档：晴 / 多云 / 阴 / 小雨 / 大雨 / 雪 / 雾 都有落点', function () {
    const cases = [[0, '晴'], [1, '晴'], [2, '多云'], [3, '阴'], [45, '雾'], [48, '雾'],
        [51, '小雨'], [61, '小雨'], [63, '大雨'], [65, '大雨'], [95, '大雨'], [99, '大雨'],
        [71, '雪'], [75, '雪'], [86, '雪']];
    cases.forEach(function (c) {
        assert.strictEqual(board.toBaseWeather(c[0], 3), c[1], '代码 ' + c[0] + ' 映射错了');
    });
});

check('大风只在无降水 / 无雾 / 无雪时改口记「风」，雨天再大风仍是雨天', function () {
    assert.strictEqual(board.toBaseWeather(0, 35), '风');
    assert.strictEqual(board.toBaseWeather(3, 30), '风');
    assert.strictEqual(board.toBaseWeather(65, 60), '大雨');
    assert.strictEqual(board.toBaseWeather(71, 60), '雪');
    assert.strictEqual(board.toBaseWeather(0, 3), '晴');
});

check('认不出的代码 / 缺字段返回空串交给手填，绝不猜一个词塞进日记', function () {
    assert.strictEqual(board.toBaseWeather(1234, 3), '');
    assert.strictEqual(board.toBaseWeather(null, 3), '', 'null 不能被 Number() 折成 0（晴）');
    assert.strictEqual(board.toBaseWeather(undefined, 3), '');
    assert.strictEqual(board.toBaseWeather('', 3), '');
});

check('pack 把折算值一起给渲染层，且仍是 8 档之一', function () {
    const r = board.pack({ label: '上海' },
        { temperature_2m: 12, weather_code: 61, wind_speed_10m: 8 }, {}, 1000);
    assert.strictEqual(r.now.baseWeather, '小雨');
    assert.ok(board.BASE_WEATHER.indexOf(r.now.baseWeather) >= 0);
    const unknown = board.pack({ label: '上海' },
        { temperature_2m: 12, weather_code: 777 }, {}, 1000);
    assert.strictEqual(unknown.now.baseWeather, '', '未知代码不该落任何档位');
});

check('view：缓存过期标 stale，关闭态照旧返回偏好', function () {
    const s = board.normalize({ enabled: true });
    const report = board.pack({ label: '上海' }, { temperature_2m: 10, weather_code: 0 }, {}, 1000);
    const cache = { report: report, fetchedAt: 1000, ttl: 1000, error: null };
    assert.strictEqual(board.view(s, cache, 1500).stale, false);
    assert.strictEqual(board.view(s, cache, 5000).stale, true, '过期必须标 stale，不能假装最新');
    const off = board.setEnabled(s, false);
    const v = board.view(off, cache, 1500);
    assert.strictEqual(v.enabled, false);
    assert.ok(v.report, 'view 只读，不在读的时候清缓存（清缓存是 setEnabled 的事）');
});

console.log('\n[首页天气] 网络边界');

check('只认三个白名单域名，别的 host 直接抛 BLOCKED_HOST', function () {
    ['ipwho.is', 'api.open-meteo.com', 'geocoding-api.open-meteo.com'].forEach(function (h) {
        assert.strictEqual(client.checkHost(h), h);
    });
    assert.throws(function () { client.checkHost('example.com'); }, /白名单/);
    assert.throws(function () { client.checkHost('127.0.0.1'); }, /白名单/);
});

check('坐标合法性：0,0 与越界一律拒绝（不拿默认值去查别人家天气）', function () {
    assert.strictEqual(client.validCoord(31.2, 121.4), true);
    assert.strictEqual(client.validCoord(0, 0), false);
    assert.strictEqual(client.validCoord(91, 0), false);
    assert.strictEqual(client.validCoord(NaN, 1), false);
});

check('坏坐标不发请求：forecast 直接 reject', async function () {
    let err = null;
    try {
        await client.forecast(0, 0);
    } catch (e) {
        err = e;
    }
    assert.ok(err, '坏坐标居然没报错');
    assert.strictEqual(err.code, 'WEATHER_BAD_COORD');
});

check('空城市名不发请求', async function () {
    let err = null;
    try {
        await client.geocode('   ');
    } catch (e) {
        err = e;
    }
    assert.ok(err, '空城市居然没报错');
    assert.strictEqual(err.code, 'WEATHER_BAD_CITY');
});

console.log('\n[首页天气] 真联调（可选）');

if (process.env.JIUGE_WX_LIVE === '1') {
    check('真联调：定位 → 取一次天气', async function () {
        const raw = await client.collect({});
        assert.ok(raw.place && raw.place.label, '没拿到城市');
        assert.ok(raw.current && isFinite(raw.current.temperature_2m), '没拿到温度');
        console.log('        城市=' + raw.place.label + ' 温度=' + raw.current.temperature_2m
            + '°C 天气代码=' + raw.current.weather_code);
    });
} else {
    console.log('  SKIP  未设置 JIUGE_WX_LIVE=1，跳过真联调');
}

(async function () {
    for (const run of queue) await run();
    console.log('\n  PASS ' + passed + ' | FAIL ' + failed);
    process.exitCode = failed > 0 ? 1 : 0;
})();
