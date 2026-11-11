<script setup lang="ts">
// 梦想 · 目标板（原九格里的「梦想」格升成的一级模块）。
//
// 形态参照「成功助理」的目标页：主题 → 领域分组 → 子目标行（开始/截止/状态/
// 完成%/优先级），每个目标可以量化、可以拆成行动、可以写总结。
// 差别在于：这里不做树形无限层级，只做「领域 × 期限」两维——层级一多，
// 目标就变成了整理工作本身。
//
// 2026-11-10 22:42 主理人要求：量化分析那些详细设置搬到右栏，右栏顶部常驻一个
// 梦想图片展示窗。于是中栏只留「看板」——一行一条，点一行把它交给右栏；
// 改数字、设账户、配图片全在右栏（与工作格 GTD 的「点一行 → 右栏改」同一套分工）。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { localDate } from '../types';

const props = defineProps<{ selected?: string; tick?: number }>();

const emit = defineEmits<{
  (e: 'notify', text: string): void;
  (e: 'changed'): void;
  // 选中一条目标：右栏据此换详情。空串 = 取消选中
  (e: 'select-dream', id: string): void;
  // 去对应模块干具体事：工作→GTD 工作台、金钱→账本、健康→坚持、成长→学习库
  (e: 'open-cell', key: string): void;
}>();

interface Metric { name: string; unit: string; from: number; to: number; current: number }
interface Fund { target: number; saved: number; pct: number; ready: boolean }
interface Row {
  id: string; title: string; area: string; areaLabel: string;
  horizon: string; horizonLabel: string; status: string; statusLabel: string;
  priority: string; priorityLabel: string;
  startDate: string; dueDate: string; progress: number;
  metric: Metric | null; fund: Fund | null; deposits: number; summary: string;
  image: string; hasImage: boolean;
  taskTotal: number; taskOpen: number; taskDone: number;
  dueDays: number | null; overdue: boolean; pace: string;
}
interface Board {
  theme: string;
  rows: Row[];
  stats: { total: number; achieved: number; overdue: number; avgProgress: number; byHorizon: Record<string, number>; byArea: Record<string, number> };
  insight: string;
  horizons: Array<{ key: string; label: string; hint: string }>;
  areas: Array<{ key: string; label: string; gridKey: string; hint: string }>;
  statusMeta: string[];
  limits: { dreams: number; title: number; summary: number; taskLinks: number };
}

const board = ref<Board | null>(null);
const loading = ref(true);
const horizonTab = ref('all');
const message = ref('');
let msgTimer: ReturnType<typeof setTimeout> | null = null;

function say(t: string): void {
  message.value = t;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { message.value = ''; }, 2800);
}

// 只读一遍数据，不再往上抛 changed：右栏改完数据会自增 tick，本页跟着 tick 重取；
// 若这里也 emit('changed')，tick 自增 → 本页 load → 再自增，会转成死循环。
async function load(): Promise<void> {
  loading.value = true;
  try {
    board.value = await callDomain<Board | null>('dream.board', null, localDate());
  } finally {
    loading.value = false;
  }
}

const rows = computed<Row[]>(() => (board.value ? board.value.rows : []));
const horizons = computed(() => (board.value ? board.value.horizons : []));
const areas = computed(() => (board.value ? board.value.areas : []));
const stats = computed(() => (board.value ? board.value.stats : {
  total: 0, achieved: 0, overdue: 0, avgProgress: 0, byHorizon: {}, byArea: {}
}));
const visible = computed<Row[]>(() => (
  horizonTab.value === 'all' ? rows.value : rows.value.filter(function (r) { return r.horizon === horizonTab.value; })
));

// 树状：总主题 → 六个领域 → 子目标。领域顺序固定，空的领域不画（避免一屏空壳）
const groups = computed<Array<{ key: string; label: string; hint: string; gridKey: string; items: Row[] }>>(() => {
  return areas.value.map(function (a) {
    return {
      key: a.key,
      label: a.label,
      hint: a.hint,
      gridKey: a.gridKey,
      items: visible.value.filter(function (r) { return r.area === a.key; })
    };
  }).filter(function (g) { return g.items.length > 0; });
});

