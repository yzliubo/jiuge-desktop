import { domainCall } from '../bridge';

// diary-store 的导出有两种返回形态：裸值 或 ok({data,error})；统一解包并降级
export function unwrap<T>(res: unknown, fallback: T): T {
  if (res && typeof res === 'object') {
    const o = res as { data?: unknown; error?: unknown };
    if ('data' in o && 'error' in o) {
      if (!o.error && o.data !== undefined && o.data !== null) return o.data as T;
      return fallback;
    }
  }
  if (res === null || res === undefined) return fallback;
  return res as T;
}

export async function callDomain<T>(name: string, fallback: T, ...args: unknown[]): Promise<T> {
  try {
    return unwrap<T>(await domainCall<unknown>(name, ...args), fallback);
  } catch {
    return fallback;
  }
}

// 需要区分业务错误码（DATE_NOT_FUTURE / INVALID_JSON 等）时不能走降级解包，
// 否则 error 会被吞成一个 null，界面会误报成功。
export interface DomainResult<T> {
  data: T | null;
  error: string | null;
}

export async function callDomainRaw<T>(name: string, ...args: unknown[]): Promise<DomainResult<T>> {
  try {
    const raw = await domainCall<unknown>(name, ...args);
    if (raw && typeof raw === 'object') {
      const o = raw as { data?: unknown; error?: unknown };
      if ('data' in o && 'error' in o) {
        return {
          data: (o.error ? null : (o.data as T)) ?? null,
          error: o.error ? String(o.error) : null
        };
      }
    }
    return { data: (raw as T) ?? null, error: null };
  } catch (e) {
    return { data: null, error: (e as Error).message || 'CLIENT_EXCEPTION' };
  }
}

// 8 utils 的汇总函数返回形态不统一：数组 / {items} / {rows} / {phrases} / {reflections}。
// 统一抽成数组，避免视图层对 .slice() 直接调用而炸页。
export function asArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== 'object') return [];
  const o = value as Record<string, unknown>;
  const keys = ['items', 'rows', 'phrases', 'reflections', 'entries', 'list', 'hits', 'dates'];
  for (let i = 0; i < keys.length; i++) {
    if (Array.isArray(o[keys[i]])) return o[keys[i]] as T[];
  }
  return [];
}
