<script setup lang="ts">
// 右栏不再是「一份固定卡片」——它按当前模块路由到对应的上下文子面板。
// 规划原则：
//   1. 右栏只显示「当前模块真的用得上」的信息，切视图必须换内容；
//   2. 每张卡都要有一个可点击的去处（跳模块 / 进某格），不做死信息；
//   3. 右栏分三层：上半「联动信息」只读；中段「选中项详情」可写，但只写当前选中的那一条
//      （工作格 = 任务详情，见 WorkContext）；下段「本页选项」可写（今日状态 / 快速录入）。
//      正文永远只在主栏编辑——右栏能写的是「这一条」的字段与设置，不是日记本身。
//   4. 皮肤已上移到标题栏右侧；「纯本地 · 零网络」这句合规声明收进全局底栏（StatusBar），
//      不再在每个面板底部各印一遍——同一句话重复十几次只是噪音。
import { computed } from 'vue';
import type { DiaryRecord, ViewKey } from '../types';
import { GRID_LABELS } from '../types';
import { useWritingCheck } from '../composables/useWritingCheck';
import TodayContext from './context/TodayContext.vue';
import TodayOptions from './context/TodayOptions.vue';
import WorkContext from './context/WorkContext.vue';
import StudyContext from './context/StudyContext.vue';
import CellContext from './context/CellContext.vue';
import InsightContext from './context/InsightContext.vue';
import TimelineContext from './context/TimelineContext.vue';
import ReviewContext from './context/ReviewContext.vue';
import CapsuleContext from './context/CapsuleContext.vue';
import WritingContext from './context/WritingContext.vue';
import HabitContext from './context/HabitContext.vue';
import DreamContext from './context/DreamContext.vue';
import DataContext from './context/DataContext.vue';
import BinContext from './context/BinContext.vue';
import InspireContext from './context/InspireContext.vue';
import ReadingContext from './context/ReadingContext.vue';
import FinanceContext from './context/FinanceContext.vue';
import ExploreContext from './context/ExploreContext.vue';
import FamilyContext from './context/FamilyContext.vue';
import LeisureContext from './context/LeisureContext.vue';
import RelationContext from './context/RelationContext.vue';
import SettingsContext from './context/SettingsContext.vue';

const props = defineProps<{
  view: ViewKey;
  cellKey: string;
  record: DiaryRecord;
  total: number;
  written: number;
  // 右栏账本联动用「当前选中日」推月份，不自己读时钟
  today: string;
  // 中栏 GTD 页每次增删改后自增，右栏据此重取一次——
  // 否则刚加完子项，右栏还写着「下一步 0 条」，自相矛盾
  tick: number;
  // 当前选中的 GTD 任务 / 学习条目 / 梦想目标：点中间一行，右栏就换成它的详情
  //（唯一一份选中态在外壳，中栏高亮与右栏表单都读它）
  taskId: string;
  itemId: string;
  dreamId: string;
}>();

const emit = defineEmits<{
  (e: 'navigate', key: ViewKey): void;
  (e: 'open-cell', key: string): void;
  (e: 'open-insight', key: string): void;
  (e: 'select-task', id: string): void;
  (e: 'select-item', id: string): void;
  (e: 'select-dream', id: string): void;
  (e: 'changed'): void;
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
}>();

// 界面减负：右栏头部只留模块标题，不再重复一遍「这一页有什么」的摘要。
// 键保留是为了让视图路由保持显式，值统一为空。
const HINTS: Record<string, string> = {
  today: '', insight: '', timeline: '', review: '', capsule: '', free: '',
  habit: '', dream: '', data: '', bin: '', inspire: '', settings: '',
  life: '', relation: '', connect: '', long: '', reading: '', finance: '', family: '', leisure: ''
};

const headTitle = computed(() => {
  if (props.view === 'cell') return '联动 · ' + (GRID_LABELS[props.cellKey] || '单格');
  if (props.view === 'insight') return '联动 · 单格洞察';
  return '联动 · ' + ({
    today: '今天', timeline: '时间轴', review: '回顾', capsule: '胶囊', free: '自由记录',
    habit: '坚持', dream: '梦想', data: '数据中心', bin: '封存箱',
    inspire: '语料库', settings: '设置', life: '时间纵深',
    relation: '关系经营', connect: '内容连接', long: '长期形状', reading: '图书馆', finance: '家庭账本',
    family: '家庭亲子', leisure: '休闲娱乐'
  }[props.view] || '');
});

const headHint = computed(() => HINTS[props.view] || '');

// 写作法体检的统计卡已从中栏搬到右栏：只有中栏停在「③ 长文撰写」时才挂上来，
// 切到胶囊 / 闪念两 tab 就收回去（右栏是本页的上下文，不是常驻仪表盘）。
const { active: writingActive } = useWritingCheck();
</script>

