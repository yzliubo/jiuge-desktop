<script setup lang="ts">
// 工作格主功能：GTD 工作台。
// 与今日页的「工作看板」分工：今日页是当天快面板，这里是跨天清单系统。
// 数据存 md_gtd 单键（主进程仓储），不写日记记录，因此不受 workBoard 的 20 条/天 限制。
//
// 2026-11-09 00:20 主理人要求「借鉴成功助理的样式，分栏分行显示，点任务右栏改详情」：
//   左分栏 = 清单（收件箱/下一步/等待/日程/将来/已完成）+ 项目 + 情境，点一下即筛选；
//   右分行 = 一条任务一行，列对齐（任务 / 情境 / 项目 / 到期），行尾才是操作；
//   点行 = 选中，右栏换成「任务详情」可编辑；每周回顾整块已搬到右栏。
// 这里只留「清单级」的写：捕获、勾选、拆子项、删除；单条详情的长表单在右栏。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { asArray, callDomain } from '../composables/useDomain';
import { localDate, type DiaryRecord } from '../types';
import CellNoteEditor from '../components/CellNoteEditor.vue';
import WorktimeStrip from '../components/WorktimeStrip.vue';

const props = defineProps<{ record: DiaryRecord; selected?: string; tick?: number }>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'notify', text: string): void;
  // 每次清单变更后通知外壳：右栏的详情 / 健康 / 周回顾读的是同一份数据
  (e: 'changed'): void;
  // 选中某条任务：外壳把它传给右栏，右栏据此换成「任务详情」
  (e: 'select-task', id: string): void;
  (e: 'save', record: DiaryRecord): void;
  // 「规则」要跳到设置页维护：本视图不直接改路由，交给外壳
  (e: 'navigate', key: 'settings'): void;
}>();

// 本机时间源回写工作格：主进程已经把行追加进当天记录，这里只把新记录交给外壳落 UI
function onWorktimeWritten(rec: Record<string, unknown>): void {
  emit('save', rec as unknown as DiaryRecord);
}

// 内联状态提示：让软件替用户算天数，而不是让他自己盯日期对今天几号
function daysSince(iso: string): number {
  const a = String(iso || '').split('-');
  if (a.length !== 3) return 0;
  const t = localDate().split('-');
  const x = new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2])).getTime();
  const y = new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2])).getTime();
  return Math.round((y - x) / 86400000);
}

function overdueDays(t: GtdTask): number {
  if (!t.overdue || !t.dueDate) return 0;
  return Math.max(1, daysSince(t.dueDate));
}

function waitDays(t: GtdTask): number {
  const base = t.waitingSince || t.createdAt || 0;
  if (!base) return 0;
  return Math.max(0, Math.floor((Date.now() - base) / 86400000));
}

interface GtdTask {
  id: string; title: string; status: string; context: string; project: string;
  dueDate: string; waitingFor: string; note: string; createdAt: number; doneAt: number;
  parentId?: string;
  waitingSince?: number;
  ageDays?: number; overdue?: boolean; dueToday?: boolean; needWho?: boolean; needDate?: boolean;
  // 子任务树派生字段（board 一次算完，界面不再自己扫全量）
  childTotal?: number; childDone?: number; openChildren?: number;
  hasChildren?: boolean; container?: boolean;
}
interface TreeRow { task: GtdTask; children: GtdTask[]; parentLabel: string }
interface GtdProject {
  id?: string; name: string; outcome?: string; archived?: boolean;
  total: number; done: number; open: number; next: number; waiting: number; stalled: boolean; pct: number;
}
interface GtdContext { name: string; open: number; next: number }
interface GtdStats {
  inbox: number; next: number; waiting: number; scheduled: number; someday: number;
  done7: number; openTotal: number; dueToday: number; overdue: number;
  waitingNoWho: number; scheduledNoDate: number; stalledProjects: number;
  doneThisWeek: number; oldestInbox: number;
  leafNext: number; containerNext: number; parents: number;
}
interface GtdBoard {
  today: string; empty: boolean;
  groups: Record<string, GtdTask[]>;
  projects: GtdProject[]; archivedProjects: GtdProject[]; contexts: GtdContext[]; stats: GtdStats;
  focus?: { items?: Array<{ id: string }> };
  insight: string; note: string;
}

const STATUS_ORDER = ['inbox', 'next', 'waiting', 'scheduled', 'someday', 'done'] as const;
const STATUS_LABEL: Record<string, string> = {
  inbox: '收件箱', next: '下一步', waiting: '等待', scheduled: '日程', someday: '将来也许', done: '已完成'
};
const STATUS_HINT: Record<string, string> = {
  inbox: '先记下来，暂不判断',
  next: '一个能立刻做掉的单一动作，带上下文',
  waiting: '等别人，写清等谁',
  scheduled: '有明确日期，到点才出现',
  someday: '想做但暂不排期',
  done: '最近 7 天做完的，可重开'
};
const PRESET_CONTEXTS = ['@电脑', '@电话', '@外出', '@会议', '@家', '@阅读'];
const CLARIFY_TARGETS = [
  { key: 'next', label: '下一步', hint: '能马上做' },
  { key: 'waiting', label: '等待', hint: '等别人' },
  { key: 'scheduled', label: '日程', hint: '定日期' },
  { key: 'someday', label: '将来也许', hint: '暂不排期' }
];
// 分栏里的清单顺序：与 board 的状态枚举一致，但把「已完成」放最后单独一条
const SIDE_STATUS = ['inbox', 'next', 'waiting', 'scheduled', 'someday'] as const;
const SORTS: Array<{ key: 'auto' | 'due' | 'new'; label: string }> = [
  { key: 'auto', label: '默认' },
  { key: 'due', label: '到期' },
  { key: 'new', label: '新增' }
];

const board = ref<GtdBoard | null>(null);
const tasks = ref<GtdTask[]>([]);
const activeStatus = ref<string>('inbox');
const contextFilter = ref('');
const projectFilter = ref('');
const keyword = ref('');
const sortMode = ref<'auto' | 'due' | 'new'>('auto');

const title = ref('');
const capContext = ref('');
const capProject = ref('');

const clarifyId = ref('');
const clarifyTarget = ref('next');
const clarifyContext = ref('');
const clarifyProject = ref('');
const clarifyDue = ref('');
const clarifyWaiting = ref('');
// 厘清向导：三步问答替代表单。熟练用户点「高级」直接回到原表单。
const clarifyStep = ref(1);
const clarifyMode = ref<'wizard' | 'advanced'>('wizard');
const clarifyTitle = ref('');
const clarifyWhen = ref<'today' | 'date' | 'waiting' | 'later'>('today');

const message = ref('');
let msgTimer: ReturnType<typeof setTimeout> | null = null;

function say(text: string): void {
  message.value = text;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { message.value = ''; }, 2600);
}

const counts = computed(() => {
  const s = board.value ? board.value.stats : null;
  return {
    inbox: s ? s.inbox : 0, next: s ? s.next : 0, waiting: s ? s.waiting : 0,
    scheduled: s ? s.scheduled : 0, someday: s ? s.someday : 0, done: s ? s.done7 : 0
  };
});

// 三道筛选（清单 / 项目 / 情境）是「并且」关系：左栏点项目时不该把情境丢掉
const filtersOn = computed(() => !!(projectFilter.value || contextFilter.value || keyword.value.trim()));

const visible = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  let list = tasks.value.filter(function (t) { return t.status === activeStatus.value; });
  if (projectFilter.value) {
    list = list.filter(function (t) { return t.project === projectFilter.value; });
  }
  if (contextFilter.value) {
    list = list.filter(function (t) { return t.context === contextFilter.value; });
  }
  if (kw) {
    list = list.filter(function (t) {
      return (t.title + ' ' + t.project + ' ' + t.context + ' ' + t.waitingFor + ' ' + t.note)
        .toLowerCase().indexOf(kw) >= 0;
    });
  }
  return list;
});

function cmpItems(a: GtdTask, b: GtdTask): number {
  if (sortMode.value === 'due') {
    // 有日期的排前面、越近越前；没日期的沉底但保持原有新近顺序
    if (!a.dueDate && !b.dueDate) return b.createdAt - a.createdAt;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    return b.createdAt - a.createdAt;
  }
  if (sortMode.value === 'new') return b.createdAt - a.createdAt;
  return 0;
}

const contexts = computed(() => (board.value ? board.value.contexts : []));
const projects = computed(() => (board.value ? board.value.projects : []));

// 项目里还有没收件箱条目时不算「停滞」：那是还没厘清，不是推不动。
// 不区分的话，刚记下的三条会让三个项目一起标红，红色就废了。
const projInbox = computed(() => {
  const map: Record<string, number> = {};
  tasks.value.forEach(function (t) {
    if (t.status === 'inbox' && t.project) map[t.project] = (map[t.project] || 0) + 1;
  });
  return map;
});
function projStalled(p: GtdProject): boolean {
  return p.stalled && !projInbox.value[p.name];
}

// ---------------------------------------------------------------
// 项目 / 情境：分栏里的「＋」与右键菜单
// 这层只维护「名单」：新建一个还没挂任务的项目/情境也得有地方待着；
// 改名会连带改掉任务上的归属字段（在领域层一次落盘，避免两处真相打架）。
// ---------------------------------------------------------------
type SideKind = 'proj' | 'ctx';
const sideAdd = ref<'' | SideKind>('');
const sideDraft = ref('');
const sideEdit = ref<{ kind: SideKind; name: string } | null>(null);
const sideRename = ref('');
const sideMenu = ref<{ kind: SideKind; name: string; x: number; y: number; archived?: boolean } | null>(null);
const showArchived = ref(false);
const archivedProjects = computed<GtdProject[]>(() => (board.value ? board.value.archivedProjects || [] : []));
// 捕获条与厘清向导的候选项：情境用用户维护过的那份名单，项目只给未归档的
const contextOptions = computed<string[]>(() => {
  const list = contexts.value.map(function (c) { return c.name; });
  return list.length ? list : PRESET_CONTEXTS;
});
const projectOptions = computed<string[]>(() => projects.value.map(function (p) { return p.name; }));

// 情境统一带 @：用户敲「手机」也存成 @手机，否则同一个情境会裂成两份
function ctxName(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.charAt(0) === '@' ? s : '@' + s;
}
function editingSide(kind: SideKind, name: string): boolean {
  const e = sideEdit.value;
  return !!e && e.kind === kind && e.name === name;
}

function openSideAdd(kind: SideKind): void {
  sideAdd.value = kind;
  sideDraft.value = '';
  sideMenu.value = null;
  void nextTick(function () {
    const el = document.querySelector('.side-add-in') as HTMLInputElement | null;
    if (el) el.focus();
  });
}
async function commitSideAdd(kind: SideKind): Promise<void> {
  const name = kind === 'ctx' ? ctxName(sideDraft.value) : String(sideDraft.value || '').trim();
  if (!name) { sideAdd.value = ''; return; }
  const had = kind === 'ctx'
    ? contexts.value.some(function (c) { return c.name === name; })
    : projects.value.concat(archivedProjects.value).some(function (p) { return p.name === name; });
  const wasArchived = kind === 'proj' && archivedProjects.value.some(function (p) { return p.name === name; });
  await callDomain(kind === 'ctx' ? 'gtd.contextAdd' : 'gtd.projectAdd', null, name);
  await refresh();
  sideAdd.value = '';
  sideDraft.value = '';
  if (wasArchived) say('已把「' + name + '」从归档里恢复——在归档区里右键也能取消归档');
  else if (had) say('「' + name + '」已经在了，没有重复建');
  else say(kind === 'ctx' ? '已新建情境 ' + name : '已新建项目「' + name + '」');
}

function openSideEdit(kind: SideKind, name: string): void {
  sideMenu.value = null;
  sideEdit.value = { kind: kind, name: name };
  sideRename.value = name;
  void nextTick(function () {
    const el = document.querySelector('.side-edit-in') as HTMLInputElement | null;
    if (el) { el.focus(); el.select(); }
  });
}
async function commitSideRename(): Promise<void> {
  const e = sideEdit.value;
  if (!e) return;
  const next = e.kind === 'ctx' ? ctxName(sideRename.value) : String(sideRename.value || '').trim();
  sideEdit.value = null;
  if (!next || next === e.name) return;
  await callDomain(e.kind === 'ctx' ? 'gtd.contextRename' : 'gtd.projectRename', null, e.name, next);
  await refresh();
  // 筛选挂着的旧名字要跟着换，否则清单一瞬间变空，看着像任务没了
  if (e.kind === 'ctx' && contextFilter.value === e.name) contextFilter.value = next;
  if (e.kind === 'proj' && projectFilter.value === e.name) projectFilter.value = next;
  say('已改名为 ' + next);
}

