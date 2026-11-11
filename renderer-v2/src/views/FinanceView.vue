<script setup lang="ts">
// 家庭账本：与「图书馆」同形态的子单元——顶栏入口、自己的 md_finance 单键、四个分区。
// 四条口径：管预算（信封制）/ 不做家庭共享 / 第一期就做 CSV 导入 / 金额全程整数分。
// 元只在这里出现：所有金额在领域层都是 cents 整数，yuan() 是唯一的展示出口。
// 类名一律 fin- 前缀：项目里 .cell / .heat-cell 都因撞名炸过真 GUI 断言。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { saveExport } from '../bridge';

interface Cat { id: string; name: string; group: string; kind: string; archived: boolean }
interface Acc { id: string; name: string; kind: string; archived: boolean }
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
  rollover: boolean; usedBp: number;
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
  kinds: string[]; accountKinds: string[]; conditionFields: string[];
  conditionOps: string[]; actionTypes: string[];
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

const props = defineProps<{ today: string }>();
const emit = defineEmits<{ (e: 'back'): void; (e: 'notify', text: string): void }>();

function currentMonth(): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(props.today)) return props.today.slice(0, 7);
  const d = new Date(), m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m));
}
const month = ref(currentMonth());
const tab = ref<'flow' | 'budget' | 'rules' | 'import'>('flow');
const board = ref<BoardData | null>(null);
const meta = ref<Meta | null>(null);
const busy = ref(false);
const notice = ref('');

