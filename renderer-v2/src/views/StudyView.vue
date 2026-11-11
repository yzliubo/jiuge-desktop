<script setup lang="ts">
// 学习格主功能：学习成长工作台。
//
// 三种学习活动的时间尺度不同，所以是三个 tab，不是一条列表加类型标签：
//   · 考试考证：有截止日、多科目、一个结果 → 倒计时 + 科目加权进度 + 成绩
//   · 技能学习：没有截止日，有等级与里程碑 → 里程碑达成率 + 累计/本周练习时长
//   · 主题阅读：一批书围绕一个主题 → 书单状态 + 页数推进 + 摘录
// 数据在 md_growth 单键（主进程仓储），由 src/growth/board.js 计算；点一行 → 右栏改详情。
// 今日一句仍写当天日记的 studyLog（与九格同源，导出与检索天然覆盖）。
import { computed, onMounted, ref, watch } from 'vue';
import { asArray, callDomain } from '../composables/useDomain';
import { localDate, type DiaryRecord } from '../types';

const props = defineProps<{ record: DiaryRecord; selected?: string; tick?: number }>();
const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
  (e: 'select-item', id: string): void;
  (e: 'changed'): void;
}>();

interface Subject { id: string; title: string; unit: string; total: number; done: number; pct: number; progressText: string }
interface ExamRow {
  id: string; title: string; org: string; examDate: string; enrollDate: string;
  status: string; score: number; passLine: number; note: string;
  subjects: Subject[]; pct: number; subjectCount: number; subjectDone: number;
  daysLeft: number; stage: string; stageLabel: string; countdown: string; resultText: string;
  enrollMissed: boolean; soon: boolean;
}
interface Milestone { id: string; title: string; done: boolean; doneAt: number; doneText: string }
interface Practice { id: string; date: string; minutes: number; note?: string }
interface SkillRow {
  id: string; title: string; level: number; targetLevel: number; note: string;
  milestones: Milestone[]; practices: Practice[];
  levelText: string; levelLabel: string; targetLabel: string;
  milestoneDone: number; milestoneTotal: number; milestonePct: number;
  minutes: number; hoursText: string; weekMinutes: number; weekText: string;
  lastPractice: string; nextTitle: string; ready: boolean;
}
interface Quote { id: string; text: string; page: number }
interface BookRow {
  id: string; title: string; author: string; total: number; done: number; unit: string;
  status: string; rating: number; pct: number; progressText: string; statusLabel: string;
  stars: string; quoteCount: number; quotes: Quote[];
}
interface ThemeRow {
  id: string; title: string; note: string; books: BookRow[];
  bookTotal: number; bookDone: number; readingCount: number; pct: number;
  quoteTotal: number; currentTitle: string; bookText: string;
}
interface Stats {
  examTotal: number; examOpen: number; examSoon: number; examPast: number; examPassed: number;
  examEnrollMissed: number; skillTotal: number; skillMinutes: number; skillHours: number;
  skillWeek: number; skillReady: number; themeTotal: number; bookTotal: number;
  bookDone: number; quoteTotal: number; total: number;
}
interface Alert { kind: string; id: string; title: string; level: string; text: string }
interface Board {
  today: string; exams: ExamRow[]; skills: SkillRow[]; themes: ThemeRow[];
  stats: Stats; alerts: Alert[]; insight: string; note: string;
}

type TabKey = 'exam' | 'skill' | 'theme';
const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'exam', label: '考试考证', hint: '有截止日：倒计时 + 科目进度 + 成绩' },
  { key: 'skill', label: '技能学习', hint: '没有截止日：里程碑 + 练习时长 + 等级' },
  { key: 'theme', label: '主题阅读', hint: '一批书：书单状态 + 页数 + 摘录' }
];

const board = ref<Board | null>(null);
const active = ref<TabKey>('exam');
const msg = ref('');
let msgTimer: ReturnType<typeof setTimeout> | null = null;