const SIDE_MENU_W = 176;
function openSideMenu(kind: SideKind, name: string, e: MouseEvent, archived = false): void {
  sideEdit.value = null;
  sideAdd.value = '';
  const x = Math.max(8, Math.min(e.clientX, window.innerWidth - SIDE_MENU_W - 8));
  const y = Math.max(8, Math.min(e.clientY, window.innerHeight - 172));
  sideMenu.value = { kind: kind, name: name, x: x, y: y, archived: archived };
}
function actSideRename(): void {
  const m = sideMenu.value;
  if (!m) return;
  openSideEdit(m.kind, m.name);
}
async function actSideArchive(archived: boolean): Promise<void> {
  const m = sideMenu.value;
  sideMenu.value = null;
  if (!m) return;
  await callDomain('gtd.projectArchive', null, m.name, archived);
  if (archived && projectFilter.value === m.name) projectFilter.value = '';
  await refresh();
  say(archived
    ? '已归档「' + m.name + '」——项目列表和选择器里都不再出现，历史还在'
    : '已取消归档「' + m.name + '」');
}
async function actSideRemove(): Promise<void> {
  const m = sideMenu.value;
  sideMenu.value = null;
  if (!m) return;
  if (m.kind === 'proj') {
    await callDomain('gtd.projectRemove', null, m.name);
    if (projectFilter.value === m.name) projectFilter.value = '';
    await refresh();
    say('已删除项目「' + m.name + '」；名下任务留着，只是不再挂项目');
    return;
  }
  await callDomain('gtd.contextRemove', null, m.name);
  if (contextFilter.value === m.name) contextFilter.value = '';
  await refresh();
  say('已删除情境 ' + m.name + '；挂过它的任务已清空这一栏');
}

// ---------------------------------------------------------------
// 行内改属性：情境 / 项目 / 到期三格点一下弹小面板
// 扫列表时「给这条标个情境」是高频动作，跑到右栏去改比不改还慢。
// ---------------------------------------------------------------
type PickField = 'ctx' | 'proj' | 'due';
const picker = ref<{ id: string; field: PickField; x: number; y: number } | null>(null);
const PICK_W = 216;
const pickerTask = computed<GtdTask | null>(function () {
  const p = picker.value;
  if (!p) return null;
  return tasks.value.filter(function (t) { return t.id === p.id; })[0] || null;
});
function openPicker(t: GtdTask, field: PickField, e: MouseEvent): void {
  if (picker.value && picker.value.id === t.id && picker.value.field === field) {
    picker.value = null;
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  picker.value = {
    id: t.id,
    field: field,
    x: Math.max(8, Math.min(r.left, window.innerWidth - PICK_W - 8)),
    y: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 246)),
  };
  if (props.selected !== t.id) emit('select-task', t.id);
}
function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDate(d);
}
async function pickValue(field: PickField, value: string): Promise<void> {
  const t = pickerTask.value;
  if (!t) return;
  picker.value = null;
  if (field === 'ctx') {
    await callDomain('gtd.update', null, t.id, { context: value });
    await refresh();
    say(value ? '已标上情境 ' + value : '已清掉情境');
    return;
  }
  if (field === 'proj') {
    await callDomain('gtd.update', null, t.id, { project: value });
    await refresh();
    say(value ? '已归到项目「' + value + '」' : '已从项目里移出');
    return;
  }
  await callDomain('gtd.update', null, t.id, { dueDate: value });
  await refresh();
  say(value ? '到期改成 ' + value : '已清掉到期日');
}
function inFocus(id: string): boolean {
  const f = board.value && board.value.focus;
  const items = f && f.items ? f.items : [];
  return items.some(function (x) { return x.id === id; });
}
async function toggleFocusOf(t: GtdTask): Promise<void> {
  const was = inFocus(t.id);
  picker.value = null;
  await callDomain('gtd.focusToggle', null, localDate(), t.id, 'work');
  await refresh();
  say(was ? '已从今日六条移出「' + t.title + '」' : '已加入今日六条——今天先干这几件');
}

const filterText = computed(() => {
  const bits: string[] = [];
  if (projectFilter.value) bits.push('项目「' + projectFilter.value + '」');
  if (contextFilter.value) bits.push('情境 ' + contextFilter.value);
  if (keyword.value.trim()) bits.push('搜索「' + keyword.value.trim() + '」');
  return bits.join(' · ');
});

// --- 子任务树 ---
// 只允许两层：父是容器，子才是能动手的下一步。整棵树在前端组装，
// board 已经给了 childTotal / openChildren，不必再拿全量任务扫一遍。
const allById = computed(() => {
  const map: Record<string, GtdTask> = {};
  tasks.value.forEach(function (t) { map[t.id] = t; });
  return map;
});

const treeRows = computed<TreeRow[]>(function () {
  const list = visible.value.slice().sort(cmpItems);
  const inView: Record<string, boolean> = {};
  list.forEach(function (t) { inView[t.id] = true; });
  const kids: Record<string, GtdTask[]> = {};
  const tops: GtdTask[] = [];
  list.forEach(function (t) {
    if (t.parentId && inView[t.parentId]) {
      (kids[t.parentId] = kids[t.parentId] || []).push(t);
    } else {
      tops.push(t);
    }
  });
  return tops.map(function (t) {
    const children = (kids[t.id] || []).slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
    // 父在别的分组、或被筛选掉时，子项仍要看得见，但要标出它属于谁，
    // 否则树看着像掉了层级
    const parent = t.parentId ? allById.value[t.parentId] : null;
    return { task: t, children: children, parentLabel: parent ? parent.title : '' };
  });
});

// 空态文案：四种「空」含义不同——清单空 / 筛掉 / 已完成没东西 / 收件箱清空，不能共用一句
const emptyHint = computed(() => {
  if (activeStatus.value === 'inbox') return '收件箱是空的——保持这样比做完更重要';
  if (activeStatus.value === 'done') return '最近 7 天没有完成的任务';
  if (filtersOn.value) return '当前筛选下没有条目，清掉筛选看看';
  return '这一组暂时没有条目';
});

const collapsed = ref<Record<string, boolean>>({});
const kidOpen = ref<Record<string, boolean>>({});
const kidDraft = ref<Record<string, string>>({});
const blockedId = ref('');

function kidsShown(id: string): boolean {
  // 默认展开：既然拆了，就该一眼看见拆成什么
  return !collapsed.value[id];
}
function toggleKids(id: string): void {
  collapsed.value = Object.assign({}, collapsed.value, { [id]: !collapsed.value[id] });
}
function canAddChild(t: GtdTask): boolean {
  // 只有「下一步 / 等待」能拆：收件箱是还没想清楚的东西，日程与将来也许是整块的事
  return t.status === 'next' || t.status === 'waiting';
}
function openKidInput(t: GtdTask): void {
  kidOpen.value = Object.assign({}, kidOpen.value, { [t.id]: !kidOpen.value[t.id] });
  // 先建键再绑定，否则 v-model 首次输入会往空对象上写，响应式不一定跟上
  kidDraft.value = Object.assign({}, kidDraft.value, { [t.id]: kidDraft.value[t.id] || '' });
  collapsed.value = Object.assign({}, collapsed.value, { [t.id]: false });
}

async function addChild(parent: GtdTask): Promise<void> {
  const text = (kidDraft.value[parent.id] || '').trim();
  if (!text) return;
  await callDomain('gtd.add', null, { title: text, status: parent.status, parentId: parent.id });
  kidDraft.value = Object.assign({}, kidDraft.value, { [parent.id]: '' });
  kidOpen.value = Object.assign({}, kidOpen.value, { [parent.id]: false });
  await refresh();
  say('已挂到「' + parent.title + '」下——子项才是能动手的那一条');
}

async function detach(t: GtdTask): Promise<void> {
  await callDomain('gtd.update', null, t.id, { parentId: '' });
  await refresh();
  say('「' + t.title + '」已提升为独立任务');
}

async function completeWithKids(t: GtdTask): Promise<void> {
  const n = t.openChildren || 0;
  await callDomain('gtd.completeAll', null, t.id);
  blockedId.value = '';
  await refresh();
  say('父项与 ' + n + ' 个子项已一起完成');
}

// 中栏自己改完清单会喊一声 changed，外壳把 tick 加一后又传回来；
// 这一趟不必再读一遍盘（同一次变更读两次会闪，也会把行内提示冲掉）
let selfBump = 0;

async function load(): Promise<void> {
  const b = await callDomain<GtdBoard | null>('gtd.board', null, localDate());
  if (b && b.groups) {
    board.value = b;
    const flat: GtdTask[] = [];
    Object.keys(b.groups).forEach(function (k) {
      asArray<GtdTask>(b.groups[k]).forEach(function (t) { flat.push(t); });
    });
    tasks.value = flat;
  }
}

async function refresh(): Promise<void> {
  await load();
  selfBump += 1;
  emit('changed');
}

watch(() => props.tick, function () {
  if (selfBump > 0) { selfBump -= 1; return; }
  void load();
});

// 选中：外壳持有唯一一份选中态，中栏与右栏都跟着它走
function select(id: string): void {
  emit('select-task', props.selected === id ? '' : id);
}

function pickStatus(k: string): void {
  activeStatus.value = k;
  blockedId.value = '';
}
function toggleProject(name: string): void {
  projectFilter.value = projectFilter.value === name ? '' : name;
}
function toggleContext(name: string): void {
  contextFilter.value = contextFilter.value === name ? '' : name;
}
function clearFilters(): void {
  projectFilter.value = '';
  contextFilter.value = '';
  keyword.value = '';
}

async function capture(): Promise<void> {
  const text = title.value.trim();
  if (!text) return;
  await callDomain('gtd.add', null, {
    title: text, status: 'inbox', context: capContext.value, project: capProject.value
  });
  title.value = '';
  await refresh();
  // 捕获后跳回收件箱：否则用户停在「下一步」等分组，看不见刚记下的那条，
  // 会以为没保存成功而重复输入。
  activeStatus.value = 'inbox';
  contextFilter.value = '';
  projectFilter.value = '';
  keyword.value = '';
  say('已收进「收件箱」——厘清是下一步的事');
}

async function toggle(t: GtdTask): Promise<void> {
  // 还有子项没做完的父任务不是「一件事」，是容器：勾不掉，先问要不要连子项一起完成。
  // 用行内确认条而不是原生 confirm——弹窗会打断键盘流，也会卡住自动化断言。
  if (t.status !== 'done' && (t.openChildren || 0) > 0) {
    blockedId.value = t.id;
    return;
  }
  const call = t.status === 'done' ? 'gtd.reopen' : 'gtd.complete';
  await callDomain(call, null, t.id);
  await refresh();
}

async function remove(t: GtdTask): Promise<void> {
  const kids = t.childTotal || 0;
  await callDomain('gtd.remove', null, t.id);
  if (props.selected === t.id) emit('select-task', '');
  await refresh();
  // 删容器不删内容：说清楚子项去哪了，否则用户会以为连带删了
  say(kids > 0 ? '已删除父项，' + kids + ' 个子项已上抬为独立任务' : '已删除');
}

function openClarify(t: GtdTask): void {
  if (clarifyId.value === t.id) { clarifyId.value = ''; return; }
  clarifyId.value = t.id;
  clarifyTarget.value = 'next';
  clarifyContext.value = t.context || '';
  clarifyProject.value = t.project || '';
  clarifyDue.value = t.dueDate || '';
  clarifyWaiting.value = t.waitingFor || '';
  clarifyStep.value = 1;
  clarifyMode.value = 'wizard';
  clarifyTitle.value = t.title;
  clarifyWhen.value = 'today';
}

// 第 1 步：这是「要我去做」还是「只是资料」？
// 资料不进清单——把它丢进「将来也许」，比让它冒充待办更诚实。
async function wizardIsMaterial(): Promise<void> {
  if (!clarifyId.value) return;
  await callDomain('gtd.clarify', null, clarifyId.value, 'someday', {});
  clarifyId.value = '';
  await refresh();
  say('已归入「将来也许」——资料不是待办');
}

// 2 分钟能做完的，不要进清单：清单是用来装「现在做不完」的事的
async function wizardTwoMinutes(): Promise<void> {
  if (!clarifyId.value) return;
  await callDomain('gtd.complete', null, clarifyId.value);
  clarifyId.value = '';
  await refresh();
  say('两分钟做完，不进清单');
}

function wizardToStep2(): void {
  clarifyStep.value = 2;
}

function wizardToStep3(): void {
  clarifyStep.value = 3;
}