<template>
  <aside id="rail-drawer" class="context" aria-label="上下文面板" :data-context="view">
    <div class="ctx-head">
      <h2 class="ctx-head-title">{{ headTitle }}</h2>
      <p v-if="headHint" class="ctx-head-hint">{{ headHint }}</p>
    </div>

    <TodayContext
      v-if="view === 'today'"
      :record="record"
      :total="total"
      :written="written"
      :tick="tick"
      @open-cell="emit('open-cell', $event)"
      @navigate="emit('navigate', $event)"
    />
    <!-- 今天这一页的选项（今日状态 / 快速录入）：从主栏搬来的，主栏只留九格与写作 -->
    <TodayOptions
      v-if="view === 'today'"
      :record="record"
      :tick="tick"
      @save="emit('save', $event)"
      @notify="emit('notify', $event)"
      @changed="emit('changed')"
    />
    <!-- 工作格单独一栏：任务详情可写（只写选中的那一条）+ 清单健康 + 每周回顾 -->
    <WorkContext
      v-else-if="view === 'cell' && cellKey === 'work'"
      :task-id="taskId"
      :tick="tick"
      @select-task="emit('select-task', $event)"
      @changed="emit('changed')"
      @notify="emit('notify', $event)"
    />
    <!-- 学习格单独一栏：三块详情（考试 / 技能 / 阅读）+ 总览 + 该看一眼 -->
    <StudyContext
      v-else-if="view === 'cell' && cellKey === 'growth'"
      :item-id="itemId"
      :tick="tick"
      @select-item="emit('select-item', $event)"
      @changed="emit('changed')"
      @notify="emit('notify', $event)"
      @navigate="emit('navigate', $event)"
    />
    <CellContext
      v-else-if="view === 'cell'"
      :cell-key="cellKey"
      :record="record"
      :tick="tick"
      @open-insight="emit('open-insight', $event)"
      @navigate="emit('navigate', $event)"
    />
    <InsightContext
      v-else-if="view === 'insight'"
      :record="record"
      :total="total"
      @open-cell="emit('open-cell', $event)"
      @navigate="emit('navigate', $event)"
    />
    <TimelineContext v-else-if="view === 'timeline'" @navigate="emit('navigate', $event)" />
    <ReviewContext v-else-if="view === 'review'" :tick="tick" @navigate="emit('navigate', $event)" />
    <!-- 胶囊降级后右栏上下文留在「自由记录」页（三 tab 的①就是胶囊收录），
         三组计数与「不泄露未开启正文」的老口径原样保留（GUI #94） -->
    <CapsuleContext v-else-if="view === 'capsule'" @navigate="emit('navigate', $event)" />
    <!-- 自由记录页：长文撰写时右栏先给「写作法」，下面仍是胶囊三组计数（切 tab 即换） -->
    <template v-else-if="view === 'free'">
      <WritingContext v-if="writingActive" />
      <CapsuleContext @navigate="emit('navigate', $event)" />
    </template>
    <HabitContext v-else-if="view === 'habit'" @navigate="emit('navigate', $event)" />
    <!-- 梦想：顶部常驻图片窗 + 选中那条的量化 / 账户 / 日期与总结（可写，只写选中的一条） -->
    <DreamContext
      v-else-if="view === 'dream'"
      :dream-id="dreamId"
      :tick="tick"
      @open-cell="emit('open-cell', $event)"
      @changed="emit('changed')"
      @notify="emit('notify', $event)"
    />
    <DataContext v-else-if="view === 'data'" :total="total" @navigate="emit('navigate', $event)" />
    <BinContext v-else-if="view === 'bin'" @navigate="emit('navigate', $event)" />
    <InspireContext v-else-if="view === 'inspire'" @navigate="emit('navigate', $event)" />
    <ReadingContext
      v-else-if="view === 'reading'"
      :tick="tick"
      @navigate="emit('navigate', $event)"
      @open-cell="emit('open-cell', $event)"
    />
    <FinanceContext
      v-else-if="view === 'finance'"
      :today="today"
      :tick="tick"
    />
    <!-- T17：时间纵深 / 内容连接 / 关系经营 / 长期形状 原来都掉进 SettingsContext 的
         通用兜底，右栏只有「当前配置 + 数据与合规」两张与页面无关的卡，白占 300px。
         现在按页换成真实数据（只读 + 每行可跳转），正文仍只在主栏写。 -->
    <!-- 家庭亲子：本周陪伴 / 还没记到的人 / 最近足迹。只做加法，不评分 -->
    <FamilyContext
      v-else-if="view === 'family'"
      :tick="tick"
      @changed="emit('changed')"
      @notify="emit('notify', $event)"
    />
    <!-- 关系经营：通讯录进右栏（可写），主栏只写正文与流水 -->
    <RelationContext
      v-else-if="view === 'relation'"
      :tick="tick"
      @changed="emit('changed')"
      @notify="emit('notify', $event)"
    />
    <!-- 休闲娱乐：当日阅读账 + 今天的笔记条数 + 打开图书馆入口（只读） -->
    <LeisureContext
      v-else-if="view === 'leisure'"
      :tick="tick"
      :date="record.date"
      @navigate="emit('navigate', $event)"
    />
    <ExploreContext
      v-else-if="view === 'life' || view === 'connect' || view === 'long'"
      :view="view"
      @navigate="emit('navigate', $event)"
    />
    <SettingsContext v-else @navigate="emit('navigate', $event)" />
  </aside>
