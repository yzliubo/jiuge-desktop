'use strict';
const lunar = require('./lunar.js');
// 家庭亲子（md_family）—— 九格第 6 格的主功能，2026-11-16 由「情绪觉察」重构而来。
//
// 为什么换：情绪觉察落到每天只剩「此刻心情叫什么」，写两天就没得写，也没有任何可回看的东西；
// 家庭亲子是具体发生的事（陪了谁、做了什么、孩子说了什么、第一次做到什么），
// 一天里真会发生，也就真写得出来，过一年还能翻。
//
// 三块内容，各回答一个问题：
//   成员   —— 我在陪谁（昵称 / 生日→年龄 / 学校 / 兴趣 / 注意事项，只存本机）
//   时刻   —— 今天陪了什么（成员 / 类型 / 时长 / 一句话）
//   足迹   —— 什么时候第一次做到（里程碑时间轴，可按成员筛）
//
// 口径（与关系经营一致）：
//   · 时长是「自己填的」，不是自动计时，不做总分、不做健康度评分；
//   · 派生值（本周陪伴 / 覆盖几个人 / 距上次几天）读时算，不落盘；
//   · 删成员不删历史时刻——那是真发生过的事，只是归属人空了。
// 全部纯函数、零第三方依赖；normalize 必须幂等。

const MAX_MEMBERS = 20;
const MAX_MOMENTS = 3000;
const MAX_MILESTONES = 1000;

const NAME_MAX = 20;
const SCHOOL_MAX = 40;
const INTERESTS_MAX = 60;
const NOTES_MAX = 200;
const TEXT_MAX = 500;
const FEELING_MAX = 60;
const TITLE_MAX = 40;
const DETAIL_MAX = 300;
const MAX_MEMBER_IDS = 6;
// 生日历法（2026-11-16）：阳历仍是原来的 birthday 字段；农历另存月/日与出生年，
// 纪念日提醒只是「读时算出的下一次」，不落盘、不产生系统通知。
const CALENDAR_TYPES = [
  { key: 'solar', label: '阳历' },
  { key: 'lunar', label: '农历' }
];
const LUNAR_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const LUNAR_DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
const ANNIVERSARY_DAYS = 30;

const ROLES = [
  { key: 'child', label: '孩子' },
  { key: 'partner', label: '伴侣' },
  { key: 'elder', label: '长辈' },
  { key: 'self', label: '自己' },
  { key: 'other', label: '其他' }
];
const ROLE_LABEL = {};
ROLES.forEach(function (r) { ROLE_LABEL[r.key] = r.label; });

// 亲子时刻的类型：都是「当天能发生、能落一句话」的动作，不是心情词。
const MOMENT_KINDS = [
  { key: 'company', label: '陪伴' },
  { key: 'talk', label: '聊天' },
  { key: 'play', label: '玩耍' },
  { key: 'study', label: '共学' },
  { key: 'sport', label: '运动' },
  { key: 'bedtime', label: '睡前' },
  { key: 'outing', label: '外出' }
];
const MOMENT_LABEL = {};
MOMENT_KINDS.forEach(function (k) { MOMENT_LABEL[k.key] = k.label; });

// 成长足迹的类型：里程碑要能被检索，所以给固定几类，不给自由标签。
const MILE_KINDS = [
  { key: 'first', label: '第一次' },
  { key: 'body', label: '身体' },
  { key: 'skill', label: '本领' },
  { key: 'work', label: '作品' },
  { key: 'school', label: '学校' },
  { key: 'other', label: '其他' }
];
const MILE_LABEL = {};
MILE_KINDS.forEach(function (k) { MILE_LABEL[k.key] = k.label; });

