<script setup lang="ts">
// 梦想账户存够之后，用浮窗提醒「该动手了」。
//
// 为什么是浮窗而不是红点或横幅：钱存够的那一刻是决策点——再放两天，
// 这笔钱就自动变成了「不动的余额」。所以要打断一次，但只打断一次：
// 点「稍后」本轮不再弹，只要目标没被标记达成，下次启动还会再来。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { localDate } from '../types';

const props = defineProps<{ tick?: number }>();
const emit = defineEmits<{ (e: 'go'): void }>();

interface AlertItem { id: string; title: string; saved: number; target: number; horizonLabel: string }

const alerts = ref<AlertItem[]>([]);
const dismissed = ref<Record<string, boolean>>({});
const closed = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  const board = await callDomain<{ alerts?: AlertItem[] } | null>('dream.board', null, localDate());
  alerts.value = board && Array.isArray(board.alerts) ? board.alerts : [];
}

const visible = computed<AlertItem[]>(() => (
  closed.value ? [] : alerts.value.filter(function (a) { return !dismissed.value[a.id]; })
));
const current = computed<AlertItem | null>(() => (visible.value.length ? visible.value[0] : null));

function yuan(cents: number): string {
  return Math.round((Number(cents) || 0) / 100).toLocaleString('zh-CN');
}

function later(): void {
  if (current.value) dismissed.value = Object.assign({}, dismissed.value, { [current.value.id]: true });
}

function go(): void {
  if (current.value) dismissed.value = Object.assign({}, dismissed.value, { [current.value.id]: true });
  emit('go');
}

onMounted(function () {
  void load();
  // 存款可能来自金钱模块，页面切走时也要能弹出来
  timer = setInterval(function () { void load(); }, 60000);
});
onUnmounted(function () { if (timer) clearInterval(timer); });
watch(function () { return props.tick; }, load);
</script>

<template>
  <div v-if="current" class="dream-alert" role="alertdialog" aria-label="梦想账户已存够">
    <div class="da-head">
      <span class="da-tag">梦想账户已存够</span>
      <button class="da-close" aria-label="本次不再提醒" @click="closed = true">×</button>
    </div>
    <p class="da-title">{{ current.title }}</p>
    <p class="da-line">
      已存 <strong>¥{{ yuan(current.saved) }}</strong>
      <template v-if="current.target > current.saved"> / ¥{{ yuan(current.target) }}</template>
      <span class="da-hz">· {{ current.horizonLabel }}</span>
    </p>
    <p class="da-hint">钱到位了，下一步该动手——在这条目标被标记达成之前，这个提醒还会出现。</p>
    <div class="da-actions">
      <button class="da-go" @click="go">去梦想页走下一步</button>
      <button class="da-later" @click="later">稍后</button>
    </div>
  </div>
</template>

<style scoped>
.dream-alert {
  position: fixed;
  right: 18px;
  bottom: 34px;
  z-index: 60;
  width: 300px;
  padding: var(--space-2);
  border: 0.5px solid var(--palette-border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
.da-head { display: flex; align-items: center; gap: 6px; }
.da-tag {
  padding: 1px 8px; border-radius: 999px;
  background: var(--palette-soft); color: var(--palette-primary); font-size: 11px;
}
.da-close {
  margin-left: auto; border: 0; background: transparent;
  color: var(--surface-muted); font-size: 14px; line-height: 1;
}
.da-title { font-size: 13px; font-weight: 500; margin: 8px 0 2px; }
.da-line { font-size: 12px; margin: 0; color: var(--surface-text); }
.da-hz { color: var(--surface-muted); margin-left: 4px; font-size: 11px; }
.da-hint { font-size: 11px; color: var(--surface-muted); margin: 6px 0 0; line-height: 1.7; }
.da-actions { display: flex; gap: 6px; margin-top: 10px; }
.da-go {
  flex: 1; padding: 5px 10px; font-size: 12px;
  border: 0.5px solid var(--palette-primary); border-radius: var(--radius-md);
  background: var(--palette-primary); color: var(--palette-on);
}
.da-later {
  padding: 5px 12px; font-size: 12px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-panel); color: var(--surface-muted);
}
</style>
