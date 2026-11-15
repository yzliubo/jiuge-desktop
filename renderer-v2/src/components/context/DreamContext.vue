<script setup lang="ts">
// 「梦想」的右栏：图片窗 + 选中那条的全部详细设置。
//
// 2026-11-10 22:42 主理人要求两件事：
//   1. 量化分析等详细设置不再在中栏行下展开，改到右栏展示与编辑；
//   2. 右栏顶部**始终**保留一个梦想图片展示窗，放每个梦想的具象化图片/照片，可自行设置。
// 于是这一栏从上到下是：
//   · 图片窗（常驻，即使没选中也占位）——「做到之后会看到的样子」，比数字更能推动人；
//   · 详情（选中才有）——量化分析 / 梦想账户 / 关联项 / 日期与总结，全部可写；
//   · 三档期限概览（只读，压在最底下，看一眼分布就够）。
//
// 写边界与工作格一致：这一栏只写「当前选中的那一条」，所有写调用的第二个参数都是 sel.id；
// 列表级的勾选、删除、新建仍在中栏，右栏不做列表操作。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { pickImageFile } from '../../bridge';
import { localDate } from '../../types';

const props = defineProps<{ dreamId?: string; tick?: number }>();

const emit = defineEmits<{
  (e: 'open-cell', key: string): void;
  (e: 'changed'): void;
  (e: 'notify', text: string): void;
}>();

interface Metric { name: string; unit: string; from: number; to: number; current: number }
interface Fund { target: number; saved: number; pct: number; ready: boolean }
interface Row {
  id: string; title: string; area: string; areaLabel: string;
  horizon: string; horizonLabel: string; status: string; statusLabel: string;
  startDate: string; dueDate: string; progress: number; pace: string; overdue: boolean;
  metric: Metric | null; fund: Fund | null; deposits: number; summary: string;
  image: string; hasImage: boolean;
  taskTotal: number; taskOpen: number; taskDone: number;
}
interface Board {
  theme: string;
  rows: Row[];
  stats: { total: number; achieved: number; overdue: number; avgProgress: number; byHorizon: Record<string, number> };
  horizons: Array<{ key: string; label: string; hint: string }>;
  areas: Array<{ key: string; label: string; gridKey: string }>;
}

const board = ref<Board | null>(null);
const loading = ref(true);
const imageUrl = ref('');
const imageBusy = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    board.value = await callDomain<Board | null>('dream.board', null, localDate());
  } finally {
    loading.value = false;
  }
  syncIfNeeded();
  await loadImage();
}

const sel = computed<Row | null>(() => {
  if (!props.dreamId || !board.value) return null;
  return board.value.rows.filter(function (r) { return r.id === props.dreamId; })[0] || null;
});
const stats = computed(() => (board.value ? board.value.stats : {
  total: 0, achieved: 0, overdue: 0, avgProgress: 0, byHorizon: {}
}));
const horizons = computed(() => (board.value ? board.value.horizons : []));
const areaGridKey = computed(() => {
  const b = board.value;
  const r = sel.value;
  if (!b || !r) return '';
  const a = b.areas.filter(function (x) { return x.key === r.area; })[0];
  return a ? a.gridKey : '';
});

// --- 表单草稿 ---
// 只在「换了一条」或「本地没有未保存改动」时从数据回填，
// 否则右栏一刷新就把用户正在敲的字冲掉（与工作格同一套规矩）。
const d = ref({
  summary: '', metricName: '', metricUnit: '', metricFrom: '', metricTo: '', metricNow: '',
  startDate: '', dueDate: '', fundYuan: '', depositYuan: ''
});

function n2s(n: number): string { return String(Number(n) || 0); }

function syncDraft(): void {
  const r = sel.value;
  const m = r ? r.metric : null;
  d.value = {
    summary: r ? r.summary || '' : '',
    metricName: m ? m.name : '',
    metricUnit: m ? m.unit : '',
    metricFrom: m ? n2s(m.from) : '',
    metricTo: m ? n2s(m.to) : '',
    metricNow: m ? n2s(m.current) : '',
    startDate: r ? r.startDate || '' : '',
    dueDate: r ? r.dueDate || '' : '',
    fundYuan: r && r.fund ? String(Math.round(r.fund.target / 100)) : '',
    depositYuan: ''
  };
}

