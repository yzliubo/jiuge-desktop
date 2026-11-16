<script setup lang="ts">
// 图书馆：休闲娱乐阅读 / 主题阅读 / 读书笔记（数据库）。
// 三条硬口径（docs/13，V2.14 已更新）：
//   1. 主题书单权威源已迁到 md_reading：themes[] + books[].themeId；主题书与休闲书共用
//      同一套 books / 阅读窗口 / 三阶九问，笔记按 themeId 归到主题下（旧 growth 书单只读保留）；
//   2. 两类阅读的笔记统一进 md_reading.notes，即「读书笔记」数据库；
//   3. 笔记写进九格只能追加、必须带出处，且补记态不许冒充当天。
// 类名一律 rd- 前缀：项目里 .cell / .heat-cell 都因撞名炸过真 GUI 断言。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DiaryRecord } from '../types';
import { callDomain } from '../composables/useDomain';
import { saveExport, listDiaries, upsertDiary, pickBookFiles, pickImageFile, pathForFile, openReader, doubanCovers, doubanApply } from '../bridge';

interface BookRow {
  id: string; title: string; author: string; total: number; done: number;
  unit: string; status: string; pct: number; progressText: string;
  statusLabel: string; noteCount: number; note: string; coverColor: string;
  filePath: string; fileExt: string; fileSize: number; format: string;
  coverId: string; source: string; hasFile: boolean; themeId: string;
  // 书架顺序（越小越靠前）与「最近在读」毫秒时间戳：都由领域层写入，渲染层只读
  order?: number; lastReadAt?: number;
  // V3.5 分组只是书上的一个名字，收藏只是一个布尔视图；分组清单由 board() 派生
  group?: string; favorite?: boolean;
  fileMissing?: boolean; fileSizeText?: string;
}
// V2.14：主题书（books 里 themeId 非空的记录）按主题分组展示，带 filePath 可进阅读窗
interface ThemeGroup {
  themeId: string; themeTitle: string; note: string; rows: BookRow[];
}
interface NoteRow {
  id: string; mode: string; bookId: string; themeId: string; bookTitle: string;
  type: string; quote: string; text: string; page: number; tags: string[];
  chapterId: string; createdAt: number; pushedAt: number; pushedCell: string;
  typeLabel?: string; modeLabel?: string; pushed?: boolean; orphan?: boolean;
}
interface ChapterRow { id: string; bookId: string; title: string; parentId: string; order: number; anchor?: string }
interface Stats {
  books: number; themeBooks?: number; notes: number; highlights: number; ideas: number; pushed: number;
  leisureNotes: number; themeNotes: number; tagCount: number; thisMonth: number;
}
interface BoardData {
  stats: Stats; books: BookRow[];
  // V3.13：书架只取 leisureBooks（主题书不混进休闲书架）；books 仍是全部，供别处只读引用
  leisureBooks?: BookRow[];
  // P0-1：themeBooks 已从 board() 删除——旧 growth 书单不再进视图，主题书只看 themeGroups
  themeGroups: ThemeGroup[];
  // 分组清单（派生值，不是独立表）与收藏总数
  groups: Array<{ name: string; count: number }>; favoriteCount: number;
  // P2-1：虚拟书架（规则集合 + 标签集合）。只有 id 列表，书仍是上面那一份。
  shelves?: Array<{ key: string; kind: string; label: string; count: number; ids: string[] }>;
  recent: NoteRow[]; tagTop: Array<{ tag: string; count: number }>;
}
interface NotesResult {
  items: NoteRow[]; total: number;
  byTag: Array<{ tag: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  byMonth: Array<{ month: string; count: number }>;
}
// 书库体检报告（P0-4）：对标 calibre check_library，只报告不自动改数据。
// counts 是给人看的四项数字，其余是展开看「具体是哪几条」。
interface AuditReport {
  counts: {
    books: number; notes: number; themes: number;
    danglingNotes: number; danglingChapters: number; danglingBookmarks: number; danglingBooks: number;
    dupFingerprints: number; dupTitles: number; notesNoSource: number;
    missingFiles: number; booksNoFingerprint: number;
  };
  dangling: {
    notes: Array<{ id: string; bookId: string; themeId: string; bookTitle: string }>;
    chapters: Array<{ id: string; bookId: string; title: string }>;
    bookmarks: Array<{ id: string; bookId: string; label: string }>;
    books: Array<{ id: string; themeId: string; title: string }>;
  };
  missingFiles: Array<{ id: string; title: string; filePath: string }>;
  dupFingerprints: Array<{ fingerprint: string; books: Array<{ id: string; title: string; filePath: string }> }>;
  dupTitles: Array<{ title: string; books: Array<{ id: string; title?: string; filePath: string }> }>;
}
// 一次「修复断链」的改动凭据：撤销就是把它原样回放
interface RepairChange { coll: 'notes' | 'books'; id: string; field: string; from: string }
interface ActiveBook {
  mode: 'leisure' | 'theme'; bookId: string; themeId: string; title: string; total: number; done: number;
}

// V3.14：图书馆改成独立窗口后，左栏的文件夹树是「范围」的唯一来源。
// 树点了哪个节点，这里就切到对应的页签与筛选——两侧看的是同一份范围，不各留一份状态。
// 不给 scope 时（例如早先的内嵌用法）完全按自己的记忆走，行为不变。
const props = defineProps<{
  record: DiaryRecord; today: string; backfill?: boolean;
  scope?: { kind: 'leisure' | 'theme' | 'notes' | 'shelf'; group?: string; themeId?: string; shelfKey?: string } | null;
  // V3.14：嵌进独立窗口时收起大标题与统计头——左栏品牌区已经有「图书馆」，
  // 右栏也已经把本数 / 在读 / 笔记摆成四格，中栏再重复一遍只是白占一屏高度。
  embedded?: boolean;
  // 外部数据变更的信号（窗口收到主进程广播后自增）：书架不许只信挂载时取的那一份。
  // 少了这条，主窗写完一本书、图书馆窗口还停在旧数。
  dataTick?: number;
}>();
const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
  (e: 'back'): void;
  (e: 'changed'): void;
  (e: 'open-cell', key: string): void;
}>();

const tab = ref<'shelf' | 'theme' | 'notes'>('shelf');
const board = ref<BoardData | null>(null);
const notes = ref<NoteRow[]>([]);
const noteTotal = ref(0);
const byTag = ref<Array<{ tag: string; count: number }>>([]);
const chapters = ref<ChapterRow[]>([]);
const active = ref<ActiveBook | null>(null);
const busy = ref(false);

// 章节大纲（本地两层树，不是 AI 生成的思维导图）
const newChapter = ref('');
// P2-3：加章节时顺手填「书内第几节」（可空）。空着就是纯大纲。
const newChapterSeq = ref('');
// 笔记表单：摘录 + 自己的话 + 页码 + #tag
const noteType = ref('highlight');
const noteQuote = ref('');
const noteText = ref('');
const notePage = ref('');
const noteTags = ref('');
// 即时想法：回车即存，同时进读书笔记与九格
const flash = ref('');
const flashCell = ref('free');
// 主题阅读自建书单
const newThemeTitle = ref('');
const newThemeNote = ref('');
const newThemeBook = ref('');       // 主题下手工加书（无本机文件的书）
const themeSel = ref('');            // 当前展开的主题 id
const importingTheme = ref('');      // 正在导入文件的主题 id
// ---- P0-2 / P0-4：书籍身份与书库体检 ----
// 体检报告整份放内存，不落库（它是派生值，每次点开现算）。
const auditOpen = ref(false);
const auditBusy = ref(false);
const auditReport = ref<AuditReport | null>(null);
// 修复的撤销凭据：只活在这一次窗口会话里。关窗即失效——不为撤销再开一个数据键。
const repairUndo = ref<RepairChange[]>([]);
const relinking = ref('');
// 读书笔记库筛选
const kw = ref('');
const fMode = ref('');
const fType = ref('');
const fTag = ref('');
// 书架整理（2026-11-14，对标 mybook 1.0.29 的书架更新）：搜索 / 排序 / 编辑信息
const shelfKw = ref('');
// V3.13：列表改成 calibre 那样的表，列头可点排序；manual 是「书架自己的顺序」（order 字段）
type SortKey = 'manual' | 'recent' | 'title' | 'author' | 'size' | 'date' | 'pct' | 'notes';
const SORT_KEY = 'jiuge.reading.sortMode';
const sortMode = ref<SortKey>('manual');
const sortAsc = ref(true);
// 每个维度第一次点时朝哪个方向：书名/作者从小到大，大小/日期/进度/笔记从大到小
// （「最厚 / 最近 / 读得最多」比反过来有用，默认别让人多点一次）
const SORT_ASC: Record<SortKey, boolean> = {
  manual: true, recent: false, title: true, author: true,
  size: false, date: false, pct: false, notes: false
};
// 拖动只记 id，落库交给 reading.reorder 统一重排；拖到谁身上只影响高亮
const dragId = ref('');
const dragOverId = ref('');
const editing = ref<BookRow | null>(null);
const editTitleEl = ref<HTMLInputElement | null>(null);
const editTitle = ref('');
const editAuthor = ref('');
const editCoverBusy = ref(false);
// ---- V3.5 书架分组 / 收藏夹 ----
// 两个保留值不与用户分组名撞车：用户分组名走 clean() 后不会是这种带双下划线的形态。
const GROUP_ALL = '__all__';
const GROUP_FAV = '__fav__';
// V3.15：「未分组」在库里不是一个名字，而是 group 为空字符串。左栏（LibraryWindow 的 UNGROUPED）
// 与中栏必须用同一个保留值，否则筛出来一本都没有——字面量两处一致，改一处就要改两处。
const GROUP_NONE = '\u0000none';
const GROUP_KEY = 'jiuge.reading.groupFilter';
const groupFilter = ref<string>(GROUP_ALL);
// 虚拟书架筛选：空 = 不筛。与 groupFilter 是两条独立的轴（规则集合 vs 分组），
// 但同屏只允许一条生效——两条一起用会得到一个谁也说不清的空列表。
const shelfFilter = ref('');
const groups = computed<Array<{ name: string; count: number }>>(() => board.value?.groups || []);
// 与左栏「未分组」同一口径：只数休闲书里 group 为空的那几本（books 已经是 leisure 清单）
const ungroupedCount = computed(() => books.value.filter((b) => !b.group).length);
const favoriteCount = computed(() => board.value?.favoriteCount || 0);
const groupAdding = ref(false);
const newGroupName = ref('');
const groupRenaming = ref(false);
const groupRenameValue = ref('');
const groupDeleteConfirm = ref(false);
// 「所属分组」可填一个还不存在的名字：新建分组就发生在保存这本书的那一刻
const editGroup = ref('');
const editGroupNew = ref(false);

const NOTE_TYPES: Array<{ key: string; label: string }> = [
  { key: 'highlight', label: '摘录' }, { key: 'note', label: '笔记' },
  { key: 'idea', label: '想法' }, { key: 'link', label: '关联' }
];
// 伴读三问：不联网的 I-P-O 链路，点一下就预置成对应笔记类型
const PROMPTS: Array<{ id: string; label: string; hint: string; type: string }> = [
  { id: 'p1', label: '这段让我想到什么', hint: '写下此刻冒出来的念头，别等', type: 'idea' },
  { id: 'p2', label: '它和哪本书连得上', hint: '找到书与书之间的那根线', type: 'link' },
  { id: 'p3', label: '我能拿它做什么', hint: '把读到的变成能动手的一步', type: 'note' }
];
const activePrompt = ref('');

const stats = computed<Stats>(() => board.value?.stats || {
  books: 0, themeBooks: 0, notes: 0, highlights: 0, ideas: 0, pushed: 0,
  leisureNotes: 0, themeNotes: 0, tagCount: 0, thisMonth: 0
});
// 书架 = 只含休闲书。主题书按主题归到「主题阅读」，两边各看各的：
// 一个主题动辄十几份同主题文件，混进书架会把随手翻的书整片顶走。
const books = computed<BookRow[]>(() => {
  const bd = board.value;
  if (!bd) return [];
  return bd.leisureBooks || (bd.books || []).filter((b) => !b.themeId);
});
// 封面要按「全部书」取：主题行的缩略图同样是书里的封面图，
// 只按书架那一份去取，主题阅读里就全变成色块了。
const allBooks = computed<BookRow[]>(() => board.value?.books || []);
// 书架搜索：书名 / 作者 / 格式 / 备注四处都算命中——记不住书名时按作者找也找得到。
// 只在渲染层过滤，不动库：搜索是「看一眼」，不是一次写操作。
const shelfBooks = computed<BookRow[]>(() => {
  const k = shelfKw.value.trim().toLowerCase();
  // 虚拟书架的范围是「整库」：规则集合里可能同时有休闲书与主题书，
  // 只从 leisureBooks 起筛会让左栏数字比中栏多，看着像丢书。
  const sk = shelfFilter.value;
  let list = sk ? allBooks.value : books.value;
  // P2-1 虚拟书架：左栏点一个规则集合，中栏只留这一摞。
  // 规则在本机派生（board.shelves 给 id 列表），这里按 id 筛——不复制书籍记录。
  if (sk) {
    const hit = (board.value?.shelves || []).filter((s) => s.key === sk)[0];
    const ids = hit ? hit.ids : [];
    const seen: Record<string, boolean> = {};
    ids.forEach((id) => { seen[id] = true; });
    list = list.filter((b) => !!seen[b.id]);
  }
  // 分组 / 收藏夹先筛，再走关键词；两者都是「看一眼」，库里一本都不动
  const g = groupFilter.value;
  if (g === GROUP_FAV) list = list.filter((b) => !!b.favorite);
  else if (g === GROUP_NONE) list = list.filter((b) => !b.group);
  else if (g !== GROUP_ALL) list = list.filter((b) => (b.group || '') === g);
  if (k) {
    list = list.filter((b) => (
      (b.title || '').toLowerCase().indexOf(k) >= 0
      || (b.author || '').toLowerCase().indexOf(k) >= 0
      || (b.format || '').toLowerCase().indexOf(k) >= 0
      || (b.note || '').toLowerCase().indexOf(k) >= 0
    ));
  }
  if (sortMode.value === 'manual') return list;
  const dir = sortAsc.value ? 1 : -1;
  const byText = (a: string, b: string) => a.localeCompare(b, 'zh-Hans-CN');
  if (sortMode.value === 'recent') {
    // 最近在读：翻过的排前面；没翻过的保持原书架次序接在后面
    return list.slice().sort((a, b) => ((b.lastReadAt || 0) - (a.lastReadAt || 0)) || ((a.order || 0) - (b.order || 0)));
  }
  const cmp = (a: BookRow, b: BookRow): number => {
    switch (sortMode.value) {
      case 'title': return byText(a.title || '', b.title || '');
      case 'author': return byText(a.author || '', b.author || '');
      case 'size': return (a.fileSize || 0) - (b.fileSize || 0);
      case 'date': return (a.lastReadAt || 0) - (b.lastReadAt || 0);
      case 'pct': return (a.pct || 0) - (b.pct || 0);
      case 'notes': return (a.noteCount || 0) - (b.noteCount || 0);
      default: return 0;
    }
  };
  return list.slice().sort((a, b) => (dir * cmp(a, b)) || ((a.order || 0) - (b.order || 0)));
});
// 搜索态 / 分组筛选态都不许拖：看不见的书会被挤出可见区，等于替用户改了没打算改的顺序
const canDrag = computed(() => sortMode.value === 'manual' && !shelfKw.value.trim()
  && groupFilter.value === GROUP_ALL && !shelfFilter.value);
