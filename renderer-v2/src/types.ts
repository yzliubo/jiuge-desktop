// B 架构视图层共享类型；与 9 固定键 / 日期键 / 金额分制契约保持一致
export interface DiaryBase {
  weather: string;
  anniversary: string;
  body: string;
  mood: string;
}

export interface DiaryRecord {
  date: string;
  base: DiaryBase;
  cells: Record<string, string>;
  workBoard?: unknown;
  moneyBook?: unknown;
  studyLog?: unknown;
  template?: string;
  updatedAt?: number;
}

// 九格仍是九格：「梦想」这一格换成「娱乐」，梦想本身升成一级模块（目标板）。
// 为什么换：梦想是长期、低频、不知从哪下笔的东西，按天要求写，写作率必然低；
// 娱乐是具体活动（看了什么、玩了多久），一天里真会发生，也就真写得出来。
// 梦想没有被丢掉——它变成了有计划、有进度、有日期的地方，见 DreamView。
// 数据层不动：旧记录里的 cells.dream 仍在（导出、备份、搜索都能看到）。
export const GRID_KEYS = [
  'work', 'money', 'health', 'relation', 'future',
  'emotion', 'leisure', 'growth', 'free'
] as const;

// 九格统一四字名：两字名放进行目录里太轻，看不出「这一格是干什么的」；
// 四个字正好说清动作（推进 / 收支 / 经营 / 觉察 / 记录），也还塞得进格子标题行。
// 2026-11-08 22:15 主理人要求：中栏「今日六点」横条合并进九格的「未来」格，该格改名「今日六条」。
// 2026-11-08 23:16 主理人要求：九格一律四字命名。
// 数据键全部不动：cells.work / cells.future 等历史正文、导出、检索、备份照旧，只改显示名。
export const GRID_LABELS: Record<string, string> = {
  work: '工作推进', money: '金钱收支', health: '身心健康',
  relation: '关系经营', future: '今日六条', emotion: '情绪觉察',
  leisure: '休闲娱乐',
  dream: '梦想', // 旧数据的 cells.dream 仍在（不计入九格，但导出/搜索要能显示名字）
  growth: '学习成长', free: '自由记录'
};

export type SkinId = 'forest' | 'night' | 'sakura' | 'candy';
export const SKINS: Array<{ id: SkinId; label: string }> = [
  { id: 'forest', label: '森绿米白' },
  { id: 'night', label: '冷调夜航' },
  { id: 'sakura', label: '樱花奶油' },
  { id: 'candy', label: '糖果积木' }
];

// 原小程序 5 页（今日 / 回看 / 胶囊 / 坚持 / 设置）在桌面端按职责重组：
// 回看拆成「时间轴（日记）」+「回顾（概览 / 复盘）」，并新增一级「数据中心」。
// insight 不进一级导航，由标题栏进入；inspire（语料库）挂在数据中心下，
// 它是「问候 / 名言 / 运动提示」的数据管理，不是第 8 个功能模块。
export type ViewKey = 'today' | 'insight' | 'cell' | 'timeline' | 'capsule' | 'review' | 'habit' | 'dream' | 'data' | 'bin' | 'inspire' | 'settings' | 'life' | 'relation' | 'connect' | 'long' | 'reading' | 'finance';
// V1.3 正文待办汇总：只读行，勾选必须回原文（不在汇总页写正文）
export interface TodoRow { date: string; cell: string; text: string; line: number; raw: string }
export const NAV_ITEMS: Array<{ key: ViewKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'timeline', label: '时间轴' },
  { key: 'review', label: '回顾' },
  { key: 'capsule', label: '胶囊' },
  { key: 'habit', label: '坚持' },
  // 梦想从九格升成一级模块：目标板（短/中/长期 + 量化 + 关联行动）
  { key: 'dream', label: '梦想' },
  { key: 'data', label: '数据中心' }
];

export interface ListResult<T> {
  items: T[];
  cursor: string | null;
  total: number;
}

export interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
}

export interface DataChangedEvent {
  keys: string[];
  revision: number;
  originWindowId?: string;
}

export function emptyRecord(date: string): DiaryRecord {
  const cells: Record<string, string> = {};
  GRID_KEYS.forEach((k) => { cells[k] = ''; });
  return {
    date,
    base: { weather: '', anniversary: '', body: '', mood: '' },
    cells,
    updatedAt: 0
  };
}

export function localDate(d: Date = new Date()): string {
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
