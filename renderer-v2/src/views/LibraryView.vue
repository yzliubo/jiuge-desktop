<script setup lang="ts">
// 语料库：名言警句 / 问候语 / 运动提示，三类都能由使用者自己增、删、改。
//
// 三件事写在这里，防以后改坏：
// 1. 删除内置条目不是真删——只记一个 hidden，行尾一直留着「还原」，误删可退。
// 2. 改内置条目走「覆盖」，不改代码里的原文；「撤销修改」能退回原句。
// 3. 「恢复内置默认」只清隐藏与覆盖，你自己加的一条都不动——它不叫「清空」。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';

const emit = defineEmits<{ (e: 'notify', text: string): void }>();

interface Item {
  id: string; text: string; author: string;
  period: string; periodLabel: string; day: number; dayLabel: string;
  builtin: boolean; custom: boolean; enabled: boolean; hidden: boolean; overridden: boolean;
  updatedAt: number;
}
interface Stats { builtin: number; custom: number; total: number; enabled: number; hidden: number; overridden: number }
interface ListPayload { kind: string; label: string; items: Item[]; stats: Stats }
interface Meta {
  kinds: Array<{ key: string; label: string; unit: string; hint: string; hasAuthor: boolean; max: number }>;
  periods: Array<{ key: string; label: string }>;
  limits: { text: number; greet: number; author: number; custom: number };
}
interface TodayPayload {
  tag: string;
  greeting: { text: string; hint: string; periodLabel: string };
  quote: { text: string; author: string };
  counts: { greetings: number; moves: number };
}

const KINDS = [
  { key: 'quotes', label: '名言警句', unit: '条' },
  { key: 'greetings', label: '问候语', unit: '句' },
  { key: 'moves', label: '运动提示', unit: '句' }
];

const kind = ref('quotes');
const meta = ref<Meta | null>(null);
const payload = ref<ListPayload | null>(null);
const allStats = ref<Record<string, Stats>>({});
const preview = ref<TodayPayload | null>(null);
const loading = ref(true);

const keyword = ref('');
const showHidden = ref(false);
const visibleCount = ref(60);
const editingId = ref('');
const draftText = ref('');
const draftAuthor = ref('');

const adding = ref(false);
const newText = ref('');
const newAuthor = ref('');
const newPeriod = ref('any');

const kindMeta = computed(() => KINDS.find((k) => k.key === kind.value) || KINDS[0]);
const stats = computed<Stats>(() => payload.value?.stats || {
  builtin: 0, custom: 0, total: 0, enabled: 0, hidden: 0, overridden: 0
});
const periods = computed(() => (meta.value ? meta.value.periods : [{ key: 'any', label: '任何时段' }]));
const textMax = computed(() => (kind.value === 'quotes'
  ? (meta.value?.limits.text || 400)
  : (meta.value?.limits.greet || 160)));

const rows = computed<Item[]>(() => {
  const list = payload.value ? payload.value.items : [];
  const kw = keyword.value.trim();
  // 自己加的排在最前：新增完能立刻看见，不用滚过 500 多条内置
  const picked = list.filter((it) => {
    if (showHidden.value !== it.hidden) return false;
    if (!kw) return true;
    return it.text.indexOf(kw) >= 0 || it.author.indexOf(kw) >= 0;
  });
  return picked.slice().sort((a, b) => Number(b.custom) - Number(a.custom));
});
const shown = computed(() => rows.value.slice(0, visibleCount.value));
const hasMore = computed(() => rows.value.length > visibleCount.value);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [m, one, st, td] = await Promise.all([
      callDomain<Meta | null>('inspire.meta', null),
      callDomain<ListPayload | null>('inspire.list', null, kind.value),
      callDomain<Record<string, Stats>>('inspire.stats', {}),
      callDomain<TodayPayload | null>('inspire.today', null, {})
    ]);
    if (m) meta.value = m;
    if (one) payload.value = one;
    allStats.value = st || {};
    if (td) preview.value = td;
  } finally {
    loading.value = false;
  }
}

