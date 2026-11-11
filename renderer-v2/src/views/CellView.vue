<script setup lang="ts">
// 通用单格主功能页：九格双击进入（工作/收支/学习三格各有专属工作台）。
// 这里给其余六格（身体/关系/未来/情绪/梦想/自由）一个「全功能书写台」。
// 2026-11-08 主理人指出：本页下部的六项指标 / 环比 / 30 天热力 / 高频词 / 摘录
// 与右栏 CellContext 展示的是同一份统计，属重复。故中栏只留「写」，
// 该格所有只读统计（指标 / 热力 / 历史 / 读法）统一由右栏承担，各司其职。
import { computed, ref, watch } from 'vue';
import RichText from '../components/RichText.vue';
import { GRID_LABELS, type DiaryRecord } from '../types';

const props = defineProps<{ cellKey: string; record: DiaryRecord }>();
const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'save', record: DiaryRecord): void;
  (e: 'open-insight', key: string): void;
}>();

const draft = ref('');
const message = ref('');
let msgTimer: ReturnType<typeof setTimeout> | null = null;

const label = computed(() => GRID_LABELS[props.cellKey] || props.cellKey);
const isDirty = computed(function () {
  const stored = (props.record.cells && props.record.cells[props.cellKey]) || '';
  return draft.value !== stored;
});

function say(t: string): void {
  message.value = t;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { message.value = ''; }, 2600);
}

watch(() => props.record, function (r) {
  draft.value = (r.cells && r.cells[props.cellKey]) || '';
}, { immediate: true, deep: true });

function saveCell(): void {
  const next = JSON.parse(JSON.stringify(props.record)) as DiaryRecord;
  next.cells[props.cellKey] = draft.value.slice(0, 2000);
  emit('save', next);
  say('已保存到今天的「' + label.value + '」格');
}
</script>

<template>
  <section class="cell-view">
    <header class="head">
      <div>
        <h2>{{ label }} · 单格工作台</h2>
      </div>
      <div class="head-actions">
        <button class="ghost" @click="emit('open-insight', cellKey)">完整洞察 →</button>
        <button class="back" @click="emit('back')">← 返回九格</button>
      </div>
    </header>

    <section class="editor">
      <!-- 完整书写用富文本：存 Markdown 子集，四下游链路（检索/字数/导出/备份）照旧吃纯文本 -->
      <RichText
        v-model="draft"
        :prompt-key="cellKey"
        :date="record.date"
        :min-rows="12"
        :max-length="2000"
        :placeholder="'把「' + label + '」这一格写透；今日页的九格是快录，这里是完整书写。'"
      />
      <div class="edit-foot">
        <button class="primary" :class="{ 'cell-save-on': isDirty }" @click="saveCell">保存到今日</button>
      </div>
    </section>

    <div v-if="message" class="msg" :class="{ 'message-on': !!message }" role="status">{{ message }}</div>
  </section>
</template>

<style scoped>
.cell-view { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.head h2 { margin: 0; font-size: 15px; font-weight: 500; }
.head-actions { display: flex; gap: 6px; }
.muted { font-size: 12px; color: var(--surface-muted); }
.primary, .ghost, .back {
  padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised);
}
.primary.cell-save-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.editor { display: flex; flex-direction: column; gap: 6px; }
.edit-foot { display: flex; align-items: center; justify-content: space-between; }
.msg { padding: 6px 10px; border-radius: var(--radius-sm); background: var(--surface-panel); font-size: 12px; }
.message-on { background: var(--palette-soft); color: var(--palette-primary); }
</style>
