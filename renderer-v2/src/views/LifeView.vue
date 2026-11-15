<script setup lang="ts">
// V1.3「把时间的纵深做出来」：人生月历 / 正文待办汇总 / 随机重读 / 导出为一张图。
// 四项都是「读已有数据换个画法」，零新数据键、不碰冻结 utils。
// 「一个文件」打包放在数据中心（DataCenter.vue），因为它属于数据主权而不是回看。
import { ref, computed, onMounted } from 'vue';
import { domainCall, saveExport } from '../bridge';
import TodoDigest from '../components/TodoDigest.vue';
import { GRID_LABELS, localDate, type TodoRow } from '../types';

interface MonthCell { key: string; year: number; month: number; count: number; level: number }
interface CalData {
  basis: 'birth' | 'record'; startYear: number; years: number; firstRecordDate: string | null;
  months: MonthCell[]; writtenMonths: number; passedMonths: number; totalRecords: number; headline: string;
}
interface CardData { date: string; lines: Array<{ label: string; text: string }>; quote: string; brand: string }
interface Rec { date: string; cells: Record<string, string> }

const emit = defineEmits<{
  (e: 'go-timeline', year: number): void;
  (e: 'go-date', date: string): void;
  (e: 'back'): void;
  (e: 'notify', msg: string): void;
}>();

type Tab = 'calendar' | 'todos' | 'random';
const tab = ref<Tab>('calendar');
const cal = ref<CalData | null>(null);
const calLoaded = ref(false);
const digest = ref<{ open: TodoRow[]; done: TodoRow[] }>({ open: [], done: [] });
const digestLoaded = ref(false);
const birth = ref<string>(localStorage.getItem('jiuge.birth') || '');
const picked = ref<Rec | null>(null);
const recent = ref<string[]>([]);
const message = ref('');
const rollHint = ref('');
const brand = ref(false);
const exporting = ref(false);

const calYears = computed(() => {
  const out: Array<{ year: number; cells: MonthCell[] }> = [];
  const months = cal.value ? cal.value.months : [];
  for (let i = 0; i < months.length; i += 12) {
    out.push({ year: months[i].year, cells: months.slice(i, i + 12) });
  }
  return out;
});
const emptyLib = computed(() => calLoaded.value && (cal.value ? cal.value.totalRecords : 0) === 0);