async function wizardCommit(): Promise<void> {
  if (!clarifyId.value) return;
  const when = clarifyWhen.value;
  const status = when === 'today' ? 'next'
    : when === 'date' ? 'scheduled'
      : when === 'waiting' ? 'waiting' : 'someday';
  const patch: Record<string, string> = {
    title: clarifyTitle.value.trim(),
    context: clarifyContext.value.trim(),
    project: clarifyProject.value.trim(),
  };
  if (when === 'date') {
    if (!clarifyDue.value) { say('先选个日子'); return; }
    patch.dueDate = clarifyDue.value;
  }
  if (when === 'waiting') {
    if (!clarifyWaiting.value.trim()) { say('写清等谁，否则一周后不知道该催什么'); return; }
    patch.waitingFor = clarifyWaiting.value.trim();
  }
  const res = await callDomain<{ error?: string } | null>('gtd.clarify', null, clarifyId.value, status, patch);
  if (res && res.error) { say('厘清失败：' + res.error); return; }
  // 「今天做」的就顺手占一条今日六条：选了今天却不进六条，等于只是换了个标签。
  // 六条满了要说清楚，否则用户以为占上了，其实 toggleFocus 静默失败。
  let focusFull = false;
  if (when === 'today') {
    const f = await callDomain<{ count: number } | null>('gtd.focus', null, localDate());
    focusFull = !!f && f.count >= 6;
    if (!focusFull) await callDomain('gtd.focusToggle', null, localDate(), clarifyId.value, 'work');
  }
  clarifyId.value = '';
  await refresh();
  say(when !== 'today' ? '已归入「' + STATUS_LABEL[status] + '」'
    : focusFull ? '已进「下一步」；今日六条已满，去「今日六条」格腾一条再挑' : '已进「下一步」，并占了一条今日六条');
}

async function submitClarify(): Promise<void> {
  if (!clarifyId.value) return;
  const target = clarifyTarget.value;
  const patch: Record<string, string> = {
    context: clarifyContext.value.trim(), project: clarifyProject.value.trim()
  };
  if (target === 'scheduled') patch.dueDate = clarifyDue.value;
  if (target === 'waiting') patch.waitingFor = clarifyWaiting.value.trim();
  const res = await callDomain<{ error?: string } | null>('gtd.clarify', null, clarifyId.value, target, patch);
  if (res && res.error) { say('厘清失败：' + res.error); return; }
  clarifyId.value = '';
  await refresh();
  say('已归入「' + STATUS_LABEL[target] + '」');
}

// --- 归类：拖拽与菜单共用同一套动作 ---
// 一条任务要「换个组」在 GTD 里不是换标签：日程必须带日子、等待必须写清等谁。
// 所以这里把校验收在一处，拖拽、右键菜单、行内按钮走同一个入口，避免三条路径三种口径。
const clarifyPanelEl = ref<HTMLElement | null>(null);

function prepareClarify(t: GtdTask, when: 'today' | 'date' | 'waiting' | 'later'): void {
  if (clarifyId.value !== t.id) openClarify(t);
  clarifyMode.value = 'wizard';
  clarifyStep.value = 3;
  clarifyWhen.value = when;
  clarifyTitle.value = t.title;
  clarifyContext.value = t.context || '';
  clarifyProject.value = t.project || '';
  clarifyDue.value = t.dueDate || '';
  clarifyWaiting.value = t.waitingFor || '';
  // 厘清面板在清单上方：拖完要看得到，否则用户以为没反应
  void nextTick(function () {
    const el = clarifyPanelEl.value;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

async function moveToStatus(t: GtdTask, k: string): Promise<void> {
  if (!t) return;
  if (k === 'done') {
    if ((t.openChildren || 0) > 0) {
      blockedId.value = t.id;
      say('「' + t.title + '」还有 ' + t.openChildren + ' 个子项没完成——先在行里确认「一并完成」');
      return;
    }
    await callDomain('gtd.complete', null, t.id);
    await refresh();
    say('已完成「' + t.title + '」');
    return;
  }
  if (k === t.status) { say('「' + t.title + '」已经在「' + STATUS_LABEL[k] + '」里了'); return; }
  if (k === 'scheduled' && !t.dueDate) {
    prepareClarify(t, 'date');
    say('归入「日程」要先挑个日子——已在上面打开厘清');
    return;
  }
  if (k === 'waiting' && !t.waitingFor) {
    prepareClarify(t, 'waiting');
    say('归入「等待」要写清等谁——已在上面打开厘清');
    return;
  }
  await callDomain('gtd.clarify', null, t.id, k, {});
  await refresh();
  say('「' + t.title + '」已归入「' + STATUS_LABEL[k] + '」');
}

// --- 拖拽：把一行拖到分栏的目录里就完成归类 ---
// 用原生 HTML5 拖拽而不是引库：只在同一窗口内搬一条任务，系统级拖动预览与光标反馈够用，
// 也不必为一个交互破坏「零运行时依赖」这条硬约束。
const dragId = ref('');
const dropKey = ref('');
const dragTask = computed<GtdTask | null>(function () {
  const id = dragId.value;
  if (!id) return null;
  return tasks.value.filter(function (t) { return t.id === id; })[0] || null;
});

function dragStart(t: GtdTask, e: DragEvent): void {
  dragId.value = t.id;
  dropKey.value = '';
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // 有的环境读不到自定义 MIME，纯文本最稳；真正的载荷仍走 dragId
    e.dataTransfer.setData('text/plain', t.title);
  }
}
function dragEnd(): void { dragId.value = ''; dropKey.value = ''; }
function dropHover(key: string, e: DragEvent): void {
  if (!dragId.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (dropKey.value !== key) dropKey.value = key;
}
function dropLeave(key: string): void {
  if (dropKey.value === key) dropKey.value = '';
}

async function dropToStatus(k: string): Promise<void> {
  const t = dragTask.value;
  dragEnd();
  if (t) await moveToStatus(t, k);
}

async function dropToProject(name: string): Promise<void> {
  const t = dragTask.value;
  dragEnd();
  if (!t) return;
  // 放进项目等于表态「这件事要做」：收件箱来的顺手推到下一步，收件箱才真的会被清空。
  // 不做这一步的话，拖进项目只是贴了个标签，人还得再回来厘清一次；
  // 已经在这个项目里的也一样——拖过来的人想要的是「归位」，不是一句「本来就在这」。
  if (t.status === 'inbox') {
    const patch = t.project === name ? {} : { project: name };
    await callDomain('gtd.clarify', null, t.id, 'next', patch);
    await refresh();
    say('已放进项目「' + name + '」，并从收件箱推到「下一步」');
    return;
  }
  if (t.project === name) { say('「' + t.title + '」已经在项目「' + name + '」里了'); return; }
  await callDomain('gtd.update', null, t.id, { project: name });
  await refresh();
  say('「' + t.title + '」已归到项目「' + name + '」');
}

async function dropToContext(name: string): Promise<void> {
  const t = dragTask.value;
  dragEnd();
  if (!t) return;
  if ((t.context || '') === name) { say('「' + t.title + '」的情境已经是 ' + (name || '空') + ' 了'); return; }
  // 情境只是执行条件，不是流程状态：拖上去不改它在清单里的归组
  await callDomain('gtd.update', null, t.id, { context: name });
  await refresh();
  say(name ? '已标上情境 ' + name + '——仍留在「' + STATUS_LABEL[t.status] + '」' : '已清掉情境');
}

// --- 右键菜单：设置 / 转发 / 移动 / 完成 / 删除 ---
// 行内只留最常用的两个按钮（厘清、⋯）。其余动作收进同一个菜单，
// 鼠标右键、行尾「⋯」、菜单里的移动子项都走上面那套 moveToStatus，不另开口径。
interface MenuState { id: string; x: number; y: number; sub: '' | 'move' | 'fwd' }
const menu = ref<MenuState | null>(null);
const MENU_W = 214;
const MENU_H = 300;

const menuTask = computed<GtdTask | null>(function () {
  const m = menu.value;
  if (!m) return null;
  return tasks.value.filter(function (t) { return t.id === m.id; })[0] || null;
});

function clampMenu(x: number, y: number): { x: number; y: number } {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const h = typeof window !== 'undefined' ? window.innerHeight : 900;
  return {
    x: Math.max(8, Math.min(x, w - MENU_W - 8)),
    y: Math.max(8, Math.min(y, h - MENU_H - 8))
  };
}

function openMenu(t: GtdTask, x: number, y: number): void {
  const p = clampMenu(x, y);
  menu.value = { id: t.id, x: p.x, y: p.y, sub: '' };
  // 右击也算选中：右栏跟着切到这一条，菜单里的「任务设置」才有明确去向
  if (props.selected !== t.id) emit('select-task', t.id);
}

function openMenuAt(t: GtdTask, e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement | null;
  const r = el ? el.getBoundingClientRect() : null;
  openMenu(t, r ? r.left - 56 : e.clientX, r ? r.bottom + 4 : e.clientY);
}

function closeMenu(): void { menu.value = null; }

function menuSub(sub: '' | 'move' | 'fwd'): void {
  const m = menu.value;
  if (!m) return;
  menu.value = { id: m.id, x: m.x, y: m.y, sub: m.sub === sub ? '' : sub };
}

function onDocDown(e: Event): void {
  const t = e.target as HTMLElement | null;
  // 浮层自己的点击不能先被这里关掉：capture 阶段比目标元素的 handler 更早跑
  const inside = (t && typeof t.closest === 'function')
    ? t.closest('.gtd-menu, .gtd-pick, .gtd-side-menu, .gtd-blank-add, .side-add-row, .side-edit')
    : null;
  if (inside) return;
  closeMenu();
  sideMenu.value = null;
  picker.value = null;
  sideAdd.value = '';
  blankMenu.value = null;
}
function onDocKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  closeMenu();
  sideMenu.value = null;
  picker.value = null;
  sideEdit.value = null;
  sideAdd.value = '';
  if (blankMenu.value) blankMenu.value = null;
  else if (blankOpen.value) blankOpen.value = false;
}
// 滚动 / 改窗口大小时浮层跟着收起：fixed 定位不会跟着内容走，留着就是错位
function closeFloats(): void {
  closeMenu();
  sideMenu.value = null;
  picker.value = null;
  blankMenu.value = null;
}

async function menuMove(k: string): Promise<void> {
  const t = menuTask.value;
  closeMenu();
  if (t) await moveToStatus(t, k);
}

async function actSet(): Promise<void> {
  const t = menuTask.value;
  closeMenu();
  if (!t) return;
  emit('select-task', t.id);
  await nextTick();
  const focus = function (): void {
    const el = document.getElementById('wc-title') as HTMLInputElement | null;
    if (el) { el.focus(); el.select(); }
  };
  focus();
  // 右栏是异步读盘后再渲染的，首次切过去时 #wc-title 可能还没挂上
  setTimeout(focus, 90);
  say('右栏已打开「' + t.title + '」的设置');
}

async function actFocus(): Promise<void> {
  const t = menuTask.value;
  closeMenu();
  if (!t) return;
  const f = await callDomain<{ count: number; items?: Array<{ id: string }> } | null>('gtd.focus', null, localDate());
  const list = f && Array.isArray(f.items) ? f.items : [];
  const inFocus = list.some(function (x) { return x.id === t.id; });
  if (inFocus) {
    await callDomain('gtd.focusToggle', null, localDate(), t.id, 'work');
    await refresh();
    say('已从今日六条移出「' + t.title + '」');
    return;
  }
  if (f && f.count >= 6) { say('今日六条已满，先去「今日六条」格腾一条再挑'); return; }
  await callDomain('gtd.focusToggle', null, localDate(), t.id, 'work');
  await refresh();
  say('已转发到「今日六条」——今天先干这几件');
}

function taskLine(t: GtdTask): string {
  const bits = [t.title];
  if (t.project) bits.push('项目 ' + t.project);
  if (t.context) bits.push('情境 ' + t.context);
  if (t.dueDate) bits.push('到期 ' + t.dueDate);
  return bits.join('｜');
}

function copyFallback(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

async function actCopy(): Promise<void> {
  const t = menuTask.value;
  closeMenu();
  if (!t) return;
  const line = taskLine(t);
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(line);
      ok = true;
    }
  } catch (e) { ok = false; }
  if (!ok) ok = copyFallback(line);
  say(ok ? '已复制：' + line : '复制失败——当前环境不给剪贴板权限');
}

// 转发到当天记录：写进「自由记录」格而不是「工作推进」格。
// 工作推进格里正开着编辑窗，从菜单里再写一次会和正在敲的字打架；自由记录这一页没人编辑。
async function actDiary(): Promise<void> {
  const t = menuTask.value;
  closeMenu();
  if (!t) return;
  const rec = props.record;
  if (!rec || !rec.cells) { say('今天的记录还没读出来，稍后再试'); return; }
  const line = '· ' + t.title + (t.project ? '（' + t.project + '）' : '') + (t.dueDate ? ' · 到期 ' + t.dueDate : '');
  const prev = rec.cells.free || '';
  const free = prev.replace(/\s+$/, '');
  const cells = Object.assign({}, rec.cells, { free: free ? free + '\n' + line : line });
  emit('save', Object.assign({}, rec, { cells: cells }));
  say('已转发到今天的「自由记录」格');
}

function actKid(): void {
  const t = menuTask.value;
  closeMenu();
  if (!t) return;
  if (props.selected !== t.id) emit('select-task', t.id);
  openKidInput(t);
  void nextTick(function () {
    const el = document.querySelector('.gtd-kid-add .kid-in') as HTMLInputElement | null;
    if (el) el.focus();
  });
}

async function actDone(): Promise<void> {
  const t = menuTask.value;
  closeMenu();
  if (!t) return;
  if (t.status === 'done') {
    await callDomain('gtd.reopen', null, t.id);
    await refresh();
    say('已重开「' + t.title + '」');
    return;
  }
  await moveToStatus(t, 'done');
}

async function actRemove(): Promise<void> {
  const t = menuTask.value;
  closeMenu();
  if (t) await remove(t);
}

// ---------------------------------------------------------------
// 任务区空白处的「就地新建」（2026-11-11 主理人要求）
// 顶部捕获条仍是 GTD 的默认入口：新念头一律先进收件箱。
// 但用户已经站在「下一步 / 等待 / 日程 / 某项目 / 某情境」里，
// 说明这一条当场就想清楚了；再让他捕获→厘清→移动，是让界面替流程多走两步。
// 这条通道必须显式（双击 / 右击 / ＋），并把当前上下文一次写进新任务，
// 不制造「存下了却看不见」的孤儿。
// ---------------------------------------------------------------
const blankOpen = ref(false);
const blankTitle = ref('');
const blankContext = ref('');
const blankProject = ref('');
const blankDue = ref('');
const blankWaiting = ref('');
const blankMenu = ref<{ x: number; y: number } | null>(null);
const blankInputEl = ref<HTMLInputElement | null>(null);
const canCreateHere = computed(() => activeStatus.value !== 'done');
const createTargetLabel = computed(() => STATUS_LABEL[activeStatus.value] || '清单');

function focusBlankInput(): void {
  void nextTick(function () {
    if (blankInputEl.value) blankInputEl.value.focus();
  });
}

function openBlankCreate(target?: string): void {
  // 条已开着、又没要求换分组，就只把光标送回去，别把正在敲的字清掉
  if (!target && blankOpen.value) { focusBlankInput(); return; }
  if (target) pickStatus(target);
  // 「已完成」只做回顾，不新建：真要建就落到「下一步」，并说清去哪了
  if (activeStatus.value === 'done') {
    pickStatus('next');
    say('「已完成」只做回顾——新任务放在「下一步」');
  }
  blankMenu.value = null;
  menu.value = null;
  sideMenu.value = null;
  picker.value = null;
  // 就地 = 继承眼前这一组：项目 / 情境筛选直接写进新任务，不必事后归位
  blankContext.value = contextFilter.value;
  blankProject.value = projectFilter.value;
  blankDue.value = activeStatus.value === 'scheduled' ? localDate() : '';
  blankWaiting.value = '';
  blankTitle.value = '';
  blankOpen.value = true;
  focusBlankInput();
}

function closeBlankCreate(): void {
  blankOpen.value = false;
  blankMenu.value = null;
}

async function commitBlankCreate(): Promise<void> {
  const text = blankTitle.value.trim();
  if (!text) return;
  const status = activeStatus.value === 'done' ? 'next' : activeStatus.value;
  const patch: Record<string, string> = {
    title: text,
    status: status,
    context: blankContext.value,
    project: blankProject.value
  };
  // 日程缺日期、等待缺「等谁」会被领域层点名；就地新建时就把这两格给足
  if (status === 'scheduled') patch.dueDate = blankDue.value || localDate();
  if (status === 'waiting') patch.waitingFor = blankWaiting.value.trim();
  await callDomain('gtd.add', null, patch);
  blankTitle.value = '';
  // 搜索词会把刚建的那条挡在视图外，重演「刚存下却看不见」的老问题
  keyword.value = '';
  await refresh();
  say('已在「' + (STATUS_LABEL[status] || '清单') + '」新建，没有过收件箱');
  focusBlankInput(); // 连着录几条时不用来回点开
}

function blankAreaOnly(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t || typeof t.closest !== 'function') return false;
  // 行、行内按钮、输入框、新建条都不是「空白」；它们的右键/双击各有自己的去处
  return !t.closest('.gtd-item, .gtd-kids-wrap, .gtd-blank-add, button, input, select, textarea');
}

