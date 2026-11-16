<script setup lang="ts">
// 图书馆 · 独立窗口（左「文件夹树」/ 中「书架」/ 右「这本书或这个范围」）
//
// 形态：顶栏「图书馆」→ 主进程开独立 BrowserWindow → 本视图挂在第三个 Vite 入口。
// 与「记账」同一套做法：同一个 preload、同一份 md_reading、没有第二条数据通道。
//
// 为什么搬出主窗：书架本身已经是「按文件夹看书」的活，主窗中栏只有 600 多像素，
// 左侧再挂一棵树就什么都不剩。calibre 的形态是「左树 / 中列表 / 右详情」，
// 这里照抄形态，不抄它的数据库结构——数据仍来自 md_reading 的单键。
//
// 三栏的分工只有一句话：**左栏说「看哪一摞」，中栏说「这一摞有哪些」，右栏说「选中了什么」**。
// 左栏是范围唯一来源；中栏（ReadingView）不另存一份范围，只认 scope 一条线。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DiaryRecord } from '../types';
import { emptyRecord } from '../types';
import { callDomain } from '../composables/useDomain';
import { useTheme } from '../composables/useTheme';
import { listDiaries, onDataChanged, openReader, pickBookFiles, saveExport } from '../bridge';
import ReadingView from './ReadingView.vue';

interface BookRow {
  id: string; title: string; author: string; format: string; fileExt: string;
  fileSizeText: string; pct: number; progressText: string; statusLabel: string;
  noteCount: number; status: string; themeId: string; filePath: string;
  coverColor: string; favorite: boolean; group: string; fileMissing?: boolean;
  tags?: string[]; rootId?: string; relPath?: string;
}
interface ThemeGroup { themeId: string; themeTitle: string; note: string; rows: BookRow[] }
// P2-1 虚拟书架：规则集合。只有 id 列表，书本身还是 books 里那一份。
interface ShelfRow { key: string; kind: string; label: string; count: number; ids: string[] }
// P2-4 书库根：一本都不复制，只是「这些书都在这棵树下」的声明
interface RootRow { id: string; label: string; path: string; books: number; missing: number; exists: boolean }
interface BoardData {
  books: BookRow[]; leisureBooks?: BookRow[]; themeGroups: ThemeGroup[];
  groups: Array<{ name: string; count: number }>; favoriteCount: number;
  shelves?: ShelfRow[];
  recent: Array<{ id: string; bookTitle: string; quote: string; text: string; createdAt: number }>;
  stats: { books: number; themeBooks?: number; notes: number; highlights: number; ideas: number; pushed: number; thisMonth: number; tagCount: number };
}
// P1-2 反向关联卡：这本书后来被谁用到（日记里的回写行 / 由它生成的任务）。
// 全部由主进程现算，read-only，一次点击取一次；不落库、不缓存。
interface RefRow { date: string; cell: string; text: string; noteId: string }
interface RefTask { id: string; title: string; status: string }
interface Refs {
  bookId: string; title: string; noteCount: number;
  theme: { id: string; title: string } | null;
  diary: RefRow[]; tasks: RefTask[];
}
type ScopeKind = 'leisure' | 'theme' | 'notes' | 'shelf';
interface Scope { kind: ScopeKind; group?: string; themeId?: string; shelfKey?: string }

const props = defineProps<{ today: string }>();

// 独立窗口必须自己挂皮肤作用域：tokens.css 里的 --palette-* 只在 [data-skin] 下定义，
// 少了这一句，文件夹图标、选中态、右侧数字会一起变透明（V3.14 实测踩到）。
const { skin, load: loadTheme } = useTheme();

// 与 ReadingView 的筛选常量同一套字面量：两边认的是同一个「范围」，不能各造一套 id
const ALL = '__all__';
const FAV = '__fav__';

const board = ref<BoardData | null>(null);
const record = ref<DiaryRecord>(emptyRecord(props.today));
const scope = ref<Scope>({ kind: 'leisure', group: ALL });
const pickedId = ref('');
// 主进程广播一到就自增：中栏书架据此重取，不至于「主窗写了、这里还是旧数」
const dataTick = ref(0);
const thead = ref('');               // 中栏顶部一句反馈，和主窗的 notify 同一形态
const showLeisure = ref(true);
const showTheme = ref(true);
const showShelf = ref(true);
const openTheme = ref<Record<string, boolean>>({});

const navW = ref(252);
const railW = ref(300);
const NAV_MIN = 190; const NAV_MAX = 380;
const RAIL_MIN = 240; const RAIL_MAX = 460;
const CENTER_MIN = 420;
const dragging = ref<'' | 'nav' | 'rail'>('');
const columnsEl = ref<HTMLElement | null>(null);

const leisureBooks = computed<BookRow[]>(() => {
  const bd = board.value;
  if (!bd) return [];
  return bd.leisureBooks || (bd.books || []).filter((b) => !b.themeId);
});
const themeGroups = computed<ThemeGroup[]>(() => board.value?.themeGroups || []);
const themeBookCount = computed(() => themeGroups.value.reduce((n, g) => n + g.rows.length, 0));
const groups = computed(() => board.value?.groups || []);
const ungrouped = computed(() => leisureBooks.value.filter((b) => !b.group).length);
const favoriteCount = computed(() => board.value?.favoriteCount || 0);
// P2-1：虚拟书架（规则集合 + 标签集合）。规则由主进程派生，这里只负责画和筛。
const shelves = computed<ShelfRow[]>(() => board.value?.shelves || []);
const ruleShelves = computed(() => shelves.value.filter((s) => s.kind === 'rule'));
const tagShelves = computed(() => shelves.value.filter((s) => s.kind === 'tag'));
const roots = ref<RootRow[]>([]);
const allBooks = computed<BookRow[]>(() => {
  const bd = board.value;
  if (!bd) return [];
  const books = bd.books || leisureBooks.value;
  return books;
});