// P0-1：这里原先还有一个 themeBooks computed（board.themeBooks 的镜像）。
// 那个数组从来没被模板用过（模板只读 stats.themeBooks 这个数字），却让「同一份书单」
// 在 IPC 里来回传了两份。board() 现在不返回它，这里也不再有这个「幽灵变量」。
// V2.14：主题书格局 md_reading.books 派生（每行是 BookRow，有 id 可直接开阅读窗）
const themeGroups = computed<ThemeGroup[]>(() => board.value?.themeGroups || []);
// V3.15：主题默认展开，三角只管「这一摞先不看」。折叠状态不写盘——
// 收起只是当下的动作，下次进来该看见内容还在。也不与 themeSel（左栏选中）混成一个状态：
// 选中是「现在在看这个主题」，收起是「这一摞先合上」，两件事分开才不会点一下就互相打架。
const closedThemes = ref<string[]>([]);
function isThemeClosed(id: string): boolean { return closedThemes.value.indexOf(id) >= 0; }
function toggleTheme(id: string): void {
  closedThemes.value = isThemeClosed(id)
    ? closedThemes.value.filter((x) => x !== id)
    : closedThemes.value.concat([id]);
}
const tagTop = computed(() => board.value?.tagTop || []);
const activeChapters = computed(() => {
  if (!active.value) return [];
  return chapters.value.filter((c) => c.bookId === active.value!.bookId);
});
const activeNotes = computed(() => notes.value.filter((n) => active.value && n.bookId === active.value.bookId));

function fmtDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function loadNotes(): Promise<void> {
  const q = await callDomain<NotesResult | null>('reading.notes', null, {
    keyword: kw.value, mode: fMode.value, type: fType.value, tag: fTag.value
  });
  notes.value = q?.items || [];
  noteTotal.value = q?.total || 0;
  byTag.value = q?.byTag || [];
}

async function load(): Promise<void> {
  board.value = await callDomain<BoardData | null>('reading.board', null);
  // 上次筛的分组被改名 / 解散后，别让书架停在一个永远空着的筛选上。
  // 「收藏夹 / 未分组」是保留值，不在 groups 清单里，不能拿这条守卫把它们清掉。
  const g = groupFilter.value;
  if (g !== GROUP_ALL && g !== GROUP_FAV && g !== GROUP_NONE
    && !(board.value?.groups || []).some((x) => x.name === g)) {
    setGroupFilter(GROUP_ALL);
  }
  const raw = await callDomain<{ chapters?: ChapterRow[] } | null>('reading.read', null);
  chapters.value = raw?.chapters || [];
  await loadNotes();
  await loadCovers();
}

async function reload(): Promise<void> {
  await load();
  emit('changed');
}

// ---- 本地电子书：拖放 / 点击选择 / 三种陈列 ----
// 只登记绝对路径，不把书的内容搬进库；封面是主进程读 EPUB 后落盘、按需转 dataURL 回传。
const VIEW_KEY = 'jiuge.reading.viewMode';
const viewMode = ref<'list' | 'grid' | 'shelf'>('list');
const dragOver = ref(false);
const importing = ref(false);
const coverMap = ref<Record<string, string>>({});

function setViewMode(m: 'list' | 'grid' | 'shelf'): void {
  viewMode.value = m;
  try { localStorage.setItem(VIEW_KEY, m); } catch { /* 隐私模式下只在本轮生效 */ }
  if (m !== 'list') void loadCovers();
}

// 封面一律取书里自带的那张；没有才由渲染层回落到首字 + 渐变。
// 不拿 coverId 当门槛：老书当年可能没抽到，主进程会按需补抽一次并记下来。
const coverTried = new Set<string>();
async function loadCovers(): Promise<void> {
  const rows = allBooks.value.filter((b) => {
    if (coverMap.value[b.id] || coverTried.has(b.id)) return false;
    if (!b.filePath || b.fileMissing || String(b.fileExt || '').toLowerCase() !== 'epub') return false;
    return true;
  });
  rows.forEach((b) => coverTried.add(b.id));
  await Promise.all(rows.map(async (b) => {
    const url = await callDomain<string>('reading.cover', '', b.id);
    if (url) coverMap.value = { ...coverMap.value, [b.id]: url };
  }));
}
function coverOf(b: BookRow): string { return coverMap.value[b.id] || ''; }
// V3.13：没有封面时，占位封面上直接印**完整书名**，不再只印一个字。
// 一个「移」认不出是哪本书，尤其主题阅读下一个主题里躺着十几份同主题文件——
// 「移动平均线策略在中国的…」和「移动平均线策略回测」在单字占位里长得一模一样。
// 字号按字数分级靠缩小来放下，不截断：宁可小，也不要让它变成第二个「略」。
function coverNameStyle(title: string, base: number): Record<string, string> {
  const n = Array.from(title || '书').length;
  const step = n <= 4 ? 1 : n <= 8 ? 0.74 : n <= 12 ? 0.58 : n <= 20 ? 0.48 : n <= 30 ? 0.4 : 0.33;
  return { fontSize: Math.round(base * step) + 'px', lineHeight: '1.32' };
}
function coverHue(b: BookRow): string {
  let h = 0;
  for (let i = 0; i < b.title.length; i += 1) h = (h * 31 + b.title.charCodeAt(i)) % 360;
  return 'linear-gradient(150deg, hsl(' + h + ',28%,84%), hsl(' + ((h + 40) % 360) + ',26%,68%))';
}

// ---- 书架整理：搜索 / 排序 / 拖动 / 编辑 / 读完 / 再读 ----
function fmtRecent(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚读过';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚读过';
  if (min < 60) return min + ' 分钟前读过';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前读过';
  const day = Math.floor(hr / 24);
  if (day < 30) return day + ' 天前读过';
  return fmtDate(ts) + ' 读过';
}

function setSortMode(m: SortKey): void {
  sortMode.value = m;
  sortAsc.value = SORT_ASC[m];
  try { localStorage.setItem(SORT_KEY, m); } catch { /* 隐私模式下只在本轮生效 */ }
}
// 同一个列头再点一次就反向；换列头则回到这一列「有用」的那一头
function toggleSort(m: SortKey): void {
  if (sortMode.value === m) sortAsc.value = !sortAsc.value;
  else { sortMode.value = m; sortAsc.value = SORT_ASC[m]; }
  try { localStorage.setItem(SORT_KEY, sortMode.value); } catch { /* 只在本轮生效 */ }
}
function sortArrow(m: SortKey): string {
  if (sortMode.value !== m) return '';
  return sortAsc.value ? ' ↑' : ' ↓';
}
function ariaSort(m: SortKey): 'ascending' | 'descending' | 'none' {
  if (sortMode.value !== m) return 'none';
  return sortAsc.value ? 'ascending' : 'descending';
}

function onDragStart(ev: DragEvent, b: BookRow): void {
  if (!canDrag.value) { ev.preventDefault(); return; }
  dragId.value = b.id;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', b.id); } catch { /* 个别环境不给写，不影响拖动 */ }
  }
}
function onDragOverBook(ev: DragEvent, b: BookRow): void {
  if (!dragId.value || dragId.value === b.id) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  dragOverId.value = b.id;
}
async function onDropBook(ev: DragEvent, target: BookRow): Promise<void> {
  ev.preventDefault();
  const from = dragId.value;
  dragId.value = '';
  dragOverId.value = '';
  if (!canDrag.value || !from || from === target.id) return;
  const ids = shelfBooks.value.map((x) => x.id);
  const a = ids.indexOf(from);
  const b2 = ids.indexOf(target.id);
  if (a < 0 || b2 < 0) return;
  ids.splice(a, 1);
  ids.splice(b2, 0, from);
  await callDomain<unknown>('reading.reorder', null, ids);
  await reload();
  say('书架顺序已保存');
}
function onDragEnd(): void { dragId.value = ''; dragOverId.value = ''; }

// ---- V3.5 分组 / 收藏 ----
function setGroupFilter(g: string): void {
  groupFilter.value = g;
  // 手动点分组 = 主动离开虚拟书架；两条筛选不叠加
  shelfFilter.value = '';
  groupAdding.value = false;
  groupRenaming.value = false;
  groupDeleteConfirm.value = false;
  try { localStorage.setItem(GROUP_KEY, g); } catch { /* 隐私模式下只在本轮生效 */ }
}
// P2-1：当前生效的虚拟书架叫什么（找不到就说「已失效」，别假装还在筛）
const shelfLabel = computed(() => {
  const hit = (board.value?.shelves || []).filter((s) => s.key === shelfFilter.value)[0];
  return hit ? hit.label : '已失效';
});
function clearShelfFilter(): void { shelfFilter.value = ''; }
function groupLabel(): string {
  return groupFilter.value === GROUP_ALL ? '全部'
    : groupFilter.value === GROUP_FAV ? '收藏夹'
      : groupFilter.value === GROUP_NONE ? '未分组' : groupFilter.value;
}
// 左栏树 → 中栏：只切页签与分组 / 主题展开，不动数据、不写偏好。
// 不写 localStorage：左栏的选择是一次「看哪里」，不该盖掉用户上次手动挑的默认视图。
function applyScope(): void {
  const s = props.scope;
  if (!s) return;
  if (s.kind === 'notes') { tab.value = 'notes'; return; }
  // P2-1：虚拟书架也走「书架」页签，只是多一条 id 筛选；
  // 分组筛选同时清回「全部」，避免两条筛选叠成一个空列表。
  if (s.kind === 'shelf') {
    tab.value = 'shelf';
    shelfFilter.value = s.shelfKey || '';
    if (s.shelfKey) groupFilter.value = GROUP_ALL;
    return;
  }
  if (s.kind === 'theme') {
    tab.value = 'theme';
    if (s.themeId !== undefined) {
      themeSel.value = s.themeId;
      // 左栏点主题 = 现在就看这一摞：若它是收起状态，顺手展开，否则点了像没反应
      closedThemes.value = closedThemes.value.filter((x) => x !== s.themeId);
    }
    return;
  }
  tab.value = 'shelf';
  // 左栏点「休闲阅读 / 分组」= 退出虚拟书架筛选，回到按分组看
  shelfFilter.value = '';
  groupFilter.value = s.group || GROUP_ALL;
}
watch(() => props.scope, applyScope, { deep: true });
// 外部写入（另一个窗口 / 领域层直写）也要落到这一栏：只重取数据，不动当前视图与筛选
watch(() => props.dataTick, () => { void load(); });
async function toggleFavorite(b: BookRow): Promise<void> {
  await callDomain('reading.setBookFavorite', null, b.id, !b.favorite);
  await reload();
  say(b.favorite ? '《' + b.title + '》已移出收藏夹' : '《' + b.title + '》已收进收藏夹');
}
// 分组是从书派生的，空分组活不下来：新建时先把当前第一本放进去，用户马上看得到结果。
// 之后想归更多书，在每本的「编辑 → 所属分组」里改，不需要一个批量弹窗。
async function createGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  const first = shelfBooks.value[0] || books.value[0];
  if (!first) { say('书架还空着，先放一本书再建分组'); return; }
  await callDomain('reading.setBookGroup', null, first.id, name);
  newGroupName.value = '';
  groupAdding.value = false;
  setGroupFilter(name);
  await reload();
  say('已建「' + name + '」，先把《' + first.title + '》放了进去；在书的「编辑」里可继续归组');
}
async function renameGroupNow(): Promise<void> {
  const from = groupFilter.value;
  const to = groupRenameValue.value.trim();
  if (from === GROUP_ALL || from === GROUP_FAV || from === GROUP_NONE) return; // 保留值不是真分组
  if (!to || to === from) { groupRenaming.value = false; return; }
  await callDomain('reading.renameGroup', null, from, to);
  groupRenameValue.value = '';
  groupRenaming.value = false;
  setGroupFilter(to);
  await reload();
  say('分组已改名为「' + to + '」；若与已有分组同名则合并，书一本不少');
}
async function removeGroupNow(): Promise<void> {
  const name = groupFilter.value;
  if (name === GROUP_ALL || name === GROUP_FAV || name === GROUP_NONE) return; // 保留值不是真分组
  await callDomain('reading.removeGroup', null, name);
  groupDeleteConfirm.value = false;
  setGroupFilter(GROUP_ALL);
  await reload();
  say('已解散「' + name + '」：书都还在，只是去掉了分组标签');
}

// ---- V3.13 豆瓣封面：只在「编辑」弹窗里出现，点了才联网 ----
// 只发书名（必要时加作者），不带路径 / 笔记 / 日记字段。找到以后不自动套用——
// 同名书能有十几个版本，套错比没有封面更糟，所以让人点一张。
interface DoubanItem { title: string; author: string; year: string; picHost: string; picPath: string; thumb: string }
const doubanBusy = ref(false);
const doubanItems = ref<DoubanItem[]>([]);
const doubanMsg = ref('');
// 已经套用的那一张（-1 = 还没选）：套完不清空候选，标出来让人能接着换一张
const doubanPicked = ref(-1);

async function findDoubanCovers(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  doubanBusy.value = true;
  doubanItems.value = [];
  doubanPicked.value = -1;
  doubanMsg.value = '正在用书名去豆瓣搜…只会发书名和作者，不发路径与笔记';
  try {
    const r = await doubanCovers(b.id);
    if (!r || !r.ok) { doubanMsg.value = (r && r.reason) || '豆瓣没搜到'; return; }
    doubanItems.value = r.items || [];
    if (!doubanItems.value.length) {
      doubanMsg.value = '豆瓣没搜到这本书。可以换一下书名里的关键词，或自己选一张图';
    } else if (r.keyword && r.keyword !== b.title) {
      // 关键词是被截短过的，如实写出来：不然人会以为豆瓣里这本书就叫这个名
      doubanMsg.value = '整本书名搜不到，用「' + r.keyword + '」搜到 ' + doubanItems.value.length + ' 个候选，挑一张最像这本的';
    } else {
      doubanMsg.value = '挑一张最像这本的：豆瓣同名书很多，选错了可以再换';
    }
  } finally { doubanBusy.value = false; }
}

async function applyDoubanCover(it: DoubanItem, idx: number): Promise<void> {
  const b = editing.value;
  if (!b) return;
  doubanBusy.value = true;
  try {
    const r = await doubanApply(b.id, it.picHost, it.picPath);
    if (!r || !r.ok) { say((r && r.reason) || '封面没取到'); return; }
    const next = { ...coverMap.value };
    delete next[b.id];
    coverMap.value = next;
    // 只为这一本书作废掉抽取记忆：coverTried 是「这本 EPUB 抽过、没封面」的去重表，
    // 不清它的话 reload 后的 loadCovers 会直接跳过，刚换上的豆瓣封面永远加载不出来。
    coverTried.delete(b.id);
    doubanPicked.value = idx;
    doubanMsg.value = '已换上《' + it.title + '》的封面；不满意可以再点一张';
    await reload();
    await loadCovers();
    say('已换上豆瓣《' + it.title + '》的封面');
  } finally { doubanBusy.value = false; }
}

