<script setup lang="ts">
// 图书馆右栏：只读。沿用第 7 轮「联动信息只读、写操作全在中栏」的契约，
// 静态门禁会禁止本文件出现任何新建 / 修改 / 删除类领域调用（连注释里的字面串也别写）。
import { onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import type { ViewKey } from '../../types';

interface NoteRow { id: string; bookTitle: string; text: string; quote: string; createdAt: number; pushedAt: number }
interface Board {
  stats: { books: number; notes: number; pushed: number; thisMonth: number; tagCount: number };
  recent: NoteRow[];
  tagTop: Array<{ tag: string; count: number }>;
}

const props = defineProps<{ tick: number }>();
const emit = defineEmits<{
  (e: 'navigate', key: ViewKey): void;
  (e: 'open-cell', key: string): void;
}>();

const data = ref<Board | null>(null);

async function load(): Promise<void> {
  data.value = await callDomain<Board | null>('reading.board', null);
}

function shortDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

onMounted(() => { void load(); });
watch(() => props.tick, () => { void load(); });
</script>

<template>
  <section class="ctx-card" aria-label="图书馆联动信息">
    <h3 class="ctx-title">读书笔记 <span class="ctx-tag">{{ data?.stats.thisMonth || 0 }} 条本月</span></h3>
    <div class="ctx-grid">
      <div class="ctx-kv"><span class="ctx-kv-label">休闲藏书</span><span class="ctx-kv-val">{{ data?.stats.books || 0 }}<span class="ctx-kv-unit">本</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">笔记总数</span><span class="ctx-kv-val">{{ data?.stats.notes || 0 }}<span class="ctx-kv-unit">条</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">已入九格</span><span class="ctx-kv-val">{{ data?.stats.pushed || 0 }}<span class="ctx-kv-unit">条</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">标签</span><span class="ctx-kv-val">{{ data?.stats.tagCount || 0 }}<span class="ctx-kv-unit">个</span></span></div>
    </div>
    <p class="ctx-muted">主题书单在「主题阅读」页自建，与休闲书共用书架；这里汇总两类阅读的笔记。</p>
  </section>

  <section class="ctx-card" aria-label="常用标签">
    <h3 class="ctx-title">标签聚类</h3>
    <div class="ctx-chips">
      <span v-for="t in (data?.tagTop || []).slice(0, 8)" :key="t.tag" class="chip">#{{ t.tag }} · {{ t.count }}</span>
      <span v-if="!(data?.tagTop || []).length" class="ctx-muted">还没有标签。</span>
    </div>
  </section>

  <section class="ctx-card" aria-label="最近笔记">
    <h3 class="ctx-title">最近留下的话</h3>
    <div class="ctx-list">
      <div v-for="n in (data?.recent || []).slice(0, 5)" :key="n.id" class="ctx-item">
        <span class="ctx-item-main">{{ n.quote || n.text }}</span>
        <span class="ctx-item-side">{{ shortDate(n.createdAt) }}</span>
      </div>
      <p v-if="!(data?.recent || []).length" class="ctx-muted">还没有笔记。翻开一本书，留一句摘录。</p>
    </div>
  </section>

  <section class="ctx-card" aria-label="相关去处">
    <h3 class="ctx-title">相关去处</h3>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('open-cell', 'growth')">学习成长</button>
      <button class="ctx-link" @click="emit('open-cell', 'dream')">休闲娱乐格</button>
      <button class="ctx-link" @click="emit('navigate', 'inspire')">语料库</button>
      <button class="ctx-link" @click="emit('navigate', 'data')">数据中心</button>
    </div>
  </section>
</template>