// 只重取当前这一类 + 计数：改一句不必把三类的列表都读一遍
async function reload(): Promise<void> {
  const [one, st] = await Promise.all([
    callDomain<ListPayload | null>('inspire.list', null, kind.value),
    callDomain<Record<string, Stats>>('inspire.stats', {})
  ]);
  if (one) payload.value = one;
  allStats.value = st || {};
  preview.value = await callDomain<TodayPayload | null>('inspire.today', preview.value, {});
}

function switchKind(key: string): void {
  if (kind.value === key) return;
  kind.value = key;
  keyword.value = '';
  showHidden.value = false;
  visibleCount.value = 60;
  editingId.value = '';
  adding.value = false;
  void load();
}

watch(keyword, () => { visibleCount.value = 60; });

function startEdit(it: Item): void {
  editingId.value = it.id;
  draftText.value = it.text;
  draftAuthor.value = it.author;
}

function cancelEdit(): void {
  editingId.value = '';
  draftText.value = '';
  draftAuthor.value = '';
}

async function saveEdit(it: Item): Promise<void> {
  const text = draftText.value.trim();
  if (!text) {
    emit('notify', '内容不能为空');
    return;
  }
  await callDomain('inspire.update', null, kind.value, it.id, {
    text: text,
    author: draftAuthor.value.trim()
  });
  await reload();
  cancelEdit();
  emit('notify', it.builtin ? '已改写这条内置内容（可「撤销修改」退回原句）' : '已保存');
}

async function toggle(it: Item): Promise<void> {
  await callDomain('inspire.toggle', null, kind.value, it.id, !it.enabled);
  await reload();
  emit('notify', it.enabled ? '已停用这一条，抽取时不会再出现' : '已启用这一条');
}

// 删：内置只记隐藏，我的才真删。文案要分开说，否则用户以为内置被销毁了
async function remove(it: Item): Promise<void> {
  await callDomain('inspire.remove', null, kind.value, it.id);
  await reload();
  if (it.builtin) emit('notify', '已从抽取里移除（内置原文没删，可在「已移除」里还原）');
  else emit('notify', '已删除这一条');
}

async function restore(it: Item): Promise<void> {
  await callDomain('inspire.restore', null, kind.value, it.id);
  await reload();
  emit('notify', it.builtin ? '已还原这条内置内容' : '已重新启用');
}

async function revert(it: Item): Promise<void> {
  await callDomain('inspire.revert', null, kind.value, it.id);
  await reload();
  emit('notify', '已退回内置原句');
}

async function openAdd(): Promise<void> {
  adding.value = true;
  newText.value = '';
  newAuthor.value = '';
  // 新增默认「任何时段」：先让它能出现，再谈按时段收窄
  newPeriod.value = 'any';
}

async function saveNew(): Promise<void> {
  const text = newText.value.trim();
  if (!text) {
    emit('notify', '先写一句话');
    return;
  }
  await callDomain('inspire.add', null, kind.value, {
    text: text,
    author: newAuthor.value.trim(),
    period: kind.value === 'quotes' ? 'any' : newPeriod.value
  });
  await reload();
  adding.value = false;
  emit('notify', '已加入语料库' + (kind.value === 'quotes' && allStats.value.quotes
    ? '（「我的」约每 7 天轮到一天）' : ''));
}

async function resetDefaults(): Promise<void> {
  await callDomain('inspire.reset', null, kind.value);
  await reload();
  emit('notify', '已恢复内置默认；你自己加的条目一条没动');
}

onMounted(load);
</script>

