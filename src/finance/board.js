'use strict';
// 家庭账本（md_finance）——纯领域层，CommonJS，零第三方依赖。
//
// 四条硬口径（主理人 2026-11-11 拍板）：
//   1. 管预算：信封制（每月每分类一个额度，可结转），不是只记流水；
//   2. 不做家庭共享：没有账号、没有成员、没有同步，数据只在本机；
//   3. 第一期就做 CSV 导入：支付宝（GBK）/ 微信（UTF-8 BOM）/ 通用 CSV，
//      按列关键字定位表头，importedId 去重，导入即过自动分类规则；
//   4. 金额全程整数分：领域层只认整数 cents，元只在 formatCents() 里出现一次。
//
// 与 src/recur/board.js 同范式：fn(state, ...) -> 新 state，绝不原地改；
// normalize 白名单收敛、幂等、不读时钟；日期 'YYYY-MM-DD' 纯字符串 + 整数运算。
// 类库里不出现 fetch / XMLHttpRequest / 远程地址：这是纯本地模块。

const VERSION = 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const KINDS = ['expense', 'income', 'transfer'];
// 账户分层照 maybe 的 balance sheet 口径（存款/信用卡/投资/房产/贷款/其他资产负债），
// 但只用于分组展示：净值一律按「余额符号」算，账户类型不参与金额计算。
const ACCOUNT_KINDS = ['cash', 'bank', 'alipay', 'wechat', 'credit', 'invest', 'property', 'loan', 'other_asset', 'other_liability', 'other'];
const LIABILITY_KINDS = ['credit', 'loan', 'other_liability'];
const ACCOUNT_SIDES = ['asset', 'liability'];
const GOAL_STATES = ['active', 'paused', 'done'];
const INTERVALS = ['monthly', 'quarterly', 'yearly'];
const END_MODES = ['never', 'date'];
const CONDITION_FIELDS = ['payee', 'note', 'category', 'account', 'kind', 'amountCents', 'date'];
const CONDITION_OPS = ['contains', 'eq', 'prefix', 'suffix', 'gte', 'lte'];
const ACTION_TYPES = ['setCategory', 'setPayee', 'setNote', 'setAccount', 'setKind'];

const MAX_TXNS = 20000;
const MAX_CATEGORIES = 80;
const MAX_ACCOUNTS = 30;
const MAX_BUDGETS = 600;
const MAX_RULES = 100;
const MAX_GOALS = 40;
const MAX_RECURRING = 80;
const MAX_CONDITIONS = 6;
const MAX_ACTIONS = 4;
const SUB_MIN_HITS = 2;        // 同一商户至少 2 笔、且金额相近，才敢叫「订阅」
const SUB_AMOUNT_TOL_BP = 500; // 金额容差 5%，容忍年付/调价
const CENTS_MAX = 99999999999;   // 约 10 亿元，够家庭账本用
const NOTE_MAX = 120;
const NAME_MAX = 24;
const GROUP_MAX = 16;
const ID_MAX = 64;
const RULE_MAX = 8;
const CSV_MAX_BYTES = 8 * 1024 * 1024;
const CSV_MAX_ROWS = 20000;
const MONTH_SCAN_CAP = 240;      // 信封结转最多回溯 20 年，防脏数据把循环拖死

const DEFAULT_CATEGORIES = [
  { id: 'cat_food', name: '餐饮', group: '日常', kind: 'expense' },
  { id: 'cat_transport', name: '交通', group: '日常', kind: 'expense' },
  { id: 'cat_daily', name: '日用', group: '日常', kind: 'expense' },
  { id: 'cat_house', name: '居住', group: '固定', kind: 'expense' },
  { id: 'cat_util', name: '水电物业', group: '固定', kind: 'expense' },
  { id: 'cat_sub', name: '订阅', group: '固定', kind: 'expense' },
  { id: 'cat_fun', name: '娱乐', group: '可选', kind: 'expense' },
  { id: 'cat_medical', name: '医疗', group: '固定', kind: 'expense' },
  { id: 'cat_edu', name: '教育', group: '可选', kind: 'expense' },
  { id: 'cat_social', name: '人情', group: '可选', kind: 'expense' },
  { id: 'cat_other_e', name: '其他支出', group: '其他', kind: 'expense' },
  { id: 'cat_salary', name: '工资', group: '收入', kind: 'income' },
  { id: 'cat_bonus', name: '奖金', group: '收入', kind: 'income' },
  { id: 'cat_invest', name: '理财', group: '收入', kind: 'income' },
  { id: 'cat_other_i', name: '其他收入', group: '收入', kind: 'income' }
];

const DEFAULT_ACCOUNTS = [
  { id: 'acc_cash', name: '现金', kind: 'cash' },
  { id: 'acc_bank', name: '银行卡', kind: 'bank' },
  { id: 'acc_alipay', name: '支付宝', kind: 'alipay' },
  { id: 'acc_wechat', name: '微信', kind: 'wechat' }
];

// CSV 列关键字：按「包含即命中」定位，绝不按固定列号——支付宝导出前几行是说明文字。
const CSV_COLS = {
  date: ['交易时间', '交易日期', '记账日期', '日期', '时间', 'date'],
  amount: ['收/付款金额', '金额(元)', '金额（元）', '发生金额', '交易金额', '金额', 'amount'],
  // 「收/付款」不能进这里：支付宝的金额列就叫「收/付款金额」，会被误判成收支方向，
  // 结果整列收入被记成支出。只认不含「金额」的窄关键字。
  direction: ['收/支', '收支', '收付方向', '方向', 'direction', 'type'],
  payee: ['交易对方', '对方', '商户', '收款方', '付款方', 'payee'],
  note: ['商品说明', '商品名称', '商品', '摘要', '备注', 'note'],
  order: ['交易订单号', '交易单号', '商户单号', '订单号', 'order'],
  status: ['交易状态', '当前状态', '状态', 'status'],
  account: ['收/付款方式', '支付方式', '付款方式', '账户', 'account']
};

// ---------------------------------------------------------------- 基础工具

function str(v) { return String(v === undefined || v === null ? '' : v); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function clean(v, max) {
  return str(v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function int(v, lo, hi, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function bool(v, fallback) { return v === true || v === 1 ? true : (v === false || v === 0 ? false : fallback); }

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] || 0;
}
function parseDate(v) {
  const s = str(v).trim();
  if (!DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y: y, m: m, d: d };
}
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function fmtDate(p) { return p.y + '-' + pad2(p.m) + '-' + pad2(p.d); }
function validDate(v) { const p = parseDate(v); return p ? fmtDate(p) : ''; }
function parseMonth(v) {
  const s = str(v).trim();
  if (!MONTH_RE.test(s)) return null;
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7));
  if (m < 1 || m > 12) return null;
  return { y: y, m: m };
}
function fmtMonth(p) { return p.y + '-' + pad2(p.m); }
function validMonth(v) { const p = parseMonth(v); return p ? fmtMonth(p) : ''; }
function monthOf(date) { return str(date).slice(0, 7); }
function nextMonth(p) { return p.m === 12 ? { y: p.y + 1, m: 1 } : { y: p.y, m: p.m + 1 }; }
function monthIndex(p) { return p.y * 12 + (p.m - 1); }
function monthFromIndex(i) { return { y: Math.floor(i / 12), m: (i % 12) + 1 }; }

