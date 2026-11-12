<script setup lang="ts">
// 「回顾」的右栏：复盘完成度（周 / 月两套周期键各填了几问）+ 三问提示。
// 复盘本身在中栏，右栏负责回答「我这一期到底写完了没有」。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { reviewTriplet } from '../../composables/promptLibrary';
import type { ViewKey } from '../../types';

const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

interface PeriodState { key: string; filled: number; total: number }

const week = ref<PeriodState>({ key: '', filled: 0, total: 3 });
const month = ref<PeriodState>({ key: '', filled: 0, total: 3 });
const prompts = ref<string[]>(['', '', '']);
const loading = ref(true);

const done = computed(function () {
  return week.value.filled + month.value.filled;
});
const totalSlots = computed(function () {
  return week.value.total + month.value.total;
});

function countFilled(answers: unknown): number {
  const list = Array.isArray(answers) ? answers : [];
  return list.filter(function (x) { return String(x || '').trim().length > 0; }).length;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [wKey, mKey] = await Promise.all([
      callDomain<string>('reviewPeriodKey', '', 'week'),
      callDomain<string>('reviewPeriodKey', '', 'month')
    ]);
    const [wAns, mAns, p] = await Promise.all([
      callDomain<unknown>('loadReview', ['', '', ''], 'week', wKey),
      callDomain<unknown>('loadReview', ['', '', ''], 'month', mKey),
      callDomain<string[]>('reviewPrompts', ['', '', ''], 'week')
    ]);
    week.value = { key: wKey, filled: countFilled(wAns), total: 3 };
    month.value = { key: mKey, filled: countFilled(mAns), total: 3 };
    // 与中栏复盘同口径：右栏「本周三问」也取同一组原创题，避免两边文案打架。
    const fresh = reviewTriplet('week', wKey);
    prompts.value = fresh.length === 3 ? fresh : (Array.isArray(p) ? p.slice(0, 3) : ['', '', '']);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="ctx-card">
    <h2 class="ctx-title">
      复盘完成度
      <span class="ctx-tag" :class="{ 'ctx-tag-warn': done === 0 }">{{ done }} / {{ totalSlots }}</span>
    </h2>
    <div class="ctx-bar-row">
      <div class="ctx-bar-head"><span>本周 · {{ week.key || '—' }}</span><span>{{ week.filled }} / 3</span></div>
      <div class="ctx-bar"><i class="ctx-bar-in" :style="{ width: Math.round(week.filled * 100 / 3) + '%' }"></i></div>
    </div>
    <div class="ctx-bar-row">
      <div class="ctx-bar-head"><span>本月 · {{ month.key || '—' }}</span><span>{{ month.filled }} / 3</span></div>
      <div class="ctx-bar"><i class="ctx-bar-in" :style="{ width: Math.round(month.filled * 100 / 3) + '%' }"></i></div>
    </div>
    <p v-if="loading" class="ctx-muted">读取中…</p>
    <p v-else-if="done === 0" class="ctx-muted">还没有复盘</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">本周三问</h2>
    <div class="ctx-list">
      <div v-for="(p, i) in prompts" :key="i" class="ctx-item">
        <span class="ctx-item-side">{{ i + 1 }}</span>
        <span class="ctx-item-main" style="white-space: normal">{{ p }}</span>
      </div>
    </div>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'timeline')">去时间轴找素材</button>
      <button class="ctx-link" @click="emit('navigate', 'insight')">看九格洞察</button>
    </div>
  </section>
</template>