const dirty = computed<boolean>(function () {
  const r = sel.value;
  if (!r) return false;
  const m = r.metric;
  return d.value.summary !== (r.summary || '')
    || d.value.metricName !== (m ? m.name : '')
    || d.value.metricUnit !== (m ? m.unit : '')
    || d.value.metricFrom !== (m ? n2s(m.from) : '')
    || d.value.metricTo !== (m ? n2s(m.to) : '')
    || d.value.metricNow !== (m ? n2s(m.current) : '')
    || d.value.startDate !== (r.startDate || '')
    || d.value.dueDate !== (r.dueDate || '');
});

let syncedId = '__init__';
function syncIfNeeded(): void {
  const id = props.dreamId || '';
  if (syncedId !== id || !dirty.value) {
    syncDraft();
    syncedId = id;
  }
}

// 草稿里的数字立刻算出进度：改「现在」就能看到百分比动，不用等保存
const draftProgress = computed<number>(function () {
  const r = sel.value;
  const name = d.value.metricName.trim();
  const from = Number(d.value.metricFrom) || 0;
  const to = Number(d.value.metricTo) || 0;
  const now = Number(d.value.metricNow) || 0;
  if (!name || to === from) return r ? r.progress : 0;
  return Math.max(0, Math.min(100, Math.round((now - from) / (to - from) * 100)));
});

// --- 图片 ---
async function loadImage(): Promise<void> {
  const id = props.dreamId || '';
  if (!id) { imageUrl.value = ''; return; }
  const url = await callDomain<string>('dream.image', '', id);
  imageUrl.value = url || '';
}

async function pickImage(): Promise<void> {
  const r = sel.value;
  if (!r || imageBusy.value) return;
  imageBusy.value = true;
  try {
    const picked = await pickImageFile();
    if (!picked || picked.canceled || !picked.paths || !picked.paths.length) return;
    const res = await callDomain<{ ok?: boolean; reason?: string } | null>(
      'dream.setImage', null, r.id, picked.paths[0]
    );
    if (!res || res.ok !== true) {
      emit('notify', (res && res.reason) || '图片没存成，换一张试试');
      return;
    }
    await loadImage();
    emit('changed');
    emit('notify', '图片已换上');
  } finally {
    imageBusy.value = false;
  }
}

async function clearImage(): Promise<void> {
  const r = sel.value;
  if (!r || imageBusy.value) return;
  imageBusy.value = true;
  try {
    await callDomain('dream.clearImage', null, r.id);
    imageUrl.value = '';
    emit('changed');
    emit('notify', '已移除这张图片');
  } finally {
    imageBusy.value = false;
  }
}

// --- 写 ---
// 账户金额按「元」输入、按「分」落库：和账本同一口径，避免 0.1+0.2 那种小数漂移
function yuanToCents(v: string): number {
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}
function yuan(cents: number): string {
  return (Math.round((Number(cents) || 0) / 100)).toLocaleString('zh-CN');
}

async function save(): Promise<void> {
  const r = sel.value;
  if (!r) return;
  const name = d.value.metricName.trim();
  const patch: Record<string, unknown> = {
    summary: d.value.summary,
    startDate: d.value.startDate,
    dueDate: d.value.dueDate,
    // 指标名留空 = 这条不量化：把 metric 显式写成 null，而不是留一份空壳
    metric: name ? {
      name: name,
      unit: d.value.metricUnit.trim(),
      from: Number(d.value.metricFrom) || 0,
      to: Number(d.value.metricTo) || 0,
      current: Number(d.value.metricNow) || 0
    } : null
  };
  await callDomain('dream.update', null, r.id, patch);
  emit('changed');
  await load();
  emit('notify', '已保存「' + r.title + '」');
}

async function saveFund(): Promise<void> {
  const r = sel.value;
  if (!r) return;
  const cents = yuanToCents(d.value.fundYuan);
  await callDomain('dream.setFund', null, r.id, cents);
  emit('changed');
  await load();
  emit('notify', cents ? '梦想账户已设为目标 ¥' + yuan(cents) : '已关闭这条的梦想账户');
}

