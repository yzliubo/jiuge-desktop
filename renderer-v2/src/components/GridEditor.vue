<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import RichText from './RichText.vue';
import { GRID_KEYS, GRID_LABELS, localDate, type DiaryRecord } from '../types';
import { callDomain } from '../composables/useDomain';
import {
  GRID_LIBRARY, FIRST_WEEK_EASY, FAMILY_PROMPTS, FAMILY_EASY,
  gridPrompt, knownTemplate, fallbackFor
} from '../composables/promptLibrary';

const props = defineProps<{
  record: DiaryRecord;
  total: number;
  date?: string;
  backfill?: boolean;
  // 自由记录模块每写一次自增：速记与三合一都不改 record，没有别的信号能让这一格重取
  tick?: number;
  // 工作清单每次改动自增：事项完成后要回原格打「已完成」标记
  taskTick?: number;
}>();

const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'open-cell', key: string): void;
  (e: 'draft-change', dirty: boolean): void;
  // 九格里的「记一句」只写 md_freewrite，不产生 save；报一声让右栏「已填 n / 9」跟着变
  (e: 'free-note'): void;
  (e: 'notify', text: string): void;
  (e: 'task-changed'): void;
}>();

function clone(r: DiaryRecord): DiaryRecord {
  return JSON.parse(JSON.stringify(r)) as DiaryRecord;
}

// 双击进入该格主功能。落在编辑区里的双击保留系统「选词」行为，
// 否则写字时双击选词会突然跳页——这是桌面端最容易踩的交互冲突。
// 编辑区已换成 contenteditable，所以除了 TEXTAREA/INPUT 还要判 isContentEditable。
// 2026-11-11：格位标题本身已是可单击按钮，BUTTON 上的双击交给按钮的 click 处理，
// 避免同一次双击把 open-cell 连发三次。
function onCellDblClick(ev: MouseEvent, key: string): void {
  const el = ev.target as HTMLElement | null;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.isContentEditable)) return;
  emit('open-cell', key);
}

const draft = ref<DiaryRecord>(clone(props.record));
// 外壳异步取回当天日记时会多次换 record：每次都重新对一遍完成标记。
// 只在 onMounted 对一次是不够的——那会儿 record 可能还是空壳，行都还没有。
watch(() => props.record, (value) => { draft.value = clone(value); applyDoneMarks(); });

const focused = ref<string>('');
const drawerOpen = ref(false);
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.record));
// 外壳据此在切日期 / 切页前拦一次确认（P0-1），避免静默丢字
watch(dirty, (v) => emit('draft-change', v));

// ---------- 第 9 格「自由记录」：三合一当天的摘要 + 一句快记 ----------
// 2026-11-16 打通：自由记录只有一条写入口（md_freewrite），九格这一格不再是一块
// 独立正文，而是「今天在这里记了什么」的只读摘要 + 一句话入口。
// 为什么不在这里也存一份正文：同一段字存两处，删改必然不同步（docs/28 §4.1 的口径）。
// 历史 cells.free（速记旧版 / 读书摘录 / 任务转发）仍原样读出来，只是不再从这一格往里写。
interface FreeDigest {
  date: string;
  flashes: Array<{ id: string; text: string; sync: string; source: string }>;
  docs: Array<{ id: string; title: string; chars: number }>;
  counts: { flash: number; doc: number; capsule: number };
}
function emptyFree(): FreeDigest {
  return { date: '', flashes: [], docs: [], counts: { flash: 0, doc: 0, capsule: 0 } };
}
const freeDay = ref<FreeDigest>(emptyFree());
const freeText = ref('');
const freeBusy = ref(false);
const freeErr = ref('');
// 「这一格算不算写过」：三合一当天有任何内容，或历史日记格原文还在，都算
const freeHas = computed(() => {
  const c = freeDay.value.counts;
  return (c.flash + c.doc + c.capsule) > 0 || !!draft.value.cells.free;
});
// 摘要只放两条：闪念在前、长文在后。格子只有一百多像素高，列全会挤掉正文。
const freeRows = computed(function () {
  const out: Array<{ key: string; kind: string; text: string }> = [];
  freeDay.value.flashes.forEach(function (f) { out.push({ key: 'f' + f.id, kind: '闪', text: f.text }); });
  freeDay.value.docs.forEach(function (d) { out.push({ key: 'd' + d.id, kind: '文', text: d.title + ' · ' + d.chars + ' 字' }); });
  return out.slice(0, 2);
});

