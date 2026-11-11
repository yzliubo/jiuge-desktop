<script setup lang="ts">
// 学习成长（growth 格）的右栏。
//
// 三种活动三套详情表单，因为它们的「进度」不是同一个东西：
//   · 考试：科目（章/套）→ 加权进度；再加成绩与合格线判通过；
//   · 技能：里程碑勾选 + 练习记录（分钟）→ 累计时长与等级；
//   · 阅读：书单（页数）+ 摘录（一句话 + 页码）。
//
// 写边界与工作台一致：这一栏只写「当前选中的那一条」，所有写调用的第二个参数都是 sel.id；
// 新建与批量操作在中栏，这里只改细节。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { localDate } from '../../types';

const props = defineProps<{ itemId: string; tick?: number }>();
const emit = defineEmits<{
  (e: 'changed'): void;
  (e: 'select-item', id: string): void;
  (e: 'notify', text: string): void;
}>();

interface Subject { id: string; title: string; unit: string; total: number; done: number; pct: number; progressText: string }
interface ExamRow {
  id: string; title: string; org: string; examDate: string; enrollDate: string;
  status: string; score: number; passLine: number; note: string;
  subjects: Subject[]; pct: number; countdown: string; stageLabel: string;
  resultText: string; enrollMissed: boolean;
}
interface Milestone { id: string; title: string; done: boolean }
interface Practice { id: string; date: string; minutes: number; note?: string }
interface SkillRow {
  id: string; title: string; level: number; targetLevel: number; note: string;
  milestones: Milestone[]; practices: Practice[];
  levelText: string; milestoneDone: number; milestoneTotal: number; milestonePct: number;
  minutes: number; hoursText: string; weekText: string; nextTitle: string; ready: boolean;
}
interface Quote { id: string; text: string; page: number }
interface BookRow {
  id: string; title: string; author: string; total: number; done: number; unit: string;
  status: string; rating: number; pct: number; progressText: string; statusLabel: string; quotes: Quote[];
}
interface ThemeRow {
  id: string; title: string; note: string; books: BookRow[];
  bookTotal: number; bookDone: number; pct: number; quoteTotal: number; bookText: string;
}
interface GrowthStats {
  examTotal: number; examSoon: number; skillTotal: number; skillHours: number;
  skillWeek: number; themeTotal: number; bookTotal: number; bookDone: number;
  quoteTotal: number; total: number;
}
interface Alert { kind: string; id: string; title: string; level: string; text: string }
interface Board {
  exams: ExamRow[]; skills: SkillRow[]; themes: ThemeRow[];
  stats: GrowthStats; alerts: Alert[]; insight: string;
}

const EXAM_STATUS = [
  { key: 'plan', label: '备考中' },
  { key: 'registered', label: '已报名' },
  { key: 'passed', label: '已通过' },
  { key: 'failed', label: '未通过' }
];
const LEVELS = [
  { level: 1, label: '初识' }, { level: 2, label: '入门' }, { level: 3, label: '熟练' },
  { level: 4, label: '精通' }, { level: 5, label: '传授' }
];

const board = ref<Board | null>(null);
const loading = ref(true);
const msg = ref('');
let msgTimer: ReturnType<typeof setTimeout> | null = null;

function say(t: string): void {
  msg.value = t;
  if (msgTimer) clearTimeout(msgTimer);
  msgTimer = setTimeout(function () { msg.value = ''; }, 3000);
}

const exam = computed<ExamRow | null>(function () {
  if (!props.itemId || !board.value) return null;
  return board.value.exams.filter(function (e) { return e.id === props.itemId; })[0] || null;
});
const skill = computed<SkillRow | null>(function () {
  if (!props.itemId || !board.value) return null;
  return board.value.skills.filter(function (s) { return s.id === props.itemId; })[0] || null;
});
const theme = computed<ThemeRow | null>(function () {
  if (!props.itemId || !board.value) return null;
  return board.value.themes.filter(function (t) { return t.id === props.itemId; })[0] || null;
});

// 表单草稿：换了一条就整份回填，同一条只在本机没有未保存改动时回填
const dTitle = ref('');
const dOrg = ref('');
const dExamDate = ref('');
const dEnrollDate = ref('');
const dStatus = ref('plan');
const dScore = ref('');
const dPassLine = ref('');
const dNote = ref('');
const dLevel = ref(1);
const dTarget = ref(2);