const TABS = ['today', 'members', 'trail'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v) { return v === null || v === undefined ? '' : String(v); }
function clean(v, max) {
  const s = str(v).replace(/\s+/g, ' ').trim();
  return max && s.length > max ? s.slice(0, max) : s;
}
function pad(n) { return n < 10 ? '0' + n : String(n); }
function todayOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function nowId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
// 「2026-13-40」也是 4-2-2 位数字，日期要回读一遍才算数
function validDate(iso) {
  const t = str(iso);
  if (!DATE_RE.test(t)) return false;
  const p = t.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return d.getFullYear() === Number(p[0]) && (d.getMonth() + 1) === Number(p[1]) && d.getDate() === Number(p[2]);
}
function dayNum(iso) {
  const p = String(iso || '').split('-');
  if (p.length !== 3) return NaN;
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime();
}
function diffDays(from, to) {
  const a = dayNum(from);
  const b = dayNum(to);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}
function oneOf(v, list, fallback) {
  const s = str(v);
  for (let i = 0; i < list.length; i += 1) if (list[i].key === s) return s;
  return fallback;
}
function minutesOf(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  // 一天 1440 分钟封顶：填 8000 也不会把周统计撑成笑话
  return Math.min(1440, Math.round(n));
}

// 生日 → 年龄。只按「到没到生日」算，不碰虚岁那套；
// 三岁以内给月份，大一点只给岁——「4 岁 3 个月」对四岁孩子没必要精确到月。
function ageOf(birthday, today) {
  if (!validDate(birthday)) return { text: '', months: 0 };
  const b = String(birthday).split('-');
  const t = String(today).split('-');
  const y = Number(t[0]) - Number(b[0]);
  const m = Number(t[1]) - Number(b[1]);
  const d = Number(t[2]) - Number(b[2]);
  let months = y * 12 + m - (d < 0 ? 1 : 0);
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (months < 12) return { text: months + ' 个月', months: months };
  if (months < 36) return { text: years + ' 岁' + (rest ? ' ' + rest + ' 个月' : ''), months: months };
  return { text: years + ' 岁', months: months };
}

function lunarLabel(m) {
  if (!m || m.calendarType !== 'lunar' || !m.lunarMonth || !m.lunarDay) return '';
  return '农历' + (LUNAR_MONTHS[m.lunarMonth - 1] || (m.lunarMonth + '月')) + (m.lunarLeap ? '（闰）' : '') + (LUNAR_DAYS[m.lunarDay - 1] || (m.lunarDay + ' 日'));
}

// 农历生日：把农历月日按当前年（不够就下一年）换成公历，再算距今天几天。
// 表里没有的年份明确返回空，不猜日期——宁可少提醒，也不能提醒错一天。
function nextBirthdayOf(m, day) {
  if (!m) return null;
  let date = '';
  let kind = m.calendarType === 'lunar' ? 'lunar' : 'solar';
  if (kind === 'lunar' && m.lunarMonth && m.lunarDay) {
    const base = Number(String(day).slice(0, 4));
    for (let i = 0; i < 2; i += 1) {
      const y = base + i;
      const r = lunar.resolveLunar(y, m.lunarMonth, m.lunarDay, m.lunarLeap);
      if (!r.date) continue;
      date = r.date.year + '-' + String(r.date.month).padStart(2, '0') + '-' + String(r.date.day).padStart(2, '0');
      if (date >= day) break;
    }
    if (!date) return null;
  } else if (validDate(m.birthday)) {
    date = String(m.birthday).slice(0, 4) + String(m.birthday).slice(4);
    const md = date.slice(5);
    const y = Number(String(day).slice(0, 4));
    date = y + '-' + md;
    if (date < day) date = (y + 1) + '-' + md;
  } else {
    return null;
  }
  return { memberId: m.id, name: m.name, date: date, kind: kind, label: kind === 'lunar' ? lunarLabel(m) : '阳历生日', daysUntil: diffDays(day, date) };
}

function anniversariesOf(state, today, withinDays) {
  const s = normalize(state);
  const day = validDate(today) ? today : todayOf(new Date());
  const windowDays = Number(withinDays) > 0 ? Number(withinDays) : 0;
  const out = [];
  s.members.forEach(function (m) {
    if (!m.anniversaryOn) return;
    const next = nextBirthdayOf(m, day);
    if (!next) return;
    if (windowDays && next.daysUntil > windowDays) return;
    out.push(next);
  });
  return out.sort(function (a, b) { return a.daysUntil - b.daysUntil; });
}

