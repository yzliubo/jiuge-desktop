<script setup lang="ts">
// 图书馆：休闲娱乐阅读 / 主题阅读 / 读书笔记（数据库）。
// 三条硬口径（docs/13）：
//   1. 主题阅读书单权威源是 md_growth，本页只读，翻页转发 growth.advanceBook——绝不建第二份书单；
//   2. 两类阅读的笔记统一进 md_reading.notes，即「读书笔记」数据库；
//   3. 笔记写进九格只能追加、必须带出处，且补记态不许冒充当天。
// 类名一律 rd- 前缀：项目里 .cell / .heat-cell 都因撞名炸过真 GUI 断言。
import { computed, onMounted, ref } from 'vue';
import type { DiaryRecord } from '../types';
import { callDomain } from '../composables/useDomain';
import { saveExport, listDiaries, upsertDiary, pickBookFiles, pathForFile, openReader } from '../bridge';

interface BookRow {
  id: string; title: string; author: string; total: number; done: number;
  unit: string; status: string; pct: number; progressText: string;
  statusLabel: string; noteCount: number; note: string; coverColor: string;
  filePath: string; fileExt: string; fileSize: number; format: string;
  coverId: string; source: string; hasFile: boolean;
  fileMissing?: boolean; fileSizeText?: string;
}
interface ThemeBook {
  themeId: string; themeTitle: string; bookId: string; title: string; author: string;
  total: number; done: number; unit: string; status: string; pct: number; quoteCount: number;
}
interface NoteRow {
  id: string; mode: string; bookId: string; themeId: string; bookTitle: string;
  type: string; quote: string; text: string; page: number; tags: string[];
  chapterId: string; createdAt: number; pushedAt: number; pushedCell: string;
  typeLabel?: string; modeLabel?: string; pushed?: boolean; orphan?: boolean;
}
interface ChapterRow { id: string; bookId: string; title: string; parentId: string; order: number }
interface Stats {
  books: number; notes: number; highlights: number; ideas: number; pushed: number;
  leisureNotes: number; themeNotes: number; tagCount: number; thisMonth: number;
}
interface BoardData {
  stats: Stats; books: BookRow[]; themeBooks: ThemeBook[];
  recent: NoteRow[]; tagTop: Array<{ tag: string; count: number }>;
}
interface NotesResult {
  items: NoteRow[]; total: number;
  byTag: Array<{ tag: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  byMonth: Array<{ month: string; count: number }>;
}
interface ActiveBook {
  mode: 'leisure' | 'theme'; bookId: string; themeId: string; title: string; total: number; done: number;
}

const props = defineProps<{ record: DiaryRecord; today: string; backfill?: boolean }>();
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

// 休闲娱乐：加书
const newTitle = ref('');
const newAuthor = ref('');
const newTotal = ref('300');
// 章节大纲（本地两层树，不是 AI 生成的思维导图）
const newChapter = ref('');
// 笔记表单：摘录 + 自己的话 + 页码 + #tag
const noteType = ref('highlight');
const noteQuote = ref('');
const noteText = ref('');
const notePage = ref('');
const noteTags = ref('');
// 即时想法：回车即存，同时进读书笔记与九格
const flash = ref('');
const flashCell = ref('free');
// 读书笔记库筛选
const kw = ref('');
const fMode = ref('');
const fType = ref('');
const fTag = ref('');

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
  books: 0, notes: 0, highlights: 0, ideas: 0, pushed: 0,
  leisureNotes: 0, themeNotes: 0, tagCount: 0, thisMonth: 0
});
const books = computed<BookRow[]>(() => board.value?.books || []);
const themeBooks = computed<ThemeBook[]>(() => board.value?.themeBooks || []);
const themeGroups = computed(() => {
  const map = new Map<string, { title: string; rows: ThemeBook[] }>();
  themeBooks.value.forEach((b) => {
    const g = map.get(b.themeId) || { title: b.themeTitle, rows: [] };
    g.rows.push(b);
    map.set(b.themeId, g);
  });
  return Array.from(map.entries()).map(([id, g]) => ({ id, title: g.title, rows: g.rows }));
});
const tagTop = computed(() => board.value?.tagTop || []);
const activeChapters = computed(() => {
  if (!active.value || active.value.mode !== 'leisure') return [];
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
  const raw = await callDomain<{ chapters?: ChapterRow[] } | null>('reading.read', null);
  chapters.value = raw?.chapters || [];
  await loadNotes();
  await loadCovers();
}

async function reload(): Promise<void> {
  await load();
  emit('changed');
}

// ---- 本地电子书：拖放 / 点击选择 / 两种陈列 ----
// 只登记绝对路径，不把书的内容搬进库；封面是主进程读 EPUB 后落盘、按需转 dataURL 回传。
const VIEW_KEY = 'jiuge.reading.viewMode';
const viewMode = ref<'list' | 'grid'>('list');
const dragOver = ref(false);
const importing = ref(false);
const coverMap = ref<Record<string, string>>({});

function setViewMode(m: 'list' | 'grid'): void {
  viewMode.value = m;
  try { localStorage.setItem(VIEW_KEY, m); } catch { /* 隐私模式下只在本轮生效 */ }
  if (m === 'grid') void loadCovers();
}

async function loadCovers(): Promise<void> {
  const rows = books.value.filter((b) => b.coverId && !coverMap.value[b.id]);
  await Promise.all(rows.map(async (b) => {
    const url = await callDomain<string>('reading.cover', '', b.id);
    if (url) coverMap.value = { ...coverMap.value, [b.id]: url };
  }));
}
function coverOf(b: BookRow): string { return coverMap.value[b.id] || ''; }
function initialOf(b: BookRow): string { return (b.title || '书').slice(0, 1); }
function coverHue(b: BookRow): string {
  let h = 0;
  for (let i = 0; i < b.title.length; i += 1) h = (h * 31 + b.title.charCodeAt(i)) % 360;
  return 'linear-gradient(150deg, hsl(' + h + ',28%,84%), hsl(' + ((h + 40) % 360) + ',26%,68%))';
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
async function addPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  importing.value = true;
  try {
    const r = await callDomain<{ added: number; skipped: number; errors: string[] } | null>('reading.addFiles', null, paths);
    await reload();
    await loadCovers();
    const err = r?.errors?.[0];
    say(r?.added
      ? '已放入 ' + r.added + ' 本' + (r.skipped ? '，跳过重复 ' + r.skipped + ' 本' : '')
      : (err || '没有可添加的书'));
  } finally { importing.value = false; }
}
async function openInReader(b: BookRow): Promise<void> {
  // 独立阅读窗口（目录 / 正文 / 笔记三栏）；书架留在主窗口，两窗口可并排
  const r = await openReader(b.id, 'leisure');
  if (!r.ok) say(r.reason || '这本书打不开');
  else if (r.reused) say('这本书的阅读窗口已经开着');
}
function startBook(b: BookRow): void {
  // 有本机文件 → 独立阅读窗口；手工登记的书没有正文可读，仍用中栏批注面板
  if (b.filePath) { void openInReader(b); return; }
  openBook('leisure', b);
  say('这本是手工登记，没有本机电子书；可直接在中栏记笔记');
}
async function revealFile(b: BookRow): Promise<void> {
  await callDomain<unknown>('reading.revealBook', null, b.id);
}

function say(text: string): void { emit('notify', text); }

// ---- 休闲娱乐阅读：自建书单 ----
async function addBook(): Promise<void> {
  const title = newTitle.value.trim();
  if (!title) { say('先写书名'); return; }
  await callDomain<unknown>('reading.addBook', null, {
    title, author: newAuthor.value.trim(), total: Number(newTotal.value) || 300, unit: '页'
  });
  newTitle.value = ''; newAuthor.value = ''; newTotal.value = '300';
  await reload();
  say('已放上书架');
}

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

// ---- 主题阅读：只读 md_growth，翻页转发 ----
async function advanceTheme(themeId: string, bookId: string, delta: number): Promise<void> {
  await callDomain<unknown>('reading.themeAdvance', null, themeId, bookId, delta);
  await reload();
}

function openBook(mode: 'leisure' | 'theme', row: BookRow | ThemeBook): void {
  const b = row as ThemeBook;
  active.value = {
    mode,
    bookId: mode === 'leisure' ? (row as BookRow).id : b.bookId,
    themeId: mode === 'theme' ? b.themeId : '',
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
  await callDomain<unknown>('reading.addChapter', null, active.value.bookId, { title });
  newChapter.value = '';
  await reload();
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
  // 唯一的写入形态：追加。绝不覆盖（那会抹掉用户今天写过的话）
  base.cells[target] = old ? old + '\n' + line : line;
  await upsertDiary(base, 'reading-' + target + '-' + Date.now());
  emit('changed');
  return target;
}

const CELL_LABEL: Record<string, string> = {
  free: '自由记录', growth: '学习成长', work: '工作推进', leisure: '休闲娱乐'
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
  // 即时想法：一键同时进数据库与九格，不要求用户再点一次「→ 九格」
  const line = await callDomain<string>('reading.diaryLine', '', Object.assign({}, patch, { tags: ['闪念'] }));
  const cell = await appendLine(flashCell.value, line || text);
  flash.value = '';
  const q = await callDomain<NotesResult | null>('reading.notes', null, { keyword: text });
  const hit = q?.items?.find((n) => n.text === text && !n.pushedAt);
  if (hit) await callDomain<unknown>('reading.markPushed', null, hit.id, cell, Date.now());
  await reload();
  say('闪念已进读书笔记，并写进九格「' + (CELL_LABEL[cell] || cell) + '」');
}

async function removeNote(id: string): Promise<void> {
  await callDomain<unknown>('reading.removeNote', null, id);
  await reload();
}

async function importQuotes(): Promise<void> {
  const r = await callDomain<{ added: number } | null>('reading.importGrowthQuotes', null);
  await reload();
  say(r?.added ? '已汇总学习成长里的旧摘录 ' + r.added + ' 条' : '没有需要补进来的旧摘录');
}

async function exportNotes(): Promise<void> {
  const text = await callDomain<string>('reading.exportMd', '');
  const receipt = await saveExport('读书笔记-' + props.today + '.md', text);
  say(receipt?.path ? '已导出：' + receipt.path : '已取消导出');
}

async function applyFilter(): Promise<void> { await loadNotes(); }
function pickTag(t: string): void { fTag.value = fTag.value === t ? '' : t; void loadNotes(); }

onMounted(() => {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'grid' || saved === 'list') viewMode.value = saved;
  } catch { /* 读不出偏好就用详细列表 */ }
  void load();
});
</script>

