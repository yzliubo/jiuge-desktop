<script setup lang="ts">
// T17：时间纵深 / 内容连接 / 关系经营 / 长期形状 四个页面的右栏。
// 原来这四个 view 都掉进 SettingsContext 的 fallback，右栏只有「当前配置 +
// 数据与合规」两张与页面无关的卡，白占最贵的 300px。现在按页面换成真实数据，
// 且全部只读 + 每行都有跳转（正文永远在主栏写，右栏不写数据）。
// 领域返回形状按 src/v13|relation|tags|search|review|trace|attach 的真实实现取，
// 不按想象写字段（历史上踩过「静态门禁全绿但功能全废」的坑）。
import { computed, ref, watch } from 'vue';
import { callDomain } from '../../composables/useDomain';
import type { ViewKey } from '../../types';

const props = defineProps<{ view: ViewKey }>();
const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

interface Cal {
  writtenMonths?: number; passedMonths?: number; totalRecords?: number;
  headline?: string; months?: Array<{ year: number; count: number; future?: boolean }>;
}
interface Todos { open?: unknown[]; total?: number }
interface TagStat { tags?: number; links?: number; taggedTargets?: number; byTag?: Array<{ name: string; count: number }> }
interface CoolingItem { name?: string; daysSince?: number; never?: boolean }
interface Analytics { cooling?: { count?: number; items?: CoolingItem[] } }
interface Term { name?: string; next?: string; daysLeft?: number }

const loading = ref(true);
const cal = ref<Cal>({});
const todos = ref<Todos>({});
const tags = ref<TagStat>({});
const links = ref<unknown[]>([]);
const analytics = ref<Analytics>({});
const term = ref<Term>({});
const traces = ref<unknown[]>([]);
const attaches = ref<unknown[]>([]);

// 人生月历按年汇总最近 6 个有记录的年份，做成横条；空月历不画一排空条。
const yearBars = computed(() => {
  const by = new Map<number, number>();
  (cal.value.months || []).forEach(function (m) {
    if (!m || m.future) return;
    by.set(m.year, (by.get(m.year) || 0) + (m.count > 0 ? 1 : 0));
  });
  return Array.from(by.entries()).slice(-6).map(function (e) {
    return { label: String(e[0]), count: e[1] };
  });
});
const maxBar = computed(() => Math.max(1, ...yearBars.value.map((x) => x.count)));
const cooling = computed(() => {
  const c = analytics.value.cooling || {};
  return {
    count: typeof c.count === 'number' ? c.count : 0,
    items: (Array.isArray(c.items) ? c.items : []).slice(0, 3)
  };
});
const topTags = computed(() => (tags.value.byTag || []).filter((t) => t.count > 0).slice(0, 4));

async function load(): Promise<void> {
  loading.value = true;
  try {
    if (props.view === 'life') {
      const [c, t] = await Promise.all([
        callDomain<Cal | null>('v13.calendar', null, {}),
        callDomain<Todos | null>('v13.todos', null)
      ]);
      cal.value = c || {};
      todos.value = t || {};
    } else if (props.view === 'relation') {
      analytics.value = await callDomain<Analytics | null>('relation.analytics', null) || {};
    } else if (props.view === 'connect') {
      const [s, l] = await Promise.all([
        callDomain<TagStat | null>('tags.stats', null),
        callDomain<unknown[] | null>('search.linksAll', null)
      ]);
      tags.value = s || {};
      links.value = Array.isArray(l) ? l : [];
    } else {
      const [tm, tr, at] = await Promise.all([
        callDomain<Term | null>('term.current', null),
        callDomain<unknown[] | null>('trace.all', null),
        callDomain<unknown[] | null>('attach.list', null)
      ]);
      term.value = tm || {};
      traces.value = Array.isArray(tr) ? tr : [];
      attaches.value = Array.isArray(at) ? at : [];
    }
  } finally {
    loading.value = false;
  }
}
watch(() => props.view, load, { immediate: true });
</script>