function openEdit(b: BookRow): void {
  editing.value = b;
  editTitle.value = b.title;
  editAuthor.value = b.author || '';
  editGroup.value = b.group || '';
  editGroupNew.value = false;
  // 每本书的豆瓣候选只属于这本书，换一本就清空
  doubanItems.value = [];
  doubanPicked.value = -1;
  doubanMsg.value = '';
  // 打开就能改：焦点进书名并全选，直接打字就是替换（书名多半只是改一两个字）
  void nextTick(() => {
    const el = editTitleEl.value;
    if (el) { el.focus(); el.select(); }
  });
}
async function saveEdit(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  const title = editTitle.value.trim();
  if (!title) { say('书名不能空着'); return; }
  // 只改书架上的显示，EPUB 文件本身一个字节都不动（与 mybook 的「编辑书籍信息」同口径）
  await callDomain<unknown>('reading.updateBook', null, b.id, { title, author: editAuthor.value.trim() });
  let msg = '书籍信息已保存，原文件没动';
  const g = editGroup.value.trim();
  if (g !== (b.group || '')) {
    const next = await callDomain<{ books?: BookRow[] } | null>('reading.setBookGroup', null, b.id, g);
    const row = next?.books?.find((x) => x.id === b.id);
    // 分组数到上限时领域层会拒绝新建（改名 / 清空不受限），这里如实说，别让用户以为存上了
    if (row && (row.group || '') !== g) msg = '书架分组最多 20 个，这个新分组没建起来（书名已保存）';
  }
  editing.value = null;
  await reload();
  say(msg);
}
async function pickCover(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  const r = await pickImageFile();
  if (!r || r.canceled || !r.paths || !r.paths.length) return;
  editCoverBusy.value = true;
  try {
    const res = await callDomain<{ ok: boolean; reason?: string } | null>('reading.setCover', null, b.id, r.paths[0]);
    if (!res || !res.ok) { say((res && res.reason) || '封面没换成功'); return; }
    // 缓存里那一本要先清掉，否则预览还是旧封面
    const next = { ...coverMap.value };
    delete next[b.id];
    coverMap.value = next;
    await reload();
    await loadCovers();
    say('封面已更换');
  } finally { editCoverBusy.value = false; }
}
async function resetCover(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  await callDomain<unknown>('reading.setCover', null, b.id, '');
  const next = { ...coverMap.value };
  delete next[b.id];
  coverMap.value = next;
  await reload();
  await loadCovers();
  say('已恢复默认封面');
}
async function markDone(b: BookRow): Promise<void> {
  await callDomain<unknown>('reading.setBookStatus', null, b.id, 'done', props.today);
  await reload();
  say('《' + b.title + '》已标记读完');
}
// 再读一遍：只重置进度，书签与标注一条不动——和「移出书架」是两件事
async function reread(b: BookRow): Promise<void> {
  await callDomain<unknown>('reading.reread', null, b.id, Date.now());
  await reload();
  say('《' + b.title + '》从头开始，书签与标注都还在');
}
// 导出只有一个落盘口：全库汇总与「按书导出」共用这一处 saveExport。
// 数据中心唯一入口的门禁按调用次数算，两个按钮各写一次就会变成「第二入口」——
// 合并后既满足口径，也保证两条导出永远走同一条通道（V1.3 / V2.3 先例）。
async function saveNotesFile(name: string, bookId: string): Promise<void> {
  const text = await callDomain<string>('reading.exportMd', '', bookId);
  const receipt = await saveExport(name, text);
  say(receipt && receipt.path ? '已导出：' + receipt.path : '已取消导出');
}
// 按书导出：只导这一本的笔记（全库汇总走「读书笔记」页那枚按钮）
async function exportBook(b: BookRow): Promise<void> {
  await saveNotesFile('读书笔记-' + b.title + '.md', b.id);
}
// 弹窗里这三枚按钮都作用在 editing 上，模板里 editing 是可空引用，
// 统一在这一层收口：既满足严格 TS，也顺手在动作后关掉弹窗（骨架已过期）
async function doneFromEdit(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  editing.value = null;
  await markDone(b);
}
async function rereadFromEdit(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  editing.value = null;
  await reread(b);
}
async function exportFromEdit(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  editing.value = null;
  await exportBook(b);
}
async function revealFromEdit(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  await revealFile(b);
}

function onDragEnter(ev: DragEvent): void { ev.preventDefault(); dragOver.value = true; }
function onDragLeave(ev: DragEvent): void {
  ev.preventDefault();
  const el = ev.currentTarget as HTMLElement | null;
  const to = ev.relatedTarget as Node | null;
  if (el && to && el.contains(to)) return;
  dragOver.value = false;
}
async function onDrop(ev: DragEvent): Promise<void> {
  ev.preventDefault();
  dragOver.value = false;
  const files = Array.from(ev.dataTransfer?.files || []);
  const paths = files.map((f) => pathForFile(f)).filter(Boolean);
  if (!paths.length) { say('没读到文件；请从资源管理器拖文件，或点「选择电子书」'); return; }
  await addPaths(paths);
}
async function pickFiles(): Promise<void> {
  const r = await pickBookFiles();
  if (r && !r.canceled) await addPaths(r.paths || []);
}
async function addPaths(paths: string[], themeId = ''): Promise<void> {
  if (!paths.length) return;
  importing.value = true;
  try {
    // 第二参 themeId：非空即把书归到该主题下（V2.14）
    const r = await callDomain<{ added: number; skipped: number; errors: string[] } | null>('reading.addFiles', null, paths, themeId);
    await reload();
    await loadCovers();
    const err = r?.errors?.[0];
    say((themeId ? '已放入主题 ' : '已放入 ') + (r?.added || 0) + ' 本'
      + (r?.skipped ? '，跳过重复 ' + r.skipped + ' 本' : '') + (r?.added ? '' : (err ? '：' + err : '')));
  } finally { importing.value = false; }
}
async function openInReader(b: BookRow, mode: 'leisure' | 'theme' = 'leisure'): Promise<void> {
  // 独立阅读窗口（目录 / 正文 / 笔记三栏）；书架留在主窗口，两窗口可并排
  const r = await openReader(b.id, mode);
  if (!r.ok) say(r.reason || '这本书打不开');
  else if (r.reused) say('这本书的阅读窗口已经开着');
}
// 主题书：有本机文件 → 独立阅读窗（与休闲阅读功能完全一致）；无文件 → 中栏批注
function revealReader(mode: 'leisure' | 'theme'): void {
  // 书单是表、批注器长在表下面：点完顺手把它带进视野，别让人以为「点了没反应」。
  // 只滚到「刚好露出来」（block:'nearest'），不把整页跳走。
  void nextTick(function () {
    const label = mode === 'leisure' ? '休闲阅读器' : '主题阅读器';
    const el = document.querySelector('.rd-reader[aria-label="' + label + '"]');
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  });
}
function startThemeBook(b: BookRow): void {
  themeSel.value = b.themeId || themeSel.value;
  if (b.filePath) { void openInReader(b, 'theme'); return; }
  openBook('theme', b);
  say('这本是手工登记，没有本机电子书；已选中，可在右栏记笔记');
  revealReader('theme');
}
function startBook(b: BookRow): void {
  // 有本机文件 → 独立阅读窗口；手工登记的书没有正文可读，仍用中栏批注面板
  if (b.filePath) { void openInReader(b); return; }
  openBook('leisure', b);
  say('这本是手工登记，没有本机电子书；可直接在中栏记笔记');
  revealReader('leisure');
}
async function revealFile(b: BookRow): Promise<void> {
  await callDomain<unknown>('reading.revealBook', null, b.id);
}

// ---- P0-2：重新关联 ----
// 文件被改名 / 搬到别的盘之后，路径断了。旧版本只能「移出 → 重新添加」，
// 那会造出一个新 bookId，笔记 / 章节 / 书签 / 按书筛选全静默失联。
// 这里保持 id 不变，只把路径换掉；是不是同一本由主进程按指纹判定。
async function relinkBook(b: BookRow): Promise<void> {
  if (relinking.value) return;
  relinking.value = b.id;
  try {
    const picked = await pickBookFiles();
    if (!picked || picked.canceled || !picked.paths.length) return;
    const r = await callDomain<{ ok: boolean; reason?: string; changedSize?: boolean } | null>(
      'reading.relinkBook', null, b.id, picked.paths[0]);
    if (!r || !r.ok) { say((r && r.reason) || '重新关联失败'); return; }
    await reload();
    say('已重新关联到新位置，书的 id 没变——' + (b.noteCount || 0) + ' 条笔记、章节与书签都还在');
  } finally {
    relinking.value = '';
  }
}

// ---- P0-4：书库体检 ----
// 报告先摆出来，人看过再决定修不修。修复只清「指向不存在的东西」的那一个字段，
// 不删书、不删笔记；撤销靠 changes 回放，不靠第二份快照。
async function openAudit(): Promise<void> {
  auditOpen.value = true;
  auditBusy.value = true;
  try {
    auditReport.value = await callDomain<AuditReport | null>('reading.audit', null);
  } finally {
    auditBusy.value = false;
  }
}
async function repairDangling(): Promise<void> {
  const r = await callDomain<{ fixed: number; changes: RepairChange[] } | null>('reading.repairDangling', null);
  repairUndo.value = (r && r.changes) || [];
  await openAudit();
  await reload();
  say(!r || !r.fixed ? '没有需要修的断链' : '已清掉 ' + r.fixed + ' 处断链，可撤销');
}
async function undoRepair(): Promise<void> {
  if (!repairUndo.value.length) return;
  await callDomain<{ restored: number } | null>('reading.restoreDangling', null, repairUndo.value);
  const n = repairUndo.value.length;
  repairUndo.value = [];
  await openAudit();
  await reload();
  say('已撤销上次修复（' + n + ' 处引用已还原）');
}

function say(text: string): void { emit('notify', text); }

// ---- 休闲娱乐阅读：书只从本机电子书来（V3.14 起不再手写书名） ----
async function advanceLeisure(id: string, delta: number): Promise<void> {
  await callDomain<unknown>('reading.advanceBook', null, id, delta, props.today);
  await reload();
}

async function removeBook(id: string): Promise<void> {
  await callDomain<unknown>('reading.removeBook', null, id);
  if (active.value?.bookId === id) active.value = null;
  await reload();
  say('书已移出书架；它留下的笔记仍在「读书笔记」里');
}

// ---- 主题阅读：自建书单（V2.14）----
async function advanceTheme(themeId: string, bookId: string, delta: number): Promise<void> {
  // 主题书已在 md_reading.books，走 advanceBook（themeId 仅作兼容占位）
  await callDomain<unknown>('reading.themeAdvance', null, themeId, bookId, delta, props.today);
  await reload();
}
async function addNewTheme(): Promise<void> {
  const title = newThemeTitle.value.trim();
  if (!title) { say('先写主题名'); return; }
  const r = await callDomain<{ id?: string } | null>('reading.themeAdd', null, { title, note: newThemeNote.value.trim() });
  newThemeTitle.value = ''; newThemeNote.value = '';
  await reload();
  if (r?.id) themeSel.value = r.id;
  say('主题已建好，现在可以往里放书了');
}
async function removeTheme(id: string, title: string): Promise<void> {
  if (!window.confirm('删除主题「' + title + '」？主题下的书会移回休闲书架，笔记保留。')) return;
  await callDomain<unknown>('reading.themeRemove', null, id);
  if (themeSel.value === id) themeSel.value = '';
  active.value = null;
  await reload();
  say('主题已删除，书已移回休闲书架');
}
async function addThemeBook(themeId: string): Promise<void> {
  const title = newThemeBook.value.trim();
  if (!title) { say('先写书名'); return; }
  await callDomain<unknown>('reading.addBook', null, { title, themeId, total: 300, unit: '页' });
  newThemeBook.value = '';
  await reload();
  say('书已放进主题，可在右栏记笔记；有电子书文件也可以拖进来读正文');
}
async function pickThemeFiles(themeId: string): Promise<void> {
  const r = await pickBookFiles();
  if (r && !r.canceled) await addPaths(r.paths || [], themeId);
}
async function onThemeDrop(ev: DragEvent, themeId: string): Promise<void> {
  ev.preventDefault();
  const files = Array.from(ev.dataTransfer?.files || []);
  const paths = files.map((f) => pathForFile(f)).filter(Boolean);
  if (!paths.length) { say('没读到文件；请从资源管理器拖文件，或点「选择电子书」'); return; }
  await addPaths(paths, themeId);
}
async function importThemes(): Promise<void> {
  const r = await callDomain<{ addedThemes: number; addedBooks: number; addedNotes: number; changed: boolean } | null>('reading.importGrowthThemes', null);
  await reload();
  say(r?.changed
    ? '已迁移旧主题 ' + (r.addedThemes || 0) + ' 个、书 ' + (r.addedBooks || 0) + ' 本、摘录 ' + (r.addedNotes || 0) + ' 条（旧数据保留）'
    : '没有需要迁移的旧主题书单');
}

function openBook(mode: 'leisure' | 'theme', row: BookRow): void {
  // P0-1：旧 ThemeBook 形状已从数据契约里删掉，主题书与休闲书都是 BookRow，主键都是 id
  active.value = {
    mode,
    bookId: row.id,
    themeId: mode === 'theme' ? (row.themeId || '') : '',
    title: row.title,
    total: row.total,
    done: row.done
  };
  noteQuote.value = ''; noteText.value = ''; notePage.value = '';
  activePrompt.value = '';
  tab.value = mode === 'leisure' ? 'shelf' : 'theme';
}

async function addChapter(): Promise<void> {
  if (!active.value || active.value.mode !== 'leisure') return;
  const title = newChapter.value.trim();
  if (!title) return;
  // P2-3：锚点与阅读窗同一口径 ch-<节序>；没填就留空（纯大纲，不假装知道位置）
  const seq = Number(newChapterSeq.value.trim());
  const anchor = Number.isFinite(seq) && seq > 0 ? 'ch-' + Math.trunc(seq) : '';
  await callDomain<unknown>('reading.addChapter', null, active.value.bookId, { title, anchor });
  newChapter.value = '';
  newChapterSeq.value = '';
  await reload();
}

// 'ch-7' → 7；没有锚点或格式不合规 → 0
function chapterSeqOf(anchor: string): number {
  const m = /^ch-(\d{1,4})$/.exec(String(anchor || ''));
  return m ? Number(m[1]) : 0;
}
// 章节行的「第几节」可改可清：清空 = 退回纯大纲。
// 用 change 而不是 input 触发：输入过程中的中间值不该一次次落库。
async function setChapterAnchor(c: ChapterRow, ev: Event): Promise<void> {
  const el = ev.target as HTMLInputElement;
  const n = Number((el.value || '').trim());
  const anchor = Number.isFinite(n) && n > 0 ? 'ch-' + Math.trunc(n) : '';
  if ((c.anchor || '') === anchor) return;
  await callDomain<unknown>('reading.updateChapter', null, c.id, { anchor });
  await reload();
  say(anchor ? '「' + c.title + '」已锚到第 ' + chapterSeqOf(anchor) + ' 节，阅读窗左栏「我的大纲」里能一跳到位' : '「' + c.title + '」不再锚定书内位置');
}

async function removeChapter(id: string): Promise<void> {
  await callDomain<unknown>('reading.removeChapter', null, id);
  await reload();
}

// ---- 阅读器：批注贴着原文长 ----
function pickPrompt(p: { id: string; label: string; hint: string; type: string }): void {
  activePrompt.value = p.id;
  noteType.value = p.type;
  if (!noteText.value) noteText.value = p.label + '：';
}

async function saveNote(): Promise<void> {
  if (!active.value) return;
  const quote = noteQuote.value.trim();
  const text = noteText.value.trim();
  if (!quote && !text) { say('摘录和想法至少写一样'); return; }
  const a = active.value;
  await callDomain<unknown>('reading.addNote', null, {
    mode: a.mode, bookId: a.bookId, themeId: a.themeId, bookTitle: a.title,
    type: noteType.value, quote, text,
    page: Number(notePage.value) || 0, tags: noteTags.value.split(/[\s,，]+/).filter(Boolean),
    chapterId: ''
  });
  noteQuote.value = ''; noteText.value = ''; notePage.value = ''; noteTags.value = '';
  activePrompt.value = '';
  await reload();
  say('已进「读书笔记」数据库');
}

// ---- 九格回写：只追加、带出处、防重复 ----
async function appendLine(cell: string, line: string): Promise<string> {
  const target = safeCell(cell);
  // 不拿 props.record 直接写：它是打开图书馆那一刻的快照，可能已被补记 / 刷新换过。
  // 现场读当天最新一篇，追加后 await 真正落盘，避免两次写基于不同快照互相覆盖。
  let base: DiaryRecord;
  try {
    const res = await listDiaries({ pageSize: 500 });
    const hit = res.items.find((r) => r.date === props.today);
    base = hit
      ? (JSON.parse(JSON.stringify(hit)) as DiaryRecord)
      : (JSON.parse(JSON.stringify(props.record)) as DiaryRecord);
  } catch {
    base = JSON.parse(JSON.stringify(props.record)) as DiaryRecord;
  }
  base.date = props.today;
  const old = base.cells[target] || '';
  // R-21（2026-11-12）：行级去重。原先「追加九格」与「markPushed」是两次独立 IPC，
  // 第二步失败后重试会把同一行再追加一遍，污染当天的日记。
  // 这里在写入前按行比对：该行已存在就只当成功返回，交给调用方继续 markPushed。
  // 这样整条链路可以安全重试，且不需要把两个动作合成一次事务。
  if (old.split('\n').some((l) => l.trim() === line.trim())) {
    emit('changed');
    return target;
  }
  // 唯一的写入形态：追加。绝不覆盖（那会抹掉用户今天写过的话）
  base.cells[target] = old ? old + '\n' + line : line;  await upsertDiary(base, 'reading-' + target + '-' + Date.now());
  emit('changed');
  return target;
}

