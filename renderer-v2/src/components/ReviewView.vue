<script setup lang="ts">
// 「回看」按职责拆成两个单一入口，不再共用三 tab：
//   mode='timeline' → 时间轴：只放日记子模块（查找 / 年历 / 历年同日 / 随手重读 / 全部日记）
//   mode='retro'    → 回顾：只放复盘子模块（周月三问 / 九格模块汇总）
// 原「概览」六卡已并入单格洞察模块下方的全局概览区块（InsightView.vue）。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { asArray, callDomain } from '../composables/useDomain';
import { reviewTriplet, REVIEW_EVIDENCE_QUESTIONS } from '../composables/promptLibrary';
import { labelText } from '../composables/useReviewFormat';
import { stripMarkdown } from '../composables/useRichText';
import { GRID_KEYS, GRID_LABELS, localDate } from '../types';

const props = defineProps<{ mode: 'timeline' | 'retro' }>();
const emit = defineEmits<{ (e: 'changed'): void }>();
const isTimeline = computed(() => props.mode === 'timeline');

// --- 复盘（仅回顾）---
const period = ref<'week' | 'month'>('week');
const reviewKey = ref('');
const reviewPrompts = ref<string[]>(['', '', '']);
const answers = ref<string[]>(['', '', '']);
const reviewSaved = ref(false);
const moduleDigest = ref<unknown[]>([]);
// 领域层 cellStats 会给 label（第 7 格仍叫「梦想」），显示名统一以 GRID_LABELS 为准；
// 同时把 days / chars 补成数值，避免「只有模块名、像渲染失败」的汇总卡。
function digestName(v: unknown): string {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const key = typeof o.key === 'string' ? o.key : '';
  return (key && GRID_LABELS[key]) || (typeof o.label === 'string' ? o.label : labelText(v));
}
function digestVal(v: unknown): string {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const days = typeof o.days === 'number' ? o.days : 0;
  const chars = typeof o.chars === 'number' ? o.chars : 0;
  return days + ' 天 / ' + chars + ' 字';
}

// --- V3.7 复盘证据面板（Check 环）---
// 全部取数走已有 domain 的只读派生：不新增领域层字段、不新增 domain 路由、不改 schema。
// 诚实口径：六条只锚定真实今天、跨天不结转（focusSix），「本周六条完成率」这个数在数据上
// 并不存在；这里只报「今日六条 n/6」+「本周完成任务 N 项」，不编一个跨天百分比。
interface Evidence {
  focusDone: number; focusCount: number; focusStale: boolean;
  doneThisWeek: number;
  recordDays: number; weekDays: number; gridUsed: number;
  goalDoing: number; goalTaskDone: number; goalTaskTotal: number;
  readingNow: number; readingPct: number; readDone: number;
  loaded: boolean;
}
function emptyEvidence(): Evidence {
  return {
    focusDone: 0, focusCount: 0, focusStale: false, doneThisWeek: 0,
    recordDays: 0, weekDays: 0, gridUsed: 0,
    goalDoing: 0, goalTaskDone: 0, goalTaskTotal: 0,
    readingNow: 0, readingPct: 0, readDone: 0, loaded: false
  };
}
const evidence = ref<Evidence>(emptyEvidence());
const evidenceHint = ref('这些数字来自各模块现有记录，只是证据，不是评分。');
const prevNote = ref('');
const prevKeyLabel = ref('');

// --- V3.10 跨期对照（P1-6）---
// 卡片只摆事实：上期那句、它有没有落成「下一步」、那条勾掉没有、这句话被写了几遍。
// 「做到没有」留在第 1、2 问里由人回答 —— 跟上一张卡「不替你打勾」是同一条底线。
// 取数走一条新路由 review.cross（只读派生），它一次回看最近 6 期并带上本期草稿。
interface CrossLink {
  title: string; status: string; statusLabel: string;
  pending: boolean; dueDate: string; dueText: string; doneText: string;
}
interface CrossHist { key: string; label: string; promise: string; sameAsNewer: boolean }
interface CrossView {
  prevKey: string; prevLabel: string; prevPromise: string;
  streak: number; history: CrossHist[]; link: CrossLink | null;
  lookback: number; hasAny: boolean; note: string;
}
const cross = ref<CrossView | null>(null);

const crossReady = computed<boolean>(function () {
  const c = cross.value;
  return !!c && (!!c.prevPromise || c.history.length > 0);
});
// 三种下落：勾掉了 / 还在清单里 / 压根没落成（没有痕迹）。第三种的措辞最要紧
const linkKind = computed<string>(function () {
  const c = cross.value;
  if (!c || !c.prevPromise || !c.link) return 'none';
  return c.link.pending ? 'open' : 'done';
});
const linkText = computed<string>(function () {
  const c = cross.value;
  if (!c || !c.prevPromise) return '';
  const l = c.link;
  if (!l) return '上期那句没落成「下一步」，清单里找不到它的记录 —— 没有痕迹，不等于没做到。';
  if (!l.pending) return '『' + l.title + '』' + (l.doneText ? '已于 ' + l.doneText + ' 勾掉' : '已勾掉') + '。';
  return '『' + l.title + '』还在' + l.statusLabel + (l.dueText ? '（' + l.dueText + '）' : '')
    + ' —— 没勾掉不等于没做到，回第 2 问说清。';
});
const streakText = computed<string>(function () {
  const c = cross.value;
  if (!c || c.streak < 2) return '';
  return '最近 ' + c.streak + ' 期（含本期）第 3 问答的是同一件事 —— 换了说法，事没换。';
});

