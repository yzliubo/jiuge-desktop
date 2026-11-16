// 唯一出境口：所有视图只能通过本模块访问主进程 v1 API。
// preload 只暴露白名单 typed 方法；渲染层不得直接触碰 ipcRenderer / fs / net。
// 非 Electron 环境（vite dev / 单测）自动降级为内存 mock，界面仍可独立运行。
import type { ApiEnvelope, DataChangedEvent, DiaryRecord, ListResult } from './types';

export interface PreloadBridge {
  invoke<T>(channel: string, payload?: unknown): Promise<ApiEnvelope<T>>;
  onDataChanged(cb: (event: DataChangedEvent) => void): () => void;
  // 全局热键 / 托盘速记（R-09）：主进程推「现在可以记了」，payload.date 是按键那一刻的日期
  onQuickCapture?(cb: (payload: { date: string; source: string }) => void): () => void;
  // 拖放：把 File 交给 preload 换成本机绝对路径，渲染层不接触 fs
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    jiugeBridge?: PreloadBridge;
  }
}

const DIARY_KEY_RE = /^morning_diary_(\d{4}-\d{2}-\d{2})$/;

function createMemoryBridge(): PreloadBridge {
  const store = new Map<string, unknown>();
  const listeners = new Set<(event: DataChangedEvent) => void>();
  let revision = 0;
  const seen = new Map<string, ApiEnvelope<unknown>>();

  function ok<T>(data: T): ApiEnvelope<T> {
    return { code: 'OK', message: 'ok', data };
  }

  return {
    pathForFile: function (): string { return ''; },
    async invoke<T>(channel: string, payload: unknown = {}): Promise<ApiEnvelope<T>> {
      const q = (payload || {}) as Record<string, unknown>;
      let data: unknown = null;
      switch (channel) {
        case 'v1/reader:open': {
          data = { ok: true, reused: false } as ReaderReceipt;
          break;
        }
        // 开发模式没有第二个窗口：如实回「已开窗」，界面不做跳转
        case 'v1/finance:open': {
          data = { ok: true, reused: false };
          break;
        }
        // 开发模式没有主进程 HTTP 客户端：如实回「未开启」，界面走降级提示
        case 'v1/worktime:sync': {
          data = { ok: false, code: 'NOT_ENABLED', msg: '开发模式（内存桥）没有本机时间源' } as WorktimeSyncReport;
          break;
        }
        // 开发模式不联网：取天气回「用的是样例缓存」，城市检索如实说不可用
        case 'v1/weather:sync': {
          data = { ok: true, cached: true };
          break;
        }
        case 'v1/weather:geocode': {
          data = { ok: false, code: 'MOCK', msg: '开发模式（内存桥）不联网，城市检索不可用' };
          break;
        }
        case 'v1/diaries:list': {
          const keys = Array.from(store.keys())
            .filter((k) => DIARY_KEY_RE.test(k)).sort().reverse();
          const size = Math.min(Math.max(Number(q.pageSize) || 50, 1), 200);
          const start = Math.max(Number(q.cursor) || 0, 0);
          const slice = keys.slice(start, start + size).map((k) => store.get(k));
          data = {
            items: slice,
            cursor: start + size < keys.length ? String(start + size) : null,
            total: keys.length
          } as ListResult<DiaryRecord>;
          break;
        }
        case 'v1/diaries:getBatch': {
          const dates = Array.isArray(q.dates) ? q.dates : [];
          const records: Record<string, unknown> = {};
          dates.forEach((d) => {
            const key = 'morning_diary_' + String(d);
            if (store.has(key)) records[key] = store.get(key);
          });
          data = { records };
          break;
        }
        case 'v1/diaries:upsert': {
          const requestId = q.requestId ? String(q.requestId) : '';
          if (requestId && seen.has(requestId)) return seen.get(requestId) as ApiEnvelope<T>;
          const record = q.record as DiaryRecord;
          if (!record || !record.date) {
            return { code: 'INVALID_FORMAT', message: '缺少 record.date', data: null as T };
          }
          store.set('morning_diary_' + record.date, record);
          revision += 1;
          const result = ok({ record, revision, changedKeys: ['morning_diary_' + record.date], fsync: true });
          if (requestId) seen.set(requestId, result);
          data = result.data;
          listeners.forEach((cb) => cb({ keys: result.data.changedKeys, revision }));
          break;
        }
        case 'v1/config:getMany': {
          const keys = Array.isArray(q.keys) ? q.keys : [];
          const values: Record<string, unknown> = {};
          keys.forEach((k) => { if (store.has(String(k))) values[String(k)] = store.get(String(k)); });
          data = { values };
          break;
        }
        case 'v1/config:setMany': {
          const patch = (q.patch || {}) as Record<string, unknown>;
          const changedKeys: string[] = [];
          Object.keys(patch).forEach((k) => { store.set(k, patch[k]); changedKeys.push(k); });
          revision += 1;
          data = { revision, changedKeys };
          listeners.forEach((cb) => cb({ keys: changedKeys, revision }));
          break;
        }
        case 'v1/app:flush':
          data = { flushed: false, reason: String(q.reason || 'mock') };
          break;
        case 'v1/system:lockState':
          data = { revision, dirty: false, keys: store.size };
          break;
        case 'v1/health:check':
          data = {
            checkedAt: Date.now(),
            boot: { replayed: 0, loadedKeys: store.size, revision, lastExitClean: true, sweptAtBoot: 0 },
            store: { bytes: 0, mtime: new Date().toISOString(), count: store.size },
            bak: { exists: true, bytes: 0, mtime: new Date().toISOString(), count: store.size, behind: 0 },
            snapshots: { count: 1, latest: null, entries: [] },
            data: { diaries: store.size, keys: store.size, sealed: 0, sealedSoonest: null, gtdOpen: 0, capsules: 0 },
            migration: { done: true, manifestAt: new Date().toISOString() },
            autoBackup: { enabled: true, intervalMinutes: 30, kept: 5, lastAt: Date.now(), lastId: 'mock-auto' }
          };
          break;
        case 'v1/health:backup':
          data = { ok: true, id: 'mock-' + Date.now() + '-manual' };
          break;
        // 可回滚版本（R-10）：mock 下给两条假版本，界面与类型仍可独立跑
        case 'v1/snapshot:list':
          data = {
            items: [
              { id: '1762900000000-auto', createdAt: new Date().toISOString(), bytes: 1024, count: 3, auto: true, reason: 'timer' },
              { id: '1762800000000-pre-restore', createdAt: new Date(Date.now() - 86400000).toISOString(), bytes: 2048, count: 2, auto: false, reason: 'before-rollback' }
            ]
          };
          break;
        case 'v1/snapshot:restore':
          data = { ok: true, restored: String(q.id || ''), safetyId: 'mock-safety', before: { diaries: 3, keys: 5, revision }, after: { diaries: 2, keys: 5, revision } };
          break;
        // 使用度量（R-11）：mock 下全为「尚未产生样本」，不编造数字
        case 'v1/metrics:summary':
          data = {
            ok: true, enabled: true, file: '<mock>/metrics.log', sampleSize: 0, firstDay: null,
            metrics: {
              weekActiveDays: 0, nextDayRetention: null, week4Retention: null,
              migrateRate: null, searchUsageRate: null, saveLatencyP50: null, saveLatencyP95: null
            },
            counts: { appStart: 0, entrySave: 0, saveEvents: 0, searchUse: 0, migrateStart: 0, migrateSuccess: 0 },
            // V3.8 成效侧：mock 里一条成效事件都没有，available 必须是 false
            outcome: {
              available: false, events: 0,
              window7: { taskDone: 0, dreamMove: 0, readMove: 0, review: 0 },
              window30: { taskDone: 0, dreamMove: 0, readMove: 0, review: 0 },
              total: { taskDone: 0, dreamMove: 0, readMove: 0, review: 0 }
            }
          };
          break;
        case 'v1/metrics:setEnabled':
          data = { ok: true, enabled: !!q.enabled };
          break;
        case 'v1/quickcapture:trigger':
          data = { ok: true, queued: false, date: new Date().toISOString().slice(0, 10) };
          break;
        case 'v1/file:pick':
          data = { canceled: true, paths: [] };
          break;
        case 'v1/file:save':
          data = {
            canceled: false,
            path: 'C:\\Users\\<用户名>\\Documents\\' + String(q.name || 'export.txt'),
            bytes: String(q.text || '').length
          };
          break;
        case 'v1/domain:call': {
          const name = String(q.name || '');
          const mockDefaults: Record<string, unknown> = {
            stats: { data: { streak: 0, total: store.size, weekCount: 0, weekGoal: 5, bestStreak: 0, startedAt: '', gentle: '' }, error: null },
            'quotes.dailyIndex': 0,
            'quotes.pick': { index: 0, text: '今天也值得被记录。', author: '', long: false },
            'quotes.size': 540,
            'greetings.compose': { scope: '', tag: '今天', text: '慢慢来，比较快。', hint: '写一句就好' },
            activeTemplate: { id: 'standard', name: '标准·九格', fields: [] },
            activeGridFields: [],
            modules: { data: { work: true, money: true, growth: true }, error: null },
            firstWeekState: { data: { enabled: true, active: false, total: 0, dayNo: 1, celebration: '' }, error: null },
            firstWeekEnabled: true,
            // 自由记录 / 写作法：mock 通道下的空态，真实数据一律走主进程 md_freewrite
            'free.board': { flashes: [], docs: [], prefs: { lastTab: 'capsule', method: 'hemingway', checkOn: false } },
            'free.capsuleIndex': [],
            'free.flashAdd': { item: null, synced: false },
            'free.flashRetry': { item: null, synced: false },
            'free.noteAdd': { item: null, synced: false },
            'free.day': { date: '', flashes: [], docs: [], counts: { flash: 0, doc: 0, capsule: 0 } },
            // 九格「事项」：mock 通道下没有回写引用
            'gtd.refs': [],
            'free.flashSyncPending': { total: 0, synced: 0 },
            'free.flashRemove': { flashes: [], docs: [], prefs: { lastTab: 'capsule', method: 'hemingway', checkOn: false } },
            'free.docAdd': { flashes: [], docs: [], prefs: { lastTab: 'capsule', method: 'hemingway', checkOn: false } },
            'free.docUpdate': { flashes: [], docs: [], prefs: { lastTab: 'capsule', method: 'hemingway', checkOn: false } },
            'free.docRemove': { flashes: [], docs: [], prefs: { lastTab: 'capsule', method: 'hemingway', checkOn: false } },
            'free.prefs': { lastTab: 'capsule', method: 'hemingway', checkOn: false },
            'writing.check': {
              sentences: [], counts: { soft: 0, hard: 0, long: 0, weak: 0, passive: 0, heavy: 0, sentences: 0 },
              chars: 0, avg: 0, readability: '偏短', rules: { softLen: 40, hardLen: 60, weakWords: 24 }
            },
            'writing.cards': [],
            capsuleGroups: { data: { due: [], sealed: [], opened: [] }, error: null },
            capsulePresets: [
              { label: '7 天后', value: '2026-12-01' },
              { label: '一个月后', value: '2026-12-24' }
            ],
            milestoneView: { data: { total: 0, list: [], next: null, count: 0 }, error: null },
            weeklyReview: { data: {}, error: null },
            moodTrend: { data: { items: [], note: '' }, error: null },
            frequentPhrases: { data: { phrases: [] }, error: null },
            workDigest: { data: { reflections: [] }, error: null },
            moneySummary: { data: {}, error: null },
            studySummary: { data: {}, error: null },
            moduleDigest: { data: { rows: [] }, error: null },
            yearPixels: { data: { months: [], writtenCount: 0 }, error: null },
            studyLibraryText: { data: { empty: true, text: '还没有学习条目。' }, error: null },
            readStudyLibrary: { items: [], topics: [] },
            'insights.analyze': { insight: '这一格还没有历史内容。', metrics: [] },
            // 语料库：dev 模式（无 Electron）下给一份能看的样例，页面不至于空成白板
            'inspire.meta': {
              kinds: [
                { key: 'quotes', label: '名言警句', unit: '条', hint: '', hasAuthor: true, max: 400 },
                { key: 'greetings', label: '问候语', unit: '句', hint: '', hasAuthor: false, max: 160 },
                { key: 'moves', label: '运动提示', unit: '句', hint: '', hasAuthor: false, max: 160 }
              ],
              periods: [{ key: 'any', label: '任何时段' }, { key: 'dawn', label: '清晨' }],
              limits: { text: 400, greet: 160, author: 60, custom: 500 }
            },
            'inspire.today': {
              tag: '今天 · 上午',
              greeting: { text: '上午好，慢一点也算数。', hint: '每坐一小时起来走动两分钟。', periodLabel: '上午' },
              quote: { id: 'q-0', text: '今天也值得被记录。', author: '九格手记' },
              counts: { greetings: 1, moves: 1 }
            },
            'inspire.stats': {
              quotes: { builtin: 539, custom: 0, total: 539, enabled: 539, hidden: 0, overridden: 0 },
              greetings: { builtin: 29, custom: 0, total: 29, enabled: 29, hidden: 0, overridden: 0 },
              moves: { builtin: 43, custom: 0, total: 43, enabled: 43, hidden: 0, overridden: 0 }
            },
            'inspire.pick': { id: 'q-0', text: '今天也值得被记录。', author: '九格手记' },
            // 图书馆 / 读书笔记：dev 模式（无 Electron）给一份能看的空态，页面不至于白板
            'reading.meta': { modes: ['leisure', 'theme'], noteTypes: ['highlight', 'note', 'idea', 'link'], prompts: [] },
            'reading.board': {
              stats: { books: 0, notes: 0, highlights: 0, ideas: 0, pushed: 0, leisureNotes: 0, themeNotes: 0, tagCount: 0, thisMonth: 0 },
              books: [], themeGroups: [], recent: [], tagTop: []
            },
            'reading.notes': { items: [], total: 0, byTag: [], byBook: [], byType: [], byMonth: [] },
            'reading.read': { chapters: [], themes: [] },
            'reading.themes': [],
            'reading.exportMd': '# 读书笔记\n\n还没有笔记\n',
            // P0/P1 新通道：dev 模式给空态，界面能渲染、不给假数据
            'reading.growthAudit': { legacyBooks: 0, migratedBooks: 0, pendingBooks: 0, pending: [], legacyThemes: 0 },
            'reading.audit': {
              counts: { books: 0, notes: 0, themes: 0, danglingNotes: 0, danglingChapters: 0, danglingBookmarks: 0, danglingBooks: 0, dupFingerprints: 0, dupTitles: 0, notesNoSource: 0, missingFiles: 0, booksNoFingerprint: 0 },
              dangling: { notes: [], chapters: [], bookmarks: [], books: [] }, missingFiles: [], dupFingerprints: [], dupTitles: []
            },
            'reading.repairDangling': { fixed: 0, changes: [] },
            'reading.restoreDangling': { restored: 0 },
            'reading.refs': { bookId: '', title: '', noteCount: 0, theme: null, diary: [], tasks: [] },
            'reading.pushAction': { ok: false, reason: '开发模式（内存桥）没有任务库' },
            'reading.resurface': { recent: [], recentCount: 0, readingCount: 0, stale: [], staleCount: 0 },
            // P2：虚拟书架 / 书目清单 / 书库根目录（dev 模式一律空态，不造假日历数据）
            'reading.exportList': { format: 'csv', mime: 'text/csv;charset=utf-8', ext: 'csv', rows: 0, text: '\ufeff"title"\n' },
            'reading.pickRoot': { ok: false, canceled: true },
            'reading.addRoot': { ok: false, reason: '开发模式（内存桥）没有真实目录' },
            'reading.relocateRoot': { ok: false, reason: '开发模式（内存桥）没有真实目录' },
            'reading.roots': [],
            'search.library': { books: [], notes: [], themes: [], total: 0 },
            // 家庭账本：dev 模式（无 Electron）给一份能看的空态，金额一律整数分
            'finance.meta': {
              kinds: ['expense', 'income', 'transfer'],
              accountKinds: ['cash', 'bank', 'alipay', 'wechat', 'credit', 'invest', 'property', 'loan', 'other_asset', 'other_liability', 'other'],
              liabilityKinds: ['credit', 'loan', 'other_liability'], accountSides: ['asset', 'liability'],
              goalStates: ['active', 'paused', 'done'], intervals: ['monthly', 'quarterly', 'yearly'],
              endModes: ['never', 'date'],
              conditionFields: ['payee', 'note', 'category', 'account', 'kind', 'amountCents', 'date'],
              conditionOps: ['contains', 'eq', 'prefix', 'suffix', 'gte', 'lte'],
              actionTypes: ['setCategory', 'setPayee', 'setNote', 'setAccount', 'setKind'],
              limits: { maxTxns: 20000, maxRules: 100, centsMax: 99999999999, noteMax: 120, nameMax: 24, csvMaxBytes: 8388608 }
            },
            'finance.board': {
              version: 1, month: '2026-11',
              totals: { incomeCents: 0, expenseCents: 0, netCents: 0, transferCents: 0, budgetLimitCents: 0, budgetSpentCents: 0, budgetRemainingCents: 0 },
              budgets: [], byCategory: [], trend: [], txns: [], categories: [], accounts: [], rules: [],
              stats: { txnTotal: 0, inMonth: 0, imported: 0, ruleHit: 0, budgetCount: 0, ruleCount: 0 }
            },
            'finance.exportCsv': '日期,类型,金额(元),分类,账户,交易对方,备注,来源指纹\n',
            // 完整理财：dev / 单测的空态，金额一律整数分
            'finance.accountRows': [],
            'finance.netWorth': {
              month: '2026-11', assetsCents: 0, liabilitiesCents: 0, netCents: 0,
              groups: [], accounts: [], series: []
            },
            'finance.cashFlow': {
              month: '2026-11', months: [], incomeCents: 0, expenseCents: 0, netCents: 0,
              incomeDeltaBp: 0, expenseDeltaBp: 0, savingBp: 0
            },
            'finance.categoryReport': { month: '2026-11', prevMonth: '', rows: [], totalCents: 0, prevTotalCents: 0 },
            'finance.goalRows': [], 'finance.recurringRows': [],
            'finance.detectSubscriptions': [], 'finance.search': [],
            'finance.insights': {
              month: '2026-11', savingBp: 0, incomeDeltaBp: 0, expenseDeltaBp: 0,
              netWorthCents: 0, assetsCents: 0, liabilitiesCents: 0,
              overspent: [], biggest: null, subscriptionCents: 0, subscriptionCount: 0,
              topCategory: null, budgetUsedBp: 0, ruleHit: 0, imported: 0
            },
            // V3.1 联动样例：账本窗在没有 preload 的冒烟环境里也能渲染两块新 UI
            'finance.moneyRows': {
              rows: [{ id: 'm1', date: '2026-11-03', type: 'expense', cents: 1250,
                       category: 'food', note: '午饭', importedId: 'mb:2026-11-03:m1', imported: false }],
              pending: 1
            },
            'finance.importMoneyRows': { added: 1, skipped: 0 },
            'dream.board': {
              rows: [{ id: 'd1', title: '去一趟敦煌', fund: { target: 500000, saved: 120000, pct: 24, ready: false } }],
              alerts: []
            }
          };
          // 首页天气：dev / 无 Electron 环境给一份固定样例（不联网、不含任何远程地址）。
          // 只用于让界面在 vite 里能看，不代表真实天气。
          const mockWeather = {
            enabled: true,
            mode: 'auto',
            city: '',
            place: null,
            unit: 'c',
            report: {
              place: { label: '上海', region: '上海市' },
              now: { temp: 12, feels: 10, humidity: 65, wind: 3, isDay: true, code: 0, text: '晴', icon: '☀', group: 'sun', baseWeather: '晴' },
              today: { max: 17, min: 6, rainProb: 0 },
              fetchedAt: 0
            },
            fetchedAt: 0,
            stale: true,
            error: { at: 0, code: 'MOCK', msg: '开发模式：这是样例天气' }
          };
          mockDefaults['weather.view'] = mockWeather;
          mockDefaults['weather.setEnabled'] = mockWeather;
          mockDefaults['weather.setMode'] = mockWeather;
          mockDefaults['weather.setCity'] = mockWeather;
          mockDefaults['weather.clearCity'] = mockWeather;
          mockDefaults['weather.setUnit'] = mockWeather;

          if (name === 'inspire.list') {
            const k = String((Array.isArray(q.args) ? q.args[0] : '') || 'quotes');
            const sample = k === 'quotes'
              ? [{ id: 'q-0', text: '今天也值得被记录。', author: '九格手记', period: 'any', periodLabel: '', day: -1, dayLabel: '', builtin: true, custom: false, enabled: true, hidden: false, overridden: false, updatedAt: 0 }]
              : [{ id: 'g-any-1', text: '慢慢来，比较快。', author: '', period: 'any', periodLabel: '任何时段', day: -1, dayLabel: '', builtin: true, custom: false, enabled: true, hidden: false, overridden: false, updatedAt: 0 }];
            const one = { builtin: sample.length, custom: 0, total: sample.length, enabled: sample.length, hidden: 0, overridden: 0 };
            data = { kind: k, label: '', items: sample, stats: one };
          } else if (name.indexOf('export') === 0) {
            data = { data: JSON.stringify({ app: 'jiuge-notes', version: 7, records: [] }), error: null };
          } else if (name === 'importBackup') {
            data = { data: { imported: 0, skipped: 0, emptyShell: 0, partial: false, sourceVersion: 7 }, error: null };
          } else if (Object.prototype.hasOwnProperty.call(mockDefaults, name)) {
            data = mockDefaults[name];
          } else if (/^(save|set|open|reset|import)/.test(name)) {
            data = { data: { ok: true }, error: null };
          } else if (/^(list|written|all|search|reviewPrompts|workTagPool|promptFor|previousToday|sameDayAcrossYears|loadReview|dueCapsules|listCapsules)/.test(name)) {
            data = { data: [], error: null };
          } else {
            data = null;
          }
          break;
        }
        default:
          return { code: 'CLIENT_EXCEPTION', message: '未知通道: ' + channel, data: null as T };
      }
      return ok(data as T);
    },
    onDataChanged(cb: (event: DataChangedEvent) => void) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }
  };
}

