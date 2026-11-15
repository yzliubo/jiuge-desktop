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
import { asArray, callDomain } from '../../composables/useDomain';
import { localDate } from '../../types';
import type { ViewKey } from '../../types';

const props = defineProps<{ itemId: string; tick?: number }>();
const emit = defineEmits<{
  (e: 'changed'): void;
  (e: 'select-item', id: string): void;
  (e: 'notify', text: string): void;
  // V3.6：右栏新增快捷访问（去图书馆 / 语料库），只跳转，不在这里写数据
  (e: 'navigate', key: ViewKey): void;
}>();

interface Subject { id: string; title: string; unit: string; total: number; done: number; pct: number; progressText: string }
// V3.9：一次作答 = 一组成绩 + 组错因。只增不改，重考也不清（清掉就丢了「上次死在哪」）
interface Attempt {
  id: string; date: string; score: number; passLine: number; passed: boolean;
  causes: string[]; causesLabel: string[]; gap: number;
}
interface CauseRow { key: string; label: string; count: number }
interface ExamRow {
  id: string; title: string; org: string; examDate: string; enrollDate: string;
  status: string; score: number; passLine: number; note: string;
  subjects: Subject[]; pct: number; countdown: string; stageLabel: string;
  resultText: string; enrollMissed: boolean;
  attempts: Attempt[]; attemptCount: number; failCount: number;
  lastFail: Attempt | null; causeTop: CauseRow[];
}
interface Milestone { id: string; title: string; done: boolean }
interface Practice { id: string; date: string; minutes: number; note?: string }
interface Cleared { id: string; text: string; since: string; clearedAt: string }
interface SkillRow {
  id: string; title: string; level: number; targetLevel: number; note: string;
  milestones: Milestone[]; practices: Practice[];
  levelText: string; milestoneDone: number; milestoneTotal: number; milestonePct: number;
  minutes: number; hoursText: string; weekText: string; nextTitle: string; ready: boolean;
  // V3.9 练习反馈
  blocker: string; blockerSince: string; blockerDays: number; blockerText: string;
  stuck: boolean; nextUp: string; cleared: Cleared[]; clearedCount: number; clearedRecent: Cleared[];
}
interface Quote { id: string; text: string; page: number }
interface BookRow {
  id: string; title: string; author: string; total: number; done: number; unit: string;
  status: string; rating: number; pct: number; progressText: string; statusLabel: string; quotes: Quote[];
}
interface ThemeRow {
  id: string; title: string; note: string; books: BookRow[];
  bookTotal: number; bookDone: number; pct: number; quoteTotal: number; bookText: string;
  readingCount: number; currentTitle: string;
}
interface GrowthStats {
  examTotal: number; examSoon: number; skillTotal: number; skillHours: number;
  skillWeek: number; themeTotal: number; bookTotal: number; bookDone: number;
  quoteTotal: number; total: number;
  skillBlocked: number; skillStuck: number; examAttempts: number; examFails: number;
}
interface Alert { kind: string; id: string; title: string; level: string; text: string }
interface Board {
  exams: ExamRow[]; skills: SkillRow[]; themes: ThemeRow[];
  stats: GrowthStats; alerts: Alert[]; insight: string;
  causeTop: CauseRow[]; blockerStaleDays: number;
}
// V3.9：阅读笔记里打了 #行动 的那些——「书里让我去做的事」，回显到学习台
interface ActionNote { id: string; bookId: string; bookTitle: string; quote: string; text: string; page: number; createdAt: number }
interface NoteBoard { items: ActionNote[]; total: number }
// V3.6：图书馆书架（md_reading）的在读书。board() 派生 pct / progressText / statusLabel，
// 主进程再补 fileMissing / fileSizeText；这里只读，不写回任何一本。
interface ShelfBook {
  id: string; title: string; author: string; status: string;
  pct: number; progressText: string; statusLabel: string;
  done: number; total: number; unit: string;
  lastReadAt: number; filePath: string; fileMissing: boolean;
  themeId: string; group: string;
}
interface ShelfBoard { books: ShelfBook[] }
interface NowBook {
  key: string; id: string; title: string; author: string;
  pct: number; progressText: string; meta: string;
  canOpen: boolean; sortAt: number;
}

