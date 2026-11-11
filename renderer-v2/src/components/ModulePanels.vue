<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { localDate, type DiaryRecord } from '../types';

const props = defineProps<{ record: DiaryRecord; flat?: boolean }>();
const emit = defineEmits<{ (e: 'save', record: DiaryRecord): void; (e: 'notify', text: string): void }>();

interface Task { id: string; text: string; done: boolean; createdAt: number }
interface Entry { id: string; type: string; cents: number; category: string; note: string; createdAt: number }
// 学习这块已换成 md_growth：这块面板只借「书」这一种，考试与技能在「学习成长」页里
interface GrowthBook { id: string; title: string; author: string; total: number; done: number; unit: string; status: string; pct: number; themeId: string; themeTitle: string }
interface GrowthBoard {
  themes: Array<{ id: string; title: string; books: Array<{ id: string; title: string; author: string; total: number; done: number; unit: string; status: string; pct: number }> }>;
}
type Modules = { work: boolean; money: boolean; growth: boolean };

const tabs = [
  { key: 'work', label: '工作看板' },
  { key: 'money', label: '记一笔收支' },
  { key: 'growth', label: '学习进展' }
] as const;
type TabKey = typeof tabs[number]['key'];

const active = ref<TabKey>('work');
const modules = ref<Modules>({ work: true, money: true, growth: true });
const workBoard = ref<{ tasks: Task[]; reflection: string }>({ tasks: [], reflection: '' });
const moneyBook = ref<{ entries: Entry[] }>({ entries: [] });
const growthBoard = ref<GrowthBoard | null>(null);
const dayNote = ref('');
const taskInput = ref('');
const moneyType = ref<'expense' | 'income'>('expense');
const moneyAmount = ref('');
const moneyNote = ref('');
const moneyCategory = ref('food');
const bookTitle = ref('');

// 与 money-book.js CATEGORIES 逐字一致：写错分类会被 normalize 静默改成 other
const EXPENSE_CATEGORIES = [
  { id: 'food', label: '餐饮' }, { id: 'transport', label: '交通' }, { id: 'daily', label: '日用' },
  { id: 'home', label: '居家' }, { id: 'medical', label: '医疗' }, { id: 'social', label: '人情' },
  { id: 'learn', label: '学习' }, { id: 'fun', label: '娱乐' }, { id: 'other', label: '其他' }
];
const INCOME_CATEGORIES = [
  { id: 'salary', label: '工资' }, { id: 'bonus', label: '奖金' }, { id: 'reimburse', label: '报销' },
  { id: 'gift', label: '红包' }, { id: 'invest', label: '理财' }, { id: 'side', label: '兼职' },
  { id: 'other', label: '其他' }
];
const categoryOptions = computed(() => moneyType.value === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES);
const allCategories = computed(() => EXPENSE_CATEGORIES.concat(INCOME_CATEGORIES));

// 未读完的书摊平（跨主题）：这块面板只做「今天翻了几页」，不做书单管理
const openBooks = computed<GrowthBook[]>(function () {
  const out: GrowthBook[] = [];
  const board = growthBoard.value;
  if (!board || !Array.isArray(board.themes)) return out;
  board.themes.forEach(function (t) {
    (Array.isArray(t.books) ? t.books : []).forEach(function (b) {
      if (b.status === 'done') return;
      out.push(Object.assign({}, b, { themeId: t.id, themeTitle: t.title }));
    });
  });
  return out.slice(0, 8);
});

watch(() => props.record, function (r) {
  workBoard.value = JSON.parse(JSON.stringify(r.workBoard || { tasks: [], reflection: '' }));
  moneyBook.value = JSON.parse(JSON.stringify(r.moneyBook || { entries: [] }));
  const log = r.studyLog as { note?: string } | undefined;
  dayNote.value = (log && log.note) || '';
}, { immediate: true, deep: true });

const totals = computed(() => {
  let income = 0, expense = 0;
  moneyBook.value.entries.forEach(function (e) {
    if (e.type === 'income') income += e.cents; else expense += e.cents;
  });
  return { income, expense, balance: income - expense };
});

