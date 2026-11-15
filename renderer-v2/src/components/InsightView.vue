<script setup lang="ts">
// 二级模块：上半部是「单格立式洞察」（cell-insights.analyze 全量结果），
// 下半部是「全局概览」（原回顾·概览六卡，按主理人规划并入此处）。
// 时间轴只管日记、回顾只管复盘，三个入口不再共享重复下级功能。
import { computed, onMounted, ref } from 'vue';
import { asArray, callDomain } from '../composables/useDomain';
import { labelText, objectRows } from '../composables/useReviewFormat';
import { GRID_KEYS, GRID_LABELS, localDate } from '../types';

interface Metric { label: string; value: unknown; unit: string }
interface HeatCell { date: string; day: string; cls: string }
interface Coverage { label: string; count: number; pct: number; cls: string }
interface Phrase { word: string; count: number; days: number }
interface Excerpt { date: string; text: string }
interface MoodItem { label: string; count: number }
interface Compare {
  daysNow: number; daysPrev: number; charsNow: number; charsPrev: number;
  daysDelta: number; charsDelta: number;
}
interface Insight {
  key: string; axis: string; purpose: string; empty: boolean; insight: string; note: string;
  metrics: Metric[]; heat: HeatCell[]; phrases: Phrase[]; coverage: Coverage[];
  moodMix: MoodItem[]; excerpts: Excerpt[]; compare: Compare;
}

const props = defineProps<{ initialKey?: string }>();
const activeKey = ref(props.initialKey || 'work');
const data = ref<Insight | null>(null);
const loading = ref(false);
const overviewEl = ref<HTMLElement | null>(null);

// --- 全局概览（原「回顾 · 概览」六卡）---
const weekly = ref<Record<string, unknown>>({});
const moodRows = ref<unknown[]>([]);
const moodNote = ref('');
const workDigest = ref<unknown[]>([]);
const moneySummary = ref<Record<string, unknown>>({});
interface GrowthBoard { stats: { examTotal: number; examSoon: number; skillTotal: number; skillHours: number; themeTotal: number; bookTotal: number; bookDone: number; quoteTotal: number; total: number } }
// 学习进展卡改读 md_growth：旧 studySummary 统计的是旧学习库与日记里的 studyLog，
// 学习成长页已经不吃那套模型了，再读它只会显示成 0
const growthStats = ref<GrowthBoard['stats'] | null>(null);
const overviewPhrases = ref<unknown[]>([]);
const overviewLoaded = ref(false);

const title = computed(() => GRID_LABELS[activeKey.value] || '自由记录');
const metrics = computed(() => (data.value && Array.isArray(data.value.metrics)) ? data.value.metrics : []);
const heat = computed(() => (data.value && Array.isArray(data.value.heat)) ? data.value.heat : []);
const insightPhrases = computed(() => (data.value && Array.isArray(data.value.phrases)) ? data.value.phrases : []);
const coverage = computed(() => (data.value && Array.isArray(data.value.coverage)) ? data.value.coverage : []);
const excerpts = computed(() => (data.value && Array.isArray(data.value.excerpts)) ? data.value.excerpts : []);
const moodMix = computed(() => (data.value && Array.isArray(data.value.moodMix)) ? data.value.moodMix : []);
const compare = computed(() => data.value && data.value.compare ? data.value.compare : null);
const writtenHeat = computed(() => heat.value.filter(function (h) { return heatLevel(h.cls) > 0; }).length);

function heatLevel(cls: string): number {
  const m = /heat-lv(\d)/.exec(String(cls || ''));
  return m ? Number(m[1]) : 0;
}
function heatClass(cls: string): string {
  const n = heatLevel(cls);
  return n > 0 ? 'heat-lv' + n + ' heat-on' : 'heat-lv0';
}
function deltaText(n: number, unit: string): string {
  return (n > 0 ? '↑ +' : n < 0 ? '↓ ' : '— ') + (n === 0 ? '持平' : n + ' ' + unit);
}

