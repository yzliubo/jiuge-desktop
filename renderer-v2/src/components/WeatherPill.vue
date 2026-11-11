<script setup lang="ts">
// 首页顶部的一小条「此刻窗外」：地点 · 天气 · 温度 · 今日高低温。
//
// 它只放在问候头的时间那一行右侧——时间回答「今天是什么日子」，天气回答「今天穿什么」，
// 同一行、同一字号层级，不额外占一条横条。九格的主栏已经很挤了。
//
// 三种状态都必须好看，否则会变成「一块坏掉的 UI」：
//   取到数据 → 正常显示；取不到 → 保留上次的温度并写灰，点开能看原因；关掉 → 整块不渲染。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useWeather } from '../composables/useWeather';

const { state, placeLabel, deg, refresh, useCity, useAuto, setEnabled } = useWeather();

const open = ref(false);
const cityInput = ref('');
const cityMsg = ref('');
const cityBusy = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const now = computed(() => (state.report ? state.report.now : null));
const today = computed(() => (state.report ? state.report.today : null));

// 提示语写清「数据从哪来、什么时候取的」——首页上任何数字都该能被追问一句
const tip = computed(() => {
  if (!state.enabled) return '首页天气已关闭';
  if (state.error) return '取天气失败：' + state.error.msg + '（点开可重试）';
  if (!state.report) return '正在取当地天气…';
  const t = state.report;
  const at = state.fetchedAt ? new Date(state.fetchedAt) : null;
  const hm = at ? String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0') : '—';
  const parts = [
    t.place.region && t.place.region !== t.place.label ? t.place.region + ' ' + t.place.label : t.place.label,
    t.now.text,
    '体感 ' + deg(t.now.feels),
    '湿度 ' + (t.now.humidity === null ? '—' : Math.round(t.now.humidity) + '%'),
    '风 ' + (t.now.wind === null ? '—' : Math.round(t.now.wind) + ' km/h'),
    t.today.rainProb === null ? '' : '降水概率 ' + Math.round(t.today.rainProb) + '%',
    '更新 ' + hm
  ].filter(Boolean);
  return parts.join(' · ') + (state.stale ? '（这是上次取到的，可能已过期）' : '');
});

async function doRefresh(): Promise<void> {
  cityMsg.value = '';
  await refresh();
}

async function submitCity(): Promise<void> {
  const q = cityInput.value.trim();
  if (!q || cityBusy.value) return;
  cityBusy.value = true;
  cityMsg.value = '正在查…';
  const r = await useCity(q);
  cityBusy.value = false;
  cityMsg.value = r.ok ? '已切到「' + q + '」' : (r.msg || '找不到这个城市');
  if (r.ok) cityInput.value = '';
}

async function backToAuto(): Promise<void> {
  cityMsg.value = '';
  await useAuto();
}

async function turnOff(): Promise<void> {
  open.value = false;
  await setEnabled(false);
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return;
  const el = rootEl.value;
  if (el && ev.target instanceof Node && !el.contains(ev.target)) open.value = false;
}

onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <!-- 关掉时整块消失：不占位、不留「天气已关闭」这种自我说明的噪音 -->
  <div v-if="state.enabled" ref="rootEl" class="weather" :class="{ 'weather-stale': state.stale || !!state.error }">
    <button class="wx-btn" type="button" :title="tip" :aria-expanded="open" @click.stop="open = !open">
      <span class="wx-icon" aria-hidden="true">{{ now ? now.icon : '·' }}</span>
      <span class="wx-place">{{ placeLabel }}</span>
      <span v-if="state.loading && !now" class="wx-temp">…</span>
      <template v-else>
        <span class="wx-temp">{{ now ? deg(now.temp) : '—' }}</span>
        <span v-if="today && today.max !== null" class="wx-range">{{ deg(today.max) }}/{{ deg(today.min) }}</span>
      </template>
      <span v-if="state.error" class="wx-warn" aria-hidden="true">!</span>
    </button>

    <div v-if="open" class="wx-pop" role="dialog" aria-label="天气设置">
      <div v-if="now" class="wx-line">
        <strong>{{ placeLabel }}</strong>
        <span>{{ now.text }} {{ deg(now.temp) }}</span>
      </div>
      <div v-if="now" class="wx-sub">
        体感 {{ deg(now.feels) }}
        <span v-if="now.humidity !== null"> · 湿度 {{ Math.round(now.humidity) }}%</span>
        <span v-if="now.wind !== null"> · 风 {{ Math.round(now.wind) }} km/h</span>
      </div>
      <div v-if="today && today.rainProb !== null" class="wx-sub">今日降水概率 {{ Math.round(today.rainProb) }}%</div>
      <p v-if="state.error" class="wx-err">{{ state.error.msg }}</p>
      <p v-else-if="state.stale" class="wx-err">这是上次取到的数据，可能已过期。</p>

      <div class="wx-row">
        <button class="wx-link" type="button" :disabled="state.loading" @click="doRefresh">
          {{ state.loading ? '正在取…' : '刷新' }}
        </button>
        <button class="wx-link" type="button" @click="backToAuto">按网络定位</button>
        <button class="wx-link" type="button" @click="turnOff">关闭天气</button>
      </div>

      <div class="wx-row">
        <input
          v-model="cityInput"
          class="wx-in"
          maxlength="24"
          placeholder="手填城市，如 苏州"
          aria-label="手填城市"
          @keydown.enter.prevent="submitCity"
        />
        <button class="wx-link" type="button" :disabled="cityBusy" @click="submitCity">查</button>
      </div>
      <p v-if="cityMsg" class="wx-sub">{{ cityMsg }}</p>
      <p class="wx-note">取天气会把出口 IP 暴露给定位服务；不发送日记、机器名或任何本机内容。</p>
    </div>
  </div>
</template>

<style scoped>
.weather { position: relative; margin-left: auto; }
.wx-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border: 0.5px solid var(--surface-border);
  border-radius: 999px;
  background: transparent;
  color: var(--surface-muted);
  font-size: 12px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.wx-btn:hover { border-color: var(--palette-accent); color: var(--surface-text); }
.wx-icon { font-size: 12px; color: var(--palette-accent); }
.wx-place { max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wx-temp { color: var(--surface-text); font-weight: 600; }
.wx-range { opacity: 0.7; }
/* 过期 / 出错：整块写灰，不假装是最新的 */
.weather-stale .wx-btn { opacity: 0.55; }
.wx-warn {
  display: inline-block;
  width: 12px; height: 12px; line-height: 12px; text-align: center;
  border-radius: 50%; background: var(--palette-accent); color: var(--palette-on); font-size: 9px;
}

.wx-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 40;
  width: 240px;
  padding: 10px 12px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  text-align: left;
  white-space: normal;
}
.wx-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 13px; }
.wx-line strong { color: var(--palette-primary); font-weight: 600; }
.wx-sub { margin: 4px 0 0; font-size: 11px; color: var(--surface-muted); line-height: 1.6; }
.wx-err { margin: 6px 0 0; font-size: 11px; color: var(--palette-accent); line-height: 1.6; }
.wx-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.wx-link {
  padding: 0; border: 0; background: transparent;
  color: var(--palette-primary); font-size: 11px; cursor: pointer;
}
.wx-link:hover { text-decoration: underline; }
.wx-link:disabled { color: var(--surface-muted); cursor: default; text-decoration: none; }
.wx-in {
  flex: 1; min-width: 0;
  padding: 3px 6px;
  font-size: 11px;
  border: 0.5px solid var(--surface-border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--surface-text);
  outline: none;
  box-sizing: border-box;
}
.wx-in:focus { border-color: var(--palette-accent); }
.wx-note { margin: 8px 0 0; font-size: 10px; color: var(--surface-muted); line-height: 1.5; opacity: 0.85; }
</style>
