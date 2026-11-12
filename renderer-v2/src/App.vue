<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import NavSidebar from './components/NavSidebar.vue';
import GridEditor from './components/GridEditor.vue';
import ContextPanel from './components/ContextPanel.vue';
import StatusBar from './components/StatusBar.vue';
import DataCenter from './components/DataCenter.vue';
import QuickNote from './components/QuickNote.vue';
import GreetingBar from './components/GreetingBar.vue';
import InsightView from './components/InsightView.vue';
import ReviewView from './components/ReviewView.vue';
import CapsuleView from './components/CapsuleView.vue';
import HabitView from './components/HabitView.vue';
import DreamView from './views/DreamView.vue';
import DreamAlert from './components/DreamAlert.vue';
import SettingsView from './components/SettingsView.vue';
import BinView from './components/BinView.vue';
import WorkView from './views/WorkView.vue';
import MoneyView from './views/MoneyView.vue';
import StudyView from './views/StudyView.vue';
import CellView from './views/CellView.vue';
import FocusView from './views/FocusView.vue';
import LibraryView from './views/LibraryView.vue';
import LifeView from './views/LifeView.vue';
import RelationView from './views/RelationView.vue';
import ConnectView from './views/ConnectView.vue';
import LongView from './views/LongView.vue';
import ReadingView from './views/ReadingView.vue';
// 胶囊降级 + 自由记录三合一：胶囊的书写/到期走顶栏弹窗，三 tab 模块占原导航位
import CapsuleModal from './components/CapsuleModal.vue';
import FreeView from './views/FreeView.vue';
import { emptyRecord, localDate, GRID_KEYS, SKINS, type DiaryRecord, type SkinId, type ViewKey } from './types';
import { listDiaries, upsertDiary, flush, onDataChanged, isMockBridge, openFinance, onQuickCapture } from './bridge';
import { callDomain } from './composables/useDomain';
import { useTheme } from './composables/useTheme';
import { useWeather } from './composables/useWeather';
import { initI18n } from './i18n/useI18n';

const { skin, set: setSkin, load: loadTheme } = useTheme();
// 真实今天：统计、问候、往年今天、胶囊提醒、洞察一律锚定它，永远不变。
const today = localDate();
// 正在读写的日期：九格、基础栏、速记跟着它走。默认今天，补记时切到过去。
// 这两者必须分开——混用会出现"看昨天时本周数据变了"这种说不清的现象。
const selectedDate = ref(today);
const view = ref<ViewKey>('today');
// 九格双击进入的「该格主功能」：工作/收支/学习各有专属工作台，其余六格走通用单格页
const cellKey = ref('work');
const record = ref<DiaryRecord>(emptyRecord(today));
const total = ref(0);
const writtenDates = ref<string[]>([]);
const dirty = ref(false);
// GTD 中栏每改一次清单就自增，右栏据此重取（右栏只读，但读的是同一份数据）
const gtdTick = ref(0);
// 当前选中的 GTD 任务：中栏点一行 → 右栏换成它的详情。
// 只在这里存一份，中栏高亮与右栏表单都读它，避免两边各自记一份选中态。
const gtdSel = ref('');
// 当前选中的学习条目（考试 / 技能 / 主题共用一个 id 空间）：点一行 → 右栏换详情
const growthSel = ref('');
// 当前选中的梦想目标：中栏点一行 → 右栏换成它的量化 / 账户 / 日期 / 图片
const dreamSel = ref('');
const quickOpen = ref(false);
// 热键 / 托盘速记落哪一天：取**按键那一刻**的日期，不取保存那一刻（R-09 跨 00:00 落日）
const quickDate = ref(today);
// 胶囊：顶栏按钮 + 两个弹窗态（写新 / 到期）。角标只显示待开启数，不再占一级导航。
type CapTab = 'write' | 'due';
const capModalOpen = ref(false);
const capTab = ref<CapTab>('write');
const capDueCount = ref(0);
const backupTime = ref('—');
// 本机时间源是否开启：只影响底栏那条合规声明怎么写，不影响任何数据通路
const wtOn = ref(false);
// 首页天气开关：底栏的合规声明要按它改口（开了就不能再说「零网络」）
const weather = useWeather();
// 天气条浮层「记进今天」：用户点一次就把联网天气落进当天日记。
// 只改 base.weather 一个字段，其余基础栏与九格正文原样带回，不冲掉正在写的草稿；
// 看往日时拒绝写入——不能用今天的窗外去改那一天的日记。
weather.onSaveToToday(async function (w) {
  if (selectedDate.value !== today) {
    notify('当前看的是往日，请先回到今天再记天气');
    return false;
  }
  const next: DiaryRecord = JSON.parse(JSON.stringify(record.value));
  next.base = Object.assign({}, next.base || {}, { weather: w });
  await save(next);
  notify('今天的天气已记下：' + w);
  return true;
});
const toast = ref('');
let off: (() => void) | null = null;
let offQuick: (() => void) | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