export const isMockBridge = typeof window === 'undefined' || !window.jiugeBridge;
export const bridge: PreloadBridge = isMockBridge ? createMemoryBridge() : window.jiugeBridge!;

async function call<T>(channel: string, payload: unknown = {}): Promise<T> {
  // IPC 结构化克隆不接受 Vue reactive Proxy / 函数；出境前统一转成纯数据
  const safe = payload === undefined ? {} : JSON.parse(JSON.stringify(payload));
  const res = await bridge.invoke<T>(channel, safe);
  if (!res || res.code !== 'OK') {
    throw new Error((res && res.message) || channel + ' 调用失败');
  }
  return res.data;
}

export function listDiaries(params: { cursor?: string | null; pageSize?: number } = {}) {
  return call<ListResult<DiaryRecord>>('v1/diaries:list', params);
}

export function getBatch(dates: string[]) {
  return call<{ records: Record<string, DiaryRecord> }>('v1/diaries:getBatch', { dates });
}

export function upsertDiary(record: DiaryRecord, requestId?: string) {
  return call<{ record: DiaryRecord; revision: number; changedKeys: string[]; fsync: boolean }>(
    'v1/diaries:upsert', { record, requestId }
  );
}

export function getConfig(keys: string[]) {
  return call<{ values: Record<string, unknown> }>('v1/config:getMany', { keys });
}