const syncedId = ref('__init__');

function syncDraft(): void {
  if (exam.value) {
    const e = exam.value;
    dTitle.value = e.title;
    dOrg.value = e.org || '';
    dExamDate.value = e.examDate || '';
    dEnrollDate.value = e.enrollDate || '';
    dStatus.value = e.status;
    dScore.value = e.score ? String(e.score) : '';
    dPassLine.value = e.passLine ? String(e.passLine) : '';
    dNote.value = e.note || '';
  } else if (skill.value) {
    const s = skill.value;
    dTitle.value = s.title;
    dLevel.value = s.level;
    dTarget.value = s.targetLevel;
    dNote.value = s.note || '';
  } else if (theme.value) {
    dTitle.value = theme.value.title;
    dNote.value = theme.value.note || '';
  }
  syncedId.value = props.itemId;
}

async function load(): Promise<void> {
  loading.value = true;
  board.value = await callDomain<Board | null>('growth.board', null, localDate());
  loading.value = false;
  const found = exam.value || skill.value || theme.value;
  if (props.itemId && !found) emit('select-item', '');
  // 只换条目时整份回填；同一条重取数据不动草稿，免得把正在敲的字冲掉
  if (syncedId.value !== props.itemId) syncDraft();
  if (!bookSel.value && theme.value && theme.value.books.length) {
    bookSel.value = theme.value.books[0].id;
  }
}

async function afterChange(text: string): Promise<void> {
  say(text);
  emit('notify', text);
  emit('changed');
}

// ---------- 考试 ----------
async function saveExam(): Promise<void> {
  if (!exam.value) return;
  if (!dTitle.value.trim()) { say('考试名称不能空着'); return; }
  await callDomain('growth.updateExam', null, exam.value.id, {
    title: dTitle.value.trim(), org: dOrg.value.trim(),
    examDate: dExamDate.value, enrollDate: dEnrollDate.value,
    status: dStatus.value, note: dNote.value.trim()
  });
  await afterChange('考试信息已保存');
}

async function saveResult(): Promise<void> {
  if (!exam.value) return;
  const score = Number(dScore.value) || 0;
  const pass = Number(dPassLine.value) || 0;
  if (!score || !pass) { say('分数和合格线都要填，才判得了通过'); return; }
  await callDomain('growth.setExamResult', null, exam.value.id, score, pass);
  await afterChange(score >= pass ? '已记为通过' : '已记为未通过');
}

async function retake(): Promise<void> {
  if (!exam.value) return;
  await callDomain('growth.retakeExam', null, exam.value.id);
  dExamDate.value = '';
  dEnrollDate.value = '';
  dScore.value = '';
  dPassLine.value = '';
  dStatus.value = 'plan';
  await afterChange('已重置为备考中，科目进度归零');
}

const newSubject = ref('');
const newSubjectTotal = ref('');
async function addSubject(): Promise<void> {
  if (!exam.value) return;
  const title = newSubject.value.trim();
  if (!title) return;
  await callDomain('growth.addSubject', null, exam.value.id, {
    title: title, total: Number(newSubjectTotal.value) || 10
  });
  newSubject.value = '';
  newSubjectTotal.value = '';
  await afterChange('已加一个科目');
}
async function subPlus(sub: Subject): Promise<void> {
  if (!exam.value) return;
  await callDomain('growth.updateSubject', null, exam.value.id, sub.id, { done: sub.done + 1 });
  await afterChange('「' + sub.title + '」+1 ' + sub.unit);
}
async function subRemove(sub: Subject): Promise<void> {
  if (!exam.value) return;
  await callDomain('growth.removeSubject', null, exam.value.id, sub.id);
  await afterChange('已删科目「' + sub.title + '」');
}

// ---------- 技能 ----------
async function saveSkill(): Promise<void> {
  if (!skill.value) return;
  if (!dTitle.value.trim()) { say('技能名称不能空着'); return; }
  await callDomain('growth.updateSkill', null, skill.value.id, {
    title: dTitle.value.trim(), level: dLevel.value, targetLevel: dTarget.value, note: dNote.value.trim()
  });
  await afterChange('技能信息已保存');
}

