// 时间轴 / 回顾 / 全局概览共用的展示格式化。
// 8 utils 的汇总返回形态不统一（数组 / {items} / {rows} / 裸对象），统一在这里收敛，
// 避免三个视图各写一份 label/objectRows 造成新的重复。

export function labelText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) return v.map(labelText).join('、');
    const o = v as Record<string, unknown>;
    const parts: string[] = [];
    [o.date, o.label, o.title, o.phrase, o.name].forEach(function (x) {
      if (typeof x === 'string' && x && parts.indexOf(x) < 0) parts.push(x);
    });
    // 搜索命中、复盘摘录要把正文一起带出来，只显示日期会找不到关键词
    if (typeof o.text === 'string' && o.text) parts.push(o.text.slice(0, 90));
    return parts.join(' · ') || JSON.stringify(o).slice(0, 80);
  }
  return '';
}

export function objectRows(v: unknown): Array<{ k: string; v: string }> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  return Object.keys(o)
    .filter(function (k) {
      const x = o[k];
      return typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
    })
    .map(function (k) { return { k: k, v: String(o[k]) }; });
}