// 金额：字符串 -> 整数分。全程不经过浮点，避免 0.1+0.2。
// 支持 "¥1,234.50" / "-12.3" / "(12.34)" / "12元" / "1,234"。
function parseAmountCents(v) {
  let s = str(v).trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[¥￥$,，\s元]/g, '');
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  else if (s.charAt(0) === '+') { s = s.slice(1); }
  const dot = s.indexOf('.');
  let whole = dot < 0 ? s : s.slice(0, dot);
  let frac = dot < 0 ? '' : s.slice(dot + 1).replace(/[^0-9]/g, '');
  whole = whole.replace(/[^0-9]/g, '');
  if (!whole && !frac) return 0;
  frac = (frac + '00').slice(0, 2);
  const cents = Number(whole || '0') * 100 + Number(frac);
  if (!isFinite(cents)) return 0;
  const capped = Math.min(CENTS_MAX, cents);
  return neg ? -capped : capped;
}
// 唯一的「分 -> 元」出口：展示层调用，不参与任何运算。
function formatCents(c) {
  const n = int(c, -CENTS_MAX, CENTS_MAX, 0);
  const a = Math.abs(n);
  return (n < 0 ? '-' : '') + Math.floor(a / 100) + '.' + pad2(a % 100);
}
function toCents(v) {
  if (typeof v === 'number') return int(v, -CENTS_MAX, CENTS_MAX, 0);
  return parseAmountCents(v);
}

// FNV-1a 32 位 + 长度与二次散列，拼出 16 位十六进制，作为去重指纹。
function fnv(strIn, seed) {
  let h = (seed || 2166136261) >>> 0;
  for (let i = 0; i < strIn.length; i++) {
    h ^= strIn.charCodeAt(i) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function hex8(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }
function importFingerprint(parts) {
  const s = parts.join('|');
  return 'imp_' + hex8(fnv(s, 2166136261)) + hex8(fnv(s + ':' + s.length, 2246822519));
}

function nextId(prefix, list) {
  let max = 0;
  const re = new RegExp('^' + prefix + '_(\\d+)$');
  list.forEach(function (row) {
    const m = re.exec(isObj(row) ? str(row.id) : '');
    if (m) { const n = Number(m[1]); if (n > max) max = n; }
  });
  return prefix + '_' + (max + 1);
}
function idsOf(list) { return (Array.isArray(list) ? list : []).map(function (x) { return isObj(x) ? str(x.id) : ''; }); }

// ---------------------------------------------------------------- normalize

function normCategory(o, idx, seen) {
  let id = clean(o.id, ID_MAX);
  if (!id || seen[id]) id = 'cat_' + idx;
  seen[id] = true;
  const kind = KINDS.indexOf(str(o.kind)) >= 0 ? str(o.kind) : 'expense';
  return {
    id: id, name: clean(o.name, NAME_MAX) || '未命名',
    group: clean(o.group, GROUP_MAX), kind: kind === 'income' ? 'income' : 'expense',
    archived: bool(o.archived, false)
  };
}
function normAccount(o, idx, seen) {
  let id = clean(o.id, ID_MAX);
  if (!id || seen[id]) id = 'acc_' + idx;
  seen[id] = true;
  const kind = ACCOUNT_KINDS.indexOf(str(o.kind)) >= 0 ? str(o.kind) : 'other';
  // openingCents = 期初「净值贡献」：资产为正、欠款为负。
  // 之后 balance = opening + 该账户所有流水之和，净值 = 所有账户 balance 之和。
  // 信用卡消费是负流水 → 余额更负 → 负债增加，还款（转入为正）→ 余额回升，无需特殊分支。
  return {
    id: id, name: clean(o.name, NAME_MAX) || '未命名',
    kind: kind, archived: bool(o.archived, false),
    side: ACCOUNT_SIDES.indexOf(str(o.side)) >= 0
      ? str(o.side) : (LIABILITY_KINDS.indexOf(kind) >= 0 ? 'liability' : 'asset'),
    openingCents: int(o.openingCents, -CENTS_MAX, CENTS_MAX, 0)
  };
}
function normTxn(o, idx, seen) {
  let id = clean(o.id, ID_MAX);
  if (!id || seen[id]) id = 'txn_' + idx;
  seen[id] = true;
  const kind = KINDS.indexOf(str(o.kind)) >= 0 ? str(o.kind) : 'expense';
  const date = validDate(o.date);
  return {
    id: id, date: date, month: date ? monthOf(date) : '',
    amountCents: int(o.amountCents, -CENTS_MAX, CENTS_MAX, 0),
    kind: kind,
    account: clean(o.account, ID_MAX), category: clean(o.category, ID_MAX),
    payee: clean(o.payee, NAME_MAX), note: clean(o.note, NOTE_MAX),
    transferId: clean(o.transferId, ID_MAX),
    importedId: clean(o.importedId, ID_MAX),
    ruleIds: (Array.isArray(o.ruleIds) ? o.ruleIds : []).slice(0, RULE_MAX)
      .map(function (x) { return clean(x, ID_MAX); }).filter(Boolean),
    cleared: bool(o.cleared, false)
  };
}
function normBudget(o, idx, seen) {
  let id = clean(o.id, ID_MAX);
  if (!id || seen[id]) id = 'bud_' + idx;
  seen[id] = true;
  return {
    id: id, category: clean(o.category, ID_MAX), month: validMonth(o.month),
    limitCents: int(o.limitCents, 0, CENTS_MAX, 0), rollover: bool(o.rollover, true)
  };
}
function normCondition(o) {
  const field = CONDITION_FIELDS.indexOf(str(o.field)) >= 0 ? str(o.field) : 'note';
  const op = CONDITION_OPS.indexOf(str(o.op)) >= 0 ? str(o.op) : 'contains';
  return { field: field, op: op, value: clean(o.value, NOTE_MAX) };
}
function normAction(o) {
  const type = ACTION_TYPES.indexOf(str(o.type)) >= 0 ? str(o.type) : 'setCategory';
  return { type: type, value: clean(o.value, NAME_MAX) };
}
function normRule(o, idx, seen) {
  let id = clean(o.id, ID_MAX);
  if (!id || seen[id]) id = 'rul_' + idx;
  seen[id] = true;
  const match = str(o.match) === 'any' ? 'any' : 'all';
  return {
    id: id, name: clean(o.name, NAME_MAX) || '未命名规则',
    priority: int(o.priority, 0, 9999, 100), enabled: bool(o.enabled, true),
    match: match, stop: bool(o.stop, false),
    conditions: (Array.isArray(o.conditions) ? o.conditions : []).slice(0, MAX_CONDITIONS)
      .filter(isObj).map(normCondition),
    actions: (Array.isArray(o.actions) ? o.actions : []).slice(0, MAX_ACTIONS)
      .filter(isObj).map(normAction)
  };
}

// 储蓄目标：只记「目标额 / 已存额」，不自动从流水倒推，避免与净资产口径打架。
function normGoal(o, idx, seen) {
  let id = clean(o.id, ID_MAX);
  if (!id || seen[id]) id = 'goal_' + idx;
  seen[id] = true;
  return {
    id: id, name: clean(o.name, NAME_MAX) || '未命名目标',
    targetCents: int(o.targetCents, 0, CENTS_MAX, 0),
    savedCents: int(o.savedCents, 0, CENTS_MAX, 0),
    month: validMonth(o.month),
    state: GOAL_STATES.indexOf(str(o.state)) >= 0 ? str(o.state) : 'active',
    note: clean(o.note, NOTE_MAX)
  };
}
// 周期账单：只产出「本月该记什么」的建议，绝不自动写流水（写库必须用户点一下）。
function normRecurring(o, idx, seen) {
  let id = clean(o.id, ID_MAX);
  if (!id || seen[id]) id = 'rec_' + idx;
  seen[id] = true;
  return {
    id: id, name: clean(o.name, NAME_MAX) || '未命名周期账单',
    payee: clean(o.payee, NAME_MAX),
    amountCents: int(o.amountCents, -CENTS_MAX, CENTS_MAX, 0),
    category: clean(o.category, ID_MAX), account: clean(o.account, ID_MAX),
    startDate: validDate(o.startDate),
    interval: INTERVALS.indexOf(str(o.interval)) >= 0 ? str(o.interval) : 'monthly',
    endMode: END_MODES.indexOf(str(o.endMode)) >= 0 ? str(o.endMode) : 'never',
    endDate: validDate(o.endDate),
    enabled: bool(o.enabled, true)
  };
}

// 白名单收敛：未知字段一律丢弃（照 recur/board.js 的既定机制，脏值不修不猜）。
function normalize(raw) {
  const src = isObj(raw) ? raw : {};
  function list(key, fn, max) {
    const arr = Array.isArray(src[key]) ? src[key].slice(-max) : [];
    const seen = {};
    return arr.map(function (o, idx) { return fn(isObj(o) ? o : {}, idx, seen); });
  }
  // 空库才播种默认分类/账户；用户主动删空的数组保持为空，不被重新种回来。
  const cats = Array.isArray(src.categories) ? list('categories', normCategory, MAX_CATEGORIES)
    : DEFAULT_CATEGORIES.map(function (c) { return Object.assign({}, c, { archived: false }); });
  const accounts = Array.isArray(src.accounts) ? list('accounts', normAccount, MAX_ACCOUNTS)
    : DEFAULT_ACCOUNTS.map(function (a) { return Object.assign({}, a, { archived: false }); });
  return {
    version: VERSION,
    categories: cats,
    accounts: accounts,
    txns: list('txns', normTxn, MAX_TXNS),
    budgets: list('budgets', normBudget, MAX_BUDGETS),
    rules: list('rules', normRule, MAX_RULES),
    goals: list('goals', normGoal, MAX_GOALS),
    recurring: list('recurring', normRecurring, MAX_RECURRING)
  };
}
function meta() {
  return {
    version: VERSION, kinds: KINDS.slice(), accountKinds: ACCOUNT_KINDS.slice(),
    liabilityKinds: LIABILITY_KINDS.slice(), accountSides: ACCOUNT_SIDES.slice(),
    goalStates: GOAL_STATES.slice(), intervals: INTERVALS.slice(), endModes: END_MODES.slice(),
    conditionFields: CONDITION_FIELDS.slice(), conditionOps: CONDITION_OPS.slice(),
    actionTypes: ACTION_TYPES.slice(), limits: {
      maxTxns: MAX_TXNS, maxRules: MAX_RULES, maxGoals: MAX_GOALS,
      maxRecurring: MAX_RECURRING, maxAccounts: MAX_ACCOUNTS,
      centsMax: CENTS_MAX, noteMax: NOTE_MAX, nameMax: NAME_MAX, csvMaxBytes: CSV_MAX_BYTES
    },
    csvPlatforms: ['alipay', 'wechat', 'generic']
  };
}

// ---------------------------------------------------------------- 规则引擎

function fieldValue(txn, field) {
  if (field === 'amountCents') return Math.abs(txn.amountCents);
  if (field === 'category' || field === 'account' || field === 'kind' || field === 'date') return str(txn[field]);
  return str(txn[field] || '');
}
function matchCondition(txn, c) {
  const raw = fieldValue(txn, c.field);
  const needle = c.value;
  if (c.op === 'gte' || c.op === 'lte') {
    // 字段名已经是「分」，条件值也必须是分；这里绝不能再按元解析一次，
    // 否则用户写 1000（10 元）会被当成 100000 分，规则永远不命中。
    const a = Number(needle);
    const b = c.field === 'amountCents' ? Math.abs(txn.amountCents) : Number(raw);
    if (!isFinite(a) || !isFinite(b)) return false;
    return c.op === 'gte' ? b >= a : b <= a;
  }
  const left = raw.toLowerCase(), right = needle.toLowerCase();
  if (c.op === 'contains') return left.indexOf(right) >= 0;
  if (c.op === 'eq') return left === right;
  if (c.op === 'prefix') return left.indexOf(right) === 0;
  if (c.op === 'suffix') return left.slice(-right.length) === right;
  return false;
}
function ruleMatches(txn, rule) {
  const cs = rule.conditions;
  if (!cs.length) return false;
  if (rule.match === 'any') return cs.some(function (c) { return matchCondition(txn, c); });
  return cs.every(function (c) { return matchCondition(txn, c); });
}
// Actual 式「条件 → 动作」：按 priority 升序逐条执行，后面的规则看得到前面改过的值。
function applyRules(state, txn) {
  const s = normalize(state);
  const rules = s.rules.filter(function (r) { return r.enabled; })
    .sort(function (a, b) { return a.priority - b.priority || (a.id < b.id ? -1 : 1); });
  let out = Object.assign({}, txn);
  const hit = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!ruleMatches(out, r)) continue;
    r.actions.forEach(function (a) {
      if (a.type === 'setCategory') out.category = a.value;
      else if (a.type === 'setPayee') out.payee = a.value;
      else if (a.type === 'setNote') out.note = a.value;
      else if (a.type === 'setAccount') out.account = a.value;
      else if (a.type === 'setKind' && KINDS.indexOf(a.value) >= 0) out.kind = a.value;
    });
    hit.push(r.id);
    if (r.stop) break;
  }
  out.ruleIds = hit.slice(0, RULE_MAX);
  return { txn: out, ruleIds: hit };
}