const newExamTitle = ref('');
const newExamDate = ref('');
const newSkillTitle = ref('');
const newThemeTitle = ref('');
const dayNote = ref('');
const importing = ref(false);

function say(t: string): void {
  msg.value = t;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { msg.value = ''; }, 2800);
}

const stats = computed<Stats>(() => board.value ? board.value.stats : {
  examTotal: 0, examOpen: 0, examSoon: 0, examPast: 0, examPassed: 0, examEnrollMissed: 0,
  skillTotal: 0, skillMinutes: 0, skillHours: 0, skillWeek: 0, skillReady: 0,
  themeTotal: 0, bookTotal: 0, bookDone: 0, quoteTotal: 0, total: 0
});
const exams = computed(() => (board.value ? board.value.exams : []));
const skills = computed(() => (board.value ? board.value.skills : []));
const themes = computed(() => (board.value ? board.value.themes : []));
const alerts = computed(() => (board.value ? board.value.alerts : []));

const tabCount = computed(() => ({
  exam: exams.value.length, skill: skills.value.length, theme: themes.value.length
}));

const currentHint = computed(() => {
  const hit = TABS.filter(function (t) { return t.key === active.value; })[0];
  return hit ? hit.hint : '';
});

// 统计胶囊：三个 tab 各给三个数，不共用一套——「条目数」对三种活动的含义不同
const chips = computed(() => {
  const s = stats.value;
  if (active.value === 'exam') {
    return [
      { label: '在考', value: String(s.examOpen) },
      { label: '7 天内', value: String(s.examSoon), warn: s.examSoon > 0 },
      { label: '已通过', value: String(s.examPassed) }
    ];
  }
  if (active.value === 'skill') {
    return [
      { label: '在练', value: String(s.skillTotal) },
      { label: '本周', value: s.skillWeek >= 60 ? (s.skillWeek / 60).toFixed(1) + ' 小时' : s.skillWeek + ' 分钟' },
      { label: '可升级', value: String(s.skillReady), warn: s.skillReady > 0 }
    ];
  }
  return [
    { label: '主题', value: String(s.themeTotal) },
    { label: '读完', value: s.bookDone + ' / ' + s.bookTotal },
    { label: '摘录', value: String(s.quoteTotal) }
  ];
});

let selfBump = 0;

async function load(): Promise<void> {
  board.value = await callDomain<Board | null>('growth.board', null, localDate());
  const log = props.record.studyLog as { note?: string } | undefined;
  dayNote.value = (log && log.note) || '';
}

async function refresh(): Promise<void> {
  await load();
  selfBump += 1;
  emit('changed');
}

watch(() => props.tick, function () {
  if (selfBump > 0) { selfBump -= 1; return; }
  void load();
});

function pick(id: string): void {
  emit('select-item', props.selected === id ? '' : id);
}

// --- 新建 ---
async function addExam(): Promise<void> {
  const title = newExamTitle.value.trim();
  if (!title) return;
  await callDomain('growth.addExam', null, { title: title, examDate: newExamDate.value });
  newExamTitle.value = '';
  newExamDate.value = '';
  await refresh();
  say('已加一场考试，右栏补科目与报名截止');
}

async function addSkill(): Promise<void> {
  const title = newSkillTitle.value.trim();
  if (!title) return;
  await callDomain('growth.addSkill', null, { title: title });
  newSkillTitle.value = '';
  await refresh();
  say('已加一项技能，右栏列里程碑');
}

async function addTheme(): Promise<void> {
  const title = newThemeTitle.value.trim();
  if (!title) return;
  await callDomain('growth.addTheme', null, { title: title });
  newThemeTitle.value = '';
  await refresh();
  say('已开一个主题，右栏放书');
}

// --- 行内快捷：日常最高频的两个动作，不该逼人先进右栏 ---
async function practice30(s: SkillRow): Promise<void> {
  await callDomain('growth.addPractice', null, s.id, { date: localDate(), minutes: 30 });
  await refresh();
  say('「' + s.title + '」已记 30 分钟练习');
}

