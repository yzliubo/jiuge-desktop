<script setup lang="ts">
// 长线视图：节气刻度 / 跨模块弱引用 / 单条加密 / 链接型附件 / 主目标提示。
// 全部取数走唯一出境口 domainCall；本文件只做展示与轻交互，不写任何文件、不留后门。
// 类型与接口都定义在本文件内，不对外导出。
import { ref, computed, onMounted } from 'vue';
import { domainCall } from '../bridge';
import { localDate } from '../types';

/* ---------------- 通用 ---------------- */
const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'notify', msg: string): void;
  (e: 'go-date', date: string): void;
  (e: 'go-cell', key: string): void;
}>();

type TabKey = 'term' | 'trace' | 'secure' | 'attach' | 'goal';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'term', label: '节气复盘' },
  { key: 'trace', label: '跨模块引用层' },
  { key: 'secure', label: '单条加密' },
  { key: 'attach', label: '链接型附件' },
  { key: 'goal', label: '主目标倒计时' }
];
const tab = ref<TabKey>('term');
const flash = ref('');

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function note(msg: string): void {
  flash.value = msg;
  emit('notify', msg);
  setTimeout(function () { if (flash.value === msg) flash.value = ''; }, 3200);
}
function fmtTime(t: unknown): string {
  const n = typeof t === 'number' ? t : Number(t);
  if (!isFinite(n) || n <= 0) return '时间未记录';
  const d = new Date(n);
  return isNaN(d.getTime()) ? '时间未记录' : localDate(d);
}

function switchTab(k: TabKey): void {
  tab.value = k;
  if (k === 'term') void loadTerm();
  else if (k === 'trace') void loadTrace();
  else if (k === 'attach') void loadAttach();
  else if (k === 'goal') void loadGoal();
  // secure 无远程取数，切换即用
}
onMounted(function () { void loadTerm(); });

/* ---------------- 一、节气复盘 ---------------- */
interface TermCurrent {
  name: string; index: number; next: string; daysLeft: number; hou: string; key: string;
}
interface TermMeta { TERMS: string[]; MAX_REVIEWS: number; }
interface TermReview { termKey: string; answers: unknown; savedAt: unknown; }

const termCurrent = ref<TermCurrent | null>(null);
const termMeta = ref<TermMeta | null>(null);
const reviews = ref<TermReview[]>([]);
const termErr = ref('');
const termLoaded = ref(false);
const answer1 = ref('');
const answer2 = ref('');
const answer3 = ref('');

async function loadReviews(): Promise<void> {
  try {
    reviews.value = await domainCall<TermReview[]>('term.reviews');
  } catch (e) {
    termErr.value = (termErr.value ? termErr.value + '；' : '') + '复盘列表读取失败：' + errMsg(e);
  }
}
async function loadTerm(): Promise<void> {
  termLoaded.value = false;
  termErr.value = '';
  try {
    termCurrent.value = await domainCall<TermCurrent>('term.current');
  } catch (e) {
    termErr.value = '当前节气读取失败：' + errMsg(e);
  }
  try {
    termMeta.value = await domainCall<TermMeta>('term.meta');
  } catch (e) {
    termErr.value = (termErr.value ? termErr.value + '；' : '') + '节气元信息读取失败：' + errMsg(e);
  }
  await loadReviews();
  termLoaded.value = true;
}
async function saveReview(): Promise<void> {
  if (!termCurrent.value || !termCurrent.value.key) {
    termErr.value = '当前节气键不可用，暂时无法保存复盘。';
    return;
  }
  const q1 = answer1.value.trim();
  const q2 = answer2.value.trim();
  const q3 = answer3.value.trim();
  if (!q1 && !q2 && !q3) {
    termErr.value = '三问都空着，先写一句再保存。';
    return;
  }
  termErr.value = '';
  try {
    await domainCall<unknown>('term.save', termCurrent.value.key, { q1, q2, q3 });
    answer1.value = ''; answer2.value = ''; answer3.value = '';
    await loadReviews();
    note('已保存本节气三问复盘');
  } catch (e) {
    termErr.value = '复盘保存失败：' + errMsg(e);
  }
}
function reviewText(r: TermReview): string {
  const a = r.answers;
  if (Array.isArray(a)) {
    const parts = a.filter(function (x) { return String(x).length > 0; })
      .map(function (x, i) { return (i + 1) + '. ' + String(x); });
    return parts.length ? parts.join('　') : '（空）';
  }
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    const qs = ['q1', 'q2', 'q3'];
    const parts = qs.filter(function (k) { return !!o[k]; })
      .map(function (k) { return k + '：' + String(o[k]); });
    const rest = Object.keys(o).filter(function (k) { return qs.indexOf(k) < 0 && !!o[k]; })
      .map(function (k) { return k + '：' + String(o[k]); });
    const all = parts.concat(rest);
    return all.length ? all.join('　') : '（空）';
  }
  return a ? String(a) : '（空）';
}

