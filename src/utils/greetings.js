/**
 * 首页 hero「时令问候 + 健康短句」生成模块
 *
 * 规则：
 * 1. 由「当前日期 + 当前时段」决定内容，不用固定标语；跨时段回到前台自动更新。
 * 2. 同一天同一时段结果稳定（日期散列），不会每次刷新乱跳；点一下可换一组。
 * 3. 纯函数、无 wx 依赖，可在 Node 下直接 require 做冒烟测试。
 * 4. 健康提示只做生活化建议，不涉医疗判断。
 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 时段：24 小时全覆盖，5:00-9:00 是早起记录的主场景
const PERIODS = [
    { key: 'dawn', from: 5, to: 9, label: '清晨' },
    { key: 'morning', from: 9, to: 12, label: '上午' },
    { key: 'noon', from: 12, to: 14, label: '午间' },
    { key: 'afternoon', from: 14, to: 18, label: '下午' },
    { key: 'evening', from: 18, to: 21, label: '傍晚' },
    { key: 'night', from: 21, to: 23, label: '夜间' },
    { key: 'latenight', from: 23, to: 5, label: '深夜' },
];

// 按月给时令感，不宣称节气的精确日期
const SEASON_WORDS = [
    '深冬', '残冬', '初春', '仲春', '暮春', '初夏',
    '盛夏', '末夏', '初秋', '深秋', '初冬', '隆冬',
];

// 固定公历节日；农历节日不做近似推算，避免出现错日期
const SPECIAL_DAYS = {
    '01-01': { label: '元旦', line: '新的一年，第一页从今天写起。' },
    '05-01': { label: '劳动节', line: '假期里也给自己留三分钟。' },
    '06-01': { label: '儿童节', line: '像小孩一样，先写最开心的一件。' },
    '10-01': { label: '国庆', line: '假期慢一点，日记也慢一点。' },
};
const ANNIVERSARY_LINE = '今天是你标记的日子，值得多写两行。';

// 问候：按时段分组，同一时段多条轮换
const GREETINGS = {
    dawn: [
        '早安，先把这一页留给自己。',
        '早，今天也从容一点开始。',
        '早安，窗外的光正好，先写三行。',
        '早，先不急着看消息，先看看自己。',
        '早安，三分钟就够，写一个字也算数。',
    ],
    morning: [
        '上午好，别一上来就把自己排满。',
        '上午好，先做最要紧的那一件。',
        '上午好，忙里也给自己留口气。',
        '上午好，慢一点，写得少也算数。',
    ],
    noon: [
        '午安，先放下手头，好好吃顿饭。',
        '午安，歇一会儿再写也不迟。',
        '午安，一天过半，别硬撑。',
        '午安，给上午收个尾，下午再接着来。',
    ],
    afternoon: [
        '下午好，抬头看看远处。',
        '下午好，喝口水，再接着来。',
        '下午好，累了就先松一松肩。',
        '下午好，写两句也是把今天接住了。',
    ],
    evening: [
        '傍晚好，把今天的节奏收一收。',
        '傍晚好，散步回来再写两句。',
        '傍晚好，今天已经很够了。',
        '傍晚好，留一点时间给不赶路的事。',
    ],
    night: [
        '晚上好，写两句就收笔吧。',
        '晚上好，灯下写一行，也就够了。',
        '晚上好，别熬着补，明天也能写。',
        '晚上好，把今天好好合上。',
    ],
    latenight: [
        '夜深了，睡觉比写字更要紧。',
        '这么晚了，明天补记也来得及。',
        '夜深了，先休息，日记会等你。',
        '夜深了，明早再和自己碰面。',
    ],
};

// 运动 / 健康短句：按时段给动作建议
const TIPS = {
    dawn: [
        '先喝一杯温水，再动笔。',
        '起床后伸展两分钟，让肩颈先醒过来。',
        '开窗透口气，做三次深呼吸。',
        '别急着刷手机，先活动一下手腕脚踝。',
        '早饭前走几步，让身体慢慢开机。',
        '今天试着用走路代替一段车程。',
    ],
    morning: [
        '每坐一小时，起来走动两分钟。',
        '远眺 20 秒，让眼睛歇一歇。',
        '把水杯放近一点，记得补口水。',
        '肩颈绕两圈，别一直低着头。',
        '去接水时多走几步，顺手松松腰。',
    ],
    noon: [
        '饭后慢走十分钟，比立刻坐下舒服。',
        '午饭别太急，嚼慢一点。',
        '想眯一会儿，15 分钟就够。',
        '饭后靠墙站两分钟，松一松腰背。',
        '饭后别马上盯屏幕，站着聊两句也好。',
    ],
    afternoon: [
        '下午容易犯困，站起来伸个懒腰。',
        '去窗边晒两分钟太阳。',
        '手腕转一转，鼠标先放一放。',
        '再喝一杯水，别等口渴才想起来。',
        '上下楼走一趟，把久坐打断。',
    ],
    evening: [
        '饭后出去快走二十分钟。',
        '放下屏幕，让眼睛先下班。',
        '拉伸一下小腿和肩背，今天辛苦了。',
        '散步时别戴耳机，听听周围的声音。',
        '晚饭后站一会儿，比窝着更舒服。',
    ],
    night: [
        '热水泡个脚，比再刷一会儿更解乏。',
        '睡前把手机放远一点。',
        '做两分钟缓慢拉伸，呼吸放长。',
        '今天走够了吗？睡前别再给自己加任务。',
        '熄灯前把肩颈松一松，睡得踏实些。',
    ],
    latenight: [
        '现在最该做的运动，是躺下。',
        '先睡吧，明早再伸展也不晚。',
        '关灯，把恢复交给身体自己。',
        '别再数今天走了几步，先闭眼。',
    ],
};

// 星期维度：与日期联动的运动 / 节奏短句，并入对应时段的候选池
const DAY_TIPS = [
    ['周末出门走一圈，晒晒太阳。', '给下周留一件想做的小事。'],
    ['新的一周，先把肩膀松下来。'],
    ['今天试试走楼梯，不赶电梯。'],
    ['一周过半，中午出去透透气。'],
    ['把散步安排进今天，别都留到周末。'],
    ['周末在望，今晚别把运动排太满。'],
    ['有空就走远一点，换条路线。'],
];

const imul = Math.imul || function (a, b) { return (a * b) >>> 0; };

function pad(n) {
    return n < 10 ? '0' + n : String(n);
}

function hashOf(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
        h = imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    }
    return h >>> 0;
}

function localKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function periodOf(hour) {
    const h = ((Number(hour) || 0) % 24 + 24) % 24;
    for (let i = 0; i < PERIODS.length; i += 1) {
        const p = PERIODS[i];
        const hit = p.from <= p.to
            ? (h >= p.from && h < p.to)
            : (h >= p.from || h < p.to);
        if (hit) return p;
    }
    return PERIODS[0];
}

// 页面用它判断「是否跨时段」，只含日期 + 时段，不含用户填的纪念日
function scopeKey(now) {
    const d = (now instanceof Date && !isNaN(now.getTime())) ? now : new Date();
    return localKey(d) + '|' + periodOf(d.getHours()).key;
}

/**
 * 生成一组提示语
 * @param {Object} opts
 *   now          Date，缺省取当前时间（测试可注入）
 *   anniversary  String，当天「纪念日」栏填的内容，非空则加纪念日提示
 *   offset       Number，可选：换一组文案的偏移。页面已下线「换一句」入口，
 *                仅保留模块能力供测试 / 后续复用；页面调用时不传此参数
 * @returns {{scope:String, tag:String, text:String, hint:String}}
 */
