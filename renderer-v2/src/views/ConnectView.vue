<script setup lang="ts">
// 「连接」视图：把散落在全库里的检索与关联能力集中到一页。
// 五个分区都只读为主，轻操作只经 domainCall 出境；不碰本地文件、不渲染正文 HTML。
// 主进程 domain 返回形态有两种（裸值 / { data, error } 包裹），本文件用本地 unwrap 统一解包；
// import 被约定限制为三条，因此不复用 useDomain，容错逻辑写在文件内。
import { ref, computed, onMounted } from 'vue';
import { domainCall, openReader, openLibrary } from '../bridge';
import { localDate, GRID_LABELS } from '../types';

// ---- 文件内类型，不导出 ----
interface SearchHit {
  date: string;
  cells: Record<string, string>;
}
// P1-1 检索合流：书库命中行与日记命中行并排显示。
// 两边的形状不同（日记是「一天一条」，书库是「一条一个对象」），所以在视图层拉平成同一种行。
interface LibRow {
  type: string; id: string; title: string; text: string;
  bookId: string; bookTitle: string; themeId: string;
  typeLabel?: string; modeLabel?: string;
  pct?: number; progressText?: string; status?: string;
}
interface LibHits { books: LibRow[]; notes: LibRow[]; themes: LibRow[]; total: number; notesMore?: number }
interface InnerLink {
  date: string;
  cell: string;
  raw: string;
  target: string;
  type: string;
}
interface TagItem {
  id: string;
  name: string;
}
interface TagsSnapshot {
  tags: TagItem[];
  links: Array<{ target: string; tagId: string }>;
}
interface GtdTask {
  id: string;
  title: string;
  status: string;
  context: string;
  repeat: string;
  due: string;
}
interface GtdSnapshot {
  tasks: GtdTask[];
  projects: unknown[];
  contexts: unknown[];
}
interface RecurSnapshot {
  tasks: unknown[];
  logs: unknown[];
}
interface WeekRow {
  context: string;
  minutes: number;
}
interface WeekReport {
  total: number;
  byContext: WeekRow[];
}
type TabKey = 'search' | 'links' | 'tags' | 'recur' | 'time';
type SearchMode = 'include' | 'or' | 'pinyin';

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'notify', text: string): void;
  (e: 'go-date', date: string): void;
  (e: 'go-cell', key: string): void;
}>();

const today = localDate();

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'search', label: '搜索增强' },
  { key: 'links', label: '正文内链' },
  { key: 'tags', label: '轻标签' },
  { key: 'recur', label: '重复任务' },
  { key: 'time', label: '耗时记录' }
];
const MODES: Array<{ key: SearchMode; label: string }> = [
  { key: 'include', label: '包含' },
  { key: 'or', label: '或匹配' },
  { key: 'pinyin', label: '拼音' }
];
const MINUTE_PRESETS = [15, 30, 45, 60, 90];
const CELL_OPTIONS = Object.keys(GRID_LABELS)
  .filter(function (k) { return k !== 'dream'; })
  .map(function (k) { return { key: k, label: GRID_LABELS[k] }; });
const LINK_TYPES: Array<{ type: string; label: string; hint: string }> = [
  { type: 'date', label: '日期', hint: '[[2026-11-07]] 点一行跳到那一天' },
  { type: 'person', label: '人物', hint: '[[@老王]] 点一行打开「关系经营」格' },
  { type: 'capsule', label: '胶囊', hint: '[[cap:xxx]] 只读展示，给提示、不跳转' },
  // P0-3：阅读回写行尾的〔rd:xxx〕也是内链的一种——从日记点回图书馆那条笔记
  { type: 'reading', label: '读书回写', hint: '〔rd:xxx〕点一行打开图书馆找那条笔记' },
  { type: 'note', label: '便签', hint: '只读展示，不跳转' },
  { type: 'other', label: '其它', hint: '只读展示，不跳转' }
];

// ---- 通用状态 ----
const tab = ref<TabKey>('search');
const notice = ref('');
const busy = ref(false);

// ---- 分区 1：搜索增强 ----
const keyword = ref('');
const mode = ref<SearchMode>('include');
const searchHits = ref<SearchHit[]>([]);
// P1-1：书库命中（书 / 主题 / 笔记）。与日记命中并行取，各摆一块，不混成一条列表——
// 点日记行是「跳到那一天」，点书行是「打开那本书」，两种动作不能长一个样。
const libHits = ref<LibHits | null>(null);
const searched = ref(false);
const loadingSearch = ref(false);
const errSearch = ref('');

// ---- 分区 2：正文内链 ----
const links = ref<InnerLink[]>([]);
const errLinks = ref('');

// ---- 分区 3：轻标签 ----
const tags = ref<TagItem[]>([]);
const stats = ref<unknown>(null);
const newTagName = ref('');
const targetKind = ref<'diary' | 'cell'>('diary');
const cellKey = ref('work');
const targetTags = ref<TagItem[]>([]);
const tagMsg = ref('');
const errTags = ref('');

// ---- 分区 4：重复任务 / 分区 5 共用 GTD ----
const gtdTasks = ref<GtdTask[]>([]);
const recurMsg = ref('');
const errRecur = ref('');
const recurLogCount = ref(0);

