<script setup lang="ts">
// 家庭账本 · 独立窗口（左中右三栏）
//
// 形态：顶栏「记账」→ 主进程开独立 BrowserWindow → 本视图挂在第二个 Vite 入口。
// 与「图书馆」同级：自己的 md_finance 单键、自己的领域层、自己的右栏上下文。
// 四条硬口径不变：管预算（信封制）/ 不做家庭共享 / 第一期 CSV 导入 / 金额全程整数分。
// 元只在 yuan() 出现一次；领域层所有金额都是 cents 整数。
//
// 功能骨架参考 maybe 的「账户 → 余额 → 资产负债表 / 损益表」，但它是
// AGPL-3.0 + Rails + PostgreSQL 且已停更，这里只取设计口径，代码一行未移植。
// 明确不做：银行自动同步、行情汇率、AI 助手、账号与家庭共享。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { saveExport } from '../bridge';

interface Cat { id: string; name: string; group: string; kind: string; archived: boolean }
interface Acc { id: string; name: string; kind: string; archived: boolean; side: string; openingCents: number }
interface Txn {
  id: string; date: string; month: string; amountCents: number; kind: string;
  account: string; category: string; payee: string; note: string;
  transferId: string; importedId: string; ruleIds: string[]; cleared: boolean;
}
interface Rule {
  id: string; name: string; priority: number; enabled: boolean; match: string;
  stop: boolean; conditions: { field: string; op: string; value: string }[];
  actions: { type: string; value: string }[];
}
interface BudgetRow {
  category: string; name: string; group: string; limitCents: number;
  spentCents: number; carryInCents: number; remainingCents: number;
  rollover: boolean; usedBp: number; configured: boolean;
}
interface Totals {
  incomeCents: number; expenseCents: number; netCents: number;
  transferCents: number; budgetLimitCents: number;
  budgetSpentCents: number; budgetRemainingCents: number;
}
interface BoardData {
  version: number; month: string; totals: Totals; budgets: BudgetRow[];
  byCategory: { category: string; name: string; group: string; spentCents: number; shareBp: number }[];
  trend: { month: string; incomeCents: number; expenseCents: number }[];
  txns: Txn[]; categories: Cat[]; accounts: Acc[]; rules: Rule[];
  stats: { txnTotal: number; inMonth: number; imported: number; ruleHit: number; budgetCount: number; ruleCount: number };
}
interface Meta {
  kinds: string[]; accountKinds: string[]; liabilityKinds: string[];
  accountSides: string[]; goalStates: string[]; intervals: string[]; endModes: string[];
  conditionFields: string[]; conditionOps: string[]; actionTypes: string[];
  limits: { maxTxns: number; maxRules: number; centsMax: number; noteMax: number; nameMax: number; csvMaxBytes: number };
}
interface ImportReport {
  platform: string; encoding: string; headerLine: number; total: number;
  added: number; skipped: number; duplicates: number; errors: string[];
}
interface RuleDraft {
  name: string; priority: number; match: string; stop: boolean; enabled: boolean;
  conditions: { field: string; op: string; value: string }[];
  actions: { type: string; value: string }[];
}
interface AccountRow {
  id: string; name: string; kind: string; side: string; archived: boolean;
  openingCents: number; flowCents: number; balanceCents: number; txnCount: number;
}
interface NetWorthData {
  month: string; assetsCents: number; liabilitiesCents: number; netCents: number;
  groups: { side: string; name: string; totalCents: number; assetCents: number; liabilityCents: number; accounts: AccountRow[] }[];
  accounts: AccountRow[]; series: { month: string; netCents: number }[];
}
interface CashFlowData {
  month: string; months: { month: string; incomeCents: number; expenseCents: number; netCents: number }[];
  incomeCents: number; expenseCents: number; netCents: number;
  incomeDeltaBp: number; expenseDeltaBp: number; savingBp: number;
}
interface CategoryRow {
  category: string; name: string; group: string; spentCents: number;
  prevCents: number; deltaCents: number; shareBp: number; txnCount: number;
}
interface CategoryReportData {
  month: string; prevMonth: string; rows: CategoryRow[];
  totalCents: number; prevTotalCents: number;
}
interface GoalRow {
  id: string; name: string; targetCents: number; savedCents: number;
  month: string; state: string; note: string;
  remainingCents: number; progressBp: number; reached: boolean;
}
// 储蓄目标统一行：账本自建目标 + 梦想板块开了账户的梦想，用同一个列表渲染。
// 梦想账户的数据仍留在 md_dream，这里只是把它「放进」储蓄目标，不复制、不迁移。
interface GoalView extends GoalRow { source: 'local' | 'dream'; dreamId?: string }
interface MoneyRow {
  id: string; date: string; type: string; cents: number;
  category: string; note: string; importedId: string; imported: boolean;
}
interface MoneyRowsData { rows: MoneyRow[]; pending: number }
interface DreamFund { target: number; saved: number; pct: number; ready: boolean }
interface DreamBoardRow { id: string; title: string; fund: DreamFund | null }
interface DreamBoardData { rows: DreamBoardRow[] }
interface RecurringRow {
  id: string; name: string; date: string; amountCents: number;
  category: string; account: string; payee: string; interval: string; recorded: boolean;
}
interface RecurringItem {
  id: string; name: string; payee: string; amountCents: number;
  category: string; account: string; startDate: string;
  interval: string; endMode: string; endDate: string; enabled: boolean;
}
interface Subscription {
  payee: string; count: number; typicalCents: number; monthlyCents: number;
  lastDate: string; firstDate: string; category: string;
}
interface Insights {
  month: string; savingBp: number; incomeDeltaBp: number; expenseDeltaBp: number;
  netWorthCents: number; assetsCents: number; liabilitiesCents: number;
  overspent: { name: string; overCents: number }[];
  biggest: { id: string; date: string; payee: string; amountCents: number } | null;
  subscriptionCents: number; subscriptionCount: number;
  topCategory: { category: string; name: string; spentCents: number; shareBp: number } | null;
  budgetUsedBp: number; ruleHit: number; imported: number;
}

type TabKey = 'overview' | 'flow' | 'budget' | 'accounts' | 'reports' | 'goals' | 'recurring' | 'rules' | 'import';
const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: 'overview', label: '总览', hint: '净资产 / 收支 / 预算一屏看完' },
  { key: 'flow', label: '流水', hint: '记一笔、检索、批量修正、导出' },
  { key: 'budget', label: '预算', hint: '信封额度与结转' },
  { key: 'accounts', label: '账户', hint: '资产负债与期初余额' },
  { key: 'reports', label: '报表', hint: '损益表与分类环比' },
  { key: 'goals', label: '储蓄目标', hint: '目标额 / 已存 / 进度' },
  { key: 'recurring', label: '周期与订阅', hint: '固定账单与自动识别' },
  { key: 'rules', label: '自动分类规则', hint: '条件 → 动作' },
  { key: 'import', label: 'CSV 导入', hint: '支付宝 / 微信 / 通用' }
];

const props = defineProps<{ today: string }>();

// ---- 栏宽规格与主窗 App.vue 一字不差：默认 240 / 300、上下限、中栏 ≥420 ----
// 独立 localStorage key：两个窗口各存各的，但拖动规则、双击复位、方向键微调完全一致。
const FIN_LAYOUT_KEY = 'jiuge.finance.layout.v1';
const NAV_DEF = 240, NAV_MIN = 168, NAV_MAX = 360;
const RAIL_DEF = 300, RAIL_MIN = 240, RAIL_MAX = 520;
const CENTER_MIN = 420;
const navW = ref(NAV_DEF);
const railW = ref(RAIL_DEF);
const dragging = ref<'' | 'nav' | 'rail'>('');
const columnsEl = ref<HTMLElement | null>(null);
function clampW(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
function loadLayout(): void {
  try {
    const raw = localStorage.getItem(FIN_LAYOUT_KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as { nav?: number; rail?: number };
    if (typeof o.nav === 'number' && isFinite(o.nav)) navW.value = clampW(o.nav, NAV_MIN, NAV_MAX);
    if (typeof o.rail === 'number' && isFinite(o.rail)) railW.value = clampW(o.rail, RAIL_MIN, RAIL_MAX);
  } catch { /* 坏值（手改过 / 隐私模式）就用默认宽度 */ }
}
function saveLayout(): void {
  try { localStorage.setItem(FIN_LAYOUT_KEY, JSON.stringify({ nav: navW.value, rail: railW.value })); }
  catch { /* 写不进就只在本轮生效，不弹窗打扰 */ }
}
function startDrag(which: 'nav' | 'rail', ev: PointerEvent): void {
  if (window.innerWidth < 1024) return;
  dragging.value = which;
  const el = ev.currentTarget as HTMLElement;
  if (el.setPointerCapture) el.setPointerCapture(ev.pointerId);
  ev.preventDefault();
}
function onDrag(ev: PointerEvent): void {
  if (!dragging.value || !columnsEl.value) return;
  const rect = columnsEl.value.getBoundingClientRect();
  if (dragging.value === 'nav') {
    const max = Math.max(NAV_MIN, Math.min(NAV_MAX, rect.width - railW.value - CENTER_MIN));
    navW.value = clampW(ev.clientX - rect.left, NAV_MIN, max);
  } else {
    const max = Math.max(RAIL_MIN, Math.min(RAIL_MAX, rect.width - navW.value - CENTER_MIN));
    railW.value = clampW(rect.right - ev.clientX, RAIL_MIN, max);
  }
}
function endDrag(): void {
  if (!dragging.value) return;
  dragging.value = '';
  saveLayout();
}
function resetLayout(): void {
  navW.value = NAV_DEF;
  railW.value = RAIL_DEF;
  saveLayout();
  flash('栏宽已恢复默认');
}
function nudge(which: 'nav' | 'rail', delta: number): void {
  if (which === 'nav') navW.value = clampW(navW.value + delta, NAV_MIN, NAV_MAX);
  else railW.value = clampW(railW.value + delta, RAIL_MIN, RAIL_MAX);
  saveLayout();
}

function currentMonth(): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(props.today)) return props.today.slice(0, 7);
  const d = new Date(), m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m));
}
const month = ref(currentMonth());
const tab = ref<TabKey>('overview');
const board = ref<BoardData | null>(null);
const meta = ref<Meta | null>(null);
const worth = ref<NetWorthData | null>(null);
const flowData = ref<CashFlowData | null>(null);
const catReport = ref<CategoryReportData | null>(null);
const goals = ref<GoalRow[]>([]);
const dreamGoals = ref<GoalView[]>([]);
const moneyRows = ref<MoneyRow[]>([]);
const dueRows = ref<RecurringRow[]>([]);
const recurringItems = ref<RecurringItem[]>([]);
const subscriptions = ref<Subscription[]>([]);
const insights = ref<Insights | null>(null);
const selected = ref<Txn | null>(null);
const notice = ref('');
const busy = ref(false);