const newMs = ref('');
async function addMilestone(): Promise<void> {
  if (!skill.value) return;
  const text = newMs.value.trim();
  if (!text) return;
  await callDomain('growth.addMilestone', null, skill.value.id, text);
  newMs.value = '';
  await afterChange('已加一条里程碑');
}
async function toggleMs(m: Milestone): Promise<void> {
  if (!skill.value) return;
  await callDomain('growth.toggleMilestone', null, skill.value.id, m.id);
  await afterChange(m.done ? '已取消达成' : '已标为达成');
}
async function removeMs(m: Milestone): Promise<void> {
  if (!skill.value) return;
  await callDomain('growth.removeMilestone', null, skill.value.id, m.id);
  await afterChange('已删里程碑');
}

const practiceMin = ref('30');
async function logPractice(): Promise<void> {
  if (!skill.value) return;
  const minutes = Number(practiceMin.value) || 0;
  if (minutes <= 0) { say('填一下这次练了多少分钟'); return; }
  await callDomain('growth.addPractice', null, skill.value.id, { date: localDate(), minutes: minutes });
  await afterChange('已记 ' + minutes + ' 分钟练习');
}
async function removePractice(p: Practice): Promise<void> {
  if (!skill.value) return;
  await callDomain('growth.removePractice', null, skill.value.id, p.id);
  await afterChange('已删这条练习记录');
}

// ---------- 阅读 ----------
const bookSel = ref('');
const currentBook = computed<BookRow | null>(function () {
  if (!theme.value || !bookSel.value) return null;
  return theme.value.books.filter(function (b) { return b.id === bookSel.value; })[0] || null;
});
async function saveTheme(): Promise<void> {
  if (!theme.value) return;
  if (!dTitle.value.trim()) { say('主题名不能空着'); return; }
  await callDomain('growth.updateTheme', null, theme.value.id, {
    title: dTitle.value.trim(), note: dNote.value.trim()
  });
  await afterChange('主题信息已保存');
}

const newBook = ref('');
const newBookAuthor = ref('');
const newBookPages = ref('');
async function addBook(): Promise<void> {
  if (!theme.value) return;
  const title = newBook.value.trim();
  if (!title) return;
  await callDomain('growth.addBook', null, theme.value.id, {
    title: title, author: newBookAuthor.value.trim(), total: Number(newBookPages.value) || 300
  });
  newBook.value = '';
  newBookAuthor.value = '';
  newBookPages.value = '';
  await afterChange('已加一本书');
}
async function bookStep(b: BookRow, delta: number): Promise<void> {
  if (!theme.value) return;
  await callDomain('growth.advanceBook', null, theme.value.id, b.id, delta);
  await afterChange('《' + b.title + '》' + (delta > 0 ? '+' : '') + delta + ' ' + b.unit);
}
async function bookStatus(b: BookRow, status: string): Promise<void> {
  if (!theme.value) return;
  await callDomain('growth.setBookStatus', null, theme.value.id, b.id, status);
  await afterChange('已标为「' + (status === 'done' ? '读完' : (status === 'reading' ? '在读' : '待读')) + '」');
}
async function bookRemove(b: BookRow): Promise<void> {
  if (!theme.value) return;
  await callDomain('growth.removeBook', null, theme.value.id, b.id);
  if (bookSel.value === b.id) bookSel.value = '';
  await afterChange('已删《' + b.title + '》');
}

const newQuote = ref('');
const newQuotePage = ref('');
async function addQuote(): Promise<void> {
  if (!theme.value || !currentBook.value) return;
  const text = newQuote.value.trim();
  if (!text) return;
  await callDomain('growth.addQuote', null, theme.value.id, currentBook.value.id, {
    text: text, page: Number(newQuotePage.value) || 0
  });
  newQuote.value = '';
  newQuotePage.value = '';
  await afterChange('已存一条摘录');
}
async function removeQuote(q: Quote): Promise<void> {
  if (!theme.value || !currentBook.value) return;
  await callDomain('growth.removeQuote', null, theme.value.id, currentBook.value.id, q.id);
  await afterChange('已删摘录');
}

