<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { callDomain, callDomainRaw } from '../composables/useDomain';
import { localDate } from '../types';

interface Capsule {
  id?: string; text?: string; preview?: string; openAt?: string;
  openAtLabel?: string; opened?: boolean; countText?: string;
  progress?: number; daysLeft?: number;
}
type GroupKey = 'due' | 'sealed' | 'opened';
type Groups = Record<GroupKey, Capsule[]>;
const GROUP_KEYS: GroupKey[] = ['due', 'sealed', 'opened'];
const GROUP_LABELS: Record<GroupKey, string> = { due: '今天可开启', sealed: '封存中', opened: '已开启' };
const GROUP_EMPTY: Record<GroupKey, string> = {
  due: '今天没有待开启的胶囊', sealed: '还没有封存中的胶囊', opened: '还没有开启过的胶囊'
};

const groups = ref<Groups>({ due: [], sealed: [], opened: [] });
const writtenMap = ref<Record<string, { writtenAt?: string }>>({});
const presets = ref<Array<{ label: string; openAt: string }>>([]);
const text = ref('');
const openAt = ref('');
const message = ref('');
const openedText = ref('');

function daysSince(iso: string): number {
  const a = String(iso || '').split('-');
  if (a.length !== 3) return 0;
  const t = localDate().split('-');
  const x = new Date(Number(a[0]), Number(a[1]) - 1, Number(a[2])).getTime();
  const y = new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2])).getTime();
  return Math.round((y - x) / 86400000);
}

// 内联提示：这封信已经存了多久。countText 只说"还有几天开启"，不说"已经存了几天"。
function sealedDays(c: Capsule): string {
  if (!c.id || c.opened || !c.openAt) return '';
  const info = writtenMap.value[c.id];
  if (!info || !info.writtenAt) return '';
  const d = daysSince(info.writtenAt);
  if (d < 1) return '';
  return '已封存 ' + d + ' 天';
}

const counts = computed(() => ({
  due: groups.value.due.length,
  sealed: groups.value.sealed.length,
  opened: groups.value.opened.length
}));

