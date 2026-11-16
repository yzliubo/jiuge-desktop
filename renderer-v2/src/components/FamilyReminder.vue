<script setup lang="ts">
// 纪念日全局轻提醒（2026-11-16）：只在「设为纪念日提醒」且 7 天内时弹一次。
// 与 DreamAlert 同一条规矩：当天点「知道了」就不再打扰，下次启动再判断；
// 不写系统通知、不写日历文件，纪念日只从 md_family 读时算出来。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { localDate } from '../types';

const props = defineProps<{ tick?: number }>();
const emit = defineEmits<{ (e: 'go'): void }>();

interface Anniv { memberId: string; name: string; date: string; label: string; daysUntil: number }
const list = ref<Anniv[]>([]);
const closed = ref(false);

function keyOf(a: Anniv): string {
  return 'jiuge.family.anniv.' + localDate() + '.' + a.memberId;
}
function dismissed(a: Anniv): boolean {
  try { return localStorage.getItem(keyOf(a)) === '1'; } catch (_) { return false; }
}
function dismiss(a: Anniv): void {
  try { localStorage.setItem(keyOf(a), '1'); } catch (_) { /* 本机存储不可用就本次不弹 */ }
}

async function load(): Promise<void> {
  try {
    const b = await callDomain<{ anniversaries?: Anniv[] } | null>('family.board', null, localDate());
    list.value = (b && b.anniversaries ? b.anniversaries : []).filter(function (a) {
      return a.daysUntil >= 0 && a.daysUntil <= 7 && !dismissed(a);
    });
  } catch (_) { list.value = []; }
}

const current = computed(function () { return closed.value ? null : (list.value[0] || null); });
const whenText = computed(function () {
  const a = current.value;
  if (!a) return '';
  if (a.daysUntil === 0) return '就是今天';
  return a.daysUntil === 1 ? '明天' : a.daysUntil + ' 天后';
});

function later(): void {
  if (current.value) dismiss(current.value);
  void load();
}
function go(): void {
  if (current.value) dismiss(current.value);
  closed.value = true;
  emit('go');
}

onMounted(function () { void load(); });
watch(function () { return props.tick || 0; }, function () { void load(); });
</script>

<template>
  <div v-if="current" class="fam-alert" role="status" aria-label="纪念日提醒">
    <span class="fa-icon">◷</span>
    <span class="fa-text">{{ current.name }} 的{{ current.label }} · {{ current.date }}（{{ whenText }}）</span>
    <button class="fa-go" @click="go">去看看</button>
    <button class="fa-x" aria-label="知道了" @click="later">知道了</button>
  </div>
</template>

<style scoped>
.fam-alert {
  position: fixed;
  right: 18px;
  bottom: 52px;
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 460px;
  padding: 9px 12px;
  border: 1px solid var(--palette-line, #e7e0d3);
  border-radius: 10px;
  background: var(--palette-card, #fffdf9);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
  font-size: 12px;
  color: var(--palette-text, #3a3a34);
}
.fa-icon { color: var(--palette-primary, #3f5c4a); font-size: 15px; }
.fa-text { flex: 1; }
.fa-go, .fa-x { border: 1px solid var(--palette-line, #e7e0d3); border-radius: 6px; padding: 3px 8px; background: transparent; color: var(--palette-primary, #3f5c4a); font-size: 11px; cursor: pointer; }
.fa-go { background: var(--palette-primary, #3f5c4a); color: #fff; }
</style>