// ---------------------------------------------------------------- 汇总 / 信封

function txnsInMonth(state, month) {
  return state.txns.filter(function (t) { return t.month === month; });
}
// 一次扫描建 (月|分类) -> 已花 的索引；否则信封结转会退化成 分类×月数×流水 的三重循环。
function spentMap(state) {
  const map = {};
  state.txns.forEach(function (t) {
    if (t.kind !== 'expense') return;
    const k = t.month + '|' + (t.category || 'cat_other_e');
    map[k] = (map[k] || 0) + (-t.amountCents);
  });
  return map;
}
function effectiveBudget(state, category, month) {
  let best = null;
  state.budgets.forEach(function (b) {
    if (b.category !== category || !b.month || b.month > month) return;
    if (!best || b.month > best.month) best = b;
  });
  return best;
}
// 信封制：remaining = 本月额度 + 上月结转 - 本月已花；rollover=false 时结转归零。
function budgetRows(state, month) {
  const target = parseMonth(month);
  if (!target) return [];
  const spentBy = spentMap(state);
  const cats = state.categories.filter(function (c) { return c.kind === 'expense'; });
  const endIdx = monthIndex(target);
  return cats.map(function (cat) {
    const rows = state.budgets.filter(function (b) { return b.category === cat.id && b.month; });
    let first = null;
    rows.forEach(function (b) {
      if (parseMonth(b.month) && (first === null || b.month < first)) first = b.month;
    });
    const start = first ? parseMonth(first) : target;
    let startIdx = monthIndex(start);
    if (endIdx - startIdx > MONTH_SCAN_CAP) startIdx = endIdx - MONTH_SCAN_CAP;
    let carry = 0, lim = 0, spent = 0, carryIn = 0, remaining = 0, rollover = true;
    for (let i = startIdx; i <= endIdx; i++) {
      const m = fmtMonth(monthFromIndex(i));
      const eb = effectiveBudget(state, cat.id, m);
      lim = eb ? eb.limitCents : 0;
      rollover = eb ? eb.rollover : true;
      spent = spentBy[m + '|' + cat.id] || 0;
      carryIn = carry;
      remaining = lim + carryIn - spent;
      carry = rollover ? remaining : 0;
    }
    return {
      category: cat.id, name: cat.name, group: cat.group,
      limitCents: lim, spentCents: spent, carryInCents: carryIn,
      remainingCents: remaining, rollover: rollover,
      // 没设过额度的分类只是「有支出」，不能算超支信封（洞察与预算页都据此区分）。
      configured: rows.some(function (b) { return b.limitCents > 0 && b.month && b.month <= fmtMonth(target); }),
      usedBp: Math.round(spent * 10000 / Math.max(1, lim + carryIn))
    };
  }).filter(function (r) {
    return r.limitCents > 0 || r.spentCents > 0 || r.remainingCents !== 0;
  });
}