// 三问固定成「证据 → 归因 → 下期一个改动」；原有轮换题组不删，退成每格的
// 「换个角度」提示。答案仍是 3 元素数组，loadReview / saveReview 的存储结构一字未动。
// 与右栏 ReviewContext 共用 promptLibrary 的同一份常量，不各写一份
const REVIEW_QUESTIONS = REVIEW_EVIDENCE_QUESTIONS;
const actBusy = ref(false);
const actDone = ref(false);
const actMsg = ref('');

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function dateText(d: Date): string {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function mondayOf(today: string): string {
  const d = new Date(today + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dateText(d);
}
// 上期键在渲染层算：领域层 reviewPeriodKey 只认「当前周期」，不给它加参数。
// loadReview(period, key) 本来就接受任意键，读上期无需新增任何存储。
function prevReviewKey(period: 'week' | 'month', key: string): string {
  if (period === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return '';
    const mo = Number(m[2]) - 1;
    return mo < 1 ? (Number(m[1]) - 1) + '-12' : m[1] + '-' + pad2(mo);
  }
  const d = new Date(key + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - 7);
  return dateText(d);
}

interface GtdBoard { stats?: { doneThisWeek?: number }; groups?: { next?: Array<{ title?: string }> } }
interface FocusView { count?: number; doneCount?: number; stale?: boolean }
interface ReadBook { status?: string; pct?: number }
interface ReadBoard { books?: ReadBook[] }
interface DreamRow { status?: string; taskDone?: number; taskTotal?: number }
interface DreamBoard { rows?: DreamRow[] }
interface DigestRow { days?: number }

async function loadEvidence(): Promise<void> {
  const today = localDate();
  const monday = mondayOf(today);
  const [gb, fc, rb, db, md, wd] = await Promise.all([
    callDomain<GtdBoard>('gtd.board', {}, today),
    callDomain<FocusView>('gtd.focus', {}, today),
    callDomain<ReadBoard>('reading.board', {}),
    callDomain<DreamBoard>('dream.board', {}, today),
    callDomain<unknown>('moduleDigest', { rows: [] }, 'week'),
    callDomain<unknown>('writtenDates', [])
  ]);
  const dates = asArray<unknown>(wd).map(function (x) {
    return typeof x === 'string' ? x : labelText(x);
  });
  const seen: Record<string, boolean> = {};
  dates.forEach(function (d) { if (d >= monday && d <= today) seen[d] = true; });
  const span = Math.round((new Date(today + 'T00:00:00').getTime() - new Date(monday + 'T00:00:00').getTime()) / 86400000) + 1;
  const digestRows = asArray<DigestRow>(md);
  const books = Array.isArray(rb.books) ? rb.books : [];
  const reading = books.filter(function (b) { return !!b && b.status === 'reading'; });
  const pctSum = reading.reduce(function (n, b) { return n + (typeof b.pct === 'number' ? b.pct : 0); }, 0);
  const rows = Array.isArray(db.rows) ? db.rows : [];
  const doneThisWeek = Number(gb.stats && gb.stats.doneThisWeek) || 0;
  const goalTaskTotal = rows.reduce(function (n, r) { return n + (Number(r.taskTotal) || 0); }, 0);
  evidence.value = {
    focusDone: Number(fc.doneCount) || 0,
    focusCount: Number(fc.count) || 0,
    focusStale: fc.stale === true,
    doneThisWeek: doneThisWeek,
    recordDays: Object.keys(seen).length,
    weekDays: Math.max(1, Math.min(7, span)),
    gridUsed: digestRows.filter(function (r) { return Number(r && r.days) > 0; }).length,
    goalDoing: rows.filter(function (r) { return r.status === 'doing'; }).length,
    goalTaskDone: rows.reduce(function (n, r) { return n + (Number(r.taskDone) || 0); }, 0),
    goalTaskTotal: goalTaskTotal,
    readingNow: reading.length,
    readingPct: reading.length ? Math.round(pctSum / reading.length) : 0,
    readDone: books.filter(function (b) { return !!b && b.status === 'done'; }).length,
    loaded: true
  };
  const noData = !Object.keys(seen).length && !doneThisWeek && !goalTaskTotal && !books.length;
  evidenceHint.value = noData
    ? '各模块还没有可回看的记录，这里不显示估算值。先写几天，证据自己会来。'
    : '这些数字来自各模块现有记录，只是证据，不是评分；六条只锚定今天，不做跨天完成率。';
}

// --- 日记（仅时间轴）---
const written = ref<string[]>([]);
const keyword = ref('');
const moodFilter = ref('');
const hits = ref<unknown[]>([]);
const year = ref(new Date().getFullYear());
const pixels = ref<Array<{ blank?: boolean; written?: boolean; cls?: string; date?: string }>>([]);
const pixelCount = ref(0);
const sameDay = ref<unknown[]>([]);
const randomPick = ref<Record<string, unknown> | null>(null);

const pixelFilled = computed(() => pixels.value.filter(function (p) { return !!p.written; }).length);
const pixelOn = function (p: { blank?: boolean; written?: boolean; cls?: string }): boolean {
  return !p.blank && !!p.written;
};

async function loadRetro(): Promise<void> {
  // reviewPeriodKey 只接受 period：周取本周起始日、月取 YYYY-MM。
  // 旧写法多传了一个日期，导致「月复盘」被存到周键下，切周期就会读到错的内容。
  reviewKey.value = await callDomain<string>('reviewPeriodKey', '', period.value);
  // 轮换题组现在只作「换个角度」提示，三问标题固定成证据 → 归因 → 一个改动。
  const legacy = await callDomain<string[]>('reviewPrompts', ['', '', ''], period.value);
  const fresh = reviewTriplet(period.value, reviewKey.value);
  reviewPrompts.value = fresh.length === 3 ? fresh : (Array.isArray(legacy) ? legacy.slice(0, 3) : ['', '', '']);
  answers.value = await callDomain<string[]>('loadReview', ['', '', ''], period.value, reviewKey.value);
  reviewSaved.value = false;
  actMsg.value = '';
  actDone.value = false;
  // 跨期对照与本期证据并发取：两件事都是只读，互不阻塞。
  await loadCross();
}

// 跨期对照取数：路由回看最近 6 期（含本期草稿），并把本期证据一起并发回来。
// 本期草稿要传进去——用户刚敲的那句还没保存，也该立刻参与「是不是同一件事」的判断。
async function loadCross(): Promise<void> {
  const p = period.value;
  const cur = reviewKey.value;
  const [c] = await Promise.all([
    callDomain<CrossView | null>('review.cross', null, p, cur, String(answers.value[2] || '')),
    loadEvidence()
  ]);
  cross.value = c && typeof c === 'object' ? c : null;
  prevNote.value = String((c && c.prevPromise) || '').trim();
  // 周期键标签以领域层算的为准；数据没回来时退回渲染层这份，首屏标签不至于空着
  const pKey = prevReviewKey(p, cur);
  prevKeyLabel.value = (c && c.prevLabel) || (pKey ? (p === 'month' ? pKey : pKey.slice(5)) : '');
}

async function saveRetro(): Promise<void> {
  await callDomain('saveReview', null, period.value, reviewKey.value, answers.value);
  reviewSaved.value = true;
  // 右栏「复盘完成度」也得跟着涨，否则刚存满三问它还写着旧数字
  emit('changed');
}

// Act 环：把第 3 问落成一条 GTD「下一步」任务。
// 不直接占今日六条——六条只存指针且锚定真实今天、跨天不结转，写进去下期也看不见。
// 这是本页唯一的写操作，必须由用户主动点击，且先去重、再复核、后给明确去向。
async function pushAct(): Promise<void> {
  const text = String(answers.value[2] || '').trim();
  if (!text || actBusy.value || actDone.value) {
    actMsg.value = '先把第 3 问写成一条能动手的事，再落成下一步。';
    return;
  }
  actBusy.value = true;
  try {
    const title = text.slice(0, 60);
    const before = await callDomain<GtdBoard>('gtd.board', {}, localDate());
    const hasSame = ((before.groups && before.groups.next) || []).some(function (t) {
      return String((t && t.title) || '').trim() === title;
    });
    if (hasSame) {
      actMsg.value = '清单里已有同名「下一步」，没有重复建。';
      actDone.value = true;
      return;
    }
    // 周复盘 → 下周一；月复盘 → 下月 1 号。只给个日期，不替用户排进六条。
    const today = localDate();
    const d = new Date(today + 'T00:00:00');
    let due = '';
    if (period.value === 'month') {
      due = (d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear())
        + '-' + pad2(d.getMonth() === 11 ? 1 : d.getMonth() + 2) + '-01';
    } else {
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7);
      due = dateText(d);
    }
    await callDomain('gtd.add', null, {
      title: title,
      status: 'next',
      dueDate: due,
      note: '来自 ' + reviewKey.value + (period.value === 'month' ? ' 月复盘' : ' 周复盘') + '的第 3 问',
      // 周期键写进 source：下期「跨期对照」靠它把承诺和下落连起来。
      // 老任务只有 source='review'、键写在 note 里，领域层两种都认。
      source: 'review:' + period.value + ':' + reviewKey.value
    });
    // 不信任写接口的返回形态：再读一次清单，确认那条真的出现才报成功。
    const after = await callDomain<GtdBoard>('gtd.board', {}, localDate());
    const created = ((after.groups && after.groups.next) || []).some(function (t) {
      return String((t && t.title) || '').trim() === title;
    });
    actMsg.value = created
      ? '已建成「下一步」并定在 ' + due + '；下期在「今日六条」里挑它，六条本身不结转。'
      : '没建成（清单可能已满），请到 GTD 工作台手动加一条。';
    actDone.value = created;
    if (created) emit('changed');
  } finally {
    actBusy.value = false;
  }
}

async function doSearch(): Promise<void> {
  hits.value = asArray(await callDomain<unknown>('search', [], keyword.value, moodFilter.value));
}

// --- 查找的两种模式：定位 ≠ 过滤 ---
// 定位：列表一篇不少，只把命中处高亮、回车跳到下一处——你要知道它在时间里的位置，
//       一旦筛掉上下文，就只剩"有一条命中"，看不出前后发生了什么。
// 过滤：只留匹配条目——你要的是一份清单，不是位置。
type FindMode = 'locate' | 'filter';
const searchMode = ref<FindMode>('locate');
const LOC_LIMIT = 60;
interface LocRow { date: string; text: string; excerpt: string; count: number }
const rawRows = ref<Array<{ date: string; text: string }>>([]);
const activeIdx = ref(0);

// 一篇日记压成一行纯文本：栏目名不进正文（否则搜「工作」会命中所有带工作格的篇）
function textOf(rec: Record<string, unknown>): string {
  const cells = (rec.cells || {}) as Record<string, string>;
  const base = (rec.base || {}) as Record<string, string>;
  const parts: string[] = [];
  [['mood', '心情'], ['weather', '天气'], ['anniversary', '纪念日'], ['body', '正文']].forEach(function (pair) {
    const v = String(base[pair[0]] || '').trim();
    if (v) parts.push('【' + pair[1] + '】' + v);
  });
  GRID_KEYS.forEach(function (k) {
    const v = String(cells[k] || '').trim();
    if (v) parts.push(stripMarkdown(v));
  });
  return parts.join(' · ').replace(/\s+/g, ' ').trim();
}

// 摘要取「第一处命中前后」，否则命中在 300 字之后，行里根本看不见高亮
function excerptAround(text: string, kw: string): { excerpt: string; count: number } {
  if (!kw) return { excerpt: text.slice(0, 110) + (text.length > 110 ? '…' : ''), count: 0 };
  const lower = text.toLowerCase();
  const k = kw.toLowerCase();
  let count = 0;
  let first = -1;
  let from = 0;
  while (from <= lower.length) {
    const at = lower.indexOf(k, from);
    if (at < 0) break;
    if (first < 0) first = at;
    count += 1;
    from = at + k.length;
    if (count > 99) break;
  }
  if (first < 0) return { excerpt: text.slice(0, 110) + (text.length > 110 ? '…' : ''), count: 0 };
  const start = Math.max(0, first - 24);
  const end = Math.min(text.length, start + 130);
  return {
    excerpt: (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''),
    count: count
  };
}

const rows = computed<LocRow[]>(function () {
  const kw = keyword.value.trim();
  return rawRows.value.map(function (r) {
    const got = excerptAround(r.text, kw);
    return { date: r.date, text: r.text, excerpt: got.excerpt, count: got.count };
  });
});
const viewRows = computed<LocRow[]>(function () {
  return rows.value.slice(0, LOC_LIMIT);
});
// 只在「画出来的这 60 篇」里取命中：否则计数说「第 5 / 12 处」，
// 而第 5 处根本不在列表里，跳过去是一片空白
const matchRows = computed<LocRow[]>(function () {
  return viewRows.value.filter(function (r) { return r.count > 0; });
});
// 命中全在更早的篇目里（超出 60 篇窗口）时，得说清楚去哪儿找
const hiddenHits = computed<number>(function () {
  const all = rows.value.filter(function (r) { return r.count > 0; }).length;
  return all - matchRows.value.length;
});
const activeDate = computed<string>(function () {
  const hit = matchRows.value[activeIdx.value];
  return hit ? hit.date : '';
});
const activeNo = computed<number>(function () {
  return matchRows.value.length ? Math.min(activeIdx.value + 1, matchRows.value.length) : 0;
});
// 没命中时必须说清「列表还是全的」——否则用户会以为搜出来是空的，跟过滤没区别
const countText = computed<string>(function () {
  if (!keyword.value.trim()) return '共 ' + rows.value.length + ' 篇';
  if (matchRows.value.length) return '第 ' + activeNo.value + ' / ' + matchRows.value.length + ' 处';
  if (hiddenHits.value > 0) return '这 ' + LOC_LIMIT + ' 篇里没有 · 更早还有 ' + hiddenHits.value + ' 处，切「过滤」看';
  return '没有命中 · 列表仍是 ' + rows.value.length + ' 篇';
});

// 高亮不引新依赖、也不把正文当 HTML 直插：按命中位置切段渲染，CSP 下没有注入面
function segments(text: string): Array<{ text: string; hit: boolean }> {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return [{ text: text, hit: false }];
  const lower = text.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(kw, i);
    if (at < 0) { out.push({ text: text.slice(i), hit: false }); break; }
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + kw.length), hit: true });
    i = at + kw.length;
  }
  return out;
}

