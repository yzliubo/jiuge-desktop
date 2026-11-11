'use strict';
/**
 * 窗口尺寸 / 位置记忆：window-state.json。
 *
 * 命名空间纪律（架构 §3.1 / §3.4 / §9.3）：这个文件与 store.json.bak、
 * store.pre-import-*.json 一样**独立于 KV 空间**，从不写进 KvStore 的 Map，
 * 因此绝不会出现在 kv:keys() 里污染 listDates() 的 morning_diary_ 前缀扫描。
 *
 * 校验：bounds 必须落在某块显示器的工作区内（多显示器 / 分辨率变更后窗口开在屏外时回落默认）。
 * 本模块在非 Electron 环境（tools/*.js 纯 Node）下会跳过显示器校验，仍可读写与解析。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_BOUNDS = { width: 1280, height: 800 };
const MIN_WIDTH = 1024;
const MIN_HEIGHT = 680;
const SAVE_DEBOUNCE_MS = 200;

function statePath(dataDir) {
  return path.join(String(dataDir || ''), 'window-state.json');
}

/** 惰性取 electron.screen；纯 Node 环境返回 null。 */
function getScreen() {
  try {
    const electron = require('electron');
    return electron && electron.screen ? electron.screen : null;
  } catch (e) {
    return null;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sanitize(bounds) {
  const out = { width: DEFAULT_BOUNDS.width, height: DEFAULT_BOUNDS.height };
  if (!isPlainObject(bounds)) return out;
  const w = Math.floor(Number(bounds.width));
  const h = Math.floor(Number(bounds.height));
  if (isFinite(w) && w >= MIN_WIDTH) out.width = w;
  if (isFinite(h) && h >= MIN_HEIGHT) out.height = h;
  if (isFinite(Number(bounds.x))) out.x = Math.floor(Number(bounds.x));
  if (isFinite(Number(bounds.y))) out.y = Math.floor(Number(bounds.y));
  return out;
}

/** bounds 是否至少与某块显示器工作区相交；无 screen 模块时只做尺寸校验。 */
function visibleOnDisplay(bounds) {
  if (bounds.x === undefined || bounds.y === undefined) return true;
  const screen = getScreen();
  if (!screen || typeof screen.getAllDisplays !== 'function') return true;
  try {
    const displays = screen.getAllDisplays() || [];
    if (!displays.length) return true;
    return displays.some((d) => {
      const a = d.workArea || d.bounds;
      if (!a) return false;
      const overlapX = bounds.x < a.x + a.width && bounds.x + bounds.width > a.x;
      const overlapY = bounds.y < a.y + a.height && bounds.y + bounds.height > a.y;
      return overlapX && overlapY;
    });
  } catch (e) {
    return true;
  }
}

class WindowState {
  /** @param {string} dataDir 与 KV 相同的数据目录（但文件独立） */
  constructor(dataDir) {
    this.dataDir = String(dataDir || '');
    this.filePath = statePath(this.dataDir);
    this.timer = null;
  }

  /** @returns {{width:number,height:number,x?:number,y?:number}} */
  read() {
    let parsed = null;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    } catch (e) {
      return Object.assign({}, DEFAULT_BOUNDS);
    }
    const clean = sanitize(parsed);
    if (!visibleOnDisplay(clean)) {
      // 分辨率 / 显示器变更后窗口可能落在屏外：丢弃 x/y，只保留尺寸
      return { width: clean.width, height: clean.height };
    }
    return clean;
  }

  /** 直接写盘（退出前调用，保证不丢）。 */
  writeNow(bounds) {
    const clean = sanitize(bounds);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(clean), { encoding: 'utf8', flag: 'w' });
      fs.renameSync(tmp, this.filePath);
      return { ok: true, bounds: clean };
    } catch (e) {
      return { ok: false, error: 'CLIENT_EXCEPTION', message: String(e && e.message || e) };
    }
  }

  /** resized / moved 事件的防抖保存，避免拖动时每帧写盘。 */
  scheduleWrite(bounds) {
    const clean = sanitize(bounds);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow(clean);
    }, SAVE_DEBOUNCE_MS);
    return { ok: true };
  }

  /** 该文件绝不参与 KV 空间，仅用于展示数据目录时核对。 */
  pathOf() {
    return this.filePath;
  }

  dispose() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  WindowState: WindowState,
  DEFAULT_BOUNDS: DEFAULT_BOUNDS,
  MIN_WIDTH: MIN_WIDTH,
  MIN_HEIGHT: MIN_HEIGHT,
  statePath: statePath,
  sanitize: sanitize,
  visibleOnDisplay: visibleOnDisplay,
};