async function putIn(): Promise<void> {
  const r = sel.value;
  if (!r) return;
  const cents = yuanToCents(d.value.depositYuan);
  if (!cents) { emit('notify', '先填一个金额'); return; }
  await callDomain('dream.deposit', null, r.id, cents, localDate(), '存入梦想账户', 'money');
  d.value.depositYuan = '';
  emit('changed');
  await load();
  emit('notify', '已存入 ¥' + (cents / 100).toFixed(2).replace(/\.00$/, ''));
}

// 拆成行动：目标不落到「下一步」，就永远停在纸上
async function makeAction(): Promise<void> {
  const r = sel.value;
  if (!r) return;
  const res = await callDomain<{ tasks?: Array<{ id: string }> } | null>('gtd.add', null, {
    title: r.title.slice(0, 40),
    status: 'next',
    project: r.title.slice(0, 24)
  });
  const tasks = res && Array.isArray(res.tasks) ? res.tasks : [];
  const last = tasks[tasks.length - 1];
  if (!last) { emit('notify', '拆解失败：未能写入 GTD'); return; }
  await callDomain('dream.linkTask', null, r.id, last.id);
  emit('changed');
  await load();
  emit('notify', '已在 GTD 建了一条下一步，并挂到这个目标上');
}

onMounted(load);
watch(function () { return props.tick; }, load);
watch(function () { return props.dreamId; }, function () {
  syncDraft();
  syncedId = props.dreamId || '';
  imageUrl.value = '';
  void loadImage();
});
</script>

