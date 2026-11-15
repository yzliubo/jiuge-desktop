<script setup lang="ts">
// 工作 / 收支工作台底部的富文本记录窗：这两个模块的工作台一直在记账、摊流水，
// 却没有地方「写一句」——今天干了什么、这笔钱为什么花。这里补上，
// 存进对应格子（cells.work / cells.money），与小程序的记录同源。
import { computed, ref, watch } from 'vue';
import RichText from './RichText.vue';
import { GRID_LABELS, localDate, type DiaryRecord } from '../types';

const props = defineProps<{ record: DiaryRecord; cellKey: string; date?: string }>();
const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
}>();

const draft = ref('');
const day = computed(() => props.date || props.record.date || localDate());
const label = computed(() => GRID_LABELS[props.cellKey] || props.cellKey);
const stored = computed(() => (props.record.cells && props.record.cells[props.cellKey]) || '');
const dirty = computed(() => draft.value !== stored.value);

watch(() => props.record, function (r) {
  draft.value = (r.cells && r.cells[props.cellKey]) || '';
}, { immediate: true, deep: true });

function save(): void {
  const next = JSON.parse(JSON.stringify(props.record)) as DiaryRecord;
  next.cells[props.cellKey] = draft.value.slice(0, 2000);
  emit('save', next);
  emit('notify', '已保存到「' + day.value + '」的「' + label.value + '」格');
}
</script>

<template>
  <section class="note-editor" :class="{ 'ne-dirty': dirty }" aria-label="完整记录">
    <header class="ne-head">
      <strong class="ne-title">今天的「{{ label }}」· 完整记录</strong>
    </header>
    <RichText
      v-model="draft"
      :prompt-key="cellKey"
      :date="day"
      :min-rows="5"
      :max-length="2000"
      :placeholder="'写给「' + label + '」的一句话：今天推进了什么、卡在哪、为什么。'"
    />
    <div class="ne-foot">
      <button class="ne-save" :class="{ 'ne-save-on': dirty }" @click="save">保存到今天</button>
    </div>
  </section>
</template>

<style scoped>
.note-editor {
  display: flex; flex-direction: column; gap: 6px;
  padding: var(--space-2); border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md); background: var(--surface-panel);
}
.ne-dirty { border-color: var(--palette-border); }
.ne-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ne-title { font-size: var(--text-sm); }
.ne-hint { font-size: var(--text-xs); color: var(--surface-muted); }
.ne-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ne-save {
  padding: 6px 12px; border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md); background: var(--surface-raised); white-space: nowrap;
}
.ne-save-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
</style>
