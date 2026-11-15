<script setup lang="ts">
// 中栏顶部两段：①「时间 + 问候」头（无底色，时间在最顶、问候语大字）；②「每日名言」独立小块。
// 主理人 2026-11-08 21:53 要求：时间置顶并加大、去掉底色，名言警句从问候卡里拆出来单独放在其下方。
// 为什么分开两个 section 而不是一块卡里换行：名言是「读到一句」的东西，问候是「今天是什么日子」，
// 混在一块会让人以为名言是问候的一部分；拆开后名言可单独换、单独管。
//
// 2026-11-09：问候 / 动一动 / 名言三条改为从「语料库」取（使用者可自行增删改）。
// 语料库不可读时退回 utils 的原逻辑，首页不会因此空着。
import { onMounted, ref } from 'vue';
import { callDomain } from '../composables/useDomain';
// 天气条与「今天是几号」同一行：时间在左、窗外在右，都是「此刻」的信息
import WeatherPill from './WeatherPill.vue';

const props = defineProps<{ today: string; total: number }>();
const emit = defineEmits<{ (e: 'navigate', key: 'inspire'): void }>();

type Stats = {
  streak: number; weekCount: number; weekGoal: number;
  bestStreak: number; gentle: string;
};
type Quote = { id?: string; text: string; author: string };
type Greeting = { tag: string; text: string; hint: string };
type Pack = {
  tag: string;
  greeting: { text: string; hint: string; periodLabel?: string };
  quote: Quote;
};

const stats = ref<Stats>({ streak: 0, weekCount: 0, weekGoal: 5, bestStreak: 0, gentle: '' });
const quote = ref<Quote>({ text: '今天也值得被记录。', author: '' });
const greeting = ref<Greeting>({ tag: props.today, text: '慢慢来，比较快。', hint: '写一句就好' });
const shuffleRound = ref(0);

// 语料库优先；读不到就退回原 utils，两条路都给同一份三行结构
async function loadPack(offset: number): Promise<void> {
  const pack = await callDomain<Pack | null>('inspire.today', null, offset ? { offset: offset } : {});
  if (pack && pack.greeting && pack.quote) {
    greeting.value = { tag: pack.tag || '', text: pack.greeting.text || '', hint: pack.greeting.hint || '' };
    quote.value = { id: pack.quote.id, text: pack.quote.text, author: pack.quote.author || '' };
    return;
  }
  const [idx, q, g] = await Promise.all([
    callDomain<number>('quotes.dailyIndex', 0, props.today),
    callDomain<Quote>('quotes.pick', quote.value, 0),
    callDomain<Greeting>('greetings.compose', greeting.value, { anniversary: '' })
  ]);
  const picked = await callDomain<Quote>('quotes.pick', quote.value, Number(idx) || 0);
  if (picked && typeof picked.text === 'string' && picked.text) quote.value = picked;
  else if (q && typeof q.text === 'string') quote.value = q;
  if (g && typeof g.text === 'string') {
    greeting.value = {
      tag: typeof g.tag === 'string' ? g.tag : '',
      text: g.text,
      hint: typeof g.hint === 'string' ? g.hint : ''
    };
  }
}

onMounted(async () => {
  const s = await callDomain<Stats>('stats', stats.value);
  if (s && typeof s === 'object') stats.value = s;
  await loadPack(0);
});

// 「换一条」只换名言，不动问候与动一动：这是三件不同的事，不该一起变
async function shuffleQuote(): Promise<void> {
  shuffleRound.value += 1;
  const hit = await callDomain<Quote | null>('inspire.pick', null, 'quotes', {
    exclude: quote.value.id || '',
    round: shuffleRound.value
  });
  if (hit && hit.text) quote.value = { id: hit.id, text: hit.text, author: hit.author || '' };
}
</script>