function board(state, month) {
  const s = normalize(state);
  const m = validMonth(month) || validMonth(monthOf(s.txns.length ? s.txns[s.txns.length - 1].date : ''));
  const rows = txnsInMonth(s, m);
  let income = 0, expense = 0, transfer = 0;
  const byCat = {};
  rows.forEach(function (t) {
    if (t.kind === 'income') income += t.amountCents;
    else if (t.kind === 'expense') {
      expense += -t.amountCents;
      const key = t.category || 'cat_other_e';
      byCat[key] = (byCat[key] || 0) + (-t.amountCents);
    } else transfer += t.amountCents;
  });
  const catMap = {};
  s.categories.forEach(function (c) { catMap[c.id] = c; });
  const breakdown = Object.keys(byCat).map(function (k) {
    const c = catMap[k] || { name: '未分类', group: '其他' };
    return { category: k, name: c.name, group: c.group, spentCents: byCat[k] };
  }).sort(function (a, b) { return b.spentCents - a.spentCents; });
  breakdown.forEach(function (x) {
    x.shareBp = expense > 0 ? Math.round(x.spentCents * 10000 / expense) : 0;
  });
  const budgets = budgetRows(s, m);
  const limitCents = budgets.reduce(function (a, b) { return a + b.limitCents; }, 0);
  const target = parseMonth(m);
  const trend = [];
  if (target) {
    for (let k = 5; k >= 0; k--) {
      const p = monthFromIndex(monthIndex(target) - k);
      const mm = fmtMonth(p);
      let inc = 0, exp = 0;
      s.txns.forEach(function (t) {
        if (t.month !== mm) return;
        if (t.kind === 'income') inc += t.amountCents;
        else if (t.kind === 'expense') exp += -t.amountCents;
      });
      trend.push({ month: mm, incomeCents: inc, expenseCents: exp });
    }
  }
  const inMonth = s.txns.filter(function (t) { return t.month === m; })
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.id < b.id ? 1 : -1)); });
  return {
    version: VERSION, month: m,
    totals: {
      incomeCents: income, expenseCents: expense, netCents: income - expense,
      transferCents: transfer, budgetLimitCents: limitCents,
      budgetSpentCents: expense, budgetRemainingCents: limitCents - expense
    },
    budgets: budgets, byCategory: breakdown, trend: trend,
    txns: inMonth.slice(0, 300),
    categories: s.categories, accounts: s.accounts, rules: s.rules,
    stats: {
      txnTotal: s.txns.length, inMonth: inMonth.length,
      imported: s.txns.filter(function (t) { return !!t.importedId; }).length,
      ruleHit: s.txns.filter(function (t) { return t.ruleIds.length > 0; }).length,
      budgetCount: s.budgets.length, ruleCount: s.rules.length
    }
  };
}

// ---------------------------------------------------------------- 增删改

function makeTxn(state, draft) {
  const date = validDate(draft.date);
  const kind = KINDS.indexOf(str(draft.kind)) >= 0 ? str(draft.kind) : 'expense';
  const mag = Math.min(CENTS_MAX, Math.abs(toCents(draft.amountCents)));
  const amount = kind === 'income' ? mag : -mag;
  const base = {
    id: '', date: date, month: date ? monthOf(date) : '', amountCents: amount, kind: kind,
    account: clean(draft.account, ID_MAX), category: clean(draft.category, ID_MAX),
    payee: clean(draft.payee, NAME_MAX), note: clean(draft.note, NOTE_MAX),
    transferId: '', importedId: clean(draft.importedId, ID_MAX), ruleIds: [],
    cleared: bool(draft.cleared, false)
  };
  const ruled = applyRules(state, base).txn;
  return ruled;
}
function addTxn(state, draft) {
  const s = normalize(state);
  const d = isObj(draft) ? draft : {};
  if (!validDate(d.date)) return s;
  if (d.kind === 'transfer') {
    const mag = Math.min(CENTS_MAX, Math.abs(toCents(d.amountCents)));
    const from = clean(d.account, ID_MAX), to = clean(d.toAccount, ID_MAX);
    if (!from || !to || from === to || !mag) return s;
    const id1 = nextId('txn', s.txns);
    const id2 = nextId('txn', s.txns.concat([{ id: id1 }]));
    const date = validDate(d.date), month = monthOf(date);
    const leg = function (id, account, cents, other) {
      return {
        id: id, date: date, month: month, amountCents: cents, kind: 'transfer',
        account: account, category: '', payee: clean(d.payee, NAME_MAX),
        note: clean(d.note, NOTE_MAX), transferId: other, importedId: '',
        ruleIds: [], cleared: bool(d.cleared, false)
      };
    };
    return normalize(Object.assign({}, s, {
      txns: s.txns.concat([leg(id1, from, -mag, id2), leg(id2, to, mag, id1)])
    }));
  }
  const t = makeTxn(s, d);
  if (!t.amountCents) return s;
  t.id = nextId('txn', s.txns);
  return normalize(Object.assign({}, s, { txns: s.txns.concat([t]) }));
}
function updateTxn(state, id, patch) {
  const s = normalize(state);
  const key = clean(id, ID_MAX);
  const p = isObj(patch) ? patch : {};
  const old = s.txns.filter(function (t) { return t.id === key; })[0];
  if (!old) return s;
  const merged = Object.assign({}, old, {
    date: validDate(p.date) || old.date,
    amountCents: p.amountCents === undefined ? old.amountCents : toCents(p.amountCents),
    kind: KINDS.indexOf(str(p.kind)) >= 0 ? str(p.kind) : old.kind,
    account: p.account === undefined ? old.account : clean(p.account, ID_MAX),
    category: p.category === undefined ? old.category : clean(p.category, ID_MAX),
    payee: p.payee === undefined ? old.payee : clean(p.payee, NAME_MAX),
    note: p.note === undefined ? old.note : clean(p.note, NOTE_MAX),
    cleared: p.cleared === undefined ? old.cleared : bool(p.cleared, false)
  });
  merged.month = monthOf(merged.date);
  const ruled = applyRules(s, merged).txn;
  return normalize(Object.assign({}, s, {
    txns: s.txns.map(function (t) { return t.id === key ? ruled : t; })
  }));
}
function removeTxn(state, id) {
  const s = normalize(state);
  const key = clean(id, ID_MAX);
  const target = s.txns.filter(function (t) { return t.id === key; })[0];
  if (!target) return s;
  const drop = {};
  drop[key] = true;
  if (target.transferId) drop[target.transferId] = true;
  return normalize(Object.assign({}, s, {
    txns: s.txns.filter(function (t) { return !drop[t.id]; })
  }));
}
function setBudget(state, patch) {
  const s = normalize(state);
  const p = isObj(patch) ? patch : {};
  const month = validMonth(p.month), category = clean(p.category, ID_MAX);
  if (!month || !category) return s;
  const limitCents = int(p.limitCents, 0, CENTS_MAX, 0);
  const rollover = bool(p.rollover, true);
  const hit = s.budgets.filter(function (b) { return b.month === month && b.category === category; })[0];
  if (hit) {
    return normalize(Object.assign({}, s, {
      budgets: s.budgets.map(function (b) {
        return b.id === hit.id ? Object.assign({}, b, { limitCents: limitCents, rollover: rollover }) : b;
      })
    }));
  }
  const row = { id: nextId('bud', s.budgets), category: category, month: month, limitCents: limitCents, rollover: rollover };
  return normalize(Object.assign({}, s, { budgets: s.budgets.concat([row]) }));
}
function removeBudget(state, id) {
  const s = normalize(state);
  const key = clean(id, ID_MAX);
  return normalize(Object.assign({}, s, { budgets: s.budgets.filter(function (b) { return b.id !== key; }) }));
}
function addRule(state, patch) {
  const s = normalize(state);
  const p = isObj(patch) ? patch : {};
  const row = normRule(Object.assign({}, p, { id: nextId('rul', s.rules) }), 0, {});
  return normalize(Object.assign({}, s, { rules: s.rules.concat([row]) }));
}
function updateRule(state, id, patch) {
  const s = normalize(state);
  const key = clean(id, ID_MAX);
  const p = isObj(patch) ? patch : {};
  const old = s.rules.filter(function (r) { return r.id === key; })[0];
  if (!old) return s;
  const row = normRule(Object.assign({}, old, p, { id: key }), 0, {});
  return normalize(Object.assign({}, s, {
    rules: s.rules.map(function (r) { return r.id === key ? row : r; })
  }));
}
function removeRule(state, id) {
  const s = normalize(state);
  const key = clean(id, ID_MAX);
  return normalize(Object.assign({}, s, { rules: s.rules.filter(function (r) { return r.id !== key; }) }));
}
function addCategory(state, patch) {
  const s = normalize(state);
  const p = isObj(patch) ? patch : {};
  const row = normCategory(Object.assign({}, p, { id: nextId('cat', s.categories) }), 0, {});
  return normalize(Object.assign({}, s, { categories: s.categories.concat([row]) }));
}
function removeCategory(state, id) {
  const s = normalize(state);
  const key = clean(id, ID_MAX);
  return normalize(Object.assign({}, s, { categories: s.categories.filter(function (c) { return c.id !== key; }) }));
}
function addAccount(state, patch) {
  const s = normalize(state);
  const p = isObj(patch) ? patch : {};
  const row = normAccount(Object.assign({}, p, { id: nextId('acc', s.accounts) }), 0, {});
  return normalize(Object.assign({}, s, { accounts: s.accounts.concat([row]) }));
}
function removeAccount(state, id) {
  const s = normalize(state);
  const key = clean(id, ID_MAX);
  return normalize(Object.assign({}, s, { accounts: s.accounts.filter(function (a) { return a.id !== key; }) }));
}

