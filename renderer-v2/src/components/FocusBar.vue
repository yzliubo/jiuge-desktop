<script setup lang="ts">
// 今日六条：住在「今日六条」格（原九格的「未来」格）里的六件决定。
// 2026-11-08 22:15 主理人要求：把原来中栏那条横条合并进「未来」格，该格改名「今日六条」。
// 合并后它不再抢占今日页顶部——今日页只留问候与九格，六条进入该格才展开。
// 它回答的是「今天做哪六件」——所以候选只给能动手的叶子，不给整份清单。
// 六条只存任务指针（md_gtd.focus），不复制标题；跨天不结转。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../composables/useDomain';
import { GRID_KEYS, GRID_LABELS, localDate, type DiaryRecord } from '../types';

interface FocusItem {
  id: string; cell: string; title: string; project: string; context: string;
  dueDate: string; status: string; done: boolean; overdue: boolean; dueToday: boolean; openChildren: number;
}
interface FocusState {
  today: string; date: string; stale: boolean; staleCount: number;
  count: number; doneCount: number; items: FocusItem[];
}
interface Cand { id: string; title: string; reason: string; project: string; context: string; dueDate: string }

const props = defineProps<{ record: DiaryRecord }>();
const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
}>();

const state = ref<FocusState | null>(null);
const cands = ref<Cand[]>([]);
const picking = ref(false);
const writing = ref(false);
const pickCell = ref('work');
const line = ref('');
const message = ref('');
let msgTimer: ReturnType<typeof setTimeout> | null = null;

const today = localDate();
const slots = computed(() => {
  const items = state.value ? state.value.items : [];
  const out: Array<FocusItem | null> = [];
  for (let i = 0; i < 6; i++) out.push(items[i] || null);
  return out;
});
const doneCount = computed(() => (state.value ? state.value.doneCount : 0));
const count = computed(() => (state.value ? state.value.count : 0));

function say(t: string): void {
  message.value = t;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { message.value = ''; }, 2800);
  emit('notify', t);
}

async function load(): Promise<void> {
  state.value = await callDomain<FocusState | null>('gtd.focus', null, today);
}
async function loadCands(): Promise<void> {
  const res = await callDomain<{ items?: Cand[] } | null>('gtd.focusCandidates', null, today);
  cands.value = res && Array.isArray(res.items) ? res.items : [];
}

async function openPicker(): Promise<void> {
  picking.value = true;
  await loadCands();
}

async function pick(c: Cand): Promise<void> {
  await callDomain('gtd.focusToggle', null, today, c.id, '');
  picking.value = false;
  await load();
  say('已占一格：' + c.title);
}

async function drop(item: FocusItem): Promise<void> {
  await callDomain('gtd.focusToggle', null, today, item.id, item.cell);
  await load();
  say('已从六条里移出');
}

async function toggleDone(item: FocusItem): Promise<void> {
  // 候选只给叶子，理论上不会碰到容器；仍然守一道，避免直接勾掉父任务
  if (!item.done && item.openChildren > 0) {
    say('这条还有 ' + item.openChildren + ' 个子项，先去清单里拆开');
    return;
  }
  await callDomain(item.done ? 'gtd.reopen' : 'gtd.complete', null, item.id);
  await load();
}

async function move(index: number, delta: number): Promise<void> {
  const items = (state.value ? state.value.items : []).slice();
  const to = index + delta;
  if (to < 0 || to >= items.length) return;
  const tmp = items[index];
  items[index] = items[to];
  items[to] = tmp;
  await callDomain('gtd.focusSet', null, today, items.map(function (x) { return x.id; }));
  await load();
}

async function clearAll(): Promise<void> {
  await callDomain('gtd.focusClear', null, today);
  await load();
  say('六条已清空，重新挑');
}

// 「→ 格」：完成后把这件事写成该格一句话，直接落进今天的记录
function openWrite(item: FocusItem): void {
  writing.value = true;
  pickCell.value = item.cell || 'work';
  line.value = item.title;
}

