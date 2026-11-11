// 九宫格 · 历史内容分析汇总
// 设计前提：
//  1) 四套模板只换标签与提问，九个数据键固定不变，角度定义挂在「语义轴」上，跨模板通用；
//  2) cells[key] 保持为一段字符串，角度定义只用于本机统计，不改数据模型，历史数据零迁移；
//  3) 全部统计在本机完成，关键词匹配只作提示，不做语义判断，数据不离开本机；
//  4) 写作引导 chips 已下线（2026-11-05），页面不再引用子项列表；本模块只保留只读分析能力。

const store = require('./diary-store.js');

const SUBITEMS = {
    work: {
        axis: '工作 / 项目推进',
        purpose: '把「已经做成的事」与「卡住的地方」分开记，形成可回看的推进轨迹',
        items: [
            { id: 'w1', label: '今日推进', cue: '今日推进：', hint: '一件已经做成的事，写事实不写计划', words: ['推进', '完成', '做完', '交付', '提交', '上线'] },
            { id: 'w2', label: '关键卡点', cue: '卡在：', hint: '卡在哪一步、缺谁或缺什么条件', words: ['卡', '阻塞', '等', '还没', '没法', '缺'] },
            { id: 'w3', label: '协作沟通', cue: '和谁对齐：', hint: '与谁沟通、达成了什么一致', words: ['沟通', '对齐', '开会', '讨论', '确认', '同步'] },
            { id: 'w4', label: '一个决定', cue: '今天决定：', hint: '记下一个决定及理由，便于日后复盘', words: ['决定', '选择', '定了', '改为', '取舍'] },
            { id: 'w5', label: '明日第一步', cue: '明日第一步：', hint: '具体到能立刻动手的最小动作', words: ['明天', '下一步', '先做', '接着', '第一步'] },
        ],
    },
    money: {
        axis: '金钱 / 收支与安全感',
        purpose: '把流水、判断与情绪分开，留下「钱是怎么被决定的」而非单纯记账',
        items: [
            { id: 'm1', label: '今日一笔', cue: '今日一笔：', hint: '一笔值得记的进或出，金额可写可不写', words: ['花', '买', '付', '收', '到账', '元', '块'] },
            { id: 'm2', label: '按计划的花费', cue: '按计划：', hint: '这笔是否符合预算或原先的打算', words: ['预算', '计划', '按', '超了', '省下'] },
            { id: 'm3', label: '值不值', cue: '值不值：', hint: '事后看这笔花得值在哪', words: ['值', '值得', '划算', '后悔', '不亏'] },
            { id: 'm4', label: '安全感', cue: '关于钱，此刻：', hint: '此刻对钱的踏实或不安，一个词也行', words: ['踏实', '安心', '紧张', '焦虑', '够用', '不安'] },
            { id: 'm5', label: '一个小决定', cue: '财务小决定：', hint: '存、省、缓一缓、不买，都算决定', words: ['存', '省', '不买', '缓', '再看看', '留着'] },
        ],
    },
    health: {
        axis: '健康 / 身体与作息',
        purpose: '把主观体感与可量化的作息分开，长期看得出身体的规律',
        items: [
            { id: 'h1', label: '身体信号', cue: '身体信号：', hint: '哪里紧、哪里松，精力是高是低', words: ['累', '困', '酸', '紧', '松', '精神', '舒服'] },
            { id: 'h2', label: '睡眠', cue: '睡眠：', hint: '大致时长与醒来后的感觉', words: ['睡', '失眠', '早醒', '小时', '做梦', '醒来'] },
            { id: 'h3', label: '饮食', cue: '饮食：', hint: '有没有按时吃、有没有照顾好', words: ['吃', '饭', '早饭', '水', '咖啡', '按时'] },
            { id: 'h4', label: '活动量', cue: '活动：', hint: '走路、拉伸、运动，量力而行', words: ['走', '步', '跑', '拉伸', '运动', '出汗'] },
            { id: 'h5', label: '身体在要什么', cue: '身体想要：', hint: '早点睡、少一点、歇一下', words: ['休息', '早睡', '歇', '慢一点', '需要'] },
        ],
    },
    relation: {
        axis: '人际关系 / 联结与表达',
        purpose: '记录想联系的人与没说出口的话，让关系不只是「今天见了谁」',
        items: [
            { id: 'r1', label: '想联系的人', cue: '想联系：', hint: '一个名字或称呼就够', words: ['联系', '找', '打电话', '发消息', '约'] },
            { id: 'r2', label: '一句感谢', cue: '想谢谢：', hint: '对谁、为了哪件小事', words: ['谢谢', '感谢', '帮', '多亏', '照顾'] },
            { id: 'r3', label: '一次对话', cue: '那句对话：', hint: '哪句话到现在还放在心上', words: ['说', '聊', '提到', '讲', '对话'] },
            { id: 'r4', label: '没说出口的话', cue: '没说出口：', hint: '留白也算记录，不必勉强自己', words: ['没说', '忍住', '想说', '犹豫', '算了'] },
            { id: 'r5', label: '温和一点', cue: '想温和一点：', hint: '今天能做的一个很小的动作', words: ['温和', '耐心', '听', '让', '体谅'] },
        ],
    },
    future: {
        axis: '给明天 / 决心与承接',
        purpose: '把决心写成可执行的动作，并留下次日可回看的对照',
        items: [
            { id: 'f1', label: '今日决心', cue: '今日决心：', hint: '一句话，不写口号', words: ['决心', '打算', '要', '一定', '坚持'] },
            { id: 'f2', label: '只做一件事', cue: '只做一件：', hint: '如果今天只完成一件，选哪件', words: ['只做', '优先', '最要紧', '一件'] },
            { id: 'f3', label: '最小动作', cue: '最小动作：', hint: '具体到时间或地点，明天能直接开始', words: ['先', '第一步', '分钟', '点', '打开'] },
            { id: 'f4', label: '请记得', cue: '请记得：', hint: '写给未来某天回看的自己', words: ['记得', '别忘', '提醒', '以后'] },
            { id: 'f5', label: '回看标记', cue: '希望回看的日子：', hint: '标一个日期，未来对照是否兑现', words: ['回看', '下周', '下个月', '以后', '那天'] },
        ],
    },
    emotion: {
        axis: '今日情绪 / 觉察与安放',
        purpose: '情绪词、触发事件、身体感受三层分开，避免只写「还行」',
        items: [
            { id: 'e1', label: '情绪词', cue: '此刻情绪：', hint: '一个词，如实写，不评判', words: ['开心', '平静', '烦', '累', '焦虑', '松', '闷'] },
            { id: 'e2', label: '触发事件', cue: '因为：', hint: '是哪件事让情绪起来的', words: ['因为', '由于', '看到', '听到', '想起'] },
            { id: 'e3', label: '身体感受', cue: '身体里：', hint: '情绪落在身体的哪个位置', words: ['胸口', '胃', '肩膀', '头', '呼吸', '喉咙'] },
            { id: 'e4', label: '背后的在意', cue: '其实在意：', hint: '这份情绪在提醒我什么', words: ['在意', '害怕', '担心', '希望', '怕'] },
            { id: 'e5', label: '写完放下', cue: '写完想说：', hint: '写出来就轻一点，允许停在这里', words: ['放下', '算了', '轻', '过去', '先这样'] },
        ],
    },
    dream: {
        axis: '梦想 / 长期方向',
        purpose: '把遥远的目标拆成今天能看见的一小步和证据',
        items: [
            { id: 'd1', label: '今天一小步', cue: '离梦想更近的一点：', hint: '一个已经发生的小动作', words: ['一步', '靠近', '推进', '开始', '碰到'] },
            { id: 'd2', label: '在路上的证据', cue: '证据：', hint: '有什么事实说明已经在路上', words: ['证据', '说明', '已经', '累计', '坚持'] },
            { id: 'd3', label: '一年后的画面', cue: '一年后：', hint: '具体场景，不写抽象目标', words: ['一年', '以后', '将来', '那时', '希望'] },
            { id: 'd4', label: '想碰一下的事', cue: '想试一下：', hint: '一直想做、今天能碰十分钟', words: ['试试', '想做', '碰', '十分钟', '开始'] },
            { id: 'd5', label: '留出时间', cue: '留给它的时间：', hint: '为长期的事留一段不受打扰的时间', words: ['留', '时间', '分钟', '空出', '安排'] },
        ],
    },
    growth: {
        axis: '学习成长 / 新知与复盘',
        purpose: '新知、复盘、模式识别分开，让「学到了什么」能被再次找到',
        items: [
            { id: 'g1', label: '今天的新知', cue: '今天学到：', hint: '一件具体的、能复述出来的东西', words: ['学到', '知道', '明白', '发现', '原来'] },
            { id: 'g2', label: '哪里可以更好', cue: '可以更好：', hint: '只挑一处，不写自我批评', words: ['更好', '改进', '下次', '本可以', '调整'] },
            { id: 'g3', label: '错误的收获', cue: '反过来看：', hint: '那个错误现在带来了什么', words: ['错', '失误', '反而', '教训', '收获'] },
            { id: 'g4', label: '反复出现的课题', cue: '又出现：', hint: '同一个模式第几次出现', words: ['又', '反复', '总是', '每次', '还是'] },
            { id: 'g5', label: '留给自己的提问', cue: '想问自己：', hint: '不急着回答，先把问题存下来', words: ['为什么', '是不是', '要不要', '如果', '提问'] },
        ],
    },
    free: {
        axis: '自由格 / 不设限的留白',
        purpose: '承接所有不属于前八格的内容，降低空白页压力',
        items: [
            { id: 'x1', label: '脑中第一念', cue: '刚冒出来：', hint: '最先想到的，别修饰', words: ['突然', '刚才', '想起', '冒出'] },
            { id: 'x2', label: '怕忘的小事', cue: '怕忘了：', hint: '随手存，不写下来就会忘的', words: ['别忘', '记得', '待办', '要买', '要问'] },
            { id: 'x3', label: '一个画面', cue: '一个画面：', hint: '一个像照片一样的瞬间', words: ['看见', '阳光', '路上', '窗', '灯'] },
            { id: 'x4', label: '今天的标题', cue: '如果今天有标题：', hint: '用一句话给今天命名', words: ['标题', '今天叫', '一句话', '总结'] },
            { id: 'x5', label: '留给自己', cue: '想留给自己的：', hint: '任意内容，写多写少都算', words: ['自己', '留', '记下', '写一句'] },
        ],
    },
};

