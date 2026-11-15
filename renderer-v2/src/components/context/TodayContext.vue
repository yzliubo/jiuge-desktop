<script setup lang="ts">
// 「今天」的右栏：今日状态 + 九格进度 + 未来 7 天 + 往年今天。
// 往年今天是真数据（sameDayAcrossYears），点一行直接进时间轴看完整来回；
// 不再像旧版那样只摆两个没有点击行为的「2025 年同日」按钮。
//
// 「未来 7 天」放右栏而不放中栏（docs/07 §5-2）：中栏已有问候条 / 六点 / 九格 /
// 今日补充 / 三模块五块，再塞一块会把九格主角挤下去。右栏「只读 + 跳转」正好装它。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { useWeather } from '../../composables/useWeather';
import { GRID_KEYS, GRID_LABELS, localDate, type DiaryRecord, type ViewKey } from '../../types';

const props = defineProps<{ record: DiaryRecord; total: number; written: number; tick?: number }>();
const emit = defineEmits<{
  (e: 'open-cell', key: string): void;
  (e: 'navigate', key: ViewKey): void;
}>();

interface PastRow { date: string; year: string; chars: number; brief: string }
interface SoonRow { key: string; date: string; days: number; when: string; title: string; kind: 'task' | 'capsule' | 'milestone'; hint: string }
// V3.8：成长主线卡的只读形状。证据来自 dream.board 的派生（近 30 天完成的任务 / 存入的钱），
// 不在这里做任何统计口径的二次加工——两处各算一遍，迟早算成两个数。
interface GoalRow {
  id: string; title: string; areaLabel: string; progress: number; pace: string;
  status: string; priority: string; dueDays: number | null;
  evidence: { has: boolean; text: string } | null;
}
interface DreamTrail {
  rows?: GoalRow[];
  stats?: { evidenceCount?: number; staleCount?: number };
  evidenceDays?: number;
}
interface NowRead {
  id: string; title: string; pct: number; progressText: string; status: string; lastReadAt: number;
}

const past = ref<PastRow[]>([]);
const pastLoading = ref(true);
const filled = computed(() => GRID_KEYS.filter(function (k) { return !!props.record.cells[k]; }));

// 天气档位与首页联网天气同源时标一下出处：让人一眼看出「这是窗外带进来的」，
// 而不是某天随手选的。手选的值与联网值不同就不标——那是有意写下的心情背景。
const wx = useWeather();
const wxTag = computed(() => {
  const w = wx.autoWeather.value;
  const saved = String((props.record.base || {}).weather || '');
  return w && saved === w ? '联网' : '';
});

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

// --- V3.8 成长主线（只读三源：目标 / GTD / 书架）---
// 「今天」这一页回答的是「我今天怎么样」。可九格日记填得再满，也可能一年没靠近目标一步。
// 这张卡只做一件事：把长期那条线摆到当天眼前——在推什么、本周推进了什么、在读什么。
// 三源全是只读派生，点一下只跳转，任何写操作都不在这里发生。
const trail = ref<DreamTrail | null>(null);
const trailLoading = ref(true);
const weekDone = ref(0);
const leafNext = ref(0);
const nowRead = ref<NowRead | null>(null);

const allGoals = computed<GoalRow[]>(function () {
  const rows = (trail.value && trail.value.rows) || [];
  return rows.filter(function (r) { return r.status === 'doing'; });
});
// 先看优先级高的，再看快到期的；没期限的排最后。
// 只铺 2 条：这张卡插在「九格进度」与「未来 7 天」之间，铺 3 条会把未来 7 天整块挤出首屏。
// 放不下的给一句「还有 N 个」——和 V3.6 学习右栏同一套取舍。
const GOAL_LIMIT = 2;
const goals = computed<GoalRow[]>(function () {
  return allGoals.value.slice().sort(function (a, b) {
    const pa = a.priority === 'high' ? 0 : 1;
    const pb = b.priority === 'high' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const da = (a.dueDays === null || a.dueDays === undefined) ? 99999 : a.dueDays;
    const db = (b.dueDays === null || b.dueDays === undefined) ? 99999 : b.dueDays;
    if (da !== db) return da - db;
    return b.progress - a.progress;
  }).slice(0, GOAL_LIMIT);
});
const goalTotal = computed<number>(function () { return allGoals.value.length; });
const goalMore = computed<number>(function () { return Math.max(0, allGoals.value.length - GOAL_LIMIT); });
const staleCount = computed<number>(function () {
  const st = trail.value && trail.value.stats;
  return (st && Number(st.staleCount)) || 0;
});
const evidenceDays = computed<number>(function () {
  return (trail.value && trail.value.evidenceDays) || 30;
});

async function loadTrail(): Promise<void> {
  trailLoading.value = true;
  try {
    const today = localDate();
    const [db, gb, rb] = await Promise.all([
      callDomain<DreamTrail | null>('dream.board', null, today),
      callDomain<{ stats?: { doneThisWeek?: number; leafNext?: number } } | null>('gtd.board', null, today),
      callDomain<{ books?: NowRead[] } | null>('reading.board', null)
    ]);
    trail.value = db;
    const st = (gb && gb.stats) || {};
    weekDone.value = Number(st.doneThisWeek) || 0;
    leafNext.value = Number(st.leafNext) || 0;
    // 只认「在读」状态：想读还没翻的不算，否则这张卡会变成愿望清单的复印件
    const books = (rb && rb.books) || [];
    const reading = books.filter(function (b) { return b.status === 'reading'; })
      .sort(function (a, b) { return (b.lastReadAt || 0) - (a.lastReadAt || 0); });
    nowRead.value = reading[0] || null;
  } finally {
    trailLoading.value = false;
  }
}