// ---------- 删除（整条） ----------
async function removeCurrent(): Promise<void> {
  if (exam.value) {
    await callDomain('growth.removeExam', null, exam.value.id);
    emit('select-item', '');
    await afterChange('已删除这场考试');
  } else if (skill.value) {
    await callDomain('growth.removeSkill', null, skill.value.id);
    emit('select-item', '');
    await afterChange('已删除这项技能');
  } else if (theme.value) {
    await callDomain('growth.removeTheme', null, theme.value.id);
    emit('select-item', '');
    await afterChange('已删除这个主题');
  }
}

onMounted(load);
watch(() => props.tick, function () { void load(); });
watch(() => props.itemId, function () { syncDraft(); });
</script>

<template>
  <div class="growth-ctx">
    <!-- 1. 选中项详情 -->
    <section class="ctx-card" :class="{ 'gc-on': !!(exam || skill || theme) }">
      <h2 class="ctx-title">
        学习详情
        <span v-if="exam" class="ctx-tag">考试考证</span>
        <span v-else-if="skill" class="ctx-tag">技能学习</span>
        <span v-else-if="theme" class="ctx-tag">主题阅读</span>
        <span v-else class="ctx-tag">未选中</span>
      </h2>

      <p v-if="!exam && !skill && !theme" class="ctx-muted">
      </p>

      <!-- ===== 考试 ===== -->
      <template v-else-if="exam">
        <p class="gc-count">{{ exam.countdown }} · {{ exam.stageLabel }} · {{ exam.resultText }}</p>
        <label class="gc-label" for="gc-title">考试名称</label>
        <input id="gc-title" v-model="dTitle" class="gc-in" maxlength="40" aria-label="考试名称" />

        <div class="gc-row">
          <div class="gc-half">
            <label class="gc-label" for="gc-org">发证 / 机构</label>
            <input id="gc-org" v-model="dOrg" class="gc-in" maxlength="20" placeholder="如 住建部" aria-label="机构" />
          </div>
          <div class="gc-half">
            <label class="gc-label" for="gc-status">状态</label>
            <select id="gc-status" v-model="dStatus" class="gc-in" aria-label="考试状态">
              <option v-for="s in EXAM_STATUS" :key="s.key" :value="s.key">{{ s.label }}</option>
            </select>
          </div>
        </div>

        <div class="gc-row">
          <div class="gc-half">
            <label class="gc-label" for="gc-exam">考试日</label>
            <input id="gc-exam" v-model="dExamDate" class="gc-in" type="date" aria-label="考试日期" />
          </div>
          <div class="gc-half">
            <label class="gc-label" for="gc-enroll">报名截止</label>
            <input id="gc-enroll" v-model="dEnrollDate" class="gc-in" type="date" aria-label="报名截止" />
          </div>
        </div>

        <p v-if="exam.enrollMissed" class="ctx-muted ctx-warn">报名日已过。</p>

        <span class="gc-label">科目（加权进度 {{ exam.pct }}%）</span>
        <div class="gc-list">
          <div v-for="sub in exam.subjects" :key="sub.id" class="gc-item">
            <span class="gc-item-main">{{ sub.title }}</span>
            <span class="gc-item-side">{{ sub.progressText }}</span>
            <button class="gc-mini" @click="subPlus(sub)">+1</button>
            <button class="gc-x" aria-label="删除科目" @click="subRemove(sub)">×</button>
          </div>
          <p v-if="!exam.subjects.length" class="ctx-muted">还没有科目。</p>
        </div>
        <div class="gc-add">
          <input v-model="newSubject" class="gc-in" maxlength="20" placeholder="科目名，如 市政实务"
            aria-label="新科目" @keydown.enter.prevent="addSubject" />
          <input v-model="newSubjectTotal" class="gc-in gc-num" type="number" min="1" placeholder="总章数"
            aria-label="总章数" />
          <button class="gc-btn" @click="addSubject">加科目</button>
        </div>

        <span class="gc-label">成绩</span>
        <div class="gc-add">
          <input v-model="dScore" class="gc-in gc-num" type="number" min="0" placeholder="分数" aria-label="分数" />
          <input v-model="dPassLine" class="gc-in gc-num" type="number" min="0" placeholder="合格线" aria-label="合格线" />
          <button class="gc-btn" @click="saveResult">记成绩</button>
          <button class="gc-btn" @click="retake">再来一次</button>
        </div>

        <label class="gc-label" for="gc-note">备注</label>
        <textarea id="gc-note" v-model="dNote" class="gc-in gc-area" rows="2" maxlength="200"
          placeholder="报名材料、考场、复习资料…" aria-label="考试备注"></textarea>

        <div class="gc-actions">
          <button class="gc-btn gc-primary" @click="saveExam">保存考试信息</button>
          <button class="gc-btn gc-del" @click="removeCurrent">删除</button>
        </div>
      </template>

      <!-- ===== 技能 ===== -->
      <template v-else-if="skill">
        <p class="gc-count">{{ skill.levelText }} · 里程碑 {{ skill.milestoneDone }} / {{ skill.milestoneTotal }} · 累计 {{ skill.hoursText }} 小时</p>
        <label class="gc-label" for="gc-skill">技能名称</label>
        <input id="gc-skill" v-model="dTitle" class="gc-in" maxlength="40" aria-label="技能名称" />

        <div class="gc-row">
          <div class="gc-half">
            <label class="gc-label" for="gc-level">当前等级</label>
            <select id="gc-level" v-model.number="dLevel" class="gc-in" aria-label="当前等级">
              <option v-for="l in LEVELS" :key="l.level" :value="l.level">{{ l.level }} · {{ l.label }}</option>
            </select>
          </div>
          <div class="gc-half">
            <label class="gc-label" for="gc-target">目标等级</label>
            <select id="gc-target" v-model.number="dTarget" class="gc-in" aria-label="目标等级">
              <option v-for="l in LEVELS" :key="l.level" :value="l.level">{{ l.level }} · {{ l.label }}</option>
            </select>
          </div>
        </div>
        <p v-if="skill.ready" class="gc-ready">里程碑全达成 —— 等级可以往上调一格了，不调进度条会骗人。</p>

        <span class="gc-label">里程碑</span>
        <div class="gc-list">
          <div v-for="m in skill.milestones" :key="m.id" class="gc-item">
            <button class="gc-check" :aria-pressed="m.done" @click="toggleMs(m)">{{ m.done ? '✓' : '○' }}</button>
            <span class="gc-item-main" :class="{ 'gc-done': m.done }">{{ m.title }}</span>
            <button class="gc-x" aria-label="删除里程碑" @click="removeMs(m)">×</button>
          </div>
          <p v-if="!skill.milestones.length" class="ctx-muted">还没有里程碑。写「能独立做出来的一件事」，别写「学会 XX」。</p>
        </div>
        <div class="gc-add">
          <input v-model="newMs" class="gc-in" maxlength="30" placeholder="一条能验证的里程碑"
            aria-label="新里程碑" @keydown.enter.prevent="addMilestone" />
          <button class="gc-btn" @click="addMilestone">加</button>
        </div>

        <span class="gc-label">练习（本周 {{ skill.weekText }} · 累计 {{ skill.hoursText }} 小时）</span>
        <div class="gc-add">
          <input v-model="practiceMin" class="gc-in gc-num" type="number" min="1" placeholder="分钟"
            aria-label="练习分钟" />
          <button class="gc-btn" @click="logPractice">记今天这一笔</button>
        </div>
        <div class="gc-list">
          <div v-for="p in skill.practices.slice(0, 5)" :key="p.id" class="gc-item">
            <span class="gc-item-main">{{ p.date }}</span>
            <span class="gc-item-side">{{ p.minutes }} 分钟</span>
            <button class="gc-x" aria-label="删除练习记录" @click="removePractice(p)">×</button>
          </div>
        </div>
        <p v-if="skill.nextTitle" class="ctx-muted">下一步：{{ skill.nextTitle }}</p>

        <label class="gc-label" for="gc-snote">备注</label>
        <textarea id="gc-snote" v-model="dNote" class="gc-in gc-area" rows="2" maxlength="200"
          placeholder="练习方法、卡在哪、参考谁…" aria-label="技能备注"></textarea>

        <div class="gc-actions">
          <button class="gc-btn gc-primary" @click="saveSkill">保存技能信息</button>
          <button class="gc-btn gc-del" @click="removeCurrent">删除</button>
        </div>
      </template>

      <!-- ===== 主题阅读 ===== -->
      <template v-else-if="theme">
        <p class="gc-count">{{ theme.bookText }} · 主题推进 {{ theme.pct }}% · 摘录 {{ theme.quoteTotal }} 条</p>
        <label class="gc-label" for="gc-theme">主题名</label>
        <input id="gc-theme" v-model="dTitle" class="gc-in" maxlength="40" aria-label="主题名" />

        <label class="gc-label" for="gc-tnote">这个主题要回答什么</label>
        <textarea id="gc-tnote" v-model="dNote" class="gc-in gc-area" rows="2" maxlength="200"
          placeholder="一句话说清主题，选书才不会散" aria-label="主题说明"></textarea>

        <span class="gc-label">书单</span>
        <div class="gc-list">
          <div
            v-for="b in theme.books"
            :key="b.id"
            class="gc-item gc-book"
            :class="{ 'gc-book-on': bookSel === b.id }"
          >
            <button class="gc-book-title" @click="bookSel = b.id">
              {{ b.title }}<span class="gc-item-side">· {{ b.statusLabel }}</span>
            </button>
            <span class="gc-item-side">{{ b.progressText }}</span>
            <button class="gc-mini" @click="bookStep(b, 10)">+10</button>
            <button class="gc-mini" @click="bookStatus(b, b.status === 'done' ? 'reading' : 'done')">
              {{ b.status === 'done' ? '重读' : '读完' }}
            </button>
            <button class="gc-x" aria-label="删除书" @click="bookRemove(b)">×</button>
          </div>
          <p v-if="!theme.books.length" class="ctx-muted">还没有书。一个主题三到五本最合适，太多就变成愿望清单。</p>
        </div>
        <div class="gc-add">
          <input v-model="newBook" class="gc-in" maxlength="50" placeholder="书名" aria-label="书名" />
          <input v-model="newBookAuthor" class="gc-in gc-num" maxlength="24" placeholder="作者" aria-label="作者" />
          <input v-model="newBookPages" class="gc-in gc-num" type="number" min="1" placeholder="页数" aria-label="页数" />
          <button class="gc-btn" @click="addBook">加书</button>
        </div>

        <template v-if="currentBook">
          <span class="gc-label">摘录 ·《{{ currentBook.title }}》</span>
          <div class="gc-list">
            <div v-for="q in currentBook.quotes" :key="q.id" class="gc-quote">
              <span class="gc-quote-text">{{ q.text }}</span>
              <span v-if="q.page" class="gc-item-side">p.{{ q.page }}</span>
              <button class="gc-x" aria-label="删除摘录" @click="removeQuote(q)">×</button>
            </div>
            <p v-if="!currentBook.quotes.length" class="ctx-muted">还没有摘录。读到想划线的那句，抄进来——比标「读完」有用。</p>
          </div>
          <div class="gc-add">
            <input v-model="newQuote" class="gc-in" maxlength="200" placeholder="抄一句"
              aria-label="摘录内容" @keydown.enter.prevent="addQuote" />
            <input v-model="newQuotePage" class="gc-in gc-num" type="number" min="0" placeholder="页" aria-label="页码" />
            <button class="gc-btn" @click="addQuote">存摘录</button>
          </div>
        </template>

        <div class="gc-actions">
          <button class="gc-btn gc-primary" @click="saveTheme">保存主题信息</button>
          <button class="gc-btn gc-del" @click="removeCurrent">删除</button>
        </div>
      </template>
    </section>

    <!-- 2. 三块总览 -->
    <section class="ctx-card">
      <h2 class="ctx-title">学习库 · 三块<span class="ctx-tag">{{ board ? board.stats.total : 0 }} 条目</span></h2>
      <div class="gc-grid">
        <div class="ctx-kv">
          <span class="ctx-kv-label">考试</span>
          <span class="ctx-kv-val">{{ board ? board.stats.examTotal : 0 }}<span class="ctx-kv-unit">场</span></span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">技能</span>
          <span class="ctx-kv-val">{{ board ? board.stats.skillTotal : 0 }}<span class="ctx-kv-unit">项</span></span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">主题</span>
          <span class="ctx-kv-val">{{ board ? board.stats.themeTotal : 0 }}<span class="ctx-kv-unit">个</span></span>
        </div>
        <div class="ctx-kv">
          <span class="ctx-kv-label">读完</span>
          <span class="ctx-kv-val">{{ board ? board.stats.bookDone : 0 }}<span class="ctx-kv-unit">本</span></span>
        </div>
      </div>
      <p class="ctx-muted">
        累计练习 {{ board ? board.stats.skillHours : 0 }} 小时 · 本周
        {{ board && board.stats.skillWeek >= 60 ? (board.stats.skillWeek / 60).toFixed(1) + ' 小时' : (board ? board.stats.skillWeek : 0) + ' 分钟' }}
        · 摘录 {{ board ? board.stats.quoteTotal : 0 }} 条
      </p>
      <p v-if="loading" class="ctx-muted">读取中…</p>
    </section>

    <!-- 3. 该看一眼 -->
    <section v-if="board && board.alerts.length" class="ctx-card">
      <h2 class="ctx-title">该看一眼<span class="ctx-tag">{{ board.alerts.length }}</span></h2>
      <button
        v-for="a in board.alerts"
        :key="a.kind + a.id"
        class="ctx-item"
        :class="{ 'gc-alert-on': a.id === itemId }"
        @click="emit('select-item', a.id)"
      >
        <span class="ctx-item-main">{{ a.title }}</span>
        <span class="ctx-item-side">{{ a.text }}</span>
      </button>
    </section>

    <p v-if="msg" class="gc-msg" role="status">{{ msg }}</p>
  </div>