/* ---------------- 二、跨模块引用层 ---------------- */
interface TraceItem { id: string; from: string; to: string; note: string; createdAt: number | string; }

const traceList = ref<TraceItem[]>([]);
const traceFiltered = ref<TraceItem[] | null>(null);
const missingIds = ref<string[]>([]);
const traceErr = ref('');
const traceLoaded = ref(false);
const traceFilter = ref('');
const trFrom = ref('');
const trTo = ref('');
const trNote = ref('');

const shownTrace = computed<TraceItem[]>(function () {
  return traceFiltered.value !== null ? traceFiltered.value : traceList.value;
});

function toIds(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter(function (x) { return typeof x === 'string'; }).map(String);
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.ids)) {
      return (o.ids as unknown[]).filter(function (x) { return typeof x === 'string'; }).map(String);
    }
    return Object.keys(o).filter(function (k) { return !!o[k]; });
  }
  return [];
}
async function loadTrace(): Promise<void> {
  traceLoaded.value = false;
  traceErr.value = '';
  try {
    traceList.value = await domainCall<TraceItem[]>('trace.all');
  } catch (e) {
    traceErr.value = '引用列表读取失败：' + errMsg(e);
    traceLoaded.value = true;
    return;
  }
  try {
    const ids = traceList.value.map(function (x) { return x.id; });
    missingIds.value = toIds(await domainCall<unknown>('trace.missing', ids));
  } catch (e) {
    // 缺失检测失败时保守处理：宁可不标灰，也不误报目标已不在
    missingIds.value = [];
    traceErr.value = '目标缺失检测失败：' + errMsg(e);
  }
  traceLoaded.value = true;
}
async function queryTrace(): Promise<void> {
  const target = traceFilter.value.trim();
  if (!target) { traceFiltered.value = null; return; }
  try {
    traceFiltered.value = await domainCall<TraceItem[]>('trace.for', target);
    traceErr.value = '';
  } catch (e) {
    traceErr.value = '按目标查询失败：' + errMsg(e);
  }
}
function clearFilter(): void { traceFiltered.value = null; traceFilter.value = ''; }
async function addTrace(): Promise<void> {
  const f = trFrom.value.trim();
  const t = trTo.value.trim();
  const n = trNote.value.trim();
  if (!f || !t) {
    traceErr.value = 'from 与 to 都要填，形如 diary:2026-11-07 / gtd:<id>。';
    return;
  }
  try {
    await domainCall<unknown>('trace.add', { from: f, to: t, note: n });
    trFrom.value = ''; trTo.value = ''; trNote.value = '';
    traceFiltered.value = null;
    await loadTrace();
    note('已新建引用');
  } catch (e) {
    traceErr.value = '新建引用失败：' + errMsg(e);
  }
}
async function removeTrace(id: string): Promise<void> {
  try {
    await domainCall<unknown>('trace.remove', id);
    await loadTrace();
    note('已删除该引用');
  } catch (e) {
    traceErr.value = '删除引用失败：' + errMsg(e);
  }
}
function refKind(t: string): string {
  const i = t.indexOf(':');
  if (i < 1) return '';
  const k = t.slice(0, i);
  const v = t.slice(i + 1);
  if (k === 'diary' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
  if (k === 'cell' && v.length > 0) return 'cell';
  return '';
}
function canJump(t: string): boolean { return refKind(t) !== ''; }
function onRef(t: string): void {
  const v = t.slice(t.indexOf(':') + 1);
  if (refKind(t) === 'date') emit('go-date', v);
  else if (refKind(t) === 'cell') emit('go-cell', v);
}

/* ---------------- 三、单条加密 ---------------- */
interface CipherBlob { v: number | string; salt: string; iv: string; tag: string; data: string; }

const secPlain = ref('');
const secPass = ref('');
const secCheck = ref('');
const cipher = ref<CipherBlob | null>(null);
const decrypted = ref('');
const verified = ref<boolean | null>(null);
const secureErr = ref('');

const cipherJson = computed<string>(function () {
  return cipher.value ? JSON.stringify(cipher.value, null, 2) : '';
});

async function doEncrypt(): Promise<void> {
  secureErr.value = '';
  decrypted.value = '';
  verified.value = null;
  if (!secPlain.value) { secureErr.value = '明文为空，没有可加密的内容。'; return; }
  if (!secPass.value) { secureErr.value = '请填写加密口令。'; return; }
  try {
    cipher.value = await domainCall<CipherBlob>('secure.encrypt', secPlain.value, secPass.value);
    note('已加密：密文对象仅留在内存，未写入任何文件');
  } catch (e) {
    secureErr.value = '加密失败：' + errMsg(e);
  }
}
async function doDecrypt(): Promise<void> {
  secureErr.value = '';
  decrypted.value = '';
  verified.value = null;
  if (!cipher.value) { secureErr.value = '还没有密文，先加密一段明文。'; return; }
  if (!secCheck.value) { secureErr.value = '请输入口令。'; return; }
  try {
    // 只有完整成功才赋值；失败时 decrypted 保持为空，绝不显示部分明文
    decrypted.value = await domainCall<string>('secure.decrypt', cipher.value, secCheck.value);
  } catch (e) {
    decrypted.value = '';
    secureErr.value = '解密失败：口令错误或密文被篡改，不显示任何明文。';
  }
}
async function doVerify(): Promise<void> {
  secureErr.value = '';
  decrypted.value = '';
  if (!cipher.value) { secureErr.value = '还没有密文，先加密一段明文。'; return; }
  if (!secCheck.value) { secureErr.value = '请输入口令。'; return; }
  try {
    // 只验口令，不返回、也不展示明文
    verified.value = await domainCall<boolean>('secure.verify', cipher.value, secCheck.value);
  } catch (e) {
    verified.value = null;
    secureErr.value = '校验失败：' + errMsg(e);
  }
}
async function copyCipher(): Promise<void> {
  if (!cipherJson.value) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(cipherJson.value);
      note('密文 JSON 已复制到剪贴板（未写入任何文件）');
    } else {
      note('当前环境不支持剪贴板，请手动选中密文文本复制');
    }
  } catch (e) {
    note('复制失败，请手动选中密文文本复制');
  }
}

