<script setup lang="ts">
// 九格手记 · 家庭亲子（九格第 6 格的主栏视图，2026-11-16 由「情绪觉察」重构）。
// 三块各回答一个问题：成员（在陪谁）/ 今天（陪了什么）/ 足迹（什么时候第一次做到）。
// 诚实边界：时长是自己填的，不是自动计时；本周覆盖只数「有记录的人」；
// 不做总分、不做健康度评分、不评价你是不是好父母；删成员不删历史时刻。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../composables/useDomain';
import { localDate, type DiaryRecord } from '../types';
import CellRecordEditor from '../components/CellRecordEditor.vue';

// 2026-11-16：登记信息移到右栏，主栏加一段正文记录窗口（写 cells.emotion，数据键不动）。
defineProps<{ record?: DiaryRecord }>();
const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'notify', msg: string): void;
  (e: 'changed'): void;
  (e: 'save', record: DiaryRecord): void;
}>();

interface MemberRow {
  id: string; name: string; role: string; roleLabel: string;
  birthday: string; ageText: string; school: string; interests: string; notes: string;
  moments: number; minutes: number; lastDate: string; daysSince: number | null;
}
interface MomentRow {
  id: string; date: string; memberIds: string[]; membersText: string;
  kind: string; kindLabel: string; minutes: number;
  text: string; feeling: string; createdAt: number;
}
interface MileRow {
  id: string; date: string; memberIds: string[]; membersText: string;
  kind: string; kindLabel: string; title: string; detail: string; daysAgo: number;
}
interface FamilyBoard {
  today: string;
  week: { start: string; end: string };
  members: MemberRow[];
  moments: MomentRow[];
  todayMoments: MomentRow[];
  milestones: MileRow[];
  weekStats: { days: number; moments: number; minutes: number; covered: number; members: number; untouched: string[] };
  streak: number;
  counts: { members: number; moments: number; milestones: number };
}
interface Opt { key: string; label: string }
interface FamilyMeta {
  roles: Opt[]; momentKinds: Opt[]; milestoneKinds: Opt[];
  limits: { members: number; moments: number; milestones: number; name: number; text: number; title: number; detail: number };
}

type TabKey = 'today' | 'trail';
const tab = ref<TabKey>('today');
const board = ref<FamilyBoard | null>(null);
const meta = ref<FamilyMeta | null>(null);
const busy = ref(false);
// 时刻与足迹的删除仍要二次确认（右栏成员删除有自己的一份本地态）
const confirmKey = ref('');
const today = localDate();

const FALLBACK_ROLES: Opt[] = [
  { key: 'child', label: '孩子' }, { key: 'partner', label: '伴侣' },
  { key: 'elder', label: '长辈' }, { key: 'self', label: '自己' }, { key: 'other', label: '其他' }
];
const FALLBACK_MOMENT_KINDS: Opt[] = [
  { key: 'company', label: '陪伴' }, { key: 'talk', label: '聊天' },
  { key: 'play', label: '玩耍' }, { key: 'study', label: '共学' },
  { key: 'sport', label: '运动' }, { key: 'bedtime', label: '睡前' },
  { key: 'outing', label: '外出' }
];
const FALLBACK_MILE_KINDS: Opt[] = [
  { key: 'first', label: '第一次' }, { key: 'body', label: '身体' },
  { key: 'skill', label: '本领' }, { key: 'work', label: '作品' },
  { key: 'school', label: '学校' }, { key: 'other', label: '其他' }
];
const roles = computed(() => (meta.value && meta.value.roles.length ? meta.value.roles : FALLBACK_ROLES));
const momentKinds = computed(() => (meta.value && meta.value.momentKinds.length ? meta.value.momentKinds : FALLBACK_MOMENT_KINDS));
const mileKinds = computed(() => (meta.value && meta.value.milestoneKinds.length ? meta.value.milestoneKinds : FALLBACK_MILE_KINDS));
const members = computed(() => (board.value ? board.value.members : []));
const moments = computed(() => (board.value ? board.value.moments : []));
const milestones = computed(() => (board.value ? board.value.milestones : []));
const week = computed(() => (board.value ? board.value.weekStats : { days: 0, moments: 0, minutes: 0, covered: 0, members: 0, untouched: [] as string[] }));