</template>

<style scoped>
.growth-ctx { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.gc-on { border-color: var(--palette-border); }
.gc-label { display: block; margin: 6px 0 2px; font-size: 11px; color: var(--surface-muted); }
.gc-count { margin: 0 0 4px; font-size: 11px; line-height: 1.6; color: var(--palette-primary); }
.gc-in {
  width: 100%; padding: 5px 8px; font-size: 12px; box-sizing: border-box;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel); outline: none;
}
.gc-in:focus { border-color: var(--palette-accent); }
.gc-area { resize: vertical; line-height: 1.6; font-family: inherit; }
.gc-row { display: flex; gap: 6px; }
.gc-half { flex: 1 1 0; min-width: 0; }
.gc-num { flex: 0 0 68px; }
.gc-add { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.gc-add .gc-in { flex: 1 1 80px; }
.gc-btn {
  padding: 4px 10px; font-size: 11px; border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm); background: var(--surface-panel); flex: 0 0 auto;
}
.gc-btn:hover { border-color: var(--palette-border); color: var(--palette-primary); }
.gc-primary { border-color: var(--palette-border); }
.gc-del { color: var(--state-warn); }
.gc-actions { display: flex; gap: 4px; margin-top: 8px; }
.gc-list { display: flex; flex-direction: column; gap: 3px; margin-top: 2px; }
.gc-item {
  display: flex; align-items: center; gap: 6px; padding: 3px 6px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel); font-size: 11px;
}
.gc-item-main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-item-side { flex: 0 0 auto; font-size: 10px; color: var(--surface-muted); }
.gc-done { text-decoration: line-through; color: var(--surface-muted); }
.gc-check { border: 0; background: transparent; color: var(--palette-primary); font-size: 11px; padding: 0 2px; }
.gc-mini {
  flex: 0 0 auto; padding: 1px 6px; font-size: 10px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); color: var(--surface-muted);
}
.gc-x { flex: 0 0 auto; border: 0; background: transparent; color: var(--surface-muted); font-size: 11px; }
.gc-book { flex-wrap: wrap; }
.gc-book-on { border-color: var(--palette-primary); background: var(--palette-soft); }
.gc-book-title {
  flex: 1 1 100%; min-width: 0; text-align: left; border: 0; background: transparent;
  font-size: 11px; padding: 0; color: var(--surface-text);
}
.gc-quote {
  display: flex; align-items: baseline; gap: 6px; padding: 4px 6px;
  border-left: 2px solid var(--palette-border); background: var(--surface-panel);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: 11px; line-height: 1.6;
}
.gc-quote-text { flex: 1; min-width: 0; }
.gc-ready { margin: 4px 0 0; font-size: 11px; color: var(--palette-primary); }
.gc-alert-on { border-color: var(--palette-primary); background: var(--palette-soft); }
.gc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.gc-msg {
  padding: 6px 8px; border-radius: var(--radius-sm);
  background: var(--palette-soft); color: var(--palette-primary); font-size: 11px;
}
</style>
