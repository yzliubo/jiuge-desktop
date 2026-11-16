<script setup lang="ts">
// 主栏记录窗口（2026-11-16）：关系经营 / 家庭亲子 / 休闲娱乐三个专属页共用的正文入口。
// 为什么单独做一个组件：
//   主栏只负责「写」，右栏只负责「信息与登记」。这三个模块以前把登记表单堆在主栏，
//   写作反而没有落脚处。统一成「主栏一段正文 + 右栏信息」后，写入口也该统一：
//   都走 v1/diaries:upsert 的 cells.<键>，不新开数据键，历史正文原样带出。
// 约定：组件不自己维护整篇 record，只改自己那一格；写成功后 emit saved 给外壳刷新。
import { computed, ref, watch } from 'vue';
import RichText from './RichText.vue';
import type { DiaryRecord } from '../types';

const props = withDefaults(defineProps<{
  record: DiaryRecord;
  cellKey: string;
  label: string;
  placeholder?: string;
  promptKey?: string;
  hint?: string;
}>(), {
  placeholder: '写点什么…',
  promptKey: '',
  hint: ''
});

const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
}>();

const origin = computed(() => props.record.cells[props.cellKey] || '');
const text = ref(origin.value);
const justSaved = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

// 外部换了日子 / 别处写了同一格：只在自己没在改的时候跟过去，避免抢用户输入
watch([() => props.record.date, origin], function () {
  if (justSaved.value) {
    justSaved.value = false;
    text.value = origin.value;
    return;
  }
  if (text.value !== origin.value && !dirty.value) text.value = origin.value;
});

const dirty = computed(function () {
  return text.value !== origin.value;
});

function saveText(): void {
  if (!dirty.value) return;
  const next: DiaryRecord = {
    ...props.record,
    cells: { ...props.record.cells, [props.cellKey]: text.value }
  };
  justSaved.value = true;
  emit('save', next);
  if (timer) clearTimeout(timer);
  timer = setTimeout(function () { justSaved.value = false; }, 2400);
}

function clear(): void {
  if (!text.value) return;
  text.value = '';
  saveText();
}
</script>

<template>
  <section class="cell-record" :aria-label="label + '记录窗口'">
    <header class="cr-head">
      <h2 class="cr-title">{{ label }} · 今天写点什么</h2>
      <span class="cr-tag" :class="{ 'cr-tag-on': dirty }">{{ dirty ? '未保存' : (justSaved ? '已保存' : '正文') }}</span>
    </header>
    <p v-if="hint" class="cr-hint">{{ hint }}</p>
    <RichText
      v-model="text"
      :prompt-key="promptKey"
      :date="record.date"
      :placeholder="placeholder"
      :min-rows="5"
      :max-length="2000"
    />
    <div class="cr-actions">
      <button class="cr-save" :disabled="!dirty" @click="saveText">保存这一格</button>
      <button v-if="text" class="cr-clear" @click="clear">清空</button>
      <span class="cr-note">正文存在九格对应格里，换设备备份照常带走</span>
    </div>
  </section>
</template>

<style scoped>
.cell-record {
  background: var(--palette-card, #fffdf9);
  border: 1px solid var(--palette-line, #e7e0d3);
  border-radius: 12px;
  padding: 14px 16px 16px;
  margin-bottom: 16px;
}
.cr-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.cr-title { margin: 0; font-size: var(--text-body, 15px); font-weight: 600; color: var(--palette-primary, #3f5c4a); }
.cr-tag { font-size: 11px; color: var(--palette-muted, #8d8a80); border: 1px solid var(--palette-line, #e7e0d3); border-radius: 999px; padding: 2px 8px; }
.cr-tag-on { color: #b45309; border-color: #e5b96b; }
.cr-hint { margin: 6px 0 10px; font-size: 12px; color: var(--palette-muted, #8d8a80); }
.cr-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.cr-save { border: 0; border-radius: 8px; padding: 6px 14px; background: var(--palette-primary, #3f5c4a); color: #fff; font-size: 12px; cursor: pointer; }
.cr-save:disabled { opacity: .45; cursor: default; }
.cr-clear { border: 1px solid var(--palette-line, #e7e0d3); border-radius: 8px; padding: 5px 12px; background: transparent; color: var(--palette-muted, #8d8a80); font-size: 12px; cursor: pointer; }
.cr-note { font-size: 11px; color: var(--palette-muted, #8d8a80); }
</style>