</template>

<!-- 非 scoped：右栏所有子面板共用一套 ctx-* 版式，避免 11 个组件各写一遍 CSS。
     全部类名以 ctx- 前缀收敛，杜绝与中栏组件撞名（上一轮 .heat-cell 撞名的教训）。 -->
<style>
.context {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--surface-panel);
  border-left: 0.5px solid var(--surface-border);
  min-width: 0;
  overflow: auto;
}
.ctx-head { padding: 0 2px; }
.ctx-head-title { font-size: var(--text-sm); font-weight: 500; margin: 0; color: var(--surface-text); }
.ctx-head-hint { font-size: var(--text-xs); color: var(--surface-muted); margin: 2px 0 0; line-height: 1.5; }

.ctx-card {
  padding: var(--space-2);
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
}
.ctx-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  font-weight: 500;
  margin: 0 0 var(--space-1);
  color: var(--surface-muted);
}
.ctx-tag {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 999px;
  font-size: var(--text-xs);
  font-weight: 400;
  background: var(--palette-soft);
  color: var(--palette-primary);
}
.ctx-tag-warn { background: var(--state-warn-soft); color: var(--state-warn); }
.ctx-warn { color: var(--state-warn); }
.ctx-muted { font-size: var(--text-sm); color: var(--surface-muted); margin: var(--space-1) 0 0; line-height: 1.6; }

.ctx-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { /* 保留旧类名：既有门禁与皮肤卡断言依赖 */
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-panel);
  font-size: var(--text-sm);
  border: 0.5px solid transparent;
}
.chip-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }

.ctx-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.ctx-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.ctx-kv { background: var(--surface-panel); border-radius: var(--radius-md); padding: 6px 8px; }
.ctx-kv-label { display: block; font-size: var(--text-xs); color: var(--surface-muted); }
.ctx-kv-val { display: block; font-size: var(--text-h2); font-weight: 500; color: var(--surface-text); line-height: 1.4; }
.ctx-kv-unit { font-size: var(--text-xs); font-weight: 400; color: var(--surface-muted); margin-left: 2px; }

.ctx-dots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.ctx-dot {
  padding: 3px 4px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  font-size: var(--text-xs);
  color: var(--surface-muted);
  text-align: left;
}
.ctx-dot:hover { border-color: var(--palette-border); }
.ctx-dot-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }

.ctx-list { display: flex; flex-direction: column; gap: 4px; margin: var(--space-1) 0 0; }
.ctx-item {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 4px 8px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--surface-text);
}
button.ctx-item:hover { border-color: var(--palette-border); background: var(--palette-soft); }
.ctx-item-main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-item-side { font-size: var(--text-xs); color: var(--surface-muted); flex: 0 0 auto; }

.past-row { /* 保留旧类名 */
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  margin-top: 4px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  font-size: var(--text-sm);
  text-align: left;
}
.past-on { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }

/* 未来 7 天：一行一件事，左「什么时候」中「类型」右「叫什么」 */
.ctx-soon-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  margin-top: 4px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--surface-text);
}
.ctx-soon-row:hover { border-color: var(--palette-border); background: var(--palette-soft); }
.ctx-soon-on { border-color: var(--palette-border); }
.ctx-soon-when { flex: 0 0 auto; font-size: var(--text-xs); color: var(--surface-muted); min-width: 42px; }
.ctx-soon-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--surface-raised);
  font-size: var(--text-xs);
  color: var(--surface-muted);
}
.ctx-soon-tag[data-kind="capsule"] { background: var(--palette-soft); color: var(--palette-primary); }
.ctx-soon-tag[data-kind="milestone"] { background: var(--state-warn-soft); color: var(--state-warn); }

.ctx-bar { height: 4px; border-radius: 999px; background: var(--surface-panel); overflow: hidden; margin-top: 4px; }.ctx-bar-in { display: block; height: 100%; background: var(--palette-accent); border-radius: 999px; }
.ctx-bar-row { margin-top: 6px; }
.ctx-bar-head { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--surface-muted); }

.ctx-heat { display: grid; grid-template-columns: repeat(15, minmax(0, 1fr)); gap: 2px; margin-top: var(--space-1); }
.ctx-heat-cell { aspect-ratio: 1; border-radius: 2px; background: var(--surface-panel); }
.ctx-heat-on { background: var(--palette-accent); }

.ctx-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--space-1); }
.ctx-link {
  padding: 3px 10px;
  border: 0.5px solid var(--surface-border);
  border-radius: 999px;
  background: var(--surface-panel);
  font-size: var(--text-sm);
}
.ctx-link:hover { border-color: var(--palette-border); background: var(--palette-soft); color: var(--palette-primary); }
/* 版权/合规声明已收进全局底栏（StatusBar），右栏不再留底部卡片 */
</style>
