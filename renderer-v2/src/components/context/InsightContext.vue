<script setup lang="ts">
// 「单格洞察」的右栏：不再重复中栏已有的图形，而是回答两个导航问题——
// 哪几格写得多（可点进该格），以及我在这个本机上到底积累了多少。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { listDiaries } from '../../bridge';
import { GRID_KEYS, GRID_LABELS, type DiaryRecord, type ViewKey } from '../../types';

const props = defineProps<{ record: DiaryRecord; total: number }>();
const emit = defineEmits<{
  (e: 'open-cell', key: string): void;
  (e: 'navigate', key: ViewKey): void;
}>();

interface Stats { total: number; streak: number; bestStreak: number; startedAt: string; weekCount: number; weekGoal: number }

const stats = ref<Stats | null>(null);
const counts = ref<Record<string, number>>({});
const loading = ref(true);

const rows = computed(() => GRID_KEYS.map(function (k) {
  const n = counts.value[k] || 0;
  const pct = props.total ? Math.min(100, Math.round(n * 100 / props.total)) : 0;
  return { key: k, label: GRID_LABELS[k], count: n, pct: pct };
}).sort(function (a, b) { return b.count - a.count; }));
const covered = computed(() => rows.value.filter(function (r) { return r.count > 0; }).length);

onMounted(async () => {
  try {
    const [s, res] = await Promise.all([
      callDomain<Stats | null>('stats', null),
      listDiaries({ pageSize: 500 })
    ]);
    stats.value = s;
    const map: Record<string, number> = {};
    res.items.forEach(function (r) {
      GRID_KEYS.forEach(function (k) {
        if (r.cells && r.cells[k]) map[k] = (map[k] || 0) + 1;
      });
    });
    counts.value = map;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="ctx-card">
    <h2 class="ctx-title">
      九格填写覆盖
      <span class="ctx-tag">{{ covered }} / 9 格</span>
    </h2>
    <div v-for="r in rows" :key="r.key" class="ctx-bar-row">
      <div class="ctx-bar-head">
        <button class="ctx-dot ctx-bar-label" @click="emit('open-cell', r.key)">{{ r.label }}</button>
        <span>{{ r.count }} 篇</span>
      </div>
      <div class="ctx-bar"><i class="ctx-bar-in" :style="{ width: r.pct + '%' }"></i></div>
    </div>
    <p v-if="loading" class="ctx-muted">读取中…</p>
    <p v-else class="ctx-muted">条长 = 写过篇数占比</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">本机积累</h2>
    <div v-if="stats" class="ctx-grid">
      <div class="ctx-kv"><span class="ctx-kv-label">总篇数</span><span class="ctx-kv-val">{{ stats.total }}<span class="ctx-kv-unit">篇</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">当前连续</span><span class="ctx-kv-val">{{ stats.streak }}<span class="ctx-kv-unit">天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">最长连续</span><span class="ctx-kv-val">{{ stats.bestStreak }}<span class="ctx-kv-unit">天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">本周已写</span><span class="ctx-kv-val">{{ stats.weekCount }}<span class="ctx-kv-unit">/ {{ stats.weekGoal }} 天</span></span></div>
    </div>
    <p v-if="loading" class="ctx-muted">读取中…</p>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'timeline')">看时间轴</button>
      <button class="ctx-link" @click="emit('navigate', 'review')">写本期复盘</button>
    </div>
  </section>
</template>