// 「元 -> 分」同样走整数字符串，不经过浮点：0.1 + 0.2 的坑不进账本。
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
// 唯一的「分 -> 元」出口。
function yuan(c: number): string {
  const n = Math.trunc(Number(c) || 0), a = Math.abs(n);
  return (n < 0 ? '-' : '') + '¥' + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
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

async function load(): Promise<void> {
  const b = await callDomain<BoardData | null>('finance.board', null, month.value);
  board.value = b;
  if (!meta.value) meta.value = await callDomain<Meta | null>('finance.meta', null);
}
onMounted(() => { void load(); });
watch(month, () => { void load(); });

// ---- 记一笔 ----
const form = ref({
  date: props.today || '', kind: 'expense', amount: '', category: 'cat_food',
  account: 'acc_alipay', toAccount: 'acc_bank', payee: '', note: ''
});
const expenseCats = computed(() => (board.value?.categories || []).filter((c) => c.kind === 'expense' && !c.archived));
const incomeCats = computed(() => (board.value?.categories || []).filter((c) => c.kind === 'income' && !c.archived));

async function addEntry(): Promise<void> {
  const cents = parseYuan(form.value.amount);
  if (!form.value.date || !cents) { notice.value = '请填日期和金额'; return; }
  busy.value = true;
  await callDomain('finance.add', null, {
    date: form.value.date, kind: form.value.kind,
    amountCents: form.value.kind === 'income' ? Math.abs(cents) : -Math.abs(cents),
    category: form.value.kind === 'transfer' ? '' : form.value.category,
    account: form.value.account, toAccount: form.value.toAccount,
    payee: form.value.payee, note: form.value.note
  });
  form.value.amount = ''; form.value.payee = ''; form.value.note = '';
  notice.value = '已记一笔';
  await load();
  busy.value = false;
}
async function removeEntry(id: string): Promise<void> {
  await callDomain('finance.remove', null, id);
  await load();
}
async function exportCsv(): Promise<void> {
  const text = await callDomain<string>('finance.exportCsv', '');
  await saveExport('家庭账本-' + month.value + '.csv', text);
  emit('notify', '账本已导出 CSV');
}

// ---- 预算（信封制） ----
const budgetForm = ref({ category: '', limit: '', rollover: true });
async function saveBudget(): Promise<void> {
  if (!budgetForm.value.category) { notice.value = '先选一个分类'; return; }
  await callDomain('finance.setBudget', null, {
    month: month.value, category: budgetForm.value.category,
    limitCents: Math.abs(parseYuan(budgetForm.value.limit)),
    rollover: budgetForm.value.rollover
  });
  budgetForm.value.limit = '';
  notice.value = '预算已更新';
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

// ---- 条件 → 动作规则 ----
function blankRule(): RuleDraft {
  return {
    name: '', priority: 100, match: 'all', stop: true, enabled: true,
    conditions: [{ field: 'note', op: 'contains', value: '' }],
    actions: [{ type: 'setCategory', value: 'cat_food' }]
  };
}
const ruleDraft = ref<RuleDraft>(blankRule());
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
async function saveRule(): Promise<void> {
  if (!ruleDraft.value.name.trim()) { notice.value = '给规则起个名字'; return; }
  await callDomain('finance.addRule', null, {
    ...ruleDraft.value, name: ruleDraft.value.name.trim(),
    conditions: ruleDraft.value.conditions.filter((c) => c.value.trim() !== ''),
    actions: ruleDraft.value.actions.filter((a) => a.value.trim() !== '')
  });
  ruleDraft.value = blankRule();
  notice.value = '规则已加入，之后记一笔和 CSV 导入都会过它';
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
const report = ref<ImportReport | null>(null);
function toBase64(bytes: Uint8Array): string {
  let out = '';
  const CH = 8190; // 3 的倍数：分块编码后可直接拼接
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
  report.value = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const cap = meta.value?.limits.csvMaxBytes || 8388608;
    if (bytes.length > cap) {
      report.value = {
        platform: 'generic', encoding: 'unknown', headerLine: -1, total: 0,
        added: 0, skipped: 0, duplicates: 0, errors: ['文件超过 ' + Math.round(cap / 1048576) + ' MB 上限']
      };
    } else {
      const rep = await callDomain<ImportReport | null>('finance.importCsv', null, {
        data: toBase64(bytes), filename: file.name
      });
      report.value = rep;
      await load();
      emit('notify', rep ? ('导入完成：新增 ' + rep.added + ' 条，跳过 ' + rep.skipped + ' 条，重复 ' + rep.duplicates + ' 条') : '导入失败');
    }
  } catch (e) {
    report.value = {
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
  <section class="fin-view" aria-label="家庭账本">
    <header class="fin-head">
      <button class="fin-back" @click="emit('back')">← 返回九格</button>
      <h1 class="fin-title">家庭账本</h1>
      <p class="fin-sub">信封预算 · 条件→动作自动分类 · CSV 导入 · 数据只在本机</p>
      <div class="fin-month">
        <button class="fin-mini" aria-label="上个月" @click="shiftMonth(-1)">←</button>
        <span class="fin-month-label">{{ month }}</span>
        <button class="fin-mini" aria-label="下个月" @click="shiftMonth(1)">→</button>
      </div>
      <div class="fin-stats" aria-label="本月汇总">
        <span class="fin-stat">收入 <b>{{ yuan(totals.incomeCents) }}</b></span>
        <span class="fin-stat">支出 <b>{{ yuan(totals.expenseCents) }}</b></span>
        <span class="fin-stat">结余 <b :class="{ 'fin-neg': totals.netCents < 0 }">{{ yuan(totals.netCents) }}</b></span>
        <span class="fin-stat">预算剩余 <b :class="{ 'fin-neg': totals.budgetRemainingCents < 0 }">{{ yuan(totals.budgetRemainingCents) }}</b></span>
      </div>
    </header>

    <nav class="fin-tabs" aria-label="家庭账本分区">
      <button class="fin-tab" :class="{ 'fin-tab-on': tab === 'flow' }" :aria-pressed="tab === 'flow'" @click="tab = 'flow'">流水</button>
      <button class="fin-tab" :class="{ 'fin-tab-on': tab === 'budget' }" :aria-pressed="tab === 'budget'" @click="tab = 'budget'">预算</button>
      <button class="fin-tab" :class="{ 'fin-tab-on': tab === 'rules' }" :aria-pressed="tab === 'rules'" @click="tab = 'rules'">自动分类规则</button>
      <button class="fin-tab" :class="{ 'fin-tab-on': tab === 'import' }" :aria-pressed="tab === 'import'" @click="tab = 'import'">CSV 导入</button>
    </nav>

    <p v-if="notice" class="fin-notice" role="status">{{ notice }}</p>

    <!-- ============ 流水 ============ -->
    <div v-if="tab === 'flow'" class="fin-pane">
      <div class="fin-card">
        <h2 class="fin-h2">记一笔</h2>
        <div class="fin-form">
          <label class="fin-field"><span>日期</span><input v-model="form.date" type="date" /></label>
          <label class="fin-field"><span>类型</span>
            <select v-model="form.kind">
              <option value="expense">支出</option><option value="income">收入</option><option value="transfer">转账</option>
            </select>
          </label>
          <label class="fin-field"><span>金额(元)</span><input v-model="form.amount" class="fin-amount" inputmode="decimal" placeholder="0.00" /></label>
          <label v-if="form.kind !== 'transfer'" class="fin-field"><span>分类</span>
            <select v-model="form.category">
              <option v-for="c in (form.kind === 'income' ? incomeCats : expenseCats)" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
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
          <button class="fin-secondary" @click="exportCsv">导出本月 CSV</button>
          <span class="fin-hint">金额以「分」整数入库，元只在显示时出现</span>
        </div>
      </div>

      <div class="fin-card">
        <h2 class="fin-h2">近 6 个月</h2>
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
        <h2 class="fin-h2">{{ month }} 流水（{{ board?.stats.inMonth || 0 }} 条）</h2>
        <div v-if="!(board?.txns || []).length" class="fin-empty">本月还没有流水。记一笔，或去「CSV 导入」把账单放进来。</div>
        <div v-for="t in (board?.txns || [])" :key="t.id" class="fin-row">
          <span class="fin-row-date">{{ t.date }}</span>
          <span class="fin-row-kind" :data-kind="t.kind">{{ kindLabel(t.kind) }}</span>
          <span class="fin-row-main">{{ t.payee || t.note || '—' }}</span>
          <span class="fin-row-cat">{{ t.kind === 'transfer' ? accName(t.account) + ' → 转账' : catName(t.category) }}</span>
          <span class="fin-row-amt" :class="{ 'fin-pos': t.amountCents > 0 }">{{ yuan(t.amountCents) }}</span>
          <span v-if="t.ruleIds.length" class="fin-rule-hit" title="由自动分类规则命中">规则</span>
          <button class="fin-del" :aria-label="'删除 ' + t.date + ' 这一笔'" @click="removeEntry(t.id)">×</button>
        </div>
      </div>
    </div>

    <!-- ============ 预算 ============ -->
    <div v-else-if="tab === 'budget'" class="fin-pane">
      <div class="fin-card">
        <h2 class="fin-h2">设置 {{ month }} 的信封额度</h2>
        <p class="fin-hint-block">信封制：本月可用 = 额度 + 上月结转 − 本月已花。结转可以关，关掉就等于每月重新开始。</p>
        <div class="fin-form">
          <label class="fin-field"><span>分类</span>
            <select v-model="budgetForm.category">
              <option value="">选择分类</option>
              <option v-for="c in expenseCats" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="fin-field"><span>额度(元)</span><input v-model="budgetForm.limit" inputmode="decimal" placeholder="0.00" /></label>
          <label class="fin-check"><input v-model="budgetForm.rollover" type="checkbox" /> 余额结转下月</label>
        </div>
        <button class="fin-primary" @click="saveBudget">保存额度</button>
      </div>

      <div class="fin-card">
        <h2 class="fin-h2">本月信封（{{ board?.budgets.length || 0 }}）</h2>
        <div v-if="!(board?.budgets || []).length" class="fin-empty">还没设额度。先给「餐饮」这类高频分类定一个。</div>
        <div v-for="b in (board?.budgets || [])" :key="b.category" class="fin-budget">
          <div class="fin-budget-top">
            <b>{{ b.name }}</b>
            <span>{{ yuan(b.spentCents) }} / {{ yuan(b.limitCents + b.carryInCents) }}</span>
            <span :class="{ 'fin-neg': b.remainingCents < 0 }">剩 {{ yuan(b.remainingCents) }}</span>
            <button class="fin-mini" @click="editBudget(b)">改</button>
            <button class="fin-mini" @click="clearBudget(b)">清零</button>
          </div>
          <div class="fin-progress"><div :class="{ 'fin-over': b.usedBp > 10000 }" :style="{ width: Math.min(100, Math.round(b.usedBp / 100)) + '%' }"></div></div>
          <div class="fin-budget-foot">
            <span v-if="b.carryInCents">上月结转 {{ yuan(b.carryInCents) }}</span>
            <span v-if="!b.rollover">不结转</span>
          </div>
        </div>
      </div>

      <div class="fin-card">
        <h2 class="fin-h2">分类与账户</h2>
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
        <div class="fin-form">
          <label class="fin-field"><span>新账户</span><input v-model="newAcc.name" placeholder="如：招行卡" /></label>
          <label class="fin-field"><span>类型</span><select v-model="newAcc.kind"><option value="bank">银行卡</option><option value="cash">现金</option><option value="alipay">支付宝</option><option value="wechat">微信</option><option value="credit">信用卡</option><option value="other">其他</option></select></label>
          <button class="fin-secondary" @click="addAcc">加账户</button>
        </div>
        <div class="fin-chips">
          <span v-for="a in (board?.accounts || [])" :key="a.id" class="fin-chip">{{ a.name }}
            <button :aria-label="'删除账户 ' + a.name" @click="removeAcc(a.id)">×</button>
          </span>
        </div>
      </div>
    </div>

    <!-- ============ 自动分类规则 ============ -->
    <div v-else-if="tab === 'rules'" class="fin-pane">
      <div class="fin-card">
        <h2 class="fin-h2">新增规则（条件 → 动作）</h2>
        <p class="fin-hint-block">按优先级从小到大依次执行，后面的规则看得到前面改过的值；勾选「命中后停止」可实现首条命中即止。记一笔和 CSV 导入都会自动过一遍。</p>
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
          <button class="fin-mini" @click="ruleDraft.conditions.splice(i, 1)" aria-label="删除条件">×</button>
        </div>
        <button class="fin-secondary" @click="ruleDraft.conditions.push({ field: 'note', op: 'contains', value: '' })">＋ 加条件</button>
        <div v-for="(a, i) in ruleDraft.actions" :key="'a' + i" class="fin-rule-line">
          <select v-model="a.type"><option v-for="t in (meta?.actionTypes || [])" :key="t" :value="t">{{ ACT_LABEL[t] || t }}</option></select>
          <input v-model="a.value" placeholder="目标分类 id / 文本" />
          <button class="fin-mini" @click="ruleDraft.actions.splice(i, 1)" aria-label="删除动作">×</button>
        </div>
        <button class="fin-secondary" @click="ruleDraft.actions.push({ type: 'setCategory', value: '' })">＋ 加动作</button>
        <div class="fin-actions"><button class="fin-primary" @click="saveRule">保存规则</button></div>
      </div>

      <div class="fin-card">
        <h2 class="fin-h2">已有规则（{{ board?.rules.length || 0 }}）</h2>
        <div v-if="!(board?.rules || []).length" class="fin-empty">还没有规则。导入账单后，把重复出现的商户写成一条规则，下次就不用手填分类了。</div>
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

    <!-- ============ CSV 导入 ============ -->
    <div v-else class="fin-pane">
      <div class="fin-card">
        <h2 class="fin-h2">导入账单 CSV</h2>
        <p class="fin-hint-block">
          支持支付宝（GBK）、微信（UTF-8 BOM）和带「日期 / 金额」两列的通用 CSV。
          表头按列关键字定位，前面几行说明文字会自动跳过；退款、失败、不计收支的行自动排除。
          同一份文件重复导入不会产生重复流水（按订单号 + 日期 + 金额 + 对方生成指纹去重）。
          导入的每一笔都会立刻过一遍自动分类规则。
        </p>
        <label class="fin-file">
          <input type="file" accept=".csv,text/csv" :disabled="importing" @change="onFile" />
          <span>{{ importing ? '正在导入…' : '选择 CSV 文件' }}</span>
        </label>
        <div v-if="report" class="fin-report" role="status">
          <p><b>结果</b>：新增 {{ report.added }} 条 · 跳过 {{ report.skipped }} 条 · 重复 {{ report.duplicates }} 条 · 共扫描 {{ report.total }} 行</p>
          <p>识别：{{ report.platform }} / {{ report.encoding }} / 表头第 {{ report.headerLine }} 行</p>
          <p v-for="(e, i) in report.errors" :key="i" class="fin-err">{{ e }}</p>
        </div>
      </div>
      <div class="fin-card">
        <h2 class="fin-h2">本机口径</h2>
        <ul class="fin-list">
          <li>不做家庭共享：没有账号、没有成员、没有云同步，账本只在这台机器上。</li>
          <li>数据挂在 <code>md_finance</code> 单键，随九格备份一起导出、导入时按 id 合并。</li>
          <li>金额全程整数分，展示层才转成元；转账是两条互指的流水，不计入支出统计。</li>
          <li>本页与九格「金钱收支」格互不覆盖：那一格按天挂在日记里，这里是跨月账本。</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.fin-view { padding: var(--space-3); overflow-y: auto; height: 100%; box-sizing: border-box; }
.fin-head { border-bottom: 1px solid var(--surface-border); padding-bottom: var(--space-2); }
.fin-back, .fin-mini, .fin-secondary, .fin-primary {
  border: 1px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); color: var(--surface-text); cursor: pointer;
  padding: 4px 10px; font-size: 12px;
}
.fin-back { background: transparent; border: 0; }
.fin-title { margin: 4px 0 0; font-size: 20px; }
.fin-sub { margin: 2px 0 8px; color: var(--surface-muted); font-size: 12px; }
.fin-month { display: inline-flex; gap: 8px; align-items: center; }
.fin-month-label { font-weight: 600; min-width: 72px; text-align: center; }
.fin-stats { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 8px; font-size: 12px; }
.fin-stat b { margin-left: 4px; font-size: 14px; }
.fin-neg { color: var(--state-warn); }
.fin-pos { color: var(--palette-primary); }
.fin-tabs { display: flex; gap: 6px; margin: var(--space-2) 0; flex-wrap: wrap; }
.fin-tab {
  border: 1px solid var(--surface-border); border-radius: var(--radius-md);
  background: transparent; color: var(--surface-text); padding: 5px 12px; cursor: pointer; font-size: 12px;
}
.fin-tab-on { background: var(--palette-primary); color: var(--palette-on); }
.fin-notice { font-size: 12px; color: var(--palette-primary); margin: 0 0 8px; }
.fin-pane { display: grid; gap: var(--space-2); }
.fin-card { background: var(--surface-panel); border: 1px solid var(--surface-border); border-radius: var(--radius-lg); padding: var(--space-3); }
.fin-h2 { font-size: 14px; margin: 0 0 10px; }
.fin-hint, .fin-hint-block { color: var(--surface-muted); font-size: 11px; }
.fin-hint-block { line-height: 1.7; margin: 0 0 10px; }
.fin-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.fin-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; min-width: 120px; }
.fin-field-wide { flex: 1; min-width: 220px; }
.fin-field input, .fin-field select, .fin-rule-line input, .fin-rule-line select {
  border: 1px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); color: var(--surface-text); padding: 5px 7px; font-size: 12px;
  min-width: 100px;
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
.fin-row { display: flex; gap: 10px; align-items: center; padding: 7px 0; border-top: 1px solid var(--surface-border); font-size: 12px; }
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
.fin-file input { font-size: 11px; }
.fin-report { margin-top: 12px; font-size: 12px; line-height: 1.7; }
.fin-err { color: var(--state-warn); }
.fin-empty { color: var(--surface-muted); font-size: 12px; padding: 14px 0; }
.fin-list { font-size: 12px; line-height: 1.9; color: var(--surface-text); padding-left: 18px; margin: 0; }
.fin-list code { background: var(--surface-raised); padding: 1px 4px; border-radius: var(--radius-sm); }
@media (max-width: 1180px) {
  .fin-stats { gap: 8px; }
  .fin-row-cat { display: none; }
}
</style>