const CELL_LABEL: Record<string, string> = {
  free: '自由记录', growth: '学习成长', work: '工作推进', dream: '休闲娱乐', leisure: '休闲娱乐'
};
// 冻结的 diary-store.js 第 7 格仍是 dream，渲染层 11-08 改成了 leisure；
// 写进 leisure 会被 save() 静默丢掉（本轮真 GUI 抓到）。不改九格核心契约，
// 统一落到 utils 认得的 free，回写行自带「【读书·休闲娱乐】」标明来源。见 docs/13 §11。
function safeCell(cell: string): string {
  return cell === 'leisure' ? 'free' : cell;
}
function cellFor(n: NoteRow): string {
  return n.mode === 'theme' ? 'growth' : 'free';
}

async function pushNote(n: NoteRow): Promise<void> {
  if (n.pushedAt) return;
  if (props.backfill) { say('正在补记过去，笔记只写真实今天；先回今天再写入'); return; }
  const line = await callDomain<string>('reading.diaryLine', '', n);
  if (!line) return;
  const cell = await appendLine(cellFor(n), line);
  await callDomain<unknown>('reading.markPushed', null, n.id, cell, Date.now());
  await reload();
  say('已追加到九格「' + (CELL_LABEL[cell] || cell) + '」，原文没动');
}

async function saveFlash(): Promise<void> {
  const text = flash.value.trim();
  if (!text) return;
  if (props.backfill) { say('正在补记过去，闪念只写真实今天；先回今天再写入'); return; }
  const a = active.value;
  const mode = a ? a.mode : 'leisure';
  const patch = {
    mode, bookId: a ? a.bookId : '', themeId: a ? a.themeId : '',
    bookTitle: a ? a.title : '随手一想', type: 'idea', quote: '', text,
    page: 0, tags: ['闪念'], chapterId: ''
  };
  await callDomain<unknown>('reading.addNote', null, patch);
  // 先落库拿到真实 id，再生成回写行：行尾的〔rd:id〕必须指向真笔记，
  // 否则「从日记点回原句」这条反查就断在第一步（P0-3）。
  const q = await callDomain<NotesResult | null>('reading.notes', null, { keyword: text });
  const hit = q?.items?.find((n) => n.text === text && !n.pushedAt);
  const line = await callDomain<string>('reading.diaryLine', '', hit || Object.assign({}, patch, { tags: ['闪念'] }));
  const cell = await appendLine(flashCell.value, line || text);
  flash.value = '';
  if (hit) await callDomain<unknown>('reading.markPushed', null, hit.id, cell, Date.now());
  await reload();
  say('闪念已进读书笔记，并写进九格「' + (CELL_LABEL[cell] || cell) + '」');
}

async function removeNote(id: string): Promise<void> {
  await callDomain<unknown>('reading.removeNote', null, id);
  await reload();
}

// P1-3：阅读里的「行动」要能落地。
// 打了 #行动 的笔记原先只在学习右栏显示一下，没有任务、没有提醒、没有下落；
// 这里照「闪念 → 收件箱」那条既有幂等链路（fl: 前缀）换成 rd: 前缀，
// 重复点不叠加，删笔记时主进程连带清掉未完成的那条。
async function pushActionNote(n: NoteRow): Promise<void> {
  const r = await callDomain<{ ok: boolean; duplicated?: boolean; reason?: string } | null>(
    'reading.pushAction', null, n.id);
  if (!r || !r.ok) { say((r && r.reason) || '没能生成任务'); return; }
  say(r.duplicated ? '这条已经生成过任务了（不会重复加）' : '已放进「工作推进」的收件箱，等厘清');
}
function isActionNote(n: NoteRow): boolean {
  return (n.tags || []).indexOf('行动') >= 0;
}

async function importQuotes(): Promise<void> {
  const r = await callDomain<{ added: number } | null>('reading.importGrowthQuotes', null);
  await reload();
  say(r?.added ? '已汇总学习成长里的旧摘录 ' + r.added + ' 条' : '没有需要补进来的旧摘录');
}

async function exportNotes(): Promise<void> {
  await saveNotesFile('读书笔记-' + props.today + '.md', '');
}

async function applyFilter(): Promise<void> { await loadNotes(); }
function pickTag(t: string): void { fTag.value = fTag.value === t ? '' : t; void loadNotes(); }

// Esc 关弹窗：挂在 window 上而不是弹窗节点上。
// 弹窗打开时焦点可能还在背后的书架按钮上（没点进输入框），这时 keydown 的
// 目标是 body，事件不会经过弹窗节点，节点上的 @keydown.esc 收不到。
function onEscClose(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return;
  // 先关最上面那层：编辑弹窗盖在体检报告之上，Esc 不该一次把两层都收掉
  if (editing.value) {
    ev.preventDefault();
    ev.stopPropagation();
    editing.value = null;
    return;
  }
  if (auditOpen.value) auditOpen.value = false;
}

onMounted(() => {
  window.addEventListener('keydown', onEscClose);
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'grid' || saved === 'list' || saved === 'shelf') viewMode.value = saved;
    const sort = localStorage.getItem(SORT_KEY) as SortKey | null;
    if (sort && Object.prototype.hasOwnProperty.call(SORT_ASC, sort)) {
      sortMode.value = sort;
      sortAsc.value = SORT_ASC[sort];
    }
    const grp = localStorage.getItem(GROUP_KEY);
    if (grp) groupFilter.value = grp;
  } catch { /* 读不出偏好就用详细列表 + 手动排序 + 全部分组 */ }
  // 打开时就带着左栏的选择（例如窗口是从「主题 X」开出来的），先落地再取数
  applyScope();
  void load();
});
onBeforeUnmount(() => { window.removeEventListener('keydown', onEscClose); });
</script>