// 「未分组」在库里不是一个名字而是一个空字符串：用一组独立常量把这个区别固定在两处
const UNGROUPED = '\u0000none';
const scopeBooks = computed<BookRow[]>(() => {
  const s = scope.value;
  if (s.kind === 'notes') return [];
  // P2-1 虚拟书架：按规则集合给的 id 反查 books 里那一份，不复制记录
  if (s.kind === 'shelf') {
    const hit = shelves.value.filter((x) => x.key === s.shelfKey)[0];
    if (!hit) return [];
    const byId: Record<string, BookRow> = {};
    allBooks.value.forEach((b) => { byId[b.id] = b; });
    return hit.ids.map((id) => byId[id]).filter((b): b is BookRow => !!b);
  }
  if (s.kind === 'theme') {
    if (!s.themeId) return themeGroups.value.reduce<BookRow[]>((a, g) => a.concat(g.rows), []);
    const hit = themeGroups.value.filter((g) => g.themeId === s.themeId)[0];
    return hit ? hit.rows : [];
  }
  const all = leisureBooks.value;
  if (s.group === FAV) return all.filter((b) => b.favorite);
  if (s.group === UNGROUPED) return all.filter((b) => !b.group);
  if (!s.group || s.group === ALL) return all;
  return all.filter((b) => (b.group || '') === s.group);
});
const scopeLabel = computed(() => {
  const s = scope.value;
  if (s.kind === 'notes') return '读书笔记';
  if (s.kind === 'shelf') {
    const hit = shelves.value.filter((x) => x.key === s.shelfKey)[0];
    return '虚拟书架：' + (hit ? hit.label : '已失效');
  }
  if (s.kind === 'theme') {
    if (!s.themeId) return '主题阅读 · 全部主题';
    const hit = themeGroups.value.filter((g) => g.themeId === s.themeId)[0];
    return '主题：' + (hit ? hit.themeTitle : '已删除');
  }
  if (s.group === FAV) return '收藏夹';
  if (s.group === UNGROUPED) return '未分组';
  if (!s.group || s.group === ALL) return '全部藏书';
  return '分组：' + s.group;
});
const scopeKpi = computed(() => {
  const list = scopeBooks.value;
  const reading = list.filter((b) => b.status === 'reading').length;
  const done = list.filter((b) => b.status === 'done').length;
  const notes = list.reduce((n, b) => n + (b.noteCount || 0), 0);
  return { count: list.length, reading, done, notes };
});
// 「读书笔记」这一栏不是书，右栏的四格也得跟着换口径：
// 摆「本数 / 在读 / 读完」在那里全是 0，等于骗人。
const notesKpi = computed(() => ({
  total: board.value?.stats.notes || 0,
  month: board.value?.stats.thisMonth || 0,
  pushed: board.value?.stats.pushed || 0,
  tags: board.value?.stats.tagCount || 0
}));
const picked = computed<BookRow | null>(() => {
  const id = pickedId.value;
  if (!id) return null;
  const all = leisureBooks.value.concat(themeGroups.value.reduce<BookRow[]>((a, g) => a.concat(g.rows), []));
  return all.filter((b) => b.id === id)[0] || null;
});
const recentNotes = computed(() => (board.value?.recent || []).slice(0, 6));

const pickedCover = ref('');
const pickedRefs = ref<Refs | null>(null);
const relinking = ref(false);
watch(pickedId, async (id) => {
  pickedCover.value = '';
  pickedRefs.value = null;
  if (!id) return;
  // 封面只问主进程要 data URL：书内封面或豆瓣套用的那张，哪张先有就用哪张。
  // 取不到就退回渐变占位（同一本书在中栏看到的也是同一套色）。
  try { pickedCover.value = (await callDomain<string>('reading.cover', '', id)) || ''; } catch { pickedCover.value = ''; }
  // P1-2：「它后来去了哪」——日记里哪几行是它回写的、生成了哪几条任务。
  // 纯只读派生：改完日记回到这里点一下就能看见变化，因为它每次现算。
  try { pickedRefs.value = await callDomain<Refs | null>('reading.refs', null, id, ''); } catch { pickedRefs.value = null; }
});

// P0-2：重新关联。旧做法是「移出 → 重新添加」，那会造新 bookId，
// 笔记 / 章节 / 书签 / 按书筛选全静默失联。这里只换路径，id 不动。
async function relinkPicked(): Promise<void> {
  const b = picked.value;
  if (!b || relinking.value) return;
  relinking.value = true;
  try {
    const pickedFile = await pickBookFiles();
    if (!pickedFile || pickedFile.canceled || !pickedFile.paths.length) return;
    const r = await callDomain<{ ok: boolean; reason?: string } | null>('reading.relinkBook', null, b.id, pickedFile.paths[0]);
    if (!r || !r.ok) { say((r && r.reason) || '重新关联失败'); return; }
    await load();
    say('已重新关联：书的 id 没变，' + (b.noteCount || 0) + ' 条笔记还在');
  } finally {
    relinking.value = false;
  }
}

// 与书架占位封面同一套派生（书名哈希 → 同色系渐变）：不抽封面图，也不让右栏出现一块白板。
// 一样是 84%→68% 的浅色渐变，所以文字必须走白字 + 阴影，和 .rd-card-initial 一致。
function coverHue(b: BookRow): string {
  let h = 0;
  for (let i = 0; i < b.title.length; i += 1) h = (h * 31 + b.title.charCodeAt(i)) % 360;
  return 'linear-gradient(150deg, hsl(' + h + ',28%,84%), hsl(' + ((h + 40) % 360) + ',26%,68%))';
}

function say(text: string): void { thead.value = text; }

