// 首页天气的**单一状态源**：首页天气条、设置页、底栏合规声明读的都是这一份。
//
// 为什么不放在 App.vue 里往下传 props：
//   天气条在问候头里、开关在设置页、合规声明在底栏，三处都不在同一个父组件下；
//   各自去 IPC 取一次会出现「设置里关了，首页还显示着」这种说不清的状态。
//
// 三条纪律：
//   · 关闭态零请求：enabled=false 时这里不会调用任何通道，连 weather.view 只读都不必；
//   · 失败不白屏：保留上一次的 report，只把 stale 标灰，并给出可读的错因；
//   · 不做「假刷新」：loading 只在真正发出请求时置位，缓存命中就直说「刚取过」。
import { computed, reactive } from 'vue';
import {
  weatherView, weatherSync, weatherSetEnabled, weatherSetMode,
  weatherClearCity, weatherSetCity, type WeatherReport
} from '../bridge';

const REFRESH_MS = 30 * 60 * 1000;

export interface WeatherState {
  ready: boolean;
  enabled: boolean;
  mode: 'auto' | 'city';
  city: string;
  unit: 'c' | 'f';
  report: WeatherReport | null;
  fetchedAt: number;
  stale: boolean;
  error: { at: number; code: string; msg: string } | null;
  loading: boolean;
}

const state = reactive<WeatherState>({
  ready: false,
  enabled: true,
  mode: 'auto',
  city: '',
  unit: 'c',
  report: null,
  fetchedAt: 0,
  stale: false,
  error: null,
  loading: false
});

let timer: ReturnType<typeof setInterval> | null = null;

// 定时器只服务于「开着」这一种状态：关掉就清掉，重新打开时再挂上。
// 不做「留着空转但里面判断开关」——空转的句柄会让「关了就是真关」这句话打折扣。
function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (state.enabled) void pull(false);
  }, REFRESH_MS);
}
function stopTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function apply(v: {
  enabled: boolean; mode: 'auto' | 'city'; city: string; unit: 'c' | 'f';
  report: WeatherReport | null; fetchedAt: number; stale: boolean;
  error: { at: number; code: string; msg: string } | null;
} | null | undefined): void {
  if (!v) return;
  state.enabled = !!v.enabled;
  state.mode = v.mode === 'city' ? 'city' : 'auto';
  state.city = v.city || '';
  state.unit = v.unit === 'f' ? 'f' : 'c';
  state.report = v.report || null;
  state.fetchedAt = Number(v.fetchedAt) || 0;
  state.stale = !!v.stale;
  state.error = v.error || null;
}

/** 当前该显示的地点名：优先用天气接口回来的城市（IP 定位时才知道是哪儿） */
const placeLabel = computed(() => {
  if (state.report && state.report.place && state.report.place.label) return state.report.place.label;
  if (state.city) return state.city;
  return '当前位置';
});

/** 温度显示：null 一律显示破折号，不要让界面出现 NaN° */
function deg(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(Number(v))) return '—';
  return Math.round(Number(v)) + '°';
}

async function pull(force: boolean): Promise<void> {
  if (!state.enabled) return;
  if (state.loading) return;
  state.loading = true;
  try {
    const r = await weatherSync(force);
    if (r && r.view) apply(r.view);
    if (r && r.ok) {
      state.error = null;
    } else {
      // 失败时不清 report：显示「上一次的温度 + 写灰 + 可读错因」比显示空白有用
      state.error = { at: Date.now(), code: (r && r.code) || 'WEATHER_ERROR', msg: (r && r.msg) || '取天气失败' };
    }
  } catch (e) {
    state.error = { at: Date.now(), code: 'WEATHER_ERROR', msg: (e as Error).message || '取天气失败' };
  } finally {
    state.loading = false;
  }
}

/** 首屏：先读偏好与上次缓存（只读、不联网），需要时才真正去取一次 */
async function init(force = false): Promise<void> {
  try {
    const v = await weatherView();
    apply(v);
  } catch {
    // 读不到偏好就按默认（开着、自动定位）走，首页不至于空着
  }
  state.ready = true;
  if (!state.enabled) { stopTimer(); return; }
  const stale = !state.report || force || (Date.now() - state.fetchedAt) > REFRESH_MS;
  if (stale) await pull(force);
  ensureTimer();
}

async function refresh(): Promise<void> {
  await pull(true);
}

async function setEnabled(on: boolean): Promise<void> {
  const v = await weatherSetEnabled(on);
  apply(v);
  if (on) {
    await pull(false);
    ensureTimer();
  } else {
    state.loading = false;
    stopTimer();
  }
}

async function setMode(mode: 'auto' | 'city'): Promise<void> {
  const v = await weatherSetMode(mode);
  apply(v);
  if (mode === 'city' && !state.city) return; // 还没填城市：等设置页检索成功再取
  await pull(false);
}

async function useCity(name: string): Promise<{ ok: boolean; msg?: string }> {
  const r = await weatherSetCity(name);
  if (r && r.view) apply(r.view);
  if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '找不到这个城市' };
  await pull(false);
  return { ok: true };
}

async function useAuto(): Promise<void> {
  const v = await weatherClearCity();
  apply(v);
  await pull(false);
}

export function useWeather() {
  return {
    state,
    placeLabel,
    deg,
    init,
    refresh,
    setEnabled,
    setMode,
    useCity,
    useAuto
  };
}
