<script setup lang="ts">
// 右栏 · 语料库：只读。写入口全在中间那一栏（右栏与中栏同写一份内容必然打架）。
// 它回答三个问题：三类各有多少、今天取到的是哪三条、删改之后从哪儿退回。
import { onMounted, ref } from 'vue';
import { callDomain } from '../../composables/useDomain';

const emit = defineEmits<{ (e: 'navigate', key: 'today' | 'settings'): void }>();

interface Stats { builtin: number; custom: number; total: number; enabled: number; hidden: number; overridden: number }
interface TodayPayload {
  tag: string;
  greeting: { text: string; hint: string; periodLabel: string };
  quote: { text: string; author: string; source: string };
}

const stats = ref<Record<string, Stats>>({});
const today = ref<TodayPayload | null>(null);
const loading = ref(true);

const LABELS: Array<{ key: string; label: string }> = [
  { key: 'quotes', label: '名言警句' },
  { key: 'greetings', label: '问候语' },
  { key: 'moves', label: '运动提示' }
];

onMounted(async () => {
  const [s, t] = await Promise.all([
    callDomain<Record<string, Stats>>('inspire.stats', {}),
    callDomain<TodayPayload | null>('inspire.today', null, {})
  ]);
  stats.value = s || {};
  today.value = t;
  loading.value = false;
});

function num(k: string, f: keyof Stats): number {
  const one = stats.value[k];
  return one ? Number(one[f]) || 0 : 0;
}
</script>

<template>
  <div class="ctx-card">
    <h3 class="ctx-title">三类语料<span class="ctx-tag">{{ LABELS.reduce((n, l) => n + num(l.key, 'enabled'), 0) }} 条在用</span></h3>
    <div class="ctx-list">
      <div v-for="l in LABELS" :key="l.key" class="ctx-item">
        <span class="ctx-item-main">{{ l.label }}</span>
        <span class="ctx-item-side">
          {{ num(l.key, 'enabled') }} 在用<template v-if="num(l.key, 'custom')"> · 我的 {{ num(l.key, 'custom') }}</template>
        </span>
      </div>
    </div>
    <p class="ctx-muted">
      内置原文在程序里，数据文件只记你的改写与移除；「恢复内置默认」不会删你加的内容。
    </p>
  </div>

  <div class="ctx-card">
    <h3 class="ctx-title">此刻取到的三条</h3>
    <p v-if="loading" class="ctx-muted">读取中…</p>
    <template v-else-if="today">
      <p class="ctx-quote">「{{ today.quote.text }}」</p>
      <p class="ctx-muted">{{ today.quote.author ? '— ' + today.quote.author + ' · ' : '' }}{{ today.tag }}</p>
      <div class="ctx-grid">
        <div class="ctx-kv">
          <span class="ctx-kv-label">问候</span>
          <span class="ctx-kv-val ctx-line">{{ today.greeting.text }}</span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">动一动</span>
          <span class="ctx-kv-val ctx-line">{{ today.greeting.hint }}</span>
        </div>
      </div>
      <p class="ctx-muted">
        同一天同一时段固定；换一句只影响那次显示，不改库里的内容。
      </p>
    </template>
    <p v-else class="ctx-muted">语料库暂不可读。</p>
  </div>

  <div class="ctx-card">
    <h3 class="ctx-title">去哪儿改</h3>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'today')">回到今天看效果</button>
      <button class="ctx-link" @click="emit('navigate', 'settings')">设置 · 数据入口</button>
    </div>
    <p class="ctx-muted">三类的增删改都在中间那一栏完成，右栏只报数、不写。</p>
  </div>
</template>

<style scoped>
.ctx-line {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
}
.ctx-quote { margin: 0; font-size: 12px; line-height: 1.7; color: var(--surface-text); }
</style>
