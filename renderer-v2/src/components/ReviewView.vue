<script setup lang="ts">
// 「回看」按职责拆成两个单一入口，不再共用三 tab：
//   mode='timeline' → 时间轴：只放日记子模块（查找 / 年历 / 历年同日 / 随手重读 / 全部日记）
//   mode='retro'    → 回顾：只放复盘子模块（周月三问 / 九格模块汇总）
// 原「概览」六卡已并入单格洞察模块下方的全局概览区块（InsightView.vue）。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { asArray, callDomain } from '../composables/useDomain';
import { reviewTriplet } from '../composables/promptLibrary';
import { labelText } from '../composables/useReviewFormat';
import { stripMarkdown } from '../composables/useRichText';
import { GRID_KEYS, localDate } from '../types';

const props = defineProps<{ mode: 'timeline' | 'retro' }>();
const isTimeline = computed(() => props.mode === 'timeline');

// --- 复盘（仅回顾）---
const period = ref<'week' | 'month'>('week');
const reviewKey = ref('');
const reviewPrompts = ref<string[]>(['', '', '']);
const answers = ref<string[]>(['', '', '']);
const reviewSaved = ref(false);
const moduleDigest = ref<unknown[]>([]);

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
  // 提问改由渲染层原创题组按周期键确定性抽取；领域层三问仅作兜底，仍是一期三问的数据结构。
  const legacy = await callDomain<string[]>('reviewPrompts', ['', '', ''], period.value);
  const fresh = reviewTriplet(period.value, reviewKey.value);
  reviewPrompts.value = fresh.length === 3 ? fresh : (Array.isArray(legacy) ? legacy.slice(0, 3) : ['', '', '']);
  answers.value = await callDomain<string[]>('loadReview', ['', '', ''], period.value, reviewKey.value);
  reviewSaved.value = false;
}

async function saveRetro(): Promise<void> {
  await callDomain('saveReview', null, period.value, reviewKey.value, answers.value);
  reviewSaved.value = true;
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
      <label v-for="(p, i) in reviewPrompts" :key="i" class="field">{{ i + 1 }}. {{ p }}
        <textarea v-model="answers[i]" class="text" rows="2" maxlength="500"></textarea>
      </label>
      <button class="btn" :class="{ 'btn-on': reviewSaved }" @click="saveRetro">{{ reviewSaved ? '已保存' : '保存复盘三问' }}</button>
      <div class="card"><h2>九格模块汇总（本月）</h2>
        <p v-for="(d, i) in moduleDigest.slice(0, 9)" :key="i" class="line">{{ labelText(d) }}</p>
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
.head h1 { font-size: 15px; font-weight: 500; margin: 0; }
.head p { font-size: 12px; color: var(--surface-muted); margin: 4px 0 0; }
.card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.card h2 { font-size: 13px; font-weight: 500; margin: 0 0 6px; }
.line { font-size: 12px; margin: 2px 0; }
.empty, .muted { font-size: 12px; color: var(--surface-muted); }
.chip { display: inline-block; padding: 2px 8px; margin: 2px; border-radius: 999px; background: var(--surface-raised); font-size: 12px; }
.chip-op { display: inline-flex; align-items: center; gap: 3px; padding-right: 4px; }
.chip-bin {
  width: 14px; height: 14px;
  display: grid; place-items: center;
  border: 0; border-radius: 50%;
  background: transparent; color: var(--surface-muted);
  font-size: 11px; line-height: 1; cursor: pointer;
}
.chip-bin:hover { background: var(--state-warn-soft); color: var(--state-warn); }
.tl-msg { font-size: 12px; color: var(--palette-primary); margin: 0 0 6px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: var(--space-2); }
.text { flex: 1; min-width: 120px; padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; }
.sel { flex: 0 0 110px; }
.btn, .seg { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.btn-on, .seg-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; margin-bottom: var(--space-2); }
.retro, .diary { display: flex; flex-direction: column; gap: var(--space-2); }
.pixels { display: grid; grid-template-columns: repeat(31, 1fr); gap: 2px; margin-top: var(--space-2); }
.px { height: 8px; border-radius: 1px; background: var(--surface-border); }
.px-on { background: var(--palette-accent); }
.dates { display: flex; flex-wrap: wrap; gap: 4px; margin-top: var(--space-2); }

/* 定位 / 过滤 */
.rv-mode { display: inline-flex; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); overflow: hidden; }
.rv-mode-btn { padding: 5px 10px; border: 0; background: var(--surface-raised); font-size: 12px; color: var(--surface-muted); }
.rv-mode-on { background: var(--palette-primary); color: var(--palette-on); }
.rv-tip { font-size: 11px; color: var(--surface-muted); margin: 0 0 var(--space-2); line-height: 1.6; }
.rv-jump { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.rv-count { font-size: 12px; color: var(--palette-primary); }
.rv-mini {
  padding: 2px 8px; border: 0.5px solid var(--surface-border);
  border-radius: 999px; background: var(--surface-raised); font-size: 11px;
}
.rv-mini:disabled { opacity: 0.45; }
.rv-loc { display: flex; flex-direction: column; gap: 3px; max-height: 320px; overflow: auto; }
.rv-loc-row {
  display: flex; gap: 8px; align-items: baseline;
  width: 100%; padding: 3px 8px; text-align: left;
  border: 0.5px solid transparent; border-radius: var(--radius-sm);
  background: transparent; font-size: 12px; color: var(--surface-muted);
}
.rv-loc-row:hover { background: var(--surface-raised); }
.rv-loc-hit { color: var(--surface-text); }
.rv-loc-on {
  border-color: var(--palette-border);
  background: var(--palette-soft);
  color: var(--surface-text);
}
.rv-loc-date { flex: 0 0 auto; font-size: 11px; color: var(--surface-muted); }
.rv-loc-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-loc-n { flex: 0 0 auto; font-size: 10px; color: var(--surface-muted); }
.hl {
  background: var(--palette-accent);
  color: var(--palette-on);
  border-radius: 2px;
  padding: 0 1px;
}

</style>