// ---------------------------------------------------------------- CSV

function parseCsv(text) {
  const src = str(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (src.charAt(i + 1) === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src.charAt(i + 1) === '\n') i++;
      row.push(cell);
      if (row.some(function (x) { return str(x).trim() !== ''; })) rows.push(row);
      row = []; cell = '';
      if (rows.length >= CSV_MAX_ROWS) break;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(function (x) { return str(x).trim() !== ''; })) rows.push(row);
  return rows;
}
// 字节 -> 文本：BOM 优先；无 BOM 先按 UTF-8 严格解，失败再按 GBK（GB18030 超集）。
function decodeCsvBytes(bytes) {
  let u8 = bytes;
  if (!u8 || typeof u8.length !== 'number') return { text: '', encoding: 'unknown' };
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  if (u8.length > CSV_MAX_BYTES) u8 = u8.slice(0, CSV_MAX_BYTES);
  let enc = 'utf-8';
  try {
    if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
      enc = 'utf-8-bom';
      return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: enc };
    }
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
    }
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' };
  } catch (e) {
    try { return { text: new TextDecoder('gb18030').decode(u8), encoding: 'gbk' }; }
    catch (e2) {
      try { return { text: new TextDecoder('gbk').decode(u8), encoding: 'gbk' }; }
      catch (e3) { return { text: new TextDecoder('utf-8').decode(u8), encoding: 'unknown' }; }
    }
  }
}
function fromBase64(s) {
  try { return new Uint8Array(Buffer.from(str(s), 'base64')); }
  catch (e) { return new Uint8Array(0); }
}
function pickCol(header, keys) {
  for (let i = 0; i < header.length; i++) {
    const cell = str(header[i]).replace(/\s/g, '');
    for (let k = 0; k < keys.length; k++) {
      if (cell.indexOf(keys[k]) >= 0) return i;
    }
  }
  return -1;
}
function csvDate(v) {
  const s = clean(v, 40).replace(/\//g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) return '';
  return validDate(m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3])));
}
function platformOf(filename) {
  const s = str(filename).toLowerCase();
  if (s.indexOf('alipay') >= 0 || s.indexOf('支付宝') >= 0) return 'alipay';
  if (s.indexOf('wechat') >= 0 || s.indexOf('weixin') >= 0 || s.indexOf('微信') >= 0) return 'wechat';
  return 'generic';
}
function defaultAccount(state, platform, raw) {
  const hit = state.accounts.filter(function (a) {
    return a.kind === (platform === 'alipay' ? 'alipay' : platform === 'wechat' ? 'wechat' : '');
  })[0];
  if (hit) return hit.id;
  const byName = state.accounts.filter(function (a) { return a.name === clean(raw, NAME_MAX); })[0];
  return byName ? byName.id : (state.accounts[0] ? state.accounts[0].id : '');
}

