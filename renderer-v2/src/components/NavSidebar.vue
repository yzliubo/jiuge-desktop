<script setup lang="ts">
import { computed } from 'vue';
import { GRID_KEYS, GRID_LABELS, NAV_ITEMS, type ViewKey } from '../types';

const props = defineProps<{
  active: ViewKey;
  writtenDates: string[];
  total: number;
  cellKey?: string;
  filledKeys?: string[];
}>();

const emit = defineEmits<{
  (e: 'navigate', key: ViewKey): void;
  (e: 'open-cell', key: string): void;
}>();

// 九格目录：常驻展开，不再有折叠开关。它是「从目录直接进完整功能页」的入口，
// 与九格上双击互为补充——目录常驻，双击就近。
const filled = computed(() => new Set(props.filledKeys || []));

const writtenSet = computed(() => new Set(props.writtenDates));
const currentYear = String(new Date().getFullYear());

const days = computed(() => {
  const out: string[] = [];
  const now = new Date();
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  for (let i = 27; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
  }
  return out;
});

const years = computed(() => {
  const set = new Set(props.writtenDates.map((d) => d.slice(0, 4)));
  return Array.from(set).sort().reverse().slice(0, 4);
});

// 自由记录撤掉一级导航后，它的完整页只剩九格目录这一条入口（openCell('free') → view 'free'）。
// 那时没有 cellKey，得让「自由」这一行自己亮，否则进了页面左栏一处高亮都没有。
function modOn(key: string): boolean {
  if (props.active === 'cell') return props.cellKey === key;
  return props.active === 'free' && key === 'free';
}
</script>

<template>
  <aside class="nav" aria-label="导航与时间定位">
    <nav class="nav-list" aria-label="一级导航与今日九格目录">
      <template v-for="item in NAV_ITEMS" :key="item.key">
        <button
          class="nav-item"
          :class="{ 'nav-on': active === item.key }"
          :aria-current="active === item.key ? 'page' : undefined"
          @click="emit('navigate', item.key)"
        >{{ item.label }}</button>
        <!-- 九格直接挂在「今天」下级：不再多包一层可折叠的分组。
             多那一层，九格就成了三级目录，每次要点还得先展开一次（主理人 2026-11-08 23:16）。
             也没了「今日 · 二级」那个小标题——层级靠缩进就看得懂，不必再写一行字解释。
             单格洞察已上移到标题栏，不再占左栏一行。 -->
        <template v-if="item.key === 'today'">
          <button
            v-for="key in GRID_KEYS"
            :key="key"
            class="nav-sub-item nav-mod"
            :class="{ 'sub-on': modOn(key) }"
            :aria-current="modOn(key) ? 'page' : undefined"
            :aria-label="'进入' + GRID_LABELS[key] + '完整功能页'"
            @click="emit('open-cell', key)"
          >
            <span class="mod-dot" :class="{ 'mod-dot-on': filled.has(key) }"></span>{{ GRID_LABELS[key] }}
          </button>
        </template>
        <!-- V1.3 时间纵深挂在时间轴下：人生月历 / 正文待办 / 随机重读都是「回看」的变体，
             不该再占一个一级导航名额（沿用封存箱 / 语料库的层级口径） -->
        <template v-if="item.key === 'timeline'">
          <button
            class="nav-sub-item nav-life"
            :class="{ 'sub-on': active === 'life' }"
            :aria-current="active === 'life' ? 'page' : undefined"
            @click="emit('navigate', 'life')"
          >└ 时间纵深</button>
          <button
            class="nav-sub-item nav-connect"
            :class="{ 'sub-on': active === 'connect' }"
            :aria-current="active === 'connect' ? 'page' : undefined"
            @click="emit('navigate', 'connect')"
          >└ 内容连接</button>
          <button
            class="nav-sub-item nav-relation"
            :class="{ 'sub-on': active === 'relation' }"
            :aria-current="active === 'relation' ? 'page' : undefined"
            @click="emit('navigate', 'relation')"
          >└ 关系经营</button>
          <button
            class="nav-sub-item nav-long"
            :class="{ 'sub-on': active === 'long' }"
            :aria-current="active === 'long' ? 'page' : undefined"
            @click="emit('navigate', 'long')"
          >└ 长期形状</button>
        </template>
        <!-- 封存箱挂在数据中心下：它属于数据管理，不必占一级导航名额 -->
        <template v-if="item.key === 'data'">
          <button
            class="nav-sub-item nav-bin"
            :class="{ 'sub-on': active === 'bin' }"
            :aria-current="active === 'bin' ? 'page' : undefined"
            @click="emit('navigate', 'bin')"
          >└ 封存箱</button>
          <!-- 语料库同理：它是问候 / 名言 / 运动提示的内容库，不是第 8 个功能模块 -->
          <button
            class="nav-sub-item nav-lib"
            :class="{ 'sub-on': active === 'inspire' }"
            :aria-current="active === 'inspire' ? 'page' : undefined"
            @click="emit('navigate', 'inspire')"
          >└ 语料库</button>
        </template>
      </template>
      <button
        class="nav-item nav-gear"
        :class="{ 'gear-on': active === 'settings' }"
        :aria-current="active === 'settings' ? 'page' : undefined"
        @click="emit('navigate', 'settings')"
      >设置</button>
    </nav>

    <section class="heat-wrap" aria-label="月历热力">
      <h2 class="section-title">最近 28 天</h2>
      <div class="heat">
        <span
          v-for="d in days"
          :key="d"
          class="heat-cell"
          :class="{ 'day-on': writtenSet.has(d) }"
          :aria-label="d + (writtenSet.has(d) ? ' 已记录' : ' 未记录')"
          :title="d"
        ></span>
      </div>
      <div class="year-row">
        <button
          v-for="y in years"
          :key="y"
          class="year-chip"
          :class="{ 'year-on': y === currentYear }"
          :aria-pressed="y === currentYear"
        >{{ y }}</button>
        <span v-if="years.length === 0" class="muted">暂无年份</span>
      </div>
      <p class="counter">本机 {{ total }} 篇</p>
    </section>
  </aside>