// ---- P2-1：书的标签（多值，与「分组」并存）----
// 加标签不是「多一个字段」而是「多一摞书架」：board().shelves 里的 tag:xxx 立刻多一条。
const tagInput = ref('');
async function addTag(): Promise<void> {
  const b = picked.value;
  const t = tagInput.value.trim().replace(/^#+/, '');
  if (!b || !t) return;
  if ((b.tags || []).length >= 8) { say('一本书最多 8 个标签'); return; }
  tagInput.value = '';
  await callDomain<unknown>('reading.addBookTag', null, b.id, t);
  await load();
  say('已给《' + b.title + '》加上 #' + t + '，左栏多了一摞同名书架');
}
async function dropTag(t: string): Promise<void> {
  const b = picked.value;
  if (!b) return;
  await callDomain<unknown>('reading.removeBookTag', null, b.id, t);
  await load();
}

// ---- P2-2：书目清单导出（CSV / JSON / OPDS）----
// 三种格式共用主进程现算的一张行表，落盘仍走 v1/file:save 这一条通道。
const exporting = ref('');
async function exportList(format: 'csv' | 'json' | 'opds'): Promise<void> {
  if (exporting.value) return;
  exporting.value = format;
  try {
    const out = await callDomain<{ text: string; ext: string; rows: number } | null>('reading.exportList', null, format);
    if (!out) { say('导出失败'); return; }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const receipt = await saveExport('九格书目-' + stamp + '.' + out.ext, out.text);
    say(receipt && receipt.path
      ? '已导出 ' + out.rows + ' 本书目：' + receipt.path
      : '已取消导出');
  } finally { exporting.value = ''; }
}

// ---- P2-4：书库根目录 ----
// 「整库换机零手工」= 在这条列表上改一次路径，所有挂在其下的书跟着走。
const rootBusy = ref('');
async function loadRoots(): Promise<void> {
  try { roots.value = await callDomain<RootRow[]>('reading.roots', []) || []; } catch { roots.value = []; }
}
async function addRootDir(): Promise<void> {
  if (rootBusy.value) return;
  rootBusy.value = 'add';
  try {
    const pickedDir = await callDomain<{ ok: boolean; path?: string; canceled?: boolean } | null>('reading.pickRoot', null);
    if (!pickedDir || !pickedDir.ok || !pickedDir.path) return;
    const r = await callDomain<{ ok: boolean; reason?: string; linked?: number } | null>(
      'reading.addRoot', null, { path: pickedDir.path }
    );
    if (!r || !r.ok) { say((r && r.reason) || '登记书库根失败'); return; }
    await loadRoots(); await load();
    say('已登记书库根，' + (r.linked || 0) + ' 本书自动挂到它下面');
  } finally { rootBusy.value = ''; }
}
async function relocateRootDir(r: RootRow): Promise<void> {
  if (rootBusy.value) return;
  rootBusy.value = r.id;
  try {
    const pickedDir = await callDomain<{ ok: boolean; path?: string } | null>('reading.pickRoot', null);
    if (!pickedDir || !pickedDir.ok || !pickedDir.path) return;
    const out = await callDomain<{ ok: boolean; reason?: string; moved?: number; missing?: number } | null>(
      'reading.relocateRoot', null, r.id, pickedDir.path
    );
    if (!out || !out.ok) { say((out && out.reason) || '换目录失败'); return; }
    await loadRoots(); await load();
    say('书库根已指向新目录，' + (out.moved || 0) + ' 本书路径一起改完'
      + (out.missing ? '；其中 ' + out.missing + ' 本在新目录里没找到' : ''));
  } finally { rootBusy.value = ''; }
}
async function dropRoot(r: RootRow): Promise<void> {
  if (rootBusy.value) return;
  rootBusy.value = r.id;
  try {
    await callDomain<unknown>('reading.removeRoot', null, r.id);
    await loadRoots(); await load();
    say('已解除书库根「' + (r.label || r.path) + '」：书一本没删，只是不再跟着它搬');
  } finally { rootBusy.value = ''; }
}

async function load(): Promise<void> {
  board.value = await callDomain<BoardData | null>('reading.board', null);
  dataTick.value += 1;
  void loadRoots();
  // 中栏写笔记要拿「今天的日记」当底座：拿不到就退回空档，别拿 null 去写
  try {
    const res = await listDiaries({ pageSize: 500 });
    const hit = res.items.filter((r) => r.date === props.today)[0];
    record.value = hit || emptyRecord(props.today);
  } catch { record.value = emptyRecord(props.today); }
}

// ---- 左栏树：点节点 = 定范围；点书名 = 选中（右栏出详情） ----
function pickLeisure(group: string): void {
  pickedId.value = '';
  scope.value = { kind: 'leisure', group };
}
function pickTheme(themeId: string): void {
  pickedId.value = '';
  scope.value = { kind: 'theme', themeId };
  if (themeId) openTheme.value = { ...openTheme.value, [themeId]: true };
}
function pickNotes(): void {
  pickedId.value = '';
  scope.value = { kind: 'notes' };
}
// P2-1：点虚拟书架的一个集合 = 换一个范围。规则在主进程派生，这里只认 key。
function pickShelf(key: string): void {
  pickedId.value = '';
  scope.value = { kind: 'shelf', shelfKey: key };
}
function isShelfScope(key: string): boolean {
  const s = scope.value;
  return s.kind === 'shelf' && s.shelfKey === key;
}
function toggleTheme(themeId: string): void {
  openTheme.value = { ...openTheme.value, [themeId]: !openTheme.value[themeId] };
}
function toggleNode(which: 'leisure' | 'theme'): void {
  if (which === 'leisure') showLeisure.value = !showLeisure.value;
  else showTheme.value = !showTheme.value;
}
function isLeisureScope(group: string): boolean {
  const s = scope.value;
  return s.kind === 'leisure' && (s.group || ALL) === group;
}
function isThemeScope(themeId: string): boolean {
  const s = scope.value;
  return s.kind === 'theme' && s.themeId === themeId;
}
function selectBook(b: BookRow): void {
  pickedId.value = b.id;
  // 只换右栏，不动范围：用户是「在这一摞里点一本看看」，不是「换一摞」。
  // 中栏跟着跳会让分组筛选被悄悄重置，看着像点错了。
}
async function openBook(b: BookRow): Promise<void> {
  if (!b.filePath) { say('《' + b.title + '》没有电子书，只有笔记'); return; }
  const r = await openReader(b.id);
  if (!r || !r.ok) say((r && r.reason) || '阅读窗口没打开');
}

// ---- 栏宽：与主窗 / 账本同一套手柄语义（命中区 6px，拖动才高亮） ----
function clampW(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.round(v))); }
function startDrag(which: 'nav' | 'rail', ev: PointerEvent): void {
  if (window.innerWidth < 1024) return;
  dragging.value = which;
  const el = ev.currentTarget as HTMLElement;
  if (el.setPointerCapture) el.setPointerCapture(ev.pointerId);
  ev.preventDefault();
}
function onDrag(ev: PointerEvent): void {
  if (!dragging.value || !columnsEl.value) return;
  const rect = columnsEl.value.getBoundingClientRect();
  if (dragging.value === 'nav') {
    const max = Math.max(NAV_MIN, Math.min(NAV_MAX, rect.width - railW.value - CENTER_MIN));
    navW.value = clampW(ev.clientX - rect.left, NAV_MIN, max);
  } else {
    const max = Math.max(RAIL_MIN, Math.min(RAIL_MAX, rect.width - navW.value - CENTER_MIN));
    railW.value = clampW(rect.right - ev.clientX, RAIL_MIN, max);
  }
}
function endDrag(): void { dragging.value = ''; }
function nudge(which: 'nav' | 'rail', delta: number): void {
  if (which === 'nav') navW.value = clampW(navW.value + delta, NAV_MIN, NAV_MAX);
  else railW.value = clampW(railW.value + delta, RAIL_MIN, RAIL_MAX);
}
function resetLayout(): void { navW.value = 252; railW.value = 300; say('栏宽已恢复默认'); }