<template>
  <!-- 图片窗：不管有没有选中都占着这一格。梦想是「看见」才想要的东西，
       所以它排在最上面，不是详情里的一个字段。 -->
  <section class="ctx-card dctx-photo-card">
    <h2 class="ctx-title">
      梦想图片
      <span v-if="sel" class="ctx-tag">{{ sel.horizonLabel }}</span>
    </h2>
    <div class="dctx-photo" :class="{ 'dctx-photo-empty': !imageUrl }">
      <img v-if="imageUrl" :src="imageUrl" :alt="(sel ? sel.title : '') + ' 的具象化图片'" />
      <div v-else class="dctx-photo-hold">
        <span class="dctx-photo-glyph" aria-hidden="true">◫</span>
        <p v-if="sel" class="dctx-photo-tip">给「{{ sel.title }}」配一张图<br />做到之后，会看到的样子</p>
        <p v-else class="dctx-photo-tip">先在左边点一个目标<br />这里放它「做到之后」的样子</p>
      </div>
      <span v-if="sel && imageUrl" class="dctx-photo-cap">{{ sel.title }}</span>
    </div>
    <div class="dctx-photo-bar">
      <button
        class="dctx-btn dctx-btn-main"
        :disabled="!sel || imageBusy"
        :title="sel ? '从本机选一张图片' : '先在左边选中一个目标'"
        @click="pickImage"
      >{{ imageUrl ? '换一张' : '选一张图片' }}</button>
      <button v-if="imageUrl" class="dctx-btn" :disabled="imageBusy" @click="clearImage">移除</button>
      <span class="dctx-photo-note">只存本机，不进备份</span>
    </div>
  </section>

  <!-- 选中那条：详细设置全部可写 -->
  <section v-if="sel" class="ctx-card dctx-detail">
    <h2 class="ctx-title dctx-name">
      {{ sel.title }}
      <span v-if="sel.status === 'done'" class="ctx-tag">已达成</span>
      <span v-else-if="sel.overdue" class="ctx-tag ctx-tag-warn">超期</span>
    </h2>
    <p class="dctx-meta">
      {{ sel.areaLabel }} · {{ sel.statusLabel }} · 进度 {{ draftProgress }}%
      <template v-if="sel.dueDate"> · {{ sel.dueDate }}<span :class="{ 'ctx-warn': sel.overdue }"> · {{ sel.pace }}</span></template>
    </p>

    <div class="dctx-sec">
      <h3 class="dctx-h">量化分析</h3>
      <label class="dctx-field dctx-wide">
        <span>指标</span>
        <input v-model="d.metricName" maxlength="20" placeholder="如 每周达标天数（留空 = 不量化）" aria-label="量化指标名" />
      </label>
      <div class="dctx-grid">
        <label class="dctx-field"><span>从</span><input v-model="d.metricFrom" type="number" aria-label="起始值" /></label>
        <label class="dctx-field"><span>到</span><input v-model="d.metricTo" type="number" aria-label="目标值" /></label>
        <label class="dctx-field"><span>现在</span><input v-model="d.metricNow" type="number" aria-label="当前值" /></label>
        <label class="dctx-field"><span>单位</span><input v-model="d.metricUnit" maxlength="10" placeholder="天" aria-label="单位" /></label>
      </div>
      <p class="dctx-hint">进度按数字算：<em>{{ draftProgress }}%</em>——写进度条是主观的，填数字不是。</p>
    </div>

    <div class="dctx-sec">
      <h3 class="dctx-h">梦想账户</h3>
      <div class="dctx-row">
        <label class="dctx-field dctx-grow">
          <span>目标金额 ¥</span>
          <input v-model="d.fundYuan" type="number" min="0" placeholder="例如 80000" aria-label="梦想账户目标金额（元）" />
        </label>
        <button class="dctx-btn" @click="saveFund">{{ sel.fund ? '改目标' : '开启账户' }}</button>
      </div>
      <template v-if="sel.fund">
        <div class="dctx-bar-row">
          <div class="dctx-bar"><span :style="{ width: sel.fund.pct + '%' }"></span></div>
          <p class="dctx-hint">
            已存 ¥{{ yuan(sel.fund.saved) }} / {{ yuan(sel.fund.target) }}
            <template v-if="sel.fund.ready"> · <em>已存够，可以动手</em></template>
            <template v-else> · 还差 ¥{{ yuan(sel.fund.target - sel.fund.saved) }}</template>
          </p>
        </div>
        <div class="dctx-row">
          <label class="dctx-field dctx-grow">
            <span>存入金额 ¥</span>
            <input v-model="d.depositYuan" type="number" min="0" placeholder="从金钱账户划进来" aria-label="存入金额（元）" />
          </label>
          <button class="dctx-btn" @click="putIn">存入</button>
        </div>
        <p class="dctx-hint">存够会浮窗提醒，直到这条被标记达成。</p>
      </template>
      <p v-else class="dctx-hint">设一个金额，就变成「存够了就动手」的目标：钱不到位先攒，钱到位了不该再拖。</p>
    </div>

    <div class="dctx-sec">
      <h3 class="dctx-h">关联项</h3>
      <p class="dctx-hint">
        已关联 <strong>{{ sel.taskTotal }}</strong> 条行动
        <template v-if="sel.taskTotal">（未完成 {{ sel.taskOpen }} 条）</template>
      </p>
      <div class="dctx-links">
        <button class="dctx-btn" @click="makeAction">在 GTD 建一条下一步</button>
        <button v-if="areaGridKey" class="dctx-btn" @click="emit('open-cell', areaGridKey)">去「{{ sel.areaLabel }}」模块</button>
      </div>
    </div>

    <div class="dctx-sec">
      <h3 class="dctx-h">日期与总结</h3>
      <div class="dctx-grid">
        <label class="dctx-field"><span>开始</span><input v-model="d.startDate" type="date" aria-label="开始日期" /></label>
        <label class="dctx-field"><span>截止</span><input v-model="d.dueDate" type="date" aria-label="截止日期" /></label>
      </div>
      <textarea
        v-model="d.summary"
        class="dctx-summary"
        rows="3"
        maxlength="400"
        placeholder="为什么是这个目标？做到之后是什么样？"
        aria-label="总结"
      ></textarea>
      <div class="dctx-actions">
        <button class="dctx-btn dctx-btn-main" @click="save">保存这条</button>
        <span v-if="dirty" class="dctx-dirty">有未保存改动</span>
      </div>
    </div>
  </section>

  <section v-else class="ctx-card">
    <h2 class="ctx-title">详细设置</h2>
    <p class="ctx-muted">
      左边点一行目标，这里换成它的量化分析、梦想账户、日期与总结——改完点「保存这条」。
      中栏只看板，改东西集中在右栏，避免同一份数据两个入口。
    </p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">
      三档期限
      <span class="ctx-tag">{{ stats.total }} 个</span>
    </h2>
    <div class="ctx-grid ctx-grid-3">
      <div v-for="h in horizons" :key="h.key" class="ctx-kv">
        <span class="ctx-kv-label">{{ h.label }}</span>
        <span class="ctx-kv-val">{{ stats.byHorizon[h.key] || 0 }}<span class="ctx-kv-unit">个</span></span>
      </div>
    </div>
    <p class="ctx-muted">
      平均进度 {{ stats.avgProgress }}%<template v-if="stats.achieved"> · 已达成 {{ stats.achieved }} 个</template>
      <template v-if="stats.overdue"> · <span class="ctx-warn">超期 {{ stats.overdue }} 个</span></template>
      <template v-if="loading"> · 读取中…</template>
    </p>
  </section>