function compose(opts) {
    const o = opts || {};
    const d = (o.now instanceof Date && !isNaN(o.now.getTime())) ? o.now : new Date();
    const period = periodOf(d.getHours());
    const scope = scopeKey(d);
    const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const weekday = d.getDay();
    const special = SPECIAL_DAYS[md] || null;
    const anniversary = String(o.anniversary || '').trim();
    const offset = Number(o.offset) > 0 ? Math.floor(Number(o.offset)) : 0;

    const season = special ? special.label : (anniversary ? '纪念日' : SEASON_WORDS[d.getMonth()]);
    const tag = [
        (d.getMonth() + 1) + '月' + d.getDate() + '日',
        WEEK[weekday],
        season,
        period.label,
    ].join(' · ');

    const greetPool = GREETINGS[period.key];
    const tipPool = TIPS[period.key].concat(DAY_TIPS[weekday] || []);
    const greet = greetPool[(hashOf(scope + '#greet') + offset) % greetPool.length];
    const tip = tipPool[(hashOf(scope + '#tip') + offset) % tipPool.length];
    const line = special ? special.line : (anniversary ? ANNIVERSARY_LINE : '');

    return {
        scope: scope,
        tag: tag,
        text: greet + (line ? ' ' + line : ''),
        hint: tip,
    };
}

module.exports = {
    compose: compose,
    periodOf: periodOf,
    scopeKey: scopeKey,
    periods: PERIODS,
    size: Object.keys(GREETINGS).reduce(function (n, k) {
        return n + GREETINGS[k].length + TIPS[k].length;
    }, 0),
};