function onCanvasDblClick(e: MouseEvent): void {
  if (!blankAreaOnly(e)) return;
  openBlankCreate();
}

function onCanvasMenu(e: MouseEvent): void {
  if (!blankAreaOnly(e)) return;
  e.preventDefault();
  const p = clampMenu(e.clientX, e.clientY);
  menu.value = null;
  sideMenu.value = null;
  picker.value = null;
  blankMenu.value = { x: p.x, y: p.y };
}

function createInInbox(): void {
  openBlankCreate('inbox');
}

function blankNewSide(kind: SideKind): void {
  blankMenu.value = null;
  openSideAdd(kind);
}

function actSideNewTask(): void {
  const m = sideMenu.value;
  if (!m) return;
  // 从项目 / 情境右键进来，就把筛选定在它身上：新任务直接落在眼前这一组
  if (m.kind === 'proj') { projectFilter.value = m.name; contextFilter.value = ''; }
  else { contextFilter.value = m.name; projectFilter.value = ''; }
  sideMenu.value = null;
  // 换了归属就让它重新初始化一次，别沿用上一条还没写完的字段
  blankOpen.value = false;
  openBlankCreate();
}

// 换清单时把条件字段收掉，避免「在日程里填的日期」被带到等待里
watch(activeStatus, function (k) {
  blankDue.value = k === 'scheduled' ? localDate() : '';
  blankWaiting.value = '';
  if (k === 'done') blankOpen.value = false;
});

async function pullLegacy(): Promise<void> {
  const res = await callDomain<{ added?: number; skipped?: number } | null>('gtd.importLegacy', null);
  await refresh();
  const added = res && typeof res.added === 'number' ? res.added : 0;
  const skipped = res && typeof res.skipped === 'number' ? res.skipped : 0;
  say('已从日记收进 ' + added + ' 条' + (skipped ? '，跳过 ' + skipped + ' 条已存在' : ''));
}

onMounted(function () {
  void load();
  // 菜单是靠 fixed 定位浮在页面上的，页面一滚、窗口一改大小、点到别处都该收起
  window.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('keydown', onDocKey);
  window.addEventListener('scroll', closeFloats, true);
  window.addEventListener('resize', closeFloats);
});

onUnmounted(function () {
  window.removeEventListener('pointerdown', onDocDown, true);
  window.removeEventListener('keydown', onDocKey);
  window.removeEventListener('scroll', closeFloats, true);
  window.removeEventListener('resize', closeFloats);
  if (msgTimer) clearTimeout(msgTimer);
});
</script>