function ageLunarOf(m, day) {
  if (!m || !m.birthYear || !lunar.supported(m.birthYear)) return { text: '', months: 0 };
  const next = nextBirthdayOf(m, day);
  if (!next) return { text: '', months: 0 };
  const age = Number(next.date.slice(0, 4)) - m.birthYear;
  if (!isFinite(age) || age < 0 || age > 130) return { text: '', months: 0 };
  return { text: age + ' 岁', months: age * 12 };
}

function normMember(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = clean(raw.name, NAME_MAX);
  if (!name) return null;
  const createdAt = Number(raw.createdAt) || Date.now();
  return {
    id: clean(raw.id, 40) || nowId('fm'),
    name: name,
    role: oneOf(raw.role, ROLES, 'child'),
    birthday: validDate(raw.birthday) ? str(raw.birthday) : '',
    calendarType: str(raw.calendarType) === 'lunar' ? 'lunar' : 'solar',
    birthYear: lunar.supported(Number(raw.birthYear)) ? Number(raw.birthYear) : 0,
    lunarMonth: Number(raw.lunarMonth) >= 1 && Number(raw.lunarMonth) <= 12 ? Math.floor(Number(raw.lunarMonth)) : 0,
    lunarDay: Number(raw.lunarDay) >= 1 && Number(raw.lunarDay) <= 30 ? Math.floor(Number(raw.lunarDay)) : 0,
    lunarLeap: !!raw.lunarLeap,
    anniversaryOn: !!raw.anniversaryOn,
    school: clean(raw.school, SCHOOL_MAX),
    interests: clean(raw.interests, INTERESTS_MAX),
    notes: clean(raw.notes, NOTES_MAX),
    createdAt: createdAt,
    updatedAt: Number(raw.updatedAt) || createdAt
  };
}

function normIds(raw, seenMembers) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach(function (x) {
    const id = clean(x, 40);
    // 成员已删的 id 就丢掉——新记的时刻不该再挂到不存在的人身上；
    // 老时刻里的旧 id 由 board 负责显示成「已删除成员」，不在这里擦掉历史。
    if (!id || out.indexOf(id) >= 0 || out.length >= MAX_MEMBER_IDS) return;
    if (seenMembers && !seenMembers[id]) return;
    out.push(id);
  });
  return out;
}

function normMoment(raw, seenMembers) {
  if (!raw || typeof raw !== 'object') return null;
  const text = clean(raw.text, TEXT_MAX);
  if (!text) return null;
  const createdAt = Number(raw.createdAt) || Date.now();
  return {
    id: clean(raw.id, 40) || nowId('mm'),
    date: validDate(raw.date) ? str(raw.date) : todayOf(new Date()),
    memberIds: normIds(raw.memberIds, seenMembers),
    kind: oneOf(raw.kind, MOMENT_KINDS, 'company'),
    minutes: minutesOf(raw.minutes),
    text: text,
    feeling: clean(raw.feeling, FEELING_MAX),
    createdAt: createdAt
  };
}

function normMilestone(raw, seenMembers) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clean(raw.title, TITLE_MAX);
  if (!title) return null;
  const createdAt = Number(raw.createdAt) || Date.now();
  return {
    id: clean(raw.id, 40) || nowId('ms'),
    date: validDate(raw.date) ? str(raw.date) : todayOf(new Date()),
    memberIds: normIds(raw.memberIds, seenMembers),
    kind: oneOf(raw.kind, MILE_KINDS, 'first'),
    title: title,
    detail: clean(raw.detail, DETAIL_MAX),
    createdAt: createdAt
  };
}

function dedup(list, limit) {
  const seen = {};
  const out = [];
  list.forEach(function (x) {
    if (!x || seen[x.id]) return;
    seen[x.id] = true;
    if (out.length < limit) out.push(x);
  });
  return out;
}