const EXAM_STATUS = [
  { key: 'plan', label: '备考中' },
  { key: 'registered', label: '已报名' },
  { key: 'passed', label: '已通过' },
  { key: 'failed', label: '未通过' }
];
// 与 src/growth/board.js 的 EXAM_CAUSES 同一套 key。归类而不是自由文本：
// 自由文本写三次不会重样，就统计不出「你总栽在哪」。
const EXAM_CAUSES = [
  { key: 'concept', label: '概念没懂' },
  { key: 'calc', label: '计算失误' },
  { key: 'misread', label: '审题偏差' },
  { key: 'time', label: '时间不够' },
  { key: 'material', label: '资料不对' },
  { key: 'practice', label: '练得不够' },
  { key: 'state', label: '状态不好' }
];
const LEVELS = [
  { level: 1, label: '初识' }, { level: 2, label: '入门' }, { level: 3, label: '熟练' },
  { level: 4, label: '精通' }, { level: 5, label: '传授' }
];

const board = ref<Board | null>(null);
const readingBoard = ref<ShelfBoard | null>(null);
// V3.9：书里让我去做的事（阅读笔记打了 #行动）
const actionNotes = ref<ActionNote[]>([]);
const actionTotal = ref(0);
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

// ---------- V3.6：目前在读 / 主题学习（只读联动 + 快捷访问） ----------
// 两份数据、一个视图：书架在读书来自 md_reading，主题书单在读书来自 md_growth。
// 同一本书可能两边都在（主题书单的书也会进书架），按书名去重后以书架那条为准，
// 因为只有它带 id / filePath，能真的「继续读」。
function shortDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = function (n: number) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const allNowBooks = computed<NowBook[]>(function () {
  const out: NowBook[] = [];
  const seen: Record<string, boolean> = {};
  const shelf = readingBoard.value ? readingBoard.value.books : [];
  shelf.forEach(function (b) {
    if (b.status !== 'reading') return;
    seen[b.title.trim()] = true;
    const last = b.lastReadAt ? '最近读过 ' + shortDate(b.lastReadAt) : '书架 · 在读';
    const file = b.fileMissing ? ' · 原文件已移走'
      : (b.filePath ? ' · 已关联文件' : ' · 未关联文件');
    out.push({
      key: 'shelf-' + b.id, id: b.id, title: b.title, author: b.author,
      pct: b.pct, progressText: b.progressText, meta: last + file,
      canOpen: !!(b.filePath && !b.fileMissing), sortAt: b.lastReadAt || 0
    });
  });
  const themes = board.value ? board.value.themes : [];
  themes.forEach(function (t) {
    t.books.forEach(function (b) {
      if (b.status !== 'reading' || seen[b.title.trim()]) return;
      seen[b.title.trim()] = true;
      out.push({
        key: 'theme-' + t.id + '-' + b.id, id: b.id, title: b.title, author: b.author,
        pct: b.pct, progressText: b.progressText,
        meta: '主题书单 · ' + t.title + ' · 未关联文件',
        canOpen: false, sortAt: 0
      });
    });
  });
  return out.sort(function (a, b) { return (b.sortAt - a.sortAt) || (b.pct - a.pct); });
});
// 右栏只有 300px 宽、一屏高：各只铺前 3 条，剩下的给一句「还有 N 条」+ 跳图书馆，
// 保证「目前在读」和「主题学习」两张卡都能在首屏看见，不用先滚。
const NOW_LIMIT = 3;
const TOPIC_LIMIT = 3;
const nowBooks = computed<NowBook[]>(function () { return allNowBooks.value.slice(0, NOW_LIMIT); });
const nowMore = computed<number>(function () { return Math.max(0, allNowBooks.value.length - NOW_LIMIT); });
const themeRows = computed<ThemeRow[]>(function () {
  return board.value ? board.value.themes.slice(0, TOPIC_LIMIT) : [];
});
const themeMore = computed<number>(function () {
  return Math.max(0, (board.value ? board.value.themes.length : 0) - TOPIC_LIMIT);
});