// 本地高频词过滤：虚词、常见口语短语一律不计
const STOP = [
    '今天', '明天', '昨天', '自己', '觉得', '感觉', '事情', '时候', '可以', '没有',
    '就是', '还是', '因为', '所以', '然后', '其实', '一下', '一点', '一些', '这个',
    '那个', '什么', '怎么', '已经', '可能', '应该', '需要', '想要', '这样', '那样',
    '出来', '起来', '到了', '看到', '想到', '知道', '一个', '一件', '还有', '不过',
    '但是', '如果', '有点', '不错', '一般', '之后', '之前', '现在', '以后', '没有',
];
const HEAD_STOP = '的了是在有和就都而及与也很还把被让从对为以于之其不没要会能可说做去来吧呢啊哦嗯呀嘛';
const TAIL_STOP = '的了着过是在有和就都也还吧呢啊哦嗯呀嘛么把被让从对为以于之其';

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function todayStr() { return fmt(new Date()); }

function shift(dateStr, delta) {
    const p = String(dateStr).split('-');
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + delta);
    return fmt(d);
}

function dayNum(dateStr) {
    const p = String(dateStr).split('-');
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
}

function cleanLen(text) {
    return String(text || '').replace(/\s/g, '').length;
}

function axisOf(key) {
    return SUBITEMS[key] ? SUBITEMS[key].axis : '自由记录';
}