const ACC_LABEL: Record<string, string> = {
  cash: '现金', bank: '银行卡', alipay: '支付宝', wechat: '微信', credit: '信用卡',
  invest: '投资账户', property: '房产', loan: '贷款', other_asset: '其他资产',
  other_liability: '其他负债', other: '其他'
};
const FIELD_LABEL: Record<string, string> = {
  payee: '交易对方', note: '备注', category: '分类', account: '账户',
  kind: '类型', amountCents: '金额(分)', date: '日期'
};
const OP_LABEL: Record<string, string> = {
  contains: '包含', eq: '等于', prefix: '开头是', suffix: '结尾是', gte: '≥', lte: '≤'
};
const ACT_LABEL: Record<string, string> = {
  setCategory: '设为分类', setPayee: '改交易对方', setNote: '追加备注',
  setAccount: '改账户', setKind: '改类型'
};
const INTERVAL_LABEL: Record<string, string> = { monthly: '每月', quarterly: '每季', yearly: '每年' };

// 「元 -> 分」走整数字符串，不经过浮点；「分 -> 元」是唯一的展示出口。
function parseYuan(v: string): number {
  let s = String(v || '').trim().replace(/[¥￥$,，\s元]/g, '');
  let neg = false;
  if (s.charAt(0) === '(' && s.slice(-1) === ')') { neg = true; s = s.slice(1, -1); }
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  else if (s.charAt(0) === '+') s = s.slice(1);
  const dot = s.indexOf('.');
  const whole = (dot < 0 ? s : s.slice(0, dot)).replace(/\D/g, '');
  const frac = ((dot < 0 ? '' : s.slice(dot + 1)).replace(/\D/g, '') + '00').slice(0, 2);
  if (!whole && !frac) return 0;
  const c = Number(whole || '0') * 100 + Number(frac);
  return neg ? -c : c;
}
function yuan(c: number): string {
  const n = Math.trunc(Number(c) || 0), a = Math.abs(n);
  return (n < 0 ? '-' : '') + '¥' + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}
function bp(v: number): string {
  const n = Math.trunc(Number(v) || 0);
  return (n > 0 ? '+' : '') + (n / 100).toFixed(1) + '%';
}
function shiftMonth(delta: number): void {
  const y = Number(month.value.slice(0, 4)), m = Number(month.value.slice(5, 7)) + delta;
  const yy = y + Math.floor((m - 1) / 12), mm = ((m - 1) % 12 + 12) % 12 + 1;
  month.value = yy + '-' + (mm < 10 ? '0' + mm : String(mm));
}
function catName(id: string): string {
  const c = (board.value?.categories || []).find((x) => x.id === id);
  return c ? c.name : (id ? '未分类' : '—');
}
function accName(id: string): string {
  const a = (board.value?.accounts || []).find((x) => x.id === id);
  return a ? a.name : (id ? id : '—');
}
function kindLabel(k: string): string {
  return k === 'income' ? '收入' : (k === 'transfer' ? '转账' : '支出');
}
const totals = computed<Totals>(() => board.value?.totals || {
  incomeCents: 0, expenseCents: 0, netCents: 0, transferCents: 0,
  budgetLimitCents: 0, budgetSpentCents: 0, budgetRemainingCents: 0
});
const maxTrend = computed(() => Math.max(1, ...(board.value?.trend || []).map((x) => Math.max(x.incomeCents, x.expenseCents))));
const expenseCats = computed(() => (board.value?.categories || []).filter((c) => c.kind === 'expense' && !c.archived));
const incomeCats = computed(() => (board.value?.categories || []).filter((c) => c.kind === 'income' && !c.archived));
const configuredBudgets = computed(() => (board.value?.budgets || []).filter((b) => b.configured));

async function load(): Promise<void> {
  const m = month.value;
  const [b, mt, nw, cf, cr, gl, due, subs, ins, rec, rd, mr, db] = await Promise.all([
    callDomain<BoardData | null>('finance.board', null, m),
    callDomain<Meta | null>('finance.meta', null),
    callDomain<NetWorthData | null>('finance.netWorth', null, m),
    callDomain<CashFlowData | null>('finance.cashFlow', null, m),
    callDomain<CategoryReportData | null>('finance.categoryReport', null, m),
    callDomain<GoalRow[]>('finance.goalRows', []),
    callDomain<RecurringRow[]>('finance.recurringRows', [], m),
    callDomain<Subscription[]>('finance.detectSubscriptions', []),
    callDomain<Insights | null>('finance.insights', null, m),
    callDomain<{ recurring: RecurringItem[] } | null>('finance.read', null),
    callDomain<Meta | null>('finance.meta', null),
    // 只读扫描九格日记里的 moneyBook；梦想账户从 md_dream 读，两者都不写回源库
    callDomain<MoneyRowsData | null>('finance.moneyRows', null),
    callDomain<DreamBoardData | null>('dream.board', null, props.today)
  ]);
  board.value = b;
  meta.value = mt || rd;
  worth.value = nw;
  flowData.value = cf;
  catReport.value = cr;
  goals.value = gl || [];
  moneyRows.value = (mr && Array.isArray(mr.rows)) ? mr.rows : [];
  dreamGoals.value = mapDreamGoals(db);
  dueRows.value = due || [];
  recurringItems.value = (rec && Array.isArray(rec.recurring) ? rec.recurring : []);
  subscriptions.value = subs || [];
  insights.value = ins;
}
function onRefresh(): void { void load(); }
onMounted(() => {
  loadLayout();
  void load();
  window.addEventListener('finance:refresh', onRefresh);
});
onUnmounted(() => { window.removeEventListener('finance:refresh', onRefresh); });
watch(month, () => { void load(); });
function flash(text: string): void {
  notice.value = text;
  window.setTimeout(() => { if (notice.value === text) notice.value = ''; }, 3500);
}

// ---- 流水 ----
const form = ref({
  date: props.today || '', kind: 'expense', amount: '', category: 'cat_food',
  account: 'acc_alipay', toAccount: 'acc_bank', payee: '', note: ''
});
async function addEntry(): Promise<void> {
  const cents = parseYuan(form.value.amount);
  if (!form.value.date || !cents) { flash('请填日期和金额'); return; }
  busy.value = true;
  await callDomain('finance.add', null, {
    date: form.value.date, kind: form.value.kind,
    amountCents: form.value.kind === 'income' ? Math.abs(cents) : -Math.abs(cents),
    category: form.value.kind === 'transfer' ? '' : form.value.category,
    account: form.value.account, toAccount: form.value.toAccount,
    payee: form.value.payee, note: form.value.note
  });
  form.value.amount = ''; form.value.payee = ''; form.value.note = '';
  flash('已记一笔');
  await load();
  busy.value = false;
}
async function removeEntry(id: string): Promise<void> {
  await callDomain('finance.remove', null, id);
  if (selected.value?.id === id) selected.value = null;
  await load();
}
async function exportCsv(): Promise<void> {
  const text = await callDomain<string>('finance.exportCsv', '');
  await saveExport('家庭账本-' + month.value + '.csv', text);
  flash('账本已导出 CSV');
}
const filter = ref({ keyword: '', category: '', account: '', kind: '', from: '', to: '', min: '', max: '' });
const searchRows = ref<Txn[]>([]);
const bulkIds = ref<string[]>([]);
const bulkCat = ref('');
async function runSearch(): Promise<void> {
  const q: Record<string, unknown> = {
    keyword: filter.value.keyword, category: filter.value.category,
    account: filter.value.account, kind: filter.value.kind,
    from: filter.value.from, to: filter.value.to
  };
  if (filter.value.min) q.minCents = Math.abs(parseYuan(filter.value.min));
  if (filter.value.max) q.maxCents = Math.abs(parseYuan(filter.value.max));
  searchRows.value = await callDomain<Txn[]>('finance.search', [], q);
  bulkIds.value = [];
}
function onBulkChange(ev: Event, id: string): void {
  const on = (ev.target as HTMLInputElement).checked;
  const list = bulkIds.value.slice();
  const i = list.indexOf(id);
  if (on && i < 0) list.push(id);
  else if (!on && i >= 0) list.splice(i, 1);
  bulkIds.value = list;
}
async function applyBulk(): Promise<void> {
  if (!bulkIds.value.length || !bulkCat.value) { flash('先勾选流水并选一个目标分类'); return; }
  const n = await callDomain<number>('finance.bulkUpdate', 0, bulkIds.value, { category: bulkCat.value });
  flash('已批量修正 ' + n + ' 笔');
  bulkIds.value = [];
  await load();
  await runSearch();
}
const flowRows = computed<Txn[]>(() => searchRows.value.length ? searchRows.value : (board.value?.txns || []));