// ---- 分区 5：耗时记录 ----
const timeTaskId = ref('');
const minutes = ref(30);
const customMinutes = ref('');
const weekTotal = ref(0);
const weekRows = ref<WeekRow[]>([]);
const timeMsg = ref('');
const errTime = ref('');

// ---- 工具 ----
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e || '未知错误');
}

// 主进程 domain 可能回裸值，也可能回 { data, error } 包裹；统一降级到 fallback，界面不炸页。
function unwrap<T>(raw: unknown, fallback: T): T {
  if (raw && typeof raw === 'object') {
    const o = raw as { data?: unknown; error?: unknown };
    if ('data' in o && 'error' in o) {
      if (!o.error && o.data !== undefined && o.data !== null) return o.data as T;
      return fallback;
    }
  }
  if (raw === null || raw === undefined) return fallback;
  return raw as T;
}

function say(text: string, slot?: 'tags' | 'recur' | 'time'): void {
  notice.value = text;
  emit('notify', text);
  if (slot === 'tags') tagMsg.value = text;
  if (slot === 'recur') recurMsg.value = text;
  if (slot === 'time') timeMsg.value = text;
}

function clearNotice(): void {
  notice.value = '';
}

function cellLabel(k: string): string {
  return GRID_LABELS[k] || k;
}

// ---- 模板用的纯布尔判断：避免在 :class 表达式里混入非类名字符串 ----
function isTab(k: TabKey): boolean { return tab.value === k; }
function isMode(k: SearchMode): boolean { return mode.value === k; }
function isDiary(): boolean { return targetKind.value === 'diary'; }
function isCell(): boolean { return targetKind.value === 'cell'; }
function isPreset(n: number): boolean { return minutes.value === n && customMinutes.value === ''; }
function hasTag(id: string): boolean { return targetTags.value.some(function (t) { return t.id === id; }); }

function switchTab(k: TabKey): void {
  tab.value = k;
  notice.value = '';
}
function pickMode(k: SearchMode): void {
  mode.value = k;
}
function pickPreset(n: number): void {
  minutes.value = n;
  customMinutes.value = '';
}
function onCustomInput(): void {
  const raw = customMinutes.value.trim();
  if (!raw) return;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) minutes.value = Math.round(n);
}
function setTargetKind(k: 'diary' | 'cell'): void {
  targetKind.value = k;
  void loadTargetTags();
}
function onCellChange(): void {
  void loadTargetTags();
}

const target = computed(function () {
  return targetKind.value === 'diary' ? 'diary:' + today : 'cell:' + cellKey.value;
});
const targetLabel = computed(function () {
  return targetKind.value === 'diary'
    ? '今天的日记 · ' + today
    : '格子 · ' + cellLabel(cellKey.value);
});

const groupedLinks = computed(function () {
  const known = LINK_TYPES.filter(function (g) { return g.type !== 'other'; })
    .map(function (g) { return g.type; });
  return LINK_TYPES.map(function (g) {
    const items = g.type === 'other'
      ? links.value.filter(function (l) { return known.indexOf(String(l.type)) < 0; })
      : links.value.filter(function (l) { return String(l.type) === g.type; });
    return { type: g.type, label: g.label, hint: g.hint, items: items };
  });
});

const repeatTasks = computed(function () {
  return gtdTasks.value.filter(function (t) {
    return t && String(t.repeat == null ? '' : t.repeat).trim() !== '';
  });
});

// tags.stats() 结构未写死：数组 / 对象 / 标量都转成可显示行，原样展示。
const statLines = computed<Array<{ label: string; value: string }>>(function () {
  const data = unwrap<unknown>(stats.value, null);
  if (!data) return [];
  if (Array.isArray(data)) {
    return data.map(function (it: unknown) {
      if (it && typeof it === 'object') {
        const o = it as Record<string, unknown>;
        const label = String(o.name ?? o.tag ?? o.label ?? o.id ?? '标签');
        const value = String(o.count ?? o.total ?? o.value ?? o.minutes ?? '');
        return { label: label, value: value };
      }
      return { label: String(it), value: '' };
    });
  }
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    return Object.keys(o).map(function (k) {
      const v = o[k];
      return { label: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) };
    });
  }
  return [{ label: '统计', value: String(data) }];
});

const weekMax = computed(function () {
  return Math.max.apply(null, [1].concat(weekRows.value.map(function (r) { return Number(r.minutes) || 0; })));
});
function barWidth(m: number): string {
  const pct = Math.max(2, Math.round((Number(m) || 0) / weekMax.value * 100));
  return Math.min(100, pct) + '%';
}

function excerpt(hit: SearchHit): string {
  const cells = (hit && hit.cells) || {};
  const parts: Array<{ label: string; text: string }> = [];
  Object.keys(cells).forEach(function (k) {
    const v = cells[k];
    const text = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (text) parts.push({ label: cellLabel(k), text: text });
  });
  if (!parts.length) return '（这一天还没有正文）';
  const kw = keyword.value.trim().toLowerCase();
  let pick = parts[0];
  if (kw) {
    const found = parts.find(function (p) { return p.text.toLowerCase().indexOf(kw) >= 0; });
    if (found) pick = found;
  }
  const short = pick.text.length > 64 ? pick.text.slice(0, 64) + '…' : pick.text;
  return '［' + pick.label + '］' + short;
}