function purposeOf(key) {
    return SUBITEMS[key] ? SUBITEMS[key].purpose : '';
}

// 取该格全部历史内容（按日期倒序），只用数据层公开方法，不直接碰 storage
function historyOf(key, limit) {
    const result = store.all();
    if (result.error) return [];
    const rows = [];
    result.data.forEach(function (rec) {
        if (!rec || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) return;
        const text = String((rec.cells || {})[key] || '').trim();
        if (!text) return;
        rows.push({
            date: rec.date,
            text: text,
            mood: String((rec.base || {}).mood || ''),
        });
    });
    rows.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
    return limit ? rows.slice(0, limit) : rows;
}

function topWords(rows, limit) {
    const counts = {};
    const days = {};
    rows.forEach(function (row) {
        const chunks = row.text.match(/[\u4e00-\u9fa5]+/g) || [];
        chunks.forEach(function (chunk) {
            for (let size = 2; size <= 4; size += 1) {
                for (let i = 0; i + size <= chunk.length; i += 1) {
                    const p = chunk.slice(i, i + size);
                    if (STOP.indexOf(p) >= 0) continue;
                    if (HEAD_STOP.indexOf(p.charAt(0)) >= 0) continue;
                    if (TAIL_STOP.indexOf(p.charAt(size - 1)) >= 0) continue;
                    counts[p] = (counts[p] || 0) + 1;
                    if (!days[p]) days[p] = {};
                    days[p][row.date] = true;
                }
            }
        });
    });
    const candidates = Object.keys(counts).map(function (p) {
        return { word: p, count: counts[p], days: Object.keys(days[p]).length };
    }).filter(function (x) { return x.days >= 2 && x.count >= 2; });
    candidates.sort(function (a, b) {
        return (b.days * 10 + b.count + b.word.length * 4) - (a.days * 10 + a.count + a.word.length * 4);
    });
    const picked = [];
    candidates.forEach(function (x) {
        if (picked.length >= (limit || 6)) return;
        let replaceAt = -1;
        for (let i = 0; i < picked.length; i += 1) {
            const p = picked[i].word;
            if (p.indexOf(x.word) >= 0) return;
            if (x.word.indexOf(p) >= 0) { replaceAt = i; break; }
        }
        if (replaceAt >= 0) picked[replaceAt] = x;
        else picked.push(x);
    });
    return picked;
}

