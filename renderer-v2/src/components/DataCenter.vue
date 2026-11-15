<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { domainCall, saveExport, healthCheck, runBackup, listRestorable, restoreVersion,
  metricsSummary, setMetricsEnabled,
  type HealthReport, type RestorableVersion, type MetricsSummary } from '../bridge';
import { callDomainRaw } from '../composables/useDomain';
import { localDate } from '../types';

defineProps<{ total: number }>();
const emit = defineEmits<{ (e: 'open-bin'): void }>();

type ActionKey = 'import' | 'export' | 'backup' | 'migrate';
interface BackupRecord { time: string; name: string; path: string; bytes: number }
interface ImportReport { imported?: number; skipped?: number; emptyShell?: number; partial?: boolean; sourceVersion?: number; error?: string }

const actions: Array<{ key: ActionKey; label: string; desc: string }> = [
  { key: 'export', label: '导出备份', desc: 'JSON / 可读文本 / Markdown，另存为文件并给出完整路径回执' },
  { key: 'import', label: '导入备份', desc: 'v7 / ≥v6 / 无版本旧档 / 旧 store.json，只补写不覆盖' },
  { key: 'backup', label: '备份历史', desc: '每次导出留一条记录；破坏性操作前自动快照' },
  { key: 'migrate', label: '迁移向导', desc: '首次启动自动迁移旧版数据，六道安全网 + 一键回滚' }
];
const formats = [
  { key: 'json', label: 'JSON 备份', fn: 'exportBackup', ext: 'json' },
  { key: 'text', label: '可读文本', fn: 'exportText', ext: 'txt' },
  { key: 'md', label: 'Markdown', fn: 'exportMarkdown', ext: 'md' }
];

const selected = ref<ActionKey>('export');
const format = ref('json');
const receipt = ref('');
const clipboardNote = '仅复制文本，不是备份';
const paste = ref('');
const report = ref<ImportReport | null>(null);
const history = ref<BackupRecord[]>([]);
const message = ref('');

// ---- V1.3「一个文件」：路径可见 + 打包为 .jiuge + 只补不覆盖地还原 ----
// 不改内部存储结构（repository / journal / persistence 一个不动），只在外面加一层打包导出。
interface PackInfo { path: string; storePath: string; storeBytes: number; totalBytes: number; keyCount: number; fileCount: number }
interface PackResult { text: string; keyCount: number; keys: string[]; bytes: number }
const packInfo = ref<PackInfo | null>(null);
const packBusy = ref(false);

async function loadPackInfo(): Promise<void> {
  try { packInfo.value = await domainCall<PackInfo>('v13.archiveInfo'); }
  catch { packInfo.value = null; }
}
async function packNow(): Promise<void> {
  if (packBusy.value) return;
  packBusy.value = true;
  try {
    const p = await domainCall<PackResult>('v13.pack');
    const name = '九格-' + localDate() + '.jiuge';
    const r = await saveExport(name, p.text);
    if (r.canceled) { message.value = '已取消，未写入任何文件'; return; }
    const bytes = r.bytes ?? p.bytes;
    message.value = '已打包 ' + p.keyCount + ' 个数据键 · 只装数据，不含程序文件';
    receipt.value = (r.path || name) + ' · ' + bytes + ' 字节 · ' + new Date().toLocaleTimeString();
    await loadPackInfo();
  } catch (e) {
    message.value = '打包失败：' + ((e as Error).message || '未知错误');
  } finally {
    packBusy.value = false;
  }
}
function onPackFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function () {
    const text = String(reader.result || '');
    try {
      const v = await domainCall<{ ok: boolean; added: number; skipped: number; error: string }>('v13.unpack', text);
      message.value = v.ok
        ? '已还原 · 新增 ' + v.added + ' 个键 / 保留本机 ' + v.skipped + ' 个键（只补不覆盖）'
        : '还原失败：' + v.error;
      await loadPackInfo();
    } catch (e) {
      message.value = '还原失败：' + ((e as Error).message || '未知错误');
    }
  };
  reader.readAsText(file);
}

