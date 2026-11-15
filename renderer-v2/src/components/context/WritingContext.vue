<script setup lang="ts">
// 右栏「写作法 · 海明威」：中栏只管写，右栏只管看。
// 三格统计 / 平均句长 / 三张技巧卡都读 useWritingCheck 的同一份结果（中栏与右栏不各算一遍）。
// 唯一的写操作是切换体检开关（落 free.prefs.checkOn）；正文权威源在 md_freewrite，
// 这里不给改写文本、不代写、不自动落库 —— 右栏手上没有正文的写权限。
//
// 类名 fw-stats / fw-stat 是既有 GUI 断言 #138 的抓手（「写作法面板没渲染」），改名会误伤门禁。
import { computed } from 'vue';
import { useWritingCheck } from '../../composables/useWritingCheck';

const { checkOn, result, cards, running, toggle } = useWritingCheck();

const passives = computed(function () {
  const c = result.value.counts;
  return c.passive + c.heavy;
});

const tone = computed(function () {
  const c = result.value.counts;
  if (c.hard > 0) return { text: c.hard + ' 句过长', cls: 'wc-hot' };
  if (c.long > 0) return { text: c.long + ' 句偏长', cls: 'wc-warm' };
  return { text: '句句都短', cls: 'wc-ok' };
});
</script>

<template>
  <section class="ctx-card wc">
    <h2 class="ctx-title">
      写作法 · 海明威
      <span class="ctx-tag">{{ checkOn ? '体检中' : '写作中' }}</span>
    </h2>
    <div class="fw-stats">
      <div class="fw-stat"><b>{{ result.counts.long }}</b><span>长句 · &gt;40 / &gt;60 字</span></div>
      <div class="fw-stat"><b>{{ result.counts.weak }}</b><span>弱化词 · 副词</span></div>
      <div class="fw-stat"><b>{{ passives }}</b><span>被动 / 繁化动词</span></div>
    </div>
    <p class="ctx-muted wc-line">
      平均句长 {{ result.avg }} 字 · 可读性 {{ result.readability }}
      <span class="wc-tone" :class="tone.cls">{{ tone.text }}</span>
    </p>
    <div class="wc-tips">
      <p v-for="c in cards" :key="c.id" class="wc-tip"><b>{{ c.title }}</b>{{ c.body }}</p>
    </div>
    <div class="wc-act">
      <button class="wc-btn" :aria-pressed="checkOn" @click="toggle">
        {{ checkOn ? '回写作态' : '逐句体检' }}
      </button>
      <span v-if="running" class="wc-running">算…</span>
    </div>
    <p class="ctx-muted wc-note">中文用句长近似，不套 ARI。规则是本地纯函数（零联网、零模型、零依赖）：黄=偏长，红=过长，蓝=弱化词，只标色不改写。</p>
  </section>
</template>

<style scoped>
.wc :deep(.ctx-tag) { margin-left: auto; }
.fw-stats { display: flex; flex-direction: column; gap: 4px; }
.fw-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm);
  background: var(--surface-panel);
}
.fw-stat b { order: 2; font-size: var(--text-h2); font-weight: 600; color: var(--palette-primary); line-height: 1.2; }
.fw-stat span { font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.5; }
.wc-line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.wc-tone { font-size: var(--text-xs); padding: 0 6px; border-radius: 999px; background: var(--surface-panel); border: 0.5px solid var(--surface-border); color: var(--surface-muted); }
.wc-tone.wc-hot { background: var(--state-warn-soft); border-color: transparent; color: var(--state-warn); }
.wc-tone.wc-warm { background: var(--palette-soft); border-color: var(--palette-border); color: var(--palette-primary); }
.wc-tone.wc-ok { color: var(--surface-faint); }
.wc-tips { display: flex; flex-direction: column; gap: 5px; margin: var(--space-1) 0 0; }
.wc-tip {
  margin: 0;
  padding: 6px 9px;
  border-left: 2px solid var(--palette-border);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--surface-panel);
  font-size: var(--text-xs);
  line-height: 1.7;
  color: var(--surface-muted);
}
.wc-tip b { display: block; font-size: var(--text-sm); font-weight: 500; color: var(--surface-text); margin-bottom: 1px; }
.wc-act { display: flex; align-items: center; gap: 8px; margin: var(--space-1) 0 0; }
.wc-btn {
  flex: 1;
  font-family: inherit;
  font-size: var(--text-sm);
  padding: 5px 10px;
  border: 0.5px solid var(--palette-border);
  border-radius: var(--radius-sm);
  background: var(--palette-soft);
  color: var(--palette-primary);
  cursor: pointer;
}
.wc-btn:hover { border-color: var(--palette-primary); }
.wc-running { font-size: var(--text-xs); color: var(--surface-faint); }
.wc-note { margin-top: var(--space-1); }
</style>
