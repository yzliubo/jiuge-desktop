'use strict';

// ---- 参数与全局状态 ----
const params = new URLSearchParams(location.search);
const BOOK_ID = params.get('bookId') || '';
const MODE = params.get('mode') || 'leisure';

let BOOK = null;
let META = null;
let SRC = null;
let TODAY = '';
let chapterCount = 1;
let currentIndex = 0;
let noteFilter = 'chapter';
let debounceTimer = null;
// V2.6 R1/R2 新增状态
let leftTab = 'toc';
let noteStyleFilter = '';
let chapterNotes = [];
let bookmarks = [];
let selCache = null;
let pendingRatio = null;
let scrollTimer = null;
let iframeReady = false;

const PREF_KEY = 'jiuge-reader-pref';
const CHAPTER_KEY = 'jiuge-reader-chapter:';
let pref = {
  font: 18, line: 1.8, theme: 'paper', zoom: 1,
  leftWidth: 260, rightWidth: 340, typeface: 'mixed',
  margin: 'mid', para: 'normal', punct: false
};

// 版心三档：窄边＝版心更宽（行更长），宽边＝版心更窄（行更短，长文更省眼）。
// 值 = { 正文最大宽度, 左右留白, 上留白 }
const MARGIN_PRESET = {
  narrow: { max: 880, x: 18, y: 20 },
  mid: { max: 720, x: 30, y: 24 },
  wide: { max: 600, x: 64, y: 28 }
};
// 段距三档：中文书式排版靠缩进分段（0），屏读可 0.5–1em。
const PARA_GAP = { tight: '0', normal: '.55em', loose: '1em' };

// 阅读时长：只在本机记，按书累计（localStorage，不进 md_reading——它不需要同步也不该占 WAL）。
// 本次 = 这个窗口打开后累计的秒数；累计 = 这本书历次阅读之和。
const TIME_KEY = 'jiuge-reader-time:';
let sessionStart = Date.now();
let bookSeconds = 0;
let timeTimer = null;

// ---- 提示语文案包（docs/16 §3 T7）----
// 红线（§2.3）：只陈述事实，不做夸奖——发糖式的夸奖词一个都不许出现，
// 静态门禁会扫这段源码（连注释都算），所以这里不把那些词写出来；
// 同一阶段也不连续重复同一条（lastPhrase 记上次下标）。
const PHRASES = {
  start: [
    '先读完第一章，好书都在后面藏着',
    '今天只需要读完这一章',
    '开头慢一点没关系，读进去就顺了'
  ],
  middle: [
    '过半的路，每一步都算数',
    '这本书你已经啃掉一半了',
    '读到这儿，剩下的会越来越快'
  ],
  end: [
    '只剩最后一章了，一鼓作气',
    '最后几步，别停在这儿',
    '今晚就能和这本书说再见'
  ],
  relay: [
    '下一章〈{t}〉，要继续吗？',
    '停在这里也没关系，进度已记下',
    '要不要再读一章？'
  ]
};
const lastPhrase = { start: -1, middle: -1, end: -1, relay: -1 };

function phraseOf(stage) {
  const list = PHRASES[stage] || PHRASES.middle;
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && i === lastPhrase[stage]) i = (i + 1) % list.length;
  lastPhrase[stage] = i;
  return list[i];
}

// 三档：前两章算开头，剩两章算尾段，其余中段（尾段文案最密集，完读率最后一公里）
function stageOf(index, total) {
  const t = Math.max(0, Number(total) || 0);
  const i = Math.max(0, Number(index) || 0);
  if (t >= 3 && t - i <= 2) return 'end';
  if (i < 2) return 'start';
  return 'middle';
}

const THEME_LABELS = { paper: '纸色', eye: '护眼', night: '夜间' };
const IFRAME_THEMES = {
  paper: { bg: '#ffffff', fg: '#2f2b26' },
  eye: { bg: '#eef4e8', fg: '#2f3a2a' },
  night: { bg: '#1f2328', fg: '#e7e2d8' }
};
const CELL_LABELS = { free: '自由记录', growth: '学习成长', work: '工作推进' };

const DEFAULT_META = {
  modes: [],
  modeLabel: {},
  noteTypes: ['highlight', 'note', 'idea', 'link'],
  noteTypeLabel: { highlight: '摘录', note: '笔记', idea: '想法', link: '关联' },
  prompts: [
    { type: 'idea', label: '这段让我想到什么' },
    { type: 'link', label: '它和哪本书连得上' },
    { type: 'note', label: '我能拿它做什么' }
  ],
  limits: {}
};

// ---- DOM 引用 ----
const appEl = document.getElementById('rrApp');
const bookTitleEl = document.getElementById('rrBookTitle');
const badgeEl = document.getElementById('rrBadge');
const chapterTitleEl = document.getElementById('rrChapterTitle');
const posEl = document.getElementById('rrPos');
const prevBtn = document.getElementById('rrPrev');
const nextBtn = document.getElementById('rrNext');
const fontMinusBtn = document.getElementById('rrFontMinus');
const fontPlusBtn = document.getElementById('rrFontPlus');
const themeBtn = document.getElementById('rrTheme');
const syncBtn = document.getElementById('rrProgressSync');
const progressTextEl = document.getElementById('rrProgressText');
const coverEl = document.getElementById('rrCover');
const bookMetaEl = document.getElementById('rrBookMeta');
const tocEl = document.getElementById('rrToc');
const lineBtn = document.getElementById('rrLine');
const quotePickBtn = document.getElementById('rrQuotePick');
const iframe = document.getElementById('rrPage');
const unsupportedEl = document.getElementById('rrUnsupported');
const askEl = document.getElementById('rrAsk');
const askHead = document.getElementById('rrAskHead');
const askTitle = document.getElementById('rrAskTitle');
const askQ = document.getElementById('rrAskQ');
const askHint = document.getElementById('rrAskHint');
const askInput = document.getElementById('rrAskInput');
const askChoice = document.getElementById('rrAskChoice');
const askSaveBtn = document.getElementById('rrAskSave');
const askSkipBtn = document.getElementById('rrAskSkip');
const askPickBtn = document.getElementById('rrAskPick');
const askFoldBtn = document.getElementById('rrAskFold');
const askCloseBtn = document.getElementById('rrAskClose');
const askOpenBtn = document.getElementById('rrAskOpen');
const askQuoteEl = document.getElementById('rrAskQuote');
const askQuoteText = document.getElementById('rrAskQuoteText');
const askQuoteClearBtn = document.getElementById('rrAskQuoteClear');
const endCardEl = document.getElementById('rrEndCard');
const endCardH = document.getElementById('rrEndCardH');
const endCardM = document.getElementById('rrEndCardM');
const endCardQ = document.getElementById('rrEndCardQ');
const endCardIn = document.getElementById('rrEndCardIn');
const endCardInput = document.getElementById('rrEndCardInput');
const endNextBtn = document.getElementById('rrEndNext');
const timeEl = document.getElementById('rrTime');
// 右栏已改为三阶九问：没有「类型」下拉、没有自由表单，答案一律走九问入口
const flashText = document.getElementById('rrFlashText');
const flashCell = document.getElementById('rrFlashCell');
const flashBtn = document.getElementById('rrFlash');
const filterEl = document.getElementById('rrNoteFilter');
const noteList = document.getElementById('rrNoteList');
const q9Tabs = document.getElementById('rrQ9Tabs');
const q9List = document.getElementById('rrQ9List');
// 底栏同时承载进度与状态：状态语只写进 #rrStatusMsg，别把按钮和进度一起覆盖掉
const statusEl = document.getElementById('rrStatusMsg');
// V2.6 新增 DOM
const tabToc = document.getElementById('rrTabToc');
const tabMark = document.getElementById('rrTabMark');
const paneToc = document.getElementById('rrPaneToc');
const paneMark = document.getElementById('rrPaneMark');
const bmAdd = document.getElementById('rrBmAdd');
const bmList = document.getElementById('rrBmList');
const hlGroup = document.getElementById('rrHlGroup');
const underlineBtn = document.getElementById('rrUnderline');
const strikeBtn = document.getElementById('rrStrike');
const zoomInBtn = document.getElementById('rrZoomIn');
const zoomOutBtn = document.getElementById('rrZoomOut');
const zoomTextEl = document.getElementById('rrZoomText');
const typefaceSel = document.getElementById('rrTypeface');
const marginSel = document.getElementById('rrMargin');
const paraSel = document.getElementById('rrPara');
const punctBtn = document.getElementById('rrPunct');
const resumeEl = document.getElementById('rrResume');
const resumeTextEl = document.getElementById('rrResumeText');
const resumeGoBtn = document.getElementById('rrResumeGo');
const resumeXBtn = document.getElementById('rrResumeX');
const searchInput = document.getElementById('rrSearchInput');
const searchBtn = document.getElementById('rrSearchBtn');
const searchCountEl = document.getElementById('rrSearchCount');
const hitsEl = document.getElementById('rrSearchHits');
const stageEl = document.getElementById('rrStage');
const selBar = document.getElementById('rrSelBar');
const styleFilterEl = document.getElementById('rrStyleFilter');
const divLeft = document.getElementById('rrDivLeft');
const divRight = document.getElementById('rrDivRight');

// ---- 通用小工具 ----
function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

function showError(e) {
  let msg = '未知错误';
  if (e && e.message) msg = e.message;
  else if (typeof e === 'string') msg = e;
  setStatus('操作失败：' + msg);
}

