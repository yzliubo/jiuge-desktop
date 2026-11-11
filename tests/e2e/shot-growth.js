'use strict';
// 学习成长排版截图：三个 tab + 右栏三套详情。仅人眼复核，不进 git 断言。
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const userData = 'G:/workbuddy/tmp-build/shot-growth-userdata';

delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(800);

  await page.locator('.cell[data-cell="growth"] .cell-label').dblclick();
  await page.waitForTimeout(600);

  // 考试
  await page.locator('.add-row input[aria-label="考试名称"]').fill('一级建造师 · 市政');
  await page.locator('.add-row input[aria-label="考试日期"]').fill('2026-12-20');
  await page.getByRole('button', { name: '加一场考试' }).click();
  await page.waitForTimeout(500);
  await page.locator('.rows .g-row').first().locator('.g-title').click();
  await page.waitForTimeout(300);
  await page.locator('.context input[aria-label="新科目"]').fill('市政实务');
  await page.locator('.context input[aria-label="总章数"]').fill('40');
  await page.getByRole('button', { name: '加科目' }).click();
  await page.waitForTimeout(400);
  await page.locator('.context input[aria-label="新科目"]').fill('项目管理');
  await page.locator('.context input[aria-label="总章数"]').fill('20');
  await page.getByRole('button', { name: '加科目' }).click();
  await page.waitForTimeout(400);
  await page.locator('.context .gc-item .gc-mini').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(root, 'build-v2/shot-growth-1.png') });
  await page.locator('.center').screenshot({ path: path.join(root, 'build-v2/shot-growth-exam.png') });
  await page.locator('.context').screenshot({ path: path.join(root, 'build-v2/shot-growth-exam-rail.png') });

  // 技能
  await page.locator('.g-tab').nth(1).click();
  await page.waitForTimeout(300);
  await page.locator('.add-row input[aria-label="技能名称"]').fill('Python 数据处理');
  await page.getByRole('button', { name: '加一项技能' }).click();
  await page.waitForTimeout(450);
  await page.locator('.rows .g-row').first().locator('.g-title').click();
  await page.waitForTimeout(300);
  await page.locator('.context input[aria-label="新里程碑"]').fill('能独立写爬虫');
  await page.getByRole('button', { name: '加', exact: true }).click();
  await page.waitForTimeout(350);
  await page.locator('.context input[aria-label="新里程碑"]').fill('能读别人的项目');
  await page.getByRole('button', { name: '加', exact: true }).click();
  await page.waitForTimeout(350);
  await page.locator('.context .gc-check').first().click();
  await page.waitForTimeout(350);
  await page.locator('.rows .g-row').first().locator('.g-quick').click();
  await page.waitForTimeout(450);
  await page.locator('.center').screenshot({ path: path.join(root, 'build-v2/shot-growth-skill.png') });
  await page.locator('.context').screenshot({ path: path.join(root, 'build-v2/shot-growth-skill-rail.png') });

  // 阅读
  await page.locator('.g-tab').nth(2).click();
  await page.waitForTimeout(300);
  await page.locator('.add-row input[aria-label="阅读主题"]').fill('给排水规范');
  await page.getByRole('button', { name: '开一个主题' }).click();
  await page.waitForTimeout(450);
  await page.locator('.rows .g-row').first().locator('.g-title').click();
  await page.waitForTimeout(300);
  await page.locator('.context input[aria-label="书名"]').fill('室外排水设计标准');
  await page.locator('.context input[aria-label="页数"]').fill('200');
  await page.getByRole('button', { name: '加书' }).click();
  await page.waitForTimeout(400);
  await page.locator('.context .gc-book .gc-mini').first().click();
  await page.waitForTimeout(400);
  await page.locator('.context input[aria-label="摘录内容"]').fill('雨水管渠设计重现期应按当地规定执行，并与排水体制相匹配');
  await page.locator('.context input[aria-label="页码"]').fill('12');
  await page.getByRole('button', { name: '存摘录' }).click();
  await page.waitForTimeout(450);
  await page.locator('.center').screenshot({ path: path.join(root, 'build-v2/shot-growth-read.png') });
  await page.locator('.context').screenshot({ path: path.join(root, 'build-v2/shot-growth-read-rail.png') });

  console.log('shot ok');
  await app.close();
})().catch(function (e) {
  console.error('shot failed', e && e.message);
  process.exitCode = 1;
});
