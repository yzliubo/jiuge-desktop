// 农历换算（2026-11-16）：纯函数、零依赖，1900–2049 年有效。
// 为什么自己写：工程既有口径是「农历节日不做近似推算」，不引第三方库、不碰 WAL；
// 家庭成员的农历生日只在右栏算「下一次是哪天」，表里查不到就明确返回 null，绝不猜一个日期。
// 表来自通用农历编码：低 4 位=闰月号，0x10000=闰大月，0x8000..0x10 依次为正月..腊月大小月。

var BASE_UTC = Date.UTC(1900, 0, 31); // 1900 年正月初一
var DAY_MS = 86400000;

var LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5d0, 0x14573, 0x052d0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b5a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0  // 2040-2049
];

var MIN_YEAR = 1900;
var MAX_YEAR = MIN_YEAR + LUNAR_INFO.length - 1;

function supported(y) {
  return Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;
}

function info(y) {
  if (!supported(y)) return 0;
  return LUNAR_INFO[y - MIN_YEAR];
}

function leapMonth(y) { return info(y) & 0xf; }
function leapDays(y) { return leapMonth(y) ? ((info(y) & 0x10000) ? 30 : 29) : 0; }
function monthDays(y, m) {
  if (!supported(y) || m < 1 || m > 12) return 0;
  return (info(y) & (0x10000 >> m)) ? 30 : 29;
}
function yearDays(y) {
  if (!supported(y)) return 0;
  var v = info(y);
  var sum = 348;
  for (var bit = 0x8000; bit > 0x8; bit >>= 1) sum += (v & bit) ? 1 : 0;
  return sum + leapDays(y);
}

function solarToLunar(y, m, d) {
  if (!supported(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  var target = Date.UTC(y, m - 1, d);
  if (new Date(target).getUTCMonth() !== m - 1) return null;
  var diff = Math.floor((target - BASE_UTC) / DAY_MS);
  if (diff < 0) return null;
  var ly = MIN_YEAR;
  while (ly <= MAX_YEAR && diff >= yearDays(ly)) { diff -= yearDays(ly); ly += 1; }
  if (ly > MAX_YEAR) return null;
  var leap = leapMonth(ly);
  var lm = 1;
  while (lm <= 12) {
    var md = monthDays(ly, lm);
    if (diff < md) return { year: ly, month: lm, day: diff + 1, leap: false };
    diff -= md;
    if (leap === lm) {
      var ld = leapDays(ly);
      if (diff < ld) return { year: ly, month: lm, day: diff + 1, leap: true };
      diff -= ld;
    }
    lm += 1;
  }
  return null;
}

function lunarToSolar(y, m, d, isLeap) {
  if (!supported(y) || m < 1 || m > 12) return null;
  var leap = leapMonth(y);
  var wantLeap = !!isLeap;
  if (wantLeap && leap !== m) return null;
  var max = wantLeap ? leapDays(y) : monthDays(y, m);
  if (!Number.isInteger(d) || d < 1 || d > max) return null;
  var diff = 0;
  for (var yy = MIN_YEAR; yy < y; yy += 1) diff += yearDays(yy);
  for (var mm = 1; mm < m; mm += 1) {
    diff += monthDays(y, mm);
    if (leap === mm) diff += leapDays(y);
  }
  if (wantLeap) diff += monthDays(y, m);
  diff += d - 1;
  var ts = BASE_UTC + diff * DAY_MS;
  var dt = new Date(ts);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

// 某一年过不过这个闰月：不过就退回同月普通月，并告诉调用方换过了。
function resolveLunar(y, m, d, isLeap) {
  if (isLeap && leapMonth(y) !== m) return { date: lunarToSolar(y, m, d, false), shifted: true };
  return { date: lunarToSolar(y, m, d, isLeap), shifted: false };
}

module.exports = {
  MIN_YEAR: MIN_YEAR,
  MAX_YEAR: MAX_YEAR,
  supported: supported,
  leapMonth: leapMonth,
  monthDays: monthDays,
  solarToLunar: solarToLunar,
  lunarToSolar: lunarToSolar,
  resolveLunar: resolveLunar
};
