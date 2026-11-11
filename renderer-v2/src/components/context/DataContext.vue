<script setup lang="ts">
// 「数据中心」的右栏：先给出「本机到底存了多少」，再提醒备份。
// 右栏不重复中栏的导入导出按钮，只做规模盘点与风险提示。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { listDiaries } from '../../bridge';
import type { ViewKey } from '../../types';

const props = defineProps<{ total: number }>();
const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

interface Stats { total: number; latest: string; startedAt: string }
const stats = ref<Stats | null>(null);
const gtdOpen = ref(0);
const capsuleAll = ref(0);
const chars = ref(0);
const loading = ref(true);

const backupHint = computed(function () {
  const n = stats.value ? stats.value.total : props.total;
  if (n === 0) return '还没有记录，暂时不用备份。';
  if (n < 10) return '记录还少，建议写完第一周后做一次备份。';
  return '建议每月导出一次 JSON 备份，换机时直接导入。';
});

onMounted(async () => {
  try {
    const [s, board, groups, res] = await Promise.all([
      callDomain<Stats | null>('stats', null),
      callDomain<{ stats?: { openTotal?: number } } | null>('gtd.board', null, null),
      callDomain<{ due: unknown[]; sealed: unknown[]; opened: unknown[] }>('capsuleGroups', { due: [], sealed: [], opened: [] }),
      listDiaries({ pageSize: 500 })
    ]);
    stats.value = s;
    gtdOpen.value = (board && board.stats && board.stats.openTotal) || 0;
    capsuleAll.value = groups.due.length + groups.sealed.length + groups.opened.length;
    let sum = 0;
    res.items.forEach(function (r) {
      const cells = (r.cells || {}) as Record<string, string>;
      Object.keys(cells).forEach(function (k) { sum += String(cells[k] || '').length; });
    });
    chars.value = sum;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="ctx-card">
    <h2 class="ctx-title">
      本机数据规模
      <span class="ctx-tag">{{ stats ? stats.total : total }} 篇</span>
    </h2>
    <div class="ctx-grid">
      <div class="ctx-kv"><span class="ctx-kv-label">日记篇数</span><span class="ctx-kv-val">{{ stats ? stats.total : total }}</span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">正文字数</span><span class="ctx-kv-val">{{ chars }}</span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">GTD 未完成</span><span class="ctx-kv-val">{{ gtdOpen }}<span class="ctx-kv-unit">条</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">胶囊</span><span class="ctx-kv-val">{{ capsuleAll }}<span class="ctx-kv-unit">封</span></span></div>
    </div>
    <p v-if="loading" class="ctx-muted">读取中…</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">备份提醒</h2>
    <p class="ctx-muted">{{ backupHint }}</p>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'timeline')">看时间轴</button>
      <button class="ctx-link" @click="emit('navigate', 'settings')">去设置</button>
    </div>
  </section>
</template>