const written = computed(() => Object.values(record.value.cells).join('').length);
// 左栏目录里的「已写」小圆点：只看当前这篇，不用去查历史
const todayFilled = computed(() => GRID_KEYS.filter((k) => !!record.value.cells[k]));
const isBackfill = computed(() => selectedDate.value !== today);

// ---- 左右两栏可拖拉缩放 ----
// 主理人 2026-11-08 22:32：两栏边界要能拖。宽度存 localStorage，关掉再开还是这个宽度；
// 双击手柄复位。中栏永远优先——两侧加起来不能把主栏挤到 420 以下。
const LAYOUT_KEY = 'jiuge.layout.v1';
const NAV_DEF = 240, NAV_MIN = 168, NAV_MAX = 360;
const RAIL_DEF = 300, RAIL_MIN = 240, RAIL_MAX = 520;
const CENTER_MIN = 420;
const navW = ref(NAV_DEF);
const railW = ref(RAIL_DEF);
const dragging = ref<'' | 'nav' | 'rail'>('');
const columnsEl = ref<HTMLElement | null>(null);

function clampW(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function loadLayout(): void {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as { nav?: number; rail?: number };
    if (typeof o.nav === 'number' && isFinite(o.nav)) navW.value = clampW(o.nav, NAV_MIN, NAV_MAX);
    if (typeof o.rail === 'number' && isFinite(o.rail)) railW.value = clampW(o.rail, RAIL_MIN, RAIL_MAX);
  } catch {
    // 坏值（手改过 / 隐私模式读不出）就用默认宽度，不影响启动
  }
}

function saveLayout(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ nav: navW.value, rail: railW.value }));
  } catch {
    // 写不进去就只在本轮生效，不弹窗打扰
  }
}

function startDrag(which: 'nav' | 'rail', ev: PointerEvent): void {
  // 窄屏左栏已图标化、右栏已隐藏，没有可拖的余地
  if (window.innerWidth < 1024) return;
  dragging.value = which;
  const el = ev.currentTarget as HTMLElement;
  if (el.setPointerCapture) el.setPointerCapture(ev.pointerId);
  ev.preventDefault();
}

function onDrag(ev: PointerEvent): void {
  if (!dragging.value || !columnsEl.value) return;
  const rect = columnsEl.value.getBoundingClientRect();
  if (dragging.value === 'nav') {
    const max = Math.max(NAV_MIN, Math.min(NAV_MAX, rect.width - railW.value - CENTER_MIN));
    navW.value = clampW(ev.clientX - rect.left, NAV_MIN, max);
  } else {
    const max = Math.max(RAIL_MIN, Math.min(RAIL_MAX, rect.width - navW.value - CENTER_MIN));
    railW.value = clampW(rect.right - ev.clientX, RAIL_MIN, max);
  }
}

function endDrag(): void {
  if (!dragging.value) return;
  dragging.value = '';
  saveLayout();
}

function resetLayout(): void {
  navW.value = NAV_DEF;
  railW.value = RAIL_DEF;
  saveLayout();
  notify('栏宽已恢复默认');
}

function nudge(which: 'nav' | 'rail', delta: number): void {
  if (which === 'nav') navW.value = clampW(navW.value + delta, NAV_MIN, NAV_MAX);
  else railW.value = clampW(railW.value + delta, RAIL_MIN, RAIL_MAX);
  saveLayout();
}