<template>
  <section class="rd-view" aria-label="图书馆">
    <header class="rd-head">
      <button class="rd-back" @click="emit('back')">← 返回九格</button>
      <h1 class="rd-title">图书馆</h1>
      <p class="rd-sub">两类阅读 · 笔记贴着原文长 · 汇总进「读书笔记」</p>
      <div class="rd-stats" aria-label="读书笔记统计">
        <span class="rd-stat"><b>{{ stats.books }}</b> 本休闲书</span>
        <span class="rd-stat"><b>{{ stats.notes }}</b> 条笔记</span>
        <span class="rd-stat"><b>{{ stats.pushed }}</b> 条已入九格</span>
        <span class="rd-stat"><b>{{ stats.thisMonth }}</b> 条本月</span>
      </div>
    </header>

    <nav class="rd-tabs" aria-label="图书馆分区">
      <button class="rd-tab" :class="{ 'rd-tab-on': tab === 'shelf' }" :aria-pressed="tab === 'shelf'" @click="tab = 'shelf'">休闲娱乐阅读</button>
      <button class="rd-tab" :class="{ 'rd-tab-on': tab === 'theme' }" :aria-pressed="tab === 'theme'" @click="tab = 'theme'">主题阅读</button>
      <button class="rd-tab" :class="{ 'rd-tab-on': tab === 'notes' }" :aria-pressed="tab === 'notes'" @click="tab = 'notes'">读书笔记 · 数据库</button>
    </nav>

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
          </span>
        </div>
      </div>

      <div class="rd-add">
        <input v-model="newTitle" class="rd-input rd-name" placeholder="书名" aria-label="书名" @keyup.enter="addBook" />
        <input v-model="newAuthor" class="rd-input" placeholder="作者（可不填）" aria-label="作者" />
        <input v-model="newTotal" class="rd-input rd-num" type="number" min="1" placeholder="页数" aria-label="总页数" />
        <button class="rd-primary" @click="addBook">＋ 放上书架</button>
      </div>

      <div v-if="!books.length" class="rd-empty">书架还空着。可以拖一本本电脑里的电子书进来，也可以手写书名建一条。</div>
      <div v-if="viewMode === 'list'" class="rd-shelf" aria-label="详细列表">
        <article v-for="b in books" :key="b.id" class="rd-book" :class="{ 'rd-book-on': active?.bookId === b.id, 'rd-book-missing': b.fileMissing }"
          :title="'双击直接翻开《' + b.title + '》'" @dblclick="startBook(b)">
          <span class="rd-cover" :style="{ background: b.coverColor || coverHue(b) }" aria-hidden="true">
            <img v-if="coverOf(b)" :src="coverOf(b)" :alt="b.title + ' 封面'" class="rd-cover-img" />
          </span>
          <div class="rd-book-main">
            <div class="rd-book-line">
              <strong class="rd-book-title">《{{ b.title }}》</strong><span class="rd-author">{{ b.author }}</span>
              <span v-if="b.format" class="rd-chip rd-chip-file">{{ b.format }}</span>
              <span class="rd-chip">{{ b.statusLabel }}</span>
              <span v-if="b.fileMissing" class="rd-chip rd-chip-warn">原文件已不在原处</span>
            </div>
            <div class="rd-thick" role="progressbar" :aria-valuenow="b.pct" aria-valuemin="0" aria-valuemax="100" :aria-label="b.title + ' 已读进度'">
              <span class="rd-thick-in" :style="{ width: b.pct + '%' }"></span>
            </div>
            <p class="rd-meta">已读 {{ b.progressText }} · 还剩 {{ Math.max(0, b.total - b.done) }} {{ b.unit }} · {{ b.noteCount }} 条笔记<span v-if="b.filePath"> · {{ b.fileSizeText }}</span><span v-if="b.filePath" class="rd-dbl-tip"> · 双击即读</span></p>
            <p v-if="b.filePath" class="rd-meta rd-path" :title="b.filePath">{{ b.filePath }}</p>
          </div>
          <div class="rd-book-actions" @dblclick.stop>
            <button class="rd-mini" @click="advanceLeisure(b.id, 10)">+10 {{ b.unit }}</button>
            <button class="rd-mini" :title="b.filePath ? '在独立阅读窗口打开：目录 / 正文 / 笔记三栏' : '手工登记的书，在中栏记笔记'" @click="startBook(b)">翻开读</button>
            <button v-if="b.filePath" class="rd-mini rd-mini-quiet" @click="revealFile(b)">定位</button>
            <button class="rd-mini rd-mini-quiet" @click="removeBook(b.id)">移出</button>
          </div>
        </article>
      </div>
      <div v-else class="rd-grid" aria-label="封面预览">
        <article v-for="b in books" :key="b.id" class="rd-card" :class="{ 'rd-card-missing': b.fileMissing }"
          :title="'双击直接翻开《' + b.title + '》'" @dblclick="startBook(b)">
          <div class="rd-card-cover" :style="{ background: coverHue(b) }">
            <img v-if="coverOf(b)" :src="coverOf(b)" :alt="b.title + ' 封面'" class="rd-card-img" />
            <span v-else class="rd-card-initial" aria-hidden="true">{{ initialOf(b) }}</span>
            <span v-if="b.format" class="rd-card-format">{{ b.format }}</span>
          </div>
          <div class="rd-card-body">
            <strong class="rd-card-title" :title="b.title">{{ b.title }}</strong>
            <span class="rd-hint">{{ b.author || '未记作者' }}<template v-if="b.fileSizeText"> · {{ b.fileSizeText }}</template></span>
            <span class="rd-meta">{{ b.progressText }} · {{ b.statusLabel }} · {{ b.noteCount }} 条笔记</span>
            <span v-if="b.fileMissing" class="rd-chip rd-chip-warn">原文件已不在原处</span>
            <div class="rd-card-actions" @dblclick.stop>
              <button class="rd-mini" :title="b.filePath ? '在独立阅读窗口打开：目录 / 正文 / 笔记三栏' : '手工登记的书，在中栏记笔记'" @click="startBook(b)">翻开读</button>
              <button class="rd-mini rd-mini-quiet" @click="removeBook(b.id)">移出</button>
            </div>
          </div>
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
                <button class="rd-x" :aria-label="'删除章节 ' + c.title" @click="removeChapter(c.id)">×</button>
              </p>
              <p v-if="!activeChapters.length" class="rd-hint">还没分章。读到哪儿顺手记一个章节名即可。</p>
            </div>
            <div class="rd-inline-add">
              <input v-model="newChapter" class="rd-input" placeholder="加一个章节" aria-label="新章节名" @keyup.enter="addChapter" />
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
    </div>

    <!-- ============ 主题阅读（书单只读 md_growth） ============ -->
    <div v-else-if="tab === 'theme'" class="rd-pane">
      <div class="rd-notice">
        <span>主题与书单仍由「学习成长」维护，这里只读并负责阅读与批注——同一份书单不存两份。</span>
        <button class="rd-mini" @click="emit('open-cell', 'growth')">去学习成长维护书单</button>
      </div>
      <div v-if="!themeGroups.length" class="rd-empty">学习成长里还没有主题书单。先去那边建一个主题，再回来读。</div>
      <section v-for="g in themeGroups" :key="g.id" class="rd-group">
        <h2 class="rd-h2">{{ g.title }} <span class="rd-hint">{{ g.rows.length }} 本</span></h2>
        <article v-for="b in g.rows" :key="b.bookId" class="rd-book" :class="{ 'rd-book-on': active?.bookId === b.bookId }"
          :title="'双击翻开《' + b.title + '》'" @dblclick="openBook('theme', b)">
          <div class="rd-book-main">
            <div class="rd-book-line"><strong class="rd-book-title">《{{ b.title }}》</strong><span class="rd-author">{{ b.author }}</span><span class="rd-chip">{{ b.pct }}%</span></div>
            <div class="rd-thick" role="progressbar" :aria-valuenow="b.pct" aria-valuemin="0" aria-valuemax="100" :aria-label="b.title + ' 已读进度'">
              <span class="rd-thick-in" :style="{ width: b.pct + '%' }"></span>
            </div>
            <p class="rd-meta">{{ b.done }} / {{ b.total }} {{ b.unit }} · 原有摘录 {{ b.quoteCount }} 条</p>
          </div>
          <div class="rd-book-actions">
            <button class="rd-mini" @click="advanceTheme(b.themeId, b.bookId, 10)">+10 {{ b.unit }}</button>
            <button class="rd-mini" @click="openBook('theme', b)">翻开读</button>
          </div>
        </article>
      </section>

      <div v-if="active && active.mode === 'theme'" class="rd-reader" aria-label="主题阅读器">
        <h2 class="rd-h2">正在读《{{ active.title }}》<span class="rd-hint"> · 主题阅读</span></h2>
        <div class="rd-prompts" aria-label="伴读三问">
          <button v-for="p in PROMPTS" :key="p.id" class="rd-prompt" :class="{ 'rd-prompt-on': activePrompt === p.id }" :title="p.hint" @click="pickPrompt(p)">{{ p.label }}</button>
        </div>
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
          <input v-model="flash" class="rd-input" placeholder="即时想法：回车即存进九格" aria-label="即时想法" @keyup.enter="saveFlash" />
          <button class="rd-mini" @click="saveFlash">闪念入格</button>
        </div>
      </div>
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
.rd-back { border: 0; background: transparent; color: var(--palette-primary); font-size: 12px; padding: 0; cursor: pointer; }
.rd-title { font-size: 20px; margin: 6px 0 2px; color: var(--surface-text); }
.rd-sub { font-size: 12px; color: var(--surface-muted); margin: 0; }
.rd-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-top: var(--space-2); }
.rd-stat { font-size: 11px; color: var(--surface-muted); padding: 3px 10px; border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-raised); }
.rd-stat b { font-size: 13px; color: var(--surface-text); margin-right: 2px; }
.rd-tabs { display: flex; gap: 6px; border-bottom: 0.5px solid var(--surface-border); padding-bottom: 8px; }
.rd-tab { padding: 6px 14px; font-size: 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--surface-text); cursor: pointer; }
.rd-tab-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.rd-pane { display: flex; flex-direction: column; gap: var(--space-2); }
.rd-add, .rd-filter, .rd-form-row, .rd-flash, .rd-inline-add { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.rd-input { padding: 6px 9px; font-size: 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--surface-text); min-width: 0; }
.rd-name { flex: 1 1 180px; }
.rd-num { width: 74px; }
.rd-sel { width: auto; }
.rd-area { width: 100%; padding: 8px 10px; font-size: 12px; line-height: 1.6; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--surface-text); resize: vertical; font-family: inherit; }
.rd-primary { padding: 6px 14px; font-size: 12px; border: 0.5px solid var(--palette-primary); border-radius: var(--radius-md); background: var(--palette-primary); color: var(--palette-on); cursor: pointer; }
.rd-mini { padding: 4px 9px; font-size: 11px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); color: var(--surface-text); cursor: pointer; white-space: nowrap; }
.rd-mini:hover { border-color: var(--palette-border); }
.rd-mini-quiet { color: var(--surface-muted); }
.rd-empty, .rd-notice { font-size: 12px; color: var(--surface-muted); padding: 12px; border: 0.5px dashed var(--surface-border); border-radius: var(--radius-md); line-height: 1.7; }
.rd-notice { display: flex; align-items: center; gap: 10px; justify-content: space-between; border-style: solid; background: var(--palette-soft); }
.rd-shelf { display: flex; flex-direction: column; gap: 8px; }
.rd-book { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); }
.rd-book-on { border-color: var(--palette-primary); background: var(--palette-soft); }
.rd-cover { width: 10px; align-self: stretch; border-radius: 3px; flex: 0 0 auto; }
.rd-book-main { flex: 1; min-width: 0; }
.rd-book-line { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rd-book-title { font-size: 13px; color: var(--surface-text); }
.rd-author, .rd-meta, .rd-hint { font-size: 11px; color: var(--surface-muted); margin: 0; }
.rd-chip { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--palette-soft); color: var(--palette-primary); }
.rd-chip-soft { background: var(--surface-panel); color: var(--surface-muted); }
.rd-chip-warn { background: var(--state-warn-soft); color: var(--state-warn); }
.rd-thick { height: 6px; border-radius: 999px; background: var(--surface-panel); overflow: hidden; margin: 6px 0 3px; }
.rd-thick-in { display: block; height: 100%; border-radius: 999px; background: var(--palette-accent); transition: width .2s; }
.rd-book-actions { display: flex; gap: 4px; flex: 0 0 auto; }
.rd-reader { margin-top: var(--space-2); padding: var(--space-3); border: 0.5px solid var(--palette-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.rd-h2 { font-size: 14px; margin: 0 0 var(--space-2); color: var(--surface-text); }
.rd-h3 { font-size: 12px; margin: 0 0 6px; color: var(--surface-muted); }
.rd-reader-grid { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: var(--space-3); }
.rd-col { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.rd-chapters { min-height: 60px; max-height: 170px; overflow: auto; }
.rd-chapter { font-size: 12px; margin: 0 0 4px; color: var(--surface-text); }
.rd-chapter-sub { padding-left: 12px; color: var(--surface-muted); }
.rd-x { border: 0; background: transparent; color: var(--surface-muted); cursor: pointer; }
.rd-prompts { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.rd-prompt { padding: 4px 9px; font-size: 11px; border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-raised); color: var(--surface-text); cursor: pointer; }
.rd-prompt-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.rd-flash { margin-top: 4px; padding-top: 8px; border-top: 0.5px dashed var(--surface-border); }
.rd-warn { font-size: 11px; color: var(--state-warn); margin: 0; }
.rd-notes-inline { margin-top: var(--space-2); padding-top: var(--space-2); border-top: 0.5px solid var(--surface-border); }
.rd-note-line { font-size: 12px; margin: 0 0 6px; color: var(--surface-text); line-height: 1.6; }
.rd-group { margin-bottom: var(--space-2); }
.rd-filter { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.rd-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.rd-tag { padding: 3px 9px; font-size: 11px; border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-panel); color: var(--surface-text); cursor: pointer; }
.rd-tag-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.rd-tag span { color: var(--surface-muted); }
.rd-note { padding: 10px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); }
.rd-note-pushed { border-color: var(--palette-border); }
.rd-note-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rd-note-book { font-size: 12px; color: var(--surface-text); }
.rd-note-quote { font-size: 12px; color: var(--surface-muted); margin: 8px 0 2px; line-height: 1.7; border-left: 2px solid var(--palette-border); padding-left: 8px; }
.rd-note-text { font-size: 12px; color: var(--surface-text); margin: 4px 0 0; line-height: 1.7; }
.rd-note-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.rd-spacer { flex: 1; }
.rd-pushed { font-size: 11px; color: var(--palette-primary); }
@media (max-width: 1180px) {
  .rd-reader-grid { grid-template-columns: 1fr; }
  .rd-book-actions { flex-wrap: wrap; }
}

/* ---- 本地电子书：拖放区 / 视图切换 / 封面预览 ---- */
.rd-files { display: flex; gap: var(--space-2); align-items: stretch; flex-wrap: wrap; }
.rd-drop {
  flex: 1 1 320px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px; border: 1px dashed var(--palette-border);
  border-radius: var(--radius-lg); background: var(--surface-raised);
  font-size: 12px; color: var(--surface-text); transition: background .15s, border-color .15s;
}
.rd-drop-on { border-color: var(--palette-primary); background: var(--palette-soft); }
.rd-drop-icon { font-size: 18px; color: var(--palette-primary); }
.rd-drop .rd-hint { flex-basis: 100%; }
.rd-file-actions { display: flex; flex-direction: column; gap: 6px; justify-content: center; }
.rd-viewmode { display: inline-flex; gap: 4px; }
.rd-mode-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.rd-chip-file { background: var(--surface-panel); color: var(--surface-muted); }
.rd-book-missing, .rd-card-missing { opacity: .62; }
/* 双击即读：书行与卡片整块可双击，动作区里的按钮除外（已 stop） */
.rd-book, .rd-card { cursor: default; }
.rd-dbl-tip { color: var(--surface-muted); }
.rd-cover { position: relative; overflow: hidden; width: 30px; flex: 0 0 30px; }
.rd-cover-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.rd-path { opacity: .7; word-break: break-all; }
.rd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: var(--space-3); }
.rd-card { display: flex; flex-direction: column; border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); overflow: hidden; }
.rd-card-cover { position: relative; aspect-ratio: 3 / 4; display: grid; place-items: center; overflow: hidden; }
.rd-card-img { width: 100%; height: 100%; object-fit: cover; }
.rd-card-initial { font-size: 46px; font-weight: 300; color: rgba(255,255,255,.85); text-shadow: 0 1px 6px rgba(0,0,0,.18); }
.rd-card-format { position: absolute; top: 6px; right: 6px; padding: 1px 7px; border-radius: 999px; font-size: 10px; background: rgba(255,255,255,.88); color: #3a3a3a; }
.rd-card-body { display: flex; flex-direction: column; gap: 4px; padding: 10px; }
.rd-card-title { font-size: 13px; color: var(--surface-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-card-actions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
@media (max-width: 1180px) {
  .rd-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
}
</style>