function taskMeta(t: GtdTask): string {
  const parts = [
    '情境 ' + (t.context || '未填'),
    '重复 ' + (t.repeat || '—'),
    '状态 ' + (t.status || '—')
  ];
  if (t.due) parts.push('到期 ' + t.due);
  return parts.join(' · ');
}
function taskOptionLabel(t: GtdTask): string {
  const base = String(t.title || '(无标题)');
  return t.context ? base + ' · ' + String(t.context) : base;
}

// tags.for() 可能回 TagItem[] / id 字符串数组 / 带 id 的对象数组，统一成 TagItem[]。
function normalizeTagList(raw: unknown): TagItem[] {
  const data = unwrap<unknown>(raw, []);
  const arr = Array.isArray(data) ? data : [];
  return arr.map(function (it: unknown) {
    if (typeof it === 'string') {
      const hit = tags.value.find(function (t) { return t.id === it; });
      return hit ? { id: hit.id, name: hit.name } : { id: it, name: it };
    }
    if (it && typeof it === 'object') {
      const o = it as { id?: unknown; name?: unknown; tagId?: unknown };
      const id = String(o.id ?? o.tagId ?? '');
      const hit = tags.value.find(function (t) { return t.id === id; });
      return { id: id, name: String(o.name ?? (hit ? hit.name : id)) };
    }
    return { id: '', name: String(it) };
  }).filter(function (t) { return !!t.id; });
}

// ---- 分区 1：搜索 ----
async function runSearch(): Promise<void> {
  const kw = keyword.value.trim();
  if (!kw) {
    errSearch.value = '请输入关键词再搜索。';
    say(errSearch.value);
    return;
  }
  errSearch.value = '';
  loadingSearch.value = true;
  searched.value = true;
  try {
    const py = mode.value === 'pinyin';
    // P1-1：日记与书库并行取，同一个关键词、同一套匹配口径（query.js 里同一组函数）。
    // 书库那条走 search.library，返回形状与日记不同，所以在下面分组显示而不是硬拼成一个数组。
    const [raw, libRaw] = await Promise.all([
      py ? domainCall<SearchHit[]>('search.pinyin', kw) : domainCall<SearchHit[]>('search.or', kw),
      domainCall<LibHits | null>('search.library', kw, py ? 'pinyin' : '')
    ]);
    const hits = unwrap<SearchHit[]>(raw, []);
    searchHits.value = Array.isArray(hits) ? hits : [];
    libHits.value = unwrap<LibHits | null>(libRaw, null);
    if (!searchHits.value.length && !(libHits.value && libHits.value.total)) {
      say('没有找到匹配的记录，换个关键词或模式试试。');
    }
  } catch (e) {
    errSearch.value = '搜索失败：' + msgOf(e);
    searchHits.value = [];
    libHits.value = null;
  } finally {
    loadingSearch.value = false;
  }
}
// 书库命中拉平成行：书 → 主题 → 笔记，各自内部按原顺序（书在前，因为是「更粗的命中」）
const libRows = computed<LibRow[]>(function () {
  const h = libHits.value;
  if (!h) return [];
  return (h.books || []).concat(h.themes || []).concat(h.notes || []);
});
async function openLibRow(r: LibRow): Promise<void> {
  // 笔记优先开它所属的那本书（能跳到原句才有意义）；没有书就开图书馆，不假装能跳
  const bookId = r.type === 'note' ? r.bookId : (r.type === 'book' ? r.id : '');
  if (bookId) {
    const res = await openReader(bookId);
    if (res && res.ok) { say('已打开《' + (r.bookTitle || r.title) + '》'); return; }
    say((res && res.reason) || '这本书打不开，去图书馆看看');
  }
  await openLibrary();
  say('已打开图书馆');
}
function goHit(date: string): void {
  emit('go-date', date);
  say('已跳到 ' + date);
}

// ---- 分区 2：正文内链 ----
async function loadLinks(): Promise<void> {
  try {
    const raw = await domainCall<InnerLink[]>('search.linksAll');
    const arr = unwrap<InnerLink[]>(raw, []);
    links.value = Array.isArray(arr) ? arr : [];
  } catch (e) {
    errLinks.value = '读取内链失败：' + msgOf(e);
    links.value = [];
  }
}
function onLinkClick(l: InnerLink): void {
  if (l.type === 'date') {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(l.target) ? l.target : l.date;
    emit('go-date', d);
    say('已跳到 ' + d);
  } else if (l.type === 'person') {
    emit('go-cell', 'relation');
    say('已打开「关系经营」格');
  } else if (l.type === 'reading') {
    // P0-3 反查：这一行是阅读笔记回写到日记的（行尾带〔rd:id〕）。
    // 点它就去图书馆的「读书笔记」里找那条——这是从日记回到原书的唯一入口。
    void openLibrary();
    say('已打开图书馆：这条是读书笔记回写来的，去「读书笔记」里找它');
  } else if (l.type === 'capsule') {
    say('胶囊内链 [[cap:xxx]] 只读展示，本视图不跳转、不编辑正文');
  } else {
    say('便签 / 其它内链只读展示，本视图不提供跳转或编辑入口');
  }
}