async function read10(t: ThemeRow): Promise<void> {
  const book = asArray<BookRow>(t.books).filter(function (b) { return b.status === 'reading'; })[0]
    || asArray<BookRow>(t.books).filter(function (b) { return b.status === 'todo'; })[0];
  if (!book) { say('这个主题还没有书，先进右栏加一本'); return; }
  await callDomain('growth.advanceBook', null, t.id, book.id, 10);
  await refresh();
  say('《' + book.title + '》+10 页');
}

async function removeExam(e: ExamRow): Promise<void> {
  await callDomain('growth.removeExam', null, e.id);
  if (props.selected === e.id) emit('select-item', '');
  await refresh();
  say('已删除这场考试');
}
async function removeSkill(s: SkillRow): Promise<void> {
  await callDomain('growth.removeSkill', null, s.id);
  if (props.selected === s.id) emit('select-item', '');
  await refresh();
  say('已删除这项技能');
}
async function removeTheme(t: ThemeRow): Promise<void> {
  await callDomain('growth.removeTheme', null, t.id);
  if (props.selected === t.id) emit('select-item', '');
  await refresh();
  say('已删除这个主题（书单一起删）');
}

async function importLegacy(): Promise<void> {
  importing.value = true;
  const res = await callDomain<{ addedBooks?: number; addedSkills?: number } | null>('growth.importLegacy', null);
  importing.value = false;
  const books = res && typeof res.addedBooks === 'number' ? res.addedBooks : 0;
  const skill = res && typeof res.addedSkills === 'number' ? res.addedSkills : 0;
  if (!books && !skill) { say('旧学习库没有可导入的条目（或已经导入过）'); return; }
  await refresh();
  say('旧学习库已导入：' + books + ' 本书进主题阅读、' + skill + ' 门课进技能学习');
}

async function saveDayNote(): Promise<void> {
  const log = Object.assign({}, (props.record.studyLog as object) || {}, { note: dayNote.value.slice(0, 120) });
  emit('save', Object.assign({}, JSON.parse(JSON.stringify(props.record)), { studyLog: log }) as DiaryRecord);
  say('今日一句已保存到今日记录');
}

onMounted(load);
</script>

