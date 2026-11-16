<script setup lang="ts">
// 「家庭亲子」的右栏（2026-11-16 扩）：登记信息全部退到这里，主栏只写正文与亲子时刻。
// 四张卡：家庭成员（可登记/编辑/归档式删除）/ 快到的纪念日 / 本周陪伴 / 最近足迹。
// 不做评分、不排名、不给「陪伴质量」下判断；时长是用户自己填的，这里只做加法。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { localDate } from '../../types';

const props = defineProps<{ tick: number }>();
const emit = defineEmits<{
  (e: 'changed'): void;
  (e: 'notify', text: string): void;
}>();

interface Opt { key?: string; value?: string; label: string }
interface MemberRow {
  id: string; name: string; role: string; roleLabel: string; ageText: string; daysSince: number | null;
  birthday: string; calendarType: string; birthYear: number; lunarMonth: number;
  lunarDay: number; lunarLeap: boolean; anniversaryOn: boolean;
  birthdayLabel: string; school: string; interests: string; notes: string;
}
interface MileRow { id: string; date: string; title: string; kindLabel: string; membersText: string; daysAgo: number }
interface Anniv { memberId: string; name: string; date: string; kind: string; label: string; daysUntil: number }
interface Board {
  today: string;
  week: { start: string; end: string };
  members: MemberRow[];
  milestones: MileRow[];
  anniversaries: Anniv[];
  weekStats: { days: number; moments: number; minutes: number; covered: number; members: number; untouched: string[] };
  streak: number;
  counts: { members: number; moments: number; milestones: number };
}
interface Meta {
  roles?: Opt[]; calendarTypes?: Opt[]; lunarMonths?: string[];
  lunarYears?: { min: number; max: number }; anniversaryDays?: number;
  limits?: { name?: number; school?: number };
}

const board = ref<Board | null>(null);
const loading = ref(true);
const meta = ref<Meta | null>(null);
const busy = ref(false);
const pendingDelete = ref('');

const FALLBACK_ROLES: Opt[] = [
  { key: 'child', label: '孩子' }, { key: 'partner', label: '伴侣' },
  { key: 'elder', label: '长辈' }, { key: 'self', label: '自己' }, { key: 'other', label: '其他' }
];
const FALLBACK_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];

interface MemberDraft {
  id: string; name: string; role: string; calendarType: string;
  birthday: string; birthYear: string; lunarMonth: string; lunarDay: string;
  lunarLeap: boolean; anniversaryOn: boolean; school: string; interests: string; notes: string;
}
function blankDraft(): MemberDraft {
  return {
    id: '', name: '', role: 'child', calendarType: 'solar', birthday: '',
    birthYear: '', lunarMonth: '', lunarDay: '', lunarLeap: false, anniversaryOn: false,
    school: '', interests: '', notes: ''
  };
}
const draft = ref<MemberDraft>(blankDraft());
const formOpen = ref(false);
const editing = computed(function () { return !!draft.value.id; });

const roles = computed(function () { return meta.value && meta.value.roles ? meta.value.roles : FALLBACK_ROLES; });
const calendarTypes = computed(function () {
  return meta.value && meta.value.calendarTypes ? meta.value.calendarTypes : [{ key: 'solar', label: '阳历' }, { key: 'lunar', label: '农历' }];
});
const lunarMonths = computed(function () { return meta.value && meta.value.lunarMonths ? meta.value.lunarMonths : FALLBACK_MONTHS; });
const lunarDays = Array.from({ length: 30 }, function (_, i) { return i + 1; });
const lunarMinYear = computed(function () { return meta.value && meta.value.lunarYears ? meta.value.lunarYears.min : 1900; });
const lunarMaxYear = computed(function () { return meta.value && meta.value.lunarYears ? meta.value.lunarYears.max : 2049; });
const nameMax = computed(function () { return meta.value && meta.value.limits && meta.value.limits.name ? meta.value.limits.name : 20; });