<template>
  <section class="lib-view" aria-label="语料库">
    <header class="lib-head">
      <h1>语料库</h1>
      <p class="lib-sub">
      </p>
    </header>

    <!-- 今日会用到的三条：改完立刻能看到效果，不用回首页确认 -->
    <div v-if="preview" class="lib-today" aria-label="今天取用的内容">
      <div class="lt-row">
        <span class="lt-tag">今日问候</span>
        <span class="lt-text">{{ preview.greeting.text }}</span>
      </div>
      <div class="lt-row">
        <span class="lt-tag">动一动</span>
        <span class="lt-text">{{ preview.greeting.hint }}</span>
      </div>
      <div class="lt-row">
        <span class="lt-tag">今日名言</span>
        <span class="lt-text">「{{ preview.quote.text }}」<em v-if="preview.quote.author">— {{ preview.quote.author }}</em></span>
      </div>
      <p class="lt-note">{{ preview.tag }} </p>
    </div>

    <div class="lib-tabs" role="tablist" aria-label="语料类别">
      <button
        v-for="k in KINDS"
        :key="k.key"
        class="lib-tab"
        :class="{ 'lib-tab-on': kind === k.key }"
        role="tab"
        :aria-selected="kind === k.key"
        @click="switchKind(k.key)"
      >
        {{ k.label }}
        <span class="lt-count">{{ allStats[k.key] ? allStats[k.key].enabled : 0 }}</span>
      </button>
    </div>

    <div class="lib-bar">
      <input v-model="keyword" class="lib-search" type="search" :placeholder="'在' + kindMeta.label + '里找…'" aria-label="搜索语料" />
      <button class="lib-btn lib-btn-main" :aria-expanded="adding" @click="openAdd">＋ 新增</button>
      <button
        v-if="stats.hidden > 0 || stats.overridden > 0"
        class="lib-btn"
        @click="resetDefaults"
      >恢复内置默认</button>
      <span class="spacer"></span>
      <span class="lib-stat">
        内置 {{ stats.builtin }} · 我的 {{ stats.custom }} · 启用 {{ stats.enabled }}
        <template v-if="stats.hidden"> · 已移除 {{ stats.hidden }}</template>
        <template v-if="stats.overridden"> · 已改写 {{ stats.overridden }}</template>
      </span>
    </div>

    <div v-if="adding" class="lib-add">
      <textarea
        v-model="newText"
        class="lib-input"
        :maxlength="textMax"
        rows="2"
        :placeholder="kind === 'quotes' ? '写一句你想每天看到的话…' : '写一句你自己的说法…'"
        aria-label="新增内容"
      ></textarea>
      <div class="lib-add-row">
        <input
          v-if="kind === 'quotes'"
          v-model="newAuthor"
          class="lib-mini"
          maxlength="60"
          placeholder="出处（可空）"
          aria-label="出处"
        />
        <select v-if="kind !== 'quotes'" v-model="newPeriod" class="lib-mini" aria-label="适用时段">
          <option v-for="p in periods" :key="p.key" :value="p.key">{{ p.label }}</option>
        </select>
        <span class="lib-count">{{ newText.length }} / {{ textMax }}</span>
        <button class="lib-btn lib-btn-main" @click="saveNew">保存</button>
        <button class="lib-btn" @click="adding = false">取消</button>
      </div>
      <p class="lib-hint">{{ kindMeta.key === 'quotes' ? '自己加的名言按日期散列轮换，约每 7 天出现一次；想马上看效果可在首页「换一条」。' : '选「任何时段」就是全天都可能抽到；选了具体时段，只在那个时段出现。' }}</p>
    </div>

    <div class="lib-switch">
      <button class="lib-chip" :class="{ 'lib-chip-on': !showHidden }" @click="showHidden = false">在用 {{ stats.total - stats.hidden }}</button>
      <button class="lib-chip" :class="{ 'lib-chip-on': showHidden }" @click="showHidden = true">已移除 {{ stats.hidden }}</button>
    </div>

    <p v-if="loading" class="lib-empty">读取中…</p>
    <p v-else-if="rows.length === 0" class="lib-empty">
      {{ showHidden ? '没有已移除的条目。' : (keyword ? '没找到含有「' + keyword + '」的内容。' : '这一类还没有内容，点「＋ 新增」写一句。') }}
    </p>

    <ul v-else class="lib-list">
      <li v-for="it in shown" :key="it.id" class="lib-item" :class="{ 'lib-item-off': !it.enabled, 'lib-item-edit': editingId === it.id }">
        <template v-if="editingId === it.id">
          <textarea v-model="draftText" class="lib-input" :maxlength="textMax" rows="3" aria-label="编辑内容"></textarea>
          <div class="lib-add-row">
            <input v-if="kind === 'quotes'" v-model="draftAuthor" class="lib-mini" maxlength="60" placeholder="出处（可空）" aria-label="编辑出处" />
            <span class="lib-count">{{ draftText.length }} / {{ textMax }}</span>
            <button class="lib-btn lib-btn-main" @click="saveEdit(it)">保存</button>
            <button class="lib-btn" @click="cancelEdit">取消</button>
            <button v-if="it.overridden" class="lib-btn" @click="revert(it)">退回原句</button>
          </div>
        </template>

        <template v-else>
          <div class="lib-line">
            <span class="lib-badge" :class="it.builtin ? 'lb-builtin' : 'lb-mine'">{{ it.builtin ? '内置' : '我的' }}</span>
            <span class="lib-text">{{ kind === 'quotes' ? '「' + it.text + '」' : it.text }}</span>
            <em v-if="kind === 'quotes' && it.author" class="lib-author">— {{ it.author }}</em>
          </div>
          <div class="lib-meta">
            <span v-if="it.period !== 'any'" class="lib-tag">{{ it.periodLabel }}</span>
            <span v-if="it.dayLabel" class="lib-tag">{{ it.dayLabel }}</span>
            <span v-if="it.overridden" class="lib-tag lib-tag-warn">已改写</span>
            <span v-if="!it.enabled" class="lib-tag">已停用</span>
            <span class="spacer"></span>
            <template v-if="it.hidden">
              <button class="lib-link" @click="restore(it)">还原</button>
            </template>
            <template v-else>
              <details class="lib-ops">
                <summary aria-label="更多操作" title="编辑 / 停用 / 移除">⋯</summary>
                <div class="lib-menu">
                  <button class="lib-link" @click="startEdit(it)">编辑</button>
                  <button class="lib-link" @click="toggle(it)">{{ it.enabled ? '停用' : '启用' }}</button>
                  <button class="lib-link lib-danger" @click="remove(it)">{{ it.builtin ? '移除' : '删除' }}</button>
                </div>
              </details>
            </template>
          </div>
        </template>
      </li>
    </ul>

    <button v-if="hasMore" class="lib-more" @click="visibleCount += 60">显示更多（还有 {{ rows.length - shown.length }} 条）</button>

  </section>