// 顶栏色点：SKINS 里 id 是字符串，useTheme.set 收 SkinId，模板里不做类型断言
function pickSkin(id: string): void {
  void setSkin(id as SkinId);
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const selectedLabel = computed(() => {
  const d = selectedDate.value;
  if (d === today) return '今天';
  const parts = d.split('-');
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return '补记 ' + Number(parts[1]) + '月' + Number(parts[2]) + '日 · 周' + WEEK[dt.getDay()];
});

const viewLabel = computed(() => ({
  today: '今天', insight: '单格洞察', cell: '单格工作台', timeline: '时间轴', review: '回顾', capsule: '胶囊',
  habit: '坚持', dream: '梦想', data: '数据中心', bin: '封存箱', inspire: '语料库', settings: '设置',
  life: '时间纵深', relation: '关系经营', connect: '内容连接', long: '长期形状', reading: '图书馆', finance: '家庭账本',
  free: '自由记录'
}[view.value]));

function shiftDate(delta: number): string {
  const parts = selectedDate.value.split('-');
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  dt.setDate(dt.getDate() + delta);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

// 切日期时主动换记录：找不到就换成空记录，绝不把上一篇的内容留在这一天上。
// （refresh() 相反，只在命中时更新，避免把用户正在输入的内容冲掉。）
async function goDate(next: string): Promise<void> {
  if (next > today) {
    notify('还没到那一天，只能补记过去');
    return;
  }
  selectedDate.value = next;
  try {
    const res = await listDiaries({ pageSize: 500 });
    const hit = res.items.find((r) => r.date === next);
    record.value = hit || emptyRecord(next);
  } catch {
    record.value = emptyRecord(next);
  }
}

function goToday(): void {
  void goDate(today);
}

async function refresh(): Promise<void> {
  try {
    const res = await listDiaries({ pageSize: 500 });
    total.value = res.total;
    writtenDates.value = res.items.map((r) => r.date);
    const current = res.items.find((r) => r.date === selectedDate.value);
    if (current) record.value = current;
  } catch {
    // 桥接不可用时保持空记录，界面仍可操作
  }
}

async function save(next: DiaryRecord): Promise<void> {
  dirty.value = true;
  try {
    const res = await upsertDiary(next, 'view-' + next.date + '-' + Date.now());
    record.value = res.record;
    await refresh();
  } finally {
    dirty.value = false;
  }
}

function navigate(key: ViewKey): void {
  view.value = key;
  // 离开工作台/学习台/梦想页就清掉选中：右栏换页后不该还挂着上一条
  if (key !== 'cell') { gtdSel.value = ''; growthSel.value = ''; }
  if (key !== 'dream') dreamSel.value = '';
  // 底栏声明跟着开关走：刚在设置里改过，回来必须立刻改口
  void refreshWtOn();
}

async function refreshWtOn(): Promise<void> {
  const m = await callDomain<{ enabled: boolean } | null>('worktime.meta', null);
  wtOn.value = !!(m && m.enabled);
}

// 九格 → 该格主功能。不占一级导航：它是「从格子里进去」的第二层入口。
function openCell(key: string): void {
  // 九格第 9 格与一级导航「自由记录」是同一个视图：入口唯一，不再开单格书写台。
  if (key === 'free') { navigate('free'); return; }
  if (key !== 'work') gtdSel.value = '';
  if (key !== 'growth') growthSel.value = '';
  dreamSel.value = '';
  cellKey.value = key;
  view.value = 'cell';
}

function openInsight(key: string): void {
  cellKey.value = key;
  view.value = 'insight';
}

function notify(text: string): void {
  toast.value = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.value = ''; }, 2600);
}

// 速记四处分流：一句话写完，去处决定它变成什么。
// 自由格=当日记、收件箱=当待办、胶囊=封起来、参考资料=先存着（没有独立资料库，用 #资料 标记）。
// 全局热键 / 托盘速记（R-09）：收到就切到**按键那一刻**的那一天，再开浮窗。
// 必须切日子：quickSaved 写的是 record.value（当前选中日），
// 不切的话「23:59 按键、00:01 保存」会落进错的一天。
async function openQuickCapture(p: { date?: string; source?: string }): Promise<void> {
  const day = p && p.date ? String(p.date) : today;
  quickDate.value = day;
  if (day !== selectedDate.value) {
    try {
      await goDate(day);
    } catch {
      // 切不过去也不阻断速记：至少浮窗能开，文本不丢
    }
  }
  quickOpen.value = true;
  await nextTick();
}

