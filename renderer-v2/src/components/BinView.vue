<script setup lang="ts">
// 封存箱：删掉的东西不销毁，先在这里待 30 天。
// 叫「封存箱」而不是「回收站」——九格本来就有把话寄给未来的胶囊文化，
// 删除也该有个告别的语气，而不是像扔进垃圾桶。
import { onMounted, ref } from 'vue';
import { callDomain } from '../composables/useDomain';

interface BinItem {
  key: string; date: string; excerpt: string; chars: number;
  sealedAt: number; daysLeft: number; expiresAt: number;
}

const items = ref<BinItem[]>([]);
const keepDays = ref(30);
const message = ref('');
const loading = ref(false);
const confirming = ref(false);

function pad(n: number): string { return n < 10 ? '0' + n : String(n); }

function stamp(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function leaveDate(ts: number): string {
  const d = new Date(ts);
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await callDomain<{ items: BinItem[]; keepDays: number }>('recycle.list', { items: [], keepDays: 30 });
    items.value = Array.isArray(res?.items) ? res.items : [];
    keepDays.value = res?.keepDays || 30;
  } finally {
    loading.value = false;
  }
}

async function restore(it: BinItem): Promise<void> {
  const res = await callDomain<{ error?: string }>('recycle.restore', {}, it.key);
  if (res && res.error) {
    message.value = res.error === 'SOURCE_GONE' ? '这一篇的原文已不在了，无法还原' : '还原失败：' + res.error;
  } else {
    message.value = '已还原「' + it.date + '」，回到时间轴了';
  }
  await load();
}

async function purge(it: BinItem): Promise<void> {
  await callDomain('recycle.purge', null, it.key);
  message.value = '「' + it.date + '」已彻底删除，无法恢复';
  await load();
}

async function emptyAll(): Promise<void> {
  const res = await callDomain<{ removed?: number }>('recycle.empty', { removed: 0 });
  message.value = '封存箱已清空，' + (res?.removed ?? 0) + ' 篇彻底删除';
  confirming.value = false;
  await load();
}

onMounted(() => { void load(); });
</script>

<template>
  <section class="bin-view" aria-label="封存箱">
    <header class="bin-head">
      <div>
        <h1 class="bin-title">封存箱</h1>
      </div>
      <span class="bin-count" :class="{ 'bin-count-on': items.length > 0 }">{{ items.length }} 篇</span>
    </header>

    <p v-if="message" class="bin-msg" role="status">{{ message }}</p>

    <ul class="bin-list">
      <li v-for="it in items" :key="it.key" class="bin-item">
        <div class="bin-body">
          <div class="bin-row">
            <span class="bin-date">{{ it.date }}</span>
            <span class="bin-chars">{{ it.chars }} 字</span>
            <span class="bin-gap">·</span>
            <span class="bin-sealed">{{ stamp(it.sealedAt) }} 封存</span>
          </div>
          <p class="bin-excerpt">{{ it.excerpt }}</p>
          <p class="bin-leave">
            还有 {{ it.daysLeft }} 天 · {{ leaveDate(it.expiresAt) }} 离开
          </p>
        </div>
        <div class="bin-actions">
          <button class="bin-btn bin-restore" @click="restore(it)">还原</button>
          <button class="bin-btn bin-purge" @click="purge(it)">彻底删除</button>
        </div>
      </li>
      <li v-if="!items.length && !loading" class="bin-empty">
        封存箱是空的。
      </li>
    </ul>

    <footer v-if="items.length" class="bin-foot">
      <template v-if="!confirming">
        <button class="bin-empty-btn" @click="confirming = true">清空封存箱</button>
        <span class="bin-hint">清空后立即彻底删除，不可恢复</span>
      </template>
      <template v-else>
        <span class="bin-warn">确认清空 {{ items.length }} 篇？此操作不可撤销。</span>
        <button class="bin-btn bin-purge" @click="emptyAll">确认清空</button>
        <button class="bin-btn" @click="confirming = false">取消</button>
      </template>
    </footer>
  </section>
</template>

<style scoped>
.bin-view { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.bin-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.bin-title { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.bin-sub { font-size: var(--text-sm); color: var(--surface-muted); margin: 4px 0 0; line-height: 1.6; max-width: 52ch; }
.bin-count { padding: 2px 10px; border-radius: 999px; background: var(--surface-panel); color: var(--surface-muted); font-size: var(--text-sm); flex: none; }
.bin-count-on { background: var(--palette-soft); color: var(--palette-primary); }
.bin-msg { margin: 0; padding: 6px 12px; font-size: var(--text-sm); border-radius: var(--radius-md); background: var(--palette-soft); color: var(--palette-primary); }
.bin-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.bin-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
}
.bin-body { flex: 1; min-width: 0; }
.bin-row { display: flex; align-items: baseline; gap: 6px; font-size: var(--text-xs); color: var(--surface-muted); }
.bin-date { font-size: var(--text-sm); color: var(--palette-primary); font-variant-numeric: tabular-nums; }
.bin-gap { opacity: 0.6; }
.bin-sealed { font-variant-numeric: tabular-nums; }
.bin-excerpt { margin: 3px 0 0; font-size: var(--text-sm); line-height: 1.55; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.bin-leave { margin: 3px 0 0; font-size: var(--text-xs); color: var(--state-warn); font-variant-numeric: tabular-nums; }
.bin-actions { display: flex; gap: 6px; flex: none; }
.bin-btn { padding: 4px 12px; font-size: var(--text-sm); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); cursor: pointer; }
.bin-btn:hover { border-color: var(--palette-border); background: var(--palette-soft); color: var(--palette-primary); }
.bin-restore { border-color: var(--palette-border); }
.bin-purge:hover { color: var(--state-warn); border-color: var(--state-warn); background: var(--state-warn-soft); }
.bin-empty { padding: var(--space-4); text-align: center; font-size: var(--text-sm); color: var(--surface-muted); border: 0.5px dashed var(--surface-border); border-radius: var(--radius-lg); }
.bin-foot { display: flex; align-items: center; gap: var(--space-2); padding-top: var(--space-2); border-top: 0.5px solid var(--surface-border); }
.bin-empty-btn { padding: 5px 12px; font-size: var(--text-sm); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: transparent; color: var(--surface-muted); cursor: pointer; }
.bin-empty-btn:hover { color: var(--state-warn); border-color: var(--state-warn); }
.bin-hint { font-size: var(--text-xs); color: var(--surface-muted); }
.bin-warn { font-size: var(--text-sm); color: var(--state-warn); }
</style>