// --- 新建 ---
const adding = ref(false);
const draft = ref({
  title: '', area: 'work', horizon: 'short', dueDate: '', priority: 'normal',
  metricName: '', metricUnit: '', metricFrom: '', metricTo: '', metricNow: ''
});

function openAdd(): void {
  adding.value = true;
  draft.value = { title: '', area: 'work', horizon: 'short', dueDate: '', priority: 'normal', metricName: '', metricUnit: '', metricFrom: '', metricTo: '', metricNow: '' };
}
function cancelAdd(): void {
  adding.value = false;
}

async function submitAdd(): Promise<void> {
  const title = draft.value.title.trim();
  if (!title) { say('先写一句具体的：什么时候、做到什么数'); return; }
  const patch: Record<string, unknown> = {
    title: title,
    area: draft.value.area,
    horizon: draft.value.horizon,
    dueDate: draft.value.dueDate,
    priority: draft.value.priority,
    status: 'doing'
  };
  if (draft.value.metricName.trim()) {
    patch.metric = {
      name: draft.value.metricName.trim(),
      unit: draft.value.metricUnit.trim(),
      from: Number(draft.value.metricFrom) || 0,
      to: Number(draft.value.metricTo) || 0,
      current: Number(draft.value.metricNow) || 0
    };
  }
  const created = await callDomain<{ dreams?: Array<{ id: string }> } | null>('dream.add', null, patch);
  adding.value = false;
  await load();
  // 新建完直接选中它：右栏立刻是它的量化与图片窗，不用再点一次
  const list = created && Array.isArray(created.dreams) ? created.dreams : [];
  const last = list[list.length - 1];
  if (last) emit('select-dream', last.id);
  emit('changed');
  say('已加入「' + labelOfHorizon(draft.value.horizon) + '」');
  emit('notify', '目标已记下');
}

function labelOfHorizon(key: string): string {
  const h = horizons.value.filter(function (x) { return x.key === key; })[0];
  return h ? h.label : key;
}

// --- 行内操作 ---
async function patchRow(row: Row, patch: Record<string, unknown>): Promise<void> {
  await callDomain('dream.update', null, row.id, patch);
  await load();
  emit('changed');
}

function toggleDone(row: Row): void {
  void patchRow(row, { status: row.status === 'done' ? 'doing' : 'done' }).then(function () {
    say(row.status === 'done' ? '已改回「进行中」' : '已达成 · 记一笔');
  });
}

async function removeRow(row: Row): Promise<void> {
  await callDomain('dream.remove', null, row.id);
  if (props.selected === row.id) emit('select-dream', '');
  await load();
  emit('changed');
  say('已删除「' + row.title + '」');
}

function select(row: Row): void {
  emit('select-dream', props.selected === row.id ? '' : row.id);
}

// 拆成行动：目标不落到「下一步」，就永远停在纸上
async function makeAction(row: Row): Promise<void> {
  const res = await callDomain<{ tasks?: Array<{ id: string }> } | null>('gtd.add', null, {
    title: row.title.slice(0, 40),
    status: 'next',
    project: row.title.slice(0, 24)
  });
  const tasks = res && Array.isArray(res.tasks) ? res.tasks : [];
  const last = tasks[tasks.length - 1];
  if (!last) { say('拆解失败：未能写入 GTD'); return; }
  await callDomain('dream.linkTask', null, row.id, last.id);
  await load();
  emit('changed');
  say('已在 GTD 建了一条下一步，并挂到这个目标上');
}

function centsToYuan(cents: number): string {
  return (Math.round((Number(cents) || 0) / 100)).toLocaleString('zh-CN');
}

onMounted(load);
// 右栏改了数据会自增 tick：这里重取一次，行里的进度/账户/状态才跟着变
watch(function () { return props.tick; }, load);
</script>

