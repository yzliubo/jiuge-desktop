<script setup lang="ts">
// 工作格（GTD）的右栏。
//
// 2026-11-09 00:20 主理人要求：「点任务，右栏可以编辑任务详情」，并把每周回顾搬到右栏。
// 于是这一栏分四段，从上到下按「越近的越上」排：
//   1. 任务详情 —— 跟着中栏选中行走，可改标题/状态/情境/项目/到期/等待/备注，可拆子项、删除；
//   2. 清单健康 —— 四条计数（收件箱 / 下一步 / 等待 / 日程）+ 逾期与停滞；
//   3. 先看这三条 / 最近日程 —— 点一行就选中它，中栏同步高亮；
//   4. 每周回顾 —— 五项检查 + 记录按钮，原来占中栏一整块，现在收在这里。
//
// 写边界（与中栏的分工，别再混）：
//   · 这一栏只写「当前选中的那一条」——所有写调用的第二个参数都是 sel.id；
//   · 清单级的捕获、批量完成、勾选仍在中栏，右栏不做列表操作。
import { computed, onMounted, ref, watch } from 'vue';
import { asArray, callDomain } from '../../composables/useDomain';
import { localDate } from '../../types';
import { worktimeSync, type WorktimeView } from '../../bridge';

const props = defineProps<{ taskId: string; tick?: number }>();

const emit = defineEmits<{
  (e: 'changed'): void;
  (e: 'select-task', id: string): void;
  (e: 'notify', text: string): void;
}>();

interface GtdTask {
  id: string; title: string; status: string; context: string; project: string;
  dueDate: string; waitingFor: string; note: string; createdAt: number; doneAt: number;
  parentId?: string; statusLabel?: string;
  ageDays?: number; overdue?: boolean; dueToday?: boolean; needWho?: boolean; needDate?: boolean;
  childTotal?: number; childDone?: number; openChildren?: number; container?: boolean;
}
interface GtdProject { name: string; total: number; done: number; open: number; next: number; stalled: boolean; pct: number }
interface GtdStats {
  inbox: number; next: number; waiting: number; scheduled: number; someday: number;
  overdue: number; stalledProjects: number; dueToday: number; doneThisWeek: number;
  waitingNoWho: number; scheduledNoDate: number; leafNext: number; containerNext: number;
}
interface GtdBoard {
  empty: boolean; insight: string; stats: GtdStats;
  groups: Record<string, GtdTask[]>;
  projects: GtdProject[];
  contexts?: Array<{ name: string; open: number }>;
  focus?: { count: number };
}
interface ReviewCheck { key: string; label: string; done: boolean; detail: string }
interface GtdReview {
  weekKey: string; checks: ReviewCheck[]; passed: number; total: number;
  reviewedThisWeek: boolean; insight: string;
}

const STATUS_LABEL: Record<string, string> = {
  inbox: '收件箱', next: '下一步', waiting: '等待', scheduled: '日程', someday: '将来也许', done: '已完成'
};
const STATUS_FLOW = ['inbox', 'next', 'waiting', 'scheduled', 'someday'] as const;
const PRESET_CONTEXTS = ['@电脑', '@电话', '@外出', '@会议', '@家', '@阅读'];

const board = ref<GtdBoard | null>(null);
const review = ref<GtdReview | null>(null);
const tasks = ref<GtdTask[]>([]);
const loading = ref(true);
const msg = ref('');
let msgTimer: ReturnType<typeof setTimeout> | null = null;

// 右栏两个输入框的候选项来自工作台自己的名单：
// board.contexts 已含用户新建的情境，board.projects 只给未归档的——
// 归档项目不该在这个选择窗口里出现，否则「归档」等于没归。
const ctxOptions = computed<string[]>(() => {
  const b = board.value;
  const list = b && b.contexts ? b.contexts.map(function (c) { return c.name; }) : [];
  return list.length ? list : PRESET_CONTEXTS;
});
const projOptions = computed<string[]>(() => {
  const b = board.value;
  return b ? b.projects.map(function (p) { return p.name; }) : [];
});

