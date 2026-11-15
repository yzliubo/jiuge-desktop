<script setup lang="ts">
// 胶囊降级后的唯一载体：顶栏按钮 → 弹窗，两态（书写 / 到期）。
// 书写态直接复用既有 CapsuleView，领域层与「封存中不泄露正文」的守门一行未改；
// 到期态只做 due 列表与开读，信息收录归自由记录模块（只读派生）。
import { ref, watch, onMounted } from 'vue';
import CapsuleView from './CapsuleView.vue';
import { callDomain, callDomainRaw } from '../composables/useDomain';
import { useDialogFocus } from '../composables/useDialogFocus';

type TabKey = 'write' | 'due';
interface DueCapsule {
  id?: string; text?: string; preview?: string; openAt?: string;
  countText?: string; openAtLabel?: string;
}
interface Groups { due?: DueCapsule[]; sealed?: DueCapsule[]; opened?: DueCapsule[] }

const props = defineProps<{ tab: TabKey }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'due-changed'): void;
}>();

// T15：Esc 关闭 + 焦点进入 / 归还，与速记浮窗共用同一份行为。
const boxEl = ref<HTMLElement | null>(null);
useDialogFocus(boxEl, () => emit('close'));

const active = ref<TabKey>(props.tab);
const dues = ref<DueCapsule[]>([]);
const openedText = ref('');
const message = ref('');

watch(() => props.tab, function (v) { active.value = v; });

async function refresh(): Promise<void> {
  const g = await callDomain<Groups>('capsuleGroups', { due: [], sealed: [], opened: [] });
  const list: DueCapsule[] = g && Array.isArray(g.due) ? g.due : [];
  dues.value = list;
  emit('due-changed');
}
onMounted(function () { void refresh(); });

function pick(k: TabKey): void {
  active.value = k;
  if (k === 'due') void refresh();
}

async function openOne(c: DueCapsule): Promise<void> {
  if (!c.id) return;
  const res = await callDomainRaw<{ text?: string }>('openCapsule', c.id);
  if (res.error) { message.value = '开启失败：' + res.error; return; }
  openedText.value = (res.data && res.data.text) || '这封胶囊没有正文';
  message.value = '';
  await refresh();
}
</script>

<template>
  <div class="cm-mask" @click.self="emit('close')">
    <div ref="boxEl" class="cm-box" role="dialog" aria-label="胶囊" aria-modal="true">
      <header class="cm-head">
        <strong>胶囊 · 给未来的信</strong>
        <span class="cm-sub">顶栏小功能 · 书写与到期都在弹窗里</span>
        <button class="cm-x" aria-label="关闭胶囊弹窗" @click="emit('close')">关闭 ✕</button>
      </header>
      <div class="cm-tabs" role="tablist" aria-label="胶囊弹窗两态">
        <button
          class="cm-tab" :class="{ 'cm-on': active === 'write' }"
          role="tab" :aria-selected="active === 'write'" @click="pick('write')"
        >写新胶囊</button>
        <button
          class="cm-tab" :class="{ 'cm-on': active === 'due' }"
          role="tab" :aria-selected="active === 'due'" @click="pick('due')"
        >今日到期<span v-if="dues.length" class="cm-badge">{{ dues.length }}</span></button>
      </div>
      <div class="cm-body">
        <!-- 书写态复用原全页组件：三组分类、四个日期预设、到期前不泄露正文，断言口径不变 -->
        <CapsuleView v-if="active === 'write'" />
        <section v-else class="cm-due">
          <p class="cm-tip">到期（含逾期）且尚未开启的信。开读后可在自由记录「胶囊收录」重读全文。</p>
          <div v-for="(c, i) in dues" :key="c.id || i" class="cm-item">
            <div class="cm-item-body">
              <span class="cm-meta">{{ c.countText || c.openAtLabel || c.openAt || '' }}</span>
              <p>{{ c.preview || c.text || '' }}</p>
            </div>
            <button class="cm-btn" @click="openOne(c)">开启</button>
          </div>
          <p v-if="!dues.length" class="cm-empty">今天没有待开启的胶囊</p>
          <div v-if="openedText" class="cm-opened">
            <strong>胶囊全文</strong>
            <p>{{ openedText }}</p>
            <button class="cm-link" @click="openedText = ''">收起</button>
          </div>
          <p v-if="message" class="cm-msg">{{ message }}</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cm-mask {
  position: fixed; inset: 0; z-index: var(--z-drawer);
  background: rgba(35, 45, 40, .30);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 76px;
}
.cm-box {
  width: 620px; max-width: calc(100% - 48px);
  max-height: calc(100% - 120px); display: flex; flex-direction: column;
  background: var(--surface-panel); border: 1px solid var(--palette-border);
  border-radius: var(--radius-lg); box-shadow: 0 20px 54px rgba(30, 45, 36, .24);
  overflow: hidden;
}
.cm-head { display: flex; align-items: center; gap: 10px; padding: 11px 16px; background: var(--surface-raised); border-bottom: 1px solid var(--surface-border); }
.cm-head strong { font-size: var(--text-h2); color: var(--palette-primary); }
.cm-sub { font-size: var(--text-xs); color: var(--surface-muted); }
.cm-x { margin-left: auto; border: 0; background: transparent; color: var(--surface-muted); font-size: var(--text-sm); cursor: pointer; }
.cm-tabs { display: flex; gap: 4px; padding: 10px 16px 0; }
.cm-tab {
  font-size: var(--text-sm); padding: 7px 14px; border: 1px solid var(--surface-border); border-bottom: 0;
  border-radius: 6px 6px 0 0; background: var(--surface-raised); color: var(--surface-muted); cursor: pointer;
}
.cm-tab.cm-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.cm-badge { display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 6px; border-radius: 9px; background: var(--palette-accent); color: var(--palette-on); font-size: var(--text-xs); }
.cm-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px; border-top: 1px solid var(--surface-border); }
.cm-body :deep(.capsule) { gap: 10px; }
.cm-due { font-size: var(--text-sm); }
.cm-tip, .cm-empty, .cm-msg { font-size: var(--text-sm); color: var(--surface-muted); line-height: 1.7; }
.cm-item { display: flex; align-items: center; gap: 10px; padding: 9px 11px; margin: 8px 0; border: 1px solid var(--palette-border); border-radius: var(--radius-md); background: var(--palette-soft); }
.cm-item-body { flex: 1; min-width: 0; }
.cm-item-body p { margin: 4px 0 0; font-size: var(--text-body); line-height: 1.7; }
.cm-meta { font-size: var(--text-xs); color: var(--surface-muted); }
.cm-btn { padding: 4px 10px; font-size: var(--text-sm); border: 1px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); cursor: pointer; }
.cm-opened { margin-top: 10px; padding: 12px; border: 1px solid var(--palette-border); border-radius: var(--radius-md); background: var(--palette-soft); }
.cm-opened strong { font-size: var(--text-sm); }
.cm-opened p { margin: 8px 0; font-size: var(--text-body); line-height: 1.9; white-space: pre-wrap; }
.cm-link { border: 0; background: transparent; color: var(--palette-primary); font-size: var(--text-sm); cursor: pointer; }
</style>