function normalize(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const members = dedup((Array.isArray(src.members) ? src.members : []).map(normMember).filter(Boolean), MAX_MEMBERS);
  const prefs = (src.prefs && typeof src.prefs === 'object') ? src.prefs : {};
  // 注意：归一化时不按成员表过滤 memberIds。删掉一个成员后如果连历史时刻的归属也擦掉，
  // 就再也说不清「那天陪的是谁」——那是真的发生过的事，只在「新记」时才校验成员是否存在。
  return {
    version: 1,
    members: members,
    moments: dedup((Array.isArray(src.moments) ? src.moments : []).map(function (m) { return normMoment(m, null); }).filter(Boolean), MAX_MOMENTS),
    milestones: dedup((Array.isArray(src.milestones) ? src.milestones : []).map(function (m) { return normMilestone(m, null); }).filter(Boolean), MAX_MILESTONES),
    prefs: { lastTab: TABS.indexOf(str(prefs.lastTab)) >= 0 ? str(prefs.lastTab) : 'today' }
  };
}

function empty() {
  return { version: 1, members: [], moments: [], milestones: [], prefs: { lastTab: 'today' } };
}

function findMember(s, id) {
  for (let i = 0; i < s.members.length; i += 1) if (s.members[i].id === str(id)) return s.members[i];
  return null;
}

function addMember(state, patch) {
  const s = normalize(state);
  if (s.members.length >= MAX_MEMBERS) return s;
  const one = normMember(Object.assign({}, patch || {}, { id: '' }));
  if (!one) return s;
  s.members.push(one);
  return normalize(s);
}

function updateMember(state, id, patch) {
  const s = normalize(state);
  const m = findMember(s, id);
  if (!m) return s;
  const p = patch || {};
  if (p.name !== undefined) m.name = clean(p.name, NAME_MAX) || m.name;
  if (p.role !== undefined) m.role = oneOf(p.role, ROLES, m.role);
  if (p.birthday !== undefined) m.birthday = validDate(p.birthday) ? str(p.birthday) : '';
  // 历法字段成组写：改成农历时不清掉阳历生日（老数据留着，切回来还在）
  if (p.calendarType !== undefined) m.calendarType = str(p.calendarType) === 'lunar' ? 'lunar' : 'solar';
  if (p.birthYear !== undefined) m.birthYear = lunar.supported(Number(p.birthYear)) ? Number(p.birthYear) : 0;
  if (p.lunarMonth !== undefined) m.lunarMonth = Number(p.lunarMonth) >= 1 && Number(p.lunarMonth) <= 12 ? Math.floor(Number(p.lunarMonth)) : 0;
  if (p.lunarDay !== undefined) m.lunarDay = Number(p.lunarDay) >= 1 && Number(p.lunarDay) <= 30 ? Math.floor(Number(p.lunarDay)) : 0;
  if (p.lunarLeap !== undefined) m.lunarLeap = !!p.lunarLeap;
  if (p.anniversaryOn !== undefined) m.anniversaryOn = !!p.anniversaryOn;
  if (p.school !== undefined) m.school = clean(p.school, SCHOOL_MAX);
  if (p.interests !== undefined) m.interests = clean(p.interests, INTERESTS_MAX);
  if (p.notes !== undefined) m.notes = clean(p.notes, NOTES_MAX);
  m.updatedAt = Date.now();
  return normalize(s);
}

// 删成员只删档案，不删历史时刻：那些事真的发生过。
function removeMember(state, id) {
  const s = normalize(state);
  s.members = s.members.filter(function (m) { return m.id !== str(id); });
  return s;
}

function addMoment(state, patch) {
  const s = normalize(state);
  if (s.moments.length >= MAX_MOMENTS) return s;
  const seen = {};
  s.members.forEach(function (m) { seen[m.id] = true; });
  const one = normMoment(patch || {}, seen);
  if (!one) return s;
  s.moments.unshift(one);
  return normalize(s);
}

function removeMoment(state, id) {
  const s = normalize(state);
  s.moments = s.moments.filter(function (m) { return m.id !== str(id); });
  return s;
}

