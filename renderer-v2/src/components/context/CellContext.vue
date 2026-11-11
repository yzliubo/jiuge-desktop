<script setup lang="ts">
// 单格主功能（cell 视图）的右栏：按「哪一格」显示不同上下文。
//   金钱 → 本月收支、分类占比、最近流水
//   其余六格 → 该格 6 项指标、30 天热力、洞察结论
// 工作格（GTD）单独成 WorkContext、学习格（三块）单独成 StudyContext：
// 那两栏要能改「当前选中的那一条」，只读约束对它们不适用。
// 全部只读；需要动手时用底部的跳转入口去对应模块，避免右栏与中栏同时写同一份数据。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { listDiaries } from '../../bridge';
import { stripMarkdown } from '../../composables/useRichText';
import { GRID_LABELS, type DiaryRecord, type ViewKey } from '../../types';

const props = defineProps<{ cellKey: string; record: DiaryRecord; tick?: number }>();
const emit = defineEmits<{
  (e: 'open-insight', key: string): void;
  (e: 'navigate', key: ViewKey): void;
}>();

const label = computed(() => GRID_LABELS[props.cellKey] || '单格');
const loading = ref(true);

// --- 金钱 ---
interface MoneySummary {
  count: number; days: number; incomeText: string; expenseText: string; balanceText: string;
  byCategory: Array<{ id: string; label: string; text: string; pct: number }>;
  recent: Array<{ id: string; dateLabel: string; label: string; amountText: string; type: string }>;
  insight: string;
}
const money = ref<MoneySummary | null>(null);

// --- 其余六格 ---
interface Metric { label: string; value: unknown; unit: string }
interface HeatCell { date: string; cls: string }
interface Insight { insights?: string; insight?: string; metrics: Metric[]; heat: HeatCell[]; empty: boolean }
const insight = ref<Insight | null>(null);
// 中栏单格工作台已改成纯书写区（2026-11-08 去重），这一格的跨天历史改由右栏承载
interface HisRow { date: string; text: string; chars: number }
const recent = ref<HisRow[]>([]);

const heatRows = computed(() => (insight.value && Array.isArray(insight.value.heat)) ? insight.value.heat.slice(-30) : []);
const metrics = computed(() => (insight.value && Array.isArray(insight.value.metrics)) ? insight.value.metrics.slice(0, 6) : []);
const insightText = computed(() => {
  const v = insight.value;
  if (!v) return '';
  return String(v.insight || v.insights || '');
});
function heatOn(cls: string): boolean {
  const m = /heat-lv(\d)/.exec(String(cls || ''));
  return !!m && Number(m[1]) > 0;
}

