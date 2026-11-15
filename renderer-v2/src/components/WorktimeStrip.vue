<script setup lang="ts">
// 工作模块 · 「今日投入」条（本机时间源）
//
// 它只回答一个问题：今天电脑前的时间去哪了。四件事按优先级排：
//   1. 总活跃时长（已扣 AFK）——别把「窗口开着」当「在工作」；
//   2. 24 小时时间带——一眼看出上午在开会、下午在画图，还是整天空着；
//   3. 未归类占比——**必须露出来**，藏着它就等于假装归类很准；
//   4. 点一段 → 记一条 / 去改归类——这是接入反哺日记的唯一入口。
//
// 三条不许破的边界：
//   · 关闭时不请求、不渲染（默认关）；
//   · 只说聚合，不显示窗口标题（主进程根本没把标题传上来）；
//   · 同步只在用户点按时发生，没有后台轮询——这是记录工具，不是监控软件。
import { computed, onMounted, ref, watch } from 'vue';
import { callDomain } from '../composables/useDomain';
import { worktimeSync, type WorktimeDay, type WorktimeRule, type WorktimeView } from '../bridge';
import { localDate } from '../types';

const props = defineProps<{ date: string; tick?: number; readOnly?: boolean }>();

const emit = defineEmits<{
  (e: 'notify', text: string): void;
  (e: 'written', record: Record<string, unknown>): void;
  (e: 'open-settings'): void;
}>();

const view = ref<WorktimeView | null>(null);
const busy = ref(false);
const picked = ref<number>(-1);

const SEGMENTS = 96; // 24h × 4（15 分钟一段）：1440 个节点会掉帧，15 分钟精度够回答「今天干了啥」

const day = computed<WorktimeDay | null>(() => (view.value ? view.value.day : null));
const enabled = computed(() => !!(view.value && view.value.enabled));
const isToday = computed(() => props.date === localDate());

function ruleOf(id: string): WorktimeRule | null {
  const list = (view.value && view.value.rules) || [];
  return list.filter((r) => r.id === id)[0] || null;
}

function hhmm(min: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}

function dur(sec: number): string {
  const min = Math.round(Number(sec || 0) / 60);
  if (min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h' + (min % 60 ? (min % 60 + 'm') : '');
}

// 96 段各自的归属：取与该段重叠最多的那条时间块。没覆盖就是空的（不是「未归类」——
// 未归类是聚合层算出来的比例，两件事不要混）。
const segOwner = computed<number[]>(() => {
  const out = new Array(SEGMENTS).fill(-1);
  const blocks = (day.value && day.value.blocks) || [];
  blocks.forEach((b, i) => {
    const from = Math.floor(Math.max(0, b[0]) / 15);
    const to = Math.min(SEGMENTS, Math.ceil(Math.min(1440, b[1]) / 15));
    for (let s = from; s < to; s++) {
      if (out[s] < 0) out[s] = i;
    }
  });
  return out;
});

const segs = computed(() =>
  Array.from({ length: SEGMENTS }, (_, i) => {
    const owner = segOwner.value[i];
    const block = owner >= 0 ? day.value!.blocks[owner] : null;
    return {
      i,
      on: !!block,
      ruleId: block ? block[2] : '',
      label: block ? (ruleOf(block[2])?.label || '未归类') : '',
      title: block ? hhmm(block[0]) + '–' + hhmm(block[1]) + ' · ' + (block[3] || '本机') + ' · ' + (ruleOf(block[2])?.label || '未归类') : ''
    };
  })
);

const pickedBlock = computed<Array<number | string> | null>(() => {
  const d = day.value;
  if (!d || picked.value < 0 || picked.value >= d.blocks.length) return null;
  return d.blocks[picked.value] as unknown as Array<number | string>;
});

const pickedKey = computed(() => (pickedBlock.value ? pickedBlock.value[0] + '-' + pickedBlock.value[1] : ''));
const pickedWritten = computed(() => {
  const d = day.value;
  return !!(d && d.written && d.written.indexOf(pickedKey.value) >= 0);
});

async function load(): Promise<void> {
  const r = await callDomain<WorktimeView | null>('worktime.dayForView', null, props.date);
  view.value = r || null;
  picked.value = -1;
}

async function sync(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await worktimeSync(props.date);
    if (!r || !r.ok) {
      emit('notify', (r && r.msg) || '同步失败');
      await load();
      return;
    }
    await load();
    emit('notify', r.partial ? '已同步（未找到离开记录，时长可能偏高）' : '已同步本机时间');
  } finally {
    busy.value = false;
  }
}

function pick(i: number): void {
  if (!segs.value[i].on) { picked.value = -1; return; }
  picked.value = segOwner.value[i];
}