async function quickSaved(payload: { target: string; text: string; openAt: string }): Promise<void> {
  const text = String(payload.text || '').trim();
  if (!text) return;
  try {
    if (payload.target === 'gtd') {
      await callDomain('gtd.add', null, { title: text.slice(0, 80), status: 'inbox' });
      quickOpen.value = false;
      notify('已进 GTD 收件箱，等厘清');
      return;
    }
    if (payload.target === 'capsule') {
      const res = await callDomain<{ error?: string } | null>('saveCapsule', null, text, payload.openAt);
      if (res && res.error) {
        // 失败不关窗：文本还在，改个日期就能重试
        notify('胶囊没存成：' + res.error + '（开启日期要晚于今天）');
        return;
      }
      quickOpen.value = false;
      notify('已封成胶囊 · ' + payload.openAt + ' 才能打开');
      return;
    }
    const base = JSON.parse(JSON.stringify(record.value)) as DiaryRecord;
    const body = payload.target === 'ref' ? '#资料 ' + text : text;
    base.cells.free = (base.cells.free || '') + (base.cells.free ? '\n' : '') + body;
    await save(base);
    quickOpen.value = false;
    notify(payload.target === 'ref' ? '已标 #资料 存进「自由」格' : '速记已写入「自由」格');
  } catch {
    // 保存失败：保留浮窗与已输入文本，不静默丢字，供用户重试
    notify('保存失败，文本已保留，请重试');
  }
}

// 胶囊角标与「到期主动弹」：每日最多一次；用户一有动作就取消自动弹，避免打断手上的事。
async function refreshDueCapsules(): Promise<number> {
  const list = await callDomain<unknown[]>('dueCapsules', []);
  const n = Array.isArray(list) ? list.length : 0;
  capDueCount.value = n;
  return n;
}
function openCapsuleModal(which: CapTab): void {
  capTab.value = which;
  capModalOpen.value = true;
  void refreshDueCapsules();
}

async function openDataDir(): Promise<void> {
  await flush('statusbar');
}

// Ctrl+←/→ 前后一天。落在输入框里的 Ctrl+方向键是系统「按词移动光标」，不能抢。
function onKeydown(ev: KeyboardEvent): void {
  if (!ev.ctrlKey || ev.altKey || ev.shiftKey) return;
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  const el = ev.target as HTMLElement | null;
  const tag = el ? el.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
  ev.preventDefault();
  void goDate(shiftDate(ev.key === 'ArrowLeft' ? -1 : 1));
}

onMounted(async () => {
  initI18n();
  loadLayout();
  await loadTheme();
  await refresh();
  off = onDataChanged(() => { void refresh(); });
  // 全局热键 / 托盘速记：主进程推「现在可以记了」，这里负责切日 + 开浮窗（R-09）
  offQuick = onQuickCapture((p) => { void openQuickCapture(p); });
  window.addEventListener('keydown', onKeydown);
  void refreshWtOn();
  // 天气走独立状态源（useWeather 单例）：这里只负责首屏取一次，
  // 组件自己订阅同一份状态，设置页改完开关立刻反映到底栏与问候头。
  void weather.init();
  // 启动 / 每日首次：有待开启胶囊就主动弹「到期」态；1.5 秒内用户一动就取消。
  const due = await refreshDueCapsules();
  if (due > 0) {
    const stamp = 'jiuge.capsuleDuePrompt.' + today;
    let already = false;
    try { already = !!localStorage.getItem(stamp); } catch (e) { already = false; }
    if (!already) {
      let cancelled = false;
      const cancel = function () { cancelled = true; };
      window.addEventListener('pointerdown', cancel, { once: true });
      window.setTimeout(function () {
        if (cancelled) return;
        try { localStorage.setItem(stamp, '1'); } catch (e) { /* 存不住也不影响本次提醒 */ }
        capTab.value = 'due';
        capModalOpen.value = true;
      }, 1500);
    }
  }
});

