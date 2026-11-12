/*
 * 九格手记 · 界面语言（渲染层单例）
 *
 * 设计口径：
 *  - 源码里的中文文案保持原样，静态契约依赖它们；语言切换靠「中文原文 -> 目标语言」词典
 *    在运行时改写已渲染的界面文本，因此不需要逐组件替换模板，也不会碰领域层与用户数据。
 *  - 简体中文是默认与原文语言，此时本模块不改写任何 DOM，观感与旧版逐字一致。
 *  - 只处理界面标签的短文本与 aria/title/placeholder；输入控件、可编辑区与长说明一律跳过，
 *    用户写的日记、笔记、摘录、自建语料永远不会被改写。
 *  - 偏好只写本机存储，跨窗口由 storage 事件同步；全程零网络。
 */
import { ref } from 'vue';
import dictRaw from './dict.json';
import localesRaw from './locales.json';

export type LocaleCode = 'zh-Hans' | 'zh-Hant' | 'ja-JP' | 'en-US';
export type LocaleChoice = LocaleCode | 'auto';

type Pattern = { re: string; params: string[]; out: Record<string, string> };
type DictShape = {
  locales: string[];
  languageNames: Record<string, string>;
  exact: Record<string, Record<string, string>>;
  patterns: Pattern[];
};
type Nested = Record<string, unknown>;

const DICT = dictRaw as unknown as DictShape;
const PACKS = localesRaw as unknown as Record<string, Nested>;
const STORAGE_KEY = 'jiuge.ui.locale';
const SRC_ATTR = 'data-i18n-src';
const ATTR_BAK = 'data-i18n-attr';
const ATTRS = ['aria-label', 'title', 'placeholder'];
const CODES: LocaleCode[] = ['zh-Hans', 'zh-Hant', 'ja-JP', 'en-US'];
const UI_TAGS = [
  'BUTTON', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LABEL', 'SUMMARY', 'STRONG', 'SMALL', 'TH', 'OPTION', 'LEGEND',
  'SPAN', 'P', 'LI', 'DIV'
];
const FONTS: Record<LocaleCode, string> = {
  'zh-Hans': '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  'zh-Hant': '"PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif',
  'ja-JP': '"Yu Gothic UI", "Hiragino Kaku Gothic ProN", Meiryo, "Noto Sans CJK JP", sans-serif',
  'en-US': '"Segoe UI", Inter, system-ui, sans-serif'
};

export const LOCALE_OPTIONS: Array<{ code: LocaleChoice; label: string }> = [
  { code: 'auto', label: '跟随系统 / Auto' },
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'en-US', label: 'English' }
];

const choice = ref<LocaleChoice>('auto');
const locale = ref<LocaleCode>('zh-Hans');
let observer: MutationObserver | null = null;
let pending: number | null = null;
let started = false;

function isCode(v: string): v is LocaleCode {
  return CODES.indexOf(v as LocaleCode) >= 0;
}

function detect(): LocaleCode {
  const s = (typeof navigator !== 'undefined' ? (navigator.language || '') : '').toLowerCase();
  if (s.indexOf('ja') === 0) return 'ja-JP';
  if (s.indexOf('en') === 0) return 'en-US';
  if (/hant|tw|hk|mo/.test(s)) return 'zh-Hant';
  return 'zh-Hans';
}

function resolve(c: LocaleChoice): LocaleCode {
  return c === 'auto' ? detect() : c;
}

function lookup(text: string, code: LocaleCode): string | null {
  const exact = DICT.exact[code];
  if (!exact) return null;
  if (Object.prototype.hasOwnProperty.call(exact, text)) return exact[text];
  for (let i = 0; i < DICT.patterns.length; i++) {
    const p = DICT.patterns[i];
    const m = new RegExp(p.re).exec(text);
    if (!m) continue;
    let out = p.out[code] || '';
    p.params.forEach(function (name, idx) {
      out = out.split('{' + name + '}').join(m[idx + 1] || '');
    });
    return out;
  }
  return null;
}

function getPath(obj: Nested | undefined, dotted: string): string {
  let cur: unknown = obj;
  const segs = dotted.split('.');
  for (let i = 0; i < segs.length; i++) {
    if (!cur || typeof cur !== 'object') return '';
    cur = (cur as Nested)[segs[i]];
  }
  return typeof cur === 'string' ? cur : '';
}

/** 供后续逐组件接线使用；本轮界面走下面的词典层 */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = getPath(PACKS[locale.value], key) || getPath(PACKS['en-US'], key);
  if (params) {
    Object.keys(params).forEach(function (k) {
      s = s.split('{' + k + '}').join(String(params[k]));
    });
  }
  return s;
}

function inUserArea(el: Element): boolean {
  return !!el.closest('input, textarea, [contenteditable], [data-no-i18n], script, style, .rr-page');
}

function readBackup(el: Element): Record<string, string> {
  const raw = el.getAttribute(ATTR_BAK);
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, string>; } catch (e) { return {}; }
}