</template>

<style scoped>
/* 图片窗：固定 16:10，占位与真图同高，换图时右栏不跳 */
.dctx-photo {
  position: relative;
  aspect-ratio: 16 / 10;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  overflow: hidden;
}
.dctx-photo-empty {
  border-style: dashed;
  display: grid;
  place-items: center;
}
.dctx-photo img { display: block; width: 100%; height: 100%; object-fit: cover; }
.dctx-photo-hold { text-align: center; padding: 8px 10px; }
.dctx-photo-glyph { display: block; font-size: var(--text-h1); line-height: 1; color: var(--palette-border); margin-bottom: 6px; }
.dctx-photo-tip { margin: 0; font-size: var(--text-xs); line-height: 1.6; color: var(--surface-muted); }
/* 图上压标题：一屏里图片多起来时，得知道这张是谁的 */
.dctx-photo-cap {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 12px 8px 5px;
  font-size: var(--text-xs);
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dctx-photo-bar { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.dctx-photo-note { font-size: var(--text-xs); color: var(--surface-muted); }

.dctx-name { font-size: var(--text-body); color: var(--surface-text); }
.dctx-meta { margin: 2px 0 0; font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.6; }

.dctx-sec { margin-top: var(--space-2); padding-top: var(--space-2); border-top: 0.5px dashed var(--surface-border); }
.dctx-h { margin: 0 0 5px; font-size: var(--text-xs); font-weight: 500; color: var(--surface-muted); letter-spacing: 0.02em; }

.dctx-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.dctx-field { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: var(--text-xs); color: var(--surface-muted); }
.dctx-field > span { flex: 0 0 auto; }
.dctx-field input {
  flex: 1 1 auto; min-width: 0; width: 100%;
  padding: 3px 6px; font-size: var(--text-xs);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel); outline: none; color: var(--surface-text);
}
.dctx-field input:focus { border-color: var(--palette-border); }
.dctx-wide { margin-bottom: 5px; }
.dctx-grow { flex: 1 1 auto; }
.dctx-row { display: flex; align-items: center; gap: 6px; margin-top: 5px; }

.dctx-btn {
  flex: 0 0 auto;
  padding: 3px 10px; font-size: var(--text-xs);
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-panel); color: var(--surface-text);
}
.dctx-btn:hover:not(:disabled) { border-color: var(--palette-border); color: var(--palette-primary); }
.dctx-btn:disabled { opacity: 0.45; }
.dctx-btn-main { background: var(--palette-primary); border-color: var(--palette-primary); color: var(--palette-on); }
.dctx-btn-main:hover:not(:disabled) { color: var(--palette-on); }

.dctx-hint { margin: 5px 0 0; font-size: var(--text-xs); line-height: 1.6; color: var(--surface-muted); }
.dctx-hint em { font-style: normal; color: var(--palette-primary); }
.dctx-bar-row { margin-top: 6px; }
.dctx-bar { height: 4px; border-radius: 999px; background: var(--surface-panel); overflow: hidden; }
.dctx-bar > span { display: block; height: 100%; background: var(--palette-accent); }
.dctx-links { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.dctx-summary {
  width: 100%; margin-top: 6px; padding: 5px 7px; resize: vertical;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-panel); outline: none; font-size: var(--text-xs); line-height: 1.6;
  color: var(--surface-text);
}
.dctx-summary:focus { border-color: var(--palette-border); }
.dctx-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.dctx-dirty { font-size: var(--text-xs); color: var(--state-warn); }
</style>