// ---- 数据健康中心 ----
// 数据层其实比多数同类软件更稳（WAL + 原子写 + .bak + 快照），
// 只是从来没告诉过用户。这里把已有状态翻译成人话，不需要新引擎。
const health = ref<HealthReport | null>(null);
const healthAt = ref('');
const backing = ref(false);

function timeOf(iso: string | number): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function kb(bytes: number): string {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function loadHealth(): Promise<void> {
  try {
    const r = await healthCheck();
    health.value = r;
    healthAt.value = new Date().toLocaleTimeString();
  } catch {
    health.value = null;
  }
}

async function backupNow(): Promise<void> {
  backing.value = true;
  try {
    const r = await runBackup();
    message.value = r && r.ok ? '已生成一份快照' : '备份失败：' + ((r && r.error) || '未知原因');
    await loadHealth();
  } finally {
    backing.value = false;
  }
}

onMounted(() => { void loadHealth(); void loadPackInfo(); void loadVersions(); void loadMetrics(); });

// ---- 本机使用指标（R-11）----
// 指标只写本机 metrics.log（独立于 store.json，结构上进不了备份），从不上传。
// 算不出来的指标写「尚无可判定样本」，绝不拿 0 冒充结论。
const metrics = ref<MetricsSummary | null>(null);
const metricsBusy = ref(false);

async function loadMetrics(): Promise<void> {
  try {
    metrics.value = await metricsSummary();
  } catch {
    metrics.value = null;
  }
}

async function toggleMetrics(): Promise<void> {
  if (!metrics.value) return;
  metricsBusy.value = true;
  try {
    await setMetricsEnabled(!metrics.value.enabled);
    await loadMetrics();
  } finally {
    metricsBusy.value = false;
  }
}

async function exportMetrics(): Promise<void> {
  if (!metrics.value) return;
  const name = '九格手记-使用指标-' + localDateStr() + '.json';
  const r = await saveExport(name, JSON.stringify(metrics.value, null, 2));
  message.value = r && r.path ? '已另存为 ' + r.path : '导出已取消';
}

function localDateStr(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function ratioText(v: number | null): string {
  return v === null ? '尚无可判定样本' : v + '%';
}
function retentionText(v: number | null): string {
  if (v === null) return '尚无可判定样本';
  return v ? '留存' : '未留存';
}
function msText(v: number | null): string {
  return v === null ? '暂无样本' : v + ' ms';
}

// ---- 可回滚版本（R-10 / 术语按 D8）----
// 「数据快照」是健康卡里的数量统计；这里是**可回滚版本**，能真的把数据退回去。
// 采用两次点击确认，不弹原生对话框：一是可被 GUI 断言覆盖，二是避免模态吞掉焦点。
const versions = ref<RestorableVersion[]>([]);
const versionsBusy = ref(false);
const pendingId = ref('');
const restoringId = ref('');

async function loadVersions(): Promise<void> {
  try {
    versions.value = await listRestorable();
  } catch {
    versions.value = [];
  }
}

function askRestore(v: RestorableVersion): void {
  pendingId.value = pendingId.value === v.id ? '' : v.id;
}

async function rollbackTo(v: RestorableVersion): Promise<void> {
  if (pendingId.value !== v.id) return;
  restoringId.value = v.id;
  pendingId.value = '';
  try {
    const r = await restoreVersion(v.id);
    if (r.ok) {
      const before = r.before ? r.before.diaries : -1;
      const after = r.after ? r.after.diaries : -1;
      message.value = '已回到 ' + timeOf(v.createdAt) + ' 的版本'
        + (before >= 0 && after >= 0 ? '（日记 ' + before + ' → ' + after + ' 篇）' : '')
        + '；回滚前的状态已留为一份安全版本，可再退回。';
    } else {
      message.value = '回滚未执行：' + (r.message || r.code || '未知原因');
    }
  } catch (e) {
    message.value = '回滚失败：' + String((e as Error)?.message || e);
  } finally {
    restoringId.value = '';
    versionsBusy.value = true;
    try {
      await loadVersions();
      await loadHealth();
    } finally {
      versionsBusy.value = false;
    }
  }
}

async function generate(): Promise<string> {
  const f = formats.find((x) => x.key === format.value) || formats[0];
  const raw = await domainCall<unknown>(f.fn);
  if (typeof raw === 'string') return raw;
  const o = raw as { data?: string; error?: string } | null;
  if (o && o.error) throw new Error(o.error);
  return (o && o.data) || '';
}

async function doExport(): Promise<void> {
  message.value = '';
  let text: string;
  try {
    text = await generate();
  } catch (e) {
    message.value = '导出失败：' + ((e as Error).message || '未知错误');
    return;
  }
  if (!text) { message.value = '还没有日记可导出'; return; }
  const f = formats.find((x) => x.key === format.value) || formats[0];
  const name = '九格手记-备份-' + localDate() + '.' + f.ext;
  let r;
  try {
    r = await saveExport(name, text);
  } catch (e) {
    message.value = '写入文件失败：' + ((e as Error).message || '未知错误');
    return;
  }
  if (r.canceled) { message.value = '已取消，未写入任何文件'; return; }
  receipt.value = (r.path || name) + ' · ' + (r.bytes ?? text.length) + ' 字节 · ' + new Date().toLocaleTimeString();
  history.value.unshift({ time: new Date().toLocaleString(), name, path: r.path || name, bytes: r.bytes ?? text.length });
  message.value = '已写出文件';
}

async function copyText(): Promise<void> {
  try {
    const text = await generate();
    await navigator.clipboard.writeText(text);
    message.value = clipboardNote + ' · 已复制到剪贴板';
  } catch {
    message.value = '剪贴板不可用，未谎称成功';
  }
}

async function doImport(): Promise<void> {
  const text = paste.value.trim();
  if (!text) { message.value = '请先选择备份文件或粘贴 JSON 文本'; return; }
  // importBackup 返回 {data:{imported,...}, error:null}；失败时 error 是 INVALID_JSON / INVALID_FORMAT
  const res = await callDomainRaw<ImportReport>('importBackup', text);
  if (res.error) {
    report.value = null;
    message.value = res.error === 'INVALID_JSON' ? '导入失败：不是合法 JSON'
      : res.error === 'INVALID_FORMAT' ? '导入失败：缺少 records 数组'
      : '导入失败：' + res.error;
    return;
  }
  const r = res.data || {};
  report.value = r;
  message.value = '导入完成 · 新增 ' + (r.imported ?? 0) + ' 篇 / 跳过 ' + (r.skipped ?? 0) + ' 篇'
    + (r.partial ? ' · 旧版备份（部分字段）' : '');
}

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    paste.value = String(reader.result || '');
    message.value = '已读取 ' + file.name + '，请确认后再导入';
  };
  reader.readAsText(file);
}
</script>