<template>
  <section class="rd-view" aria-label="图书馆">
    <header v-if="!embedded" class="rd-head">
      <button class="rd-back" @click="emit('back')">← 返回九格</button>
      <h1 class="rd-title">图书馆</h1>
      <p class="rd-sub">两类阅读 · 笔记贴着原文长 · 汇总进「读书笔记」</p>
      <div class="rd-stats" aria-label="读书笔记统计">
        <span class="rd-stat"><b>{{ stats.books }}</b> 本休闲书</span>
        <span class="rd-stat"><b>{{ stats.themeBooks || 0 }}</b> 本主题书</span>
        <span class="rd-stat"><b>{{ stats.notes }}</b> 条笔记</span>
        <span class="rd-stat"><b>{{ stats.pushed }}</b> 条已入九格</span>
        <span class="rd-stat"><b>{{ stats.thisMonth }}</b> 条本月</span>
      </div>
    </header>
    <header v-else class="rd-head rd-head-lite">
      <button class="rd-back" @click="emit('back')">← 关闭窗口</button>
      <p class="rd-sub">两类阅读 · 笔记贴着原文长 · 汇总进「读书笔记」</p>
    </header>

    <!-- 页签行（V3.14）：搜索收到这一行的最左边。
         原先搜索单占一行，既是白扔一屏高度，也让人误以为它只筛休闲书架——
         它筛的其实就是「书架」这一栏，跟页签并排才看得明白。
         排序与计数同理，只在休闲书架这一栏出现，切到主题 / 笔记时收起。 -->
    <nav class="rd-tabs" aria-label="图书馆分区">
      <input
        v-if="tab === 'shelf'" v-model="shelfKw" class="rd-input rd-search"
        placeholder="在书架里找：书名 / 作者 / 格式 / 备注" aria-label="书架搜索"
      />
      <button class="rd-tab" :class="{ 'rd-tab-on': tab === 'shelf' }" :aria-pressed="tab === 'shelf'" @click="tab = 'shelf'">休闲娱乐阅读</button>
      <button class="rd-tab" :class="{ 'rd-tab-on': tab === 'theme' }" :aria-pressed="tab === 'theme'" @click="tab = 'theme'">主题阅读</button>
      <button class="rd-tab" :class="{ 'rd-tab-on': tab === 'notes' }" :aria-pressed="tab === 'notes'" @click="tab = 'notes'">读书笔记 · 数据库</button>
      <template v-if="tab === 'shelf'">
        <span class="rd-spacer"></span>
        <span class="rd-sort" role="group" aria-label="书架排序方式">
          <button class="rd-mini" :class="{ 'rd-mode-on': sortMode === 'manual' }" :aria-pressed="sortMode === 'manual'" @click="setSortMode('manual')">手动排序</button>
          <button class="rd-mini" :class="{ 'rd-mode-on': sortMode === 'recent' }" :aria-pressed="sortMode === 'recent'" @click="setSortMode('recent')">最近在读</button>
        </span>
        <span class="rd-hint">
          {{ shelfBooks.length }} / {{ books.length }} 本<template v-if="canDrag && !embedded"> · 拖书行可调整顺序</template><template v-else-if="sortMode === 'recent' && !embedded"> · 按翻开时间倒序</template>
        </span>
      </template>
      <!-- P0-4：书库体检放在页签行常驻，任何一栏都能点（断链不只发生在书架上） -->
      <button class="rd-mini rd-audit-btn" :aria-pressed="auditOpen" title="查断链 / 指纹重复 / 同名异路径 / 找不到的文件" @click="openAudit">书库体检</button>
    </nav>

    <!-- 体检报告：先摆事实，再决定动不动数据。修复可撤销，撤销凭据只在本次会话内。 -->
    <section v-if="auditOpen" class="rd-audit" aria-label="书库体检">
      <header class="rd-audit-head">
        <h2 class="rd-h3">书库体检</h2>
        <span class="rd-hint">只报告，不自动改数据</span>
        <span class="rd-spacer"></span>
        <button class="rd-mini" :disabled="auditBusy" @click="openAudit">{{ auditBusy ? '正在查…' : '重新查' }}</button>
        <button class="rd-mini" :disabled="auditBusy || !(auditReport && (auditReport.counts.danglingNotes || auditReport.counts.danglingBooks))" title="只清掉指向不存在的那个字段，不删书也不删笔记" @click="repairDangling">修复断链</button>
        <button v-if="repairUndo.length" class="rd-mini" @click="undoRepair">撤销上次修复（{{ repairUndo.length }}）</button>
        <button class="rd-mini rd-mini-quiet" @click="auditOpen = false">收起</button>
      </header>
      <p v-if="auditBusy && !auditReport" class="rd-hint">正在核对五张表…</p>
      <template v-else-if="auditReport">
        <div class="rd-audit-grid">
          <div class="rd-audit-kpi"><span>断链笔记</span><b>{{ auditReport.counts.danglingNotes }}</b></div>
          <div class="rd-audit-kpi"><span>断链章节 / 书签</span><b>{{ auditReport.counts.danglingChapters + auditReport.counts.danglingBookmarks }}</b></div>
          <div class="rd-audit-kpi"><span>找不到的文件</span><b>{{ auditReport.counts.missingFiles }}</b></div>
          <div class="rd-audit-kpi"><span>指纹重复</span><b>{{ auditReport.counts.dupFingerprints }}</b></div>
          <div class="rd-audit-kpi"><span>同名异路径</span><b>{{ auditReport.counts.dupTitles }}</b></div>
          <div class="rd-audit-kpi"><span>还没有指纹</span><b>{{ auditReport.counts.booksNoFingerprint }}</b></div>
        </div>
        <p v-if="!auditReport.counts.danglingNotes && !auditReport.counts.danglingBooks && !auditReport.counts.danglingChapters && !auditReport.counts.danglingBookmarks && !auditReport.counts.missingFiles && !auditReport.counts.dupFingerprints && !auditReport.counts.dupTitles" class="rd-hint">
          五项全清：没有断链、没有重复、没有找不到的文件。
        </p>
        <div v-if="auditReport.dangling.notes.length" class="rd-audit-list">
          <h3 class="rd-h3">断链笔记（{{ auditReport.counts.danglingNotes }}）</h3>
          <p v-for="n in auditReport.dangling.notes.slice(0, 6)" :key="n.id" class="rd-note-line">
            《{{ n.bookTitle || '未记书名' }}》<span class="rd-hint">{{ n.bookId || n.themeId }}</span>
          </p>
        </div>
        <div v-if="auditReport.missingFiles.length" class="rd-audit-list">
          <h3 class="rd-h3">找不到的文件（{{ auditReport.counts.missingFiles }}）</h3>
          <p v-for="m in auditReport.missingFiles.slice(0, 5)" :key="m.id" class="rd-note-line">
            《{{ m.title }}》<span class="rd-hint">{{ m.filePath }}</span>
          </p>
          <p class="rd-hint">书架上那几本带「原件不在」标记的，用行尾的「重新关联」指到新位置即可，笔记不会丢。</p>
        </div>
        <div v-if="auditReport.dupFingerprints.length" class="rd-audit-list">
          <h3 class="rd-h3">指纹重复（{{ auditReport.counts.dupFingerprints }}）</h3>
          <p v-for="d in auditReport.dupFingerprints.slice(0, 3)" :key="d.fingerprint" class="rd-note-line">
            {{ d.books.map((b) => '《' + b.title + '》').join(' / ') }}<span class="rd-hint">同一份文件被登记了两次</span>
          </p>
        </div>
        <div v-if="auditReport.dupTitles.length" class="rd-audit-list">
          <h3 class="rd-h3">同名异路径（{{ auditReport.counts.dupTitles }}）</h3>
          <p v-for="d in auditReport.dupTitles.slice(0, 3)" :key="d.title" class="rd-note-line">
            《{{ d.title }}》<span class="rd-hint">{{ d.books.length }} 条记录</span>
          </p>
        </div>
      </template>
    </section>

    <!-- ============ 休闲娱乐阅读 ============ -->
    <div v-if="tab === 'shelf'" class="rd-pane">
      <div class="rd-files">
        <div
          class="rd-drop"
          :class="{ 'rd-drop-on': dragOver }"
          aria-label="拖放本地电子书到此处"
          @dragenter="onDragEnter"
          @dragover.prevent="dragOver = true"
          @dragleave="onDragLeave"
          @drop="onDrop"
        >
          <span class="rd-drop-icon" aria-hidden="true">⇩</span>
          <span>把本电脑的电子书拖到这里</span>
          <span class="rd-hint">支持 EPUB / PDF / TXT / MD / MOBI / AZW3 · 只登记路径，不复制内容</span>
        </div>
        <div class="rd-file-actions">
          <button class="rd-primary" :disabled="importing" @click="pickFiles">{{ importing ? '正在放入…' : '＋ 选择电子书' }}</button>
          <span class="rd-viewmode" role="group" aria-label="书目陈列方式">
            <button class="rd-mini" :class="{ 'rd-mode-on': viewMode === 'list' }" :aria-pressed="viewMode === 'list'" @click="setViewMode('list')">详细列表</button>
            <button class="rd-mini" :class="{ 'rd-mode-on': viewMode === 'grid' }" :aria-pressed="viewMode === 'grid'" @click="setViewMode('grid')">封面预览</button>
            <button class="rd-mini" :class="{ 'rd-mode-on': viewMode === 'shelf' }" :aria-pressed="viewMode === 'shelf'" title="只摆封面，像看自家书架" @click="setViewMode('shelf')">封面墙</button>
          </span>
        </div>
      </div>

      <!-- 手写书名的入口在 V3.14 下线：图书馆只认「本电脑里的电子书」这一条来路。
           手写一条只有书名、没有文件、没有格式的书，只会变成书架上认不出来的占位行；
           真要记一本没电子书的读书笔记，走「主题阅读」——那里手写书名是合理的（资料本来就是散的）。 -->

      <!-- V3.5 分组 / 收藏夹：只是筛选视图，不是另一份书单；分组名就写在书自己身上 -->
      <div class="rd-groups" aria-label="书架分组">
        <!-- P2-1：虚拟书架筛选生效时先说清楚「现在只显示这一摞」，
             否则用户会以为书丢了。取消按钮回到全部。 -->
        <span v-if="shelfFilter" class="rd-gchip rd-gchip-on rd-shelfchip" :aria-pressed="true">
          虚拟书架 · {{ shelfLabel }}
          <button class="rd-shelfchip-x" aria-label="取消虚拟书架筛选" @click="clearShelfFilter">×</button>
        </span>
        <button class="rd-gchip" :class="{ 'rd-gchip-on': groupFilter === GROUP_ALL }" :aria-pressed="groupFilter === GROUP_ALL" @click="setGroupFilter(GROUP_ALL)">全部 {{ books.length }}</button>
        <button class="rd-gchip" :class="{ 'rd-gchip-on': groupFilter === GROUP_FAV }" :aria-pressed="groupFilter === GROUP_FAV" @click="setGroupFilter(GROUP_FAV)">★ 收藏夹 {{ favoriteCount }}</button>
        <button v-if="ungroupedCount" class="rd-gchip" :class="{ 'rd-gchip-on': groupFilter === GROUP_NONE }" :aria-pressed="groupFilter === GROUP_NONE" title="没有归到任何分组的书（左栏同一项）" @click="setGroupFilter(GROUP_NONE)">未分组 {{ ungroupedCount }}</button>
        <button v-for="g in groups" :key="g.name" class="rd-gchip" :class="{ 'rd-gchip-on': groupFilter === g.name }" :aria-pressed="groupFilter === g.name" @click="setGroupFilter(g.name)">
          {{ g.name }}<span class="rd-gcount">{{ g.count }}</span>
        </button>
        <template v-if="groupAdding">
          <input v-model="newGroupName" class="rd-input rd-gnew" placeholder="新分组名" aria-label="新分组名" @keyup.enter="createGroup" />
          <button class="rd-mini" @click="createGroup">建分组</button>
          <button class="rd-mini rd-mini-quiet" @click="groupAdding = false; newGroupName = ''">取消</button>
        </template>
        <button v-else class="rd-mini rd-mini-quiet" title="新分组会先放入当前第一本书，之后在书的「编辑」里继续归组" @click="groupAdding = true">＋ 新分组</button>
        <span class="rd-spacer"></span>
        <template v-if="groupFilter !== GROUP_ALL && groupFilter !== GROUP_FAV && groupFilter !== GROUP_NONE">
          <template v-if="groupRenaming">
            <input v-model="groupRenameValue" class="rd-input rd-gnew" aria-label="分组改名" @keyup.enter="renameGroupNow" />
            <button class="rd-mini" @click="renameGroupNow">改名</button>
            <button class="rd-mini rd-mini-quiet" @click="groupRenaming = false">取消</button>
          </template>
          <template v-else-if="!groupDeleteConfirm">
            <button class="rd-mini rd-mini-quiet" @click="groupRenameValue = groupFilter; groupRenaming = true">重命名「{{ groupLabel() }}」</button>
            <button class="rd-mini rd-mini-quiet" @click="groupDeleteConfirm = true">解散分组</button>
          </template>
          <template v-else>
            <span class="rd-hint">书都保留，只去掉标签</span>
            <button class="rd-mini" @click="removeGroupNow">确认解散</button>
            <button class="rd-mini rd-mini-quiet" @click="groupDeleteConfirm = false">取消</button>
          </template>
        </template>
      </div>

      <div v-if="!books.length" class="rd-empty">书架还空着。把本电脑的电子书拖进来，或点上面的「＋ 选择电子书」；书是从文件来的，不再手写书名。</div>
      <div v-else-if="!shelfBooks.length" class="rd-empty">没有符合条件的书。换个词、换个分组，或清空筛选。</div>
      <!-- 详细列表（V3.13 起对标 calibre）：一列一项、列头可点排序、行高紧凑。
           理由：书架里几十本书时，卡片式的每行一条进度条会把「哪本多厚、哪天翻过」淹掉；
           calibre 那种表格式排布让人一眼横向比较，也不需要逐行读句子。 -->
      <div v-if="viewMode === 'list'" class="rd-table rd-shelf" aria-label="详细列表">
        <div class="rd-thead" role="row">
          <span class="rd-th rd-th-grip" aria-hidden="true"></span>
          <span class="rd-th rd-th-title" role="columnheader" :aria-sort="ariaSort('title')" @click="toggleSort('title')">书名{{ sortArrow('title') }}</span>
          <span class="rd-th rd-th-author" role="columnheader" :aria-sort="ariaSort('author')" @click="toggleSort('author')">作者{{ sortArrow('author') }}</span>
          <span class="rd-th rd-th-size" role="columnheader" :aria-sort="ariaSort('size')" @click="toggleSort('size')">格式 · 大小{{ sortArrow('size') }}</span>
          <span class="rd-th rd-th-date" role="columnheader" :aria-sort="ariaSort('date')" @click="toggleSort('date')">最近读过{{ sortArrow('date') }}</span>
          <span class="rd-th rd-th-pct" role="columnheader" :aria-sort="ariaSort('pct')" @click="toggleSort('pct')">进度{{ sortArrow('pct') }}</span>
          <span class="rd-th rd-th-act">操作</span>
        </div>
        <article
          v-for="b in shelfBooks" :key="b.id" class="rd-trow rd-book"
          :class="{ 'rd-trow-on': active?.bookId === b.id, 'rd-book-missing': b.fileMissing, 'rd-book-drag': dragId === b.id, 'rd-book-over': dragOverId === b.id }"
          :draggable="canDrag"
          :title="'双击直接翻开《' + b.title + '》' + (b.filePath ? '\n' + b.filePath : '')" @dblclick="startBook(b)"
          @dragstart="onDragStart($event, b)" @dragover="onDragOverBook($event, b)"
          @drop="onDropBook($event, b)" @dragend="onDragEnd"
        >
          <span v-if="canDrag" class="rd-grip" aria-hidden="true" title="按住拖动，调整书架顺序">⋮⋮</span>
          <span v-else class="rd-th-grip" aria-hidden="true"></span>
          <span class="rd-td rd-td-title">
            <span class="rd-tcover" :style="{ background: b.coverColor || coverHue(b) }" aria-hidden="true">
              <img v-if="coverOf(b)" :src="coverOf(b)" :alt="b.title + ' 封面'" class="rd-cover-img" />
            </span>
            <span class="rd-tname-wrap">
              <span class="rd-tname" :title="b.title">{{ b.title }}</span>
              <!-- 路径保留在行里：这是「只登记路径、不复制内容」这条承诺的唯一可见证据 -->
              <span v-if="b.filePath" class="rd-tpath" :title="b.filePath">{{ b.filePath }}</span>
            </span>
            <span v-if="b.group" class="rd-chip rd-chip-file">{{ b.group }}</span>
            <span v-if="b.favorite" class="rd-tfav" title="在收藏夹里">★</span>
            <span v-if="b.fileMissing" class="rd-chip rd-chip-warn">原件不在</span>
          </span>
          <span class="rd-td rd-td-author" :title="b.author || ''">{{ b.author || '未记作者' }}</span>
          <span class="rd-td rd-td-size" :title="[b.format, b.fileSizeText, b.noteCount + ' 条笔记'].filter(Boolean).join(' · ')">{{ [b.format, b.fileSizeText].filter(Boolean).join(' ') || '—' }}</span>
          <span class="rd-td rd-td-date" :title="b.lastReadAt ? fmtRecent(b.lastReadAt) : '还没翻开过'">{{ b.lastReadAt ? fmtDate(b.lastReadAt) : '—' }}</span>
          <span class="rd-td rd-td-pct" :title="'已读 ' + b.progressText + ' · 还剩 ' + Math.max(0, b.total - b.done) + ' ' + b.unit + ' · ' + b.noteCount + ' 条笔记'">
            <span class="rd-tbar" role="progressbar" :aria-valuenow="b.pct" aria-valuemin="0" aria-valuemax="100" :aria-label="b.title + ' 已读进度'">
              <span class="rd-tbar-in" :style="{ width: b.pct + '%' }"></span>
            </span>
            <span class="rd-tpct">{{ b.pct }}%</span>
          </span>
          <span class="rd-td rd-td-act" @dblclick.stop>
            <button class="rd-mini rd-fav" :class="{ 'rd-fav-on': b.favorite }" :aria-pressed="!!b.favorite" :title="b.favorite ? '移出收藏夹' : '收进收藏夹'" @click="toggleFavorite(b)">{{ b.favorite ? '★' : '☆' }}</button>
            <button class="rd-mini" title="记 10 个单位的进度" @click="advanceLeisure(b.id, 10)">＋</button>
            <button class="rd-mini" :title="b.filePath ? '在独立阅读窗口打开：目录 / 正文 / 笔记三栏' : '手工登记的书，在中栏记笔记'" @click="startBook(b)">翻开读</button>
            <!-- P0-2：文件被移走 / 改名时，这里换路径而不是「移出再添加」——后者会造出新 id，笔记全丢 -->
            <button
              v-if="b.fileMissing" class="rd-mini rd-mini-warn"
              :title="'原文件不在 ' + b.filePath + '：选它的新位置，书的 id 不变，' + b.noteCount + ' 条笔记与书签都跟着回来'"
              :disabled="relinking === b.id" @click.stop="relinkBook(b)"
            >重新关联</button>
            <button class="rd-mini" title="改书名 / 作者 / 封面，或标记读完、再读一遍" @click="openEdit(b)">编辑</button>
            <button class="rd-mini rd-mini-quiet" title="移出书架（笔记保留）" @click="removeBook(b.id)">✕</button>
          </span>
        </article>
      </div>
      <div v-else-if="viewMode === 'grid'" class="rd-grid" aria-label="封面预览">
        <article
          v-for="b in shelfBooks" :key="b.id" class="rd-card"
          :class="{ 'rd-card-missing': b.fileMissing, 'rd-book-drag': dragId === b.id, 'rd-book-over': dragOverId === b.id }"
          :draggable="canDrag"
          :title="'双击直接翻开《' + b.title + '》'" @dblclick="startBook(b)"
          @dragstart="onDragStart($event, b)" @dragover="onDragOverBook($event, b)"
          @drop="onDropBook($event, b)" @dragend="onDragEnd"
        >
          <div class="rd-card-cover" :style="{ background: coverHue(b) }">
            <img v-if="coverOf(b)" :src="coverOf(b)" :alt="b.title + ' 封面'" class="rd-card-img" />
            <span v-else class="rd-card-initial" :style="coverNameStyle(b.title, 34)" aria-hidden="true">{{ b.title }}</span>
            <span v-if="b.format" class="rd-card-format">{{ b.format }}</span>
            <button class="rd-card-fav" :class="{ 'rd-fav-on': b.favorite }" :aria-pressed="!!b.favorite" :title="b.favorite ? '移出收藏夹' : '收进收藏夹'" @click.stop="toggleFavorite(b)">{{ b.favorite ? '★' : '☆' }}</button>
          </div>
          <div class="rd-card-body">
            <strong class="rd-card-title" :title="b.title">{{ b.title }}</strong>
            <span class="rd-hint">{{ b.author || '未记作者' }}<template v-if="b.fileSizeText"> · {{ b.fileSizeText }}</template></span>
            <span class="rd-meta">{{ b.progressText }} · {{ b.statusLabel }} · {{ b.noteCount }} 条笔记</span>
            <span v-if="b.fileMissing" class="rd-chip rd-chip-warn">原文件已不在原处</span>
            <div class="rd-card-actions" @dblclick.stop>
              <button class="rd-mini" :title="b.filePath ? '在独立阅读窗口打开：目录 / 正文 / 笔记三栏' : '手工登记的书，在中栏记笔记'" @click="startBook(b)">翻开读</button>
              <button class="rd-mini" title="改书名 / 作者 / 封面，或标记读完、再读一遍" @click="openEdit(b)">编辑</button>
              <button class="rd-mini rd-mini-quiet" @click="removeBook(b.id)">移出</button>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="rd-wall" aria-label="封面墙">
        <article
          v-for="b in shelfBooks" :key="b.id" class="rd-spine"
          :class="{ 'rd-spine-on': active?.bookId === b.id, 'rd-book-missing': b.fileMissing, 'rd-book-drag': dragId === b.id, 'rd-book-over': dragOverId === b.id }"
          :draggable="canDrag"
          :title="'《' + b.title + '》' + (b.author ? ' · ' + b.author : '') + ' · 双击翻开读'"
          @dblclick="startBook(b)"
          @dragstart="onDragStart($event, b)" @dragover="onDragOverBook($event, b)"
          @drop="onDropBook($event, b)" @dragend="onDragEnd"
        >
          <span class="rd-spine-box" :style="{ background: b.coverColor || coverHue(b) }">
            <img v-if="coverOf(b)" :src="coverOf(b)" :alt="b.title + ' 封面'" class="rd-spine-img" />
            <span v-else class="rd-spine-initial" :style="coverNameStyle(b.title, 24)" aria-hidden="true">{{ b.title }}</span>
            <span v-if="b.fileMissing" class="rd-spine-badge">原件不在</span>
          </span>
          <span class="rd-spine-tip" aria-hidden="true">
            <strong class="rd-spine-name">《{{ b.title }}》</strong>
            <span class="rd-spine-sub">{{ b.author || '未记作者' }}</span>
            <span class="rd-spine-sub">{{ b.progressText }} · {{ b.statusLabel }}</span>
          </span>
        </article>
      </div>

      <div v-if="active && active.mode === 'leisure'" class="rd-reader" aria-label="休闲阅读器">
        <h2 class="rd-h2">正在读《{{ active.title }}》</h2>
        <div class="rd-reader-grid">
          <div class="rd-col">
            <h3 class="rd-h3">章节大纲 <span class="rd-hint">自己填，不是自动生成的思维导图</span></h3>
            <div class="rd-chapters">
              <p v-for="c in activeChapters" :key="c.id" class="rd-chapter" :class="{ 'rd-chapter-sub': !!c.parentId }">
                {{ c.parentId ? '↳ ' : '· ' }}{{ c.title }}
                <!-- P2-3：这一章对应书里的第几节。填了就能在阅读窗左栏「我的大纲」里一跳到位；
                     留空就是纯大纲，不假装知道它在书里的位置。 -->
                <input
                  class="rd-cseq" type="text" inputmode="numeric" maxlength="4"
                  :value="c.anchor ? String(chapterSeqOf(c.anchor)) : ''"
                  :aria-label="'《' + c.title + '》对应书内第几节'"
                  title="对应书内第几节（可空）"
                  placeholder="节"
                  @change="setChapterAnchor(c, $event)"
                />
                <button class="rd-x" :aria-label="'删除章节 ' + c.title" @click="removeChapter(c.id)">×</button>
              </p>
              <p v-if="!activeChapters.length" class="rd-hint">还没分章。读到哪儿顺手记一个章节名即可。</p>
            </div>
            <div class="rd-inline-add">
              <input v-model="newChapter" class="rd-input" placeholder="加一个章节" aria-label="新章节名" @keyup.enter="addChapter" />
              <input v-model="newChapterSeq" class="rd-cseq rd-cseq-new" type="text" inputmode="numeric" maxlength="4" placeholder="第几节" aria-label="这一章对应书内第几节（可空）" />
              <button class="rd-mini" @click="addChapter">＋</button>
            </div>
          </div>
          <div class="rd-col">
            <h3 class="rd-h3">批注贴着原文长</h3>
            <div class="rd-prompts" aria-label="伴读三问">
              <button
                v-for="p in PROMPTS" :key="p.id"
                class="rd-prompt" :class="{ 'rd-prompt-on': activePrompt === p.id }"
                :title="p.hint" @click="pickPrompt(p)"
              >{{ p.label }}</button>
            </div>
            <p v-if="activePrompt" class="rd-hint">{{ PROMPTS.find(p => p.id === activePrompt)?.hint }}</p>
            <textarea v-model="noteQuote" class="rd-area" rows="3" placeholder="摘录：书里那句原话" aria-label="摘录原文"></textarea>
            <textarea v-model="noteText" class="rd-area" rows="3" placeholder="我的批注 / 想法（自己的话）" aria-label="我的批注"></textarea>
            <div class="rd-form-row">
              <select v-model="noteType" class="rd-input rd-sel" aria-label="笔记类型">
                <option v-for="t in NOTE_TYPES" :key="t.key" :value="t.key">{{ t.label }}</option>
              </select>
              <input v-model="notePage" class="rd-input rd-num" type="number" min="0" placeholder="页码" aria-label="页码" />
              <input v-model="noteTags" class="rd-input" placeholder="#标签 空格分隔" aria-label="标签" />
              <button class="rd-primary" @click="saveNote">存进读书笔记</button>
            </div>
            <div class="rd-flash">
              <input v-model="flash" class="rd-input" placeholder="即时想法：一句话，回车即存进九格" aria-label="即时想法" @keyup.enter="saveFlash" />
              <select v-model="flashCell" class="rd-input rd-sel" aria-label="闪念写入的格子">
                <option value="free">自由记录</option>
                <option value="leisure">休闲娱乐</option>
                <option value="growth">学习成长</option>
              </select>
              <button class="rd-mini" @click="saveFlash">闪念入格</button>
            </div>
            <p v-if="props.backfill" class="rd-warn">正在补记过去：写进九格的动作只作用于真实今天 {{ props.today }}。</p>
          </div>
        </div>
        <div class="rd-notes-inline">
          <h3 class="rd-h3">这本书已有的笔记（{{ activeNotes.length }}）</h3>
          <p v-for="n in activeNotes.slice(0, 5)" :key="n.id" class="rd-note-line">
            <span class="rd-chip">{{ n.typeLabel || n.type }}</span>
            {{ n.quote ? '「' + n.quote + '」→ ' : '' }}{{ n.text }}
            <span class="rd-hint">p.{{ n.page }} {{ n.tags.map(t => '#' + t).join(' ') }}</span>
          </p>
          <p v-if="!activeNotes.length" class="rd-hint">还没有笔记。读到一句想留的话，就写在上面。</p>
        </div>
      </div>
      <!-- 编辑书籍信息（对标 mybook 的「编辑书籍信息」）：只改书架上的显示，不动文件 -->
      <div v-if="editing" class="rd-modal" role="dialog" aria-modal="true" aria-label="编辑书籍信息">
        <div class="rd-modal-box">
          <header class="rd-modal-head">
            <h2 class="rd-modal-title">编辑《{{ editing.title }}》</h2>
            <button class="rd-x" aria-label="关闭" @click="editing = null">×</button>
          </header>
          <div class="rd-modal-row">
            <label class="rd-modal-label" for="rdEditTitle">书名</label>
            <input id="rdEditTitle" ref="editTitleEl" v-model="editTitle" class="rd-input" aria-label="书名" @keyup.enter="saveEdit" />
          </div>
          <div class="rd-modal-row">
            <label class="rd-modal-label" for="rdEditAuthor">作者</label>
            <input id="rdEditAuthor" v-model="editAuthor" class="rd-input" placeholder="可不填" aria-label="作者" @keyup.enter="saveEdit" />
          </div>
          <div class="rd-modal-row">
            <label class="rd-modal-label" for="rdEditGroup">分组</label>
            <select v-if="!editGroupNew" id="rdEditGroup" v-model="editGroup" class="rd-input rd-gsel" aria-label="所属分组">
              <option value="">未分组</option>
              <option v-for="g in groups" :key="g.name" :value="g.name">{{ g.name }}</option>
            </select>
            <input v-else v-model="editGroup" class="rd-input rd-gsel" placeholder="输入一个新分组名" aria-label="新分组名" />
            <button class="rd-mini rd-mini-quiet" :title="editGroupNew ? '回到已有分组列表' : '直接输入一个新分组名'" @click="editGroupNew = !editGroupNew">{{ editGroupNew ? '选已有' : '＋ 新建' }}</button>
          </div>
          <div class="rd-modal-row">
            <span class="rd-modal-label">封面</span>
            <span class="rd-modal-btns">
              <img v-if="editing && coverOf(editing)" :src="coverOf(editing)" alt="当前封面" class="rd-cover-prev" />
              <button class="rd-mini" :disabled="editCoverBusy" @click="pickCover">{{ editCoverBusy ? '正在换…' : '选一张图当封面' }}</button>
              <button class="rd-mini" :disabled="editCoverBusy || doubanBusy" title="用书名去豆瓣搜同名书的封面，挑一张用上" @click="findDoubanCovers">{{ doubanBusy ? '正在搜…' : '从豆瓣找封面' }}</button>
              <button class="rd-mini rd-mini-quiet" :disabled="editCoverBusy" @click="resetCover">恢复默认</button>
            </span>
          </div>
          <!-- 豆瓣候选：先给人看，再由人点；不点就不会有任何一张被套上去 -->
          <div v-if="doubanMsg || doubanItems.length" class="rd-douban">
            <p class="rd-hint">{{ doubanMsg }}</p>
            <div v-if="doubanItems.length" class="rd-douban-grid">
              <button
                v-for="(it, i) in doubanItems" :key="i" class="rd-douban-item" :disabled="doubanBusy"
                :class="{ 'rd-douban-item-on': doubanPicked === i }"
                :title="'用这张：' + it.title + (it.author ? ' · ' + it.author : '')" @click="applyDoubanCover(it, i)"
              >
                <img v-if="it.thumb" :src="it.thumb" :alt="it.title + ' 封面候选'" class="rd-douban-img" />
                <span v-else class="rd-douban-img rd-douban-nocover">无图</span>
                <span class="rd-douban-name">{{ it.title }}</span>
                <span class="rd-douban-sub">{{ [it.author, it.year].filter(Boolean).join(' · ') || '—' }}</span>
              </button>
            </div>
          </div>
          <p class="rd-hint">只改书架上显示的书名与作者，电子书文件本身一个字节都不动。封面会复制一份小图进本机数据目录，原图删了也不影响。</p>
          <div class="rd-modal-acts">
            <div class="rd-acts-sub">
              <button v-if="editing.status !== 'done'" class="rd-mini" @click="doneFromEdit">标记读完</button>
              <button class="rd-mini" @click="rereadFromEdit">再读一遍</button>
              <button class="rd-mini rd-mini-quiet" @click="exportFromEdit">导出这本的笔记</button>
              <button v-if="editing.filePath" class="rd-mini rd-mini-quiet" @click="revealFromEdit">在文件夹里定位</button>
              <!-- P0-2：换位置而不换身份。这一步点完，笔记 / 章节 / 书签 / 按书筛选全部照旧 -->
              <button
                v-if="editing.filePath" class="rd-mini rd-mini-quiet"
                :disabled="relinking === editing.id"
                @click="relinkBook(editing)"
              >文件换了位置？重新关联</button>
            </div>
            <div class="rd-acts-main">
              <button class="rd-mini rd-mini-quiet" @click="editing = null">取消</button>
              <button class="rd-primary" @click="saveEdit">保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 主题阅读（V2.14：自建书单 · 与休闲阅读功能一致） ============ -->
    <div v-else-if="tab === 'theme'" class="rd-pane">
      <div class="rd-notice">
        <span>主题书单现在由这里维护：建主题 → 往主题里放书 → 双击读正文。多格式多文件都归在同一主题下，笔记也集中记录在这里。</span>
        <button class="rd-mini" @click="importThemes">导入学习成长的旧主题书单</button>
      </div>

      <!-- 新建主题 -->
      <div class="rd-add">
        <input v-model="newThemeTitle" class="rd-input rd-name" placeholder="新主题名，如：污水处理工艺" aria-label="新主题名" @keyup.enter="addNewTheme" />
        <input v-model="newThemeNote" class="rd-input" placeholder="这个主题想解决什么（可不填）" aria-label="主题说明" />
        <button class="rd-primary" @click="addNewTheme">＋ 建主题</button>
      </div>

      <div v-if="!themeGroups.length" class="rd-empty">还没有主题。先在上面建一个主题，然后把电子书拖进主题里；学习成长里的旧书单也可以一键导入。</div>

      <section v-for="g in themeGroups" :key="g.themeId" class="rd-group" :class="{ 'rd-group-on': themeSel === g.themeId }">
        <h2 class="rd-h2">
          <button class="rd-group-title" :aria-expanded="!isThemeClosed(g.themeId)"
            :title="isThemeClosed(g.themeId) ? '展开这个主题的书单' : '收起这个主题的书单'"
            @click="toggleTheme(g.themeId)">{{ isThemeClosed(g.themeId) ? '▸' : '▾' }} {{ g.themeTitle }}</button>
          <span class="rd-hint">{{ g.rows.length }} 本<span v-if="isThemeClosed(g.themeId)"> · 已收起</span></span>
          <button class="rd-mini rd-mini-quiet rd-group-del" :aria-label="'删除主题 ' + g.themeTitle" @click="removeTheme(g.themeId, g.themeTitle)">删主题</button>
        </h2>
        <p v-if="g.note && !isThemeClosed(g.themeId)" class="rd-meta">{{ g.note }}</p>

        <template v-if="!isThemeClosed(g.themeId)">
        <!-- 主题下导入多格式多文件（与休闲阅读同样的拖放/选择入口，归到本主题） -->
        <div class="rd-files">
          <div class="rd-drop" :class="{ 'rd-drop-on': importingTheme === g.themeId }" aria-label="拖放电子书到本主题"
            @dragenter.prevent="importingTheme = g.themeId" @dragover.prevent="importingTheme = g.themeId"
            @dragleave.prevent="importingTheme = ''" @drop="onThemeDrop($event, g.themeId)">
            <span class="rd-drop-icon" aria-hidden="true">⇩</span>
            <span>把电子书拖「{{ g.themeTitle }}」里，笔记就记在这个主题下</span>
            <span class="rd-hint">支持 EPUB / PDF / TXT / MD / MOBI / AZW3 · 多格式多文件 · 只登记路径</span>
          </div>
          <div class="rd-file-actions rd-file-actions-theme">
            <button class="rd-primary" :disabled="importing" @click="pickThemeFiles(g.themeId)">＋ 选择电子书放进本主题</button>
            <span class="rd-theme-book-add">
              <input v-model="newThemeBook" class="rd-input" placeholder="或手写书名（无电子书，仅记笔记）" aria-label="主题新书名" @keyup.enter="addThemeBook(g.themeId)" />
              <button class="rd-mini" @click="addThemeBook(g.themeId)">＋ 加书名</button>
            </span>
          </div>
        </div>

        <div v-if="!g.rows.length" class="rd-hint rd-group-empty">这个主题还没放书。拖一本进来，或手写书名。</div>
        <!-- V3.15：主题下的书也走 calibre 式表格（与休闲书架同一套列与行外观）。
             原来每本一张大卡片：一个主题放十来份资料就要翻好几屏，而且没法横向比
             「哪本厚、哪天翻过、读到几成」——那正是表格擅长的事。 -->
        <div v-else class="rd-table rd-theme-table" :aria-label="g.themeTitle + ' 书单（表格）'">
          <div class="rd-thead rd-thead-static" role="row">
            <span class="rd-th rd-th-grip" aria-hidden="true"></span>
            <span class="rd-th rd-th-title" role="columnheader">书名</span>
            <span class="rd-th rd-th-author" role="columnheader">作者</span>
            <span class="rd-th rd-th-size" role="columnheader">格式 · 大小</span>
            <span class="rd-th rd-th-date" role="columnheader">最近读过</span>
            <span class="rd-th rd-th-pct" role="columnheader">进度</span>
            <span class="rd-th rd-th-act">操作</span>
          </div>
          <article
            v-for="b in g.rows" :key="b.id" class="rd-trow rd-book"
            :class="{ 'rd-trow-on': active?.bookId === b.id, 'rd-book-missing': b.fileMissing }"
            :title="'双击翻开《' + b.title + '》' + (b.filePath ? '\n' + b.filePath : '')" @dblclick="startThemeBook(b)"
          >
            <span class="rd-th-grip" aria-hidden="true"></span>
            <span class="rd-td rd-td-title">
              <span class="rd-tcover" :style="{ background: b.coverColor || coverHue(b) }" aria-hidden="true">
                <img v-if="coverOf(b)" :src="coverOf(b)" :alt="b.title + ' 封面'" class="rd-cover-img" />
              </span>
              <span class="rd-tname-wrap">
                <span class="rd-tname" :title="b.title">{{ b.title }}</span>
                <!-- 路径是「只登记路径、不复制内容」这条承诺的唯一可见证据，手写的书就写清没有文件 -->
                <span v-if="b.filePath" class="rd-tpath" :title="b.filePath">{{ b.filePath }}</span>
                <span v-else class="rd-tpath">手工登记，仅记笔记</span>
              </span>
              <span v-if="b.statusLabel" class="rd-chip">{{ b.statusLabel }}</span>
              <span v-if="b.fileMissing" class="rd-chip rd-chip-warn">原件不在</span>
            </span>
            <span class="rd-td rd-td-author" :title="b.author || ''">{{ b.author || '未记作者' }}</span>
            <span class="rd-td rd-td-size" :title="[b.format, b.fileSizeText, b.noteCount + ' 条笔记'].filter(Boolean).join(' · ')">{{ [b.format, b.fileSizeText].filter(Boolean).join(' ') || '—' }}</span>
            <span class="rd-td rd-td-date" :title="b.lastReadAt ? fmtRecent(b.lastReadAt) : '还没翻开过'">{{ b.lastReadAt ? fmtDate(b.lastReadAt) : '—' }}</span>
            <span class="rd-td rd-td-pct" :title="'已读 ' + b.progressText + ' · ' + b.noteCount + ' 条笔记'">
              <span class="rd-tbar" role="progressbar" :aria-valuenow="b.pct" aria-valuemin="0" aria-valuemax="100" :aria-label="b.title + ' 已读进度'">
                <span class="rd-tbar-in" :style="{ width: b.pct + '%' }"></span>
              </span>
              <span class="rd-tpct">{{ b.pct }}%</span>
            </span>
            <span class="rd-td rd-td-act" @dblclick.stop>
              <button class="rd-mini" :title="'记 10 个' + b.unit + '的进度'" @click="advanceTheme(g.themeId, b.id, 10)">＋</button>
              <button class="rd-mini" :title="b.filePath ? '在独立阅读窗口打开：目录 / 正文 / 笔记三栏' : '手工登记的书，在右栏记笔记'" @click="startThemeBook(b)">翻开读</button>
              <button
                v-if="b.fileMissing" class="rd-mini rd-mini-warn"
                :title="'原文件不在 ' + b.filePath + '：选它的新位置，书的 id 不变，笔记与书签都跟着回来'"
                :disabled="relinking === b.id" @click.stop="relinkBook(b)"
              >重新关联</button>
              <button class="rd-mini" title="改书名 / 作者 / 封面，或标记读完、再读一遍（与休闲阅读同一套）" @click="openEdit(b)">编辑</button>
              <button class="rd-mini rd-mini-quiet" title="移出书库（笔记保留）" @click="removeBook(b.id)">✕</button>
            </span>
          </article>
        </div>

        <!-- 主题批注器（与休闲阅读同款：章节大纲 / 伴读三问 / 摘录批注 / 闪念 / 已有笔记）。
             V3.15 起挪进「这本书所属的主题」里：表格化后一个主题能放十几本，
             若还挂在所有主题之后，点了第一本就得滚过别的主题才看得见批注器。 -->
        <div v-if="active && active.mode === 'theme' && active.themeId === g.themeId" class="rd-reader" aria-label="主题阅读器">
          <h2 class="rd-h2">正在读《{{ active.title }}》<span class="rd-hint"> · 主题阅读 · 笔记记在本主题下</span></h2>
          <div class="rd-reader-grid">
            <div class="rd-col">
              <h3 class="rd-h3">章节大纲 <span class="rd-hint">自己填，不是自动生成的思维导图</span></h3>
              <div class="rd-chapters">
                <p v-for="c in activeChapters" :key="c.id" class="rd-chapter" :class="{ 'rd-chapter-sub': !!c.parentId }">
                  {{ c.parentId ? '↳ ' : '· ' }}{{ c.title }}
                  <input
                    class="rd-cseq" type="text" inputmode="numeric" maxlength="4"
                    :value="c.anchor ? String(chapterSeqOf(c.anchor)) : ''"
                    :aria-label="'《' + c.title + '》对应书内第几节'"
                    title="对应书内第几节（可空）"
                    placeholder="节"
                    @change="setChapterAnchor(c, $event)"
                  />
                  <button class="rd-x" :aria-label="'删除章节 ' + c.title" @click="removeChapter(c.id)">×</button>
                </p>
                <p v-if="!activeChapters.length" class="rd-hint">还没分章。读到哪儿顺手记一个章节名即可。</p>
              </div>
              <div class="rd-inline-add">
                <input v-model="newChapter" class="rd-input" placeholder="加一个章节" aria-label="新章节名" @keyup.enter="addChapter" />
                <input v-model="newChapterSeq" class="rd-cseq rd-cseq-new" type="text" inputmode="numeric" maxlength="4" placeholder="第几节" aria-label="这一章对应书内第几节（可空）" />
                <button class="rd-mini" @click="addChapter">＋</button>
              </div>
            </div>
            <div class="rd-col">
              <h3 class="rd-h3">批注贴着原文长</h3>
              <div class="rd-prompts" aria-label="伴读三问">
                <button v-for="p in PROMPTS" :key="p.id" class="rd-prompt" :class="{ 'rd-prompt-on': activePrompt === p.id }" :title="p.hint" @click="pickPrompt(p)">{{ p.label }}</button>
              </div>
              <p v-if="activePrompt" class="rd-hint">{{ PROMPTS.find(p => p.id === activePrompt)?.hint }}</p>
              <textarea v-model="noteQuote" class="rd-area" rows="3" placeholder="摘录：书里那句原话" aria-label="摘录原文"></textarea>
              <textarea v-model="noteText" class="rd-area" rows="3" placeholder="我的批注 / 想法（自己的话）" aria-label="我的批注"></textarea>
              <div class="rd-form-row">
                <select v-model="noteType" class="rd-input rd-sel" aria-label="笔记类型">
                  <option v-for="t in NOTE_TYPES" :key="t.key" :value="t.key">{{ t.label }}</option>
                </select>
                <input v-model="notePage" class="rd-input rd-num" type="number" min="0" placeholder="页码" aria-label="页码" />
                <input v-model="noteTags" class="rd-input" placeholder="#标签 空格分隔" aria-label="标签" />
                <button class="rd-primary" @click="saveNote">存进读书笔记</button>
              </div>
              <div class="rd-flash">
                <input v-model="flash" class="rd-input" placeholder="即时想法：一句话，回车即存进九格" aria-label="即时想法" @keyup.enter="saveFlash" />
                <select v-model="flashCell" class="rd-input rd-sel" aria-label="闪念写入的格子">
                  <option value="growth">学习成长</option>
                  <option value="free">自由记录</option>
                  <option value="leisure">休闲娱乐</option>
                </select>
                <button class="rd-mini" @click="saveFlash">闪念入格</button>
              </div>
              <p v-if="props.backfill" class="rd-warn">正在补记过去：写进九格的动作只作用于真实今天 {{ props.today }}。</p>
            </div>
          </div>
          <div class="rd-notes-inline">
            <h3 class="rd-h3">这本书已有的笔记（{{ activeNotes.length }}）</h3>
            <p v-for="n in activeNotes.slice(0, 5)" :key="n.id" class="rd-note-line">
              <span class="rd-chip">{{ n.typeLabel || n.type }}</span>
              {{ n.quote ? '「' + n.quote + '」→ ' : '' }}{{ n.text }}
              <span class="rd-hint">p.{{ n.page }} {{ n.tags.map(t => '#' + t).join(' ') }}</span>
            </p>
            <p v-if="!activeNotes.length" class="rd-hint">还没有笔记。读到一句想留的话，就写在上面。</p>
          </div>
        </div>
        </template>
      </section>
    </div>

    <!-- ============ 读书笔记 · 数据库 ============ -->
    <div v-else class="rd-pane">
      <div class="rd-filter">
        <input v-model="kw" class="rd-input" placeholder="搜原文 / 批注 / 书名 / 标签" aria-label="关键词" @keyup.enter="applyFilter" />
        <select v-model="fMode" class="rd-input rd-sel" aria-label="按阅读类型筛选" @change="applyFilter">
          <option value="">两类阅读</option><option value="leisure">休闲娱乐</option><option value="theme">主题阅读</option>
        </select>
        <select v-model="fType" class="rd-input rd-sel" aria-label="按笔记类型筛选" @change="applyFilter">
          <option value="">全部类型</option>
          <option v-for="t in NOTE_TYPES" :key="t.key" :value="t.key">{{ t.label }}</option>
        </select>
        <button class="rd-mini" @click="applyFilter">筛选</button>
        <button class="rd-mini" @click="importQuotes">汇总旧摘录</button>
        <button class="rd-mini rd-export" @click="exportNotes">导出汇总</button>
      </div>
      <div class="rd-tags" aria-label="标签聚类">
        <button v-for="t in tagTop" :key="t.tag" class="rd-tag" :class="{ 'rd-tag-on': fTag === t.tag }" @click="pickTag(t.tag)">#{{ t.tag }} <span>{{ t.count }}</span></button>
        <span v-if="!tagTop.length" class="rd-hint">还没有标签。批注时写 #标签，同类的想法就能聚到一起。</span>
      </div>
      <p class="rd-hint">共 {{ noteTotal }} 条 · 已回写九格 {{ stats.pushed }} 条 · 主题阅读笔记 {{ stats.themeNotes }} 条</p>

      <div v-if="!notes.length" class="rd-empty">「读书笔记」数据库还是空的。翻开一本书，留下一句摘录或一点想法。</div>
      <article v-for="n in notes" :key="n.id" class="rd-note" :class="{ 'rd-note-pushed': !!n.pushedAt }">
        <div class="rd-note-head">
          <span class="rd-chip">{{ n.typeLabel || n.type }}</span>
          <span class="rd-chip rd-chip-soft">{{ n.modeLabel || (n.mode === 'theme' ? '主题阅读' : '休闲娱乐') }}</span>
          <strong class="rd-note-book">《{{ n.bookTitle || '未记书名' }}》</strong>
          <span class="rd-hint">{{ fmtDate(n.createdAt) }} · p.{{ n.page }}</span>
          <span v-if="n.orphan" class="rd-chip rd-chip-warn">原书已移出</span>
        </div>
        <p v-if="n.quote" class="rd-note-quote">「{{ n.quote }}」</p>
        <p v-if="n.text" class="rd-note-text">{{ n.text }}</p>
        <div class="rd-note-foot">
          <span class="rd-hint">{{ n.tags.map(t => '#' + t).join(' ') }}</span>
          <span class="rd-spacer"></span>
          <!-- P1-3：打了 #行动 的笔记要有下落。按 source 幂等，重复点不会叠出两条。 -->
          <button v-if="isActionNote(n)" class="rd-mini" title="这条打了 #行动：放进「工作推进」的收件箱，等厘清" @click="pushActionNote(n)">→ 收件箱</button>
          <button v-if="!n.pushedAt" class="rd-mini" @click="pushNote(n)">→ 九格</button>
          <span v-else class="rd-pushed">已入九格 · {{ fmtDate(n.pushedAt) }}</span>
          <button class="rd-mini rd-mini-quiet" :aria-label="'删除笔记'" @click="removeNote(n.id)">删除</button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.rd-view { display: flex; flex-direction: column; gap: var(--space-3); }