function addMilestone(state, patch) {
  const s = normalize(state);
  if (s.milestones.length >= MAX_MILESTONES) return s;
  const seen = {};
  s.members.forEach(function (m) { seen[m.id] = true; });
  const one = normMilestone(patch || {}, seen);
  if (!one) return s;
  s.milestones.unshift(one);
  return normalize(s);
}

function removeMilestone(state, id) {
  const s = normalize(state);
  s.milestones = s.milestones.filter(function (m) { return m.id !== str(id); });
  return s;
}

function setPrefs(state, patch) {
  const s = normalize(state);
  const p = patch || {};
  if (p.lastTab !== undefined) s.prefs.lastTab = TABS.indexOf(str(p.lastTab)) >= 0 ? str(p.lastTab) : 'today';
  return s;
}

function sortByDateDesc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
}

// 本周窗口：周一到周日。周日归上一周——否则周日晚上写的会掉进下一周，
// 「本周陪了多久」在周日当天忽然归零（复盘也是同一个口径）。
function weekWindow(today) {
  const t = validDate(today) ? today : todayOf(new Date());
  const d = new Date(t + 'T00:00:00');
  const back = (d.getDay() + 6) % 7;
  const start = new Date(d.getTime() - back * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  return { start: todayOf(start), end: todayOf(end) };
}

function memberNameOf(map, id) {
  return map[id] ? map[id].name : '';
}

function board(state, today) {
  const s = normalize(state);
  const day = validDate(today) ? today : todayOf(new Date());
  const wk = weekWindow(day);
  const map = {};
  s.members.forEach(function (m) { map[m.id] = m; });

  // 展示用成员：补年龄与「最近一次」——派生值读时算，不写回数据
  const members = s.members.map(function (m) {
    const age = m.calendarType === 'lunar' ? ageLunarOf(m, day) : ageOf(m.birthday, day);
    let last = '';
    let count = 0;
    let minutes = 0;
    s.moments.forEach(function (x) {
      if (x.memberIds.indexOf(m.id) < 0) return;
      count += 1;
      minutes += x.minutes;
      if (!last || x.date > last) last = x.date;
    });
    return {
      id: m.id, name: m.name, role: m.role, roleLabel: ROLE_LABEL[m.role] || '孩子',
      birthday: m.birthday, calendarType: m.calendarType, birthYear: m.birthYear,
      lunarMonth: m.lunarMonth, lunarDay: m.lunarDay, lunarLeap: m.lunarLeap,
      anniversaryOn: m.anniversaryOn, birthdayLabel: lunarLabel(m),
      ageText: age.text, school: m.school,
      interests: m.interests, notes: m.notes,
      moments: count, minutes: minutes, lastDate: last,
      daysSince: last ? diffDays(last, day) : null
    };
  });

  const moments = s.moments.slice().sort(sortByDateDesc).map(function (m) {
    return Object.assign({}, m, {
      kindLabel: MOMENT_LABEL[m.kind] || '陪伴',
      membersText: m.memberIds.map(function (id) { return memberNameOf(map, id); }).filter(Boolean).join('、')
    });
  });
  const milestones = s.milestones.slice().sort(sortByDateDesc).map(function (m) {
    return Object.assign({}, m, {
      kindLabel: MILE_LABEL[m.kind] || '第一次',
      membersText: m.memberIds.map(function (id) { return memberNameOf(map, id); }).filter(Boolean).join('、'),
      daysAgo: diffDays(m.date, day)
    });
  });

  const todayMoments = moments.filter(function (m) { return m.date === day; });
  const weekMoments = moments.filter(function (m) { return m.date >= wk.start && m.date <= wk.end; });
  const weekMinutes = weekMoments.reduce(function (sum, m) { return sum + m.minutes; }, 0);
  const covered = {};
  weekMoments.forEach(function (m) { m.memberIds.forEach(function (id) { covered[id] = true; }); });
  const coveredIds = Object.keys(covered).filter(function (id) { return !!map[id]; });

  // 本周按成员：谁陪得多、谁这周还没被记到——只列事实，不评判
  const perMember = members.map(function (m) {
    const rows = weekMoments.filter(function (x) { return x.memberIds.indexOf(m.id) >= 0; });
    return {
      id: m.id, name: m.name, roleLabel: m.roleLabel,
      count: rows.length,
      minutes: rows.reduce(function (sum, x) { return sum + x.minutes; }, 0),
      lastDate: rows.length ? rows[0].date : m.lastDate
    };
  });
  const untouched = perMember.filter(function (x) { return x.count === 0; }).map(function (x) { return x.name; });

  // 连续记录：只数「有亲子时刻」的天，断一天就断——不做补签
  const daySet = {};
  moments.forEach(function (m) { daySet[m.date] = true; });
  let streak = 0;
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(dayNum(day) - i * 86400000);
    if (!daySet[todayOf(d)]) break;
    streak += 1;
  }

  return {
    today: day,
    week: { start: wk.start, end: wk.end },
    members: members,
    moments: moments.slice(0, 200),
    todayMoments: todayMoments,
    milestones: milestones.slice(0, 200),
    weekStats: {
      days: Object.keys(daySet).filter(function (d) { return d >= wk.start && d <= wk.end; }).length,
      moments: weekMoments.length,
      minutes: weekMinutes,
      covered: coveredIds.length,
      members: members.length,
      untouched: untouched
    },
    streak: streak,
    anniversaries: anniversariesOf(s, day, ANNIVERSARY_DAYS),
    counts: {
      members: members.length,
      moments: s.moments.length,
      milestones: s.milestones.length
    }
  };
}