function goReading(): void { emit('navigate', 'reading'); }
function openTheme(t: ThemeRow): void { emit('select-item', t.id); }
async function continueRead(b: NowBook): Promise<void> {
  if (!b.canOpen) {
    goReading();
    say('《' + b.title + '》还没关联本机文件，先去书架');
    return;
  }
  const r = await callDomain<{ ok: boolean; reason?: string } | null>('reading.readerOpen', null, b.id);
  if (!r || !r.ok) { say((r && r.reason) || '没能打开阅读窗'); return; }
  say('已翻开《' + b.title + '》');
}

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
// V3.9：错因勾选（跟着「记成绩」一起提交）与技能卡点 / 下次提高
const dCauses = ref<string[]>([]);
const dBlocker = ref('');
const dNextUp = ref('');

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
    // 最近一次作答的错因先勾上：多数时候是「补记」，不是从零填
    const last = e.attempts && e.attempts.length ? e.attempts[e.attempts.length - 1] : null;
    dCauses.value = last ? last.causes.slice() : [];
  } else if (skill.value) {
    const s = skill.value;
    dTitle.value = s.title;
    dLevel.value = s.level;
    dTarget.value = s.targetLevel;
    dNote.value = s.note || '';
    dBlocker.value = s.blocker || '';
    dNextUp.value = s.nextUp || '';
  } else if (theme.value) {
    dTitle.value = theme.value.title;
    dNote.value = theme.value.note || '';
  }
  syncedId.value = props.itemId;
}

async function load(): Promise<void> {
  loading.value = true;
  // V3.6：右栏同时读「学习库」与「图书馆」两份派生数据，并发一次取回，不多开通道
  // V3.9：第三路取「笔记里打了 #行动 的那些」，仍是已有路由 + 已有标签，零新增字段
  const [b, rb, an] = await Promise.all([
    callDomain<Board | null>('growth.board', null, localDate()),
    callDomain<ShelfBoard | null>('reading.board', null),
    callDomain<NoteBoard | null>('reading.notes', null, { tag: '行动' })
  ]);
  board.value = b;
  readingBoard.value = rb;
  actionNotes.value = an ? asArray<ActionNote>(an.items).slice(0, 3) : [];
  actionTotal.value = an ? an.total : 0;
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
  await callDomain('growth.setExamResult', null, exam.value.id, score, pass, dCauses.value);
  await afterChange(score >= pass ? '已记为通过（这次作答已存档）' : '已记为未通过，错因已记下');
}

// 只存错因：隔了几天才想明白「为什么没过」，不该为了补这一句重填分数
async function saveCausesOnly(): Promise<void> {
  if (!exam.value) return;
  if (!exam.value.attemptCount) { say('还没有成绩记录，先记一次分数'); return; }
  await callDomain('growth.setExamCauses', null, exam.value.id, dCauses.value);
  await afterChange(dCauses.value.length ? '错因已更新到最近一次作答' : '已清空最近一次作答的错因');
}

function toggleCause(key: string): void {
  const i = dCauses.value.indexOf(key);
  if (i >= 0) dCauses.value.splice(i, 1);
  else if (dCauses.value.length < 4) dCauses.value.push(key);
  else say('最多勾四条，圈太多等于没归因');
}