async function loadFreeDay(): Promise<void> {
  const day = props.date || props.record.date || localDate();
  const d = await callDomain<FreeDigest>('free.day', emptyFree(), day);
  freeDay.value = d && d.counts ? d : emptyFree();
}

async function addFreeNote(): Promise<void> {
  const text = freeText.value.trim();
  if (!text || freeBusy.value) return;
  freeBusy.value = true;
  freeErr.value = '';
  try {
    const day = props.date || props.record.date || localDate();
    const res = await callDomain<{ item?: unknown } | null>('free.noteAdd', null, text, day);
    if (!res || !res.item) {
      // 不静默丢字：文本留在输入框里，用户可重试
      freeErr.value = '没存成，文本还在，再点一次';
      return;
    }
    freeText.value = '';
    await loadFreeDay();
    emit('free-note');
  } finally {
    freeBusy.value = false;
  }
}

const filledCount = computed(() => GRID_KEYS.filter((k) => !!draft.value.cells[k] || (k === 'free' && freeHas.value)).length);

// ---------- 九格引导语（替代原来九格共用的「随手一句，可写多行」）----------
// 2026-11-12：统一改走渲染层自建语料库 promptLibrary（原创；四套模板 × 九格 + 头七天）。
// 领域层 diary-store.promptFor 仍是「自建 / 未知模板」与旧数据键的兜底，保持小程序同源行为；
// utils 是逐字节对拍基线，一律不改。休闲娱乐（leisure）此前在领域层无对应键，
// 单格工作台会显示「本格暂无引导词」，本轮由新库统一补齐。
const LEISURE_PROMPTS = GRID_LIBRARY.standard.dream;
const LEISURE_EASY = FIRST_WEEK_EASY.dream;
// 第 6 格家庭亲子：与 leisure 同一处理——领域层没有对应键、四套模板的 emotion 题
// 也仍是情绪问法，所以这一格始终由本地语料库供题（不随模板换）。
const FAMILY_LIB = FAMILY_PROMPTS;

// 领域层取词失败（或浏览器预览的 mock）时，仍按模块给一句，不再退回统一占位语。
const FALLBACK_PROMPTS: Record<string, string> = (function () {
  const out: Record<string, string> = {};
  GRID_KEYS.forEach(function (k) { out[k] = fallbackFor(k) || '写点什么…'; });
  return out;
})();

const prompts = ref<Record<string, string>>({ ...FALLBACK_PROMPTS });
const shuffle = ref(0);
const firstWeek = ref(false);

// 按「日期 + 格位」生成稳定的伪随机偏移：每天、每格换一句，
// 但同一天反复进出九格不会跳字——写字时提示语乱动比不随机更烦人。
// 点「换一批」时整体 +1，用户主动换的这一批仍在同一套题库里。
function dailyOffset(key: string, date: string): number {
  let h = 0;
  const s = date + '|' + key;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return h % 8;
}

function offsetFor(key: string, date: string): number {
  // 头七天默认仍走领域层的轻松题（off === 0 才生效）；用户点过换一批就回到标准题库。
  if (firstWeek.value && shuffle.value === 0) return 0;
  return dailyOffset(key, date) + shuffle.value;
}