onMounted(function () { void load(); void loadSoon(); void loadTrail(); });
// 日期一变（跨零点 / 补看往日）三块一起重取，不留半旧半新的卡
watch(function () { return props.record.date; }, function () { void load(); void loadTrail(); });
watch(function () { return props.tick; }, function () { void loadSoon(); void loadTrail(); });
</script>

<template>
  <section class="ctx-card">
    <!-- 只读概览：显示「填了什么」而不是「填没填」。真正的编辑在本页选项卡里，
         所以这里不叫「今日状态」，避免和那张可写的卡撞名。 -->
    <h2 class="ctx-title">今天概览</h2>
    <div class="ctx-chips">
      <span class="chip" :class="{ 'chip-on': !!record.base.weather }">{{ record.base.weather || '天气未记' }}<em v-if="wxTag" class="chip-src">{{ wxTag }}</em></span>
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

  <!-- V3.8 成长主线：把长期那条线放到当天眼前。只读 + 跳转，写操作都在各自的模块里 -->
  <section class="ctx-card tc-trail" aria-label="成长主线">
    <h2 class="ctx-title">
      成长主线
      <span class="ctx-tag">{{ goalTotal }} 个在推</span>
      <span v-if="staleCount" class="ctx-tag ctx-tag-warn">{{ staleCount }} 个 {{ evidenceDays }} 天没动</span>
    </h2>
    <button
      v-for="g in goals"
      :key="g.id"
      class="tc-goal"
      :aria-label="'查看目标 ' + g.title + '，进度 ' + g.progress + '%'"
      @click="emit('navigate', 'dream')"
    >
      <span class="tc-goal-top">
        <span class="tc-goal-title">{{ g.title }}</span>
        <span class="ctx-item-side">{{ g.progress }}%</span>
      </span>
      <span class="tc-bar"><i :style="{ width: g.progress + '%' }"></i></span>
      <span class="tc-goal-meta">
        {{ g.areaLabel }}<template v-if="g.pace"> · {{ g.pace }}</template>
        · {{ g.evidence ? g.evidence.text : '没有可回查的证据' }}
      </span>
    </button>
    <p v-if="trailLoading" class="ctx-muted">读取中…</p>
    <p v-else-if="!goals.length" class="ctx-muted">
      还没有在推的目标。去梦想页写一条带数字和期限的——「今年存下 8 万」比「多挣钱」能动。
    </p>
    <p v-else-if="goalMore" class="ctx-muted">还有 {{ goalMore }} 个在推，去梦想页看全。</p>

    <div class="tc-week">
      <button class="tc-week-cell" aria-label="去 GTD 看本周完成" @click="emit('open-cell', 'work')">
        <span class="tc-week-k">本周完成</span>
        <span class="tc-week-v">{{ weekDone }} 件</span>
      </button>
      <button class="tc-week-cell" aria-label="去 GTD 看可执行下一步" @click="emit('open-cell', 'work')">
        <span class="tc-week-k">可执行</span>
        <span class="tc-week-v">{{ leafNext }} 项</span>
      </button>
      <button
        class="tc-week-cell tc-week-wide"
        :aria-label="nowRead ? '继续读《' + nowRead.title + '》' : '去图书馆挑一本在读'"
        @click="emit('navigate', 'reading')"
      >
        <span class="tc-week-k">在读</span>
        <span class="tc-week-v tc-one-line">{{ nowRead ? '《' + nowRead.title + '》 · ' + nowRead.pct + '%' : '书架还没标在读' }}</span>
      </button>
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

<style scoped>
/* 来源标只做一枚小角标，不抢「天气」两个字 */
.chip-src {
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--palette-soft);
  color: var(--palette-primary);
  font-size: var(--text-xs);
  font-style: normal;
}
/* V3.8 成长主线：每行三层（标题+百分比 / 轨道 / 领域·期限·证据），
   与学习右栏的「目前在读」同一种密度，300px 里不换行不挤成一团 */
.tc-goal {
  display: block; width: 100%; box-sizing: border-box; padding: 6px 8px;
  margin-bottom: 6px; text-align: left; cursor: pointer;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel);
}
.tc-goal:hover { border-color: var(--palette-border); }
.tc-goal-top { display: flex; align-items: baseline; gap: 6px; }
.tc-goal-title {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--text-sm); color: var(--surface-text);
}
.tc-bar {
  display: block; height: 6px; margin: 5px 0 3px; border-radius: 999px;
  background: var(--palette-soft); overflow: hidden;
  /* 只看填充段会像一条下划线：给轨道一圈极细描边，40% 才读得出「还差多少」 */
  box-shadow: inset 0 0 0 0.5px var(--surface-border);
}
.tc-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--palette-primary); }
.tc-goal-meta {
  display: block; font-size: var(--text-xs); line-height: 1.5;
  color: var(--surface-muted);
}
.tc-week { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
.tc-week-cell {
  display: block; padding: 5px 8px; text-align: left; cursor: pointer;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); min-width: 0;
}
.tc-week-cell:hover { border-color: var(--palette-border); }
.tc-week-wide { grid-column: 1 / -1; }
.tc-week-k { display: block; font-size: var(--text-xs); color: var(--surface-muted); }
.tc-week-v { display: block; font-size: var(--text-sm); color: var(--surface-text); }
.tc-one-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