// ---- 预算 ----
const budgetForm = ref({ category: '', limit: '', rollover: true });
async function saveBudget(): Promise<void> {
  if (!budgetForm.value.category) { flash('先选一个分类'); return; }
  await callDomain('finance.setBudget', null, {
    month: month.value, category: budgetForm.value.category,
    limitCents: Math.abs(parseYuan(budgetForm.value.limit)),
    rollover: budgetForm.value.rollover
  });
  budgetForm.value.limit = '';
  flash('预算已更新');
  await load();
}
function editBudget(row: BudgetRow): void {
  budgetForm.value.category = row.category;
  budgetForm.value.limit = yuan(row.limitCents).replace(/[¥-]/g, '');
  budgetForm.value.rollover = row.rollover;
}
async function clearBudget(row: BudgetRow): Promise<void> {
  await callDomain('finance.setBudget', null, {
    month: month.value, category: row.category, limitCents: 0, rollover: row.rollover
  });
  await load();
}
const newCat = ref({ name: '', group: '', kind: 'expense' });
const newAcc = ref({ name: '', kind: 'bank' });
async function addCat(): Promise<void> {
  if (!newCat.value.name.trim()) return;
  await callDomain('finance.addCategory', null, { ...newCat.value, name: newCat.value.name.trim() });
  newCat.value.name = '';
  await load();
}
async function removeCat(id: string): Promise<void> {
  await callDomain('finance.removeCategory', null, id);
  await load();
}
async function addAcc(): Promise<void> {
  if (!newAcc.value.name.trim()) return;
  await callDomain('finance.addAccount', null, { ...newAcc.value, name: newAcc.value.name.trim() });
  newAcc.value.name = '';
  await load();
}
async function removeAcc(id: string): Promise<void> {
  await callDomain('finance.removeAccount', null, id);
  await load();
}

// ---- 账户 / 期初 ----
const accEdit = ref<Record<string, string>>({});
async function saveOpening(a: AccountRow): Promise<void> {
  const v = parseYuan(accEdit.value[a.id] || '');
  await callDomain('finance.setAccountMeta', null, a.id, { openingCents: v });
  accEdit.value[a.id] = '';
  flash('期初余额已更新');
  await load();
}
async function toggleSide(a: AccountRow): Promise<void> {
  await callDomain('finance.setAccountMeta', null, a.id, {
    side: a.side === 'asset' ? 'liability' : 'asset'
  });
  await load();
}

// ---- 目标：账本自建目标 + 梦想账户统一入口 ----
const goalForm = ref({ name: '', target: '', saved: '', month: '' });
const savingInput = ref<Record<string, string>>({});
function mapDreamGoals(db: DreamBoardData | null): GoalView[] {
  const rows = (db && Array.isArray(db.rows)) ? db.rows : [];
  return rows.filter((r) => !!r.fund && r.fund.target > 0).map((r) => {
    const target = r.fund ? r.fund.target : 0;
    const saved = r.fund ? r.fund.saved : 0;
    return {
      id: 'dream:' + r.id, dreamId: r.id, source: 'dream' as const,
      name: r.title, targetCents: target, savedCents: saved,
      remainingCents: Math.max(0, target - saved),
      progressBp: target > 0 ? Math.min(10000, Math.round(saved * 10000 / target)) : 0,
      reached: saved >= target, month: '', state: 'active', note: ''
    };
  });
}
const allGoals = computed<GoalView[]>(() => {
  const local: GoalView[] = goals.value.map((g) => Object.assign({}, g, { source: 'local' as const }));
  return local.concat(dreamGoals.value);
});

// ---- 与九格「金钱收支」格联动：只读展示，用户点名才导入 ----
const moneyMonthRows = computed(() => moneyRows.value.filter((r) => r.date.slice(0, 7) === month.value));
const moneyPending = computed(() => moneyMonthRows.value.filter((r) => !r.imported));
async function importMoney(rows: MoneyRow[]): Promise<void> {
  if (!rows.length) return;
  const res = await callDomain<{ added: number; skipped: number } | null>('finance.importMoneyRows', null,
    rows.map((r) => ({
      id: r.id, date: r.date, type: r.type, cents: r.cents,
      category: r.category, note: r.note
    })));
  flash('已导入 ' + (res ? res.added : 0) + ' 笔，跳过重复 ' + (res ? res.skipped : 0) + ' 笔');
  await load();
}
function importAllMoney(): void { void importMoney(moneyPending.value); }

async function addGoal(): Promise<void> {
  const t = Math.abs(parseYuan(goalForm.value.target));
  if (!goalForm.value.name.trim() || !t) { flash('请填目标名称和金额'); return; }
  await callDomain('finance.addGoal', null, {
    name: goalForm.value.name.trim(), targetCents: t,
    savedCents: Math.abs(parseYuan(goalForm.value.saved)),
    month: goalForm.value.month, state: 'active', note: ''
  });
  goalForm.value = { name: '', target: '', saved: '', month: '' };
  flash('目标已建立');
  await load();
}
async function addSaving(g: GoalView): Promise<void> {
  const v = Math.abs(parseYuan(savingInput.value[g.id] || ''));
  if (!v) return;
  if (g.source === 'dream' && g.dreamId) {
    // 梦想账户的钱仍存 md_dream.deposits；账本不复制一份，避免两处余额打架
    await callDomain('dream.deposit', null, g.dreamId, v, props.today, '账本储蓄目标存入', 'money');
    flash('已存入梦想账户');
  } else {
    await callDomain('finance.updateGoal', null, g.id, { savedCents: g.savedCents + v });
    flash('已记一笔存款');
  }
  savingInput.value[g.id] = '';
  await load();
}
async function removeGoal(id: string): Promise<void> {
  await callDomain('finance.removeGoal', null, id);
  await load();
}

// ---- 周期账单 / 订阅 ----
const recForm = ref({
  name: '', payee: '', amount: '', category: 'cat_house',
  account: 'acc_bank', startDate: props.today || '', interval: 'monthly', endMode: 'never', endDate: ''
});
async function addRecurring(): Promise<void> {
  const v = Math.abs(parseYuan(recForm.value.amount));
  if (!recForm.value.name.trim() || !v || !recForm.value.startDate) { flash('请填名称、金额和起始日'); return; }
  await callDomain('finance.addRecurring', null, {
    name: recForm.value.name.trim(), payee: recForm.value.payee,
    amountCents: -v, category: recForm.value.category, account: recForm.value.account,
    startDate: recForm.value.startDate, interval: recForm.value.interval,
    endMode: recForm.value.endMode, endDate: recForm.value.endDate, enabled: true
  });
  recForm.value.name = ''; recForm.value.payee = ''; recForm.value.amount = '';
  flash('周期账单已建立');
  await load();
}
async function postDue(r: RecurringRow): Promise<void> {
  await callDomain('finance.add', null, {
    date: r.date, kind: 'expense', amountCents: r.amountCents,
    category: r.category, account: r.account, payee: r.payee, note: r.name
  });
  flash('已记入 ' + r.name);
  await load();
}
async function subToRecurring(s: Subscription): Promise<void> {
  await callDomain('finance.addRecurring', null, {
    name: s.payee, payee: s.payee, amountCents: -Math.abs(s.typicalCents),
    category: s.category || 'cat_sub', account: (board.value?.accounts || [])[0]?.id || '',
    startDate: s.firstDate, interval: 'monthly', endMode: 'never', endDate: '', enabled: true
  });
  flash('已按识别结果建立周期账单');
  await load();
}
async function toggleRecurring(r: RecurringItem): Promise<void> {
  await callDomain('finance.updateRecurring', null, r.id, { enabled: !r.enabled });
  await load();
}
async function removeRecurring(id: string): Promise<void> {
  await callDomain('finance.removeRecurring', null, id);
  await load();
}

// ---- 条件 → 动作规则 ----
function blankRule(): RuleDraft {
  return {
    name: '', priority: 100, match: 'all', stop: true, enabled: true,
    conditions: [{ field: 'note', op: 'contains', value: '' }],
    actions: [{ type: 'setCategory', value: 'cat_food' }]
  };
}
const ruleDraft = ref<RuleDraft>(blankRule());
async function saveRule(): Promise<void> {
  if (!ruleDraft.value.name.trim()) { flash('给规则起个名字'); return; }
  await callDomain('finance.addRule', null, {
    ...ruleDraft.value, name: ruleDraft.value.name.trim(),
    conditions: ruleDraft.value.conditions.filter((c) => c.value.trim() !== ''),
    actions: ruleDraft.value.actions.filter((a) => a.value.trim() !== '')
  });
  ruleDraft.value = blankRule();
  flash('规则已加入，记一笔和 CSV 导入都会过它');
  await load();
}
async function toggleRule(r: Rule): Promise<void> {
  await callDomain('finance.updateRule', null, r.id, { enabled: !r.enabled });
  await load();
}
async function removeRule(id: string): Promise<void> {
  await callDomain('finance.removeRule', null, id);
  await load();
}

// ---- CSV 导入：文件字节 -> base64，编码嗅探全在领域层 ----
const importing = ref(false);
const importReport = ref<ImportReport | null>(null);
function toBase64(bytes: Uint8Array): string {
  let out = '';
  const CH = 8190;
  for (let i = 0; i < bytes.length; i += CH) {
    let part = '';
    const end = Math.min(bytes.length, i + CH);
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
    out += btoa(part);
  }
  return out;
}
async function onFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files && input.files[0];
  if (!file) return;
  importing.value = true;
  importReport.value = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const cap = meta.value?.limits.csvMaxBytes || 8388608;
    if (bytes.length > cap) {
      importReport.value = {
        platform: 'generic', encoding: 'unknown', headerLine: -1, total: 0,
        added: 0, skipped: 0, duplicates: 0, errors: ['文件超过 ' + Math.round(cap / 1048576) + ' MB 上限']
      };
    } else {
      const rep = await callDomain<ImportReport | null>('finance.importCsv', null, {
        data: toBase64(bytes), filename: file.name
      });
      importReport.value = rep;
      await load();
      flash(rep ? ('导入完成：新增 ' + rep.added + ' 条，跳过 ' + rep.skipped + ' 条，重复 ' + rep.duplicates + ' 条') : '导入失败');
    }
  } catch (e) {
    importReport.value = {
      platform: 'generic', encoding: 'unknown', headerLine: -1, total: 0,
      added: 0, skipped: 0, duplicates: 0, errors: [(e as Error).message || '读取文件失败']
    };
  } finally {
    importing.value = false;
    input.value = '';
  }
}
</script>