/* ---------------- 四、链接型附件 ---------------- */
interface AttachItem {
  id: string; path: string; name: string; size: number; mtime: number | string; broken: boolean;
}

const attachList = ref<AttachItem[]>([]);
const attachErr = ref('');
const attachLoaded = ref(false);
const atPath = ref('');
const atCandidates = ref('');

async function loadAttach(): Promise<void> {
  attachLoaded.value = false;
  attachErr.value = '';
  try {
    attachList.value = await domainCall<AttachItem[]>('attach.list');
  } catch (e) {
    attachErr.value = '附件列表读取失败：' + errMsg(e);
  }
  attachLoaded.value = true;
}
async function addAttach(): Promise<void> {
  const p = atPath.value.trim();
  if (!p) { attachErr.value = '请填写文件完整路径。'; return; }
  try {
    const r = await domainCall<AttachItem | null>('attach.add', p);
    if (!r) {
      attachErr.value = '路径不存在或无法添加，未新增附件（只存路径、不拷贝文件）。';
      return;
    }
    atPath.value = '';
    await loadAttach();
    note('已链接附件：' + (r.name || p));
  } catch (e) {
    attachErr.value = '添加附件失败：' + errMsg(e);
  }
}
async function refreshAttach(): Promise<void> {
  try {
    await domainCall<unknown>('attach.refresh');
    await loadAttach();
    note('已刷新状态，失效项已标灰');
  } catch (e) {
    attachErr.value = '刷新状态失败：' + errMsg(e);
  }
}
async function removeAttach(id: string): Promise<void> {
  try {
    await domainCall<unknown>('attach.remove', id);
    await loadAttach();
    note('已移除该链接（不删除磁盘上的文件）');
  } catch (e) {
    attachErr.value = '移除链接失败：' + errMsg(e);
  }
}
function candidateList(): string[] {
  return atCandidates.value.split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}
async function reconnectAttach(item: AttachItem): Promise<void> {
  try {
    await domainCall<unknown>('attach.reconnect', item.path, candidateList());
    await loadAttach();
    note('已按文件名 + 大小尝试重连，结果见状态');
  } catch (e) {
    attachErr.value = '重连失败：' + errMsg(e);
  }
}
function fmtSize(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!isFinite(v) || v < 0) return '大小未知';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}

