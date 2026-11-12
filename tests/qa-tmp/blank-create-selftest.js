'use strict';
// 临时自测（不进门禁计数）：真实 Electron 窗口里验证「任务区空白处就地新建」。
// 覆盖：双击 / 右击 / ＋ 三个入口、归属继承、日程与等待的条件字段、
//       不经过收件箱、已完成组不新建、项目卡片不再显示「N 个下一步」。
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
// playwright 只装在 tests/e2e/node_modules（gui-assert 同款），qa-tmp 目录解析不到，走相对路径
const { _electron: electron } = require('../e2e/node_modules/playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-blank-'));
delete process.env.ELECTRON_RUN_AS_NODE;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name: name, ok: true });
    console.log('PASS  ' + name);
  } catch (e) {
    const msg = String((e && e.message) || e);
    results.push({ name: name, ok: false, err: msg });
    console.log('FAIL  ' + name + ' :: ' + msg);
  }
}

(async function main() {
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
    const jsErrors = [];
    page.on('pageerror', function (e) { jsErrors.push(String((e && e.message) || e)); });
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(400);

    // 进「工作 · GTD 工作台」
    await page.locator('.nav-item').first().click();
    await page.waitForTimeout(250);
    await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
    await page.waitForSelector('.gtd-view', { timeout: 10000 });

    await check('01 空白处有可发现提示（双击/右击/＋ 新建）', async () => {
      assert.strictEqual(await page.locator('.gtd-blank-hint').count(), 1);
      const t = await page.locator('.gtd-blank-hint').textContent();
      assert(t.includes('双击') && t.includes('右击'), '提示没写清两种操作：' + t);
      assert.strictEqual(await page.locator('.gtd-blank-hint-btn').count(), 1, '缺键盘可达的 ＋ 新建');
    });

    await check('02 双击空白 → 在「收件箱」里出现新建条并自动聚焦', async () => {
      await page.locator('.gtd-blank-hint').dblclick({ position: { x: 6, y: 8 } });
      await page.waitForSelector('.gtd-blank-add', { timeout: 5000 });
      const head = await page.locator('.gtd-blank-head').textContent();
      assert(head.includes('收件箱'), '新建条没落在当前分组：' + head);
      const focused = await page.evaluate(function () {
        return document.activeElement && document.activeElement.className;
      });
      assert(String(focused).includes('gtd-blank-in'), '输入框没自动聚焦：' + focused);
    });

    await check('03 再双击一次空白不清掉正在敲的字', async () => {
      await page.locator('.gtd-blank-in').fill('半句还没写完');
      const box3 = await page.locator('.gtd-canvas').boundingBox();
      await page.mouse.dblclick(box3.x + box3.width - 10, box3.y + box3.height - 6);
      await page.waitForTimeout(120);
      assert.strictEqual(await page.locator('.gtd-blank-in').inputValue(), '半句还没写完');
      await page.locator('.gtd-blank-in').fill('');
    });

    await check('04 切到「下一步」：就地建一条，带项目与情境，不经收件箱', async () => {
      await page.locator('.side-tab').nth(1).click();
      await page.waitForTimeout(200);
      // 换分组时 watch 会收掉条件字段，但新建条保持打开
      assert.strictEqual(await page.locator('.gtd-blank-add').count(), 1, '切清单把条关掉了');
      const head = await page.locator('.gtd-blank-head').textContent();
      assert(head.includes('下一步'), '新建条没跟着换目标：' + head);
      await page.locator('.gtd-blank-in').fill('就地建：核对管材清单');
      await page.locator('.gtd-blank-proj').fill('装修');
      await page.locator('.gtd-blank-sel').selectOption('@电脑');
      await page.locator('.gtd-blank-in').press('Enter');
      await page.waitForTimeout(450);
      const titles = await page.locator('.gtd-list .gtd-title').allTextContents();
      assert(titles.includes('就地建：核对管材清单'), '新任务没出现在眼前这一组：' + titles.join('|'));
      const rows = await page.locator('.gtd-item').allTextContents();
      assert(rows.some(function (r) { return r.includes('装修') && r.includes('@电脑'); }),
        '项目/情境没写进新任务：' + rows.join('|'));
      // 收件箱必须是空的：这一条从头到尾没进过收件箱
      await page.locator('.side-tab').nth(0).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.gtd-item').count(), 0, '收件箱多出一条，说明还是走了捕获→厘清');
    });

    await check('05 项目卡片不再显示「N 个下一步」', async () => {
      const side = await page.locator('.gtd-side').textContent();
      assert(side.includes('装修'), '左栏没出现刚建的项目：' + side);
      assert(!side.includes('个下一步'), '项目卡片仍在列下一步清单：' + side);
    });

    await check('06 项目右键 →「在此新建任务」直接带上该项目', async () => {
      await page.locator('.side-proj').filter({ hasText: '装修' }).click({ button: 'right' });
      await page.waitForSelector('.gtd-side-menu', { timeout: 5000 });
      await page.locator('.gtd-side-menu .gm-item').filter({ hasText: '在此新建任务' }).click();
      await page.waitForTimeout(250);
      const head = await page.locator('.gtd-blank-head').textContent();
      assert(head.includes('装修'), '右键新建没继承项目：' + head);
      await page.locator('.gtd-blank-in').fill('右键建：约工长看现场');
      await page.locator('.gtd-blank-in').press('Enter');
      await page.waitForTimeout(450);
      const rows = await page.locator('.gtd-item').allTextContents();
      assert(rows.some(function (r) { return r.includes('右键建：约工长看现场') && r.includes('装修'); }),
        '右键新建的任务没带上项目：' + rows.join('|'));
    });

    await check('07 右击空白 → 菜单四项齐；「新建到收件箱」切回 inbox', async () => {
      const box7 = await page.locator('.gtd-canvas').boundingBox();
      await page.mouse.click(box7.x + box7.width - 10, box7.y + box7.height - 6, { button: 'right' });
      await page.waitForSelector('.gtd-blank-menu', { timeout: 5000 });
      const items = await page.locator('.gtd-blank-menu .gm-item').allTextContents();
      assert(items.length === 4, '菜单项数不对：' + items.join('|'));
      assert(items.join('|').includes('新建到收件箱'));
      await page.locator('.gtd-blank-menu .gm-item').filter({ hasText: '新建到收件箱' }).click();
      await page.waitForTimeout(250);
      const head = await page.locator('.gtd-blank-head').textContent();
      assert(head.includes('收件箱'), '没切回收件箱：' + head);
    });

    await check('08 日程组给日期、等待组给「等谁」；已完成组不新建', async () => {
      await page.locator('.side-tab').nth(3).click(); // 日程
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.gtd-blank-date').count(), 1, '日程组没给日期输入');
      const due = await page.locator('.gtd-blank-date').inputValue();
      assert(/^\d{4}-\d{2}-\d{2}$/.test(due), '日期没默认今天：' + due);
      await page.locator('.side-tab').nth(2).click(); // 等待
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.gtd-blank-who').count(), 1, '等待组没给「等谁」输入');
      assert.strictEqual(await page.locator('.gtd-blank-date').count(), 0, '日程字段串到等待组了');
      await page.locator('.side-tab').nth(5).click(); // 已完成
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.gtd-blank-add').count(), 0, '已完成组还开着新建条');
      const hint = await page.locator('.gtd-blank-hint').textContent();
      assert(hint.includes('只做回顾'), '已完成组提示不对：' + hint);
    });

    await check('09 全程无渲染层异常', async () => {
      assert.strictEqual(jsErrors.length, 0, jsErrors.join(' | '));
    });
  } finally {
    if (app) await app.close();
  }
  const fail = results.filter(function (r) { return !r.ok; });
  console.log('');
  console.log('========================================');
  console.log('  PASS ' + (results.length - fail.length) + ' | FAIL ' + fail.length);
  console.log('========================================');
  process.exit(fail.length ? 1 : 0);
})().catch(function (e) {
  console.error('自测脚本异常：', e);
  process.exit(2);
});