function commitWrite(): void {
  const text = line.value.trim();
  if (!text) return;
  const next = JSON.parse(JSON.stringify(props.record)) as DiaryRecord;
  const key = pickCell.value;
  const old = next.cells[key] || '';
  next.cells[key] = old ? old + '\n' + text : text;
  emit('save', next);
  writing.value = false;
  say('已写进「' + (GRID_LABELS[key] || key) + '」格');
}

onMounted(load);
</script>

<template>
  <section class="focus-bar" :class="{ 'focus-on': count > 0 }" aria-label="今日六条">
    <header class="fb-head">
      <span class="fb-stat">{{ doneCount }} / {{ count }} 完成</span>
      <span class="fb-actions">
        <button v-if="count < 6" class="fb-add" @click="openPicker">+ 挑一件</button>
        <button v-if="count > 0" class="fb-clear" @click="clearAll">清空</button>
      </span>
    </header>

    <p v-if="state && state.stale" class="fb-stale">
      今天重新挑。
    </p>

    <ol class="fb-slots">
      <li v-for="(item, i) in slots" :key="i" class="fb-slot" :class="{ 'fb-empty': !item, 'fb-got': item && item.done }">
        <span class="fb-no">{{ i + 1 }}</span>
        <template v-if="item">
          <button class="fb-check" :aria-pressed="item.done" @click="toggleDone(item)">
            {{ item.done ? '✓' : '○' }}
          </button>
          <span class="fb-text">{{ item.title }}</span>
          <span v-if="item.overdue" class="fb-tag fb-hot">逾期</span>
          <span v-else-if="item.dueToday" class="fb-tag fb-hot">今天到期</span>
          <span v-if="item.cell" class="fb-tag">{{ GRID_LABELS[item.cell] }}</span>
          <span class="fb-ops">
            <button class="fb-mini" aria-label="上移" :disabled="i === 0" @click="move(i, -1)">↑</button>
            <button class="fb-mini" aria-label="下移" :disabled="i === count - 1" @click="move(i, 1)">↓</button>
            <button v-if="item.done" class="fb-mini fb-write" @click="openWrite(item)">→ 格</button>
            <button class="fb-mini" aria-label="移出六条" @click="drop(item)">×</button>
          </span>
        </template>
        <button v-else class="fb-pick" @click="openPicker">挑一件</button>
      </li>
    </ol>

    <!-- 挑选浮层：只列能动手的，并说明为什么在候选里 -->
    <div v-if="picking" class="fb-panel" role="dialog" aria-label="挑一件放入今日六条">
      <header class="fb-panel-head">
        <strong>挑一件</strong>
        <span class="fb-hint">{{ cands.length }} 条可挑</span>
        <button class="fb-mini" @click="picking = false">关闭</button>
      </header>
      <ul class="fb-cands">
        <li v-for="c in cands" :key="c.id" class="fb-cand">
          <button class="fb-cand-btn" @click="pick(c)">
            <span class="fb-cand-title">{{ c.title }}</span>
            <span class="fb-cand-why">{{ c.reason }}</span>
            <span v-if="c.context" class="fb-tag">{{ c.context }}</span>
          </button>
        </li>
      </ul>
      <p v-if="cands.length === 0" class="fb-hint">
        没有可挑的：先在工作台把「下一步」厘清出来，或给日程定个日期。
      </p>
    </div>

    <!-- → 格：把完成的事写成该格一句话 -->
    <div v-if="writing" class="fb-panel" role="dialog" aria-label="写进某一格">
      <header class="fb-panel-head">
        <strong>写进哪一格？</strong>
        <button class="fb-mini" @click="writing = false">关闭</button>
      </header>
      <div class="fb-cells">
        <button
          v-for="k in GRID_KEYS"
          :key="k"
          class="fb-cell"
          :class="{ 'fb-cell-on': pickCell === k }"
          @click="pickCell = k"
        >{{ GRID_LABELS[k] }}</button>
      </div>
      <input v-model="line" class="fb-line" maxlength="120" aria-label="一句话" placeholder="一句话：做成了什么、留下了什么" />
      <div class="fb-panel-foot">
        <button class="fb-save" @click="commitWrite">保存到今天</button>
        <span class="fb-hint">写进今天的「{{ GRID_LABELS[pickCell] }}」格，不回填历史</span>
      </div>
    </div>

    <p v-if="message" class="fb-msg" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.focus-bar {
  display: flex; flex-direction: column; gap: 10px;
}
.focus-on .fb-stat { font-weight: 600; }
.fb-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.fb-stat { font-size: 13px; color: var(--palette-primary); font-variant-numeric: tabular-nums; }
.fb-hint { font-size: 11px; color: var(--surface-muted); }
.fb-actions { margin-left: auto; display: flex; gap: 6px; }
.fb-add, .fb-clear {
  padding: 3px 10px; border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-raised); font-size: 12px;
}
.fb-stale { margin: 0; font-size: 11px; color: var(--palette-accent); }
.fb-slots { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.fb-slot {
  display: flex; align-items: center; gap: 8px; min-height: 44px;
  padding: 8px 10px; border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md); background: var(--surface-raised); font-size: 13px;
}
.fb-empty { border-style: dashed; background: transparent; }
.fb-got { opacity: 0.62; }
.fb-no { color: var(--surface-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.fb-check { border: 0; background: transparent; color: var(--palette-primary); font-size: 13px; padding: 0; width: 16px; }
.fb-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-got .fb-text { text-decoration: line-through; }
.fb-tag { padding: 0 6px; border-radius: 999px; background: var(--surface-panel); color: var(--surface-muted); font-size: 10px; }
.fb-hot { color: var(--palette-accent); }
.fb-ops { display: flex; gap: 2px; }
.fb-mini { border: 0; background: transparent; color: var(--surface-muted); font-size: 11px; padding: 0 3px; }
.fb-mini:disabled { opacity: 0.3; }
.fb-write { color: var(--palette-primary); }
.fb-pick { border: 0; background: transparent; color: var(--surface-muted); font-size: 12px; text-align: left; flex: 1; }
.fb-panel {
  display: flex; flex-direction: column; gap: 6px; margin-top: 4px;
  padding: var(--space-2); border: 0.5px solid var(--palette-border);
  border-radius: var(--radius-md); background: var(--surface-raised);
}
.fb-panel-head { display: flex; align-items: baseline; gap: 8px; }
.fb-panel-head strong { font-size: 12px; }
.fb-panel-head .fb-mini { margin-left: auto; }
.fb-cands { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 220px; overflow: auto; }
.fb-cand-btn {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 5px 8px; border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm); background: var(--surface-panel); font-size: 12px;
}
.fb-cand-btn:hover { border-color: var(--palette-border); background: var(--palette-soft); }
.fb-cand-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-cand-why { font-size: 11px; color: var(--surface-muted); }
.fb-cells { display: flex; flex-wrap: wrap; gap: 4px; }
.fb-cell {
  padding: 3px 10px; border: 0.5px solid var(--surface-border);
  border-radius: 999px; background: var(--surface-panel); font-size: 12px;
}
.fb-cell-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.fb-line {
  padding: 6px 8px; border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md); background: var(--surface-panel); outline: none;
}
.fb-line:focus { border-color: var(--palette-accent); }
.fb-panel-foot { display: flex; align-items: center; gap: 8px; }
.fb-save { padding: 5px 12px; border: 0.5px solid var(--palette-primary); border-radius: var(--radius-md); background: var(--palette-primary); color: var(--palette-on); }
.fb-msg { margin: 0; font-size: 11px; color: var(--palette-primary); }
@media (max-width: 1100px) { .fb-slots { grid-template-columns: 1fr; } }
</style>
