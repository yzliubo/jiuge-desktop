<script setup lang="ts">
// 关系经营右栏 = 通讯录（2026-11-16）。
// 主栏只写正文与「记一次」流水，登记信息一律退到右栏——和今天页、家庭亲子同一条规矩：
// 主栏写、右栏读/登记。通讯录在这里能新增、编辑、归档、约一下；写完 emit changed 让主栏刷新。
import { computed, onMounted, ref, watch } from 'vue';
import { domainCall } from '../../bridge';

const props = defineProps<{ tick: number }>();
const emit = defineEmits<{
  (e: 'changed'): void;
  (e: 'notify', text: string): void;
}>();

interface Opt { value: string; label: string }
interface Contact {
  id: string; name: string; circle: string; tier: string; org: string; title: string;
  phone: string; wechat: string; howMet: string; giveFirst: string; tags: string[]; note: string;
  followUp?: string; daysSince?: number | null; temperature?: number | null; never?: boolean;
  circleLabel?: string; tierLabel?: string;
}
interface Draft {
  id: string; name: string; circle: string; tier: string; org: string; title: string;
  phone: string; wechat: string; howMet: string; tagsText: string; giveFirst: string;
  note: string; followUp: string;
}
interface Meta { circles?: unknown; circleLabel?: unknown; tiers?: unknown; tierLabel?: unknown; limits?: unknown }

const FALLBACK_CIRCLES: Opt[] = [
  { value: 'classmate', label: '同学' }, { value: 'colleague', label: '同事' },
  { value: 'client', label: '客户' }, { value: 'supplier', label: '供应商' },
  { value: 'friend', label: '朋友' }, { value: 'other', label: '普通联系人' }
];
const FALLBACK_TIERS: Opt[] = [
  { value: 'core', label: '核心圈' }, { value: 'close', label: '紧密圈' },
  { value: 'active', label: '活跃圈' }, { value: 'periphery', label: '外围圈' },
  { value: 'weak', label: '弱连接' }
];

function strMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw as Record<string, unknown>).forEach(function (k) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'string') out[k] = v;
    });
  }
  return out;
}
const circleLabels = ref<Record<string, string>>({});
const tierLabels = ref<Record<string, string>>({});
const circles = computed(function () {
  return FALLBACK_CIRCLES.map(function (o) { return { ...o, label: circleLabels.value[o.value] || o.label }; });
});
const tiers = computed(function () {
  return FALLBACK_TIERS.map(function (o) { return { ...o, label: tierLabels.value[o.value] || o.label }; });
});
const nameMax = ref(24);

const contacts = ref<Contact[]>([]);
const loading = ref(false);
const query = ref('');
const selectedId = ref('');
const editingNew = ref(false);
const busy = ref(false);

function blank(): Draft {
  return {
    id: '', name: '', circle: '', tier: '', org: '', title: '', phone: '', wechat: '',
    howMet: '', tagsText: '', giveFirst: '', note: '', followUp: ''
  };
}
const draft = ref<Draft>(blank());
const selectedTemp = computed(function () {
  const hit = contacts.value.filter(function (c) { return c.id === draft.value.id; })[0];
  return hit ? hit.temperature : null;
});

function labelOf(opts: Opt[], key: string): string {
  const hit = opts.filter(function (o) { return o.value === key; })[0];
  return hit ? hit.label : (key || '未填');
}
function tempText(t: number | null | undefined): string {
  if (typeof t !== 'number') return '—';
  return String(Math.round(t));
}
function daysText(c: Contact): string {
  if (c.never || c.daysSince === null || c.daysSince === undefined) return '未联系';
  return String(c.daysSince) + ' 天';
}

async function loadMeta(): Promise<void> {
  try {
    const m = await domainCall<Meta | null>('relation.meta');
    if (!m) return;
    circleLabels.value = strMap(m.circleLabel);
    tierLabels.value = strMap(m.tierLabel);
    const lim = m.limits as { name?: number } | undefined;
    if (lim && lim.name) nameMax.value = Number(lim.name);
  } catch (_) { /* 兜底选项已经够用 */ }
}

