<script setup lang="ts">
// 九格第 7 格「休闲娱乐」专属页（2026-11-16）。
// 以前点这一格进的是通用书写台，图书馆里记的休闲阅读看不到；现在主栏是
// 「一段正文 + 当日阅读摘要 + 当日笔记想法」，右栏是阅读统计与打开图书馆入口。
// 数据键仍是 dream：历史 cells.dream 原样带出，图书馆的 md_reading 一条不动。
import { computed, onMounted, ref, watch } from 'vue';
import CellRecordEditor from '../components/CellRecordEditor.vue';
import { callDomain } from '../composables/useDomain';
import {
  leisureReadsOf, localDayOf, mergeAutoLines, readLine, type LeisureRead
} from '../composables/readingDigest';
import type { DiaryRecord, ViewKey } from '../types';

const props = defineProps<{ record: DiaryRecord; today: string; tick?: number }>();
const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
  (e: 'navigate', key: ViewKey): void;
}>();

interface LeisureNote {
  id: string;
  type: string;
  typeLabel: string;
  bookTitle: string;
  quote: string;
  text: string;
  createdAt: number;
}

const reads = ref<LeisureRead[]>([]);
const notes = ref<LeisureNote[]>([]);
const loading = ref(false);
const autoDone = ref('');

const totalMinutes = computed(function () {
  return reads.value.reduce(function (n, r) { return n + r.minutes; }, 0);
});

function refreshReads(): void {
  reads.value = leisureReadsOf(props.record.date);
}

async function loadNotes(): Promise<void> {
  loading.value = true;
  try {
    const res = await callDomain<{ items?: LeisureNote[] } | null>('reading.notes', null, { mode: 'leisure' });
    const all = (res && res.items) || [];
    notes.value = all
      .filter(function (n) { return localDayOf(Number(n.createdAt) || 0) === props.record.date; })
      .sort(function (a, b) { return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0); });
  } finally {
    loading.value = false;
  }
}

// 当日读过超过 5 分钟的休闲书，书名 + 时长自动落进这一天的正文笔记。
// 幂等：同一本书只留一行；时长变了替换那一行；不足 5 分钟不写。
function autoRecord(): void {
  if (!reads.value.length) return;
  const lines = reads.value.map(readLine);
  const signature = props.record.date + '|' + lines.join('|');
  if (autoDone.value === signature) return;
  const before = props.record.cells.dream || '';
  const after = mergeAutoLines(before, lines);
  autoDone.value = signature;
  if (after === before) return;
  emit('save', { ...props.record, cells: { ...props.record.cells, dream: after } });
}

function reload(): void {
  refreshReads();
  void loadNotes();
  autoRecord();
}

onMounted(reload);
watch(function () { return [props.record.date, props.tick || 0]; }, reload);
</script>

<template>
  <section class="leisure" aria-label="休闲娱乐">
    <div class="lz-top">
      <button class="lz-back" aria-label="回到今天" @click="emit('navigate', 'today')">← 回到今天</button>
      <span class="lz-top-note">第 7 格 · 休闲娱乐</span>
    </div>
    <CellRecordEditor
      :record="record"
      cell-key="dream"
      label="休闲娱乐"
      placeholder="今天玩了什么、看了什么，写一句…"
      prompt-key="dream"
      hint="图书馆里读的休闲书，超过 5 分钟的会自动记到下面，也会写进这一格正文。"
      @save="emit('save', $event)"
      @notify="emit('notify', $event)"
    />

    <section class="lz-card" aria-label="当日休闲阅读">
      <header class="lz-head">
        <h2>今天在图书馆读了什么</h2>
        <span class="lz-tag">{{ reads.length }} 本 · 共 {{ totalMinutes }} 分钟</span>
      </header>
      <ul v-if="reads.length" class="lz-list">
        <li v-for="r in reads" :key="r.bookId" class="lz-item">
          <span class="lz-book">《{{ r.title }}》</span>
          <span class="lz-min">{{ r.minutes }} 分钟</span>
        </li>
      </ul>
      <p v-else class="lz-empty">今天还没有读满 5 分钟的休闲书。读一会儿再回来，这里会自己出现。</p>
      <button class="lz-open" @click="emit('navigate', 'reading')">打开图书馆 →</button>
    </section>

    <section class="lz-card" aria-label="当日阅读笔记">
      <header class="lz-head">
        <h2>今天记下的想法</h2>
        <span class="lz-tag">{{ loading ? '读取中…' : notes.length + ' 条' }}</span>
      </header>
      <ul v-if="notes.length" class="lz-notes">
        <li v-for="n in notes" :key="n.id" class="lz-note">
          <div class="lz-note-head">
            <span class="lz-kind">{{ n.typeLabel || '笔记' }}</span>
            <span class="lz-src">{{ n.bookTitle || '未命名' }}</span>
          </div>
          <blockquote v-if="n.quote" class="lz-quote">{{ n.quote }}</blockquote>
          <p v-if="n.text" class="lz-text">{{ n.text }}</p>
        </li>
      </ul>
      <p v-else class="lz-empty">今天在图书馆里画的摘录、写的想法，会原样出现在这里。</p>
    </section>
  </section>
</template>

<style scoped>
.leisure { padding-bottom: 24px; }
.lz-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.lz-back { border: 0; background: transparent; color: var(--palette-primary, #3f5c4a); font-size: 12px; cursor: pointer; padding: 2px 0; }
.lz-top-note { font-size: 11px; color: var(--palette-muted, #8d8a80); }
.lz-card {
  background: var(--palette-card, #fffdf9);
  border: 1px solid var(--palette-line, #e7e0d3);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.lz-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.lz-head h2 { margin: 0; font-size: var(--text-body, 15px); font-weight: 600; color: var(--palette-primary, #3f5c4a); }
.lz-tag { font-size: 12px; color: var(--palette-muted, #8d8a80); }
.lz-list, .lz-notes { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.lz-item { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; padding: 7px 10px; border-radius: 8px; background: var(--palette-soft, #f6f3ec); font-size: 13px; }
.lz-min { color: var(--palette-primary, #3f5c4a); font-variant-numeric: tabular-nums; }
.lz-empty { margin: 4px 0 10px; font-size: 12px; color: var(--palette-muted, #8d8a80); }
.lz-open { border: 1px solid var(--palette-line, #e7e0d3); border-radius: 8px; padding: 5px 12px; background: transparent; color: var(--palette-primary, #3f5c4a); font-size: 12px; cursor: pointer; }
.lz-note { border-left: 2px solid var(--palette-primary, #3f5c4a); padding: 4px 0 4px 10px; }
.lz-note-head { display: flex; gap: 8px; font-size: 11px; color: var(--palette-muted, #8d8a80); }
.lz-kind { color: var(--palette-primary, #3f5c4a); }
.lz-quote { margin: 5px 0; font-size: 13px; color: var(--palette-text, #3a3a34); border-left: 2px solid var(--palette-line, #e7e0d3); padding-left: 8px; }
.lz-text { margin: 4px 0; font-size: 13px; color: var(--palette-text, #3a3a34); }
</style>