.rd-head { position: relative; }
/* 窗口内的窄头：只留「关闭」与一句说明，标题在左栏品牌区 */
.rd-head-lite { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.rd-head-lite .rd-sub { margin: 0; }
.rd-back { border: 0; background: transparent; color: var(--palette-primary); font-size: var(--text-sm); padding: 0; cursor: pointer; }
.rd-title { font-size: var(--text-h1); margin: 6px 0 2px; color: var(--surface-text); }
.rd-sub { font-size: var(--text-sm); color: var(--surface-muted); margin: 0; }
.rd-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-top: var(--space-2); }
.rd-stat { font-size: var(--text-xs); color: var(--surface-muted); padding: 3px 10px; border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-raised); }
.rd-stat b { font-size: var(--text-body); color: var(--surface-text); margin-right: 2px; }
/* V3.14：搜索 / 页签 / 排序挤在同一行——搜索在最左，排序与计数靠右。
   行内换行是允许的（窗口窄到 1024 时），但不许把搜索挤成一条竖线。 */
.rd-tabs {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  border-bottom: 0.5px solid var(--surface-border); padding-bottom: 8px;
}
.rd-search { flex: 0 1 230px; min-width: 180px; }
.rd-tab { padding: 6px 12px; font-size: var(--text-sm); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--surface-text); cursor: pointer; white-space: nowrap; }
.rd-tab-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.rd-pane { display: flex; flex-direction: column; gap: var(--space-2); }
.rd-add, .rd-filter, .rd-form-row, .rd-flash, .rd-inline-add { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.rd-input { padding: 6px 9px; font-size: var(--text-sm); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--surface-text); min-width: 0; }
.rd-name { flex: 1 1 180px; }
.rd-num { width: 74px; }
.rd-sel { width: auto; }
.rd-area { width: 100%; padding: 8px 10px; font-size: var(--text-sm); line-height: 1.6; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--surface-text); resize: vertical; font-family: inherit; }
.rd-primary { padding: 6px 14px; font-size: var(--text-sm); border: 0.5px solid var(--palette-primary); border-radius: var(--radius-md); background: var(--palette-primary); color: var(--palette-on); cursor: pointer; }
.rd-mini { padding: 4px 9px; font-size: var(--text-xs); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); color: var(--surface-text); cursor: pointer; white-space: nowrap; }
.rd-mini:hover { border-color: var(--palette-border); }
.rd-mini-quiet { color: var(--surface-muted); }
/* 「原件不在 / 该怎么修」这类按钮要点出来：它是用户此刻最该点的那个 */
.rd-mini-warn { border-color: var(--palette-border); color: var(--palette-primary); }