function translateElement(el: Element, code: LocaleCode): void {
  if (!(el instanceof HTMLElement)) return;
  if (UI_TAGS.indexOf(el.tagName) < 0) return;
  if (inUserArea(el)) return;

  // 文本节点：只处理「纯文本元素」，避免破坏带子节点的结构
  let hasElementChild = false;
  for (let i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeType === 1) { hasElementChild = true; break; }
  }
  if (!hasElementChild) {
    const current = el.textContent || '';
    let original = el.getAttribute(SRC_ATTR);
    // Vue 重写了这段中文（例如「连续 7 天」变成「连续 8 天」）时，原文记录要跟着更新，
    // 否则重译会一直用第一次记下的旧数字。
    if (original !== null && /[\u4e00-\u9fff]/.test(current) && current.trim() !== original.trim()) {
      el.setAttribute(SRC_ATTR, current);
      original = current;
    }
    const raw = original !== null ? original : current;
    const trimmed = raw.trim();
    if (trimmed && trimmed.length <= 80 && /[\u4e00-\u9fff]/.test(trimmed)) {
      const hit = lookup(trimmed, code);
      const lead = (raw.match(/^\s*/) || [''])[0];
      const next = hit ? lead + hit : raw;
      if (original === null && hit) el.setAttribute(SRC_ATTR, raw);
      if (el.textContent !== next) el.textContent = next;
      if (code === 'zh-Hans') el.removeAttribute(SRC_ATTR);
    }
  }

  // 无障碍与提示属性：这些属性只属于界面，不会承载用户数据
  let bak = readBackup(el);
  ATTRS.forEach(function (a) {
    const original = bak[a] !== undefined ? bak[a] : (el.getAttribute(a) || '');
    if (!original || !/[\u4e00-\u9fff]/.test(original)) return;
    const hit = lookup(original.trim(), code);
    if (hit) {
      if (bak[a] === undefined) { bak[a] = original; }
      if (el.getAttribute(a) !== hit) el.setAttribute(a, hit);
    } else if (bak[a] !== undefined) {
      if (el.getAttribute(a) !== bak[a]) el.setAttribute(a, bak[a]);
    }
  });
  if (Object.keys(bak).length) {
    const encoded = JSON.stringify(bak);
    if (el.getAttribute(ATTR_BAK) !== encoded) el.setAttribute(ATTR_BAK, encoded);
  }
}

function translateTree(node: Node, code: LocaleCode): void {
  if (node.nodeType === 1) translateElement(node as Element, code);
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i++) translateTree(kids[i], code);
}

function restoreAll(): void {
  document.querySelectorAll('[' + SRC_ATTR + ']').forEach(function (el) {
    el.textContent = el.getAttribute(SRC_ATTR) || '';
    el.removeAttribute(SRC_ATTR);
  });
  document.querySelectorAll('[' + ATTR_BAK + ']').forEach(function (el) {
    const bak = readBackup(el);
    Object.keys(bak).forEach(function (a) { el.setAttribute(a, bak[a]); });
    el.removeAttribute(ATTR_BAK);
  });
}

function stopObserver(): void {
  if (observer) { observer.disconnect(); observer = null; }
  if (pending !== null) { window.clearTimeout(pending); pending = null; }
}

function startObserver(code: LocaleCode): void {
  if (observer) return;
  observer = new MutationObserver(function (records) {
    if (pending !== null) return;
    pending = window.setTimeout(function () {
      pending = null;
      records.forEach(function (r) {
        if (r.type === 'characterData' && r.target.parentElement) {
          translateElement(r.target.parentElement, code);
        } else {
          r.addedNodes.forEach(function (n) { translateTree(n, code); });
        }
      });
    }, 60);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function apply(code: LocaleCode): void {
  const root = document.documentElement;
  root.setAttribute('lang', code);
  root.setAttribute('data-locale', code);
  root.style.fontFamily = FONTS[code];
  if (document.body) document.body.style.fontFamily = FONTS[code];
  if (code === 'zh-Hans') { restoreAll(); stopObserver(); return; }
  if (document.body) translateTree(document.body, code);
  startObserver(code);
}

function onStorage(e: StorageEvent): void {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  const next: LocaleChoice = e.newValue === 'auto' ? 'auto' : (isCode(e.newValue) ? e.newValue : 'auto');
  if (next === choice.value) return;
  choice.value = next;
  locale.value = resolve(next);
  stopObserver();
  apply(locale.value);
}

export function setLocale(next: LocaleChoice): void {
  if (next !== 'auto' && !isCode(next)) return;
  choice.value = next;
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* 存储不可用时仅本次生效 */ }
  locale.value = resolve(next);
  stopObserver();
  apply(locale.value);
}

/** 每个窗口启动时调用一次（主窗 App.vue / 独立账本窗 finance-main.ts） */
export function initI18n(): void {
  if (started) return;
  started = true;
  let saved: LocaleChoice = 'auto';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'auto' || (v && isCode(v))) saved = v as LocaleChoice;
  } catch (e) { /* 读不到就用系统语言 */ }
  choice.value = saved;
  locale.value = resolve(saved);
  window.addEventListener('storage', onStorage);
  apply(locale.value);
}

export function useI18n() {
  return {
    locale,
    choice,
    options: LOCALE_OPTIONS,
    setLocale,
    t,
    initI18n,
    languageName: function (code: string): string {
      return DICT.languageNames[code] || code;
    }
  };
}