const week = computed(function () { return board.value ? board.value.weekStats : null; });
const recent = computed(function () { return board.value ? board.value.milestones.slice(0, 3) : []; });
const untouched = computed(function () { return week.value ? week.value.untouched : []; });
const annivs = computed(function () { return board.value && board.value.anniversaries ? board.value.anniversaries : []; });
const weekRange = computed(function () {
  const w = board.value && board.value.week;
  return w ? w.start.slice(5) + ' – ' + w.end.slice(5) : '';
});

function durationText(min: number): string {
  if (!min) return '0 分钟';
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
}
function daysText(n: number): string {
  if (n === 0) return '就是今天';
  return n === 1 ? '明天' : n + ' 天后';
}

async function loadMeta(): Promise<void> {
  try {
    meta.value = await callDomain<Meta | null>('family.meta', null);
  } catch (_) { /* 兜底选项够用 */ }
}

async function load(): Promise<void> {
  try {
    const b = await callDomain<Board | null>('family.board', null, localDate());
    board.value = b && b.counts ? b : null;
  } finally {
    loading.value = false;
  }
}

function editMember(m: MemberRow): void {
  formOpen.value = true;
  draft.value = {
    id: m.id, name: m.name || '', role: m.role || 'child',
    calendarType: m.calendarType === 'lunar' ? 'lunar' : 'solar',
    birthday: m.birthday || '', birthYear: m.birthYear ? String(m.birthYear) : '',
    lunarMonth: m.lunarMonth ? String(m.lunarMonth) : '', lunarDay: m.lunarDay ? String(m.lunarDay) : '',
    lunarLeap: !!m.lunarLeap, anniversaryOn: !!m.anniversaryOn,
    school: m.school || '', interests: m.interests || '', notes: m.notes || ''
  };
  pendingDelete.value = '';
}
function newMember(): void {
  formOpen.value = true;
  draft.value = blankDraft();
  pendingDelete.value = '';
}
function cancelEdit(): void {
  formOpen.value = false;
  draft.value = blankDraft();
  pendingDelete.value = '';
}

function patchOf(): Record<string, unknown> {
  const d = draft.value;
  return {
    name: d.name.trim(), role: d.role, calendarType: d.calendarType,
    birthday: d.calendarType === 'solar' ? d.birthday : '',
    birthYear: d.calendarType === 'lunar' ? Number(d.birthYear) : 0,
    lunarMonth: d.calendarType === 'lunar' ? Number(d.lunarMonth) : 0,
    lunarDay: d.calendarType === 'lunar' ? Number(d.lunarDay) : 0,
    lunarLeap: d.calendarType === 'lunar' ? d.lunarLeap : false,
    anniversaryOn: d.anniversaryOn,
    school: d.school.trim(), interests: d.interests.trim(), notes: d.notes.trim()
  };
}

async function saveMember(): Promise<void> {
  const d = draft.value;
  if (!d.name.trim()) { emit('notify', '称呼不能为空'); return; }
  if (d.calendarType === 'lunar' && (!d.birthYear || !d.lunarMonth || !d.lunarDay)) {
    emit('notify', '农历生日要填出生年、月份和日子');
    return;
  }
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await callDomain<{ error?: string } | null>(
      editing.value ? 'family.updateMember' : 'family.addMember',
      null, ...(editing.value ? [d.id, patchOf()] : [patchOf()])
    );
    if (res && res.error) { emit('notify', '没存成：' + res.error); return; }
    emit('notify', editing.value ? '已更新 · ' + d.name.trim() : '已登记 · ' + d.name.trim());
    formOpen.value = false;
    draft.value = blankDraft();
    await load();
    emit('changed');
  } catch (_) { emit('notify', '没存成，请重试'); }
  finally { busy.value = false; }
}

async function deleteMember(id: string): Promise<void> {
  if (pendingDelete.value !== id) { pendingDelete.value = id; return; }
  try {
    await callDomain('family.removeMember', null, id);
    emit('notify', '已删档案；历史亲子时刻一条不删');
    formOpen.value = false;
    draft.value = blankDraft();
    pendingDelete.value = '';
    await load();
    emit('changed');
  } catch (_) { emit('notify', '删除失败，请重试'); }
}

onMounted(function () { void loadMeta(); void load(); });
watch(function () { return props.tick; }, function () { void load(); });
</script>

