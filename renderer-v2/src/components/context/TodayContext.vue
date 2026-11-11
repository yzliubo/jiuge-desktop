<script setup lang="ts">
// 「今天」的右栏：今日状态 + 九格进度 + 未来 7 天 + 往年今天。
// 往年今天是真数据（sameDayAcrossYears），点一行直接进时间轴看完整来回；
// 不再像旧版那样只摆两个没有点击行为的「2025 年同日」按钮。
//
// 「未来 7 天」放右栏而不放中栏（docs/07 §5-2）：中栏已有问候条 / 六点 / 九格 /
// 今日补充 / 三模块五块，再塞一块会把九格主角挤下去。右栏「只读 + 跳转」正好装它。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { GRID_KEYS, GRID_LABELS, localDate, type DiaryRecord, type ViewKey } from '../../types';

const props = defineProps<{ record: DiaryRecord; total: number; written: number; tick?: number }>();
const emit = defineEmits<{
  (e: 'open-cell', key: string): void;
  (e: 'navigate', key: ViewKey): void;
}>();

interface PastRow { date: string; year: string; chars: number; brief: string }
interface SoonRow { key: string; date: string; days: number; when: string; title: string; kind: 'task' | 'capsule' | 'milestone'; hint: string }

const past = ref<PastRow[]>([]);
const pastLoading = ref(true);
const filled = computed(() => GRID_KEYS.filter(function (k) { return !!props.record.cells[k]; }));

// --- 未来 7 天（只读）---
const soon = ref<SoonRow[]>([]);
const soonLoading = ref(true);
const soonOverdue = ref(0);
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function dayNum(iso: string): number {
  const p = String(iso || '').split('-');
  if (p.length !== 3) return NaN;
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime();
}
function addDays(iso: string, n: number): string {
  const p = iso.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  d.setDate(d.getDate() + n);
  const q = function (x: number) { return x < 10 ? '0' + x : String(x); };
  return d.getFullYear() + '-' + q(d.getMonth() + 1) + '-' + q(d.getDate());
}
function diffDays(from: string, to: string): number {
  return Math.round((dayNum(to) - dayNum(from)) / 86400000);
}
// 「明天 / 后天 / 11-12 周四」——日期自己算，别让用户在心里数格子
function whenLabel(iso: string, days: number, today: string): string {
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === 2) return '后天';
  const p = iso.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  void today;
  return Number(p[1]) + '-' + p[2] + ' 周' + WEEK[d.getDay()];
}

async function loadSoon(): Promise<void> {
  soonLoading.value = true;
  try {
    const today = localDate();
    const rows: SoonRow[] = [];
    let overdue = 0;

    // ① GTD：任何有到期日且未完成的任务（不限分组——「下一步」也可能带日期）
    const board = await callDomain<{ groups?: Record<string, Array<Record<string, unknown>>> } | null>('gtd.board', null, today);
    const groups = (board && board.groups) || {};
    Object.keys(groups).forEach(function (g) {
      if (g === 'done') return;
      (groups[g] || []).forEach(function (t) {
        const due = String(t.dueDate || '');
        if (!due) return;
        const d = diffDays(today, due);
        if (d < 0) { overdue += 1; return; }
        if (d > 7) return;
        rows.push({
          key: 'task-' + String(t.id),
          date: due,
          days: d,
          when: whenLabel(due, d, today),
          title: String(t.title || ''),
          kind: 'task',
          hint: String(t.context || '') || '待办'
        });
      });
    });

    // ② 胶囊：还没开启、7 天内会开启的
    const cg = await callDomain<{ sealed?: Array<Record<string, unknown>> } | null>('capsuleGroups', null);
    ((cg && cg.sealed) || []).forEach(function (c) {
      const openAt = String(c.openAt || '');
      if (!openAt) return;
      const d = diffDays(today, openAt);
      if (d < 0 || d > 7) return;
      rows.push({
        key: 'cap-' + String(c.id),
        date: openAt,
        days: d,
        when: whenLabel(openAt, d, today),
        title: String(c.preview || '一封写给未来的信'),
        kind: 'capsule',
        hint: '胶囊开启'
      });
    });

    // ③ 里程碑奖励日：里程碑按「第 N 天」计，不是日历日，
    //    所以要换算成日期只能假设每天写一篇——必须写明「约」，否则是编数据
    const st = await callDomain<{ total?: number }>('stats', {});
    const mv = await callDomain<{ next?: { at: number; reward: string; remain: number } | null }>('milestoneView', {}, Number(st && st.total) || 0);
    const next = mv && mv.next;
    if (next && next.remain > 0 && next.remain <= 7) {
      const est = addDays(today, next.remain);
      rows.push({
        key: 'ms-' + next.at,
        date: est,
        days: next.remain,
        when: '约' + whenLabel(est, next.remain, today),
        title: '第 ' + next.at + ' 天 · ' + String(next.reward || '奖励'),
        kind: 'milestone',
        hint: '还需 ' + next.remain + ' 篇（按每天一篇估）'
      });
    }

    rows.sort(function (a, b) {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.kind.localeCompare(b.kind);
    });
    soon.value = rows;
    soonOverdue.value = overdue;
  } finally {
    soonLoading.value = false;
  }
}

