<script setup lang="ts">
// 九格手记 · 关系经营（九格第 4 格的主栏视图）。
// 只回答四件事：这周该主动联系谁 / 上次见面聊了什么 / 关系结构偏没偏 / 答应过帮谁做什么。
// 诚实边界：温度是「记录的函数」不是「关系的函数」；权重与 90 天半衰期是启发式；
// 邓巴容量只提示、不做保存闸门；不做总分 / 健康度评分；giveFirst 只记「我能帮他什么」。
// 所有派生值（温度 / 上次联系 / 渠道分布）都由主进程读时算，本视图不存、不重算。
import { ref, computed, onMounted } from 'vue';
import { domainCall } from '../bridge';
import { localDate } from '../types';

/* ---------------- 类型：全部定义在文件内，script setup 块内不写 export ---------------- */
interface Opt { value: string; label: string; weight?: number }
interface RelationMeta {
  circles?: unknown; circleLabel?: unknown;
  tiers?: unknown; tierLabel?: unknown;
  channels?: unknown; channelLabel?: unknown; channelWeight?: unknown;
  depths?: unknown; depthLabel?: unknown; depthWeight?: unknown;
  limits?: unknown;
}
interface Contact {
  id: string; name: string; circle: string; tier: string;
  org: string; title: string; phone: string; wechat: string;
  howMet: string; giveFirst: string; tags: string[]; note: string;
  followUp?: string;
  circleLabel?: string; tierLabel?: string;
  lastContactAt?: string | null; daysSince?: number | null;
  temperature?: number | null; never?: boolean; overdue?: boolean;
  isArchived?: boolean;
}
interface Draft {
  id: string; name: string; circle: string; tier: string;
  org: string; title: string; phone: string; wechat: string;
  howMet: string; tagsText: string; giveFirst: string; note: string; followUp: string;
}
interface LogRow {
  id: string; date: string; contactIds: string[];
  channel: string; depth: string;
  summary: string; feeling: string; followUp: string;
  channelLabel?: string; depthLabel?: string;
  daysAgo?: number; channelWeight?: number; depthWeight?: number; contribution?: number;
}
interface RelationState { contacts?: Contact[]; logs?: LogRow[]; archived?: Contact[] }
interface ActionItem {
  id: string; contactId: string; name: string;
  tier?: string; tierLabel?: string;
  action?: string; actionLabel?: string; actionHint?: string;
  lastContactAt?: string | null; daysSince?: number | null;
  cadence?: number; never?: boolean; overdue?: boolean;
  giveFirst?: string; deep90?: number; temperature?: number | null; createdAt?: number;
}
interface CoolingView { label: string; action: string; count: number; items: ActionItem[]; upgrades: ActionItem[]; note: string }
interface CapacityRow { key: string; label: string; count: number; capacity: number | null; over: boolean }
interface StructureView {
  label: string; action: string; byCircle: Record<string, number>; total: number;
  bonding: number; bridging: number; bridgingRatio: number; narrow: boolean; hint: string;
  recentWeak: ActionItem[]; tierCapacity: CapacityRow[]; note: string;
}
interface ChannelsView {
  label: string; action: string; weeks: number; windowDays: number;
  mix: Record<string, number>; ratio: Record<string, number>; total: number;
  online: number; onlineRatio: number; onlinePct: number; onlyOnline: boolean;
  hint: string; candidates: ActionItem[]; note: string;
}
interface GiveView { label: string; action: string; count: number; items: ActionItem[]; note: string }
interface Analytics {
  today: string; cooling: CoolingView; structure: StructureView;
  channels: ChannelsView; giveFirst: GiveView; note: string;
}

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'notify', msg: string): void;
  (e: 'go-date', date: string): void;
  (e: 'go-cell', key: string): void;
}>();

/* ---------------- 枚举兜底：一切以 relation.meta() 为准，meta 缺失时才用这份 ---------------- */
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
const FALLBACK_CHANNELS: Opt[] = [
  { value: 'meal', label: '餐会', weight: 2.5 }, { value: 'meet', label: '见面', weight: 2.0 },
  { value: 'meeting', label: '会议', weight: 1.3 }, { value: 'call', label: '电话', weight: 1.3 },
  { value: 'mail', label: '邮件', weight: 0.7 }, { value: 'wechat', label: '微信', weight: 0.7 }
];
const FALLBACK_DEPTHS: Opt[] = [
  { value: 'small', label: '寒暄', weight: 0.8 }, { value: 'work', label: '事务', weight: 1.0 },
  { value: 'deep', label: '交心', weight: 1.4 }
];

/* ---------------- 状态 ---------------- */
type Tab = 'book' | 'logs' | 'analytics';
const tab = ref<Tab>('book');
const notice = ref('');
const errMsg = ref('');

const meta = ref<RelationMeta | null>(null);
const contacts = ref<Contact[]>([]);
const allPeople = ref<Contact[]>([]);
const idName = ref<Record<string, string>>({});
const allLogs = ref<LogRow[]>([]);
const analytics = ref<Analytics | null>(null);
const listLoading = ref(false);
const readLoading = ref(false);
const analyticsLoading = ref(false);

const filterCircle = ref('');
const filterTier = ref('');
const query = ref('');

const selectedId = ref('');
const editingNew = ref(false);
function blankDraft(): Draft {
  return {
    id: '', name: '', circle: '', tier: '', org: '', title: '', phone: '',
    wechat: '', howMet: '', tagsText: '', giveFirst: '', note: '', followUp: ''
  };
}
const draft = ref<Draft>(blankDraft());
const hasDraft = computed<boolean>(() => editingNew.value || selectedId.value !== '');
const detailLogs = ref<LogRow[]>([]);
const detailTemp = ref<number | null>(null);
// 会话内记忆：若主进程未把 followUp 纳入联系人白名单，界面也不会把用户填的内容静默清空。
const followUpMemo = ref<Record<string, string>>({});

const logOpen = ref(false);
const logError = ref('');
const logContactIds = ref<string[]>([]);
const logDate = ref('');
const logChannel = ref('');
const logDepth = ref('');
const logSummary = ref('');
const logFeeling = ref('');
const logFollowUp = ref('');

const logFilterId = ref('');
const personLogs = ref<LogRow[]>([]);
const logFilterLoading = ref(false);