// ---- 分区 3：轻标签 ----
async function loadTags(): Promise<void> {
  try {
    const raw = await domainCall<TagsSnapshot>('tags.read');
    const snap = unwrap<TagsSnapshot>(raw, { tags: [], links: [] });
    tags.value = Array.isArray(snap.tags) ? snap.tags : [];
  } catch (e) {
    errTags.value = '读取标签失败：' + msgOf(e);
    tags.value = [];
  }
}
async function loadStats(): Promise<void> {
  try {
    stats.value = await domainCall<unknown>('tags.stats');
  } catch (e) {
    errTags.value = '读取标签统计失败：' + msgOf(e);
    stats.value = null;
  }
}
async function loadTargetTags(): Promise<void> {
  try {
    const raw = await domainCall<unknown>('tags.for', target.value);
    targetTags.value = normalizeTagList(raw);
  } catch (e) {
    errTags.value = '读取目标标签失败：' + msgOf(e);
    targetTags.value = [];
  }
}
async function addTag(): Promise<void> {
  const name = newTagName.value.trim();
  if (!name) { say('标签名不能为空', 'tags'); return; }
  if (Array.from(name).length > 12) { say('标签名最多 12 个字，请缩短', 'tags'); return; }
  if (busy.value) return;
  busy.value = true;
  try {
    await domainCall<unknown>('tags.add', name);
    newTagName.value = '';
    await loadTags();
    await loadTargetTags();
    await loadStats();
    say('已新建标签「' + name + '」', 'tags');
  } catch (e) {
    errTags.value = '新建标签失败：' + msgOf(e);
  } finally {
    busy.value = false;
  }
}
async function removeTag(id: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await domainCall<unknown>('tags.remove', id);
    await loadTags();
    await loadTargetTags();
    await loadStats();
    say('已删除该标签', 'tags');
  } catch (e) {
    errTags.value = '删除标签失败：' + msgOf(e);
  } finally {
    busy.value = false;
  }
}
async function toggleTag(tag: TagItem): Promise<void> {
  if (busy.value) return;
  const has = hasTag(tag.id);
  if (!has && targetTags.value.length >= 3) {
    say('每个目标最多 3 个标签，先取消一个再打', 'tags');
    return;
  }
  busy.value = true;
  try {
    if (has) await domainCall<unknown>('tags.untag', target.value, tag.id);
    else await domainCall<unknown>('tags.tag', target.value, tag.id);
    await loadTargetTags();
    await loadStats();
    say((has ? '已取消「' : '已打上「') + tag.name + '」', 'tags');
  } catch (e) {
    errTags.value = '标签操作失败：' + msgOf(e);
  } finally {
    busy.value = false;
  }
}

// ---- 分区 4：重复任务 ----
async function loadGtd(): Promise<void> {
  try {
    const raw = await domainCall<GtdSnapshot>('gtd.read');
    const snap = unwrap<GtdSnapshot>(raw, { tasks: [], projects: [], contexts: [] });
    gtdTasks.value = Array.isArray(snap.tasks) ? snap.tasks : [];
  } catch (e) {
    const m = '读取 GTD 任务失败：' + msgOf(e);
    errRecur.value = m;
    errTime.value = m;
    gtdTasks.value = [];
  }
}
async function deriveNext(task: GtdTask): Promise<void> {
  if (String(task.repeat == null ? '' : task.repeat).trim() === '') {
    say('不是重复任务，不派生', 'recur');
    return;
  }
  if (busy.value) return;
  busy.value = true;
  try {
    const next = unwrap<GtdTask | null>(
      await domainCall<GtdTask | null>('recur.derive', task, today),
      null
    );
    if (!next) {
      say('已有同标题未完成实例，不重复派生', 'recur');
      return;
    }
    await domainCall<unknown>('gtd.add', next);
    await loadGtd();
    say('已派生下一条：' + String(next.title || '') + '（原任务保留为历史，未改动）', 'recur');
  } catch (e) {
    errRecur.value = '派生失败：' + msgOf(e);
  } finally {
    busy.value = false;
  }
}

