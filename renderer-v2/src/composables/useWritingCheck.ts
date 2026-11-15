// 写作法体检的共享状态：中栏「③ 长文撰写」的编辑态与右栏「写作法 · 海明威」卡
// 读的是同一份结果，避免两处各算一次、数字对不上。
//
// 分工（写作法的红线）：
//   · 规则仍是 src/writing/check.js 的本地纯函数（零联网 / 零模型 / 零依赖）；
//   · 这里只保存「正文快照 + 体检结果」，正文权威源永远是 md_freewrite，右栏只读不回写；
//   · 右栏唯一的写操作是切换体检开关（写 free.prefs.checkOn），永不给改写文本、不代写。
import { ref } from 'vue';
import { callDomain } from './useDomain';

export interface WHit { start: number; end: number; type: string }
export interface WSentence { text: string; level: string; hits: WHit[] }
export interface WCounts {
  soft: number; hard: number; long: number; weak: number; passive: number; heavy: number; sentences: number;
}
export interface WCheck {
  sentences: WSentence[];
  counts: WCounts;
  chars: number;
  avg: number;
  readability: string;
}
export interface WCard { id: string; title: string; body: string }

export const EMPTY_WCHECK: WCheck = {
  sentences: [],
  counts: { soft: 0, hard: 0, long: 0, weak: 0, passive: 0, heavy: 0, sentences: 0 },
  chars: 0,
  avg: 0,
  readability: '偏短'
};

// 模块级单例：FreeView 卸载后右栏还在，状态不能跟着组件一起没
const active = ref(false);   // 中栏是否停在「③ 长文撰写」
const checkOn = ref(false);  // true = 编辑态逐句标色；false = 纯写作态
const body = ref('');        // 主栏正文快照（只读镜像，供右栏算体检）
const result = ref<WCheck>(EMPTY_WCHECK);
const cards = ref<WCard[]>([]);
const running = ref(false);

let timer: ReturnType<typeof setTimeout> | null = null;

async function run(): Promise<void> {
  running.value = true;
  try {
    const r = await callDomain<WCheck>('writing.check', EMPTY_WCHECK, body.value);
    result.value = r && Array.isArray(r.sentences) ? r : EMPTY_WCHECK;
  } finally {
    running.value = false;
  }
}

// 正文一变就同步快照并重算（350ms 防抖）。
// 写作态也照算：右栏是唯一看数的地方，写作时数字要跟着走，但中栏不标色、不打扰。
function noteBody(text: string): void {
  body.value = text;
  if (timer) clearTimeout(timer);
  timer = setTimeout(function () { void run(); }, 350);
}

// 立刻重算（切文档、开体检时用，不等防抖）
function runNow(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  void run();
}

function setActive(v: boolean): void {
  active.value = v;
}

function hydrate(on: boolean): void {
  checkOn.value = on;
}

// 体检开关：唯一的写操作，落 free.prefs.checkOn，下次打开模块保持
function toggle(): void {
  checkOn.value = !checkOn.value;
  void callDomain('free.prefs', {}, { checkOn: checkOn.value });
  if (checkOn.value) runNow();
}

async function loadCards(): Promise<void> {
  if (cards.value.length) return;
  const list = await callDomain<WCard[]>('writing.cards', []);
  cards.value = Array.isArray(list) ? list : [];
}

export function useWritingCheck() {
  return {
    active, checkOn, body, result, cards, running,
    noteBody, runNow, setActive, hydrate, toggle, loadCards
  };
}