async function safeRun(fn) {
  try { await fn(); } catch (e) { showError(e); }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function todayStr() {
  const d = new Date();
  function p(x) { return x < 10 ? '0' + x : '' + x; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fmtTime(t) {
  if (t === undefined || t === null || t === '') return '';
  const d = new Date(t);
  if (isNaN(d.getTime())) return String(t);
  function p(x) { return x < 10 ? '0' + x : '' + x; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---- 与主进程通信的唯一入口 ----
async function domain(name, args) {
  const res = await window.jiugeBridge.invoke('v1/domain:call', { name: name, args: args });
  if (!res || res.code !== 'OK') throw new Error((res && res.message) || (name + ' 调用失败'));
  return res.data;
}

async function emptyRecord(date) {
  const res = await window.jiugeBridge.invoke('v1/domain:call', { name: 'emptyRecord', args: [date] });
  if (!res || res.code !== 'OK') throw new Error((res && res.message) || '空白日记生成失败');
  return res.data;
}

// ---- 九格回写口径 ----
function safeCell(cell) { return cell === 'leisure' ? 'free' : cell; }

function cellFor(n) { return n.mode === 'theme' ? 'growth' : 'free'; }

async function appendLine(cell, line) {
  const target = safeCell(cell);
  const res = await window.jiugeBridge.invoke('v1/diaries:list', { pageSize: 500 });
  if (!res || res.code !== 'OK') throw new Error((res && res.message) || '日记列表读取失败');
  let base = ((res.data && res.data.items) || []).find(r => r.date === TODAY);
  base = base ? JSON.parse(JSON.stringify(base)) : await emptyRecord(TODAY);
  base.date = TODAY;
  if (!base.cells) base.cells = {};
  const old = base.cells[target] || '';
  base.cells[target] = old ? old + '\n' + line : line;
  const up = await window.jiugeBridge.invoke('v1/diaries:upsert', {
    record: base,
    requestId: 'reader-' + target + '-' + Date.now()
  });
  if (!up || up.code !== 'OK') throw new Error((up && up.message) || '九格回写失败');
  return target;
}

function cellLabel(c) { return CELL_LABELS[c] || '自由记录'; }

// ---- 偏好 ----
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      if (typeof o.font === 'number') pref.font = clamp(o.font, 14, 24);
      if (typeof o.line === 'number') pref.line = clamp(o.line, 1.5, 2.2);
      if (o.theme === 'paper' || o.theme === 'eye' || o.theme === 'night') pref.theme = o.theme;
      if (typeof o.zoom === 'number') pref.zoom = clamp(o.zoom, 0.8, 1.5);
      if (typeof o.leftWidth === 'number') pref.leftWidth = clamp(o.leftWidth, 200, 360);
      if (typeof o.rightWidth === 'number') pref.rightWidth = clamp(o.rightWidth, 300, 460);
      if (['mixed', 'serif', 'sans', 'kai'].indexOf(o.typeface) >= 0) pref.typeface = o.typeface;
      if (MARGIN_PRESET[o.margin]) pref.margin = o.margin;
      if (PARA_GAP[o.para]) pref.para = o.para;
      if (typeof o.punct === 'boolean') pref.punct = o.punct;
    }
  } catch (e) {}
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch (e) {}
}
function readChapterPref() {
  try {
    const v = localStorage.getItem(CHAPTER_KEY + BOOK_ID);
    if (v === null || v === '') return 0;
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  } catch (e) { return 0; }
}
function saveChapterPref(idx) {
  try { localStorage.setItem(CHAPTER_KEY + BOOK_ID, String(idx)); } catch (e) {}
}

// ---- 渲染：顶栏 / 左栏 / 目录 ----
// 已读章数。注意口径：休闲书登记时的 book.done 是「页数」（默认 100），
// 直接拿它当章数会排出「已读 0 / 100 章」这种假进度——旧版就差在这里。
// 只有当 done 落在章数范围内（说明它确实是章口径）才采信，否则以「读到第几章」为准。
function doneChapters() {
  const t = Math.max(0, Number(chapterCount) || 0);
  const raw = Number(BOOK && BOOK.done) || 0;
  const fromBook = (t > 0 && raw <= t) ? raw : 0;
  // 当前章读到 95% 以上就算这一章读完了——否则滚到底还显示「已读 0 章」，
  // 这正是完读率漏斗里最伤人的那种假进度。
  const here = chapterPct() >= 95 ? currentIndex + 1 : currentIndex;
  return clamp(Math.max(fromBook, here), 0, t);
}

// 全书百分比：按「已读章数 / 总章数」，与进度行同一口径
function bookPct() {
  const t = Math.max(0, Number(chapterCount) || 0);
  if (t < 1) return 0;
  return clamp(Math.round(doneChapters() / t * 100), 0, 100);
}

// 本章百分比：跟着滚动实时算；内容不足一屏时直接算 100%（这一章确实看完了）
function chapterPct() {
  try {
    const d = iframe.contentDocument;
    const w = iframe.contentWindow;
    if (!d || !w) return 0;
    const max = d.documentElement.scrollHeight - w.innerHeight;
    if (max <= 4) return 100;
    return clamp(Math.round(w.scrollY / max * 100), 0, 100);
  } catch (e) { return 0; }
}

// 进度三件套：章进度 + 全书百分比 + 本章百分比（docs/16 §3 T2）
function fmtDuration(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  if (m < 60) return m + ' 分';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? (h + ' 小时 ' + rest + ' 分') : (h + ' 小时');
}

function renderTime() {
  if (!timeEl) return;
  const cur = Math.max(0, Math.floor((Date.now() - sessionStart) / 1000));
  timeEl.textContent = '本次 ' + fmtDuration(cur) + ' · 累计 ' + fmtDuration(bookSeconds + cur);
}

// 把本次时长结算进累计并落盘；每 15 秒一次，关窗前再冲一次，避免一次性猛加
function flushTime() {
  const cur = Math.max(0, Math.floor((Date.now() - sessionStart) / 1000));
  if (cur <= 0) return;
  bookSeconds += cur;
  sessionStart = Date.now();
  try { localStorage.setItem(TIME_KEY + BOOK_ID, String(bookSeconds)); } catch (e) {}
}

function loadTime() {
  try { bookSeconds = Math.max(0, Number(localStorage.getItem(TIME_KEY + BOOK_ID)) || 0); } catch (e) { bookSeconds = 0; }
  sessionStart = Date.now();
  renderTime();
}

function startTime() {
  loadTime();
  if (timeTimer) clearInterval(timeTimer);
  timeTimer = setInterval(function () { flushTime(); renderTime(); }, 15000);
  window.addEventListener('beforeunload', flushTime);
}

function progressLine() {
  const t = Math.max(0, Number(chapterCount) || 0);
  return '已读 ' + doneChapters() + ' / ' + t + ' 章 · 全书 ' + bookPct() + '% · 本章 ' + chapterPct() + '%';
}

function setProgressText(done, total) {
  if (!progressTextEl) return;
  if (done !== undefined && done !== null && done !== '') BOOK.done = done;
  if (total !== undefined && total !== null && total !== '') BOOK.total = total;
  progressTextEl.textContent = progressLine();
}

function updateProgress() {
  if (!progressTextEl) return;
  const txt = progressLine();
  if (progressTextEl.textContent !== txt) progressTextEl.textContent = txt;
  maybeShowEndCard();
}

// ---- T1 续读引导条：打开时一条、5 秒淡出、用完即走 ----
let resumeTimer = null;

function hideResume() {
  if (!resumeEl) return;
  resumeEl.classList.remove('rr-show');
  setTimeout(function () { if (resumeEl) resumeEl.hidden = true; }, 500);
}

function showResumeBar(pos) {
  if (!resumeEl || !resumeTextEl || !pos) return;
  // 上次停在第 0 章最顶端等于没读过，别硬凑一句「上次读到」
  if (!pos.chapter && !(pos.ratio > 0.02)) return;
  const title = chapterTitleAt(pos.chapter);
  const total = Math.max(1, chapterCount || 1);
  const pct = clamp(Math.round((Math.max(0, pos.chapter) + clamp(pos.ratio, 0, 1)) / total * 100), 0, 99);
  // 目录里本来就带「第 X 章」时不再重复一次，免得出现「第 1 章〈第一章 水管〉」
  const where = title ? ('第 ' + (pos.chapter + 1) + ' 章〈' + title.replace(/^第[一二三四五六七八九十百零〇\d]+[章节]\s*/, '') + '〉')
    : ('第 ' + (pos.chapter + 1) + ' 章');
  let txt = '上次读到' + where + ' · 全书 ' + pct + '%';
  if (pos.ts) {
    const days = Math.floor((Date.now() - pos.ts) / 86400000);
    if (days >= 1) txt += ' · 距上次 ' + days + ' 天';
    if (days >= 7) txt += ' · 这本书在等你回来';
  }
  resumeTextEl.textContent = txt;
  resumeEl.hidden = false;
  setTimeout(function () { if (resumeEl) resumeEl.classList.add('rr-show'); }, 20);
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(hideResume, 5000);
}

// ---- T3 章末轻卡：滚到底部才出现，切章即消失，不点也没关系 ----
let endCardShown = false;
let chapterEnteredAt = Date.now();
let endCardTimer = null;
let endCardHideTimer = null;

// 一屏就到底的章节：scroll 永远不会触发，靠 chapterPct 直接判 100%。
// 但刚切过来就弹「本章读完」太急，给它一点停留时间再判定。
function isShortChapter() {
  try {
    const d = iframe.contentDocument;
    const w = iframe.contentWindow;
    if (!d || !w) return false;
    return (d.documentElement.scrollHeight - w.innerHeight) <= 4;
  } catch (e) { return false; }
}

function chapterTitleAt(i) {
  const toc = (SRC && SRC.toc) || [];
  for (let k = 0; k < toc.length; k++) {
    if (Number(toc[k].index) === Number(i)) return toc[k].title || '';
  }
  return '';
}

// 章末卡现在挂在父窗口顶部（不进正文流）：正文 DOM 一字不动，
// 字号小、浅灰、半透明，读完扫一眼就能忽略，不打断阅读。
function renderEndCard() {
  const isLast = currentIndex >= chapterCount - 1;
  const got = chapterNotes.length;
  if (endCardH) {
    endCardH.textContent = isLast
      ? '这本书读完了 · 全书 ' + bookPct() + '%'
      : '本章读完 · 全书 ' + bookPct() + '%（' + doneChapters() + ' / ' + Math.max(0, chapterCount) + ' 章）';
  }
  if (endCardM) {
    endCardM.textContent = got > 0
      ? '这一章摘了 ' + got + ' 句 · 都留在读书笔记里'
      : '这一章还没摘句子 · 划选一句就存下来';
  }
  if (endCardQ) {
    const nextTitle = chapterTitleAt(currentIndex + 1);
    endCardQ.textContent = isLast
      ? '整本读完了，这本书现在留在你的读书笔记里。'
      : phraseOf('relay').replace('{t}', nextTitle || ('第 ' + (currentIndex + 2) + ' 章'));
  }
  if (endNextBtn) endNextBtn.hidden = isLast;
  if (endCardIn) endCardIn.hidden = true;
  if (endCardInput) endCardInput.value = '';
}

function maybeShowEndCard() {
  if (!iframeReady || endCardShown) return;
  if (!SRC || SRC.supported === false) return;
  // 封面 / 版权页 / 目录：读完一屏也不弹「本章读完」，那不是一章正文
  if (isFrontMatter(currentIndex)) return;
  if (chapterPct() < 95) return;
  if (isShortChapter() && Date.now() - chapterEnteredAt < 1800) {
    if (!endCardTimer) {
      endCardTimer = setTimeout(function () { endCardTimer = null; updateProgress(); }, 1900);
    }
    return;
  }
  showEndCard();
}

// 贴正文上部：位置与宽度按中栏实测算，绝不横跨整个窗口（否则侧栏也被压住，
// 而且文字短时右边会空一大片）
function positionEndCard() {
  if (!endCardEl) return;
  // 用正文容器（iframe 那一块）而不是 .rr-main：后者连工具栏一起算，卡片会压住工具栏
  const stage = document.getElementById('rrStage') || document.querySelector('.rr-main');
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  const w = Math.max(260, Math.min(360, Math.round(r.width - 32)));
  endCardEl.style.width = w + 'px';
  endCardEl.style.left = Math.round(r.left + 14) + 'px';
  endCardEl.style.top = Math.round(r.top + 8) + 'px';
}

function showEndCard() {
  if (!endCardEl || endCardShown) return;
  endCardShown = true;
  renderEndCard();
  positionEndCard();
  endCardEl.hidden = false;
  setTimeout(function () { if (endCardEl) endCardEl.classList.add('rr-show'); }, 20);
  // 浮层只为「扫一眼」，10 秒后自己收走：不点也不留，绝不长期占着正文上方
  if (endCardHideTimer) clearTimeout(endCardHideTimer);
  endCardHideTimer = setTimeout(function () {
    if (document.activeElement === endCardInput) return;   // 正在写感想就别收
    hideEndCard();
  }, 10000);
}

function hideEndCard() {
  if (endCardHideTimer) { clearTimeout(endCardHideTimer); endCardHideTimer = null; }
  if (!endCardEl) return;
  endCardEl.classList.remove('rr-show');
  endCardEl.hidden = true;
  if (endCardIn) endCardIn.hidden = true;
}

// 章末「写一句感想」：走现有笔记 + 九格回写通道，不另开一条写路径
async function saveEndNote(input) {
  const text = String((input && input.value) || '').trim();
  if (!text) { setStatus('先写一句，再存进九格'); return; }
  const patch = {
    mode: (BOOK && BOOK.mode) || MODE,
    bookId: BOOK_ID,
    themeId: (BOOK && BOOK.themeId) || '',
    bookTitle: (BOOK && BOOK.bookTitle) || (BOOK && BOOK.title) || '',
    type: 'note',
    quote: '',
    text: text,
    page: 0,
    tags: ['章末'],
    chapterId: 'ch-' + currentIndex,
    anchor: '',
    color: '',
    style: ''
  };
  await domain('reading.addNote', [patch]);
  const q = await domain('reading.notes', [{ bookId: BOOK_ID, keyword: text }]);
  const fresh = (q && q.items && q.items[0]) || null;
  if (input) input.value = '';
  if (fresh) await pushNote(fresh);
  await refreshNotes();
  setStatus('已写进读书笔记，并追加到九格');
}

function onEndCardClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  if (act === 'next') {
    hideEndCard();
    hideResume();
    safeRun(function () { return loadChapter(currentIndex + 1); });
    return;
  }
  if (act === 'note') {
    if (!endCardIn) return;
    endCardIn.hidden = false;
    if (endCardInput) { try { endCardInput.focus(); } catch (err) {} }
    return;
  }
  if (act === 'save') {
    safeRun(function () { return saveEndNote(endCardInput); });
  }
}

function renderLeft() {
  if (coverEl) {
    clear(coverEl);
    if (BOOK.cover) {
      const img = document.createElement('img');
      img.src = BOOK.cover;
      img.alt = BOOK.title || '封面';
      coverEl.appendChild(img);
    } else {
      coverEl.appendChild(mk('span', 'rr-cover-ph', (BOOK.title || '书').charAt(0)));
    }
  }
  if (bookMetaEl) {
    clear(bookMetaEl);
    const rows = [
      ['作者', BOOK.author || '—'],
      ['格式', BOOK.format || '—'],
      ['状态', BOOK.status || '—']
    ];
    rows.forEach(function (r) {
      const line = mk('div', 'rr-meta-row');
      line.appendChild(mk('span', 'rr-meta-k', r[0]));
      line.appendChild(mk('span', 'rr-meta-v', String(r[1])));
      bookMetaEl.appendChild(line);
    });
  }
}

function appendTocItem(it, extra) {
  const div = mk('div', 'rr-toc-item');
  const raw = Number(it.index);
  const idx = isNaN(raw) ? 0 : raw;
  const ex = extra || {};
  div.setAttribute('data-index', String(idx));
  div.setAttribute('data-level', String(it.level === 2 ? 2 : 1));
  if (it.level === 2 && typeof ex.parentIndex === 'number' && ex.parentIndex >= 0) {
    div.setAttribute('data-parent-index', String(ex.parentIndex));
  }
  div.appendChild(mk('span', 'rr-toc-caret', ''));
  div.appendChild(mk('span', 'rr-toc-name', it.title || ('第 ' + (idx + 1) + ' 节')));
  // 重排流没有固定页码：显示「节序 + 全书位置」，不假装精确页码
  const pos = chapterCount > 0 ? (idx + 1) + '/' + chapterCount : String(idx + 1);
  const pct = chapterCount > 0 ? Math.round((idx / chapterCount) * 100) : 0;
  div.appendChild(mk('span', 'rr-toc-pct', pos + ' · ' + pct + '%'));
  for (let i = 0; i < bookmarks.length; i++) {
    if (bookmarks[i].chapterIndex === idx) { div.appendChild(mk('span', 'rr-toc-bm-dot', '')); break; }
  }
  if (tocEl) tocEl.appendChild(div);
}

// 折叠某一节的子项；递归把孙子一起收起，避免「父收起、孙还露着」
function toggleTocChildren(idx, hide) {
  if (!tocEl) return;
  const kids = tocEl.querySelectorAll('.rr-toc-item[data-parent-index="' + idx + '"]');
  for (let i = 0; i < kids.length; i++) {
    kids[i].classList.toggle('rr-toc-folded', !!hide);
    if (hide) toggleTocChildren(Number(kids[i].getAttribute('data-index')), true);
  }
}

function renderToc(toc) {
  if (!tocEl) return;
  clear(tocEl);
  const list = Array.isArray(toc) ? toc : [];
  if (!list.length) {
    for (let i = 0; i < chapterCount; i++) {
      appendTocItem({ index: i, title: '第 ' + (i + 1) + ' 节', level: 1 });
    }
    return;
  }
  let lastTop = -1;
  list.forEach(function (it) {
    const idx = Number(it.index) || 0;
    if (it.level === 2) appendTocItem(it, { parentIndex: lastTop });
    else { lastTop = idx; appendTocItem(it, {}); }
  });
  // 有子项的顶层章节才给折叠三角，避免每个「第一章」都长一个没用的箭头
  const tops = tocEl.querySelectorAll('.rr-toc-item[data-level="1"]');
  for (let i = 0; i < tops.length; i++) {
    const idx = tops[i].getAttribute('data-index');
    if (!tocEl.querySelector('.rr-toc-item[data-parent-index="' + idx + '"]')) continue;
    const caret = tops[i].querySelector('.rr-toc-caret');
    if (!caret) continue;
    caret.textContent = '▾';
    caret.style.cursor = 'pointer';
    caret.addEventListener('click', function (e) {
      e.stopPropagation();
      const folded = tops[i].getAttribute('data-folded') === '1';
      tops[i].setAttribute('data-folded', folded ? '0' : '1');
      caret.textContent = folded ? '▾' : '▸';
      toggleTocChildren(Number(idx), !folded);
    });
  }
}

function highlightToc(idx) {
  if (!tocEl) return;
  const items = tocEl.querySelectorAll('.rr-toc-item');
  for (let i = 0; i < items.length; i++) {
    if (parseInt(items[i].getAttribute('data-index'), 10) === idx) {
      items[i].classList.add('rr-toc-on');
      if (items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
    } else {
      items[i].classList.remove('rr-toc-on');
    }
  }
}

// ---- 渲染：右栏三阶九问 / 伴读浮窗 / 笔记列表 ----
function normalizeTypes(meta) {
  const nt = (meta && meta.noteTypes) || [];
  const labels = (meta && meta.noteTypeLabel) || {};
  const out = [];
  for (let i = 0; i < nt.length; i++) {
    const t = nt[i];
    if (typeof t === 'string') {
      const lab = Array.isArray(labels) ? (labels[i] || t) : (labels[t] || t);
      out.push({ value: t, label: lab });
    } else if (t && typeof t === 'object') {
      const v = String(t.type || t.value || t.key || t);
      const l = t.label || t.typeLabel || (Array.isArray(labels) ? labels[i] : labels[v]) || v;
      out.push({ value: v, label: l });
    }
  }
  return out;
}

function typeLabel(t) {
  const opts = normalizeTypes(META);
  for (let i = 0; i < opts.length; i++) if (opts[i].value === t) return opts[i].label;
  return t || '';
}

// ---- 右栏三阶九问面板 ----
// 它取代了原来那张「类型 + 摘录 + 想法 + 页码 + 标签」的自由表单：
// 表单问的是「你要记什么」，九问问的是「这一段你到底想明白了什么」——
// 答案仍落同一条 notes（tags 带 #重述 / #连接 / #行动 …），所以笔记列表、九格回写、
// 原文锚点全部照旧，不加任何新表、新通道。
function qParts(item) {
  const s = String((item && item.q) || '');
  const i = s.indexOf(' · ');
  if (i > 0) return { no: s.slice(0, i), title: s.slice(i + 3) };
  return { no: '', title: s };
}

function q9Key(stage, i) { return String(stage) + ':' + String(i); }

function buildQ9Quote() {
  const box = mk('div', 'rr-q9-quote');
  if (!askQuote.text) { box.hidden = true; return box; }
  box.appendChild(mk('span', 'rr-q9-quote-tag', '原文'));
  box.appendChild(mk('p', 'rr-q9-quote-text', '「' + askQuote.text + '」'));
  const x = mk('button', 'rr-q9-quote-x', '×');
  x.type = 'button';
  x.setAttribute('data-act', 'unquote');
  x.title = '去掉引用';
  box.appendChild(x);
  return box;
}

function paintQ9Quote() {
  const old = q9List && q9List.querySelector('.rr-q9-quote');
  if (!old || !old.parentNode) return;
  old.parentNode.replaceChild(buildQ9Quote(), old);
}

function paintQ9Counts() {
  if (!q9List) return;
  const ns = q9List.querySelectorAll('.rr-q9-n');
  for (let i = 0; i < ns.length; i++) {
    const tag = ns[i].getAttribute('data-tag') || '';
    const c = q9Counts[tag] || 0;
    ns[i].textContent = c ? String(c) : '';
    ns[i].classList.toggle('rr-q9-n-on', c > 0);
  }
}

// 各问已记几条：只做事实陈述，不做「九问齐了吗」的配额提示
async function refreshQ9Counts() {
  let items = [];
  try {
    const d = await domain('reading.notes', [{ bookId: BOOK_ID }]);
    items = (d && d.items) || [];
  } catch (e) { items = []; }
  const m = {};
  items.forEach(function (n) {
    (n.tags || []).forEach(function (t) {
      const k = String(t);
      m[k] = (m[k] || 0) + 1;
    });
  });
  q9Counts = m;
  paintQ9Counts();
}

function renderQ9() {
  if (!q9List) return;
  clear(q9List);
  if (q9Tabs) {
    const bs = q9Tabs.querySelectorAll('button[data-stage]');
    for (let i = 0; i < bs.length; i++) {
      if (bs[i].getAttribute('data-stage') === q9Stage) bs[i].classList.add('rr-q9-on');
      else bs[i].classList.remove('rr-q9-on');
    }
  }
  const list = Q9_BANK[q9Stage] || Q9_BANK.mid;
  list.forEach(function (item, i) {
    const p = qParts(item);
    const row = mk('button', 'rr-q9-item');
    row.type = 'button';
    row.setAttribute('data-i', String(i));
    if (i === q9Active) row.classList.add('rr-q9-item-on');
    row.appendChild(mk('span', 'rr-q9-no', p.no));
    row.appendChild(mk('span', 'rr-q9-t', p.title));
    if (item.meta) {
      row.appendChild(mk('span', 'rr-q9-meta', '看目录'));
    } else {
      const n = mk('span', 'rr-q9-n', '');
      n.setAttribute('data-tag', item.tag || '');
      row.appendChild(n);
    }
    q9List.appendChild(row);
    if (i !== q9Active) return;

    const box = mk('div', 'rr-q9-edit');
    box.appendChild(mk('p', 'rr-q9-hint', item.hint || ''));
    if (item.meta) {
      // Q2 不给输入框：翻目录本身就是在回答「它打算怎么回答」
      const go = mk('button', 'rr-q9-toc', '翻目录看结构');
      go.type = 'button';
      go.setAttribute('data-act', 'toc');
      box.appendChild(go);
      q9List.appendChild(box);
      return;
    }
    box.appendChild(buildQ9Quote());
    if (item.options) {
      const opts = mk('div', 'rr-q9-opts');
      item.options.forEach(function (o) {
        const b = mk('button', 'rr-q9-opt', o);
        b.type = 'button';
        b.setAttribute('data-val', o);
        opts.appendChild(b);
      });
      box.appendChild(opts);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'rr-q9-input';
      ta.rows = 3;
      ta.placeholder = item.ph || '写一句…';
      ta.value = q9Draft[q9Key(q9Stage, i)] || '';
      box.appendChild(ta);
    }
    const bar = mk('div', 'rr-q9-bar');
    if (!item.options) {
      const sv = mk('button', 'rr-save rr-q9-save', '存下');
      sv.type = 'button';
      sv.setAttribute('data-act', 'save');
      bar.appendChild(sv);
      const pk = mk('button', 'rr-q9-pick', '引原文');
      pk.type = 'button';
      pk.setAttribute('data-act', 'pick');
      bar.appendChild(pk);
    }
    const cl = mk('button', 'rr-q9-close', '收起');
    cl.type = 'button';
    cl.setAttribute('data-act', 'close');
    bar.appendChild(cl);
    box.appendChild(bar);
    q9List.appendChild(box);
  });
  paintQ9Counts();
}

function q9ItemAt(i) {
  const list = Q9_BANK[q9Stage] || [];
  return list[i] || null;
}

async function commitQ9(item, val, extraTags) {
  if (!item || item.meta) return;
  const ok = await addAnswer(item, val, extraTags);
  if (!ok) { setStatus('写一句再存，或者点「收起」'); return; }
  q9Draft[q9Key(q9Stage, q9Active)] = '';
  q9Active = -1;
  if (q9Stage === 'pre') markPreDone();
  await refreshNotes();
  renderQ9();
  setStatus('已存进读书笔记 · ' + item.tag);
}

function pickQ9Quote() {
  const sel = selCache || currentSelection();
  if (!sel || !sel.text) { setStatus('先在正文里划一句，再点「引原文」'); return; }
  askQuote = {
    text: String(sel.text).slice(0, 300),
    anchor: currentIndex + ':' + sel.start + '-' + sel.end,
    chapter: currentIndex
  };
  paintQ9Quote();
  renderAskQuote();
  setStatus('已引用这一句 · 笔记会带锚点，右栏可跳回原文');
}

function onQ9TabClick(e) {
  const b = e.target && e.target.closest ? e.target.closest('button[data-stage]') : null;
  if (!b) return;
  const s = b.getAttribute('data-stage') || 'mid';
  if (!Q9_BANK[s]) return;
  q9Stage = s;
  q9Active = -1;
  renderQ9();
}

function onQ9ListClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;
  const act = t.closest('[data-act]');
  if (act) {
    const a = act.getAttribute('data-act');
    if (a === 'toc') { switchLeftTab('toc'); setStatus('目录在左栏 · 结构本身就是在回答 Q2'); return; }
    if (a === 'pick') { pickQ9Quote(); return; }
    if (a === 'unquote') { clearAskQuote(); paintQ9Quote(); return; }
    if (a === 'close') { q9Active = -1; renderQ9(); return; }
    if (a === 'save') {
      const item = q9ItemAt(q9Active);
      const ta = q9List.querySelector('.rr-q9-input');
      safeRun(function () { return commitQ9(item, ta ? ta.value : ''); });
      return;
    }
    return;
  }
  const opt = t.closest('.rr-q9-opt[data-val]');
  if (opt) {
    const item = q9ItemAt(q9Active);
    const val = opt.getAttribute('data-val') || '';
    safeRun(function () { return commitQ9(item, val, ['态度:' + val]); });
    return;
  }
  const row = t.closest('.rr-q9-item');
  if (row) {
    const i = Number(row.getAttribute('data-i'));
    q9Active = (q9Active === i) ? -1 : i;
    renderQ9();
  }
}

// ---- 三阶九问（docs/17）----
// 三条硬规矩写在这里，改动前先读：
//   ① 一次只问一个问题，绝不并列九问——并列的结果是用户只答最容易那一问；
//   ② 全可跳过，跳过即静默，不设配额、不设红点、不做「三问齐了吗」；
//   ③ 答案按方法落库：Q4 重述 / Q5 连接（type=link）/ Q6 行动（type=note），
//      读前读后同样走 notes + tags，不加任何新字段（docs/17 §8.3 的绕行口径）。
// 分工：浮窗只留「读中三问」——读书时随手记；右栏九问面板含读前 / 读中 / 读后全九问。
const ASK_POS_KEY = 'jiuge-reader-ask-pos';
const ASK_PRE_KEY = 'jiuge-reader-ask-pre:';
const Q9_BANK = {
  pre: [
    { q: 'Q1 · 我为什么翻开它', hint: '想弄清一件什么事？写空也可以，直接开读。', ph: '我想弄清……', type: 'note', tag: '读前' },
    // Q2 不产生输入框：目录本身就是答案（docs/17 §6.2「能用界面回答的问题，不要变成提问」）
    { q: 'Q2 · 它打算怎么回答', hint: '翻一下目录就知道——结构自己会回答，这里不用写。', meta: true },
    { q: 'Q3 · 什么算「值了」', hint: '读到什么程度，你就觉得这本书没白读。', ph: '读完能……就算值', type: 'note', tag: '读前' }
  ],
  mid: [
    { q: 'Q4 · 这句话在说什么', hint: '合上书，用你自己的话讲一遍——不要抄原文。', ph: '这句话的意思是……', type: 'note', tag: '重述' },
    { q: 'Q5 · 接得上我的什么', hint: '哪本书、哪件事、哪次经历。', ph: '这和我读过的《……》/ 我经历过的……是一回事', type: 'link', tag: '连接' },
    { q: 'Q6 · 下次什么场景怎么做', hint: '具体到触发条件：当……时，我就……', ph: '下次遇到……，我就……', type: 'note', tag: '行动' }
  ],
  post: [
    { q: 'Q7 · 这一章在论证什么', hint: '一句话说清骨架，不是复述细节。', ph: '这一章在说……', type: 'note', tag: '章句' },
    { q: 'Q8 · 我信几分', hint: '全信、部分、存疑，还是不同意——选一个就好。', options: ['全部说服我', '部分认同', '仍有存疑', '不同意'], type: 'note', tag: '态度' },
    { q: 'Q9 · 哪一句带走', hint: '三个月后你还想记得的那句。', ph: '我要带走的是……', type: 'note', tag: '收束' }
  ]
};
// 浮窗只用读中三问；右栏面板用 Q9_BANK 全量
const ASK_MID = Q9_BANK.mid;

let askStep = 0;
let askDrag = null;
// 右栏九问面板状态：当前阶、展开的那一问（-1 = 都没展开）、草稿、各问已记条数
let q9Stage = 'mid';
let q9Active = -1;
let q9Draft = {};
let q9Counts = {};
// 引用原文：三阶问的是同一段字，所以引用跟着浮窗走而不是每问重取。
// 存下来的是「原文 + 锚点（章:起-止）」，笔记落库后右栏能一键跳回原文那句话。
let askQuote = { text: '', anchor: '', chapter: -1 };

function markPreDone() {
  try { localStorage.setItem(ASK_PRE_KEY + BOOK_ID, '1'); } catch (e) {}
}

function preDone() {
  try { return localStorage.getItem(ASK_PRE_KEY + BOOK_ID) === '1'; } catch (e) { return false; }
}

// 阶段跟着阅读位置走：没问过读前就问读前；读到末章底部才问读后；其余都是读中
function autoAskStage() {
  if (!preDone()) return 'pre';
  if (chapterCount > 0 && currentIndex >= chapterCount - 1 && chapterPct() >= 95) return 'post';
  return 'mid';
}

function renderAskQuote() {
  if (!askQuoteEl) return;
  if (!askQuote.text) {
    askQuoteEl.hidden = true;
    if (askQuoteText) askQuoteText.textContent = '';
    keepAskInView();
    return;
  }
  askQuoteEl.hidden = false;
  if (askQuoteText) askQuoteText.textContent = '「' + askQuote.text + '」';
  keepAskInView();
}

function pickAskQuote() {
  const sel = selCache || currentSelection();
  if (!sel || !sel.text) {
    setStatus('先在正文里划一句，再点「引原文」');
    return;
  }
  askQuote = {
    text: String(sel.text).slice(0, 300),
    anchor: currentIndex + ':' + sel.start + '-' + sel.end,
    chapter: currentIndex
  };
  renderAskQuote();
  setStatus('已引用这一句 · 笔记会带锚点，右栏可跳回原文');
}

function clearAskQuote() {
  askQuote = { text: '', anchor: '', chapter: -1 };
  renderAskQuote();
  setStatus('已去掉引用');
}

function renderAsk() {
  if (!askEl) return;
  // 浮窗只做读中三问：读书时随手能记住的就在这三问里，读前读后归右栏面板
  const list = ASK_MID;
  const item = list[askStep];
  if (askTitle) {
    askTitle.textContent = '伴读 · 读中 ' + Math.min(askStep + 1, list.length) + '/' + list.length;
  }
  if (!item) {
    // 三问问完了：不追问、不庆祝，只留一句可继续的话
    if (askQ) askQ.textContent = '读中三问问完了';
    if (askHint) askHint.textContent = '想接着写，右栏「三阶九问」里还有读前、读后两阶；关掉浮窗后，右下角还能再唤出。';
    if (askInput) askInput.hidden = true;
    if (askChoice) { askChoice.hidden = true; if (askChoice) askChoice.textContent = ''; }
    if (askSaveBtn) askSaveBtn.hidden = true;
    if (askSkipBtn) askSkipBtn.hidden = true;
    keepAskInView();
    return;
  }
  if (askQ) askQ.textContent = item.q;
  if (askHint) askHint.textContent = item.hint || '';
  if (askSaveBtn) askSaveBtn.hidden = false;
  if (askSkipBtn) askSkipBtn.hidden = false;
  if (item.options) {
    if (askInput) { askInput.hidden = true; askInput.value = ''; }
    if (askChoice) {
      askChoice.textContent = '';
      askChoice.hidden = false;
      item.options.forEach(function (opt) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-val', opt);
        b.textContent = opt;
        askChoice.appendChild(b);
      });
    }
  } else {
    if (askChoice) { askChoice.hidden = true; askChoice.textContent = ''; }
    if (askInput) {
      askInput.hidden = false;
      askInput.placeholder = item.ph || '写一句…';
      askInput.value = '';
    }
  }
  keepAskInView();
}

