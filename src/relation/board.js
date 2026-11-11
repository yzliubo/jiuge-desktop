'use strict';
// 九格手记 · 关系经营领域模块（九格第 4 格由一句话升级为结构化模块）
//
// 定位（文档 §0）：不是名片夹、不是销售 CRM，是「一本让你该给谁打电话的账」。
//   只回答四件事：这周该主动联系谁 / 上次见面聊了什么 / 关系结构偏没偏 / 答应过帮谁做什么。
//
// 边界（写死，防「顺手再加一个客户表」）：
//   1. 单一对象：只描述「人」；2. 字段可复原：contacts 卡在 12 字段封顶；
//   3. 指标可触发：每个统计都必须能推出一个动作（打电话 / 约饭 / 建任务）。
//   明确不做：通用元字段基类、销售漏斗 / 商机金额 / 跟进 SLA / 组织架构 / 评分星级。
//
// 数据：由主进程仓储读写 md_relation 单键（与 md_gtd / md_dream 同一先例），
//   本模块纯函数、不碰 wxStorage / 不联网 / 不读写文件。结构：
//     { version:1, contacts:[...], logs:[...], archived:[...], trimmed:0 }
//   contacts = 活跃联系人，archived = 已归档联系人（归档即移动，绝不硬删），logs = 联系流水。
//
// 派生而非存储（文档 §2.4，本模块最硬的一条）：
//   温度 / 上次联系 / 联系次数 / 渠道分布 / 逾期 一律不写库，只在读取时算。
//   存了就有两份真相，改一条 log 忘了更新派生值，界面立刻自相矛盾。
//   所以本文件所有 normalize / 动作函数都只放行白名单字段，任何注入的派生字段都会被削掉。
//
// 诚实边界（文档 §5.2，必须在界面上能翻译成一句人话）：
//   1. 温度是「记录的函数」，不是「关系的函数」——半年没记不等于半年没联系；
//   2. 渠道权重与 90 天半衰期是启发式，不是心理学常数，只用来排序「谁最久没被想起」；
//   3. 邓巴 5/15/50/150/500 是平均值不是上限，容量只做提示，绝不做保存闸门。
//   另外（§4.3）不做关系健康度 / 人脉总分——评分一出现，人就会去刷记录优化分数；
//   （§4.4）只记「我能帮他什么」giveFirst，不做「他给过我什么」的互惠对称账。

// ---------------------------------------------------------------------------
// 一、上限常量（文档 §2.2 / §2.3）
// ---------------------------------------------------------------------------
const MAX_CONTACTS = 600;
const MAX_LOGS = 5000;
// contacts 12 字段的上限；archived 里也是联系人，沿用同一上限
const NAME_MAX = 24;
const ORG_MAX = 40;
const TITLE_MAX = 24;
const PHONE_MAX = 32;
const WECHAT_MAX = 40;
const HOW_MET_MAX = 60;
const GIVE_FIRST_MAX = 120;
const NOTE_MAX = 400;
const MAX_TAGS = 8;
const TAG_MAX = 12;
// logs 字段上限
const SUMMARY_MAX = 200;
const FEELING_MAX = 300;
const FOLLOW_UP_MAX = 100;
const MAX_CONTACT_IDS = 12;
const ID_MAX = 64;
// 温度公式：半衰期 90 天、压缩系数 6（文档 §4.1）
const HALF_LIFE_DAYS = 90;
const TEMP_SCALE = 6;
// 渠道结构窗口：近 12 周（文档 §4.2）
const CHANNEL_WINDOW_WEEKS = 12;
const CHANNEL_WINDOW_DAYS = CHANNEL_WINDOW_WEEKS * 7;
// 冷却告警：超过 2× 预期间隔（文档 §4.2）
const OVERDUE_FACTOR = 2;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// 二、三轴元数据（文档 §1）—— 单一真相，由数组生成映射，避免两处重复定义
// ---------------------------------------------------------------------------
// A 轴 来源圈层（怎么认识的，事实，几乎不变）；顺带映射 Putnam 的 bonding / bridging
//   colleague 是混合型，分析时两栏各计一半（文档 §1.3）
const CIRCLES = [
    { key: 'classmate', label: '同学', capital: 'bonding' },
    { key: 'colleague', label: '同事', capital: 'half' },
    { key: 'client', label: '客户', capital: 'bridging' },
    { key: 'supplier', label: '供应商', capital: 'bridging' },
    { key: 'friend', label: '朋友', capital: 'bonding' },
    { key: 'other', label: '普通联系人', capital: 'bridging' },
];
// B 轴 亲密度分层（该多久联系，判断，可随时改）。cadence = 预期间隔（天），capacity = 邓巴容量提示
const TIERS = [
    { key: 'core', label: '核心圈', cadence: 30, capacity: 5 },
    { key: 'close', label: '紧密圈', cadence: 60, capacity: 15 },
    { key: 'active', label: '活跃圈', cadence: 120, capacity: 50 },
    { key: 'periphery', label: '外围圈', cadence: 365, capacity: 150 },
    { key: 'weak', label: '弱连接', cadence: 0, capacity: null },   // 不提醒、容量不限
];
// 渠道含量权重（文档 §3.1）。other 是 enum 里的兜底，但 §3.1 权重表与本模块需求都只
//   给了 6 个渠道，未给 other 权重：按 0 处理，不臆造数值污染温度；界面要计入可自行补值。
const CHANNELS = [
    { key: 'meal', label: '餐会', weight: 2.5 },
    { key: 'meet', label: '见面', weight: 2.0 },
    { key: 'meeting', label: '会议', weight: 1.3 },
    { key: 'call', label: '电话', weight: 1.3 },
    { key: 'mail', label: '邮件', weight: 0.7 },
    { key: 'wechat', label: '微信', weight: 0.7 },
    { key: 'other', label: '其他', weight: 0 },
];
// 深度系数：渠道决定广度，深度决定重量（文档 §3.1）
const DEPTHS = [
    { key: 'small', label: '寒暄', weight: 0.8 },
    { key: 'work', label: '事务', weight: 1.0 },
    { key: 'deep', label: '交心', weight: 1.4 },
];
const INITIATORS = ['me', 'them'];