<template>
  <section ref="columnsEl" class="fw-app fin-view" :class="{ 'col-dragging': !!dragging }"
           :style="{ '--nav-w': navW + 'px', '--rail-w': railW + 'px' }" aria-label="家庭账本独立窗口">
    <!-- ==================== 左栏 ==================== -->
    <aside class="fw-left">
      <div class="fw-brand">
        <h1>家庭账本</h1>
        <p>纯本机 · 零网络 · 整数分</p>
      </div>
      <div class="fw-month">
        <button class="fin-mini" aria-label="上个月" @click="shiftMonth(-1)">←</button>
        <span>{{ month }}</span>
        <button class="fin-mini" aria-label="下个月" @click="shiftMonth(1)">→</button>
      </div>
      <div class="fw-worth">
        <span class="fw-worth-label">净资产</span>
        <b :class="{ 'fin-neg': (worth?.netCents || 0) < 0 }">{{ yuan(worth?.netCents || 0) }}</b>
        <div class="fw-worth-split">
          <span>资产 {{ yuan(worth?.assetsCents || 0) }}</span>
          <span>负债 {{ yuan(worth?.liabilitiesCents || 0) }}</span>
        </div>
      </div>
      <nav class="fw-nav" aria-label="账本模块">
        <button
          v-for="t in TABS" :key="t.key" class="fw-nav-item"
          :class="{ 'fw-nav-on': tab === t.key }"
          :aria-pressed="tab === t.key" :title="t.hint"
          @click="tab = t.key"
        >{{ t.label }}</button>
      </nav>
      <div class="fw-left-foot">
        <p>数据挂在 <code>md_finance</code> 单键，随九格备份一起导出。</p>
        <p>与九格「金钱收支」格联动：只读汇总，导入后才计入净资产。</p>
        <p>梦想账户已并入「储蓄目标」，存钱写回梦想板块。</p>
      </div>
    </aside>
    <div class="col-divider" role="separator" aria-label="拖动调整左栏宽度" tabindex="0"
         @pointerdown="startDrag('nav', $event)" @pointermove="onDrag" @pointerup="endDrag"
         @pointercancel="endDrag" @dblclick="resetLayout"
         @keydown.left.prevent="nudge('nav', -16)" @keydown.right.prevent="nudge('nav', 16)"></div>

    <!-- ==================== 中栏 ==================== -->
    <main class="fw-main">
      <p v-if="notice" class="fin-notice" role="status">{{ notice }}</p>

      <!-- ---------- 总览 ---------- -->
      <div v-if="tab === 'overview'" class="fw-pane" data-pane="overview">
        <div class="fw-kpis">
          <div class="fw-kpi"><span>净资产</span><b>{{ yuan(worth?.netCents || 0) }}</b><small>截至 {{ month }}</small></div>
          <div class="fw-kpi"><span>本月收入</span><b class="fin-pos">{{ yuan(totals.incomeCents) }}</b><small>{{ bp(flowData?.incomeDeltaBp || 0) }} 环比</small></div>
          <div class="fw-kpi"><span>本月支出</span><b>{{ yuan(totals.expenseCents) }}</b><small>{{ bp(flowData?.expenseDeltaBp || 0) }} 环比</small></div>
          <div class="fw-kpi"><span>储蓄率</span><b>{{ (insights?.savingBp || 0) / 100 }}%</b><small>结余 / 收入</small></div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">近 6 个月收支</h2>
          <div class="fin-trend" aria-label="近六个月收支">
            <div v-for="t in (board?.trend || [])" :key="t.month" class="fin-trend-col">
              <div class="fin-trend-bars">
                <div class="fin-bar fin-bar-in" :style="{ height: Math.round(t.incomeCents * 100 / maxTrend) + '%' }" :title="'收入 ' + yuan(t.incomeCents)"></div>
                <div class="fin-bar fin-bar-out" :style="{ height: Math.round(t.expenseCents * 100 / maxTrend) + '%' }" :title="'支出 ' + yuan(t.expenseCents)"></div>
              </div>
              <span class="fin-trend-label">{{ t.month.slice(5) }}月</span>
            </div>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">预算进度（{{ configuredBudgets.length }} 个信封）</h2>
          <div v-if="!configuredBudgets.length" class="fin-empty">还没设额度。去「预算」给高频分类定一个，超支才会被如实报出来。</div>
          <div v-for="b in configuredBudgets.slice(0, 6)" :key="b.category" class="fin-budget">
            <div class="fin-budget-top">
              <b>{{ b.name }}</b>
              <span>{{ yuan(b.spentCents) }} / {{ yuan(b.limitCents + b.carryInCents) }}</span>
              <span :class="{ 'fin-neg': b.remainingCents < 0 }">剩 {{ yuan(b.remainingCents) }}</span>
            </div>
            <div class="fin-progress"><div :class="{ 'fin-over': b.usedBp > 10000 }" :style="{ width: Math.min(100, Math.round(b.usedBp / 100)) + '%' }"></div></div>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">最近流水</h2>
          <div v-if="!(board?.txns || []).length" class="fin-empty">本月还没有流水。去「流水」记一笔，或「CSV 导入」把账单放进来。</div>
          <div v-for="t in (board?.txns || []).slice(0, 8)" :key="t.id" class="fin-row" @click="selected = t">
            <span class="fin-row-date">{{ t.date }}</span>
            <span class="fin-row-main">{{ t.payee || t.note || '—' }}</span>
            <span class="fin-row-cat">{{ catName(t.category) }}</span>
            <span class="fin-row-amt" :class="{ 'fin-pos': t.amountCents > 0 }">{{ yuan(t.amountCents) }}</span>
          </div>
        </div>
      </div>

      <!-- ---------- 流水 ---------- -->
      <div v-else-if="tab === 'flow'" class="fw-pane" data-pane="flow">
        <div class="fin-card">
          <h2 class="fin-h2">记一笔</h2>
          <div class="fin-form">
            <label class="fin-field"><span>日期</span><input v-model="form.date" type="date" /></label>
            <label class="fin-field"><span>类型</span>
              <select v-model="form.kind"><option value="expense">支出</option><option value="income">收入</option><option value="transfer">转账</option></select>
            </label>
            <label class="fin-field"><span>金额(元)</span><input v-model="form.amount" class="fin-amount" inputmode="decimal" placeholder="0.00" /></label>
            <label v-if="form.kind !== 'transfer'" class="fin-field"><span>分类</span>
              <select v-model="form.category"><option v-for="c in (form.kind === 'income' ? incomeCats : expenseCats)" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            </label>
            <label class="fin-field"><span>{{ form.kind === 'transfer' ? '转出账户' : '账户' }}</span>
              <select v-model="form.account"><option v-for="a in (board?.accounts || [])" :key="a.id" :value="a.id">{{ a.name }}</option></select>
            </label>
            <label v-if="form.kind === 'transfer'" class="fin-field"><span>转入账户</span>
              <select v-model="form.toAccount"><option v-for="a in (board?.accounts || [])" :key="a.id" :value="a.id">{{ a.name }}</option></select>
            </label>
            <label class="fin-field"><span>交易对方</span><input v-model="form.payee" placeholder="可选" /></label>
            <label class="fin-field fin-field-wide"><span>备注</span><input v-model="form.note" placeholder="可选，规则会看这栏" /></label>
          </div>
          <div class="fin-actions">
            <button class="fin-primary" :disabled="busy" @click="addEntry">记一笔</button>
            <button class="fin-secondary" @click="exportCsv">导出账本 CSV</button>
            <span class="fin-hint">金额以「分」整数入库，元只在显示时出现</span>
          </div>
        </div>
        <div class="fin-card" data-card="money-link">
          <h2 class="fin-h2">手记收支 · 九格「金钱收支」格</h2>
          <p class="fin-hint">只读汇总：九格按天记的收支在这里看得见，导入后才计入账本净资产；不会改写九格日记。</p>
          <div class="fin-actions">
            <span class="fin-hint">{{ month }} 共 {{ moneyMonthRows.length }} 笔 · 待导入 {{ moneyPending.length }} 笔</span>
            <button class="fin-secondary" :disabled="!moneyPending.length" @click="importAllMoney">导入本月待导入</button>
          </div>
          <div v-if="!moneyMonthRows.length" class="fin-empty">本月九格里还没有记收支。</div>
          <div v-for="r in moneyMonthRows.slice(0, 8)" :key="r.importedId" class="fw-money-row">
            <span class="fin-row-date">{{ r.date.slice(5) }}</span>
            <span class="fin-row-kind" :data-kind="r.type">{{ r.type === 'income' ? '收入' : '支出' }}</span>
            <span class="fin-row-main">{{ r.note || r.category || '—' }}</span>
            <span class="fin-row-amt" :class="{ 'fin-pos': r.type === 'income' }">{{ yuan(r.type === 'income' ? r.cents : -r.cents) }}</span>
            <span v-if="r.imported" class="fw-tag">已导入</span>
            <button v-else class="fin-mini" @click="importMoney([r])">导入到账本</button>
          </div>
          <p v-if="moneyMonthRows.length > 8" class="fin-hint">只显示最近 8 笔；「导入本月待导入」会处理全部。</p>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">检索与批量修正</h2>
          <div class="fin-form">
            <label class="fin-field"><span>关键字</span><input v-model="filter.keyword" placeholder="对方 / 备注" /></label>
            <label class="fin-field"><span>分类</span><select v-model="filter.category"><option value="">全部</option><option v-for="c in (board?.categories || [])" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
            <label class="fin-field"><span>账户</span><select v-model="filter.account"><option value="">全部</option><option v-for="a in (board?.accounts || [])" :key="a.id" :value="a.id">{{ a.name }}</option></select></label>
            <label class="fin-field"><span>类型</span><select v-model="filter.kind"><option value="">全部</option><option value="expense">支出</option><option value="income">收入</option><option value="transfer">转账</option></select></label>
            <label class="fin-field"><span>起始日</span><input v-model="filter.from" type="date" /></label>
            <label class="fin-field"><span>截止日</span><input v-model="filter.to" type="date" /></label>
            <label class="fin-field"><span>金额≥(元)</span><input v-model="filter.min" inputmode="decimal" placeholder="0" /></label>
            <label class="fin-field"><span>金额≤(元)</span><input v-model="filter.max" inputmode="decimal" placeholder="不限" /></label>
            <button class="fin-secondary" @click="runSearch">检索</button>
          </div>
          <div class="fin-actions">
            <select v-model="bulkCat" class="fw-inline-select"><option value="">改为分类…</option><option v-for="c in (board?.categories || [])" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            <button class="fin-secondary" @click="applyBulk">批量应用（已选 {{ bulkIds.length }} 笔）</button>
            <span class="fin-hint">批量修正是显式决定，不重跑自动分类规则</span>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">{{ searchRows.length ? '检索结果' : month + ' 流水' }}（{{ flowRows.length }} 条）</h2>
          <div v-if="!flowRows.length" class="fin-empty">没有匹配的流水。</div>
          <div v-for="t in flowRows" :key="t.id" class="fin-row" @click="selected = t">
            <input type="checkbox" class="fw-check" :checked="bulkIds.indexOf(t.id) >= 0" :aria-label="'选择 ' + t.date + ' 这一笔'" @click.stop @change="onBulkChange($event, t.id)" />
            <span class="fin-row-date">{{ t.date }}</span>
            <span class="fin-row-kind" :data-kind="t.kind">{{ kindLabel(t.kind) }}</span>
            <span class="fin-row-main">{{ t.payee || t.note || '—' }}</span>
            <span class="fin-row-cat">{{ t.kind === 'transfer' ? accName(t.account) + ' → 转账' : catName(t.category) }}</span>
            <span class="fin-row-amt" :class="{ 'fin-pos': t.amountCents > 0 }">{{ yuan(t.amountCents) }}</span>
            <span v-if="t.ruleIds.length" class="fin-rule-hit" title="由自动分类规则命中">规则</span>
            <button class="fin-del" :aria-label="'删除 ' + t.date + ' 这一笔'" @click.stop="removeEntry(t.id)">×</button>
          </div>
        </div>
      </div>

      <!-- ---------- 预算 ---------- -->
      <div v-else-if="tab === 'budget'" class="fw-pane" data-pane="budget">
        <div class="fin-card">
          <h2 class="fin-h2">设置 {{ month }} 的信封额度</h2>
          <p class="fin-hint-block">信封制：本月可用 = 额度 + 上月结转 − 本月已花。结转可以关，关掉就等于每月重新开始。没设额度的分类只显示「有支出」，不算超支。</p>
          <div class="fin-form">
            <label class="fin-field"><span>分类</span><select v-model="budgetForm.category"><option value="">选择分类</option><option v-for="c in expenseCats" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
            <label class="fin-field"><span>额度(元)</span><input v-model="budgetForm.limit" inputmode="decimal" placeholder="0.00" /></label>
            <label class="fin-check"><input v-model="budgetForm.rollover" type="checkbox" /> 余额结转下月</label>
          </div>
          <button class="fin-primary" @click="saveBudget">保存额度</button>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">本月信封（{{ board?.budgets.length || 0 }}）</h2>
          <div v-if="!(board?.budgets || []).length" class="fin-empty">还没有可显示的信封。</div>
          <div v-for="b in (board?.budgets || [])" :key="b.category" class="fin-budget">
            <div class="fin-budget-top">
              <b>{{ b.name }}</b>
              <span v-if="!b.configured" class="fw-tag">未设额度</span>
              <span v-else>{{ yuan(b.spentCents) }} / {{ yuan(b.limitCents + b.carryInCents) }}</span>
              <span v-if="b.configured" :class="{ 'fin-neg': b.remainingCents < 0 }">剩 {{ yuan(b.remainingCents) }}</span>
              <button class="fin-mini" @click="editBudget(b)">改</button>
              <button class="fin-mini" @click="clearBudget(b)">清零</button>
            </div>
            <div v-if="b.configured" class="fin-progress"><div :class="{ 'fin-over': b.usedBp > 10000 }" :style="{ width: Math.min(100, Math.round(b.usedBp / 100)) + '%' }"></div></div>
            <div class="fin-budget-foot">
              <span v-if="b.carryInCents">上月结转 {{ yuan(b.carryInCents) }}</span>
              <span v-if="!b.rollover">不结转</span>
            </div>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">分类管理</h2>
          <div class="fin-form">
            <label class="fin-field"><span>新分类</span><input v-model="newCat.name" placeholder="如：宠物" /></label>
            <label class="fin-field"><span>分组</span><input v-model="newCat.group" placeholder="日常 / 固定" /></label>
            <label class="fin-field"><span>类型</span><select v-model="newCat.kind"><option value="expense">支出</option><option value="income">收入</option></select></label>
            <button class="fin-secondary" @click="addCat">加分类</button>
          </div>
          <div class="fin-chips">
            <span v-for="c in (board?.categories || [])" :key="c.id" class="fin-chip">{{ c.name }}
              <button :aria-label="'删除分类 ' + c.name" @click="removeCat(c.id)">×</button>
            </span>
          </div>
        </div>
      </div>

      <!-- ---------- 账户 ---------- -->
      <div v-else-if="tab === 'accounts'" class="fw-pane" data-pane="accounts">
        <div class="fin-card">
          <h2 class="fin-h2">资产负债表 · {{ month }}</h2>
          <p class="fin-hint-block">余额 = 期初净值贡献 + 该账户所有流水之和；资产为正、欠款为负，净资产 = 所有账户余额相加。转账两条互指、金额相消，不会被重复计入。</p>
          <div class="fw-kpis fw-kpis-3">
            <div class="fw-kpi"><span>资产</span><b class="fin-pos">{{ yuan(worth?.assetsCents || 0) }}</b></div>
            <div class="fw-kpi"><span>负债</span><b>{{ yuan(worth?.liabilitiesCents || 0) }}</b></div>
            <div class="fw-kpi"><span>净资产</span><b :class="{ 'fin-neg': (worth?.netCents || 0) < 0 }">{{ yuan(worth?.netCents || 0) }}</b></div>
          </div>
          <div class="fw-mini-chart" aria-label="近六个月净资产">
            <div v-for="p in (worth?.series || [])" :key="p.month" class="fw-mini-col" :title="p.month + ' ' + yuan(p.netCents)">
              <span class="fw-mini-label">{{ p.month.slice(5) }}</span>
            </div>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">账户（{{ worth?.accounts.length || 0 }}）</h2>
          <div v-if="!(worth?.accounts || []).length" class="fin-empty">还没有账户。</div>
          <div v-for="a in (worth?.accounts || [])" :key="a.id" class="fw-acc-row">
            <div class="fw-acc-head">
              <b>{{ a.name }}</b>
              <span class="fw-tag">{{ ACC_LABEL[a.kind] || a.kind }}</span>
              <button class="fw-tag fw-tag-btn" @click="toggleSide(a)">{{ a.side === 'liability' ? '负债' : '资产' }}</button>
              <span class="fw-acc-bal" :class="{ 'fin-neg': a.balanceCents < 0 }">{{ yuan(a.balanceCents) }}</span>
            </div>
            <div class="fw-acc-foot">
              <span>期初 {{ yuan(a.openingCents) }}</span>
              <span>流水净额 {{ yuan(a.flowCents) }}</span>
              <span>{{ a.txnCount }} 笔</span>
              <input v-model="accEdit[a.id]" class="fw-inline-input" inputmode="decimal" placeholder="改期初(元)" />
              <button class="fin-mini" @click="saveOpening(a)">保存期初</button>
              <button class="fin-del" :aria-label="'删除账户 ' + a.name" @click="removeAcc(a.id)">×</button>
            </div>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">新增账户</h2>
          <div class="fin-form">
            <label class="fin-field"><span>名称</span><input v-model="newAcc.name" placeholder="如：招行卡 / 房贷" /></label>
            <label class="fin-field"><span>类型</span>
              <select v-model="newAcc.kind"><option v-for="k in (meta?.accountKinds || [])" :key="k" :value="k">{{ ACC_LABEL[k] || k }}</option></select>
            </label>
            <button class="fin-secondary" @click="addAcc">加账户</button>
          </div>
          <p class="fin-hint-block">信用卡 / 贷款 / 其他负债会自动归到「负债」侧；仍可在列表里手动切换。</p>
        </div>
      </div>

      <!-- ---------- 报表 ---------- -->
      <div v-else-if="tab === 'reports'" class="fw-pane" data-pane="reports">
        <div class="fin-card">
          <h2 class="fin-h2">损益表 · {{ month }}</h2>
          <div class="fw-kpis fw-kpis-3">
            <div class="fw-kpi"><span>收入</span><b class="fin-pos">{{ yuan(flowData?.incomeCents || 0) }}</b><small>{{ bp(flowData?.incomeDeltaBp || 0) }} 环比</small></div>
            <div class="fw-kpi"><span>支出</span><b>{{ yuan(flowData?.expenseCents || 0) }}</b><small>{{ bp(flowData?.expenseDeltaBp || 0) }} 环比</small></div>
            <div class="fw-kpi"><span>净流量</span><b :class="{ 'fin-neg': (flowData?.netCents || 0) < 0 }">{{ yuan(flowData?.netCents || 0) }}</b><small>储蓄率 {{ (flowData?.savingBp || 0) / 100 }}%</small></div>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">近 6 个月现金流</h2>
          <div class="fw-table">
            <div class="fw-tr fw-th"><span>月份</span><span>收入</span><span>支出</span><span>净流量</span></div>
            <div v-for="m in (flowData?.months || [])" :key="m.month" class="fw-tr">
              <span>{{ m.month }}</span><span class="fin-pos">{{ yuan(m.incomeCents) }}</span>
              <span>{{ yuan(m.expenseCents) }}</span>
              <span :class="{ 'fin-neg': m.netCents < 0 }">{{ yuan(m.netCents) }}</span>
            </div>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">分类环比（对比 {{ catReport?.prevMonth || '上月' }}）</h2>
          <div v-if="!(catReport?.rows || []).length" class="fin-empty">本月和上月都没有支出分类数据。</div>
          <div class="fw-table">
            <div class="fw-tr fw-th"><span>分类</span><span>本月</span><span>上月</span><span>变化</span><span>占比</span></div>
            <div v-for="r in (catReport?.rows || [])" :key="r.category" class="fw-tr">
              <span>{{ r.name }}</span><span>{{ yuan(r.spentCents) }}</span><span>{{ yuan(r.prevCents) }}</span>
              <span :class="{ 'fin-neg': r.deltaCents > 0 }">{{ r.deltaCents > 0 ? '+' : '' }}{{ yuan(r.deltaCents) }}</span>
              <span>{{ r.shareBp / 100 }}% · {{ r.txnCount }} 笔</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ---------- 目标 ---------- -->
      <div v-else-if="tab === 'goals'" class="fw-pane" data-pane="goals">
        <div class="fin-card">
          <h2 class="fin-h2">新建储蓄目标</h2>
          <div class="fin-form">
            <label class="fin-field"><span>名称</span><input v-model="goalForm.name" placeholder="如：应急基金" /></label>
            <label class="fin-field"><span>目标额(元)</span><input v-model="goalForm.target" inputmode="decimal" placeholder="0.00" /></label>
            <label class="fin-field"><span>已存(元)</span><input v-model="goalForm.saved" inputmode="decimal" placeholder="0.00" /></label>
            <label class="fin-field"><span>目标月份</span><input v-model="goalForm.month" type="month" /></label>
            <button class="fin-primary" @click="addGoal">建立目标</button>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">目标进度（{{ allGoals.length }}）</h2>
          <p class="fin-hint">梦想账户已并入本页：带「梦想账户」标签的目标来自梦想板块，在这里存钱会写回 md_dream，不会复制出第二份余额。</p>
          <div v-if="!allGoals.length" class="fin-empty">还没有目标。先定一个应急基金，或在梦想板块给梦想定价。</div>
          <div v-for="g in allGoals" :key="g.id" class="fw-goal">
            <div class="fin-budget-top">
              <b>{{ g.name }}</b>
              <span v-if="g.source === 'dream'" class="fw-tag">梦想账户</span>
              <span>{{ yuan(g.savedCents) }} / {{ yuan(g.targetCents) }}</span>
              <span :class="{ 'fin-pos': g.reached }">{{ g.reached ? '已达成' : '还差 ' + yuan(g.remainingCents) }}</span>
              <span v-if="g.month" class="fw-tag">{{ g.month }}</span>
              <button v-if="g.source === 'local'" class="fin-del" :aria-label="'删除目标 ' + g.name" @click="removeGoal(g.id)">×</button>
            </div>
            <div class="fin-progress"><div :class="{ 'fin-over': g.progressBp > 10000 }" :style="{ width: Math.min(100, Math.round(g.progressBp / 100)) + '%' }"></div></div>
            <div class="fin-actions">
              <input v-model="savingInput[g.id]" class="fw-inline-input" inputmode="decimal" placeholder="本次存入(元)" />
              <button class="fin-mini" @click="addSaving(g)">{{ g.source === 'dream' ? '存入梦想账户' : '记一笔存款' }}</button>
              <span class="fin-hint">{{ g.progressBp / 100 }}%</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ---------- 周期与订阅 ---------- -->
      <div v-else-if="tab === 'recurring'" class="fw-pane" data-pane="recurring">
        <div class="fin-card">
          <h2 class="fin-h2">{{ month }} 到期清单</h2>
          <p class="fin-hint-block">周期账单只给建议，绝不自动写流水；点「记入」才落库。已记过（同月、同对方、同金额）的会标出来。</p>
          <div v-if="!dueRows.length" class="fin-empty">本月没有到期账单。</div>
          <div v-for="r in dueRows" :key="r.id" class="fin-row">
            <span class="fin-row-date">{{ r.date }}</span>
            <span class="fin-row-main">{{ r.name }}<small class="fw-dim"> · {{ INTERVAL_LABEL[r.interval] || r.interval }}</small></span>
            <span class="fin-row-amt">{{ yuan(r.amountCents) }}</span>
            <span v-if="r.recorded" class="fw-tag">已记</span>
            <button v-else class="fin-mini" @click="postDue(r)">记入</button>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">自动识别的订阅（{{ subscriptions.length }}）</h2>
          <p class="fin-hint-block">离线启发式：同一交易对方至少 2 笔、金额落在中位数 ±5%、且至少一对落在相邻月份。只是候选，确认后可一键建为周期账单。</p>
          <div v-if="!subscriptions.length" class="fin-empty">还没从流水里识别出周期性扣款。</div>
          <div v-for="s in subscriptions" :key="s.payee" class="fin-row">
            <span class="fin-row-main">{{ s.payee }}</span>
            <span class="fin-row-cat">{{ s.count }} 笔 · 最近 {{ s.lastDate }}</span>
            <span class="fin-row-amt">{{ yuan(s.typicalCents) }}</span>
            <button class="fin-mini" @click="subToRecurring(s)">建为账单</button>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">新增周期账单</h2>
          <div class="fin-form">
            <label class="fin-field"><span>名称</span><input v-model="recForm.name" placeholder="如：房租" /></label>
            <label class="fin-field"><span>对方</span><input v-model="recForm.payee" placeholder="可选" /></label>
            <label class="fin-field"><span>金额(元)</span><input v-model="recForm.amount" inputmode="decimal" placeholder="0.00" /></label>
            <label class="fin-field"><span>分类</span><select v-model="recForm.category"><option v-for="c in expenseCats" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
            <label class="fin-field"><span>账户</span><select v-model="recForm.account"><option v-for="a in (board?.accounts || [])" :key="a.id" :value="a.id">{{ a.name }}</option></select></label>
            <label class="fin-field"><span>起始日</span><input v-model="recForm.startDate" type="date" /></label>
            <label class="fin-field"><span>周期</span><select v-model="recForm.interval"><option value="monthly">每月</option><option value="quarterly">每季</option><option value="yearly">每年</option></select></label>
            <label class="fin-field"><span>结束方式</span><select v-model="recForm.endMode"><option value="never">不设结束</option><option value="date">指定日期</option></select></label>
            <label v-if="recForm.endMode === 'date'" class="fin-field"><span>结束日</span><input v-model="recForm.endDate" type="date" /></label>
            <button class="fin-primary" @click="addRecurring">保存</button>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">已有账单（{{ recurringItems.length }}）</h2>
          <div v-if="!recurringItems.length" class="fin-empty">还没有周期账单。</div>
          <div v-for="r in recurringItems" :key="r.id" class="fin-row">
            <span class="fin-row-main">{{ r.name }}</span>
            <span class="fin-row-cat">{{ INTERVAL_LABEL[r.interval] || r.interval }} · {{ r.startDate }}</span>
            <span class="fin-row-amt">{{ yuan(r.amountCents) }}</span>
            <button class="fin-mini" @click="toggleRecurring(r)">{{ r.enabled ? '停用' : '启用' }}</button>
            <button class="fin-del" :aria-label="'删除账单 ' + r.name" @click="removeRecurring(r.id)">×</button>
          </div>
        </div>
      </div>

      <!-- ---------- 规则 ---------- -->
      <div v-else-if="tab === 'rules'" class="fw-pane" data-pane="rules">
        <div class="fin-card">
          <h2 class="fin-h2">新增规则（条件 → 动作）</h2>
          <p class="fin-hint-block">按优先级从小到大依次执行，后面的规则看得到前面改过的值；勾选「命中后停止」可实现首条命中即止。记一笔和 CSV 导入都会自动过一遍。金额条件的单位是「分」。</p>
          <div class="fin-form">
            <label class="fin-field"><span>规则名</span><input v-model="ruleDraft.name" placeholder="如：便利店 → 餐饮" /></label>
            <label class="fin-field"><span>优先级</span><input v-model.number="ruleDraft.priority" type="number" min="0" max="9999" /></label>
            <label class="fin-field"><span>条件关系</span><select v-model="ruleDraft.match"><option value="all">全部满足</option><option value="any">任一满足</option></select></label>
            <label class="fin-check"><input v-model="ruleDraft.stop" type="checkbox" /> 命中后停止</label>
          </div>
          <div v-for="(c, i) in ruleDraft.conditions" :key="'c' + i" class="fin-rule-line">
            <select v-model="c.field"><option v-for="f in (meta?.conditionFields || [])" :key="f" :value="f">{{ FIELD_LABEL[f] || f }}</option></select>
            <select v-model="c.op"><option v-for="o in (meta?.conditionOps || [])" :key="o" :value="o">{{ OP_LABEL[o] || o }}</option></select>
            <input v-model="c.value" placeholder="关键字 / 数值" />
            <button class="fin-mini" aria-label="删除条件" @click="ruleDraft.conditions.splice(i, 1)">×</button>
          </div>
          <button class="fin-secondary" @click="ruleDraft.conditions.push({ field: 'note', op: 'contains', value: '' })">＋ 加条件</button>
          <div v-for="(a, i) in ruleDraft.actions" :key="'a' + i" class="fin-rule-line">
            <select v-model="a.type"><option v-for="t in (meta?.actionTypes || [])" :key="t" :value="t">{{ ACT_LABEL[t] || t }}</option></select>
            <input v-model="a.value" placeholder="目标分类 id / 文本" />
            <button class="fin-mini" aria-label="删除动作" @click="ruleDraft.actions.splice(i, 1)">×</button>
          </div>
          <button class="fin-secondary" @click="ruleDraft.actions.push({ type: 'setCategory', value: '' })">＋ 加动作</button>
          <div class="fin-actions"><button class="fin-primary" @click="saveRule">保存规则</button></div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">已有规则（{{ board?.rules.length || 0 }}）</h2>
          <div v-if="!(board?.rules || []).length" class="fin-empty">还没有规则。导入账单后，把重复出现的商户写成一条规则。</div>
          <div v-for="r in (board?.rules || [])" :key="r.id" class="fin-rule-row">
            <span class="fin-pri">P{{ r.priority }}</span>
            <b>{{ r.name }}</b>
            <span class="fin-rule-desc">
              {{ r.conditions.map((c) => (FIELD_LABEL[c.field] || c.field) + ' ' + (OP_LABEL[c.op] || c.op) + ' ' + c.value).join(' 且 ') }}
              → {{ r.actions.map((a) => (ACT_LABEL[a.type] || a.type) + ' ' + a.value).join('，') }}
            </span>
            <button class="fin-mini" @click="toggleRule(r)">{{ r.enabled ? '停用' : '启用' }}</button>
            <button class="fin-del" :aria-label="'删除规则 ' + r.name" @click="removeRule(r.id)">×</button>
          </div>
        </div>
      </div>

      <!-- ---------- 导入 ---------- -->
      <div v-else class="fw-pane" data-pane="import">
        <div class="fin-card">
          <h2 class="fin-h2">导入账单 CSV</h2>
          <p class="fin-hint-block">
            支持支付宝（GBK）、微信（UTF-8 BOM）、UTF-16LE 和带「日期 / 金额」两列的通用 CSV。
            表头按列关键字定位，前面几行说明文字会自动跳过；退款、失败、不计收支的行自动排除。
            同一份文件重复导入不会产生重复流水（按订单号 + 日期 + 金额 + 对方生成指纹去重）。
            导入的每一笔都会立刻过一遍自动分类规则。
          </p>
          <label class="fin-file">
            <input type="file" accept=".csv,text/csv" :disabled="importing" @change="onFile" />
            <span>{{ importing ? '正在导入…' : '选择 CSV 文件' }}</span>
          </label>
          <div v-if="importReport" class="fin-report" role="status">
            <p><b>结果</b>：新增 {{ importReport.added }} 条 · 跳过 {{ importReport.skipped }} 条 · 重复 {{ importReport.duplicates }} 条 · 共扫描 {{ importReport.total }} 行</p>
            <p>识别：{{ importReport.platform }} / {{ importReport.encoding }} / 表头第 {{ importReport.headerLine }} 行</p>
            <p v-for="(e, i) in importReport.errors" :key="i" class="fin-err">{{ e }}</p>
          </div>
        </div>
        <div class="fin-card">
          <h2 class="fin-h2">功能边界（本机口径）</h2>
          <ul class="fin-list">
            <li><b>做</b>：信封预算、资产负债表、损益表、分类环比、储蓄目标、周期账单、订阅识别、条件→动作自动分类、CSV 导入去重、批量修正、跨月检索。</li>
            <li><b>不做</b>：家庭共享 / 账号 / 云同步 / 银行自动同步 / 行情与汇率 / AI 助手。这些要么违反纯本地约定，要么需要联网取数。</li>
            <li>金额全程整数分，展示层才转成元；转账是两条互指的流水，不计入支出统计。</li>
            <li>功能骨架参考 maybe 的账户与报表分层；该项目为 AGPL-3.0 且已停更，本窗口只取设计口径，未使用其代码。</li>
          </ul>
        </div>
      </div>
    </main>
    <div class="col-divider" role="separator" aria-label="拖动调整右栏宽度" tabindex="0"
         @pointerdown="startDrag('rail', $event)" @pointermove="onDrag" @pointerup="endDrag"
         @pointercancel="endDrag" @dblclick="resetLayout"
         @keydown.left.prevent="nudge('rail', 16)" @keydown.right.prevent="nudge('rail', -16)"></div>

    <!-- ==================== 右栏 ==================== -->
    <aside class="fw-right">
      <h2 class="fw-right-title">本月速览</h2>
      <div class="fw-summary">
        <div><span>收入</span><b class="fin-pos">{{ yuan(totals.incomeCents) }}</b></div>
        <div><span>支出</span><b>{{ yuan(totals.expenseCents) }}</b></div>
        <div><span>结余</span><b :class="{ 'fin-neg': totals.netCents < 0 }">{{ yuan(totals.netCents) }}</b></div>
        <div><span>预算剩余</span><b :class="{ 'fin-neg': totals.budgetRemainingCents < 0 }">{{ yuan(totals.budgetRemainingCents) }}</b></div>
        <div><span>手记待导入</span><b>{{ moneyPending.length }} 笔</b></div>
      </div>
      <h2 class="fw-right-title">洞察</h2>
      <div class="fw-insight">
        <p><span>储蓄率</span><b>{{ (insights?.savingBp || 0) / 100 }}%</b></p>
        <p><span>预算已用</span><b>{{ (insights?.budgetUsedBp || 0) / 100 }}%</b></p>
        <p><span>净资产</span><b>{{ yuan(insights?.netWorthCents || 0) }}</b></p>
        <p><span>订阅月支出</span><b>{{ yuan(insights?.subscriptionCents || 0) }}<small> · {{ insights?.subscriptionCount || 0 }} 项</small></b></p>
        <p v-if="insights?.topCategory"><span>最大支出分类</span><b>{{ insights.topCategory.name }} · {{ yuan(insights.topCategory.spentCents) }}</b></p>
        <p v-if="insights?.biggest"><span>最大单笔</span><b>{{ insights.biggest.payee || insights.biggest.date }} · {{ yuan(insights.biggest.amountCents) }}</b></p>
        <p><span>规则命中 / 导入</span><b>{{ insights?.ruleHit || 0 }} / {{ insights?.imported || 0 }}</b></p>
      </div>
      <div v-if="(insights?.overspent || []).length" class="fw-warn">
        <b>超支信封</b>
        <p v-for="o in (insights?.overspent || [])" :key="o.name">{{ o.name }} 超 {{ yuan(o.overCents) }}</p>
      </div>
      <h2 class="fw-right-title">最近 5 笔</h2>
      <div class="fw-recent">
        <div v-for="t in (board?.txns || []).slice(0, 5)" :key="t.id" class="fw-recent-row" @click="selected = t">
          <span>{{ t.date.slice(5) }}</span>
          <span class="fw-recent-main">{{ t.payee || t.note || '—' }}</span>
          <b :class="{ 'fin-pos': t.amountCents > 0 }">{{ yuan(t.amountCents) }}</b>
        </div>
        <p v-if="!(board?.txns || []).length" class="fin-empty">暂无流水</p>
      </div>
      <div v-if="selected" class="fw-detail">
        <h2 class="fw-right-title">选中流水 <button class="fin-mini" @click="selected = null">收起</button></h2>
        <p><span>日期</span>{{ selected.date }}</p>
        <p><span>类型</span>{{ kindLabel(selected.kind) }}</p>
        <p><span>金额</span>{{ yuan(selected.amountCents) }}</p>
        <p><span>分类</span>{{ catName(selected.category) }}</p>
        <p><span>账户</span>{{ accName(selected.account) }}</p>
        <p><span>对方</span>{{ selected.payee || '—' }}</p>
        <p><span>备注</span>{{ selected.note || '—' }}</p>
        <p v-if="selected.ruleIds.length"><span>命中规则</span>{{ selected.ruleIds.join('，') }}</p>
        <p v-if="selected.importedId"><span>导入指纹</span>{{ selected.importedId.slice(0, 16) }}…</p>
      </div>
    </aside>
  </section>
