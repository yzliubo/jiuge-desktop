<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import RichText from './RichText.vue';
import { GRID_KEYS, GRID_LABELS, localDate, type DiaryRecord } from '../types';
import { callDomain } from '../composables/useDomain';

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
function onCellDblClick(ev: MouseEvent, key: string): void {
  const el = ev.target as HTMLElement | null;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
  emit('open-cell', key);
}

const draft = ref<DiaryRecord>(clone(props.record));
watch(() => props.record, (value) => { draft.value = clone(value); });

const focused = ref<string>('');
const drawerOpen = ref(false);
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.record));
const filledCount = computed(() => GRID_KEYS.filter((k) => !!draft.value.cells[k]).length);

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

onMounted(() => { void loadLastWritten(); void loadFocus(); });
watch(() => props.total, () => { void loadLastWritten(); });
watch(() => props.record.date, () => { void loadFocus(); });

function save(): void {
  emit('save', clone(draft.value));
}
</script>

<template>
  <section class="editor" aria-label="九格编辑区">
    <header class="date-head">
      <div>
        <h1 class="date-title">
          {{ record.date }}
          <span v-if="backfill" class="date-backfill-tag">补记</span>
        </h1>
        <p class="date-sub">已写 {{ filledCount }} / {{ GRID_KEYS.length }} 格 · 本机 {{ total }} 篇</p>
      </div>
      <span class="badge" :class="{ 'badge-on': dirty }">{{ dirty ? '未保存' : '已保存' }}</span>
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
          <span class="cell-label">{{ GRID_LABELS[key] }}</span>
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
          placeholder="随手一句，可写多行"
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
.date-title { font-size: 15px; font-weight: 500; margin: 0; }
.date-backfill-tag {
  margin-left: 6px;
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
.cell-label { font-size: 12px; color: var(--palette-primary); }
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
