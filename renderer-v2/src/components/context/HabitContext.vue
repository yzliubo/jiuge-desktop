<script setup lang="ts">
// 「坚持」的右栏：天数与「下一个奖励」。
// 里程碑在 utils 里是有序列表，右栏只回答一个具体问题：还差几天能拿到下一个。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../../composables/useDomain';
import type { ViewKey } from '../../types';

const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

interface Stats { total: number; streak: number; bestStreak: number; weekCount: number; weekGoal: number }
interface Milestone { at: number; reward: string; label: string; done: boolean; remain: number }
interface MilestoneView { total: number; list: Milestone[]; next: Milestone | null; count: number }

const stats = ref<Stats | null>(null);
const view = ref<MilestoneView | null>(null);
const loading = ref(true);

const hit = computed(function () {
  const v = view.value;
  if (!v || !Array.isArray(v.list)) return 0;
  return v.list.filter(function (m) { return m.done; }).length;
});
const nextPct = computed(function () {
  const n = view.value && view.value.next;
  const cur = stats.value ? stats.value.total : 0;
  if (!n || !n.at) return 0;
  return Math.max(0, Math.min(100, Math.round((cur - (n.at - n.remain)) * 100 / n.at)));
});

onMounted(async () => {
  try {
    const s = await callDomain<Stats | null>('stats', null);
    stats.value = s;
    const mv = await callDomain<MilestoneView>('milestoneView', { total: 0, list: [], next: null, count: 0 }, s ? s.total : 0);
    view.value = mv;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="ctx-card">
    <h2 class="ctx-title">
      天数
      <span class="ctx-tag">本机 {{ stats ? stats.total : 0 }} 篇</span>
    </h2>
    <div v-if="stats" class="ctx-grid">
      <div class="ctx-kv"><span class="ctx-kv-label">当前连续</span><span class="ctx-kv-val">{{ stats.streak }}<span class="ctx-kv-unit">天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">最长连续</span><span class="ctx-kv-val">{{ stats.bestStreak }}<span class="ctx-kv-unit">天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">本周已写</span><span class="ctx-kv-val">{{ stats.weekCount }}<span class="ctx-kv-unit">天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">本周目标</span><span class="ctx-kv-val">{{ stats.weekGoal }}<span class="ctx-kv-unit">天</span></span></div>
    </div>
    <p v-if="loading" class="ctx-muted">读取中…</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">
      下一个奖励
      <span class="ctx-tag">{{ hit }} / {{ view ? view.count : 0 }}</span>
    </h2>
    <template v-if="view && view.next">
      <p class="ctx-kv-val">{{ view.next.label }}</p>
      <p class="ctx-muted">还差 {{ view.next.remain }} 天 · 奖励：{{ view.next.reward }}</p>
      <div class="ctx-bar"><i class="ctx-bar-in" :style="{ width: nextPct + '%' }"></i></div>
    </template>
    <p v-else-if="!loading" class="ctx-muted">所有里程碑都达成了——可以在中栏再加一个新的。</p>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'timeline')">看时间轴</button>
      <button class="ctx-link" @click="emit('navigate', 'capsule')">写封胶囊</button>
    </div>
  </section>
</template>