function say(text: string): void {
  msg.value = text;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { msg.value = ''; }, 3000);
}

const sel = computed<GtdTask | null>(function () {
  if (!props.taskId) return null;
  return tasks.value.filter(function (t) { return t.id === props.taskId; })[0] || null;
});
const kids = computed(() => tasks.value.filter(function (t) { return t.parentId === props.taskId; }));
const focusIds = ref<string[]>([]);
const inFocus = computed(() => focusIds.value.indexOf(props.taskId) >= 0);
const askAll = ref(false);

// 表单草稿：只有「选中项变了」或「没有未保存改动」时才从数据回填，
// 否则右栏一刷新就把用户正在敲的字冲掉
const dTitle = ref('');
const dStatus = ref('inbox');
const dContext = ref('');
const dProject = ref('');
const dDue = ref('');
const dWaiting = ref('');
const dNote = ref('');

function syncDraft(): void {
  const t = sel.value;
  dTitle.value = t ? t.title : '';
  dStatus.value = t ? t.status : 'inbox';
  dContext.value = t ? t.context : '';
  dProject.value = t ? t.project : '';
  dDue.value = t ? t.dueDate : '';
  dWaiting.value = t ? t.waitingFor : '';
  dNote.value = t ? t.note : '';
  askAll.value = false;
}

const dirty = computed(function () {
  const t = sel.value;
  if (!t) return false;
  return dTitle.value !== t.title || dContext.value !== (t.context || '')
    || dProject.value !== (t.project || '') || dDue.value !== (t.dueDate || '')
    || dWaiting.value !== (t.waitingFor || '') || dNote.value !== (t.note || '');
});

// 换了一条任务就必须整份回填（否则带着上一条的草稿）；
// 同一条只在外壳说「数据变了」且本地没有未保存改动时才回填，免得冲掉正在敲的字
let syncedId = '__init__';
function syncIfNeeded(): void {
  if (syncedId !== props.taskId || !dirty.value) {
    syncDraft();
    syncedId = props.taskId;
  }
}

// --- 派生 ---
const dueSoon = computed(() => {
  const b = board.value;
  if (!b) return [];
  return asArray<GtdTask>(b.groups.scheduled)
    .filter(function (t) { return !!t.dueDate && t.status !== 'done'; }).slice(0, 3);
});
// 「先看这三条」只给能动手的：带未完成子项的父任务是容器，点开它没法动手
const nextTasks = computed(() => {
  const b = board.value;
  if (!b) return [];
  const list = asArray<GtdTask>(b.groups.next).filter(function (t) { return t.status !== 'done'; });
  const leaves = list.filter(function (t) { return !(t.openChildren && t.openChildren > 0); });
  return (leaves.length ? leaves : list).slice(0, 3);
});

async function load(): Promise<void> {
  loading.value = true;
  const [b, r, f] = await Promise.all([
    callDomain<GtdBoard | null>('gtd.board', null, localDate()),
    callDomain<GtdReview | null>('gtd.review', null, localDate()),
    callDomain<{ items?: Array<{ id: string }> } | null>('gtd.focus', null, localDate())
  ]);
  board.value = b;
  review.value = r;
  focusIds.value = (f && Array.isArray(f.items)) ? f.items.map(function (x) { return x.id; }) : [];
  const flat: GtdTask[] = [];
  if (b && b.groups) {
    Object.keys(b.groups).forEach(function (k) {
      asArray<GtdTask>(b.groups[k]).forEach(function (t) { flat.push(t); });
    });
  }
  tasks.value = flat;
  loading.value = false;
  // 选中的那条被删了（或还没选）：把选中态交回外壳，右栏回到「点一行」的空态
  if (props.taskId && !flat.some(function (t) { return t.id === props.taskId; })) {
    emit('select-task', '');
  }
  syncIfNeeded();
}

async function afterChange(text: string): Promise<void> {
  say(text);
  emit('notify', text);
  emit('changed');
}

