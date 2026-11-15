<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../composables/useDomain';

interface Milestone { at: number; reward: string; label?: string; hint?: string; done?: boolean; remain?: number }
type Stats = {
  streak: number; total: number; bestStreak: number; startedAt: string;
  weekCount: number; weekGoal: number; weekTotal: number; thousandProgress?: number; gentle?: string;
};
type FirstWeek = { active: boolean; dayNo: number; enabled: boolean; total: number; celebration?: string };

const stats = ref<Stats>({ streak: 0, total: 0, bestStreak: 0, startedAt: '', weekCount: 0, weekGoal: 5, weekTotal: 7 });
const milestones = ref<Milestone[]>([]);
const firstWeek = ref<FirstWeek>({ active: false, dayNo: 0, enabled: false, total: 0 });
const newAt = ref('30');
const newReward = ref('');
const message = ref('');

const challenge = computed(() => {
  const s = stats.value.streak;
  if (s < 3) return { title: '三天', text: '先写满三天，不必追求完美。' };
  if (s < 90) return { title: '三月', text: '已经过了最初的门槛，保持节奏。' };
  if (s < 1095) return { title: '三年', text: '习惯正在变成生活的一部分。' };
  return { title: '稳定飞行', text: '不必再数天数，写就是了。' };
});

const thousand = computed(() => Math.min(100, (stats.value.total / 1000) * 100));

async function refresh(): Promise<void> {
  const s = await callDomain<Stats>('stats', stats.value);
  if (s && typeof s === 'object') stats.value = s;
  // milestoneView(total) 返回 {total, list, next, count}，里程碑在 list 里
  const mv = await callDomain<{ list?: Milestone[] }>('milestoneView', {}, stats.value.total);
  milestones.value = (mv && Array.isArray(mv.list)) ? mv.list : [];
}

async function add(): Promise<void> {
  const at = Math.max(1, Math.min(10000, Math.floor(Number(newAt.value) || 0)));
  const reward = newReward.value.trim().slice(0, 30);
  if (!reward) { message.value = '请写一句奖励'; return; }
  const next = milestones.value.map(function (m) { return { at: m.at, reward: m.reward }; });
  const hit = next.find(function (m) { return m.at === at; });
  if (hit) hit.reward = reward; else next.push({ at, reward });
  await callDomain('saveMilestones', null, next.slice(0, 12));
  newReward.value = ''; message.value = '里程碑已保存';
  await refresh();
}

async function remove(at: number): Promise<void> {
  const next = milestones.value.filter(function (m) { return m.at !== at; })
    .map(function (m) { return { at: m.at, reward: m.reward }; });
  await callDomain('saveMilestones', null, next);
  await refresh();
}

async function reset(): Promise<void> {
  await callDomain('resetMilestones', null);
  message.value = '已恢复默认里程碑';
  await refresh();
}

onMounted(async () => {
  firstWeek.value = await callDomain<FirstWeek>('firstWeekState', firstWeek.value);
  await refresh();
});
</script>

<template>
  <section class="habit">
    <header class="head"><h1>坚持 · 记录本身的刻度</h1></header>

    <div class="card hero">
      <div class="big">{{ stats.streak }} <small>天连续</small></div>
      <div class="stats">
        <span class="stat" :class="{ 'stat-on': stats.streak > 0 }">累计 {{ stats.total }} 篇</span>
        <span class="stat">最长 {{ stats.bestStreak }} 天</span>
        <span class="stat">本周 {{ stats.weekCount }} / {{ stats.weekGoal }}</span>
        <span class="stat">启程 {{ stats.startedAt || '—' }}</span>
      </div>
      <div class="progress"><span :style="{ width: thousand + '%' }"></span></div>
      <p class="muted">{{ stats.gentle || challenge.text }} · 千日进度 {{ Math.round(thousand) }}%</p>
    </div>

    <div class="card"><h2>三大考验期 · {{ challenge.title }}</h2><p class="line">{{ challenge.text }}</p></div>

    <div v-if="firstWeek.active" class="card first" :class="{ 'first-on': firstWeek.active }">
      <h2>头七天引导 · 第 {{ firstWeek.dayNo }} 天</h2>
    </div>

    <div class="card">
      <h2>奖励里程碑</h2>
      <div class="row">
        <input v-model="newAt" class="text at" type="number" min="1" max="10000" placeholder="天数" />
        <input v-model="newReward" class="text" maxlength="30" placeholder="给自己的奖励（≤30 字）" />
        <button class="btn" :class="{ 'btn-on': !!newReward.trim() }" @click="add">添加 / 合并</button>
        <button class="seg" @click="reset">恢复默认</button>
      </div>
      <div v-for="m in milestones" :key="m.at" class="item" :class="{ 'item-on': m.done }">
        <span class="badge">{{ m.label || ('第 ' + m.at + ' 天') }}</span>
        <span class="reward">{{ m.reward }}</span>
        <span class="muted">{{ m.done ? '已达成' : '还差 ' + (m.remain ?? Math.max(0, m.at - stats.total)) + ' 篇' }}</span>
        <button class="del" aria-label="删除里程碑" @click="remove(m.at)">×</button>
      </div>
      <p v-if="milestones.length === 0" class="empty">还没有设置奖励</p>
      <p v-if="message" class="message">{{ message }}</p>
    </div>
  </section>
</template>

<style scoped>
.habit { display: flex; flex-direction: column; gap: var(--space-2); }
.head h1 { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.head p { font-size: var(--text-sm); color: var(--surface-muted); margin: 4px 0 0; }
.card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.card h2 { font-size: var(--text-body); font-weight: 500; margin: 0 0 6px; }
.hero { background: var(--palette-soft); }
.big { font-size: 24px; font-weight: 500; color: var(--palette-primary); }
.big small { font-size: var(--text-sm); font-weight: 400; }
.stats { display: flex; flex-wrap: wrap; gap: 6px; margin: var(--space-2) 0; }
.stat { padding: 2px 8px; border-radius: 999px; background: var(--surface-raised); font-size: var(--text-sm); }
.stat-on, .badge { background: var(--palette-primary); color: var(--palette-on); }
.progress { height: 5px; background: var(--surface-border); border-radius: 3px; margin-bottom: 6px; }
.progress span { display: block; height: 100%; background: var(--palette-accent); border-radius: 3px; }
.line, .muted, .empty, .message { font-size: var(--text-sm); color: var(--surface-muted); }
.message { color: var(--palette-primary); }
.first { background: var(--palette-soft); }
.first-on { border-color: var(--palette-border); }
.row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: var(--space-2); }
.text { flex: 1; min-width: 100px; padding: 6px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; }
.at { flex: 0 0 80px; }
.btn, .seg { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.btn-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); margin-bottom: 4px; font-size: var(--text-sm); }
.item-on { border-color: var(--palette-accent); }
.badge { padding: 2px 8px; border-radius: 999px; }
.reward { flex: 1; }
.del { border: 0; background: transparent; }
</style>