<template>
  <section class="greeting-bar" aria-label="今日问候">
    <!-- 时间在最顶部：日期 · 周几 · 节气 · 时段；同一行右侧是此刻窗外的天气。
         天气条嵌在 .greeting-time 里、而不是另起一块：这一行只放「此刻」，
         也不能破坏「时间行是问候头第一个子元素」这条既有约定。 -->
    <div class="greeting-time">
      <span class="greeting-time-text">{{ greeting.tag }}</span>
      <WeatherPill />
    </div>
    <div class="greeting-line">{{ greeting.text }}</div>
    <div v-if="greeting.hint" class="greeting-hint">
      <span class="hint-tag">动一动</span>{{ greeting.hint }}
    </div>
    <!-- 读数与鼓励语同排：左边一句人话，右边三两个数字。
         原来四颗胶囊各占一块，白占一整行；「本机 N 篇」底栏已经有，这里不再重复。 -->
    <div class="foot-row">
      <p class="gentle">{{ stats.gentle }}</p>
      <div class="stat-row">
        <span class="stat" :class="{ 'stat-on': stats.streak > 0 }">连续 {{ stats.streak }} 天</span>
        <span class="stat-dot">·</span>
        <span class="stat">本周 {{ stats.weekCount }}/{{ stats.weekGoal }}</span>
        <template v-if="stats.bestStreak > stats.streak">
          <span class="stat-dot">·</span>
          <span class="stat">最长 {{ stats.bestStreak }} 天</span>
        </template>
      </div>
    </div>
  </section>

  <!-- 名言警句：独立模块，紧接问候下方 -->
  <section class="quote-block" aria-label="每日名言警句">
    <p class="quote-line">
      「{{ quote.text }}」<span v-if="quote.author" class="quote-author">— {{ quote.author }}</span>
    </p>
    <div class="quote-actions">
      <button class="qa-btn" @click="shuffleQuote">换一条</button>
      <button class="qa-btn" @click="emit('navigate', 'inspire')">语料库</button>
    </div>
  </section>
</template>

<style scoped>
/* ① 问候头：无底色、无边框。底色会让「时间」看起来像卡片的标题栏，去掉后它才是页面第一行字。 */
.greeting-bar {
  padding: 0 0 var(--space-1);
  margin-bottom: var(--space-2);
}
.greeting-time {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 22px;
  font-size: var(--text-body);
  line-height: 1.5;
  letter-spacing: 0.04em;
  color: var(--surface-muted);
  font-variant-numeric: tabular-nums;
}

.greeting-line {
  margin-top: 4px;
  font-size: clamp(20px, 1.9vw, 26px);
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0.02em;
  color: var(--palette-primary);
}
.greeting-hint { margin-top: 6px; font-size: var(--text-sm); color: var(--surface-muted); line-height: 1.6; }
.hint-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 999px;
  border: 0.5px solid var(--surface-border);
  font-size: var(--text-xs);
  color: var(--surface-muted);
}
/* 四颗读数胶囊靠右排：左边留白给问候语，右侧这条空白正好放它们，
   不再单独占满一行、把下面的九格往下推 */
/* 读数行：不再做胶囊外壳，一行小字足够。省下的是高度和横向占位，
   不是信息——数字仍在，只是不各占一块白底 */
.foot-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin-top: 8px;
}
.stat-row {
  display: flex;
  align-items: baseline;
  gap: 0 6px;
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--surface-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.stat { white-space: nowrap; }
/* 连续有记录时只把这一处点亮，不整块反白 */
.stat-on { color: var(--palette-primary); font-weight: 600; }
.stat-dot { opacity: 0.35; }
.gentle { margin: 0; font-size: var(--text-sm); color: var(--surface-muted); }

/* ② 名言：单独一块，左侧竖线 + 浅底，与上面的纯文字区分开 */
.quote-block {
  margin-bottom: var(--space-3);
  padding: 8px 12px 8px 12px;
  border-left: 3px solid var(--palette-accent);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: var(--palette-soft);
}
.quote-line {
  margin: 0;
  font-size: var(--text-h2);
  line-height: 1.7;
  color: var(--surface-text);
}
.quote-author {
  margin-left: 6px;
  font-size: var(--text-sm);
  color: var(--surface-muted);
  white-space: nowrap;
}
.quote-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.qa-btn {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: var(--text-xs);
  color: var(--palette-primary);
  cursor: pointer;
}
.qa-btn:hover { text-decoration: underline; }
.qa-hint { margin-left: auto; font-size: var(--text-xs); color: var(--surface-muted); }
</style>