onUnmounted(() => {
  if (off) off();
  if (offQuick) offQuick();
  if (toastTimer) clearTimeout(toastTimer);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="workbench" :data-skin="skin" data-surface="light">
    <header class="titlebar">
      <strong class="brand">九格手记 · 个人记录工作台</strong>
      <!-- 补记：日期导航常驻标题栏。切到过去时整条变色，避免"以为在写今天" -->
      <div class="date-nav" :class="{ 'date-backfill': isBackfill }">
        <button class="dn-btn" aria-label="前一天" title="前一天（Ctrl+←）" @click="goDate(shiftDate(-1))">‹</button>
        <span class="dn-label" :class="{ 'dn-past': isBackfill }">{{ selectedLabel }}</span>
        <button
          class="dn-btn"
          aria-label="后一天"
          title="后一天（Ctrl+→）"
          :disabled="selectedDate >= today"
          :aria-disabled="selectedDate >= today"
          @click="goDate(shiftDate(1))"
        >›</button>
        <button v-if="isBackfill" class="dn-today" @click="goToday">回到今天</button>
      </div>
      <span class="view-crumb">{{ viewLabel }}</span>
      <span class="spacer"></span>
      <!-- 单格洞察从左栏二级目录上移到这里：它是「看」的入口，不是「写」的一格，
           放左栏会让九格目录里混进一个不同类的东西（主理人 2026-11-08 23:16） -->
      <button
        class="insight-btn"
        :class="{ 'insight-on': view === 'insight' }"
        :aria-current="view === 'insight' ? 'page' : undefined"
        @click="navigate('insight')"
      >单格洞察</button>
      <!-- 图书馆是重功能但不属「今天 / 回看 / 数据」任何一条线：沿用单格洞察上顶栏的先例。
           一级导航仍 7 项 + 设置（GUI #122 锁住），高频入口也不必藏进二级目录。 -->
      <button
        class="reading-btn"
        :class="{ 'reading-on': view === 'reading' }"
        :aria-current="view === 'reading' ? 'page' : undefined"
        @click="navigate('reading')"
      >图书馆</button>
      <!-- 家庭账本：重功能走独立窗口（左中右三栏），一级导航仍锁 7 项 + 设置。
           主窗只负责「开窗」这一个动作，窗口句柄与数据都不经过这里。 -->
      <button
        class="finance-btn"
        @click="openFinance()"
      >记账</button>
      <!-- 皮肤从右栏底部收上来：全局面板不该在每一页的右栏里重复一遍 -->
      <div class="skin-pick" role="radiogroup" aria-label="界面皮肤">
        <span v-for="s in SKINS" :key="s.id" class="skin-dot-wrap" :data-skin="s.id">
          <button
            class="skin-dot"
            :class="{ 'skin-dot-on': skin === s.id }"
            role="radio"
            :aria-checked="skin === s.id"
            :aria-label="s.label"
            :title="s.label"
            @click="pickSkin(s.id)"
          ></button>
        </span>
      </div>
      <!-- 胶囊：功能单一，从一级导航降到这里；书写与到期都在弹窗内闭环 -->
      <button
        class="capsule-btn"
        :class="{ 'capsule-on': capModalOpen }"
        :aria-expanded="capModalOpen"
        title="胶囊 · 写新 / 今日到期"
        @click="openCapsuleModal('write')"
      >胶囊<span v-if="capDueCount" class="cap-badge">{{ capDueCount }}</span></button>
      <button
        class="quick-btn"
        :class="{ 'quick-on': quickOpen }"
        :aria-expanded="quickOpen"
        @click="quickOpen = !quickOpen"
      >＋ 快速记录</button>
      <button
        class="settings-btn"
        :class="{ 'settings-on': view === 'settings' }"
        :aria-current="view === 'settings' ? 'page' : undefined"
        @click="navigate('settings')"
      >设置</button>
    </header>

    <div
      class="columns"
      ref="columnsEl"
      :style="{ '--nav-w': navW + 'px', '--rail-w': railW + 'px' }"
      :class="{ 'col-dragging': !!dragging }"
    >
      <NavSidebar
        :active="view"
        :written-dates="writtenDates"
        :total="total"
        :cell-key="cellKey"
        :filled-keys="todayFilled"
        @navigate="navigate"
        @open-cell="openCell"
      />

      <!-- 左边界可拖：拖动改左栏宽度，双击复位，方向键 ±16px -->
      <div
        class="col-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        title="拖动调整左栏宽度（双击恢复默认，方向键微调）"
        tabindex="0"
        @pointerdown="startDrag('nav', $event)"
        @pointermove="onDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @dblclick="resetLayout"
        @keydown.left.prevent="nudge('nav', -16)"
        @keydown.right.prevent="nudge('nav', 16)"
      ></div>

      <main class="center">
        <template v-if="view === 'today'">
          <!-- 补记时顶部明示，并说清统计口径：右侧与问候条的统计仍按真实今天算 -->
          <div v-if="isBackfill" class="backfill-banner" role="status">
            <span class="bf-dot" aria-hidden="true"></span>
            <span class="bf-text">
              正在补记 <strong>{{ selectedDate }}</strong> · 统计仍按真实今天
            </span>
            <button class="bf-btn" @click="goToday">回到今天</button>
          </div>
          <!-- 提示语 + 名人名言固定在中栏最顶部，九格之前 -->
          <GreetingBar :today="today" :total="total" @navigate="navigate" />
          <!-- 今日六条已并入九格「今日六条」格：今日页顶部不再单独占一条横条 -->
          <GridEditor
            :record="record"
            :total="total"
            :date="selectedDate"
            :backfill="isBackfill"
            @save="save"
            @open-cell="openCell"
          />
          <!-- 今日状态（基础栏 4 项）与三块快速录入面板已移到右栏「本页选项」：
               主栏只留九格与写作，右栏承担这一页的配置与关联信息（主理人 2026-11-08 22:32） -->
        </template>
        <!-- 九格双击进入的该格主功能：三格有专属工作台，其余六格走通用单格页 -->
        <template v-else-if="view === 'cell'">
          <WorkView
            v-if="cellKey === 'work'"
            :record="record"
            :selected="gtdSel"
            :tick="gtdTick"
            @back="navigate('today')"
            @notify="notify"
            @save="save"
            @select-task="gtdSel = $event"
            @changed="gtdTick += 1"
            @navigate="navigate"
          />
          <MoneyView
            v-else-if="cellKey === 'money'"
            :record="record"
            @back="navigate('today')"
            @notify="notify"
            @save="save"
          />
          <StudyView
            v-else-if="cellKey === 'growth'"
            :record="record"
            :selected="growthSel"
            :tick="gtdTick"
            @back="navigate('today')"
            @save="save"
            @notify="notify"
            @select-item="growthSel = $event"
            @changed="gtdTick += 1"
          />
          <!-- 今日六条：原中栏横条并入「未来」格后的专属工作台（挑六件 + 给今天留一句） -->
          <FocusView
            v-else-if="cellKey === 'future'"
            :record="record"
            @back="navigate('today')"
            @save="save"
            @notify="notify"
          />
          <CellView
            v-else
            :cell-key="cellKey"
            :record="record"
            @back="navigate('today')"
            @save="save"
            @open-insight="openInsight"
          />
        </template>
        <InsightView v-else-if="view === 'insight'" :key="'insight-' + cellKey" :initial-key="cellKey" />
        <!-- 时间轴只有日记子模块；回顾只有复盘子模块；概览在单格洞察下方 -->
        <ReviewView v-else-if="view === 'timeline'" mode="timeline" />
        <LifeView
          v-else-if="view === 'life'"
          @back="navigate('today')"
          @go-timeline="navigate('timeline')"
          @go-date="navigate('timeline')"
          @notify="notify"
        />
        <RelationView
          v-else-if="view === 'relation'"
          @back="navigate('today')"
          @go-date="navigate('timeline')"
          @go-cell="openCell"
          @notify="notify"
        />
        <ConnectView
          v-else-if="view === 'connect'"
          @back="navigate('today')"
          @go-date="navigate('timeline')"
          @go-cell="openCell"
          @notify="notify"
        />
        <LongView
          v-else-if="view === 'long'"
          @back="navigate('today')"
          @go-date="navigate('timeline')"
          @go-cell="openCell"
          @notify="notify"
        />
        <ReviewView v-else-if="view === 'review'" mode="retro" />
        <FreeView v-else-if="view === 'free'" @notify="notify" />
        <!-- 旧 ViewKey 分支保留作兼容（命令面板等旧入口），主入口已是顶栏弹窗 -->
        <CapsuleView v-else-if="view === 'capsule'" />
        <HabitView v-else-if="view === 'habit'" />
        <DreamView
          v-else-if="view === 'dream'"
          :selected="dreamSel"
          :tick="gtdTick"
          @notify="notify"
          @changed="gtdTick += 1"
          @select-dream="dreamSel = $event"
          @open-cell="openCell"
        />
        <DataCenter v-else-if="view === 'data'" :total="total" @open-bin="navigate('bin')" />
        <BinView v-else-if="view === 'bin'" />
        <LibraryView v-else-if="view === 'inspire'" @notify="notify" />
        <!-- 图书馆：两类阅读 + 读书笔记；九格回写只追加、只写真实今天 -->
        <ReadingView
          v-else-if="view === 'reading'"
          :record="record"
          :today="today"
          :backfill="isBackfill"
          @back="navigate('today')"
          @save="save"
          @notify="notify"
          @changed="gtdTick += 1"
          @open-cell="openCell"
        />
        <!-- 家庭账本已迁到独立窗口：主窗不再内嵌第二套账本界面，避免同一份数据两套 UI -->
        <SettingsView v-else @go-data="navigate('data')" @notify="notify" @wt-changed="refreshWtOn" />
      </main>

      <!-- 右边界可拖：往左拖右栏变宽（右栏是「读」的那一侧，宽窄随内容走） -->
      <div
        class="col-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右栏宽度"
        title="拖动调整右栏宽度（双击恢复默认，方向键微调）"
        tabindex="0"
        @pointerdown="startDrag('rail', $event)"
        @pointermove="onDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @dblclick="resetLayout"
        @keydown.left.prevent="nudge('rail', 16)"
        @keydown.right.prevent="nudge('rail', -16)"
      ></div>

      <ContextPanel
        :view="view"
        :cell-key="cellKey"
        :record="record"
        :total="total"
        :written="written"
        :today="today"
        :tick="gtdTick"
        :task-id="gtdSel"
        :item-id="growthSel"
        :dream-id="dreamSel"
        @navigate="navigate"
        @open-cell="openCell"
        @open-insight="openInsight"
        @select-task="gtdSel = $event"
        @select-item="growthSel = $event"
        @select-dream="dreamSel = $event"
        @changed="gtdTick += 1"
        @save="save"
        @notify="notify"
      />
    </div>

    <!-- 梦想账户存够 → 浮窗提醒走下一步，直到这条目标被标记达成 -->
    <DreamAlert :tick="gtdTick" @go="navigate('dream')" />

    <StatusBar
      :total="total"
      :backup-time="backupTime"
      :dirty="dirty"
      :mock="isMockBridge"
      :wt-on="wtOn"
      :wx-on="weather.state.enabled"
      @open-data-dir="openDataDir"
    />

    <CapsuleModal
      v-if="capModalOpen"
      :tab="capTab"
      @close="capModalOpen = false; void refreshDueCapsules()"
      @due-changed="refreshDueCapsules()"
    />

    <QuickNote
      v-if="quickOpen"
      :date="quickDate"
      @close="quickOpen = false"
      @saved="quickSaved"
    />

    <div v-if="toast" class="toast" :class="{ 'toast-on': !!toast }" role="status">{{ toast }}</div>
  </div>
</template>

<style scoped>
.workbench {
  position: relative;
  height: 100%;
  display: grid;
  /* 底栏只承载读数与一句合规声明，22px 足够；高度让给内容 */
  grid-template-rows: 44px minmax(0, 1fr) 22px;
  background: var(--surface-bg);
}
.titlebar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  background: var(--palette-primary);
  color: var(--palette-on);
}
.brand { font-weight: 500; font-size: 14px; }
.view-crumb { font-size: 12px; opacity: 0.8; }

/* 补记：日期导航常驻标题栏，切到过去时整条变琥珀色 */
.date-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 1px 4px;
  border-radius: var(--radius-md);
  border: 0.5px solid rgba(255, 255, 255, 0.18);
}
.date-backfill {
  border-color: rgba(246, 193, 119, 0.7);
  background: rgba(246, 193, 119, 0.14);
}
.dn-btn {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  border-radius: 4px;
  opacity: 0.85;
}
.dn-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); }
.dn-btn:disabled { opacity: 0.3; cursor: default; }
.dn-label { font-size: 12px; min-width: 46px; text-align: center; }
.dn-past { color: #f6c177; font-weight: 500; }
.dn-today {
  margin-left: 4px;
  padding: 1px 8px;
  font-size: 11px;
  border: 0.5px solid rgba(246, 193, 119, 0.7);
  border-radius: 999px;
  background: transparent;
  color: #f6c177;
  cursor: pointer;
}
.dn-today:hover { background: rgba(246, 193, 119, 0.18); }

.backfill-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 12px;
  margin-bottom: var(--space-3);
  border: 0.5px solid var(--state-warn);
  background: var(--state-warn-soft);
  border-radius: var(--radius-md);
  font-size: 12px;
}
.bf-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--state-warn); flex: none; }
.bf-text { flex: 1; }
.bf-sub { opacity: 0.75; }
.bf-btn {
  padding: 2px 10px;
  font-size: 11px;
  cursor: pointer;
  border: 0.5px solid var(--state-warn);
  border-radius: 999px;
  background: transparent;
  color: var(--state-warn);
}
.spacer { flex: 1; }
.quick-btn, .settings-btn, .insight-btn, .reading-btn, .finance-btn, .capsule-btn {
  padding: 4px 12px;
  border: 0.5px solid rgba(255, 255, 255, 0.4);
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
}
.quick-on, .settings-on, .insight-on, .reading-on, .finance-on, .capsule-on { background: var(--palette-on); color: var(--palette-primary); }
.cap-badge { display: inline-block; min-width: 15px; padding: 0 4px; margin-left: 5px; border-radius: 9px; background: var(--palette-accent); color: var(--palette-on); font-size: 10px; line-height: 15px; }
.columns {
  display: flex;
  min-height: 0;
  min-width: 0;
}
/* 左右两栏宽度由 --nav-w / --rail-w 决定（拖手柄时由 JS 改值），中栏吃掉剩余空间 */
.columns :deep(.nav) { flex: 0 0 auto; width: var(--nav-w, 240px); min-width: 0; }
.columns :deep(.context) { flex: 0 0 auto; width: var(--rail-w, 300px); min-width: 0; }
.center { flex: 1 1 auto; overflow: auto; padding: var(--space-4); min-width: 0; }