// ---- 分区 5：耗时记录 ----
async function loadRecur(): Promise<void> {
  try {
    const raw = await domainCall<RecurSnapshot>('recur.read');
    const snap = unwrap<RecurSnapshot>(raw, { tasks: [], logs: [] });
    recurLogCount.value = Array.isArray(snap.logs) ? snap.logs.length : 0;
  } catch (e) {
    errTime.value = '读取耗时记录失败：' + msgOf(e);
    recurLogCount.value = 0;
  }
}
async function loadWeek(): Promise<void> {
  try {
    const raw = await domainCall<WeekReport>('recur.week', today);
    const w = unwrap<WeekReport>(raw, { total: 0, byContext: [] });
    weekTotal.value = Number(w.total) || 0;
    weekRows.value = Array.isArray(w.byContext) ? w.byContext : [];
  } catch (e) {
    errTime.value = '读取本周分布失败：' + msgOf(e);
    weekTotal.value = 0;
    weekRows.value = [];
  }
}
async function logMinutes(): Promise<void> {
  if (!timeTaskId.value) {
    say('请先选一个任务', 'time');
    return;
  }
  const n = Number(minutes.value);
  if (!Number.isFinite(n) || n <= 0 || n > 1440) {
    say('分钟数要是 1–1440 之间的数字', 'time');
    return;
  }
  if (busy.value) return;
  busy.value = true;
  try {
    const task = gtdTasks.value.find(function (t) { return t.id === timeTaskId.value; });
    const opts = { date: today, context: task ? String(task.context || '') : '' };
    await domainCall<unknown>('recur.log', timeTaskId.value, Math.round(n), opts);
    await loadWeek();
    await loadRecur();
    say('已记 ' + Math.round(n) + ' 分钟', 'time');
  } catch (e) {
    errTime.value = '记录耗时失败：' + msgOf(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  // 顺序加载：tags.for 要用 tags 列表把 id 映射成名字，所以标签必须先到。
  await loadTags();
  await loadTargetTags();
  await loadStats();
  await loadLinks();
  await loadGtd();
  await loadRecur();
  await loadWeek();
});
</script>

<template>
  <section class="con-root">
    <header class="con-head">
      <div class="con-head-text">
        <h2 class="con-title">连接 · 检索与关联</h2>
      </div>
      <button class="con-back" @click="emit('back')">← 返回</button>
    </header>

    <div v-if="notice" class="con-notice" role="status" @click="clearNotice">
      {{ notice }} <span class="con-notice-x">×</span>
    </div>

    <nav class="con-tabs" aria-label="连接视图分区">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="con-tab"
        :class="{ 'con-tab-on': isTab(t.key) }"
        :aria-current="isTab(t.key) ? 'page' : undefined"
        @click="switchTab(t.key)"
      >{{ t.label }}</button>
    </nav>

    <div class="con-body">
      <!-- 1 搜索增强 -->
      <section v-if="tab === 'search'" class="con-panel">
        <div class="con-panel-head">
          <h3 class="con-panel-title">搜索增强</h3>
        </div>
        <p v-if="errSearch" class="con-err" role="alert">{{ errSearch }}</p>

        <div class="con-search-bar">
          <input
            v-model="keyword"
            class="con-input"
            type="text"
            placeholder="输入关键词，如 复盘 / A | B / zs"
            @keyup.enter="runSearch"
          />
          <button class="con-btn con-search-btn" :disabled="loadingSearch || busy" @click="runSearch">
            {{ loadingSearch ? '搜索中…' : '搜索' }}
          </button>
        </div>
        <div class="con-modes">
          <span class="con-label">模式</span>
          <button
            v-for="m in MODES"
            :key="m.key"
            class="con-mode"
            :class="{ 'con-mode-on': isMode(m.key) }"
            @click="pickMode(m.key)"
          >{{ m.label }}</button>
        </div>


        <div v-if="searchHits.length" class="con-hits">
          <div v-for="h in searchHits" :key="h.date" class="con-hit" @click="goHit(h.date)">
            <span class="con-hit-date">{{ h.date }}</span>
            <span class="con-hit-excerpt">{{ excerpt(h) }}</span>
            <button class="con-link-btn" @click.stop="goHit(h.date)">打开这一天 →</button>
          </div>
        </div>
        <!-- P1-1：书库命中。同一关键词在书库里的结果（书名 / 作者 / 摘录 / 标签），
             与上面的日记命中并列，各带各的动作——点书开书，点笔记开原书。 -->
        <div v-if="libRows.length" class="con-lib">
          <p class="con-lib-head">
            图书馆命中 {{ libRows.length }} 条
            <span class="con-lib-hint">书名 / 作者 / 摘录 / 笔记标签</span>
          </p>
          <div v-for="r in libRows" :key="r.type + r.id" class="con-hit con-hit-lib" @click="openLibRow(r)">
            <span class="con-hit-date">{{ r.type === 'book' ? '书' : (r.type === 'theme' ? '主题' : (r.typeLabel || '笔记')) }}</span>
            <span class="con-hit-excerpt">
              <template v-if="r.type === 'note'">《{{ r.bookTitle || '未记书名' }}》{{ r.text }}</template>
              <template v-else>{{ r.title }}<template v-if="r.text"> · {{ r.text }}</template></template>
            </span>
            <button class="con-link-btn" @click.stop="openLibRow(r)">
              {{ r.type === 'book' ? '去图书馆 →' : (r.type === 'theme' ? '看这个主题 →' : '打开原书 →') }}
            </button>
          </div>
        </div>
        <p v-if="!searchHits.length && !libRows.length" class="con-empty">
          {{ searched ? '没有找到匹配的记录，换个关键词或模式试试。' : '输入关键词后点「搜索」，命中会列在这里；点一行跳到那一天。' }}
        </p>
      </section>

      <!-- 2 正文内链 -->
      <section v-else-if="tab === 'links'" class="con-panel">
        <div class="con-panel-head">
          <h3 class="con-panel-title">正文内链 [[ ]]</h3>
        </div>
        <p v-if="errLinks" class="con-err" role="alert">{{ errLinks }}</p>


        <p v-if="!links.length" class="con-empty">
          还没有内链。
        </p>
        <div v-for="g in groupedLinks" :key="g.type" class="con-group">
          <div class="con-group-head">
            <span class="con-group-label">{{ g.label }}</span>
            <span class="con-group-count">{{ g.items.length }} 条</span>
            <span class="con-group-hint">{{ g.hint }}</span>
          </div>
          <div
            v-for="(l, i) in g.items"
            :key="g.type + '-' + i"
            class="con-link"
            @click="onLinkClick(l)"
          >
            <span class="con-link-raw">{{ l.raw }}</span>
            <span class="con-link-meta">来源 {{ l.date }} · {{ cellLabel(l.cell) }}</span>
            <span class="con-link-note">{{ l.type === 'date' || l.type === 'person' ? '点行跳转' : '只读 · 点行看提示' }}</span>
          </div>
          <p v-if="!g.items.length" class="con-empty">这一组还没有内链。</p>
        </div>
      </section>

      <!-- 3 轻标签 -->
      <section v-else-if="tab === 'tags'" class="con-panel">
        <div class="con-panel-head">
          <h3 class="con-panel-title">轻标签</h3>
        </div>
        <p v-if="errTags" class="con-err" role="alert">{{ errTags }}</p>
        <p v-if="tagMsg" class="con-msg" role="status">{{ tagMsg }}</p>

        <div class="con-note">
          <p class="con-note-line">标签名 ≤ 12 字 · 每目标最多 3 个</p>
          <p class="con-note-line con-muted">如 <span class="con-code">diary:2026-11-07</span> 或 <span class="con-code">cell:work</span></p>
        </div>

        <div class="con-row">
          <input
            v-model="newTagName"
            class="con-input"
            type="text"
            maxlength="40"
            placeholder="新标签名，最多 12 字"
            @keyup.enter="addTag"
          />
          <button class="con-btn" :disabled="busy" @click="addTag">新建标签</button>
        </div>

        <p v-if="!tags.length" class="con-empty">还没有标签，先新建一个。</p>
        <div v-else class="con-tag-list">
          <div v-for="t in tags" :key="t.id" class="con-tag-item">
            <span class="con-tag-name">{{ t.name }}</span>
            <div class="con-tag-actions">
              <button class="con-btn con-btn-mini" :disabled="busy" @click="toggleTag(t)">
                {{ hasTag(t.id) ? '取消' : '打上' }}
              </button>
              <button class="con-btn con-btn-mini con-btn-danger" :disabled="busy" @click="removeTag(t.id)">删除</button>
            </div>
          </div>
        </div>

        <div class="con-target">
          <span class="con-label">当前目标</span>
          <button class="con-mode" :class="{ 'con-mode-on': isDiary() }" @click="setTargetKind('diary')">今天的日记</button>
          <button class="con-mode" :class="{ 'con-mode-on': isCell() }" @click="setTargetKind('cell')">某个格</button>
          <select v-if="targetKind === 'cell'" v-model="cellKey" class="con-select" @change="onCellChange">
            <option v-for="c in CELL_OPTIONS" :key="c.key" :value="c.key">{{ c.label }}</option>
          </select>
          <span class="con-muted">{{ target }}</span>
        </div>
        <p class="con-hint">{{ targetLabel }} 的标签：</p>
        <div class="con-chips">
          <span v-for="t in targetTags" :key="t.id" class="con-chip">{{ t.name }}</span>
          <span v-if="!targetTags.length" class="con-empty">这个目标还没有标签。</span>
        </div>

        <div class="con-stat">
          <div v-if="statLines.length" class="con-stat-lines">
            <div v-for="(s, i) in statLines" :key="i" class="con-stat-line">
              <span>{{ s.label }}</span><span>{{ s.value }}</span>
            </div>
          </div>
          <p v-else class="con-empty">暂无统计。</p>
        </div>
      </section>

      <!-- 4 重复任务 -->
      <section v-else-if="tab === 'recur'" class="con-panel">
        <div class="con-panel-head">
          <h3 class="con-panel-title">重复任务</h3>
          <p class="con-panel-desc">完成一条，接着派生下一条。</p>
        </div>
        <p v-if="errRecur" class="con-err" role="alert">{{ errRecur }}</p>
        <p v-if="recurMsg" class="con-msg" role="status">{{ recurMsg }}</p>


        <p v-if="!repeatTasks.length" class="con-empty">还没有重复任务。</p>
        <div v-else class="con-task-list">
          <div v-for="t in repeatTasks" :key="t.id" class="con-task">
            <div class="con-task-main">
              <span class="con-task-title">{{ t.title || '(无标题)' }}</span>
              <span class="con-task-meta">{{ taskMeta(t) }}</span>
            </div>
            <button class="con-btn con-task-btn" :disabled="busy" @click="deriveNext(t)">完成并派生下一条</button>
          </div>
        </div>
      </section>

      <!-- 5 耗时记录 -->
      <section v-else-if="tab === 'time'" class="con-panel">
        <div class="con-panel-head">
          <h3 class="con-panel-title">耗时记录</h3>
        </div>
        <p v-if="errTime" class="con-err" role="alert">{{ errTime }}</p>
        <p v-if="timeMsg" class="con-msg" role="status">{{ timeMsg }}</p>


        <div class="con-row">
          <span class="con-label">任务</span>
          <select v-model="timeTaskId" class="con-select">
            <option value="">（选一个任务）</option>
            <option v-for="t in gtdTasks" :key="t.id" :value="t.id">{{ taskOptionLabel(t) }}</option>
          </select>
        </div>
        <p v-if="!gtdTasks.length" class="con-empty">暂无任务可选。</p>

        <div class="con-presets">
          <span class="con-label">分钟</span>
          <button
            v-for="n in MINUTE_PRESETS"
            :key="n"
            class="con-preset"
            :class="{ 'con-preset-on': isPreset(n) }"
            @click="pickPreset(n)"
          >{{ n }}</button>
          <input
            v-model="customMinutes"
            class="con-input con-minutes"
            type="number"
            min="1"
            max="1440"
            placeholder="自定义"
            @input="onCustomInput"
          />
          <span class="con-muted">当前 {{ minutes }} 分钟</span>
        </div>
        <div class="con-row">
          <button class="con-btn" :disabled="busy" @click="logMinutes">记一笔</button>
        </div>

        <div class="con-week">
          <div class="con-week-total">本周合计 <strong>{{ weekTotal }}</strong> 分钟</div>
          <p v-if="!weekRows.length" class="con-empty">本周还没有耗时记录。</p>
          <div v-for="(r, i) in weekRows" :key="i" class="con-week-row">
            <span class="con-week-label">{{ r.context || '未分情境' }}</span>
            <span class="con-week-bar"><span class="con-week-bar-fill" :style="{ width: barWidth(r.minutes) }"></span></span>
            <span class="con-week-value">{{ r.minutes }} 分</span>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.con-root {
  --con-bg: var(--surface-bg, #fbfaf7);
  --con-panel: var(--surface-raised, #ffffff);
  --con-border: var(--surface-border, #e3ded2);
  --con-text: var(--text-primary, #2f2c26);
  --con-muted: var(--surface-muted, #8b8577);
  --con-accent: var(--palette-primary, #4a6b52);
  --con-soft: var(--palette-soft, #eef3ea);
  --con-on: var(--palette-on, #ffffff);
  --con-warn: var(--state-warn, #a9681f);
  --con-warn-soft: var(--state-warn-soft, #fbf1de);
  --con-danger: var(--state-danger, #a03838);
  --con-danger-soft: var(--state-danger-soft, #fdeaea);
  --con-radius: var(--radius-md, 8px);
  --con-space: var(--space-2, 10px);
  display: flex;
  flex-direction: column;
  gap: var(--con-space);
  min-width: 0;
  padding: 2px 0;
  color: var(--con-text);
  background: var(--con-bg);
  font-size: var(--text-body);
}
.con-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.con-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.con-title { margin: 0; font-size: var(--text-h2); font-weight: 600; }
.con-sub { margin: 0; font-size: var(--text-sm); color: var(--con-muted); }
.con-back {
  padding: 6px 12px; border: 1px solid var(--con-border); border-radius: var(--con-radius);
  background: var(--con-panel); color: var(--con-text); cursor: pointer; font-size: var(--text-sm);
}
.con-back:hover { background: var(--con-soft); }
.con-notice {
  padding: 6px 12px; border-radius: var(--con-radius);
  background: var(--con-soft); color: var(--con-accent); font-size: var(--text-sm); cursor: pointer;
}
.con-notice-x { float: right; }
.con-tabs { display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--con-border); padding-bottom: 8px; }
.con-tab {
  padding: 6px 14px; border: 1px solid var(--con-border); border-radius: var(--con-radius);
  background: var(--con-panel); color: var(--con-text); cursor: pointer; font-size: var(--text-sm);
}
.con-tab-on { background: var(--con-accent); color: var(--con-on); border-color: var(--con-accent); }
.con-body { min-width: 0; }
.con-panel { display: flex; flex-direction: column; gap: 10px; }
.con-panel-head { display: flex; flex-direction: column; gap: 2px; }
.con-panel-title { margin: 0; font-size: var(--text-h2); font-weight: 600; }
.con-panel-desc { margin: 0; font-size: var(--text-sm); color: var(--con-muted); }
.con-note {
  padding: 8px 12px; border: 1px solid var(--con-border); border-radius: var(--con-radius);
  background: var(--con-panel); font-size: var(--text-sm); line-height: 1.7;
}
.con-note-line { margin: 2px 0; }
.con-note-warn { background: var(--con-warn-soft); border-color: var(--con-warn); }
.con-code { padding: 0 4px; border-radius: 4px; background: var(--con-soft); font-family: monospace; }
.con-muted { color: var(--con-muted); }
.con-err {
  margin: 0; padding: 6px 10px; border-radius: var(--con-radius);
  background: var(--con-danger-soft); color: var(--con-danger); font-size: var(--text-sm);
}
.con-msg {
  margin: 0; padding: 6px 10px; border-radius: var(--con-radius);
  background: var(--con-soft); color: var(--con-accent); font-size: var(--text-sm);
}
.con-empty {
  margin: 0; padding: 10px 12px; border: 1px dashed var(--con-border);
  border-radius: var(--con-radius); color: var(--con-muted); font-size: var(--text-sm);
}
.con-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.con-label { font-size: var(--text-sm); color: var(--con-muted); }
.con-hint { margin: 0; font-size: var(--text-sm); color: var(--con-muted); }
.con-input {
  padding: 6px 10px; border: 1px solid var(--con-border); border-radius: var(--con-radius);
  background: var(--con-panel); color: var(--con-text); font-size: var(--text-body); min-width: 0;
}
.con-input:focus { outline: 2px solid var(--con-accent); outline-offset: 1px; }
.con-select {
  padding: 6px 10px; border: 1px solid var(--con-border); border-radius: var(--con-radius);
  background: var(--con-panel); color: var(--con-text); font-size: var(--text-body);
}
.con-btn {
  padding: 6px 12px; border: 1px solid var(--con-border); border-radius: var(--con-radius);
  background: var(--con-panel); color: var(--con-text); cursor: pointer; font-size: var(--text-sm);
}
.con-btn:hover { background: var(--con-soft); }
.con-btn:disabled { opacity: 0.5; cursor: default; }
.con-btn-mini { padding: 3px 8px; font-size: var(--text-xs); }
.con-btn-danger { color: var(--con-danger); }
.con-search-bar { display: flex; gap: 8px; }
.con-search-bar .con-input { flex: 1 1 auto; }
.con-search-btn { flex: 0 0 auto; }
.con-modes { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.con-mode {
  padding: 4px 10px; border: 1px solid var(--con-border); border-radius: 999px;
  background: var(--con-panel); color: var(--con-text); cursor: pointer; font-size: var(--text-sm);
}
.con-mode-on { background: var(--con-accent); color: var(--con-on); border-color: var(--con-accent); }
.con-hits { display: flex; flex-direction: column; gap: 6px; }
.con-hit {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border: 1px solid var(--con-border); border-radius: var(--con-radius);
  background: var(--con-panel); cursor: pointer;
}
.con-hit:hover { background: var(--con-soft); }
.con-hit-date { flex: 0 0 auto; font-size: var(--text-sm); color: var(--con-accent); font-variant-numeric: tabular-nums; }
.con-hit-excerpt {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: var(--text-sm);
}
.con-link-btn {
  flex: 0 0 auto; border: 0; background: transparent;
  color: var(--con-accent); cursor: pointer; font-size: var(--text-sm);
}
/* P1-1 书库命中：与日记命中分开成块，块头写清「这是图书馆里的」 */
.con-lib { display: flex; flex-direction: column; gap: 6px; margin-top: var(--space-3); }
.con-lib-head { margin: 0; font-size: var(--text-sm); color: var(--con-muted); }
.con-lib-hint { margin-left: 6px; font-size: var(--text-xs); color: var(--con-muted); }
.con-hit-lib { border-style: dashed; }
.con-hit-lib .con-hit-excerpt { white-space: normal; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.con-group {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  border: 1px solid var(--con-border); border-radius: var(--con-radius); background: var(--con-panel);
}
.con-group-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.con-group-label { font-size: var(--text-body); font-weight: 600; }
.con-group-count { font-size: var(--text-xs); color: var(--con-muted); }
.con-group-hint { font-size: var(--text-xs); color: var(--con-muted); }
.con-link {
  display: flex; align-items: center; gap: 10px; padding: 5px 8px;
  border-radius: var(--con-radius); cursor: pointer;
}
.con-link:hover { background: var(--con-soft); }
.con-link-raw { font-size: var(--text-sm); color: var(--con-accent); font-family: monospace; }
.con-link-meta { font-size: var(--text-xs); color: var(--con-muted); }
.con-link-note { margin-left: auto; font-size: var(--text-xs); color: var(--con-muted); }
.con-tag-list { display: flex; flex-direction: column; gap: 4px; }
.con-tag-item {
  display: flex; align-items: center; justify-content: space-between; padding: 6px 10px;
  border: 1px solid var(--con-border); border-radius: var(--con-radius); background: var(--con-panel);
}
.con-tag-name { font-size: var(--text-body); }
.con-tag-actions { display: flex; gap: 6px; }
.con-target {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px;
  border: 1px solid var(--con-border); border-radius: var(--con-radius); background: var(--con-panel);
}
.con-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.con-chip {
  padding: 3px 10px; border-radius: 999px;
  background: var(--con-soft); color: var(--con-accent); font-size: var(--text-sm);
}
.con-stat {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  border: 1px solid var(--con-border); border-radius: var(--con-radius); background: var(--con-panel);
}
.con-stat-lines { display: flex; flex-direction: column; gap: 3px; }
.con-stat-line { display: flex; justify-content: space-between; font-size: var(--text-sm); }
.con-task-list { display: flex; flex-direction: column; gap: 6px; }
.con-task {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border: 1px solid var(--con-border); border-radius: var(--con-radius); background: var(--con-panel);
}
.con-task-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.con-task-title { font-size: var(--text-body); }
.con-task-meta { font-size: var(--text-xs); color: var(--con-muted); }
.con-task-btn { flex: 0 0 auto; }
.con-presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.con-preset {
  padding: 4px 12px; border: 1px solid var(--con-border); border-radius: var(--con-radius);
  background: var(--con-panel); color: var(--con-text); cursor: pointer; font-size: var(--text-sm);
}
.con-preset-on { background: var(--con-accent); color: var(--con-on); border-color: var(--con-accent); }
.con-minutes { width: 96px; }
.con-week {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border: 1px solid var(--con-border); border-radius: var(--con-radius); background: var(--con-panel);
}
.con-week-total { font-size: var(--text-body); }
.con-week-row { display: flex; align-items: center; gap: 8px; font-size: var(--text-sm); }
.con-week-label { flex: 0 0 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.con-week-bar { flex: 1 1 auto; height: 8px; border-radius: 999px; background: var(--con-soft); overflow: hidden; }
.con-week-bar-fill { display: block; height: 100%; background: var(--con-accent); }
.con-week-value { flex: 0 0 auto; width: 56px; text-align: right; color: var(--con-muted); }
@media (max-width: 720px) {
  .con-hit { flex-wrap: wrap; }
  .con-hit-excerpt { flex-basis: 100%; }
  .con-week-label { flex-basis: 72px; }
}
</style>
