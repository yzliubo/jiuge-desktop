<script setup lang="ts">
// 速记浮窗：一句话写完，选去处。
// 四个去处各有语义：自由格=当日记、收件箱=当待办、胶囊=封起来、参考资料=先存着。
// 记住上次选择，所以「回车即存」依然成立——分流不牺牲速度。
import { computed, onMounted, ref } from 'vue';
import { useDialogFocus } from '../composables/useDialogFocus';

const props = defineProps<{ date: string }>();

interface QuickPayload { target: string; text: string; openAt: string }

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', payload: QuickPayload): void;
}>();

// T15：Esc 关闭 + 焦点归还统一走 composable（根节点捕获，输入框内的 Esc 也能收到）。
const boxEl = ref<HTMLElement | null>(null);
useDialogFocus(boxEl, () => emit('close'));

const TARGET_KEY = 'jiuge.quickTarget';

// 全局热键 / 托盘点进来时，用户预期「打开就能打字」，不该再点一下输入框（R-09 验收 ≤500ms 可输入）
const inputEl = ref<HTMLTextAreaElement | null>(null);
onMounted(() => {
  const el = inputEl.value;
  if (el) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
});

const TARGETS = [
  { key: 'free', label: '自由格', hint: '写进今天「自由」格，当日记' },
  { key: 'gtd', label: '收件箱', hint: '当成一件待办，稍后厘清' },
  { key: 'capsule', label: '胶囊', hint: '封起来，到期才打开' },
  { key: 'ref', label: '参考资料', hint: '标 #资料 存进自由格' }
];

function lastTarget(): string {
  try {
    const saved = localStorage.getItem(TARGET_KEY) || '';
    return TARGETS.some(function (t) { return t.key === saved; }) ? saved : 'free';
  } catch (e) {
    return 'free';
  }
}

function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = function (x: number) { return x < 10 ? '0' + x : String(x); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

const text = ref('');
const target = ref(lastTarget());
const openAt = ref(plusDays(30));
const canSave = computed(() => text.value.trim().length > 0);
const targetLabel = computed(() => {
  const hit = TARGETS.filter(function (t) { return t.key === target.value; })[0];
  return hit ? hit.label : '自由格';
});

function pick(key: string): void {
  target.value = key;
  try { localStorage.setItem(TARGET_KEY, key); } catch (e) { /* 存不住也不影响保存 */ }
}

function submit(): void {
  if (!canSave.value) return;
  // 不清空文本：保存成功由父组件卸载浮窗，失败时保留全文供重试
  emit('saved', { target: target.value, text: text.value.trim(), openAt: openAt.value });
}

</script>

<template>
  <div ref="boxEl" class="quick" :class="{ 'note-on': true }" role="dialog" aria-modal="true" aria-label="快速记录">
    <header class="quick-head">
      <strong>速记 · {{ date }}</strong>
      <button class="close" aria-label="关闭速记" @click="emit('close')">关闭</button>
    </header>
    <textarea
      ref="inputEl"
      v-model="text"
      class="quick-input"
      :class="{ 'input-on': canSave }"
      rows="3"
      aria-label="速记正文"
      :placeholder="'写一句，回车即存到「' + targetLabel + '」'"
      @keydown.enter.exact.prevent="submit"
    ></textarea>

    <!-- 四处分流：默认是上次的去处，改一次记住一次 -->
    <div class="targets" role="group" aria-label="存到哪里">
      <button
        v-for="t in TARGETS"
        :key="t.key"
        class="target"
        :class="{ 'target-on': target === t.key }"
        :title="t.hint"
        @click="pick(t.key)"
      >{{ t.label }}</button>
    </div>
    <div v-if="target === 'capsule'" class="cap-row">
      <span class="tip">开启日期</span>
      <input v-model="openAt" class="cap-date" type="date" aria-label="胶囊开启日期" />
      <span class="tip">必须是未来某天</span>
    </div>

    <footer class="quick-foot">
      <span class="tip">Enter 存入「{{ targetLabel }}」 · Esc 关闭</span>
      <button class="submit" :class="{ 'submit-on': canSave }" :disabled="!canSave" :aria-disabled="!canSave" @click="submit">
        存入{{ targetLabel }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.quick {
  position: absolute;
  right: var(--space-4);
  bottom: 48px;
  width: min(380px, calc(100vw - 48px));
  padding: var(--space-3);
  border: 0.5px solid var(--palette-border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  z-index: var(--z-sticky);
}
.note-on { border-color: var(--palette-accent); }
.quick-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-2); }
.close { border: 0; background: transparent; color: var(--surface-muted); font-size: var(--text-sm); }
.quick-input { width: 100%; resize: vertical; padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-bg); outline: none; }
.input-on { border-color: var(--palette-accent); }
.targets { display: flex; flex-wrap: wrap; gap: 4px; margin-top: var(--space-2); }
.target {
  padding: 3px 10px; border: 0.5px solid var(--surface-border);
  border-radius: 999px; background: var(--surface-panel); font-size: var(--text-sm); color: var(--surface-muted);
}
.target-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.cap-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.cap-date {
  padding: 4px 8px; border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md); background: var(--surface-panel); outline: none;
}
.quick-foot { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
.tip { font-size: var(--text-xs); color: var(--surface-muted); }
.submit { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); white-space: nowrap; }
.submit-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.submit:disabled { opacity: 0.5; cursor: default; }
</style>