async function retake(): Promise<void> {
  if (!exam.value) return;
  await callDomain('growth.retakeExam', null, exam.value.id);
  dExamDate.value = '';
  dEnrollDate.value = '';
  dScore.value = '';
  dPassLine.value = '';
  dStatus.value = 'plan';
  // 新一轮重新归因：上次的错因留在历史里可查，但不该被默认带进下一次
  dCauses.value = [];
  await afterChange('已重置为备考中，科目进度归零；上次成绩与错因仍留在历史里');
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

// ---------- 技能：练习反馈（V3.9） ----------
async function saveBlocker(): Promise<void> {
  if (!skill.value) return;
  const text = dBlocker.value.trim();
  await callDomain('growth.setSkillBlocker', null, skill.value.id, text, localDate());
  await afterChange(text ? '卡点已记下——同一条不会重置天数' : '卡点已清空');
}
async function dropBlocker(): Promise<void> {
  if (!skill.value) return;
  if (!skill.value.blocker) { say('现在没有卡点可清'); return; }
  await callDomain('growth.clearSkillBlocker', null, skill.value.id, localDate());
  dBlocker.value = '';
  await afterChange('这条卡点已算过去，留档了');
}
async function saveNextUp(): Promise<void> {
  if (!skill.value) return;
  await callDomain('growth.setSkillNextUp', null, skill.value.id, dNextUp.value.trim());
  await afterChange(dNextUp.value.trim() ? '下次练的靶子已存' : '已清空「下次提高」');
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

        <!-- V3.9 错因归类：分数只说明「没过」，错因才说明「下一步练什么」 -->
        <span class="gc-label">这次错在哪（最多四条，归类才看得出规律）</span>
        <div class="gc-causes">
          <button
            v-for="c in EXAM_CAUSES"
            :key="c.key"
            class="gc-cause"
            :class="{ 'gc-cause-on': dCauses.indexOf(c.key) >= 0 }"
            :aria-pressed="dCauses.indexOf(c.key) >= 0"
            @click="toggleCause(c.key)"
          >{{ c.label }}</button>
        </div>
        <div class="gc-add">
          <button class="gc-btn" @click="saveCausesOnly">只存错因</button>
          <span v-if="exam.causeTop.length" class="gc-hint">
            历次最常错：{{ exam.causeTop[0].label }}（{{ exam.causeTop[0].count }} 次）
          </span>
        </div>
        <div v-if="exam.attemptCount" class="gc-list">
          <div v-for="a in exam.attempts.slice(-2).reverse()" :key="a.id" class="gc-item">
            <span class="gc-item-main">{{ a.date || '未记日期' }} · {{ a.score }} / {{ a.passLine }}</span>
            <span class="gc-item-side" :class="{ 'gc-warn': !a.passed }">
              {{ a.passed ? '通过' : (a.gap ? '差 ' + Math.abs(a.gap) + ' 分' : '未通过') }}
            </span>
          </div>
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

        <!-- V3.9 练习反馈：练了多少是投入，「卡在哪 / 卡了多久」才是反馈。
             刻意练习的前提是每次都盯着一个具体弱点，而不是把时长堆上去。 -->
        <span class="gc-label">
          练习卡点
          <span v-if="skill.blocker" class="gc-age" :class="{ 'gc-age-warn': skill.stuck }">{{ skill.blockerText }}</span>
        </span>
        <div class="gc-add">
          <input
            v-model="dBlocker" class="gc-in gc-wide" maxlength="60"
            placeholder="如：看不懂 groupby 的返回结构" aria-label="当前卡点"
            @keydown.enter.prevent="saveBlocker"
          />
          <button class="gc-btn" @click="saveBlocker">记下</button>
          <button v-if="skill.blocker" class="gc-btn" @click="dropBlocker">已过去</button>
        </div>
        <p v-if="skill.stuck" class="gc-stuck">
          卡了 {{ skill.blockerDays }} 天还没下走 —— 练得少是加时间，卡住是换方法：拆小一号、找人看一次、换份材料。
        </p>
        <p v-else-if="skill.clearedCount" class="ctx-muted">
          已经过去 {{ skill.clearedCount }} 条卡点，最近一条：{{ skill.clearedRecent[0].text }}
        </p>

        <label class="gc-label" for="gc-next">下次练，提高一点什么</label>
        <div class="gc-add">
          <input
            id="gc-next" v-model="dNextUp" class="gc-in" maxlength="60"
            placeholder="如：手写一遍三种聚合的差别" aria-label="下次提高一点什么"
            @keydown.enter.prevent="saveNextUp"
          />
          <button class="gc-btn" @click="saveNextUp">存</button>
        </div>

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

    <!-- V3.6 ① 目前在读的图书：书架 + 主题书单两源合并，进度 / 最近在读 / 继续读 -->
    <section class="ctx-card gc-now" aria-label="目前在读的图书">
      <h2 class="ctx-title">目前在读<span class="ctx-tag">{{ allNowBooks.length }} 本</span></h2>
      <div class="gc-now-list">
        <div v-for="b in nowBooks" :key="b.key" class="gc-now-row">
          <div class="gc-now-top">
            <span class="gc-now-title" :title="b.title">《{{ b.title }}》</span>
            <span class="gc-now-pct">{{ b.pct }}%</span>
          </div>
          <span class="gc-bar"><i :style="{ width: b.pct + '%' }"></i></span>
          <div class="gc-now-foot">
            <span class="gc-now-meta">{{ b.progressText }} · {{ b.meta }}</span>
            <button class="gc-now-go" @click="continueRead(b)">{{ b.canOpen ? '继续读 →' : '去书架关联 →' }}</button>
          </div>
        </div>
        <p v-if="!allNowBooks.length" class="ctx-muted">
          还没有在读的书。去图书馆把一本标成「在读」，这里就会跟着走。
        </p>
        <p v-if="nowMore" class="ctx-muted">还有 {{ nowMore }} 本在读书，去书架看全。</p>
      </div>
      <div class="ctx-links gc-now-links">
        <button class="ctx-link" @click="goReading">图书馆 →</button>
        <button class="ctx-link" @click="emit('navigate', 'inspire')">语料库 →</button>
      </div>
    </section>

    <!-- V3.6 ② 主题学习：进度 / 书单 / 摘录，点一行即选中中栏与右栏详情 -->
    <section class="ctx-card gc-topic" aria-label="主题学习状态">
      <h2 class="ctx-title">主题学习<span class="ctx-tag">{{ board ? board.themes.length : 0 }} 个</span></h2>
      <div class="gc-topic-list">
        <button
          v-for="t in themeRows"
          :key="t.id"
          class="gc-topic-row"
          :class="{ 'gc-topic-on': t.id === itemId }"
          :aria-label="'查看主题 ' + t.title"
          @click="openTheme(t)"
        >
          <span class="gc-topic-top">
            <span class="gc-topic-title">{{ t.title }}</span>
            <span class="gc-now-pct">{{ t.pct }}%</span>
          </span>
          <span class="gc-bar"><i :style="{ width: t.pct + '%' }"></i></span>
          <span class="gc-now-meta">{{ t.bookText }} · 在读 {{ t.readingCount }} · 摘录 {{ t.quoteTotal }} 条</span>
          <span v-if="t.currentTitle" class="gc-now-meta">正在读《{{ t.currentTitle }}》</span>
        </button>
        <p v-if="!themeRows.length" class="ctx-muted">
          还没有主题。在中栏「主题阅读」里建一个，书单进度会同步到这里。
        </p>
        <p v-if="themeMore" class="ctx-muted">还有 {{ themeMore }} 个主题，在中栏看全部。</p>
      </div>
    </section>

    <!-- V3.9 阅读里的行动：书里打了 #行动 的笔记回显到这里。
         零新增字段——阅读笔记本来就有标签，缺的只是「打了个标签没人看」的回显。 -->
    <section class="ctx-card gc-act" aria-label="阅读里的行动">
      <h2 class="ctx-title">阅读里的行动<span class="ctx-tag">{{ actionTotal }} 条</span></h2>
      <div class="gc-now-list">
        <button
          v-for="n in actionNotes"
          :key="n.id"
          class="gc-act-row"
          :aria-label="'查看《' + n.bookTitle + '》的这条行动'"
          @click="emit('navigate', 'reading')"
        >
          <span class="gc-act-main">{{ n.text || n.quote }}</span>
          <span class="gc-now-meta">《{{ n.bookTitle }}》<template v-if="n.page"> · p.{{ n.page }}</template></span>
        </button>
        <p v-if="!actionNotes.length" class="ctx-muted">
          还没有。在图书馆给一条笔记打 #行动 标签，书里要求你做的事就会列在这里。
        </p>
        <p v-if="actionTotal > actionNotes.length" class="ctx-muted">
          还有 {{ actionTotal - actionNotes.length }} 条，去图书馆看全。
        </p>
      </div>
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
      <p v-if="board && board.stats.skillBlocked" class="ctx-muted">
        卡点 {{ board.stats.skillBlocked }} 项<template v-if="board.stats.skillStuck">，其中挂超 {{ board.blockerStaleDays }} 天 {{ board.stats.skillStuck }} 项</template>
      </p>
      <p v-if="board && board.stats.examAttempts" class="ctx-muted">
        考过 {{ board.stats.examAttempts }} 次，未过 {{ board.stats.examFails }} 次<template v-if="board.causeTop.length">，最常错「{{ board.causeTop[0].label }}」</template>
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
.gc-label { display: block; margin: 6px 0 2px; font-size: var(--text-xs); color: var(--surface-muted); }
.gc-count { margin: 0 0 4px; font-size: var(--text-xs); line-height: 1.6; color: var(--palette-primary); }
.gc-in {
  width: 100%; padding: 5px 8px; font-size: var(--text-sm); box-sizing: border-box;
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
  padding: 4px 10px; font-size: var(--text-xs); border: 0.5px solid var(--surface-border);
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
  background: var(--surface-panel); font-size: var(--text-xs);
}
.gc-item-main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-item-side { flex: 0 0 auto; font-size: var(--text-xs); color: var(--surface-muted); }
.gc-done { text-decoration: line-through; color: var(--surface-muted); }
.gc-check { border: 0; background: transparent; color: var(--palette-primary); font-size: var(--text-xs); padding: 0 2px; }
.gc-mini {
  flex: 0 0 auto; padding: 1px 6px; font-size: var(--text-xs);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); color: var(--surface-muted);
}
.gc-x { flex: 0 0 auto; border: 0; background: transparent; color: var(--surface-muted); font-size: var(--text-xs); }
.gc-book { flex-wrap: wrap; }
.gc-book-on { border-color: var(--palette-primary); background: var(--palette-soft); }
.gc-book-title {
  flex: 1 1 100%; min-width: 0; text-align: left; border: 0; background: transparent;
  font-size: var(--text-xs); padding: 0; color: var(--surface-text);
}
.gc-quote {
  display: flex; align-items: baseline; gap: 6px; padding: 4px 6px;
  border-left: 2px solid var(--palette-border); background: var(--surface-panel);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: var(--text-xs); line-height: 1.6;
}
.gc-quote-text { flex: 1; min-width: 0; }
.gc-ready { margin: 4px 0 0; font-size: var(--text-xs); color: var(--palette-primary); }
.gc-alert-on { border-color: var(--palette-primary); background: var(--palette-soft); }
/* V3.6：在读书 / 主题学习两卡。300px 右栏里每行压到 3 层：标题+百分比 / 进度条 / 状态与去处 */
.gc-now-list, .gc-topic-list { display: flex; flex-direction: column; gap: 6px; }
.gc-now-row, .gc-topic-row {
  display: block; width: 100%; box-sizing: border-box; padding: 6px 8px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel); text-align: left;
}
.gc-topic-row { cursor: pointer; }
.gc-topic-row:hover { border-color: var(--palette-border); }
.gc-topic-on { border-color: var(--palette-primary); background: var(--palette-soft); }
.gc-now-top, .gc-topic-top { display: flex; align-items: baseline; gap: 6px; }
.gc-now-title, .gc-topic-title {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--text-sm); color: var(--surface-text);
}
.gc-now-pct { flex: 0 0 auto; font-size: var(--text-xs); color: var(--palette-primary); }
.gc-bar {
  display: block; height: 5px; margin: 5px 0 3px; border-radius: 999px;
  background: var(--palette-soft); overflow: hidden;
}
.gc-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--palette-primary); }
.gc-now-foot { display: flex; align-items: center; gap: 6px; }
.gc-now-meta {
  flex: 1; min-width: 0; display: block; margin: 0;
  font-size: var(--text-xs); line-height: 1.5; color: var(--surface-muted);
}
.gc-now-go {
  flex: 0 0 auto; padding: 2px 8px; font-size: var(--text-xs);
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); color: var(--palette-primary); cursor: pointer;
}
.gc-now-go:hover { border-color: var(--palette-border); }
.gc-now-links { margin-top: 8px; }
.gc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
/* V3.9 练习反馈：错因 chips / 卡点年龄 / 阅读行动 */
/* 四列等宽网格而不是 flex 换行：7 个标签换行会参差不齐，且行数不可控；
   四列正好两行，300px 下每格约 66px，四个汉字放得下 */