function onChanged(): void { void load(); }
function onRefresh(): void { void load(); }
// 中栏左上角那个「← 返回九格」在这个窗口里的含义就是「关掉这扇窗」：
// 窗口是主进程开的，主窗还在后面等着；关不掉也不该拦住别的动作。
function closeWindow(): void {
  try { window.close(); } catch { /* 关不掉就留着，反正有原生关窗键 */ }
}

onMounted(() => {
  void loadTheme();
  void load();
  onDataChanged(onChanged);
  window.addEventListener('library:refresh', onRefresh);
});
onBeforeUnmount(() => { window.removeEventListener('library:refresh', onRefresh); });
</script>

<template>
  <section
    ref="columnsEl" class="lib-app" :class="{ 'lib-dragging': !!dragging }"
    :style="{ '--lib-nav-w': navW + 'px', '--lib-rail-w': railW + 'px' }"
    :data-skin="skin" data-surface="light"
    aria-label="图书馆独立窗口"
  >
    <!-- ==================== 左栏：文件夹层级 ==================== -->
    <aside class="lib-left" aria-label="文件夹">
      <div class="lib-brand">
        <h1>图书馆</h1>
        <p>两类阅读 · 按文件夹走 · 全部本机</p>
      </div>

      <div class="lib-tree" role="tree" aria-label="书籍层级">
        <!-- 休闲阅读 -->
        <div class="lib-node" role="none">
          <button
            class="lib-row lib-root" :class="{ 'lib-row-on': scope.kind === 'leisure' && (scope.group || ALL) === ALL }"
            role="treeitem" :aria-expanded="showLeisure"
            @click="pickLeisure(ALL); showLeisure = true"
          >
            <span class="lib-caret" @click.stop="toggleNode('leisure')">{{ showLeisure ? '▾' : '▸' }}</span>
            <span class="lib-ico"><i class="lib-folder"></i></span>
            <span class="lib-name">休闲阅读</span>
            <span class="lib-count">{{ leisureBooks.length }}</span>
          </button>
          <div v-if="showLeisure" class="lib-kids" role="group">
            <!-- 不再单独放一个「全部藏书」叶子：根节点本身就是「这一摞全看」，
                 两个都画选中只是让人以为自己点错了。收藏夹是唯一不是分组的筛选。 -->
            <button
              class="lib-row lib-leaf" :class="{ 'lib-row-on': isLeisureScope(FAV) }"
              role="treeitem" @click="pickLeisure(FAV)"
            >
              <span class="lib-caret lib-caret-none" aria-hidden="true"></span>
              <span class="lib-ico"><i class="lib-folder-open"></i></span>
              <span class="lib-name">★ 收藏夹</span>
              <span class="lib-count">{{ favoriteCount }}</span>
            </button>
            <button
              v-for="g in groups" :key="g.name" class="lib-row lib-leaf"
              :class="{ 'lib-row-on': isLeisureScope(g.name) }" role="treeitem" @click="pickLeisure(g.name)"
            >
              <span class="lib-caret lib-caret-none" aria-hidden="true"></span>
              <span class="lib-ico"><i class="lib-folder-open"></i></span>
              <span class="lib-name">{{ g.name }}</span>
              <span class="lib-count">{{ g.count }}</span>
            </button>
            <button
              v-if="ungrouped" class="lib-row lib-leaf" :class="{ 'lib-row-on': isLeisureScope(UNGROUPED) }"
              role="treeitem" @click="pickLeisure(UNGROUPED)"
            >
              <span class="lib-caret lib-caret-none" aria-hidden="true"></span>
              <span class="lib-ico"><i class="lib-folder-open"></i></span>
              <span class="lib-name">未分组</span>
              <span class="lib-count">{{ ungrouped }}</span>
            </button>
          </div>
        </div>

        <!-- 主题阅读：主题是这一摞里的「文件夹」，书挂在主题下面 -->
        <div class="lib-node" role="none">
          <button
            class="lib-row lib-root" :class="{ 'lib-row-on': scope.kind === 'theme' && !scope.themeId }"
            role="treeitem" :aria-expanded="showTheme"
            @click="pickTheme(''); showTheme = true"
          >
            <span class="lib-caret" @click.stop="toggleNode('theme')">{{ showTheme ? '▾' : '▸' }}</span>
            <span class="lib-ico"><i class="lib-folder"></i></span>
            <span class="lib-name">主题阅读</span>
            <span class="lib-count">{{ themeBookCount }}</span>
          </button>
          <div v-if="showTheme" class="lib-kids" role="group">
            <div v-for="t in themeGroups" :key="t.themeId" class="lib-node" role="none">
              <button
                class="lib-row lib-leaf lib-leaf-theme" :class="{ 'lib-row-on': isThemeScope(t.themeId) }"
                role="treeitem" :aria-expanded="!!openTheme[t.themeId]" @click="pickTheme(t.themeId)"
              >
                <span class="lib-caret" @click.stop="toggleTheme(t.themeId)">{{ openTheme[t.themeId] ? '▾' : '▸' }}</span>
                <span class="lib-ico"><i class="lib-folder"></i></span>
                <span class="lib-name" :title="t.themeTitle">{{ t.themeTitle }}</span>
                <span class="lib-count">{{ t.rows.length }}</span>
              </button>
              <div v-if="openTheme[t.themeId]" class="lib-kids lib-kids-book" role="group">
                <button
                  v-for="b in t.rows" :key="b.id" class="lib-row lib-book"
                  :class="{ 'lib-row-on': pickedId === b.id }" role="treeitem"
                  :title="b.title + (b.filePath ? '\n双击翻开' : '\n没有电子书，只有笔记')"
                  @click="selectBook(b)" @dblclick="openBook(b)"
                >
                  <span class="lib-caret lib-caret-none" aria-hidden="true"></span>
                  <span class="lib-ico"><i class="lib-book-ico"></i></span>
                  <span class="lib-name">{{ b.title }}</span>
                  <span class="lib-count">{{ b.pct }}%</span>
                </button>
                <p v-if="!t.rows.length" class="lib-empty">这个主题还没放书</p>
              </div>
            </div>
            <p v-if="!themeGroups.length" class="lib-empty">还没有主题</p>
          </div>
        </div>

        <!-- P2-1 虚拟书架：规则集合。不是文件夹，是「按规则筛出来的一摞」，
             同一本书可以同时出现在「在读」和某个标签里——这正是它和分组的区别。 -->
        <div class="lib-node" role="none">
          <button
            class="lib-row lib-root"
            role="treeitem" :aria-expanded="showShelf"
            @click="showShelf = true"
          >
            <span class="lib-caret" @click.stop="showShelf = !showShelf">{{ showShelf ? '▾' : '▸' }}</span>
            <span class="lib-ico"><i class="lib-folder lib-folder-rule"></i></span>
            <span class="lib-name">虚拟书架</span>
            <span class="lib-count">{{ allBooks.length }}</span>
          </button>
          <div v-if="showShelf" class="lib-kids" role="group">
            <button
              v-for="s in ruleShelves" :key="s.key" class="lib-row lib-leaf"
              :class="{ 'lib-row-on': isShelfScope(s.key), 'lib-row-dim': !s.count }"
              role="treeitem" @click="pickShelf(s.key)"
            >
              <span class="lib-caret lib-caret-none" aria-hidden="true"></span>
              <span class="lib-ico"><i class="lib-folder-open"></i></span>
              <span class="lib-name">{{ s.label }}</span>
              <span class="lib-count">{{ s.count }}</span>
            </button>
            <p v-if="tagShelves.length" class="lib-sub-head">按标签</p>
            <button
              v-for="s in tagShelves" :key="s.key" class="lib-row lib-leaf"
              :class="{ 'lib-row-on': isShelfScope(s.key) }" role="treeitem" @click="pickShelf(s.key)"
            >
              <span class="lib-caret lib-caret-none" aria-hidden="true"></span>
              <span class="lib-ico"><i class="lib-folder-open"></i></span>
              <span class="lib-name">{{ s.label }}</span>
              <span class="lib-count">{{ s.count }}</span>
            </button>
            <p v-if="!tagShelves.length" class="lib-empty">右栏给书加标签，这里就会多一摞</p>
          </div>
        </div>

        <!-- 读书笔记 -->
        <button
          class="lib-row lib-root lib-row-single" :class="{ 'lib-row-on': scope.kind === 'notes' }"
          role="treeitem" @click="pickNotes()"
        >
          <span class="lib-caret lib-caret-none" aria-hidden="true"></span>
          <span class="lib-ico"><i class="lib-folder lib-folder-note"></i></span>
          <span class="lib-name">读书笔记</span>
          <span class="lib-count">{{ board?.stats.notes || 0 }}</span>
        </button>
      </div>

      <!-- P2-4 书库根：一条声明管一片目录。换机器只改这一行，60 本书的路径一起改。
           只列「有书挂着的根」和「已经找不到的根」，空根不占位置。 -->
      <div class="lib-roots" aria-label="书库根目录">
        <div class="lib-roots-head">
          <h2>书库根</h2>
          <button class="lib-mini" :disabled="!!rootBusy" @click="addRootDir">+ 登记目录</button>
        </div>
        <p v-if="!roots.length" class="lib-hint">
          电子书放在固定的目录下？登记一次，以后整库搬机器只改这里一条路径。
        </p>
        <div v-for="r in roots" :key="r.id" class="lib-root-row">
          <div class="lib-root-main">
            <b :title="r.path">{{ r.label || r.path }}</b>
            <span class="lib-root-meta">
              {{ r.books }} 本<template v-if="r.missing"> · {{ r.missing }} 本找不到</template>
              <template v-if="!r.exists"> · 目录不在</template>
            </span>
          </div>
          <div class="lib-root-acts">
            <button class="lib-mini" :disabled="!!rootBusy" @click="relocateRootDir(r)">换目录</button>
            <button class="lib-mini" :disabled="!!rootBusy" @click="dropRoot(r)">解除</button>
          </div>
        </div>
      </div>

      <!-- P2-2 书目清单：三种格式共用一张行表，落盘仍走唯一那条另存为 -->
      <div class="lib-export" aria-label="导出书目清单">
        <span class="lib-export-label">书目清单</span>
        <button class="lib-mini" :disabled="!!exporting" @click="exportList('csv')">CSV</button>
        <button class="lib-mini" :disabled="!!exporting" @click="exportList('json')">JSON</button>
        <button class="lib-mini" :disabled="!!exporting" @click="exportList('opds')">OPDS</button>
      </div>

      <p class="lib-foot">点文件夹筛这一摞书；点书名看右栏，双击直接翻开。书架只认本机电子书。</p>
    </aside>

    <div
      class="lib-split" role="separator" aria-orientation="vertical" aria-label="调整左栏宽度" tabindex="0"
      @pointerdown="startDrag('nav', $event)" @pointermove="onDrag" @pointerup="endDrag"
      @pointercancel="endDrag" @dblclick="resetLayout"
      @keydown.left.prevent="nudge('nav', -16)" @keydown.right.prevent="nudge('nav', 16)"
    ></div>

    <!-- ==================== 中栏：书架本体（复用主窗那套 ReadingView） ==================== -->
    <main class="lib-main" aria-label="书架">
      <p v-if="thead" class="lib-notice" role="status">{{ thead }}</p>
      <ReadingView
        :record="record" :today="today" :scope="scope" :embedded="true" :data-tick="dataTick"
        @back="closeWindow"
        @notify="say" @changed="onChanged"
        @save="() => {}" @open-cell="() => {}"
      />
    </main>

    <div
      class="lib-split" role="separator" aria-orientation="vertical" aria-label="调整右栏宽度" tabindex="0"
      @pointerdown="startDrag('rail', $event)" @pointermove="onDrag" @pointerup="endDrag"
      @pointercancel="endDrag" @dblclick="resetLayout"
      @keydown.left.prevent="nudge('rail', 16)" @keydown.right.prevent="nudge('rail', -16)"
    ></div>

    <!-- ==================== 右栏：选中了什么 ==================== -->
    <aside class="lib-right" aria-label="详情">
      <template v-if="picked">
        <div class="lib-detail-cover" :style="{ background: pickedCover ? 'var(--surface-panel)' : coverHue(picked) }">
          <img v-if="pickedCover" :src="pickedCover" :alt="picked.title + ' 封面'" class="lib-detail-img" />
          <span v-else>{{ picked.title }}</span>
        </div>
        <h2 class="lib-right-title">《{{ picked.title }}》</h2>
        <p class="lib-detail-sub">{{ picked.author || '作者未填' }}</p>
        <div class="lib-kv"><span>格式</span><b>{{ picked.format || '—' }}<template v-if="picked.fileSizeText"> · {{ picked.fileSizeText }}</template></b></div>
        <div class="lib-kv"><span>进度</span><b>{{ picked.progressText }}</b></div>
        <div class="lib-kv"><span>状态</span><b>{{ picked.statusLabel }}</b></div>
        <div class="lib-kv"><span>笔记</span><b>{{ picked.noteCount }} 条</b></div>
        <p v-if="picked.filePath" class="lib-path" :title="picked.filePath">{{ picked.filePath }}</p>
        <div class="lib-detail-acts">
          <button class="lib-mini lib-mini-main" :disabled="!picked.filePath || picked.fileMissing" @click="openBook(picked)">翻开读</button>
          <!-- P0-2：文件被移走时，这里换路径而不是「移出再添加」 -->
          <button v-if="picked.fileMissing" class="lib-mini" :disabled="relinking" @click="relinkPicked">重新关联</button>
          <button class="lib-mini" @click="pickedId = ''">收起</button>
        </div>
        <p v-if="picked.fileMissing" class="lib-hint">原文件不在这个位置了。点「重新关联」选它的新位置——书的 id 不变，笔记与书签都跟着回来。</p>
        <p v-else-if="!picked.filePath" class="lib-hint">这本没有电子书，只有笔记。</p>

        <!-- P2-1 标签：与「分组」并存。分组决定「放哪一摞」，标签决定「还能从哪些入口找到它」。 -->
        <div class="lib-section lib-tags">
          <h3>标签</h3>
          <div class="lib-tag-row">
            <span v-for="t in (picked.tags || [])" :key="t" class="lib-tag">
              #{{ t }}
              <button class="lib-tag-x" :aria-label="'去掉标签 ' + t" @click="dropTag(t)">×</button>
            </span>
            <span v-if="!(picked.tags || []).length" class="lib-hint">还没有标签。</span>
          </div>
          <div class="lib-tag-add">
            <input
              v-model="tagInput" class="lib-tag-input" type="text" maxlength="24"
              placeholder="加个标签，回车" aria-label="给这本书加标签"
              @keydown.enter.prevent="addTag"
            />
            <button class="lib-mini" :disabled="!tagInput.trim()" @click="addTag">加</button>
          </div>
          <p class="lib-hint">加完左栏「虚拟书架」下会多一摞同名书架，点它就能筛出同一标签的所有书。</p>
        </div>

        <!-- P2-4 书在哪：相对路径是「跟着书库根走」的那半边，换机器靠它 -->
        <div v-if="picked.relPath" class="lib-kv lib-kv-rel">
          <span>书库内位置</span><b :title="picked.relPath">{{ picked.relPath }}</b>
        </div>

        <!-- P1-2 反向关联卡：零落库、纯只读派生。
             这一块回答的是「我读过的那句话，后来到底用上了没有」。 -->
        <div v-if="pickedRefs" class="lib-section lib-refs">
          <h3>它后来去了哪</h3>
          <p class="lib-hint">
            {{ pickedRefs.noteCount }} 条笔记
            · 日记里回写 {{ pickedRefs.diary.length }} 次
            · 生成 {{ pickedRefs.tasks.length }} 条任务<template v-if="pickedRefs.theme"> · 属于主题「{{ pickedRefs.theme.title }}」</template>
          </p>
          <div v-for="d in pickedRefs.diary.slice(0, 4)" :key="d.date + d.cell" class="lib-ref-row">
            <span class="lib-ref-date">{{ d.date }}</span>
            <span class="lib-ref-text">{{ d.text }}</span>
          </div>
          <p v-if="!pickedRefs.diary.length" class="lib-hint">还没有回写进九格。在阅读窗里点「→ 九格」会追加一行，这里就能看见。</p>
          <div v-if="pickedRefs.tasks.length" class="lib-ref-tasks">
            <span v-for="t in pickedRefs.tasks.slice(0, 4)" :key="t.id" class="lib-ref-task" :data-done="t.status === 'done' ? '1' : '0'">
              {{ t.title }}<span v-if="t.status === 'done'"> · 已完成</span>
            </span>
          </div>
        </div>
      </template>

      <template v-else>
        <h2 class="lib-right-title">{{ scopeLabel }}</h2>
        <p class="lib-detail-sub">左栏点文件夹换范围，中栏看这一摞书。</p>
        <!-- 读书笔记这一栏没有「几本」，四格换成笔记自己的口径 -->
        <div v-if="scope.kind === 'notes'" class="lib-kpis">
          <div class="lib-kpi"><span>笔记</span><b>{{ notesKpi.total }}</b></div>
          <div class="lib-kpi"><span>本月</span><b>{{ notesKpi.month }}</b></div>
          <div class="lib-kpi"><span>已入九格</span><b>{{ notesKpi.pushed }}</b></div>
          <div class="lib-kpi"><span>标签</span><b>{{ notesKpi.tags }}</b></div>
        </div>
        <div v-else class="lib-kpis">
          <div class="lib-kpi"><span>本数</span><b>{{ scopeKpi.count }}</b></div>
          <div class="lib-kpi"><span>在读</span><b>{{ scopeKpi.reading }}</b></div>
          <div class="lib-kpi"><span>读完</span><b>{{ scopeKpi.done }}</b></div>
          <div class="lib-kpi"><span>笔记</span><b>{{ scopeKpi.notes }}</b></div>
        </div>
        <div class="lib-section">
          <h3>这个范围</h3>
          <p class="lib-hint">休闲 {{ leisureBooks.length }} 本 · 主题 {{ themeBookCount }} 本 · 笔记共 {{ board?.stats.notes || 0 }} 条（本月 {{ board?.stats.thisMonth || 0 }} 条）</p>
        </div>
        <div class="lib-section">
          <h3>最近留下的话</h3>
          <button v-for="n in recentNotes" :key="n.id" class="lib-note" @click="pickNotes()">
            <span class="lib-note-main">{{ n.quote || n.text }}</span>
            <span class="lib-note-side">{{ n.bookTitle }}</span>
          </button>
          <p v-if="!recentNotes.length" class="lib-hint">还没有笔记。翻开一本书，留一句摘录。</p>
        </div>
      </template>
    </aside>
  </section>