/* ---------------- 通用小工具 ---------------- */
function strMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    Object.keys(obj).forEach(function (k) {
      const v = obj[k];
      out[k] = v === null || v === undefined ? '' : String(v);
    });
  }
  return out;
}
function numMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    Object.keys(obj).forEach(function (k) {
      const n = Number(obj[k]);
      out[k] = isFinite(n) ? n : 0;
    });
  }
  return out;
}
// meta 里的枚举可能是 key 数组，也可能是 {key,label} 对象数组；两种都吃，label 映射兜底显示。
function asOptions(raw: unknown, labels: Record<string, string>, weights: Record<string, number>, fallback: Opt[]): Opt[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: Opt[] = [];
  arr.forEach(function (x) {
    if (typeof x === 'string' || typeof x === 'number') {
      const v = String(x);
      if (!v) return;
      out.push({ value: v, label: labels[v] || v, weight: weights[v] });
    } else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const v = String(o.key === undefined ? (o.value === undefined ? (o.id === undefined ? '' : o.id) : o.value) : o.key);
      if (!v) return;
      const l = o.label === undefined ? (labels[v] || v) : String(o.label);
      const w = weights[v] === undefined ? (typeof o.weight === 'number' ? o.weight : undefined) : weights[v];
      out.push({ value: v, label: l, weight: w });
    }
  });
  return out.length ? out : fallback;
}
function labelOf(opts: Opt[], key: string): string {
  const hit = opts.filter(function (o) { return o.value === key; })[0];
  return hit ? hit.label : (key || '—');
}
function limitOf(key: string, def: number): number {
  const m = numMap(meta.value ? meta.value.limits : null);
  const n = Number(m[key]);
  return n > 0 ? n : def;
}

/* ---------------- meta 派生（全部以 meta() 为准，失败则用兜底） ---------------- */
const circleOptions = computed<Opt[]>(() => asOptions(
  meta.value ? meta.value.circles : null,
  strMap(meta.value ? meta.value.circleLabel : null), {}, FALLBACK_CIRCLES
));
const tierOptions = computed<Opt[]>(() => asOptions(
  meta.value ? meta.value.tiers : null,
  strMap(meta.value ? meta.value.tierLabel : null), {}, FALLBACK_TIERS
));
const channelOptions = computed<Opt[]>(() => asOptions(
  meta.value ? meta.value.channels : null,
  strMap(meta.value ? meta.value.channelLabel : null),
  numMap(meta.value ? meta.value.channelWeight : null), FALLBACK_CHANNELS
));
const depthOptions = computed<Opt[]>(() => asOptions(
  meta.value ? meta.value.depths : null,
  strMap(meta.value ? meta.value.depthLabel : null),
  numMap(meta.value ? meta.value.depthWeight : null), FALLBACK_DEPTHS
));

/* ---------------- 展示用文本 ---------------- */
function tempText(t: number | null | undefined): string {
  return t === null || t === undefined ? '还没记过' : String(t) + '°';
}
function tempClass(t: number | null | undefined): string {
  if (t === null || t === undefined) return 'rel-temp-none';
  if (t >= 60) return 'rel-temp-hot';
  if (t >= 30) return 'rel-temp-warm';
  return 'rel-temp-cool';
}
function lastText(c: Contact): string {
  if (!c.lastContactAt) return '还没联系过';
  const d = c.daysSince === null || c.daysSince === undefined ? '' : ' · ' + c.daysSince + ' 天前';
  return c.lastContactAt + d;
}
function participants(l: LogRow): string {
  const ids = Array.isArray(l.contactIds) ? l.contactIds : [];
  return ids.map(function (id) { return idName.value[id] || id; }).join('、') || '（未关联联系人）';
}
function channelLabelOf(l: LogRow): string {
  return l.channelLabel || labelOf(channelOptions.value, l.channel);
}
function depthLabelOf(l: LogRow): string {
  return l.depthLabel || labelOf(depthOptions.value, l.depth);
}
function fmtDays(n: number | null | undefined): string {
  return n === null || n === undefined ? '从未记录' : n + ' 天';
}

/* ---------------- 提示：错误一定可见，不静默失败 ---------------- */
function say(msg: string): void {
  errMsg.value = '';
  notice.value = msg;
  emit('notify', msg);
}
function fail(what: string, e: unknown): void {
  const m = what + '：' + (e && (e as Error).message ? (e as Error).message : String(e));
  notice.value = '';
  errMsg.value = m;
  emit('notify', m);
}

/* ---------------- 读取 ---------------- */
async function loadMeta(): Promise<void> {
  try {
    meta.value = await domainCall<RelationMeta>('relation.meta');
  } catch (e) {
    fail('关系元数据读取失败（下拉框已用内置默认值）', e);
  }
}
async function loadList(): Promise<void> {
  listLoading.value = true;
  try {
    const opts: Record<string, string> = {};
    if (filterCircle.value) opts.circle = filterCircle.value;
    if (filterTier.value) opts.tier = filterTier.value;
    if (query.value.trim()) opts.query = query.value.trim();
    const rows = await domainCall<Contact[]>('relation.list', opts);
    contacts.value = Array.isArray(rows) ? rows : [];
  } catch (e) {
    fail('通讯录读取失败', e);
  } finally {
    listLoading.value = false;
  }
}
async function loadRead(): Promise<void> {
  readLoading.value = true;
  try {
    const s = await domainCall<RelationState>('relation.read');
    const active = Array.isArray(s && s.contacts) ? s!.contacts! : [];
    const archived = Array.isArray(s && s.archived) ? s!.archived! : [];
    const map: Record<string, string> = {};
    active.concat(archived).forEach(function (c) { map[c.id] = c.name; });
    idName.value = map;
    allPeople.value = active.concat(archived);
    const logs = Array.isArray(s && s.logs) ? s!.logs! : [];
    allLogs.value = logs;
  } catch (e) {
    fail('联系流水读取失败', e);
  } finally {
    readLoading.value = false;
  }
}
async function loadAnalytics(): Promise<void> {
  analyticsLoading.value = true;
  try {
    analytics.value = await domainCall<Analytics | null>('relation.analytics');
  } catch (e) {
    fail('关系分析读取失败', e);
  } finally {
    analyticsLoading.value = false;
  }
}
async function loadDetail(id: string): Promise<void> {
  try {
    const pair = await Promise.all([
      domainCall<LogRow[]>('relation.logsFor', id),
      domainCall<number | null>('relation.temperature', id)
    ]);
    detailLogs.value = Array.isArray(pair[0]) ? pair[0] : [];
    detailTemp.value = typeof pair[1] === 'number' ? pair[1] : null;
  } catch (e) {
    fail('联系人详情读取失败', e);
  }
}
async function loadLogsFor(): Promise<void> {
  logFilterLoading.value = true;
  const id = logFilterId.value;
  try {
    if (id) {
      const rows = await domainCall<LogRow[]>('relation.logsFor', id);
      personLogs.value = Array.isArray(rows) ? rows : [];
    } else {
      personLogs.value = [];
    }
  } catch (e) {
    fail('按人查看流水失败', e);
  } finally {
    logFilterLoading.value = false;
  }
}