async function loadList(): Promise<void> {
  loading.value = true;
  try {
    const opts: Record<string, string> = {};
    if (query.value.trim()) opts.query = query.value.trim();
    const rows = await domainCall<Contact[] | null>('relation.list', opts);
    contacts.value = Array.isArray(rows) ? rows : [];
  } catch (_) {
    contacts.value = [];
  } finally {
    loading.value = false;
  }
}

function select(c: Contact): void {
  editingNew.value = false;
  selectedId.value = c.id;
  draft.value = {
    id: c.id, name: c.name || '', circle: c.circle || '', tier: c.tier || '',
    org: c.org || '', title: c.title || '', phone: c.phone || '', wechat: c.wechat || '',
    howMet: c.howMet || '', tagsText: (c.tags || []).join('、'), giveFirst: c.giveFirst || '',
    note: c.note || '', followUp: c.followUp || ''
  };
}
function openNew(): void {
  editingNew.value = true;
  selectedId.value = '';
  draft.value = blank();
}

function toPatch(d: Draft): Record<string, unknown> {
  const tags = d.tagsText.split(/[、,，\s]+/).filter(Boolean).slice(0, 8);
  return {
    name: d.name.trim(), circle: d.circle, tier: d.tier, org: d.org, title: d.title,
    phone: d.phone, wechat: d.wechat, howMet: d.howMet, tags: tags,
    giveFirst: d.giveFirst, followUp: d.followUp, note: d.note
  };
}

async function save(): Promise<void> {
  const d = draft.value;
  if (!d.name.trim()) { emit('notify', '姓名不能为空'); return; }
  if (busy.value) return;
  busy.value = true;
  try {
    if (editingNew.value) await domainCall('relation.addContact', toPatch(d));
    else await domainCall('relation.updateContact', d.id, toPatch(d));
    emit('notify', editingNew.value ? '已新增 · ' + d.name.trim() : '已保存 · ' + d.name.trim());
    editingNew.value = false;
    selectedId.value = '';
    draft.value = blank();
    await loadList();
    emit('changed');
  } catch (_) {
    emit('notify', '没存成，请重试');
  } finally {
    busy.value = false;
  }
}

async function archive(): Promise<void> {
  if (editingNew.value || !draft.value.id) return;
  try {
    await domainCall('relation.archiveContact', draft.value.id);
    emit('notify', '已归档 · 历史流水一条不删');
    selectedId.value = '';
    draft.value = blank();
    await loadList();
    emit('changed');
  } catch (_) { emit('notify', '归档失败，请重试'); }
}

async function plan(): Promise<void> {
  const d = draft.value;
  if (!d.id) return;
  try {
    await domainCall('gtd.add', {
      title: '约一下 · ' + (d.name || '未命名'), status: 'inbox',
      contactId: d.id, note: d.followUp || '', source: 'rel:' + d.id
    });
    emit('notify', '已进「工作 → 下一步行动」收件箱');
    emit('changed');
  } catch (_) { emit('notify', '没建成任务，请重试'); }
}

function reload(): void { void loadList(); }
onMounted(function () { void loadMeta(); void loadList(); });
watch(function () { return props.tick; }, reload);
</script>

