<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../composables/useDomain';
import { useTheme } from '../composables/useTheme';
import { SKINS, localDate, type SkinId } from '../types';
import { worktimeSync, type WorktimeView } from '../bridge';
import { useWeather } from '../composables/useWeather';

const emit = defineEmits<{
  (e: 'goData'): void;
  (e: 'notify', text: string): void;
  // 开关本身不换页，但底栏那句声明必须立刻改口：这里往上报一次，由外壳重读 worktime.meta
  (e: 'wtChanged'): void;
}>();
const { skin, set } = useTheme();

const TEMPLATES = [
  { id: 'standard', name: '标准·九格' },
  { id: 'goal', name: '目标导向' },
  { id: 'emotion', name: '情绪觉察' },
  { id: 'simple', name: '极简' }
];
const MODULES = [
  { id: 'work', label: '工作看板', desc: '任务清单 + 当日感想' },
  { id: 'money', label: '记一笔收支', desc: '收入支出与分类明细' },
  { id: 'growth', label: '学习进展', desc: '在读书影画课与主题' }
];
// 界面减负：原先常驻的「写法 / 坚持」提示词清单已移除；设计口径统一收进下方折叠说明。
const PRESETS = ['7', '30', '90', '180', '365', '1000'];

const template = ref('standard');
const modules = ref<Record<string, boolean>>({ work: true, money: true, growth: true });
const firstWeek = ref(true);
const tipsOpen = ref(false);
const message = ref('');

// --- 工作模块 · 本机时间源（ActivityWatch 只读订阅）---
// 默认关：不开启时主进程一次请求都不发，界面也不渲染任何投入卡片。
const wt = ref<WorktimeView | null>(null);
const wtHost = ref('127.0.0.1:5600');
const wtToken = ref('');
const wtKeep = ref(180);
const wtMsg = ref('');
const wtApp = ref('');
const wtTitle = ref('');
const wtLabel = ref('');

async function loadWt(): Promise<void> {
  const v = await callDomain<WorktimeView | null>('worktime.dayForView', null, localDate());
  wt.value = v || null;
  if (v) {
    wtHost.value = v.host;
    wtKeep.value = v.keepDays;
  }
}

function wtSay(text: string): void { wtMsg.value = text; }

async function toggleWt(): Promise<void> {
  const on = !(wt.value && wt.value.enabled);
  await callDomain('worktime.enable', null, on);
  await loadWt();
  emit('wtChanged');
  wtSay(on ? '已开启：只读本机汇总，不采集、不上传' : '已关闭：不再发起任何本机请求，已有数据保留');
}

async function saveHost(): Promise<void> {
  await callDomain('worktime.setHost', null, wtHost.value);
  await loadWt();
  wtSay('地址已保存（只允许本机回环）');
}

async function saveToken(): Promise<void> {
  await callDomain('worktime.setToken', null, wtToken.value);
  wtToken.value = '';
  await loadWt();
  wtSay('API Key 已保存到本机');
}

async function saveKeep(): Promise<void> {
  await callDomain('worktime.setKeepDays', null, Number(wtKeep.value));
  await loadWt();
  wtSay('只保留最近 ' + Number(wtKeep.value) + ' 天');
}

async function addWtRule(): Promise<void> {
  const r = await callDomain<{ ok?: boolean } | null>('worktime.addRule', null, {
    app: wtApp.value, titleMatch: wtTitle.value, label: wtLabel.value
  });
  if (!r) { wtSay('规则没建成（应用名与标题关键词至少填一个）'); return; }
  wtApp.value = ''; wtTitle.value = ''; wtLabel.value = '';
  await loadWt();
  wtSay('规则已加，下次同步生效');
}

async function delWtRule(id: string): Promise<void> {
  await callDomain('worktime.removeRule', null, id);
  await loadWt();
  wtSay('规则已删（已归类过的历史天数不回溯）');
}

async function syncWt(): Promise<void> {
  const r = await worktimeSync(localDate());
  await loadWt();
  wtSay(r && r.ok ? '已同步今天' : ((r && r.msg) || '同步失败'));
}

async function clearWt(): Promise<void> {
  await callDomain('worktime.clearDays', null);
  await loadWt();
  wtSay('已清空本机投入数据（规则保留）');
}

// --- 首页天气：与首页天气条共用 useWeather 单例，改完立刻同步 ---
const wx = useWeather();
const wxCity = ref('');
const wxMsg = ref('');
const wxBusy = ref(false);
// 底栏与关于页都要按真实开关改口，所以从同一个状态源取
const wxOn = computed(() => wx.state.enabled);

