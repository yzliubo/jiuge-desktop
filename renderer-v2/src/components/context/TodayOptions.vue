<script setup lang="ts">
// 右栏「本页选项」：今天这一页的配置与快速录入，从主栏搬过来的。
// 为什么搬：主栏是「写」的地方，九格 + 正文才是正文；今日状态与三块录入面板属于
// 「这一页的设置/入口」，和右栏的联动信息是同一类，放一起才叫关联展示（主理人 2026-11-08 22:32）。
// 代价要说清：右栏从此不是纯只读了——但写入仍然只发生在这张卡里，且改的是 base / 看板这类
// 「设置与分类数据」，正文永远只在主栏编辑。
import { ref } from 'vue';
import TodayExtras from '../TodayExtras.vue';
import ModulePanels from '../ModulePanels.vue';
import type { DiaryRecord } from '../../types';

defineProps<{ record: DiaryRecord }>();
const emit = defineEmits<{
  (e: 'save', record: DiaryRecord): void;
  (e: 'notify', text: string): void;
}>();

const tab = ref<'base' | 'quick'>('base');
</script>

<template>
  <section class="ctx-card today-opt" aria-label="本页选项">
    <h2 class="ctx-title">本页选项<span class="ctx-tag">可写</span></h2>
    <div class="opt-tabs" role="tablist" aria-label="本页选项分组">
      <button
        class="opt-tab"
        :class="{ 'opt-tab-on': tab === 'base' }"
        role="tab"
        :aria-selected="tab === 'base'"
        @click="tab = 'base'"
      >今日状态</button>
      <button
        class="opt-tab"
        :class="{ 'opt-tab-on': tab === 'quick' }"
        role="tab"
        :aria-selected="tab === 'quick'"
        @click="tab = 'quick'"
      >快速录入</button>
    </div>

    <TodayExtras
      v-if="tab === 'base'"
      flat
      :record="record"
      @save="emit('save', $event)"
      @notify="emit('notify', $event)"
    />
    <ModulePanels
      v-else
      flat
      :record="record"
      @save="emit('save', $event)"
      @notify="emit('notify', $event)"
    />
  </section>
</template>

<style scoped>
.opt-tabs { display: flex; gap: 6px; margin-bottom: var(--space-2); }
.opt-tab {
  flex: 1;
  padding: 5px 8px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  font-size: var(--text-sm);
}
.opt-tab-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
</style>