async function load(key: string): Promise<void> {
  loading.value = true;
  try {
    const raw = await callDomain<Insight | null>('insights.analyze', null, key);
    data.value = raw && typeof raw === 'object' ? raw : null;
  } finally {
    loading.value = false;
  }
}

async function pick(key: string): Promise<void> {
  activeKey.value = key;
  await load(key);
}

async function loadOverview(): Promise<void> {
  const [w, m, wd, ms, gr, ph] = await Promise.all([
    callDomain<Record<string, unknown>>('weeklyReview', {}),
    callDomain<{ items?: unknown[]; note?: string }>('moodTrend', { items: [], note: '' }, 30),
    callDomain<unknown>('workDigest', null, 'week', ''),
    callDomain<Record<string, unknown>>('moneySummary', {}, 'month'),
    callDomain<GrowthBoard | null>('growth.board', null, localDate()),
    callDomain<{ phrases?: unknown[] }>('frequentPhrases', { phrases: [] }, 12)
  ]);
  weekly.value = w && typeof w === 'object' && !Array.isArray(w) ? w : {};
  moodRows.value = asArray(m);
  moodNote.value = (m && typeof m.note === 'string') ? m.note : '';
  workDigest.value = asArray(wd);
  moneySummary.value = ms && typeof ms === 'object' && !Array.isArray(ms) ? ms : {};
  growthStats.value = gr && gr.stats ? gr.stats : null;
  overviewPhrases.value = asArray(ph);
  overviewLoaded.value = true;
}

