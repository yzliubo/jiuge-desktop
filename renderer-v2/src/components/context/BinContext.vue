<script setup lang="ts">
// 封存箱右栏：说清"规则"，并给出两个去处。
// 右栏只读——封存箱的还原/删除都在中栏做。
import { onMounted, ref } from 'vue';
import type { ViewKey } from '../../types';
import { callDomain } from '../../composables/useDomain';

const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

interface BinItem { daysLeft: number; chars: number }
const items = ref<BinItem[]>([]);
const keepDays = ref(30);

onMounted(async () => {
  const res = await callDomain<{ items: BinItem[]; keepDays: number }>('recycle.list', { items: [], keepDays: 30 });
  items.value = Array.isArray(res?.items) ? res.items : [];
  keepDays.value = res?.keepDays || 30;
});
</script>

<template>
  <section class="ctx-card">
    <h2 class="ctx-title">封存箱<span class="ctx-tag">{{ items.length }} 篇</span></h2>
    <div class="ctx-grid">
      <div class="ctx-kv">
        <span class="ctx-kv-label">保留</span>
        <span class="ctx-kv-val">{{ keepDays }}<span class="ctx-kv-unit">天</span></span>
      </div>
      <div class="ctx-kv">
        <span class="ctx-kv-label">最早离开</span>
        <span class="ctx-kv-val" :class="{ 'ctx-warn': items.length }">
          {{ items.length ? Math.min(...items.map((x) => x.daysLeft)) : '—' }}<span v-if="items.length" class="ctx-kv-unit">天</span>
        </span>
      </div>
    </div>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">它不进备份正文</h2>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'timeline')">回时间轴</button>
      <button class="ctx-link" @click="emit('navigate', 'data')">数据健康</button>
    </div>
  </section>
</template>
