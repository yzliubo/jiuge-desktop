<script setup lang="ts">
// 休闲娱乐右栏：只做「读」——当日阅读账、今天记过的想法、打开图书馆的入口。
// 主栏那段正文不在这里出现，免得两处都能改同一格。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { leisureReadsOf, localDayOf } from '../../composables/readingDigest';
import type { ViewKey } from '../../types';

const props = defineProps<{ tick: number; date: string }>();
const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

interface NoteRow { id: string; createdAt: number; typeLabel: string; bookTitle: string; }
const reads = ref(returnReads());
const noteCount = ref(0);

function returnReads() {
  return leisureReadsOf(props.date || localDayOf(Date.now()));
}

const totalMinutes = computed(function () {
  return reads.value.reduce(function (n, r) { return n + r.minutes; }, 0);
});

async function load(): Promise<void> {
  reads.value = returnReads();
  try {
    const res = await callDomain<{ items?: NoteRow[] } | null>('reading.notes', null, { mode: 'leisure' });
    const all = (res && res.items) || [];
    noteCount.value = all.filter(function (n) {
      return localDayOf(Number(n.createdAt) || 0) === (props.date || localDayOf(Date.now()));
    }).length;
  } catch (_) { noteCount.value = 0; }
}

onMounted(function () { void load(); });
watch(function () { return [props.tick, props.date]; }, function () { void load(); });
</script>

<template>
  <aside class="ctx-card leisure-ctx" aria-label="休闲阅读右栏">
    <h2 class="ctx-title">休闲阅读</h2>
    <div class="ctx-grid">
      <div class="ctx-kv"><span class="ctx-kv-label">今天读满 5 分钟</span><span class="ctx-kv-val">{{ reads.length }}<span class="ctx-kv-unit"> 本</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">合计</span><span class="ctx-kv-val">{{ totalMinutes }}<span class="ctx-kv-unit"> 分钟</span></span></div>
    </div>
    <ul v-if="reads.length" class="ctx-list">
      <li v-for="r in reads" :key="r.bookId" class="ctx-item">
        <span class="ctx-item-main">《{{ r.title }}》</span>
        <span class="ctx-item-side">{{ r.minutes }} 分钟</span>
      </li>
    </ul>
    <p v-else class="ctx-muted">今天还没有读满 5 分钟的休闲书。</p>
    <p class="ctx-muted">今天在图书馆记下的笔记与想法：{{ noteCount }} 条。</p>
    <button class="ctx-link" @click="emit('navigate', 'reading')">打开图书馆 →</button>
  </aside>
</template>

<style scoped>
.ctx-link { margin-top: 10px; border: 1px solid var(--palette-line, #e7e0d3); border-radius: 8px; padding: 5px 12px; background: transparent; color: var(--palette-primary, #3f5c4a); font-size: 12px; cursor: pointer; }
</style>