// 落库只有一条路：答案 → notes（带 tag、引用、锚点）。浮窗与右栏面板共用这一条。
async function addAnswer(item, val, extraTags) {
  const text = String(val || '').trim();
  if (!text) return false;
  const patch = {
    mode: (BOOK && BOOK.mode) || MODE,
    bookId: BOOK_ID,
    themeId: (BOOK && BOOK.themeId) || '',
    bookTitle: (BOOK && BOOK.bookTitle) || (BOOK && BOOK.title) || '',
    type: item.type || 'note',
    // 引用与锚点跟着浮窗走：三阶问的是同一段字，所以每条笔记都带同一句原文。
    // anchor 形如「章:起-止」（正文纯文本偏移），右栏点笔记能跳回原句。
    quote: askQuote.text || '',
    text: text,
    page: 0,
    tags: [item.tag].concat(extraTags || []),
    chapterId: 'ch-' + (askQuote.chapter >= 0 ? askQuote.chapter : currentIndex),
    anchor: askQuote.anchor || '',
    color: '',
    style: ''
  };
  await domain('reading.addNote', [patch]);
  return true;
}

async function commitAsk(item, val, extraTags) {
  const ok = await addAnswer(item, val, extraTags);
  if (!ok) { setStatus('写一句再存，或者点「跳过」'); return; }
  askStep += 1;
  renderAsk();
  await refreshNotes();
  setStatus('已存进读书笔记 · ' + item.tag);
}