// 导入：定位表头 -> 逐行映射 -> 指纹去重 -> 过自动分类规则 -> 一次性写回。
function importCsv(state, opts) {
  const s = normalize(state);
  const o = isObj(opts) ? opts : {};
  let text = '', encoding = 'text';
  if (typeof o.text === 'string') { text = o.text; encoding = str(o.encoding) || 'text'; }
  else if (typeof o.data === 'string') {
    const dec = decodeCsvBytes(fromBase64(o.data));
    text = dec.text; encoding = dec.encoding;
  }
  const filename = clean(o.filename, 120);
  const platform = platformOf(filename);
  const rows = parseCsv(text);
  const report = {
    platform: platform, encoding: encoding, headerLine: -1, total: 0,
    added: 0, skipped: 0, duplicates: 0, errors: []
  };
  if (!rows.length) { report.errors.push('文件为空或无法解析'); return { state: s, report: report }; }
  let hi = -1, cols = null;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const d = pickCol(rows[i], CSV_COLS.date), a = pickCol(rows[i], CSV_COLS.amount);
    // 必须落在两个不同的列上：一行说明文字若同时含「日期」「金额」，
    // 只有一列时会被误当成表头，后面所有行都会被当成脏数据静默丢掉。
    if (d >= 0 && a >= 0 && d !== a) {
      hi = i;
      cols = {
        date: d, amount: a,
        direction: pickCol(rows[i], CSV_COLS.direction),
        payee: pickCol(rows[i], CSV_COLS.payee), note: pickCol(rows[i], CSV_COLS.note),
        order: pickCol(rows[i], CSV_COLS.order), status: pickCol(rows[i], CSV_COLS.status),
        account: pickCol(rows[i], CSV_COLS.account)
      };
      break;
    }
  }
  if (hi < 0 || !cols) {
    report.errors.push('找不到「日期 / 金额」表头，请确认导出的是支付宝、微信或带日期金额列的 CSV');
    return { state: s, report: report };
  }
  report.headerLine = hi + 1;
  const seen = {};
  s.txns.forEach(function (t) { if (t.importedId) seen[t.importedId] = 1; });
  const added = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const cell = function (idx) { return idx >= 0 ? str(r[idx]).trim() : ''; };
    report.total += 1;
    const status = cell(cols.status);
    const direction = cell(cols.direction);
    if (/退款|失败|关闭|已撤销|不计收支/.test(status) || /不计收支/.test(direction)) {
      report.skipped += 1; continue;
    }
    const date = csvDate(cell(cols.date));
    const rawAmount = cell(cols.amount);
    const mag = Math.abs(parseAmountCents(rawAmount));
    if (!date || !mag) { report.skipped += 1; continue; }
    const isIncome = /收入|入账|收款|income/i.test(direction)
      || (rawAmount.charAt(0) === '+' && !/支出/.test(direction));
    const kind = isIncome ? 'income' : 'expense';
    const amountCents = kind === 'income' ? mag : -mag;
    const payee = clean(cell(cols.payee), NAME_MAX);
    const note = clean(cell(cols.note), NOTE_MAX);
    const order = clean(cell(cols.order), ID_MAX);
    const fp = importFingerprint([platform, date, String(amountCents), payee, note, order]);
    if (seen[fp]) { report.duplicates += 1; continue; }
    seen[fp] = 1;
    const base = {
      id: '', date: date, month: monthOf(date), amountCents: amountCents, kind: kind,
      account: defaultAccount(s, platform, cell(cols.account)), category: '',
      payee: payee, note: note, transferId: '', importedId: fp, ruleIds: [], cleared: false
    };
    const ruled = applyRules(s, base).txn;
    added.push(ruled);
  }
  // 确定性 id：避免与库里已有的 txn_N 撞号
  const existing = idsOf(s.txns);
  const used = {};
  existing.forEach(function (id) { used[id] = 1; });
  added.forEach(function (t) {
    let n = s.txns.length + 1;
    while (used['txn_' + n]) n += 1;
    t.id = 'txn_' + n;
    used[t.id] = 1;
  });
  report.added = added.length;
  return { state: normalize(Object.assign({}, s, { txns: s.txns.concat(added) })), report: report };
}

function csvEscape(v) {
  const s = str(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv(state) {
  const s = normalize(state);
  const names = {};
  s.categories.forEach(function (c) { names[c.id] = c.name; });
  const accounts = {};
  s.accounts.forEach(function (a) { accounts[a.id] = a.name; });
  const head = ['日期', '类型', '金额(元)', '分类', '账户', '交易对方', '备注', '来源指纹'];
  const lines = [head.join(',')];
  s.txns.slice().sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); })
    .forEach(function (t) {
      lines.push([
        t.date, t.kind === 'income' ? '收入' : (t.kind === 'transfer' ? '转账' : '支出'),
        formatCents(t.amountCents), names[t.category] || '', accounts[t.account] || '',
        t.payee, t.note, t.importedId
      ].map(csvEscape).join(','));
    });
  return lines.join('\r\n');
}

// 备份导入：按 id 并集，只补不改，幂等（照 reading/board.js 的机制）。
function mergeSection(state, section) {
  const cur = normalize(state);
  const src = isObj(section) ? normalize(section) : null;
  if (!src) return { state: cur, added: 0 };
  let added = 0;
  const out = {};
  ['categories', 'accounts', 'txns', 'budgets', 'rules', 'goals', 'recurring'].forEach(function (key) {
    const seen = {};
    cur[key].forEach(function (row) { seen[row.id] = 1; });
    const add = src[key].filter(function (row) { return !seen[row.id]; });
    added += add.length;
    out[key] = cur[key].concat(add);
  });
  return { state: normalize(Object.assign({}, cur, out)), added: added };
}

// ---------------------------------------------------------------- 完整理财：账户 / 净值 / 损益 / 目标 / 周期
//
// 参考 maybe 的「账户 → 余额 → 资产负债表 / 损益表」骨架，全部自研实现：
// 它是 AGPL-3.0 + Rails + PostgreSQL，且已停更，代码一行都不进九格。
// 这里只做纯本机、零网络、整数分能算清的那部分：
//   资产/负债分层、期初余额、净资产趋势、损益表、分类环比、储蓄目标、
//   周期账单建议、订阅识别、交易检索、批量编辑、右栏洞察。
// 明确不做：Plaid 银行同步、行情与汇率、AI 助手、用户登录与家庭共享。