<template>
  <section class="dream-view">
    <header class="head">
      <div>
        <h1 class="theme-title">{{ board ? board.theme : '梦想 · 目标板' }}</h1>
        <p class="sub">点一行，右栏改它的量化、账户与日期，并给它配一张「做到之后」的图片。</p>
      </div>
      <button class="add-btn" :class="{ 'add-on': adding }" @click="adding ? cancelAdd() : openAdd()">
        {{ adding ? '取消' : '＋ 新目标' }}
      </button>
    </header>

    <!-- 新建：一句目标 + 领域 + 期限；量化可选，不强迫 -->
    <div v-if="adding" class="add-panel">
      <input
        v-model="draft.title"
        class="ap-title"
        maxlength="60"
        placeholder="写具体的：例如「今年存下 8 万」「三年内考出一建」"
        aria-label="目标标题"
        @keydown.enter.prevent="submitAdd"
      />
      <div class="ap-row">
        <select v-model="draft.area" class="ap-sel" aria-label="领域">
          <option v-for="a in areas" :key="a.key" :value="a.key">{{ a.label }}</option>
        </select>
        <select v-model="draft.horizon" class="ap-sel" aria-label="期限">
          <option v-for="h in horizons" :key="h.key" :value="h.key">{{ h.label }}（{{ h.hint }}）</option>
        </select>
        <input v-model="draft.dueDate" class="ap-date" type="date" aria-label="截止日期" />
        <select v-model="draft.priority" class="ap-sel ap-pri" aria-label="优先级">
          <option value="normal">普通</option>
          <option value="high">高</option>
        </select>
      </div>
      <div class="ap-row ap-metric">
        <span class="ap-hint">量化（可选）</span>
        <input v-model="draft.metricName" class="ap-mini" maxlength="20" placeholder="指标名，如 存款" aria-label="指标名" />
        <input v-model="draft.metricFrom" class="ap-num" type="number" placeholder="从" aria-label="起始值" />
        <span class="ap-arrow">→</span>
        <input v-model="draft.metricTo" class="ap-num" type="number" placeholder="到" aria-label="目标值" />
        <input v-model="draft.metricNow" class="ap-num" type="number" placeholder="现在" aria-label="当前值" />
        <input v-model="draft.metricUnit" class="ap-unit" maxlength="10" placeholder="单位" aria-label="单位" />
      </div>
      <div class="ap-row">
        <button class="ap-save" @click="submitAdd">记下这个目标</button>
      </div>
    </div>

    <!-- 期限分段 -->
    <div class="hz-tabs" role="tablist" aria-label="期限">
      <button class="hz-tab" :class="{ 'hz-on': horizonTab === 'all' }" @click="horizonTab = 'all'">
        全部<span class="num">{{ stats.total }}</span>
      </button>
      <button
        v-for="h in horizons"
        :key="h.key"
        class="hz-tab"
        :class="{ 'hz-on': horizonTab === h.key }"
        @click="horizonTab = h.key"
      >{{ h.label }}<span class="num">{{ stats.byHorizon[h.key] || 0 }}</span><span class="hz-hint">{{ h.hint }}</span></button>
    </div>

    <p class="insight">{{ board ? board.insight : '正在读取…' }}</p>

    <div class="stats">
      <span class="st"><em>{{ stats.total }}</em> 个目标</span>
      <span class="st"><em>{{ stats.achieved }}</em> 已达成</span>
      <span class="st" :class="{ 'st-warn': stats.overdue > 0 }"><em>{{ stats.overdue }}</em> 已超期</span>
      <span class="st">平均进度 <em>{{ stats.avgProgress }}%</em></span>
    </div>

    <p v-if="message" class="dv-msg" role="status">{{ message }}</p>

    <div class="rows">
      <section v-for="g in groups" :key="g.key" class="area">
        <h2 class="area-head">
          <span class="area-label">{{ g.label }}</span>
          <span class="area-count">{{ g.items.length }}</span>
          <span class="area-hint">{{ g.hint }}</span>
        </h2>
        <div
          v-for="row in g.items"
          :key="row.id"
          class="goal"
          :class="{
            'goal-done': row.status === 'done',
            'goal-overdue': row.overdue,
            'goal-on': selected === row.id
          }"
        >
          <div class="goal-main">
            <button
              class="g-check"
              :aria-pressed="row.status === 'done'"
              :aria-label="row.status === 'done' ? '改回进行中' : '标记已达成'"
              @click="toggleDone(row)"
            >{{ row.status === 'done' ? '✓' : '○' }}</button>
            <button
              class="g-title"
              :aria-pressed="selected === row.id"
              :title="'在右栏编辑「' + row.title + '」'"
              @click="select(row)"
            >{{ row.title }}</button>
            <span v-if="row.hasImage" class="g-pic" title="已配具象化图片" aria-label="已配图">▣</span>
            <span class="g-hz">{{ row.horizonLabel }}</span>
            <span v-if="row.dueDate" class="g-due" :class="{ 'g-due-hot': row.overdue }">{{ row.dueDate }} · {{ row.pace }}</span>
            <span v-if="row.priority === 'high'" class="g-pri">高</span>
            <span v-if="row.taskTotal" class="g-task" :class="{ 'g-task-done': row.taskOpen === 0 }">
              行动 {{ row.taskDone }}/{{ row.taskTotal }}
            </span>
            <span v-if="row.fund" class="g-fund" :class="{ 'g-fund-ready': row.fund.ready }">
              账户 ¥{{ centsToYuan(row.fund.saved) }} / {{ centsToYuan(row.fund.target) }}
              <template v-if="row.fund.ready">· 可动</template>
            </span>
            <span class="g-bar" :aria-label="'进度 ' + row.progress + '%'">
              <span class="g-bar-in" :style="{ width: row.progress + '%' }"></span>
            </span>
            <span class="g-pct">{{ row.progress }}%</span>
            <span class="g-status">{{ row.statusLabel }}</span>
            <button class="g-act" @click="makeAction(row)">拆成行动</button>
            <button class="g-del" :aria-label="'删除「' + row.title + '」'" @click="removeRow(row)">×</button>
          </div>
        </div>
      </section>
      <p v-if="loading" class="empty">正在读取本机目标…</p>
      <p v-else-if="!visible.length" class="empty">
        这一档还没有目标。写一条能验收的：「今年存下 8 万」比「多挣钱」有用得多。
      </p>
    </div>
  </section>