function patchOf(): Record<string, string> {
  return {
    title: dTitle.value.trim(),
    context: dContext.value.trim(),
    project: dProject.value.trim(),
    dueDate: dDue.value,
    waitingFor: dWaiting.value.trim(),
    note: dNote.value.trim()
  };
}

async function save(): Promise<void> {
  if (!sel.value) return;
  if (!dTitle.value.trim()) { say('标题不能空着——写清这一步到底做什么'); return; }
  await callDomain('gtd.update', null, sel.value.id, patchOf());
  await afterChange('已保存这条任务的改动');
}

// 状态不是「换个标签」：日程必须有日期、等待必须写清等谁，缺了当场说，别让它悄悄进组
async function setStatus(next: string): Promise<void> {
  if (!sel.value) return;
  if (next === 'scheduled' && !dDue.value) { say('归入「日程」要先选个日子'); return; }
  if (next === 'waiting' && !dWaiting.value.trim()) { say('归入「等待」要写清等谁，否则一周后不知道该催什么'); return; }
  await callDomain('gtd.update', null, sel.value.id, patchOf());
  await callDomain('gtd.clarify', null, sel.value.id, next, {});
  dStatus.value = next;
  await afterChange('已归入「' + STATUS_LABEL[next] + '」');
}

async function toggleDone(): Promise<void> {
  const t = sel.value;
  if (!t) return;
  if (t.status === 'done') {
    await callDomain('gtd.reopen', null, sel.value.id);
    await afterChange('已重开这条任务');
    return;
  }
  if ((t.openChildren || 0) > 0) { askAll.value = true; return; }
  await callDomain('gtd.complete', null, sel.value.id);
  await afterChange('已完成');
}

async function completeAll(): Promise<void> {
  const t = sel.value;
  if (!t) return;
  const n = t.openChildren || 0;
  await callDomain('gtd.completeAll', null, sel.value.id);
  askAll.value = false;
  await afterChange('父项与 ' + n + ' 个子项已一起完成');
}

async function removeTask(): Promise<void> {
  const t = sel.value;
  if (!t) return;
  const kids = t.childTotal || 0;
  await callDomain('gtd.remove', null, sel.value.id);
  emit('select-task', '');
  await afterChange(kids > 0 ? '已删除，' + kids + ' 个子项已上抬为独立任务' : '已删除这条任务');
}

async function toggleFocus(): Promise<void> {
  const t = sel.value;
  if (!t) return;
  if (inFocus.value) {
    await callDomain('gtd.focusToggle', null, localDate(), sel.value.id, 'work');
    await afterChange('已移出今日六条');
    return;
  }
  const f = await callDomain<{ count: number } | null>('gtd.focus', null, localDate());
  if (f && f.count >= 6) { say('今日六条已满，先去「今日六条」格腾一条'); return; }
  await callDomain('gtd.focusToggle', null, localDate(), sel.value.id, 'work');
  await afterChange('已占一条今日六条');
}

// --- 子项 ---
const kidDraft = ref('');
async function addKid(): Promise<void> {
  const t = sel.value;
  const text = kidDraft.value.trim();
  if (!t || !text) return;
  await callDomain('gtd.add', null, { title: text, status: t.status, parentId: t.id });
  kidDraft.value = '';
  await afterChange('已挂一条子项——子项才是能动手的那条');
}
async function detachKid(k: GtdTask): Promise<void> {
  await callDomain('gtd.update', null, k.id, { parentId: '' });
  await afterChange('「' + k.title + '」已提升为独立任务');
}
async function toggleKid(k: GtdTask): Promise<void> {
  const call = k.status === 'done' ? 'gtd.reopen' : 'gtd.complete';
  await callDomain(call, null, k.id);
  await afterChange(k.status === 'done' ? '已重开子项' : '子项已完成');
}

async function markReviewed(): Promise<void> {
  await callDomain('gtd.markReviewed', null, localDate());
  await afterChange('本周回顾已记录');
}