function notify(t: string): void { emit('notify', t); }
function labelOf(list: Opt[], key: string): string {
  const hit = list.filter(function (x) { return x.key === key; })[0];
  return hit ? hit.label : key;
}
function durationText(min: number): string {
  if (!min) return '';
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
}
function daysText(n: number | null): string {
  if (n === null) return '还没记过';
  if (n <= 0) return '今天';
  return n + ' 天前';
}

async function load(): Promise<void> {
  const b = await callDomain<FamilyBoard | null>('family.board', null, today);
  board.value = b && b.counts ? b : null;
}

onMounted(async function () {
  const m = await callDomain<FamilyMeta | null>('family.meta', null);
  meta.value = m && m.roles ? m : null;
  await load();
  // 记住上次的 tab：与自由记录 prefs 同一套做法，不写盘就落到「今天」
  const prefs = await callDomain<{ lastTab?: string } | null>('family.prefs', null, {});
  if (prefs && prefs.lastTab === 'trail') tab.value = prefs.lastTab;
});

function switchTab(k: TabKey): void {
  tab.value = k;
  if (board.value) void callDomain('family.prefs', null, { lastTab: k });
}

/* ---------------- ① 亲子时刻 ---------------- */
const mDate = ref(today);
const mMembers = ref<string[]>([]);
const mKind = ref('company');
const mMinutes = ref(30);
const mMemo = ref('');
const mFeeling = ref('');

function toggleMember(id: string, list: string[]): string[] {
  const i = list.indexOf(id);
  if (i >= 0) { const next = list.slice(); next.splice(i, 1); return next; }
  if (list.length >= 6) return list;
  return list.concat([id]);
}
function pickMomentMember(id: string): void { mMembers.value = toggleMember(id, mMembers.value); }

async function addMoment(): Promise<void> {
  const text = mMemo.value.trim();
  if (!text || busy.value) return;
  busy.value = true;
  try {
    const res = await callDomain<{ error?: string } | null>('family.addMoment', null, {
      date: mDate.value || today,
      memberIds: mMembers.value,
      kind: mKind.value,
      minutes: Number(mMinutes.value) || 0,
      text: text,
      feeling: mFeeling.value.trim()
    });
    if (res && res.error) { notify('没记上：' + res.error); return; }
    mMemo.value = '';
    mFeeling.value = '';
    await load();
    emit('changed');
    notify('已记下一条亲子时刻');
  } finally {
    busy.value = false;
  }
}

async function removeMoment(id: string): Promise<void> {
  await callDomain('family.removeMoment', null, id);
  confirmKey.value = '';
  await load();
  emit('changed');
  notify('这条时刻已删除');
}

/* ---------------- ③ 成长足迹 ---------------- */
const gTitle = ref('');
const gDate = ref(today);
const gMembers = ref<string[]>([]);
const gKind = ref('first');
const gDetail = ref('');

function pickMileMember(id: string): void { gMembers.value = toggleMember(id, gMembers.value); }

async function addMilestone(): Promise<void> {
  const title = gTitle.value.trim();
  if (!title || busy.value) return;
  busy.value = true;
  try {
    const res = await callDomain<{ error?: string } | null>('family.addMilestone', null, {
      date: gDate.value || today,
      memberIds: gMembers.value,
      kind: gKind.value,
      title: title,
      detail: gDetail.value.trim()
    });
    if (res && res.error) { notify('没记上：' + res.error); return; }
    gTitle.value = '';
    gDetail.value = '';
    await load();
    emit('changed');
    notify('已收进成长足迹');
  } finally {
    busy.value = false;
  }
}

async function removeMilestone(id: string): Promise<void> {
  await callDomain('family.removeMilestone', null, id);
  confirmKey.value = '';
  await load();
  emit('changed');
  notify('这条足迹已删除');
}
</script>