</template>

<style scoped>
.dream-view { display: flex; flex-direction: column; gap: var(--space-2); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.theme-title { font-size: 15px; font-weight: 500; margin: 0; }
.head .sub { font-size: 12px; color: var(--surface-muted); margin: 4px 0 0; line-height: 1.7; max-width: 62ch; }
.add-btn {
  flex: 0 0 auto; padding: 5px 14px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); font-size: 12px;
}
.add-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }

.add-panel {
  display: flex; flex-direction: column; gap: 6px;
  padding: var(--space-2);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg);
  background: var(--surface-panel);
}
.ap-title {
  width: 100%; padding: 6px 8px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); outline: none;
}
.ap-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ap-sel, .ap-date, .ap-mini, .ap-num, .ap-unit {
  padding: 4px 8px; font-size: 12px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); outline: none;
}
.ap-sel { max-width: 150px; }
.ap-pri { max-width: 80px; }
.ap-mini { width: 120px; }
.ap-num { width: 68px; }
.ap-unit { width: 60px; }
.ap-hint, .ap-arrow { font-size: 11px; color: var(--surface-muted); }
.ap-save {
  padding: 5px 14px; border: 0.5px solid var(--palette-primary); border-radius: var(--radius-md);
  background: var(--palette-primary); color: var(--palette-on); font-size: 12px;
}