<template>
  <section class="gtd-view">
    <header class="gtd-head">
      <div>
        <h2>工作 · GTD 工作台</h2>
      </div>
      <div class="head-actions">
        <button class="ghost" @click="pullLegacy">收进日记旧任务</button>
        <button class="back" @click="emit('back')">← 返回九格</button>
      </div>
    </header>

    <p class="insight" :class="{ 'gtd-insight-on': !!board }">{{ board ? board.insight : '正在读取本机清单…' }}</p>

    <!-- 本机时间源：只读订阅 ActivityWatch。默认关闭时组件自己不渲染，也不发请求。 -->
    <WorktimeStrip
      :date="record.date"
      :tick="tick"
      @notify="emit('notify', $event)"
      @written="onWorktimeWritten"
      @open-settings="emit('navigate', 'settings')"
    />

    <!-- 捕获：GTD 第一步不是整理，是先倒空脑袋 -->
    <div class="capture">
      <input
        v-model="title"
        class="cap-input"
        maxlength="80"
        placeholder="想到什么先扔进收件箱，回车即存（80 字内）"
        aria-label="捕获到收件箱"
        @keydown.enter.prevent="capture"
      />
      <select v-model="capContext" class="cap-sel" aria-label="上下文">
        <option value="">无上下文</option>
        <option v-for="c in contextOptions" :key="c" :value="c">{{ c }}</option>
      </select>
      <input v-model="capProject" class="cap-proj" maxlength="24" list="cap-proj-list" placeholder="项目（可选）" aria-label="项目" />
      <datalist id="cap-proj-list">
        <option v-for="p in projectOptions" :key="p" :value="p"></option>
      </datalist>
      <button class="cap-btn" :class="{ 'gtd-cap-on': !!title.trim() }" @click="capture">收进收件箱</button>
    </div>

    <!-- 厘清：三步向导是默认路径；熟练用户可切「高级」直接填。
         放在分栏之上、整宽显示——它是流程，不是列表里的一行。 -->
    <div v-if="clarifyId" ref="clarifyPanelEl" class="clarify-panel">
      <!-- 候选项跟着工作台的名单走：新建的情境能选到，归档的项目不会冒出来 -->
      <datalist id="cp-ctx-list">
        <option v-for="c in contextOptions" :key="c" :value="c"></option>
      </datalist>
      <datalist id="cp-proj-list">
        <option v-for="p in projectOptions" :key="p" :value="p"></option>
      </datalist>
      <header class="cp-head">
        <strong class="cp-title">厘清「{{ clarifyTitle || '这一条' }}」</strong>
        <span class="cp-step">{{ clarifyMode === 'advanced' ? '高级' : '第 ' + clarifyStep + ' / 3 步' }}</span>
        <button class="cp-mode" @click="clarifyMode = clarifyMode === 'advanced' ? 'wizard' : 'advanced'">
          {{ clarifyMode === 'advanced' ? '用三步向导' : '高级（直接填）' }}
        </button>
        <button class="cp-x" @click="clarifyId = ''">取消</button>
      </header>

      <template v-if="clarifyMode === 'wizard'">
        <div v-if="clarifyStep === 1" class="cp-body">
          <p class="cp-q">这是「要我去做」，还是「只是资料」？</p>
          <div class="cp-choices">
            <button class="cp-choice" @click="wizardToStep2">要我去做<span class="cp-sub">下一步得有个动作</span></button>
            <button class="cp-choice" @click="wizardIsMaterial">只是资料<span class="cp-sub">丢进「将来也许」，不当待办</span></button>
            <button class="cp-choice cp-choice-fast" @click="wizardTwoMinutes">两分钟能做完<span class="cp-sub">直接完成，不进清单</span></button>
          </div>
        </div>

        <div v-else-if="clarifyStep === 2" class="cp-body">
          <p class="cp-q">下一步做什么？</p>
          <input
            v-model="clarifyTitle"
            class="cp-in cp-full"
            maxlength="80"
            aria-label="下一步动作"
            placeholder="例如：给工长打电话问瓷砖到货时间"
            @keydown.enter.prevent="wizardToStep3"
          />
          <div class="cp-fields">
            <input v-model="clarifyContext" class="cp-in" maxlength="12" list="cp-ctx-list" placeholder="@上下文（如 @电脑）" aria-label="上下文" />
            <input v-model="clarifyProject" class="cp-in" maxlength="24" list="cp-proj-list" placeholder="项目（可选）" aria-label="项目" />
          </div>
          <div class="cp-actions">
            <button class="ghost" @click="clarifyStep = 1">上一步</button>
            <button class="primary" @click="wizardToStep3">下一步</button>
          </div>
        </div>

        <div v-else class="cp-body">
          <p class="cp-q">什么时候做？</p>
          <div class="cp-choices cp-when">
            <button class="cp-choice" :class="{ 'gtd-target-on': clarifyWhen === 'today' }" @click="clarifyWhen = 'today'">今天做<span class="cp-sub">进下一步，并占一条六条</span></button>
            <button class="cp-choice" :class="{ 'gtd-target-on': clarifyWhen === 'date' }" @click="clarifyWhen = 'date'">定个日子<span class="cp-sub">到点才出现</span></button>
            <button class="cp-choice" :class="{ 'gtd-target-on': clarifyWhen === 'waiting' }" @click="clarifyWhen = 'waiting'">等别人<span class="cp-sub">写清等谁</span></button>
            <button class="cp-choice" :class="{ 'gtd-target-on': clarifyWhen === 'later' }" @click="clarifyWhen = 'later'">以后再说<span class="cp-sub">将来也许</span></button>
          </div>
          <div v-if="clarifyWhen === 'date' || clarifyWhen === 'waiting'" class="cp-fields">
            <input
              v-if="clarifyWhen === 'date'"
              v-model="clarifyDue"
              class="cp-in"
              type="date"
              aria-label="日程日期"
            />
            <input
              v-if="clarifyWhen === 'waiting'"
              v-model="clarifyWaiting"
              class="cp-in"
              maxlength="40"
              placeholder="等谁 / 等什么"
              aria-label="等待对象"
            />
          </div>
          <div class="cp-actions">
            <button class="ghost" @click="clarifyStep = 2">上一步</button>
            <button class="primary" @click="wizardCommit">确认归入</button>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="cp-targets">
          <button
            v-for="tg in CLARIFY_TARGETS"
            :key="tg.key"
            class="cp-target"
            :class="{ 'gtd-target-on': clarifyTarget === tg.key }"
            @click="clarifyTarget = tg.key"
          >{{ tg.label }}<span class="cp-hint">{{ tg.hint }}</span></button>
        </div>
        <div class="cp-fields">
          <input v-model="clarifyContext" class="cp-in" maxlength="12" list="cp-ctx-list" placeholder="@上下文（如 @电脑）" aria-label="上下文" />
          <input v-model="clarifyProject" class="cp-in" maxlength="24" list="cp-proj-list" placeholder="项目（可选）" aria-label="项目" />
          <input
            v-if="clarifyTarget === 'scheduled'"
            v-model="clarifyDue"
            class="cp-in"
            type="date"
            aria-label="日程日期"
          />
          <input
            v-if="clarifyTarget === 'waiting'"
            v-model="clarifyWaiting"
            class="cp-in"
            maxlength="40"
            placeholder="等谁 / 等什么"
            aria-label="等待对象"
          />
        </div>
        <div class="cp-actions">
          <button class="primary" @click="submitClarify">确认归入</button>
          <button class="ghost" @click="clarifyId = ''">取消</button>
        </div>
      </template>
    </div>

    <div class="gtd-body">
      <!-- 分栏：清单 / 项目 / 情境。点一下即筛选，再点一次取消 -->
      <aside class="gtd-side" :class="{ 'gtd-side-drop': !!dragId }" aria-label="清单分栏">
        <div class="side-sec">
          <span class="side-label">清单<span class="side-tip">拖任务进来即归类</span></span>
          <button
            v-for="k in SIDE_STATUS"
            :key="k"
            class="gtd-tab side-tab"
            :class="{ 'gtd-tab-on': activeStatus === k, 'gtd-drop-hot': dropKey === 'st:' + k }"
            role="tab"
            :aria-selected="activeStatus === k"
            @click="pickStatus(k)"
            @contextmenu.prevent.stop="openBlankCreate(k)"
            @dragover="dropHover('st:' + k, $event)"
            @dragleave="dropLeave('st:' + k)"
            @drop.prevent="dropToStatus(k)"
          >
            <span class="side-dot" :class="{ 'side-dot-hot': counts[k] > 0 }" aria-hidden="true"></span>
            <span class="side-name">{{ STATUS_LABEL[k] }}</span>
            <span class="num">{{ counts[k] }}</span>
          </button>
          <button
            class="gtd-tab side-tab side-done-tab"
            :class="{ 'gtd-tab-on': activeStatus === 'done', 'gtd-drop-hot': dropKey === 'st:done' }"
            role="tab"
            :aria-selected="activeStatus === 'done'"
            @click="pickStatus('done')"
            @dragover="dropHover('st:done', $event)"
            @dragleave="dropLeave('st:done')"
            @drop.prevent="dropToStatus('done')"
          >
            <span class="side-dot side-dot-done" aria-hidden="true"></span>
            <span class="side-name">已完成</span>
            <span class="num">{{ counts.done }}</span>
          </button>
          <p class="side-hint">{{ STATUS_HINT[activeStatus] }}</p>
        </div>

        <!-- 项目：标题后的「＋」管名单，条目双击改名、右键出菜单（含归档） -->
        <div class="side-sec">
          <span class="side-label">
            项目
            <button class="side-plus" aria-label="新建项目" title="新建项目" @click.stop="openSideAdd('proj')">＋</button>
            <span class="side-tip">点一下只看它</span>
          </span>
          <div v-if="sideAdd === 'proj'" class="side-add-row">
            <input
              v-model="sideDraft"
              class="side-add-in"
              maxlength="24"
              placeholder="项目名，回车即建"
              aria-label="新项目名称"
              @keydown.enter.prevent="commitSideAdd('proj')"
              @keydown.esc="sideAdd = ''"
            />
          </div>
          <template v-for="p in projects" :key="p.name">
            <div v-if="editingSide('proj', p.name)" class="side-edit">
              <input
                v-model="sideRename"
                class="side-edit-in"
                maxlength="24"
                aria-label="项目改名"
                @keydown.enter.prevent="commitSideRename"
                @keydown.esc="sideEdit = null"
                @blur="commitSideRename"
              />
            </div>
            <button
              v-else
              class="side-proj"
              :class="{ 'side-proj-on': projectFilter === p.name, 'gtd-stall': projStalled(p), 'gtd-drop-hot': dropKey === 'proj:' + p.name }"
              :aria-pressed="projectFilter === p.name"
              @click="toggleProject(p.name)"
              @dblclick.stop="openSideEdit('proj', p.name)"
              @contextmenu.prevent.stop="openSideMenu('proj', p.name, $event)"
              @dragover="dropHover('proj:' + p.name, $event)"
              @dragleave="dropLeave('proj:' + p.name)"
              @drop.prevent="dropToProject(p.name)"
            >
              <span class="side-proj-top">
                <span class="proj-name">{{ p.name }}</span>
                <span class="proj-mini">{{ p.done }} / {{ p.total }}</span>
              </span>
              <span class="side-bar"><i :style="{ width: p.pct + '%' }"></i></span>
              <!-- 「N 个下一步」已下线：与上面的 done/total 重复，且把项目卡变成半张清单。
                   只在真出问题时才占第三行：停滞 / 还有没收件箱条目待厘清。 -->
              <span v-if="projStalled(p)" class="proj-warn">停滞：没有下一步</span>
              <span v-else-if="p.stalled" class="proj-ok">{{ projInbox[p.name] }} 条待厘清</span>
            </button>
          </template>
          <p v-if="!projects.length" class="side-empty">还没有项目。点标题旁的「＋」建一个。</p>

          <!-- 归档区：项目做完就退场，但不删历史。取消归档 / 彻底删除都在右键里 -->
          <button
            v-if="archivedProjects.length"
            class="side-arch-toggle"
            :aria-expanded="showArchived"
            @click="showArchived = !showArchived"
          >归档 {{ archivedProjects.length }}<span class="side-caret">{{ showArchived ? '▴' : '▾' }}</span></button>
          <div v-if="showArchived && archivedProjects.length" class="side-arch-list">
            <button
              v-for="p in archivedProjects"
              :key="'arch-' + p.name"
              class="side-arch-item"
              :title="'已归档：右键可取消归档或删除'"
              @contextmenu.prevent.stop="openSideMenu('proj', p.name, $event, true)"
            >
              <span class="proj-name">{{ p.name }}</span>
              <span class="proj-mini">{{ p.done }} / {{ p.total }}</span>
            </button>
          </div>
        </div>

        <div class="side-sec">
          <span class="side-label">
            情境
            <button class="side-plus" aria-label="新建情境" title="新建情境（自动补 @）" @click.stop="openSideAdd('ctx')">＋</button>
          </span>
          <div v-if="sideAdd === 'ctx'" class="side-add-row">
            <input
              v-model="sideDraft"
              class="side-add-in"
              maxlength="12"
              placeholder="@情境，回车即建"
              aria-label="新情境名称"
              @keydown.enter.prevent="commitSideAdd('ctx')"
              @keydown.esc="sideAdd = ''"
            />
          </div>
          <div class="side-ctxs">
            <button
              class="side-ctx"
              :class="{ 'side-ctx-on': !contextFilter, 'gtd-drop-hot': dropKey === 'ctx:' }"
              @click="contextFilter = ''"
              @dragover="dropHover('ctx:', $event)"
              @dragleave="dropLeave('ctx:')"
              @drop.prevent="dropToContext('')"
            >全部</button>
            <template v-for="c in contexts" :key="c.name">
              <input
                v-if="editingSide('ctx', c.name)"
                v-model="sideRename"
                class="side-edit-in side-ctx-in"
                maxlength="12"
                aria-label="情境改名"
                @keydown.enter.prevent="commitSideRename"
                @keydown.esc="sideEdit = null"
                @blur="commitSideRename"
              />
              <button
                v-else
                class="side-ctx"
                :class="{ 'side-ctx-on': contextFilter === c.name, 'gtd-drop-hot': dropKey === 'ctx:' + c.name }"
                @click="toggleContext(c.name)"
                @dblclick.stop="openSideEdit('ctx', c.name)"
                @contextmenu.prevent.stop="openSideMenu('ctx', c.name, $event)"
                @dragover="dropHover('ctx:' + c.name, $event)"
                @dragleave="dropLeave('ctx:' + c.name)"
                @drop.prevent="dropToContext(c.name)"
              >{{ c.name }}<span class="num">{{ c.open }}</span></button>
            </template>
          </div>
        </div>
      </aside>

      <div class="gtd-main">
        <div class="gtd-bar">
          <input
            v-model="keyword"
            class="gtd-search"
            maxlength="30"
            placeholder="搜标题 / 项目 / 情境"
            aria-label="搜索清单"
          />
          <span class="gtd-sorts" role="group" aria-label="排序">
            <button
              v-for="s in SORTS"
              :key="s.key"
              class="mini"
              :class="{ 'gtd-sort-on': sortMode === s.key }"
              :aria-pressed="sortMode === s.key"
              @click="sortMode = s.key"
            >{{ s.label }}</button>
          </span>
          <span class="gtd-count">{{ treeRows.length }} 条</span>
        </div>

        <p v-if="filtersOn" class="gtd-filter">
          {{ filterText }}
          <button class="gtd-clear" @click="clearFilters">清除筛选</button>
        </p>

        <!-- 列头：与每一行共用同一套栅格（.gtd-main 的 --gtd-cols），
             所以「情境 / 项目 / 到期」三列的纵向分割线上下是一条线，不是两套近似值 -->
        <div class="gtd-colhead" aria-hidden="true">
          <span class="ch-lead"></span>
          <span class="ch-title">任务</span>
          <span class="ch-ctx">情境</span>
          <span class="ch-proj">项目</span>
          <span class="ch-due">到期</span>
          <span class="ch-act"></span>
        </div>

        <!-- 任务区画布：列表之外的空白也是可操作的（双击 / 右击就地新建），
             行、行内按钮、输入框由 blankAreaOnly 排除，不抢它们自己的事件 -->
        <div class="gtd-canvas" @dblclick="onCanvasDblClick" @contextmenu="onCanvasMenu">
        <ul class="gtd-list">
          <template v-for="row in treeRows" :key="row.task.id">
            <li
              class="gtd-item"
              :class="{
                'gtd-done': row.task.status === 'done',
                'gtd-overdue': row.task.overdue,
                'gtd-parent-item': row.children.length > 0,
                'gtd-sel': selected === row.task.id,
                'gtd-dragging': dragId === row.task.id
              }"
              :aria-current="selected === row.task.id ? 'true' : undefined"
              draggable="true"
              @click="select(row.task.id)"
              @dragstart="dragStart(row.task, $event)"
              @dragend="dragEnd"
              @contextmenu.prevent="openMenu(row.task, $event.clientX, $event.clientY)"
            >
              <span class="gtd-lead">
                <button
                  v-if="row.children.length"
                  class="gtd-fold"
                  :aria-expanded="kidsShown(row.task.id)"
                  :aria-label="kidsShown(row.task.id) ? '收起子项' : '展开子项'"
                  @click.stop="toggleKids(row.task.id)"
                >{{ kidsShown(row.task.id) ? '▾' : '▸' }}</button>
                <span v-else class="gtd-fold-gap" aria-hidden="true"></span>
                <button class="gtd-check" :aria-pressed="row.task.status === 'done'" @click.stop="toggle(row.task)">
                  {{ row.task.status === 'done' ? '✓' : '○' }}
                </button>
              </span>

              <span class="gtd-cell gtd-cell-title">
                <span class="gtd-title">{{ row.task.title }}</span>
                <span
                  v-if="row.children.length"
                  class="gtd-kid-count"
                  :class="{ 'gtd-kid-count-on': (row.task.openChildren || 0) === 0 }"
                >{{ row.task.childDone }} / {{ row.task.childTotal }} 子项</span>
                <span v-if="row.parentLabel" class="gtd-tag gtd-up">↑ {{ row.parentLabel }}</span>
                <span v-if="row.task.needWho" class="gtd-warn">缺「等谁」</span>
                <span v-if="row.task.needDate" class="gtd-warn">缺日期</span>
                <span v-if="row.task.status === 'inbox' && (row.task.ageDays || 0) > 0" class="gtd-age">躺 {{ row.task.ageDays }} 天</span>
              </span>

              <span
                class="gtd-cell gtd-cell-ctx"
                :class="{ 'gtd-cell-open': picker && picker.id === row.task.id && picker.field === 'ctx' }"
                title="点一下改情境"
                @click.stop="openPicker(row.task, 'ctx', $event)"
              >
                <span v-if="row.task.context" class="gtd-tag">{{ row.task.context }}</span>
                <span v-else class="gtd-cell-plus" aria-hidden="true">＋</span>
              </span>
              <span
                class="gtd-cell gtd-cell-proj"
                :class="{ 'gtd-cell-open': picker && picker.id === row.task.id && picker.field === 'proj' }"
                title="点一下改项目"
                @click.stop="openPicker(row.task, 'proj', $event)"
              >
                <span v-if="row.task.project" class="gtd-tag gtd-proj">{{ row.task.project }}</span>
                <span v-else class="gtd-cell-plus" aria-hidden="true">＋</span>
              </span>
              <span
                class="gtd-cell gtd-cell-due"
                :class="{ 'gtd-cell-open': picker && picker.id === row.task.id && picker.field === 'due' }"
                title="点一下设到期日"
                @click.stop="openPicker(row.task, 'due', $event)"
              >
                <span v-if="row.task.dueDate" class="gtd-due" :class="{ 'gtd-due-hot': row.task.overdue || row.task.dueToday }">
                  {{ row.task.dueDate.slice(5) }}
                  <span v-if="overdueDays(row.task) > 0" class="gtd-gap">· 逾期 {{ overdueDays(row.task) }} 天</span>
                  <span v-else-if="row.task.dueToday" class="gtd-gap">· 今天</span>
                </span>
                <span v-else-if="row.task.waitingFor" class="gtd-wait">
                  等 {{ row.task.waitingFor }}<span v-if="waitDays(row.task) >= 3" class="gtd-gap">· {{ waitDays(row.task) }} 天</span>
                </span>
                <span v-else class="gtd-cell-plus" aria-hidden="true">＋</span>
              </span>

              <span class="gtd-cell gtd-act" @click.stop>
                <button v-if="canAddChild(row.task)" class="mini gtd-add-kid" @click="openKidInput(row.task)">+ 子项</button>
                <button
                  v-if="row.task.status === 'inbox'"
                  class="clarify-btn"
                  :class="{ 'gtd-clarify-on': clarifyId === row.task.id }"
                  @click="openClarify(row.task)"
                >厘清</button>
                <button v-else-if="row.task.status === 'done'" class="mini" @click="toggle(row.task)">重开</button>
                <button
                  class="gtd-more"
                  aria-label="更多操作（右键任务行也打开同一菜单）"
                  title="更多操作：设置 / 转发 / 移动"
                  @click="openMenuAt(row.task, $event)"
                >⋯</button>
                <button class="gtd-del" aria-label="删除任务" @click="remove(row.task)">×</button>
              </span>
            </li>

            <!-- 容器不能直接勾掉：先问要不要连子项一起完成，不做静默级联 -->
            <li v-if="blockedId === row.task.id" class="gtd-block" role="status">
              还有 {{ row.task.openChildren }} 个子项没完成 ——
              <button class="mini gtd-block-go" @click="completeWithKids(row.task)">一并完成</button>
              <button class="mini" @click="blockedId = ''">先不动</button>
            </li>

            <!-- 子项：与父行共用同一套栅格（不再整体缩进），层级靠 ↳ 与浅底表达，
                 否则子行的「情境 / 到期」会比父行整体右移，列就对不齐了 -->
            <li
              v-if="(row.children.length || kidOpen[row.task.id]) && kidsShown(row.task.id)"
              class="gtd-kids-wrap"
            >
              <ul v-if="row.children.length" class="gtd-kids">
                <li
                  v-for="c in row.children"
                  :key="c.id"
                  class="gtd-item gtd-kid"
                  :class="{ 'gtd-done': c.status === 'done', 'gtd-overdue': c.overdue, 'gtd-sel': selected === c.id, 'gtd-dragging': dragId === c.id }"
                  draggable="true"
                  @click="select(c.id)"
                  @dragstart="dragStart(c, $event)"
                  @dragend="dragEnd"
                  @contextmenu.prevent="openMenu(c, $event.clientX, $event.clientY)"
                >
                  <span class="gtd-lead">
                    <span class="gtd-kid-line" aria-hidden="true">↳</span>
                    <button class="gtd-check" :aria-pressed="c.status === 'done'" @click.stop="toggle(c)">
                      {{ c.status === 'done' ? '✓' : '○' }}
                    </button>
                  </span>
                  <span class="gtd-cell gtd-cell-title">
                    <span class="gtd-title">{{ c.title }}</span>
                  </span>
                  <span
                    class="gtd-cell gtd-cell-ctx"
                    :class="{ 'gtd-cell-open': picker && picker.id === c.id && picker.field === 'ctx' }"
                    title="点一下改情境"
                    @click.stop="openPicker(c, 'ctx', $event)"
                  >
                    <span v-if="c.context" class="gtd-tag">{{ c.context }}</span>
                    <span v-else class="gtd-cell-plus" aria-hidden="true">＋</span>
                  </span>
                  <span
                    class="gtd-cell gtd-cell-proj"
                    :class="{ 'gtd-cell-open': picker && picker.id === c.id && picker.field === 'proj' }"
                    title="点一下改项目"
                    @click.stop="openPicker(c, 'proj', $event)"
                  >
                    <span v-if="c.project" class="gtd-tag gtd-proj">{{ c.project }}</span>
                    <span v-else class="gtd-cell-plus" aria-hidden="true">＋</span>
                  </span>
                  <span
                    class="gtd-cell gtd-cell-due"
                    :class="{ 'gtd-cell-open': picker && picker.id === c.id && picker.field === 'due' }"
                    title="点一下设到期日"
                    @click.stop="openPicker(c, 'due', $event)"
                  >
                    <span v-if="c.dueDate" class="gtd-due" :class="{ 'gtd-due-hot': c.overdue || c.dueToday }">
                      {{ c.dueDate.slice(5) }}
                      <span v-if="overdueDays(c) > 0" class="gtd-gap">· 逾期 {{ overdueDays(c) }} 天</span>
                    </span>
                  </span>
                  <span class="gtd-cell gtd-act" @click.stop>
                    <button class="mini" @click="detach(c)">↑ 提升</button>
                    <button
                      class="gtd-more"
                      aria-label="更多操作（右键子项也打开同一菜单）"
                      title="更多操作：设置 / 转发 / 移动"
                      @click="openMenuAt(c, $event)"
                    >⋯</button>
                    <button class="gtd-del" aria-label="删除子项" @click="remove(c)">×</button>
                  </span>
                </li>
              </ul>
              <div v-if="kidOpen[row.task.id]" class="gtd-kid-add">
                <input
                  v-model="kidDraft[row.task.id]"
                  class="kid-in"
                  maxlength="80"
                  :placeholder="'给「' + row.task.title + '」添一条能动手的子项，回车即存'"
                  :aria-label="'为 ' + row.task.title + ' 添加子项'"
                  @keydown.enter.prevent="addChild(row.task)"
                />
                <button class="mini gtd-kid-go" @click="addChild(row.task)">加入</button>
              </div>
            </li>
          </template>
          <li v-if="treeRows.length === 0" class="gtd-empty">
            {{ emptyHint }}
          </li>

          <!-- 就地新建：状态、项目、情境都按眼前这一组预置，回车即存。
               保存后保留输入条，方便连着录几条。 -->
          <li v-if="blankOpen" class="gtd-blank-add" @dblclick.stop @contextmenu.stop>
            <div class="gtd-blank-head">
              在「{{ createTargetLabel }}」里新建
              <span v-if="projectFilter"> · 项目「{{ projectFilter }}」</span>
              <span v-if="contextFilter"> · 情境 {{ contextFilter }}</span>
              <span class="gtd-blank-tip">回车即存，不过收件箱</span>
            </div>
            <div class="gtd-blank-row">
              <input
                ref="blankInputEl"
                v-model="blankTitle"
                class="gtd-blank-in"
                maxlength="80"
                placeholder="写一条能动手的任务，回车即存"
                aria-label="就地新建任务"
                @keydown.enter.prevent="commitBlankCreate"
                @keydown.esc="closeBlankCreate"
              />
              <button class="mini gtd-blank-go" @click="commitBlankCreate">加入</button>
              <button class="mini" @click="closeBlankCreate">收起</button>
            </div>
            <div class="gtd-blank-row gtd-blank-fields">
              <select v-model="blankContext" class="gtd-blank-sel" aria-label="新任务的情境">
                <option value="">无情境</option>
                <option v-for="c in contextOptions" :key="c" :value="c">{{ c }}</option>
              </select>
              <input
                v-model="blankProject"
                class="gtd-blank-proj"
                maxlength="24"
                list="cap-proj-list"
                placeholder="项目（可选）"
                aria-label="新任务的项目"
              />
              <input
                v-if="activeStatus === 'scheduled'"
                v-model="blankDue"
                class="gtd-blank-date"
                type="date"
                aria-label="日程日期"
              />
              <input
                v-if="activeStatus === 'waiting'"
                v-model="blankWaiting"
                class="gtd-blank-who"
                maxlength="40"
                placeholder="等谁 / 等什么"
                aria-label="等待对象"
              />
            </div>
          </li>
        </ul>

        <div v-if="!blankOpen && canCreateHere" class="gtd-blank-hint">
          <span>双击或右击空白处，直接在此新建</span>
          <button class="mini gtd-blank-hint-btn" aria-label="在此新建任务" @click.stop="openBlankCreate()">＋ 新建</button>
        </div>
        <div v-else-if="!blankOpen" class="gtd-blank-hint">
          <span>「已完成」只做回顾；去「下一步」新建，或在左侧清单上右击</span>
        </div>
        </div>
      </div>
    </div>

    <CellNoteEditor :record="record" cell-key="work" @save="emit('save', $event)" @notify="emit('notify', $event)" />

    <p class="note">{{ board ? board.note : '' }}</p>
    <div v-if="message" class="msg" :class="{ 'message-on': !!message }" role="status">{{ message }}</div>

    <!-- 行内选择面板：情境 / 项目 / 到期各弹一个，底部固定一条「今日六条」开关 -->
    <div
      v-if="picker && pickerTask"
      class="gtd-pick"
      role="dialog"
      aria-label="改任务属性"
      :style="{ left: picker.x + 'px', top: picker.y + 'px' }"
      @pointerdown.stop
      @click.stop
      @contextmenu.prevent
    >
      <p class="gp-head">
        {{ picker.field === 'ctx' ? '情境' : picker.field === 'proj' ? '项目' : '到期日' }}
        <span class="gp-sub">{{ pickerTask.title }}</span>
      </p>

      <template v-if="picker.field === 'ctx'">
        <div class="gp-list">
          <button
            v-for="c in contexts"
            :key="'pk-' + c.name"
            class="gp-item"
            :class="{ 'gp-on': pickerTask.context === c.name }"
            @click="pickValue('ctx', c.name)"
          >{{ c.name }}<span class="gp-num">{{ c.open }}</span></button>
        </div>
        <button class="gp-item gp-clear" @click="pickValue('ctx', '')">清除情境</button>
      </template>

      <template v-else-if="picker.field === 'proj'">
        <div class="gp-list">
          <button
            v-for="p in projects"
            :key="'pp-' + p.name"
            class="gp-item"
            :class="{ 'gp-on': pickerTask.project === p.name }"
            @click="pickValue('proj', p.name)"
          >{{ p.name }}<span class="gp-num">{{ p.open }}</span></button>
          <p v-if="!projects.length" class="gp-empty">还没有项目——去左侧「＋」建一个</p>
        </div>
        <button class="gp-item gp-clear" @click="pickValue('proj', '')">移出项目</button>
      </template>

      <template v-else>
        <div class="gp-quick">
          <button class="mini" @click="pickValue('due', isoOffset(0))">今天</button>
          <button class="mini" @click="pickValue('due', isoOffset(1))">明天</button>
          <button class="mini" @click="pickValue('due', isoOffset(7))">下周</button>
        </div>
        <input
          class="gp-date"
          type="date"
          :value="pickerTask.dueDate"
          aria-label="到期日"
          @change="pickValue('due', ($event.target as HTMLInputElement).value)"
        />
        <button class="gp-item gp-clear" @click="pickValue('due', '')">清掉日期</button>
      </template>

      <div class="gp-sep"></div>
      <button class="gp-item gp-focus" @click="toggleFocusOf(pickerTask)">
        {{ inFocus(pickerTask.id) ? '★ 移出今日六条' : '☆ 加入今日六条' }}
      </button>
    </div>

    <!-- 分栏右键菜单：改名 / 归档（仅项目）/ 删除 -->
    <div
      v-if="sideMenu"
      class="gtd-menu gtd-side-menu"
      role="menu"
      :style="{ left: sideMenu.x + 'px', top: sideMenu.y + 'px' }"
      @contextmenu.prevent
      @pointerdown.stop
    >
      <p class="gm-head" :title="sideMenu.name">{{ sideMenu.name }}</p>
      <p class="gm-meta">{{ sideMenu.kind === 'proj' ? '项目' : '情境' }}<template v-if="sideMenu.archived"> · 已归档</template></p>
      <button v-if="!sideMenu.archived" class="gm-item" role="menuitem" @click="actSideNewTask">
        <span class="gm-label">在此新建任务</span><span class="gm-hint">直接归属</span>
      </button>
      <div v-if="!sideMenu.archived" class="gm-sep" role="separator"></div>
      <button class="gm-item" role="menuitem" @click="actSideRename">
        <span class="gm-label">改名</span><span class="gm-hint">双击也能改</span>
      </button>
      <button
        v-if="sideMenu.kind === 'proj' && !sideMenu.archived"
        class="gm-item"
        role="menuitem"
        @click="actSideArchive(true)"
      >
        <span class="gm-label">归档</span><span class="gm-hint">完成即退场</span>
      </button>
      <button
        v-if="sideMenu.kind === 'proj' && sideMenu.archived"
        class="gm-item"
        role="menuitem"
        @click="actSideArchive(false)"
      >
        <span class="gm-label">取消归档</span>
      </button>
      <div class="gm-sep" role="separator"></div>
      <button class="gm-item gm-del" role="menuitem" @click="actSideRemove">
        <span class="gm-label">删除</span>
        <span class="gm-hint">{{ sideMenu.kind === 'proj' ? '任务保留' : '清空该情境' }}</span>
      </button>
    </div>

    <!-- 任务区空白处的右键菜单：就地新建 / 回到收件箱 / 补名单 -->
    <div
      v-if="blankMenu"
      class="gtd-menu gtd-blank-menu"
      role="menu"
      :style="{ left: blankMenu.x + 'px', top: blankMenu.y + 'px' }"
      @contextmenu.prevent
      @pointerdown.stop
    >
      <p class="gm-head">在「{{ createTargetLabel }}」新建</p>
      <p class="gm-meta">{{ filterText || '就地建，不必先过收件箱' }}</p>
      <button class="gm-item" role="menuitem" @click="openBlankCreate()">
        <span class="gm-label">新建一条任务</span><span class="gm-hint">双击空白处同款</span>
      </button>
      <button class="gm-item" role="menuitem" @click="createInInbox">
        <span class="gm-label">新建到收件箱</span><span class="gm-hint">暂不判断</span>
      </button>
      <div class="gm-sep" role="separator"></div>
      <button class="gm-item" role="menuitem" @click="blankNewSide('proj')">
        <span class="gm-label">新建项目</span><span class="gm-hint">名单</span>
      </button>
      <button class="gm-item" role="menuitem" @click="blankNewSide('ctx')">
        <span class="gm-label">新建情境</span><span class="gm-hint">名单</span>
      </button>
    </div>

    <!-- 右键菜单：fixed 浮层，不放进滚动容器里被裁掉。
         不 Teleport 到 body——皮肤变量挂在 .workbench[data-skin] 上，
         挪出这个作用域菜单会变成全透明（踩过一次） -->
    <div
      v-if="menu && menuTask"
      class="gtd-menu"
      role="menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @contextmenu.prevent
      @pointerdown.stop
    >
        <p class="gm-head" :title="menuTask.title">{{ menuTask.title }}</p>
        <p class="gm-meta">{{ STATUS_LABEL[menuTask.status] }}<template v-if="menuTask.project"> · {{ menuTask.project }}</template><template v-if="menuTask.context"> · {{ menuTask.context }}</template></p>

        <button class="gm-item" role="menuitem" @click="actSet">
          <span class="gm-label">任务设置</span><span class="gm-hint">右栏改属性</span>
        </button>

        <div class="gm-sep" role="separator"></div>

        <button class="gm-item" role="menuitem" :aria-expanded="menu.sub === 'move'" @click="menuSub('move')">
          <span class="gm-label">移动到</span><span class="gm-more">›</span>
        </button>
        <div v-if="menu.sub === 'move'" class="gm-sub">
          <button
            v-for="k in SIDE_STATUS"
            :key="k"
            class="gm-item gm-subitem"
            role="menuitem"
            :class="{ 'gm-on': menuTask.status === k }"
            @click="menuMove(k)"
          >{{ STATUS_LABEL[k] }}<span v-if="menuTask.status === k" class="gm-check">✓</span></button>
          <button
            class="gm-item gm-subitem"
            role="menuitem"
            :class="{ 'gm-on': menuTask.status === 'done' }"
            @click="menuMove('done')"
          >已完成<span v-if="menuTask.status === 'done'" class="gm-check">✓</span></button>
        </div>

        <button class="gm-item" role="menuitem" :aria-expanded="menu.sub === 'fwd'" @click="menuSub('fwd')">
          <span class="gm-label">转发</span><span class="gm-more">›</span>
        </button>
        <div v-if="menu.sub === 'fwd'" class="gm-sub">
          <button class="gm-item gm-subitem" role="menuitem" @click="actFocus">转发到今日六条</button>
          <button class="gm-item gm-subitem" role="menuitem" @click="actDiary">转发到当天「自由记录」</button>
          <button class="gm-item gm-subitem" role="menuitem" @click="actCopy">复制为文本</button>
        </div>

        <button v-if="menuTask.status !== 'done' && canAddChild(menuTask)" class="gm-item" role="menuitem" @click="actKid">
          <span class="gm-label">加一条子项</span><span class="gm-hint">拆到能动手</span>
        </button>

        <div class="gm-sep" role="separator"></div>

        <button class="gm-item" role="menuitem" @click="actDone">
          <span class="gm-label">{{ menuTask.status === 'done' ? '重开' : '标记完成' }}</span>
        </button>
        <button class="gm-item gm-del" role="menuitem" @click="actRemove">
          <span class="gm-label">删除</span>
        </button>
    </div>
  </section>