<template>
  <!-- 时间纵深：年份分布 + 正文待办 -->
  <template v-if="view === 'life'">
    <section class="ctx-card">
      <h2 class="ctx-title">年份分布 <span v-if="cal.totalRecords" class="ctx-tag">{{ cal.totalRecords }} 篇</span></h2>
      <p v-if="cal.headline" class="ctx-muted">{{ cal.headline }}</p>
      <div v-for="y in yearBars" :key="y.label" class="ctx-bar-row">
        <div class="ctx-bar-head"><span>{{ y.label }}</span><span>{{ y.count }} 个月</span></div>
        <div class="ctx-bar"><i class="ctx-bar-in" :style="{ width: Math.round(y.count * 100 / maxBar) + '%' }"></i></div>
      </div>
      <p v-if="!loading && !yearBars.length" class="ctx-muted">还没有记录，写几天后这里会出现年份分布。</p>
      <p v-if="loading" class="ctx-muted">读取中…</p>
      <div class="ctx-links">
        <button class="ctx-link" @click="emit('navigate', 'timeline')">看时间轴</button>
        <button class="ctx-link" @click="emit('navigate', 'data')">去数据中心</button>
      </div>
    </section>
    <section class="ctx-card">
      <h2 class="ctx-title">正文待办</h2>
      <div class="ctx-grid">
        <div class="ctx-kv"><span class="ctx-kv-label">未完成</span><span class="ctx-kv-val">{{ (todos.open || []).length }}<span class="ctx-kv-unit">条</span></span></div>
        <div class="ctx-kv"><span class="ctx-kv-label">累计</span><span class="ctx-kv-val">{{ todos.total || 0 }}<span class="ctx-kv-unit">条</span></span></div>
      </div>
      <p class="ctx-muted">勾选请回正文原文，这里只做汇总。</p>
    </section>
  </template>

  <!-- 关系经营：待联系提醒 -->
  <template v-else-if="view === 'relation'">
    <section class="ctx-card">
      <h2 class="ctx-title">该联系谁 <span v-if="cooling.count" class="ctx-tag">{{ cooling.count }} 人</span></h2>
      <div v-if="cooling.items.length" class="ctx-list">
        <div v-for="(c, i) in cooling.items" :key="i" class="ctx-item">
          <span class="ctx-item-main">{{ c.name || '未命名' }}</span>
          <span class="ctx-item-side">{{ c.never ? '还没记过' : (c.daysSince || 0) + ' 天' }}</span>
        </div>
      </div>
      <p v-else-if="!loading" class="ctx-muted">暂时没有需要提醒的人。</p>
      <p v-if="loading" class="ctx-muted">读取中…</p>
      <div class="ctx-links">
        <button class="ctx-link" @click="emit('navigate', 'today')">回今日九格</button>
        <button class="ctx-link" @click="emit('navigate', 'review')">看复盘</button>
      </div>
    </section>
    <section class="ctx-card">
      <h2 class="ctx-title">记录说明</h2>
      <p class="ctx-muted">温度只按「记过的联系」算，半年没记不等于半年没联系；不给关系打分。</p>
    </section>
  </template>

  <!-- 内容连接：标签与最近命中 -->
  <template v-else-if="view === 'connect'">
    <section class="ctx-card">
      <h2 class="ctx-title">连接规模</h2>
      <div class="ctx-grid">
        <div class="ctx-kv"><span class="ctx-kv-label">标签</span><span class="ctx-kv-val">{{ tags.tags || 0 }}</span></div>
        <div class="ctx-kv"><span class="ctx-kv-label">关联</span><span class="ctx-kv-val">{{ tags.links || 0 }}</span></div>
        <div class="ctx-kv"><span class="ctx-kv-label">内链</span><span class="ctx-kv-val">{{ links.length }}</span></div>
        <div class="ctx-kv"><span class="ctx-kv-label">被标对象</span><span class="ctx-kv-val">{{ tags.taggedTargets || 0 }}</span></div>
      </div>
    </section>
    <section class="ctx-card">
      <h2 class="ctx-title">用得最多的标签</h2>
      <div v-if="topTags.length" class="ctx-list">
        <div v-for="(t, i) in topTags" :key="i" class="ctx-item">
          <span class="ctx-item-main">{{ t.name }}</span><span class="ctx-item-side">{{ t.count }} 处</span>
        </div>
      </div>
      <p v-else-if="!loading" class="ctx-muted">还没有标签，去主栏给某篇打一个。</p>
      <p v-if="loading" class="ctx-muted">读取中…</p>
      <div class="ctx-links">
        <button class="ctx-link" @click="emit('navigate', 'timeline')">按时间找</button>
        <button class="ctx-link" @click="emit('navigate', 'data')">去数据中心</button>
      </div>
    </section>
  </template>

  <!-- 长期形状：节气 / 弱引用 / 附件 -->
  <template v-else>
    <section class="ctx-card">
      <h2 class="ctx-title">此刻节气 <span v-if="term.name" class="ctx-tag">{{ term.name }}</span></h2>
      <div class="ctx-grid">
        <div class="ctx-kv"><span class="ctx-kv-label">距下一个</span><span class="ctx-kv-val">{{ term.daysLeft ?? '—' }}<span class="ctx-kv-unit">天</span></span></div>
        <div class="ctx-kv"><span class="ctx-kv-label">下一个</span><span class="ctx-kv-val" style="font-size: var(--text-body)">{{ term.next || '—' }}</span></div>
      </div>
      <p class="ctx-muted">节气按 ±1 天近似，只作复盘刻度。</p>
    </section>
    <section class="ctx-card">
      <h2 class="ctx-title">长期引用</h2>
      <div class="ctx-list">
        <div class="ctx-item"><span class="ctx-item-main">弱引用</span><span class="ctx-item-side">{{ traces.length }} 条</span></div>
        <div class="ctx-item"><span class="ctx-item-main">链接型附件</span><span class="ctx-item-side">{{ attaches.length }} 个</span></div>
      </div>
      <div class="ctx-links">
        <button class="ctx-link" @click="emit('navigate', 'review')">写节气复盘</button>
        <button class="ctx-link" @click="emit('navigate', 'data')">去数据中心</button>
      </div>
    </section>
  </template>
</template>