function balanceRows(s, until) {
  const sums = {};
  const counts = {};
  s.txns.forEach(function (t) {
    if (until && t.month > until) return;
    if (!t.account) return;
    sums[t.account] = (sums[t.account] || 0) + t.amountCents;
    counts[t.account] = (counts[t.account] || 0) + 1;
  });
  return s.accounts.map(function (a) {
    return {
      id: a.id, name: a.name, kind: a.kind, side: a.side, archived: a.archived,
      openingCents: a.openingCents, flowCents: sums[a.id] || 0,
      balanceCents: a.openingCents + (sums[a.id] || 0),
      txnCount: counts[a.id] || 0
    };
  });
}
// 账户余额：期初 + 截至该月的所有流水。转账两条互指、金额相消，天然不重复计净值。
function accountRows(state, month) {
  const s = normalize(state);
  return balanceRows(s, validMonth(month));
}
function netWorth(state, month) {
  const s = normalize(state);
  const m = validMonth(month);
  const rows = balanceRows(s, m);
  let assets = 0, liabilities = 0;
  const bySide = {};
  rows.forEach(function (r) {
    if (r.balanceCents >= 0) assets += r.balanceCents;
    else liabilities += -r.balanceCents;
    const key = r.side === 'liability' ? 'liability' : 'asset';
    if (!bySide[key]) bySide[key] = {
      side: key, name: key === 'liability' ? '负债' : '资产',
      totalCents: 0, assetCents: 0, liabilityCents: 0, accounts: []
    };
    bySide[key].totalCents += r.balanceCents;
    bySide[key].assetCents += Math.max(0, r.balanceCents);
    bySide[key].liabilityCents += Math.max(0, -r.balanceCents);
    bySide[key].accounts.push(r);
  });
  const target = parseMonth(m);
  const series = [];
  if (target) {
    for (let k = 5; k >= 0; k--) {
      const mm = fmtMonth(monthFromIndex(monthIndex(target) - k));
      let net = 0;
      balanceRows(s, mm).forEach(function (r) { net += r.balanceCents; });
      series.push({ month: mm, netCents: net });
    }
  }
  return {
    month: m, assetsCents: assets, liabilitiesCents: liabilities,
    netCents: assets - liabilities,
    groups: Object.keys(bySide).map(function (k) { return bySide[k]; }),
    accounts: rows, series: series
  };
}
// 损益表：近 6 月收入/支出/净流量 + 环比；储蓄率用整数分算完再取基点，不引入浮点金额。
function cashFlow(state, month) {
  const s = normalize(state);
  const b = board(s, month);
  const target = parseMonth(b.month);
  const months = [];
  if (target) {
    for (let k = 5; k >= 0; k--) {
      const mm = fmtMonth(monthFromIndex(monthIndex(target) - k));
      let inc = 0, exp = 0;
      s.txns.forEach(function (t) {
        if (t.month !== mm) return;
        if (t.kind === 'income') inc += t.amountCents;
        else if (t.kind === 'expense') exp += -t.amountCents;
      });
      months.push({ month: mm, incomeCents: inc, expenseCents: exp, netCents: inc - exp });
    }
  }
  const cur = months.length ? months[months.length - 1] : null;
  const prev = months.length >= 2 ? months[months.length - 2] : null;
  return {
    month: b.month, months: months,
    incomeCents: b.totals.incomeCents, expenseCents: b.totals.expenseCents,
    netCents: b.totals.netCents,
    incomeDeltaBp: cur && prev && prev.incomeCents
      ? Math.round((cur.incomeCents - prev.incomeCents) * 10000 / prev.incomeCents) : 0,
    expenseDeltaBp: cur && prev && prev.expenseCents
      ? Math.round((cur.expenseCents - prev.expenseCents) * 10000 / prev.expenseCents) : 0,
    savingBp: b.totals.incomeCents > 0
      ? Math.round(b.totals.netCents * 10000 / b.totals.incomeCents) : 0
  };
}
// 分类报表：本月 vs 上月，占比用基点（万分比），避免展示层出现浮点百分比误差。
function categoryReport(state, month) {
  const s = normalize(state);
  const m = validMonth(month);
  const p = parseMonth(m);
  const prevM = p ? fmtMonth(monthFromIndex(monthIndex(p) - 1)) : '';
  const cur = {}, prev = {}, count = {};
  let total = 0, prevTotal = 0;
  s.txns.forEach(function (t) {
    if (t.kind !== 'expense') return;
    const k = t.category || 'cat_other_e';
    const v = -t.amountCents;
    if (t.month === m) { cur[k] = (cur[k] || 0) + v; count[k] = (count[k] || 0) + 1; total += v; }
    else if (prevM && t.month === prevM) { prev[k] = (prev[k] || 0) + v; prevTotal += v; }
  });
  const names = {};
  s.categories.forEach(function (c) { names[c.id] = c; });
  const keys = {};
  Object.keys(cur).forEach(function (k) { keys[k] = 1; });
  Object.keys(prev).forEach(function (k) { keys[k] = 1; });
  const rows = Object.keys(keys).map(function (k) {
    const c = names[k] || { name: '未分类', group: '其他' };
    const spent = cur[k] || 0, before = prev[k] || 0;
    return {
      category: k, name: c.name, group: c.group,
      spentCents: spent, prevCents: before, deltaCents: spent - before,
      shareBp: total > 0 ? Math.round(spent * 10000 / total) : 0,
      txnCount: count[k] || 0
    };
  }).sort(function (a, b) { return b.spentCents - a.spentCents; });
  return { month: m, prevMonth: prevM, rows: rows, totalCents: total, prevTotalCents: prevTotal };
}
function goalRows(state) {
  const s = normalize(state);
  return s.goals.map(function (g) {
    return Object.assign({}, g, {
      remainingCents: Math.max(0, g.targetCents - g.savedCents),
      progressBp: g.targetCents > 0 ? Math.round(g.savedCents * 10000 / g.targetCents) : 0,
      reached: g.targetCents > 0 && g.savedCents >= g.targetCents
    });
  });
}
// 周期账单只给「本月该记什么」的建议，是否已记靠同月同商户同金额判定；绝不自动写库。
function recurringRows(state, month) {
  const s = normalize(state);
  const p = parseMonth(validMonth(month));
  if (!p) return [];
  const curIdx = monthIndex(p);
  const m = fmtMonth(p);
  const out = [];
  s.recurring.forEach(function (r) {
    if (!r.enabled || !r.startDate) return;
    const sp = parseDate(r.startDate);
    if (!sp) return;
    const startIdx = monthIndex({ y: sp.y, m: sp.m });
    if (curIdx < startIdx) return;
    if (r.endMode === 'date' && r.endDate && m > r.endDate.slice(0, 7)) return;
    const step = r.interval === 'yearly' ? 12 : (r.interval === 'quarterly' ? 3 : 1);
    if ((curIdx - startIdx) % step !== 0) return;
    const date = fmtDate({ y: p.y, m: p.m, d: Math.min(sp.d, daysInMonth(p.y, p.m)) });
    const recorded = s.txns.some(function (t) {
      if (t.month !== m || t.amountCents !== r.amountCents) return false;
      // r.payee 为空时不能拿空串去比，否则任何无对方的流水都会被误判成「已记」。
      return (r.payee && t.payee === r.payee) || (r.name && t.note === r.name);
    });
    out.push({
      id: r.id, name: r.name, date: date, amountCents: r.amountCents,
      category: r.category, account: r.account, payee: r.payee,
      interval: r.interval, recorded: recorded
    });
  });
  return out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
}
// 订阅识别：同商户 ≥2 笔、金额落在中位数 ±5%、且至少一对落在相邻月份。
// 纯离线启发式，不做银行聚合；识别结果只是候选，用户可据此建周期账单。
function detectSubscriptions(state) {
  const s = normalize(state);
  const buckets = {};
  s.txns.forEach(function (t) {
    if (t.kind !== 'expense' || !t.payee) return;
    (buckets[t.payee] = buckets[t.payee] || []).push(t);
  });
  const out = [];
  Object.keys(buckets).forEach(function (payee) {
    const list = buckets[payee];
    if (list.length < SUB_MIN_HITS) return;
    const vals = list.map(function (t) { return -t.amountCents; })
      .sort(function (a, b) { return a - b; });
    const med = vals[Math.floor(vals.length / 2)];
    if (med <= 0) return;
    const near = list.filter(function (t) {
      return Math.abs(-t.amountCents - med) * 10000 <= med * SUB_AMOUNT_TOL_BP;
    });
    if (near.length < SUB_MIN_HITS) return;
    near.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    let monthly = 0;
    for (let i = 1; i < near.length; i++) {
      const a = parseDate(near[i - 1].date), b = parseDate(near[i].date);
      if (!a || !b) continue;
      if (monthIndex({ y: b.y, m: b.m }) - monthIndex({ y: a.y, m: a.m }) === 1) monthly += 1;
    }
    if (monthly < 1) return;
    const last = near[near.length - 1];
    out.push({
      payee: payee, count: near.length, typicalCents: med,
      monthlyCents: med, lastDate: last.date,
      firstDate: near[0].date, category: last.category
    });
  });
  return out.sort(function (a, b) { return b.typicalCents - a.typicalCents; }).slice(0, 30);
}
// 交易检索：关键字 / 分类 / 账户 / 类型 / 日期区间 / 金额绝对值区间，全部整数分比较。
function searchTxns(state, q) {
  const s = normalize(state);
  const query = isObj(q) ? q : {};
  const kw = clean(query.keyword, NOTE_MAX).toLowerCase();
  const from = validDate(query.from), to = validDate(query.to);
  const hasMin = query.minCents !== undefined && query.minCents !== '';
  const hasMax = query.maxCents !== undefined && query.maxCents !== '';
  const minC = Math.abs(toCents(query.minCents));
  const maxC = hasMax ? Math.abs(toCents(query.maxCents)) : CENTS_MAX;
  const cat = clean(query.category, ID_MAX), acc = clean(query.account, ID_MAX);
  const kind = KINDS.indexOf(str(query.kind)) >= 0 ? str(query.kind) : '';
  return s.txns.filter(function (t) {
    if (cat && t.category !== cat) return false;
    if (acc && t.account !== acc) return false;
    if (kind && t.kind !== kind) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    const mag = Math.abs(t.amountCents);
    if (hasMin && mag < minC) return false;
    if (hasMax && mag > maxC) return false;
    if (kw) {
      const hay = (t.payee + ' ' + t.note + ' ' + t.category + ' ' + t.account).toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  }).sort(function (a, b) {
    return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.id < b.id ? 1 : -1));
  }).slice(0, 500);
}
// 批量编辑：只放行 4 个字段，且不重跑规则——批量修正是用户显式决定，不该被规则二次改写。
function bulkUpdate(state, ids, patch) {
  const s = normalize(state);
  const idset = {};
  (Array.isArray(ids) ? ids : []).slice(0, 500).forEach(function (x) {
    idset[clean(x, ID_MAX)] = 1;
  });
  const p = isObj(patch) ? patch : {};
  const allowed = {};
  if (p.category !== undefined) allowed.category = clean(p.category, ID_MAX);
  if (p.account !== undefined) allowed.account = clean(p.account, ID_MAX);
  if (p.kind !== undefined && KINDS.indexOf(str(p.kind)) >= 0) allowed.kind = str(p.kind);
  if (p.cleared !== undefined) allowed.cleared = bool(p.cleared, false);
  let updated = 0;
  const txns = s.txns.map(function (t) {
    if (!idset[t.id]) return t;
    updated += 1;
    return Object.assign({}, t, allowed);
  });
  return { state: normalize(Object.assign({}, s, { txns: txns })), updated: updated };
}
// 右栏洞察：把散在 5 张表里的信号收成一屏，不新增任何持久化字段。
function insights(state, month) {
  const b = board(state, month);
  const nw = netWorth(state, b.month);
  const cf = cashFlow(state, b.month);
  const subs = detectSubscriptions(state);
  const overspent = b.budgets.filter(function (x) { return x.configured && x.remainingCents < 0; })
    .map(function (x) { return { name: x.name, overCents: -x.remainingCents }; });
  let biggest = null;
  b.txns.forEach(function (t) {
    if (t.kind !== 'expense') return;
    if (!biggest || t.amountCents < biggest.amountCents) biggest = t;
  });
  let subCents = 0;
  subs.forEach(function (x) { subCents += x.monthlyCents; });
  return {
    month: b.month, savingBp: cf.savingBp,
    incomeDeltaBp: cf.incomeDeltaBp, expenseDeltaBp: cf.expenseDeltaBp,
    netWorthCents: nw.netCents, assetsCents: nw.assetsCents, liabilitiesCents: nw.liabilitiesCents,
    overspent: overspent,
    biggest: biggest ? { id: biggest.id, date: biggest.date, payee: biggest.payee, amountCents: biggest.amountCents } : null,
    subscriptionCents: subCents, subscriptionCount: subs.length,
    topCategory: b.byCategory.length ? b.byCategory[0] : null,
    budgetUsedBp: b.totals.budgetLimitCents > 0
      ? Math.round(b.totals.budgetSpentCents * 10000 / b.totals.budgetLimitCents) : 0,
    ruleHit: b.stats.ruleHit, imported: b.stats.imported
  };
}