</template>

<style scoped>
.gtd-view { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.gtd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.gtd-head h2 { margin: 0; font-size: 15px; font-weight: 500; }
.head-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.head-actions button { white-space: nowrap; }
.muted { font-size: 12px; color: var(--surface-muted); }
.insight { margin: 0; padding: 8px 10px; border-left: 2px solid var(--palette-border); background: var(--surface-panel); font-size: 12px; line-height: 1.6; }
.gtd-insight-on { border-left-color: var(--palette-primary); }
.capture { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cap-input { flex: 1 1 240px; min-width: 160px; }
.cap-sel { flex: 0 0 110px; }
.cap-proj { flex: 0 0 130px; }
input, select {
  padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); outline: none;
}
input:focus, select:focus { border-color: var(--palette-accent); }
.cap-btn, .primary, .ghost, .back, .mini, .clarify-btn {
  padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised);
}
.primary, .cap-btn.gtd-cap-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }

/* --- 分栏 + 分行 --- */
.gtd-body { display: flex; gap: var(--space-2); align-items: flex-start; min-width: 0; }
.gtd-side {
  flex: 0 0 156px; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-2); border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md); background: var(--surface-panel);
  position: sticky; top: 0;
}
.side-sec { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.side-label { display: flex; align-items: baseline; gap: 6px; padding: 0 2px; font-size: 11px; color: var(--surface-muted); letter-spacing: 0.04em; }
.side-tip { font-size: 10px; opacity: 0.8; }
.gtd-tab { padding: 5px 10px; border: 0.5px solid transparent; border-radius: var(--radius-sm); background: transparent; font-size: 12px; text-align: left; }
.gtd-tab:hover { background: var(--surface-raised); }
.gtd-tab-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.side-tab { display: flex; align-items: center; gap: 6px; width: 100%; }
.side-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--surface-border); flex: 0 0 auto; }
.side-dot-hot { background: var(--palette-accent); }
.side-dot-done { background: transparent; border: 1px solid var(--palette-border); }
.side-name { flex: 1; min-width: 0; }
.side-done-tab { margin-top: 2px; border-top: 0.5px dashed var(--surface-border); border-radius: 0 0 var(--radius-sm) var(--radius-sm); }
.side-hint { margin: 2px 2px 0; font-size: 10px; line-height: 1.5; color: var(--surface-muted); }
.num { font-variant-numeric: tabular-nums; opacity: 0.75; }
.side-proj {
  display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; text-align: left;
  border: 0.5px solid transparent; border-radius: var(--radius-sm); background: transparent; font-size: 11px;
}
.side-proj:hover { border-color: var(--surface-border); background: var(--surface-raised); }
.side-proj-on { background: var(--palette-soft); border-color: var(--palette-border); }
.side-proj-top { display: flex; align-items: baseline; gap: 6px; }
.proj-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-mini { font-size: 10px; color: var(--surface-muted); font-variant-numeric: tabular-nums; }
.side-bar { display: block; height: 3px; border-radius: 999px; background: var(--surface-raised); overflow: hidden; }
.side-bar i { display: block; height: 100%; background: var(--palette-primary); }
.gtd-stall .proj-name { color: var(--palette-accent); }
.proj-warn { font-size: 10px; color: var(--palette-accent); }
.proj-ok { font-size: 10px; color: var(--surface-muted); }
.side-ctxs { display: flex; flex-wrap: wrap; gap: 3px; }
.side-ctx {
  padding: 2px 7px; border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: transparent; font-size: 11px;
}
.side-ctx-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }

/* --- 分栏名单的维护：标题旁的「＋」、行内改名、归档区 --- */
.side-label { display: flex; align-items: center; gap: 4px; }
.side-plus {
  width: 16px; height: 16px; line-height: 1; padding: 0;
  border: 0.5px solid var(--surface-border); border-radius: 4px;
  background: transparent; color: var(--surface-muted); font-size: 11px; flex: 0 0 auto;
}
.side-plus:hover { color: var(--palette-primary); border-color: var(--palette-border); background: var(--surface-raised); }
.side-add-row { display: flex; gap: 4px; }
.side-add-in {
  width: 100%; font-size: 11px; padding: 3px 6px;
  border: 0.5px solid var(--palette-border); border-radius: var(--radius-sm);
  background: var(--surface-raised);
}
.side-edit { display: flex; }
.side-edit-in {
  width: 100%; font-size: 11px; padding: 3px 6px;
  border: 0.5px solid var(--palette-primary); border-radius: var(--radius-sm);
  background: var(--surface-raised);
}
.side-ctx-in { width: 88px; }
.side-empty { margin: 0; font-size: 10px; color: var(--surface-muted); line-height: 1.5; }
.side-arch-toggle {
  margin-top: 2px; padding: 2px 6px; text-align: left;
  border: 0.5px dashed var(--surface-border); border-radius: var(--radius-sm);
  background: transparent; font-size: 10px; color: var(--surface-muted);
}
.side-arch-toggle:hover { color: var(--palette-primary); border-color: var(--palette-border); }
.side-caret { margin-left: 4px; }
.side-arch-list { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.side-arch-item {
  display: flex; justify-content: space-between; gap: 6px; padding: 2px 6px;
  border: 0.5px dashed var(--surface-border); border-radius: var(--radius-sm);
  background: transparent; font-size: 10px; color: var(--surface-muted); text-align: left;
}
.side-arch-item:hover { color: var(--palette-primary); border-color: var(--palette-border); }

.gtd-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;
  /* 列头与每一行共用这一套栅格：改这里一处，表头、父行、子行的分列同时对上 */
  --gtd-cols: 46px minmax(0, 1fr) 80px 90px 102px 106px;
}
.gtd-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.gtd-search { flex: 1 1 160px; min-width: 120px; font-size: 12px; padding: 5px 8px; }
.gtd-sorts { display: flex; gap: 2px; }
.gtd-sorts .mini { padding: 3px 8px; font-size: 11px; }
.gtd-sort-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.gtd-count { font-size: 11px; color: var(--surface-muted); font-variant-numeric: tabular-nums; }
.gtd-filter { margin: 0; font-size: 11px; color: var(--surface-muted); }
.gtd-clear { margin-left: 6px; padding: 1px 8px; border: 0.5px solid var(--surface-border); border-radius: 999px; background: transparent; font-size: 11px; }

/* --- 列头：与任务行同一套栅格，纵向分列线才会一条线到底 --- */
.gtd-colhead {
  display: grid; grid-template-columns: var(--gtd-cols); align-items: stretch;
  /* 与任务行等宽的透明外框：差这 0.5px，整列会偏半个像素，看着像没对齐 */
  padding: 0 8px; border: 0.5px solid transparent;
  border-radius: var(--radius-sm); background: var(--surface-panel);
  font-size: 10px; color: var(--surface-muted); letter-spacing: 0.04em;
}
.gtd-colhead > span,
.gtd-item > .gtd-cell {
  display: flex; align-items: center; min-width: 0; overflow: hidden;
  padding: 5px 0 5px 8px;
}
.gtd-colhead .ch-ctx, .gtd-colhead .ch-proj, .gtd-colhead .ch-due, .gtd-colhead .ch-act,
.gtd-item .gtd-cell-ctx, .gtd-item .gtd-cell-proj, .gtd-item .gtd-cell-due, .gtd-item .gtd-act {
  border-left: 0.5px solid var(--surface-border);
}