function briefOf(rec: Record<string, unknown>): string {
  const cells = (rec.cells || {}) as Record<string, string>;
  const text = Object.keys(cells).map(function (k) { return String(cells[k] || ''); })
    .join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 24 ? text.slice(0, 24) + '…' : text;
}

async function load(): Promise<void> {
  pastLoading.value = true;
  try {
    const raw = await callDomain<unknown>('sameDayAcrossYears', [], props.record.date.slice(5));
    const thisYear = Number(props.record.date.slice(0, 4));
    const rows: PastRow[] = [];
    (Array.isArray(raw) ? raw : []).forEach(function (item) {
      const rec = (item || {}) as Record<string, unknown>;
      const date = String(rec.date || '');
      if (!date) return;
      if (Number(date.slice(0, 4)) >= thisYear) return;
      const cells = (rec.cells || {}) as Record<string, string>;
      const chars = Object.keys(cells).reduce(function (n, k) { return n + String(cells[k] || '').length; }, 0);
      rows.push({ date: date, year: date.slice(0, 4), chars: chars, brief: briefOf(rec) });
    });
    past.value = rows.slice(0, 3);
  } finally {
    pastLoading.value = false;
  }
}

// 点一行就去那件事能动手的地方：待办去 GTD 工作台、胶囊去胶囊页、里程碑去坚持页
function jump(row: SoonRow): void {
  if (row.kind === 'task') { emit('open-cell', 'work'); return; }
  if (row.kind === 'capsule') { emit('navigate', 'capsule'); return; }
  emit('navigate', 'habit');
}

onMounted(function () { void load(); void loadSoon(); });
watch(function () { return props.record.date; }, load);
// GTD 中栏改一次清单，这里就重取一次：否则刚排的日期在右栏看不见
watch(function () { return props.tick; }, loadSoon);
</script>

<template>
  <section class="ctx-card">
    <!-- 只读概览：显示「填了什么」而不是「填没填」。真正的编辑在本页选项卡里，
         所以这里不叫「今日状态」，避免和那张可写的卡撞名。 -->
    <h2 class="ctx-title">今天概览</h2>
    <div class="ctx-chips">
      <span class="chip" :class="{ 'chip-on': !!record.base.weather }">{{ record.base.weather || '天气未记' }}</span>
      <span class="chip" :class="{ 'chip-on': !!record.base.mood }">{{ record.base.mood || '心情未记' }}</span>
      <span class="chip" :class="{ 'chip-on': !!record.base.anniversary }">{{ record.base.anniversary || '无纪念日' }}</span>
    </div>
    <p class="ctx-muted">本篇 {{ written }} 字 · 本机 {{ total }} 篇</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">
      九格进度
      <span class="ctx-tag">{{ filled.length }} / {{ GRID_KEYS.length }}</span>
    </h2>
    <div class="ctx-dots">
      <button
        v-for="k in GRID_KEYS"
        :key="k"
        class="ctx-dot"
        :class="{ 'ctx-dot-on': !!record.cells[k] }"
        :aria-label="'进入' + GRID_LABELS[k] + (record.cells[k] ? '（今日已写）' : '（今日未写）')"
        @click="emit('open-cell', k)"
      >{{ GRID_LABELS[k] }}</button>
    </div>
  </section>

  <section class="ctx-card ctx-soon-card">
    <h2 class="ctx-title">
      未来 7 天
      <span v-if="soonOverdue" class="ctx-tag ctx-tag-warn">逾期 {{ soonOverdue }}</span>
      <span v-else-if="soon.length" class="ctx-tag">{{ soon.length }}</span>
    </h2>
    <button
      v-for="row in soon"
      :key="row.key"
      class="ctx-soon-row"
      :class="{ 'ctx-soon-on': row.days <= 1 }"
      :aria-label="row.when + '，' + row.title + '，' + row.hint"
      @click="jump(row)"
    >
      <span class="ctx-soon-when">{{ row.when }}</span>
      <span class="ctx-soon-tag" :data-kind="row.kind">{{ row.kind === 'task' ? '待办' : row.kind === 'capsule' ? '胶囊' : '里程碑' }}</span>
      <span class="ctx-item-main">{{ row.title }}</span>
    </button>
    <p v-if="soonLoading" class="ctx-muted">读取中…</p>
    <p v-else-if="!soon.length" class="ctx-muted">接下来 7 天没有排期。</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">
      往年今天
      <span v-if="past.length" class="ctx-tag">{{ past.length }} 年</span>
    </h2>
    <button
      v-for="(p, i) in past"
      :key="p.date"
      class="past-row"
      :class="{ 'past-on': i === 0 }"
      :aria-label="p.year + ' 年同日，' + p.chars + ' 字'"
      @click="emit('navigate', 'timeline')"
    >
      <span class="ctx-item-side">{{ p.year }}</span>
      <span class="ctx-item-main">{{ p.brief || '（仅结构数据）' }}</span>
    </button>
    <p v-if="pastLoading" class="ctx-muted">读取中…</p>
    <p v-else-if="!past.length" class="ctx-muted">往年今天还没有记录。</p>
  </section>
</template>