// 子项覆盖度：按关键词粗匹配，只作「哪些角度写得少」的提示，不是语义判断
function coverageOf(rows, key) {
    const def = SUBITEMS[key];
    if (!def || !rows.length) return [];
    return def.items.map(function (it) {
        let hit = 0;
        rows.forEach(function (r) {
            if (it.words.some(function (w) { return r.text.indexOf(w) >= 0; })) hit += 1;
        });
        const pct = Math.round(hit * 100 / rows.length);
        return {
            label: it.label,
            count: hit,
            pct: pct,
            cls: pct >= 50 ? 'cov-high' : (pct > 0 ? 'cov-mid' : 'cov-low'),
        };
    });
}

function moodMixOf(rows) {
    const map = {};
    rows.forEach(function (r) {
        if (!r.mood) return;
        map[r.mood] = (map[r.mood] || 0) + 1;
    });
    return Object.keys(map).map(function (k) {
        return { label: k, count: map[k] };
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
}

// 单格历史分析汇总：返回结构已按 WXML 可直接渲染的方式扁平化
function analyze(key) {
    const rows = historyOf(key);
    const def = SUBITEMS[key];
    const empty = rows.length === 0;
    const today = todayStr();
    const lenByDate = {};

    let totalChars = 0;
    rows.forEach(function (r) {
        const n = cleanLen(r.text);
        lenByDate[r.date] = n;
        totalChars += n;
    });

    // 当前连续：今天没写时从昨天起算，避免白天打开就断签
    let cursor = lenByDate[today] ? today : shift(today, -1);
    let currentStreak = 0;
    while (lenByDate[cursor]) {
        currentStreak += 1;
        cursor = shift(cursor, -1);
    }

    const dates = Object.keys(lenByDate).sort();
    let bestStreak = 0;
    let run = 0;
    let prev = null;
    dates.forEach(function (ds) {
        run = (prev && dayNum(ds) - dayNum(prev) === 1) ? run + 1 : 1;
        if (run > bestStreak) bestStreak = run;
        prev = ds;
    });

    let days30 = 0, chars30 = 0, daysPrev30 = 0, charsPrev30 = 0;
    const t = dayNum(today);
    rows.forEach(function (r) {
        const diff = t - dayNum(r.date);
        const n = cleanLen(r.text);
        if (diff >= 0 && diff < 30) { days30 += 1; chars30 += n; }
        else if (diff >= 30 && diff < 60) { daysPrev30 += 1; charsPrev30 += n; }
    });

    const heat = [];
    for (let i = 29; i >= 0; i -= 1) {
        const ds = shift(today, -i);
        const n = lenByDate[ds] || 0;
        heat.push({
            date: ds,
            day: ds.slice(5),
            cls: n === 0 ? 'heat-cell heat-lv0'
                : (n < 15 ? 'heat-cell heat-lv1' : (n < 40 ? 'heat-cell heat-lv2' : 'heat-cell heat-lv3')),
        });
    }

    const coverage = coverageOf(rows, key);
    const weakest = coverage.slice().sort(function (a, b) { return a.pct - b.pct; })[0];
    let insight;
    if (empty) {
        insight = '这一格还没有历史内容。写下第一句，之后就能看到它自己的轨迹。';
    } else {
        const delta = days30 - daysPrev30;
        const trend = delta > 0 ? ('比上一个月多 ' + delta + ' 天')
            : (delta < 0 ? ('比上一个月少 ' + (-delta) + ' 天') : '与上一个月持平');
        const tail = (weakest && weakest.pct < 30)
            ? ('「' + weakest.label + '」写得较少，下次可以补一句。')
            : '各角度写得比较均衡，保持就好。';
        insight = '近 30 天写了 ' + days30 + ' 天，' + trend + '；' + tail;
    }

    const avgChars = rows.length ? Math.round(totalChars / rows.length) : 0;
    const lastDate = rows.length ? rows[0].date : '';

    return {
        key: key,
        axis: def ? def.axis : '自由记录',
        purpose: def ? def.purpose : '',
        empty: empty,
        metrics: [
            { label: '累计记录', value: rows.length, unit: '天' },
            { label: '累计字数', value: totalChars, unit: '字' },
            { label: '平均每篇', value: avgChars, unit: '字' },
            { label: '当前连续', value: currentStreak, unit: '天' },
            { label: '最长连续', value: bestStreak, unit: '天' },
            { label: '最近一次', value: lastDate ? lastDate.slice(5) : '—', unit: '' },
        ],
        compare: {
            daysNow: days30, daysPrev: daysPrev30,
            charsNow: chars30, charsPrev: charsPrev30,
            daysDelta: days30 - daysPrev30,
            charsDelta: chars30 - charsPrev30,
        },
        heat: heat,
        phrases: topWords(rows, 6),
        coverage: coverage,
        moodMix: key === 'emotion' ? moodMixOf(rows) : [],
        excerpts: rows.slice(0, 3).map(function (r) {
            return {
                date: r.date.slice(5),
                text: r.text.length > 56 ? r.text.slice(0, 56) + '…' : r.text,
            };
        }),
        insight: insight,
        note: '本机统计反复出现的字句与填写节奏，非语义分析；数据不离开本机。',
    };
}

module.exports = {
    SUBITEMS: SUBITEMS,
    axisOf: axisOf,
    purposeOf: purposeOf,
    historyOf: historyOf,
    analyze: analyze,
};
