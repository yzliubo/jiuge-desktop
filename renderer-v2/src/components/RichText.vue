<script setup lang="ts">
// 富文本编辑器：contenteditable + 格式工具栏 + 小程序引导词。
//
// 设计取舍（写在这里备查）：
//   1. 存 Markdown 子集而不是 HTML——见 composables/useRichText.ts 顶部说明，
//      否则搜索 / 字数统计 / 导出 / 备份四条纯文本链路全部被标签污染。
//   2. 用 document.execCommand 而不是引第三方编辑器：根包要保住「零运行时依赖」，
//      renderer 也不该为几个按钮背一个富文本框架。Chromium 31 上 execCommand 依旧可用。
//   3. 粘贴一律降级为纯文本：外部 HTML 会带一堆行内样式，落进 Markdown 就是垃圾。
//   4. 引导词优先取渲染层原创语料库 promptLibrary（四套模板 × 九格 + 头七天，含
//      桌面版新增的 leisure 格）；领域层 diary-store.promptFor 作自建模板 / 旧键的兜底：
//      按日期确定性取词、offset 可换下一条，utils 逐字节对拍基线不动。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { gridPrompt, knownTemplate } from '../composables/promptLibrary';
import { escapeHtml, htmlToMarkdown, markdownLength, markdownToHtml } from '../composables/useRichText';

const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  promptKey?: string;
  date?: string;
  minRows?: number;
  maxLength?: number;
  compact?: boolean;
}>(), {
  placeholder: '写点什么…',
  promptKey: '',
  date: '',
  minRows: 6,
  maxLength: 2000,
  compact: false
});

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

interface ToolButton { cmd: string; arg?: string; label: string; title: string; block?: string }

const TOOLS: ToolButton[] = [
  { cmd: 'bold', label: '粗', title: '粗体（Ctrl+B）' },
  { cmd: 'italic', label: '斜', title: '斜体（Ctrl+I）' },
  { cmd: 'strikeThrough', label: '删', title: '删除线' },
  { cmd: 'formatBlock', arg: 'H3', label: '标题', title: '小标题', block: 'H3' },
  { cmd: 'insertUnorderedList', label: '• 列表', title: '无序列表' },
  { cmd: 'insertOrderedList', label: '1. 列表', title: '有序列表' },
  { cmd: 'formatBlock', arg: 'BLOCKQUOTE', label: '引用', title: '引用块', block: 'BLOCKQUOTE' },
  { cmd: 'removeFormat', label: '清格式', title: '清除格式' }
];

const bodyEl = ref<HTMLElement | null>(null);
const active = ref<Record<string, boolean>>({});
const composing = ref(false);
const focused = ref(false);
const promptText = ref('');
const promptOffset = ref(0);
const promptLoaded = ref(false);

let internal = false;

const plainLength = computed(() => markdownLength(props.modelValue || ''));
const overLimit = computed(() => plainLength.value > props.maxLength);
const styleVars = computed(() => ({ minHeight: props.minRows * 22 + 'px' }));

function refreshActive(): void {
  const map: Record<string, boolean> = {};
  ['bold', 'italic', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].forEach(function (cmd) {
    try {
      map[cmd] = document.queryCommandState(cmd);
    } catch {
      map[cmd] = false;
    }
  });
  try {
    const block = String(document.queryCommandValue('formatBlock') || '').toUpperCase();
    map.H3 = block === 'H3' || block === 'H2' || block === 'H1';
    map.BLOCKQUOTE = block === 'BLOCKQUOTE';
  } catch {
    map.H3 = false;
    map.BLOCKQUOTE = false;
  }
  active.value = map;
}

function syncFromDom(): void {
  const el = bodyEl.value;
  if (!el) return;
  internal = true;
  emit('update:modelValue', htmlToMarkdown(el.innerHTML));
  nextTick(function () { internal = false; });
}

