'use strict';
// 出图 + 自检（非门禁）：看 V2.14 主题阅读自建书单的实际样子。
// 用法：env -u ELECTRON_RUN_AS_NODE node tests/e2e/shot-theme-visual.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const outDir = path.join(root, 'build-v2');
const userData = path.join(os.tmpdir(), 'jiuge-shot-theme-' + Date.now());
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  let app = null;
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.locator('.reading-btn').click();
    await page.waitForSelector('.rd-view', { timeout: 8000 });

    // 建两个主题，各放几本书（手工书名，走领域层真写口）
    async function addTheme(title, note) {
      await page.locator('.rd-tab').nth(1).click();
      await page.locator('.rd-add input[aria-label="新主题名"]').fill(title);
      await page.locator('.rd-add input[aria-label="主题说明"]').fill(note);
      await page.locator('.rd-add button', { hasText: '建主题' }).first().click();
      await page.waitForTimeout(300);
    }
    await addTheme('污水处理工艺', '从格栅到二沉池，把主流工艺吃透');
    // 第一个主题加 3 本书
    for (const t of ['活性污泥法原理', 'A²/O 工艺设计', 'MBR 膜生物反应器']) {
      await page.locator('.rd-group input[aria-label="主题新书名"]').first().fill(t);
      await page.locator('.rd-group button', { hasText: '加书名' }).first().click();
      await page.waitForTimeout(200);
    }
    await addTheme('给排水管网', '雨水与污水管网的水力计算');
    await page.locator('.rd-group input[aria-label="主题新书名"]').last().fill('室外排水设计标准');
    await page.locator('.rd-group button', { hasText: '加书名' }).last().click();
    await page.waitForTimeout(400);

    // ① 主题列表视角
    await page.screenshot({ path: path.join(outDir, 'shot-theme-1-list.png') });
    // ② 翻开一本书，看批注器与休闲同款
    await page.locator('.rd-group .rd-book').first().locator('button', { hasText: '翻开读' }).click();
    await page.waitForSelector('.rd-reader[aria-label="主题阅读器"] .rd-prompts', { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'shot-theme-2-reader.png') });

    // 自检：主题 2 个、书 4 本、批注器章节大纲存在
    const groups = await page.locator('.rd-group').count();
    const books = await page.locator('.rd-group .rd-book').count();
    const prompts = await page.locator('.rd-reader[aria-label="主题阅读器"] .rd-prompt').count();
    const chapters = await page.locator('.rd-reader[aria-label="主题阅读器"] .rd-chapters').count();
    console.log('VISUAL_CHECK groups=' + groups + ' books=' + books + ' prompts=' + prompts + ' chapters=' + chapters);
    if (groups < 2 || books < 4 || prompts < 3 || chapters < 1) {
      throw new Error('视觉自检不通过');
    }
    console.log('VISUAL_CHECK: PASS');
  } finally {
    if (app) await app.close();
  }
})().catch(function (e) {
  console.error('VISUAL_CHECK: FAIL', e && e.stack || e);
  process.exit(1);
});