function skipAsk() {
  askStep += 1;
  renderAsk();
  if (askStep < ASK_MID.length) setStatus('跳过了这一问');
}

function closeAsk() {
  if (askEl) askEl.hidden = true;
  if (askOpenBtn) askOpenBtn.hidden = false;
}

// 折叠态就是「胶囊」：只剩标题栏一行，正文让开。默认就是这个形态
function syncAskFoldBtn() {
  if (!askFoldBtn || !askEl) return;
  const folded = askEl.classList.contains('rr-ask-folded');
  askFoldBtn.textContent = folded ? '▸' : '–';
  askFoldBtn.title = folded ? '展开这一问（点标题栏也行）' : '收起成胶囊';
  askFoldBtn.setAttribute('aria-expanded', folded ? 'false' : 'true');
  askFoldBtn.setAttribute('aria-label', folded ? '展开伴读提问' : '收起伴读提问');
  if (askTitle) askTitle.title = folded ? '点一下展开' : '';
}

function setAskFolded(folded) {
  if (!askEl) return;
  askEl.classList.toggle('rr-ask-folded', !!folded);
  syncAskFoldBtn();
  if (!folded) keepAskInView();
}

function openAsk() {
  if (askEl) askEl.hidden = false;
  if (askOpenBtn) askOpenBtn.hidden = true;
  // 唤出是一次主动动作，直接摊开问答；胶囊只在「刚打开书」时出现
  setAskFolded(false);
  restoreAskPos();
}

// 划选之后直接问某一问：划线工具条上的「重述 / 连接 / 行动」走这里。
// 它把选区变成引用（带锚点），所以存下的笔记仍能一键跳回原句。
function openAskAt(i) {
  askStep = clamp(Number(i) || 0, 0, ASK_MID.length - 1);
  openAsk();
  renderAskQuote();
  renderAsk();
  if (askInput && !askInput.hidden) {
    setTimeout(function () { try { askInput.focus(); } catch (e) {} }, 30);
  }
}

function foldAsk() {
  if (!askEl) return;
  if (askEl.classList.contains('rr-ask-folded')) setAskFolded(false);
  else setAskFolded(true);
}

// 内容一变高度就变（引用块、选项、多行输入），底部按钮可能被挤出窗口——
// 每次重排后按新高度把浮窗拉回可视区，别让人够不到「存下」。
function keepAskInView() {
  if (!askEl || askEl.hidden) return;
  const r = askEl.getBoundingClientRect();
  moveAsk(r.left, r.top);
}

// 拖动：整块跟着标题栏走，松手记住位置（跨书共用，因为这是「我习惯放哪」）
function moveAsk(x, y) {
  if (!askEl) return;
  const w = askEl.offsetWidth || 300;
  const h = askEl.offsetHeight || 160;
  const nx = clamp(x, 6, Math.max(6, window.innerWidth - w - 6));
  const ny = clamp(y, 6, Math.max(6, window.innerHeight - h - 6));
  askEl.style.left = nx + 'px';
  askEl.style.top = ny + 'px';
  askEl.style.right = 'auto';
  askEl.style.bottom = 'auto';
}

function saveAskPos() {
  if (!askEl) return;
  try {
    const r = askEl.getBoundingClientRect();
    localStorage.setItem(ASK_POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
  } catch (e) {}
}

function placeAskDefault() {
  if (!askEl) return;
  const main = document.querySelector('.rr-main');
  if (!main) return;
  const r = main.getBoundingClientRect();
  const w = askEl.offsetWidth || 292;
  // 胶囊贴正文右下角；展开时 keepAskInView 会把它向上顶，看着像「向上长」
  const h = askEl.offsetHeight || 200;
  moveAsk(r.right - w - 16, r.bottom - h - 20);
}

function restoreAskPos() {
  if (!askEl) return;
  try {
    const raw = localStorage.getItem(ASK_POS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (typeof o.x === 'number' && typeof o.y === 'number') { moveAsk(o.x, o.y); return; }
    }
  } catch (e) {}
  placeAskDefault();
}

function bindAskDrag() {
  if (!askHead || !askEl) return;
  askHead.addEventListener('mousedown', function (e) {
    if (e.target && e.target.closest && e.target.closest('button')) return;
    const r = askEl.getBoundingClientRect();
    askDrag = {
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      sx: e.clientX,
      sy: e.clientY,
      moved: false
    };
    askEl.classList.add('rr-ask-drag');
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!askDrag) return;
    // 位移超过 3px 才算拖动，否则松手按「点了一下标题栏」处理
    if (Math.abs(e.clientX - askDrag.sx) > 3 || Math.abs(e.clientY - askDrag.sy) > 3) askDrag.moved = true;
    moveAsk(e.clientX - askDrag.dx, e.clientY - askDrag.dy);
  });
  document.addEventListener('mouseup', function () {
    if (!askDrag) return;
    const wasClick = !askDrag.moved;
    askDrag = null;
    if (askEl) askEl.classList.remove('rr-ask-drag');
    saveAskPos();
    // 胶囊状态下点一下标题栏就展开——不逼人去找那个小箭头
    if (wasClick && askEl && askEl.classList.contains('rr-ask-folded')) setAskFolded(false);
  });
  window.addEventListener('resize', function () {
    if (!askEl || askEl.hidden) return;
    const r = askEl.getBoundingClientRect();
    moveAsk(r.left, r.top);
    if (endCardEl && !endCardEl.hidden) positionEndCard();
  });
}

function initAsk() {
  if (askEl) {
    askStep = 0;
    askEl.hidden = false;
    if (askOpenBtn) askOpenBtn.hidden = true;
    // 刚打开书时只给一颗胶囊：这一问是什么，点开才知道——先别摊在正文上
    setAskFolded(true);
    restoreAskPos();
    renderAskQuote();
    renderAsk();
  }
  // 右栏面板的默认阶跟着阅读位置走：没读过读前就先给读前
  q9Stage = autoAskStage();
  q9Active = -1;
  renderQ9();
}

// 封面 / 版权页 / 目录这类前附页不是「一章正文」：读到底也不该弹章末卡
const FRONT_MATTER_RE = /^(?:封面|封底|版权|版权页|目录|扉页|书名页|题名页|献辞|题献|插图|cover|copyright|contents|table of contents|title page|toc)\b/i;

function isFrontMatter(index) {
  const title = (chapterTitleAt(index) || '').trim();
  if (title && FRONT_MATTER_RE.test(title)) return true;
  // 标题没线索时看体量：封面/版权页通常只有几十字
  if (title && /^第[一二三四五六七八九十百零〇\d]+[章节回篇]/.test(title)) return false;
  try {
    const d = iframe.contentDocument;
    if (!d || !d.body) return false;
    const plain = (d.body.textContent || '').replace(/\s+/g, '');
    return plain.length > 0 && plain.length < 80;
  } catch (e) { return false; }
}

function renderNotes(items) {
  if (!noteList) return;
  clear(noteList);
  if (!items || !items.length) {
    noteList.appendChild(mk('div', 'rr-note-empty', '还没有笔记：划一句上色，或者在上面答一问'));
    return;
  }
  items.forEach(function (n) {
    const card = mk('div', 'rr-note');
    card.setAttribute('data-id', String(n.id));

    const head = mk('div', 'rr-note-head');
    if (n.style) {
      const st = n.style === 'highlight' ? ('高亮' + (n.color ? '·' + colorLabel(n.color) : ''))
        : (n.style === 'underline' ? '下划线' : '删除线');
      const chip = mk('span', 'rr-note-style', st);
      // 色标本身要带颜色，否则右栏一堆灰胶囊，看不出哪条是黄哪条是蓝
      chip.setAttribute('data-color', n.style === 'highlight' ? (n.color || 'yellow') : n.style);
      card.appendChild(chip);
      card.setAttribute('data-style', n.style);
    }
    if (n.anchor) {
      card.classList.add('rr-note-jump');
      card.title = '点击回到原文位置';
      card.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('button')) return;
        safeRun(function () { return gotoNote(n); });
      });
    }
    head.appendChild(mk('span', 'rr-note-type', n.typeLabel || typeLabel(n.type) || '笔记'));
    head.appendChild(mk('span', 'rr-note-time', fmtTime(n.createdAt)));
    if (n.modeLabel) head.appendChild(mk('span', 'rr-note-mode', n.modeLabel));
    card.appendChild(head);

    if (n.quote) card.appendChild(mk('div', 'rr-note-quote', '「' + n.quote + '」'));
    if (n.text) card.appendChild(mk('div', 'rr-note-text', n.text));
    if (n.tags && n.tags.length) {
      const tags = mk('div', 'rr-note-tags');
      n.tags.forEach(function (t) { tags.appendChild(mk('span', 'rr-note-tag', '#' + String(t))); });
      card.appendChild(tags);
    }

    const foot = mk('div', 'rr-note-foot');
    if (n.pushedAt || n.pushed) {
      foot.appendChild(mk('span', 'rr-pushed', '已入九格'));
    } else {
      const pb = mk('button', 'rr-push', '→ 九格');
      pb.type = 'button';
      pb.addEventListener('click', function () { safeRun(function () { return pushNote(n); }); });
      foot.appendChild(pb);
    }
    const db = mk('button', 'rr-note-del', '删除');
    db.type = 'button';
    db.addEventListener('click', function () { safeRun(function () { return deleteNote(n.id); }); });
    foot.appendChild(db);
    card.appendChild(foot);
    noteList.appendChild(card);
  });
}

// ---- 主题 / 字号 / 行距 ----
function updateChrome() {
  document.documentElement.setAttribute('data-theme', pref.theme);
  if (appEl) appEl.setAttribute('data-theme', pref.theme);
  if (themeBtn) themeBtn.textContent = THEME_LABELS[pref.theme] || '纸色';
  if (lineBtn) lineBtn.textContent = '行距 ' + pref.line;
}

function applyIframePrefs() {
  try {
    const doc = iframe && iframe.contentDocument;
    if (!doc || !doc.body) return;
    const b = doc.body;
    const m = MARGIN_PRESET[pref.margin] || MARGIN_PRESET.mid;
    b.style.fontSize = pref.font + 'px';
    b.style.lineHeight = String(pref.line);
    b.style.maxWidth = m.max + 'px';
    b.style.marginLeft = 'auto';
    b.style.marginRight = 'auto';
    b.style.padding = m.y + 'px ' + m.x + 'px 64px';
    b.style.setProperty('--rr-para', PARA_GAP[pref.para] || PARA_GAP.normal);
    const t = IFRAME_THEMES[pref.theme] || IFRAME_THEMES.paper;
    b.style.backgroundColor = t.bg;
    b.style.color = t.fg;
    doc.documentElement.setAttribute('data-theme', pref.theme);
    applyZoom();
    applyTypeface();
    applyPunct();
    const ps = doc.querySelectorAll('p');
    for (let i = 0; i < ps.length; i++) {
      ps[i].style.lineHeight = String(pref.line);
      ps[i].style.color = t.fg;
    }
  } catch (e) {}
}