function onInput(): void {
  // 中文输入法组合期间不回写：否则拼音上屏过程会被反复序列化，光标乱跳
  if (composing.value) return;
  syncFromDom();
}

function onCompositionEnd(): void {
  composing.value = false;
  syncFromDom();
}

function exec(btn: ToolButton): void {
  const el = bodyEl.value;
  if (!el) return;
  el.focus();
  if (btn.block) {
    const current = String(document.queryCommandValue('formatBlock') || '').toUpperCase();
    document.execCommand('formatBlock', false, current === btn.block ? 'P' : btn.block);
  } else {
    document.execCommand(btn.cmd, false, btn.arg);
  }
  syncFromDom();
  refreshActive();
}

function onPaste(ev: ClipboardEvent): void {
  // 一律纯文本：外部富文本会带颜色/字号，进 Markdown 全是无法表达的垃圾
  ev.preventDefault();
  const text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
  if (!text) return;
  document.execCommand('insertText', false, text);
  syncFromDom();
}

function onKeydown(ev: KeyboardEvent): void {
  const mod = ev.ctrlKey || ev.metaKey;
  if (!mod) return;
  const key = ev.key.toLowerCase();
  if (key === 'b' || key === 'i' || key === 'u') {
    ev.preventDefault();
    document.execCommand(key === 'b' ? 'bold' : (key === 'i' ? 'italic' : 'underline'));
    syncFromDom();
    refreshActive();
  }
}