async function toggleWx(): Promise<void> {
  wxBusy.value = true;
  await wx.setEnabled(!wx.state.enabled);
  wxBusy.value = false;
  wxMsg.value = wx.state.enabled ? '已开启：只在首页显示天气，不发送任何本机记录' : '已关闭：不再发起任何网络请求';
}

async function wxRefresh(): Promise<void> {
  wxBusy.value = true;
  await wx.refresh();
  wxBusy.value = false;
  const e = wx.state.error;
  wxMsg.value = e ? ('取失败：' + e.msg) : '已更新到最新一次观测';
}

async function wxAuto(): Promise<void> {
  wxBusy.value = true;
  await wx.useAuto();
  wxBusy.value = false;
  wxMsg.value = '已改为按出口 IP 自动定位（城市可能精确到地级市）';
}

async function wxUseCity(): Promise<void> {
  const q = wxCity.value.trim();
  if (!q) { wxMsg.value = '先填一个城市名'; return; }
  wxBusy.value = true;
  const r = await wx.useCity(q);
  wxBusy.value = false;
  wxMsg.value = r.ok ? ('已切到「' + q + '」') : (r.msg || '找不到这个城市');
  if (r.ok) wxCity.value = '';
}

async function changeTemplate(id: string): Promise<void> {
  await callDomain('setTemplate', null, id);
  template.value = id;
  emit('notify', '已切换模板：' + (TEMPLATES.find((t) => t.id === id)?.name || id));
}

async function toggleModule(id: string): Promise<void> {
  const on = !modules.value[id];
  await callDomain('setModule', null, id, on);
  modules.value[id] = on;
  emit('notify', (MODULES.find((m) => m.id === id)?.label || id) + (on ? ' 已开启' : ' 已关闭，数据仍保留'));
}

async function toggleFirstWeek(): Promise<void> {
  firstWeek.value = !firstWeek.value;
  await callDomain('setFirstWeekEnabled', null, firstWeek.value);
  emit('notify', firstWeek.value ? '头七天引导已开启' : '头七天引导已关闭');
}

async function changeSkin(id: SkinId): Promise<void> {
  await set(id);
  emit('notify', '皮肤已切换');
}

onMounted(async () => {
  const [t, m, f] = await Promise.all([
    callDomain<{ id?: string }>('activeTemplate', {}),
    callDomain<Record<string, boolean>>('modules', modules.value),
    callDomain<boolean>('firstWeekEnabled', true)
  ]);
  template.value = (t && t.id) || 'standard';
  modules.value = m || { work: true, money: true, growth: true };
  firstWeek.value = !!f;
  message.value = '里程碑周期预设：' + PRESETS.join(' / ');
  void loadWt();
});
</script>

