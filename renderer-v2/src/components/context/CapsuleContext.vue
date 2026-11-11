<script setup lang="ts">
// 「胶囊」的右栏：三组计数 + 最近到期提醒。
// 到期项只显示日期与剩余天数，绝不显示正文——中栏都要点了才开封，右栏更不能漏。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../../composables/useDomain';
import type { ViewKey } from '../../types';

const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

interface CapsuleItem { id: string; openAtLabel: string; countText: string; daysLeft: number; opened: boolean }
interface Groups { due: CapsuleItem[]; sealed: CapsuleItem[]; opened: CapsuleItem[] }

const groups = ref<Groups>({ due: [], sealed: [], opened: [] });
const loading = ref(true);

const total = computed(function () {
  const g = groups.value;
  return g.due.length + g.sealed.length + g.opened.length;
});
const readyNow = computed(function () {
  return groups.value.due.filter(function (x) { return x.daysLeft <= 0; }).length;
});
const soon = computed(function () {
  return groups.value.sealed.slice(0, 3);
});

onMounted(async () => {
  try {
    const g = await callDomain<Groups>('capsuleGroups', { due: [], sealed: [], opened: [] });
    groups.value = {
      due: Array.isArray(g.due) ? g.due : [],
      sealed: Array.isArray(g.sealed) ? g.sealed : [],
      opened: Array.isArray(g.opened) ? g.opened : []
    };
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="ctx-card">
    <h2 class="ctx-title">
      胶囊状态
      <span class="ctx-tag">{{ total }} 封</span>
    </h2>
    <div class="ctx-grid-3">
      <div class="ctx-kv">
        <span class="ctx-kv-label">待开启</span>
        <span class="ctx-kv-val" :class="{ 'ctx-warn': readyNow > 0 }">{{ groups.due.length }}</span>
      </div>
      <div class="ctx-kv">
        <span class="ctx-kv-label">封存中</span>
        <span class="ctx-kv-val">{{ groups.sealed.length }}</span>
      </div>
      <div class="ctx-kv">
        <span class="ctx-kv-label">已开启</span>
        <span class="ctx-kv-val">{{ groups.opened.length }}</span>
      </div>
    </div>
    <p v-if="loading" class="ctx-muted">读取中…</p>
    <p v-else-if="readyNow > 0" class="ctx-muted ctx-warn">有 {{ readyNow }} 封已经到期，可以开了。</p>
    <p v-else-if="total === 0" class="ctx-muted">还没有封存任何一封。</p>
  </section>

  <section v-if="soon.length" class="ctx-card">
    <h2 class="ctx-title">最近会开启</h2>
    <div class="ctx-list">
      <div v-for="c in soon" :key="c.id" class="ctx-item">
        <span class="ctx-item-side">{{ c.openAtLabel }}</span>
        <span class="ctx-item-main">封存中</span>
        <span class="ctx-item-side">{{ c.countText }}</span>
      </div>
    </div>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'today')">回今日写一封</button>
      <button class="ctx-link" @click="emit('navigate', 'habit')">看坚持</button>
    </div>
  </section>
</template>