function focusEnd(): void {
  const el = bodyEl.value;
  if (!el) return;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

async function loadPrompt(): Promise<void> {
  if (!props.promptKey) return;
  const rawTpl = String((await callDomain<string>('getTemplateId', 'standard')) || 'standard');
  const fw = await callDomain<{ active?: boolean } | null>('firstWeekState', null);
  const easy = !!(fw && fw.active) && promptOffset.value === 0;
  let text = gridPrompt(props.promptKey, knownTemplate(rawTpl) ? rawTpl : '', props.date, promptOffset.value, easy);
  // 自建模板、旧数据键（如 dream）或库里没有的格位，仍回退到与小程序同源的题库。
  // 休闲娱乐（leisure）此前在这里只会拿到空串、显示「本格暂无引导词」，本轮由新库补全。
  if (!text) text = await callDomain<string>('promptFor', '', props.promptKey, props.date, promptOffset.value);
  promptText.value = typeof text === 'string' ? text : '';
  promptLoaded.value = true;
}

function nextPrompt(): void {
  promptOffset.value += 1;
  void loadPrompt();
}

// 引导词以引用块追加到末尾：它是「起头用」的素材，不覆盖已有正文。
// 直接改 Markdown 再重建 DOM，避免 insertHTML 把 blockquote 塞进 p 里导致标记丢失。
function insertPrompt(): void {
  if (!promptText.value) return;
  const base = (props.modelValue || '').replace(/\s+$/, '');
  const next = (base ? base + '\n\n' : '') + '> ' + promptText.value;
  emit('update:modelValue', next);
  nextTick(function () {
    const el = bodyEl.value;
    if (!el) return;
    el.innerHTML = markdownToHtml(next);
    focusEnd();
  });
}

watch(function () { return props.modelValue; }, function (value) {
  if (internal) return;
  const el = bodyEl.value;
  if (!el) return;
  // 聚焦时不回填，否则每次输入都会被父组件回传覆盖，光标跳到开头
  if (document.activeElement === el) return;
  const html = markdownToHtml(value || '');
  if (el.innerHTML !== html) el.innerHTML = html;
});

watch(function () { return props.promptKey; }, function () {
  promptOffset.value = 0;
  void loadPrompt();
});

onMounted(function () {
  const el = bodyEl.value;
  if (el) el.innerHTML = markdownToHtml(props.modelValue || '');
  document.addEventListener('selectionchange', function () {
    if (focused.value) refreshActive();
  });
  void loadPrompt();
});
</script>

<template>
  <div class="rt" :class="{ 'rt-focus': focused, 'rt-compact': compact }">
    <div v-if="!compact" class="rt-toolbar" role="toolbar" aria-label="格式工具栏">
      <button
        v-for="btn in TOOLS"
        :key="btn.label"
        class="rt-btn"
        :class="{ 'rt-btn-on': active[btn.cmd] || (btn.block && active[btn.block]) }"
        :aria-pressed="!!(active[btn.cmd] || (btn.block && active[btn.block]))"
        :title="btn.title"
        :aria-label="btn.title"
        @mousedown.prevent
        @click="exec(btn)"
      >{{ btn.label }}</button>
      <span class="rt-spacer"></span>
      <span class="rt-count" :class="{ 'rt-over': overLimit }">{{ plainLength }} / {{ maxLength }}</span>
    </div>

    <div
      ref="bodyEl"
      class="rt-body"
      contenteditable="true"
      role="textbox"
      aria-multiline="true"
      :data-placeholder="placeholder"
      :style="styleVars"
      @input="onInput"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
      @paste="onPaste"
      @keydown="onKeydown"
      @focus="focused = true; refreshActive()"
      @blur="focused = false"
      @mouseup="refreshActive"
      @keyup="refreshActive"
    ></div>

    <div v-if="promptKey" class="rt-prompt" :class="{ 'rt-prompt-on': promptLoaded }">
      <span class="rt-prompt-label">引导词</span>
      <span class="rt-prompt-text">{{ promptText || '（本格暂无引导词）' }}</span>
      <button class="rt-prompt-btn" @click="nextPrompt">换一条</button>
      <button class="rt-prompt-btn rt-prompt-insert" :disabled="!promptText" @click="insertPrompt">插入为引用</button>
    </div>
  </div>
</template>

<style scoped>
.rt {
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  overflow: hidden;
}
.rt-focus { border-color: var(--palette-accent); }
.rt-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border-bottom: 0.5px solid var(--surface-border);
  background: var(--surface-panel);
}
.rt-btn {
  padding: 3px 8px;
  border: 0.5px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 11px;
  color: var(--surface-muted);
}
.rt-btn:hover { border-color: var(--surface-border); color: var(--palette-primary); }
.rt-btn-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.rt-spacer { flex: 1; }
.rt-count { font-size: 11px; color: var(--surface-muted); font-variant-numeric: tabular-nums; }
.rt-over { color: var(--palette-accent); }
.rt-body {
  padding: 8px 10px;
  line-height: 1.75;
  outline: none;
  overflow: auto;
  max-height: 420px;
  font-size: 13px;
}
.rt-body:empty:before {
  content: attr(data-placeholder);
  color: var(--surface-muted);
  pointer-events: none;
}
.rt-body :deep(p) { margin: 0 0 6px; }
.rt-body :deep(h3) { margin: 8px 0 4px; font-size: 13px; font-weight: 600; color: var(--palette-primary); }
.rt-body :deep(blockquote) {
  margin: 4px 0;
  padding: 2px 10px;
  border-left: 2px solid var(--palette-border);
  color: var(--surface-muted);
}
.rt-body :deep(ul), .rt-body :deep(ol) { margin: 4px 0; padding-left: 20px; }
.rt-body :deep(code) {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--surface-panel);
  font-size: 12px;
}
.rt-prompt {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-top: 0.5px dashed var(--surface-border);
  font-size: 11px;
  color: var(--surface-muted);
}
.rt-prompt-on .rt-prompt-label { color: var(--palette-primary); }
.rt-prompt-label {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-panel);
}
.rt-prompt-text { flex: 1; min-width: 120px; }
.rt-prompt-btn {
  padding: 2px 8px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  font-size: 11px;
}
.rt-prompt-btn:disabled { opacity: 0.45; }
.rt-prompt-insert { color: var(--palette-primary); border-color: var(--palette-border); }
</style>
