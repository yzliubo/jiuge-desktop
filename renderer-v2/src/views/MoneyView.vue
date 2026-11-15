<script setup lang="ts">
// 收支格主功能：完整账本（跨天流水 + 分类占比 + 本月汇总）。
// 今日页的「记一笔收支」只是当天快面板；这里按日期倒序摊开全部流水，
// 允许直接删改历史记录（写回对应日期的日记记录，不做旁路存储）。
import { computed, onMounted, ref } from 'vue';
import { listDiaries, upsertDiary } from '../bridge';
import { localDate, type DiaryRecord } from '../types';
import CellNoteEditor from '../components/CellNoteEditor.vue';

// 账本是数字，记录是理由。只留数字，三个月后只记得花了多少，不记得为什么
defineProps<{ record: DiaryRecord }>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'notify', text: string): void;
  (e: 'save', record: DiaryRecord): void;
}>();

interface Entry { id: string; type: string; cents: number; category: string; note: string; createdAt: number }
interface FlatEntry extends Entry { date: string }

const EXPENSE = [
  { id: 'food', label: '餐饮' }, { id: 'transport', label: '交通' }, { id: 'daily', label: '日用' },
  { id: 'home', label: '居家' }, { id: 'medical', label: '医疗' }, { id: 'social', label: '人情' },
  { id: 'learn', label: '学习' }, { id: 'fun', label: '娱乐' }, { id: 'other', label: '其他' }
];
const INCOME = [
  { id: 'salary', label: '工资' }, { id: 'bonus', label: '奖金' }, { id: 'reimburse', label: '报销' },
  { id: 'gift', label: '红包' }, { id: 'invest', label: '理财' }, { id: 'side', label: '兼职' },
  { id: 'other', label: '其他' }
];
const ALL = EXPENSE.concat(INCOME);

const records = ref<DiaryRecord[]>([]);
const scope = ref(0);
const type = ref<'expense' | 'income'>('expense');
const amount = ref('');
const note = ref('');
const category = ref('food');
const message = ref('');
const monthKey = ref(localDate().slice(0, 7));
let msgTimer: ReturnType<typeof setTimeout> | null = null;

function say(t: string): void {
  message.value = t;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { message.value = ''; }, 2600);
}

const categoryOptions = computed(() => (type.value === 'income' ? INCOME : EXPENSE));

const flat = computed<FlatEntry[]>(() => {
  const out: FlatEntry[] = [];
  records.value.forEach(function (r) {
    const book = r.moneyBook as { entries?: Entry[] } | undefined;
    const list = book && Array.isArray(book.entries) ? book.entries : [];
    list.forEach(function (e) {
      out.push(Object.assign({}, e, { date: r.date }));
    });
  });
  return out.sort(function (a, b) {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.createdAt - a.createdAt;
  });
});

const totals = computed(() => {
  let income = 0, expense = 0;
  flat.value.forEach(function (e) {
    if (e.date.slice(0, 7) !== monthKey.value) return;
    if (e.type === 'income') income += e.cents; else expense += e.cents;
  });
  return { income: income, expense: expense, balance: income - expense };
});

const monthEntries = computed(() => flat.value.filter(function (e) { return e.date.slice(0, 7) === monthKey.value; }));

const byCategory = computed(() => {
  const map: Record<string, number> = {};
  let sum = 0;
  monthEntries.value.forEach(function (e) {
    if (e.type === 'income') return;
    map[e.category] = (map[e.category] || 0) + e.cents;
    sum += e.cents;
  });
  const rows = Object.keys(map).map(function (k) {
    return { id: k, label: labelOf(k), cents: map[k], pct: sum ? Math.round(map[k] * 100 / sum) : 0 };
  }).sort(function (a, b) { return b.cents - a.cents; });
  return rows;
});

const months = computed(() => {
  const set: Record<string, boolean> = {};
  flat.value.forEach(function (e) { set[e.date.slice(0, 7)] = true; });
  set[monthKey.value] = true;
  return Object.keys(set).sort().reverse();
});

const grouped = computed(() => {
  const map: Record<string, FlatEntry[]> = {};
  const order: string[] = [];
  monthEntries.value.forEach(function (e) {
    if (!map[e.date]) { map[e.date] = []; order.push(e.date); }
    map[e.date].push(e);
  });
  return order.map(function (d) { return { date: d, items: map[d] }; });
});

const dayTotals = computed(() => {
  const map: Record<string, number> = {};
  monthEntries.value.forEach(function (e) {
    map[e.date] = (map[e.date] || 0) + (e.type === 'income' ? e.cents : -e.cents);
  });
  return map;
});

