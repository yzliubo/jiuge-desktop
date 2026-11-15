<script setup lang="ts">
// A2 正文待办汇总：纯展示组件，只读。
// 刻意不放任何 domainCall / saveExport / 写操作——勾选必须回原文，
// 否则正文与这张表就成了两份真相（docs/10 §9-A2）。
import { GRID_LABELS, type TodoRow } from '../types';

const props = defineProps<{
  open: TodoRow[];
  done: TodoRow[];
  loaded: boolean;
}>();
const emit = defineEmits<{ (e: 'go-date', date: string): void }>();

function label(k: string): string {
  return (GRID_LABELS as Record<string, string>)[k] || k;
}
</script>

<template>
  <section class="v13-digest" aria-label="正文待办汇总">
    <p class="v13-note">只读 · 勾选请回到原文</p>
    <p v-if="!loaded" class="v13-empty">正在读取本机记录…</p>
    <template v-else>
      <p v-if="open.length === 0 && done.length === 0" class="v13-empty">正文里还没有待办</p>
      <div v-else class="v13-digest-cols">
        <div class="v13-digest-col">
          <h3 class="v13-h3">未完成 <span class="v13-count">{{ open.length }}</span></h3>
          <p v-if="open.length === 0" class="v13-empty">没有未完成项</p>
          <button
            v-for="(row, i) in open"
            :key="'o' + i"
            class="v13-todo"
            @click="emit('go-date', row.date)"
          >
            <span class="v13-todo-meta">{{ row.date }} · {{ label(row.cell) }}</span>
            <span class="v13-todo-text">{{ row.text }}</span>
          </button>
        </div>
        <div class="v13-digest-col">
          <h3 class="v13-h3">已完成 <span class="v13-count">{{ done.length }}</span></h3>
          <p v-if="done.length === 0" class="v13-empty">没有已完成项</p>
          <button
            v-for="(row, i) in done"
            :key="'d' + i"
            class="v13-todo v13-todo-done"
            @click="emit('go-date', row.date)"
          >
            <span class="v13-todo-meta">{{ row.date }} · {{ label(row.cell) }}</span>
            <span class="v13-todo-text">{{ row.text }}</span>
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.v13-digest { display: flex; flex-direction: column; gap: 12px; }
.v13-note { margin: 0; font-size: var(--text-sm); line-height: 1.6; color: var(--text-secondary, #5f5e5a); }
.v13-note code { font-family: var(--font-mono, monospace); }
.v13-empty { margin: 0; padding: 18px; font-size: var(--text-body); color: var(--text-tertiary, #888780); text-align: center; }
.v13-digest-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.v13-h3 { margin: 0 0 8px; font-size: var(--text-h2); font-weight: 500; }
.v13-count { font-size: var(--text-sm); color: var(--text-secondary, #5f5e5a); }
.v13-todo { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 8px 10px; margin-bottom: 6px; text-align: left; border: 0.5px solid var(--border-tertiary, #e2e0d9); border-radius: 8px; background: var(--background-primary, #fff); cursor: pointer; }
.v13-todo:hover { border-color: var(--border-secondary, #c9c7be); }
.v13-todo-meta { font-size: var(--text-xs); color: var(--text-secondary, #5f5e5a); }
.v13-todo-text { font-size: var(--text-body); line-height: 1.5; word-break: break-word; }
.v13-todo-done .v13-todo-text { text-decoration: line-through; color: var(--text-tertiary, #888780); }
</style>