function scrollToOverview(): void {
  if (overviewEl.value) overviewEl.value.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

onMounted(async () => {
  await Promise.all([load(activeKey.value), loadOverview()]);
});
</script>

<template>
  <section class="insight-view" aria-label="单格立式洞察">
    <header class="head">
      <h1>单格立式洞察 · {{ title }}</h1>
      <button class="jump" @click="scrollToOverview">↓ 跳到全局概览</button>
    </header>

    <nav class="insight-nav" aria-label="选择要洞察的格子">
      <button v-for="key in GRID_KEYS" :key="key" class="insight-pick"
        :class="{ 'insight-pick-on': activeKey === key }" :aria-pressed="activeKey === key"
        @click="pick(key)">{{ GRID_LABELS[key] }}</button>
    </nav>

    <div v-if="loading" class="hint-line">正在读取本机「{{ title }}」格历史…</div>

    <template v-if="data">
      <section class="card conclusion" :class="{ 'conclusion-on': !!data.insight }">
        <div class="axis-row">
          <span class="axis-tag">{{ data.axis || '自由记录' }}</span>
          <span class="muted">{{ data.purpose }}</span>
        </div>
        <p class="conclusion-text">{{ data.insight }}</p>
        <p v-if="data.empty" class="muted">还没有记录。</p>
      </section>

      <section class="card">
        <h2>六项指标</h2>
        <div class="metric-grid">
          <div v-for="(m, i) in metrics" :key="i" class="metric-card" :class="{ 'metric-on': Number(m.value) > 0 }">
            <span class="metric-label">{{ m.label }}</span>
            <strong class="metric-value">{{ m.value }}<small>{{ m.unit }}</small></strong>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>近 30 天填写热力 · {{ writtenHeat }} / {{ heat.length }} 天</h2>
        <div class="heat-strip">
          <span v-for="(h, i) in heat" :key="i" class="insight-heat" :class="heatClass(h.cls)" :title="h.date"></span>
        </div>
        <div class="legend"><span class="muted">浅 → 深：字数由少到多</span><span class="muted">{{ heat.length }} 格固定</span></div>
        <div v-if="compare" class="compare-row">
          <span class="cmp">本月 {{ compare.daysNow }} 天 <em>{{ deltaText(compare.daysDelta, '天') }}</em></span>
          <span class="cmp">本月 {{ compare.charsNow }} 字 <em>{{ deltaText(compare.charsDelta, '字') }}</em></span>
          <span class="cmp">上月 {{ compare.daysPrev }} 天 / {{ compare.charsPrev }} 字</span>
        </div>
      </section>

      <section class="card">
        <h2>子角度覆盖</h2>
        <div v-for="(c, i) in coverage" :key="i" class="cov-row">
          <span class="cov-label">{{ c.label }}</span>
          <div class="cov-bar"><span :class="{ 'cov-on': c.pct >= 50 }" :style="{ width: Math.min(100, c.pct) + '%' }"></span></div>
          <span class="cov-pct">{{ c.pct }}%</span>
        </div>
        <p v-if="coverage.length === 0" class="empty">这一格没有子角度定义，或还没有历史内容</p>
      </section>

      <section class="card">
        <h2>本格反复出现的字句 / 心情分布</h2>
        <div class="chips">
          <span v-for="(p, i) in insightPhrases" :key="i" class="chip" :class="{ 'chip-on': p.days >= 3 }">{{ p.word }} · {{ p.count }} 次 / {{ p.days }} 天</span>
        </div>
        <p v-if="insightPhrases.length === 0" class="empty">还没有跨天重复出现的字句</p>
        <div v-if="moodMix.length" class="chips mood-row">
          <span v-for="(m, i) in moodMix" :key="'m' + i" class="chip">{{ m.label }} × {{ m.count }}</span>
        </div>
      </section>

      <section class="card">
        <h2>最近摘录</h2>
        <p v-for="(e, i) in excerpts" :key="i" class="excerpt"><span class="date">{{ e.date }}</span> {{ e.text }}</p>
        <p v-if="excerpts.length === 0" class="empty">暂无摘录</p>
      </section>

      <p class="foot-note">{{ data.note }}</p>
    </template>
    <p v-else-if="!loading" class="empty">本机还没有可分析的数据</p>

    <!-- 全局概览：原「回顾 · 概览」六个功能模块，按规划并入单格洞察下方 -->
    <section ref="overviewEl" class="overview-section" :class="{ 'overview-on': overviewLoaded }" aria-label="全局概览">
      <header class="overview-head">
        <h2>全局概览</h2>
        <span class="muted">原「回顾 · 概览」六项已并入此处；时间轴只管日记，回顾只管复盘</span>
      </header>
      <div class="overview-grid">
        <div class="overview-card"><h3>本周小结</h3>
          <p v-for="row in objectRows(weekly)" :key="row.k" class="line">{{ row.k }}：{{ row.v }}</p>
          <p v-if="objectRows(weekly).length === 0" class="empty">本周还没有可汇总的记录</p>
        </div>
        <div class="overview-card"><h3>近 30 天心情</h3>
          <div class="ov-bars"><span v-for="(m, i) in moodRows" :key="i" class="ov-bar" :class="{ 'ov-bar-on': !!m }" :title="labelText(m)"></span></div>
          <p class="muted">共 {{ moodRows.length }} 天采样 · {{ moodNote }}</p>
        </div>
        <div class="overview-card"><h3>工作 · 任务与感想</h3>
          <p v-for="(d, i) in workDigest.slice(0, 6)" :key="i" class="line">{{ labelText(d) }}</p>
          <p v-if="workDigest.length === 0" class="empty">暂无工作汇总</p>
        </div>
        <div class="overview-card"><h3>收支汇总</h3>
          <p v-for="row in objectRows(moneySummary)" :key="row.k" class="line">{{ row.k }}：{{ row.v }}</p>
          <p v-if="objectRows(moneySummary).length === 0" class="empty">暂无收支记录</p>
        </div>
        <div class="overview-card"><h3>学习进展</h3>
          <template v-if="growthStats">
            <p class="line">考试：{{ growthStats.examTotal }} 场<template v-if="growthStats.examSoon">（7 天内 {{ growthStats.examSoon }} 场）</template></p>
            <p class="line">技能：{{ growthStats.skillTotal }} 项 · 累计 {{ growthStats.skillHours }} 小时</p>
            <p class="line">阅读：{{ growthStats.bookDone }} / {{ growthStats.bookTotal }} 本 · 摘录 {{ growthStats.quoteTotal }} 条</p>
          </template>
          <p v-else class="empty">暂无学习记录</p>
        </div>
        <div class="overview-card"><h3>反复出现的字句</h3>
          <span v-for="(p, i) in overviewPhrases" :key="i" class="chip">{{ labelText(p) }}</span>
          <p v-if="overviewPhrases.length === 0" class="empty">还没有重复出现的字句</p>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.insight-view { display: flex; flex-direction: column; gap: var(--space-2); }
.head h1 { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.head p { font-size: var(--text-sm); color: var(--surface-muted); margin: 4px 0 0; }
.jump { margin-top: 6px; align-self: flex-start; border: 0; background: transparent; color: var(--palette-primary); font-size: var(--text-sm); }
.insight-nav { display: flex; flex-wrap: wrap; gap: 6px; }
.insight-pick { padding: 5px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm); background: var(--surface-raised); font-size: var(--text-sm); }
.insight-pick-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.card h2 { font-size: var(--text-body); font-weight: 500; margin: 0 0 8px; }
.conclusion { background: var(--palette-soft); }
.conclusion-on { border-color: var(--palette-border); }
.axis-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.axis-tag { padding: 2px 10px; border-radius: 999px; background: var(--palette-primary); color: var(--palette-on); font-size: var(--text-sm); }
.conclusion-text { font-size: var(--text-body); margin: 8px 0 0; }
.muted, .empty, .hint-line, .foot-note { font-size: var(--text-sm); color: var(--surface-muted); }
.metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.metric-card { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: var(--radius-md); background: var(--surface-raised); }
.metric-on { border: 0.5px solid var(--palette-border); }
.metric-label { font-size: var(--text-xs); color: var(--surface-muted); }
.metric-value { font-size: 16px; font-weight: 500; color: var(--palette-primary); }
.metric-value small { font-size: var(--text-xs); font-weight: 400; margin-left: 2px; }
.heat-strip { display: grid; grid-template-columns: repeat(30, 1fr); gap: 3px; }
.insight-heat { height: 18px; border-radius: 2px; display: block; }
.heat-lv0 { background: var(--surface-border); }
.heat-lv1 { background: color-mix(in srgb, var(--palette-accent) 30%, var(--surface-border)); }
.heat-lv2 { background: color-mix(in srgb, var(--palette-accent) 60%, var(--surface-border)); }
.heat-lv3 { background: var(--palette-accent); }
.legend { display: flex; justify-content: space-between; margin-top: 6px; }
.compare-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: var(--space-2); }
.cmp { padding: 2px 10px; border-radius: 999px; background: var(--surface-raised); font-size: var(--text-sm); }
.cmp em { font-style: normal; color: var(--palette-primary); }
.cov-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.cov-label { flex: 0 0 80px; font-size: var(--text-sm); }
.cov-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--surface-border); overflow: hidden; }
.cov-bar span { display: block; height: 100%; background: var(--palette-accent); border-radius: 3px; }
.cov-on { background: var(--palette-primary); }
.cov-pct { flex: 0 0 40px; text-align: right; font-size: var(--text-sm); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 2px 10px; border-radius: 999px; background: var(--surface-raised); font-size: var(--text-sm); }
.chip-on { background: var(--palette-soft); color: var(--palette-primary); }
.mood-row { margin-top: 8px; }
.excerpt { font-size: var(--text-sm); margin: 4px 0; }
.excerpt .date { color: var(--palette-primary); margin-right: 6px; }
.foot-note { margin: 0; }
.overview-section { margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--palette-border); }
.overview-on { border-top-style: solid; }
.overview-head { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-2); }
.overview-head h2 { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.overview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
.overview-card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.overview-card h3 { font-size: var(--text-body); font-weight: 500; margin: 0 0 6px; }
.ov-bars { display: flex; gap: 2px; align-items: flex-end; height: 40px; }
.ov-bar { flex: 1; min-height: 4px; background: var(--surface-border); border-radius: 2px; }
.ov-bar-on { background: var(--palette-accent); }
.line { font-size: var(--text-sm); margin: 2px 0; }
</style>