<template>
  <section class="ctx-card fam-ctx" aria-label="家庭成员">
    <h2 class="ctx-title">家庭成员<span class="ctx-tag">可写</span></h2>
    <p v-if="loading" class="ctx-muted">读取中…</p>
    <ul v-else-if="board && board.members.length" class="ctx-list">
      <li v-for="m in board.members" :key="m.id" class="ctx-item fam-member">
        <span class="ctx-item-main">
          {{ m.name }} <span class="ctx-muted">· {{ m.roleLabel }} · {{ m.ageText || '未填生日' }}</span>
          <span v-if="m.birthdayLabel" class="ctx-muted"> · {{ m.birthdayLabel }}</span>
          <span v-if="m.anniversaryOn" class="ctx-tag">纪念日</span>
        </span>
        <span class="ctx-item-side fam-member-ops">
          <button class="fam-mini" @click="editMember(m)">改</button>
          <button class="fam-mini fam-mini-danger" @click="deleteMember(m.id)">{{ pendingDelete === m.id ? '再点确认' : '删' }}</button>
        </span>
      </li>
    </ul>
    <p v-else class="ctx-muted">还没有家庭成员，先登记一位。</p>
    <button class="fam-mini fam-add" @click="newMember">+ 登记成员</button>

    <div v-if="formOpen" class="fam-form">
      <h3 class="ctx-title">{{ editing ? '编辑 · ' + (draft.name || '未命名') : '登记成员' }}</h3>
      <div class="fam-grid">
        <label class="fam-field"><span>称呼</span><input v-model="draft.name" class="fam-input" :maxlength="nameMax" placeholder="家里怎么叫" /></label>
        <label class="fam-field"><span>关系</span>
          <select v-model="draft.role" class="fam-input"><option v-for="o in roles" :key="o.key || o.value" :value="o.key || o.value">{{ o.label }}</option></select>
        </label>
      </div>
      <div class="fam-grid">
        <label class="fam-field"><span>生日历法</span>
          <select v-model="draft.calendarType" class="fam-input"><option v-for="o in calendarTypes" :key="o.key || o.value" :value="o.key || o.value">{{ o.label }}</option></select>
        </label>
      </div>
      <div v-if="draft.calendarType === 'solar'" class="fam-grid">
        <label class="fam-field fam-wide"><span>阳历生日</span><input v-model="draft.birthday" class="fam-input" type="date" /></label>
      </div>
      <template v-else>
        <div class="fam-grid">
          <label class="fam-field"><span>出生年</span>
            <input v-model="draft.birthYear" class="fam-input" type="number" :min="lunarMinYear" :max="lunarMaxYear" placeholder="例：2018" />
          </label>
          <label class="fam-field"><span>农历月</span>
            <select v-model="draft.lunarMonth" class="fam-input"><option value="">选月份</option>
              <option v-for="(mn, i) in lunarMonths" :key="i" :value="i + 1">{{ mn }}</option>
            </select>
          </label>
          <label class="fam-field"><span>农历日</span>
            <select v-model="draft.lunarDay" class="fam-input"><option value="">选日子</option>
              <option v-for="d in lunarDays" :key="d" :value="d">{{ d }} 日</option>
            </select>
          </label>
        </div>
        <label class="fam-check"><input v-model="draft.lunarLeap" type="checkbox" /> 闰月出生</label>
        <p class="ctx-muted">换算表支持 {{ lunarMinYear }}–{{ lunarMaxYear }} 年；查不到就不提醒，不猜日子。</p>
      </template>
      <label class="fam-check"><input v-model="draft.anniversaryOn" type="checkbox" /> 设为纪念日提醒</label>
      <div class="fam-grid">
        <label class="fam-field"><span>学校</span><input v-model="draft.school" class="fam-input" /></label>
        <label class="fam-field"><span>兴趣</span><input v-model="draft.interests" class="fam-input" /></label>
      </div>
      <label class="fam-field"><span>注意事项</span><textarea v-model="draft.notes" class="fam-input fam-area" rows="2"></textarea></label>
      <div class="fam-actions">
        <button class="fam-save" :disabled="busy" @click="saveMember">{{ editing ? '保存' : '登记' }}</button>
        <button class="fam-mini" @click="cancelEdit">取消</button>
      </div>
    </div>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">快到的纪念日</h2>
    <ul v-if="annivs.length" class="ctx-list">
      <li v-for="a in annivs" :key="a.memberId" class="ctx-item">
        <span class="ctx-item-main">{{ a.name }} · {{ a.label }}</span>
        <span class="ctx-item-side">{{ daysText(a.daysUntil) }}</span>
      </li>
    </ul>
    <p v-else class="ctx-muted">近一个月没有设了提醒的生日。登记时在「设为纪念日提醒」上打勾就会出现在这里。</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">本周陪伴<span class="ctx-tag">{{ weekRange }}</span></h2>
    <div v-if="week" class="ctx-grid">
      <div class="ctx-kv"><span class="ctx-kv-label">亲子时刻</span><span class="ctx-kv-val">{{ week.moments }}<span class="ctx-kv-unit">条</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">陪伴时长</span><span class="ctx-kv-val">{{ durationText(week.minutes) }}</span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">记到的天</span><span class="ctx-kv-val">{{ week.days }}<span class="ctx-kv-unit">天</span></span></div>
      <div class="ctx-kv"><span class="ctx-kv-label">覆盖成员</span><span class="ctx-kv-val">{{ week.covered }} / {{ week.members }}</span></div>
    </div>
    <p v-if="loading" class="ctx-muted">读取中…</p>
    <p v-else class="ctx-muted">时长是你自己填的，不是自动计时{{ board && board.streak > 1 ? ' · 连续记录 ' + board.streak + ' 天' : '' }}。</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">这周还没记到</h2>
    <p v-if="!untouched.length" class="ctx-muted">{{ week && week.members ? '每个人都至少有一条记录。' : '还没有家庭成员，先在上面登记一位。' }}</p>
    <div v-else class="ctx-chips"><span v-for="n in untouched" :key="n" class="chip">{{ n }}</span></div>
    <p class="ctx-muted">只列事实：这周没有记录，不等于没有陪伴。</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">最近足迹<span class="ctx-tag">{{ board ? board.counts.milestones : 0 }} 条</span></h2>
    <div class="ctx-list">
      <div v-for="g in recent" :key="g.id" class="ctx-item">
        <span class="ctx-item-main">{{ g.title }}<span class="ctx-muted"> · {{ g.date }} · {{ g.kindLabel }}</span></span>
        <span class="ctx-item-side">{{ g.daysAgo === 0 ? '今天' : g.daysAgo + ' 天前' }}</span>
      </div>
    </div>
    <p v-if="!recent.length && !loading" class="ctx-muted">还没有足迹。第一次自己吃饭、第一次骑车，都值得留一条。</p>
  </section>