function scrollToActive(): void {
  const el = document.querySelector('.rv-loc-on');
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
}

async function jump(delta: number): Promise<void> {
  const n = matchRows.value.length;
  if (!n) return;
  activeIdx.value = (activeIdx.value + delta + n) % n;
  await nextTick();
  scrollToActive();
}

function selectRow(r: LocRow): void {
  if (!r.count) return;
  const at = matchRows.value.findIndex(function (x) { return x.date === r.date; });
  if (at >= 0) activeIdx.value = at;
}

// 输入即定位：打完第一个字就能看见第一处，不必先按按钮
watch(keyword, async function () {
  activeIdx.value = 0;
  await nextTick();
  if (searchMode.value === 'locate') scrollToActive();
});

function setMode(m: FindMode): void {
  searchMode.value = m;
  // 切模式不保留旧结果：过滤模式下的命中是服务端筛过的，定位模式要的是全量
  if (m === 'filter') { void doSearch(); } else { activeIdx.value = 0; void nextTick().then(scrollToActive); }
}

// 按钮与 Enter 共用一条路径：shift 决定方向，模式决定语义
function step(shift: boolean): void {
  if (searchMode.value === 'filter') { void doSearch(); return; }
  void jump(shift ? -1 : 1);
}

async function loadYear(): Promise<void> {
  const raw = await callDomain<{ months?: Array<{ cells: Array<{ blank?: boolean; written?: boolean; cls?: string; date?: string }> }>; writtenCount?: number }>('yearPixels', { months: [], writtenCount: 0 }, year.value);
  const months = (raw && Array.isArray(raw.months)) ? raw.months : [];
  const flat: Array<{ blank?: boolean; written?: boolean; cls?: string; date?: string }> = [];
  months.forEach(function (m) { (m.cells || []).forEach(function (c) { flat.push(c); }); });
  pixels.value = flat;
  pixelCount.value = Number(raw && raw.writtenCount) || 0;
}