// --- 本机时间源（只读卡片） ---
// 右栏只读原则的例外清单里不含它：这里只有「同步」一个动作，且同步写的是时间聚合，
// 不是任务清单。真正的开关与规则维护放在设置页（中栏），右栏只报告状态。
const wt = ref<WorktimeView | null>(null);
const wtWeek = ref<{ activeMin: number; unclassifiedRatio: number; days: number } | null>(null);
const wtBusy = ref(false);
const wtDay = computed(() => (wt.value ? wt.value.day : null));

function wtDur(sec: number): string {
  const min = Math.round(Number(sec || 0) / 60);
  if (min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h' + (min % 60 ? min % 60 + 'm' : '');
}

async function loadWt(): Promise<void> {
  wt.value = await callDomain<WorktimeView | null>('worktime.dayForView', null, localDate());
  wtWeek.value = await callDomain<{ activeMin: number; unclassifiedRatio: number; days: number } | null>('worktime.week', null, localDate());
}

async function syncWt(): Promise<void> {
  if (wtBusy.value) return;
  wtBusy.value = true;
  try {
    const r = await worktimeSync(localDate());
    if (!r || !r.ok) { say((r && r.msg) || '同步失败'); return; }
    await loadWt();
    say(r.partial ? '已同步（缺少离开记录，时长可能偏高）' : '已同步本机时间');
  } finally {
    wtBusy.value = false;
  }
}

onMounted(function () { void load(); void loadWt(); });
watch(() => props.tick, function () { void load(); void loadWt(); });
watch(() => props.taskId, function () { syncIfNeeded(); });
</script>

<template>
  <div class="work-ctx">
    <!-- 1. 任务详情：跟着中栏选中行走 -->
    <section class="ctx-card wc-detail" :class="{ 'wc-detail-on': !!sel }">
      <h2 class="ctx-title">
        任务详情
        <span v-if="sel" class="ctx-tag">{{ STATUS_LABEL[sel.status] || sel.status }}</span>
        <span v-else class="ctx-tag">未选中</span>
      </h2>

      <p v-if="!sel" class="ctx-muted">
      </p>

      <template v-else>
        <label class="wc-label" for="wc-title">标题</label>
        <input id="wc-title" v-model="dTitle" class="wc-in" maxlength="80" aria-label="任务标题" />

        <span class="wc-label">状态</span>
        <div class="wc-status">
          <button
            v-for="s in STATUS_FLOW"
            :key="s"
            class="wc-st"
            :class="{ 'wc-st-on': dStatus === s }"
            :aria-pressed="dStatus === s"
            @click="setStatus(s)"
          >{{ STATUS_LABEL[s] }}</button>
        </div>

        <div class="wc-row">
          <div class="wc-half">
            <label class="wc-label" for="wc-ctx">情境</label>
            <input id="wc-ctx" v-model="dContext" class="wc-in" maxlength="12" list="wc-ctx-list" placeholder="@电脑" aria-label="情境" />
            <datalist id="wc-ctx-list">
              <option v-for="c in ctxOptions" :key="c" :value="c"></option>
            </datalist>
          </div>
          <div class="wc-half">
            <label class="wc-label" for="wc-proj">项目</label>
            <input id="wc-proj" v-model="dProject" class="wc-in" maxlength="24" list="wc-proj-list" placeholder="可留空" aria-label="项目" />
            <datalist id="wc-proj-list">
              <option v-for="p in projOptions" :key="p" :value="p"></option>
            </datalist>
          </div>
        </div>

        <div class="wc-row">
          <div class="wc-half">
            <label class="wc-label" for="wc-due">到期</label>
            <input id="wc-due" v-model="dDue" class="wc-in" type="date" aria-label="到期日" />
          </div>
          <div class="wc-half">
            <label class="wc-label" for="wc-wait">等待谁</label>
            <input id="wc-wait" v-model="dWaiting" class="wc-in" maxlength="40" placeholder="等别人时填" aria-label="等待对象" />
          </div>
        </div>

        <label class="wc-label" for="wc-note">备注</label>
        <textarea
          id="wc-note"
          v-model="dNote"
          class="wc-in wc-note"
          maxlength="300"
          rows="3"
          placeholder="为什么要做、卡在哪、下一步线索…（300 字内）"
          aria-label="任务备注"
        ></textarea>

        <p v-if="sel.overdue" class="ctx-muted ctx-warn">已逾期：{{ sel.dueDate }}</p>
        <p v-else-if="sel.status === 'waiting' && !dWaiting" class="ctx-muted ctx-warn">未填等待对象。</p>

        <div class="wc-actions">
          <button class="wc-btn wc-save" :class="{ 'wc-dirty': dirty }" :disabled="!dirty" @click="save">
            {{ dirty ? '保存改动' : '已是最新' }}
          </button>
          <button class="wc-btn" @click="toggleDone">{{ sel.status === 'done' ? '重开' : '完成' }}</button>
          <button class="wc-btn" @click="toggleFocus">{{ inFocus ? '移出六条' : '加入今日六条' }}</button>
          <button class="wc-btn wc-del" @click="removeTask">删除</button>
        </div>

        <div v-if="askAll" class="wc-confirm" role="status">
          还有 {{ sel.openChildren }} 个子项没完成 ——
          <button class="wc-btn" @click="completeAll">一并完成</button>
          <button class="wc-btn" @click="askAll = false">先不动</button>
        </div>

        <!-- 子项：父是容器，子才是能动手的那条；这里能把子项提上来或勾掉 -->
        <div class="wc-kids">
          <span class="wc-label">子项 {{ sel.childDone || 0 }} / {{ sel.childTotal || 0 }}</span>
          <div v-for="k in kids" :key="k.id" class="wc-kid">
            <button class="wc-kid-check" :aria-pressed="k.status === 'done'" @click="toggleKid(k)">
              {{ k.status === 'done' ? '✓' : '○' }}
            </button>
            <span class="wc-kid-title" :class="{ 'wc-kid-done': k.status === 'done' }">{{ k.title }}</span>
            <button class="wc-kid-btn" @click="detachKid(k)">↑</button>
          </div>
          <div class="wc-kid-add">
            <input
              v-model="kidDraft"
              class="wc-in"
              maxlength="80"
              placeholder="拆一条能动手的子项"
              aria-label="新增子项"
              @keydown.enter.prevent="addKid"
            />
            <button class="wc-btn" @click="addKid">加入</button>
          </div>
          <p v-if="!kids.length" class="ctx-muted">还没有子项。</p>
        </div>
      </template>
    </section>

    <!-- 2. 清单健康 -->
    <section class="ctx-card">
      <h2 class="ctx-title">
        清单健康
        <span v-if="board && board.stats.inbox" class="ctx-tag">{{ board.stats.inbox }} 待厘清</span>
        <span v-else-if="board" class="ctx-tag">干净</span>
      </h2>
      <div v-if="board" class="ctx-grid">
        <div class="ctx-kv">
          <span class="ctx-kv-label">收件箱</span>
          <span class="ctx-kv-val" :class="{ 'ctx-warn': board.stats.inbox > 0 }">{{ board.stats.inbox }}<span class="ctx-kv-unit">条</span></span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">下一步</span>
          <span class="ctx-kv-val">{{ board.stats.next }}<span class="ctx-kv-unit">条</span></span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">等待</span>
          <span class="ctx-kv-val">{{ board.stats.waiting }}<span class="ctx-kv-unit">条</span></span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">日程</span>
          <span class="ctx-kv-val">{{ board.stats.scheduled }}<span class="ctx-kv-unit">条</span></span>
        </div>
      </div>
      <p v-if="board && (board.stats.overdue || board.stats.stalledProjects)" class="ctx-muted ctx-warn">
        <template v-if="board.stats.overdue">逾期 {{ board.stats.overdue }} 项</template>
        <template v-if="board.stats.overdue && board.stats.stalledProjects"> · </template>
        <template v-if="board.stats.stalledProjects">停滞项目 {{ board.stats.stalledProjects }} 个</template>
      </p>
      <p v-if="loading" class="ctx-muted">读取中…</p>
    </section>

    <!-- 3. 先看这三条 + 最近日程：点一行等于选中它 -->
    <section v-if="nextTasks.length" class="ctx-card">
      <h2 class="ctx-title">下一步 · 先看这三条</h2>
      <div class="ctx-list">
        <button
          v-for="t in nextTasks"
          :key="t.id"
          class="ctx-item"
          :class="{ 'wc-item-on': t.id === taskId }"
          @click="emit('select-task', t.id)"
        >
          <span class="ctx-item-main">{{ t.title }}</span>
          <span v-if="t.context" class="ctx-item-side">{{ t.context }}</span>
        </button>
      </div>
      <p v-if="board && board.stats.containerNext" class="ctx-muted">
        另有 {{ board.stats.containerNext }} 条是带子项的容器，没列进来——容器不能直接动手。
      </p>
    </section>

    <section v-if="dueSoon.length" class="ctx-card">
      <h2 class="ctx-title">最近日程</h2>
      <div class="ctx-list">
        <button
          v-for="t in dueSoon"
          :key="t.id"
          class="ctx-item"
          :class="{ 'wc-item-on': t.id === taskId }"
          @click="emit('select-task', t.id)"
        >
          <span class="ctx-item-main">{{ t.title }}</span>
          <span class="ctx-item-side">{{ t.dueDate.slice(5) }}</span>
        </button>
      </div>
    </section>

    <!-- 4. 每周回顾：整块从中栏搬来（中栏只留清单） -->
    <section v-if="review" class="review ctx-card" :class="{ 'gtd-review-on': review.reviewedThisWeek }">
      <h2 class="ctx-title">
        每周回顾
        <span class="ctx-tag" :class="{ 'ctx-tag-warn': !review.reviewedThisWeek }">
          {{ review.reviewedThisWeek ? '本周已记录' : '未记录' }}
        </span>
      </h2>
      <p class="wc-week">
        {{ review.weekKey }} · 五项检查通过 {{ review.passed }} / {{ review.total }}
        <span v-if="!review.reviewedThisWeek"> —— 通过数不等于做过，看完点下面的按钮</span>
      </p>
      <div
        v-for="c in review.checks"
        :key="c.key"
        class="check-row"
        :class="{ 'gtd-check-on': c.done }"
      >
        <span class="check-mark">{{ c.done ? '✓' : '·' }}</span>
        <span class="check-label">{{ c.label }}</span>
        <span class="check-detail">{{ c.detail }}</span>
      </div>
      <p class="ctx-muted">{{ review.insight }}</p>
      <div class="review-actions">
        <button class="wc-btn wc-review primary" :class="{ 'gtd-reviewed': review.reviewedThisWeek }" @click="markReviewed">
          {{ review.reviewedThisWeek ? '本周已回顾，再记一次' : '记录本次回顾' }}
        </button>
      </div>
    </section>

    <!-- 5. 本机时间源：只读报告「时间去哪了」；开关与规则在设置页，右栏不碰 -->
    <section v-if="wt && wt.enabled" class="ctx-card wc-source">
      <h2 class="ctx-title">
        本机时间源
        <span class="ctx-tag" :class="{ 'ctx-tag-warn': !!wt.error }">{{ wt.error ? '未运行' : '只读' }}</span>
      </h2>
      <div v-if="wtDay" class="wc-src-row">
        <span>活跃 <b>{{ wtDur(wtDay.activeSec) }}</b></span>
        <span>离开 {{ wtDur(wtDay.afkSec) }}</span>
        <span>未归类 <b>{{ wtDay.unclassifiedRatio }}%</b></span>
      </div>
      <p v-else class="ctx-muted">今天还没有本机记录——点下面同步一次。</p>
      <p v-if="wtWeek && wtWeek.days" class="ctx-muted">
        近 7 天投入 {{ wtWeek.activeMin }} 分钟 · 有记录 {{ wtWeek.days }} 天
      </p>
      <p v-if="wt.error" class="ctx-muted">{{ wt.error.msg }}</p>
      <div class="review-actions">
        <button class="wc-btn" :disabled="wtBusy" :aria-busy="wtBusy" @click="syncWt">
          {{ wtBusy ? '同步中…' : '同步今天' }}
        </button>
      </div>
      <p class="ctx-muted">数据来自本机 ActivityWatch；只取汇总，不读窗口标题。</p>
    </section>

    <p v-if="msg" class="wc-msg" role="status">{{ msg }}</p>
  </div>
</template>

<style scoped>
.work-ctx { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.wc-detail-on { border-color: var(--palette-border); }
.wc-label { display: block; margin: 6px 0 2px; font-size: var(--text-xs); color: var(--surface-muted); }
.wc-in {
  width: 100%; padding: 5px 8px; font-size: var(--text-sm);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel); outline: none; box-sizing: border-box;
}
.wc-in:focus { border-color: var(--palette-accent); }
.wc-note { resize: vertical; line-height: 1.6; font-family: inherit; }
.wc-row { display: flex; gap: 6px; }
.wc-half { flex: 1 1 0; min-width: 0; }
.wc-status { display: flex; flex-wrap: wrap; gap: 3px; }
.wc-st {
  padding: 3px 8px; font-size: var(--text-xs); border: 0.5px solid var(--surface-border);
  border-radius: 999px; background: var(--surface-panel); color: var(--surface-muted);
}
.wc-st-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.wc-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.wc-btn {
  padding: 4px 10px; font-size: var(--text-xs); border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm); background: var(--surface-panel);
}
.wc-btn:hover { border-color: var(--palette-border); color: var(--palette-primary); }
.wc-save { border-color: var(--palette-border); }
.wc-dirty { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.wc-save:disabled { opacity: 0.55; }
.wc-del { color: var(--state-warn); }
.wc-confirm {
  margin-top: 6px; padding: 6px 8px; font-size: var(--text-xs); line-height: 1.7;
  border-left: 2px solid var(--state-warn); background: var(--state-warn-soft);
}
.wc-kids { margin-top: 8px; padding-top: 6px; border-top: 0.5px dashed var(--surface-border); }
.wc-kid { display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); padding: 2px 0; }
.wc-kid-check { border: 0; background: transparent; color: var(--palette-primary); font-size: var(--text-xs); padding: 0 2px; }
.wc-kid-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-kid-done { text-decoration: line-through; color: var(--surface-muted); }
.wc-kid-btn { border: 0; background: transparent; color: var(--surface-muted); font-size: var(--text-xs); }
.wc-kid-add { display: flex; gap: 4px; margin-top: 4px; }
.wc-kid-add .wc-in { flex: 1; }
.wc-item-on { border-color: var(--palette-primary); background: var(--palette-soft); }
.wc-week { margin: 0 0 4px; font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.6; }
.wc-review { border-color: var(--palette-border); }
.primary { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
/* 每周回顾：原来长在中栏，样式跟着搬过来（类名不变，既有门禁按这些名字断言） */
.review { display: flex; flex-direction: column; gap: 5px; }
.gtd-review-on { border-color: var(--palette-border); }
.check-row { display: flex; gap: 6px; align-items: baseline; font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.5; }
.gtd-check-on { color: var(--palette-primary); }
.check-mark { width: 10px; flex: 0 0 10px; }
.check-label { flex: 0 0 auto; }
.check-detail { flex: 1; min-width: 0; opacity: 0.85; }
.review-actions { display: flex; gap: 6px; align-items: center; margin-top: 2px; }
.gtd-reviewed { background: var(--surface-panel); color: var(--surface-muted); border-color: var(--surface-border); }
.wc-msg {
  padding: 6px 8px; border-radius: var(--radius-sm);
  background: var(--palette-soft); color: var(--palette-primary); font-size: var(--text-xs);
}
.wc-src-row {
  display: flex; gap: 10px; font-size: var(--text-xs); color: var(--surface-muted);
  font-variant-numeric: tabular-nums;
}
.wc-src-row b { color: var(--palette-primary); }
</style>