async function loadCalendar(): Promise<void> {
  try {
    cal.value = await domainCall<CalData>('v13.calendar', { birth: birth.value || '', years: 100 });
  } catch (e) {
    message.value = '人生月历读取失败：' + (e as Error).message;
  }
  calLoaded.value = true;
}
async function loadTodos(): Promise<void> {
  try {
    digest.value = await domainCall<{ open: TodoRow[]; done: TodoRow[] }>('v13.todos');
  } catch (e) {
    message.value = '待办汇总读取失败：' + (e as Error).message;
  }
  digestLoaded.value = true;
}
function applyBirth(): void {
  if (birth.value) localStorage.setItem('jiuge.birth', birth.value);
  else localStorage.removeItem('jiuge.birth');
  void loadCalendar();
}
async function roll(): Promise<void> {
  if (emptyLib.value) {
    rollHint.value = '本机还没有旧记录，先写几天再来翻';
    return;
  }
  const r = await domainCall<Rec | null>('v13.random', recent.value);
  if (!r) {
    picked.value = null;
    rollHint.value = '最近这几篇都翻过了，换一天再来，或回到时间轴自己挑一篇';
    return;
  }
  picked.value = r;
  recent.value = [r.date].concat(recent.value).slice(0, 5);
  rollHint.value = '';
}
function plain(v: unknown): string {
  return String(v == null ? '' : v).replace(/[*`~>#]/g, '').replace(/^\s*[-•]\s*/gm, '').trim();
}
function label(k: string): string { return (GRID_LABELS as Record<string, string>)[k] || k; }

// 导出为一张竖版 PNG。默认不带软件名水印（docs/10 D3），开关默认关。
// dataURL 交给主进程 v1/file:save：那边识别前缀后按二进制落盘，仍是同一个通道。
async function exportCard(): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const data = await domainCall<CardData>('v13.card', localDate(), { brand: brand.value });
    const W = 720;
    const H = Math.max(420, 150 + data.lines.length * 92 + (data.quote ? 70 : 0) + 80);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画布不可用');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2c2c2a';
    ctx.font = '500 30px "Microsoft YaHei", sans-serif';
    ctx.fillText(data.date, 48, 66);
    ctx.fillStyle = '#888780';
    ctx.font = '14px "Microsoft YaHei", sans-serif';
    ctx.fillText('这一天的九格', 48, 94);
    ctx.strokeStyle = '#e2e0d9';
    ctx.beginPath(); ctx.moveTo(48, 112); ctx.lineTo(W - 48, 112); ctx.stroke();
    let y = 150;
    data.lines.forEach(function (line) {
      ctx.fillStyle = '#0f6e56';
      ctx.font = '500 16px "Microsoft YaHei", sans-serif';
      ctx.fillText(line.label, 48, y);
      ctx.fillStyle = '#2c2c2a';
      ctx.font = '16px "Microsoft YaHei", sans-serif';
      const chars = Array.from(line.text);
      const per = 38;
      const rows = chars.length === 0 ? ['（空）'] : [chars.slice(0, per).join(''), chars.slice(per, per * 2).join('')].filter(Boolean);
      rows.slice(0, 2).forEach(function (row, i) { ctx.fillText(row, 48, y + 26 + i * 22); });
      y += 92;
    });
    if (data.quote) {
      ctx.fillStyle = '#5f5e5a';
      ctx.font = '15px "Microsoft YaHei", sans-serif';
      ctx.fillText(data.quote.slice(0, 38), 48, Math.min(y + 8, H - 56));
    }
    ctx.fillStyle = '#b4b2a9';
    ctx.font = '13px "Microsoft YaHei", sans-serif';
    // 默认页脚只写日期，不出现「九格手记」字样；开关打开才写品牌
    ctx.fillText(data.brand || '', 48, H - 28);
    const url = canvas.toDataURL('image/png');
    const receipt = await saveExport('九格-' + data.date + '.png', url);
    message.value = receipt.canceled
      ? '已取消导出'
      : '已导出 ' + (receipt.path || '') + ' · ' + (receipt.bytes || 0) + ' 字节 · ' + W + '×' + H;
    emit('notify', message.value);
  } catch (e) {
    message.value = '导出图片失败：' + (e as Error).message;
  } finally {
    exporting.value = false;
  }
}

onMounted(function () { void loadCalendar(); void loadTodos(); });
</script>

<template>
  <section class="v13" aria-label="时间纵深">
    <header class="v13-head">
      <button class="v13-back" @click="emit('back')">← 回到今天</button>
      <h1 class="v13-h1">把时间的纵深做出来</h1>
    </header>

    <div class="v13-tabs" role="tablist">
      <button class="v13-tab" :class="{ 'v13-tab-on': tab === 'calendar' }" @click="tab = 'calendar'">人生月历</button>
      <button class="v13-tab" :class="{ 'v13-tab-on': tab === 'todos' }" @click="tab = 'todos'">正文待办</button>
      <button class="v13-tab" :class="{ 'v13-tab-on': tab === 'random' }" @click="tab = 'random'">随便看看</button>
      <span class="v13-spacer"></span>
      <label class="v13-brand"><input type="checkbox" v-model="brand" /> 图上有软件名</label>
      <button class="v13-btn" :disabled="exporting" @click="exportCard">导出今天为一张图</button>
    </div>
    <p v-if="message" class="v13-msg">{{ message }}</p>

    <!-- A1 人生月历：100 年 × 12 月 = 1200 格 -->
    <section v-if="tab === 'calendar'" class="v13-panel" aria-label="人生月历">
      <div class="v13-calbar">
        <h2 class="v13-h2">{{ cal ? cal.headline : '正在读取…' }}</h2>
        <span class="v13-calc">{{ cal ? cal.months.length : 0 }} 格 · 共 {{ cal ? cal.totalRecords : 0 }} 篇</span>
      </div>
      <div class="v13-birth">
        <label for="v13-birth">出生年月（选填）</label>
        <input id="v13-birth" v-model="birth" class="v13-input" type="month" />
        <button class="v13-btn" @click="applyBirth">按此重算</button>
      </div>
      <div class="v13-gridwrap">
        <div v-for="yr in calYears" :key="yr.year" class="v13-year">
          <span class="v13-yearlabel">{{ yr.year }}</span>
          <span
            v-for="m in yr.cells"
            :key="m.key"
            class="v13-month"
            :class="'v13-lv' + m.level"
            :title="m.key + ' · 写了 ' + m.count + ' 天'"
            :aria-label="m.key + ' 写了 ' + m.count + ' 天'"
            @click="emit('go-timeline', m.year)"
          ></span>
        </div>
      </div>
      <p class="v13-note">一格 = 一个月 · 点格回到时间轴</p>
    </section>

    <!-- A2 正文待办汇总：独立只读组件，本视图只负责取数 -->
    <section v-else-if="tab === 'todos'" class="v13-panel" aria-label="正文待办汇总">
      <TodoDigest :open="digest.open" :done="digest.done" :loaded="digestLoaded" @go-date="emit('go-date', $event)" />
    </section>

    <!-- A4 随机重读 -->
    <section v-else class="v13-panel" aria-label="随便看看">
      <div class="v13-calbar">
        <h2 class="v13-h2">随便看看</h2>
        <button class="v13-btn" :disabled="emptyLib" @click="roll">再翻一篇</button>
      </div>
      <p v-if="emptyLib" class="v13-empty">本机还没有旧记录，先写几天再来翻</p>
      <p v-else-if="!picked" class="v13-empty">{{ rollHint || '点「再翻一篇」，随机打开一篇写过的旧日记（不会翻到今天）' }}</p>
      <article v-else class="v13-pick">
        <h3 class="v13-h3">{{ picked.date }}</h3>
        <div v-for="(v, k) in picked.cells" :key="k" class="v13-pickrow">
          <template v-if="plain(v)">
            <span class="v13-picklabel">{{ label(String(k)) }}</span>
            <span class="v13-picktext">{{ plain(v) }}</span>
          </template>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
.v13 { display: flex; flex-direction: column; gap: 14px; }
.v13-head { display: flex; flex-direction: column; gap: 6px; }
.v13-back { align-self: flex-start; border: 0; background: transparent; color: var(--text-secondary, #5f5e5a); cursor: pointer; font-size: var(--text-body); padding: 0; }
.v13-h1 { margin: 0; font-size: var(--text-h1); font-weight: 500; }
.v13-sub { margin: 0; font-size: var(--text-sm); color: var(--text-secondary, #5f5e5a); }
.v13-h2 { margin: 0; font-size: var(--text-h2); font-weight: 500; }
.v13-h3 { margin: 0; font-size: var(--text-h2); font-weight: 500; }
.v13-tabs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.v13-tab { padding: 6px 12px; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 8px; background: var(--background-primary, #fff); font-size: var(--text-body); cursor: pointer; }
.v13-tab-on { border-color: var(--palette-primary, #0f6e56); color: var(--palette-primary, #0f6e56); }
.v13-spacer { flex: 1; }
.v13-brand { font-size: var(--text-sm); color: var(--text-secondary, #5f5e5a); display: flex; align-items: center; gap: 4px; }
.v13-btn { padding: 6px 12px; border: 0.5px solid var(--border-secondary, #c9c7be); border-radius: 8px; background: var(--background-primary, #fff); font-size: var(--text-body); cursor: pointer; }
.v13-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.v13-msg { margin: 0; font-size: var(--text-sm); color: var(--palette-primary, #0f6e56); word-break: break-all; }
.v13-panel { display: flex; flex-direction: column; gap: 12px; }
.v13-calbar { display: flex; align-items: center; gap: 12px; }
.v13-calc { font-size: var(--text-sm); color: var(--text-secondary, #5f5e5a); }
.v13-birth { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--text-sm); color: var(--text-secondary, #5f5e5a); }
.v13-input { border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 6px; padding: 4px 8px; font-size: var(--text-sm); }
.v13-hint { font-size: var(--text-xs); color: var(--text-tertiary, #888780); }
.v13-gridwrap { max-height: 420px; overflow-y: auto; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 10px; padding: 10px 12px; }
.v13-year { display: grid; grid-template-columns: 46px repeat(12, minmax(0, 1fr)); gap: 3px; align-items: center; margin-bottom: 3px; }
.v13-yearlabel { font-size: var(--text-xs); color: var(--text-tertiary, #888780); }
.v13-month { display: block; height: 10px; border-radius: 2px; background: var(--background-secondary, #f1efe8); cursor: pointer; }
.v13-month:hover { outline: 1px solid var(--palette-primary, #0f6e56); }
.v13-lv0 { background: var(--background-secondary, #f1efe8); }
.v13-lv1 { background: #c8e8db; }
.v13-lv2 { background: #8fd0b8; }
.v13-lv3 { background: #4caf8e; }
.v13-lv4 { background: #0f6e56; }
.v13-note { margin: 0; font-size: var(--text-sm); line-height: 1.6; color: var(--text-secondary, #5f5e5a); }
.v13-empty { margin: 0; padding: 24px; text-align: center; font-size: var(--text-body); color: var(--text-tertiary, #888780); }
.v13-pick { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 10px; }
.v13-pickrow { display: flex; gap: 10px; font-size: var(--text-body); line-height: 1.6; }
.v13-picklabel { flex: 0 0 76px; color: var(--palette-primary, #0f6e56); }
.v13-picktext { flex: 1; white-space: pre-wrap; word-break: break-word; }
</style>