const CIRCLE_KEYS = [];
const CIRCLE_LABEL = {};
const CIRCLE_CAPITAL = {};
CIRCLES.forEach(function (c) {
    CIRCLE_KEYS.push(c.key);
    CIRCLE_LABEL[c.key] = c.label;
    CIRCLE_CAPITAL[c.key] = c.capital;
});
const TIER_KEYS = [];
const TIER_LABEL = {};
const TIER_CADENCE = {};
const TIER_CAPACITY = {};
const TIER_ORDER = {};
TIERS.forEach(function (t, i) {
    TIER_KEYS.push(t.key);
    TIER_LABEL[t.key] = t.label;
    TIER_CADENCE[t.key] = t.cadence;
    TIER_CAPACITY[t.key] = t.capacity;
    TIER_ORDER[t.key] = i;
});
const CHANNEL_KEYS = [];
const CHANNEL_LABEL = {};
const CHANNEL_WEIGHT = {};
CHANNELS.forEach(function (c) {
    CHANNEL_KEYS.push(c.key);
    CHANNEL_LABEL[c.key] = c.label;
    CHANNEL_WEIGHT[c.key] = c.weight;
});
const DEPTH_KEYS = [];
const DEPTH_LABEL = {};
const DEPTH_WEIGHT = {};
DEPTHS.forEach(function (d) {
    DEPTH_KEYS.push(d.key);
    DEPTH_LABEL[d.key] = d.label;
    DEPTH_WEIGHT[d.key] = d.weight;
});
// 只有这三层参与冷却告警；弱连接与外围不提醒（文档 §4.2 / §5.1 Granovetter）
const COOL_TIERS = ['core', 'close', 'active'];

// ---------------------------------------------------------------------------
// 三、防御型工具：脏数据一律不抛，非字符串标量静默落空
// ---------------------------------------------------------------------------
function str(v) {
    if (v === null || v === undefined) return '';
    const t = typeof v;
    if (t === 'string') return v;
    if (t === 'number') return isFinite(v) ? String(v) : '';
    if (t === 'boolean') return v ? 'true' : 'false';
    // 对象 / 数组 / Symbol / BigInt / function 一律落空：绝不 String(v) 触发 getter 或抛错
    return '';
}

function clean(v, max) {
    let s = str(v).replace(/\r/g, '').trim();
    return max && s.length > max ? s.slice(0, max) : s;
}

function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return isFinite(n) ? n : 0;
    }
    return 0;   // Symbol / BigInt / 对象 → 0，Number(Symbol()) 会抛，必须挡在这里
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function todayOf(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}