function showUnsupported(reason) {
  if (unsupportedEl) {
    unsupportedEl.style.display = 'block';
    unsupportedEl.textContent = '暂不支持该格式：' + (reason || '无法解析正文与目录');
  }
  if (iframe) iframe.style.display = 'none';
}
function hideUnsupported() {
  if (unsupportedEl) unsupportedEl.style.display = 'none';
  if (iframe) iframe.style.display = 'block';
}

// ---- 章节 / 进度 / 笔记 动作 ----
async function loadChapter(index, opts) {
  // 切章前先把「当前章读到哪」存下，别让翻章把上一章的位置冲掉
  savePos();
  let idx = Number(index);
  if (!isFinite(idx)) idx = 0;
  idx = Math.floor(idx);
  const max = Math.max(0, chapterCount - 1);
  if (idx < 0) idx = 0;
  if (idx > max) idx = max;
  const data = await domain('reading.readerChapter', [BOOK_ID, idx]);
  if (!data || data.ok === false) {
    setStatus('章节读取失败：' + ((data && data.reason) || '未知原因'));
    return;
  }
  currentIndex = idx;
  iframeReady = false;
  hideEndCard();
  endCardShown = false;                      // 换章后重新判断这一章读没读完
  chapterEnteredAt = Date.now();
  if (endCardTimer) { clearTimeout(endCardTimer); endCardTimer = null; }
  pendingRatio = (opts && typeof opts.ratio === 'number') ? clamp(opts.ratio, 0, 1) : null;
  if (iframe) iframe.srcdoc = data.html || '';
  if (chapterTitleEl) chapterTitleEl.textContent = data.title || ('第 ' + (idx + 1) + ' 章');
  if (posEl) posEl.textContent = (idx + 1) + ' / ' + chapterCount;
  highlightToc(idx);
  saveChapterPref(idx);
  // 超长章节（微信读书 iOS 曾因 2 万段落爆内存）：不拒绝渲染，但如实提示一句
  if (data && data.oversize) {
    setTimeout(function () {
      setStatus('本章解压后约 ' + (Math.round((Number(data.bytes) || 0) / 1048576 * 10) / 10) +
        ' MB，属超长章节，已降级渲染；建议用书内搜索直接定位句子');
    }, 60);
  }
}

async function syncProgress() {
  const data = await domain('reading.readerProgress', [BOOK_ID, currentIndex, chapterCount]);
  if (!data || data.ok === false) {
    setStatus('同步失败：' + ((data && data.reason) || '未知原因'));
    return;
  }
  setProgressText(data.done, data.total);
  setStatus('已同步进度：已读 ' + data.done + ' / ' + data.total + ' 章');
}

async function refreshNotes() {
  const q = (noteFilter === 'chapter')
    ? { bookId: BOOK_ID, chapterId: 'ch-' + currentIndex }
    : { bookId: BOOK_ID };
  const data = await domain('reading.notes', [q]);
  const items = (data && data.items) || [];
  // 正文高亮永远按「本章」取：筛选「全部」只影响右栏列表，不该把别章锚点画到本章上
  chapterNotes = items.filter(function (n) { return n.chapterId === 'ch-' + currentIndex; });
  const shown = noteStyleFilter
    ? items.filter(function (n) { return n.style === noteStyleFilter; })
    : items;
  renderNotes(shown);
  if (searchCountEl) searchCountEl.textContent = '';
  setTimeout(applyHighlights, 30);
  await refreshQ9Counts();
}

// 自由表单已下线：右栏只收九问的答案（saveNote 随表单一起移除），
// 需要「只摘不写」时就用划线工具条的颜色按钮，那条路仍然直存 notes。
async function saveFlash() {
  const text = flashText.value.trim();
  if (!text) { setStatus('先写一句闪念再入格'); return; }
  const cell = flashCell.value || 'free';
  const patch = {
    mode: (BOOK && BOOK.mode) || MODE,
    bookId: BOOK_ID,
    themeId: (BOOK && BOOK.themeId) || '',
    bookTitle: (BOOK && BOOK.bookTitle) || (BOOK && BOOK.title) || '',
    type: 'idea',
    quote: '',
    text: text,
    page: 0,
    tags: ['闪念'],
    chapterId: 'ch-' + currentIndex
  };
  await domain('reading.addNote', [patch]);
  const noteLike = Object.assign({}, patch, { id: 'flash-' + Date.now(), createdAt: Date.now(), pushedAt: 0 });
  const line = await domain('reading.diaryLine', [noteLike]);
  const target = await appendLine(cell, line);
  const list = await domain('reading.notes', [{ keyword: text }]);
  const items = (list && list.items) || [];
  let found = null;
  for (let i = 0; i < items.length; i++) {
    if (items[i].text === text && !items[i].pushedAt) { found = items[i]; break; }
  }
  if (!found && items.length) found = items[0];
  if (found) await domain('reading.markPushed', [found.id, target, Date.now()]);
  flashText.value = '';
  await refreshNotes();
  setStatus('闪念已入格 · ' + cellLabel(target));
}

async function pushNote(n) {
  if (n.pushedAt) return;
  const line = await domain('reading.diaryLine', [n]);
  const cell = await appendLine(cellFor(n), line);
  await domain('reading.markPushed', [n.id, cell, Date.now()]);
  await refreshNotes();
  setStatus('已追加到九格 · ' + cellLabel(cell) + '，并标记已入九格');
}

async function deleteNote(id) {
  await domain('reading.removeNote', [id]);
  await refreshNotes();
  setStatus('已删除这条笔记');
}

// 顶栏「划选问一句」：把划选原文变成引用，直接开 Q4（这句话在说什么）
function pickQuote() {
  const sel = selCache || currentSelection();
  if (!sel || !sel.text) { setStatus('请先在正文里划选文字'); return; }
  askQuote = {
    text: String(sel.text).slice(0, 300),
    anchor: currentIndex + ':' + sel.start + '-' + sel.end,
    chapter: currentIndex
  };
  hideSelBar();
  openAskAt(0);
  setStatus('已引用这一句 · 用你自己的话讲讲它在说什么');
}

// ---- 偏好动作 ----
function changeFont(delta) {
  pref.font = clamp(pref.font + delta, 14, 24);
  savePrefs();
  applyIframePrefs();
  setStatus('字号 ' + pref.font + 'px');
}

function cycleLine() {
  const steps = [1.5, 1.7, 1.9, 2.2];
  let i = steps.indexOf(pref.line);
  if (i < 0) {
    i = 0;
    for (let k = 1; k < steps.length; k++) {
      if (Math.abs(steps[k] - pref.line) < Math.abs(steps[i] - pref.line)) i = k;
    }
  }
  pref.line = steps[(i + 1) % steps.length];
  savePrefs();
  updateChrome();
  applyIframePrefs();
  setStatus('行距 ' + pref.line);
}

function cycleTheme() {
  const order = ['paper', 'eye', 'night'];
  const i = order.indexOf(pref.theme);
  pref.theme = order[(i + 1) % order.length];
  savePrefs();
  updateChrome();
  applyIframePrefs();
  setStatus('主题：' + (THEME_LABELS[pref.theme] || '纸色'));
}

// ---- 事件 ----
function onTocClick(e) {
  const item = e.target && e.target.closest ? e.target.closest('.rr-toc-item') : null;
  if (!item) return;
  const idx = parseInt(item.getAttribute('data-index'), 10);
  if (isNaN(idx)) return;
  safeRun(function () { return loadChapter(idx); });
}



function onFilterClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-filter]') : null;
  if (!btn) return;
  noteFilter = btn.getAttribute('data-filter') === 'all' ? 'all' : 'chapter';
  if (filterEl) {
    const all = filterEl.querySelectorAll('button');
    for (let i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-filter') === noteFilter) all[i].classList.add('rr-filter-on');
      else all[i].classList.remove('rr-filter-on');
    }
  }
  setStatus(noteFilter === 'chapter' ? '只看本章笔记' : '查看全部笔记');
  safeRun(refreshNotes);
}

function onKeyDown(e) {
  const t = e.target;
  const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    safeRun(function () { return loadChapter(currentIndex - 1); });
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    safeRun(function () { return loadChapter(currentIndex + 1); });
  }
}

function subscribeDataChanged() {
  try {
    const b = window.jiugeBridge;
    if (b && typeof b.onDataChanged === 'function') {
      b.onDataChanged(function () {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () { safeRun(refreshNotes); }, 150);
      });
    }
  } catch (e) {}
}


// ================= V2.6 R1/R2：位置 / 书签 / 搜索 / 缩放 / 标注 =================
const POS_KEY = 'jiuge-reader-pos:';

function colorLabel(c) {
  return c === 'yellow' ? '黄' : c === 'green' ? '绿' : c === 'blue' ? '蓝' : c === 'pink' ? '粉' : '';
}

// ---- 精确位置：章 + 章内滚动比例 ----
function scrollRatio() {
  try {
    const w = iframe.contentWindow;
    const d = iframe.contentDocument;
    const max = Math.max(1, d.documentElement.scrollHeight - w.innerHeight);
    return clamp(w.scrollY / max, 0, 1);
  } catch (e) { return 0; }
}
function setScrollRatio(r) {
  try {
    const w = iframe.contentWindow;
    const d = iframe.contentDocument;
    const max = Math.max(0, d.documentElement.scrollHeight - w.innerHeight);
    w.scrollTo(0, max * clamp(r, 0, 1));
  } catch (e) {}
}
function savePos() {
  if (!iframeReady) return; // 正文还没加载，别用「空页 + 第 0 章」覆盖真实位置
  try {
    const ratio = scrollRatio();
    const prev = readPos();
    // 打开/换章那一瞬间正文还没滚起来，ratio=0 会把已记录的进度清零。
    // 位置只许前进：位置更靠后的旧记录不因一次空页写入而丢失。
    if (prev && ratio < 0.02) {
      if (prev.chapter > currentIndex) return;
      if (prev.chapter === currentIndex && prev.ratio > 0.02) return;
    }
    localStorage.setItem(POS_KEY + BOOK_ID, JSON.stringify({
      chapter: currentIndex, ratio: ratio, ts: Date.now()
    }));
  } catch (e) {}
}
function readPos() {
  try {
    const raw = localStorage.getItem(POS_KEY + BOOK_ID);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o.chapter !== 'number' || !isFinite(o.chapter)) return null;
    const chapter = Math.max(0, Math.floor(o.chapter));
    const ratio = clamp(Number(o.ratio) || 0, 0, 1);
    const ts = Number(o.ts) || 0;
    // 章级兜底：位置被冲成「第 0 章最顶端」时，只要上次读到过更后面的章就用它，
    // 否则续读条和「翻到上次那章」都会失效（章级精度总比没有强）。
    if (!chapter && ratio < 0.02) {
      const prefCh = readChapterPref();
      if (prefCh > 0) return { chapter: prefCh, ratio: 0, ts: ts };
    }
    return { chapter: chapter, ratio: ratio, ts: ts };
  } catch (e) { return null; }
}

// ---- 缩放：与字号独立，改的是版面比例 ----
function applyZoom() {
  try {
    const doc = iframe && iframe.contentDocument;
    if (doc && doc.documentElement) doc.documentElement.style.zoom = String(pref.zoom || 1);
    if (zoomTextEl) zoomTextEl.textContent = Math.round((pref.zoom || 1) * 100) + '%';
  } catch (e) {}
}
function changeZoom(delta) {
  pref.zoom = clamp(Math.round(((pref.zoom || 1) + delta) * 10) / 10, 0.8, 1.5);
  savePrefs();
  applyZoom();
  setStatus('版面 ' + Math.round(pref.zoom * 100) + '%');
}

// ---- 侧栏宽度 ----
function applyWidths() {
  if (!appEl) return;
  appEl.style.setProperty('--rw-left', (pref.leftWidth || 260) + 'px');
  appEl.style.setProperty('--rw-right', (pref.rightWidth || 340) + 'px');
}
function bindDivider(el, side) {
  if (!el) return;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  el.addEventListener('pointerdown', function (e) {
    dragging = true;
    startX = e.clientX;
    startW = side === 'left' ? (pref.leftWidth || 260) : (pref.rightWidth || 340);
    if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (_) {} }
  });
  el.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (side === 'left') pref.leftWidth = Math.round(clamp(startW + dx, 200, 360));
    else pref.rightWidth = Math.round(clamp(startW - dx, 300, 460));
    applyWidths();
  });
  function stop() {
    if (!dragging) return;
    dragging = false;
    savePrefs();
    applyHighlights();
  }
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('dblclick', function () {
    if (side === 'left') pref.leftWidth = 260; else pref.rightWidth = 340;
    applyWidths();
    savePrefs();
  });
}

// ---- 左栏双 tab ----
function switchLeftTab(tab) {
  leftTab = tab === 'mark' ? 'mark' : 'toc';
  if (paneToc) paneToc.style.display = leftTab === 'toc' ? 'block' : 'none';
  if (paneMark) paneMark.style.display = leftTab === 'mark' ? 'block' : 'none';
  if (tabToc) tabToc.classList.toggle('rr-ltab-on', leftTab === 'toc');
  if (tabMark) tabMark.classList.toggle('rr-ltab-on', leftTab === 'mark');
  if (leftTab === 'mark') safeRun(loadBookmarks);
}

