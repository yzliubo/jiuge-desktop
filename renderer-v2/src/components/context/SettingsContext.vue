<script setup lang="ts">
// 「设置」的右栏：当前配置一眼看全（皮肤 / 模板 / 模块开关 / 头七天），
// 以及对外分发必须能说清的合规口径——纯本地、不联网、不收集。
import { computed, onMounted, ref } from 'vue';
import { callDomain } from '../../composables/useDomain';
import { SKINS, type SkinId, type ViewKey } from '../../types';
import { useTheme } from '../../composables/useTheme';

const emit = defineEmits<{ (e: 'navigate', key: ViewKey): void }>();

const { skin } = useTheme();
const template = ref('标准·九格');
const modules = ref<Record<string, boolean>>({ work: true, money: true, growth: true });
const firstWeek = ref(true);
const loading = ref(true);

const skinLabel = computed(function () {
  const hit = SKINS.filter(function (s) { return s.id === (skin.value as SkinId); })[0];
  return hit ? hit.label : skin.value;
});
const onCount = computed(function () {
  const m = modules.value;
  return ['work', 'money', 'growth'].filter(function (k) { return !!m[k]; }).length;
});

onMounted(async () => {
  try {
    const [t, m, f] = await Promise.all([
      callDomain<{ name?: string }>('activeTemplate', {}),
      callDomain<Record<string, boolean>>('modules', modules.value),
      callDomain<boolean>('firstWeekEnabled', true)
    ]);
    template.value = (t && t.name) || '标准·九格';
    modules.value = m || modules.value;
    firstWeek.value = !!f;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="ctx-card">
    <h2 class="ctx-title">当前配置</h2>
    <div class="ctx-list">
      <div class="ctx-item"><span class="ctx-item-main">皮肤</span><span class="ctx-item-side">{{ skinLabel }}</span></div>
      <div class="ctx-item"><span class="ctx-item-main">九格模板</span><span class="ctx-item-side">{{ template }}</span></div>
      <div class="ctx-item"><span class="ctx-item-main">模块开关</span><span class="ctx-item-side">{{ onCount }} / 3 开</span></div>
      <div class="ctx-item"><span class="ctx-item-main">头七天引导</span><span class="ctx-item-side">{{ firstWeek ? '已开启' : '已关闭' }}</span></div>
    </div>
    <p v-if="loading" class="ctx-muted">读取中…</p>
  </section>

  <section class="ctx-card">
    <h2 class="ctx-title">数据与合规</h2>
    <p class="ctx-muted">所有记录只写本机数据目录，程序不发起任何网络请求；不收集账号、不埋点。</p>
    <div class="ctx-links">
      <button class="ctx-link" @click="emit('navigate', 'data')">去数据中心</button>
      <button class="ctx-link" @click="emit('navigate', 'today')">回今日九格</button>
    </div>
  </section>
</template>