/* ---- P0-4 书库体检：一格一个数，展开才看明细 ---- */
.rd-audit-btn { margin-left: auto; flex: 0 0 auto; }
.rd-audit {
  margin: 0 0 var(--space-2); padding: var(--space-2) var(--space-3);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg);
  background: var(--surface-panel);
}
.rd-audit-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rd-audit-head h2 { margin: 0; }
.rd-audit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 6px; margin-top: 8px; }
.rd-audit-kpi {
  background: var(--surface-raised); border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md); padding: 6px 8px;
}
.rd-audit-kpi span { display: block; font-size: var(--text-xs); color: var(--surface-muted); }
.rd-audit-kpi b { display: block; font-size: var(--text-h2); font-weight: 500; line-height: 1.4; }
.rd-audit-list { margin-top: var(--space-2); }
.rd-audit-list h3 { margin: 0 0 2px; }
.rd-empty, .rd-notice { font-size: var(--text-sm); color: var(--surface-muted); padding: 12px; border: 0.5px dashed var(--surface-border); border-radius: var(--radius-md); line-height: 1.7; }
.rd-notice { display: flex; align-items: center; gap: 10px; justify-content: space-between; border-style: solid; background: var(--palette-soft); }
.rd-shelf { display: flex; flex-direction: column; gap: 8px; }
/* ---- 详细列表：calibre 式表格（V3.13） ----
   一列一项、列头可点排序、行高紧凑。窄窗口时整表横向滚动而不是把列挤成省略号：
   一列只剩一个「…」时，表格相对卡片就没有优势了。 */
.rd-table { border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); overflow-x: auto; background: var(--surface-raised); }
/* 表体沿用 rd-shelf 这个老钩子（门禁与用例按「书架容器」找行）：它是 flex 列容器，
   套在表格上会把「行」变成 flex item，所以这里显式还原成普通块 */
.rd-shelf.rd-table { display: block; gap: 0; }
/* 选择器必须带 .rd-table 前缀（V3.13 实测踩坑）：行同时挂着老类名 rd-book，而
   .rd-book{display:flex} 在样式表里更靠后，同权重会把它赢走，格子退化成 flex item
   ——作者列被压到 44px、格式列只剩 12px，整列变省略号。加一层祖先把权重抬到 0,2,0。 */
