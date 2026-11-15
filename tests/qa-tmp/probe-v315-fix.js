'use strict';
// 诊断探针（不是门禁）：验证 V3.15 两个报障的修法
//   ① 左栏点「未分组」→ 中栏书架要出现那几本（保留值 GROUP_NONE 与空 group 对上）
//   ② 点主题标题的三角 → 该主题书单真的收起 / 展开
// 用法：node tests/qa-tmp/probe-v315-fix.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require(path.join(path.resolve(__dirname, '../..'), 'tests/e2e/node_modules/playwright'));

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
const userData = path.join(os.tmpdir(), 'jiuge-probe-v315-' + Date.now());

delete process.env.ELECTRON_RUN_AS_NODE;

function tmpTxt(slug) {
  const f = path.join(os.tmpdir(), 'jiuge-p315-' + slug + '-' + Date.now() + '.txt');
  fs.writeFileSync(f, '探针用正文\n');
  return f;
}

(async function main() {
  let app = null;
  const out = [];
  const log = function (s) { out.push(s); console.log(s); };
  try {
    fs.mkdirSync(userData, { recursive: true });
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1320, height: 940 });
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(400);

    const call = function (name, args) {
      return page.evaluate(function (p) {
        return window.jiugeBridge.invoke('v1/domain:call', { name: p.name, args: p.args })
          .then(function (r) { return r.data; });
      }, { name: name, args: args || [] });
    };

    // 5 本都不带 group（＝未分组），另建一个主题放 3 本
    const leisure = ['未分组甲', '未分组乙', '未分组丙', '未分组丁', '未分组戊'];
    for (let i = 0; i < leisure.length; i += 1) {
      await call('reading.addBook', [{
        title: leisure[i], author: '探针', total: 100, unit: '页',
        filePath: tmpTxt('l' + i), fileExt: 'txt', fileSize: 30, format: 'TXT'
      }]);
    }
    await call('reading.themeAdd', [{ title: '折叠试主题', note: '' }]);
    const themes = await call('reading.themes', []);
    const themeId = themes[0].themeId;
    for (let i = 0; i < 3; i += 1) {
      await call('reading.addBook', [{
        title: '主题书' + (i + 1), author: '探针', total: 10, unit: '章',
        themeId: themeId, filePath: tmpTxt('t' + i), fileExt: 'txt', fileSize: 30, format: 'TXT'
      }]);
    }

    const [lib] = await Promise.all([app.waitForEvent('window'), page.locator('.reading-btn').click()]);
    await lib.waitForSelector('.lib-app', { timeout: 20000 });
    await lib.setViewportSize({ width: 1440, height: 900 });
    await lib.waitForTimeout(900);

    const shelfRows = function () { return lib.locator('.rd-shelf .rd-trow').count(); };
    const themeRows = function () { return lib.locator('.rd-theme-table .rd-trow').count(); };
    const themeTables = function () { return lib.locator('.rd-theme-table').count(); };

    log('左栏「未分组」行数 = ' + (await lib.locator('.lib-row', { hasText: '未分组' }).count()));

    // ① 点「未分组」
    await lib.locator('.lib-row', { hasText: '未分组' }).first().click();
    await lib.waitForTimeout(700);
    const rowsNone = await shelfRows();
    const chipNone = await lib.locator('.rd-gchip', { hasText: '未分组' }).count();
    const chipOn = await lib.locator('.rd-gchip.rd-gchip-on', { hasText: '未分组' }).count();
    log('点「未分组」→ 书架行数 = ' + rowsNone + '（应为 5）；中栏「未分组」chip 在 = ' + chipNone + '，高亮 = ' + chipOn);

    // 回到「全部」
    await lib.locator('.lib-row', { hasText: '休闲阅读' }).first().click();
    await lib.waitForTimeout(600);
    log('点「休闲阅读」→ 书架行数 = ' + (await shelfRows()) + '（应为 5：主题书不进书架）');

    // ② 主题折叠
    await lib.locator('.rd-tab').filter({ hasText: '主题阅读' }).click();
    await lib.waitForSelector('.rd-theme-table', { timeout: 8000 });
    await lib.waitForTimeout(400);
    log('主题默认展开 → 表数 = ' + (await themeTables()) + '，行数 = ' + (await themeRows()));
    await lib.locator('.rd-group-title').first().click();
    await lib.waitForTimeout(500);
    const ariaAfter = await lib.locator('.rd-group-title').first().getAttribute('aria-expanded');
    log('点三角收起 → 表数 = ' + (await themeTables()) + '，行数 = ' + (await themeRows()) +
      '，aria-expanded = ' + ariaAfter + '，提示 = ' + (await lib.locator('.rd-group .rd-hint').first().innerText()).trim());
    await lib.locator('.rd-group-title').first().click();
    await lib.waitForTimeout(500);
    log('再点一次展开 → 表数 = ' + (await themeTables()) + '，行数 = ' + (await themeRows()) +
      '，aria-expanded = ' + (await lib.locator('.rd-group-title').first().getAttribute('aria-expanded')));

    // ③ 收起状态下从左栏点这个主题：应自动展开
    await lib.locator('.rd-group-title').first().click();
    await lib.waitForTimeout(400);
    log('先收起，行数 = ' + (await themeRows()));
    await lib.locator('.lib-row', { hasText: '折叠试主题' }).first().click();
    await lib.waitForTimeout(700);
    log('左栏点该主题 → 行数 = ' + (await themeRows()) + '（应自动展开回 3）');
  } catch (e) {
    console.log('FAILED: ' + (e && e.stack ? e.stack : String(e)));
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(function () {});
    fs.writeFileSync(path.join(__dirname, 'probe-v315-fix.log'), out.join('\n') + '\n', 'utf8');
  }
})();
