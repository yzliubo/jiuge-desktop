<script setup lang="ts">
// 「今天」页的补充区：基础栏 + 头七天 / 往年今天 / 胶囊提醒 + 一键留一句。
// 2026-11-08 22:32 起整块搬进右栏「本页选项」（主栏只留九格与写作）：
// flat = 去掉自己的卡片外框，交给右栏的 ctx-card 统一收边。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { useWeather } from '../composables/useWeather';
import { GRID_KEYS, GRID_LABELS, localDate, type DiaryBase, type DiaryRecord } from '../types';

const props = defineProps<{ record: DiaryRecord; flat?: boolean }>();
const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
}>();

// 与 diary-store.js BASE_FIELDS 逐字一致：落盘是中文字符串，不是数字下标
const WEATHER = ['晴', '多云', '阴', '小雨', '大雨', '雪', '风', '雾'];
const BODY = ['很好', '不错', '一般', '疲惫', '不适'];
const MOOD = ['愉悦', '平静', '一般', '低落', '烦躁'];

type FirstWeek = { active: boolean; dayNo: number; enabled: boolean; celebration: string };
type GridField = { key: string; label: string; hint: string };

const base = ref<DiaryBase>({ weather: '', anniversary: '', body: '', mood: '' });

// 2026-11-11 主理人口径：互联网天气与「今天概览 / 今日状态」直接关联。
// 联网时自动把 8 档天气带进草稿，点一次保存就落盘；断网 / 关闭 / 认不出时才需要手填。
// 只对今天生效：翻到往日时，不能用今天的窗外去改那一天的日记。
const wx = useWeather();
const isToday = computed(() => props.record.date === localDate());
const autoWx = computed(() => (isToday.value ? wx.autoWeather.value : ''));
// 手选过一次之后，30 分钟一次的天气刷新不再偷偷改草稿；想改回去有显式入口。
const manual = ref(false);

watch(() => props.record, function (r) {
  base.value = Object.assign({ weather: '', anniversary: '', body: '', mood: '' },
    JSON.parse(JSON.stringify(r.base || {})));
  // 首页天气条「记进今天」写下的自动值：右栏跟着回到自动态，别还挂着「已改为手填」
  if (autoWx.value && base.value.weather === autoWx.value) manual.value = false;
  if (!manual.value && autoWx.value) base.value.weather = autoWx.value;
}, { immediate: true, deep: true });

watch(autoWx, function (v) {
  if (v && !manual.value && isToday.value) base.value.weather = v;
});
// 换了一天就重新由联网值接管，别把昨天「改为手填」的状态带到今天
watch(() => props.record.date, function () { manual.value = false; });

const autoText = computed(() => (wx.state.report && wx.state.report.now ? wx.state.report.now.text : '联网天气'));

function resetAuto(): void {
  manual.value = false;
  if (autoWx.value) base.value.weather = autoWx.value;
}

const template = ref<{ id: string; name: string }>({ id: 'standard', name: '标准·九格' });
const firstWeek = ref<FirstWeek>({ active: false, dayNo: 0, enabled: false, celebration: '' });
const dueCount = ref(0);
const previousText = ref('往年今天还没有记录');
const prompts = ref<Record<string, string>>({});
const quickLine = ref('');

const filled = computed(() => GRID_KEYS.filter((k) => !!props.record.cells[k]).length);
const baseSet = computed(() => !!(base.value.weather || base.value.body || base.value.mood || base.value.anniversary));

function persist(patch: Partial<DiaryRecord>): void {
  emit('save', Object.assign({}, JSON.parse(JSON.stringify(props.record)), patch));
}

// 保存 = 用户确认了这一版天气。若它与联网值不同，就当手填锁定，
// 否则保存后 record 回灌时又会被自动值盖回去（表现为「刚选的天气自己变了」）。
function confirmManual(): void {
  if (autoWx.value && base.value.weather !== autoWx.value) manual.value = true;
}

function saveBase(): void {
  confirmManual();
  persist({ base: base.value });
  emit('notify', '今日状态已记下');
}

// 「保存今日记录」也必须带上当前基础栏：否则在别处存一次正文，刚自动带入的天气
// 草稿就丢了，等于逼用户点两次保存。两个按钮现在都是一次点击直接落盘。
function saveAll(): void {
  confirmManual();
  persist({ base: base.value });
  emit('notify', '今日记录已保存');
}

function addQuickLine(): void {
  const text = quickLine.value.trim();
  if (!text) return;
  const cells = Object.assign({}, props.record.cells);
  cells.free = (cells.free || '') + (cells.free ? '\n' : '') + text;
  persist({ cells });
  quickLine.value = '';
  emit('notify', '已记下 · 这也算一篇');
}

async function endFirstWeek(): Promise<void> {
  await callDomain('setFirstWeekEnabled', null, false);
  firstWeek.value.active = false;
  emit('notify', '已结束头七天引导');
}