async function randomEntry(): Promise<void> {
  randomPick.value = await callDomain<Record<string, unknown> | null>('randomEntry', null, localDate());
}

// 只加载本视图需要的领域数据，不再两个页面都全量拉一遍
async function loadTimeline(): Promise<void> {
  const [wr, sd, all] = await Promise.all([
    callDomain<unknown[]>('writtenDates', []),
    callDomain<unknown>('sameDayAcrossYears', [], localDate().slice(5)),
    callDomain<unknown[]>('all', [])
  ]);
  written.value = asArray(wr).map(labelText);
  sameDay.value = asArray(sd);
  // 定位模式要「列表不动」，所以这里取全量正文压成一行；过滤模式仍走服务端 search
  rawRows.value = asArray<Record<string, unknown>>(all)
    .map(function (rec) {
      return { date: String((rec && rec.date) || ''), text: textOf(rec || {}) };
    })
    .filter(function (r) { return !!r.date && !!r.text; })
    .sort(function (a, b) { return b.date.localeCompare(a.date); });
}

// 封存：删掉的东西先去封存箱待 30 天，不是立刻销毁
const timelineMsg = ref('');

async function seal(date: string): Promise<void> {
  const res = await callDomain<{ error?: string }>('recycle.seal', {}, date);
  if (res && res.error) {
    timelineMsg.value = date + ' 封存失败：' + res.error;
    return;
  }
  timelineMsg.value = date + ' 已放进封存箱，30 天内可还原';
  await loadTimeline();
  await loadYear();
}