/* ---------------- 五、主目标倒计时（只读、诚实降级） ---------------- */
interface DreamGoal {
  id?: string; title?: string; name?: string;
  primary?: boolean; isPrimary?: boolean; main?: boolean; isMain?: boolean;
  targetDate?: string; dueDate?: string; deadline?: string; date?: string; endDate?: string;
  [key: string]: unknown;
}
interface DreamState {
  themes?: unknown[]; goals?: DreamGoal[];
  mainGoal?: DreamGoal | null; primaryGoal?: DreamGoal | null;
  [key: string]: unknown;
}

const dreamState = ref<DreamState | null>(null);
const primaryGoal = ref<{ title: string; date: string } | null>(null);
const goalErr = ref('');
const goalLoaded = ref(false);
const todayStr = ref(localDate());

function goalDate(g: DreamGoal): string {
  const cands = [g.targetDate, g.dueDate, g.deadline, g.endDate, g.date];
  for (const c of cands) {
    if (c && /^\d{4}-\d{2}-\d{2}/.test(String(c))) return String(c).slice(0, 10);
  }
  return '';
}
// 只认「明确的主目标口径」：mainGoal / primaryGoal 字段，或目标上带 primary / main 标识。
// 不猜测、不把任意一个带日期的目标硬当主目标，以免编造倒计时。
function pickPrimary(state: DreamState): DreamGoal | null {
  const direct = state.mainGoal || state.primaryGoal;
  if (direct && typeof direct === 'object') return direct as DreamGoal;
  const goals = Array.isArray(state.goals) ? state.goals : [];
  for (const g of goals) {
    if (g && (g.primary === true || g.isPrimary === true || g.main === true || g.isMain === true)) return g;
  }
  return null;
}
async function loadGoal(): Promise<void> {
  goalLoaded.value = false;
  goalErr.value = '';
  primaryGoal.value = null;
  try {
    const s = await domainCall<DreamState>('dream.read');
    dreamState.value = s || null;
    const p = s ? pickPrimary(s) : null;
    const d = p ? goalDate(p) : '';
    if (p && d) {
      primaryGoal.value = { title: String(p.title || p.name || '（未命名主目标）'), date: d };
    }
  } catch (e) {
    goalErr.value = '目标板读取失败：' + errMsg(e);
  }
  todayStr.value = localDate();
  goalLoaded.value = true;
}
const goalDaysLeft = computed<number | null>(function () {
  if (!primaryGoal.value) return null;
  const a = Date.parse(primaryGoal.value.date + 'T00:00:00Z');
  const b = Date.parse(todayStr.value + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
});
const goalCount = computed<number>(function () {
  const s = dreamState.value;
  return s && Array.isArray(s.goals) ? s.goals.length : 0;
});
const themeCount = computed<number>(function () {
  const s = dreamState.value;
  return s && Array.isArray(s.themes) ? s.themes.length : 0;
});
</script>

<template>
  <section class="lng-wrap" aria-label="长线视图">
    <header class="lng-head">
      <button class="lng-back" @click="emit('back')">← 返回</button>
      <h1 class="lng-h1">长线 · 把时间摊开来看</h1>
      <p v-if="flash" class="lng-flash" role="status">{{ flash }}</p>
    </header>

    <nav class="lng-tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="lng-tab"
        :class="{ 'lng-tab-on': tab === t.key }"
        role="tab"
        @click="switchTab(t.key)"
      >{{ t.label }}</button>
    </nav>

    <!-- 一、节气复盘 -->
    <section v-if="tab === 'term'" class="lng-panel" aria-label="节气复盘">
      <div class="lng-row"><h2 class="lng-h2">节气复盘</h2><button class="lng-btn" @click="loadTerm">重新读取</button></div>
      <p v-if="termErr" class="lng-err" role="alert">{{ termErr }}</p>

      <div class="lng-termhead">
        <template v-if="termCurrent">
          <p class="lng-now">当前：{{ termCurrent.name }}（还剩 {{ termCurrent.daysLeft }} 天）</p>
          <p class="lng-next">下一节气：{{ termCurrent.next }} · 稳定键：{{ termCurrent.key || '未提供' }}</p>
          <p class="lng-hou">{{ termCurrent.hou }}</p>
        </template>
        <p v-else-if="!termLoaded" class="lng-muted">正在读取当前节气…</p>
        <p v-else class="lng-empty">当前节气读取不到，稍后点「重新读取」再试。</p>
      </div>


      <div class="lng-form">
        <h3 class="lng-h3">写三问复盘（本节气：{{ termCurrent ? termCurrent.name : '—' }}）</h3>
        <label class="lng-field"><span>① 这一节气里，哪件事被你真正推进了？</span>
          <textarea v-model="answer1" class="lng-input" rows="2" placeholder="一句就好"></textarea></label>
        <label class="lng-field"><span>② 有什么一直被搁着、还没动？</span>
          <textarea v-model="answer2" class="lng-input" rows="2" placeholder="如实写，不必漂亮"></textarea></label>
        <label class="lng-field"><span>③ 下一个节气，想留一句什么给自己？</span>
          <textarea v-model="answer3" class="lng-input" rows="2" placeholder="只当时间刻度上的一句话"></textarea></label>
        <div class="lng-row">
          <button class="lng-primary" :disabled="!termCurrent || !termCurrent.key" @click="saveReview">保存三问复盘</button>
          <span class="lng-note">同一节气再写会覆盖上一次。</span>
        </div>
      </div>

      <div class="lng-list">
        <h3 class="lng-h3">已写复盘（{{ reviews.length }}）</h3>
        <p v-if="termLoaded && reviews.length === 0" class="lng-empty">还没有写过节气复盘。上面三问写一条，这里就会留下来。</p>
        <p v-else-if="!termLoaded" class="lng-muted">正在读取复盘列表…</p>
        <article v-for="r in reviews" :key="r.termKey" class="lng-card">
          <div class="lng-row"><strong class="lng-key">{{ r.termKey }}</strong><span class="lng-note">{{ fmtTime(r.savedAt) }}</span></div>
          <p class="lng-answer">{{ reviewText(r) }}</p>
        </article>
      </div>
    </section>

    <!-- 二、跨模块引用层 -->
    <section v-else-if="tab === 'trace'" class="lng-panel" aria-label="跨模块引用层">
      <div class="lng-row"><h2 class="lng-h2">跨模块引用层</h2><button class="lng-btn" @click="loadTrace">重新读取</button></div>
      <p v-if="traceErr" class="lng-err" role="alert">{{ traceErr }}</p>

      <div class="lng-form">
        <h3 class="lng-h3">新建引用</h3>
        <div class="lng-grid3">
          <label class="lng-field"><span>from（来源）</span><input v-model="trFrom" class="lng-input" placeholder="diary:2026-11-07" /></label>
          <label class="lng-field"><span>to（目标）</span><input v-model="trTo" class="lng-input" placeholder="gtd:&lt;id&gt; 或 cell:work" /></label>
          <label class="lng-field"><span>note（备注，选填）</span><input v-model="trNote" class="lng-input" placeholder="为什么指过去" /></label>
        </div>
        <div class="lng-row">
          <button class="lng-primary" @click="addTrace">新建引用</button>
          <span class="lng-note">如 diary:2026-11-07 / gtd:&lt;id&gt;</span>
        </div>
      </div>

      <div class="lng-row">
        <input v-model="traceFilter" class="lng-input lng-grow" placeholder="按目标查引用，如 diary:2026-11-07" />
        <button class="lng-btn" @click="queryTrace">按目标查引用</button>
        <button v-if="traceFiltered" class="lng-btn" @click="clearFilter">清除筛选</button>
      </div>
      <p v-if="traceFiltered" class="lng-note">按目标筛出 {{ shownTrace.length }} 条，已显示在主列表。</p>

      <div class="lng-list">
        <h3 class="lng-h3">引用列表（{{ shownTrace.length }}）</h3>
        <p v-if="traceLoaded && shownTrace.length === 0" class="lng-empty">还没有任何跨模块引用。上面填 from / to 新建一条。</p>
        <p v-else-if="!traceLoaded" class="lng-muted">正在读取引用…</p>
        <article v-for="it in shownTrace" :key="it.id" class="lng-card" :class="{ 'lng-missing': missingIds.includes(it.id) }">
          <div class="lng-row">
            <button v-if="canJump(it.from)" class="lng-link" @click="onRef(it.from)">{{ it.from }}</button>
            <span v-else class="lng-key">{{ it.from }}</span>
            <span class="lng-arrow">→</span>
            <button v-if="canJump(it.to)" class="lng-link" @click="onRef(it.to)">{{ it.to }}</button>
            <span v-else class="lng-key">{{ it.to }}</span>
            <span v-if="missingIds.includes(it.id)" class="lng-badge">目标已不在</span>
            <span class="lng-spacer"></span>
            <button class="lng-danger" @click="removeTrace(it.id)">删除</button>
          </div>
          <p v-if="it.note" class="lng-note">{{ it.note }}</p>
          <p class="lng-note">建立于 {{ fmtTime(it.createdAt) }}</p>
        </article>
      </div>
    </section>

    <!-- 三、单条加密 -->
    <section v-else-if="tab === 'secure'" class="lng-panel" aria-label="单条加密">
      <div class="lng-row"><h2 class="lng-h2">单条加密</h2></div>
      <p v-if="secureErr" class="lng-err" role="alert">{{ secureErr }}</p>
      <p class="lng-warn">忘记口令即不可恢复。</p>

      <div class="lng-form">
        <h3 class="lng-h3">① 加密</h3>
        <label class="lng-field"><span>明文</span>
          <textarea v-model="secPlain" class="lng-input" rows="3" placeholder="要加密的一段文字"></textarea></label>
        <label class="lng-field"><span>口令</span>
          <input v-model="secPass" class="lng-input" type="password" autocomplete="off" placeholder="只用于本次加密，不会被保存" /></label>
        <button class="lng-primary" @click="doEncrypt">加密</button>
      </div>

      <div v-if="cipher" class="lng-form">
        <h3 class="lng-h3">② 密文对象（JSON，可复制、不写文件）</h3>
        <pre class="lng-pre">{{ cipherJson }}</pre>
        <button class="lng-btn" @click="copyCipher">复制密文 JSON</button>
      </div>
      <p v-else class="lng-empty">还没有密文。上面填明文与口令，点「加密」后这里会出现密文对象。</p>

      <div class="lng-form">
        <h3 class="lng-h3">③ 解密 / 仅校验</h3>
        <label class="lng-field"><span>口令</span>
          <input v-model="secCheck" class="lng-input" type="password" autocomplete="off" placeholder="输入同一口令" /></label>
        <div class="lng-row">
          <button class="lng-primary" :disabled="!cipher" @click="doDecrypt">解密</button>
          <button class="lng-btn" :disabled="!cipher" @click="doVerify">仅校验口令</button>
          <span class="lng-note">仅校验口令，不显示明文。</span>
        </div>
        <p v-if="decrypted" class="lng-plain">明文：{{ decrypted }}</p>
        <p v-if="verified !== null" class="lng-plain">校验结果：{{ verified ? '口令正确' : '口令不正确' }}</p>
      </div>
    </section>

    <!-- 四、链接型附件 -->
    <section v-else-if="tab === 'attach'" class="lng-panel" aria-label="链接型附件">
      <div class="lng-row"><h2 class="lng-h2">链接型附件</h2><button class="lng-btn" @click="loadAttach">重新读取</button></div>
      <p v-if="attachErr" class="lng-err" role="alert">{{ attachErr }}</p>
      <p class="lng-clause">仅存路径，文件移动后可能失效。</p>
      <p class="lng-note"></p>

      <div class="lng-form">
        <div class="lng-row">
          <input v-model="atPath" class="lng-input lng-grow" placeholder="完整文件路径，如 D:\资料\笔记.pdf" />
          <button class="lng-primary" @click="addAttach">添加链接</button>
          <button class="lng-btn" @click="refreshAttach">刷新状态</button>
        </div>
        <label class="lng-field"><span>重连候选路径（每行一个，选填）</span>
          <textarea v-model="atCandidates" class="lng-input" rows="2" placeholder="留空则由主进程按文件名 + 大小尝试"></textarea></label>
        <p class="lng-note">按文件名 + 大小重连失效项。</p>
      </div>

      <div class="lng-list">
        <h3 class="lng-h3">附件列表（{{ attachList.length }}）</h3>
        <p v-if="attachLoaded && attachList.length === 0" class="lng-empty">还没有链接型附件。上面填一个存在的完整路径添加。</p>
        <p v-else-if="!attachLoaded" class="lng-muted">正在读取附件列表…</p>
        <article v-for="a in attachList" :key="a.id" class="lng-card" :class="{ 'lng-missing': !!a.broken }">
          <div class="lng-row">
            <strong class="lng-key">{{ a.name || '（未命名）' }}</strong>
            <span class="lng-note">{{ fmtSize(a.size) }}</span>
            <span v-if="a.broken" class="lng-badge">已失效</span>
            <span v-else class="lng-ok">正常</span>
            <span class="lng-spacer"></span>
            <button v-if="a.broken" class="lng-btn" @click="reconnectAttach(a)">按文件名+大小重连</button>
            <button class="lng-danger" @click="removeAttach(a.id)">移除链接</button>
          </div>
          <p class="lng-note lng-path">{{ a.path }}</p>
        </article>
      </div>
    </section>

    <!-- 五、主目标倒计时 -->
    <section v-else class="lng-panel" aria-label="主目标倒计时">
      <div class="lng-row"><h2 class="lng-h2">主目标倒计时</h2><button class="lng-btn" @click="loadGoal">重新读取</button></div>
      <p v-if="goalErr" class="lng-err" role="alert">{{ goalErr }}</p>

      <div v-if="primaryGoal && goalDaysLeft !== null" class="lng-goalbox">
        <p class="lng-now">主目标：{{ primaryGoal.title }}</p>
        <p class="lng-next">目标日：{{ primaryGoal.date }} · 今天：{{ todayStr }}</p>
        <p v-if="goalDaysLeft > 0" class="lng-count">还剩 {{ goalDaysLeft }} 天</p>
        <p v-else-if="goalDaysLeft === 0" class="lng-count">就是今天</p>
        <p v-else class="lng-count">已过去 {{ -goalDaysLeft }} 天</p>
      </div>
      <div v-else-if="goalLoaded" class="lng-clause">
        <p class="lng-warnline">暂无主目标</p>
      </div>
      <p v-else class="lng-muted">正在读取目标板…</p>

      <p v-if="goalLoaded && goalCount === 0 && themeCount === 0" class="lng-empty">目标板是空的。</p>
    </section>
  </section>
</template>

<style scoped>
.lng-wrap {
  display: flex; flex-direction: column; gap: 14px;
  color: var(--text-primary, #2c2c2a);
  background: var(--background-primary, #ffffff);
  font-size: 13px; line-height: 1.6;
}
.lng-head { display: flex; flex-direction: column; gap: 6px; }
.lng-back { align-self: flex-start; border: 0; background: transparent; color: var(--text-secondary, #5f5e5a); cursor: pointer; font-size: 13px; padding: 0; }
.lng-h1 { margin: 0; font-size: 20px; font-weight: 500; color: var(--text-primary, #2c2c2a); }
.lng-sub { margin: 0; font-size: 12px; color: var(--text-secondary, #5f5e5a); }
.lng-flash { margin: 0; padding: 6px 10px; border-radius: var(--radius-sm, 6px); background: var(--palette-soft, #e7f4ee); color: var(--palette-primary, #0f6e56); font-size: 12px; }

.lng-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.lng-tab { padding: 6px 12px; border: 1px solid var(--border-tertiary, #e2e0d9); border-radius: var(--radius-md, 8px); background: var(--background-primary, #ffffff); color: var(--text-secondary, #5f5e5a); font-size: 13px; cursor: pointer; }
.lng-tab-on { border-color: var(--palette-primary, #0f6e56); color: var(--palette-primary, #0f6e56); }

.lng-panel { display: flex; flex-direction: column; gap: 12px; }
.lng-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lng-h2 { margin: 0; font-size: 15px; font-weight: 500; color: var(--text-primary, #2c2c2a); }
.lng-h3 { margin: 0; font-size: 13px; font-weight: 500; color: var(--text-primary, #2c2c2a); }
.lng-spacer { flex: 1; }
.lng-btn, .lng-primary, .lng-danger {
  padding: 6px 12px; border: 1px solid var(--border-secondary, #c9c7be); border-radius: var(--radius-md, 8px);
  background: var(--surface-panel, #faf8f2); color: var(--text-primary, #2c2c2a); font-size: 12px; cursor: pointer;
}
.lng-btn:disabled, .lng-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.lng-primary { border-color: var(--palette-primary, #0f6e56); background: var(--palette-primary, #0f6e56); color: var(--palette-on, #ffffff); }
.lng-danger { border-color: var(--state-danger, #a3281b); color: var(--state-danger, #a3281b); background: var(--background-primary, #ffffff); }
.lng-link { border: 0; background: transparent; color: var(--palette-primary, #0f6e56); cursor: pointer; font-size: 12px; padding: 0; text-decoration: underline; }

.lng-err { margin: 0; padding: 8px 10px; border-radius: var(--radius-sm, 6px); background: var(--state-danger-soft, #fbeae7); color: var(--state-danger, #a3281b); font-size: 12px; word-break: break-all; }
.lng-clause { margin: 0; padding: 8px 10px; border-left: 3px solid var(--state-warn, #8a5a00); border-radius: var(--radius-sm, 6px); background: var(--state-warn-soft, #fbf1dd); color: var(--text-primary, #2c2c2a); font-size: 12px; }
.lng-warn { margin: 0; padding: 10px 12px; border: 1px solid var(--state-danger, #a3281b); border-radius: var(--radius-sm, 6px); background: var(--state-danger-soft, #fbeae7); color: var(--state-danger, #a3281b); font-size: 13px; font-weight: 500; }
.lng-warnline { margin: 0 0 4px; font-size: 14px; font-weight: 500; color: var(--state-warn, #8a5a00); }
.lng-note { margin: 0; font-size: 12px; color: var(--text-secondary, #5f5e5a); }
.lng-muted { margin: 0; font-size: 12px; color: var(--text-tertiary, #888780); }
.lng-empty { margin: 0; padding: 20px; text-align: center; font-size: 13px; color: var(--text-tertiary, #888780); border: 1px dashed var(--border-tertiary, #e2e0d9); border-radius: var(--radius-md, 8px); }

.lng-termhead { display: flex; flex-direction: column; gap: 4px; padding: 12px; border: 1px solid var(--border-tertiary, #e2e0d9); border-radius: var(--radius-md, 8px); background: var(--background-primary, #ffffff); }
.lng-now { margin: 0; font-size: 16px; font-weight: 500; color: var(--text-primary, #2c2c2a); }
.lng-next { margin: 0; font-size: 12px; color: var(--text-secondary, #5f5e5a); }
.lng-hou { margin: 0; font-size: 13px; color: var(--palette-primary, #0f6e56); }

.lng-form { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border-tertiary, #e2e0d9); border-radius: var(--radius-md, 8px); }
.lng-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary, #5f5e5a); }
.lng-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.lng-input { width: 100%; box-sizing: border-box; border: 1px solid var(--border-tertiary, #e2e0d9); border-radius: var(--radius-sm, 6px); padding: 6px 8px; font-size: 13px; color: var(--text-primary, #2c2c2a); background: var(--background-primary, #ffffff); }
.lng-grow { flex: 1; min-width: 180px; }
.lng-pre { margin: 0; padding: 10px; max-height: 220px; overflow: auto; border: 1px solid var(--border-tertiary, #e2e0d9); border-radius: var(--radius-sm, 6px); background: var(--background-secondary, #f5f3ec); color: var(--text-primary, #2c2c2a); font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.lng-plain { margin: 0; padding: 8px 10px; border-radius: var(--radius-sm, 6px); background: var(--palette-soft, #e7f4ee); color: var(--text-primary, #2c2c2a); font-size: 13px; white-space: pre-wrap; word-break: break-word; }

.lng-list { display: flex; flex-direction: column; gap: 8px; }
.lng-card { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--border-tertiary, #e2e0d9); border-radius: var(--radius-md, 8px); background: var(--background-primary, #ffffff); }
.lng-missing { background: var(--background-secondary, #f5f3ec); color: var(--text-tertiary, #888780); border-style: dashed; }
.lng-key { font-size: 13px; font-weight: 500; color: var(--text-primary, #2c2c2a); }
.lng-missing .lng-key { color: var(--text-tertiary, #888780); }
.lng-answer { margin: 0; font-size: 12px; color: var(--text-primary, #2c2c2a); white-space: pre-wrap; word-break: break-word; }
.lng-arrow { font-size: 12px; color: var(--text-tertiary, #888780); }
.lng-badge { padding: 1px 6px; border-radius: var(--radius-sm, 6px); background: var(--background-secondary, #e9e7df); color: var(--text-secondary, #5f5e5a); font-size: 11px; }
.lng-ok { padding: 1px 6px; border-radius: var(--radius-sm, 6px); background: var(--palette-soft, #e7f4ee); color: var(--state-ok, #0f6e56); font-size: 11px; }
.lng-path { word-break: break-all; }

.lng-goalbox { display: flex; flex-direction: column; gap: 4px; padding: 14px; border: 1px solid var(--border-tertiary, #e2e0d9); border-radius: var(--radius-md, 8px); background: var(--background-primary, #ffffff); }
.lng-count { margin: 4px 0 0; font-size: 22px; font-weight: 500; color: var(--palette-primary, #0f6e56); }

@media (max-width: 720px) {
  .lng-grid3 { grid-template-columns: 1fr; }
}
</style>