export function setConfig(patch: Record<string, unknown>, requestId?: string) {
  return call<{ revision: number; changedKeys: string[] }>('v1/config:setMany', { patch, requestId });
}

export function flush(reason: string) {
  return call<{ flushed: boolean; reason: string }>('v1/app:flush', { reason });
}

export function lockState() {
  return call<{ revision: number; dirty: boolean; keys: number }>('v1/system:lockState');
}

export function onDataChanged(cb: (event: DataChangedEvent) => void) {
  return bridge.onDataChanged(cb);
}

// 全局热键 / 托盘速记（R-09）：返回解绑函数，用法与 onDataChanged 一致。
// mock 环境下没有主进程推送，返回一个空解绑，界面照常可用。
export function onQuickCapture(cb: (payload: { date: string; source: string }) => void): () => void {
  if (typeof bridge.onQuickCapture === 'function') return bridge.onQuickCapture(cb);
  return () => {};
}

// 领域层白名单调用：8 utils 的 68 个能力统一从这里出境
export function domainCall<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  return call<T>('v1/domain:call', { name, args });
}

// 数据健康中心：主进程把 persistence 里早已实现、此前从未被调用的能力翻译成可读状态
export interface HealthReport {
  checkedAt: number;
  boot: { replayed: number; loadedKeys: number; revision: number; lastExitClean: boolean; sweptAtBoot: number };
  store: { bytes: number; mtime: string; count: number };
  bak: { exists: boolean; bytes: number; mtime: string; count: number; behind: number };
  snapshots: {
    count: number;
    latest: { id: string; createdAt: string } | null;
    entries: Array<{ id: string; createdAt: string; auto: boolean }>;
  };
  data: { diaries: number; keys: number; sealed: number; sealedSoonest: number | null; gtdOpen: number; capsules: number };
  migration: { done: boolean; manifestAt: string };
  autoBackup: { enabled: boolean; intervalMinutes: number; kept: number; lastAt: number; lastId: string };
}

