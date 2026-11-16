// 休闲阅读当日摘要（2026-11-16）：把阅读窗按天记在本机的时长读成九格可用的一行行。
// 为什么放在渲染层而不进 md_reading：阅读时长的既有约定是「只在本机、按书累计、不进 WAL」，
// 这里只加了一个按天的本机键，领域层与备份一个字节都不用改。
export interface LeisureRead {
  bookId: string;
  title: string;
  seconds: number;
  minutes: number;
}

const DAY_KEY = 'jiuge-reader-day:';
const MIN_SECONDS = 300; // 5 分钟门槛，低于它不进笔记、不在窗口里占位置
const MARK = '〔rt:';

export function localDayOf(ts: number): string {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function leisureReadsOf(date: string): LeisureRead[] {
  const prefix = DAY_KEY + date + ':';
  const out: LeisureRead[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || '';
      if (key.indexOf(prefix) !== 0) continue;
      const raw = JSON.parse(localStorage.getItem(key) || '{}') as {
        bookId?: string; title?: string; mode?: string; seconds?: number;
      };
      if (raw.mode && raw.mode !== 'leisure') continue;
      const seconds = Math.max(0, Number(raw.seconds) || 0);
      if (seconds < MIN_SECONDS) continue;
      out.push({
        bookId: raw.bookId || key.slice(prefix.length),
        title: raw.title || '未命名',
        seconds: seconds,
        minutes: Math.round(seconds / 60)
      });
    }
  } catch (_) { /* 本机存储不可用就当今天没读，不拦住写作 */ }
  return out.sort((a, b) => b.seconds - a.seconds);
}

export function readLine(r: LeisureRead): string {
  return '【休闲阅读】《' + r.title + '》 · 阅读 ' + r.minutes + ' 分钟' + MARK + r.bookId + '〕';
}

// 幂等追加：已有同一本书的自动行就不重复写；用户手写的其他行原样保留。
export function mergeAutoLines(cellText: string, lines: string[]): string {
  let text = cellText || '';
  let changed = false;
  lines.forEach(function (line) {
    if (text.indexOf(line) >= 0) return;
    const id = line.slice(line.indexOf(MARK));
    // 同一本书换了时长时，替换旧的自动行，而不是再堆一行
    const at = text.indexOf(id);
    if (at >= 0) {
      const end = text.indexOf('\n', at);
      const before = text.slice(0, at);
      const after = end < 0 ? '' : text.slice(end);
      const start = before.lastIndexOf('\n') + 1;
      text = before.slice(0, start) + line + after;
    } else {
      text = text ? text.replace(/\s*$/, '') + '\n' + line : line;
    }
    changed = true;
  });
  return changed ? text : (cellText || '');
}