<template>
  <section class="growth-view">
    <header class="head">
      <div>
        <h2>学习 · 学习成长</h2>
      </div>
      <div class="head-actions">
        <button class="ghost" :disabled="importing" @click="importLegacy">
          {{ importing ? '导入中…' : '导入旧学习库' }}
        </button>
        <button class="back" @click="emit('back')">← 返回九格</button>
      </div>
    </header>

    <p class="insight" :class="{ 'growth-insight-on': !!board }">{{ board ? board.insight : '正在读取本机学习库…' }}</p>

    <div class="tabs" role="tablist" aria-label="学习类型">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="g-tab"
        :class="{ 'g-tab-on': active === t.key }"
        role="tab"
        :aria-selected="active === t.key"
        @click="active = t.key"
      >{{ t.label }}<span class="num">{{ tabCount[t.key] }}</span></button>
      <span class="tab-hint">{{ currentHint }}</span>
    </div>

    <div class="chip-row">
      <span v-for="c in chips" :key="c.label" class="chip" :class="{ 'chip-warn': c.warn }">
        {{ c.label }} <b>{{ c.value }}</b>
      </span>
    </div>

    <!-- 新建：三个 tab 三套字段，考试要日期，技能只要名字，阅读只要主题名 -->
    <div v-if="active === 'exam'" class="add-row">
      <input v-model="newExamTitle" class="grow" maxlength="40" placeholder="考什么（如「一级建造师 · 市政」）"
        aria-label="考试名称" @keydown.enter.prevent="addExam" />
      <input v-model="newExamDate" class="date" type="date" aria-label="考试日期" />
      <button class="primary" :class="{ 'add-on': !!newExamTitle.trim() }" @click="addExam">加一场考试</button>
    </div>
    <div v-else-if="active === 'skill'" class="add-row">
      <input v-model="newSkillTitle" class="grow" maxlength="40" placeholder="练什么（如「Python 数据处理」）"
        aria-label="技能名称" @keydown.enter.prevent="addSkill" />
      <button class="primary" :class="{ 'add-on': !!newSkillTitle.trim() }" @click="addSkill">加一项技能</button>
    </div>
    <div v-else class="add-row">
      <input v-model="newThemeTitle" class="grow" maxlength="40" placeholder="读什么主题（如「给排水规范」）"
        aria-label="阅读主题" @keydown.enter.prevent="addTheme" />
      <button class="primary" :class="{ 'add-on': !!newThemeTitle.trim() }" @click="addTheme">开一个主题</button>
    </div>

    <!-- 列表：一行一条，列对齐（标题 / 中段指标 / 进度 / 右侧状态） -->
    <div class="colhead" aria-hidden="true">
      <span class="ch-dot"></span>
      <span class="ch-title">{{ active === 'exam' ? '考试' : (active === 'skill' ? '技能' : '主题') }}</span>
      <span class="ch-mid">{{ active === 'exam' ? '科目' : (active === 'skill' ? '里程碑' : '书单') }}</span>
      <span class="ch-bar"></span>
      <span class="ch-num">{{ active === 'exam' ? '加权' : (active === 'skill' ? '累计' : '摘录') }}</span>
      <span class="ch-side">{{ active === 'exam' ? '倒计时' : (active === 'skill' ? '等级' : '在读') }}</span>
      <span class="ch-tail"></span>
    </div>

    <ul class="rows">
      <template v-if="active === 'exam'">
        <li
          v-for="e in exams"
          :key="e.id"
          class="g-row"
          :class="{ 'g-sel': selected === e.id, 'g-past': e.stage === 'past' }"
          :aria-current="selected === e.id ? 'true' : undefined"
          @click="pick(e.id)"
        >
          <span class="g-dot" :class="'g-dot-' + e.stage" aria-hidden="true"></span>
          <span class="g-title">{{ e.title }}<span v-if="e.org" class="g-sub">{{ e.org }}</span></span>
          <span class="g-mid">{{ e.subjectDone }} / {{ e.subjectCount }} 科</span>
          <span class="g-bar"><i :style="{ width: e.pct + '%' }"></i></span>
          <span class="g-num">{{ e.pct }}%</span>
          <span class="g-side" :class="{ 'g-warn': e.soon || e.enrollMissed }">
            {{ e.countdown }}<span class="g-gap">· {{ e.stageLabel }}</span>
          </span>
          <span class="g-acts"><button class="g-del" aria-label="删除考试" @click.stop="removeExam(e)">×</button></span>
        </li>
        <li v-if="!exams.length" class="g-empty">
          还没有考试，填考试日即可显示倒计时。
        </li>
      </template>

      <template v-else-if="active === 'skill'">
        <li
          v-for="s in skills"
          :key="s.id"
          class="g-row"
          :class="{ 'g-sel': selected === s.id }"
          :aria-current="selected === s.id ? 'true' : undefined"
          @click="pick(s.id)"
        >
          <span class="g-dot g-dot-skill" aria-hidden="true"></span>
          <span class="g-title">{{ s.title }}<span v-if="s.ready" class="g-badge">可升级</span></span>
          <span class="g-mid">{{ s.milestoneDone }} / {{ s.milestoneTotal }} 里程碑</span>
          <span class="g-bar"><i :style="{ width: s.milestonePct + '%' }"></i></span>
          <span class="g-num">{{ s.minutes }}′</span>
          <span class="g-side">{{ s.levelText }}<span class="g-gap">· 本周 {{ s.weekText }}</span></span>
          <span class="g-acts">
            <button class="mini g-quick" @click.stop="practice30(s)">+30′</button>
            <button class="g-del" aria-label="删除技能" @click.stop="removeSkill(s)">×</button>
          </span>
        </li>
        <li v-if="!skills.length" class="g-empty">
          还没有技能。技能不追「完成」，追的是里程碑与练习时长——先写一个「能独立做出来」的里程碑。
        </li>
      </template>

      <template v-else>
        <li
          v-for="t in themes"
          :key="t.id"
          class="g-row"
          :class="{ 'g-sel': selected === t.id }"
          :aria-current="selected === t.id ? 'true' : undefined"
          @click="pick(t.id)"
        >
          <span class="g-dot g-dot-theme" aria-hidden="true"></span>
          <span class="g-title">{{ t.title }}<span v-if="t.note" class="g-sub">{{ t.note }}</span></span>
          <span class="g-mid">{{ t.bookText }}</span>
          <span class="g-bar"><i :style="{ width: t.pct + '%' }"></i></span>
          <span class="g-num">{{ t.quoteTotal }} 条</span>
          <span class="g-side">
            {{ t.currentTitle ? '在读《' + t.currentTitle + '》' : (t.bookTotal ? '没有在读的' : '还没有书') }}
          </span>
          <span class="g-acts">
            <button class="mini g-quick" @click.stop="read10(t)">+10 页</button>
            <button class="g-del" aria-label="删除主题" @click.stop="removeTheme(t)">×</button>
          </span>
        </li>
        <li v-if="!themes.length" class="g-empty">
          还没有主题。主题是一批书围着同一个问题——先开一个，再往里放书。
        </li>
      </template>
    </ul>

    <!-- 待看一眼：只在真有事时出现，凑数的提醒等于没有提醒 -->
    <section v-if="alerts.length" class="alerts">
      <h3>该看一眼</h3>
      <div v-for="a in alerts" :key="a.kind + a.id" class="alert" :class="'alert-' + a.level">
        <span class="alert-kind">{{ a.kind === 'exam' ? '考' : (a.kind === 'skill' ? '技' : '读') }}</span>
        <span class="alert-title">{{ a.title }}</span>
        <span class="alert-text">{{ a.text }}</span>
      </div>
    </section>

    <section class="day-note">
      <h3>今日一句 </h3>
      <textarea v-model="dayNote" class="area" rows="2" maxlength="120" aria-label="今日一句"></textarea>
      <button class="primary" :class="{ 'note-on': !!dayNote }" @click="saveDayNote">保存今日一句</button>
    </section>

    <p class="note">{{ board ? board.note : '' }}</p>
    <div v-if="msg" class="msg" :class="{ 'message-on': !!msg }" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
