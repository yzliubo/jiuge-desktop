<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import RichText from './RichText.vue';
import { GRID_KEYS, GRID_LABELS, localDate, type DiaryRecord } from '../types';
import { callDomain } from '../composables/useDomain';
import { GRID_LIBRARY, FIRST_WEEK_EASY, gridPrompt, knownTemplate, fallbackFor } from '../composables/promptLibrary';

const props = defineProps<{
  record: DiaryRecord;
  total: number;
  date?: string;
  backfill?: boolean;
}>();

const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'open-cell', key: string): void;
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
watch(() => props.record, (value) => { draft.value = clone(value); });

const focused = ref<string>('');
const drawerOpen = ref(false);
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.record));
const filledCount = computed(() => GRID_KEYS.filter((k) => !!draft.value.cells[k]).length);

// ---------- 九格引导语（替代原来九格共用的「随手一句，可写多行」）----------
// 2026-11-12：统一改走渲染层自建语料库 promptLibrary（原创；四套模板 × 九格 + 头七天）。
// 领域层 diary-store.promptFor 仍是「自建 / 未知模板」与旧数据键的兜底，保持小程序同源行为；
// utils 是逐字节对拍基线，一律不改。休闲娱乐（leisure）此前在领域层无对应键，
// 单格工作台会显示「本格暂无引导词」，本轮由新库统一补齐。
const LEISURE_PROMPTS = GRID_LIBRARY.standard.leisure;
const LEISURE_EASY = FIRST_WEEK_EASY.leisure;

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
    if (k === 'leisure') {
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

onMounted(() => { void loadLastWritten(); void loadFocus(); void loadPrompts(); });
watch(() => props.total, () => { void loadLastWritten(); });
watch(() => props.record.date, () => { void loadFocus(); });
watch(() => props.date || props.record.date, () => { void loadPrompts(); });

function save(): void {
  emit('save', clone(draft.value));
}
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
        :class="{ 'cell-on': focused === key, 'cell-filled': !!draft.cells[key] }"
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
        <RichText
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
  padding: 2px 9px; font-size: 11px; cursor: pointer;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-panel); color: var(--surface-muted);
}
.prompt-shuffle:hover { color: var(--palette-primary); border-color: var(--palette-border); }
.date-title { font-size: 15px; font-weight: 500; margin: 0; }
.date-backfill-tag {
  margin-left: 0;
  padding: 0 7px;
  font-size: 11px;
  font-weight: 400;
  color: var(--state-warn);
  border: 0.5px solid var(--state-warn);
  border-radius: 999px;
}
.cell-gap { margin-right: auto; font-size: 10px; color: var(--surface-muted); opacity: 0.9; }
/* 「今日六条」格的进度徽标：这一格的入口在格子里，得看得出有没有在用 */
.cell-focus {
  padding: 0 6px; border-radius: 999px; font-size: 10px;
  color: var(--palette-primary); background: var(--palette-soft);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.cell-focus-on { background: var(--palette-primary); color: var(--palette-on); }
.date-sub { font-size: 12px; color: var(--surface-muted); margin: 4px 0 0; }
.badge { padding: 2px 10px; border-radius: 999px; background: var(--surface-panel); color: var(--surface-muted); font-size: 12px; }
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
  font-size: 10px;
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
  font: inherit; font-size: 12px; color: var(--palette-primary);
  text-align: left; cursor: pointer; white-space: nowrap;
}
.cell-label:hover { color: var(--palette-accent); text-decoration: underline; }
.cell-label:focus-visible {
  outline: none; color: var(--palette-accent);
  border-radius: 3px; box-shadow: 0 0 0 1px var(--palette-accent);
}
.cell-input { width: 100%; resize: vertical; border: 0; outline: none; background: transparent; line-height: 1.6; }
/* 九格里的富文本：去掉外框，让编辑区直接铺在格子里 */
.cell :deep(.rt) { border: 0; background: transparent; }
.cell :deep(.rt-body) { padding: 0; font-size: 12px; max-height: none; }
.drawer-toggle { align-self: flex-start; padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.drawer-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.drawer { display: flex; gap: var(--space-2); padding: var(--space-2); border: 0.5px dashed var(--surface-border); border-radius: var(--radius-md); }
.drawer-body-on { border-color: var(--palette-border); }
.drawer-tab { padding: 4px 10px; background: var(--surface-panel); border-radius: var(--radius-sm); }
.drawer-link { border: 0.5px solid var(--surface-border); }
.drawer-link:hover { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.actions { display: flex; align-items: center; gap: var(--space-2); }
.save-btn { padding: 8px 16px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.save-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.save-btn:disabled { opacity: 0.5; cursor: default; }
.hint { font-size: 12px; color: var(--surface-muted); }
@media (max-width: 1280px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