onMounted(async () => {
  if (!isTimeline.value) {
    const md = await callDomain<{ rows?: unknown[] }>('moduleDigest', { rows: [] }, 'month');
    moduleDigest.value = asArray(md);
    await loadRetro();
    return;
  }
  await loadTimeline();
  await loadYear();
});
</script>

<template>
  <section class="review">
    <header class="head">
      <h1 v-if="isTimeline">时间轴 · 日记回看</h1>
      <h1 v-else>回顾 · 周 / 月复盘</h1>
    </header>

    <div v-if="!isTimeline" class="retro">
      <div class="row">
        <button class="seg" :class="{ 'seg-on': period === 'week' }" @click="period = 'week'; loadRetro()">周复盘</button>
        <button class="seg" :class="{ 'seg-on': period === 'month' }" @click="period = 'month'; loadRetro()">月复盘</button>
        <span class="muted">周期键 {{ reviewKey }}</span>
      </div>
      <!-- Check 环：本期证据。五格全是现有模块的只读派生，不给估算值、不给评分 -->
      <div class="card rv-evidence" aria-label="本期证据">
        <h2>本期证据 · 只读</h2>
        <p class="rv-hint">{{ evidenceHint }}</p>
        <div class="rv-ev-grid">
          <div class="rv-ev-cell">
            <span class="rv-ev-label">今日六条</span>
            <strong class="rv-ev-val">{{ evidence.focusCount ? evidence.focusDone + ' / ' + evidence.focusCount : '—' }}</strong>
            <span class="rv-ev-note">{{ evidence.focusStale ? '昨天那组不结转' : '六条只锚定今天' }}</span>
          </div>
          <div class="rv-ev-cell">
            <span class="rv-ev-label">本周完成</span>
            <strong class="rv-ev-val">{{ evidence.doneThisWeek }}<span class="rv-ev-unit"> 项</span></strong>
            <span class="rv-ev-note">GTD 已勾掉的任务</span>
          </div>
          <div class="rv-ev-cell">
            <span class="rv-ev-label">落笔天数</span>
            <strong class="rv-ev-val">{{ evidence.recordDays }} / {{ evidence.weekDays }}</strong>
            <span class="rv-ev-note">本周九格写过 {{ evidence.gridUsed }} / 9 格</span>
          </div>
          <div class="rv-ev-cell">
            <span class="rv-ev-label">目标推进</span>
            <strong class="rv-ev-val">{{ evidence.goalTaskDone }} / {{ evidence.goalTaskTotal }}</strong>
            <span class="rv-ev-note">关联行动完成 · 在推 {{ evidence.goalDoing }} 个</span>
          </div>
          <div class="rv-ev-cell">
            <span class="rv-ev-label">在读书</span>
            <strong class="rv-ev-val">{{ evidence.readingNow }}<span class="rv-ev-unit"> 本</span></strong>
            <span class="rv-ev-note">平均 {{ evidence.readingPct }}% · 已读完 {{ evidence.readDone }} 本</span>
          </div>
        </div>
        <p v-if="!evidence.loaded" class="empty">正在读各模块的记录…</p>
      </div>

      <!-- 跨期对照（P1-6）：上期那句 + 它后来怎么样了。只摆事实，不替人判定做到没有 -->
      <div v-if="crossReady" class="card rv-prev rv-cross">
        <h2 v-if="prevNote">上期（{{ prevKeyLabel || '—' }}）留的一句</h2>
        <h2 v-else>上期（{{ prevKeyLabel || '—' }}）没留下那一句</h2>
        <p v-if="prevNote" class="rv-prev-text">
          {{ prevNote }}<span class="rv-prev-tip"> · 做到与否，在第 1、2 问里判断，这里不替你打勾</span>
        </p>
        <p v-else class="rv-cross-empty">
          「下期只改哪一条」那格空着，对照链从这里断了 —— 本期补上，下期才有得比。
        </p>

        <div v-if="prevNote" class="rv-cross-link" :class="'rv-cross-' + linkKind">
          <span class="rv-cross-k">那句话后来</span>
          <span class="rv-cross-v">{{ linkText }}</span>
        </div>

        <p v-if="streakText" class="rv-cross-repeat">{{ streakText }}</p>

        <div v-if="cross && cross.history.length" class="rv-cross-hist">
          <span class="rv-cross-k rv-hist-head">前几期</span>
          <div v-for="h in cross.history" :key="h.key" class="rv-hist-row">
            <span class="rv-hist-key">{{ h.label }}</span>
            <span class="rv-hist-text">{{ h.promise }}</span>
            <span v-if="h.sameAsNewer" class="rv-hist-same">同上</span>
          </div>
        </div>
        <p v-if="cross" class="rv-cross-note">{{ cross.note }}</p>
      </div>

      <!-- 三问：证据 → 归因 → 一个改动；轮换题组退成标题行里的「换个角度」提示 -->
      <label v-for="(q, i) in REVIEW_QUESTIONS" :key="i" class="field rv-field">
        <span class="rv-q-title">{{ i + 1 }}. {{ q }}
          <em v-if="reviewPrompts[i]" class="rv-q-hint">换个角度：{{ reviewPrompts[i] }}</em>
        </span>
        <textarea v-model="answers[i]" class="text" rows="2" maxlength="500" :placeholder="reviewPrompts[i] || ''"></textarea>
      </label>
      <div class="row rv-act-row">
        <button class="btn" :class="{ 'btn-on': reviewSaved }" @click="saveRetro">{{ reviewSaved ? '已保存' : '保存复盘三问' }}</button>
        <button class="btn rv-act-btn" :disabled="actBusy || actDone || !answers[2]" @click="pushAct">
          {{ actDone ? '已落成下一步' : '把第 3 问落成下一步 →' }}
        </button>
        <span class="muted">不占今日六条</span>
      </div>
      <p v-if="actMsg" class="rv-act-msg" role="status">{{ actMsg }}</p>
      <div class="card"><h2>九格模块汇总（本月）</h2>
        <div class="digest-grid">
          <div v-for="(d, i) in moduleDigest.slice(0, 9)" :key="i" class="digest-cell">
            <span class="dg-name">{{ digestName(d) }}</span>
            <strong class="dg-val">{{ digestVal(d) }}</strong>
          </div>
        </div>
        <p v-if="moduleDigest.length === 0" class="empty">暂无模块汇总</p>
      </div>
    </div>

    <div v-else class="diary">
      <div class="card rv-find"><h2>关键词查找（正文 / 栏目 / 心情）</h2>
        <div class="row">
          <div class="rv-mode" role="group" aria-label="查找方式">
            <button
              class="rv-mode-btn"
              :class="{ 'rv-mode-on': searchMode === 'locate' }"
              :aria-pressed="searchMode === 'locate'"
              @click="setMode('locate')"
            >定位</button>
            <button
              class="rv-mode-btn"
              :class="{ 'rv-mode-on': searchMode === 'filter' }"
              :aria-pressed="searchMode === 'filter'"
              @click="setMode('filter')"
            >过滤</button>
          </div>
          <input
            v-model="keyword"
            class="text"
            placeholder="正文 / 栏目关键词"
            aria-label="关键词"
            @keydown.enter.prevent="step($event.shiftKey)"
          />
          <select
            v-model="moodFilter"
            class="text sel"
            :disabled="searchMode === 'locate'"
            :title="searchMode === 'locate' ? '心情筛选属于「过滤」；要按心情筛请先切到过滤' : ''"
          >
            <option value="">全部心情</option><option value="愉悦">愉悦</option><option value="平静">平静</option>
            <option value="一般">一般</option><option value="低落">低落</option><option value="烦躁">烦躁</option>
          </select>
          <button class="btn" @click="step(false)">{{ searchMode === 'locate' ? '下一处' : '查找' }}</button>
        </div>
        <p class="rv-tip">
          {{ searchMode === 'locate'
            ? '定位：跳到下一处（Enter / Shift+Enter）'
            : '过滤：只留下匹配条目' }}
        </p>

        <template v-if="searchMode === 'locate'">
          <div class="rv-jump">
            <span class="rv-count">{{ countText }}</span>
            <button class="rv-mini" :disabled="!matchRows.length" @click="jump(-1)">↑ 上一处</button>
            <button class="rv-mini" :disabled="!matchRows.length" @click="jump(1)">↓ 下一处</button>
            <span v-if="rawRows.length > LOC_LIMIT" class="muted">只列最近 {{ LOC_LIMIT }} 篇（共 {{ rawRows.length }} 篇）</span>
          </div>
          <div class="rv-loc">
            <button
              v-for="r in viewRows"
              :key="r.date"
              class="rv-loc-row"
              :class="{ 'rv-loc-on': r.date === activeDate, 'rv-loc-hit': r.count > 0 }"
              :aria-label="r.date + (r.count ? '，命中 ' + r.count + ' 处' : '，无命中')"
              @click="selectRow(r)"
            >
              <span class="rv-loc-date">{{ r.date }}</span>
              <span class="rv-loc-text"><template v-for="(seg, i) in segments(r.excerpt)" :key="i"><mark v-if="seg.hit" class="hl">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></span>
              <span v-if="r.count > 1" class="rv-loc-n">×{{ r.count }}</span>
            </button>
            <p v-if="!viewRows.length" class="empty">还没有记录</p>
          </div>
        </template>

        <template v-else>
          <p v-for="(h, i) in hits.slice(0, 20)" :key="i" class="line"><template v-for="(seg, j) in segments(labelText(h))" :key="j"><mark v-if="seg.hit" class="hl">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></p>
          <p v-if="hits.length === 0" class="empty">没有找到匹配的日记</p>
        </template>
      </div>
      <div class="card"><h2>全年像素年历</h2>
        <div class="row">
          <button class="seg" @click="year--; loadYear()">上一年</button>
          <span class="muted">{{ year }} 年 · {{ pixelCount }} 天有记录 · 固定 372 格（12 月 × 31 天）</span>
          <button class="seg" :disabled="year >= new Date().getFullYear()" @click="year++; loadYear()">下一年</button>
        </div>
        <div class="pixels"><span v-for="(p, i) in pixels" :key="i" class="px"
          :class="{ 'px-on': pixelOn(p) }" :title="p.date || ''"></span></div>
        <p class="muted">当前视图高亮 {{ pixelFilled }} 格</p>
      </div>
      <div class="card"><h2>历年同日 / 随手重读 / 全部日记</h2>
        <div class="row"><button class="btn" @click="randomEntry">随手重读一篇</button></div>
        <p v-if="randomPick" class="line">{{ randomPick.date }} · {{ labelText(randomPick) }}</p>
        <p v-for="(s, i) in sameDay.slice(0, 6)" :key="'s' + i" class="line">{{ labelText(s) }}</p>
        <p v-if="timelineMsg" class="tl-msg" role="status">{{ timelineMsg }}</p>
        <div class="dates">
          <span v-for="d in written.slice(0, 40)" :key="d" class="chip chip-op">
            {{ d }}
            <button
              class="chip-bin"
              :aria-label="'封存 ' + d"
              title="封存到封存箱（30 天内可还原）"
              @click="seal(d)"
            >×</button>
          </span>
        </div>
        <p class="muted">共 {{ written.length }} 篇 · 按日期倒序</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.review { display: flex; flex-direction: column; gap: var(--space-2); }