.gc-causes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin-top: 2px; }
.gc-cause {
  padding: 3px 2px; font-size: var(--text-xs); border-radius: var(--radius-sm);
  border: 0.5px solid var(--surface-border); background: var(--surface-panel);
  color: var(--surface-muted); cursor: pointer; white-space: nowrap;
}
.gc-cause:hover { border-color: var(--palette-border); }
.gc-cause-on { background: var(--state-warn-soft); color: var(--state-warn); border-color: var(--state-warn); }
.gc-hint { flex: 1 1 auto; font-size: var(--text-xs); color: var(--surface-muted); align-self: center; }
.gc-warn { color: var(--state-warn); }
/* 卡点输入框独占一行：一句话要写清「卡在哪」，挤在 110px 里等于逼人缩写。
   必须写成 .gc-add .gc-wide——上面那条 .gc-add .gc-in 是双类选择器，单类盖不住它 */
.gc-add .gc-wide { flex: 1 1 100%; }
/* 卡点年龄：默认是中性灰，超过两周才变警告色——不是一卡就报警，那会让卡点变成噪音 */
.gc-age {
  margin-left: 6px; padding: 0 5px; border-radius: 999px;
  background: var(--surface-panel); color: var(--surface-muted); font-size: var(--text-xs);
}
.gc-age-warn { background: var(--state-warn-soft); color: var(--state-warn); }
.gc-stuck {
  margin: 4px 0 0; padding: 5px 7px; border-radius: var(--radius-sm);
  background: var(--state-warn-soft); color: var(--state-warn);
  font-size: var(--text-xs); line-height: 1.6;
}
.gc-act-row {
  display: block; width: 100%; box-sizing: border-box; padding: 5px 8px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-panel); text-align: left; cursor: pointer;
}
.gc-act-row:hover { border-color: var(--palette-border); background: var(--palette-soft); }
.gc-act-main {
  font-size: var(--text-sm); color: var(--surface-text); line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.gc-msg {
  padding: 6px 8px; border-radius: var(--radius-sm);
  background: var(--palette-soft); color: var(--palette-primary); font-size: var(--text-xs);
}
</style>