// ---- 书签 ----
async function loadBookmarks() {
  const list = await domain('reading.bookmarks', [BOOK_ID]);
  bookmarks = Array.isArray(list) ? list : [];
  renderBookmarks();
  if (SRC && SRC.toc) renderToc(SRC.toc);
}
function renderBookmarks() {
  if (!bmList) return;
  clear(bmList);
  if (!bookmarks.length) {
    bmList.appendChild(mk('div', 'rr-bm-empty', '还没有书签。读到想记住的地方，点上面的按钮。'));
    return;
  }
  bookmarks.forEach(function (bm) {
    const row = mk('div', 'rr-bm');
    row.setAttribute('data-id', String(bm.id));
    row.setAttribute('data-chapter', String(bm.chapterIndex));
    const ratio = Number(String(bm.anchor).split(':')[1]) || 0;
    row.appendChild(mk('span', 'rr-bm-title', bm.label || ('第 ' + (bm.chapterIndex + 1) + ' 节')));
    row.appendChild(mk('span', 'rr-bm-pos', '第 ' + (bm.chapterIndex + 1) + ' 节 · ' + Math.round(ratio * 100) + '%'));
    const del = mk('button', 'rr-bm-del', '删除');
    del.type = 'button';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      safeRun(function () { return removeBookmarkAt(bm.id); });
    });
    row.appendChild(del);
    row.addEventListener('click', function () { safeRun(function () { return jumpBookmark(bm); }); });
    bmList.appendChild(row);
  });
}
async function addBookmarkHere() {
  if (!iframeReady) { setStatus('正文还没加载完，稍等一下'); return; }
  const ratio = scrollRatio();
  const anchor = currentIndex + ':' + ratio.toFixed(3);
  const label = (chapterTitleEl && chapterTitleEl.textContent) || ('第 ' + (currentIndex + 1) + ' 节');
  await domain('reading.addBookmark', [{ bookId: BOOK_ID, anchor: anchor, label: label }]);
  await loadBookmarks();
  setStatus('已加书签 · 第 ' + (currentIndex + 1) + ' 节 ' + Math.round(ratio * 100) + '%');
}
async function removeBookmarkAt(id) {
  await domain('reading.removeBookmark', [id]);
  await loadBookmarks();
  setStatus('书签已删除');
}
async function jumpBookmark(bm) {
  const ratio = Number(String(bm.anchor).split(':')[1]) || 0;
  switchLeftTab('toc');
  await loadChapter(bm.chapterIndex, { ratio: ratio });
}

// ---- 书内搜索 ----
async function doSearch() {
  const kw = ((searchInput && searchInput.value) || '').trim();
  if (!kw) { hideHits(); return; }
  if (searchCountEl) searchCountEl.textContent = '查找中…';
  const r = await domain('reading.searchBook', [BOOK_ID, kw, 30]);
  if (!r || r.ok === false) {
    if (searchCountEl) searchCountEl.textContent = '';
    setStatus('搜索失败：' + ((r && r.reason) || '未知原因'));
    return;
  }
  const hits = r.hits || [];
  if (searchCountEl) searchCountEl.textContent = r.total ? (r.total + ' 处') : '没有';
  renderHits(hits);
  if (!hits.length) {
    setStatus('没有找到「' + kw + '」');
    return;
  }
  setStatus('找到 ' + r.total + ' 处' + (r.total > hits.length ? '，先列前 ' + hits.length + ' 处' : ''));
}
function hideHits() {
  if (hitsEl) { hitsEl.style.display = 'none'; clear(hitsEl); }
  if (searchCountEl) searchCountEl.textContent = '';
}
function renderHits(hits) {
  if (!hitsEl) return;
  clear(hitsEl);
  if (!hits || !hits.length) { hitsEl.style.display = 'none'; return; }
  hits.forEach(function (h) {
    const row = mk('div', 'rr-hit');
    row.setAttribute('data-chapter', String(h.chapterIndex));
    row.appendChild(mk('span', 'rr-hit-ch', '第 ' + (h.chapterIndex + 1) + ' 节'));
    row.appendChild(mk('span', 'rr-hit-text', h.snippet || ''));
    row.addEventListener('click', function () { safeRun(function () { return jumpHit(h); }); });
    hitsEl.appendChild(row);
  });
  hitsEl.style.display = 'block';
}
async function jumpHit(h) {
  await loadChapter(h.chapterIndex);
  const kw = ((searchInput && searchInput.value) || '').trim();
  hideHits();
  if (kw) setTimeout(function () { flashFind(kw); }, 120);
  setStatus('已跳到第 ' + (h.chapterIndex + 1) + ' 节');
}
// 命中词临时点亮：只加一个 rr-find 高亮，1.8 秒后撤掉，不写进笔记
// ---- 正文锚点：用「正文纯文本偏移」定位，不受字号/缩放/字体影响 ----
// 口径照 foliate-js 的 text-walker：先按文档序把「参与排版的文本节点」收成一张表
// （元素 FILTER_SKIP、script / style FILTER_REJECT、文本 FILTER_ACCEPT），偏移与还原
// 都走同一张表。原先两处各自量长度，且 TreeWalker 不过滤 script / style——书里只要
// 嵌一段脚本或样式，整章偏移就整体后移，高亮会串到别的段落上去。
const TEXT_SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
const ANCHOR_RE = /^(\d{1,4}):(\d{1,7})-(\d{1,7})$/;

function buildTextMap(root) {
  if (!root) return null;
  const doc = root.ownerDocument;
  if (!doc) return null;
  const nodes = [];
  const starts = [];
  const index = new Map();
  let total = 0;
  let joined = '';
  try {
    // 数字常量而非 NodeFilter.X：正文住在沙箱 iframe 里，常量值跨 realm 相同，
    // 但对象引用不保证一致，用字面量最稳。
    const walker = doc.createTreeWalker(root, 4, {
      acceptNode: function (node) {
        const p = node.parentNode;
        if (!p) return 2;
        return TEXT_SKIP[p.nodeName] ? 2 : 1;
      }
    });
    let n = walker.nextNode();
    while (n) {
      index.set(n, nodes.length);
      nodes.push(n);
      starts.push(total);
      const v = n.nodeValue || '';
      joined += v;
      total += v.length;
      n = walker.nextNode();
    }
  } catch (e) { return null; }
  return { doc: doc, nodes: nodes, starts: starts, index: index, length: total, text: joined, norm: null };
}

// 归一化文本（去掉全部空白）与「归一化下标 → 原文下标」的回溯表。
// 中文书里换行、缩进、全角空格遍地都是，逐字比对必须先抹平空白才可靠。
function normView(map) {
  if (map.norm) return map.norm;
  const raw = map.text;
  let out = '';
  const back = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (/\s/.test(ch)) continue;
    out += ch;
    back.push(i);
  }
  map.norm = { text: out, back: back };
  return map.norm;
}
function normWs(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

function offsetAt(root, node, offset, map) {
  const m = map || buildTextMap(root);
  if (!m) return -1;
  const i = m.index.get(node);
  if (i !== undefined) return m.starts[i] + Math.max(0, Math.min(offset, (node.nodeValue || '').length));
  // 节点不在表里（这段文字被跳过，或节点已脱离文档）：退回旧口径，至少不比以前更差
  try {
    const r = root.ownerDocument.createRange();
    r.selectNodeContents(root);
    r.setEnd(node, offset);
    return r.toString().length;
  } catch (e) { return -1; }
}
function locateInMap(map, off) {
  const starts = map.starts;
  let lo = 0, hi = starts.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= off) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (hit < 0) hit = 0;
  const node = map.nodes[hit];
  const len = (node.nodeValue || '').length;
  return { node: node, offset: Math.max(0, Math.min(off - starts[hit], len)) };
}
function rangeByOffset(root, start, end, map) {
  try {
    const m = map || buildTextMap(root);
    if (!m || !m.nodes.length) return null;
    const s = Math.max(0, Math.min(start, m.length));
    const e = Math.max(s, Math.min(end, m.length));
    const a = locateInMap(m, s);
    const b = locateInMap(m, e);
    const r = m.doc.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  } catch (e) { return null; }
}
// 从原文 s0 起逐字比对一段归一化过的 quote，返回终点偏移；对不上给 -1。
// 这个函数同时充当「偏移校验」和「按内容重新定位」两件事，是锚点自愈的核心。
function measureQuote(map, s0, quote) {
  if (!quote) return -1;
  let i = s0, k = 0;
  const raw = map.text;
  while (i < raw.length && k < quote.length) {
    const ch = raw.charAt(i);
    if (!/\s/.test(ch)) {
      if (ch !== quote.charAt(k)) return -1;
      k += 1;
    }
    i += 1;
  }
  return k === quote.length ? i : -1;
}
// 解析一条笔记的锚点：先信偏移，再必须过「原文对得上」这一关；对不上就按原文片段
// 全章找回，并用选区前后的片段消歧。返回 { range, start, end, exact }，找不到给 null。
// exact=false 表示偏移已经不准、位置是按内容重建的——UI 上要说出来，不能假装没事。
function resolveAnchor(map, n) {
  if (!map || !n) return null;
  const m = ANCHOR_RE.exec(n.anchor || '');
  if (!m) return null;
  const ch = Number(m[1]);
  const start = Number(m[2]);
  const end = Number(m[3]);
  const quote = normWs(n.quote || '');
  const rough = rangeByOffset(null, start, end, map);
  // 有 quote 就必须过「逐字对得上」这一关；没有 quote 的老数据只能按偏移落，
  // 但必须标成 exact=false —— 那是猜的，不能对用户假装精确。
  if (rough && quote) {
    const trueEnd = measureQuote(map, start, quote);
    if (trueEnd > 0) {
      // 终点以 quote 实际对上的位置为准：anchor 里的 end 可能偏大（跨节点时容易多吃
      // 一个换行），照它画就会多标出半行。
      const r = trueEnd === end ? rough : rangeByOffset(null, start, trueEnd, map);
      return { range: r || rough, start: start, end: trueEnd, exact: true, chapter: ch };
    }
  } else if (rough) {
    // 偏移越界时 range 已被夹到文末，返回值也要跟着夹，否则调用方会拿到一个不存在的坐标
    const s0 = Math.max(0, Math.min(start, map.length));
    const e0 = Math.max(s0, Math.min(end, map.length));
    return { range: rough, start: s0, end: e0, exact: false, chapter: ch };
  }
  // 没有原文片段就没法按内容找（此处必须拦住空串：indexOf('') 恒为 0，会造出假命中）
  if (!quote) return null;
  const nv = normView(map);
  const needle = quote.slice(0, 40);
  const hits = [];
  let at = nv.text.indexOf(needle);
  while (at >= 0 && hits.length < 60) {
    hits.push(at);
    at = nv.text.indexOf(needle, at + 1);
  }
  if (!hits.length) return null;
  const pre = normWs(n.anchorPre || '');
  const suf = normWs(n.anchorSuf || '');
  let best = null;
  let bestScore = -1;
  hits.forEach(function (h) {
    const s0 = nv.back[h];
    const s1 = measureQuote(map, s0, quote);
    const trueEnd = s1 > 0 ? s1 : s0 + quote.length;
    let score = 0;
    if (pre) {
      const head = normWs(map.text.slice(Math.max(0, s0 - pre.length - 12), s0));
      if (head.length >= pre.length && head.slice(-pre.length) === pre) score += 2;
    }
    if (suf) {
      const tail = normWs(map.text.slice(trueEnd, trueEnd + suf.length + 12));
      if (tail.slice(0, suf.length) === suf) score += 2;
    }
    if (s0 === start) score += 1;
    if (score > bestScore) { bestScore = score; best = { s0: s0, s1: trueEnd }; }
  });
  if (!best) return null;
  const r2 = rangeByOffset(null, best.s0, best.s1, map);
  if (!r2) return null;
  return { range: r2, start: best.s0, end: best.s1, exact: false, chapter: ch };
}
function currentSelection() {
  try {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc || !doc.body) return null;
    const sel = win.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return null;
    const range = sel.getRangeAt(0);
    const map = buildTextMap(doc.body);
    const start = offsetAt(doc.body, range.startContainer, range.startOffset, map);
    const end = offsetAt(doc.body, range.endContainer, range.endOffset, map);
    if (start < 0 || end <= start) return null;
    // 前后文各取 24 个非空白字符：偏移失准时靠这两段把这一句从全章里认回来
    const preRaw = map ? normWs(map.text.slice(Math.max(0, start - 48), start)) : '';
    const sufRaw = map ? normWs(map.text.slice(end, end + 48)) : '';
    const pre = Array.from(preRaw).slice(-24).join('');
    const suf = Array.from(sufRaw).slice(0, 24).join('');
    return { text: text, start: start, end: end, pre: pre, suf: suf, rect: range.getBoundingClientRect() };
  } catch (e) { return null; }
}
function hideSelBar() {
  selCache = null;
  if (selBar) selBar.style.display = 'none';
}
function captureSelection() {
  const s = currentSelection();
  if (!s || !selBar || !stageEl) { hideSelBar(); return; }
  selCache = s;
  const stageRect = stageEl.getBoundingClientRect();
  const frameRect = iframe.getBoundingClientRect();
  selBar.style.display = 'flex';
  // 工具条现在多带了「重述 / 连接 / 行动」三个快捷入口，宽度得实测后再夹住，
  // 不能再按写死的 330px 算——否则贴右边划选时按钮会压出正文区。
  const bw = selBar.offsetWidth || 330;
  const left = clamp(frameRect.left - stageRect.left + s.rect.left, 6,
    Math.max(6, stageRect.width - bw - 6));
  const top = Math.max(4, frameRect.top - stageRect.top + s.rect.top - 44);
  selBar.style.left = left + 'px';
  selBar.style.top = top + 'px';
}
function onMarkClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-color]') : null;
  if (!btn) return;
  safeRun(function () { return applyMark({ color: btn.getAttribute('data-color'), style: 'highlight' }); });
}
function onSelBarClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button') : null;
  if (!btn) return;
  // 快捷问：把这一句直接带进读中三问（Q4 重述 / Q5 连接 / Q6 行动）
  const ask = btn.getAttribute('data-ask');
  if (ask !== null) {
    const s = selCache || currentSelection();
    if (!s) { setStatus('先划选一句，再问这一问'); return; }
    askQuote = {
      text: String(s.text).slice(0, 300),
      anchor: currentIndex + ':' + s.start + '-' + s.end,
      chapter: currentIndex
    };
    hideSelBar();
    openAskAt(Number(ask) || 0);
    setStatus('已引用这一句 · ' + qParts(ASK_MID[clamp(Number(ask) || 0, 0, ASK_MID.length - 1)]).title);
    return;
  }
  safeRun(function () {
    const color = btn.getAttribute('data-color');
    const style = btn.getAttribute('data-style') || 'highlight';
    return applyMark({ color: color || 'yellow', style: style });
  });
}