export function healthCheck() {
  return call<HealthReport>('v1/health:check', {});
}

export function runBackup() {
  return call<{ ok: boolean; id?: string; error?: string }>('v1/health:backup', {});
}

// ---- 可回滚版本（R-10）----
// 术语按 D8：这是「可回滚版本」，与数据中心的「导出记录」、健康卡里的「数据快照数量」不是一回事。
export interface RestorableVersion {
  id: string;
  createdAt: string;
  bytes: number;
  count: number;
  auto: boolean;
  reason: string;
}
export interface RestoreResult {
  ok: boolean;
  restored?: string;
  safetyId?: string;
  before?: { diaries: number; keys: number; revision: number };
  after?: { diaries: number; keys: number; revision: number };
  code?: string;
  message?: string;
}

export function listRestorable(): Promise<RestorableVersion[]> {
  return call<{ items: RestorableVersion[] }>('v1/snapshot:list', {}).then((r) => (r && r.items) || []);
}

// 回滚直接用 invoke 而不是 call：call 在非 OK 时会抛错，把 code/message 丢掉，
// 而回滚失败的原因（找不到 / 文件读不出来 / 留不了安全版本）必须原样告诉用户。
export function restoreVersion(id: string): Promise<RestoreResult> {
  return bridge.invoke<RestoreResult>('v1/snapshot:restore', { id })
    .then((r) => r.data || { ok: false, code: r.code, message: r.message });
}