/* 边界线：命中区 6px，视觉只在 hover / 聚焦 / 拖动时给 2px 高亮——平时不画线，不跟九格抢眼 */
.col-divider {
  flex: 0 0 6px;
  position: relative;
  cursor: col-resize;
  background: transparent;
  outline: none;
}
.col-divider::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  right: 2px;
  border-radius: 2px;
  background: transparent;
  transition: background 0.12s;
}
.col-divider:hover::after,
.col-divider:focus-visible::after { background: var(--palette-border); }
.col-dragging { user-select: none; }
.col-dragging .col-divider::after { background: var(--palette-primary); }

/* 顶栏皮肤色点：色值来自各皮肤自己的 --palette-primary（外层 data-skin 提供作用域） */
.skin-pick { display: flex; align-items: center; gap: 6px; padding-right: 2px; }
.skin-dot-wrap { display: inline-flex; }
.skin-dot {
  width: 14px;
  height: 14px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.7);
  background: var(--palette-primary);
  cursor: pointer;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.skin-dot:focus-visible { outline: 2px solid var(--palette-on); outline-offset: 2px; }
.skin-dot-on { border-color: var(--palette-on); box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.22); }
.toast {
  position: absolute;
  right: var(--space-4);
  bottom: 44px;
  padding: 8px 16px;
  border-radius: var(--radius-lg);
  background: var(--palette-primary);
  color: var(--palette-on);
  font-size: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}
.toast-on { border: 0.5px solid var(--palette-border); }
@media (max-width: 1024px) {
  /* 窄屏：中栏优先。左栏图标化、右栏让位，手柄随之隐藏（拖也拖不出空间） */
  .col-divider { display: none; }
  .columns :deep(.nav) { width: 64px; }
  .columns :deep(.context) { display: none; }
  .center { padding: var(--space-2); }
}
</style>