function labelOf(id: string): string {
  const hit = ALL.filter(function (c) { return c.id === id; })[0];
  return hit ? hit.label : '其他';
}
function yuan(cents: number): string { return (cents / 100).toFixed(2); }
function uid(): string {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

async function load(): Promise<void> {
  const res = await listDiaries({ pageSize: 200 });
  records.value = res.items;
  scope.value = res.total;
}

async function addEntry(): Promise<void> {
  const y = Number(amount.value);
  if (!isFinite(y) || y <= 0) { say('金额要大于 0'); return; }
  const cents = Math.round(y * 100);
  if (cents > 999999999) { say('单笔金额超出上限'); return; }
  const today = localDate();
  const current = records.value.filter(function (r) { return r.date === today; })[0];
  const base: DiaryRecord = current
    ? (JSON.parse(JSON.stringify(current)) as DiaryRecord)
    : (await upsertDiary(Object.assign({}, emptyToday(today)), 'money-new-' + today)).record;
  const book = base.moneyBook as { entries?: Entry[] } | undefined;
  const entries = book && Array.isArray(book.entries) ? book.entries.slice(0) : [];
  if (entries.length >= 30) { say('单日上限 30 笔'); return; }
  entries.push({
    id: uid(), type: type.value, cents: cents,
    category: category.value, note: note.value.trim().slice(0, 40), createdAt: Date.now()
  });
  base.moneyBook = Object.assign({}, base.moneyBook, { entries: entries }) as DiaryRecord['moneyBook'];
  await upsertDiary(base, 'money-add-' + today + '-' + Date.now());
  amount.value = '';
  note.value = '';
  await load();
  say('已记一笔 · 按「分」整数落盘');
}

function emptyToday(date: string): DiaryRecord {
  const cells: Record<string, string> = {};
  ['work', 'money', 'health', 'relation', 'future', 'emotion', 'dream', 'growth', 'free'].forEach(function (k) { cells[k] = ''; });
  return {
    date: date, cells: cells, base: {}, workBoard: { tasks: [], reflection: '' },
    moneyBook: { entries: [] }, studyLog: {}, review: {}, capsule: {}
  } as unknown as DiaryRecord;
}

async function removeEntry(e: FlatEntry): Promise<void> {
  const rec = records.value.filter(function (r) { return r.date === e.date; })[0];
  if (!rec) return;
  const base = JSON.parse(JSON.stringify(rec)) as DiaryRecord;
  const book = base.moneyBook as { entries?: Entry[] } | undefined;
  const entries = (book && Array.isArray(book.entries) ? book.entries : []).filter(function (x) { return x.id !== e.id; });
  base.moneyBook = Object.assign({}, base.moneyBook, { entries: entries }) as DiaryRecord['moneyBook'];
  await upsertDiary(base, 'money-del-' + e.date + '-' + Date.now());
  await load();
  say('已删除该笔');
}

onMounted(load);
</script>

<template>
  <section class="money-view">
    <header class="head">
      <div>
        <h2>收支 · 完整账本</h2>
      </div>
      <button class="back" @click="emit('back')">← 返回九格</button>
    </header>

    <div class="sum-row">
      <div class="sum-card">
        <span class="sum-label">本月收入</span>
        <strong class="sum-num">¥{{ yuan(totals.income) }}</strong>
      </div>
      <div class="sum-card">
        <span class="sum-label">本月支出</span>
        <strong class="sum-num">¥{{ yuan(totals.expense) }}</strong>
      </div>
      <div class="sum-card sum-on">
        <span class="sum-label">本月结余</span>
        <strong class="sum-num">¥{{ yuan(totals.balance) }}</strong>
      </div>
      <select v-model="monthKey" class="month-sel" aria-label="选择月份">
        <option v-for="m in months" :key="m" :value="m">{{ m }}</option>
      </select>
    </div>

    <div class="add-row">
      <button class="seg" :class="{ 'seg-on': type === 'expense' }" @click="type = 'expense'; category = 'food'">支出</button>
      <button class="seg" :class="{ 'seg-on': type === 'income' }" @click="type = 'income'; category = 'salary'">收入</button>
      <select v-model="category" class="sel" aria-label="分类">
        <option v-for="c in categoryOptions" :key="c.id" :value="c.id">{{ c.label }}</option>
      </select>
      <input v-model="amount" class="amount" type="number" min="0" step="0.01" placeholder="金额（元）" aria-label="金额" />
      <input v-model="note" class="note-in" maxlength="40" placeholder="备注（40 字内）" aria-label="备注" />
      <button class="primary" :class="{ 'money-add-on': Number(amount) > 0 }" @click="addEntry">记一笔</button>
    </div>

    <section class="cats">
      <h3>本月支出结构 <span class="muted">共 {{ byCategory.length }} 类</span></h3>
      <div v-for="c in byCategory" :key="c.id" class="cat-row" :class="{ 'money-cat-on': c.pct >= 50 }">
        <span class="cat-name">{{ c.label }}</span>
        <span class="cat-bar"><i :style="{ width: c.pct + '%' }"></i></span>
        <span class="cat-num">¥{{ yuan(c.cents) }} · {{ c.pct }}%</span>
      </div>
      <p v-if="byCategory.length === 0" class="muted">本月还没有支出记录。</p>
    </section>

    <section class="ledger">
      <h3>流水 <span class="muted">本月 {{ monthEntries.length }} 笔 · 已加载最近 200 篇日记中的记录</span></h3>
      <div v-for="g in grouped" :key="g.date" class="day-group">
        <div class="day-head">
          <span class="day-date">{{ g.date }}</span>
          <span class="day-sum" :class="{ 'money-neg': dayTotals[g.date] < 0 }">
            当日 {{ dayTotals[g.date] >= 0 ? '+' : '−' }}¥{{ yuan(Math.abs(dayTotals[g.date] || 0)) }}
          </span>
        </div>
        <ul class="list">
          <li v-for="e in g.items" :key="e.id" class="item" :class="{ 'money-in': e.type === 'income' }">
            <span class="tag" :class="{ 'tag-on': e.type === 'income' }">{{ e.type === 'income' ? '收' : '支' }}</span>
            <span class="cat">{{ labelOf(e.category) }}</span>
            <span class="item-text">{{ e.note || '（无备注）' }}</span>
            <span class="amt">¥{{ yuan(e.cents) }}</span>
            <button class="del" aria-label="删除账目" @click="removeEntry(e)">×</button>
          </li>
        </ul>
      </div>
      <p v-if="grouped.length === 0" class="muted">这个月还没有记账。</p>
    </section>

    <CellNoteEditor :record="record" cell-key="money" @save="emit('save', $event)" @notify="emit('notify', $event)" />

    <p class="note">最近 200 篇 · 按日期倒序</p>
    <div v-if="message" class="msg" :class="{ 'message-on': !!message }" role="status">{{ message }}</div>
  </section>
</template>

<style scoped>
.money-view { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.head h2 { margin: 0; font-size: var(--text-h2); font-weight: 500; }
.muted { font-size: var(--text-sm); color: var(--surface-muted); }
.sum-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sum-card { display: flex; flex-direction: column; gap: 2px; padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.sum-on { background: var(--palette-soft); border-color: var(--palette-border); }
.sum-label { font-size: var(--text-xs); color: var(--surface-muted); }
.sum-num { font-size: var(--text-h2); font-variant-numeric: tabular-nums; }
.month-sel { margin-left: auto; padding: 5px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.add-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
input, select { padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; }
input:focus, select:focus { border-color: var(--palette-accent); }
.sel { flex: 0 0 90px; }
.amount { flex: 0 0 110px; }
.note-in { flex: 1 1 160px; }
.seg, .primary, .back { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.seg-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.primary.money-add-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.cats, .ledger { display: flex; flex-direction: column; gap: 6px; padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.cats h3, .ledger h3 { margin: 0; font-size: var(--text-sm); font-weight: 500; display: flex; gap: 8px; align-items: baseline; }
.cat-row { display: flex; align-items: center; gap: 8px; font-size: var(--text-sm); }
.cat-name { min-width: 48px; }
.cat-bar { flex: 1; height: 6px; border-radius: 999px; background: var(--surface-raised); overflow: hidden; }
.cat-bar i { display: block; height: 100%; background: var(--palette-primary); }
.money-cat-on .cat-bar i { background: var(--palette-accent); }
.cat-num { font-variant-numeric: tabular-nums; color: var(--surface-muted); }
.day-group { display: flex; flex-direction: column; gap: 4px; }
.day-head { display: flex; justify-content: space-between; font-size: var(--text-sm); color: var(--surface-muted); border-bottom: 0.5px solid var(--surface-border); padding-bottom: 2px; }
.day-date { font-variant-numeric: tabular-nums; }
.day-sum { font-variant-numeric: tabular-nums; }
.money-neg { color: var(--palette-accent); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm); background: var(--surface-raised); font-size: var(--text-sm); }
.money-in .amt { color: var(--palette-primary); }
.tag { padding: 0 6px; border-radius: 999px; background: var(--surface-panel); }
.tag-on { background: var(--palette-soft); color: var(--palette-primary); }
.cat { color: var(--surface-muted); min-width: 40px; }
.item-text { flex: 1; }
.amt { font-variant-numeric: tabular-nums; }
.del { border: 0; background: transparent; color: var(--surface-muted); }
.note { margin: 0; font-size: var(--text-xs); color: var(--surface-muted); }
.msg { padding: 6px 10px; border-radius: var(--radius-sm); background: var(--surface-panel); font-size: var(--text-sm); }
.message-on { background: var(--palette-soft); color: var(--palette-primary); }
</style>