onMounted(async () => {
  const [t, fw, due, prev, fields] = await Promise.all([
    callDomain<{ id: string; name: string }>('activeTemplate', template.value),
    callDomain<FirstWeek>('firstWeekState', firstWeek.value),
    callDomain<unknown[]>('dueCapsules', []),
    callDomain<unknown>('previousToday', null),
    callDomain<GridField[]>('activeGridFields', [])
  ]);
  template.value = t && typeof t === 'object' ? t : template.value;
  firstWeek.value = fw && typeof fw === 'object' ? fw : firstWeek.value;
  dueCount.value = Array.isArray(due) ? due.length : 0;
  previousText.value = prev ? '往年今天有记录，可到「回顾」对照' : '往年今天还没有记录';
  const list = Array.isArray(fields) ? fields : [];
  const next: Record<string, string> = {};
  for (let i = 0; i < GRID_KEYS.length; i++) {
    // activeGridFields 是 {key,label,hint,...}；hint 才是引导提问
    const f = list[i];
    next[GRID_KEYS[i]] = (f && (f.hint || f.label)) || GRID_LABELS[GRID_KEYS[i]];
  }
  prompts.value = next;
});
</script>

<template>
  <div class="extras" :class="{ 'extras-flat': flat }">
    <section class="card">
      <h2 v-if="!flat" class="card-title">{{ template.name }} · 今日状态</h2>
      <div class="base-grid">
        <label class="field">{{ autoWx && !manual ? '天气 · 联网自动带入' : '天气（8 档）' }}
          <!-- 联网时也不用强制锁死下拉：想改成「今天心里是雨天」随时能改，改过就不再被刷新覆盖 -->
          <select v-model="base.weather" class="text" @change="manual = true">
            <option value="">未选择</option>
            <option v-for="w in WEATHER" :key="w" :value="w">{{ w }}</option>
          </select>
        </label>
        <label class="field">身体状况（5 档）
          <select v-model="base.body" class="text">
            <option value="">未选择</option>
            <option v-for="b in BODY" :key="b" :value="b">{{ b }}</option>
          </select>
        </label>
        <label class="field">心情（5 档）
          <select v-model="base.mood" class="text">
            <option value="">未选择</option>
            <option v-for="m in MOOD" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
        <label class="field">纪念日（≤40 字）
          <input v-model="base.anniversary" class="text" maxlength="40" placeholder="选填" />
        </label>
      </div>
      <p v-if="autoWx && !manual" class="hint wx-auto">
        {{ autoText }} → {{ autoWx }}，已带进今天；点下面任一「保存」即记进日记。
      </p>
      <p v-else-if="autoWx && manual" class="hint">
        已改为手填 · <button class="link" type="button" @click="resetAuto">按联网重填</button>
      </p>
      <p v-else-if="isToday && !autoWx" class="hint">没取到联网天气（可能断网 / 已关闭），请在这里手填。</p>
      <div class="row">
        <button class="btn" :class="{ 'btn-on': baseSet }" @click="saveBase">记下今日状态</button>
      </div>
    </section>

    <section class="card">
      <div class="chips">
        <span v-if="firstWeek.active" class="chip chip-on">头七天引导 · 第 {{ firstWeek.dayNo }} 天</span>
        <button v-if="firstWeek.active" class="link" @click="endFirstWeek">结束引导</button>
        <span class="chip">{{ previousText }}</span>
        <span v-if="dueCount > 0" class="chip chip-on">胶囊待拆 {{ dueCount }} 封</span>
      </div>
      <div class="row quick-row">
        <input v-model="quickLine" class="text" maxlength="120" placeholder="一键留一句，追加到「自由」格" />
        <button class="btn" :class="{ 'btn-on': !!quickLine.trim() }" @click="addQuickLine">留一句</button>
      </div>
      <div class="row">
        <span class="muted">已填 {{ filled }} / 9 格</span>
        <button class="btn primary" @click="saveAll">保存今日记录</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.extras { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-3); }
.card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
/* 右栏里：外框交给 ctx-card，卡片之间只在标题上留一点分隔，别叠三层框 */
.extras-flat { margin-top: 0; gap: 10px; }
.extras-flat .card { padding: 0; border: 0; border-radius: 0; background: transparent; }
.extras-flat .card + .card { padding-top: 10px; border-top: 0.5px dashed var(--surface-border); }
.extras-flat .base-grid { grid-template-columns: 1fr; gap: 8px; margin: 8px 0; }
.card-title { font-size: 13px; font-weight: 500; margin: 0 0 4px; }
.hint, .muted { font-size: 12px; color: var(--surface-muted); }
.hint.wx-auto { color: var(--palette-primary); }
.hint .link { font-size: 12px; }
.base-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); margin: var(--space-2) 0; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--surface-muted); }
.text { width: 100%; padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; }
.row { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); flex-wrap: wrap; }
.btn { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.btn-on, .primary { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.link { border: 0; background: transparent; color: var(--palette-primary); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 2px 10px; border-radius: 999px; background: var(--surface-raised); font-size: 12px; }
.chip-on { background: var(--palette-soft); color: var(--palette-primary); }
.quick-row .text { flex: 1; min-width: 180px; }
.insight-hint { font-size: 12px; color: var(--surface-muted); margin: var(--space-2) 0 0; }
</style>