.hz-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.hz-tab {
  display: flex; align-items: baseline; gap: 4px;
  padding: 4px 10px;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-raised); font-size: 12px; color: var(--surface-muted);
}
.hz-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.hz-tab .num { font-size: 11px; opacity: 0.85; }
.hz-hint { font-size: 10px; opacity: 0.7; }

.insight { margin: 0; font-size: 12px; color: var(--surface-text); line-height: 1.7; }
.stats { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--surface-muted); }
.stats em { font-style: normal; color: var(--surface-text); font-size: 14px; }
.st-warn em { color: var(--state-warn); }
.dv-msg { margin: 0; font-size: 12px; color: var(--palette-primary); }

.rows { display: flex; flex-direction: column; gap: var(--space-2); }
.area { display: flex; flex-direction: column; gap: 4px; }
.area-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 2px; font-size: 12px; font-weight: 500; }
.area-label { color: var(--palette-primary); }
.area-count { font-size: 11px; color: var(--surface-muted); font-weight: 400; }
.area-hint { font-size: 11px; color: var(--surface-muted); font-weight: 400; }
.goal {
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised);
}
.goal-done { background: var(--palette-soft); }
.goal-overdue { border-color: var(--state-warn); }
/* 选中态要一眼看出来：右栏现在改的是这一条，点错行等于改错目标 */
.goal-on { border-color: var(--palette-primary); box-shadow: inset 2px 0 0 var(--palette-primary); }
.goal-main { display: flex; align-items: center; gap: 8px; padding: 5px 8px; font-size: 12px; }
.g-check {
  flex: 0 0 auto; width: 18px; height: 18px; padding: 0;
  border: 0.5px solid var(--surface-border); border-radius: 50%;
  background: var(--surface-panel); font-size: 11px; line-height: 1; color: var(--surface-muted);
}
.goal-done .g-check { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.g-title {
  flex: 1 1 auto; min-width: 0; text-align: left;
  border: 0; background: transparent; font-size: 12px; color: var(--surface-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.g-title:hover { color: var(--palette-primary); }
.goal-done .g-title { text-decoration: line-through; color: var(--surface-muted); }
.g-pic { flex: 0 0 auto; font-size: 9px; color: var(--palette-primary); }
.g-hz { flex: 0 0 auto; font-size: 11px; color: var(--surface-muted); }
.g-due { flex: 0 0 auto; font-size: 11px; color: var(--surface-muted); }
.g-due-hot { color: var(--state-warn); }
.g-pri { flex: 0 0 auto; font-size: 10px; color: var(--state-warn); border: 0.5px solid var(--state-warn); border-radius: 3px; padding: 0 3px; }
.g-task { flex: 0 0 auto; font-size: 11px; color: var(--surface-muted); }
.g-task-done { color: var(--palette-primary); }
.g-bar { flex: 0 0 70px; height: 4px; border-radius: 999px; background: var(--surface-panel); overflow: hidden; }
.g-bar-in { display: block; height: 100%; background: var(--palette-accent); }
.g-pct { flex: 0 0 auto; font-size: 11px; color: var(--surface-muted); min-width: 32px; text-align: right; }
.g-status { flex: 0 0 auto; font-size: 11px; color: var(--surface-muted); min-width: 42px; }
.g-act {
  flex: 0 0 auto; padding: 2px 8px; font-size: 11px;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-panel); color: var(--surface-muted);
}
.g-act:hover { color: var(--palette-primary); border-color: var(--palette-border); }
.g-del { flex: 0 0 auto; border: 0; background: transparent; color: var(--surface-muted); font-size: 13px; }
.g-del:hover { color: var(--state-warn); }
.g-fund { flex: 0 0 auto; font-size: 11px; color: var(--surface-muted); }
.g-fund-ready { color: var(--palette-primary); font-weight: 500; }
.empty { font-size: 12px; color: var(--surface-muted); margin: 6px 0 0; line-height: 1.7; }
</style>