<template>
  <section class="settings">
    <header class="head"><h1>设置</h1><p>改完即生效</p></header>

    <div class="card"><h2>1 · 界面皮肤</h2>
      <div class="skins" role="radiogroup">
        <button v-for="s in SKINS" :key="s.id" class="skin" :class="{ 'skin-on': skin === s.id }"
          :aria-checked="skin === s.id" role="radio" @click="changeSkin(s.id)">{{ s.label }}</button>
      </div>
    </div>

    <div class="card"><h2>2 · 页面模板</h2>
      <div class="row">
        <button v-for="t in TEMPLATES" :key="t.id" class="seg" :class="{ 'seg-on': template === t.id }"
          :aria-pressed="template === t.id" @click="changeTemplate(t.id)">{{ t.name }}</button>
      </div>
    </div>

    <div class="card"><h2>3 · 功能模块开关</h2>
      <div v-for="m in MODULES" :key="m.id" class="switch-row">
        <div><strong>{{ m.label }}</strong><span class="desc">{{ m.desc }}</span></div>
        <button class="switch" :class="{ 'switch-on': modules[m.id] }" :aria-checked="!!modules[m.id]"
          role="switch" @click="toggleModule(m.id)">{{ modules[m.id] ? '开' : '关' }}</button>
      </div>
    </div>

    <div class="card"><h2>4 · 头七天引导</h2>
      <div class="switch-row">
        <div><strong>前七天用轻松提问</strong></div>
        <button class="switch" :class="{ 'switch-on': firstWeek }" :aria-checked="firstWeek"
          role="switch" @click="toggleFirstWeek">{{ firstWeek ? '开' : '关' }}</button>
      </div>
      <p class="muted">{{ message }}</p>
    </div>

    <div class="card"><h2>5 · 数据管理</h2>
      <p class="line">建议定期另存一份备份。</p>
      <div class="row">
        <button class="btn" @click="emit('goData')">打开数据中心</button>
        <span class="muted">数据操作统一在数据中心</span>
      </div>
    </div>


    <div class="card"><h2>6 · 工作模块 · 本机时间源</h2>
      <div class="switch-row">
        <div>
          <strong>接入本机 ActivityWatch</strong>
          <span class="desc">只读汇总（应用名 + 分钟数），默认关闭</span>
        </div>
        <button class="switch" :class="{ 'switch-on': !!(wt && wt.enabled) }" :aria-checked="!!(wt && wt.enabled)"
          role="switch" @click="toggleWt">{{ wt && wt.enabled ? '开' : '关' }}</button>
      </div>

      <p class="line">
        九格自己不采集任何东西。开启后只从本机 ActivityWatch 读取汇总后的时间；窗口标题只用于归类匹配，
        用完即丢，不写进日记、不进备份、不上传。ActivityWatch 默认对本机所有程序开放读取——是否安装、
        记录哪些、保留多久，请在它自己的设置里决定。
      </p>

      <template v-if="wt && wt.enabled">
        <div class="row">
          <label class="muted" for="wt-host">本机地址</label>
          <input id="wt-host" v-model="wtHost" class="set-in" maxlength="32" aria-label="本机地址" />
          <button id="wt-host-save" class="btn" @click="saveHost">保存</button>
          <button id="wt-sync" class="btn" @click="syncWt">同步今天</button>
        </div>
        <div class="row">
          <label class="muted" for="wt-token">API Key（可选）</label>
          <input id="wt-token" v-model="wtToken" class="set-in" maxlength="120" aria-label="API Key" placeholder="rust 版开了鉴权才需要" />
          <button class="btn" @click="saveToken">保存</button>
          <label class="muted" for="wt-keep">保留</label>
          <select id="wt-keep" v-model.number="wtKeep" class="set-in" @change="saveKeep">
            <option :value="180">180 天</option>
            <option :value="400">400 天</option>
          </select>
        </div>

        <p class="line"><strong>归类规则</strong>：先按标题关键词，再按应用名；都没命中就算「未归类」。</p>
        <div v-for="r in (wt.rules || [])" :key="r.id" class="wt-rule">
          <span class="wt-rule-l">{{ r.label }}</span>
          <span class="wt-rule-m">{{ r.titleMatch ? '标题 ~ ' + r.titleMatch : r.app }}</span>
          <button class="link" @click="delWtRule(r.id)">删除</button>
        </div>
        <div class="row">
          <input v-model="wtApp" class="set-in" maxlength="40" aria-label="应用名" placeholder="应用名，如 code" />
          <input v-model="wtTitle" class="set-in" maxlength="120" aria-label="标题关键词" placeholder="标题关键词（可选，正则）" />
          <input v-model="wtLabel" class="set-in" maxlength="20" aria-label="归类名" placeholder="归类名，如 编程" />
          <button class="btn" @click="addWtRule">加规则</button>
        </div>

        <div class="row">
          <button class="btn" @click="clearWt">清空本机投入数据</button>
          <span class="muted">规则保留；清的是这台电脑上的聚合副本</span>
        </div>
      </template>
      <p v-if="wtMsg" class="muted">{{ wtMsg }}</p>
    </div>

    <div class="card"><h2>7 · 首页天气与位置</h2>
      <div class="switch-row">
        <div>
          <strong>在首页显示当地天气</strong>
          <span class="desc">默认开启；关闭后不再发起任何网络请求</span>
        </div>
        <button class="switch" :class="{ 'switch-on': wxOn }" :aria-checked="wxOn"
          role="switch" @click="toggleWx">{{ wxOn ? '开' : '关' }}</button>
      </div>

      <p class="line">
        只取「此刻的窗外」：地点、温度、今日高低温、降水概率。请求只发往气象服务与 IP 归属地服务，
        <strong>不发送日记、窗口标题、机器名或任何本机内容</strong>；没有账号、没有 Key、没有遥测。
        九格里手填的「天气」档位是另一件事，不会被自动值覆盖。
      </p>

      <template v-if="wxOn">
        <p class="line">
          定位方式：<strong>{{ wx.state.mode === 'city' ? '手填城市' : '按出口 IP 自动定位' }}</strong>
          <span v-if="wx.state.report" class="muted">
            · 当前 {{ wx.state.report.place.label }}
            <span v-if="wx.state.report.now">· {{ wx.state.report.now.text }} {{ wx.deg(wx.state.report.now.temp) }}</span>
          </span>
        </p>
        <div class="row">
          <button class="btn" :disabled="wxBusy" @click="wxRefresh">立即刷新</button>
          <button class="btn" :disabled="wxBusy" @click="wxAuto">按网络定位</button>
        </div>
        <div class="row">
          <input v-model="wxCity" class="set-in" maxlength="24" placeholder="手填城市，如 苏州" aria-label="手填城市" @keydown.enter.prevent="wxUseCity" />
          <button class="btn" :disabled="wxBusy" @click="wxUseCity">设为这个城市</button>
          <span class="muted">IP 定位只到城市，园区 / 新区这类会按主城区算</span>
        </div>
        <p v-if="wxMsg" class="muted">{{ wxMsg }}</p>
        <p v-if="wx.state.error" class="muted">上次失败：{{ wx.state.error.msg }}（会保留上一次的温度并标灰，不假装是最新的）</p>
      </template>
      <p v-else class="muted">关闭态：首页连天气占位都不渲染，主进程一次请求都不发。</p>
    </div>

    <div class="card"><h2>8 · 关于</h2>
      <p class="line">日记不上传 · 无账号 · 无遥测 · 不联互联网（除你开启的天气）</p>
      <p class="line" v-if="wxOn">首页天气已开启：只向气象服务取当前天气，发送的只有出口 IP，不发送任何本机记录。</p>
      <p class="line" v-if="wt && wt.enabled">本机时间源已开启：只读 127.0.0.1:5600，不出本机。</p>
      <p class="line" v-if="!(wxOn || (wt && wt.enabled))">不发起任何网络请求（含本机回环）。</p>
      <p class="line">数据只存在这台电脑；卸载不会删数据；便携版数据不随 U 盘走。</p>
    </div>

    <!-- 界面减负：原先散落在各模块常驻显示的设计口径与免责说明，统一收进这个默认收起的入口 -->
    <details class="card" style="cursor: pointer;">
      <summary style="font-size: 13px;">功能说明与边界</summary>
      <p class="line"><strong>数据与备份</strong>：全部记录只存本机；导入只补不改；迁移失败进入只读模式，回滚前强制导出一份备份。</p>
      <p class="line"><strong>搜索与内链</strong>：<code>A | B</code> 为「或」匹配；拼音首字母表是启发式近似，表外字可能不准。正文 <code>[[ ]]</code> 只是 Markdown 写法，零新键、不新增数据字段。</p>
      <p class="line"><strong>关系温度</strong>：100×(1−e^(−S/6))，S = Σ(渠道权重 × 深度系数 × 0.5^(天数/90))。只用来排序「谁最久没被想起」，不算总分、不做健康度评分，也不做「他给过我什么」的对称账；权重与 90 天半衰期是启发式，不是心理学常数；邓巴数只提示、不设闸门。</p>
      <p class="line"><strong>重复任务与耗时</strong>：完成后派生下一条而非原地重置；同标题同情境已有未完成实例时不重复派生。不做计时器，只做事后填分钟。</p>
      <p class="line"><strong>节气复盘</strong>：只做时间刻度与文意象，不做养生 / 宜忌 / 运势；节气为公历近似，误差可达 ±1 天。</p>
      <p class="line"><strong>弱引用</strong>：目标被删后保留灰色残留并标记「目标已不在」，不自动清除，自动清除等于悄悄改历史。</p>
      <p class="line"><strong>单条加密</strong>：AES-256-GCM。忘记口令即不可恢复，且无任何后门；口令不保存、不写进密文，密文只留在内存、不写入任何文件。</p>
      <p class="line"><strong>链接型附件</strong>：只存路径不拷贝文件；文件被移走或改名后会失效，失效只标灰不删除。</p>
    </details>
  </section>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: var(--space-2); }