<template>
  <section class="dc" aria-label="数据中心">
    <header class="dc-head">
      <h1>数据中心</h1>
      <p>本机共 {{ total }} 篇。</p>
    </header>

    <!-- 数据健康：先给状态，再给操作。这些能力一直在，只是从前没告诉用户 -->
    <section class="health" aria-label="数据健康">
      <div class="health-head">
        <h2 class="health-title">数据健康</h2>
        <span v-if="healthAt" class="health-at">检查于 {{ healthAt }}</span>
        <span class="health-spacer"></span>
        <button class="hbtn" :disabled="backing" @click="backupNow">{{ backing ? '备份中…' : '立即备份' }}</button>
        <button class="hbtn" @click="emit('open-bin')">
          封存箱{{ health && health.data.sealed ? ' · ' + health.data.sealed : '' }}
        </button>
      </div>

      <div v-if="health" class="health-grid">
        <div class="h-cell" :class="health.boot.lastExitClean ? 'h-ok' : 'h-warn'">
          <span class="h-k">上次退出</span>
          <span class="h-v">{{ health.boot.lastExitClean ? '正常' : '异常 · 已回放 ' + health.boot.replayed + ' 条' }}</span>
        </div>
        <div class="h-cell">
          <span class="h-k">主文件</span>
          <span class="h-v">{{ health.store.count }} 篇 · {{ kb(health.store.bytes) }}</span>
        </div>
        <div class="h-cell">
          <span class="h-k">备份文件</span>
          <span class="h-v">
            <template v-if="health.bak.exists">
              {{ health.bak.count }} 篇<template v-if="health.bak.behind > 0"> · 落后 {{ health.bak.behind }}</template>
            </template>
            <template v-else>尚无</template>
          </span>
        </div>
        <div class="h-cell">
          <span class="h-k">快照</span>
          <span class="h-v">
            {{ health.snapshots.count }} 份<template v-if="health.snapshots.latest"> · 最近 {{ timeOf(health.snapshots.latest.createdAt) }}</template>
          </span>
        </div>
        <div class="h-cell">
          <span class="h-k">数据规模</span>
          <span class="h-v">{{ health.data.diaries }} 篇 · {{ health.data.capsules }} 胶囊 · 待办 {{ health.data.gtdOpen }}</span>
        </div>
        <div class="h-cell">
          <span class="h-k">自动备份</span>
          <span class="h-v">
            <template v-if="health.autoBackup.enabled">每 {{ health.autoBackup.intervalMinutes }} 分钟 · 留 {{ health.autoBackup.kept }} 份</template>
            <template v-else>未启用</template>
            <template v-if="health.autoBackup.lastAt"> · 上次 {{ timeOf(health.autoBackup.lastAt) }}</template>
          </span>
        </div>
      </div>
      <p v-else class="health-empty">正在读取本机数据状态…</p>

      <p class="health-note">
        「落后」指备份比主文件少几篇，属正常。
        <template v-if="health && health.data.sealed > 0">
          封存箱里有 {{ health.data.sealed }} 篇，最早还有 {{ health.data.sealedSoonest }} 天离开。
        </template>
      </p>
    </section>

    <!-- 可回滚版本（R-10）：不只告诉你「有几份快照」，而是能真的退回去 -->
    <section class="panel" aria-label="可回滚版本">
      <h2>可回滚版本</h2>
      <p class="clipboard-hint">
        这里是「可回滚版本」——能真的把数据退回到那一刻。与上面健康卡里的「快照 N 份」指同一批文件，
        但只有这里能执行回滚。回滚前会自动给当前状态留一份安全版本，退错了还能再退回来。
      </p>
      <p v-if="!versions.length" class="health-empty">还没有可回滚的版本。点上面的「立即备份」生成一份。</p>
      <ul v-else class="ver-list">
        <li v-for="v in versions" :key="v.id" class="ver-item" :data-ver-id="v.id">
          <span class="ver-when">{{ timeOf(v.createdAt) }}</span>
          <span class="ver-meta">
            {{ v.count >= 0 ? v.count + ' 篇' : '篇数未知' }} · {{ kb(v.bytes) }} · {{ v.auto ? '自动' : '手动' }}<template v-if="v.reason"> · {{ v.reason }}</template>
          </span>
          <span class="ver-spacer"></span>
          <button
            class="btn ver-btn"
            :class="{ 'ver-ask': pendingId === v.id }"
            :disabled="!!restoringId || versionsBusy"
            @click="pendingId === v.id ? rollbackTo(v) : askRestore(v)"
          >{{ restoringId === v.id ? '回滚中…' : pendingId === v.id ? '确认回到这一份？' : '回到这一份' }}</button>
        </li>
      </ul>
    </section>

    <!-- 本机使用指标（R-11）：只写本机、不写正文、从不上传；备份里结构性地不含它 -->
    <section class="panel" aria-label="本机使用指标">
      <h2>本机使用指标</h2>
      <p class="clipboard-hint">
        只记「哪一天写了、存一次花多久、有没有用检索」这类计数，不记任何正文，也从不上传。
        它落在独立文件里，不在备份中——导出备份永远带不走这些数字。
      </p>
      <p v-if="!metrics" class="health-empty">正在读取指标…</p>
      <template v-else>
        <div class="metric-grid">
          <div class="h-cell"><span class="h-k">周有效记录天数</span><span class="h-v">{{ metrics.metrics.weekActiveDays }} / 5 天</span></div>
          <div class="h-cell"><span class="h-k">次日留存</span><span class="h-v">{{ retentionText(metrics.metrics.nextDayRetention) }}</span></div>
          <div class="h-cell"><span class="h-k">第 4 周留存</span><span class="h-v">{{ retentionText(metrics.metrics.week4Retention) }}</span></div>
          <div class="h-cell"><span class="h-k">迁移完成率</span><span class="h-v">{{ ratioText(metrics.metrics.migrateRate) }}</span></div>
          <div class="h-cell"><span class="h-k">检索使用面</span><span class="h-v">{{ ratioText(metrics.metrics.searchUsageRate) }}</span></div>
          <div class="h-cell"><span class="h-k">保存耗时 P50 / P95</span><span class="h-v">{{ msText(metrics.metrics.saveLatencyP50) }} / {{ msText(metrics.metrics.saveLatencyP95) }}</span></div>
        </div>
        <!-- V3.8 成效侧：把「用得多不多」补上「有没有真的推动」。
             没有成效事件时明说没有，不拿一排 0 冒充「你什么都没做成」。 -->
        <div class="outcome-head">
          <span class="h-k">成效侧</span>
          <span class="muted">近 7 天 / 近 30 天 · 只记次数，不记任务名与复盘内容</span>
        </div>
        <div v-if="!metrics.outcome || !metrics.outcome.available" class="health-empty">
          还没有成效事件。完成一件任务、推一次目标进度、存一笔梦想金、写一次复盘，这里才开始计数。
        </div>
        <div v-else class="metric-grid">
          <div class="h-cell"><span class="h-k">完成任务</span><span class="h-v">{{ metrics.outcome.window7.taskDone }} / {{ metrics.outcome.window30.taskDone }} 件</span></div>
          <div class="h-cell"><span class="h-k">目标推进</span><span class="h-v">{{ metrics.outcome.window7.dreamMove }} / {{ metrics.outcome.window30.dreamMove }} 次</span></div>
          <div class="h-cell"><span class="h-k">阅读推进</span><span class="h-v">{{ metrics.outcome.window7.readMove }} / {{ metrics.outcome.window30.readMove }} 次</span></div>
          <div class="h-cell"><span class="h-k">复盘落成</span><span class="h-v">{{ metrics.outcome.window7.review }} / {{ metrics.outcome.window30.review }} 次</span></div>
        </div>
        <div class="row">
          <button class="btn" :disabled="metricsBusy" @click="toggleMetrics">{{ metrics.enabled ? '停用本机指标' : '启用本机指标' }}</button>
          <button class="btn" @click="exportMetrics">另存为文件</button>
          <span class="muted">样本 {{ metrics.sampleSize }} 条{{ metrics.enabled ? '' : ' · 当前已停用' }}</span>
        </div>
      </template>
    </section>

    <!-- V1.3「一个文件」：eDiary 27 年的信任状就是「你的记录是一个能拷走的文件」。
         九格不改内部存储，只把数据键打成一个可校验、可还原的 .jiuge 文本容器。 -->
    <section class="panel" aria-label="一个文件">
      <h2>你的全部记录是一个文件</h2>
      <p v-if="packInfo" class="clipboard-hint">
        1 个数据文件 + {{ packInfo.fileCount }} 个同目录文件，共 {{ kb(packInfo.totalBytes) }}，
        {{ packInfo.keyCount }} 个数据键，位于 <code>{{ packInfo.path }}</code>。底栏「打开数据目录」可直接打开。
      </p>
      <p v-else class="clipboard-hint">正在读取本机数据目录…</p>
      <div class="row">
        <button class="btn" :disabled="packBusy" @click="packNow">打包为单个文件</button>
        <input class="file" type="file" accept=".jiuge,application/json,text/plain" @change="onPackFile" />
        <span class="muted">选 .jiuge 还原 · 只补本机没有的键，不覆盖</span>
      </div>
      <p class="clipboard-hint">打包产物只装数据键，不含 app.asar / 程序文件 / 日志；超过 200 MB 请改用「导出备份」。</p>
    </section>

    <div class="action-grid" role="tablist" aria-label="数据操作">
      <button v-for="a in actions" :key="a.key" class="action-card"
        :class="{ 'action-on': selected === a.key }" :aria-selected="selected === a.key"
        role="tab" @click="selected = a.key">
        <strong>{{ a.label }}</strong><span>{{ a.desc }}</span>
      </button>
    </div>

    <div v-if="selected === 'export'" class="panel">
      <h2>导出为文件</h2>
      <div class="row">
        <button v-for="f in formats" :key="f.key" class="seg" :class="{ 'seg-on': format === f.key }"
          :aria-pressed="format === f.key" @click="format = f.key">{{ f.label }}</button>
        <button class="btn primary" :class="{ 'primary-on': format === 'json' }" @click="doExport">另存为文件</button>
        <button class="btn" @click="copyText">复制到剪贴板</button>
      </div>
      <p class="clipboard-hint">{{ clipboardNote }} · 只有「另存为文件」才生成看得见的备份</p>
      <p v-if="receipt" class="receipt" :class="{ 'receipt-on': !!receipt }">回执：{{ receipt }}</p>
    </div>

    <div v-else-if="selected === 'import'" class="panel">
      <h2>导入备份（可取消 · 失败自动回滚）</h2>
      <div class="row">
        <input class="file" type="file" accept=".json,.txt,application/json,text/plain" @change="onFile" />
        <span class="muted">支持 .json / .txt，或直接粘贴</span>
      </div>
      <textarea v-model="paste" class="text" rows="4" placeholder="粘贴备份 JSON 文本"></textarea>
      <div class="row">
        <button class="btn" :class="{ 'btn-on': !!paste.trim() }" @click="doImport">预览并导入</button>
        <button class="btn" @click="paste = ''; report = null; message = '已取消，零写入'">取消</button>
      </div>
      <p class="clipboard-hint">只补写本机没有的日期；本机有正文的日子绝不覆盖 · 兼容 v7 / ≥v6 / 无版本旧档</p>
      <div v-if="report && !report.error" class="report">
        <span class="stat">新增 {{ report.imported ?? 0 }}</span>
        <span class="stat">跳过 {{ report.skipped ?? 0 }}</span>
        <span class="stat">空壳 {{ report.emptyShell ?? 0 }}</span>
        <span class="stat">来源版本 {{ report.sourceVersion ?? '旧档' }}</span>
      </div>
    </div>

    <div v-else-if="selected === 'backup'" class="panel">
      <h2>备份历史</h2>
      <div v-for="(h, i) in history" :key="i" class="hist">
        <span class="stat">{{ h.time }}</span><span class="path">{{ h.path }}</span><span class="muted">{{ h.bytes }} B</span>
      </div>
      <p v-if="history.length === 0" class="empty">暂无备份记录，先到「导出备份」生成一份</p>
      <p class="clipboard-hint">数据快照 / .bak / 可回滚版本三者物理隔离于日记命名空间；回滚前会强制导出一份数据快照，不假装无损</p>
    </div>

    <div v-else class="panel">
      <h2>迁移向导</h2>
      <ol class="steps">
        <li>首次启动自动探测旧 <code>store.json</code></li>
        <li>冻结只读锚点 + 预检 9 固定键 + 未知键入 <code>raw_kv</code></li>
        <li>只读双跑逐键比对，全部一致才提交</li>
        <li>写 <code>manifest.json</code>，需要时可一键回滚</li>
      </ol>
      <p class="clipboard-hint">迁移失败即进入只读模式，绝不静默清空；回滚前必须导出 v7 备份</p>
    </div>

    <p v-if="message" class="message" :class="{ 'message-on': !!message }">{{ message }}</p>

    <div class="privacy">
      <strong>数据只在这台电脑</strong>
      <span>不联网 · 无账号 · 无遥测 · 卸载不删数据 · 便携版数据不随 U 盘走</span>
    </div>
  </section>
