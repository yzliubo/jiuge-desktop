<script setup lang="ts">
// 右栏联动：只读账本汇总，不写任何东西。类名 ctx-fin- 前缀。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';

interface Totals {
  incomeCents: number; expenseCents: number; netCents: number;
  budgetLimitCents: number; budgetRemainingCents: number;
}
interface Brief {
  month: string; totals: Totals;
  byCategory: { name: string; spentCents: number; shareBp: number }[];
  stats: { imported: number; ruleHit: number; budgetCount: number; ruleCount: number };
}
const props = defineProps<{ today: string; tick: number }>();
const brief = ref<Brief | null>(null);
const month = computed(() => (/^\d{4}-\d{2}-\d{2}$/.test(props.today) ? props.today.slice(0, 7) : ''));

function yuan(c: number): string {
  const n = Math.trunc(Number(c) || 0), a = Math.abs(n);
  return (n < 0 ? '-' : '') + '¥' + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
}
async function load(): Promise<void> {
  brief.value = await callDomain<Brief | null>('finance.board', null, month.value);
}
onMounted(() => { void load(); });
watch(() => [props.tick, props.today], () => { void load(); });
</script>

<template>
  <div class="ctx-fin" aria-label="账本联动">
    <p class="ctx-fin-month">{{ brief?.month || month || '本月' }} · 本机账本</p>
    <div class="ctx-fin-grid">
      <span>本月支出 <b>{{ yuan(brief?.totals.expenseCents || 0) }}</b></span>
      <span>预算剩余 <b :class="{ 'ctx-fin-neg': (brief?.totals.budgetRemainingCents || 0) < 0 }">{{ yuan(brief?.totals.budgetRemainingCents || 0) }}</b></span>
    </div>
    <p class="ctx-fin-sub">已设 {{ brief?.stats.budgetCount || 0 }} 个信封 · {{ brief?.stats.ruleCount || 0 }} 条规则 · 导入 {{ brief?.stats.imported || 0 }} 笔</p>
    <div v-if="(brief?.byCategory || []).length" class="ctx-fin-top">
      <p class="ctx-fin-sub">本月支出前三</p>
      <div v-for="c in (brief?.byCategory || []).slice(0, 3)" :key="c.name" class="ctx-fin-line">
        <span>{{ c.name }}</span><b>{{ yuan(c.spentCents) }}</b>
      </div>
    </div>
    <p v-else class="ctx-fin-sub">还没有流水。去账本记一笔，或导入账单 CSV。</p>
    <p class="ctx-fin-foot">不联网 · 不共享 · 金额以整数分存储</p>
  </div>
</template>

<style scoped>
.ctx-fin { font-size: var(--text-sm); line-height: 1.7; }
.ctx-fin-month { font-weight: 600; margin: 0 0 8px; }
.ctx-fin-grid { display: flex; flex-direction: column; gap: 4px; }
.ctx-fin-grid b { float: right; font-variant-numeric: tabular-nums; }
.ctx-fin-neg { color: var(--state-warn); }
.ctx-fin-sub { color: var(--surface-muted); font-size: var(--text-xs); margin: 8px 0; }
.ctx-fin-line { display: flex; justify-content: space-between; border-top: 1px solid var(--surface-border); padding: 3px 0; }
.ctx-fin-foot { color: var(--surface-muted); font-size: var(--text-xs); margin-top: 12px; }
</style>