async function loadPrompts(): Promise<void> {
  const date = props.date || props.record.date || localDate();
  const fw = await callDomain<{ active?: boolean } | null>('firstWeekState', null);
  firstWeek.value = !!(fw && fw.active);
  const rawTpl = String((await callDomain<string>('getTemplateId', 'standard')) || 'standard');
  const tplId = knownTemplate(rawTpl) ? rawTpl : '';
  const out: Record<string, string> = {};
  await Promise.all(GRID_KEYS.map(async (k) => {
    const off = offsetFor(k, date);
    const easy = firstWeek.value && off === 0;
    const local = gridPrompt(k, tplId, date, off, easy);
    if (k === 'emotion') {
      const idx = ((off % FAMILY_LIB.length) + FAMILY_LIB.length) % FAMILY_LIB.length;
      out[k] = FAMILY_LIB[idx] || FAMILY_EASY;
      return;
    }
    if (k === 'dream') {
      // 领域层没有 leisure 键，这一格始终由本地语料库供题（四套模板各有专属题）。
      const idx = ((off % LEISURE_PROMPTS.length) + LEISURE_PROMPTS.length) % LEISURE_PROMPTS.length;
      out[k] = local || LEISURE_PROMPTS[idx] || LEISURE_EASY;
      return;
    }
    if (local) { out[k] = local; return; }
    const text = await callDomain<string>('promptFor', '', k, date, off);
    out[k] = (typeof text === 'string' && text.trim()) ? text : (FALLBACK_PROMPTS[k] || '写点什么…');
  }));
  prompts.value = out;
}

function shufflePrompts(): void {
  shuffle.value += 1;
  void loadPrompts();
}

// 内联状态提示：这一格上一次写是哪天。
// 只填空格子、且只在"隔了 7 天以上"才显示——每天都提示就等于没提示。
// 基准日是当前正在看的这一天（补记时按补记日算），不是真实今天。
const lastMap = ref<Record<string, string>>({});

function toTime(d: string): number {
  const a = String(d || '').split('-');
  if (a.length !== 3) return 0;
  return new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2])).getTime();
}

function gapHint(key: string): string {
  if (draft.value.cells[key]) return '';
  // 自由记录格另有摘要（三合一），有内容就不算「没写」
  if (key === 'free' && freeHas.value) return '';
  if (props.backfill) return '';
  // 「今日六条」格只要挑过就算用过：那一格的正文可以空着，六条本身是内容
  if (key === 'future') return '';
  const last = lastMap.value[key];
  const base = props.date || props.record.date;
  if (!last) return '还没写过';
  const gap = Math.round((toTime(base) - toTime(last)) / 86400000);
  if (gap < 7) return '';
  return gap + ' 天没写';
}

// 六条并入「未来」格后，入口藏进格子里：口头要能一眼看到今天挑了几件、完成几件。
// 只读这一格的状态（gtd.focus 是只读派生），不在这里增删。
const focusInfo = ref<{ count: number; done: number }>({ count: 0, done: 0 });
const focusBadge = computed(function () {
  const c = focusInfo.value.count;
  // 格子标签已经是「今日六条」，徽标不再重复「六条」二字，只报状态
  if (c === 0) return '未挑';
  return focusInfo.value.done + ' / ' + c;
});

async function loadFocus(): Promise<void> {
  const s = await callDomain<{ count?: number; doneCount?: number } | null>('gtd.focus', null, localDate());
  focusInfo.value = {
    count: s && typeof s.count === 'number' ? s.count : 0,
    done: s && typeof s.doneCount === 'number' ? s.doneCount : 0
  };
}

async function loadLastWritten(): Promise<void> {
  lastMap.value = await callDomain<Record<string, string>>('cell.lastWrittenMap', {});
}

// ---------- 「事项」：九格每行 → 工作下一步行动 → 完成后回原格 ----------
// 2026-11-16：不新增领域字段，用 gtd.source 存紧凑回写位置 g9|日期|格键|行号。
// 前缀 g9| 与闪念的 source 全等幂等天然隔离；gtd.refs 直读原始任务（done 组只留 7 天，不够用）。
interface TaskRef { id: string; source: string; status: string; title: string; doneAt?: number }
const DONE_MARK = '〔已完成〕';
const taskRefs = ref<TaskRef[]>([]);