</template>

<style scoped>
.lib-app {
  display: flex; height: 100vh; box-sizing: border-box;
  background: var(--surface-bg); color: var(--surface-text);
  font-family: var(--font-sans);
}
.lib-left, .lib-main, .lib-right { overflow-y: auto; height: 100%; box-sizing: border-box; }
.lib-left {
  flex: 0 0 auto; width: var(--lib-nav-w, 252px); min-width: 0;
  border-right: 1px solid var(--surface-border);
  padding: var(--space-3); background: var(--surface-panel);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.lib-main { flex: 1 1 auto; min-width: 0; padding: var(--space-4); }
.lib-right {
  flex: 0 0 auto; width: var(--lib-rail-w, 300px); min-width: 0;
  border-left: 1px solid var(--surface-border);
  padding: var(--space-3); background: var(--surface-panel);
}
.lib-split { flex: 0 0 6px; position: relative; cursor: col-resize; background: transparent; outline: none; }
.lib-split::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 2px; right: 2px;
  border-radius: 2px; background: transparent; transition: background 0.12s;
}
.lib-split:hover::after, .lib-split:focus-visible::after { background: var(--palette-border); }
.lib-dragging { user-select: none; }
.lib-dragging .lib-split::after { background: var(--palette-primary); }

.lib-brand h1 { margin: 0; font-size: var(--text-h1); }
.lib-brand p { margin: 3px 0 6px; font-size: var(--text-xs); color: var(--surface-muted); }