function meta() {
  return {
    roles: ROLES, roleLabel: ROLE_LABEL,
    momentKinds: MOMENT_KINDS, momentLabel: MOMENT_LABEL,
    milestoneKinds: MILE_KINDS, milestoneLabel: MILE_LABEL,
    calendarTypes: CALENDAR_TYPES, lunarMonths: LUNAR_MONTHS,
    lunarYears: { min: lunar.MIN_YEAR, max: lunar.MAX_YEAR }, anniversaryDays: ANNIVERSARY_DAYS,
    limits: {
      members: MAX_MEMBERS, moments: MAX_MOMENTS, milestones: MAX_MILESTONES,
      name: NAME_MAX, text: TEXT_MAX, title: TITLE_MAX, detail: DETAIL_MAX
    }
  };
}

// 跨机恢复：三段都按 id 合并，只补不改（与 dream / growth 同一口径）
function mergeSection(state, section) {
  const s = normalize(state);
  const incoming = normalize(section);
  let added = 0;
  ['members', 'moments', 'milestones'].forEach(function (k) {
    const seen = {};
    s[k].forEach(function (x) { seen[x.id] = true; });
    incoming[k].forEach(function (x) {
      if (seen[x.id]) return;
      s[k].push(x);
      seen[x.id] = true;
      added += 1;
    });
  });
  return { state: normalize(s), added: added };
}

module.exports = {
  MAX_MEMBERS: MAX_MEMBERS,
  MAX_MOMENTS: MAX_MOMENTS,
  MAX_MILESTONES: MAX_MILESTONES,
  NAME_MAX: NAME_MAX,
  TEXT_MAX: TEXT_MAX,
  TITLE_MAX: TITLE_MAX,
  ROLES: ROLES,
  ROLE_LABEL: ROLE_LABEL,
  MOMENT_KINDS: MOMENT_KINDS,
  MOMENT_LABEL: MOMENT_LABEL,
  MILE_KINDS: MILE_KINDS,
  MILE_LABEL: MILE_LABEL,
  TABS: TABS,
  empty: empty,
  normalize: normalize,
  ageOf: ageOf,
  ageLunarOf: ageLunarOf,
  anniversariesOf: anniversariesOf,
  lunarLabel: lunarLabel,
  weekWindow: weekWindow,
  addMember: addMember,
  updateMember: updateMember,
  removeMember: removeMember,
  addMoment: addMoment,
  removeMoment: removeMoment,
  addMilestone: addMilestone,
  removeMilestone: removeMilestone,
  setPrefs: setPrefs,
  board: board,
  meta: meta,
  mergeSection: mergeSection
};
