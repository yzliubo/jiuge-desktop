<script setup lang="ts">
// 自由记录 · 三合一：① 胶囊收录（只读派生）② 闪念快记（同步收件箱）③ 长文撰写（写作法体检）。
// 胶囊原文权威源仍是冻结的 diary-store，这里绝不复制第二份；长文正文存 md_freewrite，
// 不塞进 cells.free（当日日记 2000 字上限 + 每次保存整篇 record 全量写）。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { callDomain, callDomainRaw } from '../composables/useDomain';
import { useWritingCheck } from '../composables/useWritingCheck';
import type { WHit, WSentence } from '../composables/useWritingCheck';
import { localDate } from '../types';

type TabKey = 'capsule' | 'flash' | 'long';
interface FlashRow {
  id: string; text: string; date: string; createdAt: number;
  source: string; sync: string; taskId: string;
}
interface DocRow { id: string; title: string; body: string; createdAt: number; updatedAt: number }
interface Prefs { lastTab: string; method: string; checkOn: boolean }
interface FreeBoard { flashes: FlashRow[]; docs: DocRow[]; prefs: Prefs }
interface CapsuleRow {
  id: string; openAt: string; writtenAt: string; opened: boolean;
  due: boolean; sealed: boolean; text: string; preview: string;
}
interface FeedRow { key: string; kind: string; at: string; tag: string; tagClass: string; text: string; meta: string; dim: boolean }

const emit = defineEmits<{ (e: 'notify', text: string): void }>();

const EMPTY_BOARD: FreeBoard = {
  flashes: [], docs: [], prefs: { lastTab: 'capsule', method: 'hemingway', checkOn: false }
};

// 写作法体检改成「中栏写、右栏看」：结果与开关都由 useWritingCheck 共享给右栏那张卡，
// 中栏不再重复渲染一份统计（同一份数据两处显示，迟早对不上）。
const {
  checkOn, result,
  noteBody, runNow, setActive, hydrate, toggle, loadCards
} = useWritingCheck();

const tab = ref<TabKey>('capsule');
const board = ref<FreeBoard>(EMPTY_BOARD);
const capsules = ref<CapsuleRow[]>([]);
const flashText = ref('');
const flashBusy = ref(false);
const docSel = ref('');
const draftTitle = ref('');
const draftBody = ref('');

function notify(t: string): void { emit('notify', t); }

function fmtDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = function (n: number) { return n < 10 ? '0' + n : String(n); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function loadBoard(): Promise<void> {
  const b = await callDomain<FreeBoard>('free.board', EMPTY_BOARD);
  board.value = {
    flashes: Array.isArray(b && b.flashes) ? b.flashes : [],
    docs: Array.isArray(b && b.docs) ? b.docs : [],
    prefs: (b && b.prefs) || EMPTY_BOARD.prefs
  };
}

async function loadCapsules(): Promise<void> {
  const list = await callDomain<CapsuleRow[]>('free.capsuleIndex', []);
  capsules.value = Array.isArray(list) ? list : [];
}

onMounted(async function () {
  await loadBoard();
  await loadCapsules();
  await loadCards();
  // 打开模块时把上次没同步成功的闪念补一次（按 source 幂等，不会产生第二条任务）
  await callDomain('free.flashSyncPending', { total: 0, synced: 0 });
  const saved = board.value.prefs.lastTab;
  if (saved === 'flash' || saved === 'long') tab.value = saved;
  hydrate(!!board.value.prefs.checkOn);
  setActive(tab.value === 'long');
  if (board.value.docs.length) selectDoc(board.value.docs[0]);
  if (checkOn.value) runNow();
  else noteBody(draftBody.value);
});

// 离开模块时把右栏那张卡收起来，别让「写作法」跟着去别的页
onUnmounted(function () { setActive(false); });

function switchTab(k: TabKey): void {
  tab.value = k;
  setActive(k === 'long');
  void callDomain('free.prefs', EMPTY_BOARD.prefs, { lastTab: k });
}

// ---- ① 胶囊收录：同一时间轴混排，胶囊未到期只给元信息 ----
const feed = computed<FeedRow[]>(function () {
  const rows: FeedRow[] = [];
  capsules.value.forEach(function (c) {
    rows.push({
      key: 'c-' + c.id, kind: '胶囊', at: c.writtenAt || c.openAt,
      tag: c.sealed ? '封存中' : (c.opened ? '已开启' : '今日到期'),
      tagClass: c.sealed ? 'fw-tag-amber' : '',
      text: c.sealed ? '内容封存中，到期才能读' : (c.text || ''),
      meta: '开启日 ' + c.openAt + ' · 源 diary-store（只读派生）',
      dim: c.sealed
    });
  });
  board.value.flashes.forEach(function (f) {
    // 「只留原文」的条目（速记 / 九格格内快记 / 任务转发，source 以 nt: 开头）
    // 本来就不进收件箱，不能标成「已同步」——那是另一条通路的说法。
    const quiet = String(f.source || '').indexOf('nt:') === 0;
    rows.push({
      key: 'f-' + f.id, kind: '闪念', at: f.date || fmtDate(f.createdAt),
      tag: quiet ? '仅留原文' : (f.sync === 'ok' ? '已同步收件箱' : '待重试'),
      tagClass: quiet ? 'fw-tag-gray' : (f.sync === 'ok' ? 'fw-tag-blue' : 'fw-tag-amber'),
      text: f.text, meta: '原文保留在自由记录 · ' + f.source, dim: false
    });
  });
  board.value.docs.forEach(function (d) {
    rows.push({
      key: 'd-' + d.id, kind: '长文', at: fmtDate(d.updatedAt || d.createdAt),
      tag: '草稿', tagClass: 'fw-tag-gray',
      text: d.title + '（' + (d.body || '').length + ' 字）',
      meta: 'md_freewrite · 写作法：海明威', dim: false
    });
  });
  return rows.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
});

// ---- ② 闪念快记：原文 + 收件箱同源双写，同步由主进程按 source 幂等完成 ----
async function submitFlash(): Promise<void> {
  const text = flashText.value.trim();
  if (!text || flashBusy.value) return;
  flashBusy.value = true;
  try {
    const res = await callDomainRaw<{ item: FlashRow | null; synced: boolean }>(
      'free.flashAdd', text, localDate()
    );
    if (!res.data || !res.data.item) { notify('没存成，文本已保留，请重试'); return; }
    flashText.value = '';
    await loadBoard();
    notify(res.data.synced ? '已记下，并同步 1 条到收件箱' : '原文已保存，收件箱同步待重试');
  } finally {
    flashBusy.value = false;
  }
}

async function retryFlash(f: FlashRow): Promise<void> {
  const res = await callDomainRaw<{ item: FlashRow | null; synced: boolean }>('free.flashRetry', f.id);
  await loadBoard();
  notify(res.data && res.data.synced ? '已补同步（按 source 去重）' : '仍没同步成功，可稍后重试');
}

async function removeFlash(f: FlashRow): Promise<void> {
  await callDomain('free.flashRemove', EMPTY_BOARD, f.id);
  await loadBoard();
  notify('闪念与对应的未完成收件箱任务已删除');
}

// ---- ③ 长文撰写 ----
function selectDoc(d: DocRow): void {
  docSel.value = d.id;
  draftTitle.value = d.title;
  draftBody.value = d.body;
  noteBody(d.body);
}

async function newDoc(): Promise<void> {
  const b = await callDomain<FreeBoard>('free.docAdd', EMPTY_BOARD, { title: '未命名长文', body: '' });
  board.value = b && Array.isArray(b.docs) ? b : await callDomain<FreeBoard>('free.board', EMPTY_BOARD);
  if (board.value.docs.length) selectDoc(board.value.docs[0]);
  notify('新建长文，正文存 md_freewrite');
}

async function saveDoc(): Promise<void> {
  if (!docSel.value) { notify('先新建或选中一篇长文'); return; }
  const b = await callDomain<FreeBoard>('free.docUpdate', EMPTY_BOARD, docSel.value, {
    title: draftTitle.value, body: draftBody.value
  });
  board.value = b && Array.isArray(b.docs) ? b : board.value;
  notify('长文已保存');
}

async function removeDoc(): Promise<void> {
  if (!docSel.value) return;
  const b = await callDomain<FreeBoard>('free.docRemove', EMPTY_BOARD, docSel.value);
  board.value = b && Array.isArray(b.docs) ? b : EMPTY_BOARD;
  docSel.value = '';
  draftTitle.value = '';
  draftBody.value = '';
  if (board.value.docs.length) selectDoc(board.value.docs[0]);
  notify('长文已删除');
}

// ---- 写作法体检：只提示，不代写；本页只负责「写 + 标色」，统计卡在右栏 ----
watch(draftBody, function (v) { noteBody(v); });

function segments(s: WSentence): Array<{ text: string; type: string }> {
  const out: Array<{ text: string; type: string }> = [];
  const hits = Array.isArray(s.hits) ? s.hits as WHit[] : [];
  let at = 0;
  hits.forEach(function (h) {
    if (h.start > at) out.push({ text: s.text.slice(at, h.start), type: '' });
    out.push({ text: s.text.slice(h.start, h.end), type: h.type });
    at = h.end;
  });
  if (at < s.text.length) out.push({ text: s.text.slice(at), type: '' });
  return out;
}

function sentClass(s: WSentence): string {
  return s.level === 'hard' ? 'fw-hard' : (s.level === 'soft' ? 'fw-soft' : '');
}
</script>

<template>
  <section class="free-view">
    <header class="fw-head">
      <h2>自由记录 · 三合一</h2>
      <p>胶囊、闪念、长文汇到一条时间轴。这里是自由记录的唯一写入口，九格第 9 格只显示当天的闪念与长文摘要。胶囊原文只在 diary-store 一份，这里只读派生。</p>
    </header>

    <div class="fw-tabs" role="tablist" aria-label="自由记录三种功能">
      <button class="fw-tab" :class="{ 'fw-on': tab === 'capsule' }" role="tab"
        :aria-selected="tab === 'capsule'" @click="switchTab('capsule')">① 胶囊收录</button>
      <button class="fw-tab" :class="{ 'fw-on': tab === 'flash' }" role="tab"
        :aria-selected="tab === 'flash'" @click="switchTab('flash')">② 闪念快记</button>
      <button class="fw-tab" :class="{ 'fw-on': tab === 'long' }" role="tab"
        :aria-selected="tab === 'long'" @click="switchTab('long')">③ 长文撰写</button>
    </div>

    <!-- ① 胶囊收录 -->
    <section v-if="tab === 'capsule'" class="fw-pane">
      <div class="fw-card">
        <h3>信息收录 · 时间轴</h3>
        <div class="fw-counts">
          <span class="fw-chip">胶囊 {{ capsules.length }}</span>
          <span class="fw-chip fw-tag-blue">闪念 {{ board.flashes.length }}</span>
          <span class="fw-chip fw-tag-gray">长文 {{ board.docs.length }}</span>
        </div>
        <div class="fw-feed">
          <div v-for="r in feed" :key="r.key" class="fw-feed-item" :class="{ 'fw-sealed': r.dim }">
            <div class="fw-dot"></div>
            <div class="fw-feed-body">
              <div class="fw-meta">
                <span class="fw-chip" :class="r.tagClass">{{ r.tag }}</span>
                <span>{{ r.kind }}</span><span>{{ r.at }}</span>
              </div>
              <p :class="{ 'fw-dim': r.dim }">{{ r.text }}</p>
              <span class="fw-note">{{ r.meta }}</span>
            </div>
          </div>
          <p v-if="!feed.length" class="fw-note">还没有内容。写封胶囊、记一句闪念，或开一篇长文。</p>
        </div>
      </div>
      <div class="fw-card">
        <h3>记录说明</h3>
        <p class="fw-note">未到期的胶囊只显示标题与日期，正文和预览不会从后台送出；已开启的可在此读全文。「写新 / 开启」统一走顶栏弹窗，入口唯一。</p>
      </div>
    </section>

    <!-- ② 闪念快记 -->
    <section v-else-if="tab === 'flash'" class="fw-pane">
      <div class="fw-card">
        <h3>闪念快记 · 先捕捉，不判断</h3>
        <div class="fw-capture">
          <input v-model="flashText" type="text" maxlength="500" aria-label="闪念正文"
            placeholder="想到什么就写一句，回车即存" @keydown.enter.prevent="submitFlash" />
          <button class="fw-btn fw-primary" :disabled="flashBusy" @click="submitFlash">记下</button>
        </div>
        <div class="fw-sync">→ 每条闪念在自由记录留原文，并按 source 幂等生成一条收件箱任务；同步失败保留文本，可重试。</div>
        <div v-for="f in board.flashes" :key="f.id" class="fw-flash">
          <span class="fw-flash-dot"></span>
          <div class="fw-flash-body">
            <p>{{ f.text }}</p>
            <span class="fw-note">{{ f.date }} · {{ f.source }}</span>
          </div>
          <span class="fw-chip" :class="f.source.indexOf('nt:') === 0 ? 'fw-tag-gray' : (f.sync === 'ok' ? 'fw-tag-blue' : 'fw-tag-amber')">
            {{ f.source.indexOf('nt:') === 0 ? '仅留原文' : (f.sync === 'ok' ? '已同步' : '待重试') }}
          </span>
          <button v-if="f.sync !== 'ok' && f.source.indexOf('nt:') !== 0" class="fw-btn fw-mini" @click="retryFlash(f)">重试</button>
          <button class="fw-btn fw-mini" @click="removeFlash(f)">删除</button>
        </div>
        <p v-if="!board.flashes.length" class="fw-note">还没有闪念。先记一句试试。</p>
      </div>
    </section>

    <!-- ③ 长文撰写 -->
    <section v-else class="fw-pane">
      <div class="fw-writing">
        <div class="fw-doclist">
          <button class="fw-btn fw-primary" @click="newDoc">＋ 新建长文</button>
          <button v-for="d in board.docs" :key="d.id" class="fw-doc"
            :class="{ 'fw-doc-on': docSel === d.id }" :aria-pressed="docSel === d.id"
            @click="selectDoc(d)">
            {{ d.title }}<span>{{ (d.body || '').length }} 字 · {{ fmtDate(d.updatedAt) }}</span>
          </button>
          <p class="fw-note">正文存 md_freewrite，上限 2 万字，不进当日日记格。</p>
        </div>
        <div class="fw-editor">
          <div class="fw-ebar">
            <input v-model="draftTitle" class="fw-title" type="text" maxlength="60" aria-label="长文标题" placeholder="标题" />
            <button class="fw-btn fw-mini" :class="{ 'fw-on-btn': checkOn }" :aria-pressed="checkOn" @click="toggle">
              {{ checkOn ? '体检' : '写作' }}
            </button>
            <button class="fw-btn fw-mini" @click="saveDoc">保存</button>
            <button class="fw-btn fw-mini" @click="removeDoc">删除</button>
          </div>
          <textarea v-if="!checkOn" v-model="draftBody" class="fw-paper" maxlength="20000"
            aria-label="长文正文" placeholder="写长一点。写作态不打扰，点「体检」才逐句标色。"></textarea>
          <div v-else class="fw-review" aria-label="写作法体检结果">
            <span v-for="(s, i) in result.sentences" :key="i" :class="sentClass(s)">
              <template v-for="(seg, j) in segments(s)" :key="j">
                <mark v-if="seg.type" :class="'fw-' + seg.type">{{ seg.text }}</mark>
                <template v-else>{{ seg.text }}</template>
              </template>
            </span>
            <span v-if="!result.sentences.length" class="fw-note">还没有正文</span>
          </div>
        </div>
      </div>
      <p class="fw-note fw-rail-hint">写作法的三格统计与技巧卡在右栏「写作法 · 海明威」——中栏只管写，右栏只管看。</p>
    </section>
  </section>
</template>

<style scoped>
.free-view { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.fw-head h2 { margin: 0; font-size: var(--text-h2); font-weight: 600; }
.fw-head p { margin: 4px 0 0; font-size: var(--text-sm); color: var(--surface-muted); line-height: 1.7; }
.fw-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--surface-border); }
.fw-tab { font-size: var(--text-body); padding: 8px 15px; border: 0; background: transparent; color: var(--surface-muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.fw-tab.fw-on { color: var(--palette-primary); font-weight: 600; border-bottom-color: var(--palette-primary); }
.fw-pane { display: flex; flex-direction: column; gap: var(--space-2); }
.fw-card { padding: var(--space-2); border: 1px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); }
.fw-card h3 { margin: 0 0 10px; font-size: var(--text-body); font-weight: 600; }
.fw-note { font-size: var(--text-xs); color: var(--surface-muted); line-height: 1.75; margin: 0; }
.fw-counts { display: flex; gap: 6px; margin-bottom: 12px; }
.fw-chip { display: inline-block; font-size: var(--text-xs); padding: 2px 9px; border-radius: 999px; background: var(--palette-soft); color: var(--palette-primary); border: 1px solid var(--palette-border); white-space: nowrap; }
.fw-chip.fw-tag-blue { background: #e8f0f8; color: #3a6f9c; border-color: #c8dcee; }
.fw-chip.fw-tag-amber { background: #fbf1de; color: #a8752a; border-color: #ebd6ad; }
.fw-chip.fw-tag-gray { background: var(--surface-raised); color: var(--surface-muted); border-color: var(--surface-border); }
.fw-feed { position: relative; padding-left: 16px; }
.fw-feed:before { content: ''; position: absolute; left: 4px; top: 8px; bottom: 8px; width: 1px; background: var(--surface-border); }
.fw-feed-item { position: relative; margin-bottom: 10px; }
.fw-dot { position: absolute; left: -15px; top: 14px; width: 7px; height: 7px; border-radius: 50%; background: var(--palette-primary); border: 2px solid var(--surface-panel); }
.fw-sealed .fw-dot { background: #c39a4d; }
.fw-feed-body { padding: 9px 11px; border: 1px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); }
.fw-meta { display: flex; align-items: center; gap: 8px; font-size: var(--text-xs); color: var(--surface-muted); }
.fw-feed-body p { margin: 7px 0 5px; font-size: var(--text-body); line-height: 1.8; white-space: pre-wrap; }
.fw-dim { color: var(--surface-muted); font-style: italic; }
.fw-capture { display: flex; gap: 8px; }
.fw-capture input { flex: 1; font-family: inherit; font-size: var(--text-sm); padding: 8px 10px; border: 1px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); outline: none; }
.fw-sync { margin: 10px 0 12px; padding: 9px 11px; border: 1px solid var(--palette-border); border-radius: var(--radius-md); background: var(--palette-soft); color: var(--palette-primary); font-size: var(--text-sm); line-height: 1.7; }
.fw-flash { display: flex; align-items: center; gap: 9px; padding: 9px 11px; border: 1px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); margin-bottom: 8px; }
.fw-flash-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--palette-primary); flex: 0 0 6px; }
.fw-flash-body { flex: 1; min-width: 0; }
.fw-flash-body p { margin: 0; font-size: var(--text-body); line-height: 1.7; }
.fw-btn { font-size: var(--text-sm); padding: 6px 12px; border: 1px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); cursor: pointer; white-space: nowrap; }
.fw-btn.fw-primary { background: var(--palette-primary); color: var(--palette-on); border-color: var(--palette-primary); }
.fw-btn.fw-mini { padding: 3px 9px; font-size: var(--text-xs); }
.fw-btn.fw-on-btn { background: var(--palette-soft); color: var(--palette-primary); border-color: var(--palette-border); }
.fw-btn:disabled { opacity: .5; cursor: default; }
.fw-writing { display: grid; grid-template-columns: 190px 1fr; gap: 12px; }
.fw-doclist { display: flex; flex-direction: column; gap: 6px; }
.fw-doc { text-align: left; font-size: var(--text-sm); padding: 8px 10px; border: 1px solid var(--surface-border); border-radius: var(--radius-md); background: var(--surface-raised); cursor: pointer; }
.fw-doc.fw-doc-on { border-color: var(--palette-border); background: var(--palette-soft); color: var(--palette-primary); }
.fw-doc span { display: block; font-size: var(--text-xs); color: var(--surface-muted); margin-top: 3px; }
.fw-editor { border: 1px solid var(--surface-border); border-radius: var(--radius-lg); background: var(--surface-panel); overflow: hidden; }
.fw-ebar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: var(--surface-raised); border-bottom: 1px solid var(--surface-border); }
.fw-title { flex: 1; min-width: 0; font-family: inherit; font-size: var(--text-sm); font-weight: 600; border: 0; background: transparent; outline: none; }
.fw-paper { display: block; width: 100%; min-height: 240px; border: 0; outline: none; resize: vertical; padding: 14px 16px; font-family: Georgia, 'SimSun', serif; font-size: var(--text-body); line-height: 2; background: transparent; }
.fw-review { min-height: 240px; padding: 14px 16px; font-family: Georgia, 'SimSun', serif; font-size: var(--text-body); line-height: 2.1; white-space: pre-wrap; }
.fw-soft { background: #fbf1de; border-bottom: 1px solid #e9c98c; border-radius: 3px; }
.fw-hard { background: #f9e9e5; border-bottom: 2px solid #b34a3a; border-radius: 3px; }
.fw-review mark { background: #e8f0f8; border-bottom: 1px solid #9dbfdd; border-radius: 2px; padding: 0 1px; color: inherit; }
.fw-rail-hint { padding-left: 2px; }
</style>