// 划选 → 直接落一条带锚点的标注：正文里画出来，右栏也有一条
async function applyMark(opts) {
  const s = selCache || currentSelection();
  if (!s) { setStatus('先在正文里划选一段文字，再点颜色'); return; }
  const style = (opts && opts.style) || 'highlight';
  const color = style === 'highlight' ? ((opts && opts.color) || 'yellow') : '';
  const patch = {
    mode: (BOOK && BOOK.mode) || MODE,
    bookId: BOOK_ID,
    themeId: (BOOK && BOOK.themeId) || '',
    bookTitle: (BOOK && BOOK.bookTitle) || (BOOK && BOOK.title) || '',
    type: 'highlight',
    quote: s.text,
    text: '',
    page: 0,
    tags: [],
    chapterId: 'ch-' + currentIndex,
    anchor: currentIndex + ':' + s.start + '-' + s.end,
    anchorPre: s.pre || '',
    anchorSuf: s.suf || '',
    color: color,
    style: style
  };
  await domain('reading.addNote', [patch]);
  hideSelBar();
  try { iframe.contentWindow.getSelection().removeAllRanges(); } catch (e) {}
  await refreshNotes();
  applyHighlights();
  // T5：划选之后立刻给存量反馈——「这是这本书的第几句」比「已保存」有感觉得多
  let seq = 0;
  try {
    const all = await domain('reading.notes', [{ bookId: BOOK_ID }]);
    seq = (all && all.total) || 0;
  } catch (e) { seq = 0; }
  setStatus('已存入读书笔记' + (seq > 0 ? ' · 这是这本书的第 ' + seq + ' 句' : '') +
    ' · ' + (style === 'highlight' ? ('高亮·' + colorLabel(color)) : style === 'underline' ? '下划线' : '删除线'));
}

function unwrapMark(el) {
  try {
    const p = el && el.parentNode;
    if (!p) return;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
    if (p.normalize) p.normalize();
  } catch (e) {}
}
function wrapRange(doc, r, cls) {
  // 跨段选区（用户常常一次拖一大段）不能整段 surroundContents——Range 起止跨元素时它必抛
  // InvalidStateError，旧的 extractContents 兜底又会把 <p> 拆散。改成按文本节点逐段包裹：
  // 先把「文本节点 + 起止偏移」全收集完，再统一插 <mark>；边遍历边包会让 TreeWalker 走到新拆出的节点。
  const segs = [];
  const root = r.commonAncestorContainer;
  const host = root && root.nodeType === 3 ? root.parentNode : root;
  if (!host) return null;
  try {
    const walker = doc.createTreeWalker(host, 4, null);
    let n = walker.nextNode();
    while (n) {
      if (r.intersectsNode(n)) {
        const s = n === r.startContainer ? r.startOffset : 0;
        const e = n === r.endContainer ? r.endOffset : n.textContent.length;
        if (e > s) segs.push({ node: n, s: s, e: e });
      }
      n = walker.nextNode();
    }
  } catch (e) { return null; }
  let first = null;
  segs.forEach(function (seg) {
    if (!seg.node.parentNode) return;
    try {
      const len = seg.node.textContent.length;
      const rr = doc.createRange();
      rr.setStart(seg.node, Math.max(0, Math.min(seg.s, len)));
      rr.setEnd(seg.node, Math.max(0, Math.min(seg.e, len)));
      const mark = doc.createElement('mark');
      mark.className = cls;
      rr.surroundContents(mark);
      if (!first) first = mark;
    } catch (e) {}
  });
  return first;
}
function clearMarks(doc) {
  if (!doc) return;
  const marks = doc.querySelectorAll('mark.rr-mark');
  for (let i = 0; i < marks.length; i++) unwrapMark(marks[i]);
}
// 阅读排版：一份注入式样式表，同时管标注配色与「多字体」。
// 字体全部走系统字体栈（零网络）：标题黑体、正文宋体、引文楷体、西文与代码各自成体，
// 这样满屏不会是一种字形；字号/行距仍由外层偏好控制，不在这里写死。
// 排印基线（docs/15 §4 的中文排印规则，P0 全落在这里）。
// 引擎完全接管书内样式之后，正文长什么样只由这张表决定，所以三条硬规则必须守住：
//   ① 首行缩进 2em（绝不用全角空格——字号一变就错位）；段落间距用 margin，不塞空段落；
//   ② 两端对齐 + inter-ideograph，中文才有左右直边；标题/列表/表格/代码必须掰回左对齐；
//   ③ 绝不把 word-break 设成「全断」值 —— 那会废掉浏览器自带的 CJK 避头尾（微信读书「推入式」的前提）。
// 段距走 --rr-para 变量、字号行距由 applyIframePrefs 写在 body 上，样式表里不写死，
// 免得「书内样式 / 用户设置 / 引擎基线」三方打架。
const TYPO_CSS =
  'body.rr-typo{' +
  // 中文衬线必须把「有 Regular 实例」的家族排在前面：
  // 本机 Source Han Serif SC 只装了 Heavy（900），Chromium 请求 400 时会直接拿它渲染，
  // 整章正文就成了"宋体加黑"。现装的是官方 Source Han Serif CN Regular（同设计、CN 子集，
  // 31058 字形），缺字自然回退 SimSun。改 font-weight 治不了这件事，只有换对家族才行。
  'font-family:Georgia,"Times New Roman","Source Han Serif CN",SimSun,"Noto Serif SC","Songti SC",serif;' +
  // 正文一律常规字重：层级交给标题的黑体与字号，正文不做加黑（屏读整段变粗很容易累眼）
  'font-weight:400;' +
  'text-align:justify;text-justify:inter-ideograph;-webkit-text-justify:inter-ideograph;' +
  'word-break:normal;line-break:normal;overflow-wrap:break-word;hyphens:none;}' +
  'body.rr-typo p,body.rr-typo li,body.rr-typo td,body.rr-typo th,body.rr-typo blockquote,' +
  'body.rr-typo dd,body.rr-typo figcaption,body.rr-typo div{font-weight:400;}' +
  'body.rr-typo p{margin:0 0 var(--rr-para,.55em);text-indent:2em;}' +
  // 标题：黑体、不缩进、左对齐（居中会与两端对齐打架），层级靠字号与字重
  'body.rr-typo h1,body.rr-typo h2,body.rr-typo h3,body.rr-typo h4,body.rr-typo h5,body.rr-typo h6{' +
  'font-family:"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;' +
  'font-weight:700;letter-spacing:.01em;line-height:1.35;margin:1.15em 0 .6em;' +
  'text-indent:0;text-align:left;}' +
  'body.rr-typo h1{font-size:1.62em;}body.rr-typo h2{font-size:1.3em;}body.rr-typo h3{font-size:1.14em;}' +
  // 列表：整体左对齐，项内不缩进
  'body.rr-typo ul,body.rr-typo ol{margin:.6em 0;padding-left:1.9em;text-align:left;}' +
  'body.rr-typo li{margin:.22em 0;text-indent:0;}' +
  'body.rr-typo li p{margin:0;text-indent:0;}' +
  // 引文：楷体 + 左侧竖线，段内不再缩进
  'body.rr-typo blockquote,body.rr-typo .rr-quote-text{' +
  'font-family:KaiTi,"Kaiti SC",STKaiti,"Noto Serif CJK SC",serif;' +
  'border-left:3px solid #d8cbb4;padding-left:.9em;margin:.9em 0;color:#5a5147;text-align:justify;}' +
  'body.rr-typo blockquote p{margin:.3em 0;text-indent:0;}' +
  // 表格 / 代码：不缩进、不两端对齐（否则列宽被撑歪）
  'body.rr-typo table{margin:.8em 0;border-collapse:collapse;text-indent:0;}' +
  'body.rr-typo th,body.rr-typo td{padding:.35em .6em;border:1px solid #dfd8ca;text-indent:0;text-align:left;}' +
  'body.rr-typo code,body.rr-typo pre,body.rr-typo kbd,body.rr-typo samp{' +
  'font-family:Consolas,"Cascadia Mono","Courier New",monospace;font-size:.92em;' +
  'text-align:left;text-indent:0;word-break:normal;}' +
  // 中文没有斜体：em/i 转正体 + 楷体，靠字形与字重区分，不靠倾斜
  'body.rr-typo em,body.rr-typo i{font-style:normal;font-weight:400;' +
  'font-family:KaiTi,"Kaiti SC",STKaiti,serif;}' +
  'body.rr-typo strong,body.rr-typo b{font-weight:700;}' +
  'body.rr-typo hr{border:none;border-top:1px solid #e0d8c8;margin:1.5em 0;}' +
  // 标点挤压 + 中西文间距：仅在特性检测通过且用户打开时生效（data-punct 由 applyPunct 切）
  'body.rr-typo[data-punct="on"]{text-spacing-trim:trim-start;text-spacing:ideograph-alpha ideograph-numeric;}' +
  // 字体方案四档：只切 body 的 data-typeface，规则在此，切换即时生效
  'body.rr-typo[data-typeface="serif"]{font-family:"Source Han Serif CN",SimSun,"Noto Serif SC","Songti SC",serif;}' +
  'body.rr-typo[data-typeface="serif"] h1,body.rr-typo[data-typeface="serif"] h2,body.rr-typo[data-typeface="serif"] h3{' +
  'font-family:"Source Han Serif CN",SimSun,serif;font-weight:700;}' +
  'body.rr-typo[data-typeface="sans"]{font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;}' +
  'body.rr-typo[data-typeface="sans"] h1,body.rr-typo[data-typeface="sans"] h2,body.rr-typo[data-typeface="sans"] h3{' +
  'font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-weight:700;}' +
  'body.rr-typo[data-typeface="kai"]{font-family:KaiTi,"Kaiti SC",STKaiti,"Noto Serif CJK SC",serif;}' +
  'body.rr-typo[data-typeface="kai"] h1,body.rr-typo[data-typeface="kai"] h2,body.rr-typo[data-typeface="kai"] h3{' +
  'font-family:KaiTi,"Kaiti SC",serif;font-weight:700;}';

function injectReaderCss(doc) {
  if (!doc || !doc.head) return;
  if (!doc.getElementById('rr-hl-css')) {
    const st = doc.createElement('style');
    st.id = 'rr-hl-css';
    st.textContent = TYPO_CSS +
    'mark.rr-mark{background:transparent;color:inherit;padding:0;border-radius:2px;}' +
    'mark.rr-hl-yellow{background-color:#ffe58a;}' +
    'mark.rr-hl-green{background-color:#c8efc0;}' +
    'mark.rr-hl-blue{background-color:#c5e4ff;}' +
    'mark.rr-hl-pink{background-color:#ffd3e2;}' +
    'mark.rr-underline{text-decoration:underline;text-decoration-thickness:1.5px;}' +
    'mark.rr-strike{text-decoration:line-through;}' +
    'mark.rr-find{background-color:#ffd76e;outline:2px solid #e8a33d;}';
    doc.head.appendChild(st);
  }
  // 字体方案只切 body 的数据属性，规则已在同一张表里，切换即时生效
  if (doc.body) {
    doc.body.classList.add('rr-typo');
    doc.body.setAttribute('data-typeface', pref.typeface || 'mixed');
  }
}

function applyTypeface() {
  try {
    const doc = iframe && iframe.contentDocument;
    if (!doc || !doc.body) return;
    injectReaderCss(doc);
    doc.body.classList.add('rr-typo');
    doc.body.setAttribute('data-typeface', pref.typeface || 'mixed');
  } catch (e) {}
}

// 标点挤压（text-spacing-trim）与中西文间距（text-spacing）是 CSS Text L4 的实验特性，
// 各版本支持的值名并不一致：Chromium 126 认 trim-start / space-first / space-all，
// 但不认早期规范里的 trim-all、也还没实现 text-spacing。所以逐个值探测，
// 探测不到就把按钮置灰并说明原因，绝不假装生效（docs/15 §6 #7 的降级口径）。
const PUNCT_VALUES = ['trim-start', 'trim-both', 'trim-all', 'space-first'];

function punctTrimValue() {
  try {
    if (!window.CSS || !window.CSS.supports) return '';
    for (let i = 0; i < PUNCT_VALUES.length; i++) {
      if (window.CSS.supports('text-spacing-trim', PUNCT_VALUES[i])) return PUNCT_VALUES[i];
    }
  } catch (e) {}
  return '';
}

function supportsPunct() { return !!punctTrimValue(); }

function supportsCjkLatinSpacing() {
  try { return !!(window.CSS && window.CSS.supports && window.CSS.supports('text-spacing', 'ideograph-alpha')); }
  catch (e) { return false; }
}

function applyPunct() {
  const trim = punctTrimValue();
  const ok = !!trim;
  if (punctBtn) {
    punctBtn.disabled = !ok;
    punctBtn.title = ok
      ? '标点挤压与中西文间距（实验性，可关）'
      : '当前 Chromium 不支持 text-spacing-trim，已自动关闭';
  }
  const on = !!pref.punct && ok;
  if (punctBtn) punctBtn.classList.toggle('rr-on', on);
  try {
    const doc = iframe && iframe.contentDocument;
    if (!doc || !doc.body) return;
    doc.body.setAttribute('data-punct', on ? 'on' : 'off');
    doc.body.style.textSpacingTrim = on ? trim : 'normal';
    // 中西文间距还没实现的版本就别写空声明，免得留下「看着开了其实没用」的假象
    doc.body.style.textSpacing = (on && supportsCjkLatinSpacing())
      ? 'ideograph-alpha ideograph-numeric' : '';
  } catch (e) {}
}
// 正文标注用 <mark> 包裹，不用 CSS Custom Highlight API：
// Highlight 构造器只认同一 realm 的 Range，Electron 沙箱 iframe 跨 realm 会抛
// "parameter 1 is not of type 'AbstractRange'"，而 DOM 包裹不受 realm 限制。
function applyHighlights() {
  try {
    const doc = iframe && iframe.contentDocument;
    if (!doc || !doc.body) return;
    injectReaderCss(doc);
    clearMarks(doc);
    // 一张文本表管住全章：200 条笔记不会各建一遍（建表要遍历整章的文本节点）
    const map = buildTextMap(doc.body);
    let miss = 0;
    let painted = 0;
    let healed = 0;
    chapterNotes.forEach(function (n) {
      if (!n.anchor || !n.style) return;
      const hit = resolveAnchor(map, n);
      if (!hit || hit.chapter !== currentIndex) return;
      if (!hit.exact) healed += 1;
      const cls = 'rr-mark ' + (n.style === 'highlight' ? ('rr-hl-' + (n.color || 'yellow')) : ('rr-' + n.style));
      if (!wrapRange(doc, hit.range, cls)) { miss += 1; return; }
      painted += 1;
    });
    iframe.contentWindow.__rrHl = {
      chapter: currentIndex, notes: chapterNotes.length, miss: miss,
      marks: doc.querySelectorAll('mark.rr-mark').length, painted: painted, healed: healed
    };
  } catch (e) {}
}

