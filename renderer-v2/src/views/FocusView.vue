<script setup lang="ts">
// 「今日六条」格的主功能页：原九格「未来」格 + 原中栏「今日六点」横条合并而成。
// 合并理由（主理人 2026-11-08 22:15 要求）：六条本来就是「今天做哪六件」，
// 它和「未来」这一格问的是同一件事——今天往前推哪几步。分两处，等于同一件事记两遍。
// 现在六条住进这一格：上面挑与勾，下面留一句，这一格的历史照旧在右栏。
import { computed, ref, watch } from 'vue';
import FocusBar from '../components/FocusBar.vue';
import RichText from '../components/RichText.vue';
import { type DiaryRecord } from '../types';

const props = defineProps<{ record: DiaryRecord }>();
const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
}>();

const CELL = 'future';
const draft = ref('');
const message = ref('');
let msgTimer: ReturnType<typeof setTimeout> | null = null;

const isDirty = computed(function () {
  const stored = (props.record.cells && props.record.cells[CELL]) || '';
  return draft.value !== stored;
});

watch(() => props.record, function (r) {
  draft.value = (r.cells && r.cells[CELL]) || '';
}, { immediate: true, deep: true });

function say(t: string): void {
  message.value = t;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { message.value = ''; }, 2600);
  emit('notify', t);
}

function saveCell(): void {
  const next = JSON.parse(JSON.stringify(props.record)) as DiaryRecord;
  next.cells[CELL] = draft.value.slice(0, 2000);
  emit('save', next);
  say('已保存到今天这一格');
}
</script>

<template>
  <section class="focus-view">
    <header class="head">
      <div>
        <h2>今天做哪六件</h2>
      </div>
      <div class="head-actions">
        <button class="back" @click="emit('back')">← 返回九格</button>
      </div>
    </header>

    <!-- 六条本体：挑选 / 勾选 / 调序 / → 格 全部在这一块里 -->
    <FocusBar :record="record" @save="emit('save', $event)" @notify="say" />

    <section class="editor">
      <div class="editor-head">
        <strong>给今天留一句</strong>
      </div>
      <RichText
        v-model="draft"
        :prompt-key="CELL"
        :date="record.date"
        :min-rows="6"
        :max-length="2000"
        placeholder="今天为什么是这六件？哪一条最难、准备怎么破？"
      />
      <div class="edit-foot">
        <button class="primary" :class="{ 'fv-save-on': isDirty }" @click="saveCell">保存到今日</button>
      </div>
    </section>

    <div v-if="message" class="msg message-on" role="status">{{ message }}</div>
  </section>
</template>

<style scoped>
.focus-view { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.head h2 { margin: 0; font-size: 15px; font-weight: 500; }
.head-actions { display: flex; gap: 6px; }
.muted { font-size: 12px; color: var(--surface-muted); }
.back {
  padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised);
}
.editor { display: flex; flex-direction: column; gap: 6px; }
.editor-head { display: flex; align-items: baseline; gap: 8px; }
.editor-head strong { font-size: 13px; }
.edit-foot { display: flex; align-items: center; justify-content: space-between; }
.primary {
  padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised);
}
.primary.fv-save-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.msg { padding: 6px 10px; border-radius: var(--radius-sm); font-size: 12px; }
.message-on { background: var(--palette-soft); color: var(--palette-primary); }
</style>