// ---- 使用度量（R-11）----
// 只读汇总：算不出来的指标一律返回 null，界面上写「尚无可判定样本」，不编数字。
export interface MetricsSummary {
  ok: boolean;
  enabled: boolean;
  file: string;
  sampleSize: number;
  firstDay: string | null;
  metrics: {
    weekActiveDays: number;
    nextDayRetention: number | null;
    week4Retention: number | null;
    migrateRate: number | null;
    searchUsageRate: number | null;
    saveLatencyP50: number | null;
    saveLatencyP95: number | null;
  };
  counts: {
    appStart: number; entrySave: number; saveEvents: number;
    searchUse: number; migrateStart: number; migrateSuccess: number;
  };
  // V3.8 成效侧：完成 / 目标推进 / 阅读推进 / 复盘落成的次数。
  // available=false 表示还没有任何成效事件，界面要说「还没有」，不能摆一排 0。
  outcome: {
    available: boolean;
    events: number;
    window7: OutcomeBucket;
    window30: OutcomeBucket;
    total: OutcomeBucket;
  };
}

export interface OutcomeBucket {
  taskDone: number; dreamMove: number; readMove: number; review: number;
}

export function metricsSummary(): Promise<MetricsSummary | null> {
  return call<MetricsSummary>('v1/metrics:summary', {}).then((r) => r || null);
}