/* 树：一行一个节点，右边永远是数量（calibre 的算式：名字左、数字右） */
.lib-tree { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.lib-node { display: flex; flex-direction: column; gap: 1px; }
.lib-kids { display: flex; flex-direction: column; gap: 1px; padding-left: 16px; }
.lib-kids-book { padding-left: 14px; }
.lib-row {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 4px 6px; border: 0.5px solid transparent; border-radius: var(--radius-sm);
  background: transparent; color: var(--surface-text); font-size: var(--text-sm);
  text-align: left; cursor: pointer; min-width: 0;
}
.lib-row:hover { background: var(--palette-soft); }
.lib-row-on { background: var(--palette-soft); border-color: var(--palette-border); color: var(--palette-primary); }
.lib-row-on .lib-count { color: var(--palette-primary); }
.lib-root { font-weight: 500; }
.lib-row-single { margin-top: 2px; }
/* 每一行都是「折叠箭 / 图标 / 名字 / 数字」四列：箭头与图标各占固定宽度，
   有没有箭头、图标是文件夹还是书，都不影响名字的起始位置——树才不会参差。 */
.lib-caret {
  flex: 0 0 auto; width: 12px; text-align: center; font-size: 10px;
  color: var(--surface-muted); cursor: pointer; user-select: none;
}
.lib-caret-none { visibility: hidden; cursor: default; }
.lib-ico { flex: 0 0 12px; display: inline-flex; align-items: center; justify-content: center; }
.lib-folder {
  width: 11px; height: 9px; border-radius: 2px 2px 1px 1px;
  background: var(--palette-primary); opacity: 0.55; position: relative;
}
.lib-folder::before {
  content: ''; position: absolute; top: -3px; left: 0; width: 6px; height: 3px;
  border-radius: 2px 2px 0 0; background: inherit; opacity: 0.9;
}
/* 组 / 主题这种「能打开看里面」的文件夹用描边款：实心款留给两个根 */
.lib-folder-open {
  width: 11px; height: 9px; border-radius: 2px;
  border: 1px solid var(--palette-border); background: transparent; position: relative;
}
.lib-folder-open::before {
  content: ''; position: absolute; top: -3px; left: -1px; width: 6px; height: 3px;
  border: 1px solid var(--palette-border); border-bottom: 0; border-radius: 2px 2px 0 0;
}
.lib-book-ico {
  width: 7px; height: 9px; border-radius: 1px;
  border-left: 2px solid var(--palette-primary); background: var(--surface-raised);
  border-top: 1px solid var(--palette-border); border-right: 1px solid var(--palette-border); border-bottom: 1px solid var(--palette-border);
  opacity: 0.8;
}
.lib-folder-note { opacity: 0.35; }
.lib-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-count { flex: 0 0 auto; font-size: var(--text-xs); color: var(--palette-primary); font-variant-numeric: tabular-nums; }
.lib-leaf .lib-name { font-size: var(--text-sm); }
.lib-book .lib-name { font-size: var(--text-xs); color: var(--surface-muted); }
.lib-book.lib-row-on .lib-name { color: var(--palette-primary); }
.lib-empty { margin: 2px 0 4px 34px; font-size: var(--text-xs); color: var(--surface-muted); }
.lib-foot { margin: 0; font-size: var(--text-xs); line-height: 1.6; color: var(--surface-muted); border-top: 0.5px solid var(--surface-border); padding-top: var(--space-2); }

/* P2-1 虚拟书架：规则集合不是文件夹，用虚一点的分隔和淡色区分 */
.lib-sub-head {
  margin: 6px 0 2px; font-size: var(--text-xs); color: var(--surface-muted);
  letter-spacing: 0.04em;
}
.lib-folder-rule { opacity: 0.72; }
.lib-row-dim { opacity: 0.55; }

/* P2-4 书库根 / P2-2 书目清单：左栏底部两块，都与「整库」有关 */
.lib-roots { border-top: 0.5px solid var(--surface-border); padding-top: var(--space-2); display: flex; flex-direction: column; gap: 4px; }
.lib-roots-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.lib-roots-head h2 { margin: 0; font-size: var(--text-xs); color: var(--surface-muted); font-weight: 600; letter-spacing: 0.04em; }
.lib-root-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.lib-root-main { display: flex; flex-direction: column; min-width: 0; }
.lib-root-main b {
  font-size: var(--text-xs); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lib-root-meta { font-size: var(--text-xs); color: var(--surface-muted); }
.lib-root-acts { display: flex; gap: 4px; flex: 0 0 auto; }
.lib-export { display: flex; align-items: center; gap: 4px; border-top: 0.5px solid var(--surface-border); padding-top: var(--space-2); }
.lib-export-label { font-size: var(--text-xs); color: var(--surface-muted); margin-right: auto; }

/* 右栏标签 */
.lib-tags .lib-tag-row { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: var(--space-2); }
.lib-tag {
  display: inline-flex; align-items: center; gap: 2px; padding: 1px 4px 1px 6px;
  border-radius: var(--radius-sm); font-size: var(--text-xs);
  background: var(--palette-soft); color: var(--palette-primary);
}
.lib-tag-x {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  font-size: var(--text-xs); line-height: 1; padding: 0 2px;
}
.lib-tag-add { display: flex; gap: 4px; }
.lib-tag-input {
  flex: 1 1 auto; min-width: 0; padding: 3px 6px; font-size: var(--text-xs);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-bg); color: var(--surface-text);
}
.lib-kv-rel b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.lib-notice {
  margin: 0 0 var(--space-2); padding: 5px 9px; border-radius: var(--radius-md);
  background: var(--palette-soft); color: var(--palette-primary); font-size: var(--text-xs);
}

/* 右栏 */
.lib-right-title { margin: 0; font-size: var(--text-h2); }
.lib-detail-sub { margin: 2px 0 var(--space-2); font-size: var(--text-xs); color: var(--surface-muted); }
.lib-detail-cover {
  display: flex; align-items: center; justify-content: center; text-align: center;
  height: 168px; border-radius: var(--radius-md); margin-bottom: var(--space-2);
  padding: 10px; box-sizing: border-box;
  font-size: var(--text-sm); line-height: 1.4; color: rgba(255, 255, 255, .95);
  text-shadow: 0 1px 6px rgba(0, 0, 0, .22); word-break: break-word; overflow: hidden;
}
.lib-detail-img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 2px; }
.lib-kv { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; font-size: var(--text-sm); border-top: 0.5px solid var(--surface-border); }
.lib-kv span { flex: 0 0 44px; color: var(--surface-muted); font-size: var(--text-xs); }
.lib-kv b { font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
.lib-path { margin: 6px 0 0; font-size: var(--text-xs); color: var(--surface-muted); overflow-wrap: anywhere; }
.lib-detail-acts { display: flex; gap: 6px; margin-top: var(--space-2); }
.lib-mini {
  padding: 4px 10px; font-size: var(--text-xs); cursor: pointer;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); color: var(--surface-text);
}
.lib-mini-main { background: var(--palette-primary); border-color: var(--palette-primary); color: var(--palette-on); }
.lib-mini:disabled { opacity: 0.5; cursor: default; }
.lib-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: var(--space-2); }
.lib-kpi { background: var(--surface-raised); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); padding: 6px 8px; }
.lib-kpi span { display: block; font-size: var(--text-xs); color: var(--surface-muted); }
.lib-kpi b { display: block; font-size: var(--text-h2); font-weight: 500; line-height: 1.4; }
.lib-section { margin-top: var(--space-3); }
.lib-section h3 { margin: 0 0 4px; font-size: var(--text-sm); font-weight: 500; color: var(--surface-muted); }
.lib-hint { margin: 0; font-size: var(--text-xs); line-height: 1.6; color: var(--surface-muted); }
.lib-note {
  display: block; width: 100%; margin-top: 4px;
  padding: 5px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); color: var(--surface-text); font-size: var(--text-sm); text-align: left;
}
.lib-note:hover { border-color: var(--palette-border); background: var(--palette-soft); }
/* 右栏只有 288px：正文给两行，书名单独一行，别把两头都挤成省略号 */
.lib-note-main {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; line-height: 1.55;
}
.lib-note-side { display: block; margin-top: 2px; font-size: var(--text-xs); color: var(--surface-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* P1-2 反向关联卡：一行一条「哪天的哪一格写过它」，300px 里压成两行 */
.lib-refs { border-top: 0.5px solid var(--surface-border); padding-top: var(--space-2); }
.lib-ref-row { display: block; margin-top: 4px; padding: 4px 6px; border-radius: var(--radius-sm); background: var(--surface-raised); border: 0.5px solid var(--surface-border); }
.lib-ref-date { display: block; font-size: var(--text-xs); color: var(--palette-primary); font-variant-numeric: tabular-nums; }
.lib-ref-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: var(--text-sm); line-height: 1.5; }
.lib-ref-tasks { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
.lib-ref-task { font-size: var(--text-xs); color: var(--surface-muted); border-left: 2px solid var(--palette-border); padding-left: 6px; }
.lib-ref-task[data-done="1"] { text-decoration: line-through; opacity: 0.7; }
@media (max-width: 1024px) {
  .lib-split { display: none; }
  .lib-left { width: 180px; }
  .lib-right { display: none; }
  .lib-main { padding: var(--space-2); }
}
</style>