// 命中词临时点亮：只加一个 rr-find，1.8 秒后撤掉，不写进笔记
function flashFind(kw) {
  try {
    const doc = iframe && iframe.contentDocument;
    if (!doc || !doc.body) return;
    injectReaderCss(doc);
    const map = buildTextMap(doc.body);
    if (!map) return;
    const text = map.text;
    const word = String(kw);
    // 先按原样找，找不到再忽略大小写找（忽略大小写时长度可能变化，命中后按原词长取尾）
    let at = text.indexOf(word);
    if (at < 0) at = text.toLowerCase().indexOf(word.toLowerCase());
    if (at < 0) return;
    const r = rangeByOffset(null, at, at + word.length, map);
    if (!r) return;
    const mark = wrapRange(doc, r, 'rr-mark rr-find');
    if (!mark) return;
    mark.scrollIntoView({ block: 'center' });
    setTimeout(function () { unwrapMark(mark); }, 1800);
  } catch (e) {}
}

async function gotoNote(n) {
  const m = ANCHOR_RE.exec(n.anchor || '');
  if (!m) { setStatus('这条笔记没有正文位置'); return; }
  const idx = Number(m[1]);
  if (idx !== currentIndex) await loadChapter(idx);
  setTimeout(function () {
    try {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      const map = buildTextMap(doc.body);
      const hit = resolveAnchor(map, n);
      if (!hit) { setStatus('原文这一句已经不在了，可能换过文件或删过章节'); return; }
      const rect = hit.range.getBoundingClientRect();
      win.scrollTo(0, Math.max(0, win.scrollY + rect.top - 120));
      const flash = wrapRange(doc, hit.range, 'rr-mark rr-find');
      if (flash) setTimeout(function () { unwrapMark(flash); }, 1600);
      setStatus(hit.exact ? '已回到原文' : '位置已按原文内容重新对上');
    } catch (e) {}
  }, 100);
}

// iframe 每次换章都要重挂事件：文档对象是新的，旧监听不会跟过来
function bindIframeEvents() {
  try {
    const doc = iframe.contentDocument;
    if (!doc || doc.__rrBound) return;
    doc.__rrBound = true;
    doc.addEventListener('mouseup', function () { setTimeout(captureSelection, 10); });
    doc.addEventListener('keyup', function (e) { if (e.shiftKey) setTimeout(captureSelection, 10); });
    // 右击划线：有选区才接管，弹出同一条工具条（颜色 / 重述 / 连接 / 行动）
    doc.addEventListener('contextmenu', function (e) {
      const s = currentSelection();
      if (!s) return;                        // 没选区就让右键保持原样
      e.preventDefault();
      selCache = s;
      captureSelection();
    });
    const win = iframe.contentWindow;
    win.addEventListener('scroll', function () {
      updateProgress();                       // 本章百分比要跟着滚动走，不能只在切章时变
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(savePos, 400);
    });

  } catch (e) {}
}

function onIframeLoad() {
  iframeReady = true;
  applyIframePrefs();
  applyZoom();
  injectReaderCss(iframe.contentDocument);
  bindIframeEvents();
  if (pendingRatio !== null) {
    const r = pendingRatio;
    pendingRatio = null;
    // 等一帧再滚：srcdoc 刚解析完时 scrollHeight 可能还没算稳
    setTimeout(function () { setScrollRatio(r); }, 30);
  } else {
    // 换章从头读：iframe 换了文档但滚动位置可能被沿用，必须显式复位
    try { iframe.contentWindow.scrollTo(0, 0); } catch (e) {}
  }
  applyHighlights();
  // 短章节一屏就到底，scroll 事件可能永不触发：加载完直接算一次进度，该出卡就出卡
  setTimeout(function () { updateProgress(); }, 150);
}

function onStyleFilterClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-style]') : null;
  if (!btn) return;
  noteStyleFilter = btn.getAttribute('data-style') || '';
  if (styleFilterEl) {
    const all = styleFilterEl.querySelectorAll('button');
    for (let i = 0; i < all.length; i++) {
      if ((all[i].getAttribute('data-style') || '') === noteStyleFilter) all[i].classList.add('rr-sf-on');
      else all[i].classList.remove('rr-sf-on');
    }
  }
  setStatus(noteStyleFilter ? ('只看' + (noteStyleFilter === 'highlight' ? '高亮' : noteStyleFilter === 'underline' ? '下划线' : '删除线')) : '显示全部标注');
  safeRun(refreshNotes);
}

function bindEvents() {
  if (prevBtn) prevBtn.addEventListener('click', function () { safeRun(function () { return loadChapter(currentIndex - 1); }); });
  if (nextBtn) nextBtn.addEventListener('click', function () { safeRun(function () { return loadChapter(currentIndex + 1); }); });
  if (syncBtn) syncBtn.addEventListener('click', function () { safeRun(syncProgress); });
  if (fontMinusBtn) fontMinusBtn.addEventListener('click', function () { changeFont(-1); });
  if (fontPlusBtn) fontPlusBtn.addEventListener('click', function () { changeFont(1); });
  if (themeBtn) themeBtn.addEventListener('click', cycleTheme);
  if (lineBtn) lineBtn.addEventListener('click', cycleLine);
  if (quotePickBtn) quotePickBtn.addEventListener('click', pickQuote);
  if (flashBtn) flashBtn.addEventListener('click', function () { safeRun(saveFlash); });
  if (tocEl) tocEl.addEventListener('click', onTocClick);
  if (askSaveBtn) askSaveBtn.addEventListener('click', function () {
    const list = ASK_MID;
    const item = list[askStep];
    if (!item) return;
    safeRun(function () { return commitAsk(item, askInput ? askInput.value : ''); });
  });
  if (askChoice) askChoice.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('button[data-val]') : null;
    if (!b) return;
    const item = ASK_MID[askStep];
    if (!item) return;
    const val = b.getAttribute('data-val') || '';
    safeRun(function () { return commitAsk(item, val, ['态度:' + val]); });
  });
  if (endCardEl) endCardEl.addEventListener('click', onEndCardClick);
  if (askSkipBtn) askSkipBtn.addEventListener('click', skipAsk);
  if (askPickBtn) askPickBtn.addEventListener('click', pickAskQuote);
  if (askQuoteClearBtn) askQuoteClearBtn.addEventListener('click', clearAskQuote);
  if (askFoldBtn) askFoldBtn.addEventListener('click', foldAsk);
  if (askCloseBtn) askCloseBtn.addEventListener('click', closeAsk);
  if (askOpenBtn) askOpenBtn.addEventListener('click', openAsk);
  bindAskDrag();
  if (filterEl) filterEl.addEventListener('click', onFilterClick);
  if (iframe) iframe.addEventListener('load', onIframeLoad);
  if (tabToc) tabToc.addEventListener('click', function () { switchLeftTab('toc'); });
  if (tabMark) tabMark.addEventListener('click', function () { switchLeftTab('mark'); });
  if (bmAdd) bmAdd.addEventListener('click', function () { safeRun(addBookmarkHere); });
  if (searchBtn) searchBtn.addEventListener('click', function () { safeRun(doSearch); });
  if (searchInput) searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); safeRun(doSearch); }
  });
  if (resumeGoBtn) {
    resumeGoBtn.addEventListener('click', function () {
      const pos = readPos();
      if (pos) { setScrollRatio(pos.ratio); }
      hideResume();
    });
  }
  if (resumeXBtn) resumeXBtn.addEventListener('click', hideResume);
  if (marginSel) {
    marginSel.value = pref.margin || 'mid';
    marginSel.addEventListener('change', function () {
      pref.margin = MARGIN_PRESET[marginSel.value] ? marginSel.value : 'mid';
      savePrefs();
      applyIframePrefs();
      setStatus('版心：' + ({ narrow: '窄边（行更长）', mid: '适中', wide: '宽边（行更短）' })[pref.margin]);
    });
  }
  if (paraSel) {
    paraSel.value = pref.para || 'normal';
    paraSel.addEventListener('change', function () {
      pref.para = PARA_GAP[paraSel.value] ? paraSel.value : 'normal';
      savePrefs();
      applyIframePrefs();
      setStatus('段距：' + ({ tight: '紧凑（靠缩进分段）', normal: '标准 0.55em', loose: '宽松 1em' })[pref.para]);
    });
  }
  if (punctBtn) {
    punctBtn.addEventListener('click', function () {
      if (punctBtn.disabled) { setStatus('当前 Chromium 不支持标点挤压，已按不支持降级'); return; }
      pref.punct = !pref.punct;
      savePrefs();
      applyPunct();
      setStatus(pref.punct
        ? ('标点挤压已开（' + punctTrimValue() + '）：行首标点收窄，字距不再被拉松' +
           (supportsCjkLatinSpacing() ? '；中西文间补 ¼ 空隙' : ''))
        : '标点挤压已关：标点按全角原宽排');
    });
  }
  if (typefaceSel) {
    typefaceSel.value = pref.typeface || 'mixed';
    typefaceSel.addEventListener('change', function () {
      const v = typefaceSel.value;
      pref.typeface = (['mixed', 'serif', 'sans', 'kai'].indexOf(v) >= 0) ? v : 'mixed';
      savePrefs();
      applyTypeface();
      setStatus('字体方案：' + (pref.typeface === 'mixed' ? '混排（宋体正文 / 黑体标题）' : pref.typeface === 'serif' ? '全宋体' : pref.typeface === 'sans' ? '全黑体' : '全楷体'));
    });
  }
  if (zoomInBtn) zoomInBtn.addEventListener('click', function () { changeZoom(0.1); });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', function () { changeZoom(-0.1); });
  if (styleFilterEl) styleFilterEl.addEventListener('click', onStyleFilterClick);
  if (hlGroup) hlGroup.addEventListener('click', onMarkClick);
  if (underlineBtn) underlineBtn.addEventListener('click', function () { safeRun(function () { return applyMark({ style: 'underline' }); }); });
  if (strikeBtn) strikeBtn.addEventListener('click', function () { safeRun(function () { return applyMark({ style: 'strike' }); }); });
  if (selBar) {
    // mousedown 阻止默认：点工具条不该把正文里的选区清掉
    selBar.addEventListener('mousedown', function (e) { e.preventDefault(); });
    selBar.addEventListener('click', onSelBarClick);
  }
  if (q9Tabs) q9Tabs.addEventListener('click', onQ9TabClick);
  if (q9List) {
    q9List.addEventListener('click', onQ9ListClick);
    // 草稿随手存：换阶 / 收起 / 存完重绘都不会把没写完的字弄丢
    q9List.addEventListener('input', function (e) {
      const ta = e.target;
      if (ta && ta.classList && ta.classList.contains('rr-q9-input')) {
        q9Draft[q9Key(q9Stage, q9Active)] = ta.value;
      }
    });
  }
  bindDivider(divLeft, 'left');
  bindDivider(divRight, 'right');
  document.addEventListener('keydown', onKeyDown);
}

// ---- 打开书籍 / 初始化 ----
async function openBook() {
  const open = await domain('reading.readerOpen', [BOOK_ID]);
  if (!open || open.ok === false) {
    const reason = (open && open.reason) || '未知原因';
    META = DEFAULT_META;
    SRC = { supported: false, reason: reason, kind: '', toc: [], chapterCount: 0 };
    TODAY = (open && open.today) ? open.today : todayStr();
    renderQ9();
    renderNotes([]);
    showUnsupported(reason);
    setStatus('无法打开阅读：' + reason);
    return;
  }
  BOOK = open.book || {};
  META = open.meta || DEFAULT_META;
  SRC = open.source || { supported: true, reason: '', kind: '', toc: [], chapterCount: 0 };
  TODAY = open.today || todayStr();

  let cc = Number(SRC.chapterCount);
  if (!isFinite(cc) || cc < 1) cc = (SRC.toc && SRC.toc.length) || 1;
  chapterCount = cc;

  if (bookTitleEl) bookTitleEl.textContent = BOOK.title || '未命名';
  if (badgeEl) badgeEl.textContent = (BOOK.format || '—').toUpperCase();
  setProgressText(BOOK.done, BOOK.total);

  renderLeft();
  renderToc(SRC.toc || []);

  const savedPos = readPos();
  const start = savedPos ? savedPos.chapter : readChapterPref();
  if (SRC.supported === false) {
    showUnsupported(SRC.reason || '该格式暂不支持解析');
    currentIndex = clamp(start, 0, Math.max(0, chapterCount - 1));
    if (chapterTitleEl) chapterTitleEl.textContent = '暂不支持预览';
    if (posEl) posEl.textContent = '0 / 0';
    highlightToc(currentIndex);
  } else {
    hideUnsupported();
    await loadChapter(start, savedPos ? { ratio: savedPos.ratio } : null);
  }
  await refreshNotes();
  await loadBookmarks();
  setStatus('已打开《' + (BOOK.title || '') + '》');
  // 位置已经自动跳好了，引导条只是把「你在哪、隔了多久」说清楚
  if (savedPos) setTimeout(function () { showResumeBar(savedPos); }, 600);
  initAsk();
  startTime();
}

async function init() {
  loadPrefs();
  applyWidths();
  switchLeftTab('toc');
  updateChrome();
  bindEvents();
  try { await openBook(); } catch (e) { showError(e); }
  subscribeDataChanged();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { safeRun(init); });
} else {
  safeRun(init);
}