</template>

<style scoped>
.dc { display: flex; flex-direction: column; gap: var(--space-3); }
.dc-head h1 { font-size: var(--text-h2); font-weight: 500; margin: 0; }
.dc-head p { font-size: var(--text-sm); color: var(--surface-muted); margin: 4px 0 0; }

/* 数据健康卡 */
.health { padding: var(--space-3); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); }
.health-head { display: flex; align-items: center; gap: var(--space-2); }
.health-title { font-size: var(--text-body); font-weight: 500; margin: 0; }
.health-at { font-size: var(--text-xs); color: var(--surface-muted); }
.health-spacer { flex: 1; }
.hbtn { padding: 3px 10px; font-size: var(--text-sm); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); cursor: pointer; }
.hbtn:hover:not(:disabled) { border-color: var(--palette-border); background: var(--palette-soft); color: var(--palette-primary); }
.hbtn:disabled { opacity: 0.5; cursor: default; }
.health-grid, .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); margin-top: var(--space-2); }
.h-cell { display: flex; flex-direction: column; gap: 2px; padding: 7px 10px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-panel); min-width: 0; }
.h-k { font-size: var(--text-xs); color: var(--surface-muted); }
.h-v { font-size: var(--text-sm); font-variant-numeric: tabular-nums; line-height: 1.5; overflow: visible; white-space: normal; }
.h-ok { border-color: var(--palette-border); }
.h-warn { border-color: var(--state-warn); background: var(--state-warn-soft); }
.h-warn .h-v { color: var(--state-warn); }
.health-empty { font-size: var(--text-sm); color: var(--surface-muted); margin: var(--space-2) 0 0; }
.outcome-head { display: flex; align-items: baseline; gap: 8px; margin-top: var(--space-3); flex-wrap: wrap; }
.health-note { font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.65; margin: var(--space-2) 0 0; }
@media (max-width: 1180px) { .health-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
.action-card { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-raised); }
.action-card span { font-size: var(--text-sm); color: var(--surface-muted); }
.action-on { background: var(--palette-soft); border-color: var(--palette-border); color: var(--palette-primary); }
.panel { padding: var(--space-3); border: 0.5px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.panel h2 { font-size: var(--text-body); font-weight: 500; margin: 0 0 var(--space-2); }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: var(--space-2); }
.seg, .btn { padding: 6px 12px; border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.seg-on, .primary-on, .btn-on { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.text { width: 100%; padding: var(--space-2); border: 0.5px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; resize: vertical; }
.file { font-size: var(--text-sm); }
.clipboard-hint, .muted, .empty { font-size: var(--text-sm); color: var(--surface-muted); margin: var(--space-2) 0 0; }

/* 可回滚版本（R-10） */
.ver-list { list-style: none; margin: var(--space-2) 0 0; padding: 0; }
.ver-item {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 6px 8px; border-bottom: 1px solid var(--line);
  font-size: var(--text-sm);
}
.ver-item:last-child { border-bottom: 0; }
.ver-when { font-variant-numeric: tabular-nums; }
.ver-meta { color: var(--surface-muted); }
.ver-spacer { flex: 1; }
.ver-btn { font-size: var(--text-sm); padding: 2px 10px; white-space: nowrap; }
.ver-ask { background: var(--state-warn-soft); border-color: var(--state-warn); font-weight: 600; }
.receipt { font-size: var(--text-sm); padding: var(--space-2); border-radius: var(--radius-md); background: var(--surface-raised); margin-top: var(--space-2); word-break: break-all; }
.receipt-on { border: 0.5px solid var(--palette-border); color: var(--palette-primary); }
.report, .hist { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: var(--space-2); }
.stat { padding: 2px 8px; border-radius: 999px; background: var(--palette-soft); color: var(--palette-primary); font-size: var(--text-sm); }
.path { flex: 1; font-size: var(--text-sm); word-break: break-all; }
.steps { font-size: var(--text-sm); padding-left: 18px; margin: 0; }
.steps li { margin-bottom: 4px; }
.message { font-size: var(--text-sm); margin: 0; }
.message-on { color: var(--palette-primary); }
.privacy { display: flex; flex-direction: column; gap: 4px; padding: var(--space-2); border-radius: var(--radius-lg); background: var(--surface-panel); font-size: var(--text-sm); }
.privacy span { color: var(--surface-muted); }
</style>