.rd-table > .rd-thead, .rd-table > .rd-trow {
  display: grid; min-width: 600px; gap: 6px; align-items: center;
  grid-template-columns: 16px minmax(0, 1fr) 74px 86px 52px 84px 172px;
}
.rd-thead { padding: 6px 10px; background: var(--surface-panel); border-bottom: 0.5px solid var(--surface-border); font-size: var(--text-xs); color: var(--surface-muted); }
.rd-th { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rd-th-title, .rd-th-author, .rd-th-size, .rd-th-date, .rd-th-pct, .rd-th-note { cursor: pointer; }
.rd-th-title:hover, .rd-th-author:hover, .rd-th-size:hover, .rd-th-date:hover, .rd-th-pct:hover, .rd-th-note:hover { color: var(--palette-primary); }
/* 主题下的表头只做列名，不排序（一个主题三五本到十几本，点了没反应才是问题）：
   去掉手型与悬停变色，免得看着像能点 */
.rd-thead-static .rd-th-title, .rd-thead-static .rd-th-author,
.rd-thead-static .rd-th-size, .rd-thead-static .rd-th-date,
.rd-thead-static .rd-th-pct { cursor: default; }
.rd-thead-static .rd-th-title:hover, .rd-thead-static .rd-th-author:hover,
.rd-thead-static .rd-th-size:hover, .rd-thead-static .rd-th-date:hover,
.rd-thead-static .rd-th-pct:hover { color: inherit; }
/* 主题表与书架表同一套列宽与行外观，只多一条与上方「拖放 / 选择电子书」的间距 */
.rd-theme-table { margin-top: 6px; }
/* 行外观同理：padding / 圆角 / 背景也要压过 .rd-book，否则每行又是一个大圆角卡片 */
.rd-table > .rd-trow { padding: 5px 10px; border: 0; border-top: 0.5px solid var(--surface-border); border-radius: 0; background: transparent; font-size: var(--text-sm); }
.rd-table > .rd-trow:nth-of-type(even) { background: var(--surface-panel); }
.rd-table > .rd-trow:hover { background: var(--palette-soft); }
.rd-table > .rd-trow.rd-trow-on { background: var(--palette-soft); box-shadow: inset 2px 0 0 var(--palette-primary); }
.rd-td { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-td-title { display: flex; align-items: center; gap: 6px; }
.rd-tcover { position: relative; width: 20px; height: 30px; flex: 0 0 20px; border-radius: 2px; overflow: hidden; box-shadow: 0 1px 2px rgba(0, 0, 0, .14); }
.rd-tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--surface-text); }
/* 书名两行：上面书名、下面路径。挤在一个 span 里会让 hasText 找不到书名，也读不出路径 */
.rd-tname-wrap { display: flex; flex-direction: column; min-width: 0; }
.rd-tpath { font-size: 10px; line-height: 1.25; color: var(--surface-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
.rd-tfav { color: var(--palette-accent); font-size: var(--text-xs); }
.rd-td-author, .rd-td-size, .rd-td-date, .rd-td-note { color: var(--surface-muted); font-size: var(--text-xs); }
.rd-td-pct { display: flex; align-items: center; gap: 6px; }
.rd-tbar { display: inline-block; width: 44px; height: 5px; flex: 0 0 44px; border-radius: 999px; background: var(--surface-border); overflow: hidden; }
.rd-tbar-in { display: block; height: 100%; border-radius: 999px; background: var(--palette-accent); }
.rd-tpct { flex: 0 0 auto; font-size: var(--text-xs); color: var(--surface-muted); }
.rd-td-act { display: flex; gap: 3px; justify-content: flex-end; }
.rd-td-act .rd-mini { padding: 2px 6px; }
.rd-grip { cursor: grab; color: var(--surface-muted); font-size: var(--text-xs); }
.rd-grip:active { cursor: grabbing; }
.rd-book { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); }
/* V3.15 起主题下的书也走表格，原来那套卡片结构（.rd-book-main / .rd-book-line /
   .rd-title-tight / .rd-thick / .rd-book-actions / .rd-cover 竖条）已无人引用，整组删掉。
   留着的只有 .rd-book 这个类名本身：表格行仍挂着它，GUI 用例按 .rd-group .rd-book 找行。 */
.rd-meta, .rd-hint { font-size: var(--text-xs); color: var(--surface-muted); margin: 0; }
.rd-chip { font-size: var(--text-xs); padding: 1px 7px; border-radius: 999px; background: var(--palette-soft); color: var(--palette-primary); }
.rd-chip-soft { background: var(--surface-panel); color: var(--surface-muted); }
.rd-chip-warn { background: var(--state-warn-soft); color: var(--state-warn); }
.rd-reader { margin-top: var(--space-2); padding: var(--space-3); border: 0.5px solid var(--palette-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.rd-h2 { font-size: var(--text-h2); margin: 0 0 var(--space-2); color: var(--surface-text); }
.rd-h3 { font-size: var(--text-sm); margin: 0 0 6px; color: var(--surface-muted); }
.rd-reader-grid { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: var(--space-3); }
.rd-col { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.rd-chapters { min-height: 60px; max-height: 170px; overflow: auto; }
.rd-chapter { font-size: var(--text-sm); margin: 0 0 4px; color: var(--surface-text); }
.rd-chapter-sub { padding-left: 12px; color: var(--surface-muted); }
/* P2-3 章节锚点：一个只有四个字符宽的小格子，不喧宾夺主 */
.rd-cseq {
  width: 4.2em; margin-left: 4px; padding: 1px 3px; font-size: var(--text-xs);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-bg); color: var(--surface-text); text-align: center;
}
.rd-cseq-new { width: 6em; margin-left: 0; }
.rd-x { border: 0; background: transparent; color: var(--surface-muted); cursor: pointer; }
.rd-prompts { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.rd-prompt { padding: 4px 9px; font-size: var(--text-xs); border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-raised); color: var(--surface-text); cursor: pointer; }
.rd-prompt-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.rd-flash { margin-top: 4px; padding-top: 8px; border-top: 0.5px dashed var(--surface-border); }
.rd-warn { font-size: var(--text-xs); color: var(--state-warn); margin: 0; }
.rd-notes-inline { margin-top: var(--space-2); padding-top: var(--space-2); border-top: 0.5px solid var(--surface-border); }
.rd-note-line { font-size: var(--text-sm); margin: 0 0 6px; color: var(--surface-text); line-height: 1.6; }
.rd-group { margin-bottom: var(--space-2); padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); }
.rd-group-on { border-color: var(--palette-border); }
.rd-group .rd-h2 { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rd-group-title { font-size: var(--text-h2); font-weight: 600; color: var(--surface-text); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.rd-group-del { margin-left: auto; }
.rd-group-empty { padding: 8px 0; display: block; }
.rd-filter { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.rd-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.rd-tag { padding: 3px 9px; font-size: var(--text-xs); border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-panel); color: var(--surface-text); cursor: pointer; }
.rd-tag-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.rd-tag span { color: var(--surface-muted); }
.rd-note { padding: 10px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); }
.rd-note-pushed { border-color: var(--palette-border); }
.rd-note-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rd-note-book { font-size: var(--text-sm); color: var(--surface-text); }
.rd-note-quote { font-size: var(--text-sm); color: var(--surface-muted); margin: 8px 0 2px; line-height: 1.7; border-left: 2px solid var(--palette-border); padding-left: 8px; }
.rd-note-text { font-size: var(--text-sm); color: var(--surface-text); margin: 4px 0 0; line-height: 1.7; }
.rd-note-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.rd-spacer { flex: 1; }
.rd-pushed { font-size: var(--text-xs); color: var(--palette-primary); }
@media (max-width: 1180px) {
  .rd-reader-grid { grid-template-columns: 1fr; }
}

/* ---- 本地电子书：拖放区 / 视图切换 / 封面预览 ---- */
.rd-files { display: flex; gap: var(--space-2); align-items: stretch; flex-wrap: wrap; }
.rd-drop {
  flex: 1 1 320px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px; border: 1px dashed var(--palette-border);
  border-radius: var(--radius-lg); background: var(--surface-raised);
  font-size: var(--text-sm); color: var(--surface-text); transition: background .15s, border-color .15s;
}
.rd-drop-on { border-color: var(--palette-primary); background: var(--palette-soft); }
.rd-drop-icon { font-size: 18px; color: var(--palette-primary); }
.rd-drop .rd-hint { flex-basis: 100%; }
.rd-file-actions { display: flex; flex-direction: column; gap: 6px; justify-content: center; }
/* 主题页：横向排「选择电子书」+「手写书名」两组，避免被挤成窄列 */
.rd-file-actions-theme { flex: 1 1 320px; flex-direction: row; flex-wrap: wrap; align-items: center; }
.rd-theme-book-add { display: inline-flex; gap: 6px; flex: 1 1 240px; align-items: center; }
.rd-theme-book-add .rd-input { flex: 1 1 160px; min-width: 0; }
.rd-viewmode { display: inline-flex; gap: 4px; }
.rd-mode-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.rd-chip-file { background: var(--surface-panel); color: var(--surface-muted); }
.rd-book-missing, .rd-card-missing { opacity: .62; }
/* 双击即读：书行与卡片整块可双击，动作区里的按钮除外（已 stop） */
.rd-book, .rd-card { cursor: default; }
.rd-dbl-tip { color: var(--surface-muted); }
/* 封面按书封 2:3 固定比例，别再跟着行高拉伸成窄条 */
.rd-cover { position: relative; overflow: hidden; width: 52px; flex: 0 0 52px; align-self: center; aspect-ratio: 2 / 3; border-radius: 4px; box-shadow: 0 1px 3px rgba(0, 0, 0, .14); }
.rd-cover-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.rd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: var(--space-3); }
.rd-card { display: flex; flex-direction: column; border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); overflow: hidden; }
/* 卡片封面同样是书封 2:3：3:4 会左右各裁掉约一成，同一本书在两个视图里形状不一 */
.rd-card-cover { position: relative; aspect-ratio: 2 / 3; display: grid; place-items: center; overflow: hidden; }
.rd-card-img { width: 100%; height: 100%; object-fit: cover; }
/* 无封面占位：印完整书名（V3.13），按字数分级字号由行内 style 给，这里只管排版 */
.rd-card-initial { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; padding: 16px 12px; text-align: center; font-weight: 400; letter-spacing: .5px; color: rgba(255,255,255,.92); text-shadow: 0 1px 6px rgba(0,0,0,.22); word-break: break-word; overflow: hidden; }
.rd-card-format { position: absolute; top: 6px; right: 6px; padding: 1px 7px; border-radius: 999px; font-size: var(--text-xs); background: rgba(255,255,255,.88); color: #3a3a3a; }
.rd-card-body { display: flex; flex-direction: column; gap: 4px; padding: 10px; }
.rd-card-title { font-size: var(--text-body); color: var(--surface-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-card-actions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
/* 封面墙：只摆封面，书名 / 作者 / 进度悬停浮出（2026-11-15） */
.rd-wall { display: grid; grid-template-columns: repeat(auto-fill, 120px); gap: 20px 18px; padding: 12px 4px 6px; justify-content: start; }
.rd-spine { position: relative; cursor: grab; }
.rd-spine:active { cursor: grabbing; }
.rd-spine-box {
  position: relative; display: block; width: 100%; aspect-ratio: 2 / 3; overflow: hidden;
  border-radius: 4px; box-shadow: 0 2px 6px rgba(0, 0, 0, .16), 0 1px 2px rgba(0, 0, 0, .12);
  transition: transform .16s ease, box-shadow .16s ease;
}
.rd-spine:hover .rd-spine-box { transform: translateY(-3px); box-shadow: 0 8px 18px rgba(0, 0, 0, .22), 0 2px 4px rgba(0, 0, 0, .14); }
.rd-spine-on .rd-spine-box { outline: 2px solid var(--palette-primary); outline-offset: 2px; }
.rd-spine.rd-book-over .rd-spine-box { outline: 2px solid var(--palette-accent); outline-offset: 2px; }
.rd-spine-img { display: block; width: 100%; height: 100%; object-fit: cover; }
.rd-spine-initial { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 12px 8px; text-align: center; font-weight: 400; letter-spacing: .4px; color: rgba(255, 255, 255, .94); text-shadow: 0 1px 5px rgba(0, 0, 0, .24); word-break: break-word; overflow: hidden; }
.rd-spine-badge { position: absolute; left: 4px; bottom: 4px; padding: 1px 6px; border-radius: 999px; font-size: 10px; background: var(--state-warn); color: #fff; }
.rd-spine-tip {
  position: absolute; left: 50%; top: calc(100% + 6px); z-index: 3;
  transform: translateX(-50%) translateY(-2px);
  display: flex; flex-direction: column; gap: 1px; max-width: 210px;
  padding: 6px 9px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); box-shadow: 0 6px 16px rgba(0, 0, 0, .16);
  opacity: 0; pointer-events: none; transition: opacity .14s ease, transform .14s ease;
}
.rd-spine:hover .rd-spine-tip { opacity: 1; transform: translateX(-50%) translateY(0); }
.rd-spine-name { font-size: var(--text-xs); color: var(--surface-text); max-width: 190px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rd-spine-sub { font-size: 10px; color: var(--surface-muted); max-width: 190px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 1180px) {
  .rd-wall { grid-template-columns: repeat(auto-fill, 88px); gap: 14px 12px; }
}
@media (max-width: 1180px) {
  .rd-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
}

/* ---- 书架整理：搜索 / 排序 / 拖动 / 编辑弹窗（2026-11-14；V3.14 搜索与排序并进页签行） ---- */
.rd-sort { display: inline-flex; gap: 4px; }
/* V3.5 分组标签条 / 收藏星标：标签条独立成行，别把上面的搜索与排序挤换行 */
.rd-groups { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 0 10px; margin-bottom: 10px; border-bottom: 0.5px solid var(--surface-border); }
.rd-gchip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-raised); color: var(--surface-muted); font-size: var(--text-xs); cursor: pointer; white-space: nowrap; }
.rd-gchip:hover { border-color: var(--palette-primary); }
.rd-gchip-on { background: var(--palette-primary); border-color: var(--palette-primary); color: #fff; }
.rd-gcount { font-size: var(--text-xs); opacity: .72; }
.rd-gchip-on .rd-gcount { color: #fff; opacity: .85; }
/* P2-1 虚拟书架：筛选态本身也是一枚 chip，带一个取消按钮 */
.rd-shelfchip { gap: 4px; padding-right: 4px; }
.rd-shelfchip-x {
  border: 0; background: transparent; color: #fff; cursor: pointer;
  font-size: var(--text-xs); line-height: 1; padding: 0 3px; opacity: .85;
}
.rd-gnew { flex: 0 1 150px; min-width: 96px; }
.rd-gsel { min-width: 0; }
.rd-fav { min-width: 26px; color: var(--surface-muted); }
.rd-fav-on { color: #d99a17; font-weight: 700; }
.rd-card-fav { position: absolute; top: 6px; right: 6px; z-index: 1; width: 26px; height: 26px; border: 0.5px solid var(--surface-border); border-radius: 50%; background: rgba(255,255,255,.88); color: var(--surface-muted); font-size: 14px; line-height: 1; cursor: pointer; padding: 0; }
.rd-card-fav.rd-fav-on { color: #d99a17; }
/* 拖动手柄：只在「手动排序 + 没在搜索」时出现——两种状态下顺序都不该被改动 */
.rd-grip { flex: 0 0 auto; color: var(--surface-muted); font-size: var(--text-xs); letter-spacing: -1px; cursor: grab; user-select: none; opacity: .55; }
.rd-book { cursor: grab; }
.rd-book:active { cursor: grabbing; }
.rd-card { cursor: grab; }
.rd-book-drag { opacity: .45; }
.rd-book-over { border-color: var(--palette-accent); box-shadow: 0 0 0 1px var(--palette-accent) inset; }
.rd-since { color: var(--palette-primary); }
/* 编辑弹窗：铺在本视图内的居中卡片，不新开窗口、不遮整窗 */
.rd-modal { position: fixed; inset: 0; z-index: var(--z-overlay); display: grid; place-items: center; background: rgba(0, 0, 0, .28); padding: var(--space-4); }
.rd-modal-box { width: min(460px, 100%); padding: var(--space-3); border: 0.5px solid var(--palette-border); border-radius: var(--radius-lg); background: var(--surface-raised); box-shadow: 0 12px 32px rgba(0, 0, 0, .18); }
.rd-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: var(--space-2); }
.rd-modal-title { font-size: var(--text-h2); margin: 0; color: var(--surface-text); }
.rd-modal-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.rd-modal-label { flex: 0 0 46px; font-size: var(--text-sm); color: var(--surface-muted); }
.rd-modal-row .rd-input { flex: 1; }
.rd-modal-btns { display: inline-flex; gap: 6px; flex-wrap: wrap; align-items: center; }
/* 换完立刻能看见：不然点完一张候选，界面上什么反馈都没有（弹窗还盖着书架） */
.rd-cover-prev { width: 30px; height: 45px; object-fit: cover; border-radius: 3px; box-shadow: 0 1px 3px rgba(0, 0, 0, .18); }
/* 豆瓣候选：三列小封面，一屏放得下 6 张；点哪张用哪张，选中前不改库里任何东西 */
.rd-douban { margin: 2px 0 10px; padding: 8px 10px; border: 0.5px dashed var(--palette-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.rd-douban .rd-hint { margin: 0 0 6px; }
.rd-douban-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.rd-douban-item { display: flex; flex-direction: column; gap: 3px; padding: 6px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); cursor: pointer; text-align: left; }
.rd-douban-item:hover { border-color: var(--palette-primary); background: var(--palette-soft); }
/* 已套用那张：勾边 + 左上角对勾，套完不消失，方便接着换 */
.rd-douban-item-on { border-color: var(--palette-primary); box-shadow: inset 0 0 0 1px var(--palette-primary); position: relative; }
.rd-douban-item-on::after { content: '✓'; position: absolute; top: 4px; right: 6px; font-size: 12px; line-height: 1; padding: 1px 4px; border-radius: 999px; color: #fff; background: var(--palette-primary); }
.rd-douban-img { display: grid; place-items: center; width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 3px; background: var(--surface-panel); }
.rd-douban-nocover { font-size: var(--text-xs); color: var(--surface-muted); }
.rd-douban-name { font-size: var(--text-xs); color: var(--surface-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-douban-sub { font-size: 10px; color: var(--surface-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 弹窗底部：次要操作自成一行，取消/保存固定右下——七个按钮硬塞一行时「保存」会被挤到
   下一行最左边，看着像另一个区块的按钮 */
.rd-modal-acts { display: flex; flex-direction: column; gap: 8px; margin-top: var(--space-2); padding-top: var(--space-2); border-top: 0.5px solid var(--surface-border); }
.rd-acts-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rd-acts-main { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
</style>