.growth-view { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.head h2 { margin: 0; font-size: 15px; font-weight: 500; }
.head-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.muted { font-size: 12px; color: var(--surface-muted); }
.insight { margin: 0; padding: 8px 10px; border-left: 2px solid var(--palette-border); background: var(--surface-panel); font-size: 12px; line-height: 1.6; }
.growth-insight-on { border-left-color: var(--palette-primary); }

.tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.g-tab {
  padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: 999px;
  background: var(--surface-raised); font-size: 12px;
}
.g-tab-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.num { margin-left: 6px; font-variant-numeric: tabular-nums; opacity: 0.75; }
.tab-hint { font-size: 11px; color: var(--surface-muted); }

.chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 3px 10px; border-radius: 999px; background: var(--surface-raised); font-size: 12px; }
.chip b { font-weight: 500; font-variant-numeric: tabular-nums; }
.chip-warn { background: var(--state-warn-soft); color: var(--state-warn); }

.add-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
input, textarea { padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; font-family: inherit; }
input:focus, textarea:focus { border-color: var(--palette-accent); }
.grow { flex: 1 1 220px; min-width: 140px; }
.date { flex: 0 0 150px; }
.primary, .ghost, .back, .mini {
  padding: 6px 12px; border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md); background: var(--surface-raised);
}
.primary.add-on, .primary.note-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }

.colhead { display: flex; gap: 8px; padding: 0 10px; font-size: 10px; color: var(--surface-muted); letter-spacing: 0.04em; }
.ch-dot { flex: 0 0 6px; }
.ch-title { flex: 1; min-width: 0; }
.ch-bar { flex: 0 0 60px; }
.ch-tail { flex: 0 0 96px; }
.ch-mid { flex: 0 0 96px; }
.ch-num { flex: 0 0 62px; }
.ch-side { flex: 0 0 168px; }

.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.g-row {
  position: relative;
  display: flex; align-items: center; gap: 8px; padding: 6px 100px 6px 10px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); font-size: 12px; cursor: pointer;
}
.g-row:hover { border-color: var(--palette-border); }
.g-sel { border-color: var(--palette-primary); box-shadow: inset 2px 0 0 var(--palette-primary); background: var(--palette-soft); }
.g-past { opacity: 0.62; }
.g-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--palette-accent); flex: 0 0 6px; }
.g-dot-base { background: var(--palette-accent); }
.g-dot-build { background: var(--palette-primary); }
.g-dot-sprint { background: var(--state-warn); }
.g-dot-today { background: var(--state-warn); }
.g-dot-past { background: var(--surface-border); }
.g-dot-none { background: var(--surface-border); }
.g-dot-skill { background: var(--palette-primary); }
.g-dot-theme { background: var(--palette-accent); }
.g-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-sub { margin-left: 6px; font-size: 11px; color: var(--surface-muted); }
.g-badge { margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--palette-primary); color: var(--palette-on); font-size: 10px; }
.g-mid { flex: 0 0 96px; color: var(--surface-muted); font-variant-numeric: tabular-nums; }
.g-bar { flex: 0 0 60px; height: 5px; border-radius: 999px; background: var(--surface-panel); overflow: hidden; }
.g-bar i { display: block; height: 100%; background: var(--palette-primary); }
.g-num { flex: 0 0 62px; font-variant-numeric: tabular-nums; color: var(--surface-muted); }
.g-side { flex: 0 0 168px; font-size: 11px; color: var(--surface-muted); }
.g-warn { color: var(--state-warn); }
.g-gap { opacity: 0.8; }
.g-acts { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 2px; }
.g-quick { flex: 0 0 auto; font-size: 11px; padding: 2px 8px; }
.g-del { border: 0; background: transparent; color: var(--surface-muted); flex: 0 0 auto; }
.g-empty { padding: 12px; font-size: 12px; color: var(--surface-muted); border: 0.5px dashed var(--surface-border); border-radius: var(--radius-sm); line-height: 1.7; }

.alerts { display: flex; flex-direction: column; gap: 4px; padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.alerts h3 { margin: 0 0 2px; font-size: 12px; font-weight: 500; }
.alert { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.alert-kind { flex: 0 0 16px; text-align: center; border-radius: 3px; background: var(--surface-raised); color: var(--palette-primary); font-size: 10px; }
.alert-title { flex: 0 0 auto; }
.alert-text { color: var(--surface-muted); }
.alert-warn .alert-text { color: var(--state-warn); }
.alert-done .alert-text { color: var(--palette-primary); }

.day-note { display: flex; flex-direction: column; gap: 6px; padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); }
.day-note h3 { margin: 0; font-size: 12px; font-weight: 500; display: flex; gap: 8px; align-items: baseline; }
.area { width: 100%; resize: vertical; }
.note { margin: 0; font-size: 11px; color: var(--surface-muted); line-height: 1.6; }
.msg { padding: 6px 10px; border-radius: var(--radius-sm); background: var(--surface-panel); font-size: 12px; }
.message-on { background: var(--palette-soft); color: var(--palette-primary); }

@media (max-width: 1180px) {
  .ch-side, .g-side { flex-basis: 120px; }
  .ch-mid, .g-mid { flex-basis: 76px; }
}
</style>
