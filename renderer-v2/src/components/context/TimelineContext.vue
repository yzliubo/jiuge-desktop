<script setup lang="ts">
// 「时间轴」的右栏：只回答「我的写作节奏怎么样」——月度分布 + 近期节奏。
// 时间轴中栏已经在做「找某一篇」，右栏不再重复列表，避免两块内容打架。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { localDate, type ViewKey } from '../../types';

const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

interface Stats { total: number; streak: number; bestStreak: number; weekCount: number; weekGoal: number; latest: string }
const stats = ref<Stats | null>(null);
const months = ref<Array<{ label: string; count: number }>>([]);
const loading = ref(true);
const year = localDate().slice(0, 4);

const maxCount = computed(() => Math.max(1, ...months.value.map(function (m) { return m.count; })));
// 当年一条记录都没有时，12 条空条会把右栏整块撑满却零信息——直接收成一句提示。
const hasAny = computed(() => months.value.some(function (m) { return m.count > 0; }));

onMounted(async () => {
  try {
    const [s, raw] = await Promise.all([
      callDomain<Stats | null>('stats', null),
      callDomain<{ months?: Array<{ cells?: Array<{ written?: boolean; date?: string }> }> }>('yearPixels', { months: [] }, Number(year))
    ]);
    stats.value = s;
    const list = (raw && Array.isArray(raw.months)) ? raw.months : [];
    months.value = list.map(function (m, i) {
      const cells = Array.isArray(m.cells) ? m.cells : [];
      return {
        label: (i + 1) + ' 月',
        count: cells.filter(function (c) { return !!c.written; }).length
      };
    });
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="ctx-card">
    <h2 class="ctx-title">
      {{ year }} 年月度分布
      <span v-if="stats" class="ctx-tag">{{ stats.total }} 篇</span>
    </h2>
    <template v-if="hasAny">
      <div v-for="(m, i) in months" :key="m.label" class="ctx-bar-row">
        <div class="ctx-bar-head"><span>{{ m.label }}</span><span>{{ m.count }} 篇</span></div>
        <div class="ctx-bar"><i class="ctx-bar-in" :style="{ width: Math.round(m.count * 100 / maxCount) + '%' }"></i></div>
      </div>
    </template>
    <p v-else-if="!loading" class="ctx-muted">{{ year }} 年还没有记录，写几天之后这里会出现月度节奏。</p>
    <p v-if="loading" class="ctx-muted">读取中…</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">近期节奏</h2>
    <div v-if="stats" class="ctx-grid">
      <div class="ctx-kv"><span class="ctx-kv-label">本周已写</span><span class="ctx-kv-val">{{ stats.weekCount }}<span class="ctx-kv-unit">/ {{ stats.weekGoal }} 天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">当前连续</span><span class="ctx-kv-val">{{ stats.streak }}<span class="ctx-kv-unit">天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">最长连续</span><span class="ctx-kv-val">{{ stats.bestStreak }}<span class="ctx-kv-unit">天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">最近一篇</span><span class="ctx-kv-val" style="font-size: var(--text-body)">{{ stats.latest || '—' }}</span></div>
    </div>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'habit')">看坚持</button>
      <button class="ctx-link" @click="emit('navigate', 'data')">去备份</button>
    </div>
  </section>
</template>