</template>

<style scoped>
.lib-view { display: flex; flex-direction: column; gap: var(--space-2); }
.lib-head h1 { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.lib-sub { font-size: var(--text-sm); color: var(--surface-muted); margin: 4px 0 0; line-height: 1.7; max-width: 76ch; }

.lib-today {
  padding: var(--space-2);
  border: 0.5px solid var(--surface-border);
  border-left: 3px solid var(--palette-accent);
  border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
  background: var(--palette-soft);
}
.lt-row { display: flex; gap: 8px; align-items: baseline; font-size: var(--text-sm); line-height: 1.7; }
.lt-tag { flex: 0 0 56px; color: var(--surface-muted); font-size: var(--text-xs); }
.lt-text { color: var(--surface-text); }
.lt-text em { font-style: normal; color: var(--surface-muted); margin-left: 4px; }
.lt-note { margin: 6px 0 0; font-size: var(--text-xs); color: var(--surface-muted); }

.lib-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.lib-tab {
  display: flex; align-items: baseline; gap: 5px;
  padding: 4px 12px;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-raised); font-size: var(--text-sm); color: var(--surface-muted);
}
.lib-tab-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.lt-count { font-size: var(--text-xs); opacity: 0.8; font-variant-numeric: tabular-nums; }

.lib-bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.lib-search {
  flex: 0 1 220px; min-width: 140px;
  padding: 5px 10px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); font-size: var(--text-sm); outline: none;
}
.lib-search:focus { border-color: var(--palette-border); }
.lib-btn {
  padding: 5px 12px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); font-size: var(--text-sm);
}
.lib-btn-main { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.lib-stat { font-size: var(--text-xs); color: var(--surface-muted); font-variant-numeric: tabular-nums; }
.spacer { flex: 1; }

.lib-add {
  display: flex; flex-direction: column; gap: 6px;
  padding: var(--space-2);
  border: 0.5px solid var(--palette-border); border-radius: var(--radius-lg);
  background: var(--surface-panel);
}
.lib-input {
  width: 100%; padding: 6px 8px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); font-size: var(--text-sm); line-height: 1.7;
  font-family: inherit; resize: vertical; outline: none;
}
.lib-input:focus { border-color: var(--palette-border); }
.lib-add-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lib-mini {
  padding: 4px 8px; font-size: var(--text-sm);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-md);
  background: var(--surface-raised); max-width: 180px; outline: none;
}
.lib-count { font-size: var(--text-xs); color: var(--surface-muted); font-variant-numeric: tabular-nums; }
.lib-hint { margin: 0; font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.6; }