function tomorrow(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function refresh(): Promise<void> {
  const g = await callDomain<Groups>('capsuleGroups', { due: [], sealed: [], opened: [] });
  groups.value = g && typeof g === 'object'
    ? {
        due: Array.isArray(g.due) ? g.due : [],
        sealed: Array.isArray(g.sealed) ? g.sealed : [],
        opened: Array.isArray(g.opened) ? g.opened : []
      }
    : { due: [], sealed: [], opened: [] };
}

async function save(): Promise<void> {
  const body = text.value.trim().slice(0, 500);
  if (!body) { message.value = '请先写点什么'; return; }
  const date = openAt.value || tomorrow(7);
  const res = await callDomainRaw<{ id?: string }>('saveCapsule', body, date);
  if (res.error) {
    message.value = res.error === 'DATE_NOT_FUTURE' ? '开启日必须晚于今天'
      : res.error === 'EMPTY_TEXT' ? '正文不能为空'
      : res.error === 'INVALID_DATE' ? '开启日格式应为 YYYY-MM-DD'
      : '保存失败：' + res.error;
    return;
  }
  text.value = ''; message.value = '已封存，到期才能开启';
  await refresh();
}

// 领域层 openCapsule 只按 id 开封，不校验日期；「到期前不泄露内容」由视图层守门
async function open(c: Capsule): Promise<void> {
  if (!c.id) return;
  const notYet = !c.opened && typeof c.daysLeft === 'number' && c.daysLeft > 0;
  if (notYet) {
    message.value = '还没到开启的日子，' + (c.countText || '再等一等');
    openedText.value = '';
    return;
  }
  const res = await callDomainRaw<{ text?: string }>('openCapsule', c.id);
  if (res.error) { message.value = '开启失败：' + res.error; return; }
  openedText.value = (res.data && res.data.text) || '这封胶囊没有正文';
  message.value = c.opened ? '重读已开启的胶囊' : '已开启';
  await refresh();
}

onMounted(async () => {
  openAt.value = tomorrow(7);
  // 封存时长：capsuleGroups 只算"还有几天开启"，不算"已经封存了几天"
  writtenMap.value = await callDomain<Record<string, { writtenAt?: string }>>('capsule.writtenMap', {});
  // capsulePresets() 返回 {label, value}，不是 {label, openAt}
  const p = await callDomain<Array<{ label: string; value: string }>>('capsulePresets', []);
  presets.value = Array.isArray(p) && p.length
    ? p.map(function (x) { return { label: x.label, openAt: x.value }; })
    : [
        { label: '7 天后', openAt: tomorrow(7) },
        { label: '一个月后', openAt: tomorrow(30) },
        { label: '半年后', openAt: tomorrow(182) },
        { label: '明年今天', openAt: tomorrow(365) }
      ];
  await refresh();
});
</script>

<template>
  <section class="capsule">
    <header class="head"><h1>给未来的信 · 胶囊</h1><p>{{ localDate() }}</p></header>
    <div class="counts">
      <span class="stat" :class="{ 'stat-on': counts.due > 0 }">待开启 {{ counts.due }}</span>
      <span class="stat">封存中 {{ counts.sealed }}</span>
      <span class="stat">已开启 {{ counts.opened }}</span>
    </div>

    <div class="card">
      <h2>写新胶囊（正文上限 500 字）</h2>
      <textarea v-model="text" class="text" rows="3" maxlength="500" placeholder="写给未来的自己"></textarea>
      <div class="row">
        <label class="field">开启日<input v-model="openAt" class="text" type="date" :min="tomorrow(1)" /></label>
        <button v-for="p in presets" :key="p.label" class="seg" :class="{ 'seg-on': openAt === p.openAt }"
          @click="openAt = p.openAt">{{ p.label }}</button>
        <button class="btn" :class="{ 'btn-on': !!text.trim() }" @click="save">封存</button>
      </div>
      <p v-if="message" class="message" :class="{ 'message-on': !!message }">{{ message }}</p>
    </div>

    <div v-for="g in GROUP_KEYS" :key="g" class="card">
      <h2>{{ GROUP_LABELS[g] }}</h2>
      <div v-for="(c, i) in groups[g]" :key="c.id || i" class="item" :class="{ 'item-on': g === 'due' }">
        <div class="item-body">
          <span class="meta">{{ c.countText || c.openAtLabel || c.openAt || '' }}</span>
          <span v-if="sealedDays(c)" class="cap-sealed">{{ sealedDays(c) }}</span>
          <!-- 封存中的胶囊连预览都不给，避免提前泄露正文 -->
          <span class="preview">{{ g === 'sealed' ? '内容封存中，到期才能读' : (c.preview || c.text || '') }}</span>
          <div v-if="c.progress !== undefined && g === 'sealed'" class="progress">
            <span :style="{ width: Math.min(100, Math.max(0, Number(c.progress) || 0)) + '%' }"></span>
          </div>
        </div>
        <button class="btn small" @click="open(c)">{{ c.opened ? '重读' : '开启' }}</button>
      </div>
      <p v-if="groups[g].length === 0" class="empty">{{ GROUP_EMPTY[g] }}</p>
    </div>

    <div v-if="openedText" class="card opened" :class="{ 'opened-on': !!openedText }">
      <h2>胶囊全文</h2><p class="full">{{ openedText }}</p>
      <button class="link" @click="openedText = ''">收起</button>
    </div>
  </section>
</template>

<style scoped>
.capsule { display: flex; flex-direction: column; gap: var(--space-2); }
.head h1 { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.head p { font-size: var(--text-sm); color: var(--surface-muted); margin: 4px 0 0; }
.counts { display: flex; gap: 6px; }
.stat { padding: 2px 10px; border-radius: 999px; background: var(--surface-raised); font-size: var(--text-sm); }
.stat-on { background: var(--palette-primary); color: var(--palette-on); }
.card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.card h2 { font-size: var(--text-body); font-weight: 500; margin: 0 0 6px; }
.text { width: 100%; padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; resize: vertical; }
.row { display: flex; gap: 6px; align-items: flex-end; flex-wrap: wrap; margin-top: var(--space-2); }
.field { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-sm); color: var(--surface-muted); }
.field .text { width: 150px; }
.btn, .seg { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.btn-on, .seg-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.small { padding: 2px 8px; font-size: var(--text-sm); }
.message { font-size: var(--text-sm); margin: var(--space-2) 0 0; }
.message-on { color: var(--palette-primary); }
.item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); margin-bottom: 6px; }
.item-on { border-color: var(--palette-accent); }
.item-body { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.meta { font-size: var(--text-xs); color: var(--surface-muted); }
.cap-sealed { font-size: var(--text-xs); color: var(--surface-muted); opacity: 0.85; margin-left: 6px; font-variant-numeric: tabular-nums; }
.preview { font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress { height: 3px; background: var(--surface-border); border-radius: 2px; }
.progress span { display: block; height: 100%; background: var(--palette-accent); border-radius: 2px; }
.empty { font-size: var(--text-sm); color: var(--surface-muted); }
.opened { background: var(--palette-soft); }
.opened-on { border-color: var(--palette-border); }
.full { font-size: var(--text-body); white-space: pre-wrap; }
.link { border: 0; background: transparent; color: var(--palette-primary); font-size: var(--text-sm); }
</style>