<template>
  <section class="fam-wrap">
    <header class="fam-head">
      <button class="fam-back" @click="emit('back')">← 回到今天</button>
      <div class="fam-title">
        <h2>家庭亲子</h2>
        <p>陪了谁、做了什么、什么时候第一次做到。时长是自己填的，不评分、不排名。</p>
      </div>
      <div class="fam-kpi">
        <span class="fam-kpi-n">{{ week.moments }}</span>
        <span class="fam-kpi-l">本周时刻</span>
        <span class="fam-kpi-n">{{ durationText(week.minutes) || '0 分钟' }}</span>
        <span class="fam-kpi-l">本周陪伴</span>
      </div>
    </header>

    <!-- 主栏记录窗口：正文写 cells.emotion（第 6 格数据键不变，历史正文原样带出） -->
    <CellRecordEditor
      v-if="record"
      :record="record"
      cell-key="emotion"
      label="家庭亲子"
      placeholder="今天陪了谁、孩子说了什么，写一句…"
      prompt-key="emotion"
      hint="成员登记与生日在右栏；这里只写今天发生的事。"
      @save="emit('save', $event)"
      @notify="emit('notify', $event)"
    />

    <nav class="fam-tabs" role="tablist" aria-label="家庭亲子两块内容">
      <button class="fam-tab" :class="{ 'fam-on': tab === 'today' }" role="tab"
        :aria-selected="tab === 'today'" @click="switchTab('today')">今天 · 亲子时刻 {{ board ? board.todayMoments.length : 0 }}</button>
      <button class="fam-tab" :class="{ 'fam-on': tab === 'trail' }" role="tab"
        :aria-selected="tab === 'trail'" @click="switchTab('trail')">成长足迹 {{ milestones.length }}</button>
    </nav>

    <!-- ① 亲子时刻 -->
    <section v-if="tab === 'today'" class="fam-pane">
      <div class="fam-card">
        <h3>记一条 · 今天发生了什么</h3>
        <p v-if="!members.length" class="fam-hint">
          还没有家庭成员。先在右栏登记一位（孩子的昵称、生日就够），记的时候才选得中人。
        </p>
        <div class="fam-form">
          <label class="fam-field fam-wide">
            <span>谁</span>
            <div class="fam-chips">
              <button v-for="m in members" :key="m.id" class="fam-chip"
                :class="{ 'fam-chip-on': mMembers.indexOf(m.id) >= 0 }"
                :aria-pressed="mMembers.indexOf(m.id) >= 0"
                @click="pickMomentMember(m.id)">{{ m.name }}</button>
              <span v-if="!members.length" class="fam-muted">先在右栏登记成员</span>
            </div>
          </label>
          <label class="fam-field">
            <span>类型</span>
            <select v-model="mKind" class="fam-input">
              <option v-for="k in momentKinds" :key="k.key" :value="k.key">{{ k.label }}</option>
            </select>
          </label>
          <label class="fam-field">
            <span>大概多久（分钟）</span>
            <input v-model.number="mMinutes" class="fam-input" type="number" min="0" max="1440" step="5" />
          </label>
          <label class="fam-field">
            <span>哪天</span>
            <input v-model="mDate" class="fam-input" type="date" :max="today" />
          </label>
          <label class="fam-field fam-wide">
            <span>一句话</span>
            <textarea v-model="mMemo" class="fam-input fam-area" rows="3" maxlength="500"
              placeholder="孩子说了什么、你们一起做了什么。写具体的事，不必写感想。"></textarea>
          </label>
          <label class="fam-field fam-wide">
            <span>留在心里的一句（可不填）</span>
            <input v-model="mFeeling" class="fam-input" type="text" maxlength="60" placeholder="比如：他第一次主动说谢谢" />
          </label>
        </div>
        <div class="fam-actions">
          <button class="fam-primary" :disabled="busy || !mMemo.trim()" @click="addMoment">记下这条</button>
          <span class="fam-muted">记完立刻落本机，不进日记正文</span>
        </div>
      </div>

      <div class="fam-card">
        <h3>最近的时刻</h3>
        <div v-for="m in moments.slice(0, 20)" :key="m.id" class="fam-row">
          <div class="fam-row-main">
            <div class="fam-row-meta">
              <span class="fam-tag">{{ m.kindLabel }}</span>
              <span class="fam-mono">{{ m.date }}</span>
              <span v-if="m.membersText">{{ m.membersText }}</span>
              <span v-if="m.minutes">{{ durationText(m.minutes) }}</span>
            </div>
            <p class="fam-row-text">{{ m.text }}</p>
            <p v-if="m.feeling" class="fam-row-feel">「{{ m.feeling }}」</p>
          </div>
          <button v-if="confirmKey !== 'm' + m.id" class="fam-del" @click="confirmKey = 'm' + m.id">删除</button>
          <template v-else>
            <button class="fam-del fam-del-on" @click="removeMoment(m.id)">确认删除</button>
            <button class="fam-del" @click="confirmKey = ''">取消</button>
          </template>
        </div>
        <p v-if="!moments.length" class="fam-hint">还没有记录。今天陪了谁、做了什么，写一句就有一条了。</p>
      </div>
    </section>

    <!-- ③ 成长足迹 -->
    <section v-else class="fam-pane">
      <div class="fam-card">
        <h3>记一条 · 第一次做到什么</h3>
        <div class="fam-form">
          <label class="fam-field fam-wide">
            <span>是什么</span>
            <input v-model="gTitle" class="fam-input" type="text" maxlength="40" placeholder="比如：第一次自己穿鞋" />
          </label>
          <label class="fam-field">
            <span>谁</span>
            <div class="fam-chips">
              <button v-for="m in members" :key="m.id" class="fam-chip"
                :class="{ 'fam-chip-on': gMembers.indexOf(m.id) >= 0 }"
                :aria-pressed="gMembers.indexOf(m.id) >= 0"
                @click="pickMileMember(m.id)">{{ m.name }}</button>
              <span v-if="!members.length" class="fam-muted">先在右栏登记成员</span>
            </div>
          </label>
          <label class="fam-field">
            <span>类别</span>
            <select v-model="gKind" class="fam-input">
              <option v-for="k in mileKinds" :key="k.key" :value="k.key">{{ k.label }}</option>
            </select>
          </label>
          <label class="fam-field">
            <span>哪天</span>
            <input v-model="gDate" class="fam-input" type="date" :max="today" />
          </label>
          <label class="fam-field fam-wide">
            <span>多说一句（可不填）</span>
            <textarea v-model="gDetail" class="fam-input fam-area" rows="2" maxlength="300"
              placeholder="当时的场面、他的表情、你怎么想的。"></textarea>
          </label>
        </div>
        <div class="fam-actions">
          <button class="fam-primary" :disabled="busy || !gTitle.trim()" @click="addMilestone">收进足迹</button>
        </div>
      </div>

      <div class="fam-card">
        <h3>成长足迹</h3>
        <div v-for="g in milestones" :key="g.id" class="fam-mile">
          <span class="fam-mile-dot" aria-hidden="true"></span>
          <div class="fam-row-main">
            <div class="fam-row-meta">
              <span class="fam-tag">{{ g.kindLabel }}</span>
              <span class="fam-mono">{{ g.date }}</span>
              <span v-if="g.membersText">{{ g.membersText }}</span>
              <span class="fam-muted">{{ g.daysAgo === 0 ? '今天' : g.daysAgo + ' 天前' }}</span>
            </div>
            <p class="fam-mile-title">{{ g.title }}</p>
            <p v-if="g.detail" class="fam-row-text">{{ g.detail }}</p>
          </div>
          <button v-if="confirmKey !== 'g' + g.id" class="fam-del" @click="confirmKey = 'g' + g.id">删除</button>
          <template v-else>
            <button class="fam-del fam-del-on" @click="removeMilestone(g.id)">确认删除</button>
            <button class="fam-del" @click="confirmKey = ''">取消</button>
          </template>
        </div>
        <p v-if="!milestones.length" class="fam-hint">还没有足迹。第一次自己吃饭、第一次骑车、第一次考满分，都值得留一条。</p>
      </div>
    </section>
  </section>
