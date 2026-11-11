// 富文本 ⇄ Markdown 子集 的双向转换。
//
// 为什么存在 Markdown 而不是 HTML：
//   cells[key] 是一个纯文本字段，下游有 4 条链路都直接吃它——全文检索（search）、
//   洞察的字数统计（cell-insights.cleanLen）、导出 Markdown、备份 JSON。
//   若存 HTML，检索会命中标签名、导出会冒出 <strong>、字数被标签污染，
//   而这 4 条链路都在被冻结的 src/utils 里，改不动也不该改。
//   存 Markdown 则一切照旧：人眼可读、检索可命中、导出干净。
//
// 安全性：markdownToHtml 先 escapeHtml 再做标记替换，
// 任何用户输入都会被转义，不存在注入面（配合严格 CSP，无 innerHTML 直插原文）。

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
};

export function escapeHtml(input: string): string {
  return String(input === undefined || input === null ? '' : input).replace(/[&<>"]/g, function (c) {
    return ESCAPES[c];
  });
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'SECTION'
]);

// 单个节点 → Markdown 片段：**必须处理节点自身的标签**。
// 早先的写法只遍历子节点，导致 `<b>文字</b>` 直接位于顶层时标签被丢掉、加粗变纯文本。
function inlineNode(node: Node): string {
  if (node.nodeType === 3) {
    return String(node.nodeValue || '').replace(/\u00a0/g, ' ');
  }
  if (node.nodeType !== 1) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  const inner = inlineOf(el);
  if (!inner) return '';
  if (tag === 'strong' || tag === 'b') return '**' + inner + '**';
  if (tag === 'em' || tag === 'i') return '*' + inner + '*';
  if (tag === 's' || tag === 'strike' || tag === 'del') return '~~' + inner + '~~';
  if (tag === 'code') return '`' + inner + '`';
  return inner;
}

// 容器 → 把子节点逐个翻译后拼接
function inlineOf(node: Node): string {
  let out = '';
  node.childNodes.forEach(function (child) {
    out += inlineNode(child);
  });
  return out;
}

// contenteditable 的 HTML → Markdown。只认工具栏能产出的那几种结构。
export function htmlToMarkdown(html: string): string {
  const src = String(html === undefined || html === null ? '' : html);
  if (!src.trim()) return '';
  const doc = new DOMParser().parseFromString('<div id="rt-root">' + src + '</div>', 'text/html');
  const root = doc.getElementById('rt-root');
  if (!root) return '';

  const lines: string[] = [];
  let pending = '';

  function flush() {
    const text = pending.replace(/\u00a0/g, ' ').trim();
    if (text) {
      text.split('\n').forEach(function (l) {
        const t = l.trim();
        if (t) lines.push(t);
      });
    }
    pending = '';
  }

  root.childNodes.forEach(function (node) {
    if (node.nodeType === 3) {
      pending += String(node.nodeValue || '').replace(/\u00a0/g, ' ');
      return;
    }
    if (node.nodeType !== 1) return;

    if (BLOCK_TAGS.has((node as HTMLElement).tagName)) {
      flush();
      const el = node as HTMLElement;
      const tag = el.tagName;

      if (tag === 'UL' || tag === 'OL') {
        const ordered = tag === 'OL';
        const items = Array.prototype.filter.call(el.children, function (c: HTMLElement) {
          return c.tagName === 'LI';
        }) as HTMLElement[];
        items.forEach(function (li: HTMLElement, i: number) {
          const t = inlineOf(li).replace(/\n+/g, ' ').trim();
          if (t) lines.push((ordered ? (i + 1) + '. ' : '- ') + t);
        });
        return;
      }

      if (tag === 'BLOCKQUOTE') {
        const t = inlineOf(el).trim();
        if (t) {
          t.split('\n').forEach(function (l) {
            const v = l.trim();
            if (v) lines.push('> ' + v);
          });
        }
        return;
      }

      if (/^H[1-6]$/.test(tag)) {
        const t = inlineOf(el).replace(/\n+/g, ' ').trim();
        if (t) lines.push('### ' + t);
        return;
      }

      const text = inlineOf(el);
      if (text.trim()) pending += text;
      flush();
      return;
    }

    // 行内元素（strong / em / code / br…）：交给 inlineNode，它会带上自身标记
    pending += inlineNode(node);
  });
  flush();

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 行内标记：先整体转义，再用占位符保护行内代码，最后套标签。
function inlineMarkdown(raw: string): string {
  let s = escapeHtml(raw);
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, function (_m, code: string) {
    codes.push(code);
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/\u0000C(\d+)\u0000/g, function (_m, i: string) {
    return '<code>' + codes[Number(i)] + '</code>';
  });
  return s;
}

// Markdown → HTML（供 contenteditable 回显）。空行分段，连续同类行合并成列表 / 引用。
export function markdownToHtml(markdown: string): string {
  const src = String(markdown === undefined || markdown === null ? '' : markdown).replace(/\r\n?/g, '\n');
  if (!src.trim()) return '';

  const lines = src.split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let quote: string[] = [];
  let para: string[] = [];

  function closeList() {
    if (list) {
      out.push('</' + list + '>');
      list = null;
    }
  }
  function closeQuote() {
    if (quote.length) {
      out.push('<blockquote>' + quote.map(inlineMarkdown).join('<br>') + '</blockquote>');
      quote = [];
    }
  }
  function closePara() {
    if (para.length) {
      out.push('<p>' + para.map(inlineMarkdown).join('<br>') + '</p>');
      para = [];
    }
  }
  function closeAll() {
    closeList();
    closeQuote();
    closePara();
  }

  lines.forEach(function (line) {
    const raw = line.replace(/\u00a0/g, ' ');

    if (!raw.trim()) {
      closeAll();
      return;
    }

    const heading = raw.match(/^\s{0,3}###\s+(.*)$/);
    if (heading) {
      closeAll();
      out.push('<h3>' + inlineMarkdown(heading[1].trim()) + '</h3>');
      return;
    }

    const quoted = raw.match(/^\s{0,3}>\s?(.*)$/);
    if (quoted) {
      closeList();
      closePara();
      quote.push(quoted[1]);
      return;
    }

    const bullet = raw.match(/^\s{0,3}[-*+]\s+(.*)$/);
    if (bullet) {
      closeQuote();
      closePara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + inlineMarkdown(bullet[1]) + '</li>');
      return;
    }

    const ordered = raw.match(/^\s{0,3}\d+\.\s+(.*)$/);
    if (ordered) {
      closeQuote();
      closePara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + inlineMarkdown(ordered[1]) + '</li>');
      return;
    }

    closeList();
    closeQuote();
    para.push(raw);
  });

  closeAll();
  return out.join('');
}

// 纯文本视图：字数统计、摘要、搜索高亮都用它，避免把标记算成字数。
export function stripMarkdown(markdown: string): string {
  return String(markdown === undefined || markdown === null ? '' : markdown)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>)\s?/gm, '')
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function markdownLength(markdown: string): number {
  return stripMarkdown(markdown).length;
}
