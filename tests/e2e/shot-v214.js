'use strict';
// 临时取证脚本：V2.14「联网天气 ↔ 今天概况」实机截图 + 文本证据。跑完即删。
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = process.argv[2] || path.join(root, '..', 'jiuge-redesign', '_shots-首页天气');
const userData = path.join(__dirname, '.shot-v214-' + Date.now());

delete process.env.ELECTRON_RUN_AS_NODE;

async function text(page, sel) {
  const el = page.locator(sel).first();
  if (!(await el.count())) return '(无)';
  return String((await el.textContent()) || '').replace(/\s+/g, ' ').trim();
}

(async function main() {
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  let app = null;
  try {
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, {
        JIUGE_V2_USERDATA: userData,
        JIUGE_V2_PROBE: '1'
      }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    // 等天气 sync 回来（真联网，30 分钟缓存首次必取）
    await page.waitForTimeout(6500);

    console.log('天气条        : ' + await text(page, '.weather .wx-btn'));
    console.log('天气来源提示  : ' + await text(page, '.today-opt .extras .hint'));
    console.log('今日状态标签  : ' + await text(page, '.today-opt .base-grid .field'));
    console.log('天气下拉当前  : ' + await page.locator('.today-opt .base-grid select').first().inputValue());
    console.log('今天概览 chip : ' + await text(page, '.ctx-card .chip'));

    await page.screenshot({ path: path.join(outDir, 'V214-整窗-天气与今天概览.png'), fullPage: false });
    const ctx = page.locator('.context').first();
    if (await ctx.count()) {
      await ctx.screenshot({ path: path.join(outDir, 'V214-右栏-今天概览与今日状态.png') });
    }
    // 浮层：点开天气条看「记进今天」
    const btn = page.locator('.weather .wx-btn').first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(350);
      console.log('浮层保存行    : ' + await text(page, '.wx-save-row'));
      await page.screenshot({ path: path.join(outDir, 'V214-天气浮层-记进今天.png'), fullPage: false });
    }
    console.log('截图目录      : ' + outDir);
  } finally {
    if (app) await app.close().catch(function () {});
  }
})().catch(function (e) {
  console.error('SHOT_FAIL ' + (e && e.stack || e));
  process.exitCode = 1;
});