export function setMetricsEnabled(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> {
  return call<{ ok: boolean; enabled: boolean }>('v1/metrics:setEnabled', { enabled })
    .then((r) => r || { ok: false, enabled: false });
}

// ---- 快速记录（R-09）：托盘菜单 / 窗口未就绪补发都走这条 ----
export function triggerQuickCapture(source = 'ui'): Promise<{ ok: boolean; queued: boolean; date?: string }> {
  return call<{ ok: boolean; queued: boolean; date?: string }>('v1/quickcapture:trigger', { source })
    .then((r) => r || { ok: false, queued: false });
}

export interface SaveReceipt { canceled: boolean; path?: string; bytes?: number }
export function saveExport(name: string, text: string) {
  return call<SaveReceipt>('v1/file:save', { name, text });
}

// 本地电子书：点击选择走主进程原生对话框；拖放只把 File 换成路径字符串。
// 两条路都只回传路径，文件内容一律不进渲染层。
export interface PickResult { canceled: boolean; paths: string[] }
export interface ReaderReceipt { ok: boolean; reused?: boolean; reason?: string }
// 独立阅读窗口：目录 / 正文 / 笔记三栏。渲染层只说「开哪本书」，不碰窗口句柄。
export function openReader(bookId: string, mode: 'leisure' | 'theme' = 'leisure'): Promise<ReaderReceipt> {
  return bridge.invoke<ReaderReceipt>('v1/reader:open', { bookId, mode })
    .then((r) => r.data || { ok: false, reason: r.message });
}

// 豆瓣封面（V3.13）：两条会联网的通道，与天气同一类，所以不走 domainCall。
// 「没搜到」是正常结果（ok:true, items:[]），不是错误——所以这里只做透传，不改写 ok。
export interface DoubanCover {
  title: string; author: string; year: string;
  picHost: string; picPath: string; thumb: string;
}
export interface DoubanCoverResult {
  ok: boolean; items: DoubanCover[]; keyword?: string;
  reason?: string; empty?: boolean;
}
export function doubanCovers(bookId: string): Promise<DoubanCoverResult> {
  return bridge.invoke<DoubanCoverResult>('v1/reading:doubanCovers', { args: [bookId] })
    .then((r) => r.data || { ok: false, items: [], reason: r.message || '豆瓣没搜到' });
}
export function doubanApply(bookId: string, picHost: string, picPath: string): Promise<{ ok: boolean; reason?: string; bytes?: number }> {
  return bridge.invoke<{ ok: boolean; reason?: string; bytes?: number }>(
    'v1/reading:doubanApply', { args: [bookId, picHost, picPath] }
  ).then((r) => r.data || { ok: false, reason: r.message || '封面没取到' });
}

// 独立账本窗口（左中右三栏）：主窗顶栏只说「开账本」，窗口句柄不进渲染层。
export function openFinance(): Promise<{ ok: boolean; reused?: boolean; reason?: string }> {
  return bridge.invoke<{ ok: boolean; reused?: boolean; reason?: string }>('v1/finance:open', {})
    .then((r) => r.data || { ok: false, reason: r.message });
}

// 独立图书馆窗口（文件夹树 / 书架 / 详情三栏）：与账本同一形态，主窗只负责开窗。
export function openLibrary(): Promise<{ ok: boolean; reused?: boolean; reason?: string }> {
  return bridge.invoke<{ ok: boolean; reused?: boolean; reason?: string }>('v1/library:open', {})
    .then((r) => r.data || { ok: false, reason: r.message });
}

export function pickBookFiles(): Promise<PickResult> {
  return call<PickResult>('v1/file:pick', {});
}
// 梦想的具象化图片：同一个选择通道，靠 kind 换过滤器。
// 选完只回路径，复制进数据目录与命名都由主进程做（渲染层没有 fs）。
export function pickImageFile(): Promise<PickResult> {
  return call<PickResult>('v1/file:pick', { kind: 'image' });
}
export function pathForFile(file: File): string {
  try { return bridge.pathForFile(file) || ''; } catch { return ''; }
}

// 本机时间源（md_worktime）：只读订阅 ActivityWatch。
// 唯一一条会发 HTTP 的通道，所以单独开；渲染层仍然只说「同步哪一天」。
export interface WorktimeDay {
  activeSec: number;
  windowSec: number;
  afkSec: number;
  unclassifiedRatio: number;
  apps: Array<[string, number]>;
  rules: Array<[string, number]>;
  // [起, 止, 规则id, 应用名]，起止为相对当天 0 点的分钟
  blocks: Array<[number, number, string, string]>;
  written: string[];
  syncedAt: number;
}
export interface WorktimeRule {
  id: string;
  order: number;
  app: string;
  titleMatch: string;
  label: string;
  enabled: boolean;
  target: { cell: string; projectId: string; context: string };
}
export interface WorktimeView {
  enabled: boolean;
  host: string;
  keepDays: number;
  rules: WorktimeRule[];
  day: WorktimeDay | null;
  error: { at: number; code: string; msg: string } | null;
}
export interface WorktimeMeta {
  enabled: boolean;
  host: string;
  hasToken: boolean;
  keepDays: number;
  ruleCount: number;
  dayCount: number;
  lastDate: string;
  lastSync: number;
  bytes: number;
}
export interface WorktimeSyncReport {
  ok: boolean;
  date?: string;
  code?: string;
  msg?: string;
  partial?: boolean;
  hostname?: string;
  version?: string;
  day?: WorktimeDay | null;
}
export function worktimeSync(date: string): Promise<WorktimeSyncReport> {
  return bridge.invoke<WorktimeSyncReport>('v1/worktime:sync', { date })
    .then((r) => r.data || { ok: false, code: r.code, msg: r.message });
}

// ---- 首页天气与位置（md_weather）----
// 渲染层只说「取一次天气 / 查一个城市」；域名、超时、体积上限、User-Agent 全在主进程。
// 这里刻意不出现任何远程地址——视图层源码里出现 URL 就该被门禁拦下。
export interface WeatherNow {
  temp: number | null;
  feels: number | null;
  humidity: number | null;
  wind: number | null;
  isDay: boolean;
  code: number;
  text: string;
  icon: string;
  group: string;
  // 领域层折算好的九格 8 档天气（晴/多云/阴/小雨/大雨/雪/风/雾）；空串 = 认不出，需手填。
  // 渲染层不自己映射 WMO 代码：映射只有一份，放在 src/weather/board.js。
  baseWeather: string;
}
export interface WeatherReport {
  place: { label: string; region: string };
  now: WeatherNow;
  today: { max: number | null; min: number | null; rainProb: number | null };
  fetchedAt: number;
}
export interface WeatherView {
  enabled: boolean;
  mode: 'auto' | 'city';
  city: string;
  place: { lat: number; lon: number; label: string; region: string } | null;
  unit: 'c' | 'f';
  report: WeatherReport | null;
  fetchedAt: number;
  stale: boolean;
  error: { at: number; code: string; msg: string } | null;
}
export interface WeatherSyncReport {
  ok: boolean;
  cached?: boolean;
  code?: string;
  msg?: string;
  view?: WeatherView;
}
export interface WeatherGeocodeReport {
  ok: boolean;
  code?: string;
  msg?: string;
  place?: { lat: number; lon: number; label: string; region: string };
  view?: WeatherView;
}
export function weatherView(): Promise<WeatherView> {
  return domainCall<WeatherView>('weather.view');
}
export function weatherSync(force = false): Promise<WeatherSyncReport> {
  return bridge.invoke<WeatherSyncReport>('v1/weather:sync', { args: [force] })
    .then((r) => r.data || { ok: false, code: r.code, msg: r.message });
}
export function weatherSetEnabled(on: boolean): Promise<WeatherView> {
  return domainCall<WeatherView>('weather.setEnabled', on);
}
export function weatherSetMode(mode: 'auto' | 'city'): Promise<WeatherView> {
  return domainCall<WeatherView>('weather.setMode', mode);
}
export function weatherSetCity(city: string): Promise<WeatherGeocodeReport> {
  return bridge.invoke<WeatherGeocodeReport>('v1/weather:geocode', { args: [city] })
    .then((r) => r.data || { ok: false, code: r.code, msg: r.message });
}
export function weatherClearCity(): Promise<WeatherView> {
  return domainCall<WeatherView>('weather.clearCity');
}