async function load(): Promise<void> {
  loading.value = true;
  const key = props.cellKey;
  try {
    if (key === 'money') {
      money.value = await callDomain<MoneySummary | null>('moneySummary', null, 'month');
    } else {
      insight.value = await callDomain<Insight | null>('insights.analyze', null, key);
      const res = await listDiaries({ pageSize: 200 });
      const rows: HisRow[] = [];
      res.items.forEach(function (r) {
        // 只给摘要：剥掉 Markdown 标记，右栏一行一个日期 + 一段开头
        const text = stripMarkdown((r.cells && r.cells[key]) || '').trim();
        if (!text) return;
        if (r.date === props.record.date) return;
        rows.push({ date: r.date, text: text, chars: text.length });
      });
      rows.sort(function (a, b) { return b.date.localeCompare(a.date); });
      recent.value = rows.slice(0, 5);
    }
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(function () { return props.cellKey; }, load);
// 中栏每次改完清单（加子项 / 勾掉 / 删除）就重取一次，
// 否则刚拆完子任务，右栏还停在「下一步 0 条」
watch(function () { return props.tick || 0; }, load);
</script>

<template>
  <!-- ===== 金钱：本月收支 ===== -->
  <template v-if="cellKey === 'money'">
    <section class="ctx-card">
      <h2 class="ctx-title">
        本月收支
        <span v-if="money" class="ctx-tag">{{ money.count }} 笔</span>
      </h2>
      <div v-if="money" class="ctx-grid-3">
        <div class="ctx-kv">
          <span class="ctx-kv-label">支出</span>
          <span class="ctx-kv-val">{{ money.expenseText }}</span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">收入</span>
          <span class="ctx-kv-val">{{ money.incomeText }}</span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">结余</span>
          <span class="ctx-kv-val">{{ money.balanceText }}</span>
        </div>
      </div>
      <p v-if="loading" class="ctx-muted">读取中…</p>
    </section>

    <section v-if="money && money.byCategory.length" class="ctx-card">
      <h2 class="ctx-title">支出分类</h2>
      <div v-for="c in money.byCategory.slice(0, 4)" :key="c.id" class="ctx-bar-row">
        <div class="ctx-bar-head"><span>{{ c.label }}</span><span>{{ c.text }} · {{ c.pct }}%</span></div>
        <div class="ctx-bar"><i class="ctx-bar-in" :style="{ width: c.pct + '%' }"></i></div>
      </div>
    </section>

    <section v-if="money && money.recent.length" class="ctx-card">
      <h2 class="ctx-title">最近流水</h2>
      <div class="ctx-list">
        <div v-for="e in money.recent.slice(0, 3)" :key="e.id" class="ctx-item">
          <span class="ctx-item-side">{{ e.dateLabel }}</span>
          <span class="ctx-item-main">{{ e.label }}</span>
          <span class="ctx-item-side" :class="{ 'ctx-warn': e.type !== 'income' }">{{ e.amountText }}</span>
        </div>
      </div>
    </section>
  </template>

  <!-- ===== 成长：学习库 ===== -->
  <!-- ===== 其余六格：该格洞察 ===== -->
  <template v-else>
    <section class="ctx-card">
      <h2 class="ctx-title">
        {{ label }} · 本期指标
        <button class="ctx-tag" @click="emit('open-insight', cellKey)">看全量</button>
      </h2>
      <div v-if="metrics.length" class="ctx-grid">
        <div v-for="m in metrics" :key="m.label" class="ctx-kv">
          <span class="ctx-kv-label">{{ m.label }}</span>
          <span class="ctx-kv-val">{{ m.value }}<span class="ctx-kv-unit">{{ m.unit }}</span></span>
        </div>
      </div>
      <p v-else-if="loading" class="ctx-muted">读取中…</p>
      <p v-else class="ctx-muted">这一格还没有足够的记录，写几天就会出现指标。</p>
    </section>

    <section v-if="heatRows.length" class="ctx-card">
      <h2 class="ctx-title">近 30 天</h2>
      <div class="ctx-heat">
        <i
          v-for="h in heatRows"
          :key="h.date"
          class="ctx-heat-cell"
          :class="{ 'ctx-heat-on': heatOn(h.cls) }"
          :title="h.date"
        ></i>
      </div>
      <p class="ctx-muted">深色表示当天这一格写过。</p>
    </section>

    <section v-if="insightText" class="ctx-card">
      <h2 class="ctx-title">这一格的读法</h2>
      <p class="ctx-muted">{{ insightText }}</p>
      <div class="ctx-links">
        <button class="ctx-link" @click="emit('open-insight', cellKey)">进入单格洞察</button>
      </div>
    </section>

    <section class="ctx-card">
      <h2 class="ctx-title">
        最近写过
        <span class="ctx-tag">{{ recent.length }} 条</span>
      </h2>
      <div v-if="recent.length" class="ctx-list">
        <div v-for="r in recent" :key="r.date" class="ctx-item">
          <span class="ctx-item-side">{{ r.date.slice(5) }}</span>
          <span class="ctx-item-main">{{ r.text }}</span>
          <span class="ctx-item-side">{{ r.chars }} 字</span>
        </div>
      </div>
      <p v-else class="ctx-muted">这一格还没有跨天历史，今天是第一条。</p>
    </section>
  </template>
</template>