function taskSource(key: string, index: number): string {
  return 'g9|' + draft.value.date + '|' + key + '|' + index;
}
function taskLines(key: string): string[] {
  if (key === 'free') {
    const legacy = (draft.value.cells.free || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    return legacy.length ? legacy : freeRows.value.map(function (r) { return r.text; });
  }
  return (draft.value.cells[key] || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function taskStat(key: string): { total: number; done: number } {
  const prefix = 'g9|' + draft.value.date + '|' + key + '|';
  const rows = taskRefs.value.filter(function (r) { return r.source.indexOf(prefix) === 0; });
  return { total: rows.length, done: rows.filter(function (r) { return r.status === 'done'; }).length };
}

// 完成时在原来的那一行末追加标记；重新打开任务也会把标记撤掉。
// 只在没有未保存正文时回写——用户正在打字时不抢编辑权。
function applyDoneMarks(): void {
  if (dirty.value) return;
  const next = clone(draft.value);
  let changed = false;
  GRID_KEYS.forEach(function (key) {
    if (key === 'free') return;
    if (!taskStat(key).total) return;
    const lines = taskLines(key);
    const marked = lines.map(function (line, i) {
      const ref = taskRefs.value.filter(function (r) { return r.source === taskSource(key, i); })[0];
      const clean = line.split(DONE_MARK).join('').trim();
      return ref && ref.status === 'done' ? clean + ' ' + DONE_MARK : clean;
    });
    const text = marked.join('\n');
    if (text !== (draft.value.cells[key] || '')) { next.cells[key] = text; changed = true; }
  });
  if (changed) emit('save', next);
}

async function loadTaskRefs(): Promise<void> {
  taskRefs.value = await callDomain<TaskRef[]>('gtd.refs', [], 'g9|');
  applyDoneMarks();
}

async function makeTask(key: string): Promise<void> {
  const lines = taskLines(key).filter(function (l) { return l.indexOf(DONE_MARK) < 0; }).slice(0, 40);
  if (!lines.length) { emit('notify', '这一格还没有能转成事项的内容'); return; }
  try {
    const refs = await callDomain<TaskRef[]>('gtd.refs', [], 'g9|');
    const seen: Record<string, boolean> = {};
    refs.forEach(function (r) { seen[r.source] = true; });
    let added = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const source = taskSource(key, i);
      if (seen[source]) continue;
      const title = lines[i].replace(/〔[^〕]*〕/g, '').trim().slice(0, 80) || lines[i].slice(0, 80);
      await callDomain('gtd.add', null, {
        title: title,
        status: 'next',
        source: source,
        note: '来自九格「' + GRID_LABELS[key] + '」· ' + draft.value.date
      });
      added += 1;
    }
    await loadTaskRefs();
    emit('task-changed');
    emit('notify', added ? ('已把 ' + added + ' 行放进「工作 → 下一步行动」，完成后会回到这一格') : '这几行已经在行动清单里了');
  } catch (_) {
    emit('notify', '同步失败，原文还在，请重试');
  }
}

onMounted(() => { void loadLastWritten(); void loadFocus(); void loadPrompts(); void loadFreeDay(); void loadTaskRefs(); });
watch(() => props.total, () => { void loadLastWritten(); });
watch(() => props.record.date, () => { void loadFocus(); });
watch(() => props.date || props.record.date, () => { void loadPrompts(); void loadFreeDay(); });
// 速记 / 三合一在别处写完 → 外壳自增 tick → 这里重取当天摘要
watch(() => props.tick, () => { void loadFreeDay(); });
// 工作那边勾完 / 重开任务 → 回原格补上或撤掉「已完成」
watch(() => props.taskTick, () => { void loadTaskRefs(); });

function save(): void {
  emit('save', clone(draft.value));
}
function saveIfDirty(): void {
  if (dirty.value) save();
}
defineExpose({ save, saveIfDirty });
</script>

<template>
  <section class="editor" aria-label="九格编辑区">
    <header class="date-head">
      <div>
        <!-- 2026-11-11 主理人要求取消本页日期：只去掉日期文字，
             补记态仍留一个标记（补的是哪一天由中栏顶部横幅明示），统计与保存态照旧。 -->
        <h1 v-if="backfill" class="date-title"><span class="date-backfill-tag">补记</span></h1>
        <p class="date-sub">已写 {{ filledCount }} / {{ GRID_KEYS.length }} 格 · 本机 {{ total }} 篇</p>
      </div>
      <div class="head-tools">
        <button
          class="prompt-shuffle"
          type="button"
          title="九格引导语换一批"
          @click="shufflePrompts"
        >换一批引导语 ↻</button>
        <span class="badge" :class="{ 'badge-on': dirty }">{{ dirty ? '未保存' : '已保存' }}</span>
      </div>
    </header>

    <div class="grid" role="group" aria-label="九格工作区">
      <!-- 注意：这里不能用 <label> 包格子。label 会把点击转发给内部第一个可标记控件，
           而格子里有「展开」按钮，结果就是点编辑区等于点展开、直接跳页。 -->
      <div
        v-for="key in GRID_KEYS"
        :key="key"
        class="cell"
        :class="{ 'cell-on': focused === key, 'cell-filled': !!draft.cells[key] || (key === 'free' && freeHas) }"
        role="group"
        :aria-label="GRID_LABELS[key] + '格'"
        :data-cell="key"
        @focusin="focused = key"
        @focusout="focused = ''"
        @dblclick="onCellDblClick($event, key)"
      >
        <span class="cell-head">
          <!-- 标题即入口：单击直达该格主功能，与「展开」按钮、双击空白处走同一条 openCell 路由 -->
          <button
            type="button"
            class="cell-label"
            :aria-label="'进入' + GRID_LABELS[key] + '模块'"
            :title="'点击进入「' + GRID_LABELS[key] + '」模块'"
            @click.stop="emit('open-cell', key)"
          >{{ GRID_LABELS[key] }}</button>
          <!-- 事项：把本格每行同步进「工作 → 下一步行动」，完成后原行末回写〔已完成〕 -->
          <button
            type="button"
            class="cell-task"
            :class="{ 'cell-task-on': taskStat(key).total > 0 }"
            :aria-label="'把' + GRID_LABELS[key] + '转成事项'"
            :title="'把本格每行同步到工作下一步行动（已完成 ' + taskStat(key).done + ' / ' + taskStat(key).total + '）'"
            @click.stop.prevent="makeTask(key)"
          >事项<span v-if="taskStat(key).total" class="cell-task-num">{{ taskStat(key).done }}/{{ taskStat(key).total }}</span></button>
          <span
            v-if="key === 'future'"
            class="cell-focus"
            :class="{ 'cell-focus-on': focusInfo.count > 0 && focusInfo.done === focusInfo.count }"
            :title="'今日六条：已挑 ' + focusInfo.count + ' 件，完成 ' + focusInfo.done + ' 件'"
          >{{ focusBadge }}</span>
          <span v-if="gapHint(key)" class="cell-gap">{{ gapHint(key) }}</span>
          <button
            class="cell-open"
            :aria-label="'进入' + GRID_LABELS[key] + '主功能'"
            title="进入该格主功能（也可双击格子空白处）"
            @click.stop.prevent="emit('open-cell', key)"
          >展开</button>
        </span>
        <!-- 第 9 格：自由记录（三合一当天的摘要 + 一句快记）。
             不是一块独立正文——写入只有一条路（md_freewrite），这里只负责「看得见」。 -->
        <div v-if="key === 'free'" class="cf">
          <div class="cf-counts">
            <span class="cf-chip">闪念 {{ freeDay.counts.flash }}</span>
            <span class="cf-chip">长文 {{ freeDay.counts.doc }}</span>
            <span v-if="freeDay.counts.capsule" class="cf-chip">胶囊 {{ freeDay.counts.capsule }}</span>
          </div>
          <ul v-if="freeRows.length" class="cf-list">
            <li v-for="r in freeRows" :key="r.key" class="cf-row" :title="r.text">
              <span class="cf-kind">{{ r.kind }}</span>
              <span class="cf-text">{{ r.text }}</span>
            </li>
          </ul>
          <p v-else class="cf-empty">{{ prompts[key] || FALLBACK_PROMPTS[key] }}</p>
          <!-- 历史 cells.free：速记旧版 / 读书摘录 / 任务转发写下来的原文。
               只读、可滚动；继续写请走下面的快记或「打开自由记录」。 -->
          <div v-if="draft.cells.free" class="cf-legacy" :title="draft.cells.free">
            <span class="cf-kind">日记</span>
            <span class="cf-text">{{ draft.cells.free }}</span>
          </div>
          <div class="cf-add">
            <input
              v-model="freeText"
              class="cf-input"
              type="text"
              maxlength="500"
              aria-label="记一句进自由记录"
              placeholder="记一句，进自由记录…"
              @keydown.enter.prevent="addFreeNote"
            />
            <button class="cf-btn" :disabled="freeBusy || !freeText.trim()" @click="addFreeNote">记下</button>
          </div>
          <p v-if="freeErr" class="cf-err">{{ freeErr }}</p>
          <button class="cf-open" @click.stop="emit('open-cell', 'free')">打开自由记录 · 三合一 →</button>
        </div>
        <RichText
          v-else
          v-model="draft.cells[key]"
          compact
          :min-rows="3"
          :max-length="2000"
          :placeholder="prompts[key] || FALLBACK_PROMPTS[key]"
        />
      </div>
    </div>

    <button
      class="drawer-toggle"
      :class="{ 'drawer-on': drawerOpen }"
      :aria-expanded="drawerOpen"
      @click="drawerOpen = !drawerOpen"
    >直达工作台 · {{ drawerOpen ? '收起' : '展开' }}</button>
    <div v-if="drawerOpen" class="drawer" :class="{ 'drawer-body-on': drawerOpen }">
      <button class="drawer-tab drawer-link" @click="emit('open-cell', 'work')">工作看板（GTD）</button>
      <button class="drawer-tab drawer-link" @click="emit('open-cell', 'money')">记一笔收支</button>
      <button class="drawer-tab drawer-link" @click="emit('open-cell', 'growth')">学习进展</button>
    </div>

    <footer class="actions">
      <button
        class="save-btn"
        :class="{ 'save-on': dirty }"
        :disabled="!dirty"
        :aria-disabled="!dirty"
        @click="save"
      >{{ backfill ? '保存补记' : '保存今日日记' }}</button>
      <span class="hint">Ctrl+S 保存</span>
    </footer>
  </section>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.date-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.head-tools { display: flex; align-items: center; gap: 8px; }
.prompt-shuffle {
  padding: 2px 9px; font-size: var(--text-xs); cursor: pointer;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-panel); color: var(--surface-muted);
}
.prompt-shuffle:hover { color: var(--palette-primary); border-color: var(--palette-border); }
.date-title { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.date-backfill-tag {
  margin-left: 0;
  padding: 0 7px;
  font-size: var(--text-xs);
  font-weight: 400;
  color: var(--state-warn);
  border: 0.5px solid var(--state-warn);
  border-radius: 999px;
}
.cell-gap { margin-right: auto; font-size: var(--text-xs); color: var(--surface-muted); opacity: 0.9; }
/* 「今日六条」格的进度徽标：这一格的入口在格子里，得看得出有没有在用 */
.cell-focus {
  padding: 0 6px; border-radius: 999px; font-size: var(--text-xs);
  color: var(--palette-primary); background: var(--palette-soft);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.cell-focus-on { background: var(--palette-primary); color: var(--palette-on); }
.date-sub { font-size: var(--text-sm); color: var(--surface-muted); margin: 4px 0 0; }
.badge { padding: 2px 10px; border-radius: 999px; background: var(--surface-panel); color: var(--surface-muted); font-size: var(--text-sm); }
.badge-on { background: var(--palette-soft); color: var(--palette-primary); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
.cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-2);
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
}
.cell-on { border-color: var(--palette-accent); box-shadow: inset 0 0 0 1px var(--palette-accent); }
.cell-filled { background: var(--palette-soft); }
.cell-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.cell-open {
  opacity: 0;
  padding: 1px 7px;
  font-size: var(--text-xs);
  border: 0.5px solid var(--surface-border);
  border-radius: 999px;
  background: var(--surface-panel);
  color: var(--surface-muted);
  transition: opacity 0.12s ease;
}
.cell:hover .cell-open, .cell-on .cell-open { opacity: 1; }
.cell-open:hover { color: var(--palette-primary); border-color: var(--palette-border); }
/* 标题按钮：外观与原来完全一致，只多出可点击的手感与键盘焦点 */
.cell-label {
  appearance: none; -webkit-appearance: none;
  margin: 0; padding: 0; border: 0; background: transparent;
  font: inherit; font-size: var(--text-sm); color: var(--palette-primary);
  text-align: left; cursor: pointer; white-space: nowrap;
}
.cell-label:hover { color: var(--palette-accent); text-decoration: underline; }
.cell-label:focus-visible {
  outline: none; color: var(--palette-accent);
  border-radius: 3px; box-shadow: 0 0 0 1px var(--palette-accent);
}
.cell-task {
  flex: 0 0 auto;
  padding: 1px 7px;
  font-size: var(--text-xs);
  border: 0.5px solid var(--surface-border);
  border-radius: 999px;
  background: transparent;
  color: var(--surface-muted);
  cursor: pointer;
  white-space: nowrap;
}
.cell-task:hover, .cell-task-on { color: var(--palette-primary); border-color: var(--palette-accent); }
.cell-task-num { margin-left: 3px; font-variant-numeric: tabular-nums; }
.cell-input { width: 100%; resize: vertical; border: 0; outline: none; background: transparent; line-height: 1.6; }
/* 第 9 格：三合一当天摘要 + 一句快记（只读摘要，写入统一走自由记录） */
.cf { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.cf-counts { display: flex; gap: 4px; flex-wrap: wrap; }
.cf-chip {
  padding: 0 6px; border-radius: 999px; font-size: var(--text-xs);
  color: var(--palette-primary); background: var(--palette-soft);
  border: 0.5px solid var(--palette-border); white-space: nowrap;
}
.cf-list { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cf-row, .cf-legacy { display: flex; gap: 5px; min-width: 0; align-items: baseline; }
.cf-legacy { max-height: 46px; overflow: hidden; }
.cf-kind {
  flex: none; font-size: var(--text-xs); color: var(--surface-muted);
  border: 0.5px solid var(--surface-border); border-radius: 3px; padding: 0 3px;
}
.cf-text {
  min-width: 0; font-size: var(--text-sm); color: var(--surface-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cf-legacy .cf-text { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.cf-empty { margin: 0; font-size: var(--text-sm); color: var(--surface-muted); line-height: 1.5; }
.cf-add { display: flex; gap: 4px; margin-top: auto; }
.cf-input {
  flex: 1; min-width: 0; padding: 3px 7px; font-size: var(--text-sm);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel); outline: none;
}
.cf-input:focus { border-color: var(--palette-border); }
.cf-btn {
  padding: 3px 9px; font-size: var(--text-xs); white-space: nowrap;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel); color: var(--surface-text);
}
.cf-btn:hover:not(:disabled) { color: var(--palette-primary); border-color: var(--palette-border); }
.cf-btn:disabled { opacity: 0.45; cursor: default; }
.cf-err { margin: 0; font-size: var(--text-xs); color: var(--state-warn); }
.cf-open {
  align-self: flex-start; padding: 0; border: 0; background: transparent;
  font-size: var(--text-xs); color: var(--palette-primary); cursor: pointer;
}
.cf-open:hover { text-decoration: underline; }
/* 九格里的富文本：去掉外框，让编辑区直接铺在格子里 */
.cell :deep(.rt) { border: 0; background: transparent; }
.cell :deep(.rt-body) { padding: 0; font-size: var(--text-sm); max-height: none; }
.drawer-toggle { align-self: flex-start; padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.drawer-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.drawer { display: flex; gap: var(--space-2); padding: var(--space-2); border: 0.5px dashed var(--surface-border); border-radius: var(--radius-md); }
.drawer-body-on { border-color: var(--palette-border); }
.drawer-tab { padding: 4px 10px; background: var(--surface-panel); border-radius: var(--radius-sm); }
.drawer-link { border: 0.5px solid var(--surface-border); }
.drawer-link:hover { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.actions {
  position: sticky; bottom: 0; z-index: var(--z-sticky);
  display: flex; align-items: center; gap: var(--space-2);
  padding: 6px 0 4px; background: var(--surface-bg);
}
.save-btn { padding: 8px 16px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.save-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.save-btn:disabled { opacity: 0.5; cursor: default; }
.hint { font-size: var(--text-sm); color: var(--surface-muted); }
/* D1：三栏下 1361 之前都排 2 列；<=1120 右栏折成抽屉，省下的宽还给九格，保持 3 列 */
@media (min-width: 1121px) and (max-width: 1360px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* 格子标题右侧的「展开」是入口，不是正文：弱显但保证可见（P1-16） */
.cell-open { opacity: 0.6; }
.cell-open:hover, .cell-open:focus-visible { opacity: 1; }
</style>