// 光靠正则不够：「2026-13-40」也是 4-2-2 位数字，必须回读一遍 Date（文档 §2.3 / dream 前车之鉴）
function validDate(iso) {
    const t = str(iso);
    if (!DATE_RE.test(t)) return false;
    const p = t.split('-');
    const y = Number(p[0]);
    const m = Number(p[1]);
    const d = Number(p[2]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCFullYear(y);   // 修正 0-99 年被 Date 构造当成 19xx
    return dt.getUTCFullYear() === y && (dt.getUTCMonth() + 1) === m && dt.getUTCDate() === d;
}

// 日期差：按 UTC 天数算，避开夏令时与本地时区偏移（沿用 gtd 的口径）
function dayNumber(iso) {
    const p = str(iso).split('-');
    if (p.length !== 3) return NaN;
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
}

function diffDays(from, to) {
    const a = dayNumber(from);
    const b = dayNumber(to);
    if (isNaN(a) || isNaN(b)) return 0;
    return Math.round(b - a);
}

// 调用方的 now 兼容：'YYYY-MM-DD' / Date / 毫秒数 / 缺省（今天）
function toToday(now) {
    if (typeof now === 'string' && validDate(now)) return now;
    if (typeof now === 'number' && isFinite(now)) return todayOf(new Date(now));
    if (now && typeof now.getTime === 'function' && !isNaN(now.getTime())) return todayOf(now);
    return todayOf(new Date());
}

function toNowMs(now, today) {
    if (typeof now === 'number' && isFinite(now)) return now;
    if (now && typeof now.getTime === 'function' && !isNaN(now.getTime())) return now.getTime();
    const parsed = Date.parse(today + 'T00:00:00Z');
    return isFinite(parsed) ? parsed : 0;
}

let seq = 0;
function newId(prefix) {
    seq += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + seq.toString(36)
        + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// 四、枚举收敛：非法值落文档规定的默认，不抛、不臆造新枚举
// ---------------------------------------------------------------------------
function normCircle(raw) {
    const k = str(raw);
    return CIRCLE_KEYS.indexOf(k) >= 0 ? k : 'other';
}
function normTier(raw) {
    const k = str(raw);
    return TIER_KEYS.indexOf(k) >= 0 ? k : 'active';
}
function normChannel(raw) {
    const k = str(raw);
    return CHANNEL_KEYS.indexOf(k) >= 0 ? k : 'other';
}
function normDepth(raw) {
    const k = str(raw);
    return DEPTH_KEYS.indexOf(k) >= 0 ? k : 'work';
}
function normInitiator(raw) {
    const k = str(raw);
    return INITIATORS.indexOf(k) >= 0 ? k : '';
}
// 标签：去重、去空、去前导 #（# 由界面加，存储不带）、8×12 封顶
function normTags(raw) {
    const out = [];
    const seen = {};
    (Array.isArray(raw) ? raw : []).forEach(function (t) {
        const v = clean(t, TAG_MAX).replace(/^#+/, '').trim();
        if (!v || seen[v] || out.length >= MAX_TAGS) return;
        seen[v] = true;
        out.push(v);
    });
    return out;
}

// ---------------------------------------------------------------------------
// 五、白名单规范化：contacts 12 字段 / logs 12 字段，派生值一个都不放行
// ---------------------------------------------------------------------------
function normContact(raw) {
    const c = (raw && typeof raw === 'object') ? raw : {};
    const name = clean(c.name, NAME_MAX);
    if (!name) return null;                 // 姓名空则整条丢弃（同 GTD 的 title 规则，文档 §2.2）
    const createdAt = num(c.createdAt) || Date.now();
    return {
        id: clean(c.id, ID_MAX) || newId('rc'),
        name: name,
        circle: normCircle(c.circle),
        tier: normTier(c.tier),
        org: clean(c.org, ORG_MAX),
        title: clean(c.title, TITLE_MAX),
        phone: clean(c.phone, PHONE_MAX),
        wechat: clean(c.wechat, WECHAT_MAX),
        howMet: clean(c.howMet, HOW_MET_MAX),
        giveFirst: clean(c.giveFirst, GIVE_FIRST_MAX),
        tags: normTags(c.tags),
        note: clean(c.note, NOTE_MAX),
        createdAt: createdAt,
        updatedAt: num(c.updatedAt) || createdAt,
        // 刻意没有：生日 / 性别 / 地址 / 公司规模 / 职位级别 / 跟进阶段 / 评分 / 头像 /
        //   cadence（逐人间隔）/ archived 布尔 / lastContactAt / temperature / count …
        //   cadence 见 §1.2 引用但未进 §2.2 的 12 字段，为守封顶改用 tier 默认常量；
        //   归档状态由「人在 contacts 还是 archived」表达，不再存一份布尔，避免两份真相。
    };
}

// validIds：合法联系人 id 集合（contacts ∪ archived）。一次 log 可记多人，
//   不存在的 id 静默剔除、contactIds 去重、全空则整条丢弃（文档 §2.3 / §3.2）。
function normLog(raw, validIds) {
    const l = (raw && typeof raw === 'object') ? raw : {};
    const seen = {};
    const contactIds = [];
    (Array.isArray(l.contactIds) ? l.contactIds : []).forEach(function (x) {
        const id = clean(x, ID_MAX);
        if (!id || seen[id] || contactIds.length >= MAX_CONTACT_IDS) return;
        if (validIds && !validIds[id]) return;   // 不存在的 id 静默剔除
        seen[id] = true;
        contactIds.push(id);
    });
    if (!contactIds.length) return null;         // 全空则整条丢弃
    // 非法日期（含 2026-13-40）落今天：脏串绝不写库（文档 §2.3）
    const date = validDate(l.date) ? str(l.date) : todayOf(new Date());
    return {
        id: clean(l.id, ID_MAX) || newId('rl'),
        date: date,
        contactIds: contactIds,
        channel: normChannel(l.channel),
        depth: normDepth(l.depth),
        summary: clean(l.summary, SUMMARY_MAX),
        feeling: clean(l.feeling, FEELING_MAX),
        followUp: clean(l.followUp, FOLLOW_UP_MAX),
        taskId: clean(l.taskId, ID_MAX),
        whoInitiated: normInitiator(l.whoInitiated),
        createdAt: num(l.createdAt) || Date.now(),
        // 刻意没有：任何派生统计、任何「按人展开后的副本」
    };
}

// normalize：幂等、脏数据不抛、上限截断、并返回 trimmed 标记（文档 §2.3 / §7.2）
//   trimmed 记在返回对象上（不参与领域数据）。为守住幂等：输入已是规范化 state 时沿用其
//   trimmed；否则按「本次输入超出上限的条数」重算。这样 normalize(normalize(x)) 全对象相等。
function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const rawC = Array.isArray(src.contacts) ? src.contacts.length : 0;
    const rawL = Array.isArray(src.logs) ? src.logs.length : 0;
    const rawA = Array.isArray(src.archived) ? src.archived.length : 0;
    const trimmed = (typeof src.trimmed === 'number' && isFinite(src.trimmed) && src.trimmed >= 0)
        ? Math.floor(src.trimmed)
        : Math.max(0, rawC - MAX_CONTACTS) + Math.max(0, rawL - MAX_LOGS)
            + Math.max(0, rawA - MAX_CONTACTS);

    const seenContact = {};
    const contacts = (Array.isArray(src.contacts) ? src.contacts : [])
        .slice(0, MAX_CONTACTS)
        .map(function (r) {
            const c = normContact(r);
            if (!c) return null;
            if (seenContact[c.id]) c.id = newId('rc');   // 重复 id 重发，不覆盖
            seenContact[c.id] = true;
            return c;
        })
        .filter(function (c) { return !!c; });

    const archived = (Array.isArray(src.archived) ? src.archived : [])
        .slice(0, MAX_CONTACTS)
        .map(function (r) {
            const c = normContact(r);
            if (!c) return null;
            if (seenContact[c.id]) c.id = newId('rc');   // 与活跃区同 id 也重发
            seenContact[c.id] = true;
            return c;
        })
        .filter(function (c) { return !!c; });

    // logs 的 contactIds 校验用「合并后的全量 id」：归档人仍算存在，其历史流水不会被剔除
    const validIds = seenContact;
    const seenLog = {};
    const logs = (Array.isArray(src.logs) ? src.logs : [])
        .slice(0, MAX_LOGS)
        .map(function (r) {
            const l = normLog(r, validIds);
            if (!l) return null;
            if (seenLog[l.id]) l.id = newId('rl');
            seenLog[l.id] = true;
            return l;
        })
        .filter(function (l) { return !!l; });

    return { version: 1, contacts: contacts, logs: logs, archived: archived, trimmed: trimmed };
}

function empty() {
    return { version: 1, contacts: [], logs: [], archived: [], trimmed: 0 };
}

// 不种任何假数据（与 dream 的 seedState 不同）：通讯录是第三方隐私，示例姓名毫无意义
function seedState() {
    return empty();
}

// ---------------------------------------------------------------------------
// 六、内部派生：一律读时算，绝不写回 state
// ---------------------------------------------------------------------------
// 属于该人的 log：遍历 logs 一次，一条 log 对该人只出现一次。
//   这是「多人 log 按人展开、一条只给每人计 1 次」的关键——按 log 条数判定存在，
//   不按 contactIds 里的人数累加（否则一桌八人的餐会给每人算 8 次，温度集体虚高，§3.2）。
function logsForRaw(s, id) {
    return s.logs.filter(function (l) { return l.contactIds.indexOf(id) >= 0; });
}

function contributionOf(l, days) {
    const w = CHANNEL_WEIGHT[l.channel];
    const dw = DEPTH_WEIGHT[l.depth];
    const cw = (w === undefined ? 0 : w) * (dw === undefined ? 1 : dw);
    return cw * Math.pow(0.5, Math.max(0, days) / HALF_LIFE_DAYS);
}

// 一个人的全部派生值。tier 可选（只用于 overdue / cool，温度与之无关）
function contactStats(s, id, today, tier) {
    const rows = logsForRaw(s, id);
    const todayNum = dayNumber(today);
    let last = null;
    let S = 0;
    let count90 = 0;
    let count365 = 0;
    const channelMix = {};
    const depthMix = {};
    rows.forEach(function (l) {
        if (!last || l.date > last) last = l.date;          // YYYY-MM-DD 字符串可直接比大小
        const days = Math.round(todayNum - dayNumber(l.date));
        if (days >= 0 && days <= 90) count90 += 1;
        if (days >= 0 && days <= 365) count365 += 1;
        channelMix[l.channel] = (channelMix[l.channel] || 0) + 1;
        depthMix[l.depth] = (depthMix[l.depth] || 0) + 1;
        S += contributionOf(l, days);                       // 未来日期被 clamp 到 0，不放大温度
    });
    const daysSince = last ? Math.round(todayNum - dayNumber(last)) : null;
    const temperature = rows.length
        ? Math.round(100 * (1 - Math.exp(-S / TEMP_SCALE)))
        : null;                                              // 无记录 = null，不是 0（§7.2 ④）
    const cadence = tier ? (TIER_CADENCE[tier] || 0) : 0;
    const never = rows.length === 0;
    const overdue = cadence > 0 && daysSince !== null && daysSince > OVERDUE_FACTOR * cadence;
    const cool = cadence > 0 && COOL_TIERS.indexOf(tier) >= 0 && (overdue || never);
    return {
        lastContactAt: last,
        daysSince: daysSince,
        count90: count90,
        count365: count365,
        channelMix: channelMix,
        depthMix: depthMix,
        S: S,
        temperature: temperature,
        cadence: cadence,
        never: never,
        overdue: overdue,
        cool: cool,
        rowCount: rows.length,
    };
}

function findContact(s, id) {
    const key = str(id);
    let hit = s.contacts.filter(function (c) { return c.id === key; })[0];
    if (!hit) hit = s.archived.filter(function (c) { return c.id === key; })[0];
    return hit || null;
}

function isArchived(s, id) {
    return s.archived.some(function (c) { return c.id === id; });
}

// ---------------------------------------------------------------------------
// 七、联系人动作
// ---------------------------------------------------------------------------
function addContact(state, patch) {
    const s = normalize(state);
    const p = (patch && typeof patch === 'object') ? patch : {};
    const raw = Object.assign({}, p);
    if (!clean(raw.id, ID_MAX)) raw.id = newId('rc');
    if (!num(raw.createdAt)) raw.createdAt = Date.now();
    if (!num(raw.updatedAt)) raw.updatedAt = raw.createdAt;
    const c = normContact(raw);
    if (!c) return s;                                        // 姓名空 → 整条丢弃
    if (s.contacts.length >= MAX_CONTACTS) return s;        // 超限不静默塞入（诚实口径）
    // 与现有（含归档区）同 id 则重发，绝不覆盖别人
    if (s.contacts.concat(s.archived).some(function (x) { return x.id === c.id; })) c.id = newId('rc');
    // 刻意不检查邓巴容量：核心圈第 6 人照样保存，容量只做提示（文档 §1.2 / §7.2 ⑦）
    s.contacts.push(c);
    return s;
}

function updateContact(state, id, patch) {
    const s = normalize(state);
    const c = findContact(s, id);
    if (!c) return s;
    const p = (patch && typeof patch === 'object') ? patch : {};
    // 逐字段白名单：id / createdAt 不可改；归档走 archiveContact；派生字段不可写
    if (p.name !== undefined) { const v = clean(p.name, NAME_MAX); if (v) c.name = v; }
    if (p.circle !== undefined) c.circle = normCircle(p.circle);
    if (p.tier !== undefined) c.tier = normTier(p.tier);
    if (p.org !== undefined) c.org = clean(p.org, ORG_MAX);
    if (p.title !== undefined) c.title = clean(p.title, TITLE_MAX);
    if (p.phone !== undefined) c.phone = clean(p.phone, PHONE_MAX);
    if (p.wechat !== undefined) c.wechat = clean(p.wechat, WECHAT_MAX);
    if (p.howMet !== undefined) c.howMet = clean(p.howMet, HOW_MET_MAX);
    // 「标记已给过」= 把 giveFirst 清空，不需要第 13 个「已兑现」字段（守住 12 字段封顶）
    if (p.giveFirst !== undefined) c.giveFirst = clean(p.giveFirst, GIVE_FIRST_MAX);
    if (p.tags !== undefined) c.tags = normTags(p.tags);
    if (p.note !== undefined) c.note = clean(p.note, NOTE_MAX);
    c.updatedAt = Date.now();
    return s;
}

// 只归档，不硬删（文档 §2.5）：人从 contacts 移到 archived，logs 一条都不动。
//   「我 2019 年见过他」是事实，不因归档而消失——删联系人是销毁自己的历史。
function archiveContact(state, id) {
    const s = normalize(state);
    const key = str(id);
    const at = s.contacts.map(function (c) { return c.id; }).indexOf(key);
    if (at < 0) return s;                                    // 找不到 / 已归档 → 幂等返回
    if (s.archived.length >= MAX_CONTACTS) return s;
    const c = s.contacts.splice(at, 1)[0];
    c.updatedAt = Date.now();
    s.archived.push(c);
    return s;                                                // logs 原样保留
}

// 通讯录行：opts.includeArchived / circle / tier / tag / query / now / sort
//   返回的每一行都带读时派生值（不写库），界面一次拿全；筛选口径与 analytics 对得上账。
function listContacts(state, opts) {
    const s = normalize(state);
    const o = (opts && typeof opts === 'object') ? opts : {};
    const today = toToday(o.now);
    const includeArchived = !!o.includeArchived;
    const circle = clean(o.circle, 24);
    const tier = clean(o.tier, 24);
    const tag = clean(o.tag, TAG_MAX).replace(/^#+/, '').trim();
    const q = clean(o.query, 60).toLowerCase();
    const sort = clean(o.sort, 16) || 'days';

    const pool = s.contacts.slice();
    if (includeArchived) s.archived.forEach(function (c) { pool.push(c); });

    const rows = pool.filter(function (c) {
        if (circle && c.circle !== circle) return false;
        if (tier && c.tier !== tier) return false;
        if (tag && c.tags.indexOf(tag) < 0) return false;
        if (q) {
            const hay = [c.name, c.org, c.title, c.howMet, c.giveFirst,
                c.tags.join(' '), c.note].join(' ').toLowerCase();
            if (hay.indexOf(q) < 0) return false;
        }
        return true;
    }).map(function (c) {
        const st = contactStats(s, c.id, today, c.tier);
        return Object.assign({}, c, {
            isArchived: isArchived(s, c.id),
            circleLabel: CIRCLE_LABEL[c.circle],
            tierLabel: TIER_LABEL[c.tier],
            lastContactAt: st.lastContactAt,
            daysSince: st.daysSince,
            count90: st.count90,
            count365: st.count365,
            temperature: st.temperature,
            never: st.never,
            overdue: st.overdue,
            channelMix: st.channelMix,
            cadence: st.cadence,
        });
    });

    rows.sort(function (a, b) {
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'recent') {
            const ad = a.daysSince === null ? Infinity : a.daysSince;
            const bd = b.daysSince === null ? Infinity : b.daysSince;
            if (ad !== bd) return ad - bd;
            return a.name.localeCompare(b.name);
        }
        if (sort === 'temperature') {
            const at = a.temperature === null ? -1 : a.temperature;
            const bt = b.temperature === null ? -1 : b.temperature;
            if (at !== bt) return bt - at;
            return a.name.localeCompare(b.name);
        }
        // 默认 days：最久没被想起的排最前，从未记录最前（文档 §5.2 只用来排序谁最久没被想起）
        const ad = a.daysSince === null ? Infinity : a.daysSince;
        const bd = b.daysSince === null ? Infinity : b.daysSince;
        if (ad !== bd) return bd - ad;
        return a.name.localeCompare(b.name);
    });
    return rows;
}

// ---------------------------------------------------------------------------
// 八、联系流水动作
// ---------------------------------------------------------------------------
function addLog(state, patch) {
    const s = normalize(state);
    const p = (patch && typeof patch === 'object') ? patch : {};
    const validIds = {};
    s.contacts.forEach(function (c) { validIds[c.id] = true; });
    s.archived.forEach(function (c) { validIds[c.id] = true; });
    const raw = Object.assign({}, p);
    if (!clean(raw.id, ID_MAX)) raw.id = newId('rl');
    if (!num(raw.createdAt)) raw.createdAt = Date.now();
    const l = normLog(raw, validIds);
    if (!l) return s;                                        // contactIds 全空 / 全不存在 → 丢弃
    if (s.logs.length >= MAX_LOGS) return s;
    if (s.logs.some(function (x) { return x.id === l.id; })) l.id = newId('rl');
    s.logs.push(l);
    return s;                                                // 一次 log 可带多个 contactIds
}

// 删一条自己记错的记录是被允许的权利（与「删联系人」风险不同，文档 §2.5）。
//   派生值不存库，所以删完温度 / 上次联系 / 次数立刻自动重算，不会留下不一致。
function removeLog(state, id) {
    const s = normalize(state);
    const key = str(id);
    s.logs = s.logs.filter(function (l) { return l.id !== key; });
    return s;
}

// 某人的流水（按日期倒序）。只看 logs，不看人在哪个数组 —— 归档人的流水永远查得到。
//   每条附带渠道 / 深度权重与贡献，供右栏「温度拆解（渠道 × 深度 × 衰减）」只读呈现（§6.3）。
//   可选第三参 now 用于与 temperature(state, id, now) 对账，缺省用当天。
function logsFor(state, contactId, now) {
    const s = normalize(state);
    const id = str(contactId);
    const today = toToday(now);
    const todayNum = dayNumber(today);
    return logsForRaw(s, id).map(function (l) {
        const days = Math.round(todayNum - dayNumber(l.date));
        return Object.assign({}, l, {
            channelLabel: CHANNEL_LABEL[l.channel],
            depthLabel: DEPTH_LABEL[l.depth],
            daysAgo: days,
            channelWeight: CHANNEL_WEIGHT[l.channel] === undefined ? 0 : CHANNEL_WEIGHT[l.channel],
            depthWeight: DEPTH_WEIGHT[l.depth] === undefined ? 1 : DEPTH_WEIGHT[l.depth],
            contribution: Math.round(contributionOf(l, days) * 1000) / 1000,
        });
    }).sort(function (a, b) {
        return b.date.localeCompare(a.date) || b.createdAt - a.createdAt;
    });
}

// ---------------------------------------------------------------------------
// 九、关系温度（文档 §4.1，唯一核心指标）
//   S = Σ (渠道权重 × 深度系数 × 0.5^(距今天数 / 90))
//   温度 = round(100 × (1 - e^(-S / 6)))；无记录返回 null 而非 0
//   返回纯数字（或 null）：名字叫什么就返回什么，拆解交给 logsFor。
// ---------------------------------------------------------------------------
function temperature(state, contactId, now) {
    const s = normalize(state);
    return contactStats(s, str(contactId), toToday(now)).temperature;
}

// ---------------------------------------------------------------------------
// 十、分析：四个视角，每个都能推到一个动作（文档 §4.2）
//   不给总分 / 不给健康度评分（§4.3）——评分会被「刷记录」优化，替代方案是陈述事实的
//   冷却名单 + 矛盾清单。四个视角一律只基于活跃 contacts；归档人已退场，不进当前结构。
// ---------------------------------------------------------------------------
function analytics(state, now) {
    const s = normalize(state);
    const today = toToday(now);
    const todayNum = dayNumber(today);
    const nowMs = toNowMs(now, today);

    const stats = {};
    s.contacts.forEach(function (c) { stats[c.id] = contactStats(s, c.id, today, c.tier); });

    // ---- 视角 1：冷却名单（冷却告警）→ 动作「约一下」→ 建任务，带 contactId ----
    const coolingItems = [];
    s.contacts.forEach(function (c) {
        const st = stats[c.id];
        if (!st.cool) return;
        coolingItems.push({
            id: c.id,
            contactId: c.id,                                 // 建任务时挂这个 id
            name: c.name,
            tier: c.tier,
            tierLabel: TIER_LABEL[c.tier],
            cadence: st.cadence,
            lastContactAt: st.lastContactAt,
            daysSince: st.daysSince,
            never: st.never,
            overdue: st.overdue,
            action: '约一下',
            actionLabel: '建任务（约饭 / 打个电话）',
            actionHint: st.never
                ? '标为' + TIER_LABEL[c.tier] + '，但从未记录过联系'
                : '标为' + TIER_LABEL[c.tier] + '，已 ' + st.daysSince + ' 天没联系（预期间隔 '
                    + st.cadence + ' 天）',
        });
    });
    coolingItems.sort(function (a, b) {
        const ad = a.daysSince === null ? Infinity : a.daysSince;
        const bd = b.daysSince === null ? Infinity : b.daysSince;
        if (ad !== bd) return bd - ad;
        return a.name.localeCompare(b.name);
    });
    // §1.4「该疏不疏」：弱连接近 90 天 ≥3 次交心 → 可能该升级（只提示、不自动改）
    const upgrades = [];
    s.contacts.forEach(function (c) {
        if (c.tier !== 'weak') return;
        const deep90 = logsForRaw(s, c.id).filter(function (l) {
            const d = todayNum - dayNumber(l.date);
            return l.depth === 'deep' && d >= 0 && d <= 90;
        }).length;
        if (deep90 < 3) return;
        upgrades.push({
            id: c.id, contactId: c.id, name: c.name, deep90: deep90,
            action: '考虑升级层级',
            actionHint: '近 90 天交心 ' + deep90 + ' 次，标为弱连接可能已经名不副实',
        });
    });
    const cooling = {
        label: '冷却名单',
        action: '「约一下」→ 建任务（约饭 / 打个电话），任务带 contactId',
        count: coolingItems.length,
        items: coolingItems,
        upgrades: upgrades,
        note: '只陈述事实（标为紧密、214 天没联系），不给「关系恶化」这种判断；弱连接不参与冷却。',
    };

    // ---- 视角 2：来源圈层分布 / 结构平衡 → 动作「看看这半年新认识的人」----
    const byCircle = {};
    CIRCLE_KEYS.forEach(function (k) { byCircle[k] = 0; });
    let bonding = 0;
    let bridging = 0;
    const tierCount = {};
    TIER_KEYS.forEach(function (k) { tierCount[k] = 0; });
    s.contacts.forEach(function (c) {
        byCircle[c.circle] += 1;
        tierCount[c.tier] += 1;
        const cap = CIRCLE_CAPITAL[c.circle];
        if (cap === 'bonding') bonding += 1;
        else if (cap === 'bridging') bridging += 1;
        else { bonding += 0.5; bridging += 0.5; }            // 同事：两栏各计一半
    });
    const capTotal = bonding + bridging;
    const bridgingRatio = capTotal ? bridging / capTotal : 0;
    const narrow = capTotal > 0 && bridgingRatio < 0.3;
    const cutoff = nowMs - 90 * 86400000;
    const recentWeak = s.contacts.filter(function (c) {
        return c.tier === 'weak' && c.createdAt >= cutoff;
    }).map(function (c) {
        return {
            id: c.id, contactId: c.id, name: c.name, createdAt: c.createdAt,
            action: '看看这半年新认识的人',
            actionHint: '90 天内新增的弱连接，约一个聊聊看',
        };
    });
    // 容量只做提示（3/5 这种），over 为 true 也绝不阻止保存（文档 §1.2 / §5.2）
    const tierCapacity = TIERS.map(function (t) {
        const count = tierCount[t.key];
        return {
            key: t.key, label: t.label, count: count,
            capacity: t.capacity, over: t.capacity !== null && count > t.capacity,
        };
    });
    const structure = {
        label: '来源圈层分布',
        action: '「看看这半年新认识的人」→ 列出 90 天内新增的 weak 层联系人',
        byCircle: byCircle,
        total: s.contacts.length,
        bonding: bonding,
        bridging: bridging,
        bridgingRatio: Math.round(bridgingRatio * 1000) / 1000,
        narrow: narrow,
        hint: narrow
            ? '信息面偏窄：bridging 占比 ' + Math.round(bridgingRatio * 100) + '%，低于 30%'
            : 'bonding : bridging = ' + Math.round(bonding * 10) / 10 + ' : '
                + Math.round(bridging * 10) / 10,
        recentWeak: recentWeak,
        tierCapacity: tierCapacity,
        note: 'bonding（同学 / 朋友）抗风险，bridging（客户 / 供应商 / 普通联系人）带新信息；'
            + '同事两栏各计一半。容量是邓巴数启发式，只提示不限制。',
    };

    // ---- 视角 3：渠道分布 → 动作「挑三个人这周见一面」----
    //   按 log 条数统计（一条 log 一个渠道，不按人展开），占比可与流水列表直接对账
    const recent = s.logs.filter(function (l) {
        const d = todayNum - dayNumber(l.date);
        return d >= 0 && d <= CHANNEL_WINDOW_DAYS;
    });
    const mix = {};
    CHANNEL_KEYS.forEach(function (k) { mix[k] = 0; });
    recent.forEach(function (l) { mix[l.channel] = (mix[l.channel] || 0) + 1; });
    const totalLogs = recent.length;
    const ratio = {};
    CHANNEL_KEYS.forEach(function (k) {
        ratio[k] = totalLogs ? Math.round(mix[k] * 100 / totalLogs) : 0;
    });
    const online = (mix.wechat || 0) + (mix.mail || 0);
    const onlineRatio = totalLogs ? online / totalLogs : 0;
    const onlyOnline = totalLogs > 0 && onlineRatio > 0.8;
    // 候选：温度最高但「只有线上记录」的人（该人所有 log 全是微信 / 邮件），取 3 个
    const candidates = [];
    s.contacts.forEach(function (c) {
        const rows = logsForRaw(s, c.id);
        if (!rows.length) return;
        const allOnline = rows.every(function (l) {
            return l.channel === 'wechat' || l.channel === 'mail';
        });
        if (!allOnline) return;
        candidates.push({
            id: c.id, contactId: c.id, name: c.name,
            temperature: stats[c.id].temperature,
            action: '这周见一面',
            actionHint: '温度 ' + stats[c.id].temperature + '，但记下来的全是线上往来',
        });
    });
    candidates.sort(function (a, b) {
        const at = a.temperature === null ? -1 : a.temperature;
        const bt = b.temperature === null ? -1 : b.temperature;
        if (at !== bt) return bt - at;
        return a.name.localeCompare(b.name);
    });
    const channels = {
        label: '渠道分布',
        action: '「挑三个人这周见一面」→ 生成三个候选（温度最高但只有线上记录）',
        weeks: CHANNEL_WINDOW_WEEKS,
        windowDays: CHANNEL_WINDOW_DAYS,
        mix: mix,
        ratio: ratio,
        total: totalLogs,
        online: online,
        onlineRatio: Math.round(onlineRatio * 1000) / 1000,
        onlinePct: Math.round(onlineRatio * 100),
        onlyOnline: onlyOnline,
        hint: onlyOnline
            ? '只有线上往来：近 ' + CHANNEL_WINDOW_WEEKS + ' 周 ' + Math.round(onlineRatio * 100)
                + '% 是微信 / 邮件'
            : '近 ' + CHANNEL_WINDOW_WEEKS + ' 周共 ' + totalLogs + ' 次记录',
        candidates: candidates.slice(0, 3),
        note: '微信聊得勤不等于关系好（§3.1）：渠道决定广度，深度决定重量。',
    };

    // ---- 视角 4：该看一眼 / 给予清单 → 动作「这件事什么时候做」→ 建任务 / 标记已给过 ----
    //   核心字段 giveFirst「我能帮他什么」；刻意不做「他给过我什么」的对称账（§4.4）
    const giveItems = [];
    s.contacts.forEach(function (c) {
        if (!c.giveFirst) return;
        giveItems.push({
            id: c.id, contactId: c.id, name: c.name,
            tier: c.tier, tierLabel: TIER_LABEL[c.tier],
            giveFirst: c.giveFirst,
            action: '建任务 / 标记已给过',
            actionHint: '这件事什么时候做',
        });
    });
    giveItems.sort(function (a, b) {
        if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
        return a.name.localeCompare(b.name);
    });
    const giveFirst = {
        label: '该看一眼 · 给予清单',
        action: '「这件事什么时候做」→ 建任务 / 把 giveFirst 清空表示已给过',
        count: giveItems.length,
        items: giveItems,
        note: '只记「我能帮他什么」，不显示「你给过 N 次、他给过 M 次」这种对称账；'
            + '互相欠着才是关系，算清了就是交易。此清单只在分析页出现，不进通讯录列表。',
    };

    return {
        today: today,
        cooling: cooling,
        structure: structure,
        channels: channels,
        giveFirst: giveFirst,
        note: '温度 = 100×(1−e^(−S/6))，S = Σ(渠道权重 × 深度系数 × 0.5^(天数/90))。'
            + '它是「记录的温度」不是「关系的温度」，半年没记不等于半年没联系（§4.1 / §5.2）；'
            + '权重与半衰期是启发式，只用来排序谁最久没被想起；邓巴容量只提示、不做闸门。'
            + '不做关系健康度 / 人脉总分（§4.3），也不做互惠对称账（§4.4）。',
    };
}

// ---------------------------------------------------------------------------
// 十一、换机合并：只补不改、幂等，返回 { state, added }（文档 §6.5 备份注入）
//   坑：不能先 normalize(section) 再合并——导入段的 log 可能引用只在本机存在的联系人，
//   那样 contactIds 会被误剔。做法是先补 contacts / archived，用「合并后的全量 id」校验 logs。
// ---------------------------------------------------------------------------
function mergeSection(state, section) {
    const s = normalize(state);
    const sec = (section && typeof section === 'object') ? section : {};
    let added = 0;

    const seenContact = {};
    s.contacts.forEach(function (c) { seenContact[c.id] = true; });
    s.archived.forEach(function (c) { seenContact[c.id] = true; });
    const seenLog = {};
    s.logs.forEach(function (l) { seenLog[l.id] = true; });
    const validIds = {};
    Object.keys(seenContact).forEach(function (k) { validIds[k] = true; });

    (Array.isArray(sec.contacts) ? sec.contacts : []).forEach(function (raw) {
        const c = normContact(raw);
        if (!c || seenContact[c.id]) return;                 // 本地已有 → 不覆盖
        if (s.contacts.length >= MAX_CONTACTS) return;
        seenContact[c.id] = true;
        validIds[c.id] = true;
        s.contacts.push(c);
        added += 1;
    });
    (Array.isArray(sec.archived) ? sec.archived : []).forEach(function (raw) {
        const c = normContact(raw);
        if (!c || seenContact[c.id]) return;
        if (s.archived.length >= MAX_CONTACTS) return;
        seenContact[c.id] = true;
        validIds[c.id] = true;
        s.archived.push(c);
        added += 1;
    });
    (Array.isArray(sec.logs) ? sec.logs : []).forEach(function (raw) {
        const l = normLog(raw, validIds);
        if (!l || seenLog[l.id]) return;
        if (s.logs.length >= MAX_LOGS) return;
        seenLog[l.id] = true;
        s.logs.push(l);
        added += 1;
    });

    // 再过一遍白名单：统一截断 / 去重 / 重算 trimmed；本地合法数据是恒等的，不违反「不改」
    return { state: normalize(s), added: added };
}

// ---------------------------------------------------------------------------
// 十二、导出
// ---------------------------------------------------------------------------
module.exports = {
    // 上限与公式常量
    MAX_CONTACTS: MAX_CONTACTS,
    MAX_LOGS: MAX_LOGS,
    NAME_MAX: NAME_MAX,
    ORG_MAX: ORG_MAX,
    TITLE_MAX: TITLE_MAX,
    PHONE_MAX: PHONE_MAX,
    WECHAT_MAX: WECHAT_MAX,
    HOW_MET_MAX: HOW_MET_MAX,
    GIVE_FIRST_MAX: GIVE_FIRST_MAX,
    NOTE_MAX: NOTE_MAX,
    MAX_TAGS: MAX_TAGS,
    TAG_MAX: TAG_MAX,
    SUMMARY_MAX: SUMMARY_MAX,
    FEELING_MAX: FEELING_MAX,
    FOLLOW_UP_MAX: FOLLOW_UP_MAX,
    MAX_CONTACT_IDS: MAX_CONTACT_IDS,
    HALF_LIFE_DAYS: HALF_LIFE_DAYS,
    TEMP_SCALE: TEMP_SCALE,
    // 三轴元数据与权重（单一真相）
    CIRCLES: CIRCLES,
    CIRCLE_LABEL: CIRCLE_LABEL,
    CIRCLE_CAPITAL: CIRCLE_CAPITAL,
    TIERS: TIERS,
    TIER_LABEL: TIER_LABEL,
    TIER_CADENCE: TIER_CADENCE,
    TIER_CAPACITY: TIER_CAPACITY,
    CHANNELS: CHANNELS,
    CHANNEL_LABEL: CHANNEL_LABEL,
    CHANNEL_WEIGHT: CHANNEL_WEIGHT,
    DEPTHS: DEPTHS,
    DEPTH_LABEL: DEPTH_LABEL,
    DEPTH_WEIGHT: DEPTH_WEIGHT,
    // 工具（供界面做日期校验 / 对账）
    validDate: validDate,
    todayOf: todayOf,
    diffDays: diffDays,
    // 数据接口（名字精确）
    empty: empty,
    normalize: normalize,
    addContact: addContact,
    updateContact: updateContact,
    archiveContact: archiveContact,
    listContacts: listContacts,
    addLog: addLog,
    removeLog: removeLog,
    logsFor: logsFor,
    temperature: temperature,
    analytics: analytics,
    mergeSection: mergeSection,
    seedState: seedState,
};