/* ---------------- 通讯录：表单 ---------------- */
function toDraft(c: Contact): Draft {
  return {
    id: c.id, name: c.name || '', circle: c.circle || '', tier: c.tier || '',
    org: c.org || '', title: c.title || '', phone: c.phone || '', wechat: c.wechat || '',
    howMet: c.howMet || '', tagsText: (Array.isArray(c.tags) ? c.tags : []).join('、'),
    giveFirst: c.giveFirst || '', note: c.note || '',
    followUp: c.followUp || followUpMemo.value[c.id] || ''
  };
}
function emptyDraft(): Draft {
  return {
    id: '', name: '', circle: circleOptions.value[0] ? circleOptions.value[0].value : 'other',
    tier: 'active', org: '', title: '', phone: '', wechat: '', howMet: '',
    tagsText: '', giveFirst: '', note: '', followUp: ''
  };
}
function splitTags(text: string): string[] {
  return text.split(/[,，、;；\s]+/)
    .map(function (s) { return s.trim().replace(/^#+/, ''); })
    .filter(Boolean).slice(0, 8);
}
function draftToPatch(d: Draft): Record<string, unknown> {
  return {
    name: d.name.trim(), circle: d.circle, tier: d.tier,
    org: d.org, title: d.title, phone: d.phone, wechat: d.wechat,
    howMet: d.howMet, tags: splitTags(d.tagsText),
    giveFirst: d.giveFirst, note: d.note, followUp: d.followUp
  };
}
async function selectContact(c: Contact): Promise<void> {
  selectedId.value = c.id;
  editingNew.value = false;
  draft.value = toDraft(c);
  await loadDetail(c.id);
}
function openNew(): void {
  editingNew.value = true;
  selectedId.value = '';
  draft.value = emptyDraft();
  detailLogs.value = [];
  detailTemp.value = null;
  tab.value = 'book';
}
async function saveContact(): Promise<void> {
  const d = draft.value;
  if (!d.name.trim()) {
    errMsg.value = '姓名不能为空——没有姓名的记录会被主进程整条丢弃。';
    emit('notify', errMsg.value);
    return;
  }
  const patch = draftToPatch(d);
  const isNew = editingNew.value;
  try {
    if (isNew) {
      await domainCall<unknown>('relation.addContact', patch);
    } else {
      await domainCall<unknown>('relation.updateContact', d.id, patch);
    }
    if (d.id) followUpMemo.value[d.id] = d.followUp;
    if (isNew) {
      // 新增成功即退出「新增」态，避免连点保存重复建人；新行已出现在左边列表里。
      editingNew.value = false;
      selectedId.value = '';
      draft.value = blankDraft();
      say('已新增联系人 · ' + d.name.trim() + '。已出现在左边列表，点这一行可继续编辑或「约一下 / 记一次」。');
    } else {
      say('已保存 · ' + d.name.trim());
    }
    await Promise.all([loadList(), loadRead(), loadAnalytics()]);
    if (!isNew && selectedId.value) await loadDetail(selectedId.value);
  } catch (e) {
    fail('保存联系人失败', e);
  }
}
async function archiveCurrent(): Promise<void> {
  const d = draft.value;
  if (editingNew.value || !d.id) return;
  try {
    await domainCall<unknown>('relation.archiveContact', d.id);
    say('已归档 · ' + d.name + '。只移出通讯录、绝不硬删，TA 的历史流水一条都还在。');
    selectedId.value = '';
    draft.value = blankDraft();
    detailLogs.value = [];
    detailTemp.value = null;
    await Promise.all([loadList(), loadRead(), loadAnalytics()]);
  } catch (e) {
    fail('归档失败', e);
  }
}

/* ---------------- 两个入口必须分开 ---------------- */
// 「约一下」= 还没发生：只建一条 GTD 收件箱任务，不写流水、不改温度。
async function planFor(id: string, name: string): Promise<void> {
  try {
    await domainCall<unknown>('gtd.add', {
      title: '约一下 · ' + name,
      status: 'inbox',
      contactId: id,
      note: '来自关系经营：这件事还没发生。约好并真的见面 / 通话后，回来点「记一次」写进流水。'
    });
    say('已建任务（收件箱）· 约一下 ' + name + '。这是「还没发生」；真见了面记得回来「记一次」。');
  } catch (e) {
    fail('建「约一下」任务失败', e);
  }
}
function planCurrent(): void {
  const d = draft.value;
  if (!d.id) { errMsg.value = '先选中一个已保存的联系人，才能「约一下」。'; emit('notify', errMsg.value); return; }
  void planFor(d.id, d.name);
}
// 「记一次」= 已经发生：打开记录面板，勾人 / 选渠道深度 / 写感想，提交 relation.addLog。
function openLog(preId?: string): void {
  logOpen.value = true;
  logError.value = '';
  const seed = preId || selectedId.value;
  logContactIds.value = seed ? [seed] : [];
  logDate.value = localDate();
  logChannel.value = channelOptions.value[0] ? channelOptions.value[0].value : 'wechat';
  logDepth.value = depthOptions.value[0] ? depthOptions.value[0].value : 'work';
  logSummary.value = '';
  logFeeling.value = '';
  logFollowUp.value = '';
}
async function submitLog(): Promise<void> {
  if (!logContactIds.value.length) {
    logError.value = '至少勾一个人——餐会 / 会议常常是一桌人，可以勾多个。';
    return;
  }
  if (!logDate.value) {
    logError.value = '选一下这次联系发生的日期。';
    return;
  }
  try {
    await domainCall<unknown>('relation.addLog', {
      contactIds: logContactIds.value.slice(),
      date: logDate.value, channel: logChannel.value, depth: logDepth.value,
      summary: logSummary.value, feeling: logFeeling.value, followUp: logFollowUp.value
    });
    const n = logContactIds.value.length;
    logOpen.value = false;
    say('已记一次 · ' + n + ' 人。列表与温度已按新记录重算。');
    await Promise.all([loadList(), loadRead(), loadAnalytics()]);
    if (selectedId.value) await loadDetail(selectedId.value);
    if (logFilterId.value) await loadLogsFor();
  } catch (e) {
    fail('写入联系流水失败', e);
  }
}
async function removeLog(id: string): Promise<void> {
  try {
    await domainCall<unknown>('relation.removeLog', id);
    say('已删掉这条记错的记录，温度自动重算，不会留下两份真相。');
    await Promise.all([loadList(), loadRead(), loadAnalytics()]);
    if (logFilterId.value) await loadLogsFor();
    if (selectedId.value) await loadDetail(selectedId.value);
  } catch (e) {
    fail('删除流水失败', e);
  }
}

/* ---------------- tab 与初始化 ---------------- */
function switchTab(t: Tab): void {
  tab.value = t;
  if (t === 'logs' && logFilterId.value) void loadLogsFor();
  if (t === 'analytics') void loadAnalytics();
}
onMounted(function () {
  void loadMeta();
  void loadList();
  void loadRead();
  void loadAnalytics();
});

/* ---------------- 分析：把四个视角整理成模板可直接遍历的数组，避免深层空值 ---------------- */
const a = computed<Analytics | null>(() => analytics.value);
const analyticsNote = computed<string>(() => a.value ? a.value.note : '');
const cooling = computed<CoolingView | null>(() => a.value ? a.value.cooling : null);
const structure = computed<StructureView | null>(() => a.value ? a.value.structure : null);
const channelsView = computed<ChannelsView | null>(() => a.value ? a.value.channels : null);
const giveView = computed<GiveView | null>(() => a.value ? a.value.giveFirst : null);

const coolingItems = computed<ActionItem[]>(() => cooling.value && Array.isArray(cooling.value.items) ? cooling.value.items : []);
const coolingUpgrades = computed<ActionItem[]>(() => cooling.value && Array.isArray(cooling.value.upgrades) ? cooling.value.upgrades : []);
const circleDist = computed<Array<{ label: string; value: string; count: number }>>(() => {
  const by = structure.value && structure.value.byCircle ? structure.value.byCircle : {};
  return circleOptions.value.map(function (o) {
    return { label: o.label, value: o.value, count: Number(by[o.value] || 0) };
  });
});
const recentWeak = computed<ActionItem[]>(() => structure.value && Array.isArray(structure.value.recentWeak) ? structure.value.recentWeak : []);
const tierCapacity = computed<CapacityRow[]>(() => structure.value && Array.isArray(structure.value.tierCapacity) ? structure.value.tierCapacity : []);
const channelDist = computed<Array<{ label: string; value: string; count: number; pct: number }>>(() => {
  const mix = channelsView.value && channelsView.value.mix ? channelsView.value.mix : {};
  const ratio = channelsView.value && channelsView.value.ratio ? channelsView.value.ratio : {};
  return channelOptions.value.map(function (o) {
    return { label: o.label, value: o.value, count: Number(mix[o.value] || 0), pct: Number(ratio[o.value] || 0) };
  });
});
const meetCandidates = computed<ActionItem[]>(() => channelsView.value && Array.isArray(channelsView.value.candidates) ? channelsView.value.candidates : []);
const giveItems = computed<ActionItem[]>(() => giveView.value && Array.isArray(giveView.value.items) ? giveView.value.items : []);
const shownLogs = computed<LogRow[]>(() => logFilterId.value ? personLogs.value : allLogs.value);
const logPeople = computed<Contact[]>(() => allPeople.value.length ? allPeople.value : contacts.value);
const totalContacts = computed<number>(() => allPeople.value.length || contacts.value.length);
const formulaWeights = computed<string>(() => channelOptions.value.map(function (o) {
  return o.label + ' ' + (o.weight === undefined ? '—' : o.weight);
}).join(' · '));
const formulaDepths = computed<string>(() => depthOptions.value.map(function (o) {
  return o.label + ' ' + (o.weight === undefined ? '—' : o.weight);
}).join(' · '));
</script>

<template>
  <section class="rel-wrap" aria-label="关系经营">
    <header class="rel-head">
      <button class="rel-back" @click="emit('back')">← 返回</button>
      <h1 class="rel-h1">关系经营</h1>
      <button class="rel-link" @click="emit('go-cell', 'relation')">去九格 · 关系经营格写一句 →</button>
    </header>

    <div class="rel-tabs" role="tablist">
      <button class="rel-tab" :class="{ 'rel-tab-on': tab === 'book' }" role="tab" :aria-selected="tab === 'book'" @click="switchTab('book')">通讯录</button>
      <button class="rel-tab" :class="{ 'rel-tab-on': tab === 'logs' }" role="tab" :aria-selected="tab === 'logs'" @click="switchTab('logs')">联系流水</button>
      <button class="rel-tab" :class="{ 'rel-tab-on': tab === 'analytics' }" role="tab" :aria-selected="tab === 'analytics'" @click="switchTab('analytics')">关系分析</button>
      <span class="rel-spacer"></span>
      <span class="rel-count">共 {{ totalContacts }} 位联系人 · {{ allLogs.length }} 条流水</span>
    </div>

    <p v-if="notice" class="rel-msg">{{ notice }}</p>
    <p v-if="errMsg" class="rel-err">{{ errMsg }}</p>

    <!-- ==================== 记录面板：「记一次」= 已经发生 ==================== -->
    <section v-if="logOpen" class="rel-logpanel" aria-label="记一次">
      <div class="rel-panelhead">
        <h2 class="rel-h2">记一次 · 已经发生过的联系</h2>
        <button class="rel-x" @click="logOpen = false">收起</button>
      </div>
      <div class="rel-field">
        <span class="rel-label">参与了谁 <em class="rel-req">至少 1 人</em></span>
        <div class="rel-checks">
          <label v-for="p in logPeople" :key="p.id" class="rel-check">
            <input type="checkbox" :value="p.id" v-model="logContactIds" />
            <span>{{ p.name }}</span>
          </label>
          <span v-if="!logPeople.length" class="rel-hint">通讯录还是空的，先去「新增联系人」。</span>
        </div>
      </div>
      <div class="rel-formrow">
        <label class="rel-field"><span class="rel-label">日期</span><input class="rel-input" type="date" v-model="logDate" /></label>
        <label class="rel-field"><span class="rel-label">渠道</span>
          <select class="rel-input" v-model="logChannel">
            <option v-for="o in channelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <label class="rel-field"><span class="rel-label">深度</span>
          <select class="rel-input" v-model="logDepth">
            <option v-for="o in depthOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
      </div>
      <label class="rel-field"><span class="rel-label">聊了什么（摘要）</span>
        <input class="rel-input" :maxlength="limitOf('summary', 200)" v-model="logSummary" placeholder="一句就够，比如「聊了孩子升学」" />
      </label>
      <label class="rel-field"><span class="rel-label">我的感想</span>
        <textarea class="rel-input rel-textarea" :maxlength="limitOf('feeling', 300)" v-model="logFeeling" placeholder="可留空"></textarea>
      </label>
      <label class="rel-field"><span class="rel-label">后续 / 答应过的事</span>
        <textarea class="rel-input rel-textarea" :maxlength="limitOf('followUp', 100)" v-model="logFollowUp" placeholder="可留空"></textarea>
      </label>
      <p v-if="logError" class="rel-err">{{ logError }}</p>
      <div class="rel-actions">
        <button class="rel-btn rel-btn-primary" @click="submitLog">写入流水</button>
        <button class="rel-btn" @click="logOpen = false">取消</button>
      </div>
    </section>

    <!-- ==================== tab 1 通讯录 ==================== -->
    <section v-if="tab === 'book'" class="rel-panel" aria-label="通讯录">
      <div class="rel-filters">
        <select class="rel-input" v-model="filterCircle" @change="loadList">
          <option value="">全部来源圈层</option>
          <option v-for="o in circleOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <select class="rel-input" v-model="filterTier" @change="loadList">
          <option value="">全部亲密度</option>
          <option v-for="o in tierOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <input class="rel-input rel-search" v-model="query" @input="loadList" placeholder="搜姓名 / 单位 / 备注…" />
        <button class="rel-btn rel-btn-primary" @click="openNew">+ 新增联系人</button>
      </div>

      <div class="rel-book">
        <div class="rel-list">
          <div class="rel-listhead">
            <span class="rel-col-name">姓名</span>
            <span class="rel-col-circle">圈层</span>
            <span class="rel-col-tier">亲密度</span>
            <span class="rel-col-last">上次联系</span>
            <span class="rel-col-temp">温度</span>
          </div>
          <div v-if="listLoading" class="rel-empty">正在读取通讯录…</div>
          <div v-else-if="!contacts.length" class="rel-empty">还没有联系人。</div>
          <button
            v-for="c in contacts" :key="c.id"
            class="rel-row" :class="{ 'rel-row-on': selectedId === c.id }"
            @click="selectContact(c)"
          >
            <span class="rel-col-name rel-ellip">{{ c.name }}</span>
            <span class="rel-col-circle">{{ labelOf(circleOptions, c.circle) }}</span>
            <span class="rel-col-tier">{{ labelOf(tierOptions, c.tier) }}</span>
            <span class="rel-col-last">{{ lastText(c) }}</span>
            <span class="rel-col-temp rel-temp" :class="tempClass(c.temperature)">{{ tempText(c.temperature) }}</span>
          </button>
        </div>

        <!-- 右栏：可编辑详情 + 两个分开的入口 + 该人流水与温度拆解 -->
        <div class="rel-detail">
          <div v-if="!hasDraft" class="rel-empty">选一行查看详情。</div>
          <template v-else>
            <div class="rel-panelhead">
              <h2 class="rel-h2">{{ editingNew ? '新增联系人' : '编辑 · ' + (draft.name || '未命名') }}</h2>
              <span class="rel-temp rel-temp-big" :class="tempClass(detailTemp)">{{ tempText(detailTemp) }}</span>
            </div>
            <div class="rel-formgrid">
              <label class="rel-field"><span class="rel-label">姓名 <em class="rel-req">必填</em></span>
                <input class="rel-input" :maxlength="limitOf('name', 24)" v-model="draft.name" placeholder="怎么称呼" />
              </label>
              <label class="rel-field"><span class="rel-label">来源圈层</span>
                <select class="rel-input" v-model="draft.circle">
                  <option v-for="o in circleOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
              <label class="rel-field"><span class="rel-label">亲密度</span>
                <select class="rel-input" v-model="draft.tier">
                  <option v-for="o in tierOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
              <label class="rel-field"><span class="rel-label">单位</span>
                <input class="rel-input" :maxlength="limitOf('org', 40)" v-model="draft.org" />
              </label>
              <label class="rel-field"><span class="rel-label">职务</span>
                <input class="rel-input" :maxlength="limitOf('title', 24)" v-model="draft.title" />
              </label>
              <label class="rel-field"><span class="rel-label">电话</span>
                <input class="rel-input" :maxlength="limitOf('phone', 32)" v-model="draft.phone" />
              </label>
              <label class="rel-field"><span class="rel-label">微信</span>
                <input class="rel-input" :maxlength="limitOf('wechat', 40)" v-model="draft.wechat" />
              </label>
              <label class="rel-field"><span class="rel-label">怎么认识的</span>
                <input class="rel-input" :maxlength="limitOf('howMet', 60)" v-model="draft.howMet" />
              </label>
              <label class="rel-field rel-field-wide"><span class="rel-label">标签</span>
                <input class="rel-input" v-model="draft.tagsText" placeholder="例：同城、读书会、老同事" />
              </label>
              <label class="rel-field rel-field-wide"><span class="rel-label rel-label-key">我能帮他什么</span>
                <input class="rel-input" :maxlength="limitOf('giveFirst', 120)" v-model="draft.giveFirst" placeholder="只记这一栏，不做「他给过我什么」的对称账" />
              </label>
              <label class="rel-field rel-field-wide"><span class="rel-label">后续 / 答应过的事</span>
                <input class="rel-input" v-model="draft.followUp" placeholder="答应过帮 TA 做的事" />
              </label>
              <label class="rel-field rel-field-wide"><span class="rel-label">备注</span>
                <textarea class="rel-input rel-textarea" :maxlength="limitOf('note', 400)" v-model="draft.note"></textarea>
              </label>
            </div>

            <div class="rel-actions">
              <button class="rel-btn rel-btn-primary" @click="saveContact">保存</button>
              <button class="rel-btn" :disabled="editingNew || !selectedId" @click="planCurrent">约一下（还没发生）</button>
              <button class="rel-btn" @click="openLog()">记一次（已经发生）</button>
              <button class="rel-btn rel-btn-danger" :disabled="editingNew || !selectedId" @click="archiveCurrent">归档（不硬删）</button>
            </div>

            <div class="rel-subblock">
              <h3 class="rel-h3">TA 的联系流水 · 温度拆解</h3>
              <p v-if="!detailLogs.length" class="rel-hint">还没有流水。</p>
              <div v-for="l in detailLogs" :key="l.id" class="rel-breakdown">
                <button class="rel-logdate" @click="emit('go-date', l.date)">{{ l.date }}</button>
                <span class="rel-breakdown-main">{{ channelLabelOf(l) }} · {{ depthLabelOf(l) }}</span>
                <span class="rel-breakdown-calc" v-if="l.contribution !== undefined">
                  贡献 {{ l.contribution }} = {{ l.channelWeight }} × {{ l.depthWeight }} × 0.5^({{ l.daysAgo }}/90)
                </span>
                <span class="rel-breakdown-sum">{{ l.summary }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- ==================== tab 2 联系流水 ==================== -->
    <section v-else-if="tab === 'logs'" class="rel-panel" aria-label="联系流水">
      <div class="rel-filters">
        <select class="rel-input" v-model="logFilterId" @change="loadLogsFor">
          <option value="">全部人的流水</option>
          <option v-for="p in logPeople" :key="p.id" :value="p.id">{{ p.name }}（含温度拆解）</option>
        </select>
        <button class="rel-btn rel-btn-primary" @click="openLog()">+ 记一次（已经发生）</button>
        <span class="rel-hint">只看已发生的事；「约一下」只建任务，不会出现在流水里。</span>
      </div>
      <div v-if="readLoading || logFilterLoading" class="rel-empty">正在读取联系流水…</div>
      <div v-else-if="!shownLogs.length" class="rel-empty">还没有联系流水。回「通讯录」选中一个人，点「记一次」把已经发生过的见面 / 通话写下来。</div>
      <div v-else class="rel-loglist">
        <article v-for="l in shownLogs" :key="l.id" class="rel-logrow">
          <button class="rel-logdate" @click="emit('go-date', l.date)">{{ l.date }}</button>
          <span class="rel-logwho">{{ participants(l) }}</span>
          <span class="rel-logch">{{ channelLabelOf(l) }} · {{ depthLabelOf(l) }}</span>
          <span class="rel-logsum">{{ l.summary || '（没写摘要）' }}</span>
          <span v-if="l.feeling" class="rel-logextra">感想：{{ l.feeling }}</span>
          <span v-if="l.followUp" class="rel-logextra">后续：{{ l.followUp }}</span>
          <span v-if="l.contribution !== undefined" class="rel-logcalc">
            温度贡献 {{ l.contribution }} = {{ l.channelWeight }} × {{ l.depthWeight }} × 0.5^({{ l.daysAgo }}/90) · {{ l.daysAgo }} 天前
          </span>
          <button class="rel-rowbtn" @click="removeLog(l.id)">删掉这条</button>
        </article>
      </div>
    </section>

    <!-- ==================== tab 3 关系分析 ==================== -->
    <section v-else class="rel-panel" aria-label="关系分析">

      <div v-if="analyticsLoading" class="rel-empty">正在计算四个视角…</div>
      <div v-else-if="!analytics" class="rel-empty">暂时没有可分析的数据。先加几个联系人、记几次联系，四个视角就会各自给出一个动作。</div>
      <div v-else class="rel-views">
        <!-- 视角 1 冷却名单 -->
        <section class="rel-view" aria-label="冷却名单">
          <div class="rel-viewhead">
            <h3 class="rel-h3">{{ cooling ? cooling.label : '冷却名单' }}</h3>
            <span class="rel-badge">{{ cooling ? cooling.count : 0 }} 人</span>
          </div>
          <p class="rel-actionline">动作：{{ cooling ? cooling.action : '「约一下」→ 建任务' }}</p>
          <p v-if="!coolingItems.length" class="rel-hint">暂时没有人冷却，挺好。</p>
          <div v-for="it in coolingItems" :key="it.id" class="rel-viewrow">
            <span class="rel-vname">{{ it.name }}</span>
            <span class="rel-vtier">{{ it.tierLabel }}</span>
            <span class="rel-vdays">{{ fmtDays(it.daysSince) }}</span>
            <span class="rel-vhint">{{ it.actionHint }}</span>
            <button class="rel-btn rel-btn-small" @click="planFor(it.contactId, it.name)">约一下</button>
          </div>
          <p v-if="coolingUpgrades.length" class="rel-actionline">顺带看一眼：</p>
          <div v-for="it in coolingUpgrades" :key="'up-' + it.id" class="rel-viewrow">
            <span class="rel-vname">{{ it.name }}</span>
            <span class="rel-vhint">{{ it.actionHint || it.action }}</span>
          </div>
          <p class="rel-note">{{ cooling ? cooling.note : '' }}</p>
        </section>

        <!-- 视角 2 来源圈层分布 -->
        <section class="rel-view" aria-label="来源圈层分布">
          <div class="rel-viewhead">
            <h3 class="rel-h3">{{ structure ? structure.label : '来源圈层分布' }}</h3>
            <span class="rel-badge">{{ structure ? structure.total : 0 }} 人</span>
          </div>
          <p class="rel-actionline">动作：{{ structure ? structure.action : '看看这半年新认识的人' }}</p>
          <p class="rel-hint">{{ structure ? structure.hint : '' }}（bonding 抗风险，bridging 带新信息；同事两栏各计一半。）</p>
          <div class="rel-dist">
            <div v-for="d in circleDist" :key="d.value" class="rel-distrow">
              <span class="rel-distlabel">{{ d.label }}</span>
              <span class="rel-distbar"><span class="rel-distfill" :style="{ width: (structure && structure.total ? Math.min(100, Math.round(d.count * 100 / structure.total)) : 0) + '%' }"></span></span>
              <span class="rel-distnum">{{ d.count }}</span>
            </div>
          </div>
          <div v-for="tc in tierCapacity" :key="tc.key" class="rel-viewrow">
            <span class="rel-vname">{{ tc.label }}</span>
            <span class="rel-vdays">{{ tc.count }} / {{ tc.capacity === null ? '不限' : tc.capacity }}</span>
            <span class="rel-vhint" :class="{ 'rel-over': tc.over }">{{ tc.over ? '超过提示容量' : '在容量内' }}</span>
          </div>
          <p v-if="recentWeak.length" class="rel-actionline">近 90 天新认识的弱连接（约一个聊聊看）：</p>
          <div v-for="it in recentWeak" :key="'rw-' + it.id" class="rel-viewrow">
            <span class="rel-vname">{{ it.name }}</span>
            <span class="rel-vhint">{{ it.actionHint || it.action }}</span>
          </div>
          <p class="rel-note">{{ structure ? structure.note : '' }}</p>
        </section>

        <!-- 视角 3 渠道分布 -->
        <section class="rel-view" aria-label="渠道分布">
          <div class="rel-viewhead">
            <h3 class="rel-h3">{{ channelsView ? channelsView.label : '渠道分布' }}</h3>
            <span class="rel-badge">{{ channelsView ? channelsView.total : 0 }} 次</span>
          </div>
          <p class="rel-actionline">动作：{{ channelsView ? channelsView.action : '挑三个人这周见一面' }}</p>
          <p class="rel-hint">{{ channelsView ? channelsView.hint : '' }}</p>
          <div class="rel-dist">
            <div v-for="d in channelDist" :key="d.value" class="rel-distrow">
              <span class="rel-distlabel">{{ d.label }}</span>
              <span class="rel-distbar"><span class="rel-distfill" :style="{ width: d.pct + '%' }"></span></span>
              <span class="rel-distnum">{{ d.pct }}% · {{ d.count }}</span>
            </div>
          </div>
          <p v-if="meetCandidates.length" class="rel-actionline">温度不低、却全是线上往来，这周见一面：</p>
          <div v-for="it in meetCandidates" :key="'mc-' + it.id" class="rel-viewrow">
            <span class="rel-vname">{{ it.name }}</span>
            <span class="rel-vhint">{{ it.actionHint || it.action }}</span>
          </div>
          <p class="rel-note">{{ channelsView ? channelsView.note : '' }}</p>
        </section>

        <!-- 视角 4 该看一眼 · 给予清单 -->
        <section class="rel-view" aria-label="该看一眼">
          <div class="rel-viewhead">
            <h3 class="rel-h3">{{ giveView ? giveView.label : '该看一眼 · 给予清单' }}</h3>
            <span class="rel-badge">{{ giveView ? giveView.count : 0 }} 件</span>
          </div>
          <p class="rel-actionline">动作：{{ giveView ? giveView.action : '这件事什么时候做 / 标记已给过' }}</p>
          <p v-if="!giveItems.length" class="rel-hint">还没写下「我能帮他什么」。回通讯录在某个人的这一栏记一句，这里就会列出来。</p>
          <div v-for="it in giveItems" :key="'g-' + it.id" class="rel-viewrow">
            <span class="rel-vname">{{ it.name }}</span>
            <span class="rel-vtier">{{ it.tierLabel }}</span>
            <span class="rel-give">我能帮他什么：{{ it.giveFirst }}</span>
            <span class="rel-vhint">{{ it.actionHint || it.action }}</span>
          </div>
          <p class="rel-note">{{ giveView ? giveView.note : '' }}</p>
        </section>
      </div>
      <p class="rel-note">整体口径：{{ analyticsNote }}</p>
    </section>
  </section>
</template>

<style scoped>
.rel-wrap { display: flex; flex-direction: column; gap: 14px; color: var(--text-primary, #2c2c2a); }
.rel-head { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.rel-back, .rel-link { border: 0; background: transparent; color: var(--text-secondary, #5f5e5a); cursor: pointer; font-size: 12px; padding: 0; }
.rel-link { color: var(--palette-primary, #0f6e56); }
.rel-h1 { margin: 0; font-size: 20px; font-weight: 500; }
.rel-h2 { margin: 0; font-size: 15px; font-weight: 500; }
.rel-h3 { margin: 0; font-size: 14px; font-weight: 500; }
.rel-sub { margin: 0; font-size: 12px; color: var(--text-secondary, #5f5e5a); }
.rel-tabs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-bottom: 0.5px solid var(--border-tertiary, #e2e0d9); padding-bottom: 10px; }
.rel-tab { padding: 6px 14px; border: 0.5px solid var(--border-secondary, #c9c7be); border-radius: 8px; background: var(--background-primary, #ffffff); font-size: 13px; cursor: pointer; color: var(--text-primary, #2c2c2a); }
.rel-tab-on { border-color: var(--palette-primary, #0f6e56); color: var(--palette-primary, #0f6e56); background: var(--palette-soft, #e1f5ee); }
.rel-spacer { flex: 1; }
.rel-count { font-size: 12px; color: var(--text-tertiary, #888780); }
.rel-msg { margin: 0; padding: 8px 12px; border-radius: 8px; font-size: 12px; color: var(--palette-primary, #0f6e56); background: var(--palette-soft, #e1f5ee); word-break: break-word; }
.rel-err { margin: 0; padding: 8px 12px; border-radius: 8px; font-size: 12px; color: var(--state-warn, #b3261e); background: var(--state-warn-soft, #fdeceb); word-break: break-word; }
.rel-panel { display: flex; flex-direction: column; gap: 12px; }
.rel-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rel-input { border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 6px; padding: 5px 8px; font-size: 12px; background: var(--background-primary, #ffffff); color: var(--text-primary, #2c2c2a); }
.rel-search { min-width: 180px; flex: 1; }
.rel-textarea { width: 100%; min-height: 52px; resize: vertical; line-height: 1.6; }
.rel-btn { padding: 6px 12px; border: 0.5px solid var(--border-secondary, #c9c7be); border-radius: 8px; background: var(--background-primary, #ffffff); font-size: 12px; cursor: pointer; color: var(--text-primary, #2c2c2a); }
.rel-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.rel-btn-primary { border-color: var(--palette-primary, #0f6e56); color: var(--palette-primary, #0f6e56); background: var(--palette-soft, #e1f5ee); }
.rel-btn-danger { color: var(--state-warn, #b3261e); }
.rel-btn-small { padding: 3px 10px; font-size: 11px; }
.rel-x { border: 0; background: transparent; color: var(--text-tertiary, #888780); cursor: pointer; font-size: 12px; }
.rel-hint { margin: 0; font-size: 11px; line-height: 1.7; color: var(--text-secondary, #5f5e5a); }
.rel-empty { margin: 0; padding: 24px 16px; text-align: center; font-size: 12px; line-height: 1.7; color: var(--text-tertiary, #888780); border: 0.5px dashed var(--border-tertiary, #e2e0d9); border-radius: 10px; }
.rel-note { margin: 0; font-size: 11px; line-height: 1.7; color: var(--text-tertiary, #888780); }

/* 通讯录：左列表 + 右详情 */
.rel-book { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 12px; }
.rel-list { display: flex; flex-direction: column; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 10px; overflow: hidden; }
.rel-listhead { display: grid; grid-template-columns: 1.2fr 0.9fr 0.9fr 1.3fr 0.8fr; gap: 6px; padding: 8px 10px; font-size: 11px; color: var(--text-tertiary, #888780); background: var(--background-secondary, #f7f8f6); }
.rel-row { display: grid; grid-template-columns: 1.2fr 0.9fr 0.9fr 1.3fr 0.8fr; gap: 6px; align-items: center; padding: 9px 10px; border: 0; border-top: 0.5px solid var(--border-tertiary, #e2e0d9); background: var(--background-primary, #ffffff); text-align: left; font-size: 12px; cursor: pointer; color: var(--text-primary, #2c2c2a); }
.rel-row:hover { background: var(--background-secondary, #f7f8f6); }
.rel-row-on { background: var(--palette-soft, #e1f5ee); }
.rel-ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rel-col-name { font-weight: 500; }
.rel-col-circle, .rel-col-tier, .rel-col-last { color: var(--text-secondary, #5f5e5a); font-size: 11px; }
.rel-temp { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 6px; }
.rel-temp-none { color: var(--text-tertiary, #888780); background: var(--background-secondary, #f7f8f6); }
.rel-temp-cool { color: var(--text-secondary, #5f5e5a); background: var(--background-secondary, #f1efe8); }
.rel-temp-warm { color: var(--palette-primary, #0f6e56); background: var(--palette-soft, #e1f5ee); }
.rel-temp-hot { color: var(--palette-primary, #0f6e56); background: #c8e8db; font-weight: 500; }
.rel-temp-big { font-size: 14px; }
.rel-detail { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 10px; background: var(--background-primary, #ffffff); }
.rel-panelhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rel-formgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.rel-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rel-field-wide { grid-column: 1 / -1; }
.rel-label { font-size: 11px; color: var(--text-secondary, #5f5e5a); }
.rel-label-key { color: var(--palette-primary, #0f6e56); font-weight: 500; }
.rel-req { font-style: normal; color: var(--state-warn, #b3261e); }
.rel-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.rel-subblock { display: flex; flex-direction: column; gap: 6px; border-top: 0.5px solid var(--border-tertiary, #e2e0d9); padding-top: 10px; }
.rel-breakdown { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; color: var(--text-secondary, #5f5e5a); }
.rel-breakdown-main { color: var(--text-primary, #2c2c2a); }
.rel-breakdown-calc, .rel-logcalc { color: var(--palette-primary, #0f6e56); }
.rel-breakdown-sum { flex: 1 1 100%; color: var(--text-tertiary, #888780); }

/* 记录面板 */
.rel-logpanel { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 0.5px solid var(--palette-primary, #0f6e56); border-radius: 10px; background: var(--palette-soft, #e1f5ee); }
.rel-formrow { display: flex; gap: 8px; flex-wrap: wrap; }
.rel-formrow .rel-field { flex: 1; min-width: 120px; }
.rel-checks { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 8px; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 8px; background: var(--background-primary, #ffffff); }
.rel-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }

/* 流水列表 */
.rel-loglist { display: flex; flex-direction: column; gap: 8px; }
.rel-logrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 10px; background: var(--background-primary, #ffffff); font-size: 12px; }
.rel-logdate { border: 0; background: transparent; padding: 0; color: var(--palette-primary, #0f6e56); cursor: pointer; font-size: 12px; text-decoration: underline dotted; }
.rel-logwho { font-weight: 500; }
.rel-logch { color: var(--text-secondary, #5f5e5a); }
.rel-logsum { flex: 1 1 100%; color: var(--text-primary, #2c2c2a); }
.rel-logextra { flex: 1 1 100%; color: var(--text-tertiary, #888780); }
.rel-logcalc { flex: 1 1 100%; }
.rel-rowbtn { border: 0; background: transparent; color: var(--text-tertiary, #888780); cursor: pointer; font-size: 11px; padding: 0; }

/* 分析四视角 */
.rel-formula { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 10px; background: var(--background-secondary, #f7f8f6); }
.rel-eq { margin: 0; font-size: 13px; font-weight: 500; color: var(--palette-primary, #0f6e56); word-break: break-word; }
.rel-views { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.rel-view { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 10px; background: var(--background-primary, #ffffff); }
.rel-viewhead { display: flex; align-items: center; gap: 8px; }
.rel-badge { font-size: 11px; color: var(--text-tertiary, #888780); }
.rel-actionline { margin: 0; font-size: 11px; color: var(--palette-primary, #0f6e56); }
.rel-viewrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 0; border-top: 0.5px solid var(--border-tertiary, #e2e0d9); font-size: 12px; }
.rel-vname { font-weight: 500; min-width: 72px; }
.rel-vtier, .rel-vdays { font-size: 11px; color: var(--text-secondary, #5f5e5a); }
.rel-vhint { flex: 1 1 140px; font-size: 11px; color: var(--text-tertiary, #888780); }
.rel-give { flex: 1 1 100%; color: var(--text-primary, #2c2c2a); }
.rel-over { color: var(--state-warn, #b3261e); }
.rel-dist { display: flex; flex-direction: column; gap: 4px; }
.rel-distrow { display: grid; grid-template-columns: 64px 1fr 74px; gap: 8px; align-items: center; font-size: 11px; }
.rel-distlabel { color: var(--text-secondary, #5f5e5a); }
.rel-distbar { display: block; height: 8px; border-radius: 4px; background: var(--background-secondary, #f1efe8); overflow: hidden; }
.rel-distfill { display: block; height: 100%; border-radius: 4px; background: var(--palette-primary, #0f6e56); }
.rel-distnum { text-align: right; color: var(--text-tertiary, #888780); }

@media (max-width: 880px) {
  .rel-book, .rel-views { grid-template-columns: minmax(0, 1fr); }
  .rel-formgrid { grid-template-columns: minmax(0, 1fr); }
}
</style>