function persist(patch: Partial<DiaryRecord>): void {
  emit('save', Object.assign({}, JSON.parse(JSON.stringify(props.record)), patch));
}

function uid(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function addTask(): void {
  const text = taskInput.value.trim().slice(0, 60);
  if (!text || workBoard.value.tasks.length >= 20) return;
  workBoard.value.tasks.push({ id: uid('t'), text, done: false, createdAt: Date.now() });
  taskInput.value = '';
  persist({ workBoard: workBoard.value });
  emit('notify', '已加入今日任务');
}

function toggleTask(id: string): void {
  const t = workBoard.value.tasks.find(function (x) { return x.id === id; });
  if (t) t.done = !t.done;
  persist({ workBoard: workBoard.value });
}

function removeTask(id: string): void {
  workBoard.value.tasks = workBoard.value.tasks.filter(function (x) { return x.id !== id; });
  persist({ workBoard: workBoard.value });
}

function switchMoneyType(type: 'expense' | 'income'): void {
  moneyType.value = type;
  moneyCategory.value = categoryOptions.value[0].id;
}

function addEntry(): void {
  const yuan = Number(moneyAmount.value);
  if (!isFinite(yuan) || yuan <= 0) return;
  const cents = Math.round(yuan * 100);
  if (cents > 999999999 || moneyBook.value.entries.length >= 30) return;
  moneyBook.value.entries.push({
    id: uid('m'), type: moneyType.value, cents,
    category: moneyCategory.value, note: moneyNote.value.slice(0, 40), createdAt: Date.now()
  });
  moneyAmount.value = ''; moneyNote.value = '';
  persist({ moneyBook: moneyBook.value });
  emit('notify', '已记一笔 · 金额按「分」整数落盘');
}

function removeEntry(id: string): void {
  moneyBook.value.entries = moneyBook.value.entries.filter(function (x) { return x.id !== id; });
  persist({ moneyBook: moneyBook.value });
}

function saveDayNote(): void {
  const log = Object.assign({}, (props.record.studyLog as object) || {}, { note: dayNote.value.slice(0, 120) });
  persist({ studyLog: log });
  emit('notify', '今日一句已保存');
}

function yuan(cents: number): string { return (cents / 100).toFixed(2); }
function categoryLabel(id: string): string {
  const hit = allCategories.value.find(function (c) { return c.id === id; });
  return hit ? hit.label : '其他';
}

async function loadGrowth(): Promise<void> {
  growthBoard.value = await callDomain<GrowthBoard | null>('growth.board', null, localDate());
}

// 一句话推进：有同名书就翻 10 页，没有就先开「随手记」主题再建书。
// 只做这一件事，是因为这块面板的定位是「今天读了什么」，不是书单管理。
async function readBook(): Promise<void> {
  const title = bookTitle.value.trim();
  if (!title) return;
  const hit = openBooks.value.filter(function (b) { return b.title === title; })[0];
  if (hit) {
    await callDomain('growth.advanceBook', null, hit.themeId, hit.id, 10);
    bookTitle.value = '';
    await loadGrowth();
    emit('notify', '《' + title + '》+10 页');
    return;
  }
  const board = growthBoard.value;
  let themeId = '';
  const quick = board && Array.isArray(board.themes)
    ? board.themes.filter(function (t) { return t.title === '随手记'; })[0]
    : null;
  if (quick) {
    themeId = quick.id;
  } else {
    await callDomain('growth.addTheme', null, { title: '随手记' });
    const next = await callDomain<GrowthBoard | null>('growth.board', null, localDate());
    const made = next && Array.isArray(next.themes)
      ? next.themes.filter(function (t) { return t.title === '随手记'; })[0]
      : null;
    themeId = made ? made.id : '';
  }
  if (!themeId) { emit('notify', '主题创建失败，去学习成长页加书'); return; }
  await callDomain('growth.addBook', null, themeId, { title: title });
  const after = await callDomain<GrowthBoard | null>('growth.board', null, localDate());
  const theme = after && Array.isArray(after.themes)
    ? after.themes.filter(function (t) { return t.id === themeId; })[0]
    : null;
  const book = theme ? theme.books.filter(function (b) { return b.title === title; })[0] : null;
  if (book) await callDomain('growth.advanceBook', null, themeId, book.id, 10);
  bookTitle.value = '';
  await loadGrowth();
  emit('notify', '已加《' + title + '》并翻 10 页');
}

async function advanceBook(b: GrowthBook): Promise<void> {
  await callDomain('growth.advanceBook', null, b.themeId, b.id, 10);
  await loadGrowth();
  emit('notify', '《' + b.title + '》+10 ' + b.unit);
}

async function finishBook(b: GrowthBook): Promise<void> {
  await callDomain('growth.setBookStatus', null, b.themeId, b.id, 'done');
  await loadGrowth();
  emit('notify', '《' + b.title + '》已标读完');
}

async function removeBook(b: GrowthBook): Promise<void> {
  await callDomain('growth.removeBook', null, b.themeId, b.id);
  await loadGrowth();
  emit('notify', '已移除《' + b.title + '》');
}

onMounted(async () => {
  const [m, board] = await Promise.all([
    callDomain<Modules>('modules', modules.value),
    callDomain<GrowthBoard | null>('growth.board', null, localDate())
  ]);
  modules.value = m && typeof m === 'object' ? m : modules.value;
  growthBoard.value = board;
  const first = tabs.find(function (t) { return modules.value[t.key]; });
  if (first) active.value = first.key;
});
</script>

<template>
  <section class="panels" :class="{ 'panels-flat': flat }">
    <div class="mod-tabs" role="tablist" aria-label="功能模块">
      <button v-for="t in tabs" :key="t.key" class="mod-tab"
        :class="{ 'mod-tab-on': active === t.key }" :aria-selected="active === t.key"
        :disabled="!modules[t.key]" role="tab" @click="active = t.key">{{ t.label }}</button>
    </div>

    <div v-if="active === 'work'" class="panel">
      <div class="row">
        <input v-model="taskInput" class="text" maxlength="60" placeholder="今天要做什么（回车添加，#标签 可分类，上限 20 条）"
          @keydown.enter.prevent="addTask" />
        <button class="btn" :class="{ 'btn-on': !!taskInput.trim() }" @click="addTask">添加</button>
      </div>
      <ul class="list">
        <li v-for="t in workBoard.tasks" :key="t.id" class="item" :class="{ 'item-on': t.done }">
          <button class="check" :aria-pressed="t.done" @click="toggleTask(t.id)">{{ t.done ? '已完成' : '待办' }}</button>
          <span class="item-text">{{ t.text }}</span>
          <button class="del" aria-label="删除任务" @click="removeTask(t.id)">×</button>
        </li>
        <li v-if="workBoard.tasks.length === 0" class="empty">还没有任务</li>
      </ul>
      <label class="field">今日感想（上限 500 字）
        <textarea v-model="workBoard.reflection" class="text" rows="2" maxlength="500" @change="persist({ workBoard })"></textarea>
      </label>
    </div>

    <div v-else-if="active === 'money'" class="panel">
      <div class="row">
        <button class="seg" :class="{ 'seg-on': moneyType === 'expense' }" @click="switchMoneyType('expense')">支出</button>
        <button class="seg" :class="{ 'seg-on': moneyType === 'income' }" @click="switchMoneyType('income')">收入</button>
        <select v-model="moneyCategory" class="text sel">
          <option v-for="c in categoryOptions" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
        <input v-model="moneyAmount" class="text amount" type="number" min="0" step="0.01" placeholder="金额（元）" />
        <input v-model="moneyNote" class="text" maxlength="40" placeholder="一句备注" />
        <button class="btn" :class="{ 'btn-on': Number(moneyAmount) > 0 }" @click="addEntry">记一笔</button>
      </div>
      <div class="money-row">
        <span class="stat">收入 ¥{{ yuan(totals.income) }}</span>
        <span class="stat">支出 ¥{{ yuan(totals.expense) }}</span>
        <span class="stat stat-on">结余 ¥{{ yuan(totals.balance) }}</span>
      </div>
      <ul class="list">
        <li v-for="e in moneyBook.entries" :key="e.id" class="item">
          <span class="tag" :class="{ 'tag-on': e.type === 'income' }">{{ e.type === 'income' ? '收' : '支' }}</span>
          <span class="item-text">{{ categoryLabel(e.category) }} · ¥{{ yuan(e.cents) }} · {{ e.note }}</span>
          <button class="del" aria-label="删除账目" @click="removeEntry(e.id)">×</button>
        </li>
        <li v-if="moneyBook.entries.length === 0" class="empty">今天还没有记账</li>
      </ul>
    </div>

    <div v-else class="panel">
      <div class="row">
        <input v-model="bookTitle" class="text" maxlength="50" placeholder="在读哪本（回车：有就翻 10 页，没有就加进来）"
          @keydown.enter.prevent="readBook" />
        <button class="btn" :class="{ 'btn-on': !!bookTitle.trim() }" @click="readBook">读一段</button>
      </div>
      <ul class="list">
        <li v-for="b in openBooks" :key="b.id" class="item" :class="{ 'item-on': b.status === 'done' }">
          <span class="tag">{{ b.themeTitle }}</span>
          <span class="item-text">{{ b.title }} · {{ b.done }} / {{ b.total }} {{ b.unit }}</span>
          <button class="check" @click="advanceBook(b)">+10</button>
          <button class="check" @click="finishBook(b)">读完</button>
          <button class="del" aria-label="移除这本书" @click="removeBook(b)">×</button>
        </li>
        <li v-if="openBooks.length === 0" class="empty">还没有在读的书，输入书名回车就加进来</li>
      </ul>
      <label class="field">今日一句（上限 120 字）
        <textarea v-model="dayNote" class="text" rows="2" maxlength="120"></textarea>
      </label>
      <button class="btn" :class="{ 'btn-on': !!dayNote }" @click="saveDayNote">保存今日一句</button>
    </div>
  </section>
</template>

<style scoped>
.panels { margin-top: var(--space-3); padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
/* 右栏里：外框与留白交给 ctx-card；行内控件一律改「占满一行」，300px 宽下不横挤 */
.panels-flat { margin-top: 0; padding: 0; border: 0; border-radius: 0; background: transparent; }
.panels-flat .row > .text, .panels-flat .row > .btn, .panels-flat .row > .seg { flex: 1 1 100%; }
.panels-flat .sel, .panels-flat .amount { flex: 0 0 auto; width: 100%; }
.panels-flat .money-row { flex-wrap: wrap; }
.mod-tabs { display: flex; gap: 6px; margin-bottom: var(--space-2); }
.mod-tab { flex: 1; padding: 6px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.mod-tab-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.mod-tab:disabled { opacity: 0.4; }
.panel { display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.text { flex: 1; min-width: 120px; padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; }
.text:focus { border-color: var(--palette-accent); }
.sel { flex: 0 0 90px; }
.amount { flex: 0 0 110px; }
.btn, .seg { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.btn-on, .seg-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm); background: var(--surface-raised); font-size: 12px; }
.item-on { opacity: 0.6; text-decoration: line-through; }
.item-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.check, .del, .tag { border: 0; background: transparent; font-size: 12px; }
.check { color: var(--palette-primary); }
.tag { padding: 0 6px; border-radius: 999px; background: var(--surface-panel); font-size: 11px; }
.tag-on { background: var(--palette-soft); color: var(--palette-primary); }
.empty, .muted { font-size: 12px; color: var(--surface-muted); }
.money-row { display: flex; gap: 6px; }
.stat { padding: 2px 8px; border-radius: 999px; background: var(--surface-raised); font-size: 12px; }
.stat-on { background: var(--palette-soft); color: var(--palette-primary); }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--surface-muted); }
</style>