<template>
  <aside class="ctx-card rel-ctx" aria-label="通讯录">
    <h2 class="ctx-title">通讯录<span class="ctx-tag">可写</span></h2>
    <div class="relc-tools">
      <input v-model="query" class="relc-input" placeholder="搜姓名 / 单位…" @input="loadList" />
      <button class="relc-add" @click="openNew">+ 新增</button>
    </div>
    <p v-if="loading" class="ctx-muted">正在读取通讯录…</p>
    <ul v-else-if="contacts.length" class="ctx-list relc-list">
      <li v-for="c in contacts" :key="c.id">
        <button class="ctx-item relc-row" :class="{ 'relc-row-on': selectedId === c.id }" @click="select(c)">
          <span class="ctx-item-main">{{ c.name }}</span>
          <span class="ctx-item-side">{{ labelOf(tiers, c.tier) }} · {{ daysText(c) }}</span>
        </button>
      </li>
    </ul>
    <p v-else class="ctx-muted">还没有联系人，点「+ 新增」记第一位。</p>

    <div v-if="editingNew || selectedId" class="relc-form">
      <h3 class="ctx-title">{{ editingNew ? '新增联系人' : '编辑 · ' + (draft.name || '未命名') }}</h3>
      <label class="relc-field"><span>姓名</span>
        <input v-model="draft.name" class="relc-input" :maxlength="nameMax" placeholder="怎么称呼" />
      </label>
      <div class="relc-grid">
        <label class="relc-field"><span>圈层</span>
          <select v-model="draft.circle" class="relc-input"><option value="">未填</option>
            <option v-for="o in circles" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <label class="relc-field"><span>亲密度</span>
          <select v-model="draft.tier" class="relc-input"><option value="">未填</option>
            <option v-for="o in tiers" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <label class="relc-field"><span>单位</span><input v-model="draft.org" class="relc-input" /></label>
        <label class="relc-field"><span>职务</span><input v-model="draft.title" class="relc-input" /></label>
        <label class="relc-field"><span>电话</span><input v-model="draft.phone" class="relc-input" /></label>
        <label class="relc-field"><span>微信</span><input v-model="draft.wechat" class="relc-input" /></label>
      </div>
      <label class="relc-field"><span>我能帮他什么</span><input v-model="draft.giveFirst" class="relc-input" /></label>
      <label class="relc-field"><span>后续 / 答应过的事</span><input v-model="draft.followUp" class="relc-input" /></label>
      <label class="relc-field"><span>备注</span><textarea v-model="draft.note" class="relc-input relc-area" rows="3"></textarea></label>
      <div class="relc-actions">
        <button class="relc-save" :disabled="busy" @click="save">保存</button>
        <button v-if="!editingNew" class="relc-btn" @click="plan">约一下</button>
        <button v-if="!editingNew" class="relc-btn" @click="archive">归档</button>
      </div>
      <p class="ctx-muted">温度 {{ tempText(selectedTemp) }} · 归档不硬删，历史流水保留。</p>
    </div>
  </aside>
</template>

<style scoped>
.relc-tools { display: flex; gap: 6px; margin: 8px 0; }
.relc-input { width: 100%; box-sizing: border-box; border: 1px solid var(--palette-line, #e7e0d3); border-radius: 6px; padding: 5px 7px; font-size: 12px; background: var(--palette-card, #fffdf9); color: var(--palette-text, #3a3a34); }
.relc-add { flex: 0 0 auto; border: 0; border-radius: 6px; padding: 5px 9px; background: var(--palette-primary, #3f5c4a); color: #fff; font-size: 12px; cursor: pointer; }
.relc-list { max-height: 220px; overflow: auto; }
.relc-row { width: 100%; text-align: left; border: 0; background: transparent; cursor: pointer; }
.relc-row-on { background: var(--palette-soft, #f6f3ec); }
.relc-form { margin-top: 12px; border-top: 1px dashed var(--palette-line, #e7e0d3); padding-top: 8px; }
.relc-field { display: block; margin: 6px 0; font-size: 11px; color: var(--palette-muted, #8d8a80); }
.relc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
.relc-area { resize: vertical; }
.relc-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.relc-save { border: 0; border-radius: 6px; padding: 5px 12px; background: var(--palette-primary, #3f5c4a); color: #fff; font-size: 12px; cursor: pointer; }
.relc-btn { border: 1px solid var(--palette-line, #e7e0d3); border-radius: 6px; padding: 5px 10px; background: transparent; font-size: 12px; cursor: pointer; }
.relc-save:disabled { opacity: .5; }
</style>