</template>

<style scoped>
.nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-3);
  background: var(--surface-panel);
  border-right: 0.5px solid var(--surface-border);
  min-width: 0;
  /* 溢出的责任交给内部两块分开担：导航区自己滚，「最近 28 天」常驻底部。
     都不滚时，超出的部分会漏到页面底部（底栏下面露出半截热力图），
     还会把整页撑出纵向滚动条。 */
  min-height: 0;
  overflow: hidden;
}
.nav-list {
  display: flex;
  flex-direction: column;
  /* T13：一级 7 项 + 九格 9 项 + 时间轴 4 项 + 数据中心 2 项 + 设置，
     23 个按钮在 1440×900 下原本 654px 内容 / 609px 可视（1.07 倍），
     设置虽已 sticky 但整块仍要滚一下。收紧行距与一级按钮上下留白即可
     省下约 76px，把 vRatio 压到 1.0 以内；不动字号也不动命中区高度。 */
  gap: 2px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* 热力 / 年份 / 计数是「我在这条时间的哪儿」，不该被滚走 */
.heat-wrap { flex: 0 0 auto; }
.nav-item {
  text-align: left;
  padding: 6px 12px;
  border: 0.5px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
}
.nav-item:hover { border-color: var(--surface-border); }
.nav-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.nav-sub-item {
  margin-left: 18px;
  width: calc(100% - 18px);
  text-align: left;
  padding: 5px 10px;
  border: 0.5px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  font-size: var(--text-sm);
  color: var(--surface-muted);
}
.nav-sub-item:hover { border-color: var(--surface-border); }
.sub-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.nav-mod { display: flex; align-items: center; gap: 6px; padding-left: 18px; }
.mod-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--surface-border);
  flex: 0 0 auto;
}
.mod-dot-on { background: var(--palette-accent); }
.nav-gear { margin-top: var(--space-2); }
.gear-on { background: var(--palette-soft); color: var(--palette-primary); }
.section-title { font-size: var(--text-sm); font-weight: 500; margin: 0 0 var(--space-1); color: var(--surface-muted); }
.heat { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.heat-cell { height: 14px; border-radius: 3px; background: var(--surface-border); }
.day-on { background: var(--palette-accent); }
.year-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--space-2); }
.year-chip { padding: 2px 8px; border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-raised); }
.year-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.counter, .muted { color: var(--surface-muted); font-size: var(--text-sm); margin: var(--space-2) 0 0; }
/* 高度响应式（原来全仓 0 个高度断点）：先让热力图收缩，再让设置常驻可见 */
.nav-gear { position: sticky; bottom: 0; z-index: 1; background: var(--surface-panel); }
@media (max-height: 820px) {
  .nav { gap: var(--space-2); padding: var(--space-2); }
  .nav-list { gap: 2px; }
  .heat-wrap .heat, .heat-wrap .year-row, .heat-wrap .counter { display: none; }
  .heat-wrap .section-title { margin: 0; }
}
@media (max-height: 720px) { .heat-wrap { display: none; } }
</style>