</template>

<style scoped>
.fam-member { align-items: flex-start; }
.fam-member-ops { display: inline-flex; gap: 4px; }
.fam-mini { border: 1px solid var(--palette-line, #e7e0d3); border-radius: 6px; padding: 2px 7px; background: transparent; color: var(--palette-primary, #3f5c4a); font-size: 11px; cursor: pointer; }
.fam-mini-danger { color: #a33; }
.fam-add { margin-top: 8px; }
.fam-form { margin-top: 10px; border-top: 1px dashed var(--palette-line, #e7e0d3); padding-top: 8px; }
.fam-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
.fam-wide { grid-column: 1 / -1; }
.fam-field { display: block; margin: 5px 0; font-size: 11px; color: var(--palette-muted, #8d8a80); }
.fam-input { width: 100%; box-sizing: border-box; border: 1px solid var(--palette-line, #e7e0d3); border-radius: 6px; padding: 5px 7px; font-size: 12px; background: var(--palette-card, #fffdf9); color: var(--palette-text, #3a3a34); }
.fam-area { resize: vertical; }
.fam-check { display: block; margin: 6px 0; font-size: 11px; color: var(--palette-text, #3a3a34); }
.fam-actions { display: flex; gap: 6px; margin: 8px 0; }
.fam-save { border: 0; border-radius: 6px; padding: 5px 12px; background: var(--palette-primary, #3f5c4a); color: #fff; font-size: 12px; cursor: pointer; }
.fam-save:disabled { opacity: .5; }
</style>