.head h1 { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.head p { font-size: var(--text-sm); color: var(--surface-muted); margin: 4px 0 0; }
.card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.card h2 { font-size: var(--text-body); font-weight: 500; margin: 0 0 6px; }
.line { font-size: var(--text-sm); margin: 2px 0; }
.empty, .muted { font-size: var(--text-sm); color: var(--surface-muted); }
.chip { display: inline-block; padding: 2px 8px; margin: 2px; border-radius: 999px; background: var(--surface-raised); font-size: var(--text-sm); }
.chip-op { display: inline-flex; align-items: center; gap: 3px; padding-right: 4px; }
.chip-bin {
  width: 14px; height: 14px;
  display: grid; place-items: center;
  border: 0; border-radius: 50%;
  background: transparent; color: var(--surface-muted);
  font-size: var(--text-xs); line-height: 1; cursor: pointer;
}
.chip-bin:hover { background: var(--state-warn-soft); color: var(--state-warn); }
.tl-msg { font-size: var(--text-sm); color: var(--palette-primary); margin: 0 0 6px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: var(--space-2); }
.text { flex: 1; min-width: 120px; padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; }
.sel { flex: 0 0 110px; }
.btn, .seg { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.btn-on, .seg-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.field { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-sm); margin-bottom: var(--space-2); }
.retro, .diary { display: flex; flex-direction: column; gap: var(--space-2); }
.pixels { display: grid; grid-template-columns: repeat(31, 1fr); gap: 2px; margin-top: var(--space-2); }
.px { height: 8px; border-radius: 1px; background: var(--surface-border); }
.px-on { background: var(--palette-accent); }
.dates { display: flex; flex-wrap: wrap; gap: 4px; margin-top: var(--space-2); }

/* 定位 / 过滤 */
.rv-mode { display: inline-flex; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); overflow: hidden; }
.rv-mode-btn { padding: 5px 10px; border: 0; background: var(--surface-raised); font-size: var(--text-sm); color: var(--surface-muted); }
.rv-mode-on { background: var(--palette-primary); color: var(--palette-on); }
.rv-tip { font-size: var(--text-xs); color: var(--surface-muted); margin: 0 0 var(--space-2); line-height: 1.6; }
.rv-jump { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.rv-count { font-size: var(--text-sm); color: var(--palette-primary); }
.rv-mini {
  padding: 2px 8px; border: 0.5px solid var(--surface-border);
  border-radius: 999px; background: var(--surface-raised); font-size: var(--text-xs);
}
.rv-mini:disabled { opacity: 0.45; }
.rv-loc { display: flex; flex-direction: column; gap: 3px; max-height: 320px; overflow: auto; }
.rv-loc-row {
  display: flex; gap: 8px; align-items: baseline;
  width: 100%; padding: 3px 8px; text-align: left;
  border: 0.5px solid transparent; border-radius: var(--radius-sm);
  background: transparent; font-size: var(--text-sm); color: var(--surface-muted);
}
.rv-loc-row:hover { background: var(--surface-raised); }
.rv-loc-hit { color: var(--surface-text); }
.rv-loc-on {
  border-color: var(--palette-border);
  background: var(--palette-soft);
  color: var(--surface-text);
}
.rv-loc-date { flex: 0 0 auto; font-size: var(--text-xs); color: var(--surface-muted); }
.rv-loc-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-loc-n { flex: 0 0 auto; font-size: var(--text-xs); color: var(--surface-muted); }
.hl {
  background: var(--palette-accent);
  color: var(--palette-on);
  border-radius: 2px;
  padding: 0 1px;
}

.digest-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.digest-cell {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 8px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel);
}
.dg-name { font-size: var(--text-xs); color: var(--surface-muted); }
.dg-val { font-size: var(--text-h2); font-weight: 500; font-variant-numeric: tabular-nums; }
@media (max-width: 1120px) { .digest-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* V3.7 复盘证据面板：五格等宽，窄屏降三列；数值用 tabular-nums 对齐 */
.rv-hint { font-size: var(--text-xs); color: var(--surface-muted); margin: 0 0 var(--space-2); line-height: 1.6; }
.rv-ev-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.rv-ev-cell {
  display: flex; flex-direction: column; gap: 2px; padding: 8px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); min-width: 0;
}
.rv-ev-label { font-size: var(--text-xs); color: var(--surface-muted); }
.rv-ev-val { font-size: var(--text-h2); font-weight: 500; font-variant-numeric: tabular-nums; }
.rv-ev-unit { font-size: var(--text-xs); font-weight: 400; }
.rv-ev-note { font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.4; }
.rv-prev-text {
  font-size: var(--text-sm); margin: 0; padding: 5px 10px;
  border-left: 2px solid var(--palette-primary); background: var(--palette-soft);
  line-height: 1.6;
}