// ---------------------------------------------------------------- 新增段落的增删改

function addGoal(state, patch) {
  const s = normalize(state);
  const p = isObj(patch) ? patch : {};
  const g = normGoal(Object.assign({}, p, { id: nextId('goal', s.goals) }), s.goals.length, {});
  if (!g.targetCents) return s;
  return normalize(Object.assign({}, s, { goals: s.goals.concat([g]).slice(-MAX_GOALS) }));
}
function updateGoal(state, id, patch) {
  const s = normalize(state), key = clean(id, ID_MAX);
  const p = isObj(patch) ? patch : {};
  let found = false;
  const goals = s.goals.map(function (g) {
    if (g.id !== key) return g;
    found = true;
    return normGoal(Object.assign({}, g, p, { id: key }), 0, {});
  });
  return found ? normalize(Object.assign({}, s, { goals: goals })) : s;
}
function removeGoal(state, id) {
  const s = normalize(state), key = clean(id, ID_MAX);
  return normalize(Object.assign({}, s, { goals: s.goals.filter(function (g) { return g.id !== key; }) }));
}
function addRecurring(state, patch) {
  const s = normalize(state);
  const p = isObj(patch) ? patch : {};
  const r = normRecurring(Object.assign({}, p, { id: nextId('rec', s.recurring) }), s.recurring.length, {});
  if (!r.startDate || !r.amountCents) return s;
  return normalize(Object.assign({}, s, { recurring: s.recurring.concat([r]).slice(-MAX_RECURRING) }));
}
function updateRecurring(state, id, patch) {
  const s = normalize(state), key = clean(id, ID_MAX);
  const p = isObj(patch) ? patch : {};
  let found = false;
  const recurring = s.recurring.map(function (r) {
    if (r.id !== key) return r;
    found = true;
    return normRecurring(Object.assign({}, r, p, { id: key }), 0, {});
  });
  return found ? normalize(Object.assign({}, s, { recurring: recurring })) : s;
}
function removeRecurring(state, id) {
  const s = normalize(state), key = clean(id, ID_MAX);
  return normalize(Object.assign({}, s, {
    recurring: s.recurring.filter(function (r) { return r.id !== key; })
  }));
}
function setAccountMeta(state, id, patch) {
  const s = normalize(state), key = clean(id, ID_MAX);
  const p = isObj(patch) ? patch : {};
  let found = false;
  const accounts = s.accounts.map(function (a) {
    if (a.id !== key) return a;
    found = true;
    const next = Object.assign({}, a);
    if (p.name !== undefined) next.name = clean(p.name, NAME_MAX);
    if (p.kind !== undefined && ACCOUNT_KINDS.indexOf(str(p.kind)) >= 0) next.kind = str(p.kind);
    if (p.side !== undefined && ACCOUNT_SIDES.indexOf(str(p.side)) >= 0) next.side = str(p.side);
    if (p.openingCents !== undefined) next.openingCents = toCents(p.openingCents);
    if (p.archived !== undefined) next.archived = bool(p.archived, false);
    return normAccount(next, 0, {});
  });
  return found ? normalize(Object.assign({}, s, { accounts: accounts })) : s;
}

module.exports = {
  VERSION: VERSION,
  normalize: normalize,
  meta: meta,
  board: board,
  budgetRows: budgetRows,
  applyRules: applyRules,
  addTxn: addTxn,
  updateTxn: updateTxn,
  removeTxn: removeTxn,
  setBudget: setBudget,
  removeBudget: removeBudget,
  addRule: addRule,
  updateRule: updateRule,
  removeRule: removeRule,
  addCategory: addCategory,
  removeCategory: removeCategory,
  addAccount: addAccount,
  removeAccount: removeAccount,
  importCsv: importCsv,
  exportCsv: exportCsv,
  accountRows: accountRows,
  netWorth: netWorth,
  cashFlow: cashFlow,
  categoryReport: categoryReport,
  goalRows: goalRows,
  recurringRows: recurringRows,
  detectSubscriptions: detectSubscriptions,
  searchTxns: searchTxns,
  bulkUpdate: bulkUpdate,
  insights: insights,
  addGoal: addGoal,
  updateGoal: updateGoal,
  removeGoal: removeGoal,
  addRecurring: addRecurring,
  updateRecurring: updateRecurring,
  removeRecurring: removeRecurring,
  setAccountMeta: setAccountMeta,
  mergeSection: mergeSection,
  parseAmountCents: parseAmountCents,
  formatCents: formatCents,
  parseCsv: parseCsv,
  decodeCsvBytes: decodeCsvBytes,
  validDate: validDate,
  validMonth: validMonth
};