</template>

<style scoped>
.fw-app {
  display: flex;
  height: 100vh;
  box-sizing: border-box;
  background: var(--surface-bg);
  color: var(--surface-text);
  font-family: var(--font-sans);
}
.fw-left, .fw-main, .fw-right { overflow-y: auto; height: 100%; box-sizing: border-box; }
.fw-left { flex: 0 0 auto; width: var(--nav-w, 240px); min-width: 0; border-right: 1px solid var(--surface-border); padding: var(--space-3); background: var(--surface-panel); }
.fw-main { flex: 1 1 auto; min-width: 0; padding: var(--space-4); }
.fw-right { flex: 0 0 auto; width: var(--rail-w, 300px); min-width: 0; border-left: 1px solid var(--surface-border); padding: var(--space-3); background: var(--surface-panel); }
/* 与主窗同款栏宽手柄：命中区 6px，视觉只在 hover / 聚焦 / 拖动时给 2px 高亮 */
.col-divider {
  flex: 0 0 6px; position: relative; cursor: col-resize;
  background: transparent; outline: none;
}
.col-divider::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 2px; right: 2px;
  border-radius: 2px; background: transparent; transition: background 0.12s;
}
.col-divider:hover::after, .col-divider:focus-visible::after { background: var(--palette-border); }
.col-dragging { user-select: none; }
.col-dragging .col-divider::after { background: var(--palette-primary); }
.fw-money-row {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  padding: 7px 0; border-top: 1px solid var(--surface-border); font-size: 12px;
}
.fw-money-row .fin-row-main { flex: 1 1 auto; min-width: 90px; }
@media (max-width: 1024px) {
  .col-divider { display: none; }
  .fw-left { width: 64px; }
  .fw-right { display: none; }
  .fw-main { padding: var(--space-2); }
}
.fw-brand h1 { margin: 0; font-size: 19px; }
.fw-brand p { margin: 3px 0 12px; font-size: 11px; color: var(--surface-muted); }
.fw-month { display: inline-flex; gap: 8px; align-items: center; font-size: 13px; font-weight: 600; }
.fw-month span { min-width: 70px; text-align: center; }
.fw-worth {
  margin: 14px 0; padding: 12px; border: 1px solid var(--surface-border);
  border-radius: var(--radius-lg); background: var(--surface-raised);
  display: flex; flex-direction: column; gap: 4px;
}
.fw-worth-label { font-size: 11px; color: var(--surface-muted); }
.fw-worth b { font-size: 20px; font-variant-numeric: tabular-nums; }
.fw-worth-split { display: flex; justify-content: space-between; font-size: 10px; color: var(--surface-muted); margin-top: 4px; }
.fw-nav { display: flex; flex-direction: column; gap: 3px; }
.fw-nav-item {
  text-align: left; border: 1px solid transparent; border-radius: var(--radius-md);
  background: transparent; color: var(--surface-text); padding: 7px 10px;
  cursor: pointer; font-size: 12px;
}
.fw-nav-item:hover { background: var(--surface-raised); }
.fw-nav-on { background: var(--palette-primary); color: var(--palette-on); }
.fw-left-foot { margin-top: 18px; font-size: 10px; line-height: 1.7; color: var(--surface-muted); }
.fw-left-foot code { background: var(--surface-raised); padding: 1px 3px; border-radius: var(--radius-sm); }
.fw-pane { display: grid; gap: var(--space-2); }
.fw-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.fw-kpis-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.fw-kpi {
  border: 1px solid var(--surface-border); border-radius: var(--radius-lg);
  background: var(--surface-panel); padding: 12px; display: flex; flex-direction: column; gap: 3px;
}
.fw-kpi span { font-size: 11px; color: var(--surface-muted); }
.fw-kpi b { font-size: 17px; font-variant-numeric: tabular-nums; }
.fw-kpi small { font-size: 10px; color: var(--surface-muted); }
.fw-mini-chart { display: flex; gap: 6px; margin-top: 12px; height: 34px; align-items: flex-end; }
.fw-mini-col { flex: 1; height: 12px; background: var(--palette-soft); border-radius: 3px; position: relative; }
.fw-mini-label { position: absolute; bottom: -14px; left: 0; right: 0; text-align: center; font-size: 9px; color: var(--surface-muted); }
.fw-table { display: flex; flex-direction: column; font-size: 12px; }
.fw-tr { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1fr 1fr; gap: 8px; padding: 7px 0; border-top: 1px solid var(--surface-border); }
.fw-tr span:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.fw-th { color: var(--surface-muted); font-size: 11px; border-top: 0; }
.fw-acc-row, .fw-goal { padding: 10px 0; border-top: 1px solid var(--surface-border); }
.fw-acc-head, .fw-acc-foot { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; font-size: 12px; }
.fw-acc-foot { margin-top: 6px; color: var(--surface-muted); font-size: 11px; }
.fw-acc-bal { margin-left: auto; font-size: 15px; font-variant-numeric: tabular-nums; }
.fw-tag {
  font-size: 10px; padding: 1px 6px; border: 1px solid var(--palette-border);
  border-radius: 999px; color: var(--surface-muted);
}
.fw-tag-btn { background: var(--surface-raised); cursor: pointer; }
.fw-dim { color: var(--surface-muted); font-size: 10px; }
.fw-inline-input, .fw-inline-select {
  border: 1px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); color: var(--surface-text);
  padding: 4px 7px; font-size: 11px; min-width: 96px;
}
.fw-check { width: 14px; height: 14px; }
.fw-right-title { font-size: 12px; margin: 14px 0 8px; color: var(--surface-muted); font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
.fw-right-title:first-child { margin-top: 0; }
.fw-summary { display: grid; gap: 6px; }
.fw-summary > div { display: flex; justify-content: space-between; font-size: 12px; }
.fw-summary span { color: var(--surface-muted); }
.fw-summary b { font-variant-numeric: tabular-nums; }
.fw-insight p, .fw-detail p { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; margin: 6px 0; }
.fw-insight span, .fw-detail span { color: var(--surface-muted); }
.fw-insight b, .fw-detail p { font-variant-numeric: tabular-nums; }
.fw-insight small { color: var(--surface-muted); font-weight: 400; }
.fw-warn {
  margin-top: 10px; padding: 9px; border: 1px solid var(--state-warn);
  border-radius: var(--radius-md); font-size: 11px;
}
.fw-warn p { margin: 4px 0 0; color: var(--state-warn); }
.fw-recent-row { display: flex; gap: 6px; font-size: 11px; padding: 5px 0; border-top: 1px solid var(--surface-border); cursor: pointer; }
.fw-recent-row > span:first-child { color: var(--surface-muted); }
.fw-recent-main { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fw-detail { margin-top: 14px; padding-top: 8px; border-top: 1px solid var(--surface-border); }
.fw-detail p { word-break: break-all; }
.fin-view { padding: 0; }
.fin-mini, .fin-secondary, .fin-primary {
  border: 1px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); color: var(--surface-text); cursor: pointer;
  padding: 4px 10px; font-size: 12px;
}
.fin-title, .fin-sub, .fin-tabs, .fin-head { display: none; }
.fin-notice { font-size: 12px; color: var(--palette-primary); margin: 0 0 8px; }
.fin-hint, .fin-hint-block { color: var(--surface-muted); font-size: 11px; }
.fin-hint-block { line-height: 1.7; margin: 0 0 10px; }
.fin-card { background: var(--surface-panel); border: 1px solid var(--surface-border); border-radius: var(--radius-lg); padding: var(--space-3); }
.fin-h2 { font-size: 14px; margin: 0 0 10px; }
.fin-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.fin-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; min-width: 120px; }
.fin-field-wide { flex: 1; min-width: 220px; }
.fin-field input, .fin-field select, .fin-rule-line input, .fin-rule-line select {
  border: 1px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); color: var(--surface-text); padding: 5px 7px; font-size: 12px; min-width: 100px;
}
.fin-amount { font-variant-numeric: tabular-nums; }
.fin-check { font-size: 11px; display: inline-flex; gap: 5px; align-items: center; }
.fin-actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.fin-primary { background: var(--palette-primary); color: var(--palette-on); border-color: transparent; }
.fin-trend { display: flex; gap: 12px; height: 96px; align-items: flex-end; }
.fin-trend-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; }
.fin-trend-bars { display: flex; gap: 3px; align-items: flex-end; height: 78px; width: 100%; justify-content: center; }
.fin-bar { width: 14px; min-height: 2px; border-radius: 3px 3px 0 0; }
.fin-bar-in { background: var(--palette-primary); }
.fin-bar-out { background: var(--palette-accent); }
.fin-trend-label { font-size: 10px; color: var(--surface-muted); }
.fin-row { display: flex; gap: 9px; align-items: center; padding: 7px 0; border-top: 1px solid var(--surface-border); font-size: 12px; }
.fin-row-date { width: 86px; color: var(--surface-muted); }
.fin-row-kind { width: 36px; font-size: 10px; color: var(--surface-muted); }
.fin-row-main { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fin-row-cat { width: 110px; color: var(--surface-muted); }
.fin-row-amt { width: 100px; text-align: right; font-variant-numeric: tabular-nums; }
.fin-rule-hit { font-size: 10px; border: 1px solid var(--palette-border); border-radius: var(--radius-sm); padding: 1px 4px; }
.fin-del { border: 0; background: transparent; color: var(--surface-muted); cursor: pointer; font-size: 15px; }
.fin-budget { padding: 8px 0; border-top: 1px solid var(--surface-border); }
.fin-budget-top { display: flex; gap: 10px; align-items: center; font-size: 12px; flex-wrap: wrap; }
.fin-budget-top b { min-width: 84px; }
.fin-progress { height: 6px; background: var(--surface-muted); border-radius: 3px; margin: 6px 0 3px; overflow: hidden; }
.fin-progress > div { height: 100%; background: var(--palette-primary); }
.fin-progress > div.fin-over { background: var(--state-warn); }
.fin-budget-foot { display: flex; gap: 10px; font-size: 10px; color: var(--surface-muted); }
.fin-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.fin-chip { border: 1px solid var(--surface-border); border-radius: 999px; padding: 2px 8px; font-size: 11px; }
.fin-chip button { border: 0; background: transparent; cursor: pointer; color: var(--surface-muted); }
.fin-rule-line { display: flex; gap: 6px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
.fin-rule-row { display: flex; gap: 10px; align-items: center; border-top: 1px solid var(--surface-border); padding: 8px 0; font-size: 12px; flex-wrap: wrap; }
.fin-pri { color: var(--surface-muted); font-size: 10px; }
.fin-rule-desc { flex: 1; color: var(--surface-muted); min-width: 220px; }
.fin-file { display: inline-flex; align-items: center; gap: 8px; border: 1px dashed var(--surface-border); border-radius: var(--radius-md); padding: 12px 18px; cursor: pointer; font-size: 12px; }
.fin-report { margin-top: 12px; font-size: 12px; line-height: 1.7; }
.fin-err { color: var(--state-warn); }
.fin-empty { color: var(--surface-muted); font-size: 12px; padding: 14px 0; }
.fin-list { font-size: 12px; line-height: 1.9; padding-left: 18px; margin: 0; }
.fin-list code { background: var(--surface-raised); padding: 1px 4px; border-radius: var(--radius-sm); }
.fin-neg { color: var(--state-warn); }
.fin-pos { color: var(--palette-primary); }
@media (max-width: 1180px) {
  .fw-app { grid-template-columns: 190px minmax(0, 1fr); }
  .fw-right { display: none; }
  .fw-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