/* V3.10 跨期对照：上期承诺 → 后来怎么样了。三种下落各给一件外衣：
   勾掉（品牌色）/ 还在清单（警示色）/ 没落成（无底色，只是灰字说明没痕迹） */
.rv-cross-empty { font-size: var(--text-sm); color: var(--surface-muted); margin: 0; line-height: 1.6; }
.rv-cross-link {
  display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
  margin-top: 6px; padding: 5px 10px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); font-size: var(--text-sm); line-height: 1.6;
}
.rv-cross-done { border-color: var(--palette-border); background: var(--palette-soft); }
.rv-cross-open { border-color: var(--state-warn); background: var(--state-warn-soft); }
/* 没落成用虚框：形状在、内容不在——别让人把这条看成一条实打实的记录 */
.rv-cross-none { border-style: dashed; }
.rv-cross-k { flex: 0 0 auto; font-size: var(--text-xs); color: var(--surface-muted); }
.rv-cross-v { flex: 1 1 180px; min-width: 0; }
.rv-cross-repeat { font-size: var(--text-sm); margin: 6px 0 0; color: var(--palette-primary); line-height: 1.6; }
/* 前几期：日期列固定宽，几期的话竖着对齐；「同上」独立一列贴在行尾 */
.rv-cross-hist { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
.rv-hist-head { margin-bottom: 1px; }
.rv-hist-row { display: flex; gap: 8px; align-items: baseline; font-size: var(--text-sm); }
.rv-hist-key { flex: 0 0 46px; font-size: var(--text-xs); color: var(--surface-muted); font-variant-numeric: tabular-nums; }
.rv-hist-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-hist-same { flex: 0 0 auto; font-size: var(--text-xs); color: var(--state-warn); }
.rv-cross-note { font-size: var(--text-xs); color: var(--surface-muted); margin: 6px 0 0; line-height: 1.5; }
.rv-prev-tip { font-size: var(--text-xs); color: var(--surface-muted); }
.rv-field { gap: 4px; }
.rv-q-title { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: var(--text-sm); }
.rv-q-hint { font-style: normal; font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.5; }
.rv-act-row { margin-bottom: 0; }
.rv-act-btn { border-color: var(--palette-primary); color: var(--palette-primary); }
.rv-act-btn:disabled { opacity: 0.45; }
.rv-act-msg { font-size: var(--text-sm); color: var(--palette-primary); margin: 0; line-height: 1.6; }
@media (max-width: 1120px) { .rv-ev-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
</style>