.lib-switch { display: flex; gap: 6px; }
.lib-chip {
  padding: 3px 10px;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-panel); font-size: var(--text-xs); color: var(--surface-muted);
}
.lib-chip-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }

.lib-empty { font-size: var(--text-sm); color: var(--surface-muted); margin: var(--space-2) 0; }
.lib-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.lib-item {
  padding: 6px 10px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised);
}
.lib-item-off { opacity: 0.62; }
.lib-item-edit { border-color: var(--palette-border); background: var(--surface-panel); }
.lib-line { display: flex; gap: 6px; align-items: baseline; font-size: var(--text-sm); line-height: 1.75; }
.lib-text { flex: 1; min-width: 0; color: var(--surface-text); }
.lib-author { font-style: normal; flex: 0 0 auto; font-size: var(--text-xs); color: var(--surface-muted); }
.lib-badge {
  flex: 0 0 auto; padding: 0 5px; border-radius: 999px;
  font-size: var(--text-xs); line-height: 16px; font-weight: 400;
}
.lb-builtin { background: var(--surface-panel); color: var(--surface-muted); border: 0.5px solid var(--surface-border); }
.lb-mine { background: var(--palette-soft); color: var(--palette-primary); }
.lib-meta { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.lib-tag { padding: 0 6px; border-radius: 999px; background: var(--surface-panel); font-size: var(--text-xs); color: var(--surface-muted); }
.lib-tag-warn { background: var(--state-warn-soft); color: var(--state-warn); }
.lib-link {
  border: 0; background: transparent; padding: 0 2px;
  font-size: var(--text-xs); color: var(--surface-muted); cursor: pointer;
}
.lib-link:hover { color: var(--palette-primary); }
.lib-danger:hover { color: var(--state-warn); }
.lib-more {
  align-self: center; padding: 5px 16px;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-raised); font-size: var(--text-sm);
}
.lib-foot { margin: var(--space-1) 0 0; font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.6; }
.lib-ops { position: relative; }
.lib-ops > summary {
  list-style: none; display: grid; place-items: center;
  width: 24px; height: 24px; border-radius: var(--radius-sm);
  cursor: pointer; color: var(--surface-muted);
}
.lib-ops > summary::-webkit-details-marker { display: none; }
.lib-menu {
  position: absolute; right: 0; top: 26px; z-index: 5;
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px; min-width: 88px; background: var(--surface-raised);
  border: 0.5px solid var(--surface-border-strong); border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
.lib-link { padding: 4px 6px; min-height: 24px; text-align: left; }
</style>