/* --- 任务区空白处：双击 / 右击就地新建 --- */
/* 底部这条 padding 是「永远点得到的空白」：列表排满时也有地方双击 / 右击 */
.gtd-canvas { flex: 1; min-height: 92px; padding-bottom: 16px; display: flex; flex-direction: column; border-radius: var(--radius-sm); }
.gtd-canvas:hover { box-shadow: inset 0 0 0 0.5px var(--surface-border); }
.gtd-blank-hint {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 6px; padding: 5px 8px;
  border: 0.5px dashed var(--surface-border); border-radius: var(--radius-sm);
  font-size: 11px; color: var(--surface-muted);
}
.gtd-blank-hint-btn { padding: 2px 9px; font-size: 11px; flex: 0 0 auto; }
.gtd-blank-add {
  list-style: none; margin: 2px 0 0; padding: 8px;
  border: 0.5px solid var(--palette-border); border-radius: var(--radius-sm);
  background: var(--palette-soft); display: flex; flex-direction: column; gap: 6px;
}
.gtd-blank-head { font-size: 11px; color: var(--palette-primary); display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
.gtd-blank-tip { color: var(--surface-muted); }
.gtd-blank-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.gtd-blank-in { flex: 1 1 190px; min-width: 140px; font-size: 12px; }
.gtd-blank-fields input, .gtd-blank-fields select { flex: 0 1 132px; min-width: 96px; font-size: 11px; padding: 3px 6px; }
.gtd-blank-go { flex: 0 0 auto; }
.gtd-blank-menu { width: 214px; }

.gtd-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.gtd-item {
  display: grid; grid-template-columns: var(--gtd-cols); align-items: stretch;
  padding: 0 8px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); font-size: 12px; cursor: pointer;
}
.gtd-item:hover { border-color: var(--palette-border); }
.gtd-sel { border-color: var(--palette-primary); box-shadow: inset 2px 0 0 var(--palette-primary); background: var(--palette-soft); }
.gtd-done { opacity: 0.55; text-decoration: line-through; }
.gtd-overdue { border-color: var(--palette-accent); }
.gtd-lead { display: flex; align-items: center; gap: 2px; min-width: 0; padding: 5px 0; }
.gtd-check { border: 0; background: transparent; color: var(--palette-primary); font-size: 13px; width: 22px; flex: 0 0 22px; }
.gtd-cell-title { gap: 6px; }
.gtd-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gtd-tag { padding: 1px 7px; border-radius: 999px; background: var(--surface-panel); color: var(--palette-primary); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gtd-proj { background: var(--palette-soft); }
.gtd-cell-ctx, .gtd-cell-proj, .gtd-cell-due { white-space: nowrap; }
/* 这三格点一下就能改：空格里留个「＋」，鼠标移到行上才显形——
   不给提示的话，没人会去点一块空白 */
.gtd-cell-ctx, .gtd-cell-proj, .gtd-cell-due { cursor: pointer; }
.gtd-cell-plus { color: var(--surface-muted); opacity: 0; font-size: 11px; transition: opacity 120ms; }
.gtd-item:hover .gtd-cell-plus, .gtd-item.gtd-sel .gtd-cell-plus { opacity: 0.5; }
.gtd-cell-open { background: var(--palette-soft); box-shadow: inset 0 0 0 0.5px var(--palette-border); border-radius: 4px; }
.gtd-due { font-variant-numeric: tabular-nums; color: var(--surface-muted); }
.gtd-due-hot { color: var(--palette-accent); font-weight: 500; }
.gtd-wait, .gtd-age { color: var(--surface-muted); flex: 0 0 auto; }
.gtd-gap { opacity: 0.8; font-variant-numeric: tabular-nums; }
.gtd-warn { color: var(--palette-accent); flex: 0 0 auto; }
.gtd-del { border: 0; background: transparent; color: var(--surface-muted); padding: 0 3px; flex: 0 0 auto; }
.gtd-del:hover { color: var(--state-warn); }
.gtd-act { justify-content: flex-end; gap: 2px; }
.gtd-act .mini, .gtd-act .clarify-btn { padding: 2px 6px; font-size: 11px; color: var(--surface-muted); flex: 0 0 auto; }
.gtd-act .mini:hover, .gtd-act .clarify-btn:hover { color: var(--palette-primary); border-color: var(--palette-border); }
/* 行尾「⋯」：右键的等价入口，给不习惯右键的人留一条看得见的路 */
.gtd-more {
  border: 0; background: transparent; color: var(--surface-muted);
  font-size: 13px; line-height: 1; padding: 1px 4px; flex: 0 0 auto; border-radius: var(--radius-sm);
}
.gtd-more:hover { color: var(--palette-primary); background: var(--surface-panel); }
.gtd-empty { padding: 10px; font-size: 12px; color: var(--surface-muted); border: 0.5px dashed var(--surface-border); border-radius: var(--radius-sm); list-style: none; }
/* --- 子任务树：父是容器，子才是能动手的那条 --- */
.gtd-fold { border: 0; background: transparent; color: var(--palette-primary); width: 16px; padding: 0; font-size: 12px; line-height: 1; flex: 0 0 16px; }
.gtd-fold-gap { width: 16px; flex: 0 0 16px; }
.gtd-parent-item { background: var(--surface-panel); }
.gtd-kid-count { padding: 1px 7px; border-radius: 999px; background: var(--palette-soft); color: var(--palette-primary); font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.gtd-kid-count-on { background: var(--surface-raised); color: var(--surface-muted); }
.gtd-up { background: transparent; color: var(--surface-muted); border: 0.5px dashed var(--surface-border); flex: 0 0 auto; }
/* 子行不整体缩进：层级用 ↳ 与浅底表达，缩进会让子行的列比父行右移，列就白对了 */
.gtd-kids-wrap { list-style: none; margin: 0 0 2px; padding: 0; }
.gtd-kids { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.gtd-kid { background: var(--surface-panel); border-style: dashed; }
.gtd-kid-line { color: var(--surface-muted); font-size: 11px; width: 16px; text-align: center; flex: 0 0 16px; }
.gtd-kid-add { display: flex; gap: 6px; margin-top: 4px; }
.kid-in { flex: 1; font-size: 12px; }
.gtd-kid-go { flex: 0 0 auto; }
.gtd-block { list-style: none; margin: 0 0 2px; padding: 6px 10px; border-left: 2px solid var(--palette-accent); background: var(--surface-panel); font-size: 12px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.gtd-block-go { border-color: var(--palette-accent); color: var(--palette-accent); }

/* --- 拖拽归类：拖动中给出「这行可以放下」的明确落点 --- */
.gtd-dragging { opacity: 0.45; border-style: dashed; }
.gtd-side-drop { border-color: var(--palette-primary); box-shadow: 0 0 0 3px var(--palette-soft); }
.gtd-drop-hot {
  background: var(--palette-soft); border-color: var(--palette-primary) !important;
  color: var(--palette-primary) !important; outline: 1px dashed var(--palette-primary); outline-offset: -1px;
}

/* --- 行内改属性的小面板（情境 / 项目 / 到期 + 今日六条） --- */
.gtd-pick {
  position: fixed; z-index: 88; width: 216px; padding: 6px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
  display: flex; flex-direction: column; gap: 2px; font-size: 12px;
}
.gp-head {
  margin: 0 0 4px; font-size: 10px; color: var(--surface-muted);
  display: flex; gap: 6px; align-items: baseline;
}
.gp-sub { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.75; }
.gp-list { display: flex; flex-direction: column; gap: 1px; max-height: 212px; overflow: auto; }
.gp-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 8px; border: 0; border-radius: var(--radius-sm);
  background: transparent; font-size: 12px; text-align: left;
}
.gp-item:hover { background: var(--surface-panel); }
.gp-on { background: var(--palette-soft); color: var(--palette-primary); }
.gp-num { color: var(--surface-muted); font-variant-numeric: tabular-nums; font-size: 10px; }
.gp-clear { color: var(--surface-muted); }
.gp-empty { margin: 4px 8px; font-size: 11px; color: var(--surface-muted); }
.gp-quick { display: flex; gap: 4px; margin-bottom: 4px; }
.gp-quick .mini { flex: 1; padding: 3px 0; font-size: 11px; }
.gp-date { width: 100%; font-size: 11px; padding: 3px 6px; margin-bottom: 4px; }
.gp-sep { height: 0.5px; background: var(--surface-border); margin: 4px 0; }
.gp-focus { color: var(--palette-primary); }

/* --- 分栏右键菜单更窄一点：条目比任务菜单少 --- */
.gtd-side-menu { width: 176px; }

/* --- 右键菜单（fixed 浮层，留在 .workbench 作用域内才能取到皮肤变量） --- */
.gtd-menu {
  position: fixed; z-index: 80; width: 214px; padding: 4px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
  display: flex; flex-direction: column; gap: 1px;
}
.gm-head {
  margin: 2px 4px 0; font-size: 12px; font-weight: 500; color: var(--palette-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gm-meta { margin: 0 4px 4px; font-size: 10px; color: var(--surface-muted); }
.gm-item {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  padding: 5px 8px; border: 0; border-radius: var(--radius-sm); background: transparent; font-size: 12px;
}
.gm-item:hover, .gm-item:focus-visible { background: var(--palette-soft); color: var(--palette-primary); outline: none; }
.gm-label { flex: 1; min-width: 0; }
.gm-hint { font-size: 10px; color: var(--surface-muted); }
.gm-more { font-size: 12px; color: var(--surface-muted); }
.gm-sub { display: flex; flex-direction: column; gap: 1px; margin: 1px 0 3px 8px; padding-left: 4px; border-left: 0.5px solid var(--surface-border); }
.gm-subitem { font-size: 11px; padding: 4px 8px; }
.gm-on { color: var(--palette-primary); }
.gm-check { font-size: 10px; }
.gm-sep { height: 0.5px; margin: 3px 4px; background: var(--surface-border); }
.gm-del .gm-label { color: var(--state-warn); }
.gm-del:hover { background: var(--state-warn-soft); }
.clarify-panel { display: flex; flex-direction: column; gap: 8px; padding: var(--space-2); border: 0.5px solid var(--palette-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.cp-title { font-size: 12px; }
.cp-targets { display: flex; flex-wrap: wrap; gap: 6px; }
.cp-target { display: flex; flex-direction: column; gap: 2px; padding: 5px 10px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); font-size: 12px; }
.gtd-target-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.cp-hint { font-size: 10px; opacity: 0.8; }
.cp-fields { display: flex; flex-wrap: wrap; gap: 6px; }
.cp-in { flex: 1 1 140px; font-size: 12px; }
.cp-actions { display: flex; gap: 6px; }
/* 厘清向导 */
.cp-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.cp-step { font-size: 11px; color: var(--surface-muted); }
.cp-mode {
  margin-left: auto; padding: 2px 9px; border: 0.5px solid var(--surface-border);
  border-radius: 999px; background: transparent; font-size: 11px; color: var(--surface-muted);
}
.cp-x { border: 0; background: transparent; color: var(--surface-muted); font-size: 12px; }
.cp-body { display: flex; flex-direction: column; gap: 8px; }
.cp-q { margin: 0; font-size: 12px; }
.cp-choices { display: flex; flex-wrap: wrap; gap: 6px; }
.cp-choice {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 12px; text-align: left;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); font-size: 12px;
}
.cp-sub { font-size: 10px; color: var(--surface-muted); }
.gtd-target-on .cp-sub { color: inherit; opacity: 0.85; }
.cp-full { flex: 1 1 100%; font-size: 12px; }
.cp-choice-fast { border-style: dashed; }
.note { margin: 0; font-size: 11px; color: var(--surface-muted); line-height: 1.6; }
/* 归类结果的回执：贴在窗口底部浮一层。
   原先跟在正文后面，拖完任务得滚到底才看得见——等于没有反馈 */
.msg {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  z-index: 90; max-width: min(560px, calc(100vw - 40px));
  padding: 8px 14px; border-radius: 999px;
  border: 0.5px solid var(--palette-border);
  background: var(--palette-soft); color: var(--palette-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 12px; line-height: 1.5; text-align: center;
  pointer-events: none;
  animation: msg-in 160ms ease-out;
}
@keyframes msg-in {
  from { opacity: 0; transform: translate(-50%, 8px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}

@media (max-width: 1180px) {
  .gtd-side { flex-basis: 132px; }
  /* 收窄时先收起「项目」列：分栏里点项目就能筛，列不必硬挤；
     栅格同步少一列，否则表头与行会错位 */
  .gtd-main { --gtd-cols: 46px minmax(0, 1fr) 80px 102px 106px; }
  .ch-proj, .gtd-cell-proj { display: none; }
}
</style>