</template>

<style scoped>
.fam-wrap { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.fam-head { display: flex; align-items: flex-start; gap: var(--space-2); flex-wrap: wrap; }
.fam-back {
  padding: 3px 10px; font-size: var(--text-xs); white-space: nowrap;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-panel); color: var(--surface-muted);
}
.fam-back:hover { color: var(--palette-primary); border-color: var(--palette-border); }
.fam-title { flex: 1 1 220px; min-width: 0; }
.fam-title h2 { margin: 0; font-size: var(--text-h2); font-weight: 600; }
.fam-title p { margin: 3px 0 0; font-size: var(--text-sm); color: var(--surface-muted); line-height: 1.6; }
.fam-kpi { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.fam-kpi-n { font-size: var(--text-h3); font-weight: 600; color: var(--palette-primary); font-variant-numeric: tabular-nums; }
.fam-kpi-l { font-size: var(--text-xs); color: var(--surface-muted); margin-right: 8px; }
.fam-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--surface-border); }
.fam-tab {
  padding: 8px 12px; font-size: var(--text-body); border: 0; border-bottom: 2px solid transparent;
  background: transparent; color: var(--surface-muted); cursor: pointer; margin-bottom: -1px;
}
.fam-tab.fam-on { color: var(--palette-primary); font-weight: 600; border-bottom-color: var(--palette-primary); }
.fam-pane { display: flex; flex-direction: column; gap: var(--space-2); }
.fam-card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.fam-card h3 { margin: 0 0 10px; font-size: var(--text-body); font-weight: 600; }
.fam-hint { margin: 0; font-size: var(--text-sm); color: var(--surface-muted); line-height: 1.7; }
.fam-muted { font-size: var(--text-xs); color: var(--surface-muted); }
.fam-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.fam-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; font-size: var(--text-xs); color: var(--surface-muted); }
.fam-wide { grid-column: 1 / -1; }
.fam-input {
  width: 100%; padding: 5px 8px; font-family: inherit; font-size: var(--text-sm);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); color: var(--surface-text); outline: none;
}
.fam-input:focus { border-color: var(--palette-border); }
.fam-area { resize: vertical; line-height: 1.7; }
.fam-chips { display: flex; gap: 4px; flex-wrap: wrap; padding: 2px 0; }
.fam-chip {
  padding: 2px 10px; font-size: var(--text-sm); border-radius: 999px;
  border: 0.5px solid var(--surface-border); background: var(--surface-raised);
  color: var(--surface-text); cursor: pointer; white-space: nowrap;
}
.fam-chip-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.fam-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.fam-primary {
  padding: 6px 16px; font-size: var(--text-sm); border-radius: var(--radius-md);
  border: 0.5px solid var(--palette-primary); background: var(--palette-primary); color: var(--palette-on);
}
.fam-primary:disabled { opacity: .45; cursor: default; }
.fam-ghost {
  padding: 6px 12px; font-size: var(--text-sm); border-radius: var(--radius-md);
  border: 0.5px solid var(--surface-border); background: transparent; color: var(--surface-muted);
}
.fam-row { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; border-top: 0.5px solid var(--surface-border); }
.fam-row:first-of-type { border-top: 0; }
.fam-row-main { flex: 1; min-width: 0; }
.fam-row-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--text-xs); color: var(--surface-muted); }
.fam-mono { font-variant-numeric: tabular-nums; }
.fam-name { font-size: var(--text-body); color: var(--surface-text); }
.fam-row-text { margin: 4px 0 0; font-size: var(--text-sm); line-height: 1.7; white-space: pre-wrap; }
.fam-row-feel { margin: 3px 0 0; font-size: var(--text-sm); color: var(--palette-primary); }
.fam-tag {
  padding: 0 6px; border-radius: 999px; font-size: var(--text-xs);
  color: var(--palette-primary); background: var(--palette-soft); border: 0.5px solid var(--palette-border);
}
.fam-del {
  flex: none; padding: 2px 8px; font-size: var(--text-xs); white-space: nowrap;
  border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: transparent; color: var(--surface-muted); cursor: pointer;
}
.fam-del:hover { color: var(--palette-primary); border-color: var(--palette-border); }
.fam-del-on { color: var(--state-warn); border-color: var(--state-warn); }
.fam-mile { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 8px 0 8px 16px; border-top: 0.5px solid var(--surface-border); }
.fam-mile:first-of-type { border-top: 0; }
.fam-mile-dot {
  position: absolute; left: 3px; top: 16px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--palette-primary);
}
.fam-mile-title { margin: 4px 0 0; font-size: var(--text-body); font-weight: 500; }
@media (max-width: 1180px) {
  .fam-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