.head h1 { font-size: 15px; font-weight: 500; margin: 0; }
.head p, .muted, .desc { font-size: 12px; color: var(--surface-muted); }
.card { padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.card h2 { font-size: 13px; font-weight: 500; margin: 0 0 8px; }
.skins { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.skin { padding: 8px 4px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); font-size: 12px; }
.skin-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.seg, .btn { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.seg-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 0.5px solid var(--surface-border); }
.switch-row:last-of-type { border-bottom: 0; }
.switch-row div { display: flex; flex-direction: column; }
.switch { padding: 4px 14px; border: 0.5px solid var(--surface-border); border-radius: 999px; background: var(--surface-raised); font-size: 12px; }
.switch-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.line { font-size: 12px; margin: 4px 0; }
.set-in {
  padding: 4px 8px; font-size: 12px; max-width: 180px;
  border: 0.5px solid var(--surface-border); border-radius: var(--radius-sm);
  background: var(--surface-raised); outline: none; box-sizing: border-box;
}
.set-in:focus { border-color: var(--palette-accent); }
.wt-rule {
  display: flex; align-items: baseline; gap: 8px; font-size: 12px;
  padding: 3px 0; border-bottom: 0.5px dashed var(--surface-border);
}
.wt-rule-l { color: var(--palette-primary); }
.wt-rule-m { flex: 1; min-width: 0; color: var(--surface-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link { border: 0; background: transparent; color: var(--palette-primary); font-size: 12px; }
.tips { margin-top: var(--space-2); }
</style>
