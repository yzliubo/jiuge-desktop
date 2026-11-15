<script setup lang="ts">
// 底栏是全局唯一一条状态行：本机篇数、备份状态、数据目录入口，
// 以及「V1.0 · 纯本地 · 零网络」这条合规声明。
//
// 2026-11-09 主理人要求：这句话原来在右栏每一个面板底部都出现一遍，
// 一页页重复等于噪音；声明只该有一个落点，就收在这里。
// 同时底栏压到 22px——它只是读数，不该占掉一行内容的高度。
import { computed } from 'vue';

const props = defineProps<{
  total: number;
  backupTime: string;
  dirty: boolean;
  mock: boolean;
  // 本机时间源是否开启：开启后底栏必须如实改口，不能一边读回环一边写「零网络」
  wtOn?: boolean;
  // 首页天气是否开启：天气要连外网，开了就更不能写「零网络」
  wxOn?: boolean;
}>();

const emit = defineEmits<{
  (e: 'openDataDir'): void;
}>();

// 「上次自动备份 —」既长又等于没说：没备份过就说「未备份」，有备份才报时间。
const backupLabel = (): string => {
  const t = String(props.backupTime || '').trim();
  return t && t !== '—' && t !== '-' ? '备份 ' + t : '未备份';
};

// 合规声明按实际开关改口。三态不够用（两样都开时要两个都说），所以组合成四种说法。
const netLabel = computed(() => {
  if (props.wxOn && props.wtOn) return '仅本机 + 天气联网';
  if (props.wxOn) return '仅天气联网';
  if (props.wtOn) return '仅本机使用';
  return '零网络';
});
const netTitle = computed(() => {
  if (props.wxOn && props.wtOn) return '日记只写本机；只读本机 ActivityWatch 汇总，只向气象服务取天气；不上传日记、无账号、无遥测';
  if (props.wxOn) return '日记只写本机；只向气象服务取当前天气（不发送日记内容）；不上传、无账号、无遥测';
  if (props.wtOn) return '只读本机 ActivityWatch 汇总（127.0.0.1:5600），不出本机；不上传、无账号、无遥测';
  return '所有记录只写本机数据目录，不上传、不联网';
});
</script>

<template>
  <footer class="statusbar">
    <span class="bar-cell">本机 {{ total }} 篇</span>
    <span class="sep">·</span>
    <span class="bar-cell">{{ backupLabel() }}</span>
    <span class="sep">·</span>
    <button class="dir-btn" title="打开本机数据目录" @click="emit('openDataDir')">打开数据目录</button>
    <span class="spacer"></span>
    <span v-if="dirty" class="dirty">写入中</span>
    <span v-if="mock" class="mock">开发模式（内存桥）</span>
    <span
      class="local"
      :class="{ 'local-loop': !!wtOn || !!wxOn }"
      :title="netTitle"
    >V1.0 · 纯本地 · {{ netLabel }}</span>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 100%;
  padding: 0 var(--space-3);
  border-top: 0.5px solid var(--surface-border);
  background: var(--surface-panel);
  font-size: var(--text-xs);
  line-height: 1;
  color: var(--surface-muted);
  white-space: nowrap;
  overflow: hidden;
}
/* 类名带 bar- 前缀：.cell 是九格的类，撞名会让断言数到 11 个格子，样式也会串味 */
.bar-cell { font-variant-numeric: tabular-nums; }
.sep { opacity: 0.4; }
.spacer { flex: 1; }
.dir-btn {
  border: 0; background: transparent; color: var(--palette-primary);
  padding: 0 4px; font-size: var(--text-xs); line-height: 20px; min-height: 20px;
}
.dir-btn:hover { text-decoration: underline; }
.local { color: var(--surface-muted); }
/* 开启本机时间源后改口并换色：合规声明不能一边读回环一边写「零网络」 */
.local-loop { color: var(--palette-accent); }
/* 写入只是瞬时状态，用一个小色点 + 文字，不和常显的合规声明抢位置 */
.dirty { color: var(--palette-accent); }
.dirty::before {
  content: ''; display: inline-block; width: 5px; height: 5px;
  margin-right: 4px; border-radius: 50%; background: currentColor;
  vertical-align: 1px;
}
.mock { color: var(--palette-accent); }
</style>