async function writeLine(): Promise<void> {
  if (props.readOnly || !isToday.value) { emit('notify', '只能写进今天的工作格'); return; }
  const r = await callDomain<{ ok: boolean; already?: boolean; line?: string; record?: Record<string, unknown>; msg?: string } | null>(
    'worktime.writeLine', null, props.date, pickedKey.value
  );
  if (!r || !r.ok) { emit('notify', (r && r.msg) || '写入失败'); return; }
  if (r.already) { emit('notify', '这一段已经记过了'); return; }
  const keep = pickedKey.value;
  await load();
  // 写完把浮层停在同一段上：否则一保存就整块消失，用户不知道到底写没写
  const d = day.value;
  if (d) {
    const idx = d.blocks.findIndex((b) => b[0] + '-' + b[1] === keep);
    if (idx >= 0) picked.value = idx;
  }
  if (r.record) emit('written', r.record);
  emit('notify', '已追加到工作格');
}

onMounted(load);
watch(() => [props.date, props.tick], load);
</script>

<template>
  <section v-if="enabled" class="wt">
    <div class="wt-head">
      <span class="wt-total">今日投入 <b>{{ day ? dur(day.activeSec) : '—' }}</b></span>
      <span class="wt-sub" v-if="day">
        离开 {{ dur(day.afkSec) }} · 未归类 <b class="wt-un">{{ day.unclassifiedRatio }}%</b>
      </span>
      <span class="wt-sub" v-else>还没有这一天的本机记录</span>
      <span class="spacer"></span>
      <button class="wt-act" :disabled="busy" :aria-busy="busy" @click="sync">{{ busy ? '同步中…' : '同步' }}</button>
      <button class="wt-act" @click="emit('open-settings')">规则</button>
    </div>

    <div class="wt-band" role="img" :aria-label="day ? '今日投入时间带' : '暂无数据'">
      <span
        v-for="s in segs"
        :key="s.i"
        class="wt-seg"
        :class="{ 'wt-seg-on': s.on, 'wt-seg-pick': s.i === (pickedBlock ? Math.floor(Number(pickedBlock[0]) / 15) : -2) }"
        :data-cell="s.label"
        :title="s.title"
        @click="pick(s.i)"
      ></span>
    </div>
    <div class="wt-axis" aria-hidden="true">
      <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
    </div>

    <div v-if="pickedBlock" class="wt-pop">
      <span class="wt-pop-t">{{ hhmm(Number(pickedBlock[0])) }}–{{ hhmm(Number(pickedBlock[1])) }}</span>
      <span class="wt-pop-a">{{ pickedBlock[3] || '本机' }}</span>
      <span class="wt-pop-l">{{ ruleOf(String(pickedBlock[2]))?.label || '未归类' }}</span>
      <span class="spacer"></span>
      <button class="wt-act" :disabled="pickedWritten || readOnly || !isToday" :title="pickedWritten ? '已记过' : '追加到当天工作格'" @click="writeLine">
        {{ pickedWritten ? '已记过' : '记一条' }}
      </button>
      <button class="wt-act" @click="emit('open-settings')">改归类</button>
    </div>

    <p v-if="view && view.error" class="wt-err">
      {{ view.error.msg }}<span class="wt-code">（{{ view.error.code }}）</span>
    </p>
  </section>
</template>

<style scoped>
.wt {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
}
.wt-head { display: flex; align-items: baseline; gap: 10px; font-size: var(--text-sm); }
.wt-total { color: var(--surface-muted); }
.wt-total b { color: var(--palette-primary); font-size: var(--text-h2); font-variant-numeric: tabular-nums; }
.wt-sub { color: var(--surface-muted); font-size: var(--text-xs); }
.wt-un { color: var(--state-warn); font-variant-numeric: tabular-nums; }
.spacer { flex: 1; }
.wt-act {
  border: 0.5px solid var(--palette-border); background: transparent; color: var(--palette-primary);
  border-radius: var(--radius-sm); font-size: var(--text-xs); padding: 2px 8px; line-height: 16px;
}
.wt-act:disabled { opacity: 0.5; }
.wt-band { display: flex; height: 14px; border-radius: 3px; overflow: hidden; background: var(--palette-soft); }
.wt-seg { flex: 1 1 0; border-right: 0.5px solid var(--surface-panel); cursor: default; }
.wt-seg:last-child { border-right: 0; }
.wt-seg-on { background: var(--palette-primary); opacity: 0.72; cursor: pointer; }
.wt-seg-on[data-cell='未归类'] { background: var(--surface-muted); opacity: 0.5; }
.wt-seg-pick { outline: 1px solid var(--palette-accent); outline-offset: -1px; }
.wt-axis { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--surface-muted); }
.wt-pop {
  display: flex; align-items: center; gap: 8px; font-size: var(--text-xs);
  padding: 4px 6px; border-radius: var(--radius-sm); background: var(--palette-soft);
}
.wt-pop-t { font-variant-numeric: tabular-nums; color: var(--palette-primary); }
.wt-pop-a { color: var(--surface-muted); }
.wt-pop-l { color: var(--palette-accent); }
.wt-err { margin: 0; font-size: var(--text-xs); color: var(--state-warn); }
.wt-code { color: var(--surface-muted); }
</style>
